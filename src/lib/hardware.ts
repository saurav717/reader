// ===========================================================================
//  Hardware — what the reader has, and how long the paper's work takes on it.
//
//  The Implementation page asks Claude for the *work* in a paper — FLOPs a
//  phase, memory it needs, disk it fills — rather than for hours, which
//  depend on the machine. The hours are worked out here, for the machine the
//  reader picks: a catalogue of the GPUs people actually have (Colab's, a
//  desktop's, a rented node's), and the arithmetic that turns work into time,
//  money and "does it fit". All of it is plain data and pure functions, so
//  the tests can check the sums without a browser.
// ===========================================================================

export interface Gpu {
  id: string;
  label: string;
  /** Where the reader would get one; shown under the name. */
  where: string;
  /** Dense bf16/fp16 tensor-core peak, in TFLOPS. The realistic rate is this times the utilisation. */
  tflops: number;
  /** Memory on the card, in GB. */
  vramGb: number;
  /** A typical rental price an hour, in USD; 0 for hardware the reader owns or Colab's free tier. */
  usdPerHour: number;
  /** The longest one session can run, in hours, where a service imposes one (Colab). */
  sessionHours?: number;
  /** The most of these one machine takes. */
  maxCount: number;
  /** Colab's tiers, so the page can say "a Colab session" rather than "a machine". */
  colab?: boolean;
}

/**
 * Peaks are the vendors' dense fp16/bf16 tensor figures (the sparse ones are
 * double and never reached in training). Prices are what the large clouds and
 * the GPU renters were charging in 2025, rounded; they move, so they are
 * shown as "about".
 */
export const GPUS: Gpu[] = [
  { id: 'colab-t4', label: 'T4 · 16 GB', where: 'Colab, free tier', tflops: 65, vramGb: 16, usdPerHour: 0, sessionHours: 12, maxCount: 1, colab: true },
  { id: 'colab-l4', label: 'L4 · 24 GB', where: 'Colab Pro', tflops: 121, vramGb: 24, usdPerHour: 0.5, sessionHours: 24, maxCount: 1, colab: true },
  { id: 'colab-a100', label: 'A100 · 40 GB', where: 'Colab Pro+', tflops: 312, vramGb: 40, usdPerHour: 1.2, sessionHours: 24, maxCount: 1, colab: true },
  { id: 'rtx-3090', label: 'RTX 3090 · 24 GB', where: 'a desktop', tflops: 71, vramGb: 24, usdPerHour: 0, maxCount: 4 },
  { id: 'rtx-4090', label: 'RTX 4090 · 24 GB', where: 'a desktop', tflops: 165, vramGb: 24, usdPerHour: 0, maxCount: 4 },
  { id: 'rtx-5090', label: 'RTX 5090 · 32 GB', where: 'a desktop', tflops: 210, vramGb: 32, usdPerHour: 0, maxCount: 4 },
  { id: 'a100-80', label: 'A100 · 80 GB', where: 'rented, about $1.80/h', tflops: 312, vramGb: 80, usdPerHour: 1.8, maxCount: 8 },
  { id: 'h100', label: 'H100 SXM · 80 GB', where: 'rented, about $3/h', tflops: 989, vramGb: 80, usdPerHour: 3, maxCount: 8 },
  { id: 'h200', label: 'H200 · 141 GB', where: 'rented, about $4/h', tflops: 989, vramGb: 141, usdPerHour: 4, maxCount: 8 },
  { id: 'b200', label: 'B200 · 180 GB', where: 'rented, about $6/h', tflops: 2250, vramGb: 180, usdPerHour: 6, maxCount: 8 },
  { id: 'apple-m3-max', label: 'Apple M3 Max · 128 GB unified', where: 'a laptop', tflops: 14, vramGb: 128, usdPerHour: 0, maxCount: 1 },
  { id: 'cpu', label: 'CPU only', where: 'no GPU', tflops: 1, vramGb: 0, usdPerHour: 0, maxCount: 1 },
];

export const gpuById = (id: string): Gpu => GPUS.find((gpu) => gpu.id === id) ?? GPUS[0];

