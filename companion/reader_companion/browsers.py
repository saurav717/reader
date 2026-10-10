"""The browsers on this computer, and their profiles, for the page to open a link in one (from 0.9.0).

A page can't pick which browser opens a link, and can't sign in to another
site for you; the Companion, on the computer itself, can open a browser — and
in Chrome, Edge, Brave, Vivaldi, Chromium or Firefox, one of its profiles, which
is where a site's sign-in lives. So "Overleaf as my work account" is "Chrome's
Work profile", and that is what the page asks for.

What is read here is each browser's own list of its profiles: Chromium
browsers' "Local State" (a profile's folder, its name and the Google account
it is signed in to) and Firefox's profiles.ini. Nothing is changed. A link is
opened only in a browser and a profile that are in that list, and only an
https link, so what the page sends never becomes an option of the command.
"""

from __future__ import annotations

import configparser
import json
import os
import platform
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Chromium:
    id: str
    name: str
    # Where its profiles are kept, under the home folder (mac, Linux) or %LOCALAPPDATA% (Windows).
    mac_data: str
    mac_app: str
    windows_data: str
    windows_exe: str
    linux_data: str
    linux_commands: tuple[str, ...]


CHROMIUMS = (
    Chromium("chrome", "Google Chrome", "Library/Application Support/Google/Chrome", "Google Chrome", r"Google\Chrome\User Data", r"Google\Chrome\Application\chrome.exe", ".config/google-chrome", ("google-chrome", "google-chrome-stable")),
    Chromium("edge", "Microsoft Edge", "Library/Application Support/Microsoft Edge", "Microsoft Edge", r"Microsoft\Edge\User Data", r"Microsoft\Edge\Application\msedge.exe", ".config/microsoft-edge", ("microsoft-edge", "microsoft-edge-stable")),
    Chromium("brave", "Brave", "Library/Application Support/BraveSoftware/Brave-Browser", "Brave Browser", r"BraveSoftware\Brave-Browser\User Data", r"BraveSoftware\Brave-Browser\Application\brave.exe", ".config/BraveSoftware/Brave-Browser", ("brave-browser", "brave")),
    Chromium("vivaldi", "Vivaldi", "Library/Application Support/Vivaldi", "Vivaldi", r"Vivaldi\User Data", r"Vivaldi\Application\vivaldi.exe", ".config/vivaldi", ("vivaldi", "vivaldi-stable")),
    Chromium("chromium", "Chromium", "Library/Application Support/Chromium", "Chromium", r"Chromium\User Data", r"Chromium\Application\chrome.exe", ".config/chromium", ("chromium", "chromium-browser")),
)


