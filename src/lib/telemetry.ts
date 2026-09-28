// What a running cell says about itself, read off its output: the losses a
// training loop prints, turned into curves, and the GPU's use while it runs,
// sampled by a line of the reader's own. Pure functions over text; the
// charts are drawn in src/components/Colab.tsx.

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

// ------------------------------------------------------------------ GPU ----

export interface GpuSample {
  /** Seconds since the cell started. */
  t: number;
  /** Utilisation, 0–100, over the GPUs on the machine. */
  util: number;
  memUsedMb: number;
  memTotalMb: number;
}

/**
 * The one line the reader runs of its own, in a second kernel on the same
 * machine, every couple of seconds while a cell runs: nvidia-smi's numbers,
 * one GPU a line. Shown in the runtime menu, so nothing runs unseen.
 */
export const GPU_PROBE = "import subprocess;print(subprocess.run(['nvidia-smi','--query-gpu=utilization.gpu,memory.used,memory.total','--format=csv,noheader,nounits'],capture_output=True,text=True).stdout)";

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
