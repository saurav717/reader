// The Usage page's Invitations tab (the owner's): who invited whom, by
// project, by mail or by a personal link, how many took, and who — the
// ledger in worker/invites.js, read as /usage/invites.

import { useEffect, useState } from 'react';
import { invitesReport, type InvitesReport, type InviteTally } from '../lib/invites';
import { initials, whenSeen } from '../lib/presence';

const HOW: Record<'project' | 'mail' | 'link', string> = { project: 'project invitation', mail: 'email', link: 'link' };

export default function InvitesReportView() {
  const [report, setReport] = useState<InvitesReport | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    let live = true;
    void invitesReport()
      .then((body) => live && setReport(body))
      .catch((e: Error) => live && (setError(e.message), setReport(null)));
    return () => {
      live = false;
    };
  }, []);
  if (report === undefined) return <p className="collection-sub">Reading the ledger…</p>;
  if (!report) return <p className="banner warn">{error ?? 'The ledger could not be read.'}</p>;
  const needle = query.trim().toLowerCase();
  const people = needle ? report.people.filter((person) => person.email.includes(needle) || person.name.toLowerCase().includes(needle)) : report.people;
  const sent = (person: InviteTally) => person.sent.project + person.sent.mail + person.sent.link;
  const took = (person: InviteTally) => person.converted.project + person.converted.mail + person.converted.link;
  const rate = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '—');

  return (
    <div className="invites-report">
      <div className="invites-totals">
        <div className="invites-tile">
          <span>Invitations</span>
          <b>{report.totals.sent}</b>
          <small>sent or made, by {report.people.length} {report.people.length === 1 ? 'person' : 'people'}</small>
        </div>
        <div className="invites-tile">
          <span>Took</span>
          <b>{report.totals.converted}</b>
          <small>joined, signed in, or signed in from a link</small>
        </div>
        <div className="invites-tile">
          <span>Rate</span>
          <b>{rate(report.totals.converted, report.totals.sent)}</b>
          <small>of invitations that took</small>
        </div>
        <input className="invites-find" placeholder="Find a person…" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Find a person" />
      </div>
      {!people.length ? (
        <p className="collection-sub">{needle ? 'Nobody by that name.' : 'No invitations yet. They show here as people share projects and invite others.'}</p>
      ) : (
        <table className="invites-table">
          <thead>
            <tr>
              <th>Person</th>
              <th className="n">Project</th>
              <th className="n">Email</th>
              <th className="n">Link</th>
              <th className="n">Sent</th>
              <th className="n">Took</th>
              <th className="n">Rate</th>
              <th className="n">Last</th>
            </tr>
          </thead>
          <tbody>
            {people.map((person) => (
              <PersonRows key={person.email} person={person} open={open === person.email} onToggle={() => setOpen(open === person.email ? null : person.email)} sent={sent(person)} took={took(person)} rate={rate(took(person), sent(person))} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PersonRows({ person, open, onToggle, sent, took, rate }: { person: InviteTally; open: boolean; onToggle: () => void; sent: number; took: number; rate: string }) {
  const pair = (a: number, b: number) => (a ? `${b}/${a}` : '—');
  return (
    <>
      <tr className={`invites-row${open ? ' is-open' : ''}`} onClick={onToggle} aria-expanded={open}>
        <td>
          <span className="invites-who">
            <span className="pj-av" style={{ background: '#1f5e52' }}>
              {initials(person.name || person.email)}
            </span>
            <span>
              <b>{person.name || person.email}</b>
              {person.name ? <small>{person.email}</small> : null}
            </span>
          </span>
        </td>
        <td className="n" title="joined / invited to a project">{pair(person.sent.project, person.converted.project)}</td>
        <td className="n" title="signed in / emailed">{pair(person.sent.mail, person.converted.mail)}</td>
        <td className="n" title="links someone signed in from / links made">{pair(person.sent.link, person.converted.link)}</td>
        <td className="n">{sent}</td>
        <td className="n">{took}</td>
        <td className="n">{rate}</td>
        <td className="n">{whenSeen(person.last)}</td>
      </tr>
      {open ? (
        <tr className="invites-detail">
          <td colSpan={8}>
            {person.people.length ? (
              <ul>
                {person.people.map((who, index) => (
                  <li key={`${who.email}:${who.at}:${index}`}>
                    <span className="pj-av" style={{ background: '#8a3a6e' }}>
                      {initials(who.name || who.email)}
                    </span>
                    <b>{who.name || who.email}</b>
                    {who.name ? <small>{who.email}</small> : null}
                    <span className="invites-how">
                      {who.how === 'project' ? `joined ${who.project || 'a project'} (${HOW.project})` : who.how === 'mail' ? `signed in after an ${HOW.mail}` : `signed in from a ${HOW.link}${who.note ? ` — “${who.note.slice(0, 80)}${who.note.length > 80 ? '…' : ''}”` : ''}`}
                    </span>
                    <span className="invites-when">{whenSeen(who.at)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>Nobody has taken one of {person.name || person.email}’s invitations up yet.</p>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}
