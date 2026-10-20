"""The mount over a real Cloudflare tunnel, measured. Not part of the unit tests: it needs cloudflared to reach
Cloudflare's edge (TCP or UDP 7844 out, and DNS for argotunnel.com), which CI sandboxes usually block.

    cd companion && python3 -m tests.live_tunnel            # a quick tunnel (trycloudflare.com)
    python3 -m tests.live_tunnel --save ~/koios-live.json  # ... and the numbers kept in a file
    KOIOS_LIVE_LOCAL=1 python3 -m tests.live_tunnel         # no tunnel: 127.0.0.1, to check the script itself
    KOIOS_LIVE_MODE=mirror python3 -m tests.live_tunnel     # the mirror where FUSE is here too (a Mac has no FUSE)
    KOIOS_LIVE_HOSTNAME=koios.example.com KOIOS_LIVE_TUNNEL_TOKEN=… python3 -m tests.live_tunnel   # your named one (Argo)
    KOIOS_LIVE_TUNNEL=1 python3 -m unittest tests.live_tunnel                                         # as a test

Both ends run on this computer: the Companion's socket serving a folder, and the daemon mounting it (FUSE where
/dev/fuse is, else the mirror) — but the daemon dials the tunnel's public address, so every byte goes out to
Cloudflare's edge and back in through cloudflared, as it does from Colab. Run it on the GPU machine instead with
KOIOS_LIVE_URL=wss://<tunnel>/companion/mount/socket KOIOS_LIVE_KEY=<key> to measure the real path.

It prints: how long the mount took to be ready (the tree and the first archives), a cold read of a 6 MB file and a
cached one (FUSE only), the time from a save on this side to the file being there (the push), the time from a write
there to the file being here, and — over a connection of its own, so in either mode — the round trip of a small
request (20 of them) and how fast a 6 MB file comes through in 4 MB pieces.
"""

from __future__ import annotations

import asyncio
import json
import os
import platform
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


def wait_for_name(url: str, say, limit_s: float = 120) -> float:
    """A new quick tunnel's name takes a moment to resolve; this says so while it waits, every few seconds."""
    started = time.monotonic()
    last = -10.0
    while True:
        code = subprocess.run(["curl", "-s", "-o", "/dev/null", "-m", "5", "-w", "%{http_code}", url + "/companion/mount/socket"], capture_output=True, text=True).stdout.strip()
        waited = time.monotonic() - started
        if code not in ("", "000", "530", "502", "1033"):
            say(f"the tunnel answers ({code}) after {waited:.0f} s")
            return waited
        if waited > limit_s:
            raise TimeoutError(
                f"{url} still doesn't answer after {limit_s:.0f} s (curl: {code or 'nothing'}). This computer may have cached "
                "'no such name' from the first look; on a Mac: sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder — then run it again."
            )
        if waited - last >= 5:
            say(f"  waiting for {url.split('//')[-1]} to resolve and answer ({waited:.0f} s; curl: {code or 'nothing'})…")
            last = waited
        time.sleep(1)


def probe(url: str, key: str, path: str, size: int, say) -> dict:
    """A connection of its own to the mount's socket, as the daemon's: the round trip of a small request, and how fast a
    file comes through. Measured the same way in either mode (the mirror has read everything already, so the
    daemon's own figure says nothing there)."""
    wire = koios_mount.Wire(url, key, on_push=lambda header, payload: None)
    wire.start()
    try:
        if not wire.up.wait(60):
            raise TimeoutError(f"the probe couldn't connect: {wire.error}")
        times = []
        for _ in range(20):
            started = time.monotonic()
            wire.call({"op": "stat", "path": "pkg/m0.py"})
            times.append((time.monotonic() - started) * 1000)
        started = time.monotonic()
        got, offset = 0, 0
        while offset < size:
            _, data = wire.call({"op": "read", "path": path, "offset": offset, "size": koios_mount.PIECE})
            if not data:
                break
            got += len(data)
            offset += len(data)
        seconds = time.monotonic() - started
        out = {
            "rtt_ms": {"median": round(statistics.median(times), 1), "min": round(min(times), 1), "max": round(max(times), 1)},
            "read_6MB_s": round(seconds, 3),
            "mb_per_s": round(got / 1e6 / seconds, 2) if seconds else None,
        }
        say(f"round trip of a small request: {out['rtt_ms']} ms; a 6 MB file through it in {out['read_6MB_s']} s ({out['mb_per_s']} MB/s)")
        return out
    finally:
        wire.stop()


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
        result["machine"] = {"system": platform.system(), "release": platform.release(), "python": platform.python_version(), "both_ends_here": not url}
        if os.environ.get("KOIOS_LIVE_LOCAL"):
            url, key = f"ws://127.0.0.1:{port}/companion/mount/socket", mount.key_for(root)
            result["tunnel"] = {"url": url, "kind": "none (127.0.0.1)", "seconds": 0}
        elif not url:
            started = time.monotonic()
            config = {"tunnel_token": os.environ["KOIOS_LIVE_TUNNEL_TOKEN"], "tunnel_hostname": os.environ["KOIOS_LIVE_HOSTNAME"], "tunnel_port": port} if os.environ.get("KOIOS_LIVE_TUNNEL_TOKEN") else {}
            running = tunnel.open_configured(port, config, say=say)
            result["tunnel"] = {"url": running.url, "kind": "named" if config else "quick", "seconds": round(time.monotonic() - started, 2)}
            say(f"tunnel: {running.url} ({result['tunnel']['seconds']} s)")
            url, key = mount.socket_url(running.url), mount.key_for(root)
            result["tunnel"]["answered_after_s"] = round(wait_for_name(running.url, say), 1)
        mode = os.environ.get("KOIOS_LIVE_MODE") or ("fuse" if not koios_mount.fuse_available() else "mirror")
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
        result.update(probe(url, key, "weights.txt", 6 * 1024 * 1024, say))
        result["at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
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
    import argparse

    parser = argparse.ArgumentParser(prog="python3 -m tests.live_tunnel", description="The mount over a real Cloudflare tunnel, measured.")
    parser.add_argument("--save", help="also write the numbers to this JSON file")
    args = parser.parse_args()
    numbers = measure()
    text = json.dumps(numbers, indent=2)
    print(text)
    if args.save:
        Path(os.path.expanduser(args.save)).write_text(text + "\n")
        print(f"saved to {args.save}")
