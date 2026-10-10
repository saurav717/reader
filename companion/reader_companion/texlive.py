"""The Companion's own TeX Live (from 0.12.0): installed into its folder, no password, used before any other.

A TeX that came with the computer, or a small one (BasicTeX), is often missing packages a paper from Overleaf
uses, and installing into it needs an administrator (`sudo tlmgr`), from a frozen year's archive when it is old.
So the Write tab can ask the Companion for a TeX Live of its own, from TeX Live's own installer (install-tl,
the same TeX Live MacTeX and Overleaf have), under `~/.reader-companion/texlive`. It belongs to you, so a
package it lacks installs with one click, and nothing outside the Companion's folder changes: your PATH and
any other TeX stay as they were. Deleting the folder takes it away.

The install runs in the background (20 to 60 minutes for the full scheme); `status()` says how far it has got,
read from install-tl's "Installing [n/N, time/total: …]: package" lines.
"""

from __future__ import annotations

import os
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile
import threading
import time
import urllib.request
import zipfile
from pathlib import Path

from . import state

MIRROR = "https://mirror.ctan.org/systems/texlive/tlnet"
# The schemes offered: everything (as Overleaf), or a medium set, with more installed when a paper asks for it.
SCHEMES = {"full": "scheme-full", "medium": "scheme-medium"}
# Space wanted before starting, in bytes: the scheme without its documentation and sources, and room to spare.
NEEDS = {"full": 7 * 1024**3, "medium": 2 * 1024**3}
PROGRESS = re.compile(r"^Installing \[(\d+)/(\d+),")


class Refused(ValueError):
    """Something the page asked for that can't be done, said in a way it can show."""


def home() -> Path:
    return state.config_dir() / "texlive"


def texdir() -> Path:
    return home() / "live"


def bin_dir() -> Path | None:
    """The folder of its programs (bin/<platform>), once installed."""
    found = sorted(texdir().glob("bin/*/latexmk*"))
    return found[0].parent if found else None


def tools() -> dict[str, str]:
    """Its programs that compiling uses, by name: empty until it is installed."""
    where = bin_dir()
    if not where:
        return {}
    names = ["latexmk", "pdflatex", "xelatex", "lualatex", "bibtex", "biber", "tlmgr"]
    found = {}
    for name in names:
        for candidate in (where / name, where / f"{name}.exe", where / f"{name}.bat"):
            if candidate.is_file():
                found[name] = str(candidate)
                break
    return found


def profile(scheme: str) -> str:
    """install-tl's answers, so it asks nothing: where it goes, which scheme, no documentation, the PATH left alone."""
    root = texdir()
    lines = {
        "selected_scheme": SCHEMES[scheme],
        "TEXDIR": root,
        "TEXMFLOCAL": root / "texmf-local",
        "TEXMFSYSCONFIG": root / "texmf-config",
        "TEXMFSYSVAR": root / "texmf-var",
        "TEXMFCONFIG": home() / "user" / "texmf-config",
        "TEXMFVAR": home() / "user" / "texmf-var",
        "TEXMFHOME": home() / "user" / "texmf",
        "instopt_adjustpath": 0,
        "instopt_adjustrepo": 1,
        "instopt_letter": 0,
        "instopt_portable": 0,
        "instopt_write18_restricted": 1,
        "tlpdbopt_autobackup": 0,
        "tlpdbopt_install_docfiles": 0,
        "tlpdbopt_install_srcfiles": 0,
        "tlpdbopt_desktop_integration": 0,
        "tlpdbopt_file_assocs": 0,
        "tlpdbopt_w32_multi_user": 0,
    }
    return "".join(f"{key} {value}\n" for key, value in lines.items())


def progress_of(line: str) -> tuple[int, int] | None:
    """(done, of) from install-tl's "Installing [0123/4567, time/total: 01:02/12:34]: amsmath [12k]" line."""
    match = PROGRESS.match(line.strip())
    return (int(match.group(1)), int(match.group(2))) if match else None


def packages_from_search(output: str) -> list[str]:
    """The packages `tlmgr search --global --file` names: each is a line ending in a colon."""
    names = []
    for line in output.splitlines():
        line = line.rstrip()
        if line.endswith(":") and not line.startswith((" ", "\t")) and " " not in line:
            names.append(line[:-1])
    return names


# ------------------------------------------------------------- the install --

_lock = threading.Lock()
_status: dict = {"state": "idle"}
_process: subprocess.Popen | None = None


def status() -> dict:
    """Whether it is installed, and how an install is going: state, step, done/of, the last lines, the error."""
    with _lock:
        now = dict(_status)
    found = tools()
    now["installed"] = bool(found.get("latexmk"))
    now["path"] = str(texdir())
    if found.get("latexmk") and now.get("state") in ("idle", None):
        now["state"] = "done"
    return now


def _set(**changes) -> None:
    with _lock:
        _status.update(changes)


