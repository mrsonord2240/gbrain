/**
 * Backlog 20b: on Windows `openclaw` is npm's openclaw.cmd shim, and a .cmd runs through cmd.exe, which cannot take
 * the JSON in --params (the runtime refuses it with ERR_INVALID_ARG_VALUE). The reader now resolves the shim to
 * `node <entry>` there. These run on any OS: the platform is passed in, and paths go through the host path module.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { execFileBounded } from '../src/core/bounded-child-exec.ts';
import { cliGatewayTransport, cmdShimEntry, findOnWindowsPath, resolveOpenclawLaunch } from '../src/core/transcripts/openclaw-gateway.ts';

const NPM_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\openclaw\\openclaw.mjs" %*',
].join('\r\n');
const PNPM_SHIM = [
  '@SETLOCAL', '@IF EXIST "%~dp0\\node.exe" (', '  "%~dp0\\node.exe"  "%~dp0\\..\\openclaw\\bin\\openclaw.mjs" %*', ') ELSE (',
  '  @SET PATHEXT=%PATHEXT:;.JS;=;%', '  node  "%~dp0\\..\\openclaw\\bin\\openclaw.mjs" %*', ')',
].join('\r\n');

const NPM = 'C:\\Users\\sam\\AppData\\Roaming\\npm';
const NODEJS = 'C:\\Program Files\\nodejs';

function fakeFs(files: Record<string, string>) {
  return { exists: (p: string) => p in files, readText: (p: string) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]!; } };
}

describe('resolveOpenclawLaunch', () => {
  test('off Windows the binary runs as given, untouched', () => {
    expect(resolveOpenclawLaunch('openclaw', { platform: 'linux' })).toEqual({ file: 'openclaw', prefix: [] });
    expect(resolveOpenclawLaunch('openclaw', { platform: 'darwin' })).toEqual({ file: 'openclaw', prefix: [] });
  });

  test('an npm .cmd shim runs as node <entry>, with node found on PATH (Path spelled the Windows way)', () => {
    const fs = fakeFs({ [join(NPM, 'openclaw.cmd')]: NPM_SHIM, [join(NPM, 'openclaw')]: '#!/bin/sh', [join(NODEJS, 'node.exe')]: '' });
    const launch = resolveOpenclawLaunch('openclaw', { platform: 'win32', env: { Path: `C:\\Windows;${NPM};${NODEJS}` }, ...fs });
    expect(launch).toEqual({ file: join(NODEJS, 'node.exe'), prefix: [join(NPM, 'node_modules', 'openclaw', 'openclaw.mjs')] });
  });

  test('a node.exe beside the shim wins, as the shim itself would choose', () => {
    const fs = fakeFs({ [join(NPM, 'openclaw.cmd')]: NPM_SHIM, [join(NPM, 'node.exe')]: '', [join(NODEJS, 'node.exe')]: '' });
    const launch = resolveOpenclawLaunch('openclaw', { platform: 'win32', env: { PATH: `${NODEJS};${NPM}` }, ...fs });
    expect(launch.file).toBe(join(NPM, 'node.exe'));
  });

  test('a pnpm shim resolves its relative entry', () => {
    expect(cmdShimEntry(join('C:\\pnpm', 'openclaw.cmd'), PNPM_SHIM)).toBe(join('C:\\pnpm', '..', 'openclaw', 'bin', 'openclaw.mjs'));
  });

  test('an openclaw.exe runs directly', () => {
    const fs = fakeFs({ [join('C:\\tools', 'openclaw.exe')]: '' });
    expect(resolveOpenclawLaunch('openclaw', { platform: 'win32', env: { PATH: 'C:\\tools' }, ...fs })).toEqual({ file: join('C:\\tools', 'openclaw.exe'), prefix: [] });
  });

  test('a batch file that is not an npm shim is refused with a clear archive error, not run through cmd.exe', () => {
    const fs = fakeFs({ [join(NPM, 'openclaw.cmd')]: '@echo off\r\nnode C:\\somewhere\\openclaw.mjs %*' });
    expect(() => resolveOpenclawLaunch('openclaw', { platform: 'win32', env: { PATH: NPM }, ...fs })).toThrow(/batch file gbrain cannot read as an npm shim/);
  });

  test('missing openclaw or missing node are unreachable errors', () => {
    expect(() => resolveOpenclawLaunch('openclaw', { platform: 'win32', env: { PATH: NPM }, ...fakeFs({}) })).toThrow(/openclaw is not on PATH/);
    const fs = fakeFs({ [join(NPM, 'openclaw.cmd')]: NPM_SHIM });
    expect(() => resolveOpenclawLaunch('openclaw', { platform: 'win32', env: { PATH: NPM }, ...fs })).toThrow(/node is not on PATH/);
  });

  test('PATH search follows PATHEXT order and skips the extensionless sh script', () => {
    const files = { [join(NPM, 'openclaw')]: '', [join(NPM, 'openclaw.cmd')]: '', [join(NPM, 'openclaw.ps1')]: '' };
    expect(findOnWindowsPath('openclaw', { PATH: NPM, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, p => p in files)).toBe(join(NPM, 'openclaw.cmd'));
  });
});

describe('cliGatewayTransport on Windows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openclaw-winshim-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('the shim is launched as node <entry>, and the JSON params stay one argument', async () => {
    const shim = join(dir, 'openclaw.cmd');
    writeFileSync(shim, NPM_SHIM);
    writeFileSync(join(dir, 'node.exe'), '');
    const calls: { file: string; args: string[] }[] = [];
    const spawn = (async (file: string, args: string[]) => {
      calls.push({ file, args });
      return { error: null, stdout: JSON.stringify({ sessions: [], hasMore: false }), stderr: '' };
    }) as unknown as typeof execFileBounded;
    const transport = cliGatewayTransport({ bin: shim, platform: 'win32', spawn, timeoutMs: 5_000 });
    await transport.call('sessions.list', { limit: 100 });
    await transport.call('sessions.list', { limit: 100, offset: 100 });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.file).toBe(join(dir, 'node.exe'));
      expect(c.args[0]).toBe(join(dir, 'node_modules', 'openclaw', 'openclaw.mjs'));
      expect(c.args.slice(1, 6)).toEqual(['gateway', 'call', 'sessions.list', '--json', '--params']);
    }
    expect(calls[0]!.args[6]).toBe('{"limit":100}');
  });
});
