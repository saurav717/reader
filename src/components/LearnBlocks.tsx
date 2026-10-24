// The Learn pages' own blocks (src/lib/learn.ts): the formal account folded
// under the plain prose, a picture found on Wikimedia Commons and captioned
// with its source, and the check at the end of a page. The first two are
// drawn by Explain's SectionView wherever a page has them; the check is drawn
// by the Learn page itself, after the sections.

import DOMPurify from 'dompurify';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { typesetMath } from '../lib/typesetMath';
import type { Block } from '../lib/explain';
import { markdown } from '../lib/markdown';
import { cleanFigure } from '../lib/sanitize';
import { typesetFigureMath } from '../lib/figureMath';
import { resolvePicture, sourceLabel } from '../lib/pictures';
import { getState } from '../lib/assistant';
import type { ResolvedPicture } from '../lib/pictures';
import { markAnswer, shuffled, verdictOf } from '../lib/learn';
import type { CheckAnswer, CheckQuestion, CheckResult } from '../lib/learn';

/** How much of a page is shown: the plain prose alone, with the formal blocks open, or with the code cells too. */
export type LearnLevel = 'plain' | 'formal' | 'code';
export const LEVELS: { id: LearnLevel; label: string; note: string }[] = [
  { id: 'plain', label: 'Plain', note: 'The pictures and the plain prose; the formal account and the code folded away' },
  { id: 'formal', label: 'Formal', note: 'The formal account open under each idea' },
  { id: 'code', label: 'With code', note: 'Everything, the code cells included' },
];

/** The level the page is read at, and the model that wrote it (which checks its pictures). */
export const LearnContext = createContext<{ level: LearnLevel; model?: string; /** The track's own papers, looked in for figures when nothing else shows it. */ papers?: { arxivId: string; title?: string }[]; /** A picture made for the page when none is found. */ generate?: boolean } | null>(null);

const html = (md: string) => DOMPurify.sanitize(markdown(md), { ADD_ATTR: ['target'] });

/** The exact statement of what the plain prose said, folded until the reader asks — or the Formal level opens every one. */
export function FormalBlock({ block }: { block: Extract<Block, { kind: 'formal' }> }) {
  const learn = useContext(LearnContext);
  const level = learn?.level ?? 'formal';
  const [open, setOpen] = useState(level !== 'plain');
  useEffect(() => setOpen(level !== 'plain'), [level]);
  // Its maths is set when it opens: the page's own pass ran before the body was there.
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) void typesetMath(body.current);
  }, [open, block.md]);
  return (
    <aside className={`learn-formal${open ? ' is-open' : ''}`}>
      <button type="button" className="formal-head" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? 'Fold the formal account away' : 'Open the formal account of this'}>
        <span className="formal-label">Formal</span>
        <span className="formal-title">{block.title || 'What this says exactly'}</span>
        <span className="formal-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? <div ref={body} className="formal-body explain-prose" dangerouslySetInnerHTML={{ __html: html(block.md) }} /> : null}
    </aside>
  );
}

