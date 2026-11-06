import { Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ApiService } from '../../api/api.service';
import { ApiKey, ApiKeyInput } from '../../api/models';
import { Notify } from '../../core/notify.service';
import { TsPipe } from '../../core/pipes';
import { ConfirmDialog, CopyBox, SecretDialog } from '../../shared/dialogs';
import { ApiKeyDialog } from './apikey-dialog';

/** Service keys for applications that ask "what happened to this message?" (limited to sender domains). */
@Component({
  selector: 'app-apikeys',
  imports: [MatButtonModule, MatIconModule, MatTooltipModule, TsPipe, CopyBox],
  template: `
    <div class="page">
      <div class="page-head"><h1>API keys</h1><span class="spacer"></span>
        <button mat-flat-button (click)="edit(null)"><mat-icon>vpn_key</mat-icon> New API key</button>
      </div>

      <section class="card intro" aria-labelledby="h-how">
        <h2 id="h-how">Look up the status of a message</h2>
        <p class="muted">
          An application that sends mail through your servers can ask maillog what became of a message: it passes the
          <span class="mono">Message-ID</span> header and gets back queued, delivered, deferred or bounced, per recipient.
          A key only sees messages whose sender is in one of its domains, and it cannot open anything else in maillog.
        </p>
        <app-copy-box [text]="example()" label="curl example" />
        <p class="muted">Full reference: <a href="/api/docs" target="_blank" rel="noopener">API docs</a> (section “Message status”).</p>
      </section>

      <div class="table-wrap">
        <table class="ml-table" aria-label="API keys">
          <thead><tr><th>Name</th><th>Key</th><th>Sender domains</th><th>Expires</th><th>Last used</th><th><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
            @for (k of keys(); track k.id) {
              <tr>
                <td class="name"><b>{{ k.name }}</b><div class="muted small">created {{ k.createdAt | ts }} by {{ k.createdBy || '–' }}</div></td>
                <td class="mono">{{ k.prefix }}…</td>
                <td class="wrap-any">@for (d of k.domains; track d) { <span class="pill neutral dom">{{ '@' + d }}</span> }</td>
                <td class="nowrap">{{ k.expiresAt ? (k.expiresAt | ts) : 'never' }}
                  @if (expired(k)) { <span class="pill fail">expired</span> }</td>
                <td class="nowrap">{{ k.lastUsed | ts }}
                  <div class="muted small">{{ k.useCount }} request{{ k.useCount === 1 ? '' : 's' }}@if (k.lastIp) { · <span class="mono">{{ k.lastIp }}</span> }</div></td>
                <td class="actions">
                  <button mat-icon-button (click)="edit(k)" matTooltip="Rename or change domains" aria-label="Edit API key"><mat-icon>edit</mat-icon></button>
                  <button mat-icon-button (click)="revoke(k)" matTooltip="Revoke" aria-label="Revoke API key"><mat-icon>delete</mat-icon></button>
                </td>
              </tr>
            }
          </tbody>
        </table>
        @if (loaded() && keys().length === 0) { <div class="empty">No API keys yet. Create one for each application that needs message status.</div> }
      </div>
    </div>
  `,
  styles: `
    .intro { margin-bottom: 16px; }
    .intro app-copy-box { display: block; margin: 12px 0; }
    .nowrap { white-space: nowrap; }
    .actions { white-space: nowrap; text-align: right; }
    .name { min-width: 15rem; }
    .small { font-size: 0.85em; }
    .dom { margin: 0 4px 4px 0; }
  `,
})
export class ApiKeys {
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  protected readonly keys = signal<ApiKey[]>([]);
  protected readonly loaded = signal(false);
  protected readonly example = computed(
    () => `curl -H "Authorization: Bearer mlk_YOUR_KEY" "${location.origin}/api/v1/messages/status?messageId=%3Cabc123%40example.org%3E"`,
  );

  constructor() {
    void this.load();
  }

  protected expired(k: ApiKey): boolean {
    return k.expiresAt !== null && k.expiresAt < Date.now();
  }

  protected edit(k: ApiKey | null): void {
    this.dialog.open<ApiKeyDialog, ApiKey | null, ApiKeyInput>(ApiKeyDialog, { data: k, width: '560px', maxWidth: '96vw' })
      .afterClosed().subscribe(async (input) => {
        if (!input) return;
        try {
          if (k) {
            await this.api.apiKeyUpdate(k.id, { name: input.name, domains: input.domains });
            this.notify.info('API key updated');
          } else {
            const r = await this.api.apiKeyCreate(input);
            this.dialog.open(SecretDialog, {
              width: '680px', maxWidth: '96vw', disableClose: true,
              data: {
                title: 'Your new API key',
                intro: `Key "${r.item.name}" can look up messages sent from ${r.item.domains.map((d) => '@' + d).join(', ')}. ` +
                  'Send it as Authorization: Bearer <key> (or the X-Api-Key header).',
                secret: r.key, secretLabel: 'API key',
                warning: 'This is the only time the key is shown. Copy it now and store it in the application’s configuration; it cannot be displayed again.',
              },
            });
          }
          await this.load();
        } catch {
          /* reported by the interceptor */
        }
      });
  }

  protected revoke(k: ApiKey): void {
    this.dialog.open(ConfirmDialog, {
      data: { title: `Revoke "${k.name}"?`, message: 'The application using this key can no longer look up message status. This cannot be undone.', confirm: 'Revoke', danger: true },
    }).afterClosed().subscribe(async (yes) => {
      if (!yes) return;
      try {
        await this.api.apiKeyDelete(k.id);
        await this.load();
      } catch {
        /* reported by the interceptor */
      }
    });
  }

  private async load(): Promise<void> {
    try {
      this.keys.set(await this.api.apiKeys());
      this.loaded.set(true);
    } catch {
      /* reported by the interceptor */
    }
  }
}
