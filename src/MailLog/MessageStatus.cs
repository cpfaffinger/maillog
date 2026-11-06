namespace MailLog;

public sealed record RecipientStatus(string Address, string Status, string? Dsn, string? RemoteServer, string? Detail, int Attempts,
    DateTimeOffset? LastAttemptAt, DateTimeOffset? DeliveredAt, double? DelaySeconds);

public sealed record TimelineItem(DateTimeOffset At, int Hop, string Kind, string? Status, string? Recipient, string? Dsn, string? Detail);

public sealed record MessageStatusResult(string MessageId, bool Found, string Status, bool Final, string Summary, string? Sender,
    DateTimeOffset? ReceivedAt, DateTimeOffset? LastEventAt, DateTimeOffset? DeliveredAt, double? TotalDelaySeconds, int RecipientCount,
    IReadOnlyList<RecipientStatus> Recipients, IReadOnlyList<TimelineItem>? Timeline, DateTimeOffset? LogsCompleteUntil);

public sealed record MessageStatusBatchDto(string[]? MessageIds, bool Timeline = false);

/// <summary>Status values of a message (<c>status</c>) and of each recipient.</summary>
public static class MailStatus
{
    public const string Queued = "queued";          // accepted by the mail system, no delivery information yet
    public const string InTransit = "in_transit";   // handed from one of our servers to the next, not yet attempted at the final one
    public const string Deferred = "deferred";      // temporary failure, the server keeps retrying
    public const string Delivered = "delivered";    // accepted by the recipient's mail server
    public const string Bounced = "bounced";        // permanently refused
    public const string Expired = "expired";        // retried until the queue lifetime ended
    public const string Partial = "partial";        // several recipients, some delivered and some failed (nothing pending)
    public const string Rejected = "rejected";      // refused by our own mail system after queueing
    public const string NotFound = "not_found";
}

/// <summary>
/// Answers "what happened to the message with this Message-ID header" from the collected logs, across all servers of the mail path.
/// A caller with a sender-domain restriction (viewer or API key) only gets messages whose envelope sender is in one of its domains;
/// every other message is indistinguishable from an unknown one.
/// </summary>
public sealed class MessageStatusService(Db db)
{
    public const int MaxBatch = 100;
    private static readonly string[] Kinds = ["queued", "delivery", "reject"];

    private static DateTimeOffset At(long ms) => DateTimeOffset.FromUnixTimeMilliseconds(ms);
    private static long L(object? v) => v is null ? 0 : Convert.ToInt64(v);

    /// <summary>Time up to which the logs of the mail path have been received (oldest agent heartbeat).</summary>
    public DateTimeOffset? LogsCompleteUntil()
    {
        var ms = db.Scalar<long?>("SELECT min(last_seen) FROM agents WHERE role IN ('relay','outbound') AND enrolled_at IS NOT NULL");
        return ms is { } v ? At(v) : null;
    }

