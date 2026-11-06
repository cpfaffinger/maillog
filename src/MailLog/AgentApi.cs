using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace MailLog;

/// <summary>The agent-facing protocol (see docs/AGENT-PROTOCOL.md) plus the public installer endpoints.</summary>
public static class AgentApi
{
    private static readonly string AgentDir = Path.Combine(AppContext.BaseDirectory, "agent");
    private static string AgentFile => Path.Combine(AgentDir, "maillog-agent.py");
    private static string InstallTemplate => Path.Combine(AgentDir, "install.sh.tpl");

    public static string AgentSha256()
    {
        try { return Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(AgentFile))).ToLowerInvariant(); }
        catch (IOException) { return ""; }
    }

    private static AgentInfo? Auth(HttpContext c, Store store)
    {
        var h = c.Request.Headers.Authorization.ToString();
        return h.StartsWith("Bearer mla_", StringComparison.Ordinal) ? store.Authenticate(h["Bearer ".Length..].Trim()) : null;
    }

    private static string? ClientIp(HttpContext c) => c.Connection.RemoteIpAddress?.ToString();

    private static object Config(AgentInfo a) => new
    {
        intervalS = a.IntervalS,
        agentSha256 = AgentSha256(),
        logs = JsonNode.Parse(a.LogsJson),
        checks = JsonNode.Parse(a.ChecksJson),
    };

    public static void Map(WebApplication app)
    {
        var agent = app.MapGroup("/agent-api/v1").WithTags("Agent protocol");

        agent.MapPost("/enroll", (EnrollDto dto, HttpContext c, Store store, Settings s) =>
        {
            var result = string.IsNullOrWhiteSpace(dto.Token) ? null : store.Enroll(dto.Token.Trim());
            if (result is null) return Results.BadRequest(new { error = "Enrollment token is invalid or expired" });
            store.Touch(result.Value.agent.Id, ClientIp(c), dto.Hostname, null);
            return Results.Ok(new { agentToken = result.Value.agentToken, name = result.Value.agent.Name, server = DataApi.ServerUrl(c.Request, s) });
        }).WithSummary("Exchange a single-use enrollment token for the agent token");

        agent.MapGet("/config", (HttpContext c, Store store) =>
            Auth(c, store) is { } a ? Results.Ok(Config(a)) : Results.Unauthorized()).WithSummary("Agent configuration");

        agent.MapPost("/ingest", (IngestDto dto, HttpContext c, Store store) =>
        {
            if (Auth(c, store) is not { } a) return Results.Unauthorized();
            var accepted = store.InsertEvents(a.Id, dto.TzOffsetMinutes, dto.Batches ?? []);
            store.Touch(a.Id, ClientIp(c), dto.Hostname, dto.Version);
            return Results.Ok(new { accepted });
        }).WithSummary("Ship log lines (idempotent)");

        agent.MapPost("/health", (HealthReportDto dto, HttpContext c, Store store) =>
        {
            if (Auth(c, store) is not { } a) return Results.Unauthorized();
            store.SaveHealth(a, dto);
            store.Touch(a.Id, ClientIp(c), dto.Hostname, dto.Version);
            return Results.Ok(Config(a));
        }).WithSummary("Heartbeat with health checks, queue metrics and recovery actions");

        // public: the installer and the agent script
        app.MapGet("/install.sh", (HttpContext c, Settings s) =>
        {
            if (!File.Exists(InstallTemplate)) return Results.NotFound();
            var script = File.ReadAllText(InstallTemplate).Replace("{{SERVER}}", DataApi.ServerUrl(c.Request, s));
            return Results.Text(script, "text/x-shellscript; charset=utf-8");
        }).ExcludeFromDescription();

        app.MapGet("/agent/maillog-agent.py", () =>
            File.Exists(AgentFile) ? Results.File(AgentFile, "text/x-python; charset=utf-8") : Results.NotFound()).ExcludeFromDescription();
    }
}
