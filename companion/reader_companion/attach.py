"""A folder on one of your computers, attached on another as a disk of its own (from 0.20.0).

Computer A shares a folder (mount.share_folder: its own key, served on A's mount socket through A's Cloudflare
tunnel). Computer B attaches it: a daemon here dials A's socket and shows the folder as a disk, the best way this
system has:

  fuse    — a real filesystem: libfuse on Linux; FUSE-T or macFUSE on a Mac; WinFsp on Windows (a drive letter).
  webdav  — no driver: a WebDAV server on 127.0.0.1 here, mounted by the system's own client — Finder's network
            drives on a Mac (mount_webdav), a mapped network drive on Windows (net use), GNOME's gio on Linux.

Like a network drive, nothing is copied ahead (cache "used", the default): a folder is listed when it is opened, a
file's pieces (1 MB blocks) are fetched when they are read, and kept. "all" fetches the rest in the background, so
the disk keeps working when A sleeps; "none" keeps nothing between opens. A's changes are pushed as they happen for
the folders open here. A file written here goes back to A when it is closed. What a system scatters on any disk it
mounts — Finder's ._ files and .DS_Store, Windows' Thumbs.db — stays here.

    python -m reader_companion.attach serve --id <id>          # the daemon (started by start(), not by hand)

The Companion's routes (extension.py: companion/share on A, companion/attach on B) and `reader-companion share` /
`reader-companion attach` drive it.
"""

from __future__ import annotations

import argparse
import base64
import errno
import hashlib
import html
import io
import json
import os
import platform
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .koios_mount import AWAY_WAIT_S, PIECE, Gone, Refused, Wire, compile_rules, matches, safe, write_json

BLOCK = 1024 * 1024
# What every system writes on any disk it mounts, and keeps to itself: never sent to the computer the folder is on.
LOCAL_ONLY = "._*\n.DS_Store\n.Spotlight-V100/\n.Trashes/\n.fseventsd/\n.TemporaryItems/\n.metadata_never_index*\nThumbs.db\ndesktop.ini\n*.koios-part*\n"
CACHES = ("used", "all", "none")
FILL_TOTAL_MAX = 4 * 1024**3
SYSTEM = platform.system()


def home() -> Path:
    from . import state

    return state.config_dir() / "attached"


def attach_id(url: str, key: str) -> str:
    return hashlib.sha256(f"{url}|{key}".encode()).hexdigest()[:12]


# ------------------------------------------------------------------ processes --


def alive(pid: int) -> bool:
    """Whether a process is running: gone and zombies are not. On Windows os.kill(pid, 0) would end it, so not that."""
    if not pid:
        return False
    if SYSTEM == "Windows":
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, int(pid))  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        kernel32.CloseHandle(handle)
        return bool(ok) and code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().rsplit(")", 1)[1].split()[0] != "Z"
    except (OSError, IndexError):
        return True


def end(pid: int) -> None:
    if not alive(pid):
        return
    try:
        os.kill(pid, signal.SIGTERM)  # TerminateProcess on Windows
    except OSError:
        pass


# ------------------------------------------------------------------ the disk --


