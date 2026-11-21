/**
 * Backlog 10b: `gbrain call <tool> -` reads its JSON params from stdin. It used Bun.stdin.text(), which came back
 * empty on Windows, so the call ran with no params and printed nothing useful. It now reads through the shared bounded
 * stdin reader (the one `gbrain put` uses), and an empty stdin is an error instead of a call with {}.
 * Real CLI spawns against a throwaway keyless PGLite brain; the env is built from an allowlist.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

const REPO = dirname(import.meta.dir);
const CLI = join(REPO, 'src', 'cli.ts');
const SKIP = process.env.GBRAIN_TEST_SKIP_SUBPROCESS === '1';

describe.skipIf(SKIP)('gbrain call <tool> - reads params from stdin', () => {
  let home = '';
  let env: Record<string, string> = {};

  async function run(args: string[], stdin: { data: string } | { file: string } | 'empty'): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn([process.execPath, 'run', CLI, ...args], {
      cwd: REPO, env,
      stdin: typeof stdin === 'object' && 'file' in stdin ? Bun.file(stdin.file) : 'pipe',
      stdout: 'pipe', stderr: 'pipe',
    });
    if (typeof stdin !== 'object' || !('file' in stdin)) {
      const sink = proc.stdin as unknown as { write(d: string): unknown; end(): unknown };
      if (typeof stdin === 'object') sink.write(stdin.data);
      await sink.end();
    }
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gb-call-stdin-'));
    env = {
      PATH: [dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter)].filter(Boolean).join(delimiter),
      HOME: home, USERPROFILE: home, GBRAIN_HOME: home, TMPDIR: tmpdir(), TEMP: tmpdir(), TMP: tmpdir(),
      GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_STDIN_TIMEOUT_MS: '2000',
      ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
    };
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite'), embedding_disabled: true }) + '\n');
    const init = await run(['init', '--migrate-only'], 'empty');
    if (init.code !== 0) throw new Error(`init --migrate-only failed (${init.code}):\n${init.stderr.slice(-2000)}`);
  }, 180_000);

  afterAll(() => {
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { if (process.platform !== 'win32') throw e; }
  });

  test('piped params reach the tool (page_not_found names the piped slug)', async () => {
    const r = await run(['call', 'get_page', '-'], { data: '{"slug":"people/nobody-call-stdin"}' });
    expect(r.stdout).toContain('page_not_found');
    expect(r.stdout + r.stderr).toContain('people/nobody-call-stdin');
  }, 120_000);

  test('params redirected from a file reach the tool, with a leading BOM tolerated', async () => {
    const file = join(home, 'params.json');
    writeFileSync(file, '﻿{"slug":"people/nobody-from-file"}');
    const r = await run(['call', 'get_page', '-'], { file });
    expect(r.stdout).toContain('page_not_found');
    expect(r.stdout + r.stderr).toContain('people/nobody-from-file');
  }, 120_000);

  test('an empty stdin is an error, not a call with no params', async () => {
    const r = await run(['call', 'get_page', '-'], 'empty');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('stdin was empty, so nothing was called');
  }, 120_000);
});
