import type { Collection, Highlight, Paper, Settings } from '../types';
import { HIGHLIGHT_COLORS } from '../types';
import { pathName, sidecar } from './sidecar';

/**
 * The annotation layer, mirrored into a Git repository.
 *
 * Drive holds the PDFs; this holds everything that is text. The split is on
 * purpose: a PDF is a binary blob that bloats a repository's history forever
 * and gains nothing from being diffed, whereas notes and highlights are small,
 * textual, and worth being able to read back through `git log`.
 *
 * Every flush is **one commit**, built through the Git Data API — blobs, then
 * a tree on top of the current one, then a commit, then a ref update. The
 * Contents API would be a request and a commit per file, which would turn a
 * reading session into a hundred commits saying nothing.
 */

const API = 'https://api.github.com';

export interface GitHubTarget {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}

/** Pulls `owner/repo` out of whatever shape the person pasted in. */
export function parseRepo(value: string): { owner: string; repo: string } | null {
  const trimmed = (value || '').trim().replace(/\.git$/, '');
  if (!trimmed) return null;
  const match = trimmed.match(/^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)\/?$/);
  return match ? { owner: match[1], repo: match[2] } : null;
}

export function targetFrom(settings: Settings): GitHubTarget | null {
  const parsed = parseRepo(settings.githubRepo);
  if (!parsed || !settings.githubToken.trim()) return null;
  return {
    ...parsed,
    branch: settings.githubBranch.trim() || 'main',
    token: settings.githubToken.trim(),
  };
}

async function gh<T>(target: GitHubTarget, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}/repos/${target.owner}/${target.repo}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${target.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { message?: string } | null;
    const message = detail?.message || `${response.status}`;
    if (response.status === 401) throw new Error('GitHub rejected the token — check it has not expired.');
    if (response.status === 403) {
      throw new Error(`GitHub refused the write (${message}). The token needs Contents: read and write on this repository.`);
    }
    if (response.status === 404) {
      throw new Error(
        `${target.owner}/${target.repo} could not be found. A fine-grained token only sees repositories it was granted, and a private repository it was not granted answers 404 rather than 403.`,
      );
    }
    throw new Error(`GitHub request failed (${message}).`);
  }
  return (await response.json()) as T;
}

// ------------------------------------------------------------------ files ----

