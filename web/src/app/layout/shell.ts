import { BreakpointObserver } from '@angular/cdk/layout';
import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatMenuModule } from '@angular/material/menu';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { map } from 'rxjs';
import { ApiService } from '../api/api.service';
import { Role } from '../api/models';
import { AuthService } from '../core/auth.service';
import { ThemeService } from '../core/theme.service';
import { VersionService } from '../core/version.service';

interface NavItem {
  path: string;
  label: string;
  icon: string;
  roles: Role[];
  /** Highlight only on an exact URL match (parent of another entry). */
  exact?: boolean;
}

const ALL: Role[] = ['admin', 'operator', 'viewer'];
const STAFF: Role[] = ['admin', 'operator'];

const NAV: NavItem[] = [
  { path: '/overview', label: 'Overview', icon: 'dashboard', roles: STAFF },
  { path: '/queue', label: 'Queue', icon: 'queue', roles: STAFF },
  { path: '/messages', label: 'Messages', icon: 'mail', roles: ALL },
  { path: '/trace', label: 'Trace', icon: 'timeline', roles: ALL },
  { path: '/stats', label: 'Statistics', icon: 'bar_chart', roles: ALL, exact: true },
  { path: '/stats/infrastructure', label: 'Infrastructure', icon: 'monitor_heart', roles: STAFF },
  { path: '/alerts', label: 'Alerts', icon: 'notifications', roles: STAFF },
  { path: '/agents', label: 'Agents', icon: 'dns', roles: STAFF },
  { path: '/users', label: 'Users', icon: 'group', roles: ['admin'] },
  { path: '/api-keys', label: 'API keys', icon: 'vpn_key', roles: ['admin'] },
  { path: '/settings', label: 'Settings', icon: 'settings', roles: ['admin'] },
];

@Component({
  selector: 'app-shell',
  imports: [
    RouterOutlet, RouterLink, RouterLinkActive, MatSidenavModule, MatToolbarModule, MatListModule,
    MatIconModule, MatButtonModule, MatMenuModule, MatDividerModule, MatTooltipModule,
  ],
  template: `
    <mat-sidenav-container class="shell">
      <mat-sidenav #nav [mode]="narrow() ? 'over' : 'side'" [opened]="!narrow()" class="side"
                   role="navigation" aria-label="Main navigation">
        <div class="brand"><mat-icon aria-hidden="true">mark_email_read</mat-icon> maillog</div>
        <mat-nav-list>
          @for (item of items(); track item.path) {
            <a mat-list-item [routerLink]="item.path" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: !!item.exact }"
               [activated]="false" (click)="narrow() && nav.close()">
              <mat-icon matListItemIcon aria-hidden="true">{{ item.icon }}</mat-icon>
              <span matListItemTitle>{{ item.label }}</span>
            </a>
          }
          <a mat-list-item href="/api/docs" target="_blank" rel="noopener">
            <mat-icon matListItemIcon aria-hidden="true">api</mat-icon>
            <span matListItemTitle>API docs</span>
          </a>
        </mat-nav-list>
        @if (version.text()) { <p class="ver muted">{{ version.text() }}</p> }
      </mat-sidenav>

      <mat-sidenav-content>
        <mat-toolbar class="bar">
          @if (narrow()) {
            <button mat-icon-button (click)="nav.toggle()" aria-label="Toggle navigation">
              <mat-icon>menu</mat-icon>
            </button>
          }
          <span class="spacer"></span>
          <button mat-icon-button (click)="theme.cycle()" [matTooltip]="'Theme: ' + theme.mode()"
                  [attr.aria-label]="'Theme: ' + theme.mode() + ' (click to change)'">
            <mat-icon>{{ themeIcon() }}</mat-icon>
          </button>
          <button mat-button [matMenuTriggerFor]="menu" aria-label="Account menu">
            <mat-icon>account_circle</mat-icon>
            <span class="who">{{ auth.user()?.displayName || auth.user()?.username }}</span>
          </button>
          <mat-menu #menu="matMenu">
            <div class="menu-head">
              <strong>{{ auth.user()?.username }}</strong>
              <span class="muted">{{ auth.user()?.role }}</span>
            </div>
            <mat-divider />
            <a mat-menu-item routerLink="/account"><mat-icon>manage_accounts</mat-icon>Account</a>
            <button mat-menu-item (click)="logout()"><mat-icon>logout</mat-icon>Sign out</button>
          </mat-menu>
        </mat-toolbar>
        <main><router-outlet /></main>
      </mat-sidenav-content>
    </mat-sidenav-container>
  `,
  styles: `
    .shell { height: 100vh; }
    .ver { position: absolute; bottom: 8px; left: 16px; margin: 0; font-size: 0.75em; }
    .side { width: 240px; }
    .brand { display: flex; align-items: center; gap: 8px; padding: 20px 16px 8px;
             font: var(--mat-sys-title-large); }
    .bar { position: sticky; top: 0; z-index: 2; background: var(--mat-sys-surface-container); }
    .who { max-width: 14ch; overflow: hidden; text-overflow: ellipsis; margin-left: 6px; }
    .menu-head { display: flex; flex-direction: column; padding: 8px 16px; }
    a.active { background: var(--mat-sys-secondary-container); }
    @media (max-width: 600px) { .who { display: none; } }
  `,
})
export class Shell {
  protected readonly auth = inject(AuthService);
  protected readonly theme = inject(ThemeService);
  protected readonly version = inject(VersionService);
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);

  constructor() {
    this.version.load();
  }

  protected readonly narrow = toSignal(
    inject(BreakpointObserver).observe('(max-width: 959.98px)').pipe(map((r) => r.matches)),
    { initialValue: false },
  );

  protected readonly items = computed(() => {
    const role = this.auth.role();
    return role ? NAV.filter((n) => n.roles.includes(role)) : [];
  });

  protected themeIcon(): string {
    const m = this.theme.mode();
    return m === 'light' ? 'light_mode' : m === 'dark' ? 'dark_mode' : 'brightness_auto';
  }

  protected async logout(): Promise<void> {
    await this.api.logout();
    this.auth.clear();
    await this.router.navigate(['/login']);
  }
}
