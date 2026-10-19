// The paper as Markdown, for the project's paper/paper.md: the reader's HTML — its own reflow of the PDF, or arXiv's
// rendering — walked into headings, paragraphs, lists, tables, captions and TeX, under a few lines of front matter.
// Pure: no fetching, nothing of the reader's stores (src/lib/paperContext.ts does that), so it tests on its own.

import type { Paper } from '../types';

/** Where the text came from. */
export type TextSource = 'pdf' | 'html' | 'abstract';

// ------------------------------------------------------------ HTML → text --

const BLOCKS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'UL', 'OL', 'LI', 'TABLE', 'TR', 'FIGURE', 'FIGCAPTION', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DL', 'DT', 'DD', 'BR', 'HR']);
const SKIP = new Set(['SCRIPT', 'STYLE', 'NAV', 'BUTTON', 'SVG', 'IMG', 'CANVAS', 'TEMPLATE']);

/** A MathML element as its TeX (LaTeXML keeps it in an annotation), else its text. */
function mathText(el: Element): string {
  const annotation = el.querySelector('annotation[encoding="application/x-tex"]');
  const tex = annotation?.textContent?.trim();
  if (tex) return el.getAttribute('display') === 'block' ? `\n\n$$${tex}$$\n\n` : `$${tex}$`;
  const alt = el.getAttribute('alttext')?.trim();
  if (alt) return `$${alt}$`;
  return (el.textContent ?? '').replace(/\s+/g, ' ');
}

/** A table as Markdown rows: each row's cells joined with pipes, the first row underlined. */
function tableText(table: Element): string {
  const rows = Array.from(table.querySelectorAll('tr')).map((row) =>
    Array.from(row.querySelectorAll('th, td')).map((cell) => inline(cell).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()),
  ).filter((cells) => cells.length);
  if (!rows.length) return '';
  const width = Math.max(...rows.map((cells) => cells.length));
  const line = (cells: string[]) => `| ${cells.concat(Array(width - cells.length).fill('')).join(' | ')} |`;
  const caption = table.querySelector('caption');
  return [caption ? `*${inline(caption).trim()}*\n` : '', line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].filter(Boolean).join('\n');
}

/** The text inside an element, with its maths as TeX and its line breaks kept, blocks inside it folded to spaces. */
function inline(el: Element): string {
  let out = '';
  el.childNodes.forEach((node) => {
    if (node.nodeType === 3) out += node.textContent ?? '';
    else if (node.nodeType === 1) {
      const child = node as Element;
      const tag = child.tagName.toUpperCase();
      if (SKIP.has(tag)) return;
      if (tag === 'MATH') out += mathText(child);
      else if (tag === 'BR') out += '\n';
      else if (tag === 'CODE' && child.parentElement?.tagName.toUpperCase() !== 'PRE') out += `\`${child.textContent ?? ''}\``;
      else out += inline(child);
    }
  });
  return out;
}

/** The paper's HTML — the reflow's or arXiv's — as plain Markdown: headings, paragraphs, lists, tables, captions, maths as TeX. */
export function htmlToMarkdown(html: string, parse: (html: string) => Document = (text) => new DOMParser().parseFromString(text, 'text/html')): string {
  const doc = parse(html);
  const parts: string[] = [];
  const walk = (el: Element, depth: number) => {
    el.childNodes.forEach((node) => {
      if (node.nodeType === 3) {
        const text = (node.textContent ?? '').trim();
        if (text) parts.push(text);
        return;
      }
      if (node.nodeType !== 1) return;
      const child = node as Element;
      const tag = child.tagName.toUpperCase();
      if (SKIP.has(tag)) return;
      if (/^H[1-6]$/.test(tag)) {
        const level = Math.min(6, Number(tag[1]) + depth);
        parts.push(`${'#'.repeat(level)} ${inline(child).replace(/\s+/g, ' ').trim()}`);
      } else if (tag === 'P' || tag === 'DT' || tag === 'DD') {
        parts.push(inline(child).replace(/[ \t]+/g, ' ').replace(/\n\s*/g, '\n').trim());
      } else if (tag === 'LI') {
        const own = Array.from(child.childNodes).filter((n) => !(n.nodeType === 1 && ['UL', 'OL'].includes((n as Element).tagName.toUpperCase())));
        const holder = child.ownerDocument.createElement('span');
        own.forEach((n) => holder.appendChild(n.cloneNode(true)));
        parts.push(`- ${inline(holder).replace(/\s+/g, ' ').trim()}`);
        child.querySelectorAll(':scope > ul, :scope > ol').forEach((list) => walk(list, depth));
      } else if (tag === 'PRE') {
        parts.push(`\`\`\`\n${(child.textContent ?? '').replace(/\n+$/, '')}\n\`\`\``);
      } else if (tag === 'TABLE') {
        const text = tableText(child);
        if (text) parts.push(text);
      } else if (tag === 'FIGCAPTION') {
        parts.push(`*${inline(child).replace(/\s+/g, ' ').trim()}*`);
      } else if (tag === 'MATH') {
        parts.push(mathText(child).trim());
      } else if (tag === 'BLOCKQUOTE') {
        parts.push(inline(child).replace(/\s+/g, ' ').trim().split('\n').map((line) => `> ${line}`).join('\n'));
      } else if (tag === 'HR') {
        parts.push('---');
      } else if (BLOCKS.has(tag)) {
        walk(child, depth);
      } else {
        // An inline element at block level (a span wrapping a paragraph's worth): its text as one paragraph.
        const text = inline(child).replace(/[ \t]+/g, ' ').trim();
        if (text) parts.push(text);
      }
    });
  };
  walk(doc.body, 0);
  return parts.filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ------------------------------------------------------------ the files --

/** The front matter and the paper's details above its text. */
export function paperMarkdown(paper: Paper, body: string, source: TextSource): string {
  const line = (key: string, value: unknown) => (value === undefined || value === '' || (Array.isArray(value) && !value.length) ? '' : `${key}: ${JSON.stringify(value)}`);
  const head = [
    '---',
    line('generator', 'reader'),
    line('title', paper.title),
    line('paperId', paper.id),
    line('authors', paper.authors),
    line('published', paper.published),
    line('venue', paper.venue),
    line('arxivId', paper.arxivId),
    line('doi', paper.doi),
    line('text', source === 'pdf' ? 'reflowed from the PDF by Koios' : source === 'html' ? "arXiv's HTML rendering, as Koios shows it" : 'the abstract only — the full text could not be read'),
    line('written', new Date().toISOString()),
    '---',
  ].filter(Boolean);
  const byline = [paper.authors.length ? paper.authors.join(', ') : '', paper.published ? `(${paper.published.slice(0, 4)})` : ''].filter(Boolean).join(' ');
  const abstract = paper.abstract?.replace(/\s+/g, ' ').trim();
  return [
    head.join('\n'),
    `# ${paper.title}`,
    byline,
    abstract ? `## Abstract\n\n${abstract}` : '',
    source === 'abstract' ? '' : `## Full text\n\n${body.trim()}`,
  ]
    .filter(Boolean)
    .join('\n\n')
    .concat('\n');
}


/** The text without its front matter and its dates, for telling a file that changed from one written again. */
export const stripDates = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^(written|updated): .*$/gm, '');
