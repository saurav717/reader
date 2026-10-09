// Settings → This computer: each Companion this browser is paired with, its
// version, and Update when the site serves a newer one. The Companion installs
// it itself, refreshes the VS Code extension, and starts again
// (/companion/update in companion/reader_companion/extension.py).

import { useEffect, useState } from 'react';
import type { CompanionInfo } from '../lib/companion';
import type { JupyterServer } from '../lib/colab';
import { COMPANION_VERSION, companionPort, findCompanion, findLocalCompanion, isNewer, normaliseCode, pairCompanion, showCompanionCode, startCompanion, updateCompanion, waitForVersion } from '../lib/companion';
import { saveCompanion, useServers } from '../lib/playground';
import { isCompanion } from './VsCodeExtension';

/** The first Companion that can update itself: an older one is updated once the way it was installed. */
const SELF_UPDATING = '0.5.0';

type Row = { state: 'looking' } | { state: 'manual'; version: string } | { state: 'offline' } | { state: 'starting' } | { state: 'unstarted' } | { state: 'current'; version: string } | { state: 'old'; version: string } | { state: 'updating'; version: string; to?: string } | { state: 'updated'; version: string } | { state: 'failed'; version: string; error: string };

function CompanionRow({ server }: { server: JupyterServer }) {
  const [row, setRow] = useState<Row>({ state: 'looking' });
  useEffect(() => {
    let live = true;
    void findCompanion(server.url, 3000).then((info) => {
      if (!live) return;
      if (!info) setRow({ state: 'offline' });
      else if (isNewer(SELF_UPDATING, info.version)) setRow({ state: 'manual', version: info.version });
      else setRow({ state: isNewer(COMPANION_VERSION, info.version) ? 'old' : 'current', version: info.version });
    });
    return () => {
      live = false;
    };
  }, [server.url]);
  const start = async () => {
    setRow({ state: 'starting' });
    const info = await startCompanion(server.url);
    if (!info) return setRow({ state: 'unstarted' });
    setRow({ state: isNewer(COMPANION_VERSION, info.version) ? 'old' : 'current', version: info.version });
  };
  const update = async () => {
    if (!('version' in row)) return;
    const from = row.version;
    setRow({ state: 'updating', version: from });
    try {
      const { version, updated } = await updateCompanion(server);
      if (!updated) return setRow({ state: 'current', version });
      setRow({ state: 'updating', version: from, to: version });
      const back = await waitForVersion(server.url, version);
      setRow(back ? { state: 'updated', version: back.version } : { state: 'failed', version: from, error: 'It installed the update but hasn’t answered since. Open the Reader app to start it.' });
    } catch (error) {
      setRow({ state: 'failed', version: from, error: error instanceof Error ? error.message : String(error) });
    }
  };
  return (
    <div className="companion-update">
      <div>
        <b>{server.name}</b>
        <small>
          {row.state === 'looking'
            ? 'Looking…'
            : row.state === 'offline'
              ? 'Not running (shut down, or the computer is off). Start starts it, through the Reader app.'
              : row.state === 'starting'
                ? 'Starting… your browser may ask whether to open Reader Companion.'
              : row.state === 'unstarted'
                ? 'It didn’t start from here. Open the Reader app on it, or run reader-companion start in a terminal there.'
              : row.state === 'manual'
                ? `Companion ${row.version}, from before it could update itself. Update it once the way you installed it (the Reader app's .dmg, or the line on the Playground's Connect this computer card); from then on, Update here does it.`
                : row.state === 'current'
                ? `Companion ${row.version}: up to date.`
                : row.state === 'old'
                  ? `Companion ${row.version}. ${COMPANION_VERSION} is out.`
                  : row.state === 'updating'
                    ? row.to
                      ? `Installed ${row.to}; starting it again…`
                      : `Updating from ${row.version}: downloading and installing, a minute at most…`
                    : row.state === 'updated'
                      ? `Updated to ${row.version}, and running.`
                      : `Companion ${row.version}. ${row.error}`}
        </small>
      </div>
      {row.state === 'old' || row.state === 'failed' ? (
        <button type="button" className="btn sm primary" onClick={() => void update()}>
          {row.state === 'failed' ? 'Try again' : 'Update'}
        </button>
      ) : (row.state === 'offline' || row.state === 'unstarted') && server.where === 'pc' && companionPort(server.url) !== null ? (
        <button type="button" className="btn sm" onClick={() => void start()}>
          Start
        </button>
      ) : row.state === 'updating' || row.state === 'starting' ? (
        <span className="spinner" />
      ) : null}
    </div>
  );
}

/**
 * No Companion paired in this browser (another browser, or the Reader app's
 * window, may be): the one running on this computer, if any, and its code to
 * pair it here — the Playground's Connect this computer, in short.
 */
function UnpairedRow() {
  const [found, setFound] = useState<{ base: string; info: CompanionInfo } | null | undefined>(undefined);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void findLocalCompanion().then((reached) => live && setFound(reached));
    return () => {
      live = false;
    };
  }, []);
  const ask = async () => {
    if (!found) return;
    const shown = await showCompanionCode(found.base);
    setNote(shown ? 'The code is in a window on this computer’s screen.' : 'This computer can’t show it in a window: run reader-companion pair in a terminal, or open the Reader app.');
  };
  const pair = async () => {
    if (!found) return;
    setBusy(true);
    setNote(null);
    try {
      saveCompanion(await pairCompanion(code, found.base), found.base);
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="companion-update companion-unpaired">
      <div>
        <b>{found ? found.info.name : 'This computer'}</b>
        <small>
          {found === undefined
            ? 'Looking for the Reader Companion…'
            : found
              ? `Companion ${found.info.version} is running here, but this window isn’t paired with it yet. Pair it to update it, shut it down and start it from here.`
              : 'No Reader Companion answers on this computer: it is off, or not installed. Open the Reader app to start it, or Playground → Connect this computer to install it.'}
        </small>
        {found ? (
          <span className="companion-pair">
            <button type="button" className="btn sm" onClick={() => void ask()}>
              Show the code on this computer
            </button>
            <input value={code} placeholder="ABC-DEF" aria-label="The code it shows" onChange={(event) => setCode(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && normaliseCode(code).length === 7 && void pair()} />
            <button type="button" className="btn sm primary" disabled={busy || normaliseCode(code).length !== 7} onClick={() => void pair()}>
              {busy ? 'Pairing…' : 'Pair'}
            </button>
          </span>
        ) : null}
        {note ? <small>{note}</small> : null}
      </div>
    </div>
  );
}

/** Every Companion this browser is paired with, or the one on this computer to pair with. */
export default function CompanionUpdates() {
  const companions = useServers().filter(isCompanion);
  if (!companions.length)
    return (
      <section style={{ marginBottom: 22 }}>
        <div className="eyebrow" style={{ marginBottom: 10 }}>
          This computer
        </div>
        <UnpairedRow />
      </section>
    );
  return (
    <section style={{ marginBottom: 22 }}>
      <div className="eyebrow" style={{ marginBottom: 10 }}>
        This computer
      </div>
      {companions.map((server) => (
        <CompanionRow key={server.id} server={server} />
      ))}
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: '8px 0 0' }}>
        The Reader Companion runs your playgrounds on this computer. Update installs the newest one from this site, refreshes
        the Reader extension in VS Code, and starts it again; your files and settings stay as they are.
      </p>
    </section>
  );
}
