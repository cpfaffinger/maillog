"""Tests for agent/maillog-agent.py. Run: python -m unittest discover -s tests/agent -v

Log shipping and the health/update cycles run against a real local HTTP server (fake maillog server);
subprocesses, clock, sockets and disk usage are injected through ``Deps``.
"""
import gzip
import hashlib
import http.server
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from collections import namedtuple
from contextlib import redirect_stdout

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
AGENT_PATH = os.path.join(ROOT, "agent", "maillog-agent.py")

_spec = importlib.util.spec_from_file_location("maillog_agent", AGENT_PATH)
mod = importlib.util.module_from_spec(_spec)
sys.modules["maillog_agent"] = mod
_spec.loader.exec_module(mod)

TOKEN = "mla_testtoken"
DiskUsage = namedtuple("DiskUsage", "total used free")

SAMPLE_QUEUE = "\n".join([
    json.dumps({"queue_name": "deferred", "queue_id": "6C4055FC24", "arrival_time": 1730000000, "message_size": 1234,
                "sender": "noreply@customer-a.example",
                "recipients": [{"address": "x@gmail.com",
                                "delay_reason": "host alt1.gmail-smtp-in.l.google.com[1.2.3.4] said: 452-4.2.2 "
                                                "The recipient's inbox is out of storage space"}]}),
    json.dumps({"queue_name": "deferred", "queue_id": "7D4055FC25", "arrival_time": 1730000500, "message_size": 99,
                "sender": "noreply@customer-a.example",
                "recipients": [{"address": "y@gmail.com",
                                "delay_reason": "host alt2.gmail-smtp-in.l.google.com[5.6.7.8] said: 452-4.2.2 "
                                                "The recipient's inbox is out of storage space"},
                               {"address": "z@t-online.de", "delay_reason": "connect to mx01.t-online.de[194.25.134.72]:25: Connection timed out"}]}),
    json.dumps({"queue_name": "active", "queue_id": "8E4055FC26", "arrival_time": 1730000900, "message_size": 5,
                "sender": "no-reply@customer-c.example", "recipients": [{"address": "a@gmx.at"}]}),
])
NOW = 1730003600.0


# ------------------------------------------------------------------------------------------------------------
# fakes
# ------------------------------------------------------------------------------------------------------------

class FakeServer:
    """Minimal maillog server: enroll / config / ingest / health / agent file."""

    def __init__(self):
        self.ingest = []
        self.ingest_headers = []
        self.health = []
        self.fail_ingest = 0
        self.fail_health = 0
        self.config = {"intervalS": 30, "logs": [], "checks": []}
        self.script = b"print('server version')\n"
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, obj=None, raw=None):
                data = raw if raw is not None else json.dumps(obj if obj is not None else {}).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _body(self):
                n = int(self.headers.get("Content-Length") or 0)
                data = self.rfile.read(n)
                if self.headers.get("Content-Encoding") == "gzip":
                    data = gzip.decompress(data)
                return json.loads(data.decode()) if data else None

            def _authed(self):
                return self.headers.get("Authorization") == "Bearer " + TOKEN

            def do_GET(self):
                if self.path == "/agent/maillog-agent.py":
                    return self._send(200, raw=outer.script)
                if self.path == "/agent-api/v1/config":
                    if not self._authed():
                        return self._send(401)
                    return self._send(200, outer.full_config())
                self._send(404)

            def do_POST(self):
                body = self._body()
                if self.path == "/agent-api/v1/enroll":
                    if body and body.get("token") == "mle_good":
                        return self._send(200, {"agentToken": TOKEN, "name": "smtp2", "server": outer.url})
                    return self._send(400, {"error": "invalid"})
                if not self._authed():
                    return self._send(401)
                if self.path == "/agent-api/v1/ingest":
                    outer.ingest_headers.append(dict(self.headers))
                    if outer.fail_ingest > 0:
                        outer.fail_ingest -= 1
                        return self._send(500)
                    outer.ingest.append(body)
                    return self._send(200, {"accepted": sum(len(b["lines"]) for b in body["batches"])})
                if self.path == "/agent-api/v1/health":
                    if outer.fail_health > 0:
                        outer.fail_health -= 1
                        return self._send(500)
                    outer.health.append(body)
                    return self._send(200, outer.full_config())
                self._send(404)

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d" % self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def full_config(self):
        c = dict(self.config)
        c.setdefault("agentSha256", hashlib.sha256(self.script).hexdigest())
        return c

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def lines(self, source=None):
        out = []
        for body in self.ingest:
            for b in body["batches"]:
                if source is None or b["source"] == source:
                    out.extend(b["lines"])
        return out


class FakeDeps(mod.Deps):
    """Real HTTP, everything else fake."""

    def __init__(self):
        super().__init__()
        self.now = 1730000000.0
        self.time = lambda: self.now
        self.sleeps = []
        self.sleep = lambda s: self.sleeps.append(s)
        self.commands = []
        self.run_handler = lambda cmd: (0, "")
        self.run = self._run
        self.hostname = lambda: "testhost"
        self.tz_offset_minutes = lambda: 60
        self.disk_usage = lambda path: DiskUsage(100, 50, 50)

    def _run(self, cmd, timeout=10):
        self.commands.append(list(cmd))
        return self.run_handler(cmd)

    def ran(self, *prefix):
        return [c for c in self.commands if c[: len(prefix)] == list(prefix)]


class FakeSock:
    def __init__(self, banner=b""):
        self.banner = banner
        self.sent = []
        self.closed = False

    def settimeout(self, t):
        pass

    def recv(self, n):
        b, self.banner = self.banner, b""
        return b

    def sendall(self, d):
        self.sent.append(d)

    def close(self):
        self.closed = True


class TmpCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="maillog-agent-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.state_dir = os.path.join(self.tmp, "state")

    def path(self, *p):
        return os.path.join(self.tmp, *p)


class AgentCase(TmpCase):
    def setUp(self):
        super().setUp()
        self.server = FakeServer()
        self.addCleanup(self.server.stop)
        self.script = self.path("agent.py")
        with open(self.script, "wb") as f:
            f.write(b"print('old version')\n")

    def make_agent(self, deps=None, **cfg_extra):
        cfg = {"server": self.server.url, "token": TOKEN, "backfillBytes": 5_000_000,
               "allowedUnits": ["postfix", "saslauthd"], "allowedLogDirs": [self.tmp]}
        cfg.update(cfg_extra)
        agent = mod.Agent(cfg, deps=deps or FakeDeps(), state_dir=self.state_dir, script_path=self.script)
        return agent

    def use_logs(self, agent, *logs):
        agent.apply_config({"intervalS": 30, "logs": [{"path": p, "source": s} for p, s in logs], "checks": []})


def write(path, text, mode="w"):
    with open(path, mode, newline="") as f:
        f.write(text)


# ------------------------------------------------------------------------------------------------------------
# queue parsing
# ------------------------------------------------------------------------------------------------------------

class QueueParsingTests(unittest.TestCase):
    def test_sample(self):
        q = mod.parse_postqueue(SAMPLE_QUEUE, NOW)
        self.assertEqual(q["total"], 3)
        self.assertEqual(q["deferred"], 2)
        self.assertEqual(q["active"], 1)
        self.assertEqual(q["hold"], 0)
        self.assertEqual(q["incoming"], 0)
        self.assertEqual(q["oldestAgeS"], 3600)
        self.assertEqual(q["ts"], int(NOW * 1000))
        self.assertEqual(q["topSenderDomains"][0], {"name": "customer-a.example", "count": 2})
        self.assertEqual(q["topRecipientDomains"][0], {"name": "gmail.com", "count": 2})
        self.assertEqual(q["topReasons"][0],
                         {"name": "452 4.2.2 The recipient's inbox is out of storage space", "count": 2})
        names = [r["name"] for r in q["topReasons"]]
        self.assertIn("connect to <host>: Connection timed out", names)

    def test_empty_and_garbage(self):
        q = mod.parse_postqueue("Mail queue is empty\nnot json\n{broken\n[1,2]\n", NOW)
        self.assertEqual(q["total"], 0)
        self.assertEqual(q["oldestAgeS"], 0)
        self.assertEqual(q["topReasons"], [])

    def test_top5_limit_and_order(self):
        lines = []
        for i in range(7):
            for _ in range(i + 1):
                lines.append(json.dumps({"queue_name": "deferred", "arrival_time": 1730000000, "sender": "a@s%d.at" % i,
                                         "recipients": [{"address": "r@d%d.com" % i, "delay_reason": "450 4.1.1 reason %d" % i}]}))
        q = mod.parse_postqueue("\n".join(lines), NOW)
        self.assertEqual(len(q["topRecipientDomains"]), 5)
        self.assertEqual(q["topRecipientDomains"][0], {"name": "d6.com", "count": 7})
        self.assertEqual(len(q["topSenderDomains"]), 5)
        self.assertEqual(len(q["topReasons"]), 5)

    def test_null_sender(self):
        q = mod.parse_postqueue(json.dumps({"queue_name": "deferred", "arrival_time": 1, "sender": "",
                                            "recipients": [{"address": "a@b.at"}]}), NOW)
        self.assertEqual(q["topSenderDomains"][0]["name"], "(null sender)")

    def test_normalize_reason(self):
        n = mod.normalize_reason
        self.assertEqual(
            n("host alt1.gmail-smtp-in.l.google.com[142.250.147.26] said: 452-4.2.2 The recipient's inbox is out of "
              "storage space. Please direct the 452-4.2.2 recipient to 452 4.2.2  https://support.google.com/mail/?p=OverQuotaTemp "
              "4fb4d7f45d1cf-6b5028af3cesi937100a12.6 - gsmtp (in reply to RCPT TO command)"),
            "452 4.2.2 The recipient's inbox is out of storage space")
        self.assertEqual(n("host mx2.mxfilter.net[23.172.136.2] said: 550 User unknown (in reply to RCPT TO command)"),
                         "550 User unknown (in reply to RCPT TO command)")
        self.assertEqual(n("connect to mx11.zoznam.sk[213.81.185.26]:25: Connection timed out"),
                         "connect to <host>: Connection timed out")
        # same reason from different hosts/IPs/queue ids groups together
        a = n("host a.example.com[1.1.1.1] said: 451 4.7.1 Greylisted, try again 6C4055FC24")
        b = n("host b.example.com[2.2.2.2] said: 451 4.7.1 Greylisted, try again 7D4055FC99")
        self.assertEqual(a, b)

    def test_age_format(self):
        self.assertEqual(mod.fmt_age(30), "30s")
        self.assertEqual(mod.fmt_age(90 * 60), "1h30m")
        self.assertEqual(mod.fmt_age(45 * 60), "45m")
        self.assertEqual(mod.fmt_age(3 * 86400 + 4 * 3600), "3d4h")


# ------------------------------------------------------------------------------------------------------------
# log shipping
# ------------------------------------------------------------------------------------------------------------

