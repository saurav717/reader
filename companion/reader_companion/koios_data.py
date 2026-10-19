"""koios_data: a project's data, checkpoints and run outputs kept where you chose — Google Drive by default — while the
code runs wherever it runs: Colab's GPU, a server, your own computer. The compute's disk is only a cache.

    import koios_data

    koios_data.where()                        # "Google Drive · Koios/Data/<project>", or a folder on this machine
    path = koios_data.path("datasets/cifar")  # a local path; fetched from the data place first if it is there
    koios_data.save("outputs/model.pt")       # a file or folder put in the data place, under the same name
    koios_data.save("big.npz", evict=True)    # ... and removed from this disk once it is safely there
    sync = koios_data.sync("runs")            # a folder pushed every few minutes and at exit, in the background
    sync.now()                                # ... and right now
    koios_data.fetch("checkpoints/latest.json")   # one file (or folder) brought to the cache

koios_telemetry.Run syncs its run folder by itself, and koios.checkpoint puts every checkpoint there, so a Colab
runtime that goes away loses at most a few minutes.

How it is set up: Koios writes the place beside this module (koios_data.json on the helper path) and in the
environment (KOIOS_DATA) before anything runs — a Drive folder reached with the account's token, which the Worker
hands over and the page renews; or a folder on this machine. Nothing is mounted; the token sees only files Koios
made (drive.file), and lives on the Worker, not in the folder.

From a terminal:

    python koios_data.py where
    python koios_data.py ls [prefix]
    python koios_data.py get <name>            # into the cache
    python koios_data.py put <local> [name]
    python koios_data.py sync <folder> [name]  # once, now
"""

from __future__ import annotations

import atexit
import hashlib
import json
import os
import shutil
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DRIVE = "https://www.googleapis.com"
FOLDER_MIME = "application/vnd.google-apps.folder"
SMALL = 5 * 1024 * 1024
CHUNK = 16 * 1024 * 1024
SKIP = {"__pycache__", ".ipynb_checkpoints", ".venv", "venv", "node_modules", ".cache", ".git"}
CONFIG_FILE = "koios_data.json"


class DataError(Exception):
    pass


# ------------------------------------------------------------------ the place --


def _config() -> dict | None:
    """Where the data is: KOIOS_DATA in the environment, else koios_data.json beside this module (the helper path)."""
    raw = os.environ.get("KOIOS_DATA", "").strip()
    if raw:
        if raw.startswith("{"):
            try:
                return json.loads(raw)
            except ValueError:
                return None
        parts = raw.split("|")
        if parts[0] == "local" and len(parts) >= 2:
            return {"kind": "local", "dir": parts[1], "label": parts[2] if len(parts) > 2 else "this machine"}
        if parts[0] == "drive" and len(parts) >= 5:
            return {"kind": "drive", "api": parts[1], "id": parts[2], "key": parts[3], "folder": parts[4], "label": parts[5] if len(parts) > 5 else "Google Drive"}
        return None
    for candidate in (os.path.join(os.path.dirname(os.path.abspath(__file__)), CONFIG_FILE), os.path.join(os.environ.get("KOIOS_PYLIB", ""), CONFIG_FILE) if os.environ.get("KOIOS_PYLIB") else ""):
        if candidate and os.path.exists(candidate):
            try:
                with open(candidate, encoding="utf-8") as f:
                    return json.load(f)
            except (OSError, ValueError):
                continue
    return None


def cache_dir() -> str:
    """Where fetched files land on this machine: KOIOS_DATA_CACHE, else ./.koios-data (which the sync leaves alone)."""
    return os.environ.get("KOIOS_DATA_CACHE") or os.path.join(os.getcwd(), ".koios-data")


def enabled() -> bool:
    return _config() is not None


def where() -> str:
    c = _config()
    if not c:
        return "nowhere: KOIOS_DATA is not set (data stays on this disk)"
    if c["kind"] == "local":
        return f"{c.get('label') or 'this machine'} · {c['dir']}"
    return f"{c.get('label') or 'Google Drive'} · Koios/Data (folder {c['folder']})"


# ------------------------------------------------------------------- Drive --


