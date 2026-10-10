// A real terminal where the page has no terminals API to reach — Colab: a
// shell (bash, in a pseudo-terminal) started on the runtime by a few lines of
// Python in its small second kernel, which keeps what the shell prints; the
// page sends the keys typed and reads what came back, a few times a second
// while something is happening and slower when nothing is. Arrow keys, ⌃C,
// colours, full-screen programs (htop, vim, a progress bar) all work, as in
// any terminal — with the delay of a round trip to the runtime.

import { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { runQuietly } from '../lib/colab';
import { pageTerminalTheme, registerTerminal } from './Terminal';

const HELPER = String.raw`
if globals().get('_rt_v') != 2:
    import os, pty, json, threading, fcntl, struct, termios, signal, base64, time
    _rt_terms = globals().setdefault('_rt_terms', {})
    def _rt_open(name, cwd, rows, cols):
        t = _rt_terms.get(name)
        if t and t['alive']:
            _rt_resize(name, rows, cols, quiet=True)
            print(json.dumps({'again': True})); return
        pid, fd = pty.fork()
        if pid == 0:
            try:
                os.makedirs(cwd, exist_ok=True); os.chdir(cwd)
            except Exception:
                pass
            env = dict(os.environ)
            env.update({'TERM': 'xterm-256color', 'COLORTERM': 'truecolor', 'PATH': os.pathsep.join([os.path.expanduser('~/.local/bin'), '/usr/local/bin', env.get('PATH', '')])})
            env.pop('JPY_PARENT_PID', None)
            os.execvpe('bash', ['bash', '-i'], env)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        t = {'pid': pid, 'fd': fd, 'buf': bytearray(), 'base': 0, 'alive': True, 'lock': threading.Lock()}
        def pump():
            while True:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    data = b''
                if not data:
                    t['alive'] = False; break
                with t['lock']:
                    t['buf'] += data
                    if len(t['buf']) > 2000000:
                        cut = len(t['buf']) - 1000000; del t['buf'][:cut]; t['base'] += cut
        threading.Thread(target=pump, daemon=True).start()
        _rt_terms[name] = t
        print(json.dumps({'again': False}))
    def _rt_read(name, offset, wait=0.0):
        t = _rt_terms.get(name)
        if not t:
            print(json.dumps({'gone': True})); return
        end = time.time() + wait
        while wait and time.time() < end and t['base'] + len(t['buf']) <= offset and t['alive']:
            time.sleep(0.02)
        with t['lock']:
            start = max(offset, t['base'])
            data = bytes(t['buf'][start - t['base']:])
            stop = t['base'] + len(t['buf'])
        print(json.dumps({'data': base64.b64encode(data).decode(), 'offset': stop, 'alive': t['alive']}))
    def _rt_write(name, b64, offset):
        t = _rt_terms.get(name)
        if t and t['alive']:
            os.write(t['fd'], base64.b64decode(b64))
        _rt_read(name, offset, 0.12)
    def _rt_resize(name, rows, cols, quiet=False):
        t = _rt_terms.get(name)
        if t and t['alive']:
            fcntl.ioctl(t['fd'], termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
            try: os.kill(t['pid'], signal.SIGWINCH)
            except Exception: pass
        if not quiet: print('ok')
    def _rt_close(name):
        t = _rt_terms.pop(name, None)
        if t:
            try: os.kill(t['pid'], signal.SIGHUP)
            except Exception: pass
        print('ok')
    _rt_v = 2
`;

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const unb64 = (data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0));

async function call(code: string): Promise<string> {
  const answer = await runQuietly(`${HELPER}\n${code}`);
  if (!answer) throw new Error('The machine isn’t connected.');
  if (!answer.ok) throw new Error(answer.text.trim().split('\n').pop() || 'The shell couldn’t be reached.');
  return answer.text.trim().split('\n').pop() ?? '';
}

/** Ends a kernel terminal's shell, so the next one starts afresh. */
export function closeKernelTerminal(name: string) {
  void call(`_rt_close(${JSON.stringify(name)})`).catch(() => undefined);
}

export default function KernelTerminal({ name, cwd, label, connected }: { name: string; cwd: string; label: string; connected: boolean }) {
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
