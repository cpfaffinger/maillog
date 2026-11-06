import { Component, computed, input, signal } from '@angular/core';
import {
  browserTz, dayLabel, dayLabelLong, evenTicks, fmtNum, nearestIndex, niceTicks, stackSegments, stackTotal, timeLabel,
  timeLabelLong,
} from './chart-utils';

// Dependency free SVG / CSS charts. They share: legend toggles, tooltips on hover AND keyboard focus (arrow keys),
// a "Show data as table" fallback, aria labels, empty states and theme colours via CSS variables (see styles.scss).

const W = 800;
const PAD = { l: 52, r: 14, t: 12, b: 28 };

export interface LineSeries {
  name: string;
  color: string;
  points: { x: number; y: number }[];
  dashed?: boolean;
}

export interface Threshold {
  value: number;
  label: string;
  color: string;
}

export interface BarSeries {
  name: string;
  color: string;
}

export interface BarDatum {
  key: string;
  label: string;
  values: number[];
}

export interface HRow {
  label: string;
  values: number[];
}

type Tip = { title: string; leftPct: number; flip: boolean; rows: { name: string; color: string; value: string }[] };

function toggled(set: ReadonlySet<string>, name: string): Set<string> {
  const next = new Set(set);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return next;
}

// ------------------------------------------------------------------------------------------------ line chart

@Component({
  selector: 'app-line-chart',
  template: `
    <div class="chart-wrap" role="group" [attr.aria-label]="label()">
      @if (hasData()) {
        <svg class="chart-svg" [attr.viewBox]="'0 0 ' + W + ' ' + height()" tabindex="0" role="img"
             [attr.aria-label]="label() + '. Use the left and right arrow keys to read values.'"
             (pointermove)="move($event)" (pointerleave)="leave()" (focus)="focusIn()" (blur)="active.set(null)"
             (keydown)="key($event)">
          @for (t of l().yTicks; track t.v) {
            <line [attr.x1]="pad.l" [attr.x2]="W - pad.r" [attr.y1]="t.y" [attr.y2]="t.y" class="grid" />
            <text [attr.x]="pad.l - 6" [attr.y]="t.y + 4" text-anchor="end">{{ yFormat()(t.v) }}</text>
          }
          @for (t of l().xTicks; track t.x) {
            <text [attr.x]="t.x" [attr.y]="height() - 8" text-anchor="middle">{{ t.label }}</text>
          }
          @for (th of l().thresholds; track th.label) {
            <line [attr.x1]="pad.l" [attr.x2]="W - pad.r" [attr.y1]="th.y" [attr.y2]="th.y" [style.stroke]="th.color" stroke-dasharray="6 4" stroke-width="1.5" />
            <text [attr.x]="W - pad.r - 2" [attr.y]="th.y - 4" text-anchor="end" [style.fill]="th.color">{{ th.label }}</text>
          }
          @for (p of l().paths; track p.name) {
            <path [attr.d]="p.d" fill="none" stroke-width="2" stroke-linejoin="round" [style.stroke]="p.color"
                  [attr.stroke-dasharray]="p.dashed ? '5 3' : null" />
            @for (d of p.dots; track d.x) { <circle [attr.cx]="d.x" [attr.cy]="d.y" r="2.5" [style.fill]="p.color" /> }
          }
          @if (cross(); as c) {
            <line [attr.x1]="c.x" [attr.x2]="c.x" [attr.y1]="pad.t" [attr.y2]="height() - pad.b" class="cross" />
            @for (d of c.dots; track d.name) { <circle [attr.cx]="c.x" [attr.cy]="d.y" r="4" [style.fill]="d.color" class="dotring" /> }
          }
        </svg>
        @if (tip(); as t) {
          <div class="chart-tip" [style.left.%]="t.leftPct" [class.flip]="t.flip" aria-live="polite">
            <b>{{ t.title }}</b>
            @for (r of t.rows; track r.name) { <div><i [style.background]="r.color"></i>{{ r.name }}: <b>{{ r.value }}</b></div> }
          </div>
        }
        <div class="chart-legend">
          @for (s of series(); track s.name) {
            <button type="button" class="chart-chip" [class.off]="hidden().has(s.name)" [attr.aria-pressed]="!hidden().has(s.name)"
                    (click)="toggle(s.name)" [attr.title]="'Show or hide ' + s.name">
              <i [style.background]="s.color"></i>{{ s.name }}</button>
          }
          @for (th of thresholds(); track th.label) {
            <span class="chart-chip static"><i class="dash" [style.background]="th.color"></i>{{ th.label }}@if (l().offScale.includes(th.label)) { (off scale) }</span>
          }
        </div>
        <details class="chart-details" (toggle)="tableOpen.set($any($event.target).open)">
          <summary>Show data as table</summary>
          @if (tableOpen()) {
            <div class="chart-table-wrap">
              <table class="ml-table chart-table">
                <thead><tr><th>{{ xHeader() }}</th>@for (s of series(); track s.name) { <th>{{ s.name }}</th> }</tr></thead>
                <tbody>
                  @for (r of tableRows(); track r.x) { <tr><td>{{ r.label }}</td>@for (v of r.values; track $index) { <td>{{ v }}</td> }</tr> }
                </tbody>
              </table>
            </div>
          }
        </details>
      } @else {
        <div class="empty">{{ emptyText() }}</div>
      }
    </div>
  `,
})
export class LineChart {
  readonly series = input.required<LineSeries[]>();
  readonly height = input(220);
  readonly label = input('Line chart');
  readonly xKind = input<'time' | 'day'>('time');
  readonly tz = input(browserTz());
  readonly yFormat = input<(n: number) => string>(fmtNum);
  readonly yIntegers = input(true);
  readonly thresholds = input<Threshold[]>([]);
  readonly emptyText = input('No data in this period');
  readonly xHeader = input('Time');

