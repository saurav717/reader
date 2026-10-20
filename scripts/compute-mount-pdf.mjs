// Prints the mount's documents as one PDF, docs/compute-mount-process.pdf: docs/compute-mount.md (what it is and how
// to use it) and docs/compute-mount-process.md (how it was built, checked and measured), in the look of
// docs/simulation-process.pdf — Chromium through Playwright, A4, "page N of M" in the footer.
//
// On the way it draws the charts the process document shows, from the measurements in docs/compute-mount-bench.json
// (companion/tests/bench_mount.py) and, over a real tunnel, docs/compute-mount-live.json (tests/live_tunnel.py), as
// SVG files in docs/compute-mount/ — so the Markdown shows them too — and renders the documents' Mermaid diagrams
// with Mermaid in the page: the page loads it from jsDelivr, and while printing a local copy stands in when there is one (MERMAID_JS, a path to mermaid.min.js, else node_modules/mermaid).
//
//   node scripts/compute-mount-pdf.mjs
//   node scripts/compute-mount-pdf.mjs shared-folders   # docs/shared-folders.md and -process.md → docs/shared-folders-process.pdf (no charts)

import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { cleanup, load } from './bundle.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(root, 'docs');
const SETS = {
  'compute-mount': {
    cap: 'Koios · the Playground · Companion 0.19.0',
    title: 'Mounting the folder on the compute',
    lede: "The code stays on your computer; the GPU reads it there, through the Companion's Cloudflare tunnel, as if it were its own disk. Saves are there in under a second, results come back as they are written, and checkpoints go where the data is kept. What was built, why, how it was checked and measured, and how to try it.",
    charts: true,
  },
  'shared-folders': {
    cap: 'Koios · your computers · Companion 0.20.0',
    title: 'A folder of one computer, a disk on another',
    lede: 'Any computer signed in to your account can attach a folder of another as a disk of its own — on a Mac, on Windows, on Linux — through the Companions and their Cloudflare tunnels. Files come over as they are opened. What was built, why, how it was checked, and how to try it.',
    charts: false,
  },
};
const set = process.argv[2] && SETS[process.argv[2]] ? process.argv[2] : 'compute-mount';
const doc = SETS[set];
const outDir = join(docs, `${set}-process`);
const chartDir = join(docs, 'compute-mount');
const html = join(outDir, 'index.html');
const out = join(docs, `${set}-process.pdf`);
const MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ------------------------------------------------------------------ charts ----
//
// Grouped bars, one axis, seconds. Copy and mount keep their colours in every chart (copy orange, mount blue: the
// dataviz reference palette's slots 2 and 1, checked for colour-blind separation on light and dark), a legend above,
// the value on each bar, a recessive grid. A reference line, when given, is labelled where it is drawn.

const INK = '#0b0b0b';
const INK_2 = '#52514e';
const MUTED = '#8a887f';
const GRID = '#e7e5df';
const SURFACE = '#fcfcfb';
const SERIES = {
  copy: { label: 'Copy before the run (koios push)', color: '#d95926' },
  mount: { label: 'Mount', color: '#2a78d6' },
  // The real-tunnel chart compares other things, so other colours (slots 3 and 7, checked the same way).
  local: { label: 'No tunnel (127.0.0.1)', color: '#199e70' },
  tunnel: { label: 'Through a real Cloudflare tunnel', color: '#6250d6' },
};

function niceMax(value) {
  const step = value > 2 ? 0.5 : value > 1 ? 0.25 : 0.1;
  return Math.ceil((value * 1.15) / step) * step;
}

/** A bar with its data end rounded (4 px) and its base square on the axis. */
function bar(x, y, w, h, color) {
  const r = Math.min(4, w / 2, h);
  return `<path d="M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z" fill="${color}"/>`;
}

