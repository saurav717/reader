import DOMPurify from 'dompurify';
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  CONTEXT_ROWS,
  MODELS,
  clearHistory,
  deleteChat,
  forgetKey,
  getState,
  newChat,
  openChat,
  saveKey,
  send,
  setContext,
  setModel,
  setQuote,
  setShot,
  paperKey,
  readingList,
  splitPassages,
  asksWhere,
  stop,
  subscribe,
} from '../lib/assistant';
import type { Passage, Recommendation, Screen, Turn } from '../lib/assistant';
import { FLASH_EVENT, showPassage, type LocateResult } from '../lib/locate';
import { typesetMath } from '../lib/typesetMath';
import {
  RUN_GAP,
  SNAP_STEPS,
  STACK_WIDTH,
  STYLES,
  clamp,
  clearOf,
  defaultRect,
  fit,
  loadWindow,
  nudge,
  resize,
  saveWindow,
  snap,
  stride,
  styleAt,
  zoom,
} from '../lib/floatWindow';
import type { Rect, Side } from '../lib/floatWindow';
import { markdown } from '../lib/markdown';
import { CameraIcon, CheckIcon, CloseIcon, PlusIcon, SearchIcon, SparkleIcon } from './icons';
import { useStore } from '../lib/store';
import { resolvePaper } from '../lib/recommend';
import { PAPER_LAYOUTS, markAdds, placeCards, setLayout, useLayout } from './paperCards';
import type { PaperLayout } from './paperCards';
import type { ChatMarks, PassageLook } from '../types';
import { discover } from './HoverCard';
import { canCapture, captureTab } from '../lib/screen';

const DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const ARROWS: Record<string, Side> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
const EDGE_NAME: Record<Side, string> = { left: 'left', right: 'right', up: 'top', down: 'bottom' };

const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
const stacked = () => window.innerWidth <= STACK_WIDTH;

const isEditable = (el: Element | null) =>
  !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable);

/** "just now" / "14 mins ago" / "3 days ago" — enough to find a chat by. */
function ago(ts: number): string {
  const secs = Math.max(0, (Date.now() - ts) / 1000);
  if (secs < 90) return 'just now';
  const units: [number, string][] = [[60, 'min'], [60, 'hour'], [24, 'day'], [7, 'week']];
  let n = secs;
  let label = 'sec';
  for (const [size, name] of units) {
    if (n < size) break;
    n /= size;
    label = name;
  }
  const whole = Math.floor(n);
  return `${whole} ${label}${whole === 1 ? '' : 's'} ago`;
}

/** Where adding a recommended paper to the Reading list has got to. */
type AddState = 'adding' | 'added' | 'missing';

/** What the papers an answer brings up can do: be looked at, found in Discover, added. */
interface PaperActions {
  layout: PaperLayout;
  find: (title: string) => void;
  peek: (turn: number, key: string, anchor: HTMLElement, pinned: boolean) => void;
  adds: Record<string, AddState>;
  add: (papers: Recommendation[]) => void;
}

const ADD_LABEL: Record<AddState, string> = { adding: 'Adding…', added: 'In Reading list', missing: 'Not found — try again' };

function AddButton({ paper, actions, compact }: { paper: Recommendation; actions: PaperActions; compact?: boolean }) {
  const state = actions.adds[paperKey(paper.title)];
  const label = state ? ADD_LABEL[state] : 'Add to Reading list';
  return (
    <button
      type="button"
      className={`btn sm chat-add ${state ? `is-${state}` : ''}`}
      disabled={state === 'adding' || state === 'added'}
      title={label}
      aria-label={compact ? `${label}: ${paper.title}` : undefined}
      onClick={() => actions.add([paper])}
    >
      {state === 'added' ? <CheckIcon size={12} /> : <PlusIcon size={12} />}
      {compact ? null : label}
    </button>
  );
}

/** A paper's card: what the answer said of it, and the two things to do with it. */
function PaperCard({ paper, n, actions }: { paper: Recommendation; n: number; actions: PaperActions }) {
  return (
    <>
      <p className="chat-peek-head">
        <span className="chat-num">{n}</span>
        {[paper.authors ?? paper.label, paper.year].filter(Boolean).join(' · ')}
      </p>
      <h3>{paper.title}</h3>
      {paper.why ? <p className="chat-peek-why">{paper.why}</p> : null}
      <div className="chat-peek-actions">
        <button type="button" className="btn primary sm" onClick={() => actions.find(paper.title)}>
          <SearchIcon size={12} />
          Find in Discover
        </button>
        <AddButton paper={paper} actions={actions} />
      </div>
    </>
  );
}

/**
 * Every paper the answer brought up, folded to one line under it until
 * opened: numbered as the names in the text are, each a row with what it
 * contributes. A row's title goes back to where the answer named the paper.
 */
