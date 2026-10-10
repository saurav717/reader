"""A project's paper on this computer: compiled to a PDF, and kept in step with Overleaf (from 0.10.0).

The page's Write tab edits the paper's files in a folder under the Companion's
own (through Jupyter, as the Playground does), and asks here for two things:

- The PDF. `latexmk` when TeX is installed (TeX Live, MacTeX, MiKTeX), else
  Tectonic: one small program that fetches the packages a paper uses, which
  the Companion downloads into its own folder when asked. The log is read
  into errors and warnings, each with its file and line.
- The sync. Overleaf's Git (a paid Overleaf feature, with a token from its
  Account settings) or a GitHub repository: the folder is a clone, and a sync
  commits what changed here, takes in what changed there, and pushes. The
  token is given to git by GIT_ASKPASS at each call, never written into the
  repository's config or its remote's address. A folder that Dropbox keeps in
  step with Overleaf needs neither: it is only compiled.

Paths come from the page relative to the Companion's folder, and are refused
if they would leave it.
"""

from __future__ import annotations

import base64
import os
import platform
import re
import stat
import subprocess
import tarfile
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path

from . import state

TECTONIC_VERSION = "0.15.0"
COMPILE_TIMEOUT_S = 180
GIT_TIMEOUT_S = 120
MAX_PDF_BYTES = 40_000_000


class Refused(ValueError):
    """What was asked for can't be done here: a path outside the folder, a file that isn't LaTeX, a missing tool."""


# ------------------------------------------------------------------ paths --


def inside(root: Path, relative: str) -> Path:
    """`relative` under root, refused when absolute or climbing out with `..` (a folder linked in is followed, as Jupyter does)."""
    text = (relative or "").replace("\\", "/").strip("/")
    parts = [part for part in text.split("/") if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts) or re.match(r"^[A-Za-z]:", text):
        raise Refused("That folder isn't inside the Companion's folder.")
    return root.joinpath(*parts)


def main_file(folder: Path, main: str | None) -> str:
    """The file to compile: the one asked for if it is a .tex here, else the one with \\documentclass, else main.tex."""
    if main:
        candidate = inside(folder, main)
        if candidate.suffix.lower() != ".tex" or not candidate.is_file():
            raise Refused(f"{main} isn't a .tex file in the paper's folder.")
        return candidate.relative_to(folder).as_posix()
    texs = sorted(folder.rglob("*.tex"), key=lambda path: (len(path.parts), path.as_posix()))
    for path in texs:
        try:
            if re.search(r"^\s*\\documentclass", path.read_text(encoding="utf-8", errors="replace"), re.M):
                return path.relative_to(folder).as_posix()
        except OSError:
            continue
    if (folder / "main.tex").is_file():
        return "main.tex"
    raise Refused("No .tex file with \\documentclass in the paper's folder.")


# ---------------------------------------------------------------- engines --


def tectonic_path() -> Path:
    return state.config_dir() / "bin" / ("tectonic.exe" if os.name == "nt" else "tectonic")


def engines(found: dict[str, str]) -> dict:
    """Which ways to compile there are: latexmk (with the TeX it drives), Tectonic, and git for the sync."""
    tectonic = found.get("tectonic") or (str(tectonic_path()) if tectonic_path().is_file() else "")
    return {
        "latexmk": found.get("latexmk", ""),
        "tectonic": tectonic,
        "git": found.get("git", ""),
        "tectonicInstallable": bool(tectonic_asset()),
    }


def tectonic_asset(system: str | None = None, machine: str | None = None) -> str | None:
    """Tectonic's release file for this computer, from its GitHub releases; None where there is none."""
    system = system or platform.system()
    machine = (machine or platform.machine()).lower()
    arch = "aarch64" if machine in ("arm64", "aarch64") else "x86_64" if machine in ("x86_64", "amd64") else None
    if not arch:
        return None
    if system == "Darwin":
        target, ext = f"{arch}-apple-darwin", "tar.gz"
    elif system == "Windows":
        if arch != "x86_64":
            return None
        target, ext = "x86_64-pc-windows-msvc", "zip"
    elif system == "Linux":
        target, ext = f"{arch}-unknown-linux-musl", "tar.gz"
    else:
        return None
    name = f"tectonic-{TECTONIC_VERSION}-{target}.{ext}"
    return f"https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40{TECTONIC_VERSION}/{name}"


