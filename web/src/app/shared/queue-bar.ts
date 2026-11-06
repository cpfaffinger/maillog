import { Component, computed, input } from '@angular/core';
import { QueueSnapshot } from '../api/models';
import { queueScale, queueState, queueUtilisation, QueueLimits } from '../features/stats/stats-data';
import { fmtPct } from './chart-utils';

/** Current Postfix queue as one stacked horizontal bar with warn/fail threshold markers. */
@Component({
  selector: 'app-queue-bar',
  template: `
    <div class="qb" [class]="'qb ' + state()">
      <div class="qh">
        <b>{{ name() }}</b><span class="pill neutral">{{ role() }}</span><span class="spacer"></span>
        <span class="pill {{ state() }}">{{ state() === 'ok' ? 'normal' : state() === 'warn' ? 'warning' : 'critical' }}</span>
      </div>
      @if (snapshot(); as q) {
        <div class="qtrack" role="meter" aria-valuemin="0" [attr.aria-valuemax]="scale()" [attr.aria-valuenow]="q.total"
             [attr.aria-label]="name() + ' queue: ' + summary()" tabindex="0" [attr.title]="summary()">
          @for (s of segments(); track s.name) { <span class="qseg" [style.width.%]="s.pct" [style.background]="s.color" [attr.title]="s.name + ' ' + s.value"></span> }
          @for (m of marks(); track m.label) { <span class="qmark" [style.left.%]="m.pct" [style.background]="m.color" [attr.title]="m.label"></span> }
        </div>
        <div class="qlegend muted">
          @for (s of segments(); track s.name) { <span><i [style.background]="s.color"></i>{{ s.name }} {{ s.value }}</span> }
        </div>
        <div class="qsum">{{ q.total }} queued@if (util() !== null) { · <b class="u">{{ pct(util()) }}</b> of the {{ limits().fail !== undefined ? 'fail' : 'warn' }} threshold }
          @for (m of marks(); track m.label) { <span class="muted"> · {{ m.label }}</span> }
        </div>
      } @else {
        <p class="muted">No queue data reported yet.</p>
      }
    </div>
  `,
  styles: `
    .qb { padding: 8px 0 12px; }
    .qh { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .qtrack { position: relative; display: flex; height: 22px; background: var(--mat-sys-surface-container-highest);
              border-radius: 6px; border: 2px solid var(--mat-sys-outline-variant); overflow: visible; }
    .qb.warn .qtrack { border-color: var(--ml-warn); }
    .qb.fail .qtrack { border-color: var(--ml-fail); }
    .qtrack:focus-visible { outline: 2px solid var(--mat-sys-primary); outline-offset: 2px; }
    .qseg { height: 100%; }
    .qseg:first-child { border-radius: 4px 0 0 4px; }
    .qmark { position: absolute; top: -4px; bottom: -4px; width: 3px; border-radius: 2px; }
    .qlegend { display: flex; flex-wrap: wrap; gap: 4px 14px; font: var(--mat-sys-label-small); margin-top: 6px; }
    .qlegend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; }
    .qsum { margin-top: 2px; font: var(--mat-sys-label-large); }
    .qb.warn .u { color: var(--ml-warn); } .qb.fail .u { color: var(--ml-fail); }
  `,
})
export class QueueBar {
  readonly name = input.required<string>();
  readonly role = input('');
  readonly snapshot = input<QueueSnapshot | null>(null);
  readonly limits = input<QueueLimits>({});

  protected readonly pct = fmtPct;
  protected readonly state = computed(() => queueState(this.snapshot()?.total ?? 0, this.limits()));
  protected readonly util = computed(() => queueUtilisation(this.snapshot()?.total ?? 0, this.limits()));
  protected readonly scale = computed(() => queueScale(this.snapshot()?.total ?? 0, this.limits()));

  protected readonly segments = computed(() => {
    const q = this.snapshot();
    if (!q) return [];
    const scale = this.scale();
    return [
      { name: 'active', value: q.active, color: 'var(--ml-info)' },
      { name: 'deferred', value: q.deferred, color: 'var(--ml-warn)' },
      { name: 'hold', value: q.hold, color: 'var(--ml-muted)' },
      { name: 'incoming', value: q.incoming, color: 'var(--ml-c5)' },
    ].map((s) => ({ ...s, pct: (s.value / scale) * 100 }));
  });

  protected readonly marks = computed(() => {
    const l = this.limits();
    const scale = this.scale();
    const out: { label: string; pct: number; color: string }[] = [];
    if (l.warn !== undefined) out.push({ label: `warn ${l.warn}`, pct: Math.min(100, (l.warn / scale) * 100), color: 'var(--ml-warn)' });
    if (l.fail !== undefined) out.push({ label: `fail ${l.fail}`, pct: Math.min(100, (l.fail / scale) * 100), color: 'var(--ml-fail)' });
    return out;
  });

  protected readonly summary = computed(() => {
    const q = this.snapshot();
    return q ? `${q.total} messages (active ${q.active}, deferred ${q.deferred}, hold ${q.hold}, incoming ${q.incoming})` : 'no data';
  });
}