class LogShippingTests(AgentCase):
    def setUp(self):
        super().setUp()
        self.log = self.path("mail.log")

    def test_partial_line_waits_for_newline(self):
        write(self.log, "a\nb\nc")
        agent = self.make_agent(backfillBytes=1_000_000)
        self.use_logs(agent, (self.log, "mail"))
        self.assertEqual(agent.ship_cycle()[0], "progress")
        self.assertEqual(self.server.lines(), ["a", "b"])
        self.assertEqual(agent.ship_cycle()[0], "idle")
        write(self.log, "\nd\n", "a")
        self.assertEqual(agent.ship_cycle()[0], "progress")
        self.assertEqual(self.server.lines(), ["a", "b", "c", "d"])

    def test_crlf_and_blank_lines_are_cleaned(self):
        write(self.log, "x\r\n\r\ny\r\n")
        agent = self.make_agent()
        self.use_logs(agent, (self.log, "mail"))
        agent.ship_cycle()
        self.assertEqual(self.server.lines(), ["x", "y"])

    def test_first_start_backfill_aligns_to_line_start(self):
        write(self.log, "".join("line-%02d\n" % i for i in range(20)))  # 8 bytes per line, 160 bytes
        for backfill, expected in [(20, ["line-18", "line-19"]),   # lands mid-line -> skip partial line
                                   (16, ["line-18", "line-19"]),   # lands exactly on a line start
                                   (10 ** 9, ["line-%02d" % i for i in range(20)]),
                                   (0, [])]:
            with self.subTest(backfill=backfill):
                shutil.rmtree(self.state_dir, True)
                self.server.ingest.clear()
                agent = self.make_agent(backfillBytes=backfill)
                self.use_logs(agent, (self.log, "mail"))
                agent.ship_cycle()
                self.assertEqual(self.server.lines(), expected)

    def test_backfill_zero_ships_only_new_lines(self):
        write(self.log, "old\n")
        agent = self.make_agent(backfillBytes=0)
        self.use_logs(agent, (self.log, "mail"))
        agent.ship_cycle()
        write(self.log, "new\n", "a")
        agent.ship_cycle()
        self.assertEqual(self.server.lines(), ["new"])

    def test_resume_after_restart_without_duplicates(self):
        write(self.log, "1\n2\n")
        agent = self.make_agent()
        self.use_logs(agent, (self.log, "mail"))
        agent.ship_cycle()
        write(self.log, "3\n", "a")
        agent2 = self.make_agent()  # new process, same state dir
        self.use_logs(agent2, (self.log, "mail"))
        agent2.ship_cycle()
        self.assertEqual(self.server.lines(), ["1", "2", "3"])

    def test_state_file_is_valid_json(self):
        write(self.log, "1\n")
        agent = self.make_agent()
        self.use_logs(agent, (self.log, "mail"))
        agent.ship_cycle()
        with open(os.path.join(self.state_dir, "state.json")) as f:
            data = json.load(f)
        self.assertIn(self.log, data["logs"])
        self.assertEqual(data["logs"][self.log]["offset"], 2)
        self.assertFalse(os.path.exists(os.path.join(self.state_dir, "state.json.tmp")))

    def test_rotation_drains_old_file_first(self):
        write(self.log, "a1\na2\n")
        agent = self.make_agent()
        self.use_logs(agent, (self.log, "mail"))
        agent.ship_cycle()
        write(self.log, "a3\na4 no newline", "a")      # unshipped tail, last line unterminated
        os.rename(self.log, self.log + ".1")            # logrotate
        write(self.log, "b1\nb2\n")
        agent.ship_cycle()
        self.assertEqual(self.server.lines(), ["a1", "a2", "a3", "a4 no newline", "b1", "b2"])
        agent.ship_cycle()
        self.assertEqual(len(self.server.lines()), 6)

    def test_rotation_without_old_file_continues_with_new(self):
        write(self.log, "a1\n")
        agent = self.make_agent()
        self.use_logs(agent, (self.log, "mail"))
        agent.ship_cycle()
        os.remove(self.log)
        write(self.log, "b1\n")
        agent.ship_cycle()
        self.assertEqual(self.server.lines(), ["a1", "b1"])

    def test_truncation_restarts_at_zero(self):
        write(self.log, "long line one\nlong line two\n")
        agent = self.make_agent()
        self.use_logs(agent, (self.log, "mail"))
        agent.ship_cycle()
        write(self.log, "n1\n")                          # truncate + rewrite, same inode, smaller
        agent.ship_cycle()
        self.assertEqual(self.server.lines(), ["long line one", "long line two", "n1"])

    def test_retry_with_backoff_keeps_offset_and_does_not_lose_lines(self):
        write(self.log, "1\n2\n3\n")
        agent = self.make_agent()
        self.use_logs(agent, (self.log, "mail"))
        self.server.fail_ingest = 2
        self.assertEqual(agent.ship_cycle(), ("error", 1))
        self.assertEqual(agent.ship_cycle(), ("error", 2))
        self.assertEqual(self.server.lines(), [])
        self.assertEqual(agent.ship_cycle(), ("progress", 0))
        self.assertEqual(self.server.lines(), ["1", "2", "3"])
        self.assertEqual(agent.shipper.backoff.delay, 0)

    def test_backoff_caps_at_60(self):
        b = mod.Backoff()
        self.assertEqual([b.fail() for _ in range(8)], [1, 2, 4, 8, 16, 32, 60, 60])
        b.reset()
        self.assertEqual(b.fail(), 1)

    def test_network_error_is_survived(self):
        write(self.log, "1\n")
        agent = self.make_agent()
        self.use_logs(agent, (self.log, "mail"))
        self.server.stop()
        result, delay = agent.ship_cycle()
        self.assertEqual((result, delay), ("error", 1))
        # offset still unset -> nothing lost; a new server on the same port is not needed for this assertion
        self.assertEqual(agent.state.data["logs"][self.log]["offset"], 0)

    def test_gzip_body_and_batching(self):
        write(self.log, "".join("line %d\n" % i for i in range(1200)))
        agent = self.make_agent()
        self.use_logs(agent, (self.log, "mail"))
        agent.ship_cycle()
        self.assertEqual([len(b["batches"][0]["lines"]) for b in self.server.ingest], [500, 500, 200])
        self.assertTrue(all(h.get("Content-Encoding") == "gzip" for h in self.server.ingest_headers))
        first = self.server.ingest[0]
        self.assertEqual(first["tzOffsetMinutes"], 60)
        self.assertEqual(first["hostname"], "testhost")
        self.assertEqual(first["version"], mod.AGENT_VERSION)
        self.assertTrue(self.server.ingest_headers[0]["Authorization"].startswith("Bearer "))
        self.assertEqual(self.server.lines(), ["line %d" % i for i in range(1200)])

    def test_two_sources(self):
        f2b = self.path("fail2ban.log")
        write(self.log, "m1\n")
        write(f2b, "f1\n")
        agent = self.make_agent()
        self.use_logs(agent, (self.log, "mail"), (f2b, "fail2ban"))
        agent.ship_cycle()
        self.assertEqual(self.server.lines("mail"), ["m1"])
        self.assertEqual(self.server.lines("fail2ban"), ["f1"])

    def test_missing_log_file_is_idle(self):
        agent = self.make_agent()
        self.use_logs(agent, (self.path("nope.log"), "mail"))
        self.assertEqual(agent.ship_cycle(), ("idle", 0))

    def test_log_path_outside_allowed_dirs_is_ignored(self):
        agent = self.make_agent()
        outside = os.path.join(os.path.dirname(self.tmp), "maillog-outside", "x.log")
        agent.apply_config({"logs": [{"path": outside, "source": "mail"}, {"path": self.log, "source": "bogus"}]})
        self.assertEqual(agent.get_logs(), [{"path": self.log, "source": "mail"}])


