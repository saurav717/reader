"""The Companion as something installed rather than run: `reader-companion setup`.

The double-click installers the site offers (scripts/build-companion.mjs) put
the Companion on this computer with `uv tool install`, then run `setup`, which

- installs the Reader extension into VS Code (and Cursor, VSCodium) when one is
  here and doesn't have it, from the .vsix the site serves;
- starts the Companion at login, in the background: a LaunchAgent on macOS, a
  systemd user service (or an autostart entry) on Linux, a hidden launcher in
  the Startup folder on Windows; and starts it now;
- opens the page with a pairing link, which it asks the running Companion for.

`reader-companion pair` opens a new pairing link for the Companion that is
running, and `reader-companion uninstall` takes the login item away again.
"""

from __future__ import annotations

import json
import os
import platform
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import state

LABEL = "io.github.saurav717.reader-companion"
EXTENSION_ID = "saurav717.reader-playground"
LOG = "companion.log"
PID = "companion.pid"


# --------------------------------------------------------------- the command ----

def executable() -> list[str]:
    """How to start this Companion again later: the `reader-companion` uv tool installed, else this Python."""
    found = shutil.which("reader-companion")
    if found:
        return [found]
    for candidate in (Path.home() / ".local/bin/reader-companion", Path.home() / ".local/bin/reader-companion.exe"):
        if candidate.is_file():
            return [str(candidate)]
    return [sys.executable, "-m", "reader_companion"]


def is_lasting(command: list[str]) -> bool:
    """False when the command is in an environment `uvx` made for one run, which uv's cache may drop."""
    return "archive-v0" not in command[0]


# ---------------------------------------------------------------- the login ----

def launch_agent_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def launch_agent(command: list[str], environment: dict[str, str]) -> bytes:
    log = str(state.config_dir() / LOG)
    return plistlib.dumps({
        "Label": LABEL,
        "ProgramArguments": [*command, "--no-browser"],
        "RunAtLoad": True,
        # Started again if it stops on its own, but not in a loop when it can't start at all.
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 30,
        "ProcessType": "Interactive",
        "EnvironmentVariables": environment,
        "StandardOutPath": log,
        "StandardErrorPath": log,
    })


def systemd_unit_path() -> Path:
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "systemd" / "user" / "reader-companion.service"


def quote_systemd(word: str) -> str:
    return '"' + word.replace("\\", "\\\\").replace('"', '\\"') + '"' if any(c in word for c in ' "\\') else word


def systemd_unit(command: list[str], environment: dict[str, str]) -> str:
    lines = [
        "[Unit]",
        "Description=Reader Companion: the reader's Playground on this computer",
        "",
        "[Service]",
        f"ExecStart={' '.join(quote_systemd(word) for word in [*command, '--no-browser'])}",
        *(f"Environment={quote_systemd(f'{key}={value}')}" for key, value in environment.items()),
        "Restart=on-failure",
        "RestartSec=30",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
    ]
    return "\n".join(lines)


def autostart_path() -> Path:
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "autostart" / "reader-companion.desktop"


def autostart_entry(command: list[str]) -> str:
    exec_line = " ".join(f'"{word}"' if " " in word else word for word in [*command, "--no-browser"])
    return f"[Desktop Entry]\nType=Application\nName=Reader Companion\nComment=The reader's Playground on this computer\nExec={exec_line}\nTerminal=false\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n"


def startup_path() -> Path:
    appdata = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    return Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup" / "Reader Companion.vbs"


def startup_script(command: list[str]) -> str:
    # wscript runs it with no window. In a VBScript string "" is one quote.
    line = " ".join(f'""{word}""' for word in [*command, "--no-browser"])
    return f'CreateObject("WScript.Shell").Run "{line}", 0, False\r\n'


def login_environment() -> dict[str, str]:
    """What a login item doesn't get on its own: this terminal's PATH (Homebrew, conda), shell and language."""
    keep = ("PATH", "SHELL", "LANG", "LC_ALL", "READER_COMPANION_HOME", "UV")
    return {key: os.environ[key] for key in keep if os.environ.get(key)}


def run_quietly(*command: str) -> bool:
    try:
        return subprocess.run(list(command), capture_output=True, timeout=30).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def has_systemd() -> bool:
    return bool(shutil.which("systemctl")) and run_quietly("systemctl", "--user", "show-environment")


def login_installed(system: str | None = None) -> bool:
    system = system or platform.system()
    if system == "Darwin":
        return launch_agent_path().exists()
    if system == "Windows":
        return startup_path().exists()
    return systemd_unit_path().exists() or autostart_path().exists()


def install_login(command: list[str], start_now: bool = True, restart: bool = False, system: str | None = None) -> str:
    """Starts the Companion at every login, and now unless told not to (when one is already running here). Says how.

    `restart` stops the one this login item started before, which is running: an update replaces it.
    """
    system = system or platform.system()
    state.config_dir().mkdir(parents=True, exist_ok=True)
    environment = login_environment()
    if system == "Darwin":
        path = launch_agent_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        domain = f"gui/{os.getuid()}"
        run_quietly("launchctl", "bootout", f"{domain}/{LABEL}")
        path.write_bytes(launch_agent(command, environment))
        # Loading it runs it (RunAtLoad); left unloaded, launchd loads it at the next login.
        if start_now and not run_quietly("launchctl", "bootstrap", domain, str(path)):
            run_quietly("launchctl", "load", "-w", str(path))
        return f"a login item ({path})"
    if system == "Windows":
        path = startup_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(startup_script(command), encoding="utf-8")
        if restart:
            stop_running()
        if start_now:
            subprocess.Popen(["wscript", str(path)], close_fds=True)
        return f"the Startup folder ({path})"
    if has_systemd():
        path = systemd_unit_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(systemd_unit(command, environment))
        run_quietly("systemctl", "--user", "daemon-reload")
        run_quietly("systemctl", "--user", "enable", "reader-companion.service")
        if start_now:
            run_quietly("systemctl", "--user", "restart", "reader-companion.service")
        return f"a systemd user service ({path})"
    path = autostart_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(autostart_entry(command))
    if restart:
        stop_running()
    if start_now:
        start_detached(command)
    return f"an autostart entry ({path})"


