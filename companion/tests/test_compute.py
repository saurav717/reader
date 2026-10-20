"""The compute link (reader_companion/compute.py): the link kept for the shell, the ignore rules, and push, pull, run
and a shell against a real Jupyter server with a kernel, started here on 127.0.0.1 — Colab's runtime is one too."""

import asyncio
import os
import pty
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

from reader_companion import compute

try:
    import ipykernel  # noqa: F401

    KERNEL = True
except ImportError:
    KERNEL = False


class Home(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        os.environ["READER_COMPANION_HOME"] = str(self.tmp / "home")
        self.addCleanup(os.environ.pop, "READER_COMPANION_HOME", None)


class LinkTests(Home):
    def test_a_link_is_kept_private_found_from_inside_the_folder_and_never_shows_its_pass(self):
        root = self.tmp / "Reader" / "playgrounds" / "p1"
        (root / "src" / "deep").mkdir(parents=True)
        link = compute.save_link(root, {"kind": "colab", "url": "https://8080-x.colab.dev", "token": "secret", "expiresAt": 5, "label": "Colab · T4", "folder": "/playgrounds/p1/"})
        self.assertEqual(link["url"], "https://8080-x.colab.dev/")
        self.assertEqual(link["folder"], "playgrounds/p1")
        self.assertEqual(oct(compute.link_file(root).stat().st_mode & 0o777), "0o600")
        self.assertEqual(compute.find_link(root / "src" / "deep")["root"], str(root.resolve()))
        self.assertIsNone(compute.find_link(self.tmp))
        shown = compute.public(link)
        self.assertNotIn("token", shown)
        self.assertEqual(shown["label"], "Colab · T4")
        compute.save_link(root, None)
        self.assertIsNone(compute.find_link(root))

    def test_the_kernel_is_kept_while_the_machine_is_the_same(self):
        root = self.tmp / "p"
        root.mkdir()
        link = compute.save_link(root, {"kind": "colab", "url": "https://a.colab.dev/", "token": "t1"})
        compute.update_link(link, kernel="k1")
        self.assertEqual(compute.save_link(root, {"kind": "colab", "url": "https://a.colab.dev/", "token": "t2"})["kernel"], "k1")
        self.assertNotIn("kernel", compute.save_link(root, {"kind": "colab", "url": "https://b.colab.dev/", "token": "t3"}))

    def test_refuses_a_link_with_no_address(self):
        with self.assertRaises(compute.ComputeError):
            compute.save_link(self.tmp, {"kind": "colab", "url": "file:///etc"})

    def test_the_ignore_rules_read_as_the_page_reads_them(self):
        self.assertTrue(compute.ignored("data/", "data/x.csv"))
        self.assertTrue(compute.ignored("data/", "sub/data/x.csv"))
        self.assertFalse(compute.ignored("/data/", "sub/data/x.csv"))
        self.assertTrue(compute.ignored("*.ckpt", "runs/a/model.ckpt"))
        self.assertTrue(compute.ignored("runs/**/*.log", "runs/a/b/out.log"))
        self.assertFalse(compute.ignored("# a comment\n\n", "anything.py"))

    def test_local_files_leave_out_the_rules_and_what_is_always_left_out(self):
        for name in ("main.py", "data/x.csv", ".git/HEAD", ".reader/meta.json", "pkg/__pycache__/m.pyc", "pkg/m.py", ".hidden/keep.txt"):
            (self.tmp / name).parent.mkdir(parents=True, exist_ok=True)
            (self.tmp / name).write_text("x")
        self.assertEqual(sorted(compute.local_files(self.tmp, "data/")), [".hidden/keep.txt", "main.py", "pkg/m.py"])

    def test_an_expired_colab_pass_says_how_to_renew_it(self):
        remote = compute.Remote({"kind": "colab", "url": "https://a/", "token": "t", "label": "Colab · T4", "expiresAt": int(time.time() * 1000) - 1000})
        with self.assertRaises(compute.ComputeError) as caught:
            remote.kernel()
        self.assertIn("open the project in Koios", str(caught.exception))


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipUnless(KERNEL, "no ipykernel")
class AgainstAServer(Home):
    @classmethod
    def setUpClass(cls):
        cls.there = Path(tempfile.mkdtemp())
        cls.port = free_port()
        cls.server = subprocess.Popen(
            [sys.executable, "-m", "jupyter_server", "--allow-root", "--no-browser", f"--port={cls.port}", "--IdentityProvider.token=abc", f"--ServerApp.root_dir={cls.there}"],
            cwd=cls.there, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/api/status?token=abc", timeout=1)
                break
            except OSError:
                time.sleep(0.2)

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait(10)
        shutil.rmtree(cls.there, True)

    def setUp(self):
        super().setUp()
        self.root = self.tmp / "proj"
        (self.root / "src").mkdir(parents=True)
        (self.root / "main.py").write_text('import os\nprint("ran in", os.getcwd())\n')
        (self.root / "src" / "a.txt").write_text("a")
        self.folder = f"playgrounds/{self.id().rsplit('.', 1)[-1]}"
        self.link = compute.save_link(self.root, {"kind": "jupyter", "url": f"http://127.0.0.1:{self.port}/", "token": "abc", "label": "Test box", "folder": self.folder, "ignore": "*.bin"})

    def remote_path(self, *parts) -> Path:
        # Resolved, as the kernel there sees it: on a Mac the temporary folder is under /var, which is /private/var.
        return Path(os.path.realpath(self.there)).joinpath(self.folder, *parts)

    def with_remote(self, work):
        async def go():
            remote = compute.Remote(self.link)
            await remote.open()
            try:
                return await work(remote)
            finally:
                remote.close()

        return asyncio.run(go())

    def test_push_sends_what_changed_only_and_removes_there_what_was_removed_here(self):
        (self.root / "weights.bin").write_bytes(b"0" * 10)
        first = self.with_remote(lambda r: compute.push(r, self.root))
        self.assertEqual(sorted(first["sent"]), ["main.py", "src/a.txt"])
        self.assertEqual(self.remote_path("src", "a.txt").read_text(), "a")
        self.assertFalse(self.remote_path("weights.bin").exists())
        again = self.with_remote(lambda r: compute.push(r, self.root))
        self.assertEqual((again["sent"], again["unchanged"]), ([], 2))
        # A file made there by a run is never removed by a push; one pushed and removed here is.
        self.remote_path("out.txt").write_text("result")
        (self.root / "src" / "a.txt").unlink()
        third = self.with_remote(lambda r: compute.push(r, self.root))
        self.assertEqual(third["removed"], ["src/a.txt"])
        self.assertFalse(self.remote_path("src", "a.txt").exists())
        self.assertTrue(self.remote_path("out.txt").exists())

    def test_a_file_grown_too_big_is_held_back_not_taken_for_gone(self):
        (self.root / "model.pt").write_bytes(b"0" * 10)
        self.with_remote(lambda r: compute.push(r, self.root))
        self.assertTrue(self.remote_path("model.pt").exists())
        old_big = compute.BIG
        compute.BIG = 50
        try:
            (self.root / "model.pt").write_bytes(b"1" * 60)
            report = self.with_remote(lambda r: compute.push(r, self.root))
        finally:
            compute.BIG = old_big
        self.assertEqual((report["big"], report["removed"], report["sent"]), (["model.pt"], [], []))
        self.assertEqual(self.remote_path("model.pt").read_bytes(), b"0" * 10)

    def test_pull_brings_a_folder_here(self):
        self.with_remote(lambda r: compute.push(r, self.root))
        self.remote_path("outputs", "run1").mkdir(parents=True)
        self.remote_path("outputs", "run1", "metrics.json").write_text('{"loss": 0.1}')
        report = self.with_remote(lambda r: compute.pull(r, self.root, ["outputs/"], self.root))
        self.assertEqual(report["files"], ["outputs/run1/metrics.json"])
        self.assertEqual((self.root / "outputs" / "run1" / "metrics.json").read_text(), '{"loss": 0.1}')
        with self.assertRaises(compute.ComputeError):
            self.with_remote(lambda r: compute.pull(r, self.root, ["nothing-here"], self.root))

    def koios(self, *args, cwd=None):
        return subprocess.run([sys.executable, "-m", "reader_companion.compute", *args], cwd=cwd or self.root, capture_output=True, text=True, timeout=60, env={**os.environ, "PYTHONPATH": str(Path(compute.__file__).parents[1])})

    def test_run_pushes_runs_there_in_the_same_folder_and_gives_its_exit_code(self):
        ran = self.koios("run", "python", "main.py")
        self.assertEqual(ran.returncode, 0, ran.stderr)
        self.assertIn(f"ran in {self.remote_path()}", ran.stdout)
        self.assertIn("↑ 2 files", ran.stderr)
        inner = self.koios("run", "--no-push", "pwd", cwd=self.root / "src")
        self.assertIn(str(self.remote_path("src")), inner.stdout)
        self.assertEqual(self.koios("run", "--no-push", "bash", "-c", "exit 3").returncode, 3)
        # A whole line, as the page's Run button sends it: the pipe is there's, not here's.
        piped = self.koios("run", "--no-push", "-c", "echo one two | wc -w")
        self.assertEqual(piped.stdout.strip(), "2")

    def test_outside_a_linked_folder_it_says_what_to_do(self):
        ran = self.koios("status", cwd=self.tmp)
        self.assertEqual(ran.returncode, 2)
        self.assertIn("Open the project in Koios", ran.stderr)

    def test_a_shell_there_answers_as_keys_are_typed(self):
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(self.root)
            os.environ["PYTHONPATH"] = str(Path(compute.__file__).parents[1])
            os.execvp(sys.executable, [sys.executable, "-m", "reader_companion.compute", "shell"])
        seen = b""

        def until(token, timeout=20):
            nonlocal seen
            end = time.time() + timeout
            while token not in seen and time.time() < end:
                ready, _, _ = select.select([fd], [], [], 0.2)
                if ready:
                    try:
                        seen += os.read(fd, 65536)
                    except OSError:
                        break
            return token in seen

        self.assertTrue(until(b"$ ") or until(b"# "), seen)
        os.write(fd, b"echo $((6*7))\r")
        self.assertTrue(until(b"42"), seen)
        os.write(fd, b"exit\r")
        _, status = os.waitpid(pid, 0)
        self.assertEqual(os.waitstatus_to_exitcode(status), 0)


if __name__ == "__main__":
    unittest.main()