@dataclass
class Place:
    """Where things are on this computer: the parts of it this module looks at, so tests can stand in for them."""

    system: str
    home: Path
    env: dict

    @classmethod
    def here(cls) -> "Place":
        return cls(platform.system(), Path.home(), dict(os.environ))

    def apps(self) -> list[Path]:
        return [Path("/Applications"), self.home / "Applications"]

    def program_roots(self) -> list[Path]:
        return [Path(self.env[key]) for key in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA") if self.env.get(key)]

    def which(self, name: str) -> str | None:
        return shutil.which(name, path=self.env.get("PATH"))


# ------------------------------------------------------------- finding --


def _chromium_launcher(browser: Chromium, place: Place) -> list[str] | None:
    """The command that starts it, before its options; None when it isn't installed."""
    if place.system == "Darwin":
        for folder in place.apps():
            app = folder / f"{browser.mac_app}.app"
            if app.exists():
                return ["open", "-na", str(app), "--args"]
        return None
    if place.system == "Windows":
        for root in place.program_roots():
            exe = root.joinpath(*browser.windows_exe.split("\\"))
            if exe.is_file():
                return [str(exe)]
        return None
    for command in browser.linux_commands:
        found = place.which(command)
        if found:
            return [found]
    return None


def _chromium_data(browser: Chromium, place: Place) -> Path:
    if place.system == "Darwin":
        return place.home / browser.mac_data
    if place.system == "Windows":
        return Path(place.env.get("LOCALAPPDATA", "")).joinpath(*browser.windows_data.split("\\"))
    return place.home / browser.linux_data


def chromium_profiles(data: Path) -> list[dict]:
    """A Chromium browser's profiles, from its Local State: the folder each is in, its name, and the account signed in to it."""
    try:
        state = json.loads((data / "Local State").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    cache = state.get("profile", {}).get("info_cache", {}) if isinstance(state, dict) else {}
    if not isinstance(cache, dict):
        return []
    order = state.get("profile", {}).get("profiles_order") or []
    folders = [folder for folder in order if folder in cache] + sorted(folder for folder in cache if folder not in order)
    profiles = []
    for folder in folders:
        info = cache[folder] if isinstance(cache[folder], dict) else {}
        name = str(info.get("name") or info.get("gaia_name") or folder)
        account = str(info.get("user_name") or "")
        profiles.append({"id": folder, "name": name, "account": account})
    return profiles


def _firefox_launcher(place: Place) -> list[str] | None:
    if place.system == "Darwin":
        for folder in place.apps():
            app = folder / "Firefox.app"
            if app.exists():
                return ["open", "-na", str(app), "--args"]
        return None
    if place.system == "Windows":
        for root in place.program_roots():
            exe = root / "Mozilla Firefox" / "firefox.exe"
            if exe.is_file():
                return [str(exe)]
        return None
    found = place.which("firefox")
    return [found] if found else None


def _firefox_ini(place: Place) -> Path:
    if place.system == "Darwin":
        return place.home / "Library/Application Support/Firefox/profiles.ini"
    if place.system == "Windows":
        return Path(place.env.get("APPDATA", "")) / "Mozilla" / "Firefox" / "profiles.ini"
    return place.home / ".mozilla/firefox/profiles.ini"


def firefox_profiles(ini: Path) -> list[dict]:
    """Firefox's profiles, by name, from profiles.ini."""
    parser = configparser.RawConfigParser()
    try:
        parser.read_string(ini.read_text(encoding="utf-8"))
    except (OSError, configparser.Error, UnicodeDecodeError):
        return []
    profiles = []
    for section in parser.sections():
        if section.startswith("Profile") and parser.has_option(section, "Name"):
            name = parser.get(section, "Name")
            profiles.append({"id": name, "name": name, "account": ""})
    return profiles


def installed(place: Place | None = None) -> list[dict]:
    """The browsers here, each with its profiles (none for one that has no way to pick them from outside, as Safari)."""
    place = place or Place.here()
    found = []
    for browser in CHROMIUMS:
        if _chromium_launcher(browser, place):
            found.append({"id": browser.id, "name": browser.name, "profiles": chromium_profiles(_chromium_data(browser, place))})
    if _firefox_launcher(place):
        found.append({"id": "firefox", "name": "Firefox", "profiles": firefox_profiles(_firefox_ini(place))})
    if place.system == "Darwin" and any((folder / "Safari.app").exists() for folder in [Path("/Applications"), *place.apps()]):
        found.append({"id": "safari", "name": "Safari", "profiles": []})
    return found


# ------------------------------------------------------------- opening --


class Refused(ValueError):
    """What was asked for isn't a link, a browser or a profile this computer has."""


def command(url: str, browser: str, profile: str | None, place: Place | None = None) -> list[str] | None:
    """The command that opens the link in that browser and profile; None for the default browser. Refused unless all three are known."""
    place = place or Place.here()
    if not url.startswith("https://") or any(character.isspace() for character in url):
        raise Refused("Only an https link opens in another browser.")
    if browser == "default":
        return None
    listed = next((item for item in installed(place) if item["id"] == browser), None)
    if not listed:
        raise Refused(f"There is no {browser} on this computer.")
    if profile and not any(item["id"] == profile for item in listed["profiles"]):
        raise Refused(f"{listed['name']} has no profile {profile} on this computer.")
    if browser == "safari":
        return ["open", "-a", "Safari", url]
    if browser == "firefox":
        launcher = _firefox_launcher(place) or []
        return [*launcher, *(["-P", profile] if profile else []), "-new-tab", url]
    spec = next(item for item in CHROMIUMS if item.id == browser)
    launcher = _chromium_launcher(spec, place) or []
    return [*launcher, *([f"--profile-directory={profile}"] if profile else []), url]


def open_url(url: str, browser: str, profile: str | None = None, place: Place | None = None) -> None:
    """Opens the link there. Refused raises before anything runs."""
    argv = command(url, browser, profile, place)
    if argv is None:
        import webbrowser

        webbrowser.open(url)
        return
    subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
