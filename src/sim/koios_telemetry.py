"""koios_telemetry: what a simulation run says about itself, for the Koios Sim pane, for coding agents and for you.

One file, nothing to install beyond what a simulation already has (numpy; imageio or Pillow for videos).

    from koios_telemetry import Run

    run = Run("ppo-cartpole", config=vars(args), sim="gymnasium/CartPole-v1")
    env = run.wrap(gym.make("CartPole-v1", render_mode="rgb_array"))   # episodes and videos, logged by themselves
    run.axes(x="environment steps")                                     # what every chart's x axis counts
    run.axes({"loss": "loss", "entropy": "policy entropy (nats)"})       # what each number's y axis measures
    run.log({"loss/policy": 0.12, "loss/value": 0.4, "entropy": 0.6}, step=global_step)
    run.episode(ret, length, step=global_step, success=info.get("is_success"))
    run.video("rollout", frames, step=global_step)                      # HxWx3 uint8 frames
    run.dream("dream", real_frames, imagined_frames, step=global_step)  # a world model's prediction against the real thing
    run.note("lr 3e-4 -> 1e-4: the policy loss oscillated", step=global_step, by="agent")
    run.scene(env)                                                      # a MuJoCo env in the Sim pane's live 3D view (rerun-sdk)
    run.evaluation({"return": 812.0, "success": 0.9}, step=global_step, episodes=10,   # a formal evaluation, the way the
                   protocol="10 episodes, seeds 0-9, deterministic policy", paper={"return": 850.0})  # paper does it
    run.evaluate(make_env, policy, episodes=10, step=global_step)       # the default protocol, when the paper gives none
    run.finish()

Everything goes to runs/<name>-<time>/: run.json (what the run is), events.jsonl (one JSON object a line, appended
as it happens) and media/ (videos). The Sim pane in Koios reads them on the machine, so nothing has to be copied
anywhere for it to draw them.

From a terminal:

    python koios_telemetry.py doctor           # what this machine can simulate, and whether it can render off-screen
    python koios_telemetry.py summary [runs]   # every run, digested, with what looks wrong and what to try
    python koios_telemetry.py tail runs/<run>  # follow one run's events as they come
    python koios_telemetry.py note runs/<run> "text" [--step N] [--by agent]   # a note on a run's timeline
    python koios_telemetry.py bridge logdir/metrics.jsonl --videos logdir/videos --follow   # another codebase's logs
    python koios_telemetry.py simulators [query]       # the catalogue: 31 simulators, what each needs, their environments
    python koios_telemetry.py use <simulator> [env]    # env.py and setup.sh for one (and a starter where it has its own API)

The event format (schema 1) is written out in docs/simulation.md in the Koios repository.
"""
from __future__ import annotations

import atexit
import ctypes.util
import glob
import importlib.util
import json
import math
import os
import platform
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback

__all__ = ["Run", "headless", "doctor", "summary", "read_run", "diagnose", "find_runs", "write_video", "bridge", "SCHEMA", "SIMULATORS"]

SCHEMA = 1
RUNS_DIR = os.environ.get("KOIOS_RUNS", "runs")
HEARTBEAT_S = 10.0

# ------------------------------------------------------------- headless ----


def _has_lib(name: str) -> bool:
    try:
        return ctypes.util.find_library(name) is not None
    except Exception:
        return False


def headless(force: bool = False) -> dict:
    """Off-screen rendering, chosen before a simulator is imported.

    A Colab runtime or a server has no display, and a simulator that opens a window there fails. On Linux with no
    DISPLAY this picks MuJoCo's renderer (EGL on a GPU, else OSMesa on the CPU) and points pygame (classic control,
    Box2D) at its dummy video driver. Anything already set is left alone. Runs on import unless KOIOS_HEADLESS=0.
    """
    if sys.platform.startswith("linux") and (force or not os.environ.get("DISPLAY")):
        os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
        if "MUJOCO_GL" not in os.environ:
            # EGL renders on a GPU; with no GPU behind it (a CPU runtime) its library can be there and still fail,
            # so it is chosen only when there is one, and OSMesa, slower but anywhere, otherwise.
            gpu = shutil.which("nvidia-smi") is not None or bool(glob.glob("/dev/dri/renderD*"))
            if _has_lib("EGL") and (gpu or not _has_lib("OSMesa")):
                os.environ["MUJOCO_GL"] = "egl"
                os.environ.setdefault("PYOPENGL_PLATFORM", "egl")
            elif _has_lib("OSMesa"):
                os.environ["MUJOCO_GL"] = "osmesa"
                os.environ.setdefault("PYOPENGL_PLATFORM", "osmesa")
    return {key: os.environ.get(key) for key in ("MUJOCO_GL", "PYOPENGL_PLATFORM", "SDL_VIDEODRIVER")}


if os.environ.get("KOIOS_HEADLESS", "1") != "0":
    headless()

# ---------------------------------------------------------------- media ----


def _as_uint8(frame):
    import numpy as np

    a = np.asarray(frame)
    if a.ndim == 3 and a.shape[0] in (1, 3, 4) and a.shape[-1] not in (1, 3, 4):
        a = a.transpose(1, 2, 0)  # CHW, as torch keeps images
    if a.dtype != np.uint8:
        a = a.astype(np.float32)
        if a.size and float(np.nanmax(a)) <= 1.0 + 1e-6:
            a = a * 255.0
        a = np.clip(np.nan_to_num(a), 0, 255).astype(np.uint8)
    if a.ndim == 2:
        a = a[..., None]
    if a.shape[-1] == 1:
        a = np.repeat(a, 3, -1)
    if a.shape[-1] == 4:
        a = a[..., :3]
    return a


def _shrink(a, max_side: int):
    h, w = a.shape[:2]
    k = max(1, math.ceil(max(h, w) / max_side)) if max_side else 1
    return a[::k, ::k] if k > 1 else a


def _even(a):
    import numpy as np

    h, w = a.shape[:2]
    if h % 2 or w % 2:
        a = np.pad(a, ((0, h % 2), (0, w % 2), (0, 0)), mode="edge")
    return a


def _frames(frames, max_side: int, max_frames: int):
    frames = list(frames)
    if len(frames) > max_frames:
        k = len(frames) / max_frames
        frames = [frames[int(i * k)] for i in range(max_frames)]
    out = [_even(_shrink(_as_uint8(f), max_side)) for f in frames]
    if not out:
        return out
    h, w = out[0].shape[:2]
    return [f if f.shape[:2] == (h, w) else _even(_resize(f, h, w)) for f in out]


def _resize(a, h, w):
    import numpy as np

    ys = (np.arange(h) * a.shape[0] / h).astype(int)
    xs = (np.arange(w) * a.shape[1] / w).astype(int)
    return a[ys][:, xs]


def write_video(frames, base: str, fps: float = 30, max_side: int = 256, max_frames: int = 600) -> tuple[str, str]:
    """Frames to a file a browser plays: MP4 (H.264) through imageio's ffmpeg, else a GIF through Pillow, else the
    raw frames as .npz. Returns (path, kind) where kind is "video", "gif" or "frames"."""
    frames = _frames(frames, max_side, max_frames)
    if not frames:
        raise ValueError("no frames to write")
    try:
        if os.environ.get("KOIOS_VIDEO", "").lower() == "gif":
            raise RuntimeError("GIFs asked for")  # a browser without H.264 (an open-source Chromium build)
        import imageio.v2 as iio
        import imageio_ffmpeg  # noqa: F401  (the ffmpeg binary comes with it)

        path = base + ".mp4"
        iio.mimwrite(path, frames, fps=fps, codec="libx264", quality=7, pixelformat="yuv420p", macro_block_size=1, ffmpeg_params=["-movflags", "+faststart"])
        return path, "video"
    except Exception:
        pass
    try:
        from PIL import Image

        path = base + ".gif"
        images = [Image.fromarray(f) for f in frames]
        images[0].save(path, save_all=True, append_images=images[1:], duration=max(20, int(1000 / max(fps, 1))), loop=0)
        return path, "gif"
    except Exception:
        pass
    import numpy as np

    path = base + ".npz"
    np.savez_compressed(path, frames=np.stack(frames))
    return path, "frames"


def _write_image(frame, base: str, max_side: int) -> str:
    a = _even(_shrink(_as_uint8(frame), max_side))
    try:
        from PIL import Image

        Image.fromarray(a).save(base + ".png")
        return base + ".png"
    except Exception:
        import imageio.v2 as iio

        iio.imwrite(base + ".png", a)
        return base + ".png"


def _write_live(frame, path: str, max_side: int) -> bool:
    """One frame of the live view, JPEG where Pillow or imageio can write one (PNG else), put in place whole."""
    a = _shrink(_as_uint8(frame), max_side)
    tmp = path + ".tmp"
    try:
        from PIL import Image

        Image.fromarray(a).save(tmp, format="JPEG", quality=80)
    except Exception:
        try:
            import imageio.v2 as iio

            iio.imwrite(tmp, a, format="jpeg")
        except Exception:
            return False
    os.replace(tmp, path)
    return True


# The live view: the Sim pane, while someone watches, keeps live.want in the run's folder fresh; the run then writes its
# newest frame to live.jpg (and live.json) a few times a second, and stops once nobody has asked for LIVE_FOR_S.
LIVE_FOR_S = 10.0
LIVE_EVERY_S = 0.15
LIVE_SIDE = 480

# ------------------------------------------------------------------ run ----


def _slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", str(text)).strip("-")[:60] or "run"


def _number(value):
    """A number as JSON can hold it: NaN and the infinities as strings, which the readers turn back."""
    try:
        f = float(value)
    except Exception:
        return None
    if math.isnan(f):
        return "nan"
    if math.isinf(f):
        return "inf" if f > 0 else "-inf"
    return int(f) if isinstance(value, int) and not isinstance(value, bool) else f


