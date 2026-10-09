"""What this computer can run, and VS Code in the page.

The Playground's Run button and Agents menu ask what is installed (/companion/tools):
the language toolchains (python, node, go, gcc, …) and the coding agents with a
command line (claude, codex, gemini, aider, …). They are looked for the way the
page's terminal finds them — through your own shell, with your rc files — since
a Companion started at login has a bare PATH, and nvm, pyenv or Homebrew put
theirs on it in ~/.zshrc. The answer is kept for a minute.

VS Code in the page (/companion/vscode-web) is `code serve-web`: Microsoft's own
VS Code for the browser, from the VS Code installed here, run on 127.0.0.1 with
a connection token only the Companion knows. The page reaches it through the
Companion (extension.VsCodeProxy) at a path with a secret in it, the way a
share link works: an iframe sends no Authorization header, and a browser may
drop a cookie set inside another site's frame. The Companion adds the
connection token on the way. The extensions are the ones your VS Code has:
each is linked into the server's own extensions folder, so your coding agents
(Copilot, Claude Code, Cline, …) are in the page too. Settings and sign-ins are
the server's own, in ~/.reader-companion/vscode.
"""

from __future__ import annotations

import atexit
import os
import platform
import secrets
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import desktop, state

LANGUAGE_TOOLS = [
    "python3", "python", "node", "bun", "deno", "tsx", "go", "cargo", "rustc", "gcc", "g++", "clang", "clang++",
    "java", "ruby", "php", "perl", "lua", "Rscript", "julia", "swift", "dart", "runghc", "elixir", "bash", "zsh", "pwsh",
]
AGENTS = [
    ("claude", "Claude Code"), ("codex", "Codex"), ("gemini", "Gemini CLI"), ("copilot", "GitHub Copilot CLI"),
    ("cursor-agent", "Cursor Agent"), ("aider", "Aider"), ("opencode", "opencode"), ("goose", "Goose"), ("amp", "Amp"), ("qwen", "Qwen Code"),
]
MARK = "__READER_TOOLS__"
CACHE_S = 60

_cache: dict = {"at": 0.0, "found": None}


def parse_found(output: str) -> dict[str, str]:
    """`name<TAB>path` lines after the mark (an rc file may print before it)."""
    found: dict[str, str] = {}
    lines = output.split(MARK, 1)[-1].splitlines()
    for line in lines:
        name, _, path = line.partition("\t")
        if name and path.strip():
            found[name.strip()] = path.strip()
    return found


def look_up(names: list[str], shell: list[str] | None) -> dict[str, str]:
    """Where each command is, as your shell finds it (or this process's PATH, without one)."""
    if os.name == "nt" or not shell:
        return {name: path for name in names if (path := shutil.which(name))}
    script = f"printf '%s\\n' {MARK}; for c in {' '.join(names)}; do p=$(command -v \"$c\" 2>/dev/null) && printf '%s\\t%s\\n' \"$c\" \"$p\"; done"
    try:
        out = subprocess.run([*shell, "-c", script], capture_output=True, text=True, timeout=20, stdin=subprocess.DEVNULL)
        if MARK in out.stdout:
            return parse_found(out.stdout)
    except (OSError, subprocess.SubprocessError):
        pass
    return {name: path for name in names if (path := shutil.which(name))}


def detect(shell: list[str] | None) -> dict:
    """The toolchains and agents here, and whether VS Code is: kept for a minute."""
    if _cache["found"] is not None and time.time() - _cache["at"] < CACHE_S:
        return _cache["found"]
    found = look_up(LANGUAGE_TOOLS + [command for command, _ in AGENTS], shell)
    answer = {
        "os": "windows" if os.name == "nt" else "mac" if platform.system() == "Darwin" else "linux",
        "tools": {name: found[name] for name in LANGUAGE_TOOLS if name in found},
        "agents": [{"id": command, "name": name} for command, name in AGENTS if command in found],
        "vscode": bool(vscode_command()),
    }
    _cache.update(at=time.time(), found=answer)
    return answer


