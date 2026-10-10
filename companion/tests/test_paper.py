import base64
import io
import os
import zipfile
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
        home = mock.patch.dict(os.environ, {"READER_COMPANION_HOME": str(self.root / ".home")})
        home.start()
        self.addCleanup(home.stop)
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

    def test_overleafs_own_command(self):
        argv = paper.compile_command("latexmk", "main.tex", {"latexmk": "latexmk"}, "pdflatex", "/b")
        self.assertEqual(argv, ["latexmk", "-cd", "-jobname=output", "-auxdir=/b", "-outdir=/b", "-synctex=1", "-interaction=batchmode", "-file-line-error", "-f", "-pdf", "main.tex"])
        self.assertIn("-xelatex", paper.compile_command("latexmk", "main.tex", {"latexmk": "latexmk"}, "xelatex", "/b"))
        self.assertIn("-lualatex", paper.compile_command("latexmk", "main.tex", {"latexmk": "latexmk"}, "lualatex", "/b"))
        self.assertIn("-pdfdvi", paper.compile_command("latexmk", "main.tex", {"latexmk": "latexmk"}, "latex", "/b"))
        halted = paper.compile_command("latexmk", "main.tex", {"latexmk": "latexmk"}, "pdflatex", "/b", halt=True)
        self.assertIn("-halt-on-error", halted)
        self.assertNotIn("-f", halted)

    def test_the_build_is_kept_out_of_the_paper(self):
        build = paper.build_dir(self.folder)
        self.assertNotIn(self.folder.resolve(), build.resolve().parents)
        self.assertEqual(build, paper.build_dir(self.folder))

    def test_compile_returns_the_pdf_and_the_log(self):
        def run(argv, cwd, **kwargs):
            out = Path(next(arg for arg in argv if arg.startswith("-outdir=")).split("=", 1)[1])
            (out / "output.pdf").write_bytes(b"%PDF-1.5 fake")
            (out / "output.log").write_text("LaTeX Warning: Reference `fig:x' on page 1 undefined on input line 3.\n")
            return subprocess.CompletedProcess(argv, 0, stdout="Latexmk: done", stderr="")

        result = paper.compile_paper(self.root, "papers/moe", None, "auto", {"latexmk": "latexmk"}, run=run)
        self.assertTrue(result["ok"])
        self.assertEqual(base64.b64decode(result["pdf"]), b"%PDF-1.5 fake")
        self.assertEqual(result["engine"], "latexmk")
        self.assertEqual(len(result["warnings"]), 1)

    def test_an_old_pdf_is_not_passed_off_as_new(self):
        out = paper.build_dir(self.folder)
        out.mkdir(parents=True)
        (out / "output.pdf").write_bytes(b"%PDF old")
        old = time.time() - 600
        os.utime(out / "output.pdf", (old, old))

        def run(argv, cwd, **kwargs):
            (out / "output.log").write_text("./main.tex:1: Emergency stop.\n")
            return subprocess.CompletedProcess(argv, 12, stdout="", stderr="")

        result = paper.compile_paper(self.root, "papers/moe", None, "auto", {"latexmk": "latexmk"}, run=run)
        self.assertFalse(result["ok"])
        self.assertEqual(result["pdf"], "")
        self.assertEqual(result["errors"][0]["line"], 1)

    @unittest.skipUnless(shutil.which("latexmk") and shutil.which("pdflatex"), "TeX isn't installed")
    def test_a_real_compile_as_overleaf_does_it(self):
        paper_dir = self.root / "papers" / "real"
        (paper_dir / "chapters").mkdir(parents=True)
        (paper_dir / "main.tex").write_text("\\documentclass{article}\n\\begin{document}\n\\section{One}\\label{s:one}See \\S\\ref{s:one}.\n\\include{chapters/two}\n\\end{document}\n")
        (paper_dir / "chapters" / "two.tex").write_text("\\section{Two}\nA line with \\nosuchmacro in it.\n")
        found = {"latexmk": shutil.which("latexmk"), "pdflatex": shutil.which("pdflatex")}
        result = paper.compile_paper(self.root, "papers/real", None, "auto", found)
        self.assertTrue(result["pdf"], result["log"][-500:])
        self.assertEqual(base64.b64decode(result["pdf"])[:5], b"%PDF-")
        self.assertEqual(result["errors"][0]["file"], "chapters/two.tex")
        self.assertEqual(result["errors"][0]["line"], 2)
        left = sorted(path.relative_to(paper_dir).as_posix() for path in paper_dir.rglob("*") if path.is_file())
        self.assertEqual(left, ["chapters/two.tex", "main.tex"], "nothing compiling makes is left in the paper's folder")
        self.assertTrue(paper.engines(found)["texVersion"].startswith("pdfTeX"))

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
            # An Overleaf token is the account's: another of its projects needs none asked for.
            self.assertEqual(paper.token_for("https://git.overleaf.com/77f1c0a9e2b7d4a1b2c3d4e5"), "olp_secret")
            self.assertEqual(paper.token_for("https://github.com/me/paper"), "")
            calls = []

            def run(argv, **kwargs):
                calls.append((argv, kwargs.get("env", {})))
                return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

            paper.git(["push"], self.root, "olp_secret", run=run)
            argv, env = calls[0]
            self.assertNotIn("olp_secret", " ".join(argv))
            self.assertEqual(env["READER_GIT_TOKEN"], "olp_secret")
            self.assertTrue(env["GIT_ASKPASS"])
            self.assertEqual(paper.forget_tokens("https://git.overleaf.com"), 2)
            self.assertEqual(paper.token_for("https://git.overleaf.com/66f1c0a9e2b7d4a1b2c3d4e5"), "")


