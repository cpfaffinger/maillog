# maillog

Central mail log, queue and health monitor for Postfix servers (relays, outbound/DKIM hosts, MX).
Small agents on your mail servers ship their logs to one place, report health and the Postfix queue, and heal broken services automatically.
A web UI and an OpenAPI-documented API give admins the whole picture and give customers a view of their own mail.

* **Server:** ASP.NET Core (.NET 10) + PostgreSQL, one container, one HTTP port. TLS is done by your reverse proxy.
* **UI:** Angular + Angular Material. Passkey (WebAuthn) and password login.
* **Agent:** one Python 3 file (stdlib only), installed with a one-liner, outbound HTTPS only.
* **Docker:** `docker compose`, **bind mounts only** (no named volumes).

```
 mail server A ─┐                                       ┌─ Angular UI (admins, operators, customers)
 mail server B ─┼─ agent ──HTTPS──▶ nginx ──▶ maillog ──┤
 mail server C ─┘  logs, health,    (TLS)     (.NET 10)  └─ /api/v1 + OpenAPI (personal access tokens)
                   queue, recovery               │
                                           PostgreSQL
```

## Features

* **Log search and message trace** – Postfix, OpenDKIM, saslauthd and fail2ban lines are parsed into events (queued, delivered, deferred, bounced, rejected, auth failures, bans …). Follow one message across all hops (relay → outbound) via queue ids.
* **Mail queue monitoring** – per server: queue size, active/deferred/hold, age of the oldest *moving* message, top sender domains, recipient domains and delay reasons, history chart.
* **Health checks with auto-recovery** – systemd services, TCP banners, disk, queue, and a real saslauthd probe. A failed service is restarted after two failed runs (limited to 4 restarts/hour) and the recovery is reported.
* **Alerts** – offline agents, failing checks, SASL backend down (Postfix "generic failure"), rate limits, foreign sender domains, fail2ban bans, mail volume, deferral storms, stuck queue. Channels: webhook (json/slack/discord/ntfy), signal-cli-rest-api, SMTP.
* **RBAC** – `admin`, `operator`, and `viewer` (a customer scoped to one or more sender domains: sees only mail from `@their-domain` on the final hop, no infrastructure data).
* **Personal access tokens** (optionally read-only/expiring) and **passkeys**.
* **Retention** – mail events are deleted automatically after N days (default **180**, changeable in the UI).

## Quick start

```bash
git clone https://github.com/cpfaffinger/maillog.git
cd maillog
cp .env.example .env && chmod 600 .env     # set POSTGRES_PASSWORD, MAILLOG_ADMIN_PASSWORD, MAILLOG_PUBLIC_URL
docker compose up -d --build
```

The app listens on `127.0.0.1:33023` (`MAILLOG_PORT`). Put a TLS reverse proxy in front, for example nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name maillog.example.com;
    # ssl_certificate ...

    client_max_body_size 16m;
    location / {
        proxy_pass http://127.0.0.1:33023;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Sign in as `admin` with `MAILLOG_ADMIN_PASSWORD` (only used on the very first start; afterwards manage users in the UI).
Set `MAILLOG_PUBLIC_URL` to the public https URL – it is required for passkeys and used in install commands.

## Add a mail server

1. UI → **Agents → Add agent**, choose a role (`relay` = SASL submission relay, `outbound` = DKIM/sending host, `inbound` = MX, `generic`).
2. Run the shown command on the server (it contains a single-use enrollment token valid for 24 h):
   ```bash
   curl -fsSL https://maillog.example.com/install.sh | sudo bash -s -- --enroll mle_xxxxxxxx
   ```
3. The agent registers, starts shipping `/var/log/mail.log`, runs the role's default checks and appears in the overview.
   Checks and log files can be edited per agent in the UI. See [agent/README.md](agent/README.md) and [docs/AGENT-PROTOCOL.md](docs/AGENT-PROTOCOL.md).

Security model of the agent: it only makes outbound HTTPS calls, the server never sends commands (only declarative check definitions),
it restarts only units in a local allow-list (`/etc/maillog-agent.json`) and reads only log files below `allowedLogDirs`.

## Postfix recipe

How to rate limit a relay chain without hard bans (tested, and what the default agent roles expect): [docs/POSTFIX-RATE-LIMITING.md](docs/POSTFIX-RATE-LIMITING.md).

## Users, roles, tokens

| role | can |
|------|-----|
| `admin` | everything: users, agents, settings |
| `operator` | read everything incl. infrastructure (overview, queue, alerts) |
| `viewer` | read mail of their sender domains only (events, trace, stats) |

Personal access tokens: *Account → Access tokens*, then

```bash
curl -H "Authorization: Bearer mlp_xxx" "https://maillog.example.com/api/v1/events?q=customer-a.example&limit=50"
```

The OpenAPI document is at `/openapi/v1.json`, interactive docs at `/api/docs`. Endpoint reference: [docs/API.md](docs/API.md).

## Configuration

All configuration is via environment variables (`.env`). See [.env.example](.env.example) for the complete list:
database password, admin password, public URL, retention, alert channels and thresholds.

## Development

```bash
# backend (needs the .NET 10 SDK and a PostgreSQL)
MAILLOG_DB_CONNECTION="Host=localhost;Database=maillog;Username=maillog;Password=..." MAILLOG_ADMIN_PASSWORD=... dotnet run --project src/MailLog
dotnet test tests/MailLog.Tests        # parser + auth unit tests
python tests/e2e/e2e.py http://localhost:8080 <admin password>   # API end-to-end test (synthetic data)
python -m unittest discover -s tests/agent                      # agent tests
cd web && npm ci && npm start          # Angular dev server, proxies /api to :8080
```

## License

MIT
