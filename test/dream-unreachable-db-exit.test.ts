/**
 * Protects: `gbrain dream` on a configured brain whose database cannot be
 * reached is a failed run (exit 1, never "Brain is healthy"). A machine with no
 * gbrain config has no database to reach and keeps its exit-0 filesystem run.
 * Regression caught: dropping the exit status, so a scheduled run that skipped
 * every DB phase reports success.
 * Existing coverage: test/dream-failed-phase-exit.test.ts pins failed phases,
 * and a skipped phase is not a failed one. No production seam is added.
 */
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli/commands/dream.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import type { CliDispatchContext } from '../src/cli/command-table.ts';
import { withEnv } from './helpers/with-env.ts';

let configured: string;
let unconfigured: string;
let dir: string;

const unreachable = {
  connectEngine: async () => { throw new Error('write CONNECT_TIMEOUT db.example.test:5432'); },
} as unknown as CliDispatchContext;

/** Runs the command and returns everything it printed to stdout. */
async function dream(home: string, ...extra: string[]): Promise<string> {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const err = spyOn(console, 'error').mockImplementation(() => {});
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined }, () =>
      run(['--dir', dir, '--phase', 'lint', ...extra], unreachable));
    return log.mock.calls.map(c => String(c[0])).join('\n');
  } finally {
    log.mockRestore();
    err.mockRestore();
    stderr.mockRestore();
  }
}

beforeAll(() => {
  configured = mkdtempSync(join(tmpdir(), 'gbrain-dream-db-home-'));
  unconfigured = mkdtempSync(join(tmpdir(), 'gbrain-dream-nodb-home-'));
  dir = mkdtempSync(join(tmpdir(), 'gbrain-dream-db-src-'));
  mkdirSync(join(configured, '.gbrain'), { recursive: true });
  writeFileSync(join(configured, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'postgres',
    database_url: 'postgresql://user:pass@db.example.test:5432/postgres',
  }));
});
afterEach(() => {
  _resetCliExitVerdictForTests();
  process.exitCode = 0;
});
afterAll(() => {
  for (const d of [configured, unconfigured, dir]) rmSync(d, { recursive: true, force: true });
});

test('a configured brain with an unreachable database exits 1', async () => {
  await dream(configured);
  expect(currentExitCode()).toBe(1);
}, 60_000);

test('no gbrain config keeps the filesystem-only cycle at exit 0', async () => {
  await dream(unconfigured);
  expect(currentExitCode()).toBe(0);
}, 60_000);

test('--json stays parseable when the database is unreachable', async () => {
  const printed = await dream(configured, '--json');
  const report = JSON.parse(printed.slice(printed.indexOf('{')));
  expect(report.phases.find((p: { phase: string }) => p.phase === 'lint')).toBeDefined();
  expect(currentExitCode()).toBe(1);
}, 60_000);

test('an unreachable database never prints Brain is healthy', async () => {
  const printed = await dream(configured);
  expect(printed).not.toContain('Brain is healthy');
}, 60_000);
