import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { markTourSeen } from '../lib/tour';
import { startShowcase } from '../lib/showcase';
import { CloseIcon } from './icons';

/**
 * What the tour needs from the app: where it is, and the few things it moves
 * — between Home and a paper, and shutting what a "try it" step opened.
 */
export interface TourHost {
  /** Whether there is a paper for the reading half of the tour to open. */
  hasPaper: boolean;
  atHome: boolean;
  reading: boolean;
  goHome: () => void;
  openPaper: () => void;
  closePalette: () => void;
  closeAssistant: () => void;
  closeNotes: () => void;
  leaveZen: () => void;
}

interface TryIt {
  /** What to press, shown in the card. */
  prompt: ReactNode;
  /** Called on entering the step: puts away what the step asks for, so pressing the key brings it out. */
  begin?: (host: TourHost) => void;
  done: (host: TourHost) => boolean;
  /** On leaving the step: puts away what it opened. */
  after?: (host: TourHost) => void;
  /** Where the ring moves once it is done, if not where it was. */
  doneTarget?: string | null;
}

interface Step {
  id: string;
  /** The page the step is on; 'any' is a card over whatever is open. */
  place: 'home' | 'paper' | 'any';
  /** The element the ring goes round, as a selector; none for a card in the middle. */
  target?: string;
  title: string;
  body: ReactNode;
  tryIt?: TryIt;
}

const K = ({ children }: { children: ReactNode }) => <kbd className="tour-key">{children}</kbd>;

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = mac ? '⌘' : 'Ctrl';

let tabBefore = '';
const activeTab = () => document.querySelector('.home-tab.is-on')?.textContent ?? '';
/** Whether the dock is showing a pane — and not on its way out. */
const dockShows = (name: string) =>
  document.querySelector('.dock-tabs [role="tab"][aria-selected="true"]')?.textContent?.trim() === name && !document.querySelector('.app.dock-slide-out');

