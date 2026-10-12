// The Overleaf accounts connected to Reader's server: each one's Git token,
// given once, kept encrypted by the Worker for every project and device of
// this Reader account (worker/latex.js). A token opens the projects of its own
// Overleaf account and those shared with it, so a project in another Overleaf
// account needs that account connected too: each project syncs with whichever
// connected account opens it, and remembers it (OverleafLink.gitAccount).

import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { projectsOf } from '../lib/projects';
import { WriteGuideLink } from './WriteGuide';
import { overleafGitUrl } from '../lib/overleaf';
import { connectOverleaf, forgetOverleafToken, onOverleafAccounts, overleafAccounts, type OverleafAccount } from '../lib/overleafCloud';

/** Settings, at its Overleaf accounts (the app listens for this event: Projects.tsx's OPEN_SETTINGS). */
export function openOverleafAccounts() {
  window.dispatchEvent(new Event('reader:open-settings'));
  window.setTimeout(() => document.getElementById('settings-overleaf-accounts')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 150);
}

/** Which Overleaf account a project syncs through, as its overview says it, with the way to the accounts. */
export function SyncedThrough({ gitAccount }: { gitAccount?: string }) {
  const { driveConnected } = useStore();
  const accounts = useOverleafAccounts();
  if (!driveConnected || accounts === null) return null;
  const account = accounts.find((item) => item.id === gitAccount);
  return (
    <p className="ol-note ol-through">
      {account ? (
        <>
          Synced through your Overleaf account <b>{account.label}</b>.{' '}
        </>
      ) : accounts.length ? (
        <>Syncs through whichever of your {accounts.length === 1 ? 'connected Overleaf account' : `${accounts.length} connected Overleaf accounts`} can open it. </>
      ) : (
        <>No Overleaf account connected yet: connect it once, and every project syncs with it. </>
      )}
      <button type="button" className="link-btn" onClick={openOverleafAccounts}>
        {accounts.length ? 'Overleaf accounts' : 'Connect Overleaf'}
      </button>
    </p>
  );
}

/** The accounts connected, kept current on the page: null while asked. */
export function useOverleafAccounts(): OverleafAccount[] | null {
  const [accounts, setAccounts] = useState<OverleafAccount[] | null>(null);
  useEffect(() => {
    const stop = onOverleafAccounts(setAccounts);
    void overleafAccounts().catch(() => setAccounts([]));
    return stop;
  }, []);
  return accounts;
}

/**
 * The accounts, each removable, and the way to connect one: open at once when
 * there is none (or `open`), else behind "Connect another Overleaf account".
 * `onConnected` hears the new account's id, for whatever was waiting on it.
 */
