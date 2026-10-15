// The card in the corner while Reader takes a meeting's notes on this
// computer (src/lib/notetaker.ts): a meeting found, with Take notes and the
// project to file them in; the recording, with how long, the last thing said
// and Stop; writing it up; and where it was filed. Only in the Reader desktop
// app, where the recorder is — nothing shows in a browser.

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useStore } from '../lib/store';
import { getState as assistantState, streamModel } from '../lib/assistant';
import { CALL_NAMES } from '../lib/calendar';
import { armJoin, dismiss, recoverRecordings, retry, setProject, startNotetaker, startRecording, stopRecording, useNotetaker, type Session } from '../lib/notetaker';
import { projectsOf } from '../lib/projects';
import type { View } from '../types.view';
import { CloseIcon } from './icons';

/** The page's model, asked once for a meeting's write-up: what it answered, whole. */
async function writeWithModel(prompt: { system: string; user: string }): Promise<string> {
  const stream = await streamModel({ model: assistantState().prefs.model, maxTokens: 4000, system: [{ type: 'text', text: prompt.system }], messages: [{ role: 'user', content: prompt.user }], effort: 'low' });
  let text = '';
  stream.on('text', (delta: string) => (text += delta));
  await stream.finalMessage();
  return text.trim();
}

const platformName = (platform?: string) =>
  platform?.includes('zoom') ? CALL_NAMES.zoom : platform?.includes('meet') ? CALL_NAMES.meet : platform?.includes('teams') ? CALL_NAMES.teams : platform?.includes('slack') ? 'Slack huddle' : platform?.includes('webex') ? CALL_NAMES.webex : 'Meeting';

