using System.Collections.Concurrent;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.Extensions.Options;

namespace MailLog;

public static class Roles
{
    public const string Admin = "admin";
    public const string Operator = "operator";
    public const string Viewer = "viewer";
    public static readonly string[] All = [Admin, Operator, Viewer];
}

/// <summary>The authenticated caller. Viewers are scoped to the sender domains in <see cref="Domains"/>.</summary>
public sealed record Me(string Id, string Username, string Role, string[] Domains, bool ReadOnlyToken = false)
{
    public bool Scoped => Role == Roles.Viewer;
    public bool IsAdmin => Role == Roles.Admin;
    public bool CanSeeInfrastructure => Role is Roles.Admin or Roles.Operator;

    public static Me? From(ClaimsPrincipal p)
    {
        var id = p.FindFirstValue(ClaimTypes.NameIdentifier);
        var role = p.FindFirstValue(ClaimTypes.Role);
        if (id is null || role is null) return null;
        var domains = (p.FindFirstValue("domains") ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries);
        return new Me(id, p.Identity?.Name ?? "", role, domains, p.FindFirstValue("readonly") == "1");
    }
}

public static class Passwords
{
    private const int Iterations = 210_000;

    public static string Hash(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        var key = Rfc2898DeriveBytes.Pbkdf2(password, salt, Iterations, HashAlgorithmName.SHA256, 32);
        return $"pbkdf2-sha256${Iterations}${Convert.ToBase64String(salt)}${Convert.ToBase64String(key)}";
    }

    public static bool Verify(string password, string stored)
    {
        var parts = stored.Split('$');
        if (parts.Length != 4 || parts[0] != "pbkdf2-sha256" || !int.TryParse(parts[1], out var iter)) return false;
        try
        {
            var salt = Convert.FromBase64String(parts[2]);
            var expected = Convert.FromBase64String(parts[3]);
            var actual = Rfc2898DeriveBytes.Pbkdf2(password, salt, iter, HashAlgorithmName.SHA256, expected.Length);
            return CryptographicOperations.FixedTimeEquals(actual, expected);
        }
        catch (FormatException) { return false; }
    }
}

public sealed record UserRow(string Id, string Username, string DisplayName, string PasswordHash, string Role,
    string[] Domains, bool Disabled, bool MustChangePassword, long CreatedAt, long? LastLogin);

/// <summary>Users, personal access tokens.</summary>
public sealed class UserStore(Db db, Settings settings, ILogger<UserStore> log)
{
    private const string Cols = "id, username, display_name, password_hash, role, domains, disabled, must_change_password, created_at, last_login";

    private static UserRow Map(Dictionary<string, object?> r) => new(
        (string)r["id"]!, (string)r["username"]!, (string)r["displayName"]!, (string)r["passwordHash"]!, (string)r["role"]!,
        (string[])r["domains"]!, (bool)r["disabled"]!, (bool)r["mustChangePassword"]!, (long)r["createdAt"]!,
        r["lastLogin"] as long?);

    public UserRow? ById(string id) =>
        db.Rows($"SELECT {Cols} FROM users WHERE id=@id", new { id }).Select(Map).FirstOrDefault();

    public UserRow? ByUsername(string username) =>
        db.Rows($"SELECT {Cols} FROM users WHERE username=@u", new { u = username.Trim().ToLowerInvariant() }).Select(Map).FirstOrDefault();

    public List<Dictionary<string, object?>> List() => db.Rows("""
        SELECT u.id, u.username, u.display_name, u.role, u.domains, u.disabled, u.must_change_password, u.created_at, u.last_login,
               (SELECT count(*) FROM passkeys p WHERE p.user_id = u.id) AS passkey_count
        FROM users u ORDER BY u.username
        """);

    public UserRow Create(string username, string displayName, string password, string role, string[] domains, bool mustChange = false)
    {
        var id = Guid.NewGuid().ToString("N");
        db.Exec("""
            INSERT INTO users(id, username, display_name, password_hash, role, domains, must_change_password, created_at)
            VALUES(@id, @u, @dn, @ph, @role, @domains, @mc, @now)
            """, new
        {
            id, u = username.Trim().ToLowerInvariant(), dn = displayName, ph = Passwords.Hash(password), role,
            domains = NormalizeDomains(domains), mc = mustChange, now = Store.Now(),
        });
        return ById(id)!;
    }

