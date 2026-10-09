"""reader-companion: start the Jupyter server the page pairs with, and say how to pair."""

from __future__ import annotations

import argparse
import logging
import os
import platform
import secrets
import shutil
import subprocess
import time
from urllib.parse import quote
import sys
import webbrowser
from pathlib import Path

from . import __version__, desktop, env, state, tls, tunnel

DEFAULT_SITE = os.environ.get("READER_SITE", "https://saurav717.github.io/reader/")
DEFAULT_PORT = 47321

DIM, BOLD, GREEN, YELLOW, BLUE, RESET = ("\033[2m", "\033[1m", "\033[32m", "\033[33m", "\033[34m", "\033[0m") if sys.stdout.isatty() else ("",) * 6


def pair_link(site: str, code: str, port: int, via: str = "", tls_port: int = 0) -> str:
    link = f"{site.rstrip('/')}/playground#pair={code}&port={port}"
    if tls_port:
        link += f"&tls={tls_port}"
    return f"{link}&via={quote(via, safe='')}" if via else link


def parse(argv=None, command=""):
    if command == "setup":
        parser = argparse.ArgumentParser(prog="reader-companion setup", description="Set this computer up for the reader's Playground: the VS Code extension, the Companion at every login, and a browser paired with it.")
        parser.add_argument("--no-vscode", action="store_true", help="don't install the Reader extension into VS Code")
        parser.add_argument("--no-login", action="store_true", help="don't start the Companion at login: run it here, in this terminal, as plain reader-companion does")
        parser.add_argument("--no-app", action="store_true", help="don't make the Reader app (Reader.app from the .dmg runs setup with this: it is the app)")
    else:
        parser = argparse.ArgumentParser(prog="reader-companion", description="Connect this computer to the reader's Playground.", epilog="Also: reader-companion setup (install it for good: the Reader app, VS Code, start at login, pair), reader-companion open (what the Reader app runs), reader-companion start (start it in the background, also after a shutdown from the page), reader-companion pair (a new pairing link for the one running), reader-companion trust (let Safari reach it, on macOS), reader-companion uninstall (remove the Reader app and stop starting it at login).")
    parser.add_argument("--root", help="the folder the page may read, write and run in (default ~/Reader)")
    parser.add_argument("--port", type=int, help=f"the port on 127.0.0.1 (default {DEFAULT_PORT})")
    parser.add_argument("--site", help=f"the reader's address (default {DEFAULT_SITE})")
    parser.add_argument("--python", help="the Python your code runs in (default: ~/Reader/.venv, made once); a conda env's python works too")
    parser.add_argument("--name", help="what the page calls this computer (default: its own name)")
    parser.add_argument("--tunnel", action=argparse.BooleanOptionalAction, default=None, help="also give the page an https address through a Cloudflare quick tunnel — what Safari needs (--no-tunnel turns it off again)")
    parser.add_argument("--no-browser", action="store_true", help="print the pairing link and code, don't open them")
    parser.add_argument("--version", action="version", version=f"reader-companion {__version__}")
    return parser.parse_args(argv)


def configure(args) -> dict:
    """The saved settings with these arguments on top, saved again: a token and an id the first time."""
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
    return config


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] in COMMANDS:
        return COMMANDS[argv[0]](argv[1:])
    args = parse(argv)
    serve(configure(args), args)