def _jsonable(value, depth: int = 0):
    if depth > 6:
        return str(value)
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, (int, float)):
        return _number(value)
    if isinstance(value, dict):
        return {str(k): _jsonable(v, depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v, depth + 1) for v in list(value)[:200]]
    if hasattr(value, "item") and callable(value.item):
        try:
            return _jsonable(value.item(), depth + 1)
        except Exception:
            pass
    if hasattr(value, "__dict__") and not isinstance(value, type):
        return _jsonable(vars(value), depth + 1)
    return str(value)


def _host() -> dict:
    gpu = None
    if shutil.which("nvidia-smi"):
        try:
            out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10).stdout.strip().splitlines()
            gpu = out[0].split(",")[0].strip() if out else None
        except Exception:
            gpu = None
    return {"python": platform.python_version(), "platform": platform.platform(), "machine": platform.node(), "gpu": gpu, "colab": "google.colab" in sys.modules or bool(os.environ.get("COLAB_RELEASE_TAG"))}


class Run:
    """One run of an experiment: its numbers, its episodes, its videos and its notes, on a timeline.

    name        what the run is called; its folder is runs/<name>-<time>
    config      the hyperparameters, any dict (argparse's vars(args), a dataclass's asdict)
    sim         the simulator and environment, "mujoco/Ant-v5", "dm_control/cartpole-swingup"
    video_every record one episode in this many (the first always), 0 for never
    max_side    the longest side a video frame is kept at, in pixels
    echo        also print a line now and then, so the console's Metrics pane draws the numbers too
    tensorboard also write the scalars as TensorBoard event files in the run's folder
    resume      a run folder to carry on writing to, rather than starting a new one
    x_label     what the x axis of every chart counts ("environment steps", "updates"), as run.axes(x=...)
    axes        what each number measures, as run.axes(axes)

    Every chart in the Sim pane is labelled: say what each number measures with run.axes() (a number logged with
    no label is pointed out, as it is logged and when the run ends).
    """

    def __init__(self, name: str = "run", config=None, sim: str | None = None, root: str | None = None, video_every: int = 25, max_side: int = 256, max_frames: int = 600, echo: bool = True, tensorboard: bool = False, resume: str | None = None, live3d: bool | None = None, x_label: str | None = None, axes: dict | None = None):
        self.name = name
        self._axes: dict = {}
        self._x_label: str | None = None
        self._unlabelled: set = set()
        self.video_every = int(video_every)
        self.max_side = int(max_side)
        self.max_frames = int(max_frames)
        self.echo = echo
        self.step = 0
        self.env_steps = 0
        self.episodes = 0
        self.finished = False
        self._lock = threading.Lock()
        self._t0 = time.time()
        self._last_echo = 0.0
        self._media = 0
        self._failure: str | None = None
        self._live_checked = 0.0
        self._live_on = False
        self._live_last = 0.0
        self._live_frames = 0
        if resume and os.path.isdir(resume):
            self.dir = resume
            self.id = os.path.basename(os.path.normpath(resume))
        else:
            self.id = f"{_slug(name)}-{time.strftime('%Y%m%d-%H%M%S')}"
            self.dir = os.path.join(root or RUNS_DIR, self.id)
            n = 1
            while os.path.exists(self.dir):
                n += 1
                self.dir = os.path.join(root or RUNS_DIR, f"{self.id}-{n}")
            self.id = os.path.basename(self.dir)
        os.makedirs(os.path.join(self.dir, "media"), exist_ok=True)
        self._file = open(os.path.join(self.dir, "events.jsonl"), "a", buffering=1, encoding="utf-8")
        self.meta = {"schema": SCHEMA, "id": self.id, "name": name, "sim": sim, "config": _jsonable(config or {}), "started": self._t0, "status": "running", "host": _host(), "argv": sys.argv[:20], "pid": os.getpid()}
        self._write_meta()
        self._event("start", name=name, sim=sim, config=self.meta["config"], host=self.meta["host"], resumed=bool(resume))
        if x_label or axes:
            self.axes(axes, x=x_label)
        # The run's folder kept in the project's data place (Google Drive by default) as it goes: every few minutes
        # and at the end, so a runtime that ends loses minutes, not the run. Nothing when no data place is set.
        self._data_sync = None
        try:
            import koios_data  # noqa: F401 — on the helper path when Koios set a data place
            if koios_data.enabled():
                self._data_sync = koios_data.sync(self.dir, name=f"runs/{os.path.basename(self.dir)}", every_minutes=float(os.environ.get("KOIOS_RUN_SYNC_MINUTES", "3")))
                self._event("note", step=0, text=f"run folder kept in {koios_data.where()} (runs/{os.path.basename(self.dir)}), pushed every few minutes", by="koios", tag="data")
        except Exception:
            self._data_sync = None
        self._tb = None
        if tensorboard:
            try:
                from torch.utils.tensorboard import SummaryWriter

                self._tb = SummaryWriter(self.dir)
            except Exception:
                self._tb = None
        # Live 3D through Rerun (rerun-sdk): a viewer the Sim pane embeds, fed as the run goes, and scene.rrd beside the
        # events for machines whose ports can't be reached. On when the SDK is installed, unless KOIOS_LIVE3D=0.
        self._rr = None
        self._scene = None
        if live3d is None:
            live3d = os.environ.get("KOIOS_LIVE3D", "1") != "0" and _have("rerun")
        if live3d:
            self._start_live3d()
        self._stop = threading.Event()
        self._beat = threading.Thread(target=self._heartbeat, name="koios-heartbeat", daemon=True)
        self._beat.start()
        self._previous_hook = sys.excepthook
        sys.excepthook = self._excepthook
        atexit.register(self._at_exit)
        print(f"[koios] run {json.dumps({'id': self.id, 'dir': self.dir})}", flush=True)

    # ------------------------------------------------------------ writing --

    def _write_meta(self):
        path = os.path.join(self.dir, "run.json")
        with open(path + ".tmp", "w", encoding="utf-8") as f:
            json.dump(self.meta, f, indent=2)
        os.replace(path + ".tmp", path)

    def _event(self, kind: str, **fields):
        event = {"kind": kind, "t": round(time.time(), 3)}
        event.update(fields)
        line = json.dumps(event, separators=(",", ":"))
        with self._lock:
            if not self._file.closed:
                self._file.write(line + "\n")

    def _heartbeat(self):
        last_steps, last_t = self.env_steps, time.time()
        while not self._stop.wait(HEARTBEAT_S):
            now = time.time()
            sps = (self.env_steps - last_steps) / max(now - last_t, 1e-6)
            last_steps, last_t = self.env_steps, now
            self._event("heartbeat", step=self.step, env_steps=self.env_steps, sps=round(sps, 2))

    def _at(self, step):
        if step is not None:
            self.step = int(step)
        return self.step

    # ------------------------------------------------------------- public --

    def axes(self, names=None, y: str | None = None, x: str | None = None):
        """What a chart's axes measure, so the Sim pane labels them and nobody has to guess what a line is.

            run.axes(x="environment steps")                                  # the x axis of every chart in the run
            run.axes("throughput/sps", y="env steps / s", x="batch size")    # one number's chart, both axes
            run.axes({"loss": "loss", "return": "episode return"})           # many at once; a prefix labels its group
            run.axes({"speedup": {"y": "x Python reference", "x": "batch size"}})

        y says what the number measures, with its units; x what its step counts. When a chart's x is not the
        training step (a batch size, a model size, a seed), pass that value as step= to run.log and name it here.
        """
        given: dict = {}
        if isinstance(names, str):
            given[names] = {"y": y, "x": None if x is None else x}
            x_all = None
        else:
            for name, said in (names or {}).items():
                given[str(name)] = {"y": said} if isinstance(said, str) else dict(said or {})
            x_all = x
        clean = {}
        for name, said in given.items():
            labels = {k: str(v).strip() for k, v in said.items() if k in ("x", "y") and v is not None and str(v).strip()}
            if labels:
                self._axes.setdefault(name, {}).update(labels)
                clean[name] = labels
        fields = {}
        if x_all is not None and str(x_all).strip():
            self._x_label = str(x_all).strip()
            fields["x"] = self._x_label
        if clean:
            fields["axes"] = clean
        if fields:
            self.meta["axes"] = {"x": self._x_label, "axes": self._axes}
            self._event("axes", step=self.step, **fields)

    def _labelled(self, name: str) -> bool:
        return bool(self._axes.get(name, {}).get("y") or ("/" in name and self._axes.get(name.split("/")[0], {}).get("y")))

    def log(self, values: dict | None = None, step: int | None = None, **more):
        """Numbers at a step: losses, rates, anything. Names with a slash group in the pane ("loss/policy")."""
        merged = dict(values or {})
        merged.update(more)
        clean = {str(k): _number(v) for k, v in merged.items()}
        clean = {k: v for k, v in clean.items() if v is not None}
        if not clean:
            return
        step = self._at(step)
        self._event("scalars", step=step, values=clean)
        fresh = [k for k in clean if k not in self._unlabelled and not self._labelled(k)]
        if fresh:
            self._unlabelled.update(fresh)
            print(f"[koios] no axis label for {', '.join(fresh[:6])}{' …' if len(fresh) > 6 else ''}: say what each measures, "
                  f"run.axes({fresh[0]!r}, y=\"what it measures, with units\", x=\"what the step counts\")", flush=True)
        if self._rr is not None:
            try:
                self._rr_time(step)
                for k, v in clean.items():
                    if isinstance(v, (int, float)):
                        self._rr.log(f"metrics/{k}", self._rr.Scalars(float(v)))
            except Exception:
                pass
        if self._tb is not None:
            for k, v in clean.items():
                if isinstance(v, (int, float)):
                    self._tb.add_scalar(k, v, step)
        if self.echo and time.time() - self._last_echo > 2.0:
            self._last_echo = time.time()
            shown = " ".join(f"{k.replace('/', '_')}={v:.4g}" if isinstance(v, float) else f"{k.replace('/', '_')}={v}" for k, v in list(clean.items())[:8])
            print(f"step {step} {shown}", flush=True)

    def scalar(self, name: str, value, step: int | None = None):
        self.log({name: value}, step=step)

    def episode(self, ret, length: int | None = None, step: int | None = None, success=None, **extra):
        """One finished episode: its return, its length, whether it succeeded when the task says."""
        self.episodes += 1
        fields = {"step": self._at(step), "index": self.episodes - 1, "return": _number(ret)}
        if length is not None:
            fields["length"] = int(length)
        if success is not None:
            fields["success"] = bool(float(success) > 0.5) if not isinstance(success, bool) else success
        if extra:
            fields["extra"] = _jsonable(extra)
        self._event("episode", **fields)
        if self._rr is not None:
            try:
                self._rr_time(fields["step"])
                if isinstance(fields["return"], (int, float)):
                    self._rr.log("episodes/return", self._rr.Scalars(float(fields["return"])))
                if length is not None:
                    self._rr.log("episodes/length", self._rr.Scalars(float(length)))
            except Exception:
                pass

    def watching(self) -> bool:
        """Whether someone is watching the run live in the Sim pane: checked at most twice a second, so cheap to ask."""
        now = time.time()
        if now - self._live_checked >= 0.5:
            self._live_checked = now
            try:
                self._live_on = now - os.path.getmtime(os.path.join(self.dir, "live.want")) < LIVE_FOR_S
            except OSError:
                self._live_on = False
        return self._live_on

    def live(self, frame, step: int | None = None, **info) -> bool:
        """The simulation as it is now, for the Sim pane's live view. Call it every step from any loop that steps a
        simulator; it does nothing until someone watches, and then keeps a few frames a second.

            run.live(lambda: env.render(), step=global_step)       # a callable: rendered only when someone watches
            run.live(frame)                                          # or an HxWx3 frame you already have

        run.wrap(env) calls it by itself. info (return so far, a score) is shown beside the frame."""
        if not self.watching():
            return False
        now = time.time()
        if now - self._live_last < LIVE_EVERY_S:
            return False
        self._live_last = now
        problem = None
        try:
            if callable(frame):
                frame = frame()
            if frame is None:
                problem = "the render gave no frame (is render_mode=\"rgb_array\"?)"
            elif not _write_live(frame, os.path.join(self.dir, "live.jpg"), LIVE_SIDE):
                problem = "no image writer: install Pillow or imageio"
        except Exception as error:
            problem = f"rendering failed: {type(error).__name__}: {error}"
        if problem is None:
            self._live_frames += 1
        state = {"t": round(now, 3), "step": self._at(step), "frame": self._live_frames, "episode": self.episodes}
        if problem:
            # Said to the pane, which would otherwise wait for a frame that cannot come.
            state["error"] = problem[:500]
        if info:
            state["info"] = _jsonable(info)
        try:
            with open(os.path.join(self.dir, "live.json.tmp"), "w", encoding="utf-8") as f:
                json.dump(state, f)
            os.replace(os.path.join(self.dir, "live.json.tmp"), os.path.join(self.dir, "live.json"))
        except Exception:
            pass
        return problem is None

    def wants_video(self, episode: int | None = None) -> bool:
        """Whether the episode about to start should be recorded: the first, then one in video_every."""
        index = self.episodes if episode is None else episode
        return self.video_every > 0 and (index == 0 or index % self.video_every == 0)

    def _base(self, name: str, step: int) -> str:
        self._media += 1
        return os.path.join(self.dir, "media", f"{_slug(name)}-{step:09d}-{self._media:04d}")

    def video(self, name: str, frames, step: int | None = None, fps: float = 30, caption: str | None = None):
        """Frames (HxWx3, uint8 or 0-1 floats, or CHW) as a video the pane plays."""
        step = self._at(step)
        try:
            path, kind = write_video(frames, self._base(name, step), fps=fps, max_side=self.max_side, max_frames=self.max_frames)
        except Exception as error:
            self._event("note", step=step, text=f"video {name} not written: {error}", by="koios", tag="problem")
            return None
        rel = os.path.relpath(path, self.dir)
        self._event("media", step=step, name=name, path=rel, type=kind, frames=min(len(frames), self.max_frames), fps=fps, bytes=os.path.getsize(path), caption=caption)
        return path

    def image(self, name: str, frame, step: int | None = None, caption: str | None = None):
        step = self._at(step)
        try:
            path = _write_image(frame, self._base(name, step), self.max_side)
        except Exception as error:
            self._event("note", step=step, text=f"image {name} not written: {error}", by="koios", tag="problem")
            return None
        self._event("media", step=step, name=name, path=os.path.relpath(path, self.dir), type="image", bytes=os.path.getsize(path), caption=caption)
        return path

    def dream(self, name: str, real, imagined, step: int | None = None, fps: float = 15, context: int = 0):
        """A world model's rollout against the real one, frame for frame: one video, real | imagined | difference,
        and the error at each step of the horizon. `context` is how many first frames the model was given rather
        than predicted (they are marked in the error as such)."""
        import numpy as np

        step = self._at(step)
        n = min(len(real), len(imagined))
        if not n:
            return None
        r = [_as_uint8(f) for f in list(real)[:n]]
        m = [_as_uint8(f) for f in list(imagined)[:n]]
        errors, panels = [], []
        for a, b in zip(r, m):
            if b.shape != a.shape:
                b = _resize(b, a.shape[0], a.shape[1])
            fa, fb = a.astype(np.float32) / 255.0, b.astype(np.float32) / 255.0
            errors.append(round(float(np.mean((fa - fb) ** 2)), 6))
            diff = np.clip(np.abs(fa - fb) * 4.0, 0, 1)
            gap = np.full((a.shape[0], 2, 3), 255, np.uint8)
            panels.append(np.concatenate([a, gap, b, gap, (diff * 255).astype(np.uint8)], axis=1))
        try:
            path, kind = write_video(panels, self._base(name, step), fps=fps, max_side=self.max_side * 3, max_frames=self.max_frames)
        except Exception as error:
            self._event("note", step=step, text=f"dream {name} not written: {error}", by="koios", tag="problem")
            path, kind = None, None
        self._event("dream", step=step, name=name, path=os.path.relpath(path, self.dir) if path else None, type=kind, error=errors, context=int(context), fps=fps, horizon=n)
        return errors

    def note(self, text: str, step: int | None = None, by: str = "code", tag: str | None = None):
        """A line on the run's timeline: what changed and why. Agents: write one each time you change the run."""
        fields = {"step": self._at(step), "text": str(text), "by": by}
        if tag:
            fields["tag"] = tag
        self._event("note", **fields)
        if self._rr is not None:
            try:
                self._rr_time(fields["step"])
                self._rr.log("notes", self._rr.TextLog(f"[{by}] {text}", level="WARN" if tag == "problem" else "INFO"))
            except Exception:
                pass

    def evaluation(self, metrics: dict, name: str = "eval", step: int | None = None, episodes: int | None = None, protocol: str | None = None, paper: dict | None = None, higher_is_better=None, seeds=None, **extra):
        """A formal evaluation of the policy (or the model), as distinct from the training episodes: the numbers the
        paper reports are compared on. `metrics` is {name: number} — whatever the paper measures: return, success rate,
        normalised score, an error, a distance. Say how it was measured in `protocol` (episodes, seeds, deterministic or
        not, which checkpoint), and give the paper's numbers for the same metrics in `paper` ({name: number}, with an
        optional "source": "Table 2") so the Sim pane and the logbook show ours against theirs. `higher_is_better` is
        True, False, or {name: bool} (default: True except for names holding loss, error, distance, cost, regret, time).
        Papers evaluate differently: read the paper's protocol and follow it; `Run.evaluate` is the default when it gives none."""
        step = self._at(step)
        clean = {str(k): _number(v) for k, v in (metrics or {}).items()}
        fields = {"step": step, "name": str(name), "metrics": clean}
        if episodes is not None:
            fields["episodes"] = int(episodes)
        if protocol:
            fields["protocol"] = str(protocol)
        if paper:
            fields["paper"] = {str(k): (_number(v) if k != "source" else str(v)) for k, v in paper.items()}
        if higher_is_better is not None:
            fields["higher_is_better"] = {str(k): bool(v) for k, v in higher_is_better.items()} if isinstance(higher_is_better, dict) else bool(higher_is_better)
        if seeds is not None:
            fields["seeds"] = [int(s) for s in list(seeds)[:64]]
        if extra:
            fields["extra"] = _jsonable(extra)
        self._event("evaluation", **fields)
        if self._rr is not None:
            try:
                self._rr_time(step)
                for k, v in clean.items():
                    if isinstance(v, (int, float)):
                        self._rr.log(f"eval/{name}/{k}", self._rr.Scalars(float(v)))
            except Exception:
                pass
        return clean

    def evaluate(self, make_env, act, episodes: int = 10, seed: int = 0, name: str = "eval", step: int | None = None, max_steps: int | None = None, video: bool = True, protocol: str | None = None, paper: dict | None = None, success_key: str = "is_success"):
        """The default evaluation protocol, for when the paper gives none (say so in the notes): `episodes` episodes on a
        fresh env from `make_env(render_mode=...)`, seeded seed, seed+1, …; `act(obs) -> action` deterministic; the mean
        and standard deviation of the return, the mean length, the success rate when infos carry `success_key`; the first
        episode recorded as a video. Logs the evaluation event and returns its metrics."""
        import numpy as np  # noqa: F401 — only to be sure it is there before the loop
        returns, lengths, successes = [], [], []
        frames = []
        env = None
        try:
            try:
                env = make_env(render_mode="rgb_array") if video else make_env()
            except TypeError:
                env = make_env()
            for i in range(int(episodes)):
                obs, info = env.reset(seed=seed + i)
                done, total, length = False, 0.0, 0
                while not done:
                    if video and i == 0 and len(frames) < self.max_frames:
                        self.grab(env.render, frames)
                    obs, r, terminated, truncated, info = env.step(act(obs))
                    total += float(r)
                    length += 1
                    done = terminated or truncated or (max_steps is not None and length >= max_steps)
                returns.append(total)
                lengths.append(length)
                if isinstance(info, dict) and info.get(success_key) is not None:
                    successes.append(bool(float(info[success_key]) > 0.5))
        finally:
            try:
                if env is not None:
                    env.close()
            except Exception:
                pass
        step = self._at(step)
        metrics = {"return": _mean(returns) if returns else float("nan"), "return_std": _std(returns) if len(returns) > 1 else 0.0, "length": _mean(lengths) if lengths else 0.0}
        if successes:
            metrics["success"] = sum(successes) / len(successes)
        if frames:
            self.video(f"{name}-episode", frames, step=step, caption=f"{name}: the first of {episodes} evaluation episodes, seed {seed}")
        return self.evaluation(metrics, name=name, step=step, episodes=int(episodes), protocol=protocol or f"{episodes} episodes, seeds {seed}-{seed + int(episodes) - 1}, deterministic actions (Koios default protocol: the paper gave none)", paper=paper, seeds=range(seed, seed + int(episodes)))

    def checkpoint(self, path: str, step: int | None = None, **metrics):
        self._event("checkpoint", step=self._at(step), path=str(path), metrics=_jsonable(metrics))

    # ------------------------------------------------------------ live 3D --

    def _start_live3d(self):
        try:
            import rerun as rr

            rr.init(f"koios/{_slug(self.name)}", recording_id=self.id)
            grpc_port, web_port = _free_port(), _free_port()
            # The stream for a viewer and the file for later, at once: rr.save() alone would replace the stream. Bound
            # to this machine only; the page reaches it through the Companion's port proxy, never across the network.
            server = rr.GrpcServerSink(bind_ip="127.0.0.1", port=grpc_port, cors_allow_origin=["*"], server_memory_limit="512MiB")
            rr.set_sinks(server, rr.FileSink(os.path.join(self.dir, "scene.rrd")), default_blueprint=_blueprint(rr))
            rr.serve_web_viewer(web_port=web_port, open_browser=False, connect_to=server.uri)
            # The viewer in the page can't be pointed at the gRPC server through the Companion's port proxy (Rerun
            # takes rerun+http://host:port/proxy and nothing with a path before it), but it loads an .rrd from any
            # http address and decodes it as it arrives: scene.rrd is served here as a stream that follows the file.
            rrd_port = _free_port()
            _RrdTail(os.path.join(self.dir, "scene.rrd"), rrd_port, lambda: self.finished).start()
        except Exception as error:
            self._event("note", step=self.step, text=f"live 3D is off: {error}", by="koios", tag="problem")
            return
        self._rr = rr
        self._event("live3d", step=self.step, grpc_port=grpc_port, web_port=web_port, rrd_port=rrd_port, rrd="scene.rrd", sdk=rr.__version__)
        print(f"[koios] live3d {json.dumps({'web_port': web_port, 'grpc_port': grpc_port, 'rrd_port': rrd_port, 'rrd': os.path.join(self.dir, 'scene.rrd')})}", flush=True)

    def _rr_time(self, step):
        self._rr.set_time("step", sequence=int(step))

    def scene(self, target, data=None, every: int = 2, groups=(0, 1, 2), max_geoms: int = 400) -> bool:
        """A MuJoCo scene in the live 3D view: `target` is a Gymnasium env over MuJoCo (its model and data are found),
        or a mujoco.MjModel with its MjData as `data`. The geoms are logged once; scene_step() moves them, every
        `every` steps and at most thirty times a second. True when there is a scene to show."""
        if self._rr is None:
            return False
        model, d = target, data
        if data is None:
            unwrapped = getattr(target, "unwrapped", target)
            model, d = getattr(unwrapped, "model", None), getattr(unwrapped, "data", None)
        if model is None or d is None or not hasattr(model, "geom_type") or not hasattr(d, "geom_xpos"):
            return False
        import numpy as np

        rr = self._rr
        try:
            import mujoco

            body_name = lambda i: mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, int(model.geom_bodyid[i])) or ""  # noqa: E731
        except Exception:
            body_name = lambda i: ""  # noqa: E731
        try:
            rr.log("world", rr.ViewCoordinates.RIGHT_HAND_Z_UP, static=True)
        except Exception:
            pass
        geoms = []
        for i in range(min(int(model.ngeom), max_geoms)):
            if int(model.geom_group[i]) not in groups:
                continue
            kind, size, rgba = int(model.geom_type[i]), [float(x) for x in model.geom_size[i]], [float(x) for x in model.geom_rgba[i]]
            color = [int(round(c * 255)) for c in rgba]
            path = f"world/geoms/{i}" + (f"_{_slug(body_name(i))}" if body_name(i) else "")
            shape = None
            try:
                if kind == 0:  # plane: its normal is +z; a sheet the size given, or a wide one
                    # MuJoCo's floors are tens of metres; drawn whole, the body is a speck in the viewer's first framing.
                    shape = rr.Boxes3D(half_sizes=[[min(size[0] or 3.0, 3.0), min(size[1] or 3.0, 3.0), 0.005]], colors=[color], fill_mode="solid")
                elif kind == 2:
                    shape = rr.Ellipsoids3D(radii=[size[0]], colors=[color], fill_mode="solid")
                elif kind == 3:  # a capsule in Rerun starts at the origin; MuJoCo's is centred
                    shape = rr.Capsules3D(lengths=[2 * size[1]], radii=[size[0]], translations=[[0.0, 0.0, -size[1]]], colors=[color], fill_mode="solid")
                elif kind == 4:
                    shape = rr.Ellipsoids3D(half_sizes=[size], colors=[color], fill_mode="solid")
                elif kind == 5:
                    shape = rr.Cylinders3D(lengths=[2 * size[1]], radii=[size[0]], colors=[color], fill_mode="solid")
                elif kind == 6:
                    shape = rr.Boxes3D(half_sizes=[size], colors=[color], fill_mode="solid")
                elif kind == 7:
                    mesh = int(model.geom_dataid[i])
                    va, vn = int(model.mesh_vertadr[mesh]), int(model.mesh_vertnum[mesh])
                    fa, fn = int(model.mesh_faceadr[mesh]), int(model.mesh_facenum[mesh])
                    if vn and fn:
                        shape = rr.Mesh3D(vertex_positions=np.asarray(model.mesh_vert[va:va + vn], np.float32), triangle_indices=np.asarray(model.mesh_face[fa:fa + fn], np.uint32), vertex_colors=np.tile(np.array(color, np.uint8), (vn, 1)))
            except Exception as error:
                self.note(f"geom {i} not shown in 3D: {error}", by="koios", tag="problem")
                continue
            if shape is None:
                continue
            rr.log(path, shape, static=True)
            geoms.append((i, path))
        if not geoms:
            return False
        self._scene = {"data": d, "geoms": geoms, "every": max(1, int(every)), "n": 0, "last": 0.0}
        self.note(f"live 3D: {len(geoms)} geoms of {int(model.ngeom)}", by="koios", tag="scene")
        self.scene_step(force=True)
        return True

    def scene_step(self, force: bool = False):
        """The geoms moved to where the simulation has them now (scene()). Cheap when there is no scene."""
        s = self._scene
        if not s:
            return
        s["n"] += 1
        now = time.time()
        if not force and (s["n"] % s["every"] or now - s["last"] < 1 / 30):
            return
        s["last"] = now
        rr, d = self._rr, s["data"]
        try:
            self._rr_time(max(self.step, self.env_steps))
            xpos, xmat = d.geom_xpos, d.geom_xmat
            for i, path in s["geoms"]:
                rr.log(path, rr.Transform3D(translation=xpos[i], mat3x3=xmat[i].reshape(3, 3)))
        except Exception:
            pass

    def _auto_scene(self, env):
        if self._rr is not None and self._scene is None:
            self.scene(env)

    def _end_live3d(self):
        if self._rr is None:
            return
        try:
            self._rr.disconnect()  # flushes scene.rrd; the stream ends with the process anyway
        except Exception:
            pass

    def grab(self, render, frames: list) -> bool:
        """frames.append(render()) when it gives a frame. A renderer that fails is noted on the timeline once and not
        asked again, so a machine that can't render still trains; the doctor says why."""
        if getattr(self, "_no_render", False) or len(frames) >= self.max_frames:
            return False
        try:
            frame = render()
        except Exception as error:
            self._no_render = True
            self.note(f"rendering failed, so no videos: {error}. Run `python koios_telemetry.py doctor`.", by="koios", tag="problem")
            return False
        if frame is None:
            return False
        frames.append(frame)
        return True

    def count(self, env_steps: int = 1):
        """Environment steps taken, for the steps-a-second in the heartbeat (run.wrap counts by itself)."""
        self.env_steps += int(env_steps)

    def log_vector(self, infos, step: int | None = None):
        """Episodes finished in a Gymnasium vector env, read off RecordEpisodeStatistics' infos (Gymnasium 1.x keeps
        them as arrays under "episode" with a "_episode" mask; 0.29 under "final_info")."""
        step = self._at(step)
        found = 0
        if isinstance(infos, dict) and "episode" in infos:
            ep = infos["episode"]
            mask = infos.get("_episode")
            rs, ls = ep.get("r"), ep.get("l")
            if rs is not None:
                for i in range(len(rs)):
                    if mask is None or bool(mask[i]):
                        success = None
                        for key in ("is_success", "success"):
                            if key in infos and (infos.get(f"_{key}") is None or bool(infos[f"_{key}"][i])):
                                success = infos[key][i]
                        self.episode(float(rs[i]), int(ls[i]) if ls is not None else None, step=step, success=success)
                        found += 1
        elif isinstance(infos, dict) and "final_info" in infos:
            for info in infos["final_info"]:
                if info and "episode" in info:
                    self.episode(float(info["episode"]["r"]), int(info["episode"]["l"]), step=step, success=info.get("is_success"))
                    found += 1
        return found

    def wrap(self, env, record: bool = True, name: str = "rollout"):
        """A Gymnasium env that logs its own episodes and, one in video_every, records them (render_mode="rgb_array").
        For one env in this process, an evaluation env say; for vector envs, use log_vector."""
        import gymnasium as gym

        run = self

        class KoiosWatch(gym.Wrapper):
            def __init__(self, env):
                super().__init__(env)
                self._ret, self._len, self._frames = 0.0, 0, None

            def _grab(self):
                frame = None
                if self._frames is not None and len(self._frames) < run.max_frames:
                    try:
                        frame = self.env.render()
                    except Exception as error:
                        run.note(f"render failed, videos are off: {error}", by="koios", tag="problem")
                        self._frames = None
                        return
                    if frame is not None:
                        self._frames.append(frame)
                # The live view, while someone watches: the frame just taken for the video, else one rendered for it.
                if getattr(self.env, "render_mode", None) == "rgb_array":
                    run.live(frame if frame is not None else self.env.render, ret=round(self._ret, 3), length=self._len)

            def reset(self, **kwargs):
                obs, info = self.env.reset(**kwargs)
                run._auto_scene(self.env)
                self._ret, self._len = 0.0, 0
                self._frames = [] if record and run.wants_video() and getattr(self.env, "render_mode", None) == "rgb_array" else None
                self._grab()
                return obs, info

            def step(self, action):
                obs, reward, terminated, truncated, info = self.env.step(action)
                self._ret += float(reward)
                self._len += 1
                run.count()
                run.scene_step()
                self._grab()
                if terminated or truncated:
                    success = info.get("is_success", info.get("success"))
                    frames = self._frames
                    self._frames = None
                    run.episode(self._ret, self._len, step=max(run.step, run.env_steps), success=success)
                    if frames:
                        run.video(name, frames, fps=float(self.env.metadata.get("render_fps") or 30))
                return obs, reward, terminated, truncated, info

        return KoiosWatch(env)

    def finish(self, status: str = "finished", error: str | None = None):
        if self.finished:
            return
        self.finished = True
        self._stop.set()
        fields = {"status": status, "step": self.step, "episodes": self.episodes, "elapsed": round(time.time() - self._t0, 2)}
        if error:
            fields["error"] = error[-4000:]
        bare = sorted(k for k in self._unlabelled if not self._labelled(k))
        if bare:
            text = f"charts with no axis labels: {', '.join(bare[:12])}{' …' if len(bare) > 12 else ''}. Label them with run.axes(name, y=..., x=...)."
            self._event("note", step=self.step, text=text, by="koios", tag="axes")
            print(f"[koios] {text}", flush=True)
        self._event("end", **fields)
        self.meta.update(status=status, ended=time.time())
        if error:
            self.meta["error"] = error[-4000:]
        try:
            self._write_meta()
        except Exception:
            pass
        # The run's folder pushed to the data place one last time, run.json with its end in it.
        if getattr(self, "_data_sync", None) is not None:
            try:
                self._data_sync.close()
            except Exception:
                pass
        self._end_live3d()
        if self._tb is not None:
            self._tb.close()
        with self._lock:
            self._file.close()

    def _excepthook(self, kind, value, tb):
        self._failure = "".join(traceback.format_exception(kind, value, tb))
        self.finish("stopped" if issubclass(kind, KeyboardInterrupt) else "crashed", self._failure)
        self._previous_hook(kind, value, tb)

    def _at_exit(self):
        self.finish("crashed" if self._failure else "finished", self._failure)

    def __enter__(self):
        return self

    def __exit__(self, kind, value, tb):
        if kind is None:
            self.finish()
        else:
            self.finish("stopped" if issubclass(kind, KeyboardInterrupt) else "crashed", "".join(traceback.format_exception(kind, value, tb)))
        return False


