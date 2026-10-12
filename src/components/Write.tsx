// The Write tab: a project's paper, the whole page an editor — its files, the
// LaTeX, and the PDF it makes — as Overleaf is. By default the paper is kept
// in Google Drive, in the project's folder there, nothing of it on the
// computer: edited in the browser, compiled on Cloud Run, kept in step with
// Overleaf by Reader's server. A project linked to Overleaf can be kept on the
// computers instead (Keep on this computer): a clone of it in a folder under
// the Companion's, compiled there or on Cloud Run, synced by its Git. When it
// compiles, how it is laid out, when it syncs and the citations drawer are
// Settings → Projects → The Write tab (types.ts, `WRITE_OPTIONS`).

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../lib/store';
import { COMPANION_VERSION, PAPER_TEMPLATES_VERSION, PAPER_VERSION, REVEAL_VERSION, TEXLIVE_VERSION, revealPaper, TEX_COMPILERS, applyTemplate, chooseFolder, clonePaper, linkFolder, listTemplates, saveTemplate, tokenKnown, updateCompanion, waitForVersion, cancelTexLive, installPackages, installTexLive, removeTexLive, texLiveStatus, type TexLiveStatus, compilePaper, forgetOverleafToken, installTectonic, isNewer, paperEngines, paperRemote, syncPaper, type Compiled, type PaperEngines, type PaperTemplate, type Synced, type TexCompiler, type TexProblem } from '../lib/companion';
import { besideFeatures, bibEntries, isBuildFile, isTextFile, keyFor, latexLinkAt, latexOwner, latexSeparate, openInOverleaf, overleafGitUrl, withLatexLink, paperFolderFor, parseOverleafUrl, switchedLink, withEntry } from '../lib/overleaf';
import { complete as completeLatex } from '../lib/latexComplete';
import { openPdf } from '../lib/pdfReflow';
import { papersIn, projectsOf, type Project } from '../lib/projects';
import { thisComputer, type ThisComputer } from '../lib/thisComputer';
import type { LatexLink, OverleafLink, PaperFolder, WriteOptions } from '../types';
import { WRITE_DEFAULTS } from '../types';
import type { View } from '../types.view';
import CodeEditor, { type CodeEditorHandle } from './CodeEditor';
import CopyBlock from './CopyBlock';
import { OpenOverleaf } from './Overleaf';
import { readTexLog, type CompileFile } from '../lib/latexGithub';
import { apiFetch } from '../lib/api';
import { cloudSync, overleafTokenKnown } from '../lib/overleafCloud';
import { companionStore, driveShelf, driveStore, subStore, paperDriveFolder, paperDriveNow, setPaperDrive, unpackKit, type PaperStore, type ShelfTemplate, type TemplateShelf } from '../lib/paperStore';
import { findLostFolder, inDrive, movePaperToDrive, removeFolder } from '../lib/paperMove';
import { CompanionConnect } from './Playground';
import OverleafAccounts, { useOverleafAccounts } from './OverleafAccounts';
import { WriteGuideLink } from './WriteGuide';
import CompareOverleaf from './WriteCompare';
import type { ZipEntry } from '../lib/zip';

type Here = Extract<ThisComputer, { server: unknown }>;


/**
 * The tab, for a project: its paper, kept in Google Drive — nothing on any
 * computer — unless the project is kept on the computers (LocalWrite). A
 * paper not in Drive yet is brought there first (ToDrive).
 */
export default function WritePage({ project, onView }: { project: Project; onView: (view: View) => void }) {
  const { settings, driveConnected } = useStore();
  const clientId = settings.googleClientId.trim();
  setPaperDrive(driveConnected && clientId ? { clientId, folderName: settings.driveFolderName } : null);
  const link = project.project.overleaf;
  if (link?.keep?.where === 'computer') return <LocalWrite project={project} onView={onView} />;
  if (link?.drive?.folder) return <DriveWrite project={project} folder={link.drive.folder} />;
  // Nothing yet: no Overleaf project, no folder on any computer — started here, one way or the other.
  if (!overleafGitUrl(link?.url) && !Object.keys(link?.folders ?? {}).length) return <WriteStart project={project} />;
  return <ToDrive project={project} />;
}

/**
 * A project with no paper yet: started from one of the person's Overleaf
 * projects (the account connected once, the project picked), or without
 * Overleaf — a new paper in the project's Drive folder, to put on Overleaf
 * later if ever.
 */
function WriteStart({ project }: { project: Project }) {
  const { driveConnected, connectDrive, settings, updateCollection } = useStore();
  const setLink = useSetLink(project);
  const signedIn = driveConnected && Boolean(settings.googleClientId.trim());
  const [way, setWay] = useState<'overleaf' | 'blank' | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const folder = paperDriveFolder(project.name, project.id);
  // The picked Overleaf project into the project's Drive folder, by Reader's server with whichever account opens it.
  const bring = async (url: string) => {
    const gitUrl = overleafGitUrl(url);
    if (!gitUrl) throw new Error('That isn’t an Overleaf project’s address.');
    const done = await cloudSync(driveStore(paperDriveNow, folder), gitUrl, 'From Reader');
    if (!done.ok) throw Object.assign(new Error(done.error ?? 'It didn’t come in.'), { needToken: Boolean(done.needToken) });
    await setLink({ url, drive: { folder }, ...(done.account ? { gitAccount: done.account } : {}) });
  };
  const blank = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await driveStore(paperDriveNow, folder).mkdir('');
      await updateCollection(project.id, (collection) => {
        const info = { ...project.project, ...(collection.project ?? {}) };
        return { project: { ...info, overleaf: inDrive(info.overleaf, folder, undefined) } };
      });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="wr-scroll">
      <div className="wr-card wr-setup">
        <span className="eyebrow">The paper</span>
        <h2>Start this project’s paper</h2>
        <p>
          Its LaTeX is kept in your Google Drive, in <span className="mono">{folder}</span> — nothing on this computer — written here in the browser and compiled on Cloud Run.{' '}
          <WriteGuideLink section="begin">Which should I pick?</WriteGuideLink>
        </p>
        {!signedIn ? (
          <div className="wr-row">
            <button type="button" className="btn primary" onClick={() => void connectDrive()}>
              Sign in with Google, with Drive
            </button>
            <span className="wr-quiet">Needed either way: Drive is where the paper is kept.</span>
          </div>
        ) : null}
        <div className="wr-ways" role="radiogroup" aria-label="How to start the paper">
          <button type="button" role="radio" aria-checked={way === 'overleaf'} className={`wr-way${way === 'overleaf' ? ' is-on' : ''}`} onClick={() => setWay('overleaf')} disabled={!signedIn}>
            <b>From your Overleaf account</b>
            <span>Connect your Overleaf account once, then pick one of its projects. It comes into Drive and stays in step with Overleaf both ways, so coauthors can keep writing there.</span>
          </button>
          <button type="button" role="radio" aria-checked={way === 'blank'} className={`wr-way${way === 'blank' ? ' is-on' : ''}`} onClick={() => setWay('blank')} disabled={!signedIn}>
            <b>Start without Overleaf</b>
            <span>A new LaTeX paper in your Drive: a blank article, a conference template, or files you upload. You can put it on Overleaf later.</span>
          </button>
        </div>
        {way === 'overleaf' && signedIn ? <OverleafPicker project={project} mode="bring" onPicked={(url) => bring(url)} /> : null}
        {way === 'blank' && signedIn ? (
          <div className="wr-row">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void blank()}>
              {busy ? 'Making its folder…' : 'Start the paper'}
            </button>
            <span className="wr-quiet">Then pick how its first LaTeX project begins.</span>
          </div>
        ) : null}
        {problem ? <p className="wr-bad">{problem}</p> : null}
      </div>
    </div>
  );
}

/**
 * A LaTeX project in Drive put into an Overleaf project — made for it from
 * here, or one made in Overleaf — and kept in step from then on. `dir` is its
 * folder ('' the top, the project's own link); a folder gets a link of its
 * own, and the other LaTeX projects inside it stay out.
 */
function PutOnOverleaf({ project, store, dir = '', main, onDone }: { project: Project; store: PaperStore; dir?: string; main?: string; onDone?: () => void }) {
  const { updateCollection } = useStore();
  const link = project.project.overleaf;
  const own = subStore(store, dir);
  const exclude = latexSeparate(link, dir);
  const outside = (path: string) => exclude.some((other) => path === other || path.startsWith(`${other}/`));
  const keep = (change: Partial<LatexLink>) =>
    updateCollection(project.id, (collection) => {
      const info = { ...project.project, ...(collection.project ?? {}) };
      return info.overleaf ? { project: { ...info, overleaf: withLatexLink(info.overleaf, dir, change) } } : {};
    });
  // A new Overleaf project made with the paper in it: Overleaf's /docs, in the account signed in in this browser.
  // (Overleaf's Git can't make a project, and no other site may read its address: it is copied back from the tab.)
  const make = async () => {
    const name = `reader-overleaf-${Date.now()}`;
    const tab = window.open('about:blank', name);
    try {
      const files: ZipEntry[] = [];
      for (const path of (await listAll(own)).filter((path) => !outside(path))) files.push({ path, content: Uint8Array.from(atob(await own.readBase64(path)), (char) => char.charCodeAt(0)) });
      if (!files.length) throw new Error('This LaTeX project has no files yet: write its main document, then put it on Overleaf.');
      openInOverleaf(files, { main: main || latexLinkAt(link, dir).main || 'main.tex', target: tab ? name : '_blank' });
    } catch (error) {
      tab?.close();
      throw error;
    }
  };
  return (
    <OverleafPicker
      project={project}
      onMake={make}
      mode="push"
      onPicked={async (url) => {
        const gitUrl = overleafGitUrl(url);
        if (!gitUrl) throw new Error('That isn’t an Overleaf project’s address.');
        const done = await cloudSync(own, gitUrl, 'The paper, from Reader', undefined, { firstPushes: true, exclude });
        if (!done.ok) throw Object.assign(new Error(done.error ?? 'The paper didn’t go to Overleaf.'), { needToken: Boolean(done.needToken) });
        await keep({ url, ...(done.account ? { gitAccount: done.account } : {}), ...(main ? { main } : {}) });
        onDone?.();
      }}
    />
  );
}

/**
 * One of the person's Overleaf projects, picked: the account connected first
 * (its Git token, kept sealed by Reader's server for all of its projects).
 * Overleaf lets no other app list an account's projects, so the ones offered
 * are those Reader knows — linked to this account's other projects — and any
 * other is picked by its address, copied from Overleaf's project list.
 * `bring`: the project is to come into Drive. `push`: a paper in Drive is to
 * go into it (a Blank Project made in Overleaf for it).
 */
