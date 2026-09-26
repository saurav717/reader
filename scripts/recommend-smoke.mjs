// Papers Claude names in an answer, in a real browser with Anthropic's API
// stubbed. Each `[name](paper:title)` is drawn as the name, numbered as its
// row in the list under the answer; a list item about one paper becomes that
// paper's card, in the answer's words, and several papers in one item get their
// cards after it. A card's Find searches Discover and opens the result; Add, and
// "Add all" under the answer, find each paper by its title and put it in the
// Reading list. Where the cards go is switched under the answer, in the
// window's ⚙ and in Settings, which all agree; with the cards only on the
// name, pointing at a name shows its card.
// Needs a server on BASE (`npm run build && npm start`). Writes screenshots to .smoke/.
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/1505.00001v1</id>
    <published>2021-03-01T00:00:00Z</published>
    <title>Machine learning-based multimodal prediction of language outcomes in chronic aphasia</title>
    <summary>Recent studies have combined multiple neuroimaging modalities to gain further understanding of the neurobiological substrates of aphasia. Following this line of work, the current study uses machine learning approaches to predict aphasia severity and specific language measures based on a multimodal neuroimaging dataset.</summary>
    <author><name>Sigfus Kristinsson</name></author><author><name>Wanfang Zhang</name></author><author><name>Chris Rorden</name></author><author><name>Roger Newman-Norlund</name></author><author><name>Alexandra Basilakos</name></author><author><name>Julius Fridriksson</name></author>
    <link title="pdf" href="http://arxiv.org/pdf/1505.00001v1"/>
  </entry>
</feed>`;

const ANSWER = [
  "A few groupings, depending on what you want:\n\n",
  "**Closest prior work (the two regression papers this one positions itself against)** — both predict WAB scores from multimodal imaging but with \"features selected using the entirety of the dataset\", which this paper calls Oracle Selection:\n\n",
  "- [Pustina et al. 2017](paper:Enhanced estimations of post-stroke aphasia severity using stacked multimodal predictions) (STAMP) — the two-phase stacking approach that Late Fusion here resembles.\n",
  "- [Kristinsson et al. 2021](paper:Machine learning-based multimodal prediction of language outcomes in chronic aphasia) — SVR on stacked multimodal features, the r=0.67 benchmark mentioned in §2.\n\n",
  "**Same dataset / research group, binary \"responder vs non-responder\" framing** — where the 55 patients and the feature sets in Table 1 come from:\n\n",
  "- [Gu et al. 2020](paper:A machine learning approach for predicting post-stroke aphasia recovery: A pilot study) and [Lai et al. 2021](paper:An exploration of machine learning methods for predicting post-stroke aphasia recovery) — the earlier binary versions of this problem.\n\n",
  "**Methods background:**\n\n",
  "- [Wolpert 1992](paper:Stacked generalization) and [Breiman 1996](paper:Stacked regressions) — stacked generalization and stacked regressions, for the Late Fusion idea.\n\n",
  "If you only read two, make them Pustina and Kristinsson — the contribution is essentially \"those, but without leaking the test folds into feature selection.\"\n\n```papers\n",
  "{\"title\": \"Enhanced estimations of post-stroke aphasia severity using stacked multimodal predictions\", \"authors\": \"Pustina et al.\", \"year\": 2017, \"why\": \"The STAMP method that Late Fusion here is modelled on\"}\n",
  "{\"title\": \"Machine learning-based multimodal prediction of language outcomes in chronic aphasia\", \"authors\": \"Kristinsson et al.\", \"year\": 2021, \"why\": \"SVR on stacked MRI features; the r=0.67 benchmark\"}\n",
  "{\"title\": \"A machine learning approach for predicting post-stroke aphasia recovery: A pilot study\", \"authors\": \"Gu et al.\", \"year\": 2020, \"why\": \"Earlier RF work that first flagged spared gray matter\"}\n",
  "{\"title\": \"An exploration of machine learning methods for predicting post-stroke aphasia recovery\", \"authors\": \"Lai et al.\", \"year\": 2021, \"why\": \"SVM/RF responder prediction adding fMRI\"}\n",
  "{\"title\": \"Stacked generalization\", \"authors\": \"Wolpert\", \"year\": 1992, \"why\": \"The stacking idea Late Fusion is built on\"}\n",
  "{\"title\": \"Stacked regressions\", \"authors\": \"Breiman\", \"year\": 1996, \"why\": \"Stacking for regression, with non-negative weights\"}\n",
  "```"
];

