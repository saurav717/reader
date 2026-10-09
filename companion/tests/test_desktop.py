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
            mock.patch.object(desktop.time, "sleep"),
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


class LaunchdTest(Sandbox):
    def test_waits_for_the_old_one_then_loads_it(self):
        calls = []
        loaded = iter([True, True, False])  # still letting go, twice; then gone

        def launchctl(*command):
            calls.append(command[1])
            if command[1] == "print":
                return next(loaded, False)
            if command[1] == "bootstrap":
                return calls.count("bootstrap") > 1  # "Input/output error" the first time
            return True

        with mock.patch.object(desktop, "run_quietly", side_effect=launchctl):
            self.assertTrue(desktop.launchd_start(Path("/x.plist"), "gui/501"))
        self.assertEqual([c for c in calls if c != "print"], ["bootstrap", "bootstrap"])

    def test_kickstarts_one_already_loaded(self):
        calls = []

        def launchctl(*command):
            calls.append(command[1])
            return command[1] in ("print", "kickstart")  # loaded, and won't bootstrap again

        with mock.patch.object(desktop, "run_quietly", side_effect=launchctl):
            self.assertTrue(desktop.launchd_start(Path("/x.plist"), "gui/501"))
        self.assertIn("kickstart", calls)


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


class UpdateTest(unittest.TestCase):
    def test_versions(self):
        self.assertTrue(desktop.newer("0.5.1", "0.5.0"))
        self.assertTrue(desktop.newer("0.10.0", "0.9.9"))
        self.assertFalse(desktop.newer("0.5.0", "0.5.0"))
        self.assertFalse(desktop.newer("0.4.9", "0.5.0"))

    def answer(self, body):
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = body.encode()
        return mock.patch.object(desktop.urllib.request, "urlopen", return_value=response)

    def test_takes_only_a_wheel_from_the_site_itself(self):
        site = "https://saurav717.github.io/reader/"
        with self.answer('{"version": "0.6.0", "wheel": "https://saurav717.github.io/reader/companion/reader_companion-0.6.0-py3-none-any.whl"}'):
            self.assertEqual(desktop.latest(site)["version"], "0.6.0")
        with self.answer('{"version": "0.6.0", "wheel": "https://evil.example/reader_companion-0.6.0-py3-none-any.whl"}'):
            self.assertIsNone(desktop.latest(site))
        with self.answer('{"version": "0.6.0", "wheel": "https://saurav717.github.io/reader/companion/payload.sh"}'):
            self.assertIsNone(desktop.latest(site))
        with self.answer("not json"):
            self.assertIsNone(desktop.latest(site))


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


class UrlHandlerTest(Sandbox):
    """reader-companion:// links, which the page's Start opens, run `reader-companion start`."""

    def test_mac_app_declares_the_scheme_and_runs_start(self):
        files = desktop.mac_url_app(["/Users/me/.local/bin/reader-companion"])
        info = plistlib.loads(files["Contents/Info.plist"])
        self.assertEqual(info["CFBundleURLTypes"][0]["CFBundleURLSchemes"], ["reader-companion"])
        self.assertTrue(info["LSUIElement"])
        self.assertIn(b"exec '/Users/me/.local/bin/reader-companion' 'start' '--quiet'", files["Contents/MacOS/start"])

    def test_linux_entry(self):
        entry = desktop.linux_url_entry(["/home/me/my apps/reader-companion"])
        self.assertIn('Exec="/home/me/my apps/reader-companion" start --quiet %u', entry)
        self.assertIn("MimeType=x-scheme-handler/reader-companion;", entry)

    def test_install_once_then_uninstall_each_system(self):
        command = ["/x/reader-companion"]
        for system in ("Darwin", "Linux", "Windows"):
            made = desktop.install_url_handler(command, system=system)
            self.assertTrue(made, system)
            self.assertTrue(desktop.url_handler_path(system).exists(), system)
            # The same command again: nothing to do; a new one: made again.
            self.assertIsNone(desktop.install_url_handler(command, system=system))
            self.assertTrue(desktop.install_url_handler(["/y/reader-companion"], system=system))
            self.assertEqual(len(desktop.uninstall_url_handler(system)), 1)
            self.assertFalse(desktop.url_handler_path(system).exists(), system)
            self.assertEqual(desktop.uninstall_url_handler(system), [])
        registered = [call.args for call in desktop.run_quietly.call_args_list]
        self.assertIn((desktop.LSREGISTER, "-f", str(desktop.state.config_dir() / "Reader Companion.app")), registered)
        self.assertTrue(any(args[:2] == ("xdg-mime", "default") for args in registered))
        self.assertTrue(any(args[:2] == ("reg", "add") for args in registered))


