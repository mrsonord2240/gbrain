/**
 * Protects: inbox_triage files against the brain's active pack, including one
 * set in the database, which outranks `gbrain schema use`'s file setting.
 * Regression caught: reading only ~/.gbrain/config.json, so captures are
 * classified against a pack the brain isn't running.
 * Existing coverage: the resolver has its own tests; this caller had none.
 * `loadTriagePack` is the phase's own lookup, not a test seam.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadTriagePack } from '../src/core/cycle/inbox-triage.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gbrain-triage-pack-home-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', schema_pack: 'gbrain-base-v2' }));
}, 120_000);
afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

test('loadTriagePack reads the database-configured pack', () => withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
  await engine.setConfig('schema_pack', 'gbrain-recommended');
  expect((await loadTriagePack(engine)).manifest.name).toBe('gbrain-recommended');
}), 60_000);
