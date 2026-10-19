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
        self.refuse_step = None


class FakeDrive:
    """Drive's files: id → {name, mimeType, parents, data}."""

    def __init__(self):
        self.files = {"root": {"name": "Project", "mimeType": mover.FOLDER_MIME, "parents": [], "data": b""}}
        self.next = 0

    def add(self, name, parent, data=None):
        self.next += 1
        key = f"f{self.next}"
        self.files[key] = {"name": name, "mimeType": mover.FOLDER_MIME if data is None else "text/plain", "parents": [parent], "data": data or b"", "trashed": False}
        return key

    def at(self, path):
        """The live file at a path, or None."""
        for key, f in self.files.items():
            if key != "root" and not f.get("trashed") and f["mimeType"] != mover.FOLDER_MIME and self.path_of(key) == path:
                return f
        return None

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
                    if report.get("step") == worker.refuse_step:
                        return self.answer(400, b'{"error":"which step?"}')
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
                found = [{"id": k, "name": f["name"], "mimeType": f["mimeType"], "size": str(len(f["data"])), "md5Checksum": hashlib.md5(f["data"]).hexdigest()} for k, f in drive.files.items() if parent in f["parents"] and not f.get("trashed")]
                return self.answer(200, json.dumps({"files": found}).encode())
            if url.path == "/drive/v3/files" and method == "POST":
                meta = json.loads(self.body())
                return self.answer(200, json.dumps({"id": drive.add(meta["name"], meta["parents"][0])}).encode())
            if parts[1] == "drive" and method == "PATCH" and len(parts) > 4:
                drive.files[parts[4]].update(json.loads(self.body()))
                return self.answer(200, json.dumps({"id": parts[4]}).encode())
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
        # The listing comes first: files found so far, the totals not yet known; then the pull counts against them.
        steps = [report["step"] for report in self.worker.reports]
        self.assertEqual(steps[0], "listing")
        self.assertEqual(self.worker.reports[0]["totalFiles"], 0)
        pulling = next(report for report in self.worker.reports if report["step"] == "pulling")
        self.assertEqual((pulling["totalFiles"], pulling["totalBytes"]), (2, len(b"print(1)\n") + len(b"X = 2\n")))

    def test_a_worker_that_refuses_the_listing_step_still_gets_the_pull(self):
        self.drive.add("main.py", "root", b"print(1)\n")
        self.worker.refuse_step = "listing"  # a Worker from before the listing step
        result = mover.run(self.config("drive-pull", self.tmp / "pulled", drive="root"))
        self.assertEqual(result["files"], 1)
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

    # ------------------------------------------------------ an old copy, met again --

    def test_decides_each_file_three_ways(self):
        d = mover.decide
        self.assertEqual(d(None, None, "n"), "take")  # new
        self.assertEqual(d("n", "o", "n"), "same")
        self.assertEqual(d("o", "o", "n"), "take")  # untouched here since it left: the newer one
        self.assertEqual(d("h", "o", "n"), "conflict")  # changed in both places
        self.assertEqual(d("h", None, "n"), "conflict")  # no record of how it left: kept beside it
        self.assertEqual(d("o", "o", None), "remove")  # deleted in the newer copy, untouched here
        self.assertEqual(d("h", "o", None), "keep")  # deleted there, but changed here
        self.assertEqual(d("h", None, None), "keep")  # made here since
        self.assertEqual(d("h", "o", "n", meta=True), "take")  # the app's own files follow the newer copy

    def move(self, source, dest):
        self.worker.parts.clear()
        self.worker.manifest = None
        mover.run(self.config("pack", source))
        return mover.run(self.config("unpack", dest))

    def test_coming_back_over_an_old_copy_loses_nothing(self):
        a = self.tmp / "laptop" / "project"
        a.mkdir(parents=True)
        (a / "untouched.py").write_text("v1\n")
        (a / "both.py").write_text("v1\n")
        (a / "deleted_there.py").write_text("v1\n")
        (a / "data.bin").write_bytes(b"\0" * 1000)
        (a / ".reader").mkdir()
        (a / ".reader" / "agent.json").write_text('{"chats": 1}')
        b = self.tmp / "gpubox" / "project"
        self.move(a, b)
        self.assertTrue((a / mover.BASE).exists(), "the place left keeps its record")
        self.assertFalse((b / mover.BASE).exists(), "the record never travels")
        # Away: work goes on at the new place, and someone edits the old copy too.
        (b / "untouched.py").write_text("v2\n")
        (b / "both.py").write_text("v2 from the gpu box\n")
        (b / "deleted_there.py").unlink()
        (b / "new_there.py").write_text("hello\n")
        (b / ".reader" / "agent.json").write_text('{"chats": 2}')
        (a / "both.py").write_text("v1 edited on the laptop\n")
        (a / "notes_here.md").write_text("made on the laptop after it left\n")
        (a / ".reader" / "agent.json").write_text('{"chats": "laptop"}')
        # Back to the laptop.
        met = self.move(b, a)
        self.assertEqual((a / "untouched.py").read_text(), "v2\n")
        self.assertEqual((a / "both.py").read_text(), "v2 from the gpu box\n")
        aside = [p for p in a.iterdir() if p.name.startswith("both (conflict ")]
        self.assertEqual(len(aside), 1)
        self.assertEqual(aside[0].read_text(), "v1 edited on the laptop\n")
        self.assertFalse((a / "deleted_there.py").exists(), "deleted there, untouched here: gone")
        self.assertEqual((a / "new_there.py").read_text(), "hello\n")
        self.assertEqual((a / "notes_here.md").read_text(), "made on the laptop after it left\n")
        self.assertEqual((a / ".reader" / "agent.json").read_text(), '{"chats": 2}')
        self.assertEqual((met["conflicts"], met["conflictPaths"], met["kept"], met["stale"]), (1, ["both.py"], 1, 1))
        self.assertFalse((a / mover.BASE).exists(), "the old record goes once it has been used")
        self.assertEqual(self.worker.reports[-1]["conflicts"], 1)

    def test_an_old_copy_with_no_record_keeps_whatever_differs(self):
        a = self.project()
        b = self.tmp / "elsewhere"
        b.mkdir()
        (b / "main.py").write_text("someone else's main\n")
        (b / "theirs.txt").write_text("keep me\n")
        met = self.move(a, b)
        self.assertEqual((b / "main.py").read_text(), "print('hello')\n")
        self.assertTrue(any(p.name.startswith("main (conflict ") for p in b.iterdir()))
        self.assertEqual((b / "theirs.txt").read_text(), "keep me\n")
        self.assertEqual(met["conflicts"], 1)

    def test_drive_as_the_old_copy(self):
        # The project left Drive earlier: its folder kept a record; since then one file was edited in Drive.
        reader = self.drive.add(".reader", "root")
        self.drive.add("untouched.py", "root", b"v1\n")
        self.drive.add("both.py", "root", b"v1 edited in Drive\n")
        self.drive.add("gone.py", "root", b"v1\n")
        md5 = lambda b: hashlib.md5(b).hexdigest()
        self.drive.add("moved-away.json", reader, json.dumps({"files": {"untouched.py": md5(b"v1\n"), "both.py": md5(b"v1\n"), "gone.py": md5(b"v1\n")}}).encode())
        root = self.tmp / "laptop"
        root.mkdir()
        (root / "untouched.py").write_text("v2\n")
        (root / "both.py").write_text("v2\n")
        met = mover.run(self.config("drive-push", root, drive="root"))
        self.assertEqual(self.drive.at("untouched.py")["data"], b"v2\n")
        self.assertEqual(self.drive.at("both.py")["data"], b"v2\n")
        aside = [f for f in self.drive.files.values() if f["name"].startswith("both (conflict ") and not f.get("trashed")]
        self.assertEqual([f["data"] for f in aside], [b"v1 edited in Drive\n"])
        self.assertIsNone(self.drive.at("gone.py"))
        self.assertIsNone(self.drive.at(".reader/moved-away.json"))
        self.assertEqual((met["conflicts"], met["stale"]), (1, 1))
        self.assertTrue((root / mover.BASE).exists(), "the laptop, left, keeps its record")

    def test_leaving_drive_leaves_a_record_there(self):
        self.drive.add("main.py", "root", b"print(1)\n")
        mover.run(self.config("drive-pull", self.tmp / "pulled", drive="root"))
        record = self.drive.at(".reader/moved-away.json")
        self.assertIsNotNone(record)
        self.assertEqual(json.loads(record["data"])["files"], {"main.py": hashlib.md5(b"print(1)\n").hexdigest()})

    def test_says_how_much_disk_is_free(self):
        answer = mover.run({"mode": "disk", "root": str(self.tmp / "not-yet")})
        self.assertGreater(answer["total"], 0)


if __name__ == "__main__":
    unittest.main()
