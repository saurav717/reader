// The Learn page: one page of a track, over everything, laid out as Explain
// lays a paper out — the outline on the left (here: the track's pages, and the
// glossary so far), the prose in the middle, its pictures beside it — with a
// switch for how much of it is shown (plain, formal, with code), the bar for
// questions and adjustments, and the check at the end.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getState, modelSpec, PROVIDERS, setAskModel, subscribe } from '../lib/assistant';
import ModelChip from './ModelChip';
import { parseExplanation } from '../lib/explain';
import type { Block } from '../lib/explain';
import {
  checkOf,
  clearCheck,
  countRead,
  dismissPagePending,
  isWorking,
  markConfident,
  markRead,
  nodeAfter,
  nodeBefore,
  nodeStates,
  pageSections,
  recordCheck,
  revisePage,
  shownContent,
  stopLearning,
  subscribeLearn,
  touchTrack,
  trackFor,
  undoPageRevision,
  writePage,
} from '../lib/learn';
import type { CheckAnswer, LearnNode } from '../lib/learn';
import { typesetMath } from '../lib/typesetMath';
import { KeepContext } from './Keep';
import { lastThought, SectionView } from './Explain';
import { CheckView, LearnContext, LEVELS } from './LearnBlocks';
import type { LearnLevel } from './LearnBlocks';
import { CloseIcon, SparkleIcon } from './icons';
import { useStore } from '../lib/store';

const LEVEL_KEY = 'reader.learn.level';
const readLevel = (): LearnLevel => {
  try {
    const stored = localStorage.getItem(LEVEL_KEY);
    if (stored === 'plain' || stored === 'formal' || stored === 'code') return stored;
  } catch {
    // private mode
  }
  return 'plain';
};

interface Props {
  trackId: string;
  nodeId: string;
  /** Another page of the track: the one after, the one before, one from the outline. */
  onOpen: (nodeId: string) => void;
  /** A paper node: open the paper in the reader when it is in the library, else find it. */
  onOpenPaper: (node: LearnNode) => void;
  onMap: () => void;
  onClose: () => void;
}

