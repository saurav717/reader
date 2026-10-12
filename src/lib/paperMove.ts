// A project's paper moved from a folder on this computer into Google Drive,
// where it is kept since: the same way whether asked for in the Write tab's
// set-up or done by itself for the projects made before (MoveToDrive).
//
// With Overleaf, nothing typed on this computer is lost: a Git clone here is
// synced to Overleaf first (the Companion), and the paper is then brought into
// Drive from Overleaf by Reader's server — so Drive starts from a commit the
// next syncs go on from. Without Overleaf, the folder's files are copied into
// Drive as they are. The folder on this computer is left as it was.

import { paperRemote, syncPaper } from './companion';
import { isBuildFile, overleafGitUrl } from './overleaf';
import { cloudSync, recordMove } from './overleafCloud';
import { companionStore, driveStore, paperDriveFolder, paperDriveNow, type PaperStore } from './paperStore';
import type { Project } from './projects';
import type { PaperFolder } from '../types';

export interface ThisCompanion {
  id: string;
  server: { url: string; token: string };
}

/** Every file under a store's folder, but Git's own, dot-files and what compiling leaves. */
async function filesOf(store: PaperStore): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 8 || found.length > 2000) return;
    for (const entry of await store.list(dir)) {
      if (entry.name.startsWith('.')) continue;
      if (entry.type === 'directory') await walk(entry.path, depth + 1);
      else if (!isBuildFile(entry.path)) found.push(entry.path);
    }
  };
  await walk('', 0);
  return found;
}

/** Whether Git's error says Overleaf (or the way to it) is down, not that anything is wrong with the paper. */
export const overleafDown = (error: string | undefined) => /\b50[234]\b|no healthy upstream|Could not resolve host|timed out|Connection (refused|reset)|Failed to connect/i.test(error ?? '');

/** Whether the project's paper is still in a folder on a computer, and not yet in Drive. */
export function keptLocally(project: Project): boolean {
  const link = project.project.overleaf;
  return Boolean(link && !link.drive && link.folders && Object.keys(link.folders).length);
}

/**
 * The paper into Drive: its folder there, which the caller records on the
 * project. `here` is this computer's Companion, when it has the paper's
 * folder (or none, to bring it in from Overleaf alone). `token` is the
 * Overleaf Git token, when Reader's server hasn't one yet.
 */
export async function movePaperToDrive(project: Project, here: ThisCompanion | null, options: { token?: string; onStep?: (text: string) => void; local?: PaperFolder } = {}): Promise<string> {
  if (!paperDriveNow()) throw new Error('Sign in with Google, with Drive, first.');
  const link = project.project.overleaf;
  const gitUrl = overleafGitUrl(link?.url);
  // The paper's folder here: as the project has it, or as given (one the project lost its link to).
  let local = here ? (link?.folders?.[here.id] ?? options.local) : undefined;
  if (here && local && !(await companionStore(here.server, local.path).list('').then(() => true, () => false))) local = undefined;
  const folder = paperDriveFolder(project.name, project.id);
  const drive = driveStore(paperDriveNow, folder);
  const step = options.onStep ?? (() => undefined);
  if (here && local) {
    // A clone of Overleaf here: what was written goes to Overleaf first, by the Companion (which has the token).
    const clone = gitUrl ? Boolean((await paperRemote(here.server, local.path).catch(() => null))?.url) : false;
    if (clone) {
      step('Sending what was written on this computer to Overleaf…');
      const sent = await syncPaper(here.server, local.path, 'Edits from Reader, before the paper moved to Drive');
      if (!sent.ok) {
        // Overleaf's Git down for a while (a 5xx, or not reached): said as such, and tried again later — nothing moved, nothing lost.
        if (overleafDown(sent.error)) throw Object.assign(new Error('Overleaf’s Git isn’t answering right now (it’s down for a moment on Overleaf’s side). Nothing was moved or lost: try again in a few minutes.'), { transient: true });
        throw new Error(`The folder on this computer couldn’t be synced with Overleaf first: ${sent.error ?? 'it didn’t finish'}.`);
      }
    }
    // Then the folder's files into Drive, as they are; with Overleaf, recorded so the first sync from Drive goes
    // on from the commit they are (a clone, or Dropbox's copy), or sends them all (a folder never synced).
    const from = companionStore(here.server, local.path);
    const paths = await filesOf(from);
    const files: { path: string; base64: string }[] = [];
    for (const [index, path] of paths.entries()) {
      step(`Copying ${index + 1} of ${paths.length}: ${path}`);
      const base64 = await from.readBase64(path);
      await drive.writeBase64(path, base64);
      files.push({ path, base64 });
    }
    if (!paths.length) await drive.mkdir('');
    if (gitUrl) await recordMove(drive, files, local.sync === 'folder' ? 'unsynced' : 'synced');
    return folder;
  }
  if (gitUrl) {
    // Nothing of it here: brought in from Overleaf by Reader's server.
    step('Bringing the paper in from Overleaf…');
    const done = await cloudSync(drive, gitUrl, 'From Reader', options.token);
    if (!done.ok) throw Object.assign(new Error(done.needToken ? 'Your Overleaf Git token is needed.' : done.error ?? 'It didn’t come in.'), { needToken: Boolean(done.needToken) });
    return folder;
  }
  throw new Error('The paper’s folder is on another computer: open Reader there to move it.');
}
