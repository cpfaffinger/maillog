import { Component, computed, inject, signal } from '@angular/core';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { ApiService } from '../../api/api.service';
import { StatsSummary } from '../../api/models';
import { AuthService } from '../../core/auth.service';
import { browserTz, fmtNum, fmtPct, fmtSeconds } from '../../shared/chart-utils';
import { BarChart, HBarChart, LineChart } from '../../shared/charts';
import {
  delayLines, DOMAIN_SERIES, domainRows, HOUR_SERIES, hourBars, OUTCOME_SERIES, outcomeBars, sentBouncedLines,
} from './stats-data';
import { StatsTabs } from './stats-tabs';

export const PERIODS = [7, 30, 90, 365];

@Component({
  selector: 'app-stats',
  imports: [MatButtonToggleModule, MatProgressBarModule, LineChart, BarChart, HBarChart, StatsTabs],
  template: `
    <div class="page">
      <div class="page-head">
        <h1>{{ staff() ? 'Mail statistics' : 'Your mail statistics' }}</h1>
        <span class="spacer"></span>
        <mat-button-toggle-group [value]="days()" (change)="setDays($event.value)" aria-label="Period" hideSingleSelectionIndicator>
          @for (p of periods; track p) { <mat-button-toggle [value]="p">{{ p }} days</mat-button-toggle> }
        </mat-button-toggle-group>
      </div>
      @if (staff()) { <app-stats-tabs /> }

      @if (data(); as d) {
        @if (d.scope.domains; as doms) {
          <div class="scope" aria-label="Your sender domains">
            <span class="muted">Mail sent from</span>
            @for (dom of doms; track dom) { <span class="pill neutral">{{ '@' + dom }}</span> }
          </div>
        }
        @if (loading()) { <mat-progress-bar mode="indeterminate" aria-label="Loading" /> }

        <dl class="kpis" aria-label="Key figures">
          <div class="kpi"><dt>Sent</dt><dd>{{ fmt(d.totals.sent) }}</dd></div>
          <div class="kpi"><dt>Delivered</dt><dd [class.ok]="(d.totals.deliveredPct ?? 0) >= 98">{{ pct(d.totals.deliveredPct) }}</dd></div>
          <div class="kpi"><dt>Bounced</dt><dd [class.fail]="d.totals.bounced > 0">{{ fmt(d.totals.bounced) }}</dd></div>
          <div class="kpi"><dt>Deferrals</dt><dd [class.warn]="d.totals.deferred > 0">{{ fmt(d.totals.deferred) }}</dd></div>
          <div class="kpi"><dt>Avg delivery time</dt><dd>{{ secs(d.totals.avgDelayS) }}</dd><dd class="sub">95th pct {{ secs(d.totals.p95DelayS) }}</dd></div>
        </dl>
        <p class="muted caption">
          <b>Sent</b> counts deliveries to the final recipient server. <b>Deferrals</b> are delivery attempts that were postponed;
          one message can be deferred several times.
        </p>

        <div class="charts">
          <section class="card wide" aria-labelledby="c1">
            <h2 id="c1">Mails sent per day</h2>
            <app-line-chart [series]="sentLines()" xKind="day" [tz]="d.tz" xHeader="Day" label="Mails sent and bounced per day"
                            emptyText="No mail was sent in this period." />
          </section>
          <section class="card wide" aria-labelledby="c2">
            <h2 id="c2">Daily outcome</h2>
            <app-bar-chart [bars]="outcome()" [series]="outcomeSeries" xHeader="Day" label="Sent, deferred, bounced and rejected per day"
                           emptyText="No delivery activity in this period." />
          </section>
          <section class="card" aria-labelledby="c3">
            <h2 id="c3">Top sender domains</h2>
            <app-hbar-chart [rows]="senderRows()" [series]="domainSeries" label="Top sender domains" emptyText="No data in this period." />
          </section>
          <section class="card" aria-labelledby="c4">
            <h2 id="c4">Top recipient domains</h2>
            <app-hbar-chart [rows]="recipientRows()" [series]="domainSeries" label="Top recipient domains" emptyText="No data in this period." />
          </section>
          <section class="card" aria-labelledby="c5">
            <h2 id="c5">Sent by hour of day</h2>
            <app-bar-chart [bars]="hours()" [series]="hourSeries" [height]="220" xHeader="Hour" label="Mails sent by hour of day"
                           emptyText="No mail was sent in this period." />
          </section>
          <section class="card" aria-labelledby="c6">
            <h2 id="c6">Delivery time per day</h2>
            <app-line-chart [series]="delay()" xKind="day" [tz]="d.tz" [yFormat]="secs" [yIntegers]="false" [height]="220" xHeader="Day"
                            label="Average and 95th percentile delivery time per day" emptyText="No delivery time data in this period." />
          </section>
          <section class="card wide" aria-labelledby="c7">
            <h2 id="c7">Top bounce reasons</h2>
            @if (d.bounceReasons.length > 0) {
              <div class="table-wrap flat">
                <table class="ml-table" aria-label="Top bounce reasons">
                  <thead><tr><th>DSN</th><th>Reason</th><th class="num">Count</th></tr></thead>
                  <tbody>
                    @for (r of d.bounceReasons; track r.dsn + r.reason) {
                      <tr><td class="mono">{{ r.dsn }}</td><td class="wrap-any">{{ r.reason }}</td><td class="num">{{ fmt(r.count) }}</td></tr>
                    }
                  </tbody>
                </table>
              </div>
            } @else {
              <div class="empty">No bounces in this period.</div>
            }
          </section>
        </div>
      } @else {
        <div class="kpis"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>
        <div class="charts"><div class="skeleton tall wide"></div><div class="skeleton tall wide"></div><div class="skeleton tall"></div><div class="skeleton tall"></div></div>
      }
    </div>
  `,
  styles: `
    .scope { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 12px; }
    .kpis { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); margin: 12px 0 4px; }
    .kpi { background: var(--mat-sys-surface-container); border-radius: 12px; padding: 12px 16px; }
    dt { font: var(--mat-sys-label-medium); color: var(--ml-muted); }
    dd { margin: 0; font: var(--mat-sys-headline-small); }
    dd.sub { font: var(--mat-sys-label-medium); color: var(--ml-muted); }
    dd.ok { color: var(--ml-ok); } dd.warn { color: var(--ml-warn); } dd.fail { color: var(--ml-fail); }
    .caption { font-size: 0.85em; margin: 4px 0 16px; }
    .charts { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); }
    .wide { grid-column: 1 / -1; }
    .tall { min-height: 220px; }
    .flat { background: transparent; }
    .num { text-align: right; }
    .kpis .skeleton { height: 84px; }
  `,
})
export class Stats {
  private readonly api = inject(ApiService);
  protected readonly staff = inject(AuthService).isOperator;
  protected readonly periods = PERIODS;
  protected readonly outcomeSeries = OUTCOME_SERIES;
  protected readonly domainSeries = DOMAIN_SERIES;
  protected readonly hourSeries = HOUR_SERIES;

  protected readonly days = signal(30);
  protected readonly data = signal<StatsSummary | null>(null);
  protected readonly loading = signal(false);
  private requestId = 0;

  protected readonly sentLines = computed(() => sentBouncedLines(this.data()?.daily ?? []));
  protected readonly outcome = computed(() => outcomeBars(this.data()?.daily ?? [], this.data()?.tz ?? 0));
  protected readonly delay = computed(() => delayLines(this.data()?.daily ?? []));
  protected readonly hours = computed(() => hourBars(this.data()?.hourOfDay ?? []));
  protected readonly senderRows = computed(() => domainRows(this.data()?.topSenderDomains ?? []));
  protected readonly recipientRows = computed(() => domainRows(this.data()?.topRecipientDomains ?? []));

  protected readonly fmt = fmtNum;
  protected readonly pct = fmtPct;
  protected readonly secs = fmtSeconds;

  constructor() {
    void this.load();
  }

  protected setDays(d: number): void {
    this.days.set(d);
    void this.load();
  }

  private async load(): Promise<void> {
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