# ------------------------------------------------------------------------------------------------------------
# checks
# ------------------------------------------------------------------------------------------------------------

class CheckCase(TmpCase):
    def setUp(self):
        super().setUp()
        self.deps = FakeDeps()
        self.state = mod.State(self.state_dir)
        self.runner = self.new_runner()

    def new_runner(self, allowed=("postfix", "saslauthd")):
        return mod.CheckRunner(self.deps, self.state, allowed)

    def run1(self, check, runner=None):
        res = (runner or self.runner).run_all([check], 30)
        self.assertEqual(len(res), 1)
        return res[0]


class CheckTypeTests(CheckCase):
    def test_disk_states(self):
        c = {"name": "disk", "type": "disk", "path": "/", "warn": 85, "fail": 95}
        for used, free, state in [(50, 50, "ok"), (85, 15, "warn"), (94, 6, "warn"), (95, 5, "fail")]:
            with self.subTest(used=used):
                self.deps.disk_usage = lambda p, u=used, f=free: DiskUsage(100, u, f)
                self.runner = self.new_runner()
                r = self.run1(c)
                self.assertEqual(r["state"], state)
                self.assertIn("% used", r["message"])

    def test_disk_error(self):
        def boom(p):
            raise OSError("no such path")
        self.deps.disk_usage = boom
        self.assertEqual(self.run1({"name": "d", "type": "disk", "path": "/x"})["state"], "fail")

    def test_tcp_banner_ok_sends_quit(self):
        sock = FakeSock(b"220 mail.example.com ESMTP Postfix\r\n")
        self.deps.connect = lambda addr, timeout: sock
        r = self.run1({"name": "smtp", "type": "tcp", "host": "127.0.0.1", "port": 25, "expect": "^220"})
        self.assertEqual(r["state"], "ok")
        self.assertEqual(sock.sent, [b"QUIT\r\n"])
        self.assertTrue(sock.closed)

    def test_tcp_banner_mismatch(self):
        sock = FakeSock(b"421 try later\r\n")
        self.deps.connect = lambda addr, timeout: sock
        r = self.run1({"name": "smtp", "type": "tcp", "host": "127.0.0.1", "port": 25, "expect": "^220"})
        self.assertEqual(r["state"], "fail")
        self.assertIn("unexpected banner", r["message"])
        self.assertTrue(sock.closed)

    def test_tcp_connect_refused(self):
        def refuse(addr, timeout):
            raise ConnectionRefusedError("refused")
        self.deps.connect = refuse
        r = self.run1({"name": "milter", "type": "tcp", "host": "127.0.0.1", "port": 8891})
        self.assertEqual(r["state"], "fail")
        self.assertIn("127.0.0.1:8891", r["message"])

    def test_tcp_without_expect_just_connects(self):
        sock = FakeSock()
        self.deps.connect = lambda addr, timeout: sock
        r = self.run1({"name": "milter", "type": "tcp", "host": "127.0.0.1", "port": 8891})
        self.assertEqual(r["state"], "ok")
        self.assertTrue(sock.closed)

    def test_service_active_and_inactive(self):
        self.deps.run_handler = lambda cmd: (0, "active\n")
        self.assertEqual(self.run1({"name": "postfix", "type": "service", "unit": "postfix"})["state"], "ok")
        self.runner = self.new_runner()
        self.deps.run_handler = lambda cmd: (3, "inactive\n")
        r = self.run1({"name": "postfix", "type": "service", "unit": "postfix"})
        self.assertEqual(r["state"], "fail")
        self.assertIn("inactive", r["message"])

    def test_service_enable_fix_is_recorded(self):
        calls = {"enabled": False}

        def handler(cmd):
            if cmd[:2] == ["systemctl", "is-active"]:
                return 0, "active\n"
            if cmd[:2] == ["systemctl", "is-enabled"]:
                return (0, "enabled\n") if calls["enabled"] else (1, "disabled\n")
            if cmd[:2] == ["systemctl", "enable"]:
                calls["enabled"] = True
                return 0, ""
            return 0, ""
        self.deps.run_handler = handler
        r = self.run1({"name": "saslauthd", "type": "service", "unit": "saslauthd", "enable": True})
        self.assertEqual(r["state"], "ok")
        self.assertIn("enabled now", r["message"])
        self.assertEqual(self.runner.pending_actions,
                         [{"name": "saslauthd", "action": "systemctl enable saslauthd", "ok": True, "result": "enabled"}])

    def test_service_enable_fix_failure_is_warn(self):
        def handler(cmd):
            if cmd[:2] == ["systemctl", "is-active"]:
                return 0, "active\n"
            if cmd[:2] == ["systemctl", "is-enabled"]:
                return 1, "disabled\n"
            return 1, "Failed to enable unit"
        self.deps.run_handler = handler
        r = self.run1({"name": "saslauthd", "type": "service", "unit": "saslauthd", "enable": True})
        self.assertEqual(r["state"], "warn")
        self.assertFalse(self.runner.pending_actions[0]["ok"])

    def test_service_enable_refused_for_unit_not_allowed(self):
        def handler(cmd):
            if cmd[:2] == ["systemctl", "is-active"]:
                return 0, "active\n"
            return 1, "disabled\n"
        self.deps.run_handler = handler
        r = self.run1({"name": "x", "type": "service", "unit": "mysql", "enable": True})
        self.assertEqual(r["state"], "warn")
        self.assertEqual(self.deps.ran("systemctl", "enable"), [])

    def test_sasl_probe(self):
        c = {"name": "sasl", "type": "sasl_probe", "unit": "saslauthd"}
        self.deps.run_handler = lambda cmd: (1, '0: NO "authentication failed"\n')
        self.assertEqual(self.run1(c)["state"], "ok")
        probe = self.deps.commands[-1]
        self.assertEqual(probe[0], "testsaslauthd")
        self.assertIn("maillog-probe-nonexistent", probe)
        for rc, out in [(1, "connect() : No such file or directory\n"), (1, "connect() : Connection refused\n"),
                        (124, "timeout after 10s"), (1, "")]:
            with self.subTest(out=out):
                self.runner = self.new_runner()
                self.deps.run_handler = lambda cmd, rc=rc, out=out: (rc, out)
                self.assertEqual(self.run1(c)["state"], "fail")

    def test_sasl_probe_missing_command(self):
        self.deps.run_handler = lambda cmd: (127, "command not found: testsaslauthd")
        r = self.run1({"name": "sasl", "type": "sasl_probe"})
        self.assertEqual(r["state"], "fail")
        self.assertIn("not installed", r["message"])

    def test_queue_check_thresholds_and_metrics(self):
        self.deps.now = NOW
        self.deps.run_handler = lambda cmd: (0, SAMPLE_QUEUE)
        base = {"name": "queue", "type": "queue", "warn": 500, "fail": 5000, "maxAgeWarnS": 7200}
        r = self.run1(base)
        self.assertEqual(r["state"], "ok")
        self.assertIn("3 queued (2 deferred), oldest 1h", r["message"])
        self.assertEqual(self.deps.commands[-1], ["postqueue", "-j"])
        self.assertEqual(self.runner.queue["total"], 3)

        self.runner = self.new_runner()
        self.assertEqual(self.run1(dict(base, warn=3))["state"], "warn")
        self.runner = self.new_runner()
        self.assertEqual(self.run1(dict(base, warn=2, fail=3))["state"], "fail")

    def test_queue_check_ignores_old_deferred_mail(self):
        self.deps.now = NOW
        old = json.dumps({"queue_name": "deferred", "queue_id": "BBBB2222CC", "arrival_time": int(NOW) - 5 * 86400,
                          "message_size": 10, "sender": "a@b.at", "recipients": [{"address": "x@gmail.com", "delay_reason": "452 4.2.2 full"}]})
        self.deps.run_handler = lambda cmd: (0, old)
        r = self.run1({"name": "queue", "type": "queue", "maxAgeWarnS": 3600})
        self.assertEqual(r["state"], "ok")
        self.assertEqual(self.runner.queue["oldestAgeS"], 5 * 86400)
        self.assertEqual(self.runner.queue["oldestActiveAgeS"], 0)

    def test_queue_check_warns_when_active_mail_is_old(self):
        self.deps.now = NOW
        stuck = json.dumps({"queue_name": "active", "queue_id": "AAAA1111BB", "arrival_time": int(NOW) - 5400,
                            "message_size": 10, "sender": "a@b.at", "recipients": [{"address": "x@y.com"}]})
        self.deps.run_handler = lambda cmd: (0, stuck)
        r = self.run1({"name": "queue", "type": "queue", "maxAgeWarnS": 3600})
        self.assertEqual(r["state"], "warn")
        self.assertEqual(self.runner.queue["oldestActiveAgeS"], 5400)

    def test_queue_empty_and_failure(self):
        self.deps.run_handler = lambda cmd: (0, "")
        r = self.run1({"name": "queue", "type": "queue"})
        self.assertEqual((r["state"], r["message"]), ("ok", "queue empty"))
        self.assertEqual(self.runner.queue["total"], 0)
        self.runner = self.new_runner()
        self.deps.run_handler = lambda cmd: (1, "postqueue: fatal: queue file write error")
        self.assertEqual(self.run1({"name": "queue", "type": "queue"})["state"], "fail")

    def test_unknown_type_and_invalid_definitions(self):
        res = self.runner.run_all([{"name": "x", "type": "shell", "cmd": "rm -rf /"}, {"type": "disk"}, "junk",
                                   {"name": "x", "type": "disk"}], 30)
        self.assertEqual([r["name"] for r in res], ["x"])
        self.assertEqual(res[0]["state"], "warn")
        self.assertEqual(self.deps.commands, [])

    def test_invalid_unit_name_is_never_executed(self):
        r = self.run1({"name": "x", "type": "service", "unit": "--now; rm -rf /", "restart": True})
        self.assertEqual(r["state"], "fail")
        self.assertEqual(self.deps.commands, [])

    def test_every_gates_runs(self):
        self.deps.run_handler = lambda cmd: (0, "active\n")
        c = {"name": "slow", "type": "service", "unit": "postfix", "every": 60}
        self.runner.run_all([c], 30)
        self.assertEqual(len(self.deps.commands), 1)
        self.deps.now += 30
        self.runner.run_all([c], 30)
        self.assertEqual(len(self.deps.commands), 1)
        self.deps.now += 30
        self.runner.run_all([c], 30)
        self.assertEqual(len(self.deps.commands), 2)

    def test_removed_checks_are_forgotten(self):
        self.deps.run_handler = lambda cmd: (0, "active\n")
        self.runner.run_all([{"name": "a", "type": "service", "unit": "postfix"}], 30)
        self.runner.run_all([], 30)
        self.assertEqual(self.runner.last, {})


