"""companion/compute (extension.ComputeHandler): the page hands over the way to the project's compute, for this
computer's shell — only with the token, for a folder inside the Companion's own, and never says the pass back.

    cd companion && python -m unittest tests.test_compute_handler
"""

import json
import os
import shutil
import tempfile
from pathlib import Path

from tornado.testing import AsyncHTTPTestCase
from tornado.web import Application

from reader_companion import compute, extension, state

ORIGIN = "https://koios.dev"


class ComputeHandlerTest(AsyncHTTPTestCase):
    def setUp(self):
        super().setUp()
        self.root = tempfile.mkdtemp()
        self.home = tempfile.mkdtemp()
        os.environ["READER_COMPANION_HOME"] = self.home
        state.current = state.Companion(name="Mac", token="t", id="abcdef0123456789", site=ORIGIN + "/", root=self.root, version="0.17.0")

    def tearDown(self):
        state.current = None
        os.environ.pop("READER_COMPANION_HOME", None)
        shutil.rmtree(self.root, True)
        shutil.rmtree(self.home, True)
        super().tearDown()

    def get_app(self):
        return Application([(r"/companion/compute", extension.ComputeHandler)])

    def call(self, method="GET", body=None, token="t", path="/companion/compute"):
        headers = {"Origin": ORIGIN, **({"Authorization": f"token {token}"} if token else {})}
        return self.fetch(path, method=method, headers=headers, body=None if body is None else json.dumps(body))

    def test_keeps_the_link_for_the_shell_and_never_says_the_pass(self):
        target = {"kind": "colab", "url": "https://8080-x.colab.dev/", "token": "secret", "expiresAt": 9, "label": "Colab · T4", "folder": "playgrounds/p1"}
        self.assertEqual(self.call("POST", {"root": "playgrounds/p1", "compute": target}, token="wrong").code, 403)
        answer = self.call("POST", {"root": "playgrounds/p1", "compute": target})
        self.assertEqual(answer.code, 200)
        self.assertNotIn("secret", answer.body.decode())
        kept = compute.find_link(Path(self.root) / "playgrounds" / "p1")
        self.assertEqual((kept["token"], kept["label"]), ("secret", "Colab · T4"))
        shown = json.loads(self.call(path="/companion/compute?root=playgrounds/p1").body)
        self.assertEqual((shown["linked"], shown["label"]), (True, "Colab · T4"))
        self.assertNotIn("token", shown)
        # Forgotten with null.
        self.call("POST", {"root": "playgrounds/p1", "compute": None})
        self.assertFalse(json.loads(self.call(path="/companion/compute?root=playgrounds/p1").body)["linked"])

    def test_refuses_a_folder_outside_its_own_and_a_push_with_no_link(self):
        self.assertEqual(self.call("POST", {"root": "../.ssh", "compute": None}).code, 400)
        self.assertEqual(self.call("POST", {"root": "playgrounds/p2", "action": "push"}).code, 409)
