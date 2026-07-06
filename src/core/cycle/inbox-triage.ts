/**
 * gbrain dream — cycle phase `inbox_triage`.
 *
 * Files raw `inbox/` captures (Clipper webhook drops via POST /ingest ->
 * ingest_capture, or anything else landed under inbox/) into their
 * canonical home per the active schema pack + `_brain-filing-rules.md`'s
 * primary-subject rule. Opt-in, default OFF, mirrors `enrich_thin`'s
 * shape (per-tick page cap, cheap Haiku classification, put_page
 * write-through so auto-link/auto-timeline fire for free).
 *
 * Each tick:
 *   1. List up to `max_pages_per_tick` inbox/* pages (oldest first).
 *   2. Ask a cheap model (utility tier / Haiku by default) to classify
 *      each against the active pack's page_types: best-matching type,
 *      a canonical target slug, and a confidence.
 *   3. High confidence -> write the page at the new slug via the real
 *      `put_page` operation handler (remote=false, so auto-link +
 *      auto-timeline fire exactly like `gbrain capture`), then
 *      soft-delete the old inbox slug (recoverable 72h via restore_page).
 *   4. Low confidence / no match -> leave it in inbox/, tag
 *      `needs-review` so it's visible to `gbrain schema review-orphans`
 *      and doesn't get re-classified (and re-billed) every tick.
 *
 * Config keys (defaults explicit):
 *   cycle.inbox_triage.enabled            (false)
 *   cycle.inbox_triage.max_pages_per_tick (10)
 *   cycle.inbox_triage.model              (utility tier -> Haiku)
 */

import type { BrainEngine } from '../engine.ts';
import type { PageType } from '../types.ts';
import { operations } from '../operations.ts';
import type { OperationContext } from '../operations.ts';
import { chat as gatewayChat, isAvailable } from '../ai/gateway.ts';
import { resolveModel } from '../model-config.ts';
import { loadActivePack } from '../schema-pack/index.ts';
import { serializeMarkdown } from '../markdown.ts';
import { loadConfig } from '../config.ts';

export interface InboxTriagePhaseOpts {
  dryRun?: boolean;
  signal?: AbortSignal;
  sourceId?: string;
}

export interface InboxTriagePhaseResult {
  phase: 'inbox_triage';
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  duration_ms: number;
  summary: string;
  details: Record<string, unknown>;
}

const CFG_PREFIX = 'cycle.inbox_triage';
const INBOX_PREFIX = 'inbox/';
const NEEDS_REVIEW_TAG = 'needs-review';

interface ResolvedConfig {
  enabled: boolean;
  maxPagesPerTick: number;
  model?: string;
}

async function loadCfg(engine: BrainEngine): Promise<ResolvedConfig> {
  const get = (k: string) => engine.getConfig(`${CFG_PREFIX}.${k}`);
  const [enabled, maxPages, model] = await Promise.all([
    get('enabled'),
    get('max_pages_per_tick'),
    get('model'),
  ]);

  const enabledFlag = (() => {
    if (enabled == null) return false;
    const v = enabled.trim().toLowerCase();
    return !['false', '0', 'no', 'off', ''].includes(v);
  })();

  const parseIntOrDefault = (raw: string | null, fallback: number): number => {
    if (raw == null) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 1 ? n : fallback;
  };

  return {
    enabled: enabledFlag,
    maxPagesPerTick: parseIntOrDefault(maxPages, 10),
    model: model ?? undefined,
  };
}

interface TriageDecision {
  type: string | null;
  target_slug: string | null;
  confidence: 'high' | 'low';
  reason: string;
}

/** Slug grammar shared across the codebase: lowercase alnum + hyphens, slash-separated. */
function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .split('/')
    .map((seg) => seg.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter((seg) => seg.length > 0)
    .join('/');
}