class Disk:
    """The shared folder as this computer sees it: folders listed when opened and kept current by A's pushes, file
    pieces fetched when read and kept (by the cache policy), files written here sent back when closed."""

    def __init__(self, url: str, key: str, state: Path, cache: str = "used", say=print):
        self.state, self.cache_policy, self.say = state, cache if cache in CACHES else "used", say
        self.cache = state / "cache"
        self.local = state / "local"
        self.cache.mkdir(parents=True, exist_ok=True)
        self.local.mkdir(parents=True, exist_ok=True)
        self.local_only = compile_rules(LOCAL_ONLY)
        self.dirs: dict[str, dict] = {}
        self.stale: set[str] = set()
        self.have: dict[str, list] = self._load("have.json") if self.cache_policy != "none" else {}
        self.blocks: dict[str, tuple] = {}
        self.dirty: set[str] = set(self._load("dirty.json") or [])
        self.writing: dict[str, int] = {}
        self.lock = threading.RLock()
        self.list_locks: dict[str, threading.Lock] = {}
        self.fetch_locks: dict[str, threading.Lock] = {}
        self.label, self.name = "the other computer", "shared folder"
        self.ready = threading.Event()
        self.away_since = 0.0
        self.counts = {"listed": 0, "read": 0, "bytes_in": 0, "written": 0, "pushed": 0}
        self.fill = {"files": 0, "bytes": 0, "done": False, "running": False}
        self.space = (0, 0, 0.0)
        self.started = time.time()
        self.wire = Wire(url, key, self.on_push, self.on_state)
        self.on_status = lambda: None

    # -- small things --

    def _load(self, name: str):
        try:
            return json.loads((self.state / name).read_text())
        except (OSError, ValueError):
            return {}

    def save(self) -> None:
        if self.cache_policy != "none":
            write_json(self.state / "have.json", dict(self.have))
        write_json(self.state / "dirty.json", sorted(self.dirty))

    def is_local(self, rel: str) -> bool:
        return bool(rel) and matches(self.local_only, rel)

    def cpath(self, rel: str) -> Path:
        return self.cache / rel

    def lpath(self, rel: str) -> Path:
        return self.local / rel

    # -- what A pushes --

    def on_state(self, up: bool) -> None:
        if up:
            self.away_since = 0.0
            with self.lock:
                # A new socket: A watches nothing for it yet. Each folder is listed again the next time it is looked at.
                self.stale.update(self.dirs)
            threading.Thread(target=self.flush_dirty, daemon=True).start()
        elif not self.away_since:
            self.away_since = time.time()
            self.say(f"{self.label} can't be reached: what is here can still be read; writes wait")
        self.on_status()

    def on_push(self, header: dict, payload: bytes) -> None:
        op = header.get("op")
        if op == "hello":
            self.label = header.get("label") or self.label
            self.name = header.get("name") or self.name
            self.ready.set()
            if self.cache_policy == "all":
                self.start_fill()
        elif op == "entries":
            self.apply(header.get("dir") or "", header.get("changed") or {}, header.get("gone") or [])
            self.counts["pushed"] += 1
        self.on_status()

    def apply(self, rel_dir: str, changed: dict, gone: list) -> None:
        with self.lock:
            entries = self.dirs.get(rel_dir)
            if entries is None:
                return
            for name, entry in changed.items():
                rel = f"{rel_dir}/{name}" if rel_dir else name
                if rel in self.dirty:
                    continue
                entries[name] = entry
                if entry[0] == "f" and self.have.get(rel) != entry[1:3]:
                    self.drop_cached(rel)
            for name in gone:
                rel = f"{rel_dir}/{name}" if rel_dir else name
                if rel in self.dirty:
                    continue
                entries.pop(name, None)
                self.drop_cached(rel)
                self.dirs.pop(rel, None)

    # -- listing --

    def listdir(self, rel_dir: str) -> dict:
        """A folder's entries (name → [kind, size, mtime_ns, mode]): as last listed and kept current, or listed now."""
        with self.lock:
            if rel_dir in self.dirs and rel_dir not in self.stale:
                return self.dirs[rel_dir]
            known = self.dirs.get(rel_dir)
        lock = self.list_locks.setdefault(rel_dir, threading.Lock())
        with lock:
            with self.lock:
                if rel_dir in self.dirs and rel_dir not in self.stale:
                    return self.dirs[rel_dir]
            try:
                # With a listing to fall back on, A away costs a moment, not the wait for it.
                reply, _ = self.wire.call({"op": "list", "path": rel_dir}, wait=3 if known is not None else AWAY_WAIT_S)
            except Gone:
                if known is not None:
                    return known
                raise
            entries = reply.get("entries") or {}
            with self.lock:
                # Written here and not yet there: still here.
                for rel in self.dirty:
                    parent, _, name = rel.rpartition("/")
                    if parent == rel_dir and name not in entries and self.cpath(rel).exists():
                        st = self.cpath(rel).stat()
                        entries[name] = ["f", st.st_size, st.st_mtime_ns, 0o644]
                self.dirs[rel_dir] = entries
                self.stale.discard(rel_dir)
                self.counts["listed"] += 1
            return entries

    def lookup(self, rel: str):
        """The entry for a path — [kind, size, mtime_ns, mode] — or None."""
        if not rel:
            return ["d", 0, int(self.started * 1e9), 0o755]
        parent, _, name = rel.rpartition("/")
        if parent and self.lookup(parent) is None:
            return None
        return self.listdir(parent).get(name)

    def put_entry(self, rel: str, entry) -> None:
        parent, _, name = rel.rpartition("/")
        with self.lock:
            if parent in self.dirs:
                if entry is None:
                    self.dirs[parent].pop(name, None)
                else:
                    self.dirs[parent][name] = entry

    # -- reading --

    def drop_cached(self, rel: str) -> None:
        with self.lock:
            self.have.pop(rel, None)
            self.blocks.pop(rel, None)
            try:
                self.cpath(rel).unlink()
            except OSError:
                pass

    def current(self, rel: str, entry) -> bool:
        return rel in self.dirty or (self.have.get(rel) == entry[1:3] and self.cpath(rel).exists())

    def read(self, rel: str, offset: int, size: int) -> bytes:
        """Bytes of a file: from the cache, or its missing blocks fetched first (whole blocks, kept)."""
        entry = self.lookup(rel)
        if entry is None or entry[0] != "f":
            raise Refused(errno.ENOENT, rel)
        length = entry[1] if rel not in self.dirty else self.cpath(rel).stat().st_size
        if offset >= length or size <= 0:
            return b""
        size = min(size, length - offset)
        if self.cache_policy == "none" and rel not in self.dirty:
            reply, data = self.wire.call({"op": "read", "path": rel, "offset": offset, "size": size}, wait=AWAY_WAIT_S)
            self.counts["read"] += 1
            self.counts["bytes_in"] += len(data)
            return data
        if not self.current(rel, entry):
            self.fetch_range(rel, entry, offset, size)
        with open(self.cpath(rel), "rb") as f:
            f.seek(offset)
            return f.read(size)

    def fetch_range(self, rel: str, entry, offset: int, size: int) -> None:
        lock = self.fetch_locks.setdefault(rel, threading.Lock())
        with lock:
            sig = (entry[1], entry[2])
            with self.lock:
                known = self.blocks.get(rel)
                if known is None or known[0] != sig:
                    known = (sig, set())
                    self.blocks[rel] = known
                    target = self.cpath(rel)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with open(target, "wb") as f:
                        f.truncate(entry[1])
            have = known[1]
            first, last = offset // BLOCK, (offset + size - 1) // BLOCK
            missing = [i for i in range(first, last + 1) if i not in have]
            run: list[int] = []
            for i in missing + [None]:
                if i is not None and (not run or (i == run[-1] + 1 and len(run) * BLOCK < PIECE)):
                    run.append(i)
                    continue
                if run:
                    start = run[0] * BLOCK
                    want = min(len(run) * BLOCK, entry[1] - start)
                    reply, data = self.wire.call({"op": "read", "path": rel, "offset": start, "size": want}, wait=AWAY_WAIT_S)
                    st = reply.get("stat") or []
                    if st and (st[0], st[1]) != sig:
                        # Changed on A as it was read: the listing is told so, and the read starts over.
                        self.put_entry(rel, ["f", st[0], st[1], st[2] if len(st) > 2 else 0o644])
                        self.drop_cached(rel)
                        raise Refused(errno.EAGAIN, f"{rel} changed as it was read")
                    with open(self.cpath(rel), "r+b") as f:
                        f.seek(start)
                        f.write(data)
                    have.update(run)
                    self.counts["read"] += 1
                    self.counts["bytes_in"] += len(data)
                run = [i] if i is not None else []
            if len(have) * BLOCK >= entry[1] or len(have) >= (entry[1] + BLOCK - 1) // BLOCK:
                with self.lock:
                    self.have[rel] = list(sig)
                    self.save()

    def fetch_all(self, rel: str) -> None:
        entry = self.lookup(rel)
        if entry is None:
            raise Refused(errno.ENOENT, rel)
        if entry[1] and not self.current(rel, entry):
            self.fetch_range(rel, entry, 0, entry[1])
        elif not entry[1] and not self.cpath(rel).exists():
            self.cpath(rel).parent.mkdir(parents=True, exist_ok=True)
            self.cpath(rel).write_bytes(b"")
            with self.lock:
                self.have[rel] = [entry[1], entry[2]]

    # -- writing --

    def begin_write(self, rel: str, truncate: bool) -> Path:
        """A file about to be written here: its cache copy whole (or emptied), marked as not yet sent."""
        target = self.cpath(rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        if truncate or self.lookup(rel) is None:
            with open(target, "wb"):
                pass
        else:
            self.fetch_all(rel)
        with self.lock:
            self.dirty.add(rel)
            self.writing[rel] = self.writing.get(rel, 0) + 1
            self.save()
            if self.lookup(rel) is None:
                self.put_entry(rel, ["f", 0, time.time_ns(), 0o644])
        return target

    def end_write(self, rel: str) -> None:
        with self.lock:
            left = self.writing.get(rel, 1) - 1
            if left > 0:
                self.writing[rel] = left
                return
            self.writing.pop(rel, None)
            if rel not in self.dirty:
                return  # sent already, when it was closed
        try:
            self.upload(rel)
        except (Gone, Refused) as error:
            self.say(f"{rel} not sent yet: {error}")

    def upload(self, rel: str) -> None:
        source = self.cpath(rel)
        try:
            size = source.stat().st_size
        except OSError:
            with self.lock:
                self.dirty.discard(rel)
            return
        if not self.wire.up.is_set():
            raise Gone(self.wire.error or "the other computer can't be reached now")
        offset, reply = 0, {}
        with open(source, "rb") as f:
            while True:
                piece = f.read(PIECE)
                last = offset + len(piece) >= size
                reply, _ = self.wire.call({"op": "write", "path": rel, "offset": offset, "last": last}, piece)
                offset += len(piece)
                if last:
                    break
        st = reply.get("stat")
        with self.lock:
            self.dirty.discard(rel)
            if st:
                self.have[rel] = [st[0], st[1]]
                self.blocks.pop(rel, None)
                self.put_entry(rel, ["f", st[0], st[1], st[2] if len(st) > 2 else 0o644])
            self.counts["written"] += 1
            self.save()
        self.on_status()

    def flush_dirty(self) -> None:
        for rel in sorted(self.dirty):
            if rel in self.writing:
                continue
            try:
                self.upload(rel)
            except (Gone, Refused) as error:
                self.say(f"{rel} not sent yet: {error}")
                return

    # -- changes to the folder --

    def remove(self, rel: str) -> None:
        entry = self.lookup(rel)
        if entry is None:
            raise Refused(errno.ENOENT, rel)
        self.wire.call({"op": "rmtree" if entry[0] == "d" else "unlink", "path": rel})
        with self.lock:
            self.put_entry(rel, None)
            self.dirty.discard(rel)
            for gone in [d for d in self.dirs if d == rel or d.startswith(rel + "/")]:
                self.dirs.pop(gone, None)
            self.drop_cached(rel)
            shutil.rmtree(self.cpath(rel), ignore_errors=True) if self.cpath(rel).is_dir() else None
            self.save()

    def rmdir(self, rel: str) -> None:
        self.wire.call({"op": "rmdir", "path": rel})
        with self.lock:
            self.put_entry(rel, None)
            self.dirs.pop(rel, None)

    def mkdir(self, rel: str) -> None:
        self.wire.call({"op": "mkdir", "path": rel})
        self.put_entry(rel, ["d", 0, time.time_ns(), 0o755])
        with self.lock:
            self.dirs.setdefault(rel, {})

    def rename(self, a: str, b: str) -> None:
        if a in self.dirty:
            self.upload(a)
        self.wire.call({"op": "rename", "path": a, "to": b})
        with self.lock:
            entry = self.lookup(a)
            self.put_entry(a, None)
            if entry is not None:
                self.put_entry(b, entry)
            if self.cpath(a).exists():
                self.cpath(b).parent.mkdir(parents=True, exist_ok=True)
                os.replace(self.cpath(a), self.cpath(b))
                if a in self.have:
                    self.have[b] = self.have.pop(a)
            self.blocks.pop(a, None)
            for d in [d for d in self.dirs if d == a or d.startswith(a + "/")]:
                self.dirs[b + d[len(a):]] = self.dirs.pop(d)
            self.save()

    def copy(self, a: str, b: str) -> None:
        self.wire.call({"op": "copy", "path": a, "to": b})
        parent = b.rpartition("/")[0]
        with self.lock:
            self.stale.add(parent)

    def chmod(self, rel: str, mode: int) -> None:
        reply, _ = self.wire.call({"op": "chmod", "path": rel, "mode": mode})
        st = reply.get("stat")
        if st:
            self.put_entry(rel, ["f", st[0], st[1], st[2]])

    def statfs(self) -> tuple:
        if time.time() - self.space[2] > 30:
            try:
                reply, _ = self.wire.call({"op": "statfs"}, wait=2)
                self.space = (reply.get("total") or 0, reply.get("free") or 0, time.time())
            except (Gone, Refused):
                pass
        return self.space[0], self.space[1]

    # -- everything, in the background (cache "all") --

    def start_fill(self) -> None:
        if self.fill["running"]:
            return
        self.fill["running"] = True
        threading.Thread(target=self._fill, daemon=True, name="koios-fill").start()

    def _fill(self) -> None:
        try:
            total, count, queue = 0, 0, [""]
            while queue and total < FILL_TOTAL_MAX:
                rel_dir = queue.pop(0)
                try:
                    entries = dict(self.listdir(rel_dir))
                except (Gone, Refused):
                    return
                for name, entry in sorted(entries.items(), key=lambda kv: kv[1][1]):
                    rel = f"{rel_dir}/{name}" if rel_dir else name
                    if entry[0] == "d":
                        queue.append(rel)
                    elif total + entry[1] <= FILL_TOTAL_MAX and not self.current(rel, entry):
                        try:
                            self.fetch_all(rel)
                        except Gone:
                            return
                        except Refused:
                            continue
                        total += entry[1]
                        count += 1
                        self.fill.update(files=count, bytes=total)
            self.fill["done"] = True
        finally:
            self.fill["running"] = False
            self.on_status()

    def status(self) -> dict:
        return {
            "connected": self.wire.up.is_set(), "ready": self.ready.is_set(), "error": self.wire.error, "label": self.label, "name": self.name,
            "cache": self.cache_policy, "listed": len(self.dirs), "cachedFiles": len(self.have), "waitingToWrite": len(self.dirty),
            "awaySince": self.away_since, "rttMs": round(self.wire.rtt_ms, 1), "counts": self.counts, "fill": {k: v for k, v in self.fill.items() if k != "running"},
        }


# ------------------------------------------------------------------ fuse --


def fuse_library_env() -> dict:
    """Where fusepy should look for the FUSE library: FUSE-T's on a Mac when it is there (fusepy looks for macFUSE's)."""
    if SYSTEM == "Darwin" and not os.environ.get("FUSE_LIBRARY_PATH"):
        for candidate in ("/usr/local/lib/libfuse-t.dylib", "/opt/homebrew/lib/libfuse-t.dylib"):
            if os.path.exists(candidate):
                return {"FUSE_LIBRARY_PATH": candidate}
    return {}


def fuse_ops(disk: Disk):
    from fuse import FuseOSError, Operations

    uid = os.getuid() if hasattr(os, "getuid") else 0
    gid = os.getgid() if hasattr(os, "getgid") else 0

    def as_stat(entry) -> dict:
        mtime = entry[2] / 1e9
        mode = (stat.S_IFDIR if entry[0] == "d" else stat.S_IFREG) | (entry[3] or (0o755 if entry[0] == "d" else 0o644))
        return {"st_mode": mode, "st_nlink": 2 if entry[0] == "d" else 1, "st_size": entry[1], "st_mtime": mtime, "st_atime": mtime, "st_ctime": mtime, "st_uid": uid, "st_gid": gid}

    def rel_of(path: str) -> str:
        return path.replace("\\", "/").strip("/")

    class Ops(Operations):
        """The attached folder as a filesystem. (No attribute here is named after a FUSE operation but the operations
        themselves: fusepy takes any such attribute for that operation.)"""

        def __init__(self):
            self.guard = threading.RLock()
            self.handles: dict[int, tuple] = {}  # fh → (rel, os fd or None, writing)
            self.next_fh = 10

        def __call__(self, op, *args):
            try:
                return super().__call__(op, *args)
            except Refused as error:
                raise FuseOSError(error.code) from None
            except Gone:
                raise FuseOSError(errno.EIO) from None
            except FileNotFoundError:
                raise FuseOSError(errno.ENOENT) from None
            except OSError as error:
                raise FuseOSError(error.errno or errno.EIO) from None

        def new_handle(self, rel, fd, writing) -> int:
            with self.guard:
                self.next_fh += 1
                self.handles[self.next_fh] = (rel, fd, writing)
                return self.next_fh

        def getattr(self, path, fh=None):
            rel = rel_of(path)
            if disk.is_local(rel):
                st = os.lstat(disk.lpath(rel))
                return {k: getattr(st, k) for k in ("st_mode", "st_size", "st_mtime", "st_atime", "st_ctime", "st_nlink", "st_uid", "st_gid")}
            entry = disk.lookup(rel)
            if entry is None:
                raise FuseOSError(errno.ENOENT)
            if rel in disk.dirty and disk.cpath(rel).exists():
                entry = ["f", disk.cpath(rel).stat().st_size, entry[2], entry[3]]
            return as_stat(entry)

        def readdir(self, path, fh):
            rel = rel_of(path)
            names = set(disk.listdir(rel))
            if disk.lpath(rel).is_dir():
                names.update(n for n in os.listdir(disk.lpath(rel)) if disk.is_local(f"{rel}/{n}" if rel else n))
            return [".", ".."] + sorted(names)

        def statfs(self, path):
            total, free = disk.statfs()
            bsize = 4096
            return {"f_bsize": bsize, "f_frsize": bsize, "f_blocks": total // bsize, "f_bfree": free // bsize, "f_bavail": free // bsize, "f_files": 1 << 20, "f_ffree": 1 << 20, "f_favail": 1 << 20, "f_namemax": 255}

        def access(self, path, amode):
            self.getattr(path)
            return 0

        def open(self, path, flags):
            rel = rel_of(path)
            if disk.is_local(rel):
                return self.new_handle(rel, os.open(disk.lpath(rel), flags), False)
            entry = disk.lookup(rel)
            if entry is None or entry[0] != "f":
                raise FuseOSError(errno.ENOENT)
            if flags & (os.O_WRONLY | os.O_RDWR):
                target = disk.begin_write(rel, bool(flags & os.O_TRUNC))
                return self.new_handle(rel, os.open(target, os.O_RDWR | getattr(os, "O_BINARY", 0)), True)
            return self.new_handle(rel, None, False)

        def create(self, path, mode, fi=None):
            rel = rel_of(path)
            if disk.is_local(rel):
                disk.lpath(rel).parent.mkdir(parents=True, exist_ok=True)
                return self.new_handle(rel, os.open(disk.lpath(rel), os.O_CREAT | os.O_RDWR | os.O_TRUNC, mode), False)
            target = disk.begin_write(rel, True)
            return self.new_handle(rel, os.open(target, os.O_RDWR | getattr(os, "O_BINARY", 0)), True)

        def read(self, path, size, offset, fh):
            rel, fd, _ = self.handles.get(fh, (rel_of(path), None, False))
            if fd is not None:
                return os.pread(fd, size, offset) if hasattr(os, "pread") else (os.lseek(fd, offset, 0), os.read(fd, size))[1]
            return disk.read(rel, offset, size)

        def write(self, path, data, offset, fh):
            rel, fd, writing = self.handles[fh]
            if writing:
                disk.dirty.add(rel)
            if hasattr(os, "pwrite"):
                return os.pwrite(fd, data, offset)
            os.lseek(fd, offset, 0)
            return os.write(fd, data)

        def truncate(self, path, length, fh=None):
            rel = rel_of(path)
            if disk.is_local(rel):
                return os.truncate(disk.lpath(rel), length)
            target = disk.begin_write(rel, length == 0)
            os.truncate(target, length)
            disk.end_write(rel)
            return 0

        def flush(self, path, fh):
            # close() waits for flush, not for release: so a file is there once the program has closed it.
            rel, fd, writing = self.handles.get(fh, (None, None, False))
            if writing and rel in disk.dirty:
                try:
                    disk.upload(rel)
                except Gone as error:
                    disk.say(f"{rel} not sent yet: {error}")
            return 0

        def fsync(self, path, datasync, fh):
            return 0

        def release(self, path, fh):
            with self.guard:
                rel, fd, writing = self.handles.pop(fh, (None, None, False))
            if fd is not None:
                os.close(fd)
            if writing and rel is not None:
                disk.end_write(rel)
            return 0

        def unlink(self, path):
            rel = rel_of(path)
            if disk.is_local(rel):
                os.unlink(disk.lpath(rel))
                return 0
            disk.remove(rel)
            return 0

        def mkdir(self, path, mode):
            rel = rel_of(path)
            if disk.is_local(rel):
                os.makedirs(disk.lpath(rel), exist_ok=False)
                return 0
            disk.mkdir(rel)
            return 0

        def rmdir(self, path):
            rel = rel_of(path)
            if disk.is_local(rel):
                os.rmdir(disk.lpath(rel))
                return 0
            if set(disk.listdir(rel)):
                raise FuseOSError(errno.ENOTEMPTY)
            disk.rmdir(rel)
            shutil.rmtree(disk.lpath(rel), ignore_errors=True)
            return 0

        def rename(self, old, new):
            a, b = rel_of(old), rel_of(new)
            if disk.is_local(a) and disk.is_local(b):
                disk.lpath(b).parent.mkdir(parents=True, exist_ok=True)
                os.replace(disk.lpath(a), disk.lpath(b))
                return 0
            if disk.is_local(a):
                # An editor's temporary file saved over a real one: it goes there.
                target = disk.begin_write(b, True)
                shutil.copyfile(disk.lpath(a), target)
                os.unlink(disk.lpath(a))
                disk.end_write(b)
                return 0
            disk.rename(a, b)
            return 0

        def chmod(self, path, mode):
            rel = rel_of(path)
            if disk.is_local(rel):
                return os.chmod(disk.lpath(rel), mode)
            disk.chmod(rel, stat.S_IMODE(mode))
            return 0

        def chown(self, path, uid_, gid_):
            return 0

        def utimens(self, path, times=None):
            return 0

    return Ops()


def fuse_check() -> str:
    """Why the fuse backend can't run here, or "" when it can — asked of a fresh Python, so a driver installed since
    the Companion started counts."""
    code = "import fuse"
    try:
        done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=30, env={**os.environ, **fuse_library_env()})
    except (OSError, subprocess.SubprocessError) as error:
        return str(error)
    if done.returncode == 0:
        if SYSTEM == "Linux" and not os.path.exists("/dev/fuse"):
            return "this computer has no /dev/fuse"
        return ""
    words = (done.stderr.strip().splitlines() or ["fusepy isn't installed"])[-1]
    if "No module named" in words:
        return "fusepy isn't installed (pip install fusepy)"
    return {"Darwin": "no FUSE driver: install FUSE-T (or macFUSE)", "Windows": "no FUSE driver: install WinFsp"}.get(SYSTEM, "libfuse 2 isn't installed (sudo apt install libfuse2)")


# ------------------------------------------------------------------ webdav --


def http_date(ns: int) -> str:
    return formatdate(ns / 1e9, usegmt=True)


def iso_date(ns: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ns / 1e9))


