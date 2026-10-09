"""Whose computer this is: the Google account that claimed the Companion, and the site's list of that account's computers.

The first page signed in with Google that pairs with the Companion claims it
for its account (/companion/claim). From then on:

- only a page signed in as that account may pair (/companion/pair asks the
  site's Worker whose pass the page sent: GET /me);
- the token changes at the claim, so a browser that paired before, signed in
  as anyone, no longer gets in with the one it kept;
- the Companion keeps the account's list of computers on the Worker current
  (POST /devices/beat): its tunnel address, its token, whether it is on. A
  browser signed in as the account, on any computer, finds it there.

The files stay here. The Worker holds only how to reach this computer, and
only that account's pass reads it. `reader-companion release` hands the
computer back, so another account can claim it.

What is kept, in config.json: owner = {email, secret, api}. The secret is the
one the Worker gave at the claim; it is what a beat is signed with.
"""

from __future__ import annotations

import json
import secrets
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from . import state

BEAT_MS = 5 * 60_000


def safe_api(api: str) -> str:
    """The Worker's address, if it is one the Companion may send the token to: https, or this computer."""
    parts = urlsplit(str(api or "").strip())
    if parts.scheme == "https" and parts.netloc or parts.scheme == "http" and parts.hostname in ("127.0.0.1", "localhost"):
        return f"{parts.scheme}://{parts.netloc}{parts.path.rstrip('/')}"
    return ""


def call(api: str, path: str, body: dict | None = None, pass_: str = "", timeout: float = 10) -> tuple[int, dict]:
    headers = {"Content-Type": "application/json", "User-Agent": "reader-companion"}
    if pass_:
        headers["Authorization"] = f"Bearer {pass_}"
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f"{api}{path}", data=data, headers=headers, method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.loads(error.read() or b"{}")
        except ValueError:
            return error.code, {}
    except (OSError, ValueError):
        return 0, {}


def owner() -> dict | None:
    """The account this computer belongs to, from config.json (read each time: `release` changes it)."""
    found = state.load_config().get("owner")
    return found if isinstance(found, dict) and found.get("email") else None


def mask(email: str) -> str:
    """Enough of an address for its owner to know it, for a page that isn't signed in as them."""
    name, _, domain = email.partition("@")
    return f"{name[:2]}{'•' * max(1, len(name) - 2)}@{domain}" if domain else email


def whose(api: str, pass_: str) -> str | None:
    """The account a pass is for, as the Worker says."""
    if not api or not pass_:
        return None
    status, body = call(api, "/me", pass_=pass_)
    email = body.get("email") if status == 200 else None
    return email.lower() if isinstance(email, str) else None


def claim(api: str, pass_: str, companion) -> tuple[str, str] | str:
    """Puts this computer on the account's list: (email, secret), or what went wrong."""
    status, body = call(api, "/devices/claim", {"id": companion.id, "name": companion.name, "hardware": companion.hardware, "version": companion.version}, pass_=pass_)
    if status == 200 and body.get("secret") and body.get("email"):
        return body["email"].lower(), body["secret"]
    return body.get("error") or ("The site’s Worker didn’t answer." if not status else f"The site’s Worker said {status}.")


def beat(companion, off: bool = False, forget: bool = False) -> bool:
    """Tells the account's list how to reach this computer now, that it is off, or (forget) to drop it."""
    held = owner()
    if not held or not companion:
        return False
    body = {
        "email": held["email"], "secret": held.get("secret", ""), "id": companion.id, "name": companion.name,
        "hardware": companion.hardware, "version": companion.version, "root": companion.root, "token": companion.token,
        "url": companion.tunnel_url, "local": f"http://127.0.0.1:{companion.port}/" if companion.port else "", "off": off,
    }
    if forget:
        body = {key: body[key] for key in ("email", "secret", "id")} | {"forget": True}
    status, _ = call(held.get("api", ""), "/devices/beat", body, timeout=5 if off or forget else 10)
    return status == 200


def new_token(serverapp=None) -> str:
    """A new token for the Jupyter server, at once: whoever kept the old one is out. config.json has it, for the VS Code extension."""
    token = secrets.token_urlsafe(32)
    config = state.load_config()
    config["token"] = token
    state.save_config(config)
    if state.current:
        state.current.token = token
    if serverapp is not None:
        serverapp.identity_provider.token = token  # read on every request
    return token
