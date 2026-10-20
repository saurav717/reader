"""A project's folder here, mounted on its compute (from 0.19.0): the Companion's side of koios_mount.py.

The machine the code runs on — Colab, a GPU server — keeps one WebSocket open to /companion/mount/socket, through
this Companion's Cloudflare tunnel, and reads and writes the project's folder over it as if it were its own disk.
Nothing is copied before a run. The pieces here:

- **The key.** One per project folder, made when the mount is first started and kept with the compute links
  (~/.reader-companion/mounts/, 0600). It opens that folder and nothing else — never the Companion's token, never
  another folder — and stopping the mount from the page forgets it, which closes every socket that used it.
- **The socket.** MountSocket answers what the machine asks (the tree, an archive of small files, a piece of a file,
  a write, a rename) and pushes what changes here. Paths are checked against the folder and the project's rules: a
  path the rules leave out (data/, *.pt, .git/…) is the machine's own, and is refused here.
- **The watch.** While a machine is connected, the folder is looked over twice a second (only stat calls) and every
  change is pushed at once — the file itself when it is small — so the machine has it before anything there asks.
  A write from the machine is not echoed back to it.
- **Starting it there.** start_remote() uses the compute link's own kernel (compute.Remote): koios_mount.py is written
  on the machine, fusepy installed when it can be, and the daemon started in the background. The page asks for all
  of it with one POST companion/compute {action: "mount"}.
"""

from __future__ import annotations

import asyncio
import base64
import errno
import hashlib
import hmac
import io
import json
import os
import secrets
import shutil
import stat
import tarfile
import time
from pathlib import Path

from tornado import websocket
from tornado.ioloop import IOLoop, PeriodicCallback

from . import awake, compute, state
from .koios_mount import compile_rules, frame, matches, unframe

SCAN_MS = 500
# A change this small is pushed with its bytes, so the machine never asks for it.
INLINE = 512 * 1024
PACK_MAX = 64 * 1024 * 1024
PIECE_MAX = 16 * 1024 * 1024
SOCKET_PATH = "companion/mount/socket"


# ------------------------------------------------------------------ the keys --


def keys_dir() -> Path:
    return state.config_dir() / "mounts"


def key_file(root: Path) -> Path:
    return keys_dir() / f"{hashlib.sha1(str(root.resolve()).encode()).hexdigest()[:16]}.json"


def key_for(root: Path) -> str:
    """The folder's mount key: the one it has, or a new one."""
    path = key_file(root)
    try:
        saved = json.loads(path.read_text())
        if saved.get("root") == str(root.resolve()) and saved.get("key"):
            return saved["key"]
    except (OSError, ValueError):
        pass
    keys_dir().mkdir(parents=True, exist_ok=True)
    key = secrets.token_urlsafe(32)
    path.write_text(json.dumps({"root": str(root.resolve()), "key": key, "at": int(time.time() * 1000)}))
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return key


def forget_key(root: Path) -> None:
    key_file(root).unlink(missing_ok=True)
    share = Share.all.get(str(root.resolve()))
    if share:
        for conn in list(share.conns):
            conn.close(4403, "the mount was stopped")


def root_for(key: str) -> Path | None:
    if not key or not keys_dir().is_dir():
        return None
    for path in keys_dir().glob("*.json"):
        try:
            saved = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if saved.get("key") and hmac.compare_digest(str(saved["key"]), key):
            return Path(saved["root"])
    return None


# ---------------------------------------------------------------- the shares --
#
# A folder you pick, anywhere on this computer, attached on another computer of yours (attach.py) as a disk of its
# own: not a project, so none of a project's rules — .git and all come too — and listed a folder at a time, as it is
# opened there, so a big one costs nothing to attach. Each share has its own key, like a project's mount.

# Never sent, and never taken: what the Companion writes beside a file as it puts it in place.
SHARE_SKIP = "*.koios-part*\n"


def shares_dir() -> Path:
    return state.config_dir() / "shares"


def share_file(root: Path) -> Path:
    return shares_dir() / f"{hashlib.sha1(str(root.resolve()).encode()).hexdigest()[:16]}.json"


