import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { candidateWords, lookupBackground, lookupWord, referenceLinks, type Background, type WordEntry } from '../lib/lookup';
import { lookupLineage, type Lineage } from '../lib/sources';
import { placeLookup, type LookupTarget } from '../lib/lookupPlace';
import { HIGHLIGHT_COLORS, type HighlightColor } from '../types';
import { BookIcon, CloseIcon, ExternalIcon, NoteIcon, TrashIcon, TreeIcon } from './icons';

export type { LookupTarget };

interface Props {
  paperId: string;
  target: LookupTarget;
  onClose: () => void;
  onSelectHighlight: (id: string | null) => void;
}

type Pane = 'dictionary' | 'origins' | 'comment';

const PANES: { id: Pane; label: string }[] = [
  { id: 'dictionary', label: 'Meaning' },
  { id: 'origins', label: 'Origins' },
  { id: 'comment', label: 'Comment' },
];

function yearOf(published: string): string {
  const year = published ? new Date(published).getFullYear() : NaN;
  return Number.isFinite(year) ? String(year) : '—';
}

export default function LookupPopover({ paperId, target, onClose, onSelectHighlight }: Props) {
  const { highlights, addHighlight, updateHighlight, deleteHighlight } = useStore();
  const box = useRef<HTMLDivElement>(null);

  const phrase = target.selector.exact.trim();
  const wordCount = phrase.split(/\s+/).length;
  // A word or a short phrase is most likely being looked up; a passage is
  // most likely being commented on.
  const [pane, setPane] = useState<Pane>(() => (wordCount <= 3 ? 'dictionary' : 'comment'));
  // A two- or three-word phrase is asked about whole first — Wiktionary has
  // "neural network" and "gradient descent" — then word by word.
  const words = useMemo(() => {
    const single = candidateWords(phrase);
    const whole = phrase.toLowerCase().replace(/[^\p{L}\p{N}\s'-]+/gu, ' ').replace(/\s+/g, ' ').trim();
    return wordCount >= 2 && wordCount <= 3 && whole.length <= 40 && whole.includes(' ') ? [whole, ...single] : single;
  }, [phrase, wordCount]);
  const [word, setWord] = useState(() => words[0] || phrase);
  const [height, setHeight] = useState(260);

  const [entry, setEntry] = useState<WordEntry | null>(null);
  const [wordState, setWordState] = useState<'loading' | 'done' | 'missing' | 'error'>('loading');
  const [wordError, setWordError] = useState('');
  const [background, setBackground] = useState<Background | null>(null);
  const [lineage, setLineage] = useState<Lineage | null>(null);
  const [originsState, setOriginsState] = useState<'loading' | 'done' | 'error'>('loading');
  const [originsError, setOriginsError] = useState('');

  // The comment pane writes a real highlight, so the text is marked up in the
  // paper the moment there is something to mark up — Acrobat's behaviour.
  const [commentId, setCommentId] = useState<string | null>(null);
  const [colour, setColour] = useState<HighlightColor>('yellow');
  const comment = highlights.find((highlight) => highlight.id === commentId);

  const placement = placeLookup(target, height);

  // The card's height follows what it holds; the placement follows the height.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.offsetHeight));
    observer.observe(element);
    setHeight(element.offsetHeight);
    return () => observer.disconnect();
  }, []);

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
        setWordError(error instanceof Error ? error.message : String(error));
        setWordState('error');
      });
    return () => controller.abort();
  }, [word]);

  // A phrase the dictionaries do not carry falls through to its first word.
  useEffect(() => {
    if (wordState === 'missing' && word === words[0] && word.includes(' ') && words[1]) setWord(words[1]);
  }, [wordState, word, words]);

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
      className={`lookup is-${placement.side}`}
      style={{ top: placement.top, left: placement.left, width: placement.width, maxHeight: placement.maxHeight }}
      role="dialog"
      aria-label={`Look up “${phrase.slice(0, 60)}”`}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <div className="lookup-head">
        <p className="lookup-quote" title={phrase}>
          “{phrase}”
        </p>
        <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close the lookup box">
          <CloseIcon size={15} />
        </button>
      </div>
      <div className="lookup-tabs" role="tablist" aria-label="Lookup panes">
        {PANES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`lookup-tab-${item.id}`}
            aria-selected={pane === item.id}
            aria-controls={`lookup-pane-${item.id}`}
            onClick={() => setPane(item.id)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              const index = PANES.findIndex((entry) => entry.id === pane);
              const next = PANES[(index + (event.key === 'ArrowRight' ? 1 : PANES.length - 1)) % PANES.length];
              setPane(next.id);
              document.getElementById(`lookup-tab-${next.id}`)?.focus();
            }}
            tabIndex={pane === item.id ? 0 : -1}
          >
            {item.id === 'dictionary' ? <BookIcon size={13} /> : item.id === 'origins' ? <TreeIcon size={13} /> : <NoteIcon size={13} />}
            {item.label}
          </button>
        ))}
      </div>

      <div className="lookup-panes">
        <section
          className="lookup-pane"
          role="tabpanel"
          id="lookup-pane-dictionary"
          aria-labelledby="lookup-tab-dictionary"
          hidden={pane !== 'dictionary'}
        >

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
              No dictionary entry for “{word}”. It may be a term of art — Origins traces where it came from.
            </p>
          ) : null}

          {wordState === 'error' ? <p className="lookup-note">{wordError || 'The dictionary could not be reached.'}</p> : null}

          {entry ? (
            <>
              <p className="lookup-word">
                {entry.word}
                {entry.phonetic ? <span className="mono"> {entry.phonetic}</span> : null}
              </p>
              {entry.formOf ? <p className="lookup-form">{entry.formOf}</p> : null}
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

          <div className="lookup-links">
            {entry ? <span className="lookup-credit">From {entry.source}</span> : null}
            <a
              className="lookup-link"
              href={`https://en.wiktionary.org/wiki/${encodeURIComponent(word.replace(/ /g, '_'))}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              Wiktionary <ExternalIcon size={11} />
            </a>
          </div>
        </section>

        <section
          className="lookup-pane"
          role="tabpanel"
          id="lookup-pane-origins"
          aria-labelledby="lookup-tab-origins"
          hidden={pane !== 'origins'}
        >

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

        <section
          className="lookup-pane"
          role="tabpanel"
          id="lookup-pane-comment"
          aria-labelledby="lookup-tab-comment"
          hidden={pane !== 'comment'}
        >

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
