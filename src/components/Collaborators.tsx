// The collaborators on a project, where the project is looked at rather than
// worked in (docs/live-collaboration.md): a panel on its overview — each
// member with their role and where they are, the invitations waiting, and
// Share — and a stack of them on its card on the board, with how many are
// here now. The room's state comes through src/lib/liveRoom.ts: live for the
// project whose page is open, a snapshot for the others.

import { useState } from 'react';
import type { Project } from '../lib/projects';
import { useStore } from '../lib/store';
import { leaveRoom, refreshRoom, roomAction, useLive, useRoomSnapshot } from '../lib/liveRoom';
import { describePlace, initials, orderMembers, presenceOf, whenSeen, type Member } from '../lib/presence';
import ShareProject from './ShareProject';
import { PeopleIcon } from './icons';

const ROLE: Record<Member['role'], string> = { owner: 'owner', editor: 'can edit', viewer: 'can view' };

function Avatar({ member, size = 'sm' }: { member: Pick<Member, 'name' | 'picture' | 'color' | 'place' | 'email'>; size?: 'sm' | 'lg' }) {
  const presence = presenceOf(member);
  return (
    <span className={`pj-av is-${size} is-${presence}`} style={{ background: member.color }} title={`${member.name} · ${presence === 'gone' ? 'not here' : describePlace(member.place)}`}>
      {member.picture ? <img src={member.picture} alt="" referrerPolicy="no-referrer" /> : initials(member.name || member.email)}
      <i className={`pj-av-dot is-${presence}`} />
    </span>
  );
}

