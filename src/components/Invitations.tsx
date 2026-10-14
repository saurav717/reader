// The projects waiting for you, on Home (docs/live-collaboration.md): invited
// to a shared project, not yet joined — a card each, with Join. No link
// needed: the room's ledger (worker/invites.js) knows what was sent to your
// address. The project then appears in your library under its owner's id.

import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { currentPass } from '../lib/api';
import { waitingInvitations, type Waiting } from '../lib/invites';
import { adoptJoined, joinRoom } from '../lib/liveRoom';
import { initials, whenSeen } from '../lib/presence';
import { projectsOf } from '../lib/projects';

export default function InvitationsCard({ onOpenProject }: { onOpenProject: (id: string) => void }) {
  const { user, collections, adoptCollection } = useStore();
  const [waiting, setWaiting] = useState<Waiting[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const signedIn = Boolean(currentPass());
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    void waitingInvitations()
      .then((list) => live && setWaiting(list))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [signedIn]);
  const shown = waiting.filter((item) => !hidden.has(item.id));
  if (!shown.length) return null;

  const join = async (item: Waiting) => {
    setBusy(item.id);
    setError(null);
    try {
      const state = await joinRoom(item.room, null, user);
      const id = await adoptJoined(state, projectsOf(collections), adoptCollection);
      setWaiting((list) => list.filter((other) => other.id !== item.id));
      onOpenProject(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="home-invites" aria-label="Projects you are invited to">
      <h2 className="home-eyebrow">You’re invited</h2>
      {shown.map((item) => (
        <div key={item.id} className="home-invite">
          <span className="pj-av is-lg" style={{ background: '#8a3a6e' }}>
            {initials(item.byName || item.by)}
          </span>
          <div className="home-invite-text">
            <b>
              {item.byName || item.by} invited you to <i>{item.project || 'a project'}</i>
            </b>
            <small>
              {item.role === 'viewer' ? 'You’d be able to see the project, and where everyone in it is.' : 'You’d be able to edit the project, and see where everyone in it is.'} · invited {whenSeen(item.at)}
            </small>
          </div>
          <div className="home-invite-acts">
            <button type="button" className="btn sm" disabled={busy === item.id} onClick={() => setHidden((set) => new Set([...set, item.id]))}>
              Not now
            </button>
            <button type="button" className="btn sm primary" disabled={busy === item.id} onClick={() => void join(item)}>
              {busy === item.id ? 'Joining…' : 'Join the project'}
            </button>
          </div>
        </div>
      ))}
      {error ? <p className="pj-share-error">{error}</p> : null}
    </section>
  );
}
