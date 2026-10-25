/**
 * Fork carry — `resolveIdleTimeoutSeconds`: GBRAIN_POOL_IDLE_TIMEOUT_S keeps
 * idle pool connections open longer so a slow-polling service stops
 * reconnecting (TLS + auth + type-catalog fetch) every 20 s.
 *
 * Hermetic: resolver only, env injected as a param.
 */

import { describe, expect, test } from 'bun:test';
import { resolveIdleTimeoutSeconds } from '../src/core/db.ts';

describe('resolveIdleTimeoutSeconds', () => {
  test('default is 20 s', () => {
    expect(resolveIdleTimeoutSeconds({})).toBe(20);
    expect(resolveIdleTimeoutSeconds({ GBRAIN_POOL_IDLE_TIMEOUT_S: '' })).toBe(20);
  });

  test('a non-negative integer overrides it; 0 means never close', () => {
    expect(resolveIdleTimeoutSeconds({ GBRAIN_POOL_IDLE_TIMEOUT_S: '300' })).toBe(300);
    expect(resolveIdleTimeoutSeconds({ GBRAIN_POOL_IDLE_TIMEOUT_S: '0' })).toBe(0);
  });

  test('invalid values fall back to 20', () => {
    for (const bad of ['-1', '1.5', 'abc', '5m']) {
      expect(resolveIdleTimeoutSeconds({ GBRAIN_POOL_IDLE_TIMEOUT_S: bad })).toBe(20);
    }
  });
});
