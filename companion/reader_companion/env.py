"""The Python your code runs in: one environment that lasts, for the console and the notebooks alike.

The Companion itself runs wherever uv put it, which may be cleared or replaced
on an upgrade. Your code gets its own: ~/Reader/.venv by default (made once,
with uv when there is one), or an interpreter you name with --python — a conda
env with torch already in it, say. Its bin/ goes first on the PATH the kernels
inherit, so `python` and `pip install …` in the console mean that environment,
and a kernelspec named python3 points the notebooks at it too.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def find_uv() -> str | None:
    for candidate in (shutil.which("uv"), os.environ.get("UV"), Path.home() / ".local/bin/uv", Path.home() / ".cargo/bin/uv"):
        if candidate and Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def python_in(venv: Path) -> Path:
    return venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def has_ipykernel(python: Path) -> bool:
    try:
        return subprocess.run([str(python), "-c", "import ipykernel"], capture_output=True, timeout=60).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def prepare(root: Path, python: str | None, say=print) -> Path:
    """The interpreter for kernels and the console, made or checked, with ipykernel in it."""
    uv = find_uv()
    if python:
        interpreter = Path(os.path.expanduser(python))
        found = shutil.which(str(interpreter))
        if found:
            interpreter = Path(found)
        if not interpreter.exists():
            raise SystemExit(f"reader-companion: no Python at {python}")
    else:
        venv = root / ".venv"
        interpreter = python_in(venv)
        if not interpreter.exists():
            say(f"  Making the environment your code runs in, once: {venv}")
            if uv:
                subprocess.run([uv, "venv", "--seed", "--quiet", "--python", sys.executable, str(venv)], check=True)
            else:
                subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
    if not has_ipykernel(interpreter):
        say(f"  Adding ipykernel to {interpreter}")
        if uv:
            subprocess.run([uv, "pip", "install", "--quiet", "--python", str(interpreter), "ipykernel"], check=True)
        else:
            subprocess.run([str(interpreter), "-m", "pip", "install", "--quiet", "ipykernel"], check=True)
    return interpreter


def use(root: Path, interpreter: Path) -> None:
    """Points this process's kernels at `interpreter`: its kernelspec first on JUPYTER_PATH, its bin/ first on PATH."""
    data = root / ".reader" / "jupyter"
    spec = data / "kernels" / "python3"
    spec.mkdir(parents=True, exist_ok=True)
    (spec / "kernel.json").write_text(json.dumps({
        "argv": [str(interpreter), "-m", "ipykernel_launcher", "-f", "{connection_file}"],
        "display_name": f"Python ({interpreter})",
        "language": "python",
        "metadata": {"debugger": True},
    }, indent=1))
    os.environ["JUPYTER_PATH"] = os.pathsep.join(filter(None, [str(data), os.environ.get("JUPYTER_PATH")]))
    bin_dir = interpreter.parent
    os.environ["PATH"] = os.pathsep.join([str(bin_dir), os.environ.get("PATH", "")])
    venv = bin_dir.parent
    if (venv / "pyvenv.cfg").exists():
        os.environ["VIRTUAL_ENV"] = str(venv)
    else:
        os.environ.pop("VIRTUAL_ENV", None)


def shell_command(root: Path, interpreter: Path) -> list[str] | None:
    """The terminal's shell: yours ($SHELL — zsh with oh-my-zsh, bash, fish), with your own rc files first and this environment on top.

    zsh and bash read a small rc of ours that sources yours (~/.zshrc,
    ~/.bashrc) and then puts the environment's bin/ first, the way VS Code
    activates one in its terminal; your prompt, theme and plugins stay as they
    are. Any other shell is started as it is. None leaves the default.
    """
    if os.name == "nt":
        return None
    shell = os.environ.get("SHELL") or shutil.which("zsh") or shutil.which("bash") or "/bin/sh"
    name = Path(shell).name
    bin_dir = interpreter.parent
    venv = bin_dir.parent
    activate = venv / "bin" / "activate"
    on_top = (
        f'[ -f "{activate}" ] && . "{activate}" || export PATH="{bin_dir}:$PATH"\n'
        if (venv / "pyvenv.cfg").exists()
        else f'export PATH="{bin_dir}:$PATH"\n'
    )
    folder = root / ".reader" / "shell"
    folder.mkdir(parents=True, exist_ok=True)
    if name == "zsh":
        zdot = folder / "zsh"
        zdot.mkdir(exist_ok=True)
        # zsh reads $ZDOTDIR/.zshenv and .zshrc: ours, which hand over to yours.
        (zdot / ".zshenv").write_text('[ -f "$HOME/.zshenv" ] && . "$HOME/.zshenv"\n')
        (zdot / ".zshrc").write_text(
            'ZDOTDIR="$HOME"\n'
            '[ -f "$HOME/.zshrc" ] && . "$HOME/.zshrc"\n'
            + on_top
        )
        return ["env", f"ZDOTDIR={zdot}", shell, "-i"]
    if name == "bash":
        rc = folder / "bashrc"
        rc.write_text('[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"\n' + on_top)
        return [shell, "--rcfile", str(rc), "-i"]
    return [shell]