    public static string[] NormalizeDomains(IEnumerable<string>? domains) =>
        (domains ?? []).Select(d => d.Trim().TrimStart('@').ToLowerInvariant()).Where(d => d.Length > 0).Distinct().ToArray();

    /// <summary>Host-visible (bind mounted) file with the generated administrator password.</summary>
    public string CredentialFile => Path.Combine(settings.DataDir, "initial-admin-password.txt");

    private static string GeneratePassword() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(18)).Replace('+', 'x').Replace('/', 'y').TrimEnd('=');

    /// <summary>First start: create the "admin" user with a random password (log once + file in the data folder).</summary>
    public void EnsureDefaultAdmin()
    {
        if (db.Scalar<long>("SELECT count(*) FROM users") > 0) return;
        var password = GeneratePassword();
        Create("admin", "Administrator", password, Roles.Admin, [], mustChange: true);
        Announce(password, "Created");
    }

    /// <summary>Recovery: set a new random password for "admin" (creates the user when it is missing). Used by the reset-admin-password command.</summary>
    public void ResetAdminPassword()
    {
        var password = GeneratePassword();
        if (ByUsername("admin") is { } admin)
            db.Exec("UPDATE users SET password_hash=@h, must_change_password=TRUE, disabled=FALSE, role='admin' WHERE id=@id",
                new { h = Passwords.Hash(password), id = admin.Id });
        else
            Create("admin", "Administrator", password, Roles.Admin, [], mustChange: true);
        Announce(password, "Reset");
    }

    private void Announce(string password, string what)
    {
        log.LogWarning("{What} user 'admin'. One-time password: {Password}  (also written to {File}; change it after the first login)",
            what, password, CredentialFile);
        try
        {
            Directory.CreateDirectory(settings.DataDir);
            var path = CredentialFile;
            var nl = Environment.NewLine;
            File.WriteAllText(path,
                $"maillog administrator credentials ({what.ToLowerInvariant()} {DateTime.UtcNow:u}){nl}{nl}" +
                $"username: admin{nl}password: {password}{nl}{nl}" +
                $"Change the password after the first login (Account -> Password). This file is deleted automatically then.{nl}");
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        catch (Exception e)
        {
            log.LogWarning("Could not write {File}: {Message}. The password above is only shown here.", CredentialFile, e.Message);
        }
    }

    /// <summary>Called after a user changed the own password: the generated credentials file is obsolete then.</summary>
    public void PasswordChanged(UserRow user)
    {
        if (user.Username != "admin") return;
        try { if (File.Exists(CredentialFile)) File.Delete(CredentialFile); }
        catch (Exception e) { log.LogWarning("Could not delete {File}: {Message}", CredentialFile, e.Message); }
    }

    public int AdminCount() => (int)db.Scalar<long>("SELECT count(*) FROM users WHERE role='admin' AND NOT disabled");

    public void TouchLogin(string id) => db.Exec("UPDATE users SET last_login=@now WHERE id=@id", new { id, now = Store.Now() });

    public static ClaimsPrincipal Principal(UserRow u, string scheme, bool readOnlyToken = false)
    {
        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, u.Id),
            new(ClaimTypes.Name, u.Username),
            new(ClaimTypes.Role, u.Role),
            new("domains", string.Join(',', u.Domains)),
        };
        if (readOnlyToken) claims.Add(new Claim("readonly", "1"));
        return new ClaimsPrincipal(new ClaimsIdentity(claims, scheme, ClaimTypes.Name, ClaimTypes.Role));
    }

    // ---- personal access tokens ----------------------------------------------------------------------------

    public (string token, Dictionary<string, object?> item) CreateToken(string userId, string name, bool readOnly, int? expiresInDays)
    {
        var token = Store.NewToken("mlp_");
        var id = Guid.NewGuid().ToString("N");
        var now = Store.Now();
        db.Exec("""
            INSERT INTO api_tokens(id, user_id, name, token_hash, prefix, read_only, created_at, expires_at)
            VALUES(@id, @uid, @name, @h, @prefix, @ro, @now, @exp)
            """, new
        {
            id, uid = userId, name, h = Store.Sha256(token), prefix = token[..8], ro = readOnly, now,
            exp = expiresInDays is > 0 ? now + expiresInDays.Value * 86_400_000L : (object?)null,
        });
        return (token, db.Rows("SELECT id, name, prefix, read_only, created_at, expires_at, last_used FROM api_tokens WHERE id=@id", new { id })[0]);
    }

    public List<Dictionary<string, object?>> Tokens(string userId) => db.Rows("""
        SELECT id, name, prefix, read_only, created_at, expires_at, last_used FROM api_tokens
        WHERE user_id=@uid AND NOT revoked ORDER BY created_at DESC
        """, new { uid = userId });

    public bool RevokeToken(string userId, string id) =>
        db.Exec("UPDATE api_tokens SET revoked=TRUE WHERE id=@id AND user_id=@uid AND NOT revoked", new { id, uid = userId }) == 1;

    public (UserRow user, bool readOnly)? ByToken(string token)
    {
        var rows = db.Rows("""
            SELECT t.id AS token_id, t.read_only, t.last_used, t.expires_at, t.revoked, u.id AS user_id
            FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash=@h
            """, new { h = Store.Sha256(token) });
        if (rows.Count != 1) return null;
        var r = rows[0];
        if ((bool)r["revoked"]!) return null;
        if (r["expiresAt"] is long exp && exp < Store.Now()) return null;
        var user = ById((string)r["userId"]!);
        if (user is null || user.Disabled) return null;
        if (r["lastUsed"] is not long lu || Store.Now() - lu > 60_000)
            db.Exec("UPDATE api_tokens SET last_used=@now WHERE id=@id", new { now = Store.Now(), id = (string)r["tokenId"]! });
        return (user, (bool)r["readOnly"]!);
    }
}

