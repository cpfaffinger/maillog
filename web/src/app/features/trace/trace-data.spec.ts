import { MailEvent } from '../../api/models';
import {
  addRecent, bounceReason, buildHopViews, buildJourney, deferReason, describeEvent, describeFinal, fmtDelta,
  groupMessages, normalizeStatus, relayHost, sizeFromDetail,
} from './trace-data';

let nextId = 1;
const T0 = Date.UTC(2026, 10, 6, 10, 0, 0);

function ev(p: Partial<MailEvent>): MailEvent {
  return {
    id: nextId++, agentId: 'a1', agentName: 'smtp2', agentRole: 'relay', ts: T0, source: 'mail', program: null, queueId: 'Q1',
    kind: 'info', sender: null, recipient: null, clientIp: null, clientHost: null, saslUser: null, relay: null,
    status: null, dsn: null, nextQueueId: null, delayS: null, detail: null, raw: null, ...p,
  };
}

const mailout = { agentId: 'a2', agentName: 'mailout', agentRole: 'outbound' as const };

/** smtp2 Q1 -> mailout Q2 -> recipient server. */
function chain(offsetMs = 0, q1 = 'Q1', q2 = 'Q2', to = 'r@example.com'): MailEvent[] {
  const t = T0 + offsetMs;
  return [
    ev({ ts: t, queueId: q1, kind: 'accepted', clientHost: 'srv-danceplus-prd', clientIp: '168.119.168.66', saslUser: 'smtp_relay_danceplus_prd' }),
    ev({ ts: t + 20, queueId: q1, kind: 'queued', sender: 'noreply@danceplus.at', detail: 'size=38617 nrcpt=1' }),
    ev({ ts: t + 200, queueId: q1, kind: 'delivery', recipient: to, relay: '192.168.234.72[192.168.234.72]:25', status: 'sent', nextQueueId: q2, detail: '250 queued as ' + q2 }),
    ev({ ...mailout, ts: t + 210, queueId: q2, kind: 'queued', sender: 'noreply@danceplus.at' }),
    ev({ ...mailout, ts: t + 300, queueId: q2, kind: 'dkim_signed', detail: 'DKIM-Signature field added (s=x, d=danceplus.at)' }),
    ev({ ...mailout, ts: t + 1300, queueId: q2, kind: 'delivery', recipient: to, relay: 'mx.example.com[1.2.3.4]:25', status: 'sent', dsn: '2.0.0' }),
    ev({ ...mailout, ts: t + 1400, queueId: q2, kind: 'meta', detail: 'removed' }),
  ];
}

describe('groupMessages', () => {
  it('connects a smtp2 -> mailout chain into one message and keeps an unrelated message apart', () => {
    const other = [
      ev({ ...mailout, ts: T0 + 60_000, queueId: 'Q9', kind: 'queued', sender: 'other@go-active.at' }),
      ev({ ...mailout, ts: T0 + 61_000, queueId: 'Q9', kind: 'delivery', recipient: 'x@gmail.com', status: 'deferred', detail: '452 4.2.2 mailbox is full' }),
    ];
    const msgs = groupMessages([...other, ...chain()]);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].firstQueueId).toBe('Q9');
    const m = msgs[1];
    expect(m.hops.map((h) => h.label)).toEqual(['smtp2', 'mailout']);
    expect(m.hops.map((h) => h.queueId)).toEqual(['Q1', 'Q2']);
    expect(m.sender).toBe('noreply@danceplus.at');
    expect(m.status).toBe('sent');
    expect(m.recipients).toHaveLength(1);
    expect(m.totalTimeS).toBeCloseTo(1.3, 5);
    expect(m.client?.saslUser).toBe('smtp_relay_danceplus_prd');
    expect(msgs[0].status).toBe('deferred');
  });

  it('is independent of the order of the input and of unrelated chains', () => {
    const a = chain(0, 'QA1', 'QA2', 'a@x.com');
    const b = chain(10_000, 'QB1', 'QB2', 'b@x.com');
    const msgs = groupMessages([...b, ...a].reverse());
    expect(msgs).toHaveLength(2);
    expect(msgs.map((m) => m.recipients[0].to)).toEqual(['b@x.com', 'a@x.com']);
    expect(msgs.every((m) => m.hops.length === 2)).toBe(true);
  });

  it('treats a hand-over without outcome as still queued', () => {
    const msgs = groupMessages(chain().slice(0, 3));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].status).toBe('queued');
    expect(msgs[0].totalTimeS).toBeNull();
    expect(describeFinal(msgs[0])).toMatch(/Still in the queue/);
  });

  it('keeps events without a usable queue id as separate rejected messages', () => {
    const msgs = groupMessages([
      ev({ queueId: 'NOQUEUE', kind: 'reject', status: 'reject', sender: 'a@b.at', recipient: 'c@d.at', detail: '554 5.7.1 Relay access denied' }),
      ev({ queueId: 'NOQUEUE', ts: T0 + 5, kind: 'reject', status: 'reject', recipient: 'e@f.at', detail: '554 5.7.1 Relay access denied' }),
    ]);
    expect(msgs).toHaveLength(2);
    expect(msgs.every((m) => m.status === 'rejected')).toBe(true);
    expect(describeFinal(msgs[0])).toContain('Rejected at submission');
  });

  it('works for viewers: single hop, role instead of agent name', () => {
    const msgs = groupMessages(
      chain().filter((e) => e.agentId === 'a2').map((e) => ({ ...e, agentId: null, agentName: null })),
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0].hops).toHaveLength(1);
    expect(msgs[0].hops[0].label).toBe('outbound');
    expect(msgs[0].status).toBe('sent');
  });

  it('uses the aggregate worst status over several recipients', () => {
    const t = T0;
    const msgs = groupMessages([
      ev({ ts: t, kind: 'queued', sender: 's@x.at' }),
      ev({ ts: t + 1, kind: 'delivery', recipient: 'ok@x.com', status: 'sent' }),
      ev({ ts: t + 2, kind: 'delivery', recipient: 'bad@x.com', status: 'bounced', dsn: '5.1.1', detail: '550 5.1.1 User unknown' }),
    ]);
    expect(msgs[0].status).toBe('bounced');
    expect(msgs[0].recipients.map((r) => r.status)).toEqual(['sent', 'bounced']);
  });
});

