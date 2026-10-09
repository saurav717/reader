"""The Companion as something installed rather than run: `reader-companion setup`.

The double-click installers the site offers (scripts/build-companion.mjs) put
the Companion on this computer with `uv tool install`, then run `setup`, which
- makes the Reader app (see "the app" below);

- installs the Reader extension into VS Code (and Cursor, VSCodium) when one is
  here and doesn't have it, from the .vsix the site serves;
- starts the Companion at login, in the background: a LaunchAgent on macOS, a
  systemd user service (or an autostart entry) on Linux, a hidden launcher in
  the Startup folder on Windows; and starts it now;
- opens the page with a pairing link, which it asks the running Companion for.

`reader-companion open` is what the app runs. `reader-companion pair` opens a
new pairing link for the Companion that is running, and
`reader-companion uninstall` takes the app and the login item away again.
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
EDITOR_NAMES = {"code": "VS Code", "code-insiders": "VS Code Insiders", "cursor": "Cursor", "codium": "VSCodium"}
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
        if start_now:
            launchd_start(path, domain)
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


def launchd_loaded(domain: str) -> bool:
    return run_quietly("launchctl", "print", f"{domain}/{LABEL}")


def launchd_start(path: Path, domain: str) -> bool:
    """Loads the LaunchAgent, which starts it.

    Right after a bootout launchd is still letting the old one go, and a bootstrap
    then fails ("Input/output error"): wait until it has, try a few times, and
    if it is loaded after all, kickstart it, so the Companion is running either way.
    """
    for _ in range(20):
        if not launchd_loaded(domain):
            break
        time.sleep(0.5)
    for _ in range(5):
        if run_quietly("launchctl", "bootstrap", domain, str(path)):
            return True
        if launchd_loaded(domain):
            return run_quietly("launchctl", "kickstart", f"{domain}/{LABEL}")
        time.sleep(1)
    return run_quietly("launchctl", "load", "-w", str(path))


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
                done.append(EDITOR_NAMES.get(Path(command).stem.lower(), Path(command).stem))
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    return done


def extension_status() -> dict:
    """The editors here, and which of them have the Reader extension: for the page's VS Code button."""
    editors = []
    for command in editor_commands():
        listing = editor_call(command, "--list-extensions", timeout=60)
        installed = bool(listing and listing.returncode == 0 and EXTENSION_ID in listing.stdout.lower().split())
        editors.append({"name": EDITOR_NAMES.get(Path(command).stem.lower(), Path(command).stem), "installed": installed})
    return {"editors": editors}


# ---------------------------------------------------------------- the app ----
#
# The Reader app is made here, on this computer, by `setup`: a small .app in
# ~/Applications on macOS, shortcuts in the Start menu and on the desktop on
# Windows, an entry in the applications menu on Linux. Made locally, it carries
# no "downloaded from the internet" mark, so macOS's Gatekeeper and Windows'
# SmartScreen have nothing to ask about, and there is nothing to sign or
# notarize. Opening it runs `reader-companion open`: the Companion is started
# if it isn't running, and the site opens in a window of its own.

APP_NAME = "Reader"