class RecoveryTests(CheckCase):
    def setUp(self):
        super().setUp()
        self.svc = {"active": False, "restart_fixes": True}

        def handler(cmd):
            if cmd[:2] == ["systemctl", "is-active"]:
                return (0, "active\n") if self.svc["active"] else (3, "inactive\n")
            if cmd[:2] == ["systemctl", "is-enabled"]:
                return 0, "enabled\n"
            if cmd[:2] == ["systemctl", "restart"] or cmd[:3] == ["systemctl", "enable", "--now"]:
                self.svc["active"] = self.svc["restart_fixes"]
                return 0, ""
            return 0, ""
        self.deps.run_handler = handler
        self.check = {"name": "saslauthd", "type": "service", "unit": "saslauthd", "restart": True}

    def tick(self, check=None, runner=None):
        self.deps.now += 30
        return self.run1(check or self.check, runner)

    def test_restart_only_after_two_consecutive_failures(self):
        r1 = self.tick()
        self.assertEqual(r1["state"], "fail")
        self.assertEqual(self.deps.ran("systemctl", "restart"), [])
        self.assertEqual(self.runner.pending_actions, [])
        r2 = self.tick()
        self.assertEqual(r2["state"], "ok")
        self.assertEqual(r2["message"], "recovered after restart")
        self.assertEqual(self.deps.ran("systemctl", "restart"), [["systemctl", "restart", "saslauthd"]])
        self.assertEqual(self.runner.pending_actions,
                         [{"name": "saslauthd", "action": "systemctl restart saslauthd", "ok": True, "result": "recovered"}])
        self.assertEqual(self.deps.sleeps, [3])
        self.assertEqual(self.runner.fail_counts["saslauthd"], 0)

    def test_single_failure_that_heals_is_not_restarted(self):
        self.tick()
        self.svc["active"] = True
        self.assertEqual(self.tick()["state"], "ok")
        self.assertEqual(self.deps.ran("systemctl", "restart"), [])

    def test_enable_now_variant(self):
        check = dict(self.check, enable=True)
        self.tick(check)
        r = self.tick(check)
        self.assertEqual(r["state"], "ok")
        self.assertEqual(self.deps.ran("systemctl", "enable", "--now"), [["systemctl", "enable", "--now", "saslauthd"]])
        self.assertEqual(self.deps.ran("systemctl", "restart"), [])
        self.assertEqual(self.runner.pending_actions[0]["action"], "systemctl enable --now saslauthd")

    def test_restart_that_does_not_help_reports_failure(self):
        self.svc["restart_fixes"] = False
        self.tick()
        r = self.tick()
        self.assertEqual(r["state"], "fail")
        self.assertIn("restart did not help", r["message"])
        self.assertFalse(self.runner.pending_actions[0]["ok"])

    def test_restart_limit_per_hour_and_persistence(self):
        self.svc["restart_fixes"] = False
        for _ in range(5):                      # run 1 counts failure, runs 2-5 restart (4x)
            self.tick()
        self.assertEqual(len(self.deps.ran("systemctl", "restart")), 4)
        r = self.tick()
        self.assertEqual(r["state"], "fail")
        self.assertIn("restart limit reached", r["message"])
        self.assertEqual(len(self.deps.ran("systemctl", "restart")), 4)

        # a restarted agent process still knows the history
        self.state = mod.State(self.state_dir)
        runner2 = mod.CheckRunner(self.deps, self.state, ("saslauthd",))
        self.tick(runner=runner2)
        r = self.tick(runner=runner2)
        self.assertIn("restart limit reached", r["message"])
        self.assertEqual(len(self.deps.ran("systemctl", "restart")), 4)

        # an hour later the window is empty again: the (still failing) unit is restarted right away, once per run
        self.deps.now += 3700
        self.tick(runner=runner2)
        self.assertEqual(len(self.deps.ran("systemctl", "restart")), 5)
        self.tick(runner=runner2)
        self.assertEqual(len(self.deps.ran("systemctl", "restart")), 6)

    def test_unit_not_in_allowed_units_is_refused(self):
        check = {"name": "mysql", "type": "service", "unit": "mysql", "restart": True}
        self.tick(check)
        r = self.tick(check)
        self.assertEqual(r["state"], "fail")
        self.assertIn("allowedUnits", r["message"])
        self.assertEqual(self.deps.ran("systemctl", "restart"), [])
        self.assertEqual(self.deps.ran("systemctl", "enable"), [])
        self.assertEqual(self.runner.pending_actions, [])

    def test_check_without_restart_flag_is_never_restarted(self):
        check = {"name": "postfix", "type": "service", "unit": "postfix"}
        self.tick(check)
        self.tick(check)
        self.tick(check)
        self.assertEqual(self.deps.ran("systemctl", "restart"), [])

    def test_sasl_probe_recovery_restarts_unit(self):
        def handler(cmd):
            if cmd[0] == "testsaslauthd":
                return (1, '0: NO "authentication failed"\n') if self.svc["active"] else (1, "connect() : No such file or directory\n")
            if cmd[:2] == ["systemctl", "restart"]:
                self.svc["active"] = True
            return 0, ""
        self.deps.run_handler = handler
        check = {"name": "sasl-auth-probe", "type": "sasl_probe", "unit": "saslauthd", "restart": True}
        self.assertEqual(self.tick(check)["state"], "fail")
        r = self.tick(check)
        self.assertEqual(r["state"], "ok")
        self.assertEqual(self.deps.ran("systemctl", "restart"), [["systemctl", "restart", "saslauthd"]])
        self.assertEqual(self.runner.pending_actions[0]["name"], "sasl-auth-probe")

    def test_crashing_check_does_not_kill_runner(self):
        self.deps.run_handler = lambda cmd: 1 / 0
        r = self.tick({"name": "boom", "type": "service", "unit": "postfix"})
        self.assertEqual(r["state"], "fail")
        self.assertIn("crashed", r["message"])


