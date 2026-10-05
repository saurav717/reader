// Scenes on the stage, end to end in the real app, with a scripted model.
//
// Six papers of different kinds — distillation, diffusion, a physics PDE,
// protein structure, a survey, and one whose model writes a scene the page
// cannot draw — are put in the app's own database, Claude's API is answered
// by this script (the page for one of them, and the motion block each
// Animate asks for), and a browser drives Explain: the offer under the marked
// figure, the request, the stage and its following of the paragraphs, holding
// a step by hand, the Stage switch, the Notebook layout, and the scene kept
// across a close and reopen. No key and no network beyond localhost.
//
//   npx vite --port 5199 &
//   node scripts/stage-e2e.mjs            # CHROMIUM=/path/to/chrome to use one of your own
//
// Results: stage-e2e/results.json and a picture of each state.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const APP = 'http://localhost:5199/';
const OUT = process.env.OUT ?? 'stage-e2e';
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// The papers, their pages, and the scene the "model" writes for each
// ---------------------------------------------------------------------------

const para = (n, topic) => Array.from({ length: n }, (_, i) => `Paragraph ${i + 1} of the method, on ${topic}. It says what happens at this stage, in enough words to be a paragraph of its own, so that the reading line crosses it on its own and the stage can take it as a step.`).join('\n\n');

const FIG = (caption, animate) => `\`\`\`figure caption="${caption}"${animate ? ' animate="yes"' : ''}\n<svg viewBox="0 0 360 120"><rect x="40" y="20" width="90" height="80" rx="6" class="f-soft s-accent"/><rect x="230" y="40" width="90" height="60" rx="6" class="f-soft s-accent"/><text x="180" y="70" class="t-muted" font-size="11" text-anchor="middle">${caption.slice(0, 24)}</text></svg>\n\`\`\``;

