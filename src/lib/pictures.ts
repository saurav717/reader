// ===========================================================================
//  Real pictures on the Explain page — not drawn by the model, but found.
//
//  The page's own diagrams are SVG the model draws. Beside them it may now
//  ask for a picture that exists: the paper's own figure or table, by the
//  number its caption gives it, or an image from the web, by the Wikipedia
//  article it heads or a few words to search Wikimedia Commons for. The model
//  names the picture in an ```image``` block (explain.ts); this finds it.
//
//  The paper's figure is looked for where it is cheapest first:
//    1. on the page, in the Reflow column, where the paper's figures are
//       already images (figures.ts does the matching by caption);
//    2. in arXiv's HTML rendering, when the paper has an arXiv id — the
//       figures there are the authors' own image files, at their own size;
//    3. in the PDF the reader is showing, reflowed once (pdfReflow.ts), which
//       cuts every figure out of its page.
//  A web picture is the address the model gave, when it loads; else an image
//  search for its words — Google Images, through the paper proxy's SerpApi
//  key (or Brave's or Tavily's image search, whichever key the proxy has;
//  server/webSearch.js) — taking the first result that will actually load
//  here; else the lead image of the Wikipedia article it named; else the
//  first image Wikimedia Commons finds, which needs no key at all. The
//  Wikimedia ones come with who made them and under what licence; a search
//  result with the site it is on. The page shows that under the picture,
//  linked. A web picture found is remembered in this browser, so each one
//  is searched for once.
// ===========================================================================

import { names } from './figures';
import { pdfShown } from './screen';
import { api, apiFetch, hasProxy, hasProxyToken, proxyHealth } from './api';

/** What an ```image``` block asks for. */
export interface PictureRequest {
  /** The paper's own figure, or table, by its number. */
  figure?: string;
  table?: string;
  /** An image address the model was sure of. */
  src?: string;
  /** An English Wikipedia article whose lead image is the picture. */
  wiki?: string;
  /** Words to search for an image with: Google Images through the proxy, else Wikimedia Commons. */
  search?: string;
}

export interface Picture {
  /** One image, or the panels of a figure that is several. */
  srcs: string[];
  from: 'paper' | 'web';
  /** Where it was found, for the line under it: "Figure 3 of the paper", "Wikimedia Commons". */
  where: string;
  /** Who made it, and the licence, for a picture from the web. */
  credit?: string;
  license?: string;
  /** The page the picture is described on. */
  link?: string;
}

/** Most panels of one figure shown side by side. */
const MAX_PANELS = 6;
/** How wide a picture from the web is asked for. */
const WEB_WIDTH = 1280;
const STORE_KEY = 'reader.explain.pictures';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';

export const isPaperPicture = (request: PictureRequest) => Boolean(request.figure || request.table);

/** A short name for what is asked, for the page while it looks and when it finds nothing. */
export function pictureLabel(request: PictureRequest): string {
  if (request.figure) return `Figure ${request.figure} of the paper`;
  if (request.table) return `Table ${request.table} of the paper`;
  if (request.wiki) return `the picture on Wikipedia’s “${request.wiki}”`;
  if (request.search) return `a picture of “${request.search}”`;
  return 'the picture';
}

// ---------------------------------------------------------------------------
// The paper's own figures
// ---------------------------------------------------------------------------

interface Found {
  caption: string;
  srcs: string[];
}

