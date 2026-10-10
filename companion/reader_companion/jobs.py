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