const STEPS: Step[] = [
  {
    id: 'welcome',
    place: 'any',
    title: 'Welcome to Koios',
    body: (
      <>
        <p>Search the indexes, keep what you collect, read it with highlights, and ask a model about it — all from one window.</p>
        <p>
          This tour takes two minutes and points at the real thing. Where it says <em>try it</em>, press the key and watch. <K>Esc</K> leaves it at any step, and it is in
          Settings whenever you want it back.
        </p>
      </>
    ),
  },
  {
    id: 'rail',
    place: 'home',
    target: '.rail',
    title: 'The rail',
    body: (
      <>
        <p>
          <b>R</b> is Home. Under it: the paper you are reading, the <b>Library</b> — your papers and collections — <b>Projects</b>, <b>Code</b> for the Playground, and at the
          foot, <b>Settings</b>.
        </p>
        <p>Rest the pointer on anything for what it does and its key.</p>
      </>
    ),
  },
  {
    id: 'views',
    place: 'home',
    target: '.home-tabs',
    title: 'Home’s views',
    body: (
      <>
        <p>
          <b>Find papers</b>, <b>Continue reading</b>, <b>Today</b>, <b>Inbox</b>, <b>Collections</b> — each a way of looking at your library, a number key apart. The <b>⋯</b> at the
          end chooses which are shown and which Home opens on.
        </p>
      </>
    ),
    tryIt: {
      prompt: (
        <>
          Press <K>2</K> to switch to the next view
        </>
      ),
      begin: () => {
        tabBefore = activeTab();
      },
      done: () => activeTab() !== tabBefore,
    },
  },
  {
    id: 'find',
    place: 'home',
    target: '.find-hero',
    title: 'Find papers',
    body: (
      <>
        <p>
          One box over arXiv, OpenAlex, Semantic Scholar, Crossref and Google Scholar — or paste an arXiv id or a DOI. <b>Search in</b> picks the indexes; <b>Save to</b> is the
          collection the <b>+</b> on each result adds it to, and a result can be dragged onto a collection instead.
        </p>
        <p>
          <K>/</K> focuses the box from anywhere on Home. Click a result for its abstract and every place it can be read from.
        </p>
      </>
    ),
  },
  {
    id: 'palette',
    place: 'home',
    target: '.home-search',
    title: 'Jump anywhere',
    body: (
      <>
        <p>
          The command palette finds a paper in your library by its title or an author, searches the indexes for one that is not there yet, and runs actions — making a
          collection, opening Settings, starting this tour.
        </p>
      </>
    ),
    tryIt: {
      prompt: (
        <>
          Press <K>{MOD} K</K> to open it
        </>
      ),
      done: () => Boolean(document.querySelector('.palette')),
      after: (host) => host.closePalette(),
    },
  },
  {
    id: 'reading',
    place: 'paper',
    target: '.reader-head .topbar',
    title: 'Reading a paper',
    body: (
      <>
        <p>
          <b>Reflow</b> lays the paper out as text you can select and highlight; <b>PDF</b> shows the file as it was typeset, and the book button puts two pages side by side.
          The download keeps the PDF; a cloud mark says it is already in your Drive.
        </p>
        <p>Rest the pointer on an author, the venue or a citation and a card says who, where, and what was cited.</p>
      </>
    ),
  },
  {
    id: 'highlights',
    place: 'paper',
    target: '[title^="Highlights and notes"], [title^="Notes — "], .dock',
    title: 'Highlights and notes',
    body: (
      <>
        <p>
          Select a passage and pick a colour — four, each with a meaning you set. Right-click it instead for what a word <b>means</b>, where the idea <b>comes from</b>, and
          a <b>comment</b> that highlights as you type.
        </p>
        <p>Everything you mark lands in the pane beside the page, and in your Drive and Git repository.</p>
      </>
    ),
    tryIt: {
      prompt: (
        <>
          Press <K>H</K> to open the highlights beside the page
        </>
      ),
      begin: (host) => host.closeNotes(),
      done: () => dockShows('Notes') || Boolean(document.querySelector('.notes-window')),
      doneTarget: '.dock, .notes-window',
    },
  },
  {
    id: 'ask',
    place: 'paper',
    target: '[title^="Ask AI"]',
    title: 'Ask AI',
    body: (
      <>
        <p>
          A chat window floats over the paper and sees the page you are on. Ask it to explain a passage, or say <i>“show me where…”</i> and the paper scrolls to it. Claude,
          DeepSeek or Gemini — your pick, in Settings.
        </p>
      </>
    ),
    tryIt: {
      prompt: (
        <>
          Press <K>{MOD} \</K> — or <K>{MOD} J</K>
        </>
      ),
      begin: (host) => host.closeAssistant(),
      done: () => Boolean(document.querySelector('.assistant-win')),
      after: (host) => host.closeAssistant(),
      doneTarget: '.assistant-win',
    },
  },
  {
    id: 'explain',
    place: 'paper',
    target: '.explain-toggle',
    title: 'Explain the whole paper',
    body: (
      <>
        <p>
          <K>E</K> opens an explanation of the paper, section by section: its figures close up, the maths worked, runnable code, and what has changed since it was published.
        </p>
        <p>It runs on the model you chose and costs a call, so the tour leaves this key for you.</p>
      </>
    ),
  },
  {
    id: 'zen',
    place: 'paper',
    target: '[aria-label^="Zen mode"]',
    title: 'Just the paper',
    body: (
      <>
        <p>
          Zen puts the rail, the library, the dock and the top bar away; move the pointer to an edge of the screen and that side slides back. <K>F</K> takes the paper full
          screen, and <K>R</K> lays every paper in progress out as a desk, each at the line you left it.
        </p>
      </>
    ),
    tryIt: {
      prompt: (
        <>
          Press <K>Z</K> for zen mode
        </>
      ),
      begin: (host) => host.leaveZen(),
      done: () => Boolean(document.querySelector('.app.is-zen')),
      after: (host) => host.leaveZen(),
      doneTarget: null,
    },
  },
  {
    id: 'home',
    place: 'paper',
    target: '.topbar-home, .brand',
    title: 'Home and back',
    body: (
      <>
        <p>
          <K>G</K> goes between Home and the paper you are reading, both ways. On Home the paper waits in <b>Back to reading</b> beside the greeting, and under <b>R</b> on the
          rail.
        </p>
      </>
    ),
    tryIt: {
      prompt: (
        <>
          Press <K>G</K> to go Home
        </>
      ),
      done: (host) => host.atHome,
      doneTarget: '.home-back',
    },
  },
  {
    id: 'code',
    place: 'home',
    target: '[title^="Playground"]',
    title: 'Code of your own',
    body: (
      <>
        <p>
          <K>P</K> opens the Playground: a notebook or a project, run on your Colab, on this computer, or with the files here and a GPU somewhere else. Explain can hand it a
          paper’s code to run, and a run goes on when you leave its page.
        </p>
      </>
    ),
  },
  {
    id: 'library',
    place: 'home',
    target: '.rail [aria-label="Library"], .rail [title^="The Library"]',
    title: 'Your library, yours',
    body: (
      <>
        <p>
          The Library is every paper you have saved, as <b>reading now</b>, <b>not started</b> and <b>finished</b>, and your collections. Signed in, all of it — each paper, its
          highlights, the collections — lives in your own Google Drive, the same in any browser, and a Git repository can keep the notes and the bibliography beside it.
        </p>
      </>
    ),
  },
  {
    id: 'settings',
    place: 'home',
    target: '.rail [aria-label="Settings"], .rail [title^="Settings"]',
    title: 'Settings',
    body: (
      <>
        <p>
          Your Google account and the Git repository, the model keys for Ask AI and Explain, the paper proxy, the look of the app — light or dark, glass, how the rail is laid
          out — and this tour, to take again.
        </p>
      </>
    ),
  },
  {
    id: 'done',
    place: 'any',
    title: 'That’s the tour',
    body: (
      <>
        <p>
          Want to see it all done on a real paper? <b>Show me</b> finds <i>Attention Is All You Need</i>, opens it, asks about it, explains it, plans it and runs it — in two minutes, with the model replayed.
        </p>
        <p>
          Take this tour again any time: <b>Settings → Guided tour</b>, or <K>{MOD} K</K> and <i>Take the tour</i>.
        </p>
      </>
    ),
  },
];