/** The machine the reader has, as the page's picker sets it. */
export interface Hardware {
  gpu: string;
  count: number;
  /** System memory, in GB. */
  ramGb: number;
  /** Free disk, in GB. */
  diskGb: number;
  /**
   * Model FLOPs utilisation: the share of the peak that training actually
   * reaches. 0.3–0.5 is typical for a well-tuned transformer; small models and
   * small batches sit lower.
   */
  mfu: number;
  /** How many hours a day the machine is the reader's to use. */
  hoursPerDay: number;
}

export const DEFAULT_HARDWARE: Hardware = { gpu: 'colab-t4', count: 1, ramGb: 16, diskGb: 100, mfu: 0.35, hoursPerDay: 8 };

const HARDWARE_KEY = 'reader.implement.hardware';

export function readHardware(): Hardware {
  try {
    const stored = JSON.parse(localStorage.getItem(HARDWARE_KEY) ?? 'null') as Partial<Hardware> | null;
    if (stored && typeof stored === 'object') return normaliseHardware({ ...DEFAULT_HARDWARE, ...stored });
  } catch {
    // private mode, or nothing kept yet
  }
  return DEFAULT_HARDWARE;
}

export function writeHardware(hardware: Hardware) {
  try {
    localStorage.setItem(HARDWARE_KEY, JSON.stringify(hardware));
  } catch {
    // private mode
  }
}

export function normaliseHardware(raw: Hardware): Hardware {
  const gpu = gpuById(raw.gpu);
  const clamp = (value: number, low: number, high: number, fallback: number) => (Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback);
  return {
    gpu: gpu.id,
    count: clamp(Math.round(raw.count), 1, gpu.maxCount, 1),
    ramGb: clamp(raw.ramGb, 1, 4096, DEFAULT_HARDWARE.ramGb),
    diskGb: clamp(raw.diskGb, 1, 100_000, DEFAULT_HARDWARE.diskGb),
    mfu: clamp(raw.mfu, 0.05, 0.8, DEFAULT_HARDWARE.mfu),
    hoursPerDay: clamp(raw.hoursPerDay, 1, 24, DEFAULT_HARDWARE.hoursPerDay),
  };
}

// ---------------------------------------------------------------------------
// The work in a paper, as Claude writes it in a ```compute block
// ---------------------------------------------------------------------------

export interface Phase {
  name: string;
  /** Floating-point operations the phase takes, in total. */
  flops?: number;
  /** Or, for work that is not arithmetic-bound (evaluation, data processing): hours on one H100. */
  h100Hours?: number;
  /** Accelerator memory the phase needs, in GB, across all cards (the page splits it over them). */
  memoryGb?: number;
  /** Whether more cards make it faster (data-parallel training does; a serial script does not). */
  parallel?: boolean;
  /** One line on what the phase is. */
  note?: string;
}

export interface Compute {
  /** Model size, in billions of parameters, for the caption. */
  paramsB?: number;
  /** Tokens (or samples) the main phase runs over, in billions, for the caption. */
  tokensB?: number;
  phases: Phase[];
  /** Disk the datasets and checkpoints fill, in GB. */
  diskGb?: number;
  /** System memory needed, in GB (tokenising, loading the dataset, the teacher on CPU…). */
  ramGb?: number;
  /** Accelerator memory the smallest configuration needs, in GB, and how to get under it. */
  minVramGb?: number;
  shrink?: string;
}

const H100_TFLOPS = 989;

const num = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[_,\s]/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

/**
 * Reads a compute block. It is JSON, but Claude's, so a missing field is a
 * missing field and a number written as a string is still a number. Null
 * when it cannot be read at all — half streamed, or not JSON.
 */
