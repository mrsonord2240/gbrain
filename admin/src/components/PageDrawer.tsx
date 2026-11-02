import React, { useEffect, useState } from 'react';
import { api, type ExplorePage } from '../api';
import { Markdown } from './Markdown';

function shortDate(value: string | null | undefined) {
  return value ? String(value).slice(0, 10) : '';
}

function Unavailable({ what }: { what: string }) {
  return <p className="explore-note">{what} could not be loaded.</p>;
}

export function PageDrawer({ slug, source, onOpen, onClose }: {
  slug: string;
  source?: string;
  onOpen: (slug: string, source?: string) => void;
  onClose: () => void;
}) {
  const [page, setPage] = useState<ExplorePage | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setPage(null); setError('');
    api.explorePage(slug, source)
      .then(result => { if (active) setPage(result); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'The page could not be loaded.'); });
    return () => { active = false; };
  }, [slug, source]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const openHere = (target: string) => onOpen(target, page?.source_id);
  const linkedFrom = page?.backlinks ? [...new Set(page.backlinks.map(link => link.from_slug))] : null;

  return <>
    <div className="drawer-overlay" onClick={onClose} />
    <aside className="drawer page-drawer" aria-label={`Page ${slug}`}>
      <button className="drawer-close" aria-label="Close page" onClick={onClose}>✕</button>
      {error && <p role="alert" className="explore-error">{error}</p>}
      {!page && !error && <p className="explore-note">Loading {slug}</p>}
      {page && <>
        <h2 className="page-drawer-title">{page.title}</h2>
        <p className="result-meta">{page.slug} · {page.type} · {page.source_id} · updated {shortDate(page.updated_at)}</p>
        <Markdown text={page.body} onOpen={openHere} />
        <h3 className="section-title">Facts</h3>
        {page.facts === null ? <Unavailable what="Facts" />
          : page.facts.length === 0 ? <p className="explore-note">No facts recorded.</p>
          : <ul className="md-list">{page.facts.map((fact, index) => <li key={fact.id ?? index}>{fact.fact}</li>)}</ul>}
        <h3 className="section-title">Timeline</h3>
        {page.timeline === null ? <Unavailable what="The timeline" />
          : page.timeline.length === 0 ? <p className="explore-note">No timeline entries.</p>
          : <ul className="md-list">{page.timeline.map((entry, index) => <li key={entry.id ?? index}><span className="result-meta">{shortDate(entry.date)}</span> {entry.summary}</li>)}</ul>}
        <h3 className="section-title">Linked from</h3>
        {linkedFrom === null ? <Unavailable what="Backlinks" />
          : linkedFrom.length === 0 ? <p className="explore-note">Nothing links here.</p>
          : <ul className="md-list">{linkedFrom.map(from => <li key={from}><a className="md-link" onClick={() => openHere(from)}>{from}</a></li>)}</ul>}
      </>}
    </aside>
  </>;
}