// Four of the six are in the index; Lai et al. and Breiman are not.
const TITLES = [
  ['Machine learning-based multimodal prediction of language outcomes in chronic aphasia', ['Sigfus Kristinsson', 'Julius Fridriksson'], '2021-01-01'],
  ['Enhanced estimations of post-stroke aphasia severity using stacked multimodal predictions', ['Dorian Pustina', 'H. Branch Coslett'], '2017-01-01'],
  ['A machine learning approach for predicting post-stroke aphasia recovery: A pilot study', ['Huanling Gu'], '2020-01-01'],
  ['Stacked generalization', ['David H. Wolpert'], '1992-01-01'],
];
const WORKS = { results: TITLES.map(([title, authors, date], i) => ({ id: `https://openalex.org/W${i}`, doi: `https://doi.org/10.1000/${i}`, display_name: title, publication_date: date, abstract_inverted_index: null, authorships: authors.map((name) => ({ author: { display_name: name } })), primary_location: null, concepts: [] })) };

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const STREAM =
  sse('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }) +
  sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
  ANSWER.map((text) => sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })).join('') +
  sse('content_block_stop', { index: 0 }) +
  sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 30 } }) +
  sse('message_stop', {});

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(label);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const cors = { 'access-control-allow-origin': '*' };
await context.route('**/api/arxiv/query*', (route) => route.fulfill({ status: 200, contentType: 'application/atom+xml', body: ATOM }));
await context.route('**/api.openalex.org/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(WORKS) }));
for (const pattern of ['**/api/arxiv/pdf*', '**/api/pdf*', '**/api/locate*', '**/api/scholar*', '**/api.crossref.org/**', '**/api.semanticscholar.org/**', '**/api.unpaywall.org/**']) {
  await context.route(pattern, (route) => route.fulfill({ status: 404, headers: cors, body: '' }));
}
await context.route('https://api.anthropic.com/**', (route) => {
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } });
  return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', ...cors }, body: STREAM });
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();

// Discover searches arXiv only, which is the index stubbed here. It stays
// open, under the window's default place against the right edge.
if (!(await page.locator('.discover-panel').count())) await page.getByRole('button', { name: 'Discover papers' }).click();
const chips = page.locator('.discover-panel .chip');
for (let index = 0; index < (await chips.count()); index += 1) {
  const chip = chips.nth(index);
  const wanted = ((await chip.textContent()) || '').trim() === 'arXiv';
  if (wanted !== ((await chip.getAttribute('aria-pressed')) === 'true')) await chip.click();
}

await page.keyboard.press('Control+Backslash');
const win = page.locator('.assistant-win');
await win.waitFor();
const covers = () => page.evaluate(() => document.querySelector('.assistant-win').getBoundingClientRect().right > document.querySelector('.discover-panel').getBoundingClientRect().left);
check('the window starts over Discover', await covers());
await page.getByLabel('Anthropic API key').fill('sk-ant-test-key');
await page.getByRole('button', { name: 'Save', exact: true }).click();
await page.getByRole('textbox', { name: 'Ask AI' }).fill('What other papers should I read to understand this one?');
await page.keyboard.press('Enter');
await page.waitForSelector('.chat-reading');
await page.waitForFunction(() => !document.querySelector('.chat-wait'));

