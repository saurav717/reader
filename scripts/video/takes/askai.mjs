/**
 * "Everything the Ask AI box can do", on the real "Attention Is All You
 * Need" in PDF: ⌘\ (Ctrl+\) opens the glass window over the page; the model
 * pill opens the picker (Claude, DeepSeek, Gemini); a "where" question is
 * answered with passages, the paper jumps to the first and a click shows the
 * second; a screenshot of the tab (📷) goes with a question about Figure 1,
 * and the answer draws page 3 back into the chat; DeepSeek with the Web
 * button on searches, reads a page and links its sources; a question about
 * what to read gives paper cards, added to the Reading list; New chat and
 * History; the window's four frames, and ⌘⇧→ throwing it at the right edge.
 *
 * The models are stand-ins inside the page (window.fetch for api.anthropic.com
 * and api.deepseek.com), streaming fixed answers at a reading pace; the
 * proxy's /health says the site's keys and the web are there, and its
 * /web/search and /web/page are answered here. The getDisplayMedia prompt is
 * stood in for by a canvas holding a real screenshot of the tab. Everything
 * else — the passages found and marked, the picker, the cards, the adding,
 * History, the window — is the app's own.
 */
import { setup as readSetup, openPaper, reflowReady, eagerFigures, shutDock, glideScroll } from './read.mjs';
import { json } from '../lib.mjs';

// ----------------------------------------------------------- the answers ---

const PASSAGES = [
  { quote: 'We call our particular attention "Scaled Dot-Product Attention"', label: 'Where scaled dot-product attention is defined', section: '3.2.1 Scaled Dot-Product Attention', page: 4, show: true },
  { quote: 'the dot products grow large in magnitude, pushing the softmax function into regions where it has extremely small gradients', label: 'Why the dot products are scaled', section: '3.2.1 Scaled Dot-Product Attention', page: 4 },
];
const WHERE = [
  'It is defined in **Section 3.2.1**: [each query is compared with every key by a dot product](passage:1), divided by $\\sqrt{d_k}$, and a softmax turns the scores into weights on the values — $\\mathrm{softmax}(QK^\\top/\\sqrt{d_k})\\,V$.',
  '',
  'The scaling is there because [for large key sizes the dot products grow large](passage:2), pushing the softmax into regions with tiny gradients; dividing by $\\sqrt{d_k}$ keeps them in range.',
  '',
  '```passages',
  ...PASSAGES.map((p) => JSON.stringify(p)),
  '```',
].join('\n');

const FIGURE = [
  '**Figure 1** is the whole Transformer: the **encoder** on the left, the **decoder** on the right, each a stack of N = 6 identical layers.',
  '',
  '- An encoder layer is multi-head self-attention, then a feed-forward network, each wrapped in a residual connection and layer norm (*Add & Norm*).',
  '- A decoder layer adds attention over the encoder’s output, and masks its own self-attention so no position sees the ones after it.',
  '- Positional encodings are added to the embeddings at the bottom, since nothing else tells it word order.',
  '',
  '![Figure 1: The Transformer, model architecture](figure:1)',
].join('\n');

const WEB = [
  'Two schemes have largely taken over:',
  '',
  '- **Rotary embeddings (RoPE)** rotate each query and key by an angle set by its position, so attention depends on relative distance. From [RoFormer (Su et al., 2021)](https://arxiv.org/abs/2104.09864); LLaMA and most open models since use it.',
  '- **ALiBi** drops position embeddings and subtracts a penalty growing with distance from the attention scores, so models handle longer inputs than they trained on ([Press et al., 2021](https://arxiv.org/abs/2108.12409)).',
  '',
  'The paper itself (§3.5) found learned and sinusoidal encodings nearly identical, and kept sinusoids in the hope they would extrapolate to longer sequences.',
].join('\n');

