// Storage & compute, for one project (docs/storage-moves.md): every place its files could be kept that is
// connected now — Google Drive, each of your computers with the Companion, its own Colab machine's disk — with the
// free space there, and every machine it could run on, with whether it is on and what it has. "Move files here"
// starts a move done by the machines themselves (src/lib/moves.ts); "Run here" changes the machine and leaves the
// files where they are. The move's progress shows here and in a strip above the editor, from any page of the
// project, until it is done and the old copy is removed or kept.

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiBase } from '../lib/api';
import type { JupyterServer } from '../lib/colab';
import { checkJupyter, colabAvailable, MACHINES, shutDownScope } from '../lib/colab';
import { COLAB, isOn, serversOn } from '../lib/compute';
import { driveFetch } from '../lib/google';
import { useLive } from '../lib/liveRoom';
import type { Destination } from '../lib/movePlan';
import { computeChangeRefused, homeFor, planOf, sameHome, sizeOf, stepWords } from '../lib/movePlan';
import type { MoveState } from '../lib/moves';
import { isNewer } from '../lib/companion';
import { cancelMove, companionDisk, MOVER_VERSION, kernelDisk, keepOldCopy, keyOf, moveStatus, removeOldCopy, renewDriveToken, settleMove, startMove, startUnpack, workerAddress } from '../lib/moves';
import { driveFolderName } from '../lib/driveFiles';
import type { Compute, FilesHome, Playground } from '../lib/playground';
import { driveConnected, driveTokenNow, machineRoot, serverById, updatePlayground, useDriveConnected, useServers } from '../lib/playground';
import { useStore } from '../lib/store';
import { ColabMark } from './Colab';
import { MachineMark } from './MachinePool';
import { CloseIcon } from './icons';
import { isCompanion } from './VsCodeExtension';

const POLL_MS = 3000;
const REMOVE_OLD_KEY = 'reader.moves.removeOld';
const DRIVE_RENEW_MS = 20 * 60_000;
/** How long the page leaves a computer with the Companion to be told by the Worker before it tells it itself. */
const WORKER_FIRST_MS = 20_000;

/**
 * The project's move, followed from this page: its state read every few seconds; the unpack started from here when
 * the destination can't be told by the Worker; the Google token renewed for a Drive move; the project's home
 * changed once every file is in and checked.
 */
