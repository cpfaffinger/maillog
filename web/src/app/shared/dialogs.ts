import { Component, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Notify } from '../core/notify.service';
import { copyText } from '../core/util';

/** Monospace text with a copy button (install commands, tokens). */
@Component({
  selector: 'app-copy-box',
  imports: [MatButtonModule, MatIconModule, MatTooltipModule],
  template: `
    <div class="box">
      <code class="mono wrap-any" tabindex="0">{{ text() }}</code>
      <button mat-icon-button type="button" (click)="copy()" matTooltip="Copy" [attr.aria-label]="'Copy ' + label()">
        <mat-icon>{{ copied() ? 'check' : 'content_copy' }}</mat-icon>
      </button>
    </div>
  `,
  styles: `
    .box { display: flex; align-items: flex-start; gap: 8px; background: var(--mat-sys-surface-container-highest);
           border-radius: var(--mat-sys-corner-small); padding: 8px 4px 8px 12px; }
    code { flex: 1; user-select: all; }
  `,
})
export class CopyBox {
  readonly text = input.required<string>();
  readonly label = input('text');
  protected readonly copied = signal(false);
  private readonly notify = inject(Notify);

  protected async copy(): Promise<void> {
    if (await copyText(this.text())) {
      this.copied.set(true);
      this.notify.info('Copied to clipboard');
      setTimeout(() => this.copied.set(false), 2000);
    } else {
      this.notify.error('Copy failed, select the text manually');
    }
  }
}

export interface ConfirmData {
  title: string;
  message: string;
  confirm: string;
  danger?: boolean;
}

@Component({
  selector: 'app-confirm-dialog',
  imports: [MatDialogModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>{{ data.message }}</mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button [mat-dialog-close]="true" [class.danger]="data.danger" cdkFocusInitial>
        {{ data.confirm }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .danger { --mat-button-filled-container-color: var(--mat-sys-error); --mat-button-filled-label-text-color: var(--mat-sys-on-error); }
  `,
})
export class ConfirmDialog {
  protected readonly data = inject<ConfirmData>(MAT_DIALOG_DATA);
}

export interface SecretData {
  title: string;
  intro: string;
  secret: string;
  secretLabel: string;
  warning?: string;
}

/** Shows a one-time secret (token / install command) with a copy box. */
@Component({
  selector: 'app-secret-dialog',
  imports: [MatDialogModule, MatButtonModule, MatIconModule, CopyBox],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>
      <p>{{ data.intro }}</p>
      <app-copy-box [text]="data.secret" [label]="data.secretLabel" />
      @if (data.warning) {
        <p class="warn"><mat-icon aria-hidden="true">warning</mat-icon>{{ data.warning }}</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-flat-button mat-dialog-close cdkFocusInitial>Done</button>
    </mat-dialog-actions>
  `,
  styles: `
    .warn { display: flex; gap: 8px; align-items: center; color: var(--ml-warn); }
  `,
})
export class SecretDialog {
  protected readonly data = inject<SecretData>(MAT_DIALOG_DATA);
}
