"""koios_mount: a project's folder on your computer, mounted on the machine the code runs on — Colab's GPU, a server —
the way Google Drive is mounted in a notebook. Nothing is copied before a run: the code is read where it is, and
what a run writes there is written back where it belongs.

    python koios_mount.py start --url wss://<tunnel>/companion/mount/socket --key <key> --at /content/playgrounds/p
    python koios_mount.py status --at /content/playgrounds/p
    python koios_mount.py stop --at /content/playgrounds/p

How it reaches your computer: one WebSocket to the Koios Companion there, through the Companion's Cloudflare tunnel
(https://<words>.trycloudflare.com), kept open. The machine dials out to Cloudflare's nearest edge, Cloudflare carries
it to the edge nearest your computer, and cloudflared hands it to the Companion: no browser, no page, no Worker in the
way, and nothing on either side has to accept a connection from the internet. The key is for this one folder only —
not the Companion's own token — and works only while the Companion keeps it.

What makes it feel like one disk:

- On connecting, the Companion sends the folder's tree, and the small files (source, configs) come over in a few
  archives, so imports and reads are local from the first second. Anything bigger is fetched the first time it is
  opened, then kept.
- The Companion watches the folder and pushes each change the moment it is saved there — the file itself when it is
  small — so the copy here is current before anything asks for it. Nothing here polls your computer.
- A file written here goes back over the same socket when it is closed, written in place on your computer atomically.

What stays on this machine: whatever the project's sync rules leave out (data/, wandb/, *.pt, *.ckpt, *.safetensors
by default), and caches (__pycache__, .reader/, .ipynb_checkpoints). They live on this machine's own disk under the
mount — written at local speed, never sent through the tunnel — and the data among them (checkpoints, run outputs)
is put in the project's data place by koios_data (Google Drive by default, or a computer of yours), a few seconds
after it is closed. A file over 100 MB written anywhere is kept here and sent to the data place the same way, rather
than through the tunnel.

Two modes. **fuse** (Colab, most servers: /dev/fuse and libfuse 2 — `pip install fusepy`): a real mount, lazy, with a
cache under ~/.koios-mount. **mirror** (where FUSE isn't allowed, as in many containers): the folder is a real
directory kept current both ways over the same socket — every file is here, but edits on your computer still arrive
the moment they are saved, and edits here go back within a second. `--mode auto` (the default) takes fuse when it can.

Standard library, tornado (which every Jupyter server and ipykernel brings), and fusepy for the fuse mode.
"""

from __future__ import annotations

import argparse
import asyncio
import concurrent.futures
import errno
import hashlib
import io
import json
import os
import queue
import re
import shutil
import signal
import stat
import struct
import subprocess
import sys
import tarfile
import threading
import time
import traceback
import urllib.parse
from pathlib import Path

VERSION = 1
# A file this small comes over in the first archives; bigger ones when they are first opened.
WARM_MAX = 2 * 1024 * 1024
# One archive at most this much (before compression), so the first files are usable while the rest come.
PACK_MAX = 8 * 1024 * 1024
# Reads and writes over the socket in pieces this big.
PIECE = 4 * 1024 * 1024
# Bigger than this, a file written here stays here and goes to the data place, not through the tunnel.
BIG = 100 * 1024 * 1024
# Always on this machine's own disk and never sent anywhere: caches and the helpers Koios writes.
SCRATCH = ".git/\n.reader/\nreader-meta/\n__pycache__/\n.ipynb_checkpoints/\n.venv/\nvenv/\nnode_modules/\n.DS_Store\n.koios-data/\n*.koios-part*\n"
# What the Companion never sends, as compute.ALWAYS_SKIP: the same paths are this machine's.
DEFAULT_RULES = "data/\nwandb/\n*.ckpt\n*.pt\n*.safetensors\n"


# ------------------------------------------------------------------ the rules --


