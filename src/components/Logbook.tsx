// A project's logbook: the tab of a project page for its logistics rather
// than its research — the notes of its meetings (filed by Granola, or written
// in), the links that come up and are needed again, one notepad the whole
// project writes in, and a whiteboard to draw on with a pen, a stylus, a
// finger or a mouse. The record is src/lib/logbook.ts; where it is kept, and
// how a shared project's reaches everyone at once, src/lib/logbookStore.ts.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import DOMPurify from 'dompurify';
import { useStore } from '../lib/store';
import { drawnNote, toggleCheck } from '../lib/noteMarkdown';
import { useLive, reportPlace } from '../lib/liveRoom';
import { initials } from '../lib/presence';
import { CALL_NAMES, type CalendarEvent } from '../lib/calendar';
import { useCalendarAccess } from './Calendar';
import { fileGranolaNotes, projectMeetings } from '../lib/meetingNotes';
import {
  BOARD,
  INK_COLORS,
  INK_WIDTHS,
  LOGBOOK_TABS,
  actionItems,
  boardSvg,
  isLogbookTab,
  linkFrom,
  linkKind,
  linkTitle,
  linksIn,
  mergePad,
  newId,
  notesInOrder,
  pressureWidth,
  sameUrl,
  strokeNear,
  suggestedLinks,
  thinPoints,
  type InkTool,
  type LinkKind,
  type LogbookTab,
  type MeetingNote,
  type Notepad,
  type ProjectLink,
  type Stroke,
} from '../lib/logbook';
import { addStrokes, clearBoard, removeLink, removeNote, removeStrokes, saveLink, saveNote, savePad, sendInk, useLogbook, type LogbookView } from '../lib/logbookStore';
import { projectsOf, whenSaid, type Project } from '../lib/projects';
import { inDesktopApp, recorderBridge } from '../lib/recorder';
import { recordHere, stopRecording, useNotetaker } from '../lib/notetaker';
import type { View } from '../types.view';
import { CheckIcon, CloseIcon, CopyIcon, DownloadIcon, ExternalIcon, PlusIcon, TrashIcon, VideoIcon } from './icons';
import Experiments from './Experiments';

const newTodoId = () => (crypto.randomUUID ? crypto.randomUUID() : newId('t'));

/** Names for the people who wrote in the logbook: the room's members, the person themself, else the address. */
function useNames(): (email: string | undefined) => { name: string; color: string } {
  const { user } = useStore();
  const live = useLive();
  return useCallback(
    (email) => {
      const member = live.state?.members.find((item) => item.email === email);
      if (member) return { name: member.email === live.state?.me ? 'You' : member.name.split(' ')[0], color: member.color };
      if (email && user?.email && email.toLowerCase() === user.email.toLowerCase()) return { name: 'You', color: 'var(--accent)' };
      return { name: email?.split('@')[0] ?? 'Someone', color: 'var(--muted)' };
    },
    [live.state, user?.email],
  );
}

