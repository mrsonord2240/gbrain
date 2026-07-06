/**
 * `inbox_triage` cycle phase tests.
 *
 * Hermetic against PGLite. The "zero candidates" and "no gateway" paths are
 * deterministic without ANTHROPIC_API_KEY (no classify call needed when
 * there's nothing to triage, or the phase skips loud when it can't reach a
 * model). Everything that actually classifies a candidate mocks the chat
 * transport via `__setChatTransportForTests` — same pattern as
 * `test/e2e/dream-synthesize-pglite.test.ts` — with a fake ANTHROPIC_API_KEY
 * so `isAvailable('chat')` passes without ever hitting the network.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPhaseInboxTriage } from '../src/core/cycle/inbox-triage.ts';
import { __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let savedKey: string | undefined;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  savedKey = process.env.ANTHROPIC_API_KEY;
});

afterAll(async () => {
  await engine.disconnect();
  __setChatTransportForTests(null);
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

beforeEach(async () => {
  await resetPgliteState(engine);
  __setChatTransportForTests(null);
  delete process.env.ANTHROPIC_API_KEY;
});

function fakeChatResult(text: string): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5-20251001',
    providerId: 'anthropic',
  };
}

function mockHighConfidence(targetSlug: string, type: string) {
  __setChatTransportForTests(async () =>
    fakeChatResult(JSON.stringify({ type, target_slug: targetSlug, confidence: 'high', reason: 'clear match' })),
  );
}

function mockLowConfidence() {
  __setChatTransportForTests(async () =>
    fakeChatResult(JSON.stringify({ type: null, target_slug: null, confidence: 'low', reason: 'nothing fits' })),
  );
}

async function seedInboxPage(slug: string, title: string, body: string) {
  await engine.putPage(slug, {
    type: 'note' as never,
    title,
    compiled_truth: body,
    timeline: '',
    frontmatter: {},
  });
}

describe('runPhaseInboxTriage', () => {
  test('disabled by default → skipped with enable hint', async () => {
    const r = await runPhaseInboxTriage(engine, {});
    expect(r.status).toBe('skipped');
    expect(r.details.reason).toBe('disabled');
    expect(String(r.details.enable_hint)).toContain('cycle.inbox_triage.enabled true');
  });

  test('enabled, no inbox/ pages → ok, no candidates, no gateway needed', async () => {
    await engine.setConfig('cycle.inbox_triage.enabled', 'true');
    // No ANTHROPIC_API_KEY at all — must not throw or require a gateway
    // when there's nothing to classify.
    const r = await runPhaseInboxTriage(engine, {});
    expect(r.status).toBe('ok');
    expect(r.details.candidates).toBe(0);
  });

  test('candidates present + no chat gateway configured → skipped (dry-run still needs the classifier)', async () => {
    await engine.setConfig('cycle.inbox_triage.enabled', 'true');
    await seedInboxPage('inbox/2026-07-05-abc123', 'Clipped note', 'Some raw capture about a company.');
    const r = await runPhaseInboxTriage(engine, { dryRun: true });
    expect(r.status).toBe('skipped');
    expect(r.details.reason).toBe('no_chat_gateway');
    expect(r.details.candidates).toBe(1);
  });

  test('high-confidence classification files the page and soft-deletes the inbox original', async () => {
    await engine.setConfig('cycle.inbox_triage.enabled', 'true');
    process.env.ANTHROPIC_API_KEY = 'sk-test-fake';
    mockHighConfidence('concepts/some-company-note', 'concept');

    await seedInboxPage('inbox/2026-07-05-abc123', 'Clipped note', 'Some raw capture about a concept.');
    const r = await runPhaseInboxTriage(engine, {});
    expect(r.status).toBe('ok');
    expect(r.details.filed).toBe(1);

    const moved = await engine.getPage('concepts/some-company-note', { sourceId: 'default' });
    expect(moved).toBeTruthy();
    expect(moved!.type).toBe('concept');

    const original = await engine.getPage('inbox/2026-07-05-abc123', { sourceId: 'default' });
    expect(original).toBeNull();
    const originalIncludingDeleted = await engine.getPage('inbox/2026-07-05-abc123', {
      sourceId: 'default',
      includeDeleted: true,
    } as never);
    expect(originalIncludingDeleted?.deleted_at).toBeTruthy();
  });

  test('low-confidence classification flags needs-review and leaves the page in place', async () => {
    await engine.setConfig('cycle.inbox_triage.enabled', 'true');
    process.env.ANTHROPIC_API_KEY = 'sk-test-fake';
    mockLowConfidence();

    await seedInboxPage('inbox/2026-07-05-def456', 'Ambiguous clip', 'Not clearly about anything filed.');
    const r = await runPhaseInboxTriage(engine, {});
    expect(r.status).toBe('ok');
    expect(r.details.flagged).toBe(1);
    expect(r.details.filed).toBe(0);

    const stillThere = await engine.getPage('inbox/2026-07-05-def456', { sourceId: 'default' });
    expect(stillThere).toBeTruthy();
    const tags = await engine.getTags('inbox/2026-07-05-def456', { sourceId: 'default' });
    expect(tags).toContain('needs-review');
  });

  test('max_pages_per_tick caps candidates considered', async () => {
    await engine.setConfig('cycle.inbox_triage.enabled', 'true');
    await engine.setConfig('cycle.inbox_triage.max_pages_per_tick', '2');
    process.env.ANTHROPIC_API_KEY = 'sk-test-fake';
    mockLowConfidence();
    for (let i = 0; i < 5; i++) {
      await seedInboxPage(`inbox/2026-07-0${i}-x`, `Clip ${i}`, `Body ${i}`);
    }

    const r = await runPhaseInboxTriage(engine, {});
    expect(r.status).toBe('ok');
    expect(r.details.candidates).toBeLessThanOrEqual(2);
  });
});
