/**
 * `gbrain embed --stale` settles the per-write embedding effects its vectors already satisfy. A write whose own embed
 * gave up (failed, attempts exhausted) kept counting in doctor's stale_embedding_effects and blocking receipt
 * compaction after a bulk embed installed its vectors, until someone ran `gbrain repair embedding-effects --apply`.
 *
 * Protects:
 * - a failed effect whose current vectors verify is committed `reconciled` with no provider call, and doctor clears;
 * - a failed effect whose vectors are missing is left exactly as it was: no retry grant, no state change;
 * - the stale drain itself runs the sweep and reports `effects_settled`; a dry run does not.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GBrainConfig } from '../src/core/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { installPageEmbeddings, installPageProjection, readProjectionSnapshot } from '../src/core/page-state/projections.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { staleEmbeddingEffectsCheck } from '../src/commands/doctor/checks/stale-embedding-effects.ts';
import { settleEffectsAfterStaleDrain } from '../src/core/embed-settle-effects.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

const model = 'openai:text-embedding-3-small';
const signature = `${model}:1536`;
const vector = () => new Float32Array(1536).fill(0.25);
let engine: BrainEngine;
let scratch: string;
let config: GBrainConfig;
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'gbrain-embed-settle-'));
  config = { engine: 'pglite', embedding_model: model, embedding_dimensions: 1536, database_path: join(scratch, 'brain') };
  engine = new PGLiteEngine(); await engine.connect(config); await engine.initSchema();
  mkdirSync(join(scratch, '.gbrain'));
  writeFileSync(join(scratch, '.gbrain', 'config.json'), JSON.stringify(config));
  configureGateway({ embedding_model: model, embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test-not-used' } });
}, 120_000);
afterAll(async () => { resetGateway(); await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(scratch, { recursive: true, force: true }); });
const check = (name: string, fn: () => Promise<void>) => test(name, () => withEnv({ GBRAIN_HOME: scratch, GBRAIN_BRAIN_ID: 'host',
  GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_EMBEDDING_MODEL: undefined,
  GBRAIN_EMBEDDING_DIMENSIONS: undefined, GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0', OPENAI_API_KEY: 'sk-test-not-used' }, fn), 120_000);

/** A committed page write on a fresh source whose embedding effect failed with its attempts exhausted. */
async function failedWrite() {
  await registerLocalWriter(engine, 'cli');
  const sourceId = `emb-${randomUUID().slice(0, 16)}`;
  const [source] = await engine.executeRaw<{ incarnation: string }>('INSERT INTO sources(id,name) VALUES($1,$1) RETURNING incarnation', [sourceId]);
  const authority = await submissionAuthority({ engine, config, remote: false, sourceId } as OperationContext, 'put_page', sourceId, source.incarnation, 'page');
  await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId, pageId: null,
    sourceIncarnation: source.incarnation, slug: 'page', requestId: randomUUID(), callerIntent: { body: 'Current' }, intent: { body: 'Current' } });
  const row = (await claimNextWrite(engine, localHostId()))!;
  await publishMutation(engine, row, { observedRevision: null, apply: async tx => {
    await tx.putPage('page', { type: 'note', title: 'Example', compiled_truth: 'Current' }, { sourceId }); return {};
  } }, localHostId());
  const prepared = (await readProjectionSnapshot(engine, 'page', sourceId, { allowUnsealed: true }))!;
  await installPageProjection(engine, prepared, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Current' }], { seal: true });
  const [effect] = await engine.executeRaw<{ id: string }>(`UPDATE persistence_effects SET state='failed', attempts=5, error_code='embedding_attempts_exhausted',
      next_attempt_at=now()+interval '1 day', updated_at=now()-interval '2 hours' WHERE request_id=$1::uuid AND kind='embedding' RETURNING id`, [row.id]);
  return { sourceId, effectId: String(effect.id) };
}
const embedVectors = async (sourceId: string) => {
  const prepared = (await readProjectionSnapshot(engine, 'page', sourceId))!;
  await installPageEmbeddings(engine, prepared, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Current', embedding: vector(), model }], signature);
};
const effect = async (id: string) => (await engine.executeRaw<Record<string, any>>('SELECT * FROM persistence_effects WHERE id=$1', [id]))[0];

check('a failed write effect whose vectors are current is settled reconciled, and doctor clears', async () => {
  const f = await failedWrite();
  await embedVectors(f.sourceId);
  expect((await staleEmbeddingEffectsCheck(engine, [f.sourceId])).details).toMatchObject({ stale_effects: 1, failed_effects: 1 });
  expect(await settleEffectsAfterStaleDrain(engine, f.sourceId, undefined, true)).toBe(1);
  expect(await effect(f.effectId)).toMatchObject({ state: 'committed', outcome: { embedding: 'reconciled' } });
  expect((await staleEmbeddingEffectsCheck(engine, [f.sourceId])).status).toBe('ok');
});

check('a failed write effect whose vectors are missing is left untouched: no retry grant, no state change', async () => {
  const f = await failedWrite();
  const before = await effect(f.effectId);
  expect(await settleEffectsAfterStaleDrain(engine, f.sourceId, undefined, true)).toBe(0);
  expect(await effect(f.effectId)).toEqual(before);
});

check('embed --stale runs the sweep and reports effects_settled; a dry run settles nothing', async () => {
  const f = await failedWrite();
  await embedVectors(f.sourceId);
  const dry = await runEmbedCore(engine, { stale: true, dryRun: true, sourceId: f.sourceId, quiet: true });
  expect(dry.effects_settled).toBeUndefined();
  expect((await effect(f.effectId)).state).toBe('failed');
  // Nothing is stale, so the drain makes no provider call (the key is a placeholder that would fail one).
  const run = await runEmbedCore(engine, { stale: true, sourceId: f.sourceId, quiet: true });
  expect(run.embedded).toBe(0);
  expect(run.effects_settled).toBe(1);
  expect(await effect(f.effectId)).toMatchObject({ state: 'committed', outcome: { embedding: 'reconciled' } });
});
