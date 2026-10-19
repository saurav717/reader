// The `koios` Python module a project's code may import on any machine it
// runs on: checkpoints on a cadence and on a stop signal, with a word to the
// page about each. The page writes it to the project's folder on the machine
// (under .reader/pylib, which the sync rules leave there) before a command
// runs, and puts that folder on PYTHONPATH (src/lib/playground.ts, shellCell),
// so `import koios` works on Colab and on a Companion alike with nothing to
// install.
//
// What it does for a training loop:
//
//   import koios
//   ck = koios.checkpoint("checkpoints", every_steps=500, every_minutes=10)
//   ck.on_save(lambda path: torch.save(model.state_dict(), path))
//   start = ck.resume(lambda path: model.load_state_dict(torch.load(path)))   # a step, or 0
//   for step in range(start, steps):
//       ...
//       ck.step(step, loss=loss.item())
//
// `step()` saves when the cadence says, and at once when the process has been
// told to stop (SIGTERM, SIGINT: the Companion sends SIGTERM to the jobs it
// runs before it shuts down, with a minute's grace); after a stop's save it
// writes a sidecar and exits with 0. Every save prints one line the page
// reads (src/lib/telemetry.ts, checkpointsOf):
//
//   [koios] checkpoint {"path": …, "step": …, "at": …, "reason": "cadence" | "stop", "metrics": {…}, "rank": …, "gpu": …}
//
// A browser that sees the machine go away then knows the last checkpoint and
// can offer to run the command again elsewhere with KOIOS_RESUME set to it,
// which `resume()` takes up.

/** Where the module is written under the project's folder on the machine. */
export const KOIOS_PYLIB = '.reader/pylib';
export const KOIOS_HELPER_PATH = `${KOIOS_PYLIB}/koios/__init__.py`;
/** The marker a save prints, read by checkpointsOf. */
export const CHECKPOINT_MARK = '[koios] checkpoint ';

