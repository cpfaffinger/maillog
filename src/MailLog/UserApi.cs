using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;

namespace MailLog;

public sealed record LoginDto(string Username, string Password);
public sealed record PasskeyLoginDto(string RequestId, JsonElement Credential);
public sealed record PasskeyRegisterDto(string RequestId, string? Name, JsonElement Credential);
public sealed record PasswordDto(string CurrentPassword, string NewPassword);
public sealed record TokenCreateDto(string Name, bool ReadOnly = true, int? ExpiresInDays = null);
public sealed record UserCreateDto(string Username, string? DisplayName, string Role, string[]? Domains, string Password);
public sealed record UserUpdateDto(string? DisplayName, string? Role, string[]? Domains, bool? Disabled, string? Password);

/// <summary>Authentication, account (/me), passkeys, access tokens and user administration.</summary>
public static partial class UserApi
{
    [GeneratedRegex(@"^[a-z0-9][a-z0-9._@-]{1,63}$")]
    private static partial Regex UsernamePattern();

    private static Me Cur(HttpContext c) => Me.From(c.User)!;

    private static IResult Bad(string message) => Results.BadRequest(new { error = message });

    public static object UserDto(UserRow u, long passkeys) => new
    {
        id = u.Id, username = u.Username, displayName = u.DisplayName, role = u.Role, domains = u.Domains,
        disabled = u.Disabled, createdAt = u.CreatedAt, lastLogin = u.LastLogin,
        mustChangePassword = u.MustChangePassword, passkeyCount = passkeys,
    };