def check_shareable(root: Path) -> Path:
    """A folder that may be shared: one that is there, and not the whole computer or the whole home folder."""
    root = Path(os.path.expanduser(str(root))).resolve()
    if not root.is_dir():
        raise ValueError(f"there is no folder at {root}")
    if root == Path(root.anchor) or root == Path.home().resolve():
        raise ValueError("pick a folder inside your home folder, not all of it (or the whole disk)")
    return root


def share_folder(root: Path, name: str = "") -> dict:
    """The folder's share: the one it has, or a new one. {root, key, name, at}."""
    root = check_shareable(root)
    path = share_file(root)
    try:
        saved = json.loads(path.read_text())
        if saved.get("root") == str(root) and saved.get("key"):
            if name and saved.get("name") != name:
                saved["name"] = name
                path.write_text(json.dumps(saved))
            return saved
    except (OSError, ValueError):
        pass
    shares_dir().mkdir(parents=True, exist_ok=True)
    saved = {"root": str(root), "key": secrets.token_urlsafe(32), "name": name or root.name, "at": int(time.time() * 1000)}
    path.write_text(json.dumps(saved))
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return saved


def stop_share(root: Path) -> bool:
    """The share forgotten, and every machine using it cut off."""
    root = Path(os.path.expanduser(str(root))).resolve()
    path = share_file(root)
    had = path.exists()
    path.unlink(missing_ok=True)
    share = Share.all.get(str(root))
    if share:
        for conn in list(share.conns):
            # On the socket's own loop: this may be called from any thread.
            conn.loop.add_callback(conn.close, 4403, "the share was stopped")
    return had


def list_shares() -> list:
    """Every share here, with how many machines have it attached now — never its key."""
    out = []
    for path in sorted(shares_dir().glob("*.json")) if shares_dir().is_dir() else []:
        try:
            saved = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        out.append({"root": saved["root"], "name": saved.get("name") or Path(saved["root"]).name, "at": saved.get("at"), "attached": connected(Path(saved["root"])), "there": Path(saved["root"]).is_dir()})
    return out


def record_for(key: str) -> dict | None:
    """Whose key it is: a project's mount ({root, lazy: False}) or a share ({root, lazy: True, name})."""
    if not key:
        return None
    root = root_for(key)
    if root is not None:
        return {"root": root, "lazy": False}
    for path in shares_dir().glob("*.json") if shares_dir().is_dir() else []:
        try:
            saved = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if saved.get("key") and hmac.compare_digest(str(saved["key"]), key):
            return {"root": Path(saved["root"]), "lazy": True, "name": saved.get("name") or Path(saved["root"]).name}
    return None


def socket_url(tunnel_url: str, base_url: str = "/") -> str:
    """Where the machine dials: the tunnel's address, as a WebSocket."""
    url = tunnel_url.rstrip("/") + "/" + (base_url.strip("/") + "/" if base_url.strip("/") else "") + SOCKET_PATH
    return "wss://" + url[len("https://"):] if url.startswith("https://") else "ws://" + url[len("http://"):]


# ------------------------------------------------------------------ the folder --


def rules_of(root: Path) -> str:
    """The project's rules (the compute link's): what they leave out is the machine's own."""
    link = compute.load_link_file(compute.link_file(root)) or {}
    return link.get("ignore") or "data/\nwandb/\n*.ckpt\n*.pt\n*.safetensors\n"


def inside(root: Path, full: str) -> bool:
    real = os.path.realpath(full)
    return real == str(root) or real.startswith(str(root) + os.sep)


def scan(root: Path, compiled: list) -> tuple[dict, set]:
    """Every file the rules let through — path → [size, mtime_ns, mode] — and every folder. A link that leads out of
    the folder is left out: the machine sees the project, not what it points at on this computer."""
    root = Path(os.path.realpath(root))
    files: dict[str, list] = {}
    dirs: set[str] = set()
    for folder, subdirs, names in os.walk(root):
        base = os.path.relpath(folder, root).replace(os.sep, "/")
        base = "" if base == "." else base
        keep = []
        for d in subdirs:
            rel = f"{base}/{d}" if base else d
            if not matches(compiled, rel) and not os.path.islink(os.path.join(folder, d)):
                keep.append(d)
                dirs.add(rel)
        subdirs[:] = keep
        for name in names:
            rel = f"{base}/{name}" if base else name
            if matches(compiled, rel):
                continue
            full = os.path.join(folder, name)
            if os.path.islink(full) and not inside(root, full):
                continue
            try:
                st = os.stat(full)
            except OSError:
                continue
            if stat.S_ISREG(st.st_mode):
                files[rel] = [st.st_size, st.st_mtime_ns, stat.S_IMODE(st.st_mode)]
    return files, dirs


