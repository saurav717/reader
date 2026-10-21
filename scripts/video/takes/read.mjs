/**
 * "Reading, your way": the real "Attention Is All You Need", opened on its
 * PDF; Reflow (made off camera first, so it comes up whole); the reflowed
 * text as a book of two pages, and back to one; the PDF again, the loupe
 * (L) over Figure 1 and the close-up (C); zen mode (Z) and back.
 *
 * Exports `setup` and `openPaper` for annotate.mjs, which reads the same paper.
 */
import { attentionPdf, json, BASE } from '../lib.mjs';

export const TITLE = 'Attention Is All You Need';
export const PAPER_ID = 'arxiv:1706.03762';
const AUTHORS = ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar', 'Jakob Uszkoreit', 'Llion Jones', 'Aidan N. Gomez', 'Lukasz Kaiser', 'Illia Polosukhin'];

const ago = (hours) => new Date(Date.now() - hours * 3600 * 1000).toISOString();
const PAPER = {
  id: PAPER_ID,
  source: 'arxiv',
  arxivId: '1706.03762',
  title: TITLE,
  authors: AUTHORS,
  abstract:
    'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. The best performing models also connect the encoder and decoder through an attention mechanism. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.',
  published: '2017-06-12',
  categories: ['cs.CL', 'cs.LG'],
  pdfUrl: 'https://arxiv.org/pdf/1706.03762',
  landingUrl: 'https://arxiv.org/abs/1706.03762',
  addedAt: ago(240),
  collectionIds: ['c-reading'],
  tags: [],
  progress: 0,
  lastOpenedAt: ago(2),
};

// ------------------------------------------------------------ stand-ins ---

