"""The mount (reader_companion/mount.py and koios_mount.py): a project's folder here, mounted on a "machine" that is
this computer too — the Companion's socket on 127.0.0.1, the daemon in a process of its own, a real FUSE mount where
/dev/fuse and fusepy are here (the mirror mode everywhere else) — and what each side sees of the other's changes."""

import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

from reader_companion import compute, koios_mount, mount, state

try:
    import tornado.web  # noqa: F401

    TORNADO = True
except ImportError:
    TORNADO = False

FUSE_WHY = koios_mount.fuse_available() if TORNADO else "no tornado"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for(check, timeout=15.0, every=0.05):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            value = check()
        except OSError:
            value = None
        if value:
            return value
        time.sleep(every)
    raise AssertionError("timed out waiting")


class Rules(unittest.TestCase):
    def test_the_rules_read_as_the_page_and_the_companion_read_them(self):
        compiled = koios_mount.compile_rules("data/\n*.pt\n/build\nsrc/**/gen\n# a note\n")
        for path, expected in [("data", True), ("data/x.csv", True), ("a/data/x", True), ("model.pt", True), ("ckpt/model.pt", True), ("build/x", True), ("a/build/x", False), ("src/a/b/gen/x.py", True), ("src/main.py", False)]:
            self.assertEqual(koios_mount.matches(compiled, path), expected, path)
            rule_says = any(compute.matches_rule(rule, path) for rule in "data/\n*.pt\n/build\nsrc/**/gen\n# a note\n".split("\n"))
            self.assertEqual(rule_says, expected, path)

    def test_a_frame_carries_its_header_and_its_bytes(self):
        header, payload = koios_mount.unframe(koios_mount.frame({"op": "read", "id": 3}, b"\x00\x01bytes"))
        self.assertEqual(header, {"op": "read", "id": 3})
        self.assertEqual(payload, b"\x00\x01bytes")


