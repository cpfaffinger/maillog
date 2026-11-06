using Microsoft.AspNetCore.DataProtection;
using System.Xml.Linq;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection.KeyManagement;
using Microsoft.AspNetCore.DataProtection.Repositories;
using Microsoft.Extensions.Options;
using MailLog;
using Scalar.AspNetCore;

var builder = WebApplication.CreateBuilder(args);
builder.Configuration.AddEnvironmentVariables("MAILLOG_");
var settings = Settings.From(builder.Configuration);

builder.Services.AddSingleton(settings);
builder.Services.AddSingleton<Db>();
builder.Services.AddSingleton<Store>();
builder.Services.AddSingleton<UserStore>();
builder.Services.AddSingleton<PasskeyService>();
builder.Services.AddSingleton<LoginThrottle>();
builder.Services.AddSingleton<ChannelStore>();
builder.Services.AddSingleton<ApiKeyStore>();
builder.Services.AddSingleton<KeyRateLimiter>();
builder.Services.AddSingleton<MessageStatusService>();
builder.Services.AddSingleton<Notifier>();
builder.Services.AddSingleton<PgXmlRepository>();
builder.Services.AddHostedService<AlertService>();
builder.Services.AddHostedService<RetentionService>();
builder.Services.AddMemoryCache();
builder.Services.AddHttpClient();
builder.Services.AddRequestDecompression();
builder.Services.Configure<Microsoft.AspNetCore.Http.Json.JsonOptions>(o => o.SerializerOptions.DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never);

// Data protection keys live in the database, so the app container needs no writable mount.
builder.Services.AddDataProtection().SetApplicationName("maillog");
builder.Services.AddSingleton<IConfigureOptions<KeyManagementOptions>>(sp =>
    new ConfigureOptions<KeyManagementOptions>(o => o.XmlRepository = sp.GetRequiredService<PgXmlRepository>()));

builder.Services.AddAuthentication("Smart")
    .AddPolicyScheme("Smart", "Cookie or personal access token", o =>
        o.ForwardDefaultSelector = ctx =>
            ctx.Request.Headers.Authorization.ToString().StartsWith("Bearer mlp_", StringComparison.Ordinal) ? PatAuthHandler.SchemeName
            : ApiKeyAuthHandler.Presented(ctx.Request) is not null ? ApiKeyAuthHandler.SchemeName
            : CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(CookieAuthenticationDefaults.AuthenticationScheme, o =>
    {
        o.Cookie.Name = "maillog.auth";
        o.Cookie.HttpOnly = true;
        o.Cookie.SameSite = SameSiteMode.Strict;
        o.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
        o.ExpireTimeSpan = TimeSpan.FromDays(7);
        o.SlidingExpiration = true;
        o.Events.OnRedirectToLogin = c => { c.Response.StatusCode = 401; return Task.CompletedTask; };
        o.Events.OnRedirectToAccessDenied = c => { c.Response.StatusCode = 403; return Task.CompletedTask; };
        o.Events.OnValidatePrincipal = CookieRevalidation.Validate;
    })
    .AddScheme<AuthenticationSchemeOptions, PatAuthHandler>(PatAuthHandler.SchemeName, _ => { })
    .AddScheme<AuthenticationSchemeOptions, ApiKeyAuthHandler>(ApiKeyAuthHandler.SchemeName, _ => { });

builder.Services.AddAuthorizationBuilder()
    // API keys are service credentials for the message status lookup only: every endpoint that uses the default policy refuses them
    .SetDefaultPolicy(new Microsoft.AspNetCore.Authorization.AuthorizationPolicyBuilder().RequireAuthenticatedUser()
        .RequireAssertion(c => !c.User.IsInRole(Roles.ApiKey)).Build())
    .AddPolicy("lookup", p => p.RequireAuthenticatedUser())
    .AddPolicy("operator", p => p.RequireRole(Roles.Admin, Roles.Operator))
    .AddPolicy("admin", p => p.RequireRole(Roles.Admin))
    .SetFallbackPolicy(null);

builder.Services.AddOpenApi(o => o.AddDocumentTransformer((doc, _, _) =>
{
    doc.Info.Title = "maillog API";
    doc.Info.Version = "v1";
    doc.Info.Description = "Central mail log and health monitor. Authenticate with a session cookie or a personal access token (`Authorization: Bearer mlp_...`). Integrations use an API key (`Authorization: Bearer mlk_...` or `X-Api-Key: mlk_...`) to look up the delivery status of a message by its Message-ID; an API key is limited to sender domains and cannot call any other endpoint.";
    return Task.CompletedTask;
}));

var app = builder.Build();

app.Services.GetRequiredService<Db>();
var userStore = app.Services.GetRequiredService<UserStore>();

// `dotnet MailLog.dll reset-admin-password`: recovery for a lost administrator password (does not start the web server)
if (args.Length > 0 && args[0] == "reset-admin-password")
{
    userStore.ResetAdminPassword();
    return;
}

userStore.EnsureDefaultAdmin();

app.Use(async (ctx, next) =>
{
    ctx.Response.Headers["X-Content-Type-Options"] = "nosniff";
    ctx.Response.Headers["Referrer-Policy"] = "same-origin";
    var path = ctx.Request.Path;
    if (!path.StartsWithSegments("/api/docs") && !path.StartsWithSegments("/openapi"))
        ctx.Response.Headers["Content-Security-Policy"] =
            "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'";
    await next();
});

app.UseRequestDecompression();
app.UseDefaultFiles();
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = ctx =>
    {
        if (ctx.File.Name == "index.html") ctx.Context.Response.Headers.CacheControl = "no-cache";
    },
});
app.UseAuthentication();