class _Drive:
    """Google Drive with the account's token from the Worker, renewed there by the page while it is open."""

    def __init__(self, c: dict):
        self.api, self.move, self.key, self.root = c["api"].rstrip("/"), c["id"], c["key"], c["folder"]
        self.lock = threading.Lock()
        self.token = ""
        self.folders: dict[str, str] = {"": self.root}
        self.listed: dict[str, dict[str, dict]] = {}

    def _worker_token(self) -> str:
        request = urllib.request.Request(f"{self.api}/moves/token?id={urllib.parse.quote(self.move)}", headers={"X-Move-Key": self.key})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return str(json.loads(response.read()).get("token") or "")
        except urllib.error.HTTPError as error:
            if error.code == 404:
                raise DataError("the data link has ended (open the project in Koios again to make a new one)") from error
            raise DataError(f"the Worker answered {error.code} for the data token") from error
        except (urllib.error.URLError, OSError) as error:
            raise DataError(f"the Worker couldn't be reached: {error}") from error

    def renew(self, stale: str) -> None:
        with self.lock:
            if self.token and self.token != stale:
                return
            for i in range(240):  # an hour, a quarter-minute at a time: the page renews it when it is next open
                fresh = self._worker_token()
                if fresh and fresh != stale:
                    self.token = fresh
                    return
                if i == 0:
                    print("[koios_data] waiting for the Google sign-in to be renewed in Koios…", file=sys.stderr, flush=True)
                time.sleep(15)
            raise DataError("your Google sign-in ran out and wasn't renewed: open the project in Koios to carry on")

    def request(self, method: str, url: str, body: bytes | None = None, headers: dict | None = None, stream: bool = False):
        if not self.token:
            self.renew("")
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
                if error.code == 308:
                    return b""
                if error.code in (403, 429) or error.code >= 500:
                    time.sleep(min(60.0, 2**attempt))
                    continue
                raise DataError(f"Drive answered {error.code}: {error.read().decode(errors='replace')[:300]}") from error
            except (urllib.error.URLError, OSError, TimeoutError):
                time.sleep(min(60.0, 2**attempt))
        raise DataError("Drive couldn't be reached")

    def children(self, folder: str, fresh: bool = False) -> dict[str, dict]:
        if folder in self.listed and not fresh:
            return self.listed[folder]
        found, page = {}, None
        while True:
            query = {"q": f"'{folder}' in parents and trashed = false", "fields": "nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime)", "pageSize": "1000", "spaces": "drive"}
            if page:
                query["pageToken"] = page
            payload = json.loads(self.request("GET", f"{DRIVE}/drive/v3/files?{urllib.parse.urlencode(query)}"))
            for f in payload.get("files", []):
                found[f["name"]] = f
            page = payload.get("nextPageToken")
            if not page:
                break
        self.listed[folder] = found
        return found

    def folder(self, rel: str, make: bool = True) -> str | None:
        """The id of the folder at rel ('' the root), made on the way when `make`."""
        rel = rel.strip("/")
        if rel in self.folders:
            return self.folders[rel]
        parent_rel, _, name = rel.rpartition("/")
        parent = self.folder(parent_rel, make)
        if parent is None:
            return None
        hit = self.children(parent).get(name)
        if hit and hit["mimeType"] == FOLDER_MIME:
            self.folders[rel] = hit["id"]
            return hit["id"]
        if not make:
            return None
        body = json.dumps({"name": name, "mimeType": FOLDER_MIME, "parents": [parent]}).encode()
        made = json.loads(self.request("POST", f"{DRIVE}/drive/v3/files?fields=id", body, {"Content-Type": "application/json"}))["id"]
        self.folders[rel] = made
        self.children(parent)[name] = {"id": made, "name": name, "mimeType": FOLDER_MIME}
        return made

    def entry(self, rel: str) -> dict | None:
        parent_rel, _, name = rel.strip("/").rpartition("/")
        parent = self.folder(parent_rel, make=False)
        return self.children(parent).get(name) if parent else None

    def tree(self, rel: str) -> list[tuple[str, dict]]:
        """Every file under the folder at rel, as (relative path from it, entry)."""
        out = []
        folder = self.folder(rel, make=False)
        if folder is None:
            return out
        stack = [(folder, "")]
        while stack:
            at, prefix = stack.pop()
            for name, f in self.children(at).items():
                if f["mimeType"] == FOLDER_MIME:
                    if name not in SKIP:
                        stack.append((f["id"], f"{prefix}{name}/"))
                elif not f["mimeType"].startswith("application/vnd.google-apps."):
                    out.append((f"{prefix}{name}", f))
        return out

    def download(self, file_id: str, target: Path) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        response = self.request("GET", f"{DRIVE}/drive/v3/files/{file_id}?alt=media", stream=True)
        tmp = target.with_name(target.name + ".part")
        with open(tmp, "wb") as handle:
            shutil.copyfileobj(response, handle, 1024 * 1024)
        os.replace(tmp, target)

    def upload(self, path: Path, rel: str) -> None:
        parent_rel, _, name = rel.strip("/").rpartition("/")
        parent = self.folder(parent_rel)
        existing = self.children(parent).get(name)
        if existing and existing.get("md5Checksum") == _md5(path):
            return
        size = path.stat().st_size
        meta = {"name": name} if existing else {"name": name, "parents": [parent]}
        base = f"{DRIVE}/upload/drive/v3/files{'/' + existing['id'] if existing else ''}"
        method = "PATCH" if existing else "POST"
        if size <= SMALL:
            boundary = "koios-data-boundary"
            body = (f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{json.dumps(meta)}\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n").encode() + path.read_bytes() + f"\r\n--{boundary}--".encode()
            made = json.loads(self.request(method, f"{base}?uploadType=multipart&fields=id,md5Checksum", body, {"Content-Type": f"multipart/related; boundary={boundary}"}) or b"{}")
        else:
            start = self.request(method, f"{base}?uploadType=resumable&fields=id,md5Checksum", json.dumps(meta).encode(), {"Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": str(size)}, stream=True)
            session = start.headers["Location"]
            made = {}
            with open(path, "rb") as handle:
                sent = 0
                while sent < size:
                    chunk = handle.read(CHUNK)
                    end = sent + len(chunk) - 1
                    answer = self.request("PUT", session, chunk, {"Content-Range": f"bytes {sent}-{end}/{size}"})
                    sent = end + 1
                    if answer:
                        try:
                            made = json.loads(answer)
                        except ValueError:
                            made = {}
        self.children(parent)[name] = {"id": made.get("id") or (existing or {}).get("id"), "name": name, "mimeType": "application/octet-stream", "md5Checksum": made.get("md5Checksum") or _md5(path), "size": str(size)}


_drive: _Drive | None = None
_drive_lock = threading.Lock()


def _place() -> tuple[dict, _Drive | None]:
    c = _config()
    if not c:
        raise DataError("KOIOS_DATA is not set: open the project in Koios with its compute connected, and run again")
    if c["kind"] == "local":
        return c, None
    global _drive
    with _drive_lock:
        if _drive is None:
            _drive = _Drive(c)
    return c, _drive


def _md5(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def _clean(name: str) -> str:
    rel = name.replace("\\", "/").strip("/")
    if not rel or ".." in rel.split("/"):
        raise DataError(f"not a name in the data place: {name!r}")
    return rel


# --------------------------------------------------------------------- API --


def path(name: str, fetch: bool = True) -> str:
    """A local path for `name` in the data place: in the cache (fetched from Drive when it is there and not here
    yet), or the file itself when the place is a folder on this machine. Use it as you would any path."""
    rel = _clean(name)
    c, drive = _place()
    if drive is None:
        local = os.path.join(c["dir"], rel)
        os.makedirs(os.path.dirname(local) or ".", exist_ok=True)
        return local
    local = os.path.join(cache_dir(), rel)
    if fetch and not os.path.exists(local):
        try:
            _fetch(drive, rel, Path(local))
        except DataError as error:
            print(f"[koios_data] {rel}: {error}", file=sys.stderr, flush=True)
    os.makedirs(os.path.dirname(local) or ".", exist_ok=True)
    return local


def fetch(name: str) -> str:
    """A file or a folder brought from the data place into the cache (or the path itself, for a local place). The local path."""
    rel = _clean(name)
    c, drive = _place()
    if drive is None:
        return os.path.join(c["dir"], rel)
    local = Path(cache_dir()) / rel
    _fetch(drive, rel, local)
    return str(local)


def _fetch(drive: _Drive, rel: str, local: Path) -> None:
    entry = drive.entry(rel)
    if entry is None:
        raise DataError(f"nothing called {rel} in the data place")
    if entry["mimeType"] == FOLDER_MIME:
        for sub, f in drive.tree(rel):
            target = local / sub
            if target.exists() and target.stat().st_size == int(f.get("size") or 0) and _md5(target) == f.get("md5Checksum"):
                continue
            drive.download(f["id"], target)
    else:
        if local.exists() and _md5(local) == entry.get("md5Checksum"):
            return
        drive.download(entry["id"], local)


def save(local: str, name: str | None = None, evict: bool = False) -> str:
    """A file or a folder put in the data place under `name` (the local path's relative name by default); `evict`
    removes the local copy once it is there. The name it was saved under."""
    src = Path(local)
    if not src.exists():
        raise DataError(f"nothing at {local}")
    inside = str(src.resolve()).startswith(os.getcwd() + os.sep)
    rel = _clean(name or (os.path.relpath(src.resolve(), os.getcwd()) if inside else src.name))
    c, drive = _place()
    if drive is None:
        dest = Path(c["dir"]) / rel
        if src.resolve() != dest.resolve():
            if src.is_dir():
                shutil.copytree(src, dest, dirs_exist_ok=True)
            else:
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dest)
    else:
        for file, sub in _files(src):
            drive.upload(file, f"{rel}/{sub}" if sub else rel)
    # Evicted only once it is elsewhere: never the file itself when the place is this very folder.
    same_place = drive is None and src.resolve() == (Path(c["dir"]) / rel).resolve()
    if evict and not same_place:
        if src.is_dir():
            shutil.rmtree(src, ignore_errors=True)
        else:
            try:
                os.remove(src)
            except OSError:
                pass
    return rel


def _files(src: Path):
    if src.is_file():
        yield src, ""
        return
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in SKIP]
        for f in sorted(files):
            full = Path(root) / f
            if full.is_symlink() or f.endswith(".part"):
                continue
            yield full, str(full.relative_to(src)).replace(os.sep, "/")


