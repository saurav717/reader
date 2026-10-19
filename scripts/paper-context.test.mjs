// The paper in a project's folder, without the reader: the HTML it shows turned into Markdown (in Chromium, since the
// walk is over a DOM), the front matter over the text, which files are written again and which kept, and the one line
// every briefing uses to point the agents at the files instead of the web.
//
//   node --test scripts/paper-context.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium } from 'playwright';

import { cleanup, load } from './bundle.mjs';

const md = await load('src/lib/paperMarkdown.ts');
const files = await load('src/lib/paperFiles.ts');
const context = await load('src/lib/paperContext.ts', { external: ['react', '@anthropic-ai/sdk', 'pdfjs-dist/*', 'dompurify'], imports: true });
const agent = await load('src/lib/projectAgent.ts', { external: ['react', '@anthropic-ai/sdk'], imports: true });
const playground = await load('src/lib/playground.ts', { external: ['react', '@anthropic-ai/sdk'], imports: true });

after(cleanup);

const paper = {
  id: 'p1',
  title: 'Dreaming of Control',
  authors: ['A. Author', 'B. Writer'],
  published: '2025-03-01',
  venue: 'ICLR',
  arxivId: '2503.00001',
  abstract: 'We learn a world model and plan in it.',
};

describe('the briefings', () => {
  it('name the files, and say not to fetch the paper', () => {
    for (const text of [files.PAPER_FILES_NOTE, agent.planMarkdown({ title: 'T', plan: 'Step 1' }), agent.cliWriteRequest(true), playground.paperFiles('Trying T', { paperId: 'p1', title: 'T' })['AGENTS.md']]) {
      assert.match(text, /paper\/paper\.md/);
      assert.match(text, /paper\/EXPLANATION\.md/);
      assert.match(text, /IMPLEMENTATION_PLAN\.md/);
      assert.match(text, /[Dd]o not search the web/);
    }
  });
  it("give the page's own agent the full text from the folder's file", () => {
    const block = agent.projectBlock({ where: 'here', listing: [], open: [], console: [], paper: { title: 'T', fullText: 'THE WHOLE PAPER' } });
    assert.match(block, /paper\/paper\.md/);
    assert.match(block, /THE WHOLE PAPER/);
    assert.match(block, /never search for the paper elsewhere/);
    assert.doesNotMatch(agent.projectBlock({ where: 'here', listing: [], open: [], console: [], paper: { title: 'T' } }), /paper\/paper\.md/);
  });
});

