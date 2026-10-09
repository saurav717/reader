"""/companion/info and /companion/pair: the two routes the page calls before it has a token.

They sit beside Jupyter's own API on the same port but outside its login, and
answer only the reader's own origin. /info says which computer this is;
/pair trades the code the terminal shows for the server's address and token.
"""

from __future__ import annotations

import json

from jupyter_server.utils import url_path_join
from tornado import web

from . import state


class CompanionHandler(web.RequestHandler):
    def check_xsrf_cookie(self):  # the page has no cookie here; the origin check below stands in
        return

    def allowed(self) -> bool:
        companion = state.current
        return bool(companion) and self.request.headers.get("Origin") == companion.origin

    def set_default_headers(self):
        companion = state.current
        origin = self.request.headers.get("Origin")
        if companion and origin == companion.origin:
            self.set_header("Access-Control-Allow-Origin", origin)
            self.set_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.set_header("Access-Control-Allow-Headers", "Content-Type")
            # Chrome's private-network preflight, for an https page calling 127.0.0.1.
            self.set_header("Access-Control-Allow-Private-Network", "true")
            self.set_header("Vary", "Origin")
        self.set_header("Cache-Control", "no-store")

    def options(self, *_):
        self.set_status(204 if self.allowed() else 403)
        self.finish()

    def reply(self, status: int, body: dict):
        self.set_status(status)
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(body))


class InfoHandler(CompanionHandler):
    def get(self):
        if not self.allowed():
            return self.reply(403, {"error": "This Companion answers only its own site."})
        companion = state.current
        self.reply(200, {"app": "reader-companion", "version": companion.version, "name": companion.name, "hardware": companion.hardware, "root": companion.root})


class PairHandler(CompanionHandler):
    def post(self):
        if not self.allowed():
            return self.reply(403, {"error": "This Companion answers only its own site."})
        try:
            code = json.loads(self.request.body or b"{}").get("code", "")
        except ValueError:
            code = ""
        companion = state.current
        if not companion.pair(code):
            return self.reply(401, {"error": "That code isn’t the one the Companion shows. Check the terminal: it prints a new one after too many tries or 15 minutes."})
        self.reply(200, {"url": f"http://127.0.0.1:{companion.port}/", "token": companion.token, "name": companion.name, "hardware": companion.hardware, "version": companion.version})


def load(serverapp):
    base = serverapp.base_url
    serverapp.web_app.add_handlers(
        ".*$",
        [
            (url_path_join(base, "companion/info"), InfoHandler),
            (url_path_join(base, "companion/pair"), PairHandler),
        ],
    )
