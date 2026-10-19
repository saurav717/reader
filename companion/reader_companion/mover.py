"""A project's files moved from one place to another, by the machines themselves (docs/storage-moves.md).

The page doesn't carry the files: it asks the Worker for a move (worker/moves.js), and this script, started on the
machine at each end, does the work there — so the bytes go at each machine's own speed, in one archive rather than a
request a file, and nothing depends on the page staying open.

    pack        the folder → one .tar.gz, streamed to the Worker in parts it keeps in R2, with a manifest of every
                file's size and SHA-256
    unpack      that archive → the new folder, every file checked against the manifest
    drive-pull  the project's Google Drive folder → this machine's folder, many files at a time, checked against
                Drive's MD5s
    drive-push  this machine's folder → a Google Drive folder
    remove      the old copy, once the move is checked: a linked folder is unlinked, never emptied

A place the project leaves keeps a record of every file as it left (.reader/moved-away.json, its MD5s). When the
project comes back there over that old copy, each file is weighed three ways — as it left, as it is there now, as it
arrives — so nothing is lost (`decide`): a file nobody touched there takes the newer version; one changed in both
places is kept beside it as "name (conflict <date>).ext"; one deleted in the newer copy and untouched there goes; one
made there since is kept.

It reports how far it has got to the Worker as it goes, and stops when the Worker says the move was cancelled. Only
the standard library, so it runs on Colab, a Jupyter server or the Companion's own Python alike. The page sends this
same file to a machine without the Companion (src/lib/moverScript.ts), and the Companion runs it from its package
(`companion/move`, extension.py).

    python mover.py config.json        the config is read, then deleted: it holds the move's key
"""

from __future__ import annotations

import hashlib
import http.client
import io
import json
import os
import shutil
import stat
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path, PurePosixPath

PART = 64 * 1024 * 1024
"""How much one upload to the Worker carries: under the 100 MB a Worker takes in one request, and over R2's 5 MB."""
SKIP = {"__pycache__", ".ipynb_checkpoints", ".venv", "venv", "node_modules", ".cache"}
"""Folders that are rebuilt rather than moved."""
BASE = ".reader/moved-away.json"
"""What a place keeps of the project as it left: every file's MD5, so a later move back can tell what changed there."""
REPORT_S = 2.0
DRIVE = "https://www.googleapis.com"
FOLDER_MIME = "application/vnd.google-apps.folder"
DRIVE_THREADS = 8
SMALL = 5 * 1024 * 1024
"""Up to this, a file goes to Drive in one request; past it, in a resumable upload of CHUNK pieces."""
CHUNK = 16 * 1024 * 1024


class Cancelled(Exception):
    pass


class MoveError(Exception):
    pass


# ------------------------------------------------------------------ the Worker --


