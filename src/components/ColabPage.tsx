// The Colab tab: Colab's own notebook page, attached to the reader's runtime,
// inside the reader. Google's pages refuse to be shown in another site's
// frame, so the page is not framed: it is opened in the proxy's browser —
// the same headless Chromium the paper's copies sign in through — and its
// picture is shown here, with clicks, keys and scrolling sent back
// (BrowserPane.tsx). The runtime is the one the chip in the bar holds, so
// a variable set by a cell on the Explanation page is there in Colab's
// notebook, and the other way round. Without a proxy that has a browser,
// the tab says what it would show and what to set up, and links out.

import { useEffect, useState } from 'react';
import { browseStatus } from '../lib/browse';
import type { BrowseStatus } from '../lib/browse';
import { machineLabel } from '../lib/colab';
import { useStore } from '../lib/store';
import BrowserPane from './BrowserPane';
import type { PaneStage } from './BrowserPane';
import { attachUrl, ColabMark, useColab } from './Colab';

export const COLAB_HOME = 'https://colab.research.google.com/';

export default function ColabPage() {
  const colab = useColab();
  const { settings } = useStore();
  const [browse, setBrowse] = useState<BrowseStatus | null>(null);
  const [pane, setPane] = useState<{ stage: PaneStage; problem: string | null }>({ stage: 'opening', problem: null });
  const [where, setWhere] = useState<BrowseStatus | null>(null);
  useEffect(() => {
    let live = true;
    void browseStatus().then((answer) => {
      if (live) setBrowse(answer);
    });
    return () => {
      live = false;
    };
  }, []);
  const connected = (colab.status === 'idle' || colab.status === 'busy') && Boolean(colab.runtime);
  const runtime = connected ? colab.runtime : undefined;
  // Colab attached to the runtime while there is one; its front page while there is not.
  const url = runtime ? attachUrl(runtime.endpoint) : COLAB_HOME;
  const machine = runtime ? machineLabel(runtime) : machineLabel(colab.machine);
  const proxyHost = (() => {
    try {
      return new URL(settings.proxyBase || '/', window.location.href).host;
    } catch {
      return 'the proxy';
    }
  })();
  return (
    <div className="colab-page" role="region" aria-label="Colab, inside the reader">
      <div className="colab-page-head">
        <ColabMark />
        <div className="colab-page-what">
          <b>{runtime ? `Colab's notebook, on your ${machine} runtime` : 'Colab, inside the reader'}</b>
          <span>
            {runtime
              ? `Colab's own page attached to the runtime the chip holds — the same kernel the cells on the Explanation and Implementation pages run in, so what one sets the other sees. It is opened in the proxy's browser and shown here; what you do to it is done there, as you.`
              : `No runtime yet, so this is Colab's front page. Start a ${machine} runtime from the chip in the bar — or run a cell on the Explanation page — and this tab attaches Colab's notebook to it.`}
          </span>
        </div>
        <a className="btn sm" href={url} target="_blank" rel="noreferrer noopener" title="The same page in a tab of your own, signed in as you are there">
          Open in a new tab ↗
        </a>
      </div>
      {!browse ? (
        <p className="mini-browser-note">
          <span className="spinner" /> Asking the proxy whether it has a browser…
        </p>
      ) : !browse.available ? (
        <div className="colab-page-card">
          <h2>This tab needs the proxy's browser</h2>
          <p>
            Google does not let Colab's page be shown inside another site's frame, so the reader cannot simply embed it. What it can do is open the page in <b>the browser inside the reader</b> — the proxy's own headless Chromium, the one the paper's copies sign in
            through — and show its picture here, with your clicks, keys and scrolling sent back. That is what this tab is: Colab's notebook, attached to the runtime the chip holds, without leaving the paper.
          </p>
          <p className="colab-page-reason">
            <b>Not available on {proxyHost}:</b> {browse.reason || 'this proxy has no browser to drive.'}
          </p>
          <ul>
            <li>
              <b>The Node proxy</b> (<code>npm start</code>): run <code>npm install</code> there without <code>PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD</code>, or set <code>READER_BROWSER_CHANNEL=chrome</code> to use the Chrome it already has, and restart it.
            </li>
            <li>
              <b>The Cloudflare Worker</b>: bind Browser Rendering to it (<code>wrangler.toml</code>, the <code>BROWSER</code> binding) and redeploy.
            </li>
          </ul>
          <p>
            Until then, the runtime is one click away in a tab of your own:{' '}
            <a href={url} target="_blank" rel="noreferrer noopener">
              {runtime ? `open this runtime in Colab ↗` : 'open Colab ↗'}
            </a>
            .
          </p>
        </div>
      ) : (
        <BrowserPane
          key={url}
          url={url}
          onStage={(stage, problem) => setPane({ stage, problem })}
          onStatus={setWhere}
          actions={
            runtime ? (
              <span className="colab-page-runtime" title="The runtime this page is attached to">
                <span className="colab-dot is-on" aria-hidden="true" /> {machine} · {runtime.endpoint}
              </span>
            ) : null
          }
        />
      )}
      {browse?.available ? (
        <p className="colab-page-foot">
          {pane.stage === 'closed' && pane.problem ? (
            <span className="is-problem">{pane.problem}</span>
          ) : /accounts\.google\.com/.test(where?.url ?? '') ? (
            <span>
              Google is asking you to sign in, inside the pane. The sign-in is kept in the proxy's own browser profile, as a publisher's is, and Colab then opens as you.
            </span>
          ) : (
            <span>
              The first time, Google asks you to sign in inside the pane; the sign-in stays in the proxy's browser profile. Everything here is done as you, in your own Colab — Drive can be mounted from Colab's own menu, on purpose.
            </span>
          )}
        </p>
      ) : null}
    </div>
  );
}
