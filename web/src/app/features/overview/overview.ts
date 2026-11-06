import { Component, inject, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../api/api.service';
import { OverviewAgent, Overview as OverviewData } from '../../api/models';
import { AgoPipe, DurPipe, TsPipe } from '../../core/pipes';
import { polling } from '../../core/util';

type AgentStatus = 'online' | 'offline' | 'pending';

@Component({
  selector: 'app-overview',
  imports: [MatIconModule, MatTooltipModule, RouterLink, DurPipe, TsPipe],
  template: `
    <div class="page">
      <div class="page-head"><h1>Overview</h1><span class="spacer"></span>
        <span class="muted">Refreshes every 15 s</span></div>

      @if (data(); as d) {
        @if (d.alerts.length > 0) {
          <section class="card alerts" aria-label="Open alerts">
            <h2><mat-icon aria-hidden="true">notifications_active</mat-icon> {{ d.alerts.length }} open alert{{ d.alerts.length === 1 ? '' : 's' }}</h2>
            <ul>
              @for (a of d.alerts; track a.id) {
                <li><span class="pill {{ a.severity }}">{{ a.severity }}</span>
                  <span class="wrap-any">{{ a.title }}</span>
                  <span class="muted">since {{ a.openedAt | ts }}</span></li>
              }
            </ul>
            <a routerLink="/alerts">All alerts</a>
          </section>
        } @else {
          <p class="allgood"><mat-icon aria-hidden="true">check_circle</mat-icon> No open alerts</p>
        }

        @if (d.agents.length === 0) {
          <div class="empty card">No agents yet. Add one under <a routerLink="/agents">Agents</a>.</div>
        }
        <div class="grid">
          @for (a of d.agents; track a.id) {
            <article class="card agent" [attr.aria-label]="'Agent ' + a.name">
              <header>
                <span class="dot {{ dotClass(a, d) }}" [attr.title]="status(a, d)"></span>
                <h2>{{ a.name }}</h2>
                <span class="pill neutral">{{ a.role }}</span>
                <span class="spacer"></span>
                <span class="muted small">{{ statusText(a, d) }}</span>
              </header>
              <div class="muted small">
                {{ a.hostname || '–' }} · agent {{ a.version || '–' }}
              </div>

              <div class="chips" role="list" aria-label="Health checks">
                @for (c of a.checks; track c.name) {
                  <span role="listitem" class="pill {{ c.state }}" [matTooltip]="(c.message || c.state) + ' · since ' + (c.since | ts)">
                    <mat-icon class="mini" aria-hidden="true">{{ c.state === 'ok' ? 'check' : c.state === 'warn' ? 'priority_high' : 'close' }}</mat-icon>{{ c.name }}
                  </span>
                } @empty {
                  <span class="muted small">No health data yet</span>
                }
              </div>

              <dl class="counters" aria-label="Last 24 hours">
                <div><dt>Sent</dt><dd>{{ a.stats24h.sent }}</dd></div>
                <div><dt>Deferred</dt><dd [class.warn]="a.stats24h.deferred > 0">{{ a.stats24h.deferred }}</dd></div>
                <div><dt>Bounced</dt><dd [class.fail]="a.stats24h.bounced > 0">{{ a.stats24h.bounced }}</dd></div>
                <div><dt>Rejected</dt><dd>{{ a.stats24h.rejected }}</dd></div>
                <div><dt>Auth fail</dt><dd>{{ a.stats24h.authFail }}</dd></div>
                <div><dt>Rate limit</dt><dd [class.warn]="a.stats24h.rateLimit > 0">{{ a.stats24h.rateLimit }}</dd></div>
              </dl>

              @if (a.queue; as q) {
                <a class="qline" routerLink="/queue">
                  <mat-icon aria-hidden="true">queue</mat-icon>
                  Queue {{ q.total }} · {{ q.deferred }} deferred · oldest {{ q.oldestAgeS | dur }}@if (q.oldestActiveAgeS != null) { · oldest active {{ q.oldestActiveAgeS | dur }} }
                </a>
              }
            </article>
          }
        </div>
      } @else {
        <div class="empty">Loading…</div>
      }
    </div>
  `,
  styles: `
    .alerts ul { list-style: none; padding: 0; margin: 0 0 8px; display: grid; gap: 6px; }
    .alerts li { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .alerts { margin-bottom: 16px; border-left: 4px solid var(--ml-fail); }
    .alerts h2 { display: flex; align-items: center; gap: 6px; }
    .allgood { display: flex; align-items: center; gap: 6px; color: var(--ml-ok); margin: 0 0 16px; }
    header { display: flex; align-items: center; gap: 8px; }
    header h2 { margin: 0; }
    .small { font-size: 0.85em; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; }
    .mini { font-size: 14px; width: 14px; height: 14px; }
    .counters { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 0 0 8px; }
    .counters div { background: var(--mat-sys-surface-container-high); border-radius: 8px; padding: 6px 10px; }
    dt { font: var(--mat-sys-label-small); color: var(--ml-muted); }
    dd { margin: 0; font: var(--mat-sys-title-medium); }
    dd.warn { color: var(--ml-warn); }
    dd.fail { color: var(--ml-fail); }
    .qline { display: flex; gap: 6px; align-items: center; text-decoration: none; }
  `,
})
export class Overview {
  private readonly api = inject(ApiService);
  protected readonly data = signal<OverviewData | null>(null);

  constructor() {
    polling(() => this.load(), 15_000);
  }

  private async load(): Promise<void> {
    try {
      this.data.set(await this.api.overview());
    } catch {
      /* the interceptor already reported it; keep the last data */
    }
  }

  protected status(a: OverviewAgent, d: OverviewData): AgentStatus {
    if (a.pendingEnrollment || a.lastSeen === null) return 'pending';
    return d.now - a.lastSeen > d.offlineAfterS * 1000 ? 'offline' : 'online';
  }

  protected dotClass(a: OverviewAgent, d: OverviewData): string {
    const s = this.status(a, d);
    if (s !== 'online') return s === 'offline' ? 'fail' : '';
    if (a.checks.some((c) => c.state === 'fail')) return 'fail';
    if (a.checks.some((c) => c.state === 'warn')) return 'warn';
    return 'ok';
  }

  protected statusText(a: OverviewAgent, d: OverviewData): string {
    const s = this.status(a, d);
    if (s === 'pending') return 'Awaiting enrollment';
    const ago = new AgoPipe().transform(a.lastSeen, d.now);
    return s === 'offline' ? `Offline · last seen ${ago}` : `Seen ${ago}`;
  }
}