export function parseCompute(text: string): Compute | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const phases = Array.isArray(raw.phases) ? raw.phases : [];
  const memory = raw.memory && typeof raw.memory === 'object' ? (raw.memory as Record<string, unknown>) : {};
  return {
    paramsB: num(raw.params_b ?? raw.paramsB),
    tokensB: num(raw.tokens_b ?? raw.tokensB),
    diskGb: num(raw.disk_gb ?? raw.diskGb),
    ramGb: num(raw.ram_gb ?? raw.ramGb ?? memory.ram_gb),
    minVramGb: num(raw.min_vram_gb ?? raw.minVramGb ?? memory.min_vram_gb),
    shrink: typeof (raw.shrink ?? memory.shrink) === 'string' ? String(raw.shrink ?? memory.shrink) : undefined,
    phases: phases
      .filter((phase): phase is Record<string, unknown> => Boolean(phase) && typeof phase === 'object')
      .map((phase) => ({
        name: String(phase.name ?? 'Phase'),
        flops: num(phase.flops),
        h100Hours: num(phase.h100_hours ?? phase.h100Hours),
        memoryGb: num(phase.memory_gb ?? phase.memoryGb),
        parallel: phase.parallel === undefined ? true : Boolean(phase.parallel),
        note: typeof phase.note === 'string' ? phase.note : undefined,
      })),
  };
}

// ---------------------------------------------------------------------------
// The sums
// ---------------------------------------------------------------------------

export type Fit = 'fits' | 'sharded' | 'tight' | 'no';

export interface PhaseEstimate {
  phase: Phase;
  /** Wall-clock hours on the reader's machine. */
  hours: number;
  /** What those hours cost, at the card's rate. */
  usd: number;
  /** Whether the phase's memory fits on the card, across the cards, only with tricks, or not at all. */
  fit: Fit;
}

export interface Estimate {
  hardware: Hardware;
  gpu: Gpu;
  phases: PhaseEstimate[];
  hours: number;
  usd: number;
  /** Calendar days at the reader's hours a day. */
  days: number;
  /** For Colab: how many sessions the longest phase spans, since a session cannot be resumed without a checkpoint. */
  sessions?: number;
  fit: Fit;
  disk: 'fits' | 'no' | 'unknown';
  ram: 'fits' | 'no' | 'unknown';
}

/** The effective rate of the reader's machine, in FLOPs a second. */
export const effectiveFlops = (gpu: Gpu, count: number, mfu: number) => gpu.tflops * 1e12 * mfu * count;

function fitOf(memoryGb: number | undefined, gpu: Gpu, count: number): Fit {
  if (memoryGb === undefined) return 'fits';
  if (gpu.vramGb === 0) return memoryGb > 0 ? 'no' : 'fits';
  if (memoryGb <= gpu.vramGb * 0.85) return 'fits';
  if (memoryGb <= gpu.vramGb * count * 0.85) return 'sharded';
  if (memoryGb <= gpu.vramGb * count * 1.6) return 'tight';
  return 'no';
}

const worst = (fits: Fit[]): Fit => (['no', 'tight', 'sharded', 'fits'] as Fit[]).find((fit) => fits.includes(fit)) ?? 'fits';

/** Hours, cost and fit for every phase, on this hardware. */
export function estimate(compute: Compute, hardware: Hardware): Estimate {
  const gpu = gpuById(hardware.gpu);
  const rate = effectiveFlops(gpu, 1, hardware.mfu);
  const phases = compute.phases.map((phase): PhaseEstimate => {
    const cards = phase.parallel === false ? 1 : hardware.count;
    let hours = 0;
    if (phase.flops !== undefined) hours = phase.flops / (rate * cards) / 3600;
    else if (phase.h100Hours !== undefined) hours = (phase.h100Hours * (H100_TFLOPS / gpu.tflops)) / cards;
    const fit = fitOf(phase.memoryGb, gpu, hardware.count);
    // Offloading and quantising cost time as well as effort.
    if (fit === 'tight') hours *= 2.5;
    return { phase, hours, usd: hours * gpu.usdPerHour * hardware.count, fit };
  });
  const hours = phases.reduce((sum, phase) => sum + phase.hours, 0);
  const usd = phases.reduce((sum, phase) => sum + phase.usd, 0);
  const longest = Math.max(0, ...phases.map((phase) => phase.hours));
  const fit = worst([...phases.map((phase) => phase.fit), fitOf(compute.minVramGb, gpu, hardware.count)]);
  return {
    hardware,
    gpu,
    phases,
    hours,
    usd,
    days: hours / hardware.hoursPerDay,
    sessions: gpu.sessionHours ? Math.max(1, Math.ceil(longest / gpu.sessionHours)) : undefined,
    fit,
    disk: compute.diskGb === undefined ? 'unknown' : compute.diskGb <= hardware.diskGb ? 'fits' : 'no',
    ram: compute.ramGb === undefined ? 'unknown' : compute.ramGb <= hardware.ramGb ? 'fits' : 'no',
  };
}

