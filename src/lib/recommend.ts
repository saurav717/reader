// The papers an answer recommends, found for real: a title Claude gave is
// searched for across the indexes that have an API, and the result whose
// title is the same paper is the one taken. Nothing is taken on a near miss —
// a paper added to the Reading list has to be the paper that was named.

import { titleFits } from './citations';
import { hasProxy } from './api';
import { search } from './sources';
import type { PaperRef, SourceId } from '../types';

/**
 * The indexes with an API, asked together. Not Google Scholar: it has none,
 * and a run of searches one after another is what it turns away with a captcha.
 * arXiv needs the proxy, as it does in Discover.
 */
const sourcesForTitles = (): SourceId[] => (hasProxy() ? ['openalex', 'semanticscholar', 'crossref', 'arxiv'] : ['openalex', 'semanticscholar', 'crossref']);

/** The search result that is this title, or `null` when none of them is. */
export async function resolvePaper(title: string, signal?: AbortSignal): Promise<PaperRef | null> {
  const outcome = await search(title, sourcesForTitles(), { signal, limit: 10 });
  return outcome.results.find((result) => titleFits(result.title, title) && titleFits(title, result.title)) ?? null;
}
