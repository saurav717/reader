// A project's paper, written in Overleaf (types.ts, `OverleafLink`).
//
// Overleaf has no API for anyone else to call, and its editor will not open
// inside another site, so what the page can do with Overleaf alone is open
// the project — in a window placed beside the reader, or in a tab. When the
// paper is also in a GitHub repository, which is what Overleaf's GitHub sync
// keeps it in, the page reads and writes the .tex and .bib files there with
// the GitHub token from Settings, and Overleaf pulls the changes in from its
// GitHub menu. What is here is the reading of all that: the link, the files,
// the outline, the \cite keys and which papers they are. The calls to GitHub
// are at the end.

import type { BrowserChoice, OverleafLink, OverleafView, Paper, PaperFolder, Settings } from '../types';
import { OVERLEAF_VIEWS } from '../types';
import { citeKey, commitFiles, gh, parseRepo, toBibtex, type GitHubTarget } from './github';

// ------------------------------------------------------------- the link --

/**
 * The Overleaf project in whatever was pasted: its address in the editor
 * (overleaf.com/project/…), a share link (/read/…, or the edit link's
 * digits and letters), or the same on a self-hosted Overleaf. Null when it is
 * not one.
 */
export function parseOverleafUrl(value: string): string | null {
  const trimmed = (value || '').trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const path = url.pathname.replace(/\/+$/, '');
  const project = path.match(/^\/project\/([0-9a-f]{24})(?:\/.*)?$/i);
  if (project) return `${url.origin}/project/${project[1].toLowerCase()}`;
  const read = path.match(/^\/read\/([a-z]{8,})$/i);
  if (read) return `${url.origin}/read/${read[1]}`;
  // An edit share link: digits, then letters.
  const edit = path.match(/^\/(\d{6,}[a-z]{6,})$/i);
  if (edit && /overleaf/i.test(url.hostname)) return `${url.origin}/${edit[1]}`;
  return null;
}

/** A link as it can be relied on, from Drive, written by any version or by hand; undefined when it is not one. */
export function overleafLinkOf(raw: unknown): OverleafLink | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Partial<Record<keyof OverleafLink, unknown>>;
  const url = typeof value.url === 'string' ? parseOverleafUrl(value.url) : null;
  if (!url) return undefined;
  const repo = typeof value.repo === 'string' ? parseRepo(value.repo) : null;
  const text = (field: unknown) => (typeof field === 'string' && field.trim() ? field.trim() : undefined);
  const browsers: Record<string, BrowserChoice> = {};
  if (value.browsers && typeof value.browsers === 'object') {
    for (const [computer, raw] of Object.entries(value.browsers as Record<string, unknown>)) {
      const choice = raw as Partial<Record<keyof BrowserChoice, unknown>> | null;
      if (!choice || typeof choice.browser !== 'string' || !/^[a-z]+$/.test(choice.browser)) continue;
      browsers[computer] = {
        browser: choice.browser,
        ...(text(choice.profile) ? { profile: text(choice.profile) } : {}),
        label: text(choice.label) ?? choice.browser,
      };
    }
  }
  const folders: Record<string, PaperFolder> = {};
  if (value.folders && typeof value.folders === 'object') {
    for (const [computer, raw] of Object.entries(value.folders as Record<string, unknown>)) {
      const folder = raw as Partial<Record<keyof PaperFolder, unknown>> | null;
      const path = typeof folder?.path === 'string' ? folder.path.replace(/^\/+|\/+$/g, '') : '';
      if (!path || path.split('/').includes('..')) continue;
      folders[computer] = { path, sync: folder?.sync === 'git' || folder?.sync === 'dropbox' ? folder.sync : 'folder' };
    }
  }
  return {
    url,
    ...(repo ? { repo: `${repo.owner}/${repo.repo}` } : {}),
    ...(repo && text(value.branch) ? { branch: text(value.branch) } : {}),
    ...(repo && text(value.folder) ? { folder: cleanFolder(text(value.folder)!) } : {}),
    ...(text(value.account) ? { account: text(value.account) } : {}),
    ...(Object.keys(browsers).length ? { browsers } : {}),
    ...(Object.keys(folders).length ? { folders } : {}),
    ...(value.compiler === 'xelatex' || value.compiler === 'lualatex' || value.compiler === 'latex' || value.compiler === 'pdflatex' ? { compiler: value.compiler } : {}),
    ...(typeof value.main === 'string' && /\.tex$/i.test(value.main) && !value.main.split('/').includes('..') ? { main: value.main.replace(/^\/+/, '') } : {}),
  };
}