  protected readonly W = W;
  protected readonly pad = PAD;
  protected readonly hidden = signal<ReadonlySet<string>>(new Set());
  protected readonly active = signal<number | null>(null);
  protected readonly tableOpen = signal(false);

  protected readonly hasData = computed(() => this.series().some((s) => s.points.length > 0));
  private readonly vis = computed(() => this.series().filter((s) => !this.hidden().has(s.name)));
  protected readonly xs = computed(() => {
    const set = new Set<number>();
    for (const s of this.vis()) for (const p of s.points) set.add(p.x);
    return [...set].sort((a, b) => a - b);
  });
  private readonly allXs = computed(() => [...new Set(this.series().flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => a - b));

  protected readonly l = computed(() => {
    const h = this.height();
    const all = this.allXs();
    const xmin = all[0] ?? 0;
    let xmax = all[all.length - 1] ?? 1;
    if (xmax === xmin) xmax = xmin + 1;
    const dataMax = Math.max(0, ...this.vis().flatMap((s) => s.points.map((p) => p.y)));
    const inScale = this.thresholds().filter((t) => t.value <= Math.max(dataMax * 3, 4));
    const { max: ymax, ticks } = niceTicks(Math.max(dataMax, ...inScale.map((t) => t.value)), 4, this.yIntegers());
    const sx = (x: number) => PAD.l + ((x - xmin) / (xmax - xmin)) * (W - PAD.l - PAD.r);
    const sy = (y: number) => h - PAD.b - (y / ymax) * (h - PAD.t - PAD.b);
    const tz = this.tz();
    const xTickValues =
      this.xKind() === 'day' && all.length > 0
        ? evenTicks(0, all.length - 1, Math.min(6, all.length)).map((i) => all[Math.round(i)])
        : evenTicks(xmin, xmax, 5);
    return {
      xmin, xmax, sx, sy,
      yTicks: ticks.map((v) => ({ v, y: sy(v) })),
      xTicks: [...new Set(xTickValues)].map((x) => ({
        x: sx(x),
        label: this.xKind() === 'day' ? dayLabel(x, tz) : timeLabel(x, xmax - xmin, tz),
      })),
      thresholds: inScale.map((t) => ({ label: t.label, color: t.color, y: sy(t.value) })),
      offScale: this.thresholds().filter((t) => !inScale.includes(t)).map((t) => t.label),
      paths: this.vis().map((s) => {
        const pts = [...s.points].sort((a, b) => a.x - b.x);
        return {
          name: s.name, color: s.color, dashed: s.dashed,
          d: pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(' '),
          dots: pts.length <= 45 ? pts.map((p) => ({ x: sx(p.x), y: sy(p.y) })) : [],
        };
      }),
    };
  });

  protected readonly cross = computed(() => {
    const i = this.active();
    const xs = this.xs();
    if (i === null || i < 0 || i >= xs.length) return null;
    const x = xs[i];
    const L = this.l();
    return {
      x: L.sx(x),
      dots: this.vis().flatMap((s) => {
        const p = s.points.find((q) => q.x === x);
        return p ? [{ name: s.name, color: s.color, y: L.sy(p.y) }] : [];
      }),
    };
  });

  protected readonly tip = computed<Tip | null>(() => {
    const i = this.active();
    const xs = this.xs();
    if (i === null || i < 0 || i >= xs.length) return null;
    const x = xs[i];
    const leftPct = (this.l().sx(x) / W) * 100;
    return {
      title: this.longLabel(x),
      leftPct,
      flip: leftPct > 62,
      rows: this.vis().map((s) => {
        const p = s.points.find((q) => q.x === x);
        return { name: s.name, color: s.color, value: p ? this.yFormat()(p.y) : '–' };
      }),
    };
  });

  protected readonly tableRows = computed(() =>
    this.allXs().map((x) => ({
      x,
      label: this.longLabel(x),
      values: this.series().map((s) => {
        const p = s.points.find((q) => q.x === x);
        return p ? this.yFormat()(p.y) : '–';
      }),
    })),
  );

  protected toggle(name: string): void {
    this.hidden.update((h) => toggled(h, name));
    this.active.set(null);
  }

  protected move(ev: PointerEvent): void {
    const xs = this.xs();
    if (xs.length === 0) return;
    const rect = (ev.currentTarget as SVGElement).getBoundingClientRect();
    const vx = ((ev.clientX - rect.left) / rect.width) * W;
    const L = this.l();
    const x = L.xmin + ((vx - PAD.l) / (W - PAD.l - PAD.r)) * (L.xmax - L.xmin);
    this.active.set(nearestIndex(xs, x));
  }

  protected leave(): void {
    if (document.activeElement !== null && !(document.activeElement instanceof SVGElement)) this.active.set(null);
  }

  protected focusIn(): void {
    if (this.active() === null && this.xs().length > 0) this.active.set(this.xs().length - 1);
  }

  protected key(ev: KeyboardEvent): void {
    const n = this.xs().length;
    if (n === 0) return;
    const cur = this.active() ?? n - 1;
    const next = ev.key === 'ArrowLeft' ? cur - 1 : ev.key === 'ArrowRight' ? cur + 1 : ev.key === 'Home' ? 0 : ev.key === 'End' ? n - 1 : null;
    if (next === null) return;
    ev.preventDefault();
    this.active.set(Math.min(n - 1, Math.max(0, next)));
  }

  private longLabel(x: number): string {
    return this.xKind() === 'day' ? dayLabelLong(x, this.tz()) : timeLabelLong(x, this.tz());
  }
}

// ------------------------------------------------------------------------------------------------ stacked bars

@Component({
  selector: 'app-bar-chart',
  template: `
    <div class="chart-wrap" role="group" [attr.aria-label]="label()">
      @if (hasData()) {
        <svg class="chart-svg" [attr.viewBox]="'0 0 ' + W + ' ' + height()" tabindex="0" role="img"
             [attr.aria-label]="label() + '. Use the left and right arrow keys to read values.'"
             (pointermove)="move($event)" (pointerleave)="leave()" (focus)="focusIn()" (blur)="active.set(null)"
             (keydown)="key($event)">
          @for (t of l().yTicks; track t.v) {
            <line [attr.x1]="pad.l" [attr.x2]="W - pad.r" [attr.y1]="t.y" [attr.y2]="t.y" class="grid" />
            <text [attr.x]="pad.l - 6" [attr.y]="t.y + 4" text-anchor="end">{{ yFormat()(t.v) }}</text>
          }
          @if (active() !== null && l().bars[active()!]; as ab) {
            <rect [attr.x]="ab.slotX" [attr.y]="pad.t" [attr.width]="l().slot" [attr.height]="height() - pad.t - pad.b" class="band" />
          }
          @for (b of l().bars; track b.key) {
            @for (r of b.rects; track r.name) {
              <rect [attr.x]="b.x" [attr.y]="r.y" [attr.width]="l().bw" [attr.height]="r.h" [style.fill]="r.color" />
            }
          }
          @for (t of l().xTicks; track t.x) {
            <text [attr.x]="t.x" [attr.y]="height() - 8" text-anchor="middle">{{ t.label }}</text>
          }
        </svg>
        @if (tip(); as t) {
          <div class="chart-tip" [style.left.%]="t.leftPct" [class.flip]="t.flip" aria-live="polite">
            <b>{{ t.title }}</b>
            @for (r of t.rows; track r.name) { <div><i [style.background]="r.color"></i>{{ r.name }}: <b>{{ r.value }}</b></div> }
          </div>
        }
        @if (series().length > 1) {
          <div class="chart-legend">
            @for (s of series(); track s.name) {
              <button type="button" class="chart-chip" [class.off]="hidden().has(s.name)" [attr.aria-pressed]="!hidden().has(s.name)"
                      (click)="toggle(s.name)" [attr.title]="'Show or hide ' + s.name">
                <i [style.background]="s.color"></i>{{ s.name }}</button>
            }
          </div>
        }
        <details class="chart-details" (toggle)="tableOpen.set($any($event.target).open)">
          <summary>Show data as table</summary>
          @if (tableOpen()) {
            <div class="chart-table-wrap">
              <table class="ml-table chart-table">
                <thead><tr><th>{{ xHeader() }}</th>@for (s of series(); track s.name) { <th>{{ s.name }}</th> }</tr></thead>
                <tbody>
                  @for (b of bars(); track b.key) { <tr><td>{{ b.label }}</td>@for (v of b.values; track $index) { <td>{{ yFormat()(v) }}</td> }</tr> }
                </tbody>
              </table>
            </div>
          }
        </details>
      } @else {
        <div class="empty">{{ emptyText() }}</div>
      }
    </div>
  `,
})
export class BarChart {
  readonly bars = input.required<BarDatum[]>();
  readonly series = input.required<BarSeries[]>();
  readonly height = input(240);
  readonly label = input('Bar chart');
  readonly yFormat = input<(n: number) => string>(fmtNum);
  readonly emptyText = input('No data in this period');
  readonly xHeader = input('Period');

