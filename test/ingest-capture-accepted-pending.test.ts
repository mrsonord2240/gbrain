/**
 * An ingest_capture write the owner accepted but has not published yet is progress, not a failure (#5600/#5601's rule,
 * which connector sync, managed import and atom publication already follow). The handler reports it `pending` with the
 * request id and the job completes; throwing it made the worker retry a write that was already queued and, after
 * max_attempts, dead-letter a capture that then published anyway.
 *
 * Protects, on a managed brain whose owner stalls after admission:
 * - a capture returns status `pending` with the queued request's id, and nothing is thrown;
 * - the worker completes the job on its first attempt (never dead, never retried) with that result;
 * - a capture tombstone that stays pending reports `pending` the same way;
 * - once the owner resumes, the queued request commits and the page is stored (or deleted) as captured.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { computeContentHash, type IngestionEvent } from '../src/core/ingestion/types.ts';
import { makeIngestCaptureHandler } from '../src/core/minions/handlers/ingest-capture.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer, startPersistenceConsumer, waitForWrite } from '../src/core/persistence/service.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { waitFor } from './helpers/wait-for.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });

const content = '---\ntitle: Captured example\ntype: note\n---\nNotes from alice-example about acme-example.\n';
function event(body: string, extra: Partial<IngestionEvent> = {}): IngestionEvent {
  return { source_id: 'source-a', source_kind: 'webhook', source_uri: 'https://example.com/page', received_at: new Date('2026-11-03T04:51:41Z').toISOString(),
    content_type: 'text/markdown', content: body, content_hash: computeContentHash(body), untrusted_payload: true, ...extra };
}
const job = (data: Record<string, unknown>): MinionJobContext => ({ id: 1, name: 'ingest_capture', data, attempts_made: 0, signal: new AbortController().signal,
  deadlineAtMs: null, shutdownSignal: new AbortController().signal, updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {},
  isActive: async () => true, readInbox: async () => [] });
const queuedRows = (sourceId: string) => engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND state='queued'", [sourceId]);

/** A managed source whose owner can be stalled after admission (worktree `draining`) and resumed. */
async function managedBrain(run: (sourceId: string, stall: (on: boolean) => Promise<void>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-capture-pending-'));
  const root = join(dir, 'brain');
  mkdirSync(root);
  const sourceId = `source-${randomUUID().slice(0, 8)}`;
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      writeFileSync(join(root, '.gitignore'), 'tmp/\n'); durableGitRepo(root, ['.gitignore']);
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await engine.setConfig('sync.write_through', 'true');
      const binding = await claimWorktree(engine, sourceId, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const stall = async (on: boolean) => {
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_worktrees SET state=$2 WHERE id=$1::uuid', [binding.worktree_id, on ? 'draining' : 'active']);
        if (!on) startPersistenceConsumer(engine, { engine: engine.kind });
      };
      await run(sourceId, stall);
    });
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    rmSync(dir, { recursive: true, force: true });
  }
}

async function resumeAndCommit(sourceId: string, stall: (on: boolean) => Promise<void>, requestId: string) {
  const queued = await queuedRows(sourceId);
  expect(queued.map(row => row.request_id)).toContain(requestId);
  await stall(false);
  for (const row of queued) expect((await waitForWrite(engine, row, { engine: engine.kind }, 20_000)).state).toBe('committed');
}

describe('ingest_capture: an accepted, still-pending write is progress, not a failure', () => {
  test('the handler reports pending with the request id, and the write commits once the owner resumes', async () => {
    await managedBrain(async (sourceId, stall) => {
      await stall(true);
      const result = await makeIngestCaptureHandler(engine)(job({ event: event(content), slug: 'clips/pending-capture', sourceId }));
      expect(result.status).toBe('pending');
      expect(typeof result.request_id).toBe('string');
      expect(await engine.readPageSnapshot('clips/pending-capture', { sourceId })).toBeNull();
      await resumeAndCommit(sourceId, stall, result.request_id!);
      expect((await engine.readPageSnapshot('clips/pending-capture', { sourceId }))?.page.title).toBe('Captured example');
    });
  }, 120_000);

  test('the worker completes the job on its first attempt instead of retrying it to dead', async () => {
    await managedBrain(async (sourceId, stall) => {
      await stall(true);
      const queue = new MinionQueue(engine);
      const queued = await queue.add('ingest_capture', { event: event(content), slug: 'clips/pending-worker', sourceId }, { max_attempts: 3 });
      const worker = new MinionWorker(engine, { concurrency: 1, pollInterval: 20, healthCheckInterval: 0, stalledInterval: 60_000 });
      worker.register('ingest_capture', makeIngestCaptureHandler(engine));
      const running = worker.start();
      try {
        await waitFor(async () => ['completed', 'dead', 'failed', 'delayed'].includes((await queue.getJob(queued.id))?.status ?? ''), { timeoutMs: 60_000, label: 'ingest_capture settled' });
      } finally { worker.stop(); await running; }
      const done = (await queue.getJob(queued.id))!;
      expect(done.status).toBe('completed');
      expect(done.attempts_made).toBe(0); // failed attempts: none were retried
      expect(done.result).toMatchObject({ status: 'pending', slug: 'clips/pending-worker' });
      await resumeAndCommit(sourceId, stall, (done.result as { request_id: string }).request_id);
      expect(await engine.readPageSnapshot('clips/pending-worker', { sourceId })).not.toBeNull();
    });
  }, 120_000);

  test('a capture tombstone that stays pending reports pending, and the page is deleted once the owner resumes', async () => {
    await managedBrain(async (sourceId, stall) => {
      const handler = makeIngestCaptureHandler(engine);
      expect((await handler(job({ event: event(content), slug: 'clips/pending-tombstone', sourceId }))).status).toBe('imported');
      await stall(true);
      const tombstone = event('tombstone', { kind: 'tombstone', slug: 'clips/pending-tombstone', untrusted_payload: false });
      const result = await handler(job({ event: tombstone, slug: 'clips/pending-tombstone', sourceId }));
      expect(result.status).toBe('pending');
      await resumeAndCommit(sourceId, stall, result.request_id!);
      expect(await engine.readPageSnapshot('clips/pending-tombstone', { sourceId })).toBeNull();
    });
  }, 120_000);
});