# --------------------------------------------------------------- reading ----


def _value(v):
    if isinstance(v, str):
        return {"nan": float("nan"), "inf": float("inf"), "-inf": float("-inf")}.get(v)
    return float(v) if isinstance(v, (int, float)) else None


def read_run(directory: str) -> dict:
    """A run folder read back: what the Sim pane draws, as Python data."""
    meta = {}
    try:
        with open(os.path.join(directory, "run.json"), encoding="utf-8") as f:
            meta = json.load(f)
    except Exception:
        pass
    run = {"dir": directory, "meta": meta, "scalars": {}, "episodes": [], "media": [], "dreams": [], "notes": [], "checkpoints": [], "evaluations": [], "axes": {}, "x_label": None, "status": meta.get("status", "running"), "error": meta.get("error"), "first_t": None, "last_t": None, "step": 0, "sps": None}
    try:
        with open(os.path.join(directory, "events.jsonl"), encoding="utf-8") as f:
            lines = f.readlines()
    except Exception:
        lines = []
    for line in lines:
        try:
            e = json.loads(line)
        except Exception:
            continue
        t = e.get("t")
        if isinstance(t, (int, float)):
            run["first_t"] = t if run["first_t"] is None else run["first_t"]
            run["last_t"] = t
        if isinstance(e.get("step"), (int, float)):
            run["step"] = max(run["step"], int(e["step"]))
        kind = e.get("kind")
        if kind == "start":
            run["status"] = "running"
            run["error"] = None
        elif kind == "scalars":
            for k, v in (e.get("values") or {}).items():
                y = _value(v)
                if y is not None:
                    run["scalars"].setdefault(k, []).append((e.get("step", 0), y))
        elif kind == "axes":
            if isinstance(e.get("x"), str) and e["x"].strip():
                run["x_label"] = e["x"].strip()
            for k, said in (e.get("axes") or {}).items():
                said = {"y": said} if isinstance(said, str) else said if isinstance(said, dict) else {}
                labels = {a: str(v).strip() for a, v in said.items() if a in ("x", "y") and isinstance(v, str) and v.strip()}
                run["axes"].setdefault(k, {}).update(labels)
        elif kind == "episode":
            y = _value(e.get("return"))
            if y is not None:
                run["episodes"].append({"step": e.get("step", 0), "return": y, "length": e.get("length"), "success": e.get("success")})
        elif kind == "media":
            run["media"].append(e)
        elif kind == "dream":
            run["dreams"].append(e)
        elif kind == "note":
            run["notes"].append(e)
        elif kind == "checkpoint":
            run["checkpoints"].append(e)
        elif kind == "evaluation":
            run["evaluations"].append(e)
        elif kind == "heartbeat":
            run["sps"] = e.get("sps")
        elif kind == "end":
            run["status"] = e.get("status", "finished")
            run["error"] = e.get("error")
    return run


