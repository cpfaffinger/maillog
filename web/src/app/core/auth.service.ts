import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiService } from '../api/api.service';
import { Role, User } from '../api/models';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(ApiService);
  private loading?: Promise<User | null>;

  readonly user = signal<User | null>(null);
  readonly role = computed<Role | null>(() => this.user()?.role ?? null);
  readonly isAdmin = computed(() => this.role() === 'admin');
  /** operator or admin: may see infrastructure data. */
  readonly isOperator = computed(() => this.role() === 'admin' || this.role() === 'operator');

  /** Loads /me once; resolves to null when not signed in. */
  ensureLoaded(): Promise<User | null> {
    this.loading ??= this.api
      .me()
      .then((u) => {
        this.user.set(u);
        return u;
      })
      .catch(() => null);
    return this.loading;
  }

  setUser(u: User): void {
    this.user.set(u);
    this.loading = Promise.resolve(u);
  }

  clear(): void {
    this.user.set(null);
    this.loading = undefined;
  }

  async refresh(): Promise<void> {
    this.loading = undefined;
    await this.ensureLoaded();
  }

  static homeFor(role: Role | null | undefined): string {
    return role === 'viewer' ? '/messages' : '/overview';
  }
}
