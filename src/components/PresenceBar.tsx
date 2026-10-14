// The people in a shared project, in the project bar on every tab
// (docs/live-collaboration.md): a stack of avatars, a green dot for someone
// active and dimmed for someone away; hover one for a card that says where
// they are, with Jump and Follow; click the group for everyone in a list.
// Someone arriving, or opening a file or a paper, is a toast with a Jump.
// Where the people come from is src/lib/liveRoom.ts.

import { useEffect, useRef, useState } from 'react';
import type { View } from '../types.view';
import { useStore } from '../lib/store';
import { dismissEvent, follow, requestJump, setVisible, useLive, type RoomEvent } from '../lib/liveRoom';
import { atParam, describePlace, initials, jumpFor, orderMembers, presenceOf, shortPlace, viewFor, whenSeen, type Member, type Place } from '../lib/presence';
import { basePath, pathFor } from '../lib/route';
import type { Project } from '../lib/projects';
import ShareProject from './ShareProject';
import { PeopleIcon } from './icons';

export default function PresenceBar({ project, onView }: { project: Project; onView: (view: View) => void }) {
  const { user } = useStore();
  const live = useLive();
  const shared = project.project.shared;
  const [sharing, setSharing] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!listOpen && !hover) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) (setListOpen(false), setHover(null));
    };
    const key = (event: KeyboardEvent) => event.key === 'Escape' && (setListOpen(false), setHover(null));
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', key);
    return () => (window.removeEventListener('pointerdown', away), window.removeEventListener('keydown', key));
  }, [listOpen, hover]);

  const state = shared && live.room === shared.room ? live.state : null;
  // The room never echoes your own place back: yours is what was last sent, or nothing while hidden.
  const members = state ? orderMembers(state.members.map((member) => (member.email === state.me ? { ...member, place: live.visible ? live.mine : null } : member))) : [];
  const here = members.filter((member) => presenceOf(member) !== 'gone');
  const jump = (place: Place) => {
    const target = jumpFor(project.id, place);
    requestJump(target);
    onView(viewFor(target));
    setListOpen(false);
    setHover(null);
  };
  const linkTo = (place: Place) => {
    const at = atParam(place);
    const path = pathFor({ view: viewFor(jumpFor(project.id, place)) }, basePath());
    return `${window.location.origin}${path}${at ? `&at=${encodeURIComponent(at)}` : ''}`;
  };

  return (
    <div className="pj-people-wrap" ref={box}>
      {shared ? (
        <div className={`pj-people${listOpen ? ' is-open' : ''}${live.following ? ' is-following' : ''}`}>
          <button type="button" className="pj-people-btn" aria-expanded={listOpen} aria-haspopup="dialog" onClick={() => (setListOpen(!listOpen), setHover(null))} title={live.status === 'live' ? `${here.length} here now` : live.status === 'error' ? live.error ?? 'Not connected' : 'Connecting…'}>
            <span className="pj-avatars">
              {(members.length ? members : [{ email: state?.me ?? user?.email ?? '', name: user?.name ?? 'You', picture: user?.picture, color: '#1f5e52', place: null, role: 'owner', joinedAt: '', lastSeen: null, lastPlace: null } as Member]).slice(0, 6).map((member) => (
                <Avatar key={member.email} member={member} me={member.email === state?.me} following={live.following === member.email} onEnter={() => member.email !== state?.me && !listOpen && setHover(member.email)} />
              ))}
            </span>
            <span className="pj-people-n">
              <i className={`pj-live is-${live.status}`} />
              {live.following ? `Following ${members.find((member) => member.email === live.following)?.name.split(' ')[0] ?? ''}` : live.status === 'live' ? `${here.length} here` : live.status === 'error' ? 'offline' : '…'}
            </span>
          </button>
          {live.following ? (
            <button type="button" className="pj-stop-follow" onClick={() => follow(null)} title="Stop following (Esc)">
              Stop
            </button>
          ) : null}
          {hover && !listOpen ? <PersonCard member={members.find((member) => member.email === hover)!} onJump={jump} onFollow={(email) => (follow(email), setHover(null))} onLink={linkTo} onLeave={() => setHover(null)} /> : null}
          {listOpen && state ? <PeopleList members={members} me={state.me} visible={live.visible} onJump={jump} onFollow={(email) => (follow(email), setListOpen(false))} onShare={() => (setListOpen(false), setSharing(true))} /> : null}
        </div>
      ) : null}
      <button type="button" className={`btn sm${shared ? '' : ' pj-share-btn'}`} onClick={() => setSharing(true)} title={shared ? 'Who is in this project' : 'Work on this project with other people: see where each of you is, as it happens'}>
        <PeopleIcon size={14} /> Share
      </button>
      {sharing ? <ShareProject project={project} onClose={() => setSharing(false)} /> : null}
      {shared ? <Toasts events={live.events} members={members} onJump={jump} /> : null}
    </div>
  );
}

function Avatar({ member, me, following, onEnter, size = 'sm' }: { member: Member; me?: boolean; following?: boolean; onEnter?: () => void; size?: 'sm' | 'lg' }) {
  const presence = presenceOf(member);
  return (
    <span className={`pj-av is-${size} is-${presence}${me ? ' is-me' : ''}${following ? ' is-following' : ''}`} style={{ background: member.color, '--who': member.color } as React.CSSProperties} onPointerEnter={onEnter} title={`${member.name}${me ? ' (you)' : ''} · ${presence === 'gone' ? `last here ${whenSeen(member.lastSeen)}` : describePlace(member.place)}`}>
      {member.picture ? <img src={member.picture} alt="" referrerPolicy="no-referrer" /> : initials(member.name)}
      <i className={`pj-av-dot is-${presence}`} />
    </span>
  );
}

