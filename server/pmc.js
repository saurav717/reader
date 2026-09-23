// Papers in PubMed Central, fetched the way PubMed Central means programs to.
//
// A paper's PMC copy is offered by its indexes as a page on ncbi.nlm.nih.gov
// or europepmc.org, and both sites put a check for a person in front of an
// anonymous fetch — Europe PMC Cloudflare's, NCBI its own — which a proxy
// cannot answer and, from the Cloudflare Worker, cannot ever pass (see the
// README under "A site that checks for a person first"). But both also keep
// interfaces meant for programs, with no check on them: NCBI's OA Web
// Service names, for every article in the open-access subset, the file
// on its FTP host — which serves the same paths over https — and Europe
// PMC's REST API on ebi.ac.uk turns a PubMed id into a PMC id. So a PMC
// URL that would not hand over its file is asked for again this way, and
// the answer is the PDF itself, from a host that hands it to anyone.
//
// Web APIs only: the Worker imports this file too.

/** What a URL of PubMed Central's, or Europe PMC's, names: a PMC id, or a PubMed id to look one up from. */
export function pmcIdIn(target) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = decodeURIComponent(url.pathname);
  if (host === 'ncbi.nlm.nih.gov' || host === 'pmc.ncbi.nlm.nih.gov') {
    const pmcid = path.match(/\/(?:pmc\/)?articles\/(PMC\d+)/i)?.[1];
    return pmcid ? { pmcid: pmcid.toUpperCase() } : null;
  }
  if (host === 'europepmc.org') {
    const pmcid = path.match(/\/(?:articles?|abstract)\/(?:PMC\/)?(PMC\d+)/i)?.[1];
    if (pmcid) return { pmcid: pmcid.toUpperCase() };
    const pmid = path.match(/\/(?:article|abstract)\/MED\/(\d+)/i)?.[1];
    return pmid ? { pmid } : null;
  }
  return null;
}

/** The PMC id of a PubMed id, from Europe PMC's REST API, or null. */
export async function pmcIdOfPmid(pmid, { fetch = globalThis.fetch, userAgent } = {}) {
  const query = encodeURIComponent(`EXT_ID:${pmid} AND SRC:MED`);
  const response = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${query}&format=json&resultType=lite`, {
    headers: { 'User-Agent': userAgent, Accept: 'application/json' },
  });
  if (!response.ok) return null;
  const payload = await response.json().catch(() => null);
  const record = payload?.resultList?.result?.find?.((entry) => entry?.pmcid);
  const pmcid = String(record?.pmcid || '').match(/PMC\d+/i)?.[0];
  return pmcid ? pmcid.toUpperCase() : null;
}

/**
 * The files NCBI's OA Web Service names for a PMC id — the PDF first, then
 * the package the article's files come in — as https URLs on NCBI's FTP
 * host. Nothing for an article outside the open-access subset, which the
 * service says by naming no files.
 */
export function oaFilesIn(xml) {
  const files = [];
  for (const tag of String(xml || '').match(/<link\b[^>]*>/gi) || []) {
    const format = tag.match(/\bformat\s*=\s*"([^"]*)"/i)?.[1]?.toLowerCase();
    const href = tag.match(/\bhref\s*=\s*"([^"]*)"/i)?.[1];
    if (!href) continue;
    const https = href.replace(/^ftp:\/\/ftp\.ncbi\.nlm\.nih\.gov\//i, 'https://ftp.ncbi.nlm.nih.gov/');
    if (!/^https:\/\/ftp\.ncbi\.nlm\.nih\.gov\//i.test(https)) continue;
    files.push({ format: format || '', url: https });
  }
  return files.filter((file) => file.format === 'pdf').map((file) => file.url);
}

/**
 * The PDFs a PMC URL's paper can be fetched from without a check in the
 * way, in the order worth trying — or none, when the URL is not PubMed
 * Central's, the paper has no PMC id, or it is not in the open-access
 * subset. Every step asks a service meant for programs, so a refusal
 * here is an answer, not a wall.
 */
export async function pmcFiles(target, { fetch = globalThis.fetch, userAgent } = {}) {
  const named = pmcIdIn(target);
  if (!named) return [];
  let pmcid = named.pmcid || null;
  try {
    if (!pmcid && named.pmid) pmcid = await pmcIdOfPmid(named.pmid, { fetch, userAgent });
    if (!pmcid) return [];
    const response = await fetch(`https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=${encodeURIComponent(pmcid)}`, {
      headers: { 'User-Agent': userAgent, Accept: 'application/xml,text/xml,*/*' },
    });
    if (!response.ok) return [];
    return oaFilesIn(await response.text());
  } catch {
    return [];
  }
}
