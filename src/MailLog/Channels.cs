using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.DataProtection;

namespace MailLog;

public sealed class SmtpConfig
{
    public bool Enabled { get; set; }
    public string Host { get; set; } = "";
    public int Port { get; set; } = 587;
    /// <summary>none | starttls | ssl</summary>
    public string Security { get; set; } = "starttls";
    public bool Authenticate { get; set; }
    public string Username { get; set; } = "";
    /// <summary>Encrypted with ASP.NET data protection (key ring in the database); never returned by the API.</summary>
    public string? PasswordProtected { get; set; }
    public string From { get; set; } = "";
    public string FromName { get; set; } = "maillog";
    public string[] To { get; set; } = [];
}

public sealed class SignalConfig
{
    public bool Enabled { get; set; }
    public string Url { get; set; } = "";
    public string Number { get; set; } = "";
    public string[] Recipients { get; set; } = [];
}

public sealed class WebhookConfig
{
    public bool Enabled { get; set; }
    public string Url { get; set; } = "";
    /// <summary>json | slack | discord | ntfy</summary>
    public string Format { get; set; } = "json";
}

public sealed class ChannelSet
{
    public SmtpConfig Smtp { get; set; } = new();
    public SignalConfig Signal { get; set; } = new();
    public WebhookConfig Webhook { get; set; } = new();
}

public sealed record SmtpInput(bool? Enabled, string? Host, int? Port, string? Security, bool? Authenticate, string? Username,
    string? Password, bool? ClearPassword, string? From, string? FromName, string[]? To);
public sealed record SignalInput(bool? Enabled, string? Url, string? Number, string[]? Recipients);
public sealed record WebhookInput(bool? Enabled, string? Url, string? Format);
public sealed record ChannelsInput(SmtpInput? Smtp, SignalInput? Signal, WebhookInput? Webhook);

/// <summary>Alert channel configuration, stored in the database (settings table, key "alert_channels").</summary>
public sealed partial class ChannelStore
{
    private const string Key = "alert_channels";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public static readonly string[] SmtpSecurities = ["none", "starttls", "ssl"];
    public static readonly string[] WebhookFormats = ["json", "slack", "discord", "ntfy"];

    [GeneratedRegex(@"^[^@\s]+@[^@\s]+\.[^@\s]+$")]
    private static partial Regex EmailPattern();

    private readonly Db _db;
    private readonly IDataProtector _protector;

    public ChannelStore(Db db, IDataProtectionProvider dp)
    {
        _db = db;
        _protector = dp.CreateProtector("maillog.alert-channels.smtp-password");
    }

    public ChannelSet Get()
    {
        var raw = _db.GetSetting(Key);
        if (string.IsNullOrWhiteSpace(raw)) return new ChannelSet();
        try { return JsonSerializer.Deserialize<ChannelSet>(raw, Json) ?? new ChannelSet(); }
        catch (JsonException) { return new ChannelSet(); }
    }

    public void Save(ChannelSet set) => _db.SetSetting(Key, JsonSerializer.Serialize(set, Json));

    public string? RevealPassword(SmtpConfig c)
    {
        if (string.IsNullOrEmpty(c.PasswordProtected)) return null;
        try { return _protector.Unprotect(c.PasswordProtected); }
        catch (System.Security.Cryptography.CryptographicException) { return null; }
    }

