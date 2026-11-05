/**
 * The tail of `gbrain embed --stale`: settle the per-write embedding effects whose vectors the drain (or an earlier
 * one) already installed, so doctor's `stale_embedding_effects` and receipt compaction stop waiting on them. Provider
 * free: an effect whose vectors are still missing or unverified is left for `gbrain repair embedding-effects`. Never
 * fails the embed run; a failure is one stderr line.
 */
import type { BrainEngine } from './engine.ts';
import { loadConfigWithEngine } from './config.ts';
import { serr } from './console-prefix.ts';
import { existingHostIdFor } from './persistence/identity.ts';

/** The count of effects settled, or undefined when the sweep could not run (no registered local host, or an error). */
export async function settleEffectsAfterStaleDrain(engine: BrainEngine, sourceId: string | undefined, signal?: AbortSignal,
  quiet?: boolean): Promise<number | undefined> {
  const hostId = existingHostIdFor(engine);
  if (!hostId) return undefined;
  try {
    // lazy: keeps the persistence effect graph out of embed's static imports (tests mock embedding.ts beneath it).
    const { settleVerifiedEmbeddingEffects } = await import('./persistence/embedding-settlement.ts');
    const sourceIds = sourceId ? [sourceId] : (await engine.executeRaw<{ id: string }>('SELECT id FROM sources')).map(row => row.id);
    const { candidates, settled } = await settleVerifiedEmbeddingEffects(engine, { sourceIds, config: await loadConfigWithEngine(engine), hostId, signal });
    if (!quiet && candidates) {
      serr(`  [embed] settled ${settled} of ${candidates} unsettled write embedding receipt(s) whose vectors are current`
        + (candidates > settled ? `; the rest need provider work: gbrain repair embedding-effects${sourceId ? ` --source ${sourceId}` : ''}` : ''));
    }
    return settled;
  } catch (error) {
    serr(`  [embed] could not settle write embedding receipts: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
