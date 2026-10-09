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
where it is installed, and restarts. Settings → Updates has the button.

/companion/vscode is for the page once paired (its origin, and the token): which
VS Code-like editors are here and whether they have the Reader extension, and
installing it into them from the .vsix the site serves — the extension isn't
on the Marketplace, and a page can't run `code --install-extension` itself.

/companion/shutdown is for the page (its origin): with the token once paired,
or without it from this computer itself (127.0.0.1, not through the tunnel),
so the Playground's switch can turn off a Companion it found but hasn't paired
with. Stopping it is all that gives: anything on this computer could anyway. It
stops the kernels and the server, and leaves a mark (state.set_off) that keeps
it stopped, at the next login too, until someone starts it on purpose: the
Reader app, `reader-companion start`, or the page's Start, which opens a
reader-companion:// link this computer hands to `reader-companion start`
(desktop.install_url_handler). The machine chip's menu has the button.

/companion/claim is for the page once paired (its origin, and the token), signed
in with Google: it makes this computer that account's (account.py). The token
changes, the HTTPS tunnel opens, and the computer goes on the account's list,
where a browser signed in as it finds it from any computer. After that,
/companion/pair takes only a page signed in as that account.

/companion/release is for this computer's own programs, like /link:
`reader-companion release` hands the computer back to no account.

/companion/tools is for the page once paired: the toolchains and coding agents
here, for the Run button and the Agents menu (tools.py).

/companion/vscode-web is for the page once paired: it starts VS Code for the
browser (`code serve-web`, tools.VsCodeWeb) and says where it is, a path with a
secret in it that /companion/vscode/<secret>/… proxies (VsCodeProxy), adding
the connection token, for the page's VS Code pane.

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

import atexit
import hmac
from pathlib import Path

from tornado import httpclient, websocket

from . import account, desktop, state, tools, tunnel


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
        held = account.owner()
        self.reply(200, {"app": "reader-companion", "version": companion.version, "id": companion.id, "name": companion.name, "hardware": "" if remote else companion.hardware, "root": "" if remote else companion.root, "tls": companion.tls_port, "owned": bool(held), "owner": account.mask(held["email"]) if held else ""})


class PairHandler(CompanionHandler):
    async def post(self):
        if not self.allowed():
            return self.reply(403, {"error": "This Companion answers only its own site."})
        try:
            body = json.loads(self.request.body or b"{}")
        except ValueError:
            body = {}
        code = body.get("code", "") if isinstance(body, dict) else ""
        companion = state.current
        held = account.owner()
        if held:
            # This computer is an account's: only a page signed in as it pairs, code or not.
            given = body.get("pass", "") if isinstance(body, dict) else ""
            email = await IOLoop.current().run_in_executor(None, account.whose, held.get("api", ""), given) if given else None
            if email != held["email"]:
                return self.reply(403, {"error": f"This computer is connected to another Google account ({account.mask(held['email'])}). Sign in as that account to use it, or run reader-companion release on it to connect it to this one.", "owned": True})
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


async def open_tunnel(serverapp) -> None:
    """The HTTPS tunnel, opened now if it isn't: how a browser on another computer reaches this one."""
    companion = state.current
    if companion.tunnel_url:
        return
    serverapp.web_app.settings["allow_remote_access"] = True  # read on every request
    try:
        running = await IOLoop.current().run_in_executor(None, lambda: tunnel.start(companion.port, tunnel.cloudflared(say=lambda *_: None)))
    except Exception as error:  # this computer still reaches it; others don't, until it is started again
        print(f"  The HTTPS tunnel didn't open ({error}): other computers won't reach this one until it starts again.", flush=True)
        return
    atexit.register(running.stop)
    companion.tunnel_url = running.url


