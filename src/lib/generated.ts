// ===========================================================================
//  A picture made for the page, when none can be found.
//
//  The last place pictures.ts looks: an illustration generated from what the
//  page asked for, by FLUX through Pollinations.ai — free, no key, no
//  account; rate-limited, watermarked for anonymous use, with no promise of
//  uptime. It is asked only after a paper's figure, Commons, the web and the
//  track's papers have all come up empty, goes through the same check as
//  anything else, and is captioned as what it is: a generated illustration,
//  not a photograph.
// ===========================================================================

export const POLLINATIONS_HOST = 'https://image.pollinations.ai';

/** What a generator does well, and what it does not: no text, no labels, no diagrams with arrows — that is the page's own drawing. */
const STYLE = 'clean, uncluttered educational illustration, soft natural light, no text, no labels, no watermark, no logos';

/** The prompt a page's request becomes: what the picture must show first, then the search words, then the style. */
export function illustrationPrompt(query: string, must: string): string {
  const parts = [must.trim(), query.trim()].filter((part, i, all) => part && all.indexOf(part) === i);
  return `${parts.join(', ')}. ${STYLE}`;
}

/** A seed that is the same for the same ask, so a page's picture does not change each time it is opened; `salt` for another one. */
export function seedFor(text: string, salt = 0): number {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return (h + salt * 7919) % 1_000_000;
}

/** The address of the picture: Pollinations makes it on the first request and serves it after. */
export function generatedImageUrl(prompt: string, options: { seed?: number; width?: number; height?: number; model?: string } = {}): string {
  const params = new URLSearchParams({
    width: String(options.width ?? 1024),
    height: String(options.height ?? 640),
    seed: String(options.seed ?? 0),
    model: options.model ?? 'flux',
    nologo: 'true',
    safe: 'true',
  });
  return `${POLLINATIONS_HOST}/prompt/${encodeURIComponent(prompt)}?${params}`;
}

export const GENERATOR_NAME = 'FLUX via Pollinations.ai';
export const GENERATOR_PAGE = 'https://pollinations.ai';
