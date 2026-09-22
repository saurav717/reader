import DOMPurify from 'dompurify';
import type { Paper } from '../types';

export interface PaperContent {
  html: string;
  mode: 'html' | 'abstract';
  sourceLabel: string;
  notice?: string;
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
      image.setAttribute('src', `/api/asset?url=${encodeURIComponent(absolute)}`);
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

export async function loadPaperContent(paper: Paper, signal?: AbortSignal): Promise<PaperContent> {
  if (!paper.arxivId) {
    return abstractDocument(
      paper,
      'Full text is only fetched for arXiv papers. Open the publisher link for the rest.',
    );
  }

  try {
    const response = await fetch(`/api/arxiv/html?id=${encodeURIComponent(paper.arxivId)}`, { signal });
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
      html: clean,
      mode: 'html',
      sourceLabel: payload.source === 'ar5iv' ? 'ar5iv HTML' : 'arXiv HTML',
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return abstractDocument(paper, 'Could not reach the full text — showing the abstract.');
  }
}
