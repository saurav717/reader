// A project's code to GitHub: every text file of its playground the sync
// rules let through (the same rules that keep data and checkpoints off the
// machine), as one commit on the repository's branch. Files not in the
// folder are left as they are in the repository: nothing is deleted there.

import { commitFiles, type GitHubTarget } from './github';
import { homeHost, matchesAny, walk, SYNC_LIMIT, type Playground } from './playground';

/** Not text: left out, as GitHub's contents would only garble them through the page. */
const BINARY = /\.(png|jpe?g|gif|webp|pdf|zip|gz|tgz|tar|pt|pth|ckpt|bin|safetensors|npy|npz|pkl|h5|parquet|arrow|so|dylib|exe|woff2?|ttf|mp4|mov|wav|mp3)$/i;

export interface CodePush {
  commit: string | null;
  files: number;
  skipped: string[];
}

/** The playground's files, as one commit to `target`. */
export async function pushCode(playground: Playground, target: GitHubTarget, message: string, onProgress?: (done: number, of: number) => void): Promise<CodePush> {
  const host = homeHost(playground);
  const entries = await walk(host, (path) => matchesAny(playground.sync.ignore, path) || path === '.git' || path.startsWith('.git/'));
  const files: Record<string, string> = {};
  const skipped: string[] = [];
  let done = 0;
  for (const entry of entries) {
    done += 1;
    onProgress?.(done, entries.length);
    if (BINARY.test(entry.path) || (entry.size ?? 0) > SYNC_LIMIT) {
      skipped.push(entry.path);
      continue;
    }
    const text = await host.read(entry.path).catch(() => null);
    if (text === null) skipped.push(entry.path);
    else files[entry.path.replace(/^\/+/, '')] = text;
  }
  if (!Object.keys(files).length) throw new Error('There is nothing to push yet: the code has no text files the sync rules let through.');
  const done2 = await commitFiles(target, files, message);
  return { commit: done2.commit, files: Object.keys(files).length, skipped };
}

/** A repository name for a project's code: lower case, dashes, "-code" after. */
export function codeRepoName(projectName: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'project'}-code`;
}
