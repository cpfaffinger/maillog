import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { Router } from '@angular/router';
import { ApiService } from '../../api/api.service';
import { MailEvent } from '../../api/models';
import { TsPipe } from '../../core/pipes';
import { EventDialog } from '../messages/event-dialog';

export interface Hop {
  key: string;
  label: string;
  queueId: string | null;
  first: number;
  last: number;
  events: MailEvent[];
  handedTo: string[];
}

const NOISE = new Set(['connect', 'disconnect', 'meta']);

/** Groups trace events into hops (one per agent + queue id), ordered by first event time. */
export function groupHops(events: MailEvent[]): Hop[] {
  const map = new Map<string, Hop>();
  for (const e of [...events].sort((a, b) => a.ts - b.ts || a.id - b.id)) {
    const who = e.agentName ?? e.agentRole ?? 'hop';
    const key = `${e.agentId ?? e.agentRole ?? ''}|${e.queueId ?? ''}`;
    let hop = map.get(key);
    if (!hop) {
      hop = { key, label: who, queueId: e.queueId, first: e.ts, last: e.ts, events: [], handedTo: [] };
      map.set(key, hop);
    }
    hop.events.push(e);
    hop.last = Math.max(hop.last, e.ts);
    if (e.nextQueueId && !hop.handedTo.includes(e.nextQueueId)) hop.handedTo.push(e.nextQueueId);
  }
  return [...map.values()].sort((a, b) => a.first - b.first);
}

@Component({
  selector: 'app-trace',
  imports: [ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatIconModule, MatProgressBarModule, TsPipe],
  template: `
    <div class="page">
      <div class="page-head"><h1>Trace a message</h1></div>
      <form class="card search" (ngSubmit)="go()" role="search">
        <mat-form-field class="grow">
          <mat-label>Queue ID or address</mat-label>
          <input matInput [formControl]="query" placeholder="9C2197F869 or person&#64;example.com" />
        </mat-form-field>
        <button mat-flat-button type="submit" [disabled]="loading()">Trace</button>
      </form>

      @if (loading()) { <mat-progress-bar mode="indeterminate" /> }

      @if (searched() && hops().length === 0 && !loading()) {
        <div class="empty">Nothing found for this search.</div>
      }

      @if (summary(); as s) {
        <section class="card sum" aria-label="Summary">
          <div><span class="muted">From</span> <b class="wrap-any">{{ s.sender || '–' }}</b></div>
          @for (r of s.recipients; track r.to) {
            <div class="wrap-any"><span class="muted">To</span> <b>{{ r.to }}</b>
              <span class="pill {{ r.status }}">{{ r.status }}</span></div>
          }
        </section>
      }

      <ol class="timeline">
        @for (h of hops(); track h.key; let i = $index) {
          <li>
            <span class="node" aria-hidden="true">{{ i + 1 }}</span>
            <article class="card">
              <header>
                <h2>{{ h.label }}</h2>
                @if (h.queueId) { <span class="mono pill neutral">{{ h.queueId }}</span> }
                <span class="spacer"></span>
                <span class="muted small">{{ h.first | ts }}</span>
              </header>
              <ul class="events">
                @for (e of h.events; track e.id) {
                  <li [class.noise]="isNoise(e)" (click)="open(e)" (keydown.enter)="open(e)" tabindex="0" role="button">
                    <span class="t muted">{{ e.ts | ts }}</span>
                    <span class="pill neutral">{{ e.kind }}</span>
                    <span class="wrap-any">
                      @if (e.kind === 'delivery') { → {{ e.recipient }} via {{ e.relay }} }
                      @else if (e.kind === 'queued') { from {{ e.sender }} }
                      @else if (e.kind === 'accepted') { from {{ e.clientHost || e.clientIp || 'client' }}@if (e.saslUser) { as {{ e.saslUser }} } }
                      @if (e.status) { <span class="pill {{ e.status }}">{{ e.status }}</span> }
                      <span class="muted">{{ e.detail }}</span>
                    </span>
                  </li>
                }
              </ul>
              @for (n of h.handedTo; track n) {
                <p class="handoff"><mat-icon aria-hidden="true">subdirectory_arrow_right</mat-icon> handed over as queue
                  <span class="mono">{{ n }}</span></p>
              }
            </article>
          </li>
        }
      </ol>
    </div>
  `,
  styles: `
    .search { display: flex; gap: 12px; align-items: baseline; margin-bottom: 12px; }
    .grow { flex: 1; }
    .sum { margin-bottom: 16px; display: grid; gap: 4px; }
    .timeline { list-style: none; margin: 0; padding: 0 0 0 20px; border-left: 2px solid var(--mat-sys-outline-variant); display: grid; gap: 16px; }
    .timeline > li { position: relative; }
    .node { position: absolute; left: -35px; top: 12px; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center;
            background: var(--mat-sys-primary); color: var(--mat-sys-on-primary); font: var(--mat-sys-label-large); }
    header { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
    header h2 { margin: 0; }
    .small { font-size: 0.85em; }
    .events { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
    .events li { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; cursor: pointer; padding: 3px 4px; border-radius: 6px; }
    .events li:hover, .events li:focus-visible { background: var(--mat-sys-surface-container-high); outline: none; }
    .events li.noise { opacity: 0.6; }
    .t { white-space: nowrap; font-size: 0.85em; }
    .handoff { display: flex; align-items: center; gap: 4px; margin: 8px 0 0; color: var(--ml-info); }
    @media (max-width: 600px) { .search { flex-direction: column; align-items: stretch; } }
  `,
})
export class Trace {
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MatDialog);
  private readonly router = inject(Router);

  /** Bound from the `q` query parameter (withComponentInputBinding). */
  readonly q = input<string>();

  protected readonly query = new FormControl('', { nonNullable: true });
  protected readonly events = signal<MailEvent[]>([]);
  protected readonly loading = signal(false);
  protected readonly searched = signal(false);
  protected readonly hops = computed(() => groupHops(this.events()));

  protected readonly summary = computed(() => {
    const ev = this.events();
    if (ev.length === 0) return null;
    const sender = ev.find((e) => e.kind === 'queued' && e.sender)?.sender ?? ev.find((e) => e.sender)?.sender ?? null;
    const last = new Map<string, string>();
    for (const e of [...ev].sort((a, b) => a.ts - b.ts)) {
      if (e.kind === 'delivery' && e.recipient && e.status) last.set(e.recipient, e.status);
    }
    return { sender, recipients: [...last].map(([to, status]) => ({ to, status })) };
  });

  constructor() {
    effect(() => {
      const q = this.q();
      if (q) {
        this.query.setValue(q);
        void this.load(q);
      }
    });
  }

  protected go(): void {
    const q = this.query.value.trim();
    if (!q) return;
    void this.router.navigate([], { queryParams: { q }, queryParamsHandling: 'merge' });
    void this.load(q);
  }

  protected isNoise(e: MailEvent): boolean {
    return NOISE.has(e.kind);
  }

  protected open(e: MailEvent): void {
    this.dialog.open(EventDialog, { data: e, width: '720px', maxWidth: '96vw' });
  }

  private async load(q: string): Promise<void> {
    this.loading.set(true);
    try {
      this.events.set((await this.api.trace(q)).events);
      this.searched.set(true);
    } catch {
      /* reported by the interceptor */
    } finally {
      this.loading.set(false);
    }
  }
}
