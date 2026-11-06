import { Component, computed, inject, signal } from '@angular/core';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { ApiService } from '../../api/api.service';
import { Agent, StatRow } from '../../api/models';
import { AuthService } from '../../core/auth.service';
import { Bar, BarSeries, StackedBars } from '../../shared/charts';

const SERIES: BarSeries[] = [
  { name: 'Sent', color: 'var(--ml-ok)' },
  { name: 'Deferred', color: 'var(--ml-warn)' },
  { name: 'Bounced', color: 'var(--ml-fail)' },
];

/** Sums rows per hour (optionally for one agent) into stacked-bar input. */
export function toBars(rows: StatRow[], agent: string): Bar[] {
  const byHour = new Map<number, number[]>();
  for (const r of rows) {
    if (agent && r.agentId !== agent) continue;
    const v = byHour.get(r.hour) ?? [0, 0, 0];
    v[0] += r.sent;
    v[1] += r.deferred;
    v[2] += r.bounced;
    byHour.set(r.hour, v);
  }
  return [...byHour].sort((a, b) => a[0] - b[0]).map(([ts, values]) => ({ ts, values }));
}

@Component({
  selector: 'app-stats',
  imports: [MatFormFieldModule, MatSelectModule, StackedBars],
  template: `
    <div class="page">
      <div class="page-head"><h1>Statistics</h1><span class="spacer"></span>
        @if (staff()) {
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>Agent</mat-label>
            <mat-select [value]="agent()" (selectionChange)="agent.set($event.value)">
              <mat-option value="">All agents</mat-option>
              @for (a of agents(); track a.id) { <mat-option [value]="a.id">{{ a.name }}</mat-option> }
            </mat-select>
          </mat-form-field>
        }
        <mat-form-field subscriptSizing="dynamic">
          <mat-label>Period</mat-label>
          <mat-select [value]="hours()" (selectionChange)="setHours($event.value)">
            <mat-option [value]="24">24 hours</mat-option>
            <mat-option [value]="48">48 hours</mat-option>
            <mat-option [value]="168">7 days</mat-option>
            <mat-option [value]="336">14 days</mat-option>
          </mat-select>
        </mat-form-field>
      </div>

      <dl class="totals">
        <div><dt>Sent</dt><dd class="ok">{{ totals().sent }}</dd></div>
        <div><dt>Deferred</dt><dd class="warn">{{ totals().deferred }}</dd></div>
        <div><dt>Bounced</dt><dd class="fail">{{ totals().bounced }}</dd></div>
      </dl>

      <section class="card" aria-label="Hourly deliveries">
        <h2>Deliveries per hour</h2>
        <app-stacked-bars [bars]="bars()" [series]="series" [height]="260" label="Deliveries per hour" />
      </section>
    </div>
  `,
  styles: `
    .totals { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 0 0 16px; }
    .totals div { background: var(--mat-sys-surface-container); border-radius: 12px; padding: 12px 16px; }
    dt { font: var(--mat-sys-label-medium); color: var(--ml-muted); }
    dd { margin: 0; font: var(--mat-sys-headline-small); }
    dd.ok { color: var(--ml-ok); } dd.warn { color: var(--ml-warn); } dd.fail { color: var(--ml-fail); }
  `,
})
export class Stats {
  private readonly api = inject(ApiService);
  protected readonly staff = inject(AuthService).isOperator;
  protected readonly series = SERIES;
  protected readonly hours = signal(48);
  protected readonly agent = signal('');
  protected readonly agents = signal<Agent[]>([]);
  private readonly rows = signal<StatRow[]>([]);

  protected readonly bars = computed(() => toBars(this.rows(), this.agent()));
  protected readonly totals = computed(() =>
    this.bars().reduce(
      (t, b) => ({ sent: t.sent + b.values[0], deferred: t.deferred + b.values[1], bounced: t.bounced + b.values[2] }),
      { sent: 0, deferred: 0, bounced: 0 },
    ),
  );

  constructor() {
    if (this.staff()) void this.api.agents().then((a) => this.agents.set(a)).catch(() => undefined);
    void this.load();
  }

  protected setHours(h: number): void {
    this.hours.set(h);
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.rows.set((await this.api.stats(this.hours())).rows);
    } catch {
      /* reported by the interceptor */
    }
  }
}
