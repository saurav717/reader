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
  if (Math.abs(dy) > 30) await glideScroll(page, dy, { steps: Math.max(10, Math.min(36, Math.round(Math.abs(dy) / 40))), ms: Math.min(1300, 400 + Math.abs(dy) * 0.6) });
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

/** The lines a phrase in the reflowed text sits on, as boxes in CSS px. */
async function lineBoxes(page, phrase) {
  return page.evaluate((phrase) => {
    const body = document.querySelector('.paper-body');
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let text = '';
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push({ node, start: text.length });
      text += node.data;
    }
    const index = text.indexOf(phrase);
    if (index < 0) return [];
    const find = (offset) => {
      const entry = nodes.filter((item) => item.start <= offset).pop();
      return [entry.node, offset - entry.start];
    };
    const range = document.createRange();
    range.setStart(...find(index));
    range.setEnd(...find(index + phrase.length));
    const lines = [];
    for (const r of range.getClientRects()) {
      if (r.width < 1) continue;
      const line = lines.find((l) => Math.abs(l.y - r.top) < r.height / 2);
      if (line) {
        const right = Math.max(line.x + line.w, r.right);
        line.x = Math.min(line.x, r.left);
        line.w = right - line.x;
      } else lines.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    }
    return lines;
  }, phrase);
}

/** Every part of a highlight or comment mark on the reflowed text. */
async function marks(page, selector) {
  const count = await page.locator(selector).count();
  return Array.from({ length: count }, (_, i) => page.locator(selector).nth(i));
}

