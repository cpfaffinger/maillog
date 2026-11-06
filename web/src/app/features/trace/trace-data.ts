import { MailEvent } from '../../api/models';
import { fmtSeconds } from '../../shared/chart-utils';

// Pure helpers behind the Trace page: grouping events into messages, final status, readable sentences, journey.

export type MessageStatus = 'sent' | 'deferred' | 'bounced' | 'rejected' | 'queued';

export interface Hop {
  key: string;
  /** Server name; viewers get the role instead (agent names are hidden for them). */
  label: string;
  role: string | null;
  queueId: string | null;
  first: number;
  last: number;
  events: MailEvent[];
  handedTo: string[];
}

export interface Recipient {
  to: string;
  status: MessageStatus;
  relay: string | null;
  dsn: string | null;
  detail: string | null;
  ts: number;
  by: string | null;
}

export interface TraceMessage {
  id: string;
  hops: Hop[];
  events: MailEvent[];
  firstTs: number;
  lastTs: number;
  firstQueueId: string | null;
  sender: string | null;
  recipients: Recipient[];
  status: MessageStatus;
  /** Last final outcome event (delivery without hand-over, or a reject). */
  finalEvent: MailEvent | null;
  client: { saslUser: string | null; clientHost: string | null; clientIp: string | null } | null;
  /** Seconds from the first event to the last successful final delivery. */
  totalTimeS: number | null;
}

const TECHNICAL = new Set(['connect', 'disconnect', 'meta', 'info']);

export function isTechnical(e: MailEvent): boolean {
  return TECHNICAL.has(e.kind);
}

function hopKeyOf(e: MailEvent): string {
  if (!e.queueId || e.queueId === 'NOQUEUE') return `ev:${e.id}`;
  return `${e.agentId ?? e.agentRole ?? ''}|${e.queueId}`;
}

function byTime(a: MailEvent, b: MailEvent): number {
  return a.ts - b.ts || a.id - b.id;
}

/** One hop = all events of one queue id on one server. Events without a queue id form their own hop. */
export function groupHops(events: MailEvent[]): Hop[] {
  const map = new Map<string, Hop>();
  for (const e of [...events].sort(byTime)) {
    const key = hopKeyOf(e);
    let hop = map.get(key);
    if (!hop) {
      hop = {
        key, label: e.agentName ?? e.agentRole ?? 'hop', role: e.agentRole, queueId: key.startsWith('ev:') ? null : e.queueId,
        first: e.ts, last: e.ts, events: [], handedTo: [],
      };
      map.set(key, hop);
    }
    hop.events.push(e);
    hop.last = Math.max(hop.last, e.ts);
    if (e.nextQueueId && !hop.handedTo.includes(e.nextQueueId)) hop.handedTo.push(e.nextQueueId);
  }
  return [...map.values()].sort((a, b) => a.first - b.first);
}

export function normalizeStatus(s: string | null | undefined): MessageStatus {
  switch (s) {
    case 'sent': return 'sent';
    case 'deferred': return 'deferred';
    case 'bounced': case 'expired': return 'bounced';
    case 'reject': case 'rejected': return 'rejected';
    default: return 'queued';
  }
}

