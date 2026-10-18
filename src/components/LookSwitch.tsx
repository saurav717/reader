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
  const [reloadDue, setReloadDue] = useState(false);

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
    // This browser's own theme follows the look unless one was picked by hand, on the next load.
    try {
      const saved = JSON.parse(localStorage.getItem('reader.settings') || '{}') as { themeChosen?: boolean; theme?: string };
      if (!saved.themeChosen) {
        saved.theme = next === 'koios' ? 'koios' : 'dark';
        localStorage.setItem('reader.settings', JSON.stringify(saved));
        setReloadDue(true);
      }
    } catch {
      // Storage closed to us: the look still applies on the next load.
    }
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
        {option('koios', 'Koios', ['Offers the Koios theme beside Light and Dark, and makes it the default: the night, gold hairlines, the quiet chrome.', 'The armillary and one of the Titan’s lines where a page is empty.'])}
        {option('classic', 'Classic', ['Light and Dark only, as before Koios: grey dark mode, green accents, bold serif headings.', 'Anyone set to Koios reads in Dark until the look is switched back.'])}
      </div>
      {problem ? <p className="banner error">{problem}</p> : null}
      {reloadDue ? (
        <p className="banner" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span>Your own theme follows the look. Reload to see it, or pick one by hand in Settings → Appearance.</span>
          <button type="button" className="btn sm" onClick={() => window.location.reload()}>Reload</button>
        </p>
      ) : null}
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
