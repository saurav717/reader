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

/companion/terminals is for the page once paired: what each of its terminals is
running now (jobs.py), so the Playground can show a command in a terminal as a
run, from any page, and say when it ends.

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
from tornado.ioloop import IOLoop, PeriodicCallback

import atexit
import hmac
import html
from pathlib import Path

from tornado import httpclient, websocket

from . import account, browsers, desktop, folders, jobs, paper, state, tools, tunnel


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
        self.reply(200, {"app": "reader-companion", "version": companion.version, "id": companion.id, "name": companion.name, "hardware": "" if remote else companion.hardware, "root": "" if remote else companion.root, "tls": companion.tls_port, "owned": bool(held), "owner": account.mask(held["email"]) if held else "", "stopWithApp": stops_with_app()})


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


class TerminalsHandler(VsCodeHandler):
    """What each terminal is running: {"terminals": {name: {"alive", "busy", "pid", "command"}}}."""

    def initialize(self, serverapp=None):
        self.serverapp = serverapp

    def get(self):
        if not self.allowed():
            return self.reply(403, {"error": "Pair this browser with the Companion first."})
        manager = self.serverapp.web_app.settings.get("terminal_manager") if self.serverapp else None
        self.reply(200, {"terminals": jobs.terminal_jobs(manager)})

    def post(self):
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


RESTARTING_PAGE = """<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3">
<title>Starting VS Code again</title>
<style>:root{color-scheme:light dark}body{margin:0;height:100vh;display:grid;place-items:center;font:14px system-ui,sans-serif;color:#8a877e;background:transparent}</style>
<p>VS Code on this computer stopped answering — starting it again. This page reloads by itself.</p>"""
PROXY_ERROR_PAGE = """<!doctype html><meta charset="utf-8"><title>VS Code: an error in the Companion</title>
<style>:root{{color-scheme:light dark}}body{{margin:0;height:100vh;display:grid;place-items:center;font:14px system-ui,sans-serif;color:#b5435a;background:transparent;padding:0 24px;text-align:center}}code{{font:12px ui-monospace,monospace}}</style>
<p>The Companion ({version}) couldn’t pass this on to VS Code:<br><code>{error}</code><br><br>Its log, ~/.reader-companion/companion.log, has the whole story.</p>"""
FAILED_PAGE = """<!doctype html><meta charset="utf-8"><title>VS Code didn’t start</title>
<style>:root{{color-scheme:light dark}}body{{margin:0;height:100vh;display:grid;place-items:center;font:14px system-ui,sans-serif;color:#b5435a;background:transparent;padding:0 24px;text-align:center}}</style>
<p>{error}<br><br>Switch to Editor and back to VS Code to try again.</p>"""


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
        # Through the HTTPS tunnel the frame is https://<tunnel> while the tunnel reaches this server over plain
        # http, so the scheme here says http: this server's origin is its host, under either scheme.
        if not state.current:
            return False
        if origin == state.current.origin:
            return True
        scheme, _, host = origin.partition("://")
        return scheme in ("http", "https") and host.lower() == self.request.host.lower()

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

    def write_error(self, status_code, **kwargs):
        """Anything that went wrong here, said in the frame — its kind and message — not Tornado's bare 500 page."""
        error = kwargs.get("exc_info", (None, None, None))[1]
        said = f"{type(error).__name__}: {error}" if error else f"{status_code} {self._reason}"
        self.set_header("Content-Type", "text/html; charset=utf-8")
        self.set_header("Content-Security-Policy", f"frame-ancestors 'self' {state.current.origin if state.current else ''}".strip())
        self.finish(PROXY_ERROR_PAGE.format(error=html.escape(said), version=html.escape(state.current.version if state.current else "")))

    def failed_here(self, secret) -> bool:
        """The right secret, but VS Code couldn't be started again: its error, said in the frame."""
        web_ = tools.vscode_web
        if web_.state != "failed" or not hmac.compare_digest(secret, web_.secret):
            return False
        self.set_status(503)
        self.set_header("Content-Type", "text/html; charset=utf-8")
        self.set_header("Content-Security-Policy", f"frame-ancestors 'self' {state.current.origin if state.current else ''}".strip())
        self.finish(FAILED_PAGE.format(error=html.escape(web_.error or "VS Code stopped.")))
        return True

    async def get(self, secret, rest=""):
        if self.failed_here(secret):
            return
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
        try:
            response = await httpclient.AsyncHTTPClient().fetch(request, raise_error=False)
        except Exception:  # refused, reset: raise_error=False passes only HTTP answers back
            response = None
        if response is None or response.code == 599:
            return self.restarting()
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

    def restarting(self):
        """VS Code didn't answer: started again (start() sees it isn't answering), and a page that reloads until it does."""
        IOLoop.current().run_in_executor(None, tools.vscode_web.start)
        self.set_status(503)
        self._headers.clear()
        self.set_header("Retry-After", "3")
        self.set_header("Cache-Control", "no-store")
        self.set_header("Content-Security-Policy", f"frame-ancestors 'self' {state.current.origin if state.current else ''}".strip())
        if self.request.method != "GET":
            return self.finish("VS Code isn’t answering; it is being started again.")
        self.set_header("Content-Type", "text/html; charset=utf-8")
        self.finish(RESTARTING_PAGE)

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