    public MessageStatusResult Lookup(string rawId, Me me, bool timeline, DateTimeOffset? logsUntil = null)
    {
        logsUntil ??= LogsCompleteUntil();
        var mid = LogParser.NormalizeMessageId(rawId);
        if (mid is null) return NotFound(rawId, logsUntil);

        var seeds = db.Rows("""
            SELECT agent_id, queue_id, min(ts) AS ts, max(sender) AS sender
            FROM events WHERE message_id = @m AND queue_id IS NOT NULL GROUP BY agent_id, queue_id
            """, new { m = mid });
        if (seeds.Count == 0) return NotFound(rawId, logsUntil);

        var events = db.Rows("""
            SELECT e.id, e.agent_id, a.role AS agent_role, e.queue_id, e.ts, e.kind, e.sender, e.recipient, e.relay, e.status,
                   e.dsn, e.next_queue_id, e.delay_s, e.detail
            FROM events e JOIN agents a ON a.id = e.agent_id
            WHERE e.kind = ANY(@kinds)
              AND EXISTS (SELECT 1 FROM events s WHERE s.message_id = @m AND s.agent_id = e.agent_id AND s.queue_id = e.queue_id)
            ORDER BY e.ts, e.id LIMIT 5000
            """, new { kinds = Kinds, m = mid });

        // ---- group the queue entries (agent, queue id) of one message into connected hops ----------------------
        var nodes = seeds.Select(s => ((string)s["agentId"]!, (string)s["queueId"]!)).ToList();
        var parent = Enumerable.Range(0, nodes.Count).ToArray();
        int Find(int x) { while (parent[x] != x) x = parent[x] = parent[parent[x]]; return x; }
        int IndexOf(string agent, string qid) => nodes.FindIndex(n => n.Item1 == agent && n.Item2 == qid);
        foreach (var ev in events)
        {
            if (ev["nextQueueId"] is not string next) continue;
            var from = IndexOf((string)ev["agentId"]!, (string)ev["queueId"]!);
            for (var i = 0; i < nodes.Count; i++)
                if (nodes[i].Item2 == next && nodes[i].Item1 != (string)ev["agentId"]! && from >= 0) parent[Find(i)] = Find(from);
        }

        // ---- RBAC: keep only the groups whose envelope sender is in the caller's domains -------------------------
        var senderOf = new Dictionary<int, string>();
        for (var i = 0; i < nodes.Count; i++)
        {
            var sender = seeds[i]["sender"] as string;
            if (string.IsNullOrEmpty(sender))
                sender = events.Where(e => (string)e["agentId"]! == nodes[i].Item1 && (string)e["queueId"]! == nodes[i].Item2)
                    .Select(e => e["sender"] as string).FirstOrDefault(s => !string.IsNullOrEmpty(s));
            if (!string.IsNullOrEmpty(sender) && !senderOf.ContainsKey(Find(i))) senderOf[Find(i)] = sender;
        }
        bool Allowed(int root) =>
            !me.Scoped || (senderOf.TryGetValue(root, out var s) && me.Domains.Contains(DomainOf(s)));
        var keep = Enumerable.Range(0, nodes.Count).Where(i => Allowed(Find(i))).ToHashSet();
        if (keep.Count == 0) return NotFound(rawId, logsUntil);

        var keptKeys = keep.Select(i => nodes[i]).ToHashSet();
        var evs = events.Where(e => keptKeys.Contains(((string)e["agentId"]!, (string)e["queueId"]!))).ToList();
        var keptSeeds = keep.Select(i => seeds[i]).ToList();

        // ---- which deliveries are the last hop? ------------------------------------------------------------------
        var hasOutbound = db.Scalar<long>("SELECT count(*) FROM agents WHERE role='outbound'") > 0;
        bool IsFinal(Dictionary<string, object?> e) =>
            hasOutbound
                ? (string)e["agentRole"]! == "outbound"
                : e["nextQueueId"] is not string next || !keptKeys.Any(k => k.Item2 == next && k.Item1 != (string)e["agentId"]!);

        // hop numbers: servers in the order they first saw the message
        var hopOf = keptSeeds.GroupBy(s => (string)s["agentId"]!).Select(g => (agent: g.Key, ts: g.Min(s => L(s["ts"]))))
            .OrderBy(x => x.ts).Select((x, i) => (x.agent, hop: i + 1)).ToDictionary(x => x.agent, x => x.hop);

        var sender0 = keptSeeds.Select(s => s["sender"] as string).FirstOrDefault(s => !string.IsNullOrEmpty(s))
                      ?? evs.Select(e => e["sender"] as string).FirstOrDefault(s => !string.IsNullOrEmpty(s));
        var receivedAt = keptSeeds.Min(s => L(s["ts"]));

        // ---- recipients ---------------------------------------------------------------------------------------------
        var final = new Dictionary<string, List<Dictionary<string, object?>>>(StringComparer.OrdinalIgnoreCase);
        var handoff = new Dictionary<string, List<Dictionary<string, object?>>>(StringComparer.OrdinalIgnoreCase);
        var names = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var expired = new List<Dictionary<string, object?>>();
        foreach (var e in evs)
        {
            if ((string)e["kind"]! != "delivery") continue;
            if (e["recipient"] is not string rcpt || rcpt.Length == 0)
            {
                if ((e["status"] as string) == "expired") expired.Add(e);
                continue;
            }
            names.TryAdd(rcpt, rcpt);
            var target = IsFinal(e) ? final : handoff;
            if (!target.TryGetValue(rcpt, out var list)) target[rcpt] = list = [];
            list.Add(e);
        }

        var recipients = new List<RecipientStatus>();
        foreach (var rcpt in names.Keys.OrderBy(k => k, StringComparer.OrdinalIgnoreCase))
        {
            final.TryGetValue(rcpt, out var f);
            handoff.TryGetValue(rcpt, out var h);
            var last = f?.LastOrDefault();
            string status; Dictionary<string, object?>? src;
            if (last is not null)
            {
                src = last;
                status = (last["status"] as string) switch
                {
                    "sent" => MailStatus.Delivered,
                    "bounced" => MailStatus.Bounced,
                    "expired" => MailStatus.Expired,
                    _ => MailStatus.Deferred,
                };
            }
            else
            {
                src = h?.LastOrDefault();
                status = (src?["status"] as string) switch
                {
                    "sent" => MailStatus.InTransit,
                    "bounced" => MailStatus.Bounced,
                    "expired" => MailStatus.Expired,
                    "deferred" => MailStatus.Deferred,
                    _ => MailStatus.Queued,
                };
            }
            if (status is MailStatus.Deferred or MailStatus.InTransit or MailStatus.Queued && expired.Count > 0 &&
                expired.Max(x => L(x["ts"])) >= (src is null ? 0 : L(src["ts"])))
                status = MailStatus.Expired;

            var isFinal = last is not null;
            var delivered = status == MailStatus.Delivered && last is not null ? At(L(last["ts"])) : (DateTimeOffset?)null;
            recipients.Add(new RecipientStatus(
                names[rcpt], status,
                src?["dsn"] as string,
                isFinal ? src!["relay"] as string : null,
                isFinal ? src!["detail"] as string : (src is null ? null : "Handed over to the outbound mail server"),
                f?.Count ?? 0,
                f?.Count > 0 ? At(L(f[^1]["ts"])) : null,
                delivered,
                isFinal && src!["delayS"] is double d ? Math.Round(d, 2) : null));
        }

        // recipients announced by "nrcpt=" but not (yet) seen in a delivery line are still pending
        var expectedRecipients = evs.Where(e => (string)e["kind"]! == "queued")
            .GroupBy(e => (string)e["agentId"]!)
            .Select(g => g.Sum(e => NRcpt(e["detail"] as string))).DefaultIfEmpty(0).Max();
        var missing = Math.Max(0, expectedRecipients - recipients.Count);
        var rejects = evs.Count(e => (string)e["kind"]! == "reject");

        var pending = recipients.Count(r => r.Status is MailStatus.Queued or MailStatus.InTransit or MailStatus.Deferred) + missing;
        var ok = recipients.Count(r => r.Status == MailStatus.Delivered);
        var failed = recipients.Count - ok - recipients.Count(r => r.Status is MailStatus.Queued or MailStatus.InTransit or MailStatus.Deferred);

        string overall;
        if (recipients.Count == 0 && rejects > 0) overall = MailStatus.Rejected;
        else if (pending > 0)
            overall = recipients.Any(r => r.Status == MailStatus.Deferred) ? MailStatus.Deferred
                    : recipients.Any(r => r.Status == MailStatus.InTransit) ? MailStatus.InTransit : MailStatus.Queued;
        else if (failed == 0) overall = MailStatus.Delivered;
        else if (ok == 0) overall = recipients.All(r => r.Status == MailStatus.Expired) ? MailStatus.Expired : MailStatus.Bounced;
        else overall = MailStatus.Partial;

        var isDone = overall is MailStatus.Delivered or MailStatus.Bounced or MailStatus.Expired or MailStatus.Partial or MailStatus.Rejected;
        var deliveredAt = ok > 0 && pending == 0 && failed == 0 ? recipients.Max(r => r.DeliveredAt) : null;
        var lastEvent = evs.Count > 0 ? evs.Max(e => L(e["ts"])) : receivedAt;

        List<TimelineItem>? items = null;
        if (timeline)
        {
            items = [];
            foreach (var e in evs)
            {
                var kind = (string)e["kind"]!;
                var fin = kind == "delivery" ? IsFinal(e) : (string)e["agentRole"]! == "outbound" || !hasOutbound;
                if (kind == "reject" && !fin) { items.Add(new TimelineItem(At(L(e["ts"])), hopOf[(string)e["agentId"]!], kind, "rejected", null, null, "Rejected by the mail system")); continue; }
                items.Add(new TimelineItem(At(L(e["ts"])), hopOf[(string)e["agentId"]!], kind, e["status"] as string,
                    e["recipient"] as string, e["dsn"] as string,
                    kind == "delivery" && !fin ? "Handed over to the next mail server" : e["detail"] as string));
            }
        }

        return new MessageStatusResult(rawId, true, overall, isDone, Summarize(overall, recipients, pending, failed),
            sender0, At(receivedAt), At(lastEvent), deliveredAt,
            deliveredAt is { } da ? Math.Round((da - At(receivedAt)).TotalSeconds, 1) : null,
            Math.Max(recipients.Count, expectedRecipients), recipients, items, logsUntil);
    }

