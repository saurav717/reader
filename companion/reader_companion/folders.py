"""Folders anywhere on this computer, for the page's "Open a file or folder".

The page reads and writes only inside the Companion's folder (~/Reader). To
work on a folder that is somewhere else on this computer — a checkout in
~/code, a project on the Desktop — the page lists folders from the home folder
down (list), or has this computer's own folder chooser ask (choose), and then
links the folder it picked into ~/Reader/linked/ (link). Jupyter follows the
link, so the project's files are that folder's: edited in place, nothing
copied. The page can already run any command here through the terminal, so
this gives it nothing it couldn't do; it makes it a click.
"""

from __future__ import annotations

import os
import platform
import re
import shutil
import subprocess
from pathlib import Path

LINKED = "linked"
# Folders not worth showing in a list of places to open: caches and the system's own.
HIDDEN_DIRS = {"__pycache__", "node_modules", ".git", "Library", "AppData", "$Recycle.Bin", "System Volume Information"}


def home() -> Path:
    return Path.home().resolve()


def resolve(raw: str | None) -> Path:
    """A path as the page gives it — absolute, or starting with ~ — made absolute."""
    if not raw or not raw.strip():
        return home()
    return Path(os.path.expanduser(raw.strip())).resolve()


def listing(raw: str | None, show_hidden: bool = False) -> dict:
    """The folders and files in one folder, folders first: what the page's browser shows. Raises OSError when it can't be read."""
    where = resolve(raw)
    if not where.is_dir():
        raise NotADirectoryError(f"{where} isn't a folder")
    entries = []
    with os.scandir(where) as found:
        for entry in found:
            name = entry.name
            if not show_hidden and (name.startswith(".") or name in HIDDEN_DIRS):
                continue
            try:
                is_dir = entry.is_dir()
                size = None if is_dir else entry.stat().st_size
            except OSError:
                continue
            entries.append({"name": name, "dir": is_dir, "size": size})
    entries.sort(key=lambda e: (not e["dir"], e["name"].lower()))
    parent = str(where.parent) if where.parent != where else None
    return {"path": str(where), "parent": parent, "home": str(home()), "sep": os.sep, "entries": entries[:2000], "more": len(entries) > 2000, "places": places()}


def places() -> list[dict]:
    """The usual starting points that exist here: home, Desktop, Documents, Downloads, code folders."""
    out = []
    for name in ("", "Desktop", "Documents", "Downloads", "code", "Code", "projects", "Projects", "src", "dev", "Developer", "repos", "github"):
        path = home() / name if name else home()
        if path.is_dir():
            out.append({"name": name or "Home", "path": str(path)})
    return out


def slug(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-.") or "folder"


def link(raw: str, root: Path) -> str:
    """The folder at `raw` linked into root/linked/: the path relative to root the page then uses. A folder already under root is used as it is."""
    target = resolve(raw)
    if not target.is_dir():
        raise NotADirectoryError(f"{target} isn't a folder")
    root = root.resolve()
    if target == root or root in target.parents:
        return target.relative_to(root).as_posix()
    linked = root / LINKED
    linked.mkdir(parents=True, exist_ok=True)
    base = slug(target.name)
    for n in range(1, 100):
        name = base if n == 1 else f"{base}-{n}"
        place = linked / name
        if place.is_symlink() and place.resolve() == target:
            return f"{LINKED}/{name}"
        if place.exists() or place.is_symlink():
            continue
        try:
            place.symlink_to(target, target_is_directory=True)
        except OSError:
            if platform.system() != "Windows":
                raise
            # Windows without Developer Mode can't make a symbolic link; a junction needs no privilege.
            subprocess.run(["cmd", "/c", "mklink", "/J", str(place), str(target)], check=True, capture_output=True)
        return f"{LINKED}/{name}"
    raise FileExistsError(f"Too many folders named {base} are linked already")


def chooser_command(system: str | None = None, start: str | None = None) -> list[str] | None:
    """This computer's own "choose a folder" dialog, as a command that prints the path; None when there is none."""
    system = system or platform.system()
    start = start or str(home())
    if system == "Darwin":
        return ["osascript", "-e", 'POSIX path of (choose folder with prompt "Choose a folder for Reader")']
    if system == "Windows":
        script = (
            "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; "
            "$d.Description = 'Choose a folder for Reader'; $d.SelectedPath = '" + start.replace("'", "''") + "'; "
            "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }"
        )
        return ["powershell", "-NoProfile", "-STA", "-Command", script]
    if shutil.which("zenity"):
        return ["zenity", "--file-selection", "--directory", "--title=Choose a folder for Reader", f"--filename={start.rstrip('/')}/"]
    if shutil.which("kdialog"):
        return ["kdialog", "--getexistingdirectory", start, "--title", "Choose a folder for Reader"]
    return None


def choose(timeout: float = 300) -> str | None:
    """Asks on this computer's screen for a folder, and waits: its path, or None when cancelled. Raises LookupError with no dialog to ask with."""
    command = chooser_command()
    if not command:
        raise LookupError("This computer has no folder chooser to show (on Linux, zenity or kdialog).")
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None
    path = done.stdout.strip()
    return path.rstrip("/\\") or None if done.returncode == 0 else None
