// ===========================================================================
//  Run it on Colab — the Implementation page's plan, as something a Colab
//  runtime of the reader's own runs from the page, step by step.
//
//  The page already knows the work in the plan (the compute block), the
//  machine it was planned for (hardware.ts), the starter files, the shell
//  cells that fetch the data and the Python cells that check it. This turns
//  them into: the budget on each of Colab's machines, so the reader can pick
//  the smallest that fits; the one cell that lays the repository out in the
//  runtime; and the steps to run, in order, each as a cell the kernel takes
//  exactly as shown. Pure functions, so the tests can check them; the panel
//  that draws them is src/components/Implement.tsx.
// ===========================================================================

import type { Accelerator } from './colab';
import type { Section } from './explain';
import { estimate, gpuById } from './hardware';
import type { Compute, Estimate, Fit, Hardware } from './hardware';
import { starterFiles } from './implement';

/**
 * Colab's machines as the runtime menu offers them, each with its entry in
 * the hardware catalogue (for the budget) and what a runtime on it usually
 * comes with. The RAM and the disk are what Colab hands out today, rounded;
 * once a runtime is connected the page measures them instead.
 */
export interface ColabMachine {
  accelerator: Accelerator;
  /** The catalogue's id, for `estimate`. */
  gpu: string;
  label: string;
  tier: string;
  /** System memory a runtime on it usually has, in GB. */
  ramGb: number;
  /** Free disk a runtime on it usually has, in GB. */
  diskGb: number;
}

export const COLAB_MACHINES: ColabMachine[] = [
  { accelerator: 'NONE', gpu: 'cpu', label: 'CPU only', tier: 'free', ramGb: 12.7, diskGb: 107 },
  { accelerator: 'T4', gpu: 'colab-t4', label: 'T4 · 16 GB', tier: 'free tier', ramGb: 12.7, diskGb: 78 },
  { accelerator: 'L4', gpu: 'colab-l4', label: 'L4 · 24 GB', tier: 'Colab Pro', ramGb: 53, diskGb: 78 },
  { accelerator: 'A100', gpu: 'colab-a100', label: 'A100 · 40 GB', tier: 'Colab Pro+', ramGb: 83, diskGb: 78 },
];

export const colabMachine = (accelerator: Accelerator | null | undefined): ColabMachine => COLAB_MACHINES.find((m) => m.accelerator === accelerator) ?? COLAB_MACHINES[0];

/** The Colab machine the hardware picker has picked, when it has picked one of Colab's. */
export const colabMachineOf = (hardware: Hardware): ColabMachine | null => COLAB_MACHINES.find((m) => m.gpu === hardware.gpu) ?? null;

export interface ColabChoice {
  machine: ColabMachine;
  est: Estimate;
  /** The smallest machine the plan fits on without tricks — or, when none does, the smallest it fits on with them. */
  recommended: boolean;
}

const RANK: Record<Fit, number> = { fits: 0, sharded: 0, tight: 1, no: 2 };

/** Every Colab machine with the budget worked out on it, one card each, and the one to pick marked. */
export function colabChoices(compute: Compute, hardware: Hardware): ColabChoice[] {
  const choices = COLAB_MACHINES.map((machine) => ({ machine, est: estimate(compute, { ...hardware, gpu: machine.gpu, count: 1 }), recommended: false }));
  const best = Math.min(...choices.map((choice) => RANK[choice.est.fit]));
  const pick = best < 2 ? choices.find((choice) => RANK[choice.est.fit] === best) : undefined;
  if (pick) pick.recommended = true;
  return choices;
}

// ---------------------------------------------------------------------------
// What the plan needs, against what the machine has
// ---------------------------------------------------------------------------

export interface Need {
  id: 'vram' | 'ram' | 'disk' | 'time';
  label: string;
  /** What the plan needs, in the unit. */
  needed?: number;
  /** What the machine has, in the unit; measured when the runtime said so. */
  have?: number;
  unit: string;
  measured: boolean;
  fit: Fit;
  note: string;
}

/**
 * The plan's needs against a Colab machine: the card's memory, the system's,
 * the disk and the session. `measured` is what the runtime's probe read —
 * the card by name, the RAM, the disk free — and stands in for the
 * catalogue's numbers when it is there.
 */
