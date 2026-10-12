// A LaTeX project in Drive compared with its Overleaf project, as GitHub
// compares two branches: on the left every file, changed, the same, or on one
// side only; on the right the chosen file's lines side by side with their
// changes, or the two PDFs with what changed on each page. Each file ends up
// as picked — this site's version in total, Overleaf's in total, or change by
// change — and that is then the version in both places: written into Drive,
// and pushed to Overleaf on top of the commit compared with.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { apiFetch } from '../lib/api';
import { isTextFile, latexLinkAt, latexOwner, latexSeparate, overleafGitUrl, withLatexLink } from '../lib/overleaf';
import { compareWithOverleaf, settleWithOverleaf, type Compared, type Comparison } from '../lib/overleafCloud';
import { subStore, type PaperStore } from '../lib/paperStore';
import { diffPdfs, type PdfDiff, type PdfDiffPage } from '../lib/pdfDiff';
import { diffLines, hunksOf, mergeLines, type HunkPick, type LineRow } from '../lib/textDiff';
import type { Project } from '../lib/projects';
import OverleafAccounts from './OverleafAccounts';

/** How a file ends up: one side in total, or change by change. */
type Decision = { whole: 'mine' | 'theirs' } | { hunks: HunkPick[] };

const decode = (base64?: string) => (base64 === undefined ? '' : new TextDecoder().decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))));
const encode = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
};
const isText = (path: string) => isTextFile(path) || /\.(txt|md|csv|json|tsv)$/i.test(path);

/** Files on one side only start kept (nothing anybody wrote is lost by default); changed ones wait to be picked, as a conflict does. */
const firstDecision = (file: Compared): Decision | undefined => (file.status === 'here' ? { whole: 'mine' } : file.status === 'overleaf' ? { whole: 'theirs' } : undefined);

/** The file as it is to end up: base64, or null for gone. */
function finalOf(file: Compared, decision: Decision, rows?: LineRow[]): string | null {
  if ('whole' in decision) return (decision.whole === 'mine' ? file.mine : file.theirs) ?? null;
  return encode(mergeLines(rows ?? diffLines(decode(file.mine), decode(file.theirs)), decision.hunks));
}

const SIDE = { mine: 'This site', theirs: 'Overleaf' } as const;

