// TensorBoard's scalars in the side pane: each tag a chart, every run under
// the project's folder a line in it, read again every few seconds while a
// run is writing (src/lib/tensorboard.ts). Runs can be hidden, tags filtered.

import { useEffect, useMemo, useState } from 'react';
import { readTensorBoard, tagsOf } from '../lib/tensorboard';
import type { TbRead } from '../lib/tensorboard';
import { LineChart } from './Charts';

export default function TensorBoardPane({ folder, connected, machineName, busy }: { folder: string; connected: boolean; machineName: string; busy: boolean }) {
  const [read, setRead] = useState<TbRead | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [round, setRound] = useState(0);
  const [at, setAt] = useState<number | null>(null);
  useEffect(() => {
    if (!connected) return;
    let live = true;
    let timer = 0;
    const look = async () => {
      try {
        const next = await readTensorBoard(folder);
        if (!live) return;
        setRead(next);
        setProblem(null);
        setAt(Date.now());
      } catch (error) {
        if (live) setProblem(error instanceof Error ? error.message : String(error));
      }
      // Every five seconds while a cell or command runs, every fifteen otherwise (a terminal's run counts as otherwise).
      if (live) timer = window.setTimeout(() => void look(), busy ? 5000 : 15000);
    };
    void look();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [folder, connected, busy, round]);

  const runs = read?.runs ?? [];
  const shown = runs.filter((run) => !hidden.has(run.name));
  const tags = useMemo(() => tagsOf(shown).filter((tag) => !filter || tag.toLowerCase().includes(filter.toLowerCase())), [shown, filter]);

  if (!connected) return <p className="pg-note pg-pad">Connect to {machineName}, and the TensorBoard logs your runs write are charted here.</p>;
  if (problem && !read) return <p className="pg-note is-problem pg-pad">{problem}</p>;
  if (!read)
    return (
      <p className="pg-note pg-pad">
        <span className="spinner" /> Reading TensorBoard’s logs on {machineName}…
      </p>
    );
  if (!runs.length) {
    return (
      <div className="tb-empty pg-pad">
        {read.note === 'no-tensorboard' ? (
          <p>There are TensorBoard logs in the folder, but TensorBoard isn’t installed on {machineName} to read them: run <code>pip install tensorboard</code> in the console.</p>
        ) : (
          <>
            <p>No TensorBoard logs in {folder} yet. Write some from your training loop, and they are charted here as they come:</p>
            <pre className="tb-snippet">{`from torch.utils.tensorboard import SummaryWriter
writer = SummaryWriter("runs/exp1")
writer.add_scalar("train/loss", loss.item(), step)`}</pre>
          </>
        )}
        <button type="button" className="btn sm" onClick={() => setRound((n) => n + 1)}>
          Look again
        </button>
      </div>
    );
  }
  return (
    <div className="tb-pane">
      <div className="tb-bar">
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter tags (loss, acc, lr…)" aria-label="Filter tags" spellCheck={false} />
        <button type="button" className="icon-btn sm" onClick={() => setRound((n) => n + 1)} title={at ? `Read ${new Date(at).toLocaleTimeString()} — read again` : 'Read again'} aria-label="Refresh">
          ↻
        </button>
      </div>
      <div className="tb-runs" role="group" aria-label="Runs">
        {runs.map((run) => (
          <label key={run.name} className="tb-run" title={`Last written ${new Date(run.updated).toLocaleString()}`}>
            <input
              type="checkbox"
              checked={!hidden.has(run.name)}
              onChange={() =>
                setHidden((now) => {
                  const next = new Set(now);
                  if (next.has(run.name)) next.delete(run.name);
                  else next.add(run.name);
                  return next;
                })
              }
            />
            <span className="mono">{run.name}</span>
            {Date.now() - run.updated < 60_000 ? <span className="tb-live">live</span> : null}
          </label>
        ))}
      </div>
      {tags.map((tag) => {
        const series = shown
          .filter((run) => run.scalars[tag]?.length)
          .slice(0, 6)
          .map((run) => ({ name: shown.length > 1 ? run.name : tag.split('/').pop() ?? tag, stepped: true, points: run.scalars[tag].map(([x, y]) => ({ x, y })) }));
        return series.length ? <LineChart key={tag} series={series} title={tag} xLabel="step" /> : null;
      })}
      {problem ? <p className="pg-note is-problem">{problem}</p> : null}
    </div>
  );
}
