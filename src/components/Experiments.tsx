// The Experiments tab of a project's logbook: every simulation run filed as
// it ended (src/lib/experiments.ts, src/lib/experimentFiling.ts) — a line
// each, newest first, open to its notes, its numbers, its findings, the
// agents' notes, and where its files are. Notes can be written here by the
// model the app is set to, or asked of Claude Code or Codex on the machine;
// files can be moved to a computer of yours, or back to Drive.

import DOMPurify from 'dompurify';
import { useMemo, useState } from 'react';
import type { LogbookView } from '../lib/logbookStore';
import { removeExperiment } from '../lib/logbookStore';
import type { Project } from '../lib/projects';
import type { Experiment } from '../lib/experiments';
import { cliNotesRequest, experimentLine, toneOf } from '../lib/experiments';
import { moveExperiment, notesModel, setExperimentPrefs, useExperimentPrefs, writeNotes } from '../lib/experimentFiling';
import { markdown } from '../lib/markdown';
import { usePlaygrounds, useServers } from '../lib/playground';
import { ago } from '../lib/playgroundRuns';
import { queueCliRequest } from './CliAgent';
import { shortModelName } from './ModelChip';
import { modelSpec } from '../lib/assistant';
import { short } from '../lib/telemetry';

const g = (n: number) => (Number.isFinite(n) ? Number(n.toPrecision(4)).toString() : '—');