class ClaimHandler(VsCodeHandler):
    """Makes this computer the account's whose pass the page sends (account.py): a new token, the tunnel, and the account's list."""

    def initialize(self, serverapp=None):
        self.serverapp = serverapp

    async def get(self):
        self.reply(405, {"error": "POST"})

    async def post(self):
        if not self.allowed():
            return self.reply(403, {"error": "Pair this browser with the Companion first."})
        try:
            body = json.loads(self.request.body or b"{}")
        except ValueError:
            body = {}
        api = account.safe_api(body.get("api", "")) if isinstance(body, dict) else ""
        given = body.get("pass", "") if isinstance(body, dict) else ""
        if not api or not given:
            return self.reply(400, {"error": "Sign in with Google first: the computer is connected to an account."})
        loop = IOLoop.current()
        held = account.owner()
        companion = state.current
        if held:
            email = await loop.run_in_executor(None, account.whose, held.get("api", ""), given)
            if email != held["email"]:
                return self.reply(403, {"error": f"This computer is connected to another Google account ({account.mask(held['email'])}). Run reader-companion release on it to connect it to this one.", "owned": True})
        claimed = await loop.run_in_executor(None, account.claim, api, given, companion)
        if isinstance(claimed, str):
            return self.reply(502, {"error": claimed})
        email, secret = claimed
        config = state.load_config()
        config["owner"] = {"email": email, "secret": secret, "api": api}
        config.setdefault("tunnel", True)
        state.save_config(config)
        if not held:
            # Whoever paired before, signed in as anyone, kept the old token: it stops working now.
            account.new_token(self.serverapp)
            print(f"  Connected to {email}: only that Google account reaches this computer now, from any browser it signs in to.", flush=True)
        if config.get("tunnel"):
            await open_tunnel(self.serverapp)
        await loop.run_in_executor(None, account.beat, companion)
        self.reply(200, {"email": email, "token": companion.token, "tunnel": companion.tunnel_url, "id": companion.id})


class ReleaseHandler(LinkHandler):
    """`reader-companion release`: the computer belongs to no account again, with a new token."""

    def initialize(self, serverapp=None):
        self.serverapp = serverapp

    async def post(self):
        if not self.allowed():
            return self.reply(403, {"error": "Only this computer, with the Companion's token."})
        held = account.owner()
        if held:
            # Off the account's list, not just marked off: its browsers would keep the old token and be refused.
            await IOLoop.current().run_in_executor(None, lambda: account.beat(state.current, forget=True))
        config = state.load_config()
        config.pop("owner", None)
        state.save_config(config)
        token = account.new_token(self.serverapp)
        print("  Released: no Google account owns this computer now. Pair a browser again to connect it to one.", flush=True)
        self.reply(200, {"released": bool(held), "token": token})


class ToolsHandler(VsCodeHandler):
    """What runs here: toolchains, coding agents, and whether VS Code is."""

    def initialize(self, serverapp=None):
        self.serverapp = serverapp

    async def get(self):
        if not self.allowed():
            return self.reply(403, {"error": "Pair this browser with the Companion first."})
        shell = (getattr(self.serverapp, "terminado_settings", None) or {}).get("shell_command")
        self.reply(200, await IOLoop.current().run_in_executor(None, tools.detect, shell))

    async def post(self):
        self.reply(405, {"error": "GET"})


class VsCodeWebHandler(VsCodeHandler):
    """VS Code in the page: GET says how it is, POST starts it; both with the folder to open, under the Companion's."""

    def answer(self, folder: str):
        status = tools.vscode_web.status()
        root = Path(state.current.root)
        target = (root / folder).resolve() if folder else root
        if root != target and root not in target.parents:
            return self.reply(400, {"error": "That folder isn’t under the Companion’s."})
        self.reply(200, {**status, "folder": str(target)})

    async def get(self):
        if not self.allowed():
            return self.reply(403, {"error": "Pair this browser with the Companion first."})
        self.answer(self.get_argument("folder", ""))

    async def post(self):
        if not self.allowed():
            return self.reply(403, {"error": "Pair this browser with the Companion first."})
        try:
            body = json.loads(self.request.body or b"{}")
        except ValueError:
            body = {}
        await IOLoop.current().run_in_executor(None, tools.vscode_web.start)
        self.answer(body.get("folder", "") if isinstance(body, dict) else "")


HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade", "content-length", "host", "origin", "cookie"}


