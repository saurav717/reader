// The Write tab: a project's paper, the whole page an editor — its files, the
// LaTeX, and the PDF it makes — as Overleaf is, but on this computer. The
// files are in a folder under the Companion's (read and written through
// Jupyter, as the Playground's are), the Companion compiles them (latexmk, or
// Tectonic) and keeps the folder in step with Overleaf through its Git, or
// Dropbox does. When it compiles, how it is laid out, when it syncs and the
// citations drawer are Settings → Projects → The Write tab (types.ts,
// `WRITE_OPTIONS`). The folder is chosen once on each computer: a project
// remembers it by the computer's Companion.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../lib/store';
import { jupyterDelete, jupyterList, jupyterMkdir, jupyterRead, jupyterReadBase64, jupyterRename, jupyterWrite, jupyterWriteBase64 } from '../lib/colab';
import { COMPANION_VERSION, PAPER_TEMPLATES_VERSION, PAPER_VERSION, TEXLIVE_VERSION, TEX_COMPILERS, applyTemplate, updateCompanion, waitForVersion, cancelTexLive, installPackages, installTexLive, removeTexLive, texLiveStatus, type TexLiveStatus, chooseFolder, clonePaper, compilePaper, deleteTemplate, forgetOverleafToken, installTectonic, isNewer, linkFolder, listTemplates, paperEngines, paperRemote, saveTemplate, syncPaper, tokenKnown, type Compiled, type PaperEngines, type PaperTemplate, type Synced, type TexCompiler, type TexProblem } from '../lib/companion';
import { besideFeatures, bibEntries, isBuildFile, isTextFile, keyFor, overleafGitUrl, paperFolderFor, parseOverleafUrl, switchedLink, withEntry } from '../lib/overleaf';
import { complete as completeLatex } from '../lib/latexComplete';
import { openPdf } from '../lib/pdfReflow';
import { papersIn, type Project } from '../lib/projects';
import { thisComputer, type ThisComputer } from '../lib/thisComputer';
import type { PaperFolder, WriteOptions } from '../types';
import { WRITE_DEFAULTS } from '../types';
import type { View } from '../types.view';
import CodeEditor, { type CodeEditorHandle } from './CodeEditor';
import CopyBlock from './CopyBlock';
import { DraftEditor, GitHubConnect, OpenOverleaf } from './Overleaf';
import { branchFor, hasWorkflow, makeCompileRepo, pushPaper, putWorkflow, readTexLog, resultFor, runFor, type CompileFile } from '../lib/latexGithub';
import { CompanionConnect } from './Playground';

type Here = Extract<ThisComputer, { server: unknown }>;

/**
 * An Overleaf Git token typed before the Companion is connected: held in this
 * page's memory only — never stored in the browser — until the set-up hands
 * it to the Companion, which keeps it on the computer.
 */
let earlyToken = '';

