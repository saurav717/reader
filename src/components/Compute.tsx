// Turning compute on and off: Colab, your computers and the servers you
// added. Each has a switch — on, it is offered wherever you choose where code
// runs; off, it is left out until turned on again — and, while it runs, Stop:
// Colab's runtimes, which spend units, and a Companion, which can be started
// again from here on this computer. Settings → Compute has all of it; where
// else it shows is the choice there (types.ts, `COMPUTE_CONTROLS`): switches
// where a project's code is set up, and a chip in the rail.

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { useStore } from '../lib/store';
import { COLAB, computeId, isOn, switched } from '../lib/compute';
import { checkJupyter, colabAvailable, machineLabel, serverBase, sessionsNow, stopColabRuntimes, subscribeColab, type JupyterServer } from '../lib/colab';
import { findCompanion, shutdownCompanion, startCompanion, STARTABLE } from '../lib/companion';
import { useServers } from '../lib/playground';
import { isCompanion } from './VsCodeExtension';

/** Whether a place to run is on, and the way to turn it on or off. */
export function useComputeSwitch() {
  const { settings, updateSettings } = useStore();
  return {
    on: (id: string) => isOn(settings, id),
    set: (id: string, on: boolean) => updateSettings({ computeOff: switched(settings.computeOff, id, on) }),
  };
}

/** One place's switch. */
export function ComputeSwitch({ id, label, small = false }: { id: string; label: string; small?: boolean }) {
  const { on, set } = useComputeSwitch();
  const value = on(id);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={`${label}: ${value ? 'on' : 'off'}`}
      title={value ? `${label} is on: offered wherever you choose where code runs. Turn it off to leave it out.` : `${label} is off: left out of every choice of where to run. Turn it on to offer it again.`}
      className={`cp-switch${value ? ' is-on' : ''}${small ? ' is-small' : ''}`}
      onClick={(event) => {
        event.stopPropagation();
        set(id, !value);
      }}
    >
      <i aria-hidden="true" />
    </button>
  );
}

/** Colab's runtimes this tab has, by machine: what spends units. */
function useColabRuntimes() {
  const sessions = useSyncExternalStore(subscribeColab, sessionsNow);
  const seen = new Map<string, { label: string; rate?: number }>();
  for (const session of sessions) {
    if (session.backend.kind !== 'colab' || !session.runtime) continue;
    if (!seen.has(session.runtime.endpoint)) seen.set(session.runtime.endpoint, { label: machineLabel(session.runtime), rate: session.units?.ratePerHour });
  }
  return [...seen.values()];
}

type Power = 'up' | 'down' | 'checking' | 'starting' | 'stopping';