def compile_rules(rules: str) -> list:
    """Gitignore-like lines, as the page and the Companion read them (compute.matches_rule), compiled once."""
    out = []
    for raw in rules.split("\n"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        anchored = line.startswith("/")
        body = line.strip("/")
        parts = []
        for part in body.split("/"):
            parts.append(".*" if part == "**" else re.escape(part).replace(r"\*", "[^/]*").replace(r"\?", "[^/]"))
        pattern = "/".join(parts).replace(".*/", "(?:.*/)?")
        lead = "^" if anchored or "/" in body else "^(?:.*/)?"
        out.append(re.compile(f"{lead}{pattern}(?:/.*)?$"))
    return out


def matches(compiled: list, rel: str) -> bool:
    return any(p.match(rel) for p in compiled)


def safe(rel: str) -> bool:
    parts = rel.replace("\\", "/").split("/")
    return bool(rel) and not rel.startswith("/") and ".." not in parts and "" not in parts


# ------------------------------------------------------------------ the wire --


def frame(header: dict, payload: bytes = b"") -> bytes:
    """One message: the header's length, the header as JSON, then the bytes it is about."""
    head = json.dumps(header, separators=(",", ":")).encode()
    return struct.pack(">I", len(head)) + head + payload


def unframe(data: bytes) -> tuple[dict, bytes]:
    (n,) = struct.unpack(">I", data[:4])
    return json.loads(data[4 : 4 + n]), data[4 + n :]


class Gone(Exception):
    """The Companion can't be reached now: the work waits for it, or fails if it is a read nothing here can answer."""


class Refused(Exception):
    def __init__(self, code: int, words: str):
        super().__init__(words)
        self.code = code


class Wire:
    """One WebSocket to the Companion, kept open and opened again when it drops: requests answered by id, and what
    the Companion pushes (the tree, a change) handed to on_push, in order, on a thread of its own."""

    def __init__(self, url: str, key: str, on_push, on_state=lambda up: None):
        self.url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode({"key": key, "v": VERSION})
        self.on_push, self.on_state = on_push, on_state
        self.loop = asyncio.new_event_loop()
        self.pending: dict[int, concurrent.futures.Future] = {}
        self.next_id = 0
        self.lock = threading.Lock()
        self.up = threading.Event()
        self.stopped = False
        self.socket = None
        self.error = ""
        self.pushes: queue.Queue = queue.Queue()
        self.rtt_ms = 0.0

    def start(self) -> None:
        threading.Thread(target=self.loop.run_forever, daemon=True, name="koios-wire").start()
        threading.Thread(target=self._pushes, daemon=True, name="koios-pushes").start()
        asyncio.run_coroutine_threadsafe(self._run(), self.loop)

    def _pushes(self) -> None:
        while True:
            header, payload = self.pushes.get()
            try:
                self.on_push(header, payload)
            except Exception:
                traceback.print_exc()

    async def _run(self) -> None:
        from tornado.websocket import websocket_connect

        wait = 1.0
        while not self.stopped:
            try:
                self.socket = await websocket_connect(self.url, max_message_size=256 * 1024 * 1024, ping_interval=20, ping_timeout=20, connect_timeout=30)
            except Exception as error:
                self.error = f"the Companion can't be reached: {getattr(error, 'code', '')} {error}".strip()
                await asyncio.sleep(wait)
                wait = min(wait * 2, 30)
                continue
            wait = 1.0
            self.error = ""
            self.up.set()
            self.on_state(True)
            while True:
                data = await self.socket.read_message()
                if data is None:
                    break
                if isinstance(data, str):
                    continue
                header, payload = unframe(data)
                fut = self.pending.pop(header.get("id"), None) if "id" in header else None
                if fut is not None:
                    fut.set_result((header, payload))
                else:
                    self.pushes.put((header, payload))
            code = self.socket.close_code
            self.up.clear()
            self.socket = None
            if code == 4403:
                self.error = "the Companion no longer takes this mount's key (it was stopped there): start it again from Koios"
                self.stopped = True
            elif not self.error:
                self.error = "the connection to the Companion dropped: opening it again"
            for fut in list(self.pending.values()):
                if not fut.done():
                    fut.set_exception(Gone(self.error))
            self.pending.clear()
            self.on_state(False)
            if not self.stopped:
                await asyncio.sleep(wait)

    def call(self, header: dict, payload: bytes = b"", timeout: float = 300) -> tuple[dict, bytes]:
        if not self.up.wait(timeout=min(timeout, 20)):
            raise Gone(self.error or "the Companion can't be reached")
        with self.lock:
            self.next_id += 1
            ident = self.next_id
        fut: concurrent.futures.Future = concurrent.futures.Future()
        self.pending[ident] = fut
        message = frame({**header, "id": ident}, payload)
        started = time.monotonic()

        def send():
            if self.socket is None:
                fut.set_exception(Gone(self.error or "the Companion can't be reached"))
                return
            try:
                self.socket.write_message(message, binary=True)
            except Exception as error:
                if not fut.done():
                    fut.set_exception(Gone(str(error)))

        self.loop.call_soon_threadsafe(send)
        try:
            reply, data = fut.result(timeout=timeout)
        except concurrent.futures.TimeoutError:
            self.pending.pop(ident, None)
            raise Gone("the Companion didn't answer in time") from None
        if header.get("op") in ("stat", "read"):
            self.rtt_ms = 0.8 * self.rtt_ms + 0.2 * (time.monotonic() - started) * 1000 if self.rtt_ms else (time.monotonic() - started) * 1000
        if not reply.get("ok"):
            raise Refused(int(reply.get("errno") or errno.EIO), str(reply.get("error") or "refused"))
        return reply, data

    def stop(self) -> None:
        self.stopped = True
        if self.socket is not None:
            self.loop.call_soon_threadsafe(self.socket.close)


# ------------------------------------------------------------- the data place --


class Shipper:
    """What a run leaves on this machine that is data — checkpoints, outputs the rules keep here — put in the
    project's data place by koios_data, a few seconds after it was last closed, in the background."""

    QUIET_S = 3.0

    def __init__(self, local: Path, pylib: list[str], say, on_sent=lambda: None):
        self.local, self.pylib, self.say, self.on_sent = local, pylib, say, on_sent
        self.waiting: dict[str, float] = {}
        self.lock = threading.Lock()
        self.sent = 0
        self.failed = ""
        self.place = ""
        threading.Thread(target=self._loop, daemon=True, name="koios-shipper").start()

    def note(self, rel: str) -> None:
        with self.lock:
            self.waiting[rel] = time.monotonic()

    def _data(self):
        for folder in self.pylib:
            if folder and folder not in sys.path and os.path.isdir(folder):
                sys.path.insert(0, folder)
        try:
            import koios_data  # type: ignore

            if not koios_data.enabled():
                return None
            self.place = koios_data.where()
            return koios_data
        except Exception:
            return None

    def _loop(self) -> None:
        while True:
            time.sleep(1.0)
            now = time.monotonic()
            with self.lock:
                due = [rel for rel, at in self.waiting.items() if now - at >= self.QUIET_S]
                for rel in due:
                    self.waiting.pop(rel, None)
            if not due:
                continue
            data = self._data()
            if data is None:
                self.failed = "no data place is set for this project (Storage & compute → Data & results): the files stay on this machine"
                continue
            for rel in due:
                full = self.local / rel
                if not full.is_file():
                    continue
                try:
                    data.save(str(full), rel)
                    self.sent += 1
                    self.failed = ""
                except Exception as error:
                    self.failed = f"{rel}: {error}"
                    self.say(f"data place: {rel}: {error}")
            self.on_sent()

    def pending(self) -> int:
        with self.lock:
            return len(self.waiting)


# ------------------------------------------------------------------ the tree --


class Tree:
    """The folder as the Companion last described it: path → [size, mtime_ns, mode], and its folders."""

    def __init__(self):
        self.files: dict[str, list] = {}
        self.dirs: set[str] = set()
        self.children: dict[str, set[str]] = {"": set()}
        self.lock = threading.RLock()

    def _link(self, rel: str) -> None:
        parts = rel.split("/")
        for i in range(len(parts)):
            parent = "/".join(parts[:i])
            self.children.setdefault(parent, set()).add(parts[i])

    def reset(self, files: dict, dirs: list) -> None:
        with self.lock:
            self.files = {k: list(v) for k, v in files.items()}
            self.dirs = set(dirs)
            self.children = {"": set()}
            for d in self.dirs:
                self._link(d)
            for f in self.files:
                self._link(f)

    def put(self, rel: str, st: list) -> None:
        with self.lock:
            self.files[rel] = list(st)
            parts = rel.split("/")
            for i in range(1, len(parts)):
                self.dirs.add("/".join(parts[:i]))
            self._link(rel)

    def add_dir(self, rel: str) -> None:
        with self.lock:
            parts = rel.split("/")
            for i in range(1, len(parts) + 1):
                self.dirs.add("/".join(parts[:i]))
            self._link(rel)

    def drop(self, rel: str) -> None:
        with self.lock:
            self.files.pop(rel, None)
            self.dirs.discard(rel)
            self.children.pop(rel, None)
            parent, _, name = rel.rpartition("/")
            self.children.get(parent, set()).discard(name)

    def drop_tree(self, rel: str) -> list[str]:
        with self.lock:
            gone = [f for f in self.files if f == rel or f.startswith(rel + "/")]
            for f in gone:
                self.files.pop(f, None)
            for d in [d for d in self.dirs if d == rel or d.startswith(rel + "/")]:
                self.dirs.discard(d)
                self.children.pop(d, None)
            parent, _, name = rel.rpartition("/")
            self.children.get(parent, set()).discard(name)
            return gone

    def names(self, rel: str) -> set[str]:
        with self.lock:
            return set(self.children.get(rel, ()))


# ---------------------------------------------------------------- the store --


class Store:
    """Everything both modes share: the wire, the tree, the rules, the cache of your computer's files, this machine's
    own files (the overlay), and the status the Companion and the page read."""

    def __init__(self, url: str, key: str, at: Path, state: Path, mode: str, say=print):
        self.at, self.state, self.mode, self.say = at, state, mode, say
        self.cache = state / "cache"
        self.local = state / "local" if mode == "fuse" else at
        self.cache.mkdir(parents=True, exist_ok=True)
        self.local.mkdir(parents=True, exist_ok=True)
        self.tree = Tree()
        self.scratch = compile_rules(SCRATCH)
        self.rules = compile_rules(DEFAULT_RULES)
        self.rules_text = DEFAULT_RULES
        self.held: set[str] = set()
        self.have: dict[str, list] = self._load("have.json")  # what the cache holds: path → [size, mtime_ns]
        self.dirty: set[str] = set()
        self.fetching: dict[str, threading.Lock] = {}
        self.lock = threading.RLock()
        self.label = "your computer"
        self.ready = threading.Event()
        self.warm = {"files": 0, "bytes": 0, "seconds": 0.0}
        self.started = time.time()
        self.counts = {"read": 0, "fetched": 0, "written": 0, "pushed": 0}
        self.last_change = 0.0
        self.shipper = Shipper(self.local, [str(self.local / ".reader" / "pylib"), os.environ.get("KOIOS_PYLIB", "")], say, lambda: self.write_status())
        self.wire = Wire(url, key, self.on_push, self.on_state)

    # -- what lives where --

    def is_local(self, rel: str) -> bool:
        return rel in self.held or matches(self.scratch, rel) or matches(self.rules, rel)

    def is_data(self, rel: str) -> bool:
        return rel in self.held or (matches(self.rules, rel) and not matches(self.scratch, rel))

    def cpath(self, rel: str) -> Path:
        return self.cache / rel

    def lpath(self, rel: str) -> Path:
        return self.local / rel

    def _load(self, name: str) -> dict:
        try:
            return json.loads((self.state / name).read_text())
        except (OSError, ValueError):
            return {}

    def _save_have(self) -> None:
        tmp = self.state / "have.json.part"
        tmp.write_text(json.dumps(self.have))
        os.replace(tmp, self.state / "have.json")

    # -- what the Companion pushes --

    def on_state(self, up: bool) -> None:
        self.write_status()
        if up:
            threading.Thread(target=self.flush_dirty, daemon=True).start()

    def on_push(self, header: dict, payload: bytes) -> None:
        op = header.get("op")
        if op == "tree":
            self.on_tree(header)
        elif op == "changed":
            self.on_changed(header["path"], header["stat"], payload if header.get("inline") else None)
        elif op == "gone":
            self.on_gone(header["path"])
        elif op == "dirs":
            with self.tree.lock:
                for d in header.get("added") or []:
                    self.tree.add_dir(d)
                for d in header.get("removed") or []:
                    if not any(f.startswith(d + "/") for f in self.tree.files):
                        self.tree.drop(d)
        self.last_change = time.time()
        self.write_status()

    def on_tree(self, header: dict) -> None:
        self.label = header.get("label") or self.label
        if header.get("rules") is not None:
            self.rules_text = header["rules"]
            self.rules = compile_rules(header["rules"])
        self.tree.reset(header.get("files") or {}, header.get("dirs") or [])
        with self.lock:
            # Written here and not yet back there: still here, whatever the tree says.
            for rel in self.dirty:
                try:
                    self.tree.put(rel, [self.cpath(rel).stat().st_size, time.time_ns(), 0o644])
                except OSError:
                    pass
            # What the cache holds of a file that has changed or gone is dropped; what is still current is kept.
            for rel in list(self.have):
                st = self.tree.files.get(rel)
                if rel in self.dirty:
                    continue
                if st is None or self.have[rel] != st[:2]:
                    self.have.pop(rel, None)
                    self.forget_cached(rel)
        self.warm_up()
        self.ready.set()

    def on_changed(self, rel: str, st: list, data: bytes | None) -> None:
        with self.lock:
            if rel in self.dirty:
                self.say(f"{rel} changed on {self.label} while it was being written here: this machine's version wins")
                return
            self.tree.put(rel, st)
            if data is not None:
                self.store_cached(rel, data, st)
            else:
                self.have.pop(rel, None)
                self.forget_cached(rel)
            self.counts["pushed"] += 1

    def on_gone(self, rel: str) -> None:
        with self.lock:
            if rel in self.dirty:
                return
            if rel in self.tree.files:
                self.tree.drop(rel)
            else:
                self.tree.drop_tree(rel)
            self.have.pop(rel, None)
            self.forget_cached(rel)

    # -- the cache --

    def store_cached(self, rel: str, data: bytes, st: list) -> None:
        target = self.cpath(rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        part = target.with_name(target.name + ".koios-part")
        with open(part, "wb") as out:
            out.write(data)
        os.chmod(part, (st[2] if len(st) > 2 and st[2] else 0o644) | 0o600)
        os.replace(part, target)
        self.have[rel] = list(st[:2])
        self.counts["fetched"] += 1

    def forget_cached(self, rel: str) -> None:
        try:
            self.cpath(rel).unlink()
        except OSError:
            pass

    def current(self, rel: str) -> bool:
        st = self.tree.files.get(rel)
        return rel in self.dirty or (st is not None and self.have.get(rel) == st[:2] and self.cpath(rel).exists())

    def warm_up(self) -> None:
        """The small files that aren't here yet, over in a few archives: imports and configs are local from then on."""
        started = time.monotonic()
        wanted = sorted((rel for rel, st in self.tree.files.items() if st[0] <= WARM_MAX and not self.current(rel)), key=lambda r: (not r.endswith(".py"), r))
        batch: list[str] = []
        size = 0
        total = {"files": 0, "bytes": 0}

        def send(paths):
            try:
                reply, data = self.wire.call({"op": "pack", "paths": paths})
            except (Gone, Refused) as error:
                self.say(f"warming up: {error}")
                return
            stats = reply.get("files") or {}
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
                for member in tar.getmembers():
                    if not member.isfile() or not safe(member.name) or member.name not in stats:
                        continue
                    with self.lock:
                        if member.name in self.dirty:
                            continue
                        self.tree.put(member.name, stats[member.name])
                        self.store_cached(member.name, tar.extractfile(member).read(), stats[member.name])
                    total["files"] += 1
                    total["bytes"] += member.size

        for rel in wanted:
            batch.append(rel)
            size += self.tree.files[rel][0]
            if size >= PACK_MAX or len(batch) >= 2000:
                send(batch)
                batch, size = [], 0
        if batch:
            send(batch)
        with self.lock:
            self._save_have()
        self.warm = {"files": total["files"], "bytes": total["bytes"], "seconds": round(time.monotonic() - started, 2)}
        if total["files"]:
            self.say(f"↓ {total['files']} files ({total['bytes'] // 1024} KB) from {self.label} in {self.warm['seconds']} s")

    def fetch(self, rel: str) -> None:
        """A file of your computer's into the cache, whole, if what is here isn't current."""
        lock = self.fetching.setdefault(rel, threading.Lock())
        with lock:
            if self.current(rel):
                return
            st = self.tree.files.get(rel)
            if st is None:
                raise Refused(errno.ENOENT, rel)
            buf = bytearray()
            offset = 0
            got = st
            while True:
                reply, data = self.wire.call({"op": "read", "path": rel, "offset": offset, "size": PIECE})
                got = reply.get("stat") or got
                buf += data
                offset += len(data)
                if len(data) < PIECE or offset >= int(got[0]):
                    break
            with self.lock:
                self.tree.put(rel, got)
                self.store_cached(rel, bytes(buf), got)
                self._save_have()
            self.counts["read"] += 1

    # -- writing back --

    def upload(self, rel: str) -> None:
        """A file written here, back on your computer (or, when it is too big for the tunnel, kept here as data)."""
        source = self.cpath(rel) if self.mode == "fuse" else self.lpath(rel)
        try:
            size = source.stat().st_size
            mode = stat.S_IMODE(source.stat().st_mode)
        except OSError:
            with self.lock:
                self.dirty.discard(rel)
            return
        if size > BIG:
            self.hold(rel)
            return
        if not self.wire.up.is_set():
            raise Gone(self.wire.error or "the Companion can't be reached now")
        offset = 0
        reply = {}
        with open(source, "rb") as f:
            while True:
                piece = f.read(PIECE)
                last = offset + len(piece) >= size
                reply, _ = self.wire.call({"op": "write", "path": rel, "offset": offset, "last": last, "mode": mode}, piece)
                offset += len(piece)
                if last:
                    break
        with self.lock:
            st = reply.get("stat")
            if st:
                self.tree.put(rel, st)
                self.have[rel] = list(st[:2])
            self.dirty.discard(rel)
            self.counts["written"] += 1

    def hold(self, rel: str) -> None:
        """Too big for the tunnel: kept on this machine as data, and sent to the data place instead."""
        with self.lock:
            self.held.add(rel)
            self.dirty.discard(rel)
            if self.mode == "fuse":
                target = self.lpath(rel)
                target.parent.mkdir(parents=True, exist_ok=True)
                try:
                    os.replace(self.cpath(rel), target)
                except OSError:
                    pass
            self.have.pop(rel, None)
            if rel in self.tree.files:
                self.tree.drop(rel)
        self.say(f"{rel} is over {BIG // 1_000_000} MB: kept on this machine and sent to the data place, not through the tunnel")
        self.shipper.note(rel)

    def flush_dirty(self) -> None:
        for rel in sorted(self.dirty):
            try:
                self.upload(rel)
            except (Gone, Refused) as error:
                self.say(f"{rel} not written back yet: {error}")

    # -- the status the Companion reads --

    def write_status(self, **extra) -> None:
        body = {
            "v": VERSION,
            "pid": os.getpid(),
            "mode": self.mode,
            "at": str(self.at),
            "connected": self.wire.up.is_set(),
            "ready": self.ready.is_set(),
            "error": self.wire.error,
            "label": self.label,
            "files": len(self.tree.files),
            "cached": len(self.have),
            "warm": self.warm,
            "rttMs": round(self.wire.rtt_ms, 1),
            "counts": self.counts,
            "waitingToWrite": len(self.dirty),
            "data": {"place": self.shipper.place, "sent": self.shipper.sent, "waiting": self.shipper.pending(), "problem": self.shipper.failed},
            "since": self.started,
            "lastChange": self.last_change,
            **extra,
        }
        tmp = self.state / "status.json.part"
        try:
            tmp.write_text(json.dumps(body))
            os.replace(tmp, self.state / "status.json")
        except OSError:
            pass


# ------------------------------------------------------------------ fuse mode --


def fuse_ops(store: Store):
    from fuse import FuseOSError, Operations  # fusepy

    def err(code):
        return FuseOSError(code)

    def rel_of(path: str) -> str:
        return path.lstrip("/")

    def as_stat(st: os.stat_result) -> dict:
        return {key: getattr(st, key) for key in ("st_mode", "st_size", "st_mtime", "st_atime", "st_ctime", "st_nlink", "st_uid", "st_gid")}

    uid, gid = os.getuid(), os.getgid()
    started = time.time()

    class Ops(Operations):
        """The mount: your computer's files from the tree and the cache, this machine's from the overlay."""

        def __init__(self):
            self.writers: dict[int, str] = {}  # handles open for writing on your computer's files
            self.local_writers: dict[int, str] = {}  # ... and on this machine's
            self.guard = threading.RLock()

        def __call__(self, op, *args):
            try:
                return super().__call__(op, *args)
            except Refused as error:
                raise err(error.code) from None
            except Gone:
                raise err(errno.EIO) from None
            except FileNotFoundError:
                raise err(errno.ENOENT) from None
            except OSError as error:
                raise err(error.errno or errno.EIO) from None

        def dir_stat(self, mtime=None):
            t = mtime or started
            return {"st_mode": stat.S_IFDIR | 0o755, "st_nlink": 2, "st_size": 4096, "st_mtime": t, "st_atime": t, "st_ctime": t, "st_uid": uid, "st_gid": gid}

        def getattr(self, path, fh=None):
            rel = rel_of(path)
            if not rel:
                return self.dir_stat()
            if store.is_local(rel):
                return as_stat(os.lstat(store.lpath(rel)))
            with store.lock:
                st = store.tree.files.get(rel)
                if st is not None:
                    if rel in store.dirty or self.writing(rel):
                        return as_stat(os.lstat(store.cpath(rel)))
                    mtime = st[1] / 1e9
                    return {"st_mode": stat.S_IFREG | (st[2] if len(st) > 2 and st[2] else 0o644), "st_nlink": 1, "st_size": st[0], "st_mtime": mtime, "st_atime": mtime, "st_ctime": mtime, "st_uid": uid, "st_gid": gid}
                if rel in store.tree.dirs:
                    return self.dir_stat()
            if store.lpath(rel).is_dir():
                return self.dir_stat()
            raise err(errno.ENOENT)

        def writing(self, rel: str) -> bool:
            return rel in self.writers.values()

        def readdir(self, path, fh):
            rel = rel_of(path)
            names = {n for n in store.tree.names(rel)}
            folder = store.lpath(rel)
            if folder.is_dir():
                for entry in os.listdir(folder):
                    child = f"{rel}/{entry}" if rel else entry
                    if store.is_local(child) or (folder / entry).is_dir():
                        names.add(entry)
            return [".", ".."] + sorted(names)

        def access(self, path, amode):
            self.getattr(path)
            return 0

        def statfs(self, path):
            sv = os.statvfs(store.state)
            return {key: getattr(sv, key) for key in ("f_bavail", "f_bfree", "f_blocks", "f_bsize", "f_favail", "f_ffree", "f_files", "f_flag", "f_frsize", "f_namemax")}

        # -- files --

        def open(self, path, flags):
            rel = rel_of(path)
            if store.is_local(rel):
                fh = os.open(store.lpath(rel), flags)
                if flags & (os.O_WRONLY | os.O_RDWR):
                    with self.guard:
                        self.local_writers[fh] = rel
                return fh
            if rel not in store.tree.files:
                raise err(errno.ENOENT)
            if not (flags & os.O_TRUNC):
                store.fetch(rel)
            else:
                store.cpath(rel).parent.mkdir(parents=True, exist_ok=True)
            fh = os.open(store.cpath(rel), flags | (os.O_CREAT if flags & os.O_TRUNC else 0), 0o644)
            if flags & (os.O_WRONLY | os.O_RDWR):
                with self.guard:
                    self.writers[fh] = rel
                if flags & os.O_TRUNC:
                    with store.lock:
                        store.dirty.add(rel)
            return fh

        def create(self, path, mode, fi=None):
            rel = rel_of(path)
            if store.is_local(rel):
                store.lpath(rel).parent.mkdir(parents=True, exist_ok=True)
                fh = os.open(store.lpath(rel), os.O_CREAT | os.O_RDWR | os.O_TRUNC, mode)
                with self.guard:
                    self.local_writers[fh] = rel
                return fh
            store.cpath(rel).parent.mkdir(parents=True, exist_ok=True)
            fh = os.open(store.cpath(rel), os.O_CREAT | os.O_RDWR | os.O_TRUNC, mode)
            with store.lock:
                store.tree.put(rel, [0, time.time_ns(), stat.S_IMODE(mode)])
                store.dirty.add(rel)
            with self.guard:
                self.writers[fh] = rel
            return fh

        def read(self, path, size, offset, fh):
            return os.pread(fh, size, offset)

        def write(self, path, data, offset, fh):
            rel = self.writers.get(fh)
            if rel is not None:
                with store.lock:
                    store.dirty.add(rel)
            return os.pwrite(fh, data, offset)

        def truncate(self, path, length, fh=None):
            rel = rel_of(path)
            if store.is_local(rel):
                return os.truncate(store.lpath(rel), length)
            if rel not in store.dirty:
                store.fetch(rel)
            os.truncate(store.cpath(rel), length)
            with store.lock:
                store.dirty.add(rel)
            if not self.writing(rel):
                store.upload(rel)
            return 0

        def flush(self, path, fh):
            rel = self.writers.get(fh)
            if rel is not None and rel in store.dirty:
                try:
                    store.upload(rel)
                except Gone as error:
                    # Kept in the cache and sent when the socket is back (flush_dirty): the program's close succeeds.
                    store.say(f"{rel} not written back yet: {error}")
            return 0

        def fsync(self, path, datasync, fh):
            os.fsync(fh)
            return self.flush(path, fh)

        def release(self, path, fh):
            with self.guard:
                rel = self.writers.pop(fh, None)
                local = self.local_writers.pop(fh, None)
            os.close(fh)
            if rel is not None and rel in store.dirty and not self.writing(rel):
                try:
                    store.upload(rel)
                except (Gone, Refused) as error:
                    store.say(f"{rel} not written back yet: {error}")
            if local is not None and store.is_data(local) and store.lpath(local).is_file():
                store.shipper.note(local)
            return 0

        def unlink(self, path):
            rel = rel_of(path)
            if store.is_local(rel):
                os.unlink(store.lpath(rel))
                store.held.discard(rel)
                return 0
            store.wire.call({"op": "unlink", "path": rel})
            with store.lock:
                store.tree.drop(rel)
                store.dirty.discard(rel)
                store.have.pop(rel, None)
                store.forget_cached(rel)
            return 0

        def mkdir(self, path, mode):
            rel = rel_of(path)
            if store.is_local(rel):
                os.makedirs(store.lpath(rel), mode, exist_ok=False)
                return 0
            store.wire.call({"op": "mkdir", "path": rel})
            store.tree.add_dir(rel)
            return 0

        def rmdir(self, path):
            rel = rel_of(path)
            if store.is_local(rel):
                os.rmdir(store.lpath(rel))
                return 0
            if store.tree.names(rel):
                raise err(errno.ENOTEMPTY)
            store.wire.call({"op": "rmdir", "path": rel})
            store.tree.drop(rel)
            try:
                os.rmdir(store.lpath(rel))
            except OSError:
                pass
            return 0

        def rename(self, old, new):
            a, b = rel_of(old), rel_of(new)
            la, lb = store.is_local(a), store.is_local(b)
            if la and lb:
                store.lpath(b).parent.mkdir(parents=True, exist_ok=True)
                os.replace(store.lpath(a), store.lpath(b))
                if store.is_data(b) and store.lpath(b).is_file():
                    store.shipper.note(b)
                return 0
            if not la and not lb:
                if a in store.dirty:
                    store.upload(a)
                store.wire.call({"op": "rename", "path": a, "to": b})
                with store.lock:
                    if a in store.tree.files:
                        st = store.tree.files[a]
                        store.tree.drop(a)
                        store.tree.put(b, st)
                        store.cpath(b).parent.mkdir(parents=True, exist_ok=True)
                        try:
                            os.replace(store.cpath(a), store.cpath(b))
                            store.have[b] = store.have.pop(a, st[:2])
                        except OSError:
                            store.have.pop(a, None)
                    else:
                        for f in store.tree.drop_tree(a):
                            store.have.pop(f, None)
                        shutil.rmtree(store.cpath(a), ignore_errors=True)
                        store.tree.add_dir(b)
                return 0
            if la and not lb:
                # This machine's file becomes one of your computer's: it goes over.
                store.cpath(b).parent.mkdir(parents=True, exist_ok=True)
                os.replace(store.lpath(a), store.cpath(b))
                with store.lock:
                    store.tree.put(b, [store.cpath(b).stat().st_size, time.time_ns(), 0o644])
                    store.dirty.add(b)
                store.upload(b)
                return 0
            # One of your computer's becomes this machine's (a checkpoint renamed into checkpoints/, say).
            store.fetch(a)
            store.lpath(b).parent.mkdir(parents=True, exist_ok=True)
            os.replace(store.cpath(a), store.lpath(b))
            store.wire.call({"op": "unlink", "path": a})
            with store.lock:
                store.tree.drop(a)
                store.have.pop(a, None)
            if store.is_data(b):
                store.shipper.note(b)
            return 0

        def chmod(self, path, mode):
            rel = rel_of(path)
            if store.is_local(rel):
                return os.chmod(store.lpath(rel), mode)
            store.wire.call({"op": "chmod", "path": rel, "mode": stat.S_IMODE(mode)})
            with store.lock:
                st = store.tree.files.get(rel)
                if st is not None:
                    store.tree.put(rel, [st[0], st[1], stat.S_IMODE(mode)])
                if store.cpath(rel).exists():
                    os.chmod(store.cpath(rel), stat.S_IMODE(mode) | 0o600)
            return 0

        def chown(self, path, uid_, gid_):
            return 0

        def utimens(self, path, times=None):
            rel = rel_of(path)
            if store.is_local(rel):
                os.utime(store.lpath(rel), times)
            return 0

        def readlink(self, path):
            rel = rel_of(path)
            if store.is_local(rel):
                return os.readlink(store.lpath(rel))
            raise err(errno.EINVAL)

        def symlink(self, target, source):
            rel = rel_of(target)
            if store.is_local(rel):
                os.symlink(source, store.lpath(rel))
                return 0
            raise err(errno.EPERM)

    return Ops()


def fuse_available() -> str:
    """Why the fuse mode can't run here, or "" when it can."""
    if not os.path.exists("/dev/fuse"):
        return "this machine has no /dev/fuse"
    try:
        import fuse  # noqa: F401  (fusepy: it finds libfuse 2 as it is imported)
    except ImportError:
        return "fusepy isn't installed (pip install fusepy)"
    except (OSError, EnvironmentError) as error:
        return f"libfuse 2 isn't here ({error}; apt-get install -y fuse libfuse2)"
    if not (shutil.which("fusermount") or shutil.which("fusermount3")) and os.geteuid() != 0:
        return "fusermount isn't installed"
    return ""


def adopt(store: Store) -> dict:
    """What was in the folder before the mount — a push's copy, the helpers Koios wrote, a run's checkpoints —
    sorted before the mount covers it: this machine's own files go to the overlay and stay; copies of your
    computer's files go (the mount is current); a file a run made there that is your computer's kind goes back."""
    at = store.at
    kept, dropped, sent = 0, 0, 0
    if not at.is_dir() or os.path.ismount(at):
        return {"kept": 0, "dropped": 0, "sent": 0}
    for folder, dirs, names in os.walk(at, topdown=False):
        for name in names:
            full = Path(folder) / name
            rel = full.relative_to(at).as_posix()
            if store.is_local(rel):
                target = store.lpath(rel)
                target.parent.mkdir(parents=True, exist_ok=True)
                if not target.exists():
                    os.replace(full, target)
                    kept += 1
                    continue
            elif rel not in store.tree.files and not full.is_symlink():
                target = store.cpath(rel)
                target.parent.mkdir(parents=True, exist_ok=True)
                os.replace(full, target)
                with store.lock:
                    store.tree.put(rel, [target.stat().st_size, time.time_ns(), 0o644])
                    store.dirty.add(rel)
                sent += 1
                continue
            try:
                full.unlink()
                dropped += 1
            except OSError:
                pass
        for name in dirs:
            try:
                (Path(folder) / name).rmdir()
            except OSError:
                pass
    if sent:
        threading.Thread(target=store.flush_dirty, daemon=True).start()
    return {"kept": kept, "dropped": dropped, "sent": sent}


def run_fuse(store: Store) -> None:
    from fuse import FUSE

    at = store.at
    at.mkdir(parents=True, exist_ok=True)
    store.wire.start()
    # The tree first: the rules it carries say which of what is there already is this machine's.
    store.ready.wait(timeout=60)
    found = adopt(store)
    store.write_status(adopted=found)
    store.say(f"mounted {at} from {store.label} (fuse) · before it: {found['kept']} kept here, {found['dropped']} old copies gone, {found['sent']} sent back")
    FUSE(fuse_ops(store), str(at), foreground=True, nothreads=False, attr_timeout=1.0, entry_timeout=1.0, negative_timeout=0.5, big_writes=True, max_read=1 << 20, fsname=f"koios:{store.label}"[:60])


# ------------------------------------------------------------------ mirror mode --


class Mirror:
    """No FUSE here: the folder is a real directory, kept current both ways over the same socket. Your computer's
    changes arrive as they are saved; what is changed here goes back within a second."""

    def __init__(self, store: Store):
        self.store = store
        self.seen: dict[str, list] = store._load("seen.json")  # path → [size, mtime_ns] of the file here as last synced
        self.lock = threading.RLock()
        self.first = True
        store.on_tree = self.on_tree  # type: ignore[method-assign]
        store.on_changed = self.on_changed  # type: ignore[method-assign]
        store.on_gone = self.on_gone  # type: ignore[method-assign]

    def local_stat(self, rel: str):
        try:
            st = os.stat(self.store.lpath(rel))
            return [st.st_size, st.st_mtime_ns]
        except OSError:
            return None

    def save_seen(self) -> None:
        tmp = self.store.state / "seen.json.part"
        tmp.write_text(json.dumps(self.seen))
        os.replace(tmp, self.store.state / "seen.json")

    def place(self, rel: str, data: bytes, st: list) -> None:
        target = self.store.lpath(rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        part = target.with_name(target.name + ".koios-part")
        with open(part, "wb") as out:
            out.write(data)
        os.chmod(part, st[2] if len(st) > 2 and st[2] else 0o644)
        os.replace(part, target)
        self.seen[rel] = self.local_stat(rel)
        self.store.have[rel] = list(st[:2])

    def on_tree(self, header: dict) -> None:
        s = self.store
        s.label = header.get("label") or s.label
        if header.get("rules") is not None:
            s.rules_text = header["rules"]
            s.rules = compile_rules(header["rules"])
        s.tree.reset(header.get("files") or {}, header.get("dirs") or [])
        started = time.monotonic()
        with self.lock:
            for d in s.tree.dirs:
                s.lpath(d).mkdir(parents=True, exist_ok=True)
            need = []
            for rel, st in s.tree.files.items():
                here = self.local_stat(rel)
                changed_here = here is not None and self.seen.get(rel) is not None and here != self.seen.get(rel)
                if changed_here:
                    continue  # the poller sends it
                if here is None or s.have.get(rel) != st[:2]:
                    need.append(rel)
            # What a push left here before the mirror started, and isn't your computer's: kept as it is, and not sent.
            # (Not on a reconnect: what was written here while the socket was down is new, and goes.)
            if self.first:
                for folder, dirs, names in os.walk(s.local):
                    for name in names:
                        rel = (Path(folder) / name).relative_to(s.local).as_posix()
                        if rel not in s.tree.files and rel not in self.seen:
                            self.seen[rel] = self.local_stat(rel)
                self.first = False
        small = [r for r in need if s.tree.files[r][0] <= PACK_MAX]
        for i in range(0, len(small), 500):
            batch = small[i : i + 500]
            try:
                reply, data = s.wire.call({"op": "pack", "paths": batch})
            except (Gone, Refused) as error:
                s.say(f"mirror: {error}")
                break
            stats = reply.get("files") or {}
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar, self.lock:
                for member in tar.getmembers():
                    if member.isfile() and safe(member.name) and member.name in stats:
                        self.place(member.name, tar.extractfile(member).read(), stats[member.name])
        for rel in need:
            if s.tree.files.get(rel, [0])[0] > PACK_MAX:
                try:
                    self.fetch_big(rel)
                except (Gone, Refused) as error:
                    s.say(f"mirror: {rel}: {error}")
        with self.lock:
            self.save_seen()
            s._save_have()
        s.warm = {"files": len(need), "bytes": sum(s.tree.files[r][0] for r in need if r in s.tree.files), "seconds": round(time.monotonic() - started, 2)}
        s.ready.set()

    def fetch_big(self, rel: str) -> None:
        s = self.store
        target = s.lpath(rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        part = target.with_name(target.name + ".koios-part")
        offset = 0
        st = s.tree.files[rel]
        with open(part, "wb") as out:
            while True:
                reply, data = s.wire.call({"op": "read", "path": rel, "offset": offset, "size": PIECE})
                st = reply.get("stat") or st
                out.write(data)
                offset += len(data)
                if len(data) < PIECE or offset >= st[0]:
                    break
        os.replace(part, target)
        with self.lock:
            self.seen[rel] = self.local_stat(rel)
            s.have[rel] = list(st[:2])

    def on_changed(self, rel: str, st: list, data: bytes | None) -> None:
        s = self.store
        with self.lock:
            here = self.local_stat(rel)
            if here is not None and self.seen.get(rel) is not None and here != self.seen[rel]:
                s.say(f"{rel} changed on both sides: this machine's version wins")
                return
            s.tree.put(rel, st)
            if data is not None:
                self.place(rel, data, st)
                s.counts["pushed"] += 1
                return
        try:
            self.fetch_big(rel)
        except (Gone, Refused) as error:
            s.say(f"mirror: {rel}: {error}")

    def on_gone(self, rel: str) -> None:
        s = self.store
        with self.lock:
            for f in [rel] + [f for f in list(s.tree.files) if f.startswith(rel + "/")]:
                here = self.local_stat(f)
                if here is not None and here == self.seen.get(f):
                    try:
                        os.unlink(s.lpath(f))
                    except OSError:
                        pass
                self.seen.pop(f, None)
                s.have.pop(f, None)
            if rel in s.tree.files:
                s.tree.drop(rel)
            else:
                s.tree.drop_tree(rel)
                shutil.rmtree(s.lpath(rel), ignore_errors=True) if s.lpath(rel).is_dir() and not any(s.lpath(rel).rglob("*")) else None

    def poll(self) -> None:
        """What changed here since it was last synced: your computer's files back there, this machine's data to the data place."""
        s = self.store
        while True:
            time.sleep(0.7)
            if not s.ready.is_set():
                continue
            found: dict[str, list] = {}
            for folder, dirs, names in os.walk(s.local):
                base = Path(folder).relative_to(s.local).as_posix()
                dirs[:] = [d for d in dirs if not matches(s.scratch, f"{base}/{d}" if base != "." else d)]
                for name in names:
                    rel = f"{base}/{name}" if base != "." else name
                    if matches(s.scratch, rel):
                        continue
                    st = self.local_stat(rel)
                    if st is not None:
                        found[rel] = st
            with self.lock:
                changed = [r for r, st in found.items() if self.seen.get(r) != st]
                removed = [r for r in list(self.seen) if r not in found and r in s.tree.files]
            for rel in changed:
                if s.is_local(rel) or found[rel][0] > BIG:
                    if s.is_data(rel) or found[rel][0] > BIG:
                        s.shipper.note(rel)
                        if found[rel][0] > BIG:
                            s.held.add(rel)
                    with self.lock:
                        self.seen[rel] = found[rel]
                    continue
                try:
                    s.upload(rel)
                    with self.lock:
                        self.seen[rel] = self.local_stat(rel)
                except (Gone, Refused) as error:
                    s.say(f"{rel} not written back yet: {error}")
            for rel in removed:
                try:
                    s.wire.call({"op": "unlink", "path": rel})
                    with self.lock:
                        self.seen.pop(rel, None)
                        s.tree.drop(rel)
                        s.have.pop(rel, None)
                except (Gone, Refused) as error:
                    s.say(f"{rel} not removed there yet: {error}")
            if changed or removed:
                with self.lock:
                    self.save_seen()
                s.write_status()


def run_mirror(store: Store) -> None:
    mirror = Mirror(store)
    store.at.mkdir(parents=True, exist_ok=True)
    store.wire.start()
    store.ready.wait(timeout=60)
    store.say(f"mirroring {store.at} from {store.label}")
    threading.Thread(target=mirror.poll, daemon=True, name="koios-poll").start()
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    while not stop.wait(5):
        store.write_status()


# ------------------------------------------------------------------ the daemon --


def state_dir(at: Path) -> Path:
    base = Path(os.environ.get("KOIOS_MOUNT_HOME") or Path.home() / ".koios-mount")
    return base / hashlib.sha1(str(at.resolve()).encode()).hexdigest()[:16]


def read_status(at: Path) -> dict:
    try:
        status = json.loads((state_dir(at) / "status.json").read_text())
    except (OSError, ValueError):
        return {"running": False}
    pid = int(status.get("pid") or 0)
    alive = False
    if pid:
        try:
            os.kill(pid, 0)
            alive = True
        except OSError:
            alive = False
    status["running"] = alive
    status["mounted"] = alive and (status.get("mode") != "fuse" or os.path.ismount(at))
    return status


def unmount(at: Path) -> None:
    if os.path.ismount(at):
        for tool in (["fusermount", "-u", "-z", str(at)], ["fusermount3", "-u", "-z", str(at)], ["umount", "-l", str(at)]):
            if shutil.which(tool[0]):
                subprocess.run(tool, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if not os.path.ismount(at):
                    break


def give_back(at: Path, state: Path) -> None:
    """After a fuse mount: this machine's own files (the overlay) back in the folder, as they were before it."""
    local = state / "local"
    if not local.is_dir() or os.path.ismount(at):
        return
    at.mkdir(parents=True, exist_ok=True)
    for folder, dirs, names in os.walk(local):
        for name in names:
            full = Path(folder) / name
            target = at / full.relative_to(local)
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                os.replace(full, target)
    shutil.rmtree(local, ignore_errors=True)


def stop(at: Path, wait_s: float = 10) -> bool:
    status = read_status(at)
    pid = int(status.get("pid") or 0)
    if status.get("mode") == "fuse":
        unmount(at)
    if pid and status.get("running"):
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
        deadline = time.time() + wait_s
        while time.time() < deadline:
            try:
                os.kill(pid, 0)
            except OSError:
                break
            time.sleep(0.1)
        else:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
    if status.get("mode") == "fuse":
        give_back(at, state_dir(at))
    return bool(pid)


def choose_mode(asked: str) -> tuple[str, str]:
    why = fuse_available()
    if asked == "fuse" and why:
        raise SystemExit(f"koios mount: {why}")
    if asked == "mirror":
        return "mirror", ""
    return ("fuse", "") if not why else ("mirror", why)


def serve(url: str, key: str, at: Path, mode: str) -> None:
    state = state_dir(at)
    state.mkdir(parents=True, exist_ok=True)
    # Somewhere that stays: koios_data reads the working directory, and the one it was started in may go.
    os.chdir(state)
    log = lambda text: print(time.strftime("%H:%M:%S"), text, flush=True)  # noqa: E731
    store = Store(url, key, at, state, mode, say=log)
    store.write_status()

    def bye(*_):
        store.wire.stop()
        if mode == "fuse":
            unmount(at)
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, bye)
    if mode == "fuse":
        try:
            run_fuse(store)
        finally:
            store.wire.stop()
            store.write_status(stopped=True)
    else:
        run_mirror(store)


def start(url: str, key: str, at: Path, mode: str, wait_s: float = 90) -> dict:
    """The daemon, started in the background (again if one is running for this folder), and its status once it is ready."""
    at = at.resolve() if at.exists() else Path(os.path.abspath(at))
    stop(at)
    chosen, why = choose_mode(mode)
    state = state_dir(at)
    state.mkdir(parents=True, exist_ok=True)
    (state / "status.json").unlink(missing_ok=True)
    with open(state / "mount.log", "ab") as out:
        subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), "serve", f"--url={url}", f"--key={key}", f"--at={at}", f"--mode={chosen}"],
            stdout=out, stderr=out, stdin=subprocess.DEVNULL, start_new_session=True, cwd=str(state), env={**os.environ, "PYTHONUNBUFFERED": "1"},
        )
    deadline = time.time() + wait_s
    status = {}
    while time.time() < deadline:
        status = read_status(at)
        if status.get("ready") and status.get("mounted"):
            break
        if status.get("pid") and not status.get("running"):
            break
        time.sleep(0.25)
    status["why"] = why
    try:
        status["log"] = (state / "mount.log").read_text()[-2000:]
    except OSError:
        pass
    return status


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="koios_mount", description="A project's folder on your computer, mounted here through the Koios Companion.")
    sub = parser.add_subparsers(dest="command")
    for name in ("start", "serve"):
        p = sub.add_parser(name)
        p.add_argument("--url", required=True)
        p.add_argument("--key", required=True)
        p.add_argument("--at", required=True)
        p.add_argument("--mode", default="auto", choices=("auto", "fuse", "mirror"))
    for name in ("status", "stop"):
        p = sub.add_parser(name)
        p.add_argument("--at", required=True)
    args = parser.parse_args(argv)
    if args.command == "serve":
        serve(args.url, args.key, Path(args.at), args.mode)
        return 0
    if args.command == "start":
        print(json.dumps(start(args.url, args.key, Path(args.at), args.mode)))
        return 0
    if args.command == "status":
        print(json.dumps(read_status(Path(args.at))))
        return 0
    if args.command == "stop":
        print(json.dumps({"stopped": stop(Path(args.at))}))
        return 0
    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