class Worker:
    """The move's side of the Worker: parts up, the archive down, reports, the Drive token. Retried through blips."""

    def __init__(self, api: str, move: str, key: str, tries: int = 8, pause: float = 1.0):
        self.api = api.rstrip("/")
        self.move = move
        self.key = key
        self.tries = tries
        self.pause = pause
        # Which run of the mover this is: the Worker lets one at a time work on a step.
        self.runner = os.urandom(8).hex()

    def url(self, path: str, **query) -> str:
        return f"{self.api}{path}?{urllib.parse.urlencode({'id': self.move, **query})}"

    def call(self, method: str, path: str, body: bytes | None = None, headers: dict | None = None, query: dict | None = None, stream: bool = False):
        last: Exception | None = None
        for attempt in range(self.tries):
            request = urllib.request.Request(self.url(path, **(query or {})), data=body, method=method, headers={"X-Move-Key": self.key, "User-Agent": "reader-mover/1", **(headers or {})})
            try:
                response = urllib.request.urlopen(request, timeout=120)
                return response if stream else response.read()
            except urllib.error.HTTPError as error:
                text = error.read().decode(errors="replace")[:400]
                # The Worker's own refusals are final; its hiccups (and Cloudflare's) are tried again.
                if error.code in (409, 410):
                    raise Cancelled(text) from error
                if error.code < 500 and error.code != 429:
                    raise MoveError(f"the Worker answered {error.code}: {text}") from error
                last = error
            except (urllib.error.URLError, OSError, TimeoutError) as error:
                last = error
            time.sleep(min(60.0, self.pause * 2**attempt))
        raise MoveError(f"the Worker couldn't be reached: {last}")

    def part(self, number: int, data: bytes) -> None:
        self.call("PUT", "/moves/part", body=data, headers={"Content-Type": "application/octet-stream"}, query={"n": str(number)})

    def report(self, **fields) -> dict:
        answer = json.loads(self.call("POST", "/moves/report", body=json.dumps({"runner": self.runner, **fields}).encode(), headers={"Content-Type": "application/json"}) or b"{}")
        if answer.get("cancelled"):
            raise Cancelled("the move was cancelled")
        return answer

    def manifest(self) -> list:
        return json.loads(self.call("GET", "/moves/manifest"))["files"]

    def archive(self, start: int = 0):
        return self.call("GET", "/moves/archive", headers={"Range": f"bytes={start}-"} if start else {}, stream=True)

    def token(self) -> str:
        return json.loads(self.call("GET", "/moves/token")).get("token") or ""


class Progress:
    """Reports at most every REPORT_S seconds, and always at the end of a step."""

    def __init__(self, worker: Worker, step: str, total_files: int = 0, total_bytes: int = 0):
        self.worker, self.step = worker, step
        self.files = self.bytes = 0
        self.total_files, self.total_bytes = total_files, total_bytes
        self.lock = threading.Lock()
        self.last = 0.0

    def add(self, files: int = 0, size: int = 0, force: bool = False) -> None:
        with self.lock:
            self.files += files
            self.bytes += size
            due = force or time.monotonic() - self.last >= REPORT_S
            if due:
                self.last = time.monotonic()
        if due:
            self.send()

    def send(self, **extra) -> dict:
        return self.worker.report(step=self.step, files=self.files, bytes=self.bytes, totalFiles=self.total_files, totalBytes=self.total_bytes, **extra)


# ------------------------------------------------------------------- the folder --


def walk(root: Path, skip: set[str]):
    """Every file under root, as (relative posix path, absolute path), skipped folders left out; symlinks as links."""
    for folder, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in skip)
        here = Path(folder)
        for name in sorted(names):
            full = here / name
            relative = full.relative_to(root).as_posix()
            if relative != BASE:
                yield relative, full
        for d in dirs:
            if (here / d).is_symlink():
                yield (here / d).relative_to(root).as_posix(), here / d


def safe_member(name: str) -> str | None:
    """A path from an archive or Drive as one inside the folder, or None: never absolute, never climbing out."""
    path = PurePosixPath(name.replace("\\", "/"))
    if path.is_absolute() or any(part in ("..", "") for part in path.parts) or not path.parts:
        return None
    return path.as_posix()


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def md5_of(path: Path) -> str:
    digest = hashlib.md5()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


# ------------------------------------------------------- an old copy, met again --


def decide(here: str | None, base: str | None, incoming: str | None, meta: bool = False) -> str:
    """What becomes of one path when files arrive where an older copy may be, from three MD5s: as it is here now
    (None: not here), as it was when the project left here (None: no record of it), and as it arrives (None: not
    in the newer copy). The answer: "same", "take" (write the newer version), "conflict" (keep what is here beside
    it, then write the newer one), "remove" (deleted in the newer copy, untouched here), or "keep" (only here)."""
    if incoming is None:
        if here is not None and base is not None and here == base and not meta:
            return "remove"
        return "keep"
    if here is None:
        return "take"
    if here == incoming:
        return "same"
    # The app's own files (.reader/: the agent's conversations) follow the newer copy.
    if meta or (base is not None and here == base):
        return "take"
    return "conflict"