const PAPERS = [
  {
    id: 'e2e-distill', field: 'machine learning', title: 'Distilling the Knowledge in a Neural Network', authors: ['Geoffrey Hinton', 'Oriol Vinyals', 'Jeff Dean'], published: '2015-03-09', arxivId: '1503.02531',
    abstract: 'A very simple way to improve the performance of almost any machine learning algorithm is to train many different models on the same data and then to average their predictions.',
    section: 'The distillation loss', caption: 'The two networks on one batch: only the softened outputs are compared.', paragraphs: 4,
    scene: `{"nodes":[{"id":"x","kind":"input","label":"x","at":[50,92]},{"id":"teacher","kind":"stack","label":"teacher","layers":6,"at":[27,55],"frozen":true,"tone":"blue"},{"id":"student","kind":"stack","label":"student","layers":3,"at":[73,62]},{"id":"p","kind":"dist","label":"softmax(z_T / T)","at":[27,13],"values":[0.72,0.18,0.06,0.04],"labels":["cat","dog","car","ship"],"tone":"blue"},{"id":"q","kind":"dist","label":"softmax(z_S / T)","at":[73,22],"values":[0.4,0.25,0.2,0.15],"labels":["cat","dog","car","ship"]},{"id":"y","kind":"box","label":"y","at":[94,22],"tone":"yellow","step":2}],"edges":[{"from":"x","to":"teacher","flow":"forward"},{"from":"x","to":"student","flow":"forward"},{"id":"kl","from":"p","to":"q","kind":"compare","label":"T²·KL","step":1},{"id":"ce","from":"y","to":"q","kind":"compare","label":"λ·CE","step":2,"tone":"yellow"},{"id":"back","from":"q","to":"student","flow":"backward","step":3}],"steps":[{"caption":"The same batch runs through both networks."},{"caption":"Only the two softened outputs are compared.","highlight":["p","q","kl"]},{"caption":"A small hard-label term keeps the student honest.","highlight":["y","ce"]},{"caption":"Gradients reach the student only.","dim":["teacher","p"],"set":{"q.values":[0.66,0.2,0.08,0.06]}}]}`,
    generate: true,
  },
  {
    id: 'e2e-ddpm', field: 'diffusion models', title: 'Denoising Diffusion Probabilistic Models', authors: ['Jonathan Ho', 'Ajay Jain', 'Pieter Abbeel'], published: '2020-06-19', arxivId: '2006.11239',
    abstract: 'We present high quality image synthesis results using diffusion probabilistic models, a class of latent variable models inspired by considerations from nonequilibrium thermodynamics.',
    section: 'The reverse process: denoising one step at a time', caption: 'Noise added over T steps, then removed one step at a time by a network that predicts the noise.', paragraphs: 3,
    scene: `{"nodes":[{"id":"img","kind":"grid","label":"x_t","at":[22,45],"values":[[0.9,0.8,0.7,0.9],[0.3,0.95,0.2,0.8],[0.85,0.1,0.9,0.3],[0.2,0.7,0.6,0.95]]},{"id":"eps","kind":"box","label":"ε_θ(x_t, t)","at":[58,45]},{"id":"t","kind":"slider","label":"t","min":0,"max":1000,"values":1000,"at":[58,82]},{"id":"out","kind":"grid","label":"x_{t−1}","at":[90,45],"values":[[0.9,0.8,0.7,0.9],[0.3,0.95,0.2,0.8],[0.85,0.1,0.9,0.3],[0.2,0.7,0.6,0.95]],"step":1}],"edges":[{"from":"img","to":"eps","flow":"forward"},{"from":"eps","to":"out","flow":"forward","step":1}],"steps":[{"caption":"At t = T the image is pure noise."},{"caption":"The network predicts the noise in x_t and a little of it is removed.","highlight":["eps"],"set":{"t":500,"out.values":[[0.6,0.5,0.4,0.6],[0.3,0.6,0.3,0.5],[0.55,0.2,0.6,0.3],[0.2,0.5,0.4,0.6]]}},{"caption":"A thousand steps later, a sample.","set":{"t":0,"img.values":[[0.1,0.1,0.1,0.1],[0.1,0.9,0.9,0.1],[0.1,0.9,0.9,0.1],[0.1,0.1,0.1,0.1]],"out.values":[[0,0,0,0],[0,1,1,0],[0,1,1,0],[0,0,0,0]]}}]}`,
  },
  {
    id: 'e2e-pinn', field: 'physics', title: 'Physics-informed neural networks: a deep learning framework for solving forward and inverse problems involving nonlinear partial differential equations', authors: ['Maziar Raissi', 'Paris Perdikaris', 'George Em Karniadakis'], published: '2019-02-01',
    abstract: 'We introduce physics-informed neural networks, neural networks that are trained to solve supervised learning tasks while respecting any given laws of physics described by general nonlinear partial differential equations.',
    section: 'The residual as a loss', caption: 'The network\'s output is differentiated by automatic differentiation and the PDE residual joins the data loss.', paragraphs: 3,
    scene: `{"nodes":[{"id":"xt","kind":"input","label":"x,t","at":[10,50]},{"id":"net","kind":"stack","label":"u_θ","layers":4,"at":[32,50]},{"id":"u","kind":"box","label":"u(x,t)","at":[56,30]},{"id":"res","kind":"box","label":"u_t + u u_x − ν u_xx","at":[60,72],"tone":"pink","step":1},{"id":"loss","kind":"curve","label":"loss over training","at":[85,50],"values":[[1,0.9,0.85,0.8,0.78,0.77]],"labels":["residual"],"step":2}],"edges":[{"from":"xt","to":"net","flow":"forward"},{"from":"net","to":"u"},{"id":"ad","from":"u","to":"res","kind":"compare","label":"∂ by AD","step":1,"tone":"pink"},{"from":"res","to":"loss","step":2}],"steps":[{"caption":"A small network takes x and t and gives u."},{"caption":"Its derivatives come from automatic differentiation, and the PDE residual is formed from them.","highlight":["res","ad"]},{"caption":"The residual is a loss: training drives it to zero where there is no data.","set":{"loss.values":[[1,0.6,0.3,0.12,0.05,0.02]]},"highlight":["loss"]}]}`,
  },
  {
    id: 'e2e-alphafold', field: 'biology', title: 'Highly accurate protein structure prediction with AlphaFold', authors: ['John Jumper', 'Richard Evans', 'Alexander Pritzel'], published: '2021-07-15',
    abstract: 'Proteins are essential to life, and understanding their structure can facilitate a mechanistic understanding of their function.',
    section: 'From sequence to structure', caption: 'The sequence, its evolutionary neighbours, the Evoformer, and the structure module.', paragraphs: 3,
    scene: `{"nodes":[{"id":"seq","kind":"text","label":"MKTAYIAKQR…","at":[14,30]},{"id":"msa","kind":"grid","label":"MSA","at":[14,66],"values":[[0.9,0.6,0.9,0.2,0.9],[0.9,0.5,0.8,0.2,0.9],[0.8,0.6,0.9,0.3,0.7]]},{"id":"evo","kind":"stack","label":"Evoformer × 48","layers":5,"at":[45,50]},{"id":"pair","kind":"grid","label":"pair representation","at":[72,34],"values":[[1,0.2,0.1,0.6],[0.2,1,0.3,0.1],[0.1,0.3,1,0.2],[0.6,0.1,0.2,1]],"step":1},{"id":"struct","kind":"box","label":"structure module","at":[90,70],"step":2}],"edges":[{"from":"seq","to":"evo","flow":"forward"},{"from":"msa","to":"evo","flow":"forward"},{"from":"evo","to":"pair","flow":"forward","step":1},{"from":"pair","to":"struct","flow":"forward","step":2}],"steps":[{"caption":"The sequence and its alignment go into the Evoformer."},{"caption":"Out of it, a pair representation: which residues are near which.","highlight":["pair"]},{"caption":"The structure module turns the pairs into atom positions.","highlight":["struct"]}]}`,
  },
  {
    id: 'e2e-survey', field: 'a survey', title: 'A Survey of Large Language Models', authors: ['Wayne Xin Zhao', 'Kun Zhou', 'Junyi Li'], published: '2023-03-31', arxivId: '2303.18223',
    abstract: 'Language is essentially a complex, intricate system of human expressions governed by grammatical rules.',
    section: 'What the survey covers', caption: 'The four stages the survey organises the field into.', paragraphs: 3, noMark: true,
  },
  {
    id: 'e2e-broken', field: 'a model that writes a bad scene', title: 'Attention Is All You Need', authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar'], published: '2017-06-12', arxivId: '1706.03762',
    abstract: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.',
    section: 'Scaled dot-product attention', caption: 'Queries against keys, scaled, normalised, used to mix the values.', paragraphs: 3,
    scene: `{nodes: [this is not json, "steps": []`,
  },
];

