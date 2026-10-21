/**
 * "Mark it, look it up, keep it": the real "Attention Is All You Need",
 * reflowed. A sentence of the abstract is selected and highlighted; a
 * right-click on "Self-attention" opens the lookup card — what it means,
 * where it comes from, and a comment typed into it; an author's name and
 * a citation each bring up their hover card; Figure 1 is kept in the
 * notes; H opens the notes, B the Board; and on the PDF, M pins a sticky.
 * The routes, the paper and its stand-ins are read.mjs's.
 */
import { setup as readSetup, openPaper, reflowReady, pdfReady, eagerFigures, shutDock, glideScroll } from './read.mjs';

export async function setup(context) {
  await readSetup(context);
  await eagerFigures(context);
}

export async function prepare({ page, arrive }) {
  await openPaper(page, arrive, { mode: 'reflow' });
  await shutDock(page);
  await reflowReady(page);
  // The PDF read once off camera, so the switch to it later is quick.
  await page.mouse.move(768, 500);
  await page.waitForTimeout(800);
}

/** Where a phrase in the reflowed text starts and ends, in the window, after bringing it to `at` of the height. */
async function phraseEnds(page, phrase, { at = 0.45, root = '.paper-body' } = {}) {
  const found = await page.evaluate(
    ([phrase, at, root]) => {
      const body = document.querySelector(root);
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let text = '';
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        nodes.push({ node, start: text.length });
        text += node.data;
      }
      const index = text.indexOf(phrase);
      if (index < 0) return null;
      const find = (offset) => {
        const entry = nodes.filter((item) => item.start <= offset).pop();
        return [entry.node, offset - entry.start];
      };
      const range = document.createRange();
      range.setStart(...find(index));
      range.setEnd(...find(index + phrase.length));
      const scroller = body.closest('.reader-scroll');
      const rect0 = range.getBoundingClientRect();
      if (scroller) scroller.scrollBy({ top: rect0.top - window.innerHeight * at, behavior: 'instant' });
      return true;
    },
    [phrase, at, root],
  );
  if (!found) throw new Error(`phrase not found: ${phrase}`);
  await page.waitForTimeout(150);
  return page.evaluate(
    ([phrase, root]) => {
      const body = document.querySelector(root);
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let text = '';
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        nodes.push({ node, start: text.length });
        text += node.data;
      }
      const index = text.indexOf(phrase);
      const find = (offset) => {
        const entry = nodes.filter((item) => item.start <= offset).pop();
        return [entry.node, offset - entry.start];
      };
      const range = document.createRange();
      range.setStart(...find(index));
      range.setEnd(...find(index + phrase.length));
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 1);
      const first = rects[0];
      const last = rects[rects.length - 1];
      return { x0: first.left + 1, y0: first.top + first.height / 2, x1: last.right - 1, y1: last.top + last.height / 2 };
    },
    [phrase, root],
  );
}

/** Scrolls the phrase into view with a glide (the wheel), then returns its ends. */
async function bringTo(page, pointer, phrase, at = 0.45) {
  const rect = await page.evaluate((phrase) => {
    const body = document.querySelector('.paper-body');
    const i = body.textContent.indexOf(phrase);
    if (i < 0) return null;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let seen = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (seen + node.data.length > i) {
        const range = document.createRange();
        range.setStart(node, i - seen);
        range.setEnd(node, Math.min(node.data.length, i - seen + 1));
        return range.getBoundingClientRect().top;
      }
      seen += node.data.length;
    }
    return null;
  }, phrase);
  if (rect === null) throw new Error(`phrase not found: ${phrase}`);
  const dy = rect - 864 * at;
  if (Math.abs(dy) > 30) await glideScroll(page, dy, { steps: Math.max(10, Math.min(36, Math.round(Math.abs(dy) / 40))), ms: Math.min(1800, 500 + Math.abs(dy)) });
  await page.waitForTimeout(400);
  return phraseEnds(page, phrase, { at });
}

/** A drag over the phrase, the custom pointer and the real mouse together. */
async function dragSelect(page, pointer, ends, ms = 1300) {
  await pointer.moveTo({ x: ends.x0, y: ends.y0 });
  await page.waitForTimeout(250);
  await page.mouse.down();
  await pointer.moveTo({ x: ends.x1, y: ends.y1 }, { ms });
  await page.mouse.up();
  await page.waitForTimeout(500);
}

