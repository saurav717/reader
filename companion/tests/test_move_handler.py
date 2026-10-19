"""companion/move (extension.MoveHandler): free disk where a project's folder is, and a step of a move started on
its own — only with the token, from the site, for a folder inside the Companion's own.

    cd companion && python -m unittest tests.test_move_handler
"""

import json
import tempfile

from tornado.testing import AsyncHTTPTestCase
from tornado.web import Application

from reader_companion import extension, mover, state

ORIGIN = "https://koios.dev"


class MoveHandlerTest(AsyncHTTPTestCase):
    def setUp(self):
        super().setUp()
        self.root = tempfile.mkdtemp()
        state.current = state.Companion(name="Mac", token="t", id="abcdef0123456789", site=ORIGIN + "/", root=self.root, version="0.15.0")
        self.started = []
        self.original = mover.start_detached
        mover.start_detached = lambda config, folder: (self.started.append(config), 4242)[1]

    def tearDown(self):
        mover.start_detached = self.original
        state.current = None
        super().tearDown()

    def get_app(self):
        return Application([(r"/companion/move", extension.MoveHandler)])

    def call(self, method="GET", body=None, token="t", path="/companion/move"):
        headers = {"Origin": ORIGIN, **({"Authorization": f"token {token}"} if token else {})}
        return self.fetch(path, method=method, headers=headers, body=None if body is None else json.dumps(body))

    def test_says_how_much_disk_is_free(self):
        answer = json.loads(self.call(path="/companion/move?root=playgrounds/p1").body)
        self.assertGreater(answer["free"], 0)
        self.assertEqual(answer["version"], "0.15.0")

    def test_starts_a_step_with_the_token_only(self):
        body = {"mode": "unpack", "api": "https://api.koios.dev", "id": "m1", "key": "k", "root": "playgrounds/p1"}
        self.assertEqual(self.call("POST", body, token="wrong").code, 403)
        answer = self.call("POST", body)
        self.assertEqual(answer.code, 202)
        self.assertEqual(json.loads(answer.body)["pid"], 4242)
        self.assertEqual(self.started[0]["root"], f"{self.root}/playgrounds/p1")

    def test_refuses_a_folder_outside_its_own(self):
        answer = self.call("POST", {"mode": "unpack", "api": "https://api.koios.dev", "id": "m1", "key": "k", "root": "../.ssh"})
        self.assertEqual(answer.code, 400)
        self.assertEqual(self.started, [])