class DavServer:
    """The attached folder as a WebDAV share on 127.0.0.1, for the system's own network-drive client. Its address
    carries a secret, so no other program on this computer can wander in by guessing a port."""

    def __init__(self, disk: Disk, secret: str, port: int = 0):
        self.disk, self.secret = disk, secret
        self.prefix = f"/{secret}/"
        server = self

        class Handler(DavHandler):
            dav = server

        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}{self.prefix}"

    def serve(self) -> None:
        threading.Thread(target=self.httpd.serve_forever, daemon=True, name="koios-dav").start()

    def close(self) -> None:
        self.httpd.shutdown()


class DavHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    dav: DavServer = None  # type: ignore[assignment]
    server_version = "KoiosDrive/1"

    def log_message(self, *args) -> None:  # quiet: the daemon's log is for what matters
        return

    # -- helpers --

    def rel(self, raw: str | None = None):
        path = urllib.parse.urlsplit(raw if raw is not None else self.path).path
        if not path.startswith(self.dav.prefix) and path + "/" != self.dav.prefix:
            return None
        rel = urllib.parse.unquote(path[len(self.dav.prefix):]).strip("/")
        if rel and not safe(rel):
            return None
        return rel

    def reply(self, code: int, body: bytes = b"", headers: dict | None = None, content_type: str = "text/plain; charset=utf-8") -> None:
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        if body or code not in (204, 304):
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def fail(self, error: Exception) -> None:
        if isinstance(error, Refused):
            code = {errno.ENOENT: 404, errno.EACCES: 403, errno.EEXIST: 405, errno.ENOTEMPTY: 409, errno.EAGAIN: 503}.get(error.code, 500)
        elif isinstance(error, Gone):
            code = 503
        elif isinstance(error, FileNotFoundError):
            code = 404
        else:
            code = 500
        self.reply(code, str(error).encode())

    def body(self) -> bytes:
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            out = io.BytesIO()
            while True:
                size = int(self.rfile.readline().strip().split(b";")[0] or b"0", 16)
                if size == 0:
                    self.rfile.readline()
                    break
                out.write(self.rfile.read(size))
                self.rfile.readline()
            return out.getvalue()
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def entry(self, rel: str):
        disk = self.dav.disk
        if disk.is_local(rel):
            full = disk.lpath(rel)
            if not full.exists():
                return None
            st = full.stat()
            return ["d" if full.is_dir() else "f", st.st_size, st.st_mtime_ns, 0o644]
        entry = disk.lookup(rel)
        if entry is not None and rel in disk.dirty and disk.cpath(rel).exists():
            entry = ["f", disk.cpath(rel).stat().st_size, entry[2], entry[3]]
        return entry

    def href(self, rel: str, is_dir: bool) -> str:
        quoted = urllib.parse.quote(rel) if rel else ""
        return self.dav.prefix + quoted + ("/" if is_dir and rel else "")

    def props(self, rel: str, entry) -> str:
        is_dir = entry[0] == "d"
        name = html.escape(rel.rpartition("/")[2] or self.dav.disk.name)
        parts = [f"<D:displayname>{name}</D:displayname>", f"<D:getlastmodified>{http_date(entry[2])}</D:getlastmodified>", f"<D:creationdate>{iso_date(entry[2])}</D:creationdate>"]
        if is_dir:
            parts.append("<D:resourcetype><D:collection/></D:resourcetype>")
            if not rel:
                total, free = self.dav.disk.statfs()
                if total:
                    parts.append(f"<D:quota-available-bytes>{free}</D:quota-available-bytes><D:quota-used-bytes>{total - free}</D:quota-used-bytes>")
        else:
            parts.append("<D:resourcetype/>")
            parts.append(f"<D:getcontentlength>{entry[1]}</D:getcontentlength>")
            parts.append("<D:getcontenttype>application/octet-stream</D:getcontenttype>")
            parts.append(f'<D:getetag>"{entry[1]:x}-{entry[2]:x}"</D:getetag>')
        return f"<D:response><D:href>{html.escape(self.href(rel, is_dir))}</D:href><D:propstat><D:prop>{''.join(parts)}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>"

    # -- methods --

    def do_OPTIONS(self):
        self.reply(200, headers={"DAV": "1, 2", "MS-Author-Via": "DAV", "Allow": "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK"})

    def do_PROPFIND(self):
        rel = self.rel()
        self.body()
        if rel is None:
            return self.reply(404)
        try:
            entry = self.entry(rel)
            if entry is None:
                return self.reply(404)
            out = [self.props(rel, entry)]
            if entry[0] == "d" and self.headers.get("Depth", "1") != "0":
                disk = self.dav.disk
                children = dict(disk.listdir(rel)) if not disk.is_local(rel) else {}
                local_dir = disk.lpath(rel)
                if local_dir.is_dir():
                    for n in os.listdir(local_dir):
                        child = f"{rel}/{n}" if rel else n
                        if disk.is_local(child):
                            st = (local_dir / n).stat()
                            children[n] = ["d" if (local_dir / n).is_dir() else "f", st.st_size, st.st_mtime_ns, 0o644]
                for name, child in sorted(children.items()):
                    out.append(self.props(f"{rel}/{name}" if rel else name, child))
        except Exception as error:
            return self.fail(error)
        body = ('<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">' + "".join(out) + "</D:multistatus>").encode()
        self.reply(207, body, content_type="application/xml; charset=utf-8")

    def do_PROPPATCH(self):
        rel = self.rel()
        self.body()
        if rel is None:
            return self.reply(404)
        body = f'<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>{html.escape(self.href(rel, False))}</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>'.encode()
        self.reply(207, body, content_type="application/xml; charset=utf-8")

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        rel = self.rel()
        if rel is None:
            return self.reply(404)
        disk = self.dav.disk
        try:
            entry = self.entry(rel)
            if entry is None:
                return self.reply(404)
            if entry[0] == "d":
                names = "".join(f'<li><a href="{html.escape(urllib.parse.quote(n))}{"/" if e[0] == "d" else ""}">{html.escape(n)}</a></li>' for n, e in sorted(disk.listdir(rel).items()))
                return self.reply(200, f"<ul>{names}</ul>".encode(), content_type="text/html; charset=utf-8")
            size = entry[1]
            start, end_ = 0, size - 1
            ranged = re.match(r"bytes=(\d*)-(\d*)$", self.headers.get("Range", ""))
            if ranged and size:
                a, b = ranged.groups()
                if a == "":
                    start, end_ = max(0, size - int(b)), size - 1
                else:
                    start, end_ = int(a), min(size - 1, int(b) if b else size - 1)
                if start > end_:
                    return self.reply(416, headers={"Content-Range": f"bytes */{size}"})
            length = max(0, end_ - start + 1) if size else 0
            self.send_response(206 if ranged and size else 200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Last-Modified", http_date(entry[2]))
            self.send_header("ETag", f'"{entry[1]:x}-{entry[2]:x}"')
            if ranged and size:
                self.send_header("Content-Range", f"bytes {start}-{end_}/{size}")
            self.end_headers()
            if self.command == "HEAD":
                return
            at = start
            while at <= end_ and length:
                piece = min(BLOCK, end_ - at + 1)
                if disk.is_local(rel):
                    with open(disk.lpath(rel), "rb") as f:
                        f.seek(at)
                        data = f.read(piece)
                else:
                    data = disk.read(rel, at, piece)
                if not data:
                    break
                self.wfile.write(data)
                at += len(data)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as error:
            return self.fail(error)

    def do_PUT(self):
        rel = self.rel()
        if not rel:
            return self.reply(403)
        disk = self.dav.disk
        try:
            data = self.body()
            existed = self.entry(rel) is not None
            if disk.is_local(rel):
                disk.lpath(rel).parent.mkdir(parents=True, exist_ok=True)
                disk.lpath(rel).write_bytes(data)
            else:
                target = disk.begin_write(rel, True)
                target.write_bytes(data)
                disk.end_write(rel)
        except Exception as error:
            return self.fail(error)
        self.reply(204 if existed else 201)

    def do_DELETE(self):
        rel = self.rel()
        if not rel:
            return self.reply(403)
        disk = self.dav.disk
        try:
            if disk.is_local(rel):
                full = disk.lpath(rel)
                shutil.rmtree(full) if full.is_dir() else full.unlink()
            else:
                disk.remove(rel)
        except Exception as error:
            return self.fail(error)
        self.reply(204)

    def do_MKCOL(self):
        rel = self.rel()
        self.body()
        if not rel:
            return self.reply(405)
        disk = self.dav.disk
        try:
            if self.entry(rel) is not None:
                return self.reply(405)
            parent = rel.rpartition("/")[0]
            if parent and self.entry(parent) is None:
                return self.reply(409)
            if disk.is_local(rel):
                disk.lpath(rel).mkdir(parents=True, exist_ok=True)
            else:
                disk.mkdir(rel)
        except Exception as error:
            return self.fail(error)
        self.reply(201)

    def destination(self):
        raw = self.headers.get("Destination", "")
        return self.rel(raw) if raw else None

    def do_MOVE(self):
        self.move_or_copy(move=True)

    def do_COPY(self):
        self.move_or_copy(move=False)

    def move_or_copy(self, move: bool) -> None:
        a, b = self.rel(), self.destination()
        if not a or not b:
            return self.reply(400 if b is None else 403)
        disk = self.dav.disk
        try:
            exists = self.entry(b) is not None
            if exists and self.headers.get("Overwrite", "T").upper() == "F":
                return self.reply(412)
            if exists and move:
                if disk.is_local(b):
                    full = disk.lpath(b)
                    shutil.rmtree(full) if full.is_dir() else full.unlink()
                else:
                    disk.remove(b)
            if disk.is_local(a) or disk.is_local(b):
                # Finder's own files, or one of them saved over a real one: through the local copy.
                source = disk.lpath(a) if disk.is_local(a) else None
                data = source.read_bytes() if source is not None else disk.read(a, 0, 1 << 62)
                if disk.is_local(b):
                    disk.lpath(b).parent.mkdir(parents=True, exist_ok=True)
                    disk.lpath(b).write_bytes(data)
                else:
                    target = disk.begin_write(b, True)
                    target.write_bytes(data)
                    disk.end_write(b)
                if move:
                    source.unlink() if source is not None else disk.remove(a)
            elif move:
                disk.rename(a, b)
            else:
                disk.copy(a, b)
        except Exception as error:
            return self.fail(error)
        self.reply(204 if exists else 201)

    def do_LOCK(self):
        rel = self.rel()
        self.body()
        token = self.headers.get("If", "")
        found = re.search(r"<(opaquelocktoken:[^>]+)>", token)
        token = found.group(1) if found else f"opaquelocktoken:{uuid.uuid4()}"
        body = (
            '<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>'
            "<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>0</D:depth>"
            f"<D:timeout>Second-3600</D:timeout><D:locktoken><D:href>{token}</D:href></D:locktoken>"
            f"<D:lockroot><D:href>{html.escape(self.href(rel or '', False))}</D:href></D:lockroot>"
            "</D:activelock></D:lockdiscovery></D:prop>"
        ).encode()
        self.reply(200, body, headers={"Lock-Token": f"<{token}>"}, content_type="application/xml; charset=utf-8")

    def do_UNLOCK(self):
        self.reply(204)


# ------------------------------------------------------------------ mounting --


def drives_dir() -> Path:
    return Path.home() / "Koios Drives"


def clean_label(text: str) -> str:
    text = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "-", text).strip(" .")
    return text[:80] or "Shared folder"