export default function CompareOverleaf({ project, store, dir, onClose }: { project: Project; store: PaperStore; dir: string; onClose: () => void }) {
  const { updateCollection } = useStore();
  const link = project.project.overleaf;
  // What syncs as one with that Overleaf project: the folder whose link it is, less the other LaTeX projects in it.
  const owner = latexOwner(link, dir);
  const own = useMemo(() => subStore(store, owner), [store, owner]);
  const exclude = useMemo(() => latexSeparate(link, owner), [link, owner]);
  const target = latexLinkAt(link, owner);
  const gitUrl = overleafGitUrl(target.url);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [chosen, setChosen] = useState<string | null>(null);
  const [view, setView] = useState<'code' | 'pdf'>('code');
  const [showSame, setShowSame] = useState(false);
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!gitUrl) return;
    let live = true;
    setComparison(null);
    setProblem(null);
    setNeedToken(false);
    void compareWithOverleaf(own, gitUrl, { account: target.gitAccount, exclude }).then(
      (found) => {
        if (!live) return;
        setComparison(found);
        setDecisions(Object.fromEntries(found.files.flatMap((file) => (firstDecision(file) ? [[file.path, firstDecision(file)!]] : []))));
        setChosen(found.files.find((file) => file.status !== 'same')?.path ?? found.files[0]?.path ?? null);
      },
      (error) => {
        if (!live) return;
        setProblem(error instanceof Error ? error.message : String(error));
        setNeedToken(Boolean((error as { needToken?: boolean }).needToken));
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [own, gitUrl, round]);

  const differing = comparison?.files.filter((file) => file.status !== 'same') ?? [];
  const undecided = differing.filter((file) => !decisions[file.path]);
  const file = comparison?.files.find((item) => item.path === chosen) ?? null;
  const allTo = (side: 'mine' | 'theirs') => setDecisions(Object.fromEntries(differing.map((item) => [item.path, { whole: side }])));

  const apply = async () => {
    if (!comparison || !gitUrl || undecided.length) return;
    setApplying(true);
    setProblem(null);
    try {
      const finals: Record<string, string | null> = {};
      for (const item of differing) finals[item.path] = finalOf(item, decisions[item.path]);
      const synced = await settleWithOverleaf(own, gitUrl, comparison, finals, { account: target.gitAccount, exclude });
      if (synced.account && synced.account !== target.gitAccount)
        void updateCollection(project.id, (collection) => {
          const info = { ...project.project, ...(collection.project ?? {}) };
          return info.overleaf ? { project: { ...info, overleaf: withLatexLink(info.overleaf, owner, { gitAccount: synced.account }) } } : {};
        });
      if (!synced.ok) throw new Error(synced.error ?? 'Overleaf didn’t take the settled version.');
      setDone(`${differing.length} file${differing.length === 1 ? '' : 's'} settled: this site and Overleaf now have the same version${synced.pushed ? ', pushed to Overleaf' : ''}.`);
      setRound((n) => n + 1);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setApplying(false);
    }
  };

  const head = (
    <header className="wc-head">
      <button type="button" className="wr-home-back wc-back" onClick={onClose}>
        ← Back to the LaTeX projects
      </button>
      <div className="wc-title">
        <span className="eyebrow">Compare with Overleaf</span>
        <h2>{owner ? `${owner}/` : 'The top of the folder'}</h2>
      </div>
      {comparison ? (
        <div className="wc-actions">
          <span className="wr-quiet">
            {differing.length ? `${differing.length} file${differing.length === 1 ? '' : 's'} differ${differing.length === 1 ? 's' : ''}${undecided.length ? ` · ${undecided.length} to pick` : ''}` : 'Nothing differs'}
          </span>
          {differing.length ? (
            <>
              <button type="button" className="btn sm" onClick={() => allTo('mine')} title="Every file as it is on this site: Overleaf gets this site’s version">
                Keep all of this site’s
              </button>
              <button type="button" className="btn sm" onClick={() => allTo('theirs')} title="Every file as it is on Overleaf: this site gets Overleaf’s version">
                Take all of Overleaf’s
              </button>
              <button type="button" className="btn sm primary" disabled={applying || Boolean(undecided.length)} onClick={() => void apply()} title={undecided.length ? 'Pick a version for every changed file first' : 'Write the picked versions here and push them to Overleaf'}>
                {applying ? 'Settling…' : 'Apply to both'}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </header>
  );

  if (!gitUrl)
    return (
      <div className="wc">
        {head}
        <p className="wr-quiet wc-pad">This LaTeX project isn’t on Overleaf, so there is nothing to compare it with.</p>
      </div>
    );

  return (
    <div className="wc">
      {head}
      {done ? <p className="wc-done wc-pad">{done}</p> : null}
      {problem ? (
        <div className="wc-pad">
          <p className="wr-bad">{problem}</p>
          {needToken ? <OverleafAccounts open projectUrl={target.url} accountLabel={target.account} onConnected={() => setRound((n) => n + 1)} /> : null}
        </div>
      ) : null}
      {!comparison && !problem ? <p className="wr-quiet wc-pad">Asking Overleaf for its files, and reading this site’s…</p> : null}
      {comparison ? (
        <div className="wc-body">
          <aside className="wc-files" aria-label="The files, compared">
            {(['changed', 'here', 'overleaf'] as const).map((status) => {
              const list = comparison.files.filter((item) => item.status === status);
              if (!list.length) return null;
              return (
                <section key={status}>
                  <h4>{status === 'changed' ? 'Changed on both' : status === 'here' ? 'Only on this site' : 'Only on Overleaf'}</h4>
                  {list.map((item) => (
                    <FileRow key={item.path} file={item} decision={decisions[item.path]} on={item.path === chosen} onClick={() => setChosen(item.path)} />
                  ))}
                </section>
              );
            })}
            <section>
              <button type="button" className="wc-same-toggle" aria-expanded={showSame} onClick={() => setShowSame(!showSame)}>
                {showSame ? '▾' : '▸'} The same on both · {comparison.files.filter((item) => item.status === 'same').length}
              </button>
              {showSame ? comparison.files.filter((item) => item.status === 'same').map((item) => <FileRow key={item.path} file={item} on={item.path === chosen} onClick={() => setChosen(item.path)} />) : null}
            </section>
          </aside>
          <main className="wc-main">
            <div className="wc-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={view === 'code'} className={view === 'code' ? 'is-on' : ''} onClick={() => setView('code')}>
                Files
              </button>
              <button type="button" role="tab" aria-selected={view === 'pdf'} className={view === 'pdf' ? 'is-on' : ''} onClick={() => setView('pdf')}>
                PDFs
              </button>
            </div>
            {view === 'code' ? (
              file ? (
                <FileCompare key={file.path} file={file} decision={decisions[file.path]} onDecide={(decision) => setDecisions((now) => ({ ...now, [file.path]: decision }))} />
              ) : (
                <p className="wr-quiet wc-pad">No files.</p>
              )
            ) : (
              <PdfCompare comparison={comparison} decisions={decisions} main={target.main || 'main.tex'} compiler={target.compiler ?? 'pdflatex'} />
            )}
          </main>
        </div>
      ) : null}
    </div>
  );
}

function FileRow({ file, decision, on, onClick }: { file: Compared; decision?: Decision; on: boolean; onClick: () => void }) {
  const said = !decision ? 'pick' : 'hunks' in decision ? 'picked across' : file.status === 'changed' ? SIDE[decision.whole] : file.status === 'here' ? (decision.whole === 'mine' ? 'kept' : 'deleted') : decision.whole === 'theirs' ? 'kept' : 'deleted';
  return (
    <button type="button" className={`wc-file is-${file.status}${on ? ' is-on' : ''}${file.status !== 'same' && !decision ? ' is-open' : ''}`} onClick={onClick} title={file.path}>
      <span className="wc-file-mark" aria-hidden="true">
        {file.status === 'changed' ? 'M' : file.status === 'here' ? 'S' : file.status === 'overleaf' ? 'O' : '='}
      </span>
      <span className="wc-file-name mono">{file.path}</span>
      {file.status !== 'same' ? <small className={`wc-file-pick${decision ? '' : ' is-open'}`}>{said}</small> : null}
    </button>
  );
}

const CONTEXT = 3;

/** One file's two versions: side by side, line by line, each change kept from one side or the other, or both. */
function FileCompare({ file, decision, onDecide }: { file: Compared; decision?: Decision; onDecide: (decision: Decision) => void }) {
  const text = isText(file.path);
  const rows = useMemo(() => (text ? diffLines(decode(file.mine), decode(file.theirs)) : []), [file, text]);
  const hunks = useMemo(() => hunksOf(rows), [rows]);
  const [allLines, setAllLines] = useState(false);
  const picks: HunkPick[] = decision && 'hunks' in decision ? decision.hunks : hunks.map(() => (decision && 'whole' in decision ? decision.whole : 'mine'));
  const pickHunk = (n: number, pick: HunkPick) => onDecide({ hunks: hunks.map((_, at) => (at === n ? pick : picks[at])) });
  const whole = (side: 'mine' | 'theirs') => onDecide({ whole: side });
  const wholeIs = (side: 'mine' | 'theirs') => Boolean(decision && 'whole' in decision && decision.whole === side);

  const choices =
    file.status === 'same' ? (
      <p className="wr-quiet">The same on this site and on Overleaf.</p>
    ) : file.status === 'changed' ? (
      <div className="wc-choose">
        <button type="button" className={`btn sm${wholeIs('mine') ? ' primary' : ''}`} onClick={() => whole('mine')}>
          Use this site’s version
        </button>
        <button type="button" className={`btn sm${wholeIs('theirs') ? ' primary' : ''}`} onClick={() => whole('theirs')}>
          Use Overleaf’s version
        </button>
        {text && hunks.length ? <span className="wr-quiet">{decision && 'hunks' in decision ? 'Picked change by change, below.' : 'Or pick change by change, below.'}</span> : null}
      </div>
    ) : (
      <div className="wc-choose">
        <button type="button" className={`btn sm${wholeIs(file.status === 'here' ? 'mine' : 'theirs') ? ' primary' : ''}`} onClick={() => whole(file.status === 'here' ? 'mine' : 'theirs')}>
          Keep it on both
        </button>
        <button type="button" className={`btn sm${wholeIs(file.status === 'here' ? 'theirs' : 'mine') ? ' primary' : ''}`} onClick={() => whole(file.status === 'here' ? 'theirs' : 'mine')}>
          Delete it from {file.status === 'here' ? 'this site' : 'Overleaf'}
        </button>
      </div>
    );

  if (!text)
    return (
      <div className="wc-file-view">
        <div className="wc-file-head">
          <b className="mono">{file.path}</b>
          {choices}
        </div>
        <p className="wr-quiet wc-pad">
          Not a text file: this site’s is {file.mine ? `${Math.round((file.mine.length * 3) / 4 / 1024)} KB` : 'not there'}, Overleaf’s {file.theirs ? `${Math.round((file.theirs.length * 3) / 4 / 1024)} KB` : 'not there'}.
        </p>
      </div>
    );

  // Each row shown, or folded into "n lines the same" away from the changes.
  const near = new Set<number>();
  for (const hunk of hunks) for (let i = Math.max(0, hunk.from - CONTEXT); i <= Math.min(rows.length - 1, hunk.to + CONTEXT); i += 1) near.add(i);
  const body: React.ReactNode[] = [];
  let folded = 0;
  const fold = (key: string) => {
    if (!folded) return;
    body.push(
      <tr key={key} className="wc-fold">
        <td colSpan={4}>
          <button type="button" className="link-btn" onClick={() => setAllLines(true)}>
            ⋯ {folded} line{folded === 1 ? '' : 's'} the same
          </button>
        </td>
      </tr>,
    );
    folded = 0;
  };
  let hunkAt = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const hunk = hunks[hunkAt];
    if (hunk && i === hunk.from) {
      fold(`f${i}`);
      const n = hunkAt;
      const pick = picks[n];
      body.push(
        <tr key={`h${n}`} className="wc-hunk-bar">
          <td colSpan={4}>
            <span className="wr-quiet">Change {n + 1} of {hunks.length}</span>
            {(['mine', 'theirs', 'both'] as const).map((side) => (
              <button key={side} type="button" className={`wc-pick${file.status === 'changed' && pick === side && decision ? ' is-on' : ''}`} onClick={() => pickHunk(n, side)}>
                {side === 'mine' ? 'Keep this site’s' : side === 'theirs' ? 'Take Overleaf’s' : 'Keep both'}
              </button>
            ))}
          </td>
        </tr>,
      );
      // Side by side: this site's lines on the left, Overleaf's on the right, paired in order.
      const left = rows.slice(hunk.from, hunk.to + 1).filter((row) => row.kind === 'removed');
      const right = rows.slice(hunk.from, hunk.to + 1).filter((row) => row.kind === 'added');
      for (let k = 0; k < Math.max(left.length, right.length); k += 1) {
        const l = left[k];
        const r = right[k];
        const keptL = pick !== 'theirs';
        const keptR = pick !== 'mine';
        body.push(
          <tr key={`h${n}-${k}`} className="wc-row is-change">
            <td className="wc-num">{l?.a ?? ''}</td>
            <td className={`wc-code${l ? ` is-mine${keptL ? '' : ' is-dropped'}` : ' is-blank'}`}>{l?.text ?? ''}</td>
            <td className="wc-num">{r?.b ?? ''}</td>
            <td className={`wc-code${r ? ` is-theirs${keptR ? '' : ' is-dropped'}` : ' is-blank'}`}>{r?.text ?? ''}</td>
          </tr>,
        );
      }
      i = hunk.to;
      hunkAt += 1;
      continue;
    }
    if (!allLines && !near.has(i)) {
      folded += 1;
      continue;
    }
    const row = rows[i];
    body.push(
      <tr key={`s${i}`} className="wc-row">
        <td className="wc-num">{row.a}</td>
        <td className="wc-code">{row.text}</td>
        <td className="wc-num">{row.b}</td>
        <td className="wc-code">{row.text}</td>
      </tr>,
    );
  }
  fold('end');

  return (
    <div className="wc-file-view">
      <div className="wc-file-head">
        <b className="mono">{file.path}</b>
        {choices}
      </div>
      <div className="wc-table-wrap">
        <table className="wc-table">
          <colgroup>
            <col className="wc-col-num" />
            <col />
            <col className="wc-col-num" />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th colSpan={2}>This site{file.mine === undefined ? ' · not there' : ''}</th>
              <th colSpan={2}>Overleaf{file.theirs === undefined ? ' · not there' : ''}</th>
            </tr>
          </thead>
          <tbody>{body}</tbody>
        </table>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- PDFs --

type Version = 'mine' | 'theirs' | 'result';
const VERSION_LABEL: Record<Version, string> = { mine: 'This site', theirs: 'Overleaf', result: 'The result, as picked' };

/** A version's files, compiled on Cloud Run as one paper: its PDF. */
async function compileVersion(files: { path: string; base64: string }[], main: string, compiler: string): Promise<Blob> {
  const response = await apiFetch('/latex/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: 'cloudrun', files, main, compiler }) });
  const answer = (await response.json().catch(() => ({}))) as { pdf?: string; error?: string; log?: string };
  if (!response.ok) throw new Error(answer.error ?? `The compiler answered ${response.status}.`);
  if (!answer.pdf) throw new Error(`It didn’t compile: ${(answer.log ?? '').split('\n').filter((line) => line.startsWith('!')).slice(0, 2).join(' ') || 'no PDF came out'}.`);
  return new Blob([Uint8Array.from(atob(answer.pdf), (char) => char.charCodeAt(0))], { type: 'application/pdf' });
}

function filesOf(comparison: Comparison, version: Version, decisions: Record<string, Decision>) {
  const out: { path: string; base64: string }[] = [];
  for (const file of comparison.files) {
    const base64 = version === 'mine' ? file.mine : version === 'theirs' ? file.theirs : file.status === 'same' ? file.mine : decisions[file.path] ? finalOf(file, decisions[file.path]) : file.mine;
    if (base64) out.push({ path: file.path, base64 });
  }
  return out;
}

/** The two versions compiled and their PDFs compared page by page: removed on the left, added on the right. */
function PdfCompare({ comparison, decisions, main, compiler }: { comparison: Comparison; decisions: Record<string, Decision>; main: string; compiler: string }) {
  const [left, setLeft] = useState<Version>('mine');
  const [right, setRight] = useState<Version>('theirs');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [diff, setDiff] = useState<PdfDiff | null>(null);
  const [onlyChanged, setOnlyChanged] = useState(true);
  const run = async () => {
    setProblem(null);
    setDiff(null);
    try {
      setBusy(`Compiling ${VERSION_LABEL[left].toLowerCase()}’s and ${VERSION_LABEL[right].toLowerCase()}’s on Cloud Run…`);
      const [a, b] = await Promise.all([compileVersion(filesOf(comparison, left, decisions), main, compiler), compileVersion(filesOf(comparison, right, decisions), main, compiler)]);
      setBusy('Comparing the pages…');
      setDiff(await diffPdfs(a, b));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };
  const pages = diff ? diff.pages.map((page, n) => ({ page, n: n + 1 })).filter(({ page }) => !onlyChanged || page.changed) : [];
  return (
    <div className="wc-pdf">
      <div className="wc-pdf-bar">
        <label>
          <span className="wr-quiet">Left</span>
          <select value={left} onChange={(event) => setLeft(event.target.value as Version)}>
            {(Object.keys(VERSION_LABEL) as Version[]).map((version) => (
              <option key={version} value={version}>
                {VERSION_LABEL[version]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="wr-quiet">Right</span>
          <select value={right} onChange={(event) => setRight(event.target.value as Version)}>
            {(Object.keys(VERSION_LABEL) as Version[]).map((version) => (
              <option key={version} value={version}>
                {VERSION_LABEL[version]}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn sm primary" disabled={Boolean(busy) || left === right} onClick={() => void run()}>
          {diff ? 'Compare again' : 'Compile both and compare'}
        </button>
        {diff ? (
          <label className="wc-pdf-only">
            <input type="checkbox" checked={onlyChanged} onChange={(event) => setOnlyChanged(event.target.checked)} /> Only pages that changed
          </label>
        ) : null}
      </div>
      <p className="wr-quiet wc-pad">Both are compiled from {main} with {compiler}. Red: only in the left one; green: only in the right one. The PDF compare is saurav717/diff-checker’s: by words where the text can be read, by pixels where it can’t.</p>
      {busy ? <p className="wr-quiet wc-pad">{busy}</p> : null}
      {problem ? <p className="wr-bad wc-pad">{problem}</p> : null}
      {diff ? (
        <>
          <p className="wc-pad">
            {diff.stats.add + diff.stats.del ? `${diff.stats.del} removed · ${diff.stats.add} added, across ${diff.pages.filter((page) => page.changed).length} of ${diff.pages.length} pages` : `The PDFs look the same, all ${diff.pages.length} pages.`}
            {diff.usedPixel ? ' · some pages compared by pixels, their text not readable' : ''}
          </p>
          <div className="wc-pdf-pages">
            <div className="wc-pdf-row wc-pdf-heads">
              <b>{VERSION_LABEL[left]}</b>
              <span />
              <b>{VERSION_LABEL[right]}</b>
            </div>
            {pages.map(({ page, n }) => (
              <div key={n} className={`wc-pdf-row${page.changed ? ' has-change' : ''}`}>
                <PdfSide side={page.a} kind="del" />
                <span className="wc-pdf-num">{n}</span>
                <PdfSide side={page.b} kind="add" />
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function PdfSide({ side, kind }: { side: PdfDiffPage['a']; kind: 'del' | 'add' }) {
  if (!side) return <div className="wc-pdf-page is-empty">no page here</div>;
  return (
    <div className="wc-pdf-page" style={{ aspectRatio: `${side.vw} / ${side.vh}` }}>
      <img src={side.url} alt="" loading="lazy" />
      {side.boxes.map((box, n) => {
        const pad = Math.max(box.h * 0.04, 1);
        return (
          <i
            key={n}
            className={`wc-hl is-${kind}${box.whole ? ' is-whole' : ''}`}
            style={box.whole ? undefined : { left: `${((box.x - pad) / side.vw) * 100}%`, top: `${((box.y - pad) / side.vh) * 100}%`, width: `${((box.w + pad * 2) / side.vw) * 100}%`, height: `${((box.h + pad * 2) / side.vh) * 100}%` }}
          />
        );
      })}
    </div>
  );
}
