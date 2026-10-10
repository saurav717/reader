import base64
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from reader_companion import paper


class Paths(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)

    def test_inside_the_folder_only(self):
        self.assertEqual(paper.inside(self.root, "papers/moe"), self.root / "papers" / "moe")
        self.assertEqual(paper.inside(self.root, "/papers/./moe/"), self.root / "papers" / "moe")
        for bad in ["", "..", "papers/../../etc", "C:/Windows", "a/../.."]:
            with self.assertRaises(paper.Refused, msg=bad):
                paper.inside(self.root, bad)

    def test_finds_the_main_file(self):
        folder = self.root / "p"
        (folder / "sections").mkdir(parents=True)
        (folder / "sections" / "intro.tex").write_text("\\section{Intro}")
        (folder / "paper.tex").write_text("% x\n\\documentclass{article}\n")
        self.assertEqual(paper.main_file(folder, None), "paper.tex")
        self.assertEqual(paper.main_file(folder, "sections/intro.tex"), "sections/intro.tex")
        with self.assertRaises(paper.Refused):
            paper.main_file(folder, "refs.bib")


class Compiling(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        self.folder = self.root / "papers" / "moe"
        self.folder.mkdir(parents=True)
        (self.folder / "main.tex").write_text("\\documentclass{article}\\begin{document}Hi\\end{document}")

    def test_latexmk_when_installed_else_tectonic(self):
        both = {"latexmk": "/usr/bin/latexmk", "tectonic": "/x/tectonic"}
        self.assertEqual(paper.compile_command("auto", "main.tex", both)[0], "/usr/bin/latexmk")
        self.assertIn("-file-line-error", paper.compile_command("auto", "main.tex", both))
        self.assertEqual(paper.compile_command("auto", "main.tex", {"tectonic": "/x/tectonic"})[:3], ["/x/tectonic", "-X", "compile"])
        self.assertEqual(paper.compile_command("tectonic", "main.tex", both)[0], "/x/tectonic")
        with self.assertRaises(paper.Refused):
            paper.compile_command("auto", "main.tex", {})

    def test_reads_errors_and_warnings_out_of_the_log(self):
        log = "\n".join([
            "./sections/intro.tex:12: Undefined control sequence.",
            "l.12 \\citee",
            "LaTeX Warning: Citation `lepikhin2020gshard' on page 2 undefined on input line 9.",
            "! Missing $ inserted.",
            "<inserted text>",
            "l.40 x^",
            "error: main.tex:7: Undefined control sequence",
            "warning: Overfull \\hbox in paragraph",
        ])
        read = paper.read_log(log, self.folder)
        self.assertEqual(read["errors"][0], {"file": "sections/intro.tex", "line": 12, "message": "Undefined control sequence."})
        self.assertEqual(read["errors"][1], {"file": "", "line": 40, "message": "Missing $ inserted."})
        self.assertEqual(read["errors"][2], {"file": "main.tex", "line": 7, "message": "Undefined control sequence"})
        self.assertEqual(read["warnings"][0]["line"], 9)
        self.assertIn("lepikhin2020gshard", read["warnings"][0]["message"])
        self.assertEqual(len(read["warnings"]), 2)

    def test_compile_returns_the_pdf_and_the_log(self):
        def run(argv, cwd, **kwargs):
            Path(cwd, "main.pdf").write_bytes(b"%PDF-1.5 fake")
            Path(cwd, "main.log").write_text("LaTeX Warning: Reference `fig:x' on page 1 undefined on input line 3.\n")
            return subprocess.CompletedProcess(argv, 0, stdout="Latexmk: done", stderr="")

        result = paper.compile_paper(self.root, "papers/moe", None, "auto", {"latexmk": "latexmk"}, run=run)
        self.assertTrue(result["ok"])
        self.assertEqual(base64.b64decode(result["pdf"]), b"%PDF-1.5 fake")
        self.assertEqual(result["engine"], "latexmk")
        self.assertEqual(len(result["warnings"]), 1)

    def test_an_old_pdf_is_not_passed_off_as_new(self):
        (self.folder / "main.pdf").write_bytes(b"%PDF old")
        old = time.time() - 600
        os.utime(self.folder / "main.pdf", (old, old))

        def run(argv, cwd, **kwargs):
            Path(cwd, "main.log").write_text("./main.tex:1: Emergency stop.\n")
            return subprocess.CompletedProcess(argv, 12, stdout="", stderr="")

        result = paper.compile_paper(self.root, "papers/moe", None, "auto", {"latexmk": "latexmk"}, run=run)
        self.assertFalse(result["ok"])
        self.assertEqual(result["pdf"], "")
        self.assertEqual(result["errors"][0]["line"], 1)

    def test_tectonic_for_this_computer(self):
        self.assertTrue(paper.tectonic_asset("Darwin", "arm64").endswith("aarch64-apple-darwin.tar.gz"))
        self.assertTrue(paper.tectonic_asset("Linux", "x86_64").endswith("x86_64-unknown-linux-musl.tar.gz"))
        self.assertTrue(paper.tectonic_asset("Windows", "AMD64").endswith("x86_64-pc-windows-msvc.zip"))
        self.assertIsNone(paper.tectonic_asset("Windows", "arm64"))
        self.assertIn("tectonic%40" + paper.TECTONIC_VERSION, paper.tectonic_asset("Linux", "aarch64"))


@unittest.skipUnless(shutil.which("git"), "git isn't installed")
class Syncing(unittest.TestCase):
    """A bare repository stands in for Overleaf's Git; a second clone for a coauthor in Overleaf."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        # A test before may leave the process in a folder it deleted, where git can't start.
        os.chdir(self.tmp)
        self.addCleanup(os.chdir, tempfile.gettempdir())
        self.env = mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": str(self.tmp / "gitconfig"), "GIT_CONFIG_NOSYSTEM": "1"})
        self.env.start()
        self.addCleanup(self.env.stop)
        (self.tmp / "gitconfig").write_text("[user]\n\tname = T\n\temail = t@x\n[init]\n\tdefaultBranch = master\n")
        self.remote = self.tmp / "overleaf.git"
        subprocess.run(["git", "init", "-q", "--bare", str(self.remote)], check=True)
        seed = self.tmp / "seed"
        subprocess.run(["git", "clone", "-q", str(self.remote), str(seed)], check=True)
        (seed / "main.tex").write_text("\\documentclass{article}\n\\begin{document}\nOne.\n\\end{document}\n")
        subprocess.run(["git", "-C", str(seed), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(seed), "commit", "-q", "-m", "seed"], check=True)
        subprocess.run(["git", "-C", str(seed), "push", "-q", "origin", "HEAD"], check=True)
        self.coauthor = seed
        self.root = self.tmp / "Reader"
        self.root.mkdir()
        done = subprocess.run(["git", "clone", "-q", str(self.remote), str(self.root / "papers" / "moe")], capture_output=True, text=True)
        assert done.returncode == 0, done.stderr

    def test_pushes_what_changed_here_and_takes_in_what_changed_there(self):
        main = self.root / "papers" / "moe" / "main.tex"
        main.write_text(main.read_text().replace("One.", "One. Two."))
        (self.coauthor / "refs.bib").write_text("@misc{a,}\n")
        subprocess.run(["git", "-C", str(self.coauthor), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(self.coauthor), "commit", "-q", "-m", "bib"], check=True)
        subprocess.run(["git", "-C", str(self.coauthor), "push", "-q"], check=True)
        result = paper.sync(self.root, "papers/moe", "", "Edit main.tex from Reader")
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["committed"] and result["pushed"])
        self.assertEqual(result["incoming"], ["refs.bib"])
        log = subprocess.run(["git", "--git-dir", str(self.remote), "log", "--format=%s", "-3"], capture_output=True, text=True).stdout
        self.assertIn("Edit main.tex from Reader", log)

    def test_a_conflict_is_left_marked_not_thrown_away(self):
        main = self.root / "papers" / "moe" / "main.tex"
        main.write_text(main.read_text().replace("One.", "Mine."))
        theirs = self.coauthor / "main.tex"
        theirs.write_text(theirs.read_text().replace("One.", "Theirs."))
        subprocess.run(["git", "-C", str(self.coauthor), "commit", "-qam", "theirs"], check=True)
        subprocess.run(["git", "-C", str(self.coauthor), "push", "-q"], check=True)
        result = paper.sync(self.root, "papers/moe", "", "mine")
        self.assertFalse(result["ok"])
        self.assertEqual(result["conflicts"], ["main.tex"])
        self.assertIn("<<<<<<<", main.read_text())

    def test_nothing_to_do_is_fine(self):
        result = paper.sync(self.root, "papers/moe", "", "x")
        self.assertTrue(result["ok"])
        self.assertFalse(result["committed"] or result["pushed"])

    def test_only_overleaf_or_github_is_cloned(self):
        self.assertTrue(paper.remote_ok("https://git.overleaf.com/66f1c0a9e2b7d4a1b2c3d4e5"))
        self.assertTrue(paper.remote_ok("https://github.com/me/paper.git"))
        for bad in ["file:///etc", "https://evil.example/x", "ssh://git.overleaf.com/1", "https://git.overleaf.com/abc", "--upload-pack=x"]:
            self.assertFalse(paper.remote_ok(bad), bad)
        with self.assertRaises(paper.Refused):
            paper.clone(self.root, "papers/x", "file:///etc", "")

    def test_the_token_is_kept_by_remote_and_never_in_the_clone(self):
        with mock.patch.dict(os.environ, {"READER_COMPANION_HOME": str(self.tmp / "home")}):
            paper.save_token("https://git.overleaf.com/66f1c0a9e2b7d4a1b2c3d4e5.git", "olp_secret")
            self.assertEqual(paper.token_for("https://git.overleaf.com/66f1c0a9e2b7d4a1b2c3d4e5"), "olp_secret")
            calls = []

            def run(argv, **kwargs):
                calls.append((argv, kwargs.get("env", {})))
                return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

            paper.git(["push"], self.root, "olp_secret", run=run)
            argv, env = calls[0]
            self.assertNotIn("olp_secret", " ".join(argv))
            self.assertEqual(env["READER_GIT_TOKEN"], "olp_secret")
            self.assertTrue(env["GIT_ASKPASS"])


if __name__ == "__main__":
    unittest.main()
