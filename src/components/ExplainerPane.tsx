// The playground's Explain page (the tab beside Notebook and Files), laid out as a paper's explanation is: an illustrated account of the project —
// the code, what the agents and the person did, what the runs show — written
// by the model picked for explanations (src/lib/projectExplainer.ts), drawn
// with its diagrams, charts from the runs' numbers, and the project's own
// images and videos. Kept in the project's folder; written again on request.

import DOMPurify from 'dompurify';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { explainError, getState as assistantState, modelSpec, PROVIDERS, sdk, setAskModel, setExplainModel, streamModel, subscribe as subscribeAssistant } from '../lib/assistant';
import { markdown } from '../lib/markdown';
import type { FileHost } from '../lib/playground';
import { cleanFigure } from '../lib/sanitize';
import { lengthSeries, mimeOf, readMedia, returnSeries, successSeries } from '../lib/simTelemetry';
import type { RunListing, SimRun } from '../lib/simTelemetry';
import { askMessage, consoleChartSeries, EXPLAINER_ASK, EXPLAINER_SYSTEM, explainerMessage, readAskReply, gatherInputs, listRuns, loadExplainer, loadRun, parseExplainer, runChartSeries, saveExplainer } from '../lib/projectExplainer';
import type { ExplainerBlock, ExplainerMeta, RunPlace } from '../lib/projectExplainer';
import { LineChart } from './Charts';
import ModelChip, { shortModelName } from './ModelChip';
import FileIcon from './FileIcon';
import { ExplainIcon, SparkleIcon } from './icons';

/** One explainer being written per project, kept across the pane being closed and opened. */
const writing = new Map<string, { text: string; step: string; abort: () => void; request?: string }>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

/** Blob URLs of the project's images and videos, by project and path. */
const mediaUrls = new Map<string, string>();

