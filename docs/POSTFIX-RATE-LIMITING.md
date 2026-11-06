# Rate limiting for a relay chain without bans

Typical chain: applications → **relay** (SASL submission, Postfix + saslauthd) → **outbound** (Postfix + OpenDKIM) → internet.

Goal: never lose or reject legitimate bulk mail (newsletters) and never ban your own servers, but still protect the
reputation of your sending IP. The recipe below is what maillog's default agent roles expect.

## 1. Accept everything, throttle where mail leaves

* **Relay:** no `smtpd_client_*_rate_limit`. It only authenticates and forwards (`relayhost = outbound`).
* **Outbound** only receives from trusted internal hosts, so its *inbound* per-client limits are switched off:
  ```
  smtpd_client_message_rate_limit   = 0
  smtpd_client_recipient_rate_limit = 0
  # smtpd_client_event_limit_exceptions stays at its default ($mynetworks)
  ```
  The `smtpd_client_*_rate_limit` family answers `451 4.7.1 ... rate limit exceeded` and is meant for *untrusted* clients.
  Applied to the relay in front of you it turns a newsletter into deferrals and retry storms.
* **Throttle the delivery side** (the Postfix queue absorbs the burst, the queue manager paces it):
  ```
  smtp_destination_concurrency_limit = 2     # parallel connections per destination domain
  smtp_destination_rate_delay        = 1s    # at least 1 s between deliveries to the same destination
  ```
  and cap the total number of simultaneous delivery processes in `master.cf`:
  ```
  postconf -F 'smtp/unix/process_limit=25'
  ```
  Result: about one message per second **per destination domain**, independent of how fast the relay hands mail over.
  A 4 000-recipient newsletter drains in minutes to a few hours depending on the recipient domains, nothing is rejected.

Tested on Postfix 3.10: 1 300 messages submitted in 15 s through the relay were accepted without a single rate-limit
warning (the old limit was 1 000 per minute); deliveries to one destination left at exactly one per second.

## 2. fail2ban: ban attackers, not outages

Postfix logs two different SASL failures:

| log text | meaning |
|----------|---------|
| `SASL LOGIN authentication failed: authentication failure` | wrong password: a real attack or a misconfigured client |
| `SASL LOGIN authentication failed: generic failure` | the **authentication backend** is broken (saslauthd down, socket missing) |

The stock `postfix[mode=auth]` filter counts both. When saslauthd stops, every correctly configured server produces
"failures" and gets banned, which turns a small outage into a long one. Ignore the backend error:

```ini
# /etc/fail2ban/filter.d/postfix.local
[Definition]
ignoreregex = : SASL (?:LOGIN|PLAIN|(?:CRAM|DIGEST)-MD5) authentication failed: generic failure
```

Check it against your real logs before you rely on it: `fail2ban-regex /var/log/mail.log "postfix[mode=auth]"`
must list the `generic failure` lines under *Ignoreregex* and keep counting `authentication failure`.

## 3. Keep saslauthd running

Debian ships `saslauthd.service` with `Restart=no`:

```ini
# /etc/systemd/system/saslauthd.service.d/restart.conf
[Service]
Restart=on-failure
RestartSec=2
```

maillog's `relay` role additionally probes saslauthd every 30 s (`testsaslauthd` with a non-existent user must answer
`0: NO`), restarts it after two failed probes and alerts. `generic failure` events also raise an alert on their own.

## 4. Watch the queue instead of counting rejections

The `queue` health check reports size, active/deferred/hold and the age of the oldest *moving* message. Old *deferred* mail
(recipient mailbox full, greylisting) is normal and never raises an age warning; a growing or non-draining queue does.
