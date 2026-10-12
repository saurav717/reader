import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { PAPER_VERSION, syncPaper } from '../lib/companion';
import { overleafGitUrl } from '../lib/overleaf';
import { findLostFolder, inDrive, keptLocally, movePaperToDrive, removeFolder, type ThisCompanion } from '../lib/paperMove';
import { companionStore, setPaperDrive } from '../lib/paperStore';
import { projectsOf } from '../lib/projects';
import { thisComputer } from '../lib/thisComputer';

const RETRY_MS = 10 * 60_000;

/** One run at a time. */
let running = false;

/**
 * Papers kept in a folder on a computer, from before papers were kept in
 * Drive (not those the project chose to keep on its computers): moved there
 * in the background, one at a time, asking nothing.
 * Whenever the account's Drive is signed in and this computer's Companion has
 * a project's folder, the paper goes into Drive (a clone of Overleaf synced
 * there first, by the Companion and its token) and the project then keeps it
 * in Drive, on every device. A folder on another computer moves when Reader is
 * opened there. Once every file is checked to be in Drive, the folder on the
 * computer is removed (never a Dropbox folder). Nothing is shown: a move that
 * fails is tried again in a while, and the next time Reader opens.
 */
export default function MoveToDrive() {
  const { collections, settings, driveConnected, updateCollection } = useStore();
  const clientId = settings.googleClientId.trim();
  const signedIn = driveConnected && Boolean(clientId);
  if (signedIn) setPaperDrive({ clientId, folderName: settings.driveFolderName });
  const all = useMemo(() => projectsOf(collections), [collections]);
  const waiting = all.filter(keptLocally);
  // Linked to Overleaf, in neither Drive nor any folder: maybe a folder here the project lost its link to.
  const unplaced = all.filter((project) => overleafGitUrl(project.project.overleaf?.url) && !project.project.overleaf?.drive && project.project.overleaf?.keep?.where !== 'computer' && !Object.keys(project.project.overleaf?.folders ?? {}).length);
  // In Drive already, with a folder still on a computer (moved before folders were removed, or kept on the computers
  // before and back in Drive since): that folder goes, once what was written in it is in Overleaf.
  const leftover = all.filter((project) => project.project.overleaf?.drive && project.project.overleaf.keep?.where !== 'computer' && Object.keys(project.project.overleaf.folders ?? {}).length);
  const [here, setHere] = useState<ThisCompanion | null | undefined>(undefined);
  const tried = useRef(new Set<string>());
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!signedIn || !(waiting.length || unplaced.length || leftover.length) || here !== undefined) return;
    void thisComputer(PAPER_VERSION, 'move the papers to Drive').then((found) => setHere('error' in found ? null : { id: found.id, server: found.server }));
  }, [signedIn, waiting.length, unplaced.length, leftover.length, here]);

  const queue = here ? [...waiting.filter((project) => project.project.overleaf?.folders?.[here.id]), ...unplaced, ...leftover.filter((project) => project.project.overleaf?.folders?.[here.id])].filter((project) => !tried.current.has(project.id)) : [];
  useEffect(() => {
    if (!signedIn || !here || !queue.length || running) return;
    running = true;
    void (async () => {
      try {
        for (const project of queue) {
          tried.current.add(project.id);
          try {
            const known = project.project.overleaf?.folders?.[here.id];
            if (project.project.overleaf?.drive && known) {
              await clearLeftover(project.project.overleaf.url, known, here);
              await updateCollection(project.id, (collection) => {
                const info = collection.project ?? project.project;
                const folders = { ...(info.overleaf?.folders ?? {}) };
                delete folders[here.id];
                const { folders: _old, ...rest } = info.overleaf ?? { url: '' };
                return { project: { ...info, overleaf: { ...rest, ...(Object.keys(folders).length ? { folders } : {}) } } };
              });
              continue;
            }
            const local = known ?? (await findLostFolder(project, here));
            // Nothing of it here: left for its set-up in the Write tab, or the computer that has it.
            if (!local) continue;
            const folder = await movePaperToDrive(project, here, { local });
            await updateCollection(project.id, (collection) => {
              const info = collection.project ?? project.project;
              return { project: { ...info, overleaf: inDrive(info.overleaf, folder, here.id) } };
            });
          } catch (error) {
            console.warn(`Reader: “${project.name}” wasn’t moved to Drive this time:`, error);
            // Tried again in a while, while Reader stays open (Overleaf down for a moment, say), and at its next opening.
            window.setTimeout(() => (tried.current.delete(project.id), setRetry((n) => n + 1)), RETRY_MS);
          }
        }
      } finally {
        running = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, here, queue.map((project) => project.id).join(), retry]);

  return null;
}

/** A folder on this computer of a paper in Drive since: its clone's edits sent to Overleaf (which Drive syncs from), then the folder removed. */
async function clearLeftover(url: string, folder: { path: string; sync: string }, here: ThisCompanion): Promise<void> {
  // Gone already (removed when the paper moved): only forgotten.
  if (!(await companionStore(here.server, folder.path).list('').then(() => true, () => false))) return;
  if (folder.sync === 'git' && overleafGitUrl(url)) {
    const sent = await syncPaper(here.server, folder.path, 'Edits from Reader, before the folder was removed from this computer');
    if (!sent.ok) throw new Error(sent.error ?? 'The folder couldn’t be synced with Overleaf first.');
  }
  // Only a folder Reader made: a Dropbox folder, or one linked in from elsewhere, is left where it is, and only forgotten.
  if (folder.sync !== 'dropbox' && /^papers\/[^/]+$/.test(folder.path)) await removeFolder(here.server, folder.path);
}
