/**
 * "Your library, and where you left off": Home with a seeded library of ML
 * papers in three collections — some part-read, at the page and line they
 * were left on, some finished, some new. Walks Home's views by tab and by
 * key (Find papers, Continue reading, Today, Inbox, Collections, with a card
 * dragged between columns), resumes the paper, lays out the desk with R,
 * switches paper with 2 and goes Home with G.
 *
 * Off camera, prepare() opens each paper in progress and scrolls it to where
 * it was "left", so Home and the desk show real pages; the library is then
 * re-seeded so dates and progress read as a lived-in week.
 */
import { attentionPdf, json, BASE } from '../lib.mjs';

const HOUR = 3600 * 1000;
const ago = (hours) => new Date(Date.now() - hours * HOUR).toISOString();

const COLLECTIONS = [
  { id: 'c-transformers', name: 'Transformers', color: '#2f7d6d' },
  { id: 'c-diffusion', name: 'Diffusion models', color: '#7b5fb0' },
  { id: 'c-group', name: 'Reading group', color: '#c08a2e' },
];

// What each printed paper says: an abstract, its sections and a few paragraphs to set under them.
const TEXT = {
  flash: {
    abstract: 'Transformers are slow and memory-hungry on long sequences, since the time and memory complexity of self-attention are quadratic in sequence length. We argue that a missing principle is making attention algorithms IO-aware—accounting for reads and writes between levels of GPU memory. We propose FlashAttention, an IO-aware exact attention algorithm that uses tiling to reduce the number of memory reads/writes between GPU high bandwidth memory (HBM) and on-chip SRAM.',
    sections: ['Introduction', 'Background', 'FlashAttention: Algorithm, Analysis, and Extensions', 'IO Complexity', 'Block-Sparse FlashAttention', 'Experiments', 'Limitations and Future Directions'],
    paras: [
      'Approximate attention methods have attempted to address this problem by trading off model quality to reduce the compute complexity, but often do not achieve wall-clock speedup. Many of these methods focus on FLOP reduction, which may not correlate with wall-clock speed, and tend to ignore overheads from memory access (IO).',
      'On modern GPUs, compute speed has out-paced memory speed, and most operations in Transformers are bottlenecked by memory accesses. IO-aware algorithms have been critical for similarly memory-bound operations, when reading and writing data can account for a large portion of the runtime.',
      'We restructure the attention computation to split the input into blocks and make several passes over input blocks, thus incrementally performing the softmax reduction. We also store the softmax normalization factor from the forward pass to quickly recompute attention on-chip in the backward pass, which is faster than reading the intermediate attention matrix from HBM.',
      'We analyze the IO complexity of FlashAttention, proving that it requires O(N²d²M⁻¹) HBM accesses where d is the head dimension and M is the size of SRAM, as compared to Ω(Nd + N²) of standard attention. For typical values of d and M, FlashAttention requires many times fewer HBM accesses.',
      'FlashAttention trains Transformer models faster in wall-clock time. We train BERT-large (seq. length 512) 15% faster than the training speed record in MLPerf 1.1, GPT2 (seq. length 1K) 3× faster than baseline implementations, and Long-Range Arena (seq. length 1K–4K) 2.4× faster than baselines.',
    ],
    eq: 'S = QKᵀ ∈ ℝᴺˣᴺ,   P = softmax(S),   O = PV ∈ ℝᴺˣᵈ',
  },
  ddpm: {
    abstract: 'We present high quality image synthesis results using diffusion probabilistic models, a class of latent variable models inspired by considerations from nonequilibrium thermodynamics. Our best results are obtained by training on a weighted variational bound designed according to a novel connection between diffusion probabilistic models and denoising score matching with Langevin dynamics.',
    sections: ['Introduction', 'Background', 'Diffusion models and denoising autoencoders', 'Forward process and L_T', 'Reverse process and L_{1:T−1}', 'Experiments', 'Related Work', 'Conclusion'],
    paras: [
      'A diffusion probabilistic model is a parameterized Markov chain trained using variational inference to produce samples matching the data after finite time. Transitions of this chain are learned to reverse a diffusion process, which is a Markov chain that gradually adds noise to the data in the opposite direction of sampling until signal is destroyed.',
      'When the diffusion consists of small amounts of Gaussian noise, it is sufficient to set the sampling chain transitions to conditional Gaussians too, allowing for a particularly simple neural network parameterization. Diffusion models are straightforward to define and efficient to train.',
      'We show that a certain parameterization of diffusion models reveals an equivalence with denoising score matching over multiple noise levels during training and with annealed Langevin dynamics during sampling. We obtained our best sample quality results using this parameterization.',
      'Despite their sample quality, our models do not have competitive log likelihoods compared to other likelihood-based models. We find that the majority of our models’ lossless codelengths are consumed to describe imperceptible image details.',
      'On the unconditional CIFAR10 dataset, we obtain an Inception score of 9.46 and a state-of-the-art FID score of 3.17. On 256×256 LSUN, we obtain sample quality similar to ProgressiveGAN.',
    ],
    eq: 'q(xₜ | xₜ₋₁) = 𝒩(xₜ; √(1−βₜ) xₜ₋₁, βₜ I)',
  },
  lora: {
    abstract: 'An important paradigm of natural language processing consists of large-scale pre-training on general domain data and adaptation to particular tasks or domains. As we pre-train larger models, full fine-tuning, which retrains all model parameters, becomes less feasible. We propose Low-Rank Adaptation, or LoRA, which freezes the pre-trained model weights and injects trainable rank decomposition matrices into each layer of the Transformer architecture.',
    sections: ['Introduction', 'Problem Statement', 'Aren’t Existing Solutions Good Enough?', 'Our Method', 'Empirical Experiments', 'Understanding the Low-Rank Updates', 'Conclusion and Future Work'],
    paras: [
      'Many applications in natural language processing rely on adapting one large-scale, pre-trained language model to multiple downstream applications. Such adaptation is usually done via fine-tuning, which updates all the parameters of the pre-trained model. The major downside of fine-tuning is that the new model contains as many parameters as in the original model.',
      'We hypothesize that the change in weights during model adaptation also has a low “intrinsic rank”. LoRA allows us to train some dense layers in a neural network indirectly by optimizing rank decomposition matrices of the dense layers’ change during adaptation instead, while keeping the pre-trained weights frozen.',
      'For a pre-trained weight matrix W₀ ∈ ℝᵈˣᵏ, we constrain its update by representing the latter with a low-rank decomposition W₀ + ΔW = W₀ + BA, where B ∈ ℝᵈˣʳ, A ∈ ℝʳˣᵏ, and the rank r ≪ min(d, k).',
      'Compared to GPT-3 175B fine-tuned with Adam, LoRA can reduce the number of trainable parameters by 10,000 times and the GPU memory requirement by 3 times. LoRA performs on-par or better than fine-tuning in model quality on RoBERTa, DeBERTa, GPT-2, and GPT-3, despite having fewer trainable parameters.',
      'Our simple linear design allows us to merge the trainable matrices with the frozen weights when deployed, introducing no inference latency compared to a fully fine-tuned model, by construction.',
    ],
    eq: 'h = W₀x + ΔWx = W₀x + BAx',
  },
};

