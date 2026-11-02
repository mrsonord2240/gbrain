/**
 * Owner search for the admin dashboard: sidebar facets and entities, keyword
 * and hybrid search, think, page reads, and metered brainstorm / LSD runs.
 * Reads go through the normal operation dispatcher as the local owner, so no
 * client grant scopes them. `think` never saves here; a brainstorm saves only
 * when the owner asks. Every route carries requireAdmin
 * (test/serve-http-admin-route-guard.test.ts).
 */
import express, { type Express, type RequestHandler, type Response } from 'express';
import type { BrainEngine } from '../core/engine.ts';
import type { GBrainConfig } from '../core/config.ts';
import { dispatchToolCall } from '../mcp/dispatch.ts';

const ALL_SOURCES = '__all__';
const MAX_QUERY_CHARS = 2000;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const SNIPPET_CHARS = 320;
const MAX_RUN_CAP_USD = 5;
const HEARTBEAT_MS = 5000;
const ENTITY_LIST_LIMIT = 200;

export class ExploreError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

type OpParams = Record<string, unknown>;

/** One operation as the local owner. A tool error becomes an ExploreError carrying its own message. */
async function runOp(engine: BrainEngine, config: GBrainConfig, name: string, params: OpParams, sourceId?: string): Promise<any> {
  const result = await dispatchToolCall(engine, name, params, { remote: false, transport: 'http', config, ...(sourceId ? { sourceId } : {}) });
  const text = (result.content as Array<{ text?: string }>)[0]?.text ?? 'null';
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  if (result.isError) {
    const code = typeof body?.code === 'string' ? body.code : '';
    throw new ExploreError(typeof body?.message === 'string' ? body.message : `${name} failed`, /not_found/.test(code) ? 404 : 502);
  }
  return body;
}

export function queryText(value: unknown, name = 'query'): string {
  if (typeof value !== 'string' || !value.trim()) throw new ExploreError(`${name} is required`);
  if (value.length > MAX_QUERY_CHARS) throw new ExploreError(`${name} is over ${MAX_QUERY_CHARS} characters`);
  return value.trim();
}

function optionalName(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^[\w.-]{1,128}$/.test(value)) throw new ExploreError(`invalid ${name}`);
  return value;
}

function pageTypes(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new ExploreError('invalid types');
  return value.map(type => {
    const checked = optionalName(type, 'types');
    if (!checked) throw new ExploreError('invalid types');
    return checked;
  });
}

function boundedInt(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) throw new ExploreError('invalid paging value');
  return value;
}

/** A Google-style excerpt: the first stretch of the chunk that mentions a query term, without the transcript quoting. */
export function buildSnippet(chunkText: string, query: string, maxChars = SNIPPET_CHARS): string {
  const clean = chunkText
    .replace(/^\[quoted [^\]]*\]\s*/, '')
    .replace(/^```\w*\n?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= maxChars) return clean;
  const lower = clean.toLowerCase();
  const hits = query.toLowerCase().split(/\W+/).filter(term => term.length > 2)
    .map(term => lower.indexOf(term)).filter(index => index >= 0);
  const hit = hits.length ? Math.min(...hits) : 0;
  const start = hit > 80 ? clean.indexOf(' ', hit - 80) + 1 : 0;
  const body = clean.slice(start, start + maxChars).trim();
  return `${start > 0 ? '… ' : ''}${body}${start + maxChars < clean.length ? ' …' : ''}`;
}

export interface SearchRow {
  key: string;
  /** The page to open; a saved fact may have none. */
  slug: string | null;
  title: string; type: string; source_id: string;
  score: number; date: string | null; snippet: string; stale: boolean;
}

/** One row per page or saved fact, best hit first, reduced to what a result line shows. */
export function toSearchRows(rows: any[], query: string): SearchRow[] {
  const seen = new Set<string>();
  const out: SearchRow[] = [];
  for (const row of rows) {
    const fact = row.result_type === 'fact';
    const slug: string | null = fact ? row.page_slug ?? null : row.slug;
    const key = fact ? `fact:${row.fact_id}` : `${row.source_id}:${row.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key, slug, title: row.title || slug || 'Saved fact', type: fact ? 'fact' : row.type, source_id: row.source_id,
      score: row.score, date: row.effective_date ?? null, stale: row.stale === true,
      snippet: buildSnippet(String(row.chunk_text ?? ''), query),
    });
  }
  return out;
}

function failure(res: Response, error: unknown): void {
  if (res.headersSent) { res.end(); return; }
  if (error instanceof ExploreError) { res.status(error.status).json({ error: error.message }); return; }
  res.status(503).json({ error: 'service_unavailable' });
}

