/**
 * Protects: inbox_triage files against the brain's active pack, including one
 * set in the database, which outranks `gbrain schema use`'s file setting.
 * Regression caught: reading only ~/.gbrain/config.json, so captures are
 * classified against a pack the brain isn't running.
 * Existing coverage: the resolver has its own tests; this caller had none.
 * `loadTriagePack` is the phase's own lookup, not a test seam.
 *
 * Also protects: the classifier sees the pack's filing rules, and is offered
 * only types that have a directory. Regression caught: `filing_rules` read by
 * nothing, so a type reached the model as a bare name, and a type with no
 * directory was offered an invented `<name>/` one.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadTriagePack, triageTypeList } from '../src/core/cycle/inbox-triage.ts';
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

test('triageTypeList gives the classifier each filing rule', () => {
  const list = triageTypeList({
    page_types: [{ name: 'gotcha', path_prefixes: ['gotchas/'] }],
    filing_rules: [{ kind: 'gotcha', directory: 'gotchas/', description: 'One way something breaks.' }],
  });
  expect(list).toBe('- gotcha (directory: gotchas/): One way something breaks.');
});

test('triageTypeList files a type where its rule says, not at its first prefix', () => {
  const list = triageTypeList({
    page_types: [{ name: 'system', path_prefixes: ['machine/', 'systems/'] }],
    filing_rules: [{ kind: 'system', directory: 'systems/' }],
  });
  expect(list).toBe('- system (directory: systems/)');
});

test('triageTypeList keeps a type with a prefix and no rule', () => {
  const list = triageTypeList({ page_types: [{ name: 'note', path_prefixes: ['notes/'] }], filing_rules: [] });
  expect(list).toBe('- note (directory: notes/)');
});

test('triageTypeList does not offer a type with no directory', () => {
  const list = triageTypeList({
    page_types: [
      { name: 'code', path_prefixes: [] },
      { name: 'note', path_prefixes: ['notes/'] },
    ],
    filing_rules: [],
  });
  expect(list).toBe('- note (directory: notes/)');
});
