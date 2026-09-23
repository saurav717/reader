import DOMPurify from 'dompurify';
import type { Paper } from '../types';
import { api, hasProxy, NO_PROXY_REASON } from './api';
import type { ReflowProgress } from './pdfReflow';
import { pdfShape } from './pdfShape';
import { withCitations } from './citations';

export interface PaperContent {
  html: string;
  /** Reflowed from the PDF itself, from an HTML rendering, or the abstract alone. */
  mode: 'pdf' | 'html' | 'abstract';
  sourceLabel: string;
  notice?: string;
  /** Hands back what the HTML refers to — the images painted from a PDF — once it is off the screen. */
  release?: () => void;
}

export type { ReflowProgress };

/**
 * Why a PDF is probably not the paper — "looks like a poster" — or null when
 * it looks like one (see `pdfShape`). pdf.js is loaded to measure it, the
 * first time it is needed. A file pdf.js cannot open is not second-guessed
 * here — whether it renders is the viewer's business — so it counts as a paper.
 */
export async function judgePdf(pdf: Blob): Promise<string | null> {
  try {
    const { measurePdf } = await import('./pdfReflow');
    return pdfShape(await measurePdf(pdf));
  } catch {
    return null;
  }
}

/**
 * The paper reflowed from its PDF: every page read out — text, figures,
 * tables, equations — and set as a document. pdf.js is loaded on demand,
 * since a reader in PDF mode never needs it. Null when the file has no
 * text to read — a scan, or fonts that cannot be mapped back to letters —
 * so the caller can fall back to the HTML rendering or the abstract.
 */
export async function loadPaperContentFromPdf(
  paper: Paper,
  pdf: Blob,
  options: { signal?: AbortSignal; onProgress?: (progress: ReflowProgress) => void } = {},
): Promise<PaperContent | null> {
  const { reflowPdf } = await import('./pdfReflow');
  const reflowed = await reflowPdf(pdf, { title: paper.title, signal: options.signal, onProgress: options.onProgress });
  if (!reflowed) return null;
  // The HTML is our own, but it went through a PDF's strings on the way,
  // and the images are blob: URLs, which the default policy strips.
  const clean = DOMPurify.sanitize(reflowed.html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['loading', 'width', 'height', 'colspan'],
    ALLOWED_URI_REGEXP: /^(?:blob:|https?:|#)/i,
    FORBID_TAGS: ['style', 'link'],
  });
  return {
    // The citations marked, so that hovering over one says what it cites.
    html: withCitations(clean),
    mode: 'pdf',
    sourceLabel: `Reflowed from the PDF · ${reflowed.pages} ${reflowed.pages === 1 ? 'page' : 'pages'}`,
    release: reflowed.release,
  };
}

const STRIP = [
  'script',
  'style',
  'noscript',
  'iframe',
  'form',
  'button',
  'nav',
  '.ltx_page_navbar',
  '.ltx_page_header',
  '.ltx_page_footer',
  '.ar5iv-footer',
  '.ltx_role_footnotemark',
  '#ar5iv-footer',
].join(', ');

function pickArticle(doc: Document): HTMLElement | null {
  const candidates = ['.ltx_page_content', '.ltx_document', 'article', 'main', 'body'];
  for (const selector of candidates) {
    const element = doc.querySelector<HTMLElement>(selector);
    if (element && (element.textContent || '').trim().length > 400) return element;
  }
  return null;
}

function absolutise(element: HTMLElement, base: string): void {
  element.querySelectorAll<HTMLImageElement>('img').forEach((image) => {
    const src = image.getAttribute('src');
    if (!src || src.startsWith('data:')) return;
    try {
      const absolute = new URL(src, base).toString();
      image.setAttribute('src', api(`/asset?url=${encodeURIComponent(absolute)}`));
      image.setAttribute('loading', 'lazy');
      image.removeAttribute('srcset');
    } catch {
      image.remove();
    }
  });
  element.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href') || '';
    if (href.startsWith('#')) return;
    try {
      anchor.setAttribute('href', new URL(href, base).toString());
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noreferrer noopener');
    } catch {
      anchor.removeAttribute('href');
    }
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] as string,
  );
}

function abstractDocument(paper: Paper, notice?: string): PaperContent {
  const paragraphs = (paper.abstract || 'No abstract is available for this paper.')
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block.trim())}</p>`)
    .join('');
  return {
    mode: 'abstract',
    sourceLabel: 'Abstract only',
    notice,
    html: `<h2>Abstract</h2>${paragraphs}`,
  };
}

/** The arXiv id in one of a paper's copies — "arxiv.org/pdf/2609.13072v1" — where there is one. */
export function arxivIdFromUrl(url: string): string | undefined {
  return /arxiv\.org\/(?:abs|pdf|html)\/((?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?)/i.exec(url)?.[1];
}

/**
 * The HTML rendering arXiv keeps, or the abstract. A paper found through
 * Scholar or a DOI may not carry its arXiv id itself; `arxivId` is the one
 * found among its copies.
 */
export async function loadPaperContent(paper: Paper, signal?: AbortSignal, options: { arxivId?: string } = {}): Promise<PaperContent> {
  if (!hasProxy()) {
    return abstractDocument(paper, `${NO_PROXY_REASON} Showing the abstract — you can still highlight it.`);
  }

  const arxivId = paper.arxivId || options.arxivId;
  if (!arxivId) {
    return abstractDocument(
      paper,
      'Reflowed text — the kind you can highlight — is only rendered for arXiv papers.',
    );
  }

  try {
    const response = await fetch(api(`/arxiv/html?id=${encodeURIComponent(arxivId)}`), { signal });
    if (!response.ok) {
      return abstractDocument(paper, 'arXiv has no HTML rendering of this paper — showing the abstract.');
    }
    const payload = (await response.json()) as { html: string; source: string; base: string };
    const doc = new DOMParser().parseFromString(payload.html, 'text/html');
    doc.querySelectorAll(STRIP).forEach((node) => node.remove());
    const article = pickArticle(doc);
    if (!article) {
      return abstractDocument(paper, 'The HTML rendering could not be parsed — showing the abstract.');
    }
    absolutise(article, payload.base);

    const clean = DOMPurify.sanitize(article.innerHTML, {
      USE_PROFILES: { html: true, mathMl: true, svg: true },
      ADD_ATTR: ['target', 'loading'],
      FORBID_TAGS: ['style', 'link'],
    });

    return {
      html: withCitations(clean),
      mode: 'html',
      sourceLabel: payload.source === 'ar5iv' ? 'ar5iv HTML' : 'arXiv HTML',
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return abstractDocument(paper, 'Could not reach the full text — showing the abstract.');
  }
}
