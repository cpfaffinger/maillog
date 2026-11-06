using System.Text;
using MailKit.Net.Smtp;
using MailKit.Security;
using MimeKit;

namespace MailLog;

/// <summary>Delivers alert notifications to the configured channels (SMTP, signal-cli-rest-api, webhook). Configuration lives in the database.</summary>
public sealed class Notifier(Settings s, ChannelStore channels, IHttpClientFactory http, ILogger<Notifier> log)
{
    public static bool SmtpReady(SmtpConfig c) => c.Enabled && c.Host.Length > 0 && c.From.Length > 0 && c.To.Length > 0;
    public static bool SignalReady(SignalConfig c) => c.Enabled && c.Url.Length > 0 && c.Number.Length > 0 && c.Recipients.Length > 0;
    public static bool WebhookReady(WebhookConfig c) => c.Enabled && c.Url.Length > 0;

    public object Status()
    {
        var c = channels.Get();
        return new { webhook = WebhookReady(c.Webhook), signal = SignalReady(c.Signal), smtp = SmtpReady(c.Smtp) };
    }

    /// <summary>Sends to every enabled channel. <paramref name="state"/>: open | resolved | info.</summary>
    public async Task<List<string>> SendAsync(string title, string body, string severity, string state, CancellationToken ct = default)
    {
        var errors = new List<string>();
        var set = channels.Get();
        var prefix = state switch { "resolved" => "[RESOLVED] ", "info" => "[INFO] ", _ => $"[{severity.ToUpperInvariant()}] " };
        var subject = prefix + title;
        var text = subject + (string.IsNullOrWhiteSpace(body) ? "" : "\n" + body);
        if (s.PublicUrl is not null) text += "\n" + s.PublicUrl;

        if (WebhookReady(set.Webhook)) await Try("webhook", () => Webhook(set.Webhook, subject, body, severity, state, text, ct), errors);
        if (SignalReady(set.Signal)) await Try("signal", () => Signal(set.Signal, text, ct), errors);
        if (SmtpReady(set.Smtp)) await Try("smtp", () => Smtp(set.Smtp, subject, text, ct), errors);
        if (!WebhookReady(set.Webhook) && !SignalReady(set.Signal) && !SmtpReady(set.Smtp))
            log.LogInformation("No alert channel enabled: {Text}", text);
        return errors;
    }

    /// <summary>Sends a test message through exactly one channel using the given (possibly unsaved) configuration.</summary>
    public async Task<List<string>> TestAsync(string channel, ChannelSet set, CancellationToken ct = default)
    {
        var errors = new List<string>();
        const string subject = "[TEST] maillog alert channel";
        var text = subject + "\nThis is a test message from maillog. If you can read it, this channel works." + (s.PublicUrl is not null ? "\n" + s.PublicUrl : "");
        switch (channel)
        {
            case "smtp":
                if (set.Smtp.Host.Length == 0 || set.Smtp.From.Length == 0 || set.Smtp.To.Length == 0) return ["SMTP: server, sender and at least one recipient are required"];
                await Try("smtp", () => Smtp(set.Smtp, subject, text, ct), errors); break;
            case "signal":
                if (set.Signal.Url.Length == 0 || set.Signal.Number.Length == 0 || set.Signal.Recipients.Length == 0) return ["Signal: URL, sender number and at least one recipient are required"];
                await Try("signal", () => Signal(set.Signal, text, ct), errors); break;
            case "webhook":
                if (set.Webhook.Url.Length == 0) return ["Webhook: URL is required"];
                await Try("webhook", () => Webhook(set.Webhook, subject, "This is a test message from maillog.", "info", "info", text, ct), errors); break;
            default: return ["Unknown channel"];
        }
        return errors;
    }

    private async Task Try(string channel, Func<Task> action, List<string> errors)
    {
        try { await action(); }
        catch (Exception e)
        {
            log.LogWarning(e, "Notification channel {Channel} failed", channel);
            errors.Add($"{channel}: {e.Message}");
        }
    }

    private async Task Webhook(WebhookConfig c, string subject, string body, string severity, string state, string text, CancellationToken ct)
    {
        var client = http.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(15);
        HttpResponseMessage res;
        switch (c.Format)
        {
            case "slack":
                res = await client.PostAsJsonAsync(c.Url, new { text }, ct); break;
            case "discord":
                res = await client.PostAsJsonAsync(c.Url, new { content = text.Length > 1900 ? text[..1900] : text }, ct); break;
            case "ntfy":
                using (var req = new HttpRequestMessage(HttpMethod.Post, c.Url) { Content = new StringContent(body.Length == 0 ? subject : body, Encoding.UTF8) })
                {
                    req.Headers.TryAddWithoutValidation("Title", subject);
                    req.Headers.TryAddWithoutValidation("Priority", severity == "critical" ? "urgent" : severity == "warning" ? "high" : "default");
                    res = await client.SendAsync(req, ct);
                }
                break;
            default:
                res = await client.PostAsJsonAsync(c.Url, new { title = subject, body, severity, state, text, time = DateTimeOffset.UtcNow }, ct); break;
        }
        res.EnsureSuccessStatusCode();
    }

    private async Task Signal(SignalConfig c, string text, CancellationToken ct)
    {
        var client = http.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(30);
        var res = await client.PostAsJsonAsync($"{c.Url.TrimEnd('/')}/v2/send", new { message = text, number = c.Number, recipients = c.Recipients }, ct);
        res.EnsureSuccessStatusCode();
    }

    private async Task Smtp(SmtpConfig c, string subject, string text, CancellationToken ct)
    {
        var msg = new MimeMessage();
        msg.From.Add(new MailboxAddress(string.IsNullOrWhiteSpace(c.FromName) ? c.From : c.FromName, c.From));
        foreach (var to in c.To) msg.To.Add(MailboxAddress.Parse(to));
        msg.Subject = subject;
        msg.Body = new TextPart("plain") { Text = text };

        using var client = new SmtpClient { Timeout = 30_000 };
        var security = c.Security switch
        {
            "ssl" => SecureSocketOptions.SslOnConnect,
            "starttls" => SecureSocketOptions.StartTls,
            _ => SecureSocketOptions.None,
        };
        await client.ConnectAsync(c.Host, c.Port, security, ct);
        if (c.Authenticate)
        {
            var password = channels.RevealPassword(c) ?? throw new InvalidOperationException("no SMTP password stored");
            await client.AuthenticateAsync(c.Username, password, ct);
        }
        await client.SendAsync(msg, ct);
        await client.DisconnectAsync(true, ct);
    }
}
