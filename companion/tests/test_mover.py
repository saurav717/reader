"""The mover (reader_companion/mover.py) against a stand-in Worker and a stand-in Drive, served on 127.0.0.1: a folder
packed into parts and unpacked elsewhere whole, binaries and links included; a damaged archive caught; a cancelled
move stopped; nothing written outside the folder; Drive pulled and pushed; the old copy removed, a linked one only
unlinked.

    cd companion && python -m unittest tests.test_mover
"""

import hashlib
import json
import os
import tempfile
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from reader_companion import mover


class FakeWorker:
    def __init__(self):
        self.parts = {}
        self.reports = []
        self.manifest = None
        self.cancelled = False
        self.token = "drive-token"
        self.corrupt = False
        self.drop_once = False


class FakeDrive:
    """Drive's files: id → {name, mimeType, parents, data}."""

    def __init__(self):
        self.files = {"root": {"name": "Project", "mimeType": mover.FOLDER_MIME, "parents": [], "data": b""}}
        self.next = 0

    def add(self, name, parent, data=None):
        self.next += 1
        key = f"f{self.next}"
        self.files[key] = {"name": name, "mimeType": mover.FOLDER_MIME if data is None else "text/plain", "parents": [parent], "data": data or b""}
        return key

    def path_of(self, key):
        parts = []
        while key != "root":
            parts.append(self.files[key]["name"])
            key = self.files[key]["parents"][0]
        return "/".join(reversed(parts))


