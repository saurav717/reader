// The peek beside a paper (Settings → Running playgrounds, E): reading a
// paper that a playground cites — or one picked with ⌘↵ in P's switcher —
// its cells are at the side of the page, live: what each printed, the one
// running now, Run on any cell and Stop. They run in the playground's own
// kernel, on its own machine (colab.ts runCellFor), without leaving the paper
// or bringing the playground to the foreground. Open goes to the playground.

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { CellRun, Output } from '../lib/colab';
import { colabNow, outputText, runCellFor, subscribeColab } from '../lib/colab';
import type { NbCell } from '../lib/notebook';
import { cellStatus, loadNotebook, notebookFor, runKey, subscribeNotebook } from '../lib/notebook';
import { backendOfPlayground, blankCells, loadPlaygrounds, notebookKey, takeSeed, usePlaygrounds } from '../lib/playground';
import { isLive, peekPlayground, stopPlayground, usePeeked, useRunBoard } from '../lib/playgroundRuns';
import { RunPill } from './PlaygroundRuns';
import { ChevronRightIcon, CloseIcon, CodeIcon } from './icons';

const FOLD_KEY = 'reader.playground.peek-folded';
const readFold = () => {
  try {
    return localStorage.getItem(FOLD_KEY) === '1';
  } catch {
    return false;
  }
};

/** The last lines of what a cell printed, and its pictures. */
function Printed({ outputs }: { outputs: Output[] }) {
  const text = outputText(outputs.filter((output) => output.type !== 'image')).split('\n');
  const shown = text.slice(-12).join('\n').trimEnd();
  const images = outputs.filter((output): output is Extract<Output, { type: 'image' }> => output.type === 'image').slice(-2);
  const failed = outputs.some((output) => output.type === 'error');
  if (!shown && !images.length) return null;
  return (
    <div className={`pk-out${failed ? ' is-error' : ''}`}>
      {shown ? <pre>{text.length > 12 ? `…\n${shown}` : shown}</pre> : null}
      {images.map((image, i) => (
        <img key={i} src={`data:${image.mime};base64,${image.data}`} alt="" />
      ))}
    </div>
  );
}

function PeekCell({ cell, index, run, onRun, busy }: { cell: NbCell; index: number; run?: CellRun; onRun: () => void; busy: boolean }) {
  const status = cellStatus(cell, run);
  const outputs = run?.outputs ?? cell.outputs;
  const live = status === 'running' || status === 'queued';
  const lines = cell.source.split('\n');
  return (
    <div className={`pk-cell is-${status ?? 'text'}`}>
      <div className="pk-cell-head">
        <span className="pk-n">[{index + 1}]</span>
        <span className="pk-state">{live ? (status === 'queued' ? 'queued' : 'running') : status === 'failed' ? 'failed' : status === 'ran' ? 'ran' : status === 'stopped' ? 'stopped' : status === 'changed' ? 'changed since it ran' : ''}</span>
        <span className="spacer" />
        <button type="button" className="link" disabled={busy || !cell.source.trim()} onClick={onRun} title="Runs this cell in the playground's own kernel, on its machine">
          Run
        </button>
      </div>
      <pre className="pk-src">{lines.slice(0, 8).join('\n')}{lines.length > 8 ? '\n…' : ''}</pre>
      <Printed outputs={outputs} />
    </div>
  );
}

/** On a paper's page: the peek, when Settings has it on or one was picked with ⌘↵ — and a playground to show. */
export default function PlaygroundPeek({ paperId, enabled, onOpen }: { paperId: string; /** Settings has the peek on: else only one picked with ⌘↵ shows. */ enabled: boolean; onOpen: (id: string) => void }) {
  const picked = usePeeked();
  if (!enabled && !picked) return null;
  return <Peek paperId={paperId} picked={picked} onOpen={onOpen} />;
}

