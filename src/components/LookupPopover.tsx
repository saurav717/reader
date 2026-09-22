import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { candidateWords, lookupBackground, lookupWord, referenceLinks, type Background, type WordEntry } from '../lib/lookup';
import { lookupLineage, type Lineage } from '../lib/sources';
import type { Selector } from '../lib/anchor';
import { HIGHLIGHT_COLORS, type HighlightColor } from '../types';
import { BookIcon, CloseIcon, ExternalIcon, NoteIcon, TrashIcon, TreeIcon } from './icons';

export interface LookupTarget {
  top: number;
  left: number;
  selector: Selector;
  section?: string;
}

interface Props {
  paperId: string;
  target: LookupTarget;
  onClose: () => void;
  onSelectHighlight: (id: string | null) => void;
}

type Pane = 'dictionary' | 'origins' | 'comment';

// The tab strip only appears when the panes will not fit side by side, so its
// labels are the short form of each pane's own heading.
const PANES: { id: Pane; label: string }[] = [
  { id: 'dictionary', label: 'Meaning' },
  { id: 'origins', label: 'Origins' },
  { id: 'comment', label: 'Comment' },
];

const WIDTH = 760;
const HEIGHT = 340;

/** Keep the box on screen, below the selection where there is room. */
function place(target: LookupTarget): { top: number; left: number } {
  const width = Math.min(WIDTH, window.innerWidth - 24);
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, target.left));
  const below = target.top;
  const top = below + HEIGHT > window.innerHeight - 12 ? Math.max(12, window.innerHeight - HEIGHT - 12) : below;
  return { top, left };
}

function yearOf(published: string): string {
  const year = published ? new Date(published).getFullYear() : NaN;
  return Number.isFinite(year) ? String(year) : '—';
}

