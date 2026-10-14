import { useState } from 'react';
import type { ReactNode } from 'react';
import { card, muted } from './AiUsage';
import { ChevronDownIcon, ChevronRightIcon, ExternalIcon } from './icons';
import type { ServiceGuide } from '../lib/usageGuide';

/**
 * The "About" panel at the top of each tab of the Usage page: what the
 * service does for Reader, its plan and limits and what happens past them,
 * what the numbers below mean, how to set it up, and where to manage it
 * (src/lib/usageGuide.ts). Open until it is closed, and remembered closed
 * per tab.
 */

const keyOf = (id: string) => `reader.usageGuide.${id}`;

function remembered(id: string): boolean {
  try {
    return window.localStorage.getItem(keyOf(id)) !== 'closed';
  } catch {
    return true;
  }
}

const heading = { fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ink-2)', margin: '0 0 8px' } as const;
const body = { fontSize: 13, lineHeight: 1.6 } as const;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ minWidth: 0 }}>
      <h4 style={heading}>{title}</h4>
      {children}
    </section>
  );
}

export default function UsageGuide({ guide }: { guide: ServiceGuide }) {
  const [open, setOpen] = useState(() => remembered(guide.id));
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      if (next) window.localStorage.removeItem(keyOf(guide.id));
      else window.localStorage.setItem(keyOf(guide.id), 'closed');
    } catch {
      // Not kept: it opens again next time.
    }
  };
  const cell = { padding: '7px 10px', borderTop: '1px solid var(--border-soft)', verticalAlign: 'top', textAlign: 'left' } as const;

  return (
    <div style={{ ...card, marginBottom: 18 }}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        style={{ all: 'unset', boxSizing: 'border-box', width: '100%', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'flex-start', padding: '14px 16px' }}
      >
        <span style={{ marginTop: 2, color: 'var(--muted)', flex: 'none' }}>{open ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}</span>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>About {guide.title}</span>
          <span style={{ display: 'block', ...body, color: 'var(--ink-2)', marginTop: 2 }}>{guide.summary}</span>
        </span>
        <span style={{ flexGrow: 1 }} />
        <span style={{ ...muted, fontSize: 12, flex: 'none', marginTop: 2 }}>{open ? 'Hide' : 'Show details'}</span>
      </button>

      {open ? (
        <div style={{ padding: '4px 16px 18px 40px', display: 'grid', gap: 20 }}>
          {guide.limits?.length ? (
            <Section title="Plan and limits">
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%', minWidth: 560 }}>
                  <thead>
                    <tr style={{ color: 'var(--muted)', fontSize: 12 }}>
                      <th style={{ ...cell, borderTop: 'none', fontWeight: 500 }}>What</th>
                      <th style={{ ...cell, borderTop: 'none', fontWeight: 500 }}>Allowance</th>
                      <th style={{ ...cell, borderTop: 'none', fontWeight: 500 }}>Past it</th>
                    </tr>
                  </thead>
                  <tbody>
                    {guide.limits.map((limit) => (
                      <tr key={limit.what}>
                        <td style={{ ...cell, fontWeight: 500, whiteSpace: 'nowrap' }}>{limit.what}</td>
                        <td style={{ ...cell, fontVariantNumeric: 'tabular-nums' }}>{limit.allowance}</td>
                        <td style={{ ...cell, color: 'var(--ink-2)' }}>{limit.past}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          ) : null}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: 20 }}>
            {guide.counters?.length ? (
              <Section title="What the numbers mean">
                <dl style={{ margin: 0, ...body }}>
                  {guide.counters.map((counter) => (
                    <div key={counter.name} style={{ marginBottom: 6 }}>
                      <dt style={{ display: 'inline', fontWeight: 500 }}>{counter.name}: </dt>
                      <dd style={{ display: 'inline', margin: 0, color: 'var(--ink-2)' }}>{counter.meaning}</dd>
                    </div>
                  ))}
                </dl>
              </Section>
            ) : null}
            {guide.notes?.length ? (
              <Section title="Good to know">
                <ul style={{ margin: 0, paddingLeft: 18, ...body, color: 'var(--ink-2)' }}>
                  {guide.notes.map((note) => (
                    <li key={note} style={{ marginBottom: 4 }}>
                      {note}
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: 20 }}>
            {guide.setup?.length ? (
              <Section title="Setting it up">
                <ol style={{ margin: 0, paddingLeft: 18, ...body, color: 'var(--ink-2)' }}>
                  {guide.setup.map((step) => (
                    <li key={step} style={{ marginBottom: 4 }}>
                      <Code text={step} />
                    </li>
                  ))}
                </ol>
              </Section>
            ) : null}
            {guide.links?.length ? (
              <Section title="Manage it">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {guide.links.map((link) => (
                    <a key={link.url} className="btn sm" href={link.url} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}>
                      {link.label}
                      <ExternalIcon size={12} />
                    </a>
                  ))}
                </div>
              </Section>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A step, with `backticked` parts as code. */
function Code({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, index) =>
        part.startsWith('`') && part.endsWith('`') ? (
          <code key={index} style={{ fontSize: 12, padding: '1px 5px', borderRadius: 5, background: 'var(--rail)', border: '1px solid var(--border-soft)', overflowWrap: 'anywhere' }}>
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}