def stop_running() -> None:
    """Stops the Companion that wrote its process id here, as one started in the background is restarted on an update."""
    path = state.config_dir() / PID
    try:
        pid = int(path.read_text().strip())
    except (OSError, ValueError):
        return
    if os.name == "nt":
        run_quietly("taskkill", "/PID", str(pid), "/T", "/F")
    else:
        try:
            os.kill(pid, 15)
        except OSError:
            pass
    path.unlink(missing_ok=True)


def start_detached(command: list[str]) -> None:
    log = open(state.config_dir() / LOG, "ab")
    flags = {}
    if os.name == "nt":
        flags["creationflags"] = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
    else:
        flags["start_new_session"] = True
    subprocess.Popen([*command, "--no-browser"], stdin=subprocess.DEVNULL, stdout=log, stderr=log, close_fds=True, **flags)


def uninstall_login(running: bool = False, system: str | None = None) -> list[str]:
    """Takes away whatever install_login made, and stops the Companion it started when one is `running`. Says what it removed."""
    system = system or platform.system()
    removed = []
    if system == "Darwin":
        path = launch_agent_path()
        if path.exists():
            run_quietly("launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}") or run_quietly("launchctl", "unload", "-w", str(path))
            path.unlink()
            removed.append(str(path))
    elif system == "Windows":
        path = startup_path()
        if path.exists():
            path.unlink()
            if running:
                stop_running()
            removed.append(str(path))
    else:
        unit = systemd_unit_path()
        if unit.exists():
            run_quietly("systemctl", "--user", "disable", "--now", "reader-companion.service")
            unit.unlink()
            run_quietly("systemctl", "--user", "daemon-reload")
            removed.append(str(unit))
        entry = autostart_path()
        if entry.exists():
            entry.unlink()
            if running:
                stop_running()
            removed.append(str(entry))
    return removed


# ------------------------------------------------------------ the running one ----

def local_call(port: int, token: str, path: str, method: str = "GET", timeout: float = 3) -> dict | None:
    request = urllib.request.Request(f"http://127.0.0.1:{port}/{path}", method=method, headers={"Authorization": f"token {token}"}, data=b"{}" if method == "POST" else None)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read() or b"{}")
    except (OSError, ValueError, urllib.error.URLError):
        return None


def wait_for(token: str, port: int, seconds: float) -> int | None:
    """The port the Companion with this token answers on, waiting while it starts (the first start installs ipykernel)."""
    until = time.time() + seconds
    while True:
        for candidate in range(port, port + 11):  # it moves up when the port is taken
            if local_call(candidate, token, "companion/link", timeout=2) is not None:
                return candidate
        if time.time() > until:
            return None
        time.sleep(1.5)


def fresh_link(token: str, port: int) -> str | None:
    """A new pairing link from the Companion running on `port`, which only the holder of its token may ask for."""
    body = local_call(port, token, "companion/link", method="POST")
    return body.get("link") if body else None


# ------------------------------------------------------------------- VS Code ----

def editor_commands() -> list[str]:
    """The `code` command of each VS Code-like editor here, found on PATH or where it installs itself."""
    home = Path.home()
    local = Path(os.environ.get("LOCALAPPDATA") or home / "AppData" / "Local")
    places = {
        "code": [
            "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
            home / "Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
            local / "Programs/Microsoft VS Code/bin/code.cmd",
            "/usr/share/code/bin/code",
            "/snap/bin/code",
        ],
        "code-insiders": ["/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code", local / "Programs/Microsoft VS Code Insiders/bin/code-insiders.cmd"],
        "cursor": ["/Applications/Cursor.app/Contents/Resources/app/bin/cursor", local / "Programs/cursor/resources/app/bin/cursor.cmd"],
        "codium": ["/Applications/VSCodium.app/Contents/Resources/app/bin/codium"],
    }
    found = []
    for name, candidates in places.items():
        command = shutil.which(name) or next((str(p) for p in map(Path, candidates) if p.is_file()), None)
        if command and command not in found:
            found.append(command)
    return found


def editor_call(command: str, *args: str, timeout: float = 120) -> subprocess.CompletedProcess | None:
    try:
        # code.cmd on Windows is a batch file: it needs the shell.
        return subprocess.run([command, *args], capture_output=True, text=True, timeout=timeout, shell=command.lower().endswith(".cmd"))
    except (OSError, subprocess.SubprocessError):
        return None


def install_extension(site: str, say=print) -> list[str]:
    """Installs or updates the Reader extension in each editor here. The editors it installed into."""
    editors = editor_commands()
    if not editors:
        return []
    vsix_url = f"{site.rstrip('/')}/vscode/reader-playground.vsix"
    folder = Path(tempfile.mkdtemp(prefix="reader-vsix-"))
    vsix = folder / "reader-playground.vsix"
    try:
        urllib.request.urlretrieve(vsix_url, vsix)
    except (OSError, urllib.error.URLError) as error:
        say(f"  Couldn't download the VS Code extension ({error}). The Playground's card has it.")
        return []
    done = []
    try:
        for command in editors:
            result = editor_call(command, "--install-extension", str(vsix), "--force")
            if result and result.returncode == 0:
                done.append(Path(command).stem)
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    return done