class Share:
    """One project folder, served to the machines mounting it: its tree as last scanned, and the sockets."""

    all: dict[str, "Share"] = {}

    @classmethod
    def of(cls, root: Path, lazy: bool = False) -> "Share":
        name = str(root.resolve())
        if name not in cls.all or cls.all[name].lazy != lazy:
            cls.all[name] = cls(root.resolve(), lazy)
        return cls.all[name]

    def __init__(self, root: Path, lazy: bool = False):
        self.root = Path(os.path.realpath(root))
        # A share (lazy): no tree up front; the folders a machine has listed are watched, each as it was last seen.
        self.lazy = lazy
        self.listed: dict[str, dict] = {}
        self.rules = ""
        self.compiled: list = []
        self.files: dict[str, list] = {}
        self.dirs: set[str] = set()
        self.conns: set["MountSocket"] = set()
        self.timer: PeriodicCallback | None = None
        self.scanning = False
        self.refresh_rules()

    def refresh_rules(self) -> None:
        if self.lazy:
            self.rules = ""
            self.compiled = compile_rules(SHARE_SKIP)
            return
        self.rules = rules_of(self.root)
        self.compiled = compile_rules(compute.ALWAYS_SKIP + "\n*.koios-part*\n" + self.rules)

    def entries(self, rel_dir: str) -> dict:
        """One folder's entries, as a machine lists it: name → [kind ("d" or "f"), size, mtime_ns, mode]."""
        full = self.root / rel_dir if rel_dir else self.root
        if rel_dir:
            self.path(rel_dir)
        out: dict[str, list] = {}
        with os.scandir(full) as found:
            for entry in found:
                rel = f"{rel_dir}/{entry.name}" if rel_dir else entry.name
                if matches(self.compiled, rel):
                    continue
                if entry.is_symlink() and not inside(self.root, entry.path):
                    continue
                try:
                    st = entry.stat()
                except OSError:
                    continue
                if stat.S_ISDIR(st.st_mode):
                    out[entry.name] = ["d", 0, st.st_mtime_ns, stat.S_IMODE(st.st_mode)]
                elif stat.S_ISREG(st.st_mode):
                    out[entry.name] = ["f", st.st_size, st.st_mtime_ns, stat.S_IMODE(st.st_mode)]
        return out

    def watch(self, rel_dir: str, entries: dict) -> None:
        self.listed[rel_dir] = entries

    def look_listed(self) -> list:
        """The listed folders looked at again: (folder, changed entries, gone names) for each that changed."""
        out = []
        for rel_dir, before in list(self.listed.items()):
            try:
                now = self.entries(rel_dir)
            except OSError:
                now = {}
                if rel_dir:
                    self.listed.pop(rel_dir, None)
            changed = {name: e for name, e in now.items() if before.get(name) != e}
            gone = [name for name in before if name not in now]
            if changed or gone:
                self.listed[rel_dir] = now
                out.append((rel_dir, changed, gone))
        return out

    def path(self, rel: str) -> Path:
        """A path inside the folder that the rules let through, or a refusal."""
        parts = rel.replace("\\", "/").split("/")
        if not rel or rel.startswith("/") or ".." in parts or "" in parts:
            raise OSError(errno.EACCES, f"not a path in the project: {rel!r}")
        if matches(self.compiled, rel):
            raise OSError(errno.EACCES, f"{rel} is the machine's own (the project's rules leave it out)")
        full = self.root / rel
        if not inside(self.root, str(full.parent)) or (os.path.islink(full) and not inside(self.root, str(full))):
            raise OSError(errno.EACCES, f"{rel} leads out of the project")
        return full

    def add(self, conn: "MountSocket") -> None:
        self.conns.add(conn)
        # A machine reads and writes here now: this computer doesn't sleep under it (awake.py).
        awake.current.hold(str(self.root))
        if self.timer is None:
            self.timer = PeriodicCallback(self.tick, SCAN_MS)
            self.timer.start()

    def remove(self, conn: "MountSocket") -> None:
        self.conns.discard(conn)
        if not self.conns:
            awake.current.release(str(self.root))
        if not self.conns and self.timer is not None:
            self.timer.stop()
            self.timer = None

    async def fresh(self) -> None:
        self.refresh_rules()
        if self.lazy:
            return
        self.files, self.dirs = await IOLoop.current().run_in_executor(None, scan, self.root, self.compiled)

    async def tick(self) -> None:
        if self.scanning or not self.conns:
            return
        self.scanning = True
        if self.lazy:
            try:
                for rel_dir, changed, gone in await IOLoop.current().run_in_executor(None, self.look_listed):
                    self.broadcast({"op": "entries", "dir": rel_dir, "changed": changed, "gone": gone})
            finally:
                self.scanning = False
            return
        try:
            files, dirs = await IOLoop.current().run_in_executor(None, scan, self.root, self.compiled)
            changed = [rel for rel, st in files.items() if self.files.get(rel) != st]
            gone = [rel for rel in self.files if rel not in files]
            added_dirs = sorted(dirs - self.dirs)
            removed_dirs = sorted(self.dirs - dirs)
            self.files, self.dirs = files, dirs
            if added_dirs or removed_dirs:
                self.broadcast({"op": "dirs", "added": added_dirs, "removed": removed_dirs})
            for rel in gone:
                self.broadcast({"op": "gone", "path": rel})
            for rel in changed:
                await self.announce(rel, files[rel])
        finally:
            self.scanning = False

    async def announce(self, rel: str, st: list, skip: "MountSocket | None" = None) -> None:
        data = b""
        inline = st[0] <= INLINE
        if inline:
            try:
                data = await IOLoop.current().run_in_executor(None, (self.root / rel).read_bytes)
            except OSError:
                return
            if len(data) != st[0]:
                return  # written as it was read: the next look sends it whole
        self.broadcast({"op": "changed", "path": rel, "stat": st, "inline": inline}, data, skip)

    def broadcast(self, header: dict, payload: bytes = b"", skip: "MountSocket | None" = None) -> None:
        message = frame(header, payload)
        for conn in list(self.conns):
            if conn is not skip:
                conn.send(message)

    def noted(self, rel: str, st: list | None, by: "MountSocket") -> None:
        """A change made by one machine: the tree knows it now (so it isn't seen as new), and the others are told."""
        if self.lazy:
            parent, _, name = rel.rpartition("/")
            if parent in self.listed:
                try:
                    entries = self.entries(parent)
                except OSError:
                    return
                before = self.listed[parent]
                self.listed[parent] = entries
                changed = {n: e for n, e in entries.items() if before.get(n) != e}
                gone = [n for n in before if n not in entries]
                if (changed or gone) and len(self.conns) > 1:
                    self.broadcast({"op": "entries", "dir": parent, "changed": changed, "gone": gone}, skip=by)
            return
        if st is None:
            self.files.pop(rel, None)
            self.broadcast({"op": "gone", "path": rel}, skip=by)
        else:
            self.files[rel] = st
            parts = rel.split("/")
            for i in range(1, len(parts)):
                self.dirs.add("/".join(parts[:i]))
            if len(self.conns) > 1:
                IOLoop.current().add_callback(self.announce, rel, st, by)


