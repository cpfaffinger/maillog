namespace MailLog;

/// <summary>All runtime configuration, read from MAILLOG_* environment variables.</summary>
public sealed class Settings
{
    public string DbConnection { get; init; } = "";
    public string AdminPassword { get; init; } = "";
    public string? PublicUrl { get; init; }

    /// <summary>Initial retention for mail events. Can be changed at runtime in the UI (stored in the database).</summary>
    public int RetentionDays { get; init; } = 180;

    public string? WebhookUrl { get; init; }
    public string WebhookFormat { get; init; } = "json";
    public string? SignalUrl { get; init; }
    public string? SignalNumber { get; init; }
    public string[] SignalRecipients { get; init; } = [];

    public string? SmtpHost { get; init; }
    public int SmtpPort { get; init; } = 587;
    public string? SmtpUser { get; init; }
    public string? SmtpPassword { get; init; }
    public bool SmtpStartTls { get; init; } = true;
    public string? SmtpFrom { get; init; }
    public string[] SmtpTo { get; init; } = [];

    public int OfflineAfterS { get; init; } = 180;
    public int SentThreshold { get; init; } = 5000;
    public int RenotifyS { get; init; } = 21600;
    public int EnrollTtlHours { get; init; } = 24;
    public string[] AllowedForeignDomains { get; init; } = [];

    public static Settings From(IConfiguration c)
    {
        static string[] List(string? v) =>
            (v ?? "").Split(new[] { ',', ';', ' ' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        static int Int(string? v, int d) => int.TryParse(v, out var i) ? i : d;
        static bool Bool(string? v, bool d) => bool.TryParse(v, out var b) ? b : d;
        static string? Nz(string? v) => string.IsNullOrWhiteSpace(v) ? null : v.Trim();

        return new Settings
        {
            DbConnection = c["DB_CONNECTION"] ?? "",
            AdminPassword = c["ADMIN_PASSWORD"] ?? "",
            PublicUrl = Nz(c["PUBLIC_URL"])?.TrimEnd('/'),
            RetentionDays = Math.Max(1, Int(c["RETENTION_DAYS"], 180)),
            WebhookUrl = Nz(c["WEBHOOK_URL"]),
            WebhookFormat = (Nz(c["WEBHOOK_FORMAT"]) ?? "json").ToLowerInvariant(),
            SignalUrl = Nz(c["SIGNAL_URL"])?.TrimEnd('/'),
            SignalNumber = Nz(c["SIGNAL_NUMBER"]),
            SignalRecipients = List(c["SIGNAL_RECIPIENTS"]),
            SmtpHost = Nz(c["SMTP_HOST"]),
            SmtpPort = Int(c["SMTP_PORT"], 587),
            SmtpUser = Nz(c["SMTP_USER"]),
            SmtpPassword = Nz(c["SMTP_PASSWORD"]),
            SmtpStartTls = Bool(c["SMTP_STARTTLS"], true),
            SmtpFrom = Nz(c["SMTP_FROM"]),
            SmtpTo = List(c["SMTP_TO"]),
            OfflineAfterS = Int(c["OFFLINE_AFTER_S"], 180),
            SentThreshold = Int(c["SENT_THRESHOLD"], 5000),
            RenotifyS = Int(c["RENOTIFY_S"], 21600),
            EnrollTtlHours = Int(c["ENROLL_TTL_HOURS"], 24),
            AllowedForeignDomains = List(c["ALLOWED_FOREIGN_DOMAINS"]).Select(x => x.ToLowerInvariant()).ToArray(),
        };
    }
}
