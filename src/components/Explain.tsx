import DOMPurify from 'dompurify';
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Screen } from '../lib/assistant';
import { getState, MODELS, saveKey, subscribe } from '../lib/assistant';
import type { Block, Section } from '../lib/explain';
import {
  caveatsOf,
  explanationFor,
  generateExplanation,
  loadExplanation,
  notebook,
  parseExplanation,
  stopExplaining,
  subscribeExplain,
  VERDICTS,
} from '../lib/explain';
import { markdown } from '../lib/markdown';
import { CloseIcon, ExplainIcon } from './icons';

export type ExplainLayout = 'margin' | 'notebook' | 'beside';
const LAYOUT_KEY = 'reader.explain.layout';
const LAYOUTS: { id: ExplainLayout; label: string; note: string }[] = [
  { id: 'margin', label: 'Margin', note: 'The prose on the left, its figures, code and caveats beside it in a wide margin' },
  { id: 'notebook', label: 'Notebook', note: 'One column of text and cells, the way a Colab notebook reads' },
  { id: 'beside', label: 'Beside the paper', note: 'The explanation over the right of the window, the paper still readable on the left' },
];

const readLayout = (): ExplainLayout => {
  try {
    const stored = localStorage.getItem(LAYOUT_KEY);
    if (stored === 'margin' || stored === 'notebook' || stored === 'beside') return stored;
  } catch {
    // private mode
  }
  return 'margin';
};

const VERDICT_CELL = /<td>(Still holds|Holds|Refined(?: since)?|Superseded|Disputed|Disproved)<\/td>/gi;
/** Prose, with a verdict alone in a table cell (the "Since then" table) drawn as its chip. */
const html = (md: string) =>
  DOMPurify.sanitize(
    markdown(md).replace(VERDICT_CELL, (_, word: string) => {
      const verdict = word.toLowerCase().replace(/^still /, '').replace(/ since$/, '');
      return `<td><span class="verdict-chip v-${verdict}">${word}</span></td>`;
    }),
    { ADD_ATTR: ['target'] },
  );

// ---------------------------------------------------------------------------
// Python, coloured — a few regular expressions, not a parser
// ---------------------------------------------------------------------------

const PY_KEYWORDS =
  'and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield';
const PY_TOKENS = new RegExp(
  [
    '(#[^\\n]*)', // comment
    '("""[\\s\\S]*?(?:"""|$)|\'\'\'[\\s\\S]*?(?:\'\'\'|$)|[rbfu]*"(?:\\\\.|[^"\\\\\\n])*"?|[rbfu]*\'(?:\\\\.|[^\'\\\\\\n])*\'?)', // string
    `\\b(${PY_KEYWORDS})\\b`, // keyword
    '\\b(\\d+(?:\\.\\d*)?(?:e[+-]?\\d+)?)\\b', // number
    '\\b([A-Za-z_]\\w*)(?=\\()', // a call
  ].join('|'),
  'g',
);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function highlightPython(code: string): string {
  let out = '';
  let last = 0;
  for (const match of code.matchAll(PY_TOKENS)) {
    out += esc(code.slice(last, match.index));
    const [text, comment, string, keyword, number, call] = match;
    const kind = comment ? 'c' : string ? 's' : keyword ? 'k' : number ? 'n' : call ? 'f' : '';
    out += kind ? `<span class="tok-${kind}">${esc(text)}</span>` : esc(text);
    last = (match.index ?? 0) + text.length;
  }
  return out + esc(code.slice(last));
}

// ---------------------------------------------------------------------------
// The blocks
// ---------------------------------------------------------------------------

