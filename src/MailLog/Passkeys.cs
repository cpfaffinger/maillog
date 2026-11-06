using System.Text.Json;
using Fido2NetLib;
using Fido2NetLib.Objects;
using Microsoft.Extensions.Caching.Memory;

namespace MailLog;

/// <summary>WebAuthn passkeys (discoverable credentials) on top of Fido2NetLib. Requires MAILLOG_PUBLIC_URL (relying party = its host).</summary>
public sealed class PasskeyService
{
    private readonly Db _db;
    private readonly IMemoryCache _cache;
    private readonly IFido2? _fido2;

    public bool Available => _fido2 is not null;

    public PasskeyService(Db db, IMemoryCache cache, Settings settings)
    {
        _db = db;
        _cache = cache;
        if (settings.PublicUrl is { } url && Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            var origin = uri.GetLeftPart(UriPartial.Authority);
            _fido2 = new Fido2(new Fido2Configuration
            {
                RPID = uri.Host,
                RPName = "maillog",
                Origins = new HashSet<string> { origin },
            });
        }
    }

    private IFido2 Fido => _fido2 ?? throw new InvalidOperationException("Passkeys need MAILLOG_PUBLIC_URL to be configured.");

    private sealed record Pending(string Json, string? UserId, string? Name);

    private string Remember(string json, string? userId)
    {
        var id = Guid.NewGuid().ToString("N");
        _cache.Set("pk:" + id, new Pending(json, userId, null), TimeSpan.FromMinutes(5));
        return id;
    }

    private Pending Take(string requestId, string? expectedUserId)
    {
        if (!_cache.TryGetValue("pk:" + requestId, out Pending? p) || p is null) throw new InvalidOperationException("Request expired, please try again.");
        _cache.Remove("pk:" + requestId);
        if (p.UserId != expectedUserId) throw new InvalidOperationException("Request does not belong to this user.");
        return p;
    }

    // ---- registration ---------------------------------------------------------------------------------------

    public (string requestId, JsonElement options) BeginRegistration(UserRow user)
    {
        var existing = _db.Rows("SELECT credential_id FROM passkeys WHERE user_id=@u", new { u = user.Id })
            .Select(r => new PublicKeyCredentialDescriptor((byte[])r["credentialId"]!)).ToList();
        var options = Fido.RequestNewCredential(new RequestNewCredentialParams
        {
            User = new Fido2User { Id = System.Text.Encoding.UTF8.GetBytes(user.Id), Name = user.Username, DisplayName = user.DisplayName },
            ExcludeCredentials = existing,
            AuthenticatorSelection = new AuthenticatorSelection
            {
                ResidentKey = ResidentKeyRequirement.Required,
                UserVerification = UserVerificationRequirement.Preferred,
            },
            AttestationPreference = AttestationConveyancePreference.None,
        });
        var json = options.ToJson();
        return (Remember(json, user.Id), JsonDocument.Parse(json).RootElement.Clone());
    }

    public async Task<Dictionary<string, object?>> FinishRegistration(UserRow user, string requestId, string name, JsonElement credential, CancellationToken ct)
    {
        var pending = Take(requestId, user.Id);
        var options = CredentialCreateOptions.FromJson(pending.Json);
        var response = JsonSerializer.Deserialize<AuthenticatorAttestationRawResponse>(credential.GetRawText())
                       ?? throw new InvalidOperationException("Invalid credential");
        var result = await Fido.MakeNewCredentialAsync(new MakeNewCredentialParams
        {
            AttestationResponse = response,
            OriginalOptions = options,
            IsCredentialIdUniqueToUserCallback = (args, _) =>
                Task.FromResult(_db.Scalar<long>("SELECT count(*) FROM passkeys WHERE credential_id=@c", new { c = args.CredentialId }) == 0),
        }, ct);

        var id = Guid.NewGuid().ToString("N");
        _db.Exec("""
            INSERT INTO passkeys(id, user_id, name, credential_id, public_key, user_handle, sign_count, created_at)
            VALUES(@id, @uid, @name, @cid, @pk, @uh, @sc, @now)
            """, new
        {
            id, uid = user.Id, name = string.IsNullOrWhiteSpace(name) ? "Passkey" : name.Trim(),
            cid = result.Id, pk = result.PublicKey, uh = System.Text.Encoding.UTF8.GetBytes(user.Id),
            sc = (long)result.SignCount, now = Store.Now(),
        });
        return _db.Rows("SELECT id, name, created_at, last_used FROM passkeys WHERE id=@id", new { id })[0];
    }

    // ---- login ----------------------------------------------------------------------------------------------

    public (string requestId, JsonElement options) BeginLogin()
    {
        var options = Fido.GetAssertionOptions(new GetAssertionOptionsParams
        {
            AllowedCredentials = [],
            UserVerification = UserVerificationRequirement.Preferred,
        });
        var json = options.ToJson();
        return (Remember(json, null), JsonDocument.Parse(json).RootElement.Clone());
    }

    /// <summary>Returns the user id the assertion belongs to.</summary>
    public async Task<string> FinishLogin(string requestId, JsonElement credential, CancellationToken ct)
    {
        var pending = Take(requestId, null);
        var options = AssertionOptions.FromJson(pending.Json);
        var response = JsonSerializer.Deserialize<AuthenticatorAssertionRawResponse>(credential.GetRawText())
                       ?? throw new InvalidOperationException("Invalid credential");

        var rows = _db.Rows("SELECT id, user_id, public_key, sign_count, user_handle FROM passkeys WHERE credential_id=@c", new { c = response.RawId });
        if (rows.Count != 1) throw new InvalidOperationException("Unknown passkey");
        var row = rows[0];

        var result = await Fido.MakeAssertionAsync(new MakeAssertionParams
        {
            AssertionResponse = response,
            OriginalOptions = options,
            StoredPublicKey = (byte[])row["publicKey"]!,
            StoredSignatureCounter = (uint)(long)row["signCount"]!,
            IsUserHandleOwnerOfCredentialIdCallback = (args, _) =>
                Task.FromResult(((byte[])row["userHandle"]!).AsSpan().SequenceEqual(args.UserHandle)),
        }, ct);

        _db.Exec("UPDATE passkeys SET sign_count=@sc, last_used=@now WHERE id=@id",
            new { sc = (long)result.SignCount, now = Store.Now(), id = (string)row["id"]! });
        return (string)row["userId"]!;
    }

    public List<Dictionary<string, object?>> List(string userId) =>
        _db.Rows("SELECT id, name, created_at, last_used FROM passkeys WHERE user_id=@u ORDER BY created_at", new { u = userId });

    public bool Delete(string userId, string id) =>
        _db.Exec("DELETE FROM passkeys WHERE id=@id AND user_id=@u", new { id, u = userId }) == 1;
}
