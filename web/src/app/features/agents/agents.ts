import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ApiService } from '../../api/api.service';
import { Agent } from '../../api/models';
import { AuthService } from '../../core/auth.service';
import { Notify } from '../../core/notify.service';
import { AgoPipe, TsPipe } from '../../core/pipes';
import { polling } from '../../core/util';
import { ConfirmDialog, SecretDialog } from '../../shared/dialogs';
import { AddAgentDialog, AddAgentResult, ConfigDialog } from './agent-dialogs';

@Component({
  selector: 'app-agents',
  imports: [MatButtonModule, MatIconModule, MatTooltipModule, AgoPipe, TsPipe],
  template: `
    <div class="page">
      <div class="page-head"><h1>Agents</h1><span class="spacer"></span>
        @if (admin()) {
          <button mat-flat-button (click)="add()"><mat-icon>add</mat-icon> Add agent</button>
        }
      </div>

      <div class="table-wrap">
        <table class="ml-table" aria-label="Agents">
          <thead><tr><th>Name</th><th>Role</th><th>Host</th><th>Status</th><th>Enrollment</th><th><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
            @for (a of agents(); track a.id) {
              <tr>
                <td><b>{{ a.name }}</b></td>
                <td><span class="pill neutral">{{ a.role }}</span></td>
                <td class="wrap-any">{{ a.hostname || '–' }}<div class="muted small">agent {{ a.version || '–' }} · {{ a.lastIp || '–' }}</div></td>
                <td><span class="dot {{ online(a) ? 'ok' : a.lastSeen ? 'fail' : '' }}"></span>
                  {{ a.lastSeen ? (online(a) ? 'online' : 'offline') : 'never seen' }}
                  <div class="muted small">{{ a.lastSeen | ago }}</div></td>
                <td>
                  @if (a.pendingEnrollment) {
                    <span class="pill warn">pending</span>
                    <div class="muted small">expires {{ a.enrollExpires | ts }}</div>
                  } @else { <span class="pill ok">enrolled</span><div class="muted small">{{ a.enrolledAt | ts }}</div> }
                </td>
                <td class="actions">
                  @if (admin()) {
                    <button mat-icon-button (click)="reenroll(a)" matTooltip="New enrollment command" aria-label="New enrollment command"><mat-icon>key</mat-icon></button>
                    <button mat-icon-button (click)="config(a)" matTooltip="Edit configuration" aria-label="Edit configuration"><mat-icon>tune</mat-icon></button>
                    <button mat-icon-button (click)="remove(a)" matTooltip="Delete" aria-label="Delete agent"><mat-icon>delete</mat-icon></button>
                  } @else {
                    <button mat-icon-button (click)="view(a)" matTooltip="View configuration" aria-label="View configuration"><mat-icon>visibility</mat-icon></button>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
        @if (loaded() && agents().length === 0) { <div class="empty">No agents yet.</div> }
      </div>
    </div>
  `,
  styles: `
    .small { font-size: 0.85em; }
    .actions { white-space: nowrap; text-align: right; }
  `,
})
export class Agents {
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  protected readonly admin = inject(AuthService).isAdmin;
  protected readonly agents = signal<Agent[]>([]);
  protected readonly loaded = signal(false);

  constructor() {
    polling(() => this.load(), 20_000);
  }

  protected online(a: Agent): boolean {
    return a.lastSeen !== null && Date.now() - a.lastSeen < Math.max(180, a.intervalS * 4) * 1000;
  }

  protected add(): void {
    this.dialog.open<AddAgentDialog, void, AddAgentResult>(AddAgentDialog, { width: '480px', maxWidth: '96vw' })
      .afterClosed().subscribe(async (r) => {
        if (!r) return;
        try {
          const created = await this.api.agentCreate(r.name, r.role);
          this.showCommand(created.installCommand, created.expiresAt, `Agent "${created.agent.name}" created`);
          await this.load();
        } catch {
          /* reported by the interceptor */
        }
      });
  }

  protected async reenroll(a: Agent): Promise<void> {
    try {
      const e = await this.api.agentEnroll(a.id);
      this.showCommand(e.installCommand, e.expiresAt, `New enrollment for "${a.name}"`);
      await this.load();
    } catch {
      /* reported by the interceptor */
    }
  }

  protected config(a: Agent): void {
    this.dialog.open(ConfigDialog, { data: { agent: a, readonly: false }, width: '720px', maxWidth: '96vw' })
      .afterClosed().subscribe(async (cfg) => {
        if (!cfg) return;
        try {
          await this.api.agentConfig(a.id, cfg);
          this.notify.info('Configuration saved; the agent picks it up with its next report');
          await this.load();
        } catch {
          /* reported by the interceptor */
        }
      });
  }

  protected view(a: Agent): void {
    this.dialog.open(ConfigDialog, { data: { agent: a, readonly: true }, width: '720px', maxWidth: '96vw' });
  }

  protected remove(a: Agent): void {
    this.dialog.open(ConfirmDialog, {
      data: {
        title: `Delete agent "${a.name}"?`,
        message: 'The agent is removed from maillog and its token stops working. Collected events are kept until retention removes them.',
        confirm: 'Delete', danger: true,
      },
    }).afterClosed().subscribe(async (yes) => {
      if (!yes) return;
      try {
        await this.api.agentDelete(a.id);
        await this.load();
      } catch {
        /* reported by the interceptor */
      }
    });
  }

  private showCommand(command: string, expiresAt: number, title: string): void {
    this.dialog.open(SecretDialog, {
      width: '640px', maxWidth: '96vw',
      data: {
        title,
        intro: 'Run this command as root on the mail server. It installs the agent and enrolls it with a single-use token.',
        secret: command, secretLabel: 'install command',
        warning: `The enrollment token expires ${new Date(expiresAt).toLocaleString()} and can be used once.`,
      },
    });
  }

  private async load(): Promise<void> {
    try {
      this.agents.set(await this.api.agents());
      this.loaded.set(true);
    } catch {
      /* reported by the interceptor */
    }
  }
}
