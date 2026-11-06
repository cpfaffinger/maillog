using Microsoft.Extensions.Caching.Memory;

namespace MailLog;

/// <summary>
/// Aggregated statistics for the dashboards. "sent" counts deliveries on the final hop (agents with role "outbound";
/// if no such agent exists, all agents). Viewers only see their sender domains; infrastructure numbers are for operator/admin.
/// </summary>
public static class StatsApi
{
    private const long DayMs = 86_400_000L;

    private static long L(object? v) => v is null ? 0 : Convert.ToInt64(v);
    private static double? D(object? v) => v is null ? null : Math.Round(Convert.ToDouble(v), 2);

    public static void Map(WebApplication app)
    {
        app.MapGroup("/api/v1").RequireAuthorization().MapGet("/stats/summary", (HttpContext c, Db db, IMemoryCache cache) =>
        {
            var me = Me.From(c.User)!;
            var days = Math.Clamp(int.TryParse(c.Request.Query["days"], out var d) ? d : 30, 1, 365);
            var tz = Math.Clamp(int.TryParse(c.Request.Query["tz"], out var t) ? t : 0, -840, 840);
            var key = $"stats:{me.Role}:{string.Join(',', me.Domains)}:{days}:{tz}";
            var result = cache.GetOrCreate(key, e =>
            {
                e.AbsoluteExpirationRelativeToNow = TimeSpan.FromSeconds(30);
                return Summary(db, me, days, tz);
            });
            return Results.Ok(result);
        }).WithTags("Mail").WithSummary("Aggregated mail statistics (daily, hourly, top domains, bounce reasons); scoped by role");
    }

    public static object Summary(Db db, Me me, int days, int tzMinutes)
    {
        var now = Store.Now();
        var tzMs = tzMinutes * 60_000L;
        var todayStart = (now + tzMs) / DayMs * DayMs - tzMs;            // local midnight as UTC ms
        var from = todayStart - (days - 1) * DayMs;

        var hasOutbound = db.Scalar<long>("SELECT count(*) FROM agents WHERE role='outbound'") > 0;

        var where = new List<string> { "e.ts >= @from", "e.ts <= @to" };
        var p = new Dictionary<string, object?> { ["from"] = from, ["to"] = now, ["tzms"] = tzMs };
        Queries.Scope(me, where, p);                                      // viewers: final hop, own domains
        if (!me.Scoped && hasOutbound) where.Add("a.role = 'outbound'");
        var w = string.Join(" AND ", where);
        const string Sent = "e.kind='delivery' AND e.status='sent'";

        // ---- daily series (zero-filled) -------------------------------------------------------------------
        var dailyRows = db.Rows($"""
            SELECT ((e.ts + @tzms) / 86400000) * 86400000 - @tzms AS day,
                   count(*) FILTER (WHERE {Sent}) AS sent,
                   count(*) FILTER (WHERE e.kind='delivery' AND e.status='deferred') AS deferred,
                   count(*) FILTER (WHERE e.kind='delivery' AND e.status IN ('bounced','expired')) AS bounced,
                   count(*) FILTER (WHERE e.kind='reject') AS rejected,
                   avg(e.delay_s) FILTER (WHERE {Sent}) AS avg_delay_s,
                   percentile_cont(0.95) WITHIN GROUP (ORDER BY e.delay_s) FILTER (WHERE {Sent}) AS p95_delay_s
            FROM events e JOIN agents a ON a.id = e.agent_id
            WHERE {w} GROUP BY 1 ORDER BY 1
            """, p).ToDictionary(r => L(r["day"]));
        var daily = new List<object>(days);
        for (var i = 0; i < days; i++)
        {
            var day = from + i * DayMs;
            if (dailyRows.TryGetValue(day, out var r))
                daily.Add(new { day, sent = L(r["sent"]), deferred = L(r["deferred"]), bounced = L(r["bounced"]), rejected = L(r["rejected"]),
                                avgDelayS = D(r["avgDelayS"]), p95DelayS = D(r["p95DelayS"]) });
            else
                daily.Add(new { day, sent = 0L, deferred = 0L, bounced = 0L, rejected = 0L, avgDelayS = (double?)null, p95DelayS = (double?)null });
        }

        // ---- totals ---------------------------------------------------------------------------------------
        var tot = db.Rows($"""
            SELECT count(*) FILTER (WHERE {Sent}) AS sent,
                   count(*) FILTER (WHERE e.kind='delivery' AND e.status='deferred') AS deferred,
                   count(*) FILTER (WHERE e.kind='delivery' AND e.status IN ('bounced','expired')) AS bounced,
                   count(*) FILTER (WHERE e.kind='reject') AS rejected,
                   avg(e.delay_s) FILTER (WHERE {Sent}) AS avg_delay_s,
                   percentile_cont(0.95) WITHIN GROUP (ORDER BY e.delay_s) FILTER (WHERE {Sent}) AS p95_delay_s
            FROM events e JOIN agents a ON a.id = e.agent_id WHERE {w}
            """, p)[0];
        long sent = L(tot["sent"]), bounced = L(tot["bounced"]);
        double? deliveredPct = sent + bounced > 0 ? Math.Round(100.0 * sent / (sent + bounced), 1) : null;