def app_browser(system: str | None = None) -> list[str] | None:
    """A Chromium browser that opens a site as an app window (`--app=`), and reaches 127.0.0.1 from an https page as Safari won't."""
    system = system or platform.system()
    if system == "Darwin":
        for name in ("Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium", "Vivaldi"):
            for folder in (Path("/Applications"), Path.home() / "Applications"):
                if (folder / f"{name}.app").exists():
                    return ["open", "-na", str(folder / f"{name}.app"), "--args"]
        return None
    if system == "Windows":
        roots = [os.environ.get(key) for key in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")]
        for relative in (r"Google\Chrome\Application\chrome.exe", r"Microsoft\Edge\Application\msedge.exe", r"BraveSoftware\Brave-Browser\Application\brave.exe"):
            for root in filter(None, roots):
                if (Path(root) / relative).is_file():
                    return [str(Path(root) / relative)]
        return None
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"):
        found = shutil.which(name)
        if found:
            return [found]
    return None


def open_window(url: str, system: str | None = None) -> None:
    """The site in a window of its own when a Chromium browser is here, else in the default browser."""
    browser = app_browser(system)
    if browser:
        try:
            subprocess.Popen([*browser, f"--app={url}"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
            return
        except OSError:
            pass
    import webbrowser

    webbrowser.open(url)


def kick(command: list[str], system: str | None = None) -> None:
    """Starts the Companion in the background: through its login item when it has one, so there is only ever one."""
    system = system or platform.system()
    if system == "Darwin" and launch_agent_path().exists():
        domain = f"gui/{os.getuid()}"
        if not run_quietly("launchctl", "kickstart", f"{domain}/{LABEL}"):
            launchd_start(launch_agent_path(), domain)
        return
    if system == "Windows" and startup_path().exists():
        subprocess.Popen(["wscript", str(startup_path())], close_fds=True)
        return
    if system not in ("Darwin", "Windows") and systemd_unit_path().exists() and has_systemd():
        run_quietly("systemctl", "--user", "start", "reader-companion.service")
        return
    start_detached(command)


def icns(png_by_size: dict[int, bytes]) -> bytes:
    """A macOS .icns of PNGs, which macOS reads as they are: ic08 is 256 px, ic09 512 px."""
    kinds = {256: b"ic08", 512: b"ic09"}
    body = b"".join(kinds[size] + (len(png) + 8).to_bytes(4, "big") + png for size, png in sorted(png_by_size.items()) if size in kinds)
    return b"icns" + (len(body) + 8).to_bytes(4, "big") + body


def ico(png: bytes, size: int = 256) -> bytes:
    """A Windows .ico holding one PNG (Windows Vista and later read PNGs in an icon)."""
    side = 0 if size >= 256 else size  # 0 means 256
    header = (0).to_bytes(2, "little") + (1).to_bytes(2, "little") + (1).to_bytes(2, "little")
    entry = bytes([side, side, 0, 0]) + (1).to_bytes(2, "little") + (32).to_bytes(2, "little") + len(png).to_bytes(4, "little") + (6 + 16).to_bytes(4, "little")
    return header + entry + png


def fetch_icons(site: str) -> dict[int, bytes]:
    icons = {}
    for size in (256, 512):
        try:
            with urllib.request.urlopen(f"{site.rstrip('/')}/icons/reader-{size}.png", timeout=20) as response:
                icons[size] = response.read()
        except (OSError, urllib.error.URLError):
            pass
    return icons


def mac_app_path() -> Path:
    return Path.home() / "Applications" / f"{APP_NAME}.app"


def mac_app(command: list[str], icons: dict[int, bytes]) -> dict[str, bytes]:
    """The files of Reader.app, by path inside it: a shell script that runs `reader-companion open`."""
    script = "#!/bin/sh\n# Reader: starts the Reader Companion if it isn't running, and opens the site in its own window.\nexec " + " ".join(f"'{word}'" for word in [*command, "open"]) + "\n"
    info = {
        "CFBundleName": APP_NAME,
        "CFBundleDisplayName": APP_NAME,
        "CFBundleIdentifier": "io.github.saurav717.reader",
        "CFBundleExecutable": APP_NAME,
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": "1.0",
        "LSUIElement": True,  # the window is the browser's; the app itself needs no Dock icon of its own while it runs
    }
    files = {"Contents/Info.plist": plistlib.dumps(info), f"Contents/MacOS/{APP_NAME}": script.encode()}
    if icons:
        info["CFBundleIconFile"] = APP_NAME
        files["Contents/Info.plist"] = plistlib.dumps(info)
        files[f"Contents/Resources/{APP_NAME}.icns"] = icns(icons)
    return files


def linux_entry_path() -> Path:
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "applications" / "reader.desktop"


def windows_shortcuts() -> list[Path]:
    appdata = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
    return [appdata / "Microsoft" / "Windows" / "Start Menu" / "Programs" / f"{APP_NAME}.lnk", Path.home() / "Desktop" / f"{APP_NAME}.lnk"]


def install_app(command: list[str], site: str, system: str | None = None) -> str:
    """Makes the Reader app on this computer. Says where."""
    system = system or platform.system()
    icons = fetch_icons(site)
    home = state.config_dir()
    home.mkdir(parents=True, exist_ok=True)
    if system == "Darwin":
        app = mac_app_path()
        shutil.rmtree(app, ignore_errors=True)
        for name, data in mac_app(command, icons).items():
            path = app / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        os.chmod(app / "Contents" / "MacOS" / APP_NAME, 0o755)
        run_quietly("touch", str(app))  # Finder and the Dock pick up the icon
        return str(app)
    if system == "Windows":
        launcher = home / "Reader.vbs"
        line = " ".join(f'""{word}""' for word in [*command, "open"])
        launcher.write_text(f'CreateObject("WScript.Shell").Run "{line}", 0, False\r\n', encoding="utf-8")
        icon = home / "Reader.ico"
        if 256 in icons:
            icon.write_bytes(ico(icons[256]))
        made = []
        for shortcut in windows_shortcuts():
            shortcut.parent.mkdir(parents=True, exist_ok=True)
            make = (
                "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($args[0]); "
                "$s.TargetPath = 'wscript.exe'; $s.Arguments = '\"' + $args[1] + '\"'; "
                "if (Test-Path $args[2]) { $s.IconLocation = $args[2] }; $s.Description = 'Reader'; $s.Save()"
            )
            if run_quietly("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", make, str(shortcut), str(launcher), str(icon)):
                made.append(str(shortcut))
        return " and ".join(made) or str(launcher)
    icon = home / "reader.png"
    if 512 in icons:
        icon.write_bytes(icons[512])
    entry = linux_entry_path()
    entry.parent.mkdir(parents=True, exist_ok=True)
    exec_line = " ".join(f'"{word}"' if " " in word else word for word in [*command, "open"])
    entry.write_text(f"[Desktop Entry]\nType=Application\nName={APP_NAME}\nComment=Research papers, and a Playground on this computer\nExec={exec_line}\nIcon={icon}\nTerminal=false\nCategories=Education;Science;Development;\n")
    return str(entry)


def uninstall_app(system: str | None = None) -> list[str]:
    system = system or platform.system()
    removed = []
    if system == "Darwin":
        if mac_app_path().exists():
            shutil.rmtree(mac_app_path(), ignore_errors=True)
            removed.append(str(mac_app_path()))
    elif system == "Windows":
        for shortcut in windows_shortcuts():
            if shortcut.exists():
                shortcut.unlink()
                removed.append(str(shortcut))
    elif linux_entry_path().exists():
        linux_entry_path().unlink()
        removed.append(str(linux_entry_path()))
    return removed


# ------------------------------------------------- started from the page ----
#
# A page can't start a program, but it can open a link whose scheme this
# computer hands to one. The page's Start (the machine chip's menu, and
# Settings → This computer) opens reader-companion://start, and what is made
# here runs `reader-companion start`: on macOS a small app in the settings
# folder that declares the scheme, on Linux an applications entry for
# x-scheme-handler/reader-companion, on Windows the URL protocol under
# HKEY_CURRENT_USER. Browsers ask once before opening it.

SCHEME = "reader-companion"
URL_APP = "Reader Companion"
LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"


def url_handler_path(system: str | None = None) -> Path:
    """The file that answers reader-companion:// links (on macOS, the app's script)."""
    system = system or platform.system()
    if system == "Darwin":
        return state.config_dir() / f"{URL_APP}.app" / "Contents" / "MacOS" / "start"
    if system == "Windows":
        return state.config_dir() / "Start.vbs"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "applications" / "reader-companion-start.desktop"


def mac_url_app(command: list[str]) -> dict[str, bytes]:
    """The files of the app that answers reader-companion:// links: a script that runs `reader-companion start`."""
    script = "#!/bin/sh\n# Opened by a reader-companion:// link (the page's Start): starts the Reader Companion if it isn't running.\nexec " + " ".join(f"'{word}'" for word in [*command, "start", "--quiet"]) + "\n"
    info = {
        "CFBundleName": URL_APP,
        "CFBundleDisplayName": URL_APP,
        "CFBundleIdentifier": "io.github.saurav717.reader-companion.start",
        "CFBundleExecutable": "start",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": "1.0",
        "LSUIElement": True,
        "CFBundleURLTypes": [{"CFBundleURLName": "Reader Companion", "CFBundleURLSchemes": [SCHEME]}],
    }
    return {"Contents/Info.plist": plistlib.dumps(info), "Contents/MacOS/start": script.encode()}


def windows_url_launcher(command: list[str]) -> str:
    line = " ".join(f'""{word}""' for word in [*command, "start", "--quiet"])
    return f'CreateObject("WScript.Shell").Run "{line}", 0, False\r\n'


def linux_url_entry(command: list[str]) -> str:
    exec_line = " ".join(f'"{word}"' if " " in word else word for word in [*command, "start", "--quiet"])
    return f"[Desktop Entry]\nType=Application\nName=Reader Companion\nComment=Starts the Reader Companion, for the reader's Start button\nExec={exec_line} %u\nTerminal=false\nNoDisplay=true\nMimeType=x-scheme-handler/{SCHEME};\n"


def install_url_handler(command: list[str], system: str | None = None, force: bool = False) -> str | None:
    """Makes reader-companion:// links start the Companion; nothing when it already does with this command. Says where, when it made it."""
    system = system or platform.system()
    path = url_handler_path(system)
    if system == "Darwin":
        files = mac_url_app(command)
        if not force and path.is_file() and path.read_bytes() == files["Contents/MacOS/start"]:
            return None
        app = path.parent.parent.parent
        shutil.rmtree(app, ignore_errors=True)
        for name, data in files.items():
            (app / name).parent.mkdir(parents=True, exist_ok=True)
            (app / name).write_bytes(data)
        os.chmod(path, 0o755)
        # Launch Services learns of an app when Finder sees it; this one is in a hidden folder, so it is told.
        run_quietly(LSREGISTER, "-f", str(app))
        return str(app)
    if system == "Windows":
        launcher = windows_url_launcher(command)
        if not force and path.is_file() and path.read_bytes() == launcher.encode():
            return None
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(launcher.encode())
        key = rf"HKCU\Software\Classes\{SCHEME}"
        run_quietly("reg", "add", key, "/ve", "/d", "URL:Reader Companion", "/f")
        run_quietly("reg", "add", key, "/v", "URL Protocol", "/d", "", "/f")
        run_quietly("reg", "add", rf"{key}\shell\open\command", "/ve", "/d", f'wscript.exe "{path}" "%1"', "/f")
        return str(path)
    entry = linux_url_entry(command)
    if not force and path.is_file() and path.read_text() == entry:
        return None
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(entry)
    run_quietly("xdg-mime", "default", path.name, f"x-scheme-handler/{SCHEME}")
    run_quietly("update-desktop-database", str(path.parent))
    return str(path)


def uninstall_url_handler(system: str | None = None) -> list[str]:
    system = system or platform.system()
    path = url_handler_path(system)
    if not path.exists():
        return []
    if system == "Darwin":
        app = path.parent.parent.parent
        run_quietly(LSREGISTER, "-u", str(app))
        shutil.rmtree(app, ignore_errors=True)
        return [str(app)]
    if system == "Windows":
        run_quietly("reg", "delete", rf"HKCU\Software\Classes\{SCHEME}", "/f")
    path.unlink()
    return [str(path)]


# ------------------------------------------------------ the code, on screen ----

def code_dialog(code: str, name: str, system: str | None = None) -> list[str] | None:
    """The command that puts the pairing code on this computer's screen, or None when there is nothing to show it with."""
    system = system or platform.system()
    text = f"The code to connect a browser to {name}:\n\n{code}\n\nType it on the Reader page. It works once, for 15 minutes."
    if system == "Darwin":
        quoted = text.replace("\\", "\\\\").replace('"', '\\"')
        return ["osascript", "-e", f'display dialog "{quoted}" with title "Reader" buttons {{"OK"}} default button 1 giving up after 300']
    if system == "Windows":
        quoted = text.replace("'", "''")
        return ["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", f"Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show('{quoted}', 'Reader')"]
    for tool, args in (("zenity", ["--info", "--title=Reader", f"--text={text}"]), ("kdialog", ["--title", "Reader", "--msgbox", text]), ("notify-send", ["--expire-time=300000", "Reader", text])):
        if shutil.which(tool):
            return [tool, *args]
    return None


def show_code(code: str, name: str) -> bool:
    """Shows the pairing code on this computer's screen, without waiting for it to be closed. Whether it could."""
    command = code_dialog(code, name)
    if not command:
        return False
    try:
        subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
        return True
    except OSError:
        return False


# ----------------------------------------------------------------- updating ----

def latest(site: str) -> dict | None:
    """The newest Companion the site serves: {"version", "wheel"} from companion/latest.json (scripts/build-companion.mjs)."""
    try:
        with urllib.request.urlopen(f"{site.rstrip('/')}/companion/latest.json", timeout=20) as response:
            body = json.loads(response.read())
    except (OSError, ValueError, urllib.error.URLError):
        return None
    version, wheel = str(body.get("version", "")), str(body.get("wheel", ""))
    # Only a wheel from the site itself: the page can't point the Companion anywhere else.
    if not version or not wheel.startswith(site.rstrip("/") + "/companion/") or not wheel.endswith(".whl"):
        return None
    return {"version": version, "wheel": wheel}


def newer(version: str, than: str) -> bool:
    def parts(value: str) -> tuple[int, ...]:
        try:
            return tuple(int(part) for part in value.split("."))
        except ValueError:
            return (0,)

    return parts(version) > parts(than)


def own_uv() -> str | None:
    from . import env

    found = env.find_uv()
    if found:
        return found
    copy = state.config_dir() / "bin" / ("uv.exe" if os.name == "nt" else "uv")
    return str(copy) if copy.is_file() else None


def install_wheel(wheel: str) -> tuple[bool, str]:
    """`uv tool install` of this wheel over the installed Companion. Whether it worked, and what uv said."""
    uv = own_uv()
    if not uv:
        return False, "There is no uv here to install with. Run the installer from the Playground's card once."
    environment = {**os.environ, "UV_PYTHON_PREFERENCE": "only-managed"}
    try:
        result = subprocess.run([uv, "tool", "install", "--force", "--python", "3.12", "--from", wheel, "reader-companion"], capture_output=True, text=True, timeout=600, env=environment)
    except (OSError, subprocess.SubprocessError) as error:
        return False, str(error)
    return result.returncode == 0, (result.stdout + result.stderr)[-2000:]


def restart_later(command: list[str], system: str | None = None) -> bool:
    """Starts this Companion again, a moment after this answer: through its login item, else a new process once this one has gone.

    True when something else restarts it; False when this process should exit itself to let the new one have the port.
    """
    system = system or platform.system()
    detached = {"start_new_session": True} if os.name != "nt" else {"creationflags": 0x00000008 | 0x00000200 | 0x08000000}
    quiet = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "close_fds": True}
    if system == "Darwin" and launch_agent_path().exists():
        subprocess.Popen(["/bin/sh", "-c", f"sleep 1; launchctl kickstart -k gui/{os.getuid()}/{LABEL}"], **quiet, **detached)
        return True
    if system not in ("Darwin", "Windows") and systemd_unit_path().exists() and has_systemd():
        subprocess.Popen(["/bin/sh", "-c", "sleep 1; systemctl --user restart reader-companion.service"], **quiet, **detached)
        return True
    log = str(state.config_dir() / LOG)
    if os.name == "nt":
        line = subprocess.list2cmdline([*command, "--no-browser"])
        subprocess.Popen(["cmd", "/c", f"timeout /t 3 /nobreak >nul & {line}"], **quiet, **detached)
    else:
        line = " ".join(f"'{word}'" for word in [*command, "--no-browser"])
        subprocess.Popen(["/bin/sh", "-c", f"sleep 3; exec {line} >> '{log}' 2>&1"], **quiet, **detached)
    return False