const elapsed = (from: number, now: number) => {
  const s = Math.max(0, Math.round((now - from) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export default function Notetaker({ onView }: { onView: (view: View) => void }) {
  const { collections, user, settings } = useStore();
  const projects = useMemo(() => projectsOf(collections), [collections]);
  const notes = useNotetaker();
  const [now, setNow] = useState(Date.now());
  // The store reads the page through these, so it always sees the newest projects and choices.
  const live = useMemo(() => ({ projects, who: user?.email ?? null, clientId: settings.googleClientId.trim(), auto: settings.notesAuto !== false, offer: settings.notesOffer !== false }), [projects, user?.email, settings.googleClientId, settings.notesAuto, settings.notesOffer]);
  useEffect(() => {
    void startNotetaker({ projects: () => live.projects, who: () => live.who, clientId: () => live.clientId, auto: () => live.auto, offer: () => live.offer, write: writeWithModel }).then(() => recoverRecordings());
  }, [live]);
  const recording = notes.sessions.some((session) => session.status === 'recording');
  useEffect(() => {
    if (!recording) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [recording]);
  // A filed note's card goes by itself after a while.
  useEffect(() => {
    const filed = notes.sessions.filter((session) => session.status === 'filed');
    if (!filed.length) return;
    const timer = window.setTimeout(() => filed.forEach((session) => dismiss(session.windowId)), 20_000);
    return () => window.clearTimeout(timer);
  }, [notes.sessions]);
  if (!notes.sessions.length) return null;
  return (
    <div className="nt-stack" aria-live="polite">
      {notes.sessions.map((session) => (
        <NotetakerCard key={session.windowId} session={session} projects={projects} now={now} onOpen={(projectId) => onView({ kind: 'project', id: projectId, mode: 'logbook', section: 'meetings' })} />
      ))}
    </div>
  );
}

function NotetakerCard({ session, projects, now, onOpen }: { session: Session; projects: ReturnType<typeof projectsOf>; now: number; onOpen: (projectId: string) => void }) {
  const project = projects.find((item) => item.id === session.projectId);
  const title = session.event?.title || session.found.title || platformName(session.found.platform);
  const last = session.turns[session.turns.length - 1];
  const picker = (
    <select className="nt-project" value={session.projectId ?? ''} onChange={(change) => setProject(session.windowId, change.target.value || null)} aria-label="File the notes in">
      <option value="">Pick a project…</option>
      {projects.map((item) => (
        <option key={item.id} value={item.id}>
          {item.name}
        </option>
      ))}
    </select>
  );
  return (
    <section className={`nt-card is-${session.status}`} style={{ '--pj': project?.color ?? 'var(--accent)' } as CSSProperties} aria-label={`Notes: ${title}`}>
      <header className="nt-head">
        {session.status === 'recording' ? <span className="nt-rec" aria-hidden="true" /> : <span className="nt-mark" aria-hidden="true">R</span>}
        <span className="nt-head-text">
          <small>
            {session.status === 'joining'
              ? `Joining${session.found.platform ? ` · ${platformName(session.found.platform)}` : ''}`
              : session.status === 'found'
              ? `${platformName(session.found.platform)} meeting on this computer`
              : session.status === 'starting'
                ? 'Starting…'
                : session.status === 'recording'
                  ? `Taking notes · ${elapsed(session.started ?? now, now)}`
                  : session.status === 'writing'
                    ? project
                      ? 'Writing up the notes…'
                      : 'The meeting has ended'
                    : session.status === 'filed'
                      ? 'Notes filed'
                      : 'Notes stopped'}
          </small>
          <b>{title}</b>
        </span>
        {session.status === 'joining' || session.status === 'found' || session.status === 'filed' || session.status === 'failed' ? (
          <button type="button" className="icon-btn sm nt-close" onClick={() => dismiss(session.windowId)} aria-label="Close">
            <CloseIcon size={13} />
          </button>
        ) : null}
      </header>

      {session.status === 'joining' ? (
        <>
          <p className="nt-text">
            <span>
              {session.armed ? (
                <>Reader will take its notes from this computer once the meeting opens — no bot joins — and file them in <b>{project?.name}</b>, for everyone in the project.</>
              ) : (
                <>Reader can take its notes from this computer once the meeting opens — no bot joins — and file them in the project{session.projectId ? '' : ' you pick'}.</>
              )}
            </span>
          </p>
          <div className="nt-row">
            {session.armed && project ? <span className="nt-to">→ <b>{project.name}</b></span> : picker}
            {session.armed ? (
              <button type="button" className="btn sm" onClick={() => armJoin(session.windowId, false)}>
                Not this time
              </button>
            ) : (
              <button type="button" className="btn primary sm" onClick={() => armJoin(session.windowId, true)} disabled={!session.projectId}>
                Take notes
              </button>
            )}
          </div>
          <p className="nt-fine">{session.armed ? 'Everyone in the call should know it is being recorded.' : 'Nothing is recorded unless you say so.'}</p>
        </>
      ) : null}

      {session.status === 'found' ? (
        <>
          <p className="nt-text">Reader can take its notes from this computer — no bot joins the call — and file them in the project{session.projectId ? '' : ' you pick'}.</p>
          <div className="nt-row">
            {picker}
            <button type="button" className="btn primary sm" onClick={() => void startRecording(session.windowId, session.projectId)}>
              Take notes
            </button>
          </div>
        </>
      ) : null}

      {session.status === 'recording' || session.status === 'starting' ? (
        <>
          <p className="nt-line">{last ? <><b>{last.speaker}:</b> {last.text.length > 140 ? `…${last.text.slice(-140)}` : last.text}</> : <i>Listening…</i>}</p>
          <div className="nt-row">
            <span className="nt-to">{project ? <>→ <b>{project.name}</b></> : picker}</span>
            <button type="button" className="btn sm nt-stop" onClick={() => void stopRecording(session.windowId)} disabled={session.status === 'starting'}>
              <i aria-hidden="true" /> Stop
            </button>
          </div>
          {session.auto ? <p className="nt-fine">Started by itself: this meeting is set to Reader notes. Everyone in the call should know it is being recorded.</p> : null}
        </>
      ) : null}

      {session.status === 'writing' ? (
        project ? (
          <p className="nt-text">
            <span className="spinner" aria-hidden="true" /> {session.turns.length} turns from {new Set(session.turns.map((turn) => turn.speaker)).size} people, going into <b>{project.name}</b>.
          </p>
        ) : (
          <div className="nt-row">
            <span className="nt-text">Which project are these notes for?</span>
            {picker}
          </div>
        )
      ) : null}

      {session.status === 'filed' && project ? (
        <div className="nt-row">
          <span className="nt-text">
            In <b>{project.name}</b> → Logbook, for everyone in the project.
          </span>
          <button type="button" className="btn sm primary" onClick={() => (onOpen(project.id), dismiss(session.windowId))}>
            Open notes
          </button>
        </div>
      ) : null}

      {session.status === 'failed' ? (
        <div className="nt-row">
          <span className="nt-text nt-error">{session.error ?? 'Something went wrong.'}</span>
          {session.turns.length ? (
            <button type="button" className="btn sm" onClick={() => retry(session.windowId)}>
              File what was recorded
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