def stat_of(full: Path) -> list:
    st = full.stat()
    return [st.st_size, st.st_mtime_ns, stat.S_IMODE(st.st_mode)]


# ------------------------------------------------------------------ the socket --


class MountSocket(websocket.WebSocketHandler):
    """/companion/mount/socket?key=…: one machine's mount of one project folder, or of a share (attach.py)."""

    share: Share | None = None

    def check_xsrf_cookie(self):
        return

    def check_origin(self, origin):
        # The machine is a program, not a page: it sends no Origin. A page may only come from the reader's own site.
        return not origin or bool(state.current and origin == state.current.origin)

    def get_compression_options(self):
        return {"compression_level": 4, "mem_level": 8}

    async def get(self, *args, **kwargs):
        record = record_for(self.get_query_argument("key", ""))
        if record is None or not record["root"].is_dir():
            self.set_status(403)
            return self.finish("This mount's key isn't known here (it was stopped): start the mount again from Koios.")
        self.record = record
        self.share = Share.of(record["root"], record["lazy"])
        self.writes: dict[str, object] = {}
        return await super().get(*args, **kwargs)

    async def open(self):
        self.loop = IOLoop.current()
        share = self.share
        await share.fresh()
        share.add(self)
        name = state.current.name if state.current else "your computer"
        if share.lazy:
            # A share: no tree up front. The machine lists each folder as it is opened (op "list").
            self.send(frame({"op": "hello", "lazy": True, "label": name, "name": self.record.get("name") or share.root.name, "rules": SHARE_SKIP}))
            return
        self.send(frame({"op": "tree", "files": share.files, "dirs": sorted(share.dirs), "rules": share.rules, "label": name}))

    def send(self, message: bytes) -> None:
        try:
            self.write_message(message, binary=True)
        except websocket.WebSocketClosedError:
            pass

    def on_close(self):
        if self.share:
            self.share.remove(self)
        for handle in getattr(self, "writes", {}).values():
            try:
                handle.close()
                os.unlink(handle.name)
            except OSError:
                pass

    async def on_message(self, message):
        if isinstance(message, str):
            return
        try:
            header, payload = unframe(message)
        except (ValueError, Exception):
            return
        ident = header.get("id")
        try:
            reply, data = await self.answer(header, payload)
            self.send(frame({"id": ident, "ok": True, **reply}, data))
        except OSError as error:
            self.send(frame({"id": ident, "ok": False, "errno": error.errno or errno.EIO, "error": str(error.strerror or error)}))
        except Exception as error:  # a bug here must not leave the machine waiting
            self.send(frame({"id": ident, "ok": False, "errno": errno.EIO, "error": f"{type(error).__name__}: {error}"}))

    async def answer(self, h: dict, payload: bytes) -> tuple[dict, bytes]:
        share = self.share
        op = h.get("op")
        run = IOLoop.current().run_in_executor
        if op == "pack":
            return await run(None, self.pack, [str(p) for p in h.get("paths") or []])
        if op == "read":
            full = share.path(str(h.get("path")))
            offset, size = max(0, int(h.get("offset") or 0)), min(PIECE_MAX, max(0, int(h.get("size") or 0)))

            def read():
                with open(full, "rb") as f:
                    f.seek(offset)
                    return f.read(size)

            data = await run(None, read)
            return {"stat": stat_of(full)}, data
        if op == "stat":
            return {"stat": stat_of(share.path(str(h.get("path"))))}, b""
        if op == "list":
            rel_dir = str(h.get("path") or "").strip("/")
            entries = await run(None, share.entries, rel_dir)
            share.watch(rel_dir, entries)
            return {"entries": entries}, b""
        if op == "rmtree":
            # A folder and all in it, as a network drive deletes one (WebDAV DELETE): here, not file by file over the wire.
            rel = str(h.get("path"))
            full = share.path(rel)
            await run(None, lambda: shutil.rmtree(full) if full.is_dir() and not full.is_symlink() else os.unlink(full))
            share.noted(rel, None, self)
            return {}, b""
        if op == "copy":
            a, b = str(h.get("path")), str(h.get("to"))
            fa, fb = share.path(a), share.path(b)

            def copy():
                fb.parent.mkdir(parents=True, exist_ok=True)
                if fa.is_dir():
                    shutil.copytree(fa, fb, dirs_exist_ok=True)
                else:
                    shutil.copy2(fa, fb)

            await run(None, copy)
            share.noted(b, stat_of(fb) if fb.is_file() else None, self)
            return {}, b""
        if op == "statfs":
            usage = await run(None, shutil.disk_usage, share.root)
            return {"total": usage.total, "free": usage.free, "used": usage.used}, b""
        if op == "write":
            rel = str(h.get("path"))
            full = share.path(rel)
            st = await run(None, self.write_piece, rel, full, int(h.get("offset") or 0), bool(h.get("last")), h.get("mode"), payload)
            if st is not None:
                share.noted(rel, st, self)
            return ({"stat": st} if st else {}), b""
        if op == "unlink":
            rel = str(h.get("path"))
            full = share.path(rel)
            await run(None, os.unlink, full)
            share.noted(rel, None, self)
            return {}, b""
        if op == "mkdir":
            rel = str(h.get("path"))
            await run(None, lambda: share.path(rel).mkdir(parents=True, exist_ok=True))
            share.dirs.add(rel)
            return {}, b""
        if op == "rmdir":
            rel = str(h.get("path"))
            full = share.path(rel)
            await run(None, os.rmdir, full)
            share.dirs.discard(rel)
            share.broadcast({"op": "dirs", "added": [], "removed": [rel]}, skip=self)
            return {}, b""
        if op == "rename":
            a, b = str(h.get("path")), str(h.get("to"))
            fa, fb = share.path(a), share.path(b)

            def move():
                fb.parent.mkdir(parents=True, exist_ok=True)
                os.replace(fa, fb)

            await run(None, move)
            # A folder renamed: the next look sends what moved; a file: the tree knows both ends now.
            if fb.is_file():
                share.noted(a, None, self)
                share.noted(b, stat_of(fb), self)
            return {}, b""
        if op == "chmod":
            rel = str(h.get("path"))
            full = share.path(rel)
            await run(None, os.chmod, full, int(h.get("mode") or 0o644) & 0o7777)
            share.noted(rel, stat_of(full), self)
            return {"stat": stat_of(full)}, b""
        raise OSError(errno.ENOSYS, f"unknown op {op!r}")

    def pack(self, paths: list[str]) -> tuple[dict, bytes]:
        out = io.BytesIO()
        stats: dict[str, list] = {}
        total = 0
        with tarfile.open(fileobj=out, mode="w:gz", compresslevel=3) as tar:
            for rel in paths:
                try:
                    full = self.share.path(rel)
                    st = stat_of(full)
                except OSError:
                    continue
                if total + st[0] > PACK_MAX and stats:
                    break
                try:
                    tar.add(str(full), arcname=rel, recursive=False)
                except OSError:
                    continue
                stats[rel] = st
                total += st[0]
        return {"files": stats}, out.getvalue()

    def write_piece(self, rel: str, full: Path, offset: int, last: bool, mode, payload: bytes):
        """A piece of a file from the machine: into a part file beside it, put in place whole at the last piece."""
        part = full.with_name(f"{full.name}.koios-part-{id(self):x}")
        handle = self.writes.get(rel)
        if offset == 0:
            if handle is not None:
                handle.close()
            full.parent.mkdir(parents=True, exist_ok=True)
            handle = open(part, "wb")
            self.writes[rel] = handle
        elif handle is None:
            raise OSError(errno.EIO, f"{rel}: a piece came with no start")
        handle.seek(offset)
        handle.write(payload)
        if not last:
            return None
        handle.close()
        self.writes.pop(rel, None)
        if mode is not None:
            os.chmod(part, int(mode) & 0o7777)
        elif full.exists():
            os.chmod(part, stat.S_IMODE(full.stat().st_mode))
        os.replace(part, full)
        return stat_of(full)