def conflict_name(relative: str, when: str, taken) -> str:
    """Where the version here is kept when both changed: beside it, the date in its name, never over another."""
    path = PurePosixPath(relative)
    for n in range(1, 1000):
        name = f"{path.stem} (conflict {when}{'' if n == 1 else f' {n}'}){path.suffix}"
        candidate = str(path.with_name(name))
        if not taken(candidate):
            return candidate
    raise MoveError(f"too many conflict copies of {relative}")


def is_meta(relative: str) -> bool:
    return relative.startswith(".reader/")


class Arrival:
    """Files arriving in a folder on this machine that may hold an older copy: each decided before it is written,
    and what is only here decided at the end. What it did is reported with the move."""

    def __init__(self, root: Path, incoming: dict[str, str | None]):
        self.root = root
        self.incoming = incoming
        self.here = {rel: full for rel, full in walk(root, set(SKIP)) if full.is_file() and not full.is_symlink()} if root.exists() else {}
        record = root / BASE
        try:
            self.base = json.loads(record.read_text()).get("files") if record.is_file() else None
        except (OSError, ValueError):
            self.base = None
        self.when = time.strftime("%Y-%m-%d")
        self.conflicts: list[str] = []
        self.kept: list[str] = []
        self.removed: list[str] = []
        self.lock = threading.Lock()

    def before(self, relative: str) -> None:
        """Just before `relative` is written: what is there kept beside it when both changed."""
        full = self.here.get(relative)
        if full is None or not full.is_file():
            return
        verdict = decide(md5_of(full), (self.base or {}).get(relative), self.incoming.get(relative) or "", is_meta(relative))
        if verdict == "conflict":
            with self.lock:
                aside = conflict_name(relative, self.when, lambda c: (self.root / c).exists() or c in self.incoming)
                os.replace(full, self.root / aside)
                self.conflicts.append(relative)

    def finish(self) -> dict:
        """What is only here, decided; the old record gone. The summary the Worker keeps."""
        for relative, full in self.here.items():
            if relative in self.incoming or not full.is_file():
                continue
            verdict = decide(md5_of(full), (self.base or {}).get(relative), None, is_meta(relative))
            if verdict == "remove":
                full.unlink()
                self.removed.append(relative)
            elif not is_meta(relative):
                self.kept.append(relative)
        (self.root / BASE).unlink(missing_ok=True)
        return summary(self.conflicts, self.kept, self.removed)


def summary(conflicts: list, kept: list, removed: list) -> dict:
    return {"conflicts": len(conflicts), "conflictPaths": sorted(conflicts)[:50], "kept": len(kept), "keptPaths": sorted(kept)[:50], "stale": len(removed)}


def leave_record(root: Path, move: str, files: dict[str, str]) -> None:
    """The project leaves this folder: what every file was, for the day it comes back."""
    record = root / BASE
    record.parent.mkdir(parents=True, exist_ok=True)
    record.write_text(json.dumps({"move": move, "at": int(time.time()), "files": files}))


def check(root: Path, manifest: list) -> list[str]:
    """The files the manifest names that aren't in root as it says: missing, or another size or hash."""
    wrong = []
    for entry in manifest:
        path = root / entry["path"]
        if entry.get("link"):
            if not path.is_symlink():
                wrong.append(entry["path"])
            continue
        if not path.is_file() or path.stat().st_size != entry["size"] or (entry.get("sha256") and sha256_of(path) != entry["sha256"]):
            wrong.append(entry["path"])
    return wrong


# ------------------------------------------------------------- pack and unpack --