/** The figures in a rendering of the paper: each one's caption and the images in it. */
function figuresIn(html: string, base?: string): Found[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: Found[] = [];
  // The outermost figure is the one with the numbered caption; its panels are figures inside it.
  for (const figure of Array.from(doc.querySelectorAll<HTMLElement>('figure, .ltx_float'))) {
    if (figure.parentElement?.closest('figure, .ltx_float')) continue;
    const caption = Array.from(figure.querySelectorAll(':scope > figcaption, :scope > .ltx_caption'))
      .map((node) => node.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const srcs = Array.from(figure.querySelectorAll('img'))
      .map((image) => image.getAttribute('src') ?? '')
      .filter((src) => src && !src.startsWith('data:image/svg'))
      .map((src) => {
        try {
          return base ? new URL(src, base).href : src;
        } catch {
          return src;
        }
      })
      .slice(0, MAX_PANELS);
    if (srcs.length) out.push({ caption: caption || figure.querySelector('img')?.getAttribute('alt') || '', srcs });
  }
  return out;
}

const pick = (found: Found[], kind: string, ref: string) => found.find((figure) => names(figure.caption, kind, ref));

const arxivFigures = new Map<string, Promise<Found[]>>();

/** The figures of arXiv's HTML rendering, read once per paper. */
function fromArxiv(arxivId: string): Promise<Found[]> {
  let figures = arxivFigures.get(arxivId);
  if (!figures) {
    figures = (async () => {
      if (!hasProxy()) return [];
      const response = await fetch(api(`/arxiv/html?id=${encodeURIComponent(arxivId)}`));
      if (!response.ok) return [];
      const payload = (await response.json()) as { html: string; base: string };
      return figuresIn(payload.html, payload.base);
    })().catch(() => []);
    arxivFigures.set(arxivId, figures);
    // Nothing found may be a proxy that was down: the next look tries again.
    void figures.then((found) => {
      if (!found.length) arxivFigures.delete(arxivId);
    });
  }
  return figures;
}

const pdfFigures = new WeakMap<Blob, Promise<Found[]>>();

/**
 * The figures of the PDF the reader is showing, cut out of their pages. Read
 * once per file; the images stay for as long as the file is the one shown.
 */
function fromPdf(blob: Blob): Promise<Found[]> {
  let figures = pdfFigures.get(blob);
  if (!figures) {
    figures = (async () => {
      const { reflowPdf } = await import('./pdfReflow');
      const reflowed = await reflowPdf(blob);
      return reflowed ? figuresIn(reflowed.html) : [];
    })().catch(() => []);
    pdfFigures.set(blob, figures);
  }
  return figures;
}

async function paperPicture(kind: 'figure' | 'table', ref: string, arxivId?: string): Promise<Picture | null> {
  const where = `${kind === 'table' ? 'Table' : 'Figure'} ${ref} of the paper`;
  // The Reflow column's own figures. Its images load as they are scrolled to, and under the Explain page they may
  // not have been, so the addresses are read as they are written rather than waited for.
  const body = document.querySelector('.paper-body');
  const shown = body ? pick(figuresIn(body.innerHTML, document.baseURI), kind, ref) : undefined;
  if (shown) return { srcs: shown.srcs, from: 'paper', where };
  if (arxivId) {
    const found = pick(await fromArxiv(arxivId), kind, ref);
    if (found) return { srcs: found.srcs, from: 'paper', where: `${where}, from arXiv` };
  }
  const pdf = pdfShown();
  if (pdf) {
    const found = pick(await fromPdf(pdf), kind, ref);
    if (found) return { srcs: found.srcs, from: 'paper', where };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pictures from the web
// ---------------------------------------------------------------------------

/** Text out of the HTML Wikimedia keeps its credits in. */
const plain = (html: string | undefined) => {
  if (!html) return undefined;
  const text = new DOMParser().parseFromString(html, 'text/html').body.textContent?.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 120) : undefined;
};

interface ImageInfo {
  url?: string;
  thumburl?: string;
  descriptionurl?: string;
  mime?: string;
  width?: number;
  extmetadata?: Record<string, { value?: string }>;
}

const SHOWABLE = /^image\/(png|jpe?g|gif|webp|svg\+xml)$/;

function asPicture(info: ImageInfo | undefined, where: string): Picture | null {
  const src = info?.thumburl || info?.url;
  if (!info || !src || (info.mime && !SHOWABLE.test(info.mime))) return null;
  const meta = info.extmetadata ?? {};
  return {
    srcs: [src],
    from: 'web',
    where,
    credit: plain(meta.Artist?.value),
    license: plain(meta.LicenseShortName?.value),
    link: info.descriptionurl,
  };
}

async function wikimedia(endpoint: string, params: Record<string, string>): Promise<{ query?: { pages?: Record<string, Record<string, unknown>> } }> {
  // origin=* is what lets a page anywhere read the answer.
  const url = `${endpoint}?${new URLSearchParams({ action: 'query', format: 'json', origin: '*', ...params })}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Wikimedia answered ${response.status}`);
  return response.json();
}

const IMAGE_INFO = { prop: 'imageinfo', iiprop: 'url|mime|size|extmetadata', iiurlwidth: String(WEB_WIDTH), iiextmetadatafilter: 'Artist|LicenseShortName' };

/** The lead image of an English Wikipedia article, with its credit from Commons. */
async function fromWikipedia(title: string): Promise<Picture | null> {
  const lead = await wikimedia(WIKIPEDIA_API, { prop: 'pageimages', piprop: 'name', titles: title, redirects: '1' });
  const page = Object.values(lead.query?.pages ?? {})[0] as { pageimage?: string; title?: string } | undefined;
  if (!page?.pageimage) return null;
  const file = await wikimedia(COMMONS_API, { ...IMAGE_INFO, titles: `File:${page.pageimage}` });
  const info = (Object.values(file.query?.pages ?? {})[0] as { imageinfo?: ImageInfo[] } | undefined)?.imageinfo?.[0];
  // A file kept on Wikipedia itself, not Commons, has no entry there; ask Wikipedia for it.
  if (!info) {
    const local = await wikimedia(WIKIPEDIA_API, { ...IMAGE_INFO, titles: `File:${page.pageimage}` });
    const own = (Object.values(local.query?.pages ?? {})[0] as { imageinfo?: ImageInfo[] } | undefined)?.imageinfo?.[0];
    return asPicture(own, `Wikipedia · ${page.title ?? title}`);
  }
  return asPicture(info, `Wikipedia · ${page.title ?? title}`);
}

/** The first image Wikimedia Commons finds for some words. */
async function fromCommons(words: string): Promise<Picture | null> {
  const found = await wikimedia(COMMONS_API, { ...IMAGE_INFO, generator: 'search', gsrsearch: `${words} filetype:bitmap|drawing`, gsrnamespace: '6', gsrlimit: '8' });
  const pages = Object.values(found.query?.pages ?? {}) as { index?: number; imageinfo?: ImageInfo[] }[];
  pages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  for (const page of pages) {
    const info = page.imageinfo?.[0];
    if ((info?.width ?? 0) < 200) continue;
    const picture = asPicture(info, 'Wikimedia Commons');
    if (picture) return picture;
  }
  return null;
}

interface SearchedImage {
  src: string;
  thumb?: string;
  width?: number;
  title?: string;
  page?: string;
  source?: string;
}

/** Whether this browser may ask the proxy to search for images: it has a key for it, and the token or a pass when it wants one. */
async function canSearchImages(): Promise<boolean> {
  if (!hasProxy()) return false;
  const health = await proxyHealth();
  return Boolean(health?.images && (!health.auth || hasProxyToken()));
}

/**
 * The first image an image search finds that loads here. A site may refuse
 * to be shown elsewhere, so each result is tried, its own address first and
 * then the search's thumbnail of it, and a small one is passed over.
 */
async function fromImageSearch(words: string): Promise<Picture | null> {
  if (!(await canSearchImages())) return null;
  const response = await apiFetch(`/web/images?q=${encodeURIComponent(words)}`);
  if (!response.ok) return null;
  const body = (await response.json()) as { via?: string; images?: SearchedImage[] };
  const via = body.via === 'serpapi' ? 'Google Images' : body.via === 'brave' ? 'Brave image search' : 'image search';
  const candidates = (body.images ?? []).filter((image) => !image.width || image.width >= 240).slice(0, 6);
  for (const image of candidates) {
    let site = image.source ?? '';
    try {
      site ||= new URL(image.page ?? image.src).hostname.replace(/^www\./, '');
    } catch {
      // no site, then
    }
    const picture = (src: string): Picture => ({ srcs: [src], from: 'web', where: site || via, credit: `found by ${via}`, link: image.page ?? image.src });
    if (await loads(image.src)) return picture(image.src);
  }
  // Nothing would show itself here: the search's own thumbnail of the first, which always does.
  const first = candidates.find((image) => image.thumb);
  if (first?.thumb && (await loads(first.thumb))) {
    return { srcs: [first.thumb], from: 'web', where: first.source || via, credit: `found by ${via}`, link: first.page ?? first.src };
  }
  return null;
}

/** Whether an image address draws: a model's guess at one may not exist. */
function loads(src: string, ms = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const image = new Image();
    const timer = window.setTimeout(() => done(false), ms);
    const done = (ok: boolean) => {
      window.clearTimeout(timer);
      image.onload = image.onerror = null;
      resolve(ok);
    };
    image.onload = () => done(image.naturalWidth > 1);
    image.onerror = () => done(false);
    image.referrerPolicy = 'no-referrer';
    image.src = src;
  });
}

