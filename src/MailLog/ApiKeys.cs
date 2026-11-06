using System.Collections.Concurrent;
using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace MailLog;

public sealed record ApiKeyCreateDto(string Name, string[]? Domains, int? ExpiresInDays = null);
public sealed record ApiKeyUpdateDto(string? Name, string[]? Domains);

/// <summary>
/// Service keys for integrations (<c>mlk_...</c>). A key is not tied to a user and may only ask for the status of messages
/// whose envelope sender is in one of its domains; it cannot reach any other endpoint.
/// </summary>
public sealed class ApiKeyStore(Db db)
{
    public const string Prefix = "mlk_";

    public (string key, Dictionary<string, object?> item) Create(string name, string[] domains, int? expiresInDays, string createdBy)
    {
        var key = Store.NewToken(Prefix);
        var id = Guid.NewGuid().ToString("N");
        var now = Store.Now();
        db.Exec("""
            INSERT INTO api_keys(id, name, key_hash, prefix, domains, created_by, created_at, expires_at)
            VALUES(@id, @name, @h, @prefix, @domains, @by, @now, @exp)
            """, new
        {
            id, name, h = Store.Sha256(key), prefix = key[..8], domains, by = createdBy, now,
            exp = expiresInDays is > 0 ? now + expiresInDays.Value * 86_400_000L : (object?)null,
        });
        return (key, ById(id)!);
    }

    private const string Cols = "id, name, prefix, domains, created_at, expires_at, last_used, last_ip, use_count, created_by";

    public Dictionary<string, object?>? ById(string id) =>
        db.Rows($"SELECT {Cols} FROM api_keys WHERE id=@id AND NOT revoked", new { id }).FirstOrDefault();

    public List<Dictionary<string, object?>> List() =>
        db.Rows($"SELECT {Cols} FROM api_keys WHERE NOT revoked ORDER BY created_at DESC");

    public bool Update(string id, string? name, string[]? domains) =>
        db.Exec("UPDATE api_keys SET name=COALESCE(@name, name), domains=COALESCE(@domains, domains) WHERE id=@id AND NOT revoked",
            new { id, name = (object?)name, domains = (object?)domains }) == 1;

    public bool Revoke(string id) => db.Exec("UPDATE api_keys SET revoked=TRUE WHERE id=@id AND NOT revoked", new { id }) == 1;

    /// <summary>Validates the key and records the use in one statement.</summary>
    public (string id, string name, string[] domains)? Authenticate(string key, string? ip)
    {
        var rows = db.Rows("""
            UPDATE api_keys SET last_used=@now, last_ip=@ip, use_count=use_count+1
            WHERE key_hash=@h AND NOT revoked AND (expires_at IS NULL OR expires_at > @now)
            RETURNING id, name, domains
            """, new { h = Store.Sha256(key), now = Store.Now(), ip = (object?)ip });
        return rows.Count == 1 ? ((string)rows[0]["id"]!, (string)rows[0]["name"]!, (string[])rows[0]["domains"]!) : null;
    }
}

/// <summary>Authenticates <c>Authorization: Bearer mlk_...</c> or <c>X-Api-Key: mlk_...</c>.</summary>
public sealed class ApiKeyAuthHandler(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger,
    UrlEncoder encoder, ApiKeyStore keys) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "ApiKey";

    /// <summary>The key presented by the request, or null when it carries none.</summary>
    public static string? Presented(HttpRequest r)
    {
        var auth = r.Headers.Authorization.ToString();
        if (auth.StartsWith("Bearer " + ApiKeyStore.Prefix, StringComparison.Ordinal)) return auth["Bearer ".Length..].Trim();
        var header = r.Headers["X-Api-Key"].ToString().Trim();
        return header.StartsWith(ApiKeyStore.Prefix, StringComparison.Ordinal) ? header : null;
    }

    public static string? ClientIp(HttpContext c)
    {
        var fwd = c.Request.Headers["X-Forwarded-For"].ToString().Split(',')[0].Trim();
        return fwd.Length is > 0 and <= 64 ? fwd : c.Connection.RemoteIpAddress?.ToString();
    }

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var key = Presented(Request);
        if (key is null) return Task.FromResult(AuthenticateResult.NoResult());
        var found = keys.Authenticate(key, ClientIp(Context));
        if (found is null) return Task.FromResult(AuthenticateResult.Fail("Invalid, expired or revoked API key"));
        var claims = new[]
        {
            new Claim(ClaimTypes.NameIdentifier, found.Value.id),
            new Claim(ClaimTypes.Name, found.Value.name),
            new Claim(ClaimTypes.Role, Roles.ApiKey),
            new Claim("domains", string.Join(',', found.Value.domains)),
        };
        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, SchemeName, ClaimTypes.Name, ClaimTypes.Role));
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(principal, SchemeName)));
    }
}

