// A project on several machines: the pool row under the workspace's bar,
// one chip a machine — what it is, how it is, and a menu to connect,
// interrupt, stop or take it out — and the panel that adds one: a Colab
// machine of its own, or a Jupyter server of the person's (a Companion on
// one of their computers, a GPU box). The machines are separate computers
// that run one job each; the row says so, and docs/compute-pool.md says
// why (Colab's runtimes can call out but never be called).

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ColabState, JupyterServer } from '../lib/colab';
import { MACHINES, colabAvailable, connectIn, interruptIn, machineLabel, restartIn, sessionsNow, shutDownScope, stopRuntimeIn, subscribeColab } from '../lib/colab';
import { COLAB, isOn, serversOn } from '../lib/compute';
import type { Compute, Playground, ProjectMachine } from '../lib/playground';
import { addMachine, machinesOf, removeMachine, serverById, useServers } from '../lib/playground';
import { useStore } from '../lib/store';
import { ColabMark, attachUrl } from './Colab';
import { CloseIcon, PlusIcon } from './icons';

/** Every session in this tab, as the store has them. */
export const useSessions = () => useSyncExternalStore(subscribeColab, sessionsNow);

/** A scope's session among them: the live one when it has one, else whichever is kept. */
export const sessionOf = (sessions: ColabState[], scope: string): ColabState | undefined =>
  sessions.find((s) => s.scope === scope && (s.status === 'idle' || s.status === 'busy' || s.status === 'connecting')) ?? sessions.find((s) => s.scope === scope);

export const isConnected = (s: ColabState | undefined) => s?.status === 'idle' || s?.status === 'busy';

/** The chip's dot and words for a session, as the bar's chip has them. */
export function stateOf(s: ColabState | undefined, compute: Compute): { dot: 'busy' | 'on' | 'lost' | 'off'; text: string } {
  if (!s) return { dot: 'off', text: compute.kind === 'server' ? 'kernel not started' : 'not connected' };
  const connected = isConnected(s);
  const sample = s.sample;
  const busy = sample ? [sample.gpu ? `GPU ${sample.gpu.util}%` : '', sample.cpu !== undefined ? `CPU ${sample.cpu}%` : ''].filter(Boolean).join(' · ') : '';
  const dot = s.status === 'busy' || s.status === 'connecting' ? 'busy' : connected ? 'on' : s.status === 'lost' || s.status === 'error' ? 'lost' : 'off';
  const text = s.status === 'connecting' ? 'connecting…' : s.reconnecting ? 'reconnecting…' : s.status === 'busy' ? busy || 'running' : connected ? busy || 'idle' : s.status === 'lost' ? 'ended' : compute.kind === 'server' ? 'kernel not started' : 'not connected';
  return { dot, text };
}

/** The mark before a machine's name: Colab's, or the server's kind. */
export function MachineMark({ compute }: { compute: Compute }) {
  if (compute.kind === 'colab') return <ColabMark />;
  const where = serverById(compute.serverId)?.where ?? compute.where;
  return <span className={`pg-mark ${where === 'pc' ? 'is-pc' : 'is-gpu'}`}>{where === 'pc' ? 'PC' : 'GPU'}</span>;
}

/**
 * The row: every machine of the project, the first included, each with its
 * state and menu; and Add a machine. `open` shows the row with the add
 * panel out even before there is a pool (the bar's chip asks for that).
 */
export default function MachinePool({ playground, usable, open, onOpen, onNote }: { playground: Playground; usable: boolean; open: boolean; onOpen: (open: boolean) => void; onNote: (note: string | null) => void }) {
  const sessions = useSessions();
  const machines = machinesOf(playground);
  const [adding, setAdding] = useState(open);
  useEffect(() => {
    if (open) setAdding(true);
  }, [open]);
  if (!playground.pool?.length && !open) return null;
  return (
    <div className="pg-pool" role="group" aria-label="The machines this project runs on">
      <span className="pg-pool-label" title="Separate machines, one job each: a command run on all of them is told its rank (KOIOS_RANK) so each can take its own seed, config or slice of the data. They cannot share one job between them — see docs/compute-pool.md.">
        {machines.length} {machines.length === 1 ? 'machine' : 'machines'} · one job each
      </span>
      {machines.map((machine) => (
        <PoolChip key={machine.scope} playground={playground} machine={machine} session={sessionOf(sessions, machine.scope)} usable={usable} onNote={onNote} />
      ))}
      <AddMachine
        playground={playground}
        open={adding}
        onOpen={(next) => {
          setAdding(next);
          if (!next) onOpen(false);
        }}
        onNote={onNote}
      />
      {!playground.pool?.length ? (
        <button type="button" className="icon-btn sm" aria-label="Hide" title="Hide the row" onClick={() => (setAdding(false), onOpen(false))}>
          <CloseIcon size={13} />
        </button>
      ) : null}
    </div>
  );
}