function groupedBars({ title, subtitle, groups, series, reference }) {
  const W = 680;
  const H = 330;
  const left = 56;
  const right = 16;
  const top = 92;
  const bottom = 44;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  const all = groups.flatMap((g) => series.map((s) => g.values[s]));
  const max = niceMax(Math.max(...all, reference?.value ?? 0));
  const y = (v) => top + plotH - (v / max) * plotH;
  const ticks = [];
  const step = max / 5;
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(v);
  const groupW = plotW / groups.length;
  const barW = Math.min(46, groupW / (series.length + 1.6));
  const gap = 2;
  const parts = [];
  parts.push(`<rect width="${W}" height="${H}" fill="${SURFACE}"/>`);
  parts.push(`<text x="16" y="28" font-size="16" font-weight="600" fill="${INK}">${esc(title)}</text>`);
  parts.push(`<text x="16" y="48" font-size="12" fill="${INK_2}">${esc(subtitle)}</text>`);
  let lx = 16;
  for (const key of series) {
    parts.push(`<rect x="${lx}" y="62" width="12" height="12" rx="3" fill="${SERIES[key].color}"/>`);
    parts.push(`<text x="${lx + 18}" y="72.5" font-size="12" fill="${INK_2}">${esc(SERIES[key].label)}</text>`);
    lx += 18 + SERIES[key].label.length * 6.6 + 22;
  }
  if (reference) {
    parts.push(`<line x1="${lx}" x2="${lx + 14}" y1="68" y2="68" stroke="${INK_2}" stroke-width="1.5" stroke-dasharray="4 3"/>`);
    parts.push(`<text x="${lx + 20}" y="72.5" font-size="12" fill="${INK_2}">${esc(reference.label)}</text>`);
  }
  for (const t of ticks) {
    parts.push(`<line x1="${left}" x2="${W - right}" y1="${y(t)}" y2="${y(t)}" stroke="${GRID}" stroke-width="1"/>`);
    parts.push(`<text x="${left - 8}" y="${y(t) + 4}" font-size="11" fill="${MUTED}" text-anchor="end">${t.toFixed(max >= 2 ? 1 : 2)} s</text>`);
  }
  groups.forEach((g, i) => {
    const total = series.length * barW + (series.length - 1) * gap;
    const x0 = left + groupW * i + (groupW - total) / 2;
    series.forEach((key, j) => {
      const v = g.values[key];
      const x = x0 + j * (barW + gap);
      const yy = y(v);
      parts.push(`<g><title>${esc(`${SERIES[key].label}, ${g.label}: ${v.toFixed(2)} s`)}</title>${bar(x, yy, barW, top + plotH - yy, SERIES[key].color)}</g>`);
      parts.push(`<text x="${x + barW / 2}" y="${yy - 6}" font-size="11" fill="${INK_2}" text-anchor="middle">${v.toFixed(2)}</text>`);
    });
    parts.push(`<text x="${left + groupW * i + groupW / 2}" y="${H - bottom + 20}" font-size="12" fill="${INK_2}" text-anchor="middle">${esc(g.label)}</text>`);
  });
  if (reference) {
    const ry = y(reference.value);
    parts.push(`<line x1="${left}" x2="${W - right}" y1="${ry}" y2="${ry}" stroke="${INK_2}" stroke-width="1.5" stroke-dasharray="5 4"/>`);
  }
  parts.push(`<line x1="${left}" x2="${W - right}" y1="${top + plotH}" y2="${top + plotH}" stroke="${MUTED}" stroke-width="1"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="IBM Plex Sans, Helvetica Neue, Arial, sans-serif" role="img" aria-label="${esc(title)}">\n${parts.join('\n')}\n</svg>\n`;
}

function charts(bench, live) {
  const rows = bench.rtts;
  const label = (r) => `${r.rtt_ms} ms round trip`;
  return {
    'first-ready.svg': groupedBars({
      title: 'Before the first run can start',
      subtitle: `${bench.modules + 3} files: the copy sends them all; the mount sends the tree and the small files as archives`,
      groups: rows.map((r) => ({ label: label(r), values: { copy: r.copy.first_push_s, mount: r.mount.ready_s } })),
      series: ['copy', 'mount'],
    }),
    'edit-to-machine.svg': groupedBars({
      title: 'After editing one file: until the machine has it',
      subtitle: 'Copy: koios run’s push (connect, compare, send one). Mount: pushed on save, no command needed',
      groups: rows.map((r) => ({ label: label(r), values: { copy: r.copy.edit_push_s, mount: r.mount.edit_visible_s } })),
      series: ['copy', 'mount'],
    }),
    'imports.svg': groupedBars({
      title: `Importing ${bench.modules} modules on the machine`,
      subtitle: 'Copy: from the machine’s own disk. Mount: through FUSE, every file already cached',
      groups: rows.map((r) => ({ label: label(r), values: { copy: r.copy.import_s, mount: r.mount.import_s } })),
      series: ['copy', 'mount'],
      reference: { value: bench.local_import_s, label: `This computer’s own disk (${bench.local_import_s.toFixed(2)} s)` },
    }),
    'tunnel-vs-local.svg': groupedBars({
      title: 'The mirror, with and without a real Cloudflare tunnel',
      subtitle: `${live.tunnel.mount.warm.files} files (${(live.tunnel.mount.warm.bytes / 1e6).toFixed(1)} MB). Tunnel: both ends on one Mac, every byte out to Cloudflare and back`,
      groups: [
        { label: 'First copy of the folder', values: { local: live.local.mount.warm.seconds, tunnel: live.tunnel.mount.warm.seconds } },
        { label: 'A save here → there (median)', values: { local: live.local.save_here_to_there_s.median, tunnel: live.tunnel.save_here_to_there_s.median } },
        { label: 'A write there → here (median)', values: { local: live.local.write_there_to_here_s.median, tunnel: live.tunnel.write_there_to_here_s.median } },
      ],
      series: ['local', 'tunnel'],
    }),
  };
}

let chartCount = 0;
if (doc.charts) {
  const bench = JSON.parse(readFileSync(join(docs, 'compute-mount-bench.json'), 'utf8'));
  const live = JSON.parse(readFileSync(join(docs, 'compute-mount-live.json'), 'utf8'));
  mkdirSync(chartDir, { recursive: true });
  const drawnCharts = charts(bench, live);
  for (const [name, svg] of Object.entries(drawnCharts)) writeFileSync(join(chartDir, name), svg);
  chartCount = Object.keys(drawnCharts).length;
}

// ---------------------------------------------------------------- the page ----

const { markdown } = await load('src/lib/markdown.ts');

/** A document's Markdown as HTML: its pictures and its Mermaid diagrams placed by hand, the rest rendered by the app's renderer. */
function render(text) {
  const figures = [];
  const withTokens = text
    .replace(/^```mermaid\n([\s\S]*?)^```\s*$/gm, (_, code) => {
      figures.push(`<figure class="diagram"><pre class="mermaid">${esc(code)}</pre></figure>`);
      return `@@FIGURE${figures.length - 1}@@`;
    })
    .replace(/^!\[([^\]]*)\]\(([^)\s]+\.(?:png|svg))\)\s*$/gm, (_, caption, file) => {
      figures.push(`<figure class="${file.endsWith('.svg') ? 'chart' : 'shot'}"><img src="../${file}" alt="${esc(caption)}" /></figure>`);
      return `@@FIGURE${figures.length - 1}@@`;
    });
  // Wrapped at 120 columns by hand; the renderer keeps a line break, so paragraphs are unwrapped first (fenced code,
  // tables, lists and headings keep their lines). Links to other files become text, but for the two printed here.
  const unwrapped = withTokens
    .replace(/\[([^\]]+)\]\((?!https?:)[^)]+\)/g, '$1')
    .split(/(^```[\s\S]*?^```\s*$)/m)
    .map((part) => (part.startsWith('```') ? part : part.replace(/([^\n])\n(?![\n#>|\-*\d ]|@@FIGURE)/g, '$1 ')))
    .join('');
  let html = markdown(unwrapped);
  html = html.replace(/(?:<p>)?@@FIGURE(\d+)@@(?:<\/p>)?/g, (_, i) => figures[Number(i)]);
  return html.replaceAll(`href="${set}-process.md"`, 'href="#part-2"').replaceAll(`href="${set}.md"`, 'href="#part-1"');
}

const design = readFileSync(join(docs, `${set}.md`), 'utf8').replace(/^# .*\n/, '');
const process_ = readFileSync(join(docs, `${set}-process.md`), 'utf8').replace(/^# .*\n/, '');
const commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: root }).toString().trim();
const date = new Date().toISOString().slice(0, 10);
const headings = (text) => [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].replace(/`/g, ''));

const local = [process.env.MERMAID_JS, join(root, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js')].find((path) => path && existsSync(path));
// The page names jsDelivr, so it opens anywhere; when printing, a local copy answers for it if there is one.
const mermaidTag = `<script src="${MERMAID_CDN}"></script>`;

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Koios — ${esc(doc.title)}</title>
<!--
  The source of docs/${set}-process.pdf, written by scripts/compute-mount-pdf.mjs from docs/${set}.md
  and docs/${set}-process.md; print it again after a change to either:
      node scripts/compute-mount-pdf.mjs ${set === 'compute-mount' ? '' : set}
-->
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Newsreader:ital,opsz,wght@0,6..72,300..700;1,6..72,300..500&display=swap" rel="stylesheet" />
<style>
  @page { size: A4; margin: 18mm 16mm 20mm 16mm; }
  :root { --ink: #1a1a17; --ink-2: #4b4a44; --muted: #7a776d; --line: #d9d4c6; --panel: #f4f1e8; --accent: #1f5e52; --gold: #a9853f; }
  * { box-sizing: border-box; }
  html, body { margin: 0; color: var(--ink); background: #fff; }
  body { font: 10.5pt/1.5 'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif; }
  h1 { font: 600 26pt/1.15 'Newsreader', Georgia, serif; margin: 0 0 6pt; letter-spacing: -0.01em; }
  h2 { font: 600 16pt/1.2 'Newsreader', Georgia, serif; margin: 22pt 0 8pt; padding-top: 10pt; border-top: 1px solid var(--line); break-after: avoid; }
  h3 { font: 600 11.5pt/1.3 'IBM Plex Sans', sans-serif; margin: 14pt 0 5pt; break-after: avoid; }
  /* The app's renderer puts a document's ## and ### two levels down. */
  h5 { font: 600 16pt/1.2 'Newsreader', Georgia, serif; margin: 22pt 0 8pt; padding-top: 10pt; border-top: 1px solid var(--line); break-after: avoid; }
  h6 { font: 600 11.5pt/1.3 'IBM Plex Sans', sans-serif; margin: 14pt 0 5pt; break-after: avoid; }
  p { margin: 0 0 7pt; }
  ul, ol { margin: 0 0 8pt; padding-left: 18pt; }
  li { margin-bottom: 3pt; }
  a { color: var(--accent); text-decoration: none; }
  code { font: 9.2pt 'IBM Plex Mono', Menlo, monospace; background: var(--panel); border: 1px solid #e6e1d3; border-radius: 3px; padding: 0 3px; }
  pre { font: 8.6pt/1.45 'IBM Plex Mono', Menlo, monospace; background: var(--panel); border: 1px solid #e6e1d3; border-radius: 6px; padding: 8pt 10pt; margin: 6pt 0 10pt; white-space: pre-wrap; break-inside: avoid; }
  pre code { background: none; border: 0; padding: 0; font-size: inherit; }
  table { width: 100%; border-collapse: collapse; font-size: 9pt; margin: 6pt 0 12pt; }
  th, td { padding: 4pt 6pt; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
  th { font-size: 8pt; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); background: var(--panel); }
  tr { break-inside: avoid; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 14pt 0; }
  em { color: var(--ink-2); }
  .cap { font-size: 8.4pt; letter-spacing: 0.1em; text-transform: uppercase; color: var(--gold); font-weight: 600; margin: 0 0 8pt; }
  .lede { font: italic 400 12.5pt/1.45 'Newsreader', Georgia, serif; color: var(--ink-2); margin: 0 0 10pt; }
  .meta { color: var(--muted); font-size: 9pt; margin-bottom: 18pt; }
  .toc { columns: 2; column-gap: 24pt; font-size: 9.4pt; margin: 0 0 6pt; padding-left: 14pt; }
  .toc li { break-inside: avoid; }
  .part { break-before: page; }
  figure { margin: 10pt 0 6pt; break-inside: avoid; }
  figure.chart img { display: block; width: 100%; max-width: 160mm; margin: 0 auto; border: 1px solid var(--line); border-radius: 6px; }
  figure.diagram { text-align: center; }
  figure.diagram pre.mermaid { background: none; border: 0; padding: 0; margin: 0 auto; white-space: pre; font: 10pt 'IBM Plex Sans', sans-serif; }
  figure.diagram svg { max-width: 100% !important; height: auto; max-height: 200mm; }
</style>
${mermaidTag}
</head>
<body>
<p class="cap">${esc(doc.cap)}</p>
<h1>${esc(doc.title)}</h1>
<p class="lede">${esc(doc.lede)}</p>
<p class="meta">Branch ${esc(branch)} at ${commit} · ${date} · printed from docs/${set}.md and docs/${set}-process.md</p>
<h3>Part 1 · What it is, and how to use it</h3>
<ul class="toc">${headings(design).map((h) => `<li>${esc(h)}</li>`).join('')}</ul>
<h3>Part 2 · How it was built, checked and measured</h3>
<ul class="toc">${headings(process_).map((h) => `<li>${esc(h)}</li>`).join('')}</ul>
<section class="part" id="part-1">
<p class="cap">Part 1</p>
<h1>What it is, and how to use it</h1>
${render(design)}
</section>
<section class="part" id="part-2">
<p class="cap">Part 2</p>
<h1>How it was built, checked and measured</h1>
${render(process_)}
</section>
<script>
  window.__diagrams = (async () => {
    if (!window.mermaid) return 'no mermaid';
    mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose', fontFamily: 'IBM Plex Sans, Helvetica Neue, Arial, sans-serif', flowchart: { htmlLabels: true, curve: 'basis' } });
    await mermaid.run({ querySelector: 'pre.mermaid' });
    return document.querySelectorAll('pre.mermaid svg').length;
  })();
</script>
</body>
</html>
`;

mkdirSync(outDir, { recursive: true });
writeFileSync(html, page);

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined });
const tab = await browser.newPage();
if (local) await tab.route(MERMAID_CDN, (route) => route.fulfill({ path: local, contentType: 'application/javascript' }));
await tab.goto(pathToFileURL(html).toString(), { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => undefined);
await tab.evaluate(() => document.fonts.ready).catch(() => undefined);
const drawn = await tab.evaluate(() => window.__diagrams).catch((error) => `failed: ${error.message}`);
const expected = (design.match(/^```mermaid/gm) ?? []).length + (process_.match(/^```mermaid/gm) ?? []).length;
if (drawn !== expected) console.warn(`Mermaid drew ${drawn} of ${expected} diagrams`);
await tab.pdf({
  path: out,
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<span></span>',
  footerTemplate:
    '<div style="width:100%;font:8px IBM Plex Sans,Helvetica,Arial,sans-serif;color:#7a776d;padding:0 16mm;display:flex;justify-content:space-between">' +
    `<span>Koios · ${esc(doc.title)}</span><span>page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
  margin: { top: '18mm', right: '16mm', bottom: '20mm', left: '16mm' },
});
await browser.close();
await cleanup();
console.log(`wrote ${chartCount} charts${chartCount ? ` in ${chartDir}` : ''}, ${html} and ${out} (${drawn} diagrams)`);
