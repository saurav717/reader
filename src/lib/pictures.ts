// ===========================================================================
//  Pictures for the Learn pages: found, checked, credited.
//
//  A page asks for a picture by what it should show, never by an address the
//  model remembers: `image query="…" must="…"`, and `paper="…" figure="…"`
//  when the right picture is a figure of a paper. The candidates come from,
//  in this order, each tried until one is accepted:
//
//    1. the paper named, when one is: its PDF through the proxy, reflowed for
//       its figures (figureReader.ts), the named figure first;
//    2. Wikimedia Commons (wikimedia.ts), which knows every picture's licence;
//    3. the web, through the proxy's image search (server/webSearch.js:
//       Google Images by SerpApi, else Brave, else Tavily);
//    4. the figures of the track's own papers, the ones the map ends at;
//    5. a picture made for the page (generated.ts), when the track allows it.
//
//  When the model that wrote the page can see, it is shown the first few
//  candidates from a source and asked which one actually shows what the page
//  needs; a source whose candidates it all refuses is passed over for the
//  next. The one chosen is captioned with where it came from — author and
//  licence from Commons, the page for a web picture, the figure and the paper
//  for a paper's — and kept, so a page is not searched again.
// ===========================================================================

import { modelSpec, streamModel } from './assistant';
import { api, apiFetch, apiHeaders, hasProxy } from './api';
import { db } from './db';
import { findFigure } from './paperFigures';
import type { PaperFigure } from './paperFigures';
import { searchCommons } from './wikimedia';
import type { CommonsImage } from './wikimedia';
import { generatedImageUrl, GENERATOR_NAME, GENERATOR_PAGE, illustrationPrompt, seedFor } from './generated';

export interface Picture {
  kind: 'commons' | 'web' | 'paper' | 'generated';
  /** The picture: an address, or a data: URL for a paper's figure. */
  src: string;
  /** Where it lives: its page on Commons, the page it was found on, the paper's abstract. */
  page: string;
  title: string;
  /** Where it came from, for the caption: "Wikimedia Commons", a host, an arXiv id. */
  source: string;
  author?: string;
  licence?: string;
  licenceUrl?: string;
  description?: string;
  /** A paper's figure: as the paper names it, and which paper. */
  ref?: string;
  paper?: { arxivId: string; title?: string };
  /** Which search found it, for a web picture. */
  via?: string;
}

export interface ResolvedPicture {
  query: string;
  must: string;
  picture: Picture | null;
  /** What was decided about it: checked by a model, taken unchecked, or nothing found. */
  verdict: 'checked' | 'unchecked' | 'none';
  /** The checker's one sentence. */
  note?: string;
  /** How many candidates were passed over, across the sources tried. */
  rejected?: number;
  /** The sources looked in, in order. */
  tried: string[];
  at: number;
}

export interface PictureAsk {
  query: string;
  must: string;
  /** The page's writer, which checks the candidates when it can see. */
  model?: string;
  /** The paper named on the block, when one was. */
  paper?: { arxivId: string; figure?: string };
  /** The track's own papers, looked in last. */
  papers?: { arxivId: string; title?: string }[];
  /** A picture made for the page when nothing is found: on unless the track says otherwise. */
  generate?: boolean;
  fresh?: boolean;
  signal?: AbortSignal;
}

const LOOKED_AT = 4;

// ---------------------------------------------------------------------------
// Candidates: each source as pictures, with the bytes the checker is shown
// ---------------------------------------------------------------------------

type Candidate = { picture: Picture; /** The picture as base64 JPEG, when it is already in hand. */ data?: string };

const fromCommons = (image: CommonsImage): Candidate => ({
  picture: {
    kind: 'commons',
    src: image.src,
    page: image.page || image.url,
    title: image.title.replace(/\.[a-z0-9]+$/i, ''),
    source: 'Wikimedia Commons',
    author: image.author,
    licence: image.licence,
    licenceUrl: image.licenceUrl,
    description: image.description,
  },
});

interface WebImage {
  src: string;
  thumb?: string;
  page: string;
  title: string;
  source: string;
}

/** The proxy's image search; nothing without a proxy, or a key on it (the page says so). */
async function searchWebImages(query: string, signal?: AbortSignal): Promise<{ via: string; candidates: Candidate[] }> {
  if (!hasProxy()) return { via: '', candidates: [] };
  const response = await apiFetch(`/web/images?q=${encodeURIComponent(query)}`, { signal });
  if (!response.ok) {
    if (response.status === 501) return { via: '', candidates: [] };
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `the proxy answered ${response.status}`);
  }
  const body = (await response.json()) as { via?: string; images?: WebImage[] };
  const via = body.via === 'serpapi' ? 'Google Images' : body.via === 'brave' ? 'Brave' : body.via === 'tavily' ? 'Tavily' : 'the web';
  return {
    via,
    candidates: (body.images ?? [])
      .filter((image) => /^https?:\/\//.test(image.src))
      .map((image) => ({ picture: { kind: 'web', src: image.src, page: image.page, title: image.title, source: image.source, via } })),
  };
}