const cleanFolder = (folder: string) => folder.replace(/^\/+|\/+$/g, '');

/** The choice in Settings, as it can be relied on: the default for anything else. */
export function overleafViewOf(settings: Pick<Settings, 'overleafView'>): OverleafView {
  return OVERLEAF_VIEWS.some((view) => view.id === settings.overleafView) ? settings.overleafView : 'tab';
}

/**
 * The features for a window on the right half of the screen, the reader
 * keeping the left: what "beside" means to a browser, which can place a
 * window it opens but not the one it is in.
 */
export function besideFeatures(screen: { availLeft?: number; availTop?: number; availWidth: number; availHeight: number }): string {
  const left = screen.availLeft ?? 0;
  const top = screen.availTop ?? 0;
  const width = Math.max(480, Math.round(screen.availWidth / 2));
  return `popup,left=${left + screen.availWidth - width},top=${top},width=${width},height=${screen.availHeight}`;
}

// ------------------------------------------------------------ the files --

export interface DraftFile {
  path: string;
  text: string;
  /** The blob it was read at: what a write checks has not moved. */
  sha: string;
}

export interface Heading {
  level: number;
  title: string;
  /** The file it is in, and its line there, from 1. */
  path: string;
  line: number;
  /** Words from it to the next heading, in its file. */
  words: number;
  /** Words under it all: its own and its subsections', to the next heading as high as it. */
  total: number;
}

const HEADING = /\\(part|chapter|section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/;
const LEVELS: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4 };

/** The text without its comments: a % to the end of the line, unless it is \%. */
export const stripComments = (tex: string) => tex.replace(/(^|[^\\])%.*$/gm, '$1');

/**
 * How many words a reader would count: commands, their options and maths
 * left out, the words inside \textbf{…} and the like kept.
 */
export function wordCount(tex: string): number {
  const text = stripComments(tex)
    .replace(/\\begin\{(equation|align|figure|table|tabular|verbatim|lstlisting|tikzpicture)\*?\}[\s\S]*?\\end\{\1\*?\}/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\$[^$]*\$/g, ' ')
    .replace(/\\(?:cite[a-z]*|ref|eqref|autoref|cref|label|input|include|bibliography|bibliographystyle|usepackage|documentclass|includegraphics|url)\*?(?:\[[^\]]*\])*\{[^}]*\}/gi, ' ')
    .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?/g, ' ')
    .replace(/[{}~\\&]/g, ' ');
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

/**
 * The files in the order the paper reads: the main file, each \input or
 * \include where it comes in it, and whatever is not pulled in at the end.
 */
export function readingOrder<T extends Pick<DraftFile, 'path' | 'text'>>(files: T[]): T[] {
  const main = mainFileOf(files);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const root = main?.includes('/') ? main.slice(0, main.lastIndexOf('/') + 1) : '';
  const seen = new Set<string>();
  const ordered: T[] = [];
  const visit = (path: string) => {
    const file = byPath.get(path);
    if (!file || seen.has(path)) return;
    seen.add(path);
    ordered.push(file);
    for (const match of stripComments(file.text).matchAll(/\\(?:input|include|subfile)\s*\{([^}]+)\}/g)) {
      const name = match[1].trim().replace(/^\.\//, '');
      const withTex = /\.tex$/i.test(name) ? name : `${name}.tex`;
      visit(byPath.has(root + withTex) ? root + withTex : withTex);
    }
  };
  if (main) visit(main);
  return [...ordered, ...files.filter((file) => !seen.has(file.path))];
}

