"""An HTTPS address for the Companion, through a Cloudflare quick tunnel, for browsers that won't call 127.0.0.1.

Safari blocks an https page from calling http://127.0.0.1 (mixed content), so
the reader on saurav717.github.io can't reach a Companion there. A quick tunnel
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
import subprocess
import tarfile
import threading
import time
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
    def __init__(self, process: subprocess.Popen, url: str):
        self.process, self.url = process, url

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


def via_tunnel(host: str | None) -> bool:
    """A request that came in through the tunnel, by its Host."""
    name = (host or "").rsplit(":", 1)[0].strip("[]")
    return name not in ("127.0.0.1", "localhost", "::1", "")

