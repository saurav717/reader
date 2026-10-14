/**
 * Copy citation: the paper in any of the forms a citation is written in —
 * BibTeX as a draft takes it, BibLaTeX, RIS, APA, IEEE, Chicago, a
 * Markdown link, and the bare \cite key. One click copies the form Settings
 * → Citations picks; the arrow opens the rest. Used in the reader's top bar,
 * on the project's bibliography, and on the card over a cited reference.
 */
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { CITE_FORMATS, citationAs, citationState, keyOf, type CiteFormat } from '../lib/citeRecord';
import { CITATION_DEFAULTS, type Paper, type PaperRef } from '../types';
import { ChevronDownIcon } from './icons';

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** A search result or a cited reference, not yet in the library, as the forms need it. */
export function asPaper(ref: PaperRef): Paper {
  return { ...ref, addedAt: '', collectionIds: [], tags: [], progress: 0 };
}

export default function CiteMenu({ paper, compact = false, label = 'Cite', align = 'right', onLookup }: { paper: Paper; /** The button as an icon-sized chip. */ compact?: boolean; label?: string; align?: 'left' | 'right'; /** Ask the indexes for the paper's official entries first (a paper in the library). */ onLookup?: () => Promise<void> }) {
  const { settings } = useStore();
  const opts = settings.citations ?? CITATION_DEFAULTS;
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const state = citationState(paper, opts);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const say = (what: string) => {
    setSaid(what);
    window.setTimeout(() => setSaid(null), 1400);
  };
  const take = async (format: CiteFormat | 'key') => {
    const text = format === 'key' ? `\\cite{${keyOf(paper, opts)}}` : citationAs(paper, format, opts);
    const ok = await copyText(text);
    say(ok ? `Copied ${format === 'key' ? '\\cite' : CITE_FORMATS.find((item) => item.id === format)?.label ?? format}` : 'Could not copy');
    setOpen(false);
  };
  const main = CITE_FORMATS.find((item) => item.id === opts.copy) ?? CITE_FORMATS[0];

  return (
    <div className={`menu-wrap cite-menu${compact ? ' is-compact' : ''}`} ref={box}>
      <div className="cite-menu-split">
        <button type="button" className="btn sm" onClick={() => void take(main.id)} title={`Copy the citation as ${main.label} (${main.note}) — Settings → Citations picks what one click copies`}>
          {said ?? label}
        </button>
        <button type="button" className="btn sm cite-menu-more" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} aria-label="Copy the citation in another form">
          <ChevronDownIcon size={12} />
        </button>
      </div>
      {open ? (
        <div className={`menu${align === 'right' ? ' right' : ''}`} role="menu">
          <div className="menu-label">Copy citation as</div>
          {CITE_FORMATS.map((format) => (
            <button key={format.id} type="button" role="menuitem" className={format.id === opts.copy ? 'is-checked' : undefined} onClick={() => void take(format.id)}>
              <span>{format.label}</span>
              <small className="cite-menu-note">{format.id === 'bibtex' ? state.label : format.note}</small>
            </button>
          ))}
          <hr />
          <button type="button" role="menuitem" onClick={() => void take('key')}>
            <span className="mono">\cite{'{'}{keyOf(paper, opts)}{'}'}</span>
            <small className="cite-menu-note">the key</small>
          </button>
          {onLookup && !state.official ? (
            <>
              <hr />
              <button type="button" role="menuitem" onClick={() => void onLookup().then(() => setOpen(false))}>
                <span>Fetch its official entry</span>
                <small className="cite-menu-note">Crossref, S2, dblp, OpenReview</small>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
