"""VS Code in the page: the proxy to `code serve-web` takes the secret path, adds the connection token, carries pages
and websockets both ways, and lets only the reader's site frame it. The VS Code server is a fake here."""

import json
import socket

from tornado import websocket
from tornado.testing import AsyncHTTPTestCase, bind_unused_port, gen_test
from tornado.httpserver import HTTPServer
from tornado.web import Application, RequestHandler

from reader_companion import extension, state, tools

ORIGIN = "https://saurav717.github.io"


class FakePage(RequestHandler):
    def get(self, rest):
        self.set_header("X-Frame-Options", "DENY")
        self.set_header("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'")
        self.write({"path": self.request.path, "query": self.request.query, "cookie": self.request.headers.get("Cookie", ""), "host": self.request.headers.get("Host")})

    def post(self, rest):
        self.write({"body": self.request.body.decode()})


class FakeSocket(websocket.WebSocketHandler):
    def check_origin(self, origin):
        return origin.startswith("http://127.0.0.1:")

    def open(self, rest):
        self.write_message("cookie:" + self.request.headers.get("Cookie", ""))

    def on_message(self, message):
        self.write_message(message, binary=isinstance(message, bytes))


class ProxyTest(AsyncHTTPTestCase):
    def setUp(self):
        super().setUp()
        sock, port = bind_unused_port()
        self.fake = HTTPServer(Application([(r"/companion/vscode/s3cret/ws(.*)", FakeSocket), (r"/companion/vscode/s3cret/(.*)", FakePage)]))
        self.fake.add_sockets([sock])
        state.current = state.Companion(name="Mac", token="t", id="abcdef0123456789", site=ORIGIN + "/reader/", root="/tmp", version="0.7.0")
        web = tools.vscode_web
        web.secret, web.token, web.port, web.state = "s3cret", "tkn", port, "ready"

    def tearDown(self):
        self.fake.stop()
        tools.vscode_web.state = "off"
        state.current = None
        super().tearDown()

    def get_app(self):
        return Application([(r"/companion/vscode/([^/]+)/?(.*)", extension.VsCodeProxy)])

    def test_pages_go_through_with_the_token_and_only_the_site_frames_them(self):
        response = self.fetch("/companion/vscode/s3cret/static/x.js?folder=/tmp/p")
        self.assertEqual(response.code, 200)
        body = json.loads(response.body)
        self.assertEqual(body["path"], "/companion/vscode/s3cret/static/x.js")
        self.assertEqual(body["query"], "folder=/tmp/p")
        self.assertEqual(body["cookie"], "vscode-tkn=tkn")
        self.assertTrue(body["host"].startswith("127.0.0.1:"))
        self.assertNotIn("X-Frame-Options", response.headers)
        policies = response.headers.get_list("Content-Security-Policy")
        self.assertIn("default-src 'self'", policies)
        self.assertIn(f"frame-ancestors 'self' {ORIGIN}", policies)
        self.assertFalse(any("'none'" in policy for policy in policies))
        posted = self.fetch("/companion/vscode/s3cret/api", method="POST", body="hello")
        self.assertEqual(json.loads(posted.body)["body"], "hello")

    def test_a_wrong_secret_or_vscode_off_is_not_found(self):
        self.assertEqual(self.fetch("/companion/vscode/guess/").code, 404)
        tools.vscode_web.state = "off"
        self.assertEqual(self.fetch("/companion/vscode/s3cret/").code, 404)

    @gen_test
    async def test_websockets_both_ways(self):
        url = f"ws://127.0.0.1:{self.get_http_port()}/companion/vscode/s3cret/ws?reconnectionToken=1"
        from tornado.httpclient import HTTPRequest
        conn = await websocket.websocket_connect(HTTPRequest(url, headers={"Origin": f"http://127.0.0.1:{self.get_http_port()}"}))
        self.assertEqual(await conn.read_message(), "cookie:vscode-tkn=tkn")
        conn.write_message(b"\x00\x01binary", binary=True)
        self.assertEqual(await conn.read_message(), b"\x00\x01binary")
        conn.write_message("text")
        self.assertEqual(await conn.read_message(), "text")
        conn.close()

    @gen_test
    async def test_websockets_from_another_site_are_refused(self):
        url = f"ws://127.0.0.1:{self.get_http_port()}/companion/vscode/s3cret/ws"
        from tornado.httpclient import HTTPClientError, HTTPRequest
        with self.assertRaises(HTTPClientError):
            await websocket.websocket_connect(HTTPRequest(url, headers={"Origin": "https://evil.example"}))


class DetectTest(AsyncHTTPTestCase):
    def get_app(self):
        return Application([])

    def test_parse_after_the_mark(self):
        out = "welcome from .zshrc\n__READER_TOOLS__\nnode\t/opt/homebrew/bin/node\nclaude\t/Users/me/.local/bin/claude\n"
        self.assertEqual(tools.parse_found(out), {"node": "/opt/homebrew/bin/node", "claude": "/Users/me/.local/bin/claude"})

    def test_look_up_through_a_shell(self):
        found = tools.look_up(["sh", "no-such-command-here"], ["sh"])
        self.assertIn("sh", found)
        self.assertNotIn("no-such-command-here", found)


class LinkExtensionsTest(DetectTest):
    def test_links_each_extension_once(self):
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as home:
            source, target = Path(home) / "src", Path(home) / "dst"
            (source / "anthropic.claude-code-2.0.0").mkdir(parents=True)
            (source / "github.copilot-1.0.0").mkdir()
            (source / ".obsolete").mkdir()
            (source / "extensions.json").write_text("[]")
            self.assertEqual(tools.link_extensions(source, target), 2)
            self.assertEqual(tools.link_extensions(source, target), 2)
            self.assertEqual(sorted(p.name for p in target.iterdir()), ["anthropic.claude-code-2.0.0", "github.copilot-1.0.0"])