def install_tectonic(fetch=urllib.request.urlopen) -> str:
    """Downloads Tectonic into the Companion's folder; its path."""
    url = tectonic_asset()
    if not url:
        raise Refused("There is no Tectonic build for this computer: install TeX Live or MacTeX instead.")
    target = tectonic_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as scratch:
        archive = Path(scratch) / url.rsplit("/", 1)[-1]
        with fetch(url, timeout=120) as response:
            archive.write_bytes(response.read())
        name = target.name
        if archive.suffix == ".zip":
            with zipfile.ZipFile(archive) as bundle:
                member = next(item for item in bundle.namelist() if item.rsplit("/", 1)[-1] == name)
                target.write_bytes(bundle.read(member))
        else:
            with tarfile.open(archive) as bundle:
                member = next(item for item in bundle.getmembers() if item.name.rsplit("/", 1)[-1] == name and item.isfile())
                extracted = bundle.extractfile(member)
                target.write_bytes(extracted.read() if extracted else b"")
    target.chmod(target.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return str(target)


def compile_command(engine: str, main: str, available: dict) -> list[str]:
    """The command that makes the PDF, run in the paper's folder."""
    if engine == "auto":
        engine = "latexmk" if available.get("latexmk") else "tectonic" if available.get("tectonic") else ""
    if engine == "latexmk" and available.get("latexmk"):
        # -pdf runs pdflatex; a paper that sets $pdf_mode in its own latexmkrc keeps it.
        return [available["latexmk"], "-pdf", "-interaction=nonstopmode", "-file-line-error", "-synctex=1", main]
    if engine == "tectonic" and available.get("tectonic"):
        return [available["tectonic"], "-X", "compile", "--synctex", "--keep-logs", main]
    raise Refused("No TeX here to compile with: install TeX Live or MacTeX, or let the Companion fetch Tectonic.")


LINE_ERROR = re.compile(r"^(?P<file>[^\s:][^:]*\.(?:tex|sty|cls|bib|bbl)):(?P<line>\d+): (?P<message>.+)$")
WARNING = re.compile(r"^(?:LaTeX|Package [\w-]+|Class [\w-]+) Warning: (?P<message>.+?)(?: on input line (?P<line>\d+))?\.?$")
TECTONIC_DIAG = re.compile(r"^(?P<kind>error|warning): (?:(?P<file>[^:\s]+\.tex):(?P<line>\d+): )?(?P<message>.+)$")


def read_log(log: str, folder: Path | None = None) -> dict:
    """Errors and warnings out of a TeX log (and Tectonic's own lines), each with its file and line when the log says."""
    errors: list[dict] = []
    warnings: list[dict] = []
    lines = log.splitlines()
    for index, line in enumerate(lines):
        match = LINE_ERROR.match(line)
        if match:
            file = match["file"]
            if folder is not None and file.startswith("./"):
                file = file[2:]
            errors.append({"file": file, "line": int(match["line"]), "message": match["message"].strip()})
            continue
        if line.startswith("! "):
            # Without -file-line-error: "! Undefined control sequence." then "l.12 ..." a few lines on.
            at = next((int(m.group(1)) for later in lines[index + 1 : index + 8] if (m := re.match(r"^l\.(\d+)", later))), None)
            errors.append({"file": "", "line": at, "message": line[2:].strip()})
            continue
        match = TECTONIC_DIAG.match(line)
        if match:
            item = {"file": match["file"] or "", "line": int(match["line"]) if match["line"] else None, "message": match["message"].strip()}
            (errors if match["kind"] == "error" else warnings).append(item)
            continue
        match = WARNING.match(line)
        if match:
            warnings.append({"file": "", "line": int(match["line"]) if match["line"] else None, "message": match["message"].strip()})
    def unique(items: list[dict]) -> list[dict]:
        seen, kept = set(), []
        for item in items:
            key = (item["file"], item["line"], item["message"])
            if key not in seen:
                seen.add(key)
                kept.append(item)
        return kept

    return {"errors": unique(errors), "warnings": unique(warnings)[:200]}


def compile_paper(root: Path, folder_rel: str, main: str | None, engine: str, available: dict, run=subprocess.run) -> dict:
    """Compiles the paper; the PDF (base64) when there is one, the log read, and how long it took."""
    folder = inside(root, folder_rel)
    if not folder.is_dir():
        raise Refused(f"{folder_rel} isn't a folder.")
    main = main_file(folder, main)
    argv = compile_command(engine, main, available)
    started = time.time()
    try:
        done = run(argv, cwd=str(folder), capture_output=True, text=True, timeout=COMPILE_TIMEOUT_S, stdin=subprocess.DEVNULL, errors="replace")
        output = (done.stdout or "") + (done.stderr or "")
        code = done.returncode
    except subprocess.TimeoutExpired:
        output, code = f"Compiling took longer than {COMPILE_TIMEOUT_S} s and was stopped.", -1
    stem = main[:-4]
    log_path = folder / f"{stem}.log"
    log = log_path.read_text(encoding="utf-8", errors="replace") if log_path.is_file() else ""
    read = read_log(log + "\n" + output, folder)
    pdf_path = folder / f"{stem}.pdf"
    pdf = ""
    if pdf_path.is_file() and pdf_path.stat().st_mtime >= started - 1 and pdf_path.stat().st_size <= MAX_PDF_BYTES:
        pdf = base64.b64encode(pdf_path.read_bytes()).decode("ascii")
    return {
        "ok": code == 0 and not read["errors"],
        "main": main,
        "engine": Path(argv[0]).stem,
        "pdf": pdf,
        "errors": read["errors"],
        "warnings": read["warnings"],
        "log": (log or output)[-60_000:],
        "ms": int((time.time() - started) * 1000),
    }


# -------------------------------------------------------------------- git --


def remote_ok(url: str) -> bool:
    """An https remote on Overleaf's Git, or GitHub: nothing else is cloned or pushed to from the page."""
    return bool(re.match(r"^https://(git\.overleaf\.com/[0-9a-f]{24}|github\.com/[\w.-]+/[\w.-]+?)(\.git)?/?$", url or ""))


def _askpass(token: str, scratch: Path) -> dict:
    """An environment in which git asks a little script for the password, and the script answers the token."""
    if os.name == "nt":
        script = scratch / "askpass.cmd"
        script.write_text('@echo off\r\necho %~1 | findstr /b /i "Username" >nul && (echo git) || (echo %READER_GIT_TOKEN%)\r\n')
    else:
        script = scratch / "askpass.sh"
        script.write_text('#!/bin/sh\ncase "$1" in Username*) echo git ;; *) printf "%s\\n" "$READER_GIT_TOKEN" ;; esac\n')
        script.chmod(0o700)
    env = dict(os.environ)
    env.update({"GIT_ASKPASS": str(script), "READER_GIT_TOKEN": token, "GIT_TERMINAL_PROMPT": "0"})
    return env


def git(args: list[str], cwd: Path | None, token: str, git_path: str = "git", run=subprocess.run) -> subprocess.CompletedProcess:
    with tempfile.TemporaryDirectory() as scratch:
        env = _askpass(token, Path(scratch)) if token else {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
        return run([git_path, "-c", "credential.helper=", *args], cwd=str(cwd) if cwd else None, env=env, capture_output=True, text=True, timeout=GIT_TIMEOUT_S, stdin=subprocess.DEVNULL)


def _said(done: subprocess.CompletedProcess, token: str) -> str:
    text = ((done.stderr or "") + (done.stdout or "")).strip()
    return text.replace(token, "•••") if token else text


def clone(root: Path, folder_rel: str, url: str, token: str, git_path: str = "git", run=subprocess.run) -> dict:
    if not remote_ok(url):
        raise Refused("Only an Overleaf Git address (https://git.overleaf.com/…) or a GitHub repository can be cloned here.")
    folder = inside(root, folder_rel)
    if folder.exists() and any(folder.iterdir()):
        raise Refused(f"{folder_rel} isn't empty.")
    folder.parent.mkdir(parents=True, exist_ok=True)
    done = git(["clone", url, str(folder)], None, token, git_path, run)
    if done.returncode != 0:
        raise Refused(f"git couldn't clone it: {_said(done, token)}")
    return {"folder": folder_rel}


def sync(root: Path, folder_rel: str, token: str, message: str, git_path: str = "git", run=subprocess.run) -> dict:
    """Commits what changed here, takes in what changed there, pushes. A conflict is left for the page to show, nothing thrown away."""
    folder = inside(root, folder_rel)
    if not (folder / ".git").exists():
        raise Refused(f"{folder_rel} isn't a Git clone: it can't be synced from here.")
    steps = []

    def step(args: list[str]) -> subprocess.CompletedProcess:
        done = git(args, folder, token, git_path, run)
        steps.append({"args": args[0], "code": done.returncode})
        return done

    step(["add", "-A"])
    staged = step(["diff", "--cached", "--quiet"])
    committed = False
    if staged.returncode == 1:
        done = step(["-c", "user.name=Reader", "-c", "user.email=reader@localhost", "commit", "-q", "-m", message or "Edits from Reader"])
        committed = done.returncode == 0
    before = step(["rev-parse", "HEAD"])
    pulled = step(["pull", "--no-rebase", "--no-edit", "-q"])
    if pulled.returncode != 0:
        conflicts = step(["diff", "--name-only", "--diff-filter=U"])
        files = [line for line in (conflicts.stdout or "").splitlines() if line.strip()]
        if files:
            return {"ok": False, "committed": committed, "pushed": False, "conflicts": files, "error": "Overleaf changed the same lines: the files are marked with <<<<<<< where they differ. Fix them, and the next sync carries on."}
        return {"ok": False, "committed": committed, "pushed": False, "conflicts": [], "error": f"git couldn't take in the changes: {_said(pulled, token)}"}
    old = (before.stdout or "").strip()
    changed = step(["diff", "--name-only", old, "HEAD"]) if old and before.returncode == 0 else None
    incoming = [line for line in ((changed.stdout if changed and changed.returncode == 0 else "") or "").splitlines() if line.strip()]
    ahead = step(["rev-list", "--count", "@{u}..HEAD"])
    pushed = False
    if ahead.returncode == 0 and (ahead.stdout or "0").strip() != "0":
        done = step(["push", "-q"])
        if done.returncode != 0:
            return {"ok": False, "committed": committed, "pushed": False, "conflicts": [], "incoming": incoming, "error": f"git couldn't push: {_said(done, token)}"}
        pushed = True
    return {"ok": True, "committed": committed, "pushed": pushed, "conflicts": [], "incoming": incoming, "at": int(time.time() * 1000)}


def remote_of(root: Path, folder_rel: str, git_path: str = "git", run=subprocess.run) -> str:
    folder = inside(root, folder_rel)
    if not (folder / ".git").exists():
        return ""
    done = git(["remote", "get-url", "origin"], folder, "", git_path, run)
    return (done.stdout or "").strip() if done.returncode == 0 else ""


# ------------------------------------------------------------- the token --
# Kept in the Companion's config, readable only by you (0600), by remote: the
# page sends it once, and syncs after name the folder only.


def save_token(url: str, token: str) -> None:
    config = state.load_config()
    tokens = config.get("git_tokens") if isinstance(config.get("git_tokens"), dict) else {}
    key = re.sub(r"\.git/?$", "", url.rstrip("/"))
    if token:
        tokens[key] = token
    else:
        tokens.pop(key, None)
    config["git_tokens"] = tokens
    state.save_config(config)


def token_for(url: str) -> str:
    tokens = state.load_config().get("git_tokens")
    if not isinstance(tokens, dict):
        return ""
    return str(tokens.get(re.sub(r"\.git/?$", "", (url or "").rstrip("/")), ""))


