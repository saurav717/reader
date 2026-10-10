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
import hashlib
import io
import os
import platform
import re
import shutil
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


def tex_version(found: dict[str, str], run=subprocess.run) -> str:
    """The TeX installed, as it says: "pdfTeX 3.141592653-2.6-1.40.26 (TeX Live 2024)"."""
    program = found.get("pdflatex") or found.get("xelatex")
    if not program:
        return ""
    try:
        done = run([program, "--version"], capture_output=True, text=True, timeout=15, stdin=subprocess.DEVNULL)
        return (done.stdout or "").splitlines()[0].strip() if done.returncode == 0 and done.stdout else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def engines(found: dict[str, str], run=subprocess.run) -> dict:
    """Which ways to compile there are: latexmk (with the TeX it drives), Tectonic, git for the sync, and the TeX's version."""
    tectonic = found.get("tectonic") or (str(tectonic_path()) if tectonic_path().is_file() else "")
    return {
        "latexmk": found.get("latexmk", ""),
        "tectonic": tectonic,
        "git": found.get("git", ""),
        "bibtex": found.get("bibtex", ""),
        "biber": found.get("biber", ""),
        "texVersion": tex_version(found, run) if found.get("latexmk") else "",
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


COMPILERS = {"pdflatex": "-pdf", "xelatex": "-xelatex", "lualatex": "-lualatex", "latex": "-pdfdvi"}
JOB = "output"


def build_dir(folder: Path) -> Path:
    """Where a paper's build goes: the Companion's own folder, never the paper's, so nothing compiling makes is synced to Overleaf."""
    key = hashlib.sha1(str(folder.resolve()).encode("utf-8")).hexdigest()[:16]
    return state.config_dir() / "build" / key


def compile_command(engine: str, main: str, available: dict, compiler: str = "pdflatex", outdir: str = JOB, halt: bool = False) -> list[str]:
    """
    The command that makes the PDF, run in the paper's folder. With latexmk it is Overleaf's own: -cd into the main
    file's folder, the job called output, the build in a folder of its own, SyncTeX, batch mode, and -f to keep going
    past errors (or -halt-on-error, Overleaf's "Stop on first error"), with the compiler the project is set to.
    """
    if engine == "auto":
        engine = "latexmk" if available.get("latexmk") else "tectonic" if available.get("tectonic") else ""
    if engine == "latexmk" and available.get("latexmk"):
        flag = COMPILERS.get(compiler, "-pdf")
        return [
            available["latexmk"], "-cd", f"-jobname={JOB}", f"-auxdir={outdir}", f"-outdir={outdir}", "-synctex=1",
            # -g: compile every time asked, as Overleaf does. Without it latexmk skips a file it failed on until the
            # file changes ("files unchanged since last error"), so a package installed since then changes nothing.
            "-interaction=batchmode", "-file-line-error", "-g", "-halt-on-error" if halt else "-f", flag, main,
        ]
    if engine == "tectonic" and available.get("tectonic"):
        return [available["tectonic"], "-X", "compile", "--synctex", "--keep-logs", "--outdir", outdir, main]
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


def compile_paper(root: Path, folder_rel: str, main: str | None, engine: str, available: dict, run=subprocess.run, compiler: str = "pdflatex", halt: bool = False) -> dict:
    """Compiles the paper; the PDF (base64) when there is one, the log read, and how long it took."""
    folder = inside(root, folder_rel)
    if not folder.is_dir():
        raise Refused(f"{folder_rel} isn't a folder.")
    main = main_file(folder, main)
    out = build_dir(folder)
    out.mkdir(parents=True, exist_ok=True)
    # TeX writes an .aux beside each \include in the build folder, and won't make the folders for them.
    for sub in folder.rglob("*"):
        if sub.is_dir() and ".git" not in sub.relative_to(folder).parts:
            (out / sub.relative_to(folder)).mkdir(parents=True, exist_ok=True)
    argv = compile_command(engine, main, available, compiler, str(out), halt)
    tectonic = Path(argv[0]).stem.lower() == "tectonic"
    stem = Path(main).stem if tectonic else JOB
    pdf_path, log_path = out / f"{stem}.pdf", out / f"{stem}.log"
    started = time.time()
    try:
        done = run(argv, cwd=str(folder), capture_output=True, text=True, timeout=COMPILE_TIMEOUT_S, stdin=subprocess.DEVNULL, errors="replace")
        output = (done.stdout or "") + (done.stderr or "")
        code = done.returncode
    except subprocess.TimeoutExpired:
        output, code = f"Compiling took longer than {COMPILE_TIMEOUT_S} s and was stopped.", -1
    log = log_path.read_text(encoding="utf-8", errors="replace") if log_path.is_file() and log_path.stat().st_mtime >= started - 1 else ""
    read = read_log(log + "\n" + output, folder)
    main_dir = str(Path(main).parent)
    if main_dir not in ("", "."):
        # With -cd, TeX names files from the main file's folder: put them back in the paper's terms.
        for item in read["errors"] + read["warnings"]:
            if item["file"] and not (folder / item["file"]).exists() and (folder / main_dir / item["file"]).exists():
                item["file"] = f"{main_dir}/{item['file']}"
    pdf = ""
    if pdf_path.is_file() and pdf_path.stat().st_mtime >= started - 1 and pdf_path.stat().st_size <= MAX_PDF_BYTES:
        pdf = base64.b64encode(pdf_path.read_bytes()).decode("ascii")
    return {
        "ok": code == 0 and not read["errors"],
        "main": main,
        "engine": Path(argv[0]).stem,
        "compiler": "xelatex" if tectonic else compiler,
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


def _remote_key(url: str) -> str:
    return re.sub(r"\.git/?$", "", (url or "").rstrip("/"))


def _host(url: str) -> str:
    match = re.match(r"^(https://[^/]+)", url or "")
    return match.group(1) if match else ""


def save_token(url: str, token: str) -> None:
    """Kept for the remote, and for its host: an Overleaf Git token is the account's, good for each of its projects."""
    config = state.load_config()
    tokens = config.get("git_tokens") if isinstance(config.get("git_tokens"), dict) else {}
    for key in (_remote_key(url), _host(url)):
        if not key:
            continue
        if token:
            tokens[key] = token
        else:
            tokens.pop(key, None)
    config["git_tokens"] = tokens
    state.save_config(config)


def token_for(url: str) -> str:
    """The remote's token, else its host's: a new project of the same Overleaf account needs none asked for."""
    tokens = state.load_config().get("git_tokens")
    if not isinstance(tokens, dict):
        return ""
    return str(tokens.get(_remote_key(url)) or tokens.get(_host(url)) or "")


def forget_tokens(host: str) -> int:
    """Every token for a host (https://git.overleaf.com): this computer no longer syncs as that account."""
    config = state.load_config()
    tokens = config.get("git_tokens") if isinstance(config.get("git_tokens"), dict) else {}
    kept = {key: value for key, value in tokens.items() if key != host and not key.startswith(host + "/")}
    config["git_tokens"] = kept
    state.save_config(config)
    return len(tokens) - len(kept)


# -------------------------------------------------------------- templates --
# A conference's kit (a .zip of its class, its style and an example paper),
# kept once under the Companion's folder, templates/<name>, and copied into a
# new paper's folder: an empty Overleaf project's clone, or a folder of its own.

TEMPLATES = "templates"
MAX_ZIP_BYTES = 200_000_000
MAX_ZIP_FILES = 5000


def unpack(zip_bytes: bytes, target: Path) -> int:
    """A .zip into target, refusing names that climb out; the one folder a kit is often wrapped in is taken off."""
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as bundle:
        members = [item for item in bundle.infolist() if not item.is_dir() and not item.filename.startswith("__MACOSX/") and not item.filename.rsplit("/", 1)[-1].startswith("._") and item.filename.rsplit("/", 1)[-1] != ".DS_Store"]
        if not members:
            raise Refused("The .zip has no files in it.")
        if len(members) > MAX_ZIP_FILES or sum(item.file_size for item in members) > MAX_ZIP_BYTES:
            raise Refused("The .zip is too big for a paper's template.")
        names = [item.filename.replace("\\", "/") for item in members]
        tops = {name.split("/", 1)[0] for name in names}
        strip = len(tops) == 1 and all("/" in name for name in names)
        written = 0
        for item, name in zip(members, names):
            relative = name.split("/", 1)[1] if strip else name
            parts = [part for part in relative.split("/") if part not in ("", ".")]
            if not parts or any(part == ".." for part in parts) or name.startswith("/") or re.match(r"^[A-Za-z]:", name):
                raise Refused(f"The .zip has a file outside its folder: {name}")
            destination = target.joinpath(*parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(bundle.read(item))
            written += 1
        return written


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:48] or "template"


def save_template(root: Path, name: str, zip_bytes: bytes) -> dict:
    slug = _slug(name)
    target = root / TEMPLATES / slug
    if target.exists():
        raise Refused(f"There is a template called {slug} already: delete it first, or give this one another name.")
    try:
        files = unpack(zip_bytes, target)
    except zipfile.BadZipFile as error:
        raise Refused("That isn't a .zip file.") from error
    except Refused:
        shutil.rmtree(target, ignore_errors=True)
        raise
    (target / ".reader-template").write_text(name.strip() or slug, encoding="utf-8")
    return describe_template(target)


def describe_template(folder: Path) -> dict:
    files = [path for path in folder.rglob("*") if path.is_file() and path.name != ".reader-template"]
    try:
        main = main_file(folder, None)
    except Refused:
        main = ""
    label = folder / ".reader-template"
    return {"slug": folder.name, "name": label.read_text(encoding="utf-8").strip() if label.is_file() else folder.name, "files": len(files), "main": main}


def list_templates(root: Path) -> list[dict]:
    base = root / TEMPLATES
    if not base.is_dir():
        return []
    return [describe_template(folder) for folder in sorted(base.iterdir()) if folder.is_dir() and not folder.name.startswith(".")]


def apply_template(root: Path, slug: str, folder_rel: str, replace: bool = False) -> dict:
    """
    The template's files copied into the paper's folder (made if new). A file already there with the same name is
    refused, unless `replace`: a blank Overleaf project's main.tex, in a clone whose history keeps it.
    """
    source = root / TEMPLATES / _slug(slug)
    if not source.is_dir():
        raise Refused(f"There is no template {slug} on this computer.")
    folder = inside(root, folder_rel)
    files = [path for path in source.rglob("*") if path.is_file() and path.name != ".reader-template"]
    clashes = [path.relative_to(source).as_posix() for path in files if (folder / path.relative_to(source)).exists()]
    if clashes and not replace:
        raise Refused(f"The paper's folder has {', '.join(clashes[:5])} already: start from an empty Overleaf project, or a new folder.")
    for path in files:
        destination = folder / path.relative_to(source)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)
    return {"folder": folder_rel, "files": len(files), "replaced": clashes if replace else [], "main": describe_template(source)["main"]}


def delete_template(root: Path, slug: str) -> None:
    target = root / TEMPLATES / _slug(slug)
    if target.is_dir():
        shutil.rmtree(target)
