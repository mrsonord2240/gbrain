/**
 * Signed owner sessions ("remember this device"): expiry, sliding refresh,
 * tampering, epoch revocation and the stable per-login id.
 * Fails when: a tampered or foreign-credential cookie validates, a cookie
 * outlives 90 days unused, a refresh changes the login id or extends a
 * revoked cookie, or revocation is not persisted.
 */
import { describe, expect, test } from 'bun:test';
import {
  ADMIN_SESSION_REFRESH_AFTER_MS, ADMIN_SESSION_TTL_MS, createAdminSessions,
} from '../src/commands/serve-http-admin-session.ts';

const T0 = 1_800_000_000_000;
const make = (token = 'synthetic-owner-credential', epoch = 0, persisted: number[] = []) =>
  createAdminSessions(token, { epoch, persistEpoch: async e => { persisted.push(e); } });

describe('admin sessions', () => {
  test('a fresh cookie validates without a refresh, and expires after 90 days unused', () => {
    const s = make();
    const cookie = s.issue(T0);
    expect(s.verify(cookie, T0 + 1000)).toEqual({ ok: true, sid: s.sessionId(cookie)! });
    expect(s.verify(cookie, T0 + ADMIN_SESSION_TTL_MS + 1)).toEqual({ ok: false, reason: 'expired' });
  });

  test('use after a day re-issues a cookie with the same login id and a new 90-day expiry', () => {
    const s = make();
    const cookie = s.issue(T0);
    const later = T0 + ADMIN_SESSION_REFRESH_AFTER_MS + 1;
    const check = s.verify(cookie, later);
    expect(check.ok).toBe(true);
    const refreshed = (check as { refreshed: string }).refreshed;
    expect(refreshed).toBeString();
    expect(refreshed).not.toBe(cookie);
    expect(s.sessionId(refreshed)).toBe(s.sessionId(cookie));
    expect(s.verify(refreshed, later + ADMIN_SESSION_TTL_MS - 1).ok).toBe(true);
  });

  test('tampered, malformed and foreign-credential cookies are refused', () => {
    const s = make();
    const cookie = s.issue(T0);
    const parts = cookie.split('.');
    const extended = [...parts.slice(0, 3), String(T0 + 10 * ADMIN_SESSION_TTL_MS), parts[4]].join('.');
    for (const bad of [extended, `${cookie}0`, 'synthetic-owner-session', '', undefined]) {
      expect(s.verify(bad, T0).ok).toBe(false);
    }
    expect(make('another-credential').verify(cookie, T0).ok).toBe(false);
  });

  test('revokeAll refuses every earlier cookie, persists the new epoch, and a store built from it agrees', async () => {
    const persisted: number[] = [];
    const s = make('synthetic-owner-credential', 3, persisted);
    const cookie = s.issue(T0);
    await s.revokeAll();
    expect(persisted).toEqual([4]);
    expect(s.verify(cookie, T0).ok).toBe(false);
    expect(s.sessionId(cookie)).toBeNull();
    const restarted = make('synthetic-owner-credential', 4);
    expect(restarted.verify(cookie, T0).ok).toBe(false);
    expect(restarted.verify(s.issue(T0), T0).ok).toBe(true);
  });
});
