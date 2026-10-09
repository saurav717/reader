// A real terminal on a Jupyter server: xterm.js in the page, the server's
// terminals API (terminado) on the other end. On a Reader Companion the shell
// is the person's own ($SHELL — zsh with oh-my-zsh, bash, fish) with the
// playground's Python environment on top. The session lives on the server, so
// leaving the tab and coming back finds the same shell, history and all.

import { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import type { JupyterServer } from '../lib/colab';
import { jupyterFetch, serverBase } from '../lib/colab';

const sessionKey = (server: JupyterServer, key: string) => `pgterm:${server.id}:${key}`;

const read = (name: string) => {
  try {
    return sessionStorage.getItem(name);
  } catch {
    return null;
  }
};
const write = (name: string, value: string | null) => {
  try {
    if (value === null) sessionStorage.removeItem(name);
    else sessionStorage.setItem(name, value);
  } catch {
    // private mode: a new shell next time
  }
};

/** Whether this server offers terminals (jupyter_server_terminals): a Companion does, a bare `jupyter server` may. */
export async function hasTerminals(server: JupyterServer): Promise<boolean> {
  try {
    await jupyterFetch(server, 'api/terminals');
    return true;
  } catch {
    return false;
  }
}

/** This page's terminal on the server: the one it had, if the server still has it, else a new one in `cwd`. */
async function terminalName(server: JupyterServer, key: string, cwd: string, fresh: boolean): Promise<string> {
  const saved = read(sessionKey(server, key));
  if (saved && fresh) {
    await jupyterFetch(server, `api/terminals/${encodeURIComponent(saved)}`, { method: 'DELETE' }).catch(() => undefined);
  } else if (saved) {
    const alive = await jupyterFetch(server, `api/terminals/${encodeURIComponent(saved)}`).then(
      () => true,
      () => false,
    );
    if (alive) return saved;
  }
  let made: { name: string };
  try {
    made = await jupyterFetch<{ name: string }>(server, 'api/terminals', { method: 'POST', body: { cwd } });
  } catch {
    // The folder isn't on the machine yet (a split playground before its first copy): start at the root.
    made = await jupyterFetch<{ name: string }>(server, 'api/terminals', { method: 'POST', body: {} });
  }
  write(sessionKey(server, key), made.name);
  return made.name;
}

// The terminal wears the site's theme: its paper, ink and accent, read from the page's own tokens, and
// ANSI colours from its palette — the highlight and code colours — dark or light to suit.
const ANSI = {
  light: {
    black: '#1a1a17', red: '#b5435a', green: '#2f7d4f', yellow: '#9a7a00', blue: '#1f5e9e', magenta: '#8a3ea6', cyan: '#1f6f72', white: '#6f6c63',
    brightBlack: '#55524a', brightRed: '#c9566c', brightGreen: '#3c9160', brightYellow: '#b0571c', brightBlue: '#3a78bd', brightMagenta: '#a55bc0', brightCyan: '#2c8a8d', brightWhite: '#1a1a17',
  },
  dark: {
    black: '#25272d', red: '#e08592', green: '#93cfa6', yellow: '#e6c46f', blue: '#8bb8ec', magenta: '#c99ae0', cyan: '#7cc7c4', white: '#c3bfb4',
    brightBlack: '#9b978c', brightRed: '#f0a3ae', brightGreen: '#b3e3c1', brightYellow: '#f2d68f', brightBlue: '#a9cdf5', brightMagenta: '#ddb8ef', brightCyan: '#9fdcd9', brightWhite: '#eae7df',
  },
};

/** The page's theme as xterm takes it, from the tokens on <html> right now. */
export function pageTerminalTheme(root: HTMLElement = document.documentElement) {
  const css = getComputedStyle(root);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const dark = root.dataset.theme === 'dark';
  const glass = root.dataset.glass === 'on';
  const accentRgb = token('--accent-rgb', dark ? '87 169 143' : '31 94 82');
  return {
    theme: {
      // Glass shows the wall through; otherwise the terminal is a sheet of the page's paper.
      background: glass ? 'rgba(0, 0, 0, 0)' : token('--paper', dark ? '#15161a' : '#fbfaf6'),
      foreground: token('--ink', dark ? '#eae7df' : '#1a1a17'),
      cursor: token('--accent', dark ? '#57a98f' : '#1f5e52'),
      cursorAccent: token('--paper', dark ? '#15161a' : '#fbfaf6'),
      selectionBackground: `rgb(${accentRgb} / ${dark ? 0.38 : 0.22})`,
      selectionInactiveBackground: `rgb(${accentRgb} / 0.14)`,
      scrollbarSliderBackground: `rgb(${accentRgb} / 0.18)`,
      scrollbarSliderHoverBackground: `rgb(${accentRgb} / 0.3)`,
      ...ANSI[dark ? 'dark' : 'light'],
    },
    glass,
  };
}

export default function Terminal({ server, cwd, sessionId, label }: { server: JupyterServer; cwd: string; sessionId: string; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'starting' | 'live' | 'closed' | 'failed'>('starting');
  const [problem, setProblem] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const fresh = useRef(false);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let cleanup = () => undefined as void;
    setState('starting');
    setProblem(null);
    void (async () => {
      try {
        const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
        const name = await terminalName(server, sessionId, cwd, fresh.current);
        fresh.current = false;
        if (disposed || !host.current) return;
        const look = pageTerminalTheme();
        const term = new XTerm({ fontFamily: "'IBM Plex Mono', ui-monospace, Menlo, monospace", fontSize: 12.5, lineHeight: 1.25, cursorBlink: true, cursorStyle: 'bar', scrollback: 5000, theme: look.theme, macOptionIsMeta: true, allowTransparency: true });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(host.current);
        const url = new URL(`terminals/websocket/${encodeURIComponent(name)}`, serverBase(server.url));
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        if (server.token) url.searchParams.set('token', server.token);
        socket = new WebSocket(url.href);
        const send = (message: unknown[]) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message));
        const resize = () => {
          try {
            fit.fit();
          } catch {
            return;
          }
          send(['set_size', term.rows, term.cols]);
        };
        socket.onopen = () => {
          setState('live');
          resize();
          term.focus();
        };
        socket.onmessage = (event) => {
          try {
            const [kind, data] = JSON.parse(String(event.data)) as [string, string];
            if (kind === 'stdout') term.write(data);
            else if (kind === 'disconnect') setState('closed');
          } catch {
            // not terminado's: ignore
          }
        };
        socket.onclose = () => !disposed && setState((now) => (now === 'live' || now === 'starting' ? 'closed' : now));
        const typing = term.onData((data) => send(['stdin', data]));
        const observer = new ResizeObserver(() => resize());
        observer.observe(host.current);
        // Light, dark or glass changed in Settings: the terminal follows at once.
        const themeWatch = new MutationObserver(() => {
          term.options.theme = pageTerminalTheme().theme;
        });
        themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-glass'] });
        cleanup = () => {
          themeWatch.disconnect();
          observer.disconnect();
          typing.dispose();
          term.dispose();
        };
      } catch (error) {
        if (disposed) return;
        setState('failed');
        setProblem(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      disposed = true;
      socket?.close();
      cleanup();
    };
  }, [server.id, server.url, server.token, cwd, sessionId, round]);

  return (
    <div className="pg-terminal">
      <div className="pg-terminal-screen" ref={host} aria-label={`Terminal on ${label}`} />
      {state !== 'live' ? (
        <div className="pg-terminal-veil">
          {state === 'starting' ? (
            <span>
              <span className="spinner" /> Opening a shell on {label}…
            </span>
          ) : (
            <>
              <span>{state === 'closed' ? 'The shell ended, or the connection to it dropped.' : `No terminal: ${problem}`}</span>
              <span className="pg-terminal-actions">
                <button type="button" className="btn sm" onClick={() => setRound((n) => n + 1)}>
                  Reconnect
                </button>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    fresh.current = true;
                    setRound((n) => n + 1);
                  }}
                >
                  New shell
                </button>
              </span>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Starts the next Terminal with a new shell, ending this one on the server. */
export function forgetTerminal(server: JupyterServer, key: string) {
  const saved = read(sessionKey(server, key));
  write(sessionKey(server, key), null);
  if (saved) void jupyterFetch(server, `api/terminals/${encodeURIComponent(saved)}`, { method: 'DELETE' }).catch(() => undefined);
}
