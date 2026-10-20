// The Sim tab of a playground's right-hand pane: a simulation run as it
// goes — its episodes and their returns, its numbers grouped as TensorBoard
// groups them, the videos it recorded, a world model's dreams against what
// really happened, the notes the code and the coding agents left on its
// timeline (dashed lines on every chart), and what looks wrong with what to
// try. Read on the machine, a few seconds apart while a run is live
// (src/lib/simTelemetry.ts); written by koios_telemetry.Run.

import { useEffect, useMemo, useRef, useState } from 'react';
import { KOIOS_TELEMETRY_PY } from '../lib/simProject';
import { SIMULATORS, simulatorById } from '../lib/simulators';
import type { Doctor, Dream, Media, RunListing, SimRun } from '../lib/simTelemetry';
import type { LiveFrame } from '../lib/simTelemetry';
import { applyEvents, diagnose, dreamSeries, dreamTrend, evaluationRows, latestEvaluations, lengthSeries, listKeptRuns, newRun, readKeptRun, readLive, readMedia, readRunsFrom, readSimRuns, returnSeries, runDoctor, scalarCharts, shownStatus, successSeries } from '../lib/simTelemetry';
import type { FileHost } from '../lib/playground';
import { short } from '../lib/telemetry';

/** A number for a table: four significant figures, NaN and the infinities as they are. */
const fmt = (n: number) => (Number.isFinite(n) ? Number(n.toPrecision(4)).toString() : String(n));
import type { JupyterServer } from '../lib/colab';
import { portTicket, portUrl } from '../lib/companion';
import { LineChart } from './Charts';
import { isCompanion } from './VsCodeExtension';
import { useFiled } from '../lib/experimentFiling';

const ago = (seconds: number) => (seconds < 90 ? `${Math.max(0, Math.round(seconds))} s ago` : seconds < 5400 ? `${Math.round(seconds / 60)} min ago` : seconds < 172_800 ? `${Math.round(seconds / 3600)} h ago` : `${Math.round(seconds / 86_400)} days ago`);
const span = (seconds: number) => (seconds < 120 ? `${Math.round(seconds)} s` : seconds < 7200 ? `${Math.round(seconds / 60)} min` : `${(seconds / 3600).toFixed(1)} h`);

/** Blobs already fetched, by folder, run and path, so going back to a video doesn't fetch it again. */
const blobs = new Map<string, string>();
function remember(key: string, url: string) {
  blobs.set(key, url);
  if (blobs.size > 24) {
    const [oldest, old] = blobs.entries().next().value as [string, string];
    URL.revokeObjectURL(old);
    blobs.delete(oldest);
  }
}