// Read-only personal access tokens may only use safe methods.
app.Use(async (ctx, next) =>
{
    if (ctx.User.FindFirst("readonly") is not null && !HttpMethods.IsGet(ctx.Request.Method) && !HttpMethods.IsHead(ctx.Request.Method))
    {
        ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
        await ctx.Response.WriteAsJsonAsync(new { error = "This access token is read-only" });
        return;
    }
    await next();
});
app.UseAuthorization();

app.MapGet("/healthz", (Db db) =>
{
    db.Scalar<long>("SELECT 1");
    return Results.Text("ok");
}).ExcludeFromDescription();

app.MapGet("/api/v1/version", () =>
{
    var info = typeof(Program).Assembly.GetCustomAttributes(typeof(System.Reflection.AssemblyInformationalVersionAttribute), false)
        .OfType<System.Reflection.AssemblyInformationalVersionAttribute>().FirstOrDefault()?.InformationalVersion ?? "dev";
    var plus = info.IndexOf('+');
    var version = plus >= 0 ? info[..plus] : info;
    var commit = plus >= 0 && plus + 1 < info.Length ? info[(plus + 1)..Math.Min(info.Length, plus + 8)] : null;
    return Results.Ok(new { name = "maillog", version, commit });
}).WithTags("System").WithSummary("Application version (anonymous)");

UserApi.Map(app);
DataApi.Map(app);
StatsApi.Map(app);
ApiKeyApi.Map(app);
MessageStatusApi.Map(app);
AgentApi.Map(app);

app.MapOpenApi();
app.MapScalarApiReference("/api/docs", o => o.WithTitle("maillog API").WithOpenApiRoutePattern("/openapi/{documentName}.json"));

app.Map("/api/{**rest}", () => Results.NotFound(new { error = "Not found" })).ExcludeFromDescription();
app.MapFallbackToFile("index.html");

app.Run();

/// <summary>ASP.NET Core data protection key ring stored in PostgreSQL.</summary>
public sealed class PgXmlRepository(Db db) : IXmlRepository
{
    public IReadOnlyCollection<XElement> GetAllElements() =>
        db.Rows("SELECT xml FROM dp_keys").Select(r => XElement.Parse((string)r["xml"]!)).ToList();

    public void StoreElement(XElement element, string friendlyName) =>
        db.Exec("INSERT INTO dp_keys(name, xml) VALUES(@name, @xml) ON CONFLICT (name) DO UPDATE SET xml=EXCLUDED.xml",
            new { name = string.IsNullOrEmpty(friendlyName) ? Guid.NewGuid().ToString("N") : friendlyName, xml = element.ToString(SaveOptions.DisableFormatting) });
}

public partial class Program;
