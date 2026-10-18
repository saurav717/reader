"""What each of the page's terminals is running: for the Playground's dock and Running-now shelf.

A terminal is a shell in a pseudo-terminal (terminado, under Jupyter's
terminals API). A shell with job control puts the command it runs in its own
process group and makes that group the terminal's foreground one; at its
prompt, the foreground group is the shell's own. So the terminal's
foreground group (tcgetpgrp on the pty) says whether a command is running and
which: no guessing from what the screen shows.
"""

from __future__ import annotations

import os
import subprocess
import time


def command_of(pid: int) -> str:
    """A process's command line, a short one: /proc where there is one (Linux), ps elsewhere (macOS)."""
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as handle:
            text = handle.read().replace(b"\0", b" ").decode(errors="replace").strip()
            if text:
                return text[:200]
    except OSError:
        pass
    try:
        done = subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True, timeout=2)
        return done.stdout.strip()[:200]
    except Exception:
        return ""


def foreground(fd: int, shell_pid: int) -> dict:
    """The terminal on `fd`: whether a command other than the shell has it, and which."""
    try:
        group = os.tcgetpgrp(fd)
    except OSError:
        return {"alive": False, "busy": False}
    if group <= 0 or group == shell_pid:
        return {"alive": True, "busy": False}
    return {"alive": True, "busy": True, "pid": group, "command": command_of(group)}


def terminal_jobs(manager) -> dict:
    """Each terminal the server has, by name, as foreground() says. Nothing when there is no terminal manager."""
    out = {}
    for name, term in list((getattr(manager, "terminals", None) or {}).items()):
        proc = getattr(term, "ptyproc", None)
        if proc is None:
            continue
        out[name] = foreground(proc.fd, proc.pid)
    return out


# ------------------------------------------------- stopping jobs gently ----
#
# The Companion shutting down takes its kernels, and every job running in
# them, with it. A job that uses the koios helper (the page writes it to the
# project's folder) saves a checkpoint when it is asked to stop — SIGTERM —
# and leaves; so before the server stops, each job is asked, and given a
# moment. A job that does not listen is simply gone with the kernel, as it
# would have been.

GRACE_S = 60.0


def children_of(pid: int) -> list:
    """The direct children of a process: /proc on Linux, pgrep elsewhere (macOS)."""
    out = []
    try:
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            try:
                with open(f"/proc/{entry}/stat") as handle:
                    fields = handle.read().rsplit(")", 1)[1].split()
                if int(fields[1]) == pid:
                    out.append(int(entry))
            except (OSError, ValueError, IndexError):
                continue
        return out
    except OSError:
        pass
    try:
        done = subprocess.run(["pgrep", "-P", str(pid)], capture_output=True, text=True, timeout=2)
        return [int(line) for line in done.stdout.split() if line.isdigit()]
    except Exception:
        return []


def descendants(pid: int, limit: int = 200) -> list:
    """Every process under one, breadth first: a kernel's shells and the commands they run."""
    seen, queue, out = {pid}, [pid], []
    while queue and len(out) < limit:
        for child in children_of(queue.pop(0)):
            if child in seen:
                continue
            seen.add(child)
            out.append(child)
            queue.append(child)
    return out


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def kernel_pids(kernel_manager) -> list:
    """The process id of each kernel the server runs, where jupyter_client says it."""
    out = []
    for kernel_id in list(getattr(kernel_manager, "list_kernel_ids", lambda: [])()):
        try:
            km = kernel_manager.get_kernel(kernel_id)
        except Exception:
            continue
        provisioner = getattr(km, "provisioner", None)
        pid = getattr(provisioner, "pid", None) or getattr(getattr(provisioner, "process", None), "pid", None) or getattr(getattr(km, "kernel", None), "pid", None)
        if isinstance(pid, int):
            out.append(pid)
    return out


def job_pids(kernel_manager) -> list:
    """The jobs running under the kernels: Python processes below each kernel, the kernel itself left alone."""
    out = []
    for kpid in kernel_pids(kernel_manager):
        for pid in descendants(kpid):
            if "python" in command_of(pid).lower():
                out.append(pid)
    return out


def ask_to_stop(pids: list, signum=None) -> None:
    """SIGTERM to each: the koios helper's cue to save and leave."""
    import signal as _signal

    for pid in pids:
        try:
            os.kill(pid, _signal.SIGTERM if signum is None else signum)
        except OSError:
            pass


def wait_gone(pids: list, seconds: float = GRACE_S, step: float = 0.25) -> list:
    """Waits for the processes to end, up to `seconds`; the ones still alive after that."""
    end = time.time() + seconds
    left = [pid for pid in pids if alive(pid)]
    while left and time.time() < end:
        time.sleep(step)
        left = [pid for pid in left if alive(pid)]
    return left