const pageFor = (p) => `## At a glance

- The claim, in one line, for ${p.field}.
- The mechanism, in one line.
- Why it mattered.

Who should care: anyone working on ${p.field}.

## ${p.section}

${para(p.paragraphs, p.field)}

${FIG(p.caption, !p.noMark)}

\`\`\`python title="A cell that proves a point"
import numpy as np
print(np.round(np.array([0.7, 0.2, 0.1]), 2))
\`\`\`
\`\`\`output
[0.7 0.2 0.1]
\`\`\`

## Since then

Later work refined this. What a reader should use today is the same recipe with a modern backbone.
`;

const sectionWithScene = (p) => `## ${p.section}

${para(p.paragraphs, p.field)}

${FIG(p.caption, true)}
\`\`\`motion title="${p.caption.split(':')[0].split('.')[0]}, in motion" figure="${p.caption}"
${p.scene}
\`\`\`

\`\`\`python title="A cell that proves a point"
import numpy as np
print(np.round(np.array([0.7, 0.2, 0.1]), 2))
\`\`\`
\`\`\`output
[0.7 0.2 0.1]
\`\`\``;

// ---------------------------------------------------------------------------
// The scripted model: Claude's streaming API, answered here
// ---------------------------------------------------------------------------

const sse = (text) => {
  const chunks = [];
  for (let i = 0; i < text.length; i += 60) chunks.push(text.slice(i, i + 60));
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return [
    ev('message_start', { message: { id: 'msg_e2e', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ...chunks.map((c) => ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: c } })),
    ev('content_block_stop', { index: 0 }),
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: chunks.length } }),
    ev('message_stop', {}),
  ].join('');
};

