// Where a publisher keeps the file, given its page — web APIs only, so the
// Worker can import it as server/access.js and server/browse.js do. The
// decisions are pinned by scripts/access.test.mjs.

/**
 * The URL a signed-in browser should ask for, given the one the indexes gave
 * us. Mostly that is the same URL. IEEE is the exception worth knowing about:
 * its landing page never links the file directly, but the stamp endpoints
 * answer with it once there is a session.
 */
export function pdfCandidates(target) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return [target];
  }
  const host = url.hostname.replace(/^www\./, '');
  if (host === 'ieeexplore.ieee.org') {
    const arnumber =
      url.pathname.match(/\/(?:abstract\/)?document\/(\d+)/)?.[1] || url.searchParams.get('arnumber');
    if (arnumber) {
      return [
        `https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=${arnumber}`,
        `https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=${arnumber}`,
        target,
      ];
    }
  }
  return [target];
}

const attr = (tag, name) => {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
};

const decode = (value) =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\\\//g, '/');

/**
 * Where a landing page says its PDF is. Publishers agree on very little, but
 * most of them put a `citation_pdf_url` meta tag on the page for Google
 * Scholar's sake; IEEE keeps the path in a JSON blob instead, and its stamp
 * page wraps the file in a frame. Absolute URLs, in the order worth trying.
 */
/** How many of a page's links are worth trying before the page is given up on. */
const MAX_LINKS = 12;

export function pdfLinksIn(html, base) {
  const found = [];
  const push = (value) => {
    if (!value) return;
    try {
      const absolute = new URL(decode(value), base).toString();
      if (!found.includes(absolute)) found.push(absolute);
    } catch {
      // not a URL
    }
  };
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const name = (attr(tag, 'name') || attr(tag, 'property') || '').toLowerCase();
    if (name === 'citation_pdf_url') push(attr(tag, 'content'));
  }
  // IEEE: "pdfPath":"/iel7/…/09000000.pdf" and sometimes "pdfUrl":"/stamp/…"
  for (const match of html.matchAll(/"(?:pdfPath|pdfUrl)"\s*:\s*"([^"]+)"/g)) push(match[1]);
  for (const tag of html.match(/<i?frame\b[^>]*>/gi) || []) push(attr(tag, 'src'));
  for (const tag of html.match(/<a\b[^>]*>/gi) || []) {
    const href = attr(tag, 'href');
    if (href && /\.pdf(\?|$)|\/pdf\/|stampPDF|getPDF|[?&]output=pdf\b/i.test(href)) push(href);
  }
  // Google Books writes its own links `http://`; everyone else's stay out.
  // And only the first dozen: the file is among the first few links on any
  // page that has it, and a page built to keep a fetcher busy could list
  // thousands.
  return found
    .map(httpsGoogleBooks)
    .filter((url, index, all) => /^https:\/\//i.test(url) && !/\.acsm(\?|$)/i.test(url) && all.indexOf(url) === index)
    .slice(0, MAX_LINKS);
}

// ---------------------------------------------------------- Google Books ----

const GOOGLE_BOOKS_HOST = /^(?:books\.google\.[a-z.]+|(?:www\.)?google\.[a-z.]+|play\.google\.com)$/i;

/**
 * The volume id of a Google Books page, in any of the shapes Google gives
 * one: `books.google.com/books?id=…`, `…/books/about/Title.html?id=…`, the
 * newer `google.com/books/edition/Title/…`, and Play Books' store page.
 * Null for anything else, a Google search included.
 */
export function googleBooksId(target) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!GOOGLE_BOOKS_HOST.test(host)) return null;
  const valid = (id) => (id && /^[A-Za-z0-9_-]{8,20}$/.test(id) ? id : null);
  if (host.startsWith('books.google.')) return valid(url.searchParams.get('id'));
  if (host === 'play.google.com') {
    return url.pathname.startsWith('/store/books/details') ? valid(url.searchParams.get('id')) : null;
  }
  const edition = url.pathname.match(/^\/books\/edition\/[^/]*\/([A-Za-z0-9_-]+)/);
  return edition ? valid(edition[1]) : null;
}

/** A Google Books link written `http://`, as its own pages write them, made `https://`. */
const httpsGoogleBooks = (value) =>
  value.replace(/^http:\/\/(books\.google\.[a-z.]+|books\.googleusercontent\.com)\//i, 'https://$1/');

/**
 * Where Google Books keeps a volume's PDF, and — when it keeps none a person
 * may download — why, in words for the person. The page itself never holds
 * the file: its viewer draws the pages as pictures, and its "Download PDF"
 * link carries a signature only Google's own answer knows. So the Books API
 * is asked for the volume's `downloadLink`, and the classic book page, whose
 * download link carries that signature, is walked after it.
 *
 * Only a book Google lets anyone download — public domain, or free — has a
 * PDF to find. A preview is pictures of some of the pages, and a bought
 * ebook is Adobe's DRM (`.acsm`); neither is a file this can or should take.
 *
 * `fetchImpl` is the proxy's own fetch, so the tests can stand in for Google.
 */
export async function googleBooksPdf(target, fetchImpl = fetch) {
  const id = googleBooksId(target);
  if (!id) return null;
  const page = `https://books.google.com/books?id=${encodeURIComponent(id)}&hl=en`;
  let volume = null;
  try {
    const response = await fetchImpl(`https://www.googleapis.com/books/v1/volumes/${encodeURIComponent(id)}`, {
      headers: { Accept: 'application/json' },
    });
    if (response.ok) volume = await response.json();
  } catch {
    // The page is still worth walking without the API's answer.
  }
  const access = volume?.accessInfo || {};
  const link = typeof access.pdf?.downloadLink === 'string' ? access.pdf.downloadLink : '';
  const drm = /\.acsm(\?|$)|acs4_fulfillment/i.test(link);
  const urls = [];
  if (link && !drm) urls.push(httpsGoogleBooks(link));
  urls.push(`https://books.google.com/books/download/?id=${encodeURIComponent(id)}&output=pdf`, page);

  let why = null;
  if (volume && !(access.pdf?.isAvailable && link && !drm)) {
    const title = volume.volumeInfo?.title ? `“${volume.volumeInfo.title}”` : 'this book';
    if (access.viewability === 'PARTIAL' || access.viewability === 'NO_PAGES') {
      why = `Google Books only shows a preview of ${title} — some of its pages, as pictures — and has no PDF of it to download`;
    } else if (drm) {
      why = `Google Books sells ${title} as a protected ebook (an Adobe .acsm file), not as a PDF anyone can download`;
    } else {
      why = `Google Books offers no PDF of ${title} to download`;
    }
    why += '. Look for it under Books & PDFs in Discover — Open Library and the Internet Archive often have a free scan — or drop in a copy of your own.';
  }
  return { id, urls, why };
}

/**
 * Every URL "Fetch the PDF from this page" should try, in order, for the
 * page the browser is on — and, where the site is one that can say so, why
 * there may be no file to find. Shared by the Node proxy and the Worker.
 */
export async function grabTargets(url, html, fetchImpl = fetch) {
  const books = await googleBooksPdf(url, fetchImpl);
  const urls = [...(books?.urls || []), ...pdfCandidates(url), ...pdfLinksIn(html, url), url];
  return { urls: urls.filter((each, index) => urls.indexOf(each) === index), why: books?.why || null };
}
