import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { ActivatedRoute } from '@angular/router';
import { ApiService } from '../../api/api.service';
import { Agent, EventQuery, MailEvent } from '../../api/models';
import { AuthService } from '../../core/auth.service';
import { TsPipe } from '../../core/pipes';
import { ALL_KINDS, VIEWER_KINDS } from '../../core/util';
import { EventDialog } from './event-dialog';

const RANGES: Record<string, number | null> = {
  '1h': 3600_000, '6h': 6 * 3600_000, '24h': 24 * 3600_000, '7d': 7 * 86400_000, '30d': 30 * 86400_000, all: null,
};

@Component({
  selector: 'app-messages',
  imports: [
    ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatCheckboxModule,
    MatButtonModule, MatIconModule, MatProgressBarModule, TsPipe,
  ],
  template: `
    <div class="page">
      <div class="page-head"><h1>Messages</h1>
        @if (!staff()) {
          <span class="muted">Mail sent from {{ domains() }}</span>
        }
      </div>

      <form class="filters card" [formGroup]="form" (ngSubmit)="search()" role="search">
        <mat-form-field class="grow">
          <mat-label>Search</mat-label>
          <input matInput formControlName="q"
                 [placeholder]="staff() ? 'Queue ID, address, IP, SASL user' : 'Queue ID or address'" />
          <mat-icon matSuffix aria-hidden="true">search</mat-icon>
        </mat-form-field>
        @if (staff()) {
          <mat-form-field>
            <mat-label>Agent</mat-label>
            <mat-select formControlName="agent">
              <mat-option value="">All agents</mat-option>
              @for (a of agents(); track a.id) { <mat-option [value]="a.id">{{ a.name }}</mat-option> }
            </mat-select>
          </mat-form-field>
        }
        <mat-form-field>
          <mat-label>Kinds</mat-label>
          <mat-select formControlName="kinds" multiple>
            @for (k of kinds(); track k) { <mat-option [value]="k">{{ k }}</mat-option> }
          </mat-select>
        </mat-form-field>
        <mat-form-field>
          <mat-label>Time range</mat-label>
          <mat-select formControlName="range">
            <mat-option value="1h">Last hour</mat-option>
            <mat-option value="6h">Last 6 hours</mat-option>
            <mat-option value="24h">Last 24 hours</mat-option>
            <mat-option value="7d">Last 7 days</mat-option>
            <mat-option value="30d">Last 30 days</mat-option>
            <mat-option value="all">All time</mat-option>
          </mat-select>
        </mat-form-field>
        @if (staff()) {
          <mat-checkbox formControlName="all">Include connect / disconnect / meta</mat-checkbox>
        }
        <button mat-flat-button type="submit" [disabled]="loading()">Search</button>
      </form>

      @if (loading()) { <mat-progress-bar mode="indeterminate" /> }

      <div class="table-wrap" tabindex="-1">
        <table class="ml-table" aria-label="Mail events">
          <thead><tr>
            <th>Time</th>@if (staff()) { <th>Agent</th> }<th>Kind</th><th>Queue ID</th><th>Sender → Recipient</th>
            <th>Status</th><th>Detail</th>
          </tr></thead>
          <tbody>
            @for (e of items(); track e.id) {
              <tr class="clickable" tabindex="0" (click)="open(e)" (keydown.enter)="open(e)" (keydown.space)="open(e); $event.preventDefault()">
                <td class="nowrap">{{ e.ts | ts }}</td>
                @if (staff()) { <td>{{ e.agentName || '–' }}</td> }
                <td><span class="pill neutral">{{ e.kind }}</span></td>
                <td class="mono">{{ e.queueId || '' }}</td>
                <td class="wrap-any">
                  @if (e.sender || e.recipient) {
                    {{ e.sender || '' }}@if (e.sender && e.recipient) { → }{{ e.recipient || '' }}
                  } @else if (e.clientIp) { {{ e.clientHost || '' }} {{ e.clientIp }} }
                </td>
                <td>@if (e.status) { <span class="pill {{ e.status }}">{{ e.status }}</span> }</td>
                <td class="wrap-any detail">{{ e.detail || '' }}</td>
              </tr>
            }
          </tbody>
        </table>
        @if (loaded() && items().length === 0) { <div class="empty">No events match.</div> }
      </div>
      @if (next() !== null) {
        <div class="more"><button mat-stroked-button (click)="search(true)" [disabled]="loading()">Load more</button></div>
      }
    </div>
  `,
  styles: `
    .filters { display: flex; gap: 12px; flex-wrap: wrap; align-items: baseline; margin-bottom: 12px; }
    .grow { flex: 1 1 240px; }
    .nowrap { white-space: nowrap; }
    .detail { max-width: 420px; }
    .more { display: grid; place-items: center; padding: 16px; }
  `,
})
export class Messages {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly dialog = inject(MatDialog);
  private readonly route = inject(ActivatedRoute);

  protected readonly staff = this.auth.isOperator;
  protected readonly kinds = computed(() => (this.staff() ? ALL_KINDS : VIEWER_KINDS));
  protected readonly domains = computed(() => (this.auth.user()?.domains ?? []).map((d) => '@' + d).join(', '));
  protected readonly agents = signal<Agent[]>([]);
  protected readonly items = signal<MailEvent[]>([]);
  protected readonly next = signal<number | null>(null);
  protected readonly loading = signal(false);
  protected readonly loaded = signal(false);

  protected readonly form = inject(FormBuilder).nonNullable.group({
    q: this.route.snapshot.queryParamMap.get('q') ?? '',
    agent: '',
    kinds: [[] as string[]],
    range: '24h',
    all: false,
  });

  constructor() {
    if (this.staff()) void this.api.agents().then((a) => this.agents.set(a)).catch(() => undefined);
    void this.search();
  }

  protected async search(more = false): Promise<void> {
    const v = this.form.getRawValue();
    const span = RANGES[v.range];
    const query: EventQuery = {
      q: v.q.trim() || undefined,
      agent: v.agent || undefined,
      kind: v.kinds.length > 0 ? v.kinds.join(',') : undefined,
      from: span ? Date.now() - span : undefined,
      all: v.all || undefined,
      limit: 200,
      before: more ? (this.next() ?? undefined) : undefined,
    };
    this.loading.set(true);
    try {
      const page = await this.api.events(query);
      this.items.update((cur) => (more ? [...cur, ...page.items] : page.items));
      this.next.set(page.nextBefore);
      this.loaded.set(true);
    } catch {
      /* reported by the interceptor */
    } finally {
      this.loading.set(false);
    }
  }

  protected open(e: MailEvent): void {
    this.dialog.open(EventDialog, { data: e, width: '720px', maxWidth: '96vw' });
  }
}
