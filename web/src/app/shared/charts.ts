import { Component, computed, input, signal } from '@angular/core';
import { fmtTime } from '../core/util';

export interface LineSeries {
  name: string;
  color: string;
  points: { x: number; y: number }[];
}

export interface BarSeries {
  name: string;
  color: string;
}

export interface Bar {
  ts: number;
  values: number[];
}

const W = 800;
const PAD = { l: 44, r: 12, t: 10, b: 26 };

function niceMax(v: number): number {
  if (v <= 4) return 4;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

function tickLabel(ms: number, spanMs: number): string {
  const d = new Date(ms);
  return spanMs > 2 * 86400_000
    ? d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
    : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Minimal dependency-free SVG line chart with hover read-out. */
@Component({
  selector: 'app-line-chart',
  template: `
    @if (layout(); as l) {
      <svg [attr.viewBox]="'0 0 ' + W + ' ' + height()" role="img" [attr.aria-label]="label()"
           (pointermove)="move($event)" (pointerleave)="hover.set(null)">
        @for (t of l.yTicks; track t.v) {
          <line [attr.x1]="pad.l" [attr.x2]="W - pad.r" [attr.y1]="t.y" [attr.y2]="t.y" class="grid" />
          <text [attr.x]="pad.l - 6" [attr.y]="t.y + 4" text-anchor="end">{{ t.v }}</text>
        }
        @for (t of l.xTicks; track t.x) {
          <text [attr.x]="t.x" [attr.y]="height() - 6" text-anchor="middle">{{ t.label }}</text>
        }
        @for (p of l.paths; track p.name) {
          <path [attr.d]="p.d" fill="none" stroke-width="2" stroke-linejoin="round" [style.stroke]="p.color" />
        }
        @if (hover(); as h) {
          <line [attr.x1]="h.x" [attr.x2]="h.x" [attr.y1]="pad.t" [attr.y2]="height() - pad.b" class="cross" />
        }
      </svg>
      <div class="legend" aria-live="polite">
        @for (s of series(); track s.name) {
          <span><i [style.background]="s.color"></i>{{ s.name }}@if (hover(); as h) {: <b>{{ valueFor(h.ts, s) }}</b>}</span>
        }
        @if (hover(); as h) { <span class="muted">{{ fmt(h.ts) }}</span> }
      </div>
    } @else {
      <div class="empty">No data yet</div>
    }
  `,
  styles: `
    svg { width: 100%; height: auto; display: block; touch-action: pan-y; }
    text { font-size: 11px; fill: var(--ml-muted); }
    .grid { stroke: var(--mat-sys-outline-variant); stroke-width: 1; }
    .cross { stroke: var(--ml-muted); stroke-dasharray: 3 3; }
    .legend { display: flex; gap: 16px; flex-wrap: wrap; font: var(--mat-sys-label-medium); padding: 4px 0 0 44px; }
    .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; }
  `,
})
export class LineChart {
  readonly series = input.required<LineSeries[]>();
  readonly height = input(200);
  readonly label = input('Line chart');
  protected readonly W = W;
  protected readonly pad = PAD;
  protected readonly hover = signal<{ x: number; ts: number } | null>(null);

  protected readonly layout = computed(() => {
    const all = this.series().flatMap((s) => s.points);
    if (all.length === 0) return null;
    const xmin = Math.min(...all.map((p) => p.x));
    let xmax = Math.max(...all.map((p) => p.x));
    if (xmax === xmin) xmax = xmin + 1;
    const ymax = niceMax(Math.max(...all.map((p) => p.y)));
    const h = this.height();
    const sx = (x: number) => PAD.l + ((x - xmin) / (xmax - xmin)) * (W - PAD.l - PAD.r);
    const sy = (y: number) => h - PAD.b - (y / ymax) * (h - PAD.t - PAD.b);
    return {
      xmin, xmax, sx,
      yTicks: [0, 1, 2, 3, 4].map((i) => ({ v: Math.round((ymax / 4) * i), y: sy((ymax / 4) * i) })),
      xTicks: [0, 1, 2, 3, 4].map((i) => {
        const x = xmin + ((xmax - xmin) / 4) * i;
        return { x: sx(x), label: tickLabel(x, xmax - xmin) };
      }),
      paths: this.series().map((s) => ({
        name: s.name,
        color: s.color,
        d: s.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(' '),
      })),
    };
  });

  protected move(ev: PointerEvent): void {
    const l = this.layout();
    if (!l) return;
    const rect = (ev.currentTarget as SVGElement).getBoundingClientRect();
    const vx = ((ev.clientX - rect.left) / rect.width) * W;
    const ts = l.xmin + ((vx - PAD.l) / (W - PAD.l - PAD.r)) * (l.xmax - l.xmin);
    const first = this.series()[0]?.points ?? [];
    if (first.length === 0) return;
    const nearest = first.reduce((a, b) => (Math.abs(b.x - ts) < Math.abs(a.x - ts) ? b : a));
    this.hover.set({ x: l.sx(nearest.x), ts: nearest.x });
  }

  protected valueFor(ts: number, s: LineSeries): number | string {
    const p = s.points.reduce<{ x: number; y: number } | null>(
      (a, b) => (a === null || Math.abs(b.x - ts) < Math.abs(a.x - ts) ? b : a), null);
    return p ? p.y : '–';
  }

  protected fmt(ts: number): string {
    return fmtTime(ts);
  }
}

/** Minimal dependency-free stacked bar chart; each bar has a native tooltip. */
@Component({
  selector: 'app-stacked-bars',
  template: `
    @if (layout(); as l) {
      <svg [attr.viewBox]="'0 0 ' + W + ' ' + height()" role="img" [attr.aria-label]="label()">
        @for (t of l.yTicks; track t.v) {
          <line [attr.x1]="pad.l" [attr.x2]="W - pad.r" [attr.y1]="t.y" [attr.y2]="t.y" class="grid" />
          <text [attr.x]="pad.l - 6" [attr.y]="t.y + 4" text-anchor="end">{{ t.v }}</text>
        }
        @for (b of l.bars; track b.ts) {
          <g>
            <title>{{ b.title }}</title>
            @for (r of b.rects; track $index) {
              <rect [attr.x]="b.x" [attr.y]="r.y" [attr.width]="l.bw" [attr.height]="r.h" [style.fill]="r.color" />
            }
          </g>
        }
        @for (t of l.xTicks; track t.x) {
          <text [attr.x]="t.x" [attr.y]="height() - 6" text-anchor="middle">{{ t.label }}</text>
        }
      </svg>
      <div class="legend">
        @for (s of series(); track s.name) { <span><i [style.background]="s.color"></i>{{ s.name }}</span> }
      </div>
    } @else {
      <div class="empty">No data in this period</div>
    }
  `,
  styles: `
    svg { width: 100%; height: auto; display: block; }
    text { font-size: 11px; fill: var(--ml-muted); }
    .grid { stroke: var(--mat-sys-outline-variant); stroke-width: 1; }
    .legend { display: flex; gap: 16px; flex-wrap: wrap; font: var(--mat-sys-label-medium); padding: 4px 0 0 44px; }
    .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; }
  `,
})
export class StackedBars {
  readonly bars = input.required<Bar[]>();
  readonly series = input.required<BarSeries[]>();
  readonly height = input(220);
  readonly label = input('Bar chart');
  protected readonly W = W;
  protected readonly pad = PAD;

  protected readonly layout = computed(() => {
    const bars = this.bars();
    if (bars.length === 0) return null;
    const series = this.series();
    const totals = bars.map((b) => b.values.reduce((a, v) => a + v, 0));
    const max = Math.max(...totals);
    if (max === 0) return null;
    const ymax = niceMax(max);
    const h = this.height();
    const inner = W - PAD.l - PAD.r;
    const slot = inner / bars.length;
    const bw = Math.max(1, slot * 0.8);
    const sy = (v: number) => (v / ymax) * (h - PAD.t - PAD.b);
    const span = bars[bars.length - 1].ts - bars[0].ts;
    const every = Math.max(1, Math.ceil(bars.length / 8));
    return {
      bw,
      yTicks: [0, 1, 2, 3, 4].map((i) => ({
        v: Math.round((ymax / 4) * i),
        y: h - PAD.b - sy((ymax / 4) * i),
      })),
      xTicks: bars
        .map((b, i) => ({ b, i }))
        .filter(({ i }) => i % every === 0)
        .map(({ b, i }) => ({ x: PAD.l + slot * i + bw / 2, label: tickLabel(b.ts, span) })),
      bars: bars.map((b, i) => {
        let base = h - PAD.b;
        const rects = b.values.map((v, k) => {
          const bh = sy(v);
          base -= bh;
          return { y: base, h: bh, color: series[k]?.color ?? 'gray' };
        });
        return {
          ts: b.ts,
          x: PAD.l + slot * i + (slot - bw) / 2,
          rects,
          title: `${fmtTime(b.ts)}\n` + b.values.map((v, k) => `${series[k]?.name}: ${v}`).join('\n'),
        };
      }),
    };
  });
}
