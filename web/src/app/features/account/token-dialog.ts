import { Component, inject } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';

export interface TokenInput {
  name: string;
  readOnly: boolean;
  expiresInDays?: number;
}

@Component({
  selector: 'app-token-dialog',
  imports: [ReactiveFormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatCheckboxModule],
  template: `
    <h2 mat-dialog-title>New access token</h2>
    <form [formGroup]="form" (ngSubmit)="save()">
      <mat-dialog-content>
        <mat-form-field class="full">
          <mat-label>Name</mat-label>
          <input matInput formControlName="name" placeholder="reporting script" required autocomplete="off" />
          <mat-hint>Helps you recognise the token later</mat-hint>
        </mat-form-field>
        <mat-form-field class="full">
          <mat-label>Expires</mat-label>
          <mat-select formControlName="days">
            <mat-option [value]="30">in 30 days</mat-option>
            <mat-option [value]="90">in 90 days</mat-option>
            <mat-option [value]="365">in 1 year</mat-option>
            <mat-option [value]="0">never</mat-option>
          </mat-select>
        </mat-form-field>
        <mat-checkbox formControlName="readOnly">Read-only (allows GET requests only)</mat-checkbox>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button type="button" mat-dialog-close>Cancel</button>
        <button mat-flat-button type="submit" [disabled]="form.invalid">Create token</button>
      </mat-dialog-actions>
    </form>
  `,
  styles: `.full { width: 100%; margin-top: 8px; }`,
})
export class TokenDialog {
  private readonly ref = inject(MatDialogRef<TokenDialog, TokenInput>);
  protected readonly form = inject(FormBuilder).nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(80)]],
    days: 90,
    readOnly: true,
  });

  protected save(): void {
    if (this.form.invalid) return;
    const v = this.form.getRawValue();
    this.ref.close({ name: v.name.trim(), readOnly: v.readOnly, expiresInDays: v.days > 0 ? v.days : undefined });
  }
}