const INSTITUTIONS = ['Google Brain', 'Google Brain', 'Google Research', 'Google Research', 'Google Research', 'University of Toronto', 'Google Brain', 'Google Research'];
const WORK = {
  id: 'https://openalex.org/W2963403868',
  title: TITLE,
  display_name: TITLE,
  publication_year: 2017,
  topics: [{ display_name: 'Natural Language Processing Techniques', field: { display_name: 'Computer Science' } }],
  authorships: AUTHORS.map((name, i) => ({
    author: { id: `https://openalex.org/A${i + 1}`, display_name: name },
    institutions: [{ display_name: INSTITUTIONS[i] }],
  })),
};
const PEOPLE = {
  A1: { name: 'Ashish Vaswani', now: 'Essential AI', works: 41, cited: 182400, h: 24, i10: 30, topics: ['Natural Language Processing Techniques', 'Topic Modeling', 'Machine translation'] },
  A2: { name: 'Noam Shazeer', now: 'Google DeepMind', works: 58, cited: 201300, h: 38, i10: 52, topics: ['Natural Language Processing Techniques', 'Mixture of experts', 'Large language models'] },
  A3: { name: 'Niki Parmar', now: 'Essential AI', works: 27, cited: 170900, h: 19, i10: 21, topics: ['Natural Language Processing Techniques', 'Image generation'] },
};
const work = (id, title, year, cites, author, venue) => ({
  id: `https://openalex.org/${id}`,
  doi: null,
  display_name: title,
  title,
  publication_date: `${year}-06-01`,
  publication_year: year,
  abstract_inverted_index: null,
  authorships: [{ author: { display_name: author } }],
  primary_location: { pdf_url: null, landing_page_url: `https://openalex.org/${id}`, source: { display_name: venue } },
  concepts: [],
  cited_by_count: cites,
  primary_topic: { display_name: 'Natural Language Processing Techniques', field: { display_name: 'Computer Science' } },
});
const TOP_WORKS = {
  A1: [work('W11', TITLE, 2017, 152000, 'Ashish Vaswani', 'NeurIPS'), work('W12', 'Self-Attention with Relative Position Representations', 2018, 2900, 'Peter Shaw', 'NAACL'), work('W13', 'Image Transformer', 2018, 2100, 'Niki Parmar', 'ICML')],
  A2: [work('W11', TITLE, 2017, 152000, 'Ashish Vaswani', 'NeurIPS'), work('W21', 'Exploring the Limits of Transfer Learning with a Unified Text-to-Text Transformer', 2020, 19800, 'Colin Raffel', 'JMLR'), work('W22', 'Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer', 2017, 3900, 'Noam Shazeer', 'ICLR')],
  A3: [work('W11', TITLE, 2017, 152000, 'Ashish Vaswani', 'NeurIPS'), work('W13', 'Image Transformer', 2018, 2100, 'Niki Parmar', 'ICML')],
};
/** A cited work, as OpenAlex would know it: the title read off the entry, given back. */
const CITES = [40100, 28700, 12900, 9800, 7600, 5400, 3300, 2200];
const KNOWN = {
  'long short-term memory': ['Long Short-Term Memory', 1997, 98400, 'Sepp Hochreiter', 'Neural Computation'],
  'neural machine translation by jointly learning to align and translate': ['Neural Machine Translation by Jointly Learning to Align and Translate', 2015, 31200, 'Dzmitry Bahdanau', 'ICLR'],
  'deep residual learning for image recognition': ['Deep Residual Learning for Image Recognition', 2016, 245000, 'Kaiming He', 'CVPR'],
};
const citedWork = (title) => {
  const known = KNOWN[title.toLowerCase().replace(/[.\s]+$/, '')];
  if (known) return { ...work(`W8${known[1]}`, ...known), abstract_inverted_index: { A: [0], model: [1], 'for': [2], sequences: [3] } };
  const n = [...title].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return { ...work(`W9${n}`, title, 2014 + (n % 3), CITES[n % CITES.length], 'Someone Else', ['NeurIPS', 'ICLR', 'EMNLP', 'ACL'][n % 4]), abstract_inverted_index: { A: [0], model: [1], 'for': [2], sequences: [3] } };
};
const LINEAGE_EARLY = [
  work('W31', 'Long Short-Term Memory-Networks for Machine Reading', 2016, 1300, 'Jianpeng Cheng', 'EMNLP'),
  work('W32', 'A Decomposable Attention Model for Natural Language Inference', 2016, 1800, 'Ankur P. Parikh', 'EMNLP'),
  work('W33', 'A Structured Self-attentive Sentence Embedding', 2017, 2400, 'Zhouhan Lin', 'ICLR'),
];
const LINEAGE_CITED = [
  work('W11', TITLE, 2017, 152000, 'Ashish Vaswani', 'NeurIPS'),
  work('W34', 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding', 2019, 98000, 'Jacob Devlin', 'NAACL'),
  work('W35', 'An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale', 2021, 41000, 'Alexey Dosovitskiy', 'ICLR'),
];

const DICTIONARY = {
  'self-attention': {
    pos: 'Noun',
    defs: [
      ['(machine learning) An attention mechanism relating different positions of a single sequence in order to compute a representation of that sequence.', 'Each layer of the encoder applies self-attention over the whole input.'],
    ],
  },
  attention: {
    pos: 'Noun',
    defs: [
      ['Mental focus; the act of concentrating on something.', 'Pay attention to the road.'],
      ['(machine learning) A mechanism that weights parts of an input by their relevance to a query.', ''],
    ],
  },
};
const WIKI = {
  title: 'Attention (machine learning)',
  key: 'Attention_(machine_learning)',
  description: 'Machine learning technique',
  extract:
    'In machine learning, attention is a method that determines the importance of each component in a sequence relative to the other components in that sequence. Self-attention, in which a sequence attends to itself, is the core of the Transformer architecture introduced in 2017.',
};

/** Routes for everything the paper's page asks outside the machine. */
export async function setup(context) {
  const PDF = await attentionPdf();
  const pdf = (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF });
  await context.route('**/pdf?*', pdf);
  await context.route('**/arxiv/pdf*', pdf);
  // No HTML rendering: Reflow is read out of the PDF itself.
  await context.route('**/api/arxiv/html*', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"none"}' }));
  const ATOM = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/1706.03762v7</id><published>2017-06-12T17:57:34Z</published><title>${TITLE}</title><summary>${PAPER.abstract}</summary>${AUTHORS.map((a) => `<author><name>${a}</name></author>`).join('')}<link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/><category term="cs.CL"/></entry></feed>`;
  await context.route('**/api/arxiv/query*', (route) => route.fulfill({ status: 200, contentType: 'application/atom+xml', body: ATOM }));
  for (const host of ['api.crossref.org', 'api.semanticscholar.org', 'dblp.org', 'wikidata.org', 'www.wikidata.org', 'api.unpaywall.org']) {
    await context.route(`**/${host}/**`, (route) => route.fulfill(json('{"results":[],"data":[],"message":{"items":[]},"result":{"hits":{}}}')));
  }
  await context.route('**/openlibrary.org/**', (route) => route.fulfill(json({ docs: [] })));
  await context.route('**/scholar/**', (route) => route.fulfill(json({ results: [] })));

  // The dictionaries and Wikipedia, for the lookup card.
  await context.route('**/en.wiktionary.org/api/rest_v1/page/definition/**', (route) => {
    const term = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop()).replace(/_/g, ' ').toLowerCase();
    const entry = DICTIONARY[term];
    if (!entry) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    return route.fulfill(json({ en: [{ partOfSpeech: entry.pos, language: 'English', definitions: entry.defs.map(([definition, example]) => ({ definition, examples: example ? [example] : [] })) }] }));
  });
  await context.route('**/api.dictionaryapi.dev/**', (route) => {
    const term = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop()).toLowerCase();
    if (!DICTIONARY[term]) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    return route.fulfill(json([{ word: term, phonetic: term === 'attention' ? '/əˈtɛnʃən/' : '/ˌsɛlf əˈtɛnʃən/', meanings: [], sourceUrls: [] }]));
  });
  await context.route('**/en.wikipedia.org/w/rest.php/**', (route) => route.fulfill(json({ pages: [{ key: WIKI.key, title: WIKI.title, description: WIKI.description }] })));
  await context.route('**/en.wikipedia.org/api/rest_v1/**', (route) => {
    if (route.request().url().includes(WIKI.key) || route.request().url().includes(encodeURIComponent(WIKI.key))) {
      return route.fulfill(json({ extract: WIKI.extract, content_urls: { desktop: { page: `https://en.wikipedia.org/wiki/${WIKI.key}` } } }));
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });

  // OpenAlex: the paper's own record and its people, the works it cites, and the lineage of a phrase.
  await context.route('**/api.openalex.org/**', (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    const filter = url.searchParams.get('filter') || '';
    if (path.startsWith('/works/doi:')) return route.fulfill(path.toLowerCase().includes('1706.03762') ? json(WORK) : { status: 404, contentType: 'application/json', body: '{}' });
    const person = /^\/authors\/(A\d+)$/.exec(path);
    if (person) {
      const p = PEOPLE[person[1]] || { name: WORK.authorships[Number(person[1].slice(1)) - 1]?.author.display_name || 'Someone', now: 'Google', works: 20, cited: 150000, h: 15, i10: 18, topics: ['Natural Language Processing Techniques'] };
      return route.fulfill(
        json({
          id: `https://openalex.org/${person[1]}`,
          display_name: p.name,
          orcid: null,
          works_count: p.works,
          cited_by_count: p.cited,
          summary_stats: { h_index: p.h, i10_index: p.i10 },
          last_known_institutions: [{ display_name: p.now }],
          topics: p.topics.map((display_name) => ({ display_name, count: 10, field: { display_name: 'Computer Science' } })),
        }),
      );
    }
    if (path === '/works') {
      if (url.searchParams.has('group_by')) return route.fulfill(json({ group_by: [2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022].map((y) => ({ key: String(y), count: 3 })) }));
      const byAuthor = /^author\.id:(A\d+)/.exec(filter);
      if (byAuthor) return route.fulfill(json({ results: TOP_WORKS[byAuthor[1]] || TOP_WORKS.A1 }));
      if (filter.startsWith('title_and_abstract.search:')) {
        const sort = url.searchParams.get('sort') || '';
        return route.fulfill(json({ results: sort.startsWith('publication_date') ? LINEAGE_EARLY : LINEAGE_CITED }));
      }
      const title = /^title\.search:(.+)$/.exec(filter);
      if (title) {
        if (title[1].toLowerCase().includes('attention is all you need')) return route.fulfill(json({ results: [WORK] }));
        return route.fulfill(json({ results: [citedWork(title[1].trim())] }));
      }
    }
    return route.fulfill(json({ results: [] }));
  });
}

/** Puts the paper in the library and opens it, on its PDF (off camera). */
export async function openPaper(page, arrive, { mode = 'pdf', settings = {} } = {}) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(async ({ paper }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('reader', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = (store, fn) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, 'readwrite');
        fn(t.objectStore(store));
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      });
    for (const store of ['papers', 'collections', 'highlights']) await tx(store, (s) => s.clear());
    await tx('collections', (s) => s.put({ id: 'c-reading', name: 'Reading list', color: '#2f7d6d', createdAt: new Date().toISOString() }));
    await tx('papers', (s) => s.put(paper));
    db.close();
  }, { paper: PAPER });
  await arrive({ settings: { readingMode: mode, ...settings }, path: `/paper/?id=${encodeURIComponent(PAPER_ID)}` });
  await page.waitForSelector(`.main[data-paper-id="${PAPER_ID}"]`, { timeout: 20000 });
}

