import { Injectable, signal } from '@angular/core';

export type ThemeMode = 'system' | 'light' | 'dark';
const KEY = 'maillog.theme';

/** Light/dark follows the OS unless the user picks one; the preference lives only in this browser. */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly mode = signal<ThemeMode>('system');

  constructor() {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === 'light' || saved === 'dark' || saved === 'system') this.mode.set(saved);
    } catch {
      /* storage unavailable: keep default */
    }
    this.apply();
  }

  cycle(): void {
    const next: Record<ThemeMode, ThemeMode> = { system: 'light', light: 'dark', dark: 'system' };
    this.mode.set(next[this.mode()]);
    try {
      localStorage.setItem(KEY, this.mode());
    } catch {
      /* ignore */
    }
    this.apply();
  }

  private apply(): void {
    const m = this.mode();
    document.documentElement.style.colorScheme = m === 'system' ? 'light dark' : m;
  }
}