    private static int NRcpt(string? detail)
    {
        if (detail is null) return 0;
        var i = detail.IndexOf("nrcpt=", StringComparison.Ordinal);
        if (i < 0) return 0;
        var j = i + 6;
        var k = j;
        while (k < detail.Length && char.IsAsciiDigit(detail[k])) k++;
        return int.TryParse(detail.AsSpan(j, k - j), out var n) ? n : 0;
    }

    private static string DomainOf(string address)
    {
        var at = address.LastIndexOf('@');
        return at < 0 ? "" : address[(at + 1)..].ToLowerInvariant();
    }

    private static string Summarize(string status, List<RecipientStatus> r, int pending, int failed)
    {
        string Reason() => r.Where(x => x.Status is MailStatus.Bounced or MailStatus.Deferred or MailStatus.Expired)
            .Select(x => string.Join(' ', new[] { x.Dsn, x.Detail }.Where(s => !string.IsNullOrWhiteSpace(s)))).FirstOrDefault(s => s.Length > 0) is { } s
            ? ": " + (s.Length > 200 ? s[..200] + "…" : s) : "";
        return status switch
        {
            MailStatus.Delivered => r.Count == 1 ? $"Delivered to {r[0].Address}" : $"Delivered to all {r.Count} recipients",
            MailStatus.Deferred => "Not delivered yet, the mail server keeps retrying" + Reason(),
            MailStatus.InTransit => "Accepted and on its way to the recipient's mail server",
            MailStatus.Queued => "Accepted by the mail system, delivery has not started yet",
            MailStatus.Bounced => "Permanently refused by the recipient's mail server" + Reason(),
            MailStatus.Expired => "Gave up after repeated failures (message expired)" + Reason(),
            MailStatus.Partial => $"Delivered to {r.Count - failed - pending} of {r.Count} recipients, {failed} failed",
            MailStatus.Rejected => "Rejected by the mail system",
            _ => status,
        };
    }