const figureCache = new Map<string, Promise<PaperFigure[]>>();

/** A paper's figures, from its PDF through the proxy, read once per paper and kept in this browser. */
export function figuresOfArxiv(arxivId: string, signal?: AbortSignal): Promise<PaperFigure[]> {
  const key = `learn:figures:${arxivId}`;
  const going = figureCache.get(arxivId);
  if (going) return going;
  const work = (async () => {
    const kept = await db.getKv<PaperFigure[]>(key).catch(() => undefined);
    if (kept) return kept;
    if (!hasProxy()) return [];
    const response = await fetch(api(`/arxiv/pdf?id=${encodeURIComponent(arxivId)}&name=${encodeURIComponent(`${arxivId}.pdf`)}`), { signal, headers: apiHeaders() });
    if (!response.ok) throw new Error(`the paper's PDF could not be fetched (${response.status})`);
    // The reflow and pdf.js, loaded only when a paper is actually read for its figures.
    const { figuresOfPdf } = await import('./figureReader');
    const figures = await figuresOfPdf(await response.blob());
    void db.setKv(key, figures).catch(() => undefined);
    return figures;
  })();
  figureCache.set(arxivId, work);
  work.catch(() => figureCache.delete(arxivId));
  return work;
}

const words = (text: string) => new Set(text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter((w) => w.length > 2));

/** The paper's figures as candidates: the one named first, then the rest by how much their captions share with the ask. */
async function paperCandidates(paper: { arxivId: string; title?: string }, figure: string | undefined, ask: string, signal?: AbortSignal): Promise<Candidate[]> {
  const figures = (await figuresOfArxiv(paper.arxivId, signal)).filter((f) => f.kind === 'figure');
  if (!figures.length) return [];
  const wanted = words(ask);
  const score = (f: PaperFigure) => Array.from(words(f.caption)).filter((w) => wanted.has(w)).length;
  const named = figure ? findFigure(figures, figure) : undefined;
  const rest = figures.filter((f) => f !== named).sort((a, b) => score(b) - score(a));
  return [...(named ? [named] : []), ...rest].map((f) => ({
    data: f.data,
    picture: {
      kind: 'paper',
      src: `data:image/jpeg;base64,${f.data}`,
      page: `https://arxiv.org/abs/${paper.arxivId}`,
      title: f.caption.slice(0, 200),
      source: `arXiv:${paper.arxivId}`,
      description: f.caption,
      ref: f.ref,
      paper: { arxivId: paper.arxivId, title: paper.title },
    },
  }));
}

// ---------------------------------------------------------------------------
// The checker
// ---------------------------------------------------------------------------