# ------------------------------------------------------------------------------------------------------------
# health cycle, config, self-update
# ------------------------------------------------------------------------------------------------------------

class HealthCycleTests(AgentCase):
    def test_report_contents_and_config_roundtrip(self):
        self.server.config = {
            "intervalS": 45,
            "logs": [{"path": self.path("mail.log"), "source": "mail"}],
            "checks": [{"name": "disk-root", "type": "disk", "path": "/", "warn": 40, "fail": 99},
                       {"name": "queue", "type": "queue", "warn": 500, "fail": 5000, "maxAgeWarnS": 7200}],
        }
        deps = FakeDeps()
        deps.now = NOW
        deps.run_handler = lambda cmd: (0, SAMPLE_QUEUE)
        agent = self.make_agent(deps=deps)
        self.assertTrue(agent.fetch_config())
        self.assertEqual(agent.interval(), 45)
        self.assertTrue(agent.health_cycle())
        report = self.server.health[0]
        self.assertEqual(report["version"], mod.AGENT_VERSION)
        self.assertEqual(report["hostname"], "testhost")
        states = {c["name"]: c["state"] for c in report["checks"]}
        self.assertEqual(states, {"disk-root": "warn", "queue": "ok"})
        m = report["metrics"]
        self.assertEqual((m["queueTotal"], m["queueDeferred"], m["queueActive"], m["queueOldestAgeS"]), (3, 2, 1, 3600))
        self.assertEqual(m["queue"]["topSenderDomains"][0]["name"], "customer-a.example")
        self.assertEqual(report["actions"], [])

    def test_config_is_cached_for_offline_start(self):
        self.server.config = {"intervalS": 50, "logs": [{"path": self.path("mail.log"), "source": "mail"}],
                              "checks": [{"name": "d", "type": "disk"}]}
        agent = self.make_agent()
        agent.fetch_config()
        agent2 = self.make_agent()   # fresh process, server not asked
        self.assertEqual(agent2.interval(), 50)
        self.assertEqual(agent2.get_logs(), [{"path": self.path("mail.log"), "source": "mail"}])

    def test_pending_actions_survive_failed_report(self):
        agent = self.make_agent()
        agent.runner.pending_actions.append({"name": "saslauthd", "action": "systemctl restart saslauthd", "ok": True, "result": "recovered"})
        self.server.fail_health = 1
        self.assertFalse(agent.health_cycle())
        self.assertEqual(len(agent.runner.pending_actions), 1)
        self.assertTrue(agent.health_cycle())
        self.assertEqual(self.server.health[0]["actions"][0]["name"], "saslauthd")
        self.assertEqual(agent.runner.pending_actions, [])
        agent.health_cycle()
        self.assertEqual(self.server.health[1]["actions"], [])

    def test_recovery_reported_end_to_end(self):
        self.server.config = {"intervalS": 30, "logs": [], "checks": [
            {"name": "saslauthd", "type": "service", "unit": "saslauthd", "restart": True, "enable": True}]}
        deps = FakeDeps()
        state = {"active": False}

        def handler(cmd):
            if cmd[:2] == ["systemctl", "is-active"]:
                return (0, "active\n") if state["active"] else (3, "inactive\n")
            if cmd[:2] == ["systemctl", "is-enabled"]:
                return 0, "enabled\n"
            if cmd[:3] == ["systemctl", "enable", "--now"]:
                state["active"] = True
            return 0, ""
        deps.run_handler = handler
        agent = self.make_agent(deps=deps)
        agent.fetch_config()
        agent.health_cycle()
        deps.now += 30
        agent.health_cycle()
        first, second = self.server.health
        self.assertEqual(first["checks"][0]["state"], "fail")
        self.assertEqual(second["checks"][0]["state"], "ok")
        self.assertEqual(second["actions"][0]["action"], "systemctl enable --now saslauthd")
        self.assertTrue(second["actions"][0]["ok"])


