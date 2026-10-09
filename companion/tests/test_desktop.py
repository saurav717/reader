import os
import plistlib
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from reader_companion import desktop


class Sandbox(unittest.TestCase):
    """A home folder of its own, where nothing really starts or stops."""

    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        patches = [
            mock.patch.dict(os.environ, {"READER_COMPANION_HOME": str(Path(self.home.name) / ".reader-companion"), "XDG_CONFIG_HOME": str(Path(self.home.name) / ".config"), "APPDATA": str(Path(self.home.name) / "AppData")}),
            mock.patch.object(Path, "home", return_value=Path(self.home.name)),
            # Nothing here really starts or stops anything.
            mock.patch.object(desktop, "run_quietly", return_value=True),
            mock.patch.object(desktop, "start_detached"),
            mock.patch.object(desktop.subprocess, "Popen"),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        self.addCleanup(self.home.cleanup)


class LoginItemTest(Sandbox):
    def test_launch_agent(self):
        plist = plistlib.loads(desktop.launch_agent(["/Users/me/.local/bin/reader-companion"], {"PATH": "/opt/homebrew/bin:/usr/bin"}))
        self.assertEqual(plist["Label"], desktop.LABEL)
        self.assertEqual(plist["ProgramArguments"], ["/Users/me/.local/bin/reader-companion", "--no-browser"])
        self.assertTrue(plist["RunAtLoad"])
        self.assertEqual(plist["EnvironmentVariables"]["PATH"], "/opt/homebrew/bin:/usr/bin")

    def test_systemd_unit_quotes_what_needs_it(self):
        unit = desktop.systemd_unit(["/home/me/my apps/reader-companion"], {"PATH": "/a b:/usr/bin"})
        self.assertIn('ExecStart="/home/me/my apps/reader-companion" --no-browser', unit)
        self.assertIn('Environment="PATH=/a b:/usr/bin"', unit)
        self.assertIn("WantedBy=default.target", unit)

    def test_windows_launcher(self):
        script = desktop.startup_script([r"C:\Users\me\.local\bin\reader-companion.exe"])
        self.assertEqual(script, 'CreateObject("WScript.Shell").Run """C:\\Users\\me\\.local\\bin\\reader-companion.exe"" ""--no-browser""", 0, False\r\n')

    def test_install_and_uninstall_each_system(self):
        command = ["/x/reader-companion"]
        with mock.patch.object(desktop, "has_systemd", return_value=False), mock.patch.object(desktop.os, "getuid", create=True, return_value=501):
            for system, path in (("Darwin", desktop.launch_agent_path), ("Windows", desktop.startup_path), ("Linux", desktop.autostart_path)):
                self.assertFalse(desktop.login_installed(system))
                desktop.install_login(command, system=system)
                self.assertTrue(path().exists(), system)
                self.assertTrue(desktop.login_installed(system))
                self.assertEqual(desktop.uninstall_login(system=system), [str(path())])
                self.assertFalse(desktop.login_installed(system))

    def test_systemd_when_there_is_one(self):
        with mock.patch.object(desktop, "has_systemd", return_value=True):
            desktop.install_login(["/x/reader-companion"], system="Linux")
        self.assertIn("ExecStart=/x/reader-companion --no-browser", desktop.systemd_unit_path().read_text())

    def test_a_uvx_run_cannot_start_at_login(self):
        self.assertFalse(desktop.is_lasting(["/home/me/.cache/uv/archive-v0/abc/bin/python", "-m", "reader_companion"]))
        self.assertTrue(desktop.is_lasting(["/home/me/.local/bin/reader-companion"]))


class AppTest(Sandbox):
    def test_icons(self):
        png = b"\x89PNG\r\n\x1a\nfake"
        made = desktop.icns({256: png, 512: png + b"!"})
        self.assertEqual(made[:4], b"icns")
        self.assertEqual(int.from_bytes(made[4:8], "big"), len(made))
        self.assertEqual(made[8:12], b"ic08")
        self.assertIn(b"ic09", made)
        icon = desktop.ico(png)
        self.assertEqual(icon[:6], b"\x00\x00\x01\x00\x01\x00")
        self.assertEqual(icon[6], 0)  # 256 px
        self.assertEqual(icon[22:], png)

    def test_mac_app(self):
        files = desktop.mac_app(["/Users/me/.local/bin/reader-companion"], {256: b"png", 512: b"png"})
        info = plistlib.loads(files["Contents/Info.plist"])
        self.assertEqual(info["CFBundleExecutable"], "Reader")
        self.assertEqual(info["CFBundleIconFile"], "Reader")
        self.assertEqual(files["Contents/MacOS/Reader"].decode().splitlines()[-1], "exec '/Users/me/.local/bin/reader-companion' 'open'")
        self.assertIn("Contents/Resources/Reader.icns", files)

    def test_install_and_uninstall_the_app(self):
        with mock.patch.object(desktop, "fetch_icons", return_value={256: b"png", 512: b"png"}):
            for system in ("Darwin", "Linux"):
                where = desktop.install_app(["/x/reader-companion"], "https://saurav717.github.io/reader/", system=system)
                self.assertTrue(Path(where).exists(), system)
                self.assertEqual(desktop.uninstall_app(system=system), [where])
                self.assertFalse(Path(where).exists())
        app = desktop.mac_app_path() / "Contents" / "MacOS" / "Reader"
        self.assertFalse(app.exists())

    def test_open_window_prefers_an_app_window(self):
        with mock.patch.object(desktop, "app_browser", return_value=["/usr/bin/google-chrome"]):
            desktop.open_window("https://saurav717.github.io/reader/playground")
        desktop.subprocess.Popen.assert_called_once()
        self.assertEqual(desktop.subprocess.Popen.call_args[0][0], ["/usr/bin/google-chrome", "--app=https://saurav717.github.io/reader/playground"])


class CodeOnScreenTest(unittest.TestCase):
    def test_each_system_shows_it(self):
        mac = desktop.code_dialog("ABC-DEF", 'Saurav\'s "Mac"', system="Darwin")
        self.assertEqual(mac[:2], ["osascript", "-e"])
        self.assertIn("ABC-DEF", mac[2])
        self.assertIn('\\"Mac\\"', mac[2])  # quotes escaped for AppleScript
        windows = desktop.code_dialog("ABC-DEF", "Saurav's PC", system="Windows")
        self.assertIn("Saurav''s PC", windows[-1])  # and for PowerShell
        with mock.patch.object(desktop.shutil, "which", side_effect=lambda tool: "/usr/bin/notify-send" if tool == "notify-send" else None):
            self.assertEqual(desktop.code_dialog("ABC-DEF", "box", system="Linux")[0], "notify-send")
        with mock.patch.object(desktop.shutil, "which", return_value=None):
            self.assertIsNone(desktop.code_dialog("ABC-DEF", "box", system="Linux"))


class EditorTest(unittest.TestCase):
    def test_no_editor_no_download(self):
        with mock.patch.object(desktop, "editor_commands", return_value=[]), mock.patch.object(desktop.urllib.request, "urlretrieve") as fetch:
            self.assertEqual(desktop.install_extension("https://saurav717.github.io/reader/"), [])
            fetch.assert_not_called()

    def test_installs_into_each_editor(self):
        calls = []

        def fake_call(command, *args, timeout=120):
            calls.append((command, args))
            return mock.Mock(returncode=0)

        with mock.patch.object(desktop, "editor_commands", return_value=["/usr/bin/code", "/usr/bin/cursor"]), mock.patch.object(desktop.urllib.request, "urlretrieve") as fetch, mock.patch.object(desktop, "editor_call", fake_call):
            self.assertEqual(desktop.install_extension("https://saurav717.github.io/reader"), ["VS Code", "Cursor"])
        self.assertEqual(fetch.call_args[0][0], "https://saurav717.github.io/reader/vscode/reader-playground.vsix")
        self.assertEqual([args[0] for _, args in calls], ["--install-extension", "--install-extension"])


if __name__ == "__main__":
    unittest.main()