def connected(root: Path) -> int:
    share = Share.all.get(str(root.resolve()))
    return len(share.conns) if share else 0


# ------------------------------------------------------------- starting it there --


def remote_code(script: bytes, url: str, key: str, folder: str, mode: str) -> str:
    """Run in the compute link's kernel there: koios_mount.py written beside its state, fusepy (and libfuse, as root)
    installed when the fuse mode can be had, and the daemon started. Prints its status as JSON."""
    return f"""
import base64 as _b, json as _j, os as _o, subprocess as _s, sys as _y, importlib as _i
_home = _o.environ.get('KOIOS_MOUNT_HOME') or _o.path.expanduser('~/.koios-mount')
_o.makedirs(_home, exist_ok=True)
_p = _o.path.join(_home, 'koios_mount.py')
open(_p, 'wb').write(_b.b64decode({base64.b64encode(script).decode()!r}))
_mode = {mode!r}
if _mode != 'mirror' and _o.path.exists('/dev/fuse'):
    try:
        import fuse as _f
    except ImportError:
        _s.run([_y.executable, '-m', 'pip', 'install', '-q', 'fusepy'], stdout=_s.DEVNULL, stderr=_s.DEVNULL)
    except OSError:
        pass
    try:
        _i.invalidate_caches(); import fuse as _f
    except OSError:
        if _o.geteuid() == 0:
            _s.run('(command -v apt-get >/dev/null && apt-get install -y -q fuse libfuse2 || apt-get install -y -q fuse libfuse2t64) >/dev/null 2>&1', shell=True)
    except ImportError:
        pass
_y.path.insert(0, _home)
import koios_mount as _k
_i.reload(_k)
_at = {folder!r}
_at = _at if _at.startswith('/') else _o.path.join(_o.getcwd(), _at)
print('KOIOS-MOUNT ' + _j.dumps(_k.start({url!r}, {key!r}, _k.Path(_at), _mode)))
"""


