// A project's logbook (src/lib/logbook.ts), the Granola notes filed in it
// (src/lib/granola.ts), and the calls the Calendar page puts on a meeting
// (src/lib/calendar.ts): what a link is, which links a meeting brought up,
// the action items in its notes, two people's notepad changes merged, the
// whiteboard's strokes thinned and erased, Granola's notes read and matched
// to their meetings, and Zoom on a Google event and back.
//
//   node --test scripts/logbook.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const log = await load('src/lib/logbook.ts');
const granola = await load('src/lib/granola.ts');
const cal = await load('src/lib/calendar.ts');
const route = await load('src/lib/route.ts');

after(cleanup);

const note = (over = {}) => ({ id: 'n1', title: 'Group meeting', start: '2026-10-14T03:30:00.000Z', source: 'granola', attendees: [], markdown: '', by: 'me@x.org', at: '2026-10-14T05:00:00.000Z', ...over });

describe('links', () => {
  it('says what a link is from where it points', () => {
    assert.equal(log.linkKind('https://docs.google.com/document/d/1abc/edit').kind, 'doc');
    assert.equal(log.linkKind('https://docs.google.com/presentation/d/1/edit').label, 'Google Slides');
    assert.equal(log.linkKind('https://github.com/lab/moe').kind, 'code');
    assert.equal(log.linkKind('https://arxiv.org/abs/2101.03961').kind, 'paper');
    assert.equal(log.linkKind('https://huggingface.co/datasets/c4').kind, 'data');
    assert.equal(log.linkKind('https://us02web.zoom.us/rec/share/abc').kind, 'video');
    assert.equal(log.linkKind('https://us02web.zoom.us/j/123').kind, 'call');
    assert.equal(log.linkKind('https://www.overleaf.com/project/1').kind, 'write');
    assert.equal(log.linkKind('https://example.org').kind, 'web');
    assert.equal(log.linkKind('not a link').kind, 'web');
  });
  it('keeps the same thing pasted twice once', () => {
    assert.equal(log.sameUrl('http://www.Example.org/a/?utm_source=x#top'), log.sameUrl('https://example.org/a'));
    assert.notEqual(log.sameUrl('https://example.org/a?id=1'), log.sameUrl('https://example.org/a?id=2'));
  });
  it('takes a link as typed, with or without its scheme', () => {
    assert.equal(log.linkFrom('github.com/lab/moe'), 'https://github.com/lab/moe');
    assert.equal(log.linkFrom(' https://x.org/a '), 'https://x.org/a');
    assert.equal(log.linkFrom('javascript:alert(1)'), null);
    assert.equal(log.linkFrom('two words'), null);
    assert.equal(log.linkFrom('localhost'), null);
  });
  it('finds the links a meeting brought up, named as the notes named them, without the call', () => {
    const markdown = [
      '## Notes',
      '- Priya shared the [ablation sheet](https://docs.google.com/spreadsheets/d/9/edit) — see tab 2.',
      '- Dataset: https://huggingface.co/datasets/c4.',
      '- Joined from https://us02web.zoom.us/j/123',
      '- https://github.com/lab/moe',
      '- Same sheet again: https://docs.google.com/spreadsheets/d/9/edit',
    ].join('\n');
    const found = log.linksIn(markdown);
    assert.deepEqual(found.map((link) => link.url), ['https://docs.google.com/spreadsheets/d/9/edit', 'https://huggingface.co/datasets/c4', 'https://github.com/lab/moe']);
    assert.equal(found[0].title, 'ablation sheet');
    assert.equal(found[1].title, 'Dataset');
    assert.equal(found[2].title, 'lab/moe');
    assert.equal(log.linksIn('Use the C4 subset from https://huggingface.co/datasets/c4 for every run')[0].title, 'c4 · huggingface.co');
    assert.equal(log.linkTitle('https://github.com/iith-ml/moe-routing/pull/41'), 'iith-ml/moe-routing #41');
  });
  it('suggests only what is not kept or waved away, newest meeting first', () => {
    const notes = [note({ id: 'old', start: '2026-10-01T00:00:00Z', markdown: 'https://a.org/x and https://b.org/y' }), note({ id: 'new', start: '2026-10-10T00:00:00Z', markdown: 'https://c.org/z' })];
    const links = [{ id: 'l', url: 'https://a.org/x', title: 'A', note: '', pinned: false, by: 'me', at: '2026-10-02T00:00:00Z' }];
    const suggested = log.suggestedLinks(notes, links, ['https://b.org/y']);
    assert.deepEqual(suggested.map((item) => [item.url, item.from.id]), [['https://c.org/z', 'new']]);
  });
  it('orders kept links pinned first, then newest', () => {
    const at = (id, pinned, when) => ({ id, url: `https://x.org/${id}`, title: id, note: '', pinned, by: 'me', at: when });
    assert.deepEqual(log.linksInOrder([at('a', false, '2026-01-03'), at('b', true, '2026-01-01'), at('c', false, '2026-01-05')]).map((l) => l.id), ['b', 'c', 'a']);
  });
});