class UnionFind {
  private readonly parent = new Map<string, string>();
  add(x: string): void {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }
  find(x: string): string {
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r) as string;
    let c = x;
    while (c !== r) {
      const next = this.parent.get(c) as string;
      this.parent.set(c, r);
      c = next;
    }
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

/** Groups hops into messages: a hop that handed mail over as queue id X belongs to the message of the hop with queue id X. */
export function groupMessages(events: MailEvent[]): TraceMessage[] {
  const hops = groupHops(events);
  const uf = new UnionFind();
  const byQueue = new Map<string, Hop[]>();
  for (const h of hops) {
    uf.add(h.key);
    if (h.queueId) byQueue.set(h.queueId, [...(byQueue.get(h.queueId) ?? []), h]);
  }
  for (const h of hops) {
    for (const next of h.handedTo) {
      for (const target of byQueue.get(next) ?? []) if (target.key !== h.key) uf.union(h.key, target.key);
    }
  }
  const groups = new Map<string, Hop[]>();
  for (const h of hops) {
    const root = uf.find(h.key);
    groups.set(root, [...(groups.get(root) ?? []), h]);
  }
  return [...groups.values()].map(buildMessage).sort((a, b) => b.firstTs - a.firstTs);
}

function isFinalOutcome(e: MailEvent): boolean {
  return (e.kind === 'delivery' && !e.nextQueueId) || e.kind === 'reject';
}

function buildMessage(hops: Hop[]): TraceMessage {
  hops = [...hops].sort((a, b) => a.first - b.first);
  const events = hops.flatMap((h) => h.events).sort(byTime);
  const firstTs = events[0].ts;
  const by = (e: MailEvent) => e.agentName ?? e.agentRole;

  const perRecipient = new Map<string, { final: MailEvent | null; handover: boolean }>();
  for (const e of events) {
    if (e.kind !== 'delivery' && e.kind !== 'reject') continue;
    const to = e.recipient ?? '–';
    const cur = perRecipient.get(to) ?? { final: null, handover: false };
    if (isFinalOutcome(e)) cur.final = e;
    else cur.handover = true;
    perRecipient.set(to, cur);
  }
  const recipients: Recipient[] = [...perRecipient].map(([to, v]) => {
    const e = v.final;
    return e
      ? { to, status: normalizeStatus(e.kind === 'reject' ? 'reject' : e.status), relay: e.relay, dsn: e.dsn, detail: e.detail, ts: e.ts, by: by(e) }
      : { to, status: 'queued' as MessageStatus, relay: null, dsn: null, detail: null, ts: firstTs, by: null };
  });

  const finals = events.filter(isFinalOutcome);
  const finalEvent = finals.length > 0 ? finals[finals.length - 1] : null;

  let status: MessageStatus = 'queued';
  const states = recipients.map((r) => r.status);
  if (states.includes('bounced')) status = 'bounced';
  else if (states.includes('rejected')) status = 'rejected';
  else if (states.includes('deferred')) status = 'deferred';
  else if (states.length > 0 && states.every((s) => s === 'sent')) status = 'sent';

  const sentTimes = recipients.filter((r) => r.status === 'sent').map((r) => r.ts);
  const accepted = events.find((e) => e.kind === 'accepted' && (e.saslUser || e.clientIp || e.clientHost));
  const sender = events.find((e) => e.kind === 'queued' && e.sender)?.sender ?? events.find((e) => e.sender)?.sender ?? null;

  return {
    id: hops[0].key,
    hops,
    events,
    firstTs,
    lastTs: events[events.length - 1].ts,
    firstQueueId: hops[0].queueId,
    sender,
    recipients,
    status,
    finalEvent,
    client: accepted ? { saslUser: accepted.saslUser, clientHost: accepted.clientHost, clientIp: accepted.clientIp } : null,
    totalTimeS: status === 'sent' && sentTimes.length > 0 ? (Math.max(...sentTimes) - firstTs) / 1000 : null,
  };
}

// ---- readable text -------------------------------------------------------------------------------------------

/** "mx.y.com[1.2.3.4]:25" -> "mx.y.com". */
export function relayHost(relay: string | null | undefined): string | null {
  if (!relay) return null;
  const i = relay.indexOf('[');
  const host = (i > 0 ? relay.slice(0, i) : relay.replace(/:\d+$/, '')).trim();
  return host || null;
}

function clip(s: string, n = 120): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export function deferReason(detail: string | null | undefined): string {
  const d = detail ?? '';
  if (/mailbox (is )?full|over ?quota|out of storage|quota exceeded|OverQuota/i.test(d)) return 'recipient mailbox full';
  if (/greylist|try again later|temporarily (deferred|rejected)|\b4\.7\.\d/i.test(d)) return 'recipient server asked to try again later (greylisting or rate limit)';
  if (/rate limit|too many/i.test(d)) return 'rate limit at the recipient server';
  if (/connection refused/i.test(d)) return 'recipient server refused the connection';
  if (/timed? ?out|timeout/i.test(d)) return 'recipient server did not answer in time';
  if (/host not found|name service error|domain not found|nxdomain/i.test(d)) return 'recipient domain could not be found';
  return d ? clip(d) : 'reason unknown';
}

export function bounceReason(detail: string | null | undefined): string {
  const d = detail ?? '';
  if (/user unknown|no such user|unknown user|does not exist|mailbox unavailable|\b5\.1\.1\b/i.test(d)) return 'user unknown';
  if (/mailbox (is )?full|quota/i.test(d)) return 'mailbox full';
  if (/spam|blocked|blacklist|blocklist|reputation|denied|policy/i.test(d)) return 'blocked as spam or by policy';
  return d ? clip(d) : 'reason unknown';
}

/** Short duration between two steps: "+0.2 s", "+340 ms", "+1m 5s". */
export function fmtDelta(ms: number): string {
  const v = Math.max(0, ms);
  if (v < 1000) return `+${Math.round(v)} ms`;
  return `+${fmtSeconds(v / 1000)}`;
}

/** The plain-language outcome sentence of a message. */
export function describeFinal(m: TraceMessage): string {
  const e = m.finalEvent;
  const who = e ? (e.agentName ?? e.agentRole ?? 'the server') : 'the server';
  switch (m.status) {
    case 'sent': {
      const many = m.recipients.length > 1 ? ` (${m.recipients.length} recipients)` : '';
      return `Delivered to the recipient's server by ${who} after ${fmtSeconds(m.totalTimeS)}${many}`;
    }
    case 'deferred': {
      const d = [...m.recipients].reverse().find((r) => r.status === 'deferred');
      return `Postponed: ${deferReason(d?.detail ?? e?.detail)}, retrying`;
    }
    case 'bounced': {
      const b = [...m.recipients].reverse().find((r) => r.status === 'bounced');
      return `Rejected (${[b?.dsn ?? e?.dsn, bounceReason(b?.detail ?? e?.detail)].filter(Boolean).join(' ')})`;
    }
    case 'rejected':
      return `Rejected at submission: ${e?.detail ? clip(e.detail, 160) : 'refused by the mail server'}`;
    default:
      return 'Still in the queue: no final delivery recorded yet';
  }
}

export function sizeFromDetail(detail: string | null): string | null {
  const m = /size=(\d+)/.exec(detail ?? '');
  if (!m) return null;
  const b = Number(m[1]);
  return b >= 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`;
}

/** One readable line per event for the timeline. */
export function describeEvent(e: MailEvent): string {
  const next = e.nextQueueId;
  switch (e.kind) {
    case 'queued': {
      const size = sizeFromDetail(e.detail);
      return `Accepted into the queue${e.sender ? ` from ${e.sender}` : ''}${size ? ` (${size})` : ''}`;
    }
    case 'accepted': {
      const from = e.clientHost || e.clientIp;
      return `Received${from ? ` from ${from}` : ''}${e.saslUser ? ` as ${e.saslUser}` : ''}`;
    }
    case 'delivery': {
      const host = relayHost(e.relay);
      if (next) return `Handed over${host ? ` to ${host}` : ''} as queue ${next}`;
      if (e.status === 'sent') return `Delivered${e.recipient ? ` to ${e.recipient}` : ''}${host ? ` via ${host}` : ''}`;
      if (e.status === 'deferred') return `Delivery${e.recipient ? ` to ${e.recipient}` : ''} postponed: ${deferReason(e.detail)}`;
      if (e.status === 'expired') return `Gave up${e.recipient ? ` on ${e.recipient}` : ''}: message expired in the queue`;
      return `Delivery${e.recipient ? ` to ${e.recipient}` : ''} failed: ${[e.dsn, bounceReason(e.detail)].filter(Boolean).join(' ')}`;
    }
    case 'reject':
      return `Rejected: ${e.detail ? clip(e.detail, 160) : 'refused by the mail server'}`;
    case 'dkim_signed':
    {
      const params = (e.detail ?? '').replace(/^DKIM-Signature field added\s*/, '').replace(/^\((.*)\)$/, '$1');
      return `DKIM signature added${params ? ` (${clip(params, 80)})` : ''}`;
    }
    case 'connect': return `Connection from ${e.clientHost || e.clientIp || 'client'}`;
    case 'disconnect': return `Disconnected${e.detail ? ` (${clip(e.detail, 80)})` : ''}`;
    default:
      return e.detail ? clip(e.detail, 160) : e.kind;
  }
}

// ---- journey strip ---------------------------------------------------------------------------------------------

export type NodeState = MessageStatus | 'ok';

export interface JourneyNode {
  label: string;
  sub: string | null;
  state: NodeState;
  icon: string;
}

export function stateIcon(s: NodeState): string {
  switch (s) {
    case 'sent': case 'ok': return 'check_circle';
    case 'deferred': return 'schedule';
    case 'bounced': return 'error';
    case 'rejected': return 'block';
    default: return 'hourglass_empty';
  }
}

function hopState(h: Hop): NodeState {
  for (let i = h.events.length - 1; i >= 0; i--) {
    const e = h.events[i];
    if (e.kind === 'reject') return 'rejected';
    if (e.kind === 'delivery') return e.nextQueueId ? 'sent' : normalizeStatus(e.status);
  }
  return 'queued';
}

/** Client -> server(s) -> recipient server. */
export function buildJourney(m: TraceMessage): JourneyNode[] {
  const nodes: JourneyNode[] = [];
  const c = m.client;
  nodes.push({
    label: c?.saslUser ?? c?.clientHost ?? c?.clientIp ?? 'Sender',
    sub: c?.saslUser && (c.clientHost || c.clientIp) ? (c.clientHost ?? c.clientIp) : m.sender,
    state: 'ok',
    icon: 'computer',
  });
  for (const h of m.hops) {
    const s = hopState(h);
    nodes.push({ label: h.label, sub: h.role, state: s, icon: stateIcon(s) });
  }
  const rejectedAtSubmission = m.status === 'rejected' && m.finalEvent?.kind === 'reject';
  if (!rejectedAtSubmission) {
    const final = [...m.recipients].reverse().find((r) => r.relay) ?? null;
    nodes.push({
      label: relayHost(final?.relay) ?? 'Recipient server',
      sub: m.recipients[0]?.to.split('@')[1] ?? null,
      state: m.status,
      icon: stateIcon(m.status),
    });
  }
  return nodes;
}

// ---- timeline view model -----------------------------------------------------------------------------------------

export interface EventRow {
  event: MailEvent;
  text: string;
  /** Time since the previously shown event of the message ("+0.2 s"); null for the first. */
  delta: string | null;
}

export interface HopView {
  hop: Hop;
  rows: EventRow[];
  hiddenCount: number;
  /** Text of the connector leading to the next hop (null for the last). */
  connector: string | null;
}

export function buildHopViews(m: TraceMessage, showTechnical: boolean): HopView[] {
  let prev: number | null = null;
  return m.hops.map((hop, i) => {
    const shown = hop.events.filter((e) => showTechnical || !isTechnical(e));
    const rows = shown.map((event) => {
      const delta = prev === null ? null : fmtDelta(event.ts - prev);
      prev = event.ts;
      return { event, text: describeEvent(event), delta };
    });
    const nextHop = m.hops[i + 1];
    let connector: string | null = null;
    if (nextHop) {
      const q = hop.handedTo.find((id) => id === nextHop.queueId) ?? hop.handedTo[0];
      connector = q ? `handed over to ${nextHop.label} as ${q}` : `continues at ${nextHop.label}`;
    }
    return { hop, rows, hiddenCount: hop.events.length - shown.length, connector };
  });
}

// ---- recent searches ---------------------------------------------------------------------------------------------

export function addRecent(list: string[], q: string, max = 5): string[] {
  const t = q.trim();
  if (!t) return list;
  return [t, ...list.filter((x) => x !== t)].slice(0, max);
}
