"""An HTTPS address for the Companion, through a Cloudflare quick tunnel, for browsers that won't call 127.0.0.1.

Safari blocks an https page from calling http://127.0.0.1 (mixed content), so
the reader on koios.dev can't reach a Companion there. A quick tunnel
(https://<words>.trycloudflare.com, no account needed) gives it an https
address that forwards to 127.0.0.1. Everything through it still needs the
server's token; /companion/pair needs the code the terminal shows.

cloudflared is the one READER_COMPANION_CLOUDFLARED names, or the one on the
PATH, or else downloaded once from its GitHub releases into
~/.reader-companion/bin.
"""

from __future__ import annotations

import os
import platform
import re
import shutil
import socket
import subprocess
import tarfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import state

RELEASES = "https://github.com/cloudflare/cloudflared/releases/latest/download/"
URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
READY_RE = re.compile(r"Registered tunnel connection|Connection [0-9a-f-]+ registered")


def asset() -> str:
    system, machine = platform.system(), platform.machine().lower()
    arch = "arm64" if machine in ("arm64", "aarch64") else "amd64"
    if system == "Darwin":
        return f"cloudflared-darwin-{arch}.tgz"
    if system == "Windows":
        return "cloudflared-windows-amd64.exe"
    return f"cloudflared-linux-{arch}"


def cloudflared(say=print) -> str:
    named = os.environ.get("READER_COMPANION_CLOUDFLARED")
    if named:
        return named
    found = shutil.which("cloudflared")
    if found:
        return found
    folder = state.config_dir() / "bin"
    target = folder / ("cloudflared.exe" if platform.system() == "Windows" else "cloudflared")
    if target.exists():
        return str(target)
    folder.mkdir(parents=True, exist_ok=True)
    name = asset()
    say(f"  Downloading cloudflared, once, for the HTTPS tunnel ({name})…")
    download = folder / name
    with urllib.request.urlopen(RELEASES + name, timeout=120) as response, open(download, "wb") as out:
        shutil.copyfileobj(response, out)
    if name.endswith(".tgz"):
        with tarfile.open(download) as archive:
            member = next(m for m in archive.getmembers() if m.name.rsplit("/", 1)[-1] == "cloudflared")
            member.name = target.name
            archive.extract(member, folder)
        download.unlink()
    else:
        download.replace(target)
    target.chmod(0o755)
    return str(target)


class Tunnel:
    def __init__(self, process: subprocess.Popen, url: str, live: bool = False):
        self.process, self.url = process, url
        # Whether the address has been seen to lead here. A quick tunnel's name is new: Cloudflare's DNS can take a
        # while to answer for it after cloudflared registers, and a machine that asks too early may be told it doesn't
        # exist and keep that answer cached (wait_live).
        self.live = live

    def wait_live(self, timeout_s: float = 30) -> bool:
        if not self.live:
            self.live = live(self.url, timeout_s)
        return self.live

    def alive(self) -> bool:
        return self.process.poll() is None

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()


def start(port: int, binary: str, timeout_s: float = 45) -> Tunnel:
    """Starts a quick tunnel to 127.0.0.1:port and waits for its address and its first connection."""
    process = subprocess.Popen(
        [binary, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{port}"],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, bufsize=1,
    )
    found: dict = {}
    tail: list[str] = []

    def read():
        for line in process.stderr:  # keep reading for its whole life, or the pipe fills and it stalls
            tail.append(line.rstrip())
            del tail[:-20]
            if "url" not in found:
                match = URL_RE.search(line.replace("api.trycloudflare.com", ""))
                if match:
                    found["url"] = match.group(0)
            if READY_RE.search(line):
                found["ready"] = True

    threading.Thread(target=read, daemon=True).start()
    deadline = time.time() + timeout_s
    while time.time() < deadline and not ("url" in found and found.get("ready")):
        if process.poll() is not None:
            break
        time.sleep(0.2)
    if "url" not in found:
        process.kill()
        raise RuntimeError("cloudflared gave no address: " + " | ".join(tail[-3:]))
    return Tunnel(process, found["url"])


def start_named(binary: str, token: str, hostname: str, timeout_s: float = 45) -> Tunnel:
    """A tunnel of the person's own (cloudflare.py): run with its token — given in the environment, never on the
    command line where any program could read it — at its fixed address. Its route to this computer is kept on
    Cloudflare (the tunnel's ingress), so it needs no --url."""
    process = subprocess.Popen(
        [binary, "tunnel", "--no-autoupdate", "run"],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, bufsize=1, env={**os.environ, "TUNNEL_TOKEN": token},
    )
    ready = threading.Event()
    tail: list[str] = []

    def read():
        for line in process.stderr:
            tail.append(line.rstrip())
            del tail[:-20]
            if READY_RE.search(line):
                ready.set()

    threading.Thread(target=read, daemon=True).start()
    deadline = time.time() + timeout_s
    while time.time() < deadline and not ready.is_set():
        if process.poll() is not None:
            break
        time.sleep(0.2)
    if not ready.is_set():
        process.kill()
        raise RuntimeError("the tunnel didn't connect to Cloudflare: " + " | ".join(tail[-3:]))
    return Tunnel(process, f"https://{hostname}", live=True)  # a fixed name, in DNS long before this start


def open_configured(port: int, config: dict, say=print) -> Tunnel:
    """The tunnel the settings ask for: the person's own named one when `reader-companion tunnel setup` made it,
    else a quick tunnel."""
    binary = cloudflared(say=say)
    if config.get("tunnel_token") and config.get("tunnel_hostname"):
        if int(config.get("tunnel_port") or port) != port:
            say(f"  The tunnel sends to port {config.get('tunnel_port')}, but the Companion is on {port}: run reader-companion tunnel setup again.")
        return start_named(binary, config["tunnel_token"], config["tunnel_hostname"])
    return start(port, binary)


def gone(url: str, timeout_s: float = 8) -> bool:
    """True when the tunnel's address no longer leads here: its name doesn't resolve (a quick tunnel Cloudflare has
    dropped, as after this computer slept a while) or Cloudflare answers that nothing is behind it (530, 502). Any
    other answer, or none in time, counts as alive: an address is only given up on when it is known to be dead."""
    try:
        with urllib.request.urlopen(urllib.request.Request(url.rstrip("/") + "/", method="HEAD"), timeout=timeout_s):
            return False
    except urllib.error.HTTPError as error:
        return error.code in (502, 530)
    except urllib.error.URLError as error:
        return isinstance(error.reason, socket.gaierror)
    except OSError:
        return False


def live(url: str, timeout_s: float = 30) -> bool:
    """Waits until the address answers through Cloudflare: its name resolves and something is behind it (not 502 or
    530). Asked once a second at first, then less often, so a resolver here isn't made to cache "no such name"."""
    deadline = time.monotonic() + timeout_s
    pause = 1.0
    while True:
        try:
            with urllib.request.urlopen(urllib.request.Request(url.rstrip("/") + "/", method="HEAD"), timeout=5):
                return True
        except urllib.error.HTTPError as error:
            if error.code not in (502, 530):
                return True  # the Companion's own answer (404 for HEAD /): it is there
        except OSError:
            pass
        if time.monotonic() + pause > deadline:
            return False
        time.sleep(pause)
        pause = min(pause * 1.5, 4)


def via_tunnel(host: str | None) -> bool:
    """A request that came in through the tunnel, by its Host."""
    name = (host or "").rsplit(":", 1)[0].strip("[]")
    return name not in ("127.0.0.1", "localhost", "::1", "")