class Parts(io.RawIOBase):
    """A file-like sink that sends what is written to it in PART-sized pieces."""

    def __init__(self, send, size: int | None = None):
        self.send, self.size = send, size or PART
        self.buffer = bytearray()
        self.count = 0
        self.sent = 0

    def writable(self) -> bool:
        return True

    def write(self, data) -> int:
        self.buffer += data
        while len(self.buffer) >= self.size:
            self.flush_part(bytes(self.buffer[: self.size]))
            del self.buffer[: self.size]
        return len(data)

    def flush_part(self, data: bytes) -> None:
        self.count += 1
        self.send(self.count, data)
        self.sent += len(data)

    def finish(self) -> None:
        if self.buffer or not self.count:
            self.flush_part(bytes(self.buffer))
            self.buffer.clear()


class Hashing(io.RawIOBase):
    """A file read through, its SHA-256 taken on the way and progress counted."""

    def __init__(self, handle, progress: Progress):
        self.handle, self.progress = handle, progress
        self.digest = hashlib.sha256()
        self.md5 = hashlib.md5()

    def readable(self) -> bool:
        return True

    def readinto(self, buffer) -> int:
        data = self.handle.read(len(buffer))
        buffer[: len(data)] = data
        self.digest.update(data)
        self.md5.update(data)
        self.progress.add(size=len(data))
        return len(data)


def pack(worker: Worker, root: Path, skip: set[str]) -> dict:
    root = root.resolve()
    if not root.is_dir():
        raise MoveError(f"there is no folder at {root}")
    entries = list(walk(root, skip))
    total = sum(full.lstat().st_size for _, full in entries if not full.is_symlink())
    progress = Progress(worker, "packing", len(entries), total)
    progress.send()
    manifest = []
    sink = Parts(worker.part)
    with tarfile.open(fileobj=sink, mode="w|gz", compresslevel=3) as archive:
        for relative, full in entries:
            info = archive.gettarinfo(str(full), arcname=relative)
            if info.issym():
                archive.addfile(info)
                manifest.append({"path": relative, "link": info.linkname})
            elif info.isreg():
                with open(full, "rb") as handle:
                    reader = Hashing(handle, progress)
                    archive.addfile(info, io.BufferedReader(reader, 1024 * 1024))
                manifest.append({"path": relative, "size": info.size, "sha256": reader.digest.hexdigest(), "md5": reader.md5.hexdigest()})
            progress.add(files=1)
    sink.finish()
    leave_record(root, worker.move, {entry["path"]: entry["md5"] for entry in manifest if "md5" in entry})
    progress.step = "packed"
    progress.send(parts=sink.count, archiveBytes=sink.sent, manifest=manifest)
    return {"files": len(manifest), "bytes": total, "parts": sink.count}


class Resuming(io.RawIOBase):
    """The archive as one stream; a connection that drops is opened again from where it was (an HTTP Range)."""

    def __init__(self, worker: Worker):
        self.worker = worker
        self.offset = 0
        self.response = worker.archive()

    def readable(self) -> bool:
        return True

    def readinto(self, buffer) -> int:
        for attempt in range(8):
            try:
                data = self.response.read(len(buffer))
                buffer[: len(data)] = data
                self.offset += len(data)
                return len(data)
            except (OSError, urllib.error.URLError, http.client.HTTPException):
                time.sleep(min(30.0, 2**attempt))
                self.response = self.worker.archive(self.offset)
        raise MoveError("the archive stopped coming")


