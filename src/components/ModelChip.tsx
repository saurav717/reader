// ===========================================================================
//  Which model answers: a pill with the maker's mark and the model's name,
//  in the ask bars and under the Ask AI box. It opens a menu of every model
//  as cards — the one in use marked, the one that wrote the page noted,
//  those without a key greyed — the same cards the Rewrite menu shows, so
//  a model looks the same wherever it is chosen.
// ===========================================================================

import { useEffect, useRef, useState } from 'react';
import { MODELS, modelSpec, PROVIDERS } from '../lib/assistant';
import type { Provider } from '../lib/assistant';

/** A model's name without its maker: the mark on the pill already says who made it. */
export const shortModelName = (label: string) => label.replace(/^(Claude|Gemini|DeepSeek) /, '');

export default function ModelChip({
  value,
  writer,
  keys,
  disabled,
  onChange,
  what = 'Answers with',
  up = false,
  align = 'right',
  view = 'grid',
}: {
  /** The model in use. */
  value: string;
  /** The model that wrote the page the bar edits, when there is one: noted on its card. */
  writer?: string;
  keys: Record<string, unknown>;
  disabled?: boolean;
  onChange: (model: string) => void;
  /** The menu's heading: what choosing here decides. */
  what?: string;
  /** Open the menu above the pill — for a pill at the foot of a window. */
  up?: boolean;
  align?: 'left' | 'right';
  /** Cards in a grid, or a list by maker where there is less room. */
  view?: 'grid' | 'list';
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const chosen = modelSpec(value);
  const ready = Boolean(keys[chosen.provider]);
  const writerSpec = writer ? modelSpec(writer) : undefined;
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    // Esc closes this, not the page behind it.
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  const choose = (id: string) => {
    setOpen(false);
    onChange(id);
  };
  const tagsOf = (note: string) =>
    note.split(' · ').map((tag) => (
      <span key={tag} className="rw-tag">
        {tag}
      </span>
    ));
  const cardTitle = (m: (typeof MODELS)[number], can: boolean) => (can ? `Answer with ${m.label}` : `Add a ${PROVIDERS[m.provider].company} key in Settings to use ${m.label}`);
  return (
    <div className="menu-wrap model-chip-wrap" ref={box}>
      <button
        type="button"
        className={`model-chip p-${chosen.provider}${ready ? '' : ' is-keyless'}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((now) => !now)}
        title={`${chosen.label} answers here${writerSpec && writerSpec.id !== chosen.id ? ` — ${writerSpec.label} wrote the page` : ''}${ready ? '' : ` · needs a ${PROVIDERS[chosen.provider].company} key in Settings`} · click to choose another`}
      >
        <span className="rw-mark" aria-hidden="true">
          {PROVIDERS[chosen.provider].name.slice(0, 1)}
        </span>
        <span className="model-chip-name">{shortModelName(chosen.label)}</span>
        <span className="caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <div className={`menu rewrite-menu model-menu is-${view}${up ? ' up' : ''}${align === 'right' ? ' right' : ''}`} role="menu" aria-label={what}>
          <div className="rw-head">
            <span className="rw-head-text">
              <b>{what}</b>
              <span>{writerSpec ? `${writerSpec.label} wrote this page · any model with a key can answer for it` : 'Any model with a key · the conversation so far goes to it'}</span>
            </span>
          </div>
          {view === 'grid' ? (
            <div className="rw-grid">
              {MODELS.map((m) => {
                const isCurrent = m.id === chosen.id;
                const can = Boolean(keys[m.provider]);
                return (
                  <button key={m.id} type="button" role="menuitemradio" aria-checked={isCurrent} className={`rw-card p-${m.provider}${isCurrent ? ' is-current' : ''}`} disabled={!can} onClick={() => choose(m.id)} title={cardTitle(m, can)}>
                    <span className="rw-card-top">
                      <span className="rw-mark" aria-hidden="true">
                        {PROVIDERS[m.provider].name.slice(0, 1)}
                      </span>
                      <span className="rw-maker">{PROVIDERS[m.provider].company}</span>
                      {isCurrent ? (
                        <span className="rw-current" title="Answering now" aria-label="Answering now">
                          ✓
                        </span>
                      ) : m.id === writerSpec?.id ? (
                        <span className="rw-wrote" title="Wrote this page">
                          ✎
                        </span>
                      ) : null}
                    </span>
                    <b className="rw-name">{shortModelName(m.label)}</b>
                    <span className="rw-tags">{can ? tagsOf(m.note) : <span className="rw-tag rw-need">Needs a key</span>}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            (Object.keys(PROVIDERS) as Provider[]).map((provider) => {
              const models = MODELS.filter((m) => m.provider === provider);
              if (!models.length) return null;
              const can = Boolean(keys[provider]);
              return (
                <div key={provider} className={`rw-group p-${provider}`} role="group" aria-label={PROVIDERS[provider].company}>
                  <div className="rw-provider">
                    <span className="rw-mark" aria-hidden="true">
                      {PROVIDERS[provider].name.slice(0, 1)}
                    </span>
                    {PROVIDERS[provider].company}
                    {can ? null : <span className="rw-need">Needs a key</span>}
                  </div>
                  {models.map((m) => {
                    const isCurrent = m.id === chosen.id;
                    return (
                      <button key={m.id} type="button" role="menuitemradio" aria-checked={isCurrent} className={`rw-model${isCurrent ? ' is-current' : ''}`} disabled={!can} onClick={() => choose(m.id)} title={cardTitle(m, can)}>
                        <b className="rw-name">{shortModelName(m.label)}</b>
                        <span className="rw-tags">{tagsOf(m.note)}</span>
                        {isCurrent ? (
                          <span className="rw-current" title="Answering now">
                            ✓
                          </span>
                        ) : m.id === writerSpec?.id ? (
                          <span className="rw-wrote" title="Wrote this page">
                            ✎
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
