// A project whose code is on another computer, as the Playground shows it —
// in the ways picked under "Code on another computer…" (src/lib/away.ts):
// the home grouped by where the code is (A), a card in the editor's place
// (B), a read-only snapshot from Drive (C), and bringing the code here (D).

import { useEffect, useMemo, useState } from 'react';
import { AWAY_DEFAULT, AWAY_SHOWS, copyProject, moveToDrive, readManifest, since, snapshotHost, takeSnapshot } from '../lib/away';
import type { Reach, SnapshotManifest } from '../lib/away';
import type { JupyterServer } from '../lib/colab';
import { driveFolderName } from '../lib/driveFiles';
import type { Playground } from '../lib/playground';
import { useDriveConnected, useServers } from '../lib/playground';
import { useStore } from '../lib/store';
import CodeEditor from './CodeEditor';
import FileIcon from './FileIcon';
import { CloseIcon } from './icons';

// ------------------------------------------------------------ choosing ----

/** The four ways, each a switch; A, B and D are what the app starts with. */
export function AwayChooser() {
  const { settings, updateSettings } = useStore();
  const shows = settings.awayShows;
  const isDefault = AWAY_SHOWS.every((option) => shows[option.id] === AWAY_DEFAULT[option.id]);
  return (
    <div className="pr-choose is-compact">
      {AWAY_SHOWS.map((option) => (
        <label key={option.id} className="pr-choose-row">
          <input type="checkbox" checked={shows[option.id]} onChange={(event) => updateSettings({ awayShows: { ...shows, [option.id]: event.target.checked } })} />
          <span>
            <strong>{option.label}</strong>
            {AWAY_DEFAULT[option.id] ? <em className="pr-rec">default</em> : null}
            <br />
            <small>{option.note}</small>
          </span>
        </label>
      ))}
      <div className="pr-choose-foot">
        <button type="button" className="btn sm" disabled={isDefault} onClick={() => updateSettings({ awayShows: AWAY_DEFAULT })}>
          Back to the default (A, B and D)
        </button>
        <button type="button" className="btn sm ghost" onClick={() => updateSettings({ awayShows: { group: true, card: true, snapshot: true, bring: true } })}>
          All four
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------- A · the home's groups --

export type GroupTone = 'here' | 'up' | 'down' | 'none';
export interface HomeGroup {
  key: string;
  label: string;
  note: string;
  tone: GroupTone;
  /** Opens from this browser as it stands. */
  openable: boolean;
  rank: number;
}

/** Which group a playground's code puts it in on the home, and whether it opens from here. */
export function homeGroupOf(p: Playground, servers: JupyterServer[], live: Record<string, string>, browserHasFiles: boolean): HomeGroup {
  const home = p.home;
  if (home.kind === 'server') {
    const server = servers.find((s) => s.id === home.serverId);
    if (!server) {
      const name = home.name ?? 'a computer this browser doesn’t know';
      return { key: `gone:${home.deviceId ?? home.name ?? home.serverId}`, label: `On ${name}`, note: 'not connected to this browser', tone: 'none', openable: false, rank: 5 };
    }
    const down = live[server.id] === 'down';
    if (server.where === 'pc')
      return { key: `s:${server.id}`, label: 'On this computer', note: down ? `${server.name} · its Companion isn’t answering` : server.name, tone: down ? 'down' : 'here', openable: !down, rank: down ? 4 : 0 };
    return {
      key: `s:${server.id}`,
      label: `On ${server.name}`,
      note: down ? `offline · last seen ${since(server.seen)}` : 'online · reachable from here',
      tone: down ? 'down' : 'up',
      openable: !down,
      rank: down ? 4 : 2,
    };
  }
  if (home.kind === 'drive') return { key: 'drive', label: 'In your Google Drive', note: 'opens on any computer you sign in on', tone: 'here', openable: true, rank: 1 };
  if (home.kind === 'machine') return { key: 'machine', label: 'On the machine it runs on', note: 'its files are on that machine’s disk', tone: 'up', openable: true, rank: 3 };
  if (p.kind === 'notebook') return { key: 'drive', label: 'In your Google Drive', note: 'opens on any computer you sign in on', tone: 'here', openable: true, rank: 1 };
  return browserHasFiles
    ? { key: 'browser', label: 'In this browser', note: 'its files are kept here only', tone: 'here', openable: true, rank: 1.5 }
    : { key: 'other-browser', label: `In ${home.browser ?? 'another browser'}`, note: 'its files are kept there only', tone: 'none', openable: false, rank: 5 };
}

// --------------------------------------------- B · where the code is, a card --

/** Copies the playground's address, to open on the computer that has its code. */
const copyLink = (id: string) => void navigator.clipboard?.writeText(`${window.location.origin}${import.meta.env.BASE_URL}playground/${id}`).catch(() => undefined);

export function AwayCard({
  playground,
  reach,
  onSnapshot,
  onBring,
  onRetry,
  onConnect,
  onNotebook,
}: {
  playground: Playground;
  reach: Exclude<Reach, { state: 'here' }>;
  onSnapshot?: () => void;
  onBring?: () => void;
  onRetry: () => void;
  onConnect: () => void;
  onNotebook: () => void;
}) {
  const { settings } = useStore();
  const shows = settings.awayShows;
  const [copied, setCopied] = useState(false);
  const root = playground.home.kind === 'server' ? playground.home.root : '';
  const snap = playground.snapshot;
  const down = reach.state === 'down';
  return (
    <div className="away-wrap">
      <section className="away-card" aria-label="Where the code is">
        <div className="away-head">
          <span className="away-mark" aria-hidden="true">
            {down ? '⏸' : '⇢'}
          </span>
          <div>
            <span className="eyebrow">{down ? 'The code can’t be reached right now' : 'The code isn’t on this computer'}</span>
            <h2>
              {playground.title} lives on {reach.computer}
            </h2>
          </div>
        </div>
        <p>
          Its folder, <code>{root || 'the project’s folder'}</code>, is on {reach.computer} and nowhere else.{' '}
          {down
            ? `${reach.computer} is in this browser’s list but isn’t answering: it may be off or asleep, or its Companion has stopped.`
            : `This browser isn’t connected to ${reach.computer}, so it can’t open the folder from here.`}
        </p>
        <div className="away-row">
          <span className={`away-dot is-${reach.state === 'checking' ? 'checking' : down ? 'down' : 'none'}`} />
          <b>{reach.state === 'checking' ? `Looking for ${reach.computer}…` : down ? `${reach.computer} isn’t answering` : `${reach.computer} isn’t connected here`}</b>
          {reach.seen ? <span className="away-meta">last heard from {since(reach.seen)}</span> : null}
        </div>
        {shows.snapshot ? (
          snap ? (
            <div className="away-row">
              <span aria-hidden="true">⧉</span>
              <span>
                A read-only snapshot from {since(snap.at)} · {snap.files} {snap.files === 1 ? 'file' : 'files'}
              </span>
              <button type="button" className="btn sm away-row-end" onClick={onSnapshot}>
                Open the snapshot
              </button>
            </div>
          ) : (
            <div className="away-row is-quiet">
              <span aria-hidden="true">⧉</span>
              <span>No snapshot yet: one is kept in your Drive while the project is open on {reach.computer}, signed in with Drive.</span>
            </div>
          )
        ) : null}
        <div className="away-acts">
          {down ? (
            <button type="button" className="btn primary" onClick={onRetry}>
              Try again
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={onConnect}>
              Connect {reach.computer} here
            </button>
          )}
          <button
            type="button"
            className="btn"
            onClick={() => {
              copyLink(playground.id);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2000);
            }}
            title={`The project’s address, to open on ${reach.computer}`}
          >
            {copied ? 'Copied' : `Copy the link to open it on ${reach.computer}`}
          </button>
          {shows.bring && onBring ? (
            <button type="button" className="btn ghost" onClick={onBring} disabled={!snap} title={snap ? undefined : 'Nothing to bring yet: there is no snapshot of the code here'}>
              Bring the code here…
            </button>
          ) : null}
        </div>
        <p className="away-hint">
          {down
            ? `On ${reach.computer}, open the Reader app (or run reader-companion there); this page finds it again by itself.`
            : `To connect it: open the Reader app on ${reach.computer}, or sign in here with the Google account it is under — your computers appear on their own. `}
          {playground.kind === 'project' ? (
            <>
              {' '}
              The{' '}
              <button type="button" className="link" onClick={onNotebook}>
                notebook
              </button>{' '}
              is kept with the project and opens here.
            </>
          ) : null}
        </p>
      </section>
    </div>
  );
}

// ------------------------------------------------ C · a read-only snapshot --

export function SnapshotView({ playground, reach, onBring, onBack }: { playground: Playground; reach: Reach; onBring?: () => void; onBack: () => void }) {
  const drive = useDriveConnected();
  const [manifest, setManifest] = useState<SnapshotManifest | null | 'none'>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const host = useMemo(() => snapshotHost(playground), [playground.id, drive]);
  useEffect(() => {
    let alive = true;
    setManifest(null);
    void readManifest(playground)
      .then((found) => {
        if (!alive) return;
        setManifest(found ?? 'none');
        const first = found?.files.find((f) => /(^|\/)main\.py$/.test(f.path)) ?? found?.files.find((f) => /\.py$/.test(f.path)) ?? found?.files[0];
        if (first) setOpen(first.path);
      })
      .catch((error) => alive && setProblem(error instanceof Error ? error.message : String(error)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playground.id, drive]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setText(null);
    void host
      .read(open)
      .then((body) => alive && setText(body ?? ''))
      .catch((error) => alive && setProblem(error instanceof Error ? error.message : String(error)));
    return () => {
      alive = false;
    };
  }, [open, host]);
  const files = manifest && manifest !== 'none' ? [...manifest.files].sort((a, b) => a.path.localeCompare(b.path)) : [];
  const away = reach.state === 'here' ? null : reach;
  return (
    <div className="away-snap">
      <div className="away-banner">
        <span>
          <b>Read-only snapshot</b>
          {manifest && manifest !== 'none' ? ` from ${since(manifest.at)}, taken on ${manifest.computer} and kept in your Drive.` : ', kept in your Drive.'}
          {away ? ` ${away.computer} ${away.state === 'down' ? 'isn’t answering' : 'isn’t connected here'}, so this may be behind what is there.` : ''}
        </span>
        <span className="spacer" />
        {onBring ? (
          <button type="button" className="btn sm primary" onClick={onBring} disabled={!files.length}>
            Bring the code here…
          </button>
        ) : null}
        <button type="button" className="btn sm" onClick={onBack}>
          Back
        </button>
      </div>
      <div className="away-snap-body">
        <aside className="away-snap-tree" aria-label="The snapshot's files">
          <div className="away-snap-head">
            Snapshot <span className="away-ro">read-only</span>
          </div>
          {manifest === null && !problem ? (
            <p className="pg-note">
              <span className="spinner" /> Reading it from Drive…
            </p>
          ) : null}
          {files.map((file) => (
            <button key={file.path} type="button" className={`away-snap-file${open === file.path ? ' is-on' : ''}`} onClick={() => setOpen(file.path)} title={file.path}>
              <FileIcon path={file.path} /> <span>{file.path}</span>
            </button>
          ))}
          {manifest && manifest !== 'none' && manifest.left.length ? (
            <p className="away-left">
              Not kept: {manifest.left.slice(0, 8).join(', ')}
              {manifest.left.length > 8 ? ` and ${manifest.left.length - 8} more` : ''} — data, checkpoints and large files stay on {manifest.computer}.
            </p>
          ) : null}
        </aside>
        <section className="away-snap-main">
          {problem ? (
            <p className="pg-note is-problem pg-pad">{drive ? problem : 'The snapshot is in your Google Drive: sign in with Google, with Drive, to open it.'}</p>
          ) : manifest === 'none' ? (
            <p className="pg-note pg-pad">There is no snapshot of this project in your Drive yet.</p>
          ) : open && text !== null ? (
            <CodeEditor key={open} value={text} path={open} onChange={() => undefined} readOnly />
          ) : open ? (
            <p className="pg-note pg-pad">
              <span className="spinner" /> Opening {open}…
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}

/** While the project is open where its code is, its snapshot is kept: a little after it opens, then every few minutes. */
export function useSnapshots(playground: Playground, on: boolean) {
  useEffect(() => {
    if (!on) return;
    let timer = 0;
    const take = () => {
      void takeSnapshot(playground).catch(() => undefined);
      timer = window.setTimeout(take, 3 * 60_000);
    };
    timer = window.setTimeout(take, 5_000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playground.id, on]);
}

// ------------------------------------------------- D · bring the code here --

type BringWay = 'move' | 'drive' | 'pc';

export function BringDialog({ playground, reach, onClose, onOpen }: { playground: Playground; reach: Reach; onClose: () => void; onOpen: (id: string) => void }) {
  const drive = useDriveConnected();
  const servers = useServers();
  const here = reach.state === 'here';
  const source = here ? 'home' : 'snapshot';
  const pc = servers.find((server) => server.where === 'pc' && !(playground.home.kind === 'server' && playground.home.serverId === server.id));
  const ways: { id: BringWay; title: string; tag?: string; note: string; why?: string }[] = [
    {
      id: 'move',
      title: 'Move it to your Google Drive',
      tag: 'opens everywhere',
      note: `The code is copied to Drive and the project opens from there on every computer you sign in on; it still runs on ${playground.compute.kind === 'colab' ? 'your Colab' : 'the same machine'}, with the folder copied there before each run. The old folder stays as it is.`,
      why: !here ? 'Only from where the code is: the folder has to answer to be moved' : !drive ? 'Sign in with Google, with Drive, first' : undefined,
    },
    {
      id: 'drive',
      title: 'Copy it into a new project in your Drive',
      note: `“${playground.title} (copy)”, from ${here ? 'its folder' : 'its snapshot'}. The original stays where it is.`,
      why: !drive ? 'Sign in with Google, with Drive, first' : !here && !playground.snapshot ? 'There is no snapshot to copy from' : undefined,
    },
    {
      id: 'pc',
      title: pc ? `Copy it onto this computer (${pc.name})` : 'Copy it onto this computer',
      note: `A new project in a folder on ${pc?.name ?? 'this computer'}, from ${here ? 'its folder' : 'its snapshot'}. The original stays where it is.`,
      why: !pc
        ? servers.some((server) => server.where === 'pc')
          ? 'Its code is already on this computer'
          : 'Connect this computer first: Your compute → Connect this computer'
        : !here && !playground.snapshot
          ? 'There is no snapshot to copy from'
          : undefined,
    },
  ];
  const [way, setWay] = useState<BringWay | null>(() => ways.find((w) => !w.why)?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const go = async () => {
    if (!way) return;
    setBusy(true);
    setProblem(null);
    try {
      if (way === 'move') {
        const n = await moveToDrive(playground, driveFolderName(playground.title, playground.id));
        setDone(`${n} ${n === 1 ? 'file' : 'files'} copied to your Drive: the project opens from there now, on every computer.`);
      } else {
        const made = await copyProject(playground, source, way === 'drive' ? { kind: 'drive', folder: '' } : { kind: 'server', serverId: pc!.id, root: '' });
        onOpen(made.id);
        onClose();
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="scrim away-scrim" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div className="away-dlg" role="dialog" aria-modal="true" aria-label="Bring the code here">
        <button type="button" className="icon-btn sm away-x" aria-label="Close" onClick={onClose} disabled={busy}>
          <CloseIcon size={14} />
        </button>
        <span className="eyebrow">{playground.title}</span>
        <h2>Bring the code here?</h2>
        <p>{here ? 'Its folder is on one computer. Pick how the others get it' : `${reach.computer} isn’t reachable, so a copy is made from the snapshot in your Drive`} — data, checkpoints and large files stay where they are.</p>
        {done ? (
          <p className="away-done">{done}</p>
        ) : (
          <div role="radiogroup" aria-label="How">
            {ways.map((w) => (
              <button key={w.id} type="button" role="radio" aria-checked={way === w.id} className={`away-opt${way === w.id ? ' is-on' : ''}`} disabled={Boolean(w.why) || busy} onClick={() => setWay(w.id)}>
                <span className="away-rd" aria-hidden="true" />
                <b>
                  {w.title} {w.tag ? <span className="away-tag">{w.tag}</span> : null}
                </b>
                <small>{w.why ?? w.note}</small>
              </button>
            ))}
          </div>
        )}
        {problem ? <p className="pg-note is-problem">{problem}</p> : null}
        <div className="away-dlg-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {done ? 'Done' : 'Cancel'}
          </button>
          {done ? null : (
            <button type="button" className="btn primary" disabled={!way || busy} onClick={() => void go()}>
              {busy ? 'Copying…' : way === 'move' ? 'Move to Drive' : 'Make the copy'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
