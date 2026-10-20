"""Keeps this computer from sleeping while a machine has one of its folders mounted (mount.py), from 0.19.0.

The machine reads and writes the folder here, so a laptop that goes to sleep mid-run leaves it waiting: its reads of
anything new wait, its writes wait. koios_mount copies every file over in the background and queues what it writes,
so a sleep costs little. Not sleeping in the first place costs nothing at all. While a machine is connected, this
holds the system's own "don't sleep" lock, and lets go when the last one disconnects:

- macOS: `caffeinate -i -s` (no idle sleep; no system sleep on mains power, even with the lid closed and a display
  attached), tied to this process, so it ends with the Companion however it ends;
- Linux: `systemd-inhibit --what=sleep:idle`, where systemd is;
- Windows: SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED), from a thread of its own.

The display may still sleep. Closing a laptop's lid on battery still sleeps it; nothing a program can do changes
that. `"keep_awake": false` in ~/.reader-companion/config.json turns it off.
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import threading

from . import state


def wanted() -> bool:
    return bool(state.load_config().get("keep_awake", True))


class Awake:
    """One hold on sleep, taken by the first holder and let go by the last."""

    def __init__(self):
        self.holders: set[str] = set()
        self.process: subprocess.Popen | None = None
        self.stop_windows: threading.Event | None = None
        self.lock = threading.Lock()
        self.how = ""

    def hold(self, who: str) -> None:
        with self.lock:
            self.holders.add(who)
            if len(self.holders) == 1 and wanted():
                self.how = self._start()

    def release(self, who: str) -> None:
        with self.lock:
            self.holders.discard(who)
            if not self.holders:
                self._stop()

    def holding(self) -> bool:
        return bool(self.how)

    def _start(self) -> str:
        system = platform.system()
        try:
            if system == "Darwin" and shutil.which("caffeinate"):
                self.process = subprocess.Popen(["caffeinate", "-i", "-s", "-w", str(os.getpid())], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return "caffeinate"
            if system == "Linux" and shutil.which("systemd-inhibit"):
                self.process = subprocess.Popen(
                    ["systemd-inhibit", "--what=sleep:idle", "--who=Koios Companion", "--why=A machine has a project folder here mounted", "--mode=block", "tail", f"--pid={os.getpid()}", "-f", "/dev/null"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
                return "systemd-inhibit"
            if system == "Windows":
                return self._windows()
        except OSError:
            pass
        return ""

    def _windows(self) -> str:
        import ctypes

        ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
        stop = threading.Event()
        self.stop_windows = stop

        def hold():
            ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
            stop.wait()
            ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS)

        threading.Thread(target=hold, daemon=True, name="koios-awake").start()
        return "SetThreadExecutionState"

    def _stop(self) -> None:
        if self.process is not None:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
            self.process = None
        if self.stop_windows is not None:
            self.stop_windows.set()
            self.stop_windows = None
        self.how = ""


current = Awake()