/** The headings of the files, in the order the paper reads, each with its words. */
export function outline(files: Pick<DraftFile, 'path' | 'text'>[]): Heading[] {
  const headings: Heading[] = [];
  for (const file of readingOrder(files)) {
    if (!/\.tex$/i.test(file.path)) continue;
    const lines = file.text.split('\n');
    let open: Heading | null = null;
    let body: string[] = [];
    const close = () => {
      if (open) open.words = wordCount(body.join('\n'));
      body = [];
    };
    lines.forEach((line, index) => {
      const match = stripComments(line).match(HEADING);
      if (!match) {
        body.push(line);
        return;
      }
      close();
      open = { level: LEVELS[match[1]], title: match[2].replace(/\\[a-zA-Z]+\s*/g, '').replace(/[{}]/g, '').trim(), path: file.path, line: index + 1, words: 0, total: 0 };
      headings.push(open);
      body.push(stripComments(line).slice((match.index ?? 0) + match[0].length));
    });
    close();
  }
  headings.forEach((heading, index) => {
    heading.total = heading.words;
    for (let next = index + 1; next < headings.length && headings[next].level > heading.level; next += 1) heading.total += headings[next].words;
  });
  return headings;
}

/** Words in the paper: every .tex file, preamble and all. */
export const draftWords = (files: Pick<DraftFile, 'path' | 'text'>[]) =>
  files.filter((file) => /\.tex$/i.test(file.path)).reduce((sum, file) => sum + wordCount(file.text.replace(/^[\s\S]*?\\begin\{document\}/, '')), 0);

export interface Citation {
  key: string;
  path: string;
  line: number;
}

const CITE = /\\(?:[a-zA-Z]*cite[a-zA-Z]*|nocite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}/g;

/** Every key a \cite, \citet, \citep, \autocite, \textcite… names, with where. */
export function citationsIn(files: Pick<DraftFile, 'path' | 'text'>[]): Citation[] {
  const found: Citation[] = [];
  for (const file of files) {
    if (!/\.tex$/i.test(file.path)) continue;
    stripComments(file.text)
      .split('\n')
      .forEach((line, index) => {
        for (const match of line.matchAll(CITE)) {
          for (const key of match[1].split(',')) {
            const trimmed = key.trim();
            if (trimmed && trimmed !== '*') found.push({ key: trimmed, path: file.path, line: index + 1 });
          }
        }
      });
  }
  return found;
}

export interface BibEntry {
  key: string;
  title?: string;
  doi?: string;
  eprint?: string;
}