class VsCodeProxy(websocket.WebSocketHandler):
    """/companion/vscode/<secret>/…: to `code serve-web` on 127.0.0.1, pages and websockets, with its connection token added.

    The secret in the path is the credential (an iframe carries no Authorization header); the
    page gets it from /companion/vscode-web with the token. Only the reader's site may frame it.
    """

    upstream = None

    def check_xsrf_cookie(self):
        return

    def check_origin(self, origin):
        # VS Code's own sockets come from inside the frame, which is this server's origin; the site's may too.
        own = f"{self.request.protocol}://{self.request.host}"
        return bool(state.current) and origin in (own, state.current.origin)

    def allowed(self, secret: str) -> bool:
        web = tools.vscode_web
        return web.state in ("starting", "ready") and bool(web.port) and hmac.compare_digest(secret, web.secret)

    def target(self, secret: str, rest: str, scheme: str = "http") -> str:
        query = f"?{self.request.query}" if self.request.query else ""
        return f"{scheme}://127.0.0.1:{tools.vscode_web.port}/companion/vscode/{secret}/{rest}{query}"

    def upstream_headers(self) -> dict:
        web = tools.vscode_web
        headers = {name: value for name, value in self.request.headers.get_all() if name.lower() not in HOP and not name.lower().startswith("sec-websocket")}
        headers["Host"] = f"127.0.0.1:{web.port}"
        headers["Cookie"] = f"vscode-tkn={web.token}"
        if "Origin" in self.request.headers:
            headers["Origin"] = f"http://127.0.0.1:{web.port}"
        return headers

    async def get(self, secret, rest=""):
        if not self.allowed(secret):
            self.set_status(404)
            return self.finish("Not found")
        if self.request.headers.get("Upgrade", "").lower() == "websocket":
            request = httpclient.HTTPRequest(self.target(secret, rest, "ws"), headers=self.upstream_headers())
            try:
                self.upstream = await websocket.websocket_connect(request, on_message_callback=self.from_upstream, max_message_size=256 * 1024 * 1024)
            except Exception:
                self.set_status(502)
                return self.finish("VS Code isn’t answering")
            return await super().get(secret, rest)
        await self.relay(secret, rest)

    async def relay(self, secret, rest=""):
        if not self.allowed(secret):
            self.set_status(404)
            return self.finish("Not found")
        body = self.request.body if self.request.method in ("POST", "PUT", "PATCH", "DELETE") else None
        request = httpclient.HTTPRequest(
            self.target(secret, rest), method=self.request.method, headers=self.upstream_headers(), body=body,
            follow_redirects=False, decompress_response=False, request_timeout=300, allow_nonstandard_methods=True,
        )
        response = await httpclient.AsyncHTTPClient().fetch(request, raise_error=False)
        if response.code == 599:
            self.set_status(502)
            return self.finish("VS Code isn’t answering")
        self.set_status(response.code, response.reason)
        self._headers.clear()
        for name, value in response.headers.get_all():
            lower = name.lower()
            if lower in HOP or lower in ("x-frame-options", "set-cookie"):
                continue
            if lower == "content-security-policy":
                # Its own framing rule is replaced by ours below; the rest of its policy stays.
                value = "; ".join(part for part in value.split(";") if not part.strip().lower().startswith("frame-ancestors"))
                if not value.strip():
                    continue
            self.add_header(name, value)
        self.add_header("Content-Security-Policy", f"frame-ancestors 'self' {state.current.origin}")
        if response.body:
            self.write(response.body)
        self.finish()

    post = put = patch = delete = head = relay

    def on_message(self, message):
        if self.upstream:
            self.upstream.write_message(message, binary=isinstance(message, bytes))

    def from_upstream(self, message):
        if message is None:
            if self.ws_connection:
                self.close()
            return
        try:
            self.write_message(message, binary=isinstance(message, bytes))
        except websocket.WebSocketClosedError:
            pass

    def on_close(self):
        if self.upstream:
            self.upstream.close()
            self.upstream = None


class ShutdownHandler(VsCodeHandler):
    def initialize(self, serverapp=None):
        self.serverapp = serverapp

    def allowed(self) -> bool:
        # The token, or the page on this computer itself: never through the tunnel without it.
        return super().allowed() or (CompanionHandler.allowed(self) and not tunnel.via_tunnel(self.request.host))

    async def post(self):
        if not self.allowed():
            return self.reply(403, {"error": "Pair this browser with the Companion first: through its tunnel, only a paired page can shut it down."})
        state.set_off(True)
        if account.owner():  # the account's list says it is off, so its other browsers don't wait for it
            await IOLoop.current().run_in_executor(None, lambda: account.beat(state.current, off=True))
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
            (url_path_join(base, "companion/claim"), ClaimHandler, {"serverapp": serverapp}),
            (url_path_join(base, "companion/release"), ReleaseHandler, {"serverapp": serverapp}),
            (url_path_join(base, "companion/vscode"), VsCodeHandler),
            (url_path_join(base, "companion/update"), UpdateHandler),
            (url_path_join(base, "companion/shutdown"), ShutdownHandler, {"serverapp": serverapp}),
            (url_path_join(base, "companion/tools"), ToolsHandler, {"serverapp": serverapp}),
            (url_path_join(base, "companion/vscode-web"), VsCodeWebHandler),
            (url_path_join(base, r"companion/vscode/([^/]+)/?(.*)"), VsCodeProxy),
        ],
    )
