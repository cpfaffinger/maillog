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
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { Role, User, UserInput } from '../../api/models';

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/** "@Customer-A.example" -> "customer-a.example"; null when it is not a plausible domain. */
export function normalizeDomain(v: string): string | null {
  const d = v.trim().replace(/^@/, '').toLowerCase();
  return DOMAIN_RE.test(d) ? d : null;
}

@Component({
  selector: 'app-user-dialog',
  imports: [
    ReactiveFormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule,
    MatChipsModule, MatIconModule, MatSlideToggleModule,
  ],
  template: `
    <h2 mat-dialog-title>{{ user ? 'Edit user' : 'Add user' }}</h2>
    <form [formGroup]="form" (ngSubmit)="save()">
      <mat-dialog-content>
        <mat-form-field class="full">
          <mat-label>Username</mat-label>
          <input matInput formControlName="username" autocomplete="off" required />
          @if (form.controls.username.invalid) { <mat-error>2–64 characters: letters, digits, . _ - &#64;</mat-error> }
        </mat-form-field>
        <mat-form-field class="full">
          <mat-label>Display name</mat-label>
          <input matInput formControlName="displayName" autocomplete="off" />
        </mat-form-field>
        <mat-form-field class="full">
          <mat-label>Role</mat-label>
          <mat-select formControlName="role" (selectionChange)="role.set($event.value)">
            <mat-option value="admin">admin – everything</mat-option>
            <mat-option value="operator">operator – all data, read-only infrastructure</mat-option>
            <mat-option value="viewer">viewer – only mail of the listed sender domains</mat-option>
          </mat-select>
        </mat-form-field>

        @if (role() === 'viewer') {
          <mat-form-field class="full">
            <mat-label>Sender domains</mat-label>
            <mat-chip-grid #grid aria-label="Sender domains">
              @for (d of domains(); track d) {
                <mat-chip-row (removed)="remove(d)">
                  {{ '@' + d }}
                  <button matChipRemove [attr.aria-label]="'Remove ' + d"><mat-icon>cancel</mat-icon></button>
                </mat-chip-row>
              }
              <input placeholder="customer-a.example" [matChipInputFor]="grid" [matChipInputSeparatorKeyCodes]="separators"
                     matChipInputAddOnBlur (matChipInputTokenEnd)="add($event)" />
            </mat-chip-grid>
            <mat-hint>The viewer sees all mail sent from these domains and nothing else</mat-hint>
          </mat-form-field>
          @if (domainError()) { <p class="err" role="alert">{{ domainError() }}</p> }
        }

        <mat-form-field class="full">
          <mat-label>{{ user ? 'New password (optional)' : 'Password' }}</mat-label>
          <input matInput type="password" formControlName="password" autocomplete="new-password" [required]="!user" />
          <mat-hint>At least 12 characters</mat-hint>
          @if (form.controls.password.invalid) { <mat-error>At least 12 characters</mat-error> }
        </mat-form-field>

        @if (user) {
          <mat-slide-toggle formControlName="disabled">Account disabled</mat-slide-toggle>
        }
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button type="button" mat-dialog-close>Cancel</button>
        <button mat-flat-button type="submit" [disabled]="form.invalid || !!domainError()">Save</button>
      </mat-dialog-actions>
    </form>
  `,
  styles: `
    .full { width: 100%; margin-top: 8px; }
    .err { color: var(--ml-fail); margin: 0; }
  `,
})
export class UserDialog {
  protected readonly user = inject<User | null>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<UserDialog, UserInput>);
  protected readonly separators = [ENTER, COMMA, SPACE];

  protected readonly role = signal<Role>(this.user?.role ?? 'viewer');
  protected readonly domains = signal<string[]>([...(this.user?.domains ?? [])]);
  protected readonly domainError = computed(() =>
    this.role() === 'viewer' && this.domains().length === 0 ? 'A viewer needs at least one sender domain' : null);

  protected readonly form = inject(FormBuilder).nonNullable.group({
    username: [
      { value: this.user?.username ?? '', disabled: !!this.user },
      [Validators.required, Validators.pattern(/^[A-Za-z0-9._@-]{2,64}$/)],
    ],
    displayName: this.user?.displayName ?? '',
    role: this.user?.role ?? ('viewer' as Role),
    password: ['', this.user ? [Validators.minLength(12)] : [Validators.required, Validators.minLength(12)]],
    disabled: this.user?.disabled ?? false,
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
    const out: UserInput = {
      displayName: v.displayName.trim(),
      role: v.role,
      domains: v.role === 'viewer' ? this.domains() : [],
    };
    if (!this.user) out.username = v.username.trim();
    else out.disabled = v.disabled;
    if (v.password) out.password = v.password;
    this.ref.close(out);
  }
}