/** The steps for this visit: without a paper to open, the reading steps are told, not shown. */
function stepsFor(hasPaper: boolean): Step[] {
  if (hasPaper) return STEPS;
  return STEPS.map((step) => (step.place === 'paper' ? { ...step, place: 'any', target: undefined, tryIt: undefined } : step));
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** How far the ring stands off its element, and the card off the ring. */
const PAD = 6;
const GAP = 18;
const EDGE = 12;
const CARD_WIDTH = 360;

function measure(selector: string | undefined): Box | null {
  if (!selector) return null;
  for (const candidate of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    const rect = candidate.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth) {
      return { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 };
    }
  }
  return null;
}

function sameBox(a: Box | null, b: Box | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.top - b.top) < 0.5 && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}

/**
 * The guided tour: a ring round one part of the app at a time, the rest of
 * the screen shaded, and a card beside it saying what that part does. Some
 * steps ask for a key; the tour watches for what it opens, says so, and
 * moves on. Esc, or Skip, leaves it; Settings and the palette bring it back.
 */
export default function Tour({ host, onClose }: { host: TourHost; onClose: () => void }) {
  const steps = stepsFor(host.hasPaper);
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState(false);
  /** The step whose `begin` has run: what a step watches for is not looked at before its own has. */
  const [beganAt, setBeganAt] = useState(-1);
  const began = beganAt === index;
  const [box, setBox] = useState<Box | null>(null);
  const [cardHeight, setCardHeight] = useState(0);
  const card = useRef<HTMLDivElement>(null);
  const hostRef = useRef(host);
  hostRef.current = host;
  const step = steps[Math.min(index, steps.length - 1)];
  const last = index === steps.length - 1;

  // Entering a step: go where it is, and remember what it watches for.
  useEffect(() => {
    const current = hostRef.current;
    if (step.place === 'home' && !current.atHome) current.goHome();
    if (step.place === 'paper' && current.hasPaper && !current.reading) current.openPaper();
    // A step that opens something waits for the page it is on before it puts
    // that thing away: the paper's panels come back with the paper.
    const begin = () => {
      step.tryIt?.begin?.(hostRef.current);
      setBeganAt(index);
    };
    setDone(false);
    const timer = window.setTimeout(begin, step.place === 'paper' && !current.reading ? 400 : 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  // Where the ring goes, followed as the page moves under it; and whether a
  // try-it step has been tried.
  useEffect(() => {
    const target = done && step.tryIt && step.tryIt.doneTarget !== undefined ? step.tryIt.doneTarget ?? undefined : step.target;
    const tick = () => {
      setBox((current) => {
        const next = measure(target);
        return sameBox(current, next) ? current : next;
      });
      if (began && step.tryIt && !done && step.tryIt.done(hostRef.current)) setDone(true);
    };
    tick();
    const timer = window.setInterval(tick, 120);
    window.addEventListener('resize', tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('resize', tick);
    };
  }, [step, done, began]);

  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    const watch = () => setCardHeight(element.offsetHeight);
    watch();
    const observer = new ResizeObserver(watch);
    observer.observe(element);
    return () => observer.disconnect();
  }, [step]);

  const leave = useCallback(
    (finished: boolean) => {
      step.tryIt?.after?.(hostRef.current);
      markTourSeen();
      onClose();
      if (finished && !hostRef.current.atHome) hostRef.current.goHome();
    },
    [step, onClose],
  );

  const next = useCallback(() => {
    step.tryIt?.after?.(hostRef.current);
    if (last) leave(true);
    else setIndex((current) => current + 1);
  }, [step, last, leave]);

  const back = useCallback(() => {
    step.tryIt?.after?.(hostRef.current);
    setIndex((current) => Math.max(0, current - 1));
  }, [step]);

  // A tried step moves on by itself, once its result has been seen.
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(next, 1400);
    return () => window.clearTimeout(timer);
  }, [done, next]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Enter on one of the card's buttons is that button's, not Home's.
      if (event.key === 'Enter' && target?.closest?.('.tour-card')) {
        event.stopPropagation();
        return;
      }
      // Something the step opened — the palette, a sheet — takes Esc first.
      if (document.querySelector('.palette, .sheet')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        leave(false);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        next();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        back();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [leave, next, back]);

  // The card: beside the ring where there is room — right, left, below, above — else in the middle.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(CARD_WIDTH, vw - EDGE * 2);
  const height = cardHeight || 240;
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));
  let where: { top: number; left: number; side: string };
  if (!box) {
    where = { top: (vh - height) / 2, left: (vw - width) / 2, side: 'middle' };
  } else if (box.left + box.width + GAP + width <= vw - EDGE) {
    where = { top: clamp(box.top + box.height / 2 - height / 2, EDGE, vh - height - EDGE), left: box.left + box.width + GAP, side: 'right' };
  } else if (box.left - GAP - width >= EDGE) {
    where = { top: clamp(box.top + box.height / 2 - height / 2, EDGE, vh - height - EDGE), left: box.left - GAP - width, side: 'left' };
  } else if (box.top + box.height + GAP + height <= vh - EDGE) {
    where = { top: box.top + box.height + GAP, left: clamp(box.left + box.width / 2 - width / 2, EDGE, vw - width - EDGE), side: 'below' };
  } else if (box.top - GAP - height >= EDGE) {
    where = { top: box.top - GAP - height, left: clamp(box.left + box.width / 2 - width / 2, EDGE, vw - width - EDGE), side: 'above' };
  } else {
    where = { top: (vh - height) / 2, left: (vw - width) / 2, side: 'middle' };
  }

  const tried = step.tryIt;
  const number = index + 1;
  return (
    <div className={`tour${box ? ' has-ring' : ''}`} data-step={step.id}>
      {/* The shade, in four pieces round the ring so what is inside it can be clicked. */}
      {box ? (
        <>
          <div className="tour-shade" style={{ top: 0, left: 0, right: 0, height: Math.max(0, box.top) }} />
          <div className="tour-shade" style={{ top: box.top + box.height, left: 0, right: 0, bottom: 0 }} />
          <div className="tour-shade" style={{ top: box.top, left: 0, width: Math.max(0, box.left), height: box.height }} />
          <div className="tour-shade" style={{ top: box.top, left: box.left + box.width, right: 0, height: box.height }} />
          <div className="tour-ring" style={{ top: box.top, left: box.left, width: box.width, height: box.height }} />
        </>
      ) : (
        <div className="tour-shade" style={{ top: 0, left: 0, right: 0, bottom: 0 }} />
      )}
      <div ref={card} className={`tour-card side-${where.side}${done ? ' is-done' : ''}`} style={{ top: where.top, left: where.left, width }} role="dialog" aria-label={`Tour, step ${number} of ${steps.length}: ${step.title}`}>
        <div className="tour-progress" aria-hidden="true">
          <span style={{ width: `${(number / steps.length) * 100}%` }} />
        </div>
        <div className="tour-head">
          <span className="tour-count">
            {number} / {steps.length}
          </span>
          <button type="button" className="icon-btn sm tour-close" onClick={() => leave(false)} aria-label="Leave the tour" title="Leave the tour (Esc)">
            <CloseIcon size={15} />
          </button>
        </div>
        <h3>{step.title}</h3>
        <div className="tour-body">{step.body}</div>
        {tried ? (
          <div className={`tour-try${done ? ' is-done' : ''}`} aria-live="polite">
            {done ? (
              <>
                <span className="tour-try-mark">✓</span> There it is — moving on
              </>
            ) : (
              <>
                <span className="tour-try-tag">Try it</span> {tried.prompt}
              </>
            )}
          </div>
        ) : step.place === 'any' && !host.hasPaper && index > 0 && !last ? (
          <p className="tour-note">You will be able to try this once a paper is in your library.</p>
        ) : null}
        <div className="tour-actions">
          {index === 0 ? (
            <button type="button" className="btn ghost sm" onClick={() => leave(false)}>
              Not now
            </button>
          ) : (
            <button type="button" className="btn ghost sm" onClick={() => leave(false)}>
              Skip tour
            </button>
          )}
          <span className="tour-gap" />
          {index > 0 ? (
            <button type="button" className="btn sm" onClick={back}>
              Back
            </button>
          ) : null}
          {last ? (
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                markTourSeen();
                onClose();
                startShowcase();
              }}
            >
              Show me, with a paper
            </button>
          ) : null}
          <button type="button" className="btn primary sm" onClick={next} autoFocus>
            {index === 0 ? 'Start the tour' : last ? 'Start reading' : tried && !done ? 'Skip this one' : 'Next'}
            {index > 0 && !last ? <kbd>→</kbd> : null}
          </button>
        </div>
      </div>
    </div>
  );
}
