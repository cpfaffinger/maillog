import { fmtAgo, fmtDuration } from './util';
import { b64urlToBuf, bufToB64url } from './webauthn';

describe('fmtDuration', () => {
  it('formats seconds, minutes, hours and days', () => {
    expect(fmtDuration(45)).toBe('45s');
    expect(fmtDuration(600)).toBe('10m');
    expect(fmtDuration(5400)).toBe('1h 30m');
    expect(fmtDuration(7200)).toBe('2h');
    expect(fmtDuration(90000)).toBe('1d 1h');
  });

  it('handles missing values', () => {
    expect(fmtDuration(null)).toBe('–');
    expect(fmtDuration(undefined)).toBe('–');
  });
});

describe('fmtAgo', () => {
  it('is relative to the supplied clock', () => {
    expect(fmtAgo(null, 1000)).toBe('never');
    expect(fmtAgo(1000, 1000 + 5_000)).toBe('just now');
    expect(fmtAgo(0, 120_000)).toBe('2m ago');
  });
});

describe('base64url', () => {
  it('round-trips binary data without padding', () => {
    const bytes = new Uint8Array([0, 250, 251, 252, 253, 254, 255, 62, 63]);
    const text = bufToB64url(bytes.buffer);
    expect(text).not.toMatch(/[+/=]/);
    expect(Array.from(new Uint8Array(b64urlToBuf(text)))).toEqual(Array.from(bytes));
  });
});
