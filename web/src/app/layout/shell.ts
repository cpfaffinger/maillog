import { BreakpointObserver } from '@angular/cdk/layout';
import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatSidenavModule } from '@angular/material/sidenav';
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
  /** Section heading shown above this entry. */
  group?: string;
}

const ALL: Role[] = ['admin', 'operator', 'viewer'];
const STAFF: Role[] = ['admin', 'operator'];

const NAV: NavItem[] = [
  { path: '/overview', label: 'Overview', icon: 'dashboard', roles: STAFF, group: 'Monitor' },
  { path: '/queue', label: 'Queue', icon: 'queue', roles: STAFF },
  { path: '/alerts', label: 'Alerts', icon: 'notifications', roles: STAFF },
  { path: '/messages', label: 'Messages', icon: 'mail', roles: ALL, group: 'Mail' },
  { path: '/trace', label: 'Trace', icon: 'timeline', roles: ALL },
  { path: '/stats', label: 'Statistics', icon: 'bar_chart', roles: ALL, exact: true },
  { path: '/stats/infrastructure', label: 'Infrastructure', icon: 'monitor_heart', roles: STAFF },
  { path: '/agents', label: 'Agents', icon: 'dns', roles: STAFF, group: 'Administration' },
  { path: '/users', label: 'Users', icon: 'group', roles: ['admin'] },
  { path: '/api-keys', label: 'API keys', icon: 'vpn_key', roles: ['admin'] },
  { path: '/settings', label: 'Settings', icon: 'settings', roles: ['admin'] },
];