/// <summary>Fixed-window request limit per key, so a looping client cannot hammer the database.</summary>
public sealed class KeyRateLimiter
{
    public const int PerMinute = 600;
    private readonly ConcurrentDictionary<string, (long window, int count)> _state = new();

    /// <returns>true when the request may proceed.</returns>
    public bool Allow(string keyId)
    {
        var window = Store.Now() / 60_000;
        var s = _state.AddOrUpdate(keyId, _ => (window, 1), (_, cur) => cur.window == window ? (window, cur.count + 1) : (window, 1));
        if (_state.Count > 10_000) _state.Clear();
        return s.count <= PerMinute;
    }
}

/// <summary>Administration of API keys (admin only).</summary>
public static class ApiKeyApi
{
    private static IResult Bad(string message) => Results.BadRequest(new { error = message });

    private static string? Validate(string? name, string[]? domains, bool requireDomains, int? expiresInDays)
    {
        if (name is not null && (string.IsNullOrWhiteSpace(name) || name.Length > 100)) return "Name is required (max 100 characters)";
        if (requireDomains && (domains is null || UserStore.NormalizeDomains(domains).Length == 0)) return "An API key needs at least one sender domain";
        if (domains is not null && UserStore.NormalizeDomains(domains).Any(d => !d.Contains('.') || d.Length > 253 || d.Any(ch => !(char.IsAsciiLetterOrDigit(ch) || ch is '.' or '-'))))
            return "Invalid sender domain";
        if (expiresInDays is < 1 or > 3650) return "expiresInDays must be between 1 and 3650";
        return null;
    }

    public static void Map(WebApplication app)
    {
        var keys = app.MapGroup("/api/v1/apikeys").RequireAuthorization("admin").WithTags("API keys");

        keys.MapGet("", (ApiKeyStore store) => Results.Ok(store.List()))
            .WithSummary("List API keys (never returns the secret)");

        keys.MapPost("", (ApiKeyCreateDto dto, HttpContext c, ApiKeyStore store) =>
        {
            if (dto.Name is null) return Bad("Name is required (max 100 characters)");
            if (Validate(dto.Name, dto.Domains, true, dto.ExpiresInDays) is { } err) return Bad(err);
            var (key, item) = store.Create(dto.Name.Trim(), UserStore.NormalizeDomains(dto.Domains), dto.ExpiresInDays, Me.From(c.User)!.Username);
            return Results.Created($"/api/v1/apikeys/{item["id"]}", new { key, item });
        }).WithSummary("Create an API key limited to sender domains (the key is returned only once)");

        keys.MapPut("/{id}", (string id, ApiKeyUpdateDto dto, ApiKeyStore store) =>
        {
            if (Validate(dto.Name, dto.Domains, false, null) is { } err) return Bad(err);
            if (dto.Domains is not null && UserStore.NormalizeDomains(dto.Domains).Length == 0) return Bad("An API key needs at least one sender domain");
            if (!store.Update(id, dto.Name?.Trim(), dto.Domains is null ? null : UserStore.NormalizeDomains(dto.Domains))) return Results.NotFound();
            return Results.Ok(store.ById(id));
        }).WithSummary("Rename an API key or change its sender domains");

        keys.MapDelete("/{id}", (string id, ApiKeyStore store) => store.Revoke(id) ? Results.NoContent() : Results.NotFound())
            .WithSummary("Revoke an API key");
    }
}