function PoolChip({ playground, machine, session, usable, onNote }: { playground: Playground; machine: ProjectMachine; session: ColabState | undefined; usable: boolean; onNote: (note: string | null) => void }) {
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const away = (event: MouseEvent) => !box.current?.contains(event.target as Node) && setMenu(false);
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [menu]);
  const { dot, text } = stateOf(session, machine.compute);
  const connected = isConnected(session);
  const first = machine.member === null;
  const name = session?.runtime && machine.compute.kind === 'colab' ? `Colab · ${machineLabel(session.runtime)}` : machine.label;
  const canConnect = Boolean(machine.backend) && (machine.compute.kind === 'server' || usable);
  const take = async () => {
    if (!machine.member) return;
    setMenu(false);
    if (session?.status === 'busy') {
      if (!window.confirm(`${name} is running something. Take it out of the project anyway? What runs there is interrupted.`)) return;
      await interruptIn(machine.scope).catch(() => undefined);
    }
    removeMachine(playground.id, machine.member);
    // Its machine stops (Colab: no more units) or its kernel ends; nothing of the project is left running there unseen.
    await shutDownScope(machine.scope, machine.compute.kind === 'server' ? serverById(machine.compute.serverId) : undefined).catch(() => undefined);
    onNote(`${name} is out of the project. Its files there stay where they are until the machine stops.`);
  };
  return (
    <div className="menu-wrap" ref={box}>
      <button type="button" className={`colab-chip pg-chip pg-pool-chip is-${dot}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} title={`Machine ${machine.rank} of ${1 + (playground.pool?.length ?? 0)}: ${name} · ${text}${session?.sharing ? ` · ${session.sharing}` : ''}`}>
        <span className="pg-pool-rank" aria-hidden="true">
          {machine.rank}
        </span>
        <MachineMark compute={machine.compute} />
        <span className={`colab-dot is-${dot}`} aria-hidden="true" />
        {name} · {text}
      </button>
      {menu ? (
        <div className="menu pg-chip-menu" role="menu">
          <div className="menu-label">Machine {machine.rank}</div>
          <p className="pg-chip-note">
            <b>{name}</b>
            {session?.specs?.gpuName ? ` · ${session.specs.gpuName}` : ''}
            {session?.specs?.ramTotalMb ? ` · ${Math.round(session.specs.ramTotalMb / 1024)} GB RAM` : ''}
            {first ? <small className="pg-chip-secure">The project's first machine: the bar's chip changes it.</small> : <small className="pg-chip-secure">KOIOS_RANK={machine.rank} for a command run on all machines</small>}
            {session?.sharing ? <small className="pg-chip-secure pg-bad">{session.sharing}</small> : null}
          </p>
          {!connected ? (
            <button
              type="button"
              role="menuitem"
              disabled={!canConnect || session?.status === 'connecting'}
              onClick={() => {
                setMenu(false);
                if (machine.backend) void connectIn(machine.backend, machine.scope).catch((error) => onNote(error instanceof Error ? error.message : String(error)));
              }}
            >
              {session?.status === 'connecting' ? 'Connecting…' : 'Connect now'}
            </button>
          ) : (
            <>
              <button type="button" role="menuitem" disabled={session?.status !== 'busy'} title="Stops what runs there now, as Ctrl-C would; the kernel and its variables stay" onClick={() => (setMenu(false), void interruptIn(machine.scope))}>
                Interrupt
              </button>
              <button type="button" role="menuitem" disabled={session?.status === 'busy'} title="Forgets every variable; keeps the machine and the files on it" onClick={() => (setMenu(false), void restartIn(machine.scope))}>
                Restart the kernel
              </button>
              {session?.runtime && machine.compute.kind === 'colab' ? (
                <a role="menuitem" className="pg-chip-link" href={attachUrl(session.runtime.endpoint)} target="_blank" rel="noreferrer noopener" title="Colab's own notebook page on the same machine">
                  Open this runtime in Colab ↗
                </a>
              ) : null}
              <hr />
              <button type="button" role="menuitem" onClick={() => (setMenu(false), void stopRuntimeIn(machine.scope))}>
                {machine.compute.kind === 'colab' ? 'Stop the Colab runtime' : 'Shut down the kernel'}
              </button>
            </>
          )}
          {!first ? (
            <>
              <hr />
              <button type="button" role="menuitem" onClick={() => void take()}>
                Take it out of the project
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Add a machine: Colab's kinds, and the servers that are on in Settings → Compute. */
function AddMachine({ playground, open, onOpen, onNote }: { playground: Playground; open: boolean; onOpen: (open: boolean) => void; onNote: (note: string | null) => void }) {
  const { settings } = useStore();
  const servers = serversOn(settings, useServers());
  const colabOn = isOn(settings, COLAB) && colabAvailable(settings.googleClientId);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => !box.current?.contains(event.target as Node) && onOpen(false);
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [open, onOpen]);
  const add = (compute: Compute, what: string) => {
    onOpen(false);
    const made = addMachine(playground.id, compute);
    if (made) onNote(`${what} is in the project as machine ${1 + (playground.pool?.length ?? 0)}. Connect it from its chip, or run a command on it: it connects on the first.`);
  };
  const taken = (server: JupyterServer) => machinesOf(playground).some((m) => m.compute.kind === 'server' && m.compute.serverId === server.id);
  return (
    <div className="menu-wrap" ref={box}>
      <button type="button" className="btn sm ghost" onClick={() => onOpen(!open)} aria-haspopup="menu" aria-expanded={open} title="One more machine for this project: a Colab machine of its own, or a computer of yours">
        <PlusIcon size={13} /> Add a machine
      </button>
      {open ? (
        <div className="menu pg-chip-menu pg-pool-add" role="menu">
          <div className="menu-label">On Colab · a machine of its own</div>
          {MACHINES.map((option) => (
            <button key={option.accelerator} type="button" role="menuitem" className="pg-chip-two" disabled={!colabOn} title={colabOn ? undefined : 'Colab needs Settings → Google and Settings → Paper proxy, and to be on in Settings → Compute'} onClick={() => add({ kind: 'colab', machine: { accelerator: option.accelerator } }, `Colab · ${option.label}`)}>
              <ColabMark /> {option.label} <small className="pg-chip-sub">{option.note}</small>
            </button>
          ))}
          {servers.length ? <div className="menu-label">Your computers and servers</div> : null}
          {servers.map((server) => (
            <button key={server.id} type="button" role="menuitem" className="pg-chip-two" disabled={taken(server)} title={taken(server) ? 'Already in the project' : `Cells and commands run in a kernel on ${server.name}`} onClick={() => add({ kind: 'server', serverId: server.id, deviceId: server.companionId, name: server.name, where: server.where === 'pc' ? 'pc' : 'remote' }, server.name)}>
              <span className={`pg-mark ${server.where === 'pc' ? 'is-pc' : 'is-gpu'}`}>{server.where === 'pc' ? 'PC' : 'GPU'}</span> {server.name}
              <small className="pg-chip-sub">{server.where === 'pc' ? 'this computer, through its Companion' : 'a server of yours'}</small>
            </button>
          ))}
          <p className="pg-chip-note pg-pool-note">
            <b>Separate machines, one job each.</b> A command run on all of them starts on every machine with KOIOS_RANK, KOIOS_WORLD and KOIOS_MACHINE set, for a sweep or a few seeds side by side. They cannot share one training run: Colab’s machines take no incoming connections, so there is no link between them fast enough for that. Colab also allows only so many machines at once on a plan (one on the free tier); past that, a new one shares the browser’s. More in docs/compute-pool.md.
          </p>
        </div>
      ) : null}
    </div>
  );
}
