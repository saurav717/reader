"""What the running Companion knows: its name, token, the site it serves, and the pairing code."""

from __future__ import annotations

import json
import os
import platform
import secrets
import shutil
import socket
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

# No 0/O, 1/I/L: a code read off a terminal and typed into a page.
ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_TTL_S = 15 * 60
MAX_TRIES = 10


def config_dir() -> Path:
    return Path(os.environ.get("READER_COMPANION_HOME") or Path.home() / ".reader-companion")


def load_config() -> dict:
    try:
        return json.loads((config_dir() / "config.json").read_text())
    except (OSError, ValueError):
        return {}


def save_config(config: dict) -> None:
    folder = config_dir()
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "config.json"
    path.write_text(json.dumps(config, indent=2))
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def new_code() -> str:
    raw = "".join(secrets.choice(ALPHABET) for _ in range(6))
    return f"{raw[:3]}-{raw[3:]}"


def normalise_code(code: str) -> str:
    raw = "".join(ch for ch in str(code).upper() if ch.isalnum())
    return f"{raw[:3]}-{raw[3:]}" if len(raw) == 6 else raw


def origin_of(site: str) -> str:
    parts = urlsplit(site)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError(f"not a web address: {site}")
    return f"{parts.scheme}://{parts.netloc}"


def computer_name() -> str:
    if platform.system() == "Darwin":
        try:
            out = subprocess.run(["scutil", "--get", "ComputerName"], capture_output=True, text=True, timeout=3)
            if out.returncode == 0 and out.stdout.strip():
                return out.stdout.strip()
        except (OSError, subprocess.SubprocessError):
            pass
    return socket.gethostname().split(".")[0] or "This computer"


def hardware() -> str:
    """One line for the page: the GPU if there is one, else the CPU."""
    if shutil.which("nvidia-smi"):
        try:
            out = subprocess.run(
                ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
                capture_output=True, text=True, timeout=5,
            )
            gpus = [line.strip() for line in out.stdout.splitlines() if line.strip()]
            if out.returncode == 0 and gpus:
                name, _, memory = gpus[0].partition(",")
                count = f"{len(gpus)}× " if len(gpus) > 1 else ""
                return f"{count}{name.strip()} · {memory.strip()}"
        except (OSError, subprocess.SubprocessError):
            pass
    if platform.system() == "Darwin" and platform.machine() == "arm64":
        return "Apple Silicon (mps)"
    return f"{platform.machine() or 'CPU'} · {os.cpu_count() or '?'} threads"


@dataclass
class Companion:
    name: str
    token: str
    id: str
    site: str
    root: str
    version: str
    hardware: str = ""
    port: int = 0
    tunnel_url: str = ""
    code: str = field(default_factory=new_code)
    code_made: float = field(default_factory=time.time)
    tries: int = 0
    on_new_code: object = None

    @property
    def origin(self) -> str:
        return origin_of(self.site)

    def fresh_code(self, announce: bool = True) -> str:
        self.code, self.code_made, self.tries = new_code(), time.time(), 0
        if announce and callable(self.on_new_code):
            self.on_new_code(self.code)
        return self.code

    def pair(self, code: str) -> bool:
        """True and a new code for the next browser when `code` is right; a code dies after its time or too many tries."""
        if time.time() - self.code_made > CODE_TTL_S:
            self.fresh_code()
            return False
        if secrets.compare_digest(normalise_code(code), self.code):
            self.fresh_code()
            return True
        self.tries += 1
        if self.tries >= MAX_TRIES:
            self.fresh_code()
        return False


current: Companion | None = None