/** The entries of the .bib files: their keys and what can tell which paper each is. */
export function bibEntries(files: Pick<DraftFile, 'path' | 'text'>[]): BibEntry[] {
  const entries: BibEntry[] = [];
  for (const file of files) {
    if (!/\.bib$/i.test(file.path)) continue;
    const starts = [...file.text.matchAll(/@([a-zA-Z]+)\s*\{\s*([^,\s]+)\s*,/g)];
    starts.forEach((start, index) => {
      if (/^(comment|string|preamble)$/i.test(start[1])) return;
      const body = file.text.slice((start.index ?? 0) + start[0].length, starts[index + 1]?.index ?? file.text.length);
      const field = (name: string) => {
        const match = body.match(new RegExp(`\\b${name}\\s*=\\s*(?:\\{((?:[^{}]|\\{[^{}]*\\})*)\\}|"([^"]*)"|([^,\\n]+))`, 'i'));
        const value = (match?.[1] ?? match?.[2] ?? match?.[3])?.replace(/[{}]/g, '').trim();
        return value || undefined;
      };
      entries.push({ key: start[2], title: field('title'), doi: field('doi')?.toLowerCase(), eprint: field('eprint') ?? field('arxiv') });
    });
  }
  return entries;
}

const foldTitle = (title: string) => title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
const bareArxiv = (id: string) => id.replace(/^arxiv:/i, '').replace(/v\d+$/, '');

/** The entry that is this paper: the same DOI, arXiv id or title. */
export function entryFor(paper: Paper, entries: BibEntry[]): BibEntry | undefined {
  const doi = paper.doi?.toLowerCase();
  const arxiv = paper.arxivId ? bareArxiv(paper.arxivId) : undefined;
  const title = foldTitle(paper.title);
  return (
    (doi && entries.find((entry) => entry.doi === doi)) ||
    (arxiv && entries.find((entry) => entry.eprint && bareArxiv(entry.eprint) === arxiv)) ||
    (title.length > 12 ? entries.find((entry) => entry.title && foldTitle(entry.title) === title) : undefined) ||
    undefined
  );
}

/** The key the draft knows the paper by, else the one the page would give it. */
export const keyFor = (paper: Paper, entries: BibEntry[]) => entryFor(paper, entries)?.key ?? citeKey(paper);

/** The paper's BibTeX, under the key the draft knows it by. */
export function bibtexFor(paper: Paper, entries: BibEntry[]): string {
  const key = keyFor(paper, entries);
  return toBibtex(paper).replace(/^(@\w+\{)[^,]*,/, `$1${key},`);
}

export interface DraftHealth {
  words: number;
  headings: Heading[];
  /** The project's papers the draft cites, and where. */
  cited: { paper: Paper; key: string; at: Citation[] }[];
  /** The project's papers read, or being read, that the draft does not cite. */
  readNotCited: Paper[];
  /** Keys cited that no .bib entry has. */
  missing: string[];
  entries: BibEntry[];
}

/** What the draft makes of the project's papers. */
export function draftHealth(files: Pick<DraftFile, 'path' | 'text'>[], papers: Paper[]): DraftHealth {
  const entries = bibEntries(files);
  const citations = citationsIn(files);
  const keys = new Set(entries.map((entry) => entry.key));
  const cited: DraftHealth['cited'] = [];
  const readNotCited: Paper[] = [];
  for (const paper of papers) {
    const key = keyFor(paper, entries);
    const at = citations.filter((citation) => citation.key === key);
    if (at.length) cited.push({ paper, key, at });
    else if (paper.progress > 0.01 || paper.lastOpenedAt) readNotCited.push(paper);
  }
  const missing = [...new Set(citations.map((citation) => citation.key).filter((key) => !keys.has(key)))];
  return { words: draftWords(files), headings: outline(files), cited, readNotCited, missing, entries };
}

/** The file a new entry goes into: the .bib the main file names, else the first. */
export function bibFileOf(files: Pick<DraftFile, 'path' | 'text'>[]): string | undefined {
  const bibs = files.filter((file) => /\.bib$/i.test(file.path)).map((file) => file.path);
  for (const file of files) {
    const named = stripComments(file.text).match(/\\(?:bibliography|addbibresource)\{([^}]+)\}/);
    if (!named) continue;
    const first = named[1].split(',')[0].trim().replace(/\.bib$/i, '');
    const hit = bibs.find((path) => path.replace(/\.bib$/i, '').endsWith(first));
    if (hit) return hit;
  }
  return bibs[0];
}

/** The main file: the one with \documentclass, else main.tex, else the first .tex. */
export function mainFileOf(files: Pick<DraftFile, 'path' | 'text'>[]): string | undefined {
  const tex = files.filter((file) => /\.tex$/i.test(file.path));
  return (tex.find((file) => /^\s*\\documentclass/m.test(stripComments(file.text))) ?? tex.find((file) => /(^|\/)main\.tex$/i.test(file.path)) ?? tex[0])?.path;
}

/** A passage as LaTeX quotes it, with the citation after: ``…''~\cite{key}. */
export function quoteOf(passage: string, key: string): string {
  const text = passage
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\{}]/g, '')
    .replace(/[&%$#_]/g, (character) => `\\${character}`);
  return `\`\`${text}''~\\cite{${key}}`;
}

/** LaTeX as HTML for the editor: commands, comments and maths, with the editor's token classes. */
export function highlightTex(code: string): string {
  const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let out = '';
  let last = 0;
  for (const match of code.matchAll(/(%.*$)|(\$[^$\n]*\$)|(\\[a-zA-Z@]+\*?|\\.)|(@[a-zA-Z]+)/gm)) {
    const index = match.index ?? 0;
    if (match[1] && index > 0 && code[index - 1] === '\\') continue;
    out += esc(code.slice(last, index));
    const kind = match[1] ? 'c' : match[2] ? 'n' : match[3] ? 'k' : 'f';
    out += `<span class="tok-${kind}">${esc(match[0])}</span>`;
    last = index + match[0].length;
  }
  return out + esc(code.slice(last));
}

// ---------------------------------------------------- GitHub, the files --

/** The repository the paper is in, with the token from Settings; null without either. */
export function draftTarget(link: OverleafLink | undefined, settings: Pick<Settings, 'githubToken'>): GitHubTarget | null {
  const repo = link?.repo ? parseRepo(link.repo) : null;
  const token = settings.githubToken.trim();
  if (!repo || !token) return null;
  return { ...repo, branch: link?.branch || 'main', token };
}

const prefixOf = (link: OverleafLink) => (link.folder ? `${link.folder}/` : '');
const MAX_FILES = 60;

/** The paper's .tex and .bib files, read at the branch's head; the folder's prefix kept on each path. */
export async function readDraft(target: GitHubTarget, link: OverleafLink): Promise<DraftFile[]> {
  const prefix = prefixOf(link);
  const tree = await gh<{ tree: { path: string; type: string; sha: string; size?: number }[]; truncated?: boolean }>(
    target,
    `/git/trees/${encodeURIComponent(target.branch)}?recursive=1`,
  );
  const wanted = tree.tree
    .filter((item) => item.type === 'blob' && item.path.startsWith(prefix) && /\.(tex|bib)$/i.test(item.path) && (item.size ?? 0) < 1_000_000)
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, MAX_FILES);
  return Promise.all(
    wanted.map(async (item) => {
      const blob = await gh<{ content: string; encoding: string }>(target, `/git/blobs/${item.sha}`);
      return { path: item.path, text: decode(blob.content), sha: item.sha };
    }),
  );
}