const PAPERS = [
  { title: 'Neural Machine Translation by Jointly Learning to Align and Translate', authors: 'Bahdanau et al.', year: 2015, why: 'Attention added to an RNN translator — the paper’s reference [2]' },
  { title: 'Effective Approaches to Attention-based Neural Machine Translation', authors: 'Luong et al.', year: 2015, why: 'Dot-product attention, the form this paper scales' },
  { title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding', authors: 'Devlin et al.', year: 2019, why: 'The encoder alone, pre-trained on unlabelled text' },
  { title: 'An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale', authors: 'Dosovitskiy et al.', year: 2021, why: 'The same encoder, run on patches of an image' },
];
const READ = [
  '**Before it** — the attention it builds on:',
  '',
  `- [Bahdanau et al. 2015](paper:${PAPERS[0].title}) — attention added to an RNN encoder–decoder.`,
  `- [Luong et al. 2015](paper:${PAPERS[1].title}) — dot-product attention, the form scaled here.`,
  '',
  '**After it** — where the Transformer went:',
  '',
  `- [Devlin et al. 2019](paper:${PAPERS[2].title}) — BERT, the encoder pre-trained.`,
  `- [Dosovitskiy et al. 2021](paper:${PAPERS[3].title}) — ViT, the encoder on image patches.`,
  '',
  '```papers',
  ...PAPERS.map((p) => JSON.stringify(p)),
  '```',
].join('\n');

const QUESTIONS = {
  where: 'Where do they define scaled dot-product attention, and why scale it?',
  figure: 'What does this figure show?',
  web: 'What has replaced their sinusoidal position encoding?',
  read: 'What should I read before and after this?',
};

const SEARCH_RESULTS = [
  ['RoFormer: Enhanced Transformer with Rotary Position Embedding', 'https://arxiv.org/abs/2104.09864', 'We propose a novel method named Rotary Position Embedding (RoPE) to effectively leverage the positional information…'],
  ['Train Short, Test Long: Attention with Linear Biases Enables Input Length Extrapolation', 'https://arxiv.org/abs/2108.12409', 'ALiBi does not add positional embeddings to word embeddings; instead, it biases query-key attention scores with a penalty…'],
  ['Rotary Embeddings: A Relative Revolution', 'https://blog.eleuther.ai/rotary-embeddings/', 'Rotary Positional Embedding (RoPE) is a new type of position encoding that unifies absolute and relative approaches…'],
  ['LLaMA: Open and Efficient Foundation Language Models', 'https://arxiv.org/abs/2302.13971', 'We remove the absolute positional embeddings, and instead, add rotary positional embeddings (RoPE)…'],
  ['Self-Attention with Relative Position Representations', 'https://arxiv.org/abs/1803.02155', 'We present an alternative approach, extending the self-attention mechanism to efficiently consider representations of the relative positions…'],
  ['A Length-Extrapolatable Transformer', 'https://arxiv.org/abs/2212.10554', 'Position modeling plays a critical role in Transformers…'],
  ['Transformer Language Models without Positional Encodings Still Learn Positional Information', 'https://arxiv.org/abs/2203.16634', 'Causal transformer language models without any explicit positional encoding are still competitive…'],
  ['Positional encoding — Transformers explained', 'https://huggingface.co/blog/designing-positional-encoding', 'From sinusoidal to RoPE: how position encodings evolved…'],
].map(([title, url, snippet]) => ({ title, url, snippet }));

// ------------------------------------------------------------- stand-ins ---

/** Inside the page: the models, answering at a reading pace; and a screen to capture. */
function standIns({ answers, questions }) {
  try {
    localStorage.setItem('reader.anthropic-key', 'sk-ant-video-stand-in');
    localStorage.setItem('reader.deepseek-key', 'sk-video-stand-in');
  } catch {}
  const enc = new TextEncoder();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Words, a few at a time: what a model streams. */
  const pieces = (text) => text.match(/(?:\S+\s*){1,3}|\s+/g) || [];
  const stream = (produce) =>
    new Response(
      new ReadableStream({
        async start(controller) {
          await produce((s) => controller.enqueue(enc.encode(s)));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  const textOf = (content) => (typeof content === 'string' ? content : (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
  const pick = (question) => {
    for (const [key, q] of Object.entries(questions)) if (question.includes(q)) return key;
    return 'where';
  };
  const PACE = 85;

  const claude = (body) =>
    stream(async (send) => {
      const ev = (type, data) => send(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      const answer = answers[pick(textOf(body.messages.at(-1).content))];
      await wait(900);
      ev('message_start', { message: { id: 'msg_v', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      // The fenced blocks the app never prints come in one go.
      const at = answer.search(/\n```(passages|papers)/);
      const prose = at >= 0 ? answer.slice(0, at) : answer;
      for (const piece of pieces(prose)) {
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: piece } });
        await wait(PACE);
      }
      if (at >= 0) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer.slice(at) } });
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 200 } });
      ev('message_stop', {});
    });

  const deepseek = (body) =>
    stream(async (send) => {
      const chunk = (delta, finish = null) => send(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      const users = body.messages.filter((m) => m.role === 'user');
      const key = pick(textOf(users.at(-1)?.content));
      const after = body.messages.slice(body.messages.lastIndexOf(users.at(-1)) + 1);
      const tools = after.filter((m) => m.role === 'tool').length;
      const think = async (text) => {
        chunk({ reasoning_content: text });
        await wait(300);
      };
      await wait(600);
      chunk({ role: 'assistant', content: null });
      if (key === 'web' && tools === 0) {
        await think('The paper uses sinusoidal encodings (§3.5). What came after is not in it — search.');
        chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '' } }] });
        chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ query: 'positional encoding after sinusoidal RoPE ALiBi' }) } }] }, 'tool_calls');
        send('data: [DONE]\n\n');
        return;
      }
      if (key === 'web' && tools === 1) {
        await think('RoFormer is the source for RoPE; read it to be sure of the claim.');
        chunk({ tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { name: 'read_page', arguments: '' } }] });
        chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ url: 'https://arxiv.org/abs/2104.09864' }) } }] }, 'tool_calls');
        send('data: [DONE]\n\n');
        return;
      }
      await think(key === 'read' ? 'Prior attention work it cites, then the two best-known descendants.' : 'Enough to answer: RoPE and ALiBi, with links.');
      const answer = answers[key];
      const at = answer.search(/\n```(passages|papers)/);
      const prose = at >= 0 ? answer.slice(0, at) : answer;
      for (const piece of pieces(prose)) {
        chunk({ content: piece });
        await wait(PACE);
      }
      if (at >= 0) chunk({ content: answer.slice(at) });
      chunk({ content: '' }, 'stop');
      send('data: [DONE]\n\n');
    });

  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://api.anthropic.com')) {
      if ((init?.method || 'GET') === 'OPTIONS') return new Response(null, { status: 204 });
      return claude(JSON.parse(init?.body ?? (await input.text?.()) ?? '{}'));
    }
    if (url.startsWith('https://api.deepseek.com')) return deepseek(JSON.parse(init?.body ?? '{}'));
    return real(input, init);
  };

  // The browser's "share this tab?" prompt, answered yes: a canvas holding a real screenshot of the tab.
  if (navigator.mediaDevices) {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const data = window.__videoShot ? await window.__videoShot() : '';
      const image = new Image();
      image.src = `data:image/jpeg;base64,${data}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      const draw = () => context.drawImage(image, 0, 0);
      draw();
      const timer = setInterval(draw, 50);
      const captured = canvas.captureStream(20);
      captured.getTracks().forEach((track) => track.addEventListener('ended', () => clearInterval(timer)));
      const stop = captured.getTracks()[0].stop.bind(captured.getTracks()[0]);
      captured.getTracks()[0].stop = () => {
        clearInterval(timer);
        stop();
      };
      return captured;
    };
  }
}

export async function setup(context) {
  await readSetup(context);
  await eagerFigures(context);
  // The proxy, as one with the site's keys and a search key.
  await context.route('**/api/health', async (route) => {
    const response = await route.fetch();
    const body = await response.json().catch(() => ({ ok: true }));
    route.fulfill(json({ ...body, ok: true, auth: false, gemini: true, ai: { anthropic: true, deepseek: true, gemini: true }, web: true }));
  });
  await context.route('**/api/web/search*', async (route) => {
    await new Promise((r) => setTimeout(r, 900));
    route.fulfill(json({ results: SEARCH_RESULTS }));
  });
  await context.route('**/api/web/page*', async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    route.fulfill(
      json({
        url: 'https://arxiv.org/abs/2104.09864',
        title: 'RoFormer: Enhanced Transformer with Rotary Position Embedding',
        text: 'RoFormer: Enhanced Transformer with Rotary Position Embedding. Jianlin Su, Yu Lu, Shengfeng Pan, Ahmed Murtadha, Bo Wen, Yunfeng Liu. Position encoding recently has shown effective in the transformer architecture. … we propose a novel method named Rotary Position Embedding (RoPE) … RoPE encodes the absolute position with a rotation matrix and meanwhile incorporates the explicit relative position dependency in self-attention formulation.',
      }),
    );
  });
  // A paper named in an answer, found by its title, as OpenAlex would.
  await context.route(/api\.openalex\.org\/works\?.*\bsearch=/, (route) => {
    const title = new URL(route.request().url()).searchParams.get('search') || '';
    const paper = PAPERS.find((p) => p.title.toLowerCase() === title.toLowerCase());
    if (!paper) return route.fulfill(json({ results: [] }));
    const n = PAPERS.indexOf(paper);
    route.fulfill(
      json({
        results: [
          {
            id: `https://openalex.org/W7${n}`,
            doi: null,
            display_name: paper.title,
            title: paper.title,
            publication_date: `${paper.year}-01-01`,
            publication_year: paper.year,
            abstract_inverted_index: null,
            authorships: [{ author: { display_name: paper.authors.replace(' et al.', '') } }],
            primary_location: { pdf_url: null, landing_page_url: `https://openalex.org/W7${n}`, source: { display_name: 'arXiv' } },
            concepts: [],
          },
        ],
      }),
    );
  });
  await context.addInitScript(standIns, { answers: { where: WHERE, figure: FIGURE, web: WEB, read: READ }, questions: QUESTIONS });
}

export async function prepare({ page, arrive }) {
  // The screenshot the stand-in prompt hands back: the tab as it is at that moment.
  await page.exposeFunction('__videoShot', async () => (await page.screenshot({ type: 'jpeg', quality: 80, scale: 'css' })).toString('base64'));
  await page.addInitScript(() => {
    try {
      localStorage.removeItem('reader.assistant.window');
      localStorage.removeItem('reader.assistant.history.v1');
      localStorage.setItem('reader.assistant.v1', JSON.stringify({ model: 'claude-opus-5' }));
    } catch {}
  });
  await openPaper(page, arrive, { mode: 'reflow' });
  await shutDock(page);
  await reflowReady(page);
  await page.mouse.move(768, 500);
  await page.waitForTimeout(1000);
}

// -------------------------------------------------------------- the take ---

export default async function ({ page, pointer, mark, spot, unspot }) {
  const hold = (ms) => page.waitForTimeout(ms);
  const win = page.locator('.assistant-win');
  const box = page.getByRole('textbox', { name: 'Ask AI' });
  const lastAnswer = page.locator('.chat-claude').last();
  const answered = async () => {
    log('waiting');
    await page.waitForSelector('.chat-claude:not(.is-streaming)', { timeout: 30000 });
    await page.waitForFunction(() => !document.querySelector('.chat-claude.is-streaming'), null, { timeout: 60000 });
    log('answered');
  };
  const T0 = Date.now();
  const log = (what) => console.log(`        ${((Date.now() - T0) / 1000).toFixed(1)} ${what}`);
  const ask = async (question) => {
    await pointer.click(box, { pause: 250 });
    // Typed a few letters at a time (one call each), so the box fills at a typist's pace even under load.
    for (const bit of question.match(/.{1,3}/g)) {
      await page.keyboard.insertText(bit);
      await hold(28);
    }
    await hold(300);
    log('typed');
    await pointer.key('Enter', '↵', 200);
  };

  mark('paper');
  await pointer.moveTo({ x: 760, y: 470 });
  await hold(1000);

  mark('open');
  await pointer.key('Control+Backslash', 'Ctrl \\', 500);
  await win.waitFor();
  await spot(win);
  await hold(2000);

  mark('models');
  await pointer.click(page.locator('.assistant-win .model-chip'), { pause: 500 });
  await spot(page.locator('.model-menu'));
  await pointer.moveTo(page.locator('.rw-group.p-deepseek'), { ms: 600 });
  await hold(300);
  await pointer.moveTo(page.locator('.rw-group.p-gemini'), { ms: 500 });
  await hold(700);
  await pointer.click(page.locator('.rw-model.is-current'), { pause: 400 });

  mark('ask-where');
  await spot(page.locator('.chat-compose'));
  await ask(QUESTIONS.where);
  await spot(win);
  await answered();
  await page.waitForSelector('.passage-band', { timeout: 15000 });
  await hold(700);
  mark('passage-shown');
  await spot([page.locator('.passage-band').first(), page.locator('.passage-tag')]);
  await hold(2600);
  await spot(page.locator('.chat-passages'));
  await pointer.moveTo(page.locator('.chat-passage-row').nth(1));
  await hold(700);
  mark('passage-2');
  await pointer.click(page.locator('.chat-passage-row').nth(1), { pause: 300 });
  await page.waitForSelector('.passage-tag', { timeout: 8000 });
  await hold(500);
  await spot([page.locator('.passage-band').first(), page.locator('.passage-tag'), page.locator('.chat-passage-row').nth(1)]);
  await hold(2700);

  mark('figure');
  unspot();
  // Back up to Figure 1, the paper's own scroll, eased.
  await pointer.moveTo({ x: 600, y: 480 });
  await page.evaluate(() => {
    const figure = [...document.querySelectorAll('.paper-body figure')].find((f) => /^Figure 1\b/.test(f.querySelector('figcaption')?.textContent || ''));
    const scroller = figure.closest('.reader-scroll');
    scroller.scrollBy({ top: figure.getBoundingClientRect().top - 140, behavior: 'smooth' });
  });
  await hold(1300);
  await spot(page.locator('.chat-shot-btn'), { pad: 12 });
  await pointer.click(page.locator('.chat-shot-btn'), { pause: 300 });
  await page.waitForSelector('.chat-shot', { timeout: 10000 });
  await spot(page.locator('.chat-shot'));
  await hold(1700);
  await ask(QUESTIONS.figure);
  await spot(win);
  await answered();
  await hold(400);
  await lastAnswer.locator('img.chat-figure').first().scrollIntoViewIfNeeded().catch(() => undefined);
  await spot(lastAnswer);
  await hold(3000);

  mark('model-switch');
  await pointer.click(page.locator('.assistant-win .model-chip'), { pause: 400 });
  await spot(page.locator('.model-menu'));
  const flash = page.locator('.rw-model:has(.rw-name:text-is("V4.1 Flash"))');
  await pointer.moveTo(flash);
  await hold(700);
  await pointer.click(flash, { pause: 400 });
  await spot(page.locator('.assistant-win .model-chip'), { pad: 10 });
  await hold(900);

  mark('web');
  await spot(page.locator('.chat-web-btn'), { pad: 12 });
  await pointer.click(page.locator('.chat-web-btn'), { pause: 700 });
  await ask(QUESTIONS.web);
  await page.waitForSelector('.chat-steps', { timeout: 15000 });
  await spot(page.locator('.chat-claude').last());
  await answered();
  await hold(400);
  await spot(lastAnswer);
  await hold(2800);

  mark('read-next');
  await ask(QUESTIONS.read);
  await spot(win);
  await answered();
  await hold(600);
  await page.locator('.chat-reading').last().scrollIntoViewIfNeeded();
  await spot(lastAnswer);
  await hold(1700);
  const addAll = page.getByRole('button', { name: 'Add all to Reading list' }).last();
  await spot(page.locator('.chat-reading').last());
  await pointer.click(addAll, { pause: 300 });
  await page.waitForFunction(() => /All in Reading list/.test(document.querySelector('.chat-claude:last-of-type .chat-reading summary')?.textContent || [...document.querySelectorAll('.chat-reading summary')].pop()?.textContent || ''), null, { timeout: 15000 });
  await spot([page.locator('.chat-reading').last(), ...[0, 1, 2, 3].map((i) => lastAnswer.locator('.chat-card').nth(i))]);
  await hold(2200);

  mark('history');
  await spot(page.locator('.chat-toolbar'));
  await pointer.click(page.getByRole('button', { name: 'New chat' }), { pause: 400 });
  await spot(win);
  await hold(800);
  await pointer.click(page.getByRole('button', { name: /^History/ }), { pause: 500 });
  await spot(page.locator('.chat-drawer'));
  await hold(1600);
  await pointer.click(page.locator('.chat-hist-open').first(), { pause: 300 });
  await spot(win);
  await hold(700);

  mark('looks');
  const style = page.locator('.win-style');
  await spot(win);
  for (let i = 0; i < 3; i += 1) {
    await pointer.click(style, { pause: 950 });
  }

  mark('dock');
  unspot();
  await pointer.click(page.locator('.chat-body'), { dx: 0.5, dy: 0.05, pause: 200 });
  await pointer.key('Control+Shift+ArrowRight', 'Ctrl ⇧ →', 800);
  await pointer.key('Control+Shift+ArrowRight', 'Ctrl ⇧ →', 900);
  await spot(win);
  await hold(1900);
  unspot();
  await pointer.key('Control+Backslash', 'Ctrl \\', 600);
  mark('closed');
  await hold(1000);
}
