/**
 * The project open on screen, for Ask AI: its files, so a question about the code is answered from the code. The
 * workspace (PlaygroundWorkspace — a playground, or a research project's code) offers it while it shows; nothing
 * is offered when no project is open. What goes: the file in front of the reader, whole, as it is in the editor
 * (unsaved edits too); the other open tabs; then the rest of the project's code and notes, the most telling first
 * (README and notes, the entry points, then the rest), up to a budget; and the whole listing, so the model can say
 * which file holds what and ask for one that didn't fit.
 */

import type { FileHost } from './playground';
import { listAll } from './projectAgent';

export interface ScreenProject {
  title: string;
  /** "a playground notebook", "a playground project", "the code of the research project “X”". */
  kind: string;
  /** Where its files are, and where it runs. */
  where: string;
  /** The file in front of the reader, as the editor has it. */
  active?: { path: string; text: string; unsaved: boolean };
  /** The other tabs open in the editor. */
  open: { path: string; text: string; unsaved: boolean }[];
  /** The rest of the project's files read for the question. */
  files: { path: string; text: string }[];
  /** Every file in the folder, with its size; `left` names those not read for want of room. */
  listing: { path: string; size: number | null }[];
  left: number;
}

type Provider = () => Promise<ScreenProject | null>;
let provider: Provider | null = null;

/** The workspace on screen offers its project (null as it goes). */
export function offerProject(next: Provider | null) {
  provider = next;
}

/** The project on screen, read now; null when there is none. */
export async function projectOnScreen(): Promise<ScreenProject | null> {
  if (!provider) return null;
  try {
    return await provider();
  } catch {
    return null;
  }
}

const TEXT = /\.(py|ipynb|js|mjs|cjs|ts|tsx|jsx|rs|go|c|cc|cpp|h|hpp|cu|java|kt|jl|r|rb|sh|bash|zsh|toml|yaml|yml|cfg|ini|json|md|txt|rst|tex|bib|csv|sql|html|css|lua|swift|m|scala|dockerfile|makefile)$/i;
const SKIP = /(^|\/)(\.git|\.reader|reader-meta|node_modules|__pycache__|\.ipynb_checkpoints|wandb|\.venv|venv|site-packages|data|datasets|runs|outputs|checkpoints)\//;
const NOTES = /(^|\/)(readme|agents|claude|plan|notes?|design|todo)[^/]*\.(md|txt|rst)$/i;
const ENTRY = /(^|\/)(main|train|run|app|model|agent|env|world|policy|config|setup)[^/]*\.(py|sh|ya?ml|toml)$/i;
/** Each file at most this much, and all of them together this much: a question's worth, not the whole repository. */
export const FILE_CHARS = 16_000;
export const TOTAL_CHARS = 120_000;

/** Which files are read first: the notes, the entry points, the code nearest the top. */
export function readOrder(path: string): number {
  if (NOTES.test(path)) return 0;
  if (ENTRY.test(path)) return 1 + path.split('/').length * 0.1;
  if (/\.(py|ipynb|sh)$/i.test(path)) return 2 + path.split('/').length;
  return 10 + path.split('/').length;
}

export const clipFile = (text: string, max = FILE_CHARS) => (text.length > max ? `${text.slice(0, max)}\n[… ${(text.length - max).toLocaleString('en')} more characters: ask the reader to open the file, or to select the part that matters …]` : text);

/** What was read of a folder lately, by path, with the size it had: read again only when it changed. */
const cache = new Map<string, { size: number | null; text: string; at: number }>();

/** The project's files for a question: the open ones as given, the rest read from its folder, the most telling first, within the budget. */
export async function readProjectFiles(host: FileHost, open: { path: string; text: string; unsaved: boolean }[], active: string | undefined): Promise<Pick<ScreenProject, 'active' | 'open' | 'files' | 'listing' | 'left'>> {
  const listing = (await listAll(host).catch(() => [])).filter((file) => !SKIP.test(file.path));
  const activeFile = open.find((file) => file.path === active);
  const others = open.filter((file) => file.path !== active);
  let total = (activeFile?.text.length ?? 0) + others.reduce((sum, file) => sum + Math.min(file.text.length, FILE_CHARS), 0);
  const seen = new Set(open.map((file) => file.path));
  const files: { path: string; text: string }[] = [];
  let left = 0;
  for (const file of listing.filter((f) => TEXT.test(f.path) && !seen.has(f.path) && (f.size ?? 0) < 1_000_000).sort((a, b) => readOrder(a.path) - readOrder(b.path))) {
    if (total >= TOTAL_CHARS) {
      left++;
      continue;
    }
    const kept = cache.get(file.path);
    let text = kept && kept.size === file.size && Date.now() - kept.at < 120_000 ? kept.text : null;
    if (text === null) {
      text = await host.read(file.path).catch(() => null);
      if (text === null) continue;
      cache.set(file.path, { size: file.size, text, at: Date.now() });
    }
    const clipped = clipFile(text, Math.min(FILE_CHARS, TOTAL_CHARS - total + 200));
    files.push({ path: file.path, text: clipped });
    total += clipped.length;
  }
  return {
    active: activeFile ? { path: activeFile.path, text: activeFile.text, unsaved: activeFile.unsaved } : undefined,
    open: others.map((file) => ({ ...file, text: clipFile(file.text) })),
    files,
    listing,
    left,
  };
}