/** Newline-delimited JSON, so a long run shows progress and a quiet model cannot look like a dead connection. */
async function streamRun(res: Response, work: (progress: (message: string) => void) => Promise<unknown>): Promise<void> {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  const send = (line: object) => { if (!res.writableEnded) res.write(`${JSON.stringify(line)}\n`); };
  const heartbeat = setInterval(() => send({ alive: true }), HEARTBEAT_MS);
  try {
    send({ result: await work(message => send({ progress: message.trim() })) });
  } catch (error) {
    const envelope = (error as { envelope?: { message?: string; hint?: string } }).envelope;
    send({ error: envelope?.message ?? (error instanceof Error ? error.message : 'The run failed') });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}

export async function readFacets(engine: BrainEngine) {
  const { listSources } = await import('../core/sources-ops.ts');
  const [sources, counts] = await Promise.all([
    listSources(engine),
    engine.executeRaw<{ source_id: string; type: string; pages: number }>(
      `SELECT source_id, type::text AS type, count(*)::int AS pages FROM pages WHERE deleted_at IS NULL GROUP BY 1, 2`),
  ]);
  const bySource = new Map<string, number>();
  const byType = new Map<string, number>();
  for (const row of counts) {
    bySource.set(row.source_id, (bySource.get(row.source_id) ?? 0) + row.pages);
    byType.set(row.type, (byType.get(row.type) ?? 0) + row.pages);
  }
  return {
    sources: sources.map(({ id, name }) => ({ id, name, pages: bySource.get(id) ?? 0 })),
    types: [...byType].map(([type, pages]) => ({ type, pages })).sort((a, b) => b.pages - a.pages),
  };
}

/** People, companies and projects, most linked first. */
export async function readEntities(engine: BrainEngine, filter: string, sourceId?: string) {
  const pattern = `%${filter.replace(/[\\%_]/g, '\\$&')}%`;
  return engine.executeRaw(
    `SELECT p.slug, p.title, p.type::text AS type, p.source_id,
            (SELECT count(*)::int FROM links l WHERE l.to_page_id = p.id) AS backlinks
       FROM pages p
      WHERE p.deleted_at IS NULL AND p.type::text IN ('person', 'company', 'project')
        AND (p.title ILIKE $1 OR p.slug ILIKE $1)
        AND ($2::text IS NULL OR p.source_id = $2)
      ORDER BY backlinks DESC, p.title
      LIMIT ${ENTITY_LIST_LIMIT}`,
    [pattern, sourceId ?? null],
  );
}

async function readPageBundle(engine: BrainEngine, config: GBrainConfig, slug: string, sourceId?: string) {
  const source = sourceId ?? ALL_SOURCES;
  const page = await runOp(engine, config, 'get_page', { slug, source_id: source }, sourceId);
  const [backlinks, timeline, facts] = await Promise.allSettled([
    runOp(engine, config, 'get_backlinks', { slug }, page.source_id),
    runOp(engine, config, 'get_timeline', { slug, limit: 50 }, page.source_id),
    runOp(engine, config, 'recall', { entity: slug, limit: 50 }, page.source_id),
  ]);
  const settled = (result: PromiseSettledResult<any>) => (result.status === 'fulfilled' ? result.value : null);
  return {
    slug: page.slug, title: page.title || page.slug, type: page.type, source_id: page.source_id,
    updated_at: page.updated_at, body: page.compiled_truth ?? '',
    backlinks: settled(backlinks), timeline: settled(timeline), facts: settled(facts)?.facts ?? settled(facts),
  };
}

type RunProfile = 'brainstorm' | 'lsd';

async function brainstormProfile(value: unknown) {
  const { BRAINSTORM_PROFILE, LSD_PROFILE } = await import('../core/brainstorm/orchestrator.ts');
  if (value === 'brainstorm') return BRAINSTORM_PROFILE;
  if (value === 'lsd') return LSD_PROFILE;
  throw new ExploreError('profile must be brainstorm or lsd');
}

export async function estimateRun(engine: BrainEngine, config: GBrainConfig, value: unknown) {
  const { estimateCost, resolveBrainstormChatModel, resolveBrainstormJudgeModel } = await import('../core/brainstorm/orchestrator.ts');
  const { configuredChatModel } = await import('../core/brainstorm/cost-gate.ts');
  const { loadPricingOverrides } = await import('../core/budget/budget-tracker.ts');
  const profile = await brainstormProfile(value);
  const model = resolveBrainstormChatModel(config, undefined, configuredChatModel());
  const judge = (await resolveBrainstormJudgeModel(engine, undefined)) ?? model;
  return { estimated_usd: estimateCost(profile, model, await loadPricingOverrides(engine), judge), model, max_cap_usd: MAX_RUN_CAP_USD };
}

export function runCap(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_RUN_CAP_USD) {
    throw new ExploreError(`max_usd must be above 0 and at most ${MAX_RUN_CAP_USD}`);
  }
  return value;
}

