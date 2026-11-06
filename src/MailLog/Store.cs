using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Npgsql;
using NpgsqlTypes;

namespace MailLog;

public sealed record AgentInfo(string Id, string Name, string Role, string ChecksJson, string LogsJson, int IntervalS);

public sealed record BatchDto(string Source, List<string> Lines);
public sealed record IngestDto(int TzOffsetMinutes, string? Version, string? Hostname, List<BatchDto>? Batches);
public sealed record HealthCheckDto(string Name, string State, string? Message);
public sealed record ActionDto(string Name, string Action, bool Ok, string? Result);
public sealed record MetricsDto(int? QueueTotal, int? QueueDeferred, int? QueueActive, int? QueueOldestAgeS, JsonElement? Queue);
public sealed record HealthReportDto(string? Version, string? Hostname, List<HealthCheckDto>? Checks, MetricsDto? Metrics, List<ActionDto>? Actions);
public sealed record EnrollDto(string Token, string? Hostname);

/// <summary>Agent management, enrollment, event ingest and health persistence.</summary>
public sealed class Store(Db db, Settings settings)
{
    public static readonly string[] Roles = ["relay", "outbound", "inbound", "generic"];
    public static readonly string[] States = ["ok", "warn", "fail"];

    public static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    public static string Sha256(string v) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(v))).ToLowerInvariant();

    public static string NewToken(string prefix) =>
        prefix + Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    // ---- default agent configuration per role ---------------------------------------------------------------

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static (string checks, string logs) DefaultConfig(string role)
    {
        object[] mailLog = [new { path = "/var/log/mail.log", source = "mail" }];
        object[] mailAndF2b = [new { path = "/var/log/mail.log", source = "mail" }, new { path = "/var/log/fail2ban.log", source = "fail2ban" }];
        object postfix = new { name = "postfix", type = "service", unit = "postfix", restart = true };
        object smtp = new { name = "smtp-25", type = "tcp", host = "127.0.0.1", port = 25, expect = "^220", every = 60 };
        object disk = new { name = "disk-root", type = "disk", path = "/", warn = 85, fail = 95 };
        object queue = new { name = "queue", type = "queue", warn = 500, fail = 5000, maxAgeWarnS = 3600 };

        object[] checks = role switch
        {
            "relay" =>
            [
                postfix,
                new { name = "saslauthd", type = "service", unit = "saslauthd", restart = true, enable = true },
                new { name = "sasl-auth-probe", type = "sasl_probe", unit = "saslauthd", restart = true },
                new { name = "fail2ban", type = "service", unit = "fail2ban", restart = true },
                smtp, disk, queue,
            ],
            "outbound" =>
            [
                postfix,
                new { name = "opendkim", type = "service", unit = "opendkim", restart = true },
                new { name = "dkim-milter", type = "tcp", host = "127.0.0.1", port = 8891, every = 60 },
                smtp, disk, queue,
            ],
            "inbound" => [postfix, smtp, disk, queue],
            _ => [postfix, disk, queue],
        };
        var logs = role == "relay" ? mailAndF2b : mailLog;
        return (JsonSerializer.Serialize(checks, Json), JsonSerializer.Serialize(logs, Json));
    }

    // ---- agents ---------------------------------------------------------------------------------------------

    public (AgentInfo agent, string enrollToken) CreateAgent(string name, string role)
    {
        var (checks, logs) = DefaultConfig(role);
        var id = Guid.NewGuid().ToString("N");
        var token = NewToken("mle_");
        db.Exec("""
            INSERT INTO agents(id, name, role, enroll_hash, enroll_expires, created_at, checks_json, logs_json)
            VALUES(@id, @name, @role, @hash, @exp, @now, @checks, @logs)
            """, new
        {
            id, name, role, hash = Sha256(token), exp = Now() + settings.EnrollTtlHours * 3600_000L,
            now = Now(), checks, logs,
        });
        return (new AgentInfo(id, name, role, checks, logs, 30), token);
    }

    public string? ReissueEnrollment(string agentId)
    {
        var token = NewToken("mle_");
        var n = db.Exec("UPDATE agents SET enroll_hash=@hash, enroll_expires=@exp WHERE id=@id",
            new { id = agentId, hash = Sha256(token), exp = Now() + settings.EnrollTtlHours * 3600_000L });
        return n == 1 ? token : null;
    }

    /// <summary>Exchanges a single-use enrollment token for the long-lived agent token.</summary>
    public (AgentInfo agent, string agentToken)? Enroll(string enrollToken)
    {
        var hash = Sha256(enrollToken);
        var token = NewToken("mla_");
        var rows = db.Rows("""
            UPDATE agents SET token_hash=@th, enroll_hash=NULL, enroll_expires=NULL, enrolled_at=@now
            WHERE enroll_hash=@eh AND enroll_expires > @now
            RETURNING id, name, role, checks_json, logs_json, interval_s
            """, new { th = Sha256(token), eh = hash, now = Now() });
        if (rows.Count != 1) return null;
        var r = rows[0];
        return (new AgentInfo((string)r["id"]!, (string)r["name"]!, (string)r["role"]!, (string)r["checksJson"]!,
            (string)r["logsJson"]!, Convert.ToInt32(r["intervalS"])), token);
    }

    public AgentInfo? Authenticate(string token)
    {
        var rows = db.Rows("SELECT id, name, role, checks_json, logs_json, interval_s FROM agents WHERE token_hash=@h",
            new { h = Sha256(token) });
        if (rows.Count != 1) return null;
        var r = rows[0];
        return new AgentInfo((string)r["id"]!, (string)r["name"]!, (string)r["role"]!, (string)r["checksJson"]!,
            (string)r["logsJson"]!, Convert.ToInt32(r["intervalS"]));
    }

    public void Touch(string agentId, string? ip, string? hostname, string? version) =>
        db.Exec("UPDATE agents SET last_seen=@now, last_ip=COALESCE(@ip, last_ip), hostname=COALESCE(@hn, hostname), version=COALESCE(@v, version) WHERE id=@id",
            new { id = agentId, now = Now(), ip = (object?)ip, hn = (object?)hostname, v = (object?)version });

    public bool DeleteAgent(string id)
    {
        db.Exec("DELETE FROM health WHERE agent_id=@id", new { id });
        db.Exec("DELETE FROM actions WHERE agent_id=@id", new { id });
        db.Exec("DELETE FROM metrics WHERE agent_id=@id", new { id });
        return db.Exec("DELETE FROM agents WHERE id=@id", new { id }) == 1;
    }

    // ---- ingest ---------------------------------------------------------------------------------------------

    public int InsertEvents(string agentId, int tzOffsetMinutes, IEnumerable<BatchDto> batches)
    {
        const string sql = """
            INSERT INTO events(agent_id, ts, source, program, pid, queue_id, kind, sender, recipient, client_ip, client_host,
                               sasl_user, relay, status, dsn, next_queue_id, delay_s, detail, raw, line_hash)
            VALUES(@agent_id, @ts, @source, @program, @pid, @queue_id, @kind, @sender, @recipient, @client_ip, @client_host,
                   @sasl_user, @relay, @status, @dsn, @next_queue_id, @delay_s, @detail, @raw, @line_hash)
            ON CONFLICT (agent_id, line_hash) DO NOTHING
            """;
        var now = DateTimeOffset.UtcNow;
        var inserted = 0;
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        using var cmd = new NpgsqlCommand(sql, conn, tx);
        NpgsqlParameter P(string name, NpgsqlDbType t) => cmd.Parameters.Add(new NpgsqlParameter(name, t));
        var pAgent = P("agent_id", NpgsqlDbType.Text); var pTs = P("ts", NpgsqlDbType.Bigint);
        var pSource = P("source", NpgsqlDbType.Text); var pProgram = P("program", NpgsqlDbType.Text);
        var pPid = P("pid", NpgsqlDbType.Integer); var pQ = P("queue_id", NpgsqlDbType.Text);
        var pKind = P("kind", NpgsqlDbType.Text); var pSender = P("sender", NpgsqlDbType.Text);
        var pRcpt = P("recipient", NpgsqlDbType.Text); var pIp = P("client_ip", NpgsqlDbType.Text);
        var pHost = P("client_host", NpgsqlDbType.Text); var pSasl = P("sasl_user", NpgsqlDbType.Text);
        var pRelay = P("relay", NpgsqlDbType.Text); var pStatus = P("status", NpgsqlDbType.Text);
        var pDsn = P("dsn", NpgsqlDbType.Text); var pNext = P("next_queue_id", NpgsqlDbType.Text);
        var pDelay = P("delay_s", NpgsqlDbType.Double); var pDetail = P("detail", NpgsqlDbType.Text);
        var pRaw = P("raw", NpgsqlDbType.Text); var pHash = P("line_hash", NpgsqlDbType.Text);
        pAgent.Value = agentId;

        foreach (var batch in batches)
        {
            var source = batch.Source is "fail2ban" ? "fail2ban" : "mail";
            foreach (var line in batch.Lines)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                var e = LogParser.Parse(line.Length > 4000 ? line[..4000] : line, source, tzOffsetMinutes, now);
                e = WithSender(conn, tx, agentId, e);
                pTs.Value = e.Ts; pSource.Value = e.Source; pProgram.Value = (object?)e.Program ?? DBNull.Value;
                pPid.Value = (object?)e.Pid ?? DBNull.Value; pQ.Value = (object?)e.QueueId ?? DBNull.Value;
                pKind.Value = e.Kind; pSender.Value = (object?)e.Sender ?? DBNull.Value;
                pRcpt.Value = (object?)e.Recipient ?? DBNull.Value; pIp.Value = (object?)e.ClientIp ?? DBNull.Value;
                pHost.Value = (object?)e.ClientHost ?? DBNull.Value; pSasl.Value = (object?)e.SaslUser ?? DBNull.Value;
                pRelay.Value = (object?)e.Relay ?? DBNull.Value; pStatus.Value = (object?)e.Status ?? DBNull.Value;
                pDsn.Value = (object?)e.Dsn ?? DBNull.Value; pNext.Value = (object?)e.NextQueueId ?? DBNull.Value;
                pDelay.Value = (object?)e.DelayS ?? DBNull.Value; pDetail.Value = (object?)e.Detail ?? DBNull.Value;
                pRaw.Value = e.Raw;
                pHash.Value = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(source + "\n" + e.Raw)))[..32];
                var n = cmd.ExecuteNonQuery();
                inserted += n;
                if (n == 1 && e.Kind == "queued" && e.QueueId is not null && e.Sender is not null)
                {
                    // Earlier lines of the same message (smtpd "client=...") were logged before the sender was known.
                    using var up = Db.Cmd(conn, "UPDATE events SET sender=@s WHERE agent_id=@a AND queue_id=@q AND sender IS NULL AND kind <> 'queued'",
                        new { s = e.Sender, a = agentId, q = e.QueueId }, tx);
                    up.ExecuteNonQuery();
                }
            }
        }
        tx.Commit();
        return inserted;
    }

    // (agent, queue id) -> envelope sender. Lets every event of a message carry the sender, so viewers can be scoped by domain.
    private readonly System.Collections.Concurrent.ConcurrentDictionary<(string, string), string> _senders = new();

    private ParsedEvent WithSender(NpgsqlConnection conn, NpgsqlTransaction tx, string agentId, ParsedEvent e)
    {
        if (e.QueueId is null or "NOQUEUE") return e;
        if (e.Kind == "queued" && e.Sender is not null)
        {
            if (_senders.Count > 100_000) _senders.Clear();
            _senders[(agentId, e.QueueId)] = e.Sender;
            return e;
        }
        if (e.Sender is not null) return e;
        if (_senders.TryGetValue((agentId, e.QueueId), out var s)) return e with { Sender = s };
        using var q = Db.Cmd(conn, "SELECT sender FROM events WHERE agent_id=@a AND queue_id=@q AND kind='queued' AND sender IS NOT NULL LIMIT 1",
            new { a = agentId, q = e.QueueId }, tx);
        if (q.ExecuteScalar() is string found)
        {
            _senders[(agentId, e.QueueId)] = found;
            return e with { Sender = found };
        }
        return e;
    }

    // ---- health ---------------------------------------------------------------------------------------------

    public void SaveHealth(AgentInfo agent, HealthReportDto r)
    {
        var now = Now();
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        var names = new List<string>();

        foreach (var c in r.Checks ?? [])
        {
            if (string.IsNullOrWhiteSpace(c.Name)) continue;
            var state = States.Contains(c.State) ? c.State : "fail";
            var msg = c.Message is { Length: > 500 } ? c.Message[..500] : c.Message;
            names.Add(c.Name);

            string? oldState = null; long since = now;
            using (var q = Db.Cmd(conn, "SELECT state, since FROM health WHERE agent_id=@a AND name=@n", new { a = agent.Id, n = c.Name }, tx))
            using (var rd = q.ExecuteReader())
                if (rd.Read()) { oldState = rd.GetString(0); since = rd.GetInt64(1); }

            if (oldState != state)
            {
                since = now;
                using var h = Db.Cmd(conn, "INSERT INTO health_history(agent_id, name, state, message, ts) VALUES(@a,@n,@s,@m,@t)",
                    new { a = agent.Id, n = c.Name, s = state, m = (object?)msg, t = now }, tx);
                h.ExecuteNonQuery();
            }
            using var up = Db.Cmd(conn, """
                INSERT INTO health(agent_id, name, state, message, since, updated) VALUES(@a,@n,@s,@m,@since,@now)
                ON CONFLICT (agent_id, name) DO UPDATE SET state=EXCLUDED.state, message=EXCLUDED.message,
                  since=EXCLUDED.since, updated=EXCLUDED.updated
                """, new { a = agent.Id, n = c.Name, s = state, m = (object?)msg, since, now }, tx);
            up.ExecuteNonQuery();
        }

        using (var del = Db.Cmd(conn, "DELETE FROM health WHERE agent_id=@a AND NOT (name = ANY(@names))",
                   new { a = agent.Id, names = names.ToArray() }, tx))
            del.ExecuteNonQuery();

        foreach (var a in r.Actions ?? [])
        {
            using var ac = Db.Cmd(conn, "INSERT INTO actions(agent_id, ts, name, action, ok, result) VALUES(@a,@t,@n,@act,@ok,@res)",
                new { a = agent.Id, t = now, n = a.Name, act = a.Action, ok = a.Ok, res = (object?)Trunc(a.Result, 500) }, tx);
            ac.ExecuteNonQuery();
        }

        if (r.Metrics is { } m)
        {
            using var mc = Db.Cmd(conn, """
                INSERT INTO metrics(agent_id, ts, queue_total, queue_deferred, queue_active, oldest_age_s, queue_detail)
                VALUES(@a,@t,@qt,@qd,@qa,@age,@detail)
                """, new { a = agent.Id, t = now, qt = (object?)m.QueueTotal, qd = (object?)m.QueueDeferred, qa = (object?)m.QueueActive, age = (object?)m.QueueOldestAgeS }, tx);
            var detail = mc.Parameters.Add(new NpgsqlParameter("detail", NpgsqlDbType.Jsonb));
            detail.Value = m.Queue is { ValueKind: JsonValueKind.Object } q ? q.GetRawText() : DBNull.Value;
            mc.ExecuteNonQuery();
        }
        tx.Commit();
    }

    private static string? Trunc(string? s, int n) => s is not null && s.Length > n ? s[..n] : s;
}