def free_drive_letter() -> str:
    import string

    used = set()
    if SYSTEM == "Windows":
        import ctypes

        mask = ctypes.windll.kernel32.GetLogicalDrives()
        used = {string.ascii_uppercase[i] for i in range(26) if mask >> i & 1}
    for letter in reversed(string.ascii_uppercase[3:]):
        if letter not in used:
            return f"{letter}:"
    raise Refused(errno.ENOSPC, "no free drive letter")


def os_mount(url: str, where: str, label: str) -> str:
    """The WebDAV share mounted by the system's own client. Where it is now: a folder, or a drive letter."""
    if SYSTEM == "Darwin":
        Path(where).mkdir(parents=True, exist_ok=True)
        done = subprocess.run(["mount_webdav", "-S", "-v", label, url, where], capture_output=True, text=True, timeout=60)
        if done.returncode != 0:
            raise Refused(errno.EIO, f"mount_webdav: {done.stderr.strip() or done.returncode}")
        return where
    if SYSTEM == "Windows":
        done = subprocess.run(["net", "use", "*", url, "/persistent:no"], capture_output=True, text=True, timeout=60)
        found = re.search(r"\b([A-Z]:)", done.stdout)
        if done.returncode != 0 or not found:
            raise Refused(errno.EIO, f"net use: {(done.stderr or done.stdout).strip()} — is the WebClient service running? (sc start webclient)")
        return found.group(1)
    if shutil.which("gio"):
        dav = "dav://" + url.split("://", 1)[1]
        done = subprocess.run(["gio", "mount", dav], capture_output=True, text=True, timeout=60)
        if done.returncode != 0:
            raise Refused(errno.EIO, f"gio mount: {done.stderr.strip()}")
        gvfs = Path(f"/run/user/{os.getuid()}/gvfs")
        port = url.split(":")[2].split("/")[0]
        mounted = next((p for p in gvfs.iterdir() if f"port={port}" in p.name), None) if gvfs.is_dir() else None
        if mounted is None:
            raise Refused(errno.EIO, "gio mounted it, but it isn't under /run/user/…/gvfs")
        link = Path(where)
        link.parent.mkdir(parents=True, exist_ok=True)
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(mounted)
        return str(link)
    raise Refused(errno.ENOSYS, "this Linux has no FUSE and no gio to mount a network drive: sudo apt install libfuse2")