def unpack(worker: Worker, root: Path) -> dict:
    manifest = worker.manifest()
    total = sum(entry.get("size", 0) for entry in manifest)
    progress = Progress(worker, "unpacking", len(manifest), total)
    progress.send()
    root.mkdir(parents=True, exist_ok=True)
    real = root.resolve()
    arrival = Arrival(real, {entry["path"]: entry.get("md5") for entry in manifest if not entry.get("link")})
    with tarfile.open(fileobj=io.BufferedReader(Resuming(worker), 1024 * 1024), mode="r|gz") as archive:
        for member in archive:
            relative = safe_member(member.name)
            if relative is None:
                continue
            target = real / relative
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.issym():
                # A link only when it points inside the folder.
                pointed = (target.parent / member.linkname).resolve()
                if not str(pointed).startswith(str(real)):
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.is_symlink() or target.exists():
                    target.unlink()
                os.symlink(member.linkname, target)
            elif member.isreg():
                target.parent.mkdir(parents=True, exist_ok=True)
                arrival.before(relative)
                source = archive.extractfile(member)
                with open(target, "wb") as out:
                    for block in iter(lambda: source.read(1024 * 1024), b""):
                        out.write(block)
                        progress.add(size=len(block))
                os.chmod(target, (member.mode & 0o777) | stat.S_IRUSR | stat.S_IWUSR)
                progress.add(files=1)
    wrong = check(real, manifest)
    if wrong:
        raise MoveError(f"{len(wrong)} file(s) didn't arrive whole: {', '.join(wrong[:5])}")
    met = arrival.finish()
    progress.step = "unpacked"
    progress.send(verified=len(manifest), **met)
    return {"files": len(manifest), "bytes": total, **met}


# ------------------------------------------------------------------- Drive --


