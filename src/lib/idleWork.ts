/**
 * Whether a Colab machine is really idle, before the idle stop ends it.
 *
 * The idle stop (Storage & compute → "Stop the runtime after … minutes with
 * nothing running") used to go by the notebook kernel alone. But a training
 * started in the terminal, under nohup, or by Claude Code or Codex runs beside
 * the kernel, which stays idle the whole time — and the runtime was stopped
 * under it. So once the kernel has been idle long enough, the machine itself
 * is asked, in the monitor kernel (runQuietly): any process busy on the CPUs
 * over a second, the GPU in use, a command running in a terminal, or a coding
 * agent's CLI. Any of these, and the stop waits.
 */

import { runQuietly } from './colab';

export const WORK_PROBE = `import json, os, subprocess, time
me = os.getpid()
hz = os.sysconf('SC_CLK_TCK') if hasattr(os, 'sysconf') else 100
SHELLS = {'bash', 'sh', 'zsh', 'dash', 'fish', 'tmux', 'screen', 'login'}
QUIET = {'jupyter', 'jupyter-lab', 'jupyter-notebook', 'jupyter-server', 'node', 'colab-fileshim', 'dockerd', 'containerd', 'tail', 'sleep'}
def ticks():
    out = {}
    for pid in os.listdir('/proc'):
        if not pid.isdigit() or int(pid) == me: continue
        try:
            with open(f'/proc/{pid}/stat') as f: s = f.read()
            rest = s.rsplit(')', 1)[1].split()
            out[int(pid)] = (int(rest[11]) + int(rest[12]), int(rest[4]), s[s.find('(') + 1:s.rfind(')')])
        except Exception: pass
    return out
def cmd(pid):
    try:
        with open(f'/proc/{pid}/cmdline', 'rb') as f: return f.read().replace(b'\\0', b' ').decode(errors='replace').strip()[:120]
    except Exception: return ''
work = []
if os.path.isdir('/proc'):
    a = ticks(); time.sleep(1.0); b = ticks()
    for pid, (t, tty, name) in b.items():
        line = cmd(pid)
        if pid in a and (t - a[pid][0]) / hz > 0.1 and 'ipykernel' not in line and name not in QUIET:
            work.append(f'{line or name} (busy on the CPU)')
        elif tty and name not in SHELLS and name not in QUIET:
            work.append(f'{line or name} (in a terminal)')
        elif any(w in line.split(' ')[0].rsplit('/', 1)[-1] for w in ('claude', 'codex')) or ' claude ' in f' {line} ':
            work.append(f'{line or name} (a coding agent)')
try:
    used = subprocess.run(['nvidia-smi', '--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=5).stdout.split()
    if used and max(int(u) for u in used) > 5: work.append(f'the GPU ({max(int(u) for u in used)}% in use)')
except Exception: pass
print(json.dumps(work[:5]))`;

/**
 * What is working on the machine (`scope`, or the page's own), in words; empty when nothing is. Null when the machine
 * couldn't be asked — the caller then goes by the kernel alone, as before.
 */
export async function workOnMachine(scope?: string): Promise<string[] | null> {
  const done = await runQuietly(WORK_PROBE, scope).catch(() => null);
  if (!done?.ok) return null;
  try {
    const found = JSON.parse(done.text.trim().split('\n').pop() || '[]') as unknown;
    return Array.isArray(found) ? found.map(String) : null;
  } catch {
    return null;
  }
}

/** When each machine (by scope; '' for the page's own) was last found working: the idle time counts from then. */
const busyAt = new Map<string, number>();
const asking = new Set<string>();

/**
 * Whether the idle stop may stop this machine now: its kernel idle since `since`, longer than `limitMs`, and nothing
 * working on it. Found working, the time starts again from now.
 */
export async function mayStopIdle(scope: string, since: number, limitMs: number): Promise<boolean> {
  const from = Math.max(since, busyAt.get(scope) ?? 0);
  if (Date.now() - from < limitMs || asking.has(scope)) return false;
  asking.add(scope);
  try {
    const work = await workOnMachine(scope || undefined);
    if (work?.length) {
      busyAt.set(scope, Date.now());
      return false;
    }
    return true;
  } finally {
    asking.delete(scope);
  }
}
