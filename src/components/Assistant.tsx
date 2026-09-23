import DOMPurify from 'dompurify';
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
  stop,
  subscribe,
} from '../lib/assistant';
import type { Screen, Turn } from '../lib/assistant';
import {
  RUN_GAP,
  SNAP_STEPS,
  STACK_WIDTH,
  STYLES,
  clamp,
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
import { CloseIcon, SparkleIcon } from './icons';

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

function TurnView({ turn }: { turn: Turn }) {
  if (turn.role === 'user') {
    return (
      <div className="chat-turn chat-user">
        <div
          className="chat-text"
          // The quote that leads a question renders as a quote; the rest is plain text.
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(markdown(turn.content)) }}
        />
      </div>
    );
  }
  return (
    <div className="chat-turn chat-claude">
      {turn.thinking?.trim() ? (
        <details className="chat-thinking">
          <summary>Reasoning</summary>
          <div>{turn.thinking}</div>
        </details>
      ) : null}
      {turn.content ? (
        <div className="chat-text" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(markdown(turn.content), { ADD_ATTR: ['target'] }) }} />
      ) : turn.streaming ? (
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
  screen: () => Screen;
  /** Whether a paper is open, for the suggestions on an empty thread. */
  reading: boolean;
}

export default function Assistant({ onClose, screen, reading }: Props) {
  const s = useSyncExternalStore(subscribe, getState);
  const [drawer, setDrawer] = useState<'settings' | 'history' | null>(null);
  const [input, setInput] = useState('');
  const [said, setSaid] = useState('');

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
          title="What Claude sees, and your key"
          aria-label="Settings"
        >
          ⚙
        </button>
      </div>

      {drawer === 'settings' ? (
        <div className="chat-drawer">
          <div className="chat-set-title">What Claude sees on your screen</div>
          <p className="chat-set-note">
            Read fresh every time you send, so you never have to paste a passage in. Turn off anything you would rather keep to
            yourself.
          </p>
          {CONTEXT_ROWS.map(([key, label, note]) => (
            <label key={key} className="chat-set-row" title={note}>
              <input type="checkbox" checked={s.prefs.context[key]} onChange={(event) => setContext(key, event.target.checked)} />
              <span>{label}</span>
              <span className="chat-set-note">{note}</span>
            </label>
          ))}
          {s.hasKey ? (
            <>
              <div className="chat-set-title">Account</div>
              <p className="chat-set-note">Your API key is in this browser only, and goes straight to Anthropic.</p>
              <button type="button" className="btn sm" onClick={forgetKey}>
                Forget my key
              </button>
            </>
          ) : null}
        </div>
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
        ref={body}
        onScroll={(event) => {
          const el = event.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        onClick={(event) => {
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
          <TurnView key={index} turn={turn} />
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

      <form className="chat-compose" onSubmit={submit}>
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
    </section>
  );
}
