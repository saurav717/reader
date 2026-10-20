// The Playground's "A simulation" start: every simulator in the catalogue
// (src/lib/simulators.ts) by family, with what each needs of the machine;
// then one of its environments and a template to start from. What it hands
// back becomes a project (src/lib/simProject.ts), placed by the usual
// "Where should it run?" step.

import { useEffect, useMemo, useRef, useState } from 'react';
import { previewFor } from '../lib/simPreviews';
import type { SimEnv, SimFamily, Simulator, TemplateId } from '../lib/simulators';
import { FAMILIES, SIMULATORS, TEMPLATES, needsLine, templatesFor } from '../lib/simulators';
import { CloseIcon } from './icons';

export interface SimPick {
  sim: Simulator;
  env?: SimEnv;
  template: TemplateId;
}

const SPACES = { discrete: 'discrete actions', continuous: 'continuous actions', multi: 'mixed actions' };
const GPU = { no: 'none: any CPU does', helps: 'optional: faster on one', needs: 'yes: a GPU (T4 or better)', rtx: 'an NVIDIA RTX GPU' };

/** What the simulator (or the chosen environment) looks like: its clip, or a quiet box when there is none or it won't load. */
function Preview({ sim, env }: { sim: Simulator; env?: SimEnv }) {
  const preview = previewFor(sim.id, env?.id);
  const [failed, setFailed] = useState<string | null>(null);
  if (!preview || failed === preview.url) return <figure className="sim-preview is-missing">No preview for {sim.name}</figure>;
  const fail = () => setFailed(preview.url);
  return (
    <figure className="sim-preview">
      {preview.kind === 'video' ? (
        <video key={preview.url} src={preview.url} autoPlay muted loop playsInline onError={fail} />
      ) : (
        <img key={preview.url} src={preview.url} alt={`${env?.label ?? sim.name}, running`} loading="lazy" referrerPolicy="no-referrer" onError={fail} />
      )}
      {preview.credit ? (
        <figcaption>{preview.page ? <a href={preview.page} target="_blank" rel="noreferrer noopener">{preview.credit} ↗</a> : preview.credit}</figcaption>
      ) : null}
    </figure>
  );
}

/** The rest of what there is to know before picking it. */
function Facts({ sim, env }: { sim: Simulator; env?: SimEnv }) {
  const spaces = [...new Set(sim.envs.map((e) => e.space))].map((space) => SPACES[space]).join(', ');
  return (
    <dl className="sim-facts">
      <dt>Family</dt>
      <dd>{FAMILIES.find((f) => f.id === sim.family)?.label ?? sim.family}</dd>
      <dt>Environments</dt>
      <dd>
        {sim.envs.length} here · {spaces}
        {sim.envs.some((e) => e.pixels) ? ' · some from pixels' : ''}
        {sim.envs.some((e) => e.hand) ? ' · dexterous hands' : ''}
      </dd>
      {env ? (
        <>
          <dt>This one</dt>
          <dd>
            {SPACES[env.space]}
            {env.pixels ? ', image observations' : ''}
            {env.hand ? ', a dexterous hand' : ''}
          </dd>
        </>
      ) : null}
      <dt>GPU</dt>
      <dd>{GPU[sim.gpu]}</dd>
      <dt>Colab</dt>
      <dd>{sim.colab ? 'runs there as it comes' : 'no: a machine of your own'}</dd>
      <dt>Systems</dt>
      <dd>{sim.linux ? 'Linux only (no macOS)' : 'Linux, macOS, Windows'}</dd>
      <dt>Videos</dt>
      <dd>{sim.video ? 'recorded off-screen, shown in the Sim pane' : 'none: it doesn’t render off-screen'}</dd>
      <dt>Interface</dt>
      <dd>{sim.api === 'gymnasium' ? 'Gymnasium (reset / step)' : 'its own API'}</dd>
      <dt>Installs with</dt>
      <dd className="mono">{sim.install.join(' && ') || '—'}</dd>
    </dl>
  );
}