describe('meeting notes', () => {
  it('reads the action items as Granola writes them, and unchecked boxes anywhere', () => {
    const markdown = ['### Discussion', '- Router collapses after 10k steps', '### Action Items', '- **Priya**: rerun with z-loss', '1. Saurav to draft §4', '', 'Then', '- Not an item', '- [ ] Book the GPU slot', '- [x] Done already'].join('\n');
    assert.deepEqual(log.actionItems(markdown), ['Priya: rerun with z-loss', 'Saurav to draft §4', 'Book the GPU slot']);
    assert.deepEqual(log.actionItems('**Next steps:**\n- Ship it'), ['Ship it']);
  });
  it('keeps one note per meeting and source, newest meeting first', () => {
    const a = note({ id: 'a', meeting: 'm1' });
    const b = note({ id: 'b', meeting: 'm1', markdown: 'again' });
    const c = note({ id: 'c', meeting: 'm2', start: '2026-10-20T00:00:00Z', source: 'manual' });
    const notes = log.withNote(log.withNote([a], b), c);
    assert.deepEqual(notes.map((n) => n.id), ['c', 'b']);
    assert.equal(log.hasNotesFor(notes, 'm1'), true);
    assert.equal(log.hasNotesFor(notes, 'm3', 'c'), true);
  });
});

describe('the notepad, two people at once', () => {
  it('keeps both changes made in different places', () => {
    const base = 'Agenda\n- results\n- plan\n';
    const mine = 'Agenda\n- results: 2D NS\n- plan\n';
    const theirs = 'Agenda\n- results\n- plan\n- camera-ready\n';
    assert.equal(log.mergePad(base, mine, theirs), 'Agenda\n- results: 2D NS\n- plan\n- camera-ready\n');
  });
  it('takes theirs when nothing of mine changed, mine when nothing of theirs did', () => {
    assert.equal(log.mergePad('a', 'a', 'b'), 'b');
    assert.equal(log.mergePad('a', 'b', 'a'), 'b');
  });
  it('keeps both where both changed the same stretch, theirs first', () => {
    const merged = log.mergePad('Title: draft', 'Title: final', 'Title: v2');
    assert.match(merged, /^Title: v2\nfinal$/);
  });
});

describe('the whiteboard', () => {
  it('thins a stroke’s points, keeping its ends, and rounds them', () => {
    const points = [];
    for (let i = 0; i <= 100; i++) points.push(i * 0.3333, 10, 0.51234);
    const thin = log.thinPoints(points, 1.5);
    assert.ok(thin.length < points.length / 3);
    assert.deepEqual(thin.slice(0, 3), [0, 10, 0.51]);
    assert.deepEqual(thin.slice(-3), [33.3, 10, 0.51]);
  });
  it('erases the strokes the eraser passes over, and no others', () => {
    const stroke = { id: 's', by: 'me', color: '#000000', width: 4, tool: 'pen', points: [0, 0, 0.5, 100, 0, 0.5], at: '' };
    assert.equal(log.strokeNear(stroke, 50, 3, 2), true);
    assert.equal(log.strokeNear(stroke, 50, 30, 2), false);
    assert.equal(log.strokeNear({ ...stroke, points: [10, 10, 0.5] }, 12, 10, 2), true);
  });
  it('draws a pen’s pressure as width, and a marker wide', () => {
    assert.ok(log.pressureWidth(4, 1, 'pen') > log.pressureWidth(4, 0.1, 'pen'));
    assert.equal(log.pressureWidth(4, 0.2, 'marker'), 12);
  });
  it('downloads as an SVG of the board', () => {
    const svg = log.boardSvg([{ id: 's', by: 'me', color: '#2d64a0', width: 4, tool: 'marker', points: [0, 0, 0.5, 10, 10, 0.5], at: '' }]);
    assert.match(svg, /^<svg[^>]+viewBox="0 0 1600 1000"/);
    assert.match(svg, /<path d="M0 0 L10 10"[^>]+stroke="#2d64a0"[^>]+stroke-opacity="0.35"/);
  });
});

