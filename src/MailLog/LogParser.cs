using System.Globalization;
using System.Text.RegularExpressions;

namespace MailLog;

public sealed record ParsedEvent(
    long Ts, string Source, string? Program, int? Pid, string? QueueId, string Kind,
    string? Sender, string? Recipient, string? ClientIp, string? ClientHost, string? SaslUser,
    string? Relay, string? Status, string? Dsn, string? NextQueueId, double? DelayS,
    string? Detail, string Raw, string? MessageId = null);

/// <summary>
/// Turns raw syslog lines (Postfix, OpenDKIM, saslauthd) and fail2ban log lines into structured events.
/// Kinds: queued, delivery, accepted, reject, auth_fail, ratelimit, connect, disconnect, conn_error, foreign_sender,
/// dkim_signed, ban, unban, f2b_found, sasl_authd_fail, error, service, meta, info.
/// </summary>
public static partial class LogParser
{
    // 2026-11-05T21:56:22.607289+01:00 mailout postfix/smtpd[7998]: message
    [GeneratedRegex(@"^(?<ts>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d))\s+(?<host>\S+)\s+(?<prog>[^\s\[:]+)(?:\[(?<pid>\d+)\])?:\s?(?<msg>.*)$")]
    private static partial Regex IsoHeader();

    // Nov  5 21:56:22 mailout postfix/smtpd[7998]: message
    [GeneratedRegex(@"^(?<mon>[A-Z][a-z]{2})\s+(?<day>\d{1,2})\s(?<time>\d\d:\d\d:\d\d)\s+(?<host>\S+)\s+(?<prog>[^\s\[:]+)(?:\[(?<pid>\d+)\])?:\s?(?<msg>.*)$")]
    private static partial Regex ClassicHeader();

    // 2026-11-05 11:14:09,357 fail2ban.actions        [758]: NOTICE  [postfix-sasl] Ban 203.0.113.66
    [GeneratedRegex(@"^(?<ts>\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)(?:,\d+)?\s+fail2ban\.\w+\s+\[\d+\]:\s+\w+\s+(?:\[(?<jail>[^\]]+)\]\s+)?(?<msg>.*)$")]
    private static partial Regex Fail2banLine();

    [GeneratedRegex(@"^(?<qid>(?=[0-9A-Za-z]*\d)[0-9A-Za-z]{10,16}): (?<rest>.*)$")]
    private static partial Regex QidLine();

    [GeneratedRegex(@"^to=<(?<to>[^>]*)>, (?:orig_to=<[^>]*>, )?relay=(?<relay>[^,]*), (?:conn_use=\d+, )?delay=(?<delay>[\d.]+), delays=[\d./]+, dsn=(?<dsn>[\d.]+), status=(?<status>\w+) \((?<detail>.*)\)\s*$")]
    private static partial Regex Delivery();

    [GeneratedRegex(@"^from=<(?<from>[^>]*)>, size=(?<size>\d+), nrcpt=(?<n>\d+) \(queue (?<q>\w+)\)")]
    private static partial Regex Queued();

    [GeneratedRegex(@"^from=<(?<from>[^>]*)>, status=expired")]
    private static partial Regex Expired();

    [GeneratedRegex(@"^client=(?<host>[^\[]*)\[(?<ip>[^\]]*)\](?:, sasl_method=(?<method>\w+))?(?:, sasl_username=(?<user>[^,\s]+))?")]
    private static partial Regex Accepted();

    [GeneratedRegex(@"^NOQUEUE: (?<act>reject|filter|discard): (?<cmd>\w+) from (?<host>[^\[]*)\[(?<ip>[^\]]*)\]: (?<detail>.*)$")]
    private static partial Regex NoQueueReject();

    [GeneratedRegex(@"from=<(?<from>[^>]*)>")]
    private static partial Regex FromAddr();

    [GeneratedRegex(@"\bto=<(?<to>[^>]*)>")]
    private static partial Regex ToAddr();

    [GeneratedRegex(@"^NOQUEUE: (?<what>lost connection|timeout|too many errors)[^\[]*from (?<host>[^\[]*)\[(?<ip>[^\]]*)\]")]
    private static partial Regex NoQueueConn();

    [GeneratedRegex(@"^(?<dir>connect|disconnect) from (?<host>[^\[]*)\[(?<ip>[^\]]*)\]")]
    private static partial Regex ConnectLine();