class Drive:
    """Google Drive's API with the account's token, which the page renews through the Worker while it is open."""

    def __init__(self, worker: Worker):
        self.worker = worker
        self.token = worker.token()
        self.lock = threading.Lock()

    def renew(self, stale: str) -> None:
        with self.lock:
            if self.token != stale:
                return
            for _ in range(240):  # an hour, a quarter-minute at a time: the page renews it when it is next open
                fresh = self.worker.token()
                if fresh and fresh != stale:
                    self.token = fresh
                    return
                try:
                    self.worker.report(step="waiting", waiting="google")
                except MoveError:
                    pass
                time.sleep(15)
            raise MoveError("your Google sign-in ran out and wasn't renewed: open the project again to carry on")

    def request(self, method: str, url: str, body: bytes | None = None, headers: dict | None = None, stream: bool = False):
        for attempt in range(8):
            token = self.token
            request = urllib.request.Request(url, data=body, method=method, headers={"Authorization": f"Bearer {token}", **(headers or {})})
            try:
                response = urllib.request.urlopen(request, timeout=300)
                return response if stream else response.read()
            except urllib.error.HTTPError as error:
                if error.code == 401:
                    self.renew(token)
                    continue
                if error.code in (403, 429) or error.code >= 500:
                    time.sleep(min(60.0, 2**attempt))
                    continue
                raise MoveError(f"Drive answered {error.code}: {error.read().decode(errors='replace')[:300]}") from error
            except (urllib.error.URLError, OSError, TimeoutError):
                time.sleep(min(60.0, 2**attempt))
        raise MoveError("Drive couldn't be reached")

    def children(self, folder: str) -> list[dict]:
        found, page = [], None
        while True:
            query = {"q": f"'{folder}' in parents and trashed = false", "fields": "nextPageToken,files(id,name,mimeType,size,md5Checksum)", "pageSize": "1000", "spaces": "drive"}
            if page:
                query["pageToken"] = page
            payload = json.loads(self.request("GET", f"{DRIVE}/drive/v3/files?{urllib.parse.urlencode(query)}"))
            found += payload.get("files", [])
            page = payload.get("nextPageToken")
            if not page:
                return found

    def tree(self, folder: str, prefix: str = "") -> list[dict]:
        out = []
        for child in self.children(folder):
            path = f"{prefix}{child['name']}"
            if child["mimeType"] == FOLDER_MIME:
                if child["name"] not in SKIP:
                    out += self.tree(child["id"], f"{path}/")
            elif not child["mimeType"].startswith("application/vnd.google-apps."):
                out.append({**child, "path": path})
        return out

    def folder(self, name: str, parent: str) -> str:
        for child in self.children(parent):
            if child["name"] == name and child["mimeType"] == FOLDER_MIME:
                return child["id"]
        body = json.dumps({"name": name, "mimeType": FOLDER_MIME, "parents": [parent]}).encode()
        return json.loads(self.request("POST", f"{DRIVE}/drive/v3/files?fields=id", body, {"Content-Type": "application/json"}))["id"]

    def trash(self, file_id: str) -> None:
        self.request("PATCH", f"{DRIVE}/drive/v3/files/{file_id}?fields=id", json.dumps({"trashed": True}).encode(), {"Content-Type": "application/json"})

    def rename(self, file_id: str, name: str) -> None:
        self.request("PATCH", f"{DRIVE}/drive/v3/files/{file_id}?fields=id", json.dumps({"name": name}).encode(), {"Content-Type": "application/json"})

    def text(self, file_id: str) -> str:
        return self.request("GET", f"{DRIVE}/drive/v3/files/{file_id}?alt=media").decode()

    def put_text(self, name: str, parent: str, text: str, existing: str | None) -> None:
        import tempfile

        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            handle.write(text)
        try:
            self.upload(Path(handle.name), name, parent, existing)
        finally:
            os.unlink(handle.name)

    def upload(self, path: Path, name: str, parent: str, existing: str | None) -> None:
        size = path.stat().st_size
        meta = {"name": name} if existing else {"name": name, "parents": [parent]}
        base = f"{DRIVE}/upload/drive/v3/files{'/' + existing if existing else ''}"
        method = "PATCH" if existing else "POST"
        if size <= SMALL:
            boundary = "reader-mover-boundary"
            body = (f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{json.dumps(meta)}\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n").encode() + path.read_bytes() + f"\r\n--{boundary}--".encode()
            self.request(method, f"{base}?uploadType=multipart&fields=id", body, {"Content-Type": f"multipart/related; boundary={boundary}"})
            return
        start = self.request(method, f"{base}?uploadType=resumable&fields=id", json.dumps(meta).encode(), {"Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": str(size)}, stream=True)
        session = start.headers["Location"]
        with open(path, "rb") as handle:
            sent = 0
            while sent < size:
                chunk = handle.read(CHUNK)
                end = sent + len(chunk) - 1
                try:
                    self.request("PUT", session, chunk, {"Content-Range": f"bytes {sent}-{end}/{size}"})
                except MoveError as error:
                    # 308, "resume incomplete", is how Drive says a chunk is in.
                    if "308" not in str(error):
                        raise
                sent = end + 1


def drive_pull(worker: Worker, root: Path, folder: str) -> dict:
    drive = Drive(worker)
    every = [f for f in drive.tree(folder) if safe_member(f["path"])]
    files = [f for f in every if f["path"] != BASE]
    total = sum(int(f.get("size") or 0) for f in files)
    progress = Progress(worker, "pulling", len(files), total)
    progress.send()
    root.mkdir(parents=True, exist_ok=True)
    arrival = Arrival(root, {f["path"]: f.get("md5Checksum") for f in files})
    manifest = []

    def fetch(entry: dict) -> dict:
        target = root / entry["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        arrival.before(entry["path"])
        for _ in range(3):
            digest = hashlib.md5()
            response = drive.request("GET", f"{DRIVE}/drive/v3/files/{entry['id']}?alt=media", stream=True)
            with open(target, "wb") as out:
                for block in iter(lambda: response.read(1024 * 1024), b""):
                    out.write(block)
                    digest.update(block)
                    progress.add(size=len(block))
            if not entry.get("md5Checksum") or digest.hexdigest() == entry["md5Checksum"]:
                progress.add(files=1)
                return {"path": entry["path"], "size": target.stat().st_size, "sha256": sha256_of(target), "md5": digest.hexdigest()}
        raise MoveError(f"{entry['path']} came from Drive damaged three times")

    with ThreadPoolExecutor(DRIVE_THREADS) as pool:
        manifest = list(pool.map(fetch, files))
    met = arrival.finish()
    # Drive is left: its folder keeps what every file was, for the day the project comes back to it.
    record = next((f for f in every if f["path"] == BASE), None)
    drive.put_text("moved-away.json", drive.folder(".reader", folder), json.dumps({"move": worker.move, "at": int(time.time()), "files": {f["path"]: f.get("md5Checksum") for f in files}}), record["id"] if record else None)
    progress.step = "pulled"
    progress.send(verified=len(manifest), manifest=manifest, **met)
    return {"files": len(manifest), "bytes": total, **met}


def drive_push(worker: Worker, root: Path, folder: str, skip: set[str]) -> dict:
    drive = Drive(worker)
    root = root.resolve()
    entries = [(rel, full) for rel, full in walk(root, skip) if full.is_file() and not full.is_symlink()]
    total = sum(full.stat().st_size for _, full in entries)
    progress = Progress(worker, "pushing", len(entries), total)
    progress.send()
    folders: dict[str, str] = {"": folder}
    present: dict[str, dict[str, str]] = {}

    def folder_of(relative_dir: str) -> str:
        if relative_dir in folders:
            return folders[relative_dir]
        parent, _, name = relative_dir.rpartition("/")
        folders[relative_dir] = drive.folder(name, folder_of(parent))
        return folders[relative_dir]

    def known(parent: str) -> dict[str, str]:
        if parent not in present:
            present[parent] = {c["name"]: c["id"] for c in drive.children(parent) if c["mimeType"] != FOLDER_MIME}
        return present[parent]

    # An older copy already in that Drive folder: weighed against the record it kept when the project left it.
    there = {f["path"]: f for f in drive.tree(folder) if safe_member(f["path"])}
    record = there.pop(BASE, None)
    try:
        base = json.loads(drive.text(record["id"])).get("files") if record else None
    except (MoveError, ValueError):
        base = None
    incoming = {rel: md5_of(full) for rel, full in entries}
    when = time.strftime("%Y-%m-%d")
    conflicts, kept, removed = [], [], []
    for rel, f in there.items():
        verdict = decide(f.get("md5Checksum"), (base or {}).get(rel), incoming.get(rel), is_meta(rel))
        if verdict == "conflict":
            aside = conflict_name(rel, when, lambda c: c in there or c in incoming)
            drive.rename(f["id"], aside.rpartition("/")[2])
            conflicts.append(rel)
        elif verdict == "remove":
            drive.trash(f["id"])
            removed.append(rel)
        elif verdict == "keep" and not is_meta(rel):
            kept.append(rel)
    if record:
        drive.trash(record["id"])

    # Folders first, in order, so the uploads in parallel each find theirs.
    for rel, _ in entries:
        parent = folder_of(rel.rpartition("/")[0])
        known(parent)
    # What was set aside or sent to the bin is no longer there to be written over.
    for rel in conflicts + removed:
        parent = folders.get(rel.rpartition("/")[0])
        if parent:
            present[parent].pop(rel.rpartition("/")[2], None)
    manifest = []

    def send(item):
        rel, full = item
        parent = folders[rel.rpartition("/")[0]]
        name = rel.rpartition("/")[2]
        if incoming[rel] != (there.get(rel) or {}).get("md5Checksum"):
            drive.upload(full, name, parent, present[parent].get(name))
        progress.add(files=1, size=full.stat().st_size)
        return {"path": rel, "size": full.stat().st_size, "md5": incoming[rel]}

    with ThreadPoolExecutor(DRIVE_THREADS) as pool:
        manifest = list(pool.map(send, entries))
    leave_record(root, worker.move, incoming)
    met = summary(conflicts, kept, removed)
    progress.step = "pushed"
    progress.send(verified=len(manifest), manifest=manifest, **met)
    return {"files": len(manifest), "bytes": total, **met}


# ------------------------------------------------------------------- the rest --


def remove(root: Path) -> None:
    """The old copy gone. A linked folder (a folder of the person's own, linked in) is unlinked, never emptied."""
    if root.is_symlink():
        root.unlink()
        return
    real = root.resolve()
    home = Path.home().resolve()
    if real in (Path("/"), home) or len(real.parts) < 3 or not real.is_dir():
        raise MoveError(f"won't remove {real}")
    shutil.rmtree(real)


def disk(root: Path) -> dict:
    at = root if root.exists() else next((p for p in root.parents if p.exists()), Path("/"))
    usage = shutil.disk_usage(at)
    return {"free": usage.free, "total": usage.total, "path": str(root)}


def run(config: dict) -> dict:
    mode = config["mode"]
    root = Path(os.path.expanduser(config.get("root") or "."))
    if mode == "disk":
        return disk(root)
    if mode == "remove" and not config.get("key"):
        remove(root)
        return {"removed": str(root)}
    worker = Worker(config["api"], config["id"], config["key"])
    skip = set(config.get("skip") or SKIP)
    try:
        if mode == "pack":
            return pack(worker, root, skip)
        if mode == "unpack":
            return unpack(worker, root)
        if mode == "drive-pull":
            return drive_pull(worker, root, config["drive"])
        if mode == "drive-push":
            return drive_push(worker, root, config["drive"], skip)
        if mode == "remove":
            remove(root)
            worker.report(step="removed")
            return {"removed": str(root)}
        raise MoveError(f"no such step: {mode}")
    except Cancelled:
        return {"cancelled": True}
    except Exception as error:  # every failure is told to the Worker, so the page can say what happened
        try:
            worker.report(step="failed", error=f"{type(error).__name__}: {error}"[:600], mode=mode)
        except Exception:
            pass
        raise


MODES = ("pack", "unpack", "drive-pull", "drive-push", "remove")


def prepare(body: dict, base: Path) -> dict:
    """A move the page or the Worker asked the Companion for (companion/move), checked: one of the steps, a Worker
    reached over https (or this computer, for a test), and a folder inside the Companion's own — a project's folder
    is relative to it, as the page's file host names it."""
    if not isinstance(body, dict) or body.get("mode") not in MODES:
        raise MoveError(f"mode must be one of {', '.join(MODES)}")
    api = str(body.get("api") or "")
    parsed = urllib.parse.urlparse(api)
    if not (parsed.scheme == "https" or (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost")) or (body["mode"] == "remove" and not api)):
        raise MoveError("the Worker's address must be https")
    # Removing the old copy reports to no one: any browser of the account may ask for it, with the Companion's token.
    if body["mode"] != "remove" and not all(isinstance(body.get(k), str) and body[k] for k in ("id", "key")):
        raise MoveError("which move, with its key?")
    relative = safe_member(str(body.get("root") or "").strip("/")) if body.get("root") else None
    if body.get("root") and relative is None:
        raise MoveError("the folder must be inside the Companion's own")
    root = base / relative if relative else base
    if body["mode"] == "remove" and root == base:
        raise MoveError("won't remove the Companion's whole folder")
    config = {"mode": body["mode"], "api": api.rstrip("/"), "id": str(body.get("id") or ""), "key": str(body.get("key") or ""), "root": str(root)}
    if body["mode"] in ("drive-pull", "drive-push"):
        if not isinstance(body.get("drive"), str) or not body["drive"]:
            raise MoveError("which Drive folder?")
        config["drive"] = body["drive"]
    return config


def start_detached(config: dict, folder: Path) -> int:
    """The mover started on its own, apart from the Companion and the kernel: it outlives both, and the page."""
    import subprocess

    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"move-{config['id']}-{config['mode']}.json"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(config, handle)
    log = open(folder / f"move-{config['id']}.log", "ab")
    process = subprocess.Popen([sys.executable, os.path.abspath(__file__), str(path)], stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
    return process.pid


def main(argv: list[str]) -> int:
    path = Path(argv[1])
    config = json.loads(path.read_text())
    path.unlink(missing_ok=True)
    print(json.dumps(run(config)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
