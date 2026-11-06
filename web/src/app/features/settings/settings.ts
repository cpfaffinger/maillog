import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { ApiService } from '../../api/api.service';
import { AppSettings, ChannelKey, Channels, SmtpSecurity, TestNotificationResult, WebhookFormat } from '../../api/models';
import { Notify } from '../../core/notify.service';
import { TsPipe } from '../../core/pipes';
import { ChipList } from '../../shared/chip-list';
import {
  buildChannelsInput, buildTestBody, ChannelsFormValue, fromChannels, normalizeEmail, normalizeSignalRecipient,
  portAfterSecurityChange, validateChannel, validateForSave, WEBHOOK_FORMATS,
} from './channels';

@Component({
  selector: 'app-settings',
  imports: [
    ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatIconModule, MatExpansionModule,
    MatSlideToggleModule, MatSelectModule, MatCheckboxModule, MatProgressBarModule, NgTemplateOutlet, ChipList, TsPipe,
  ],
  template: `
    <div class="page">
      <div class="page-head"><h1>Settings</h1></div>

      @if (s(); as cfg) {
        <div class="cols">
          <section class="card" aria-labelledby="h-ret">
            <h2 id="h-ret">Data retention</h2>
            <p class="muted">Events older than the retention period are deleted automatically. Applies to all mail events;
              health history and alerts are cleaned up with the same period.</p>
            <form class="inline" [formGroup]="retention" (ngSubmit)="saveRetention()">
              <mat-form-field subscriptSizing="dynamic">
                <mat-label>Keep events for (days)</mat-label>
                <input matInput type="number" min="1" max="3650" formControlName="days" />
                @if (retention.controls.days.invalid) { <mat-error>1 – 3650 days</mat-error> }
              </mat-form-field>
              <button mat-flat-button type="submit" [disabled]="retention.invalid || retention.pristine">Save</button>
            </form>
            <dl>
              <dt>Stored events</dt><dd>{{ cfg.eventCount.toLocaleString() }}</dd>
              <dt>Oldest event</dt><dd>{{ cfg.oldestEventTs ? (cfg.oldestEventTs | ts) : '–' }}</dd>
            </dl>
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

      <section class="channels" aria-labelledby="h-ch">
        <div class="head">
          <h2 id="h-ch">Alert channels</h2><span class="spacer"></span>
          <button mat-stroked-button type="button" (click)="testSaved()" [disabled]="testingAll()">
            <mat-icon>send</mat-icon> Test all saved channels
          </button>
        </div>
        <p class="muted">Choose how alerts are delivered. Enable one or more channels; alerts are sent through every enabled channel.</p>
        @if (testAll(); as r) {
          <p role="status" [class.ok]="r.ok" [class.bad]="!r.ok">{{ r.ok ? 'Test notification sent.' : 'Sending failed:' }}</p>
          @for (e of r.errors; track e) { <p class="bad wrap-any">{{ e }}</p> }
        }

        @if (loaded()) {
          <div [formGroup]="form">
            <mat-accordion multi>
              <!-- SMTP -->
              <mat-expansion-panel formGroupName="smtp" expanded>
                <mat-expansion-panel-header>
                  <mat-panel-title><mat-icon aria-hidden="true">mail</mat-icon>&nbsp;E-mail (SMTP)</mat-panel-title>
                  <mat-panel-description>
                    <span class="pill {{ form.controls.smtp.controls.enabled.value ? 'ok' : 'neutral' }}">
                      {{ form.controls.smtp.controls.enabled.value ? 'enabled' : 'disabled' }}</span>
                  </mat-panel-description>
                </mat-expansion-panel-header>

                <p class="note"><mat-icon aria-hidden="true">info</mat-icon>
                  Use an SMTP server that is independent of the mail system you monitor, otherwise alerts about a mail outage cannot be delivered.</p>
                <mat-slide-toggle formControlName="enabled">Enabled</mat-slide-toggle>

                <div class="row">
                  <mat-form-field class="grow">
                    <mat-label>Server host</mat-label>
                    <input matInput formControlName="host" placeholder="smtp.example.com" autocomplete="off" />
                  </mat-form-field>
                  <mat-form-field class="port">
                    <mat-label>Port</mat-label>
                    <input matInput type="number" min="1" max="65535" formControlName="port" />
                    <mat-hint>25 · 587 · 465</mat-hint>
                  </mat-form-field>
                  <mat-form-field class="sec">
                    <mat-label>Security</mat-label>
                    <mat-select formControlName="security">
                      <mat-option value="none">None (port 25)</mat-option>
                      <mat-option value="starttls">STARTTLS (port 587)</mat-option>
                      <mat-option value="ssl">SSL/TLS (port 465)</mat-option>
                    </mat-select>
                  </mat-form-field>
                </div>

                <mat-slide-toggle formControlName="authenticate">Server requires authentication</mat-slide-toggle>
                @if (form.controls.smtp.controls.authenticate.value) {
                  <div class="row">
                    <mat-form-field class="grow">
                      <mat-label>Username</mat-label>
                      <input matInput formControlName="username" autocomplete="off" />
                    </mat-form-field>
                    <mat-form-field class="grow">
                      <mat-label>Password</mat-label>
                      <input matInput type="password" formControlName="password" autocomplete="new-password"
                             [placeholder]="passwordSet() ? 'stored – leave empty to keep' : ''" />
                      @if (passwordSet()) { <mat-hint>A password is stored; it is never shown</mat-hint> }
                    </mat-form-field>
                  </div>
                }
                @if (passwordSet()) {
                  <mat-checkbox formControlName="clearPassword">Remove stored password</mat-checkbox>
                }

                <div class="row">
                  <mat-form-field class="grow">
                    <mat-label>Sender address</mat-label>
                    <input matInput type="email" formControlName="from" placeholder="maillog@example.com" autocomplete="off" />
                  </mat-form-field>
                  <mat-form-field class="grow">
                    <mat-label>Sender display name</mat-label>
                    <input matInput formControlName="fromName" placeholder="maillog" autocomplete="off" />
                  </mat-form-field>
                </div>
                <app-chip-list formControlName="to" label="Recipients" placeholder="ops@example.com"
                               hint="Press Enter, comma or space after each address"
                               [normalize]="normalizeEmail" invalidMessage="Not a valid e-mail address" />

                <div class="actions">
                  <button mat-stroked-button type="button" (click)="test('smtp')" [disabled]="testing() !== null">
                    <mat-icon>send</mat-icon> Send test</button>
                  @if (testing() === 'smtp') { <mat-progress-bar mode="indeterminate" class="bar" /> }
                </div>
                @if (results().smtp; as r) { <ng-container [ngTemplateOutlet]="resultTpl" [ngTemplateOutletContext]="{ r }" /> }
              </mat-expansion-panel>

              <!-- Signal -->
              <mat-expansion-panel formGroupName="signal">
                <mat-expansion-panel-header>
                  <mat-panel-title><mat-icon aria-hidden="true">chat</mat-icon>&nbsp;Signal</mat-panel-title>
                  <mat-panel-description>
                    <span class="pill {{ form.controls.signal.controls.enabled.value ? 'ok' : 'neutral' }}">
                      {{ form.controls.signal.controls.enabled.value ? 'enabled' : 'disabled' }}</span>
                  </mat-panel-description>
                </mat-expansion-panel-header>
                <p class="note"><mat-icon aria-hidden="true">info</mat-icon>
                  Uses a <a href="https://github.com/bbernhard/signal-cli-rest-api" target="_blank" rel="noopener">signal-cli-rest-api</a>
                  instance with a registered sender number. Signal does not depend on your mail system.</p>
                <mat-slide-toggle formControlName="enabled">Enabled</mat-slide-toggle>
                <div class="row">
                  <mat-form-field class="grow">
                    <mat-label>signal-cli-rest-api URL</mat-label>
                    <input matInput type="url" formControlName="url" placeholder="http://localhost:8083" autocomplete="off" />
                  </mat-form-field>
                  <mat-form-field class="grow">
                    <mat-label>Sender number</mat-label>
                    <input matInput formControlName="number" placeholder="+4366412345678" autocomplete="off" />
                  </mat-form-field>
                </div>
                <app-chip-list formControlName="recipients" label="Recipients" placeholder="+4366412345678"
                               hint="Phone numbers in international format, or group.… ids"
                               [normalize]="normalizeSignalRecipient" invalidMessage="Not a valid number" />
                <div class="actions">
                  <button mat-stroked-button type="button" (click)="test('signal')" [disabled]="testing() !== null">
                    <mat-icon>send</mat-icon> Send test</button>
                  @if (testing() === 'signal') { <mat-progress-bar mode="indeterminate" class="bar" /> }
                </div>
                @if (results().signal; as r) { <ng-container [ngTemplateOutlet]="resultTpl" [ngTemplateOutletContext]="{ r }" /> }
              </mat-expansion-panel>

              <!-- Webhook -->
              <mat-expansion-panel formGroupName="webhook">
                <mat-expansion-panel-header>
                  <mat-panel-title><mat-icon aria-hidden="true">webhook</mat-icon>&nbsp;Webhook</mat-panel-title>
                  <mat-panel-description>
                    <span class="pill {{ form.controls.webhook.controls.enabled.value ? 'ok' : 'neutral' }}">
                      {{ form.controls.webhook.controls.enabled.value ? 'enabled' : 'disabled' }}</span>
                  </mat-panel-description>
                </mat-expansion-panel-header>
                <mat-slide-toggle formControlName="enabled">Enabled</mat-slide-toggle>
                <div class="row">
                  <mat-form-field class="grow">
                    <mat-label>Webhook URL</mat-label>
                    <input matInput type="url" formControlName="url" placeholder="https://hooks.example.com/…" autocomplete="off" />
                  </mat-form-field>
                  <mat-form-field class="sec">
                    <mat-label>Format</mat-label>
                    <mat-select formControlName="format">
                      @for (f of formats; track f.value) { <mat-option [value]="f.value">{{ f.label }}</mat-option> }
                    </mat-select>
                  </mat-form-field>
                </div>
                <div class="actions">
                  <button mat-stroked-button type="button" (click)="test('webhook')" [disabled]="testing() !== null">
                    <mat-icon>send</mat-icon> Send test</button>
                  @if (testing() === 'webhook') { <mat-progress-bar mode="indeterminate" class="bar" /> }
                </div>
                @if (results().webhook; as r) { <ng-container [ngTemplateOutlet]="resultTpl" [ngTemplateOutletContext]="{ r }" /> }
              </mat-expansion-panel>
            </mat-accordion>
          </div>

          @if (problems().length > 0) {
            <ul class="problems" role="alert" aria-label="Problems preventing save">
              @for (p of problems(); track p) { <li>{{ p }}</li> }
            </ul>
          }
          <div class="savebar">
            <button mat-flat-button type="button" (click)="save()" [disabled]="form.pristine || problems().length > 0 || saving()">
              Save alert channels</button>
            @if (form.dirty) { <span class="muted">Unsaved changes</span> }
          </div>
        } @else {
          <div class="empty">Loading…</div>
        }
      </section>
    </div>

    <ng-template #resultTpl let-r="r">
      <p role="status" [class.ok]="r.ok" [class.bad]="!r.ok">{{ r.ok ? 'Test message sent.' : 'Sending failed:' }}</p>
      @for (e of r.errors; track e) { <p class="bad wrap-any">{{ e }}</p> }
    </ng-template>
  `,
  styles: `
    .cols { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); margin-bottom: 24px; }
    .inline { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; margin: 12px 0; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 8px 0 0; }
    dt { color: var(--ml-muted); } dd { margin: 0; }
    .head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 12px; }
    .grow { flex: 1 1 220px; } .port { flex: 0 0 110px; } .sec { flex: 0 1 220px; }
    .note { display: flex; gap: 8px; align-items: flex-start; color: var(--ml-muted); margin: 8px 0 16px; }
    .note mat-icon { flex: none; }
    mat-slide-toggle { display: block; margin: 8px 0; }
    .actions { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
    .bar { max-width: 160px; }
    .savebar { display: flex; align-items: center; gap: 12px; margin-top: 16px; }
    .problems { color: var(--ml-warn); margin: 12px 0 0; padding-left: 20px; }
    .ok { color: var(--ml-ok); } .bad { color: var(--ml-fail); margin: 4px 0 0; }
    mat-expansion-panel { margin-bottom: 8px; }
  `,
})
export class SettingsPage {
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);
  private readonly fb = inject(FormBuilder).nonNullable;

  protected readonly s = signal<AppSettings | null>(null);
  protected readonly formats = WEBHOOK_FORMATS;
  protected readonly normalizeEmail = normalizeEmail;
  protected readonly normalizeSignalRecipient = normalizeSignalRecipient;

  protected readonly retention = this.fb.group({
    days: [180, [Validators.required, Validators.min(1), Validators.max(3650)]],
  });

  protected readonly form = this.fb.group({
    smtp: this.fb.group({
      enabled: false,
      host: '',
      port: 587,
      security: 'starttls' as SmtpSecurity,
      authenticate: true,
      username: '',
      password: '',
      clearPassword: false,
      from: '',
      fromName: 'maillog',
      to: [[] as string[]],
    }),
    signal: this.fb.group({ enabled: false, url: '', number: '', recipients: [[] as string[]] }),
    webhook: this.fb.group({ enabled: false, url: '', format: 'json' as WebhookFormat }),
  });

  protected readonly loaded = signal(false);
  protected readonly passwordSet = signal(false);
  protected readonly saving = signal(false);
  protected readonly testing = signal<ChannelKey | null>(null);
  protected readonly testingAll = signal(false);
  protected readonly testAll = signal<TestNotificationResult | null>(null);
  protected readonly results = signal<Partial<Record<ChannelKey, TestNotificationResult>>>({});

  private readonly value = signal<ChannelsFormValue>(this.form.getRawValue());
  protected readonly problems = computed(() => validateForSave(this.value(), this.passwordSet()));
  private lastSecurity: SmtpSecurity = 'starttls';

  constructor() {
    const smtp = this.form.controls.smtp.controls;
    this.form.valueChanges.subscribe(() => this.value.set(this.form.getRawValue()));
    smtp.security.valueChanges.subscribe((sec) => {
      smtp.port.setValue(portAfterSecurityChange(Number(smtp.port.value), this.lastSecurity, sec));
      this.lastSecurity = sec;
    });
    smtp.clearPassword.valueChanges.subscribe((clear) => {
      if (clear) {
        smtp.password.setValue('');
        smtp.password.disable();
      } else {
        smtp.password.enable();
      }
    });
    void this.load();
  }

  protected async saveRetention(): Promise<void> {
    if (this.retention.invalid) return;
    try {
      this.applySettings(await this.api.settingsSave(Math.round(this.retention.getRawValue().days)));
      this.notify.info('Retention saved');
    } catch {
      /* reported by the interceptor */
    }
  }

  protected async save(): Promise<void> {
    if (this.problems().length > 0) return;
    this.saving.set(true);
    try {
      this.applyChannels(await this.api.channelsSave(buildChannelsInput(this.form.getRawValue())));
      this.notify.info('Alert channels saved');
    } catch {
      /* reported by the interceptor (validation errors arrive as 400 {error}) */
    } finally {
      this.saving.set(false);
    }
  }

  protected async test(kind: ChannelKey): Promise<void> {
    const values = this.form.getRawValue();
    const problems = validateChannel(kind, values, this.passwordSet());
    if (problems.length > 0) {
      this.notify.error(problems[0]);
      return;
    }
    this.testing.set(kind);
    this.results.update((r) => ({ ...r, [kind]: undefined }));
    try {
      const r = await this.api.channelTest(kind, buildTestBody(kind, values));
      this.results.update((cur) => ({ ...cur, [kind]: r }));
      if (r.ok) this.notify.info('Test message sent');
      else this.notify.error(r.errors[0] ?? 'Test failed');
    } catch {
      /* reported by the interceptor */
    } finally {
      this.testing.set(null);
    }
  }

  protected async testSaved(): Promise<void> {
    this.testingAll.set(true);
    this.testAll.set(null);
    try {
      this.testAll.set(await this.api.testNotification());
    } catch {
      /* reported by the interceptor */
    } finally {
      this.testingAll.set(false);
    }
  }

  private async load(): Promise<void> {
    try {
      const [settings, channels] = await Promise.all([this.api.settings(), this.api.channels()]);
      this.applySettings(settings);
      this.applyChannels(channels);
    } catch {
      /* reported by the interceptor */
    }
  }

  private applySettings(s: AppSettings): void {
    this.s.set(s);
    this.retention.reset({ days: s.retentionDays });
  }

  private applyChannels(c: Channels): void {
    this.passwordSet.set(c.smtp.passwordSet);
    const v = fromChannels(c);
    this.lastSecurity = v.smtp.security;
    this.form.controls.smtp.controls.password.enable({ emitEvent: false });
    this.form.reset(v);
    this.value.set(this.form.getRawValue());
    this.loaded.set(true);
  }
}
