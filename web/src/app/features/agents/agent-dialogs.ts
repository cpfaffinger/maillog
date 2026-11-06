import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { Agent, AgentCheck, AgentConfigInput, AgentLog } from '../../api/models';

export interface AddAgentResult {
  name: string;
  role: string;
}

@Component({
  selector: 'app-add-agent-dialog',
  imports: [ReactiveFormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule],
  template: `
    <h2 mat-dialog-title>Add agent</h2>
    <form [formGroup]="form" (ngSubmit)="save()">
      <mat-dialog-content>
        <p class="muted">Creates the agent and a single-use enrollment command to run on the mail server.</p>
        <mat-form-field class="full">
          <mat-label>Name</mat-label>
          <input matInput formControlName="name" placeholder="smtp2" required autocomplete="off" />
          <mat-hint>Letters, digits, dot, dash, underscore</mat-hint>
          @if (form.controls.name.invalid && form.controls.name.touched) { <mat-error>Enter a valid name</mat-error> }
        </mat-form-field>
        <mat-form-field class="full">
          <mat-label>Role</mat-label>
          <mat-select formControlName="role">
            <mat-option value="relay">relay – SASL relay (smtp2): saslauthd, fail2ban</mat-option>
            <mat-option value="outbound">outbound – DKIM + delivery (mailout)</mat-option>
            <mat-option value="inbound">inbound – MX / mail in</mat-option>
            <mat-option value="generic">generic – any Postfix host</mat-option>
          </mat-select>
          <mat-hint>Selects the default health checks and logs; editable afterwards</mat-hint>
        </mat-form-field>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button type="button" mat-dialog-close>Cancel</button>
        <button mat-flat-button type="submit" [disabled]="form.invalid">Create</button>
      </mat-dialog-actions>
    </form>
  `,
  styles: `.full { width: 100%; margin-top: 8px; }`,
})
export class AddAgentDialog {
  private readonly ref = inject(MatDialogRef<AddAgentDialog, AddAgentResult>);
  protected readonly form = inject(FormBuilder).nonNullable.group({
    name: ['', [Validators.required, Validators.pattern(/^[A-Za-z0-9._-]{1,64}$/)]],
    role: ['relay', Validators.required],
  });

  protected save(): void {
    if (this.form.valid) this.ref.close(this.form.getRawValue());
  }
}

export interface ConfigDialogData {
  agent: Agent;
  readonly: boolean;
}

/** Returns an error message, or null when the check list is acceptable. */
export function validateChecks(v: unknown): string | null {
  if (!Array.isArray(v)) return 'Checks must be a JSON array';
  const names = new Set<string>();
  for (const [i, c] of v.entries()) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return `Check #${i + 1} must be an object`;
    const o = c as Record<string, unknown>;
    if (typeof o['name'] !== 'string' || !o['name']) return `Check #${i + 1} needs a "name"`;
    if (typeof o['type'] !== 'string' || !o['type']) return `Check "${o['name']}" needs a "type"`;
    if (names.has(o['name'])) return `Duplicate check name "${o['name']}"`;
    names.add(o['name']);
  }
  return null;
}

export function validateLogs(v: unknown): string | null {
  if (!Array.isArray(v)) return 'Logs must be a JSON array';
  for (const [i, l] of v.entries()) {
    const o = l as Record<string, unknown> | null;
    if (!o || typeof o['path'] !== 'string' || !o['path'] || typeof o['source'] !== 'string' || !o['source']) {
      return `Log #${i + 1} needs "path" and "source"`;
    }
  }
  return null;
}

@Component({
  selector: 'app-config-dialog',
  imports: [ReactiveFormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule],
  template: `
    <h2 mat-dialog-title>{{ data.readonly ? 'Configuration' : 'Edit configuration' }} · {{ data.agent.name }}</h2>
    <form [formGroup]="form" (ngSubmit)="save()">
      <mat-dialog-content>
        <mat-form-field class="full">
          <mat-label>Report interval (seconds)</mat-label>
          <input matInput type="number" min="5" max="3600" formControlName="intervalS" />
        </mat-form-field>
        <mat-form-field class="full">
          <mat-label>Health checks (JSON array)</mat-label>
          <textarea matInput class="mono" rows="12" formControlName="checks" spellcheck="false"
                    [readonly]="data.readonly"></textarea>
        </mat-form-field>
        <mat-form-field class="full">
          <mat-label>Logs to ship (JSON array)</mat-label>
          <textarea matInput class="mono" rows="4" formControlName="logs" spellcheck="false"
                    [readonly]="data.readonly"></textarea>
        </mat-form-field>
        @if (problem(); as p) { <p class="err" role="alert">{{ p }}</p> }
        <p class="muted small">Check types: service, tcp, disk, queue, sasl_probe. See the agent protocol documentation.</p>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button type="button" mat-dialog-close>{{ data.readonly ? 'Close' : 'Cancel' }}</button>
        @if (!data.readonly) { <button mat-flat-button type="submit" [disabled]="!!problem()">Save</button> }
      </mat-dialog-actions>
    </form>
  `,
  styles: `
    .full { width: 100%; margin-top: 8px; }
    textarea { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
    .err { color: var(--ml-fail); }
    .small { font-size: 0.85em; }
  `,
})
export class ConfigDialog {
  protected readonly data = inject<ConfigDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<ConfigDialog, AgentConfigInput>);
  protected readonly form = inject(FormBuilder).nonNullable.group({
    intervalS: [this.data.agent.intervalS, [Validators.required, Validators.min(5), Validators.max(3600)]],
    checks: [JSON.stringify(this.data.agent.checks, null, 2)],
    logs: [JSON.stringify(this.data.agent.logs, null, 2)],
  });
  private readonly tick = signal(0);

  constructor() {
    this.form.valueChanges.subscribe(() => this.tick.update((n) => n + 1));
  }

  private parsed(): { checks?: unknown; logs?: unknown; error?: string } {
    const v = this.form.getRawValue();
    try {
      return { checks: JSON.parse(v.checks), logs: JSON.parse(v.logs) };
    } catch (e) {
      return { error: 'Invalid JSON: ' + (e instanceof Error ? e.message : String(e)) };
    }
  }

  protected readonly problem = computed(() => {
    this.tick();
    if (this.form.controls.intervalS.invalid) return 'Interval must be between 5 and 3600 seconds';
    const p = this.parsed();
    return p.error ?? validateChecks(p.checks) ?? validateLogs(p.logs);
  });

  protected save(): void {
    if (this.problem() || this.data.readonly) return;
    const p = this.parsed();
    this.ref.close({
      intervalS: Number(this.form.getRawValue().intervalS),
      checks: p.checks as AgentCheck[],
      logs: p.logs as AgentLog[],
    });
  }
}
