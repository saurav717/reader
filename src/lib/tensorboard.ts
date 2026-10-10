// TensorBoard's scalars, read on the machine: the event files a run wrote
// under the project's folder (runs/, logs/, lightning_logs/ — wherever
// torch.utils.tensorboard's SummaryWriter, Keras or Lightning put them),
// read with TensorBoard's own reader in the runtime's small second kernel, and
// handed to the page as numbers to chart. Nothing is served from the machine,
// so it works on Colab, whose ports the page can't reach.

import { runQuietly } from './colab';

export interface TbRun {
  /** The run's folder, from the project's. */
  name: string;
  /** Each scalar tag: its points as [step, value], thinned to at most a few hundred. */
  scalars: Record<string, [number, number][]>;
  /** When the newest event file was written, in ms. */
  updated: number;
}

export interface TbRead {
  runs: TbRun[];
  /** Why there is nothing to show, when there isn't. */
  note?: string;
}

const CODE = (folder: string) => String.raw`
import os, json, glob, time
root = os.path.abspath(${JSON.stringify(folder)})
out = {'runs': [], 'note': None}
files = [f for f in glob.glob(os.path.join(root, '**', '*tfevents*'), recursive=True) if '/.git/' not in f][:400]
if not files:
    out['note'] = 'no-events'
else:
    try:
        from tensorboard.backend.event_processing.event_accumulator import EventAccumulator
        try:
            from tensorboard.util import tensor_util
        except Exception:
            tensor_util = None
    except Exception as error:
        EventAccumulator = None
        out['note'] = 'no-tensorboard'
    if EventAccumulator:
        dirs = sorted(set(os.path.dirname(f) for f in files))[:40]
        for d in dirs:
            ea = EventAccumulator(d, size_guidance={'scalars': 4000, 'tensors': 4000})
            ea.Reload()
            tags = ea.Tags()
            scalars = {}
            for tag in tags.get('scalars', []):
                scalars[tag] = [[e.step, float(e.value)] for e in ea.Scalars(tag)]
            if tensor_util:
                for tag in tags.get('tensors', []):
                    points = []
                    for e in ea.Tensors(tag):
                        try:
                            value = tensor_util.make_ndarray(e.tensor_proto)
                            if value.size == 1: points.append([e.step, float(value.reshape(-1)[0])])
                        except Exception:
                            pass
                    if points: scalars[tag] = points
            for tag, points in scalars.items():
                if len(points) > 400:
                    k = len(points) / 400.0
                    scalars[tag] = [points[int(i * k)] for i in range(400)] + [points[-1]]
            if scalars:
                newest = max(os.path.getmtime(f) for f in files if os.path.dirname(f) == d)
                out['runs'].append({'name': os.path.relpath(d, root), 'scalars': scalars, 'updated': newest * 1000})
print(json.dumps(out))
`;

/** The scalars of every run under the project's folder on the machine. */
export async function readTensorBoard(folder: string): Promise<TbRead> {
  const answer = await runQuietly(CODE(folder));
  if (!answer) throw new Error('The machine isn’t connected.');
  if (!answer.ok) throw new Error(answer.text.trim().split('\n').pop() || 'TensorBoard’s files couldn’t be read.');
  const raw = JSON.parse(answer.text.trim().split('\n').pop() || '{}') as { runs?: TbRun[]; note?: string | null };
  return { runs: raw.runs ?? [], note: raw.note ?? undefined };
}

/** The tags of every run, in the order TensorBoard groups them: by their prefix (train/, val/), then name. */
export function tagsOf(runs: TbRun[]): string[] {
  const all = new Set<string>();
  for (const run of runs) for (const tag of Object.keys(run.scalars)) all.add(tag);
  return [...all].sort((a, b) => {
    const [pa, pb] = [a.split('/')[0], b.split('/')[0]];
    return pa === pb ? a.localeCompare(b) : pa.localeCompare(pb);
  });
}