    private static MessageStatusResult NotFound(string id, DateTimeOffset? logsUntil) =>
        new(id, false, MailStatus.NotFound, false,
            "No log entries for this Message-ID. It may not have been sent from an allowed domain, or its logs have not arrived yet (see logsCompleteUntil).",
            null, null, null, null, null, 0, [], null, logsUntil);
}

public static class MessageStatusApi
{
    private static IResult TooMany() => Results.Json(new { error = $"Rate limit: at most {KeyRateLimiter.PerMinute} requests per minute per API key" },
        statusCode: StatusCodes.Status429TooManyRequests, contentType: "application/json");

    private static bool Throttled(HttpContext c, Me me, KeyRateLimiter limiter)
    {
        if (me.Role != Roles.ApiKey) return false;
        if (limiter.Allow(me.Id)) return false;
        c.Response.Headers.RetryAfter = "60";
        return true;
    }

    public static void Map(WebApplication app)
    {
        // "lookup": any authenticated caller, including API keys (every other endpoint rejects API keys)
        var g = app.MapGroup("/api/v1").RequireAuthorization("lookup").WithTags("Message status");

        g.MapGet("/messages/status", (string messageId, bool? timeline, HttpContext c, MessageStatusService svc, KeyRateLimiter limiter) =>
        {
            var me = Me.From(c.User)!;
            if (Throttled(c, me, limiter)) return TooMany();
            var r = svc.Lookup(messageId, me, timeline == true);
            return r.Found ? Results.Ok(r) : Results.Json(r, statusCode: StatusCodes.Status404NotFound);
        }).WithSummary("Status of one message by its Message-ID header")
          .WithDescription("`messageId` is the value of the Message-ID header, with or without the angle brackets. " +
                           "404 when no message with that id and an allowed sender domain is known (also for ids of other domains). " +
                           "Add `timeline=true` for the individual steps.");

        g.MapPost("/messages/status", (MessageStatusBatchDto dto, HttpContext c, MessageStatusService svc, KeyRateLimiter limiter) =>
        {
            var me = Me.From(c.User)!;
            if (dto.MessageIds is not { Length: > 0 }) return Results.BadRequest(new { error = "messageIds is required" });
            if (dto.MessageIds.Length > MessageStatusService.MaxBatch)
                return Results.BadRequest(new { error = $"At most {MessageStatusService.MaxBatch} message ids per request" });
            if (Throttled(c, me, limiter)) return TooMany();
            var until = svc.LogsCompleteUntil();
            var results = dto.MessageIds.Distinct().Select(id => svc.Lookup(id, me, dto.Timeline, until)).ToList();
            return Results.Ok(new { results, logsCompleteUntil = until });
        }).WithSummary("Status of up to 100 messages in one request")
          .WithDescription("Always 200; unknown ids (or ids of other domains) come back with `found: false` and `status: not_found`.");

        g.MapGet("/key", (HttpContext c, Db db) =>
        {
            var me = Me.From(c.User)!;
            if (me.Role != Roles.ApiKey)
                return Results.Ok(new { kind = "user", name = me.Username, role = me.Role, domains = me.Scoped ? me.Domains : null, expiresAt = (long?)null });
            var row = db.Rows("SELECT name, domains, expires_at FROM api_keys WHERE id=@id", new { id = me.Id }).FirstOrDefault();
            return Results.Ok(new { kind = "apikey", name = me.Username, role = me.Role, domains = me.Domains, expiresAt = row?["expiresAt"] });
        }).WithSummary("Who am I: name, sender domains and expiry of the calling API key (connection test)");
    }
}