/** A picture the page asked for: found (a paper's figure, Commons, the web), checked, and captioned with where it came from. */
export function ImageBlock({ block }: { block: Extract<Block, { kind: 'image' }> }) {
  const learn = useContext(LearnContext);
  const model = learn?.model;
  const papers = learn?.papers;
  const generate = learn?.generate;
  const [state, setState] = useState<{ resolved?: ResolvedPicture; error?: string; looking: boolean }>({ looking: true });
  const [fresh, setFresh] = useState(0);
  useEffect(() => {
    if (block.open || !(block.query || block.paper)) return;
    const controller = new AbortController();
    setState({ looking: true });
    resolvePicture({ query: block.query || block.must, must: block.must || block.query, model, paper: block.paper ? { arxivId: block.paper, figure: block.figure } : undefined, papers, generate, fresh: fresh > 0, variant: fresh, signal: controller.signal })
      .then((resolved) => setState({ resolved, looking: false }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ error: error instanceof Error ? error.message : String(error), looking: false });
      });
    return () => controller.abort();
  }, [block.open, block.query, block.must, block.paper, block.figure, model, papers, generate, fresh]);
  const picture = state.resolved?.picture;
  const resolved = state.resolved;
  return (
    <figure className={`explain-figure is-photo${picture ? '' : ' is-empty'}${picture?.kind === 'paper' ? ' is-paper' : ''}${picture?.kind === 'generated' ? ' is-generated' : ''}`}>
      <div className="photo-head">
        <span>{picture ? sourceLabel(picture) : 'A picture from the web'}</span>
        {!block.open && !state.looking ? (
          <button type="button" className="btn sm ghost" onClick={() => setFresh((n) => n + 1)} title="Search again — the paper named, Commons, the web, the track's papers — and check what is found afresh">
            Look again
          </button>
        ) : null}
      </div>
      {block.open ? (
        <div className="figure-art drawing">Asking for a picture…</div>
      ) : state.looking ? (
        <div className="figure-art drawing">
          <span className="spinner" /> Looking for “{block.query || block.figure}”{block.paper ? ` in arXiv:${block.paper}, then` : ''} on Commons and the web{generate !== false ? ', else making one' : ''}{model ? ', and checking what turns up' : ''}…
        </div>
      ) : picture ? (
        <a className={`figure-art photo-art${picture.kind === 'paper' ? ' paper-art' : ''}`} href={picture.page || picture.src} target="_blank" rel="noreferrer noopener" title={picture.kind === 'paper' ? 'Open the paper on arXiv' : picture.kind === 'commons' ? 'Open its page on Wikimedia Commons' : 'Open the page it was found on'}>
          <img src={picture.src} alt={block.caption || picture.title} loading="lazy" />
          <span className="photo-query">{picture.kind === 'paper' ? `${picture.ref ?? 'figure'} of ${picture.source}` : picture.kind === 'generated' ? 'AI-generated illustration' : `image: search “${block.query}”`}</span>
        </a>
      ) : (
        <div className="figure-art drawing paper-missing">{state.error ? `No picture yet — ${state.error}. Look again in a moment.` : resolved?.note || `Nothing found shows “${block.must || block.query}” clearly enough to put here.`}</div>
      )}
      {block.caption ? <figcaption>{block.caption}</figcaption> : null}
      {block.md ? <div className="paper-figure-note" dangerouslySetInnerHTML={{ __html: html(block.md) }} /> : null}
      {picture ? (
        <div className="photo-source">
          {picture.kind === 'commons' ? (
            <>
              “{picture.title}”, by {picture.author} ·{' '}
              <a href={picture.page} target="_blank" rel="noreferrer noopener">
                Wikimedia Commons
              </a>{' '}
              ·{' '}
              {picture.licenceUrl ? (
                <a href={picture.licenceUrl} target="_blank" rel="noreferrer noopener">
                  {picture.licence}
                </a>
              ) : (
                picture.licence
              )}
            </>
          ) : picture.kind === 'generated' ? (
            <>
              <b>Generated illustration</b>, not a photograph — made by{' '}
              <a href={picture.page} target="_blank" rel="noreferrer noopener">
                {picture.source}
              </a>{' '}
              from “{picture.title}”. A generator can get details wrong; take it as a sketch of what the page describes.
            </>
          ) : picture.kind === 'paper' ? (
            <>
              {picture.ref ?? 'A figure'} of {picture.paper?.title ? <i>{picture.paper.title}</i> : 'the paper'} ·{' '}
              <a href={picture.page} target="_blank" rel="noreferrer noopener">
                {picture.source}
              </a>{' '}
              · pulled from the paper’s PDF{picture.description ? ` · “${picture.description.slice(0, 140)}${picture.description.length > 140 ? '…' : ''}”` : ''}
            </>
          ) : (
            <>
              {picture.title ? `“${picture.title}” · ` : ''}from{' '}
              <a href={picture.page || picture.src} target="_blank" rel="noreferrer noopener">
                {picture.source || 'the web'}
              </a>{' '}
              · found by {picture.via || 'image search'} · licence not known: see the page before reusing it
            </>
          )}
        </div>
      ) : null}
      {picture && resolved ? (
        <div className={`photo-verify is-${resolved.verdict}`}>
          <i aria-hidden="true">{resolved.verdict === 'checked' ? '✓' : '?'}</i>
          {resolved.verdict === 'checked'
            ? `Checked by the model: ${resolved.note || 'it shows what the page asked for.'}${resolved.rejected ? ` ${resolved.rejected} other${resolved.rejected === 1 ? '' : 's'} passed over${resolved.tried.length > 1 ? ` (${resolved.tried.join(', ')})` : ''}.` : ''}`
            : resolved.note || 'Not checked: the first match for the search, as found. Look again with a model that can see to have it checked.'}
        </div>
      ) : null}
    </figure>
  );
}