export default async function ({ page, pointer, mark, spot, unspot }) {
  const hold = (ms) => page.waitForTimeout(ms);
  await pointer.moveTo({ x: 900, y: 560 });
  await hold(1000);

  // ---------------------------------------------------------- highlight ---
  mark('highlight');
  const sentence = 'We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.';
  let ends = await bringTo(page, pointer, sentence, 0.5);
  await spot(await lineBoxes(page, sentence));
  await dragSelect(page, pointer, ends, 1600);
  await page.waitForSelector('.selection-toolbar');
  await hold(900);
  await spot('.selection-toolbar');
  await hold(2500);
  await pointer.key('2', '2', 400);
  await page.waitForSelector('mark.hl');
  await spot(await lineBoxes(page, sentence));
  await pointer.moveTo({ x: Math.min(ends.x1 + 120, 1300), y: ends.y1 + 90 });
  await hold(2300);

  // ------------------------------------------------------------- lookup ---
  mark('lookup');
  await unspot();
  ends = await bringTo(page, pointer, 'Self-attention, sometimes called intra-attention', 0.32);
  const word = await phraseEnds(page, 'Self-attention', { at: 0.32 });
  await spot(await lineBoxes(page, 'Self-attention, sometimes').then((l) => l.slice(0, 1).map((b) => ({ ...b, w: word.x1 - word.x0 + 2 }))));
  await dragSelect(page, pointer, word, 700);
  await hold(1000);
  await pointer.moveTo({ x: (word.x0 + word.x1) / 2, y: word.y0 }, { ms: 300 });
  await pointer.click(null, { button: 'right', pause: 300 });
  await page.waitForSelector('.lookup');
  await page.waitForSelector('.lookup-word', { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('.lookup .spinner'), null, { timeout: 10000 });
  await spot('.lookup');
  await hold(2200);
  // Meaning, then where it comes from, then a comment.
  const tab = (name) => page.locator('.lookup-tabs button', { hasText: name });
  await spot('.lookup-pane:not([hidden])');
  await pointer.moveTo('.lookup-pane:not([hidden])', { dy: 0.4 });
  await hold(2300);
  await pointer.click(tab('Origins'), { pause: 300 });
  await page.waitForFunction(() => !document.querySelector('.lookup .spinner'), null, { timeout: 10000 });
  await page.waitForSelector('#lookup-pane-origins .lookup-papers a', { timeout: 10000 });
  await spot('#lookup-pane-origins');
  await hold(2700);
  await pointer.click(tab('Comment'), { pause: 400 });
  await spot('#lookup-pane-comment');
  await pointer.click('#lookup-comment', { pause: 300 });
  // The first letter makes the highlight; give it a moment before the rest.
  await pointer.type('S');
  await page.waitForSelector('mark.hl[data-has-note="true"]', { timeout: 5000 }).catch(() => undefined);
  await hold(700);
  await pointer.type('ame as intra-attention (Cheng et al., 2016)?', { delay: 70 });
  await hold(2000);
  await unspot();
  await pointer.key('Escape', 'Esc', 900);
  // Commenting brought the notes out beside the page; they go away again for now, and H brings them back later.
  if (await page.locator('.dock .notes-rail').count()) {
    await page.keyboard.press('h');
    await page.waitForTimeout(900);
  }

  // ------------------------------------------------------- hover: author ---
  mark('hover-author');
  await pointer.moveTo({ x: 900, y: 450 });
  await glideScroll(page, -3000, { steps: 20, ms: 1000 });
  await hold(500);
  const author = page.locator('.paper-authors .author-name', { hasText: 'Ashish Vaswani' }).first();
  await spot(author);
  await hold(700);
  await pointer.moveTo(author);
  await page.waitForSelector('.hover-card .hc-stats', { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('.hover-card .spinner'), null, { timeout: 10000 }).catch(() => undefined);
  await spot('.hover-card');
  await hold(3000);
  await unspot();
  await pointer.moveTo({ x: 1380, y: 500 });
  await page.waitForSelector('.hover-card', { state: 'detached', timeout: 4000 }).catch(() => undefined);

  // ----------------------------------------------------- hover: citation ---
  mark('hover-citation');
  await bringTo(page, pointer, 'long short-term memory [13]', 0.4);
  const cite = page.locator('.paper-body .cite', { hasText: '[13]' }).first();
  await spot(cite);
  await hold(800);
  await pointer.moveTo(cite);
  await page.waitForSelector('.hover-card .hc-title', { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('.hover-card .spinner'), null, { timeout: 10000 }).catch(() => undefined);
  await spot('.hover-card');
  await hold(2800);
  await unspot();
  await pointer.moveTo({ x: 1380, y: 500 });
  await page.waitForSelector('.hover-card', { state: 'detached', timeout: 4000 }).catch(() => undefined);

  // ------------------------------------------------------ keep Figure 1 ---
  mark('keep-figure');
  const figure = page.locator('.paper-body figure.pdf-figure').first();
  const top = await figure.evaluate((el) => el.getBoundingClientRect().top);
  // From the margin, so the pointer arrives on the figure after the scroll has stopped.
  await pointer.moveTo({ x: 260, y: 450 });
  await glideScroll(page, top - 130, { steps: 26, ms: 1300 });
  await hold(700);
  const art = await figure.locator('img').first().boundingBox();
  await pointer.moveTo({ x: art.x + art.width * 0.45, y: art.y + art.height * 0.3 });
  await pointer.moveTo({ x: art.x + art.width * 0.55, y: art.y + art.height * 0.25 }, { ms: 500 });
  await page.waitForSelector('.note-clip-btn', { timeout: 5000 });
  await spot('.note-clip-btn');
  await pointer.moveTo('.note-clip-btn', { ms: 700 });
  await hold(1600);
  await pointer.click(null, { pause: 200 });
  await page.waitForSelector('.note-kept', { timeout: 5000 });
  await spot('.note-kept');
  await hold(2400);

  // --------------------------------------------------------------- notes ---
  mark('notes');
  await unspot();
  await pointer.moveTo({ x: 700, y: 480 });
  await pointer.key('h', 'H', 600);
  await page.waitForSelector('.dock .notes-rail, .notes-win', { timeout: 5000 });
  await page.waitForTimeout(500);
  const highlightsTab = page.locator('.notes-tabs [role="tab"]', { hasText: 'Highlights' }).first();
  if ((await highlightsTab.getAttribute('aria-selected')) !== 'true') await pointer.click(highlightsTab, { pause: 300 });
  await spot(await marks(page, '.dock .note-card'));
  await pointer.moveTo(page.locator('.notes-rail .eyebrow', { hasText: /Background/i }).first(), { dy: 3 });
  await hold(2700);
  await pointer.click(page.locator('.notes-tabs [role="tab"]', { hasText: 'Notes' }).first(), { pause: 300 });
  await page.waitForSelector('.dock .note-piece', { timeout: 5000 });
  await spot('.dock .note-piece');
  await hold(2500);

  mark('board');
  await unspot();
  await pointer.key('b', 'B', 600);
  await page.waitForSelector('.notes-board .board-card', { timeout: 5000 });
  await hold(1500);
  // A double-click on the board writes a note beside the figure.
  const card = await page.locator('.notes-board .board-card').first().boundingBox();
  const at = { x: Math.min(card.x + card.width + 90, 1200), y: card.y + 40 };
  await pointer.moveTo(at);
  await page.mouse.dblclick(at.x, at.y);
  await hold(400);
  const note = page.locator('.notes-board .board-card').nth(1);
  await spot(note);
  await pointer.type('Big picture: no recurrence at all.', { delay: 40 });
  await hold(600);
  await page.keyboard.press('Escape');
  await pointer.moveTo({ x: at.x + 60, y: at.y + 260 });
  await hold(2200);
  await unspot();
  await pointer.key('Escape', 'Esc', 900);
  if (await page.locator('.notes-board').count()) await page.keyboard.press('Escape');
  await hold(300);

  // ------------------------------------------------- a sticky on the PDF ---
  mark('sticky');
  if (await page.locator('.dock .notes-rail').count()) await pointer.key('h', 'H', 700);
  await pointer.click(page.locator('.reader-head .segmented button', { hasText: 'PDF' }).first(), { pause: 400 });
  await pdfReady(page);
  // The PDF opens where the reading got to: Figure 1's page. The sticky goes beside the figure.
  const page3 = page.locator('.pdf-book-page[data-page="3"]');
  await pointer.moveTo({ x: 900, y: 500 });
  const p3top = await page3.evaluate((el) => el.getBoundingClientRect().top);
  if (Math.abs(p3top - 150) > 40) await glideScroll(page, p3top - 150, { steps: 18, ms: 900 });
  await pdfReady(page);
  await hold(1400);
  await pointer.key('m', 'M', 500);
  await page.waitForSelector('.pin-hint', { timeout: 5000 });
  const p3 = await page3.boundingBox();
  const pinAt = { x: p3.x + p3.width * 0.93, y: Math.max(p3.y + p3.height * 0.2, 260) };
  await pointer.click(pinAt, { pause: 500 });
  await page.waitForSelector('.pdf-sticky textarea', { timeout: 5000 });
  await spot(['.pdf-sticky', '.pdf-pin']);
  await pointer.type('Encoder left, decoder right: 6 layers each.', { delay: 40 });
  await hold(700);
  await pointer.key('Escape', 'Esc', 600);
  await pointer.moveTo({ x: p3.x + p3.width * 0.45, y: pinAt.y + 220 });
  await hold(2500);
}
