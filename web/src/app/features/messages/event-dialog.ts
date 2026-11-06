import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { MailEvent } from '../../api/models';
import { TsPipe } from '../../core/pipes';

interface Field {
  label: string;
  value: string;
}

@Component({
  selector: 'app-event-dialog',
  imports: [MatDialogModule, MatButtonModule, TsPipe],
  template: `
    <h2 mat-dialog-title>Event #{{ e.id }}</h2>
    <mat-dialog-content>
      <dl>
        <dt>Time</dt><dd>{{ e.ts | ts }}</dd>
        @for (f of fields(); track f.label) {
          <dt>{{ f.label }}</dt><dd class="wrap-any">{{ f.value }}</dd>
        }
      </dl>
      @if (e.raw) {
        <h3>Raw log line</h3>
        <pre class="mono raw">{{ e.raw }}</pre>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      @if (e.queueId && e.queueId !== 'NOQUEUE') {
        <button mat-button (click)="trace(e.queueId)">Trace this message</button>
      }
      <button mat-flat-button mat-dialog-close cdkFocusInitial>Close</button>
    </mat-dialog-actions>
  `,
  styles: `
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
    dt { color: var(--ml-muted); }
    dd { margin: 0; }
    h3 { font: var(--mat-sys-label-large); color: var(--ml-muted); margin: 16px 0 4px; }
    .raw { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; background: var(--mat-sys-surface-container-highest);
           padding: 8px; border-radius: 8px; }
  `,
})
export class EventDialog {
  protected readonly e = inject<MailEvent>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<EventDialog>);
  private readonly router = inject(Router);

  protected fields(): Field[] {
    const e = this.e;
    const pairs: [string, string | number | null][] = [
      ['Kind', e.kind], ['Agent', e.agentName ?? e.agentRole], ['Source', e.source], ['Program', e.program],
      ['Queue ID', e.queueId], ['Next queue ID', e.nextQueueId], ['Sender', e.sender], ['Recipient', e.recipient],
      ['Client IP', e.clientIp], ['Client host', e.clientHost], ['SASL user', e.saslUser], ['Relay', e.relay],
      ['Status', e.status], ['DSN', e.dsn], ['Delay (s)', e.delayS], ['Detail', e.detail],
    ];
    return pairs.filter(([, v]) => v !== null && v !== '').map(([label, v]) => ({ label, value: String(v) }));
  }

  protected trace(queueId: string): void {
    this.ref.close();
    void this.router.navigate(['/trace'], { queryParams: { q: queueId } });
  }
}