    /// <summary>Applies the non-null fields of the input onto a copy of the stored/current configuration.</summary>
    public ChannelSet Merge(ChannelSet current, ChannelsInput input)
    {
        var copy = JsonSerializer.Deserialize<ChannelSet>(JsonSerializer.Serialize(current, Json), Json)!;
        if (input.Smtp is { } s)
        {
            var c = copy.Smtp;
            c.Enabled = s.Enabled ?? c.Enabled;
            c.Host = s.Host?.Trim() ?? c.Host;
            c.Port = s.Port ?? c.Port;
            c.Security = s.Security?.Trim().ToLowerInvariant() ?? c.Security;
            c.Authenticate = s.Authenticate ?? c.Authenticate;
            c.Username = s.Username?.Trim() ?? c.Username;
            c.From = s.From?.Trim() ?? c.From;
            c.FromName = s.FromName?.Trim() ?? c.FromName;
            if (s.To is not null) c.To = s.To.Select(x => x.Trim()).Where(x => x.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            if (s.ClearPassword == true) c.PasswordProtected = null;
            if (!string.IsNullOrEmpty(s.Password)) c.PasswordProtected = _protector.Protect(s.Password);
            if (!c.Authenticate) { /* credentials are kept but unused while authentication is off */ }
        }
        if (input.Signal is { } g)
        {
            var c = copy.Signal;
            c.Enabled = g.Enabled ?? c.Enabled;
            c.Url = g.Url?.Trim().TrimEnd('/') ?? c.Url;
            c.Number = g.Number?.Trim() ?? c.Number;
            if (g.Recipients is not null) c.Recipients = g.Recipients.Select(x => x.Trim()).Where(x => x.Length > 0).Distinct().ToArray();
        }
        if (input.Webhook is { } w)
        {
            var c = copy.Webhook;
            c.Enabled = w.Enabled ?? c.Enabled;
            c.Url = w.Url?.Trim() ?? c.Url;
            c.Format = w.Format?.Trim().ToLowerInvariant() ?? c.Format;
        }
        return copy;
    }

    public string? Validate(ChannelSet set)
    {
        var s = set.Smtp;
        if (s.Port is < 1 or > 65535) return "SMTP: port must be between 1 and 65535";
        if (!SmtpSecurities.Contains(s.Security)) return "SMTP: security must be none, starttls or ssl";
        if (s.From.Length > 0 && !EmailPattern().IsMatch(s.From)) return "SMTP: the sender address is not a valid e-mail address";
        if (s.To.Any(x => !EmailPattern().IsMatch(x))) return "SMTP: a recipient is not a valid e-mail address";
        if (s.Enabled)
        {
            if (s.Host.Length == 0) return "SMTP: server is required";
            if (s.From.Length == 0) return "SMTP: sender address is required";
            if (s.To.Length == 0) return "SMTP: at least one recipient is required";
            if (s.Authenticate && (s.Username.Length == 0 || string.IsNullOrEmpty(s.PasswordProtected)))
                return "SMTP: username and password are required when authentication is on";
        }
        var g = set.Signal;
        if (g.Url.Length > 0 && !IsHttp(g.Url)) return "Signal: the URL must start with http:// or https://";
        if (g.Enabled && (g.Url.Length == 0 || g.Number.Length == 0 || g.Recipients.Length == 0))
            return "Signal: URL, sender number and at least one recipient are required";
        var w = set.Webhook;
        if (!WebhookFormats.Contains(w.Format)) return "Webhook: format must be json, slack, discord or ntfy";
        if (w.Url.Length > 0 && !IsHttp(w.Url)) return "Webhook: the URL must start with http:// or https://";
        if (w.Enabled && w.Url.Length == 0) return "Webhook: URL is required";
        return null;
    }

    private static bool IsHttp(string url) => Uri.TryCreate(url, UriKind.Absolute, out var u) && (u.Scheme is "http" or "https");

    public static object View(ChannelSet set) => new
    {
        smtp = new
        {
            enabled = set.Smtp.Enabled, host = set.Smtp.Host, port = set.Smtp.Port, security = set.Smtp.Security,
            authenticate = set.Smtp.Authenticate, username = set.Smtp.Username,
            passwordSet = !string.IsNullOrEmpty(set.Smtp.PasswordProtected),
            from = set.Smtp.From, fromName = set.Smtp.FromName, to = set.Smtp.To,
        },
        signal = new { enabled = set.Signal.Enabled, url = set.Signal.Url, number = set.Signal.Number, recipients = set.Signal.Recipients },
        webhook = new { enabled = set.Webhook.Enabled, url = set.Webhook.Url, format = set.Webhook.Format },
    };
}
