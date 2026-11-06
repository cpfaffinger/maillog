# maillog agent protocol

The agent is a single Python 3 file (`agent/maillog-agent.py`, stdlib only, Python ≥ 3.9) running as root under systemd.
It (1) ships log lines, (2) runs health checks with optional auto-recovery, (3) reports the Postfix queue.
All requests go **from the agent to the server** over HTTPS (`Authorization: Bearer mla_...`), never the other way round.
JSON is camelCase. Request bodies may be gzip-compressed (`Content-Encoding: gzip`).

## Onboarding

1. Admin creates the agent in the UI → server returns a single-use **enrollment token** `mle_...` (valid 24 h) and this command:
   `curl -fsSL https://SERVER/install.sh | sudo bash -s -- --enroll mle_xxx`
2. `GET /install.sh` (public) returns `agent/install.sh.tpl` with `{{SERVER}}` replaced by the server's public base URL. The script (idempotent, needs root, python3, systemd, curl):
   * `--enroll TOKEN` (required for first install; optional when `/etc/maillog-agent.json` already exists), `--uninstall`.
   * downloads `GET /agent/maillog-agent.py` (public) to `/opt/maillog-agent/maillog-agent.py`, verifies `python3 -m py_compile`.
   * calls `POST /agent-api/v1/enroll {token, hostname}` → `{agentToken, name, server}` and writes `/etc/maillog-agent.json` (mode 0600): `{"server":"https://...","token":"mla_...","backfillBytes":5000000,"allowedUnits":[...]}`.
   * installs `/etc/systemd/system/maillog-agent.service` (`Restart=always`, `RestartSec=5`), `daemon-reload`, `enable --now`, prints status + the last log lines. `--uninstall` removes unit, files and state dir.
3. The agent token replaces the enrollment token (single use). Re-issuing an enrollment in the UI is how a host is re-installed.

## Endpoints (`/agent-api/v1`)

### `POST /enroll` (no auth) `{token, hostname}` → `{agentToken, name, server}`   (`400` if token invalid/expired)

### `GET /config` → config
```jsonc
{ "intervalS": 30,
  "agentSha256": "<sha256 hex of the current agent file on the server>",
  "logs":   [ {"path":"/var/log/mail.log","source":"mail"}, {"path":"/var/log/fail2ban.log","source":"fail2ban"} ],
  "checks": [ ...see below... ] }
```

### `POST /ingest`
```jsonc
{ "tzOffsetMinutes": 60, "version": "1.0.0", "hostname": "smtp2",
  "batches": [ { "source": "mail", "lines": ["2026-11-05T21:56:22.607289+01:00 mailout postfix/smtpd[7998]: ...", "..."] } ] }
```
→ `{accepted: n}`. The server de-duplicates lines (hash of source+line), so **at-least-once delivery is fine**.
The log file itself is the buffer: the agent only advances its saved offset after a `2xx`.

### `POST /health` (every `intervalS` seconds, also acts as heartbeat)
```jsonc
{ "version":"1.0.0", "hostname":"smtp2",
  "checks":  [ {"name":"saslauthd","state":"ok|warn|fail","message":"active (running)"} ],
  "metrics": { "queueTotal":34, "queueDeferred":30, "queueActive":2, "queueOldestAgeS":5400,
               "queue": { "ts":.., "total":34, "active":2, "deferred":30, "hold":0, "incoming":2, "oldestAgeS":5400, "oldestActiveAgeS":40,
                          "topSenderDomains":[{"name":"customer-a.example","count":20}],
                          "topRecipientDomains":[{"name":"gmail.com","count":12}],
                          "topReasons":[{"name":"452 4.2.2 mailbox full","count":9}] } },
  "actions": [ {"name":"saslauthd","action":"systemctl restart saslauthd","ok":true,"result":"recovered"} ] }
```
→ the same object as `GET /config` (so config changes and the agent hash arrive with every heartbeat).
`actions` lists auto-recovery steps taken **since the last successful report** (the agent keeps them in memory until a report succeeded).

## Log shipping rules