/** Whether each server answers, asked when the list shows and again on asking. */
function useServerPower(servers: JupyterServer[]) {
  const [power, setPower] = useState<Record<string, Power>>({});
  const key = servers.map((server) => `${server.id}@${server.url}`).join(' ');
  const ask = (list = servers) => {
    for (const server of list) {
      setPower((current) => ({ ...current, [server.id]: 'checking' }));
      const answer = isCompanion(server) ? findCompanion(serverBase(server.url), 2500).then(Boolean) : checkJupyter(server).then((result) => result.ok);
      void answer.then((up) => setPower((current) => (current[server.id] === 'checking' ? { ...current, [server.id]: up ? 'up' : 'down' } : current)));
    }
  };
  useEffect(() => {
    ask();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { power, setPower, ask };
}

/**
 * Every place to run, with its switch and, while it runs, Stop (or Start, for
 * a Companion on this computer that is off). `compact` is the rail's.
 */
export function ComputeList({ compact = false }: { compact?: boolean }) {
  const { settings } = useStore();
  const servers = useServers();
  const runtimes = useColabRuntimes();
  const { power, setPower, ask } = useServerPower(servers);
  const [note, setNote] = useState<Record<string, string>>({});
  const [stoppingColab, setStoppingColab] = useState(false);
  const colabReady = colabAvailable(settings.googleClientId);
  const say = (id: string, text: string) => setNote((current) => ({ ...current, [id]: text }));

  const stop = async (server: JupyterServer) => {
    setPower((current) => ({ ...current, [server.id]: 'stopping' }));
    try {
      await shutdownCompanion(server);
      setPower((current) => ({ ...current, [server.id]: 'down' }));
      say(server.id, 'Stopped: no Jupyter server, no kernels. It stays off, at the next login too, until it is started again.');
    } catch (error) {
      setPower((current) => ({ ...current, [server.id]: 'up' }));
      say(server.id, error instanceof Error ? error.message : String(error));
    }
  };
  const start = async (server: JupyterServer) => {
    setPower((current) => ({ ...current, [server.id]: 'starting' }));
    const info = await startCompanion(server.url, 60_000);
    setPower((current) => ({ ...current, [server.id]: info ? 'up' : 'down' }));
    say(server.id, info ? '' : `It didn’t start from here. Open the Reader app on this computer, or run reader-companion start. (A Companion starts from the page from ${STARTABLE} on.)`);
  };

  return (
    <div className={`cp-list${compact ? ' is-compact' : ''}`}>
      <div className={`cp-row${isOn(settings, COLAB) ? '' : ' is-off'}`}>
        <span className="cp-mark is-colab">co</span>
        <span className="cp-what">
          <b>Google Colab</b>
          <small>
            {!colabReady
              ? 'needs set-up: a Google client ID and the paper proxy'
              : runtimes.length
                ? `running · ${runtimes.map((runtime) => runtime.label).join(', ')}${runtimes.some((runtime) => runtime.rate) ? ` · ${runtimes.reduce((sum, runtime) => sum + (runtime.rate ?? 0), 0).toFixed(2)} units/h` : ''}`
                : isOn(settings, COLAB)
                  ? 'nothing running'
                  : 'off'}
          </small>
          {note.colab ? <small className="cp-note">{note.colab}</small> : null}
        </span>
        {runtimes.length ? (
          <button
            type="button"
            className="btn sm"
            disabled={stoppingColab}
            title="Stops every Colab runtime this tab has: no more units are spent"
            onClick={async () => {
              setStoppingColab(true);
              await stopColabRuntimes();
              setStoppingColab(false);
              say(COLAB, 'Stopped: the runtimes are gone, and their variables with them.');
            }}
          >
            {stoppingColab ? 'Stopping…' : 'Stop'}
          </button>
        ) : null}
        <ComputeSwitch id={COLAB} label="Colab" small={compact} />
      </div>
      {servers.map((server) => {
        const id = computeId(server);
        const state = power[server.id];
        const companion = isCompanion(server);
        const busy = state === 'checking' || state === 'starting' || state === 'stopping';
        return (
          <div key={server.id} className={`cp-row${isOn(settings, id) ? '' : ' is-off'}`}>
            <span className={`cp-mark${server.where === 'pc' || companion ? ' is-pc' : ' is-gpu'}`}>{server.where === 'pc' || companion ? 'PC' : 'GPU'}</span>
            <span className="cp-what">
              <b>{server.name}</b>
              <small>
                <i className={`cp-dot is-${state ?? 'checking'}`} aria-hidden="true" />
                {state === 'up'
                  ? companion
                    ? 'running'
                    : 'answering'
                  : state === 'down'
                    ? companion
                      ? server.where === 'pc'
                        ? 'stopped'
                        : 'offline'
                      : 'not answering'
                    : state === 'starting'
                      ? 'starting…'
                      : state === 'stopping'
                        ? 'stopping…'
                        : 'asking…'}
                {isOn(settings, id) ? '' : ' · off'}
              </small>
              {note[server.id] ? <small className="cp-note">{note[server.id]}</small> : null}
            </span>
            {companion && state === 'up' ? (
              <button type="button" className="btn sm" title="Stops its Jupyter server and every kernel on it" onClick={() => void stop(server)}>
                Stop
              </button>
            ) : companion && state === 'down' && server.where === 'pc' ? (
              <button type="button" className="btn sm" title="Starts the Companion on this computer" onClick={() => void start(server)}>
                Start
              </button>
            ) : !busy && state === 'down' ? (
              <button type="button" className="btn sm ghost" onClick={() => ask([server])}>
                Retry
              </button>
            ) : null}
            <ComputeSwitch id={id} label={server.name} small={compact} />
          </div>
        );
      })}
      {!servers.length ? <p className="cp-empty">No computers or servers yet: connect one from the Playground, under Your compute.</p> : null}
    </div>
  );
}

/** The rail's chip: lit while a Colab runtime runs; it opens the list. */
export function RailCompute({ labelled = false }: { labelled?: boolean }) {
  const runtimes = useColabRuntimes();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const box = button.current.getBoundingClientRect();
    setPlace({ left: box.right + 10, bottom: Math.max(10, window.innerHeight - box.bottom) });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!pop.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  const live = runtimes.length > 0;
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`${labelled ? 'nav-lab' : 'icon-btn'} cp-chip${live ? ' is-live' : ''}`}
        aria-expanded={open}
        aria-label={live ? `Compute: ${runtimes.length} Colab runtime${runtimes.length > 1 ? 's' : ''} running` : 'Compute'}
        title={live ? `Colab is running (${runtimes.map((runtime) => runtime.label).join(', ')}) — click to stop it, or to turn compute on and off` : 'Compute: turn Colab and your computers on and off'}
        onClick={() => setOpen(!open)}
      >
        <svg className="cp-chip-icon" viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
          <rect x="6" y="6" width="12" height="12" rx="2" />
          <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
        </svg>
        {live ? <span className="cp-chip-dot" aria-hidden="true" /> : null}
        {labelled ? <span>Compute</span> : null}
      </button>
      {open ? (
        <div ref={pop} className="cp-pop" style={place} role="dialog" aria-label="Compute">
          <div className="cp-pop-head">
            <b>Compute</b>
            <span>Switch a place off to leave it out of every choice of where to run.</span>
          </div>
          <ComputeList compact />
        </div>
      ) : null}
    </>
  );
}
