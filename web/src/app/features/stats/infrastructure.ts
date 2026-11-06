import { Component, computed, inject, signal } from '@angular/core';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { ApiService } from '../../api/api.service';
import { Agent, QueueAgent, StatsSummary } from '../../api/models';
import { browserTz } from '../../shared/chart-utils';
import { BarChart, HBarChart, LineChart } from '../../shared/charts';
import { QueueBar } from '../../shared/queue-bar';
import { polling } from '../../core/util';
import {
  ACCEPTED_SERIES, AUTH_SERIES, authBars, COUNT_SERIES, limitThresholds, nameCountRows, queueLimits, queueLines,
} from './stats-data';
import { StatsTabs } from './stats-tabs';

const QUEUE_RANGES = [
  { hours: 24, label: '24 hours' },
  { hours: 168, label: '7 days' },
  { hours: 720, label: '30 days' },
];

@Component({
  selector: 'app-infrastructure',
  imports: [MatButtonToggleModule, MatFormFieldModule, MatSelectModule, MatProgressBarModule, LineChart, BarChart, HBarChart, QueueBar, StatsTabs],
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Infrastructure statistics</h1><span class="spacer"></span>
        <mat-button-toggle-group [value]="days()" (change)="setDays($event.value)" aria-label="Period for mail statistics" hideSingleSelectionIndicator>
          @for (p of periods; track p) { <mat-button-toggle [value]="p">{{ p }} days</mat-button-toggle> }
        </mat-button-toggle-group>
      </div>
      <app-stats-tabs />

      <section class="card block" aria-labelledby="i1">
        <h2 id="i1">Mail queue now</h2>
        @if (queue(); as agents) {
          <div class="qgrid">
            @for (a of agents; track a.id) {
              <app-queue-bar [name]="a.name" [role]="a.role" [snapshot]="a.current" [limits]="limitsOf(a.id)" />
            } @empty { <div class="empty">No agents report a queue yet.</div> }
          </div>
          <p class="muted caption">The bar ends slightly beyond the "fail" threshold. Markers show the warn/fail limits of each server's queue check; the border turns amber and red when they are reached. Refreshes every 30 s.</p>
        } @else { <div class="skeleton tall"></div> }
      </section>

      <section class="card block" aria-labelledby="i2">
        <div class="bar">
          <h2 id="i2">Queue size over time</h2><span class="spacer"></span>
          <mat-form-field subscriptSizing="dynamic" class="sel">
            <mat-label>Server</mat-label>
            <mat-select [value]="selected()" (selectionChange)="selected.set($event.value)">
              <mat-option value="">All servers</mat-option>
              @for (a of queue() ?? []; track a.id) { <mat-option [value]="a.id">{{ a.name }}</mat-option> }
            </mat-select>
          </mat-form-field>
          <mat-button-toggle-group [value]="hours()" (change)="setHours($event.value)" aria-label="Queue history range" hideSingleSelectionIndicator>
            @for (r of ranges; track r.hours) { <mat-button-toggle [value]="r.hours">{{ r.label }}</mat-button-toggle> }
          </mat-button-toggle-group>
        </div>
        <app-line-chart [series]="lines()" [thresholds]="thresholds()" [height]="240" label="Queue size over time" emptyText="No queue history in this range." />
        @if (!selected()) { <p class="muted caption">Select a single server to see its warn/fail thresholds and the deferred/active split.</p> }
      </section>

      @if (data(); as d) {
        @if (loading()) { <mat-progress-bar mode="indeterminate" aria-label="Loading" /> }
        @if (d.infrastructure; as infra) {
          <div class="charts">
            <section class="card" aria-labelledby="i3">
              <h2 id="i3">Mail accepted per server</h2>
              <app-hbar-chart [rows]="accepted()" [series]="acceptedSeries" label="Mail accepted per server" emptyText="No mail was accepted in this period." />
              <p class="muted caption">Accepted = messages submitted to that server.</p>
            </section>
            <section class="card" aria-labelledby="i4">
              <h2 id="i4">Top SASL accounts</h2>
              <app-hbar-chart [rows]="sasl()" [series]="countSeries" label="Top SASL accounts by submitted mail" emptyText="No authenticated submissions in this period." />
            </section>
            <section class="card" aria-labelledby="i5">
              <h2 id="i5">Top client IPs</h2>
              <app-hbar-chart [rows]="clients()" [series]="countSeries" label="Top client IP addresses by submitted mail" emptyText="No client activity in this period." />
            </section>
            <section class="card wide" aria-labelledby="i6">
              <h2 id="i6">Authentication failures per day</h2>
              <app-bar-chart [bars]="authDays()" [series]="authSeries" xHeader="Day" label="Authentication failures per day"
                             emptyText="No authentication failures in this period." />
              <p class="muted caption"><b>Generic failures</b> mean the authentication backend itself failed (for example saslauthd is down), not that a password was wrong. If they appear, legitimate clients are being rejected and may get banned.</p>
            </section>
          </div>
        } @else {
          <div class="empty card">No infrastructure data for this account.</div>
        }
      } @else {
        <div class="charts"><div class="skeleton tall"></div><div class="skeleton tall"></div><div class="skeleton tall"></div></div>
      }
    </div>
  `,
  styles: `
    .block { margin-bottom: 16px; }
    .qgrid { display: grid; gap: 8px 24px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); }
    .bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
    .bar h2 { margin: 0; }
    .sel { width: 200px; }
    .caption { font-size: 0.85em; margin: 8px 0 0; }
    .charts { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); }
    .wide { grid-column: 1 / -1; }
    .tall { min-height: 160px; }
  `,
})
export class Infrastructure {
  private readonly api = inject(ApiService);
  protected readonly periods = [7, 30, 90];
  protected readonly ranges = QUEUE_RANGES;
  protected readonly acceptedSeries = ACCEPTED_SERIES;
  protected readonly countSeries = COUNT_SERIES;
  protected readonly authSeries = AUTH_SERIES;

  protected readonly days = signal(30);
  protected readonly hours = signal(24);
  protected readonly selected = signal('');
  protected readonly queue = signal<QueueAgent[] | null>(null);
  protected readonly agents = signal<Agent[]>([]);
  protected readonly data = signal<StatsSummary | null>(null);
  protected readonly loading = signal(false);
  private requestId = 0;

  protected readonly lines = computed(() => queueLines(this.queue() ?? [], this.selected()));
  protected readonly thresholds = computed(() => (this.selected() ? limitThresholds(queueLimits(this.agents().find((a) => a.id === this.selected()))) : []));
  protected readonly accepted = computed(() =>
    (this.data()?.infrastructure?.byAgent ?? []).map((a) => ({ label: `${a.agentName} (${a.role})`, values: [a.accepted] })),
  );
  protected readonly sasl = computed(() => nameCountRows(this.data()?.infrastructure?.topSaslUsers ?? []));
  protected readonly clients = computed(() => nameCountRows(this.data()?.infrastructure?.topClients ?? []));
  protected readonly authDays = computed(() => authBars(this.data()?.infrastructure?.authFailuresDaily ?? [], this.data()?.tz ?? 0));

  constructor() {
    polling(() => this.loadQueue(), 30_000);
    void this.loadSummary();
  }

  protected limitsOf(agentId: string) {
    return queueLimits(this.agents().find((a) => a.id === agentId));
  }

  protected setDays(d: number): void {
    this.days.set(d);
    void this.loadSummary();
  }

  protected setHours(h: number): void {
    this.hours.set(h);
    void this.loadQueue();
  }

  private async loadQueue(): Promise<void> {
    try {
      const [q, agents] = await Promise.all([this.api.queue(this.hours()), this.api.agents()]);
      this.queue.set(q.agents);
      this.agents.set(agents);
    } catch {
      /* reported by the interceptor */
    }
  }

  private async loadSummary(): Promise<void> {
    const id = ++this.requestId;
    this.loading.set(true);
    try {
      const result = await this.api.statsSummary(this.days(), browserTz());
      if (id === this.requestId) this.data.set(result);
    } catch {
      /* reported by the interceptor */
    } finally {
      if (id === this.requestId) this.loading.set(false);
    }
  }
}
