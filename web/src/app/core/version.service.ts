import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiService } from '../api/api.service';
import { VersionInfo } from '../api/models';
import { formatVersion } from './util';

/** Fetches the build version once; failures are ignored (the footer simply stays empty). */
@Injectable({ providedIn: 'root' })
export class VersionService {
  private readonly api = inject(ApiService);
  private started = false;

  readonly info = signal<VersionInfo | null>(null);
  readonly text = computed(() => {
    const i = this.info();
    return i ? formatVersion(i) : '';
  });

  load(): void {
    if (this.started) return;
    this.started = true;
    this.api.version().then((v) => this.info.set(v)).catch(() => undefined);
  }
}
