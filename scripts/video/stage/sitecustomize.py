"""The video's stage, for the Python processes of the takes (scripts/video/takes/companion.mjs puts this folder on
PYTHONPATH): names the takes give their stand-in machines resolve to this computer, and, in the Companion, its
HTTPS tunnel is this computer's own address (no cloudflared, no network).

KOIOS_STAGE_HOSTS: "name=port,name=port" — each name reaches 127.0.0.1 on that port, whatever port was asked for.
KOIOS_STAGE_TUNNEL: an address the Companion uses as its tunnel's.
"""
import os
import socket

_hosts = {}
for pair in filter(None, os.environ.get("KOIOS_STAGE_HOSTS", "").split(",")):
    name, _, port = pair.partition("=")
    _hosts[name.strip().lower()] = int(port)

if _hosts:
    _getaddrinfo = socket.getaddrinfo

    def getaddrinfo(host, port, *args, **kwargs):
        name = host.decode() if isinstance(host, bytes) else host
        if isinstance(name, str) and name.lower() in _hosts:
            return _getaddrinfo("127.0.0.1", _hosts[name.lower()], *args, **kwargs)
        return _getaddrinfo(host, port, *args, **kwargs)

    socket.getaddrinfo = getaddrinfo

_tunnel = os.environ.get("KOIOS_STAGE_TUNNEL")
if _tunnel:
    try:
        from reader_companion import tunnel as _t

        class _Here:
            def __init__(self, url):
                self.process, self.url = None, url

            def alive(self):
                return True

            def stop(self):
                pass

        _t.open_configured = lambda port, config, say=print: _Here(_tunnel)
        _t.gone = lambda url, timeout_s=8: False
    except Exception:  # not the Companion's Python: nothing to stand in for
        pass