export default async function ({ page, pointer, mark }) {
  const hold = (ms) => page.waitForTimeout(ms);
  await pointer.moveTo({ x: 900, y: 560 });
  await hold(1500);

  // ---------------------------------------------------------- highlight ---
  mark('highlight');
  const sentence = 'We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.';
  let ends = await bringTo(page, pointer, sentence, 0.5);
  await dragSelect(page, pointer, ends, 1600);
  await page.waitForSelector('.selection-toolbar');
  await hold(1600);
  await pointer.key('1', '1', 400);
  await page.waitForSelector('mark.hl');
  await pointer.moveTo({ x: Math.min(ends.x1 + 120, 1300), y: ends.y1 + 90 });
  await hold(2200);

  // ------------------------------------------------------------- lookup ---
  mark('lookup');
  ends = await bringTo(page, pointer, 'Self-attention, sometimes called intra-attention', 0.32);
  const word = await phraseEnds(page, 'Self-attention', { at: 0.32 });
  await dragSelect(page, pointer, word, 700);
  await hold(500);
  await pointer.moveTo({ x: (word.x0 + word.x1) / 2, y: word.y0 }, { ms: 300 });
  await pointer.click(null, { button: 'right', pause: 300 });
  await page.waitForSelector('.lookup');
  await page.waitForSelector('.lookup-word', { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('.lookup .spinner'), null, { timeout: 10000 });
  await hold(800);
  // Meaning, then where it comes from, then a comment.
  const tab = (name) => page.locator('.lookup-tabs button', { hasText: name });
  await pointer.moveTo('.lookup-pane:not([hidden])', { dy: 0.4 });
  await hold(2600);
  await pointer.click(tab('Origins'), { pause: 300 });
  await page.waitForFunction(() => !document.querySelector('.lookup .spinner'), null, { timeout: 10000 });
  await page.waitForSelector('#lookup-pane-origins .lookup-papers a', { timeout: 10000 });
  await hold(3200);
  await pointer.click(tab('Comment'), { pause: 400 });
  await pointer.click('#lookup-comment', { pause: 300 });
  await pointer.type('Same idea as intra-attention, Cheng et al. 2016. Why does it beat RNNs on long range?', { delay: 45 });
  await hold(2400);
  await pointer.key('Escape', 'Esc', 900);
  // Commenting brought the notes out beside the page; they go away again for now, and H brings them back later.
  if (await page.locator('.dock .notes-rail').count()) {
    await page.keyboard.press('h');
    await page.waitForTimeout(900);
  }

  // ------------------------------------------------------- hover: author ---
  mark('hover-author');
  await pointer.moveTo({ x: 900, y: 450 });
  await glideScroll(page, -3000, { steps: 24, ms: 1200 });
  await hold(600);
  await pointer.moveTo(page.locator('.paper-authors .author-name', { hasText: 'Ashish Vaswani' }));
  await page.waitForSelector('.hover-card .hc-stats', { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('.hover-card .spinner'), null, { timeout: 10000 }).catch(() => undefined);
  await hold(3800);
  await pointer.moveTo({ x: 1380, y: 500 });
  await page.waitForSelector('.hover-card', { state: 'detached', timeout: 4000 }).catch(() => undefined);

  // ----------------------------------------------------- hover: citation ---
  mark('hover-citation');
  await bringTo(page, pointer, 'long short-term memory [13]', 0.4);
  await pointer.moveTo(page.locator('.paper-body .cite', { hasText: '[13]' }).first());
  await page.waitForSelector('.hover-card .hc-title', { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('.hover-card .spinner'), null, { timeout: 10000 }).catch(() => undefined);
  await hold(3500);
  await pointer.moveTo({ x: 1380, y: 500 });
  await page.waitForSelector('.hover-card', { state: 'detached', timeout: 4000 }).catch(() => undefined);

  // ------------------------------------------------------ keep Figure 1 ---
  mark('keep-figure');
  const figure = page.locator('.paper-body figure.pdf-figure').first();
  const top = await figure.evaluate((el) => el.getBoundingClientRect().top);
  await pointer.moveTo({ x: 900, y: 450 });
  await glideScroll(page, top - 130, { steps: 30, ms: 1800 });
  await hold(500);
  const art = await figure.locator('img').first().boundingBox();
  await pointer.moveTo({ x: art.x + art.width * 0.45, y: art.y + art.height * 0.3 });
  await pointer.moveTo({ x: art.x + art.width * 0.55, y: art.y + art.height * 0.25 }, { ms: 500 });
  await page.waitForSelector('.note-clip-btn', { timeout: 5000 });
  await hold(900);
  await pointer.click('.note-clip-btn', { pause: 400 });
  await page.waitForSelector('.note-kept', { timeout: 5000 }).catch(() => undefined);
  await hold(2200);

  // --------------------------------------------------------------- notes ---
  mark('notes');
  await pointer.moveTo({ x: 700, y: 480 });
  await pointer.key('h', 'H', 600);
  await page.waitForSelector('.dock .notes-rail, .notes-win', { timeout: 5000 });
  await hold(3800);

  mark('board');
  await pointer.key('b', 'B', 600);
  await page.waitForSelector('.notes-board .board-card', { timeout: 5000 });
  await hold(3600);
  await pointer.key('Escape', 'Esc', 1000);
  await hold(800);

  // ------------------------------------------------- a sticky on the PDF ---
  mark('sticky');
  if (await page.locator('.dock .notes-rail').count()) await pointer.key('h', 'H', 700);
  await pointer.click(page.locator('.reader-head .segmented button', { hasText: 'PDF' }).first(), { pause: 400 });
  await pdfReady(page);
  await page.waitForSelector('.pdf-book-page[data-page="1"] .pdf-mark', { timeout: 15000 }).catch(() => undefined);
  const mark1 = page.locator('.pdf-book-page[data-page="1"] .pdf-mark').first();
  await pointer.moveTo({ x: 900, y: 500 });
  const markTop = await mark1.evaluate((el) => el.getBoundingClientRect().top).catch(() => 500);
  if (markTop > 560) await glideScroll(page, markTop - 420, { steps: 20, ms: 1200 });
  await hold(2200);
  await pointer.key('m', 'M', 500);
  await page.waitForSelector('.pin-hint', { timeout: 5000 });
  const p1 = await page.locator('.pdf-book-page[data-page="1"]').boundingBox();
  const markBox = await mark1.boundingBox().catch(() => null);
  const pinAt = { x: p1.x + p1.width * 0.88, y: markBox ? markBox.y + markBox.height / 2 : p1.y + p1.height * 0.5 };
  await pointer.click(pinAt, { pause: 500 });
  await page.waitForSelector('.pdf-sticky textarea', { timeout: 5000 });
  await pointer.type('The claim: no recurrence, no convolution. Check Table 2 for the cost.', { delay: 45 });
  await hold(1200);
  await pointer.key('Escape', 'Esc', 600);
  await pointer.moveTo({ x: p1.x + p1.width * 0.45, y: pinAt.y + 160 });
  await hold(3000);
}
