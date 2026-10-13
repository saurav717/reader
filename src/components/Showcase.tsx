import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Cursor, Run, Stopped } from '../lib/cursor';
import { installReplay, SHOWCASE_PAPER } from '../lib/showcase';
import { MODELS, setModel } from '../lib/assistant';
import { explanationFor } from '../lib/explain';
import { colabAvailable, onColab, stopRuntime } from '../lib/colab';
import { useStore } from '../lib/store';
import { CloseIcon } from './icons';

/** What the showcase needs from the app. */
export interface ShowcaseHost {
  goHome: () => void;
  /** The paper open now, if one is. */
  reading: string | null;
  closeAssistant: () => void;
  closeExplain: () => void;
}

interface Scene {
  id: string;
  title: string;
  text: ReactNode;
  /** The model's and Colab's part is a replay, not a call: said on the card. */
  replay?: boolean;
  run: (c: Cursor, host: ShowcaseHost) => Promise<void>;
}

/** The scene could not go on: the card says why, and the showcase stops. */
class Halt extends Error {}

const K = ({ children }: { children: ReactNode }) => <kbd className="tour-key">{children}</kbd>;

const byText = (selector: string, pattern: RegExp, within: ParentNode = document) => Array.from(within.querySelectorAll<HTMLElement>(selector)).find((el) => pattern.test(el.textContent ?? ''));

const CLAUDE = MODELS.find((m) => m.provider === 'anthropic' && /sonnet/i.test(m.id)) ?? MODELS.find((m) => m.provider === 'anthropic') ?? MODELS[0];

/** A radio for Claude in a model picker, so every replayed page is written by the model the replay stands in for. */
const pickClaude = async (c: Cursor, within: Element | null) => {
  const radio = within ? byText('.model-pick [role="radio"]', /sonnet/i, within) ?? byText('.model-pick [role="radio"]', /claude/i, within) : null;
  if (radio && radio.getAttribute('aria-checked') !== 'true') await c.click(radio, 500);
};

