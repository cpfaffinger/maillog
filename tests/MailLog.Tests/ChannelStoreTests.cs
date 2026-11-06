using Microsoft.AspNetCore.DataProtection;
using MailLog;
using Xunit;

namespace MailLog.Tests;

public class ChannelStoreTests
{
    // Merge/Validate/RevealPassword never touch the database
    private static ChannelStore NewStore() => new(null!, new EphemeralDataProtectionProvider());

    [Fact]
    public void Password_is_encrypted_and_kept_when_not_resent()
    {
        var store = NewStore();
        var set = store.Merge(new ChannelSet(), new ChannelsInput(new SmtpInput(true, "smtp.example.net", 587, "starttls", true, "user",
            "s3cret!", null, "alerts@example.net", "maillog", ["ops@example.net"]), null, null));
        Assert.NotNull(set.Smtp.PasswordProtected);
        Assert.DoesNotContain("s3cret!", set.Smtp.PasswordProtected);
        Assert.Equal("s3cret!", store.RevealPassword(set.Smtp));

        var renamed = store.Merge(set, new ChannelsInput(new SmtpInput(null, null, null, null, null, "other", null, null, null, null, null), null, null));
        Assert.Equal("other", renamed.Smtp.Username);
        Assert.Equal("s3cret!", store.RevealPassword(renamed.Smtp));
        Assert.Equal("user", set.Smtp.Username); // merge works on a copy

        var cleared = store.Merge(set, new ChannelsInput(new SmtpInput(null, null, null, null, false, null, null, true, null, null, null), null, null));
        Assert.Null(cleared.Smtp.PasswordProtected);
    }

    [Fact]
    public void Validation_rules()
    {
        var store = NewStore();
        ChannelSet Smtp(Func<SmtpInput, SmtpInput> tweak)
        {
            var baseInput = new SmtpInput(true, "smtp.example.net", 587, "starttls", false, "", null, null, "alerts@example.net", "maillog", ["ops@example.net"]);
            return store.Merge(new ChannelSet(), new ChannelsInput(tweak(baseInput), null, null));
        }

        Assert.Null(store.Validate(Smtp(x => x)));
        Assert.NotNull(store.Validate(Smtp(x => x with { Host = " " })));
        Assert.NotNull(store.Validate(Smtp(x => x with { Port = 70000 })));
        Assert.NotNull(store.Validate(Smtp(x => x with { Security = "tls13" })));
        Assert.NotNull(store.Validate(Smtp(x => x with { From = "nope" })));
        Assert.NotNull(store.Validate(Smtp(x => x with { To = ["a@b.test", "broken"] })));
        Assert.NotNull(store.Validate(Smtp(x => x with { To = [] })));
        Assert.NotNull(store.Validate(Smtp(x => x with { Authenticate = true, Username = "u" })));             // no password
        Assert.Null(store.Validate(Smtp(x => x with { Authenticate = true, Username = "u", Password = "p" })));
        Assert.Null(store.Validate(Smtp(x => x with { Enabled = false, Host = "" })));                         // disabled channels may be incomplete
    }

    [Fact]
    public void Recipients_are_trimmed_and_deduplicated()
    {
        var store = NewStore();
        var set = store.Merge(new ChannelSet(), new ChannelsInput(new SmtpInput(null, null, null, null, null, null, null, null, null, null,
            [" a@b.test ", "A@B.test", "c@d.test", ""]), null, null));
        Assert.Equal(["a@b.test", "c@d.test"], set.Smtp.To);
    }

    [Fact]
    public void View_never_contains_the_password()
    {
        var store = NewStore();
        var set = store.Merge(new ChannelSet(), new ChannelsInput(new SmtpInput(true, "h", 25, "none", true, "u", "pw", null, "a@b.test", null, ["x@y.test"]), null, null));
        var json = System.Text.Json.JsonSerializer.Serialize(ChannelStore.View(set));
        Assert.DoesNotContain("pw\"", json);
        Assert.Contains("\"passwordSet\":true", json);
    }

    [Fact]
    public void Signal_and_webhook_validation()
    {
        var store = NewStore();
        Assert.NotNull(store.Validate(store.Merge(new ChannelSet(), new ChannelsInput(null, new SignalInput(true, "http://x", "", []), null))));
        Assert.Null(store.Validate(store.Merge(new ChannelSet(), new ChannelsInput(null, new SignalInput(true, "http://x:8080/", "+431234", ["+435678"]), null))));
        Assert.NotNull(store.Validate(store.Merge(new ChannelSet(), new ChannelsInput(null, null, new WebhookInput(true, "ftp://x", "json")))));
        Assert.NotNull(store.Validate(store.Merge(new ChannelSet(), new ChannelsInput(null, null, new WebhookInput(true, "https://x", "xml")))));
        Assert.Null(store.Validate(store.Merge(new ChannelSet(), new ChannelsInput(null, null, new WebhookInput(true, "https://x/hook", "slack")))));
    }
}
