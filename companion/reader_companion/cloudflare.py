"""A tunnel of your own on Cloudflare, with Argo Smart Routing (from 0.19.0): `reader-companion tunnel setup`.

The Companion's quick tunnel (tunnel.py) is free and needs no account, but it gets a new trycloudflare.com address at
every start, and it can't use Argo. Argo Smart Routing is Cloudflare's paid routing. It carries traffic between its
data centres on the paths it currently measures as fastest, instead of the default route. For a mount, that is the
middle of the journey: from the edge near the GPU machine to the edge near this computer, where cloudflared
connects. Cloudflare quotes about a third less time on that leg; it varies with the route.

What setup does, with an API token you make once in the Cloudflare dashboard:

1. finds the zone (your domain on Cloudflare) the hostname is in, and its account;
2. creates a named tunnel, "koios-<this computer's id>" (or reuses it), managed from Cloudflare;
3. points the hostname at the Companion (ingress: https://<hostname> → http://127.0.0.1:<port>);
4. adds the DNS record: a proxied CNAME, <hostname> → <tunnel id>.cfargotunnel.com;
5. turns Argo Smart Routing on for the zone. That is billed by Cloudflare: a monthly fee and a price per GB. If the
   account can't have it (no billing set up, a token without the permission), setup says so and the tunnel works
   without it;
6. keeps the tunnel's own token in the Companion's settings (0600). The API token is used for these calls and never
   saved.

From then on the Companion runs `cloudflared tunnel run` with that token instead of a quick tunnel, at a fixed
https://<hostname>, and mounts dial it there. `reader-companion tunnel quick` goes back to quick tunnels.

The API token needs: Account → Cloudflare Tunnel: Edit; Zone → DNS: Edit; Zone → Zone Settings: Edit (for Argo);
Zone → Zone: Read. It can be limited to the one zone.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.cloudflare.com/client/v4"


class CloudflareError(Exception):
    pass


def call(token: str, method: str, path: str, body=None, query: dict | None = None):
    url = API + path + ("?" + urllib.parse.urlencode(query) if query else "")
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method, headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            answer = json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        try:
            answer = json.loads(error.read() or b"{}")
        except ValueError:
            raise CloudflareError(f"Cloudflare answered {error.code} to {method} {path}") from None
    except (urllib.error.URLError, OSError) as error:
        raise CloudflareError(f"Cloudflare's API can't be reached: {getattr(error, 'reason', error)}") from None
    if not answer.get("success"):
        words = "; ".join(f"{e.get('code')}: {e.get('message')}" for e in answer.get("errors") or []) or "refused"
        raise CloudflareError(f"{method} {path}: {words}")
    return answer.get("result")


def find_zone(token: str, hostname: str) -> dict:
    """The zone the hostname is in: the longest of its suffixes that is a zone on this account."""
    parts = hostname.strip(".").lower().split(".")
    for i in range(len(parts) - 1):
        name = ".".join(parts[i:])
        found = call(token, "GET", "/zones", query={"name": name})
        if found:
            return found[0]
    raise CloudflareError(f"none of {hostname}'s domains is a zone this token can see: add the domain to Cloudflare, or give the token Zone: Read on it")


def argo_on(token: str, zone_id: str) -> tuple[bool, str]:
    """Argo Smart Routing turned on for the zone: whether it is, and why not when it isn't."""
    try:
        result = call(token, "PATCH", f"/zones/{zone_id}/argo/smart_routing", {"value": "on"})
        return (result or {}).get("value") == "on", ""
    except CloudflareError as error:
        return False, str(error)


def setup(api_token: str, hostname: str, port: int, computer_id: str, argo: bool = True, say=None) -> dict:
    say = say or print
    hostname = hostname.strip().strip(".").lower()
    if not hostname or "." not in hostname or "/" in hostname:
        raise CloudflareError(f"not a hostname: {hostname!r} (for example companion.example.com)")
    zone = find_zone(api_token, hostname)
    account = (zone.get("account") or {}).get("id")
    if not account:
        raise CloudflareError(f"the zone {zone.get('name')} names no account")
    say(f"  Zone {zone['name']} (account {account[:8]}…)")
    name = f"koios-{computer_id}"
    tunnels = call(api_token, "GET", f"/accounts/{account}/cfd_tunnel", query={"name": name, "is_deleted": "false"}) or []
    tunnel = tunnels[0] if tunnels else call(api_token, "POST", f"/accounts/{account}/cfd_tunnel", {"name": name, "config_src": "cloudflare"})
    say(f"  Tunnel {name} ({'kept' if tunnels else 'made'}: {tunnel['id']})")
    token = call(api_token, "GET", f"/accounts/{account}/cfd_tunnel/{tunnel['id']}/token")
    if not isinstance(token, str) or not token:
        raise CloudflareError("Cloudflare gave no token for the tunnel")
    call(api_token, "PUT", f"/accounts/{account}/cfd_tunnel/{tunnel['id']}/configurations", {
        "config": {"ingress": [{"hostname": hostname, "service": f"http://127.0.0.1:{port}", "originRequest": {"connectTimeout": 30, "keepAliveTimeout": 900}}, {"service": "http_status:404"}]},
    })
    target = f"{tunnel['id']}.cfargotunnel.com"
    records = call(api_token, "GET", f"/zones/{zone['id']}/dns_records", query={"name": hostname}) or []
    record = {"type": "CNAME", "name": hostname, "content": target, "proxied": True, "comment": "Koios Companion tunnel"}
    if records:
        if records[0].get("type") != "CNAME" or records[0].get("content") != target:
            call(api_token, "PUT", f"/zones/{zone['id']}/dns_records/{records[0]['id']}", record)
    else:
        call(api_token, "POST", f"/zones/{zone['id']}/dns_records", record)
    say(f"  https://{hostname} → this computer, port {port}")
    argo_state, argo_why = (argo_on(api_token, zone["id"]) if argo else (False, "not asked for"))
    say(f"  Argo Smart Routing: {'on' if argo_state else 'off — ' + argo_why}")
    return {"hostname": hostname, "tunnel_id": tunnel["id"], "tunnel_token": token, "zone": zone["name"], "zone_id": zone["id"], "argo": argo_state, "argo_why": argo_why}
