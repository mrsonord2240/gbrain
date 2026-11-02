import React from 'react';

// Page bodies are stored text from many writers, so this builds React elements
// and never injects HTML. It covers what brain pages use: headings, bullets,
// code fences, bold, inline code, links, [[wikilinks]] and think's [dir/slug] citations.
const CITATION = /^\[[\w-]+(?:\/[\w.-]+)+\]$/;
const INLINE = /(\[\[[^\]\n]+\]\]|\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|\[[\w-]+(?:\/[\w.-]+)+\])/g;

export function Inline({ text, onOpen }: { text: string; onOpen: (slug: string) => void }) {
  return <>{text.split(INLINE).map((part, index) => {
    if (part.startsWith('[[') && part.endsWith(']]')) {
      const [slug, label] = part.slice(2, -2).split('|');
      return <a key={index} className="md-link" onClick={() => onOpen(slug.trim())}>{(label ?? slug).trim()}</a>;
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={index}>{part.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part);
    if (link) return <a key={index} className="md-link" href={link[2]} target="_blank" rel="noreferrer noopener">{link[1]}</a>;
    if (CITATION.test(part)) return <a key={index} className="md-link" onClick={() => onOpen(part.slice(1, -1))}>{part}</a>;
    return <React.Fragment key={index}>{part}</React.Fragment>;
  })}</>;
}

export function Markdown({ text, onOpen }: { text: string; onOpen: (slug: string) => void }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith('```')) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index].startsWith('```')) code.push(lines[index++]);
      index++;
      blocks.push(<pre key={blocks.length} className="md-code">{code.join('\n')}</pre>);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const Tag = `h${Math.min(heading[1].length + 2, 6)}` as 'h3';
      blocks.push(<Tag key={blocks.length} className="md-heading"><Inline text={heading[2]} onOpen={onOpen} /></Tag>);
      index++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) items.push(lines[index++].replace(/^\s*[-*]\s+/, ''));
      blocks.push(<ul key={blocks.length} className="md-list">{items.map((item, i) => <li key={i}><Inline text={item} onOpen={onOpen} /></li>)}</ul>);
      continue;
    }
    if (!line.trim()) { index++; continue; }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !/^(#{1,4}\s|```|\s*[-*]\s+)/.test(lines[index])) paragraph.push(lines[index++]);
    blocks.push(<p key={blocks.length} className="md-paragraph"><Inline text={paragraph.join(' ')} onOpen={onOpen} /></p>);
  }
  return <div className="md">{blocks}</div>;
}
