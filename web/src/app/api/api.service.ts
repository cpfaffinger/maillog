import { HttpClient, HttpContext, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { SILENT } from '../core/http';
import {
  AccessToken, ActionItem, Agent, AgentConfigInput, AgentCreated, Alert, AppSettings, ChannelKey, Channels,
  ChannelsInput, ChannelTestBody, Enrollment,
  EventQuery, EventsPage, HealthHistoryItem, Overview, Passkey, QueueResult, StatsResult, StatsSummary,
  TestNotificationResult, TokenCreated, TraceResult, User, UserInput, VersionInfo, WebAuthnRequest,
} from './models';

const BASE = '/api/v1';

type Query = Record<string, string | number | boolean | undefined | null>;

function params(q?: Query): HttpParams {
  let p = new HttpParams();
  for (const [k, v] of Object.entries(q ?? {})) {
    if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
  }
  return p;
}

/** Single typed gateway to the maillog user API (docs/API.md). */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  private get<T>(path: string, q?: Query, silent = false): Promise<T> {
    return firstValueFrom(this.http.get<T>(BASE + path, { params: params(q), context: ctx(silent) }));
  }
  private post<T>(path: string, body?: unknown, silent = false): Promise<T> {
    return firstValueFrom(this.http.post<T>(BASE + path, body ?? {}, { context: ctx(silent) }));
  }
  private put<T>(path: string, body: unknown): Promise<T> {
    return firstValueFrom(this.http.put<T>(BASE + path, body));
  }
  private del(path: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(BASE + path));
  }

  /** Anonymous; used by the login page and the sidenav footer. */
  version() {
    return this.get<VersionInfo>('/version', undefined, true);
  }

  // auth
  login(username: string, password: string) {
    return this.post<{ user: User }>('/auth/login', { username, password }, true);
  }
  logout() {
    return this.post<void>('/auth/logout', undefined, true).catch(() => undefined);
  }
  passkeyLoginOptions() {
    return this.get<WebAuthnRequest>('/auth/passkey/login/options', undefined, true);
  }
  passkeyLogin(requestId: string, credential: unknown) {
    return this.post<{ user: User }>('/auth/passkey/login', { requestId, credential }, true);
  }

  // account
  me() {
    return this.get<User>('/me', undefined, true);
  }
  changePassword(currentPassword: string, newPassword: string) {
    return this.post<void>('/me/password', { currentPassword, newPassword });
  }
  passkeys() {
    return this.get<Passkey[]>('/me/passkeys');
  }
  passkeyCreateOptions() {
    return this.post<WebAuthnRequest>('/me/passkeys/options');
  }
  passkeyAdd(requestId: string, name: string, credential: unknown) {
    return this.post<Passkey>('/me/passkeys', { requestId, name, credential });
  }
  passkeyDelete(id: string) {
    return this.del(`/me/passkeys/${encodeURIComponent(id)}`);
  }
  tokens() {
    return this.get<AccessToken[]>('/me/tokens');
  }
  tokenCreate(name: string, readOnly: boolean, expiresInDays?: number) {
    return this.post<TokenCreated>('/me/tokens', { name, readOnly, expiresInDays });
  }
  tokenDelete(id: string) {
    return this.del(`/me/tokens/${encodeURIComponent(id)}`);
  }

  // users
  users() {
    return this.get<User[]>('/users');
  }
  userCreate(u: UserInput) {
    return this.post<User>('/users', u);
  }
  userUpdate(id: string, u: UserInput) {
    return this.put<User>(`/users/${encodeURIComponent(id)}`, u);
  }
  userDelete(id: string) {
    return this.del(`/users/${encodeURIComponent(id)}`);
  }

  // data
  events(q: EventQuery) {
    return this.get<EventsPage>('/events', { ...q });
  }
  trace(q: string) {
    return this.get<TraceResult>('/trace', { q });
  }
  stats(hours: number) {
    return this.get<StatsResult>('/stats', { hours });
  }
  statsSummary(days: number, tz: number) {
    return this.get<StatsSummary>('/stats/summary', { days, tz });
  }
  overview() {
    return this.get<Overview>('/overview');
  }
  queue(hours: number) {
    return this.get<QueueResult>('/queue', { hours });
  }
  alerts(state: 'open' | 'all', limit = 200) {
    return this.get<Alert[]>('/alerts', { state, limit });
  }
  healthHistory(limit = 200, agent?: string) {
    return this.get<HealthHistoryItem[]>('/health/history', { limit, agent });
  }
  actions(limit = 100) {
    return this.get<ActionItem[]>('/actions', { limit });
  }

  // agents
  agents() {
    return this.get<Agent[]>('/agents');
  }
  agentCreate(name: string, role: string) {
    return this.post<AgentCreated>('/agents', { name, role });
  }
  agentEnroll(id: string) {
    return this.post<Enrollment>(`/agents/${encodeURIComponent(id)}/enroll`);
  }
  agentConfig(id: string, cfg: AgentConfigInput) {
    return this.put<Agent>(`/agents/${encodeURIComponent(id)}/config`, cfg);
  }
  agentDelete(id: string) {
    return this.del(`/agents/${encodeURIComponent(id)}`);
  }

  // settings
  settings() {
    return this.get<AppSettings>('/settings');
  }
  settingsSave(retentionDays: number) {
    return this.put<AppSettings>('/settings', { retentionDays });
  }
  channels() {
    return this.get<Channels>('/settings/channels');
  }
  channelsSave(input: ChannelsInput) {
    return this.put<Channels>('/settings/channels', input);
  }
  channelTest(kind: ChannelKey, body?: ChannelTestBody) {
    return this.post<TestNotificationResult>(`/settings/channels/${kind}/test`, body ?? {});
  }
  testNotification() {
    return this.post<TestNotificationResult>('/settings/test-notification');
  }
}

function ctx(silent: boolean): HttpContext {
  return silent ? new HttpContext().set(SILENT, true) : new HttpContext();
}
