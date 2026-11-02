import React, { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, type ExploreEntity, type ExploreFacets, type ExploreRow, type ExploreRunEstimate, type ExploreRunResult, type ExploreThinkResult } from '../api';
import { Inline, Markdown } from '../components/Markdown';
import { PageDrawer } from '../components/PageDrawer';

type Mode = 'keyword' | 'hybrid' | 'think' | 'brainstorm' | 'lsd';

const MODES: Array<{ id: Mode; label: string; hint: string }> = [
  { id: 'keyword', label: 'Keyword', hint: 'Exact words and names.' },
  { id: 'hybrid', label: 'Hybrid', hint: 'Meaning and keywords together.' },
  { id: 'think', label: 'Think', hint: 'A cited answer across pages, takes and links. Calls a model.' },
  { id: 'brainstorm', label: 'Brainstorm', hint: 'Ideas from collisions between distant pages. Paid run.' },
  { id: 'lsd', label: 'LSD', hint: 'Brainstorm with the judge inverted, for stranger ideas. Paid run.' },
];

// Imported sessions outnumber everything else, so they stay out until asked for.
const DEFAULT_HIDDEN_TYPES = ['conversation'];

function usd(value: number) {
  return `$${value.toFixed(2)}`;
}

function message(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

export function ExplorePage() {
  const [facets, setFacets] = useState<ExploreFacets | null>(null);
  const [sidebarError, setSidebarError] = useState('');
  const [entities, setEntities] = useState<ExploreEntity[] | null>(null);
  const [entityFilter, setEntityFilter] = useState('');
  const [source, setSource] = useState('');
  const [hiddenTypes, setHiddenTypes] = useState<string[]>(DEFAULT_HIDDEN_TYPES);

  const [mode, setMode] = useState<Mode>('keyword');
  const [query, setQuery] = useState('');
  const [ranQuery, setRanQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [rows, setRows] = useState<ExploreRow[] | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [think, setThink] = useState<ExploreThinkResult | null>(null);
  const [run, setRun] = useState<ExploreRunResult | null>(null);
  const [estimate, setEstimate] = useState<ExploreRunEstimate | null>(null);
  const [capUsd, setCapUsd] = useState(2);
  const [saveRun, setSaveRun] = useState(false);
  const [showFiltered, setShowFiltered] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [open, setOpen] = useState<{ slug: string; source?: string } | null>(null);
  const stop = useRef<AbortController | null>(null);

  useEffect(() => {
    api.exploreFacets().then(setFacets).catch(cause => setSidebarError(message(cause, 'Sources and types could not be loaded.')));
  }, []);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      api.exploreEntities(entityFilter, source || undefined)
        .then(list => { if (active) setEntities(list); })
        .catch(cause => { if (active) setSidebarError(message(cause, 'Entities could not be loaded.')); });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [entityFilter, source]);

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const types = useMemo(() => {
    if (!facets || hiddenTypes.length === 0) return undefined;
    return facets.types.map(row => row.type).filter(type => !hiddenTypes.includes(type));
  }, [facets, hiddenTypes]);

  const clearResults = () => {
    setRows(null); setNextOffset(null); setThink(null); setRun(null); setEstimate(null);
    setError(''); setProgress([]); setElapsed(0); setShowFiltered(false);
  };

  const runSearch = async (text: string, searchMode: 'keyword' | 'hybrid', offset = 0) => {
    setBusy(true); setError('');
    try {
      const result = await api.exploreSearch({ query: text, mode: searchMode, source: source || undefined, types, offset });
      setRows(previous => (offset > 0 && previous ? [...previous, ...result.rows] : result.rows));
      setNextOffset(result.next_offset);
    } catch (cause) {
      setError(message(cause, 'The search failed.'));
    } finally { setBusy(false); }
  };

  const runThink = async (text: string) => {
    const controller = new AbortController();
    stop.current = controller;
    setBusy(true); setRunning(true);
    try {
      setThink(await api.exploreThink({ question: text, source: source || undefined }, line => setProgress(lines => [...lines, line]), controller.signal));
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(cause, 'Think failed.'));
    } finally { setBusy(false); setRunning(false); stop.current = null; }
  };

  const prepareRun = async (profile: 'brainstorm' | 'lsd') => {
    setBusy(true);
    try {
      const next = await api.exploreRunEstimate(profile);
      setEstimate(next);
      setCapUsd(Math.min(next.max_cap_usd, Math.max(1, Math.ceil(next.estimated_usd * 2))));
    } catch (cause) {
      setError(message(cause, 'The cost estimate failed.'));
    } finally { setBusy(false); }
  };

  const startRun = async () => {
    if (mode !== 'brainstorm' && mode !== 'lsd') return;
    const controller = new AbortController();
    stop.current = controller;
    setBusy(true); setError(''); setProgress([]); setElapsed(0); setEstimate(null); setRunning(true);
    try {
      setRun(await api.exploreRun({ question: ranQuery, profile: mode, source: source || undefined, max_usd: capUsd, save: saveRun },
        line => setProgress(lines => [...lines, line]), controller.signal));
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(cause, 'The run failed.'));
    } finally { setBusy(false); setRunning(false); stop.current = null; }
  };

  const submit = (nextMode: Mode, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    clearResults();
    setRanQuery(trimmed);
    if (nextMode === 'keyword' || nextMode === 'hybrid') void runSearch(trimmed, nextMode);
    else if (nextMode === 'think') void runThink(trimmed);
    else void prepareRun(nextMode);
  };

  // Free searches follow the sidebar; a model call waits for the button.
  useEffect(() => {
    if (ranQuery && (mode === 'keyword' || mode === 'hybrid')) void runSearch(ranQuery, mode);
  }, [source, types]);

  const onSubmit = (event: FormEvent) => { event.preventDefault(); submit(mode, query); };

  const chooseMode = (next: Mode) => {
    if (busy) return;
    setMode(next);
    clearResults();
    setRanQuery('');
    if ((next === 'keyword' || next === 'hybrid') && query.trim()) submit(next, query);
  };

  const toggleType = (type: string) => {
    setHiddenTypes(hidden => (hidden.includes(type) ? hidden.filter(name => name !== type) : [...hidden, type]));
  };

  const openPage = (slug: string, pageSource?: string) => setOpen({ slug, source: pageSource });
  const activeMode = MODES.find(item => item.id === mode)!;
  const filteredIdeas = run ? run.ideas.filter(idea => !idea.passes).length : 0;
  const ideas = run ? run.ideas.filter(idea => idea.passes || showFiltered) : [];

  return <div className="explore">
    <aside className="explore-sidebar" aria-label="Brain contents">
      {sidebarError && <p role="alert" className="explore-error">{sidebarError}</p>}
      <h2 className="section-title">Sources</h2>
      <label className="facet"><input type="radio" name="explore-source" checked={source === ''} onChange={() => setSource('')} /><span>All sources</span></label>
      {facets?.sources.map(item => <label className="facet" key={item.id}>
        <input type="radio" name="explore-source" checked={source === item.id} onChange={() => setSource(item.id)} />
        <span>{item.name}</span><span className="facet-count">{item.pages}</span>
      </label>)}
      <h2 className="section-title">Types</h2>
      {facets?.types.map(item => <label className="facet" key={item.type}>
        <input type="checkbox" checked={!hiddenTypes.includes(item.type)} onChange={() => toggleType(item.type)} />
        <span>{item.type}</span><span className="facet-count">{item.pages}</span>
      </label>)}
      <p className="explore-note">Types filter Keyword and Hybrid only.</p>
      <h2 className="section-title">Entities</h2>
      <input aria-label="Filter entities" placeholder="Filter" value={entityFilter} onChange={event => setEntityFilter(event.target.value)} />
      <ul className="entity-list">
        {entities?.map(entity => <li key={`${entity.source_id}:${entity.slug}`}>
          <a className="md-link" onClick={() => openPage(entity.slug, entity.source_id)}>{entity.title || entity.slug}</a>
          <span className="facet-count">{entity.type}</span>
        </li>)}
      </ul>
      {entities?.length === 0 && <p className="explore-note">No matching entities.</p>}
    </aside>

    <section className="explore-main">
      <h1 className="page-title">Search</h1>
      <form className="explore-form" onSubmit={onSubmit}>
        <input aria-label="Search the brain" placeholder="Search the brain" value={query} onChange={event => setQuery(event.target.value)} />
        <button className="btn btn-primary" type="submit" disabled={busy || !query.trim()}>{mode === 'brainstorm' || mode === 'lsd' ? 'Estimate' : 'Search'}</button>
      </form>
      <div className="tabs" role="tablist">
        {MODES.map(item => <a key={item.id} role="tab" aria-selected={mode === item.id} className={`tab ${mode === item.id ? 'active' : ''}`} onClick={() => chooseMode(item.id)}>{item.label}</a>)}
      </div>
      <p className="explore-note">{activeMode.hint}</p>

      {error && <p role="alert" className="explore-error">{error}</p>}

      {busy && (mode === 'keyword' || mode === 'hybrid') && <p className="explore-note">Searching</p>}

      {estimate && !busy && <div className="explore-run-panel">
        <p>Estimated cost <strong>{usd(estimate.estimated_usd)}</strong> on <span className="mono">{estimate.model}</span></p>
        <label className="facet"><span>Stop at</span>
          <input type="number" min={0.5} max={estimate.max_cap_usd} step={0.5} value={capUsd} onChange={event => setCapUsd(Number(event.target.value))} style={{ width: 80 }} />
          <span className="facet-count">USD, {usd(estimate.max_cap_usd)} at most</span>
        </label>
        <label className="facet"><input type="checkbox" checked={saveRun} onChange={event => setSaveRun(event.target.checked)} /><span>Save the result to the brain</span></label>
        <button className="btn btn-primary" onClick={() => void startRun()}>Run {activeMode.label}</button>
      </div>}

      {running && <div className="explore-progress">
        <p className="explore-note">Working for {elapsed}s</p>
        {progress.slice(-6).map((line, index) => <p key={index} className="result-meta">{line}</p>)}
        <button className="btn btn-secondary" onClick={() => stop.current?.abort()}>Stop</button>
      </div>}

      {think && <article className="think-answer">
        <Markdown text={think.answer} onOpen={slug => openPage(slug)} />
        {think.gaps.length > 0 && <>
          <h2 className="section-title">Gaps</h2>
          <ul className="md-list">{think.gaps.map((gap, index) => <li key={index}><Inline text={gap} onOpen={slug => openPage(slug)} /></li>)}</ul>
        </>}
        {think.citations.length > 0 && <>
          <h2 className="section-title">Sources</h2>
          <ol className="think-sources">
            {[...new Map(think.citations.map(citation => [citation.page_slug, citation])).values()].map(citation =>
              <li key={citation.page_slug}><a className="md-link" onClick={() => openPage(citation.page_slug, citation.source_id ?? undefined)}>{citation.page_slug}</a></li>)}
          </ol>
        </>}
        {think.warnings.length > 0 && <p className="explore-note">{think.warnings.join(', ')}</p>}
      </article>}

      {run && <div>
        <p className="explore-note">
          {run.ideas.length - filteredIdeas} of {run.ideas.length} ideas passed the judge. Cost {usd(run.cost.actual_usd)}.
          {run.judge_failed && ' The judge failed, so these are unscored.'}
          {run.saved && (run.saved.dbSaved ? ' Saved.' : ' Not saved.')}
        </p>
        {ideas.map(idea => <article className="idea-card" key={idea.id}>
          <p>{idea.text}</p>
          <p className="result-meta">
            <a className="md-link" onClick={() => openPage(idea.close_slug)}>{idea.close_slug}</a>
            {' × '}
            <a className="md-link" onClick={() => openPage(idea.far_slug)}>{idea.far_slug}</a>
            {` · distance ${idea.distance_score.toFixed(2)}`}
            {idea.judge && ` · score ${idea.judge.weighted_score.toFixed(1)}`}
          </p>
          {idea.judge?.note && <p className="explore-note">{idea.judge.note}</p>}
        </article>)}
        {filteredIdeas > 0 && <button className="btn btn-secondary" onClick={() => setShowFiltered(shown => !shown)}>{showFiltered ? 'Hide' : 'Show'} {filteredIdeas} filtered</button>}
      </div>}

      {rows && rows.length === 0 && <p className="explore-empty">Nothing matched. Try Hybrid, or turn more types on.</p>}
      {rows?.map(row => <article className="result" key={row.key}>
        <p className="result-meta">{row.slug ? `${row.slug} · ` : ''}{row.type}{row.date ? ` · ${String(row.date).slice(0, 10)}` : ''}{row.stale ? ' · stale' : ''}</p>
        {row.slug
          ? <a className="result-title" onClick={() => openPage(row.slug!, row.source_id)}>{row.title}</a>
          : <span className="result-title result-title-plain">{row.title}</span>}
        <p className="result-snippet">{row.snippet}</p>
      </article>)}
      {nextOffset !== null && !busy && <button className="btn btn-secondary" onClick={() => void runSearch(ranQuery, mode as 'keyword' | 'hybrid', nextOffset)}>More results</button>}
    </section>

    {open && <PageDrawer slug={open.slug} source={open.source} onOpen={openPage} onClose={() => setOpen(null)} />}
  </div>;
}
