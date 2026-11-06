import {
  Agent, AuthFailDay, DomainStat, HourOfDay, NamedCount, QueueAgent, SummaryDay,
} from '../../api/models';
import { BarDatum, BarSeries, HRow, LineSeries, Threshold } from '../../shared/charts';
import { dayLabel, hourLabel, SERIES_COLORS } from '../../shared/chart-utils';

// Pure data-shaping helpers for the statistics pages (unit tested).

export const OUTCOME_SERIES: BarSeries[] = [
  { name: 'Sent', color: 'var(--ml-ok)' },
  { name: 'Deferred', color: 'var(--ml-warn)' },
  { name: 'Bounced', color: 'var(--ml-fail)' },
  { name: 'Rejected', color: 'var(--ml-c4)' },
];

export const DOMAIN_SERIES: BarSeries[] = OUTCOME_SERIES.slice(0, 3);
export const HOUR_SERIES: BarSeries[] = [OUTCOME_SERIES[0]];
export const AUTH_SERIES: BarSeries[] = [
  { name: 'Rejected logins', color: 'var(--ml-warn)' },
  { name: 'Generic failures (backend)', color: 'var(--ml-fail)' },
];
export const COUNT_SERIES: BarSeries[] = [{ name: 'Messages', color: 'var(--ml-info)' }];
export const ACCEPTED_SERIES: BarSeries[] = [{ name: 'Accepted', color: 'var(--ml-info)' }];

export function sentBouncedLines(daily: SummaryDay[]): LineSeries[] {
  return [
    { name: 'Sent', color: 'var(--ml-ok)', points: daily.map((d) => ({ x: d.day, y: d.sent })) },
    { name: 'Bounced', color: 'var(--ml-fail)', points: daily.map((d) => ({ x: d.day, y: d.bounced })) },
  ];
}

export function delayLines(daily: SummaryDay[]): LineSeries[] {
  const pick = (f: (d: SummaryDay) => number | null) =>
    daily.flatMap((d) => (f(d) === null ? [] : [{ x: d.day, y: f(d) as number }]));
  return [
    { name: 'Average', color: 'var(--ml-info)', points: pick((d) => d.avgDelayS) },
    { name: '95th percentile', color: 'var(--ml-warn)', points: pick((d) => d.p95DelayS), dashed: true },
  ];
}

export function outcomeBars(daily: SummaryDay[], tz: number): BarDatum[] {
  return daily.map((d) => ({
    key: String(d.day),
    label: dayLabel(d.day, tz),
    values: [d.sent, d.deferred, d.bounced, d.rejected],
  }));
}

/** Always 24 bars, 00:00 … 23:00, missing hours count as zero. */
export function hourBars(hours: HourOfDay[]): BarDatum[] {
  const byHour = new Map(hours.map((h) => [h.hour, h.sent]));
  return Array.from({ length: 24 }, (_, h) => ({ key: String(h), label: hourLabel(h), values: [byHour.get(h) ?? 0] }));
}

export function domainRows(list: DomainStat[]): HRow[] {
  return list.map((d) => ({ label: d.name, values: [d.sent, d.deferred, d.bounced] }));
}

export function nameCountRows(list: NamedCount[]): HRow[] {
  return list.map((n) => ({ label: n.name, values: [n.count] }));
}

/** Rejected logins = failures that are not backend ("generic") errors; assumes genericFailures is part of authFail. */
export function authBars(days: AuthFailDay[], tz: number): BarDatum[] {
  return days.map((d) => ({
    key: String(d.day),
    label: dayLabel(d.day, tz),
    values: [Math.max(0, d.authFail - d.genericFailures), d.genericFailures],
  }));
}

// ---- queue helpers -------------------------------------------------------------------------------------------

export interface QueueLimits {
  warn?: number;
  fail?: number;
}

export type QueueState = 'ok' | 'warn' | 'fail';

/** warn/fail message counts of the agent's `queue` health check (if configured). */
export function queueLimits(agent: Agent | undefined): QueueLimits {
  const c = agent?.checks.find((x) => x.type === 'queue');
  const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : undefined);
  return { warn: num(c?.['warn']), fail: num(c?.['fail']) };
}

export function queueState(total: number, limits: QueueLimits): QueueState {
  if (limits.fail !== undefined && total >= limits.fail) return 'fail';
  if (limits.warn !== undefined && total >= limits.warn) return 'warn';
  return 'ok';
}

/** Share of the fail threshold (or warn when no fail is set) that is used; null without any threshold. */
export function queueUtilisation(total: number, limits: QueueLimits): number | null {
  const ref = limits.fail ?? limits.warn;
  return ref ? Math.round((total / ref) * 1000) / 10 : null;
}

/** Right edge of the queue bar: the data or slightly beyond the highest threshold, whichever is larger. */
export function queueScale(total: number, limits: QueueLimits): number {
  const ref = limits.fail ?? limits.warn ?? 0;
  return Math.max(total, ref * 1.15, 10);
}

export function queueLines(agents: QueueAgent[], selectedId: string): LineSeries[] {
  const sel = agents.find((a) => a.id === selectedId);
  if (sel) {
    const lines: LineSeries[] = [
      { name: 'Total', color: 'var(--ml-info)', points: sel.series.map((p) => ({ x: p.ts, y: p.total })) },
      { name: 'Deferred', color: 'var(--ml-warn)', points: sel.series.map((p) => ({ x: p.ts, y: p.deferred })) },
    ];
    if (sel.series.some((p) => p.active !== undefined)) {
      lines.push({
        name: 'Active', color: 'var(--ml-c5)',
        points: sel.series.flatMap((p) => (p.active === undefined ? [] : [{ x: p.ts, y: p.active }])),
      });
    }
    return lines;
  }
  return agents.map((a, i) => ({
    name: a.name,
    color: SERIES_COLORS[i % SERIES_COLORS.length],
    points: a.series.map((p) => ({ x: p.ts, y: p.total })),
  }));
}

export function limitThresholds(limits: QueueLimits): Threshold[] {
  const out: Threshold[] = [];
  if (limits.warn !== undefined) out.push({ value: limits.warn, label: `warn ${limits.warn}`, color: 'var(--ml-warn)' });
  if (limits.fail !== undefined) out.push({ value: limits.fail, label: `fail ${limits.fail}`, color: 'var(--ml-fail)' });
  return out;
}
