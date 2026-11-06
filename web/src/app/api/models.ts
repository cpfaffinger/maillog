// Types mirroring docs/API.md. Timestamps are Unix epoch milliseconds (UTC).

export type Role = 'admin' | 'operator' | 'viewer';
export type HealthState = 'ok' | 'warn' | 'fail';
export type Severity = 'critical' | 'warning' | 'info';
export type AgentRole = 'relay' | 'outbound' | 'inbound' | 'generic';

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  domains: string[];
  disabled: boolean;
  createdAt: number;
  lastLogin: number | null;
  mustChangePassword: boolean;
  passkeyCount: number;
}

export interface UserInput {
  username?: string;
  displayName: string;
  role: Role;
  domains: string[];
  disabled?: boolean;
  password?: string;
}

export interface HealthCheck {
  name: string;
  state: HealthState;
  message: string | null;
  since: number;
  updated: number;
}

export type EventKind =
  | 'queued' | 'delivery' | 'accepted' | 'reject' | 'auth_fail' | 'ratelimit' | 'connect'
  | 'disconnect' | 'conn_error' | 'foreign_sender' | 'dkim_signed' | 'ban' | 'unban'
  | 'f2b_found' | 'sasl_authd_fail' | 'error' | 'service' | 'meta' | 'info';

export interface MailEvent {
  id: number;
  agentId: string | null;
  agentName: string | null;
  agentRole: AgentRole | null;
  ts: number;
  source: string | null;
  program: string | null;
  queueId: string | null;
  kind: EventKind | string;
  sender: string | null;
  recipient: string | null;
  clientIp: string | null;
  clientHost: string | null;
  saslUser: string | null;
  relay: string | null;
  status: string | null;
  dsn: string | null;
  nextQueueId: string | null;
  delayS: number | null;
  detail: string | null;
  raw: string | null;
}

export interface EventsPage {
  items: MailEvent[];
  nextBefore: number | null;
}

export interface EventQuery {
  agent?: string;
  kind?: string;
  q?: string;
  from?: number;
  to?: number;
  before?: number;
  limit?: number;
  all?: boolean;
}

export interface TraceResult {
  events: MailEvent[];
}

export interface StatRow {
  agentId: string | null;
  hour: number;
  sent: number;
  deferred: number;
  bounced: number;
  rejected: number;
  authFail: number;
  rateLimit: number;
}

export interface StatsResult {
  hours: number;
  rows: StatRow[];
}

export interface Counter {
  sent: number;
  deferred: number;
  bounced: number;
  rejected: number;
  authFail: number;
  rateLimit: number;
}

export interface NamedCount {
  name: string;
  count: number;
}

export interface QueueSnapshot {
  ts: number;
  total: number;
  active: number;
  deferred: number;
  hold: number;
  incoming: number;
  oldestAgeS: number;
  /** Oldest message in the active/incoming queue (mail that should be moving). */
  oldestActiveAgeS?: number | null;
  topSenderDomains: NamedCount[];
  topRecipientDomains: NamedCount[];
  topReasons: NamedCount[];
}

export interface OverviewAgent {
  id: string;
  name: string;
  role: AgentRole;
  hostname: string | null;
  version: string | null;
  lastSeen: number | null;
  enrolledAt: number | null;
  pendingEnrollment: boolean;
  checks: HealthCheck[];
  stats24h: Counter;
  queue: QueueSnapshot | null;
}

export interface Alert {
  id: number;
  key: string;
  agentId: string | null;
  agentName: string | null;
  severity: Severity;
  title: string;
  body: string | null;
  openedAt: number;
  resolvedAt: number | null;
}

export interface Overview {
  now: number;
  offlineAfterS: number;
  agents: OverviewAgent[];
  alerts: Alert[];
}

export interface QueuePoint {
  ts: number;
  total: number;
  deferred: number;
  oldestAgeS: number;
}

export interface QueueAgent {
  id: string;
  name: string;
  role: AgentRole;
  current: QueueSnapshot | null;
  series: QueuePoint[];
}

export interface QueueResult {
  agents: QueueAgent[];
}

export interface HealthHistoryItem {
  agentId: string;
  agentName: string | null;
  name: string;
  state: HealthState;
  message: string | null;
  ts: number;
}

export interface ActionItem {
  id: number;
  agentId: string;
  agentName: string | null;
  ts: number;
  name: string;
  action: string;
  ok: boolean;
  result: string | null;
}

export interface AgentCheck {
  name: string;
  type: string;
  [key: string]: unknown;
}

export interface AgentLog {
  path: string;
  source: string;
}

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  hostname: string | null;
  version: string | null;
  lastSeen: number | null;
  lastIp: string | null;
  createdAt: number;
  enrolledAt: number | null;
  enrollExpires: number | null;
  pendingEnrollment: boolean;
  intervalS: number;
  checks: AgentCheck[];
  logs: AgentLog[];
}

export interface AgentCreated {
  agent: Agent;
  enrollToken: string;
  installCommand: string;
  expiresAt: number;
}

export interface Enrollment {
  enrollToken: string;
  installCommand: string;
  expiresAt: number;
}

export interface AgentConfigInput {
  intervalS: number;
  checks: AgentCheck[];
  logs: AgentLog[];
}

export interface Passkey {
  id: string;
  name: string;
  createdAt: number;
  lastUsed: number | null;
}

export interface AccessToken {
  id: string;
  name: string;
  prefix: string;
  readOnly: boolean;
  createdAt: number;
  expiresAt: number | null;
  lastUsed: number | null;
}

export interface TokenCreated {
  token: string;
  item: AccessToken;
}

export interface WebAuthnRequest {
  requestId: string;
  options: Record<string, unknown>;
}

export interface AppSettings {
  retentionDays: number;
  eventCount: number;
  oldestEventTs: number | null;
  channels: { webhook: boolean; signal: boolean; smtp: boolean };
  publicUrl: string | null;
  passkeysAvailable: boolean;
}

export interface TestNotificationResult {
  ok: boolean;
  errors: string[];
}
