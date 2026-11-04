/**
 * Dream daily cap (fork-local, atlas egress guard).
 *
 * Every `gbrain dream` run opens database connections and reads from the
 * brain, and on the Supabase Free plan that read traffic is egress against a
 * hard monthly quota. On 2026-11-02/03 about 40 short dream processes ran in
 * two days (one burst of 20 in under three minutes), none of them a full
 * cycle. This guard caps how many dream runs a day may start:
 *
 *   - one scheduled run (`--scheduled`, passed by the nightly job), plus
 *   - N extra runs, from GBRAIN_DREAM_DAILY_EXTRA_RUNS or the config.json key
 *     `dream_daily_extra_runs`, default 1.
 *
 * A run counts when it starts, so a failed run, a skipped run and a retry all
 * use a slot. `--dry-run` and `--help` never count. `--override-daily-cap`
 * starts a run past the cap (operator only) and is still recorded.
 *
 * The ledger is `<configDir>/dream-quota.json`, keyed by the host's local
 * date. It is local to the machine, so it costs no egress to read.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configDir, loadConfigFileOnly } from './config.ts';

export const DEFAULT_DREAM_DAILY_EXTRA_RUNS = 1;
export const DREAM_SCHEDULED_RUNS_PER_DAY = 1;

export type DreamRunKind = 'scheduled' | 'extra' | 'override';

export interface DreamQuotaRun {
  at: string;
  kind: DreamRunKind;
  pid: number;
  args: string;
}

export interface DreamQuotaLedger {
  date: string;
  scheduled: number;
  extra: number;
  override: number;
  runs: DreamQuotaRun[];
}

export type DreamQuotaDecision =
  | { allowed: true; kind: DreamRunKind; ledger: DreamQuotaLedger; extraLimit: number }
  | { allowed: false; kind: 'scheduled' | 'extra'; ledger: DreamQuotaLedger; extraLimit: number; message: string; suggestion: string };

export function dreamQuotaPath(): string {
  return join(configDir(), 'dream-quota.json');
}

/** Host-local calendar date, YYYY-MM-DD. */
export function localDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseLimit(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

/** Extra runs allowed per day: env, then config.json, then the default. */
export function resolveDreamExtraRunLimit(): number {
  const fromEnv = parseLimit(process.env.GBRAIN_DREAM_DAILY_EXTRA_RUNS);
  if (fromEnv !== null) return fromEnv;
  const file = loadConfigFileOnly() as unknown as Record<string, unknown> | null;
  const fromFile = parseLimit(file?.dream_daily_extra_runs);
  if (fromFile !== null) return fromFile;
  return DEFAULT_DREAM_DAILY_EXTRA_RUNS;
}

function emptyLedger(date: string): DreamQuotaLedger {
  return { date, scheduled: 0, extra: 0, override: 0, runs: [] };
}

export function readDreamQuotaLedger(date: string, path: string = dreamQuotaPath()): DreamQuotaLedger {
  if (!existsSync(path)) return emptyLedger(date);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<DreamQuotaLedger>;
    if (parsed.date !== date) return emptyLedger(date);
    return {
      date,
      scheduled: Number(parsed.scheduled) || 0,
      extra: Number(parsed.extra) || 0,
      override: Number(parsed.override) || 0,
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    };
  } catch {
    // A corrupt ledger must not let runs through uncounted forever, but it
    // also must not block the nightly run: start the day fresh.
    return emptyLedger(date);
  }
}

function writeLedger(ledger: DreamQuotaLedger, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
}

export interface ClaimDreamSlotOpts {
  scheduled: boolean;
  override: boolean;
  args: string[];
  now?: Date;
  path?: string;
}

/**
 * Decide whether this dream run may start and, when it may, record it.
 * Recording happens before the run so a run that fails still uses its slot.
 */
export function claimDreamSlot(opts: ClaimDreamSlotOpts): DreamQuotaDecision {
  const now = opts.now ?? new Date();
  const path = opts.path ?? dreamQuotaPath();
  const date = localDate(now);
  const ledger = readDreamQuotaLedger(date, path);
  const extraLimit = resolveDreamExtraRunLimit();
  const requested: 'scheduled' | 'extra' = opts.scheduled ? 'scheduled' : 'extra';

  let kind: DreamRunKind | null = null;
  if (opts.override) kind = 'override';
  else if (requested === 'scheduled' && ledger.scheduled < DREAM_SCHEDULED_RUNS_PER_DAY) kind = 'scheduled';
  else if (requested === 'extra' && ledger.extra < extraLimit) kind = 'extra';

  if (kind === null) {
    const used = requested === 'scheduled'
      ? `the scheduled run already ran today (${date})`
      : `today's ${extraLimit === 1 ? 'one extra run is' : `${extraLimit} extra runs are`} already used (${date})`;
    return {
      allowed: false,
      kind: requested,
      ledger,
      extraLimit,
      message:
        `gbrain dream refused: ${used}. Dream runs are capped at 1 scheduled + ` +
        `${extraLimit} extra per day to protect database egress. Nothing ran.`,
      suggestion:
        'Batch the work into tomorrow\'s scheduled run. Only the operator may start ' +
        'one more today, with --override-daily-cap.',
    };
  }

  ledger[kind] += 1;
  ledger.runs.push({ at: now.toISOString(), kind, pid: process.pid, args: opts.args.join(' ') });
  writeLedger(ledger, path);
  return { allowed: true, kind, ledger, extraLimit };
}

/** Test-only switch: the unit lane shares one GBRAIN_HOME per process. */
export function dreamCapDisabledForTests(): boolean {
  return process.env.GBRAIN_TEST_DREAM_CAP_OFF === '1';
}
