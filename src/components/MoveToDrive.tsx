import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { PAPER_VERSION } from '../lib/companion';
import { keptLocally, movePaperToDrive, type ThisCompanion } from '../lib/paperMove';
import { setPaperDrive } from '../lib/paperStore';
import { projectsOf } from '../lib/projects';
import { thisComputer } from '../lib/thisComputer';

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
  const waiting = useMemo(() => projectsOf(collections).filter(keptLocally), [collections]);
  const [here, setHere] = useState<ThisCompanion | null | undefined>(undefined);
  const tried = useRef(new Set<string>());

  useEffect(() => {
    if (!signedIn || !waiting.length || here !== undefined) return;
    void thisComputer(PAPER_VERSION, 'move the papers to Drive').then((found) => setHere('error' in found ? null : { id: found.id, server: found.server }));
  }, [signedIn, waiting.length, here]);

  const queue = here ? waiting.filter((project) => project.project.overleaf?.folders?.[here.id] && !tried.current.has(project.id)) : [];
  useEffect(() => {
    if (!signedIn || !here || !queue.length || running) return;
    running = true;
    void (async () => {
      try {
        for (const project of queue) {
          tried.current.add(project.id);
          try {
            const folder = await movePaperToDrive(project, here);
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
