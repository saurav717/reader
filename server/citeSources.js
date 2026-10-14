// The places a paper's own BibTeX entry is fetched from, and nothing else.
//
// Most of them hand the entry over only to a server — no CORS on
// arxiv.org/bibtex, dblp's .bib files or the ACL Anthology's — so the app
// asks the proxy's /cite route for them. The route forwards only to these
// hosts, only on these paths, only over HTTPS: a list, not a general fetch.
// Shared by server/api.js and worker/index.js.

/** [host, path] pairs: the hosts that publish BibTeX, and where on each. */
const CITE_SOURCES = [
  // arXiv's own export of a preprint: https://arxiv.org/bibtex/2202.08906
  [/^arxiv\.org$/, /^\/bibtex\/(?:[0-9]{4}\.[0-9]{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/[0-9]{7})(?:v[0-9]+)?$/],
  // dblp's record: https://dblp.org/rec/conf/nips/Vaswani17.bib
  [/^dblp\.org$/, /^\/rec\/[\w.:/-]+\.bib$/],
  // The ACL Anthology's: https://aclanthology.org/2020.acl-main.1.bib
  [/^aclanthology\.org$/, /^\/[\w.-]+\.bib$/],
  // The publisher's record by DOI, as Crossref transforms it.
  [/^api\.crossref\.org$/, /^\/works\/[^/]+(?:\/[^/]+)*\/transform\/application\/x-bibtex$/],
  // DOI content negotiation (Crossref and DataCite alike): the Accept header does the asking.
  [/^doi\.org$/, /^\/10\.[0-9]{4,9}\/\S+$/],
  // DataCite's record, for an arXiv DOI (10.48550) among others.
  [/^api\.datacite\.org$/, /^\/dois\/application\/x-bibtex\/10\.[0-9]{4,9}\/\S+$/],
  // PMLR (ICML, AISTATS, …) and the NeurIPS proceedings publish a .bib per paper.
  [/^proceedings\.mlr\.press$/, /^\/v[0-9]+\/[\w.-]+\.bib$/],
  [/^proceedings\.neurips\.cc$/, /\.bib$/],
  // Semantic Scholar's and OpenReview's APIs answer the page directly; through here too, when the page's own call is refused.
  [/^api\.semanticscholar\.org$/, /^\/graph\/v1\/paper\/[^/]+$/],
  [/^api2?\.openreview\.net$/, /^\/notes$/],
];

/** The URL as it will be fetched, or null when it is not one of the sources. */
export function citeSourceUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ''));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const fits = CITE_SOURCES.some(([host, path]) => host.test(url.hostname) && path.test(url.pathname));
  return fits ? url.href : null;
}

/** What the fetch asks for: BibTeX first, as doi.org and the Anthology want it asked. */
export const CITE_ACCEPT = 'application/x-bibtex; charset=utf-8, text/x-bibtex;q=0.9, text/plain;q=0.8, application/json;q=0.7, */*;q=0.1';

/** The content type the answer goes out under: text, unless the source spoke JSON. */
export function citeContentType(upstreamType) {
  return /json/i.test(upstreamType || '') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
}
