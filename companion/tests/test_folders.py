import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from reader_companion import folders


class Folders(unittest.TestCase):
    """Folders anywhere on this computer: listed, and linked into the Companion's folder."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home"
        (self.home / "code" / "lora").mkdir(parents=True)
        (self.home / "code" / "lora" / "train.py").write_text("print(1)\n")
        (self.home / "code" / ".cache").mkdir()
        (self.home / "code" / "__pycache__").mkdir()
        (self.home / "code" / "notes.md").write_text("# n\n")
        (self.home / "Reader").mkdir()
        patch = mock.patch.object(Path, "home", return_value=self.home)
        patch.start()
        self.addCleanup(patch.stop)
        env = mock.patch.dict(os.environ, {"HOME": str(self.home), "USERPROFILE": str(self.home)})
        env.start()
        self.addCleanup(env.stop)

    def test_lists_folders_first_and_leaves_hidden_ones_out(self):
        found = folders.listing("~/code")
        self.assertEqual(found["path"], str((self.home / "code").resolve()))
        self.assertEqual([(e["name"], e["dir"]) for e in found["entries"]], [("lora", True), ("notes.md", False)])
        self.assertIn({"name": "Home", "path": str(self.home.resolve())}, found["places"])
        with_hidden = [e["name"] for e in folders.listing("~/code", show_hidden=True)["entries"]]
        self.assertIn(".cache", with_hidden)

    def test_a_file_is_not_a_folder(self):
        with self.assertRaises(NotADirectoryError):
            folders.listing("~/code/notes.md")

    def test_links_a_folder_in_and_edits_reach_it(self):
        root = self.home / "Reader"
        rel = folders.link("~/code/lora", root)
        self.assertEqual(rel, "linked/lora")
        (root / rel / "eval.py").write_text("print(2)\n")
        self.assertTrue((self.home / "code" / "lora" / "eval.py").exists())
        # The same folder again: the same link, not a second one.
        self.assertEqual(folders.link("~/code/lora", root), "linked/lora")

    def test_another_folder_of_the_same_name_gets_its_own_link(self):
        (self.home / "other" / "lora").mkdir(parents=True)
        root = self.home / "Reader"
        folders.link("~/code/lora", root)
        self.assertEqual(folders.link("~/other/lora", root), "linked/lora-2")

    def test_a_folder_already_inside_is_used_as_it_is(self):
        (self.home / "Reader" / "playgrounds" / "x").mkdir(parents=True)
        self.assertEqual(folders.link("~/Reader/playgrounds/x", self.home / "Reader"), "playgrounds/x")

    def test_each_system_has_a_chooser_or_says_none(self):
        self.assertEqual(folders.chooser_command("Darwin")[0], "osascript")
        self.assertEqual(folders.chooser_command("Windows")[0], "powershell")
        with mock.patch.object(folders.shutil, "which", return_value=None):
            self.assertIsNone(folders.chooser_command("Linux"))
            with self.assertRaises(LookupError):
                with mock.patch.object(folders.platform, "system", return_value="Linux"):
                    folders.choose()


if __name__ == "__main__":
    unittest.main()