function CodeCell({ block, index }: { block: Extract<Block, { kind: 'code' }>; index: number }) {
  const [copied, setCopied] = useState(false);
  const python = block.lang === 'python';
  return (
    <figure className="explain-cell">
      <header>
        <span className="cell-index">{python ? `In [${index}]` : 'Out'}</span>
        <span className="cell-title">{block.title}</span>
        {python ? (
          <>
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                void navigator.clipboard?.writeText(block.code).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1400);
                });
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              className="btn sm colab"
              disabled
              title="Running cells in Google Colab is coming next. For now, “Notebook” in the bar downloads every cell as an .ipynb that Colab opens."
            >
              <span className="colab-mark" aria-hidden="true">
                co
              </span>
              Run in Colab
            </button>
          </>
        ) : null}
      </header>
      <pre className="cell-code">
        <code dangerouslySetInnerHTML={{ __html: python ? highlightPython(block.code) : esc(block.code) }} />
        {block.open ? <span className="caret" aria-hidden="true" /> : null}
      </pre>
      {block.output !== undefined ? (
        <div className="cell-output">
          <div className="cell-output-label">Expected output · written by Claude, not run yet</div>
          <pre>{block.output}</pre>
        </div>
      ) : null}
    </figure>
  );
}

function Figure({ block }: { block: Extract<Block, { kind: 'figure' }> }) {
  const svg = useMemo(
    () => (block.open ? '' : DOMPurify.sanitize(block.svg, { USE_PROFILES: { svg: true, svgFilters: true } })),
    [block.svg, block.open],
  );
  return (
    <figure className="explain-figure">
      {svg ? <div className="figure-art" dangerouslySetInnerHTML={{ __html: svg }} /> : <div className="figure-art drawing">Drawing…</div>}
      {block.caption ? <figcaption>{block.caption}</figcaption> : null}
    </figure>
  );
}

function Caveat({ block }: { block: Extract<Block, { kind: 'caveat' }> }) {
  return (
    <aside className={`explain-caveat v-${block.verdict}`}>
      <div className="caveat-head">
        <span className="verdict">{VERDICTS[block.verdict]}</span>
        {block.title ? <strong>{block.title}</strong> : null}
      </div>
      <div className="caveat-body" dangerouslySetInnerHTML={{ __html: html(block.md) }} />
    </aside>
  );
}

/**
 * A section, as rows: a run of prose, then whatever figures, cells and
 * caveats follow it. In the margin layout the two halves of a row sit side
 * by side, so a figure stands next to the paragraph it illustrates.
 */
