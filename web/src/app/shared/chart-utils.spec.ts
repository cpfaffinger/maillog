import {
  dayLabel, dayLabelLong, evenTicks, fmtNum, fmtPct, fmtSeconds, hourLabel, nearestIndex, niceTicks, pct,
  stackSegments, stackTotal, timeLabel,
} from './chart-utils';

describe('niceTicks', () => {
  it('rounds the ceiling up to a nice step', () => {
    expect(niceTicks(34)).toEqual({ max: 40, ticks: [0, 10, 20, 30, 40] });
    expect(niceTicks(1234)).toEqual({ max: 1500, ticks: [0, 500, 1000, 1500] });
  });

  it('keeps integer steps for small counts and handles empty data', () => {
    expect(niceTicks(3).ticks).toEqual([0, 1, 2, 3]);
    expect(niceTicks(0).ticks).toEqual([0, 1, 2, 3, 4]);
    expect(niceTicks(Number.NaN).max).toBe(4);
  });

  it('supports fractional axes (seconds)', () => {
    const t = niceTicks(0.5, 4, false);
    expect(t.max).toBeCloseTo(0.6, 5);
    expect(t.ticks[0]).toBe(0);
    expect(t.ticks[t.ticks.length - 1]).toBe(t.max);
  });
});

describe('stacking', () => {
  it('accumulates segments and skips hidden series', () => {
    expect(stackSegments([2, 3, 5]).map((s) => [s.start, s.end])).toEqual([[0, 2], [2, 5], [5, 10]]);
    const hidden = stackSegments([2, 3, 5], [true, false, true]);
    expect(hidden.map((s) => [s.start, s.end])).toEqual([[0, 2], [2, 2], [2, 7]]);
    expect(stackTotal([2, 3, 5], [true, false, true])).toBe(7);
  });

  it('never stacks negative values', () => {
    expect(stackTotal([4, -2])).toBe(4);
  });
});

describe('percent and number formatting', () => {
  it('computes percentages with one decimal and null for empty totals', () => {
    expect(pct(982, 1000)).toBe(98.2);
    expect(pct(1, 3)).toBe(33.3);
    expect(pct(0, 0)).toBeNull();
    expect(fmtPct(98.2)).toBe('98.2 %');
    expect(fmtPct(null)).toBe('–');
  });

  it('formats large numbers compactly', () => {
    expect(fmtNum(950)).toBe('950');
    expect(fmtNum(12_345)).toBe('12.3k');
    expect(fmtNum(2_500_000)).toBe('2.5M');
  });

  it('formats seconds', () => {
    expect(fmtSeconds(null)).toBe('–');
    expect(fmtSeconds(0.34)).toBe('340 ms');
    expect(fmtSeconds(1.234)).toBe('1.2 s');
    expect(fmtSeconds(125)).toBe('2m 5s');
    expect(fmtSeconds(3900)).toBe('1h 5m');
  });
});

describe('day and time labels honour the reporting timezone', () => {
  // 2026-11-05T23:00:00Z is local midnight of 6 Nov in UTC+1.
  const midnightPlus1 = Date.UTC(2026, 10, 5, 23, 0, 0);

  it('labels a local-midnight timestamp with the local date', () => {
    expect(dayLabel(midnightPlus1, 60)).toBe('6.11.');
    expect(dayLabel(midnightPlus1, 0)).toBe('5.11.');
    expect(dayLabelLong(midnightPlus1, 60)).toContain('2026');
  });

  it('labels times as dates for long spans and as clock time otherwise', () => {
    const t = Date.UTC(2026, 10, 6, 11, 30);
    expect(timeLabel(t, 7 * 86_400_000, 60)).toBe('6.11.');
    expect(timeLabel(t, 3_600_000, 60)).toBe('12:30');
    expect(hourLabel(7)).toBe('07:00');
  });
});

describe('ticks and nearest', () => {
  it('spaces ticks evenly', () => {
    expect(evenTicks(0, 100, 5)).toEqual([0, 25, 50, 75, 100]);
    expect(evenTicks(5, 5, 5)).toEqual([5]);
  });

  it('finds the closest sorted value', () => {
    expect(nearestIndex([], 3)).toBe(-1);
    expect(nearestIndex([10, 20, 40], 26)).toBe(1);
    expect(nearestIndex([10, 20, 40], 99)).toBe(2);
  });
});
