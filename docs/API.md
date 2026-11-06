# maillog HTTP API (user API)

Base path `/api/v1`. JSON, camelCase. Timestamps are Unix epoch **milliseconds** (UTC).
The machine-readable OpenAPI 3 document is served at `/openapi/v1.json`, interactive docs at `/api/docs`.

## Authentication

Two ways, both resolve to the same user + role:

* **Session cookie** (`maillog.auth`, HttpOnly, SameSite=Strict): created by `POST /auth/login` (username + password) or `POST /auth/passkey/login` (WebAuthn).
* **Personal access token (PAT)**: `Authorization: Bearer mlp_...`. Created under *My account → Access tokens* or `POST /me/tokens`.
  A token can be `readOnly` (then only `GET` is allowed) and can expire. It carries the role and domain scope of its user.

Errors: `401` not authenticated, `403` role not allowed, `404`, `400 {"error":"..."}` for validation, `429` login throttling.

## Roles (RBAC)

| role | sees | may change |
|------|------|------------|
| `admin` | everything | everything (users, agents, settings, tokens of others are not visible) |
| `operator` | everything incl. infrastructure data (overview, queue, alerts, health, agents read-only) | only own account/passkeys/tokens |
| `viewer` | **only mail whose envelope sender domain is in the user's `domains`** (events, trace, stats). No agents, no infrastructure fields (`agentId`, `agentName`, `clientIp`, `clientHost`, `saslUser`, `raw` are always `null` for viewers) | only own account/passkeys/tokens |

The default user is `admin`: created on the first start with a random password (logged once and written to `initial-admin-password.txt` in the data folder).

## Common shapes

```jsonc
// User (as returned by /me and /users)
{ "id":"..", "username":"admin", "displayName":"Administrator", "role":"admin|operator|viewer",
  "domains":["customer-a.example"], "disabled":false, "createdAt":1730000000000, "lastLogin":1730000000000|null,
  "mustChangePassword":false, "passkeyCount":1 }

// Event
{ "id":123, "agentId":"..", "agentName":"mailout", "agentRole":"outbound", "ts":1730000000000, "source":"mail|fail2ban",
  "program":"postfix/smtp", "queueId":"9C2197F869", "kind":"queued|delivery|accepted|reject|auth_fail|ratelimit|connect|disconnect|conn_error|foreign_sender|dkim_signed|ban|unban|f2b_found|sasl_authd_fail|error|service|meta|info",
  "sender":"a@b.at", "recipient":"x@y.com", "clientIp":"1.2.3.4", "clientHost":"host", "saslUser":"smtp_relay_x",
  "relay":"mx.y.com[1.2.3.4]:25", "status":"sent|deferred|bounced|expired|reject|...", "dsn":"2.0.0",
  "nextQueueId":"AAAB15FA5C", "delayS":0.16, "detail":"...", "raw":"..." }

// Alert
{ "id":1, "key":"check:<agentId>:saslauthd", "agentId":"..", "agentName":"smtp2", "severity":"critical|warning|info",
  "title":"smtp2: saslauthd failing", "body":"...", "openedAt":.., "resolvedAt":null }

// Health check
{ "name":"saslauthd", "state":"ok|warn|fail", "message":"active", "since":.., "updated":.. }
```

## Auth & account

| method path | role | body → result |
|---|---|---|
| `POST /auth/login` | – | `{username,password}` → `{user}`; sets cookie |
| `POST /auth/logout` | any | → 204 |
| `GET /auth/passkey/login/options` | – | → `{requestId, options}`; `options` is a `PublicKeyCredentialRequestOptionsJSON` (discoverable credentials, empty allow list) |
| `POST /auth/passkey/login` | – | `{requestId, credential}` (`credential` = the JSON of the `PublicKeyCredential` assertion) → `{user}`; sets cookie |
| `GET /me` | any | → User |
| `POST /me/password` | any | `{currentPassword,newPassword}` → 204 (min length 12) |
| `GET /me/passkeys` | any | → `[{id,name,createdAt,lastUsed}]` |
| `POST /me/passkeys/options` | any | → `{requestId, options}`; `options` is `PublicKeyCredentialCreationOptionsJSON` |
| `POST /me/passkeys` | any | `{requestId,name,credential}` → 201 `{id,name,createdAt,lastUsed}` |
| `DELETE /me/passkeys/{id}` | any | → 204 |
| `GET /me/tokens` | any | → `[{id,name,prefix,readOnly,createdAt,expiresAt,lastUsed}]` |
| `POST /me/tokens` | any | `{name,readOnly,expiresInDays?}` → 201 `{token:"mlp_...", item:{...}}` (plain token only returned once) |
| `DELETE /me/tokens/{id}` | any | → 204 (revoke) |

