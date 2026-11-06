// Pure helpers shared by the chart components and the statistics pages (unit tested).

/** Browser UTC offset in minutes, as expected by the API (`tz`). */
export function browserTz(): number {
  return -new Date().getTimezoneOffset();
}

export const SERIES_COLORS = [
  'var(--ml-info)', 'var(--ml-ok)', 'var(--ml-warn)', 'var(--ml-fail)', 'var(--ml-c4)', 'var(--ml-c5)',
  'var(--ml-c6)', 'var(--ml-c7)',
];

function niceStep(raw: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

const round10 = (v: number) => Math.round(v * 1e10) / 1e10;

/** "Nice" axis: ceiling and evenly spaced ticks starting at 0. With `integer` the step is never below 1. */
export function niceTicks(max: number, target = 4, integer = true): { max: number; ticks: number[] } {
  if (!isFinite(max) || max <= 0) max = integer ? target : 1;
  let step = niceStep(max / target);
  if (integer) step = Math.max(1, Math.ceil(step));
  const top = round10(Math.ceil(max / step - 1e-9) * step);
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 1000; v += step) ticks.push(round10(v));
  return { max: top, ticks };
}

export interface Segment {
  index: number;
  value: number;
  start: number;
  end: number;
}

/** Cumulative stacking; hidden series contribute nothing. */
export function stackSegments(values: number[], visible?: boolean[]): Segment[] {
  let acc = 0;
  return values.map((v, index) => {
    const value = visible && !visible[index] ? 0 : Math.max(0, v);
    const seg = { index, value, start: acc, end: acc + value };
    acc += value;
    return seg;
  });
}

export function stackTotal(values: number[], visible?: boolean[]): number {
  return stackSegments(values, visible).reduce((t, s) => t + s.value, 0);
}

/** Percentage rounded to `digits`; null when the total is zero. */
export function pct(part: number, total: number, digits = 1): number | null {
  if (!total || total <= 0) return null;
  const f = Math.pow(10, digits);
  return Math.round((part / total) * 100 * f) / f;
}

export function fmtPct(v: number | null | undefined): string {
  return v === null || v === undefined ? '–' : `${v.toFixed(1)} %`;
}

export function fmtNum(n: number): string {
  if (!isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${trim1(n / 1_000_000)}M`;
  if (a >= 10_000) return `${trim1(n / 1000)}k`;
  return Number.isInteger(n) ? n.toLocaleString() : trim1(n);
}

function trim1(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

/** Seconds as "340 ms", "1.2 s", "2m 5s", "1h 5m". */
export function fmtSeconds(s: number | null | undefined): string {
  if (s === null || s === undefined || !isFinite(s)) return '–';
  if (s < 1) return `${Math.round(s * 1000)} ms`;
  if (s < 60) return `${s.toFixed(1)} s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

/** "6.11." for a day timestamp (local midnight of the reporting timezone `tz` minutes east of UTC). */
export function dayLabel(ms: number, tz: number): string {
  const d = new Date(ms + tz * 60_000);
  return `${d.getUTCDate()}.${d.getUTCMonth() + 1}.`;
}

/** "Fri, 6 Nov 2026" in the reporting timezone. */
export function dayLabelLong(ms: number, tz: number): string {
  return new Date(ms + tz * 60_000).toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

export function hourLabel(h: number): string {
  return `${String(h).padStart(2, '0')}:00`;
}

/** Axis label for a timestamp: a date when the visible span exceeds two days, else a time. */
export function timeLabel(ms: number, spanMs: number, tz: number): string {
  const d = new Date(ms + tz * 60_000);
  if (spanMs > 2 * 86_400_000) return `${d.getUTCDate()}.${d.getUTCMonth() + 1}.`;
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export function timeLabelLong(ms: number, tz: number): string {
  const d = new Date(ms + tz * 60_000);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
}

/** `count` evenly spaced values from min to max (inclusive). */
export function evenTicks(min: number, max: number, count: number): number[] {
  if (count < 2 || max <= min) return [min];
  return Array.from({ length: count }, (_, i) => min + ((max - min) / (count - 1)) * i);
}

/** Index of the value in the sorted array closest to `target` (-1 for an empty array). */
export function nearestIndex(sorted: number[], target: number): number {
  if (sorted.length === 0) return -1;
  let best = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i] - target) < Math.abs(sorted[best] - target)) best = i;
  }
  return best;
}