const author = (names) => names;
const PAPERS = [
  // In progress — Attention is the one to carry on with.
  { id: 'scholar:attention', title: 'Attention Is All You Need', authors: author(['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar', 'Jakob Uszkoreit', 'Llion Jones', 'Aidan N. Gomez', 'Łukasz Kaiser', 'Illia Polosukhin']), venue: 'NeurIPS', published: '2017-06-12', file: 'attention', progress: 0.38, opened: 3, added: 24 * 6, in: ['c-transformers', 'c-group'], abstract: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.' },
  { id: 'scholar:flash', title: 'FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness', authors: ['Tri Dao', 'Daniel Y. Fu', 'Stefano Ermon', 'Atri Rudra', 'Christopher Ré'], venue: 'NeurIPS', published: '2022-05-27', file: 'flash', progress: 0.56, opened: 26, added: 24 * 5, in: ['c-transformers'] },
  { id: 'scholar:ddpm', title: 'Denoising Diffusion Probabilistic Models', authors: ['Jonathan Ho', 'Ajay Jain', 'Pieter Abbeel'], venue: 'NeurIPS', published: '2020-06-19', file: 'ddpm', progress: 0.31, opened: 50, added: 24 * 9, in: ['c-diffusion'] },
  { id: 'scholar:lora', title: 'LoRA: Low-Rank Adaptation of Large Language Models', authors: ['Edward J. Hu', 'Yelong Shen', 'Phillip Wallis', 'Zeyuan Allen-Zhu'], venue: 'ICLR', published: '2021-06-17', file: 'lora', progress: 0.22, opened: 24 * 7 + 4, added: 24 * 12, in: ['c-group'] },
  // Finished.
  { id: 'scholar:bert', title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding', authors: ['Jacob Devlin', 'Ming-Wei Chang', 'Kenton Lee', 'Kristina Toutanova'], venue: 'NAACL', published: '2018-10-11', progress: 1, opened: 24 * 18, added: 24 * 30, in: ['c-transformers'] },
  { id: 'scholar:ldm', title: 'High-Resolution Image Synthesis with Latent Diffusion Models', authors: ['Robin Rombach', 'Andreas Blattmann', 'Dominik Lorenz', 'Patrick Esser', 'Björn Ommer'], venue: 'CVPR', published: '2021-12-20', progress: 1, opened: 24 * 11, added: 24 * 21, in: ['c-diffusion'] },
  // Not started: two new since the last visit, one waiting from before.
  { id: 'scholar:scaling', title: 'Scaling Laws for Neural Language Models', authors: ['Jared Kaplan', 'Sam McCandlish', 'Tom Henighan', 'Tom B. Brown'], venue: 'arXiv', published: '2020-01-23', progress: 0, added: 9, in: ['c-group'], abstract: 'We study empirical scaling laws for language model performance on the cross-entropy loss. The loss scales as a power-law with model size, dataset size, and the amount of compute used for training.' },
  { id: 'scholar:cfg', title: 'Classifier-Free Diffusion Guidance', authors: ['Jonathan Ho', 'Tim Salimans'], venue: 'NeurIPS Workshop', published: '2022-07-26', progress: 0, added: 28, in: ['c-diffusion'], abstract: 'We show that guidance can be performed by a pure generative model without a classifier: we jointly train a conditional and an unconditional diffusion model, and combine the resulting estimates.' },
  { id: 'scholar:chinchilla', title: 'Training Compute-Optimal Large Language Models', authors: ['Jordan Hoffmann', 'Sebastian Borgeaud', 'Arthur Mensch', 'Laurent Sifre'], venue: 'NeurIPS', published: '2022-03-29', progress: 0, added: 24 * 9, in: ['c-group'], abstract: 'We investigate the optimal model size and number of tokens for training a transformer language model under a given compute budget, and find that model size and training tokens should be scaled equally.' },
];
const IN_PROGRESS_ORDER = ['scholar:lora', 'scholar:ddpm', 'scholar:flash', 'scholar:attention']; // opened oldest first, off camera

function record(p) {
  return {
    id: p.id,
    source: 'scholar',
    title: p.title,
    authors: p.authors,
    abstract: p.abstract ?? TEXT[p.file]?.abstract ?? '',
    published: p.published,
    venue: p.venue,
    categories: [],
    pdfUrl: `https://example.org/papers/${p.id.split(':')[1]}.pdf`,
    addedAt: ago(p.added),
    lastOpenedAt: p.opened ? ago(p.opened) : undefined,
    collectionIds: p.in,
    tags: [],
    progress: p.progress,
  };
}

/** A conference-style paper, two columns, printed by Chromium. */
function paperHtml(p) {
  const t = TEXT[p.file];
  const body = t.sections
    .map((name, s) => {
      const paras = [0, 1, 2, 3].map((i) => `<p>${t.paras[(s + i) % t.paras.length]}</p>`);
      const extra =
        s % 2 === 1
          ? `<div class="eq">${t.eq} <span>(${s})</span></div>`
          : s === 2
            ? `<figure><div class="fig"><div></div><div></div><div></div><div></div></div><figcaption>Figure ${s}: Overview of the method. Left: the standard formulation. Right: ours.</figcaption></figure>`
            : '';
      return `<h2>${s + 1}&nbsp;&nbsp;${name}</h2>${paras.slice(0, 2).join('')}${extra}${paras.slice(2).join('')}`;
    })
    .join('');
  return `<!doctype html><html><head><style>
    body { font-family: 'Times New Roman', Times, serif; font-size: 10pt; line-height: 1.32; margin: 0; color: #111; }
    h1 { text-align: center; font-size: 17pt; margin: 0 0 10pt; }
    .by { text-align: center; font-size: 10pt; margin-bottom: 14pt; }
    .abs { margin: 0 0.45in 14pt; font-size: 9.5pt; } .abs b { display: block; text-align: center; margin-bottom: 4pt; }
    .cols { column-count: 2; column-gap: 0.3in; text-align: justify; hyphens: auto; }
    h2 { font-size: 11pt; margin: 10pt 0 5pt; break-after: avoid; }
    p { margin: 0 0 6pt; text-indent: 1.2em; }
    .eq { text-align: center; font-style: italic; margin: 8pt 0; } .eq span { float: right; font-style: normal; }
    figure { margin: 8pt 0; break-inside: avoid; } .fig { height: 1.4in; display: grid; grid-template-columns: 1fr 1fr; gap: 6pt; }
    .fig div { border: 1px solid #555; background: repeating-linear-gradient(135deg, #eee 0 6px, #fafafa 6px 12px); }
    figcaption { font-size: 9pt; margin-top: 4pt; }
  </style></head><body>
    <h1>${p.title}</h1><div class="by">${p.authors.join(', ')}</div>
    <div class="abs"><b>Abstract</b>${t.abstract}</div>
    <div class="cols">${body}${body.replace(/<h2>(\d+)/g, (m, n) => `<h2>${Number(n) + t.sections.length}`)}</div>
  </body></html>`;
}

export async function setup(context) {
  const pdfs = { attention: await attentionPdf() };
  const printer = await context.browser().newPage();
  for (const p of PAPERS.filter((item) => item.file && item.file !== 'attention')) {
    await printer.setContent(paperHtml(p));
    pdfs[p.file] = await printer.pdf({ format: 'Letter', margin: { top: '0.75in', bottom: '0.75in', left: '0.75in', right: '0.75in' } });
  }
  await printer.close();
  const byName = Object.fromEntries(PAPERS.filter((p) => p.file).map((p) => [p.id.split(':')[1], pdfs[p.file]]));
  await context.route('**/pdf?*', (route) => {
    const url = new URL(route.request().url()).searchParams.get('url') || '';
    const name = /papers\/([^/.]+)\.pdf/.exec(url)?.[1];
    const body = byName[name] ?? pdfs.attention;
    route.fulfill({ status: 200, contentType: 'application/pdf', body });
  });
  // Find papers suggests papers near the one being read, from OpenAlex.
  const NEAR = [
    ['W1', 'Reformer: The Efficient Transformer', 'N Kitaev', '2020-01-13', 2400],
    ['W2', 'Longformer: The Long-Document Transformer', 'I Beltagy', '2020-04-10', 3900],
    ['W3', 'Transformer-XL: Attentive Language Models beyond a Fixed-Length Context', 'Z Dai', '2019-01-09', 4100],
    ['W4', 'Rethinking Attention with Performers', 'K Choromanski', '2020-09-30', 1700],
    ['W5', 'RoFormer: Enhanced Transformer with Rotary Position Embedding', 'J Su', '2021-04-20', 1500],
    ['W6', 'GQA: Training Generalized Multi-Query Transformer Models from Multi-Head Checkpoints', 'J Ainslie', '2023-05-22', 600],
  ];
  await context.route('**/api.openalex.org/works*', (route) =>
    route.fulfill(
      json({
        meta: { count: NEAR.length },
        results: NEAR.map(([id, title, name, date, cited]) => ({ id: `https://openalex.org/${id}`, display_name: title, title, publication_date: date, publication_year: Number(date.slice(0, 4)), authorships: [{ author: { display_name: name } }], cited_by_count: cited })),
      }),
    ),
  );
}

async function seed(page, { home, visitAt } = {}) {
  await page.evaluate(
    async ({ papers, collections, home, visitAt }) => {
      if (home) localStorage.setItem('reader.home', JSON.stringify(home));
      if (visitAt) localStorage.setItem('reader.visit.at', visitAt);
      localStorage.setItem('reader.view', JSON.stringify({ kind: 'all' }));
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('reader', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction(['papers', 'collections', 'highlights'], 'readwrite');
      for (const name of ['papers', 'collections', 'highlights']) tx.objectStore(name).clear();
      for (const c of collections) tx.objectStore('collections').put({ ...c, createdAt: new Date(Date.now() - 40 * 864e5).toISOString() });
      for (const p of papers) tx.objectStore('papers').put(p);
      const at = (h) => new Date(Date.now() - h * 3600e3).toISOString();
      tx.objectStore('highlights').put({ id: 'h1', paperId: 'scholar:attention', color: 'yellow', exact: 'An attention function can be described as mapping a query and a set of key-value pairs to an output', prefix: '', suffix: '', hint: 0, tags: [], createdAt: at(3.2), note: 'Q, K, V — revisit for the reading group' });
      tx.objectStore('highlights').put({ id: 'h2', paperId: 'scholar:flash', color: 'green', exact: 'we make attention algorithms IO-aware—accounting for reads and writes between levels of GPU memory', prefix: '', suffix: '', hint: 0, tags: [], createdAt: at(26) });
      tx.objectStore('highlights').put({ id: 'h3', paperId: 'scholar:ddpm', color: 'blue', exact: 'an equivalence with denoising score matching over multiple noise levels', prefix: '', suffix: '', hint: 0, tags: [], createdAt: at(50) });
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { papers: PAPERS.map(record), collections: COLLECTIONS, home, visitAt },
  );
}

async function reload(page) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const skip = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.locator('.main.home').waitFor({ timeout: 15000 });
}

/** Open a paper from Home, scroll it to `fraction` of the way through, and come back Home: its spot is kept. */
async function readTo(page, paper) {
  const hero = page.locator('.home-continue-title', { hasText: paper.title.slice(0, 30) });
  if (await hero.count()) await page.locator('.home-resume').click();
  else await page.locator('.home-row', { hasText: paper.title.slice(0, 30) }).first().click();
  await page.waitForSelector(`.main[data-paper-id="${paper.id}"]`, { timeout: 15000 });
  await page.waitForSelector('.pdf-book-page:not(.drawing) canvas', { timeout: 30000 });
  await page.waitForTimeout(800);
  await page.locator('.pdf-scroll').evaluate((el, f) => {
    el.scrollTop = f * (el.scrollHeight - el.clientHeight);
  }, paper.progress);
  await page.waitForTimeout(600);
  await page.waitForFunction(() => !document.querySelector('.pdf-scroll .pdf-book-page.drawing'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1600);
  await page.locator('.rail button.brand').click();
  await page.locator('.main.home').waitFor({ timeout: 10000 });
  await page.waitForTimeout(400);
}

const HOME_PREFS = (opensOn) => ({ opensOn, tabs: ['search', 'continue', 'today', 'inbox', 'board'], last: opensOn, clearPanels: true, v: 2 });

export async function prepare({ page, arrive }) {
  await arrive({ settings: { readingMode: 'pdf' } });
  await seed(page, { home: HOME_PREFS('continue') });
  await page.evaluate(() => localStorage.removeItem('reader.spots'));
  await reload(page);
  for (const id of IN_PROGRESS_ORDER) await readTo(page, PAPERS.find((p) => p.id === id));
  const spots = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('reader.spots') || '{}')));
  if (spots.length < 4) console.log(`  (only ${spots.length} spots kept: ${spots.join(', ')})`);
  // The week as it should read: the dates and progress seeded, not the ones just made.
  // Wait out the reader's debounced progress write, then put the library back.
  await page.waitForTimeout(1200);
  await seed(page, { home: HOME_PREFS('search'), visitAt: ago(46) });
  await reload(page);
  await page.locator('.find').waitFor({ timeout: 10000 });
  await page.locator('.find-why').first().waitFor({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(800);
}

export default async function ({ page, pointer, mark, spot, unspot }) {
  const hold = (ms) => page.waitForTimeout(ms);
  const home = page.locator('.main.home');

  mark('home-find-papers');
  // Out of the search box, so the number keys switch views.
  await page.evaluate(() => document.activeElement?.blur());
  await hold(600);
  await spot(['.home-hello', '.home-tabs']);
  await pointer.moveTo('.home-hello h1', { ms: 900 });
  await hold(2600);
  await spot('.find-colls');
  await pointer.moveTo('.find-colls', { ms: 900 });
  await hold(2500);
  await pointer.moveTo('.find-carry', { ms: 900 });
  await spot('.find-carry');
  await hold(2500);
  unspot();
  // Back up to the tabs, smoothly, before switching view.
  await page.locator('.home-scroll').evaluate((el) => el.scrollTo({ top: 0, behavior: 'smooth' }));
  await hold(900);

  mark('continue-reading');
  const tab = page.locator('.home-tab', { hasText: 'Continue reading' });
  await spot(tab);
  await pointer.click(tab);
  await page.locator('.home-continue').waitFor();
  await hold(600);
  await spot('.home-continue');
  await pointer.moveTo('.home-continue-title', { ms: 900 });
  await hold(2600);
  await spot(['.home-peek-read', '.home-peek .home-stop']);
  await pointer.moveTo('.home-peek .home-stop', { ms: 900, dx: 0.3 });
  await hold(2800);
  await spot(page.locator('.home-side .home-card').first());
  await pointer.moveTo(page.locator('.home-side .home-card').first(), { ms: 900 });
  await hold(2600);
  unspot();

  mark('today');
  await pointer.key('3', '3', 400);
  await page.locator('.home-today').waitFor();
  await spot('.home-today > .home-card');
  await pointer.moveTo(page.locator('.home-plan').nth(1), { ms: 900 });
  await hold(2800);
  unspot();

  mark('inbox');
  await pointer.key('4', '4', 400);
  await page.locator('.home-inbox').waitFor();
  const fresh = page.locator('.home-inbox .home-card').first();
  await spot(fresh);
  await pointer.moveTo(fresh, { ms: 900 });
  await hold(2800);
  unspot();

  mark('collections');
  await pointer.key('5', '5', 400);
  await page.locator('.cb').waitFor();
  await spot('.cb-cols');
  await hold(2600);

  mark('collections-drag');
  const column = (name) => page.locator('.cb-col', { hasText: name }).first();
  const card = column('Reading group').locator('.cb-card', { hasText: 'Scaling Laws' });
  await spot(card);
  await pointer.moveTo(card, { ms: 900 });
  await hold(900);
  await spot(column('Transformers'));
  await page.mouse.down();
  await pointer.moveTo(column('Transformers').locator('.cb-col-head'), { dy: 4, ms: 1100 });
  await hold(300);
  await page.mouse.up();
  await hold(2600);
  unspot();

  mark('resume');
  await pointer.key('2', '2', 400);
  await page.locator('.home-continue').waitFor();
  await spot('.home-resume', { pad: 12 });
  await pointer.moveTo('.home-resume', { ms: 900 });
  await hold(2200);
  await pointer.click('.home-resume', { pause: 200 });
  unspot();
  await page.waitForSelector('.main[data-paper-id="scholar:attention"]', { timeout: 15000 });
  await page.waitForSelector('.pdf-book-page:not(.drawing) canvas', { timeout: 30000 });
  await pointer.moveTo({ x: 1536 * 0.55, y: 864 * 0.5 }, { ms: 900 });
  await hold(2200);

  mark('desk');
  await pointer.key('r', 'R', 400);
  await page.locator('.desk-scrim').waitFor();
  await hold(400);
  await spot('.desk-cards');
  await hold(2800);
  const pick = page.locator('.desk-card').nth(1);
  await spot(pick);
  await pointer.moveTo(pick, { ms: 1000, dy: 0.4 });
  await hold(2600);

  mark('desk-switch');
  await pointer.key('2', '2', 200);
  unspot();
  await page.waitForSelector('.main[data-paper-id="scholar:flash"]', { timeout: 15000 });
  await page.waitForSelector('.pdf-book-page:not(.drawing) canvas', { timeout: 30000 });
  await hold(2800);

  mark('go-home');
  await pointer.key('g', 'G', 400);
  await home.waitFor();
  await page.evaluate(() => document.activeElement?.blur());
  await spot('.home-back');
  await pointer.moveTo('.home-back', { ms: 900 });
  await hold(2600);

  mark('home-continue-flash');
  unspot();
  await pointer.key('2', '2', 400);
  await page.locator('.home-continue').waitFor();
  await spot(['.home-continue-head', '.home-peek .home-stop']);
  await pointer.moveTo('.home-peek .home-stop', { ms: 900, dx: 0.3 });
  await hold(3000);
  unspot();
}