function escapeBib(value: string): string {
  return value.replace(/[{}\\]/g, '').replace(/[&%$#_]/g, (character) => `\\${character}`);
}

function familyName(author: string): string {
  const parts = author.trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : parts[0] || '';
}

/** A cite key a person would recognise: lecun2015deep. */
export function citeKey(paper: Paper): string {
  const author = familyName(paper.authors[0] || '').toLowerCase().replace(/[^a-z]/g, '') || 'anon';
  const year = (paper.published || '').slice(0, 4) || 'nd';
  const word =
    (paper.title.toLowerCase().match(/[a-z]{4,}/g) || []).find((candidate) => candidate.length >= 4) || 'paper';
  return `${author}${year}${word}`;
}

export function toBibtex(paper: Paper): string {
  // A preprint with no venue is a @misc; anything that was published somewhere
  // is an @article, which is what a bibliography style expects to be given.
  const type = paper.venue ? 'article' : 'misc';
  const fields: [string, string | undefined][] = [
    ['title', paper.title],
    ['author', paper.authors.map(escapeBib).join(' and ') || undefined],
    ['year', (paper.published || '').slice(0, 4) || undefined],
    ['journal', paper.venue],
    ['doi', paper.doi],
    ['eprint', paper.arxivId],
    ['archivePrefix', paper.arxivId ? 'arXiv' : undefined],
    ['url', paper.landingUrl],
    ['keywords', paper.tags.join(', ') || undefined],
  ];
  const body = fields
    .filter(([, value]) => value)
    .map(([key, value]) => `  ${key} = {${escapeBib(String(value))}}`)
    .join(',\n');
  return `@${type}{${citeKey(paper)},\n${body}\n}`;
}

/** The human-readable half: what you actually marked up, as Markdown. */
export function toMarkdown(paper: Paper, highlights: Highlight[], collectionNames: string[]): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(`title: ${JSON.stringify(paper.title)}`);
  if (paper.authors.length) lines.push(`authors: ${JSON.stringify(paper.authors)}`);
  if (paper.published) lines.push(`published: ${paper.published}`);
  if (paper.venue) lines.push(`venue: ${JSON.stringify(paper.venue)}`);
  if (paper.doi) lines.push(`doi: ${paper.doi}`);
  if (paper.arxivId) lines.push(`arxiv: ${paper.arxivId}`);
  if (collectionNames.length) lines.push(`collections: ${JSON.stringify(collectionNames)}`);
  if (paper.tags.length) lines.push(`tags: ${JSON.stringify(paper.tags)}`);
  lines.push(`added: ${paper.addedAt}`);
  lines.push(`cite: ${citeKey(paper)}`);
  lines.push('---', '');
  lines.push(`# ${paper.title}`, '');
  if (paper.authors.length) lines.push(`*${paper.authors.join(', ')}*`, '');
  if (paper.landingUrl) lines.push(`[Source](${paper.landingUrl})`, '');
  if (paper.abstract) lines.push('## Abstract', '', paper.abstract, '');

  if (highlights.length) {
    lines.push(`## Highlights (${highlights.length})`, '');
    for (const colour of HIGHLIGHT_COLORS) {
      const group = highlights.filter((highlight) => highlight.color === colour.id);
      if (!group.length) continue;
      lines.push(`### ${colour.label}`, '');
      for (const highlight of group) {
        if (highlight.section) lines.push(`*${highlight.section}*`, '');
        lines.push(`> ${highlight.exact.replace(/\n+/g, ' ')}`, '');
        if (highlight.note) lines.push(highlight.note, '');
        if (highlight.orphaned) lines.push('`could no longer be located in the text`', '');
      }
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

function collectionsOf(paper: Paper, collections: Collection[]): string[] {
  return paper.collectionIds
    .map((id) => collections.find((collection) => collection.id === id)?.name)
    .filter((name): name is string => Boolean(name));
}

/** Where a paper lives in the repository. One folder per collection. */
export function pathFor(paper: Paper, collections: Collection[]): string {
  const names = collectionsOf(paper, collections);
  const folder = names.length
    ? names[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unsorted'
    : 'unsorted';
  return `collections/${folder}/${pathName(paper)}`;
}

export interface RepoFiles {
  [path: string]: string;
}

/**
 * Everything the given papers contribute to the repository: a sidecar and a
 * Markdown note each, plus the index and bibliography, which are rebuilt from
 * the whole library rather than patched, so a removed paper actually leaves.
 */
export function filesFor(
  papers: Paper[],
  context: { collections: Collection[]; highlights: Highlight[]; library: Paper[] },
): RepoFiles {
  const files: RepoFiles = {};
  for (const paper of papers) {
    const names = collectionsOf(paper, context.collections);
    const highlights = context.highlights.filter((highlight) => highlight.paperId === paper.id);
    const stem = pathFor(paper, context.collections);
    files[`${stem}.json`] = `${JSON.stringify(sidecar(paper, highlights, names), null, 2)}\n`;
    files[`${stem}.md`] = toMarkdown(paper, highlights, names);
  }

  const library = context.library
    .slice()
    .sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1))
    .map((paper) => ({
      id: paper.id,
      title: paper.title,
      authors: paper.authors,
      published: paper.published,
      venue: paper.venue,
      doi: paper.doi,
      arxivId: paper.arxivId,
      collections: collectionsOf(paper, context.collections),
      tags: paper.tags,
      addedAt: paper.addedAt,
      cite: citeKey(paper),
      path: `${pathFor(paper, context.collections)}.md`,
      highlights: context.highlights.filter((highlight) => highlight.paperId === paper.id).length,
    }));

  files['library.json'] = `${JSON.stringify({ generator: 'reader', updatedAt: new Date().toISOString(), papers: library }, null, 2)}\n`;
  files['references.bib'] = `${context.library
    .slice()
    .sort((a, b) => citeKey(a).localeCompare(citeKey(b)))
    .map(toBibtex)
    .join('\n\n')}\n`;
  return files;
}

// ----------------------------------------------------------------- commit ----

interface RefResponse {
  object: { sha: string };
}
interface CommitResponse {
  sha: string;
  tree: { sha: string };
}

export interface CommitResult {
  /** Null when nothing had changed and no commit was needed. */
  commit: string | null;
  paths: string[];
}

/**
 * Writes `files` to the branch as a single commit. Paths not mentioned are
 * left exactly as they are, because the new tree is built on top of the
 * current one rather than replacing it.
 */
export async function commitFiles(
  target: GitHubTarget,
  files: RepoFiles,
  message: string,
): Promise<CommitResult> {
  const paths = Object.keys(files);
  if (!paths.length) return { commit: null, paths: [] };

  let ref: RefResponse;
  try {
    ref = await gh<RefResponse>(target, `/git/ref/heads/${encodeURIComponent(target.branch)}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      /could not be found|failed \(Not Found\)/i.test(detail)
        ? `Branch "${target.branch}" does not exist in ${target.owner}/${target.repo}. Create the repository with at least one commit — an empty repository has no branch to write to.`
        : detail,
    );
  }

  const head = await gh<CommitResponse>(target, `/git/commits/${ref.object.sha}`);

  // Blobs first: base64 so that anything non-ASCII in a title or a note
  // survives the round trip, which a raw `content` string does not guarantee.
  const blobs = await Promise.all(
    paths.map(async (path) => {
      const created = await gh<{ sha: string }>(target, '/git/blobs', {
        method: 'POST',
        body: JSON.stringify({
          content: base64(files[path]),
          encoding: 'base64',
        }),
      });
      return { path, sha: created.sha };
    }),
  );

  const tree = await gh<{ sha: string }>(target, '/git/trees', {
    method: 'POST',
    body: JSON.stringify({
      base_tree: head.tree.sha,
      tree: blobs.map((blob) => ({ path: blob.path, mode: '100644', type: 'blob', sha: blob.sha })),
    }),
  });

  // An identical tree means nothing actually changed; committing anyway would
  // fill the history with empty commits every time a paper is re-synced.
  if (tree.sha === head.tree.sha) return { commit: null, paths };

  const commit = await gh<{ sha: string }>(target, '/git/commits', {
    method: 'POST',
    body: JSON.stringify({ message, tree: tree.sha, parents: [ref.object.sha] }),
  });

  await gh(target, `/git/refs/heads/${encodeURIComponent(target.branch)}`, {
    method: 'PATCH',
    // No force: if someone else pushed in between, this fails rather than
    // throwing their commit away, and the next flush rebuilds on top of theirs.
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });

  return { commit: commit.sha, paths };
}

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A commit message that says what the flush actually did. */
export function commitMessage(papers: Paper[], highlightCount: number): string {
  const head =
    papers.length === 1 ? `reader: ${papers[0].title.slice(0, 60)}` : `reader: sync ${papers.length} papers`;
  return highlightCount ? `${head}\n\n${highlightCount} highlight${highlightCount === 1 ? '' : 's'}.` : head;
}

export interface GitHubSyncResult {
  commit: string | null;
  paths: string[];
  syncedAt: string;
}

export async function syncPapersToGitHub(
  papers: Paper[],
  context: { collections: Collection[]; highlights: Highlight[]; library: Paper[]; settings: Settings },
): Promise<GitHubSyncResult> {
  const target = targetFrom(context.settings);
  if (!target) throw new Error('No GitHub repository and token are configured');
  const files = filesFor(papers, context);
  const highlightCount = context.highlights.filter((highlight) =>
    papers.some((paper) => paper.id === highlight.paperId),
  ).length;
  const result = await commitFiles(target, files, commitMessage(papers, highlightCount));
  return { ...result, syncedAt: new Date().toISOString() };
}