/** Reflow, made whole: the text, every figure painted, nothing still loading. */
export async function reflowReady(page, timeout = 120000) {
  await page.waitForSelector('.paper-body h2', { timeout });
  await page.waitForFunction(
    () =>
      !document.querySelector('.paper-body.is-waiting') &&
      !document.querySelector('.reader-column .spinner, .reader .spinner') &&
      Array.from(document.querySelectorAll('.paper-body img')).every((image) => image.complete && image.naturalWidth > 0),
    null,
    { timeout },
  );
}

export async function pdfReady(page, timeout = 60000) {
  await page.waitForSelector('.pdf-book-page:not(.drawing) canvas', { timeout });
  await page.waitForFunction(() => !document.querySelector('.pdf-book-page.drawing'), null, { timeout }).catch(() => undefined);
}

/** Reflowed figures are lazy images; drawn up front, they never pop in on camera. */
export async function eagerFigures(context) {
  await context.addInitScript(() => {
    const eager = () => document.querySelectorAll('.paper-body img[loading="lazy"]').forEach((image) => (image.loading = 'eager'));
    new MutationObserver(eager).observe(document, { childList: true, subtree: true });
  });
}

/** The Discover / notes dock shut, so the page has the room. */
export async function shutDock(page) {
  await page.waitForTimeout(800);
  for (let tries = 0; tries < 4 && (await page.locator('.dock').count()); tries += 1) {
    const close = page.locator('.dock').getByRole('button', { name: /^Close the (discover|highlights) panel/ }).first();
    await close.click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(600);
  }
}

