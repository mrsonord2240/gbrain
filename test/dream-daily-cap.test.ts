/**
 * Fork: dream daily cap. 1 scheduled run + N extra per local day (default 1),
 * counted at start, --dry-run exempt, --override-daily-cap recorded.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimDreamSlot, localDate, resolveDreamExtraRunLimit } from '../src/core/dream-quota.ts';

let home: string;
let ledgerPath: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ['GBRAIN_HOME', 'GBRAIN_DREAM_DAILY_EXTRA_RUNS']) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'dream-cap-'));
  process.env.GBRAIN_HOME = home;
  delete process.env.GBRAIN_DREAM_DAILY_EXTRA_RUNS;
  ledgerPath = join(home, '.gbrain', 'dream-quota.json');
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const day = new Date(2026, 10, 4, 10, 0, 0);
const claim = (scheduled: boolean, override = false, now = day) =>
  claimDreamSlot({ scheduled, override, args: ['dream'], now, path: ledgerPath });

describe('dream daily cap', () => {
  test('default allows one scheduled and one extra run a day', () => {
    expect(resolveDreamExtraRunLimit()).toBe(1);
    expect(claim(true).allowed).toBe(true);
    expect(claim(false).allowed).toBe(true);
    const third = claim(false);
    expect(third.allowed).toBe(false);
    if (!third.allowed) {
      expect(third.message).toContain('refused');
      expect(third.message).toContain('Nothing ran');
      expect(third.suggestion).toContain('--override-daily-cap');
    }
  });

  test('a second scheduled run the same day is refused', () => {
    expect(claim(true).allowed).toBe(true);
    expect(claim(true).allowed).toBe(false);
  });

  test('extra runs do not use the scheduled slot', () => {
    expect(claim(false).allowed).toBe(true);
    expect(claim(false).allowed).toBe(false);
    expect(claim(true).allowed).toBe(true);
  });

  test('override runs past the cap and is recorded', () => {
    claim(true); claim(false);
    const o = claim(false, true);
    expect(o.allowed).toBe(true);
    expect(o.kind).toBe('override');
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8'));
    expect(ledger.override).toBe(1);
    expect(ledger.runs).toHaveLength(3);
    expect(ledger.date).toBe(localDate(day));
  });

  test('a new local day resets the counts', () => {
    claim(true); claim(false);
    expect(claim(false).allowed).toBe(false);
    const next = new Date(2026, 10, 5, 9, 0, 0);
    expect(claim(false, false, next).allowed).toBe(true);
  });

  test('env sets n, then config.json, and invalid values fall back to 1', () => {
    process.env.GBRAIN_DREAM_DAILY_EXTRA_RUNS = '0';
    expect(resolveDreamExtraRunLimit()).toBe(0);
    expect(claim(false).allowed).toBe(false);
    process.env.GBRAIN_DREAM_DAILY_EXTRA_RUNS = 'lots';
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', dream_daily_extra_runs: 3 }));
    expect(resolveDreamExtraRunLimit()).toBe(3);
    delete process.env.GBRAIN_DREAM_DAILY_EXTRA_RUNS;
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', dream_daily_extra_runs: -2 }));
    expect(resolveDreamExtraRunLimit()).toBe(1);
  });

  test('a corrupt ledger starts the day fresh', () => {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(ledgerPath, '{not json');
    expect(claim(true).allowed).toBe(true);
  });
});

describe('gbrain dream CLI honors the cap', () => {
  const run = (args: string[], env: Record<string, string>) => {
    const p = Bun.spawnSync(['bun', 'src/cli.ts', 'dream', ...args], {
      cwd: join(import.meta.dir, '..'),
      // bun test runs its own clock in UTC; pin the child to it so the
      // ledger date written above matches the CLI's localDate() late at night.
      env: { ...process.env, TZ: 'Etc/UTC', GBRAIN_TEST_DREAM_CAP_OFF: '0', ...env },
    });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };

  test('refuses before any work once the day is used, and --dry-run and --help are exempt', () => {
    const h = mkdtempSync(join(tmpdir(), 'dream-cap-cli-'));
    mkdirSync(join(h, '.gbrain'), { recursive: true });
    writeFileSync(join(h, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(h, 'brain.pglite') }));
    writeFileSync(join(h, '.gbrain', 'dream-quota.json'), JSON.stringify({
      date: localDate(), scheduled: 1, extra: 1, override: 0, runs: [],
    }));
    const env = { GBRAIN_HOME: h };
    const refused = run(['--json'], env);
    expect(refused.code).not.toBe(0);
    expect(refused.out + refused.err).toContain('dream_daily_cap');
    const help = run(['--help'], env);
    expect(help.code).toBe(0);
    expect(help.out).toContain('--override-daily-cap');
    const ledger = JSON.parse(readFileSync(join(h, '.gbrain', 'dream-quota.json'), 'utf-8'));
    expect(ledger.extra).toBe(1);
    expect(ledger.runs).toHaveLength(0);
  }, 60_000);
});
