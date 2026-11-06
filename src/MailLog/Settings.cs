namespace MailLog;

/// <summary>
/// Deployment settings from MAILLOG_* environment variables. Secrets and everything an admin edits at runtime
/// (users, alert channels, retention) live in the database, not here.
/// </summary>
public sealed class Settings
{
    public string DbConnection { get; init; } = "";
    public string DataDir { get; init; } = "/data";
    public string? PublicUrl { get; init; }

    /// <summary>Initial retention for mail events. Can be changed at runtime in the UI (stored in the database).</summary>
    public int RetentionDays { get; init; } = 180;

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
        static string? Nz(string? v) => string.IsNullOrWhiteSpace(v) ? null : v.Trim();

        return new Settings
        {
            DbConnection = c["DB_CONNECTION"] ?? "",
            DataDir = Nz(c["DATA_DIR"]) ?? "/data",
            PublicUrl = Nz(c["PUBLIC_URL"])?.TrimEnd('/'),
            RetentionDays = Math.Max(1, Int(c["RETENTION_DAYS"], 180)),
            OfflineAfterS = Int(c["OFFLINE_AFTER_S"], 180),
            SentThreshold = Int(c["SENT_THRESHOLD"], 5000),
            RenotifyS = Int(c["RENOTIFY_S"], 21600),
            EnrollTtlHours = Int(c["ENROLL_TTL_HOURS"], 24),
            AllowedForeignDomains = List(c["ALLOWED_FOREIGN_DOMAINS"]).Select(x => x.ToLowerInvariant()).ToArray(),
        };
    }
}
