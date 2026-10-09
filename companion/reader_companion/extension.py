"""/companion/info and /companion/pair: the two routes the page calls before it has a token.

They sit beside Jupyter's own API on the same port but outside its login, and
answer only the reader's own origin. /info says which computer this is;
/pair trades the code the terminal shows for the server's address and token.

/companion/show-code is for a browser that found the Companion but has no code:
it puts the code in a dialog on this computer's screen (a few seconds apart at
most), so whoever reads it there is at the computer, as with the terminal.

/companion/update is for the page once paired too (its origin, and the token):
it installs the newest Companion the site serves (companion/latest.json, a wheel
from the site and nowhere else) over this one, refreshes the VS Code extension
where it is installed, and restarts. Settings → This computer has the button.

/companion/vscode is for the page once paired (its origin, and the token): which
VS Code-like editors are here and whether they have the Reader extension, and
installing it into them from the .vsix the site serves — the extension isn't
on the Marketplace, and a page can't run `code --install-extension` itself.

/companion/shutdown is for the page once paired (its origin, and the token): it
stops the kernels and the server, and leaves a mark (state.set_off) that keeps
it stopped, at the next login too, until someone starts it on purpose: the
Reader app, `reader-companion start`, or the page's Start, which opens a
reader-companion:// link this computer hands to `reader-companion start`
(desktop.install_url_handler). The machine chip's menu has the button.

/companion/link is for this computer's own programs, not the page: given the
token, it hands out a pairing link with a fresh code. `reader-companion setup`
and `reader-companion pair` open it, for a Companion running in the background.
"""

from __future__ import annotations

import json
import os
import secrets
import time

from jupyter_server.utils import url_path_join
from tornado import web
from tornado.ioloop import IOLoop

from . import desktop, state, tunnel


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
            self.set_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
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
        # Through the tunnel the address is public: say which Companion it is, and the rest after pairing.
        remote = tunnel.via_tunnel(self.request.host)
        self.reply(200, {"app": "reader-companion", "version": companion.version, "id": companion.id, "name": companion.name, "hardware": "" if remote else companion.hardware, "root": "" if remote else companion.root, "tls": companion.tls_port})


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
            return self.reply(401, {"error": "That code isn’t the one the Companion shows. Ask for it again: there is a new one after too many tries or 15 minutes."})
        self.reply(200, {"url": f"http://127.0.0.1:{companion.port}/", "tunnel": companion.tunnel_url, "token": companion.token, "id": companion.id, "name": companion.name, "hardware": companion.hardware, "root": companion.root, "version": companion.version})


class ShowCodeHandler(CompanionHandler):
    last = 0.0

    def post(self):
        if not self.allowed():
            return self.reply(403, {"error": "This Companion answers only its own site."})
        companion = state.current
        if time.time() - ShowCodeHandler.last < 5:
            return self.reply(429, {"error": "It’s on the screen already."})
        ShowCodeHandler.last = time.time()
        if time.time() - companion.code_made > state.CODE_TTL_S:
            companion.fresh_code(announce=False)
        print(f"  A browser asked for the code: {companion.code}", flush=True)
        self.reply(200, {"shown": desktop.show_code(companion.code, companion.name)})


class LinkHandler(CompanionHandler):
    def allowed(self) -> bool:
        # Not for any page: no Origin, and the server's own token.
        companion = state.current
        given = self.request.headers.get("Authorization", "")
        return bool(companion) and "Origin" not in self.request.headers and secrets.compare_digest(given, f"token {companion.token}")

    def get(self):
        if not self.allowed():
            return self.reply(403, {"error": "Only this computer, with the Companion's token."})
        self.reply(200, {"ok": True})

    def post(self):
        if not self.allowed():
            return self.reply(403, {"error": "Only this computer, with the Companion's token."})
        from .cli import pair_link

        companion = state.current
        self.reply(200, {"link": pair_link(companion.site, companion.fresh_code(announce=False), companion.port, companion.tunnel_url, companion.tls_port)})