function PersonCard({ member, onJump, onFollow, onLink, onLeave }: { member: Member; onJump: (place: Place) => void; onFollow: (email: string) => void; onLink: (place: Place) => string; onLeave: () => void }) {
  const presence = presenceOf(member);
  const place = member.place ?? member.lastPlace;
  const [copied, setCopied] = useState(false);
  return (
    <div className="pj-person" role="dialog" aria-label={member.name} onPointerLeave={onLeave}>
      <div className="pj-person-who">
        <Avatar member={member} size="lg" />
        <div>
          <b>{member.name}</b>
          <small>{presence === 'here' ? 'here now' : presence === 'away' ? 'here, away for a bit' : `last here ${whenSeen(member.lastSeen)}`}</small>
        </div>
      </div>
      <div className="pj-person-where">
        <span>{presence === 'gone' ? 'Was in' : 'In'}</span>
        <code>{describePlace(place)}</code>
        {member.role !== 'editor' ? (
          <>
            <span>Role</span>
            <em>{member.role === 'owner' ? 'owner' : 'can view'}</em>
          </>
        ) : null}
      </div>
      {place && (place.path || place.paperId) ? (
        <div className="pj-person-acts">
          <button type="button" className="btn sm primary" onClick={() => onJump(place)}>
            {presence === 'gone' ? 'Open there' : 'Jump there'}
          </button>
          {presence !== 'gone' ? (
            <button type="button" className="btn sm" onClick={() => onFollow(member.email)}>
              Follow {member.name.split(' ')[0]}
            </button>
          ) : null}
          <button
            type="button"
            className="btn sm ghost"
            title="Copy a link to this place"
            onClick={() => {
              void navigator.clipboard?.writeText(onLink(place)).then(() => (setCopied(true), window.setTimeout(() => setCopied(false), 1500)));
            }}
          >
            {copied ? 'Copied' : 'Link'}
          </button>
        </div>
      ) : null}
      <p className="pj-person-note">Jump opens the tab and the file at their caret, once. Follow keeps the editor where they go, until you press Esc or edit something.</p>
    </div>
  );
}

function PeopleList({ members, me, visible, onJump, onFollow, onShare }: { members: Member[]; me: string; visible: boolean; onJump: (place: Place) => void; onFollow: (email: string) => void; onShare: () => void }) {
  const now = Date.now();
  const here = members.filter((member) => presenceOf(member, now) !== 'gone');
  const earlier = members.filter((member) => presenceOf(member, now) === 'gone');
  const row = (member: Member) => {
    const presence = presenceOf(member, now);
    const place = member.place ?? member.lastPlace;
    const mine = member.email === me;
    return (
      <div key={member.email} className={`pj-people-row${mine ? ' is-me' : ''}`}>
        <Avatar member={member} size="lg" me={mine} />
        <div className="pj-people-row-text">
          <b>{mine ? 'You' : member.name}</b>
          <small>
            {place ? <code>{describePlace(place)}</code> : <span>{presence === 'gone' ? 'not here' : 'somewhere in the project'}</span>}
            {presence === 'away' ? ' · away' : ''}
            {presence === 'gone' && member.lastSeen ? ` · ${whenSeen(member.lastSeen, now)}` : ''}
            {mine ? (visible ? ' · the others see this' : ' · hidden from the others') : ''}
          </small>
        </div>
        {mine ? (
          <button type="button" className="link-btn" onClick={() => setVisible(!visible)}>
            {visible ? 'Appear away' : 'Show where I am'}
          </button>
        ) : place && (place.path || place.paperId) ? (
          <span className="pj-people-row-acts">
            <button type="button" className="link-btn" onClick={() => onJump(place)}>
              {presence === 'gone' ? 'Open there' : 'Jump'}
            </button>
            {presence !== 'gone' ? (
              <button type="button" className="link-btn" onClick={() => onFollow(member.email)}>
                Follow
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
    );
  };
  return (
    <div className="pj-people-list" role="dialog" aria-label="Everyone in the project">
      <h5>Here now</h5>
      {here.length ? here.map(row) : <p className="pj-people-none">Nobody else right now.</p>}
      {earlier.length ? (
        <>
          <h5>Earlier</h5>
          {earlier.map(row)}
        </>
      ) : null}
      <div className="pj-people-foot">
        <button type="button" className="link-btn" onClick={onShare}>
          Share…
        </button>
      </div>
    </div>
  );
}

function Toasts({ events, members, onJump }: { events: RoomEvent[]; members: Member[]; onJump: (place: Place) => void }) {
  const latest = events[events.length - 1];
  useEffect(() => {
    if (!latest) return;
    const timer = window.setTimeout(() => dismissEvent(latest.id), 7000);
    return () => window.clearTimeout(timer);
  }, [latest]);
  if (!latest) return null;
  const member = members.find((item) => item.email === latest.who);
  if (!member) return null;
  return (
    <div className="pj-toast" role="status">
      <Avatar member={member} />
      <span>
        <b>{member.name.split(' ')[0]}</b> {latest.kind === 'joined' ? 'joined the project' : <>opened <b>{shortPlace(latest.place)}</b></>}
      </span>
      {latest.place ? (
        <button type="button" className="link-btn" onClick={() => (dismissEvent(latest.id), onJump(latest.place!))}>
          Jump
        </button>
      ) : null}
      <button type="button" className="pj-toast-x" aria-label="Dismiss" onClick={() => dismissEvent(latest.id)}>
        ×
      </button>
    </div>
  );
}