async function classifyInboxPage(
  content: string,
  slug: string,
  pageTypes: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }>,
  model: string,
): Promise<TriageDecision> {
  const typeList = pageTypes
    .map((t) => `- ${t.name} (directory: ${t.path_prefixes[0] ?? t.name + '/'})`)
    .join('\n');

  const sys = `You file raw captures dropped into a personal knowledge brain's inbox/ into their canonical home.

Available page types (name + the directory its pages live under):
${typeList}

Rule: the PRIMARY SUBJECT of the content determines where it goes, not the format or source.
If nothing fits confidently, say so — a wrong filing is worse than staying in inbox/.

Respond as strict JSON only:
{"type": "<one of the type names above, or null>", "target_slug": "<directory>/<short-kebab-slug>, or null", "confidence": "high"|"low", "reason": "<one short phrase>"}`;

  const truncated = content.length > 6000 ? content.slice(0, 6000) + '\n[...truncated...]' : content;

  const result = await gatewayChat({
    model,
    system: sys,
    messages: [{ role: 'user', content: `Capture at inbox slug "${slug}":\n\n${truncated}` }],
    maxTokens: 300,
  });

  const m = /\{[\s\S]*\}/.exec(result.text.trim());
  if (!m) return { type: null, target_slug: null, confidence: 'low', reason: 'unparseable classifier response' };
  try {
    const parsed = JSON.parse(m[0]) as Partial<TriageDecision>;
    const confidence = parsed.confidence === 'high' ? 'high' : 'low';
    const type = typeof parsed.type === 'string' && parsed.type.length > 0 ? parsed.type : null;
    const targetSlugRaw = typeof parsed.target_slug === 'string' ? parsed.target_slug : null;
    const target_slug = targetSlugRaw ? sanitizeSlug(targetSlugRaw) : null;
    const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : '';
    if (!type || !target_slug || target_slug === sanitizeSlug(slug)) {
      return { type: null, target_slug: null, confidence: 'low', reason: reason || 'no confident match' };
    }
    return { type, target_slug, confidence, reason };
  } catch {
    return { type: null, target_slug: null, confidence: 'low', reason: 'unparseable classifier response' };
  }
}

