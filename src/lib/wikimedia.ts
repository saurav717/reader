// ===========================================================================
//  Pictures from Wikimedia Commons, for the Learn pages.
//
//  A page asks for a picture by what it should show, never by an address the
//  model remembers: `image query="…" must="…"`. Commons is searched straight
//  from the browser (its API answers cross-origin requests), the candidates
//  come back with their author and licence. Which one goes on the page, and
//  what else is looked in when Commons has nothing, is pictures.ts's business.
// ===========================================================================


export interface CommonsImage {
  title: string;
  /** The picture, at a width that fits the page. */
  src: string;
  /** The original file. */
  url: string;
  /** Its page on Commons, where the licence can be checked. */
  page: string;
  width: number;
  height: number;
  author: string;
  licence: string;
  licenceUrl: string;
  description: string;
}

export const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const THUMB_WIDTH = 960;
const CANDIDATES = 6;

/** The search URL for a query, as Commons wants it. */
export function commonsSearchUrl(query: string, limit = CANDIDATES): string {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*',
    generator: 'search',
    gsrsearch: `filetype:bitmap|drawing ${query}`,
    gsrnamespace: '6',
    gsrlimit: String(limit),
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: String(THUMB_WIDTH),
    iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl|ImageDescription|Credit',
  });
  return `${COMMONS_API}?${params}`;
}

const text = (html: string | undefined) =>
  (html ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/** The candidates in Commons' answer, best match first, pictures only. */
export function fromCommons(json: unknown): CommonsImage[] {
  const pages = (json as { query?: { pages?: Record<string, Record<string, unknown>> } })?.query?.pages;
  if (!pages || typeof pages !== 'object') return [];
  const out: (CommonsImage & { index: number })[] = [];
  for (const page of Object.values(pages)) {
    const info = (Array.isArray(page.imageinfo) ? page.imageinfo[0] : null) as Record<string, unknown> | null;
    if (!info) continue;
    const mime = String(info.mime ?? '');
    if (!/^image\/(jpeg|png|gif|webp|svg)/.test(mime)) continue;
    const meta = (info.extmetadata ?? {}) as Record<string, { value?: string }>;
    const licence = text(meta.LicenseShortName?.value);
    // Only what can be shown with its licence named: Commons keeps little else, but a file with no licence recorded is skipped.
    if (!licence) continue;
    out.push({
      index: Number(page.index ?? out.length),
      title: String(page.title ?? '').replace(/^File:/, ''),
      src: String(info.thumburl ?? info.url ?? ''),
      url: String(info.url ?? ''),
      page: String(info.descriptionurl ?? ''),
      width: Number(info.thumbwidth ?? info.width ?? 0),
      height: Number(info.thumbheight ?? info.height ?? 0),
      author: text(meta.Artist?.value) || text(meta.Credit?.value) || 'unknown author',
      licence,
      licenceUrl: text(meta.LicenseUrl?.value),
      description: text(meta.ImageDescription?.value).slice(0, 300),
    });
  }
  return out.sort((a, b) => a.index - b.index).map(({ index: _i, ...image }) => image);
}

export async function searchCommons(query: string, signal?: AbortSignal): Promise<CommonsImage[]> {
  const response = await fetch(commonsSearchUrl(query), { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Wikimedia Commons answered ${response.status}.`);
  return fromCommons(await response.json());
}
