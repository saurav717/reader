import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { PAPER_VERSION, paperRemote } from '../lib/companion';
import { overleafGitUrl, paperFolderFor } from '../lib/overleaf';
import { keptLocally, movePaperToDrive, type ThisCompanion } from '../lib/paperMove';
import { setPaperDrive } from '../lib/paperStore';
import { projectsOf, type Project } from '../lib/projects';
import type { PaperFolder } from '../types';
import { thisComputer } from '../lib/thisComputer';

/** The same Overleaf project, however its Git address is written. */
const sameRemote = (a: string, b: string) => {
  const plain = (address: string) => address.trim().replace(/^https?:\/\/[^@/]*@/, 'https://').replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
  return plain(a) === plain(b);
};

/** A project linked to Overleaf that lost its link to the folder it was cloned into here: that folder, when it is one. */
async function lostFolder(project: Project, here: ThisCompanion): Promise<PaperFolder | null> {
  const gitUrl = overleafGitUrl(project.project.overleaf?.url);
  if (!gitUrl) return null;
  const path = paperFolderFor(project.name);
  const remote = await paperRemote(here.server, path).catch(() => null);
  return remote?.url && sameRemote(remote.url, gitUrl) ? { path, sync: 'git' } : null;
}

/** One run at a time. */
let running = false;

/**
 * Papers kept in a folder on a computer, from before papers were kept in
 * Drive: moved there in the background, one at a time, asking nothing.
 * Whenever the account's Drive is signed in and this computer's Companion has
 * a project's folder, the paper goes into Drive (a clone of Overleaf synced
 * there first, by the Companion and its token) and the project then keeps it
 * in Drive, on every device. A folder on another computer moves when Reader is
 * opened there. The folders on the computer are left as they were. Nothing is
 * shown: a move that fails is tried again the next time Reader opens.
 */
export default function MoveToDrive() {
  const { collections, settings, driveConnected, updateCollection } = useStore();
  const clientId = settings.googleClientId.trim();
  const signedIn = driveConnected && Boolean(clientId);
  if (signedIn) setPaperDrive({ clientId, folderName: settings.driveFolderName });
  const all = useMemo(() => projectsOf(collections), [collections]);
  const waiting = all.filter(keptLocally);
  // Linked to Overleaf, in neither Drive nor any folder: maybe a folder here the project lost its link to.
  const unplaced = all.filter((project) => overleafGitUrl(project.project.overleaf?.url) && !project.project.overleaf?.drive && !Object.keys(project.project.overleaf?.folders ?? {}).length);
  const [here, setHere] = useState<ThisCompanion | null | undefined>(undefined);
  const tried = useRef(new Set<string>());

  useEffect(() => {
    if (!signedIn || !(waiting.length || unplaced.length) || here !== undefined) return;
    void thisComputer(PAPER_VERSION, 'move the papers to Drive').then((found) => setHere('error' in found ? null : { id: found.id, server: found.server }));
  }, [signedIn, waiting.length, unplaced.length, here]);

  const queue = here ? [...waiting.filter((project) => project.project.overleaf?.folders?.[here.id]), ...unplaced].filter((project) => !tried.current.has(project.id)) : [];
  useEffect(() => {
    if (!signedIn || !here || !queue.length || running) return;
    running = true;
    void (async () => {
      try {
        for (const project of queue) {
          tried.current.add(project.id);
          try {
            const known = project.project.overleaf?.folders?.[here.id];
            const local = known ?? (await lostFolder(project, here));
            // Nothing of it here: left for its set-up in the Write tab, or the computer that has it.
            if (!local) continue;
            const folder = await movePaperToDrive(project, here, { local });
            await updateCollection(project.id, (collection) => {
              const info = collection.project ?? project.project;
              return { project: { ...info, overleaf: { ...(info.overleaf ?? { url: '' }), drive: { folder } } } };
            });
          } catch (error) {
            console.warn(`Reader: “${project.name}” wasn’t moved to Drive this time:`, error);
          }
        }
      } finally {
        running = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, here, queue.map((project) => project.id).join()]);

  return null;
}
