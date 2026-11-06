import { Agent, QueueAgent, SummaryDay } from '../../api/models';
import {
  authBars, delayLines, domainRows, hourBars, limitThresholds, outcomeBars, queueLimits, queueLines, queueScale,
  queueState, queueUtilisation, sentBouncedLines,
} from './stats-data';

const day = (n: number, p: Partial<SummaryDay> = {}): SummaryDay => ({
  day: Date.UTC(2026, 10, n, 0), sent: 10 * n, deferred: n, bounced: 0, rejected: 0, avgDelayS: 1.5, p95DelayS: 3, ...p,
});

describe('daily shaping', () => {
  const daily = [day(1), day(2, { bounced: 2, avgDelayS: null, p95DelayS: null })];

  it('builds the sent/bounced lines in chronological order', () => {
    const [sent, bounced] = sentBouncedLines(daily);
    expect(sent.points).toEqual([{ x: daily[0].day, y: 10 }, { x: daily[1].day, y: 20 }]);
    expect(bounced.points.map((p) => p.y)).toEqual([0, 2]);
  });

  it('skips days without delay data', () => {
    const [avg, p95] = delayLines(daily);
    expect(avg.points).toHaveLength(1);
    expect(p95.points[0].y).toBe(3);
  });

  it('labels outcome bars with the reporting timezone day', () => {
    const bars = outcomeBars([{ ...day(1), day: Date.UTC(2026, 10, 5, 23) }], 60);
    expect(bars[0].label).toBe('6.11.');
    expect(bars[0].values).toEqual([10, 1, 0, 0]);
  });

  it('fills all 24 hours', () => {
    const bars = hourBars([{ hour: 9, sent: 5 }, { hour: 23, sent: 1 }]);
    expect(bars).toHaveLength(24);
    expect(bars[9].values).toEqual([5]);
    expect(bars[0].label).toBe('00:00');
    expect(bars[3].values).toEqual([0]);
  });

  it('maps domain stats to stacked rows', () => {
    expect(domainRows([{ name: 'a.at', sent: 3, deferred: 2, bounced: 1 }])).toEqual([{ label: 'a.at', values: [3, 2, 1] }]);
  });

  it('splits auth failures into rejected logins and generic failures', () => {
    const bars = authBars(
      [
        { day: Date.UTC(2026, 10, 6), authFail: 12, genericFailures: 5 },
        { day: Date.UTC(2026, 10, 7), authFail: 2, genericFailures: 9 },
      ],
      0,
    );
    expect(bars[0].values).toEqual([7, 5]);
    expect(bars[1].values).toEqual([0, 9]);
  });
});

describe('queue helpers', () => {
  const agent = {
    id: 'a1',
    checks: [{ name: 'queue', type: 'queue', warn: 500, fail: 5000 }, { name: 'x', type: 'tcp' }],
  } as unknown as Agent;

  it('reads warn/fail from the queue check', () => {
    expect(queueLimits(agent)).toEqual({ warn: 500, fail: 5000 });
    expect(queueLimits(undefined)).toEqual({});
    expect(limitThresholds({ warn: 500, fail: 5000 }).map((t) => t.label)).toEqual(['warn 500', 'fail 5000']);
  });

  it('classifies the queue size', () => {
    const l = { warn: 500, fail: 5000 };
    expect(queueState(34, l)).toBe('ok');
    expect(queueState(500, l)).toBe('warn');
    expect(queueState(5000, l)).toBe('fail');
    expect(queueState(99999, {})).toBe('ok');
  });

  it('computes utilisation against fail (or warn) and the bar scale', () => {
    expect(queueUtilisation(250, { warn: 500, fail: 5000 })).toBe(5);
    expect(queueUtilisation(250, { warn: 500 })).toBe(50);
    expect(queueUtilisation(10, {})).toBeNull();
    expect(queueScale(10, { fail: 1000 })).toBe(1150);
    expect(queueScale(2000, { fail: 1000 })).toBe(2000);
    expect(queueScale(0, {})).toBe(10);
  });

  it('builds one line per server, or total/deferred/active for a selected one', () => {
    const agents = [
      { id: 'a1', name: 'smtp2', role: 'relay', current: null, series: [{ ts: 1, total: 5, deferred: 2, active: 1, oldestAgeS: 0 }] },
      { id: 'a2', name: 'mailout', role: 'outbound', current: null, series: [{ ts: 1, total: 7, deferred: 0, oldestAgeS: 0 }] },
    ] as QueueAgent[];
    expect(queueLines(agents, '').map((s) => s.name)).toEqual(['smtp2', 'mailout']);
    expect(queueLines(agents, 'a1').map((s) => s.name)).toEqual(['Total', 'Deferred', 'Active']);
    expect(queueLines(agents, 'a2').map((s) => s.name)).toEqual(['Total', 'Deferred']);
  });
});
