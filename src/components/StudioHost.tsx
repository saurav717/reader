// The card a page shows for its Studio scene, and the Studio itself loaded
// only when the card — or the page's button — opens it: the 3-D stage and
// KaTeX are not part of what a page needs to be read.

import { lazy, Suspense, useMemo, useState } from 'react';
import type { ComponentProps } from 'react';
import type { Block } from '../lib/explain';
import { frameAtSlot } from '../lib/studio';
import { FrameCanvas, toneOf } from './StudioFrame';

export type StudioBlock = Extract<Block, { kind: 'studio' }>;

const Loaded = lazy(() => import('./Studio').then((m) => ({ default: m.Studio })));

export default function StudioHost(props: ComponentProps<typeof Loaded>) {
  return (
    <Suspense fallback={<div className="studio studio-loading">Opening the Studio…</div>}>
      <Loaded {...props} />
    </Suspense>
  );
}

/** The scene at rest in the page: its slots in a strip, what is carried, and the button that opens the Studio. */
export function StudioCard({ block, title, writer, kicker }: { block: StudioBlock; /** The section it is in, for the Studio's bar. */ title?: string; writer?: string; kicker?: string }) {
  const [open, setOpen] = useState(false);
  const spec = block.spec;
  const frames = useMemo(() => (spec ? spec.slots.map((_, i) => frameAtSlot(spec, i)) : []), [spec]);
  if (!spec) {
    return (
      <div className="studio-card is-empty">
        <div className="studio-card-head">
          <span className="studio-card-label">Studio</span>
          <span className="studio-card-title">{block.title || 'A scene for this page'}</span>
        </div>
        <p className="studio-card-note">{block.open ? `${writer ?? 'The model'} is writing the scene…` : `This scene could not be read as ${writer ?? 'the model'} wrote it. Ask for it again in the bar.`}</p>
      </div>
    );
  }
  const shown = spec.slots.length > 8 ? spec.slots.map((_, i) => i).filter((i) => i === 0 || i === spec.slots.length - 1 || i % Math.ceil(spec.slots.length / 7) === 0) : spec.slots.map((_, i) => i);
  return (
    <div className="studio-card">
      <div className="studio-card-head">
        <span className="studio-card-label">Studio</span>
        <span className="studio-card-title">{block.title || spec.state}</span>
        <button type="button" className="btn sm primary" onClick={() => setOpen(true)} title="Open the scene full screen: the slots in 3-D, the state carried from the first to the last, the equation of each step above">
          Open in Studio ⤢
        </button>
      </div>
      <div className="studio-card-strip" onClick={() => setOpen(true)} role="button" tabIndex={0} onKeyDown={(event) => event.key === 'Enter' && setOpen(true)} aria-label="Open the scene full screen">
        {shown.map((i) => (
          <div key={i} className="studio-card-slot">
            <FrameCanvas frame={frames[i]} tone={toneOf(spec)} label={`${spec.state} at ${spec.slots[i]}`} />
            <span className="studio-slot-label">{spec.slots[i]}</span>
          </div>
        ))}
      </div>
      <p className="studio-card-note">
        {spec.state}, one {spec.unit} at a time from {spec.slots[0]} to {spec.slots[spec.slots.length - 1]} · {spec.steps.length} steps
      </p>
      {open ? <StudioHost spec={spec} title={block.title || title || spec.state} kicker={kicker} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