def _installer(scratch: Path, fetch) -> list[str]:
    """Downloads install-tl and unpacks it; the command that runs it."""
    windows = os.name == "nt"
    name = "install-tl.zip" if windows else "install-tl-unx.tar.gz"
    archive = scratch / name
    with fetch(f"{MIRROR}/{name}", timeout=120) as response:
        archive.write_bytes(response.read())
    if windows:
        with zipfile.ZipFile(archive) as bundle:
            bundle.extractall(scratch)
    else:
        with tarfile.open(archive) as bundle:
            bundle.extractall(scratch, filter="data") if hasattr(tarfile, "data_filter") else bundle.extractall(scratch)
    script = next(scratch.glob("install-tl-*/install-tl-windows.bat" if windows else "install-tl-*/install-tl"), None)
    if not script:
        raise Refused("TeX Live's installer didn't unpack as expected.")
    if windows:
        return [str(script), "-no-gui"]
    perl = shutil.which("perl")
    if not perl:
        raise Refused("TeX Live's installer needs Perl, which isn't on this computer.")
    return [perl, str(script)]


def _run(scheme: str, fetch) -> None:
    global _process
    try:
        with tempfile.TemporaryDirectory() as scratch_name:
            scratch = Path(scratch_name)
            _set(step="Downloading TeX Live’s installer…")
            command = _installer(scratch, fetch)
            answers = scratch / "reader.profile"
            answers.write_text(profile(scheme))
            texdir().mkdir(parents=True, exist_ok=True)
            _set(step="Installing TeX Live…")
            tail: list[str] = []
            with subprocess.Popen(
                [*command, "-profile", str(answers), "-repository", MIRROR],
                cwd=str(scratch),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                text=True,
                errors="replace",
            ) as process:
                _process = process
                for line in process.stdout or []:
                    line = line.rstrip()
                    if not line:
                        continue
                    tail = (tail + [line])[-20:]
                    counted = progress_of(line)
                    if counted:
                        _set(done=counted[0], of=counted[1], step=f"Installing packages ({counted[0]} of {counted[1]})…", tail=tail)
                    else:
                        _set(tail=tail)
                code = process.wait()
            _process = None
            if code != 0 or not tools().get("latexmk"):
                if _status.get("state") == "cancelled":
                    return
                _set(state="failed", error=f"TeX Live’s installer stopped (exit {code}). The last lines it wrote are below.")
                return
            _set(state="done", step="Installed.", finishedAt=int(time.time() * 1000))
    except Exception as error:  # noqa: BLE001 - said to the page, which shows it
        _process = None
        _set(state="failed", error=str(error))


def install(scheme: str = "full", fetch=urllib.request.urlopen, start=True) -> dict:
    """Starts installing TeX Live into the Companion's folder, in the background; its status."""
    if scheme not in SCHEMES:
        raise Refused("The scheme is full or medium.")
    with _lock:
        if _status.get("state") == "installing":
            return dict(_status)
    if tools().get("latexmk"):
        return status()
    home().mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(home()).free
    if free < NEEDS[scheme]:
        raise Refused(f"TeX Live ({scheme}) needs about {NEEDS[scheme] // 1024**3} GB free, and this disk has {free / 1024**3:.1f} GB.")
    with _lock:
        _status.clear()
        _status.update(state="installing", scheme=scheme, step="Starting…", startedAt=int(time.time() * 1000), done=0, of=0, tail=[])
    if start:
        threading.Thread(target=_run, args=(scheme, fetch), daemon=True, name="texlive-install").start()
    return status()


def cancel() -> dict:
    """Stops an install under way; what was installed so far is taken away, so the next one starts clean."""
    process = _process
    _set(state="cancelled", step="Cancelled.")
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            process.kill()
    shutil.rmtree(texdir(), ignore_errors=True)
    return status()


def remove() -> dict:
    """Takes the Companion's TeX Live away, all of it."""
    if _status.get("state") == "installing":
        raise Refused("It is being installed: cancel first.")
    shutil.rmtree(home(), ignore_errors=True)
    _set(state="idle", step="", error="")
    return status()


# ------------------------------------------------------------- a package --


def install_packages(names: list[str], run=subprocess.run) -> dict:
    """Installs packages into the Companion's TeX Live with its tlmgr, a .sty's name looked up when it isn't a package's."""
    tlmgr = tools().get("tlmgr")
    if not tlmgr:
        raise Refused("Install the Companion’s TeX Live first: packages go into it without a password.")
    clean = [name for name in names if re.fullmatch(r"[\w.+-]{1,80}", name or "")]
    if not clean:
        raise Refused("No package named.")
    installed, failed, said = [], [], []
    for name in clean:
        done = run([tlmgr, "install", name], capture_output=True, text=True, timeout=600, stdin=subprocess.DEVNULL)
        said.append((done.stdout or "") + (done.stderr or ""))
        if done.returncode == 0:
            installed.append(name)
            continue
        found = run([tlmgr, "search", "--global", "--file", f"/{name}.sty"], capture_output=True, text=True, timeout=120, stdin=subprocess.DEVNULL)
        packages = packages_from_search(found.stdout or "")
        if packages:
            done = run([tlmgr, "install", *packages[:3]], capture_output=True, text=True, timeout=600, stdin=subprocess.DEVNULL)
            said.append((done.stdout or "") + (done.stderr or ""))
            if done.returncode == 0:
                installed.extend(packages[:3])
                continue
        failed.append(name)
    return {"installed": installed, "failed": failed, "log": "\n".join(said)[-4000:]}