class Sync:
    """A folder kept in the data place: pushed on a cadence in the background, and at exit. Only changed files go."""

    def __init__(self, folder: str, name: str | None, every_minutes: float):
        self.folder = Path(folder)
        self.name = _clean(name or os.path.relpath(self.folder, os.getcwd()))
        self.every = every_minutes
        self.sent: dict[str, tuple[int, float]] = {}
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.last_error: str | None = None
        self.thread = threading.Thread(target=self._loop, name="koios-data-sync", daemon=True)
        self.thread.start()
        atexit.register(self.close)

    def _loop(self) -> None:
        while not self.stop.wait(max(30.0, self.every * 60)):
            self.now()

    def now(self) -> int:
        """Pushes what changed since the last push. How many files went."""
        if not self.folder.exists():
            return 0
        sent = 0
        with self.lock:
            try:
                c, drive = _place()
                for file, sub in _files(self.folder):
                    stat = file.stat()
                    mark = (stat.st_size, stat.st_mtime)
                    if self.sent.get(sub) == mark:
                        continue
                    rel = f"{self.name}/{sub}"
                    if drive is None:
                        dest = Path(c["dir"]) / rel
                        if file.resolve() != dest.resolve():
                            dest.parent.mkdir(parents=True, exist_ok=True)
                            shutil.copy2(file, dest)
                    else:
                        drive.upload(file, rel)
                    self.sent[sub] = mark
                    sent += 1
                self.last_error = None
            except DataError as error:
                self.last_error = str(error)
                print(f"[koios_data] sync of {self.folder}: {error}", file=sys.stderr, flush=True)
        return sent

    def close(self) -> None:
        if self.stop.is_set():
            return
        self.stop.set()
        try:
            self.now()
        except Exception:
            pass