describe('final status sentence', () => {
  it('describes delivery, deferral and bounce in plain language', () => {
    const sent = groupMessages(chain())[0];
    expect(describeFinal(sent)).toBe("Delivered to the recipient's server by mailout after 1.3 s");

    const deferred = groupMessages([
      ev({ kind: 'queued', sender: 's@x.at' }),
      ev({ ts: T0 + 100, kind: 'delivery', recipient: 'r@x.com', status: 'deferred', detail: 'host gmail said: 452-4.2.2 The recipient inbox is out of storage space' }),
    ])[0];
    expect(describeFinal(deferred)).toBe('Postponed: recipient mailbox full, retrying');

    const bounced = groupMessages([
      ev({ kind: 'queued', sender: 's@x.at' }),
      ev({ ts: T0 + 100, kind: 'delivery', recipient: 'r@x.com', status: 'bounced', dsn: '5.1.1', detail: 'host mx said: 550 User unknown' }),
    ])[0];
    expect(describeFinal(bounced)).toBe('Rejected (5.1.1 user unknown)');
  });

  it('maps common reasons and falls back to the raw text', () => {
    expect(deferReason('Connection timed out')).toContain('did not answer');
    expect(deferReason('450 4.7.1 greylisted')).toContain('try again later');
    expect(deferReason('something odd')).toBe('something odd');
    expect(deferReason(null)).toBe('reason unknown');
    expect(bounceReason('554 blocked by spamhaus blacklist')).toContain('spam');
  });
});

describe('formatting helpers', () => {
  it('formats step durations', () => {
    expect(fmtDelta(0)).toBe('+0 ms');
    expect(fmtDelta(200)).toBe('+200 ms');
    expect(fmtDelta(1300)).toBe('+1.3 s');
    expect(fmtDelta(65_000)).toBe('+1m 5s');
    expect(fmtDelta(-5)).toBe('+0 ms');
  });

  it('extracts host names, sizes and statuses', () => {
    expect(relayHost('mx.example.com[1.2.3.4]:25')).toBe('mx.example.com');
    expect(relayHost('192.168.234.72[192.168.234.72]:25')).toBe('192.168.234.72');
    expect(relayHost(null)).toBeNull();
    expect(sizeFromDetail('size=38617 nrcpt=1')).toBe('38 KB');
    expect(normalizeStatus('expired')).toBe('bounced');
    expect(normalizeStatus('reject')).toBe('rejected');
    expect(normalizeStatus(null)).toBe('queued');
  });

  it('describes events readably', () => {
    expect(describeEvent(ev({ kind: 'delivery', recipient: 'r@x.com', status: 'sent', relay: 'mx.example.com[1.2.3.4]:25' }))).toBe('Delivered to r@x.com via mx.example.com');
    expect(describeEvent(ev({ kind: 'delivery', status: 'sent', nextQueueId: 'Q2', relay: '10.0.0.1[10.0.0.1]:25' }))).toBe('Handed over to 10.0.0.1 as queue Q2');
    expect(describeEvent(ev({ kind: 'accepted', clientHost: 'srv', saslUser: 'u' }))).toBe('Received from srv as u');
    expect(describeEvent(ev({ kind: 'dkim_signed', detail: 'DKIM-Signature field added (s=x, d=y.at)' }))).toBe('DKIM signature added (s=x, d=y.at)');
  });

  it('keeps the five most recent distinct searches', () => {
    let l: string[] = [];
    for (const q of ['a', 'b', 'c', 'd', 'e', 'f', 'c']) l = addRecent(l, q);
    expect(l).toEqual(['c', 'f', 'e', 'd', 'b']);
    expect(addRecent(l, '  ')).toEqual(l);
  });
});

describe('timeline and journey', () => {
  const m = groupMessages(chain())[0];

  it('hides technical lines by default and reports the time between steps', () => {
    const views = buildHopViews(m, false);
    const all = views.flatMap((v) => v.rows);
    expect(all.some((r) => r.event.kind === 'meta')).toBe(false);
    expect(views[1].hiddenCount).toBe(1);
    expect(views[0].rows[0].delta).toBeNull();
    expect(views[0].rows[1].delta).toBe('+20 ms');
    expect(buildHopViews(m, true).flatMap((v) => v.rows).some((r) => r.event.kind === 'meta')).toBe(true);
  });

  it('labels the connector between hops', () => {
    const views = buildHopViews(m, false);
    expect(views[0].connector).toBe('handed over to mailout as Q2');
    expect(views[1].connector).toBeNull();
  });

  it('builds client -> servers -> recipient server', () => {
    const nodes = buildJourney(m);
    expect(nodes.map((n) => n.label)).toEqual(['smtp_relay_danceplus_prd', 'smtp2', 'mailout', 'mx.example.com']);
    expect(nodes.map((n) => n.state)).toEqual(['ok', 'sent', 'sent', 'sent']);
  });

  it('omits the recipient server for submission-time rejections', () => {
    const r = groupMessages([ev({ queueId: 'NOQUEUE', kind: 'reject', status: 'reject', detail: 'denied' })])[0];
    expect(buildJourney(r).map((n) => n.state)).toEqual(['ok', 'rejected']);
  });
});