export function mountAdminExplore(app: Express, requireAdmin: RequestHandler, engine: BrainEngine, config: GBrainConfig): void {
  // One paid run at a time: a double submit must not spend twice.
  let paidRunActive = false;

  app.get('/admin/api/explore/facets', requireAdmin, async (_req, res) => {
    try { res.json(await readFacets(engine)); } catch (e) { failure(res, e); }
  });

  app.get('/admin/api/explore/entities', requireAdmin, async (req, res) => {
    try {
      const filter = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
      res.json(await readEntities(engine, filter, optionalName(req.query.source, 'source')));
    } catch (e) { failure(res, e); }
  });

  app.get('/admin/api/explore/page', requireAdmin, async (req, res) => {
    try {
      const slug = queryText(req.query.slug, 'slug');
      res.json(await readPageBundle(engine, config, slug, optionalName(req.query.source, 'source')));
    } catch (e) { failure(res, e); }
  });

  app.post('/admin/api/explore/search', requireAdmin, express.json(), async (req, res) => {
    try {
      const body = req.body ?? {};
      const query = queryText(body.query);
      const limit = boundedInt(body.limit, DEFAULT_LIMIT, MAX_LIMIT) || DEFAULT_LIMIT;
      const offset = boundedInt(body.offset, 0, 10_000);
      const types = pageTypes(body.types);
      const params: OpParams = { query, limit, offset, source_id: optionalName(body.source, 'source') ?? ALL_SOURCES, ...(types ? { types } : {}) };
      const hybrid = body.mode === 'hybrid';
      if (!hybrid && body.mode !== 'keyword') throw new ExploreError('mode must be keyword or hybrid');
      const rows = await runOp(engine, config, hybrid ? 'query' : 'search', hybrid ? params : { ...params, match: 'keyword' });
      const list = Array.isArray(rows) ? rows : rows?.results ?? [];
      res.json({ rows: toSearchRows(list, query), next_offset: list.length >= limit ? offset + limit : null });
    } catch (e) { failure(res, e); }
  });

  app.post('/admin/api/explore/think', requireAdmin, express.json(), async (req, res) => {
    let question: string;
    let source: string | undefined;
    try {
      question = queryText(req.body?.question, 'question');
      source = optionalName(req.body?.source, 'source');
    } catch (e) { failure(res, e); return; }
    await streamRun(res, async () => {
      const result = await runOp(engine, config, 'think', { question }, source);
      return { answer: result.answer, gaps: [result.gaps ?? []].flat(), citations: result.citations ?? [], warnings: result.warnings ?? [], status: result.synthesis_status };
    });
  });

  app.get('/admin/api/explore/run-estimate', requireAdmin, async (req, res) => {
    try { res.json(await estimateRun(engine, config, req.query.profile)); } catch (e) { failure(res, e); }
  });

  app.post('/admin/api/explore/run', requireAdmin, express.json(), async (req, res) => {
    let question: string;
    let source: string | undefined;
    let maxUsd: number;
    let profile: Awaited<ReturnType<typeof brainstormProfile>>;
    try {
      question = queryText(req.body?.question, 'question');
      source = optionalName(req.body?.source, 'source');
      maxUsd = runCap(req.body?.max_usd);
      profile = await brainstormProfile(req.body?.profile as RunProfile);
      if (paidRunActive) throw new ExploreError('A run is already in progress', 409);
    } catch (e) { failure(res, e); return; }
    paidRunActive = true;
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      await streamRun(res, async progress => {
        const { runBrainstorm } = await import('../core/brainstorm/orchestrator.ts');
        const { buildIdeaSlug, saveBrainstormResult } = await import('./brainstorm.ts');
        const save = req.body?.save === true;
        const freshSlug = buildIdeaSlug(question, profile.label);
        const result = await runBrainstorm(engine, config, {
          question, profile, skipCostPreview: true, maxCostUsd: maxUsd, maxCostFlag: '--max-usd',
          abortSignal: abort.signal, stderrWrite: progress,
          ...(source ? { sourceId: source } : {}),
          ...(save ? { ideaSlug: freshSlug } : {}),
        });
        if (!save) return { ...result, saved: null };
        const outcome = await saveBrainstormResult(engine, result, profile.label, freshSlug);
        return { ...result, saved: outcome };
      });
    } finally {
      paidRunActive = false;
    }
  });
}