/** Reflow made once off camera, then back to the PDF at its top. */
export async function warmReflow(page) {
  await pdfReady(page);
  await page.locator('.segmented button', { hasText: 'Reflow' }).click();
  await reflowReady(page);
  await page.locator('.segmented button', { hasText: 'PDF' }).click();
  await pdfReady(page);
  await page.waitForTimeout(800);
}

/** A smooth scroll of whatever is under the pointer, in small wheel steps. */
export async function glideScroll(page, dy, { steps = 24, ms = 1400 } = {}) {
  for (let i = 0; i < steps; i += 1) {
    await page.mouse.wheel(0, dy / steps);
    await page.waitForTimeout(ms / steps);
  }
}

// ------------------------------------------------------------- the take ---

export async function prepare({ page, arrive }) {
  await eagerFigures(page.context());
  await openPaper(page, arrive, { mode: 'pdf' });
  await shutDock(page);
  await warmReflow(page);
  await page.mouse.move(768, 500);
}

export default async function ({ page, pointer, mark }) {
  const hold = (ms) => page.waitForTimeout(ms);
  const segment = (name) => page.locator('.reader-head .segmented button', { hasText: name }).first();

  mark('pdf');
  await pointer.moveTo({ x: 820, y: 520 });
  await hold(1500);
  await glideScroll(page, 420);
  await hold(1600);

  mark('reflow');
  await pointer.click(segment('Reflow'), { pause: 300 });
  await reflowReady(page, 20000);
  await hold(2200);
  await pointer.moveTo({ x: 760, y: 560 });
  await glideScroll(page, 520);
  await hold(2500);

  mark('book');
  await pointer.click(page.getByRole('button', { name: /Read as a book/ }), { pause: 400 });
  await page.waitForSelector('.book-pages');
  await hold(2600);
  await pointer.click(page.getByRole('button', { name: 'Next page' }), { pause: 1600 });
  await pointer.key('ArrowRight', '→', 2200);

  mark('one-page');
  await pointer.click(page.getByRole('button', { name: /Read as one scrolling page/ }), { pause: 400 });
  await page.waitForSelector('.reader-scroll');
  await hold(2500);

  mark('pdf-again');
  await pointer.click(segment('PDF'), { pause: 400 });
  await pdfReady(page);
  await hold(1200);
  // On to page 3, where Figure 1 is.
  await pointer.moveTo({ x: 800, y: 500 });
  const slot = page.locator('.pdf-scroll-slot[data-slot="3"]');
  const toPage3 = async () => {
    for (let i = 0; i < 12; i += 1) {
      const top = await slot.evaluate((el) => el.getBoundingClientRect().top);
      if (Math.abs(top - 130) < 30) break;
      await glideScroll(page, Math.max(-900, Math.min(900, top - 130)), { steps: 18, ms: 700 });
    }
    await pdfReady(page);
  };
  await toPage3();
  await hold(1500);

  mark('zoom');
  const fig = page.locator('.pdf-book-page[data-page="3"]');
  let box = await fig.boundingBox();
  await pointer.moveTo({ x: box.x + box.width * 0.55, y: 420 });
  await pointer.key('+', '+', 700);
  await pointer.key('+', '+', 700);
  await pdfReady(page);
  await hold(2000);
  await pointer.key('0', '0', 900);
  await pdfReady(page);
  await toPage3();
  await hold(600);
  box = await fig.boundingBox();
  const figY = (f) => Math.max(260, Math.min(box.y + box.height * f, 640));

  mark('loupe');
  await pointer.key('l', 'L', 400);
  await pointer.moveTo({ x: box.x + box.width * 0.4, y: figY(0.35) }, { ms: 900 });
  await hold(1200);
  await pointer.moveTo({ x: box.x + box.width * 0.6, y: figY(0.25) }, { ms: 1600 });
  await hold(1400);
  await pointer.key('l', 'L', 800);

  mark('closeup');
  await pointer.moveTo({ x: box.x + box.width * 0.5, y: figY(0.3) });
  await pointer.key('c', 'C', 300);
  await page.waitForSelector('.pdf-closeup-card.is-drawn', { timeout: 30000 });
  await hold(4200);
  await pointer.key('Escape', 'Esc', 1200);

  mark('zen');
  await pointer.moveTo({ x: 768, y: 480 });
  await pointer.key('z', 'Z', 600);
  await hold(2600);
  await glideScroll(page, 500);
  await hold(1800);
  await pointer.key('z', 'Z', 600);
  mark('zen-off');
  await hold(2500);
}