  protected readonly W = W;
  protected readonly pad = PAD;
  protected readonly hidden = signal<ReadonlySet<string>>(new Set());
  protected readonly active = signal<number | null>(null);
  protected readonly tableOpen = signal(false);

  private readonly visible = computed(() => this.series().map((s) => !this.hidden().has(s.name)));
  protected readonly hasData = computed(() => this.bars().some((b) => stackTotal(b.values) > 0));

  protected readonly l = computed(() => {
    const bars = this.bars();
    const vis = this.visible();
    const series = this.series();
    const h = this.height();
    const { max: ymax, ticks } = niceTicks(Math.max(0, ...bars.map((b) => stackTotal(b.values, vis))), 4, true);
    const inner = W - PAD.l - PAD.r;
    const slot = inner / Math.max(1, bars.length);
    const bw = Math.max(1, slot * 0.78);
    const sy = (v: number) => (v / ymax) * (h - PAD.t - PAD.b);
    const every = Math.max(1, Math.ceil(bars.length / 8));
    return {
      slot, bw,
      yTicks: ticks.map((v) => ({ v, y: h - PAD.b - sy(v) })),
      xTicks: bars
        .map((b, i) => ({ b, i }))
        .filter(({ i }) => i % every === 0)
        .map(({ b, i }) => ({ x: PAD.l + slot * i + slot / 2, label: b.label })),
      bars: bars.map((b, i) => ({
        key: b.key,
        slotX: PAD.l + slot * i,
        x: PAD.l + slot * i + (slot - bw) / 2,
        rects: stackSegments(b.values, vis)
          .filter((s) => s.value > 0)
          .map((s) => ({ name: series[s.index]?.name ?? '', color: series[s.index]?.color ?? 'gray', y: h - PAD.b - sy(s.end), h: sy(s.value) })),
      })),
    };
  });