async def shut_down(serverapp, why: str) -> None:
    """Off, and kept off (at the next login too) until started on purpose: the Reader app, reader-companion start, the page's Start."""
    state.set_off(True)
    if account.owner():  # the account's list says it is off, so its other browsers don't wait for it
        await IOLoop.current().run_in_executor(None, lambda: account.beat(state.current, off=True))
    print(f"  {why} It stays off until it is started again: the Reader app, or reader-companion start.", flush=True)
    # After any answer has gone: the kernels are shut down, the server stops, and the process ends
    # with 0, which launchd and systemd take as "leave it stopped" (KeepAlive/Restart on failure only).
    IOLoop.current().call_later(0.3, serverapp.stop)


class ShutdownHandler(VsCodeHandler):
    def initialize(self, serverapp=None):
        self.serverapp = serverapp

    def allowed(self) -> bool:
        # The token, or the page on this computer itself: never through the tunnel without it.
        return super().allowed() or (CompanionHandler.allowed(self) and not tunnel.via_tunnel(self.request.host))

    async def post(self):
        if not self.allowed():
            return self.reply(403, {"error": "Pair this browser with the Companion first: through its tunnel, only a paired page can shut it down."})
        self.reply(200, {"stopping": True})
        await shut_down(self.serverapp, "Shut down from the page.")


# ---------------------------------------------------- with the Reader window ----
#
# The Reader app opens the site in a window of its own and quits; the Companion it started
# would run on. So the page in that window (and only there: the app marks it) says it is
# open every half minute, and that it is closing as it closes; the Companion shuts down
# once the window is gone — a few seconds after its goodbye, so that a reload (goodbye,
# then hello again) doesn't, or when it has gone quiet for a few minutes (closed without a
# goodbye: a crash, a force-quit). Unless it is set to keep running (the page's switch),
# for a computer reached from other machines while its own window is shut.

APP_QUIET_S = 180  # a window minimised for long is woken once a minute at most: three of those
APP_GOODBYE_S = 10


def stops_with_app() -> bool:
    return state.load_config().get("stop_with_app", True) is not False


class AppWindow:
    """The Reader window's last word: when it was last heard from, and whether it said goodbye since."""

    def __init__(self):
        self.heard = 0.0
        self.closing: object | None = None
        self.watch: PeriodicCallback | None = None

    def hello(self, serverapp) -> None:
        self.heard = time.time()
        if self.closing is not None:
            IOLoop.current().remove_timeout(self.closing)
            self.closing = None
        if self.watch is None:
            self.watch = PeriodicCallback(lambda: self._quiet(serverapp), 30_000)
            self.watch.start()

    def goodbye(self, serverapp) -> None:
        said = time.time()
        if self.closing is not None:
            IOLoop.current().remove_timeout(self.closing)

        def gone():
            self.closing = None
            if self.heard <= said and stops_with_app():
                self.stop(serverapp, "The Reader window was closed: shut down with it.")

        self.closing = IOLoop.current().call_later(APP_GOODBYE_S, gone)

    def _quiet(self, serverapp) -> None:
        if self.heard and time.time() - self.heard > APP_QUIET_S and stops_with_app():
            self.stop(serverapp, "The Reader window went quiet (closed without a word): shut down with it.")

    def stop(self, serverapp, why: str) -> None:
        if self.watch is not None:
            self.watch.stop()
            self.watch = None
        self.heard = 0.0
        IOLoop.current().spawn_callback(shut_down, serverapp, why)