@Component({
  selector: 'app-shell',
  imports: [
    RouterOutlet, RouterLink, RouterLinkActive, MatSidenavModule, MatIconModule, MatButtonModule, MatMenuModule,
    MatDividerModule, MatTooltipModule,
  ],
  template: `
    <mat-sidenav-container class="shell">
      <mat-sidenav #nav [mode]="narrow() ? 'over' : 'side'" [opened]="!narrow()" class="side"
                   role="navigation" aria-label="Main navigation">
        <div class="brand">
          <span class="logo" aria-hidden="true"><mat-icon>mark_email_read</mat-icon></span>
          <span class="name">maillog<small>mail monitoring</small></span>
        </div>
        <nav class="links">
          @for (item of items(); track item.path) {
            @if (item.group) { <div class="group">{{ item.group }}</div> }
            <a class="link" [routerLink]="item.path" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: !!item.exact }"
               (click)="narrow() && nav.close()">
              <mat-icon aria-hidden="true">{{ item.icon }}</mat-icon>
              <span>{{ item.label }}</span>
            </a>
          }
          <div class="group">Developers</div>
          <a class="link" href="/api/docs" target="_blank" rel="noopener">
            <mat-icon aria-hidden="true">api</mat-icon>
            <span>API docs</span>
            <mat-icon class="ext" aria-hidden="true">open_in_new</mat-icon>
          </a>
        </nav>
        @if (version.text()) { <p class="ver">{{ version.text() }}</p> }
      </mat-sidenav>

      <mat-sidenav-content>
        <header class="bar">
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
          <button class="user" [matMenuTriggerFor]="menu" aria-label="Account menu">
            <span class="avatar" aria-hidden="true">{{ initials() }}</span>
            <span class="who">
              <b>{{ auth.user()?.displayName || auth.user()?.username }}</b>
              <small>{{ auth.user()?.role }}</small>
            </span>
            <mat-icon class="chev" aria-hidden="true">expand_more</mat-icon>
          </button>
          <mat-menu #menu="matMenu" xPosition="before">
            <div class="menu-head">
              <strong>{{ auth.user()?.username }}</strong>
              <span class="muted">{{ auth.user()?.role }}</span>
            </div>
            <mat-divider />
            <a mat-menu-item routerLink="/account"><mat-icon>manage_accounts</mat-icon>Account</a>
            <button mat-menu-item (click)="logout()"><mat-icon>logout</mat-icon>Sign out</button>
          </mat-menu>
        </header>
        <main><router-outlet /></main>
      </mat-sidenav-content>
    </mat-sidenav-container>
  `,
  styles: `
    .shell { height: 100vh; background: var(--mat-sys-surface); }
    .side { width: 252px; border-right: 1px solid var(--mat-sys-outline-variant); }
    .brand { display: flex; align-items: center; gap: 12px; padding: 22px 20px 14px; }
    .logo { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 12px; color: #fff; flex: none;
            background: linear-gradient(135deg, #2f7cf6, #7c4dff);
            box-shadow: 0 4px 12px rgb(79 100 246 / 0.4); }
    .logo mat-icon { font-size: 22px; width: 22px; height: 22px; }
    .name { display: flex; flex-direction: column; font-size: 1.15rem; font-weight: 700; letter-spacing: -0.02em; line-height: 1.15; }
    .name small { font-size: 0.7rem; font-weight: 500; letter-spacing: 0.02em; color: var(--ml-muted); }

    .links { display: flex; flex-direction: column; gap: 2px; padding: 4px 12px 56px; }
    .group { padding: 16px 10px 6px; font-size: 0.68rem; font-weight: 650; letter-spacing: 0.09em; text-transform: uppercase; color: var(--ml-muted); }
    .link { position: relative; display: flex; align-items: center; gap: 12px; padding: 8px 10px; border-radius: 10px;
            color: var(--mat-sys-on-surface-variant); text-decoration: none; font-weight: 500; transition: background-color 0.12s, color 0.12s; }
    .link mat-icon { font-size: 20px; width: 20px; height: 20px; opacity: 0.85; }
    .link .ext { margin-left: auto; font-size: 15px; width: 15px; height: 15px; opacity: 0.5; }
    .link:hover { background: var(--mat-sys-surface-container); color: var(--mat-sys-on-surface); }
    .link:focus-visible { outline: 2px solid var(--mat-sys-primary); outline-offset: -2px; }
    .link.active { background: color-mix(in srgb, var(--mat-sys-primary) 13%, transparent); color: var(--mat-sys-primary); font-weight: 600; }
    .link.active mat-icon { opacity: 1; }
    .link.active::before { content: ''; position: absolute; left: -12px; top: 8px; bottom: 8px; width: 3px; border-radius: 0 3px 3px 0; background: var(--mat-sys-primary); }
    .ver { position: absolute; bottom: 0; left: 0; right: 0; margin: 0; padding: 12px 20px 14px; font-size: 0.72rem; color: var(--ml-muted);
           background: var(--mat-sys-surface-container-low); border-top: 1px solid var(--mat-sys-outline-variant); }

    .bar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 8px; height: 60px; padding: 0 24px;
           background: color-mix(in srgb, var(--mat-sys-surface) 82%, transparent); backdrop-filter: blur(10px);
           border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .user { display: flex; align-items: center; gap: 10px; padding: 4px 8px 4px 4px; border: 0; border-radius: 999px; cursor: pointer;
            background: transparent; color: inherit; font: inherit; transition: background-color 0.12s; }
    .user:hover { background: var(--mat-sys-surface-container); }
    .user:focus-visible { outline: 2px solid var(--mat-sys-primary); }
    .avatar { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; font-size: 0.8rem; font-weight: 650;
              color: var(--mat-sys-primary); background: color-mix(in srgb, var(--mat-sys-primary) 16%, transparent);
              box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--mat-sys-primary) 28%, transparent); }
    .who { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.2; max-width: 18ch; }
    .who b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
    .who small { color: var(--ml-muted); font-size: 0.72rem; text-transform: capitalize; }
    .chev { color: var(--ml-muted); }
    .menu-head { display: flex; flex-direction: column; padding: 8px 16px; }
    @media (max-width: 720px) { .who, .chev { display: none; } .bar { padding: 0 12px; } }
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

  protected readonly initials = computed(() => {
    const u = this.auth.user();
    const name = (u?.displayName || u?.username || '?').trim();
    const parts = name.split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
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