function OverleafPicker({ project, mode, onPicked, onMake }: { project: Project; mode: 'bring' | 'push'; onPicked: (url: string) => Promise<unknown>; /** push: a new Overleaf project made with the paper in it, in a new tab. */ onMake?: () => Promise<void> }) {
  const { collections } = useStore();
  const accounts = useOverleafAccounts();
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [needAccount, setNeedAccount] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const [made, setMade] = useState(false);
  const offered = useMemo(() => {
    const seen = new Map<string, { url: string; label: string }>();
    for (const other of projectsOf(collections)) {
      const link = other.project.overleaf;
      const url = link?.url ? parseOverleafUrl(link.url) : null;
      if (url && other.id !== project.id && !seen.has(url)) seen.set(url, { url, label: other.name });
      for (const before of Object.keys(link?.earlier ?? {})) if (!seen.has(before) && other.id !== project.id) seen.set(before, { url: before, label: `${other.name}, before` });
    }
    return [...seen.values()];
  }, [collections, project.id]);
  const pick = async (url: string) => {
    setBusy(true);
    setProblem(null);
    setNeedAccount(null);
    setLast(url);
    try {
      await onPicked(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // No connected account opens it: the one it is in connected, and tried again.
      if ((error as { needToken?: boolean }).needToken) setNeedAccount(message);
      else setProblem(message);
    } finally {
      setBusy(false);
    }
  };
  const pasted = parseOverleafUrl(address);
  if (accounts === null) return <p className="wr-quiet">Asking Reader’s server about your Overleaf accounts…</p>;
  if (!accounts.length || needAccount)
    return (
      <div className="wr-form">
        <OverleafAccounts open={Boolean(needAccount)} accountLabel={project.project.overleaf?.account} why={needAccount ?? undefined} onConnected={() => (needAccount && last ? void pick(last) : undefined)} />
      </div>
    );
  return (
    <div className="wr-form wr-ol-pick">
      <details className="ol-connected">
        <summary>
          Overleaf: {accounts.map((account) => account.label).join(', ')} <span className="wr-quiet">· accounts</span>
        </summary>
        <OverleafAccounts />
      </details>
      {mode === 'push' && onMake ? (
        <div className="wr-ol-make">
          <p>
            <b>1.</b> Reader makes a new Overleaf project with this paper in it, in the Overleaf account signed in in this browser. Overleaf’s Git can’t make projects, so this opens Overleaf in a new tab.
          </p>
          <div className="wr-row">
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => {
                setProblem(null);
                void onMake().then(() => setMade(true), (error) => setProblem(error instanceof Error ? error.message : String(error)));
              }}
            >
              {made ? 'Make another' : 'Make it on Overleaf'}
            </button>
          </div>
          <p>
            <b>2.</b> {made ? 'In the tab that opened, ' : 'Then, in that tab, '}copy the project’s address from the browser and paste it below: Overleaf lets no other site read it. From then on the paper stays in step with Overleaf.
          </p>
        </div>
      ) : mode === 'push' ? (
        <p>
          In Overleaf, make a <b>Blank Project</b> for this paper (New Project → Blank Project), copy its address, and paste it here: this paper’s files go into it, and from then on it stays in step with Overleaf.
        </p>
      ) : offered.length ? (
        <>
          <span className="wr-field-label">Your Overleaf projects Reader knows</span>
          <div className="wr-ol-list" role="list">
            {offered.map((item) => (
              <button key={item.url} type="button" role="listitem" className="wr-ol-item" disabled={busy} onClick={() => void pick(item.url)}>
                <b>{item.label}</b>
                <small className="mono">{item.url.replace('https://www.', '')}</small>
              </button>
            ))}
          </div>
        </>
      ) : null}
      <label className="wr-field">
        <span>{mode === 'push' || !offered.length ? 'The Overleaf project’s address' : 'Or another of your projects: its address'}</span>
        <input value={address} placeholder="https://www.overleaf.com/project/…" onChange={(event) => setAddress(event.target.value)} aria-label="The Overleaf project’s address" />
        <small>
          Overleaf doesn’t let other apps list your projects: open{' '}
          <a href="https://www.overleaf.com/project" target="_blank" rel="noopener noreferrer">
            your Overleaf projects ↗
          </a>
          , open the one you want, and copy the address from the browser.
        </small>
      </label>
      <div className="wr-row">
        <button type="button" className="btn primary" disabled={busy || !pasted} onClick={() => pasted && void pick(pasted)}>
          {busy ? (mode === 'push' ? 'Sending the paper to Overleaf…' : 'Bringing it in…') : mode === 'push' ? 'Put the paper in this project' : 'Use this project'}
        </button>
        {address.trim() && !pasted ? <span className="wr-bad">That isn’t an Overleaf project’s address (overleaf.com/project/…).</span> : null}
      </div>
      {problem ? <p className="wr-bad">{problem}</p> : null}
    </div>
  );
}

/**
 * Where the project's paper is kept, and the way to the other place: from
 * Drive to the computers (what is in Drive goes to Overleaf first, then each
 * computer clones it), or back to Drive (this computer's clone goes to
 * Overleaf first, then the folder is removed from the computer). Only with an
 * Overleaf project: it is what carries the paper between the two.
 */
