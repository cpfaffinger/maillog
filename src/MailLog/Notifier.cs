using System.Net;
using System.Net.Mail;
using System.Text;
using System.Text.Json;

namespace MailLog;

/// <summary>Delivers alert notifications to the configured channels (webhook, signal-cli-rest-api, SMTP).</summary>
public sealed class Notifier(Settings s, IHttpClientFactory http, ILogger<Notifier> log)
{
    public bool SignalConfigured => s.SignalUrl is not null && s.SignalNumber is not null && s.SignalRecipients.Length > 0;
    public bool SmtpConfigured => s.SmtpHost is not null && s.SmtpFrom is not null && s.SmtpTo.Length > 0;
    public bool WebhookConfigured => s.WebhookUrl is not null;

    /// <param name="state">open | resolved | info</param>
    public async Task<List<string>> SendAsync(string title, string body, string severity, string state, CancellationToken ct = default)
    {
        var errors = new List<string>();
        var prefix = state switch { "resolved" => "[RESOLVED] ", "info" => "[INFO] ", _ => $"[{severity.ToUpperInvariant()}] " };
        var subject = prefix + title;
        var text = subject + (string.IsNullOrWhiteSpace(body) ? "" : "\n" + body);
        if (s.PublicUrl is not null) text += "\n" + s.PublicUrl;

        if (WebhookConfigured) await Try("webhook", () => Webhook(subject, body, severity, state, text, ct), errors);
        if (SignalConfigured) await Try("signal", () => Signal(text, ct), errors);
        if (SmtpConfigured) await Try("smtp", () => Smtp(subject, text, ct), errors);
        if (!WebhookConfigured && !SignalConfigured && !SmtpConfigured)
            log.LogInformation("No alert channel configured: {Text}", text);
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

    private async Task Webhook(string subject, string body, string severity, string state, string text, CancellationToken ct)
    {
        var client = http.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(15);
        HttpResponseMessage res;
        switch (s.WebhookFormat)
        {
            case "slack":
                res = await client.PostAsJsonAsync(s.WebhookUrl!, new { text }, ct); break;
            case "discord":
                res = await client.PostAsJsonAsync(s.WebhookUrl!, new { content = text.Length > 1900 ? text[..1900] : text }, ct); break;
            case "ntfy":
                using (var req = new HttpRequestMessage(HttpMethod.Post, s.WebhookUrl!) { Content = new StringContent(body.Length == 0 ? subject : body, Encoding.UTF8) })
                {
                    req.Headers.TryAddWithoutValidation("Title", subject);
                    req.Headers.TryAddWithoutValidation("Priority", severity == "critical" ? "urgent" : severity == "warning" ? "high" : "default");
                    res = await client.SendAsync(req, ct);
                }
                break;
            default:
                res = await client.PostAsJsonAsync(s.WebhookUrl!, new { title = subject, body, severity, state, text, time = DateTimeOffset.UtcNow }, ct); break;
        }
        res.EnsureSuccessStatusCode();
    }

    private async Task Signal(string text, CancellationToken ct)
    {
        var client = http.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(30);
        var res = await client.PostAsJsonAsync($"{s.SignalUrl}/v2/send", new { message = text, number = s.SignalNumber, recipients = s.SignalRecipients }, ct);
        res.EnsureSuccessStatusCode();
    }

    private async Task Smtp(string subject, string text, CancellationToken ct)
    {
        using var client = new SmtpClient(s.SmtpHost!, s.SmtpPort) { EnableSsl = s.SmtpStartTls, Timeout = 30_000 };
        if (s.SmtpUser is not null) client.Credentials = new NetworkCredential(s.SmtpUser, s.SmtpPassword);
        using var msg = new MailMessage { From = new MailAddress(s.SmtpFrom!), Subject = subject, Body = text, BodyEncoding = Encoding.UTF8, SubjectEncoding = Encoding.UTF8 };
        foreach (var to in s.SmtpTo) msg.To.Add(to);
        await client.SendMailAsync(msg, ct);
    }
}
