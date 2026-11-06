#!/usr/bin/env python3
"""End-to-end API test for a running maillog instance (stdlib only).

Usage: e2e.py BASE_URL ADMIN_PASSWORD [--wait-alerts]   (ADMIN_PASSWORD: from the container log / initial-admin-password.txt)
Creates its own agent/users/tokens with a random suffix and cleans up what it can. Do NOT run against production data you care about
(it ingests synthetic mail events with sender domain *.e2e.test).
"""
import gzip
import os
import http.cookiejar
import json
import secrets
import sys
import time
import urllib.error
import urllib.request

BASE = sys.argv[1].rstrip("/")
ADMIN_PW = sys.argv[2]
SUFFIX = secrets.token_hex(3)
FAILS = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + (" -- " + str(extra) if (extra and not cond) else ""))
    if not cond:
        FAILS.append(name)


class Session:
    def __init__(self, token=None):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.token = token

    def call(self, method, path, body=None, headers=None, gz=False, raw=False):
        h = dict(headers or {})
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
            if gz:
                data = gzip.compress(data)
                h["Content-Encoding"] = "gzip"
        if self.token and "Authorization" not in h:
            h["Authorization"] = "Bearer " + self.token
        req = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
        try:
            with self.opener.open(req, timeout=60) as r:
                payload = r.read()
                return r.status, (payload if raw else _json(payload))
        except urllib.error.HTTPError as e:
            payload = e.read()
            return e.code, (payload if raw else _json(payload))


def _json(b):
    try:
        return json.loads(b.decode())
    except ValueError:
        return b.decode(errors="replace")


class FakeSmtp:
    """Tiny SMTP server for the alert channel tests (plain, optional AUTH PLAIN/LOGIN, records messages)."""

    def __init__(self, port):
        import socket
        import threading
        self.port = port
        self.require_auth = False
        self.messages = []
        self.auths = []
        self.sock = socket.socket()
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("0.0.0.0", port))
        self.sock.listen(5)
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self):
        import threading
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _serve(self, conn):
        import base64
        f = conn.makefile("rwb", buffering=0)
        send = lambda t: f.write((t + "\r\n").encode())
        authed = False
        mail_from, rcpts = None, []
        send("220 fake.smtp ESMTP ready")
        try:
            while True:
                line = f.readline().decode(errors="replace").rstrip("\r\n")
                if not line:
                    return
                up = line.upper()
                if up.startswith(("EHLO", "HELO")):
                    send("250-fake.smtp")
                    send("250-AUTH PLAIN LOGIN")
                    send("250 8BITMIME")
                elif up.startswith("AUTH PLAIN"):
                    arg = line[10:].strip()
                    if not arg:
                        send("334 ")
                        arg = f.readline().decode().strip()
                    parts = base64.b64decode(arg).split(b"\0")
                    self.auths.append((parts[-2].decode(), parts[-1].decode()))
                    authed = True
                    send("235 2.7.0 Authentication successful")
                elif up.startswith("AUTH LOGIN"):
                    send("334 " + base64.b64encode(b"Username:").decode())
                    user = base64.b64decode(f.readline().strip()).decode()
                    send("334 " + base64.b64encode(b"Password:").decode())
                    pw = base64.b64decode(f.readline().strip()).decode()
                    self.auths.append((user, pw))
                    authed = True
                    send("235 2.7.0 Authentication successful")
                elif up.startswith("MAIL FROM"):
                    if self.require_auth and not authed:
                        send("530 5.7.0 Authentication required")
                        continue
                    mail_from = line[10:].strip()
                    rcpts = []
                    send("250 OK")
                elif up.startswith("RCPT TO"):
                    rcpts.append(line[8:].strip())
                    send("250 OK")
                elif up == "DATA":
                    send("354 go ahead")
                    data = b""
                    while not data.endswith(b"\r\n.\r\n"):
                        chunk = f.readline()
                        if not chunk:
                            return
                        data += chunk
                    self.messages.append({"from": mail_from, "rcpts": rcpts, "data": data.decode(errors="replace"), "authed": authed})
                    send("250 OK queued")
                elif up == "QUIT":
                    send("221 bye")
                    return
                elif up.startswith("RSET") or up.startswith("NOOP"):
                    send("250 OK")
                else:
                    send("502 not implemented")
        finally:
            conn.close()


def iso(ts):
    lt = time.localtime(ts)
    off = time.strftime("%z", lt)
    return time.strftime("%Y-%m-%dT%H:%M:%S", lt) + ".%06d" % int((ts % 1) * 1e6) + off[:3] + ":" + off[3:]


