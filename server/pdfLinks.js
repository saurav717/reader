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
    if (href && /\.pdf(\?|$)|\/pdf\/|stampPDF|getPDF/i.test(href)) push(href);
  }
  return found.filter((url) => /^https:\/\//i.test(url));
}
