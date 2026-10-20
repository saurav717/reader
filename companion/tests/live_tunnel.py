"""The mount over a real Cloudflare tunnel, measured. Not part of the unit tests: it needs cloudflared to reach
Cloudflare's edge (TCP or UDP 7844 out, and DNS for argotunnel.com), which CI sandboxes usually block.

    cd companion && python3 -m tests.live_tunnel            # a quick tunnel (trycloudflare.com)
    KOIOS_LIVE_HOSTNAME=koios.example.com KOIOS_LIVE_TUNNEL_TOKEN=… python3 -m tests.live_tunnel   # your named one (Argo)
    KOIOS_LIVE_TUNNEL=1 python3 -m unittest tests.live_tunnel                                         # as a test

Both ends run on this computer: the Companion's socket serving a folder, and the daemon mounting it (FUSE where
/dev/fuse is, else the mirror) — but the daemon dials the tunnel's public address, so every byte goes out to
Cloudflare's edge and back in through cloudflared, as it does from Colab. Run it on the GPU machine instead with
KOIOS_LIVE_URL=wss://<tunnel>/companion/mount/socket KOIOS_LIVE_KEY=<key> to measure the real path.

It prints: how long the mount took to be ready (the tree and the first archives), a cold read of a 6 MB file and a
cached one, the time from a save on this side to the file being there (the push), the time from a write there to the
file being here, and the round trip of a small read.
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
import unittest
from pathlib import Path

from reader_companion import compute, koios_mount, mount, state, tunnel


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def until(check, timeout=60.0, every=0.01):
    started = time.monotonic()
    while time.monotonic() - started < timeout:
        try:
            if check():
                return time.monotonic() - started
        except OSError:
            pass
        time.sleep(every)
    raise TimeoutError("timed out")


def measure(say=print) -> dict:
    tmp = Path(tempfile.mkdtemp())
    os.environ["READER_COMPANION_HOME"] = str(tmp / "home")
    os.environ["KOIOS_MOUNT_HOME"] = str(tmp / "mounts")
    root = tmp / "Reader" / "playgrounds" / "live"
    (root / "pkg").mkdir(parents=True)
    for i in range(200):
        (root / "pkg" / f"m{i}.py").write_text(f"VALUE = {i}\n" + "# padding\n" * 50)
    (root / "weights.txt").write_bytes(os.urandom(6 * 1024 * 1024))
    compute.save_link(root, {"kind": "jupyter", "url": "http://127.0.0.1:1/", "token": "t", "label": "live", "folder": "playgrounds/live", "ignore": "*.pt\n"})
    state.current = state.Companion(name="This computer", token="t", id="0123456789abcdef", site="https://koios.dev/", root=str(tmp / "Reader"), version="live")
    port = free_port()
    ready = threading.Event()
    holder = {}

    def serve():
        from tornado.ioloop import IOLoop
        from tornado.web import Application

        asyncio.set_event_loop(asyncio.new_event_loop())
        Application([(r"/companion/mount/socket", mount.MountSocket)], websocket_max_message_size=256 * 1024 * 1024).listen(port, "127.0.0.1")
        holder["loop"] = IOLoop.current()
        ready.set()
        holder["loop"].start()

    threading.Thread(target=serve, daemon=True).start()
    ready.wait(5)
    result: dict = {}
    running = None
    daemon = None
    at = tmp / "gpu" / "playgrounds" / "live"
    try:
        url, key = os.environ.get("KOIOS_LIVE_URL"), os.environ.get("KOIOS_LIVE_KEY")
        if not url:
            started = time.monotonic()
            config = {"tunnel_token": os.environ["KOIOS_LIVE_TUNNEL_TOKEN"], "tunnel_hostname": os.environ["KOIOS_LIVE_HOSTNAME"], "tunnel_port": port} if os.environ.get("KOIOS_LIVE_TUNNEL_TOKEN") else {}
            running = tunnel.open_configured(port, config, say=say)
            result["tunnel"] = {"url": running.url, "kind": "named" if config else "quick", "seconds": round(time.monotonic() - started, 2)}
            say(f"tunnel: {running.url} ({result['tunnel']['seconds']} s)")
            url, key = mount.socket_url(running.url), mount.key_for(root)
            # A new quick tunnel's name takes a moment to resolve everywhere.
            until(lambda: subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", running.url + "/companion/mount/socket"], capture_output=True, text=True).stdout not in ("", "000", "530", "1033"), 90, 1)
        mode = "fuse" if not koios_mount.fuse_available() else "mirror"
        started = time.monotonic()
        log = open(tmp / "daemon.log", "wb")
        daemon = subprocess.Popen([sys.executable, koios_mount.__file__, "serve", f"--url={url}", f"--key={key}", f"--at={at}", f"--mode={mode}"], stdout=log, stderr=log)
        until(lambda: koios_mount.read_status(at).get("ready") and koios_mount.read_status(at).get("mounted"), 120, 0.05)
        status = koios_mount.read_status(at)
        result["mount"] = {"mode": mode, "ready_s": round(time.monotonic() - started, 2), "warm": status.get("warm")}
        say(f"mounted ({mode}) in {result['mount']['ready_s']} s; first archives: {status.get('warm')}")
        if mode == "fuse":
            # Big files come over in the background too; measure a cold read before that gets to it.
            started = time.monotonic()
            data = (at / "weights.txt").read_bytes()
            result["cold_read_6MB_s"] = round(time.monotonic() - started, 3)
            assert data == (root / "weights.txt").read_bytes()
            started = time.monotonic()
            (at / "weights.txt").read_bytes()
            result["cached_read_6MB_s"] = round(time.monotonic() - started, 4)
            say(f"6 MB: cold {result['cold_read_6MB_s']} s, cached {result['cached_read_6MB_s']} s")
        pushes, backs = [], []
        for i in range(5):
            (root / "pkg" / "m0.py").write_text(f"VALUE = {1000 + i}\n")
            pushes.append(until(lambda: (at / "pkg" / "m0.py").read_text() == f"VALUE = {1000 + i}\n", 30))
            (at / f"result{i}.json").write_text(json.dumps({"i": i}))
            backs.append(until(lambda: (root / f"result{i}.json").exists() and (root / f"result{i}.json").read_text() == json.dumps({"i": i}), 30))
        result["save_here_to_there_s"] = {"median": round(statistics.median(pushes), 3), "max": round(max(pushes), 3)}
        result["write_there_to_here_s"] = {"median": round(statistics.median(backs), 3), "max": round(max(backs), 3)}
        say(f"a save here is there in {result['save_here_to_there_s']} s; a write there is here in {result['write_there_to_here_s']} s")
        result["rtt_ms"] = koios_mount.read_status(at).get("rttMs")
        say(f"round trip of a read: {result['rtt_ms']} ms")
        return result
    finally:
        if daemon is not None:
            koios_mount.stop(at)
            daemon.wait(10)
        if running is not None:
            running.stop()
        holder.get("loop") and holder["loop"].add_callback(holder["loop"].stop)
        state.current = None
        shutil.rmtree(tmp, True)


@unittest.skipUnless(os.environ.get("KOIOS_LIVE_TUNNEL"), "KOIOS_LIVE_TUNNEL=1 runs it: it needs to reach Cloudflare")
class LiveTunnel(unittest.TestCase):
    def test_the_mount_over_a_real_tunnel(self):
        result = measure(say=lambda text: print("  " + text, flush=True))
        self.assertLess(result["save_here_to_there_s"]["median"], 5)
        self.assertLess(result["write_there_to_here_s"]["median"], 5)


if __name__ == "__main__":
    print(json.dumps(measure(), indent=2))
