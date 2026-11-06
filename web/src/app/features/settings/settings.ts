import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { ApiService } from '../../api/api.service';
import { AppSettings, TestNotificationResult } from '../../api/models';
import { Notify } from '../../core/notify.service';
import { TsPipe } from '../../core/pipes';

@Component({
  selector: 'app-settings',
  imports: [ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatIconModule, TsPipe],
  template: `
    <div class="page">
      <div class="page-head"><h1>Settings</h1></div>

      @if (s(); as cfg) {
        <div class="cols">
          <section class="card" aria-labelledby="h-ret">
            <h2 id="h-ret">Data retention</h2>
            <p class="muted">Events older than the retention period are deleted automatically. Applies to all mail events;
              health history and alerts are cleaned up with the same period.</p>
            <form class="inline" [formGroup]="form" (ngSubmit)="save()">
              <mat-form-field subscriptSizing="dynamic">
                <mat-label>Keep events for (days)</mat-label>
                <input matInput type="number" min="1" max="3650" formControlName="days" />
                @if (form.controls.days.invalid) { <mat-error>1 – 3650 days</mat-error> }
              </mat-form-field>
              <button mat-flat-button type="submit" [disabled]="form.invalid || form.pristine">Save</button>
            </form>
            <dl>
              <dt>Stored events</dt><dd>{{ cfg.eventCount.toLocaleString() }}</dd>
              <dt>Oldest event</dt><dd>{{ cfg.oldestEventTs ? (cfg.oldestEventTs | ts) : '–' }}</dd>
            </dl>
          </section>

          <section class="card" aria-labelledby="h-ch">
            <h2 id="h-ch">Alert channels</h2>
            <p class="muted">Configured through environment variables on the server (see the README).</p>
            <ul class="channels">
              <li><mat-icon [class.on]="cfg.channels.webhook">{{ cfg.channels.webhook ? 'check_circle' : 'cancel' }}</mat-icon> Webhook</li>
              <li><mat-icon [class.on]="cfg.channels.signal">{{ cfg.channels.signal ? 'check_circle' : 'cancel' }}</mat-icon> Signal</li>
              <li><mat-icon [class.on]="cfg.channels.smtp">{{ cfg.channels.smtp ? 'check_circle' : 'cancel' }}</mat-icon> E-mail (SMTP)</li>
            </ul>
            <button mat-stroked-button (click)="test()" [disabled]="testing()"><mat-icon>send</mat-icon> Send test notification</button>
            @if (result(); as r) {
              <p [class.ok]="r.ok" [class.bad]="!r.ok" role="status">
                {{ r.ok ? 'Test notification sent.' : 'Sending failed:' }}
              </p>
              @for (e of r.errors; track e) { <p class="bad wrap-any">{{ e }}</p> }
            }
          </section>

          <section class="card" aria-labelledby="h-gen">
            <h2 id="h-gen">General</h2>
            <dl>
              <dt>Public URL</dt><dd class="wrap-any">{{ cfg.publicUrl || 'not set' }}</dd>
              <dt>Passkeys</dt><dd>{{ cfg.passkeysAvailable ? 'available' : 'unavailable – set MAILLOG_PUBLIC_URL to an https URL' }}</dd>
              <dt>API docs</dt><dd><a href="/api/docs" target="_blank" rel="noopener">Open interactive API documentation</a>
                · <a href="/openapi/v1.json" target="_blank" rel="noopener">OpenAPI JSON</a></dd>
            </dl>
          </section>
        </div>
      } @else {
        <div class="empty">Loading…</div>
      }
    </div>
  `,
  styles: `
    .cols { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); }
    .inline { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; margin: 12px 0; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 8px 0 0; }
    dt { color: var(--ml-muted); } dd { margin: 0; }
    .channels { list-style: none; padding: 0; margin: 0 0 12px; display: grid; gap: 6px; }
    .channels li { display: flex; align-items: center; gap: 8px; }
    .channels mat-icon { color: var(--ml-muted); }
    .channels mat-icon.on { color: var(--ml-ok); }
    .ok { color: var(--ml-ok); } .bad { color: var(--ml-fail); margin: 4px 0 0; }
  `,
})
export class SettingsPage {
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);
  protected readonly s = signal<AppSettings | null>(null);
  protected readonly testing = signal(false);
  protected readonly result = signal<TestNotificationResult | null>(null);

  protected readonly form = inject(FormBuilder).nonNullable.group({
    days: [180, [Validators.required, Validators.min(1), Validators.max(3650)]],
  });

  constructor() {
    void this.load();
  }

  protected async save(): Promise<void> {
    if (this.form.invalid) return;
    try {
      this.apply(await this.api.settingsSave(Math.round(this.form.getRawValue().days)));
      this.notify.info('Retention saved');
    } catch {
      /* reported by the interceptor */
    }
  }

  protected async test(): Promise<void> {
    this.testing.set(true);
    this.result.set(null);
    try {
      this.result.set(await this.api.testNotification());
    } catch {
      /* reported by the interceptor */
    } finally {
      this.testing.set(false);
    }
  }

  private async load(): Promise<void> {
    try {
      this.apply(await this.api.settings());
    } catch {
      /* reported by the interceptor */
    }
  }

  private apply(s: AppSettings): void {
    this.s.set(s);
    this.form.reset({ days: s.retentionDays });
  }
}
