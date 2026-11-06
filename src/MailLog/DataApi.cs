using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace MailLog;

public sealed record AgentCreateDto(string Name, string Role);
public sealed record AgentConfigDto(int? IntervalS, JsonElement Checks, JsonElement Logs);
public sealed record SettingsDto(int RetentionDays);

/// <summary>Mail data, infrastructure overview, agents and settings (user API).</summary>
public static partial class DataApi
{
    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")]
    private static partial Regex AgentNamePattern();

    private static readonly string[] CheckTypes = ["service", "tcp", "disk", "queue", "sasl_probe"];
    private static readonly string[] LogSources = ["mail", "fail2ban"];

    private static Me Cur(HttpContext c) => Me.From(c.User)!;
    private static IResult Bad(string message) => Results.BadRequest(new { error = message });

    public static string ServerUrl(HttpRequest r, Settings s) => s.PublicUrl ?? $"{r.Scheme}://{r.Host}";

    public static void Map(WebApplication app)
    {
        var secured = app.MapGroup("/api/v1").RequireAuthorization();
        var ops = secured.MapGroup("").RequireAuthorization("operator");
        var admin = secured.MapGroup("").RequireAuthorization("admin");

        // ---- mail data (all roles, RBAC-scoped) ------------------------------------------------------------

        secured.MapGet("/events", (HttpContext c, Db db) => Results.Ok(Queries.Events(db, Cur(c), c.Request.Query)))
            .WithTags("Mail").WithSummary("Search mail log events");

        secured.MapGet("/trace", (HttpContext c, Db db) => Results.Ok(Queries.Trace(db, Cur(c), c.Request.Query["q"].ToString())))
            .WithTags("Mail").WithSummary("Follow one message across all hops (queue id or address)");

        secured.MapGet("/stats", (HttpContext c, Db db) =>
            Results.Ok(Queries.Stats(db, Cur(c), int.TryParse(c.Request.Query["hours"], out var h) ? h : 48)))
            .WithTags("Mail").WithSummary("Hourly mail counters");

        // ---- infrastructure (operator+) -------------------------------------------------------------------

        ops.MapGet("/overview", (Db db, Settings s) => Results.Ok(Overview(db, s))).WithTags("Infrastructure").WithSummary("Agents, health checks, 24 h counters, queue and open alerts");

        ops.MapGet("/queue", (HttpContext c, Db db) =>
            Results.Ok(QueueView(db, int.TryParse(c.Request.Query["hours"], out var h) ? Math.Clamp(h, 1, 24 * 30) : 24)))
            .WithTags("Infrastructure").WithSummary("Postfix mail queue per agent: current snapshot and history");

        ops.MapGet("/alerts", (HttpContext c, Db db) =>
        {
            var all = c.Request.Query["state"] == "all";
            var limit = Math.Clamp(int.TryParse(c.Request.Query["limit"], out var l) ? l : 200, 1, 1000);
            return Results.Ok(db.Rows($"""
                SELECT al.id, al.key, al.agent_id, a.name AS agent_name, al.severity, al.title, al.body, al.opened_at, al.resolved_at
                FROM alerts al LEFT JOIN agents a ON a.id = al.agent_id
                {(all ? "" : "WHERE al.resolved_at IS NULL")} ORDER BY al.opened_at DESC LIMIT @limit
                """, new { limit }));
        }).WithTags("Infrastructure").WithSummary("Alerts");

        ops.MapGet("/health/history", (HttpContext c, Db db) =>
        {
            var limit = Math.Clamp(int.TryParse(c.Request.Query["limit"], out var l) ? l : 200, 1, 1000);
            var agent = c.Request.Query["agent"].ToString();
            return Results.Ok(db.Rows($"""
                SELECT h.agent_id, a.name AS agent_name, h.name, h.state, h.message, h.ts
                FROM health_history h LEFT JOIN agents a ON a.id = h.agent_id
                {(agent.Length > 0 ? "WHERE h.agent_id=@agent OR a.name=@agent" : "")} ORDER BY h.ts DESC LIMIT @limit
                """, new { agent, limit }));
        }).WithTags("Infrastructure").WithSummary("Health check state changes");

        ops.MapGet("/actions", (HttpContext c, Db db) =>
        {
            var limit = Math.Clamp(int.TryParse(c.Request.Query["limit"], out var l) ? l : 100, 1, 1000);
            return Results.Ok(db.Rows("""
                SELECT x.id, x.agent_id, a.name AS agent_name, x.ts, x.name, x.action, x.ok, x.result
                FROM actions x LEFT JOIN agents a ON a.id = x.agent_id ORDER BY x.ts DESC LIMIT @limit
                """, new { limit }));
        }).WithTags("Infrastructure").WithSummary("Auto-recovery actions taken by agents");

        // ---- agents ---------------------------------------------------------------------------------------

        ops.MapGet("/agents", (Db db) => Results.Ok(AgentList(db))).WithTags("Agents").WithSummary("List agents");

        admin.MapPost("/agents", (AgentCreateDto dto, HttpContext c, Store store, Settings s) =>
        {
            if (!AgentNamePattern().IsMatch(dto.Name)) return Bad("Name: 1-64 characters, letters, digits . _ -");
            if (!Store.Roles.Contains(dto.Role)) return Bad("Role must be relay, outbound, inbound or generic");
            try
            {
                var (agent, token) = store.CreateAgent(dto.Name, dto.Role);
                return Results.Created($"/api/v1/agents/{agent.Id}", new
                {
                    agent = AgentList(c.RequestServices.GetRequiredService<Db>()).First(a => (string)a["id"]! == agent.Id),
                    enrollToken = token,
                    installCommand = InstallCommand(ServerUrl(c.Request, s), token),
                    expiresAt = Store.Now() + s.EnrollTtlHours * 3600_000L,
                });
            }
            catch (Npgsql.PostgresException e) when (e.SqlState == "23505") { return Bad("An agent with this name already exists"); }
        }).WithTags("Agents").WithSummary("Create an agent and its single-use enrollment token");

        admin.MapPost("/agents/{id}/enroll", (string id, HttpContext c, Store store, Settings s) =>
        {
            var token = store.ReissueEnrollment(id);
            return token is null
                ? Results.NotFound()
                : Results.Ok(new { enrollToken = token, installCommand = InstallCommand(ServerUrl(c.Request, s), token), expiresAt = Store.Now() + s.EnrollTtlHours * 3600_000L });
        }).WithTags("Agents").WithSummary("Issue a new enrollment token (re-install)");

        admin.MapPut("/agents/{id}/config", (string id, AgentConfigDto dto, Db db) =>
        {
            var error = ValidateConfig(dto);
            if (error is not null) return Bad(error);
            var interval = Math.Clamp(dto.IntervalS ?? 30, 10, 300);
            var n = db.Exec("UPDATE agents SET checks_json=@c, logs_json=@l, interval_s=@i WHERE id=@id",
                new { id, c = dto.Checks.GetRawText(), l = dto.Logs.GetRawText(), i = interval });
            return n == 1 ? Results.Ok(AgentList(db).First(a => (string)a["id"]! == id)) : Results.NotFound();
        }).WithTags("Agents").WithSummary("Update an agent's health checks and log files");

        admin.MapDelete("/agents/{id}", (string id, Store store) => store.DeleteAgent(id) ? Results.NoContent() : Results.NotFound())
            .WithTags("Agents").WithSummary("Delete an agent (logged events are kept until retention removes them)");

        // ---- settings -------------------------------------------------------------------------------------

        admin.MapGet("/settings", (Db db, Settings s, Notifier n) => Results.Ok(SettingsView(db, s, n, true)))
            .WithTags("Settings").WithSummary("Settings and statistics");

        admin.MapPut("/settings", (SettingsDto dto, Db db, Settings s, Notifier n, PasskeyService pk) =>
        {
            if (dto.RetentionDays is < 1 or > 3650) return Bad("retentionDays must be between 1 and 3650");
            db.SetSetting("retention_days", dto.RetentionDays.ToString());
            return Results.Ok(SettingsView(db, s, n, pk.Available));
        }).WithTags("Settings").WithSummary("Change the retention period for mail events");

        admin.MapPost("/settings/test-notification", async (Notifier n, CancellationToken ct) =>
        {
            var errors = await n.SendAsync("Test notification", "This is a test from maillog.", "info", "info", ct);
            return Results.Ok(new { ok = errors.Count == 0, errors });
        }).WithTags("Settings").WithSummary("Send a test notification to all configured channels");
    }