class VsCodeHandler(CompanionHandler):
    def allowed(self) -> bool:
        companion = state.current
        given = self.request.headers.get("Authorization", "")
        return super().allowed() and secrets.compare_digest(given, f"token {companion.token}")

    def options(self, *_):
        # The preflight carries no token: the origin is enough to ask.
        self.set_status(204 if CompanionHandler.allowed(self) else 403)
        self.finish()

    async def get(self):
        if not self.allowed():
            return self.reply(403, {"error": "Pair this browser with the Companion first."})
        self.reply(200, await IOLoop.current().run_in_executor(None, desktop.extension_status))

    async def post(self):
        if not self.allowed():
            return self.reply(403, {"error": "Pair this browser with the Companion first."})
        site = state.current.site
        installed = await IOLoop.current().run_in_executor(None, lambda: desktop.install_extension(site, say=lambda *_: None))
        status = await IOLoop.current().run_in_executor(None, desktop.extension_status)
        if not status["editors"]:
            return self.reply(404, {"error": "No VS Code here. Install it from code.visualstudio.com, then try again.", **status})
        if not installed:
            return self.reply(502, {"error": "VS Code didn't take the extension. Download the .vsix and use Extensions → … → Install from VSIX.", **status})
        self.reply(200, status)


class UpdateHandler(VsCodeHandler):
    busy = False

    async def get(self):
        if not self.allowed():
            return self.reply(403, {"error": "Pair this browser with the Companion first."})
        companion = state.current
        newest = await IOLoop.current().run_in_executor(None, desktop.latest, companion.site)
        self.reply(200, {"version": companion.version, "latest": newest["version"] if newest else None, "updatable": desktop.is_lasting(desktop.executable())})

    async def post(self):
        if not self.allowed():
            return self.reply(403, {"error": "Pair this browser with the Companion first."})
        if UpdateHandler.busy:
            return self.reply(409, {"error": "It’s updating already."})
        companion = state.current
        command = desktop.executable()
        if not desktop.is_lasting(command):
            return self.reply(409, {"error": "This Companion runs from uvx, which fetches the newest each start: stop it (Ctrl-C) and start it again."})
        newest = await IOLoop.current().run_in_executor(None, desktop.latest, companion.site)
        if not newest:
            return self.reply(502, {"error": "Couldn’t read the newest version from the site. Is this computer online?"})
        if not desktop.newer(newest["version"], companion.version):
            return self.reply(200, {"version": companion.version, "updated": False})
        UpdateHandler.busy = True
        try:
            ok, said = await IOLoop.current().run_in_executor(None, desktop.install_wheel, newest["wheel"])
            if not ok:
                return self.reply(500, {"error": "The update didn’t install.", "detail": said})
            status = await IOLoop.current().run_in_executor(None, desktop.extension_status)
            if any(editor["installed"] for editor in status["editors"]):
                await IOLoop.current().run_in_executor(None, lambda: desktop.install_extension(companion.site, say=lambda *_: None))
        finally:
            UpdateHandler.busy = False
        self.reply(200, {"version": newest["version"], "updated": True})
        print(f"  Updated to {newest['version']}: starting again…", flush=True)
        if not desktop.restart_later(desktop.executable()):
            IOLoop.current().call_later(0.5, lambda: os._exit(0))


class ShutdownHandler(VsCodeHandler):
    def initialize(self, serverapp=None):
        self.serverapp = serverapp

    def post(self):
        if not self.allowed():
            return self.reply(403, {"error": "Pair this browser with the Companion first."})
        state.set_off(True)
        self.reply(200, {"stopping": True})
        print("  Shut down from the page. It stays off until it is started again: the Reader app, or reader-companion start.", flush=True)
        # After the answer has gone: the kernels are shut down, the server stops, and the process ends
        # with 0, which launchd and systemd take as "leave it stopped" (KeepAlive/Restart on failure only).
        IOLoop.current().call_later(0.3, self.serverapp.stop)


def load(serverapp):
    base = serverapp.base_url
    serverapp.web_app.add_handlers(
        ".*$",
        [
            (url_path_join(base, "companion/info"), InfoHandler),
            (url_path_join(base, "companion/pair"), PairHandler),
            (url_path_join(base, "companion/show-code"), ShowCodeHandler),
            (url_path_join(base, "companion/link"), LinkHandler),
            (url_path_join(base, "companion/vscode"), VsCodeHandler),
            (url_path_join(base, "companion/update"), UpdateHandler),
            (url_path_join(base, "companion/shutdown"), ShutdownHandler, {"serverapp": serverapp}),
        ],
    )
