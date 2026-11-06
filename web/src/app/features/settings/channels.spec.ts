import { Channels } from '../../api/models';
import {
  buildChannelsInput, buildTestBody, ChannelsFormValue, fromChannels, isEmail, normalizeEmail,
  normalizeSignalRecipient, portAfterSecurityChange, validateChannel, validateForSave,
} from './channels';

const stored: Channels = {
  smtp: {
    enabled: true, host: ' smtp.example.com ', port: 587, security: 'starttls', authenticate: true, username: 'u',
    passwordSet: true, from: 'maillog@example.com', fromName: 'maillog', to: ['ops@example.com'],
  },
  signal: { enabled: false, url: '', number: '', recipients: [] },
  webhook: { enabled: false, url: '', format: 'json' },
};

function form(patch: Partial<ChannelsFormValue['smtp']> = {}): ChannelsFormValue {
  const v = fromChannels(stored);
  return { ...v, smtp: { ...v.smtp, ...patch } };
}

describe('buildChannelsInput', () => {
  it('omits password and clearPassword when nothing was typed', () => {
    const smtp = buildChannelsInput(form()).smtp;
    expect('password' in smtp).toBe(false);
    expect('clearPassword' in smtp).toBe(false);
    expect('passwordSet' in smtp).toBe(false);
    expect(smtp.host).toBe('smtp.example.com');
  });

  it('sends a typed password and ignores clearPassword in that case', () => {
    const smtp = buildChannelsInput(form({ password: 's3cret', clearPassword: true })).smtp;
    expect(smtp.password).toBe('s3cret');
    expect('clearPassword' in smtp).toBe(false);
  });

  it('sends clearPassword only when asked and no new password is given', () => {
    const smtp = buildChannelsInput(form({ clearPassword: true })).smtp;
    expect(smtp.clearPassword).toBe(true);
    expect('password' in smtp).toBe(false);
  });

  it('converts the port to a number and trims lists', () => {
    const smtp = buildChannelsInput(form({ port: '465' as unknown as number, to: [' a@b.at ', ''] })).smtp;
    expect(smtp.port).toBe(465);
    expect(smtp.to).toEqual(['a@b.at']);
  });
});

describe('buildTestBody', () => {
  it('contains the unsaved smtp values without enabled/clearPassword and only a typed password', () => {
    const none = buildTestBody('smtp', form({ clearPassword: true })) as Record<string, unknown>;
    expect('enabled' in none).toBe(false);
    expect('clearPassword' in none).toBe(false);
    expect('password' in none).toBe(false);
    expect(none['host']).toBe('smtp.example.com');
    const typed = buildTestBody('smtp', form({ password: 'pw' })) as Record<string, unknown>;
    expect(typed['password']).toBe('pw');
  });

  it('builds bodies for the other channels', () => {
    const v = form();
    v.webhook = { enabled: true, url: ' https://h.example.com/x ', format: 'slack' };
    expect(buildTestBody('webhook', v)).toEqual({ url: 'https://h.example.com/x', format: 'slack' });
  });
});

describe('validation', () => {
  it('validates e-mail addresses', () => {
    expect(isEmail('ops@example.com')).toBe(true);
    expect(normalizeEmail('  a.b+c@mail.example.co.uk ')).toBe('a.b+c@mail.example.co.uk');
    for (const bad of ['', 'nope', 'a@b', 'a b@c.de', '@c.de', 'a@@c.de', 'a@c..de']) {
      expect(normalizeEmail(bad)).toBeNull();
    }
  });

  it('validates signal recipients', () => {
    expect(normalizeSignalRecipient('+4366412345678')).toBe('+4366412345678');
    expect(normalizeSignalRecipient('group.abc123=')).toBe('group.abc123=');
    expect(normalizeSignalRecipient('066412345678')).toBeNull();
  });

  it('reports smtp problems and accepts a complete config', () => {
    expect(validateChannel('smtp', form(), true)).toEqual([]);
    const empty = form({ host: '', from: 'x', to: [], username: '' });
    expect(validateChannel('smtp', empty, true).length).toBeGreaterThanOrEqual(4);
    expect(validateChannel('smtp', form({ password: '' }), false)).toContain('SMTP: password is required when authentication is on');
    expect(validateChannel('smtp', form({ authenticate: false, username: '' }), false)).toEqual([]);
    expect(validateChannel('smtp', form({ to: ['bad'] }), true)).toContain('SMTP: a recipient address is invalid');
  });

  it('only blocks saving for enabled channels', () => {
    const v = form();
    expect(validateForSave(v, true)).toEqual([]);
    v.webhook = { enabled: true, url: 'ftp://x', format: 'json' };
    expect(validateForSave(v, true)).toEqual(['Webhook: a valid http(s) URL is required']);
    v.webhook = { ...v.webhook, enabled: false };
    expect(validateForSave(v, true)).toEqual([]);
  });
});

describe('portAfterSecurityChange', () => {
  it('follows the security mode unless the port was customised', () => {
    expect(portAfterSecurityChange(587, 'starttls', 'ssl')).toBe(465);
    expect(portAfterSecurityChange(465, 'ssl', 'none')).toBe(25);
    expect(portAfterSecurityChange(2525, 'starttls', 'ssl')).toBe(2525);
  });
});