    [GeneratedRegex(@"^warning: (?<host>[^\[:]*)\[(?<ip>[^\]]*)\]: SASL (?<mech>\S+) authentication failed: (?<reason>.*?)(?:, sasl_username=(?<user>.*))?$")]
    private static partial Regex SaslFail();

    [GeneratedRegex(@"rate limit exceeded|too much mail from|too many recipients from|too many connections from|too many errors after", RegexOptions.IgnoreCase)]
    private static partial Regex RateLimit();

    [GeneratedRegex(@"from (?<host>[^\[\s]*)\[(?<ip>[^\]]+)\]")]
    private static partial Regex FromClient();

    [GeneratedRegex(@"queued as (?<id>[0-9A-Za-z]{6,16})")]
    private static partial Regex QueuedAs();

    [GeneratedRegex(@"no signing table match for '(?<s>[^']*)'")]
    private static partial Regex NoSigning();

    [GeneratedRegex(@"^(?<ip>\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]+)\b")]
    private static partial Regex LeadingIp();

    private static readonly string[] Months =
        ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    /// <param name="tzOffsetMinutes">Agent's local UTC offset, used for timestamps without zone information.</param>
    public static ParsedEvent Parse(string line, string source, int tzOffsetMinutes, DateTimeOffset now)
    {
        line = line.TrimEnd('\r', '\n');

        if (source == "fail2ban")
        {
            var f = Fail2banLine().Match(line);
            if (f.Success && DateTime.TryParseExact(f.Groups["ts"].Value, "yyyy-MM-dd HH:mm:ss",
                    CultureInfo.InvariantCulture, DateTimeStyles.None, out var local))
            {
                var ts = new DateTimeOffset(local, TimeSpan.FromMinutes(tzOffsetMinutes)).ToUnixTimeMilliseconds();
                return ParseFail2ban(ts, f.Groups["jail"].Value, f.Groups["msg"].Value, line);
            }
            return Generic(now.ToUnixTimeMilliseconds(), source, "info", line);
        }

        long tsMs;
        string host, prog, msg;
        int? pid = null;

        var m = IsoHeader().Match(line);
        if (m.Success)
        {
            tsMs = DateTimeOffset.Parse(m.Groups["ts"].Value, CultureInfo.InvariantCulture).ToUnixTimeMilliseconds();
        }
        else
        {
            m = ClassicHeader().Match(line);
            if (!m.Success) return Generic(now.ToUnixTimeMilliseconds(), source, "info", line);
            var mon = Array.IndexOf(Months, m.Groups["mon"].Value) + 1;
            var year = now.Year;
            var dt = new DateTime(year, mon, int.Parse(m.Groups["day"].Value),
                int.Parse(m.Groups["time"].Value[..2]), int.Parse(m.Groups["time"].Value[3..5]), int.Parse(m.Groups["time"].Value[6..8]));
            var off = new DateTimeOffset(dt, TimeSpan.FromMinutes(tzOffsetMinutes));
            if (off > now.AddDays(1)) off = off.AddYears(-1);
            tsMs = off.ToUnixTimeMilliseconds();
        }

        host = m.Groups["host"].Value;
        prog = m.Groups["prog"].Value;
        msg = m.Groups["msg"].Value;
        if (m.Groups["pid"].Success && int.TryParse(m.Groups["pid"].Value, out var p)) pid = p;

        if (prog.StartsWith("opendkim", StringComparison.Ordinal))
            return ParseOpenDkim(tsMs, source, prog, pid, msg, line);
        if (prog.StartsWith("saslauthd", StringComparison.Ordinal))
        {
            var k = msg.Contains("auth failure", StringComparison.OrdinalIgnoreCase) ? "sasl_authd_fail" : "info";
            return new ParsedEvent(tsMs, source, prog, pid, null, k, null, null, null, null, null, null, null, null, null, null, Trunc(msg), line);
        }

        return ParsePostfix(tsMs, source, prog, pid, msg, line);
    }