def vscode_command() -> str | None:
    """The `code` of Microsoft's VS Code (serve-web is in its command line; VSCodium's and Cursor's have none)."""
    for command in desktop.editor_commands():
        if Path(command).stem.lower() in ("code", "code-insiders"):
            return command
    return None


def user_extensions() -> Path:
    return Path(os.environ.get("VSCODE_EXTENSIONS") or Path.home() / ".vscode" / "extensions")


def link_extensions(source: Path, target: Path) -> int:
    """Each extension your VS Code has, linked into the server's folder (a junction on Windows): how many are there."""
    target.mkdir(parents=True, exist_ok=True)
    if not source.is_dir():
        return 0
    count = 0
    for folder in source.iterdir():
        if not folder.is_dir() or folder.name.startswith("."):
            continue
        link = target / folder.name
        if not link.exists():
            try:
                os.symlink(folder, link, target_is_directory=True)
            except OSError:
                if os.name != "nt":
                    continue
                subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(folder)], capture_output=True)
        count += link.exists()
    return count


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class VsCodeWeb:
    """One `code serve-web` for this Companion, started when the page first asks and stopped with it."""

    def __init__(self):
        self.secret = secrets.token_urlsafe(24)
        self.token = secrets.token_urlsafe(32)
        self.port = 0
        self.process: subprocess.Popen | None = None
        self.state = "off"  # off, starting, ready, failed
        self.error = ""
        self.lock = threading.Lock()
        self.tail: list[str] = []

    @property
    def base_path(self) -> str:
        return f"/companion/vscode/{self.secret}"

    def status(self) -> dict:
        if self.process and self.process.poll() is not None and self.state != "failed":
            self.state, self.error = "failed", "VS Code stopped: " + " | ".join(self.tail[-3:])
        # Its last lines, for the page to show when something is wrong: what VS Code itself said.
        return {"state": self.state, "error": self.error, "path": f"{self.base_path}/" if self.state == "ready" else "", "log": self.tail[-12:]}

    def start(self) -> dict:
        with self.lock:
            if self.state == "starting" and self.process and self.process.poll() is None:
                return self.status()
            if self.state == "ready" and self.process and self.process.poll() is None:
                if self.answers():
                    return self.status()
                # Running, but its server no longer answers (it stopped, the computer slept): start it again,
                # or every page that asks is told it is ready and the frame shows an error.
                self.stop()
            command = vscode_command()
            if not command:
                self.state, self.error = "failed", "VS Code isn’t installed on this computer. Install it from code.visualstudio.com, then try again."
                return self.status()
            data = state.config_dir() / "vscode"
            link_extensions(user_extensions(), data / "extensions")
            self.port = free_port()
            self.state, self.error, self.tail = "starting", "", []
            args = [
                command, "serve-web", "--host", "127.0.0.1", "--port", str(self.port), "--connection-token", self.token,
                "--server-base-path", self.base_path, "--server-data-dir", str(data), "--accept-server-license-terms",
            ]
            try:
                self.process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, text=True, bufsize=1)
            except OSError as error:
                self.state, self.error = "failed", f"VS Code didn’t start: {error}"
                return self.status()
            atexit.register(self.stop)
            threading.Thread(target=self._read, daemon=True).start()
            threading.Thread(target=self._wait, daemon=True).start()
            return self.status()

    def _read(self):
        for line in self.process.stdout:  # keep reading, or the pipe fills and it stalls
            self.tail.append(line.rstrip())
            del self.tail[:-20]

    def _wait(self, seconds: float = 600):
        # The first start downloads the VS Code server (a minute or two); after that it is quick.
        until = time.time() + seconds
        while time.time() < until and self.process and self.process.poll() is None:
            if self.answers():
                self.state = "ready"
                return
            time.sleep(1)
        if self.state == "starting":
            self.state = "failed"
            self.error = "VS Code didn’t come up: " + " | ".join(self.tail[-3:])

    def answers(self) -> bool:
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}{self.base_path}/", headers={"Cookie": f"vscode-tkn={self.token}"})
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                return response.status < 500
        except urllib.error.HTTPError as error:
            return error.code < 500 and error.code != 404
        except OSError:
            return False

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
        self.state = "off"


vscode_web = VsCodeWeb()