export default function LookupPopover({ paperId, target, onClose, onSelectHighlight }: Props) {
  const { highlights, addHighlight, updateHighlight, deleteHighlight } = useStore();
  const [pane, setPane] = useState<Pane>('dictionary');
  const box = useRef<HTMLDivElement>(null);

  const phrase = target.selector.exact.trim();
  const words = useMemo(() => candidateWords(phrase), [phrase]);
  const [word, setWord] = useState(() => words[0] || phrase);

  const [entry, setEntry] = useState<WordEntry | null>(null);
  const [wordState, setWordState] = useState<'loading' | 'done' | 'missing' | 'error'>('loading');
  const [background, setBackground] = useState<Background | null>(null);
  const [lineage, setLineage] = useState<Lineage | null>(null);
  const [originsState, setOriginsState] = useState<'loading' | 'done' | 'error'>('loading');
  const [originsError, setOriginsError] = useState('');

  // The comment pane writes a real highlight, so the text is marked up in the
  // paper the moment there is something to mark up — Acrobat's behaviour.
  const [commentId, setCommentId] = useState<string | null>(null);
  const [colour, setColour] = useState<HighlightColor>('yellow');
  const comment = highlights.find((highlight) => highlight.id === commentId);

  const { top, left } = useMemo(() => place(target), [target]);

  useEffect(() => {
    setWord(words[0] || phrase);
  }, [words, phrase]);

  useEffect(() => {
    if (!word) return;
    const controller = new AbortController();
    setWordState('loading');
    setEntry(null);
    lookupWord(word, controller.signal)
      .then((found) => {
        setEntry(found);
        setWordState(found ? 'done' : 'missing');
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setWordState('error');
      });
    return () => controller.abort();
  }, [word]);

  useEffect(() => {
    const controller = new AbortController();
    setOriginsState('loading');
    Promise.all([
      lookupBackground(phrase, controller.signal).catch(() => null),
      lookupLineage(phrase, controller.signal),
    ])
      .then(([found, trail]) => {
        setBackground(found);
        setLineage(trail);
        setOriginsState('done');
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setOriginsError(error instanceof Error ? error.message : String(error));
        setOriginsState('error');
      });
    return () => controller.abort();
  }, [phrase]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    // Wait for the click that opened the box to finish before listening.
    const timer = window.setTimeout(() => window.addEventListener('mousedown', onDown), 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  /** Mark the passage now, so the highlight appears as the comment is written. */
  const startComment = useCallback(
    async (withColour: HighlightColor) => {
      setColour(withColour);
      if (commentId) {
        await updateHighlight(commentId, { color: withColour });
        return commentId;
      }
      const created = await addHighlight({
        paperId,
        color: withColour,
        exact: target.selector.exact,
        prefix: target.selector.prefix,
        suffix: target.selector.suffix,
        hint: target.selector.hint,
        section: target.section,
        tags: [],
        note: '',
      });
      setCommentId(created.id);
      onSelectHighlight(created.id);
      return created.id;
    },
    [addHighlight, commentId, onSelectHighlight, paperId, target, updateHighlight],
  );

  const onCommentChange = async (text: string) => {
    const id = commentId ?? (await startComment(colour));
    await updateHighlight(id, { note: text });
  };

  const links = referenceLinks(phrase);

  return (
    <div
      ref={box}
      className="lookup"
      style={{ top, left, width: Math.min(WIDTH, window.innerWidth - 24) }}
      role="dialog"
      aria-label={`Look up “${phrase.slice(0, 60)}”`}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <div className="lookup-head">
        <p className="lookup-quote" title={phrase}>
          “{phrase}”
        </p>
        <div className="lookup-tabs" role="tablist" aria-label="Lookup panes">
          {PANES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={pane === item.id}
              onClick={() => setPane(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close the lookup box">
          <CloseIcon size={16} />
        </button>
      </div>

      <div className="lookup-panes">
        <section className={`lookup-pane ${pane === 'dictionary' ? 'is-open' : ''}`} aria-label="Dictionary">
          <h3>
            <BookIcon size={14} /> Meaning
          </h3>

          {words.length > 1 ? (
            <div className="lookup-words">
              {words.map((item) => (
                <button
                  key={item}
                  type="button"
                  className="chip"
                  aria-pressed={item === word}
                  onClick={() => setWord(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          ) : null}

          {wordState === 'loading' ? (
            <p className="lookup-note">
              <span className="spinner" /> Looking up “{word}”…
            </p>
          ) : null}

          {wordState === 'missing' ? (
            <p className="lookup-note">
              No dictionary entry for “{word}”. It may be a term of art — the next pane traces where it came
              from.
            </p>
          ) : null}

          {wordState === 'error' ? (
            <p className="lookup-note">The dictionary could not be reached.</p>
          ) : null}

          {entry ? (
            <>
              <p className="lookup-word">
                {entry.word}
                {entry.phonetic ? <span className="mono"> {entry.phonetic}</span> : null}
              </p>
              {entry.senses.map((sense, index) => (
                <div key={`${sense.partOfSpeech}-${index}`} className="lookup-sense">
                  <span className="eyebrow">{sense.partOfSpeech}</span>
                  <ol>
                    {sense.definitions.map((definition) => (
                      <li key={definition.definition}>
                        {definition.definition}
                        {definition.example ? <em> “{definition.example}”</em> : null}
                      </li>
                    ))}
                  </ol>
                  {sense.synonyms.length ? (
                    <p className="lookup-synonyms">Also: {sense.synonyms.join(', ')}</p>
                  ) : null}
                </div>
              ))}
            </>
          ) : null}

          <a
            className="lookup-link"
            href={`https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            Wiktionary <ExternalIcon size={11} />
          </a>
        </section>

        <section className={`lookup-pane ${pane === 'origins' ? 'is-open' : ''}`} aria-label="Where it comes from">
          <h3>
            <TreeIcon size={14} /> Where it comes from
          </h3>

          {originsState === 'loading' ? (
            <p className="lookup-note">
              <span className="spinner" /> Tracing the phrase…
            </p>
          ) : null}

          {originsState === 'error' ? <p className="lookup-note">{originsError}</p> : null}

          {background ? (
            <div className="lookup-background">
              <a href={background.url} target="_blank" rel="noreferrer noopener">
                {background.title} <ExternalIcon size={11} />
              </a>
              {background.description ? <span className="lookup-kicker">{background.description}</span> : null}
              <p>{background.extract}</p>
            </div>
          ) : null}

          {lineage?.earliest.length ? (
            <>
              <span className="eyebrow">Earliest papers using it</span>
              <ul className="lookup-papers">
                {lineage.earliest.map((paper) => (
                  <li key={paper.id}>
                    <a href={paper.landingUrl || `https://openalex.org/${paper.id}`} target="_blank" rel="noreferrer noopener">
                      {paper.title}
                    </a>
                    <span className="lookup-paper-meta">
                      {yearOf(paper.published)}
                      {paper.authors[0] ? ` · ${paper.authors[0]}${paper.authors.length > 1 ? ' et al.' : ''}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {lineage?.influential.length ? (
            <>
              <span className="eyebrow">Most cited since</span>
              <ul className="lookup-papers">
                {lineage.influential.map((paper) => (
                  <li key={paper.id}>
                    <a href={paper.landingUrl || `https://openalex.org/${paper.id}`} target="_blank" rel="noreferrer noopener">
                      {paper.title}
                    </a>
                    <span className="lookup-paper-meta">
                      {yearOf(paper.published)}
                      {typeof paper.citedBy === 'number' ? ` · ${paper.citedBy.toLocaleString()} citations` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {originsState === 'done' && !background && !lineage?.earliest.length && !lineage?.influential.length ? (
            <p className="lookup-note">Nothing indexed for this phrase. The links below search it directly.</p>
          ) : null}

          <div className="lookup-links">
            {links.map((link) => (
              <a key={link.label} className="lookup-link" href={link.url} target="_blank" rel="noreferrer noopener">
                {link.label} <ExternalIcon size={11} />
              </a>
            ))}
          </div>
        </section>

        <section className={`lookup-pane ${pane === 'comment' ? 'is-open' : ''}`} aria-label="Comment">
          <h3>
            <NoteIcon size={14} /> Comment
          </h3>

          <div className="lookup-colours" role="group" aria-label="Highlight colour">
            {HIGHLIGHT_COLORS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={colour === item.id}
                aria-label={item.label}
                title={item.label}
                onClick={() => void startComment(item.id)}
              >
                <span className="swatch" style={{ background: item.swatch }} />
              </button>
            ))}
          </div>

          <label className="vh" htmlFor="lookup-comment">
            Comment on this passage
          </label>
          <textarea
            id="lookup-comment"
            value={comment?.note ?? ''}
            placeholder="Write a comment — the passage is highlighted as you type."
            onChange={(event) => void onCommentChange(event.target.value)}
          />

          <p className="lookup-note">
            {commentId
              ? `Highlighted and saved${target.section ? ` under “${target.section}”` : ''}. It is in the Highlights pane too.`
              : 'Typing here highlights the passage and pins the comment to it.'}
          </p>

          <div className="lookup-actions">
            <button type="button" className="btn primary sm" onClick={onClose} disabled={!commentId}>
              Done
            </button>
            {commentId ? (
              <button
                type="button"
                className="btn sm danger"
                onClick={() => {
                  void deleteHighlight(commentId);
                  onSelectHighlight(null);
                  setCommentId(null);
                }}
              >
                <TrashIcon size={13} /> Discard
              </button>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