def stop_code(folder: str) -> str:
    return f"""
import json as _j, os as _o, sys as _y
_home = _o.environ.get('KOIOS_MOUNT_HOME') or _o.path.expanduser('~/.koios-mount')
_y.path.insert(0, _home)
try:
    import koios_mount as _k
    _at = {folder!r}
    _at = _at if _at.startswith('/') else _o.path.join(_o.getcwd(), _at)
    print('KOIOS-MOUNT ' + _j.dumps({{'stopped': _k.stop(_k.Path(_at)), **_k.read_status(_k.Path(_at))}}))
except ImportError:
    print('KOIOS-MOUNT ' + _j.dumps({{'stopped': False, 'running': False}}))
"""


def status_code(folder: str) -> str:
    return f"""
import json as _j, os as _o, sys as _y
_home = _o.environ.get('KOIOS_MOUNT_HOME') or _o.path.expanduser('~/.koios-mount')
_y.path.insert(0, _home)
try:
    import koios_mount as _k
    _at = {folder!r}
    _at = _at if _at.startswith('/') else _o.path.join(_o.getcwd(), _at)
    print('KOIOS-MOUNT ' + _j.dumps(_k.read_status(_k.Path(_at))))
except ImportError:
    print('KOIOS-MOUNT ' + _j.dumps({{'running': False}}))
"""