const remembered = (): Record<string, Picture> => {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, Picture>;
  } catch {
    return {};
  }
};

function remember(key: string, picture: Picture) {
  try {
    const all = remembered();
    all[key] = picture;
    // The newest two hundred: plenty for every page read lately.
    const keys = Object.keys(all);
    for (const old of keys.slice(0, Math.max(0, keys.length - 200))) delete all[old];
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    // private mode, or full: it is looked up again next time
  }
}

async function webPicture(request: PictureRequest): Promise<Picture | null> {
  const key = JSON.stringify([request.src ?? '', request.wiki ?? '', request.search ?? '']);
  const known = remembered()[key];
  if (known) return known;
  let picture: Picture | null = null;
  if (request.src && /^https:\/\//i.test(request.src) && (await loads(request.src))) {
    let host = '';
    try {
      host = new URL(request.src).hostname.replace(/^www\./, '');
    } catch {
      // checked above
    }
    picture = { srcs: [request.src], from: 'web', where: host || 'the web', link: request.src };
  }
  // Words to search with: the model's own, and failing those the article's title.
  if (!picture && request.search) picture = await fromImageSearch(request.search).catch(() => null);
  if (!picture && request.wiki) picture = await fromWikipedia(request.wiki).catch(() => null);
  if (!picture && request.wiki && !request.search) picture = await fromImageSearch(request.wiki).catch(() => null);
  // No image search on this proxy, or nothing that would load: Commons, which needs no key.
  const words = request.search || request.wiki;
  if (!picture && words) picture = await fromCommons(words).catch(() => null);
  if (picture) remember(key, picture);
  return picture;
}

// ---------------------------------------------------------------------------

const looking = new Map<string, Promise<Picture | null>>();

/**
 * The picture an ```image``` block asks for, or null when it cannot be had.
 * Two blocks asking for the same web picture share the looking.
 */
export function findPicture(request: PictureRequest, { arxivId }: { arxivId?: string } = {}): Promise<Picture | null> {
  // The paper's own figures are not shared: one found on the page may be gone with the page, and looking again is cheap.
  if (request.figure) return paperPicture('figure', request.figure, arxivId).catch(() => null);
  if (request.table) return paperPicture('table', request.table, arxivId).catch(() => null);
  const key = JSON.stringify([request.src, request.wiki, request.search]);
  let found = looking.get(key);
  if (!found) {
    found = webPicture(request).catch(() => null);
    looking.set(key, found);
    // A miss is not kept: the reader may turn to the paper, or the network come back.
    void found.then((picture) => {
      if (!picture) looking.delete(key);
    });
  }
  return found;
}