def os_unmount(where: str, backend: str, url: str = "") -> None:
    if not where:
        return
    if SYSTEM == "Windows":
        if backend == "webdav":
            subprocess.run(["net", "use", where, "/delete", "/y"], capture_output=True, timeout=30)
        return  # WinFsp lets go when its process ends
    if backend == "webdav" and SYSTEM == "Linux":
        if url and shutil.which("gio"):
            subprocess.run(["gio", "mount", "-u", "dav://" + url.split("://", 1)[1]], capture_output=True, timeout=30)
        if Path(where).is_symlink():
            Path(where).unlink()
        return
    for tool in (["fusermount", "-u", "-z", where], ["fusermount3", "-u", "-z", where], ["umount", where], ["diskutil", "unmount", "force", where]):
        if shutil.which(tool[0]) and os.path.ismount(where):
            subprocess.run(tool, capture_output=True, timeout=30)
    try:
        if Path(where).is_dir() and not any(Path(where).iterdir()):
            Path(where).rmdir()
    except OSError:
        pass


def backends() -> dict:
    """What this computer can attach with, and why not where it can't."""
    why = fuse_check()
    dav = {"Darwin": shutil.which("mount_webdav"), "Windows": shutil.which("net"), "Linux": shutil.which("gio")}.get(SYSTEM)
    return {
        "os": {"Darwin": "mac", "Windows": "windows"}.get(SYSTEM, "linux"),
        "fuse": {"ok": not why, "why": why, "driver": {"Darwin": "FUSE-T", "Windows": "WinFsp"}.get(SYSTEM, "libfuse2")},
        "webdav": {"ok": bool(dav), "why": "" if dav else ("no gio here (GNOME's): install libfuse2 for FUSE instead" if SYSTEM == "Linux" else "the system's WebDAV client isn't here")},
    }


