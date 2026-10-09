"""A Companion connected to a Google account: claimed with a page's pass, a new token at the claim, and pairing
only with a page signed in as that account. The site's Worker is a fake here (account.call)."""

import json
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

from tornado.testing import AsyncHTTPTestCase
from tornado.web import Application

from reader_companion import account, extension, state

SITE = "https://saurav717.github.io/reader/"
ORIGIN = "https://saurav717.github.io"
API = "https://proxy.example"
PASSES = {"pass-a": "a@gmail.com", "pass-b": "b@gmail.com"}


def fake_worker(beats):
    def call(api, path, body=None, pass_="", timeout=10):
        if path == "/me":
            return (200, {"email": PASSES[pass_]}) if pass_ in PASSES else (401, {})
        if path == "/devices/claim":
            return (200, {"secret": "s3cret", "email": PASSES[pass_]}) if pass_ in PASSES else (401, {"error": "sign in"})
        if path == "/devices/beat":
            beats.append(body)
            return 200, {"ok": True}
        return 404, {}

    return call


class AccountTest(AsyncHTTPTestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        os.environ["READER_COMPANION_HOME"] = self.home.name
        state.save_config({"token": "old-token", "id": "abcdef0123456789"})
        state.current = state.Companion(name="Mac", token="old-token", id="abcdef0123456789", site=SITE, root="/tmp", version="0.7.0", port=47321)
        self.serverapp = SimpleNamespace(identity_provider=SimpleNamespace(token="old-token"), web_app=SimpleNamespace(settings={}))
        self.beats = []
        patch = mock.patch.object(account, "call", side_effect=fake_worker(self.beats))
        patch.start()
        self.addCleanup(patch.stop)
        # No tunnel in a test: claiming would open one.
        tunnel = mock.patch.object(extension, "open_tunnel", new=mock.AsyncMock())
        tunnel.start()
        self.addCleanup(tunnel.stop)
        super().setUp()

    def tearDown(self):
        super().tearDown()
        os.environ.pop("READER_COMPANION_HOME", None)
        self.home.cleanup()
        state.current = None

    def get_app(self):
        return Application([
            (r"/companion/info", extension.InfoHandler),
            (r"/companion/pair", extension.PairHandler),
            (r"/companion/claim", extension.ClaimHandler, {"serverapp": self.serverapp}),
            (r"/companion/release", extension.ReleaseHandler, {"serverapp": self.serverapp}),
        ])

    def post(self, path, body, token=None):
        headers = {"Origin": ORIGIN, "Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"token {token}"
        response = self.fetch(path, method="POST", body=json.dumps(body), headers=headers)
        return response.code, json.loads(response.body or b"{}")

    def test_claim_changes_the_token_and_lists_the_computer(self):
        code, body = self.post("/companion/claim", {"pass": "pass-a", "api": API}, token="old-token")
        self.assertEqual(code, 200)
        self.assertEqual(body["email"], "a@gmail.com")
        self.assertNotEqual(body["token"], "old-token")
        self.assertEqual(self.serverapp.identity_provider.token, body["token"])
        self.assertEqual(state.load_config()["token"], body["token"])
        self.assertEqual(state.load_config()["owner"], {"email": "a@gmail.com", "secret": "s3cret", "api": API})
        self.assertEqual(self.beats[-1]["token"], body["token"])
        # The token a browser kept from before is no good for claiming again.
        self.assertEqual(self.post("/companion/claim", {"pass": "pass-a", "api": API}, token="old-token")[0], 403)

    def test_only_the_owner_pairs_once_claimed(self):
        _, claimed = self.post("/companion/claim", {"pass": "pass-a", "api": API}, token="old-token")
        info = json.loads(self.fetch("/companion/info", headers={"Origin": ORIGIN}).body)
        self.assertTrue(info["owned"])
        self.assertEqual(info["owner"], "a•@gmail.com")
        code, body = self.post("/companion/pair", {"code": state.current.code, "pass": "pass-b"})
        self.assertEqual(code, 403)
        self.assertTrue(body["owned"])
        self.assertEqual(self.post("/companion/pair", {"code": state.current.code})[0], 403)
        code, body = self.post("/companion/pair", {"code": state.current.code, "pass": "pass-a"})
        self.assertEqual(code, 200)
        self.assertEqual(body["token"], claimed["token"])
        # Another account can't claim it either.
        self.assertEqual(self.post("/companion/claim", {"pass": "pass-b", "api": API}, token=claimed["token"])[0], 403)

    def test_claim_needs_a_sign_in_and_a_safe_worker(self):
        self.assertEqual(self.post("/companion/claim", {"api": API}, token="old-token")[0], 400)
        self.assertEqual(self.post("/companion/claim", {"pass": "pass-a", "api": "http://evil.example"}, token="old-token")[0], 400)
        self.assertIsNone(account.owner())

    def test_release_frees_it_with_a_new_token(self):
        _, claimed = self.post("/companion/claim", {"pass": "pass-a", "api": API}, token="old-token")
        response = self.fetch("/companion/release", method="POST", body="{}", headers={"Authorization": f"token {claimed['token']}"})
        self.assertEqual(response.code, 200)
        self.assertIsNone(account.owner())
        self.assertNotEqual(state.load_config()["token"], claimed["token"])
        self.assertTrue(self.beats[-1]["off"])


class MaskTest(unittest.TestCase):
    def test_mask(self):
        self.assertEqual(account.mask("saurav@gmail.com"), "sa••••@gmail.com")
        self.assertEqual(account.safe_api("https://proxy.example/"), "https://proxy.example")
        self.assertEqual(account.safe_api("http://localhost:8080"), "http://localhost:8080")
        self.assertEqual(account.safe_api("http://evil.example"), "")