/** "40 min", "3.5 h", "2.1 days", "6 weeks": the nearest unit a person would say. */
export function hoursText(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return '—';
  if (hours < 1 / 60) return '< 1 min';
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours < 10 ? hours.toFixed(1).replace(/\.0$/, '') : Math.round(hours)} h`;
  const days = hours / 24;
  if (days < 14) return `${days.toFixed(1).replace(/\.0$/, '')} days`;
  const weeks = days / 7;
  if (weeks < 9) return `${weeks.toFixed(1).replace(/\.0$/, '')} weeks`;
  return `${(days / 30).toFixed(1).replace(/\.0$/, '')} months`;
}

export function usdText(usd: number): string {
  if (usd <= 0) return 'free';
  if (usd < 1) return `$${usd.toFixed(2)}`;
  if (usd < 100) return `$${usd.toFixed(0)}`;
  return `$${Math.round(usd).toLocaleString('en-US')}`;
}

/** "3e19" as a person reads it: "30 EFLOP" (exa), "1.2 PFLOP". */
export function flopsText(flops: number): string {
  const units: [number, string][] = [
    [1e21, 'ZFLOP'],
    [1e18, 'EFLOP'],
    [1e15, 'PFLOP'],
    [1e12, 'TFLOP'],
    [1e9, 'GFLOP'],
  ];
  for (const [size, unit] of units) if (flops >= size) return `${(flops / size).toPrecision(2).replace(/\.0$/, '')} ${unit}`;
  return `${flops.toPrecision(2)} FLOP`;
}

export const FIT_TEXT: Record<Fit, string> = {
  fits: 'Fits',
  sharded: 'Fits across cards',
  tight: 'Needs offloading',
  no: 'Does not fit',
};

/** The reader's machine in a sentence, for Claude and for the page. */
export function hardwareText(hardware: Hardware): string {
  const gpu = gpuById(hardware.gpu);
  const cards = gpu.id === 'cpu' ? 'no GPU' : `${hardware.count}× ${gpu.label} (${gpu.where}; ${gpu.tflops} TFLOPS bf16 dense each)`;
  return `${cards}, ${hardware.ramGb} GB RAM, ${hardware.diskGb} GB free disk, about ${hardware.hoursPerDay} h a day, assuming ${Math.round(hardware.mfu * 100)}% utilisation`;
}

/**
 * The catalogue entry nearest a card the proxy found on the reader's
 * machine, by name first — "NVIDIA GeForce RTX 4090" — then by memory
 * among the cards of that kind. Null for a card nothing here resembles.
 */
export function matchGpu(name: string, vramGb?: number): Gpu | null {
  const text = name.toLowerCase();
  const byName: [RegExp, string][] = [
    [/\bb200\b/, 'b200'],
    [/\bh200\b/, 'h200'],
    [/\bh100\b/, 'h100'],
    [/\ba100\b/, 'a100-80'],
    [/\b5090\b/, 'rtx-5090'],
    [/\b4090\b/, 'rtx-4090'],
    [/\b3090\b/, 'rtx-3090'],
    [/\bl4\b/, 'colab-l4'],
    [/\bt4\b/, 'colab-t4'],
    [/\bapple\b|\bm[1-4]\b/, 'apple-m3-max'],
  ];
  for (const [pattern, id] of byName) if (pattern.test(text)) return gpuById(id);
  if (vramGb === undefined) return null;
  // Unknown name: the desktop or rented card with the nearest memory.
  const candidates = GPUS.filter((gpu) => !gpu.colab && gpu.id !== 'cpu' && !gpu.id.startsWith('apple'));
  return candidates.reduce<Gpu | null>((best, gpu) => (!best || Math.abs(gpu.vramGb - vramGb) < Math.abs(best.vramGb - vramGb) ? gpu : best), null);
}