const SCENES: Scene[] = [
  {
    id: 'find',
    title: 'Find the paper',
    text: (
      <>
        Every paper starts in the box on Home. We type the title — <i>Attention Is All You Need</i>, the paper behind the Transformer — and search the indexes at once.
      </>
    ),
    run: async (c, host) => {
      host.goHome();
      const box = await c.waitFor<HTMLInputElement>('.find-box input', 8000);
      if (!box) throw new Halt('Home’s search box did not come up.');
      await c.type(box, SHOWCASE_PAPER.query);
      const form = box.closest('form');
      await c.moveTo(byText('.find-box button', /search/i) ?? box);
      form?.requestSubmit();
      const open = await c.waitFor(() => byText('.find-list button.btn.sm', /^(Read|Open)$/, document)?.closest('[class*="find-row"], li, div')?.textContent?.match(SHOWCASE_PAPER.title) ? byText('.find-list button.btn.sm', /^(Read|Open)$/) : null, 25_000);
      if (!open) throw new Halt('The search did not find the paper — the indexes may be unreachable right now. Try the showcase again later.');
      await c.sleep(900);
    },
  },
  {
    id: 'open',
    title: 'Save it, and open it',
    text: <>Read saves the paper to your library — its PDF to your Drive, when you are signed in — and opens it. The file comes from arXiv through the reader’s proxy.</>,
    run: async (c) => {
      const open = byText('.find-list button.btn.sm', /^(Read|Open)$/);
      if (!open) throw new Halt('The result went away.');
      await c.click(open, 800);
      const head = await c.waitFor('.reader-head', 15_000);
      if (!head) throw new Halt('The paper did not open.');
      const modes = await c.waitFor(() => byText('.reader-head .segmented button', /^PDF$/), 40_000);
      if (!modes) throw new Halt('The PDF did not arrive — the proxy may be unreachable.');
      await c.sleep(1800);
    },
  },
  {
    id: 'modes',
    title: 'PDF, Reflow, book',
    text: (
      <>
        <b>PDF</b> is the paper as typeset. <b>Reflow</b> lays the same text out to be read and highlighted at any width; the book button puts two pages side by side.
      </>
    ),
    run: async (c) => {
      const reflow = byText('.reader-head .segmented button', /^Reflow$/);
      const pdf = byText('.reader-head .segmented button', /^PDF$/);
      if (reflow) await c.click(reflow, 2800);
      if (pdf) await c.click(pdf, 2400);
      const book = document.querySelector<HTMLElement>('.reader-head [aria-label^="Read as a book"]');
      if (book) {
        await c.click(book, 2600);
        const scroll = document.querySelector<HTMLElement>('.reader-head [aria-label^="Read as one scrolling"]');
        if (scroll) await c.click(scroll, 900);
      }
    },
  },
  {
    id: 'ask',
    title: 'Ask about it',
    text: (
      <>
        <K>⌘ \</K> opens Ask AI over the page. Ask where something is and the answer comes with passages: click one and the paper scrolls to it, marked.
      </>
    ),
    replay: true,
    run: async (c, host) => {
      setModel(CLAUDE.id);
      host.closeAssistant();
      await c.sleep(300);
      await c.press('\\', { ctrl: true }, 900);
      const box = await c.waitFor<HTMLTextAreaElement>('.assistant-win textarea', 8000);
      if (!box) throw new Halt('Ask AI did not open.');
      await c.type(box, 'Show me where they define scaled dot-product attention', 30);
      await c.press('Enter', { on: box }, 400);
      const passage = await c.waitFor('.assistant-win .chat-passage-row', 20_000);
      if (!passage) throw new Halt('The answer did not come.');
      await c.sleep(1400);
      await c.click(passage, 3600);
    },
  },
  {
    id: 'explain',
    title: 'Explain the whole paper',
    text: (
      <>
        <K>E</K> opens the Explanation page. Pick a model — Claude or DeepSeek — and it writes the paper up section by section, with figures, the maths worked and runnable code.
      </>
    ),
    replay: true,
    run: async (c, host) => {
      host.closeAssistant();
      await c.sleep(300);
      await c.press('e', {}, 900);
      const page = await c.waitFor(() => document.querySelector<HTMLElement>('.explain-start') ?? document.querySelector<HTMLElement>('.explain-section'), 10_000);
      if (!page) throw new Halt('The Explanation page did not open.');
      if (page.classList.contains('explain-start')) {
        await pickClaude(c, page);
        const cta = page.querySelector<HTMLElement>('.btn.primary.cta');
        if (!cta) throw new Halt('The Explain button is not there — a key is wanted first.');
        await c.click(cta, 600);
      }
      const written = await c.waitFor(() => (document.querySelectorAll('.explain-section').length >= 4 ? document.body : null), 40_000);
      if (!written) throw new Halt('The explanation did not come.');
      await c.sleep(3200);
    },
  },
  {
    id: 'implement',
    title: 'Plan an implementation',
    text: <>The Implementation tab plans the build for your machine: what to reproduce, the datasets, a repository layout, starter files, and what it costs on a T4.</>,
    replay: true,
    run: async (c) => {
      const tab = byText('.explain-pages [role="tab"]', /implement/i);
      if (!tab) throw new Halt('The Implementation tab is not there.');
      await c.click(tab, 900);
      const page = await c.waitFor(() => document.querySelector<HTMLElement>('.explain-start') ?? document.querySelector<HTMLElement>('.explain-section'), 10_000);
      if (page?.classList.contains('explain-start')) {
        await pickClaude(c, page);
        const cta = page.querySelector<HTMLElement>('.btn.primary.cta');
        if (cta) await c.click(cta, 600);
      }
      const written = await c.waitFor(() => (document.querySelectorAll('.explain-section').length >= 4 ? document.body : null), 40_000);
      if (!written) throw new Halt('The plan did not come.');
      await c.sleep(3200);
    },
  },
  {
    id: 'colab',
    title: 'Run it on Colab',
    text: (
      <>
        The Colab tab is a notebook of your own. The model writes its cells from the paper; <b>Run all</b> starts a runtime in your Google Colab — a T4 here — and the machine’s load is read live beside the cells.
      </>
    ),
    replay: true,
    run: async (c) => {
      const tab = document.querySelector<HTMLElement>('.explain-bar button[title^="Your notebook"]');
      if (!tab) throw new Halt('The Colab tab is not there.');
      await c.click(tab, 900);
      const page = await c.waitFor(() => document.querySelector<HTMLElement>('.nb-start') ?? document.querySelector<HTMLElement>('.nb-cell'), 10_000);
      if (!page) throw new Halt('The notebook did not open.');
      if (page.classList.contains('nb-start')) {
        await pickClaude(c, page);
        const cta = page.querySelector<HTMLElement>('.btn.primary.cta');
        if (!cta) throw new Halt('The notebook cannot be written without a key.');
        await c.click(cta, 600);
      }
      const cells = await c.waitFor(() => (document.querySelectorAll('.nb-cell').length >= 6 ? document.body : null), 30_000);
      if (!cells) throw new Halt('The notebook was not written.');
      await c.sleep(1200);
      const runAll = byText('button.btn.colab', /run all/i);
      if (!runAll || (runAll as HTMLButtonElement).disabled) throw new Halt('Running cells needs the reader’s proxy, which this copy has not got — the rest of the showcase goes on without it.');
      await c.click(runAll, 1200);
      const output = await c.waitFor('.nb-cell .cell-output', 40_000);
      if (!output) throw new Halt('The cells did not run.');
      await c.sleep(1500);
      // The machine, read live while the cells run: the pane beside them.
      const machine = document.querySelector<HTMLElement>('.explain-bar button[title^="The machine"]');
      if (machine && machine.getAttribute('aria-pressed') !== 'true') await c.click(machine, 600);
      await c.sleep(9000);
    },
  },
  {
    id: 'toggle',
    title: 'Paper and pages, a key apart',
    text: (
      <>
        <K>E</K> goes between the paper and its pages, both ways; what was written stays, in your library and your Drive. <K>Esc</K> leaves the showcase at any time.
      </>
    ),
    run: async (c) => {
      await c.press('e', {}, 1800);
      await c.press('e', {}, 1800);
      await c.press('e', {}, 1200);
    },
  },
];

