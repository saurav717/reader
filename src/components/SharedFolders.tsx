/**
 * Settings → Compute: a folder of one of your computers attached on another as
 * a disk (src/lib/shares.ts). Pick the computer with the folder, the folder,
 * and the computer it goes to; then what is attached where, and what each
 * computer shares.
 */

import { useCallback, useEffect, useState } from 'react';
import type { JupyterServer } from '../lib/colab';
import { listFolder } from '../lib/companion';
import type { FolderListing } from '../lib/companion';
import { useServers } from '../lib/playground';
import { attachFolder, attachedWords, detach, installDriver, listAttached, listShares, stopSharing } from '../lib/shares';
import type { AttachCache, Attachment, Backends, Shared } from '../lib/shares';
import { isCompanion } from './VsCodeExtension';

const CACHES: { id: AttachCache; label: string; note: string }[] = [
  { id: 'used', label: 'Only what’s used', note: 'Like a network drive: a file comes over when it is opened, and is kept.' },
  { id: 'all', label: 'Everything, in the background', note: 'Keeps working while the other computer sleeps; takes its room here.' },
  { id: 'none', label: 'Nothing kept', note: 'Every read goes to the other computer.' },
];

interface Seen {
  attached: Attachment[];
  backends: Backends | null;
  shares: Shared[];
  problem?: string;
}

function FolderPicker({ server, path, onPick }: { server: JupyterServer; path: string; onPick: (path: string) => void }) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [problem, setProblem] = useState('');
  const open = useCallback(
    (at: string) => {
      setProblem('');
      listFolder(server, at)
        .then((found) => {
          setListing(found);
          onPick(found.path);
        })
        .catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)));
    },
    [server, onPick],
  );
  useEffect(() => {
    open(path);
    // Only when the computer changes: a path typed in is opened with Enter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);
  return (
    <div className="shared-picker">
      <input value={path} aria-label="The folder" onChange={(event) => onPick(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && open(path)} />
      {listing ? (
        <div className="shared-picker-list">
          {listing.parent ? (
            <button type="button" className="btn sm" onClick={() => open(listing.parent ?? '')}>
              ↑ Up
            </button>
          ) : null}
          {listing.places.map((place) => (
            <button type="button" key={place.path} className="btn sm" onClick={() => open(place.path)}>
              {place.name}
            </button>
          ))}
          {listing.entries
            .filter((entry) => entry.dir)
            .map((entry) => (
              <button type="button" key={entry.name} className="btn sm ghost" onClick={() => open(`${listing.path}${listing.sep}${entry.name}`)}>
                📁 {entry.name}
              </button>
            ))}
        </div>
      ) : null}
      {problem ? <small className="shared-problem">{problem}</small> : null}
    </div>
  );
}

export default function SharedFolders() {
  const computers = useServers().filter(isCompanion);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [path, setPath] = useState('');
  const [cache, setCache] = useState<AttachCache>('used');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [seen, setSeen] = useState<Record<string, Seen>>({});
  const from = computers.find((server) => server.id === fromId) ?? computers[0];
  const to = computers.find((server) => server.id === toId && server.id !== from?.id) ?? computers.find((server) => server.id !== from?.id);

  const look = useCallback(async (servers: JupyterServer[]) => {
    const found = await Promise.all(
      servers.map(async (server): Promise<[string, Seen]> => {
        try {
          const [attached, shares] = await Promise.all([listAttached(server), listShares(server)]);
          return [server.id, { attached: attached.attached, backends: attached.backends, shares: shares.shares }];
        } catch (error) {
          return [server.id, { attached: [], backends: null, shares: [], problem: error instanceof Error ? error.message : String(error) }];
        }
      }),
    );
    setSeen(Object.fromEntries(found));
  }, []);
  const ids = computers.map((server) => server.id).join('|');
  useEffect(() => {
    void look(computers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, look]);

  const run = async (label: string, work: () => Promise<string | void>) => {
    setBusy(label);
    setNote('');
    try {
      const said = await work();
      if (said) setNote(said);
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('');
      void look(computers);
    }
  };

  if (computers.length < 2) {
    return (
      <p className="shared-note">
        Sign in to the Koios app on another computer (Mac, Windows or Linux) with this account, and it shows up here: then a
        folder of one can be attached on the other as a disk of its own.
      </p>
    );
  }

  const attach = () =>
    run('attach', async () => {
      if (!from || !to || !path.trim()) return 'Pick the folder, and the computer it goes to.';
      const done = await attachFolder(from, to, path.trim(), cache);
      return `Attached on ${to.name} at ${done.where}.`;
    });

  return (
    <div className="shared-folders">
      <div className="shared-form">
        <label>
          From
          <select value={from?.id ?? ''} onChange={(event) => setFromId(event.target.value)}>
            {computers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.name}
              </option>
            ))}
          </select>
        </label>
        {from ? <FolderPicker key={from.id} server={from} path={path} onPick={setPath} /> : null}
        <label>
          To
          <select value={to?.id ?? ''} onChange={(event) => setToId(event.target.value)}>
            {computers
              .filter((server) => server.id !== from?.id)
              .map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Keep here
          <select value={cache} onChange={(event) => setCache(event.target.value as AttachCache)}>
            {CACHES.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <small>{CACHES.find((choice) => choice.id === cache)?.note}</small>
        <button type="button" className="btn sm primary" disabled={Boolean(busy) || !path.trim()} onClick={() => void attach()}>
          {busy === 'attach' ? 'Attaching…' : `Attach on ${to?.name ?? '…'}`}
        </button>
        {note ? <small className="shared-note">{note}</small> : null}
      </div>

      {computers.map((server) => {
        const here = seen[server.id];
        if (!here) return null;
        const fuse = here.backends?.fuse;
        return (
          <div key={server.id} className="companion-update">
            <div>
              <b>{server.name}</b>
              {here.problem ? <small>{here.problem}</small> : null}
              {here.attached.map((item) => (
                <small key={item.id}>
                  {item.name || item.label} from {item.from || 'another computer'}: {attachedWords(item)}{' '}
                  <button type="button" className="btn sm" disabled={Boolean(busy)} onClick={() => void run(item.id, async () => void (await detach(server, item.id)))}>
                    Detach
                  </button>
                </small>
              ))}
              {here.shares.map((share) => (
                <small key={share.root}>
                  Shares {share.root}
                  {share.attached ? ` (attached on ${share.attached} now)` : ''}{' '}
                  <button type="button" className="btn sm" disabled={Boolean(busy)} onClick={() => void run(share.root, async () => void (await stopSharing(server, share.root)))}>
                    Stop sharing
                  </button>
                </small>
              ))}
              {!here.problem && !here.attached.length && !here.shares.length ? <small>Nothing attached or shared.</small> : null}
              {fuse && !fuse.ok && here.backends?.os !== 'linux' ? (
                <small>
                  Folders are attached as a network drive here. {fuse.driver} makes them faster and works with every program.{' '}
                  <button
                    type="button"
                    className="btn sm"
                    disabled={Boolean(busy)}
                    onClick={() => void run('driver', async () => {
                      const done = await installDriver(server);
                      return done.opened ? `${done.name}’s installer is open on ${server.name}: it asks for the rest. Attach again afterwards.` : `On ${server.name}: ${done.how}`;
                    })}
                  >
                    Install {fuse.driver}
                  </button>
                </small>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