WebAuthn JSON note: binary fields (`challenge`, `id`, `rawId`, `user.id`, `clientDataJSON`, `attestationObject`,
`authenticatorData`, `signature`, `userHandle`, credential ids) are **base64url strings**, i.e. the
WebAuthn Level 3 JSON representation (`PublicKeyCredential.toJSON()` /
`PublicKeyCredential.parseCreationOptionsFromJSON()`); browsers without those helpers need a manual conversion.

## Users (admin)

| method path | body → result |
|---|---|
| `GET /users` | → `[User]` |
| `POST /users` | `{username,displayName,role,domains[],password}` → 201 User (`domains` required and non-empty for `viewer`) |
| `PUT /users/{id}` | `{displayName,role,domains[],disabled,password?}` → User (cannot disable/demote the last admin) |
| `DELETE /users/{id}` | → 204 (cannot delete yourself or the last admin) |

## Mail data

| method path | role | notes |
|---|---|---|
| `GET /events` | any | query: `agent` (id or name), `kind` (comma list), `q` (queue id, address fragment, IP, SASL user), `from`,`to` (ms), `before` (event id for paging), `limit` (≤1000, default 200), `all=true` (include noisy kinds `connect, disconnect, meta, info`). → `{items:[Event], nextBefore: id|null}` newest first. Viewers: only events of agents with role `outbound` (the final hop), whose sender domain is in their domains, only kinds `queued, delivery, accepted, reject, dkim_signed` |
| `GET /trace?q=` | any | follows a message across hops via `queueId` ↔ `nextQueueId`. → `{events:[Event]}` oldest first (same scoping rules as `/events`) |
| `GET /stats?hours=48` | any | hourly counters → `{hours, rows:[{agentId, hour, sent, deferred, bounced, rejected, authFail, rateLimit}]}`. Viewers: only final deliveries of agents with role `outbound`, `agentId` is `null`, summed per hour for their domains |
| `GET /overview` | operator+ | → `{now, offlineAfterS, agents:[{id,name,role,hostname,version,lastSeen,enrolledAt,pendingEnrollment,checks:[Health check],stats24h:{sent,deferred,bounced,rejected,authFail,rateLimit},queue:Queue|null}], alerts:[Alert]}` |
| `GET /queue?hours=24` | operator+ | → `{agents:[{id,name,role,current:Queue|null,series:[{ts,total,deferred,oldestAgeS}]}]}` |
| `GET /alerts?state=open\|all&limit=200` | operator+ | → `[Alert]` |
| `GET /health/history?agent=&limit=200` | operator+ | → `[{agentId,agentName,name,state,message,ts}]` state changes, newest first |
| `GET /actions?limit=100` | operator+ | auto-recovery actions done by agents → `[{id,agentId,agentName,ts,name,action,ok,result}]` |

```jsonc
// Queue (postfix mail queue snapshot reported by the agent).
// oldestAgeS = oldest message overall (deferred mail can legitimately wait for days);
// oldestActiveAgeS = oldest message in the active/incoming queue, i.e. mail that should be moving.
{ "ts":.., "total":34, "active":2, "deferred":30, "hold":0, "incoming":2, "oldestAgeS":5400, "oldestActiveAgeS":40,
  "topSenderDomains":[{"name":"customer-a.example","count":20}],
  "topRecipientDomains":[{"name":"gmail.com","count":12}],
  "topReasons":[{"name":"452 4.2.2 mailbox full","count":9}] }
```

## Agents (admin; operator may read)

