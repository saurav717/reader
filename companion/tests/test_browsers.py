import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from reader_companion import browsers


class Browsers(unittest.TestCase):
    """A computer of its own: a home folder with browsers' profile lists in it, and their programs."""

    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.home = Path(self.root.name) / "home"
        self.home.mkdir()

    def write(self, path: Path, text: str) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def program(self, name: str) -> str:
        path = self.write(Path(self.root.name) / "bin" / name, "#!/bin/sh\n")
        path.chmod(path.stat().st_mode | stat.S_IEXEC)
        return str(path.parent)

    def linux(self) -> browsers.Place:
        bin_dir = self.program("google-chrome")
        self.program("firefox")
        self.write(self.home / ".config/google-chrome/Local State", json.dumps({"profile": {"profiles_order": ["Profile 1", "Default"], "info_cache": {"Default": {"name": "Personal", "user_name": "me@gmail.com"}, "Profile 1": {"name": "Work", "user_name": "me@lab.edu"}, "Profile 3": {"gaia_name": "Old"}}}}))
        self.write(self.home / ".mozilla/firefox/profiles.ini", "[General]\nStartWithLastProfile=1\n\n[Profile0]\nName=default-release\nPath=abc.default-release\n\n[Profile1]\nName=Lab\nPath=def.lab\n")
        return browsers.Place("Linux", self.home, {"PATH": bin_dir})

    def test_lists_the_browsers_and_their_profiles(self):
        found = browsers.installed(self.linux())
        self.assertEqual([item["id"] for item in found], ["chrome", "firefox"])
        self.assertEqual(found[0]["profiles"], [
            {"id": "Profile 1", "name": "Work", "account": "me@lab.edu"},
            {"id": "Default", "name": "Personal", "account": "me@gmail.com"},
            {"id": "Profile 3", "name": "Old", "account": ""},
        ])
        self.assertEqual([item["name"] for item in found[1]["profiles"]], ["default-release", "Lab"])

    def test_a_browser_with_no_profile_list_still_shows(self):
        place = browsers.Place("Linux", self.home, {"PATH": self.program("chromium")})
        self.assertEqual(browsers.installed(place), [{"id": "chromium", "name": "Chromium", "profiles": []}])

    def test_a_broken_local_state_is_no_profiles(self):
        self.write(self.home / "x/Local State", "{not json")
        self.assertEqual(browsers.chromium_profiles(self.home / "x"), [])

    def test_opens_in_the_profile_asked_for(self):
        place = self.linux()
        chrome = browsers.command("https://www.overleaf.com/project/1", "chrome", "Profile 1", place)
        self.assertTrue(chrome[0].endswith("google-chrome"))
        self.assertEqual(chrome[1:], ["--profile-directory=Profile 1", "https://www.overleaf.com/project/1"])
        firefox = browsers.command("https://www.overleaf.com/project/1", "firefox", "Lab", place)
        self.assertEqual(firefox[1:], ["-P", "Lab", "-new-tab", "https://www.overleaf.com/project/1"])
        self.assertIsNone(browsers.command("https://www.overleaf.com/project/1", "default", None, place))

    def test_on_a_mac_through_open(self):
        apps = self.home / "Applications"
        (apps / "Google Chrome.app").mkdir(parents=True)
        self.write(self.home / "Library/Application Support/Google/Chrome/Local State", json.dumps({"profile": {"info_cache": {"Default": {"name": "Me"}}}}))
        place = browsers.Place("Darwin", self.home, {})
        with mock.patch.object(browsers.Place, "apps", return_value=[apps]):
            self.assertEqual(browsers.command("https://x.org/", "chrome", "Default", place), ["open", "-na", str(apps / "Google Chrome.app"), "--args", "--profile-directory=Default", "https://x.org/"])

    def test_on_windows_from_its_program_folders(self):
        local = Path(self.root.name) / "Local"
        self.write(local / r"Microsoft\Edge\Application\msedge.exe".replace("\\", os.sep), "")
        self.write(local / r"Microsoft\Edge\User Data\Local State".replace("\\", os.sep), json.dumps({"profile": {"info_cache": {"Profile 2": {"name": "Uni"}}}}))
        place = browsers.Place("Windows", self.home, {"LOCALAPPDATA": str(local)})
        found = browsers.installed(place)
        self.assertEqual(found, [{"id": "edge", "name": "Microsoft Edge", "profiles": [{"id": "Profile 2", "name": "Uni", "account": ""}]}])

    def test_refuses_what_it_does_not_know(self):
        place = self.linux()
        for url, browser, profile in [
            ("http://www.overleaf.com/", "chrome", None),
            ("javascript:alert(1)", "chrome", None),
            ("https://x.org/ --remote-debugging-port=1", "chrome", None),
            ("https://x.org/", "safari", None),
            ("https://x.org/", "chrome", "--user-data-dir=/tmp/evil"),
            ("https://x.org/", "firefox", "Nobody"),
        ]:
            with self.assertRaises(browsers.Refused, msg=(url, browser, profile)):
                browsers.command(url, browser, profile, place)

    def test_open_runs_the_command_and_nothing_when_refused(self):
        place = self.linux()
        with mock.patch.object(browsers.subprocess, "Popen") as popen:
            browsers.open_url("https://x.org/", "chrome", "Default", place)
            self.assertIn("--profile-directory=Default", popen.call_args[0][0])
            with self.assertRaises(browsers.Refused):
                browsers.open_url("https://x.org/", "chrome", "Profile 9", place)
            self.assertEqual(popen.call_count, 1)


if __name__ == "__main__":
    unittest.main()