def choose_backend(asked: str) -> str:
    if asked in ("fuse", "webdav"):
        return asked
    found = backends()
    if found["fuse"]["ok"]:
        return "fuse"
    if found["webdav"]["ok"]:
        return "webdav"
    raise Refused(errno.ENOSYS, found["fuse"]["why"])


# ------------------------------------------------------------------ the daemon --


def config_of(ident: str) -> dict:
    return json.loads((home() / ident / "attach.json").read_text())


def status_of(ident: str) -> dict:
    folder = home() / ident
    try:
        config = config_of(ident)
    except (OSError, ValueError):
        return {"id": ident, "running": False}
    try:
        status = json.loads((folder / "status.json").read_text())
    except (OSError, ValueError):
        status = {}
    running = alive(int(status.get("pid") or 0))
    public = {k: v for k, v in config.items() if k not in ("key", "secret")}
    return {**public, **status, "id": ident, "running": running, "mounted": running and bool(status.get("where"))}


def list_all() -> list:
    return [status_of(p.name) for p in sorted(home().iterdir()) if (p / "attach.json").exists()] if home().is_dir() else []


def serve(ident: str) -> None:
    folder = home() / ident
    config = config_of(ident)
    os.chdir(folder)
    log = lambda text: print(time.strftime("%H:%M:%S"), text, flush=True)  # noqa: E731
    disk = Disk(config["url"], config["key"], folder, config.get("cache", "used"), say=log)
    backend = config["backend"]
    extra: dict = {"where": "", "backend": backend}

    def write_status(**more):
        extra.update(more)
        write_json(folder / "status.json", {"pid": os.getpid(), **extra, **disk.status()})

    disk.on_status = write_status
    write_status()
    disk.wire.start()
    if not disk.ready.wait(60):
        write_status(error=disk.wire.error or "the other computer didn't answer")
        log(f"no answer from the share: {disk.wire.error}")
        return
    label = clean_label(config.get("label") or f"{disk.name} on {disk.label}")
    if backend == "fuse":
        from fuse import FUSE

        where = config.get("where") or (free_drive_letter() if SYSTEM == "Windows" else str(drives_dir() / label))
        if SYSTEM != "Windows":
            Path(where).mkdir(parents=True, exist_ok=True)

        def watch():
            deadline = time.time() + 30
            while time.time() < deadline and not (os.path.ismount(where) or (SYSTEM == "Windows" and os.path.exists(where + "\\"))):
                time.sleep(0.1)
            write_status(where=where)
            log(f"attached {disk.name} from {disk.label} at {where} (fuse)")
            while os.path.ismount(where) or (SYSTEM == "Windows" and os.path.exists(where + "\\")):
                time.sleep(0.5)
            write_status(where="", stopped=True)
            os._exit(0)

        threading.Thread(target=watch, daemon=True).start()
        options = {"foreground": True, "nothreads": False, "fsname": f"koios:{label}"[:60]}
        if SYSTEM == "Darwin":
            options["volname"] = label
        elif SYSTEM == "Linux":
            options.update(attr_timeout=1.0, entry_timeout=1.0, big_writes=True)
        FUSE(fuse_ops(disk), where, **options)
        return
    secret = config.get("secret") or secrets.token_urlsafe(16)
    dav = DavServer(disk, secret)
    dav.serve()
    where = os_mount(dav.url, config.get("where") or str(drives_dir() / label), label)
    write_status(where=where, davPort=dav.port)
    log(f"attached {disk.name} from {disk.label} at {where} (webdav)")
    stop = threading.Event()
    try:
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
    except (ValueError, OSError):
        pass
    while not stop.wait(1):
        if (folder / "detach").exists():
            break
        write_status()
    os_unmount(where, "webdav", dav.url)
    write_status(where="", stopped=True)