export default function Experiments({ project, book }: { project: Project; book: LogbookView }) {
  const prefs = useExperimentPrefs();
  const servers = useServers();
  const playgrounds = usePlaygrounds();
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const list = book.log.experiments;
  const model = notesModel();
  const modelName = shortModelName(modelSpec(model).label);
  const key = (exp: Experiment) => `${exp.playgroundId}:${exp.id}`;
  const say = (exp: Experiment, text: string | null) => setBusy((now) => (text ? { ...now, [key(exp)]: text } : Object.fromEntries(Object.entries(now).filter(([k]) => k !== key(exp)))));

  const notes = async (exp: Experiment) => {
    say(exp, `Writing with ${modelName}…`);
    try {
      await writeNotes(exp, { playground: playgrounds.find((p) => p.id === exp.playgroundId), project, onText: (text) => setDraft((now) => ({ ...now, [key(exp)]: text })) });
    } catch (error) {
      say(exp, error instanceof Error ? error.message : String(error));
      return;
    }
    setDraft((now) => Object.fromEntries(Object.entries(now).filter(([k]) => k !== key(exp))));
    say(exp, null);
  };
  const askCli = (exp: Experiment, agent: 'claude' | 'codex') => {
    queueCliRequest(exp.playgroundId, agent, cliNotesRequest(exp, `runs/${exp.id}`));
    say(exp, `${agent === 'claude' ? 'Claude Code' : 'Codex'} is asked: open the playground’s agent pane on that machine and it takes the request up; its summary.md lands in runs/${exp.id}.`);
  };
  const move = async (exp: Experiment, to: 'drive' | { serverId: string }) => {
    try {
      await moveExperiment(exp, to, project, (step) => say(exp, step));
      say(exp, null);
    } catch (error) {
      say(exp, error instanceof Error ? error.message : String(error));
    }
  };

  const counts = useMemo(() => ({ good: list.filter((e) => toneOf(e) === 'good').length, bad: list.filter((e) => toneOf(e) === 'bad').length }), [list]);

  return (
    <section className="lb-section xp">
      <div className="xp-bar">
        <label className="xp-pref">
          <input type="checkbox" checked={prefs.autoFile} onChange={(event) => setExperimentPrefs({ autoFile: event.target.checked })} /> File runs as they end
        </label>
        <label className="xp-pref">
          Files go to{' '}
          <select value={prefs.where === 'drive' ? 'drive' : prefs.where.serverId} onChange={(event) => setExperimentPrefs({ where: event.target.value === 'drive' ? 'drive' : { serverId: event.target.value } })}>
            <option value="drive">Google Drive (Experiments/…)</option>
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.name}
              </option>
            ))}
          </select>
        </label>
        <label className="xp-pref">
          Notes by{' '}
          <select value={prefs.notes} onChange={(event) => setExperimentPrefs({ notes: event.target.value as typeof prefs.notes })}>
            <option value="model">{modelName} (Ask AI’s model)</option>
            <option value="cli">Claude Code / Codex, when asked</option>
            <option value="off">no one</option>
          </select>
        </label>
        <span className="lb-quiet">
          {list.length ? `${list.length} ${list.length === 1 ? 'experiment' : 'experiments'}${counts.good ? ` · ${counts.good} improving` : ''}${counts.bad ? ` · ${counts.bad} to look at` : ''}` : ''}
        </span>
      </div>
      {!list.length ? (
        <p className="lb-empty">
          No experiments yet. A simulation run in this project&rsquo;s playground is filed here as it ends — its numbers, videos and scene, with notes written by {modelName} — and its files go to {prefs.where === 'drive' ? 'your Google Drive' : servers.find((s) => s.id === (prefs.where as { serverId: string }).serverId)?.name ?? 'a computer of yours'}.
          Start one from the Playground&rsquo;s <b>A simulation</b>, or run <code>python koios_telemetry.py use &lt;simulator&gt;</code> in any project.
        </p>
      ) : (
        <ol className="xp-list">
          {list.map((exp) => {
            const k = key(exp);
            const isOpen = open === k;
            const tone = toneOf(exp);
            const live = draft[k];
            return (
              <li key={k} className={`xp-item is-${tone}${isOpen ? ' is-open' : ''}`}>
                <button type="button" className="xp-row" onClick={() => setOpen(isOpen ? null : k)} aria-expanded={isOpen}>
                  <span className={`xp-pill is-${tone}`}>{exp.status === 'crashed' ? 'crashed' : tone === 'good' ? 'improving' : tone === 'bad' ? 'look' : exp.status}</span>
                  <b>{exp.title}</b>
                  <span className="xp-line">{experimentLine(exp)}</span>
                  <span className="xp-when" title={exp.ended}>
                    {exp.playground} · {ago(Date.parse(exp.ended))}
                  </span>
                </button>
                {isOpen ? (
                  <div className="xp-body">
                    <div className="xp-facts">
                      {exp.sim ? <span className="mono">{exp.sim}</span> : null}
                      <span>{short(exp.steps)} steps</span>
                      <span>{exp.episodes} episodes</span>
                      {exp.returns ? <span>return {g(exp.returns.first)} → {g(exp.returns.last)}, best {g(exp.returns.best)}</span> : null}
                      {exp.success !== undefined ? <span>{exp.success}% success</span> : null}
                      {exp.machine ? <span>{exp.machine}</span> : null}
                      <span>
                        files: {exp.where.link ? (
                          <a href={exp.where.link} target="_blank" rel="noreferrer noopener">
                            {exp.where.label} ↗
                          </a>
                        ) : (
                          `${exp.where.label}, ${exp.where.path}`
                        )}
                      </span>
                    </div>
                    {exp.summary || live ? (
                      <div className="xp-notes">
                        <div className="rt-part-label">
                          Notes <small>· {live ? `${modelName}, writing…` : `${exp.summary!.by}, ${ago(Date.parse(exp.summary!.at))}`}</small>
                        </div>
                        <div className="md xp-md" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(markdown(live ?? exp.summary!.text)) }} />
                      </div>
                    ) : null}
                    {exp.findings.length ? (
                      <ul className="sim-findings">
                        {exp.findings.map((f) => (
                          <li key={f.id} className={`is-${f.level}`}>
                            <b>{f.title}</b>
                            <span>{f.detail}</span>
                            <span className="sim-try">Try: {f.try}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {Object.keys(exp.last).length ? (
                      <table className="xp-table">
                        <tbody>
                          {Object.entries(exp.last).map(([name, value]) => (
                            <tr key={name}>
                              <th>{name}</th>
                              <td>{g(value)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : null}
                    {exp.notes.length ? (
                      <ol className="sim-notes">
                        {exp.notes.map((note, index) => (
                          <li key={index}>
                            <span className={`sim-by is-${note.by}`}>{note.by}</span>
                            <span className="sim-at">step {short(note.step)}</span>
                            <span>{note.text}</span>
                          </li>
                        ))}
                      </ol>
                    ) : null}
                    {exp.files.length ? (
                      <p className="lb-quiet">
                        {exp.files.map((f) => f.path).join(' · ')}
                        {exp.leftOut.length ? ` · left on the machine: ${exp.leftOut.join(', ')}` : ''}
                      </p>
                    ) : null}
                    <div className="xp-acts">
                      {book.writable ? (
                        <>
                          <button type="button" className="btn sm" disabled={Boolean(busy[k])} onClick={() => void notes(exp)}>
                            {exp.summary ? 'Notes again' : 'Write notes'} with {modelName}
                          </button>
                          <button type="button" className="btn sm" onClick={() => askCli(exp, 'claude')}>
                            Ask Claude Code
                          </button>
                          <button type="button" className="btn sm" onClick={() => askCli(exp, 'codex')}>
                            Ask Codex
                          </button>
                          <select className="xp-move" value="" onChange={(event) => event.target.value && void move(exp, event.target.value === 'drive' ? 'drive' : { serverId: event.target.value })} aria-label="Move the files">
                            <option value="">Move files to…</option>
                            {exp.where.kind !== 'drive' ? <option value="drive">Google Drive</option> : null}
                            {servers
                              .filter((server) => server.id !== exp.where.serverId)
                              .map((server) => (
                                <option key={server.id} value={server.id}>
                                  {server.name}
                                </option>
                              ))}
                          </select>
                          <button type="button" className="btn sm ghost" onClick={() => void removeExperiment(project, exp)}>
                            Remove from the logbook
                          </button>
                        </>
                      ) : null}
                      {busy[k] ? <span className="lb-quiet">{busy[k]}</span> : null}
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