/**
 * The showcase: the app used on a real paper, in front of the viewer — a
 * pointer of its own finds the paper, opens it, turns its pages, asks about
 * it, has it explained, planned and run — with the model and Colab replayed
 * from fixtures, so it costs nothing and needs no key. A card at the foot
 * says what is happening; → skips a scene, Esc leaves.
 */
export default function Showcase({ host, onClose }: { host: ShowcaseHost; onClose: () => void }) {
  const { settings } = useStore();
  const [index, setIndex] = useState(-1);
  const [note, setNote] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const hostRef = useRef(host);
  hostRef.current = host;
  const sceneRun = useRef<Run | null>(null);
  const whole = useRef(new Run());
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const run = whole.current;
    const cursor = new Cursor(run);
    const uninstall = installReplay();
    let cancelled = false;
    (async () => {
      for (let at = 0; at < SCENES.length; at++) {
        if (run.stopped) break;
        const scene = SCENES[at];
        if (scene.id === 'colab' && !colabAvailable(settings.googleClientId) && !hostRef.current.reading) continue;
        setIndex(at);
        setNote(null);
        const own = new Run();
        sceneRun.current = own;
        const sceneCursor = new Cursor(own);
        cursor.destroy();
        try {
          await scene.run(sceneCursor, hostRef.current);
        } catch (error) {
          if (error instanceof Halt) {
            setNote(error.message);
            await new Promise((resolve) => setTimeout(resolve, 3600));
            if (scene.id === 'find' || scene.id === 'open') break;
          } else if (!(error instanceof Stopped)) {
            setNote('Something went wrong in this scene; moving on.');
            await new Promise((resolve) => setTimeout(resolve, 2400));
          }
        } finally {
          sceneCursor.destroy();
        }
        if (run.stopped) break;
      }
      if (!cancelled) setDone(true);
    })();
    return () => {
      cancelled = true;
      run.stop();
      sceneRun.current?.stop();
      cursor.destroy();
      document.querySelectorAll('.sc-cursor, .sc-key').forEach((el) => el.remove());
      // The stand-in runtime is let go before the stand-in is: the stop goes to it, not to Colab.
      const letGo = onColab() ? stopRuntime().catch(() => undefined) : Promise.resolve();
      void letGo.finally(uninstall);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const leave = () => {
    whole.current.stop();
    sceneRun.current?.stop();
    hostRef.current.closeAssistant();
    closeRef.current();
  };
  const skip = () => sceneRun.current?.stop();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.isTrusted) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        leave();
      } else if (event.key === 'ArrowRight' && !done) {
        event.preventDefault();
        skip();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  const scene = index >= 0 ? SCENES[index] : null;
  const explained = hostRef.current.reading ? Boolean(explanationFor(hostRef.current.reading)) : false;
  return (
    <div className="showcase" data-scene={done ? 'done' : scene?.id ?? 'start'}>
      <div className="tour-card showcase-card" role="status" aria-live="polite">
        <div className="tour-progress" aria-hidden="true">
          <span style={{ width: `${((done ? SCENES.length : Math.max(index, 0)) / SCENES.length) * 100}%` }} />
        </div>
        <div className="tour-head">
          <span className="tour-count">{done ? 'Showcase' : scene ? `Scene ${index + 1} / ${SCENES.length}` : 'Showcase'}</span>
          <button type="button" className="icon-btn sm tour-close" onClick={leave} aria-label="Leave the showcase" title="Leave the showcase (Esc)">
            <CloseIcon size={15} />
          </button>
        </div>
        {done ? (
          <>
            <h3>That is a paper, read here</h3>
            <div className="tour-body">
              <p>
                Found, saved, read two ways, asked about, explained, planned and run — the explanation and the plan are kept with the paper{explained ? ', and are there now under E' : ''}. The model’s part was a replay; in your copy it runs on the model and the key you choose in Settings, and the notebook on your own Colab.
              </p>
            </div>
            <div className="tour-actions">
              <span className="tour-gap" />
              <button type="button" className="btn primary sm" onClick={leave} autoFocus>
                Start reading
              </button>
            </div>
          </>
        ) : scene ? (
          <>
            <h3>{scene.title}</h3>
            <div className="tour-body">
              <p>{scene.text}</p>
            </div>
            {note ? <p className="tour-note showcase-note">{note}</p> : scene.replay ? <p className="tour-note">Replayed — nothing is sent to a model or to Colab during the showcase.</p> : null}
            <div className="tour-actions">
              <button type="button" className="btn ghost sm" onClick={leave}>
                Stop
              </button>
              <span className="tour-gap" />
              <button type="button" className="btn sm" onClick={skip}>
                Skip scene <kbd>→</kbd>
              </button>
            </div>
          </>
        ) : (
          <>
            <h3>Show me, with a paper</h3>
            <div className="tour-body">
              <p>Watch the app used on a real paper. The pointer is the showcase’s; sit back, or press Esc to take over.</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