function MediaView({ folder, runDir, media, auto }: { folder: string; runDir: string; media: Pick<Media, 'path' | 'type' | 'caption' | 'bytes' | 'name' | 'step'>; auto: boolean }) {
  const key = `${folder}|${runDir}|${media.path}`;
  const [url, setUrl] = useState<string | null>(blobs.get(key) ?? null);
  const [progress, setProgress] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const load = async () => {
    setProblem(null);
    setProgress(0);
    try {
      const blob = await readMedia(folder, runDir, media.path, undefined, (done, size) => setProgress(size ? done / size : 0));
      const made = URL.createObjectURL(blob);
      remember(key, made);
      setUrl(made);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setProgress(null);
    }
  };
  useEffect(() => {
    setUrl(blobs.get(key) ?? null);
    setProblem(null);
    if (auto && !blobs.get(key) && media.type !== 'frames') void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (media.type === 'frames') return <p className="pg-note">Saved as raw frames ({media.path}): install imageio and imageio-ffmpeg (or Pillow) on the machine for videos.</p>;
  return (
    <figure className="sim-media">
      {url ? (
        media.type === 'video' ? (
          <video src={url} controls loop autoPlay muted playsInline />
        ) : (
          <img src={url} alt={media.caption ?? media.name} />
        )
      ) : (
        <button type="button" className="sim-media-load" onClick={() => void load()} disabled={progress !== null}>
          {progress !== null ? `Fetching from the machine… ${Math.round(progress * 100)}%` : `Play ${media.name} · step ${short(media.step)}${media.bytes ? ` · ${Math.max(1, Math.round(media.bytes / 1024))} KB` : ''}`}
        </button>
      )}
      <figcaption>
        {media.caption ?? `${media.name} · step ${short(media.step)}`}
        {problem ? <span className="is-problem"> · {problem}</span> : null}
      </figcaption>
    </figure>
  );
}

/** How long the live view waits for a first frame before saying why one may not come. */
const LIVE_FIRST_FRAME_MS = 8000;

/**
 * The run as it goes: while this is open the run is asked for its live view (koios_telemetry's run.live, which
 * run.wrap(env) calls by itself) and its newest frame is read as fast as the machine answers. Closed, or the run
 * ended, nothing is asked and the run stops rendering for it within seconds.
 */
function LiveView({ folder, runDir, onClose }: { folder: string; runDir: string; onClose: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<LiveFrame | null>(null);
  const [fps, setFps] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    let seen = 0;
    let timer = 0;
    const started = Date.now();
    const times: number[] = [];
    const look = async () => {
      let fresh = false;
      try {
        const got = await readLive(folder, runDir, seen);
        if (!on) return;
        setProblem(null);
        setState(got);
        if (got.jpeg && got.frame) {
          seen = got.frame;
          fresh = true;
          setSrc(`data:image/jpeg;base64,${got.jpeg}`);
          const now = Date.now();
          times.push(now);
          while (times.length && now - times[0] > 3000) times.shift();
          setFps(times.length > 1 ? (times.length - 1) / ((now - times[0]) / 1000) : 0);
        }
        setWaiting(!seen && Date.now() - started > LIVE_FIRST_FRAME_MS);
      } catch (error) {
        if (!on) return;
        setProblem(error instanceof Error ? error.message : String(error));
      }
      // As fast as frames come; a little slower while none do.
      if (on) timer = window.setTimeout(() => void look(), fresh ? 60 : 400);
    };
    void look();
    return () => {
      on = false;
      window.clearTimeout(timer);
    };
  }, [folder, runDir]);
  const info = state?.info ? Object.entries(state.info).filter(([, v]) => typeof v === 'number' || typeof v === 'string') : [];
  const age = state?.t && state.now ? state.now - state.t : null;
  return (
    <figure className="sim-media sim-live">
      <div className="sim-live-frame">
        {src ? <img src={src} alt="The simulation, live" /> : <div className="sim-live-empty"><span className="spinner" /> Asking the run for its live view…</div>}
        <span className={`sim-live-badge${age !== null && age > 3 ? ' is-stale' : ''}`}>● {age !== null && age > 3 ? `${Math.round(age)} s ago` : 'live'}</span>
      </div>
      <figcaption>
        {state?.step !== undefined ? <span>step {short(state.step)}</span> : null}
        {state?.episode !== undefined ? <span> · episode {state.episode + 1}</span> : null}
        {info.map(([k, v]) => (
          <span key={k}>
            {' '}· {k} {typeof v === 'number' ? short(v) : String(v)}
          </span>
        ))}
        {fps ? <span> · {fps.toFixed(1)} frames/s</span> : null}
        <button type="button" className="link sim-live-stop" onClick={onClose}>
          Stop watching
        </button>
      </figcaption>
      {state?.error ? <p className="pg-note is-problem">The run can’t render a frame: {state.error}</p> : null}
      {waiting && !state?.error ? (
        <p className="pg-note">
          No frame yet. A run streams when its code renders for it: <code>run.wrap(env)</code> does (with <code>render_mode="rgb_array"</code>), and any other loop can call <code>run.live(lambda: env.render())</code> each step — the agent can add it. It costs nothing while nobody watches.
        </p>
      ) : null}
      {problem ? <p className="pg-note is-problem">{problem}</p> : null}
    </figure>
  );
}

function DreamView({ folder, run, dream }: { folder: string; run: SimRun; dream: Dream }) {
  const trend = dreamTrend(run);
  return (
    <div className="sim-dream">
      {dream.path ? <MediaView folder={folder} runDir={run.dir} media={{ path: dream.path, type: dream.type ?? 'video', name: dream.name, step: dream.step, caption: `${dream.name} at step ${short(dream.step)}: real · imagined · difference (×4)` }} auto /> : null}
      <LineChart series={dreamSeries(dream)} title={`Prediction error over the horizon${dream.context ? ` · first ${dream.context} given` : ''}`} xLabel="frame" marks={dream.context ? [{ x: dream.context + 0.5, label: 'the dream starts: the model sees only its own predictions from here' }] : undefined} />
      {trend.length ? <LineChart series={trend} title="Dream error over training" xLabel="step" /> : null}
    </div>
  );
}

/**
 * The run's live 3D view: Rerun's web viewer, served by the run on the
 * machine and reached through the Companion's port proxy (0.18.0), with the
 * stream's address handed to it the same way. On a machine whose ports the
 * page can't reach — Colab, a plain Jupyter server — the run's scene.rrd is
 * offered instead, to open in Rerun on this computer.
 */
function Live3D({ folder, run, server, live }: { folder: string; run: SimRun; server?: JupyterServer; live: boolean }) {
  const scene = run.live3d!;
  const companion = server && isCompanion(server) ? server : undefined;
  const [urls, setUrls] = useState<{ viewer: string; probe: string } | null>(null);
  const [state, setState] = useState<'checking' | 'ok' | 'old' | 'down'>('checking');
  const [saving, setSaving] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!companion || !live || !scene.rrdPort) return;
    let alive = true;
    void (async () => {
      const [webTicket, rrdTicket] = await Promise.all([portTicket(companion.token, scene.webPort), portTicket(companion.token, scene.rrdPort!)]);
      const web = portUrl(companion, webTicket, scene.webPort);
      // The viewer's own page, told to load the run's scene.rrd as the run streams it (the gRPC server can't be
      // reached through a path, so the stream is the file, followed as it grows: koios_telemetry, _RrdTail).
      const viewer = `${web}?url=${encodeURIComponent(portUrl(companion, rrdTicket, scene.rrdPort!, scene.rrd))}`;
      if (!alive) return;
      setUrls({ viewer, probe: web });
      try {
        const answer = await fetch(web, { cache: 'no-store' });
        if (!alive) return;
        setState(answer.ok ? 'ok' : answer.status === 404 ? 'old' : 'down');
      } catch {
        if (alive) setState('down');
      }
    })();
    return () => {
      alive = false;
    };
  }, [companion?.url, companion?.token, scene.webPort, scene.rrdPort, live]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    setProblem(null);
    setSaving(0);
    try {
      const blob = await readMedia(folder, run.dir, scene.rrd, undefined, (done, size) => setSaving(size ? done / size : 0));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${run.meta.id ?? run.dir.split('/').pop() ?? 'run'}.rrd`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(null);
    }
  };
  const download = (
    <p className="pg-note">
      <button type="button" className="btn sm" onClick={() => void save()} disabled={saving !== null}>
        {saving !== null ? `Fetching scene.rrd… ${Math.round(saving * 100)}%` : 'Download scene.rrd'}
      </button>{' '}
      and open it on this computer: <code>pip install rerun-sdk && rerun {run.meta.id ?? 'run'}.rrd</code>
      {problem ? <span className="is-problem"> · {problem}</span> : null}
    </p>
  );
  return (
    <section className="sim-section-open">
      <div className="rt-part-label">
        Live 3D <small>· Rerun{scene.sdk ? ` ${scene.sdk}` : ''}</small>
      </div>
      {!live ? (
        <>
          <p className="pg-note">The run is over, and its stream with it; what it logged is in its scene.rrd.</p>
          {download}
        </>
      ) : !scene.rrdPort ? (
        <>
          <p className="pg-note">This run's telemetry is older than the streamed scene: its scene.rrd is still here.</p>
          {download}
        </>
      ) : !companion ? (
        <>
          <p className="pg-note">{server ? `${server.name} isn’t a Companion, so the page can’t reach the viewer’s port there` : 'Colab’s ports can’t be reached from outside'}: the scene is kept as a file instead.</p>
          {download}
        </>
      ) : state === 'old' ? (
        <>
          <p className="pg-note">This Companion is older than Live 3D (0.18.0): update it in Settings → Updates, and the viewer opens here.</p>
          {download}
        </>
      ) : state === 'down' ? (
        <>
          <p className="pg-note is-problem">The viewer on {companion.name} isn’t answering on port {scene.webPort}.</p>
          {download}
        </>
      ) : urls && state === 'ok' ? (
        <>
          <iframe className="sim-live3d" src={urls.viewer} title="Live 3D" allow="fullscreen" />
          <p className="pg-note">
            Orbit with the mouse, scrub the timeline at the bottom; the layout is the viewer&rsquo;s own.{' '}
            <a href={urls.viewer} target="_blank" rel="noreferrer noopener">
              Open in a window ↗
            </a>
          </p>
        </>
      ) : (
        <p className="pg-note">
          <span className="spinner" /> Reaching the viewer on {companion.name}…
        </p>
      )}
    </section>
  );
}

function DoctorView() {
  const [state, setState] = useState<{ doctor?: Doctor; problem?: string; busy?: boolean }>({});
  const check = async () => {
    setState({ busy: true });
    try {
      setState({ doctor: await runDoctor(KOIOS_TELEMETRY_PY) });
    } catch (error) {
      setState({ problem: error instanceof Error ? error.message : String(error) });
    }
  };
  const d = state.doctor;
  const yes = (v: boolean) => (v ? 'yes' : 'no');
  return (
    <details className="sim-section" onToggle={(event) => (event.currentTarget as HTMLDetailsElement).open && !d && !state.busy && void check()}>
      <summary>This machine: what it can simulate</summary>
      {state.busy ? (
        <p className="pg-note">
          <span className="spinner" /> Checking: GPUs, off-screen rendering, video encoding, installed simulators…
        </p>
      ) : state.problem ? (
        <p className="pg-note is-problem">{state.problem}</p>
      ) : d ? (
        <>
          <table className="sim-doctor">
            <tbody>
              <tr><th>Python</th><td>{d.python}{d.colab ? ' · Colab' : ''}</td></tr>
              <tr><th>GPU</th><td>{d.gpus.length ? d.gpus.map((gpu) => `${gpu.name} (${Math.round(gpu.memMb / 1024)} GB)`).join(', ') : 'none'}{d.rtx ? ' · RTX-class' : ''}</td></tr>
              <tr><th>Rendering</th><td>{d.env.MUJOCO_GL ?? 'default'} · EGL {yes(d.egl)} · OSMesa {yes(d.osmesa)} · Vulkan {yes(d.vulkan)}{d.render ? ` · MuJoCo test render ${d.render.ok ? 'works' : 'FAILED'}` : ''}</td></tr>
              <tr><th>Video</th><td>{d.ffmpeg ? 'MP4 (ffmpeg)' : 'GIF only: pip install imageio imageio-ffmpeg'}</td></tr>
              <tr><th>Learning</th><td>torch {yes(d.torch)} · JAX {yes(d.jax)}{d.torch_threads ? ` · CPU threads: ${Object.entries(d.torch_threads.ms).map(([n, ms]) => `${n} → ${ms.toFixed(2)} ms`).join(', ')}` : ''}</td></tr>
              <tr><th>Installed</th><td>{Object.entries(d.installed).filter(([, on]) => on).map(([id]) => simulatorById(id)?.name ?? id).join(', ') || 'none of the catalogue'}</td></tr>
            </tbody>
          </table>
          {d.torch_threads && d.torch_threads.best === 1 && Object.keys(d.torch_threads.ms).length > 1 ? <p className="pg-note">Small networks run faster here on one CPU thread: the PPO and SAC templates use one by default; <code>export KOIOS_TORCH_THREADS=1</code> does it for the rest.</p> : null}
          {d.render && !d.render.ok ? <p className="pg-note is-problem">{d.render.text}. Without off-screen rendering runs still train, without videos: on a CPU machine install OSMesa (apt-get install libosmesa6), on a GPU one EGL.</p> : null}
          <button type="button" className="btn sm" onClick={() => void check()}>
            Check again
          </button>
        </>
      ) : null}
    </details>
  );
}

export default function SimPane({
  folder,
  connected,
  machineName,
  busy,
  server,
  playgroundId,
  kept,
}: {
  folder: string;
  connected: boolean;
  machineName: string;
  busy: boolean;
  /** The machine, when it is a Jupyter server the page added: a Companion's ports can be reached for Live 3D. */
  server?: JupyterServer;
  /** Whose runs these are, for what was filed of them. */
  playgroundId?: string;
  /** The project's own folder, when it isn't the machine's disk (your computer, Drive, a server): the runs are kept there, and read there when the machine isn't connected or no longer has them. */
  kept?: FileHost;
}) {
  const filed = useFiled(playgroundId ?? '');
  const [runs, setRuns] = useState<RunListing[]>([]);
  const [now, setNow] = useState(0);
  const [chosen, setChosen] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [read, setRead] = useState(false);
  const [round, setRound] = useState(0);
  const [, setVersion] = useState(0);
  const [filter, setFilter] = useState('');
  const [mediaAt, setMediaAt] = useState<number | null>(null);
  const [dreamAt, setDreamAt] = useState<number | null>(null);
  /** The run being watched live, by its folder: one at a time, and only while it runs. */
  const [watching, setWatching] = useState<string | null>(null);
  const runRef = useRef<SimRun | null>(null);
  const focusRef = useRef<string | null>(null);
  /** The project folder's runs, listed a minute at a time (Drive is slow), and the size each was last read at. */
  const keptList = useRef<{ at: number; runs: RunListing[] } | null>(null);
  /** The folder's list being read again behind the machine's (it walks Drive: seconds, not a moment). */
  const keptReading = useRef<Promise<void> | null>(null);
  const sourceRef = useRef('');
  const roundRef = useRef(round);
  /** When the runs were last looked for, and where: what the pane says under Look again. */
  const [looked, setLooked] = useState<{ at: number; where: string[] } | null>(null);

  useEffect(() => {
    if (!connected && !kept) return;
    let live = true;
    let timer = 0;
    // Another place to read from (connected or not): the runs are read again from the start. Look again lists the folder again.
    const source = `${connected}|${kept?.label ?? ''}`;
    if (sourceRef.current !== source) {
      sourceRef.current = source;
      runRef.current = null;
      keptList.current = null;
    }
    // Look again lists the folder again; picking another run doesn't (the list is the same).
    if (roundRef.current !== round) {
      roundRef.current = round;
      keptList.current = null;
    }
    const look = async () => {
      let again = false;
      try {
        const focus = chosen ?? focusRef.current;
        const current = runRef.current && runRef.current.dir === focus ? runRef.current : null;
        const keptOnly = new Set((keptList.current?.runs ?? []).map((r) => r.dir));
        const fromMachine = connected ? await readSimRuns(folder, focus ? { dir: focus, offset: current?.offset ?? 0 } : null).catch((error: unknown) => (kept ? null : Promise.reject(error))) : null;
        // The project's own folder: listed once, then again a minute later or at Look again — waited for only when
        // there is nothing else to show (no machine, or not listed yet); otherwise read behind, and shown the next round.
        if (kept && (!keptList.current || Date.now() - keptList.current.at > 60_000) && !keptReading.current) {
          const reading = listKeptRuns(kept)
            .then((runs) => void (keptList.current = { at: Date.now(), runs }))
            .catch(() => undefined)
            .finally(() => (keptReading.current = null));
          keptReading.current = reading;
          if (!fromMachine || !keptList.current) await reading;
        }
        const onMachine = new Set((fromMachine?.runs ?? []).map((r) => r.dir));
        const extra = (keptList.current?.runs ?? []).filter((r) => !onMachine.has(r.dir));
        keptOnly.clear();
        extra.forEach((r) => keptOnly.add(r.dir));
        if (kept) readRunsFrom(folder, kept, keptOnly);
        const all = [...(fromMachine?.runs ?? []), ...extra].sort((a, b) => b.mtime - a.mtime);
        let focused = fromMachine?.focus;
        if (focus && keptOnly.has(focus) && kept) {
          // Kept in the folder: read whole, again only when it has grown.
          const listed = extra.find((r) => r.dir === focus);
          focused = current && listed && current.offset >= listed.size ? undefined : await readKeptRun(kept, { dir: focus, offset: current?.offset ?? 0 });
        }
        const got = { now: fromMachine?.now ?? Date.now() / 1000, runs: all, focus: focused };
        if (!live) return;
        setRuns(got.runs);
        setNow(got.now);
        setProblem(null);
        setRead(true);
        setLooked({ at: Date.now(), where: [...(fromMachine ? [machineName] : []), ...(kept ? [kept.label] : [])] });
        // Nothing chosen: the newest run, read on the next round.
        const want = chosen ?? got.runs[0]?.dir ?? null;
        if (want !== focusRef.current) {
          focusRef.current = want;
          runRef.current = null;
          setMediaAt(null);
          setDreamAt(null);
          again = Boolean(want);
        }
        const f = got.focus;
        if (f && f.dir === focusRef.current) {
          const listing = got.runs.find((r) => r.dir === f.dir);
          let run = runRef.current;
          if (!run || f.from < run.offset || (f.from === 0 && run.offset > 0)) run = newRun(f.dir, listing?.meta);
          applyEvents(run, f.text);
          run.offset = f.to;
          run.truncated ||= f.truncated;
          if (listing) run.meta = { ...run.meta, ...listing.meta };
          runRef.current = run;
          setVersion((n) => n + 1);
          again ||= f.to < f.size && f.text.length > 0;
        }
      } catch (error) {
        if (live) setProblem(error instanceof Error ? error.message : String(error));
      }
      const latest = runRef.current;
      const running = latest?.status === 'running';
      // At once while there is more of the file to read; every three seconds while a run is live; every fifteen otherwise.
      if (live) timer = window.setTimeout(() => void look(), again ? 50 : running || busy ? 3000 : connected ? 15000 : 60000);
    };
    void look();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [folder, connected, busy, round, chosen, kept]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = runRef.current;
  const findings = useMemo(() => (run ? diagnose(run, now) : []), [run, now, run?.offset]); // eslint-disable-line react-hooks/exhaustive-deps
  const marks = useMemo(() => (run ? run.notes.filter((note) => note.tag !== 'spaces').map((note) => ({ x: note.step, label: `${note.by}: ${note.text}` })) : []), [run, run?.offset]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!connected && !kept) return <p className="pg-note pg-pad">Connect to {machineName}, and the simulation runs in this project (koios_telemetry) are drawn here: episodes, videos, dreams, notes. (This project’s files are on {machineName}’s own disk, so runs there go with it when it stops: file the ones to keep as experiments.)</p>;
  if (problem && !read) return <p className="pg-note is-problem pg-pad">{problem}</p>;
  if (!read)
    return (
      <p className="pg-note pg-pad">
        <span className="spinner" /> Looking for runs {connected ? `on ${machineName}` : ''}{connected && kept ? ' and ' : ''}{kept ? `in ${kept.label}` : ''}…
      </p>
    );
  if (!runs.length) {
    return (
      <div className="sim-pane pg-pad">
        <p>No simulation runs in {folder || 'the folder'} yet. A run that logs with koios_telemetry appears here as it starts:</p>
        <pre className="tb-snippet">{`from koios_telemetry import Run
run = Run("ppo", config=vars(args), sim="gymnasium/CartPole-v1")
env = run.wrap(gym.make("CartPole-v1", render_mode="rgb_array"))
run.log({"loss/policy": loss}, step=env_steps)
run.finish()`}</pre>
        <p className="pg-note">The Playground&rsquo;s <b>A simulation</b> start makes a project with it in place, for any of {SIMULATORS.length} simulators.</p>
        <p className="sim-looked">
          <button type="button" className="btn sm" disabled={!looked} onClick={() => (setLooked(null), setRound((n) => n + 1))}>
            {looked ? 'Look again' : 'Looking…'}
          </button>{' '}
          {looked ? (
            <small>
              Looked {new Date(looked.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })} {looked.where.length ? `on ${looked.where.join(' and in ')}` : ''}: none found.
            </small>
          ) : null}
        </p>
        {kept ? null : <p className="pg-note">This project’s files are on {machineName}’s own disk, so its runs go with the runtime when it stops: file the ones to keep as experiments.</p>}
        {connected ? <DoctorView /> : null}
      </div>
    );
  }

  const listing = runs.find((r) => r.dir === (run?.dir ?? focusRef.current));
  const status = run ? shownStatus(run.status, run.lastT, now) : shownStatus(listing?.meta.status, listing?.mtime, now);
  const returns = run ? returnSeries(run) : [];
  const success = run ? successSeries(run) : [];
  const lengths = run ? lengthSeries(run) : [];
  const charts = run ? scalarCharts(run, filter) : [];
  const videos = run?.media ?? [];
  const media = videos.length ? videos[mediaAt ?? videos.length - 1] : undefined;
  const dreams = run?.dreams ?? [];
  const dream = dreams.length ? dreams[dreamAt ?? dreams.length - 1] : undefined;
  const elapsed = run?.firstT ? (run.lastT ?? now) - run.firstT : 0;
  const sim = run?.meta.sim ?? listing?.meta.sim;

  return (
    <div className="sim-pane" aria-live="polite">
      <div className="sim-bar">
        <select
          value={chosen ?? run?.dir ?? focusRef.current ?? ''}
          onChange={(event) => {
            // The pick shows at once; its run is read next (the pane says so meanwhile).
            const next = event.target.value || null;
            focusRef.current = next;
            runRef.current = null;
            setMediaAt(null);
            setDreamAt(null);
            setChosen(next);
          }}
          aria-label="Run"
        >
          {runs.map((r) => (
            <option key={r.dir} value={r.dir}>
              {r.meta.name ?? r.dir} · {shownStatus(r.meta.status, r.mtime, now)} · {ago(now - r.mtime)}
              {r.kept ? ` · in ${kept?.label ?? 'the folder'}` : ''}
            </option>
          ))}
        </select>
        <button type="button" className="icon-btn sm" onClick={() => setRound((n) => n + 1)} title="Read again" aria-label="Refresh">
          ↻
        </button>
      </div>
      {!run && focusRef.current ? (
        <p className="pg-note">
          <span className="spinner" /> Reading {listing?.meta.name ?? focusRef.current}
          {listing?.kept && kept ? ` from ${kept.label}` : ''}…
        </p>
      ) : null}
      <div className="sim-status">
        <span className={`sim-pill is-${status}`}>{status === 'running' ? 'live' : status}</span>
        {sim ? <span className="mono">{sim}</span> : null}
        {run ? <span>step {short(run.step)}</span> : null}
        {run?.episodes.length ? <span>{run.episodes.length} episodes</span> : null}
        {status === 'running' && run?.sps ? <span>{short(run.sps)} steps/s</span> : null}
        {elapsed ? <span>{span(elapsed)}</span> : null}
        {run?.meta.host?.gpu ? <span>{run.meta.host.gpu}</span> : null}
        {run && filed[run.meta.id ?? run.dir.split('/').pop() ?? run.dir] ? (
          <span>
            filed{filed[run.meta.id ?? run.dir.split('/').pop() ?? run.dir].where.link ? (
              <>
                {' '}
                <a href={filed[run.meta.id ?? run.dir.split('/').pop() ?? run.dir].where.link} target="_blank" rel="noreferrer noopener">
                  in {filed[run.meta.id ?? run.dir.split('/').pop() ?? run.dir].where.label} ↗
                </a>
              </>
            ) : (
              ` on ${filed[run.meta.id ?? run.dir.split('/').pop() ?? run.dir].where.label}`
            )}
          </span>
        ) : null}
      </div>
      {run && (status === 'running' || status === 'stalled') ? (
        watching === run.dir ? (
          <LiveView folder={folder} runDir={run.dir} onClose={() => setWatching(null)} />
        ) : (
          <button type="button" className="btn sm sim-live-start" onClick={() => setWatching(run.dir)} title="The simulation as it runs, a few frames a second, straight from the machine — nothing stored">
            ● Watch live
          </button>
        )
      ) : null}
      {run?.truncated ? <p className="pg-note">A long run: its first part is left out here; <code>python koios_telemetry.py summary</code> reads all of it.</p> : null}
      {problem ? <p className="pg-note is-problem">{problem}</p> : null}

      {findings.length ? (
        <ul className="sim-findings" aria-label="What the run looks like">
          {findings.map((f) => (
            <li key={f.id} className={`is-${f.level}`}>
              <b>{f.title}</b>
              <span>{f.detail}</span>
              <span className="sim-try">Try: {f.try}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {returns.length ? <LineChart series={returns} title="Episode return" xLabel={run?.xLabel ?? 'step'} yLabel="return" marks={marks} /> : null}
      {success.length ? <LineChart series={success} title="Success rate" xLabel={run?.xLabel ?? 'step'} yLabel="episodes succeeding" unit="%" marks={marks} /> : null}

      {run?.live3d ? <Live3D folder={folder} run={run} server={server} live={status === 'running'} /> : null}

      {media ? (
        <section className="sim-section-open">
          <div className="rt-part-label">
            Videos <small>· {videos.length}</small>
          </div>
          <MediaView folder={folder} runDir={run!.dir} media={media} auto={mediaAt === null} />
          {videos.length > 1 ? (
            <div className="sim-chips" role="group" aria-label="Videos">
              {videos.slice(-12).map((m) => {
                const index = videos.indexOf(m);
                return (
                  <button key={m.path} type="button" className={media === m ? 'is-on' : ''} onClick={() => setMediaAt(index)} title={m.caption ?? m.path}>
                    {m.name} @ {short(m.step)}
                  </button>
                );
              })}
            </div>
          ) : null}
        </section>
      ) : null}

      {dream && run ? (
        <section className="sim-section-open">
          <div className="rt-part-label">
            World model: real against imagined <small>· {dreams.length}</small>
          </div>
          <DreamView folder={folder} run={run} dream={dream} />
          {dreams.length > 1 ? (
            <div className="sim-chips" role="group" aria-label="Dreams">
              {dreams.slice(-12).map((d) => {
                const index = dreams.indexOf(d);
                return (
                  <button key={`${d.step}-${index}`} type="button" className={dream === d ? 'is-on' : ''} onClick={() => setDreamAt(index)}>
                    step {short(d.step)}
                  </button>
                );
              })}
            </div>
          ) : null}
        </section>
      ) : null}

      {run && run.scalars.size ? (
        <section className="sim-section-open">
          <div className="sim-numbers-head">
            <span className="rt-part-label">Numbers</span>
            <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter (loss, entropy…)" aria-label="Filter the numbers" spellCheck={false} />
          </div>
          {charts.map((chart) => (
            <LineChart key={chart.title} series={chart.series} title={chart.title} xLabel={chart.xLabel} yLabel={chart.yLabel} marks={marks} />
          ))}
        </section>
      ) : null}
      {lengths.length ? <LineChart series={lengths} title="Episode length" xLabel={run?.xLabel ?? 'step'} yLabel="steps per episode" /> : null}

      {run?.evaluations.length ? (
        <section className="sim-section-open sim-eval">
          <span className="rt-part-label">Evaluation</span>
          {latestEvaluations(run.evaluations).map((ev) => {
            const rows = evaluationRows(ev);
            const withPaper = rows.some((row) => row.paper !== undefined);
            return (
              <div key={ev.name} className="sim-eval-one">
                <div className="sim-eval-head">
                  <b>{ev.name}</b> <span className="sim-at">step {short(ev.step)}</span>
                  {ev.episodes ? <span className="sim-at">{ev.episodes} episodes</span> : null}
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>metric</th>
                      <th>ours</th>
                      {withPaper ? <th>paper</th> : null}
                      {withPaper ? <th>vs paper</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.metric}>
                        <td>{row.metric}</td>
                        <td className="num">{fmt(row.ours)}</td>
                        {withPaper ? <td className="num">{row.paper !== undefined ? fmt(row.paper) : '—'}</td> : null}
                        {withPaper ? (
                          <td className={`num${row.delta?.better === true ? ' is-better' : row.delta?.better === false ? ' is-worse' : ''}`}>
                            {row.delta ? `${row.delta.abs >= 0 ? '+' : ''}${fmt(row.delta.abs)}${row.delta.pct !== null ? ` (${row.delta.pct >= 0 ? '+' : ''}${Math.round(row.delta.pct)}%)` : ''}` : row.paper !== undefined ? '—' : ''}
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {ev.protocol || ev.source ? <p className="sim-eval-protocol">{ev.protocol}{ev.source ? ` · paper: ${ev.source}` : ''}</p> : null}
              </div>
            );
          })}
        </section>
      ) : null}

      {run?.notes.length ? (
        <details className="sim-section" open>
          <summary>Timeline · {run.notes.length} notes</summary>
          <ol className="sim-notes">
            {[...run.notes].reverse().slice(0, 40).map((note, index) => (
              <li key={`${note.t}-${index}`} className={note.tag === 'problem' ? 'is-problem' : ''}>
                <span className={`sim-by is-${note.by}`}>{note.by}</span>
                <span className="sim-at">step {short(note.step)}</span>
                <span>{note.text}</span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {run?.status === 'crashed' && run.error ? (
        <details className="sim-section" open>
          <summary>Traceback</summary>
          <pre className="sim-pre">{run.error.trim().split('\n').slice(-14).join('\n')}</pre>
        </details>
      ) : null}

      {run?.meta.config && Object.keys(run.meta.config).length ? (
        <details className="sim-section">
          <summary>Config</summary>
          <pre className="sim-pre">{JSON.stringify(run.meta.config, null, 2)}</pre>
        </details>
      ) : null}
      {run?.checkpoints.length ? (
        <details className="sim-section">
          <summary>Checkpoints · {run.checkpoints.length}</summary>
          <ul className="sim-notes">
            {run.checkpoints.map((c) => (
              <li key={c.path}>
                <span className="sim-at">step {short(c.step)}</span> <span className="mono">{c.path}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <DoctorView />
      <p className="rt-metric-note">
        For coding agents and terminals: <code>python koios_telemetry.py summary</code> prints the same, findings included.
      </p>
    </div>
  );
}