export default function ExplainerPane({
  title,
  projectId,
  host,
  where,
  place,
  consoleLines,
  metricTexts,
  onOpen,
}: {
  /** The project's name: the page's title. */
  title: string;
  projectId: string;
  /** The project's own folder. */
  host: FileHost;
  /** Where the files are and where they run, in words. */
  where: string;
  place: RunPlace;
  /** The commands run in the console, newest last. */
  consoleLines: string[];
  /** What the console's commands printed, each with its label: for the charts of the numbers they print. */
  metricTexts: { label: string; text: string }[];
  onOpen: (path: string) => void;
}) {
  const assistant = useSyncExternalStore(subscribeAssistant, assistantState);
  const model = assistant.prefs.explainModel ?? assistant.prefs.model;
  const ready = Boolean(assistant.keys[modelSpec(model).provider]);
  const writer = PROVIDERS[modelSpec(model).provider].name;
  const live = useSyncExternalStore(subscribe, () => writing.get(projectId));
  const [saved, setSaved] = useState<{ text: string; meta: ExplainerMeta } | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunListing[]>([]);
  // The ask bar: what is typed, the section it is about, the answer to a question, and the page before the last change (for Undo).
  const askModel = assistant.prefs.askModel ?? model;
  const askReady = Boolean(assistant.keys[modelSpec(askModel).provider]);
  const asker = PROVIDERS[modelSpec(askModel).provider].name;
  const [ask, setAsk] = useState('');
  const [askSection, setAskSection] = useState<string | null>(null);
  const [askFocused, setAskFocused] = useState(false);
  const [answer, setAnswer] = useState<{ request: string; note: string; changed: boolean } | null>(null);
  const [before, setBefore] = useState<{ text: string; meta: ExplainerMeta } | null>(null);
  const askRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let on = true;
    setSaved(undefined);
    void loadExplainer(host)
      .then((found) => on && setSaved(found))
      .catch(() => on && setSaved(null));
    return () => {
      on = false;
    };
  }, [host, live === undefined]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void listRuns(place).then(setRuns).catch(() => undefined);
  }, [place.machineFolder, place.kept]); // eslint-disable-line react-hooks/exhaustive-deps

  const write = async () => {
    if (writing.has(projectId) || !ready) return;
    setProblem(null);
    let aborted = false;
    let stop: () => void = () => {
      aborted = true;
    };
    const state = { text: '', step: 'Reading the project', abort: () => stop() };
    writing.set(projectId, state);
    notify();
    const step = (text: string) => {
      state.step = text;
      writing.set(projectId, { ...state });
      notify();
    };
    let SDK = null;
    try {
      if (modelSpec(model).provider === 'anthropic') SDK = await sdk();
      const inputs = await gatherInputs({ projectId, host, where, place, console: consoleLines, metricTexts: metricTexts.map((m) => m.text), onStep: step });
      if (aborted) throw new Error('Stopped.');
      step('Writing');
      const stream = await streamModel({
        model,
        maxTokens: 32_000,
        system: [{ type: 'text', text: EXPLAINER_SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: explainerMessage(inputs, Boolean(saved)) }],
        effort: 'medium',
      });
      stop = () => stream.abort();
      let frame = 0;
      stream.on('text', (delta: string) => {
        state.text += delta;
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          writing.set(projectId, { ...state });
          notify();
        });
      });
      const final = await stream.finalMessage();
      if (frame) cancelAnimationFrame(frame);
      if (final.stop_reason === 'refusal') throw new Error(`${writer} declined to write it.`);
      const meta: ExplainerMeta = { at: Date.now(), model, files: inputs.listing.length, runs: inputs.runs.map((r) => r.dir), agentTurns: inputs.agents ? inputs.agents.split('\n\nAsked').length : 0 };
      const text = final.stop_reason === 'max_tokens' ? `${state.text}\n\n*(It ran out of room here: write it again for the rest.)*` : state.text;
      await saveExplainer(host, text, meta).catch((error: unknown) => setProblem(`It isn’t saved in the project’s folder: ${error instanceof Error ? error.message : String(error)}`));
      setSaved({ text, meta });
    } catch (error) {
      const message = explainError(error, SDK);
      if (message !== 'Stopped.') setProblem(message);
    } finally {
      writing.delete(projectId);
      notify();
    }
  };

  /** A question about the page, or a change to it: answered under the bar, or the page written again (Undo puts it back). */
  const submit = async (request = ask) => {
    const asked = request.trim();
    const current = saved?.text;
    if (!asked || !current || writing.has(projectId) || !askReady) return;
    setAsk('');
    setAnswer(null);
    setProblem(null);
    let stop: () => void = () => undefined;
    const state = { text: '', step: 'Reading your request', abort: () => stop(), request: asked };
    writing.set(projectId, state);
    notify();
    const show = (patch: Partial<typeof state>) => {
      Object.assign(state, patch);
      writing.set(projectId, { ...state });
      notify();
    };
    let SDK = null;
    let reply = '';
    try {
      if (modelSpec(askModel).provider === 'anthropic') SDK = await sdk();
      const inputs = await gatherInputs({ projectId, host, where, place, console: consoleLines, metricTexts: metricTexts.map((m) => m.text), onStep: (step) => show({ step }) });
      show({ step: 'Thinking', text: current });
      const stream = await streamModel({
        model: askModel,
        maxTokens: 32_000,
        system: [
          { type: 'text', text: EXPLAINER_SYSTEM, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: EXPLAINER_ASK },
        ],
        messages: [{ role: 'user', content: askMessage(inputs, current, asked, askSection ?? undefined) }],
        effort: 'medium',
      });
      stop = () => stream.abort();
      let frame = 0;
      stream.on('text', (delta: string) => {
        reply += delta;
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          const read = readAskReply(reply);
          // A change: the page as it is written again, from the top. A question: the page stays as it is.
          show(read.page !== null ? { step: 'Rewriting the page', text: read.page } : { step: read.note ? 'Answering' : 'Thinking' });
        });
      });
      const final = await stream.finalMessage();
      if (frame) cancelAnimationFrame(frame);
      if (final.stop_reason === 'refusal') throw new Error(`${asker} declined that request.`);
      const read = readAskReply(reply);
      if (read.page !== null && read.pageDone && read.page.trim()) {
        const meta: ExplainerMeta = { ...(saved?.meta ?? { files: 0, runs: [], agentTurns: 0 }), at: Date.now(), model: askModel };
        setBefore(saved ?? null);
        await saveExplainer(host, read.page, meta).catch((error: unknown) => setProblem(`The change isn’t saved in the project’s folder: ${error instanceof Error ? error.message : String(error)}`));
        setSaved({ text: read.page, meta });
        setAnswer({ request: asked, note: read.note || 'Done.', changed: true });
      } else {
        if (read.page !== null) throw new Error(`${asker} ran out of room before the end of the page: ask for a smaller change.`);
        setAnswer({ request: asked, note: read.note || reply.trim(), changed: false });
      }
      setAskSection(null);
    } catch (error) {
      const message = explainError(error, SDK);
      if (message !== 'Stopped.') setProblem(message);
    } finally {
      writing.delete(projectId);
      notify();
    }
  };
  const undo = async () => {
    if (!before) return;
    await saveExplainer(host, before.text, before.meta).catch(() => undefined);
    setSaved(before);
    setBefore(null);
    setAnswer(null);
  };
  const askAbout = (section: string) => {
    setAskSection(section);
    askRef.current?.focus();
  };
  const asking = Boolean(live?.request);
  const suggestions = askSection
    ? ['Explain this more simply', 'Go deeper', 'Add a diagram for this', 'Show the code for this', 'Add a chart from the runs', 'Is anything here wrong or out of date?']
    : ['Make it simpler, for a newcomer', 'Add a diagram of how the data flows', 'Add a section on how to run it', 'Chart every run’s returns', 'What should I try next, and why?', 'Shorter: just the essentials'];

  const text = live?.text ?? saved?.text ?? '';
  const sections = useMemo(() => sectionsOf(text), [text]);
  const newRuns = saved ? runs.filter((r) => !saved.meta.runs.includes(r.dir)).length : 0;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(null);
  // The outline follows the reading: the section whose head was last passed.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const onScroll = () => {
      const heads = [...scroller.querySelectorAll<HTMLElement>('[data-section]')];
      const top = scroller.getBoundingClientRect().top + 80;
      const passed = heads.filter((head) => head.getBoundingClientRect().top <= top).pop() ?? heads[0];
      setActive(passed?.dataset.section ?? null);
    };
    onScroll();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [sections.length]);
  const writtenBy = saved?.meta.model ? shortModelName(modelSpec(saved.meta.model).label) : writer;
  const startButton = (
    <div className="pg-explainer-start">
      <ModelChip value={model} keys={assistant.keys} disabled={Boolean(live)} what="Written by" align="left" view="list" onChange={(id) => setExplainModel(id)} />
      <button type="button" className="btn primary" disabled={!ready} onClick={() => void write()} title={ready ? undefined : `${writer} needs its key in Settings → AI`}>
        <ExplainIcon size={15} /> Explain this project
      </button>
    </div>
  );

  return (
    <div className="pg-explainer">
      <header className="explain-bar">
        <span className="explain-brand">
          <ExplainIcon size={17} /> <span>{asking ? `${asker} is answering` : live ? `${writer} is writing` : saved ? `Explained by ${writtenBy}` : 'Explain this project'}</span>
        </span>
        <span className="explain-bar-title">
          {live
            ? `${live.step}…`
            : saved
              ? `Written ${saved.meta.at ? new Date(saved.meta.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}${newRuns ? ` · ${newRuns} new run${newRuns === 1 ? '' : 's'} since` : ''} · kept in the project’s folder`
              : 'The code, what was done with it, and what the runs show'}
        </span>
        {saved || live ? <ModelChip value={model} keys={assistant.keys} disabled={Boolean(live)} what="Written by" align="right" view="list" onChange={(id) => setExplainModel(id)} /> : null}
        {live ? (
          <button type="button" className="btn sm" onClick={() => live.abort()}>
            ■ Stop
          </button>
        ) : saved ? (
          <button type="button" className="btn sm" disabled={!ready} onClick={() => void write()} title={ready ? 'Write it again, with what has changed since' : `${writer} needs its key in Settings → AI`}>
            Write again
          </button>
        ) : null}
      </header>
      {saved || asking ? (
        <div className="explain-ask pg-explainer-ask">
          <div className="ask-column">
            <form
              className={`ask-field${asking ? ' is-busy' : ''}${askFocused ? ' is-focused' : ''}${!askReady || Boolean(live && !asking) ? ' is-off' : ''}`}
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <SparkleIcon size={16} />
              {askSection ? (
                <span className="ask-chip" title={`About the section “${askSection}”`}>
                  § {askSection}
                  <button type="button" aria-label="Not about this section" onClick={() => setAskSection(null)}>
                    ×
                  </button>
                </span>
              ) : null}
              <input
                ref={askRef}
                value={ask}
                disabled={Boolean(live)}
                onChange={(event) => setAsk(event.target.value)}
                onFocus={() => setAskFocused(true)}
                onBlur={() => window.setTimeout(() => setAskFocused(false), 150)}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') return;
                  if (askSection) setAskSection(null);
                  else event.currentTarget.blur();
                }}
                placeholder={
                  !askReady
                    ? `${asker} needs its key in Settings → AI — or pick another model here`
                    : askSection
                      ? 'Ask about this section, or say how to change it…'
                      : `Ask ${asker} anything about this page or the project — or how to change the page: simpler, deeper, a new diagram, a new section…`
                }
                aria-label="Ask about the explanation, or ask for a change"
              />
              <ModelChip value={askModel} writer={saved?.meta.model} keys={assistant.keys} disabled={Boolean(live)} what="Answers here with" onChange={(id) => setAskModel(id)} />
              {asking ? (
                <button type="button" className="btn sm" onClick={() => live?.abort()}>
                  Stop
                </button>
              ) : (
                <button type="submit" className="btn sm primary" disabled={!askReady || !ask.trim() || Boolean(live)}>
                  Ask
                </button>
              )}
            </form>
            {asking && live ? (
              <div className="ask-status is-live">
                <span className="spinner" />
                <span className="ask-note">
                  {live.step} — <em>{live.request}</em>
                </span>
              </div>
            ) : askFocused && !ask && askReady && !live ? (
              <div className="ask-suggestions">
                {suggestions.map((suggestion) => (
                  <button key={suggestion} type="button" className="ask-suggestion" onMouseDown={(event) => event.preventDefault()} onClick={() => void submit(suggestion)}>
                    {suggestion}
                  </button>
                ))}
              </div>
            ) : answer ? (
              <div className={`ask-status ${answer.changed ? 'is-done' : 'is-answer'}`}>
                {answer.changed ? <span className="check">✓</span> : <SparkleIcon size={14} />}
                <span className="ask-note">
                  {answer.changed ? (
                    answer.note
                  ) : (
                    <>
                      <em>{answer.request}</em>
                      <span className="explain-prose pgx-answer" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(markdown(answer.note)) }} />
                    </>
                  )}
                </span>
                {answer.changed && before ? (
                  <button type="button" className="btn sm ghost" onClick={() => void undo()} title={`Put the page back as it was before “${answer.request}”`}>
                    Undo
                  </button>
                ) : (
                  <button type="button" className="btn sm ghost" onClick={() => setAnswer(null)}>
                    Dismiss
                  </button>
                )}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="explain-split">
        <div className="explain-scroll" ref={scrollRef}>
          <nav className="explain-outline" aria-label="Sections">
            <div className="outline-paper">
              <div className="outline-title">{title}</div>
              <div className="outline-byline">{where}</div>
            </div>
            {sections.filter((section) => section.title).length ? (
              <ol>
                {sections
                  .filter((section) => section.title)
                  .map((section, index) => (
                    <li key={section.id} className={active === section.id ? 'active' : ''}>
                      <a
                        href={`#pgx-${section.id}`}
                        onClick={(event) => {
                          event.preventDefault();
                          document.getElementById(`pgx-${section.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }}
                      >
                        <span className="n">{String(index + 1).padStart(2, '0')}</span>
                        <span className="t">{section.title}</span>
                      </a>
                    </li>
                  ))}
              </ol>
            ) : null}
            {saved && !live ? <div className="outline-meta">Written by {writtenBy}{saved.meta.at ? ` · ${new Date(saved.meta.at).toLocaleDateString()}` : ''}</div> : null}
          </nav>
          <article className="explain-doc">
            {problem ? <p className="explain-error">{problem}</p> : null}
            {saved === undefined && !live ? (
              <p className="explain-looking">
                <span className="spinner" /> Opening the explanation from the project’s folder…
              </p>
            ) : !text && !live ? (
              <div className="explain-empty">
                <div className="explain-kicker pill">
                  <ExplainIcon size={15} /> The whole project, explained
                </div>
                <h1>{title}</h1>
                <div className="byline">{where}</div>
                <p className="explain-lede">
                  {writer} reads the project <b>end to end</b> — the code, <mark>what you and the agents asked for and built</mark>, the commands run and <mark>what the simulation runs show</mark> — and writes you a walkthrough to read instead of the code.
                </p>
                <ul className="explain-promises">
                  <li className="p-figures">
                    <span className="promise-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
                        <path d="M7 15l3.2-3.6 2.6 2.4L17 9" />
                      </svg>
                    </span>
                    <b>Diagrams</b>
                    <span>of how the code fits together and how the method works</span>
                  </li>
                  <li className="p-code">
                    <span className="promise-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 19V5M4 19h16M7 15l4-5 3 3 5-7" />
                      </svg>
                    </span>
                    <b>Charts and videos</b>
                    <span>from the runs’ own numbers and recordings</span>
                  </li>
                  <li className="p-caveats">
                    <span className="promise-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="8" />
                        <path d="M12 8v4l3 2" />
                      </svg>
                    </span>
                    <b>What was done</b>
                    <span>the requests, the changes, what works and what to try next</span>
                  </li>
                </ul>
                {startButton}
                <p className="pg-note">It is kept in the project’s folder (<code>.reader/explainer.md</code>), so it opens again anywhere, and it can be written again whenever the project has moved on.</p>
              </div>
            ) : (
              <>
                <header className="explain-title">
                  <div className="explain-kicker">
                    <ExplainIcon size={16} /> {live ? `${writer} is explaining` : `Explained by ${writtenBy}`}
                  </div>
                  <h1>{title}</h1>
                  <div className="byline">{where}</div>
                </header>
                {sections.map((section, index) => (
                  <section key={section.id} className="explain-section" id={`pgx-${section.id}`} data-section={section.id}>
                    {section.title ? (
                      <header className="explain-section-head">
                        <span className="section-number">{String(index + (sections[0]?.title ? 1 : 0)).padStart(2, '0')}</span>
                        <h2>{section.title}</h2>
                        {saved && !live ? (
                          <button type="button" className="btn sm ghost ask" onClick={() => askAbout(section.title)} title="Ask about this section, or ask for it to change">
                            <SparkleIcon size={13} /> Ask
                          </button>
                        ) : null}
                      </header>
                    ) : null}
                    {section.blocks.map((block, i) => (
                      <Block key={i} block={block} place={place} host={host} runs={runs} projectId={projectId} metricTexts={metricTexts} onOpen={onOpen} streaming={Boolean(live)} />
                    ))}
                  </section>
                ))}
                {live && !asking ? (
                  <p className="explain-writing">
                    <span className="spinner" /> <span>{live.text ? `${writer} is writing${sections.length ? ` — ${sections[sections.length - 1].title || 'the opening'}` : ''}…` : `${live.step}… a big project can take a minute or two before the first words.`}</span>
                  </p>
                ) : null}
              </>
            )}
          </article>
        </div>
      </div>
    </div>
  );
}

/** The account cut at its ## headings, each section's blocks parsed. */
function sectionsOf(text: string): { id: string; title: string; blocks: ExplainerBlock[] }[] {
  const out: { id: string; title: string; body: string }[] = [];
  let current = { id: 'opening', title: '', body: '' };
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) inFence = !inFence;
    const head = !inFence ? line.match(/^##\s+(.+?)\s*#*\s*$/) : null;
    if (head) {
      if (current.title || current.body.trim()) out.push(current);
      current = { id: `s${out.length + 1}`, title: head[1].replace(/^\d+[.)]\s*/, ''), body: '' };
    } else if (!/^#\s/.test(line) || inFence) {
      current.body += `${line}\n`;
    }
  }
  if (current.title || current.body.trim()) out.push(current);
  return out.map((section) => ({ id: section.id, title: section.title, blocks: parseExplainer(section.body) }));
}

function Block({ block, place, host, runs, projectId, metricTexts, onOpen, streaming }: { block: ExplainerBlock; place: RunPlace; host: FileHost; runs: RunListing[]; projectId: string; metricTexts: { label: string; text: string }[]; onOpen: (path: string) => void; streaming: boolean }) {
  if (block.kind === 'text') return <div className="explain-prose" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(markdown(block.text)) }} />;
  if (block.kind === 'figure') {
    return (
      <figure className="explain-figure pgx-block">
        <div className="figure-art" dangerouslySetInnerHTML={{ __html: cleanFigure(block.svg) }} />
        {block.caption ? <figcaption>{block.caption}</figcaption> : null}
      </figure>
    );
  }
  if (block.kind === 'code') {
    return (
      <figure className="explainer-code">
        {block.file ? (
          <button type="button" className="link explainer-file" onClick={() => onOpen(block.file!)}>
            <FileIcon path={block.file} /> {block.file}
          </button>
        ) : null}
        <pre>
          <code>{block.text}</code>
        </pre>
      </figure>
    );
  }
  if (block.kind === 'chart') return streaming ? <p className="pg-note">A chart: {block.title}</p> : <ChartBlock block={block} place={place} runs={runs} metricTexts={metricTexts} />;
  return streaming ? <p className="pg-note">{block.caption || block.path}</p> : <MediaBlock path={block.path} caption={block.caption} place={place} host={host} runs={runs} projectId={projectId} />;
}

/** Runs read once per pane, by dir. */
const runCache = new Map<string, Promise<SimRun | null>>();

function ChartBlock({ block, place, runs, metricTexts }: { block: Extract<ExplainerBlock, { kind: 'chart' }>; place: RunPlace; runs: RunListing[]; metricTexts: { label: string; text: string }[] }) {
  const [run, setRun] = useState<SimRun | null | undefined>(block.run ? undefined : null);
  useEffect(() => {
    if (!block.run) return;
    const dir = block.run.replace(/^\.?\/+|\/+$/g, '');
    const key = `${place.machineFolder}|${place.kept?.label}|${dir}`;
    if (!runCache.has(key)) runCache.set(key, loadRun(place, dir, runs.find((r) => r.dir === dir)).catch(() => null));
    let on = true;
    void runCache.get(key)!.then((found) => on && setRun(found));
    return () => {
      on = false;
    };
  }, [block.run, place.machineFolder, place.kept, runs.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const series = useMemo(() => (block.run ? (run ? runChartSeries(run, block.metric, { returns: returnSeries, success: successSeries, length: lengthSeries }) : []) : consoleChartSeries(metricTexts, block.metric)), [run, block.metric, block.run, metricTexts]);
  if (block.run && run === undefined) {
    return (
      <p className="pg-note explainer-chart-wait">
        <span className="spinner" /> {block.title}
      </p>
    );
  }
  if (!series.length) return <p className="pg-note">{block.title}: {block.run ? `no ${block.metric} in ${block.run} where it can be read now` : `the console hasn’t printed ${block.metric} in this tab`}.</p>;
  return (
    <figure className="explainer-chart">
      <LineChart series={series} title={block.title} xLabel={block.run ? (run?.xLabel ?? 'step') : 'step'} yLabel={block.metric} />
    </figure>
  );
}

function MediaBlock({ path, caption, place, host, runs, projectId }: { path: string; caption: string; place: RunPlace; host: FileHost; runs: RunListing[]; projectId: string }) {
  const clean = path.replace(/^\.?\/+/, '');
  const key = `${projectId}|${clean}`;
  const [url, setUrl] = useState<string | null>(mediaUrls.get(key) ?? null);
  const [problem, setProblem] = useState<string | null>(null);
  const tried = useRef('');
  useEffect(() => {
    if (url || tried.current === key) return;
    tried.current = key;
    void (async () => {
      try {
        // A run's own file: from the machine, or the project's folder for a run kept there (readMedia knows which).
        const run = runs.find((r) => clean.startsWith(`${r.dir}/`));
        let blob: Blob | null = null;
        if (run && place.machineFolder !== null) blob = await readMedia(place.machineFolder, run.dir, clean.slice(run.dir.length + 1)).catch(() => null);
        if (!blob && host.readBase64) {
          const data = await host.readBase64(clean);
          if (data !== null) blob = new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))] as BlobPart[], { type: mimeOf(clean) });
        }
        if (!blob && place.machineFolder !== null) blob = await readMedia(place.machineFolder, '', clean);
        if (!blob) throw new Error(`${clean} can’t be read from here now.`);
        const made = URL.createObjectURL(blob);
        mediaUrls.set(key, made);
        setUrl(made);
      } catch (error) {
        setProblem(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [key, url, runs.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const video = /\.(mp4|webm)$/i.test(clean);
  return (
    <figure className="explainer-media">
      {url ? video ? <video src={url} controls loop muted playsInline /> : <img src={url} alt={caption || clean} /> : problem ? <p className="pg-note">{problem}</p> : <p className="pg-note"><span className="spinner" /> {clean}</p>}
      <figcaption>
        {caption} <code>{clean}</code>
      </figcaption>
    </figure>
  );
}