def serve(config: dict, args):
    """Runs the Jupyter server the page pairs with, here, until Ctrl-C."""
    if state.is_off():
        # Shut down from the page. Started by hand in a terminal is on purpose; a login item isn't.
        if sys.stdin.isatty():
            state.set_off(False)
        else:
            print("reader-companion: it was shut down from the page, so it stays off until it is started on purpose: the page's Start, the Reader app, or reader-companion start.", flush=True)
            return
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
    # Keep-alive: Jupyter pings every websocket every 30 s and closes one whose last pong is older
    # than ws_ping_timeout. Leave that at its default (90 s, three pings): a timeout equal to the
    # interval closed healthy sockets whenever a pong came back a little late, as through a tunnel.
    # Tornado also reads those millisecond values as seconds and warns that the timeout outlasts
    # the interval; that warning is about its own pinger, which this never uses, so it is muted.
    logging.getLogger("tornado.general").addFilter(lambda record: "websocket_ping_timeout" not in record.getMessage())
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

    # https on 127.0.0.1 too, for Safari, when this computer trusts the certificate (`reader-companion trust`).
    if config.get("tls", tls.needed()) and tls.days_left():
        tls_port = int(config.get("tls_port") or tls.DEFAULT_PORT)
        try:
            app.io_loop.asyncio_loop.run_until_complete(tls.serve(tls_port, companion.port))
            companion.tls_port = tls_port
        except Exception as error:  # the http address still works in Chrome, Edge and Firefox
            print(f"  {YELLOW}https on 127.0.0.1:{tls_port} didn't start ({error}): Safari won't reach this.{RESET}", flush=True)

    link = pair_link(site, companion.code, companion.port, companion.tunnel_url, companion.tls_port)
    print(f"""
  {BOLD}Reader Companion {__version__}{RESET}
  {DIM}Computer  {RESET} {companion.name}
  {DIM}Hardware  {RESET} {companion.hardware}
  {DIM}Folder    {RESET} {root}
  {DIM}Your code {RESET} {interpreter}  {DIM}(pip install in the console goes here){RESET}
  {DIM}Listening {RESET} http://127.0.0.1:{companion.port}/  {DIM}(only {origin} may call it){RESET}
{f"  {DIM}For Safari{RESET} https://127.0.0.1:{companion.tls_port}/" + chr(10) if companion.tls_port else ""}{f"  {DIM}Tunnel    {RESET} {companion.tunnel_url}  {DIM}(for Safari; everything through it needs the token){RESET}" + chr(10) if companion.tunnel_url else ""}
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
    if desktop.is_lasting(desktop.executable()) and desktop.login_installed():
        # Installed for good: the page's Start can start it again after a shutdown (one updated from the page gets it here).
        try:
            desktop.install_url_handler(desktop.executable())
        except OSError:
            pass
    if platform.system() == "Darwin" and desktop.launch_agent_path().exists():
        watch_app(app, config)
    pid_file = state.config_dir() / desktop.PID
    pid_file.write_text(str(os.getpid()))
    try:
        app.start()
    except KeyboardInterrupt:
        pass
    finally:
        if running_tunnel:
            running_tunnel.stop()
        try:
            if pid_file.read_text().strip() == str(os.getpid()):
                pid_file.unlink()
        except OSError:
            pass



def watch_app(app, config: dict) -> None:
    """On a Mac, stops for good once Reader.app is deleted (desktop.forget_install): looked for every minute."""
    # Set up before the app's place was recorded: it is looked for where apps are usually put and with
    # Spotlight. A login item with no Reader.app anywhere is one whose app was deleted (setup always makes
    # one, or is run by one), and goes too.
    from tornado.ioloop import PeriodicCallback

    missing = [0]

    def look():
        found = desktop.find_mac_app(config.get("app"))
        if found:
            missing[0] = 0
            if found != config.get("app"):  # moved, not deleted
                config["app"] = found
                state.save_config(config)
            return
        # Twice in a row, so that an app being replaced by a newer copy isn't taken for a deleted one.
        missing[0] += 1
        if missing[0] < 2:
            return
        removed = desktop.forget_install()
        stored = state.load_config()
        stored.pop("app", None)
        state.save_config(stored)
        what = f" (removed {', '.join(removed)})" if removed else ""
        print(f"  Reader.app was deleted, so the Companion stops and no longer starts at login{what}. Your files stay in {config.get('root') or '~/Reader'}; opening Reader again sets it up again.", flush=True)
        app.stop()

    look()
    PeriodicCallback(look, 60_000).start()


# ------------------------------------------------------- installed for good ----

def setup(argv):
    """The double-click installers' last step: VS Code, the Companion at every login and now, the Reader app, and the page to pair."""
    args = parse(argv, "setup")
    config = configure(args)
    state.set_off(False)
    site = config.get("site") or DEFAULT_SITE
    port = int(config.get("port") or DEFAULT_PORT)
    print(f"\n  {BOLD}Reader Companion {__version__}: setting up this computer{RESET}\n", flush=True)
    if tls.needed() and not make_trusted():
        if args.tunnel is None and "tunnel" not in config and not desktop.app_browser():
            # No https of its own, and no Chrome, Edge or Brave: the tunnel is Safari's only way in.
            config["tunnel"] = True
            state.save_config(config)
            print(f"  {DIM}Safari    {RESET} it opens an HTTPS tunnel for Safari instead (--no-tunnel turns that off)", flush=True)

    if not args.no_vscode:
        print(f"  {DIM}VS Code   {RESET} looking for it…", flush=True)
        editors = desktop.install_extension(site)
        print(f"  {DIM}VS Code   {RESET} " + (f"the Reader extension is in {', '.join(editors)}" if editors else "not found here; the Playground's card has the extension for later"), flush=True)

    command = desktop.executable()
    if args.no_login or not desktop.is_lasting(command):
        if not args.no_login:
            print(f"  {YELLOW}Run from uvx, so it can't start at login; the installers on the Playground's card install it for good.{RESET}", flush=True)
        args.no_browser = False
        return serve(config, args)

    running = desktop.wait_for(config["token"], port, 0)
    ours = desktop.login_installed()
    # One running in a terminal stays as it is; the login item takes over from the next login.
    how = desktop.install_login(command, start_now=ours or running is None, restart=ours and running is not None)
    print(f"  {DIM}At login  {RESET} starts by itself, in the background: {how}", flush=True)
    print(f"  {DIM}Starting  {RESET} the first start makes the Python your code runs in, which takes a minute…", flush=True)
    time.sleep(2)  # a restarted one is let go of its port first
    running = desktop.wait_for(config["token"], port, 240)
    if running is None:
        sys.exit(f"\n  reader-companion: it didn't start. Its log is {state.config_dir() / desktop.LOG}; reader-companion on its own runs it here, where you can see why.")
    if not args.no_app:
        print(f"  {DIM}The app   {RESET} {desktop.install_app(command, site)}", flush=True)
    desktop.install_url_handler(command, force=True)
    # Where Reader.app is, on a Mac: the .dmg's (it runs this with READER_APP set) or the one just made.
    # The Companion stops for good once it is deleted (watch_app).
    if platform.system() == "Darwin":
        made = os.environ.get("READER_APP") or (None if args.no_app else str(desktop.mac_app_path()))
        if made:
            config = state.load_config()
            config["app"] = made
            state.save_config(config)
    link = desktop.fresh_link(config["token"], running)
    print(f"""  {DIM}Listening {RESET} http://127.0.0.1:{running}/  {DIM}(folder {Path(os.path.expanduser(config.get("root") or "~/Reader")).resolve()}){RESET}

  {GREEN}Done.{RESET} Opening Reader to pair it with this computer:
    {BLUE}{link}{RESET}

  {DIM}You can close this window. From now on open {BOLD}Reader{RESET}{DIM} like any app ({APP_WHERE.get(platform.system(), "your applications menu")}):
  it starts the Companion if it isn't running and opens the site in its own window.
  The Companion also starts by itself at every login. reader-companion uninstall takes it all away again.{RESET}
""", flush=True)
    desktop.open_window(link)


APP_WHERE = {"Darwin": "Applications in Finder, Launchpad or Spotlight; drag it to the Dock to keep it there", "Windows": "the Start menu or the desktop"}


def open_app(argv):
    """What the Reader app runs: the Companion started if it isn't running, and the site in its own window."""
    argparse.ArgumentParser(prog="reader-companion open", description="Start the Companion if it isn't running, and open the reader in a window of its own.").parse_args(argv)
    config = state.load_config()
    site = config.get("site") or DEFAULT_SITE
    if not config.get("token"):
        return desktop.open_window(site)
    # Safari's certificate, not trusted yet (the prompt was turned down, or failed): ask again, at most once a week.
    if tls.needed() and tls.days_left() and not tls.is_trusted() and time.time() - float(config.get("trust_asked_at") or 0) > 7 * 86400:
        make_trusted()
    port = int(config.get("port") or DEFAULT_PORT)
    state.set_off(False)  # opening the app is starting it on purpose
    if platform.system() == "Darwin" and not desktop.login_installed() and desktop.is_lasting(desktop.executable()):
        # Reader.app was deleted (watch_app took the login item away) and is back: so is starting at login.
        desktop.install_login(desktop.executable(), start_now=False)
        if os.environ.get("READER_APP"):
            config["app"] = os.environ["READER_APP"]
            state.save_config(config)
    running = desktop.wait_for(config["token"], port, 0)
    if running is None:
        desktop.kick(desktop.executable())
        running = desktop.wait_for(config["token"], port, 120)
    # A pairing link: a browser that knows this Companion reconnects with no click, also at a new tunnel address.
    link = desktop.fresh_link(config["token"], running) if running else None
    desktop.open_window(link or site)


def make_trusted() -> bool:
    """The https certificate for Safari: made, and trusted by this Mac (it asks for the password once). Whether it is."""
    renewed = tls.ensure_certificate()
    if not renewed and tls.is_trusted():
        print(f"  {DIM}Safari    {RESET} reaches the Companion at https://127.0.0.1:{tls.DEFAULT_PORT}", flush=True)
        return True
    print(f"  {DIM}Safari    {RESET} macOS now asks for your password once, to trust a certificate for this Mac's own address", flush=True)
    print(f"  {DIM}          {RESET} (localhost and 127.0.0.1 only), so Safari can reach the Companion too…", flush=True)
    config = state.load_config()
    config["trust_asked_at"] = time.time()
    state.save_config(config)
    trusted, said = tls.trust()
    if trusted:
        print(f"  {DIM}Safari    {RESET} done: https://127.0.0.1:{tls.DEFAULT_PORT}", flush=True)
        return True
    print(f"  {YELLOW}Safari    It wasn't trusted{f' (macOS said: {said})' if said else ''}, so Safari can't reach the Companion yet: Chrome, Edge and Firefox can. Opening Reader asks again, or reader-companion trust.{RESET}", flush=True)
    return False


def trust_command(argv):
    """Makes the https certificate and asks this Mac to trust it, for Safari; then restarts the Companion so it listens on https."""
    argparse.ArgumentParser(prog="reader-companion trust", description="Let Safari reach the Companion: a certificate for this Mac's own address (localhost and 127.0.0.1), trusted once with your password.").parse_args(argv)
    if not tls.needed():
        print("Only Safari needs this, and Safari is only on macOS: nothing to do here.")
        return
    if make_trusted() and desktop.login_installed():
        config = state.load_config()
        if config.get("token") and desktop.wait_for(config["token"], int(config.get("port") or DEFAULT_PORT), 0):
            desktop.install_login(desktop.executable(), start_now=True, restart=True)
            print("Restarted the Companion: it listens on https now.")


def start(argv):
    """Starts the Companion in the background if it isn't running, also after a shutdown from the page. What the page's Start runs."""
    parser = argparse.ArgumentParser(prog="reader-companion start", description="Start the Companion in the background if it isn't running: also after it was shut down from the page.")
    parser.add_argument("--quiet", action="store_true", help="say nothing, and don't wait for it (how a reader-companion:// link runs it)")
    parser.add_argument("url", nargs="?", help=argparse.SUPPRESS)  # the reader-companion://start link, on Linux and Windows
    args = parser.parse_args(argv)
    config = state.load_config()
    state.set_off(False)
    if not config.get("token"):
        if args.quiet:
            return
        sys.exit("reader-companion: it isn't set up here yet. Run reader-companion (or reader-companion setup) once first.")
    port = int(config.get("port") or DEFAULT_PORT)
    running = desktop.wait_for(config["token"], port, 0)
    if running is None:
        desktop.kick(desktop.executable())
        if args.quiet:
            return
        print("Starting the Companion…", flush=True)
        running = desktop.wait_for(config["token"], port, 120)
        if running is None:
            sys.exit(f"reader-companion: it didn't start. Its log is {state.config_dir() / desktop.LOG}.")
    if not args.quiet:
        print(f"The Companion is running: http://127.0.0.1:{running}/")


def pair(argv):
    """Opens a new pairing link for the Companion running on this computer."""
    parser = argparse.ArgumentParser(prog="reader-companion pair", description="Open a new pairing link for the Companion running on this computer.")
    parser.add_argument("--no-browser", action="store_true", help="print the link, don't open it")
    args = parser.parse_args(argv)
    config = state.load_config()
    running = desktop.wait_for(config["token"], int(config.get("port") or DEFAULT_PORT), 0) if config.get("token") else None
    link = desktop.fresh_link(config["token"], running) if running else None
    if not link:
        sys.exit("reader-companion: no Companion is running here. Start it with reader-companion (or log out and in again, if setup installed it).")
    print(link)
    if not args.no_browser:
        webbrowser.open(link)


def uninstall(argv):
    """Removes the Reader app and the login item (and stops the Companion that runs). Keeps the folder and the settings."""
    argparse.ArgumentParser(prog="reader-companion uninstall", description="Remove the Reader app and stop starting the Companion at login. Your folder and settings stay.").parse_args(argv)
    config = state.load_config()
    running = bool(config.get("token")) and desktop.wait_for(config["token"], int(config.get("port") or DEFAULT_PORT), 0) is not None
    removed = desktop.uninstall_login(running) + desktop.uninstall_app() + desktop.uninstall_url_handler()
    print("\n".join(f"Removed {path}" for path in removed) if removed else "It wasn't set to start at login.")
    print(f"Your files are still in {Path(os.path.expanduser(config.get('root') or '~/Reader')).resolve()}, and the settings in {state.config_dir()}.")
    if shutil.which("uv"):
        print("To remove the program too: uv tool uninstall reader-companion")


COMMANDS = {"setup": setup, "open": open_app, "start": start, "pair": pair, "trust": trust_command, "uninstall": uninstall}


if __name__ == "__main__":
    main()
