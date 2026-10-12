// The accounts a project's work goes out through, connected once on the
// projects board for every project: GitHub (its token, kept in this browser's
// settings as Git mirror's is) for the code, and Overleaf (an email and its
// Git token, kept by Reader's server) for the paper. And, in the workspace,
// the project's code to a GitHub repository: set up from the button itself
// when it has none.

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { createPrivateRepo, githubAccount, parseRepo, writableRepos, type RepoState } from '../lib/github';
import { codeRepoName, pushCode } from '../lib/codeGithub';
import { agoShort } from '../lib/writePlace';
import type { Playground } from '../lib/playground';
import type { Project } from '../lib/projects';
import OverleafAccounts, { useOverleafAccounts } from './OverleafAccounts';
import { CheckIcon, ChevronDownIcon, ExternalIcon } from './icons';

const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo&description=Reader';

/** Who the GitHub token in Settings is: null while asking, '' for none or one GitHub refuses. */
function useGitHubLogin(): { login: string | null; problem: string | null } {
  const { settings } = useStore();
  const token = settings.githubToken.trim();
  const [state, setState] = useState<{ login: string | null; problem: string | null }>({ login: token ? null : '', problem: null });
  useEffect(() => {
    if (!token) return setState({ login: '', problem: null });
    let live = true;
    setState({ login: null, problem: null });
    githubAccount(token).then(
      (account) => live && setState({ login: account.login, problem: null }),
      (error) => live && setState({ login: '', problem: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
  }, [token]);
  return state;
}

/** GitHub, connected with a token: checked with GitHub before it is kept. */
export function GitHubConnect({ compact = false }: { compact?: boolean }) {
  const { settings, updateSettings } = useStore();
  const { login, problem: refused } = useGitHubLogin();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const saved = settings.githubToken.trim();
  if (saved && login === null) return <p className="cx-quiet">Asking GitHub who this token is…</p>;
  if (saved && login)
    return (
      <div className="cx-account">
        <span className="cx-ok">
          <CheckIcon size={13} /> Connected as <b>{login}</b>
        </span>
        <button type="button" className="link-btn" onClick={() => updateSettings({ githubToken: '' })} title="Forget the token in this browser (revoke it on GitHub too, if you are done with it)">
          Disconnect
        </button>
      </div>
    );
  const connect = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await githubAccount(typed.trim());
      updateSettings({ githubToken: typed.trim() });
      setTyped('');
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cx-form">
      {!compact ? (
        <p className="cx-quiet">
          A personal access token with the <span className="mono">repo</span> scope (or a fine-grained one with Contents and Administration: read and write).{' '}
          <a href={TOKEN_URL} target="_blank" rel="noopener noreferrer">
            Make one on GitHub ↗
          </a>
        </p>
      ) : null}
      <div className="cx-row">
        <input type="password" value={typed} autoComplete="off" placeholder="ghp_… or github_pat_…" onChange={(event) => setTyped(event.target.value)} aria-label="GitHub token" />
        <button type="button" className="btn primary sm" disabled={busy || !typed.trim()} onClick={() => void connect()}>
          {busy ? 'Checking…' : 'Connect GitHub'}
        </button>
      </div>
      {compact ? (
        <a className="cx-quiet" href={TOKEN_URL} target="_blank" rel="noopener noreferrer">
          Make a token on GitHub ↗
        </a>
      ) : null}
      {problem || (saved && refused) ? <p className="cx-bad">{problem ?? refused}</p> : null}
      <p className="cx-quiet">Kept in this browser’s settings, with Git mirror’s: never in a project, a paper or Drive.</p>
    </div>
  );
}

/**
 * The board's Connections: GitHub and Overleaf, connected once for every
 * project — both optional. Reader works without either; each is there for
 * when the code or the paper should sync somewhere. Folded to a line of what
 * is connected until it is opened.
 */
export function ProjectConnections() {
  const { settings } = useStore();
  const { login } = useGitHubLogin();
  const overleaf = useOverleafAccounts();
  const github = Boolean(settings.githubToken.trim() && login);
  const [shown, setOpen] = useState(false);
  return (
    <section className={`cx-panel${shown ? ' is-open' : ''}`} aria-label="Connections">
      <button type="button" className="cx-head" aria-expanded={shown} onClick={() => setOpen(!shown)}>
        <span className="eyebrow">Connections</span>
        <span className={`cx-chip${github ? ' is-on' : ''}`}>GitHub{github ? ` · ${login}` : ' · not connected'}</span>
        <span className={`cx-chip${overleaf?.length ? ' is-on' : ''}`}>
          Overleaf{overleaf?.length ? ` · ${overleaf.map((account) => account.label).join(', ')}` : ' · not connected'}
        </span>
        <span className="cx-hint cx-optional">Optional — only to sync code to GitHub or a paper to Overleaf</span>
        <span style={{ flex: 1 }} />
        <span className="cx-hint">{shown ? 'Hide' : github || overleaf?.length ? 'Manage' : 'Connect…'}</span>
        <ChevronDownIcon size={14} style={{ transform: shown ? 'rotate(180deg)' : undefined }} />
      </button>
      {shown ? (
        <div className="cx-grid">
          <div className="cx-card">
            <b>
              GitHub <small className="cx-quiet">· optional</small>
            </b>
            <p className="cx-lede">For pushing a project’s code to a repository of yours from the workspace’s Sync to GitHub — made for it in a click, or one you have. Without it, the code stays where it is.</p>
            <GitHubConnect />
          </div>
          <div className="cx-card">
            <b>
              Overleaf <small className="cx-quiet">· optional</small>
            </b>
            <p className="cx-lede">For keeping a paper in step with Overleaf: your Overleaf email and its Git token, once, and the Write tab never asks again. Without it, papers are written and kept in Reader only.</p>
            <OverleafAccounts />
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The workspace's Sync to GitHub: the project's code as one commit to its
 * repository. With no GitHub connected, or no repository yet, the menu sets
 * them up: a private repository made for the code, or one of the account's.
 */
export function CodeGitHub({ project, code }: { project: Project; code: Playground | undefined }) {
  const { settings, updateCollection } = useStore();
  const token = settings.githubToken.trim();
  const repo = project.project.codeRepo;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [name, setName] = useState(() => codeRepoName(project.name));
  const [mine, setMine] = useState<RepoState[] | null>(null);
  const [picked, setPicked] = useState('');
  const [changing, setChanging] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => box.current && !box.current.contains(event.target as Node) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const choosing = Boolean(token && (!repo || changing));
  useEffect(() => {
    if (!open || !choosing || mine) return;
    writableRepos(token).then(setMine, () => setMine([]));
  }, [open, choosing, mine, token]);

  const setRepo = (next: { repo: string; branch: string }) =>
    updateCollection(project.id, (collection) => {
      const info = { ...project.project, ...(collection.project ?? {}) };
      return { project: { ...info, codeRepo: { ...next } } };
    });
  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setProblem(null);
    try {
      await work();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };
  const create = () =>
    run('Making the repository…', async () => {
      const made = await createPrivateRepo(token, name.trim(), `The code for ${project.name}, from Reader.`);
      await setRepo({ repo: made.fullName, branch: made.defaultBranch || 'main' });
      setChanging(false);
    });
  const use = () =>
    run('Linking…', async () => {
      const chosen = mine?.find((one) => one.fullName === picked);
      if (!chosen) throw new Error('Pick a repository first.');
      await setRepo({ repo: chosen.fullName, branch: chosen.defaultBranch || 'main' });
      setChanging(false);
    });
  const push = () =>
    run('Pushing…', async () => {
      if (!repo || !code) return;
      const parsed = parseRepo(repo.repo);
      if (!parsed) throw new Error('The repository’s name isn’t owner/name.');
      const done = await pushCode(code, { ...parsed, branch: repo.branch, token }, message.trim() || `Code from Reader: ${project.name}`, (at, of) => setBusy(`Reading the files… ${at} of ${of}`));
      setMessage('');
      await updateCollection(project.id, (collection) => {
        const info = { ...project.project, ...(collection.project ?? {}) };
        return { project: { ...info, codeRepo: { ...repo, pushedAt: new Date().toISOString(), commit: done.commit ?? repo.commit, files: done.files } } };
      });
    });

  const label = !repo ? 'Sync to GitHub' : repo.repo.split('/').pop();
  return (
    <div className="cx-gh" ref={box}>
      <button type="button" className={`btn sm cx-gh-btn${repo ? ' is-linked' : ''}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)} title={repo ? `The code goes to ${repo.repo} (${repo.branch})` : 'Push the project’s code to a GitHub repository'}>
        <GitHubMark /> {label}
        {repo?.pushedAt ? <small> · {agoShort(Date.parse(repo.pushedAt))}</small> : null}
        <ChevronDownIcon size={12} />
      </button>
      {open ? (
        <div className="cx-pop" role="dialog" aria-label="The code on GitHub">
          {!token ? (
            <>
              <b>Connect GitHub</b>
              <p className="cx-quiet">Once, for every project: then pick or make the repository for this one.</p>
              <GitHubConnect compact />
            </>
          ) : choosing ? (
            <>
              <b>{repo ? 'Another repository for the code' : 'Where should the code go?'}</b>
              <div className="cx-way">
                <span className="cx-way-title">Make a private repository</span>
                <div className="cx-row">
                  <input value={name} onChange={(event) => setName(event.target.value)} aria-label="New repository’s name" />
                  <button type="button" className="btn primary sm" disabled={Boolean(busy) || !name.trim()} onClick={() => void create()}>
                    Create
                  </button>
                </div>
              </div>
              <div className="cx-way">
                <span className="cx-way-title">Or use one of yours</span>
                <div className="cx-row">
                  <select value={picked} onChange={(event) => setPicked(event.target.value)} aria-label="One of your repositories" disabled={!mine?.length}>
                    <option value="">{mine === null ? 'Asking GitHub…' : mine.length ? 'Pick a repository' : 'None the token can write to'}</option>
                    {mine?.map((one) => (
                      <option key={one.fullName} value={one.fullName}>
                        {one.fullName}
                        {one.private ? ' (private)' : ''}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="btn sm" disabled={Boolean(busy) || !picked} onClick={() => void use()}>
                    Use
                  </button>
                </div>
              </div>
              {repo ? (
                <button type="button" className="link-btn" onClick={() => setChanging(false)}>
                  Keep {repo.repo}
                </button>
              ) : null}
            </>
          ) : repo ? (
            <>
              <div className="cx-pop-head">
                <b className="mono">{repo.repo}</b>
                <span className="cx-quiet">{repo.branch}</span>
                <span style={{ flex: 1 }} />
                <a className="link-btn" href={`https://github.com/${repo.repo}`} target="_blank" rel="noopener noreferrer">
                  <ExternalIcon size={12} /> GitHub
                </a>
              </div>
              <p className="cx-quiet">
                {repo.pushedAt ? `Last pushed ${agoShort(Date.parse(repo.pushedAt))}: ${repo.files ?? 0} files${repo.commit ? `, ${repo.commit.slice(0, 7)}` : ''}.` : 'Nothing pushed yet.'} Every text file of the code goes as one commit; the sync rules leave out data and checkpoints, and nothing is deleted on GitHub.
              </p>
              {code ? (
                <>
                  <input value={message} placeholder={`Code from Reader: ${project.name}`} onChange={(event) => setMessage(event.target.value)} aria-label="Commit message" />
                  <div className="cx-row">
                    <button type="button" className="btn primary sm" disabled={Boolean(busy)} onClick={() => void push()}>
                      Push to GitHub
                    </button>
                    <button type="button" className="link-btn" onClick={() => setChanging(true)}>
                      Change repository
                    </button>
                  </div>
                </>
              ) : (
                <p className="cx-quiet">Set up the project’s code first: then it can go here.</p>
              )}
            </>
          ) : null}
          {busy ? <p className="cx-quiet">{busy}</p> : null}
          {problem ? <p className="cx-bad">{problem}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function GitHubMark() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
