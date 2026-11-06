#!/usr/bin/env bash
# maillog agent installer (served by the maillog server at /install.sh; {{SERVER}} is filled in by the server).
#
#   curl -fsSL {{SERVER}}/install.sh | sudo bash -s -- --enroll mle_xxxxxxxx
#   curl -fsSL {{SERVER}}/install.sh | sudo bash -s -- --uninstall
#
# Idempotent: running it again updates the agent file and the systemd unit. --enroll is only required for the
# first install (or to re-install a host with a freshly issued enrollment token).
set -euo pipefail

SERVER="{{SERVER}}"
INSTALL_DIR="/opt/maillog-agent"
AGENT_FILE="$INSTALL_DIR/maillog-agent.py"
CONFIG_FILE="/etc/maillog-agent.json"
STATE_DIR="/var/lib/maillog-agent"
UNIT_FILE="/etc/systemd/system/maillog-agent.service"

die() { echo "maillog-agent installer: $*" >&2; exit 1; }
info() { echo "==> $*"; }

ENROLL=""
UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --enroll) [ $# -ge 2 ] || die "--enroll needs a token"; ENROLL="$2"; shift 2 ;;
    --enroll=*) ENROLL="${1#--enroll=}"; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,8p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "please run as root (use sudo)"

if [ "$UNINSTALL" -eq 1 ]; then
  info "removing maillog agent"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now maillog-agent.service >/dev/null 2>&1 || true
  fi
  rm -f "$UNIT_FILE" "$CONFIG_FILE"
  rm -rf "$INSTALL_DIR" "$STATE_DIR"
  command -v systemctl >/dev/null 2>&1 && systemctl daemon-reload || true
  info "done"
  exit 0
fi

case "$SERVER" in
  *"{{"*) die "this is the raw template; fetch the installer from your maillog server" ;;
esac

command -v systemctl >/dev/null 2>&1 || die "systemd (systemctl) is required"
command -v curl >/dev/null 2>&1 || die "curl is required"
PYTHON="$(command -v python3 || true)"
[ -n "$PYTHON" ] || die "python3 is required"
"$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' || die "python 3.9 or newer is required"

if [ -z "$ENROLL" ] && [ ! -f "$CONFIG_FILE" ]; then
  die "first install needs an enrollment token: --enroll mle_... (create the agent in the maillog UI)"
fi

# --- agent file ------------------------------------------------------------------------------------------------
info "downloading agent from $SERVER"
install -d -m 755 "$INSTALL_DIR"
TMP="$(mktemp "$INSTALL_DIR/.agent.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
curl -fsSL "$SERVER/agent/maillog-agent.py" -o "$TMP"
"$PYTHON" -c 'import sys; compile(open(sys.argv[1], "rb").read(), "maillog-agent.py", "exec")' "$TMP" \
  || die "downloaded agent file is not valid python"
chmod 755 "$TMP"
mv -f "$TMP" "$AGENT_FILE"
trap - EXIT

# --- enrollment ------------------------------------------------------------------------------------------------
install -d -m 700 "$STATE_DIR"
if [ -n "$ENROLL" ]; then
  info "enrolling this host"
  HOST="$(hostname -f 2>/dev/null || hostname)"
  # token and hostname are passed via the environment, never on a command line
  MAILLOG_ENROLL_TOKEN="$ENROLL" MAILLOG_ENROLL_HOST="$HOST" MAILLOG_SERVER="$SERVER" MAILLOG_CONFIG="$CONFIG_FILE" \
  "$PYTHON" - <<'PY'
import json, os, sys, urllib.error, urllib.request

server = os.environ["MAILLOG_SERVER"].rstrip("/")
body = json.dumps({"token": os.environ["MAILLOG_ENROLL_TOKEN"], "hostname": os.environ["MAILLOG_ENROLL_HOST"]}).encode()
req = urllib.request.Request(server + "/agent-api/v1/enroll", data=body, method="POST",
                             headers={"Content-Type": "application/json", "User-Agent": "maillog-install"})
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        resp = json.loads(r.read().decode())
except urllib.error.HTTPError as e:
    sys.exit("enrollment failed: HTTP %d (token invalid, expired or already used?)" % e.code)
except Exception as e:
    sys.exit("enrollment failed: %s" % e)

token = resp.get("agentToken")
if not token:
    sys.exit("enrollment failed: unexpected server response")

path = os.environ["MAILLOG_CONFIG"]
cfg = {}
try:
    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
except (OSError, ValueError):
    cfg = {}
cfg["server"] = resp.get("server") or server
cfg["token"] = token
cfg.setdefault("backfillBytes", 5000000)
cfg.setdefault("allowedUnits", ["postfix", "saslauthd", "opendkim", "fail2ban", "dovecot", "rspamd", "clamav-daemon", "unbound"])
cfg.setdefault("allowedLogDirs", ["/var/log"])

tmp = path + ".tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)
os.replace(tmp, path)
os.chmod(path, 0o600)
print("enrolled as '%s'" % resp.get("name", "?"))
PY
else
  info "keeping existing enrollment ($CONFIG_FILE)"
fi
chmod 600 "$CONFIG_FILE"

# --- systemd ---------------------------------------------------------------------------------------------------
info "installing systemd unit"
cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=maillog agent (mail log shipping + health checks)
Documentation=$SERVER/api/docs
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$PYTHON $AGENT_FILE
Restart=always
RestartSec=5
User=root
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true

[Install]
WantedBy=multi-user.target
UNIT
chmod 644 "$UNIT_FILE"

systemctl daemon-reload
systemctl enable maillog-agent.service >/dev/null 2>&1
systemctl restart maillog-agent.service
sleep 3

info "status"
systemctl is-active maillog-agent.service || true
journalctl -u maillog-agent.service -n 8 --no-pager 2>/dev/null || true
info "done - the host should appear in the maillog UI within a minute"