function Peek({ paperId, picked, onOpen }: { paperId: string; picked: string | null; onOpen: (id: string) => void }) {
  useEffect(() => {
    void loadPlaygrounds();
  }, []);
  const list = usePlaygrounds();
  const board = useRunBoard(list);
  const citing = useMemo(() => list.filter((p) => p.cites.some((cite) => cite.paperId === paperId)), [list, paperId]);
  // The one picked; else of those citing the paper, one running, else the one changed last.
  const choices = picked && !citing.some((p) => p.id === picked) ? [...list.filter((p) => p.id === picked), ...citing] : citing;
  const ranked = [...choices].sort((a, b) => Number(isLive(board.find((r) => r.id === b.id) ?? { phase: 'never' })) - Number(isLive(board.find((r) => r.id === a.id) ?? { phase: 'never' })) || b.updated - a.updated);
  const [chosen, setChosen] = useState<string | null>(null);
  const p = (picked ? list.find((x) => x.id === picked) : undefined) ?? ranked.find((x) => x.id === chosen) ?? ranked[0];
  const [folded, setFolded] = useState(readFold);
  const fold = (next: boolean) => {
    setFolded(next);
    try {
      localStorage.setItem(FOLD_KEY, next ? '1' : '0');
    } catch {
      // Only a convenience.
    }
  };
  const key = p ? notebookKey(p.id) : '';
  useEffect(() => {
    if (!p) return;
    void loadNotebook(key, p.title, () => takeSeed(p.id) ?? blankCells(p.title));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const nb = useSyncExternalStore(subscribeNotebook, () => (key ? notebookFor(key) : undefined));
  const colab = useSyncExternalStore(subscribeColab, colabNow);
  const [problem, setProblem] = useState<string | null>(null);
  if (!p) return null;
  const run = board.find((r) => r.id === p.id);
  const backend = backendOfPlayground(p);
  const live = run ? isLive(run) : false;
  const code = (nb?.cells ?? []).map((cell, index) => ({ cell, index })).filter(({ cell }) => cell.type === 'code' && cell.source.trim());
  const runOne = (cell: NbCell) => {
    if (!backend) return setProblem('Its machine isn’t in your list here: open the playground to choose one.');
    setProblem(null);
    void runCellFor(backend, p.id, runKey(cell.id), cell.source).catch((error) => setProblem(error instanceof Error ? error.message : String(error)));
  };
  if (folded) {
    return (
      <button type="button" className="pk-pill" onClick={() => fold(false)} title={`Show ${p.title} beside the paper`}>
        <CodeIcon size={14} />
        <span>{p.title}</span>
        {run ? <RunPill run={run} /> : null}
      </button>
    );
  }
  return (
    <aside className="pk" aria-label={`${p.title}, beside the paper`}>
      <header className="pk-head">
        <div className="pk-title">
          <span className="eyebrow">Beside the paper</span>
          {ranked.length > 1 && !picked ? (
            <select value={p.id} onChange={(event) => setChosen(event.target.value)} aria-label="Which playground">
              {ranked.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.title}
                </option>
              ))}
            </select>
          ) : (
            <b title={p.title}>{p.title}</b>
          )}
        </div>
        <button type="button" className="icon-btn sm" aria-label="Fold the peek" title="Fold" onClick={() => fold(true)}>
          <ChevronRightIcon size={15} />
        </button>
        {picked ? (
          <button type="button" className="icon-btn sm" aria-label="Close the peek" title="Close" onClick={() => peekPlayground(null)}>
            <CloseIcon size={14} />
          </button>
        ) : null}
      </header>
      <div className="pk-bar">
        {run ? <RunPill run={run} /> : null}
        <span className="pk-where">{run?.where}</span>
        <span className="spacer" />
        {live ? (
          <button type="button" className="btn sm pr-stop" onClick={() => void stopPlayground(p.id)}>
            Stop
          </button>
        ) : null}
        <button type="button" className="btn sm primary" onClick={() => onOpen(p.id)}>
          Open
        </button>
      </div>
      {problem ? <p className="pk-problem">{problem}</p> : null}
      <div className="pk-cells">
        {code.length ? (
          code.map(({ cell }, i) => <PeekCell key={cell.id} cell={cell} index={i} run={colab.runs[runKey(cell.id)]} busy={Boolean(run && isLive(run) && run.session)} onRun={() => runOne(cell)} />)
        ) : (
          <p className="pk-empty">No code cells yet — Open writes them.</p>
        )}
      </div>
    </aside>
  );
}
