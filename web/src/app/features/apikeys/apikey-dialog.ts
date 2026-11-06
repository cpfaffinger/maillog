import { COMMA, ENTER, SPACE } from '@angular/cdk/keycodes';
import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatChipInputEvent, MatChipsModule } from '@angular/material/chips';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { ApiKey, ApiKeyInput } from '../../api/models';
import { normalizeDomain } from '../users/user-dialog';

@Component({
  selector: 'app-apikey-dialog',
  imports: [ReactiveFormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatChipsModule, MatIconModule],
  template: `
    <h2 mat-dialog-title>{{ key ? 'Edit API key' : 'New API key' }}</h2>
    <form [formGroup]="form" (ngSubmit)="save()">
      <mat-dialog-content>
        <mat-form-field class="full">
          <mat-label>Name</mat-label>
          <input matInput formControlName="name" placeholder="danceplus.at web application" required autocomplete="off" />
          <mat-hint>Tells you later which application uses the key</mat-hint>
        </mat-form-field>

        <mat-form-field class="full">
          <mat-label>Sender domains</mat-label>
          <mat-chip-grid #grid aria-label="Sender domains">
            @for (d of domains(); track d) {
              <mat-chip-row (removed)="remove(d)">
                {{ '@' + d }}
                <button matChipRemove [attr.aria-label]="'Remove ' + d"><mat-icon>cancel</mat-icon></button>
              </mat-chip-row>
            }
            <input placeholder="danceplus.at" [matChipInputFor]="grid" [matChipInputSeparatorKeyCodes]="separators"
                   matChipInputAddOnBlur (matChipInputTokenEnd)="add($event)" />
          </mat-chip-grid>
          <mat-hint>The key only finds messages sent from these domains (envelope sender). Other messages look like unknown ones.</mat-hint>
        </mat-form-field>
        @if (domainError()) { <p class="err" role="alert">{{ domainError() }}</p> }

        @if (!key) {
          <mat-form-field class="full">
            <mat-label>Expires</mat-label>
            <mat-select formControlName="days">
              <mat-option [value]="90">in 90 days</mat-option>
              <mat-option [value]="365">in 1 year</mat-option>
              <mat-option [value]="0">never</mat-option>
            </mat-select>
          </mat-form-field>
        }
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button type="button" mat-dialog-close>Cancel</button>
        <button mat-flat-button type="submit" [disabled]="form.invalid || !!domainError()">{{ key ? 'Save' : 'Create key' }}</button>
      </mat-dialog-actions>
    </form>
  `,
  styles: `
    .full { width: 100%; margin-top: 8px; }
    .err { color: var(--ml-fail); margin: 0; }
  `,
})
export class ApiKeyDialog {
  protected readonly key = inject<ApiKey | null>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<ApiKeyDialog, ApiKeyInput>);
  protected readonly separators = [ENTER, COMMA, SPACE];

  protected readonly domains = signal<string[]>([...(this.key?.domains ?? [])]);
  protected readonly domainError = computed(() => (this.domains().length === 0 ? 'An API key needs at least one sender domain' : null));
  protected readonly form = inject(FormBuilder).nonNullable.group({
    name: [this.key?.name ?? '', [Validators.required, Validators.maxLength(100)]],
    days: 365,
  });

  protected add(ev: MatChipInputEvent): void {
    const d = normalizeDomain(ev.value);
    if (d && !this.domains().includes(d)) this.domains.update((l) => [...l, d]);
    if (d || !ev.value.trim()) ev.chipInput.clear();
  }

  protected remove(d: string): void {
    this.domains.update((l) => l.filter((x) => x !== d));
  }

  protected save(): void {
    if (this.form.invalid || this.domainError()) return;
    const v = this.form.getRawValue();
    const out: ApiKeyInput = { name: v.name.trim(), domains: this.domains() };
    if (!this.key && v.days > 0) out.expiresInDays = v.days;
    this.ref.close(out);
  }
}
