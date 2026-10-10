// A real terminal where the page has no terminals API to reach — Colab: a
// shell (bash, in a pseudo-terminal) started on the runtime by a few lines of
// Python in its small second kernel, which keeps what the shell prints; the
// page sends the keys typed and reads what came back, a few times a second
// while something is happening and slower when nothing is. Arrow keys, ⌃C,
// colours, full-screen programs (htop, vim, a progress bar) all work, as in
// any terminal — with the delay of a round trip to the runtime.

import { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { b64, shellCall as call, unb64 } from '../lib/kernelShell';
import { unwatchTerminal, watchKernelTerminal } from '../lib/jobWatch';
import { pageTerminalTheme, registerTerminal } from './Terminal';

/** Ends a kernel terminal's shell, so the next one starts afresh. */
export function closeKernelTerminal(name: string) {
  unwatchTerminal(name);
  void call(`_rt_close(${JSON.stringify(name)})`).catch(() => undefined);
}

export default function KernelTerminal({ name, cwd, label, connected, playgroundId }: { name: string; cwd: string; label: string; connected: boolean; /** Whose shell it is: followed from any page while it runs something. */ playgroundId?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'starting' | 'live' | 'closed' | 'failed'>('starting');
  const [problem, setProblem] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!connected) return;
    let disposed = false;
    let cleanup = () => undefined as void;
    let timer = 0;
    setState('starting');
    setProblem(null);
    void (async () => {
      try {
        const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
        if (disposed || !host.current) return;
        const term = new XTerm({ fontFamily: "'IBM Plex Mono', 'Reader Nerd Symbols', ui-monospace, Menlo, monospace", fontSize: 12.5, lineHeight: 1.25, cursorBlink: true, cursorStyle: 'bar', scrollback: 5000, theme: pageTerminalTheme().theme, macOptionIsMeta: true, allowTransparency: true });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(host.current);
        try {
          fit.fit();
        } catch {
          // not laid out yet
        }
        await call(`_rt_open(${JSON.stringify(name)}, ${JSON.stringify(cwd)}, ${term.rows}, ${term.cols})`);
        if (playgroundId) watchKernelTerminal({ playgroundId, name });
        if (disposed) return term.dispose();
        setState('live');
        term.focus();
        let offset = 0;
        let pending = '';
        let busy = false;
        let quiet = 0;
        const decoder = new TextDecoder();
        /** One round trip: what was typed sent, what came back written; the next one sooner after activity. */
        const pump = async () => {
          if (disposed || busy) return;
          busy = true;
          window.clearTimeout(timer);
          try {
            const typed = pending;
            pending = '';
            const raw = await call(typed ? `_rt_write(${JSON.stringify(name)}, ${JSON.stringify(b64(typed))}, ${offset})` : `_rt_read(${JSON.stringify(name)}, ${offset}, 0.4)`);
            const read = JSON.parse(raw) as { data?: string; offset?: number; alive?: boolean; gone?: boolean };
            if (read.gone) {
              setState('closed');
              return;
            }
            if (read.data) {
              term.write(decoder.decode(unb64(read.data), { stream: true }));
              quiet = 0;
            } else quiet += 1;
            offset = read.offset ?? offset;
            if (read.alive === false) {
              setState('closed');
              return;
            }
          } catch (error) {
            quiet += 3;
            if (!disposed) setProblem(error instanceof Error ? error.message : String(error));
          } finally {
            busy = false;
          }
          // Fast while output flows or keys come; after a while of nothing, every second or two.
          if (!disposed) timer = window.setTimeout(() => void pump(), pending ? 0 : quiet < 4 ? 60 : quiet < 20 ? 400 : 1500);
        };
        const type = (text: string) => {
          pending += text;
          window.setTimeout(() => void pump(), 8);
        };
        const unregister = registerTerminal(name, type);
        const typing = term.onData(type);
        const resize = () => {
          try {
            fit.fit();
          } catch {
            return;
          }
          void call(`_rt_resize(${JSON.stringify(name)}, ${term.rows}, ${term.cols})`).catch(() => undefined);
        };
        let resizeTimer = 0;
        const observer = new ResizeObserver(() => {
          window.clearTimeout(resizeTimer);
          resizeTimer = window.setTimeout(resize, 150);
        });
        observer.observe(host.current!);
        const themeWatch = new MutationObserver(() => {
          term.options.theme = pageTerminalTheme().theme;
        });
        themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-glass'] });
        void pump();
        cleanup = () => {
          unregister();
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
      window.clearTimeout(timer);
      cleanup();
    };
  }, [name, cwd, connected, round]);

  return (
    <div className="pg-terminal">
      <div className="pg-terminal-screen" ref={host} aria-label={`Terminal on ${label}`} />
      {!connected || state !== 'live' ? (
        <div className="pg-terminal-veil">
          {!connected ? (
            <span>Connect to {label} — the bar’s chip, or run a cell — and a shell opens here.</span>
          ) : state === 'starting' ? (
            <span>
              <span className="spinner" /> Opening a shell on {label}…
            </span>
          ) : (
            <>
              <span>{state === 'closed' ? 'The shell ended (exit, or the runtime restarted).' : `No terminal: ${problem}`}</span>
              <span className="pg-terminal-actions">
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    closeKernelTerminal(name);
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
