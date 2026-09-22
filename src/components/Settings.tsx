import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { BUILT_IN_BASE, checkProxy, hasProxy } from '../lib/api';
import { parseRepo } from '../lib/github';
import { prepare as prepareGoogle } from '../lib/google';
import { CheckIcon, CloseIcon, CloudCheckIcon, GoogleMark } from './icons';

export default function Settings({ onClose }: { onClose: () => void }) {
  const {
    settings,
    updateSettings,
    user,
    driveConnected,
    authError,
    signIn,
    connectDrive,
    signOut,
    syncAll,
    papers,
    syncLog,
    githubConnected,
    githubLog,
    githubPending,
    pushToGitHub,
  } = useStore();
  const [clientId, setClientId] = useState(settings.googleClientId);
  const [repo, setRepo] = useState(settings.githubRepo);
  const [branch, setBranch] = useState(settings.githubBranch);
  const [token, setToken] = useState(settings.githubToken);
  const [email, setEmail] = useState(settings.contactEmail);
  const [proxy, setProxy] = useState(settings.proxyBase);
  const [proxyCheck, setProxyCheck] = useState<{ ok: boolean; message: string } | null>(null);
  const [checking, setChecking] = useState(false);

  // Fetch Google's script while the sheet is being read, not inside the click
  // that needs it: a popup opened after an awaited download has lost the user
  // gesture that allows it, and the browser blocks it.
  useEffect(() => {
    if (settings.googleClientId.trim()) prepareGoogle();
  }, [settings.googleClientId]);

  const pending = syncLog.filter((entry) => entry.state === 'queued' || entry.state === 'running').length;
  const failed = syncLog.filter((entry) => entry.state === 'error');
  const synced = papers.filter((paper) => paper.drive?.syncedAt).length;
  const committed = papers.filter((paper) => paper.github?.syncedAt).length;
  const githubFailed = githubLog.filter((entry) => entry.state === 'error');
  const repoIsValid = !repo.trim() || Boolean(parseRepo(repo));

  return (
    <>
      <div className="scrim" onClick={onClose} role="presentation" />
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Settings">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flexGrow: 1 }}>
            <h2>Settings</h2>
            <p className="lede">
              Your library lives in this browser. Connect Google Drive to keep a copy of every paper you add,
              with its highlights, in your own Drive — and a Git repository to keep the notes and the
              bibliography under version control beside it.
            </p>
          </div>
          <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close settings">
            <CloseIcon size={18} />
          </button>
        </div>

        {authError ? (
          <p className="banner error" style={{ marginBottom: 16 }}>
            {authError}
          </p>
        ) : null}

        <section style={{ marginBottom: 22 }}>
          <div className="eyebrow" style={{ marginBottom: 10 }}>
            Google account
          </div>

          {user ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: 12,
                border: '1px solid var(--border)',
                borderRadius: 12,
                marginBottom: 12,
              }}
            >
              {user.picture ? (
                <img className="avatar" src={user.picture} alt="" />
              ) : (
                <span className="avatar-fallback" aria-hidden="true">
                  {user.name.slice(0, 1).toUpperCase()}
                </span>
              )}
              <div style={{ flexGrow: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{user.name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{user.email}</div>
              </div>
              <button type="button" className="btn sm" onClick={signOut}>
                Sign out
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn"
              onClick={() => void signIn()}
              style={{ marginBottom: 12, height: 40, padding: '0 16px', fontSize: 13.5 }}
            >
              <GoogleMark size={18} /> Sign in with Google
            </button>
          )}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: 12,
              border: '1px solid var(--border)',
              borderRadius: 12,
            }}
          >
            <CloudCheckIcon size={20} style={{ color: driveConnected ? 'var(--accent)' : 'var(--muted)' }} />
            <div style={{ flexGrow: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>
                {driveConnected ? 'Google Drive connected' : 'Google Drive not connected'}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                {driveConnected
                  ? `${synced} of ${papers.length} papers saved${pending ? ` · ${pending} in progress` : ''}`
                  : 'Grants access only to the files this app creates.'}
              </div>
            </div>
            {driveConnected ? (
              <button type="button" className="btn sm" onClick={syncAll}>
                Sync all
              </button>
            ) : (
              <button type="button" className="btn primary sm" onClick={() => void connectDrive()}>
                Connect Drive
              </button>
            )}
          </div>

          {failed.length ? (
            <p className="banner error" style={{ marginTop: 10 }}>
              {failed.length} paper{failed.length === 1 ? '' : 's'} failed to save. Most recent: {failed[0].message}
            </p>
          ) : null}
        </section>

        <section style={{ marginBottom: 22 }}>
          <div className="eyebrow" style={{ marginBottom: 10 }}>
            Where papers are stored
          </div>

          <label className="setting">
            <span>Drive folder</span>
            <input
              type="text"
              value={settings.driveFolderName}
              onChange={(event) => updateSettings({ driveFolderName: event.target.value })}
              placeholder="Paper Reader"
            />
            <small>
              A folder of this name is created at the top level of your Drive, with one sub-folder per
              collection. Because the app asks only for the <span className="mono">drive.file</span> scope, it can
              read and write the files it created and nothing else in your Drive.
            </small>
          </label>

          <div className="setting-row">
            <input
              id="auto-sync"
              type="checkbox"
              checked={settings.autoSync}
              onChange={(event) => updateSettings({ autoSync: event.target.checked })}
            />
            <label htmlFor="auto-sync" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
              <strong style={{ fontWeight: 500 }}>Save new papers automatically</strong>
              <br />
              <span style={{ color: 'var(--muted)' }}>
                Every paper added to a collection is uploaded, along with a JSON sidecar holding its metadata and
                your highlights. Editing a highlight re-uploads the sidecar.
              </span>
            </label>
          </div>

          <div className="setting-row">
            <input
              id="save-pdf"
              type="checkbox"
              checked={settings.savePdf}
              onChange={(event) => updateSettings({ savePdf: event.target.checked })}
            />
            <label htmlFor="save-pdf" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
              <strong style={{ fontWeight: 500 }}>Include the PDF</strong>
              <br />
              <span style={{ color: 'var(--muted)' }}>
                PDFs are fetched through the proxy — arXiv, or whichever repository OpenAlex, Unpaywall and
                Semantic Scholar point at. A paper with no free copy anywhere saves its metadata only.
              </span>
            </label>
          </div>

          <div className="setting-row">
            <input
              id="sync-on-open"
              type="checkbox"
              checked={settings.syncOnOpen}
              onChange={(event) => updateSettings({ syncOnOpen: event.target.checked })}
            />
            <label htmlFor="sync-on-open" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
              <strong style={{ fontWeight: 500 }}>Save a paper when I open it</strong>
              <br />
              <span style={{ color: 'var(--muted)' }}>
                Opening a paper that is not in Drive yet uploads it — the same copy the reader is showing, so it
                is one download rather than two. This is what catches the papers you collected before connecting
                Drive. Afterwards the reader opens that copy straight from Drive.
              </span>
            </label>
          </div>
        </section>

        <section style={{ marginBottom: 22 }}>
          <div className="eyebrow" style={{ marginBottom: 10 }}>
            Paper proxy
          </div>
          <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 }}>
            arXiv and the publishers send no CORS headers, so a browser cannot fetch a paper from them directly —
            a small proxy has to do it. On a static host (GitHub Pages) there is no server to run one, so deploy
            the Cloudflare Worker in <span className="mono">worker/</span> — <span className="mono">npx wrangler
            deploy</span>, free tier — and paste its address here. Without it, search still works through
            OpenAlex, Crossref and Semantic Scholar, but there are no PDFs to read or to save.
          </p>

          <label className="setting">
            <span className="vh">Proxy URL</span>
            <input
              type="url"
              value={proxy}
              onChange={(event) => {
                setProxy(event.target.value);
                setProxyCheck(null);
              }}
              onBlur={() => updateSettings({ proxyBase: proxy.trim() })}
              placeholder="https://reader-arxiv-proxy.you.workers.dev"
              spellCheck={false}
            />
            <small>
              {BUILT_IN_BASE
                ? `Leave it empty to use this deployment's own ${BUILT_IN_BASE}.`
                : 'This build has no proxy compiled in, so PDFs need one here.'}{' '}
              Kept in this browser. The Worker only answers origins listed in its{' '}
              <span className="mono">ALLOWED_ORIGINS</span>, so add this site's to it.
            </small>
          </label>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              className="btn sm"
              disabled={checking || !proxy.trim()}
              onClick={async () => {
                setChecking(true);
                updateSettings({ proxyBase: proxy.trim() });
                setProxyCheck(await checkProxy(proxy));
                setChecking(false);
              }}
            >
              {checking ? <span className="spinner" /> : null} Test it
            </button>
            {proxyCheck ? (
              <span
                style={{
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: proxyCheck.ok ? 'var(--accent)' : 'var(--danger)',
                }}
              >
                {proxyCheck.message}
              </span>
            ) : (
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {hasProxy() ? 'A proxy is configured.' : 'No proxy — PDFs are links out only.'}
              </span>
            )}
          </div>
        </section>


        <section style={{ marginBottom: 22 }}>
          <div className="eyebrow" style={{ marginBottom: 10 }}>
            Git mirror
          </div>
          <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 }}>
            Drive holds the PDFs; a repository holds everything that is text — a sidecar and a Markdown note
            per paper, an index, and a <span className="mono">references.bib</span> you can cite from. PDFs are
            deliberately <em>not</em> written here: a binary blob bloats a repository's history forever and
            gains nothing from being diffed.
          </p>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: 12,
              border: '1px solid var(--border)',
              borderRadius: 12,
              marginBottom: 12,
            }}
          >
            <CloudCheckIcon size={20} style={{ color: githubConnected ? 'var(--accent)' : 'var(--muted)' }} />
            <div style={{ flexGrow: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>
                {githubConnected ? `Mirroring to ${settings.githubRepo}` : 'No repository configured'}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                {githubConnected
                  ? `${committed} of ${papers.length} papers committed${githubPending ? ` · ${githubPending} waiting` : ''}`
                  : 'Add a repository and a token below.'}
              </div>
            </div>
            {githubConnected ? (
              <button type="button" className="btn sm" onClick={pushToGitHub}>
                Push all
              </button>
            ) : null}
          </div>

          <label className="setting">
            <span>Repository</span>
            <input
              type="text"
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
              onBlur={() => updateSettings({ githubRepo: repo.trim() })}
              placeholder="you/papers"
              aria-invalid={!repoIsValid}
            />
            <small>
              {repoIsValid
                ? 'owner/repo, or the full GitHub URL. It must already exist and have at least one commit — an empty repository has no branch to write to.'
                : 'That does not look like owner/repo or a GitHub URL.'}
            </small>
          </label>

          <label className="setting">
            <span>Branch</span>
            <input
              type="text"
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              onBlur={() => updateSettings({ githubBranch: branch.trim() || 'main' })}
              placeholder="main"
            />
          </label>

          <label className="setting">
            <span>Access token</span>
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              onBlur={() => updateSettings({ githubToken: token.trim() })}
              placeholder="github_pat_…"
              autoComplete="off"
            />
            <small>
              A <strong>fine-grained</strong> personal access token, scoped to this one repository, with
              Contents: read and write — and nothing else. It is kept in this browser's localStorage, which
              means any script that runs on this origin could read it: scope it narrowly, give it an expiry, and
              revoke it if you stop using this app. Prefer a private repository.
            </small>
          </label>

          <div className="setting-row">
            <input
              id="github-sync"
              type="checkbox"
              checked={settings.githubSync}
              onChange={(event) => updateSettings({ githubSync: event.target.checked })}
            />
            <label htmlFor="github-sync" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
              <strong style={{ fontWeight: 500 }}>Commit as I read</strong>
              <br />
              <span style={{ color: 'var(--muted)' }}>
                Adding a paper, writing a note or changing a tag is committed a few seconds later. Everything
                that changed in that window goes into one commit, so a reading session is a handful of commits
                rather than a hundred.
              </span>
            </label>
          </div>

          {githubFailed.length ? (
            <p className="banner error" style={{ marginTop: 10 }}>
              {githubFailed.length} paper{githubFailed.length === 1 ? '' : 's'} failed to commit. Most recent:{' '}
              {githubFailed[0].message}
            </p>
          ) : null}
        </section>

        <section style={{ marginBottom: 22 }}>
          <div className="eyebrow" style={{ marginBottom: 10 }}>
            Contact address
          </div>
          <label className="setting">
            <span className="vh">Contact email</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              onBlur={() => updateSettings({ contactEmail: email.trim() })}
              placeholder="you@example.com"
            />
            <small>
              Optional, and sent only to OpenAlex, Crossref and Unpaywall. The first two run a faster "polite
              pool" for requests that carry a way to reach you; Unpaywall — which finds free copies of papers
              the other indexes miss — refuses the request without one, so leaving this empty simply skips it.
            </small>
          </label>
        </section>

        <section style={{ marginBottom: 22 }}>
          <div className="eyebrow" style={{ marginBottom: 10 }}>
            Google OAuth client ID
          </div>
          <label className="setting">
            <span className="vh">Google OAuth client ID</span>
            <input
              type="text"
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              onBlur={() => updateSettings({ googleClientId: clientId.trim() })}
              placeholder="000000000000-xxxxxxxx.apps.googleusercontent.com"
            />
            <small>
              Create one in the Google Cloud Console under APIs &amp; Services → Credentials → OAuth client ID →
              Web application, enable the Google Drive API, and add this app's origin to the authorised JavaScript
              origins. Stored in this browser only.
            </small>
          </label>
          {settings.googleClientId ? (
            <p style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--accent)', margin: 0 }}>
              <CheckIcon size={14} /> A client ID is configured.
            </p>
          ) : null}
        </section>

        <section style={{ marginBottom: 22 }}>
          <div className="eyebrow" style={{ marginBottom: 10 }}>
            Reading
          </div>
          <div className="segmented" style={{ width: 'fit-content' }} role="group" aria-label="What a paper opens in">
            <button
              type="button"
              aria-pressed={settings.readingMode === 'pdf'}
              onClick={() => updateSettings({ readingMode: 'pdf' })}
            >
              PDF
            </button>
            <button
              type="button"
              aria-pressed={settings.readingMode === 'reflow'}
              onClick={() => updateSettings({ readingMode: 'reflow' })}
            >
              Reflow
            </button>
          </div>
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: '8px 0 0' }}>
            What a paper opens in. The PDF is the paper as it was published; Reflow is the text rendering, which is
            the one you can highlight. Either way the switch in the top bar changes a paper you already have open —
            and sets this.
          </p>
        </section>

        <section>
          <div className="eyebrow" style={{ marginBottom: 10 }}>
            Appearance
          </div>
          <div className="segmented" style={{ width: 'fit-content' }} role="group" aria-label="Theme">
            <button type="button" aria-pressed={settings.theme === 'light'} onClick={() => updateSettings({ theme: 'light' })}>
              Light
            </button>
            <button type="button" aria-pressed={settings.theme === 'dark'} onClick={() => updateSettings({ theme: 'dark' })}>
              Dark
            </button>
          </div>
        </section>
      </div>
    </>
  );
}
