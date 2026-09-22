/**
 * Google Scholar as a source, through the app's own proxy.
 *
 * Scholar publishes no API, so `server/scholar.js` fetches the pages a person
 * would open and parses them; this is the browser's half of that. It needs the
 * proxy for the same reason arXiv does — no CORS headers — and it needs it for
 * a second reason too: the request has to come from somewhere Scholar has not
 * already decided is a robot.
 *
 * Being refused is a normal outcome here, not an error to hide. `ScholarError`
 * carries `blocked`, and the panel says which sources are still answering
 * rather than showing an empty list.
 */
import type { AuthorRef, PaperRef } from '../types';
import { api, hasProxy } from './api';

export interface ScholarResult {
  id?: string;
  title: string;
  url?: string;
  pdfUrl?: string;
  pdfKind?: string;
  pdfHost?: string;
  authors: string[];
  venue?: string;
  year?: number;
  snippet: string;
  citedBy?: number;
  clusterId?: string;
  versionCount?: number;
}

export interface ScholarAuthor {
  userId?: string;
  name: string;
  profileUrl?: string;
  affiliation?: string;
  verifiedEmail?: string;
  interests: string[];
  citedBy?: number;
}

export class ScholarError extends Error {
  blocked: boolean;
  reason?: string;
  constructor(message: string, blocked = false, reason?: string) {
    super(message);
    this.blocked = blocked;
    this.reason = reason;
  }
}

const NO_PROXY =
  'Google Scholar needs the proxy: it sends no CORS headers, and a request from a browser tab would never reach it. Settings → Paper proxy.';

async function ask<T>(path: string, signal?: AbortSignal): Promise<T[]> {
  if (!hasProxy()) throw new ScholarError(NO_PROXY);
  let response: Response;
  try {
    response = await fetch(api(path), { signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ScholarError('Could not reach the proxy to ask Google Scholar.');
  }
  const payload = (await response.json().catch(() => ({}))) as {
    results?: T[];
    error?: string;
    blocked?: boolean;
    reason?: string;
  };
  if (!response.ok) {
    throw new ScholarError(payload.error || `Google Scholar search failed (${response.status})`, Boolean(payload.blocked), payload.reason);
  }
  return payload.results || [];
}

/**
 * A Scholar id is not a DOI and not an arXiv id, so a Scholar record folds in
 * with the other sources on its title — which is what `identity()` in
 * sources.ts falls back to. The cluster id rides along so that "all N
 * versions" can be asked for later.
 */
export function fromScholar(result: ScholarResult): PaperRef {
  const arxiv = (result.pdfUrl || result.url || '').match(/arxiv\.org\/(?:pdf|abs)\/([^?#]+?)(?:\.pdf)?$/i)?.[1];
  const doi = (result.url || '').match(/doi\.org\/(10\.[^?#\s]+)/i)?.[1];
  return {
    id: arxiv ? `arxiv:${arxiv}` : doi ? `doi:${doi.toLowerCase()}` : `scholar:${result.clusterId || result.id || result.title}`,
    source: 'scholar',
    title: result.title,
    authors: result.authors || [],
    // Scholar gives a two-line snippet rather than an abstract; it is marked as
    // what it is so the reader does not present it as one.
    abstract: result.snippet || '',
    published: result.year ? `${result.year}-01-01` : '',
    categories: [],
    arxivId: arxiv,
    doi: doi?.toLowerCase(),
    pdfUrl: result.pdfUrl,
    landingUrl: result.url,
    venue: result.venue,
    citedBy: result.citedBy,
    scholarCluster: result.clusterId,
    scholarVersions: result.versionCount,
  };
}

export async function searchScholar(query: string, page = 0, signal?: AbortSignal): Promise<PaperRef[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  // Scholar pages in tens, whatever we ask for.
  const results = await ask<ScholarResult>(
    `/scholar/search?q=${encodeURIComponent(trimmed)}&start=${page * 10}`,
    signal,
  );
  return results.map(fromScholar);
}

export async function scholarAuthors(name: string, signal?: AbortSignal): Promise<AuthorRef[]> {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const results = await ask<ScholarAuthor>(`/scholar/authors?name=${encodeURIComponent(trimmed)}`, signal);
  return results
    .filter((author) => author.name)
    .map((author) => ({
      id: `scholar:${author.userId || author.name}`,
      source: 'scholar' as const,
      name: author.name,
      affiliation: author.affiliation,
      citedBy: author.citedBy,
      scholarUserId: author.userId,
      scholarProfileUrl: author.profileUrl,
      interests: author.interests,
      verifiedEmail: author.verifiedEmail,
    }));
}

/** Everything on one person's Scholar profile, which is their own list. */
export async function scholarProfileWorks(userId: string, page = 0, signal?: AbortSignal): Promise<PaperRef[]> {
  const results = await ask<ScholarResult>(
    `/scholar/profile?user=${encodeURIComponent(userId)}&start=${page * 20}`,
    signal,
  );
  return results.map(fromScholar);
}

/**
 * Scholar's "All 84 versions" — every copy of one paper it knows of, which is
 * the longest such list anywhere and the reason this source is worth the
 * trouble. Each version is a result in its own right, carrying the host it
 * sits on and, where Scholar found one, a direct link to the file.
 */
export async function scholarVersions(clusterId: string, signal?: AbortSignal): Promise<ScholarResult[]> {
  if (!/^\d{1,25}$/.test(clusterId)) return [];
  return ask<ScholarResult>(`/scholar/versions?cluster=${encodeURIComponent(clusterId)}`, signal);
}