    private static async Task SignIn(HttpContext c, UserRow u)
    {
        await c.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme,
            UserStore.Principal(u, CookieAuthenticationDefaults.AuthenticationScheme),
            new AuthenticationProperties { IsPersistent = true, ExpiresUtc = DateTimeOffset.UtcNow.AddDays(7) });
    }

    private static object DtoFor(UserRow u, Db db) =>
        UserDto(u, db.Scalar<long>("SELECT count(*) FROM passkeys WHERE user_id=@u", new { u = u.Id }));

    public static void Map(WebApplication app)
    {
        var api = app.MapGroup("/api/v1");
        var auth = api.MapGroup("/auth").WithTags("Auth");
        var secured = api.MapGroup("").RequireAuthorization();
        var me = secured.MapGroup("/me").WithTags("Account");
        var users = secured.MapGroup("/users").WithTags("Users").RequireAuthorization("admin");

        // ---- login / logout ---------------------------------------------------------------------------------

        auth.MapPost("/login", async (LoginDto dto, HttpContext c, UserStore store, LoginThrottle throttle) =>
        {
            var key = (c.Connection.RemoteIpAddress?.ToString() ?? "?") + "|" + dto.Username.Trim().ToLowerInvariant();
            if (throttle.Blocked(key)) return Results.StatusCode(StatusCodes.Status429TooManyRequests);
            var user = store.ByUsername(dto.Username);
            // verify against a dummy hash for unknown users so timing does not reveal valid usernames
            var ok = user is not null ? Passwords.Verify(dto.Password, user.PasswordHash) : Passwords.Verify(dto.Password, DummyHash);
            if (!ok || user is null || user.Disabled)
            {
                throttle.Failure(key);
                return Results.Json(new { error = "Invalid username or password" }, statusCode: 401);
            }
            throttle.Success(key);
            store.TouchLogin(user.Id);
            await SignIn(c, user);
            return Results.Ok(new { user = DtoFor(user, c.RequestServices.GetRequiredService<Db>()) });
        }).WithSummary("Sign in with username and password (sets the session cookie)");

        auth.MapPost("/logout", async (HttpContext c) =>
        {
            await c.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
            return Results.NoContent();
        }).WithSummary("Sign out");

        auth.MapGet("/passkey/login/options", (PasskeyService pk) =>
        {
            if (!pk.Available) return Bad("Passkeys are not available: set MAILLOG_PUBLIC_URL.");
            var (requestId, options) = pk.BeginLogin();
            return Results.Ok(new { requestId, options });
        }).WithSummary("Begin a passkey sign-in (WebAuthn assertion options)");

        auth.MapPost("/passkey/login", async (PasskeyLoginDto dto, HttpContext c, PasskeyService pk, UserStore store, Db db, CancellationToken ct) =>
        {
            if (!pk.Available) return Bad("Passkeys are not available: set MAILLOG_PUBLIC_URL.");
            try
            {
                var userId = await pk.FinishLogin(dto.RequestId, dto.Credential, ct);
                var user = store.ById(userId);
                if (user is null || user.Disabled) return Results.Json(new { error = "Account disabled" }, statusCode: 401);
                store.TouchLogin(user.Id);
                await SignIn(c, user);
                return Results.Ok(new { user = DtoFor(user, db) });
            }
            catch (Exception e) when (e is InvalidOperationException or Fido2NetLib.Fido2VerificationException or JsonException)
            {
                return Results.Json(new { error = "Passkey sign-in failed: " + e.Message }, statusCode: 401);
            }
        }).WithSummary("Finish a passkey sign-in (sets the session cookie)");

        // ---- own account ------------------------------------------------------------------------------------

        me.MapGet("", (HttpContext c, UserStore store, Db db) =>
            store.ById(Cur(c).Id) is { } u ? Results.Ok(DtoFor(u, db)) : Results.Unauthorized())
            .WithSummary("The signed-in user");

        me.MapPost("/password", (PasswordDto dto, HttpContext c, UserStore store, Db db) =>
        {
            var u = store.ById(Cur(c).Id);
            if (u is null) return Results.Unauthorized();
            if (!Passwords.Verify(dto.CurrentPassword, u.PasswordHash)) return Bad("Current password is wrong");
            if (dto.NewPassword.Length < 12) return Bad("The new password must have at least 12 characters");
            db.Exec("UPDATE users SET password_hash=@h, must_change_password=FALSE WHERE id=@id", new { h = Passwords.Hash(dto.NewPassword), id = u.Id });
            return Results.NoContent();
        }).WithSummary("Change the own password");

        me.MapGet("/passkeys", (HttpContext c, PasskeyService pk) => Results.Ok(pk.List(Cur(c).Id)))
            .WithSummary("List own passkeys");

        me.MapPost("/passkeys/options", (HttpContext c, UserStore store, PasskeyService pk) =>
        {
            if (!pk.Available) return Bad("Passkeys are not available: set MAILLOG_PUBLIC_URL.");
            var (requestId, options) = pk.BeginRegistration(store.ById(Cur(c).Id)!);
            return Results.Ok(new { requestId, options });
        }).WithSummary("Begin adding a passkey (WebAuthn creation options)");

        me.MapPost("/passkeys", async (PasskeyRegisterDto dto, HttpContext c, UserStore store, PasskeyService pk, CancellationToken ct) =>
        {
            if (!pk.Available) return Bad("Passkeys are not available: set MAILLOG_PUBLIC_URL.");
            try
            {
                var item = await pk.FinishRegistration(store.ById(Cur(c).Id)!, dto.RequestId, dto.Name ?? "", dto.Credential, ct);
                return Results.Created($"/api/v1/me/passkeys/{item["id"]}", item);
            }
            catch (Exception e) when (e is InvalidOperationException or Fido2NetLib.Fido2VerificationException or JsonException)
            {
                return Bad("Could not add the passkey: " + e.Message);
            }
        }).WithSummary("Finish adding a passkey");

        me.MapDelete("/passkeys/{id}", (string id, HttpContext c, PasskeyService pk) =>
            pk.Delete(Cur(c).Id, id) ? Results.NoContent() : Results.NotFound()).WithSummary("Remove a passkey");

        me.MapGet("/tokens", (HttpContext c, UserStore store) => Results.Ok(store.Tokens(Cur(c).Id)))
            .WithSummary("List own personal access tokens");

        me.MapPost("/tokens", (TokenCreateDto dto, HttpContext c, UserStore store) =>
        {
            if (string.IsNullOrWhiteSpace(dto.Name) || dto.Name.Length > 100) return Bad("Name is required (max 100 characters)");
            if (dto.ExpiresInDays is < 1 or > 3650) return Bad("expiresInDays must be between 1 and 3650");
            var (token, item) = store.CreateToken(Cur(c).Id, dto.Name.Trim(), dto.ReadOnly, dto.ExpiresInDays);
            return Results.Created($"/api/v1/me/tokens/{item["id"]}", new { token, item });
        }).WithSummary("Create a personal access token (the plain token is returned only once)");

        me.MapDelete("/tokens/{id}", (string id, HttpContext c, UserStore store) =>
            store.RevokeToken(Cur(c).Id, id) ? Results.NoContent() : Results.NotFound()).WithSummary("Revoke a personal access token");

        // ---- user administration (admin) --------------------------------------------------------------------

        users.MapGet("", (UserStore store) => Results.Ok(store.List())).WithSummary("List users");

        users.MapPost("", (UserCreateDto dto, UserStore store) =>
        {
            var username = dto.Username.Trim().ToLowerInvariant();
            if (!UsernamePattern().IsMatch(username)) return Bad("Username: 2-64 characters, a-z 0-9 . _ @ -");
            if (!Roles.All.Contains(dto.Role)) return Bad("Role must be admin, operator or viewer");
            var domains = UserStore.NormalizeDomains(dto.Domains);
            if (dto.Role == Roles.Viewer && domains.Length == 0) return Bad("A viewer needs at least one sender domain");
            if (dto.Password.Length < 12) return Bad("The password must have at least 12 characters");
            if (store.ByUsername(username) is not null) return Bad("Username already exists");
            var u = store.Create(username, string.IsNullOrWhiteSpace(dto.DisplayName) ? username : dto.DisplayName.Trim(), dto.Password, dto.Role, domains);
            return Results.Created($"/api/v1/users/{u.Id}", UserDto(u, 0));
        }).WithSummary("Create a user");

        users.MapPut("/{id}", (string id, UserUpdateDto dto, UserStore store, Db db) =>
        {
            var u = store.ById(id);
            if (u is null) return Results.NotFound();
            var role = dto.Role ?? u.Role;
            if (!Roles.All.Contains(role)) return Bad("Role must be admin, operator or viewer");
            var domains = dto.Domains is null ? u.Domains : UserStore.NormalizeDomains(dto.Domains);
            if (role == Roles.Viewer && domains.Length == 0) return Bad("A viewer needs at least one sender domain");
            var disabled = dto.Disabled ?? u.Disabled;
            var losesAdmin = u.Role == Roles.Admin && !u.Disabled && (role != Roles.Admin || disabled);
            if (losesAdmin && store.AdminCount() <= 1) return Bad("Cannot disable or demote the last administrator");
            if (dto.Password is { Length: > 0 and < 12 }) return Bad("The password must have at least 12 characters");
            db.Exec("""
                UPDATE users SET display_name=@dn, role=@role, domains=@domains, disabled=@disabled WHERE id=@id
                """, new { id, dn = string.IsNullOrWhiteSpace(dto.DisplayName) ? u.DisplayName : dto.DisplayName.Trim(), role, domains, disabled });
            if (!string.IsNullOrEmpty(dto.Password))
                db.Exec("UPDATE users SET password_hash=@h, must_change_password=FALSE WHERE id=@id", new { id, h = Passwords.Hash(dto.Password) });
            return Results.Ok(DtoFor(store.ById(id)!, db));
        }).WithSummary("Update a user (role, domains, disabled, password)");

        users.MapDelete("/{id}", (string id, HttpContext c, UserStore store, Db db) =>
        {
            var u = store.ById(id);
            if (u is null) return Results.NotFound();
            if (id == Cur(c).Id) return Bad("You cannot delete yourself");
            if (u.Role == Roles.Admin && !u.Disabled && store.AdminCount() <= 1) return Bad("Cannot delete the last administrator");
            db.Exec("DELETE FROM users WHERE id=@id", new { id });
            return Results.NoContent();
        }).WithSummary("Delete a user");
    }

    private static readonly string DummyHash = Passwords.Hash("not-a-real-password");
}