  protected readonly tip = computed<Tip | null>(() => {
    const i = this.active();
    const b = i === null ? undefined : this.bars()[i];
    if (!b) return null;
    const vis = this.visible();
    const leftPct = ((PAD.l + this.l().slot * (i! + 0.5)) / W) * 100;
    const rows = this.series().flatMap((s, k) => (vis[k] ? [{ name: s.name, color: s.color, value: this.yFormat()(b.values[k] ?? 0) }] : []));
    if (this.series().length > 1) rows.push({ name: 'Total', color: 'transparent', value: this.yFormat()(stackTotal(b.values, vis)) });
    return { title: b.label, leftPct, flip: leftPct > 62, rows };
  });

  protected toggle(name: string): void {
    this.hidden.update((h) => toggled(h, name));
  }

  protected move(ev: PointerEvent): void {
    const n = this.bars().length;
    if (n === 0) return;
    const rect = (ev.currentTarget as SVGElement).getBoundingClientRect();
    const vx = ((ev.clientX - rect.left) / rect.width) * W;
    this.active.set(Math.min(n - 1, Math.max(0, Math.floor((vx - PAD.l) / this.l().slot))));
  }

  protected leave(): void {
    if (document.activeElement !== null && !(document.activeElement instanceof SVGElement)) this.active.set(null);
  }