export default function Learn({ trackId, nodeId, onOpen, onOpenPaper, onMap, onClose }: Props) {
  const assistant = useSyncExternalStore(subscribe, getState);
  const track = useSyncExternalStore(subscribeLearn, () => trackFor(trackId));
  const { papers } = useStore();
  const node = track?.nodes.find((n) => n.id === nodeId);
  const page = track?.pages[nodeId];
  const working = useSyncExternalStore(subscribeLearn, () => isWorking(trackId, nodeId));
  const [level, setLevel] = useState<LearnLevel>(readLevel);
  const scrollRef = useRef<HTMLDivElement>(null);
  const askRef = useRef<HTMLInputElement>(null);
  const [ask, setAsk] = useState('');
  const [askFocused, setAskFocused] = useState(false);
  const [active, setActive] = useState('');

  const writerModel = page?.model ?? track?.model ?? assistant.prefs.explainModel ?? assistant.prefs.model;
  const writer = modelSpec(writerModel).label;
  const askModel = assistant.prefs.askModel ?? writerModel;
  const asker = modelSpec(askModel).label;
  const hasKey = Boolean(assistant.keys[modelSpec(writerModel).provider]);

  useEffect(() => {
    try {
      localStorage.setItem(LEVEL_KEY, level);
    } catch {
      // private mode
    }
  }, [level]);

  // Opening a page writes it when it has not been written: the box on the map was clicked for that.
  useEffect(() => {
    touchTrack(trackId);
    if (!track || !node || node.kind === 'paper') return;
    if (!page?.content && !page?.streaming && !page?.error && hasKey) void writePage(trackId, nodeId);
  }, [trackId, nodeId]); // eslint-disable-line react-hooks/exhaustive-deps
  // A page with something on it, open, is read — never one that is still being written, or was not.
  const hasContent = Boolean(page?.content) && !page?.streaming;
  useEffect(() => {
    if (hasContent && node?.kind === 'page') markRead(trackId, nodeId);
  }, [hasContent, trackId, nodeId, node?.kind]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const from = event.target instanceof Element ? event.target : document.activeElement;
      if (event.key === 'Escape' && !from?.closest('input, textarea, .assistant-win') && !document.querySelector('.scrim, .figure-closeup')) onClose();
      if (event.key === '/' && !(event.target as HTMLElement | null)?.closest('input, textarea, [contenteditable="true"]')) {
        event.preventDefault();
        askRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shown = shownContent(page);
  const allSections = useMemo(() => parseExplanation(shown), [shown]);
  const sections = useMemo(() => pageSections(allSections), [allSections]);
  const questions = useMemo(() => checkOf(allSections), [allSections]);
  const cells = useMemo(() => {
    const numbers = new Map<Block, number>();
    let n = 0;
    for (const section of sections) for (const block of section.blocks) if (block.kind === 'code') numbers.set(block, ++n);
    return numbers;
  }, [sections]);
  const streaming = Boolean(page?.streaming);
  const pending = page?.pending;
  const busy = streaming || Boolean(pending && !pending.error);
  const thought = lastThought(page?.thinking);
  const lastRevision = page?.revisions?.[page.revisions.length - 1];

  useEffect(() => {
    void typesetMath(scrollRef.current);
  });
  // A new page starts at the top.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    setActive('');
  }, [nodeId]);
  // The outline follows the reading.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const onScroll = () => {
      const heads = Array.from(scroller.querySelectorAll<HTMLElement>('[data-title]'));
      const line = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
      let current = '';
      for (const head of heads) if (head.getBoundingClientRect().top <= line) current = head.dataset.title ?? '';
      setActive(current);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [sections.length]);

  const submit = useCallback(
    async (request?: string) => {
      const text = (request ?? ask).trim();
      if (!text || busy || !page?.content) return;
      setAsk('');
      await revisePage(trackId, nodeId, text, askModel);
    },
    [ask, busy, page?.content, trackId, nodeId, askModel],
  );

  if (!track || !node) {
    return (
      <div className="explain learn layout-margin">
        <header className="explain-bar">
          <span className="explain-brand">
            <SparkleIcon size={15} /> Learn
          </span>
          <span className="explain-bar-title">This page is no longer here.</span>
          <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close">
            <CloseIcon size={17} />
          </button>
        </header>
      </div>
    );
  }

  const states = nodeStates(track);
  const index = track.nodes.findIndex((n) => n.id === nodeId);
  const before = nodeBefore(track, nodeId);
  const after = nodeAfter(track, nodeId);
  const counts = countRead(track);
  const inLibrary = node.kind === 'paper' ? papers.find((paper) => (node.paper?.arxivId && paper.arxivId === node.paper.arxivId) || paper.title.toLowerCase() === node.paper?.title.toLowerCase()) : undefined;
  const canAsk = Boolean(page?.content) && !streaming && Boolean(assistant.keys[modelSpec(askModel).provider]);
  const goAfter = after ? () => (after.kind === 'paper' ? onOpenPaper(after) : onOpen(after.id)) : undefined;

  return (
    <LearnContext.Provider value={{ level, model: page?.model ?? track.model }}>
      <div className={`explain learn layout-margin learn-level-${level}`}>
        <header className="explain-bar">
          <span className="explain-brand">
            <SparkleIcon size={15} /> Learn
          </span>
          <span className="explain-bar-title">
            {track.topic} · {String(index + 1).padStart(2, '0')} {node.title}
          </span>
          <div className="segmented" role="group" aria-label="How much of the page to show">
            {LEVELS.map((item) => (
              <button key={item.id} type="button" aria-pressed={level === item.id} onClick={() => setLevel(item.id)} title={item.note}>
                {item.label}
              </button>
            ))}
          </div>
          {streaming || (pending && !pending.error) ? (
            <button type="button" className="btn sm" onClick={stopLearning}>
              Stop
            </button>
          ) : node.kind === 'page' ? (
            <button type="button" className="btn sm" disabled={!hasKey || busy} onClick={() => void writePage(trackId, nodeId)} title={page?.content ? `Write this page again with ${writer}` : `Write this page with ${writer}`}>
              {page?.content ? 'Rewrite' : 'Write it'}
            </button>
          ) : null}
          <button type="button" className="btn sm ghost" onClick={onMap} title="Back to the map of this track, on Home">
            Map
          </button>
          <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close the page (Esc)" title="Close (Esc)">
            <CloseIcon size={17} />
          </button>
        </header>

        {node.kind === 'page' ? (
          <div className="explain-ask">
            <div className="ask-column">
              <form
                className={`ask-field${busy ? ' is-busy' : ''}${askFocused ? ' is-focused' : ''}${!canAsk ? ' is-off' : ''}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                <SparkleIcon size={16} />
                <input
                  ref={askRef}
                  value={ask}
                  disabled={!canAsk || busy}
                  onChange={(event) => setAsk(event.target.value)}
                  onFocus={() => setAskFocused(true)}
                  onBlur={() => window.setTimeout(() => setAskFocused(false), 150)}
                  placeholder={!page?.content ? 'Ask about this page, or tell the model how to change it, once it is written' : `Ask about this page, or tell ${asker} how to change it — “simpler”, “draw this in 2-D”, “another example” ( / )`}
                />
                <ModelChip value={askModel} writer={page?.model} keys={assistant.keys} disabled={busy || !page?.content} what="Answers here with" onChange={(id) => setAskModel(id === page?.model ? '' : id)} />
                {busy && pending ? (
                  <button type="button" className="btn sm" onClick={stopLearning}>
                    Stop
                  </button>
                ) : (
                  <button type="submit" className="btn sm primary" disabled={!canAsk || !ask.trim()}>
                    Ask
                  </button>
                )}
              </form>
              {pending && !pending.error ? (
                <div className="ask-status is-live">
                  <span className="spinner" />
                  <span className="ask-note">
                    {thought ? `Thinking — ${thought}` : 'Reading your request'} — <em>{pending.request}</em>
                  </span>
                </div>
              ) : pending?.error ? (
                <div className="ask-status is-error">
                  <span className="ask-note">{pending.error}</span>
                  <button type="button" className="btn sm ghost" onClick={() => dismissPagePending(trackId, nodeId)}>
                    Dismiss
                  </button>
                </div>
              ) : askFocused && !ask && canAsk ? (
                <div className="ask-suggestions">
                  {['Explain this more simply, with a picture', 'Give me a concrete worked example', 'Draw the key idea as a sequence of panels', 'Go deeper into the maths', 'Animate the key figure', 'Add a short code cell that shows it'].map((suggestion) => (
                    <button key={suggestion} type="button" className="ask-suggestion" onMouseDown={(event) => event.preventDefault()} onClick={() => void submit(suggestion)}>
                      {suggestion}
                    </button>
                  ))}
                </div>
              ) : lastRevision ? (
                <div className="ask-status is-done">
                  <span className="check">✓</span>
                  <span className="ask-note">{lastRevision.note || `Done: ${lastRevision.request}`}</span>
                  <button type="button" className="btn sm ghost" onClick={() => undoPageRevision(trackId, nodeId)} title={`Put the page back as it was before “${lastRevision.request}”`}>
                    Undo
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="explain-scroll" ref={scrollRef}>
          <aside className="explain-outline learn-outline">
            <div className="outline-paper">
              <div className="outline-title">{track.topic}</div>
              <div className="outline-byline">
                {counts.total} pages · {counts.read} read{counts.confident ? ` · ${counts.confident} confident` : ''}
              </div>
            </div>
            <ol>
              {track.nodes.map((item, i) => (
                <li key={item.id} className={item.id === nodeId ? 'active' : ''}>
                  <a
                    href={`#learn-${item.id}`}
                    onClick={(event) => {
                      event.preventDefault();
                      if (item.id === nodeId) return;
                      if (item.kind === 'paper') onOpenPaper(item);
                      else onOpen(item.id);
                    }}
                    title={item.blurb}
                  >
                    <span className="n">{String(i + 1).padStart(2, '0')}</span>
                    <span className="t">{item.kind === 'paper' ? `📄 ${item.title}` : item.title}</span>
                    <span className={`dot learn-dot is-${states[item.id]}`} aria-label={states[item.id]} />
                  </a>
                </li>
              ))}
            </ol>
            {sections.length ? (
              <div className="outline-aged">
                <div className="aged-label">On this page</div>
                {sections
                  .filter((section) => section.title)
                  .map((section) => (
                    <a key={section.id} href={`#explain-${section.id}`} className={`learn-outline-section${active === section.title ? ' is-active' : ''}`}>
                      {section.title}
                    </a>
                  ))}
                {questions.length ? (
                  <a href="#learn-check" className={`learn-outline-section${active === 'Check yourself' ? ' is-active' : ''}`}>
                    <b>Check yourself</b> · {questions.length} questions
                  </a>
                ) : null}
              </div>
            ) : null}
            {track.glossary.length ? (
              <div className="outline-aged">
                <div className="aged-label">Glossary so far</div>
                {track.glossary.slice(-12).map((entry, i) => (
                  <div key={`${entry.term}-${i}`} className="learn-gloss" title={entry.meaning}>
                    <b>{entry.term}</b> {entry.meaning}
                  </div>
                ))}
              </div>
            ) : null}
            <div className="outline-meta">
              {page?.content ? `Written by ${writer} · ${new Date(page.created).toLocaleDateString()}` : node.kind === 'paper' ? 'A paper to read' : 'Not written yet'}
            </div>
          </aside>

          <KeepContext.Provider value={null}>
            <article className="explain-doc">
              <header className="explain-title">
                <div className="explain-kicker">
                  <SparkleIcon size={16} /> {track.topic} · {node.stage}
                </div>
                <h1>{node.title}</h1>
                <div className="byline">{node.blurb}</div>
              </header>

              {node.kind === 'paper' ? (
                <PaperNode node={node} inLibrary={Boolean(inLibrary)} onOpen={() => onOpenPaper(node)} />
              ) : !page?.content && !streaming ? (
                <div className="learn-empty">
                  {page?.error ? <p className="explain-error">{page.error}</p> : null}
                  {!hasKey ? (
                    <p>
                      {writer} needs its key in Settings before it can write this page{PROVIDERS[modelSpec(writerModel).provider] ? ` (${PROVIDERS[modelSpec(writerModel).provider].name})` : ''}.
                    </p>
                  ) : (
                    <p>This page has not been written yet.</p>
                  )}
                  <button type="button" className="btn primary" disabled={!hasKey || working} onClick={() => void writePage(trackId, nodeId)}>
                    Write this page with {writer}
                  </button>
                </div>
              ) : (
                <>
                  {sections.map((section, i) => (
                    <SectionView key={section.id} section={section} number={i + (sections[0]?.title ? 1 : 0)} cells={cells} stage={level === 'plain' ? 'inline' : 'margin'} writer={writer} asker={asker} />
                  ))}
                  {streaming ? (
                    <p className="explain-writing">
                      <span className="spinner" />
                      {thought ? (
                        <span>
                          {writer} is thinking — <em>{thought}</em>
                        </span>
                      ) : (
                        <span>
                          {writer} is writing{sections.length ? ` — ${sections[sections.length - 1].title || 'the opening'}` : ''}…
                        </span>
                      )}
                    </p>
                  ) : null}
                  {page?.truncated ? <p className="explain-error">The page ran past the length allowed and was cut short. Rewrite it, or ask for the missing part in the bar.</p> : null}
                  {page?.error && !streaming ? <p className="explain-error">{page.error}</p> : null}
                  {!streaming && questions.length && track.prefs.checks ? (
                    <CheckView
                      key={`${nodeId}:${page?.check?.at ?? 0}`}
                      questions={questions}
                      result={page?.check}
                      nodeId={nodeId}
                      nextTitle={after?.title}
                      onSubmit={(answers: CheckAnswer[]) => recordCheck(trackId, nodeId, questions, answers)}
                      onRetry={() => clearCheck(trackId, nodeId)}
                      onContinue={goAfter}
                      onReread={() => {
                        setLevel('formal');
                        scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                      onConfident={() => {
                        markConfident(trackId, nodeId);
                        if (goAfter) goAfter();
                      }}
                    />
                  ) : null}
                  {!streaming && page?.content ? (
                    <footer className="learn-footer">
                      {before ? (
                        <button type="button" className="btn" onClick={() => (before.kind === 'paper' ? onOpenPaper(before) : onOpen(before.id))}>
                          ← {String(index).padStart(2, '0')} {before.title}
                        </button>
                      ) : null}
                      {!questions.length || !track.prefs.checks ? (
                        <button type="button" className="btn" onClick={() => markConfident(trackId, nodeId)} disabled={states[nodeId] === 'confident'}>
                          {states[nodeId] === 'confident' ? 'Marked confident' : 'I’m confident, mark it done'}
                        </button>
                      ) : null}
                      {after ? (
                        <button type="button" className="btn primary" onClick={goAfter}>
                          {String(index + 2).padStart(2, '0')} {after.title} →
                        </button>
                      ) : (
                        <button type="button" className="btn primary" onClick={onMap}>
                          The end of the track · back to the map
                        </button>
                      )}
                    </footer>
                  ) : null}
                </>
              )}
            </article>
          </KeepContext.Provider>
        </div>
      </div>
    </LearnContext.Provider>
  );
}

/** A paper node: the paper to read, now that the pages before it are read. */
function PaperNode({ node, inLibrary, onOpen }: { node: LearnNode; inLibrary: boolean; onOpen: () => void }) {
  return (
    <div className="learn-empty learn-paper">
      <p>
        The pages before this one have taught what this paper assumes. Read it as the authors wrote it{inLibrary ? ', from your library' : ''}, and press <kbd>E</kbd> on it for Explain’s walkthrough, which
        will use the same names these pages did.
      </p>
      <p className="learn-paper-title">
        {node.paper?.title ?? node.title}
        {node.paper?.authors ? <span> · {node.paper.authors}</span> : null}
        {node.paper?.arxivId ? <span> · arXiv:{node.paper.arxivId}</span> : null}
      </p>
      <button type="button" className="btn primary" onClick={onOpen}>
        {inLibrary ? 'Open the paper' : 'Find the paper'}
      </button>
    </div>
  );
}

