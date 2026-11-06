import { NgTemplateOutlet } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTabsModule } from '@angular/material/tabs';
import { ApiService } from '../../api/api.service';
import { ActionItem, Alert, HealthHistoryItem } from '../../api/models';
import { TsPipe } from '../../core/pipes';
import { polling } from '../../core/util';

@Component({
  selector: 'app-alerts',
  imports: [MatTabsModule, MatIconModule, NgTemplateOutlet, TsPipe],
  template: `
    <div class="page">
      <div class="page-head"><h1>Alerts &amp; health</h1></div>
      <mat-tab-group animationDuration="0ms" mat-stretch-tabs="false">
        <mat-tab label="Open ({{ open().length }})">
          <ng-template matTabContent>
            <ng-container [ngTemplateOutlet]="alertTable" [ngTemplateOutletContext]="{ list: open(), history: false }" />
          </ng-template>
        </mat-tab>
        <mat-tab label="History">
          <ng-template matTabContent>
            <ng-container [ngTemplateOutlet]="alertTable" [ngTemplateOutletContext]="{ list: all(), history: true }" />
          </ng-template>
        </mat-tab>
        <mat-tab label="Health changes">
          <ng-template matTabContent>
            <div class="table-wrap">
              <table class="ml-table" aria-label="Health state changes">
                <thead><tr><th>Time</th><th>Agent</th><th>Check</th><th>State</th><th>Message</th></tr></thead>
                <tbody>
                  @for (h of health(); track h.ts + h.agentId + h.name) {
                    <tr><td class="nowrap">{{ h.ts | ts }}</td><td>{{ h.agentName || h.agentId }}</td><td>{{ h.name }}</td>
                      <td><span class="pill {{ h.state }}">{{ h.state }}</span></td><td class="wrap-any">{{ h.message }}</td></tr>
                  }
                </tbody>
              </table>
              @if (health().length === 0) { <div class="empty">No health changes recorded.</div> }
            </div>
          </ng-template>
        </mat-tab>
        <mat-tab label="Auto-recovery">
          <ng-template matTabContent>
            <div class="table-wrap">
              <table class="ml-table" aria-label="Automatic recovery actions">
                <thead><tr><th>Time</th><th>Agent</th><th>Check</th><th>Action</th><th>Result</th></tr></thead>
                <tbody>
                  @for (a of actions(); track a.id) {
                    <tr><td class="nowrap">{{ a.ts | ts }}</td><td>{{ a.agentName || a.agentId }}</td><td>{{ a.name }}</td>
                      <td class="mono wrap-any">{{ a.action }}</td>
                      <td><span class="pill {{ a.ok ? 'ok' : 'fail' }}">{{ a.ok ? 'recovered' : 'failed' }}</span>
                        <span class="wrap-any"> {{ a.result }}</span></td></tr>
                  }
                </tbody>
              </table>
              @if (actions().length === 0) { <div class="empty">No automatic recovery has been necessary.</div> }
            </div>
          </ng-template>
        </mat-tab>
      </mat-tab-group>
    </div>

    <ng-template #alertTable let-list="list" let-history="history">
      <div class="table-wrap">
        <table class="ml-table" [attr.aria-label]="history ? 'Alert history' : 'Open alerts'">
          <thead><tr><th>Severity</th><th>Alert</th><th>Opened</th><th>Resolved</th></tr></thead>
          <tbody>
            @for (a of list; track a.id) {
              <tr>
                <td><span class="pill {{ a.severity }}">{{ a.severity }}</span></td>
                <td class="wrap-any"><b>{{ a.title }}</b>@if (a.body) { <div class="muted">{{ a.body }}</div> }</td>
                <td class="nowrap">{{ a.openedAt | ts }}</td>
                <td class="nowrap">@if (a.resolvedAt) { {{ a.resolvedAt | ts }} } @else { <span class="pill fail">open</span> }</td>
              </tr>
            }
          </tbody>
        </table>
        @if (list.length === 0) { <div class="empty">{{ history ? 'No alerts yet.' : 'No open alerts.' }}</div> }
      </div>
    </ng-template>
  `,
  styles: `
    .nowrap { white-space: nowrap; }
    .table-wrap { margin-top: 12px; }
  `,
})
export class Alerts {
  private readonly api = inject(ApiService);
  protected readonly open = signal<Alert[]>([]);
  protected readonly all = signal<Alert[]>([]);
  protected readonly health = signal<HealthHistoryItem[]>([]);
  protected readonly actions = signal<ActionItem[]>([]);

  constructor() {
    polling(() => this.load(), 30_000);
  }

  private async load(): Promise<void> {
    try {
      const [open, all, health, actions] = await Promise.all([
        this.api.alerts('open'), this.api.alerts('all'), this.api.healthHistory(), this.api.actions(),
      ]);
      this.open.set(open);
      this.all.set(all);
      this.health.set(health);
      this.actions.set(actions);
    } catch {
      /* reported by the interceptor */
    }
  }
}
