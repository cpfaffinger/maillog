import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { AbstractControl, FormBuilder, ReactiveFormsModule, ValidationErrors, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ApiService } from '../../api/api.service';
import { AccessToken, Passkey } from '../../api/models';
import { AuthService } from '../../core/auth.service';
import { errorMessage } from '../../core/http';
import { Notify } from '../../core/notify.service';
import { TsPipe } from '../../core/pipes';
import { createCredential, isCancelled, passkeysSupported } from '../../core/webauthn';
import { CopyBox, ConfirmDialog, SecretDialog } from '../../shared/dialogs';
import { ProgressNote } from '../../shared/progress-note';
import { TokenDialog, TokenInput } from './token-dialog';

function sameAs(a: string, b: string) {
  return (g: AbstractControl): ValidationErrors | null =>
    g.get(a)?.value === g.get(b)?.value ? null : { mismatch: true };
}

@Component({
  selector: 'app-account',
  imports: [ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatIconModule, MatTooltipModule, TsPipe, CopyBox, ProgressNote],
  template: `
    <div class="page">
      <div class="page-head"><h1>My account</h1></div>

      @if (auth.user(); as u) {
        @if (u.mustChangePassword) {
          <p class="banner" role="alert"><mat-icon aria-hidden="true">warning</mat-icon> You must change your password before continuing.</p>
        }
        <div class="cols">
          <section class="card" aria-labelledby="h-profile">
            <h2 id="h-profile">Profile</h2>
            <dl>
              <dt>Username</dt><dd>{{ u.username }}</dd>
              <dt>Name</dt><dd>{{ u.displayName || '–' }}</dd>
              <dt>Role</dt><dd><span class="pill neutral">{{ u.role }}</span></dd>
              @if (u.role === 'viewer') {
                <dt>Sender domains</dt>
                <dd>@for (d of u.domains; track d) { <span class="pill neutral dom">{{ '@' + d }}</span> }</dd>
              }
            </dl>
          </section>

          <section class="card" aria-labelledby="h-pw">
            <h2 id="h-pw">Change password</h2>
            <form class="stack" [formGroup]="pw" (ngSubmit)="changePassword()">
              <mat-form-field><mat-label>Current password</mat-label>
                <input matInput type="password" formControlName="current" autocomplete="current-password" required /></mat-form-field>
              <mat-form-field><mat-label>New password</mat-label>
                <input matInput type="password" formControlName="next" autocomplete="new-password" required />
                <mat-hint>At least 12 characters</mat-hint></mat-form-field>
              <mat-form-field><mat-label>Repeat new password</mat-label>
                <input matInput type="password" formControlName="again" autocomplete="new-password" required />
                @if (pw.hasError('mismatch') && pw.controls.again.touched) { <mat-error>Passwords differ</mat-error> }</mat-form-field>
              <button mat-flat-button type="submit" [disabled]="pw.invalid || busy()">Change password</button>
            </form>
          </section>
        </div>

        <section class="card block" aria-labelledby="h-pk">
          <div class="head"><h2 id="h-pk">Passkeys</h2><span class="spacer"></span></div>
          @if (supported) {
            <form class="inline" [formGroup]="pk" (ngSubmit)="addPasskey()">
              <mat-form-field subscriptSizing="dynamic"><mat-label>Name for this passkey</mat-label>
                <input matInput formControlName="name" placeholder="Laptop, phone…" autocomplete="off" /></mat-form-field>
              <button mat-flat-button type="submit" [disabled]="pk.invalid || busy()"><mat-icon>fingerprint</mat-icon> Add passkey</button>
            </form>
            @if (pkStep(); as step) { <app-progress-note [text]="step" /> }
          } @else {
            <p class="muted">This browser or connection does not support passkeys (HTTPS is required).</p>
          }
          <table class="ml-table" aria-label="Passkeys">
            <thead><tr><th>Name</th><th>Created</th><th>Last used</th><th><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>
              @for (p of passkeys(); track p.id) {
                <tr><td>{{ p.name }}</td><td>{{ p.createdAt | ts }}</td><td>{{ p.lastUsed | ts }}</td>
                  <td class="actions"><button mat-icon-button (click)="removePasskey(p)" aria-label="Remove passkey" matTooltip="Remove"><mat-icon>delete</mat-icon></button></td></tr>
              }
            </tbody>
          </table>
          @if (passkeys().length === 0) { <div class="empty">No passkeys registered.</div> }
        </section>

        <section class="card block" aria-labelledby="h-tok">
          <div class="head"><h2 id="h-tok">Personal access tokens</h2><span class="spacer"></span>
            <button mat-flat-button (click)="newToken()"><mat-icon>add</mat-icon> New token</button></div>
          <p class="muted">Tokens let scripts call the API with your role and access. Treat them like passwords.</p>
          <app-copy-box [text]="curlHint()" label="curl example" />
          <table class="ml-table" aria-label="Access tokens">
            <thead><tr><th>Name</th><th>Token</th><th>Access</th><th>Created</th><th>Expires</th><th>Last used</th><th><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>
              @for (t of tokens(); track t.id) {
                <tr><td>{{ t.name }}</td><td class="mono">{{ t.prefix }}…</td>
                  <td><span class="pill neutral">{{ t.readOnly ? 'read-only' : 'read/write' }}</span></td>
                  <td>{{ t.createdAt | ts }}</td><td>{{ t.expiresAt ? (t.expiresAt | ts) : 'never' }}</td><td>{{ t.lastUsed | ts }}</td>
                  <td class="actions"><button mat-icon-button (click)="revoke(t)" aria-label="Revoke token" matTooltip="Revoke"><mat-icon>delete</mat-icon></button></td></tr>
              }
            </tbody>
          </table>
          @if (tokens().length === 0) { <div class="empty">No access tokens.</div> }
        </section>
      }
    </div>
  `,
  styles: `
    .cols { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); margin-bottom: 16px; }
    .block { margin-bottom: 16px; overflow-x: auto; }
    .head { display: flex; align-items: center; gap: 8px; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
    dt { color: var(--ml-muted); } dd { margin: 0; }
    .dom { margin-right: 4px; }
    .banner { display: flex; gap: 8px; align-items: center; padding: 12px; border-radius: 12px; color: var(--ml-warn);
              background: var(--mat-sys-surface-container); border: 1px solid var(--ml-warn); }
    .inline { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
    .actions { text-align: right; white-space: nowrap; }
    app-copy-box { display: block; margin-bottom: 12px; }
  `,
})
export class Account {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);

  protected readonly supported = passkeysSupported();
  protected readonly busy = signal(false);
  /** What the passkey registration is waiting for right now (null when idle). */
  protected readonly pkStep = signal<string | null>(null);
  protected readonly passkeys = signal<Passkey[]>([]);
  protected readonly tokens = signal<AccessToken[]>([]);
  protected readonly curlHint = computed(
    () => `curl -H "Authorization: Bearer mlp_YOUR_TOKEN" "${location.origin}/api/v1/events?limit=10"`,
  );

  protected readonly pw = inject(FormBuilder).nonNullable.group(
    {
      current: ['', Validators.required],
      next: ['', [Validators.required, Validators.minLength(12)]],
      again: ['', Validators.required],
    },
    { validators: sameAs('next', 'again') },
  );
  protected readonly pk = inject(FormBuilder).nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(80)]],
  });

  constructor() {
    void this.load();
  }

  protected async changePassword(): Promise<void> {
    if (this.pw.invalid) return;
    this.busy.set(true);
    try {
      const v = this.pw.getRawValue();
      await this.api.changePassword(v.current, v.next);
      this.pw.reset();
      await this.auth.refresh();
      this.notify.info('Password changed');
    } catch {
      /* reported by the interceptor */
    } finally {
      this.busy.set(false);
    }
  }

  protected async addPasskey(): Promise<void> {
    if (this.pk.invalid) return;
    this.busy.set(true);
    this.pkStep.set('Preparing the passkey…');
    try {
      const req = await this.api.passkeyCreateOptions();
      this.pkStep.set('Waiting for your device: confirm in the browser prompt with fingerprint, face, PIN or security key.');
      const credential = await createCredential(req.options);
      this.pkStep.set('Saving the passkey…');
      await this.api.passkeyAdd(req.requestId, this.pk.getRawValue().name.trim(), credential);
      this.pk.reset();
      this.notify.info('Passkey added');
      await this.load();
      await this.auth.refresh();
    } catch (e) {
      // HTTP errors were already reported by the interceptor; browser/WebAuthn errors are reported here.
      if (!isCancelled(e) && !(e instanceof HttpErrorResponse)) this.notify.error(errorMessage(e));
    } finally {
      this.pkStep.set(null);
      this.busy.set(false);
    }
  }

  protected removePasskey(p: Passkey): void {
    this.confirm(`Remove passkey "${p.name}"?`, 'You will no longer be able to sign in with it.', 'Remove', async () => {
      await this.api.passkeyDelete(p.id);
      await this.load();
      await this.auth.refresh();
    });
  }

  protected newToken(): void {
    this.dialog.open<TokenDialog, void, TokenInput>(TokenDialog, { width: '480px', maxWidth: '96vw' })
      .afterClosed().subscribe(async (input) => {
        if (!input) return;
        try {
          const r = await this.api.tokenCreate(input.name, input.readOnly, input.expiresInDays);
          this.dialog.open(SecretDialog, {
            width: '640px', maxWidth: '96vw', disableClose: true,
            data: {
              title: 'Your new access token',
              intro: `Token "${r.item.name}" was created. Use it as: Authorization: Bearer <token>`,
              secret: r.token, secretLabel: 'access token',
              warning: 'This is the only time the token is shown. Copy it now; it cannot be displayed again.',
            },
          });
          await this.load();
        } catch {
          /* reported by the interceptor */
        }
      });
  }

  protected revoke(t: AccessToken): void {
    this.confirm(`Revoke token "${t.name}"?`, 'Anything using this token stops working immediately.', 'Revoke', async () => {
      await this.api.tokenDelete(t.id);
      await this.load();
    });
  }

  private confirm(title: string, message: string, confirm: string, action: () => Promise<void>): void {
    this.dialog.open(ConfirmDialog, { data: { title, message, confirm, danger: true } })
      .afterClosed().subscribe(async (yes) => {
        if (!yes) return;
        try {
          await action();
        } catch {
          /* reported by the interceptor */
        }
      });
  }

  private async load(): Promise<void> {
    try {
      const [passkeys, tokens] = await Promise.all([this.api.passkeys(), this.api.tokens()]);
      this.passkeys.set(passkeys);
      this.tokens.set(tokens);
    } catch {
      /* reported by the interceptor */
    }
  }
}
