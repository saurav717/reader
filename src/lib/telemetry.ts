// What a running cell says about itself, read off its output: the losses a
// training loop prints, turned into curves, and the machine's use while it
// runs — GPU, CPU, memory, disk — sampled by a few lines of the reader's own. Pure functions over text; the
// charts are drawn in src/components/Charts.tsx.

export interface Point {
  x: number;
  y: number;
}

export interface Series {
  /** loss, train, val, test or eval — the name the log used, shortened. */
  name: string;
  points: Point[];
  /** Whether x is a step or epoch the log named, or just the order of the lines. */
  stepped: boolean;
}

// A loss, as training loops print it: "loss: 0.532", "train_loss=0.41",
// "val loss 1.2", "Loss 2.3e-01". The name is kept to tell the series apart.
const LOSS = /\b((?:train(?:ing)?|val(?:id(?:ation)?)?|test|eval(?:uation)?|dev)?[ _-]?loss)\b\s*(?:[:=]\s*|\s+)([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\b/gi;
// Where in training the line is: a step or iteration first ("step 100",
// "iter=40", "it 12"), an epoch when that is all there is, else a progress
// bar's "12/100". A line with both an epoch and a step is plotted by the step.
const STEP = /\b(?:global[ _]?step|step|iter(?:ation)?|it)\b\s*[:=#]?\s*(\d+)/i;
const EPOCH = /\bepoch\b\s*[:=#]?\s*(\d+)/i;
const PROGRESS = /(?:^|\s)(\d+)\/\d+\b/;

const MAX_SERIES = 4;
/** The most points a series keeps for drawing; beyond it, every other one goes. */
export const MAX_POINTS = 2000;

function seriesName(raw: string): string {
  const lower = raw.toLowerCase().replace(/[_-]/g, ' ').trim();
  if (/^train/.test(lower)) return 'train';
  if (/^val/.test(lower)) return 'val';
  if (/^test/.test(lower)) return 'test';
  if (/^eval/.test(lower)) return 'eval';
  if (/^dev/.test(lower)) return 'dev';
  return 'loss';
}

export function downsample(points: Point[], max = MAX_POINTS): Point[] {
  if (points.length <= max) return points;
  const stride = Math.ceil(points.length / max);
  const kept = points.filter((_, index) => index % stride === 0);
  // The last point is the one the reader looks for.
  if (kept[kept.length - 1] !== points[points.length - 1]) kept.push(points[points.length - 1]);
  return kept;
}

/**
 * The loss curves in a cell's output. Each line is read for losses and for a
 * step; a line with a loss and no step is plotted by its order among such
 * lines. Carriage returns (a progress bar redrawing itself) count as line
 * ends, so each redraw is a point. At most four series; nothing for output
 * that names no loss.
 */
export function lossSeries(text: string): Series[] {
  const series = new Map<string, Series>();
  let order = 0;
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (!/loss/i.test(line)) continue;
    const found: { name: string; y: number }[] = [];
    LOSS.lastIndex = 0;
    for (const match of line.matchAll(LOSS)) {
      const y = Number(match[2]);
      if (Number.isFinite(y)) found.push({ name: seriesName(match[1]), y });
    }
    if (!found.length) continue;
    const step = line.match(STEP)?.[1] ?? line.match(EPOCH)?.[1] ?? line.match(PROGRESS)?.[1];
    order += 1;
    const x = step !== undefined ? Number(step) : order;
    for (const { name, y } of found) {
      let entry = series.get(name);
      if (!entry) {
        if (series.size >= MAX_SERIES) continue;
        entry = { name, points: [], stepped: step !== undefined };
        series.set(name, entry);
      }
      if (step === undefined) entry.stepped = false;
      entry.points.push({ x, y });
    }
  }
  return Array.from(series.values())
    .map((entry) => ({ ...entry, points: downsample(entry.stepped ? entry.points : entry.points.map((point, index) => ({ x: index + 1, y: point.y }))) }))
    .filter((entry) => entry.points.length > 0);
}

/** Whether there is enough of a curve to draw: three points on one series. */
export const hasCurve = (series: Series[]) => series.some((entry) => entry.points.length >= 3);

// ------------------------------------------------------------- metrics ----
//
// The Metrics pane reads every scalar a training loop prints, the way
// TensorBoard's Scalars tab shows every tag: the loss, but also accuracy,
// the learning rate, perplexity, BLEU, F1, a gradient norm, a reward. A
// value counts when its name is one of those, on its own or with a split in
// front (train_loss, val/acc, test accuracy); "step 100" and "epoch 2" say
// where it is, as for the loss curves.

export interface Metric {
  /** The metric's name, the split taken off: loss, acc, lr… */
  name: string;
  /** One series a split — train, val, test… — or one unnamed series when the log names none. */
  series: Series[];
}

const SPLIT = '(?:train(?:ing)?|val(?:id(?:ation)?)?|test|eval(?:uation)?|dev)';
const METRIC_NAMES = 'loss|nll|acc(?:uracy)?|top[- _]?[15](?:[- _]?acc(?:uracy)?)?|lr|learning[ _-]?rate|ppl|perplexity|bleu|rouge(?:[- _]?[l12])?|f1|auc(?:roc)?|m?ap|precision|recall|iou|dice|wer|cer|mse|mae|rmse|r2|grad[ _-]?norm|reward|return|score|error(?:[ _-]?rate)?|err|elbo|kl|entropy';
const METRIC = new RegExp(`(?<![\\w./])(?:(${SPLIT})[ _/-])?(${METRIC_NAMES})(?:@\\d+)?\\b\\s*(?:[:=]\\s*|\\s+)([-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[-+]?\\d+)?)(?![\\w./])`, 'gi');
export const MAX_METRICS = 8;

const metricName = (raw: string) => {
  const lower = raw.toLowerCase().replace(/[ _-]+/g, ' ').trim();
  if (/^acc/.test(lower)) return 'accuracy';
  if (lower === 'learning rate') return 'lr';
  if (lower === 'ppl') return 'perplexity';
  if (lower === 'err' || /^error/.test(lower)) return 'error';
  if (/^grad/.test(lower)) return 'grad norm';
  if (/^top ?1/.test(lower)) return 'top-1';
  if (/^top ?5/.test(lower)) return 'top-5';
  return lower;
};

/**
 * The metrics in a cell's output, each with a series a split, by step (or
 * epoch, or a progress bar's count) where the line names one and by the
 * order of the lines otherwise. At most MAX_METRICS metrics, the first
 * seen kept; nothing for output that names none.
 */
export function metricSeries(text: string): Metric[] {
  const metrics = new Map<string, Map<string, Series>>();
  const orders = new Map<string, number>();
  for (const line of text.split(/\r\n|\r|\n/)) {
    const found: { metric: string; split: string; y: number }[] = [];
    METRIC.lastIndex = 0;
    for (const match of line.matchAll(METRIC)) {
      const y = Number(match[3]);
      if (!Number.isFinite(y)) continue;
      found.push({ metric: metricName(match[2]), split: match[1] ? seriesName(match[1]) : '', y });
    }
    if (!found.length) continue;
    const step = line.match(STEP)?.[1] ?? line.match(EPOCH)?.[1] ?? line.match(PROGRESS)?.[1];
    for (const { metric, split, y } of found) {
      let splits = metrics.get(metric);
      if (!splits) {
        if (metrics.size >= MAX_METRICS) continue;
        splits = new Map();
        metrics.set(metric, splits);
      }
      let entry = splits.get(split);
      if (!entry) {
        if (splits.size >= MAX_SERIES) continue;
        entry = { name: split, points: [], stepped: step !== undefined };
        splits.set(split, entry);
      }
      const orderKey = `${metric}\u0000${split}`;
      const order = (orders.get(orderKey) ?? 0) + 1;
      orders.set(orderKey, order);
      if (step === undefined) entry.stepped = false;
      entry.points.push({ x: step !== undefined ? Number(step) : order, y });
    }
  }
  return Array.from(metrics.entries()).map(([name, splits]) => ({
    name,
    series: Array.from(splits.values())
      .map((entry) => ({ ...entry, points: downsample(entry.stepped ? entry.points : entry.points.map((point, index) => ({ x: index + 1, y: point.y }))) }))
      .filter((entry) => entry.points.length > 0),
  }));
}

// -------------------------------------------------------------- machine ----

export interface GpuSample {
  /** Seconds since the cell started. */
  t: number;
  /** Utilisation, 0–100, over the GPUs on the machine. */
  util: number;
  memUsedMb: number;
  memTotalMb: number;
}

/**
 * The machine at one moment: the GPU when nvidia-smi can see one, the CPUs,
 * the system memory and the disk. Every part is optional, since a CPU
 * runtime has no GPU and a probe can fail halfway; `t` is seconds since the
 * cell started, or 0 for a reading taken between cells.
 */
export interface MachineSample {
  t: number;
  gpu?: GpuSample & { name?: string };
  /** CPU utilisation, 0–100, over every core. */
  cpu?: number;
  cpus?: number;
  ramUsedMb?: number;
  ramTotalMb?: number;
  diskFreeGb?: number;
  diskTotalGb?: number;
}

/** What the machine is, read off a sample: the parts that do not change while it is up. */
export interface MachineSpecs {
  gpuName?: string;
  vramMb?: number;
  cpus?: number;
  ramTotalMb?: number;
  diskTotalGb?: number;
  diskFreeGb?: number;
}

/**
 * The one thing the reader runs of its own, in a second kernel on the same
 * machine, every couple of seconds while a cell runs and once when the
 * runtime connects: nvidia-smi's numbers when there is a GPU, the CPUs' busy
 * share over a quarter of a second, the memory in use, and the disk. On
 * Linux — Colab, a lab machine — the CPU and memory come from /proc; on a
 * Mac from the kernel's own counters (host_statistics, sysctl and vm_stat);
 * on Windows from GetSystemTimes and GlobalMemoryStatusEx. One JSON line.
 * Shown in the runtime menu, so nothing runs unseen; it reads, and changes
 * nothing.
 */
export const MACHINE_PROBE = `import json, os, platform, shutil, subprocess, time
def _safe(f):
    try: return f()
    except Exception: return None
def _run(*args):
    return subprocess.run(list(args), capture_output=True, text=True, timeout=5).stdout
def _ticks():
    if os.path.exists('/proc/stat'):
        with open('/proc/stat') as f: v = [int(x) for x in f.readline().split()[1:]]
        return sum(v), v[3] + v[4]
    import ctypes
    if platform.system() == 'Darwin':
        lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
        lib.mach_host_self.restype = ctypes.c_uint
        host = globals().get('_mach_host') or lib.mach_host_self()
        globals()['_mach_host'] = host
        v = (ctypes.c_uint * 4)(); n = ctypes.c_uint(4)
        if lib.host_statistics(ctypes.c_uint(host), 3, v, ctypes.byref(n)): raise OSError('host_statistics')
        return sum(v), v[2]
    if os.name == 'nt':
        idle, kernel, user = ctypes.c_ulonglong(), ctypes.c_ulonglong(), ctypes.c_ulonglong()
        if not ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user)): raise OSError('GetSystemTimes')
        return kernel.value + user.value, idle.value
    raise OSError('no CPU counters here')
def _cpu():
    a, ia = _ticks(); time.sleep(0.25); b, ib = _ticks()
    return round(100 * (1 - (ib - ia) / max(1, b - a)))
def _ram():
    if os.path.exists('/proc/meminfo'):
        m = {}
        with open('/proc/meminfo') as f:
            for line in f:
                k, v = line.split(':', 1); m[k] = int(v.split()[0])
        return [(m['MemTotal'] - m['MemAvailable']) // 1024, m['MemTotal'] // 1024]
    if platform.system() == 'Darwin':
        total = int(_run('sysctl', '-n', 'hw.memsize'))
        out = _run('vm_stat')
        page = int(out.split('page size of ')[1].split()[0])
        pages = {}
        for line in out.splitlines()[1:]:
            k, _, v = line.partition(':'); v = v.strip().rstrip('.')
            if v.isdigit(): pages[k.strip()] = int(v)
        used = (pages['Pages active'] + pages['Pages wired down'] + pages.get('Pages occupied by compressor', 0)) * page
        return [used // 2**20, total // 2**20]
    if os.name == 'nt':
        import ctypes
        class M(ctypes.Structure):
            _fields_ = [('size', ctypes.c_ulong), ('load', ctypes.c_ulong)] + [(k, ctypes.c_ulonglong) for k in ('total', 'avail', 'pt', 'pa', 'vt', 'va', 've')]
        m = M(); m.size = ctypes.sizeof(M)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)): raise OSError('GlobalMemoryStatusEx')
        return [(m.total - m.avail) // 2**20, m.total // 2**20]
    raise OSError('no memory counters here')
def _gpu():
    return _run('nvidia-smi', '--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits').strip()
def _disk():
    d = shutil.disk_usage(os.path.abspath(os.sep)); return [d.free // 2**30, d.total // 2**30]
print(json.dumps({'gpu': _safe(_gpu) or '', 'cpu': _safe(_cpu), 'cpus': os.cpu_count(), 'ram': _safe(_ram), 'disk': _safe(_disk)}))`;

/** nvidia-smi's csv, read: the busiest GPU's utilisation, and memory summed. Null when the line is not that. */
export function parseGpuSample(text: string, t: number): GpuSample | null {
  const rows = text
    .split('\n')
    .map((line) => line.split(',').map((cell) => Number(cell.trim())))
    .filter((cells) => cells.length >= 3 && cells.every((cell) => Number.isFinite(cell)));
  if (!rows.length) return null;
  return {
    t,
    util: Math.max(...rows.map((cells) => cells[0])),
    memUsedMb: rows.reduce((sum, cells) => sum + cells[1], 0),
    memTotalMb: rows.reduce((sum, cells) => sum + cells[2], 0),
  };
}

/** nvidia-smi's csv with the name first: "Tesla T4, 63, 3012, 15360", one GPU a line. */
function parseNamedGpu(text: string, t: number): MachineSample['gpu'] | undefined {
  const rows = text
    .split('\n')
    .map((line) => line.split(','))
    .filter((cells) => cells.length >= 4)
    .map((cells) => ({ name: cells[0].trim(), numbers: cells.slice(1, 4).map((cell) => Number(cell.trim())) }))
    .filter((row) => row.numbers.every((n) => Number.isFinite(n)));
  if (!rows.length) return parseGpuSample(text, t) ?? undefined;
  const name = rows[0].name && rows.every((row) => row.name === rows[0].name) ? (rows.length > 1 ? `${rows.length}× ${rows[0].name}` : rows[0].name) : rows.map((row) => row.name).join(', ');
  return { t, name, util: Math.max(...rows.map((row) => row.numbers[0])), memUsedMb: rows.reduce((sum, row) => sum + row.numbers[1], 0), memTotalMb: rows.reduce((sum, row) => sum + row.numbers[2], 0) };
}

const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/**
 * What the probe printed, read: the last line that is its JSON. Null when
 * nothing in the text is — a kernel that printed a traceback instead.
 */
export function parseMachineSample(text: string, t: number): MachineSample | null {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{'));
  for (const line of lines.reverse()) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object' || !('cpu' in raw || 'gpu' in raw || 'ram' in raw)) continue;
    const ram = Array.isArray(raw.ram) ? raw.ram : [];
    const disk = Array.isArray(raw.disk) ? raw.disk : [];
    const sample: MachineSample = { t };
    const gpu = typeof raw.gpu === 'string' && raw.gpu.trim() ? parseNamedGpu(raw.gpu, t) : undefined;
    if (gpu) sample.gpu = gpu;
    const cpu = finite(raw.cpu);
    if (cpu !== undefined) sample.cpu = Math.max(0, Math.min(100, Math.round(cpu)));
    const cpus = finite(raw.cpus);
    if (cpus !== undefined) sample.cpus = cpus;
    if (finite(ram[0]) !== undefined && finite(ram[1]) !== undefined) {
      sample.ramUsedMb = ram[0] as number;
      sample.ramTotalMb = ram[1] as number;
    }
    if (finite(disk[0]) !== undefined && finite(disk[1]) !== undefined) {
      sample.diskFreeGb = disk[0] as number;
      sample.diskTotalGb = disk[1] as number;
    }
    return sample;
  }
  return null;
}

/** The lasting parts of a sample: what the machine is. */
export function specsOf(sample: MachineSample): MachineSpecs {
  return { gpuName: sample.gpu?.name, vramMb: sample.gpu?.memTotalMb, cpus: sample.cpus, ramTotalMb: sample.ramTotalMb, diskTotalGb: sample.diskTotalGb, diskFreeGb: sample.diskFreeGb };
}

export const gigabytes = (mb: number) => `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB`;

// --------------------------------------------------------------- drawing ---

/** Round tick values for an axis: a few clean numbers across the range. */
export function ticks(min: number, max: number, count = 3): number[] {
  if (!(max > min)) return [min];
  const span = max - min;
  const rough = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => span / s <= count + 0.5) ?? magnitude * 10;
  const first = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let value = first; value <= max + step / 1000; value += step) out.push(Number(value.toFixed(10)));
  return out;
}

/** A number as the axis and the labels show it: short, and no more digits than it has. */
export function short(value: number): string {
  if (!Number.isFinite(value)) return '';
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= 1000) return `${(value / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 1) return value.toFixed(2).replace(/\.?0+$/, '');
  if (abs >= 0.01) return value.toFixed(3).replace(/\.?0+$/, '');
  return value.toExponential(1);
}
