#!/usr/bin/env python3
"""maillog agent: ships mail logs, runs health checks (with auto-recovery) and reports the Postfix queue.

Stdlib only, Python >= 3.9. Talks to the maillog server exclusively via outbound HTTPS (see docs/AGENT-PROTOCOL.md).
Every external effect (HTTP, subprocesses, clock, sockets, disk usage) goes through the injectable ``Deps`` object.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import logging
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import Counter

AGENT_VERSION = "1.0.0"

CONFIG_PATH = "/etc/maillog-agent.json"
STATE_DIR = "/var/lib/maillog-agent"
API = "/agent-api/v1"

DEFAULT_ALLOWED_UNITS = ["postfix", "saslauthd", "opendkim", "fail2ban", "dovecot", "rspamd", "clamav-daemon", "unbound"]
DEFAULT_ALLOWED_LOG_DIRS = ["/var/log"]
DEFAULT_LOGS = [{"path": "/var/log/mail.log", "source": "mail"}]
DEFAULT_BACKFILL_BYTES = 5_000_000
DEFAULT_INTERVAL_S = 30

MAX_BATCH_LINES = 500
MAX_BATCH_BYTES = 256 * 1024
RESTART_LIMIT = 4
RESTART_WINDOW_S = 3600
UPDATE_MIN_INTERVAL_S = 600
RECOVERY_AFTER_FAILURES = 2

UNIT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:_.@-]*$")
ENABLED_STATES = ("enabled", "enabled-runtime", "static", "alias", "indirect", "generated", "linked")

log = logging.getLogger("maillog-agent")


# --------------------------------------------------------------------------------------------------------------
# injectable effects
# --------------------------------------------------------------------------------------------------------------

def default_http(method, url, body, headers, timeout=20):
    """Returns (status, bytes). HTTP error statuses are returned, network errors raise."""
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read()
        finally:
            e.close()


def default_run(cmd, timeout=10):
    """Runs a command (never through a shell). Returns (returncode, combined output)."""
    env = dict(os.environ, LC_ALL="C")
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, env=env)
        return p.returncode, p.stdout.decode("utf-8", "replace")
    except FileNotFoundError:
        return 127, "command not found: %s" % cmd[0]
    except subprocess.TimeoutExpired:
        return 124, "timeout after %ss" % timeout
    except OSError as e:
        return 126, str(e)


def default_tz_offset_minutes():
    t = time.localtime()
    return int((getattr(t, "tm_gmtoff", 0) or 0) // 60)


class Deps:
    """All side effects in one place, replaced by fakes in the tests."""

    def __init__(self):
        self.time = time.time
        self.sleep = time.sleep
        self.http = default_http
        self.run = default_run
        self.disk_usage = shutil.disk_usage
        self.connect = socket.create_connection
        self.stat = os.stat
        self.hostname = socket.gethostname
        self.tz_offset_minutes = default_tz_offset_minutes


# --------------------------------------------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------------------------------------------

class Backoff:
    """1, 2, 4 ... 60 seconds."""

    def __init__(self, maximum=60):
        self.maximum = maximum
        self.delay = 0

    def fail(self):
        self.delay = 1 if self.delay == 0 else min(self.maximum, self.delay * 2)
        return self.delay

    def reset(self):
        self.delay = 0


def fmt_age(seconds):
    s = int(seconds)
    if s < 60:
        return "%ds" % s
    m = s // 60
    if m < 60:
        return "%dm" % m
    h, m = divmod(m, 60)
    if h < 48:
        return "%dh%02dm" % (h, m) if m else "%dh" % h
    d, h = divmod(h, 24)
    return "%dd%dh" % (d, h)


def short(text, n=160):
    t = " ".join(str(text).split())
    return t if len(t) <= n else t[: n - 1] + "…"


def domain_of(address):
    a = (address or "").strip().strip("<>")
    if "@" not in a:
        return ""
    return a.rsplit("@", 1)[1].lower()


_CODE_RE = re.compile(r"\b([245]\d\d)[ -](?:([245]\.\d{1,3}\.\d{1,3})\b)?")


def normalize_reason(text):
    """Reduces a Postfix delay reason to a short grouping key: SMTP code, enhanced code and ~60 chars of text."""
    t = " ".join(str(text).split())
    t = re.sub(r"https?://\S+", "", t)
    t = re.sub(r"[\w.-]+\[[0-9a-fA-F:.]+\](?::\d+)?", "<host>", t)
    t = re.sub(r"\b\d{1,3}(?:\.\d{1,3}){3}\b", "<ip>", t)
    t = re.sub(r"\b[0-9A-F]{10,}\b", "<id>", t)
    t = re.sub(r"\b[0-9a-z]{8,}-[0-9a-z.]{8,}\b", "", t)
    t = re.sub(r"\s+-\s+gsmtp\b", "", t)
    m = _CODE_RE.search(t)
    if not m:
        return t[:70].strip()
    rest = t[m.end():]
    rest = re.sub(r"\b[245]\d\d[ -][245]\.\d{1,3}\.\d{1,3}\b", "", rest)
    rest = " ".join(rest.split()).strip(" -:")
    rest = rest.split(". ")[0][:60].rstrip(" .,;:-")
    return " ".join(x for x in (m.group(1), m.group(2) or "", rest) if x)


def _top(counter, n=5):
    return [{"name": k, "count": v} for k, v in counter.most_common(n)]


def parse_postqueue(text, now):
    """Builds the Queue object from the output of ``postqueue -j`` (one JSON object per line)."""
    by_queue = Counter()
    senders = Counter()
    rcpts = Counter()
    reasons = Counter()
    oldest = None
    oldest_active = None
    total = 0
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if not isinstance(m, dict):
            continue
        total += 1
        by_queue[str(m.get("queue_name", ""))] += 1
        at = m.get("arrival_time")
        if isinstance(at, (int, float)):
            oldest = at if oldest is None else min(oldest, at)
            # deferred mail (e.g. full mailboxes) legitimately waits for days; only active/incoming mail should move
            if m.get("queue_name") in ("active", "incoming"):
                oldest_active = at if oldest_active is None else min(oldest_active, at)
        senders[domain_of(m.get("sender", "")) or "(null sender)"] += 1
        for r in m.get("recipients") or []:
            if not isinstance(r, dict):
                continue
            d = domain_of(r.get("address", ""))
            if d:
                rcpts[d] += 1
            reason = r.get("delay_reason")
            if reason:
                reasons[normalize_reason(reason)] += 1
    return {
        "ts": int(now * 1000),
        "total": total,
        "active": by_queue["active"],
        "deferred": by_queue["deferred"],
        "hold": by_queue["hold"],
        "incoming": by_queue["incoming"],
        "oldestAgeS": max(0, int(now - oldest)) if oldest is not None else 0,
        "oldestActiveAgeS": max(0, int(now - oldest_active)) if oldest_active is not None else 0,
        "topSenderDomains": _top(senders),
        "topRecipientDomains": _top(rcpts),
        "topReasons": _top(reasons),
    }


def should_update(remote_sha, local_sha, last_update, now):
    return bool(remote_sha) and bool(local_sha) and remote_sha != local_sha and (now - last_update) >= UPDATE_MIN_INTERVAL_S


# --------------------------------------------------------------------------------------------------------------
# state + HTTP client
# --------------------------------------------------------------------------------------------------------------

class State:
    """Persistent agent state (log offsets, restart history, cached config), written atomically."""

    def __init__(self, directory):
        self.dir = directory
        self.path = os.path.join(directory, "state.json")
        self.lock = threading.RLock()
        self.data = {"logs": {}, "restarts": {}, "lastUpdate": 0, "config": None}
        try:
            os.makedirs(directory, mode=0o700, exist_ok=True)
        except OSError as e:
            log.warning("cannot create state dir %s: %s", directory, e)
        self.load()

    def load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                for k in self.data:
                    if k in loaded:
                        self.data[k] = loaded[k]
        except (OSError, ValueError):
            pass

    def save(self):
        with self.lock:
            tmp = self.path + ".tmp"
            try:
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(self.data, f)
                try:
                    os.chmod(tmp, 0o600)
                except OSError:
                    pass
                os.replace(tmp, self.path)
            except OSError as e:
                log.warning("cannot save state: %s", e)


class Client:
    def __init__(self, server, token, deps):
        self.server = server.rstrip("/")
        self.token = token
        self.deps = deps

    def request(self, method, path, obj=None, auth=True, compress=False):
        headers = {"User-Agent": "maillog-agent/" + AGENT_VERSION, "Accept": "application/json"}
        if auth and self.token:
            headers["Authorization"] = "Bearer " + self.token
        body = None
        if obj is not None:
            body = json.dumps(obj, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
            if compress:
                body = gzip.compress(body)
                headers["Content-Encoding"] = "gzip"
        status, data = self.deps.http(method, self.server + path, body, headers)
        parsed = None
        if data:
            try:
                parsed = json.loads(data.decode("utf-8", "replace"))
            except ValueError:
                parsed = None
        return status, parsed


def ok_status(status):
    return 200 <= status < 300


# --------------------------------------------------------------------------------------------------------------
# log shipping
# --------------------------------------------------------------------------------------------------------------

class Batch:
    def __init__(self, lines, state):
        self.lines = lines
        self.state = state


def read_lines(path, offset, final=False):
    """Reads complete lines starting at offset. Returns (lines, new_offset).

    With final=True (draining a rotated file) a trailing line without newline is returned as well.
    """
    with open(path, "rb") as f:
        f.seek(offset)
        data = f.read(MAX_BATCH_BYTES)
    if not data:
        return [], offset
    at_eof = len(data) < MAX_BATCH_BYTES
    if final and at_eof:
        chunk = data
    else:
        cut = data.rfind(b"\n")
        if cut >= 0:
            chunk = data[: cut + 1]
        elif not at_eof:
            chunk = data  # one single overlong line: ship it in pieces rather than stalling
        else:
            return [], offset  # incomplete line, wait for the rest
    pieces = chunk.split(b"\n")
    if chunk.endswith(b"\n"):
        pieces.pop()
    lines = []
    consumed = 0
    taken = 0
    for p in pieces:
        if taken >= MAX_BATCH_LINES:
            break
        taken += 1
        consumed += len(p) + 1
        text = p.decode("utf-8", "replace").rstrip("\r")
        if text.strip():
            lines.append(text)
    consumed = min(consumed, len(chunk))
    return lines, offset + consumed


class LogShipper:
    def __init__(self, client, state, deps, cfg, get_logs):
        self.client = client
        self.state = state
        self.deps = deps
        self.cfg = cfg
        self.get_logs = get_logs
        self.backoff = Backoff()

    def _stat(self, path):
        try:
            return self.deps.stat(path)
        except OSError:
            return None

    def initial_offset(self, path, size):
        backfill = int(self.cfg.get("backfillBytes", DEFAULT_BACKFILL_BYTES))
        start = max(0, size - max(0, backfill))
        if start == 0:
            return 0
        try:
            with open(path, "rb") as f:
                f.seek(start - 1)
                if f.read(1) == b"\n":
                    return start
                rest = f.readline(65536)
            return min(size, start + len(rest))
        except OSError:
            return size

    def next_batch(self, path):
        logs = self.state.data["logs"]
        cur = logs.get(path)
        st = self._stat(path)
        if cur is None:
            if st is None:
                return None
            return Batch([], {"inode": st.st_ino, "offset": self.initial_offset(path, st.st_size)})
        if st is not None and st.st_ino != cur["inode"]:
            old = path + ".1"
            ost = self._stat(old)
            if ost is not None and ost.st_ino == cur["inode"] and ost.st_size > cur["offset"]:
                lines, off = read_lines(old, cur["offset"], final=True)
                if off > cur["offset"]:
                    return Batch(lines, {"inode": cur["inode"], "offset": off})
            return Batch([], {"inode": st.st_ino, "offset": 0})
        if st is None:
            return None
        offset = cur["offset"]
        if st.st_size < offset:
            return Batch([], {"inode": st.st_ino, "offset": 0})  # truncated
        if st.st_size == offset:
            return None
        lines, off = read_lines(path, offset)
        if off == offset:
            return None
        return Batch(lines, {"inode": cur["inode"], "offset": off})

    def post(self, source, lines):
        body = {
            "tzOffsetMinutes": self.deps.tz_offset_minutes(),
            "version": AGENT_VERSION,
            "hostname": self.deps.hostname(),
            "batches": [{"source": source, "lines": lines}],
        }
        try:
            status, _ = self.client.request("POST", API + "/ingest", body, compress=True)
        except Exception as e:  # network errors are routine
            log.warning("ingest failed: %s", short(e))
            return False
        if ok_status(status):
            return True
        log.warning("ingest rejected: HTTP %s", status)
        return False

    def cycle(self):
        """Ships everything currently available. Returns ('progress'|'idle'|'error', delay_seconds)."""
        progress = False
        for lg in self.get_logs():
            path, source = lg["path"], lg.get("source", "mail")
            for _ in range(100000):
                batch = self.next_batch(path)
                if batch is None:
                    break
                if batch.lines:
                    if not self.post(source, batch.lines):
                        return "error", self.backoff.fail()
                    progress = True
                elif batch.state == self.state.data["logs"].get(path):
                    break
                with self.state.lock:
                    self.state.data["logs"][path] = batch.state
                    self.state.save()
        self.backoff.reset()
        return ("progress" if progress else "idle"), 0


# --------------------------------------------------------------------------------------------------------------
# health checks
# --------------------------------------------------------------------------------------------------------------

class CheckRunner:
    def __init__(self, deps, state, allowed_units):
        self.deps = deps
        self.state = state
        self.allowed = set(allowed_units)
        self.fail_counts = {}
        self.last_run = {}
        self.last = {}
        self.pending_actions = []
        self.queue = None
        self.types = {
            "service": self._check_service,
            "tcp": self._check_tcp,
            "disk": self._check_disk,
            "queue": self._check_queue,
            "sasl_probe": self._check_sasl_probe,
        }

    # -- scheduling -------------------------------------------------------------------------------------------

    def run_all(self, checks, interval):
        now = self.deps.time()
        results = []
        names = set()
        for c in checks or []:
            if not isinstance(c, dict) or not c.get("name") or not c.get("type"):
                log.warning("ignoring invalid check definition")
                continue
            name = str(c["name"])
            if name in names:
                continue
            names.add(name)
            every = int(c.get("every") or interval)
            if name in self.last and now - self.last_run.get(name, 0) < every - 1:
                results.append(self.last[name])
                continue
            try:
                state, message = self.run_one(c, name)
            except Exception as e:  # a broken check must never take the agent down
                log.exception("check %s crashed", name)
                state, message = "fail", "check crashed: %s" % short(e)
            self.last_run[name] = now
            self.last[name] = {"name": name, "state": state, "message": short(message, 400)}
            results.append(self.last[name])
        for stale in [n for n in self.last if n not in names]:
            self.last.pop(stale, None)
            self.last_run.pop(stale, None)
            self.fail_counts.pop(stale, None)
        return results

    def run_one(self, c, name):
        state, message = self.evaluate(c)
        if state == "fail":
            n = self.fail_counts[name] = self.fail_counts.get(name, 0) + 1
            if c.get("restart") and c.get("unit") and n >= RECOVERY_AFTER_FAILURES:
                state, message = self.recover(c, name, message)
                if state == "ok":
                    self.fail_counts[name] = 0
        else:
            self.fail_counts[name] = 0
        return state, message

    def evaluate(self, c):
        fn = self.types.get(str(c.get("type")))
        if fn is None:
            return "warn", "unknown check type %s" % short(c.get("type"), 40)
        return fn(c)

    # -- recovery ---------------------------------------------------------------------------------------------

    def recover(self, c, name, original):
        unit = str(c["unit"])
        if not UNIT_RE.match(unit) or unit not in self.allowed:
            log.warning("refusing to restart %s: not in allowedUnits", unit)
            return "fail", "%s; refusing to restart %s: not in allowedUnits" % (original, unit)
        now = self.deps.time()
        history = [t for t in self.state.data["restarts"].get(unit, []) if now - t < RESTART_WINDOW_S]
        if len(history) >= RESTART_LIMIT:
            self.state.data["restarts"][unit] = history
            return "fail", "%s; restart limit reached (%d/h)" % (original, RESTART_LIMIT)
        cmd = ["systemctl", "enable", "--now", unit] if c.get("enable") else ["systemctl", "restart", unit]
        rc, out = self.deps.run(cmd, 60)
        history.append(now)
        self.state.data["restarts"][unit] = history
        self.state.save()
        log.warning("auto-recovery for %s: %s (rc=%s)", name, " ".join(cmd), rc)
        self.deps.sleep(3)
        state, message = self.evaluate(c)
        if state == "ok":
            self.pending_actions.append({"name": name, "action": " ".join(cmd), "ok": True, "result": "recovered"})
            return "ok", "recovered after restart"
        detail = "rc=%s %s" % (rc, short(out, 120))
        self.pending_actions.append({"name": name, "action": " ".join(cmd), "ok": False, "result": detail})
        return "fail", "%s; restart did not help (%s)" % (message, detail)

    # -- check types ------------------------------------------------------------------------------------------

    def _check_service(self, c):
        unit = str(c.get("unit", ""))
        if not UNIT_RE.match(unit):
            return "fail", "invalid unit name"
        rc, out = self.deps.run(["systemctl", "is-active", unit])
        status = out.strip().splitlines()[0] if out.strip() else "unknown"
        if rc != 0 or status != "active":
            return "fail", "%s is %s" % (unit, status)
        if c.get("enable"):
            rc, out = self.deps.run(["systemctl", "is-enabled", unit])
            enabled = out.strip().splitlines()[0] if out.strip() else ""
            if enabled not in ENABLED_STATES:
                if unit not in self.allowed:
                    return "warn", "%s is active but not enabled (unit not in allowedUnits)" % unit
                cmd = ["systemctl", "enable", unit]
                rc, out = self.deps.run(cmd)
                self.pending_actions.append({"name": str(c.get("name")), "action": " ".join(cmd), "ok": rc == 0,
                                             "result": "enabled" if rc == 0 else short(out, 120)})
                if rc != 0:
                    return "warn", "%s is active but not enabled (enable failed: %s)" % (unit, short(out, 80))
                return "ok", "%s active; was not enabled, enabled now" % unit
        return "ok", "%s active" % unit

    def _check_tcp(self, c):
        host = str(c.get("host", "127.0.0.1"))
        try:
            port = int(c.get("port"))
        except (TypeError, ValueError):
            return "fail", "invalid port"
        timeout = float(c.get("timeout", 5))
        target = "%s:%s" % (host, port)
        try:
            sock = self.deps.connect((host, port), timeout)
        except Exception as e:
            return "fail", "%s %s" % (target, short(e, 100))
        try:
            expect = c.get("expect")
            if not expect:
                return "ok", "%s connected" % target
            try:
                pattern = re.compile(expect)
            except re.error:
                return "fail", "invalid expect regex"
            try:
                settimeout = getattr(sock, "settimeout", None)
                if settimeout:
                    settimeout(timeout)
                line = self._recv_line(sock)
            except Exception as e:
                return "fail", "%s no banner (%s)" % (target, short(e, 80))
            if not pattern.search(line):
                return "fail", "%s unexpected banner: %s" % (target, short(line, 80))
            if line.startswith("220"):
                try:
                    sock.sendall(b"QUIT\r\n")
                except Exception:
                    pass
            return "ok", "%s banner ok" % target
        finally:
            try:
                sock.close()
            except Exception:
                pass

    @staticmethod
    def _recv_line(sock):
        buf = b""
        while b"\n" not in buf and len(buf) < 512:
            part = sock.recv(512)
            if not part:
                break
            buf += part
        return buf.split(b"\n", 1)[0].decode("utf-8", "replace").strip()

    def _check_disk(self, c):
        path = str(c.get("path", "/"))
        warn, fail = float(c.get("warn", 85)), float(c.get("fail", 95))
        try:
            usage = self.deps.disk_usage(path)
        except OSError as e:
            return "fail", "%s: %s" % (path, short(e, 80))
        denom = usage.used + usage.free
        pct = 100.0 * usage.used / denom if denom else 0.0
        message = "%s %.0f%% used" % (path, pct)
        if pct >= fail:
            return "fail", message
        if pct >= warn:
            return "warn", message
        return "ok", message

    def _check_queue(self, c):
        rc, out = self.deps.run(["postqueue", "-j"], 30)
        if rc != 0:
            return "fail", "postqueue failed: %s" % short(out, 100)
        q = parse_postqueue(out, self.deps.time())
        self.queue = q
        warn, fail = int(c.get("warn", 500)), int(c.get("fail", 5000))
        max_age = int(c.get("maxAgeWarnS", 3600))
        if q["total"] == 0:
            return "ok", "queue empty"
        message = "%d queued (%d deferred), oldest %s" % (q["total"], q["deferred"], fmt_age(q["oldestAgeS"]))
        if q["total"] >= fail:
            return "fail", message
        if q["total"] >= warn or q["oldestActiveAgeS"] >= max_age:
            return "warn", message
        return "ok", message

    def _check_sasl_probe(self, c):
        rc, out = self.deps.run(["testsaslauthd", "-u", "maillog-probe-nonexistent", "-p", "x", "-s", "smtp"], 10)
        if rc == 127:
            return "fail", "testsaslauthd not installed"
        if out.lstrip().startswith("0: NO"):
            return "ok", "saslauthd answers (credentials rejected as expected)"
        return "fail", "saslauthd probe failed: %s" % (short(out, 120) or "no output (rc=%s)" % rc)


# --------------------------------------------------------------------------------------------------------------
# agent
# --------------------------------------------------------------------------------------------------------------

def load_config(path):
    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict) or not cfg.get("server") or not cfg.get("token"):
        raise ValueError("config needs 'server' and 'token'")
    cfg.setdefault("allowedUnits", list(DEFAULT_ALLOWED_UNITS))
    cfg.setdefault("allowedLogDirs", list(DEFAULT_ALLOWED_LOG_DIRS))
    cfg.setdefault("backfillBytes", DEFAULT_BACKFILL_BYTES)
    return cfg


class Agent:
    def __init__(self, cfg, deps=None, state_dir=STATE_DIR, script_path=None):
        self.cfg = cfg
        self.deps = deps or Deps()
        self.state = State(state_dir)
        self.client = Client(cfg["server"], cfg["token"], self.deps)
        self.stop = threading.Event()
        self.exit_code = 0
        self.script_path = script_path if script_path is not None else os.path.abspath(__file__)
        self.local_sha = self._file_sha(self.script_path)
        self.config_lock = threading.Lock()
        self.remote = {"intervalS": DEFAULT_INTERVAL_S, "logs": list(DEFAULT_LOGS), "checks": []}
        cached = self.state.data.get("config")
        if isinstance(cached, dict):
            self._set_remote(cached)
        self.shipper = LogShipper(self.client, self.state, self.deps, cfg, self.get_logs)
        self.runner = CheckRunner(self.deps, self.state, cfg.get("allowedUnits", DEFAULT_ALLOWED_UNITS))

    # -- config -----------------------------------------------------------------------------------------------

    @staticmethod
    def _file_sha(path):
        try:
            with open(path, "rb") as f:
                return hashlib.sha256(f.read()).hexdigest()
        except OSError:
            return ""

    def _log_allowed(self, path):
        real = os.path.realpath(path)
        for d in self.cfg.get("allowedLogDirs", DEFAULT_ALLOWED_LOG_DIRS):
            root = os.path.realpath(d)
            if real == root or real.startswith(root.rstrip(os.sep) + os.sep):
                return True
        return False

    def _set_remote(self, conf):
        logs = []
        for lg in conf.get("logs") or []:
            if not isinstance(lg, dict) or not isinstance(lg.get("path"), str):
                continue
            if not self._log_allowed(lg["path"]):
                log.warning("ignoring log path outside allowedLogDirs: %s", lg["path"])
                continue
            source = lg.get("source") if lg.get("source") in ("mail", "fail2ban") else "mail"
            logs.append({"path": lg["path"], "source": source})
        try:
            interval = max(5, int(conf.get("intervalS") or DEFAULT_INTERVAL_S))
        except (TypeError, ValueError):
            interval = DEFAULT_INTERVAL_S
        checks = [c for c in (conf.get("checks") or []) if isinstance(c, dict)]
        with self.config_lock:
            self.remote = {"intervalS": interval, "logs": logs, "checks": checks}

    def apply_config(self, conf):
        if not isinstance(conf, dict):
            return
        self._set_remote(conf)
        with self.state.lock:
            self.state.data["config"] = {k: conf.get(k) for k in ("intervalS", "logs", "checks")}
            self.state.save()

    def get_logs(self):
        with self.config_lock:
            return list(self.remote["logs"])

    def interval(self):
        with self.config_lock:
            return self.remote["intervalS"]

    def fetch_config(self):
        try:
            status, conf = self.client.request("GET", API + "/config")
        except Exception as e:
            log.warning("cannot fetch config: %s", short(e))
            return False
        if ok_status(status) and isinstance(conf, dict):
            self.apply_config(conf)
            return True
        log.warning("config request rejected: HTTP %s", status)
        return False

    # -- cycles -----------------------------------------------------------------------------------------------

    def ship_cycle(self):
        return self.shipper.cycle()

    def health_cycle(self):
        with self.config_lock:
            checks = list(self.remote["checks"])
        results = self.runner.run_all(checks, self.interval())
        actions = list(self.runner.pending_actions)
        report = {
            "version": AGENT_VERSION,
            "hostname": self.deps.hostname(),
            "checks": results,
            "actions": actions,
        }
        q = self.runner.queue
        if q is not None:
            report["metrics"] = {
                "queueTotal": q["total"], "queueDeferred": q["deferred"], "queueActive": q["active"],
                "queueOldestAgeS": q["oldestAgeS"], "queue": q,
            }
        try:
            status, resp = self.client.request("POST", API + "/health", report)
        except Exception as e:
            log.warning("health report failed: %s", short(e))
            return False
        if not ok_status(status):
            log.warning("health report rejected: HTTP %s", status)
            return False
        del self.runner.pending_actions[: len(actions)]
        if isinstance(resp, dict):
            self.apply_config(resp)
            self.maybe_update(resp.get("agentSha256"))
        return True

    # -- self update ------------------------------------------------------------------------------------------

    def maybe_update(self, remote_sha):
        now = self.deps.time()
        if not should_update(remote_sha, self.local_sha, self.state.data.get("lastUpdate", 0), now):
            return False
        with self.state.lock:
            self.state.data["lastUpdate"] = now
            self.state.save()
        try:
            status, data = self.deps.http("GET", self.client.server + "/agent/maillog-agent.py",
                                          None, {"User-Agent": "maillog-agent/" + AGENT_VERSION})
        except Exception as e:
            log.warning("update download failed: %s", short(e))
            return False
        if not ok_status(status) or not data:
            log.warning("update download rejected: HTTP %s", status)
            return False
        sha = hashlib.sha256(data).hexdigest()
        if sha != remote_sha:
            log.warning("update hash mismatch, ignoring")
            return False
        try:
            compile(data, "maillog-agent.py", "exec")
        except (SyntaxError, ValueError) as e:
            log.warning("update does not compile: %s", e)
            return False
        tmp = self.script_path + ".new"
        try:
            with open(tmp, "wb") as f:
                f.write(data)
            try:
                os.chmod(tmp, 0o755)
            except OSError:
                pass
            os.replace(tmp, self.script_path)
        except OSError as e:
            log.warning("cannot write update: %s", e)
            return False
        log.info("updated agent to %s, restarting", sha[:12])
        self.local_sha = sha
        self.exit_code = 0
        self.stop.set()
        return True

    # -- thread loops -----------------------------------------------------------------------------------------

    def log_loop(self):
        while not self.stop.is_set():
            delay = 2
            try:
                result, wait = self.ship_cycle()
                if result == "progress":
                    continue
                if result == "error":
                    delay = max(1, wait)
            except Exception:
                log.exception("log shipper crashed, continuing")
                delay = 5
            self.stop.wait(delay)

    def health_loop(self):
        while not self.stop.is_set():
            try:
                self.health_cycle()
            except Exception:
                log.exception("health runner crashed, continuing")
            self.stop.wait(self.interval())

    def run(self):
        if not self.fetch_config():
            log.info("using cached/default config until the server is reachable")
        threads = [threading.Thread(target=self.log_loop, name="logs", daemon=True),
                   threading.Thread(target=self.health_loop, name="health", daemon=True)]
        for t in threads:
            t.start()
        while not self.stop.wait(1):
            pass
        for t in threads:
            t.join(timeout=5)
        self.state.save()
        return self.exit_code


def main(argv=None):
    ap = argparse.ArgumentParser(description="maillog agent")
    ap.add_argument("--config", default=CONFIG_PATH)
    ap.add_argument("--state-dir", default=STATE_DIR)
    ap.add_argument("--version", action="store_true")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args(argv)
    if args.version:
        print(AGENT_VERSION)
        return 0
    logging.basicConfig(stream=sys.stderr, level=logging.DEBUG if args.debug else logging.INFO,
                        format="%(levelname)s %(message)s")
    try:
        cfg = load_config(args.config)
    except (OSError, ValueError) as e:
        log.error("cannot read config %s: %s", args.config, e)
        return 2
    agent = Agent(cfg, state_dir=args.state_dir)
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: agent.stop.set())
    log.info("maillog-agent %s starting, server %s", AGENT_VERSION, cfg["server"])
    return agent.run()


if __name__ == "__main__":
    sys.exit(main())
