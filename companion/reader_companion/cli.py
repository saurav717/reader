"""reader-companion: start the Jupyter server the page pairs with, and say how to pair."""

from __future__ import annotations

import argparse
import os
import secrets
import subprocess
from urllib.parse import quote
import sys
import webbrowser
from pathlib import Path

from . import __version__, env, state, tunnel

DEFAULT_SITE = os.environ.get("READER_SITE", "https://saurav717.github.io/reader/")
DEFAULT_PORT = 47321

DIM, BOLD, GREEN, YELLOW, BLUE, RESET = ("\033[2m", "\033[1m", "\033[32m", "\033[33m", "\033[34m", "\033[0m") if sys.stdout.isatty() else ("",) * 6


def pair_link(site: str, code: str, port: int, via: str = "") -> str:
    link = f"{site.rstrip('/')}/playground#pair={code}&port={port}"
    return f"{link}&via={quote(via, safe='')}" if via else link


def parse(argv=None):
    parser = argparse.ArgumentParser(prog="reader-companion", description="Connect this computer to the reader's Playground.")
    parser.add_argument("--root", help="the folder the page may read, write and run in (default ~/Reader)")
    parser.add_argument("--port", type=int, help=f"the port on 127.0.0.1 (default {DEFAULT_PORT})")
    parser.add_argument("--site", help=f"the reader's address (default {DEFAULT_SITE})")
    parser.add_argument("--python", help="the Python your code runs in (default: ~/Reader/.venv, made once); a conda env's python works too")
    parser.add_argument("--name", help="what the page calls this computer (default: its own name)")
    parser.add_argument("--tunnel", action=argparse.BooleanOptionalAction, default=None, help="also give the page an https address through a Cloudflare quick tunnel — what Safari needs (--no-tunnel turns it off again)")
    parser.add_argument("--no-browser", action="store_true", help="print the pairing link and code, don't open them")
    parser.add_argument("--version", action="version", version=f"reader-companion {__version__}")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse(argv)
    config = state.load_config()
    # Kept across restarts, so a browser paired once stays paired.
    config.setdefault("token", secrets.token_urlsafe(32))
    config.setdefault("id", secrets.token_hex(8))
    for key in ("root", "port", "site", "name", "python"):
        if getattr(args, key):
            config[key] = getattr(args, key)
    if args.tunnel is not None:
        config["tunnel"] = args.tunnel
    state.save_config(config)

    site = config.get("site") or DEFAULT_SITE
    try:
        origin = state.origin_of(site)
    except ValueError as error:
        sys.exit(f"reader-companion: {error}")
    root = Path(os.path.expanduser(config.get("root") or "~/Reader")).resolve()
    root.mkdir(parents=True, exist_ok=True)
    # Kernels start where the server does; the page's paths are relative to the root.
    os.chdir(root)
    try:
        interpreter = env.prepare(root, config.get("python"))
    except subprocess.CalledProcessError as error:
        sys.exit(f"reader-companion: couldn't set up the Python environment ({error}). Try --python with one you have.")
    env.use(root, interpreter)

    companion = state.Companion(
        name=config.get("name") or state.computer_name(),
        token=config["token"],
        id=config["id"],
        site=site,
        root=str(root),
        version=__version__,
        hardware=state.hardware(),
    )
    state.current = companion

    from jupyter_server.serverapp import ServerApp
    from traitlets.config import Config

    jupyter = Config()
    jupyter.ServerApp.ip = "127.0.0.1"
    jupyter.ServerApp.port = int(config.get("port") or DEFAULT_PORT)
    jupyter.ServerApp.port_retries = 10
    jupyter.ServerApp.open_browser = False
    # GPU pods (RunPod and the like) run everything as root; it listens on 127.0.0.1 behind a token either way.
    jupyter.ServerApp.allow_root = True
    jupyter.ServerApp.root_dir = str(root)
    # The page writes .reader/playground.json into a project (for the VS Code extension): let it reach
    # hidden paths it names, while listings still leave them out.
    jupyter.ContentsManager.allow_hidden = True
    jupyter.ServerApp.allow_origin = origin
    jupyter.ServerApp.jpserver_extensions = {"reader_companion": True, "jupyter_server_terminals": True}
    # A real terminal for the page: your shell, with your rc files and this environment.
    shell = env.shell_command(root, interpreter)
    if shell:
        jupyter.ServerApp.terminado_settings = {"shell_command": shell}
    # The server talks to its kernels over Unix sockets only your user can open, not TCP ports
    # any program on this computer could connect to (and ipykernel's warning about them).
    if os.name != "nt":
        jupyter.KernelManager.transport = "ipc"
    # Jupyter's websockets default their ping timeout to 3× the interval, which Tornado then
    # warns about and cuts back to the interval: say so up front (milliseconds).
    jupyter.ServerApp.tornado_settings = {"ws_ping_interval": 30000, "ws_ping_timeout": 30000}
    jupyter.IdentityProvider.token = companion.token
    jupyter.ServerApp.log_level = "WARN"
    if config.get("tunnel"):
        # Requests through the tunnel carry its host name; the token still guards everything.
        jupyter.ServerApp.allow_remote_access = True

    app = ServerApp.instance(config=jupyter)
    app.initialize(argv=[])
    companion.port = app.port

    running_tunnel = None
    if config.get("tunnel"):
        try:
            print("  Opening the HTTPS tunnel…", flush=True)
            running_tunnel = tunnel.start(companion.port, tunnel.cloudflared())
            companion.tunnel_url = running_tunnel.url
        except Exception as error:  # the direct address still works in Chrome, Edge and Firefox
            print(f"  {YELLOW}The tunnel didn't open ({error}). Carrying on without it: Safari won't reach this.{RESET}", flush=True)

    link = pair_link(site, companion.code, companion.port, companion.tunnel_url)
    print(f"""
  {BOLD}Reader Companion {__version__}{RESET}
  {DIM}Computer  {RESET} {companion.name}
  {DIM}Hardware  {RESET} {companion.hardware}
  {DIM}Folder    {RESET} {root}
  {DIM}Your code {RESET} {interpreter}  {DIM}(pip install in the console goes here){RESET}
  {DIM}Listening {RESET} http://127.0.0.1:{companion.port}/  {DIM}(only {origin} may call it){RESET}
{f"  {DIM}Tunnel    {RESET} {companion.tunnel_url}  {DIM}(for Safari; everything through it needs the token){RESET}" + chr(10) if companion.tunnel_url else ""}
  {YELLOW}To pair, open this in your browser{RESET}{' (opening it now)' if not args.no_browser else ''}:
    {BLUE}{link}{RESET}
  {DIM}or type the code {RESET}{BOLD}{companion.code}{RESET}{DIM} under Playground → Your compute → Connect this computer.{RESET}

  {DIM}Already paired? Nothing to do: the page finds it on its own.
  Leave this running while you work. Ctrl-C stops it; the files stay in {root}.{RESET}
""", flush=True)

    def announce(code):
        print(f"  {DIM}Paired. To pair another browser, use the code {RESET}{BOLD}{code}{RESET}", flush=True)

    companion.on_new_code = announce
    if not args.no_browser:
        try:
            webbrowser.open(link)
        except Exception:  # no browser here: the link above is enough
            pass
    try:
        app.start()
    except KeyboardInterrupt:
        pass
    finally:
        if running_tunnel:
            running_tunnel.stop()


if __name__ == "__main__":
    main()