export const KOIOS_PY = String.raw`"""koios: checkpoints for a project's code, on a cadence and when the machine is about to go.

    import koios
    ck = koios.checkpoint("checkpoints", every_steps=500, every_minutes=10)
    ck.on_save(lambda path: torch.save(model.state_dict(), path))
    start = ck.resume(lambda path: model.load_state_dict(torch.load(path)))
    for step in range(start, steps):
        ...
        ck.step(step, loss=loss.item())

Written to the project's folder by the Koios page; nothing to install. The page reads the line each save prints.
"""
from __future__ import annotations

import atexit
import json
import os
import signal
import subprocess
import sys
import time

__all__ = ["checkpoint", "Checkpoint", "resume_path", "stopping", "rank", "world"]

_MARK = "[koios] checkpoint "
_stop_asked = {"signal": None, "at": None}
_instances = []


def rank() -> int:
    """This machine's place in the pool, from 0 (KOIOS_RANK), 0 alone."""
    try:
        return int(os.environ.get("KOIOS_RANK", "0"))
    except ValueError:
        return 0


def world() -> int:
    """How many machines the command was started on (KOIOS_WORLD), 1 alone."""
    try:
        return max(1, int(os.environ.get("KOIOS_WORLD", "1")))
    except ValueError:
        return 1


def resume_path() -> str | None:
    """The checkpoint to pick up (KOIOS_RESUME), when the page started this run to continue one; else None."""
    path = os.environ.get("KOIOS_RESUME", "").strip()
    return path or None


def stopping() -> bool:
    """Whether the process has been asked to stop (the Companion shutting down, a Stop): save and leave."""
    return _stop_asked["signal"] is not None


def _on_signal(signum, frame):
    if _stop_asked["signal"] is None:
        _stop_asked["signal"] = signum
        _stop_asked["at"] = time.time()
        print(f"[koios] stop asked (signal {signum}): saving a checkpoint at the next step", flush=True)
    # A second ask, or no checkpoint set up at all: stop now, the usual way.
    if _stop_asked["at"] is not None and time.time() - _stop_asked["at"] > 0.5 or not _instances:
        if signum == signal.SIGINT:
            raise KeyboardInterrupt
        sys.exit(143 if signum == getattr(signal, "SIGTERM", 15) else 130)


def _install_signals():
    for name in ("SIGTERM", "SIGINT", "SIGHUP"):
        num = getattr(signal, name, None)
        if num is None:
            continue
        try:
            signal.signal(num, _on_signal)
        except (ValueError, OSError):
            pass  # not the main thread, or not this platform


def _gpu():
    """The GPUs' use at this moment, from nvidia-smi, for the record; None without one."""
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=3).stdout
        rows = [[int(float(c.strip())) for c in line.split(",")] for line in out.strip().splitlines() if line.strip()]
        if not rows:
            return None
        return {"util": max(r[0] for r in rows), "memUsedMb": sum(r[1] for r in rows), "memTotalMb": sum(r[2] for r in rows), "count": len(rows)}
    except Exception:
        return None


class Checkpoint:
    """Saves through on_save's function on a cadence, and at once when the process is asked to stop."""

    def __init__(self, directory: str = "checkpoints", every_steps: int | None = None, every_minutes: float | None = 10, keep: int = 3, name: str = "step-{step:08d}.pt"):
        self.directory = directory
        self.every_steps = every_steps
        self.every_minutes = every_minutes
        self.keep = max(1, int(keep))
        self.name = name
        self._save = None
        self._last_step = None
        self._last_at = time.time()
        self._saved = []
        self._metrics = {}
        os.makedirs(directory, exist_ok=True)
        _instances.append(self)
        _install_signals()

    def on_save(self, fn):
        """The function that writes the checkpoint: given the path to write to."""
        self._save = fn
        return fn

    def resume(self, load=None) -> int:
        """The step to start from: the checkpoint KOIOS_RESUME names, or the newest in the directory; 0 when there is none.
        'load', given the path, restores the state."""
        asked = resume_path()
        path = asked or self.latest()
        if asked and not os.path.exists(asked):
            print(f"[koios] resume asked from {asked}, which is not on this machine: starting from the beginning", flush=True)
            return 0
        if not path or not os.path.exists(path):
            return 0
        meta = self._sidecar_of(path)
        if load is not None:
            load(path)
        step = int(meta.get("step", 0)) if meta else 0
        print(f"[koios] resumed {json.dumps({'path': path, 'step': step})}", flush=True)
        return step

    def latest(self) -> str | None:
        """The newest checkpoint in the directory, by its sidecar's record; None when there is none."""
        pointer = os.path.join(self.directory, "latest.json")
        try:
            with open(pointer) as f:
                path = json.load(f).get("path")
                if path and os.path.exists(path):
                    return path
        except (OSError, ValueError):
            pass
        return None

    def step(self, step: int, **metrics) -> bool:
        """Called once a step with what to record (loss=…, acc=…); saves when due, and leaves after a stop's save. True when it saved."""
        self._metrics.update({k: v for k, v in metrics.items() if isinstance(v, (int, float))})
        self._last_step = step
        due = stopping()
        if not due and self.every_steps and step > 0 and step % self.every_steps == 0:
            due = True
        if not due and self.every_minutes and time.time() - self._last_at >= self.every_minutes * 60:
            due = True
        if not due:
            return False
        reason = "stop" if stopping() else "cadence"
        self.save(step, reason)
        if reason == "stop":
            print("[koios] saved for the stop; leaving.", flush=True)
            sys.stdout.flush()
            sys.exit(0)
        return True

    def save(self, step: int | None = None, reason: str = "asked") -> str | None:
        """Saves now, whatever the cadence, and says so to the page. The path written, or None when nothing is set up to save."""
        if self._save is None:
            return None
        step = self._last_step if step is None else step
        path = os.path.join(self.directory, self.name.format(step=step or 0))
        self._save(path)
        record = {"path": os.path.abspath(path), "step": step, "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "reason": reason, "metrics": dict(self._metrics), "rank": rank(), "world": world(), "machine": os.environ.get("KOIOS_MACHINE", ""), "gpu": _gpu()}
        with open(path + ".koios.json", "w") as f:
            json.dump(record, f)
        with open(os.path.join(self.directory, "latest.json"), "w") as f:
            json.dump({"path": os.path.abspath(path), "step": step, "at": record["at"]}, f)
        self._saved.append(path)
        while len(self._saved) > self.keep:
            old = self._saved.pop(0)
            for p in (old, old + ".koios.json"):
                try:
                    os.remove(p)
                except OSError:
                    pass
        self._last_at = time.time()
        print(_MARK + json.dumps(record), flush=True)
        # In the project's data place too (Google Drive by default), so the runtime going away loses no checkpoint.
        try:
            import koios_data
            if koios_data.enabled():
                for p in (path, path + ".koios.json", os.path.join(self.directory, "latest.json")):
                    koios_data.save(p, os.path.join(self.directory, os.path.basename(p)).replace(os.sep, "/"))
        except Exception as error:
            print(f"[koios] checkpoint not copied to the data place: {error}", file=sys.stderr, flush=True)
        return path

    @staticmethod
    def _sidecar_of(path: str) -> dict:
        try:
            with open(path + ".koios.json") as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}


def checkpoint(directory: str = "checkpoints", every_steps: int | None = None, every_minutes: float | None = 10, keep: int = 3, name: str = "step-{step:08d}.pt") -> Checkpoint:
    """A Checkpoint: see the module's docstring."""
    return Checkpoint(directory, every_steps=every_steps, every_minutes=every_minutes, keep=keep, name=name)


def _at_exit():
    # Asked to stop between steps, with something to save: save on the way out.
    for ck in _instances:
        if stopping() and ck._save is not None and ck._last_step is not None and (not ck._saved or ck._saved[-1] != os.path.join(ck.directory, ck.name.format(step=ck._last_step))):
            try:
                ck.save(ck._last_step, "stop")
            except Exception:
                pass


atexit.register(_at_exit)
`;
