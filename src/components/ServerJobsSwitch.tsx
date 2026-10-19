import { useEffect, useState } from 'react';
import { hasProxy } from '../lib/api';
import { serverJobs, setServerJobs } from '../lib/agentJobs';

/**
 * The owner's switch, on Usage → The site, for the agent's answers written on
 * the server (worker/agentJobs.js): on, a project the agent is writing goes on
 * being written when the person's connection drops, they reload or close the
 * page, or their sign-in lapses, and lands in the folder when they are back;
 * off, the page streams the answer itself, as before, and a lost connection
 * ends it. One choice for every visitor.
 */
export default function ServerJobsSwitch() {
  const [state, setState] = useState<{ enabled: boolean; available: boolean; stored: boolean } | null>(null);
  const [saving, setSaving] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void serverJobs(true).then((answer) => live && setState(answer));
    return () => {
      live = false;
    };
  }, []);

  const choose = async (enabled: boolean) => {
    setProblem(null);
    setSaving(enabled);
    const answer = await setServerJobs(enabled);
    setSaving(null);
    if (!answer.ok) return setProblem(answer.error);
    setState(await serverJobs());
  };

  const on = Boolean(state?.enabled);
  const option = (value: boolean, title: string, lines: string[]) => {
    const chosen = state !== null && on === value;
    return (
      <button type="button" className={`look-option${chosen ? ' is-on' : ''}`} aria-pressed={chosen} onClick={() => void choose(value)} disabled={saving !== null || state === null || (value && !state.available)}>
        <span className="look-option-text">
          <b>{title}</b>
          {lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
        <span className="look-state">{saving === value ? 'Setting…' : state === null ? 'Asking the proxy…' : chosen ? 'On for everyone' : 'Switch'}</span>
      </button>
    );
  };

  return (
    <div className="look-switch">
      <h3 style={{ margin: '12px 0 0', fontSize: 15 }}>The agent’s long answers</h3>
      <p className="look-lead">
        When the playground’s agent writes a project from a paper, the answer takes minutes. Written on the server, it goes on through a dropped connection, a reload, a closed page or a lapsed sign-in, and the files land in the project’s folder when the person opens it again in that browser. Answers on the site’s keys go on the tally as before; a person’s own key is held by the job only until the provider has answered. Claude Code and Codex are not affected: they already run on the project’s machine.
      </p>
      <div className="look-options">
        {option(true, 'On the server', ['The answer keeps being written when the page loses its connection or is closed, and is picked up where it was.', 'Kept for a day after it ends, then deleted.'])}
        {option(false, 'In the page', ['The page streams the answer from the provider itself, as before.', 'A lost connection or a closed page ends the answer.'])}
      </div>
      {problem ? <p className="banner error">{problem}</p> : null}
      {state && !state.available ? (
        <p className="banner warn">{hasProxy() ? 'The Worker has no AGENT_JOBS object bound, so answers are written in the page whatever is chosen here. Bind it in wrangler.toml (it is there from this release) and deploy.' : 'No proxy is set, so answers are written in the page.'}</p>
      ) : state && !state.stored ? (
        <p className="banner warn">The Worker has no SESSIONS namespace bound, so the switch can’t be kept: it stays on.</p>
      ) : null}
    </div>
  );
}