export async function runPhaseInboxTriage(
  engine: BrainEngine,
  opts: InboxTriagePhaseOpts = {},
): Promise<InboxTriagePhaseResult> {
  const cfg = await loadCfg(engine);
  const startedAt = Date.now();

  if (!cfg.enabled) {
    return {
      phase: 'inbox_triage',
      status: 'skipped',
      duration_ms: 0,
      summary: 'cycle.inbox_triage.enabled=false (default OFF)',
      details: { reason: 'disabled', enable_hint: 'gbrain config set cycle.inbox_triage.enabled true' },
    };
  }

  const candidates = await engine.listPages({
    slugPrefix: INBOX_PREFIX,
    limit: cfg.maxPagesPerTick,
    // No `created_asc` option on PageFilters; inbox pages are essentially
    // never updated post-creation, so updated_asc is oldest-first in practice.
    sort: 'updated_asc',
    ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
  });

  if (candidates.length === 0) {
    return {
      phase: 'inbox_triage',
      status: 'ok',
      duration_ms: Date.now() - startedAt,
      summary: 'no inbox/ pages to triage',
      details: { candidates: 0 },
    };
  }

  // Unlike enrich_thin, dry-run here still needs the classifier — the whole
  // point of a dry-run is previewing what each page WOULD be filed as, so
  // the gateway check applies regardless of opts.dryRun (only the actual
  // put_page/delete_page writes are skipped below).
  if (!isAvailable('chat')) {
    return {
      phase: 'inbox_triage',
      status: 'skipped',
      duration_ms: Date.now() - startedAt,
      summary: 'no chat gateway configured',
      details: { reason: 'no_chat_gateway', candidates: candidates.length },
    };
  }

  const model = cfg.model ?? await resolveModel(engine, {
    configKey: 'models.dream.inbox_triage',
    tier: 'utility',
    fallback: 'haiku',
  });

  const pack = await loadActivePack({ cfg: loadConfig(), remote: false, sourceId: opts.sourceId });

  const putPageOp = operations.find((o) => o.name === 'put_page');
  const deletePageOp = operations.find((o) => o.name === 'delete_page');
  if (!putPageOp || !deletePageOp) throw new Error('put_page/delete_page operation missing (gbrain build issue)');
  const opCtx: OperationContext = {
    engine,
    config: loadConfig() ?? { engine: 'pglite' as const },
    logger: {
      info: () => {},
      warn: (msg: string) => process.stderr.write(`[inbox_triage] WARN: ${msg}\n`),
      error: (msg: string) => process.stderr.write(`[inbox_triage] ERROR: ${msg}\n`),
    },
    dryRun: !!opts.dryRun,
    remote: false,
    // REQUIRED on OperationContext; 'default' matches buildOperationContext's
    // auto-fill for callers on a single-source brain.
    sourceId: opts.sourceId ?? 'default',
  };

  let filed = 0;
  let flagged = 0;
  let failed = 0;
  const details: Array<Record<string, unknown>> = [];

  for (const candidate of candidates) {
    if (opts.signal?.aborted) throw new Error('aborted');
    try {
      const page = await engine.getPage(candidate.slug, opts.sourceId ? { sourceId: opts.sourceId } : undefined);
      if (!page) continue;

      const decision = await classifyInboxPage(page.compiled_truth, page.slug, pack.manifest.page_types, model);

      if (decision.confidence !== 'high' || !decision.type || !decision.target_slug) {
        flagged++;
        details.push({ slug: candidate.slug, action: 'flagged', reason: decision.reason });
        if (!opts.dryRun) {
          const tags = await engine.getTags(candidate.slug, opts.sourceId ? { sourceId: opts.sourceId } : {}).catch(() => [] as string[]);
          if (!tags.includes(NEEDS_REVIEW_TAG)) {
            await engine.addTag(candidate.slug, NEEDS_REVIEW_TAG, opts.sourceId ? { sourceId: opts.sourceId } : undefined).catch(() => {});
          }
        }
        continue;
      }

      if (opts.dryRun) {
        filed++;
        details.push({ slug: candidate.slug, action: 'would_file', target_slug: decision.target_slug, type: decision.type });
        continue;
      }

      const tags = await engine.getTags(candidate.slug, opts.sourceId ? { sourceId: opts.sourceId } : {}).catch(() => [] as string[]);
      const filedTags = tags.filter((t) => t !== NEEDS_REVIEW_TAG);
      const newFrontmatter: Record<string, unknown> = {
        ...page.frontmatter,
        triaged_from: candidate.slug,
        triaged_at: new Date().toISOString(),
      };
      const content = serializeMarkdown(newFrontmatter, page.compiled_truth, page.timeline ?? '', {
        type: decision.type as PageType,
        title: page.title,
        tags: filedTags,
      });

      await putPageOp.handler(opCtx, { slug: decision.target_slug, content });
      await deletePageOp.handler(opCtx, { slug: candidate.slug });

      filed++;
      details.push({ slug: candidate.slug, action: 'filed', target_slug: decision.target_slug, type: decision.type });
    } catch (err) {
      failed++;
      details.push({ slug: candidate.slug, action: 'error', error: (err as Error).message });
    }
  }

  const status = failed > 0 ? 'warn' : 'ok';
  const summary = opts.dryRun
    ? `${filed} page(s) would be filed, ${flagged} would be flagged for review (dry-run)`
    : `${filed} page(s) filed, ${flagged} flagged needs-review, ${failed} failed`;

  return {
    phase: 'inbox_triage',
    status,
    duration_ms: Date.now() - startedAt,
    summary,
    details: {
      candidates: candidates.length,
      filed,
      flagged,
      failed,
      model,
      pack: pack.manifest.name,
      items: details,
    },
  };
}