function SectionView({ section, number, cells, onAsk }: { section: Section; number: number; cells: Map<Block, number>; onAsk?: (text: string) => void }) {
  const rows: { prose: Block[]; side: Block[] }[] = [];
  for (const block of section.blocks) {
    const row = rows[rows.length - 1];
    if (block.kind === 'prose') {
      if (row && !row.side.length) row.prose.push(block);
      else rows.push({ prose: [block], side: [] });
    } else if (row) row.side.push(block);
    else rows.push({ prose: [], side: [block] });
  }
  const draw = (block: Block, key: number) =>
    block.kind === 'prose' ? (
      <div key={key} className="explain-prose" dangerouslySetInnerHTML={{ __html: html(block.md) }} />
    ) : block.kind === 'figure' ? (
      <Figure key={key} block={block} />
    ) : block.kind === 'code' ? (
      <CodeCell key={key} block={block} index={cells.get(block) ?? 0} />
    ) : (
      <Caveat key={key} block={block} />
    );
  return (
    <section className="explain-section" id={`explain-${section.id}`} data-section={section.id}>
      {section.title ? (
        <header className="explain-section-head">
          <span className="section-number">{String(number).padStart(2, '0')}</span>
          <h2>{section.title}</h2>
          {onAsk ? (
            <button type="button" className="btn sm ghost ask" onClick={() => onAsk(section.title)} title="Ask Claude a follow-up about this section">
              Ask about this
            </button>
          ) : null}
        </header>
      ) : null}
      {rows.map((row, index) => (
        <div key={index} className="explain-row">
          <div className="row-main">{row.prose.map(draw)}</div>
          {row.side.length ? <div className="row-side">{row.side.map(draw)}</div> : null}
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

interface Props {
  paperId: string;
  title: string;
  authors: string[];
  published?: string;
  screen: () => Promise<Screen>;
  onClose: () => void;
  onAsk?: (sectionTitle: string) => void;
}

export default function Explain({ paperId, title, authors, published, screen, onClose, onAsk }: Props) {
  const assistant = useSyncExternalStore(subscribe, getState);
  const explanation = useSyncExternalStore(subscribeExplain, () => explanationFor(paperId));
  const [layout, setLayout] = useState<ExplainLayout>(readLayout);
  const [model, setModel] = useState<string>(assistant.prefs.model);
  const [keyDraft, setKeyDraft] = useState('');
  const [active, setActive] = useState('');
  const [checked, setChecked] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setChecked(false);
    void loadExplanation(paperId).finally(() => setChecked(true));
  }, [paperId]);

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, layout);
    } catch {
      // private mode
    }
  }, [layout]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.activeElement?.closest('.assistant-win') && !document.querySelector('.scrim')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sections = useMemo(() => parseExplanation(explanation?.content ?? ''), [explanation?.content]);
  const caveats = useMemo(() => caveatsOf(sections), [sections]);
  const cells = useMemo(() => {
    const numbers = new Map<Block, number>();
    let n = 0;
    for (const section of sections) for (const block of section.blocks) if (block.kind === 'code' && block.lang === 'python') numbers.set(block, ++n);
    return numbers;
  }, [sections]);
  const hasCode = cells.size > 0;
  const streaming = Boolean(explanation?.streaming);

  // The outline follows the reading: the section whose head last crossed the top third.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const onScroll = () => {
      const line = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
      let current = '';
      for (const element of scroller.querySelectorAll<HTMLElement>('.explain-section')) {
        if (element.getBoundingClientRect().top <= line) current = element.dataset.section ?? '';
      }
      setActive(current);
    };
    onScroll();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [sections.length]);

  const start = async () => {
    const read = await screen();
    await generateExplanation(read, model);
  };

  const download = () => {
    const blob = new Blob([notebook(title, sections)], { type: 'application/x-ipynb+json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${title.slice(0, 80).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'paper'}.ipynb`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  };

  const year = published?.slice(0, 4);
  const byline = [authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : ''), year].filter(Boolean).join(' · ');
  const writtenWith = MODELS.find((m) => m.id === explanation?.model)?.label ?? explanation?.model;

  return (
    <div className={`explain layout-${layout}`} role="dialog" aria-label={`Explanation of ${title}`}>
      <header className="explain-bar">
        <span className="explain-brand">
          <ExplainIcon size={17} /> Explained by Claude
        </span>
        <span className="explain-bar-title" title={title}>
          {title}
        </span>
        <div className="segmented" role="group" aria-label="Layout">
          {LAYOUTS.map((option) => (
            <button key={option.id} type="button" aria-pressed={layout === option.id} title={option.note} onClick={() => setLayout(option.id)}>
              {option.label}
            </button>
          ))}
        </div>
        {hasCode && !streaming ? (
          <button type="button" className="btn sm" onClick={download} title="Every cell and its explanation as a Jupyter notebook — File → Upload notebook in Colab opens it">
            Notebook ↓
          </button>
        ) : null}
        {explanation?.content && !streaming ? (
          <button type="button" className="btn sm ghost" onClick={() => void start()} disabled={!assistant.hasKey} title="Write it again from scratch">
            Rewrite
          </button>
        ) : null}
        {streaming ? (
          <button type="button" className="btn sm" onClick={stopExplaining}>
            Stop
          </button>
        ) : null}
        <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close the explanation (Esc)" title="Back to the paper (Esc or E)">
          <CloseIcon size={17} />
        </button>
      </header>

      <div className="explain-scroll" ref={scrollRef}>
        <nav className="explain-outline" aria-label="Sections">
          <div className="outline-paper">
            <div className="outline-title">{title}</div>
            {byline ? <div className="outline-byline">{byline}</div> : null}
          </div>
          {sections.filter((s) => s.title).length ? (
            <ol>
              {sections
                .filter((s) => s.title)
                .map((section, index) => {
                  const marks = section.blocks.filter((b) => b.kind === 'caveat') as Extract<Block, { kind: 'caveat' }>[];
                  return (
                    <li key={section.id} className={active === section.id ? 'active' : ''}>
                      <a
                        href={`#explain-${section.id}`}
                        onClick={(event) => {
                          event.preventDefault();
                          document.getElementById(`explain-${section.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }}
                      >
                        <span className="n">{String(index + 1).padStart(2, '0')}</span>
                        <span className="t">{section.title}</span>
                        {marks.map((mark, i) => (
                          <span key={i} className={`dot v-${mark.verdict}`} title={`${VERDICTS[mark.verdict]}: ${mark.title}`} />
                        ))}
                      </a>
                    </li>
                  );
                })}
            </ol>
          ) : null}
          {caveats.length ? (
            <div className="outline-aged">
              <div className="aged-label">How it has aged</div>
              {(Object.keys(VERDICTS) as (keyof typeof VERDICTS)[])
                .map((verdict) => [verdict, caveats.filter((c) => c.verdict === verdict).length] as const)
                .filter(([, count]) => count)
                .map(([verdict, count]) => (
                  <div key={verdict} className={`aged-row v-${verdict}`}>
                    <span className="dot" /> {VERDICTS[verdict]} <span className="count">{count}</span>
                  </div>
                ))}
            </div>
          ) : null}
          {explanation?.content ? (
            <div className="outline-meta">
              {streaming ? 'Claude is writing…' : `Written by ${writtenWith} · ${new Date(explanation.created).toLocaleDateString()}`}
            </div>
          ) : null}
        </nav>

        <article className="explain-doc">
          {!explanation?.content && checked && !streaming ? (
            <div className="explain-empty">
              <div className="explain-kicker">
                <ExplainIcon size={16} /> The whole paper, explained
              </div>
              <h1>{title}</h1>
              <p>
                Claude reads the paper end to end and writes you a walkthrough: the problem, how the method works and why it beats what came before,
                with diagrams, small Python cells you can run, and an honest account of what has changed since it was published.
              </p>
              <ul className="explain-promises">
                <li>
                  <b>Figures</b> drawn for each key idea
                </li>
                <li>
                  <b>Code cells</b> — runnable in Google Colab
                </li>
                <li>
                  <b>Caveats</b> — what still holds, what was superseded or disproved
                </li>
              </ul>
              {assistant.hasKey ? (
                <div className="explain-start">
                  <select value={model} onChange={(event) => setModel(event.target.value)} aria-label="Model">
                    {MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} — {m.note}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="btn primary" onClick={() => void start()}>
                    Explain this paper
                  </button>
                  <span className="hint">Written once and kept for this paper. A long paper costs about as much as a few long answers in Ask Claude.</span>
                </div>
              ) : (
                <form
                  className="explain-start"
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveKey(keyDraft);
                  }}
                >
                  <input type="password" placeholder="sk-ant-…" value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)} aria-label="Anthropic API key" />
                  <button type="submit" className="btn primary" disabled={!keyDraft.trim()}>
                    Use this key
                  </button>
                  <span className="hint">The same key as Ask Claude. It stays in this browser and goes only to api.anthropic.com.</span>
                </form>
              )}
            </div>
          ) : (
            <>
              <header className="explain-title">
                <div className="explain-kicker">
                  <ExplainIcon size={16} /> Explained by Claude
                </div>
                <h1>{title}</h1>
                {byline ? <div className="byline">{byline}</div> : null}
              </header>
              {sections.map((section, index) => (
                <Fragment key={section.id}>
                  <SectionView section={section} number={index + (sections[0]?.title ? 1 : 0)} cells={cells} onAsk={streaming ? undefined : onAsk} />
                </Fragment>
              ))}
              {streaming ? (
                <p className="explain-writing">
                  <span className="spinner" /> Claude is writing{sections.length ? ` — ${sections[sections.length - 1].title || 'the opening'}` : ''}…
                </p>
              ) : null}
              {explanation?.error ? <p className="explain-error">{explanation.error}</p> : null}
              {explanation?.truncated ? <p className="explain-error">It ran out of room before the end. Rewrite, or ask about the rest in Ask Claude.</p> : null}
            </>
          )}
        </article>
      </div>
    </div>
  );
}
