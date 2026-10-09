import time
import unittest

from reader_companion import state
from reader_companion.cli import pair_link


def companion():
    return state.Companion(name="Mac", token="t", id="c1", site="https://saurav717.github.io/reader/", root="/tmp", version="0")


class StateTest(unittest.TestCase):
    def test_origin(self):
        self.assertEqual(state.origin_of("https://saurav717.github.io/reader/"), "https://saurav717.github.io")
        self.assertEqual(state.origin_of("http://localhost:5173/"), "http://localhost:5173")
        with self.assertRaises(ValueError):
            state.origin_of("saurav717.github.io")

    def test_code_shape(self):
        code = state.new_code()
        self.assertRegex(code, r"^[A-Z2-9]{3}-[A-Z2-9]{3}$")
        self.assertEqual(state.normalise_code(" abc def "), "ABC-DEF")

    def test_pair_once(self):
        c = companion()
        code = c.code
        self.assertTrue(c.pair(code.lower().replace("-", "")))
        self.assertNotEqual(c.code, code)
        self.assertFalse(c.pair(code))

    def test_too_many_tries(self):
        c = companion()
        code = c.code
        for _ in range(state.MAX_TRIES):
            c.pair("XXX-XXX")
        self.assertNotEqual(c.code, code)

    def test_expired(self):
        c = companion()
        c.code_made = time.time() - state.CODE_TTL_S - 1
        code = c.code
        self.assertFalse(c.pair(code))
        self.assertNotEqual(c.code, code)

    def test_link(self):
        self.assertEqual(pair_link("https://x.io/reader/", "ABC-DEF", 47321), "https://x.io/reader/playground#pair=ABC-DEF&port=47321")
        self.assertEqual(
            pair_link("https://x.io/reader/", "ABC-DEF", 47321, "https://a-b.trycloudflare.com"),
            "https://x.io/reader/playground#pair=ABC-DEF&port=47321&via=https%3A%2F%2Fa-b.trycloudflare.com",
        )

    def test_via_tunnel(self):
        from reader_companion.tunnel import via_tunnel
        self.assertFalse(via_tunnel("127.0.0.1:47321"))
        self.assertFalse(via_tunnel("localhost:47321"))
        self.assertTrue(via_tunnel("a-b.trycloudflare.com"))


if __name__ == "__main__":
    unittest.main()