/// <summary>Authenticates <c>Authorization: Bearer mlp_...</c> personal access tokens.</summary>
public sealed class PatAuthHandler(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger,
    UrlEncoder encoder, UserStore users) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "Pat";

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var header = Request.Headers.Authorization.ToString();
        if (!header.StartsWith("Bearer mlp_", StringComparison.Ordinal)) return Task.FromResult(AuthenticateResult.NoResult());
        var found = users.ByToken(header["Bearer ".Length..].Trim());
        if (found is null) return Task.FromResult(AuthenticateResult.Fail("Invalid or expired token"));
        var principal = UserStore.Principal(found.Value.user, SchemeName, found.Value.readOnly);
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(principal, SchemeName)));
    }
}

/// <summary>Re-reads the user on every cookie request so disabling or changing a role takes effect immediately.</summary>
public static class CookieRevalidation
{
    public static async Task Validate(CookieValidatePrincipalContext ctx)
    {
        var id = ctx.Principal?.FindFirstValue(ClaimTypes.NameIdentifier);
        var users = ctx.HttpContext.RequestServices.GetRequiredService<UserStore>();
        var user = id is null ? null : users.ById(id);
        if (user is null || user.Disabled)
        {
            ctx.RejectPrincipal();
            await ctx.HttpContext.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
            return;
        }
        ctx.ReplacePrincipal(UserStore.Principal(user, CookieAuthenticationDefaults.AuthenticationScheme));
    }
}

/// <summary>Very small in-memory login throttle (per client address).</summary>
public sealed class LoginThrottle
{
    private readonly ConcurrentDictionary<string, (int count, long until)> _state = new();
    private const int MaxFailures = 8;
    private static readonly long WindowMs = 15 * 60_000;

    public bool Blocked(string key) => _state.TryGetValue(key, out var s) && s.count >= MaxFailures && s.until > Store.Now();

    public void Failure(string key) => _state.AddOrUpdate(key, _ => (1, Store.Now() + WindowMs),
        (_, s) => s.until < Store.Now() ? (1, Store.Now() + WindowMs) : (s.count + 1, Store.Now() + WindowMs));

    public void Success(string key) => _state.TryRemove(key, out _);
}