class Keys(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        os.environ["READER_COMPANION_HOME"] = str(self.tmp / "home")
        self.addCleanup(os.environ.pop, "READER_COMPANION_HOME", None)

    def test_a_key_opens_its_own_folder_only_is_private_and_goes_when_forgotten(self):
        a, b = self.tmp / "a", self.tmp / "b"
        a.mkdir()
        b.mkdir()
        key_a = mount.key_for(a)
        self.assertEqual(mount.key_for(a), key_a)
        key_b = mount.key_for(b)
        self.assertNotEqual(key_a, key_b)
        self.assertEqual(mount.root_for(key_a), a.resolve())
        self.assertEqual(mount.root_for(key_b), b.resolve())
        self.assertIsNone(mount.root_for("nope"))
        self.assertIsNone(mount.root_for(""))
        self.assertEqual(oct(mount.key_file(a).stat().st_mode & 0o777), "0o600")
        mount.forget_key(a)
        self.assertIsNone(mount.root_for(key_a))

    def test_the_socket_address_is_the_tunnel_as_a_websocket(self):
        self.assertEqual(mount.socket_url("https://a-b.trycloudflare.com", "/"), "wss://a-b.trycloudflare.com/companion/mount/socket")
        self.assertEqual(mount.socket_url("https://a-b.trycloudflare.com/", "/base/"), "wss://a-b.trycloudflare.com/base/companion/mount/socket")
        self.assertEqual(mount.socket_url("http://127.0.0.1:9", "/"), "ws://127.0.0.1:9/companion/mount/socket")


@unittest.skipUnless(TORNADO, "tornado isn't installed")
class Mounted(unittest.TestCase):
    """The Companion's socket in a thread, the daemon in a process, the folder edited on both sides."""

    mode = "fuse"

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        for name, value in (("READER_COMPANION_HOME", self.tmp / "home"), ("KOIOS_MOUNT_HOME", self.tmp / "mounts")):
            os.environ[name] = str(value)
            self.addCleanup(os.environ.pop, name, None)
        self.root = self.tmp / "Reader" / "playgrounds" / "p1"
        (self.root / "pkg").mkdir(parents=True)
        (self.root / "pkg" / "__init__.py").write_text("")
        (self.root / "pkg" / "model.py").write_text("WIDTH = 64\n")
        (self.root / "main.py").write_text("from pkg.model import WIDTH\nprint('width', WIDTH)\n")
        (self.root / "big.txt").write_bytes(b"x" * (3 * 1024 * 1024))
        (self.root / "data").mkdir()
        (self.root / "data" / "train.csv").write_text("never sent\n")
        (self.root / ".git").mkdir()
        (self.root / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
        compute.save_link(self.root, {"kind": "jupyter", "url": "http://127.0.0.1:1/", "token": "t", "label": "GPU box", "folder": "playgrounds/p1", "ignore": "data/\nwandb/\n*.ckpt\n*.pt\n*.safetensors\n"})
        state.current = state.Companion(name="Laptop", token="tok", id="abcdef0123456789", site="https://koios.dev/", root=str(self.tmp / "Reader"), version="0.19.0")
        self.addCleanup(setattr, state, "current", None)
        self.port = free_port()
        self.start_server()
        self.key = mount.key_for(self.root)
        self.at = self.tmp / "content" / "playgrounds" / "p1"
        # What an earlier push left there: a stale copy of a file, the helpers, and a checkpoint a run made.
        (self.at / ".reader" / "pylib").mkdir(parents=True)
        # The helpers, as the page writes them: koios_data, set to keep data in a folder standing for Drive.
        self.helper = Path(koios_mount.__file__).with_name("koios_data.py").read_text()
        self.place = self.tmp / "data-place"
        (self.at / ".reader" / "pylib" / "koios_data.py").write_text(self.helper)
        (self.at / ".reader" / "pylib" / "koios_data.json").write_text(json.dumps({"kind": "local", "dir": str(self.place), "label": "Google Drive"}))
        (self.at / "main.py").write_text("stale copy\n")
        (self.at / "old.ckpt").write_bytes(b"weights")
        self.daemon = None

    def start_server(self):
        from tornado.ioloop import IOLoop
        from tornado.web import Application

        ready = threading.Event()

        def run():
            asyncio.set_event_loop(asyncio.new_event_loop())
            self.app = Application([(r"/companion/mount/socket", mount.MountSocket)], websocket_max_message_size=256 * 1024 * 1024)
            self.server = self.app.listen(self.port, "127.0.0.1")
            self.loop = IOLoop.current()
            ready.set()
            self.loop.start()

        threading.Thread(target=run, daemon=True).start()
        ready.wait(5)

        def stop():
            self.loop.add_callback(self.server.stop)
            self.loop.add_callback(self.loop.stop)

        self.addCleanup(stop)

    def start_daemon(self, mode=None):
        log = open(self.tmp / "daemon.log", "wb")
        self.addCleanup(log.close)
        self.daemon = subprocess.Popen(
            [sys.executable, koios_mount.__file__, "serve", f"--url=ws://127.0.0.1:{self.port}/companion/mount/socket", f"--key={self.key}", f"--at={self.at}", f"--mode={mode or self.mode}"],
            stdout=log, stderr=log, env={**os.environ},
        )
        self.addCleanup(self.stop_daemon)
        try:
            wait_for(lambda: koios_mount.read_status(self.at).get("mounted") and koios_mount.read_status(self.at).get("ready"), 30)
        except AssertionError:
            raise AssertionError((self.tmp / "daemon.log").read_text()) from None

    def stop_daemon(self):
        if self.daemon and self.daemon.poll() is None:
            koios_mount.stop(self.at)
            try:
                self.daemon.wait(10)
            except subprocess.TimeoutExpired:
                self.daemon.kill()

    def test_the_folder_is_there_live_both_ways_and_the_machines_own_files_stay_on_the_machine(self):
        if self.mode == "fuse" and FUSE_WHY:
            self.skipTest(FUSE_WHY)
        self.start_daemon()
        at, root = self.at, self.root
        if self.mode == "fuse":
            self.assertTrue(os.path.ismount(at))
        # Your computer's files are there, current, and the code runs from them.
        self.assertEqual((at / "pkg" / "model.py").read_text(), "WIDTH = 64\n")
        self.assertEqual((at / "main.py").read_text(), root.joinpath("main.py").read_text())
        self.assertEqual((at / "big.txt").stat().st_size, 3 * 1024 * 1024)
        self.assertEqual((at / "big.txt").read_bytes(), root.joinpath("big.txt").read_bytes())
        ran = subprocess.run([sys.executable, "main.py"], cwd=at, capture_output=True, text=True, timeout=30)
        self.assertEqual(ran.stdout.strip(), "width 64", ran.stderr)
        # What the rules leave out never came over; what the machine had of its own is still there.
        self.assertFalse((at / "data" / "train.csv").exists())
        self.assertFalse((at / ".git" / "HEAD").exists())
        self.assertEqual((at / ".reader" / "pylib" / "koios_data.py").read_text(), self.helper)
        self.assertEqual((at / "old.ckpt").read_bytes(), b"weights")

        # A save on your computer is there a moment later, with nothing asked for.
        (root / "pkg" / "model.py").write_text("WIDTH = 128\n")
        wait_for(lambda: (at / "pkg" / "model.py").read_text() == "WIDTH = 128\n", 10)
        ran = subprocess.run([sys.executable, "main.py"], cwd=at, capture_output=True, text=True, timeout=30)
        self.assertEqual(ran.stdout.strip(), "width 128", ran.stderr)
        (root / "pkg" / "new.py").write_text("NEW = 1\n")
        wait_for(lambda: (at / "pkg" / "new.py").exists() and (at / "pkg" / "new.py").read_text() == "NEW = 1\n", 10)
        (root / "pkg" / "new.py").unlink()
        wait_for(lambda: not (at / "pkg" / "new.py").exists(), 10)

        # What a run writes there: code-like files go back to your computer, checkpoints stay on the machine.
        (at / "results").mkdir(exist_ok=True)
        (at / "results" / "metrics.json").write_text('{"loss": 0.1}')
        wait_for(lambda: (root / "results" / "metrics.json").exists() and (root / "results" / "metrics.json").read_text() == '{"loss": 0.1}', 10)
        (at / "model.pt").write_bytes(b"\x00" * 4096)
        (at / "wandb").mkdir()
        (at / "wandb" / "run.log").write_text("stays\n")
        (at / "pkg" / "__pycache__").mkdir(exist_ok=True)
        (at / "pkg" / "__pycache__" / "x.pyc").write_bytes(b"pyc")
        time.sleep(1.5)
        self.assertFalse((root / "model.pt").exists())
        self.assertFalse((root / "wandb").exists())
        self.assertFalse((root / "pkg" / "__pycache__").exists())
        self.assertEqual((at / "model.pt").stat().st_size, 4096)
        self.assertIn("model.pt", os.listdir(at))
        # ... and the checkpoint is put in the data place a few seconds after it was closed; the caches never are.
        try:
            wait_for(lambda: (self.place / "model.pt").exists() and (self.place / "model.pt").stat().st_size == 4096, 15)
        except AssertionError:
            raise AssertionError((self.tmp / "daemon.log").read_text() + json.dumps(koios_mount.read_status(at))) from None
        wait_for(lambda: (self.place / "wandb" / "run.log").exists(), 15)
        self.assertFalse((self.place / "pkg").exists())
        self.assertEqual(koios_mount.read_status(at)["data"]["place"], "Google Drive · " + str(self.place))

        # Edits, renames and removals there are made on your computer.
        with open(at / "main.py", "a") as f:
            f.write("# tuned on the GPU\n")
        wait_for(lambda: root.joinpath("main.py").read_text().endswith("# tuned on the GPU\n"), 10)
        os.rename(at / "results" / "metrics.json", at / "results" / "final.json")
        wait_for(lambda: (root / "results" / "final.json").exists() and not (root / "results" / "metrics.json").exists(), 10)
        os.unlink(at / "results" / "final.json")
        wait_for(lambda: not (root / "results" / "final.json").exists(), 10)
        # ... and a write from the machine isn't sent back to it as a change of yours.
        status = koios_mount.read_status(at)
        self.assertTrue(status["connected"])
        self.assertEqual(status["mode"], self.mode)

    def on_server(self, work):
        done = threading.Event()

        def go():
            work()
            done.set()

        self.loop.add_callback(go)
        done.wait(5)

    def test_a_write_while_your_computer_is_away_waits_and_goes_when_it_is_back(self):
        if self.mode == "fuse" and FUSE_WHY:
            self.skipTest(FUSE_WHY)
        self.start_daemon()

        def away():
            self.server.stop()
            for conn in list(mount.Share.of(self.root).conns):
                conn.close()

        self.on_server(away)
        wait_for(lambda: not koios_mount.read_status(self.at)["connected"], 10)
        # The program writing it isn't stopped by the computer being away: the file waits on the machine.
        (self.at / "notes.txt").write_text("written while away\n")
        self.assertEqual((self.at / "notes.txt").read_text(), "written while away\n")
        self.assertFalse((self.root / "notes.txt").exists())

        def back():
            self.server = self.app.listen(self.port, "127.0.0.1")

        self.on_server(back)
        wait_for(lambda: (self.root / "notes.txt").exists() and (self.root / "notes.txt").read_text() == "written while away\n", 40)

    def test_stopping_gives_the_machines_own_files_back_and_the_key_is_refused_after_it_is_forgotten(self):
        if self.mode == "fuse" and FUSE_WHY:
            self.skipTest(FUSE_WHY)
        self.start_daemon()
        (self.at / "ckpt.pt").write_bytes(b"w")
        koios_mount.stop(self.at)
        self.daemon.wait(10)
        self.assertFalse(os.path.ismount(self.at))
        self.assertEqual((self.at / "ckpt.pt").read_bytes(), b"w")
        self.assertEqual((self.at / ".reader" / "pylib" / "koios_data.py").read_text(), self.helper)
        mount.forget_key(self.root)
        from tornado.httpclient import HTTPClientError
        from tornado.websocket import websocket_connect

        async def dial():
            await websocket_connect(f"ws://127.0.0.1:{self.port}/companion/mount/socket?key={self.key}")

        with self.assertRaises(HTTPClientError) as refused:
            asyncio.new_event_loop().run_until_complete(dial())
        self.assertEqual(refused.exception.code, 403)


class Mirrored(Mounted):
    """Where FUSE isn't allowed: a real directory, kept current both ways."""

    mode = "mirror"

    def test_stopping_gives_the_machines_own_files_back_and_the_key_is_refused_after_it_is_forgotten(self):
        self.start_daemon()
        (self.at / "ckpt.pt").write_bytes(b"w")
        koios_mount.stop(self.at)
        self.daemon.wait(10)
        self.assertEqual((self.at / "ckpt.pt").read_bytes(), b"w")


@unittest.skipUnless(TORNADO, "tornado isn't installed")
class SocketRefusals(Mounted):
    """What the socket refuses whatever the machine asks: paths out of the folder, the machine's own paths."""

    def test_paths_out_of_the_folder_or_left_out_by_the_rules_are_refused(self):
        share = mount.Share.of(self.root)
        for bad in ("../x", "/etc/passwd", "a//b", ".git/HEAD", "data/train.csv", "w.pt", ""):
            with self.assertRaises(OSError, msg=bad):
                share.path(bad)
        self.assertEqual(share.path("pkg/model.py"), self.root.resolve() / "pkg" / "model.py")
        os.symlink("/etc", self.root / "out")
        with self.assertRaises(OSError):
            share.path("out/passwd")
        os.symlink("/etc/hostname", self.root / "host.txt")
        with self.assertRaises(OSError):
            share.path("host.txt")
        os.symlink("pkg/model.py", self.root / "alias.py")
        self.assertEqual(share.path("alias.py"), self.root.resolve() / "alias.py")
        files, dirs = mount.scan(self.root, share.compiled)
        self.assertIn("alias.py", files)
        self.assertNotIn("host.txt", files)
        self.assertNotIn("out", dirs)

    test_the_folder_is_there_live_both_ways_and_the_machines_own_files_stay_on_the_machine = None
    test_a_write_while_your_computer_is_away_waits_and_goes_when_it_is_back = None
    test_stopping_gives_the_machines_own_files_back_and_the_key_is_refused_after_it_is_forgotten = None


if __name__ == "__main__":
    unittest.main()


try:
    import ipykernel  # noqa: F401
    import jupyter_server  # noqa: F401

    KERNEL = True
except ImportError:
    KERNEL = False

if TORNADO:
    from tornado.testing import AsyncHTTPTestCase
    from tornado.web import Application

    from reader_companion import extension

    @unittest.skipUnless(KERNEL, "no jupyter_server and ipykernel")
    class ThroughTheLink(AsyncHTTPTestCase):
        """POST companion/compute {action: "mount"}: the page's one call. A Jupyter server stands for the GPU box,
        and the Companion's own address for its tunnel; the daemon is started through the link's kernel there."""

        @classmethod
        def setUpClass(cls):
            cls.tmp = Path(tempfile.mkdtemp())
            cls.there = cls.tmp / "gpu"
            cls.there.mkdir()
            cls.port = free_port()
            mode = "fuse" if not FUSE_WHY else "mirror"
            cls.mode = mode
            cls.server = subprocess.Popen(
                [sys.executable, "-m", "jupyter_server", "--allow-root", "--no-browser", f"--port={cls.port}", "--IdentityProvider.token=abc", f"--ServerApp.root_dir={cls.there}"],
                cwd=cls.there, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={**os.environ, "KOIOS_MOUNT_HOME": str(cls.tmp / "mounts")},
            )
            import urllib.request

            for _ in range(100):
                try:
                    urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/api/status?token=abc", timeout=1)
                    break
                except OSError:
                    time.sleep(0.2)

        @classmethod
        def tearDownClass(cls):
            at = cls.there / "playgrounds" / "p1"
            os.environ["KOIOS_MOUNT_HOME"] = str(cls.tmp / "mounts")
            koios_mount.stop(at)
            os.environ.pop("KOIOS_MOUNT_HOME", None)
            cls.server.terminate()
            cls.server.wait(10)
            shutil.rmtree(cls.tmp, True)

        def setUp(self):
            super().setUp()
            self.home = Path(tempfile.mkdtemp())
            self.addCleanup(shutil.rmtree, self.home, True)
            os.environ["READER_COMPANION_HOME"] = str(self.home / "companion")
            self.addCleanup(os.environ.pop, "READER_COMPANION_HOME", None)
            self.root = self.home / "Reader"
            (self.root / "playgrounds" / "p1").mkdir(parents=True)
            (self.root / "playgrounds" / "p1" / "train.py").write_text("print('training')\n")
            state.current = state.Companion(name="Laptop", token="t", id="abcdef0123456789", site="https://koios.dev/", root=str(self.root), version="0.19.0")
            state.current.tunnel_url = f"http://127.0.0.1:{self.get_http_port()}"
            self.addCleanup(setattr, state, "current", None)

        def get_app(self):
            return Application([(r"/companion/compute", extension.ComputeHandler), (r"/companion/mount/socket", mount.MountSocket)])

        def call(self, body=None, method="POST", path="/companion/compute", origin=True):
            headers = {"Authorization": "token t", **({"Origin": "https://koios.dev"} if origin else {})}
            url = self.get_url(path)
            return self.io_loop.run_sync(lambda: self.http_client.fetch(url, method=method, headers=headers, body=None if body is None else json.dumps(body), request_timeout=240, raise_error=False), timeout=240)

        def test_one_call_mounts_the_folder_on_the_machine_and_another_stops_it(self):
            self.assertEqual(self.call({"root": "playgrounds/p1", "action": "mount"}).code, 409)  # not linked yet
            link = {"kind": "jupyter", "url": f"http://127.0.0.1:{self.port}/", "token": "abc", "label": "GPU box", "folder": "playgrounds/p1", "ignore": "*.pt\n"}
            self.assertEqual(self.call({"root": "playgrounds/p1", "compute": link}).code, 200)
            answer = self.call({"root": "playgrounds/p1", "action": "mount"})
            body = json.loads(answer.body)
            self.assertEqual(answer.code, 200, body)
            self.assertEqual((body["mode"], body["mounted"], body["connected"]), (self.mode, True, 1))
            self.assertNotIn("abc", answer.body.decode())
            at = self.there / "playgrounds" / "p1"
            self.assertEqual((at / "train.py").read_text(), "print('training')\n")
            shown = json.loads(self.call(method="GET", path="/companion/compute?root=playgrounds/p1").body)
            self.assertEqual(shown["mount"], {"on": True, "mode": self.mode, "connected": 1})
            # The link handed over again (the pass renewed) keeps the mount.
            self.call({"root": "playgrounds/p1", "compute": {**link, "token": "abc"}})
            self.assertTrue(json.loads(self.call(method="GET", path="/companion/compute?root=playgrounds/p1").body)["mount"]["on"])
            # This computer's own programs (koios mount) may ask too: no Origin, the token.
            asked = self.call({"root": "playgrounds/p1", "action": "mount-status"}, origin=False)
            self.assertEqual((asked.code, json.loads(asked.body)["running"]), (200, True))
            # The page's Copy, while mounted: nothing to send.
            pushed = json.loads(self.call({"root": "playgrounds/p1", "action": "push"}).body)
            self.assertEqual((pushed["mounted"], pushed["sent"]), (True, []))
            stopped = self.call({"root": "playgrounds/p1", "action": "unmount"})
            self.assertEqual(stopped.code, 200, stopped.body)
            self.assertFalse(os.path.ismount(at))
            self.assertIsNone(mount.root_for(mount.key_for(self.root / "playgrounds" / "p1") + "x"))
            shown = json.loads(self.call(method="GET", path="/companion/compute?root=playgrounds/p1").body)
            self.assertEqual(shown["mount"]["on"], False)