app_window = AppWindow()


class FoldersHandler(VsCodeHandler):
    """GET /companion/folders?path=…: the folders and files in a folder anywhere on this computer (from 0.8.0).
    POST {action: "link", path}: that folder linked into the Companion's folder, so a project can use it in place — the
    path the page uses comes back as {root}. POST {action: "choose"}: this computer's own folder chooser, on its screen,
    and the folder picked as {path} (null when cancelled). The token, as for every call that reaches the files."""

    async def get(self):
        if not self.allowed():
            return self.reply(403, {"error": "Pair this browser with the Companion first."})
        path = self.get_query_argument("path", "")
        hidden = self.get_query_argument("hidden", "") == "1"
        try:
            self.reply(200, await IOLoop.current().run_in_executor(None, lambda: folders.listing(path, hidden)))
        except PermissionError:
            self.reply(403, {"error": f"This computer doesn't let the Companion read {path or 'that folder'}."})
        except OSError as error:
            self.reply(404, {"error": str(error) or "That folder isn't there."})

    async def post(self):
        if not self.allowed():
            return self.reply(403, {"error": "Pair this browser with the Companion first."})
        try:
            body = json.loads(self.request.body or b"{}")
        except ValueError:
            body = {}
        action = body.get("action") if isinstance(body, dict) else None
        loop = IOLoop.current()
        try:
            if action == "link":
                root = Path(state.current.root)
                linked = await loop.run_in_executor(None, lambda: folders.link(str(body.get("path", "")), root))
                return self.reply(200, {"root": linked, "path": str(folders.resolve(str(body.get("path", ""))))})
            if action == "choose":
                return self.reply(200, {"path": await loop.run_in_executor(None, folders.choose)})
        except LookupError as error:
            return self.reply(501, {"error": str(error)})
        except OSError as error:
            return self.reply(400, {"error": str(error) or "That folder can't be linked."})
        self.reply(400, {"error": "link or choose"})


class BrowsersHandler(VsCodeHandler):
    """GET /companion/browsers: the browsers on this computer and their profiles (from 0.9.0). POST {url, browser,
    profile}: that https link opened there — the browser and profile must be ones the listing has. The token, as
    for every call that does something on this computer."""

    async def get(self):
        if not self.allowed():
            return self.reply(403, {"error": "Pair this browser with the Companion first."})
        self.reply(200, {"browsers": await IOLoop.current().run_in_executor(None, browsers.installed)})

    async def post(self):
        if not self.allowed():
            return self.reply(403, {"error": "Pair this browser with the Companion first."})
        try:
            body = json.loads(self.request.body or b"{}")
        except ValueError:
            body = {}
        if not isinstance(body, dict):
            body = {}
        url, browser, profile = str(body.get("url", "")), str(body.get("browser", "")), body.get("profile")
        profile = str(profile) if profile else None
        try:
            await IOLoop.current().run_in_executor(None, lambda: browsers.open_url(url, browser, profile))
        except browsers.Refused as error:
            return self.reply(400, {"error": str(error)})
        except OSError as error:
            return self.reply(500, {"error": f"The browser didn't start: {error}"})
        self.reply(200, {"opened": True})