  protected focusIn(): void {
    if (this.active() === null && this.bars().length > 0) this.active.set(this.bars().length - 1);
  }

  protected key(ev: KeyboardEvent): void {
    const n = this.bars().length;
    if (n === 0) return;
    const cur = this.active() ?? n - 1;
    const next = ev.key === 'ArrowLeft' ? cur - 1 : ev.key === 'ArrowRight' ? cur + 1 : ev.key === 'Home' ? 0 : ev.key === 'End' ? n - 1 : null;
    if (next === null) return;
    ev.preventDefault();
    this.active.set(Math.min(n - 1, Math.max(0, next)));
  }
}

// ------------------------------------------------------------------------------------------------ horizontal bars

@Component({
  selector: 'app-hbar-chart',
  template: `
    <div class="chart-wrap" role="group" [attr.aria-label]="label()">
      @if (hasData()) {
        <div class="hbar" role="list" [attr.aria-label]="label()">
          @for (r of rows(); track r.label) {
            <div class="hrow" role="listitem" tabindex="0" [attr.aria-label]="describe(r)">
              <span class="hl wrap-any" [attr.title]="r.label">{{ r.label }}</span>
              <span class="htrack" aria-hidden="true">
                @for (s of segs(r); track s.name) { <span class="hseg" [style.width.%]="s.pct" [style.background]="s.color"></span> }
              </span>
              <span class="hv">{{ valueFormat()(total(r)) }}</span>
              <span class="hbreak" aria-hidden="true">{{ breakdown(r) }}</span>
            </div>
          }
        </div>
        @if (series().length > 1) {
          <div class="chart-legend">
            @for (s of series(); track s.name) {
              <button type="button" class="chart-chip" [class.off]="hidden().has(s.name)" [attr.aria-pressed]="!hidden().has(s.name)"
                      (click)="toggle(s.name)" [attr.title]="'Show or hide ' + s.name">
                <i [style.background]="s.color"></i>{{ s.name }}</button>
            }
          </div>
        }
      } @else {
        <div class="empty">{{ emptyText() }}</div>
      }
    </div>
  `,
})
export class HBarChart {
  readonly rows = input.required<HRow[]>();
  readonly series = input.required<BarSeries[]>();
  readonly label = input('Bar chart');
  readonly valueFormat = input<(n: number) => string>(fmtNum);
  readonly emptyText = input('No data in this period');

  protected readonly hidden = signal<ReadonlySet<string>>(new Set());
  private readonly visible = computed(() => this.series().map((s) => !this.hidden().has(s.name)));
  protected readonly hasData = computed(() => this.rows().some((r) => stackTotal(r.values) > 0));
  private readonly max = computed(() => Math.max(1, ...this.rows().map((r) => stackTotal(r.values, this.visible()))));

  protected total(r: HRow): number {
    return stackTotal(r.values, this.visible());
  }

  protected segs(r: HRow): { name: string; color: string; pct: number }[] {
    const max = this.max();
    const series = this.series();
    return stackSegments(r.values, this.visible())
      .filter((s) => s.value > 0)
      .map((s) => ({ name: series[s.index]?.name ?? '', color: series[s.index]?.color ?? 'gray', pct: (s.value / max) * 100 }));
  }

  protected breakdown(r: HRow): string {
    return this.series().map((s, k) => `${s.name} ${this.valueFormat()(r.values[k] ?? 0)}`).join(' · ');
  }

  protected describe(r: HRow): string {
    return `${r.label}: ${this.breakdown(r)}`;
  }

  protected toggle(name: string): void {
    this.hidden.update((h) => toggled(h, name));
  }
}
