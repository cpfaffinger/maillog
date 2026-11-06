import { MailEvent, StatRow } from '../api/models';
import { validateChecks, validateLogs } from './agents/agent-dialogs';
import { toBars } from './stats/stats';
import { groupHops } from './trace/trace';
import { normalizeDomain } from './users/user-dialog';

function ev(p: Partial<MailEvent>): MailEvent {
  return {
    id: 1, agentId: 'a1', agentName: 'smtp2', agentRole: 'relay', ts: 1, source: 'mail', program: null, queueId: 'Q1',
    kind: 'info', sender: null, recipient: null, clientIp: null, clientHost: null, saslUser: null, relay: null,
    status: null, dsn: null, nextQueueId: null, delayS: null, detail: null, raw: null, ...p,
  };
}

describe('groupHops', () => {
  it('groups by agent and queue id and orders hops by first event', () => {
    const hops = groupHops([
      ev({ id: 3, ts: 30, agentId: 'a2', agentName: 'mailout', queueId: 'Q2', kind: 'delivery', status: 'sent' }),
      ev({ id: 1, ts: 10, kind: 'queued', sender: 'x@y.at' }),
      ev({ id: 2, ts: 20, kind: 'delivery', nextQueueId: 'Q2', status: 'sent' }),
    ]);
    expect(hops.map((h) => h.label)).toEqual(['smtp2', 'mailout']);
    expect(hops[0].events.map((e) => e.id)).toEqual([1, 2]);
    expect(hops[0].handedTo).toEqual(['Q2']);
  });

  it('works for viewers without agent information', () => {
    const hops = groupHops([ev({ agentId: null, agentName: null, agentRole: 'outbound' })]);
    expect(hops[0].label).toBe('outbound');
  });
});

describe('toBars', () => {
  const rows = [
    { agentId: 'a1', hour: 3600000, sent: 2, deferred: 1, bounced: 0 },
    { agentId: 'a2', hour: 3600000, sent: 3, deferred: 0, bounced: 1 },
    { agentId: 'a1', hour: 0, sent: 1, deferred: 0, bounced: 0 },
  ] as StatRow[];

  it('sums per hour in chronological order', () => {
    expect(toBars(rows, '')).toEqual([
      { ts: 0, values: [1, 0, 0] },
      { ts: 3600000, values: [5, 1, 1] },
    ]);
  });

  it('can be limited to one agent', () => {
    expect(toBars(rows, 'a2')).toEqual([{ ts: 3600000, values: [3, 0, 1] }]);
  });
});

describe('normalizeDomain', () => {
  it('accepts domains with optional @ and any case', () => {
    expect(normalizeDomain('@Customer-A.example')).toBe('customer-a.example');
    expect(normalizeDomain(' customer-b.example ')).toBe('customer-b.example');
  });

  it('rejects things that are not domains', () => {
    expect(normalizeDomain('nodot')).toBeNull();
    expect(normalizeDomain('a b.at')).toBeNull();
    expect(normalizeDomain('')).toBeNull();
  });
});

describe('agent config validation', () => {
  it('requires named, typed, unique checks', () => {
    expect(validateChecks([{ name: 'a', type: 'tcp' }])).toBeNull();
    expect(validateChecks({})).toMatch(/array/);
    expect(validateChecks([{ type: 'tcp' }])).toMatch(/name/);
    expect(validateChecks([{ name: 'a' }])).toMatch(/type/);
    expect(validateChecks([{ name: 'a', type: 'x' }, { name: 'a', type: 'y' }])).toMatch(/Duplicate/);
  });

  it('requires path and source for logs', () => {
    expect(validateLogs([{ path: '/var/log/mail.log', source: 'mail' }])).toBeNull();
    expect(validateLogs([{ path: '/x' }])).toMatch(/source/);
  });
});
