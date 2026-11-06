# Message status API (for applications)

An application that sends mail through your servers can ask maillog what became of a message, instead of reading
`mail.log` on the mail server. The application keeps the `Message-ID` header of every mail it sends and asks for the status
later.

* Authentication: an **API key** (`mlk_...`), created by an administrator under **API keys** in the web UI.
* A key is **limited to sender domains**. It only finds messages whose envelope sender (`MAIL FROM`) is in one of those domains.
  A message of any other domain looks exactly like an unknown one (same answer, so a key cannot be used to probe other customers).
* A key can call **nothing else** (no events, no statistics, no users). It reveals no server names, IP addresses or SASL accounts.
* The interactive reference is at `/api/docs` (section "Message status").

## Create a key

Web UI → **API keys** → **New API key**: a name, the sender domains (for example `danceplus.at`) and an expiry. The key is shown once.
Revoking it in the same page takes effect immediately.

## Look up one message

```bash
curl -H "Authorization: Bearer mlk_YOUR_KEY" \
     "https://maillog.pulse.one/api/v1/messages/status?messageId=%3Cabc123%40danceplus.at%3E"
```

`messageId` is the value of the `Message-ID` header, with or without the angle brackets (URL-encode it). `X-Api-Key: mlk_...` works as
an alternative to the `Authorization` header. Add `&timeline=true` for the individual steps.

* `200` – the message is known (see the fields below).
* `404` – no message with this id and an allowed sender domain is known. The body has the same shape with `"found": false` and
  `"status": "not_found"`.
* `401` – missing, wrong, expired or revoked key. `429` – more than 600 requests per minute for this key (`Retry-After: 60`).

```json
{
  "messageId": "abc123@danceplus.at",
  "found": true,
  "status": "delivered",
  "final": true,
  "summary": "Delivered to user@gmail.com",
  "sender": "noreply@danceplus.at",
  "receivedAt": "2026-11-06T14:07:36.543+00:00",
  "lastEventAt": "2026-11-06T14:07:38.100+00:00",
  "deliveredAt": "2026-11-06T14:07:38.100+00:00",
  "totalDelaySeconds": 1.6,
  "recipientCount": 1,
  "recipients": [
    {
      "address": "user@gmail.com",
      "status": "delivered",
      "dsn": "2.0.0",
      "remoteServer": "gmail-smtp-in.l.google.com[142.250.1.1]:25",
      "detail": "250 2.0.0 OK ... - gsmtp",
      "attempts": 1,
      "lastAttemptAt": "2026-11-06T14:07:38.100+00:00",
      "deliveredAt": "2026-11-06T14:07:38.100+00:00",
      "delaySeconds": 1.3
    }
  ],
  "timeline": null,
  "logsCompleteUntil": "2026-11-06T14:09:01.000+00:00"
}
```

### `status`

| status       | meaning                                                                                  | `final` |
|--------------|------------------------------------------------------------------------------------------|---------|
| `queued`     | accepted by the mail system, no delivery information yet                                 | no      |
| `in_transit` | handed to the outbound server, not yet attempted at the recipient's server               | no      |
| `deferred`   | temporary failure (mailbox full, timeout, greylisting), the server keeps retrying        | no      |
| `delivered`  | accepted by the recipient's mail server (every recipient)                                | yes     |
| `bounced`    | permanently refused (unknown user, blocked). The reason is in `recipients[].dsn/detail`  | yes     |
| `expired`    | retried until the queue lifetime ended, then given up                                    | yes     |
| `partial`    | several recipients; some delivered, some failed, none pending                            | yes     |
| `rejected`   | refused by our own mail system after it had accepted the message                         | yes     |
| `not_found`  | nothing known (see below)                                                                | no      |

`final: false` means the status can still change: ask again later. A recipient has the same values as `status`
(`queued`, `in_transit`, `deferred`, `delivered`, `bounced`, `expired`). "Delivered" means the recipient's mail server accepted the
message; it says nothing about the inbox vs. spam folder.

### `not_found` and `logsCompleteUntil`

`not_found` does not prove that nothing was sent: the logs travel from the mail servers to maillog within seconds, but a message that was
sent a moment ago may not be there yet. `logsCompleteUntil` is the time up to which the logs of all mail servers have arrived. If you
asked about a message that was sent **before** `logsCompleteUntil` (minus a minute of margin) and still get `not_found`, no log
entry will appear for it: treat it as "unknown / not sent from an allowed domain".

## Look up many messages

```bash
curl -X POST -H "Authorization: Bearer mlk_YOUR_KEY" -H "Content-Type: application/json" \
     -d '{"messageIds": ["<abc123@danceplus.at>", "<def456@danceplus.at>"], "timeline": false}' \
     https://maillog.pulse.one/api/v1/messages/status
```

Up to 100 ids per request (duplicates are answered once). Always `200`:
`{ "results": [ { ... same object as above ... } ], "logsCompleteUntil": "..." }`; unknown ids come back with `found: false`.

## Connection test

```bash
curl -H "Authorization: Bearer mlk_YOUR_KEY" https://maillog.pulse.one/api/v1/key
# {"kind":"apikey","name":"danceplus","role":"apikey","domains":["danceplus.at"],"expiresAt":null}
```

## Timeline (optional)

With `timeline=true` (GET) or `"timeline": true` (POST) each result carries the steps in time order:

```json
{ "at": "2026-11-06T14:07:36.600+00:00", "hop": 1, "kind": "queued", "status": null, "recipient": null, "dsn": null, "detail": "size=1234 nrcpt=1" }
{ "at": "2026-11-06T14:07:36.700+00:00", "hop": 1, "kind": "delivery", "status": "sent", "recipient": "user@gmail.com", "dsn": "2.0.0", "detail": "Handed over to the next mail server" }
{ "at": "2026-11-06T14:07:38.100+00:00", "hop": 2, "kind": "delivery", "status": "sent", "recipient": "user@gmail.com", "dsn": "2.0.0", "detail": "250 2.0.0 OK ..." }
```

`hop` numbers the servers in the order the message passed them (no server names are disclosed).

## Recommended client behaviour

1. Store the `Message-ID` of every mail you hand to the mail server (PHPMailer: `$mail->getLastMessageID()`).
2. Ask again after about 2 minutes (the first status is usually final within seconds for normal mail).
3. As long as `final` is `false`, keep asking with growing intervals (for example 2, 10, 60 minutes, then hourly) for as long as you care;
   mail is retried by Postfix for up to 5 days by default.
4. Treat a `not_found` as definitive only after `logsCompleteUntil` has passed the time you sent the mail.
5. Never log or display the API key; keep it in the application's configuration, not in the repository.
6. Use the batch endpoint for periodic jobs (one request per 100 messages).
7. Send your own `User-Agent` header (for example `danceplus-web/1.0`). maillog sits behind Cloudflare, which rejects requests with the default
   User-Agent of some HTTP libraries (for example Python's urllib) with `403 error code: 1010`. Set a request timeout of about 10-30 seconds.

## How it works

Every mail server (agent) ships its Postfix log lines to maillog. Each hop logs the `Message-ID` header (`cleanup ... message-id=<...>`),
so maillog connects the queue entries of all servers that handled the message, checks that the envelope sender is in the key's
domains, and derives the status per recipient from the delivery lines of the **last** server. Messages are kept for the retention
period configured in the settings (180 days by default); older messages are `not_found`.