class OffTest(Sandbox):
    """Shut down from the page, it stays down until it is started on purpose."""

    def test_off_mark(self):
        from reader_companion import state

        self.assertFalse(state.is_off())
        state.set_off(True)
        self.assertTrue(state.is_off())
        state.set_off(False)
        state.set_off(False)
        self.assertFalse(state.is_off())

    def test_a_login_start_stays_off_and_a_terminal_start_clears_it(self):
        from reader_companion import cli, state

        state.set_off(True)
        args = cli.parse(["--no-browser"])
        with mock.patch.object(cli.sys.stdin, "isatty", return_value=False), mock.patch.object(cli.env, "prepare") as prepare:
            cli.serve({"token": "t", "id": "i"}, args)
            prepare.assert_not_called()
        self.assertTrue(state.is_off())
        with mock.patch.object(cli.sys.stdin, "isatty", return_value=True), mock.patch.object(cli.env, "prepare", side_effect=SystemExit("stop here")):
            with self.assertRaises(SystemExit):
                cli.serve({"token": "t", "id": "i", "root": str(Path(self.home.name) / "Reader")}, args)
        self.assertFalse(state.is_off())

    def test_start_clears_it_and_starts_it(self):
        from reader_companion import cli, state

        state.save_config({"token": "t", "port": 47400})
        state.set_off(True)
        with mock.patch.object(desktop, "wait_for", side_effect=[None, 47400]), mock.patch.object(desktop, "kick") as kick:
            cli.start([])
        self.assertFalse(state.is_off())
        kick.assert_called_once()
        # Running already: nothing to start.
        with mock.patch.object(desktop, "wait_for", return_value=47400), mock.patch.object(desktop, "kick") as kick:
            cli.start(["--quiet", "reader-companion://start"])
        kick.assert_not_called()


class DeletedAppTest(Sandbox):
    """On a Mac, deleting Reader.app takes the Companion's login item and link away."""

    def make_app(self, where: Path, bundle_id: str = desktop.MAC_BUNDLE_ID) -> Path:
        (where / "Contents").mkdir(parents=True)
        (where / "Contents" / "Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": bundle_id}))
        return where

    def test_finds_the_app_where_it_was_or_moved_but_not_in_the_trash(self):
        home = Path(self.home.name)
        app = self.make_app(home / "Apps" / "Reader.app")
        self.assertEqual(desktop.find_mac_app(str(app)), str(app))
        trashed = self.make_app(home / ".Trash" / "Reader.app")
        other = self.make_app(home / "Other.app", "com.example.other")
        moved = self.make_app(home / "Moved" / "Reader.app")
        spotlight = mock.Mock(stdout=f"{trashed}\n{other}\n{moved}\n")
        with mock.patch.object(desktop.subprocess, "run", return_value=spotlight):
            self.assertEqual(desktop.find_mac_app(str(home / "Gone" / "Reader.app")), str(moved))
        with mock.patch.object(desktop.subprocess, "run", return_value=mock.Mock(stdout=f"{trashed}\n")):
            self.assertIsNone(desktop.find_mac_app(str(home / "Gone" / "Reader.app")))

    def test_forget_install_removes_the_login_item_without_booting_out(self):
        with mock.patch.object(desktop.os, "getuid", create=True, return_value=501):
            desktop.install_login(["/x/reader-companion"], start_now=False, system="Darwin")
        desktop.install_url_handler(["/x/reader-companion"], system="Darwin")
        desktop.run_quietly.reset_mock()
        removed = desktop.forget_install()
        self.assertEqual(len(removed), 2)
        self.assertFalse(desktop.launch_agent_path().exists())
        self.assertFalse(desktop.url_handler_path("Darwin").exists())
        self.assertFalse(any(call.args[:2] == ("launchctl", "bootout") for call in desktop.run_quietly.call_args_list))

    def test_the_running_companion_stops_after_two_misses(self):
        from reader_companion import cli, state

        state.save_config({"token": "t", "app": "/Applications/Reader.app"})
        server = mock.Mock()
        callbacks = []

        class Periodic:
            def __init__(self, fn, ms):
                callbacks.append(fn)

            def start(self):
                pass

        with mock.patch("tornado.ioloop.PeriodicCallback", Periodic), mock.patch.object(desktop, "find_mac_app", return_value=None), mock.patch.object(desktop, "forget_install", return_value=["x"]) as forget:
            cli.watch_app(server, state.load_config())  # looks once at once: one miss
            server.stop.assert_not_called()
            callbacks[0]()
            forget.assert_called_once()
            server.stop.assert_called_once()
        self.assertNotIn("app", state.load_config())

    def test_an_app_found_is_recorded_and_nothing_stops(self):
        from reader_companion import cli, state

        state.save_config({"token": "t"})
        server = mock.Mock()
        with mock.patch("tornado.ioloop.PeriodicCallback"), mock.patch.object(desktop, "find_mac_app", return_value="/Applications/Reader.app"):
            config = state.load_config()
            cli.watch_app(server, config)
        self.assertEqual(state.load_config()["app"], "/Applications/Reader.app")
        server.stop.assert_not_called()