export function useMove(playground: Playground, connected: boolean): { move: MoveState | null; problem: string | null } {
  const [move, setMove] = useState<MoveState | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const asked = useRef<{ unpack?: string; renewed?: number; packedAt?: number }>({});
  const moving = playground.moving;
  const latest = useRef(playground);
  latest.current = playground;
  useEffect(() => {
    if (!moving) {
      setMove(null);
      return;
    }
    let live = true;
    let timer = 0;
    let last = '';
    const tick = async () => {
      try {
        const now = await moveStatus(moving.id);
        if (!live) return;
        last = now.status;
        setMove(now);
        setProblem(null);
        const p = latest.current;
        if (now.status === 'done') {
          await settleMove(p, now);
          return;
        }
        // A move to or from Drive: the token handed on again before it runs out, and at once when a machine waits for one.
        if (now.plan !== 'archive' && keyOf(now.id) !== null && (now.step === 'waiting' || Date.now() - (asked.current.renewed ?? now.created) > DRIVE_RENEW_MS)) {
          asked.current.renewed = Date.now();
          void renewDriveToken(now.id).catch(() => undefined);
        }
        if (now.status === 'packed') {
          asked.current.packedAt ??= Date.now();
          const companionFirst = Boolean(now.to.deviceId) && Date.now() - asked.current.packedAt < WORKER_FIRST_MS;
          if (!companionFirst && asked.current.unpack !== now.id) {
            asked.current.unpack = now.id;
            const started = await startUnpack(p, now, connected, workerAddress(apiBase())).catch((error: unknown) => {
              setProblem(error instanceof Error ? error.message : String(error));
              return false;
            });
            if (!started) asked.current.unpack = undefined;
          }
        }
      } catch (error) {
        if (live) setProblem(error instanceof Error ? error.message : String(error));
      }
      if (live && !['done', 'cancelled'].includes(last)) timer = window.setTimeout(() => void tick(), document.hidden ? POLL_MS * 4 : POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moving?.id, connected]);
  // The old copy, when the move was to delete it and the Worker couldn't (Colab's disk, a computer that was off): done
  // from here once, as soon as the old place can be reached from this page.
  const removing = useRef<string | null>(null);
  const wanted = playground.movedFrom?.removeWanted && !playground.movedFrom.removed ? playground.movedFrom.move : null;
  useEffect(() => {
    if (!wanted || removing.current === `${wanted}:${connected}`) return;
    removing.current = `${wanted}:${connected}`;
    void removeOldCopy(latest.current, connected, '').catch(() => undefined);
  }, [wanted, connected]);
  return { move, problem };
}

const percent = (move: MoveState) => {
  const { bytes, totalBytes, files, totalFiles } = move.progress;
  const share = totalBytes ? bytes / totalBytes : totalFiles ? files / totalFiles : 0;
  // Two halves for an archive: packed, then unpacked.
  const half = move.plan === 'archive' ? (['packed', 'unpacking', 'unpacked', 'done'].includes(move.status) ? 0.5 + share / 2 : share / 2) : share;
  return Math.max(0, Math.min(1, move.status === 'done' ? 1 : half));
};

/** The move as one line and a bar: in the strip above the editor, and in the panel. */
export function MoveProgress({ playground, move, problem, compact, onShow }: { playground: Playground; move: MoveState | null; problem: string | null; compact?: boolean; onShow?: () => void }) {
  if (!playground.moving) return null;
  const failed = move?.status === 'failed';
  const words = move ? (failed ? `It stopped: ${move.error ?? 'an error on the machine'}` : stepWords(move.step, move.plan, move.from.label, move.to.label)) : 'Asking the proxy how the move is going…';
  return (
    <div className={`mv-progress${compact ? ' is-compact' : ''}${failed ? ' is-problem' : ''}`} role="status">
      <div className="mv-progress-line">
        <b>{move ? `Moving the files to ${move.to.label}` : 'Moving the files'}</b>
        <span>{words}</span>
        {move?.progress.totalFiles ? (
          <small>
            {move.progress.files.toLocaleString('en')} / {move.progress.totalFiles.toLocaleString('en')} files · {sizeOf(move.progress.bytes)} / {sizeOf(move.progress.totalBytes)}
          </small>
        ) : null}
        <span className="spacer" />
        {onShow ? (
          <button type="button" className="link" onClick={onShow}>
            Details
          </button>
        ) : null}
        <button type="button" className="link" onClick={() => void cancelMove(playground)}>
          {failed ? 'Dismiss' : 'Cancel'}
        </button>
      </div>
      {move && !failed ? (
        <div className="mv-bar" aria-hidden="true">
          <i style={{ width: `${Math.round(percent(move) * 100)}%` }} />
        </div>
      ) : null}
      {problem ? <p className="pg-note is-problem">{problem}</p> : null}
      {!compact ? <p className="hint">The machines do this themselves: closing this page doesn’t stop it. Edits saved meanwhile stay in the old place — save them after the move.</p> : null}
    </div>
  );
}

interface Place {
  key: string;
  label: string;
  detail: string;
  icon: React.ReactNode;
  to: Destination;
  free?: number | null;
  total?: number | null;
  /** Whether its free space has been asked: '—' then, rather than "checking…", when it couldn't say. */
  checked: boolean;
  online: boolean | null;
  /** Its state in a word or two: online, offline, not signed in. */
  state?: string;
  blocked?: string;
}

interface Machine {
  key: string;
  label: string;
  detail: string;
  icon: React.ReactNode;
  compute: Compute;
  online: boolean | null;
}

function Meter({ free, total, checked }: { free?: number | null; total?: number | null; checked: boolean }) {
  if (!total) return <small className="mv-free">{checked ? '—' : 'checking…'}</small>;
  const used = Math.max(0, Math.min(1, 1 - (free ?? 0) / total));
  return (
    <span className="mv-free" title={`${sizeOf(free)} free of ${sizeOf(total)}`}>
      <span className="mv-meter" aria-hidden="true">
        <i style={{ width: `${Math.round(used * 100)}%` }} />
      </span>
      <small>{sizeOf(free)} free</small>
    </span>
  );
}

export default function StoragePanel({ playground, machineName, connected, move, problem, onConnect, onClose, onNote }: { playground: Playground; machineName: string; connected: boolean; move: MoveState | null; problem: string | null; onConnect: () => void; onClose: () => void; onNote: (note: string | null) => void }) {
  const { settings } = useStore();
  const servers = serversOn(settings, useServers(), playground.compute.kind === 'server' ? playground.compute.serverId : undefined);
  const driveOn = useDriveConnected();
  const live = useLive();
  const shared = Boolean(live.room) && live.status === 'live';
  const [disks, setDisks] = useState<Record<string, { free: number; total: number; version?: string } | null | undefined>>({});
  const [online, setOnline] = useState<Record<string, boolean | null>>({});
  const [looked, setLooked] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // "Delete the old copy once every file is checked": this browser remembers the choice.
  const [removeOld, setRemoveOldState] = useState(() => {
    try {
      return localStorage.getItem(REMOVE_OLD_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setRemoveOld = (next: boolean) => {
    setRemoveOldState(next);
    try {
      localStorage.setItem(REMOVE_OLD_KEY, next ? '1' : '0');
    } catch {
      // only a convenience
    }
  };
  const [error, setError] = useState<string | null>(null);
  const [colabMachine, setColabMachine] = useState(playground.compute.kind === 'colab' ? playground.compute.machine.accelerator : 'NONE');
  const companions = servers.filter(isCompanion);

  const look = useCallback(async () => {
    const found: typeof disks = {};
    const up: typeof online = {};
    await Promise.all([
      ...companions.map(async (server) => {
        const info = await companionDisk(server, '', true);
        found[server.id] = info;
        up[server.id] = Boolean(info) || (await checkJupyter(server)).ok;
      }),
      ...servers
        .filter((server) => !isCompanion(server))
        .map(async (server) => {
          up[server.id] = (await checkJupyter(server)).ok;
        }),
      (async () => {
        if (!driveConnected()) return;
        try {
          const quota = (await (await driveFetch(await driveTokenNow(), 'https://www.googleapis.com/drive/v3/about?fields=storageQuota')).json()) as { storageQuota?: { limit?: string; usage?: string } };
          const limit = Number(quota.storageQuota?.limit ?? 0);
          found.drive = limit ? { free: limit - Number(quota.storageQuota?.usage ?? 0), total: limit } : null;
        } catch {
          found.drive = null;
        }
      })(),
      (async () => {
        if (playground.compute.kind !== 'colab' || !connected) return;
        found.machine = await kernelDisk(playground.id, machineRoot({ ...playground, home: { kind: 'machine' } }));
      })(),
    ]);
    setDisks(found);
    setOnline(up);
    setLooked(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers.map((s) => s.id).join(' '), connected, driveOn]);
  useEffect(() => {
    void look();
  }, [look]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && (event.stopPropagation(), onClose());
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const places: Place[] = [
    { key: 'drive', label: 'Google Drive', detail: driveOn ? 'Your account’s Drive · reached from anywhere' : 'Sign in with Google, with Drive, to keep files there', icon: <span className="pg-mark is-drive">▲</span>, to: { kind: 'drive' }, free: disks.drive?.free, total: disks.drive?.total, checked: looked || !driveOn, online: driveOn, state: driveOn ? 'connected' : 'not signed in', blocked: driveOn ? undefined : 'Drive isn’t connected' },
    ...companions.map((server): Place => {
      const info = disks[server.id];
      return {
        key: server.id,
        label: server.name,
        detail: `${server.where === 'pc' ? 'This computer' : 'Your computer'} · the Koios Companion${online[server.id] && (info === null || isNewer(MOVER_VERSION, info?.version ?? '0')) ? ` — update it to ${MOVER_VERSION} to move files` : ''}`,
        icon: <span className={`pg-mark ${server.where === 'pc' ? 'is-pc' : 'is-gpu'}`}>{server.where === 'pc' ? 'PC' : 'GPU'}</span>,
        to: { kind: 'server', serverId: server.id, name: server.name, ...(server.companionId ? { deviceId: server.companionId } : {}) },
        free: info?.free,
        total: info?.total,
        checked: looked,
        online: online[server.id] ?? null,
        blocked: online[server.id] === false ? 'Offline' : info === null || isNewer(MOVER_VERSION, info?.version ?? '0') ? `Needs Companion ${MOVER_VERSION}` : undefined,
      };
    }),
    ...(playground.compute.kind === 'colab'
      ? [{ key: 'machine', label: `${machineName}’s disk`, detail: 'Fastest for runs; gone when the runtime is', icon: <ColabMark />, to: { kind: 'machine' } as Destination, free: disks.machine?.free, total: disks.machine?.total, checked: looked || !connected, online: connected, state: connected ? 'connected' : 'not connected', blocked: connected ? undefined : 'Not connected' }]
      : []),
  ];
  const colabOn = isOn(settings, COLAB) || playground.compute.kind === 'colab';
  const machines: Machine[] = [
    ...(colabOn && colabAvailable(settings.googleClientId) ? [{ key: 'colab', label: 'Your Colab', detail: MACHINES.find((m) => m.accelerator === colabMachine)?.note ?? 'Google’s machine, on your account', icon: <ColabMark />, compute: { kind: 'colab', machine: { accelerator: colabMachine } } as Compute, online: true }] : []),
    ...servers.map(
      (server: JupyterServer): Machine => ({
        key: server.id,
        label: server.name,
        detail: isCompanion(server) ? `${server.where === 'pc' ? 'This computer' : 'Your computer'} · the Koios Companion` : 'A Jupyter server of yours',
        icon: <MachineMark compute={{ kind: 'server', serverId: server.id }} />,
        compute: { kind: 'server', serverId: server.id, ...(server.companionId ? { deviceId: server.companionId } : {}) },
        online: online[server.id] ?? null,
      }),
    ),
  ];
  const isHere = (to: Destination) => sameHome(playground.home, homeFor(playground, to, driveFolderName));
  const runsHere = (compute: Compute) => (compute.kind === 'colab' ? playground.compute.kind === 'colab' && playground.compute.machine.accelerator === compute.machine.accelerator : playground.compute.kind === 'server' && playground.compute.serverId === compute.serverId);

  const moveTo = async (place: Place) => {
    setError(null);
    setBusy(place.key);
    try {
      if (removeOld && !confirm(`Move the files to ${place.label}, then delete the copy in ${homeName}? It is deleted only once every file is in ${place.label} and checked${playground.home.kind === 'drive' ? ', and Drive keeps it in the bin for 30 days' : ''}.`)) return;
      await startMove(playground, place.to, machineName, connected, { removeOld });
      onNote(`Moving the files to ${place.label}: the machines do it themselves, and the project switches over once every file is in and checked${removeOld ? `; then the copy in ${homeName} is deleted` : ''}.`);
    } catch (problemNow) {
      setError(problemNow instanceof Error ? problemNow.message : String(problemNow));
    } finally {
      setBusy(null);
    }
  };
  const runOn = (machine: Machine) => {
    setError(null);
    const refused = computeChangeRefused(playground.home, playground.compute, machine.compute);
    if (refused) return setError(refused);
    const ownColab = (c: Compute) => c.kind === 'colab' && !c.shared;
    if (ownColab(playground.compute) && !(machine.compute.kind === 'colab')) void shutDownScope(playground.id);
    updatePlayground(playground.id, { compute: machine.compute });
    onNote(`Code now runs on ${machine.label}; the files stay where they are${playground.home.kind === 'server' && machine.compute.kind === 'server' && playground.home.serverId === machine.compute.serverId ? '' : ', copied to it before each command'}. Its kernel starts fresh.`);
  };

  const homeName = playground.home.kind === 'drive' ? 'Google Drive' : playground.home.kind === 'server' ? (serverById(playground.home.serverId)?.name ?? playground.home.name ?? 'a computer') : playground.home.kind === 'machine' ? `${machineName}’s disk` : 'this browser';
  const last = playground.movedFrom ?? null;
  const oldName = last ? (last.home.kind === 'drive' ? 'Google Drive' : last.home.kind === 'server' ? (serverById(last.home.serverId)?.name ?? last.home.name ?? 'a computer') : `${machineName}’s disk`) : '';

  return (
    <div className="scrim pg-scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="sheet pg-sheet mv-sheet" role="dialog" aria-label="Storage and compute">
        <header className="pg-sheet-head">
          <div>
            <span className="eyebrow">Storage & compute</span>
            <h2>Where this project lives and runs</h2>
            <p>
              Files kept in <b>{homeName}</b> · code runs on <b>{machineName}</b>. Either can change on its own; a move is done by the machines themselves, so it is fast and goes on with this page closed.
            </p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon size={17} />
          </button>
        </header>
        <div className="mv-body">
        {shared ? <p className="banner warn">This project is shared with others right now: its storage and machine stay as they are while it is.</p> : null}
        <MoveProgress playground={playground} move={move} problem={problem} />
        {last && !playground.moving ? (
          <div className="mv-old">
            <div className="mv-old-line">
              <span>
                Moved from <b>{oldName}</b> {new Date(last.at).toLocaleDateString()}.{' '}
                {last.removed ? (last.home.kind === 'drive' ? 'Its old copy is in Drive’s bin (kept there 30 days).' : 'Its old copy was deleted.') : last.removeWanted ? `Its old copy is deleted as soon as ${oldName} can be reached.` : 'The old copy is still there.'}
              </span>
              <span className="spacer" />
              {!last.removed ? (
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy !== null}
                  onClick={async () => {
                    if (!confirm(`Delete the old copy in ${oldName}? The files in ${homeName} were checked against it; this can't be undone${last.home.kind === 'drive' ? ' (Drive keeps it in the bin for 30 days)' : ''}.`)) return;
                    setBusy('remove');
                    setError(null);
                    try {
                      await removeOldCopy(playground, connected, machineName);
                    } catch (problemNow) {
                      setError(problemNow instanceof Error ? problemNow.message : String(problemNow));
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {busy === 'remove' ? 'Deleting…' : last.removeWanted ? 'Delete it now' : 'Delete the old copy'}
                </button>
              ) : null}
              <button type="button" className="link" onClick={() => keepOldCopy(playground)}>
                {last.removed ? 'Dismiss' : 'Keep it'}
              </button>
            </div>
            {last.conflicts ? (
              <p className="mv-met">
                <b>{last.conflicts === 1 ? '1 file' : `${last.conflicts} files`} had changed in both places.</b> The newer copy is in place; the version that was already in {homeName} is kept beside {last.conflicts === 1 ? 'it' : 'each'} as “name (conflict {new Date(last.at).toISOString().slice(0, 10)}).ext”, for you to compare: {last.conflictPaths?.slice(0, 6).join(', ')}
                {(last.conflictPaths?.length ?? 0) > 6 ? '…' : ''}
              </p>
            ) : null}
            {last.kept ? <p className="mv-met">{last.kept === 1 ? '1 file' : `${last.kept} files`} made in {homeName} after the project left it {last.kept === 1 ? 'was' : 'were'} kept.</p> : null}
          </div>
        ) : null}
        {error ? <p className="banner error">{error}</p> : null}

        <section className="mv-section" aria-label="Storage">
          <h3>Storage</h3>
          <p className="hint">Where the files are kept. Everything moves, checkpoints and data included; caches (__pycache__, virtual environments) are rebuilt instead. Moving back to a place with an older copy loses nothing: files changed in both places are kept side by side.</p>
          <label className="mv-check">
            <input type="checkbox" checked={removeOld} onChange={(event) => setRemoveOld(event.target.checked)} disabled={Boolean(playground.moving)} />
            <span>
              <b>Delete the copy in {homeName} after the move</b> — once every file is in the new place and checked, to free its space{playground.home.kind === 'drive' ? ' (Drive keeps it in the bin for 30 days)' : ''}. Off: it stays, and you choose later.
            </span>
          </label>
          <ul className="mv-list">
            {places.map((place) => {
              const here = isHere(place.to);
              const refused = here ? null : (() => { const p = planOf(playground.home, homeFor(playground, place.to, driveFolderName)); return 'refused' in p ? p.refused : null; })();
              return (
                <li key={place.key} className={here ? 'is-here' : ''}>
                  {place.icon}
                  <span className="mv-name">
                    <b>{place.label}</b>
                    <small>
                      <i className={`mv-dot is-${place.online === null ? 'unknown' : place.online ? 'on' : 'off'}`} aria-hidden="true" /> {place.state ?? (place.online === null ? 'checking' : place.online ? 'online' : 'offline')} · {place.detail}
                    </small>
                  </span>
                  <Meter free={place.free} total={place.total} checked={place.checked} />
                  {here ? (
                    <span className="mv-here">Files are here</span>
                  ) : (
                    <button type="button" className="btn sm" disabled={shared || Boolean(playground.moving) || Boolean(place.blocked) || Boolean(refused) || busy !== null} title={place.blocked ?? refused ?? undefined} onClick={() => void moveTo(place)}>
                      {busy === place.key ? 'Starting…' : 'Move files here'}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="mv-section" aria-label="Compute">
          <h3>Compute</h3>
          <p className="hint">Where the code runs. Changing it leaves the files where they are; the new machine’s kernel starts fresh.</p>
          <ul className="mv-list">
            {machines.map((machine) => {
              const here = runsHere(machine.compute);
              return (
                <li key={machine.key} className={here ? 'is-here' : ''}>
                  {machine.icon}
                  <span className="mv-name">
                    <b>{machine.label}</b>
                    <small>
                      <i className={`mv-dot is-${machine.online === null ? 'unknown' : machine.online ? 'on' : 'off'}`} aria-hidden="true" /> {machine.online === null ? 'checking' : machine.online ? 'available' : 'offline'} · {machine.detail}
                    </small>
                  </span>
                  {machine.key === 'colab' ? (
                    <select className="cli-select" value={colabMachine} onChange={(event) => setColabMachine(event.target.value as typeof colabMachine)} aria-label="Colab machine">
                      {MACHINES.map((option) => (
                        <option key={option.accelerator} value={option.accelerator}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span />
                  )}
                  {here ? (
                    <span className="mv-here">
                      Runs here
                      {!connected ? (
                        <button type="button" className="btn sm" onClick={onConnect}>
                          Start it
                        </button>
                      ) : null}
                    </span>
                  ) : (
                    <button type="button" className="btn sm" disabled={shared || machine.online === false} onClick={() => runOn(machine)}>
                      Run here
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
        </div>
        <footer className="pg-sheet-foot">
          <span className="hint">Add a computer under Settings → Compute: install the Companion there and pair it, and it shows up here.</span>
          <span className="spacer" />
          <button type="button" className="btn sm ghost" onClick={() => void look()}>
            Check again
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Whether a home is one a move can leave: a browser's isn't. */
export const movable = (home: FilesHome) => home.kind !== 'browser';