def find_runs(root: str = ".") -> list[str]:
    """Every run folder under root (an events.jsonl in it), newest first."""
    # The same walk as the Sim pane's (src/lib/simTelemetry.ts, READ_CODE): folders that can't hold a run pruned.
    prune = {".git", ".reader", "node_modules", "wandb", "data", "datasets", "__pycache__", ".venv", "venv", "site-packages", ".ipynb_checkpoints"}
    found = []
    for here, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in prune and not d.startswith(".")]
        if here[len(root):].count(os.sep) >= 6:
            dirs[:] = []
        if "events.jsonl" in files:
            found.append(here)
    return sorted(found, key=lambda d: os.path.getmtime(os.path.join(d, "events.jsonl")), reverse=True)


def _mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def _std(xs):
    if len(xs) < 2:
        return 0.0
    m = _mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def _median(xs):
    s = sorted(xs)
    return s[len(s) // 2] if s else 0.0


def _rolling(xs, w):
    out, total = [], 0.0
    for i, x in enumerate(xs):
        total += x
        if i >= w:
            total -= xs[i - w]
        out.append(total / min(i + 1, w))
    return out


VALUE_LOSS = re.compile(r"(value|critic|vf|q)[ _/-]?loss|loss[ _/-]?(value|critic|vf|q)\b", re.I)


def diagnose(run: dict, now: float | None = None) -> list[dict]:
    """What looks wrong, or right, in a run, with why it matters and what to try. The same rules as the Sim pane's
    (src/lib/simTelemetry.ts, diagnose); the ids match."""
    now = time.time() if now is None else now
    out = []

    def add(id, level, title, detail, tip):
        out.append({"id": id, "level": level, "title": title, "detail": detail, "try": tip})

    if run["status"] == "crashed":
        last = (run.get("error") or "").strip().splitlines()[-1:] or ["no traceback"]
        add("crashed", "error", "The run crashed", last[0], "Read the traceback in the run's end event or the console; fix, then start again (or resume from the last checkpoint).")
    if run["status"] == "running" and run["last_t"] and now - run["last_t"] > 120:
        add("stalled", "warn", "No news from the run", f"Nothing written for {int(now - run['last_t'])} s, not even a heartbeat.", "The process may have been killed (out of memory, the runtime stopped). Look at the console; resume from the last checkpoint.")
    for name, points in run["scalars"].items():
        bad = next(((s, y) for s, y in points if math.isnan(y) or math.isinf(y)), None)
        if bad:
            add("nan", "error", f"{name} became {'NaN' if math.isnan(bad[1]) else 'infinite'}", f"First at step {bad[0]}.", "Lower the learning rate, clip gradients, normalise observations and rewards, look for a log of zero or a division by a tiny std.")
            break
    returns = [e["return"] for e in run["episodes"] if math.isfinite(e["return"])]
    n = len(returns)
    if n >= 30:
        q = n // 4
        first, last, spread = _mean(returns[:q]), _mean(returns[-q:]), _std(returns) or 1e-9
        if last - first > 0.5 * spread:
            add("improving", "info", "Return is climbing", f"Mean return {first:.3g} over the first quarter of episodes, {last:.3g} over the last.", "Keep going; compare against the paper's or the env's reported score to know how far there is to go.")
        elif last - first < 0.1 * spread:
            add("no-learning", "warn", "Return isn't improving", f"Mean return {first:.3g} early, {last:.3g} lately, over {n} episodes.", "Check the reward reaches the agent (sign, scale), that actions reach the env, the learning rate (try 3e-4), and that the policy isn't deterministic from the start.")
    if n >= 40:
        w = max(5, n // 10)
        rolled = _rolling(returns, w)
        best = max(rolled)
        at = rolled.index(best)
        if at < len(rolled) - w and best - rolled[-1] > 0.5 * (best - rolled[0]) and best - rolled[0] > 0.5 * (_std(returns) or 1e-9):
            add("collapse", "warn", "Performance collapsed after peaking", f"The rolling mean return peaked at {best:.3g} and is now {rolled[-1]:.3g}.", "Too large policy updates: lower the learning rate, tighten PPO's clip or add a KL target, keep the best checkpoint.")
    for name, points in run["scalars"].items():
        ys = [y for _, y in points if math.isfinite(y)]
        if len(ys) < 10:
            continue
        if "entropy" in name.lower():
            early, late = _mean(ys[:3]), _mean(ys[-3:])
            if early > 0 and late < 0.05 * early:
                add("entropy-collapse", "warn", f"{name} collapsed", f"From {early:.3g} to {late:.3g}: the policy stopped exploring.", "Raise the entropy coefficient, lower the learning rate, or check the action distribution's std isn't being driven to zero.")
        if VALUE_LOSS.search(name):
            early, late = _median([abs(y) for y in ys[:5]]), _mean([abs(y) for y in ys[-3:]])
            if early > 0 and late > 100 * early:
                add("loss-explode", "warn", f"{name} is exploding", f"From about {early:.3g} to {late:.3g}.", "Normalise or scale the rewards, clip the value loss, lower the critic's learning rate, check the bootstrapping at truncation.")
    dreams = [d for d in run["dreams"] if d.get("error")]
    if dreams:
        errors = [e for e in dreams[-1]["error"][int(dreams[-1].get("context") or 0):] if isinstance(e, (int, float))]
        if len(errors) >= 6:
            third = len(errors) // 3
            a, b = _mean(errors[:third]), _mean(errors[-third:])
            if a > 0 and b > 3 * a:
                add("dream-drift", "warn" if b > 10 * a else "info", "The world model drifts over the horizon", f"Prediction error {a:.3g} in the first third of the rollout, {b:.3g} in the last.", "Errors compound when the model feeds on its own predictions: train with multi-step (latent overshooting) losses, imagine shorter horizons, or add stochastic latents.")
    if len(dreams) >= 4:
        means = [_mean([e for e in d["error"] if isinstance(e, (int, float))]) for d in dreams]
        if _mean(means[-2:]) >= 0.95 * _mean(means[:2]):
            add("dream-stuck", "warn", "The world model isn't getting better", f"Mean prediction error {_mean(means[:2]):.3g} in the first comparisons, {_mean(means[-2:]):.3g} in the last.", "Check the model sees enough varied data (exploration), its capacity, its learning rate, and that the decoder's loss isn't dominating the dynamics loss.")
    axes = run.get("axes") or {}
    bare = [k for k in run["scalars"] if not ((axes.get(k) or {}).get("y") or ("/" in k and (axes.get(k.split("/")[0]) or {}).get("y")))]
    if bare:
        what = ", ".join(bare[:4]) + (f" and {len(bare) - 4} more" if len(bare) > 4 else "")
        add("unlabelled", "warn", "A chart has no axis labels" if len(bare) == 1 else f"{len(bare)} charts have no axis labels", f"Nothing says what {what} measure{'s' if len(bare) == 1 else ''}.", 'Label them in the code: run.axes("name", y="what it measures, with units", x="what the step counts") — or run.axes(x="env steps") once for the whole run.')
    if not run["episodes"] and not run["dreams"] and run["scalars"] and run["first_t"] and (run["last_t"] or now) - run["first_t"] > 300:
        add("no-episodes", "info", "No episodes logged", "The run logs numbers but no episode has been reported.", "Wrap the env with run.wrap(env) or call run.episode(return, length) when one ends, so returns can be judged.")
    return out


def _ago(seconds: float) -> str:
    seconds = max(0, int(seconds))
    return f"{seconds} s" if seconds < 90 else f"{seconds // 60} min" if seconds < 5400 else f"{seconds // 3600} h"


def summary(root: str = ".", limit: int = 8) -> str:
    """Every run under root, in a few lines each: status, episodes, return, the last numbers, notes, and diagnostics.
    Written for coding agents as much as for people: read this before changing a run."""
    runs = find_runs(root)
    if not runs:
        return f"No runs under {os.path.abspath(root)} (no events.jsonl). Log with koios_telemetry.Run."
    now = time.time()
    lines = []
    for directory in runs[:limit]:
        r = read_run(directory)
        meta = r["meta"]
        lines.append(f"== {meta.get('id') or os.path.basename(directory)}  [{r['status']}]  {meta.get('sim') or ''}")
        if r["last_t"]:
            lines.append(f"   last written {_ago(now - r['last_t'])} ago · step {r['step']}" + (f" · {r['sps']:.0f} env steps/s" if isinstance(r["sps"], (int, float)) and r["status"] == "running" else ""))
        returns = [e["return"] for e in r["episodes"] if math.isfinite(e["return"])]
        if returns:
            k = max(1, len(returns) // 10)
            successes = [e["success"] for e in r["episodes"][-50:] if e.get("success") is not None]
            lines.append(f"   episodes {len(returns)} · return first {_mean(returns[:k]):.4g} → last {_mean(returns[-k:]):.4g} · best {max(returns):.4g}" + (f" · success {100 * sum(successes) / len(successes):.0f}% (last {len(successes)})" if successes else ""))
        if r["scalars"]:
            last = ", ".join(f"{k}={v[-1][1]:.4g}" for k, v in list(r["scalars"].items())[:10])
            lines.append(f"   last values: {last}")
        for ev in r["evaluations"][-3:]:
            ours = ", ".join(f"{k}={v:.4g}" if isinstance(v, (int, float)) else f"{k}={v}" for k, v in (ev.get("metrics") or {}).items())
            paper = ev.get("paper") or {}
            against = ", ".join(f"{k}: paper {paper[k]:.4g}" for k in (ev.get("metrics") or {}) if isinstance(paper.get(k), (int, float)))
            lines.append(f"   evaluation '{ev.get('name', 'eval')}' @ {ev.get('step')}: {ours}" + (f" · {against}" if against else "") + (f" · {ev['protocol']}" if ev.get("protocol") else ""))
        if r["dreams"]:
            d = r["dreams"][-1]
            errs = [e for e in d.get("error") or [] if isinstance(e, (int, float))]
            if errs:
                lines.append(f"   world model: {len(r['dreams'])} comparisons; latest error {errs[0]:.3g} at step 1 → {errs[-1]:.3g} at step {len(errs)}")
        if r["media"]:
            lines.append(f"   videos: {len(r['media'])}, latest {r['media'][-1].get('path')}")
        for note in r["notes"][-5:]:
            lines.append(f"   note @ {note.get('step')}: [{note.get('by')}] {note.get('text')}")
        for finding in diagnose(r, now):
            lines.append(f"   {finding['level'].upper()}: {finding['title']} - {finding['detail']} Try: {finding['try']}")
        if r["status"] == "crashed" and r.get("error"):
            lines.append("   " + "\n   ".join(r["error"].strip().splitlines()[-6:]))
    if len(runs) > limit:
        lines.append(f"... and {len(runs) - limit} older runs")
    return "\n".join(lines)


# ---------------------------------------------------------------- bridge ----

STEP_KEYS = ("step", "global_step", "_step", "frame", "env_steps", "timesteps", "total_timesteps")
EPISODE_KEYS = ("episode/score", "episode/return", "episode_reward", "eval/episode_reward", "episode_return", "return", "ep_rew_mean")
LENGTH_KEYS = ("episode/length", "episode_length", "eval/episode_length", "ep_len_mean")
SUCCESS_KEYS = ("episode/success", "episode_success", "eval/episode_success", "success")


def _rows(path: str, offset: int):
    """New rows of a growing .jsonl or .csv file from a byte offset: (rows, new offset)."""
    with open(path, encoding="utf-8", errors="replace") as f:
        if path.endswith(".csv"):
            header = f.readline().strip().split(",")
            if offset == 0:
                offset = f.tell()
            f.seek(offset)
            rows = []
            for line in iter(f.readline, ""):
                if not line.endswith("\n"):
                    break
                offset = f.tell()
                cells = line.strip().split(",")
                rows.append({k: c for k, c in zip(header, cells)})
            return rows, offset
        f.seek(offset)
        rows = []
        for line in iter(f.readline, ""):
            if not line.endswith("\n"):
                break
            offset = f.tell()
            try:
                row = json.loads(line)
            except Exception:
                continue
            if isinstance(row, dict):
                rows.append(row)
        return rows, offset


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def bridge(source: str, name: str = "bridge", sim: str | None = None, videos: str | None = None, follow: bool = False, run: Run | None = None, until_pid: int | None = None) -> Run:
    """Another codebase's logs as a Koios run, without touching its code: a metrics .jsonl (DreamerV3) or .csv
    (TD-MPC2, SB3's progress.csv) read as it grows, and a folder of .mp4/.gif videos (Isaac Lab's --video,
    Gymnasium's RecordVideo) taken in as they appear."""
    run = run or Run(name, config={"bridged_from": source, "videos": videos}, sim=sim, echo=False)
    offset, seen, count, current = 0, set(), 0, None
    while True:
        last_round = until_pid is not None and not _alive(until_pid)
        # A pattern (logs/*/eval.csv) follows the newest file that matches, from its start when it changes.
        path = source
        if source and any(ch in source for ch in "*?["):
            matches = sorted(glob.glob(source, recursive=True), key=os.path.getmtime)
            path = matches[-1] if matches else None
        if path != current:
            current, offset = path, 0
        if path and os.path.exists(path):
            rows, offset = _rows(path, offset)
            for row in rows:
                count += 1
                step = next((int(float(row[k])) for k in STEP_KEYS if k in row and _value(_try_float(row[k])) is not None), count)
                values = {k: _try_float(v) for k, v in row.items() if k not in STEP_KEYS}
                values = {k: v for k, v in values.items() if isinstance(v, float)}
                ret = next((values.pop(k) for k in EPISODE_KEYS if k in values), None)
                length = next((values.pop(k) for k in LENGTH_KEYS if k in values), None)
                success = next((values.pop(k) for k in SUCCESS_KEYS if k in values), None)
                if ret is not None and math.isfinite(ret):
                    run.episode(ret, int(length) if length is not None and math.isfinite(length) else None, step=step, success=success if success is not None and math.isfinite(success) else None)
                if values:
                    run.log(values, step=step)
        if videos and os.path.isdir(videos):
            for path in sorted(glob.glob(os.path.join(videos, "**", "*"), recursive=True)):
                if path in seen or not path.lower().endswith((".mp4", ".gif", ".webm")):
                    continue
                if time.time() - os.path.getmtime(path) < 3:
                    continue  # still being written
                seen.add(path)
                target = os.path.join(run.dir, "media", os.path.basename(path))
                shutil.copyfile(path, target)
                match = re.search(r"(\d+)", os.path.basename(path))
                step = int(match.group(1)) if match else run.step
                run._event("media", step=step, name="video", path=os.path.relpath(target, run.dir), type="gif" if path.lower().endswith(".gif") else "video", bytes=os.path.getsize(target), caption=os.path.relpath(path, videos))
        if not follow or last_round:
            return run
        time.sleep(2.0)


def _try_float(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).strip())
    except Exception:
        return None


# ---------------------------------------------------------------- doctor ----

# Each simulator in the Koios catalogue (src/lib/simulators.ts, `module`): what to import to know it is installed.
SIMULATORS = {
    "gymnasium": "gymnasium",
    "box2d": "Box2D",
    "mujoco": "mujoco",
    "dm_control": "dm_control",
    "mujoco_playground": "mujoco_playground",
    "brax": "brax",
    "gymnasium_robotics": "gymnasium_robotics",
    "myosuite": "myosuite",
    "metaworld": "metaworld",
    "robosuite": "robosuite",
    "maniskill": "mani_skill",
    "genesis": "genesis",
    "pybullet": "pybullet",
    "isaaclab": "isaaclab",
    "drake": "pydrake",
    "ale": "ale_py",
    "minigrid": "minigrid",
    "crafter": "crafter",
    "craftax": "craftax",
    "gymnax": "gymnax",
    "vizdoom": "vizdoom",
    "nle": "nle",
    "minerl": "minerl",
    "mlagents": "mlagents_envs",
    "godot_rl": "godot_rl",
    "pettingzoo": "pettingzoo",
    "highway_env": "highway_env",
    "metadrive": "metadrive",
    "carla": "carla",
    "habitat": "habitat_sim",
    "minari": "minari",
    "shimmy": "shimmy",
}


class _RrdTail(threading.Thread):
    """GET /scene.rrd on 127.0.0.1: the file's bytes so far, then the ones added as the run logs, until the run is
    over or the reader goes; Rerun's web viewer decodes the stream as it comes, so a page sees the run live."""

    def __init__(self, path: str, port: int, finished):
        super().__init__(name="koios-rrd", daemon=True)
        self.path, self.port, self.finished = path, port, finished

    def run(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        tail = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_):
                pass

            def do_OPTIONS(self):
                self.send_response(204)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Headers", "*")
                self.end_headers()

            def do_GET(self):
                if not self.path.split("?")[0].endswith(".rrd"):
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                try:
                    with open(tail.path, "rb") as f:
                        quiet = 0
                        while True:
                            data = f.read(1 << 20)
                            if data:
                                self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
                                self.wfile.flush()
                                quiet = 0
                                continue
                            if tail.finished():
                                quiet += 1
                                if quiet > 5:  # the footer written at the end has been sent
                                    break
                            time.sleep(0.2)
                    self.wfile.write(b"0\r\n\r\n")
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass

        try:
            server = ThreadingHTTPServer(("127.0.0.1", self.port), Handler)
            server.daemon_threads = True
            server.serve_forever()
        except Exception:
            pass


def _blueprint(rr):
    """How the viewer opens: the world large on the left, the returns, the numbers and the notes down the right."""
    try:
        import rerun.blueprint as rrb

        return rrb.Blueprint(
            rrb.Horizontal(
                rrb.Spatial3DView(origin="world", name="World"),
                rrb.Vertical(rrb.TimeSeriesView(origin="episodes", name="Episodes"), rrb.TimeSeriesView(origin="metrics", name="Numbers"), rrb.TextLogView(origin="notes", name="Notes"), row_shares=[2, 2, 1]),
                column_shares=[3, 2],
            ),
            collapse_panels=True,
        )
    except Exception:
        return None


def _free_port() -> int:
    import socket

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _have(module: str) -> bool:
    """Whether a module can be imported, without importing it (a parent that is missing is a no)."""
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def _run(cmd, timeout=20):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout + p.stderr).strip()
    except Exception as error:
        return -1, str(error)


_THREADS_CHECK = """
import time, torch
x = torch.randn(256, 256)
layer = torch.nn.Linear(256, 256)
out = {}
for n in sorted({1, torch.get_num_threads()}):
    torch.set_num_threads(n)
    for _ in range(5):
        torch.relu(layer(x))
    t = time.perf_counter()
    for _ in range(100):
        torch.relu(layer(x))
    out[n] = (time.perf_counter() - t) * 10
print(" ".join(f"{n}:{ms:.3f}" for n, ms in out.items()))
"""

_RENDER_CHECK = """
import os, sys
sys.path.insert(0, sys.argv[1])
import koios_telemetry  # picks the off-screen renderer
import mujoco
m = mujoco.MjModel.from_xml_string('<mujoco><worldbody><light pos="0 0 3"/><geom type="sphere" size=".2"/></worldbody></mujoco>')
d = mujoco.MjData(m)
r = mujoco.Renderer(m, 48, 64)
mujoco.mj_forward(m, d)
r.update_scene(d)
img = r.render()
print("ok", os.environ.get("MUJOCO_GL"), img.shape, int(img.max()))
"""


def doctor(render_check: bool = True) -> dict:
    """What this machine is, which simulators are installed, and whether it can render off-screen and write videos."""
    gpus = []
    if shutil.which("nvidia-smi"):
        code, out = _run(["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"])
        if code == 0:
            for line in out.splitlines():
                parts = [p.strip() for p in line.split(",")]
                if len(parts) >= 3:
                    gpus.append({"name": parts[0], "memMb": _number(parts[1]), "driver": parts[2]})
    rtx = any(re.search(r"RTX|A10|A40|L4|L40|A6000|Ada|Quadro", g["name"]) for g in gpus)
    installed = {sid: _have(module) for sid, module in SIMULATORS.items()}
    ffmpeg = shutil.which("ffmpeg") is not None
    try:
        import imageio_ffmpeg

        ffmpeg = ffmpeg or bool(imageio_ffmpeg.get_ffmpeg_exe())
    except Exception:
        pass
    out = {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "colab": bool(os.environ.get("COLAB_RELEASE_TAG")) or _have("google.colab"),
        "cpus": os.cpu_count(),
        "gpus": gpus,
        "rtx": rtx,
        "display": bool(os.environ.get("DISPLAY")),
        "egl": _has_lib("EGL"),
        "osmesa": _has_lib("OSMesa"),
        "vulkan": _has_lib("vulkan"),
        "java": shutil.which("java") is not None,
        "ffmpeg": ffmpeg,
        "imageio": _have("imageio"),
        "pillow": _have("PIL"),
        "torch": _have("torch"),
        "jax": _have("jax"),
        "env": {k: os.environ.get(k) for k in ("MUJOCO_GL", "PYOPENGL_PLATFORM", "SDL_VIDEODRIVER")},
        "installed": installed,
        "render": None,
    }
    if out["torch"]:
        # A small network's step on one CPU thread against torch's default pool: on a container with a CPU quota the
        # pool can be a hundred times slower, and the templates read KOIOS_TORCH_THREADS.
        code, text = _run([sys.executable, "-c", _THREADS_CHECK], timeout=120)
        if code == 0 and text:
            times = {int(n): float(ms) for n, ms in (part.split(":") for part in text.split()[-2:] if ":" in part)}
            best = min(times, key=times.get)
            out["torch_threads"] = {"ms": times, "best": best}
    if render_check and installed.get("mujoco"):
        here = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.getcwd()
        code, text = _run([sys.executable, "-c", _RENDER_CHECK, here], timeout=90)
        out["render"] = {"ok": code == 0 and text.splitlines()[-1:][0].startswith("ok") if text else False, "text": text.splitlines()[-1] if text else ""}
    return out


def _doctor_text(d: dict) -> str:
    yes = lambda v: "yes" if v else "no"  # noqa: E731
    lines = [
        f"python {d['python']} on {d['platform']}" + (" (Colab)" if d["colab"] else ""),
        f"CPUs {d['cpus']} · GPUs: " + (", ".join(f"{g['name']} ({g['memMb']} MB)" for g in d["gpus"]) or "none"),
        f"display {yes(d['display'])} · EGL {yes(d['egl'])} · OSMesa {yes(d['osmesa'])} · Vulkan {yes(d['vulkan'])} · ffmpeg {yes(d['ffmpeg'])} · Java {yes(d['java'])}",
        f"torch {yes(d['torch'])} · jax {yes(d['jax'])} · renderer {d['env'].get('MUJOCO_GL') or 'default'}",
        "installed: " + (", ".join(k for k, v in d["installed"].items() if v) or "none of the catalogue"),
    ]
    if d.get("render"):
        lines.append(f"MuJoCo off-screen render: {'works' if d['render']['ok'] else 'FAILED'} - {d['render']['text']}")
    if d.get("torch_threads"):
        t = d["torch_threads"]
        lines.append("torch on the CPU, a small layer: " + ", ".join(f"{n} thread{'s' if n > 1 else ''} {ms:.2f} ms" for n, ms in t["ms"].items()) + f" -> export KOIOS_TORCH_THREADS={t['best']}")
    if not d["ffmpeg"]:
        lines.append("videos: no ffmpeg; `pip install imageio imageio-ffmpeg` for MP4 (GIFs through Pillow otherwise)")
    if not d["rtx"]:
        lines.append("Isaac Lab / Isaac Sim need an NVIDIA RTX-class GPU: not on this machine.")
    return "\n".join(lines)


# ------------------------------------------------------------- catalogue ----

CATALOGUE_FILE = "koios_simulators.json"


def catalogue() -> dict | None:
    """koios_simulators.json: beside this module, in the folder, or on the Koios helper path (.reader/pylib)."""
    here = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.getcwd()
    places = [here, os.getcwd(), os.path.join(os.getcwd(), ".reader", "pylib"), os.environ.get("KOIOS_PYLIB", "")]
    for place in places:
        path = os.path.join(place, CATALOGUE_FILE) if place else ""
        if path and os.path.isfile(path):
            try:
                with open(path, encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                continue
    return None


_RESOLVE = '''def resolve(env_id):
    """The id as registered, or the newest registered version of it when that one isn't (versions move: -v4, -v5)."""
    if env_id in gym.registry:
        return env_id
    base = env_id.rsplit("-v", 1)[0]
    found = [k for k in gym.registry if k.rsplit("-v", 1)[0] == base and k.rsplit("-v", 1)[-1].isdigit()]
    return max(found, key=lambda k: int(k.rsplit("-v", 1)[1])) if found else env_id'''

_MAKE_ENV = '''def make_env(render_mode=None, env_id=None):
    """A new environment; render_mode="rgb_array" to record it. An env that can't render that way is made without."""
    env_id = env_id or ENV_ID
    try:
        return _make(env_id, render_mode)
    except Exception:
        if render_mode is None:
            raise
        return _make(env_id, None)
'''


def env_py(sim: dict, env_id: str) -> str:
    """env.py for a Gymnasium simulator, as the Koios page writes it (src/lib/simulators.ts, envPy)."""
    body = sim.get("make") or "    return gym.make(resolve(env_id), render_mode=render_mode)"
    imports = f"{sim['imports']}\n" if sim.get("imports") else ""
    head = f'"""The environment this project runs: {sim["name"]}, {env_id}.\n\nEvery script imports make_env from here, so another environment is another ENV_ID (or another body for _make).\n"""\n'
    head += "import koios_telemetry  # noqa: F401  (first: it picks an off-screen renderer before any simulator loads)\nimport gymnasium as gym\n"
    return f"{head}{imports}\nSIM = {json.dumps(sim['id'])}\nENV_ID = {json.dumps(env_id)}\n\n\n{_RESOLVE}\n\n\ndef _make(env_id, render_mode):\n{body}\n\n\n{_MAKE_ENV}"


def native_env_py(sim: dict, env_id: str) -> str:
    head = f'"""The environment this project runs: {sim["name"]}, {env_id}. It has an API of its own (see main.py), so make_env\nis not a Gymnasium one.\n"""\n'
    return f"{head}SIM = {json.dumps(sim['id'])}\nENV_ID = {json.dumps(env_id)}\n\n\ndef make_env(render_mode=None, env_id=None):\n    raise NotImplementedError({json.dumps(sim['name'] + ' has its own API: wrap it as a gymnasium.Env here to use the Gymnasium templates')})\n"


def setup_sh(sim: dict) -> str:
    extra = ["numpy", "imageio", "imageio-ffmpeg", "pillow", "rerun-sdk"] + (['"gymnasium>=1.0"'] if sim.get("api") == "gymnasium" else [])
    lines = ["#!/usr/bin/env bash", "# What this project needs, installed on the machine it runs on. Run it once per machine (on Colab, once a session).", "set -e", *sim["install"], f"pip install -q {' '.join(extra)}", "# What the machine can do: GPUs, off-screen rendering, video encoding, which simulators import.", "python koios_telemetry.py doctor"]
    return "\n".join(lines) + "\n"


def use(sim_id: str, env_id: str | None, folder: str = ".", force: bool = False) -> list:
    """env.py, setup.sh and, for a simulator with its own API, main.py — written for one simulator and environment.
    setup.sh and main.py already there are left alone unless --force; env.py is always written."""
    book = catalogue()
    if not book:
        raise SystemExit(f"{CATALOGUE_FILE} isn't beside this module, in the folder, or on KOIOS_PYLIB: the Koios page writes it.")
    sims = book["simulators"]
    sim = next((s for s in sims if s["id"] == sim_id), None) or next((s for s in sims if sim_id.lower() in s["name"].lower()), None)
    if not sim:
        raise SystemExit(f"no simulator {sim_id!r}; `python koios_telemetry.py simulators` lists them")
    env = env_id or (sim["envs"][0]["id"] if sim["envs"] else "")
    files = [("env.py", env_py(sim, env) if sim["api"] == "gymnasium" else native_env_py(sim, env)), ("setup.sh", setup_sh(sim))]
    if sim.get("native"):
        files.append(("main.py", sim["native"].replace("__ENV__", env)))
    written = []
    for name, text in files:
        path = os.path.join(folder, name)
        if os.path.exists(path) and not force and name != "env.py":
            continue
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        written.append(name)
    # Run from the Koios helper path (.reader/pylib) rather than the folder: the module and the catalogue are
    # copied in, so the project stands on its own — `python koios_telemetry.py …` and `import koios_telemetry`
    # work from any shell, an agent's included, not only the console the page sets PYTHONPATH for.
    here = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else ""
    if here and os.path.realpath(here) != os.path.realpath(folder):
        import shutil as _shutil

        for name in ("koios_telemetry.py", CATALOGUE_FILE):
            source, target = os.path.join(here, name), os.path.join(folder, name)
            if os.path.isfile(source) and not os.path.exists(target):
                _shutil.copyfile(source, target)
                written.append(name)
    needs = {"no": "any CPU", "helps": "faster on a GPU", "needs": "a GPU", "rtx": "an NVIDIA RTX GPU"}[sim["gpu"]] + (", Colab" if sim["colab"] else ", not Colab") + (", Linux" if sim.get("linux") else "")
    print(f"{sim['name']} · {env}: wrote {', '.join(written) or 'nothing new (--force to replace)'}. Needs {needs}. Run `bash setup.sh`, then `python koios_telemetry.py doctor`. Docs: {sim['docs']}")
    for caveat in sim.get("caveats") or []:
        print(f"  note: {caveat}")
    return written


def simulators_text(query: str = "") -> str:
    book = catalogue()
    if not book:
        return f"{CATALOGUE_FILE} isn't here: the Koios page writes it beside this module."
    lines = []
    for sim in book["simulators"]:
        haystack = f"{sim['id']} {sim['name']} {sim['blurb']} {sim['family']} " + " ".join(e["id"] + " " + e["label"] for e in sim["envs"])
        if query and query.lower() not in haystack.lower():
            continue
        needs = {"no": "any CPU", "helps": "faster on a GPU", "needs": "a GPU", "rtx": "an RTX GPU"}[sim["gpu"]] + (" · Colab" if sim["colab"] else " · not Colab")
        lines.append(f"{sim['id']:<20} {sim['name']} — {sim['blurb']} [{needs}; {sim['api']}]")
        lines.append("                     envs: " + ", ".join(e["id"] for e in sim["envs"][:6]))
    return "\n".join(lines) if lines else "nothing matches"


# ------------------------------------------------------------------- cli ----


def _main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__)
        return 0
    command, rest = argv[0], argv[1:]
    if command == "doctor":
        d = doctor(render_check="--no-render" not in rest)
        print(json.dumps(d) if "--json" in rest else _doctor_text(d))
        return 0
    if command == "summary":
        print(summary(rest[0] if rest else "."))
        return 0
    if command == "tail":
        directory = rest[0] if rest else (find_runs(".") or [None])[0]
        if not directory:
            print("No runs here.")
            return 1
        path = os.path.join(directory, "events.jsonl")
        with open(path, encoding="utf-8") as f:
            while True:
                line = f.readline()
                if line:
                    print(line.rstrip(), flush=True)
                elif "--follow" in rest or "-f" in rest:
                    time.sleep(0.5)
                else:
                    return 0
    if command == "note":
        if len(rest) < 2:
            print('usage: koios_telemetry.py note runs/<run> "text" [--step N] [--by agent]')
            return 2
        directory, text = rest[0], rest[1]
        step = int(rest[rest.index("--step") + 1]) if "--step" in rest else None
        by = rest[rest.index("--by") + 1] if "--by" in rest else "agent"
        if step is None:
            step = read_run(directory)["step"]
        event = {"kind": "note", "t": round(time.time(), 3), "step": step, "text": text, "by": by}
        with open(os.path.join(directory, "events.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(event, separators=(",", ":")) + "\n")
        print(f"noted at step {step}")
        return 0
    if command == "simulators":
        print(simulators_text(" ".join(rest)))
        return 0
    if command == "use":
        if not rest:
            print("usage: koios_telemetry.py use <simulator> [env] [--force]")
            return 2
        use(rest[0], rest[1] if len(rest) > 1 and not rest[1].startswith("--") else None, force="--force" in rest)
        return 0
    if command == "bridge":
        if not rest:
            print("usage: koios_telemetry.py bridge <metrics.jsonl|.csv|glob> [--videos DIR] [--name NAME] [--sim SIM] [--follow | --until-pid PID]")
            return 2
        flag = lambda name: rest[rest.index(name) + 1] if name in rest else None  # noqa: E731
        source = rest[0] if not rest[0].startswith("--") else None
        pid = flag("--until-pid")
        run = bridge(source, name=flag("--name") or "bridge", sim=flag("--sim"), videos=flag("--videos"), follow="--follow" in rest or "-f" in rest or bool(pid), until_pid=int(pid) if pid else None)
        run.finish()
        print(f"bridged into {run.dir}")
        return 0
    print(f"unknown command {command}; try doctor, summary, tail, note, bridge, simulators or use")
    return 2


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