/** A picture made for the page from the model's own prompt: generated, checked when the model can see, captioned as generated. */
export function IllustrationBlock({ block }: { block: Extract<Block, { kind: 'illustration' }> }) {
  const learn = useContext(LearnContext);
  // On a Learn page the page's writer checks it; on an Explain page, the model Explain writes with.
  const model = learn?.model ?? getState().prefs.explainModel ?? getState().prefs.model;
  const off = learn?.generate === false;
  const [state, setState] = useState<{ resolved?: ResolvedPicture; error?: string; looking: boolean }>({ looking: true });
  const [again, setAgain] = useState(0);
  useEffect(() => {
    if (block.open || !block.prompt || off) return;
    const controller = new AbortController();
    setState({ looking: true });
    resolvePicture({ query: block.prompt, must: block.prompt, model, only: 'generated', fresh: again > 0, variant: again, signal: controller.signal })
      .then((resolved) => setState({ resolved, looking: false }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ error: error instanceof Error ? error.message : String(error), looking: false });
      });
    return () => controller.abort();
  }, [block.open, block.prompt, model, off, again]);
  const resolved = state.resolved;
  const picture = resolved?.picture;
  return (
    <figure className={`explain-figure is-photo is-generated${picture ? '' : ' is-empty'}`}>
      <div className="photo-head">
        <span>Made for this page{picture ? ` · ${picture.source}` : ''}</span>
        {!block.open && !state.looking && !off ? (
          <button type="button" className="btn sm ghost" onClick={() => setAgain((n) => n + 1)} title="Make another one from the same prompt">
            Another
          </button>
        ) : null}
      </div>
      {block.open ? (
        <div className="figure-art drawing">Asking for an illustration…</div>
      ) : off ? (
        <div className="figure-art drawing paper-missing">Generated pictures are off for this track.</div>
      ) : state.looking ? (
        <div className="figure-art drawing">
          <span className="spinner" /> Making a picture of “{block.prompt.slice(0, 80)}{block.prompt.length > 80 ? '…' : ''}”{model ? ', then checking it' : ''}…
        </div>
      ) : picture ? (
        <a className="figure-art photo-art" href={picture.page} target="_blank" rel="noreferrer noopener" title="About the generator">
          <img src={picture.src} alt={block.caption || block.prompt} loading="lazy" />
          <span className="photo-query">AI-generated illustration</span>
        </a>
      ) : (
        <div className="figure-art drawing paper-missing">{state.error ? `No picture yet — ${state.error}. Try Another in a moment.` : resolved?.note || 'The generator made nothing that shows this clearly; try Another.'}</div>
      )}
      {block.caption ? <figcaption>{block.caption}</figcaption> : null}
      {block.md ? <div className="paper-figure-note" dangerouslySetInnerHTML={{ __html: html(block.md) }} /> : null}
      {picture ? (
        <div className="photo-source">
          <b>Generated illustration</b>, not a photograph — made by{' '}
          <a href={picture.page} target="_blank" rel="noreferrer noopener">
            {picture.source}
          </a>{' '}
          from “{block.prompt}”. A generator can get details wrong; take it as a sketch of the idea.
        </div>
      ) : null}
      {picture && resolved ? (
        <div className={`photo-verify is-${resolved.verdict}`}>
          <i aria-hidden="true">{resolved.verdict === 'checked' ? '✓' : '?'}</i>
          {resolved.verdict === 'checked' ? `Checked by the model: ${resolved.note || 'it shows what was asked for.'}` : 'Not checked: shown as the generator made it. With a proxy configured, the model checks it first.'}
        </div>
      ) : null}
    </figure>
  );
}