def kit(files: dict[str, bytes | str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as bundle:
        for name, data in files.items():
            bundle.writestr(name, data)
    return buffer.getvalue()


class Templates(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)

    def test_a_kit_is_kept_without_the_folder_it_comes_in(self):
        data = kit({"NeurIPS_2026/neurips_2026.sty": "%sty", "NeurIPS_2026/neurips_2026.tex": "\\documentclass{article}\n", "__MACOSX/._x": "", "NeurIPS_2026/figs/a.png": b"\x89PNG"})
        made = paper.save_template(self.root, "NeurIPS 2026", data)
        self.assertEqual(made, {"slug": "neurips-2026", "name": "NeurIPS 2026", "files": 3, "main": "neurips_2026.tex"})
        self.assertTrue((self.root / "templates" / "neurips-2026" / "figs" / "a.png").is_file())
        self.assertEqual([item["slug"] for item in paper.list_templates(self.root)], ["neurips-2026"])
        with self.assertRaises(paper.Refused):
            paper.save_template(self.root, "NeurIPS 2026", data)

    def test_a_kit_that_climbs_out_is_refused(self):
        with self.assertRaises(paper.Refused):
            paper.save_template(self.root, "evil", kit({"../../escape.tex": "x"}))
        self.assertFalse((self.root.parent / "escape.tex").exists())
        self.assertFalse((self.root / "templates" / "evil").exists())
        with self.assertRaises(paper.Refused):
            paper.save_template(self.root, "not a zip", b"hello")

    def test_a_new_paper_from_a_kit(self):
        paper.save_template(self.root, "ICML", kit({"icml.tex": "\\documentclass{article}", "icml.sty": "%"}))
        (self.root / "papers" / "mine" / ".git").mkdir(parents=True)
        done = paper.apply_template(self.root, "icml", "papers/mine")
        self.assertEqual(done["files"], 2)
        self.assertTrue((self.root / "papers" / "mine" / "icml.tex").is_file())
        with self.assertRaises(paper.Refused):
            paper.apply_template(self.root, "icml", "papers/mine")
        # A blank Overleaf project's main.tex gives way, in a clone whose history keeps it.
        again = paper.apply_template(self.root, "icml", "papers/mine", replace=True)
        self.assertEqual(sorted(again["replaced"]), ["icml.sty", "icml.tex"])
        self.assertEqual(again["main"], "icml.tex")
        paper.delete_template(self.root, "icml")
        self.assertEqual(paper.list_templates(self.root), [])


if __name__ == "__main__":
    unittest.main()