console.log('\n== in place ==');
const text = page.locator('.chat-claude .chat-text');
const cards = text.locator('.chat-card');
check('every paper has one card in the answer', (await cards.count()) === 6);
const pustina = cards.first();
check('an item about one paper became its card, in the answer\'s words', (await text.locator('li.chat-li-card').count()) === 2 && /two-phase stacking approach/.test(await pustina.textContent()));
check('with its number, authors, year and the short name it was given', /1\s*Pustina et al\. · 2017 · STAMP/.test(await pustina.locator('.chat-card-head').textContent()));
check('several papers in one item keep the words, and their cards follow', /Gu et al\. 2020\s*and Lai et al\. 2021\s*— the earlier binary/.test(await text.locator('li').nth(2).textContent()) && (await text.locator('li').nth(2).locator('.chat-card').count()) === 2);
check('a card there says what the block said of it', /first flagged spared gray matter/.test(await text.locator('li').nth(2).locator('.chat-card').first().textContent()));
check('no link syntax and no block are shown', !/paper:|\]\(|```|"title"/.test(await text.textContent()));
await page.screenshot({ path: `${OUT}/recommend-inline.png` });

console.log('\n== the list under the answer ==');
check('it counts the papers, folded', /6 papers mentioned/.test(await page.locator('.chat-reading summary').textContent()) && !(await page.locator('.chat-reading').evaluate((el) => el.open)));
await page.getByRole('button', { name: 'Add all to Reading list' }).click();
await page.waitForFunction(() => !document.querySelector('.chat-add.is-adding, .chat-card-add.is-adding'), null, { timeout: 15000 });
check('"Add all" adds the papers it finds', /4 of 6 in Reading list/.test(await page.locator('.chat-reading summary').textContent()));
await page.locator('.chat-reading summary').click();
check('and says which it could not find', (await page.locator('.chat-reading-missing').count()) === 2);
check('the cards know it too', (await text.locator('.chat-card-add.is-added').count()) === 4 && (await text.locator('.chat-card-add.is-missing').count()) === 2);

console.log('\n== to Discover ==');
await pustina.locator('.chat-card-head .chat-card-find').click();
await page.waitForSelector('.discover-panel article.result.is-open', { timeout: 15000 });
check('Find searches Discover for the title', (await page.getByLabel('Search papers').inputValue()) === 'Enhanced estimations of post-stroke aphasia severity using stacked multimodal predictions');
check('and opens the matching result, with its Read button', (await page.locator('.discover-panel article.result.is-open').getByRole('button', { name: /^Read$/ }).count()) === 1);
check('the window steps out of the way of Discover', !(await covers()));

console.log('\n== the switch under the answer ==');
const layoutSwitch = page.locator('.chat-reading .chat-layout');
check('it offers the three places, "In place" chosen', (await layoutSwitch.locator('button').allTextContents()).join('|') === 'In place|Sections|On name' && (await layoutSwitch.getByRole('button', { name: 'In place' }).getAttribute('aria-pressed')) === 'true');
const wasOpen = await page.locator('.chat-reading').evaluate((el) => el.open);
await layoutSwitch.getByRole('button', { name: 'Sections' }).click();
check('"Sections" leaves the text as written, cards after each part', (await text.locator('li.chat-li-card').count()) === 0 && (await text.locator(':scope > .chat-cards').count()) === 3 && (await text.locator('.chat-card').count()) === 6);
check('pressing it does not fold or unfold the list', (await page.locator('.chat-reading').evaluate((el) => el.open)) === wasOpen);
await page.screenshot({ path: `${OUT}/recommend-sections.png` });

console.log('\n== only on the name, from the window\'s ⚙ ==');
await page.locator('.assistant-win').getByRole('button', { name: 'Settings' }).click();
await page.getByLabel('Only on the name').check();
await page.locator('.assistant-win').getByRole('button', { name: 'Settings' }).click();
check('the switch under the answer follows', (await layoutSwitch.getByRole('button', { name: 'On name' }).getAttribute('aria-pressed')) === 'true');
check('the cards leave the answer', (await text.locator('.chat-card').count()) === 0 && (await text.locator('.chat-mention').count()) === 6);
check('the choice is kept', (await page.evaluate(() => localStorage.getItem('reader.assistant.paper-layout'))) === 'end');
await text.locator('.chat-mention').first().hover();
await page.waitForSelector('.chat-peek');
check('pointing at a name shows its card', /Enhanced estimations/.test(await page.locator('.chat-peek').textContent()) && /STAMP method/.test(await page.locator('.chat-peek').textContent()));
await page.mouse.move(5, 5);
await page.waitForFunction(() => !document.querySelector('.chat-peek'));
check('and leaving it hides the card', true);
await text.locator('.chat-mention').nth(1).click();
await page.waitForSelector('.chat-peek');
await page.mouse.move(5, 5);
await page.waitForTimeout(400);
check('a press keeps it', (await page.locator('.chat-peek').count()) === 1);
await page.keyboard.press('Escape');
check('until Escape', (await page.locator('.chat-peek').count()) === 0);
await page.screenshot({ path: `${OUT}/recommend-end.png` });

console.log('\n== in Settings ==');
await page.keyboard.press('Control+Backslash');
await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
const sheet = page.getByRole('dialog', { name: 'Settings' });
const choice = sheet.getByRole('group', { name: "Where the papers' cards go" });
check('Settings shows the same choice', (await choice.getByRole('button', { name: 'Only on the name' }).getAttribute('aria-pressed')) === 'true');
await choice.getByRole('button', { name: 'In place' }).click();
check('and sets it', (await page.evaluate(() => localStorage.getItem('reader.assistant.paper-layout'))) === 'inline');
await page.screenshot({ path: `${OUT}/recommend-settings.png` });
await page.keyboard.press('Escape');
await page.keyboard.press('Control+Backslash');
await page.waitForSelector('.chat-claude .chat-card');
check('the answer has its cards in place again', (await text.locator('li.chat-li-card').count()) === 2);

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(problems.length ? `\n${problems.length} failed` : '\nall passed');
process.exit(problems.length ? 1 : 0);
