"""companion/ports/<ticket>/<port>/… (extension.PortProxy): a port on this computer reached from the page, for the
Sim pane's Live 3D (a Rerun viewer and its gRPC stream). The ticket is the credential; answers stream as they come;
websockets are relayed.

    cd companion && python -m unittest tests.test_ports_proxy
"""

import asyncio
import json

from tornado import gen, web, websocket
from tornado.httpserver import HTTPServer
from tornado.testing import AsyncHTTPTestCase, gen_test

from reader_companion import extension, state, tools

ORIGIN = "https://koios.dev"


class Slow(web.RequestHandler):
    """Three chunks, a pause between each: a proxy that waits for the end would hand them over together."""

    async def get(self, *_):
        self.set_header("Content-Type", "text/plain")
        self.set_header("X-Frame-Options", "DENY")
        for part in ("one\n", "two\n", "three\n"):
            self.write(part)
            await self.flush()
            await gen.sleep(0.05)
        self.finish()

    async def post(self, *_):
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"got": self.request.body.decode(), "path": self.request.path, "query": self.request.query}))


class Echo(websocket.WebSocketHandler):
    def on_message(self, message):
        self.write_message(f"echo {message}")


class PortProxyTest(AsyncHTTPTestCase):
    def setUp(self):
        super().setUp()
        state.current = state.Companion(name="Mac", token="t", id="abcdef0123456789", site=ORIGIN + "/", root="/tmp", version="0.18.0")
        self.port = tools.free_port()
        self.upstream = HTTPServer(web.Application([(r"/slow", Slow), (r"/echo", Echo), (r"/deep/(.*)", Slow)]))
        self.upstream.listen(self.port, "127.0.0.1")

    def tearDown(self):
        self.upstream.stop()
        state.current = None
        super().tearDown()

    def get_app(self):
        return web.Application([(r"/companion/ports/([0-9a-f]+)/(\d+)/?(.*)", extension.PortProxy)])

    def path(self, rest, port=None, ticket=None):
        port = port or self.port
        return f"/companion/ports/{ticket or extension.port_ticket('t', port)}/{port}/{rest}"

    def test_the_ticket_is_the_credential(self):
        self.assertEqual(self.fetch(self.path("slow", ticket="0" * 40)).code, 404)
        self.assertEqual(self.fetch(self.path("slow", ticket=extension.port_ticket("other-token", self.port))).code, 404)
        self.assertEqual(self.fetch(self.path("slow", port=self.port + 1, ticket=extension.port_ticket("t", self.port))).code, 404)
        # The page computes the same (src/lib/companion.ts, portTicket): scripts/simulation.test.mjs pins this vector too.
        self.assertEqual(extension.port_ticket("t", 9090), "5c42279cfbe380ac8195601bb240a93b1448e359")
        self.assertNotEqual(extension.port_ticket("t", 9090), extension.port_ticket("t", 9091))

    def test_passes_an_answer_on_as_it_comes_and_frames_it_for_the_site_only(self):
        chunks = []
        answer = self.fetch(self.path("slow"), headers={"Origin": ORIGIN}, streaming_callback=chunks.append)
        self.assertEqual(answer.code, 200)
        self.assertEqual(b"".join(chunks), b"one\ntwo\nthree\n")
        self.assertGreaterEqual(len(chunks), 3, "the chunks came together: the proxy waited for the end")
        self.assertEqual(answer.headers["Content-Security-Policy"], f"frame-ancestors 'self' {ORIGIN}")
        self.assertNotIn("X-Frame-Options", answer.headers)
        self.assertEqual(answer.headers["Access-Control-Allow-Origin"], ORIGIN)

    def test_posts_with_the_body_path_and_query(self):
        answer = self.fetch(self.path("deep/a/b?x=1"), method="POST", body="hello")
        self.assertEqual(answer.code, 200)
        self.assertEqual(json.loads(answer.body), {"got": "hello", "path": "/deep/a/b", "query": "x=1"})

    def test_says_when_nothing_answers(self):
        port = tools.free_port()
        answer = self.fetch(self.path("slow", port=port))
        self.assertEqual(answer.code, 502)
        self.assertIn(str(port), answer.body.decode())

    @gen_test
    async def test_relays_a_websocket(self):
        url = f"ws://127.0.0.1:{self.get_http_port()}{self.path('echo')}"
        connection = await websocket.websocket_connect(url)
        connection.write_message("hi")
        self.assertEqual(await asyncio.wait_for(connection.read_message(), 5), "echo hi")
        connection.close()