function ReadingList({ papers, actions, onShow }: { papers: Recommendation[]; actions: PaperActions; onShow: (key: string) => void }) {
  const stateOf = (paper: Recommendation) => actions.adds[paperKey(paper.title)];
  const waiting = papers.filter((paper) => !stateOf(paper));
  const added = papers.filter((paper) => stateOf(paper) === 'added').length;
  const busy = papers.some((paper) => stateOf(paper) === 'adding');
  return (
    <details className="chat-reading">
      <summary>
        <span className="chat-reading-count">
          {papers.length} {papers.length === 1 ? 'paper' : 'papers'} mentioned
        </span>
        <span className="segmented sm chat-layout" role="group" aria-label="Where the papers' cards go">
          {PAPER_LAYOUTS.map(({ value, short, note }) => (
            <button
              key={value}
              type="button"
              aria-pressed={actions.layout === value}
              title={note}
              onClick={(event) => {
                event.preventDefault();
                setLayout(value);
              }}
            >
              {short}
            </button>
          ))}
        </span>
        {waiting.length ? (
          <button
            type="button"
            className="btn sm"
            onClick={(event) => {
              event.preventDefault();
              actions.add(waiting);
            }}
          >
            <PlusIcon size={12} />
            {waiting.length === papers.length ? 'Add all to Reading list' : `Add the other ${waiting.length}`}
          </button>
        ) : (
          <span className={`chat-reading-status ${added === papers.length ? 'is-done' : ''}`} aria-live="polite">
            {busy ? 'Adding…' : added === papers.length ? <><CheckIcon size={12} /> All in Reading list</> : `${added} of ${papers.length} in Reading list`}
          </span>
        )}
      </summary>
      <ol>
        {papers.map((paper, index) => {
          const key = paperKey(paper.title);
          return (
            <li key={key}>
              <span className="chat-num">{index + 1}</span>
              <div className="chat-reading-paper">
                <button type="button" className="chat-reading-title" onClick={() => onShow(key)} title="Show where the answer names it">
                  {paper.title}
                </button>
                <p className="chat-reading-meta">{[paper.authors ?? paper.label, paper.year].filter(Boolean).join(' · ')}</p>
                {paper.why ? <p className="chat-reading-why">{paper.why}</p> : null}
                {stateOf(paper) === 'missing' ? (
                  <p className="chat-reading-missing">Not found in the indexes by its title — Find searches Google Scholar too.</p>
                ) : null}
              </div>
              <div className="chat-reading-actions">
                <button type="button" className="btn sm" onClick={() => actions.find(paper.title)} aria-label={`Find in Discover: ${paper.title}`} title="Find in Discover">
                  <SearchIcon size={12} />
                </button>
                <AddButton paper={paper} actions={actions} compact />
              </div>
            </li>
          );
        })}
      </ol>
    </details>
  );
}


// ---------------------------------------------------------------------------
// The window's settings: what Claude sees, how answers mark words, how the
// page marks a passage, where paper cards go, and the key
// ---------------------------------------------------------------------------

const CHAT_MARKS: { id: ChatMarks; label: string; note: string }[] = [
  { id: 'auto', label: 'Auto', note: 'Marker fill on paper, a glow in the dark' },
  { id: 'fill', label: 'Fill', note: 'A marker behind the words' },
  { id: 'glow', label: 'Glow', note: 'The words themselves in amber' },
  { id: 'underline', label: 'Underline', note: 'A thick marker stroke beneath' },
  { id: 'tint', label: 'Tint', note: 'The app’s own green' },
  { id: 'outline', label: 'Outline', note: 'A framed chip' },
];

const PAGE_LOOKS: { id: PassageLook; label: string; note: string }[] = [
  { id: 'marker', label: 'Marker', note: 'Swept over the words' },
  { id: 'spotlight', label: 'Spotlight', note: 'The rest of the page dims' },
  { id: 'outline', label: 'Outline', note: 'Framed, with a bar' },
];

function SetSection({ icon, title, note, children }: { icon: string; title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="set-card">
      <header>
        <span className="set-icon" aria-hidden="true">
          {icon}
        </span>
        <span>
          <b>{title}</b>
          {note ? <small>{note}</small> : null}
        </span>
      </header>
      {children}
    </section>
  );
}

function ChatSettings({
  context,
  hasKey,
  paperLayout,
  marks,
  look,
  onMarks,
  onLook,
}: {
  context: Record<string, boolean>;
  hasKey: boolean;
  paperLayout: PaperLayout;
  marks: ChatMarks;
  look: PassageLook;
  onMarks: (marks: ChatMarks) => void;
  onLook: (look: PassageLook) => void;
}) {
  const on = CONTEXT_ROWS.filter(([key]) => context[key]).length;
  return (
    <div className="chat-drawer chat-settings">
      <SetSection icon="✦" title="Highlights in answers" note="How bold words and links to passages are marked">
        <div className="mark-tiles" role="radiogroup" aria-label="Highlights in answers">
          {CHAT_MARKS.map((option) => (
            <button key={option.id} type="button" role="radio" aria-checked={marks === option.id} className="mark-tile" data-marks={option.id} onClick={() => onMarks(option.id)} title={option.note}>
              <span className="mark-sample chat-claude">
                <span className="chat-text">
                  the <strong>key idea</strong>, and <span className="chat-passage" data-passage="1">where</span>
                </span>
              </span>
              <span className="mark-name">{option.label}</span>
              <span className="mark-note">{option.note}</span>
            </button>
          ))}
        </div>
      </SetSection>

      <SetSection icon="◎" title="Passages on the page" note="When Claude shows you where something is">
        <div className="look-tiles" role="radiogroup" aria-label="Passages on the page">
          {PAGE_LOOKS.map((option) => (
            <button key={option.id} type="button" role="radio" aria-checked={look === option.id} className={`look-tile look-${option.id}`} onClick={() => onLook(option.id)}>
              <span className="look-sample" aria-hidden="true">
                <i />
                <i className="hit" />
                <i className="hit short" />
                <i />
              </span>
              <span className="mark-name">{option.label}</span>
              <span className="mark-note">{option.note}</span>
            </button>
          ))}
        </div>
      </SetSection>

      <SetSection icon="◉" title="What Claude sees" note={`${on} of ${CONTEXT_ROWS.length} on · read fresh each time you send`}>
        <div className="set-switches">
          {CONTEXT_ROWS.map(([key, label, note]) => (
            <label key={key} className="set-switch" title={note}>
              <span className="set-switch-text">
                <b>{label}</b>
                <small>{note}</small>
              </span>
              <input type="checkbox" role="switch" checked={context[key]} onChange={(event) => setContext(key, event.target.checked)} />
              <span className="set-toggle" aria-hidden="true" />
            </label>
          ))}
        </div>
      </SetSection>

      <SetSection icon="▤" title="Papers Claude names" note="Where a paper's card goes in the answer">
        <div className="set-choices" role="radiogroup" aria-label="Where paper cards go">
          {PAPER_LAYOUTS.map(({ value, label, note }) => (
            <button key={value} type="button" role="radio" aria-checked={paperLayout === value} onClick={() => setLayout(value)}>
              <b>{label}</b>
              <small>{note}</small>
            </button>
          ))}
        </div>
      </SetSection>

      {hasKey ? (
        <SetSection icon="⚿" title="Your Anthropic key" note="Kept in this browser only, sent straight to Anthropic">
          <div className="set-key">
            <span className="set-key-dot" aria-hidden="true" />
            <span>Connected · usage bills your own account</span>
            <button type="button" className="btn sm danger" onClick={forgetKey}>
              Forget my key
            </button>
          </div>
        </SetSection>
      ) : null}
    </div>
  );
}

