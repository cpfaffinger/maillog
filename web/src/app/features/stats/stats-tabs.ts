import { Component } from '@angular/core';
import { MatTabsModule } from '@angular/material/tabs';
import { RouterLink, RouterLinkActive } from '@angular/router';

/** Sub navigation between the two statistics pages (shown to operators and admins only). */
@Component({
  selector: 'app-stats-tabs',
  imports: [MatTabsModule, RouterLink, RouterLinkActive],
  template: `
    <nav mat-tab-nav-bar [tabPanel]="panel" aria-label="Statistics sections" mat-stretch-tabs="false">
      <a mat-tab-link routerLink="/stats" routerLinkActive #a="routerLinkActive" [routerLinkActiveOptions]="{ exact: true }" [active]="a.isActive">Mail statistics</a>
      <a mat-tab-link routerLink="/stats/infrastructure" routerLinkActive #b="routerLinkActive" [active]="b.isActive">Infrastructure</a>
    </nav>
    <mat-tab-nav-panel #panel />
  `,
})
export class StatsTabs {}
