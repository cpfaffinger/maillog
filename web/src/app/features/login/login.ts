import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService } from '../../api/api.service';
import { User } from '../../api/models';
import { AuthService } from '../../core/auth.service';
import { errorMessage } from '../../core/http';
import { ThemeService } from '../../core/theme.service';
import { VersionService } from '../../core/version.service';
import { getAssertion, isCancelled, passkeysSupported } from '../../core/webauthn';
import { ProgressNote } from '../../shared/progress-note';

@Component({
  selector: 'app-login',
  imports: [
    ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatIconModule,
    MatProgressBarModule, MatDividerModule, ProgressNote,
  ],
  template: `
    <div class="wrap">
      <div class="col">
      <form class="card box stack" [formGroup]="form" (ngSubmit)="submit()" aria-labelledby="login-title">
        <span class="logo" aria-hidden="true"><mat-icon>mark_email_read</mat-icon></span>
        <h1 id="login-title">maillog</h1>
        <p class="muted lead">Sign in to continue</p>

        <mat-form-field>
          <mat-label>Username</mat-label>
          <input matInput formControlName="username" autocomplete="username webauthn" autofocus required />
        </mat-form-field>
        <mat-form-field>
          <mat-label>Password</mat-label>
          <input matInput type="password" formControlName="password" autocomplete="current-password" required />
        </mat-form-field>

        @if (error()) {
          <p class="err" role="alert">{{ error() }}</p>
        }

        <button mat-flat-button type="submit" [disabled]="busy() || form.invalid">Sign in</button>

        <mat-divider />
        @if (passkeys) {
          <button mat-stroked-button type="button" (click)="passkey()" [disabled]="busy()">
            <mat-icon>fingerprint</mat-icon> Sign in with passkey
          </button>
        } @else {
          <p class="muted small">Passkeys are not available in this browser or on this connection (HTTPS required).</p>
        }
        @if (step(); as s) { <app-progress-note [text]="s" /> }
        @else if (busy()) { <mat-progress-bar mode="indeterminate" /> }
      </form>
      @if (version.text()) { <p class="ver muted">{{ version.text() }}</p> }
      </div>
    </div>
  `,
  styles: `
    .wrap { min-height: 100vh; display: grid; place-items: center; padding: 16px;
            background:
              radial-gradient(900px 500px at 15% -10%, color-mix(in srgb, var(--mat-sys-primary) 16%, transparent), transparent 60%),
              radial-gradient(800px 500px at 100% 110%, color-mix(in srgb, var(--mat-sys-tertiary) 14%, transparent), transparent 60%),
              var(--mat-sys-surface); }
    .col { width: min(100%, 400px); }
    .box { width: 100%; padding: 32px 28px 28px; box-shadow: var(--ml-shadow-lift); gap: 10px; }
    .ver { text-align: center; font-size: 0.8em; margin: 14px 0 0; }
    .logo { display: grid; place-items: center; width: 52px; height: 52px; border-radius: 16px; color: #fff; margin: 0 auto 4px;
            background: linear-gradient(135deg, #2f7cf6, #7c4dff);
            box-shadow: 0 8px 20px rgb(79 100 246 / 0.4); }
    .logo mat-icon { font-size: 28px; width: 28px; height: 28px; }
    h1 { text-align: center; font-size: 1.6rem; }
    .lead { text-align: center; margin: 0 0 12px; }
    .err { color: var(--ml-fail); margin: 0 0 8px; }
    .small { font-size: 0.85em; margin: 0; }
    button { margin-top: 4px; }
  `,
})
export class Login {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly form = inject(FormBuilder).nonNullable.group({
    username: ['', Validators.required],
    password: ['', Validators.required],
  });
  protected readonly busy = signal(false);
  /** What the passkey sign-in is waiting for right now (null when idle). */
  protected readonly step = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly passkeys = passkeysSupported();
  protected readonly version = inject(VersionService);
  // the shell applies the saved light/dark choice; the sign-in page lives outside it
  private readonly theme = inject(ThemeService);

  constructor() {
    this.version.load();
    void this.auth.ensureLoaded().then((u) => {
      if (u) void this.router.navigateByUrl(this.target(u));
    });
  }

  protected async submit(): Promise<void> {
    if (this.form.invalid) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const { username, password } = this.form.getRawValue();
      const r = await this.api.login(username.trim(), password);
      await this.done(r.user);
    } catch (e) {
      this.error.set(
        e instanceof HttpErrorResponse && e.status === 401 ? 'Invalid username or password' : errorMessage(e),
      );
    } finally {
      this.busy.set(false);
    }
  }

  protected async passkey(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.step.set('Preparing the sign-in…');
    try {
      const req = await this.api.passkeyLoginOptions();
      this.step.set('Waiting for your device: choose your passkey in the browser prompt and confirm.');
      const credential = await getAssertion(req.options);
      this.step.set('Signing in…');
      const r = await this.api.passkeyLogin(req.requestId, credential);
      await this.done(r.user);
    } catch (e) {
      if (!isCancelled(e)) {
        this.error.set(
          e instanceof HttpErrorResponse && e.status === 401 ? 'This passkey is not registered' : errorMessage(e),
        );
      }
    } finally {
      this.step.set(null);
      this.busy.set(false);
    }
  }

  private async done(user: User): Promise<void> {
    this.auth.setUser(user);
    await this.router.navigateByUrl(this.target(user));
  }

  private target(user: User): string {
    if (user.mustChangePassword) return '/account';
    const back = this.route.snapshot.queryParamMap.get('returnUrl');
    return back && back.startsWith('/') && !back.startsWith('//') && !back.startsWith('/login')
      ? back
      : AuthService.homeFor(user.role);
  }
}