| method path | body → result |
|---|---|
| `GET /agents` | → `[{id,name,role,hostname,version,lastSeen,lastIp,createdAt,enrolledAt,enrollExpires,pendingEnrollment,intervalS,checks:[...],logs:[...]}]` |
| `POST /agents` | `{name,role}` (`role`: `relay|outbound|inbound|generic`) → 201 `{agent, enrollToken, installCommand, expiresAt}` |
| `POST /agents/{id}/enroll` | → `{enrollToken, installCommand, expiresAt}` (new single-use token, e.g. to reinstall) |
| `PUT /agents/{id}/config` | `{intervalS, checks:[...], logs:[...]}` → agent (see agent protocol for the check types) |
| `DELETE /agents/{id}` | → 204 |

`installCommand` looks like `curl -fsSL https://maillog.example.com/install.sh | sudo bash -s -- --enroll mle_...`.

## Settings (admin)

| method path | body → result |
|---|---|
| `GET /settings` | → `{retentionDays, eventCount, oldestEventTs, channels:{webhook,signal,smtp}, publicUrl, passkeysAvailable}` |
| `PUT /settings` | `{retentionDays}` (1..3650) → same as GET. Events older than `retentionDays` are deleted automatically (default 180) |
| `POST /settings/test-notification` | → `{ok, errors:[string]}` |

### Alert channels (admin)

Alert delivery is configured in the database (UI: *Settings → Alert channels*), not in environment variables.
Use an SMTP server that does not depend on the mail system you monitor.

| method path | body → result |
|---|---|
| `GET /settings/channels` | → `{smtp:{enabled,host,port,security:"none\|starttls\|ssl",authenticate,username,passwordSet,from,fromName,to:[...]}, signal:{enabled,url,number,recipients:[...]}, webhook:{enabled,url,format:"json\|slack\|discord\|ntfy"}}` (the password is never returned) |
| `PUT /settings/channels` | same shape; fields that are omitted/null keep their stored value. `smtp.password` sets a new password, `smtp.clearPassword:true` deletes it. Passwords are stored encrypted. → saved config, or `400 {error}` |
| `POST /settings/channels/{smtp\|signal\|webhook}/test` | optional body with (unsaved) values of that channel, e.g. `{"host":"...","port":587}`; missing fields fall back to the stored config. Sends a real test message → `{ok, errors:[...]}` |

### System

| method path | role | result |
|---|---|---|
| `GET /version` | anonymous | `{name, version, commit}` (`commit` is the short git revision the image was built from, or `null`) |


### Statistics summary

`GET /stats/summary?days=30&tz=60` (all roles, RBAC-scoped, cached for 30 s). `days` 1..365, `tz` = UTC offset of the client in minutes (day and hour buckets are local).
"sent" counts deliveries on the final hop (agents with role `outbound`, or all agents when none exists); "deferred" counts postponed delivery attempts.

```jsonc
{ "days":30, "tz":60, "from":.., "to":..,
  "scope": { "domains": ["customer-a.example"] | null },            // non-null for viewers
  "totals": { "sent":0, "deferred":0, "bounced":0, "rejected":0, "deliveredPct":98.2|null, "avgDelayS":1.2|null, "p95DelayS":3.4|null },
  "daily": [ { "day":.., "sent":0, "deferred":0, "bounced":0, "rejected":0, "avgDelayS":1.2|null, "p95DelayS":3.4|null } ],   // zero-filled, oldest first
  "hourOfDay": [ { "hour":0, "sent":0 } ],                           // 24 entries
  "topSenderDomains": [ { "name":"customer-a.example", "sent":0, "deferred":0, "bounced":0 } ],
  "topRecipientDomains": [ { "name":"gmail.com", "sent":0, "deferred":0, "bounced":0 } ],
  "bounceReasons": [ { "dsn":"5.1.1", "reason":"User unknown", "count":0 } ],
  "infrastructure": null | { "byAgent":[{"agentId","agentName","role","sent","deferred","bounced","rejected","accepted"}],
                             "topSaslUsers":[{"name","count"}], "topClients":[{"name","count"}],
                             "authFailuresDaily":[{"day","authFail","genericFailures"}] } }   // null for viewers
```

`GET /queue` series points additionally carry `active`.
