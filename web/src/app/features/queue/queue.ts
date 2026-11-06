import { Component, inject, signal } from '@angular/core';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { ApiService } from '../../api/api.service';
import { QueueAgent } from '../../api/models';
import { DurPipe, TsPipe } from '../../core/pipes';
import { polling } from '../../core/util';
import { LineChart, LineSeries } from '../../shared/charts';

@Component({
  selector: 'app-queue',
  imports: [MatFormFieldModule, MatSelectModule, LineChart, DurPipe, TsPipe],
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Postfix queue</h1><span class="spacer"></span>
        <mat-form-field subscriptSizing="dynamic">
          <mat-label>History</mat-label>
          <mat-select [value]="hours()" (selectionChange)="setHours($event.value)">
            <mat-option [value]="6">6 hours</mat-option>
            <mat-option [value]="24">24 hours</mat-option>
            <mat-option [value]="72">3 days</mat-option>
            <mat-option [value]="168">7 days</mat-option>
          </mat-select>
        </mat-form-field>
      </div>

      @if (agents(); as list) {
        @if (list.length === 0) { <div class="empty card">No agents reporting yet.</div> }
        <div class="grid wide">
          @for (a of list; track a.id) {
            <article class="card" [attr.aria-label]="'Queue of ' + a.name">
              <h2>{{ a.name }} <span class="pill neutral">{{ a.role }}</span></h2>
              @if (a.current; as q) {
                <dl class="nums">
                  <div [class.warn]="q.total > 0"><dt>Total</dt><dd>{{ q.total }}</dd></div>
                  <div><dt>Active</dt><dd>{{ q.active }}</dd></div>
                  <div [class.warn]="q.deferred > 0"><dt>Deferred</dt><dd>{{ q.deferred }}</dd></div>
                  <div><dt>Hold</dt><dd>{{ q.hold }}</dd></div>
                  <div><dt>Incoming</dt><dd>{{ q.incoming }}</dd></div>
                  <div><dt>Oldest (any)</dt><dd>{{ q.oldestAgeS | dur }}</dd></div>
                  <div [class.warn]="(q.oldestActiveAgeS ?? 0) > 600"><dt>Oldest active</dt><dd>{{ q.oldestActiveAgeS ?? null | dur }}</dd></div>
                </dl>
                <p class="muted small">Snapshot {{ q.ts | ts }}</p>
                <div class="tops">
                  <section><h3>Top sender domains</h3>@for (r of q.topSenderDomains; track r.name) {
                    <div class="row"><span class="wrap-any">{{ r.name }}</span><b>{{ r.count }}</b></div>
                  } @empty { <span class="muted">–</span> }</section>
                  <section><h3>Top recipient domains</h3>@for (r of q.topRecipientDomains; track r.name) {
                    <div class="row"><span class="wrap-any">{{ r.name }}</span><b>{{ r.count }}</b></div>
                  } @empty { <span class="muted">–</span> }</section>
                  <section class="reasons"><h3>Top delay reasons</h3>@for (r of q.topReasons; track r.name) {
                    <div class="row"><span class="wrap-any">{{ r.name }}</span><b>{{ r.count }}</b></div>
                  } @empty { <span class="muted">–</span> }</section>
                </div>
              } @else {
                <p class="muted">No queue snapshot reported yet.</p>
              }
              <h3>History</h3>
              <app-line-chart [series]="chartFor(a)" [height]="180" [label]="'Queue history of ' + a.name" />
            </article>
          }
        </div>
      } @else {
        <div class="empty">Loading…</div>
      }
    </div>
  `,
  styles: `
    .grid.wide { grid-template-columns: repeat(auto-fill, minmax(min(100%, 520px), 1fr)); }
    .nums { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 8px 0; }
    .nums div { background: var(--mat-sys-surface-container-high); border-radius: 8px; padding: 6px 10px; }
    .nums .warn dd { color: var(--ml-warn); }
    dt { font: var(--mat-sys-label-small); color: var(--ml-muted); }
    dd { margin: 0; font: var(--mat-sys-title-medium); }
    h3 { font: var(--mat-sys-label-large); color: var(--ml-muted); margin: 12px 0 4px; }
    .small { font-size: 0.85em; margin: 0; }
    .tops { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px 16px; }
    .row { display: flex; justify-content: space-between; gap: 8px; }
  `,
})
export class QueuePage {
  private readonly api = inject(ApiService);
  protected readonly hours = signal(24);
  protected readonly agents = signal<QueueAgent[] | null>(null);

  constructor() {
    polling(() => this.load(), 30_000);
  }

  protected setHours(h: number): void {
    this.hours.set(h);
    void this.load();
  }

  protected chartFor(a: QueueAgent): LineSeries[] {
    return [
      { name: 'Total', color: 'var(--ml-info)', points: a.series.map((p) => ({ x: p.ts, y: p.total })) },
      { name: 'Deferred', color: 'var(--ml-warn)', points: a.series.map((p) => ({ x: p.ts, y: p.deferred })) },
    ];
  }

  private async load(): Promise<void> {
    try {
      this.agents.set((await this.api.queue(this.hours())).agents);
    } catch {
      /* reported by the interceptor */
    }
  }
}
