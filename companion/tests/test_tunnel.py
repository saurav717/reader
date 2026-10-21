import os
import stat
import sys
import tempfile
import textwrap
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest import mock

from reader_companion import tunnel


def fake_cloudflared(folder, lines, exit_after=False):
    """A stand-in for cloudflared that writes these lines to stderr, as the real one logs."""
    path = os.path.join(folder, "cloudflared")
    with open(path, "w") as out:
        out.write(f"#!{sys.executable}\n")
        out.write(textwrap.dedent(f"""
            import sys, time
            for line in {lines!r}:
                print(line, file=sys.stderr, flush=True)
            {'sys.exit(1)' if exit_after else 'time.sleep(60)'}
        """))
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)
    return path


class TunnelTest(unittest.TestCase):
    def test_reads_the_address(self):
        with tempfile.TemporaryDirectory() as folder:
            binary = fake_cloudflared(folder, [
                "INF Requesting new quick Tunnel on trycloudflare.com...",
                "INF |  https://brave-otter-lamp.trycloudflare.com  |",
                "INF Registered tunnel connection connIndex=0",
            ])
            running = tunnel.start(47321, binary, timeout_s=10)
            try:
                self.assertEqual(running.url, "https://brave-otter-lamp.trycloudflare.com")
            finally:
                running.stop()

    def test_says_why_when_it_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            binary = fake_cloudflared(folder, ["failed to request quick Tunnel: no such host"], exit_after=True)
            with self.assertRaises(RuntimeError) as caught:
                tunnel.start(47321, binary, timeout_s=5)
            self.assertIn("no such host", str(caught.exception))

    def test_knows_a_dead_address(self):
        codes = {"/": 404}

        class Answer(BaseHTTPRequestHandler):
            def do_HEAD(self):
                self.send_response(codes["/"])
                self.end_headers()

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Answer)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{server.server_port}"
        no_proxy = {k: "" for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY")}
        try:
            with mock.patch.dict(os.environ, no_proxy):
                self.assertFalse(tunnel.gone(url))  # the Companion's own 404: it is there
                codes["/"] = 530  # Cloudflare: nothing behind the address
                self.assertTrue(tunnel.gone(url))
                self.assertTrue(tunnel.gone("https://no-such-tunnel.invalid"))  # the name no longer resolves
        finally:
            server.shutdown()

    def test_asset_names(self):
        self.assertRegex(tunnel.asset(), r"^cloudflared-(darwin|linux|windows)-(amd64|arm64)(\.tgz|\.exe)?$")


if __name__ == "__main__":
    unittest.main()