/** On the overview: everyone in the project, and Share. */
export function CollaboratorsPanel({ project }: { project: Project }) {
  const { user, updateCollection, deleteCollection } = useStore();
  const shared = project.project.shared;
  const state = useRoomSnapshot(shared?.room);
  const live = useLive();
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const owner = state?.role === 'owner';
  // The owner's say over who is in: a role changed, someone taken out, an invitation taken back, or sharing stopped.
  const act = async (key: string, action: 'role' | 'remove' | 'uninvite' | 'close', body: Record<string, unknown>) => {
    if (!shared) return;
    setBusy(key);
    setError(null);
    try {
      await roomAction(shared.room, action, body);
      if (action === 'close') {
        const { shared: _gone, ...info } = project.project;
        await updateCollection(project.id, { project: info });
      } else refreshRoom();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const remove = (email: string, name: string) => window.confirm(`Take ${name} out of ${project.name}? They lose the project and where everyone is; their own papers, notes and highlights stay theirs.`) && void act(email, 'remove', { email });
  const stop = () => window.confirm(`Stop sharing ${project.name}? Everyone else is taken out and the project is yours alone again. Their copies stay with them as plain projects.`) && void act('close', 'close', {});
  const leave = async () => {
    if (!shared || !window.confirm(`Leave ${project.name}? The project stays with its owner; your copy of it is taken off your library.`)) return;
    setBusy('leave');
    try {
      await leaveRoom(shared.room);
      await deleteCollection(project.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };
  // The room never echoes your own place back: yours is what this page last sent, while this is the room open here.
  const members = state ? orderMembers(state.members.map((member) => (member.email === state.me && live.room === shared?.room ? { ...member, place: live.visible ? live.mine : null } : member))) : [];
  const here = members.filter((member) => presenceOf(member) === 'here').length;
  const invitations = state?.invitations ?? [];
  return (
    <section className="pj-panel pj-collab pj-collab-row" aria-label="Collaborators">
      <span className="eyebrow">
        Collaborators{members.length ? ` · ${members.length}` : ''}
        {here > 1 ? <span className="pj-collab-here"> · {here} here now</span> : null}
      </span>
      {!shared ? (
        <>
          <p className="pj-sub">Just you. Share it and the people you work with see the project — and where each of you is in it, as it happens.</p>
          <div className="pj-row">
            <button type="button" className="btn primary sm" onClick={() => setSharing(true)}>
              <PeopleIcon size={13} /> Share this project
            </button>
          </div>
        </>
      ) : !state ? (
        <p className="pj-sub">Reading who is in it…</p>
      ) : (
        <>
          <ul className="pj-collab-list">
            {members.map((member) => {
              const presence = presenceOf(member);
              const me = member.email === state.me || member.email === user?.email;
              return (
                <li key={member.email}>
                  <Avatar member={member} size="lg" />
                  <span className="pj-collab-text">
                    <b>
                      {member.name || member.email}
                      {me ? <span className="muted"> (you)</span> : null}
                    </b>
                    <small>
                      {owner && !me ? (
                        <select className="pj-collab-role" value={member.role} disabled={busy === member.email} onChange={(event) => void act(member.email, 'role', { email: member.email, role: event.target.value })} aria-label={`${member.name}'s role`}>
                          <option value="editor">can edit</option>
                          <option value="viewer">can view</option>
                        </select>
                      ) : (
                        ROLE[member.role]
                      )}
                      {' · '}
                      {presence === 'here' ? `here · ${describePlace(member.place)}` : presence === 'away' ? `away · ${describePlace(member.place)}` : member.lastSeen ? `last here ${whenSeen(member.lastSeen)}` : 'not here yet'}
                    </small>
                  </span>
                  {owner && !me ? (
                    <button type="button" className="link-btn pj-collab-x" disabled={busy === member.email} onClick={() => remove(member.email, member.name || member.email)} title="Take them out of the project">
                      Remove
                    </button>
                  ) : null}
                </li>
              );
            })}
            {invitations.map((invitation) => (
              <li key={invitation.email} className="is-invited">
                <span className="pj-av is-lg is-gone">?</span>
                <span className="pj-collab-text">
                  <b>{invitation.email}</b>
                  <small>invited · {invitation.role === 'viewer' ? 'can view' : 'can edit'} · not yet joined</small>
                </span>
                {owner || state.role === 'editor' ? (
                  <button type="button" className="link-btn pj-collab-x" disabled={busy === invitation.email} onClick={() => void act(invitation.email, 'uninvite', { email: invitation.email })} title="Take the invitation back">
                    Withdraw
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="pj-row">
            <button type="button" className="btn sm" onClick={() => setSharing(true)}>
              <PeopleIcon size={13} /> {state.role === 'viewer' ? 'Who is in it' : 'Invite someone'}
            </button>
            {owner ? (
              <button type="button" className="link-btn pj-collab-stop" disabled={busy === 'close'} onClick={stop} title="Take everyone out and keep the project to yourself">
                {busy === 'close' ? 'Stopping…' : 'Stop sharing'}
              </button>
            ) : (
              <button type="button" className="link-btn pj-collab-stop" disabled={busy === 'leave'} onClick={() => void leave()}>
                Leave the project
              </button>
            )}
          </div>
          {error ? <p className="pj-share-error">{error}</p> : null}
        </>
      )}
      {sharing ? <ShareProject project={project} onClose={() => setSharing(false)} /> : null}
    </section>
  );
}

/** On the board's card: the members as a stack, and how many are here now. */
export function CollaboratorsStack({ project }: { project: Project }) {
  const shared = project.project.shared;
  const state = useRoomSnapshot(shared?.room);
  if (!shared || !state) return null;
  const members = orderMembers(state.members);
  const here = members.filter((member) => presenceOf(member) === 'here').length;
  return (
    <div className="pj-card-part pj-collab-part">
      <span className="eyebrow">With</span>
      <span className="pj-collab-stack">
        <span className="pj-avatars">
          {members.slice(0, 5).map((member) => (
            <Avatar key={member.email} member={member} />
          ))}
          {members.length > 5 ? <span className="pj-av is-sm is-more">+{members.length - 5}</span> : null}
        </span>
        <span className="pj-collab-count">
          {members.length} {members.length === 1 ? 'person' : 'people'}
          {here ? ` · ${here} here now` : ''}
        </span>
      </span>
    </div>
  );
}