def start(url: str, key: str, cache: str = "used", backend: str = "auto", label: str = "", source: str = "", where: str = "", wait_s: float = 90) -> dict:
    """The folder attached here (again if it was), and its status once it is mounted or has failed."""
    ident = attach_id(url, key)
    folder = home() / ident
    running = status_of(ident)
    if running.get("running") and running.get("mounted"):
        return {**running, "reused": True}
    stop(ident)
    chosen = choose_backend(backend)
    folder.mkdir(parents=True, exist_ok=True)
    config = {"url": url, "key": key, "cache": cache if cache in CACHES else "used", "backend": chosen, "label": label, "from": source, "where": where, "secret": secrets.token_urlsafe(16), "at": int(time.time() * 1000)}
    write_json(folder / "attach.json", config)
    try:
        os.chmod(folder / "attach.json", 0o600)
    except OSError:
        pass
    for name in ("status.json", "detach"):
        (folder / name).unlink(missing_ok=True)
    kwargs: dict = {"stdout": None, "stderr": None, "stdin": subprocess.DEVNULL, "cwd": str(folder), "env": {**os.environ, **fuse_library_env(), "PYTHONUNBUFFERED": "1"}}
    if SYSTEM == "Windows":
        kwargs["creationflags"] = 0x00000008 | 0x00000200 | 0x08000000  # detached, its own group, no window
    else:
        kwargs["start_new_session"] = True
    with open(folder / "attach.log", "ab") as out:
        kwargs["stdout"] = kwargs["stderr"] = out
        daemon = subprocess.Popen([sys.executable, "-m", "reader_companion.attach", "serve", f"--id={ident}"], **kwargs)
    threading.Thread(target=daemon.wait, daemon=True).start()
    deadline = time.time() + wait_s
    status = {}
    while time.time() < deadline:
        status = status_of(ident)
        if status.get("mounted") or status.get("error") or (status.get("pid") and not status.get("running")):
            break
        time.sleep(0.2)
    try:
        status["log"] = (folder / "attach.log").read_text(errors="replace")[-1500:]
    except OSError:
        pass
    return status


