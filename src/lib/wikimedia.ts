// ===========================================================================
//  Pictures from Wikimedia Commons, for the Learn pages.
//
//  A page asks for a picture by what it should show, never by an address the
//  model remembers: `image query="…" must="…"`. Commons is searched straight
//  from the browser (its API answers cross-origin requests), the candidates
//  come back with their author and licence, and — when the model that wrote
//  the page can see — it is shown the first few and asked which one actually
//  shows what the page needs. The chosen picture is captioned with its
//  source, author and licence, and kept, so a page is not searched again.
// ===========================================================================

import { modelSpec, streamModel } from './assistant';
import { db } from './db';

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

export interface ResolvedImage {
  query: string;
  must: string;
  image: CommonsImage | null;
  /** What was decided about it: checked by a model, taken unchecked, or nothing found. */
  verdict: 'checked' | 'unchecked' | 'none';
  /** The checker's one sentence, and how many candidates it passed over. */
  note?: string;
  rejected?: number;
  at: number;
}

export const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const THUMB_WIDTH = 960;
const CANDIDATES = 6;
const LOOKED_AT = 4;

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

/** The picture as a JPEG the model can be shown, small; null when it cannot be read (no CORS, or not an image). */
async function jpegOf(src: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(src, { signal, mode: 'cors' });
    if (!response.ok) return null;
    const bitmap = await createImageBitmap(await response.blob());
    try {
      const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.8).split(',')[1] || null;
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

/** The number a checker answered with, 0 for none; and the sentence after it. */
export function readVerdict(reply: string): { pick: number; note: string } {
  const match = /^\s*(?:picture\s*)?#?(\d+)\b[\s.:,—-]*([\s\S]*)$/i.exec(reply.trim());
  if (!match) return { pick: 0, note: reply.trim().split('\n')[0] ?? '' };
  return { pick: Number(match[1]), note: match[2].trim().split('\n')[0] ?? '' };
}

/**
 * Shown the first few candidates, the model says which one shows what the page
 * asked for. Null when the model cannot see, or the pictures could not be read.
 */
async function checkWithModel(model: string, must: string, query: string, candidates: CommonsImage[], signal?: AbortSignal): Promise<{ pick: number; note: string } | null> {
  if (!modelSpec(model).vision || !candidates.length) return null;
  const pictures = (await Promise.all(candidates.map((image) => jpegOf(image.src, signal)))).map((data, i) => ({ data, image: candidates[i], n: i + 1 })).filter((p) => p.data);
  if (!pictures.length) return null;
  const content = [
    ...pictures.flatMap((p) => [
      { type: 'text' as const, text: `Picture ${p.n}: “${p.image.title}” — ${p.image.description || 'no description'}` },
      { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: p.data! } },
    ]),
    {
      type: 'text' as const,
      text: `These were found on Wikimedia Commons for the search “${query}”. A page teaching a reader needs a picture that clearly shows: ${must}.
Which picture is the best one for that? Answer with its number alone on the first line — or 0 if none of them clearly shows it — then one short sentence on what it shows. Nothing else.`,
    },
  ];
  const stream = await streamModel({ model, maxTokens: 200, system: [{ type: 'text', text: 'You check pictures for a teaching page. Be strict: a picture that is about the topic but does not show the thing asked for is a 0.' }], messages: [{ role: 'user', content }], effort: 'low' });
  let reply = '';
  stream.on('text', (delta: string) => {
    reply += delta;
  });
  await stream.finalMessage();
  const verdict = readVerdict(reply);
  // The number is among the pictures shown; a number of a picture that could not be read is nothing.
  const shown = pictures.find((p) => p.n === verdict.pick);
  return { pick: shown ? candidates.indexOf(shown.image) + 1 : 0, note: verdict.note };
}

const KEY = (query: string, must: string) => `learn:image:${query.trim().toLowerCase()}|${must.trim().toLowerCase()}`;
const inFlight = new Map<string, Promise<ResolvedImage>>();

/**
 * The picture for a page's request: searched, checked when the model can see,
 * kept. `model` is the page's writer; with no model, the first match is taken
 * unchecked and said so.
 */
export function resolveImage(query: string, must: string, model?: string, options: { fresh?: boolean; signal?: AbortSignal } = {}): Promise<ResolvedImage> {
  const key = KEY(query, must);
  const going = inFlight.get(key);
  if (going && !options.fresh) return going;
  const work = (async (): Promise<ResolvedImage> => {
    if (!options.fresh) {
      const kept = await db.getKv<ResolvedImage>(key).catch(() => undefined);
      if (kept?.image || kept?.verdict === 'none') return kept;
    }
    const candidates = await searchCommons(query, options.signal);
    let resolved: ResolvedImage;
    if (!candidates.length) resolved = { query, must, image: null, verdict: 'none', at: Date.now() };
    else {
      const looked = candidates.slice(0, LOOKED_AT);
      const checked = model ? await checkWithModel(model, must, query, looked, options.signal).catch(() => null) : null;
      if (checked) {
        resolved = checked.pick
          ? { query, must, image: candidates[checked.pick - 1], verdict: 'checked', note: checked.note, rejected: looked.length - 1, at: Date.now() }
          : { query, must, image: null, verdict: 'none', note: checked.note || 'None of the pictures found shows what the page asked for.', rejected: looked.length, at: Date.now() };
      } else resolved = { query, must, image: candidates[0], verdict: 'unchecked', at: Date.now() };
    }
    void db.setKv(key, resolved).catch(() => undefined);
    return resolved;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}

/** The caption's source line: author, licence and where it came from. */
export function creditOf(image: CommonsImage): { author: string; licence: string; source: string } {
  return { author: image.author, licence: image.licence, source: 'Wikimedia Commons' };
}