/** The tab, for a project: this computer's Companion, then the paper's folder on it, then the desk. */
export default function WritePage({ project, onView }: { project: Project; onView: (view: View) => void }) {
  const [here, setHere] = useState<ThisComputer | null>(null);
  const [inBrowser, setInBrowser] = useState(false);
  const ask = useCallback((again = false) => {
    setHere(null);
    void thisComputer(PAPER_VERSION, 'write the paper here', again).then(setHere);
  }, []);
  useEffect(() => ask(), [ask]);
  // Missing, it is looked for again every few seconds: started (the Reader app, or the command), the tab goes on by itself.
  const missing = Boolean(here && 'error' in here);
  useEffect(() => {
    if (!missing) return;
    let live = true;
    const timer = window.setInterval(() => {
      void thisComputer(PAPER_VERSION, 'write the paper here', true).then((found) => live && !('error' in found) && setHere(found));
    }, 4000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [missing]);
  const link = project.project.overleaf;
  const folder = here && 'id' in here ? link?.folders?.[here.id] : undefined;
  const { papers } = useStore();
  const mine = useMemo(() => papersIn(project.id, papers), [project.id, papers]);

  if (!here) return <div className="wr-center"><p className="wr-quiet">Looking for this computer’s Companion…</p></div>;
  if ('error' in here) {
    if (inBrowser && link?.repo) {
      return (
        <div className="wr-browser">
          <div className="wr-browser-bar">
            <span className="pj-sub">Writing in the browser: each Save is a commit to {link.repo}, which Overleaf pulls. Compiling needs the Companion, or Overleaf.</span>
            <span style={{ flex: 1 }} />
            <button type="button" className="btn sm" onClick={() => setInBrowser(false)}>
              Write on this computer
            </button>
          </div>
          <DraftEditor project={project} paper={mine[0]} />
        </div>
      );
    }
    return (
      <div className="wr-center wr-start">
        <div className="wr-card">
          <span className="eyebrow">The paper</span>
          <h2>Write it on this computer</h2>
          <p>The Write tab keeps the paper in a folder on your computer, compiles it there and keeps it in step with Overleaf — your coauthors’ edits come in, yours go out. That takes the Companion, connected once here; after that this tab finds it by itself.</p>
          {here.why === 'old' ? <p className="wr-bad">{here.error}</p> : null}
          {overleafGitUrl(link?.url) ? (
            <>
              <EarlyToken />
              <ForgetToken />
            </>
          ) : null}
          {link ? (
            <div className="wr-row">
              <OpenOverleaf project={project} view="beside" primary={false} />
              {link.repo ? (
                <button type="button" className="btn" onClick={() => setInBrowser(true)} title="Edit the .tex files in the browser and commit them to the project’s GitHub repository: no Companion">
                  Write in the browser instead
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {here.why === 'old' ? null : (
          <div className="wr-connect">
            <CompanionConnect onPaired={() => ask(true)} onManual={() => onView({ kind: 'playground' })} />
          </div>
        )}
      </div>
    );
  }
  if (!folder) return <WriteSetUp project={project} here={here} />;
  return <WriteDesk key={`${here.id}:${folder.path}`} project={project} here={here} folder={folder} />;
}

/** The way to Overleaf's Git, step by step, with the token taken now if it is to hand. */
function EarlyToken() {
  const [token, setToken] = useState(earlyToken);
  return (
    <div className="wr-steps">
      <ol>
        <li className="is-now">
          <b>Connect this computer</b> — below. Once, on each computer.
        </li>
        <li>
          <b>Your Overleaf Git token</b> — in Overleaf: Account Settings → Git integration → Generate token.
          <input
            type="password"
            value={token}
            autoComplete="off"
            placeholder="Paste it here now, or on the next step (olp_…)"
            aria-label="Overleaf Git token"
            onChange={(event) => {
              setToken(event.target.value);
              earlyToken = event.target.value.trim();
            }}
          />
          <small>Kept in this page’s memory until the next step hands it to the Companion, which keeps it on your computer. It is not saved in the browser.</small>
        </li>
        <li>
          <b>Clone the paper</b> — pick “Overleaf’s Git”, a folder, and Clone. From then on your edits go to Overleaf and your coauthors’ come in.
        </li>
      </ol>
    </div>
  );
}

/**
 * Where the Overleaf Git token is kept on this computer, and how to take it
 * off: a button when the Companion is here, and the steps by hand either way.
 */
function ForgetToken({ server, open = false, onForgotten }: { server?: Here['server']; open?: boolean; onForgotten?: () => void }) {
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const windows = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || navigator.userAgent);
  const file = windows ? '%USERPROFILE%\\.reader-companion\\config.json' : '~/.reader-companion/config.json';
  return (
    <details className="wr-forget" open={open}>
      <summary>Remove the Overleaf token from this computer</summary>
      <p>
        The Companion keeps it in <code>{file}</code>, under <code>git_tokens</code>, readable only by your user account. The paper’s folder doesn’t hold it: Git is handed it for each sync and keeps nothing.
      </p>
      {server ? (
        <p className="wr-row">
          <button
            type="button"
            className="btn sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const done = await forgetOverleafToken(server);
                setSaid(done.forgotten ? 'Removed from this computer. The next sync asks for a token again.' : 'There was no Overleaf token on this computer.');
                onForgotten?.();
              } catch (error) {
                setSaid(error instanceof Error ? error.message : String(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Removing…' : 'Remove it now'}
          </button>
          {said ? <span className="wr-quiet">{said}</span> : null}
        </p>
      ) : null}
      <ol>
        <li>
          {server ? 'Or by hand: open' : 'Open'} <code>{file}</code> in a text editor{windows ? '' : <> (on a Mac: <code>open -e ~/.reader-companion/config.json</code> in Terminal)</>}, delete the <code>"git_tokens"</code> entry, and save.
        </li>
        <li>
          To make the token useless everywhere — on this computer and any other — delete it in Overleaf: Account Settings → Git integration.
        </li>
      </ol>
    </details>
  );
}

// ------------------------------------------------------ compiled on GitHub --

type GithubState = { phase: 'idle' | 'setup' | 'sending' | 'queued' | 'compiling' | 'done' | 'failed'; startedAt?: number; finishedAt?: number; runUrl?: string; error?: string };

/** Seconds since, as m:ss, ticking. */
function useElapsed(since: number | undefined, running: boolean): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  if (!since) return '';
  const seconds = Math.max(0, Math.round(((running ? now : now) - since) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * The PDF pane's line about GitHub: setting it up once (GitHub connected, a
 * private repository with the compile workflow), then how a compile is going.
 */
function GithubCompilePanel({ token, repo, state, onRepo, onCompile }: { token: string; repo: string; state: GithubState; onRepo: (repo: string) => void; onCompile: () => void }) {
  const [making, setMaking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const running = state.phase === 'sending' || state.phase === 'queued' || state.phase === 'compiling';
  const elapsed = useElapsed(state.startedAt, running);
  const note = (
    <p className="wr-later">
      <b>Note for later:</b> look into a compile server on Google Cloud Run — your own, with all of TeX Live, a PDF in seconds rather than minutes, and likely within its free tier.
    </p>
  );
  if (!token || !repo) {
    return (
      <div className="wr-ghc">
        <b>Compile on GitHub — set up once</b>
        <span>GitHub Actions compiles the paper with all of TeX Live, in a private repository of yours, and the PDF comes back here. Free up to 2,000 minutes a month; a compile is a minute or two, and only ⌘↵ or Recompile starts one.</span>
        {!token ? <GitHubConnect /> : null}
        {token ? (
          <>
            <small>The token needs, on that repository: Contents, Workflows and Actions — read and write (and Administration to make it).</small>
            <p className="wr-row">
              <button
                type="button"
                className="btn primary sm"
                disabled={making}
                onClick={async () => {
                  setMaking(true);
                  setProblem(null);
                  try {
                    onRepo(await makeCompileRepo(token));
                  } catch (error) {
                    setProblem(error instanceof Error ? error.message : String(error));
                  } finally {
                    setMaking(false);
                  }
                }}
              >
                {making ? 'Making it…' : 'Make my private compile repository (reader-latex)'}
              </button>
            </p>
          </>
        ) : null}
        {problem ? <p className="wr-bad">{problem}</p> : null}
        {note}
      </div>
    );
  }
  const said =
    state.phase === 'sending'
      ? 'Sending the paper to GitHub…'
      : state.phase === 'queued'
        ? 'Waiting for GitHub to start…'
        : state.phase === 'compiling'
          ? 'Compiling on GitHub with all of TeX Live…'
          : state.phase === 'done'
            ? `Compiled on GitHub in ${elapsed}.`
            : state.phase === 'failed'
              ? state.error ?? 'It didn’t compile.'
              : 'Press ⌘↵ or Recompile: GitHub compiles it with all of TeX Live, and the PDF comes back here in a minute or two.';
  return (
    <div className={`wr-ghc is-line${state.phase === 'failed' ? ' is-bad' : ''}`}>
      <span>
        {running ? <span className="spinner" /> : null} {said} {running && elapsed ? <span className="mono">{elapsed}</span> : null}
        {state.runUrl ? (
          <>
            {' '}
            <a href={state.runUrl} target="_blank" rel="noreferrer noopener">
              the run on GitHub
            </a>
          </>
        ) : null}
      </span>
      {state.phase === 'failed' ? (
        <button type="button" className="link-btn" onClick={onCompile}>
          Try again
        </button>
      ) : null}
      <small className="mono">{repo}</small>
      {note}
    </div>
  );
}

// ------------------------------------------------------- the desk's panes --

/** How the desk is laid out on this device: the files' width, how the source and PDF share the room, the problems' height. */
type Desk = { side: number; split: number; log: number; swapped: boolean; sideOpen: boolean };
const DESK: Desk = { side: 250, split: 0.5, log: 220, swapped: false, sideOpen: true };
const DESK_KEY = 'reader.write.desk';
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function useDesk(): [Desk, (change: Partial<Desk> | ((now: Desk) => Partial<Desk>)) => void] {
  const [desk, setDeskState] = useState<Desk>(() => {
    try {
      return { ...DESK, ...(JSON.parse(localStorage.getItem(DESK_KEY) || '{}') as Partial<Desk>) };
    } catch {
      return DESK;
    }
  });
  const setDesk = useCallback((change: Partial<Desk> | ((now: Desk) => Partial<Desk>)) => {
    setDeskState((now) => {
      const next = { ...now, ...(typeof change === 'function' ? change(now) : change) };
      try {
        localStorage.setItem(DESK_KEY, JSON.stringify(next));
      } catch {
        // only a convenience
      }
      return next;
    });
  }, []);
  return [desk, setDesk];
}

/** A line to drag between two panes; a double-click puts it back. Arrow keys move it too. */
function Handle({ axis, className, style, onDrag, onReset, label }: { axis: 'x' | 'y'; className: string; style?: React.CSSProperties; onDrag: (delta: number) => void; onReset: () => void; label: string }) {
  return (
    <div
      className={`wr-handle is-${axis} ${className}`}
      style={style}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      title={`${label} (double-click to reset)`}
      tabIndex={0}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 12;
        const keys = axis === 'x' ? { ArrowLeft: -step, ArrowRight: step } : { ArrowUp: -step, ArrowDown: step };
        const delta = keys[event.key as keyof typeof keys];
        if (delta) (event.preventDefault(), onDrag(delta));
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        const handle = event.currentTarget;
        handle.setPointerCapture(event.pointerId);
        let last = axis === 'x' ? event.clientX : event.clientY;
        document.body.classList.add(axis === 'x' ? 'is-dragging-x' : 'is-dragging-y');
        const move = (e: PointerEvent) => {
          const at = axis === 'x' ? e.clientX : e.clientY;
          onDrag(at - last);
          last = at;
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          document.body.classList.remove('is-dragging-x', 'is-dragging-y');
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
      }}
    />
  );
}

/** Above the source: how the two panes sit — side by side, one above the other, or one at a time — which goes first, and the source alone. */
function PaneTools({ layout, onLayout, swapped, onSwap, big, onBig }: { layout: WriteOptions['layout']; onLayout: (layout: WriteOptions['layout']) => void; swapped: boolean; onSwap: () => void; big: boolean; onBig: () => void }) {
  return (
    <span className="wr-pane-tools">
      <span className="segmented sm" role="group" aria-label="How the source and the PDF sit">
        <button type="button" aria-pressed={layout === 'side'} onClick={() => onLayout('side')} title="Side by side">◫</button>
        <button type="button" aria-pressed={layout === 'stacked'} onClick={() => onLayout('stacked')} title="One above the other">⬒</button>
        <button type="button" aria-pressed={layout === 'tabs'} onClick={() => onLayout('tabs')} title="One at a time">▭</button>
      </span>
      {layout !== 'tabs' ? (
        <button type="button" className="wr-icon" aria-pressed={swapped} onClick={onSwap} title={layout === 'stacked' ? 'Swap: the PDF on top' : 'Swap: the PDF on the left'} aria-label="Swap the panes">
          ⇄
        </button>
      ) : null}
      <button type="button" className="wr-icon" aria-pressed={big} onClick={onBig} title={big ? 'Back to both panes' : 'The source alone, filling the space'} aria-label={big ? 'Back to both panes' : 'Expand the source'}>
        {big ? '⤡' : '⤢'}
      </button>
    </span>
  );
}

// ------------------------------------------------- the Companion, updated --

/** From this version the Companion updates itself when asked; an older one is updated the way it was installed. */
const SELF_UPDATING = '0.5.0';

/** Update the Companion from here, and the page comes back to it once the new one answers. */
function UpdateCompanion({ server, version }: { server: Here['server']; version: string }) {
  const [state, setState] = useState<'idle' | 'updating' | 'failed'>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  if (isNewer(SELF_UPDATING, version)) {
    return <span className="wr-quiet">This Companion ({version}) is from before it could update itself: install it again the way you did (the Reader app’s .dmg, or the line on the Connect card), once.</span>;
  }
  return (
    <span className="wr-update">
      <button
        type="button"
        className="btn primary sm"
        disabled={state === 'updating'}
        onClick={async () => {
          setState('updating');
          setProblem(null);
          try {
            const done = await updateCompanion(server);
            const back = done.updated ? await waitForVersion(server.url, done.version) : true;
            if (!back) throw new Error('It installed the update but hasn’t answered since. Open the Reader app to start it.');
            window.location.reload();
          } catch (error) {
            setState('failed');
            setProblem(error instanceof Error ? error.message : String(error));
          }
        }}
      >
        {state === 'updating' ? 'Updating the Companion…' : `Update the Companion (${version} → ${COMPANION_VERSION})`}
      </button>
      {problem ? <span className="wr-bad">{problem}</span> : null}
    </span>
  );
}

// ------------------------------------------------- TeX Live for Reader --

/**
 * The Companion's own TeX Live: one click installs TeX Live — the same as
 * Overleaf's — into its folder, no password, and it is used before any other
 * TeX on the computer. While it installs, how far it has got.
 */
function OwnTex({ server, status, onStatus, onReady }: { server: Here['server']; status?: TexLiveStatus; onStatus: (status: TexLiveStatus) => void; onReady: () => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const installing = status?.state === 'installing';
  useEffect(() => {
    if (!installing) return;
    let live = true;
    const timer = window.setInterval(async () => {
      try {
        const now = await texLiveStatus(server);
        if (!live) return;
        onStatus(now);
        if (now.state === 'done') onReady();
      } catch {
        // asked again in a moment
      }
    }, 3000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installing, server]);
  const act = async (call: () => Promise<TexLiveStatus>) => {
    setBusy(true);
    setProblem(null);
    try {
      onStatus(await call());
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  if (status?.installed) {
    return (
      <div className="wr-owntex is-done">
        <span>
          <b>TeX Live for Reader is installed</b> — compiling uses it, and a missing package installs with one click.
        </span>
        <button
          type="button"
          className="link-btn"
          disabled={busy}
          onClick={() => {
            if (window.confirm('Remove TeX Live for Reader from this computer? Compiling goes back to the TeX installed before, if there is one.')) void act(() => removeTexLive(server)).then(onReady);
          }}
        >
          Remove
        </button>
        {problem ? <p className="wr-bad">{problem}</p> : null}
      </div>
    );
  }
  if (installing) {
    const share = status?.of ? Math.round(((status.done ?? 0) / status.of) * 100) : 0;
    return (
      <div className="wr-owntex">
        <b>Installing TeX Live for Reader{status?.scheme === 'medium' ? ' (medium)' : ''}…</b>
        <div className="wr-owntex-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={share}>
          <span style={{ width: `${Math.max(2, share)}%` }} />
        </div>
        <small>
          {status?.step || 'Starting…'} {status?.of ? `· ${share}%` : ''} — it carries on if you leave this page; keep the Companion running.
        </small>
        <p className="wr-row">
          <button type="button" className="btn sm" disabled={busy} onClick={() => void act(() => cancelTexLive(server))}>
            Cancel
          </button>
        </p>
      </div>
    );
  }
  return (
    <div className="wr-owntex">
      <b>Let Reader install TeX Live</b>
      <span>
        TeX Live — the same as Overleaf’s — goes into the Companion’s folder: no password, and nothing else on this computer changes. Reader compiles with it from then on, and a package it lacks installs with one click.
      </span>
      {status?.state === 'failed' ? (
        <div className="wr-bad">
          {status.error}
          {status.tail?.length ? <pre className="wr-owntex-tail">{status.tail.join('\n')}</pre> : null}
        </div>
      ) : null}
      {problem ? <p className="wr-bad">{problem}</p> : null}
      <p className="wr-row">
        <button type="button" className="btn primary sm" disabled={busy} onClick={() => void act(() => installTexLive(server, 'full'))} title="scheme-full, without the documentation: about 5 GB, 20–60 minutes">
          Install everything, as Overleaf (about 5 GB)
        </button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => void act(() => installTexLive(server, 'medium'))} title="scheme-medium: about 1.5 GB, more installed as papers ask">
          A medium set (about 1.5 GB)
        </button>
      </p>
    </div>
  );
}

/** One click: the missing packages into the Companion's TeX Live, then compile again. */
function InstallMissing({ server, names, onDone }: { server: Here['server']; names: string[]; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  return (
    <p className="wr-row">
      <button
        type="button"
        className="btn primary sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setSaid(null);
          try {
            const done = await installPackages(server, names);
            setSaid(done.failed.length ? `Installed ${done.installed.join(', ') || 'nothing'}; couldn’t find ${done.failed.join(', ')}.` : `Installed ${done.installed.join(', ')}. Compiling again…`);
            if (done.installed.length) onDone();
          } catch (error) {
            setSaid(error instanceof Error ? error.message : String(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Installing…' : `Install ${names.join(', ')} now`}
      </button>
      {said ? <span className="wr-quiet">{said}</span> : null}
    </p>
  );
}

// ---------------------------------------------------- packages not here --

/** The packages a compile stopped for: "File `physics.sty' not found". */
function missingPackages(compiled: Compiled | null): string[] {
  if (!compiled) return [];
  const found = new Set<string>();
  for (const text of [...compiled.errors.map((item) => item.message), compiled.log ?? '']) {
    for (const match of text.matchAll(/File [`'‘]([\w.-]+)\.(?:sty|cls)['’] not found/g)) found.add(match[1]);
  }
  return [...found];
}

/** A TeX Live whose year is frozen: tlmgr then installs only from that year's archive. */
function frozen(year: number): boolean {
  const now = new Date();
  // A year's TeX Live is replaced by the next, about April.
  return year < now.getFullYear() - 1 || (year === now.getFullYear() - 1 && now.getMonth() >= 3);
}

/** What to do about packages this computer's TeX hasn't got: install them, or let Tectonic fetch them. */
function MissingPackages({ names, texLive, tectonic, onTectonic, first }: { names: string[]; texLive?: string; tectonic: boolean; onTectonic: () => void; /** The way Reader does it for you, above the rest. */ first?: ReactNode }) {
  const year = texLive ? Number(texLive) : NaN;
  const old = Number.isFinite(year) && frozen(year);
  const windows = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || navigator.userAgent);
  const sudo = windows ? '' : 'sudo ';
  const install = `${sudo}tlmgr install ${names.join(' ')}`;
  const command = old ? `${sudo}tlmgr option repository https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/${year}/tlnet-final\n${install}` : install;
  return (
    <div className="wr-missing">
      <p>
        <b>Not on this computer: {names.map((name) => `${name}.sty`).join(', ')}.</b> Overleaf has every package; this computer’s TeX{texLive ? ` Live ${texLive}` : ''} is a smaller install.{first ? '' : ' Either:'}
      </p>
      {first}
      {first ? <p className="wr-quiet">Or by hand:</p> : null}
      <ol>
        <li>
          Install {names.length === 1 ? 'it' : 'them'} — in a terminal{windows ? ' (as administrator)' : ''}:
          <CopyBlock code={command} />
          {old ? <small>TeX Live {texLive} is frozen, so tlmgr has to install from its archive (the first line). Installing this year’s TeX Live instead brings it up to date with Overleaf.</small> : null}
          <small>If tlmgr can’t find it by that name: <span className="mono">tlmgr search --global --file /{names[0]}.sty</span> names the package that has it.</small>
        </li>
        <li>
          Or install the whole of TeX Live, as Overleaf has it:{' '}
          <a href={windows ? 'https://www.tug.org/texlive/' : /Mac/i.test(navigator.userAgent) ? 'https://www.tug.org/mactex/' : 'https://www.tug.org/texlive/'} target="_blank" rel="noreferrer noopener">
            {/Mac/i.test(navigator.userAgent) ? 'MacTeX' : 'TeX Live'}
          </a>{' '}
          (a few GB; nothing missing after that).
        </li>
        {tectonic ? (
          <li>
            Or{' '}
            <button type="button" className="link-btn" onClick={onTectonic}>
              compile with Tectonic
            </button>
            , which fetches any package it needs by itself — but always as XeLaTeX.
          </li>
        ) : null}
      </ol>
    </div>
  );
}

/** The end of an Overleaf project's address, enough to tell two apart. */
const shortProject = (url: string) => {
  const last = url.replace(/\/+$/, '').split('/').pop() ?? url;
  return last.length > 10 ? `…${last.slice(-6)}` : last;
};

/**
 * Which Overleaf project the paper is, and the way to another: the folder of
 * the one left stays on the computer, the new one is cloned with all that is
 * written in it so far, and one switched back to opens its folder again and
 * takes in what changed in Overleaf meanwhile. Or off Overleaf altogether.
 */
function SwitchOverleaf({ project }: { project: Project }) {
  const { updateCollection } = useStore();
  const link = project.project.overleaf;
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const parsed = parseOverleafUrl(url);
  if (!link) return null;
  const earlier = Object.keys(link.earlier ?? {});
  const move = (next: string | undefined) => {
    void updateCollection(project.id, (collection) => {
      const info = { ...project.project, ...(collection.project ?? {}) };
      if (!info.overleaf) return {};
      if (!next) {
        const { overleaf: _gone, ...rest } = info;
        return { project: rest };
      }
      return { project: { ...info, overleaf: switchedLink(info.overleaf, next) } };
    });
    setOpen(false);
    setUrl('');
  };
  if (!open) {
    return (
      <span className="wr-switch">
        <a className="mono" href={link.url} target="_blank" rel="noreferrer noopener" title={link.url}>
          Overleaf {shortProject(link.url)}
        </a>
        <button type="button" className="link-btn" onClick={() => setOpen(true)} title="Write in another Overleaf project, or disconnect from this one">
          Switch
        </button>
      </span>
    );
  }
  return (
    <form
      className="wr-switch-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (parsed && parsed !== link.url) move(parsed);
      }}
    >
      <b>Another Overleaf project</b>
      <input autoFocus value={url} placeholder="https://www.overleaf.com/project/…" onChange={(event) => setUrl(event.target.value)} aria-label="The Overleaf project’s address" />
      {url.trim() && !parsed ? <small className="wr-bad">Copy the address from Overleaf’s address bar with the project open.</small> : null}
      {earlier.length ? (
        <span className="wr-switch-back">
          Or back to:{' '}
          {earlier.map((address) => (
            <button key={address} type="button" className="link-btn" onClick={() => move(address)} title={`${address} — its folder is kept, and Overleaf’s changes come in when it opens`}>
              {shortProject(address)}
            </button>
          ))}
        </span>
      ) : null}
      <small>The folder of {shortProject(link.url)} stays on this computer as it is. The new project is cloned with everything written in it so far; one you come back to opens its folder again and takes in what changed in Overleaf meanwhile.</small>
      <span className="wr-row">
        <button type="submit" className="btn primary sm" disabled={!parsed || parsed === link.url}>
          Switch
        </button>
        <button type="button" className="btn sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <span className="wr-sp" />
        <button
          type="button"
          className="link-btn wr-danger"
          onClick={() => {
            if (window.confirm(`Disconnect “${project.name}” from Overleaf? The Overleaf project and the folders on your computers stay as they are; link one again from the project’s overview.`)) move(undefined);
          }}
        >
          Disconnect from Overleaf
        </button>
      </span>
    </form>
  );
}

// ------------------------------------------------------------- set-up --

/** Fields of the project's Overleaf link changed, whatever else is on it kept: the compiler, the main document. */
function useUpdateLink(project: Project) {
  const { updateCollection } = useStore();
  return (change: Partial<NonNullable<Project['project']['overleaf']>>) =>
    void updateCollection(project.id, (collection) => {
      const info = { ...project.project, ...(collection.project ?? {}) };
      if (!info.overleaf) return {};
      return { project: { ...info, overleaf: { ...info.overleaf, ...change } } };
    });
}

function useSaveFolder(project: Project) {
  const { updateCollection } = useStore();
  return (computer: string, folder: PaperFolder | undefined, url?: string) =>
    void updateCollection(project.id, (collection) => {
      const info = { ...project.project, ...(collection.project ?? {}) };
      const link = info.overleaf ?? (url ? { url } : undefined);
      if (!link) return {};
      const folders = { ...(link.folders ?? {}) };
      if (folder) folders[computer] = folder;
      else delete folders[computer];
      const { folders: _old, ...rest } = link;
      return { project: { ...info, overleaf: { ...rest, ...(Object.keys(folders).length ? { folders } : {}) } } };
    });
}

/** A file as base64, for the Companion or Jupyter. */
const fileBase64 = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('The file couldn’t be read.'));
    reader.readAsDataURL(file);
  });

/**
 * A conference's kit, kept once on this computer and offered to every new
 * paper: the templates there, a .zip to add as another, and the one picked.
 */
function TemplatePicker({ here, value, onChange }: { here: Here; value: string; onChange: (slug: string) => void }) {
  const [templates, setTemplates] = useState<PaperTemplate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const old = isNewer(PAPER_TEMPLATES_VERSION, here.version);
  useEffect(() => {
    if (old) return;
    void listTemplates(here.server).then(setTemplates, (error) => setProblem(error instanceof Error ? error.message : String(error)));
  }, [here, old]);
  if (old) return <p className="wr-quiet">Templates need the Companion {PAPER_TEMPLATES_VERSION} or later on this computer (it is {here.version}): update it from Your compute in the Playground.</p>;
  const add = async (file: File) => {
    setBusy(true);
    setProblem(null);
    try {
      const made = await saveTemplate(here.server, name.trim() || file.name.replace(/\.zip$/i, ''), await fileBase64(file));
      setTemplates(await listTemplates(here.server));
      onChange(made.slug);
      setName('');
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="wr-templates">
      <span className="wr-field-label">Start from a conference template <small>optional</small></span>
      <div className="wr-template-list" role="radiogroup" aria-label="Template">
        <button type="button" role="radio" aria-checked={!value} className={`wr-template${!value ? ' is-on' : ''}`} onClick={() => onChange('')}>
          <b>None</b>
          <small>{templates === null ? 'Asking this computer…' : 'The project’s files as they are'}</small>
        </button>
        {(templates ?? []).map((template) => (
          <span key={template.slug} className={`wr-template${value === template.slug ? ' is-on' : ''}`}>
            <button type="button" role="radio" aria-checked={value === template.slug} onClick={() => onChange(template.slug)}>
              <b>{template.name}</b>
              <small>
                {template.files} files{template.main ? ` · ${template.main}` : ''}
              </small>
            </button>
            <button
              type="button"
              className="wr-template-x"
              aria-label={`Delete the template ${template.name}`}
              title="Delete this template from this computer"
              onClick={async () => {
                if (!window.confirm(`Delete the template “${template.name}” from this computer? Papers made from it keep their files.`)) return;
                await deleteTemplate(here.server, template.slug);
                if (value === template.slug) onChange('');
                setTemplates(await listTemplates(here.server));
              }}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="wr-row">
        <input className="wr-template-name" value={name} placeholder="Its name, e.g. NeurIPS 2026" onChange={(event) => setName(event.target.value)} aria-label="The template’s name" />
        <button type="button" className="btn sm" disabled={busy} onClick={() => picker.current?.click()}>
          {busy ? 'Adding…' : 'Add a template (.zip)…'}
        </button>
        <input
          ref={picker}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void add(file);
          }}
        />
        <span className="wr-quiet">The kit a conference gives out: its class, style and example paper.</span>
      </div>
      {problem ? <p className="wr-bad">{problem}</p> : null}
    </div>
  );
}

/** Where the paper's folder comes from, the first time on this computer. */
function WriteSetUp({ project, here }: { project: Project; here: Here }) {
  const { settings } = useStore();
  const link = project.project.overleaf;
  const save = useSaveFolder(project);
  const updateLink = useUpdateLink(project);
  const gitUrl = overleafGitUrl(link?.url);
  const [way, setWay] = useState<'git' | 'dropbox' | 'github' | 'folder'>(gitUrl ? 'git' : link?.repo ? 'github' : 'dropbox');
  const [token, setToken] = useState(earlyToken);
  // An Overleaf Git token is the account's: once given on this computer, every project of it uses it.
  const [known, setKnown] = useState<boolean | null>(null);
  const [another, setAnother] = useState(false);
  const [where, setWhere] = useState(paperFolderFor(project.name));
  const [template, setTemplate] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [engines, setEngines] = useState<PaperEngines | null>(null);
  useEffect(() => {
    void paperEngines(here.server).then(setEngines, () => setEngines(null));
    if (gitUrl && !isNewer(PAPER_TEMPLATES_VERSION, here.version)) void tokenKnown(here.server, gitUrl).then(setKnown, () => setKnown(false));
    else setKnown(false);
  }, [here, gitUrl]);

  /** The template's files into the new folder, then — with Git — to Overleaf at once. */
  const fill = async (folder: string, synced: boolean) => {
    if (!template) return;
    const done = await applyTemplate(here.server, template, folder, synced);
    if (done.main) updateLink({ main: done.main });
    if (synced) await syncPaper(here.server, folder, 'Start from a template, from Reader');
  };
  const clone = async (url: string, secret: string) => {
    setBusy(true);
    setProblem(null);
    try {
      const done = await clonePaper(here.server, where, url, secret);
      try {
        await fill(done.folder, true);
      } catch (error) {
        setProblem(`Cloned, but the template didn’t go in: ${error instanceof Error ? error.message : String(error)}`);
      }
      save(here.id, { path: done.folder, sync: 'git' });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const pick = async (sync: 'dropbox' | 'folder') => {
    setBusy(true);
    setProblem(null);
    try {
      const chosen = await chooseFolder(here.server);
      if (!chosen.path) return;
      const linked = await linkFolder(here.server, chosen.path);
      await fill(linked.root, false);
      save(here.id, { path: linked.root, sync });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const fresh = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const done = await applyTemplate(here.server, template, where);
      if (done.main) updateLink({ main: done.main });
      save(here.id, { path: where, sync: 'folder' });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const askToken = gitUrl && (!known || another);

  return (
    <div className="wr-scroll">
      <div className="wr-card wr-setup">
        <span className="eyebrow">The paper · on {here.name}</span>
        <h2>Where should the paper’s files be?</h2>
        <SwitchOverleaf project={project} />
        <p>The Write tab edits the paper in a folder on this computer, compiles it here as Overleaf does, and keeps it in step with Overleaf. Pick how, once for this computer: the project keeps it until you change it.</p>
        {!link ? <p className="wr-bad">Link the Overleaf project on the project’s overview first (the paper card), so the tab knows which paper it is.</p> : null}
        <p className="wr-note">
          <b>Writing with coauthors:</b> the Overleaf project is where everyone’s edits meet. Share it with them in Overleaf (Share → their email), and each of you links the same Overleaf address here and clones it with your own Overleaf Git token. Every sync pulls the others’ edits in before pushing yours, and anyone can still write straight in Overleaf.
        </p>
        <div className="wr-ways" role="radiogroup" aria-label="Where the paper’s files come from">
          <button type="button" role="radio" aria-checked={way === 'git'} className={`wr-way${way === 'git' ? ' is-on' : ''}`} onClick={() => setWay('git')} disabled={!gitUrl}>
            <b>
              Overleaf’s Git <small>recommended</small>
            </b>
            <span>A clone of the Overleaf project. Everything you write or add here goes to Overleaf seconds after you stop, and coauthors’ edits come in. Needs a paid Overleaf plan.</span>
            {!gitUrl && link ? <span className="wr-bad">This needs the project’s address in Overleaf (overleaf.com/project/…), not a share link: change it on the paper card.</span> : null}
          </button>
          <button type="button" role="radio" aria-checked={way === 'dropbox'} className={`wr-way${way === 'dropbox' ? ' is-on' : ''}`} onClick={() => setWay('dropbox')}>
            <b>Overleaf’s Dropbox folder</b>
            <span>If Overleaf syncs the project to Dropbox, pick that folder: Dropbox carries edits both ways by itself. Needs a paid Overleaf plan and Dropbox here.</span>
          </button>
          <button type="button" role="radio" aria-checked={way === 'github'} className={`wr-way${way === 'github' ? ' is-on' : ''}`} onClick={() => setWay('github')} disabled={!link?.repo}>
            <b>Its GitHub repository</b>
            <span>{link?.repo ? `A clone of ${link.repo}, with the token from Settings → Git mirror. Overleaf takes the edits in from Menu → GitHub → Pull: not by itself.` : 'Name the repository on the paper card first (Overleaf’s GitHub sync).'}</span>
          </button>
          <button type="button" role="radio" aria-checked={way === 'folder'} className={`wr-way${way === 'folder' ? ' is-on' : ''}`} onClick={() => setWay('folder')}>
            <b>A folder already here</b>
            <span>Any folder with the paper in it, compiled here and not synced: copy it to Overleaf yourself.</span>
          </button>
        </div>

        {way !== 'github' ? <TemplatePicker here={here} value={template} onChange={setTemplate} /> : null}
        {template && way === 'git' ? <p className="wr-note">For a new paper from a template: in Overleaf make a <b>Blank Project</b>, put its address on the paper card, and clone it here. The template’s files go in and are pushed to Overleaf straight away.</p> : null}

        {way === 'git' && gitUrl ? (
          <div className="wr-form">
            {known && !another ? (
              <p className="wr-ok">
                Your Overleaf account’s Git token is on this computer already.{' '}
                <button type="button" className="link-btn" onClick={() => setAnother(true)}>
                  Use another
                </button>
              </p>
            ) : null}
            {known ? <ForgetToken server={here.server} onForgotten={() => setKnown(false)} /> : null}
            {askToken ? (
              <label className="wr-field">
                <span>Overleaf Git token</span>
                <input type="password" value={token} autoComplete="off" placeholder="olp_…" onChange={(event) => setToken(event.target.value)} />
                <small>In Overleaf: Account Settings → Git integration → Generate token. The Companion keeps it on this computer, readable only by you, for every project of your account.</small>
              </label>
            ) : null}
            <label className="wr-field">
              <span>Folder, inside the Companion’s</span>
              <input value={where} onChange={(event) => setWhere(event.target.value)} />
            </label>
            <div className="wr-row">
              <button type="button" className="btn primary" disabled={busy || known === null || (askToken ? !token.trim() : false) || !where.trim()} onClick={() => void clone(gitUrl, askToken ? token.trim() : '')}>
                {busy ? 'Cloning…' : template ? 'Clone, and fill it from the template' : 'Clone from Overleaf'}
              </button>
              <span className="wr-quiet mono">{gitUrl}</span>
            </div>
          </div>
        ) : null}
        {way === 'github' && link?.repo ? (
          <div className="wr-form">
            <label className="wr-field">
              <span>Folder, inside the Companion’s</span>
              <input value={where} onChange={(event) => setWhere(event.target.value)} />
            </label>
            <div className="wr-row">
              <button type="button" className="btn primary" disabled={busy || !settings.githubToken.trim()} onClick={() => void clone(`https://github.com/${link.repo}`, settings.githubToken.trim())}>
                {busy ? 'Cloning…' : `Clone ${link.repo}`}
              </button>
              {!settings.githubToken.trim() ? <span className="wr-bad">Add a GitHub token in Settings → Git mirror first.</span> : null}
            </div>
          </div>
        ) : null}
        {way === 'dropbox' || way === 'folder' ? (
          <div className="wr-row">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void pick(way)}>
              {busy ? 'Waiting for the folder…' : 'Choose the folder on this computer'}
            </button>
            <span className="wr-quiet">{way === 'dropbox' ? 'Usually Dropbox → Apps → Overleaf → the project.' : 'It opens this computer’s own folder chooser.'}</span>
            {way === 'folder' && template ? (
              <button type="button" className="btn" disabled={busy} onClick={() => void fresh()}>
                Or a new folder from the template: {where}
              </button>
            ) : null}
          </div>
        ) : null}
        {problem ? <p className="wr-bad">{problem}</p> : null}
        {engines && !engines.latexmk && !engines.tectonic ? (
          <p className="wr-note">
            There’s no TeX on this computer yet: the first compile offers to fetch Tectonic, or install TeX Live or MacTeX yourself — as Overleaf does, it compiles best with TeX Live.
          </p>
        ) : null}
        {engines && !engines.git && (way === 'git' || way === 'github') ? <p className="wr-bad">git isn’t installed on this computer: install it (git-scm.com, or xcode-select --install on a Mac) to sync.</p> : null}
      </div>
    </div>
  );
}

// --------------------------------------------------------------- desk --

interface FileState {
  /** What the file says now, typed here. */
  text: string;
  /** What is on disk. */
  disk: string;
}

const COMPILE_PAUSE_MS = 1000;
const SAVE_PAUSE_MS = 600;
const SYNC_PAUSE_MS = 4000;
const OVERLEAF_SYNC_PAUSE_MS = 1500;
const PULL_EVERY_MS = 30_000;
const MAX_FILES = 400;

/** Every file under the folder, as paths relative to it; what compiling leaves and .git left out. */
async function listAll(server: Here['server'], folder: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 5 || found.length >= MAX_FILES) return;
    const listing = await jupyterList(server, dir);
    for (const entry of listing.entries) {
      const relative = entry.path.startsWith(`${folder}/`) ? entry.path.slice(folder.length + 1) : entry.name;
      if (entry.name.startsWith('.')) continue;
      if (entry.type === 'directory') await walk(entry.path, depth + 1);
      else if (!isBuildFile(relative)) found.push(relative);
    }
  };
  await walk(folder, 0);
  return found.sort((a, b) => (a.includes('/') === b.includes('/') ? a.localeCompare(b) : a.includes('/') ? 1 : -1));
}

const toBlob = (base64: string) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'application/pdf' });
};

function WriteDesk({ project, here, folder }: { project: Project; here: Here; folder: PaperFolder }) {
  const { settings, papers, updateSettings } = useStore();
  const [desk, setDesk] = useDesk();
  const setLayout = (layout: WriteOptions['layout']) => updateSettings({ write: { ...WRITE_DEFAULTS, ...(settings.write ?? {}), layout } });
  const [big, setBig] = useState<'source' | 'pdf' | null>(null);
  const options: WriteOptions = { ...WRITE_DEFAULTS, ...(settings.write ?? {}) };
  const save = useSaveFolder(project);
  const updateLink = useUpdateLink(project);
  const link = project.project.overleaf;
  // As the Overleaf project is set (Menu → Compiler, Main document): kept on the project, so it stays as picked.
  const compiler: TexCompiler = link?.compiler ?? 'pdflatex';
  const server = here.server;
  const [paths, setPaths] = useState<string[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, FileState>>({});
  const filesRef = useRef(files);
  filesRef.current = files;
  const [open, setOpenState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(`reader.write.${project.id}.file`);
    } catch {
      return null;
    }
  });
  const editor = useRef<CodeEditorHandle>(null);
  const [compiled, setCompiled] = useState<Compiled | null>(null);
  const [pdf, setPdf] = useState<Blob | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [engines, setEngines] = useState<PaperEngines | null>(null);
  const [installing, setInstalling] = useState(false);
  const [synced, setSynced] = useState<Synced | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(0);
  const [showLog, setShowLog] = useState(false);
  const [pane, setPane] = useState<'source' | 'pdf'>('source');
  const [drawer, setDrawer] = useState(true);
  const typedAt = useRef(0);
  const timers = useRef<{ save?: number; compile?: number; sync?: number }>({});
  const [tokenShown, setTokenShown] = useState(false);
  const [texShown, setTexShown] = useState(false);
  // The Companion's own TeX Live, from 0.12.0: installed with a click, its packages too.
  const canOwnTex = !isNewer(TEXLIVE_VERSION, here.version);
  const setOwnTex = (status: TexLiveStatus) => setEngines((now) => (now ? { ...now, texlive: status } : now));
  const panesRef = useRef<HTMLDivElement>(null);
  const git = folder.sync === 'git';
  const at = (relative: string) => `${folder.path}/${relative}`;

  const setOpen = (path: string) => {
    setOpenState(path);
    try {
      localStorage.setItem(`reader.write.${project.id}.file`, path);
    } catch {
      // only a convenience
    }
  };

  const load = useCallback(
    async (relative: string, force = false) => {
      if (!force && filesRef.current[relative]) return;
      const read = await jupyterRead(server, at(relative));
      const text = read?.text ?? '';
      setFiles((current) => (!force && current[relative] ? current : { ...current, [relative]: { text, disk: text } }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [server, folder.path],
  );

  const refreshList = useCallback(async () => {
    try {
      setPaths(await listAll(server, folder.path));
      setListError(null);
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    }
  }, [server, folder.path]);

  useEffect(() => {
    void refreshList();
    void paperEngines(server).then(setEngines, () => setEngines(null));
    if (git) void paperRemote(server, folder.path).then((remote) => setNeedToken(!remote.token && /overleaf|github/.test(remote.url)), () => undefined);
  }, [refreshList, server, folder.path, git]);

  const texts = (paths ?? []).filter(isTextFile);
  const mainGuess = texts.find((path) => path === compiled?.main) ?? texts.find((path) => /(^|\/)main\.tex$/.test(path)) ?? texts.find((path) => path.endsWith('.tex'));
  const shown = open && texts.includes(open) ? open : mainGuess;
  // The main document: as set on the project, else the one the compile found, else the first with main.tex's name.
  const mainDoc = link?.main && texts.includes(link.main) ? link.main : undefined;
  const mainRef = useRef<string | undefined>(mainDoc);
  mainRef.current = mainDoc;
  useEffect(() => {
    if (shown) void load(shown);
  }, [shown, load]);

  // ---- compile
  const compile = useCallback(async () => {
    // Overleaf makes the PDF, or GitHub does (only when asked, ⌘↵ or Recompile: its minutes count): nothing compiles here.
    if (options.pdf === 'overleaf' || options.pdf === 'github') return;
    setCompiling(true);
    setCompileError(null);
    try {
      const done = await compilePaper(server, folder.path, options.engine, { main: mainRef.current, compiler, halt: options.errors === 'halt' });
      setCompiled(done);
      if (done.pdf) setPdf(toBlob(done.pdf));
      if (done.errors.length && !done.pdf) setShowLog(true);
    } catch (error) {
      setCompileError(error instanceof Error ? error.message : String(error));
    } finally {
      setCompiling(false);
    }
  }, [server, folder.path, options.engine, compiler, options.errors, options.pdf]);
  useEffect(() => {
    if (paths && texts.length && engines && (engines.latexmk || engines.tectonic) && !compiled && !compiling) void compile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths, engines]);

  // ---- sync
  const sync = useCallback(
    async (quiet = false) => {
      if (!git) return;
      setSyncing(true);
      if (!quiet) setSyncError(null);
      try {
        const done = await syncPaper(server, folder.path, 'Edits from Reader', token.trim() || undefined);
        setSynced(done);
        setSyncError(done.ok ? null : done.error ?? 'The sync didn’t finish.');
        if (token.trim() && done.ok) setNeedToken(false);
        const incoming = (done.incoming ?? []).map((path) => path.replace(/^\.\//, ''));
        const conflicted = done.conflicts ?? [];
        const reload = [...new Set([...incoming, ...conflicted])].filter((path) => filesRef.current[path] && filesRef.current[path].text === filesRef.current[path].disk);
        if (reload.length || incoming.some((path) => !(paths ?? []).includes(path))) void refreshList();
        await Promise.all(reload.map((path) => load(path, true)));
        if (incoming.length && options.compile !== 'manual') void compile();
      } catch (error) {
        setSyncError(error instanceof Error ? error.message : String(error));
      } finally {
        setSyncing(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [git, server, folder.path, token, paths, options.compile, compile],
  );
  // Opening the tab takes in what changed in Overleaf since, at once.
  const openedSync = useRef(false);
  useEffect(() => {
    if (!git || options.sync === 'manual' || openedSync.current || paths === null) return;
    openedSync.current = true;
    void sync(true);
  }, [git, options.sync, paths, sync]);
  // What coauthors write in Overleaf comes in while nothing is being typed here.
  useEffect(() => {
    if (!git || options.sync === 'manual') return;
    const timer = window.setInterval(() => {
      const dirty = Object.values(filesRef.current).some((file) => file.text !== file.disk);
      if (!dirty && Date.now() - typedAt.current > 5000) void sync(true);
    }, PULL_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [git, options.sync, sync]);

  // ---- save
  const writeOut = useCallback(
    async (relative: string) => {
      const file = filesRef.current[relative];
      if (!file || file.text === file.disk) return false;
      const text = file.text;
      setSaving((n) => n + 1);
      try {
        await jupyterWrite(server, at(relative), text);
        setFiles((current) => (current[relative] ? { ...current, [relative]: { ...current[relative], disk: text } } : current));
        return true;
      } finally {
        setSaving((n) => n - 1);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [server, folder.path],
  );
  const saveAll = useCallback(async () => {
    const dirty = Object.keys(filesRef.current).filter((path) => filesRef.current[path].text !== filesRef.current[path].disk);
    const results = await Promise.all(dirty.map(writeOut));
    return results.some(Boolean);
  }, [writeOut]);

  const afterSave = (how: 'pause' | 'save') => {
    window.clearTimeout(timers.current.compile);
    window.clearTimeout(timers.current.sync);
    if (options.compile === how) timers.current.compile = window.setTimeout(() => void compile(), how === 'pause' ? COMPILE_PAUSE_MS : 0);
    // With Overleaf making the PDF, the edit goes sooner: the PDF waits on it.
    if (git && options.sync === how) timers.current.sync = window.setTimeout(() => void sync(true), how === 'pause' ? (options.pdf === 'overleaf' ? OVERLEAF_SYNC_PAUSE_MS : SYNC_PAUSE_MS) : 0);
  };

  const edit = (relative: string, text: string) => {
    typedAt.current = Date.now();
    setFiles((current) => ({ ...current, [relative]: { disk: current[relative]?.disk ?? '', text } }));
    window.clearTimeout(timers.current.save);
    window.clearTimeout(timers.current.compile);
    window.clearTimeout(timers.current.sync);
    timers.current.save = window.setTimeout(() => void saveAll().then((wrote) => wrote && afterSave('pause')), SAVE_PAUSE_MS);
  };
  useEffect(() => () => {
    window.clearTimeout(timers.current.save);
    window.clearTimeout(timers.current.compile);
    window.clearTimeout(timers.current.sync);
  }, []);

  const saveNow = async () => {
    window.clearTimeout(timers.current.save);
    await saveAll();
    afterSave('save');
  };

  // ---- files made, added, moved and deleted: compiled, and synced like an edit
  const scheduleSync = () => {
    if (!git || options.sync === 'manual') return;
    window.clearTimeout(timers.current.sync);
    timers.current.sync = window.setTimeout(() => void sync(true), 1500);
  };
  const afterChange = async () => {
    await refreshList();
    if (options.compile !== 'manual') void compile();
    scheduleSync();
  };
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const cleanPath = (raw: string | null) => {
    const parts = (raw ?? '').trim().replace(/\\/g, '/').split('/').filter(Boolean);
    if (!parts.length || parts.some((part) => part === '..' || part === '.' || part.startsWith('.'))) return null;
    return parts.join('/');
  };
  const fileOp = async (what: () => Promise<void>) => {
    setFileProblem(null);
    try {
      await what();
      await afterChange();
    } catch (error) {
      setFileProblem(error instanceof Error ? error.message : String(error));
    }
  };
  const newFile = () => {
    const path = cleanPath(window.prompt('A new file — its path in the paper:', 'sections/new-section.tex'));
    if (!path) return;
    if ((paths ?? []).includes(path)) return setFileProblem(`${path} is there already.`);
    void fileOp(async () => {
      await jupyterWrite(server, at(path), '');
      setFiles((current) => ({ ...current, [path]: { text: '', disk: '' } }));
      setOpen(path);
    });
  };
  const newFolder = () => {
    const path = cleanPath(window.prompt('A new folder — its path in the paper (it reaches Overleaf once a file is in it):', 'figures'));
    if (!path) return;
    void fileOp(async () => {
      const parts = path.split('/');
      for (let i = 1; i <= parts.length; i += 1) await jupyterMkdir(server, at(parts.slice(0, i).join('/'))).catch(() => undefined);
    });
  };
  const uploader = useRef<HTMLInputElement>(null);
  const upload = (list: FileList) => {
    const chosen = Array.from(list);
    if (!chosen.length) return;
    const dir = window.prompt(`Put ${chosen.length === 1 ? chosen[0].name : `${chosen.length} files`} in which folder? (empty for the top)`, chosen.every((file) => /\.(png|jpe?g|pdf|eps|svg)$/i.test(file.name)) ? 'figures' : '');
    if (dir === null) return;
    const base = dir.trim() ? cleanPath(dir) : '';
    if (base === null) return setFileProblem('That folder name won’t do.');
    void fileOp(async () => {
      for (const file of chosen) await jupyterWriteBase64(server, at(base ? `${base}/${file.name}` : file.name), await fileBase64(file));
    });
  };
  const rename = (path: string) => {
    const to = cleanPath(window.prompt('Rename or move it — its new path:', path));
    if (!to || to === path) return;
    void fileOp(async () => {
      await writeOut(path);
      await jupyterRename(server, at(path), at(to));
      setFiles((current) => {
        const { [path]: moved, ...rest } = current;
        return moved ? { ...rest, [to]: moved } : rest;
      });
      if (path === shown) setOpen(to);
      if (path === link?.main) updateLink({ main: to });
    });
  };
  const remove = (path: string) => {
    if (!window.confirm(`Delete ${path}?${git ? ' It goes from Overleaf too with the next sync (Overleaf’s history keeps it).' : ''}`)) return;
    void fileOp(async () => {
      await jupyterDelete(server, at(path));
      setFiles((current) => {
        const { [path]: _gone, ...rest } = current;
        return rest;
      });
    });
  };

  // ---- leaving: nothing typed is left behind, and with Git it goes to Overleaf
  const flushRef = useRef<() => void>(() => undefined);
  flushRef.current = () => {
    window.clearTimeout(timers.current.save);
    void saveAll().then((wrote) => {
      if (git && options.sync !== 'manual' && (wrote || synced?.ok !== true || Date.now() - (synced?.at ?? 0) > 2000)) void syncPaper(server, folder.path, 'Edits from Reader').catch(() => undefined);
    });
  };
  useEffect(() => {
    const hidden = () => document.visibilityState === 'hidden' && flushRef.current();
    const leaving = () => flushRef.current();
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', leaving);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', leaving);
      flushRef.current();
    };
  }, []);

  // A compiler or main document picked: the PDF made again with it.
  const firstPick = useRef(true);
  useEffect(() => {
    if (firstPick.current) {
      firstPick.current = false;
      return;
    }
    if (compiled) void compile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compiler, link?.main]);

  // ---- citations
  const mine = useMemo(() => papersIn(project.id, papers), [project.id, papers]);
  const bibPath = texts.find((path) => path.endsWith('.bib'));
  const bibText = bibPath ? files[bibPath]?.text : undefined;
  useEffect(() => {
    if (bibPath && options.citations === 'drawer') void load(bibPath);
  }, [bibPath, options.citations, load]);
  const entries = useMemo(() => bibEntries(bibPath && bibText !== undefined ? [{ path: bibPath, text: bibText }] : []), [bibPath, bibText]);
  // ---- autocomplete: every text file read, for its labels and its own commands; the cite keys from the .bib and the project
  useEffect(() => {
    for (const path of texts.slice(0, 80)) void load(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths, load]);
  const allEntries = useMemo(
    () => bibEntries(Object.entries(files).filter(([path]) => path.endsWith('.bib')).map(([path, file]) => ({ path, text: file.text }))),
    [files],
  );
  const completeFor = useCallback(
    (text: string, caret: number) => {
      const others = Object.entries(files)
        .filter(([path]) => path !== shown && /\.(tex|sty|cls)$/.test(path))
        .map(([path, file]) => ({ path, text: file.text }));
      const keys = [
        ...allEntries.map((entry) => ({ key: entry.key, detail: entry.title ?? 'in the .bib' })),
        ...mine.filter((paper) => !allEntries.some((entry) => entry.key === keyFor(paper, allEntries))).map((paper) => ({ key: keyFor(paper, allEntries), detail: `${paper.title} · adds its BibTeX` })),
      ];
      return completeLatex(text, caret, { files: [{ path: shown ?? '', text }, ...others], paths: paths ?? [], keys });
    },
    [files, shown, allEntries, mine, paths],
  );

  // A project paper's key cited by hand, or from the suggestions, brings its BibTeX entry into the .bib.
  const bibFor = useRef<(text: string) => void>(() => undefined);
  bibFor.current = (text: string) => {
    if (!bibPath || bibText === undefined) return;
    const cited = new Set([...text.matchAll(/\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\]){0,2}\{([^}]*)\}/g)].flatMap((match) => match[1].split(',').map((key) => key.trim())));
    let bib = bibText;
    let current = entries;
    for (const paper of mine) {
      if (!cited.has(keyFor(paper, current))) continue;
      const added = withEntry(bib, paper, current);
      if (!added) continue;
      bib = added;
      current = bibEntries([{ path: bibPath, text: bib }]);
    }
    if (bib !== bibText) edit(bibPath, bib);
  };

  const cite = (paperId: string) => {
    const paper = mine.find((item) => item.id === paperId);
    if (!paper || !shown) return;
    editor.current?.insert(`\\cite{${keyFor(paper, entries)}}`);
    if (bibPath && bibText !== undefined) {
      const added = withEntry(bibText, paper, entries);
      if (added) edit(bibPath, added);
    }
  };

  const goTo = (problem: TexProblem) => {
    const file = problem.file ? problem.file.replace(/^\.\//, '') : compiled?.main;
    if (file && texts.includes(file)) setOpen(file);
    if (options.layout === 'tabs') setPane('source');
    if (problem.line) window.setTimeout(() => editor.current?.goToLine(problem.line!), 60);
  };

  const current = shown ? files[shown] : undefined;
  const dirtyCount = Object.values(files).filter((file) => file.text !== file.disk).length;
  const noTex = engines && !engines.latexmk && !engines.tectonic;
  const texLive = compiled?.engine === 'latexmk' ? engines?.texVersion?.match(/TeX Live (\d{4})/)?.[1] : undefined;
  // Packages the compile looked for and this computer's TeX hasn't got: Overleaf has them all.
  const missing = useMemo(() => missingPackages(compiled), [compiled]);

  const source = (
    <section className="wr-source">
      <div className="wr-tabs">
        <button type="button" className="wr-icon" aria-pressed={desk.sideOpen} onClick={() => setDesk({ sideOpen: !desk.sideOpen })} title={desk.sideOpen ? 'Hide the files' : 'Show the files'} aria-label={desk.sideOpen ? 'Hide the files' : 'Show the files'}>
          ☰
        </button>
        {shown ? <span className="wr-file mono">{shown}{current && current.text !== current.disk ? ' ●' : ''}</span> : null}
        <span className="wr-sp" />
        <PaneTools layout={options.layout} onLayout={setLayout} swapped={desk.swapped} onSwap={() => setDesk({ swapped: !desk.swapped })} big={big === 'source'} onBig={() => setBig(big === 'source' ? null : 'source')} />
        {options.layout === 'tabs' ? (
          <span className="segmented sm">
            <button type="button" aria-pressed={pane === 'source'} onClick={() => setPane('source')}>Source</button>
            <button type="button" aria-pressed={pane === 'pdf'} onClick={() => setPane('pdf')}>PDF</button>
          </span>
        ) : null}
      </div>
      <div className="wr-editor">
        {shown && current ? (
          <CodeEditor
            key={shown}
            ref={editor}
            value={current.text}
            path={shown}
            wrap
            minimap={false}
            complete={/\.(tex|sty|cls)$/.test(shown) ? completeFor : undefined}
            onChange={(next) => {
              edit(shown, next);
              if (shown.endsWith('.tex') && next.includes('cite')) bibFor.current(next);
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                event.preventDefault();
                void saveNow();
              }
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                recompile();
              }
            }}
          />
        ) : (
          <p className="wr-quiet wr-pad">{paths === null ? 'Reading the folder…' : texts.length ? 'Opening…' : 'No .tex file in this folder yet.'}</p>
        )}
      </div>
    </section>
  );

  /**
   * ⌘↵. Here: save and compile. With Overleaf making the PDF: the window
   * beside is taken in the keypress itself (a browser lets a page open one
   * only then) and says the edits are on their way; once they have reached
   * Overleaf, the project opens in it — and Overleaf compiles a project as it
   * opens, so the PDF there is of what was just written. A project set to
   * open in another browser isn't opened from here: this page can't reach it.
   */
  // ---- compiling on GitHub
  const [gh, setGh] = useState<GithubState>({ phase: 'idle' });
  const ghChecked = useRef(false);
  const compileOnGithub = async () => {
    const token = settings.githubToken.trim();
    const repo = settings.latexRepo;
    if (!token || !repo) return setGh({ phase: 'setup' });
    const started = Date.now();
    setCompiling(true);
    setCompileError(null);
    try {
      if (!ghChecked.current && !(await hasWorkflow(token, repo))) await putWorkflow(token, repo);
      ghChecked.current = true;
      setGh({ phase: 'sending', startedAt: started });
      const paths = (await listAll(server, folder.path)).filter((path) => !path.startsWith('.reader'));
      const files: CompileFile[] = [];
      for (const path of paths) files.push({ path, base64: await jupyterReadBase64(server, `${folder.path}/${path}`) });
      const branch = branchFor(project.id);
      const main = mainDoc ?? compiled?.main ?? 'main.tex';
      const sha = await pushPaper(token, repo, branch, files, { main, compiler });
      setGh({ phase: 'queued', startedAt: started });
      const until = Date.now() + 15 * 60_000;
      while (Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const run = await runFor(token, repo, sha).catch(() => null);
        const result = await resultFor(token, repo, branch, sha).catch(() => null);
        if (result) {
          const read = readTexLog(result.log);
          setCompiled({ ok: Boolean(result.pdf) && result.exit === 0, main, engine: 'GitHub · all of TeX Live', compiler, pdf: result.pdf ? 'github' : '', errors: read.errors, warnings: read.warnings, log: result.log, ms: Date.now() - started });
          if (result.pdf) setPdf(result.pdf);
          if (read.errors.length && !result.pdf) setShowLog(true);
          setGh({ phase: 'done', startedAt: started, runUrl: run?.url, finishedAt: Date.now() });
          return;
        }
        if (run?.status === 'completed' && run.conclusion && run.conclusion !== 'success') {
          setGh({ phase: 'failed', startedAt: started, runUrl: run.url, error: `The run on GitHub ended: ${run.conclusion}.` });
          return;
        }
        setGh({ phase: run?.status === 'in_progress' ? 'compiling' : 'queued', startedAt: started, runUrl: run?.url });
      }
      setGh({ phase: 'failed', startedAt: started, error: 'No PDF came back from GitHub within 15 minutes.' });
    } catch (error) {
      setGh({ phase: 'failed', startedAt: started, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setCompiling(false);
    }
  };

  const recompile = () => {
    if (options.pdf === 'github') return void saveNow().then(() => compileOnGithub());
    if (options.pdf !== 'overleaf') return void saveNow().then(() => compile());
    const overleaf = project.project.overleaf;
    let beside: Window | null = null;
    if (overleaf && !overleaf.browsers?.[here.id]) {
      beside = window.open('about:blank', `reader-overleaf-${project.id}`, besideFeatures(window.screen));
      try {
        if (beside) {
          beside.document.title = 'Overleaf';
          beside.document.body.style.cssText = 'font: 15px system-ui, sans-serif; color: #555; display: grid; place-items: center; height: 100vh; margin: 0';
          beside.document.body.textContent = 'Sending your edits to Overleaf…';
        }
      } catch {
        // a window already on Overleaf: it is only navigated
      }
    }
    const show = () => {
      if (!beside || !overleaf) return;
      beside.location.href = overleaf.url;
      try {
        beside.opener = null;
      } catch {
        // already across
      }
      beside.focus();
    };
    if (git) void saveNow().then(() => sync()).finally(show);
    else show();
  };

  const pdfWhere = (
    <span className="wr-where">
    <span className="wr-where-label">Compile on</span>
    <span className="segmented sm" role="group" aria-label="Which compiler makes the PDF">
      <button type="button" aria-pressed={options.pdf === 'here'} onClick={() => updateSettings({ write: { ...WRITE_DEFAULTS, ...(settings.write ?? {}), pdf: 'here' } })} title="The TeX installed on this computer compiles it, through the Companion">
        This computer
      </button>
      <button type="button" aria-pressed={options.pdf === 'github'} onClick={() => updateSettings({ write: { ...WRITE_DEFAULTS, ...(settings.write ?? {}), pdf: 'github' } })} title="GitHub Actions compiles it with all of TeX Live, in a private repository of yours, and the PDF comes back here. It compiles: it doesn’t publish or sync anything.">
        GitHub Actions
      </button>
      <button type="button" aria-pressed={options.pdf === 'overleaf'} onClick={() => updateSettings({ write: { ...WRITE_DEFAULTS, ...(settings.write ?? {}), pdf: 'overleaf' } })} title="Overleaf’s compiler: your edits go to Overleaf, and the PDF is in Overleaf’s window">
        Overleaf
      </button>
    </span>
    </span>
  );

  const local = (
    <section className="wr-preview">
      <div className="wr-tabs">
        <b>PDF</b>
        {pdfWhere}
        <select className="wr-pick" value={compiler} onChange={(event) => updateLink({ compiler: event.target.value as TexCompiler })} aria-label="Compiler" title="As the Overleaf project is set: Menu → Compiler. pdfLaTeX is Overleaf’s default.">
          {TEX_COMPILERS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        <select
          className="wr-pick mono"
          value={mainDoc ?? compiled?.main ?? ''}
          onChange={(event) => updateLink({ main: event.target.value })}
          aria-label="Main document"
          title="As the Overleaf project is set: Menu → Main document"
        >
          {!mainDoc && !compiled?.main ? <option value="">main document…</option> : null}
          {texts
            .filter((path) => path.endsWith('.tex'))
            .map((path) => (
              <option key={path} value={path}>
                {path}
              </option>
            ))}
        </select>
        {compiled ? (
          <span className="wr-quiet" title={texLive ? `Overleaf compiles with the TeX Live set in its Menu → TeX Live version: pick ${texLive} there for the same output as here.` : undefined}>
            {texLive ? `TeX Live ${texLive}` : compiled.engine} · {(compiled.ms / 1000).toFixed(1)} s
          </span>
        ) : null}
        <span className="wr-sp" />
        <button type="button" className="wr-icon" aria-pressed={big === 'pdf'} onClick={() => setBig(big === 'pdf' ? null : 'pdf')} title={big === 'pdf' ? 'Back to both panes' : 'The PDF alone, filling the space'} aria-label={big === 'pdf' ? 'Back to both panes' : 'Expand the PDF'}>
          {big === 'pdf' ? '⤡' : '⤢'}
        </button>
        <button type="button" className="btn sm primary" disabled={compiling || (options.pdf === 'here' && Boolean(noTex))} onClick={recompile} title={options.pdf === 'github' ? 'Compile on GitHub (⌘↵): a minute or two' : 'Recompile (⌘↵)'}>
          {compiling ? (options.pdf === 'github' ? 'Compiling on GitHub…' : 'Compiling…') : options.pdf === 'github' ? 'Compile on GitHub' : 'Recompile'}
        </button>
        {options.layout === 'tabs' ? (
          <span className="segmented sm">
            <button type="button" aria-pressed={pane === 'source'} onClick={() => setPane('source')}>Source</button>
            <button type="button" aria-pressed={pane === 'pdf'} onClick={() => setPane('pdf')}>PDF</button>
          </span>
        ) : null}
      </div>
      {options.pdf === 'github' ? (
        <GithubCompilePanel
          token={settings.githubToken.trim()}
          repo={settings.latexRepo}
          state={gh}
          onRepo={(repo) => updateSettings({ latexRepo: repo })}
          onCompile={recompile}
        />
      ) : null}
      {noTex && options.pdf === 'here' ? (
        <div className="wr-pad">
          <p>There’s no TeX on this computer to compile with.</p>
          {canOwnTex ? <OwnTex server={server} status={engines?.texlive} onStatus={setOwnTex} onReady={() => void paperEngines(server).then(setEngines).then(() => compile())} /> : null}
          {engines?.tectonicInstallable ? (
            <button
              type="button"
              className="btn primary sm"
              disabled={installing}
              onClick={async () => {
                setInstalling(true);
                try {
                  await installTectonic(server);
                  setEngines(await paperEngines(server));
                  void compile();
                } catch (error) {
                  setCompileError(error instanceof Error ? error.message : String(error));
                } finally {
                  setInstalling(false);
                }
              }}
            >
              {installing ? 'Fetching Tectonic…' : 'Fetch Tectonic (about 30 MB)'}
            </button>
          ) : null}
          <p className="wr-quiet">Or install TeX Live (Linux, Windows) or MacTeX (Mac), and compile again.</p>
        </div>
      ) : null}
      {compileError ? <p className="wr-banner">{compileError}</p> : null}
      {compiled && !compiled.pdf && !compiled.errors.length && !compiling ? (
        <div className="wr-banner">
          <b>No PDF came out, and TeX reported no error.</b>{' '}
          {isNewer('0.11.1', here.version) ? (
            <>
              This Companion skips a file that failed until the file changes. Update it, and it compiles every time — and can install TeX Live and missing packages for you:{' '}
              <UpdateCompanion server={server} version={here.version} />
            </>
          ) : (
            'Check the main document above is the file with \\documentclass, and see what the compiler said:'
          )}
          {compiled.log.trim() ? (
            <details className="wr-raw">
              <summary>What the compiler said</summary>
              <pre>{compiled.log.trim().split('\n').slice(-40).join('\n')}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
      {missing.length && !showLog ? (
        <p className="wr-banner">
          <b>{missing.map((name) => `${name}.sty`).join(', ')}</b> isn’t on this computer.{' '}
          <button type="button" className="link-btn" onClick={() => setShowLog(true)}>
            How to fix it
          </button>
        </p>
      ) : null}
      {compiled && compiled.compiler && compiled.compiler !== compiler ? (
        <p className="wr-banner is-soft">Compiled with Tectonic, which is always XeLaTeX, not this project’s {TEX_COMPILERS.find((item) => item.id === compiler)?.label}: install TeX Live (or MacTeX) for the PDF Overleaf makes.</p>
      ) : null}
      <PdfPages blob={pdf} />
    </section>
  );

  const preview =
    options.pdf === 'overleaf' ? (
      <section className="wr-preview is-overleaf">
        <div className="wr-tabs">
          <b>PDF</b>
          {pdfWhere}
          <span className="wr-sp" />
          {options.layout === 'tabs' ? (
            <span className="segmented sm">
              <button type="button" aria-pressed={pane === 'source'} onClick={() => setPane('source')}>Source</button>
              <button type="button" aria-pressed={pane === 'pdf'} onClick={() => setPane('pdf')}>PDF</button>
            </span>
          ) : null}
        </div>
        <div className="wr-overleaf-pane">
          <h3>Overleaf makes the PDF</h3>
          <p>
            {git
              ? 'Your edits go to Overleaf a moment after you stop typing, and Overleaf compiles them with all of TeX Live — nothing to install here. The PDF is in Overleaf’s window: open it beside this one.'
              : 'This folder isn’t synced with Overleaf’s Git, so Overleaf won’t see these edits by itself: copy them there, or set the folder up with Overleaf’s Git (Change, under the files).'}
          </p>
          <div className="wr-row">
            <OpenOverleaf project={project} view="beside" />
            {git ? (
              <button type="button" className="btn sm" disabled={syncing} onClick={() => void saveNow().then(() => sync())}>
                {syncing ? 'Sending…' : 'Send now'}
              </button>
            ) : null}
          </div>
          {git ? (
            <p className="wr-quiet">
              {syncing
                ? 'Sending your edits to Overleaf…'
                : dirtyCount
                  ? 'Typing… your edits go to Overleaf when you pause.'
                  : synced?.at
                    ? `Overleaf has everything up to ${new Date(synced.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}.`
                    : 'Not sent yet.'}
              {syncError ? <span className="wr-bad"> {syncError}</span> : null}
            </p>
          ) : null}
          <p className="wr-quiet">⌘↵ here sends your edits and opens the project in the window beside once they’ve arrived — Overleaf compiles it as it opens. If Overleaf’s PDF doesn’t refresh after an edit comes in, press Recompile there. To compile on this computer or with GitHub Actions instead, pick it under Compile on, above.</p>
        </div>
      </section>
    ) : (
      local
    );

  const layoutClass = big ? ` is-tabs show-${big}` : options.layout === 'stacked' ? ' is-stacked' : options.layout === 'tabs' ? ` is-tabs show-${pane}` : '';
  const split = options.layout !== 'tabs' && !big;
  const stacked = options.layout === 'stacked';
  return (
    <div className={`wr-desk${desk.sideOpen ? '' : ' no-side'}`} style={{ ['--wr-side' as string]: `${desk.side}px`, ['--wr-log' as string]: `${desk.log}px` }}>
      {desk.sideOpen ? (
      <aside className="wr-side">
        <Handle axis="x" className="wr-handle-side" onDrag={(dx) => setDesk((now) => ({ side: clamp(now.side + dx, 160, 520) }))} onReset={() => setDesk({ side: DESK.side })} label="Drag to widen or narrow the files" />
        <div className="wr-side-head">
          <b>Files</b>
          <span className="wr-file-ops">
            <button type="button" onClick={newFile} title="New file" aria-label="New file">+ file</button>
            <button type="button" onClick={newFolder} title="New folder" aria-label="New folder">+ folder</button>
            <button type="button" onClick={() => uploader.current?.click()} title="Upload files: figures, a .bib, a style" aria-label="Upload">upload</button>
            <button type="button" onClick={() => void refreshList()} title="Read the folder again" aria-label="Read the folder again">↻</button>
          </span>
          <input
            ref={uploader}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files) upload(event.target.files);
              event.target.value = '';
            }}
          />
        </div>
        {fileProblem ? <p className="wr-bad wr-pad">{fileProblem}</p> : null}
        <div className="wr-tree">
          {listError ? <p className="wr-bad wr-pad">{listError}</p> : null}
          {(paths ?? []).map((path) => (
            <div key={path} className={`wr-tree-row${path === shown ? ' is-on' : ''}`}>
              <button
                type="button"
                className={`wr-tree-item${path === shown ? ' is-on' : ''}${isTextFile(path) ? '' : ' is-other'}`}
                disabled={!isTextFile(path)}
                onClick={() => setOpen(path)}
                title={path}
              >
                {path.includes('/') ? <span className="wr-tree-dir">{path.slice(0, path.lastIndexOf('/') + 1)}</span> : null}
                {path.split('/').pop()}
                {files[path] && files[path].text !== files[path].disk ? <i> ●</i> : null}
                {path === (mainDoc ?? compiled?.main) ? <small> main</small> : null}
              </button>
              <span className="wr-tree-ops">
                <button type="button" onClick={() => rename(path)} aria-label={`Rename ${path}`} title="Rename or move">✎</button>
                <button type="button" onClick={() => remove(path)} aria-label={`Delete ${path}`} title="Delete">×</button>
              </span>
            </div>
          ))}
        </div>
        {options.citations === 'drawer' ? (
          <div className={`wr-drawer${drawer ? ' is-open' : ''}`}>
            <button type="button" className="wr-side-head wr-drawer-head" aria-expanded={drawer} onClick={() => setDrawer(!drawer)}>
              <b>Cite · {mine.length}</b>
              <span>{drawer ? '▾' : '▸'}</span>
            </button>
            {drawer ? (
              <div className="wr-cites">
                {mine.map((paper) => (
                  <button key={paper.id} type="button" className="wr-cite" onMouseDown={(event) => event.preventDefault()} onClick={() => cite(paper.id)} title={`\\cite{${keyFor(paper, entries)}} at the cursor${bibPath ? `, its entry added to ${bibPath} if missing` : ''}`}>
                    <span>{paper.title}</span>
                    <small className="mono">{keyFor(paper, entries)}</small>
                  </button>
                ))}
                {!mine.length ? <p className="wr-quiet wr-pad">The project has no papers yet.</p> : null}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="wr-side-switch">
          <SwitchOverleaf project={project} />
        </div>
        <div className="wr-side-foot">
          <span className="wr-quiet mono" title={folder.path}>
            {here.name} · {folder.path}
          </span>
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              if (window.confirm('Use another folder for the paper on this computer? This folder stays as it is.')) save(here.id, undefined);
            }}
          >
            Change
          </button>
        </div>
      </aside>
      ) : null}
      <div
        ref={panesRef}
        className={`wr-panes${layoutClass}${desk.swapped ? ' is-swapped' : ''}`}
        style={split ? { [stacked ? 'gridTemplateRows' : 'gridTemplateColumns']: `minmax(0, ${desk.split}fr) minmax(0, ${1 - desk.split}fr)` } : undefined}
      >
        {source}
        {preview}
        {split ? (
          <Handle
            axis={stacked ? 'y' : 'x'}
            className="wr-handle-split"
            style={stacked ? { top: `${desk.split * 100}%` } : { left: `${desk.split * 100}%` }}
            onDrag={(delta) => {
              const box = panesRef.current?.getBoundingClientRect();
              if (!box) return;
              setDesk((now) => ({ split: clamp(now.split + delta / (stacked ? box.height : box.width), 0.15, 0.85) }));
            }}
            onReset={() => setDesk({ split: 0.5 })}
            label="Drag to share the room between the source and the PDF"
          />
        ) : null}
      </div>
      {showLog && compiled ? (
        <div className="wr-log">
          <Handle axis="y" className="wr-handle-log" onDrag={(dy) => setDesk((now) => ({ log: clamp(now.log - dy, 90, 640) }))} onReset={() => setDesk({ log: DESK.log })} label="Drag to make the problems taller or shorter" />
          <div className="wr-tabs">
            <b>{compiled.errors.length} errors · {compiled.warnings.length} warnings</b>
            <span className="wr-sp" />
            <button type="button" className="link-btn" onClick={() => setShowLog(false)}>
              Close
            </button>
          </div>
          <div className="wr-log-body">
            {[...compiled.errors.map((item) => ({ ...item, kind: 'error' })), ...compiled.warnings.map((item) => ({ ...item, kind: 'warning' }))].map((item, index) => (
              <button key={index} type="button" className={`wr-problem is-${item.kind}`} onClick={() => goTo(item)}>
                <b>{item.kind === 'error' ? 'Error' : 'Warning'}</b>
                <span>{item.message}</span>
                <small className="mono">{item.file || compiled.main}{item.line ? `:${item.line}` : ''}</small>
              </button>
            ))}
            {!compiled.errors.length && !compiled.warnings.length ? <p className="wr-quiet wr-pad">Nothing to say.</p> : null}
            {missing.length ? (
              <MissingPackages
                names={missing}
                texLive={texLive}
                tectonic={Boolean(engines?.tectonic || engines?.tectonicInstallable)}
                onTectonic={() => updateSettings({ write: { ...WRITE_DEFAULTS, ...(settings.write ?? {}), engine: 'tectonic' } })}
                first={
                  !canOwnTex ? (
                    <p className="wr-quiet">
                      Update the Companion and Reader can install TeX Live — and any missing package — for you, without a password: <UpdateCompanion server={server} version={here.version} />
                    </p>
                  ) : engines?.texlive?.installed ? (
                    <InstallMissing server={server} names={missing} onDone={() => void compile()} />
                  ) : (
                    <OwnTex server={server} status={engines?.texlive} onStatus={setOwnTex} onReady={() => void paperEngines(server).then(setEngines).then(() => compile())} />
                  )
                }
              />
            ) : null}
            <details className="wr-raw">
              <summary>The whole log</summary>
              <pre>{compiled.log}</pre>
            </details>
          </div>
        </div>
      ) : null}
      <footer className="wr-status">
        {git ? (
          <>
            <span className={`wr-dot is-${syncError ? 'bad' : syncing ? 'busy' : synced?.ok ? 'ok' : 'idle'}`} />
            <span>
              {syncing ? 'Syncing with Overleaf…' : syncError ? 'Not synced' : synced?.at ? `Synced with ${/github/.test(project.project.overleaf?.repo ?? '') && !overleafGitUrl(project.project.overleaf?.url) ? 'GitHub' : 'Overleaf'} · ${new Date(synced.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Git · not synced yet'}
            </span>
            <button type="button" className="link-btn" disabled={syncing} onClick={() => void saveNow().then(() => sync())}>
              Sync
            </button>
          </>
        ) : (
          <span>{folder.sync === 'dropbox' ? 'Dropbox keeps this folder in step with Overleaf' : 'Not synced: a folder on this computer'}</span>
        )}
        <span className="wr-sep">·</span>
        <span>{saving > 0 ? 'Saving…' : dirtyCount ? `${dirtyCount} not saved` : 'Saved'}</span>
        <span className="wr-sep">·</span>
        {compiled ? (
          <button type="button" className={`link-btn wr-counts${compiled.errors.length ? ' is-bad' : ''}`} onClick={() => setShowLog(!showLog)}>
            {compiled.errors.length} errors · {compiled.warnings.length} warnings
          </button>
        ) : (
          <span>{options.pdf === 'overleaf' ? 'Overleaf compiles it' : compiling ? 'Compiling…' : 'Not compiled yet'}</span>
        )}
        <span className="wr-sp" />
        <button type="button" className="link-btn" aria-expanded={texShown} onClick={() => setTexShown(!texShown)} title="The TeX that compiles the paper: Reader can install TeX Live for you">
          TeX
        </button>
        {git ? (
          <button type="button" className="link-btn" aria-expanded={tokenShown} onClick={() => setTokenShown(!tokenShown)} title="The Overleaf Git token on this computer: where it is, and how to remove it">
            Overleaf token
          </button>
        ) : null}
        <OpenOverleaf project={project} view="beside" primary={false} compact />
      </footer>
      {texShown ? (
        <div className="wr-sync-banner">
          <span className="wr-quiet">{engines?.texVersion ? `Compiling with ${engines.texVersion}.` : 'No TeX found yet.'}</span>
          {canOwnTex ? (
            <OwnTex server={server} status={engines?.texlive} onStatus={setOwnTex} onReady={() => void paperEngines(server).then(setEngines).then(() => compile())} />
          ) : (
            <span>
              Update the Companion ({here.version}) and Reader can install TeX Live for you: <UpdateCompanion server={server} version={here.version} />
            </span>
          )}
        </div>
      ) : null}
      {tokenShown ? (
        <div className="wr-sync-banner">
          <ForgetToken server={server} open onForgotten={() => setNeedToken(true)} />
        </div>
      ) : null}
      {syncError || needToken || (synced?.conflicts.length ?? 0) > 0 ? (
        <div className="wr-sync-banner">
          {synced?.conflicts.length ? (
            <span>
              <b>Overleaf changed the same lines.</b> Look for <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code> in {synced.conflicts.map((path) => (
                <button key={path} type="button" className="link-btn" onClick={() => setOpen(path)}>
                  {path}
                </button>
              ))}
              , keep what should stay, and sync again.
            </span>
          ) : needToken ? (
            <span>The Companion has no token for this folder’s remote yet.</span>
          ) : (
            <span>{syncError}</span>
          )}
          {needToken || /auth|token|403|401|denied/i.test(syncError ?? '') ? (
            <span className="wr-token">
              <input type="password" placeholder="Overleaf Git token" value={token} onChange={(event) => setToken(event.target.value)} />
              <button type="button" className="btn sm primary" disabled={!token.trim()} onClick={() => void sync()}>
                Use it
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- pdf --

/** The compiled PDF, every page drawn at the pane's width; where you were stays put across compiles. */
function PdfPages({ blob }: { blob: Blob | null }) {
  const box = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(Math.round(element.clientWidth)));
    observer.observe(element);
    setWidth(Math.round(element.clientWidth));
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!blob || !width || !pagesRef.current) return;
    let cancelled = false;
    let close: (() => void) | null = null;
    const scroller = box.current;
    const ratio = scroller && scroller.scrollHeight > scroller.clientHeight ? scroller.scrollTop / scroller.scrollHeight : 0;
    void (async () => {
      try {
        const opened = await openPdf(blob);
        close = opened.close;
        const canvases: HTMLCanvasElement[] = [];
        const scale = window.devicePixelRatio || 1;
        for (let n = 1; n <= opened.doc.numPages; n += 1) {
          const page = await opened.doc.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const fit = Math.max(0.2, (width - 32) / base.width);
          const viewport = page.getViewport({ scale: fit * scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = `${Math.floor(viewport.width / scale)}px`;
          canvas.style.height = `${Math.floor(viewport.height / scale)}px`;
          canvas.className = 'wr-page';
          await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
          if (cancelled) return;
          canvases.push(canvas);
        }
        if (cancelled || !pagesRef.current) return;
        // Swapped in whole, so the pane never shows half a PDF; the place you were in is kept.
        pagesRef.current.replaceChildren(...canvases);
        if (scroller) scroller.scrollTop = ratio * scroller.scrollHeight;
        setProblem(null);
      } catch (error) {
        if (!cancelled) setProblem(error instanceof Error ? error.message : String(error));
      } finally {
        close?.();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blob, width]);
  return (
    <div className="wr-pdf" ref={box}>
      {problem ? <p className="wr-bad wr-pad">The PDF couldn’t be drawn: {problem}</p> : null}
      {!blob ? <p className="wr-quiet wr-pad">The PDF shows here once it compiles.</p> : null}
      <div className="wr-pdf-pages" ref={pagesRef} />
    </div>
  );
}