def serve(worker: FakeWorker, drive: FakeDrive):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def answer(self, status, body=b"", kind="application/json", headers=None):
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def body(self):
            return self.rfile.read(int(self.headers.get("Content-Length") or 0))

        def archive(self):
            return b"".join(worker.parts[n] for n in sorted(worker.parts))

        def handle_any(self, method):
            url = urllib.parse.urlparse(self.path)
            query = dict(urllib.parse.parse_qsl(url.query))
            if url.path.startswith("/moves/"):
                if self.headers.get("X-Move-Key") != "key":
                    return self.answer(403, b'{"error":"key"}')
                if url.path == "/moves/part":
                    worker.parts[int(query["n"])] = self.body()
                    return self.answer(200, b"{}")
                if url.path == "/moves/report":
                    report = json.loads(self.body())
                    worker.reports.append(report)
                    if report.get("manifest") is not None:
                        worker.manifest = report["manifest"]
                    return self.answer(200, json.dumps({"ok": True, "cancelled": worker.cancelled}).encode())
                if url.path == "/moves/manifest":
                    return self.answer(200, json.dumps({"files": worker.manifest}).encode())
                if url.path == "/moves/token":
                    return self.answer(200, json.dumps({"token": worker.token}).encode())
                if url.path == "/moves/archive":
                    data = self.archive()
                    if worker.corrupt:
                        data = data[:-40] + bytes(40)
                    start = int((self.headers.get("Range") or "bytes=0-")[6:].split("-")[0])
                    return self.answer(206 if start else 200, data[start:], "application/octet-stream")
            if url.path.startswith("/drive/v3/files") or url.path.startswith("/upload/drive/v3/files"):
                return self.drive(method, url, query)
            self.answer(404)

        def drive(self, method, url, query):
            if self.headers.get("Authorization") != f"Bearer {worker.token}":
                return self.answer(401, b"{}")
            parts = url.path.split("/")
            if url.path == "/drive/v3/files" and method == "GET":
                parent = query["q"].split("'")[1]
                found = [{"id": k, "name": f["name"], "mimeType": f["mimeType"], "size": str(len(f["data"])), "md5Checksum": hashlib.md5(f["data"]).hexdigest()} for k, f in drive.files.items() if parent in f["parents"]]
                return self.answer(200, json.dumps({"files": found}).encode())
            if url.path == "/drive/v3/files" and method == "POST":
                meta = json.loads(self.body())
                return self.answer(200, json.dumps({"id": drive.add(meta["name"], meta["parents"][0])}).encode())
            if parts[1] == "drive" and method == "GET" and query.get("alt") == "media":
                return self.answer(200, drive.files[parts[4]]["data"], "application/octet-stream")
            if parts[1] == "upload":
                body = self.body()
                boundary = "--reader-mover-boundary"
                chunks = body.split(boundary.encode())
                meta = json.loads(chunks[1].split(b"\r\n\r\n", 1)[1].rsplit(b"\r\n", 1)[0])
                data = chunks[2].split(b"\r\n\r\n", 1)[1][:-2]
                if len(parts) > 5:
                    drive.files[parts[5]]["data"] = data
                    key = parts[5]
                else:
                    key = drive.add(meta["name"], meta["parents"][0], data)
                return self.answer(200, json.dumps({"id": key}).encode())
            self.answer(404)

        def do_GET(self):
            self.handle_any("GET")

        def do_POST(self):
            self.handle_any("POST")

        def do_PUT(self):
            self.handle_any("PUT")

        def do_PATCH(self):
            self.handle_any("PATCH")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class MoverTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.worker = FakeWorker()
        self.drive = FakeDrive()
        self.server = serve(self.worker, self.drive)
        self.api = f"http://127.0.0.1:{self.server.server_port}"
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        mover.DRIVE = self.api

    def project(self):
        root = self.tmp / "from" / "project"
        (root / "envtrans" / "core").mkdir(parents=True)
        (root / "main.py").write_text("print('hello')\n")
        (root / "envtrans" / "core" / "spec.py").write_text("X = 1\n" * 1000)
        (root / "checkpoint.bin").write_bytes(os.urandom(300_000))
        (root / ".reader").mkdir()
        (root / ".reader" / "agent.json").write_text("{}")
        (root / "__pycache__").mkdir()
        (root / "__pycache__" / "x.pyc").write_bytes(b"skip me")
        os.symlink("main.py", root / "entry.py")
        return root

    def config(self, mode, root, **extra):
        return {"mode": mode, "api": self.api, "id": "m1", "key": "key", "root": str(root), **extra}

    def test_packs_and_unpacks_whole(self):
        root = self.project()
        old = mover.PART
        mover.PART = 64 * 1024  # several parts
        try:
            packed = mover.run(self.config("pack", root))
        finally:
            mover.PART = old
        self.assertGreater(packed["parts"], 1)
        paths = {entry["path"] for entry in self.worker.manifest}
        self.assertIn(".reader/agent.json", paths)
        self.assertIn("entry.py", paths)
        self.assertNotIn("__pycache__/x.pyc", paths)
        self.assertEqual(self.worker.reports[-1]["step"], "packed")
        dest = self.tmp / "to" / "project"
        mover.run(self.config("unpack", dest))
        self.assertEqual((dest / "checkpoint.bin").read_bytes(), (root / "checkpoint.bin").read_bytes())
        self.assertEqual((dest / "envtrans" / "core" / "spec.py").read_text(), "X = 1\n" * 1000)
        self.assertEqual(os.readlink(dest / "entry.py"), "main.py")
        self.assertEqual(self.worker.reports[-1]["step"], "unpacked")
        self.assertEqual(self.worker.reports[-1]["verified"], len(self.worker.manifest))

    def test_a_damaged_archive_is_caught(self):
        mover.run(self.config("pack", self.project()))
        self.worker.corrupt = True
        with self.assertRaises(Exception):
            mover.run(self.config("unpack", self.tmp / "to"))
        self.assertEqual(self.worker.reports[-1]["step"], "failed")

    def test_a_file_changed_after_packing_is_caught(self):
        mover.run(self.config("pack", self.project()))
        self.worker.manifest[0]["sha256"] = "0" * 64
        with self.assertRaises(mover.MoveError):
            mover.run(self.config("unpack", self.tmp / "to"))

    def test_stops_when_cancelled(self):
        self.worker.cancelled = True
        self.assertEqual(mover.run(self.config("pack", self.project())), {"cancelled": True})

    def test_never_writes_outside_the_folder(self):
        self.assertIsNone(mover.safe_member("../etc/passwd"))
        self.assertIsNone(mover.safe_member("/etc/passwd"))
        self.assertEqual(mover.safe_member("a//b"), "a/b")
        self.assertEqual(mover.safe_member("a/b.py"), "a/b.py")

    def test_pulls_from_drive(self):
        folder = self.drive.add("envtrans", "root")
        self.drive.add("main.py", "root", b"print(1)\n")
        self.drive.add("spec.py", folder, b"X = 2\n")
        dest = self.tmp / "pulled"
        result = mover.run(self.config("drive-pull", dest, drive="root"))
        self.assertEqual(result["files"], 2)
        self.assertEqual((dest / "envtrans" / "spec.py").read_text(), "X = 2\n")
        self.assertEqual(self.worker.reports[-1]["step"], "pulled")

    def test_pushes_to_drive_and_waits_for_a_renewed_token(self):
        root = self.project()
        self.worker.token = "new-token"  # the mover starts with it; Drive takes it
        mover.run(self.config("drive-push", root, drive="root"))
        names = {self.drive.path_of(key) for key, f in self.drive.files.items() if f["mimeType"] != mover.FOLDER_MIME and key != "root"}
        self.assertIn("envtrans/core/spec.py", names)
        self.assertIn("checkpoint.bin", names)
        self.assertNotIn("__pycache__/x.pyc", names)
        pushed = next(f for f in self.drive.files.values() if f["name"] == "checkpoint.bin")
        self.assertEqual(pushed["data"], (root / "checkpoint.bin").read_bytes())
        # Pushed again: the files are replaced, not doubled.
        mover.run(self.config("drive-push", root, drive="root"))
        self.assertEqual(sum(1 for f in self.drive.files.values() if f["name"] == "main.py"), 1)

    def test_removes_the_old_copy_and_only_unlinks_a_linked_folder(self):
        root = self.project()
        mine = self.tmp / "my-own-folder"
        mine.mkdir()
        (mine / "keep.txt").write_text("mine")
        link = self.tmp / "from" / "linked"
        os.symlink(mine, link)
        mover.run(self.config("remove", link))
        self.assertTrue((mine / "keep.txt").exists())
        self.assertFalse(link.exists())
        mover.run(self.config("remove", root))
        self.assertFalse(root.exists())
        with self.assertRaises(mover.MoveError):
            mover.remove(Path.home())

    def test_the_companion_takes_only_a_step_inside_its_folder(self):
        base = self.tmp / "Reader"
        ok = mover.prepare({"mode": "unpack", "api": "https://api.koios.dev/", "id": "m1", "key": "k", "root": "playgrounds/p1"}, base)
        self.assertEqual(ok["root"], str(base / "playgrounds" / "p1"))
        self.assertEqual(ok["api"], "https://api.koios.dev")
        for bad in (
            {"mode": "rm -rf", "api": "https://x", "id": "m", "key": "k"},
            {"mode": "unpack", "api": "http://evil.example", "id": "m", "key": "k"},
            {"mode": "unpack", "api": "https://x", "id": "m", "key": "k", "root": "../../etc"},
            {"mode": "remove", "api": "https://x", "id": "m", "key": "k", "root": ""},
            {"mode": "drive-pull", "api": "https://x", "id": "m", "key": "k", "root": "p"},
        ):
            with self.assertRaises(mover.MoveError):
                mover.prepare(bad, base)

    def test_starts_on_its_own_and_deletes_its_config(self):
        root = self.project()
        config = self.config("pack", root)
        pid = mover.start_detached(config, self.tmp / "agent")
        self.assertGreater(pid, 0)
        import time
        for _ in range(100):
            if self.worker.reports and self.worker.reports[-1]["step"] == "packed":
                break
            time.sleep(0.1)
        self.assertEqual(self.worker.reports[-1]["step"], "packed")
        self.assertFalse((self.tmp / "agent" / "move-m1-pack.json").exists())

    def test_says_how_much_disk_is_free(self):
        answer = mover.run({"mode": "disk", "root": str(self.tmp / "not-yet")})
        self.assertGreater(answer["total"], 0)


if __name__ == "__main__":
    unittest.main()