const modelCalls = [];
async function answer(route) {
  const request = route.request();
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Expose-Headers': '*' };
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const body = JSON.parse(request.postData() || '{}');
  const system = Array.isArray(body.system) ? body.system.map((b) => b.text).join('\n') : String(body.system ?? '');
  const last = body.messages?.[body.messages.length - 1]?.content;
  const user = typeof last === 'string' ? last : Array.isArray(last) ? last.map((b) => b.text ?? '').join('\n') : '';
  const paper = PAPERS.find((p) => system.includes(`Title: ${p.title}`));
  const call = { paper: paper?.id, kind: user.includes('The reader has a request') ? 'revision' : 'page', promptHasScenes: system.includes('SCENES — a figure can be animated on request'), promptMarks: system.includes('animate="yes"'), request: (/<request>([\s\S]*?)<\/request>/.exec(user) ?? [])[1]?.trim() };
  modelCalls.push(call);
  let reply = '';
  if (!paper) reply = '## Unknown paper\n\nThis paper is not one the script knows.';
  else if (call.kind === 'revision') {
    reply = /animate/i.test(call.request ?? '') ? `<<<replace: ${paper.section}>>>\n${sectionWithScene(paper)}\n<<<note>>>\nAnimated the figure: one step per paragraph.` : `<<<note>>>\nNothing to change.`;
  } else reply = pageFor(paper);
  await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream' }, body: sse(reply) });
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.route('https://api.anthropic.com/**', answer);
await context.addInitScript(() => {
  localStorage.setItem('reader.welcomed', 'true');
  localStorage.setItem('reader.anthropic-key', 'sk-ant-api03-' + 'e2e'.repeat(30));
  localStorage.setItem('reader.explain.layout', 'margin');
  localStorage.setItem('reader.explain.stage', 'on');
  localStorage.setItem('reader.explain.page', 'explain');
  localStorage.setItem('reader.explain.open', 'false');
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404|net::ERR|Failed to load resource/.test(m.text())) errors.push(m.text()); });