class SelfUpdateTests(AgentCase):
    def test_should_update_decision(self):
        f = mod.should_update
        self.assertTrue(f("b" * 64, "a" * 64, 0, 1000))
        self.assertFalse(f("a" * 64, "a" * 64, 0, 1000))       # same hash
        self.assertFalse(f(None, "a" * 64, 0, 1000))           # server did not say
        self.assertFalse(f("", "a" * 64, 0, 1000))
        self.assertFalse(f("b" * 64, "", 0, 1000))             # unknown local hash
        self.assertFalse(f("b" * 64, "a" * 64, 500, 1000))     # updated < 10 minutes ago
        self.assertTrue(f("b" * 64, "a" * 64, 400, 1000))

    def test_update_replaces_file_and_requests_exit(self):
        new = b"print('new version')\n"
        self.server.script = new
        agent = self.make_agent()
        self.assertTrue(agent.maybe_update(hashlib.sha256(new).hexdigest()))
        with open(self.script, "rb") as f:
            self.assertEqual(f.read(), new)
        self.assertTrue(agent.stop.is_set())
        self.assertEqual(agent.exit_code, 0)
        self.assertFalse(os.path.exists(self.script + ".new"))
        self.assertGreater(agent.state.data["lastUpdate"], 0)

    def test_update_rate_limited(self):
        deps = FakeDeps()
        agent = self.make_agent(deps=deps)
        new1, new2 = b"print(1)\n", b"print(2)\n"
        self.server.script = new1
        self.assertTrue(agent.maybe_update(hashlib.sha256(new1).hexdigest()))
        self.server.script = new2
        deps.now += 60
        self.assertFalse(agent.maybe_update(hashlib.sha256(new2).hexdigest()))
        deps.now += 700
        self.assertTrue(agent.maybe_update(hashlib.sha256(new2).hexdigest()))

    def test_hash_mismatch_is_rejected(self):
        self.server.script = b"print('tampered')\n"
        agent = self.make_agent()
        self.assertFalse(agent.maybe_update(hashlib.sha256(b"print('expected')\n").hexdigest()))
        with open(self.script, "rb") as f:
            self.assertEqual(f.read(), b"print('old version')\n")
        self.assertFalse(agent.stop.is_set())

    def test_invalid_python_is_rejected(self):
        bad = b"def broken(:\n"
        self.server.script = bad
        agent = self.make_agent()
        self.assertFalse(agent.maybe_update(hashlib.sha256(bad).hexdigest()))
        with open(self.script, "rb") as f:
            self.assertEqual(f.read(), b"print('old version')\n")

    def test_no_update_when_hashes_equal(self):
        agent = self.make_agent()
        self.assertFalse(agent.maybe_update(agent.local_sha))

    def test_health_response_triggers_update(self):
        new = b"print('v2')\n"
        self.server.script = new
        agent = self.make_agent()
        self.assertTrue(agent.health_cycle())
        self.assertTrue(agent.stop.is_set())
        with open(self.script, "rb") as f:
            self.assertEqual(f.read(), new)


