"""The project's compute, from this computer's own terminal: `koios run`, `koios shell`, `koios push`, `koios pull`.

When a project's files are on this computer and its code runs elsewhere — Colab, a GPU server of yours — the page
hands the Companion the way to reach that machine's Jupyter server (POST companion/compute: its address and a pass,
for Colab the runtime proxy's token, which the page renews while it is open). From then on the shell here works
with the files here, at the speed of a local shell, and reaches the machine only when asked:

  koios run python train.py     the changed files copied over, the command run there, its output here
  koios shell                   a shell there, in this terminal
  koios push                    the changed files copied over, nothing run
  koios pull outputs/           files from there, here
  koios status                  where the project runs, and whether it can be reached
  koios mount                   the folder mounted there instead of copied: live both ways, nothing to push
  koios unmount                 back to copying before each run

Nothing here polls. The client opens one WebSocket to a small kernel of its own on that machine (started once, kept
apart from the notebook's, so a long cell doesn't hold the shell up) and talks to it in Jupyter comms: keys go out
as comm messages, and what the shell prints comes back the moment it is printed, from a thread on the machine. Files
go as one gzip'd tar, only those changed since the last push, through the same socket.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import io
import json
import os
import re
import shutil
import signal
import sys
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from . import state

COLAB_HOST = "https://colab.research.google.com"
CLIENT_AGENT = "reader"
CHUNK = 256 * 1024
# Bigger than this, a file is left out of a push unless asked (--big): data and weights belong on the machine.
BIG = 100 * 1024 * 1024
# Always left out of a push, whatever the project's own rules: what is this computer's, or rebuilt there.
ALWAYS_SKIP = ".git/\n.reader/\n__pycache__/\n.ipynb_checkpoints/\n.venv/\nvenv/\nnode_modules/\n.DS_Store\n"
KERNEL_V = 2


class ComputeError(Exception):
    pass


# ------------------------------------------------------------------ the link --


def links_dir() -> Path:
    return state.config_dir() / "compute"


def link_file(root: Path) -> Path:
    return links_dir() / f"{hashlib.sha1(str(root.resolve()).encode()).hexdigest()[:16]}.json"


def save_link(root: Path, compute: dict | None) -> dict | None:
    """The way to the project's compute, kept for the shell (0600, beside the Companion's own settings); None forgets it."""
    path = link_file(root)
    if compute is None:
        path.unlink(missing_ok=True)
        return None
    kind = compute.get("kind")
    url = str(compute.get("url") or "")
    if kind not in ("colab", "jupyter") or not re.match(r"^https?://", url):
        raise ComputeError("the compute needs a kind (colab or jupyter) and an http(s) address")
    old = load_link_file(path) or {}
    link = {
        "root": str(root.resolve()),
        "kind": kind,
        "url": url if url.endswith("/") else url + "/",
        "token": str(compute.get("token") or ""),
        "expiresAt": int(compute.get("expiresAt") or 0),
        "label": str(compute.get("label") or ("Colab" if kind == "colab" else "the server"))[:120],
        "folder": str(compute.get("folder") or "").strip("/"),
        "ignore": str(compute.get("ignore") or "")[:20_000],
        "at": int(time.time() * 1000),
    }
    # The kernel of ours there is kept while the machine is the same one.
    if old.get("url") == link["url"] and old.get("kernel"):
        link["kernel"] = old["kernel"]
    # ... and so is the mount there (mount.py): a new machine has none until it is started on it.
    if old.get("url") == link["url"] and old.get("mount"):
        link["mount"] = old["mount"]
    links_dir().mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(link, indent=2))
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return link


def load_link_file(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def find_link(cwd: Path) -> dict | None:
    """The link of the project the folder is in: the one whose folder holds it, the deepest first."""
    here = cwd.resolve()
    best = None
    for path in links_dir().glob("*.json") if links_dir().is_dir() else []:
        link = load_link_file(path)
        if not link or not link.get("root"):
            continue
        root = Path(link["root"])
        if (here == root or root in here.parents) and (best is None or len(str(root)) > len(best["root"])):
            best = link
    return best


def update_link(link: dict, **fields) -> None:
    path = link_file(Path(link["root"]))
    saved = load_link_file(path) or link
    saved.update(fields)
    link.update(fields)
    path.write_text(json.dumps(saved, indent=2))


def public(link: dict | None) -> dict:
    """What the page is told of a link: never the token."""
    if not link:
        return {"linked": False}
    return {"linked": True, "kind": link["kind"], "label": link["label"], "folder": link["folder"], "expiresAt": link["expiresAt"], "kernel": bool(link.get("kernel")), "mounted": bool(link.get("mount"))}


# ------------------------------------------------------------ the ignore rules --


def matches_rule(rule: str, path: str) -> bool:
    """One gitignore-like line, as the page reads them (src/lib/playground.ts, matchesRule)."""
    line = rule.strip()
    if not line or line.startswith("#"):
        return False
    anchored = line.startswith("/")
    body = line.strip("/")
    parts = []
    for part in body.split("/"):
        if part == "**":
            parts.append(".*")
        else:
            parts.append(re.escape(part).replace(r"\*", "[^/]*").replace(r"\?", "[^/]"))
    pattern = "/".join(parts).replace(".*/", "(?:.*/)?")
    lead = "^" if anchored or "/" in body else "^(?:.*/)?"
    return re.match(f"{lead}{pattern}(?:/.*)?$", path) is not None


def ignored(rules: str, path: str) -> bool:
    return any(matches_rule(rule, path) for rule in rules.split("\n"))


def local_files(root: Path, rules: str) -> dict[str, tuple[int, int]]:
    """Every file under root the rules let through: path → (size, mtime in ns)."""
    rules = ALWAYS_SKIP + "\n" + rules
    found: dict[str, tuple[int, int]] = {}
    for folder, dirs, names in os.walk(root):
        here = Path(folder)
        rel_dir = here.relative_to(root).as_posix()
        dirs[:] = sorted(d for d in dirs if not ignored(rules, f"{rel_dir}/{d}" if rel_dir != "." else d))
        for name in sorted(names):
            rel = f"{rel_dir}/{name}" if rel_dir != "." else name
            if ignored(rules, rel):
                continue
            full = here / name
            try:
                info = full.stat()
            except OSError:
                continue
            if full.is_file() and not full.is_symlink():
                found[rel] = (info.st_size, info.st_mtime_ns)
    return found


# ------------------------------------------------------- on the machine's side --

# Run once in our kernel there (again only when KERNEL_V changes): the comm targets the client opens. Standard
# library only; a thread per shell pushes what it prints as it prints it.
KERNEL_CODE = r"""
if globals().get('_koios_v') != %(v)d:
    import os, pty, json, threading, fcntl, struct, termios, signal, base64, tarfile, tempfile, shutil, time
    def _koios_manager():
        k = get_ipython().kernel
        m = getattr(k, 'comm_manager', None)
        if m is None:
            import comm as _c
            m = _c.get_comm_manager()
        return m
    _koios_home = os.getcwd()
    def _koios_dir(folder):
        # Relative to where the server starts its kernels (Colab: /content), as the page's own folder is.
        d = folder if folder.startswith('/') else os.path.join(_koios_home, folder)
        os.makedirs(d, exist_ok=True)
        return d
    def _koios_safe(name):
        parts = name.replace('\\', '/').split('/')
        return name and not name.startswith('/') and '..' not in parts
    def _koios_shell(comm, msg):
        d = msg['content']['data']
        cwd = _koios_dir(d.get('folder') or '')
        pid, fd = pty.fork()
        if pid == 0:
            try:
                os.chdir(cwd)
            except Exception:
                pass
            env = dict(os.environ)
            env.update({'TERM': 'xterm-256color', 'COLORTERM': 'truecolor', 'PATH': os.pathsep.join([os.path.expanduser('~/.local/bin'), '/usr/local/bin', env.get('PATH', '')])})
            env.update(d.get('env') or {})
            env.pop('JPY_PARENT_PID', None)
            # The kernel's prompt settings are its own shell's (a zsh theme's, say): bash makes its own.
            for k in ('PS1', 'PS2', 'PROMPT_COMMAND'):
                env.pop(k, None)
            argv = d.get('argv') or ['bash', '-i']
            try:
                os.execvpe(argv[0], argv, env)
            except Exception as e:
                os.write(2, ('koios: %%s\r\n' %% e).encode())
                os._exit(127)
        def size(rows, cols):
            try:
                fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', int(rows), int(cols), 0, 0))
            except Exception:
                pass
        size(d.get('rows') or 24, d.get('cols') or 80)
        done = {'v': False}
        def pump():
            while True:
                try:
                    out = os.read(fd, 65536)
                except OSError:
                    break
                if not out:
                    break
                comm.send({'o': base64.b64encode(out).decode()})
            try:
                _, status = os.waitpid(pid, 0)
                code = os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else (status >> 8)
            except Exception:
                code = -1
            done['v'] = True
            try:
                os.close(fd)
            except OSError:
                pass
            comm.send({'x': code})
            comm.close()
        def on_msg(m):
            x = m['content']['data']
            if 'i' in x:
                try:
                    os.write(fd, base64.b64decode(x['i']))
                except OSError:
                    pass
            if 'r' in x:
                size(*x['r'])
            if 'k' in x and not done['v']:
                try:
                    os.killpg(os.getpgid(pid), getattr(signal, 'SIG' + x['k']))
                except Exception:
                    pass
        def on_close(m):
            if not done['v']:
                try:
                    os.killpg(os.getpgid(pid), signal.SIGHUP)
                except Exception:
                    pass
        comm.on_msg(on_msg)
        comm.on_close(on_close)
        threading.Thread(target=pump, daemon=True).start()
    def _koios_record(base):
        try:
            with open(os.path.join(base, '.reader', 'koios-pushed.json')) as f:
                return json.load(f)
        except Exception:
            return {}
    def _koios_push(comm, msg):
        d = msg['content']['data']
        base = _koios_dir(d.get('folder') or '')
        files = d.get('files') or {}
        # Here but held back (too big): still here, so never "gone"; just not sent.
        held = set(d.get('held') or [])
        record = _koios_record(base)
        need = []
        for path, (size, mtime) in files.items():
            if not _koios_safe(path) or path in held:
                continue
            full = os.path.join(base, path)
            if record.get(path) == [size, mtime] and os.path.isfile(full) and os.path.getsize(full) == size:
                continue
            need.append(path)
        # Gone here since the last push: removed there too, only what a push put there and nothing has changed since.
        gone = [p for p, (size, _) in record.items() if p not in files and _koios_safe(p) and os.path.isfile(os.path.join(base, p)) and os.path.getsize(os.path.join(base, p)) == size]
        handle = tempfile.TemporaryFile()
        def on_msg(m):
            x = m['content']['data']
            if 'c' in x:
                handle.write(base64.b64decode(x['c']))
            if x.get('end'):
                try:
                    count = 0
                    if handle.tell():
                        handle.seek(0)
                        with tarfile.open(fileobj=handle, mode='r:gz') as tar:
                            for member in tar.getmembers():
                                if not member.isfile() or not _koios_safe(member.name):
                                    continue
                                target = os.path.join(base, member.name)
                                os.makedirs(os.path.dirname(target), exist_ok=True)
                                with tar.extractfile(member) as src, open(target + '.koios-part', 'wb') as out:
                                    shutil.copyfileobj(src, out)
                                os.replace(target + '.koios-part', target)
                                count += 1
                    for p in gone:
                        try:
                            os.remove(os.path.join(base, p))
                        except OSError:
                            pass
                    kept = {p: v for p, v in record.items() if p not in gone}
                    for p in x.get('sent') or []:
                        if p in files:
                            kept[p] = files[p]
                    os.makedirs(os.path.join(base, '.reader'), exist_ok=True)
                    with open(os.path.join(base, '.reader', 'koios-pushed.json'), 'w') as f:
                        json.dump(kept, f)
                    comm.send({'done': count, 'removed': len(gone)})
                except Exception as e:
                    comm.send({'e': '%%s: %%s' %% (type(e).__name__, e)})
                finally:
                    handle.close()
                    comm.close()
        comm.on_msg(on_msg)
        comm.send({'need': need, 'gone': gone, 'base': base})
    def _koios_pull(comm, msg):
        d = msg['content']['data']
        base = _koios_dir(d.get('folder') or '')
        paths = [p.strip('/') for p in d.get('paths') or [] if _koios_safe(p.strip('/'))]
        def send():
            try:
                missing = [p for p in paths if not os.path.exists(os.path.join(base, p))]
                if missing:
                    comm.send({'e': 'not there: ' + ', '.join(missing)})
                    return
                with tempfile.TemporaryFile() as handle:
                    with tarfile.open(fileobj=handle, mode='w:gz', compresslevel=4) as tar:
                        for p in paths:
                            tar.add(os.path.join(base, p), arcname=p)
                    total = handle.tell()
                    handle.seek(0)
                    while True:
                        block = handle.read(%(chunk)d)
                        if not block:
                            break
                        comm.send({'c': base64.b64encode(block).decode()})
                comm.send({'end': total})
            except Exception as e:
                comm.send({'e': '%%s: %%s' %% (type(e).__name__, e)})
            finally:
                comm.close()
        threading.Thread(target=send, daemon=True).start()
    _m = _koios_manager()
    for _name, _fn in (('koios.shell', _koios_shell), ('koios.push', _koios_push), ('koios.pull', _koios_pull)):
        _m.register_target(_name, _fn)
    _koios_v = %(v)d