def stop(ident: str, forget: bool = False) -> bool:
    status = status_of(ident)
    folder = home() / ident
    if status.get("where"):
        os_unmount(status["where"], status.get("backend") or "", f"http://127.0.0.1:{status.get('davPort')}/" if status.get("davPort") else "")
    pid = int(status.get("pid") or 0)
    if alive(pid):
        (folder / "detach").write_text("")
        deadline = time.time() + 5
        while alive(pid) and time.time() < deadline:
            time.sleep(0.1)
        end(pid)
    if forget:
        shutil.rmtree(folder, ignore_errors=True)
    return bool(pid)


# ------------------------------------------------------------------ the code --


def attach_code(url: str, key: str, name: str, source: str) -> str:
    """What `reader-companion share` prints and `reader-companion attach` takes: everything needed, in one word."""
    raw = json.dumps({"url": url, "key": key, "name": name, "from": source}, separators=(",", ":")).encode()
    return "koios-attach:" + base64.urlsafe_b64encode(raw).decode().rstrip("=")


def read_code(code: str) -> dict:
    body = code.strip()
    if body.startswith("koios-attach:"):
        body = body[len("koios-attach:"):]
    raw = base64.urlsafe_b64decode(body + "=" * (-len(body) % 4))
    data = json.loads(raw)
    if not str(data.get("url", "")).startswith(("wss://", "ws://")) or not data.get("key"):
        raise ValueError("not an attach code")
    return data


# ------------------------------------------------------------------ drivers --

DRIVERS = {
    "Darwin": ("macos-fuse-t/fuse-t", ".pkg", "FUSE-T"),
    "Windows": ("winfsp/winfsp", ".msi", "WinFsp"),
}


def install_driver(say=print) -> dict:
    """The faster driver's installer, downloaded from its own GitHub releases and opened: the system's installer
    asks for the password (or UAC) and does the rest. On Linux, the command to run."""
    if SYSTEM not in DRIVERS:
        return {"opened": False, "how": "sudo apt install fuse libfuse2   (or your distribution's libfuse2 package)", "name": "libfuse2"}
    import urllib.request

    repo, suffix, name = DRIVERS[SYSTEM]
    with urllib.request.urlopen(urllib.request.Request(f"https://api.github.com/repos/{repo}/releases/latest", headers={"Accept": "application/vnd.github+json"}), timeout=30) as response:
        release = json.loads(response.read())
    asset = next((a for a in release.get("assets") or [] if a.get("name", "").endswith(suffix)), None)
    if asset is None:
        raise Refused(errno.ENOENT, f"{name}'s latest release has no {suffix}")
    target = Path.home() / "Downloads" / asset["name"]
    target.parent.mkdir(parents=True, exist_ok=True)
    say(f"downloading {asset['name']}…")
    with urllib.request.urlopen(asset["browser_download_url"], timeout=300) as response, open(target, "wb") as out:
        shutil.copyfileobj(response, out)
    if SYSTEM == "Darwin":
        subprocess.Popen(["open", str(target)])
    else:
        subprocess.Popen(["msiexec", "/i", str(target)])
    return {"opened": True, "path": str(target), "name": name, "version": release.get("tag_name")}


# ------------------------------------------------------------------ the CLI --


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m reader_companion.attach")
    sub = parser.add_subparsers(dest="command")
    p = sub.add_parser("serve")
    p.add_argument("--id", required=True)
    args = parser.parse_args(argv)
    if args.command == "serve":
        serve(args.id)
        return 0
    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