describe('Granola', () => {
  const event = { id: 'lab:ev1_20261014T033000Z', eventId: 'ev1_20261014T033000Z', seriesId: 'ev1', calendarId: 'lab', title: 'Group meeting', start: new Date('2026-10-14T03:30:00Z'), end: new Date('2026-10-14T04:30:00Z'), allDay: false, attendees: [{ name: 'Priya Nair', email: 'priya@x.org', response: 'accepted', self: false }], status: 'confirmed', color: '#000', meet: 'https://us02web.zoom.us/j/1', callKind: 'zoom', notetaker: 'granola' };
  it('reads a note whichever version of the API wrote it', () => {
    const parsed = granola.parseGranolaNote({ id: 'not_1', title: null, created_at: '2026-10-14T04:31:00Z', web_url: 'https://notes.granola.ai/d/1', summary_markdown: '## Summary', calendar_event: { event_title: 'Group meeting', scheduled_start_time: '2026-10-14T03:30:00Z', invitees: [{ email: 'Priya@X.org' }] } });
    assert.deepEqual([parsed.title, parsed.url, parsed.markdown, parsed.start, parsed.attendees], ['Group meeting', 'https://notes.granola.ai/d/1', '## Summary', '2026-10-14T03:30:00.000Z', ['priya@x.org']]);
    assert.equal(granola.parseGranolaNote({ title: 'no id' }), null);
    assert.equal(granola.parseGranolaNote({ id: 'x', web_url: 'javascript:1' }).url, undefined);
  });
  it('matches a meeting by its calendar event, else by title at the same time, else by title written just after', () => {
    const byId = { id: 'a', title: 'Something else', createdAt: '2026-10-14T09:00:00.000Z', eventId: 'ev1_20261014T033000Z', markdown: '', attendees: [] };
    const bySlot = { id: 'b', title: 'Group Meeting!', createdAt: '2026-10-14T09:00:00.000Z', start: '2026-10-14T03:35:00.000Z', markdown: '', attendees: [] };
    const after = { id: 'c', title: 'group meeting', createdAt: '2026-10-14T04:40:00.000Z', markdown: '', attendees: [] };
    const otherDay = { id: 'd', title: 'Group meeting', createdAt: '2026-10-07T04:40:00.000Z', start: '2026-10-07T03:30:00.000Z', markdown: '', attendees: [] };
    assert.equal(granola.noteFor(event, [otherDay, bySlot, byId]).id, 'a');
    assert.equal(granola.noteFor(event, [otherDay, after, bySlot]).id, 'b');
    assert.equal(granola.noteFor(event, [otherDay, after]).id, 'c');
    assert.equal(granola.noteFor(event, [otherDay]), undefined);
  });
  it('waits until ten minutes after a meeting, and only for a fortnight', () => {
    const now = (iso) => new Date(iso);
    assert.equal(granola.meetingsDue([event], now('2026-10-14T04:35:00Z')).length, 0);
    assert.equal(granola.meetingsDue([event], now('2026-10-14T04:41:00Z')).length, 1);
    assert.equal(granola.meetingsDue([event], now('2026-11-14T04:41:00Z')).length, 0);
    assert.equal(granola.meetingsDue([{ ...event, notetaker: undefined }], now('2026-10-14T05:00:00Z')).length, 0);
  });
  it('files the note under the meeting, with its call and everyone who was there', () => {
    const filed = granola.noteOf({ id: 'not_1', title: 'x', createdAt: '', url: 'https://notes.granola.ai/d/1', markdown: '', attendees: ['lin@x.org', 'Priya@x.org'] }, event, 'me@x.org', new Date('2026-10-14T05:00:00Z'));
    assert.deepEqual([filed.id, filed.meeting, filed.source, filed.call, filed.by], ['granola:not_1', event.id, 'granola', 'https://us02web.zoom.us/j/1', 'me@x.org']);
    assert.deepEqual(filed.attendees, ['Priya Nair', 'lin@x.org']);
    assert.match(filed.markdown, /no summary/);
  });
});

