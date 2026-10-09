"""The Companion shuts down with the Reader window: a goodbye stops it a few seconds later, unless the window says
hello again first (a reload); a window gone quiet stops it too; and the page's switch keeps it running instead."""

import asyncio
import json

from tornado.testing import AsyncHTTPTestCase, gen_test
from tornado.web import Application

from reader_companion import extension, state

ORIGIN = "https://saurav717.github.io"


class FakeServer:
    def __init__(self):
        self.stopped = 0

    def stop(self):
        self.stopped += 1


class AppWindowTest(AsyncHTTPTestCase):
    def setUp(self):
        super().setUp()
        self.home = self.tmp = __import__("tempfile").mkdtemp()
        self.env = __import__("os").environ.get("READER_COMPANION_HOME")
        __import__("os").environ["READER_COMPANION_HOME"] = self.home
        state.current = state.Companion(name="Mac", token="tok", id="abcdef0123456789", site=ORIGIN + "/reader/", root="/tmp", version="0.7.4")
        extension.app_window = extension.AppWindow()
        self.goodbye_s, self.quiet_s = extension.APP_GOODBYE_S, extension.APP_QUIET_S
        extension.APP_GOODBYE_S = 0.2

    def tearDown(self):
        extension.APP_GOODBYE_S, extension.APP_QUIET_S = self.goodbye_s, self.quiet_s
        if extension.app_window.watch:
            extension.app_window.watch.stop()
        import os
        if self.env is None:
            os.environ.pop("READER_COMPANION_HOME", None)
        else:
            os.environ["READER_COMPANION_HOME"] = self.env
        state.current = None
        super().tearDown()

    def get_app(self):
        self.server = FakeServer()
        return Application([(r"/companion/app", extension.AppHandler, {"serverapp": self.server})])

    async def say(self, event, **more):
        return await self.http_client.fetch(
            self.get_url("/companion/app"), method="POST", raise_error=False,
            headers={"Origin": ORIGIN, "Authorization": "token tok", "Content-Type": "application/json"}, body=json.dumps({"event": event, **more}),
        )

    @gen_test
    async def test_closing_the_window_shuts_it_down(self):
        await self.say("hello")
        await self.say("goodbye")
        await asyncio.sleep(0.8)
        self.assertEqual(self.server.stopped, 1)
        self.assertTrue(state.is_off(), "it stays off until started on purpose")

    @gen_test
    async def test_a_reload_does_not(self):
        await self.say("hello")
        await self.say("goodbye")
        await asyncio.sleep(0.05)
        await self.say("hello")
        await asyncio.sleep(0.6)
        self.assertEqual(self.server.stopped, 0)

    @gen_test
    async def test_the_switch_keeps_it_running(self):
        answer = await self.say("setting", stopWithApp=False)
        self.assertEqual(json.loads(answer.body), {"stopWithApp": False})
        await self.say("hello")
        await self.say("goodbye")
        await asyncio.sleep(0.6)
        self.assertEqual(self.server.stopped, 0)
        self.assertFalse(extension.stops_with_app())

    @gen_test
    async def test_a_window_gone_quiet_shuts_it_down(self):
        extension.APP_QUIET_S = 0
        await self.say("hello")
        extension.app_window.heard -= 1
        extension.app_window._quiet(self.server)
        await asyncio.sleep(0.6)
        self.assertEqual(self.server.stopped, 1)

    @gen_test
    async def test_only_with_the_token(self):
        answer = await self.http_client.fetch(self.get_url("/companion/app"), method="POST", raise_error=False, headers={"Origin": ORIGIN}, body=json.dumps({"event": "goodbye"}))
        self.assertEqual(answer.code, 403)


def test_the_app_marks_its_window():
    from reader_companion import cli

    assert cli.app_window_url("https://saurav717.github.io/reader/") == "https://saurav717.github.io/reader/#app=1"
    assert cli.app_window_url("https://saurav717.github.io/reader/playground#pair=ABCD&port=47321") == "https://saurav717.github.io/reader/playground#pair=ABCD&port=47321&app=1"
