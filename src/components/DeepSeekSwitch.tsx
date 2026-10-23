import { useEffect, useState } from 'react';
import { hasProxy } from '../lib/api';
import { checkSite } from '../lib/assistant';
import { setSiteDeepseek, siteDeepseek } from '../lib/siteDeepseek';
import type { DeepseekSwitch as SwitchState } from '../lib/siteDeepseek';

/**
 * The owner's switch, on Usage → The site, for DeepSeek as a whole
 * (worker/deepseekSwitch.js). Off — as it is until turned on — nothing on the
 * site goes to DeepSeek: not the chat, Explain or the ask bars, not the
 * agent's jobs, not the Scholar or contribution readers, and not a person's
 * own key; its models leave the pickers. DeepSeek's terms let it train on
 * what it is sent, and Google's data policy forbids passing it what came
 * through Google's APIs, so the switch is off while the app is verified with
 * Google. One choice for every visitor.
 */
export default function DeepSeekSwitch() {
  const [state, setState] = useState<SwitchState | null>(null);
  const [saving, setSaving] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void siteDeepseek(true).then((answer) => live && setState(answer));
    return () => {
      live = false;
    };
  }, []);

  const choose = async (enabled: boolean) => {
    setProblem(null);
    setSaving(enabled);
    const answer = await setSiteDeepseek(enabled);
    setSaving(null);
    if (!answer.ok) return setProblem(answer.error);
    setState(await siteDeepseek(true));
    // The pickers in this browser follow at once; everyone else's on their next /health.
    void checkSite();
  };

  const on = Boolean(state?.enabled);
  const option = (value: boolean, title: string, lines: string[]) => {
    const chosen = state !== null && on === value;
    return (
      <button type="button" className={`look-option${chosen ? ' is-on' : ''}`} aria-pressed={chosen} onClick={() => void choose(value)} disabled={saving !== null || state === null || !hasProxy()}>
        <span className="look-option-text">
          <b>{title}</b>
          {lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
        <span className="look-state">{saving === value ? 'Setting…' : state === null ? 'Asking the proxy…' : chosen ? (value ? 'On for everyone' : 'Off for everyone') : 'Switch'}</span>
      </button>
    );
  };

  return (
    <div className="look-switch">
      <h3 style={{ margin: '12px 0 0', fontSize: 15 }}>DeepSeek</h3>
      <p className="look-lead">
        Whether anything on the site may go to DeepSeek at all. DeepSeek’s terms let it train on what it is sent, and Google’s policy for the data its APIs hand over (Drive, Calendar, a signed-in account) does not allow passing that to a service which may; so it is off unless you turn it on here. Off, its models leave every picker, the relay and the agent’s jobs refuse it, the Scholar and contribution readers go without it, and a key of a person’s own is not used either. Claude and Gemini are not affected.
      </p>
      <div className="look-options">
        {option(false, 'Off', ['Nothing is sent to DeepSeek, on the site’s key or on anyone’s own.', 'The choice while the app is verified with Google.'])}
        {option(true, 'On', ['DeepSeek’s models are offered again, on the site’s key where there is one.', 'Mind Google’s Limited Use policy before turning it on.'])}
      </div>
      {problem ? <p className="banner error">{problem}</p> : null}
      {!hasProxy() ? (
        <p className="banner warn">No proxy is set, so there is nothing to switch: without one, DeepSeek is off.</p>
      ) : state && !state.stored ? (
        <p className="banner warn">The Worker has no SESSIONS namespace bound, so the switch can’t be kept: it stays off.</p>
      ) : null}
    </div>
  );
}