""" % {"v": KERNEL_V, "chunk": CHUNK}


# ------------------------------------------------------------ the connection --


def strip_xssi(text: str) -> str:
    return text[4:] if text.startswith(")]}'") else text


class Remote:
    """The machine's Jupyter server: its kernels over HTTP, and one kernel of ours over a WebSocket."""

    def __init__(self, link: dict):
        self.link = link
        self.session = uuid.uuid4().hex
        self.socket = None
        self.waiting: dict[str, asyncio.Future] = {}
        self.comms: dict[str, asyncio.Queue] = {}
        # What an execute_request printed, for the callers that read it (mount.run_there): msg_id → pieces.
        self.streams: dict[str, list] = {}
        self.reader: asyncio.Task | None = None

    def headers(self) -> dict:
        token = self.link["token"]
        if self.link["kind"] == "colab":
            return {"X-Colab-Runtime-Proxy-Token": token, "X-Colab-Client-Agent": CLIENT_AGENT}
        return {"Authorization": f"token {token}"} if token else {}

    def address(self, path: str, ws: bool = False, **query) -> str:
        url = urllib.parse.urljoin(self.link["url"], path)
        if self.link["token"]:
            query["colab-runtime-proxy-token" if self.link["kind"] == "colab" else "token"] = self.link["token"]
        if query:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(query)
        if ws:
            url = "wss://" + url[8:] if url.startswith("https://") else "ws://" + url[7:]
        return url

    def http(self, method: str, path: str, body=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.address(path), data=data, method=method, headers={"Accept": "application/json", **({"Content-Type": "application/json"} if data else {}), **self.headers()})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                text = strip_xssi(response.read().decode()).strip()
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                raise ComputeError(self.expired_words() or f"{self.link['label']} refused the pass ({error.code}): open the project in Koios to renew it") from None
            if error.code in (404, 410) and self.link["kind"] == "colab" and path == "api/kernels":
                raise ComputeError(f"{self.link['label']} is gone — Colab ends idle runtimes. Connect it again from the project in Koios.") from None
            raise ComputeError(f"{self.link['label']} answered {error.code} to {method} {path}") from None
        except (urllib.error.URLError, OSError) as error:
            raise ComputeError(f"{self.link['label']} can't be reached: {getattr(error, 'reason', error)}") from None
        return json.loads(text) if text else None

    def expired_words(self) -> str:
        at = self.link.get("expiresAt") or 0
        if self.link["kind"] == "colab" and at and at < time.time() * 1000:
            return f"the pass to {self.link['label']} ran out at {time.strftime('%H:%M', time.localtime(at / 1000))}: open the project in Koios (it renews the pass while it is open), then try again"
        return ""

    def kernel(self) -> str:
        """Our kernel there: the one we started before if it is still there, else a new one."""
        if self.expired_words():
            raise ComputeError(self.expired_words())
        kept = self.link.get("kernel")
        kernels = self.http("GET", "api/kernels") or []
        if kept and any(k.get("id") == kept for k in kernels):
            return kept
        made = self.http("POST", "api/kernels", {"name": "python3"})
        update_link(self.link, kernel=made["id"])
        return made["id"]

    async def open(self) -> None:
        from tornado.httpclient import HTTPRequest
        from tornado.websocket import websocket_connect

        kernel = await asyncio.get_running_loop().run_in_executor(None, self.kernel)
        headers = dict(self.headers())
        if self.link["kind"] == "colab":
            headers["Origin"] = COLAB_HOST
        request = HTTPRequest(self.address(f"api/kernels/{kernel}/channels", ws=True, session_id=self.session), headers=headers, connect_timeout=30, request_timeout=0)
        try:
            self.socket = await websocket_connect(request, max_message_size=64 * 1024 * 1024, ping_interval=20, ping_timeout=20)
        except Exception as error:
            raise ComputeError(f"the kernel on {self.link['label']} didn't take a connection: {error}") from None
        self.reader = asyncio.ensure_future(self.read())
        reply = await self.execute(KERNEL_CODE)
        if reply.get("status") != "ok":
            raise ComputeError(f"the kernel on {self.link['label']} refused the shell's helper: {reply.get('ename')}: {reply.get('evalue')}")

    def message(self, msg_type: str, content: dict, channel: str = "shell") -> dict:
        msg_id = uuid.uuid4().hex
        return {
            "header": {"msg_id": msg_id, "username": "koios", "session": self.session, "msg_type": msg_type, "version": "5.3", "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
            "parent_header": {},
            "metadata": {},
            "content": content,
            "channel": channel,
            "buffers": [],
        }

    def send(self, msg_type: str, content: dict) -> str:
        msg = self.message(msg_type, content)
        self.socket.write_message(json.dumps(msg))
        return msg["header"]["msg_id"]

    async def read(self) -> None:
        while True:
            text = await self.socket.read_message()
            if text is None:
                break
            if isinstance(text, bytes):
                continue  # the binary framing carries buffers; ours are JSON
            try:
                msg = json.loads(text)
            except ValueError:
                continue
            kind = msg.get("header", {}).get("msg_type") or msg.get("msg_type")
            content = msg.get("content") or {}
            parent = (msg.get("parent_header") or {}).get("msg_id")
            if kind == "execute_reply" and parent in self.waiting:
                self.waiting.pop(parent).set_result(content)
            elif kind == "stream" and parent in self.streams:
                self.streams[parent].append(content.get("text") or "")
            elif kind in ("comm_msg", "comm_close") and content.get("comm_id") in self.comms:
                self.comms[content["comm_id"]].put_nowait(None if kind == "comm_close" else content.get("data") or {})
        for queue in self.comms.values():
            queue.put_nowait(None)
        for future in self.waiting.values():
            if not future.done():
                future.set_exception(ComputeError(f"the connection to {self.link['label']} closed"))

    async def execute(self, code: str) -> dict:
        future = asyncio.get_running_loop().create_future()
        self.waiting[self.send("execute_request", {"code": code, "silent": True, "store_history": False, "user_expressions": {}, "allow_stdin": False, "stop_on_error": True})] = future
        return await asyncio.wait_for(future, 60)

    def comm(self, target: str, data: dict) -> "Comm":
        comm_id = uuid.uuid4().hex
        self.comms[comm_id] = asyncio.Queue()
        self.send("comm_open", {"comm_id": comm_id, "target_name": target, "data": data})
        return Comm(self, comm_id)

    def close(self) -> None:
        if self.socket:
            self.socket.close()


class Comm:
    def __init__(self, remote: Remote, comm_id: str):
        self.remote, self.id = remote, comm_id

    def send(self, data: dict) -> None:
        self.remote.send("comm_msg", {"comm_id": self.id, "data": data})

    async def next(self) -> dict | None:
        return await self.remote.comms[self.id].get()

    def close(self) -> None:
        try:
            self.remote.send("comm_close", {"comm_id": self.id, "data": {}})
        except Exception:
            pass


# ------------------------------------------------------------------ the work --


def remote_folder(link: dict, root: Path, cwd: Path) -> str:
    """The folder there for a folder here: the project's folder there, and the same place under it."""
    root = root.resolve()  # on a Mac /var is /private/var: both sides resolved, or one isn't "inside" the other
    inner = cwd.resolve().relative_to(root).as_posix() if cwd.resolve() != root else ""
    return "/".join(p for p in (link["folder"], inner if inner != "." else "") if p)


async def push(remote: Remote, root: Path, big: bool = False, say=lambda text: None) -> dict:
    files = local_files(root, remote.link.get("ignore") or "")
    left = {p: v for p, v in files.items() if v[0] > BIG} if not big else {}
    every = {p: [v[0], v[1]] for p, v in files.items()}
    started = time.monotonic()
    comm = remote.comm("koios.push", {"folder": remote.link["folder"], "files": every, "held": sorted(left)})
    first = await comm.next()
    if first is None or "e" in first:
        raise ComputeError((first or {}).get("e") or f"{remote.link['label']} closed the push")
    need = first.get("need") or []
    size = sum(every[p][0] for p in need)
    if need:
        say(f"↑ {len(need)} file{'s' if len(need) != 1 else ''} ({human(size)}) to {remote.link['label']}…")
    with tempfile.TemporaryFile() as handle:
        if need:
            with tarfile.open(fileobj=handle, mode="w:gz", compresslevel=4) as tar:
                for path in need:
                    tar.add(str(root / path), arcname=path, recursive=False)
            handle.seek(0)
            while True:
                block = handle.read(CHUNK)
                if not block:
                    break
                comm.send({"c": base64.b64encode(block).decode()})
        comm.send({"end": True, "sent": need})
    last = await comm.next()
    if last is None or "e" in last:
        raise ComputeError((last or {}).get("e") or f"{remote.link['label']} closed the push before it was in")
    return {"sent": need, "bytes": size, "removed": first.get("gone") or [], "unchanged": len(every) - len(left) - len(need), "big": sorted(left), "seconds": round(time.monotonic() - started, 2)}


async def pull(remote: Remote, root: Path, paths: list[str], cwd: Path) -> dict:
    root = root.resolve()
    inner = "" if cwd.resolve() == root else cwd.resolve().relative_to(root).as_posix()
    wanted = ["/".join(p for p in (inner, path.strip("/")) if p) for path in paths]
    comm = remote.comm("koios.pull", {"folder": remote.link["folder"], "paths": wanted})
    with tempfile.TemporaryFile() as handle:
        while True:
            data = await comm.next()
            if data is None:
                raise ComputeError(f"{remote.link['label']} closed before the files were sent")
            if "e" in data:
                raise ComputeError(data["e"])
            if "c" in data:
                handle.write(base64.b64decode(data["c"]))
            if "end" in data:
                break
        total = handle.tell()
        handle.seek(0)
        written = []
        with tarfile.open(fileobj=handle, mode="r:gz") as tar:
            for member in tar.getmembers():
                name = member.name
                parts = name.split("/")
                if not name or name.startswith("/") or ".." in parts:
                    continue
                target = root / name
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                elif member.isfile():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with tar.extractfile(member) as source, open(str(target) + ".koios-part", "wb") as out:
                        shutil.copyfileobj(source, out)
                    os.replace(str(target) + ".koios-part", target)
                    written.append(name)
    return {"files": written, "bytes": total}


async def attach(remote: Remote, folder: str, argv: list[str] | None) -> int:
    """A shell (or one command) there, in this terminal: keys out as they are typed, what it prints back as it prints."""
    loop = asyncio.get_running_loop()
    interactive = sys.stdin.isatty()
    cols, rows = shutil.get_terminal_size((80, 24))
    comm = remote.comm("koios.shell", {"folder": folder, "rows": rows, "cols": cols, "argv": argv, "env": {"KOIOS_REMOTE": "1"}})
    saved = None
    if interactive and os.name != "nt":
        import termios
        import tty

        saved = termios.tcgetattr(sys.stdin.fileno())
        tty.setraw(sys.stdin.fileno())

        def resized(*_):
            c, r = shutil.get_terminal_size((80, 24))
            loop.call_soon_threadsafe(comm.send, {"r": [r, c]})

        signal.signal(signal.SIGWINCH, resized)

        def keys():
            while True:
                try:
                    data = os.read(sys.stdin.fileno(), 4096)
                except OSError:
                    return
                if not data:
                    return
                loop.call_soon_threadsafe(comm.send, {"i": base64.b64encode(data).decode()})

        threading.Thread(target=keys, daemon=True).start()
    else:
        # Not a terminal (a pipe, a script): ⌃C here stops the command there.
        try:
            loop.add_signal_handler(signal.SIGINT, lambda: comm.send({"k": "INT"}))
        except (NotImplementedError, RuntimeError):
            pass
    out = sys.stdout.buffer
    code = 255
    try:
        while True:
            data = await comm.next()
            if data is None:
                out.write(f"\r\nkoios: the connection to {remote.link['label']} closed\r\n".encode())
                break
            if "o" in data:
                out.write(base64.b64decode(data["o"]))
                out.flush()
            if "x" in data:
                code = int(data["x"])
                break
    finally:
        if saved is not None:
            import termios

            termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, saved)
        comm.close()
    return code