function KeepWhere({ project, here, folder, store }: { project: Project; here?: Here; folder?: PaperFolder; store?: PaperStore }) {
  const setLink = useSetLink(project);
  const save = useSaveFolder(project);
  const link = project.project.overleaf;
  const gitUrl = overleafGitUrl(link?.url);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const onComputer = link?.keep?.where === 'computer';
  if (!gitUrl && !onComputer) return null;
  const keep = (where: 'drive' | 'computer') => setLink({ keep: { where, at: new Date().toISOString() } });
  const toComputer = async () => {
    if (!window.confirm('Keep this paper on your computers instead of Google Drive? What is in Drive goes to Overleaf first; then each computer keeps a clone of the Overleaf project, set up once on each.')) return;
    setBusy(true);
    setProblem(null);
    try {
      if (store?.kind === 'drive' && gitUrl) {
        const done = await cloudSync(store, gitUrl, 'Edits from Reader, before the paper moved to a computer');
        if (!done.ok) throw new Error(done.needToken ? 'Your Overleaf Git token is needed to send what is in Drive to Overleaf first: give it under the files, then try again.' : done.error ?? 'What is in Drive couldn’t be sent to Overleaf first.');
      }
      await keep('computer');
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const toDrive = async () => {
    if (!window.confirm('Keep this paper in Google Drive instead? The folder on this computer is sent to Overleaf, brought into Drive, then removed from this computer.')) return;
    setBusy(true);
    setProblem(null);
    try {
      // Already in Drive from before: this computer's edits go to Overleaf, which Drive syncs from; the folder then goes.
      if (link?.drive?.folder && here && folder) {
        if (folder.sync === 'git') {
          const sent = await syncPaper(here.server, folder.path, 'Edits from Reader, before the paper moved to Drive');
          if (!sent.ok) throw new Error(`The folder on this computer couldn’t be synced with Overleaf first: ${sent.error ?? 'it didn’t finish'}.`);
        }
        if (folder.sync !== 'dropbox' && /^papers\/[^/]+$/.test(folder.path)) await removeFolder(here.server, folder.path).catch((error) => console.warn(`Reader: ${folder.path} couldn’t be removed from this computer:`, error));
        save(here.id, undefined);
        // Drive brought up to date with it now, not only when a document is next opened.
        if (gitUrl && paperDriveNow()) await cloudSync(driveStore(paperDriveNow, link.drive.folder), gitUrl, 'From Reader').catch((error) => console.warn('Reader: Drive will catch up at the next sync:', error));
      }
      // Not in Drive yet: the tab brings it there, from this computer's folder (ToDrive).
      await keep('drive');
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="wr-keep">
      <button type="button" className="link-btn" disabled={busy} onClick={() => void (onComputer ? toDrive() : toComputer())} title={onComputer ? 'Keep the paper in your Google Drive, nothing of it on the computer (the default)' : 'Keep the paper in a folder on each of your computers instead: a clone of the Overleaf project'}>
        {busy ? 'Moving…' : onComputer ? 'Keep in Google Drive instead' : 'Keep on this computer instead'}
      </button>
      {problem ? <span className="wr-bad"> {problem}</span> : null}
    </span>
  );
}

/**
 * A project whose paper isn't in Drive yet, brought there as the tab opens,
 * asking only what it can't do without: a sign-in with Google; the paper's
 * folder on this computer moved (its clone synced to Overleaf first, by the
 * Companion), then deleted from the computer; with nothing here, the paper
 * brought in from Overleaf by Reader's server (its Git token, once); with no
 * Overleaf, an empty paper made in Drive, its documents to start there.
 */
function ToDrive({ project }: { project: Project }) {
  const { driveConnected, connectDrive, settings, updateCollection } = useStore();
  const link = project.project.overleaf;
  const gitUrl = overleafGitUrl(link?.url);
  const signedIn = driveConnected && Boolean(settings.googleClientId.trim());
  const [here, setHere] = useState<ThisComputer | null>(null);
  const [known, setKnown] = useState<boolean | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<'elsewhere' | 'token' | null>(null);
  const [again, setAgain] = useState(0);
  const started = useRef(false);
  useEffect(() => {
    void thisComputer(PAPER_VERSION, 'move the paper to Drive').then(setHere);
  }, []);
  useEffect(() => {
    if (signedIn && gitUrl) void overleafTokenKnown().then(setKnown, () => setKnown(false));
    else setKnown(false);
  }, [signedIn, gitUrl]);

  const move = async ({ token: given, force = false }: { token?: string; force?: boolean } = {}) => {
    setProblem(null);
    setBlocked(null);
    const companion = here && !('error' in here) ? { id: here.id, server: here.server } : null;
    try {
      const local = companion ? (link?.folders?.[companion.id] ?? (await findLostFolder(project, companion))) : null;
      // The paper's folder is on another computer (or this one, with the Companion not running): moved from there.
      if (!local && link?.folders && Object.keys(link.folders).length && !force) return setBlocked('elsewhere');
      // Nothing of it on a computer: from Overleaf, which takes Reader's server the Git token once.
      // (`force`: asked for now, an account just connected among them — Reader's server says if none opens it.)
      if (!local && gitUrl && !known && !given && !force) return setBlocked('token');
      if (!local && !gitUrl && link?.folders && Object.keys(link.folders).length) return setBlocked('elsewhere');
      setStep('Starting…');
      const folder = await movePaperToDrive(project, companion, { token: given, onStep: setStep, local: local ?? undefined });
      await updateCollection(project.id, (collection) => {
        const info = { ...project.project, ...(collection.project ?? {}) };
        return { project: { ...info, overleaf: inDrive(info.overleaf, folder, companion && local ? companion.id : undefined) } };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProblem(message);
      if ((error as { needToken?: boolean }).needToken) (setKnown(false), setBlocked('token'));
      // Overleaf down for a moment: tried again in a minute, nothing asked.
      if ((error as { transient?: boolean }).transient) window.setTimeout(() => setAgain((n) => n + 1), 60_000);
    } finally {
      setStep(null);
    }
  };
  useEffect(() => {
    if (!signedIn || here === null || (gitUrl && known === null)) return;
    if (started.current && !again) return;
    started.current = true;
    void move();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, here, known, again]);

  if (!signedIn)
    return (
      <div className="wr-center wr-start">
        <div className="wr-card">
          <span className="eyebrow">The paper</span>
          <h2>Kept in your Google Drive</h2>
          <p>Every project’s LaTeX lives in your Drive, in the project’s folder — nothing on this computer — and opens the same on any device you sign in on. Sign in with Google, with Drive, to open it.</p>
          <div className="wr-row">
            <button type="button" className="btn primary" onClick={() => void connectDrive()}>
              Sign in with Google, with Drive
            </button>
          </div>
          {gitUrl ? (
            <p className="wr-quiet">
              Or keep it on your computers, as a clone of the Overleaf project: <KeepWhere project={project} />
            </p>
          ) : null}
        </div>
      </div>
    );
  return (
    <div className="wr-center wr-start">
      <div className="wr-card">
        <span className="eyebrow">The paper</span>
        <h2>{blocked ? 'Bringing the paper into Google Drive' : 'Getting the paper ready in Google Drive'}</h2>
        <p>
          The project’s LaTeX is kept in your Drive, in <span className="mono">{paperDriveFolder(project.name, project.id)}</span> — nothing on this computer — written here in the browser, compiled on Cloud Run
          {gitUrl ? ', and kept in step with Overleaf by Reader’s server.' : '.'}{' '}
          <WriteGuideLink section="where">How this works</WriteGuideLink>
        </p>
        {step ? (
          <p className="wr-quiet">
            <span className="spinner" /> {step}
          </p>
        ) : null}
        {blocked === 'elsewhere' ? (
          <>
            <p>
              This project’s paper is in a folder on {here && !('error' in here) ? 'another computer' : 'a computer, and this one’s Companion isn’t running'}: open the Reader app there and it moves into Drive by itself — what was written there with it.
            </p>
            {gitUrl ? <p className="wr-quiet">Or bring it in from Overleaf now: anything written on that computer and not yet synced stays there.</p> : null}
          </>
        ) : null}
        {gitUrl && (blocked === 'token' || (blocked === 'elsewhere' && !known)) ? (
          // No connected Overleaf account opens it (or none is connected): the one it is in connected, then brought in.
          <OverleafAccounts open={Boolean(problem)} projectUrl={project.project.overleaf?.url} accountLabel={project.project.overleaf?.account} why={blocked === 'token' ? problem ?? undefined : undefined} onConnected={() => (setKnown(true), void move({ force: true }))} />
        ) : null}
        {blocked && gitUrl && known ? (
          <div className="wr-row">
            <button type="button" className="btn primary" disabled={Boolean(step)} onClick={() => void move({ force: true })}>
              Bring it in from Overleaf
            </button>
          </div>
        ) : null}
        {gitUrl ? (
          <p className="wr-quiet">
            Rather keep it on your computers, as a clone of the Overleaf project? <KeepWhere project={project} />
          </p>
        ) : null}
        {problem && blocked !== 'token' ? (
          <>
            <p className="wr-bad">{problem}</p>
            {!blocked ? (
              <div className="wr-row">
                <button type="button" className="btn" disabled={Boolean(step)} onClick={() => void move()}>
                  Try again
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}


/**
 * A paper kept on the computers: this computer's Companion, then the paper's
 * folder on it (a clone of the Overleaf project, set up once on each
 * computer), then its documents and the desk.
 */
function LocalWrite({ project, onView }: { project: Project; onView: (view: View) => void }) {
  const [here, setHere] = useState<ThisComputer | null>(null);
  // The project's LaTeX projects first, each time the tab opens; the desk once one is picked.
  const [scope, setScope] = useState<PaperScope | null>(null);
  const updateLink = useUpdateLink(project);
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
  const store = useMemo(() => (here && 'id' in here && folder ? companionStore(here.server, folder.path) : null), [here, folder]);
  const shelf = useMemo(() => (here && 'id' in here && folder ? companionShelf(here, folder.path) : null), [here, folder]);

  if (!here) return <div className="wr-center"><p className="wr-quiet">Looking for this computer’s Companion…</p></div>;
  if ('error' in here)
    return (
      <div className="wr-center wr-start">
        <div className="wr-card">
          <span className="eyebrow">The paper · on your computers</span>
          <h2>Write it on this computer</h2>
          <p>This project keeps its paper on your computers: a clone of the Overleaf project in a folder on each, compiled there and kept in step with Overleaf. That takes the Companion, connected once here; after that this tab finds it by itself.</p>
          {here.why === 'old' ? <p className="wr-bad">{here.error}</p> : null}
          <p className="wr-quiet">
            Or, with nothing on the computer: <KeepWhere project={project} />
          </p>
          {link?.url ? (
            <div className="wr-row">
              <OpenOverleaf project={project} view="beside" primary={false} />
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
  if (!folder || !store) return <LocalSetUp project={project} here={here} />;
  if (!scope)
    return (
      <WriteHome
        project={project}
        here={here}
        folder={folder}
        store={store}
        shelf={shelf}
        onOpen={(main, opened) => {
          if (main !== link?.main) updateLink({ main });
          setScope(opened);
        }}
      />
    );
  return <WriteDesk key={`${here.id}:${folder.path}:${scope.dir}`} project={project} here={here} folder={folder} store={store} scope={scope} onHome={() => setScope(null)} />;
}

/** The Companion's own templates, for a paper kept on this computer. */
function companionShelf(here: Here, folder: string): TemplateShelf {
  const within = (dir: string, path: string) => (dir ? `${dir}/${path}` : path);
  return {
    list: () => listTemplates(here.server),
    save: (name, zip) => saveTemplate(here.server, name, zip),
    apply: async (slug, dir) => {
      const done = await applyTemplate(here.server, slug, dir ? `${folder}/${dir}` : folder);
      return within(dir, done.main || 'main.tex');
    },
  };
}

/** The paper's folder on this computer, the first time here: a clone of the Overleaf project, or Overleaf's Dropbox folder. */
function LocalSetUp({ project, here }: { project: Project; here: Here }) {
  const link = project.project.overleaf;
  const save = useSaveFolder(project);
  const gitUrl = overleafGitUrl(link?.url);
  const [way, setWay] = useState<'git' | 'dropbox'>(gitUrl ? 'git' : 'dropbox');
  const [token, setToken] = useState('');
  // An Overleaf Git token is the account's: once given on this computer, every project of it uses it.
  const [known, setKnown] = useState<boolean | null>(null);
  const [another, setAnother] = useState(false);
  const [where, setWhere] = useState(paperFolderFor(project.name));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [engines, setEngines] = useState<PaperEngines | null>(null);
  useEffect(() => {
    void paperEngines(here.server).then(setEngines, () => setEngines(null));
    if (gitUrl && !isNewer(PAPER_TEMPLATES_VERSION, here.version)) void tokenKnown(here.server, gitUrl).then(setKnown, () => setKnown(false));
    else setKnown(false);
  }, [here, gitUrl]);

  const clone = async (url: string, secret: string) => {
    setBusy(true);
    setProblem(null);
    try {
      // The folder is a clone of this project already (made here before, and the project lost its link to it): taken back as it is.
      const plain = (address: string) => address.trim().replace(/^https?:\/\/[^@/]*@/, 'https://').replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
      const existing = await paperRemote(here.server, where).catch(() => null);
      if (existing?.url) {
        if (plain(existing.url) === plain(url)) return save(here.id, { path: where, sync: 'git' });
        throw new Error(`${where} is a clone of another project (${existing.url.replace(/^https?:\/\/[^@/]*@/, 'https://')}): give this one another folder.`);
      }
      const done = await clonePaper(here.server, where, url, secret);
      save(here.id, { path: done.folder, sync: 'git' });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const pick = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const chosen = await chooseFolder(here.server);
      if (!chosen.path) return;
      const linked = await linkFolder(here.server, chosen.path);
      save(here.id, { path: linked.root, sync: 'dropbox' });
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
        <h2>Where on this computer?</h2>
        <SwitchOverleaf project={project} />
        <p>
          This project keeps its paper on your computers rather than in Google Drive. Set up its folder here once: the project keeps it until you change it. <KeepWhere project={project} here={here} /> · <WriteGuideLink section="where">How this works</WriteGuideLink>
        </p>
        <div className="wr-ways" role="radiogroup" aria-label="Where the paper’s files come from">
          <button type="button" role="radio" aria-checked={way === 'git'} className={`wr-way${way === 'git' ? ' is-on' : ''}`} onClick={() => setWay('git')} disabled={!gitUrl}>
            <b>
              Overleaf’s Git <small>recommended</small>
            </b>
            <span>A clone of the Overleaf project. Everything you write here goes to Overleaf seconds after you stop, and coauthors’ edits come in. Needs a paid Overleaf plan.</span>
          </button>
          <button type="button" role="radio" aria-checked={way === 'dropbox'} className={`wr-way${way === 'dropbox' ? ' is-on' : ''}`} onClick={() => setWay('dropbox')}>
            <b>Overleaf’s Dropbox folder</b>
            <span>If Overleaf syncs the project to Dropbox, pick that folder: Dropbox carries edits both ways by itself.</span>
          </button>
        </div>
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
                <small>In Overleaf: Account Settings → Git integration → Generate token. The Companion keeps it on this computer, readable only by you.</small>
              </label>
            ) : null}
            <label className="wr-field">
              <span>Folder, inside the Companion’s</span>
              <input value={where} onChange={(event) => setWhere(event.target.value)} />
            </label>
            <div className="wr-row">
              <button type="button" className="btn primary" disabled={busy || known === null || (askToken ? !token.trim() : false) || !where.trim()} onClick={() => void clone(gitUrl, askToken ? token.trim() : '')}>
                {busy ? 'Cloning…' : 'Clone from Overleaf'}
              </button>
              <span className="wr-quiet mono">{gitUrl}</span>
            </div>
          </div>
        ) : null}
        {way === 'dropbox' ? (
          <div className="wr-row">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void pick()}>
              {busy ? 'Waiting for the folder…' : 'Choose the folder on this computer'}
            </button>
            <span className="wr-quiet">Usually Dropbox → Apps → Overleaf → the project.</span>
          </div>
        ) : null}
        {problem ? <p className="wr-bad">{problem}</p> : null}
        {engines && !engines.latexmk && !engines.tectonic ? <p className="wr-note">There’s no TeX on this computer yet: compile on Cloud Run, or the first compile here offers to fetch Tectonic.</p> : null}
        {engines && !engines.git && way === 'git' ? <p className="wr-bad">git isn’t installed on this computer: install it (git-scm.com, or xcode-select --install on a Mac) to sync.</p> : null}
      </div>
    </div>
  );
}

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

// ------------------------------------------------- compiled in the cloud --

type GithubState = { phase: 'idle' | 'setup' | 'sending' | 'queued' | 'compiling' | 'done' | 'failed'; on?: 'cloudrun' | 'github'; startedAt?: number; finishedAt?: number; runUrl?: string; error?: string; texSeconds?: number | null; readSeconds?: number; warming?: boolean; sent?: number; kept?: boolean };

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
 * The PDF pane's line about compiling in the cloud: Reader's own compiler —
 * Cloud Run, or GitHub Actions where the site has no Cloud Run — so there is
 * nothing to set up; how a compile is going.
 */
function GithubCompilePanel({ state, on, onCompile }: { state: GithubState; on: 'cloudrun' | 'github'; onCompile: () => void }) {
  const running = state.phase === 'sending' || state.phase === 'queued' || state.phase === 'compiling';
  const elapsed = useElapsed(state.startedAt, running);
  const where = (state.on ?? on) === 'github' ? 'on GitHub' : 'on Cloud Run';
  const said =
    state.phase === 'sending'
      ? 'Gathering the paper’s files…'
      : state.phase === 'queued'
        ? 'Waiting for GitHub to start…'
        : state.phase === 'compiling'
          ? `Compiling ${where} with all of TeX Live…`
          : state.phase === 'done'
            ? state.on === 'cloudrun' && state.finishedAt && state.startedAt
              ? `Compiled on Cloud Run in ${((state.finishedAt - state.startedAt) / 1000).toFixed(1)} s — ${state.sent === 0 ? 'nothing changed to send' : `${state.sent} changed file${state.sent === 1 ? '' : 's'} sent`}, TeX ${(state.texSeconds ?? 0).toFixed(1)} s${state.kept ? '' : ', from scratch'}.`
              : `Compiled ${where} in ${elapsed}.`
            : state.phase === 'failed'
              ? state.error ?? 'It didn’t compile.'
              : on === 'github'
                ? 'Press ⌘↵ or Compile: GitHub Actions makes the PDF with all of TeX Live, and it comes back here in a minute or two. Nothing to set up.'
                : `Cloud Run makes the PDF with all of TeX Live as you type, as Overleaf does (⌘↵ or Compile at any time); only what changed is sent. Nothing to set up.${state.warming ? ' Starting the compiler…' : ''}`;
  return (
    <div className={`wr-ghc is-line${state.phase === 'failed' ? ' is-bad' : ''}`}>
      <span>
        {running ? <span className="spinner" /> : null} {said} {running && elapsed ? <span className="mono">{elapsed}</span> : null}
      </span>
      {state.phase === 'failed' ? (
        <button type="button" className="link-btn" onClick={onCompile}>
          Try again
        </button>
      ) : null}
      <small>{(state.on ?? on) === 'github' ? 'The files pass through Reader’s server and a GitHub runner to be compiled; they are never put in a repository, and are deleted within the hour.' : 'The files pass through Reader’s server to its compiler on Cloud Run and are deleted once compiled; the PDF and log within the hour.'}</small>
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

/**
 * The Overleaf link a LaTeX project goes by — the folder `owner`'s own, or the
 * project's for the top — with the way to change it: only that folder's.
 */
function useLatexLink(project: Project, owner: string): [OverleafLink | undefined, (change: Partial<LatexLink>) => void] {
  const { updateCollection } = useStore();
  const base = project.project.overleaf;
  const link = owner && base ? { ...base, ...latexLinkAt(base, owner) } : base;
  const update = (change: Partial<LatexLink>) =>
    void updateCollection(project.id, (collection) => {
      const info = { ...project.project, ...(collection.project ?? {}) };
      if (!info.overleaf) return {};
      return { project: { ...info, overleaf: withLatexLink(info.overleaf, owner, change) } };
    });
  return [link, update];
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
async function listAll(store: PaperStore): Promise<string[]> {
  return (await listStamped(store)).map((file) => file.path);
}

/** The same, each with when it last changed and its size: enough to tell a changed file without reading it. */
async function listStamped(store: PaperStore): Promise<{ path: string; stamp: string }[]> {
  const found: { path: string; stamp: string }[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 5 || found.length >= MAX_FILES) return;
    for (const entry of await store.list(dir)) {
      if (entry.name.startsWith('.')) continue;
      if (entry.type === 'directory') await walk(entry.path, depth + 1);
      // Drive can hold two files of one name in a folder: the paper has one, the first listed.
      else if (!isBuildFile(entry.path) && !found.some((file) => file.path === entry.path)) found.push({ path: entry.path, stamp: `${entry.modified ?? ''}|${entry.size ?? ''}` });
    }
  };
  await walk('', 0);
  return found.sort((a, b) => (a.path.includes('/') === b.path.includes('/') ? a.path.localeCompare(b.path) : a.path.includes('/') ? 1 : -1));
}

/** The SHA-256 of a file's base64, as the compiler on Cloud Run reckons it (cloudrun/latex/server.py). */
async function fingerprint(base64: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(base64));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const toBlob = (base64: string) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'application/pdf' });
};


/** A project's link, made if there is none, with `change` in it: a paper in Drive needs no Overleaf. */
function useSetLink(project: Project) {
  const { updateCollection } = useStore();
  return (change: Partial<NonNullable<Project['project']['overleaf']>>) =>
    updateCollection(project.id, (collection) => {
      const info = { ...project.project, ...(collection.project ?? {}) };
      return { project: { ...info, overleaf: { url: '', ...(info.overleaf ?? {}), ...change } } };
    });
}

/** A paper kept in Drive: its LaTeX projects, then the desk — with nothing of it on this computer. */
function DriveWrite({ project, folder }: { project: Project; folder: string }) {
  const { driveConnected, connectDrive, settings, updateCollection } = useStore();
  const link = project.project.overleaf;
  const [scope, setScope] = useState<PaperScope | null>(null);
  const [comparing, setComparing] = useState<string | null>(null);
  const store = useMemo(() => driveStore(paperDriveNow, folder), [folder]);
  const shelf = useMemo(() => driveShelf(paperDriveNow, store), [store]);
  const place: PaperFolder = { path: folder, sync: 'drive' };
  if (!driveConnected || !settings.googleClientId.trim())
    return (
      <div className="wr-center wr-start">
        <div className="wr-card">
          <span className="eyebrow">The paper</span>
          <h2>It’s in your Google Drive</h2>
          <p>This project’s paper is kept in Drive, not on any computer. Sign in with Google, with Drive, to open it here.</p>
          <div className="wr-row">
            <button type="button" className="btn primary" onClick={() => void connectDrive()}>
              Sign in with Google, with Drive
            </button>
          </div>
        </div>
      </div>
    );
  if (comparing !== null) return <CompareOverleaf project={project} store={store} dir={comparing} onClose={() => setComparing(null)} />;
  if (!scope)
    return (
      <WriteHome
        project={project}
        folder={place}
        store={store}
        shelf={shelf}
        onOpen={(main, opened) => {
          // Its main document, kept on the link it goes by: its own folder's, or the top's — relative to that folder.
          const owner = latexOwner(link, opened.dir);
          const relative = owner ? main.slice(owner.length + 1) : main;
          if (relative !== latexLinkAt(link, owner).main)
            void updateCollection(project.id, (collection) => {
              const info = { ...project.project, ...(collection.project ?? {}) };
              return info.overleaf ? { project: { ...info, overleaf: withLatexLink(info.overleaf, owner, { main: relative }) } } : {};
            });
          rememberOpened(project.id, opened.dir);
          setScope(opened);
        }}
        onCompare={(dir) => setComparing(dir)}
      />
    );
  // Rooted at the folder whose Overleaf link it goes by: that is what syncs and compiles as one.
  const owner = latexOwner(link, scope.dir);
  const relative = (path: string) => (owner ? (path === owner ? '' : path.slice(owner.length + 1)) : path);
  const deskScope: PaperScope = { dir: relative(scope.dir), exclude: scope.exclude.filter((dir) => !owner || dir.startsWith(`${owner}/`)).map(relative) };
  return <WriteDesk key={`drive:${folder}:${scope.dir}`} project={project} folder={place} store={subStore(store, owner)} scope={deskScope} owner={owner} onHome={() => setScope(null)} onCompare={() => (setComparing(scope.dir), setScope(null))} />;
}

/** The LaTeX project last opened in a project, on this device: where Continue goes. */
const OPENED_KEY = (project: string) => `reader.write.${project}.opened`;
function rememberOpened(project: string, dir: string) {
  try {
    localStorage.setItem(OPENED_KEY(project), dir);
  } catch {
    // only a convenience
  }
}
function lastOpened(project: string): string | null {
  try {
    return localStorage.getItem(OPENED_KEY(project));
  } catch {
    return null;
  }
}

/** A main document in the paper's folder: a .tex file with \documentclass, with what it says of itself. */
interface PaperDoc {
  path: string;
  title: string;
  docClass: string;
  modified: string | null;
}

/** Which part of the folder a LaTeX project is: its folder ('' the top), less the other projects' folders inside it. */
interface PaperScope {
  dir: string;
  exclude: string[];
}

/** A LaTeX project: one PDF, from a main .tex and the files it brings in — sections, a .bib, styles, figures. */
interface LatexProject extends PaperScope {
  main: PaperDoc;
  /** Other .tex files with \documentclass in the same folder: standalone figures, a cover letter. */
  alsoMain: string[];
  /** Everything else it holds, as paths relative to the folder. */
  files: string[];
  modified: string | null;
}

const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const isWithin = (dir: string, path: string) => !dir || path.startsWith(`${dir}/`);
/** Whether a path is one of this LaTeX project's files, not another's in a folder inside it. */
const inScope = (scope: PaperScope, path: string) => isWithin(scope.dir, path) && !scope.exclude.some((dir) => isWithin(dir, path));

/**
 * The folder's LaTeX projects: one for each folder with a main document in it
 * (the project's main if it is there, else main.tex, else the latest edited),
 * each holding the files under it that no deeper project does.
 */
function groupProjects(docs: PaperDoc[], listed: { path: string; stamp: string }[], preferred: string[] = []): LatexProject[] {
  const byDir = new Map<string, PaperDoc[]>();
  for (const doc of docs) byDir.set(dirOf(doc.path), [...(byDir.get(dirOf(doc.path)) ?? []), doc]);
  const dirs = [...byDir.keys()];
  const owner = (path: string) => dirs.filter((dir) => isWithin(dir, path)).sort((a, b) => b.length - a.length)[0];
  return dirs.map((dir) => {
    const here = byDir.get(dir) ?? [];
    const main = here.find((doc) => preferred.includes(doc.path)) ?? here.find((doc) => /(^|\/)main\.tex$/i.test(doc.path)) ?? [...here].sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? ''))[0];
    const mine = listed.filter((file) => owner(file.path) === dir);
    const modified = mine.map((file) => file.stamp.split('|')[0]).concat(here.map((doc) => doc.modified ?? '')).filter(Boolean).sort().pop() ?? null;
    const exclude = dirs.filter((other) => other !== dir && isWithin(dir, other));
    const relative = (path: string) => (dir ? path.slice(dir.length + 1) : path);
    return {
      dir,
      exclude,
      main,
      alsoMain: here.filter((doc) => doc !== main).map((doc) => relative(doc.path)),
      files: mine.filter((file) => !here.some((doc) => doc.path === file.path)).map((file) => relative(file.path)),
      modified,
    };
  });
}

/** What a LaTeX project brings in, counted: "3 sections · 1 .bib · 6 figures". */
function filesSummary(files: string[]): string {
  const count = (test: RegExp) => files.filter((path) => test.test(path)).length;
  const tex = count(/\.tex$/i);
  const bib = count(/\.bib$/i);
  const figures = count(/\.(png|jpe?g|pdf|eps|svg)$/i);
  const styles = count(/\.(sty|cls|bst|bbx|cbx)$/i);
  const other = files.length - tex - bib - figures - styles;
  return [
    tex ? `${tex} .tex input${tex === 1 ? '' : 's'}` : '',
    bib ? `${bib} .bib` : '',
    figures ? `${figures} figure${figures === 1 ? '' : 's'}` : '',
    styles ? `${styles} style${styles === 1 ? '' : 's'}` : '',
    other ? `${other} other` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "3 h ago", for a document's last edit. */
function ago(iso: string | null): string {
  if (!iso) return '';
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 30 * 86_400) return `${Math.round(seconds / 86_400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

/** A new LaTeX project's folder name, from what it is called. */
const folderSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

/**
 * A new LaTeX project's files: a main.tex that brings in a section of its
 * own and has a bibliography to turn on, so it starts as the project it will
 * grow into rather than one file.
 */
const BLANK_PROJECT = (title: string): { path: string; text: string }[] => [
  {
    path: 'main.tex',
    text: `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath,amssymb,graphicx,hyperref}
\\graphicspath{{figures/}}

\\title{${title.replace(/[\\{}]/g, '')}}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\input{sections/introduction}

% Cite from references.bib, then turn the bibliography on:
% \\bibliographystyle{plain}
% \\bibliography{references}

\\end{document}
`,
  },
  { path: 'sections/introduction.tex', text: '\\section{Introduction}\n\n' },
  { path: 'references.bib', text: '% The bibliography: BibTeX entries, cited with \\cite{key} in the .tex files.\n' },
];

/** A file picked from a folder, by its path inside that folder: its top folder's name left off, and what isn't the paper's left out. */
const pickedPath = (file: File) => {
  const parts = (file.webkitRelativePath || file.name).split('/').filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join('/') : parts.join('/');
};
const worthKeeping = (path: string) => !path.split('/').some((part) => part.startsWith('.') || part === '__MACOSX') && !isBuildFile(path);

type Making = 'blank' | 'templates' | 'zip' | 'files';

/** A LaTeX project's folder in Google Drive, in a new tab. */
function OpenInDrive({ store, dir, onProblem, label = 'Google Drive' }: { store: PaperStore; dir: string; onProblem: (problem: string) => void; label?: string }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    // Opened at once, then sent on: a tab opened after the wait would be taken for a pop-up.
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    setBusy(true);
    try {
      const url = await store.link!(dir);
      if (tab) tab.location.href = url;
      else window.open(url, '_blank', 'noopener');
    } catch (error) {
      tab?.close();
      onProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="wr-doc-where" disabled={busy || !store.link} onClick={() => void go()} title={`Open ${dir ? `${dir}/` : 'the folder'} in Google Drive`}>
      {busy ? 'Opening…' : label}
    </button>
  );
}

/**
 * Where another project keeps its LaTeX in Drive, to copy a LaTeX project
 * into: its Drive folder, or the one it will have when it has no paper yet.
 * Null when it keeps its paper on a computer (a clone there), where Drive
 * isn't what it writes in.
 */
function driveFolderOf(project: Project): string | null {
  const link = project.project.overleaf;
  if (link?.keep?.where === 'computer') return null;
  if (link?.drive?.folder) return link.drive.folder;
  if (!overleafGitUrl(link?.url) && !Object.keys(link?.folders ?? {}).length) return paperDriveFolder(project.name, project.id);
  return null;
}

/**
 * A copy of a LaTeX project — its main .tex and every file it brings in,
 * subfolders and all — put into another project's Drive folder, as a LaTeX
 * project of its own there: off Overleaf, and from then on apart from this one.
 */
function CopyToProject({ project, store, one, onDone }: { project: Project; store: PaperStore; one: LatexProject; onDone: () => void }) {
  const { collections, updateCollection } = useStore();
  const others = useMemo(() => projectsOf(collections).filter((other) => other.id !== project.id), [collections, project.id]);
  const [to, setTo] = useState(others.find((other) => driveFolderOf(other))?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const target = others.find((other) => other.id === to);
  const copy = async () => {
    if (!target) return;
    const folder = driveFolderOf(target);
    if (!folder) return setProblem(`“${target.name}” keeps its paper on a computer, not in Drive: copy it there from that computer.`);
    setBusy(true);
    setProblem(null);
    setSaid(null);
    try {
      const into = driveStore(paperDriveNow, folder);
      const there = await listAll(into).catch(() => [] as string[]);
      const title = one.main.title || one.dir.split('/').pop() || 'paper';
      // A folder of its own there — unless that project has no paper and no Overleaf yet: then it is the paper, at its top.
      const fresh = !there.length && !overleafGitUrl(target.project.overleaf?.url);
      const slug = folderSlug(one.dir.split('/').pop() || title) || 'paper';
      let dir = fresh ? '' : slug;
      for (let n = 2; dir && there.some((path) => path.startsWith(`${dir}/`)); n += 1) dir = `${slug}-${n}`;
      const own = subStore(store, one.dir);
      // Paths in it: its main .tex, the other .tex files with \documentclass beside it, and every file it holds.
      const files = [one.dir ? one.main.path.slice(one.dir.length + 1) : one.main.path, ...one.alsoMain, ...one.files];
      for (const path of [...new Set(files)]) await into.writeBase64(dir ? `${dir}/${path}` : path, await own.readBase64(path));
      const main = one.dir ? one.main.path.slice(one.dir.length + 1) : one.main.path;
      await updateCollection(target.id, (collection) => {
        const info = { ...target.project, ...(collection.project ?? {}) };
        const link = info.overleaf?.drive?.folder ? info.overleaf : inDrive(info.overleaf, folder, undefined);
        return { project: { ...info, overleaf: dir ? withLatexLink(link, dir, { url: '', main }) : { ...link, main } } };
      });
      setSaid(`Copied to “${target.name}”${dir ? `, as ${dir}/` : ''}: ${files.length} file${files.length === 1 ? '' : 's'}. It is its own there, off Overleaf; this one is left as it is.`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  if (!others.length) return <p className="wr-quiet">There is no other project to copy it to yet.</p>;
  return (
    <div className="wr-copy">
      <label className="wr-field">
        <span>Copy “{one.main.title || one.dir || one.main.path}” to</span>
        <select value={to} onChange={(event) => setTo(event.target.value)} aria-label="The project to copy it to">
          {others.map((other) => (
            <option key={other.id} value={other.id} disabled={!driveFolderOf(other)}>
              {other.name}
              {driveFolderOf(other) ? '' : ' — keeps its paper on a computer'}
            </option>
          ))}
        </select>
        <small>Its main .tex and every file it brings in — sections, .bib, styles, figures — with their folders. The copy is a LaTeX project of its own there, not on Overleaf; changes to one don’t reach the other.</small>
      </label>
      <div className="wr-row">
        <button type="button" className="btn primary" disabled={busy || !target} onClick={() => void copy()}>
          {busy ? 'Copying…' : 'Copy it'}
        </button>
        <button type="button" className="link-btn" onClick={onDone}>
          {said ? 'Done' : 'Cancel'}
        </button>
      </div>
      {said ? <p className="wc-done">{said}</p> : null}
      {problem ? <p className="wr-bad">{problem}</p> : null}
    </div>
  );
}

/** A LaTeX project's folder on this computer, in Finder, Explorer or the desktop's file manager, by the Companion. */
function OpenHere({ here, folder, onProblem, label = 'This computer' }: { here: Here; folder: string; onProblem: (problem: string) => void; label?: string }) {
  const [busy, setBusy] = useState(false);
  const old = isNewer(REVEAL_VERSION, here.version);
  const go = async () => {
    if (old) return onProblem(`Opening the folder needs the Companion ${REVEAL_VERSION} or later on this computer (it is ${here.version}): update it from Your compute in the Playground.`);
    setBusy(true);
    try {
      await revealPaper(here.server, folder);
    } catch (error) {
      onProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="wr-doc-where" disabled={busy} onClick={() => void go()} title={`Open ~/Reader/${folder} in ${/Mac/i.test(navigator.platform) ? 'Finder' : /Win/i.test(navigator.platform) ? 'Explorer' : 'the file manager'}${old ? ` (needs the Companion ${REVEAL_VERSION})` : ''}`}>
      {busy ? 'Opening…' : label}
    </button>
  );
}

/**
 * Where the Write tab opens: the LaTeX projects in this project's folder —
 * each one PDF, from a main .tex (with \documentclass) and the files it
 * brings in: sections, a .bib, styles, figures — to open one, and the ways
 * to start another: a blank article, one of the templates kept on this
 * computer, a template's .zip (kept as a template too), or LaTeX files from
 * elsewhere. A new one goes in a folder of its own, beside the others,
 * unless the project has none yet.
 */
function WriteHome({ project, here, folder, store, shelf, onOpen, onCompare }: { project: Project; here?: Here; folder: PaperFolder; store: PaperStore; shelf: TemplateShelf | null; onOpen: (main: string, scope: PaperScope) => void; /** A LaTeX project on Overleaf, compared with its Overleaf project file by file (Drive only). */ onCompare?: (dir: string) => void }) {
  const { updateCollection } = useStore();
  const [toOverleaf, setToOverleaf] = useState(false);
  const [putting, setPutting] = useState<string | null>(null);
  const [copying, setCopying] = useState<string | null>(null);
  const placed = useRef('');
  const link = project.project.overleaf;
  const inDrive = store.kind === 'drive';
  // Each LaTeX project's Overleaf project (in Drive): its own, the one above it, or the top's — or none.
  const overleafOf = (dir: string) => {
    const owner = inDrive ? latexOwner(link, dir) : '';
    const url = latexLinkAt(link, owner).url;
    return { owner, url: overleafGitUrl(url) ? url : '' };
  };
  const opened = lastOpened(project.id);
  const next = (all: LatexProject[]) => all.find((one) => one.dir === opened) ?? all[0];
  const accounts = useOverleafAccounts();
  const throughAccount = folder.sync === 'drive' ? accounts?.find((account) => account.id === link?.gitAccount)?.label : undefined;
  const [docs, setDocs] = useState<LatexProject[] | null>(null);
  // Files no LaTeX project holds: beside them at the top, with no main document there.
  const [loose, setLoose] = useState<string[]>([]);
  const [taken, setTaken] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [making, setMaking] = useState<Making | null>(null);
  const [name, setName] = useState('');
  const [templates, setTemplates] = useState<PaperTemplate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const zipPicker = useRef<HTMLInputElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement | null>(null);
  // The Companion's templates are on this computer, from its 0.11.0; Drive's are in Drive, as their .zip.
  const templatesOld = !shelf || (here && store.kind === 'companion' ? isNewer(PAPER_TEMPLATES_VERSION, here.version) : false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const listed = await listStamped(store);
        const found: PaperDoc[] = [];
        let read = 0;
        for (const { path, stamp } of listed) {
          if (!/\.tex$/i.test(path) || read >= 80) continue;
          read += 1;
          const got = await store.readText(path).catch(() => null);
          const text = got?.text ?? '';
          const docClass = /^[^%\n]*\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/m.exec(text)?.[1];
          if (!docClass) continue;
          const title = /^[^%\n]*\\title(?:\[[^\]]*\])?\{([^}]*)\}/m.exec(text)?.[1]?.replace(/\\\\|\\[a-zA-Z]+\s*/g, ' ').replace(/\s+/g, ' ').trim() ?? '';
          found.push({ path, title, docClass, modified: got?.modified ?? (stamp.split('|')[0] || null) });
        }
        const mains = [link?.main, ...Object.entries(link?.latex ?? {}).map(([dir, own]) => (own.main ? `${dir}/${own.main}` : undefined))].filter((path): path is string => Boolean(path));
        const projects = groupProjects(found, listed, mains);
        const holds = (path: string) => projects.some((one) => inScope(one, path));
        const last = lastOpened(project.id);
        projects.sort((a, b) => (a.dir === last ? -1 : b.dir === last ? 1 : (b.modified ?? '').localeCompare(a.modified ?? '')));
        if (live) (setDocs(projects), setLoose(listed.map((file) => file.path).filter((path) => !holds(path))), setTaken(listed.map((file) => file.path)));
      } catch (error) {
        if (live) setProblem(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      live = false;
    };
  }, [store, link?.main]);

  useEffect(() => {
    if (making !== 'templates' || templates || templatesOld) return;
    void shelf?.list().then(setTemplates, (error) => setProblem(error instanceof Error ? error.message : String(error)));
  }, [making, templates, templatesOld, shelf]);

  /** Where a new LaTeX project goes: a folder of its own, or the top when the folder has nothing yet. */
  const placeFor = (label: string) => {
    if (!docs?.length && !taken.length) return '';
    const slug = folderSlug(label) || 'paper';
    let dir = slug;
    for (let n = 2; taken.some((path) => path.startsWith(`${dir}/`)); n += 1) dir = `${slug}-${n}`;
    return dir;
  };
  const within = (dir: string, path: string) => (dir ? `${dir}/${path}` : path);
  const open = (one: LatexProject) => onOpen(one.main.path, { dir: one.dir, exclude: one.exclude });
  const onOverleaf = Boolean(overleafGitUrl(link?.url));
  const run = async (work: () => Promise<string | undefined>) => {
    setBusy(true);
    setProblem(null);
    try {
      placed.current = '';
      const main = await work();
      const dir = placed.current;
      // A new LaTeX project in a folder of its own is off Overleaf until it is put there: never in the top's Overleaf project.
      if (main && dir && inDrive)
        await updateCollection(project.id, (collection) => {
          const info = { ...project.project, ...(collection.project ?? {}) };
          return info.overleaf ? { project: { ...info, overleaf: withLatexLink(info.overleaf, dir, { url: '', main: main.slice(dir.length + 1) }) } } : {};
        });
      // The new one's folder, less any project already inside it (only the top can have those).
      if (main) onOpen(main, { dir, exclude: dir ? [] : (docs ?? []).map((one) => one.dir).filter(Boolean) });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const makeBlank = () =>
    run(async () => {
      const title = name.trim() || 'Untitled';
      const dir = (placed.current = placeFor(title));
      for (const file of BLANK_PROJECT(title)) await store.writeText(within(dir, file.path), file.text);
      return within(dir, 'main.tex');
    });
  const fromTemplate = (template: ShelfTemplate) =>
    run(async () => {
      if (!shelf) throw new Error('Templates need the Companion on this computer, or the paper in Drive.');
      return shelf.apply(template.slug, (placed.current = placeFor(name.trim() || template.name)));
    });
  const fromZip = (file: File) =>
    run(async () => {
      const label = name.trim() || file.name.replace(/\.zip$/i, '');
      const zipped = await fileBase64(file);
      const dir = (placed.current = placeFor(label));
      // Kept for next time where there is a shelf; unpacked into the paper either way.
      if (shelf) {
        const kept = await shelf.save(label, zipped);
        return shelf.apply(kept.slug, dir);
      }
      return unpackKit(store, zipped, dir);
    });
  /** A LaTeX project from elsewhere: a folder, its subfolders kept as they are, or files picked one by one. */
  const fromFiles = (files: File[]) =>
    run(async () => {
      const picked = files.map((file) => ({ file, path: pickedPath(file) })).filter(({ path }) => path && worthKeeping(path));
      const tex = picked.filter(({ path }) => /\.tex$/i.test(path));
      if (!tex.length) throw new Error('There is no .tex file in it: pick the LaTeX project’s folder, or its main .tex with the files it needs.');
      const folderName = files[0]?.webkitRelativePath?.split('/')[0];
      const dir = (placed.current = placeFor(name.trim() || folderName || tex[0].path.replace(/\.tex$/i, '')));
      // Its main document: main.tex at its top if there is one, else the shallowest .tex with \documentclass.
      const mains: string[] = [];
      for (const { file, path } of tex) if (/^[^%\n]*\\documentclass/m.test(await file.text())) mains.push(path);
      mains.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
      for (const { file, path } of picked) await store.writeBase64(within(dir, path), await fileBase64(file));
      return within(dir, mains.find((path) => path === 'main.tex') ?? mains[0] ?? tex[0].path);
    });

  const ways: { id: Making; title: string; note: string; icon: string }[] = [
    { id: 'blank', title: 'Blank LaTeX project', note: 'A main.tex, a first section in sections/ and a references.bib, in a folder of its own: add more files as it grows.', icon: '＋' },
    { id: 'templates', title: 'Browse templates', note: store.kind === 'drive' ? 'The conference kits kept in your Drive: NeurIPS, ICML, ACL…' : 'The conference kits kept on this computer: NeurIPS, ICML, ACL…', icon: '▦' },
    { id: 'zip', title: 'Upload a template (.zip)', note: 'A conference’s kit, as it gives it out. Kept as a template for next time.', icon: '⇪' },
    { id: 'files', title: 'Upload a LaTeX project', note: 'Its folder from your computer, subfolders and all — the main .tex with its sections, .bib, styles and figures.', icon: '⎘' },
  ];

  return (
    <div className="wr-home">
      <header className="wr-home-head">
        <div>
          <span className="eyebrow">Write</span>
          <h2>{project.name}</h2>
          <p className="wr-quiet">
            <span className="mono">{store.label}</span> · {folder.sync === 'drive' ? (overleafGitUrl(link?.url) ? (throughAccount ? `in step with Overleaf through ${throughAccount}` : 'in step with Overleaf, through Reader’s server') : 'not on Overleaf') : folder.sync === 'git' ? (link?.repo && !overleafGitUrl(link?.url) ? `in step with GitHub (${link.repo})` : 'in step with Overleaf') : folder.sync === 'dropbox' ? 'kept in step by Dropbox' : 'on this computer only'}
            {' · '}
            {folder.sync === 'drive' && !overleafGitUrl(link?.url) ? (
              <button type="button" className="link-btn" aria-expanded={toOverleaf} onClick={() => setToOverleaf(!toOverleaf)}>
                Put it on Overleaf
              </button>
            ) : (
              <KeepWhere project={project} here={here} folder={folder} store={store} />
            )}
            {' · '}
            <WriteGuideLink section="where" />
          </p>
          {toOverleaf && folder.sync === 'drive' && !overleafGitUrl(link?.url) ? <PutOnOverleaf project={project} store={store} /> : null}
        </div>
        {docs?.length ? (
          <button type="button" className="btn primary" onClick={() => open(next(docs))}>
            Continue {next(docs).main.title || next(docs).dir || next(docs).main.path} →
          </button>
        ) : null}
      </header>

      <section className="wr-home-section" aria-label="The LaTeX projects in this project">
        <h3>LaTeX projects</h3>
        <p className="wr-quiet wr-home-lede">Each makes one PDF: a main .tex and the files it brings in — sections, a .bib, styles, figures — kept together in a folder.</p>
        {docs === null && !problem ? <p className="wr-quiet">Reading the project’s folder…</p> : null}
        {docs && !docs.length ? <p className="wr-quiet">None yet: start one below. A LaTeX project is a folder with a main .tex (the one with \documentclass) and its supporting files.</p> : null}
        {docs?.length ? (
          <div className="wr-docs">
            {docs.map((one) => (
              <div key={one.main.path} className="wr-doc-card">
              <button type="button" className="wr-doc" onClick={() => open(one)} title={`Open ${one.dir ? `${one.dir}/` : 'the top of the folder'}, compiled from ${one.main.path}`}>
                <span className="wr-doc-page" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
                <span className="wr-doc-text">
                  <b>{one.main.title || one.dir.split('/').pop() || one.main.path.split('/').pop()}</b>
                  <span className="mono">{one.dir ? `${one.dir}/` : 'top of the folder'} · {one.main.path.split('/').pop()}</span>
                  <small>
                    {one.main.docClass}
                    {one.modified ? ` · edited ${ago(one.modified)}` : ''}
                    {one.dir === opened ? <em>last open</em> : null}
                  </small>
                  <span className="wr-doc-files">
                    {one.files.length ? filesSummary(one.files) : 'No supporting files yet'}
                    {one.alsoMain.length ? ` · also ${one.alsoMain.join(', ')}` : ''}
                  </span>
                </span>
              </button>
              <div className="wr-doc-open" aria-label={`Open ${one.main.title || one.dir || one.main.path} elsewhere`}>
                <span className="wr-quiet">View in</span>
                {store.kind === 'drive' ? <OpenInDrive store={store} dir={one.dir} onProblem={setProblem} /> : null}
                {here && store.kind === 'companion' ? <OpenHere here={here} folder={[folder.path, one.dir].filter(Boolean).join('/')} onProblem={setProblem} /> : null}
                {(inDrive ? overleafOf(one.dir).url : onOverleaf) ? <OpenOverleaf project={project} view="beside" primary={false} compact url={inDrive ? overleafOf(one.dir).url : undefined} /> : null}
              </div>
              {inDrive ? (
                <div className="wr-doc-overleaf">
                  {overleafOf(one.dir).url ? (
                    <>
                      <span className="wr-quiet">{overleafOf(one.dir).owner === one.dir ? 'On Overleaf' : 'On Overleaf, in the project of the folder above'}</span>
                      {onCompare ? (
                        <button type="button" className="wr-doc-where" onClick={() => onCompare(one.dir)} title="See which files differ from Overleaf’s, compare the two PDFs, and pick which version each file keeps — here and on Overleaf">
                          Compare with Overleaf
                        </button>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <span className="wr-quiet">Not on Overleaf</span>
                      <button type="button" className="wr-doc-where" aria-expanded={putting === one.dir} onClick={() => setPutting(putting === one.dir ? null : one.dir)}>
                        Put on Overleaf
                      </button>
                    </>
                  )}
                </div>
              ) : null}
              {inDrive ? (
                <div className="wr-doc-overleaf">
                  <button type="button" className="wr-doc-where" aria-expanded={copying === one.dir} onClick={() => setCopying(copying === one.dir ? null : one.dir)} title="A copy of it, with every file it brings in, into another of your projects">
                    Copy to another project
                  </button>
                </div>
              ) : null}
              {copying === one.dir ? (
                <div className="wr-doc-put">
                  <CopyToProject project={project} store={store} one={one} onDone={() => setCopying(null)} />
                </div>
              ) : null}
              {putting === one.dir ? (
                <div className="wr-doc-put">
                  <PutOnOverleaf project={project} store={store} dir={one.dir} main={one.dir ? one.main.path.slice(one.dir.length + 1) : one.main.path} onDone={() => setPutting(null)} />
                </div>
              ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {docs?.length && loose.length ? (
          <p className="wr-quiet wr-home-others">
            Not in any LaTeX project: {filesSummary(loose)} — files at the top with no main .tex beside them.
          </p>
        ) : null}
      </section>

      <section className="wr-home-section" aria-label="Start a new LaTeX project">
        <h3>Start a new LaTeX project</h3>
        <div className="wr-home-ways" role="radiogroup" aria-label="How to start it">
          {ways.map((way) => (
            <button key={way.id} type="button" role="radio" aria-checked={making === way.id} className={`wr-home-way${making === way.id ? ' is-on' : ''}`} onClick={() => setMaking(making === way.id ? null : way.id)}>
              <span className="wr-home-icon" aria-hidden="true">{way.icon}</span>
              <b>{way.title}</b>
              <small>{way.note}</small>
            </button>
          ))}
        </div>

        {making ? (
          <div className="wr-home-make">
            <label className="wr-home-name">
              <span>Its name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder={making === 'blank' ? 'e.g. Workshop paper' : 'Optional: the template’s or folder’s name otherwise'} />
              <small className="wr-quiet">{docs?.length || taken.length ? `It goes in a folder of its own, ${placeFor(name.trim() || (making === 'blank' ? 'Untitled' : 'paper'))}/, beside the other LaTeX projects; its supporting files go in there with it.` : 'It goes at the top of the project’s folder.'}</small>
            </label>
            {making === 'blank' ? (
              <button type="button" className="btn primary" disabled={busy} onClick={() => void makeBlank()}>
                {busy ? 'Making it…' : 'Make it and open it'}
              </button>
            ) : null}
            {making === 'templates' ? (
              templatesOld ? (
                <p className="wr-quiet">Templates need the Companion {PAPER_TEMPLATES_VERSION} or later on this computer{here ? ` (it is ${here.version})` : ''}: update it from Your compute in the Playground.</p>
              ) : templates === null ? (
                <p className="wr-quiet">Asking this computer for its templates…</p>
              ) : templates.length ? (
                <div className="wr-home-templates">
                  {templates.map((template) => (
                    <button key={template.slug} type="button" className="wr-home-template" disabled={busy} onClick={() => void fromTemplate(template)}>
                      <b>{template.name}</b>
                      <small>
                        {template.files} files{template.main ? ` · ${template.main}` : ''}
                      </small>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="wr-quiet">No template {store.kind === 'drive' ? 'in your Drive' : 'on this computer'} yet: upload a conference’s .zip, and it is kept for next time.</p>
              )
            ) : null}
            {making === 'zip' ? (
              <>
                <button type="button" className="btn primary" disabled={busy} onClick={() => zipPicker.current?.click()}>
                  {busy ? 'Unpacking…' : 'Choose the .zip…'}
                </button>
                <input
                  ref={zipPicker}
                  type="file"
                  accept=".zip,application/zip"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) void fromZip(file);
                  }}
                />
              </>
            ) : null}
            {making === 'files' ? (
              <>
                <div className="wr-row">
                  <button type="button" className="btn primary" disabled={busy} onClick={() => folderPicker.current?.click()}>
                    {busy ? 'Copying…' : 'Choose its folder…'}
                  </button>
                  <button type="button" className="btn" disabled={busy} onClick={() => filePicker.current?.click()}>
                    Or pick its files…
                  </button>
                </div>
                <small className="wr-quiet">Its folder keeps its subfolders (sections/, figures/) as they are, so \input and \includegraphics paths still work. Picked one by one, the files all go at its top.</small>
                <input
                  ref={(input) => {
                    folderPicker.current = input;
                    // A folder, its subfolders and all: not in React's own attributes yet.
                    input?.setAttribute('webkitdirectory', '');
                  }}
                  type="file"
                  multiple
                  hidden
                  onChange={(event) => {
                    const files = [...(event.target.files ?? [])];
                    event.target.value = '';
                    if (files.length) void fromFiles(files);
                  }}
                />
                <input
                  ref={filePicker}
                  type="file"
                  multiple
                  accept=".tex,.bib,.sty,.cls,.bst,.bbx,.cbx,.png,.jpg,.jpeg,.pdf,.eps,.svg"
                  hidden
                  onChange={(event) => {
                    const files = [...(event.target.files ?? [])];
                    event.target.value = '';
                    if (files.length) void fromFiles(files);
                  }}
                />
              </>
            ) : null}
          </div>
        ) : null}
        {problem ? <p className="wr-bad">{problem}</p> : null}
      </section>
    </div>
  );
}

function WriteDesk({ project, here, folder, store, scope, owner = '', onHome, onCompare }: { project: Project; here?: Here; folder: PaperFolder; store: PaperStore; /** The LaTeX project open: its files are the ones listed. */ scope?: PaperScope; /** The folder (in the paper's Drive folder) whose Overleaf link this goes by: `store` is rooted at it. */ owner?: string; onHome?: () => void; /** Compare it with its Overleaf project, file by file (a paper in Drive on Overleaf). */ onCompare?: () => void }) {
  const { settings, papers, updateSettings } = useStore();
  const [desk, setDesk] = useDesk();
  const setLayout = (layout: WriteOptions['layout']) => updateSettings({ write: { ...WRITE_DEFAULTS, ...(settings.write ?? {}), layout } });
  const [big, setBig] = useState<'source' | 'pdf' | null>(null);
  // A paper in Drive has nothing on this computer to compile with: Cloud Run makes its PDF unless another is picked.
  const inDrive = folder.sync === 'drive';
  const options: WriteOptions = { ...WRITE_DEFAULTS, ...(settings.write ?? {}) };
  if (inDrive && options.pdf === 'here') options.pdf = 'cloudrun';
  const save = useSaveFolder(project);
  const [link, updateLink] = useLatexLink(project, owner);
  // Other LaTeX projects inside this one's folder, with Overleaf projects (or none) of their own: never synced with it.
  const separate = useMemo(() => latexSeparate(project.project.overleaf, owner), [project.project.overleaf, owner]);
  const separateKey = separate.join('|');
  // As the Overleaf project is set (Menu → Compiler, Main document): kept on the project, so it stays as picked.
  const compiler: TexCompiler = link?.compiler ?? 'pdflatex';
  const server = here?.server;
  const [paths, setPaths] = useState<string[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, FileState>>({});
  const filesRef = useRef(files);
  filesRef.current = files;
  const [open, setOpenState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(`reader.write.${project.id}${owner ? `:${owner}` : ''}.file`);
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
  // Written without syncing, for now: no account asked for, nothing sent until Sync is pressed.
  const [unsynced, setUnsynced] = useState(false);
  const unsyncedRef = useRef(false);
  unsyncedRef.current = unsynced;
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(0);
  const [showLog, setShowLog] = useState(false);
  const [pane, setPane] = useState<'source' | 'pdf'>('source');
  const [drawer, setDrawer] = useState(true);
  const typedAt = useRef(0);
  const timers = useRef<{ save?: number; compile?: number; sync?: number }>({});
  const [tokenShown, setTokenShown] = useState(false);
  const [fellBack, setFellBack] = useState<string | null>(null);
  const [texShown, setTexShown] = useState(false);
  // The Companion's own TeX Live, from 0.12.0: installed with a click, its packages too.
  const canOwnTex = Boolean(here) && !inDrive && !isNewer(TEXLIVE_VERSION, here?.version ?? '0');
  const setOwnTex = (status: TexLiveStatus) => setEngines((now) => (now ? { ...now, texlive: status } : now));
  const panesRef = useRef<HTMLDivElement>(null);
  // With Overleaf: by the Companion's Git on this computer, or for a paper in Drive by Reader's server (Cloud Run).
  const git = folder.sync === 'git' || (inDrive && Boolean(overleafGitUrl(link?.url)));

  const setOpen = (path: string) => {
    setOpenState(path);
    try {
      localStorage.setItem(`reader.write.${project.id}${owner ? `:${owner}` : ''}.file`, path);
    } catch {
      // only a convenience
    }
  };

  const load = useCallback(
    async (relative: string, force = false) => {
      if (!force && filesRef.current[relative]) return;
      const read = await store.readText(relative);
      const text = read?.text ?? '';
      setFiles((current) => (!force && current[relative] ? current : { ...current, [relative]: { text, disk: text } }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store],
  );

  const refreshList = useCallback(async () => {
    try {
      setPaths(await listAll(store));
      setListError(null);
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    }
  }, [store]);

  useEffect(() => {
    void refreshList();
    if (server && !inDrive) void paperEngines(server).then(setEngines, () => setEngines(null));
    if (git && server && !inDrive) void paperRemote(server, folder.path).then((remote) => setNeedToken(!remote.token && /overleaf|github/.test(remote.url)), () => undefined);
    if (git && inDrive) void overleafTokenKnown().then((known) => setNeedToken(!known), () => undefined);
  }, [refreshList, server, folder.path, git, inDrive]);

  // The open LaTeX project's own files; the folder's other projects are a step back, on the home page.
  const scoped = scope ? (paths ?? []).filter((path) => inScope(scope, path)) : paths ?? [];
  const at = (path: string) => (scope?.dir ? `${scope.dir}/${path}` : path);
  const texts = scoped.filter(isTextFile);
  const mainGuess = texts.find((path) => path === link?.main) ?? texts.find((path) => path === compiled?.main) ?? texts.find((path) => /(^|\/)main\.tex$/.test(path)) ?? texts.find((path) => path.endsWith('.tex'));
  const shown = open && texts.includes(open) ? open : mainGuess;
  // The main document: as set on the project, else the one the compile found, else the first with main.tex's name.
  const mainDoc = link?.main && texts.includes(link.main) ? link.main : undefined;
  const mainRef = useRef<string | undefined>(mainDoc);
  mainRef.current = mainDoc;
  useEffect(() => {
    if (shown) void load(shown);
  }, [shown, load]);

  // ---- compile
  // On Cloud Run, compiling as you type (or on save) goes there, as Overleaf's does: see compileOnCloudRun below.
  const cloudCompile = useRef<(() => void) | null>(null);
  const compile = useCallback(async () => {
    if (options.pdf === 'cloudrun') return void cloudCompile.current?.();
    // Overleaf makes the PDF, or GitHub Actions does (only when asked, ⌘↵ or Compile: a minute or two): nothing compiles here.
    if (options.pdf === 'overleaf' || options.pdf === 'github') return;
    if (!server || inDrive) return;
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
    // Opened: compiled at once, with the TeX here, or for a paper in Drive on Cloud Run.
    const ready = inDrive ? options.pdf === 'cloudrun' : Boolean(engines && (engines.latexmk || engines.tectonic));
    if (paths && texts.length && ready && !compiled && !compiling) void compile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths, engines]);

  // The Overleaf account the project syncs through, as it is now (chosen while the desk is open, too).
  const accountRef = useRef(link?.gitAccount);
  accountRef.current = link?.gitAccount;
  // ---- sync: by the Companion's Git here, or for a paper in Drive by Reader's server
  const syncNow = (message: string, given?: string): Promise<Synced> => {
    const asked = accountRef.current;
    return inDrive
      ? cloudSync(store, overleafGitUrl(link?.url) ?? '', message, given, { account: asked, exclude: separateKey ? separateKey.split('|') : [] }).then((done) => {
          // The account that opened it, remembered for the next sync (and shown with the project's accounts) —
          // unless another was chosen while it ran: that choice stands.
          if (done.account && done.account !== asked && accountRef.current === asked) updateLink({ gitAccount: (accountRef.current = done.account) });
          // Shared with several of the accounts, and the one it synced with can't open it any more: another did.
          setFellBack(done.fellBackFrom ? `“${done.fellBackFrom}” can’t open this Overleaf project any more (unshared, or its token was revoked), so it synced through “${done.accountLabel}”, which can.` : null);
          return done;
        })
      : server ? syncPaper(server, folder.path, message, given) : Promise.reject(new Error('This computer’s Companion isn’t connected.'));
  };
  const sync = useCallback(
    async (quiet = false) => {
      if (!git || (quiet && unsyncedRef.current)) return;
      if (!quiet) setUnsynced(false);
      setSyncing(true);
      if (!quiet) setSyncError(null);
      try {
        const done = await syncNow('Edits from Reader', token.trim() || undefined);
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
        await store.writeText(relative, text);
        setFiles((current) => (current[relative] ? { ...current, [relative]: { ...current[relative], disk: text } } : current));
        return true;
      } finally {
        setSaving((n) => n - 1);
      }
    },
    [store],
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
    const path = cleanPath(window.prompt('A new file — its path in the paper:', at('sections/new-section.tex')));
    if (!path) return;
    if ((paths ?? []).includes(path)) return setFileProblem(`${path} is there already.`);
    void fileOp(async () => {
      await store.writeText(path, '');
      setFiles((current) => ({ ...current, [path]: { text: '', disk: '' } }));
      setOpen(path);
    });
  };
  const newFolder = () => {
    const path = cleanPath(window.prompt('A new folder — its path in the paper (it reaches Overleaf once a file is in it):', at('figures')));
    if (!path) return;
    void fileOp(async () => {
      const parts = path.split('/');
      for (let i = 1; i <= parts.length; i += 1) await store.mkdir(parts.slice(0, i).join('/')).catch(() => undefined);
    });
  };
  const uploader = useRef<HTMLInputElement>(null);
  const upload = (list: FileList) => {
    const chosen = Array.from(list);
    if (!chosen.length) return;
    const dir = window.prompt(`Put ${chosen.length === 1 ? chosen[0].name : `${chosen.length} files`} in which folder? (empty for the top)`, chosen.every((file) => /\.(png|jpe?g|pdf|eps|svg)$/i.test(file.name)) ? at('figures') : scope?.dir ?? '');
    if (dir === null) return;
    const base = dir.trim() ? cleanPath(dir) : '';
    if (base === null) return setFileProblem('That folder name won’t do.');
    void fileOp(async () => {
      for (const file of chosen) await store.writeBase64(base ? `${base}/${file.name}` : file.name, await fileBase64(file));
    });
  };
  const rename = (path: string) => {
    const to = cleanPath(window.prompt('Rename or move it — its new path:', path));
    if (!to || to === path) return;
    void fileOp(async () => {
      await writeOut(path);
      await store.rename(path, to);
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
      await store.remove(path);
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
      if (git && options.sync !== 'manual' && (wrote || synced?.ok !== true || Date.now() - (synced?.at ?? 0) > 2000)) void syncNow('Edits from Reader').catch(() => undefined);
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
  // ---- compiling in the cloud: Reader's compiler, Cloud Run or GitHub Actions, through its Worker (worker/latex.js)
  const [gh, setGh] = useState<GithubState>({ phase: 'idle' });
  const compileOnGithub = async () => {
    const started = Date.now();
    setCompiling(true);
    setCompileError(null);
    // What this computer's compile said (a package it lacks, say) isn't the cloud's: cleared until it answers.
    setCompiled(null);
    setShowLog(false);
    try {
      setGh({ phase: 'sending', startedAt: started });
      const paths = await listAll(store);
      const files: CompileFile[] = [];
      for (const path of paths) files.push({ path, base64: await store.readBase64(path) });
      const main = mainDoc ?? compiled?.main ?? 'main.tex';
      const on = 'github' as const;
      const asked = await apiFetch('/latex/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files, main, compiler, on }) });
      const job = (await asked.json().catch(() => ({}))) as { id?: string; on?: 'cloudrun' | 'github'; state?: string; error?: string };
      if (!asked.ok || !job.id) throw new Error(job.error ?? `The compiler didn’t take it (${asked.status}).`);
      // Cloud Run answers once it has compiled: no waiting before the first look.
      let wait = job.state === 'done' ? 0 : 4000;
      setGh({ phase: job.state === 'done' ? 'compiling' : 'queued', on, startedAt: started });
      const until = Date.now() + 12 * 60_000;
      while (Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        wait = 4000;
        const now = (await (await apiFetch(`/latex/jobs/${job.id}`, { cache: 'no-store' })).json().catch(() => null)) as { state?: string; pdf?: boolean; exit?: number | null; error?: string | null } | null;
        if (!now?.state) continue;
        if (now.state === 'failed') throw new Error(now.error ?? 'The compile didn’t start.');
        if (now.state !== 'done') {
          setGh({ phase: now.state === 'compiling' ? 'compiling' : 'queued', on, startedAt: started });
          continue;
        }
        const log = await (await apiFetch(`/latex/jobs/${job.id}/log`, { cache: 'no-store' })).text().catch(() => '');
        const blob = now.pdf ? await (await apiFetch(`/latex/jobs/${job.id}/pdf`, { cache: 'no-store' })).blob() : null;
        const read = readTexLog(log);
        setCompiled({ ok: Boolean(blob) && now.exit === 0, main, engine: 'GitHub · all of TeX Live', compiler, pdf: blob ? 'github' : '', errors: read.errors, warnings: read.warnings, log, ms: Date.now() - started });
        if (blob) setPdf(new Blob([blob], { type: 'application/pdf' }));
        if (read.errors.length && !blob) setShowLog(true);
        setGh({ phase: 'done', on, startedAt: started, finishedAt: Date.now(), });
        return;
      }
      throw new Error('No PDF came back within 12 minutes.');
    } catch (error) {
      setGh({ phase: 'failed', startedAt: started, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setCompiling(false);
    }
  };

  // ---- compiling on Cloud Run, as Overleaf does: the compiler keeps this
  // paper's folder between compiles (and TeX's .aux, .bbl and .toc in it), so
  // each compile sends only the files changed since the last, read only when
  // the Companion says they changed, and TeX reruns only what it must. The
  // service asks (409) for any file it lacks — it restarted, say — and gets it.
  // One compile at a time; edits made during one are compiled right after.
  const cloud = useRef<{ folder: string; files: Map<string, { stamp: string; sha: string; base64: string }>; acked: Map<string, string>; busy: boolean; again: boolean }>({ folder: '', files: new Map(), acked: new Map(), busy: false, again: false });
  const compileOnCloudRun = async (fresh = false) => {
    const state = cloud.current;
    if (state.busy) return void (state.again = true);
    if (state.folder !== folder.path) Object.assign(state, { folder: folder.path, files: new Map(), acked: new Map() });
    state.busy = true;
    const started = Date.now();
    setCompiling(true);
    setCompileError(null);
    setGh((now) => ({ ...now, phase: 'sending', on: 'cloudrun', startedAt: started, error: undefined }));
    try {
      const listed = await listStamped(store);
      for (const { path, stamp } of listed) {
        // The paper's text (.tex, .bib, .sty) is read every time — a few ms from this computer — as an edit
        // saved within the listing's timestamp resolution, or keeping the size, could look unchanged; figures go by their stamp.
        if (state.files.get(path)?.stamp === stamp && !isTextFile(path)) continue;
        const base64 = await store.readBase64(path);
        state.files.set(path, { stamp, sha: await fingerprint(base64), base64 });
      }
      const here = new Set(listed.map((file) => file.path));
      for (const path of [...state.files.keys()]) if (!here.has(path)) state.files.delete(path);
      const manifest = Object.fromEntries([...state.files].map(([path, file]) => [path, file.sha]));
      const filesOf = (paths: string[]): CompileFile[] => paths.filter((path) => state.files.has(path)).map((path) => ({ path, base64: state.files.get(path)!.base64 }));
      let changed = [...state.files].filter(([path, file]) => state.acked.get(path) !== file.sha).map(([path]) => path);
      const main = mainDoc ?? compiled?.main ?? 'main.tex';
      const readSeconds = (Date.now() - started) / 1000;
      setGh((now) => ({ ...now, phase: 'compiling' }));
      const send = (paths: string[]) =>
        apiFetch('/latex/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: 'cloudrun', project: `${project.id}:${owner ? `${folder.path}/${owner}` : folder.path}:${main}`, manifest, files: filesOf(paths), main, compiler, fresh }) });
      let answer = await send(changed);
      if (answer.status === 409) {
        // The compiler lacks some files (it restarted, or another paper pushed this one out): those, and ask again.
        const { need = [] } = (await answer.json().catch(() => ({}))) as { need?: string[] };
        changed = [...new Set([...changed, ...need])];
        answer = await send(need);
      }
      const result = (await answer.json().catch(() => ({}))) as { pdf?: string; log?: string; exit?: number; seconds?: number; cached?: boolean; error?: string; need?: string[] };
      if (!answer.ok) throw new Error(result.error ?? `The compiler answered ${answer.status}.`);
      state.acked = new Map(Object.entries(manifest));
      const log = result.log ?? '';
      const read = readTexLog(log);
      const bytes = result.pdf ? Uint8Array.from(atob(result.pdf), (char) => char.charCodeAt(0)) : null;
      setCompiled({ ok: Boolean(bytes) && result.exit === 0, main, engine: 'Cloud Run · all of TeX Live', compiler, pdf: bytes ? 'github' : '', errors: read.errors, warnings: read.warnings, log, ms: Date.now() - started });
      if (bytes) setPdf(new Blob([bytes], { type: 'application/pdf' }));
      if (read.errors.length && !bytes) setShowLog(true);
      setGh({ phase: 'done', on: 'cloudrun', startedAt: started, finishedAt: Date.now(), texSeconds: result.seconds ?? null, readSeconds, sent: changed.length, kept: Boolean(result.cached) });
    } catch (error) {
      setGh({ phase: 'failed', on: 'cloudrun', startedAt: started, error: error instanceof Error ? error.message : String(error) });
    } finally {
      state.busy = false;
      setCompiling(false);
      if (state.again) {
        state.again = false;
        void compileOnCloudRun();
      }
    }
  };
  cloudCompile.current = () => void compileOnCloudRun();

  // Cloud Run starts an instance on the first compile after a quiet spell (some
  // seconds, all of TeX Live): one is asked for as soon as it is picked, and
  // every ten minutes while it stays picked and this page is in view, so the
  // compile doesn't wait for it. An idle instance costs nothing.
  useEffect(() => {
    if (options.pdf !== 'cloudrun') return;
    const warm = () => {
      if (document.visibilityState !== 'visible') return;
      setGh((now) => (now.phase === 'idle' ? { ...now, warming: true } : now));
      void apiFetch('/latex/warm', { method: 'POST', cache: 'no-store' })
        .catch(() => undefined)
        .finally(() => setGh((now) => (now.warming ? { ...now, warming: false } : now)));
    };
    warm();
    const timer = window.setInterval(warm, 10 * 60_000);
    document.addEventListener('visibilitychange', warm);
    return () => (window.clearInterval(timer), document.removeEventListener('visibilitychange', warm));
  }, [options.pdf]);

  const recompile = () => {
    if (options.pdf === 'cloudrun') return void saveNow().then(() => compileOnCloudRun());
    if (options.pdf === 'github') return void saveNow().then(() => compileOnGithub());
    if (options.pdf !== 'overleaf') return void saveNow().then(() => compile());
    const overleaf = link;
    let beside: Window | null = null;
    if (overleaf && !(here && overleaf.browsers?.[here.id])) {
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
      {inDrive ? null : (
        <button type="button" aria-pressed={options.pdf === 'here'} onClick={() => updateSettings({ write: { ...WRITE_DEFAULTS, ...(settings.write ?? {}), pdf: 'here' } })} title="The TeX installed on this computer compiles it, through the Companion">
          This computer
        </button>
      )}
      <button type="button" aria-pressed={options.pdf === 'github'} onClick={() => updateSettings({ write: { ...WRITE_DEFAULTS, ...(settings.write ?? {}), pdf: 'github' } })} title="Reader’s compiler on GitHub Actions, with all of TeX Live: the PDF comes back here in a minute or two. It compiles: it doesn’t publish or sync anything.">
        GitHub Actions
      </button>
      <button type="button" aria-pressed={options.pdf === 'cloudrun'} onClick={() => updateSettings({ write: { ...WRITE_DEFAULTS, ...(settings.write ?? {}), pdf: 'cloudrun' } })} title="Reader’s compiler on Google Cloud Run, with all of TeX Live: the PDF comes back here in seconds. It compiles: it doesn’t publish or sync anything.">
        Cloud Run
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
        <button type="button" className="btn sm primary" disabled={compiling || (options.pdf === 'here' && Boolean(noTex))} onClick={recompile} title={options.pdf === 'github' ? 'Compile on GitHub Actions (⌘↵)' : options.pdf === 'cloudrun' ? 'Compile on Cloud Run (⌘↵)' : 'Recompile (⌘↵)'}>
          {compiling ? 'Compiling…' : options.pdf === 'github' || options.pdf === 'cloudrun' ? 'Compile' : 'Recompile'}
        </button>
        {options.layout === 'tabs' ? (
          <span className="segmented sm">
            <button type="button" aria-pressed={pane === 'source'} onClick={() => setPane('source')}>Source</button>
            <button type="button" aria-pressed={pane === 'pdf'} onClick={() => setPane('pdf')}>PDF</button>
          </span>
        ) : null}
      </div>
      {options.pdf === 'github' || options.pdf === 'cloudrun' ? (
        <GithubCompilePanel state={gh} on={options.pdf} onCompile={options.pdf === 'cloudrun' ? () => void saveNow().then(() => compileOnCloudRun(true)) : recompile} />
      ) : null}
      {noTex && options.pdf === 'here' ? (
        <div className="wr-pad">
          <p>There’s no TeX on this computer to compile with.</p>
          {canOwnTex && server ? <OwnTex server={server} status={engines?.texlive} onStatus={setOwnTex} onReady={() => void paperEngines(server).then(setEngines).then(() => compile())} /> : null}
          {engines?.tectonicInstallable ? (
            <button
              type="button"
              className="btn primary sm"
              disabled={installing}
              onClick={async () => {
                if (!server) return;
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
          {here && server && isNewer('0.11.1', here.version) ? (
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
            <OpenOverleaf project={project} view="beside" url={link?.url ?? ''} />
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
          <p className="wr-quiet">⌘↵ here sends your edits and opens the project in the window beside once they’ve arrived — Overleaf compiles it as it opens. If Overleaf’s PDF doesn’t refresh after an edit comes in, press Recompile there. To compile on this computer, GitHub Actions or Cloud Run instead, pick it under Compile on, above.</p>
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
        {onHome ? (
          <button type="button" className="wr-home-back" onClick={onHome} title="The project’s LaTeX projects, and new ones">
            ← All LaTeX projects
          </button>
        ) : null}
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
          {scoped.map((path) => (
            <div key={path} className={`wr-tree-row${path === shown ? ' is-on' : ''}`}>
              <button
                type="button"
                className={`wr-tree-item${path === shown ? ' is-on' : ''}${isTextFile(path) ? '' : ' is-other'}`}
                disabled={!isTextFile(path)}
                onClick={() => setOpen(path)}
                title={path}
              >
                {path.slice(scope?.dir ? scope.dir.length + 1 : 0).includes('/') ? <span className="wr-tree-dir">{path.slice(scope?.dir ? scope.dir.length + 1 : 0, path.lastIndexOf('/') + 1)}</span> : null}
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
          {owner ? null : <SwitchOverleaf project={project} />}
        </div>
        <div className="wr-side-foot">
          <span className="wr-quiet mono" title={store.label}>
            {inDrive ? 'Google Drive' : here?.name} · {folder.path}
          </span>
          {inDrive ? (
            <OpenInDrive store={store} dir={scope?.dir ?? ''} onProblem={setFileProblem} label="Open in Drive" />
          ) : here ? (
            <>
            <OpenHere here={here} folder={[folder.path, scope?.dir].filter(Boolean).join('/')} onProblem={setFileProblem} label="Show the folder" />
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                if (window.confirm('Use another folder for the paper on this computer? This folder stays as it is.')) save(here.id, undefined);
              }}
            >
              Change
            </button>
            </>
          ) : null}
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
            {missing.length && server && here ? (
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
              {syncing ? 'Syncing with Overleaf…' : unsynced ? 'Not syncing with Overleaf for now' : syncError ? 'Not synced' : synced?.at ? `Synced with ${/github/.test(link?.repo ?? '') && !overleafGitUrl(link?.url) ? 'GitHub' : 'Overleaf'} · ${new Date(synced.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Git · not synced yet'}
            </span>
            <button type="button" className="link-btn" disabled={syncing} onClick={() => void saveNow().then(() => sync())}>
              Sync
            </button>
            {onCompare && inDrive ? (
              <button type="button" className="link-btn" disabled={syncing} onClick={() => void saveNow().then(onCompare)} title="See which files differ from Overleaf’s, compare the PDFs, and pick which version each file keeps — here and on Overleaf">
                Compare with Overleaf
              </button>
            ) : null}
          </>
        ) : (
          <span>{folder.sync === 'dropbox' ? 'Dropbox keeps this folder in step with Overleaf' : inDrive ? 'Saved in Google Drive · not on Overleaf' : 'Not synced: a folder on this computer'}</span>
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
        <WriteGuideLink section="editor" />
        <button type="button" className="link-btn" aria-expanded={texShown} onClick={() => setTexShown(!texShown)} title="The TeX that compiles the paper: Reader can install TeX Live for you">
          TeX
        </button>
        {git ? (
          <button type="button" className="link-btn" aria-expanded={tokenShown} onClick={() => setTokenShown(!tokenShown)} title={inDrive ? 'The Overleaf Git token Reader’s server keeps for you, and how to remove it' : 'The Overleaf Git token on this computer: where it is, and how to remove it'}>
            {inDrive ? 'Overleaf account' : 'Overleaf token'}
          </button>
        ) : null}
        <OpenOverleaf project={project} view="beside" primary={false} compact url={link?.url ?? ''} />
      </footer>
      {texShown && server && here ? (
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
          {inDrive ? (
            <div className="wr-sync-accounts">
              <OverleafAccounts current={link?.gitAccount} projectUrl={link?.url} accountLabel={link?.account} onChoose={(id) => (updateLink({ gitAccount: id }), setFellBack(null))} />
            </div>
          ) : (
            <ForgetToken server={server} open onForgotten={() => setNeedToken(true)} />
          )}
        </div>
      ) : null}
      {fellBack ? (
        <div className="wr-sync-banner">
          <span>{fellBack}</span>
          <button type="button" className="link-btn" onClick={() => (setTokenShown(true), setFellBack(null))}>
            Overleaf accounts
          </button>
        </div>
      ) : null}
      {!unsynced && (syncError || needToken || (synced?.conflicts.length ?? 0) > 0) ? (
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
            <span>{inDrive ? 'No Overleaf account is connected yet: connect yours to keep the paper in step with Overleaf.' : 'The Companion has no token for this folder’s remote yet.'}</span>
          ) : (
            <span>{syncError}</span>
          )}
          {inDrive && (needToken || /token|account/i.test(syncError ?? '')) ? (
            <div className="wr-sync-accounts">
              <OverleafAccounts open projectUrl={link?.url} accountLabel={link?.account} onConnected={() => (setNeedToken(false), void sync())} />
              <button type="button" className="link-btn" onClick={() => (setUnsynced(true), setNeedToken(false), setSyncError(null))} title="Keep writing and compiling here; nothing goes to Overleaf until you press Sync">
                Not now: write without syncing
              </button>
            </div>
          ) : needToken || /auth|token|403|401|denied/i.test(syncError ?? '') ? (
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