    public static string InstallCommand(string server, string token) =>
        $"curl -fsSL {server}/install.sh | sudo bash -s -- --enroll {token}";

    private static object SettingsView(Db db, Settings s, Notifier n, bool passkeys)
    {
        var estimate = db.Scalar<long>("SELECT reltuples::bigint FROM pg_class WHERE relname='events'");
        if (estimate < 1000) estimate = db.Scalar<long>("SELECT count(*) FROM events");
        return new
        {
            retentionDays = RetentionService.RetentionDays(db),
            eventCount = estimate,
            oldestEventTs = db.Scalar<long?>("SELECT min(ts) FROM events"),
            channels = new { webhook = n.WebhookConfigured, signal = n.SignalConfigured, smtp = n.SmtpConfigured },
            publicUrl = s.PublicUrl,
            passkeysAvailable = passkeys && s.PublicUrl is not null,
        };
    }

    private static string? ValidateConfig(AgentConfigDto dto)
    {
        if (dto.Checks.ValueKind != JsonValueKind.Array) return "checks must be an array";
        if (dto.Logs.ValueKind != JsonValueKind.Array) return "logs must be an array";
        var names = new HashSet<string>();
        foreach (var c in dto.Checks.EnumerateArray())
        {
            if (c.ValueKind != JsonValueKind.Object) return "every check must be an object";
            var name = c.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() : null;
            var type = c.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
            if (string.IsNullOrWhiteSpace(name)) return "every check needs a name";
            if (!names.Add(name)) return $"duplicate check name '{name}'";
            if (type is null || !CheckTypes.Contains(type)) return $"check '{name}': type must be one of {string.Join(", ", CheckTypes)}";
        }
        foreach (var l in dto.Logs.EnumerateArray())
        {
            if (l.ValueKind != JsonValueKind.Object) return "every log entry must be an object";
            var path = l.TryGetProperty("path", out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;
            var src = l.TryGetProperty("source", out var s) && s.ValueKind == JsonValueKind.String ? s.GetString() : null;
            if (path is null || !path.StartsWith('/') || path.Contains("..")) return "log path must be absolute";
            if (src is null || !LogSources.Contains(src)) return "log source must be mail or fail2ban";
        }
        return null;
    }

    public static List<Dictionary<string, object?>> AgentList(Db db)
    {
        var rows = db.Rows("""
            SELECT id, name, role, hostname, version, last_seen, last_ip, created_at, enrolled_at, enroll_expires,
                   token_hash IS NULL AS pending_enrollment, interval_s, checks_json, logs_json
            FROM agents ORDER BY name
            """);
        foreach (var r in rows)
        {
            r["checks"] = JsonNode.Parse((string)r["checksJson"]!);
            r["logs"] = JsonNode.Parse((string)r["logsJson"]!);
            r.Remove("checksJson");
            r.Remove("logsJson");
            r["intervalS"] = r["intervalS"] is int i ? i : Convert.ToInt32(r["intervalS"]);
        }
        return rows;
    }

    private static object Overview(Db db, Settings s)
    {
        var now = Store.Now();
        var agents = AgentList(db);
        var health = db.Rows("SELECT agent_id, name, state, message, since, updated FROM health ORDER BY name")
            .GroupBy(r => (string)r["agentId"]!).ToDictionary(g => g.Key, g => g.ToList());
        var stats = db.Rows("""
            SELECT agent_id,
                   count(*) FILTER (WHERE kind='delivery' AND status='sent') AS sent,
                   count(*) FILTER (WHERE kind='delivery' AND status='deferred') AS deferred,
                   count(*) FILTER (WHERE kind='delivery' AND status IN ('bounced','expired')) AS bounced,
                   count(*) FILTER (WHERE kind='reject') AS rejected,
                   count(*) FILTER (WHERE kind='auth_fail') AS auth_fail,
                   count(*) FILTER (WHERE kind='ratelimit') AS rate_limit
            FROM events WHERE ts >= @since GROUP BY agent_id
            """, new { since = now - 86_400_000L }).ToDictionary(r => (string)r["agentId"]!);
        var queues = LatestQueues(db);

        var items = agents.Select(a =>
        {
            var id = (string)a["id"]!;
            stats.TryGetValue(id, out var st);
            return new Dictionary<string, object?>
            {
                ["id"] = id, ["name"] = a["name"], ["role"] = a["role"], ["hostname"] = a["hostname"], ["version"] = a["version"],
                ["lastSeen"] = a["lastSeen"], ["enrolledAt"] = a["enrolledAt"], ["pendingEnrollment"] = a["pendingEnrollment"],
                ["checks"] = health.TryGetValue(id, out var h) ? h.Select(x => new { name = x["name"], state = x["state"], message = x["message"], since = x["since"], updated = x["updated"] }) : [],
                ["stats24h"] = new
                {
                    sent = st?["sent"] ?? 0L, deferred = st?["deferred"] ?? 0L, bounced = st?["bounced"] ?? 0L,
                    rejected = st?["rejected"] ?? 0L, authFail = st?["authFail"] ?? 0L, rateLimit = st?["rateLimit"] ?? 0L,
                },
                ["queue"] = queues.TryGetValue(id, out var q) ? q : null,
            };
        }).ToList();

        var alerts = db.Rows("""
            SELECT al.id, al.key, al.agent_id, a.name AS agent_name, al.severity, al.title, al.body, al.opened_at, al.resolved_at
            FROM alerts al LEFT JOIN agents a ON a.id = al.agent_id WHERE al.resolved_at IS NULL ORDER BY al.opened_at DESC
            """);
        return new { now, offlineAfterS = s.OfflineAfterS, agents = items, alerts };
    }

    /// <summary>Latest queue snapshot per agent in the documented Queue shape.</summary>
    private static Dictionary<string, JsonNode?> LatestQueues(Db db, long? since = null)
    {
        var rows = db.Rows("""
            SELECT DISTINCT ON (agent_id) agent_id, ts, queue_total, queue_deferred, queue_active, oldest_age_s, queue_detail::text AS detail
            FROM metrics ORDER BY agent_id, ts DESC
            """);
        var result = new Dictionary<string, JsonNode?>();
        foreach (var r in rows)
        {
            JsonObject obj;
            if (r["detail"] is string d && JsonNode.Parse(d) is JsonObject parsed) obj = parsed;
            else obj = new JsonObject
            {
                ["total"] = Convert.ToInt32(r["queueTotal"] ?? 0), ["active"] = Convert.ToInt32(r["queueActive"] ?? 0),
                ["deferred"] = Convert.ToInt32(r["queueDeferred"] ?? 0), ["hold"] = 0, ["incoming"] = 0,
                ["oldestAgeS"] = Convert.ToInt32(r["oldestAgeS"] ?? 0),
            };
            obj["ts"] = (long)r["ts"]!;
            result[(string)r["agentId"]!] = obj;
        }
        return result;
    }

    private static object QueueView(Db db, int hours)
    {
        var since = Store.Now() - hours * 3600_000L;
        var bucketMs = Math.Max(60_000L, hours * 3600_000L / 288);
        var series = db.Rows("""
            SELECT agent_id, (ts / @bucket) * @bucket AS ts, max(queue_total) AS total, max(queue_deferred) AS deferred, max(oldest_age_s) AS oldest_age_s
            FROM metrics WHERE ts >= @since GROUP BY 1, 2 ORDER BY 2
            """, new { since, bucket = bucketMs }).GroupBy(r => (string)r["agentId"]!).ToDictionary(g => g.Key, g => g.ToList());
        var current = LatestQueues(db);
        var agents = AgentList(db).Select(a =>
        {
            var id = (string)a["id"]!;
            return new
            {
                id, name = a["name"], role = a["role"],
                current = current.TryGetValue(id, out var c) ? c : null,
                series = series.TryGetValue(id, out var s)
                    ? s.Select(x => new { ts = x["ts"], total = x["total"], deferred = x["deferred"], oldestAgeS = x["oldestAgeS"] })
                    : [],
            };
        });
        return new { agents };
    }
}