    private static ParsedEvent ParsePostfix(long ts, string source, string prog, int? pid, string msg, string raw)
    {
        ParsedEvent E(string kind, string? qid = null, string? sender = null, string? rcpt = null, string? cip = null,
            string? chost = null, string? sasl = null, string? relay = null, string? status = null, string? dsn = null,
            string? next = null, double? delay = null, string? detail = null, string? mid = null) =>
            new(ts, source, prog, pid, qid, kind, sender, rcpt, cip, Host(chost), sasl, relay, status, dsn, next, delay, Trunc(detail), raw, mid);

        var q = QidLine().Match(msg);
        if (q.Success)
        {
            var qid = q.Groups["qid"].Value;
            var rest = q.Groups["rest"].Value;

            var d = Delivery().Match(rest);
            if (d.Success)
            {
                var detail = d.Groups["detail"].Value;
                var next = QueuedAs().Match(detail);
                return E("delivery", qid, rcpt: d.Groups["to"].Value, relay: d.Groups["relay"].Value,
                    status: d.Groups["status"].Value, dsn: d.Groups["dsn"].Value,
                    next: next.Success ? next.Groups["id"].Value : null,
                    delay: double.Parse(d.Groups["delay"].Value, CultureInfo.InvariantCulture), detail: detail);
            }
            var qd = Queued().Match(rest);
            if (qd.Success)
                return E("queued", qid, sender: qd.Groups["from"].Value,
                    detail: $"size={qd.Groups["size"].Value} nrcpt={qd.Groups["n"].Value}");
            var ex = Expired().Match(rest);
            if (ex.Success) return E("delivery", qid, sender: ex.Groups["from"].Value, status: "expired", detail: rest);
            var ac = Accepted().Match(rest);
            if (ac.Success)
                return E("accepted", qid, cip: ac.Groups["ip"].Value, chost: ac.Groups["host"].Value,
                    sasl: ac.Groups["user"].Success ? ac.Groups["user"].Value : null,
                    detail: ac.Groups["method"].Success ? "sasl " + ac.Groups["method"].Value : null);
            if (rest.StartsWith("reject:", StringComparison.Ordinal) || rest.StartsWith("milter-reject:", StringComparison.Ordinal))
            {
                var fm = FromAddr().Match(rest); var tm = ToAddr().Match(rest);
                return E("reject", qid, sender: fm.Success ? fm.Groups["from"].Value : null,
                    rcpt: tm.Success ? tm.Groups["to"].Value : null, detail: rest);
            }
            if (rest.StartsWith("message-id=", StringComparison.Ordinal))
                return E("meta", qid, detail: rest, mid: NormalizeMessageId(rest["message-id=".Length..]));
            if (rest.StartsWith("removed", StringComparison.Ordinal)
                || rest.StartsWith("warning: header", StringComparison.Ordinal) || rest.StartsWith("resent-message-id=", StringComparison.Ordinal))
                return E("meta", qid, detail: rest);
            return E("info", qid, detail: rest);
        }

        var nr = NoQueueReject().Match(msg);
        if (nr.Success)
        {
            var det = nr.Groups["detail"].Value;
            var fm = FromAddr().Match(det); var tm = ToAddr().Match(det);
            return E("reject", "NOQUEUE", sender: fm.Success ? fm.Groups["from"].Value : null,
                rcpt: tm.Success ? tm.Groups["to"].Value : null, cip: nr.Groups["ip"].Value,
                chost: nr.Groups["host"].Value, status: nr.Groups["act"].Value, detail: det);
        }

        var nc = NoQueueConn().Match(msg);
        if (nc.Success)
            return E("conn_error", cip: nc.Groups["ip"].Value, chost: nc.Groups["host"].Value, detail: msg);

        var cl = ConnectLine().Match(msg);
        if (cl.Success)
            return E(cl.Groups["dir"].Value, cip: cl.Groups["ip"].Value, chost: cl.Groups["host"].Value,
                detail: cl.Groups["dir"].Value == "disconnect" ? msg[(cl.Length)..].Trim() : null);

        var sf = SaslFail().Match(msg);
        if (sf.Success)
            return E("auth_fail", cip: sf.Groups["ip"].Value, chost: sf.Groups["host"].Value,
                sasl: sf.Groups["user"].Success ? sf.Groups["user"].Value : null,
                detail: sf.Groups["reason"].Value);

        if (RateLimit().IsMatch(msg))
        {
            var fc = FromClient().Match(msg);
            return E("ratelimit", cip: fc.Success ? fc.Groups["ip"].Value : null,
                chost: fc.Success ? fc.Groups["host"].Value : null, detail: msg);
        }

        if (msg.StartsWith("daemon started", StringComparison.Ordinal) || msg.StartsWith("reload", StringComparison.Ordinal)
            || msg.StartsWith("terminating", StringComparison.Ordinal) || msg.StartsWith("warning: process", StringComparison.Ordinal))
            return E("service", detail: msg);

        if (msg.StartsWith("fatal:", StringComparison.Ordinal) || msg.StartsWith("panic:", StringComparison.Ordinal)
            || msg.StartsWith("error:", StringComparison.Ordinal) || msg.Contains("SASL authentication problem", StringComparison.Ordinal))
            return E("error", detail: msg);

        if (msg.StartsWith("lost connection", StringComparison.Ordinal) || msg.StartsWith("timeout after", StringComparison.Ordinal)
            || msg.StartsWith("SSL_accept error", StringComparison.Ordinal))
            return E("conn_error", detail: msg);

        return E("info", detail: msg);
    }