def human(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1000 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" or value >= 100 else f"{value:.1f} {unit}"
        value /= 1000
    return f"{size} B"


def push_words(report: dict, label: str) -> str:
    sent = len(report["sent"])
    words = f"{sent} file{'s' if sent != 1 else ''} ({human(report['bytes'])}) to {label} in {report['seconds']} s" if sent else f"nothing new for {label}"
    extra = [f"{report['unchanged']} already there"] if report["unchanged"] else []
    if report["removed"]:
        extra.append(f"{len(report['removed'])} removed there")
    if report["big"]:
        extra.append(f"{len(report['big'])} over {human(BIG)} left out (--big sends them)")
    return f"↑ {words}" + (f" · {', '.join(extra)}" if extra else "")


# ------------------------------------------------------------- the Companion --


def companion_call(link: dict, body: dict | None, timeout: float = 600) -> dict:
    """The running Companion's companion/compute, as this computer's own program: no Origin, its token. For the
    mount, which the Companion holds (the socket, the tunnel), not this process."""
    config = state.load_config()
    token, port = config.get("token"), int(config.get("port") or 47321)
    if not token:
        raise ComputeError("the Koios Companion isn't set up on this computer")
    base = Path(config.get("root") or Path.home() / "Reader").expanduser().resolve()
    try:
        relative = Path(link["root"]).resolve().relative_to(base).as_posix()
    except ValueError:
        raise ComputeError(f"this project isn't in the Companion's folder ({base})") from None
    url = f"http://127.0.0.1:{port}/companion/compute"
    if body is None:
        request = urllib.request.Request(url + "?" + urllib.parse.urlencode({"root": relative}), headers={"Authorization": f"token {token}"})
    else:
        request = urllib.request.Request(url, data=json.dumps({"root": relative, **body}).encode(), method="POST", headers={"Authorization": f"token {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        try:
            words = json.loads(error.read()).get("error")
        except ValueError:
            words = None
        raise ComputeError(words or f"the Companion answered {error.code}") from None
    except (urllib.error.URLError, OSError) as error:
        raise ComputeError(f"the Companion isn't running here ({getattr(error, 'reason', error)}): open Koios, or run reader-companion start") from None


def mounted_now(link: dict) -> bool:
    """Whether the folder is mounted on the compute this moment: then there is nothing to push."""
    if not link.get("mount"):
        return False
    try:
        return bool(companion_call(link, None, timeout=3).get("mount", {}).get("connected"))
    except ComputeError:
        return False


def mount_words(status: dict, label: str) -> str:
    mode = "a FUSE mount" if status.get("mode") == "fuse" else "a live mirror (no FUSE there)"
    warm = status.get("warm") or {}
    first = f" · {warm.get('files', 0)} small files sent ahead in {warm.get('seconds', 0)} s" if warm.get("files") else ""
    return f"⇄ mounted on {label} at {status.get('at')}, as {mode}{first}. Saves here are there at once; what a run writes there is written here, and checkpoints go to the data place."


# ------------------------------------------------------------------ the CLI --


def run_async(coroutine):
    return asyncio.run(coroutine)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="koios", description="This project's compute — Colab, a GPU server — from this computer's terminal. The files stay here.")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("status", help="where the project runs, and whether it can be reached")
    p_push = sub.add_parser("push", help="copy the files changed since the last push to the machine")
    p_push.add_argument("--big", action="store_true", help=f"also send files over {human(BIG)}")
    p_run = sub.add_parser("run", help="push, then run a command there, here in this terminal: koios run python train.py")
    p_run.add_argument("--no-push", action="store_true", help="run on what is there already")
    p_run.add_argument("--big", action="store_true", help=f"also send files over {human(BIG)}")
    p_run.add_argument("-c", dest="line", help="a whole command line, run as it is by bash there (pipes, &&, quotes and all)")
    p_run.add_argument("cmd", nargs=argparse.REMAINDER)
    sub.add_parser("shell", help="a shell there, in this terminal (exit, or ⌃D, comes back)")
    p_pull = sub.add_parser("pull", help="bring files or folders from there, here: koios pull outputs/ model.pt")
    p_pull.add_argument("paths", nargs="+")
    p_mount = sub.add_parser("mount", help="mount this folder on the machine instead of copying it: live both ways")
    p_mount.add_argument("--mode", choices=("auto", "fuse", "mirror"), default="auto", help="fuse (a real mount) or mirror (a directory kept current); auto takes fuse where the machine allows it")
    sub.add_parser("unmount", help="stop the mount there; runs copy the changed files again")
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 0
    cwd = Path.cwd()
    link = find_link(cwd)
    if not link:
        print("koios: this folder isn't a project linked to a compute. Open the project in Koios with its files on this computer and its code on Colab or a server: the page links them.", file=sys.stderr)
        return 2
    root = Path(link["root"])
    label = link["label"]
    if args.command == "status":
        expires = link.get("expiresAt") or 0
        print(f"{root.name}: files here ({root}), code runs on {label}, in {link['folder'] or 'its home folder'}.")
        if link["kind"] == "colab" and expires:
            left = (expires - time.time() * 1000) / 60_000
            print(f"The pass to Colab {'runs out in %d min' % left if left > 0 else 'has run out: open the project in Koios to renew it'}.")
        if link.get("mount"):
            print(f"Mounted there ({link['mount'].get('mode')}): {'connected' if mounted_now(link) else 'not connected now — koios mount starts it again'}.")
        return 0
    if args.command in ("mount", "unmount"):
        try:
            if args.command == "mount":
                print(f"koios: mounting {root.name} on {label}…", file=sys.stderr)
                print(mount_words(companion_call(link, {"action": "mount", "mode": args.mode}), label))
            else:
                companion_call(link, {"action": "unmount"})
                print(f"koios: {label} no longer mounts {root.name}; runs copy the changed files before they start.")
        except ComputeError as error:
            print(f"koios: {error}", file=sys.stderr)
            return 1
        return 0

    async def work() -> int:
        remote = Remote(link)
        try:
            await remote.open()
            if args.command == "push":
                if mounted_now(link):
                    print(f"koios: {root.name} is mounted on {label}: it is there already, as it is here.")
                    return 0
                print(push_words(await push(remote, root, args.big, say=print), label))
                return 0
            if args.command == "pull":
                report = await pull(remote, root, args.paths, cwd)
                print(f"↓ {len(report['files'])} file{'s' if len(report['files']) != 1 else ''} ({human(report['bytes'])}) from {label}")
                return 0
            if args.command == "run":
                import shlex

                command = args.cmd[1:] if args.cmd[:1] == ["--"] else args.cmd
                line = args.line or " ".join(shlex.quote(c) for c in command)
                if not line.strip():
                    print("koios run: which command? koios run python train.py", file=sys.stderr)
                    return 2
                if not args.no_push and not mounted_now(link):
                    print(push_words(await push(remote, root, args.big), label), file=sys.stderr)
                return await attach(remote, remote_folder(link, root, cwd), ["bash", "-lc", line])
            if args.command == "shell":
                print(f"koios: a shell on {label} — exit or ⌃D to come back here.", file=sys.stderr)
                return await attach(remote, remote_folder(link, root, cwd), None)
        finally:
            remote.close()
        return 0

    try:
        return run_async(work())
    except ComputeError as error:
        print(f"koios: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
