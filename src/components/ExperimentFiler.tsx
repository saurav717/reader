// Files a playground's simulation runs as they end: while the machine is
// connected, the runs' folders are looked at every twenty seconds, and a run
// that has ended and isn't filed yet goes where the experiments go — Drive by
// default — with its record in the project's logbook and notes written by
// the model, as Settings on the Experiments tab say (src/lib/
// experimentFiling.ts). A toast says so, with the folder and a way to move
// the files to a computer connected right now. No UI otherwise.

import { useEffect, useRef, useState } from 'react';
import { experimentPrefs, fileRun, filedIndex, moveExperiment, writeNotes } from '../lib/experimentFiling';
import type { Experiment } from '../lib/experiments';
import type { Playground } from '../lib/playground';
import { useServers } from '../lib/playground';
import type { Project } from '../lib/projects';
import { projectsOf } from '../lib/projects';
import { readSimRuns, shownStatus } from '../lib/simTelemetry';
import { useStore } from '../lib/store';
import { openProject, useLibrarySettled, useProjectForImplementation } from '../lib/implementationProject';
import { saveExperiment } from '../lib/logbookStore';

/** Runs that ended longer ago than this are not filed by themselves: they were over before the filing was. */
const FRESH_S = 2 * 24 * 3600;

interface Toast {
  experiment: Experiment;
  problems: string[];
  notes?: 'writing' | 'done' | 'off' | 'failed';
  moving?: string;
}

export default function ExperimentFiler({ playground, folder, connected }: { playground: Playground; folder: string; connected: boolean }) {
  const { collections, user } = useStore();
  const servers = useServers();
  const [toast, setToast] = useState<Toast | null>(null);
  const project = projectsOf(collections).find((p) => p.project.playgroundId === playground.id) as Project | undefined;
  const projectRef = useRef(project);
  projectRef.current = project;
  const busy = useRef(false);
  const by = user?.email ?? 'you';
  const projectFor = useProjectForImplementation();
  const settled = useLibrarySettled();
  const paperId = playground.cites[0]?.paperId;
  /** The experiment on the toast, waiting for the Project just made for the playground, to go into its logbook. */
  const [toLog, setToLog] = useState<Experiment | null>(null);
  useEffect(() => {
    if (!toLog || !project) return;
    setToLog(null);
    void saveExperiment(project, toLog).catch(() => undefined);
  }, [toLog, project]);
  const makeProject = async () => {
    if (!paperId) return;
    const id = await projectFor(paperId, playground).catch(() => null);
    if (id) setToLog(toast?.experiment ?? null);
  };

  useEffect(() => {
    if (!connected) return;
    let live = true;
    let timer = 0;
    const look = async () => {
      if (!experimentPrefs().autoFile || busy.current) return;
      try {
        const got = await readSimRuns(folder, null);
        if (!live) return;
        const filed = await filedIndex(playground.id);
        const done = got.runs.filter((r) => !filed[r.dir.split('/').pop() ?? r.dir] && !filed[r.dir] && shownStatus(r.meta.status, r.mtime, got.now) !== 'running' && r.meta.status && r.meta.status !== 'running' && got.now - r.mtime < FRESH_S);
        for (const listing of done.slice(0, 2)) {
          busy.current = true;
          try {
            const report = await fileRun({ playground, folder, dir: listing.dir, project: projectRef.current, by });
            if (!live) return;
            const next: Toast = { experiment: report.experiment, problems: report.problems, notes: experimentPrefs().notes === 'model' ? 'writing' : 'off' };
            setToast(next);
            if (experimentPrefs().notes === 'model') {
              try {
                const noted = await writeNotes(report.experiment, { playground, project: projectRef.current });
                if (live) setToast((now) => (now && now.experiment.id === noted.id ? { ...now, experiment: noted, notes: 'done' } : now));
              } catch {
                if (live) setToast((now) => (now && now.experiment.id === report.experiment.id ? { ...now, notes: 'failed' } : now));
              }
            }
          } catch (error) {
            // Not filed this time (Drive signed out, the machine gone): looked at again on the next round.
            if (live) setToast({ experiment: { id: listing.dir, title: listing.meta.name ?? listing.dir } as Experiment, problems: [error instanceof Error ? error.message : String(error)], notes: 'off' });
          } finally {
            busy.current = false;
          }
        }
      } catch {
        // the machine isn't answering: next round
      }
    };
    void look();
    timer = window.setInterval(() => void look(), 20_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [playground.id, folder, connected, by]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!toast) return null;
  const exp = toast.experiment;
  const filedSomewhere = Boolean(exp.where);
  const move = async (serverId: string) => {
    setToast((now) => (now ? { ...now, moving: 'Moving…' } : now));
    try {
      const moved = await moveExperiment(exp, serverId === 'drive' ? 'drive' : { serverId }, projectRef.current, (step) => setToast((now) => (now ? { ...now, moving: step } : now)));
      setToast((now) => (now ? { ...now, experiment: moved, moving: undefined } : now));
    } catch (error) {
      setToast((now) => (now ? { ...now, moving: error instanceof Error ? error.message : String(error) } : now));
    }
  };
  return (
    <div className="xp-toast" role="status" aria-live="polite">
      <b>{filedSomewhere ? `Experiment filed: ${exp.title}` : `Not filed: ${exp.title}`}</b>
      {filedSomewhere ? (
        <span>
          {exp.where.link ? (
            <a href={exp.where.link} target="_blank" rel="noreferrer noopener">
              {exp.where.label} ↗
            </a>
          ) : (
            `${exp.where.label}: ${exp.where.path}`
          )}
          {projectRef.current ? (
            <>
              {' · in '}
              <button type="button" className="link" onClick={() => openProject(projectRef.current!.id, 'experiments')}>
                {projectRef.current.name}’s logbook
              </button>
            </>
          ) : (
            ' · not in any logbook yet: this playground has no Project'
          )}
          {toast.notes === 'writing' ? ' · notes being written…' : toast.notes === 'done' ? ' · notes written' : toast.notes === 'failed' ? ' · the notes could not be written (the Experiments tab can try again)' : ''}
        </span>
      ) : null}
      {toast.problems.length ? <span className="is-problem">{toast.problems.slice(0, 2).join(' · ')}</span> : null}
      {toast.moving ? <span>{toast.moving}</span> : null}
      <div className="xp-acts">
        {filedSomewhere && (servers.length || exp.where.kind !== 'drive') ? (
          <select className="xp-move" value="" onChange={(event) => event.target.value && void move(event.target.value)} aria-label="Move the files">
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
        ) : null}
        {!projectRef.current && paperId && settled && filedSomewhere ? (
          <button type="button" className="btn sm primary" onClick={() => void makeProject()} title="A Project on the Projects page for this playground, named after its paper: this run and every one after it are kept in its logbook, with notes">
            Make it a Project
          </button>
        ) : null}
        <button type="button" className="btn sm" onClick={() => setToast(null)}>
          Close
        </button>
      </div>
    </div>
  );
}
