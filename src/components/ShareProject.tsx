// Sharing a project with the people you work with (docs/live-collaboration.md):
// a room is made for it on the Worker the first time, and from then on the
// dialog is who is in it. Invitations are by Google email, since that is how
// everyone signs in: an invited address joins by the project's link. A join
// link for anyone, off unless switched on, can be kept to a domain.

import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { proxyHealth } from '../lib/api';
import { createRoom, leaveRoom, openRoom, refreshRoom, roomAction, roomState, summarize, useLive } from '../lib/liveRoom';
import { describePlace, initials, orderMembers, presenceOf, whenSeen, type Role, type RoomState } from '../lib/presence';
import { basePath, pathFor } from '../lib/route';
import type { Project } from '../lib/projects';
import InviteSomeone from './InviteSomeone';

export default function ShareProject({ project, onClose }: { project: Project; onClose: () => void }) {
  const { user, papers, updateCollection, deleteCollection } = useStore();
  const live = useLive();
  const shared = project.project.shared;
  const [state, setState] = useState<RoomState | null>(shared && live.room === shared.room ? live.state : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const [copied, setCopied] = useState<string | null>(null);
  // Not a member for this project, just someone to show Reader to: that dialog, in this one's place.
  const [someone, setSomeone] = useState(false);
  // Whether the site sends the invitation by mail, or the owner sends the link: the Worker's /health says.
  const [mails, setMails] = useState<boolean | null>(null);
  // What became of the last invitation's mail: sent, or why not.
  const [mailed, setMailed] = useState<Record<string, string>>({});
  useEffect(() => {
    void proxyHealth().then((health) => setMails(Boolean(health?.mail)));
  }, []);
  const mine = state?.role ?? shared?.role ?? 'owner';
  const owner = mine === 'owner';

  useEffect(() => {
    if (!shared) return;
    if (live.room === shared.room && live.state) setState(live.state);
    else void roomState(shared.room).then(setState).catch((e: Error) => setError(e.message));
  }, [shared, live.room, live.state]);

  const close = () => {
    if (!busy) onClose();
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => event.key === 'Escape' && close();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  const share = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await createRoom(summarize(project, papers), user);
      await updateCollection(project.id, (collection) => ({ project: { ...project.project, ...(collection.project ?? {}), shared: { room: made.room, owner: made.owner, role: 'owner' } } }));
      setState(made);
      openRoom(made.room, user);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const stopSharing = async () => {
    if (!shared || !window.confirm(`Stop sharing ${project.name}? Everyone else is taken out and loses the project; it is yours alone again. Their own papers, notes and highlights stay theirs.`)) return;
    setBusy(true);
    setError(null);
    try {
      await roomAction(shared.room, 'close', {});
      const { shared: _gone, ...info } = project.project;
      await updateCollection(project.id, { project: info });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const act = async (action: 'invite' | 'uninvite' | 'role' | 'link' | 'remove', body: Record<string, unknown>) => {
    if (!shared) return;
    setBusy(true);
    setError(null);
    try {
      const next = await roomAction(shared.room, action, body);
      setState(next);
      if (action === 'invite') setMailed((was) => ({ ...was, [String(body.email)]: next.mailed ? 'sent' : next.mailError ? `not sent: ${next.mailError}` : '' }));
      refreshRoom();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const invite = async () => {
    const address = email.trim().toLowerCase();
    if (!address.includes('@')) return setError('A Google account’s email address.');
    await act('invite', { email: address, role, link: link() });
    setEmail('');
  };

  const leave = async () => {
    if (!shared || !window.confirm(`Leave ${project.name}? The project stays with its owner; your copy of it is taken off your library.`)) return;
    setBusy(true);
    try {
      await leaveRoom(shared.room);
      await deleteCollection(project.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const link = (token?: string | null, tag?: string) => {
    if (!shared) return '';
    const path = pathFor({ view: { kind: 'project', id: project.id } }, basePath());
    return `${window.location.origin}${path}&room=${shared.room}${token ? `&join=${token}` : ''}${tag ? `&for=${tag}` : ''}`;
  };
  const copy = (what: string, text: string) => void navigator.clipboard?.writeText(text).then(() => (setCopied(what), window.setTimeout(() => setCopied(null), 1500)));

  const members = state ? orderMembers(state.members) : [];
  if (someone) return <InviteSomeone onClose={onClose} />;
  return (
    <>
      <div className="scrim" onClick={close} role="presentation" />
      <div className="sheet pj-share" role="dialog" aria-modal="true" aria-labelledby="pj-share-title">
        <span className="eyebrow">{project.name} · share</span>
        <h2 id="pj-share-title">{shared ? 'Working on this together' : 'Work on this project together'}</h2>
        <p className="lede">
          Everyone you invite sees the project — its question, its papers' roles and its to-do list — and where each of you is in it, as it happens. Your library and your other projects stay yours.
          {shared ? (mails ? ' An invitation is emailed to the address, with the project’s link; signing in with Google as that address is all an account is.' : mails === false ? ' Send each person the project’s link; they join signed in with Google as the address invited.' : '') : ''}
        </p>
        {!shared ? (
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={close}>
              Not now
            </button>
            <button type="button" className="btn primary" disabled={busy || !user} onClick={() => void share()} title={user ? undefined : 'Sign in with Google first'}>
              {busy ? 'Making the room…' : 'Share this project'}
            </button>
          </div>
        ) : (
          <>
            {owner || mine === 'editor' ? (
              <form
                className="pj-share-invite"
                onSubmit={(event) => {
                  event.preventDefault();
                  void invite();
                }}
              >
                <input type="email" value={email} placeholder="A Google account's email…" onChange={(event) => setEmail(event.target.value)} disabled={busy} />
                <select value={role} onChange={(event) => setRole(event.target.value as Role)} aria-label="Role">
                  <option value="editor">Can edit</option>
                  <option value="viewer">Can view</option>
                </select>
                <button type="submit" className="btn sm primary" disabled={busy || !email.trim()}>
                  Invite
                </button>
              </form>
            ) : null}
            <div className="pj-share-members">
              {members.map((member) => {
                const presence = presenceOf(member);
                const me = member.email === state?.me;
                return (
                  <div key={member.email} className="pj-share-row">
                    <span className="pj-av is-lg" style={{ background: member.color }}>
                      {member.picture ? <img src={member.picture} alt="" referrerPolicy="no-referrer" /> : initials(member.name)}
                    </span>
                    <div className="pj-share-row-text">
                      <b>
                        {member.name}
                        {me ? <span className="muted"> (you)</span> : null}
                      </b>
                      <small>{presence === 'gone' ? (member.lastSeen ? `last here ${whenSeen(member.lastSeen)}` : member.email) : `${presence === 'here' ? 'here now' : 'away'} · ${describePlace(member.place)}`}</small>
                    </div>
                    {member.role === 'owner' ? (
                      <span className="pj-share-role">Owner</span>
                    ) : owner ? (
                      <select className="pj-share-role" value={member.role} disabled={busy} onChange={(event) => void act('role', { email: member.email, role: event.target.value })} aria-label={`${member.name}'s role`}>
                        <option value="editor">Can edit</option>
                        <option value="viewer">Can view</option>
                      </select>
                    ) : (
                      <span className="pj-share-role">{member.role === 'editor' ? 'Can edit' : 'Can view'}</span>
                    )}
                    {owner && !me ? (
                      <button type="button" className="link-btn" disabled={busy} onClick={() => window.confirm(`Take ${member.name} out of ${project.name}?`) && void act('remove', { email: member.email })}>
                        Remove
                      </button>
                    ) : me && !owner ? (
                      <button type="button" className="link-btn" disabled={busy} onClick={() => void leave()}>
                        Leave
                      </button>
                    ) : (
                      <span />
                    )}
                  </div>
                );
              })}
              {(state?.invitations ?? []).map((invitation) => (
                <div key={invitation.email} className="pj-share-row is-invited">
                  <span className="pj-av is-lg is-gone">?</span>
                  <div className="pj-share-row-text">
                    <b>{invitation.email}</b>
                    <small>
                      {mailed[invitation.email] === 'sent' ? 'invited · emailed the link; they join signed in with that Google account' : mailed[invitation.email]?.startsWith('not sent') ? `invited · ${mailed[invitation.email]}` : mails ? 'invited · they join with that Google account' : 'invited · send them the link; they join with that Google account'}
                    </small>
                  </div>
                  <span className="pj-share-role">{invitation.role === 'editor' ? 'Can edit' : 'Can view'}</span>
                  <span className="pj-share-row-acts">
                    <button type="button" className="link-btn" onClick={() => copy(invitation.email, link(undefined, invitation.tag))}>
                      {copied === invitation.email ? 'Copied' : 'Copy link'}
                    </button>
                    {mails && (owner || mine === 'editor') ? (
                      <button type="button" className="link-btn" disabled={busy} onClick={() => void act('invite', { email: invitation.email, role: invitation.role, link: link() })} title="Email the invitation again">
                        {mailed[invitation.email] === 'sent' ? 'Sent' : 'Email again'}
                      </button>
                    ) : null}
                    {owner || mine === 'editor' ? (
                      <button type="button" className="link-btn" disabled={busy} onClick={() => void act('uninvite', { email: invitation.email })}>
                        Withdraw
                      </button>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
            <div className="pj-share-gets">
              <div>
                <b>Papers</b>The project's list and roles. Each person's reading progress, highlights and notes are their own.
              </div>
              <div>
                <b>Code and the paper</b>Each person works in their own copy of the folder, synced as now — through the Companion, GitHub or Overleaf's Git. Editing one file together, live, is the next step.
              </div>
              <div>
                <b>Where everyone is</b>The tab, file and line, or the paper: shown to members only, while the page is open. <em>Appear away</em> in the bar hides yours.
              </div>
            </div>
            {owner && state?.link ? (
              <div className="pj-share-link">
                <label className="pj-share-switch">
                  <input type="checkbox" checked={state.link.on} disabled={busy} onChange={(event) => void act('link', { on: event.target.checked, domain: state.link?.domain ?? '' })} />
                  Anyone with the link can join
                </label>
                {state.link.on ? (
                  <>
                    <input className="pj-share-domain" placeholder="only @domain (optional)" defaultValue={state.link.domain} onBlur={(event) => event.target.value.trim().replace(/^@/, '') !== state.link?.domain && void act('link', { on: true, domain: event.target.value.trim() })} />
                    <button type="button" className="link-btn" onClick={() => copy('link', link(state.link?.token))}>
                      {copied === 'link' ? 'Copied' : 'Copy link'}
                    </button>
                    <button type="button" className="link-btn" disabled={busy} onClick={() => window.confirm('Make a new link? The old one stops working.') && void act('link', { on: true, domain: state.link?.domain ?? '', renew: true })}>
                      New link
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
            {error ? <p className="pj-share-error">{error}</p> : null}
            <div className="dialog-actions">
              <button type="button" className="link-btn" style={{ marginRight: 'auto' }} onClick={() => setSomeone(true)} title="Not for this project — just an email saying what Koios is, with the site's address">
                Just want to show someone Koios?
              </button>
              {owner ? (
                <button type="button" className="link-btn" disabled={busy} onClick={() => void stopSharing()} title="Take everyone out and keep the project to yourself">
                  Stop sharing
                </button>
              ) : null}
              <button type="button" className="btn primary" onClick={close}>
                Done
              </button>
            </div>
          </>
        )}
        {error && !shared ? <p className="pj-share-error">{error}</p> : null}
      </div>
    </>
  );
}