/** What pressing Show on a passage came to. */
type Shown = LocateResult | 'looking';

/**
 * The places in the open paper an answer points at, under it: each with its
 * caption, the paper's own words, and Show — which scrolls the paper there
 * and marks the passage for a few seconds.
 */
function PassageList({ passages, shown, onShow, onPage }: { passages: Passage[]; shown: Record<number, Shown>; onShow: (index: number) => void; onPage?: string | null }) {
  return (
    <div className="chat-passages">
      <div className="chat-passages-head">
        <span className="chat-passages-title">
          <SparkleIcon size={12} />{' '}
          {passages.every((p) => p.source === 'explanation') ? 'Found in the explanation' : passages.some((p) => p.source === 'explanation') ? 'Found in the paper and its explanation' : 'Found in the paper'}
        </span>
        <span className="chat-passages-count">{passages.length}</span>
        <span className="chat-passages-hint">Click one to see it on the page</span>
      </div>
      <ol>
        {passages.map((passage, index) => {
          const state = shown[index];
          const live = onPage === passage.quote;
          const missing = state && state !== 'looking' && !state.found;
          return (
            <li key={index} className={`${live ? 'is-live' : ''}${missing ? ' is-missing' : ''}`}>
              <button type="button" className="chat-passage-row" onClick={() => onShow(index)} title={passage.source === 'explanation' ? 'Scroll the explanation to this passage and mark it' : 'Scroll the paper to this passage and mark it'}>
                <span className="chat-passage-n">{index + 1}</span>
                <span className="chat-passage-body">
                  <b>{passage.label}</b>
                  <q>{passage.quote}</q>
                  <span className="chat-passage-meta">
                    {passage.section ? <i>{passage.section}</i> : null}
                    {passage.page ? <i>p. {passage.page}</i> : null}
                    {live && state && state !== 'looking' && state.pageOnly ? (
                      <span className="ok live">
                        <span className="dot" /> Opened at page {state.page}
                      </span>
                    ) : live ? (
                      <span className="ok live">
                        <span className="dot" /> On the page now
                      </span>
                    ) : state === 'looking' ? (
                      <span>Finding it…</span>
                    ) : state?.found && state.pageOnly ? (
                      <span className="ok">Opened at page {state.page}</span>
                    ) : missing ? (
                      <span className="bad">{state.reason ?? 'Not found on the page'}</span>
                    ) : null}
                  </span>
                </span>
                <span className="chat-passage-go">
                  {live ? 'Shown' : 'Show'}
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 8h8M8.5 4.5 12 8l-3.5 3.5" />
                  </svg>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The quote of the passage marked on the page right now, if any. */
function usePassageOnPage(): string | null {
  const [quote, setQuote] = useState<string | null>(null);
  useEffect(() => {
    const on = (event: Event) => setQuote((event as CustomEvent<{ quote: string | null }>).detail?.quote ?? null);
    window.addEventListener(FLASH_EVENT, on);
    return () => window.removeEventListener(FLASH_EVENT, on);
  }, []);
  return quote;
}

const PEEK_WIDTH = 320;

/** Under the name when there is room, over it when there is not; always on the page. */
function peekPlace(box: DOMRect): React.CSSProperties {
  const left = clamp(box.left, 8, window.innerWidth - PEEK_WIDTH - 8);
  const below = window.innerHeight - box.bottom > 230;
  return below
    ? { left, top: box.bottom + 6, width: PEEK_WIDTH }
    : { left, bottom: window.innerHeight - box.top + 6, width: PEEK_WIDTH };
}

function TurnView({ turn, index, actions, question }: { turn: Turn; index: number; actions: PaperActions; question?: string }) {
  const textRef = useRef<HTMLDivElement>(null);
  const isClaude = turn.role !== 'user';
  const pointed = isClaude ? splitPassages(turn.content) : { text: turn.content, passages: [] as Passage[] };
  const passages = pointed.passages;
  const { text, papers } = isClaude ? readingList(pointed.text) : { text: turn.content, papers: [] };
  const [shown, setShown] = useState<Record<number, Shown>>({});
  const onPage = usePassageOnPage();
  const showAt = useCallback(
    (at: number) => {
      const passage = passages[at];
      if (!passage) return;
      setShown((current) => ({ ...current, [at]: 'looking' }));
      void showPassage({ ...passage, n: at + 1 }).then((result) => setShown((current) => ({ ...current, [at]: result })));
    },
    // The passages are re-read from the content on every render; their text is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(passages)],
  );
  // The moment an answer finishes, the passage it was asked for is shown —
  // not when an old conversation is reopened, which never streams.
  const wasStreaming = useRef(turn.streaming);
  useEffect(() => {
    if (wasStreaming.current && !turn.streaming && passages.length) {
      const pick = passages.findIndex((passage) => passage.show);
      const at = pick >= 0 ? pick : question && asksWhere(question) ? 0 : -1;
      if (at >= 0) showAt(at);
    }
    wasStreaming.current = turn.streaming;
  }, [turn.streaming, passages, question, showAt]);
  const order = papers.map((paper) => paperKey(paper.title)).join('\n');

  // Each name in the text carries its paper's number, as its row in the list
  // does; once the answer is in, the papers' cards are set into it.
  useLayoutEffect(() => {
    const container = textRef.current;
    if (!container) return;
    const keys = order.split('\n');
    container.querySelectorAll<HTMLElement>('.chat-mention').forEach((mention) => {
      const n = keys.indexOf(paperKey(mention.dataset.paper ?? '')) + 1;
      if (n) mention.dataset.n = String(n);
      mention.dataset.turn = String(index);
    });
    void typesetMath(container);
    if (turn.streaming) return;
    placeCards(container, papers, actions.layout);
    markAdds(container, (title) => actions.adds[paperKey(title)]);
  });

  if (!isClaude) {
    return (
      <div className="chat-turn chat-user">
        {turn.shot ? <span className="chat-shot-tag">Screenshot attached</span> : null}
        <div
          className="chat-text"
          // The quote that leads a question renders as a quote; the rest is plain text.
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(markdown(turn.content)) }}
        />
      </div>
    );
  }
  const show = (key: string) => {
    const mention = Array.from(textRef.current?.querySelectorAll<HTMLElement>('.chat-mention') ?? []).find(
      (el) => paperKey(el.dataset.paper ?? '') === key,
    );
    if (!mention) return;
    mention.scrollIntoView({ block: 'center', behavior: 'smooth' });
    mention.classList.remove('is-flash');
    void mention.offsetWidth;
    mention.classList.add('is-flash');
    window.setTimeout(() => actions.peek(index, key, mention, true), 380);
  };
  return (
    <div className={`chat-turn chat-claude${turn.streaming ? ' is-streaming' : ''}`}>
      <div className="chat-who" aria-hidden="true">
        <span className="chat-avatar">
          <SparkleIcon size={11} />
        </span>
        Claude
      </div>
      {turn.thinking?.trim() ? (
        <details className="chat-thinking">
          <summary>Reasoning</summary>
          <div>{turn.thinking}</div>
        </details>
      ) : null}
      {text ? (
        <div
          key={actions.layout}
          ref={textRef}
          className="chat-text"
          onClick={(event) => {
            const link = (event.target as HTMLElement).closest<HTMLElement>('.chat-passage');
            if (!link) return;
            event.preventDefault();
            showAt(Number(link.dataset.passage) - 1);
          }}
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(markdown(text), { ADD_ATTR: ['target'] }) }} />
      ) : null}
      {passages.length && !turn.streaming ? <PassageList passages={passages} shown={shown} onShow={showAt} onPage={onPage} /> : null}
      {papers.length && !turn.streaming ? <ReadingList papers={papers} actions={actions} onShow={show} /> : null}
      {text || papers.length || passages.length ? null : turn.streaming ? (
        <p className="chat-wait">
          <span className="chat-dot" />
          <span className="chat-dot" />
          <span className="chat-dot" />
        </p>
      ) : null}
      {turn.error ? <p className="chat-err">{turn.error}</p> : null}
      {turn.truncated ? <p className="chat-note">The answer hit the length cap. Ask for the rest.</p> : null}
    </div>
  );
}

function KeyCard() {
  const [value, setValue] = useState('');
  const save = () => {
    const key = value.trim();
    if (!key) return;
    if (!/^sk-ant-/.test(key) && !confirm('That does not look like an Anthropic API key (they start with "sk-ant-"). Save it anyway?')) return;
    saveKey(key);
  };
  return (
    <div className="chat-card">
      <h3>Connect an Anthropic account</h3>
      <p>
        Anthropic does not offer a “sign in with Claude” for other websites, and a Claude.ai subscription cannot be spent
        from a web page — so this window needs an <strong>API key</strong> from the developer console.
      </p>
      <ol>
        <li>
          Open{' '}
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">
            console.anthropic.com/settings/keys
          </a>{' '}
          and create a key.
        </li>
        <li>Paste it below. It is stored in this browser only and sent straight to Anthropic — nobody else sees it.</li>
      </ol>
      <div className="chat-key-row">
        <input
          type="password"
          className="chat-key-input"
          placeholder="sk-ant-…"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              save();
            }
          }}
          aria-label="Anthropic API key"
        />
        <button type="button" className="btn primary sm" onClick={save}>
          Save
        </button>
      </div>
      <p className="chat-card-note">Usage bills your own Anthropic account. Forget the key any time from the ⚙ menu.</p>
    </div>
  );
}

