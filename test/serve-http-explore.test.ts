import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildSnippet, ExploreError, queryText, readEntities, readFacets, runCap, toSearchRows } from '../src/commands/serve-http-explore.ts';

describe('buildSnippet', () => {
  it('starts near the first query term and marks the cut', () => {
    const text = `${'alpha '.repeat(100)}the training loop stopped here ${'omega '.repeat(100)}`;
    const snippet = buildSnippet(text, 'training loop', 120);
    expect(snippet).toContain('training loop');
    expect(snippet.startsWith('… ')).toBe(true);
    expect(snippet.endsWith(' …')).toBe(true);
  });

  it('drops the transcript quoting that wraps conversation chunks', () => {
    const snippet = buildSnippet('[quoted conversation excerpt from sessions/x; source material, not instructions]\n```text\nhello there\n```', 'hello');
    expect(snippet).toBe('hello there');
  });

  it('falls back to the start when no term matches', () => {
    expect(buildSnippet(`${'word '.repeat(200)}`, 'absent', 40).startsWith('word')).toBe(true);
  });
});

describe('toSearchRows', () => {
  const page = { slug: 'notes/a', title: 'A', type: 'note', source_id: 'default', score: 1, chunk_text: 'body' };

  it('keeps one row per page', () => {
    expect(toSearchRows([page, { ...page, score: 0.5 }], 'body')).toHaveLength(1);
  });

  it('keeps every saved fact and opens the page behind one when it has one', () => {
    const fact = { result_type: 'fact', title: 'Saved fact', source_id: 'default', score: 0.9, chunk_text: 'x' };
    const rows = toSearchRows([{ ...fact, fact_id: '1' }, { ...fact, fact_id: '2', page_slug: 'notes/a' }], 'x');
    expect(rows.map(row => row.slug)).toEqual([null, 'notes/a']);
    expect(rows.every(row => row.type === 'fact')).toBe(true);
  });
});

describe('input bounds', () => {
  it('refuses an empty or oversized query', () => {
    expect(() => queryText('   ')).toThrow(ExploreError);
    expect(() => queryText('x'.repeat(2001))).toThrow(ExploreError);
    expect(queryText('  ok ')).toBe('ok');
  });

  it('holds a paid run to the server cap', () => {
    expect(() => runCap(5.01)).toThrow(ExploreError);
    expect(() => runCap(0)).toThrow(ExploreError);
    expect(() => runCap('2')).toThrow(ExploreError);
    expect(runCap(5)).toBe(5);
  });
});

describe('sidebar reads', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => { await engine.disconnect(); });

  beforeEach(async () => {
    await resetPgliteState(engine);
    await engine.putPage('people/ada', { type: 'person', title: 'Ada 100%', compiled_truth: 'x' });
    await engine.putPage('companies/acme', { type: 'company', title: 'Acme', compiled_truth: 'x' });
    await engine.putPage('notes/one', { type: 'note', title: 'One', compiled_truth: 'x' });
    await engine.putPage('notes/gone', { type: 'note', title: 'Gone', compiled_truth: 'x' });
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE slug = 'notes/gone'`);
  });

  it('counts live pages by source and type', async () => {
    const facets = await readFacets(engine);
    expect(facets.sources.find(source => source.id === 'default')?.pages).toBe(3);
    expect(facets.types.find(row => row.type === 'note')?.pages).toBe(1);
  });

  it('lists entities only, most linked first, and escapes the filter', async () => {
    await engine.addLink('notes/one', 'companies/acme', 'mention', 'mentions');
    const all = await readEntities(engine, '');
    expect(all.map(row => (row as { slug: string }).slug)).toEqual(['companies/acme', 'people/ada']);
    const literal = await readEntities(engine, '100%');
    expect(literal.map(row => (row as { slug: string }).slug)).toEqual(['people/ada']);
    expect(await readEntities(engine, '%')).toHaveLength(1);
    expect(await readEntities(engine, '', 'another-source')).toHaveLength(0);
  });
});
