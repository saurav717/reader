"""Copy-before-run against the mount, measured, at three network distances. Not a unit test: it prints the numbers
docs/compute-mount-process.md charts.

    cd companion && python -m tests.bench_mount            # JSON on stdout, progress on stderr

Both run on this computer: a Jupyter server stands in for the GPU machine (for the copy, `koios push` as `koios run`
does it), and the Companion's mount socket serves the folder (for the mount, FUSE where it can, else the mirror).
Between them and the machine sits a small proxy that holds every byte back for a fixed time each way, so a round
trip of 0, 50 or 150 ms stands in for a machine in the same city, the same continent, or across an ocean. It does
not limit bandwidth, and it is not Cloudflare: tests/live_tunnel.py measures a real tunnel.

The project: 300 small Python modules a package imports, and a 6 MB file.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

from reader_companion import compute, koios_mount, mount, state

MODULES = 300
RTTS_MS = [0, 50, 150]


def say(text: str) -> None:
    print(text, file=sys.stderr, flush=True)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def until(check, timeout=60.0, every=0.005) -> float:
    started = time.monotonic()
    while time.monotonic() - started < timeout:
        try:
            if check():
                return time.monotonic() - started
        except OSError:
            pass
        time.sleep(every)
    raise TimeoutError("timed out")


class DelayProxy:
    """TCP on 127.0.0.1:port to 127.0.0.1:target, every chunk delivered `one_way` seconds after it was read, in order."""

    def __init__(self, target: int, one_way: float):
        self.target, self.one_way = target, one_way
        self.port = free_port()
        self.loop = asyncio.new_event_loop()
        ready = threading.Event()

        def run():
            asyncio.set_event_loop(self.loop)
            self.server = self.loop.run_until_complete(asyncio.start_server(self.handle, "127.0.0.1", self.port))
            ready.set()
            self.loop.run_forever()

        threading.Thread(target=run, daemon=True).start()
        ready.wait(5)

    async def pipe(self, reader, writer):
        queue: asyncio.Queue = asyncio.Queue()

        async def deliver():
            while True:
                at, data = await queue.get()
                if data is None:
                    break
                wait = at - self.loop.time()
                if wait > 0:
                    await asyncio.sleep(wait)
                writer.write(data)
                await writer.drain()
            writer.close()

        task = asyncio.ensure_future(deliver())
        try:
            while True:
                data = await reader.read(65536)
                if not data:
                    break
                queue.put_nowait((self.loop.time() + self.one_way, data))
        except ConnectionError:
            pass
        queue.put_nowait((0, None))
        await task

    async def handle(self, reader, writer):
        try:
            up_reader, up_writer = await asyncio.open_connection("127.0.0.1", self.target)
        except OSError:
            writer.close()
            return
        await asyncio.gather(self.pipe(reader, up_writer), self.pipe(up_reader, writer), return_exceptions=True)

    def close(self):
        self.loop.call_soon_threadsafe(self.server.close)


def make_project(root: Path) -> None:
    (root / "pkg").mkdir(parents=True)
    lines = []
    for i in range(MODULES):
        (root / "pkg" / f"m{i}.py").write_text(f"VALUE_{i} = {i}\n" + "".join(f"def f{j}(x):\n    return x * {j}\n" for j in range(40)))
        lines.append(f"from . import m{i}")
    (root / "pkg" / "__init__.py").write_text("\n".join(lines) + "\n")
    (root / "weights.txt").write_bytes(os.urandom(6 * 1024 * 1024))
    (root / "main.py").write_text("import pkg\nprint('ok')\n")


def import_time(cwd: Path) -> float:
    code = "import time, sys; sys.dont_write_bytecode = True; t = time.perf_counter(); import pkg; print(time.perf_counter() - t)"
    out = subprocess.run([sys.executable, "-B", "-c", code], cwd=cwd, capture_output=True, text=True, timeout=600)
    if out.returncode:
        raise RuntimeError(out.stderr)
    return float(out.stdout.strip())


def bench() -> dict:
    tmp = Path(tempfile.mkdtemp())
    os.environ["READER_COMPANION_HOME"] = str(tmp / "home")
    os.environ["KOIOS_MOUNT_HOME"] = str(tmp / "mounts")
    # The background copy would race the cold read; it is measured on its own below.
    os.environ["KOIOS_MOUNT_FILL_MB"] = "0"
    root = tmp / "Reader" / "playgrounds" / "bench"
    make_project(root)
    state.current = state.Companion(name="Laptop", token="t", id="0123456789abcdef", site="https://koios.dev/", root=str(tmp / "Reader"), version="bench")

    # The Companion's socket.
    mount_port = free_port()
    ready = threading.Event()
    holder: dict = {}

    def serve():
        from tornado.ioloop import IOLoop
        from tornado.web import Application

        asyncio.set_event_loop(asyncio.new_event_loop())
        Application([(r"/companion/mount/socket", mount.MountSocket)], websocket_max_message_size=256 * 1024 * 1024).listen(mount_port, "127.0.0.1")
        holder["loop"] = IOLoop.current()
        ready.set()
        holder["loop"].start()

    threading.Thread(target=serve, daemon=True).start()
    ready.wait(5)

    # The GPU machine's Jupyter server, for the copy.
    there = tmp / "gpu"
    there.mkdir()
    jport = free_port()
    jupyter = subprocess.Popen(
        [sys.executable, "-m", "jupyter_server", "--allow-root", "--no-browser", f"--port={jport}", "--IdentityProvider.token=abc", f"--ServerApp.root_dir={there}"],
        cwd=there, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    until(lambda: urllib.request.urlopen(f"http://127.0.0.1:{jport}/api/status?token=abc", timeout=1).status == 200, 60, 0.2)

    mode = "fuse" if not koios_mount.fuse_available() else "mirror"
    results: dict = {"mode": mode, "modules": MODULES, "local_import_s": round(statistics.median(import_time(root) for _ in range(3)), 3), "rtts": []}
    say(f"local disk: import of {MODULES} modules {results['local_import_s']} s; mode {mode}")
    try:
        for rtt in RTTS_MS:
            row: dict = {"rtt_ms": rtt}
            # ---- the copy, as koios run does it: a connection to the machine, the changed files, per command
            jproxy = DelayProxy(jport, rtt / 2000)
            folder = f"playgrounds/copy-{rtt}"
            link = compute.save_link(root, {"kind": "jupyter", "url": f"http://127.0.0.1:{jproxy.port}/", "token": "abc", "label": "GPU", "folder": folder, "ignore": "*.pt\n"})

            async def push_once():
                remote = compute.Remote(link)
                started = time.monotonic()
                await remote.open()
                connected = time.monotonic() - started
                report = await compute.push(remote, root)
                remote.close()
                return time.monotonic() - started, connected, len(report["sent"])

            first, _, sent = asyncio.run(push_once())
            (root / "pkg" / "m7.py").write_text((root / "pkg" / "m7.py").read_text() + "# edited\n")
            again, connect_s, sent_again = asyncio.run(push_once())
            row["copy"] = {"first_push_s": round(first, 3), "files": sent, "edit_push_s": round(again, 3), "connect_s": round(connect_s, 3), "edit_files": sent_again, "import_s": round(import_time(there / folder), 3)}
            jproxy.close()
            say(f"rtt {rtt} ms · copy: first push {first:.2f} s ({sent} files), after one edit {again:.2f} s (of which connecting {connect_s:.2f} s)")

            # ---- the mount
            mproxy = DelayProxy(mount_port, rtt / 2000)
            at = tmp / "gpu" / f"mount-{rtt}"
            key = mount.key_for(root)
            log = open(tmp / f"daemon-{rtt}.log", "wb")
            started = time.monotonic()
            daemon = subprocess.Popen([sys.executable, koios_mount.__file__, "serve", f"--url=ws://127.0.0.1:{mproxy.port}/companion/mount/socket", f"--key={key}", f"--at={at}", f"--mode={mode}"], stdout=log, stderr=log, env=dict(os.environ))
            until(lambda: koios_mount.read_status(at).get("ready") and koios_mount.read_status(at).get("mounted"), 300, 0.01)
            ready_s = time.monotonic() - started
            m = {"ready_s": round(ready_s, 3), "warm": koios_mount.read_status(at).get("warm"), "import_s": round(import_time(at), 3)}
            if mode == "fuse":
                t = time.monotonic()
                (at / "weights.txt").read_bytes()
                m["cold_read_6MB_s"] = round(time.monotonic() - t, 3)
                t = time.monotonic()
                (at / "weights.txt").read_bytes()
                m["cached_read_6MB_s"] = round(time.monotonic() - t, 4)
            pushes, backs = [], []
            for i in range(7):
                text = f"VALUE = {rtt * 100 + i}\n"
                (root / "pkg" / "m0.py").write_text(text)
                pushes.append(until(lambda: (at / "pkg" / "m0.py").read_text() == text, 30))
                body = json.dumps({"rtt": rtt, "i": i})
                (at / f"result{i}.json").write_text(body)
                backs.append(until(lambda: (root / f"result{i}.json").exists() and (root / f"result{i}.json").read_text() == body, 30))
                (root / f"result{i}.json").unlink()
            m["edit_visible_s"] = round(statistics.median(pushes), 3)
            m["write_back_s"] = round(statistics.median(backs), 3)
            row["mount"] = m
            koios_mount.stop(at)
            daemon.wait(10)
            log.close()
            mproxy.close()
            say(f"rtt {rtt} ms · mount: ready {ready_s:.2f} s, import {m['import_s']} s, an edit visible in {m['edit_visible_s']} s, a write back in {m['write_back_s']} s")
            results["rtts"].append(row)
        return results
    finally:
        jupyter.terminate()
        jupyter.wait(10)
        holder.get("loop") and holder["loop"].add_callback(holder["loop"].stop)
        state.current = None
        shutil.rmtree(tmp, True)


if __name__ == "__main__":
    print(json.dumps(bench(), indent=2))
