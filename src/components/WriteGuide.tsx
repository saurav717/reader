// The guide to the Write tab, on the site itself: where a paper is kept, the
// ways to start one, Overleaf accounts, the LaTeX projects page, the editor and its
// settings — each with what it does for you and when to pick it. Opened from
// wherever those choices are (WriteGuideLink), at the part about them.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type GuideSection = 'start' | 'where' | 'begin' | 'accounts' | 'documents' | 'editor' | 'settings' | 'questions';

const SECTIONS: { id: GuideSection; title: string }[] = [
  { id: 'start', title: 'Quick start' },
  { id: 'where', title: 'Where your paper is kept' },
  { id: 'begin', title: 'Starting a paper' },
  { id: 'accounts', title: 'Overleaf accounts' },
  { id: 'documents', title: 'LaTeX projects' },
  { id: 'editor', title: 'In the editor' },
  { id: 'settings', title: 'Your Write tab settings' },
  { id: 'questions', title: 'Questions' },
];

/** Settings, at its Overleaf accounts (the app listens for this event). */
function toAccounts(close: () => void) {
  close();
  window.dispatchEvent(new Event('reader:open-settings'));
  window.setTimeout(() => document.getElementById('settings-overleaf-accounts')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 150);
}

/** A "Guide" link that opens the guide at `section`. */
export function WriteGuideLink({ section = 'start', children = 'Guide', className = 'link-btn' }: { section?: GuideSection; children?: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`${className} wg-link`} onClick={() => setOpen(true)} title="What these choices do for you, and which to pick">
        <span className="wg-q" aria-hidden="true">
          ?
        </span>
        {children}
      </button>
      {open ? createPortal(<WriteGuide section={section} onClose={() => setOpen(false)} />, document.body) : null}
    </>
  );
}