export default function Logbook({ project, section, onView }: { project: Project; section?: string; onView: (view: View) => void }) {
  const tab: LogbookTab = isLogbookTab(section) ? section : 'meetings';
  const book = useLogbook(project);
  const live = useLive();
  const shared = project.project.shared;
  useEffect(() => {
    if (shared) reportPlace({ tab: 'logbook', path: tab });
  }, [shared, tab]);
  const go = (next: LogbookTab) => onView({ kind: 'project', id: project.id, mode: 'logbook', section: next });
  const counts: Record<LogbookTab, number | null> = { experiments: book.log.experiments.length, meetings: book.log.notes.length, links: book.log.links.length, notepad: null, board: null };
  /** Who else is on each tab of the logbook right now. */
  const here = (id: LogbookTab) => (live.state?.members ?? []).filter((member) => member.email !== live.state?.me && member.place?.tab === 'logbook' && member.place.path === id && member.place.active);
  return (
    <div className="lb" style={{ '--pj': project.color } as CSSProperties}>
      <div className="lb-head">
        <nav className="lb-tabs" role="tablist" aria-label="Logbook">
          {LOGBOOK_TABS.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={`lb-tab${tab === item.id ? ' is-on' : ''}`} onClick={() => go(item.id)} title={item.note}>
              <TabIcon tab={item.id} />
              {item.label}
              {counts[item.id] ? <small>{counts[item.id]}</small> : null}
              {here(item.id).length ? (
                <span className="lb-tab-here">
                  {here(item.id).slice(0, 3).map((member) => (
                    <i key={member.email} style={{ background: member.color }} title={`${member.name} is here`} />
                  ))}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
        <span className="lb-where">
          {shared ? (
            <>
              <span className={`lb-live${live.status === 'live' ? ' is-on' : ''}`} />
              {book.writable ? `Shared with everyone in ${project.name} — changes show for all of you as they are made` : 'You can read this logbook; the owner and editors write in it'}
            </>
          ) : (
            'Kept in this browser until the project is shared — then everyone in it has it'
          )}
        </span>
      </div>
      {book.error ? (
        <p className="banner error lb-banner">
          {book.error}
          <button type="button" className="link-btn" onClick={book.reload}>
            Read it again
          </button>
        </p>
      ) : null}
      {tab === 'experiments' ? <Experiments project={project} book={book} /> : null}
      {tab === 'meetings' ? <Meetings project={project} book={book} onLinks={() => go('links')} /> : null}
      {tab === 'links' ? <Links project={project} book={book} /> : null}
      {tab === 'notepad' ? <NotepadTab project={project} book={book} /> : null}
      {tab === 'board' ? <Whiteboard project={project} book={book} /> : null}
    </div>
  );
}

function TabIcon({ tab }: { tab: LogbookTab }) {
  const paths: Record<LogbookTab, ReactNode> = {
    experiments: <path d="M9 3v6l-5 9a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3l-5-9V3M8 3h8M7 15h10" />,
    meetings: <path d="M4 6h16v12H4zM8 3v4M16 3v4M4 10h16" />,
    links: <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />,
    notepad: <path d="M6 3h9l3 3v15H6zM9 9h6M9 13h6M9 17h4" />,
    board: <path d="M4 20l4-1 11-11-3-3L5 16zM14 6l3 3" />,
  };
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[tab]}
    </svg>
  );
}

/** Meeting notes as drawn: a `- [ ]` line is a box to tick (noteMarkdown.ts), not a bullet reading "[ ]". */
const drawn = (text: string) => DOMPurify.sanitize(drawnNote(text).replace(/<a /g, '<a target="_blank" rel="noreferrer" '), { ADD_ATTR: ['target', 'role', 'aria-checked'] });

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

// --------------------------------------------------------------- meetings --

function Meetings({ project, book, onLinks }: { project: Project; book: LogbookView; onLinks: () => void }) {
  const { settings, user, collections, updateCollection } = useStore();
  const projects = useMemo(() => projectsOf(collections), [collections]);
  const connected = useCalendarAccess();
  const names = useNames();
  const [meetings, setMeetings] = useState<CalendarEvent[] | null>(null);
  const [fetching, setFetching] = useState<string | null>(null);
  const [writing, setWriting] = useState<MeetingNote | 'new' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const notes = useMemo(() => notesInOrder(book.log.notes), [book.log.notes]);
  const key = settings.granolaKey.trim();
  const me = user?.email ?? 'me';
  const meetingKeys = Object.keys(project.project.meetings ?? {}).join(',');
  useEffect(() => {
    if (!connected) return setMeetings(null);
    let gone = false;
    void projectMeetings(settings.googleClientId.trim(), project, projects)
      .then((events) => !gone && setMeetings(events))
      .catch(() => !gone && setMeetings(null));
    return () => {
      gone = true;
    };
    // The project's tags, not every change to the project, are what change its meetings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, project.id, meetingKeys]);
  const fetchNotes = useCallback(
    async (quiet = false) => {
      if (!key || !meetings) return;
      if (!quiet) setFetching('Asking Granola…');
      const result = await fileGranolaNotes(key, meetings, projects, me);
      if (result.error) setFetching(`Granola: ${result.error}`);
      else if (!quiet) setFetching(result.filed ? `${result.filed} filed.` : result.waiting.length ? `Granola has no notes yet for ${result.waiting.length === 1 ? 'one meeting' : `${result.waiting.length} meetings`}.` : 'Every meeting’s notes are here.');
      else setFetching(null);
    },
    [key, meetings, projects, me],
  );
  // What is due is filed as the tab opens.
  useEffect(() => {
    void fetchNotes(true);
  }, [fetchNotes]);

  const now = Date.now();
  const coming = (meetings ?? []).filter((event) => event.end.getTime() > now).slice(0, 6);
  const past = (meetings ?? []).filter((event) => event.end.getTime() <= now && !notes.some((note) => note.meeting === event.id)).reverse().slice(0, 4);
  const addTodo = (text: string) => {
    if (project.project.todos.some((todo) => todo.text.trim().toLowerCase() === text.trim().toLowerCase())) return;
    void updateCollection(project.id, { project: { ...project.project, todos: [...project.project.todos, { id: newTodoId(), text, done: false }] } });
  };
  const keep = (url: string, title: string, from: MeetingNote) => void saveLink(project, { id: newId('l'), url, title, note: `From ${from.title}, ${dayLabel(from.start)}`, pinned: false, by: me, at: new Date().toISOString(), from: from.id });
  const kept = new Set(book.log.links.map((link) => sameUrl(link.url)));
  const firstOpen = open ?? notes[0]?.id ?? null;

  return (
    <div className="lb-body lb-meetings">
      <aside className="lb-side">
        <section>
          <h3>Coming up</h3>
          {!connected ? (
            <p className="lb-quiet">Connect the calendar on the Calendar page, and this project’s meetings show here — tag them with the project from a meeting’s card.</p>
          ) : meetings === null ? (
            <p className="lb-quiet">Reading the calendar…</p>
          ) : coming.length ? (
            <ul className="lb-coming">
              {coming.map((event) => (
                <li key={event.id}>
                  <span className="lb-coming-when">
                    <b>{event.start.toLocaleDateString(undefined, { weekday: 'short' })}</b>
                    <small>{event.start.getDate()}</small>
                  </span>
                  <span className="lb-coming-what">
                    <b>{event.title}</b>
                    <small>
                      {timeOf(event.start.toISOString())}
                      {event.notetaker === 'granola' ? <span className="cal-granola sm" title="Granola takes the notes">G</span> : event.notetaker === 'reader' ? <span className="cal-reader-mark sm" title="Koios takes the notes, on the computer in the call">K</span> : null}
                    </small>
                  </span>
                  {event.meet ? (
                    <a className="cal-join" href={event.meet} target="_blank" rel="noreferrer" title={`Join the ${CALL_NAMES[event.callKind ?? 'video']} call`}>
                      <VideoIcon size={12} />
                      {event.callKind === 'zoom' ? 'Zoom' : 'Join'}
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="lb-quiet">Nothing in the next two weeks is tagged with {project.name}.</p>
          )}
        </section>
        {past.length ? (
          <section>
            <h3>Without notes yet</h3>
            <ul className="lb-coming is-past">
              {past.map((event) => (
                <li key={event.id}>
                  <span className="lb-coming-what">
                    <b>{event.title}</b>
                    <small>
                      {dayLabel(event.start.toISOString())} · {event.notetaker === 'granola' ? 'waiting for Granola' : event.notetaker === 'reader' ? 'not recorded' : 'no notetaker'}
                    </small>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <RecorderPanel project={project} writable={book.writable} />
        <section className="lb-granola">
          <h3>
            <span className="cal-granola">G</span> Granola
          </h3>
          <p className="lb-quiet">
            {key
              ? 'Meetings that ask Granola to take notes have them filed here once they end, for everyone in the project.'
              : 'Add your Granola key in Settings → Account → Meetings, and the notes of meetings that ask Granola are filed here when they end.'}
          </p>
          {key && book.writable ? (
            <button type="button" className="btn sm" onClick={() => void fetchNotes()} disabled={!meetings || fetching === 'Asking Granola…'}>
              Fetch notes now
            </button>
          ) : null}
          {fetching ? <p className="lb-quiet">{fetching}</p> : null}
        </section>
      </aside>
      <div className="lb-main">
        <div className="lb-main-head">
          <h2>Meeting notes</h2>
          <span className="lb-quiet">{notes.length ? `${notes.length} ${notes.length === 1 ? 'meeting' : 'meetings'}` : ''}</span>
          <span style={{ flex: 1 }} />
          {book.writable ? (
            <button type="button" className="btn sm" onClick={() => setWriting('new')}>
              <PlusIcon size={13} /> Write notes
            </button>
          ) : null}
        </div>
        {!notes.length ? (
          <div className="lb-empty">
            <b>No meeting notes yet</b>
            <p>Make a meeting on the Calendar for {project.name} with “Take notes with Granola”, and its notes land here when it ends. Or write a meeting’s notes in by hand.</p>
          </div>
        ) : (
          notes.map((note) => {
            const expanded = note.id === firstOpen;
            const items = actionItems(note.markdown);
            const links = linksIn(note.markdown, note.call ? [note.call] : []);
            const by = names(note.by);
            return (
              <article key={note.id} className={`lb-note${expanded ? ' is-open' : ''}`}>
                <button type="button" className="lb-note-head" onClick={() => setOpen(expanded ? '' : note.id)} aria-expanded={expanded}>
                  <span className="lb-note-date">
                    <b>{new Date(note.start).getDate()}</b>
                    <small>{new Date(note.start).toLocaleDateString(undefined, { month: 'short' })}</small>
                  </span>
                  <span className="lb-note-title">
                    <b>{note.title}</b>
                    <small>
                      {dayLabel(note.start)} · {timeOf(note.start)}
                      {note.attendees.length ? ` · ${note.attendees.length} ${note.attendees.length === 1 ? 'person' : 'people'}` : ''}
                    </small>
                  </span>
                  <span className={`lb-src is-${note.source}`}>{note.source === 'granola' ? 'Granola' : note.source === 'reader' ? 'Recorded by Koios' : 'Written here'}</span>
                </button>
                {expanded ? (
                  <div className="lb-note-body">
                    <div className="lb-note-text">
                      <div
                        className="md doc-shown"
                        dangerouslySetInnerHTML={{ __html: drawn(note.markdown) }}
                        onClick={(event) => {
                          // A box clicked is ticked in the Markdown itself, so the note and its action items agree.
                          const box = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-check]') : null;
                          if (!box || !book.writable) return;
                          void saveNote(project, { ...note, markdown: toggleCheck(note.markdown, Number(box.dataset.check)) });
                        }}
                      />
                      {note.transcript ? <Transcript text={note.transcript} /> : null}
                    </div>
                    <aside className="lb-note-aside">
                      {note.attendees.length ? (
                        <div>
                          <h4>Who was there</h4>
                          <div className="lb-people">
                            {note.attendees.slice(0, 10).map((person) => (
                              <span key={person} className="lb-person" title={person}>
                                {initials(person)}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {items.length ? (
                        <div>
                          <h4>Action items</h4>
                          <ul className="lb-actions">
                            {items.map((item) => {
                              const added = project.project.todos.some((todo) => todo.text.trim().toLowerCase() === item.toLowerCase());
                              return (
                                <li key={item}>
                                  <span>{item}</span>
                                  {book.writable ? (
                                    <button type="button" className={`lb-add${added ? ' is-done' : ''}`} onClick={() => addTodo(item)} disabled={added} title={added ? 'On the project’s to-do list' : 'Add to the project’s to-do list'}>
                                      {added ? <CheckIcon size={12} /> : <PlusIcon size={12} />}
                                      {added ? 'To-do' : 'To-do'}
                                    </button>
                                  ) : null}
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      ) : null}
                      {links.length ? (
                        <div>
                          <h4>Links mentioned</h4>
                          <ul className="lb-actions">
                            {links.map((link) => {
                              const isKept = kept.has(sameUrl(link.url));
                              return (
                                <li key={link.url}>
                                  <a href={link.url} target="_blank" rel="noreferrer" title={link.url}>
                                    {link.title}
                                  </a>
                                  {book.writable ? (
                                    <button type="button" className={`lb-add${isKept ? ' is-done' : ''}`} onClick={() => (isKept ? onLinks() : keep(link.url, link.title, note))} title={isKept ? 'In the project’s links' : 'Keep in the project’s links'}>
                                      {isKept ? <CheckIcon size={12} /> : <PlusIcon size={12} />}
                                      {isKept ? 'Kept' : 'Keep'}
                                    </button>
                                  ) : null}
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      ) : null}
                      <div className="lb-note-foot">
                        <small>
                          Filed by {by.name} · {whenSaid(note.at)}
                        </small>
                        <span className="lb-note-acts">
                          {note.url ? (
                            <a className="btn sm" href={note.url} target="_blank" rel="noreferrer">
                              <ExternalIcon size={12} /> Open in Granola
                            </a>
                          ) : null}
                          {book.writable && note.source === 'manual' ? (
                            <button type="button" className="btn sm" onClick={() => setWriting(note)}>
                              Edit
                            </button>
                          ) : null}
                          {book.writable ? (
                            <button type="button" className="icon-btn sm" aria-label="Delete these notes" title="Delete these notes" onClick={() => window.confirm(`Delete the notes of “${note.title}” for everyone?`) && void removeNote(project, note.id)}>
                              <TrashIcon size={13} />
                            </button>
                          ) : null}
                        </span>
                      </div>
                    </aside>
                  </div>
                ) : null}
              </article>
            );
          })
        )}
      </div>
      {writing ? <NoteWriter note={writing === 'new' ? null : writing} onClose={() => setWriting(null)} onSave={(note) => (void saveNote(project, { ...note, by: me }), setOpen(note.id), setWriting(null))} /> : null}
    </div>
  );
}

/** What was said, folded under the notes: open to read it, with a search that marks what it finds. */
function Transcript({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState('');
  const lines = text.split('\n');
  const shown = find.trim() ? lines.filter((line) => line.toLowerCase().includes(find.trim().toLowerCase())) : lines;
  return (
    <details className="lb-transcript" open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
      <summary>
        Transcript <small>{lines.length} turns</small>
      </summary>
      {open ? (
        <>
          <input className="lb-search" value={find} onChange={(change) => setFind(change.target.value)} placeholder="Find in the transcript" aria-label="Find in the transcript" />
          <ol className="lb-transcript-lines">
            {shown.map((line, index) => {
              const match = /^\[([\d:]+)\] ([^:]+): (.*)$/.exec(line);
              return match ? (
                <li key={index}>
                  <time>{match[1]}</time>
                  <b>{match[2]}</b>
                  <span>{match[3]}</span>
                </li>
              ) : (
                <li key={index}>
                  <span>{line}</span>
                </li>
              );
            })}
          </ol>
        </>
      ) : null}
    </details>
  );
}

/**
 * Reader's own notes, on the computer in the call: whether this computer can
 * take them, the recording on now, and a button to record a meeting the app
 * did not find — an in-person one, round a table.
 */
function RecorderPanel({ project, writable }: { project: Project; writable: boolean }) {
  const notes = useNotetaker();
  const bridge = recorderBridge();
  const active = notes.sessions.find((session) => session.status === 'recording' || session.status === 'starting');
  const here = active?.projectId === project.id;
  return (
    <section className="lb-granola lb-recorder">
      <h3>
        <span className="cal-reader-mark">K</span> Koios’s notes
      </h3>
      {!inDesktopApp() ? (
        <p className="lb-quiet">
          In the Koios app for Mac or Windows, Koios records a meeting on your computer — Zoom, Meet, Teams or Slack, with no bot in the call — and files its notes here.{' '}
          <a href="https://github.com/saurav717/reader/releases/latest" target="_blank" rel="noreferrer">
            Get the app
          </a>
        </p>
      ) : !bridge ? (
        <p className="lb-quiet">This computer cannot record meetings: Koios’s notes need macOS or Windows.</p>
      ) : notes.availability !== 'ready' ? (
        <p className="lb-quiet">{notes.availability === 'checking' ? 'Starting the recorder…' : notes.reason ?? 'The recorder is not ready.'}</p>
      ) : (
        <>
          <p className="lb-quiet">Meetings set to Koios notes are recorded on this computer as they open, and any other is offered. No bot joins.</p>
          {active ? (
            <button type="button" className="btn sm nt-stop" onClick={() => void stopRecording(active.windowId)}>
              <i aria-hidden="true" /> Stop {here ? 'this recording' : 'the recording on now'}
            </button>
          ) : writable ? (
            <button type="button" className="btn sm" onClick={() => void recordHere(project.id, `${project.name} meeting`)} title="Record the computer’s microphone and sound now: a meeting in the room, or a call Koios did not find">
              <span className="nt-rec sm" aria-hidden="true" /> Record a meeting now
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

function NoteWriter({ note, onClose, onSave }: { note: MeetingNote | null; onClose: () => void; onSave: (note: MeetingNote) => void }) {
  const start = note ? new Date(note.start) : new Date();
  const [title, setTitle] = useState(note?.title ?? '');
  const [day, setDay] = useState(`${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`);
  const [time, setTime] = useState(`${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`);
  const [text, setText] = useState(note?.markdown ?? '## Notes\n\n\n## Action items\n- [ ] ');
  return (
    <div className="cal-editor-shade" onPointerDown={(press) => press.target === press.currentTarget && onClose()}>
      <form
        className="cal-editor lb-writer"
        onSubmit={(submit) => {
          submit.preventDefault();
          const [y, m, d] = day.split('-').map(Number);
          const [hh, mm] = time.split(':').map(Number);
          if (!title.trim()) return;
          onSave({ id: note?.id ?? newId('m'), title: title.trim(), start: new Date(y, m - 1, d, hh || 0, mm || 0).toISOString(), source: 'manual', attendees: note?.attendees ?? [], markdown: text, by: '', at: new Date().toISOString() });
        }}
      >
        <h3>{note ? 'Edit the notes' : 'A meeting’s notes'}</h3>
        <input className="cal-editor-title" placeholder="Which meeting — e.g. Weekly sync, Supervisor 1:1" value={title} onChange={(change) => setTitle(change.target.value)} autoFocus required aria-label="Which meeting" />
        <div className="cal-editor-when">
          <input type="date" value={day} onChange={(change) => setDay(change.target.value)} aria-label="Date" />
          <input type="time" value={time} onChange={(change) => setTime(change.target.value)} aria-label="Time" />
        </div>
        <textarea rows={12} value={text} onChange={(change) => setText(change.target.value)} aria-label="Notes, in Markdown" className="lb-writer-text" />
        <p className="cal-editor-note">Markdown. Unticked boxes and a list under “Action items” become to-dos with one click; links are offered to the Links tab.</p>
        <div className="cal-editor-actions">
          <span style={{ flexGrow: 1 }} />
          <button type="button" className="btn sm" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary sm" disabled={!title.trim()} title={title.trim() ? undefined : 'Name the meeting first'}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ links --

const KIND_COLORS: Record<LinkKind, string> = { doc: '#2d64a0', sheet: '#1f8a70', slides: '#b27414', drive: '#5a7a2d', code: '#3a3a40', paper: '#8f2f2f', data: '#5a3ea8', video: '#c0392b', design: '#a0462d', notes: '#1f2b22', write: '#3c7a46', call: '#2d64a0', web: '#6f6c63' };
const KIND_LETTER: Record<LinkKind, string> = { doc: 'D', sheet: 'S', slides: 'P', drive: 'Dr', code: '</>', paper: 'Pa', data: 'Da', video: '▶', design: 'De', notes: 'N', write: 'TeX', call: '☎', web: '↗' };

const dismissedKey = (projectId: string) => `reader.logbook.dismissed:${projectId}`;
const readDismissed = (projectId: string): string[] => {
  try {
    const value = JSON.parse(localStorage.getItem(dismissedKey(projectId)) ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
};

function Links({ project, book }: { project: Project; book: LogbookView }) {
  const { user } = useStore();
  const names = useNames();
  const me = user?.email ?? 'me';
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<LinkKind | 'all'>('all');
  const [dismissed, setDismissed] = useState<string[]>(() => readDismissed(project.id));
  const [copied, setCopied] = useState<string | null>(null);
  const suggestions = useMemo(() => suggestedLinks(book.log.notes, book.log.links, dismissed).slice(0, 8), [book.log.notes, book.log.links, dismissed]);
  const dismiss = (link: string) => {
    const next = [...dismissed, link];
    setDismissed(next);
    try {
      localStorage.setItem(dismissedKey(project.id), JSON.stringify(next.slice(-300)));
    } catch {
      // only a convenience
    }
  };
  const add = (raw = url, name = title, from?: string) => {
    const link = linkFrom(raw);
    if (!link) return setProblem('That is not a link: it starts https://, or is a site’s address.');
    if (book.log.links.some((item) => sameUrl(item.url) === sameUrl(link))) return setProblem('That link is kept already.');
    void saveLink(project, { id: newId('l'), url: link, title: name.trim() || linkTitle(link), note: '', pinned: false, by: me, at: new Date().toISOString(), ...(from ? { from } : {}) });
    setUrl('');
    setTitle('');
    setProblem(null);
  };
  const kinds = [...new Set(book.log.links.map((link) => linkKind(link.url).kind))];
  const shown = book.log.links.filter((link) => (kind === 'all' || linkKind(link.url).kind === kind) && (!query.trim() || `${link.title} ${link.url} ${link.note}`.toLowerCase().includes(query.trim().toLowerCase())));
  const copy = (link: ProjectLink) => {
    void navigator.clipboard?.writeText(link.url).then(() => {
      setCopied(link.id);
      window.setTimeout(() => setCopied(null), 1400);
    });
  };
  return (
    <div className="lb-body lb-links">
      {book.writable ? (
        <form
          className="lb-addlink"
          onSubmit={(submit) => {
            submit.preventDefault();
            add();
          }}
        >
          <input value={url} onChange={(change) => (setUrl(change.target.value), setProblem(null))} placeholder="Paste a link — a doc, a dataset, a recording, a repo" aria-label="Link" />
          <input value={title} onChange={(change) => setTitle(change.target.value)} placeholder="What it is (optional)" aria-label="Its name" />
          <button type="submit" className="btn primary sm" disabled={!url.trim()}>
            <PlusIcon size={13} /> Keep
          </button>
          {problem ? <small className="lb-problem">{problem}</small> : null}
        </form>
      ) : null}
      {suggestions.length && book.writable ? (
        <section className="lb-suggest">
          <h3>
            Came up in meetings <small>— links in the notes that are not kept yet, so they are not lost in a chat</small>
          </h3>
          <div className="lb-suggest-row">
            {suggestions.map((item) => {
              const k = linkKind(item.url);
              return (
                <div key={item.url} className="lb-suggest-card">
                  <span className="lb-kind" style={{ background: KIND_COLORS[k.kind] }}>
                    {KIND_LETTER[k.kind]}
                  </span>
                  <span className="lb-suggest-text">
                    <b title={item.url}>{item.title}</b>
                    <small>
                      {k.label} · {item.from.title}, {dayLabel(item.from.start)}
                    </small>
                  </span>
                  <span className="lb-suggest-acts">
                    <button type="button" className="btn sm primary" onClick={() => add(item.url, item.title, item.from.id)}>
                      Keep
                    </button>
                    <button type="button" className="icon-btn sm" aria-label="Not this one" title="Not this one" onClick={() => dismiss(item.url)}>
                      <CloseIcon size={12} />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
      <div className="lb-links-bar">
        <h2>Links</h2>
        <div className="lb-chips" role="group" aria-label="Kind">
          <button type="button" className={`lb-chip${kind === 'all' ? ' is-on' : ''}`} onClick={() => setKind('all')}>
            All {book.log.links.length}
          </button>
          {kinds.map((item) => (
            <button key={item} type="button" className={`lb-chip${kind === item ? ' is-on' : ''}`} onClick={() => setKind(item)}>
              <i style={{ background: KIND_COLORS[item] }} />
              {linkKind(book.log.links.find((link) => linkKind(link.url).kind === item)!.url).label}
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <input className="lb-search" value={query} onChange={(change) => setQuery(change.target.value)} placeholder="Find a link" aria-label="Find a link" />
      </div>
      {!book.log.links.length ? (
        <div className="lb-empty">
          <b>No links kept yet</b>
          <p>The Overleaf draft, the results sheet, the dataset, the recording of last week’s meeting: keep them here, where everyone in the project finds them — and the links that come up in meetings are offered as they do.</p>
        </div>
      ) : (
        <div className="lb-grid">
          {shown.map((link) => {
            const k = linkKind(link.url);
            const by = names(link.by);
            let host = link.url;
            try {
              host = new URL(link.url).hostname.replace(/^www\./, '');
            } catch {
              // shown as it is
            }
            return (
              <article key={link.id} className={`lb-link${link.pinned ? ' is-pinned' : ''}`}>
                <a className="lb-link-main" href={link.url} target="_blank" rel="noreferrer">
                  <span className="lb-kind" style={{ background: KIND_COLORS[k.kind] }}>
                    {KIND_LETTER[k.kind]}
                  </span>
                  <span className="lb-link-text">
                    <b>{link.title}</b>
                    <small>
                      {k.label} · {host}
                    </small>
                  </span>
                </a>
                {link.note ? <p className="lb-link-note">{link.note}</p> : null}
                <div className="lb-link-foot">
                  <span className="lb-by" style={{ '--who': by.color } as CSSProperties}>
                    {by.name} · {whenSaid(link.at)}
                  </span>
                  <span className="lb-link-acts">
                    <button type="button" className="icon-btn sm" onClick={() => copy(link)} aria-label="Copy the link" title="Copy the link">
                      {copied === link.id ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                    </button>
                    {book.writable ? (
                      <>
                        <button type="button" className={`icon-btn sm lb-pin${link.pinned ? ' is-on' : ''}`} onClick={() => void saveLink(project, { ...link, pinned: !link.pinned })} aria-pressed={link.pinned} aria-label={link.pinned ? 'Unpin' : 'Pin to the top'} title={link.pinned ? 'Unpin' : 'Pin to the top'}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill={link.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
                            <path d="M9 3h6l-1 6 4 4H6l4-4zM12 13v8" />
                          </svg>
                        </button>
                        <button type="button" className="icon-btn sm" onClick={() => window.confirm(`Take “${link.title}” out of the links?`) && void removeLink(project, link.id)} aria-label="Remove" title="Remove">
                          <TrashIcon size={13} />
                        </button>
                      </>
                    ) : null}
                  </span>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- notepad --

type PadView = 'write' | 'split' | 'preview';

function NotepadTab({ project, book }: { project: Project; book: LogbookView }) {
  const { user } = useStore();
  const names = useNames();
  const me = user?.email ?? 'me';
  const remote = book.log.pad;
  const [text, setText] = useState(remote.text);
  /** The notepad as last kept: what a change is made on, and merged against. */
  const base = useRef<Notepad>(remote);
  const textRef = useRef(text);
  textRef.current = text;
  const [state, setState] = useState<'saved' | 'saving' | 'unsaved'>('saved');
  const [view, setView] = useState<PadView>(() => {
    try {
      const kept = localStorage.getItem('reader.logbook.pad');
      return kept === 'write' || kept === 'preview' ? kept : 'split';
    } catch {
      return 'split';
    }
  });
  const timer = useRef<number | undefined>(undefined);
  const area = useRef<HTMLTextAreaElement>(null);

  // A newer notepad from the room (someone else's change), taken in: as it is, when nothing is being typed here; merged, when it is.
  useEffect(() => {
    if (remote.version <= base.current.version) return;
    const mine = textRef.current;
    const next = mine === base.current.text ? remote.text : mergePad(base.current.text, mine, remote.text);
    base.current = remote;
    // Kept at once, not at the next render: a save answered in between merges against this text, not the one before it.
    textRef.current = next;
    if (next !== mine) {
      const caret = area.current?.selectionStart ?? null;
      setText(next);
      if (caret !== null) requestAnimationFrame(() => area.current?.setSelectionRange(Math.min(caret, next.length), Math.min(caret, next.length)));
    }
    if (next === remote.text) setState('saved');
  }, [remote]);

  const save = useCallback(async () => {
    const mine = textRef.current;
    if (mine === base.current.text) return setState('saved');
    setState('saving');
    const result = await savePad(project, mine, base.current.version, me);
    if (!result) return setState('unsaved');
    if (result.conflict) {
      // Someone else's change got there first: mine put on top of theirs, and saved again — unless the room's message
      // with their change was taken in already, in which case the text here has both.
      const merged = base.current.version >= result.pad.version ? textRef.current : mergePad(base.current.text, textRef.current, result.pad.text);
      base.current = result.pad;
      setText(merged);
      textRef.current = merged;
      return void save();
    }
    base.current = result.pad;
    setState(textRef.current === result.pad.text ? 'saved' : 'unsaved');
    if (textRef.current !== result.pad.text) timer.current = window.setTimeout(() => void save(), 600);
  }, [project, me]);

  const edit = (next: string) => {
    setText(next);
    setState('unsaved');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(), 700);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const insert = (snippet: string) => {
    const el = area.current;
    const at = el?.selectionStart ?? text.length;
    const lineStart = text.lastIndexOf('\n', at - 1) + 1;
    const before = text.slice(0, at);
    const lead = at === lineStart ? '' : '\n';
    edit(`${before}${lead}${snippet}${text.slice(at)}`);
    requestAnimationFrame(() => {
      const caret = (before + lead + snippet).length;
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };
  const setPadView = (next: PadView) => {
    setView(next);
    try {
      localStorage.setItem('reader.logbook.pad', next);
    } catch {
      // only a preference
    }
  };
  const last = remote.by ? names(remote.by) : null;
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  return (
    <div className="lb-body lb-pad">
      <div className="lb-pad-bar">
        {book.writable ? (
          <>
            <button type="button" className="btn sm" onClick={() => insert(`## ${today}\n`)}>
              Date
            </button>
            <button type="button" className="btn sm" onClick={() => insert('- [ ] ')}>
              Checkbox
            </button>
            <button type="button" className="btn sm" onClick={() => insert(`## Agenda — ${today}\n1. \n\n## Decisions\n- \n\n## Action items\n- [ ] \n`)}>
              Agenda
            </button>
          </>
        ) : null}
        <span style={{ flex: 1 }} />
        <span className={`lb-pad-state is-${state}`}>
          {state === 'saving' ? 'Saving…' : state === 'unsaved' ? 'Not saved yet' : last && remote.at ? `Saved · last edit ${last.name}, ${whenSaid(remote.at)}` : 'Saved'}
        </span>
        <div className="segmented sm" role="radiogroup" aria-label="Notepad view">
          {(['write', 'split', 'preview'] as const).map((item) => (
            <button key={item} type="button" role="radio" aria-checked={view === item} onClick={() => setPadView(item)}>
              {item === 'write' ? 'Write' : item === 'split' ? 'Both' : 'Read'}
            </button>
          ))}
        </div>
      </div>
      <div className={`lb-pad-panes is-${view}`}>
        {view !== 'preview' ? (
          <textarea
            ref={area}
            className="lb-pad-text"
            value={text}
            readOnly={!book.writable}
            onChange={(change) => edit(change.target.value)}
            onBlur={() => state === 'unsaved' && void save()}
            placeholder={book.writable ? 'Anything the project needs written down: the agenda for Friday, the numbers to beat, who has the GPU this week. Markdown.' : 'Nothing written yet.'}
            aria-label="Notepad"
            spellCheck
          />
        ) : null}
        {view !== 'write' ? <div className="lb-pad-preview md doc-shown" dangerouslySetInnerHTML={{ __html: drawn(text || '_Nothing written yet._') }} /> : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- whiteboard --

type BoardTool = InkTool | 'eraser';

/** The ink colour a stroke is drawn in: the board's own ink, in either theme, for the first (black) colour. */
const inkColor = (color: string, ink: string) => (color === INK_COLORS[0] ? ink : color);

function drawStroke(context: CanvasRenderingContext2D, stroke: Stroke, ink: string) {
  const p = stroke.points;
  if (!p.length) return;
  context.strokeStyle = inkColor(stroke.color, ink);
  context.fillStyle = context.strokeStyle;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  if (stroke.tool === 'marker') {
    // A marker is see-through and one width: the path drawn whole, so where it crosses itself it does not darken.
    context.globalAlpha = 0.32;
    context.lineWidth = pressureWidth(stroke.width, 0.5, 'marker');
    context.beginPath();
    context.moveTo(p[0], p[1]);
    for (let i = 3; i < p.length; i += 3) context.lineTo(p[i], p[i + 1]);
    if (p.length === 3) context.lineTo(p[0] + 0.1, p[1]);
    context.stroke();
    context.globalAlpha = 1;
    return;
  }
  if (p.length === 3) {
    context.beginPath();
    context.arc(p[0], p[1], pressureWidth(stroke.width, p[2], 'pen') / 2, 0, Math.PI * 2);
    context.fill();
    return;
  }
  // A pen's width follows the pressure: each stretch between midpoints drawn as a curve of its own width.
  let [mx, my] = [p[0], p[1]];
  for (let i = 3; i < p.length; i += 3) {
    const [x, y, pressure] = [p[i], p[i + 1], p[i + 2]];
    const [nx, ny] = i + 3 < p.length ? [(x + p[i + 3]) / 2, (y + p[i + 4]) / 2] : [x, y];
    context.lineWidth = pressureWidth(stroke.width, (pressure + p[i - 1]) / 2, 'pen');
    context.beginPath();
    context.moveTo(mx, my);
    context.quadraticCurveTo(x, y, nx, ny);
    context.stroke();
    [mx, my] = [nx, ny];
  }
}

function Whiteboard({ project, book }: { project: Project; book: LogbookView }) {
  const { user } = useStore();
  const live = useLive();
  const names = useNames();
  const me = user?.email ?? 'me';
  const [tool, setTool] = useState<BoardTool>('pen');
  const [color, setColor] = useState(INK_COLORS[0]);
  const [width, setWidth] = useState(INK_WIDTHS[1]);
  const [penOnly, setPenOnly] = useState(false);
  /** A stylus was seen: a touch is then the palm resting on the screen, not a stroke, when "Pen only" is on. */
  const [sawPen, setSawPen] = useState(false);
  const [erasing, setErasing] = useState<string[]>([]);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<{ stroke: Stroke; pointer: number; sent: number } | null>(null);
  const [scale, setScale] = useState(0.6);
  const [, redraw] = useState(0);
  const mine = book.log.strokes.filter((stroke) => stroke.by === me);

  // The board is fitted to the width there is, keeping its shape.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fit = () => setScale(Math.max(0.2, Math.min((el.clientWidth - 2) / BOARD.width, 1.2)));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const paint = useCallback(() => {
    const el = canvas.current;
    if (!el) return;
    const ratio = window.devicePixelRatio || 1;
    const w = Math.round(BOARD.width * scale);
    const h = Math.round(BOARD.height * scale);
    if (el.width !== Math.round(w * ratio)) {
      el.width = Math.round(w * ratio);
      el.height = Math.round(h * ratio);
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    }
    const context = el.getContext('2d');
    if (!context) return;
    context.setTransform(ratio * scale, 0, 0, ratio * scale, 0, 0);
    context.clearRect(0, 0, BOARD.width, BOARD.height);
    const ink = getComputedStyle(el).getPropertyValue('--ink').trim() || '#1a1a17';
    for (const stroke of book.log.strokes) if (!erasing.includes(stroke.id)) drawStroke(context, stroke, ink);
    for (const stroke of Object.values(book.ink)) drawStroke(context, stroke, ink);
    if (drawing.current) drawStroke(context, drawing.current.stroke, ink);
  }, [book.log.strokes, book.ink, erasing, scale]);
  useEffect(() => paint(), [paint]);

  const at = (event: { clientX: number; clientY: number; pressure: number; pointerType: string }): [number, number, number] => {
    const box = canvas.current!.getBoundingClientRect();
    return [(event.clientX - box.left) / scale, (event.clientY - box.top) / scale, event.pointerType === 'mouse' ? 0.5 : event.pressure || 0.5];
  };
  const refuses = (event: ReactPointerEvent) => !book.writable || (penOnly && sawPen && event.pointerType === 'touch');

  const down = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'pen' && !sawPen) setSawPen(true);
    if (refuses(event) || event.button > 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const [x, y, pressure] = at(event);
    if (tool === 'eraser' || (event.pointerType === 'pen' && event.button === 5)) {
      drawing.current = null;
      erase(x, y);
      return;
    }
    drawing.current = { pointer: event.pointerId, sent: 0, stroke: { id: newId('s'), by: me, color, width, tool, points: [x, y, pressure], at: new Date().toISOString() } };
    paint();
  };
  const erase = (x: number, y: number) => {
    const hit = book.log.strokes.filter((stroke) => !erasing.includes(stroke.id) && strokeNear(stroke, x, y, 10)).map((stroke) => stroke.id);
    if (hit.length) setErasing((current) => [...current, ...hit]);
  };
  const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (refuses(event)) return;
    if (tool === 'eraser' && event.buttons) {
      const [x, y] = at(event);
      return erase(x, y);
    }
    const current = drawing.current;
    if (!current || current.pointer !== event.pointerId) return;
    // Every point the pen reported since the last frame, not just the last: a quick stroke stays smooth.
    const events = 'getCoalescedEvents' in event.nativeEvent ? event.nativeEvent.getCoalescedEvents() : [];
    for (const item of events.length ? events : [event.nativeEvent]) current.stroke.points.push(...at(item));
    paint();
    if (Date.now() - current.sent > 80) {
      current.sent = Date.now();
      sendInk(project, { ...current.stroke, points: thinPoints(current.stroke.points) });
    }
  };
  const up = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (tool === 'eraser' || !drawing.current) {
      if (erasing.length) {
        const ids = erasing;
        void removeStrokes(project, ids).then(() => setErasing((current) => current.filter((id) => !ids.includes(id))));
      }
      return;
    }
    if (drawing.current.pointer !== event.pointerId) return;
    const stroke = { ...drawing.current.stroke, points: thinPoints(drawing.current.stroke.points) };
    drawing.current = null;
    void addStrokes(project, [stroke]);
    redraw((n) => n + 1);
  };
  const undo = () => {
    const last = mine[mine.length - 1];
    if (last) void removeStrokes(project, [last.id]);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !(event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement)) {
        event.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const download = () => {
    const blob = new Blob([boardSvg(book.log.strokes)], { type: 'image/svg+xml' });
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = `${project.name.replace(/[^\w-]+/g, '-')}-whiteboard.svg`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  };
  const drawingNow = Object.values(book.ink);
  const others = (live.state?.members ?? []).filter((member) => member.email !== live.state?.me && member.place?.tab === 'logbook' && member.place.path === 'board');
  return (
    <div className="lb-body lb-board">
      <div className="lb-board-bar">
        <div className="segmented sm" role="radiogroup" aria-label="Tool">
          {(
            [
              ['pen', 'Pen'],
              ['marker', 'Marker'],
              ['eraser', 'Eraser'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={tool === id} onClick={() => setTool(id)} disabled={!book.writable}>
              {label}
            </button>
          ))}
        </div>
        <div className="lb-swatches" role="radiogroup" aria-label="Colour">
          {INK_COLORS.map((item) => (
            <button key={item} type="button" role="radio" aria-checked={color === item} className={`lb-swatch${color === item ? ' is-on' : ''}${item === INK_COLORS[0] ? ' is-ink' : ''}`} style={{ background: item === INK_COLORS[0] ? undefined : item }} onClick={() => (setColor(item), tool === 'eraser' && setTool('pen'))} aria-label={item === INK_COLORS[0] ? 'Ink' : item} disabled={!book.writable} />
          ))}
        </div>
        <div className="lb-widths" role="radiogroup" aria-label="Width">
          {INK_WIDTHS.map((item) => (
            <button key={item} type="button" role="radio" aria-checked={width === item} className={`lb-width${width === item ? ' is-on' : ''}`} onClick={() => setWidth(item)} aria-label={`Width ${item}`} disabled={!book.writable}>
              <i style={{ width: item + 2, height: item + 2 }} />
            </button>
          ))}
        </div>
        <label className="lb-penonly" title="With a stylus, a hand resting on the screen draws nothing: only the pen does">
          <input type="checkbox" checked={penOnly} onChange={(change) => setPenOnly(change.target.checked)} />
          Pen only{sawPen ? ' · stylus seen' : ''}
        </label>
        <span style={{ flex: 1 }} />
        {others.length || drawingNow.length ? (
          <span className="lb-drawing">
            {[...new Set([...others.map((member) => member.email), ...drawingNow.map((stroke) => stroke.by)])].slice(0, 4).map((email) => {
              const who = names(email);
              const busy = drawingNow.some((stroke) => stroke.by === email);
              return (
                <span key={email} className="lb-drawer" style={{ '--who': who.color } as CSSProperties}>
                  <i />
                  {who.name}
                  {busy ? ' is drawing' : ''}
                </span>
              );
            })}
          </span>
        ) : null}
        <button type="button" className="btn sm" onClick={undo} disabled={!mine.length || !book.writable} title="Take back your last stroke (⌘Z)">
          Undo
        </button>
        <button type="button" className="btn sm" onClick={download} disabled={!book.log.strokes.length} title="The board as an SVG picture">
          <DownloadIcon size={13} /> Download
        </button>
        {book.writable ? (
          <button type="button" className="btn sm" onClick={() => book.log.strokes.length && window.confirm('Clear the whiteboard for everyone? Download it first to keep a copy.') && void clearBoard(project)} disabled={!book.log.strokes.length}>
            Clear
          </button>
        ) : null}
      </div>
      <div className="lb-board-wrap" ref={wrap}>
        <canvas
          ref={canvas}
          className={`lb-canvas is-${tool}${book.writable ? '' : ' is-readonly'}`}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          style={{ touchAction: penOnly && sawPen ? 'pan-x pan-y' : 'none' }}
          aria-label="Whiteboard"
        />
        {!book.log.strokes.length && !drawingNow.length ? <p className="lb-board-hint">{book.writable ? 'Draw here — with a stylus the line follows its pressure. Everyone in the project sees it as you draw.' : 'Nothing drawn yet.'}</p> : null}
      </div>
    </div>
  );
}
