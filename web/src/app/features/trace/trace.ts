import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router } from '@angular/router';
import { ApiService } from '../../api/api.service';
import { MailEvent } from '../../api/models';
import { Notify } from '../../core/notify.service';
import { TsPipe } from '../../core/pipes';
import { copyText } from '../../core/util';
import { fmtSeconds } from '../../shared/chart-utils';
import { EventDialog } from '../messages/event-dialog';
import {
  addRecent, buildHopViews, buildJourney, describeFinal, groupMessages, MessageStatus, relayHost, TraceMessage,
} from './trace-data';

export { groupHops } from './trace-data';

const LIMIT = 50;
const RECENT_KEY = 'maillog.trace.recent';

function loadRecent(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 5) : [];
  } catch {
    return [];
  }
}

function saveRecent(list: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: recent searches are a convenience only */
  }
}

@Component({
  selector: 'app-trace',
  imports: [ReactiveFormsModule, MatButtonModule, MatIconModule, MatSlideToggleModule, MatTooltipModule, TsPipe],
  template: `
    <div class="page">
      <div class="page-head"><h1>Trace a message</h1></div>

      <form class="card search" (submit)="$event.preventDefault(); go()" role="search">
        <div class="field">
          <mat-icon aria-hidden="true">search</mat-icon>
          <input class="big" type="search" [formControl]="query" placeholder="Queue ID, e-mail address or Message-ID" autocomplete="off"
                 aria-label="Queue ID, e-mail address or Message-ID" aria-describedby="trace-help" enterkeyhint="search" />
          <button mat-flat-button type="submit" [disabled]="loading() || !query.value.trim()">Trace</button>
        </div>
        <p id="trace-help" class="muted help">
          Paste a queue ID, or enter a sender/recipient address – we find the message and follow it through every server.
        </p>
        @if (recent().length > 0) {
          <div class="recent" aria-label="Recent searches">
            <span class="muted">Recent</span>
            @for (r of recent(); track r) { <button type="button" class="chart-chip" (click)="useRecent(r)">{{ r }}</button> }
            <button type="button" class="linkish" (click)="clearRecent()">Clear</button>
          </div>
        }
      </form>

      @if (loading()) {
        <div class="layout" aria-busy="true" aria-label="Loading">
          <div class="skeleton tall list"></div>
          <div class="stack-sk"><div class="skeleton h1"></div><div class="skeleton h2"></div><div class="skeleton h3"></div></div>
        </div>
      } @else if (!searched()) {
        <section class="card hero" aria-labelledby="tips-h">
          <mat-icon class="big-icon" aria-hidden="true">travel_explore</mat-icon>
          <h2 id="tips-h">Where did my mail go?</h2>
          <p class="muted">Search to see every step a message took, from the first server to the recipient's server.</p>
          <ul class="tips">
            <li><b>Queue ID</b> – for example <span class="mono">9C2197F869</span>, shown in the Messages list.</li>
            <li><b>Address</b> – a full sender or recipient address, or part of it such as <span class="mono">&#64;example.com</span>.</li>
            <li><b>Message-ID</b> – the <span class="mono">Message-ID</span> header of the mail, for example <span class="mono">&lt;abc123&#64;example.com&gt;</span>.</li>
            <li>Tip: open an event in <b>Messages</b> and choose <i>Trace this message</i>.</li>
          </ul>
        </section>
      } @else if (messages().length === 0) {
        <section class="card hero" aria-live="polite">
          <mat-icon class="big-icon" aria-hidden="true">search_off</mat-icon>
          <h2>Nothing found for “{{ searchedFor() }}”</h2>
          <ul class="tips">
            <li>Check the spelling, or try just the domain (<span class="mono">&#64;example.com</span>).</li>
            <li>Very old messages are removed after the retention period.</li>
            <li>Queue IDs are case-sensitive and 10–12 characters long.</li>
          </ul>
        </section>
      } @else {
        <div class="layout" [class.single]="messages().length === 1">
          @if (messages().length > 1) {
            <aside class="card list" aria-label="Messages found">
              <div class="list-head">
                <b>{{ messages().length }} messages found</b>
                @if (messages().length > limit) { <span class="muted">Showing the {{ limit }} most recent – refine the search.</span> }
              </div>
              <ul>
                @for (m of shown(); track m.id) {
                  <li>
                    <button type="button" class="item" [class.sel]="m.id === selected()?.id"
                            [attr.aria-current]="m.id === selected()?.id ? 'true' : null" (click)="select(m)">
                      <span class="r1"><span class="muted">{{ m.firstTs | ts }}</span>
                        <span class="pill {{ pillClass(m.status) }}">{{ label(m.status) }}</span></span>
                      <span class="r2 wrap-any">{{ m.sender || 'unknown sender' }} → {{ recipientText(m) }}</span>
                      <span class="r3 muted">{{ m.hops.length }} {{ m.hops.length === 1 ? 'hop' : 'hops' }} · <span class="mono">{{ m.firstQueueId || '–' }}</span></span>
                    </button>
                  </li>
                }
              </ul>
            </aside>
          }

          <section id="trace-detail" class="detail" aria-live="polite">
            @if (selected(); as m) {
              <section class="card" aria-labelledby="msg-h">
                <h2 id="msg-h">Message</h2>
                <dl class="kv">
                  <dt>From</dt><dd class="addr">{{ m.sender || '–' }}</dd>
                  <dt>To</dt>
                  <dd>
                    <ul class="rcpts">
                      @for (r of m.recipients; track r.to) {
                        <li><span class="addr wrap-any">{{ r.to }}</span>
                          <span class="pill {{ pillClass(r.status) }}">{{ label(r.status) }}</span>
                          @if (host(r.relay); as h) { <span class="muted">via {{ h }}</span> }</li>
                      } @empty { <li class="muted">not recorded yet</li> }
                    </ul>
                  </dd>
                  @if (m.client; as c) {
                    <dt>Client</dt>
                    <dd class="wrap-any">
                      @if (c.saslUser) { <span class="addr">{{ c.saslUser }}</span> }
                      @if (c.clientHost || c.clientIp) { <span class="muted"> {{ c.saslUser ? '· ' : '' }}{{ c.clientHost }} {{ c.clientHost && c.clientIp ? '(' + c.clientIp + ')' : c.clientIp }}</span> }
                    </dd>
                  }
                  <dt>Submitted</dt><dd>{{ m.firstTs | ts }}</dd>
                  <dt>Total time</dt><dd>{{ m.totalTimeS !== null ? secs(m.totalTimeS) : '–' }}</dd>
                  <dt>Status</dt>
                  <dd><span class="pill {{ pillClass(m.status) }}">{{ label(m.status) }}</span> <span class="sentence">{{ finalText() }}</span></dd>
                </dl>
              </section>

              <section class="card" aria-labelledby="j-h">
                <h2 id="j-h">Journey</h2>
                <ol class="journey">
                  @for (n of journey(); track $index; let last = $last) {
                    <li class="node {{ n.state }}">
                      <mat-icon aria-hidden="true">{{ n.icon }}</mat-icon>
                      <span class="nl wrap-any">{{ n.label }}</span>
                      @if (n.sub) { <span class="ns muted wrap-any">{{ n.sub }}</span> }
                      <span class="sr-only"> – {{ n.state === 'ok' ? 'ok' : label(asStatus(n.state)) }}</span>
                    </li>
                    @if (!last) { <li class="arrow" aria-hidden="true"><mat-icon>arrow_forward</mat-icon></li> }
                  }
                </ol>
              </section>

              <div class="tl-head">
                <h2>Timeline</h2><span class="spacer"></span>
                <mat-slide-toggle [checked]="techOn()" (change)="toggleTech(m, $event.checked)">Show technical details</mat-slide-toggle>
              </div>
              <ol class="timeline">
                @for (v of views(); track v.hop.key; let i = $index) {
                  <li>
                    <article class="card hop" [attr.aria-label]="'Hop ' + (i + 1) + ': ' + v.hop.label">
                      <header>
                        <span class="num" aria-hidden="true">{{ i + 1 }}</span>
                        <h3>{{ v.hop.label }}</h3>
                        @if (v.hop.role) { <span class="pill neutral">{{ v.hop.role }}</span> }
                        @if (v.hop.queueId; as qid) {
                          <button type="button" class="idchip mono" (click)="copy(qid)" matTooltip="Copy queue ID" [attr.aria-label]="'Copy queue ID ' + qid">
                            {{ qid }}<mat-icon aria-hidden="true">content_copy</mat-icon></button>
                        }
                        <span class="spacer"></span>
                        <span class="muted small">{{ v.hop.first | ts }}@if (v.hop.last > v.hop.first) { · {{ secs((v.hop.last - v.hop.first) / 1000) }} }</span>
                      </header>
                      <div class="evwrap">
                        <table class="ml-table ev" [attr.aria-label]="'Events on ' + v.hop.label">
                          <tbody>
                            @for (r of v.rows; track r.event.id) {
                              <tr class="clickable" tabindex="0" (click)="open(r.event)" (keydown.enter)="open(r.event)" (keydown.space)="open(r.event); $event.preventDefault()">
                                <td class="tm"><span>{{ time(r.event.ts) }}</span>@if (r.delta) { <span class="delta muted">{{ r.delta }}</span> }</td>
                                <td><span class="pill neutral">{{ r.event.kind }}</span></td>
                                <td class="wrap-any">{{ r.text }}</td>
                                <td>@if (r.event.status) { <span class="pill {{ pillClass(statusOf(r.event.status)) }}">{{ r.event.status }}</span> }</td>
                              </tr>
                            } @empty {
                              <tr><td class="muted" colspan="4">Only technical lines on this server – switch on “Show technical details”.</td></tr>
                            }
                          </tbody>
                        </table>
                      </div>
                      @if (v.hiddenCount > 0) { <p class="muted small hidden-note">{{ v.hiddenCount }} technical {{ v.hiddenCount === 1 ? 'line' : 'lines' }} hidden</p> }
                    </article>
                    @if (v.connector) {
                      <div class="connector"><mat-icon aria-hidden="true">south</mat-icon><span>{{ v.connector }}</span></div>
                    }
                  </li>
                }
              </ol>
            } @else {
              <div class="card empty"><mat-icon aria-hidden="true">touch_app</mat-icon><p>Select a message from the list to see its journey.</p></div>
            }
          </section>
        </div>
      }
    </div>
  `,
  styles: `
    .search { margin-bottom: 16px; padding: 20px; }
    .field { display: flex; align-items: center; gap: 12px; background: var(--mat-sys-surface-container-highest); border-radius: 999px;
             padding: 6px 8px 6px 18px; border: 2px solid transparent; }
    .field:focus-within { border-color: var(--mat-sys-primary); }
    .big { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: inherit; font: var(--mat-sys-title-medium); padding: 10px 0; }
    .big::placeholder { color: var(--ml-muted); }
    .help { margin: 10px 4px 0; }
    .recent { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 12px 4px 0; }
    .linkish { background: none; border: 0; color: var(--mat-sys-primary); cursor: pointer; font: var(--mat-sys-label-medium); padding: 2px 6px; }
    .hero { text-align: center; padding: 40px 24px; }
    .hero .big-icon { font-size: 56px; width: 56px; height: 56px; color: var(--ml-muted); }
    .tips { text-align: left; display: inline-block; margin: 12px auto 0; padding-left: 20px; line-height: 1.7; }

    .layout { display: grid; grid-template-columns: minmax(280px, 380px) minmax(0, 1fr); gap: 16px; align-items: start; }
    .layout.single { grid-template-columns: minmax(0, 1fr); }
    .list { position: sticky; top: 72px; max-height: calc(100vh - 96px); overflow: auto; padding: 8px; }
    .list-head { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; }
    .list ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
    .item { display: grid; gap: 3px; width: 100%; text-align: left; padding: 10px 12px; border-radius: 12px; border: 1px solid transparent;
            background: transparent; color: inherit; cursor: pointer; font: inherit; }
    .item:hover { background: var(--mat-sys-surface-container-high); }
    .item:focus-visible { outline: 2px solid var(--mat-sys-primary); }
    .item.sel { background: var(--mat-sys-secondary-container); color: var(--mat-sys-on-secondary-container); }
    .r1 { display: flex; justify-content: space-between; gap: 8px; align-items: center; font-size: 0.85em; }
    .r2 { font-weight: 500; }
    .r3 { font-size: 0.8em; }
    .item.sel .muted { color: inherit; opacity: 0.8; }

    .detail { display: grid; gap: 16px; min-width: 0; }
    .kv { display: grid; grid-template-columns: 8.5rem minmax(0, 1fr); gap: 10px 20px; margin: 8px 0 0; }
    .kv dt { color: var(--ml-muted); }
    .kv dd { margin: 0; min-width: 0; }
    .addr { user-select: all; font-weight: 500; }
    .rcpts { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
    .rcpts li { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; }
    .sentence { margin-left: 6px; }

    .journey { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-wrap: wrap; align-items: stretch; gap: 8px; }
    .node { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 110px; max-width: 200px; padding: 10px 14px;
            border-radius: 14px; border: 2px solid var(--mat-sys-outline-variant); background: var(--mat-sys-surface-container-high); text-align: center; }
    .node .nl { font-weight: 600; }
    .node .ns { font-size: 0.8em; }
    .node.sent, .node.ok { border-color: var(--ml-ok); } .node.sent mat-icon, .node.ok mat-icon { color: var(--ml-ok); }
    .node.deferred { border-color: var(--ml-warn); } .node.deferred mat-icon { color: var(--ml-warn); }
    .node.bounced, .node.rejected { border-color: var(--ml-fail); } .node.bounced mat-icon, .node.rejected mat-icon { color: var(--ml-fail); }
    .node.queued mat-icon { color: var(--ml-muted); }
    .arrow { display: grid; place-items: center; color: var(--ml-muted); }

    .tl-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
    .tl-head h2 { margin: 0; }
    .timeline { list-style: none; margin: 0; padding: 0; display: grid; gap: 0; }
    .hop header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
    .hop h3 { font: var(--mat-sys-title-medium); margin: 0; }
    .num { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; background: var(--mat-sys-primary);
           color: var(--mat-sys-on-primary); font: var(--mat-sys-label-large); }
    .idchip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px 2px 10px; border-radius: 999px; cursor: pointer;
              border: 1px solid var(--mat-sys-outline-variant); background: transparent; color: inherit; }
    .idchip mat-icon { font-size: 15px; width: 15px; height: 15px; }
    .idchip:focus-visible { outline: 2px solid var(--mat-sys-primary); }
    .evwrap { overflow-x: auto; }
    table.ev td { padding: 10px 12px; }
    .tm { white-space: nowrap; }
    .delta { display: block; font-size: 0.8em; }
    .small { font-size: 0.85em; }
    .hidden-note { margin: 8px 0 0; }
    .connector { display: flex; align-items: center; gap: 8px; padding: 10px 0 10px 18px; color: var(--ml-info); font: var(--mat-sys-label-large); }
    .connector mat-icon { font-size: 20px; width: 20px; height: 20px; }

    .empty { display: grid; place-items: center; gap: 4px; padding: 40px 16px; }
    .empty mat-icon { font-size: 40px; width: 40px; height: 40px; }
    .tall { min-height: 360px; } .stack-sk { display: grid; gap: 16px; }
    .h1 { height: 170px; } .h2 { height: 110px; } .h3 { height: 220px; }
    @media (max-width: 959px) {
      .layout { grid-template-columns: minmax(0, 1fr); }
      .list { position: static; max-height: 340px; }
    }
    @media (max-width: 560px) { .kv { grid-template-columns: 6rem minmax(0, 1fr); } .field { padding-left: 12px; } }
  `,
})
export class Trace {
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MatDialog);
  private readonly router = inject(Router);
  private readonly notify = inject(Notify);

  /** The `q` query parameter is the single source of truth (withComponentInputBinding). */
  readonly q = input<string>();

  protected readonly limit = LIMIT;
  protected readonly query = new FormControl('', { nonNullable: true });
  protected readonly events = signal<MailEvent[]>([]);
  protected readonly loading = signal(false);
  protected readonly searched = signal(false);
  protected readonly searchedFor = signal('');
  protected readonly recent = signal<string[]>(loadRecent());
  private readonly selectedId = signal<string | null>(null);
  private readonly techFor = signal<ReadonlySet<string>>(new Set());
  private requestId = 0;

  protected readonly messages = computed(() => groupMessages(this.events()));
  protected readonly shown = computed(() => this.messages().slice(0, LIMIT));
  protected readonly selected = computed<TraceMessage | null>(() => {
    const list = this.messages();
    return list.find((m) => m.id === this.selectedId()) ?? (list.length === 1 ? list[0] : null);
  });
  protected readonly techOn = computed(() => {
    const m = this.selected();
    return !!m && this.techFor().has(m.id);
  });
  protected readonly views = computed(() => {
    const m = this.selected();
    return m ? buildHopViews(m, this.techOn()) : [];
  });
  protected readonly journey = computed(() => {
    const m = this.selected();
    return m ? buildJourney(m) : [];
  });
  protected readonly finalText = computed(() => {
    const m = this.selected();
    return m ? describeFinal(m) : '';
  });

  protected readonly secs = fmtSeconds;
  protected readonly host = relayHost;

  constructor() {
    effect(() => {
      const q = this.q();
      untracked(() => {
        if (q) {
          this.query.setValue(q);
          void this.load(q);
        } else {
          this.requestId++;
          this.query.setValue('');
          this.events.set([]);
          this.searched.set(false);
          this.loading.set(false);
        }
      });
    });
  }

  protected go(): void {
    const q = this.query.value.trim();
    if (!q) return;
    if (q === this.q()) void this.load(q);
    else void this.router.navigate([], { queryParams: { q }, queryParamsHandling: 'merge' });
  }

  protected useRecent(q: string): void {
    this.query.setValue(q);
    this.go();
  }

  protected clearRecent(): void {
    this.recent.set([]);
    saveRecent([]);
  }

  protected select(m: TraceMessage): void {
    this.selectedId.set(m.id);
    if (window.matchMedia('(max-width: 959px)').matches) {
      setTimeout(() => document.getElementById('trace-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  }

  protected toggleTech(m: TraceMessage, on: boolean): void {
    this.techFor.update((s) => {
      const next = new Set(s);
      if (on) next.add(m.id);
      else next.delete(m.id);
      return next;
    });
  }

  protected open(e: MailEvent): void {
    this.dialog.open(EventDialog, { data: e, width: '720px', maxWidth: '96vw' });
  }

  protected async copy(text: string): Promise<void> {
    if (await copyText(text)) this.notify.info('Queue ID copied');
    else this.notify.error('Copy failed, select the text manually');
  }

  protected time(ms: number): string {
    return new Date(ms).toLocaleTimeString();
  }

  protected pillClass(s: MessageStatus): string {
    return s === 'rejected' ? 'reject' : s === 'queued' ? 'neutral' : s;
  }

  protected statusOf(raw: string): MessageStatus {
    return raw === 'sent' ? 'sent' : raw === 'deferred' ? 'deferred' : raw === 'bounced' || raw === 'expired' ? 'bounced' : raw.startsWith('reject') ? 'rejected' : 'queued';
  }

  protected asStatus(s: string): MessageStatus {
    return this.statusOf(s);
  }

  protected label(s: MessageStatus): string {
    return { sent: 'delivered', deferred: 'deferred', bounced: 'bounced', rejected: 'rejected', queued: 'in queue' }[s];
  }

  protected recipientText(m: TraceMessage): string {
    const first = m.recipients[0]?.to ?? 'recipient unknown';
    return m.recipients.length > 1 ? `${first} +${m.recipients.length - 1}` : first;
  }

  private async load(q: string): Promise<void> {
    const id = ++this.requestId;
    this.loading.set(true);
    this.searchedFor.set(q);
    try {
      const r = await this.api.trace(q);
      if (id !== this.requestId) return;
      this.events.set(r.events);
      this.selectedId.set(null);
      this.searched.set(true);
      this.recent.update((l) => {
        const next = addRecent(l, q);
        saveRecent(next);
        return next;
      });
    } catch {
      if (id === this.requestId) this.searched.set(false);
    } finally {
      if (id === this.requestId) this.loading.set(false);
    }
  }
}