export default function SimPicker({ onClose, onPick }: { onClose: () => void; onPick: (pick: SimPick) => void }) {
  const [family, setFamily] = useState<SimFamily | 'all' | 'hands'>('all');
  const [query, setQuery] = useState('');
  const [colabOnly, setColabOnly] = useState(false);
  const [sim, setSim] = useState<Simulator | null>(null);
  const [envId, setEnvId] = useState<string | null>(null);
  const [template, setTemplate] = useState<TemplateId | null>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return SIMULATORS.filter((s) => (family === 'all' ? true : family === 'hands' ? s.envs.some((e) => e.hand) : s.family === family))
      .filter((s) => !colabOnly || s.colab)
      .filter((s) => !q || `${s.name} ${s.blurb} ${s.good} ${s.envs.map((e) => `${e.id} ${e.label}`).join(' ')}`.toLowerCase().includes(q));
  }, [family, query, colabOnly]);

  const env = sim ? sim.envs.find((e) => e.id === envId) ?? sim.envs[0] : undefined;
  const choices = sim ? templatesFor(sim, env) : [];
  const chosen = template && choices.includes(template) ? template : choices[0];

  const side = useRef<HTMLElement>(null);
  useEffect(() => side.current?.scrollTo({ top: 0 }), [sim?.id]);

  const choose = (next: Simulator) => {
    setSim(next);
    setEnvId(next.envs[0]?.id ?? null);
    setTemplate(null);
  };

  return (
    <div className="scrim pg-scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="sheet pg-sheet sim-picker" role="dialog" aria-label="Start a simulation">
        <header className="pg-sheet-head">
          <div>
            <span className="eyebrow">New project · simulation</span>
            <h2>What should it simulate?</h2>
            <p>A simulator, one of its environments, and a starting point. Every project logs its runs for the Sim pane, and its coding agents are told to do the same and to explain what they change.</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon size={17} />
          </button>
        </header>
        <div className="sim-picker-filters">
          <div className="sim-chips" role="radiogroup" aria-label="Family">
            {[{ id: 'all' as const, label: `All · ${SIMULATORS.length}` }, ...FAMILIES.map((f) => ({ id: f.id, label: f.label })), { id: 'hands' as const, label: 'Dexterous hands' }].map((f) => (
              <button key={f.id} type="button" role="radio" aria-checked={family === f.id} className={family === f.id ? 'is-on' : ''} onClick={() => setFamily(f.id)} title={FAMILIES.find((x) => x.id === f.id)?.text}>
                {f.label}
              </button>
            ))}
          </div>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search: humanoid, Atari, hand, driving…" aria-label="Search the simulators" />
          <label className="sim-picker-toggle">
            <input type="checkbox" checked={colabOnly} onChange={(event) => setColabOnly(event.target.checked)} /> Runs on Colab
          </label>
        </div>
        <div className="sim-picker-body">
          <div className="sim-picker-grid" role="listbox" aria-label="Simulators">
            {shown.map((s) => (
              <button key={s.id} type="button" role="option" aria-selected={sim?.id === s.id} className={`sim-card${sim?.id === s.id ? ' is-on' : ''}`} onClick={() => choose(s)}>
                <b>{s.name}</b>
                <span>{s.blurb}</span>
                <small className={`sim-needs is-${s.gpu}`}>{needsLine(s)}</small>
              </button>
            ))}
            {!shown.length ? <p className="pg-note">No simulator matches.</p> : null}
          </div>
          <aside className="sim-picker-side" ref={side}>
            {sim ? (
              <>
                <Preview sim={sim} env={env} />
                <h3>{sim.name}</h3>
                <p>{sim.good}</p>
                <p className="sim-picker-meta">
                  {needsLine(sim)} ·{' '}
                  <a href={sim.docs} target="_blank" rel="noreferrer noopener">
                    docs ↗
                  </a>
                </p>
                <Facts sim={sim} env={env} />
                {(sim.caveats ?? []).map((caveat) => (
                  <p key={caveat} className="pg-note">
                    {caveat}
                  </p>
                ))}
                <div className="rt-part-label">Environment</div>
                <div className="sim-picker-list" role="radiogroup" aria-label="Environment">
                  {sim.envs.map((e) => (
                    <label key={e.id} className={env?.id === e.id ? 'is-on' : ''}>
                      <input type="radio" checked={env?.id === e.id} onChange={() => setEnvId(e.id)} />
                      <span>
                        {e.label}
                        <small className="mono"> {e.id}</small>
                      </span>
                    </label>
                  ))}
                </div>
                <div className="rt-part-label">Start from</div>
                <div className="sim-picker-list" role="radiogroup" aria-label="Template">
                  {choices.map((id) => (
                    <label key={id} className={chosen === id ? 'is-on' : ''}>
                      <input type="radio" checked={chosen === id} onChange={() => setTemplate(id)} />
                      <span>
                        <b>{TEMPLATES[id].name}</b>
                        <small> {TEMPLATES[id].text}</small>
                      </span>
                    </label>
                  ))}
                </div>
                <button type="button" className="btn primary" disabled={!chosen} onClick={() => chosen && onPick({ sim, env, template: chosen })}>
                  Next: where it runs
                </button>
              </>
            ) : (
              <p className="pg-note">Pick a simulator. Each says what it needs: any CPU, a GPU, or an RTX GPU (Isaac Lab), and whether Colab will do.</p>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
