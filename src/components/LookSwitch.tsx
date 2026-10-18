import { useEffect, useState } from 'react';
import { apiFetch, hasProxy } from '../lib/api';
import { applyLook, currentLook, setSiteLook, type Look } from '../lib/look';
import { Armillary } from './Quiet';

/**
 * The owner's switch between the site's two looks, on Usage → The site:
 * Koios — the night, the gold, the Titan where a page is empty — or Classic,
 * the theme before it. The choice is kept on the Worker and reaches every
 * visitor on their next page load; this browser changes at once.
 */
export default function LookSwitch() {
  const [look, setLook] = useState<Look>(() => currentLook());
  const [kept, setKept] = useState<boolean | null>(null);
  const [saving, setSaving] = useState<Look | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!hasProxy()) {
      setKept(false);
      return;
    }
    let live = true;
    void apiFetch('/site/look')
      .then(async (response) => {
        if (!live || !response.ok) return;
        const body = (await response.json()) as { look?: Look; stored?: boolean };
        if (body.look === 'koios' || body.look === 'classic') {
          setLook(body.look);
          applyLook(body.look);
        }
        setKept(Boolean(body.stored));
      })
      .catch(() => live && setKept(false));
    return () => {
      live = false;
    };
  }, []);

  const choose = async (next: Look) => {
    setProblem(null);
    setSaving(next);
    const answer = await setSiteLook(next);
    setSaving(null);
    if (!answer.ok) {
      setProblem(answer.error);
      return;
    }
    setLook(next);
  };

  const option = (value: Look, title: string, lines: string[]) => (
    <button type="button" className={`look-option${look === value ? ' is-on' : ''}`} aria-pressed={look === value} onClick={() => void choose(value)} disabled={saving !== null}>
      <span className="look-swatch" data-look-swatch={value} aria-hidden="true">
        {value === 'koios' ? <Armillary size={34} /> : <span className="look-swatch-r">R</span>}
      </span>
      <span className="look-option-text">
        <b>{title}</b>
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </span>
      <span className="look-state">{saving === value ? 'Setting…' : look === value ? 'On for everyone' : 'Switch'}</span>
    </button>
  );

  return (
    <div className="look-switch">
      <p className="look-lead">
        One look for the whole site. Whichever you choose here is what every visitor gets on their next page load; this browser changes as you click. The loading screen and the sign-in stand either way: this is the app behind them.
      </p>
      <div className="look-options">
        {option('koios', 'Koios', ['Navy ground with the sky’s glow, gold hairlines and labels, headings in the light serif.', 'The armillary and one of the Titan’s lines where a page is empty.'])}
        {option('classic', 'Classic', ['The theme before Koios: grey dark mode, green accents, bold serif headings.', 'Plain notices where a page is empty.'])}
      </div>
      {problem ? <p className="banner error">{problem}</p> : null}
      {kept === false ? (
        <p className="banner warn">
          {hasProxy()
            ? 'The Worker has no SESSIONS namespace bound, so a choice made here is not kept for other visitors; it changes this browser only. Bind one in wrangler.toml to keep it.'
            : 'No proxy is set, so there is nowhere to keep the choice; it changes this browser only.'}
        </p>
      ) : null}
    </div>
  );
}