export default function OverleafAccounts({ open = false, why, onConnected, current, onChoose, projectUrl }: { open?: boolean; why?: string; onConnected?: (id: string) => void; current?: string; /** For a project: the account it is to sync with, chosen — any it is shared with. */ onChoose?: (id: string) => void; /** The Overleaf project at hand, the token checked on it unless another is given. */ projectUrl?: string }) {
  const { collections, driveConnected } = useStore();
  const accounts = useOverleafAccounts();
  const [adding, setAdding] = useState(open);
  const [token, setToken] = useState('');
  const [label, setLabel] = useState('');
  const [check, setCheck] = useState(projectUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!driveConnected) return <p className="wr-quiet">Sign in with Google first: your Overleaf accounts are kept with your Reader account, for every device.</p>;
  if (accounts === null) return <p className="wr-quiet">Asking Reader’s server about your Overleaf accounts…</p>;
  const used = (id: string) => projectsOf(collections).filter((project) => project.project.overleaf?.gitAccount === id);
  const connect = async () => {
    const project = overleafGitUrl(check.trim());
    if (!project) return setProblem('Paste the link of one of this account’s Overleaf projects (https://www.overleaf.com/project/…): the token is tried on it, so a token from another account is caught.');
    setBusy(true);
    setProblem(null);
    try {
      const id = await connectOverleaf(token.trim(), label.trim(), project);
      setToken('');
      setLabel('');
      setCheck('');
      setAdding(false);
      onConnected?.(id);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const showForm = adding || open || !accounts.length;
  return (
    <div className="ol-accounts">
      {accounts.length ? (
        <ul className="ol-account-list" aria-label="Connected Overleaf accounts">
          {accounts.map((account) => {
            const projects = used(account.id);
            return (
              <li key={account.id} className={`ol-account${account.id === current ? ' is-current' : ''}`}>
                <span className="ol-account-mark" aria-hidden="true">
                  {account.label.trim().charAt(0).toUpperCase() || 'O'}
                </span>
                <span className="ol-account-text">
                  <b>{account.label}</b>
                  <small>
                    {account.id === current ? 'This project syncs with it · ' : ''}
                    {projects.length ? `${projects.length} project${projects.length === 1 ? '' : 's'}: ${projects.map((project) => project.name).slice(0, 3).join(', ')}${projects.length > 3 ? '…' : ''}` : 'No project synced with it yet'}
                  </small>
                </span>
                {onChoose && account.id !== current ? (
                  <button type="button" className="link-btn" onClick={() => onChoose(account.id)} title="For a project shared with this account too: its syncs go through this account (and show as it in Overleaf’s history)">
                    Sync with this one
                  </button>
                ) : null}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    if (!window.confirm(`Disconnect “${account.label}” from Reader? Its projects stop syncing until it is connected again. (To make its token useless everywhere, delete it in Overleaf too: Account Settings → Git integration.)`)) return;
                    void forgetOverleafToken(account.id);
                  }}
                >
                  Disconnect
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {why ? <p className="wr-bad">{why}</p> : null}
      {showForm ? (
        <div className="ol-connect">
          <b>{accounts.length ? 'Connect another Overleaf account' : 'Connect your Overleaf account'}</b>
          <p className="wr-quiet">
            Once, for every project and every device: in Overleaf, Account Settings → Git integration → Generate token, and paste it here. A token opens that account’s projects and the ones shared with it — for a project in another Overleaf account, connect that one too.
          </p>
          <label className="wr-field">
            <span>Which account (for you to tell them apart)</span>
            <input value={label} placeholder={accounts.length ? 'e.g. lab@university.edu' : 'e.g. you@university.edu'} onChange={(event) => setLabel(event.target.value)} aria-label="Which Overleaf account" />
          </label>
          <label className="wr-field">
            <span>Its Overleaf Git token</span>
            <input type="password" value={token} autoComplete="off" placeholder="olp_…" onChange={(event) => setToken(event.target.value)} aria-label="Overleaf Git token" />
            <small>Kept encrypted by Reader’s server, for your syncs only; never in a paper, in Drive, or in this browser. Overleaf’s Git integration needs a paid Overleaf plan.</small>
          </label>
          <label className="wr-field">
            <span>One of this account’s Overleaf projects, to check the token on</span>
            <input value={check} placeholder="https://www.overleaf.com/project/…" onChange={(event) => setCheck(event.target.value)} aria-label="An Overleaf project of this account" />
            <small>Overleaf doesn’t say which account a token belongs to, so Reader opens this project with it: a token from another account can’t, and isn’t kept. Pick one this account owns — a project only shared with it would pass too.</small>
          </label>
          <div className="wr-row">
            <button type="button" className="btn primary" disabled={busy || !token.trim() || !check.trim()} onClick={() => void connect()}>
              {busy ? 'Checking the token…' : 'Connect Overleaf'}
            </button>
            <a className="link-btn" href="https://www.overleaf.com/user/settings" target="_blank" rel="noopener noreferrer">
              Overleaf’s account settings ↗
            </a>
            <WriteGuideLink section="accounts">What is this?</WriteGuideLink>
            {accounts.length && !open ? (
              <button type="button" className="link-btn" onClick={() => setAdding(false)}>
                Cancel
              </button>
            ) : null}
          </div>
          {problem ? <p className="wr-bad">{problem}</p> : null}
        </div>
      ) : (
        <button type="button" className="link-btn" onClick={() => setAdding(true)}>
          + Connect another Overleaf account
        </button>
      )}
    </div>
  );
}
