/**
 * Owner admin sessions for `gbrain serve --http`: "remember this device".
 *
 * A session is a signed cookie, not a server-side row, so it survives server
 * restarts. Value: `v1.<sid>.<epoch>.<expiresAt>.<sig>`, where `sig` is an
 * HMAC over the rest keyed from the bootstrap credential. Rotating that
 * credential therefore invalidates every session. Sessions slide: a request
 * on a cookie issued more than a day ago gets a fresh 90-day expiry with the
 * same `sid` (the consent CSRF binding keys on `sid`, so a refresh never
 * breaks an open consent page).
 *
 * Sign-out-everywhere bumps a persisted epoch (`admin.session_epoch` in the
 * brain's config table); cookies carrying an older epoch are refused, across
 * restarts too.
 */

import { createHmac, randomBytes } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { safeHexEqual } from '../core/timing-safe.ts';

export const ADMIN_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** A cookie older than this (issued or last refreshed) is re-issued on use. */
export const ADMIN_SESSION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
export const ADMIN_SESSION_EPOCH_KEY = 'admin.session_epoch';

export type AdminSessionCheck =
  | { ok: true; sid: string; refreshed?: string }
  | { ok: false; reason: 'missing' | 'invalid' | 'expired' };

export interface AdminSessions {
  /** A new session cookie value. */
  issue(now?: number): string;
  /** Validate a cookie value; `refreshed` is a re-issued value to set when the cookie is due. */
  verify(value: string | undefined, now?: number): AdminSessionCheck;
  /** The stable per-login id inside a valid cookie, or null. */
  sessionId(value: string | undefined): string | null;
  /** Invalidate every outstanding session, persisted so it holds across restarts. */
  revokeAll(): Promise<void>;
}

export function createAdminSessions(bootstrapToken: string, opts: {
  epoch: number;
  persistEpoch: (epoch: number) => Promise<void>;
}): AdminSessions {
  const key = createHmac('sha256', bootstrapToken).update('gbrain-admin-session-v1').digest();
  let epoch = opts.epoch;
  const sign = (body: string) => createHmac('sha256', key).update(body).digest('hex');
  const mint = (sid: string, ep: number, expiresAt: number) => {
    const body = `v1.${sid}.${ep}.${expiresAt}`;
    return `${body}.${sign(body)}`;
  };
  const parse = (value: string | undefined) => {
    if (!value) return null;
    const parts = value.split('.');
    if (parts.length !== 5 || parts[0] !== 'v1' || !/^[0-9a-f]{32}$/.test(parts[1])) return null;
    if (!/^\d+$/.test(parts[2]) || !/^\d+$/.test(parts[3]) || !/^[0-9a-f]{64}$/.test(parts[4])) return null;
    if (!safeHexEqual(parts[4], sign(parts.slice(0, 4).join('.')))) return null;
    return { sid: parts[1], epoch: Number(parts[2]), expiresAt: Number(parts[3]) };
  };

  return {
    issue(now = Date.now()) {
      return mint(randomBytes(16).toString('hex'), epoch, now + ADMIN_SESSION_TTL_MS);
    },
    verify(value, now = Date.now()) {
      if (!value) return { ok: false, reason: 'missing' };
      const s = parse(value);
      if (!s || s.epoch !== epoch) return { ok: false, reason: 'invalid' };
      if (now > s.expiresAt) return { ok: false, reason: 'expired' };
      const due = s.expiresAt - now < ADMIN_SESSION_TTL_MS - ADMIN_SESSION_REFRESH_AFTER_MS;
      return due ? { ok: true, sid: s.sid, refreshed: mint(s.sid, epoch, now + ADMIN_SESSION_TTL_MS) } : { ok: true, sid: s.sid };
    },
    sessionId(value) {
      const s = parse(value);
      return s && s.epoch === epoch ? s.sid : null;
    },
    async revokeAll() {
      epoch += 1; // effective immediately in this process, even if persisting fails
      await opts.persistEpoch(epoch);
    },
  };
}

/** Load the persisted epoch and build the session store for a running server. */
export async function loadAdminSessions(engine: BrainEngine, bootstrapToken: string): Promise<AdminSessions> {
  let epoch: number;
  try {
    const stored = await engine.getConfig(ADMIN_SESSION_EPOCH_KEY);
    epoch = stored && /^\d+$/.test(stored) ? Number(stored) : 0;
  } catch {
    // Fail closed: an unreadable epoch must not revive revoked cookies, so
    // this process accepts none of them (the owner logs in once more).
    epoch = Date.now();
  }
  return createAdminSessions(bootstrapToken, {
    epoch,
    persistEpoch: e => engine.setConfig(ADMIN_SESSION_EPOCH_KEY, String(e)),
  });
}