        // ---- hour of day ---------------------------------------------------------------------------------
        var hours = db.Rows($"""
            SELECT (((e.ts + @tzms) / 3600000) % 24) AS hour, count(*) AS sent
            FROM events e JOIN agents a ON a.id = e.agent_id WHERE {w} AND {Sent} GROUP BY 1
            """, p).ToDictionary(r => (int)L(r["hour"]), r => L(r["sent"]));
        var hourOfDay = Enumerable.Range(0, 24).Select(h => new { hour = h, sent = hours.GetValueOrDefault(h) }).ToList();

        // ---- top domains ---------------------------------------------------------------------------------
        List<Dictionary<string, object?>> Top(string column) => db.Rows($"""
            SELECT lower(split_part(e.{column}, '@', 2)) AS name,
                   count(*) FILTER (WHERE e.status='sent') AS sent,
                   count(*) FILTER (WHERE e.status='deferred') AS deferred,
                   count(*) FILTER (WHERE e.status IN ('bounced','expired')) AS bounced
            FROM events e JOIN agents a ON a.id = e.agent_id
            WHERE {w} AND e.kind='delivery' AND e.{column} IS NOT NULL AND split_part(e.{column}, '@', 2) <> ''
            GROUP BY 1 ORDER BY sent DESC, bounced DESC, deferred DESC LIMIT 10
            """, p);
        object Shape(List<Dictionary<string, object?>> rows) =>
            rows.Select(r => new { name = (string)r["name"]!, sent = L(r["sent"]), deferred = L(r["deferred"]), bounced = L(r["bounced"]) }).ToList();

        // ---- bounce reasons ------------------------------------------------------------------------------
        var reasons = db.Rows($"""
            SELECT e.dsn, left(regexp_replace(coalesce(e.detail, ''), '\[[0-9a-fA-F:.]+\]', '', 'g'), 140) AS reason, count(*) AS cnt
            FROM events e JOIN agents a ON a.id = e.agent_id
            WHERE {w} AND e.kind='delivery' AND e.status='bounced' GROUP BY 1, 2 ORDER BY cnt DESC LIMIT 8
            """, p).Select(r => new { dsn = r["dsn"] as string ?? "", reason = (string)r["reason"]!, count = L(r["cnt"]) }).ToList();

        object? infrastructure = null;
        if (me.CanSeeInfrastructure)
        {
            var ip = new Dictionary<string, object?> { ["from"] = from, ["to"] = now, ["tzms"] = tzMs };
            var byAgent = db.Rows("""
                SELECT a.id AS agent_id, a.name AS agent_name, a.role,
                       count(*) FILTER (WHERE e.kind='delivery' AND e.status='sent') AS sent,
                       count(*) FILTER (WHERE e.kind='delivery' AND e.status='deferred') AS deferred,
                       count(*) FILTER (WHERE e.kind='delivery' AND e.status IN ('bounced','expired')) AS bounced,
                       count(*) FILTER (WHERE e.kind='reject') AS rejected,
                       count(*) FILTER (WHERE e.kind='accepted') AS accepted
                FROM agents a LEFT JOIN events e ON e.agent_id = a.id AND e.ts >= @from AND e.ts <= @to
                GROUP BY a.id, a.name, a.role ORDER BY a.name
                """, ip).Select(r => new
            {
                agentId = (string)r["agentId"]!, agentName = (string)r["agentName"]!, role = (string)r["role"]!,
                sent = L(r["sent"]), deferred = L(r["deferred"]), bounced = L(r["bounced"]), rejected = L(r["rejected"]), accepted = L(r["accepted"]),
            }).ToList();

            List<object> TopCount(string column) => db.Rows($"""
                SELECT e.{column} AS name, count(*) AS cnt FROM events e
                WHERE e.kind='accepted' AND e.ts >= @from AND e.ts <= @to AND e.{column} IS NOT NULL
                GROUP BY 1 ORDER BY cnt DESC LIMIT 10
                """, ip).Select(r => (object)new { name = (string)r["name"]!, count = L(r["cnt"]) }).ToList();

            var authRows = db.Rows("""
                SELECT ((e.ts + @tzms) / 86400000) * 86400000 - @tzms AS day,
                       count(*) AS auth_fail,
                       count(*) FILTER (WHERE e.detail ILIKE 'generic failure%') AS generic_failures
                FROM events e WHERE e.kind='auth_fail' AND e.ts >= @from AND e.ts <= @to GROUP BY 1
                """, ip).ToDictionary(r => L(r["day"]));
            var authDaily = Enumerable.Range(0, days).Select(i =>
            {
                var day = from + i * DayMs;
                authRows.TryGetValue(day, out var r);
                return new { day, authFail = r is null ? 0L : L(r["authFail"]), genericFailures = r is null ? 0L : L(r["genericFailures"]) };
            }).ToList();

            infrastructure = new { byAgent, topSaslUsers = TopCount("sasl_user"), topClients = TopCount("client_ip"), authFailuresDaily = authDaily };
        }

        return new
        {
            days, tz = tzMinutes, from, to = now,
            scope = new { domains = me.Scoped ? me.Domains : null },
            totals = new
            {
                sent, deferred = L(tot["deferred"]), bounced, rejected = L(tot["rejected"]), deliveredPct,
                avgDelayS = D(tot["avgDelayS"]), p95DelayS = D(tot["p95DelayS"]),
            },
            daily, hourOfDay,
            topSenderDomains = Shape(Top("sender")),
            topRecipientDomains = Shape(Top("recipient")),
            bounceReasons = reasons,
            infrastructure,
        };
    }
}
