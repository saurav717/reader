import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from reader_companion import texlive


class TeXLiveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        patch = mock.patch.dict(os.environ, {"READER_COMPANION_HOME": str(self.tmp / "home")})
        patch.start()
        self.addCleanup(patch.stop)

    def fake_install(self):
        where = texlive.texdir() / "bin" / "universal-darwin"
        where.mkdir(parents=True)
        for name in ("latexmk", "pdflatex", "biber", "tlmgr"):
            (where / name).write_text("#!/bin/sh\n")
        return where

    def test_the_profile_asks_nothing_and_leaves_the_path_alone(self):
        answers = texlive.profile("full")
        self.assertIn("selected_scheme scheme-full\n", answers)
        self.assertIn(f"TEXDIR {texlive.texdir()}\n", answers)
        self.assertIn("instopt_adjustpath 0\n", answers)
        self.assertIn("tlpdbopt_install_docfiles 0\n", answers)
        self.assertIn("selected_scheme scheme-medium\n", texlive.profile("medium"))

    def test_progress_is_read_from_the_installers_lines(self):
        self.assertEqual(texlive.progress_of("Installing [0012/4567, time/total: 00:10/12:00]: amsmath [42k]"), (12, 4567))
        self.assertIsNone(texlive.progress_of("Installing TeX Live 2026 from: https://mirror.ctan.org"))

    def test_a_search_names_its_packages(self):
        out = "physics:\n\ttexmf-dist/tex/latex/physics/physics.sty\nother-pkg:\n\ttexmf-dist/tex/latex/x/physics.sty\n"
        self.assertEqual(texlive.packages_from_search(out), ["physics", "other-pkg"])

    def test_nothing_until_installed_then_its_programs(self):
        self.assertEqual(texlive.tools(), {})
        self.assertFalse(texlive.status()["installed"])
        where = self.fake_install()
        found = texlive.tools()
        self.assertEqual(found["latexmk"], str(where / "latexmk"))
        self.assertEqual(found["tlmgr"], str(where / "tlmgr"))
        self.assertTrue(texlive.status()["installed"])
        self.assertEqual(texlive.status()["state"], "done")

    def test_a_scheme_it_doesnt_know_and_too_little_room_are_refused(self):
        with self.assertRaises(texlive.Refused):
            texlive.install("everything", start=False)
        with mock.patch("shutil.disk_usage", return_value=mock.Mock(free=1024**3)):
            with self.assertRaises(texlive.Refused):
                texlive.install("full", start=False)

    def test_packages_need_the_companions_tex(self):
        with self.assertRaises(texlive.Refused):
            texlive.install_packages(["physics"])

    def test_a_sty_name_that_isnt_a_package_is_looked_up(self):
        self.fake_install()
        calls = []

        def run(argv, **kwargs):
            calls.append(argv[1:])
            if argv[1:] == ["install", "physics"]:
                return subprocess.CompletedProcess(argv, 0, "installed physics\n", "")
            if argv[1:] == ["install", "cmupint"]:
                return subprocess.CompletedProcess(argv, 1, "", "unknown package\n")
            if argv[1] == "search":
                return subprocess.CompletedProcess(argv, 0, "cm-unicode-int:\n\ttexmf-dist/tex/latex/x/cmupint.sty\n", "")
            return subprocess.CompletedProcess(argv, 0, "ok\n", "")

        done = texlive.install_packages(["physics", "cmupint", "bad name;rm"], run=run)
        self.assertEqual(done["installed"], ["physics", "cm-unicode-int"])
        self.assertEqual(done["failed"], [])
        self.assertIn(["install", "cm-unicode-int"], calls)
        self.assertNotIn(["install", "bad name;rm"], calls)


if __name__ == "__main__":
    unittest.main()
