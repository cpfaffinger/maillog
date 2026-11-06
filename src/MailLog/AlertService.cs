namespace MailLog;

/// <summary>
/// Evaluates alert rules every 30 s, opens/resolves alerts and notifies. Rules:
/// agent offline, failing health checks (incl. mail queue, saslauthd), SASL "generic failure" (auth backend down),
/// rate limits hit, foreign sender domains, fail2ban bans, mail volume, deferral storms, stuck queue.
/// </summary>
public sealed class AlertService(Db db, Settings s, Notifier notifier, ILogger<AlertService> log) : BackgroundService
{
    private readonly long _started = Store.Now();

    public sealed record Desired(string Key, string? AgentId, string Severity, string Title, string Body);

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        await Task.Delay(TimeSpan.FromSeconds(15), ct);
        while (!ct.IsCancellationRequested)
        {
            try { await TickAsync(ct); }
            catch (OperationCanceledException) { break; }
            catch (Exception e) { log.LogError(e, "Alert evaluation failed"); }
            await Task.Delay(TimeSpan.FromSeconds(30), ct);
        }
    }

    public async Task TickAsync(CancellationToken ct)
    {
        var now = Store.Now();
        var agents = db.Rows("SELECT id, name, last_seen, token_hash IS NOT NULL AS enrolled FROM agents");
        var names = agents.ToDictionary(a => (string)a["id"]!, a => (string)a["name"]!);
        string Name(string? id) => id is not null && names.TryGetValue(id, out var n) ? n : id ?? "?";
        var desired = new Dictionary<string, Desired>();
        void Want(Desired d) => desired[d.Key] = d;

        var online = new HashSet<string>();
        var graceOver = now - _started > 180_000;
        foreach (var a in agents)
        {
            if (!(bool)a["enrolled"]!) continue;
            var id = (string)a["id"]!;
            var lastSeen = a["lastSeen"] as long?;
            if (lastSeen is not null && now - lastSeen < s.OfflineAfterS * 1000L) { online.Add(id); continue; }
            if (lastSeen is null || !graceOver) continue;
            Want(new Desired($"offline:{id}", id, "critical", $"{Name(id)}: agent offline",
                $"No heartbeat since {Ago(now - lastSeen.Value)}. The host, the agent or the network path to this server is down."));
        }

        // health checks reported by agents (service, tcp, disk, queue, sasl probe)
        foreach (var h in db.Rows("SELECT agent_id, name, state, message, since FROM health WHERE state <> 'ok'"))
        {
            var id = (string)h["agentId"]!;
            if (!online.Contains(id)) continue;
            var failing = (string)h["state"]! == "fail";
            Want(new Desired($"check:{id}:{h["name"]}", id, failing ? "critical" : "warning",
                $"{Name(id)}: {h["name"]} {(failing ? "failing" : "degraded")}",
                $"{h["message"]}\nSince {Ago(now - (long)h["since"]!)}."));
        }

        // SASL backend down: Postfix logs "generic failure" instead of "authentication failure"
        foreach (var r in db.Rows("""
            SELECT agent_id, count(*) AS c, count(DISTINCT sasl_user) AS users FROM events
            WHERE kind='auth_fail' AND ts > @since AND detail ILIKE 'generic failure%' GROUP BY agent_id
            """, new { since = now - 5 * 60_000 }))
        {
            var id = (string)r["agentId"]!;
            Want(new Desired($"sasl-backend:{id}", id, "critical", $"{Name(id)}: SASL authentication backend failing",
                $"{r["c"]} logins ({r["users"]} accounts) failed with 'generic failure' in the last 5 minutes. saslauthd is most likely down; clients cannot send mail."));
        }

        foreach (var r in db.Rows("""
            SELECT agent_id, count(*) AS c, mode() WITHIN GROUP (ORDER BY client_ip) AS top_ip FROM events
            WHERE kind='ratelimit' AND ts > @since GROUP BY agent_id
            """, new { since = now - 5 * 60_000 }))
        {
            var id = (string)r["agentId"]!;
            Want(new Desired($"ratelimit:{id}", id, "warning", $"{Name(id)}: Postfix rate limit hit",
                $"{r["c"]} rate-limit rejections in the last 5 minutes (most from {r["topIp"]})."));
        }

        foreach (var r in db.Rows("""
            SELECT agent_id, lower(split_part(sender, '@', 2)) AS dom, count(*) AS c FROM events
            WHERE kind='foreign_sender' AND ts > @since GROUP BY 1, 2
            """, new { since = now - 10 * 60_000 }))
        {
            var dom = (string?)r["dom"] ?? "";
            if (s.AllowedForeignDomains.Contains(dom)) continue;
            var id = (string)r["agentId"]!;
            Want(new Desired($"foreign:{id}:{dom}", id, "warning", $"{Name(id)}: sender domain without DKIM key '{dom}'",
                $"{r["c"]} messages in 10 minutes from a domain OpenDKIM cannot sign for. Add it to MAILLOG_ALLOWED_FOREIGN_DOMAINS if legitimate."));
        }

        foreach (var r in db.Rows("""
            SELECT DISTINCT ON (e.agent_id, e.client_ip) e.agent_id, e.client_ip, e.ts, e.detail FROM events e
            WHERE e.kind='ban' AND e.ts > @since
              AND NOT EXISTS (SELECT 1 FROM events u WHERE u.kind='unban' AND u.agent_id=e.agent_id AND u.client_ip=e.client_ip AND u.ts >= e.ts)
            ORDER BY e.agent_id, e.client_ip, e.ts DESC
            """, new { since = now - 6 * 3600_000L }))
        {
            var id = (string)r["agentId"]!;
            Want(new Desired($"ban:{id}:{r["clientIp"]}", id, "warning", $"{Name(id)}: fail2ban banned {r["clientIp"]}",
                $"{r["detail"]}. Verify this is not one of your own servers."));
        }

        foreach (var r in db.Rows("""
            SELECT agent_id, count(*) AS c FROM events
            WHERE kind='delivery' AND status='sent' AND ts > @since GROUP BY agent_id HAVING count(*) >= @th
            """, new { since = now - 5 * 60_000, th = (long)s.SentThreshold }))
        {
            var id = (string)r["agentId"]!;
            Want(new Desired($"volume:{id}", id, "info", $"{Name(id)}: unusually high mail volume",
                $"{r["c"]} deliveries in the last 5 minutes (threshold {s.SentThreshold})."));
        }

        foreach (var r in db.Rows("""
            SELECT agent_id,
                   count(*) FILTER (WHERE status IN ('sent','deferred','bounced')) AS attempts,
                   count(*) FILTER (WHERE status IN ('deferred','bounced')) AS bad
            FROM events WHERE kind='delivery' AND ts > @since GROUP BY agent_id
            """, new { since = now - 15 * 60_000 }))
        {
            long attempts = (long)r["attempts"]!, bad = (long)r["bad"]!;
            if (attempts < 50 || bad * 2 <= attempts) continue;
            var id = (string)r["agentId"]!;
            Want(new Desired($"deferrals:{id}", id, "warning", $"{Name(id)}: most deliveries failing",
                $"{bad} of {attempts} delivery attempts in the last 15 minutes were deferred or bounced."));
        }

        // queue not draining: mail sits in the active/incoming queue while nothing is delivered.
        // (Deferred mail, e.g. recipients with full mailboxes, legitimately waits for days and is not a stuck queue.)
        foreach (var r in db.Rows("""
            SELECT DISTINCT ON (m.agent_id) m.agent_id, COALESCE(m.queue_active, 0) + COALESCE((m.queue_detail->>'incoming')::int, 0) AS moving,
                   COALESCE((m.queue_detail->>'oldestActiveAgeS')::int, 0) AS oldest_active
            FROM metrics m WHERE m.ts > @recent ORDER BY m.agent_id, m.ts DESC
            """, new { recent = now - 5 * 60_000 }))
        {
            var id = (string)r["agentId"]!;
            if (!online.Contains(id)) continue;
            int moving = Convert.ToInt32(r["moving"] ?? 0), oldest = Convert.ToInt32(r["oldestActive"] ?? 0);
            if (moving < 10 || oldest < 900) continue;
            var delivered = db.Scalar<long>("SELECT count(*) FROM events WHERE agent_id=@a AND kind='delivery' AND status='sent' AND ts > @since",
                new { a = id, since = now - 10 * 60_000 });
            if (delivered == 0)
                Want(new Desired($"queue-stuck:{id}", id, "critical", $"{Name(id)}: mail queue is not draining",
                    $"{moving} messages are waiting to be delivered (oldest {Ago(oldest * 1000L)}) and nothing was delivered in the last 10 minutes."));
        }

        await Reconcile(desired, now, ct);
        await NotifyActions(Name, ct);
    }

    private async Task Reconcile(Dictionary<string, Desired> desired, long now, CancellationToken ct)
    {
        var open = db.Rows("SELECT id, key, severity, title, last_notified FROM alerts WHERE resolved_at IS NULL")
            .ToDictionary(r => (string)r["key"]!);

        foreach (var d in desired.Values)
        {
            if (!open.TryGetValue(d.Key, out var existing))
            {
                var inserted = db.Exec("""
                    INSERT INTO alerts(key, agent_id, severity, title, body, opened_at, last_notified)
                    VALUES(@key, @agent, @sev, @title, @body, @now, @now) ON CONFLICT DO NOTHING
                    """, new { key = d.Key, agent = (object?)d.AgentId, sev = d.Severity, title = d.Title, body = d.Body, now });
                if (inserted == 1) await notifier.SendAsync(d.Title, d.Body, d.Severity, "open", ct);
                continue;
            }
            db.Exec("UPDATE alerts SET severity=@sev, title=@title, body=@body WHERE id=@id",
                new { sev = d.Severity, title = d.Title, body = d.Body, id = (long)existing["id"]! });
            var last = existing["lastNotified"] as long? ?? 0;
            if (d.Severity == "critical" && now - last > s.RenotifyS * 1000L)
            {
                db.Exec("UPDATE alerts SET last_notified=@now WHERE id=@id", new { now, id = (long)existing["id"]! });
                await notifier.SendAsync(d.Title + " (still open)", d.Body, d.Severity, "open", ct);
            }
        }

        foreach (var (key, row) in open)
        {
            if (desired.ContainsKey(key)) continue;
            db.Exec("UPDATE alerts SET resolved_at=@now WHERE id=@id", new { now, id = (long)row["id"]! });
            await notifier.SendAsync((string)row["title"]!, "Condition cleared.", (string)row["severity"]!, "resolved", ct);
        }
    }

    private async Task NotifyActions(Func<string?, string> name, CancellationToken ct)
    {
        foreach (var a in db.Rows("SELECT id, agent_id, name, action, ok, result FROM actions WHERE NOT notified ORDER BY id LIMIT 50"))
        {
            var ok = (bool)a["ok"]!;
            var title = $"{name((string)a["agentId"]!)}: auto-recovery for {a["name"]} {(ok ? "succeeded" : "FAILED")}";
            await notifier.SendAsync(title, $"{a["action"]}\n{a["result"]}", ok ? "warning" : "critical", ok ? "info" : "open", ct);
            db.Exec("UPDATE actions SET notified=TRUE WHERE id=@id", new { id = (long)a["id"]! });
        }
    }

    public static string Ago(long ms)
    {
        var t = TimeSpan.FromMilliseconds(Math.Max(0, ms));
        if (t.TotalDays >= 1) return $"{(int)t.TotalDays}d {t.Hours}h";
        if (t.TotalHours >= 1) return $"{(int)t.TotalHours}h {t.Minutes}m";
        if (t.TotalMinutes >= 1) return $"{(int)t.TotalMinutes}m";
        return $"{(int)t.TotalSeconds}s";
    }
}
