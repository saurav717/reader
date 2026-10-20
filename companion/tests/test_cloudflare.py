"""cloudflare.py: a named tunnel at a hostname of yours, with Argo Smart Routing, made through Cloudflare's API — here
against a stand-in for the API that keeps what it is told, as Cloudflare would."""

import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

from reader_companion import cli, cloudflare, state, tunnel


class FakeCloudflare:
    def __init__(self, argo_ok=True):
        self.calls = []
        self.tunnels = {}
        self.records = {}
        self.config = None
        self.argo = "off"
        self.argo_ok = argo_ok

    def __call__(self, token, method, path, body=None, query=None):
        assert token == "api-token"
        self.calls.append((method, path, body, query))
        if path == "/zones":
            return [{"id": "z1", "name": "example.com", "account": {"id": "acct1234567"}}] if query["name"] == "example.com" else []
        if path == "/accounts/acct1234567/cfd_tunnel" and method == "GET":
            return [t for t in self.tunnels.values() if t["name"] == query["name"]]
        if path == "/accounts/acct1234567/cfd_tunnel" and method == "POST":
            made = {"id": f"t{len(self.tunnels) + 1}", "name": body["name"]}
            self.tunnels[made["id"]] = made
            return made
        if path.endswith("/token"):
            return "tunnel-token-" + path.split("/")[-2]
        if path.endswith("/configurations"):
            self.config = body
            return {}
        if path == "/zones/z1/dns_records" and method == "GET":
            return [r for r in self.records.values() if r["name"] == query["name"]]
        if path == "/zones/z1/dns_records" and method == "POST":
            self.records["r1"] = {"id": "r1", **body}
            return self.records["r1"]
        if path.startswith("/zones/z1/dns_records/") and method == "PUT":
            self.records["r1"] = {"id": "r1", **body}
            return self.records["r1"]
        if path == "/zones/z1/argo/smart_routing":
            if not self.argo_ok:
                raise cloudflare.CloudflareError("PATCH /zones/z1/argo/smart_routing: 1010: billing is not set up")
            self.argo = body["value"]
            return {"id": "smart_routing", "value": self.argo}
        raise AssertionError(f"unexpected {method} {path}")


class SetupTest(unittest.TestCase):
    def test_makes_the_tunnel_points_the_hostname_at_this_computer_and_turns_argo_on(self):
        api = FakeCloudflare()
        with mock.patch.object(cloudflare, "call", api):
            made = cloudflare.setup("api-token", "Koios.Example.com.", 47321, "abcd", say=lambda *_: None)
        self.assertEqual(made["hostname"], "koios.example.com")
        self.assertEqual((made["tunnel_token"], made["argo"]), ("tunnel-token-t1", True))
        self.assertEqual(api.tunnels["t1"]["name"], "koios-abcd")
        ingress = api.config["config"]["ingress"]
        self.assertEqual(ingress[0]["hostname"], "koios.example.com")
        self.assertEqual(ingress[0]["service"], "http://127.0.0.1:47321")
        self.assertEqual(ingress[-1], {"service": "http_status:404"})
        self.assertEqual({k: api.records["r1"][k] for k in ("type", "content", "proxied")}, {"type": "CNAME", "content": "t1.cfargotunnel.com", "proxied": True})
        self.assertEqual(api.argo, "on")
        # Again: the same tunnel and record are kept, not made twice.
        with mock.patch.object(cloudflare, "call", api):
            again = cloudflare.setup("api-token", "koios.example.com", 47321, "abcd", say=lambda *_: None)
        self.assertEqual((again["tunnel_id"], len(api.tunnels), len(api.records)), ("t1", 1, 1))

    def test_without_argo_billing_the_tunnel_still_works_and_says_why(self):
        api = FakeCloudflare(argo_ok=False)
        with mock.patch.object(cloudflare, "call", api):
            made = cloudflare.setup("api-token", "koios.example.com", 47321, "abcd", say=lambda *_: None)
        self.assertFalse(made["argo"])
        self.assertIn("billing", made["argo_why"])
        self.assertEqual(made["tunnel_token"], "tunnel-token-t1")

    def test_a_hostname_outside_the_accounts_zones_or_not_a_hostname_is_refused(self):
        api = FakeCloudflare()
        with mock.patch.object(cloudflare, "call", api):
            with self.assertRaisesRegex(cloudflare.CloudflareError, "none of koios.other.org"):
                cloudflare.setup("api-token", "koios.other.org", 47321, "abcd", say=lambda *_: None)
            with self.assertRaisesRegex(cloudflare.CloudflareError, "not a hostname"):
                cloudflare.setup("api-token", "https://x/y", 47321, "abcd", say=lambda *_: None)


class CommandTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.home, True)
        os.environ["READER_COMPANION_HOME"] = self.home
        self.addCleanup(os.environ.pop, "READER_COMPANION_HOME", None)

    def test_setup_keeps_the_tunnels_token_never_the_api_token_and_quick_forgets_it(self):
        state.save_config({"id": "abcd", "port": 47321, "token": "t"})
        with mock.patch.object(cloudflare, "call", FakeCloudflare()), mock.patch("builtins.print"):
            cli.main(["tunnel", "setup", "--hostname", "koios.example.com", "--api-token", "api-token"])
        config = state.load_config()
        self.assertEqual((config["tunnel_hostname"], config["tunnel_token"], config["tunnel_argo"], config["tunnel"]), ("koios.example.com", "tunnel-token-t1", True, True))
        self.assertNotIn("api-token", json.dumps(config))
        self.assertEqual(oct(os.stat(os.path.join(self.home, "config.json")).st_mode & 0o777), "0o600")
        with mock.patch("builtins.print"):
            cli.main(["tunnel", "quick"])
        self.assertNotIn("tunnel_token", state.load_config())


class StartTest(unittest.TestCase):
    def test_the_named_tunnel_runs_with_its_token_in_the_environment_not_the_command_line(self):
        seen = {}

        class Process:
            stderr = iter(["2026-10-20 INF Registered tunnel connection connIndex=0\n"])

            def poll(self):
                return None

        def popen(argv, **kwargs):
            seen["argv"], seen["env"] = argv, kwargs["env"]
            return Process()

        with mock.patch.object(tunnel.subprocess, "Popen", side_effect=popen), mock.patch.object(tunnel, "cloudflared", return_value="/bin/cloudflared"):
            made = tunnel.open_configured(47321, {"tunnel_token": "secret-token", "tunnel_hostname": "koios.example.com", "tunnel_port": 47321})
        self.assertEqual(made.url, "https://koios.example.com")
        self.assertEqual(seen["argv"], ["/bin/cloudflared", "tunnel", "--no-autoupdate", "run"])
        self.assertEqual(seen["env"]["TUNNEL_TOKEN"], "secret-token")
        self.assertNotIn("secret-token", " ".join(seen["argv"]))


if __name__ == "__main__":
    unittest.main()
