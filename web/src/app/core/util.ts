import { DestroyRef, inject } from '@angular/core';

/** 5400 -> "1h 30m". */
export function fmtDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !isFinite(sec)) return '–';
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** "5m ago" relative to `now` (server clock when available). */
export function fmtAgo(ms: number | null | undefined, now: number = Date.now()): string {
  if (ms === null || ms === undefined) return 'never';
  const diff = (now - ms) / 1000;
  if (diff < 10) return 'just now';
  return `${fmtDuration(diff)} ago`;
}

export function fmtTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '–';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });
}

/** Runs `fn` now and then every `ms` until the calling component is destroyed (call in an injection context). */
export function polling(fn: () => unknown, ms: number): void {
  const destroyRef = inject(DestroyRef);
  void fn();
  const id = setInterval(() => void fn(), ms);
  destroyRef.onDestroy(() => clearInterval(id));
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      return document.execCommand('copy');
    } finally {
      ta.remove();
    }
  }
}

export const ALL_KINDS = [
  'queued', 'delivery', 'accepted', 'reject', 'dkim_signed', 'auth_fail', 'ratelimit', 'conn_error',
  'foreign_sender', 'ban', 'unban', 'f2b_found', 'sasl_authd_fail', 'error', 'service',
  'connect', 'disconnect', 'meta', 'info',
];

export const VIEWER_KINDS = ['queued', 'delivery', 'accepted', 'reject', 'dkim_signed'];

/** "maillog v1.0.0 (a1b2c3d)"; the commit part is left out when unknown. */
export function formatVersion(v: { name: string; version: string; commit: string | null }): string {
  return `${v.name} v${v.version}` + (v.commit ? ` (${v.commit})` : '');
}
