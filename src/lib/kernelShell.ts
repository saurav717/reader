// A shell on a Colab runtime, where there is no terminals API: bash in a
// pseudo-terminal, started by a few lines of Python in the runtime's small
// second kernel (the monitor), which keeps what it prints. The terminal pane
// (src/components/KernelTerminal.tsx) types into it and reads it back; the
// running-playgrounds watch (src/lib/jobWatch.ts) asks what each is running.

import { runQuietly } from './colab';

export const KERNEL_SHELL = String.raw`
if globals().get('_rt_v') != 3:
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
    def _rt_status():
        # What each shell is running: the pty's foreground process group is the shell's own at its prompt, a
        # command's while one runs (bash -i has job control); and the end of what it printed.
        out = {}
        for name, t in list(_rt_terms.items()):
            busy, cmd = False, ''
            if t['alive']:
                try:
                    g = os.tcgetpgrp(t['fd'])
                    if g > 0 and g != t['pid']:
                        busy = True
                        try:
                            with open('/proc/%d/cmdline' % g, 'rb') as f:
                                cmd = f.read().replace(b'\0', b' ').decode(errors='replace').strip()[:200]
                        except Exception:
                            pass
                except OSError:
                    pass
            with t['lock']:
                tail = bytes(t['buf'][-4000:]).decode(errors='replace')
            out[name] = {'alive': t['alive'], 'busy': busy, 'command': cmd, 'tail': tail, 'offset': t['base'] + len(t['buf'])}
        print(json.dumps(out))
    _rt_v = 3
`;
export const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
export const unb64 = (data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0));

/** Runs the helper and `code` in the monitor kernel of `scope`'s session (a playground's, from any page), or the foreground's. */
export async function shellCall(code: string, scope?: string): Promise<string> {
  const answer = await runQuietly(`${KERNEL_SHELL}\n${code}`, scope);
  if (!answer) throw new Error('The machine isn’t connected.');
  if (!answer.ok) throw new Error(answer.text.trim().split('\n').pop() || 'The shell couldn’t be reached.');
  return answer.text.trim().split('\n').pop() ?? '';
}