* Per log path keep `{inode, offset}` in `/var/lib/maillog-agent/state.json` (atomic write: temp file + rename, mode 0600).
* First start (no state): begin at `max(0, size - backfillBytes)` and align to the next line start.
* Only consume complete lines (up to the last `\n`). Batches of ≤ 500 lines / ≤ 256 KB; gzip the body.
* Rotation: if the inode changed, first drain the rest of the previous file (try `path + ".1"` when its inode equals the saved one), then continue at offset 0 of the new file. If size < offset (truncate) restart at 0.
* On any HTTP/network error: keep the offset, back off exponentially (1 s … 60 s), keep trying. Never crash.
* `tzOffsetMinutes` = the host's current local UTC offset in minutes (used for fail2ban timestamps without zone).

## Health checks (declarative, defined centrally by the server per agent)

Common fields: `name` (unique), `type`, optional `every` (seconds, default = `intervalS`). The server never sends shell commands;
the agent only implements these types. **Security rule:** the agent must refuse to restart units that are not in the local `allowedUnits`
list of `/etc/maillog-agent.json` (default `["postfix","saslauthd","opendkim","fail2ban","dovecot","rspamd","clamav-daemon","unbound"]`).

| type | fields | semantics |
|---|---|---|
| `service` | `unit`, `restart?` (bool), `enable?` (bool) | `ok` if `systemctl is-active unit` = active. If `enable` and `is-enabled` ≠ enabled → run `systemctl enable unit` (action recorded, state `warn` until fixed). `fail` otherwise (message includes `systemctl is-active` output) |
| `tcp` | `host`, `port`, `expect?` (regex matched against the first line the server sends), `timeout?` (default 5) | connect (and read banner when `expect` is set; send `QUIT\r\n` if the banner starts with `220`). `fail` when it cannot connect / banner does not match |
| `disk` | `path`, `warn`, `fail` (percent used) | `warn`/`fail` when used% ≥ thresholds |
| `queue` | `warn`, `fail` (message counts), `maxAgeWarnS` | runs `postqueue -j`, computes the Queue object above (also sent as `metrics`). `fail` if total ≥ `fail`; `warn` if total ≥ `warn` or the oldest **active/incoming** message is older than `maxAgeWarnS` (old *deferred* mail, e.g. full recipient mailboxes, never warns by age). Message says e.g. `34 queued (30 deferred), oldest 1h30m` |
| `sasl_probe` | `unit` (default `saslauthd`), `restart?` | runs `testsaslauthd -u maillog-probe-nonexistent -p x -s smtp`. Healthy output starts with `0: NO` (daemon answered, credentials rejected). Any other result (socket missing, connection refused, timeout, command missing) = `fail` |

### Auto-recovery
If a check with `restart: true` is `fail` for **2 consecutive runs**, the agent runs `systemctl enable --now <unit>` when `enable` is set, else `systemctl restart <unit>`,
waits 3 s and re-runs the check immediately. Result:
* check ok afterwards → report state `ok`, message `recovered after restart`, and add an action `{"ok":true}`;
* still failing → state `fail`, message includes the restart result, action `{"ok":false}`.
Limit: at most 4 restarts per unit per hour (persisted in the state file); beyond that report `fail` with `restart limit reached`.
`sasl_probe` recovery restarts `unit` the same way.

## Self-update
Every `/health` response carries `agentSha256`. If it differs from the sha256 of the running file, the agent downloads `GET /agent/maillog-agent.py`,
verifies the hash and `python3 -m py_compile`, atomically replaces itself and exits with status 0 (systemd restarts it). Never update more than once per 10 minutes.

## Misc
* Version constant `AGENT_VERSION` inside the agent file. Logs to stderr/journal, concise.
* Handles `SIGTERM` cleanly (flush state, exit).
* Two worker threads: log shipper (loop every 2 s when idle) and health runner. Neither may kill the other.
* Python ≥ 3.9 compatible (target systems: Debian 12/13, Python 3.11–3.13).

## Additions made during implementation
* `/etc/maillog-agent.json` also has `allowedLogDirs` (default `["/var/log"]`): log paths pushed by the server outside these directories are ignored (a compromised server must not be able to make the root agent ship arbitrary files).
* The agent caches the last server config in its state file and keeps shipping logs / running checks after a restart while the server is unreachable.
* A refused restart (unit not allowed, restart limit reached) is reported in the check message but not as an `actions` entry.
* Queue `ts` is epoch milliseconds; recipient domain counts are per recipient, sender domain counts per message; empty sender is `(null sender)`.