export function needsOn(compute: Compute, choice: ColabChoice, measured?: { vramMb?: number; ramTotalMb?: number; diskFreeGb?: number }): Need[] {
  const gpu = gpuById(choice.machine.gpu);
  const vramNeeded = compute.minVramGb ?? (Math.max(0, ...compute.phases.map((phase) => phase.memoryGb ?? 0)) || undefined);
  const vramHave = measured?.vramMb ? Math.round((measured.vramMb / 1024) * 10) / 10 : gpu.vramGb;
  const ramHave = measured?.ramTotalMb ? Math.round((measured.ramTotalMb / 1024) * 10) / 10 : choice.machine.ramGb;
  const diskHave = measured?.diskFreeGb ?? choice.machine.diskGb;
  const simple = (needed: number | undefined, have: number): Fit => (needed === undefined ? 'fits' : needed <= have ? 'fits' : 'no');
  const sessions = choice.est.sessions ?? 1;
  return [
    {
      id: 'vram',
      label: 'Accelerator memory',
      needed: vramNeeded,
      have: vramHave,
      unit: 'GB',
      measured: Boolean(measured?.vramMb),
      fit: choice.est.fit,
      note:
        gpu.id === 'cpu'
          ? 'No GPU on this machine: only the smallest experiments are practical'
          : choice.est.fit === 'tight' && compute.shrink
            ? `To get it under: ${compute.shrink}`
            : choice.est.fit === 'no'
              ? `More than the card holds${compute.shrink ? ` — ${compute.shrink}` : ''}`
              : vramNeeded !== undefined
                ? `${vramNeeded} GB of ${vramHave} GB, with room for the activations`
                : 'The plan does not say how much',
    },
    {
      id: 'ram',
      label: 'RAM',
      needed: compute.ramGb,
      have: ramHave,
      unit: 'GB',
      measured: Boolean(measured?.ramTotalMb),
      fit: simple(compute.ramGb, ramHave),
      note: simple(compute.ramGb, ramHave) === 'no' ? 'A high-RAM runtime, from the runtime menu, has about four times this' : measured?.ramTotalMb ? 'Measured on the runtime' : 'What Colab usually gives this machine; measured once connected',
    },
    {
      id: 'disk',
      label: 'Disk',
      needed: compute.diskGb,
      have: diskHave,
      unit: 'GB',
      measured: measured?.diskFreeGb !== undefined,
      fit: simple(compute.diskGb, diskHave),
      note: simple(compute.diskGb, diskHave) === 'no' ? 'Stream the dataset, or keep the checkpoints in Drive' : measured?.diskFreeGb !== undefined ? 'Free on the runtime now' : 'Free on a fresh runtime, usually; measured once connected',
    },
    {
      id: 'time',
      label: 'Sessions',
      needed: sessions,
      have: 1,
      unit: '',
      measured: false,
      fit: sessions > 1 ? 'tight' : 'fits',
      note: gpu.sessionHours ? `${sessions === 1 ? 'One session' : `${sessions} sessions`} of up to ${gpu.sessionHours} h${sessions > 1 ? ' — checkpoint to Drive between them, and the runtime menu starts the next' : ''}` : 'Colab ends an idle runtime by itself',
    },
  ];
}

// ---------------------------------------------------------------------------
// The steps: cells the kernel takes exactly as shown
// ---------------------------------------------------------------------------

/** A JSON string is a Python string literal too, escape for escape. */
const py = (text: string) => JSON.stringify(text);

/**
 * The one cell that lays the repository out in the runtime: the directories,
 * then every starter file from the plan, written as it is shown on the page.
 * Null when the plan has no starter files yet.
 */
export function scaffoldCell(sections: Section[]): string | null {
  const files = starterFiles(sections);
  const paths = Object.keys(files);
  if (!paths.length) return null;
  const entries = paths.map((path) => `    ${py(path)}: ${py(files[path])},`).join('\n');
  return `# Lay the repository out here: the starter files from the plan, exactly as shown on the page.
import os
FILES = {
${entries}
}
for path, text in FILES.items():
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as f:
        f.write(text)
print("\\n".join(f"wrote {p} ({len(t.splitlines())} lines)" for p, t in FILES.items()))
print(f"{len(FILES)} files in {os.getcwd()}")
`;
}

/** A shell cell as the kernel runs it: a bash cell, so `cd` and `&&` mean what they do in a shell. */
export const shellCell = (code: string) => `%%bash\n${code.trim()}\n`;

export type StepKind = 'scaffold' | 'shell' | 'make' | 'python';

export interface ColabStep {
  kind: StepKind;
  title: string;
  /** One line on what the step does, for the list. */
  note: string;
  /** The code the kernel takes, exactly. */
  code: string;
}

const MAKE_SKIP = new Set(['all', 'clean', 'help', 'test', 'lint', 'format', 'install']);

/**
 * The steps, in the order to run them: the repository laid out, the plan's
 * shell cells (the data, the installs), the Makefile's targets that do work,
 * then the plan's Python cells. Each is a cell; nothing runs without a click
 * on it, and Run all asks first.
 */
export function colabSteps(sections: Section[]): ColabStep[] {
  const steps: ColabStep[] = [];
  const scaffold = scaffoldCell(sections);
  if (scaffold) {
    const count = Object.keys(starterFiles(sections)).length;
    steps.push({ kind: 'scaffold', title: 'Lay the repository out', note: `Writes the ${count} starter ${count === 1 ? 'file' : 'files'} into the runtime's disk, as shown on the page`, code: scaffold });
  }
  const python: ColabStep[] = [];
  const make: ColabStep[] = [];
  for (const section of sections)
    for (const block of section.blocks) {
      if (block.kind === 'prose' || block.kind === 'caveat' || block.open) continue;
      if (block.kind === 'code' && block.lang === 'bash') steps.push({ kind: 'shell', title: block.title || 'Shell', note: `From “${section.title}” — runs in bash`, code: shellCell(block.code) });
      else if (block.kind === 'code' && block.lang === 'python') python.push({ kind: 'python', title: block.title || 'Python', note: `From “${section.title}”`, code: block.code });
      else if (block.kind === 'file' && /(^|\/)Makefile$/.test(block.path))
        for (const match of block.code.matchAll(/^([a-z][\w-]*):(?!=)/gm))
          if (!MAKE_SKIP.has(match[1]) && !make.some((step) => step.title === `make ${match[1]}`)) make.push({ kind: 'make', title: `make ${match[1]}`, note: `A target of the plan's Makefile`, code: shellCell(`make ${match[1]}`) });
    }
  return [...steps, ...make.slice(0, 6), ...python];
}
