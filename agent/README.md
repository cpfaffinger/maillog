# maillog agent

A single Python file (`maillog-agent.py`, stdlib only, Python ≥ 3.9) that runs on every mail host and talks to the maillog server.

* **Log shipping** – tails `/var/log/mail.log` (and optionally `/var/log/fail2ban.log`), survives rotation/truncation/restarts, never loses lines
  (the log file is the buffer; the offset only advances after the server answered `2xx`; the server de-duplicates).
* **Health checks** – `service`, `tcp`, `disk`, `queue` (Postfix mail queue via `postqueue -j`) and `sasl_probe` (functional `saslauthd` test),
  reported every 30 s (also the heartbeat). Failed services are **restarted automatically** (after 2 consecutive failures, max 4 restarts/hour/unit).
* **Self-update** – when the server publishes a new agent file the agent verifies its hash and replaces itself.

Protocol details: [`docs/AGENT-PROTOCOL.md`](../docs/AGENT-PROTOCOL.md).

## Install

Create the agent in the maillog UI (*Agents → Add agent*), then run the shown one-liner on the host:

```bash
curl -fsSL https://maillog.example.com/install.sh | sudo bash -s -- --enroll mle_xxxxxxxx
```

The enrollment token is single use and expires after 24 h; the installer exchanges it for the agent's own token and stores it in
`/etc/maillog-agent.json` (mode 0600). Re-running the installer updates the agent; `--uninstall` removes everything.

Files: `/opt/maillog-agent/maillog-agent.py`, `/etc/maillog-agent.json`, `/var/lib/maillog-agent/state.json`, `maillog-agent.service`.

## Security model

* **Outbound only.** The agent opens HTTPS connections to the server; nothing listens on the host.
* **No server-defined commands.** The server only sends declarative check definitions of a fixed set of types. The agent never executes anything the server sends;
  the commands it runs (`systemctl`, `postqueue -j`, `testsaslauthd`) are hard-coded, always as argument lists, never through a shell.
* **`allowedUnits`.** Auto-recovery (and `enable`) only touches units listed in `allowedUnits` in `/etc/maillog-agent.json`
  (default: postfix, saslauthd, opendkim, fail2ban, dovecot, rspamd, clamav-daemon, unbound). Anything else is refused and reported in the check message.
* **`allowedLogDirs`.** Log paths pushed by the server are only read when they resolve (after symlinks) below one of these directories (default `/var/log`),
  so a compromised server cannot make the agent ship arbitrary files.
* `tcp` checks only connect to the given `host:port` and report whether the banner matched.
* Runs as **root** because it reads `/var/log/mail.log` (group `adm`) and restarts system services via `systemctl`.
* The tokens never appear on a command line or in the logs.

## Tests

```bash
python -m unittest discover -s tests/agent -v
```