/** A picture as a small JPEG the model can be shown: from the bytes in hand, the host when it allows, else through the proxy. */
async function jpegOf(candidate: Candidate, signal?: AbortSignal): Promise<string | null> {
  if (candidate.data) return candidate.data;
  const src = candidate.picture.src;
  const draw = async (blob: Blob) => {
    const bitmap = await createImageBitmap(blob);
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
  };
  try {
    const direct = await fetch(src, { signal, mode: 'cors' });
    if (direct.ok) return await draw(await direct.blob());
  } catch {
    // the host does not allow it: through the proxy, below
  }
  if (!hasProxy() || candidate.picture.kind === 'commons' || candidate.picture.kind === 'generated') return null;
  try {
    const relayed = await apiFetch(`/web/picture?url=${encodeURIComponent(src)}`, { signal });
    if (!relayed.ok) return null;
    return await draw(await relayed.blob());
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
 * asked for. Null when the model cannot see, or none of the pictures could be read.
 */
async function checkWithModel(model: string, must: string, query: string, candidates: Candidate[], signal?: AbortSignal): Promise<{ pick: number; note: string } | null> {
  if (!modelSpec(model).vision || !candidates.length) return null;
  const pictures = (await Promise.all(candidates.map((c) => jpegOf(c, signal)))).map((data, i) => ({ data, candidate: candidates[i], n: i + 1 })).filter((p) => p.data);
  if (!pictures.length) return null;
  const content = [
    ...pictures.flatMap((p) => [
      { type: 'text' as const, text: `Picture ${p.n}: “${p.candidate.picture.title}” — ${p.candidate.picture.description || p.candidate.picture.source || 'no description'}` },
      { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: p.data! } },
    ]),
    {
      type: 'text' as const,
      text: `These were found for the search “${query}”. A page teaching a reader needs a picture that clearly shows: ${must}.
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
  const shown = pictures.find((p) => p.n === verdict.pick);
  return { pick: shown ? candidates.indexOf(shown.candidate) + 1 : 0, note: verdict.note };
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

const KEY = (ask: PictureAsk) => `learn:picture:${ask.query.trim().toLowerCase()}|${ask.must.trim().toLowerCase()}|${ask.paper?.arxivId ?? ''}`;
const inFlight = new Map<string, Promise<ResolvedPicture>>();

type Source = { name: string; get: () => Promise<Candidate[]> };

function sourcesFor(ask: PictureAsk): Source[] {
  const sources: Source[] = [];
  const asked = `${ask.must} ${ask.query}`;
  if (ask.paper) {
    const named = ask.paper;
    sources.push({ name: `arXiv:${named.arxivId}`, get: () => paperCandidates({ arxivId: named.arxivId, title: ask.papers?.find((p) => p.arxivId === named.arxivId)?.title }, named.figure, asked, ask.signal) });
  }
  sources.push({ name: 'Wikimedia Commons', get: async () => (await searchCommons(ask.query, ask.signal)).map(fromCommons) });
  sources.push({ name: 'the web', get: async () => (await searchWebImages(ask.query, ask.signal)).candidates });
  for (const paper of (ask.papers ?? []).filter((p) => p.arxivId && p.arxivId !== ask.paper?.arxivId).slice(0, 2)) {
    sources.push({ name: `arXiv:${paper.arxivId}`, get: () => paperCandidates(paper, undefined, asked, ask.signal) });
  }
  // Last of all, a picture made for the page: two seeds, so the checker has a choice.
  if (ask.generate !== false) {
    sources.push({
      name: 'a generated illustration',
      get: async () => {
        const prompt = illustrationPrompt(ask.query, ask.must);
        return [0, 1].map((salt) => ({
          picture: {
            kind: 'generated' as const,
            src: generatedImageUrl(prompt, { seed: seedFor(prompt, salt) }),
            page: GENERATOR_PAGE,
            title: ask.must || ask.query,
            source: GENERATOR_NAME,
            description: prompt,
          },
        }));
      },
    });
  }
  return sources;
}

/**
 * The picture for a page's request: each source searched in turn, its
 * candidates checked when the model can see, the first accepted one kept.
 * With no model that can see, the first candidate found is taken, unchecked,
 * and said so.
 */
export function resolvePicture(ask: PictureAsk): Promise<ResolvedPicture> {
  const key = KEY(ask);
  const going = inFlight.get(key);
  if (going && !ask.fresh) return going;
  const work = (async (): Promise<ResolvedPicture> => {
    if (!ask.fresh) {
      const kept = await db.getKv<ResolvedPicture>(key).catch(() => undefined);
      if (kept?.picture || kept?.verdict === 'none') return kept;
    }
    const canSee = Boolean(ask.model && modelSpec(ask.model).vision);
    const tried: string[] = [];
    let rejected = 0;
    let note = '';
    let unchecked: Candidate | null = null;
    let failed = '';
    for (const source of sourcesFor(ask)) {
      let candidates: Candidate[];
      try {
        candidates = await source.get();
      } catch (error) {
        if (ask.signal?.aborted) throw error;
        failed = failed || `${source.name}: ${error instanceof Error ? error.message : String(error)}`;
        continue;
      }
      if (!candidates.length) continue;
      tried.push(source.name);
      if (!canSee) {
        unchecked = unchecked ?? candidates[0];
        break;
      }
      const looked = candidates.slice(0, LOOKED_AT);
      const checked = await checkWithModel(ask.model!, ask.must, ask.query, looked, ask.signal).catch((error: unknown) => {
        if (ask.signal?.aborted) throw error;
        return null;
      });
      if (!checked) {
        // The pictures could not be read, or the checker failed: the first is kept in reserve, unchecked.
        unchecked = unchecked ?? candidates[0];
        continue;
      }
      if (checked.pick) {
        const resolved: ResolvedPicture = { query: ask.query, must: ask.must, picture: candidates[checked.pick - 1].picture, verdict: 'checked', note: checked.note, rejected: rejected + checked.pick - 1, tried, at: Date.now() };
        void db.setKv(key, resolved).catch(() => undefined);
        return resolved;
      }
      rejected += looked.length;
      note = checked.note || note;
    }
    const resolved: ResolvedPicture = unchecked
      ? { query: ask.query, must: ask.must, picture: unchecked.picture, verdict: 'unchecked', note: canSee ? 'The pictures could not be shown to the model, so the first found is here unchecked.' : undefined, rejected, tried, at: Date.now() }
      : {
          query: ask.query,
          must: ask.must,
          picture: null,
          verdict: 'none',
          note: tried.length ? note || `Nothing found shows “${ask.must || ask.query}” clearly enough.` : failed ? `Nothing could be searched — ${failed}` : hasProxy() ? 'Nothing was found for that search.' : 'Nothing on Commons; the web and papers need a proxy configured.',
          rejected,
          tried,
          at: Date.now(),
        };
    void db.setKv(key, resolved).catch(() => undefined);
    return resolved;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}

/** Where the picture came from, in a few words, for the head of its card. */
export function sourceLabel(picture: Picture): string {
  if (picture.kind === 'commons') return 'Found on the web · Wikimedia Commons';
  if (picture.kind === 'paper') return `From a paper · ${picture.source}`;
  if (picture.kind === 'generated') return `Made for this page · ${picture.source}`;
  return `Found on the web · ${picture.via || 'image search'}`;
}