class PaperHandler(VsCodeHandler):
    """A project's paper on this computer (from 0.10.0). GET: what compiles it (latexmk, Tectonic) and whether git is here.
    POST {action}: compile {folder, main?, engine} — the PDF as base64 and the log read into errors; install-tectonic;
    clone {folder, url, token}; sync {folder, message, token?} — commit, pull, push; remote {folder}. Folders are
    relative to the Companion's, and the token is kept for its remote in the Companion's config. The token, as for
    every call that reaches files."""

    def initialize(self, serverapp=None):
        self.serverapp = serverapp

    def found(self) -> dict:
        shell = (getattr(self.serverapp, "terminado_settings", None) or {}).get("shell_command")
        return paper.engines(tools.look_up(["latexmk", "tectonic", "git", "pdflatex", "xelatex"], shell))

    async def get(self):
        if not self.allowed():
            return self.reply(403, {"error": "Pair this browser with the Companion first."})
        self.reply(200, await IOLoop.current().run_in_executor(None, self.found))

    async def post(self):
        if not self.allowed():
            return self.reply(403, {"error": "Pair this browser with the Companion first."})
        try:
            body = json.loads(self.request.body or b"{}")
        except ValueError:
            body = {}
        if not isinstance(body, dict):
            body = {}
        action = body.get("action")
        root = Path(state.current.root)
        folder = str(body.get("folder", ""))
        loop = IOLoop.current()
        try:
            if action == "compile":
                found = await loop.run_in_executor(None, self.found)
                engine = body.get("engine") if body.get("engine") in ("auto", "latexmk", "tectonic") else "auto"
                main = str(body["main"]) if body.get("main") else None
                return self.reply(200, await loop.run_in_executor(None, lambda: paper.compile_paper(root, folder, main, engine, found)))
            if action == "install-tectonic":
                return self.reply(200, {"tectonic": await loop.run_in_executor(None, paper.install_tectonic)})
            git_path = (await loop.run_in_executor(None, self.found)).get("git") or ""
            if action in ("clone", "sync") and not git_path:
                return self.reply(501, {"error": "git isn't installed on this computer: install it (git-scm.com, or xcode-select --install on a Mac) to sync with Overleaf."})
            if action == "clone":
                url, token = str(body.get("url", "")), str(body.get("token", ""))
                done = await loop.run_in_executor(None, lambda: paper.clone(root, folder, url, token, git_path))
                paper.save_token(url, token)
                return self.reply(200, done)
            if action == "sync":
                url = await loop.run_in_executor(None, lambda: paper.remote_of(root, folder, git_path))
                token = str(body.get("token") or "") or paper.token_for(url)
                if body.get("token"):
                    paper.save_token(url, token)
                return self.reply(200, await loop.run_in_executor(None, lambda: paper.sync(root, folder, token, str(body.get("message", "")), git_path)))
            if action == "remote":
                url = await loop.run_in_executor(None, lambda: paper.remote_of(root, folder, git_path or "git"))
                return self.reply(200, {"url": url, "token": bool(paper.token_for(url))})
        except paper.Refused as error:
            return self.reply(400, {"error": str(error)})
        except OSError as error:
            return self.reply(500, {"error": str(error)})
        self.reply(400, {"error": "compile, install-tectonic, clone, sync or remote"})


class AppHandler(VsCodeHandler):
    """POST /companion/app: {event: "hello"} from the Reader window while it is open, {event: "goodbye"} as it closes,
    {event: "setting", stopWithApp} from the page's switch. The token, as for every call that changes something."""

    def initialize(self, serverapp=None):
        self.serverapp = serverapp

    def post(self):
        if not self.allowed():
            return self.reply(403, {"error": "Pair this browser with the Companion first."})
        try:
            body = json.loads(self.request.body or b"{}")
        except ValueError:
            body = {}
        event = body.get("event") if isinstance(body, dict) else None
        if event == "setting" and isinstance(body.get("stopWithApp"), bool):
            config = state.load_config()
            config["stop_with_app"] = body["stopWithApp"]
            state.save_config(config)
        elif event == "hello":
            app_window.hello(self.serverapp)
        elif event == "goodbye":
            app_window.goodbye(self.serverapp)
        else:
            return self.reply(400, {"error": "hello, goodbye, or setting"})
        self.reply(200, {"stopWithApp": stops_with_app()})


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
            (url_path_join(base, "companion/app"), AppHandler, {"serverapp": serverapp}),
            (url_path_join(base, "companion/folders"), FoldersHandler),
            (url_path_join(base, "companion/browsers"), BrowsersHandler),
            (url_path_join(base, "companion/paper"), PaperHandler, {"serverapp": serverapp}),
            (url_path_join(base, "companion/tools"), ToolsHandler, {"serverapp": serverapp}),
            (url_path_join(base, "companion/terminals"), TerminalsHandler, {"serverapp": serverapp}),
            (url_path_join(base, "companion/vscode-web"), VsCodeWebHandler),
            (url_path_join(base, r"companion/vscode/([^/]+)/?(.*)"), VsCodeProxy),
        ],
    )