function decode(content: string): string {
  const binary = atob(content.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** A file was changed in the repository — in Overleaf, most likely — since it was read here. */
export class DraftConflict extends Error {
  constructor(readonly paths: string[]) {
    super(`${paths.join(', ')} changed in the repository since it was opened here — in Overleaf, most likely. Reload to get it, then make the change again.`);
  }
}

/**
 * Writes the files that changed as one commit, after checking that none of
 * them moved in the repository since it was read: Overleaf's side of the
 * paper is never written over. What comes back is the files at their new
 * blobs, to carry on editing from.
 */
export async function writeDraft(target: GitHubTarget, changed: DraftFile[], message: string): Promise<DraftFile[]> {
  if (!changed.length) return [];
  const tree = await gh<{ tree: { path: string; type: string; sha: string }[] }>(target, `/git/trees/${encodeURIComponent(target.branch)}?recursive=1`);
  const now = new Map(tree.tree.map((item) => [item.path, item.sha]));
  const moved = changed.filter((file) => file.sha && now.get(file.path) !== file.sha).map((file) => file.path);
  if (moved.length) throw new DraftConflict(moved);
  await commitFiles(target, Object.fromEntries(changed.map((file) => [file.path, file.text])), message);
  const after = await gh<{ tree: { path: string; sha: string }[] }>(target, `/git/trees/${encodeURIComponent(target.branch)}?recursive=1`);
  const shas = new Map(after.tree.map((item) => [item.path, item.sha]));
  return changed.map((file) => ({ ...file, sha: shas.get(file.path) ?? file.sha }));
}

// ------------------------------------------------- the Write tab's files --

/** Overleaf's Git address for a project, from its address in the editor; null for a share link or another host. */
export function overleafGitUrl(url: string | undefined): string | null {
  const parsed = parseOverleafUrl(url ?? '');
  const id = parsed?.match(/^https:\/\/(?:www\.)?overleaf\.com\/project\/([0-9a-f]{24})$/)?.[1];
  return id ? `https://git.overleaf.com/${id}` : null;
}

/** A file the editor opens: LaTeX and the text around it. */
export const isTextFile = (path: string) => /\.(tex|bib|sty|cls|bst|bbx|cbx|txt|md|cfg|def|ltx|dtx|ins)$|(^|\/)(latexmkrc|\.latexmkrc)$/i.test(path);

/** What compiling leaves behind, kept out of the file list. */
export const isBuildFile = (path: string) => /\.(aux|log|fls|fdb_latexmk|synctex\.gz|synctex|out|toc|lof|lot|bbl|blg|bcf|run\.xml|nav|snm|vrb|xdv|dvi)$/i.test(path);

/** The bib file with the paper's entry put at its end; null when the draft has one for it already. */
export function withEntry(bib: string, paper: Paper, entries: BibEntry[]): string | null {
  if (entryFor(paper, entries)) return null;
  const key = keyFor(paper, entries);
  if (entries.some((entry) => entry.key === key)) return null;
  return `${bib.replace(/\s*$/, '')}${bib.trim() ? '\n\n' : ''}${bibtexFor(paper, entries)}\n`;
}

/** A folder for the paper under the Companion's: papers/<the project's name>. */
export const paperFolderFor = (name: string) =>
  `papers/${
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .slice(0, 48) || 'paper'
  }`;
