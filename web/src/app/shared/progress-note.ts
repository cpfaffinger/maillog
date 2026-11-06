import { Component, input } from '@angular/core';
import { MatProgressBarModule } from '@angular/material/progress-bar';

/** Indeterminate progress bar with a line of text that says what is happening (announced to screen readers). */
@Component({
  selector: 'app-progress-note',
  imports: [MatProgressBarModule],
  template: `
    <div class="note" role="status" aria-live="polite">
      <mat-progress-bar mode="indeterminate" [attr.aria-label]="text()" />
      <p class="text">{{ text() }}</p>
    </div>
  `,
  styles: `
    .note { margin: 8px 0; }
    .text { margin: 8px 0 0; color: var(--ml-muted); font-size: 0.9em; }
  `,
})
export class ProgressNote {
  readonly text = input.required<string>();
}
