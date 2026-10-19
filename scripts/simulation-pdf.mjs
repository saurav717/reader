// Prints the simulation documents as one PDF, docs/simulation-process.pdf: docs/simulation.md (what was built,
// the format, the challenges) and docs/simulation-process.md (how it was built, checked and reviewed), with the
// screenshots beside them, in the look of docs/ask-page.pdf — Chromium through Playwright, A4, "page N of M" in
// the footer. The page it prints is written to docs/simulation-process/index.html on the way.
//
//   node scripts/simulation-pdf.mjs

import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { cleanup, load } from './bundle.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(root, 'docs');
const outDir = join(docs, 'simulation-process');
const html = join(outDir, 'index.html');
const out = join(docs, 'simulation-process.pdf');

const { markdown } = await load('src/lib/markdown.ts');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A document's Markdown as HTML: its figures placed by hand (the app's renderer takes only absolute image URLs), the rest rendered. */
function render(text) {
  const figures = [];
  const withTokens = text
    .replace(/^!\[([^\]]*)\]\(([^)\s]+\.png)\)\s*$/gm, (_, caption, file) => {
      figures.push(`<figure class="shot"><img src="../${file}" alt="${esc(caption)}" /><figcaption>${esc(caption)}</figcaption></figure>`);
      return `@@FIGURE${figures.length - 1}@@`;
    })
    // A table of figures: each cell's picture as a figure of its own, under the table's headings.
    .replace(/^\|([^\n]*)\|\n\|[-| ]+\|\n\|([^\n]*)\|$/gm, (whole, heads, cells) => {
      if (!cells.includes('![')) return whole;
      const titles = heads.split('|').map((s) => s.trim());
      const parts = cells.split(/\|(?![^[]*\])/).map((s) => s.trim()).filter(Boolean);
      return parts
        .map((cell, i) => {
          const m = /!\[([^\]]*)\]\(([^)\s]+)\)/.exec(cell);
          if (!m) return cell;
          figures.push(`<figure class="shot"><img src="../${m[2]}" alt="${esc(m[1])}" /><figcaption><b>${esc(titles[i] ?? '')}</b> ${esc(m[1])}</figcaption></figure>`);
          return `@@FIGURE${figures.length - 1}@@`;
        })
        .join('\n\n');
    });
  // The documents are wrapped at 110 columns by hand; the app's renderer keeps a line break, so paragraphs are
  // unwrapped first (fenced code, tables, lists and headings keep their lines). Links to other files become text.
  const unwrapped = withTokens
    .replace(/\[([^\]]+)\]\((?!https?:)[^)]+\)/g, '$1')
    .split(/(^```[\s\S]*?^```\s*$)/m)
    .map((part) => (part.startsWith('```') ? part : part.replace(/([^\n])\n(?![\n#>|\-*\d ]|@@FIGURE)/g, '$1 ')))
    .join('');
  let out = markdown(unwrapped);
  out = out.replace(/(?:<p>)?@@FIGURE(\d+)@@(?:<\/p>)?/g, (_, i) => figures[Number(i)]);
  // Links between the two documents point within this one.
  out = out.replace(/href="simulation-process\.md"/g, 'href="#part-2"').replace(/href="simulation\.md"/g, 'href="#part-1"');
  return out;
}

const design = readFileSync(join(docs, 'simulation.md'), 'utf8').replace(/^# .*\n/, '');
const process_ = readFileSync(join(docs, 'simulation-process.md'), 'utf8').replace(/^# .*\n/, '');
const commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
const date = new Date().toISOString().slice(0, 10);
const headings = (text) => [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].replace(/`/g, ''));

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Koios — Simulations: what was built, and how</title>
<!--
  The source of docs/simulation-process.pdf, written by scripts/simulation-pdf.mjs from docs/simulation.md and
  docs/simulation-process.md; print it again after a change to either:
      node scripts/simulation-pdf.mjs
-->
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Newsreader:ital,opsz,wght@0,6..72,300..700;1,6..72,300..500&display=swap" rel="stylesheet" />
<style>
  @page { size: A4; margin: 18mm 16mm 20mm 16mm; }
  :root { --ink: #1a1a17; --ink-2: #4b4a44; --muted: #7a776d; --line: #d9d4c6; --panel: #f4f1e8; --accent: #1f5e52; --gold: #a9853f; --red: #a33f3f; }
  * { box-sizing: border-box; }
  html, body { margin: 0; color: var(--ink); background: #fff; }
  body { font: 10.5pt/1.5 'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif; }
  h1 { font: 600 26pt/1.15 'Newsreader', Georgia, serif; margin: 0 0 6pt; letter-spacing: -0.01em; }
  h2 { font: 600 16pt/1.2 'Newsreader', Georgia, serif; margin: 22pt 0 8pt; padding-top: 10pt; border-top: 1px solid var(--line); break-after: avoid; }
  h3 { font: 600 11.5pt/1.3 'IBM Plex Sans', sans-serif; margin: 14pt 0 5pt; break-after: avoid; }
  h4 { font: 600 10.5pt/1.3 'IBM Plex Sans', sans-serif; margin: 10pt 0 4pt; }
  p { margin: 0 0 7pt; }
  ul, ol { margin: 0 0 8pt; padding-left: 18pt; }
  li { margin-bottom: 3pt; }
  a { color: var(--accent); text-decoration: none; }
  code { font: 9.2pt 'IBM Plex Mono', Menlo, monospace; background: var(--panel); border: 1px solid #e6e1d3; border-radius: 3px; padding: 0 3px; }
  pre { font: 8.6pt/1.45 'IBM Plex Mono', Menlo, monospace; background: var(--panel); border: 1px solid #e6e1d3; border-radius: 6px; padding: 8pt 10pt; margin: 6pt 0 10pt; white-space: pre-wrap; break-inside: avoid; }
  pre code { background: none; border: 0; padding: 0; font-size: inherit; }
  blockquote { margin: 8pt 0 10pt; padding: 7pt 10pt; border-left: 3px solid var(--accent); background: var(--panel); }
  blockquote p:last-child { margin: 0; }
  table { width: 100%; border-collapse: collapse; font-size: 9.2pt; margin: 6pt 0 12pt; }
  th, td { padding: 4pt 6pt; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
  th { font-size: 8.2pt; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); background: var(--panel); }
  tr { break-inside: avoid; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 14pt 0; }
  .cap { font-size: 8.4pt; letter-spacing: 0.1em; text-transform: uppercase; color: var(--gold); font-weight: 600; margin: 0 0 8pt; }
  .lede { font: italic 400 12.5pt/1.45 'Newsreader', Georgia, serif; color: var(--ink-2); margin: 0 0 10pt; }
  .meta { color: var(--muted); font-size: 9pt; margin-bottom: 18pt; }
  .toc { columns: 2; column-gap: 24pt; font-size: 9.4pt; margin: 0 0 6pt; padding-left: 14pt; }
  .toc li { break-inside: avoid; }
  .part { break-before: page; }
  figure { margin: 10pt 0 14pt; break-inside: avoid; }
  figure img { display: block; max-width: 100%; border: 1px solid var(--line); border-radius: 6px; }
  figure.shot img { max-height: 120mm; width: auto; margin: 0 auto; }
  figcaption { font-size: 8.8pt; color: var(--ink-2); margin-top: 5pt; }
  figcaption b { color: var(--ink); }
</style>
</head>
<body>
<p class="cap">Koios · the Playground</p>
<h1>Simulations: what was built, and how</h1>
<p class="lede">Thirty-one simulators and the templates to learn on them; a telemetry every run writes and a pane that draws it; a live 3D view through the Companion; experiments filed as they end, with notes; a paper's reimplementation wired to a simulator by the coding agents — and the process that made it: every run, every finding, every review.</p>
<p class="meta">Branch claude/zealous-bardeen-vr8z49 at ${commit} · ${date} · the two documents this prints are docs/simulation.md and docs/simulation-process.md</p>
<h3>Part 1 · What was built</h3>
<ul class="toc">${headings(design).map((h) => `<li>${esc(h)}</li>`).join('')}</ul>
<h3>Part 2 · How it was built, checked and reviewed</h3>
<ul class="toc">${headings(process_).map((h) => `<li>${esc(h)}</li>`).join('')}</ul>
<section class="part" id="part-1">
<p class="cap">Part 1</p>
<h1>What was built</h1>
${render(design)}
</section>
<section class="part" id="part-2">
<p class="cap">Part 2</p>
<h1>How it was built, checked and reviewed</h1>
${render(process_)}
</section>
</body>
</html>
`;

mkdirSync(outDir, { recursive: true });
writeFileSync(html, page);

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined });
const tab = await browser.newPage();
await tab.goto(pathToFileURL(html).toString(), { waitUntil: 'networkidle' }).catch(() => undefined);
await tab.evaluate(() => document.fonts.ready).catch(() => undefined);
await tab.pdf({
  path: out,
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<span></span>',
  footerTemplate:
    '<div style="width:100%;font:8px IBM Plex Sans,Helvetica,Arial,sans-serif;color:#7a776d;padding:0 16mm;display:flex;justify-content:space-between">' +
    '<span>Koios · Simulations: what was built, and how</span><span>page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>',
  margin: { top: '18mm', right: '16mm', bottom: '20mm', left: '16mm' },
});
await browser.close();
await cleanup();
console.log(`wrote ${html} and ${out}`);