describe('a meeting’s call', () => {
  const calendar = { id: 'primary', name: 'Me', color: '#1f5e52', primary: true, writable: true };
  const base = { id: 'e', summary: 'Sync', start: { dateTime: '2026-10-13T10:00:00Z' }, end: { dateTime: '2026-10-13T11:00:00Z' } };
  it('knows the service by the link’s host', () => {
    assert.equal(cal.callKindOf('https://meet.google.com/abc-defg-hij'), 'meet');
    assert.equal(cal.callKindOf('https://iith.zoom.us/j/123'), 'zoom');
    assert.equal(cal.callKindOf('https://teams.microsoft.com/l/meetup-join/x'), 'teams');
    assert.equal(cal.callKindOf('https://zoom.us.evil.org/j/1'), null);
  });
  it('takes a Zoom link only as one: a meeting, a room or a webinar', () => {
    assert.equal(cal.zoomLink('zoom.us/j/1234567890?pwd=ab'), 'https://zoom.us/j/1234567890?pwd=ab');
    assert.equal(cal.zoomLink('https://iith.zoom.us/my/saurav'), 'https://iith.zoom.us/my/saurav');
    assert.equal(cal.zoomLink('https://zoom.us/pricing'), null);
    assert.equal(cal.zoomLink('https://meet.google.com/abc'), null);
  });
  it('finds a call in where the meeting is, or in what it says', () => {
    assert.equal(cal.parseEvent({ ...base, location: 'https://iith.zoom.us/j/99' }, calendar).callKind, 'zoom');
    const described = cal.parseEvent({ ...base, description: '<p>Join: <a href="https://teams.microsoft.com/l/meetup-join/1">here</a></p>' }, calendar);
    assert.deepEqual([described.callKind, described.meet], ['teams', 'https://teams.microsoft.com/l/meetup-join/1']);
    assert.equal(cal.parseEvent(base, calendar).meet, undefined);
  });
  it('writes a Zoom call and Granola onto Google’s event, and reads them back', () => {
    const draft = { ...cal.emptyDraft('primary', new Date('2026-10-13T10:00:00Z')), title: 'Sync', description: 'Bring numbers', call: 'zoom', zoom: 'zoom.us/j/42', notes: 'granola' };
    assert.equal(cal.draftProblem(draft), null);
    const body = cal.toGoogleEvent(draft);
    assert.equal(body.location, 'https://zoom.us/j/42');
    assert.equal(body.description, 'Join Zoom: https://zoom.us/j/42\n\nBring numbers');
    assert.deepEqual(body.extendedProperties.private, { readerZoom: 'https://zoom.us/j/42', readerNotes: 'granola' });
    assert.equal(body.conferenceData, undefined);
    const event = cal.parseEvent({ ...base, ...body, start: base.start, end: base.end }, calendar);
    assert.deepEqual([event.callKind, event.meet, event.notetaker], ['zoom', 'https://zoom.us/j/42', 'granola']);
    // Edited: the Zoom line is the call's, not the person's, and is not doubled.
    const again = cal.draftOf(event);
    assert.deepEqual([again.call, again.zoom, again.notes, again.description], ['zoom', 'https://zoom.us/j/42', 'granola', 'Bring numbers']);
    assert.equal(cal.parseEvent({ ...base, extendedProperties: { private: { readerNotes: 'reader' } } }, calendar).notetaker, 'reader');
    assert.equal(cal.parseEvent({ ...base, extendedProperties: { private: { readerNotes: 'someone-else' } } }, calendar).notetaker, undefined);
    assert.equal(cal.toGoogleEvent(again).description, body.description);
    // Taken off: both kept keys emptied, so a PATCH clears them.
    assert.deepEqual(cal.toGoogleEvent({ ...again, call: 'none', notes: 'none' }).extendedProperties.private, { readerZoom: '', readerNotes: '' });
  });
  it('wants a Zoom link that is one before it saves', () => {
    const draft = { ...cal.emptyDraft('primary', new Date('2026-10-13T10:00:00Z')), call: 'zoom', zoom: '' };
    assert.match(cal.draftProblem(draft), /Paste the Zoom/);
    assert.match(cal.draftProblem({ ...draft, zoom: 'https://example.org' }), /not a Zoom meeting/);
  });
});

