using System.Text.RegularExpressions;

namespace MailLog;

/// <summary>Event queries shared by /events, /trace and /stats. Applies RBAC: viewers only see their sender domains.</summary>
public static partial class Queries
{
    public static readonly string[] ViewerKinds = ["queued", "delivery", "accepted", "reject", "dkim_signed"];
    public static readonly string[] NoisyKinds = ["connect", "disconnect", "meta", "info"];

    [GeneratedRegex(@"^(?=[0-9A-Za-z]*\d)[0-9A-Za-z]{10,16}$")]
    private static partial Regex QueueIdPattern();

    public const string EventSelect = """
        SELECT e.id, e.agent_id, a.name AS agent_name, a.role AS agent_role, e.ts, e.source, e.program, e.queue_id, e.kind,
               e.sender, e.recipient, e.client_ip, e.client_host, e.sasl_user, e.relay, e.status, e.dsn, e.next_queue_id,
               e.delay_s, e.detail, e.raw
        FROM events e LEFT JOIN agents a ON a.id = e.agent_id
        """;

    private static readonly string[] Hidden = ["agentId", "agentName", "clientIp", "clientHost", "saslUser", "raw", "program", "source"];

    /// <summary>Adds the RBAC restriction. Viewers: final-hop agents only, their sender domains, customer-relevant kinds.</summary>
    public static void Scope(Me me, List<string> where, Dictionary<string, object?> p)
    {
        if (!me.Scoped) return;
        where.Add("a.role = 'outbound'");
        where.Add("lower(split_part(e.sender, '@', 2)) = ANY(@scopeDomains)");
        where.Add("e.kind = ANY(@scopeKinds)");
        p["scopeDomains"] = me.Domains;
        p["scopeKinds"] = ViewerKinds;
    }

    public static void Scrub(Me me, List<Dictionary<string, object?>> rows)
    {
        if (!me.Scoped) return;
        foreach (var r in rows)
            foreach (var k in Hidden) r[k] = null;
    }

    public static string Like(string q) => "%" + q.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";

    /// <summary>Adds the free-text filter used by the message search.</summary>
    public static void AddSearch(Me me, string q, List<string> where, Dictionary<string, object?> p)
    {
        q = q.Trim();
        if (q.Length == 0) return;
        p["q"] = q;
        if (QueueIdPattern().IsMatch(q))
        {
            where.Add("(e.queue_id = @q OR e.next_queue_id = @q)");
            return;
        }
        p["like"] = Like(q);
        where.Add(me.Scoped
            ? "(e.sender ILIKE @like OR e.recipient ILIKE @like)"
            : "(e.sender ILIKE @like OR e.recipient ILIKE @like OR e.client_ip = @q OR e.sasl_user ILIKE @like OR e.client_host ILIKE @like)");
    }

    public static object Events(Db db, Me me, IQueryCollection qs)
    {
        var where = new List<string> { "TRUE" };
        var p = new Dictionary<string, object?>();
        Scope(me, where, p);

        var limit = Math.Clamp(int.TryParse(qs["limit"], out var l) ? l : 200, 1, 1000);
        var all = string.Equals(qs["all"], "true", StringComparison.OrdinalIgnoreCase);
        var kinds = qs["kind"].ToString().Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        if (kinds.Length > 0) { where.Add("e.kind = ANY(@kinds)"); p["kinds"] = kinds; }
        else if (!all && !me.Scoped) { where.Add("e.kind <> ALL(@noisy)"); p["noisy"] = NoisyKinds; }

        if (!me.Scoped && qs["agent"].ToString() is { Length: > 0 } agent)
        {
            where.Add("(e.agent_id = @agent OR a.name = @agent)");
            p["agent"] = agent;
        }
        if (long.TryParse(qs["from"], out var from)) { where.Add("e.ts >= @from"); p["from"] = from; }
        if (long.TryParse(qs["to"], out var to)) { where.Add("e.ts <= @to"); p["to"] = to; }
        if (long.TryParse(qs["before"], out var before)) { where.Add("e.id < @before"); p["before"] = before; }
        AddSearch(me, qs["q"].ToString(), where, p);

        p["limit"] = limit + 1;
        var rows = db.Rows($"{EventSelect} WHERE {string.Join(" AND ", where)} ORDER BY e.id DESC LIMIT @limit", p);
        long? next = null;
        if (rows.Count > limit)
        {
            rows.RemoveAt(rows.Count - 1);
            next = (long)rows[^1]["id"]!;
        }
        Scrub(me, rows);
        return new { items = rows, nextBefore = next };
    }

    public static object Trace(Db db, Me me, string q)
    {
        var where = new List<string> { "TRUE" };
        var p = new Dictionary<string, object?>();
        Scope(me, where, p);
        AddSearch(me, q, where, p);
        if (where.Count == 1) return new { events = Array.Empty<object>() };

        p["limit"] = 200;
        var seeds = db.Rows($"{EventSelect} WHERE {string.Join(" AND ", where)} ORDER BY e.id DESC LIMIT @limit", p);
        var ids = new HashSet<string>();
        void Collect(IEnumerable<Dictionary<string, object?>> rows)
        {
            foreach (var r in rows)
            {
                if (r["queueId"] is string a && a != "NOQUEUE") ids.Add(a);
                if (r["nextQueueId"] is string b) ids.Add(b);
            }
        }
        Collect(seeds);

        var all = new Dictionary<long, Dictionary<string, object?>>();
        for (var round = 0; round < 6 && ids.Count > 0; round++)
        {
            var w = new List<string> { "(e.queue_id = ANY(@ids) OR e.next_queue_id = ANY(@ids))" };
            var pp = new Dictionary<string, object?> { ["ids"] = ids.ToArray(), ["limit"] = 3000 };
            Scope(me, w, pp);
            var rows = db.Rows($"{EventSelect} WHERE {string.Join(" AND ", w)} ORDER BY e.ts, e.id LIMIT @limit", pp);
            var before = ids.Count;
            foreach (var r in rows) all[(long)r["id"]!] = r;
            Collect(rows);
            if (ids.Count == before) break;
        }
        var events = all.Values.OrderBy(r => (long)r["ts"]!).ThenBy(r => (long)r["id"]!).ToList();
        Scrub(me, events);
        return new { events };
    }

    public static object Stats(Db db, Me me, int hours)
    {
        hours = Math.Clamp(hours, 1, 24 * 90);
        var since = Store.Now() - hours * 3600_000L;
        var where = new List<string> { "e.ts >= @since" };
        var p = new Dictionary<string, object?> { ["since"] = since };
        Scope(me, where, p);
        var agentCol = me.Scoped ? "NULL::text" : "e.agent_id";
        var group = me.Scoped ? "2" : "1, 2";
        var rows = db.Rows($"""
            SELECT {agentCol} AS agent_id, (e.ts / 3600000) * 3600000 AS hour,
                   count(*) FILTER (WHERE e.kind='delivery' AND e.status='sent') AS sent,
                   count(*) FILTER (WHERE e.kind='delivery' AND e.status='deferred') AS deferred,
                   count(*) FILTER (WHERE e.kind='delivery' AND e.status IN ('bounced','expired')) AS bounced,
                   count(*) FILTER (WHERE e.kind='reject') AS rejected,
                   count(*) FILTER (WHERE e.kind='auth_fail') AS auth_fail,
                   count(*) FILTER (WHERE e.kind='ratelimit') AS rate_limit
            FROM events e LEFT JOIN agents a ON a.id = e.agent_id
            WHERE {string.Join(" AND ", where)} GROUP BY {group} ORDER BY 2
            """, p);
        return new { hours, rows };
    }
}