def main():
    anon = Session()
    viewer2 = None
    st, body = anon.call("GET", "/healthz", raw=True)
    check("healthz", st == 200 and body == b"ok", (st, body))

    # ---- auth -----------------------------------------------------------------------------------------------
    st, _ = anon.call("GET", "/api/v1/me")
    check("me requires auth", st == 401, st)
    st, _ = anon.call("POST", "/api/v1/auth/login", {"username": "admin", "password": "wrong-password"})
    check("wrong password rejected", st == 401, st)
    admin = Session()
    st, r = admin.call("POST", "/api/v1/auth/login", {"username": "admin", "password": ADMIN_PW})
    check("admin login", st == 200 and r["user"]["role"] == "admin", (st, r))
    st, me = admin.call("GET", "/api/v1/me")
    check("me returns admin", st == 200 and me["username"] == "admin", me)

    # ---- agent onboarding ----------------------------------------------------------------------------------
    name = "e2e-relay-" + SUFFIX
    st, created = admin.call("POST", "/api/v1/agents", {"name": name, "role": "relay"})
    check("create agent", st == 201 and created["enrollToken"].startswith("mle_"), (st, created))
    enroll = created["enrollToken"]
    check("install command has server+token", "install.sh" in created["installCommand"] and enroll in created["installCommand"], created.get("installCommand"))
    st, script = anon.call("GET", "/install.sh", raw=True)
    check("install.sh served with server filled in", st == 200 and b"{{SERVER}}" not in script and BASE.encode().split(b"//")[1] in script, st)
    st, agent_py = anon.call("GET", "/agent/maillog-agent.py", raw=True)
    check("agent script served", st == 200 and b"AGENT_VERSION" in agent_py, st)
    st, bad = anon.call("POST", "/agent-api/v1/enroll", {"token": "mle_nope", "hostname": "x"})
    check("bogus enrollment token rejected", st == 400, (st, bad))
    st, enr = anon.call("POST", "/agent-api/v1/enroll", {"token": enroll, "hostname": "e2e-host"})
    check("enroll succeeds", st == 200 and enr["agentToken"].startswith("mla_"), (st, enr))
    st, _ = anon.call("POST", "/agent-api/v1/enroll", {"token": enroll, "hostname": "e2e-host"})
    check("enrollment token is single use", st == 400, st)
    agent = Session(enr["agentToken"])
    st, cfg = agent.call("GET", "/agent-api/v1/config")
    check("agent config", st == 200 and any(c["type"] == "sasl_probe" for c in cfg["checks"]) and cfg["agentSha256"], cfg)
    st, _ = Session("mla_wrong").call("GET", "/agent-api/v1/config")
    check("agent token required", st == 401, st)

    # ---- ingest ---------------------------------------------------------------------------------------------
    now = time.time()
    dom = "dp-%s.e2e.test" % SUFFIX
    other = "other-%s.e2e.test" % SUFFIX
    q1, q2, q3 = "9C2197F8" + SUFFIX[:2].upper() + "1", "AAAB15F" + SUFFIX[:3].upper() + "1", "5D1E8A3" + SUFFIX[:3].upper() + "7"
    # sanity: queue ids must be 10-16 chars
    q1, q2, q3 = [(q + "0000000000")[:10] for q in (q1, q2, q3)]
    host = "smtp2"
    lines = [
        iso(now - 20) + " " + host + " postfix/smtpd[1]: " + q1 + ": client=srv-x.example[10.1.1.1], sasl_method=LOGIN, sasl_username=smtp_relay_e2e",
        iso(now - 19) + " " + host + " postfix/qmgr[2]: " + q1 + ": from=<noreply@" + dom + ">, size=1234, nrcpt=1 (queue active)",
        iso(now - 18) + " " + host + " postfix/smtp[3]: " + q1 + ": to=<user@gmail.com>, relay=10.0.0.72[10.0.0.72]:25, delay=0.2, delays=0.02/0.01/0.02/0.15, dsn=2.0.0, status=sent (250 2.0.0 Ok: queued as " + q2 + ")",
        iso(now - 17) + " " + host + " postfix/smtpd[4]: warning: unknown[89.1.2.3]: SASL LOGIN authentication failed: generic failure, sasl_username=smtp_relay_e2e",
        iso(now - 16) + " " + host + " postfix/smtpd[5]: " + q3 + ": client=srv-y.example[10.1.1.2], sasl_method=LOGIN, sasl_username=smtp_relay_other",
        iso(now - 15) + " " + host + " postfix/qmgr[2]: " + q3 + ": from=<noreply@" + other + ">, size=999, nrcpt=1 (queue active)",
    ]
    st, r = agent.call("POST", "/agent-api/v1/ingest", {"tzOffsetMinutes": 60, "version": "e2e", "hostname": "e2e-host",
                                                       "batches": [{"source": "mail", "lines": lines}]}, gz=True)
    check("ingest (gzip) accepted", st == 200 and r["accepted"] == len(lines), (st, r))
    st, r2 = agent.call("POST", "/agent-api/v1/ingest", {"tzOffsetMinutes": 60, "batches": [{"source": "mail", "lines": lines}]})
    check("ingest is idempotent", st == 200 and r2["accepted"] == 0, (st, r2))
    st, rn = agent.call("POST", "/agent-api/v1/ingest", {"tzOffsetMinutes": 60, "batches": [{"source": "mail", "lines": [
        iso(now - 30) + " " + host + " postfix/smtpd[7]: warning: line with a NUL byte \u0000 inside", "\u0000\u0000\u0000"]}]})
    check("ingest survives NUL bytes in log lines", st == 200 and rn["accepted"] >= 1, (st, rn))

    # the mailout hop (second agent, role outbound) to test trace + viewer scoping
    out_name = "e2e-out-" + SUFFIX
    st, c2 = admin.call("POST", "/api/v1/agents", {"name": out_name, "role": "outbound"})
    st, e2 = anon.call("POST", "/agent-api/v1/enroll", {"token": c2["enrollToken"], "hostname": "e2e-out"})
    out = Session(e2["agentToken"])
    o = "mailout"
    out_lines = [
        iso(now - 14) + " " + o + " postfix/smtpd[1]: " + q2 + ": client=unknown[10.0.0.74]",
        iso(now - 13) + " " + o + " postfix/qmgr[2]: " + q2 + ": from=<noreply@" + dom + ">, size=1300, nrcpt=1 (queue active)",
        iso(now - 12) + " " + o + " opendkim[3]: " + q2 + ": DKIM-Signature field added (s=x, d=" + dom + ")",
        iso(now - 11) + " " + o + " postfix/smtp[4]: " + q2 + ": to=<user@gmail.com>, relay=gmail-smtp-in.l.google.com[142.250.1.1]:25, delay=1.3, delays=0.1/0.01/0.32/0.9, dsn=2.0.0, status=sent (250 2.0.0 OK)",
        iso(now - 10) + " " + o + " postfix/smtpd[5]: " + q3 + ": client=unknown[10.0.0.74]",
        iso(now - 9) + " " + o + " postfix/qmgr[2]: " + q3 + ": from=<noreply@" + other + ">, size=999, nrcpt=1 (queue active)",
        iso(now - 8) + " " + o + " postfix/smtp[4]: " + q3 + ": to=<a@b.com>, relay=mx.b.com[1.1.1.1]:25, delay=1, delays=0.1/0/0.5/0.4, dsn=4.2.2, status=deferred (452 mailbox full)",
        iso(now - 7) + " " + o + " opendkim[3]: ZZZZZ99999: no signing table match for 'postmaster@e2e.local'",
        # out-of-order: delivery line before its queued line in the SAME batch must still get the sender (cache/UPDATE)
    ]
    st, r = out.call("POST", "/agent-api/v1/ingest", {"tzOffsetMinutes": 60, "batches": [{"source": "mail", "lines": out_lines}]}, gz=True)
    check("ingest second agent", st == 200 and r["accepted"] == len(out_lines), (st, r))
    old_ts = "2020-01-02T03:04:05.000000+01:00"
    st, r = out.call("POST", "/agent-api/v1/ingest", {"tzOffsetMinutes": 60, "batches": [
        {"source": "mail", "lines": [old_ts + " mailout postfix/smtpd[9]: connect from old.example[9.9.9.9]"]},
        {"source": "fail2ban", "lines": [time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(now + 3600 - 60)) + ",357 fail2ban.actions        [758]: NOTICE  [postfix-sasl] Ban 203.0.113.9"]}]})
    check("ingest old event + fail2ban line", st == 200 and r["accepted"] == 2, (st, r))

    # ---- health + queue ------------------------------------------------------------------------------------
    qsnap = {"ts": int(now * 1000), "total": 34, "active": 2, "deferred": 30, "hold": 0, "incoming": 2, "oldestAgeS": 90000, "oldestActiveAgeS": 40,
             "topSenderDomains": [{"name": dom, "count": 20}], "topRecipientDomains": [{"name": "gmail.com", "count": 12}],
             "topReasons": [{"name": "452 4.2.2 mailbox full", "count": 9}]}
    report = {"version": "e2e", "hostname": "e2e-host",
              "checks": [{"name": "saslauthd", "state": "fail", "message": "saslauthd is inactive"},
                         {"name": "postfix", "state": "ok", "message": "postfix active"}],
              "metrics": {"queueTotal": 34, "queueDeferred": 30, "queueActive": 2, "queueOldestAgeS": 90000, "queue": qsnap},
              "actions": [{"name": "postfix", "action": "systemctl restart postfix", "ok": True, "result": "recovered"}]}
    st, r = agent.call("POST", "/agent-api/v1/health", report)
    check("health report accepted and config echoed", st == 200 and "checks" in r and "agentSha256" in r, (st, r))
    st, r = out.call("POST", "/agent-api/v1/health", {"version": "e2e", "checks": [{"name": "postfix", "state": "ok", "message": "ok"}]})

    # ---- admin reads --------------------------------------------------------------------------------------
    st, ov = admin.call("GET", "/api/v1/overview")
    mine = next((a for a in ov["agents"] if a["name"] == name), None) if st == 200 else None
    check("overview lists agent with checks and queue", mine is not None and len(mine["checks"]) == 2 and mine["queue"]["total"] == 34, (st, mine))
    check("overview stats24h counts the sent mail", mine is not None and mine["stats24h"]["sent"] == 1 and mine["stats24h"]["authFail"] == 1, mine and mine["stats24h"])
    st, qv = admin.call("GET", "/api/v1/queue?hours=1")
    qa = next((a for a in qv["agents"] if a["name"] == name), None) if st == 200 else None
    check("queue view has snapshot + topReasons + series", qa is not None and qa["current"]["topReasons"][0]["count"] == 9 and len(qa["series"]) >= 1, qa)
    st, ev = admin.call("GET", "/api/v1/events?q=" + q1)
    check("events by queue id (follows next hop)", st == 200 and len(ev["items"]) >= 3, (st, ev))
    st, ev = admin.call("GET", "/api/v1/events?kind=auth_fail&agent=" + name)
    check("events by kind+agent name", st == 200 and len(ev["items"]) == 1 and ev["items"][0]["detail"] == "generic failure", ev)
    st, ev = admin.call("GET", "/api/v1/events?q=noreply@" + dom)
    check("events by sender fragment (trigram search)", st == 200 and all(i["sender"] == "noreply@" + dom for i in ev["items"]) and len(ev["items"]) >= 4, (st, len(ev["items"]) if st == 200 else ev))
    st, tr = admin.call("GET", "/api/v1/trace?q=" + q1)
    agents_in_trace = {e["agentName"] for e in tr["events"]} if st == 200 else set()
    check("trace crosses both hops", agents_in_trace == {name, out_name}, agents_in_trace)
    check("every event of the message carries its sender", all(e["sender"] == "noreply@" + dom for e in tr["events"] if e["kind"] in ("delivery", "accepted", "dkim_signed")), [e["kind"] for e in tr["events"] if e["sender"] is None])
    st, stt = admin.call("GET", "/api/v1/stats?hours=2")
    check("stats rows", st == 200 and sum(r["sent"] for r in stt["rows"]) >= 2, stt)
    st, ex = admin.call("GET", "/api/v1/events?kind=ban")
    check("fail2ban ban parsed", st == 200 and ex["items"] and ex["items"][0]["clientIp"] == "203.0.113.9", ex)


    # ---- statistics summary (admin) ------------------------------------------------------------------------
    st, sm = admin.call("GET", "/api/v1/stats/summary?days=7&tz=60")
    check("summary: shape and zero-filled days", st == 200 and len(sm["daily"]) == 7 and len(sm["hourOfDay"]) == 24 and sm["scope"]["domains"] is None, (st, sm if st != 200 else sm["daily"][:1]))
    if st == 200:
        check("summary counts final hop only (outbound)", sm["totals"]["sent"] == 1 and sm["totals"]["deferred"] == 1, sm["totals"])
        check("summary delivered percent and delay", sm["totals"]["deliveredPct"] == 100.0 and sm["totals"]["avgDelayS"] is not None, sm["totals"])
        check("today's bucket has the mail", sm["daily"][-1]["sent"] == 1 and sum(d["sent"] for d in sm["daily"]) == 1, sm["daily"][-2:])
        check("hour of day sums to sent", sum(h["sent"] for h in sm["hourOfDay"]) == 1, sm["hourOfDay"])
        check("top sender domains", sm["topSenderDomains"] and any(t["name"] == dom and t["sent"] == 1 for t in sm["topSenderDomains"]) and any(t["name"] == other and t["deferred"] == 1 for t in sm["topSenderDomains"]), sm["topSenderDomains"])
        check("top recipient domains", any(t["name"] == "gmail.com" and t["sent"] == 1 for t in sm["topRecipientDomains"]), sm["topRecipientDomains"])
        inf = sm["infrastructure"]
        check("admin gets infrastructure stats", inf is not None and {a["agentName"] for a in inf["byAgent"]} >= {name, out_name}, inf)
        check("infrastructure: top SASL accounts and clients", inf and any(u["name"] == "smtp_relay_e2e" for u in inf["topSaslUsers"]) and any(u["name"] == "10.1.1.1" for u in inf["topClients"]), inf and (inf["topSaslUsers"], inf["topClients"]))
        check("infrastructure: auth failures with generic split", inf and inf["authFailuresDaily"][-1]["authFail"] >= 1 and inf["authFailuresDaily"][-1]["genericFailures"] >= 1, inf and inf["authFailuresDaily"][-1:])
    st, sm1 = admin.call("GET", "/api/v1/stats/summary?days=0")
    st2, sm2 = admin.call("GET", "/api/v1/stats/summary?days=1000")
    check("summary clamps days to 1..365", st == 200 and len(sm1["daily"]) == 1 and st2 == 200 and len(sm2["daily"]) == 365, (len(sm1["daily"]) if st == 200 else st, len(sm2["daily"]) if st2 == 200 else st2))

    # ---- RBAC: viewer scoped to a sender domain ------------------------------------------------------------
    vname = "viewer-" + SUFFIX
    st, _ = admin.call("POST", "/api/v1/users", {"username": vname, "role": "viewer", "domains": [], "password": "viewer-password-123"})
    check("viewer without domains rejected", st == 400, st)
    st, vu = admin.call("POST", "/api/v1/users", {"username": vname, "displayName": "Dance Plus", "role": "viewer", "domains": ["@" + dom], "password": "viewer-password-123"})
    check("create viewer", st == 201 and vu["domains"] == [dom], (st, vu))
    viewer = Session()
    st, _ = viewer.call("POST", "/api/v1/auth/login", {"username": vname, "password": "viewer-password-123"})
    check("viewer login", st == 200, st)
    st, vev = viewer.call("GET", "/api/v1/events?limit=1000&all=true")
    items = vev["items"] if st == 200 else []
    check("viewer sees only own domain", st == 200 and items and all(i["sender"] == "noreply@" + dom for i in items), [i["sender"] for i in items])
    check("viewer sees only final hop (outbound) and no infra data",
          all(i["agentRole"] == "outbound" and i["agentId"] is None and i["agentName"] is None and i["clientIp"] is None
              and i["saslUser"] is None and i["raw"] is None for i in items), items[:1])
    check("viewer only sees customer kinds", {i["kind"] for i in items} <= {"queued", "delivery", "accepted", "reject", "dkim_signed"}, {i["kind"] for i in items})
    st, vtr = viewer.call("GET", "/api/v1/trace?q=" + q2)
    check("viewer trace limited to own mail (final hop only)", st == 200 and vtr["events"] and all(e["sender"] == "noreply@" + dom and e["agentRole"] == "outbound" for e in vtr["events"]), vtr)
    st, vtr1 = viewer.call("GET", "/api/v1/trace?q=" + q1)
    check("viewer cannot see the relay hop by its queue id", st == 200 and vtr1["events"] == [] or all(e["agentRole"] == "outbound" for e in vtr1["events"]), vtr1)
    st, vtr2 = viewer.call("GET", "/api/v1/trace?q=" + q3)
    check("viewer cannot trace another domain's mail", st == 200 and vtr2["events"] == [], vtr2)
    st, vs = viewer.call("GET", "/api/v1/stats?hours=2")
    check("viewer stats aggregated, no agent ids", st == 200 and vs["rows"] and all(r["agentId"] is None for r in vs["rows"]) and sum(r["sent"] for r in vs["rows"]) == 1, vs)
    st, vsum = viewer.call("GET", "/api/v1/stats/summary?days=7&tz=60")
    check("viewer summary is scoped to the own domain", st == 200 and vsum["scope"]["domains"] == [dom] and vsum["infrastructure"] is None, (st, vsum if st != 200 else vsum["scope"]))
    if st == 200:
        check("viewer totals contain only own mail", vsum["totals"]["sent"] == 1 and vsum["totals"]["deferred"] == 0, vsum["totals"])
        check("viewer top lists show only own domain", [t["name"] for t in vsum["topSenderDomains"]] == [dom] and [t["name"] for t in vsum["topRecipientDomains"]] == ["gmail.com"], (vsum["topSenderDomains"], vsum["topRecipientDomains"]))
        check("viewer summary leaks no other domain or infrastructure", other not in json.dumps(vsum) and "smtp_relay" not in json.dumps(vsum) and "10.1.1" not in json.dumps(vsum), None)
    for path in ("/api/v1/overview", "/api/v1/queue", "/api/v1/alerts", "/api/v1/agents", "/api/v1/users", "/api/v1/settings", "/api/v1/health/history"):
        st, _ = viewer.call("GET", path)
        check("viewer forbidden: " + path, st == 403, st)
    st, _ = viewer.call("POST", "/api/v1/agents", {"name": "evil", "role": "relay"})
    check("viewer cannot create agents", st == 403, st)

    # operator: infrastructure yes, administration no
    oname = "operator-" + SUFFIX
    admin.call("POST", "/api/v1/users", {"username": oname, "role": "operator", "password": "operator-password-1"})
    op = Session()
    viewer2 = op
    op.call("POST", "/api/v1/auth/login", {"username": oname, "password": "operator-password-1"})
    st, _ = op.call("GET", "/api/v1/overview")
    check("operator sees overview", st == 200, st)
    st, oev = op.call("GET", "/api/v1/events?q=" + q1)
    check("operator sees infrastructure fields", st == 200 and any(i["clientIp"] for i in oev["items"]), st)
    st, osum = op.call("GET", "/api/v1/stats/summary?days=7&tz=60")
    check("operator summary includes infrastructure", st == 200 and osum["infrastructure"] is not None and osum["scope"]["domains"] is None, st)
    st, _ = op.call("POST", "/api/v1/agents", {"name": "evil2", "role": "relay"})
    check("operator cannot create agents", st == 403, st)
    st, _ = op.call("GET", "/api/v1/users")
    check("operator cannot list users", st == 403, st)

    # ---- personal access tokens ---------------------------------------------------------------------------
    st, t = viewer.call("POST", "/api/v1/me/tokens", {"name": "ci", "readOnly": True, "expiresInDays": 30})
    check("create PAT", st == 201 and t["token"].startswith("mlp_") and t["item"]["readOnly"] is True, (st, t))
    pat = Session(t["token"])
    st, pme = pat.call("GET", "/api/v1/me")
    check("PAT authenticates as its user", st == 200 and pme["username"] == vname, (st, pme))
    st, pev = pat.call("GET", "/api/v1/events?limit=5")
    check("PAT keeps the viewer scope", st == 200 and all(i["sender"] == "noreply@" + dom for i in pev["items"]), pev)
    st, _ = pat.call("POST", "/api/v1/me/tokens", {"name": "x"})
    check("read-only PAT cannot write", st == 403, st)
    st, _ = Session("mlp_garbage").call("GET", "/api/v1/me")
    check("invalid PAT rejected", st == 401, st)
    st, tl = viewer.call("GET", "/api/v1/me/tokens")
    check("token list hides secret", st == 200 and tl and "token" not in tl[0], tl)
    st, _ = viewer.call("DELETE", "/api/v1/me/tokens/" + t["item"]["id"])
    check("revoke PAT", st == 204, st)
    st, _ = pat.call("GET", "/api/v1/me")
    check("revoked PAT rejected", st == 401, st)

    # ---- user admin guards -------------------------------------------------------------------------------
    st, users = admin.call("GET", "/api/v1/users")
    admins = [u for u in users if u["role"] == "admin" and not u["disabled"]]
    if len(admins) == 1:
        st, _ = admin.call("PUT", "/api/v1/users/" + admins[0]["id"], {"role": "viewer", "domains": ["x.test"]})
        check("cannot demote the last admin", st == 400, st)
        st, _ = admin.call("DELETE", "/api/v1/users/" + admins[0]["id"])
        check("cannot delete yourself / last admin", st == 400, st)
    st, _ = admin.call("PUT", "/api/v1/users/" + vu["id"], {"disabled": True})
    st, _ = viewer.call("GET", "/api/v1/me")
    check("disabling a user kills the session immediately", st == 401, st)

    # ---- passkeys + docs ---------------------------------------------------------------------------------
    st, po = anon.call("GET", "/api/v1/auth/passkey/login/options")
    check("passkey login options", st == 200 and po["options"]["challenge"] and po["requestId"], (st, po))
    st, pr = admin.call("POST", "/api/v1/me/passkeys/options")
    check("passkey registration options", st == 200 and pr["options"]["user"]["name"] == "admin" and pr["options"]["authenticatorSelection"]["residentKey"] == "required", (st, pr))
    st, oa = anon.call("GET", "/openapi/v1.json")
    check("openapi document", st == 200 and "/api/v1/events" in oa["paths"], st)
    st, docs = anon.call("GET", "/api/docs", raw=True)
    check("API docs page", st == 200, st)
    st, ix = anon.call("GET", "/", raw=True)
    check("SPA index served", st == 200 and b"<app-root" in ix.lower() or b"<html" in ix.lower(), st)
    st, nf = anon.call("GET", "/api/v1/nonexistent")
    check("unknown api path is JSON 404", st == 404, (st, nf))


    # ---- version + alert channels -------------------------------------------------------------------------
    st, ver = anon.call("GET", "/api/v1/version")
    check("version endpoint (anonymous)", st == 200 and ver["name"] == "maillog" and ver["version"], (st, ver))
    smtp_host = os.environ.get("E2E_SMTP_HOST")
    fake = None
    if smtp_host:
        fake = FakeSmtp(2525)
        st, ch = admin.call("GET", "/api/v1/settings/channels")
        check("channels default: nothing enabled, no password", st == 200 and not ch["smtp"]["enabled"] and ch["smtp"]["passwordSet"] is False and "password" not in ch["smtp"], (st, ch))
        st, e = admin.call("PUT", "/api/v1/settings/channels", {"smtp": {"enabled": True, "host": "", "from": "a@b.test", "to": ["x@y.test"]}})
        check("enabled smtp without host rejected", st == 400, (st, e))
        st, e = admin.call("PUT", "/api/v1/settings/channels", {"smtp": {"to": ["not-an-email"]}})
        check("invalid recipient rejected", st == 400, (st, e))
        st, e = admin.call("PUT", "/api/v1/settings/channels", {"smtp": {"enabled": True, "host": smtp_host, "port": 2525, "security": "none", "authenticate": True, "username": "u", "from": "a@b.test", "to": ["x@y.test"]}})
        check("auth on without password rejected", st == 400, (st, e))

        # 1) without authentication
        st, saved = admin.call("PUT", "/api/v1/settings/channels", {"smtp": {"enabled": True, "host": smtp_host, "port": 2525, "security": "none",
                               "authenticate": False, "from": "maillog@alerts.test", "fromName": "maillog e2e", "to": ["ops1@example.test", "ops2@example.test"]}})
        check("save smtp (no auth)", st == 200 and saved["smtp"]["enabled"] and saved["smtp"]["to"] == ["ops1@example.test", "ops2@example.test"], (st, saved))
        st, r = admin.call("POST", "/api/v1/settings/channels/smtp/test")
        check("smtp test without auth succeeds", st == 200 and r["ok"], (st, r))
        m = fake.messages[-1] if fake.messages else None
        check("test mail reached the server with sender, both recipients and subject", m is not None and "maillog@alerts.test" in m["from"]
              and len(m["rcpts"]) == 2 and "[TEST]" in m["data"] and not m["authed"], m)

        # 2) with authentication (server now demands it)
        fake.require_auth = True
        st, r = admin.call("POST", "/api/v1/settings/channels/smtp/test")
        check("without auth a server that requires it is reported as error", st == 200 and r["ok"] is False and r["errors"], (st, r))
        st, saved = admin.call("PUT", "/api/v1/settings/channels", {"smtp": {"authenticate": True, "username": "alerts-user", "password": "S3cret-pass word!"}})
        check("save smtp with auth", st == 200 and saved["smtp"]["authenticate"] and saved["smtp"]["passwordSet"] is True and "password" not in saved["smtp"], (st, saved))
        st, r = admin.call("POST", "/api/v1/settings/channels/smtp/test")
        check("smtp test with auth succeeds", st == 200 and r["ok"], (st, r))
        check("server received exactly the configured credentials", fake.auths and fake.auths[-1] == ("alerts-user", "S3cret-pass word!"), fake.auths)
        check("authenticated mail delivered", fake.messages and fake.messages[-1]["authed"], fake.messages[-1:] )

        # 3) unsaved form values can be tested, stored config stays untouched
        st, r = admin.call("POST", "/api/v1/settings/channels/smtp/test", {"host": smtp_host, "port": 1})
        check("test with unsaved wrong port fails", st == 200 and r["ok"] is False, (st, r))
        st, again = admin.call("GET", "/api/v1/settings/channels")
        check("unsaved test did not change the stored port", again["smtp"]["port"] == 2525 and again["smtp"]["passwordSet"], again)
        st, r = admin.call("PUT", "/api/v1/settings/channels", {"smtp": {"username": "renamed"}})
        st, r2 = admin.call("POST", "/api/v1/settings/channels/smtp/test")
        check("changing the user keeps the stored password", r2["ok"] and fake.auths[-1] == ("renamed", "S3cret-pass word!"), (r2, fake.auths[-1:]))
        st, e = admin.call("PUT", "/api/v1/settings/channels", {"smtp": {"clearPassword": True}})
        check("clearing the password while auth is on is rejected", st == 400, (st, e))
        st, sv = admin.call("GET", "/api/v1/settings")
        check("settings reports smtp channel ready", st == 200 and sv["channels"]["smtp"] is True, sv)
        st, sg = admin.call("POST", "/api/v1/settings/channels/signal/test")
        check("signal test without config explains what is missing", st == 200 and sg["ok"] is False and sg["errors"], sg)
        st, wh = admin.call("PUT", "/api/v1/settings/channels", {"webhook": {"enabled": True, "url": "ftp://x"}})
        check("webhook url must be http(s)", st == 400, (st, wh))
        before = len(fake.messages)
        st, tn = admin.call("POST", "/api/v1/settings/test-notification")
        check("test-notification goes to enabled channels", st == 200 and tn["ok"] and len(fake.messages) == before + 1, (tn, len(fake.messages) - before))
    st, _ = viewer2.call("GET", "/api/v1/settings/channels") if viewer2 else (403, None)
    check("operator cannot read channel settings", st == 403, st)

    # ---- settings + retention ----------------------------------------------------------------------------
    st, s = admin.call("GET", "/api/v1/settings")
    check("settings default retention is 180", st == 200 and s["retentionDays"] == 180, s)
    st, _ = admin.call("PUT", "/api/v1/settings", {"retentionDays": 0})
    check("retention validation", st == 400, st)
    st, s = admin.call("PUT", "/api/v1/settings", {"retentionDays": 90})
    check("retention can be changed", st == 200 and s["retentionDays"] == 90, s)
    st, old = admin.call("GET", "/api/v1/events?all=true&q=9.9.9.9")
    check("old event exists before retention run", st == 200 and len(old["items"]) == 1, old)

    if "--wait-alerts" in sys.argv:
        print("waiting ~100 s for alert evaluation and the first retention run ...")
        time.sleep(100)
        st, al = admin.call("GET", "/api/v1/alerts")
        keys = {a["key"].split(":")[0] + ":" + (a["key"].split(":")[-1] if a["key"].startswith("check") else "") for a in al}
        titles = [a["title"] for a in al if name in a["title"]]
        check("alert for failing saslauthd check", any("saslauthd failing" in t for t in titles), titles)
        check("alert for SASL backend generic failure", any("SASL authentication backend" in a["title"] for a in al if a["agentName"] == name), [a["title"] for a in al])
        check("alert for foreign sender domain", any("without DKIM key" in a["title"] for a in al), [a["title"] for a in al])
        check("alert for fail2ban ban", any("banned 203.0.113.9" in a["title"] for a in al), [a["title"] for a in al])
        if fake is not None:
            subjects = [m["data"] for m in fake.messages]
            check("alert mails were sent through the configured SMTP server", any("[CRITICAL]" in d and "saslauthd failing" in d for d in subjects), [d[:120] for d in subjects][-3:])
        st, act = admin.call("GET", "/api/v1/actions")
        check("recovery action stored", st == 200 and any(a["action"] == "systemctl restart postfix" for a in act), act[:2] if st == 200 else act)
        # recover the check and expect the alert to resolve
        report["checks"][0] = {"name": "saslauthd", "state": "ok", "message": "recovered after restart"}
        report["actions"] = []
        agent.call("POST", "/agent-api/v1/health", report)
        out.call("POST", "/agent-api/v1/health", {"version": "e2e", "checks": [{"name": "postfix", "state": "ok", "message": "ok"}]})
        time.sleep(40)
        st, al2 = admin.call("GET", "/api/v1/alerts")
        check("check alert resolves after recovery", not any("saslauthd failing" in a["title"] for a in al2 if a["agentName"] == name), [a["title"] for a in al2])
        st, old = admin.call("GET", "/api/v1/events?all=true&q=9.9.9.9")
        check("retention deleted the 2020 event", st == 200 and old["items"] == [], old)
        st, hh = admin.call("GET", "/api/v1/health/history?agent=" + name)
        check("health history recorded state changes", st == 200 and len(hh) >= 2, hh)

    # cleanup
    admin.call("DELETE", "/api/v1/agents/" + created["agent"]["id"])
    admin.call("DELETE", "/api/v1/agents/" + c2["agent"]["id"])
    for u in (vu, ):
        admin.call("DELETE", "/api/v1/users/" + u["id"])
    st, users = admin.call("GET", "/api/v1/users")
    for u in users:
        if u["username"] == oname:
            admin.call("DELETE", "/api/v1/users/" + u["id"])

    print("\n%d failed" % len(FAILS) if FAILS else "\nALL PASSED")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
