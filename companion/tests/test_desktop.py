import os
import plistlib
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from reader_companion import desktop


class LoginItemTest(unittest.TestCase):
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
            self.assertEqual(desktop.install_extension("https://saurav717.github.io/reader"), ["code", "cursor"])
        self.assertEqual(fetch.call_args[0][0], "https://saurav717.github.io/reader/vscode/reader-playground.vsix")
        self.assertEqual([args[0] for _, args in calls], ["--install-extension", "--install-extension"])


if __name__ == "__main__":
    unittest.main()
