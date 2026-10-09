import os
import stat
import sys
import tempfile
import textwrap
import unittest

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

    def test_asset_names(self):
        self.assertRegex(tunnel.asset(), r"^cloudflared-(darwin|linux|windows)-(amd64|arm64)(\.tgz|\.exe)?$")


if __name__ == "__main__":
    unittest.main()