function Choice({ name, tag, children, pick }: { name: string; tag?: string; children: ReactNode; pick: ReactNode }) {
  return (
    <div className="wg-choice">
      <b>
        {name}
        {tag ? <small>{tag}</small> : null}
      </b>
      <div className="wg-choice-body">{children}</div>
      <p className="wg-pick">
        <span>Pick it when</span> {pick}
      </p>
    </div>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="wg-steps">{children}</ol>;
}

/** The guide itself: its contents on the left, every part on the right. */
export default function WriteGuide({ section = 'start', onClose }: { section?: GuideSection; onClose: () => void }) {
  const body = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<GuideSection>(section);
  // The part being read, kept in sight in the contents (a row that scrolls sideways on a phone).
  useEffect(() => {
    document.querySelector('.wg-nav button.is-on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [at]);
  const go = (id: GuideSection, smooth = true) => {
    const target = body.current?.querySelector<HTMLElement>(`#wg-${id}`);
    if (target && body.current) body.current.scrollTo({ top: target.offsetTop - 12, behavior: smooth ? 'smooth' : 'auto' });
    setAt(id);
  };
  useEffect(() => {
    go(section, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // The part being read, marked in the contents.
  const onScroll = () => {
    const box = body.current;
    if (!box) return;
    let current: GuideSection = 'start';
    for (const item of SECTIONS) {
      const element = box.querySelector<HTMLElement>(`#wg-${item.id}`);
      if (element && element.offsetTop - 40 <= box.scrollTop) current = item.id;
    }
    setAt(current);
  };

  return (
    <>
      <div className="scrim" onClick={onClose} role="presentation" />
      <div className="sheet wg-sheet" role="dialog" aria-modal="true" aria-labelledby="wg-title">
        <nav className="wg-nav" aria-label="The guide’s parts">
          <span className="eyebrow">Guide</span>
          <h2 id="wg-title">Writing your paper</h2>
          <ul>
            {SECTIONS.map((item, index) => (
              <li key={item.id}>
                <button type="button" className={at === item.id ? 'is-on' : ''} aria-current={at === item.id ? 'true' : undefined} onClick={() => go(item.id)}>
                  <span>{index + 1}</span> {item.title}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="btn sm wg-close" onClick={onClose}>
            Close
          </button>
        </nav>

        <div className="wg-body" ref={body} onScroll={onScroll}>
          <section id="wg-start" className="wg-section">
            <h3>Quick start</h3>
            <p className="wg-lede">Most of the choices have a good default. If you only read one part, read this one.</p>
            <div className="wg-quick">
              <div>
                <span className="wg-num">1</span>
                <b>Connect Overleaf, once</b>
                <p>Only if you use Overleaf. It works for every project, on every device.</p>
                <button type="button" className="btn sm" onClick={() => toAccounts(onClose)}>
                  Open Overleaf accounts
                </button>
              </div>
              <div>
                <span className="wg-num">2</span>
                <b>Open a project’s Write tab</b>
                <p>Pick how its paper starts: from one of your Overleaf projects, or a fresh one.</p>
              </div>
              <div>
                <span className="wg-num">3</span>
                <b>Write</b>
                <p>It saves to your Google Drive, compiles the PDF on Cloud Run, and stays in step with Overleaf.</p>
              </div>
            </div>
            <div className="wg-flow" aria-label="Where your words go">
              <span className="wg-node">
                <b>You write</b>
                <small>in Reader, in the browser</small>
              </span>
              <span className="wg-arrow" aria-hidden="true">
                →
              </span>
              <span className="wg-node is-main">
                <b>Google Drive</b>
                <small>the paper’s home, in the project’s folder</small>
              </span>
              <span className="wg-arrow" aria-hidden="true">
                ⇄
              </span>
              <span className="wg-node">
                <b>Overleaf</b>
                <small>kept in step by Reader’s server, if linked</small>
              </span>
            </div>
            <p className="wg-note">The PDF is made on Cloud Run, with all of TeX Live: you don’t install anything.</p>
          </section>

          <section id="wg-where" className="wg-section">
            <h3>Where your paper is kept</h3>
            <p className="wg-lede">Every project has one paper home. You can change it later, without losing anything.</p>
            <div className="wg-choices">
              <Choice name="Google Drive" tag="default" pick="almost always. It’s the one to use unless you have a reason not to.">
                <p>
                  Saved in your Drive at <span className="mono">Papers_collection › Projects › your project › LaTeX</span>. Nothing is saved on your computer, and you see the same paper on any device where you
                  sign in with Google.
                </p>
              </Choice>
              <Choice name="This computer" tag="Overleaf projects only" pick="you need your own TeX installation, or want the files in a folder for other tools.">
                <p>A copy of the Overleaf project in a folder on each of your computers, set up once on each. It needs the Reader app (the Companion) running.</p>
              </Choice>
            </div>
            <div className="wg-how">
              <b>How to switch</b>
              <ul>
                <li>
                  In the Write tab, under the project’s name: <em>Keep on this computer instead</em>. What’s in Drive goes to Overleaf first, then you make the copy on the computer.
                </li>
                <li>
                  Back again: <em>Keep in Google Drive instead</em>. Your edits go to Overleaf, Drive is brought up to date, and the folder on the computer goes to the Trash.
                </li>
              </ul>
            </div>
            <p className="wg-note">Papers saved on a computer by earlier versions of Reader move into Drive by themselves; their old folders are removed once every file is safely in Drive. Dropbox folders are never touched.</p>
          </section>

          <section id="wg-begin" className="wg-section">
            <h3>Starting a paper</h3>
            <p className="wg-lede">A project with no paper yet opens on “Start this project’s paper”, with two choices.</p>
            <div className="wg-choices">
              <Choice name="From your Overleaf account" pick="the paper already exists in Overleaf, or coauthors write there.">
                <p>Pick one of your Overleaf projects. It comes into Drive and stays in step both ways: your edits show in Overleaf, theirs come into Reader.</p>
                <p className="wg-small">
                  Reader lists the Overleaf projects it already knows. For any other, open it in Overleaf, copy the address from the browser (<span className="mono">overleaf.com/project/…</span>) and paste it — Overleaf
                  doesn’t let other apps list your projects.
                </p>
              </Choice>
              <Choice name="Start without Overleaf" pick="it’s your own paper, or you don’t have a paid Overleaf plan.">
                <p>An empty paper in Drive. You choose how its first LaTeX project begins: blank, a conference template, or files you upload.</p>
              </Choice>
            </div>
            <div className="wg-how">
              <b>Put it on Overleaf later</b>
              <Steps>
                <li>
                  In Overleaf: <em>New Project → Blank Project</em>.
                </li>
                <li>Copy its address from the browser.</li>
                <li>
                  In the Write tab, click <em>Put it on Overleaf</em> (next to “not on Overleaf”) and paste it. Your files go into it, and from then on the two stay in step.
                </li>
              </Steps>
            </div>
          </section>

          <section id="wg-accounts" className="wg-section">
            <h3>Overleaf accounts</h3>
            <p className="wg-lede">Reader talks to Overleaf through Overleaf’s Git integration, with a token you make once per Overleaf account.</p>
            <div className="wg-how">
              <b>Connect an account</b>
              <Steps>
                <li>
                  In Overleaf: <em>Account Settings → Git integration → Generate token</em>. It starts with <span className="mono">olp_</span>.
                </li>
                <li>
                  In Reader: <em>Settings → Overleaf accounts</em> (or the form any Write tab shows when it needs one). Give the account a name you’ll recognise, like your email, paste the token, and paste the link of one of that account’s own Overleaf projects.
                </li>
                <li>Reader opens that project with the token before keeping it. Overleaf doesn’t say which account a token belongs to, so this is how a token from a different account is caught: it can’t open the project, and Reader says so.</li>
                <li>That’s it — every project, on every device, uses it.</li>
              </Steps>
              <button type="button" className="btn sm" onClick={() => toAccounts(onClose)}>
                Open Overleaf accounts
              </button>
            </div>
            <div className="wg-facts">
              <div>
                <b>Is it safe?</b>
                <p>The token is kept encrypted by Reader’s server, under your Google sign-in — never in a paper, in Drive, or in your browser. Disconnect removes it; delete it in Overleaf too to make it useless everywhere.</p>
              </div>
              <div>
                <b>More than one account</b>
                <p>A token opens its own account’s projects and those shared with it. For a project in another account (a lab account, say), connect that one too.</p>
              </div>
              <div>
                <b>No choosing per project</b>
                <p>Each sync tries the project’s usual account first, then your others, and remembers whichever worked.</p>
              </div>
            </div>
            <h4>Messages you might see</h4>
            <table className="wg-table">
              <thead>
                <tr>
                  <th>It says</th>
                  <th>What it means</th>
                  <th>What to do</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>“…can’t open this project”</td>
                  <td>None of your connected accounts has access to it.</td>
                  <td>Connect the account it’s in — the form is right there — and Reader carries on by itself.</td>
                </tr>
                <tr>
                  <td>“X can’t open this Overleaf project any more… synced through Y”</td>
                  <td>The project was unshared from X, or X’s token was revoked, so Reader used Y, which can.</td>
                  <td>Nothing. Reconnect X with a new token if you want it back.</td>
                </tr>
                <tr>
                  <td>“Overleaf’s Git isn’t answering right now”</td>
                  <td>Overleaf is down for a moment on its side. Nothing was lost.</td>
                  <td>Nothing: Reader tries again in a few minutes.</td>
                </tr>
              </tbody>
            </table>
            <div className="wg-how">
              <b>A project shared between two of your accounts</b>
              <p>
                Open the paper, click <em>Overleaf account</em> at the bottom right, then <em>Sync with this one</em> beside the account it should use. Your edits show as that account in Overleaf’s history.
              </p>
            </div>
          </section>

          <section id="wg-documents" className="wg-section">
            <h3>LaTeX projects</h3>
            <p className="wg-lede">What the Write tab opens on: the project’s LaTeX projects, and ways to start another. Each one makes one PDF, from a main .tex and the files it brings in — sections, a .bib, styles, figures — kept together in a folder. A project can hold several: the paper, a workshop version, a rebuttal. In the editor, the file list shows only the open one’s files; new files and uploads go in its folder.</p>
            <dl className="wg-list">
              <dt>Continue…</dt>
              <dd>Opens the LaTeX project you were last writing.</dd>
              <dt>On Overleaf, or not</dt>
              <dd>Each LaTeX project can have an Overleaf project of its own, or none. A new one starts off Overleaf — nothing to connect, nothing synced — until you press <em>Put on Overleaf</em> on its card: Reader makes the Overleaf project with its files in it (in the account signed in in this browser), and you paste that project’s address back once. A paper brought in from Overleaf keeps syncing as before.</dd>
              <dt>Compare with Overleaf</dt>
              <dd>On a LaTeX project that is on Overleaf (its card, or the editor’s status bar). On the left, every file: changed on both, only on this site, only on Overleaf, or the same. On the right, a file’s two versions side by side, as GitHub shows them. Keep this site’s version or Overleaf’s in total, for one file or all of them, or pick change by change — this site’s, Overleaf’s, or both. <em>PDFs</em> compiles any two of this site’s, Overleaf’s and the result as picked, and boxes what changed on each page. <em>Apply to both</em> makes the picked version the one on this site and on Overleaf.</dd>
              <dt>View in</dt>
              <dd>Under each LaTeX project: <em>Google Drive</em> opens its folder in Drive, <em>This computer</em> opens it in Finder or Explorer (a paper kept on the computer; Companion 0.13.0 or later), and <em>Overleaf</em> opens the Overleaf project it is in.</dd>
              <dt>Blank article</dt>
              <dd>A main.tex with a title and a first section, in a folder of its own; add sections, a .bib and figures as it grows.</dd>
              <dt>Browse templates</dt>
              <dd>Conference kits you saved before (NeurIPS, ICML, ACL…), kept in your Drive.</dd>
              <dt>Upload a template (.zip)</dt>
              <dd>The zip a conference gives out. Reader also keeps it as a template for next time.</dd>
              <dt>Upload LaTeX files</dt>
              <dd>A main .tex you already have, with its sections, .bib, style files and figures.</dd>
            </dl>
          </section>

          <section id="wg-editor" className="wg-section">
            <h3>In the editor</h3>
            <h4>Compile on — who turns the LaTeX into a PDF</h4>
            <div className="wg-choices is-four">
              <Choice name="Cloud Run" tag="best" pick="always, unless it’s down.">
                <p>All of TeX Live; the PDF in seconds, sending only what changed.</p>
              </Choice>
              <Choice name="GitHub Actions" pick="Cloud Run isn’t answering.">
                <p>The same result, in a minute or two.</p>
              </Choice>
              <Choice name="Overleaf" pick="you want Overleaf’s own PDF.">
                <p>The PDF is in Overleaf’s window, beside.</p>
              </Choice>
              <Choice name="This computer" pick="the paper is kept on this computer.">
                <p>Your own TeX, through the Reader app.</p>
              </Choice>
            </div>
            <dl className="wg-list">
              <dt>Sync</dt>
              <dd>Sends your edits to Overleaf and brings coauthors’ in now. It also happens by itself a few seconds after you stop typing.</dd>
              <dt>
                <span className="mono">&lt;&lt;&lt;&lt;&lt;&lt;&lt;</span> in a file
              </dt>
              <dd>You and a coauthor changed the same lines. Keep what should stay, delete the marks, and sync again.</dd>
              <dt>Open in Drive</dt>
              <dd>The paper’s folder in Google Drive (bottom left).</dd>
              <dt>Overleaf account</dt>
              <dd>Which account the paper syncs through, and the way to change it (bottom right).</dd>
            </dl>
          </section>

          <section id="wg-settings" className="wg-section">
            <h3>Your Write tab settings</h3>
            <p className="wg-lede">
              In <em>Settings → Projects → The Write tab</em>. They apply to every project.
            </p>
            <table className="wg-table">
              <thead>
                <tr>
                  <th>Setting</th>
                  <th>What it changes</th>
                  <th>Recommended</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Compile on</td>
                  <td>Who makes the PDF (above). For a paper in Drive, “This computer” means Cloud Run.</td>
                  <td>Cloud Run</td>
                </tr>
                <tr>
                  <td>Compile</td>
                  <td>When: as you type, when you press ⌘S, or only with Recompile.</td>
                  <td>As you type</td>
                </tr>
                <tr>
                  <td>On an error</td>
                  <td>Keep going (the PDF as far as TeX can, errors listed) or stop at the first.</td>
                  <td>Keep going</td>
                </tr>
                <tr>
                  <td>TeX</td>
                  <td>Which TeX program — only for papers kept on this computer.</td>
                  <td>Leave it</td>
                </tr>
                <tr>
                  <td>The PDF</td>
                  <td>Beside the source, under it, or in a tab of its own.</td>
                  <td>Beside</td>
                </tr>
                <tr>
                  <td>Sync with Overleaf</td>
                  <td>When: as you type, on ⌘S, or only with Sync.</td>
                  <td>As you type</td>
                </tr>
                <tr>
                  <td>Citations</td>
                  <td>A drawer of the project’s papers beside the files: click one to \cite it, its BibTeX added.</td>
                  <td>The drawer</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section id="wg-questions" className="wg-section">
            <h3>Questions</h3>
            <dl className="wg-faq">
              <dt>Do I need a paid Overleaf plan?</dt>
              <dd>Only to sync with Overleaf: its Git integration is a paid feature. Without one, start without Overleaf — everything else works.</dd>
              <dt>Why can’t Reader list my Overleaf projects?</dt>
              <dd>Overleaf doesn’t let other apps do that. Paste a project’s address once, and Reader remembers it.</dd>
              <dt>Is anything kept on my computer?</dt>
              <dd>Not for papers in Drive. Only if you choose “Keep on this computer” for a project.</dd>
              <dt>What if Overleaf or Cloud Run is down?</dt>
              <dd>Your writing is saved in Drive either way. Syncs are tried again by themselves; to compile meanwhile, switch Compile on to GitHub Actions.</dd>
              <dt>Can I still write in Overleaf directly?</dt>
              <dd>Yes — you and your coauthors can. What changes there comes into Reader at the next sync.</dd>
            </dl>
          </section>
        </div>
      </div>
    </>
  );
}