    private static ParsedEvent ParseOpenDkim(long ts, string source, string prog, int? pid, string msg, string raw)
    {
        string? qid = null;
        var idx = msg.IndexOf(": ", StringComparison.Ordinal);
        if (idx is > 5 and < 20 && !msg.AsSpan(0, idx).Contains(' ')) { qid = msg[..idx]; msg = msg[(idx + 2)..]; }

        var ns = NoSigning().Match(msg);
        if (ns.Success)
            return new ParsedEvent(ts, source, prog, pid, qid, "foreign_sender", ns.Groups["s"].Value, null, null, null, null,
                null, null, null, null, null, Trunc(msg), raw);
        if (msg.StartsWith("DKIM-Signature field added", StringComparison.Ordinal))
            return new ParsedEvent(ts, source, prog, pid, qid, "dkim_signed", null, null, null, null, null,
                null, null, null, null, null, Trunc(msg), raw);
        return new ParsedEvent(ts, source, prog, pid, qid, "info", null, null, null, null, null,
            null, null, null, null, null, Trunc(msg), raw);
    }

    private static ParsedEvent ParseFail2ban(long ts, string jail, string msg, string raw)
    {
        var parts = msg.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries);
        string kind = "info";
        string? ip = null;
        if (parts.Length == 2)
        {
            var ipm = LeadingIp().Match(parts[1]);
            switch (parts[0])
            {
                case "Ban": kind = "ban"; ip = ipm.Success ? ipm.Groups["ip"].Value : null; break;
                case "Unban": kind = "unban"; ip = ipm.Success ? ipm.Groups["ip"].Value : null; break;
                case "Found": kind = "f2b_found"; ip = ipm.Success ? ipm.Groups["ip"].Value : null; break;
                case "Restore" when parts[1].StartsWith("Ban", StringComparison.Ordinal):
                    kind = "ban";
                    var rm = LeadingIp().Match(parts[1][3..].Trim());
                    ip = rm.Success ? rm.Groups["ip"].Value : null;
                    break;
            }
        }
        return new ParsedEvent(ts, "fail2ban", "fail2ban", null, null, kind, null, null, ip, null, null,
            null, null, null, null, null, Trunc(string.IsNullOrEmpty(jail) ? msg : jail + ": " + msg), raw);
    }

    private static ParsedEvent Generic(long ts, string source, string kind, string raw) =>
        new(ts, source, null, null, null, kind, null, null, null, null, null, null, null, null, null, null, Trunc(raw), raw);

    /// <summary>"&lt;abc@example.org&gt;" and "abc@example.org" both become "abc@example.org"; null when nothing usable is left.</summary>
    public static string? NormalizeMessageId(string? id)
    {
        if (string.IsNullOrWhiteSpace(id)) return null;
        var v = id.Trim();
        if (v.StartsWith('<') && v.EndsWith('>')) v = v[1..^1].Trim();
        return v.Length is 0 or > 998 || v.Any(char.IsControl) ? null : v;
    }

    private static string? Host(string? h) =>
        string.IsNullOrEmpty(h) || h == "unknown" ? null : h;

    private static string? Trunc(string? s) =>
        s is { Length: > 1000 } ? s[..1000] : s;
}
