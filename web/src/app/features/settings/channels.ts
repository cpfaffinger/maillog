import {
  ChannelKey, Channels, ChannelsInput, ChannelTestBody, SignalChannel, SmtpChannelInput, SmtpSecurity,
  WebhookChannel, WebhookFormat,
} from '../../api/models';

/** Values of the settings form: the API shape plus the write-only password fields. */
export interface SmtpFormValue {
  enabled: boolean;
  host: string;
  port: number;
  security: SmtpSecurity;
  authenticate: boolean;
  username: string;
  password: string;
  clearPassword: boolean;
  from: string;
  fromName: string;
  to: string[];
}

export interface ChannelsFormValue {
  smtp: SmtpFormValue;
  signal: SignalChannel;
  webhook: WebhookChannel;
}

export const SECURITY_PORTS: Record<SmtpSecurity, number> = { none: 25, starttls: 587, ssl: 465 };

export const WEBHOOK_FORMATS: { value: WebhookFormat; label: string }[] = [
  { value: 'json', label: 'Generic JSON' },
  { value: 'slack', label: 'Slack' },
  { value: 'discord', label: 'Discord' },
  { value: 'ntfy', label: 'ntfy' },
];

const EMAIL_RE = /^[^\s@,;<>()[\]\\]+@[^\s@,;<>()[\]\\.]+(\.[^\s@,;<>()[\]\\.]+)+$/;
const PHONE_RE = /^\+[1-9]\d{5,14}$/;
const SIGNAL_GROUP_RE = /^group\.[A-Za-z0-9+/=_-]+$/;

export function isEmail(v: string): boolean {
  return v.length <= 254 && EMAIL_RE.test(v);
}

/** Returns the trimmed address or null when it is not a plausible e-mail address. */
export function normalizeEmail(v: string): string | null {
  const t = v.trim();
  return isEmail(t) ? t : null;
}

/** Signal recipient: international phone number (+43…) or a signal group id. */
export function normalizeSignalRecipient(v: string): string | null {
  const t = v.trim();
  return PHONE_RE.test(t) || SIGNAL_GROUP_RE.test(t) ? t : null;
}

export function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** When the security mode changes, move the port along unless the user entered a custom one. */
export function portAfterSecurityChange(port: number, from: SmtpSecurity, to: SmtpSecurity): number {
  return port === SECURITY_PORTS[from] || !port ? SECURITY_PORTS[to] : port;
}

export function fromChannels(c: Channels): ChannelsFormValue {
  const { passwordSet: _ignored, ...smtp } = c.smtp;
  return {
    smtp: { ...smtp, password: '', clearPassword: false, to: [...c.smtp.to] },
    signal: { ...c.signal, recipients: [...c.signal.recipients] },
    webhook: { ...c.webhook },
  };
}

function smtpBody(v: SmtpFormValue): SmtpChannelInput {
  return {
    enabled: v.enabled,
    host: v.host.trim(),
    port: Number(v.port),
    security: v.security,
    authenticate: v.authenticate,
    username: v.username.trim(),
    from: v.from.trim(),
    fromName: v.fromName.trim(),
    to: v.to.map((a) => a.trim()).filter(Boolean),
  };
}

/** The PUT payload. The password is only sent when typed; clearPassword only when asked and no new password is given. */
export function buildChannelsInput(v: ChannelsFormValue): ChannelsInput {
  const smtp = smtpBody(v.smtp);
  if (v.smtp.password !== '') smtp.password = v.smtp.password;
  else if (v.smtp.clearPassword) smtp.clearPassword = true;
  return {
    smtp,
    signal: {
      enabled: v.signal.enabled,
      url: v.signal.url.trim(),
      number: v.signal.number.trim(),
      recipients: v.signal.recipients.map((r) => r.trim()).filter(Boolean),
    },
    webhook: { enabled: v.webhook.enabled, url: v.webhook.url.trim(), format: v.webhook.format },
  };
}

/** Body for the per-channel test: unsaved values of that channel only; no `enabled`, no `clearPassword`. */
export function buildTestBody(kind: ChannelKey, v: ChannelsFormValue): ChannelTestBody {
  const full = buildChannelsInput(v);
  if (kind === 'smtp') {
    const { enabled: _e, clearPassword: _c, ...rest } = full.smtp;
    return rest;
  }
  const { enabled: _e, ...rest } = full[kind];
  return rest;
}

/** Human readable problems for one channel (empty = fine). Used for Save (only when enabled) and Send test (always). */
export function validateChannel(kind: ChannelKey, v: ChannelsFormValue, passwordSet: boolean): string[] {
  const out: string[] = [];
  if (kind === 'smtp') {
    const s = v.smtp;
    if (!s.host.trim()) out.push('SMTP: server host is required');
    const port = Number(s.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) out.push('SMTP: port must be between 1 and 65535');
    if (!isEmail(s.from.trim())) out.push('SMTP: a valid sender address is required');
    if (s.to.length === 0) out.push('SMTP: add at least one recipient');
    else if (s.to.some((a) => !isEmail(a.trim()))) out.push('SMTP: a recipient address is invalid');
    if (s.authenticate) {
      if (!s.username.trim()) out.push('SMTP: username is required when authentication is on');
      if (!passwordSet && !s.password) out.push('SMTP: password is required when authentication is on');
      if (passwordSet && s.clearPassword && !s.password) out.push('SMTP: enter a new password or keep the stored one');
    }
  } else if (kind === 'signal') {
    const s = v.signal;
    if (!isHttpUrl(s.url.trim())) out.push('Signal: a valid http(s) URL of signal-cli-rest-api is required');
    if (!PHONE_RE.test(s.number.trim())) out.push('Signal: the sender number must look like +4366412345678');
    if (s.recipients.length === 0) out.push('Signal: add at least one recipient');
  } else if (!isHttpUrl(v.webhook.url.trim())) {
    out.push('Webhook: a valid http(s) URL is required');
  }
  return out;
}

/** Problems that block saving: only enabled channels are validated. */
export function validateForSave(v: ChannelsFormValue, passwordSet: boolean): string[] {
  const kinds: ChannelKey[] = ['smtp', 'signal', 'webhook'];
  return kinds.filter((k) => v[k].enabled).flatMap((k) => validateChannel(k, v, passwordSet));
}
