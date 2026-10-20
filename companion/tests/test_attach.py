"""A folder shared on one computer and attached on another (reader_companion/attach.py, mount.share_folder): both
"computers" are this one — the Companion's socket on 127.0.0.1 serving a share, and the attach side as a Disk in
this process, its WebDAV server spoken to with http.client, and a real FUSE attach where /dev/fuse and fusepy are."""

import asyncio
import http.client
import os
import shutil
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from reader_companion import attach, mount, state

try:
    import tornado.web  # noqa: F401

    TORNADO = True
except ImportError:
    TORNADO = False

FUSE_WHY = attach.fuse_check() if TORNADO else "no tornado"


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


class Codes(unittest.TestCase):
    def test_an_attach_code_carries_the_address_and_key(self):
        code = attach.attach_code("wss://a.trycloudflare.com/companion/mount/socket", "-k3y_", "Photos", "Laptop")
        self.assertTrue(code.startswith("koios-attach:"))
        self.assertEqual(attach.read_code("  " + code + "\n"), {"url": "wss://a.trycloudflare.com/companion/mount/socket", "key": "-k3y_", "name": "Photos", "from": "Laptop"})
        self.assertEqual(attach.read_code(code[len("koios-attach:"):])["name"], "Photos")
        with self.assertRaises(ValueError):
            attach.read_code(attach.attach_code("https://x", "k", "n", "s"))

    def test_the_whole_disk_and_the_home_folder_cant_be_shared(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        with mock.patch.dict(os.environ, {"READER_COMPANION_HOME": str(tmp / "home")}):
            with self.assertRaises(ValueError):
                mount.share_folder(Path("/"))
            with self.assertRaises(ValueError):
                mount.share_folder(Path.home())
            with self.assertRaises(ValueError):
                mount.share_folder(tmp / "not-there")
            (tmp / "f").mkdir()
            first = mount.share_folder(tmp / "f", "Folder")
            self.assertEqual(mount.share_folder(tmp / "f")["key"], first["key"])
            self.assertEqual(mount.record_for(first["key"])["lazy"], True)
            self.assertEqual(oct(os.stat(mount.share_file(tmp / "f")).st_mode & 0o777), "0o600")
            self.assertTrue(mount.stop_share(tmp / "f"))
            self.assertIsNone(mount.record_for(first["key"]))


class MountCommands(unittest.TestCase):
    """What each system is asked to mount the WebDAV share with (the commands, not run)."""

    def run_as(self, system, which=lambda name: "/usr/bin/" + name, stdout=""):
        calls = []

        def fake_run(args, **kwargs):
            calls.append(args)
            return mock.Mock(returncode=0, stdout=stdout, stderr="")

        with mock.patch.object(attach, "SYSTEM", system), mock.patch.object(attach.subprocess, "run", fake_run), mock.patch.object(attach.shutil, "which", which):
            return calls, fake_run

    def test_mac_windows_and_linux(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        url = "http://127.0.0.1:5555/s3cret/"
        calls = []

        def fake_run(args, **kwargs):
            calls.append(args)
            return mock.Mock(returncode=0, stdout="Drive Z: is now connected to http://127.0.0.1:5555/s3cret/.", stderr="")

        with mock.patch.object(attach.subprocess, "run", fake_run):
            with mock.patch.object(attach, "SYSTEM", "Darwin"):
                self.assertEqual(attach.os_mount(url, str(tmp / "Photos"), "Photos"), str(tmp / "Photos"))
            with mock.patch.object(attach, "SYSTEM", "Windows"):
                self.assertEqual(attach.os_mount(url, "", "Photos"), "Z:")
        self.assertEqual(calls[0], ["mount_webdav", "-S", "-v", "Photos", url, str(tmp / "Photos")])
        self.assertEqual(calls[1], ["net", "use", "*", url, "/persistent:no"])
        self.assertEqual(attach.clean_label('a/b:c*"d'), "a-b-c--d")


@unittest.skipUnless(TORNADO, "no tornado")
class Attached(unittest.TestCase):
    """A shared folder here, attached here through the socket."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        os.environ["READER_COMPANION_HOME"] = str(self.tmp / "home")
        self.addCleanup(os.environ.pop, "READER_COMPANION_HOME", None)
        self.root = self.tmp / "Laptop" / "Photos"
        (self.root / "2024").mkdir(parents=True)
        (self.root / "2024" / "a.jpg").write_bytes(os.urandom(3 * attach.BLOCK + 123))
        (self.root / "notes.txt").write_text("hello\n")
        (self.root / ".git").mkdir()
        (self.root / ".git" / "HEAD").write_text("ref\n")
        state.current = state.Companion(name="Laptop", token="tok", id="abcdef0123456789", site="https://koios.dev/", root=str(self.tmp / "Reader"), version="0.20.0")
        self.addCleanup(setattr, state, "current", None)
        self.port = free_port()
        self.start_server()
        self.share = mount.share_folder(self.root, "Photos")
        self.url = f"ws://127.0.0.1:{self.port}/companion/mount/socket"

    def start_server(self):
        from tornado.ioloop import IOLoop
        from tornado.web import Application

        ready = threading.Event()

        def run():
            asyncio.set_event_loop(asyncio.new_event_loop())
            self.server = Application([(r"/companion/mount/socket", mount.MountSocket)], websocket_max_message_size=256 * 1024 * 1024).listen(self.port, "127.0.0.1")
            self.loop = IOLoop.current()
            ready.set()
            self.loop.start()

        threading.Thread(target=run, daemon=True).start()
        ready.wait(5)

        def stop():
            mount.Share.all.clear()
            self.loop.add_callback(self.server.stop)
            self.loop.add_callback(self.loop.stop)

        self.addCleanup(stop)

    def disk(self, cache="used") -> attach.Disk:
        disk = attach.Disk(self.url, self.share["key"], self.tmp / "attached" / cache, cache, say=lambda text: None)
        disk.wire.start()
        self.addCleanup(disk.wire.stop)
        self.assertTrue(disk.ready.wait(10), disk.wire.error)
        return disk

    def test_only_what_is_opened_is_fetched_and_changes_go_both_ways(self):
        disk = self.disk()
        self.assertEqual((disk.label, disk.name), ("Laptop", "Photos"))
        root = disk.listdir("")
        self.assertEqual(sorted(root), [".git", "2024", "notes.txt"])  # a share is the folder as it is: .git too
        self.assertEqual(disk.counts["listed"], 1)
        # A read in the middle of a file: only its block comes over.
        data = (self.root / "2024" / "a.jpg").read_bytes()
        self.assertEqual(disk.read("2024/a.jpg", attach.BLOCK + 10, 100), data[attach.BLOCK + 10 : attach.BLOCK + 110])
        self.assertEqual(disk.counts["bytes_in"], attach.BLOCK)
        self.assertNotIn("2024/a.jpg", disk.have)
        self.assertEqual(disk.read("2024/a.jpg", 0, len(data)), data)
        self.assertEqual(disk.have["2024/a.jpg"][0], len(data))
        before = disk.counts["bytes_in"]
        disk.read("2024/a.jpg", 5, 5)
        self.assertEqual(disk.counts["bytes_in"], before)  # kept
        # A change on the laptop, to a folder listed here: pushed.
        (self.root / "notes.txt").write_text("changed there\n")
        wait_for(lambda: disk.lookup("notes.txt")[1] == len("changed there\n"))
        self.assertEqual(disk.read("notes.txt", 0, 100), b"changed there\n")
        (self.root / "new.txt").write_text("n")
        wait_for(lambda: disk.lookup("new.txt"))
        # Written here: there when closed.
        target = disk.begin_write("made.txt", True)
        target.write_bytes(b"from the other computer")
        disk.end_write("made.txt")
        self.assertEqual((self.root / "made.txt").read_bytes(), b"from the other computer")
        disk.mkdir("dir")
        disk.rename("made.txt", "dir/moved.txt")
        self.assertEqual((self.root / "dir" / "moved.txt").read_bytes(), b"from the other computer")
        self.assertIsNone(disk.lookup("made.txt"))
        disk.copy("dir", "dir2")
        self.assertTrue((self.root / "dir2" / "moved.txt").exists())
        disk.remove("dir2")
        self.assertFalse((self.root / "dir2").exists())
        self.assertEqual(disk.statfs()[0], shutil.disk_usage(self.root).total)

    def test_a_stopped_share_cuts_the_other_computer_off(self):
        disk = self.disk()
        mount.stop_share(self.root)
        wait_for(lambda: not disk.wire.up.is_set())
        with self.assertRaises(Exception):
            disk.wire.call({"op": "list", "path": ""}, wait=1)

    def test_the_way_out_of_the_folder_is_refused(self):
        disk = self.disk()
        for rel in ("../Laptop", "2024/../../x"):
            with self.assertRaises(Exception):
                disk.wire.call({"op": "list", "path": rel})

    def test_cache_all_fetches_everything_in_the_background(self):
        disk = self.disk("all")
        wait_for(lambda: disk.fill["done"], 20)
        self.assertEqual(set(disk.have), {"2024/a.jpg", "notes.txt", ".git/HEAD"})

    def test_cache_none_keeps_nothing(self):
        disk = self.disk("none")
        disk.read("notes.txt", 0, 100)
        disk.read("notes.txt", 0, 100)
        self.assertEqual(disk.counts["read"], 2)
        self.assertEqual(disk.have, {})

    def test_webdav_the_way_finder_and_windows_speak_it(self):
        disk = self.disk()
        dav = attach.DavServer(disk, "s3cret")
        dav.serve()
        self.addCleanup(dav.close)

        def call(method, path, body=None, headers=None):
            conn = http.client.HTTPConnection("127.0.0.1", dav.port, timeout=10)
            conn.request(method, path, body=body, headers=headers or {})
            response = conn.getresponse()
            out = (response.status, response.read(), dict(response.getheaders()))
            conn.close()
            return out

        self.assertEqual(call("PROPFIND", "/wrong/", headers={"Depth": "1"})[0], 404)
        code, body, _ = call("PROPFIND", "/s3cret/", headers={"Depth": "1"})
        self.assertEqual(code, 207)
        self.assertIn(b"/s3cret/2024/", body)
        self.assertIn(b"<D:collection/>", body)
        self.assertIn(b"notes.txt", body)
        code, body, _ = call("PROPFIND", "/s3cret/notes.txt", headers={"Depth": "0"})
        self.assertIn(b"<D:getcontentlength>6</D:getcontentlength>", body)
        data = (self.root / "2024" / "a.jpg").read_bytes()
        code, body, headers = call("GET", "/s3cret/2024/a.jpg", headers={"Range": "bytes=100-199"})
        self.assertEqual((code, body, headers["Content-Range"]), (206, data[100:200], f"bytes 100-199/{len(data)}"))
        code, body, _ = call("GET", "/s3cret/2024/a.jpg")
        self.assertEqual(body, data)
        self.assertEqual(call("HEAD", "/s3cret/notes.txt")[0], 200)
        # Finder: chunked PUT, its ._ files kept here, MKCOL, MOVE, COPY, DELETE, LOCK.
        conn = http.client.HTTPConnection("127.0.0.1", dav.port, timeout=10)
        conn.putrequest("PUT", "/s3cret/up%20load.txt")
        conn.putheader("Transfer-Encoding", "chunked")
        conn.endheaders()
        for piece in (b"first ", b"second"):
            conn.send(b"%x\r\n%s\r\n" % (len(piece), piece))
        conn.send(b"0\r\n\r\n")
        self.assertEqual(conn.getresponse().status, 201)
        conn.close()
        self.assertEqual((self.root / "up load.txt").read_bytes(), b"first second")
        self.assertEqual(call("PUT", "/s3cret/._up load.txt".replace(" ", "%20"), b"finder junk")[0], 201)
        self.assertFalse((self.root / "._up load.txt").exists())
        self.assertIn(b"._up%20load.txt", call("PROPFIND", "/s3cret/", headers={"Depth": "1"})[1])
        self.assertEqual(call("MKCOL", "/s3cret/new")[0], 201)
        self.assertTrue((self.root / "new").is_dir())
        self.assertEqual(call("MKCOL", "/s3cret/no/such")[0], 409)
        self.assertEqual(call("MOVE", "/s3cret/up%20load.txt", headers={"Destination": f"http://127.0.0.1:{dav.port}/s3cret/new/moved.txt"})[0], 201)
        self.assertEqual((self.root / "new" / "moved.txt").read_bytes(), b"first second")
        self.assertEqual(call("COPY", "/s3cret/notes.txt", headers={"Destination": "/s3cret/new/moved.txt", "Overwrite": "F"})[0], 412)
        self.assertEqual(call("COPY", "/s3cret/notes.txt", headers={"Destination": "/s3cret/copy.txt"})[0], 201)
        self.assertEqual((self.root / "copy.txt").read_text(), "hello\n")
        code, body, headers = call("LOCK", "/s3cret/copy.txt", b"<lockinfo/>")
        self.assertEqual(code, 200)
        self.assertIn("opaquelocktoken:", headers["Lock-Token"])
        self.assertEqual(call("UNLOCK", "/s3cret/copy.txt", headers={"Lock-Token": headers["Lock-Token"]})[0], 204)
        self.assertEqual(call("DELETE", "/s3cret/new")[0], 204)
        self.assertFalse((self.root / "new").exists())
        self.assertEqual(call("GET", "/s3cret/new/moved.txt")[0], 404)
        self.assertIn("DAV", call("OPTIONS", "/s3cret/")[2])

    @unittest.skipIf(FUSE_WHY, FUSE_WHY or "")
    def test_attached_with_fuse_as_a_disk(self):
        where = self.tmp / "drives" / "Photos"
        status = attach.start(self.url, self.share["key"], backend="fuse", label="Photos", source="Laptop", where=str(where), wait_s=30)
        ident = attach.attach_id(self.url, self.share["key"])
        self.addCleanup(attach.stop, ident, True)
        self.assertTrue(status.get("mounted"), status)
        self.assertNotIn("key", attach.list_all()[0])
        self.assertTrue(os.path.ismount(where))
        self.assertEqual(sorted(os.listdir(where)), [".git", "2024", "notes.txt"])
        self.assertEqual((where / "2024" / "a.jpg").read_bytes(), (self.root / "2024" / "a.jpg").read_bytes())
        (where / "written.txt").write_text("from the disk\n")
        self.assertEqual((self.root / "written.txt").read_text(), "from the disk\n")
        (where / ".DS_Store").write_bytes(b"finder")
        self.assertFalse((self.root / ".DS_Store").exists())
        (where / "2024" / "a.jpg").rename(where / "b.jpg")
        self.assertTrue((self.root / "b.jpg").exists())
        (where / "dir").mkdir()
        (where / "dir").rmdir()
        (self.root / "laptop.txt").write_text("saved on the laptop")
        wait_for(lambda: (where / "laptop.txt").exists(), 10)
        self.assertEqual((where / "laptop.txt").read_text(), "saved on the laptop")
        self.assertEqual(attach.start(self.url, self.share["key"], backend="fuse", where=str(where)).get("reused"), True)
        attach.stop(ident)
        wait_for(lambda: not os.path.ismount(where), 10)



if TORNADO:
    import json

    from tornado.testing import AsyncHTTPTestCase
    from tornado.web import Application

    from reader_companion import extension

    class Routes(AsyncHTTPTestCase):
        """companion/share on the computer with the folder, companion/attach on the other: the page's two calls (here
        one Companion is both, and its own address stands for its tunnel)."""

        def setUp(self):
            super().setUp()
            self.tmp = Path(tempfile.mkdtemp())
            self.addCleanup(shutil.rmtree, self.tmp, True)
            os.environ["READER_COMPANION_HOME"] = str(self.tmp / "home")
            self.addCleanup(os.environ.pop, "READER_COMPANION_HOME", None)
            self.folder = self.tmp / "Documents" / "Thesis"
            self.folder.mkdir(parents=True)
            (self.folder / "chapter1.tex").write_text("\\section{One}\n")
            state.current = state.Companion(name="Laptop", token="t", id="abcdef0123456789", site="https://koios.dev/", root=str(self.tmp / "Reader"), version="0.20.0")
            state.current.tunnel_url = f"http://127.0.0.1:{self.get_http_port()}"
            self.addCleanup(setattr, state, "current", None)
            self.addCleanup(mount.Share.all.clear)

        def get_app(self):
            return Application([(r"/companion/share", extension.ShareHandler), (r"/companion/attach", extension.AttachHandler), (r"/companion/mount/socket", mount.MountSocket)])

        def call(self, path, body=None, origin=True, token="t"):
            headers = {"Authorization": f"token {token}", **({"Origin": "https://koios.dev"} if origin else {})}
            fetch = lambda: self.http_client.fetch(self.get_url(path), method="GET" if body is None else "POST", headers=headers, body=None if body is None else json.dumps(body), request_timeout=120, raise_error=False)  # noqa: E731
            answer = self.io_loop.run_sync(fetch, timeout=120)
            return answer.code, json.loads(answer.body or b"{}")

        def test_a_folder_shared_and_attached_through_the_routes(self):
            self.assertEqual(self.call("/companion/share", {"path": str(self.folder)}, token="wrong")[0], 403)
            self.assertEqual(self.call("/companion/share", {"path": str(self.folder)}, origin=False, token="wrong")[0], 403)
            self.assertEqual(self.call("/companion/share", {"path": "/"})[0], 400)
            code, shared = self.call("/companion/share", {"path": str(self.folder), "name": "Thesis"})
            self.assertEqual(code, 200, shared)
            self.assertEqual((shared["name"], shared["computer"]), ("Thesis", "Laptop"))
            self.assertTrue(shared["url"].startswith("ws://127.0.0.1:"))
            self.assertEqual(attach.read_code(shared["code"])["key"], shared["key"])
            code, listed = self.call("/companion/share")
            self.assertEqual([s["name"] for s in listed["shares"]], ["Thesis"])
            self.assertNotIn(shared["key"], json.dumps(listed))
            code, found = self.call("/companion/attach", origin=False)  # this computer's own program: no Origin
            self.assertEqual((code, found["attached"]), (200, []))
            self.assertIn(found["backends"]["os"], ("linux", "mac", "windows"))
            self.assertEqual(self.call("/companion/attach", {"code": "nonsense"})[0], 400)
            self.assertEqual(self.call("/companion/attach", {"action": "detach", "id": "../../x"})[0], 400)
            if FUSE_WHY:
                return
            where = self.tmp / "drives" / "Thesis"
            code, done = self.call("/companion/attach", {"code": shared["code"], "backend": "fuse", "where": str(where)})
            self.addCleanup(attach.stop, attach.attach_id(shared["url"], shared["key"]), True)
            self.assertEqual(code, 200, done)
            # Read while the loop serves the socket (as the Companion's always does).
            text = self.io_loop.run_sync(lambda: self.io_loop.run_in_executor(None, (where / "chapter1.tex").read_text), timeout=30)
            self.assertEqual(text, "\\section{One}\n")
            self.assertNotIn(shared["key"], json.dumps(self.call("/companion/attach")[1]))
            code, gone = self.call("/companion/attach", {"action": "detach", "id": done["id"]})
            self.assertEqual((code, gone["attached"]), (200, []))
            wait_for(lambda: not os.path.ismount(where), 10)
            self.assertEqual(self.call("/companion/share", {"path": str(self.folder), "action": "stop"})[1]["shares"], [])

if __name__ == "__main__":
    unittest.main()
