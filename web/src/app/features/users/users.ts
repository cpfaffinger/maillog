import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ApiService } from '../../api/api.service';
import { User, UserInput } from '../../api/models';
import { AuthService } from '../../core/auth.service';
import { Notify } from '../../core/notify.service';
import { TsPipe } from '../../core/pipes';
import { ConfirmDialog } from '../../shared/dialogs';
import { UserDialog } from './user-dialog';

@Component({
  selector: 'app-users',
  imports: [MatButtonModule, MatIconModule, MatTooltipModule, TsPipe],
  template: `
    <div class="page">
      <div class="page-head"><h1>Users</h1><span class="spacer"></span>
        <button mat-flat-button (click)="edit(null)"><mat-icon>person_add</mat-icon> Add user</button>
      </div>
      <div class="table-wrap">
        <table class="ml-table" aria-label="Users">
          <thead><tr><th>Username</th><th>Role</th><th>Sender domains</th><th>Passkeys</th><th>Last login</th><th><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
            @for (u of users(); track u.id) {
              <tr [class.off]="u.disabled">
                <td><b>{{ u.username }}</b>@if (u.displayName) { <div class="muted">{{ u.displayName }}</div> }
                  @if (u.disabled) { <span class="pill fail">disabled</span> }</td>
                <td><span class="pill neutral">{{ u.role }}</span></td>
                <td class="wrap-any">
                  @for (d of u.domains; track d) { <span class="pill neutral dom">{{ '@' + d }}</span> }
                  @if (u.role !== 'viewer') { <span class="muted">all</span> }
                </td>
                <td>{{ u.passkeyCount }}</td>
                <td class="nowrap">{{ u.lastLogin | ts }}</td>
                <td class="actions">
                  <button mat-icon-button (click)="edit(u)" matTooltip="Edit" aria-label="Edit user"><mat-icon>edit</mat-icon></button>
                  <button mat-icon-button (click)="remove(u)" [disabled]="u.id === me()?.id" matTooltip="Delete" aria-label="Delete user"><mat-icon>delete</mat-icon></button>
                </td>
              </tr>
            }
          </tbody>
        </table>
        @if (loaded() && users().length === 0) { <div class="empty">No users.</div> }
      </div>
    </div>
  `,
  styles: `
    .nowrap { white-space: nowrap; }
    .actions { white-space: nowrap; text-align: right; }
    .off { opacity: 0.6; }
    .dom { margin: 0 4px 4px 0; }
  `,
})
export class Users {
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  protected readonly me = inject(AuthService).user;
  protected readonly users = signal<User[]>([]);
  protected readonly loaded = signal(false);

  constructor() {
    void this.load();
  }

  protected edit(u: User | null): void {
    this.dialog.open<UserDialog, User | null, UserInput>(UserDialog, { data: u, width: '520px', maxWidth: '96vw' })
      .afterClosed().subscribe(async (input) => {
        if (!input) return;
        try {
          if (u) await this.api.userUpdate(u.id, input);
          else await this.api.userCreate(input);
          this.notify.info(u ? 'User updated' : 'User created');
          await this.load();
        } catch {
          /* reported by the interceptor */
        }
      });
  }

  protected remove(u: User): void {
    this.dialog.open(ConfirmDialog, {
      data: { title: `Delete user "${u.username}"?`, message: 'Their passkeys and access tokens are deleted as well.', confirm: 'Delete', danger: true },
    }).afterClosed().subscribe(async (yes) => {
      if (!yes) return;
      try {
        await this.api.userDelete(u.id);
        await this.load();
      } catch {
        /* reported by the interceptor */
      }
    });
  }

  private async load(): Promise<void> {
    try {
      this.users.set(await this.api.users());
      this.loaded.set(true);
    } catch {
      /* reported by the interceptor */
    }
  }
}