// Seed: the app makes its database on first load; then the papers and the pages go in.
await page.goto(APP);
await page.waitForTimeout(1500);
await page.evaluate(async ({ papers, pages }) => {
  const db = await new Promise((resolve, reject) => { const r = indexedDB.open('reader', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const now = new Date().toISOString();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['papers', 'kv'], 'readwrite');
    for (const p of papers) tx.objectStore('papers').put({ id: p.id, source: 'arxiv', title: p.title, authors: p.authors, abstract: p.abstract, published: p.published, categories: ['cs.LG'], arxivId: p.arxivId, addedAt: now, collectionIds: [], tags: [], progress: 0 });
    for (const [id, content] of Object.entries(pages)) tx.objectStore('kv').put({ paperId: id, content, model: 'claude-sonnet-5', created: Date.now(), updated: Date.now() }, `explain:${id}`);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}, { papers: PAPERS, pages: Object.fromEntries(PAPERS.filter((p) => !p.generate).map((p) => [p.id, pageFor(p)])) });

const results = [];
const text = async (sel) => (await page.locator(sel).first().textContent().catch(() => '')) ?? '';
const count = (sel) => page.locator(sel).count();

for (const p of PAPERS) {
  const r = { paper: p.id, title: p.title, field: p.field, steps: [] };
  const note = (what, ok, detail = '') => r.steps.push({ what, ok, detail });
  try {
    await page.evaluate((id) => localStorage.setItem('reader.view', JSON.stringify({ kind: 'paper', id })), p.id);
    await page.goto(APP);
    await page.locator('.explain-toggle').waitFor({ timeout: 15000 });
    await page.locator('.explain-toggle').click();
    await page.locator('.explain').waitFor({ timeout: 10000 });
    if (p.generate) {
      // No page kept for this one: the model writes it, marks and all, through the real stream.
      const start = page.getByRole('button', { name: /Explain this paper/ });
      await start.waitFor({ timeout: 10000 });
      await start.click();
    }
    await page.locator('.explain-section').nth(1).waitFor({ timeout: 20000 });
    await page.waitForFunction(() => !document.querySelector('.explain-outline .outline-meta')?.textContent?.includes('writing'), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(800);
    const offers = await count('.figure-animate');
    const hollow = await count('.explain-outline .play.offered');
    note('figures offered for animation', p.noMark ? offers === 0 : offers === 1, `${offers} offer(s), ${hollow} hollow mark(s) in the outline`);
    await page.screenshot({ path: `${OUT}/${p.id}-1-page.png` });
    if (p.noMark) {
      note('nothing moves on a page with no marked figure', (await count('.explain-motion')) === 0 && (await count('.explain-stage')) === 0);
      results.push(r);
      await page.keyboard.press('Escape');
      continue;
    }
    await page.locator('.figure-animate .btn').first().click();
    note('the request went to the model', true);
    await page.locator('.explain-motion').waitFor({ timeout: 20000 });
    await page.waitForFunction(() => !document.querySelector('.explain-section.is-revising'), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const calls = modelCalls.filter((c) => c.paper === p.id);
    note('the model was asked with the scene rules and the animate request', calls.some((c) => c.kind === 'revision' && c.promptHasScenes && /animate the figure/i.test(c.request ?? '')), calls.map((c) => `${c.kind}: ${c.request ?? '(first page)'}`).join(' | '));
    if (p.id === 'e2e-broken') {
      const msg = await text('.explain-motion .motion-art.drawing');
      note('a bad scene is said so, and the figure stays', /not a scene/.test(msg) && (await count('.explain-figure')) >= 1, msg.trim());
      await page.screenshot({ path: `${OUT}/${p.id}-2-bad-scene.png` });
      results.push(r);
      await page.keyboard.press('Escape');
      continue;
    }
    const stage = await count('.explain-stage');
    const state = await text('.explain-stage .motion-state');
    note('the stage appeared and follows the reading', stage === 1 && /follows/.test(state), state.trim());
    const caption1 = await text('.explain-stage .motion-caption');
    note('the outline marks the section as having a scene', (await count('.explain-outline .play.has')) === 1);
    note('the offer is gone once the scene exists', (await count('.figure-animate')) === 0);
    await page.screenshot({ path: `${OUT}/${p.id}-2-stage.png` });
    // Read on: the last paragraph under the reading line is the last step.
    await page.evaluate(() => {
      const s = document.querySelector('.explain-scroll');
      const ps = s.querySelectorAll('.explain-section.has-stage .stage-main .explain-prose > p');
      const last = ps[ps.length - 1];
      s.scrollTop += last.getBoundingClientRect().top - s.getBoundingClientRect().top - s.clientHeight / 3 + 30;
    });
    await page.waitForTimeout(1300);
    const caption2 = await text('.explain-stage .motion-caption');
    note('the step moved with the paragraph', caption1 !== caption2, `${caption1.trim()} → ${caption2.trim()}`);
    await page.screenshot({ path: `${OUT}/${p.id}-3-last-step.png` });
    // Held by hand, then handed back.
    await page.locator('.explain-stage .motion-steps .dots button').first().click();
    await page.waitForTimeout(400);
    note('a step picked by hand holds the stage', /held/.test(await text('.explain-stage .motion-state')));
    await page.locator('.explain-stage .motion-state.as-btn').click();
    await page.waitForTimeout(400);
    note('follow again on request', /follows/.test(await text('.explain-stage .motion-state')));
    // The switch.
    await page.locator('.stage-toggle').click();
    await page.waitForTimeout(500);
    note('Stage off: no stage, no scene, no marks, the figure still there', (await count('.explain-stage')) === 0 && (await count('.explain-motion')) === 0 && (await count('.explain-outline .play')) === 0 && (await count('.explain-figure')) >= 1);
    await page.screenshot({ path: `${OUT}/${p.id}-4-stage-off.png` });
    await page.locator('.stage-toggle').click();
    await page.waitForTimeout(500);
    note('Stage on again: the scene is back', (await count('.explain-stage')) === 1);
    // The other layouts: a card in the flow.
    await page.getByRole('button', { name: 'Notebook', exact: true }).click();
    await page.waitForTimeout(500);
    note('Notebook layout: the scene is a card in the flow, not a stage', (await count('.explain-stage')) === 0 && (await count('.explain-motion')) === 1);
    await page.screenshot({ path: `${OUT}/${p.id}-5-notebook.png` });
    await page.getByRole('button', { name: 'Margin', exact: true }).click();
    await page.waitForTimeout(400);
    // The page keeps the scene: close and reopen.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await page.locator('.explain-toggle').click();
    await page.locator('.explain-section').nth(1).waitFor({ timeout: 10000 });
    await page.waitForTimeout(600);
    note('the scene is kept with the page across a close and reopen', (await count('.explain-motion')) === 1);
    await page.keyboard.press('Escape');
  } catch (error) {
    note('failed', false, String(error.message || error).split('\n')[0]);
    await page.screenshot({ path: `${OUT}/${p.id}-failed.png` }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
  }
  results.push(r);
}

writeFileSync(`${OUT}/results.json`, JSON.stringify({ results, modelCalls, errors }, null, 2));
for (const r of results) {
  console.log(`\n${r.title} (${r.field})`);
  for (const s of r.steps) console.log(`  ${s.ok ? 'PASS' : 'FAIL'}  ${s.what}${s.detail ? `  — ${s.detail}` : ''}`);
}
console.log(`\nmodel calls: ${modelCalls.length}; page errors: ${errors.length}${errors.length ? '\n' + errors.join('\n') : ''}`);
await browser.close();