async def run_there(remote: compute.Remote, code: str, timeout: float = 600) -> dict:
    """Code run in the link's kernel there, and the JSON it prints after KOIOS-MOUNT."""
    printed: list[str] = []
    future = asyncio.get_running_loop().create_future()
    msg_id = remote.send("execute_request", {"code": code, "silent": False, "store_history": False, "user_expressions": {}, "allow_stdin": False, "stop_on_error": True})
    remote.waiting[msg_id] = future
    remote.streams = getattr(remote, "streams", {})
    remote.streams[msg_id] = printed
    try:
        reply = await asyncio.wait_for(future, timeout)
    finally:
        remote.streams.pop(msg_id, None)
    if reply.get("status") != "ok":
        raise compute.ComputeError(f"the machine refused the mount: {reply.get('ename')}: {reply.get('evalue')}")
    for line in "".join(printed).splitlines():
        if line.startswith("KOIOS-MOUNT "):
            return json.loads(line[len("KOIOS-MOUNT "):])
    raise compute.ComputeError("the machine said nothing about the mount: " + "".join(printed)[-300:])


def script() -> bytes:
    return (Path(__file__).parent / "koios_mount.py").read_bytes()


async def start_remote(remote: compute.Remote, url: str, key: str, mode: str = "auto") -> dict:
    return await run_there(remote, remote_code(script(), url, key, remote.link["folder"], mode))


async def stop_remote(remote: compute.Remote) -> dict:
    return await run_there(remote, stop_code(remote.link["folder"]), timeout=60)


async def status_remote(remote: compute.Remote) -> dict:
    return await run_there(remote, status_code(remote.link["folder"]), timeout=60)
