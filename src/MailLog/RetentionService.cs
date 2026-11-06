namespace MailLog;

/// <summary>Deletes mail events (and housekeeping data) older than the configured retention. Default 180 days, editable in the UI.</summary>
public sealed class RetentionService(Db db, ILogger<RetentionService> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        await Task.Delay(TimeSpan.FromMinutes(1), ct);
        while (!ct.IsCancellationRequested)
        {
            try { await RunOnce(ct); }
            catch (OperationCanceledException) { break; }
            catch (Exception e) { log.LogError(e, "Retention run failed"); }
            await Task.Delay(TimeSpan.FromHours(1), ct);
        }
    }

    public static int RetentionDays(Db db) =>
        int.TryParse(db.GetSetting("retention_days"), out var d) && d > 0 ? d : 180;

    public async Task RunOnce(CancellationToken ct)
    {
        var days = RetentionDays(db);
        var cutoff = DateTimeOffset.UtcNow.AddDays(-days).ToUnixTimeMilliseconds();
        long total = 0;
        int n;
        do
        {
            // batches keep transactions and locks short even for large backlogs
            n = db.Exec("DELETE FROM events WHERE id IN (SELECT id FROM events WHERE ts < @cutoff LIMIT 20000)", new { cutoff });
            total += n;
            if (n > 0) await Task.Delay(200, ct);
        } while (n > 0 && !ct.IsCancellationRequested);

        db.Exec("DELETE FROM health_history WHERE ts < @cutoff", new { cutoff });
        db.Exec("DELETE FROM actions WHERE ts < @cutoff", new { cutoff });
        db.Exec("DELETE FROM alerts WHERE resolved_at IS NOT NULL AND resolved_at < @cutoff", new { cutoff });
        db.Exec("DELETE FROM metrics WHERE ts < @cutoff", new { cutoff = Math.Max(cutoff, DateTimeOffset.UtcNow.AddDays(-30).ToUnixTimeMilliseconds()) });
        if (total > 0) log.LogInformation("Retention: deleted {Count} events older than {Days} days", total, days);
    }
}