interface Props {
  onClose: () => void;
  /** Read the screen at the moment of sending. */
  screen: () => Screen | Promise<Screen>;
  /** Whether a paper is open, for the suggestions on an empty thread. */
  reading: boolean;
}

export default function Assistant({ onClose, screen, reading }: Props) {
  const s = useSyncExternalStore(subscribe, getState);
  const [drawer, setDrawer] = useState<'settings' | 'history' | null>(null);
  const [input, setInput] = useState('');
  const [said, setSaid] = useState('');
  const [shooting, setShooting] = useState(false);
  const [shotError, setShotError] = useState('');

  // The browser asks each time; a refusal is not an error worth more than a line.
  const takeShot = async () => {
    if (shooting) return;
    setShooting(true);
    setShotError('');
    try {
      setShot(await captureTab());
    } catch (error) {
      const name = (error as Error)?.name;
      setShotError(name === 'NotAllowedError' || name === 'AbortError' ? '' : `No screenshot — ${String((error as Error)?.message ?? error).replace(/\.$/, '')}.`);
    } finally {
      setShooting(false);
      inputRef.current?.focus();
    }
  };

  // ---- the frame ------------------------------------------------------------
  const [win, setWin] = useState(loadWindow);
  const [rect, setRect] = useState<Rect>(() => fit(win.rect ?? defaultRect(viewport()), viewport()));
  const [isStacked, setStacked] = useState(stacked);
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const drag = useRef<{ id: number; dir: string | null; x0: number; y0: number; start: Rect } | null>(null);
  const snapped = useRef<{ side: Side; step: number } | null>(null);
  const run = useRef<{ side: Side; step: number; at: number; stuck: boolean } | null>(null);
  const runSave = useRef(0);

  const persist = useCallback(
    (next: Rect, patch: Partial<typeof win> = {}) => {
      setWin((current) => {
        const merged = { ...current, ...patch, rect: next };
        saveWindow(merged);
        return merged;
      });
    },
    [],
  );

  // A window that survives a reload has to survive a resized browser too.
  useEffect(() => {
    const onResize = () => {
      setStacked(stacked());
      setRect((current) => fit(current, viewport()));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const begin = (event: ReactPointerEvent<HTMLElement>, dir: string | null) => {
    if (event.button !== 0 || stacked()) return;
    if (!dir && (event.target as HTMLElement).closest('button, a, input, select, textarea, label')) return;
    drag.current = { id: event.pointerId, dir, x0: event.clientX, y0: event.clientY, start: { ...rectRef.current } };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.body.classList.add('win-moving');
    event.preventDefault();
  };
  const step = (event: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || event.pointerId !== d.id) return;
    // Moved by hand: the next arrow press starts its cycle over.
    snapped.current = null;
    run.current = null;
    const dx = event.clientX - d.x0;
    const dy = event.clientY - d.y0;
    setRect(d.dir ? resize(d.start, d.dir, dx, dy, viewport()) : fit({ ...d.start, x: d.start.x + dx, y: d.start.y + dy }, viewport()));
  };
  const end = (event: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || event.pointerId !== d.id) return;
    event.currentTarget.releasePointerCapture?.(d.id);
    drag.current = null;
    document.body.classList.remove('win-moving');
    persist(rectRef.current);
  };

  // A paper named in an answer is searched for in Discover. The pane opens on the
  // right, which is where the window stands by default, so the window steps
  // left of it once it is there — the result it opened is the point.
  const findPaper = (title: string) => {
    discover(title, title);
    if (stacked()) return;
    let tries = 0;
    const step = () => {
      const pane = document.querySelector('.discover-panel');
      if (!pane) {
        if ((tries += 1) < 20) requestAnimationFrame(step);
        return;
      }
      const next = clearOf(rectRef.current, pane.getBoundingClientRect().left, viewport());
      if (!next) return;
      setRect(next);
      rectRef.current = next;
      persist(next);
    };
    requestAnimationFrame(step);
  };

  // ---- the papers an answer names ------------------------------------------
  // Pointing at a name shows its paper's card beside it; a press keeps the card
  // until it is closed. The card lives on the page, not in the window, so the
  // window's edge never clips it.
  const { collections, createCollection, addPaper, papers: library, settings, updateSettings } = useStore();
  const [peek, setPeek] = useState<{ turn: number; key: string; anchor: HTMLElement; pinned: boolean } | null>(null);
  const peekTimer = useRef(0);
  const [adds, setAdds] = useState<Record<string, AddState>>({});

  // A paper already in the library is added already.
  const inLibrary = new Set(library.map((paper) => paperKey(paper.title)));
  const addState: Record<string, AddState> = { ...Object.fromEntries([...inLibrary].map((key) => [key, 'added' as const])), ...adds };

  const addPapers = async (wanted: Recommendation[]) => {
    const todo = wanted.filter((paper) => addState[paperKey(paper.title)] !== 'added');
    if (!todo.length) return;
    setAdds((current) => ({ ...current, ...Object.fromEntries(todo.map((paper) => [paperKey(paper.title), 'adding' as const])) }));
    const list = collections.find((collection) => collection.name === 'Reading list') ?? (await createCollection('Reading list'));
    // Two at a time: every one is a search of every source.
    const queue = [...todo];
    const next = async (): Promise<void> => {
      const paper = queue.shift();
      if (!paper) return;
      const key = paperKey(paper.title);
      let state: AddState = 'missing';
      try {
        const found = await resolvePaper(paper.title);
        if (found) {
          await addPaper(found, list.id);
          state = 'added';
        }
      } catch {
        state = 'missing';
      }
      setAdds((current) => ({ ...current, [key]: state }));
      return next();
    };
    await Promise.all([next(), next()]);
  };

  const showPeek = (turn: number, key: string, anchor: HTMLElement, pinned: boolean) => {
    clearTimeout(peekTimer.current);
    setPeek({ turn, key, anchor, pinned });
  };
  const hidePeekSoon = () => {
    clearTimeout(peekTimer.current);
    peekTimer.current = window.setTimeout(() => setPeek((current) => (current?.pinned ? current : null)), 220);
  };

  const paperLayout = useLayout();
  const actions: PaperActions = { layout: paperLayout, find: findPaper, peek: showPeek, adds: addState, add: (wanted) => void addPapers(wanted) };

  useEffect(() => {
    if (!peek?.pinned) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setPeek(null);
      }
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.chat-peek, .chat-mention')) setPeek(null);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [peek?.pinned]);

  // The name whose card is open reads as pressed.
  useEffect(() => {
    const anchor = peek?.anchor;
    anchor?.setAttribute('aria-expanded', 'true');
    return () => anchor?.setAttribute('aria-expanded', 'false');
  }, [peek?.anchor]);

  const peeked = peek ? readingList(s.turns[peek.turn]?.content ?? '').papers : [];
  const peekIndex = peek ? peeked.findIndex((paper) => paperKey(paper.title) === peek.key) : -1;

  const cycleStyle = () => {
    const i = STYLES.findIndex((x) => x.id === win.style);
    const next = STYLES[(i + 1) % STYLES.length];
    persist(rectRef.current, { style: next.id, tint: next.tint });
    setSaid(`Window style: ${next.label}`);
  };

  // ---- the keyboard ---------------------------------------------------------
  // ⌘ + an arrow *moves* the window, faster the longer the key is held; ⌘⇧ +
  // an arrow throws it at that edge and cycles half / a third / two thirds.
  // Plain ⌘ + arrow is left alone in a text field, where it moves the caret.
  // Escape from inside the window closes it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const side = ARROWS[event.key];
      if (mod && side && !event.altKey && !stacked()) {
        if (event.shiftKey) {
          event.preventDefault();
          const i = snapped.current?.side === side ? snapped.current.step + 1 : 0;
          snapped.current = { side, step: i % SNAP_STEPS.length };
          run.current = null;
          const next = snap(side, i, viewport());
          setRect(next);
          persist(next);
          setSaid(`Claude window: ${EDGE_NAME[side]} ${SNAP_STEPS[i % SNAP_STEPS.length].label}`);
          return;
        }
        if (isEditable(document.activeElement)) return;
        event.preventDefault();
        snapped.current = null;
        const now = performance.now();
        const going = !!run.current && run.current.side === side && now - run.current.at < RUN_GAP;
        const by = stride(going ? run.current!.step : null);
        const before = rectRef.current;
        const moved = nudge(before, side, by, viewport());
        const stuck = moved.x === before.x && moved.y === before.y;
        setRect(moved);
        rectRef.current = moved;
        if (!going) persist(moved);
        clearTimeout(runSave.current);
        runSave.current = window.setTimeout(() => persist(rectRef.current), RUN_GAP);
        // A held arrow repeats thirty times a second: speak once when the run
        // starts, and once more the first time it runs out of room.
        if (stuck && !(going && run.current?.stuck)) setSaid(`Claude window: at the ${EDGE_NAME[side]}`);
        else if (!going && !stuck) setSaid(`Claude window moving ${side}`);
        run.current = { side, step: by, at: now, stuck };
        return;
      }
      if (event.key === 'Escape' && !mod && frame.current?.contains(document.activeElement)) {
        event.preventDefault();
        if (s.live) stop();
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, persist, s.live]);

  // ---- the thread -----------------------------------------------------------
  const frame = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const following = useRef(true);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // A quote attached from the paper is something to ask about: go to the box.
  useEffect(() => {
    if (s.quote) inputRef.current?.focus();
  }, [s.quote]);

  // Follow a streaming answer down, unless the reader has scrolled up to reread.
  useLayoutEffect(() => {
    const el = body.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [s.turns]);

  // Every code block gets a Copy button, once.
  useEffect(() => {
    body.current?.querySelectorAll('.chat-claude pre').forEach((pre) => {
      if (pre.querySelector('.chat-copy')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn sm chat-copy';
      button.textContent = 'Copy';
      pre.append(button);
    });
  });

  const grow = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = input.trim();
    if (!text || s.live || !s.hasKey) return;
    following.current = true;
    setInput('');
    requestAnimationFrame(grow);
    void send(text, screen());
  };

  const ideas = reading
    ? ['What is the main contribution, in two sentences?', 'Explain the passage I am looking at.', 'What would I need to know to follow section 3?']
    : ['Which of these papers should I read first?', 'What do these papers have in common?'];

  const model = MODELS.find((m) => m.id === s.prefs.model) ?? MODELS[0];
  const style = styleAt(win.style);
  const floating = !isStacked;
  const position = floating
    ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h, ['--win-tint' as string]: String(win.tint) }
    : {};

  return (
    <section
      ref={frame}
      className={`assistant-win${floating ? ' is-floating' : ' is-sheet'}`}
      data-win-style={style.id}
      style={position}
      role="dialog"
      aria-modal="false"
      aria-label="Ask Claude"
    >
      <header
        className="win-bar"
        onPointerDown={(event) => begin(event, null)}
        onPointerMove={step}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={(event) => {
          if (!floating || (event.target as HTMLElement).closest('button, input, label')) return;
          snapped.current = null;
          run.current = null;
          const next = zoom(rectRef.current, viewport());
          setRect(next);
          persist(next);
        }}
        title={floating ? 'Drag to move · double-click to zoom · ⌘ + arrows to move · ⌘⇧ + arrows to snap' : undefined}
      >
        <SparkleIcon size={15} className="win-mark" />
        <span className="win-name">Ask Claude</span>
        <span className="win-ctl">
          {floating ? (
            <>
              <label className="win-tint" title="Window transparency">
                <span aria-hidden="true">◐</span>
                <input
                  type="range"
                  min={25}
                  max={100}
                  step={5}
                  value={Math.round(win.tint * 100)}
                  aria-label="Window opacity"
                  onChange={(event) => persist(rectRef.current, { tint: clamp(Number(event.target.value) / 100, 0.25, 1) })}
                />
              </label>
              <button type="button" className="win-btn win-style" onClick={cycleStyle} title="Change the window's look">
                {style.label}
              </button>
            </>
          ) : null}
          <button type="button" className="win-btn" onClick={onClose} aria-label="Close Ask Claude" title="Close (Esc, or ⌘\)">
            <CloseIcon size={14} />
          </button>
        </span>
      </header>

      <div className="chat-toolbar">
        <select
          className="chat-model"
          value={model.id}
          disabled={s.live}
          onChange={(event) => setModel(event.target.value)}
          title="Which Claude model answers"
          aria-label="Model"
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} — {m.note}
            </option>
          ))}
        </select>
        <span style={{ flexGrow: 1 }} />
        <button
          type="button"
          className="btn ghost sm"
          aria-pressed={drawer === 'history'}
          onClick={() => setDrawer(drawer === 'history' ? null : 'history')}
          title="Earlier conversations, kept in this browser"
        >
          History{s.history.length ? <span className="chat-count">{s.history.length}</span> : null}
        </button>
        <button
          type="button"
          className="btn ghost sm"
          disabled={s.live || !s.turns.length}
          onClick={() => {
            newChat();
            setDrawer(null);
          }}
          title="File this conversation in History and start a new one"
        >
          New chat
        </button>
        <button
          type="button"
          className="btn ghost sm"
          aria-pressed={drawer === 'settings'}
          onClick={() => setDrawer(drawer === 'settings' ? null : 'settings')}
          title="What Claude sees, where paper cards go, and your key"
          aria-label="Settings"
        >
          ⚙
        </button>
      </div>

      {drawer === 'settings' ? (
        <ChatSettings
          context={s.prefs.context}
          hasKey={s.hasKey}
          paperLayout={paperLayout}
          marks={settings.chatMarks ?? 'auto'}
          look={settings.passageLook ?? 'marker'}
          onMarks={(chatMarks) => updateSettings({ chatMarks })}
          onLook={(passageLook) => updateSettings({ passageLook })}
        />
      ) : drawer === 'history' ? (
        <div className="chat-drawer">
          <div className="chat-set-title">Previous chats</div>
          {s.history.length ? (
            <>
              {s.history.map((chat) => {
                const asks = chat.turns.filter((t) => t.role === 'user').length;
                const current = chat.id === s.threadId;
                return (
                  <div key={chat.id} className={`chat-hist-row${current ? ' is-on' : ''}`}>
                    <button
                      type="button"
                      className="chat-hist-open"
                      title={chat.title}
                      aria-current={current || undefined}
                      disabled={s.live}
                      onClick={() => {
                        openChat(chat.id);
                        setDrawer(null);
                      }}
                    >
                      <span className="chat-hist-title">{chat.title}</span>
                      <span className="chat-hist-meta">
                        {asks} question{asks === 1 ? '' : 's'} · {ago(chat.updated)}
                        {current ? ' · open' : ''}
                      </span>
                    </button>
                    <button type="button" className="chat-hist-del" onClick={() => deleteChat(chat.id)} aria-label="Delete this chat" title="Delete this chat">
                      ✕
                    </button>
                  </div>
                );
              })}
              <div className="chat-hist-foot">
                <p className="chat-set-note">Kept in this browser only — no account, nothing uploaded. The screen that went with each question is not stored.</p>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    if (confirm(`Delete all ${s.history.length} saved chat${s.history.length === 1 ? '' : 's'} from this browser? This cannot be undone.`)) clearHistory();
                  }}
                >
                  Delete all
                </button>
              </div>
            </>
          ) : (
            <p className="chat-set-note">No chats yet. Every conversation is filed here as soon as Claude answers, and stays in this browser until you delete it.</p>
          )}
        </div>
      ) : null}

      <div
        className="chat-body"
        data-marks={settings.chatMarks ?? 'auto'}
        ref={body}
        onScroll={(event) => {
          const el = event.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          // A kept card follows its name; one that was only pointed at goes.
          if (peek) setPeek(peek.pinned ? { ...peek } : null);
        }}
        onPointerOver={(event) => {
          if (event.pointerType !== 'mouse') return;
          const mention = (event.target as HTMLElement).closest<HTMLElement>('.chat-mention');
          if (!mention || peek?.pinned) return;
          clearTimeout(peekTimer.current);
          peekTimer.current = window.setTimeout(
            () => showPeek(Number(mention.dataset.turn), paperKey(mention.dataset.paper ?? ''), mention, false),
            180,
          );
        }}
        onPointerOut={(event) => {
          if (event.pointerType === 'mouse' && (event.target as HTMLElement).closest('.chat-mention')) hidePeekSoon();
        }}
        onClick={(event) => {
          const mention = (event.target as HTMLElement).closest<HTMLElement>('.chat-mention');
          const cardButton = (event.target as HTMLElement).closest<HTMLElement>('.chat-card-find, .chat-card-add');
          if (cardButton?.dataset.paper) {
            const title = cardButton.dataset.paper;
            return cardButton.classList.contains('chat-card-add') ? void addPapers([{ title }]) : findPaper(title);
          }
          if (mention) {
            const key = paperKey(mention.dataset.paper ?? '');
            if (peek?.pinned && peek.key === key) return setPeek(null);
            return showPeek(Number(mention.dataset.turn), key, mention, true);
          }
          const copy = (event.target as HTMLElement).closest('.chat-copy');
          if (!copy) return;
          const code = copy.parentElement?.querySelector('code')?.textContent ?? '';
          void navigator.clipboard?.writeText(code);
          copy.textContent = 'Copied';
          window.setTimeout(() => (copy.textContent = 'Copy'), 1200);
        }}
      >
        {!s.hasKey ? <KeyCard /> : null}
        {s.hasKey && !s.turns.length ? (
          <div className="chat-empty">
            <p>
              Just ask — Claude reads your screen first. {reading ? 'The paper, the passage in view, what you have selected and your highlights' : 'The list you are looking at'}{' '}
              go along with the question, so there is nothing to paste. The ⚙ menu says exactly what, and lets you hold anything back.
            </p>
            <ul>
              {ideas.map((idea) => (
                <li key={idea}>
                  <button type="button" className="link-btn" onClick={() => setInput(idea)}>
                    {idea}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {s.turns.map((turn, index) => (
          <TurnView key={index} index={index} turn={turn} actions={actions} question={s.turns[index - 1]?.role === 'user' ? s.turns[index - 1].content : undefined} />
        ))}
      </div>

      {s.quote ? (
        <div className="chat-quote">
          <span className="chat-quote-text">“{s.quote.length > 220 ? `${s.quote.slice(0, 219)}…` : s.quote}”</span>
          <button type="button" className="win-btn" onClick={() => setQuote('')} aria-label="Remove the quoted passage" title="Remove">
            <CloseIcon size={12} />
          </button>
        </div>
      ) : null}

      {s.shot ? (
        <div className="chat-quote chat-shot">
          <img src={`data:image/jpeg;base64,${s.shot}`} alt="The screenshot that goes with the next question" />
          <span className="chat-quote-text">A screenshot of this tab goes with your next question.</span>
          <button type="button" className="win-btn" onClick={() => setShot('')} aria-label="Remove the screenshot" title="Remove">
            <CloseIcon size={12} />
          </button>
        </div>
      ) : shotError ? (
        <p className="chat-shot-error">{shotError}</p>
      ) : null}

      <form className="chat-compose" onSubmit={submit}>
        {canCapture() ? (
          <button
            type="button"
            className="btn sm chat-shot-btn"
            onClick={() => void takeShot()}
            disabled={!s.hasKey || s.live || shooting}
            aria-label="Attach a screenshot of this tab"
            title="Attach a screenshot of this tab — your browser asks first"
          >
            <CameraIcon size={16} />
          </button>
        ) : null}
        <textarea
          ref={inputRef}
          rows={1}
          value={input}
          disabled={!s.hasKey}
          placeholder={s.hasKey ? (reading ? 'Ask about this paper…' : 'Ask Claude…') : 'Add an API key above to start'}
          aria-label="Ask Claude"
          onChange={(event) => {
            setInput(event.target.value);
            grow();
          }}
          onKeyDown={(event) => {
            // ↵ sends, ⇧↵ makes a new line — the convention every chat box uses.
            if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        {s.live ? (
          <button type="button" className="btn sm" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="btn primary sm" disabled={!s.hasKey || !input.trim()}>
            Send
          </button>
        )}
      </form>

      {floating
        ? DIRS.map((dir) => (
            <div
              key={dir}
              className={`win-grip win-grip-${dir}`}
              onPointerDown={(event) => begin(event, dir)}
              onPointerMove={step}
              onPointerUp={end}
              onPointerCancel={end}
            />
          ))
        : null}

      <span className="vh" aria-live="polite">
        {said}
      </span>

      {peek && peekIndex >= 0 && peek.anchor.isConnected
        ? createPortal(
            <div
              className="chat-peek"
              role="dialog"
              aria-label={peeked[peekIndex].title}
              style={peekPlace(peek.anchor.getBoundingClientRect())}
              onPointerEnter={() => clearTimeout(peekTimer.current)}
              onPointerLeave={(event) => {
                if (event.pointerType === 'mouse') hidePeekSoon();
              }}
            >
              {peek.pinned ? (
                <button type="button" className="icon-btn chat-peek-close" aria-label="Close" onClick={() => setPeek(null)}>
                  <CloseIcon size={13} />
                </button>
              ) : null}
              <PaperCard paper={peeked[peekIndex]} n={peekIndex + 1} actions={actions} />
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}
