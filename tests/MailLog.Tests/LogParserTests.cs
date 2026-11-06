using MailLog;
using Xunit;

namespace MailLog.Tests;

/// <summary>Parser tests use real (anonymised where needed) lines from Postfix 3.10 / OpenDKIM / fail2ban on Debian 13.</summary>
public class LogParserTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 6, 12, 0, 0, TimeSpan.FromHours(1));
    private static ParsedEvent P(string line, string source = "mail") => LogParser.Parse(line, source, 60, Now);

    [Fact]
    public void Delivery_to_next_hop_extracts_next_queue_id()
    {
        var e = P("2026-11-01T00:58:00.798254+01:00 smtp2 postfix/smtp[3441020]: 9C2197F869: to=<welcome@customer-d.example>, relay=10.0.0.72[10.0.0.72]:25, delay=0.16, delays=0.02/0.01/0.02/0.11, dsn=2.0.0, status=sent (250 2.0.0 Ok: queued as AAAB15FA5C)");
        Assert.Equal("delivery", e.Kind);
        Assert.Equal("9C2197F869", e.QueueId);
        Assert.Equal("AAAB15FA5C", e.NextQueueId);
        Assert.Equal("sent", e.Status);
        Assert.Equal("welcome@customer-d.example", e.Recipient);
        Assert.Equal("2.0.0", e.Dsn);
        Assert.Equal(0.16, e.DelayS);
        Assert.Equal("postfix/smtp", e.Program);
        Assert.Equal(new DateTimeOffset(2026, 11, 1, 0, 58, 0, 798, TimeSpan.FromHours(1)).ToUnixTimeMilliseconds() / 1000,
            e.Ts / 1000);
    }

    [Fact]
    public void Deferred_delivery_with_long_gmail_reply()
    {
        var e = P("2026-11-01T00:40:56.415238+01:00 mailout postfix/smtp[1466085]: 6C4055FC24: to=<recipient1@gmail.com>, relay=alt1.gmail-smtp-in.l.google.com[142.250.147.26]:25, delay=227197, delays=227196/0.01/1.1/0.16, dsn=4.2.2, status=deferred (host alt1.gmail-smtp-in.l.google.com[142.250.147.26] said: 452-4.2.2 The recipient's inbox is out of storage space. Please direct the 452-4.2.2 recipient to 452 4.2.2  https://support.google.com/mail/?p=OverQuotaTemp 4fb4d7f45d1cf-6b5028af3cesi937100a12.6 - gsmtp (in reply to RCPT TO command))");
        Assert.Equal("delivery", e.Kind);
        Assert.Equal("deferred", e.Status);
        Assert.Equal("4.2.2", e.Dsn);
        Assert.Contains("out of storage space", e.Detail);
    }

    [Fact]
    public void Bounced_delivery()
    {
        var e = P("2026-11-01T13:50:57.892247+01:00 mailout postfix/smtp[1471378]: 8C2C65FA5A: to=<no-reply@customer-c.example>, relay=mx2.mxfilter.net[23.172.136.2]:25, delay=0.32, delays=0.01/0/0.23/0.08, dsn=5.0.0, status=bounced (host mx2.mxfilter.net[23.172.136.2] said: 550 User unknown (in reply to RCPT TO command))");
        Assert.Equal("bounced", e.Status);
        Assert.Equal("no-reply@customer-c.example", e.Recipient);
    }

    [Fact]
    public void Queued_line_carries_sender()
    {
        var e = P("2026-11-01T00:58:00.660095+01:00 smtp2 postfix/qmgr[3121297]: 9C2197F869: from=<noreply@customer-a.example>, size=38617, nrcpt=1 (queue active)");
        Assert.Equal("queued", e.Kind);
        Assert.Equal("noreply@customer-a.example", e.Sender);
        Assert.Equal("9C2197F869", e.QueueId);
    }

    [Fact]
    public void Accepted_line_has_client_and_sasl_user()
    {
        var e = P("2026-11-01T00:58:00.639651+01:00 smtp2 postfix/smtpd[3441014]: 9C2197F869: client=app1.client.example.net[203.0.113.66], sasl_method=LOGIN, sasl_username=smtp_relay_app1");
        Assert.Equal("accepted", e.Kind);
        Assert.Equal("203.0.113.66", e.ClientIp);
        Assert.Equal("app1.client.example.net", e.ClientHost);
        Assert.Equal("smtp_relay_app1", e.SaslUser);
    }

    [Fact]
    public void Accepted_from_unknown_host_has_no_client_host()
    {
        var e = P("2026-11-01T00:58:00.699200+01:00 mailout postfix/smtpd[1466171]: AAAB15FA5C: client=unknown[10.0.0.74]");
        Assert.Equal("accepted", e.Kind);
        Assert.Null(e.ClientHost);
        Assert.Equal("10.0.0.74", e.ClientIp);
    }

    [Theory]
    [InlineData("SASL LOGIN authentication failed: generic failure, sasl_username=smtp_relay_app1", "generic failure", "smtp_relay_app1")]
    [InlineData("SASL PLAIN authentication failed: authentication failure, sasl_username=manuel", "authentication failure", "manuel")]
    public void Sasl_failures_distinguish_backend_errors(string tail, string reason, string user)
    {
        var e = P($"2026-11-05T11:13:10.723609+01:00 smtp2 postfix/smtpd[1049]: warning: app1.client.example.net[203.0.113.66]: {tail}");
        Assert.Equal("auth_fail", e.Kind);
        Assert.Equal(reason, e.Detail);
        Assert.Equal(user, e.SaslUser);
        Assert.Equal("203.0.113.66", e.ClientIp);
    }

    [Fact]
    public void Sasl_failure_from_unknown_host()
    {
        var e = P("2026-11-05T10:22:29.375491+01:00 smtp2 postfix/smtpd[916]: warning: unknown[198.51.100.66]: SASL PLAIN authentication failed: generic failure, sasl_username=smtp_relay_app3");
        Assert.Equal("auth_fail", e.Kind);
        Assert.Null(e.ClientHost);
        Assert.Equal("198.51.100.66", e.ClientIp);
    }

    [Fact]
    public void Rate_limit_warning()
    {
        var e = P("2026-11-05T21:56:22.607289+01:00 mailout postfix/smtpd[7998]: warning: Message delivery request rate limit exceeded: 1001 from unknown[10.0.0.74] for service smtp");
        Assert.Equal("ratelimit", e.Kind);
        Assert.Equal("10.0.0.74", e.ClientIp);
    }

    [Fact]
    public void Opendkim_foreign_sender()
    {
        var e = P("2026-11-03T18:30:03.336483+01:00 mailout opendkim[680]: 46E195FA5A: no signing table match for 'postmaster@mail.example'");
        Assert.Equal("foreign_sender", e.Kind);
        Assert.Equal("postmaster@mail.example", e.Sender);
        Assert.Equal("46E195FA5A", e.QueueId);
    }

    [Fact]
    public void Opendkim_signature()
    {
        var e = P("2026-11-01T00:58:00.742609+01:00 mailout opendkim[680]: AAAB15FA5C: DKIM-Signature field added (s=customer_a, d=customer-a.example)");
        Assert.Equal("dkim_signed", e.Kind);
        Assert.Equal("AAAB15FA5C", e.QueueId);
    }

    [Fact]
    public void Connect_disconnect_and_noqueue()
    {
        Assert.Equal("connect", P("2026-11-01T00:36:08.000000+01:00 smtp2 postfix/smtpd[3440996]: connect from scanner.example.org[66.132.159.142]").Kind);
        Assert.Equal("disconnect", P("2026-10-25T07:47:40.023101+01:00 smtp2 postfix/smtpd[3422000]: disconnect from app2.client.example.net[203.0.113.39] ehlo=1 auth=1 mail=1 rcpt=1 data=1 quit=1 commands=6").Kind);
        var e = P("2026-11-01T00:36:08.052513+01:00 smtp2 postfix/smtpd[3440996]: NOQUEUE: lost connection after STARTTLS from scanner.example.org[66.132.159.142]");
        Assert.Equal("conn_error", e.Kind);
        Assert.Equal("66.132.159.142", e.ClientIp);
    }

    [Fact]
    public void Noqueue_reject_extracts_addresses()
    {
        var e = P("2026-11-01T01:00:00.000000+01:00 smtp2 postfix/smtpd[1]: NOQUEUE: reject: RCPT from unknown[1.2.3.4]: 454 4.7.1 <x@y.com>: Relay access denied; from=<a@b.com> to=<x@y.com> proto=ESMTP helo=<h>");
        Assert.Equal("reject", e.Kind);
        Assert.Equal("a@b.com", e.Sender);
        Assert.Equal("x@y.com", e.Recipient);
        Assert.Equal("1.2.3.4", e.ClientIp);
    }

    [Fact]
    public void Statistics_line_is_not_mistaken_for_a_queue_id()
    {
        var e = P("2026-11-01T01:00:00.000000+01:00 smtp2 postfix/anvil[1]: statistics: max connection rate 2/60s for (smtp:1.2.3.4) at Nov  1 01:00:00");
        Assert.Null(e.QueueId);
        Assert.Equal("info", e.Kind);
    }

    [Fact]
    public void Fail2ban_ban_unban_and_found_use_agent_time_zone()
    {
        var ban = P("2026-11-05 11:14:09,357 fail2ban.actions        [758]: NOTICE  [postfix-sasl] Ban 203.0.113.66", "fail2ban");
        Assert.Equal("ban", ban.Kind);
        Assert.Equal("203.0.113.66", ban.ClientIp);
        Assert.Equal(new DateTimeOffset(2026, 11, 5, 11, 14, 9, TimeSpan.FromHours(1)).ToUnixTimeMilliseconds(), ban.Ts);
        Assert.Equal("unban", P("2026-11-05 21:52:43,199 fail2ban.actions        [758]: NOTICE  [postfix-sasl] Unban 203.0.113.66", "fail2ban").Kind);
        var found = P("2026-11-05 11:13:10,000 fail2ban.filter         [758]: INFO    [postfix-sasl] Found 203.0.113.66 - 2026-11-05 11:13:10", "fail2ban");
        Assert.Equal("f2b_found", found.Kind);
        Assert.Equal("203.0.113.66", found.ClientIp);
    }

    [Fact]
    public void Classic_syslog_header_is_supported()
    {
        var e = P("Nov  5 21:56:22 mailout postfix/smtpd[7998]: connect from unknown[10.0.0.1]");
        Assert.Equal("connect", e.Kind);
        Assert.Equal("postfix/smtpd", e.Program);
    }

    [Fact]
    public void Garbage_does_not_throw()
    {
        Assert.Equal("info", P("this is not a log line").Kind);
        Assert.Equal("info", P("", "mail").Kind);
    }

    [Fact]
    public void Camel_case_conversion()
    {
        Assert.Equal("queueId", Db.CamelCase("queue_id"));
        Assert.Equal("agentName", Db.CamelCase("agent_name"));
        Assert.Equal("id", Db.CamelCase("id"));
    }

    [Fact]
    public void Password_hash_roundtrip()
    {
        var h = Passwords.Hash("correct horse battery staple");
        Assert.True(Passwords.Verify("correct horse battery staple", h));
        Assert.False(Passwords.Verify("wrong", h));
        Assert.False(Passwords.Verify("x", "garbage"));
    }

    [Fact]
    public void Domains_are_normalised()
    {
        Assert.Equal(["customer-a.example", "customer-b.example"], UserStore.NormalizeDomains(["@Customer-A.example ", "customer-b.example", "customer-a.example", ""]));
    }
}
