// The collaborators on a project, where the project is looked at rather than
// worked in (docs/live-collaboration.md): a panel on its overview — each
// member with their role and where they are, the invitations waiting, and
// Share — and a stack of them on its card on the board, with how many are
// here now. The room's state comes through src/lib/liveRoom.ts: live for the
// project whose page is open, a snapshot for the others.

import { useState } from 'react';
import type { Project } from '../lib/projects';
import { useStore } from '../lib/store';
import { useLive, useRoomSnapshot } from '../lib/liveRoom';
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
  const { user } = useStore();
  const shared = project.project.shared;
  const state = useRoomSnapshot(shared?.room);
  const live = useLive();
  const [sharing, setSharing] = useState(false);
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
                      {ROLE[member.role]} · {presence === 'here' ? `here · ${describePlace(member.place)}` : presence === 'away' ? `away · ${describePlace(member.place)}` : member.lastSeen ? `last here ${whenSeen(member.lastSeen)}` : 'not here yet'}
                    </small>
                  </span>
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
              </li>
            ))}
          </ul>
          <div className="pj-row">
            <button type="button" className="btn sm" onClick={() => setSharing(true)}>
              <PeopleIcon size={13} /> {state.role === 'viewer' ? 'Who is in it' : 'Invite someone'}
            </button>
          </div>
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