// ---------------------------------------------------------------------------
// The check at the end of a page
// ---------------------------------------------------------------------------

function OptionArt({ svg }: { svg: string }) {
  const art = useMemo(() => typesetFigureMath(cleanFigure(svg)), [svg]);
  return <span className="figure-art check-art" dangerouslySetInnerHTML={{ __html: art }} />;
}

/**
 * Three questions, mostly pictures. Answered, they are marked here (learn.ts),
 * and what was missed is what the next page opens by mending.
 */
export function CheckView({
  questions,
  result,
  nodeId,
  nextTitle,
  onSubmit,
  onRetry,
  onContinue,
  onReread,
  onConfident,
}: {
  questions: CheckQuestion[];
  result?: CheckResult;
  nodeId: string;
  nextTitle?: string;
  onSubmit: (answers: CheckAnswer[]) => void;
  onRetry: () => void;
  onContinue?: () => void;
  onReread: () => void;
  onConfident: () => void;
}) {
  const [answers, setAnswers] = useState<CheckAnswer[]>(() => result?.answers ?? questions.map((q) => (q.kind === 'order' ? shuffled(q.steps.map((_, i) => i), `${nodeId}:${q.q}`) : null)));
  useEffect(() => {
    if (result?.answers) setAnswers(result.answers);
  }, [result]);
  const answered = answers.every((answer, i) => (questions[i].kind === 'order' ? Array.isArray(answer) : questions[i].kind === 'fill' ? typeof answer === 'string' && answer.trim() : typeof answer === 'number'));
  const marked = result ? questions.map((q, i) => markAnswer(q, answers[i] ?? null)) : null;
  const verdict = result ? verdictOf(result) : null;
  const set = (i: number, answer: CheckAnswer) => setAnswers((all) => all.map((a, j) => (j === i ? answer : a)));
  const move = (i: number, from: number, to: number) => {
    const order = answers[i];
    if (!Array.isArray(order) || to < 0 || to >= order.length) return;
    const next = order.slice();
    [next[from], next[to]] = [next[to], next[from]];
    set(i, next);
  };
  return (
    <section className="learn-check" id="learn-check" data-title="Check yourself">
      <header className="explain-section-head">
        <span className="section-number">✓</span>
        <h2>Check yourself</h2>
      </header>
      <p className="check-lead">Three questions, mostly pictures. Not a test: the answers decide how the next page is written.</p>
      {questions.map((question, i) => {
        const mark = marked?.[i];
        const stateClass = mark === undefined ? '' : mark >= 1 ? ' is-right' : mark > 0 ? ' is-near' : ' is-wrong';
        return (
          <div key={i} className={`check-q${stateClass}`}>
            <div className="check-n">
              {i + 1} of {questions.length} · {question.kind === 'pick' ? 'pick one' : question.kind === 'order' ? 'put the steps in order' : 'finish the sentence'}
            </div>
            {question.kind === 'fill' && question.q.includes('___') ? null : <div className="check-title">{question.q}</div>}
            {question.kind === 'pick' ? (
              <div className="check-opts">
                {question.options.map((option, k) => (
                  <button key={k} type="button" className={`check-opt${answers[i] === k ? ' is-pick' : ''}${result && k === question.answer ? ' is-answer' : ''}`} disabled={Boolean(result)} onClick={() => set(i, k)} aria-pressed={answers[i] === k}>
                    {option.svg ? <OptionArt svg={option.svg} /> : null}
                    <span className="check-opt-text">
                      <span className="k">{String.fromCharCode(65 + k)}</span>
                      {option.text}
                    </span>
                  </button>
                ))}
              </div>
            ) : question.kind === 'order' ? (
              <ol className="check-order">
                {(Array.isArray(answers[i]) ? (answers[i] as number[]) : []).map((stepIndex, position) => (
                  <li key={stepIndex} className={result ? (stepIndex === position ? 'is-right' : 'is-wrong') : ''}>
                    <i>{position + 1}</i>
                    <span>{question.steps[stepIndex]}</span>
                    {!result ? (
                      <span className="check-move">
                        <button type="button" aria-label="Move up" disabled={position === 0} onClick={() => move(i, position, position - 1)}>
                          ▲
                        </button>
                        <button type="button" aria-label="Move down" disabled={position === question.steps.length - 1} onClick={() => move(i, position, position + 1)}>
                          ▼
                        </button>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : (
              <div className="check-fill">
                {question.q.includes('___') ? (
                  question.q.split('___').map((part, k, parts) => (
                    <span key={k}>
                      {part}
                      {k < parts.length - 1 ? <input type="text" value={typeof answers[i] === 'string' ? (answers[i] as string) : ''} disabled={Boolean(result)} placeholder="…" onChange={(event) => set(i, event.target.value)} /> : null}
                    </span>
                  ))
                ) : (
                  <input type="text" value={typeof answers[i] === 'string' ? (answers[i] as string) : ''} disabled={Boolean(result)} placeholder="Your answer, in a few words" onChange={(event) => set(i, event.target.value)} />
                )}
              </div>
            )}
            {result ? (
              <div className="check-why">
                {mark !== undefined && mark >= 1 ? 'Right. ' : mark ? 'Nearly. ' : 'Not quite. '}
                {question.kind === 'fill' && mark !== undefined && mark < 1 ? `The page said: ${question.answer}. ` : ''}
                {question.why}
              </div>
            ) : null}
          </div>
        );
      })}
      {!result ? (
        <div className="check-actions">
          <button type="button" className="btn primary" disabled={!answered} onClick={() => onSubmit(answers)}>
            Mark it
          </button>
          <button type="button" className="btn ghost" onClick={onConfident} title="Skip the check and mark this page as one you are confident about">
            I’m confident, skip the check
          </button>
        </div>
      ) : (
        <div className="check-verdict">
          <div className="check-verdict-main">
            <h3>{verdict!.title}</h3>
            <p>
              {verdict!.confident
                ? 'Every question answered as the page taught it. This page is marked confident on the map.'
                : result.missed.length
                  ? `What did not stick: ${result.missed.join(' ')} The next page will open with a short bridge on exactly that, before its own idea starts.`
                  : 'Close enough to carry on; the next page will pick up what was missed.'}
            </p>
            <div className="check-actions">
              {onContinue ? (
                <button type="button" className="btn primary" onClick={onContinue}>
                  Continue{nextTitle ? ` to ${nextTitle}` : ''} →
                </button>
              ) : null}
              <button type="button" className="btn" onClick={onReread}>
                Reread at the Formal level
              </button>
              {!verdict!.confident ? (
                <>
                  <button type="button" className="btn" onClick={onRetry}>
                    Try the check again
                  </button>
                  <button type="button" className="btn ghost" onClick={onConfident}>
                    I’m confident, mark it done
                  </button>
                </>
              ) : null}
            </div>
          </div>
          <aside className="check-changes">
            <b>What this changes</b>
            <ul>
              <li>
                This page → <b>{verdict!.confident ? 'confident' : 'read'}</b>
                {verdict!.confident ? '' : ', not yet confident'}
              </li>
              {result.missed.length && nextTitle ? <li>{nextTitle} opens with a bridge</li> : null}
              <li>Its terms are in the glossary for the pages after it</li>
            </ul>
          </aside>
        </div>
      )}
    </section>
  );
}
