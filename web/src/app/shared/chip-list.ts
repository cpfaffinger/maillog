import { COMMA, ENTER, SPACE } from '@angular/cdk/keycodes';
import { Component, forwardRef, input, signal } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { MatChipInputEvent, MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';

/** Form control holding a list of validated strings, edited as chips (e-mail addresses, phone numbers, domains). */
@Component({
  selector: 'app-chip-list',
  imports: [MatChipsModule, MatFormFieldModule, MatIconModule],
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => ChipList), multi: true }],
  template: `
    <mat-form-field class="full">
      <mat-label>{{ label() }}</mat-label>
      <mat-chip-grid #grid [attr.aria-label]="label()" [disabled]="disabled()">
        @for (v of value(); track v) {
          <mat-chip-row (removed)="remove(v)">
            {{ v }}
            <button matChipRemove [attr.aria-label]="'Remove ' + v"><mat-icon>cancel</mat-icon></button>
          </mat-chip-row>
        }
        <input [placeholder]="placeholder()" [matChipInputFor]="grid" [matChipInputSeparatorKeyCodes]="separators"
               matChipInputAddOnBlur (matChipInputTokenEnd)="add($event)" (blur)="onTouched()" />
      </mat-chip-grid>
      @if (hint()) { <mat-hint>{{ hint() }}</mat-hint> }
    </mat-form-field>
    @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
  `,
  styles: `
    .full { width: 100%; }
    .err { color: var(--ml-fail); margin: 0 0 8px; }
  `,
})
export class ChipList implements ControlValueAccessor {
  readonly label = input('Values');
  readonly placeholder = input('');
  readonly hint = input('');
  /** Returns the normalized value, or null when the entry is invalid. */
  readonly normalize = input<(v: string) => string | null>((v) => v.trim() || null);
  readonly invalidMessage = input('Invalid value');

  protected readonly separators = [ENTER, COMMA, SPACE];
  protected readonly value = signal<string[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly disabled = signal(false);

  private onChange: (v: string[]) => void = () => undefined;
  protected onTouched: () => void = () => undefined;

  writeValue(v: string[] | null): void {
    this.value.set(v ? [...v] : []);
    this.error.set(null);
  }
  registerOnChange(fn: (v: string[]) => void): void {
    this.onChange = fn;
  }
  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }
  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  protected add(ev: MatChipInputEvent): void {
    let rejected = false;
    const next = [...this.value()];
    for (const token of ev.value.split(/[\s,;]+/).filter(Boolean)) {
      const n = this.normalize()(token);
      if (n === null) {
        rejected = true;
        break;
      }
      if (!next.includes(n)) next.push(n);
    }
    this.error.set(rejected ? `${this.invalidMessage()}: "${ev.value.trim()}"` : null);
    if (next.length !== this.value().length) this.commit(next);
    if (!rejected) ev.chipInput.clear();
  }

  protected remove(v: string): void {
    this.commit(this.value().filter((x) => x !== v));
  }

  private commit(list: string[]): void {
    this.value.set(list);
    this.onChange(list);
  }
}