_syncs: dict[str, Sync] = {}


def sync(folder: str, name: str | None = None, every_minutes: float = 3.0) -> Sync | None:
    """The folder pushed to the data place every `every_minutes` and at exit; None (and nothing done) when no data
    place is set. One Sync a folder."""
    if not enabled():
        return None
    key = os.path.abspath(folder)
    if key not in _syncs:
        _syncs[key] = Sync(folder, name, every_minutes)
    return _syncs[key]


def ls(prefix: str = "") -> list[dict]:
    """What is in the data place under prefix: [{path, size}]."""
    c, drive = _place()
    rel = _clean(prefix) if prefix.strip("/") else ""
    if drive is None:
        base = Path(c["dir"]) / rel
        return [{"path": f"{rel}/{sub}" if rel else sub, "size": file.stat().st_size} for file, sub in _files(base)] if base.exists() else []
    return [{"path": f"{rel}/{sub}" if rel else sub, "size": int(f.get("size") or 0)} for sub, f in drive.tree(rel)]


# --------------------------------------------------------------------- CLI --


def main(argv: list[str]) -> int:
    command = argv[0] if argv else "where"
    if command == "where":
        print(where())
        return 0
    try:
        if command == "ls":
            for item in ls(argv[1] if len(argv) > 1 else ""):
                print(f"{item['size']:>12}  {item['path']}")
        elif command == "get" and len(argv) > 1:
            print(fetch(argv[1]))
        elif command == "put" and len(argv) > 1:
            print(save(argv[1], argv[2] if len(argv) > 2 else None))
        elif command == "sync" and len(argv) > 1:
            s = sync(argv[1], argv[2] if len(argv) > 2 else None)
            if s is None:
                print(where())
                return 1
            print(f"{s.now()} files sent · {where()}")
            s.stop.set()
        else:
            print(__doc__)
            return 2
    except DataError as error:
        print(f"koios_data: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