describe('the logbook’s address', () => {
  it('opens on a tab of its own, and says which', () => {
    const view = { kind: 'project', id: 'p1', mode: 'logbook', section: 'board' };
    assert.equal(route.pathFor({ view }, '/reader/'), '/reader/project/?id=p1&view=logbook&section=board');
    assert.deepEqual(route.placeFor('/reader/project/?id=p1&view=logbook&section=board', '/reader/').view, view);
    assert.deepEqual(route.placeFor('/reader/project/?id=p1&view=logbook', '/reader/').view, { kind: 'project', id: 'p1', mode: 'logbook' });
    assert.deepEqual(route.placeFor('/reader/project/?id=p1&view=write&section=board', '/reader/').view, { kind: 'project', id: 'p1', mode: 'write' });
  });
});

describe('Reader’s own notes (src/lib/recorder.ts)', async () => {
  const rec = await load('src/lib/recorder.ts');
  const at = (h, m = 0) => new Date(`2026-10-15T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  const ev = (over) => ({ id: over.id, eventId: over.id, calendarId: 'c', title: 'Meeting', start: at(9), end: at(10), allDay: false, attendees: [], status: 'confirmed', color: '#000', ...over });

  it('knows one call by its link, whatever else the link carries', () => {
    assert.equal(rec.callKey('https://iith.zoom.us/j/8123456789?pwd=abc'), rec.callKey('https://zoom.us/j/8123456789'));
    assert.equal(rec.callKey('https://zoom.us/wc/8123456789/join?fromPWA=1'), 'zoom:8123456789');
    assert.equal(rec.callKey('https://zoom.us/my/Saurav'), 'zoom:my:saurav');
    assert.equal(rec.callKey('https://meet.google.com/ABC-defg-hij?authuser=1'), 'meet:abc-defg-hij');
    assert.equal(rec.callKey('https://teams.microsoft.com/l/meetup-join/19%3ameeting_NjQ%40thread.v2/0?context=x'), 'teams:19:meeting_njq@thread.v2');
    assert.equal(rec.callKey('https://example.org/j/123456789'), null);
    assert.equal(rec.callKey(undefined), null);
  });

  it('finds the calendar event of a meeting on the computer: its call, else its title, else the one call on now', () => {
    const weekly = ev({ id: 'w', title: 'MoE weekly', meet: 'https://iith.zoom.us/j/8123456789' });
    const lastWeek = ev({ id: 'w0', title: 'MoE weekly', meet: 'https://iith.zoom.us/j/8123456789', start: new Date(at(9).getTime() - 7 * 86_400_000), end: new Date(at(10).getTime() - 7 * 86_400_000) });
    const lunch = ev({ id: 'l', title: 'Lunch', start: at(9), end: at(10) });
    const now = at(9, 5);
    assert.equal(rec.eventFor({ id: '1', url: 'https://zoom.us/j/8123456789?pwd=x' }, [lastWeek, lunch, weekly], now).id, 'w');
    assert.equal(rec.eventFor({ id: '2', title: 'MoE Weekly' }, [lunch, weekly], now).id, 'w');
    assert.equal(rec.eventFor({ id: '3', title: 'Zoom' }, [lunch, weekly], now).id, 'w', 'the one meeting with a call on now');
    assert.equal(rec.eventFor({ id: '4', url: 'https://meet.google.com/xyz-abcd-efg' }, [lunch, weekly], now), undefined, 'another call is not this one');
    assert.equal(rec.eventFor({ id: '5', url: 'https://zoom.us/j/8123456789' }, [weekly], at(13)), undefined, 'not on now');
  });

  it('puts what is said together, a turn per speaker', () => {
    let turns = [];
    turns = rec.withSpeech(turns, { words: [{ text: 'So' }, { text: 'the' }, { text: 'router' }, { text: 'collapses' }, { text: '.' }], participant: { name: 'Priya Natarajan' } });
    turns = rec.withSpeech(turns, { words: [{ text: 'After', start_timestamp: { relative: 12 } }, { text: '40k' }, { text: 'steps' }], participant: { name: 'Priya Natarajan' } });
    turns = rec.withSpeech(turns, { words: [{ text: 'With', start_timestamp: { relative: 75 } }, { text: 'z-loss' }, { text: '?' }], participant: { id: 2, name: null } });
    turns = rec.withSpeech(turns, { words: [], participant: { name: 'Nobody' } });
    assert.deepEqual(turns.map((turn) => [turn.speaker, turn.text]), [['Priya Natarajan', 'So the router collapses. After 40k steps'], ['Speaker 2', 'With z-loss?']]);
    assert.equal(rec.transcriptText(turns), '[0:00] Priya Natarajan: So the router collapses. After 40k steps\n[1:15] Speaker 2: With z-loss?');
    assert.equal(rec.wordCount(turns), 9);
  });

  it('asks for the write-up in the shape the logbook reads, with the project and the transcript', () => {
    const turns = [{ speaker: 'Priya', text: 'I will rerun it.', at: 0 }];
    const prompt = rec.summaryPrompt({ title: 'MoE weekly', start: at(9), project: 'Sparse-gated MoE', question: 'No aux loss?', attendees: ['Priya'] }, turns);
    assert.match(prompt.system, /### Action items/);
    assert.match(prompt.system, /Do not invent/);
    assert.match(prompt.user, /Project: Sparse-gated MoE — No aux loss\?/);
    assert.match(prompt.user, /<transcript>\n\[0:00\] Priya: I will rerun it\.\n<\/transcript>/);
    const long = rec.summaryPrompt({ title: 'x', start: at(9), attendees: [] }, [{ speaker: 'A', text: 'w '.repeat(80_000), at: 0 }]);
    assert.match(long.user, /the start of the meeting is left out/);
  });

  it('files the notes under the meeting, with the transcript and who spoke', () => {
    const weekly = ev({ id: 'c:w', title: 'MoE weekly', meet: 'https://zoom.us/j/1', attendees: [{ name: 'Priya Natarajan', email: 'p@x.org', response: 'accepted', self: false }] });
    const turns = [{ speaker: 'Marco Ruiz', text: 'Merged.', at: 3 }, { speaker: 'Speaker 4', text: 'Hi.', at: 9 }];
    const note = rec.recordedNote({ event: weekly, found: { id: 'win' }, started: at(9), ended: at(10), turns, markdown: '### Summary\n- Merged', by: 'me@x.org', now: at(10) });
    assert.equal(note.source, 'reader');
    assert.equal(note.meeting, 'c:w');
    assert.equal(note.call, 'https://zoom.us/j/1');
    assert.deepEqual(note.attendees, ['Priya Natarajan', 'Marco Ruiz']);
    assert.match(note.transcript, /^\[0:03\] Marco Ruiz: Merged\./);
    const bare = rec.recordedNote({ found: { id: 'win', title: 'Huddle', url: 'https://meet.google.com/a' }, started: at(9), ended: at(9, 20), turns: [], markdown: '', by: 'me' });
    assert.deepEqual([bare.title, bare.meeting, bare.call, bare.end], ['Huddle', undefined, 'https://meet.google.com/a', at(9, 20).toISOString()]);
    assert.match(bare.markdown, /too little said/);
  });
});
