import { Routes } from '@angular/router';
import { homeGuard, roleGuard } from './core/guards';

const staff = roleGuard('admin', 'operator');
const admin = roleGuard('admin');

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/login/login').then((m) => m.Login),
    title: 'Sign in · maillog',
  },
  {
    path: '',
    canActivate: [roleGuard()],
    loadComponent: () => import('./layout/shell').then((m) => m.Shell),
    children: [
      { path: '', pathMatch: 'full', canActivate: [homeGuard], children: [] },
      {
        path: 'overview',
        canActivate: [staff],
        title: 'Overview · maillog',
        loadComponent: () => import('./features/overview/overview').then((m) => m.Overview),
      },
      {
        path: 'queue',
        canActivate: [staff],
        title: 'Queue · maillog',
        loadComponent: () => import('./features/queue/queue').then((m) => m.QueuePage),
      },
      {
        path: 'messages',
        title: 'Messages · maillog',
        loadComponent: () => import('./features/messages/messages').then((m) => m.Messages),
      },
      {
        path: 'trace',
        title: 'Trace · maillog',
        loadComponent: () => import('./features/trace/trace').then((m) => m.Trace),
      },
      {
        path: 'stats',
        title: 'Statistics · maillog',
        loadComponent: () => import('./features/stats/stats').then((m) => m.Stats),
      },
      {
        path: 'alerts',
        canActivate: [staff],
        title: 'Alerts · maillog',
        loadComponent: () => import('./features/alerts/alerts').then((m) => m.Alerts),
      },
      {
        path: 'agents',
        canActivate: [staff],
        title: 'Agents · maillog',
        loadComponent: () => import('./features/agents/agents').then((m) => m.Agents),
      },
      {
        path: 'users',
        canActivate: [admin],
        title: 'Users · maillog',
        loadComponent: () => import('./features/users/users').then((m) => m.Users),
      },
      {
        path: 'account',
        title: 'Account · maillog',
        loadComponent: () => import('./features/account/account').then((m) => m.Account),
      },
      {
        path: 'settings',
        canActivate: [admin],
        title: 'Settings · maillog',
        loadComponent: () => import('./features/settings/settings').then((m) => m.SettingsPage),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