describe('paper.md', () => {
  it('has front matter, the details, the abstract and the text', () => {
    const text = md.paperMarkdown(paper, '# 1 Introduction\n\nBody.', 'pdf');
    assert.match(text, /^---\ngenerator: "reader"\ntitle: "Dreaming of Control"\npaperId: "p1"\nauthors: \["A. Author","B. Writer"\]\npublished: "2025-03-01"\nvenue: "ICLR"\narxivId: "2503.00001"\ntext: "reflowed from the PDF by Koios"\nwritten: "20/);
    assert.match(text, /\n# Dreaming of Control\n\nA\. Author, B\. Writer \(2025\)\n\n## Abstract\n\nWe learn a world model and plan in it\.\n\n## Full text\n\n# 1 Introduction\n\nBody\.\n$/);
    assert.doesNotMatch(text, /doi:/);
  });
  it('says so when only the abstract could be had', () => {
    const text = md.paperMarkdown(paper, '', 'abstract');
    assert.match(text, /text: "the abstract only/);
    assert.doesNotMatch(text, /## Full text/);
  });
  it('is the same file again, whenever it was written', () => {
    const a = md.stripDates(md.paperMarkdown(paper, 'Body.', 'pdf'));
    const b = md.stripDates(md.paperMarkdown(paper, 'Body.', 'pdf').replace(/written: "[^"]+"/, 'written: "1999-01-01T00:00:00.000Z"'));
    assert.equal(a, b);
    assert.notEqual(a, md.stripDates(md.paperMarkdown(paper, 'Other.', 'pdf')));
  });
});

describe('the HTML as Markdown', { skip: !existsSync('/opt/pw-browsers/chromium') && !process.env.PLAYWRIGHT_CHROMIUM ? 'no Chromium on this machine' : false }, () => {
  it('keeps headings, lists, tables, captions, code and maths as TeX', async () => {
    const { outputFiles } = await build({ entryPoints: ['src/lib/paperMarkdown.ts'], bundle: true, format: 'esm', write: false, logLevel: 'silent' });
    const source = outputFiles[0].text;
    const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined) });
    try {
      const page = await browser.newPage();
      const html = `<article><h1>Dreaming <span>of</span> Control</h1><p>We plan in <em>latent</em> space, see <math><semantics><mi>x</mi><annotation encoding="application/x-tex">x_t</annotation></semantics></math>.</p>
<section><h2>2 Method</h2><p>Steps:</p><ul><li>encode<ul><li>then decode</li></ul></li><li>plan</li></ul>
<math display="block"><semantics><mrow><mi>a</mi></mrow><annotation encoding="application/x-tex">\\min_a L(a)</annotation></semantics></math>
<figure><img src="x.png"><figcaption>Figure 1: the loop.</figcaption></figure>
<table><caption>Table 1</caption><tr><th>Task</th><th>Score</th></tr><tr><td>walker</td><td>900 | 950</td></tr></table>
<pre>def f():\n    pass</pre><script>alert(1)</script><p>Code is <code>f()</code>.</p></section></article>`;
      const out = await page.evaluate(async ([src, html]) => {
        const mod = await import(`data:text/javascript;base64,${btoa(unescape(encodeURIComponent(src)))}`);
        return mod.htmlToMarkdown(html);
      }, [source, html]);
      assert.equal(
        out,
        [
          '# Dreaming of Control',
          'We plan in latent space, see $x_t$.',
          '## 2 Method',
          'Steps:',
          '- encode',
          '- then decode',
          '- plan',
          '$$\\min_a L(a)$$',
          '*Figure 1: the loop.*',
          '*Table 1*\n\n| Task | Score |\n| --- | --- |\n| walker | 900 \\| 950 |',
          '```\ndef f():\n    pass\n```',
          'Code is `f()`.',
        ].join('\n\n'),
      );
    } finally {
      await browser.close();
    }
  });
});

/** A folder in memory, with or without room for a binary file. */
function folder(initial = {}, { binary = true } = {}) {
  const texts = { ...initial };
  const binaries = {};
  const host = {
    label: 'test',
    async list(path = '') {
      const prefix = path ? `${path}/` : '';
      return [...Object.keys(texts), ...Object.keys(binaries)].filter((p) => p.startsWith(prefix)).map((p) => ({ name: p.slice(prefix.length), path: p, type: 'file', size: 1, modified: null }));
    },
    async read(path) {
      return path in texts ? texts[path] : null;
    },
    async write(path, text) {
      texts[path] = text;
    },
    ...(binary ? { async writeBase64(path, data) { binaries[path] = data; } } : {}),
  };
  return { host, texts, binaries };
}

const gathered = (wants) => ({
  files: { ...(wants.text ? { [files.PAPER_TEXT_FILE]: md.paperMarkdown(paper, 'Body.', 'pdf') } : {}), ...(wants.explanation ? { [files.EXPLANATION_FILE]: '---\nwritten: "now"\n---\n\nExplained.\n' } : {}) },
  pdf: wants.pdf ? 'JVBERi0=' : undefined,
  textSource: 'pdf',
  missing: [],
});

describe('the files in the folder', () => {
  it('are all written the first time, the PDF where the folder takes one', async () => {
    const asked = [];
    const { host, texts, binaries } = folder();
    const report = await context.ensurePaperContext(host, paper, { gather: async (_, options) => (asked.push(options.want), gathered(options.want)) });
    assert.deepEqual(asked, [{ text: true, pdf: true, explanation: true }]);
    assert.deepEqual(report.wrote, [files.PAPER_TEXT_FILE, files.EXPLANATION_FILE, files.PAPER_PDF_FILE]);
    assert.match(texts['paper/paper.md'], /## Full text/);
    assert.equal(binaries['paper/paper.pdf'], 'JVBERi0=');
    assert.deepEqual(report.missing, []);
  });
  it('fetches neither the text nor the PDF again, and rewrites the explanation only when it changed', async () => {
    const asked = [];
    const { host, texts } = folder({ 'paper/paper.md': md.paperMarkdown(paper, 'Body.', 'pdf'), 'paper/EXPLANATION.md': '---\nwritten: "then"\n---\n\nExplained.\n' });
    await host.writeBase64('paper/paper.pdf', 'x');
    const first = await context.ensurePaperContext(host, paper, { gather: async (_, options) => (asked.push(options.want), gathered(options.want)) });
    assert.deepEqual(asked, [{ text: false, pdf: false, explanation: true }]);
    assert.deepEqual(first.wrote, []);
    assert.deepEqual(first.kept, [files.PAPER_TEXT_FILE, files.PAPER_PDF_FILE, files.EXPLANATION_FILE]);
    texts['paper/EXPLANATION.md'] = '---\n---\n\nAn older page.\n';
    const second = await context.ensurePaperContext(host, paper, { gather: async (_, options) => gathered(options.want) });
    assert.deepEqual(second.wrote, [files.EXPLANATION_FILE]);
    assert.match(texts['paper/EXPLANATION.md'], /Explained\./);
  });
  it('says what a text-only folder cannot hold, and what could not be had', async () => {
    const { host, binaries } = folder({}, { binary: false });
    const report = await context.ensurePaperContext(host, paper, { gather: async (_, options) => ({ ...gathered({ ...options.want, pdf: false }), missing: ['the Explain page (none was written for this paper yet)'] }) });
    assert.deepEqual(Object.keys(binaries), []);
    assert.deepEqual(report.wrote, [files.PAPER_TEXT_FILE, files.EXPLANATION_FILE]);
    assert.match(context.paperContextSummary(report), /^Put in the folder: paper\/paper\.md, paper\/EXPLANATION\.md\. Not there: the Explain page \(none was written for this paper yet\); the PDF \(this folder holds text files only; the full text is there in its place\)\.$/);
  });
});