# ------------------------------------------------------------------------------------------------------------
# misc: config file, entry point, installer
# ------------------------------------------------------------------------------------------------------------

class MiscTests(TmpCase):
    def test_load_config_defaults(self):
        p = self.path("cfg.json")
        write(p, json.dumps({"server": "https://x", "token": "mla_1"}))
        cfg = mod.load_config(p)
        self.assertEqual(cfg["allowedUnits"], mod.DEFAULT_ALLOWED_UNITS)
        self.assertEqual(cfg["allowedLogDirs"], ["/var/log"])
        self.assertEqual(cfg["backfillBytes"], 5_000_000)

    def test_load_config_requires_server_and_token(self):
        p = self.path("cfg.json")
        write(p, json.dumps({"server": "https://x"}))
        with self.assertRaises(ValueError):
            mod.load_config(p)

    def test_main_version_and_missing_config(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.assertEqual(mod.main(["--version"]), 0)
        self.assertEqual(buf.getvalue().strip(), mod.AGENT_VERSION)
        self.assertEqual(mod.main(["--config", self.path("missing.json"), "--state-dir", self.state_dir]), 2)

    def test_state_roundtrip_and_corrupt_file(self):
        s = mod.State(self.state_dir)
        s.data["logs"]["/x"] = {"inode": 1, "offset": 5}
        s.save()
        self.assertEqual(mod.State(self.state_dir).data["logs"]["/x"], {"inode": 1, "offset": 5})
        write(s.path, "{not json")
        self.assertEqual(mod.State(self.state_dir).data["logs"], {})


def _bash():
    for cand in (r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files\Git\usr\bin\bash.exe"):
        if os.path.exists(cand):
            return cand
    if os.name != "nt":
        return shutil.which("bash")
    return None


class InstallerTests(unittest.TestCase):
    TEMPLATE = os.path.join(ROOT, "agent", "install.sh.tpl")

    def read(self):
        with open(self.TEMPLATE, "r", encoding="utf-8", newline="") as f:
            return f.read().replace("\r\n", "\n")

    def test_template_has_server_placeholder(self):
        text = self.read()
        self.assertIn('SERVER="{{SERVER}}"', text)
        self.assertTrue(text.startswith("#!/usr/bin/env bash"))
        self.assertIn("set -euo pipefail", text)

    def test_rendered_script_is_valid_bash(self):
        bash = _bash()
        if not bash:
            self.skipTest("bash not available")
        text = self.read().replace("{{SERVER}}", "https://maillog.example.com")
        p = subprocess.run([bash, "-n"], input=text.encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(p.returncode, 0, p.stderr.decode())

    def test_tokens_are_never_echoed(self):
        text = self.read()
        for line in text.splitlines():
            if line.lstrip().startswith(("echo", "info", "die")):
                self.assertNotIn("$ENROLL", line)
                self.assertNotIn("$TOKEN", line)


if __name__ == "__main__":
    unittest.main()
