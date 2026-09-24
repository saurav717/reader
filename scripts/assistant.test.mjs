// The Ask Claude window, without a browser or a key: what it sends (the
// screen block, the system prompt with the paper behind a cache breakpoint,
// the messages), how its chats are named and read back, the Markdown its
// answers are drawn with, and the geometry of the floating window.
//
//   node --test scripts/assistant.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const assistant = await load('src/lib/assistant.ts', { external: ['@anthropic-ai/sdk'] });
const { markdown, inline } = await load('src/lib/markdown.ts');
const win = await load('src/lib/floatWindow.ts');

after(cleanup);

const ALL = { paper: true, fullText: true, visible: true, selection: true, highlights: true, library: true };
const paperScreen = {
  where: 'Reading a paper',
  paper: {
    id: 'arxiv:1706.03762',
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani', 'Noam Shazeer'],
    published: '2017-06-12',
    arxivId: '1706.03762',
    abstract: 'The dominant sequence transduction models…',
    mode: 'Reflow',
    progress: 40,
  },
  fullText: 'Section 1. Introduction. Recurrent neural networks…',
  visible: 'Scaled dot-product attention computes…',
  selection: 'softmax(QK^T / sqrt(d_k)) V',
  highlights: [{ exact: 'multi-head attention', kind: 'Key claim', note: 'why 8 heads?', section: '3.2' }],
};

describe('the screen block', () => {
  it('carries every part that is switched on', () => {
    const block = assistant.screenBlock(paperScreen, ALL);
    assert.match(block, /^<screen>\n/);
    assert.match(block, /Title: Attention Is All You Need/);
    assert.match(block, /Authors: Ashish Vaswani, Noam Shazeer/);
    assert.match(block, /<abstract>\nThe dominant/);
    assert.match(block, /<passage_in_view>\nScaled dot-product/);
    assert.match(block, /<selected_text>\nsoftmax/);
    assert.match(block, /\[Key claim\] \(3\.2\) “multi-head attention”\n   note: why 8 heads\?/);
    assert.match(block, /Read so far: 40%/);
  });

  it('never assembles a part that is switched off', () => {
    const block = assistant.screenBlock(paperScreen, { ...ALL, selection: false, highlights: false, visible: false });
    assert.doesNotMatch(block, /softmax/);
    assert.doesNotMatch(block, /multi-head/);
    assert.doesNotMatch(block, /Scaled dot-product/);
    assert.match(block, /Attention Is All You Need/);
  });

  it('leaves out empty parts rather than sending empty tags', () => {
    const block = assistant.screenBlock({ ...paperScreen, selection: '', highlights: [] }, ALL);
    assert.doesNotMatch(block, /<selected_text>/);
    assert.doesNotMatch(block, /<highlights>/);
  });

  it('lists the titles on screen only when no paper is open', () => {
    const browsing = { where: 'Browsing all papers', library: ['A', 'B'] };
    assert.match(assistant.screenBlock(browsing, ALL), /<list_on_screen>\n- A\n- B/);
    assert.doesNotMatch(assistant.screenBlock({ ...paperScreen, library: ['A'] }, ALL), /list_on_screen/);
  });
});

describe('the system prompt', () => {
  it('puts the paper text last, behind a cache breakpoint', () => {
    const blocks = assistant.systemBlocks(paperScreen, ALL);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].text, assistant.SYSTEM);
    assert.equal(blocks[0].cache_control, undefined);
    assert.match(blocks[1].text, /^<paper_text title="Attention Is All You Need">\nSection 1/);
    assert.deepEqual(blocks[1].cache_control, { type: 'ephemeral' });
  });

  it('is only the instructions when the full text is switched off or missing', () => {
    assert.equal(assistant.systemBlocks(paperScreen, { ...ALL, fullText: false }).length, 1);
    assert.equal(assistant.systemBlocks({ ...paperScreen, fullText: '' }, ALL).length, 1);
  });

  it('cuts a very long paper, and says so', () => {
    const long = 'x'.repeat(assistant.FULL_TEXT_MAX_CHARS + 50);
    const [, text] = assistant.systemBlocks({ ...paperScreen, fullText: long }, ALL);
    assert.match(text.text, /truncated="yes, first 200,000 characters only"/);
    assert.ok(text.text.length < assistant.FULL_TEXT_MAX_CHARS + 200);
  });
});

describe('the messages', () => {
  it('leads the newest question with the screen, and only that one', () => {
    const turns = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second' },
    ];
    const messages = assistant.buildMessages(turns, '<screen>S</screen>');
    assert.deepEqual(messages, [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: '<screen>S</screen>\n\nsecond' },
    ]);
  });

  it('puts the pictures of the screen before the newest question, each named', () => {
    const messages = assistant.buildMessages(
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'what is in figure 2?' },
      ],
      '<screen>S</screen>',
      [{ label: 'Page 3 of the PDF, as it is on screen:', data: 'AAAA' }],
    );
    assert.equal(messages[0].content, 'first');
    assert.deepEqual(messages[2].content, [
      { type: 'text', text: 'Page 3 of the PDF, as it is on screen:' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
      { type: 'text', text: '<screen>S</screen>\n\nwhat is in figure 2?' },
    ]);
  });

  it('drops an empty assistant turn — a stopped or failed answer', () => {
    const messages = assistant.buildMessages(
      [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'again' },
      ],
      '',
    );
    assert.deepEqual(messages.map((m) => m.role), ['user', 'user']);
  });

  it('quotes an attached passage above the question', () => {
    assert.equal(assistant.withQuote('line one\nline two', 'What?'), '> line one\n> line two\n\nWhat?');
    assert.equal(assistant.withQuote('  ', 'What?'), 'What?');
  });
});

describe('history', () => {
  it('names a chat after its question, not the quote that leads it', () => {
    assert.equal(assistant.titleFor([{ role: 'user', content: '> a long passage\n\nWhat does this mean?' }]), 'What does this mean?');
    assert.equal(assistant.titleFor([{ role: 'user', content: '> only a quote' }]), 'only a quote');
    assert.equal(assistant.titleFor([]), 'Untitled chat');
    assert.equal(assistant.titleFor([{ role: 'user', content: 'y'.repeat(100) }]).length, 70);
  });

  it('reads back only well-formed chats', () => {
    const chats = assistant.normaliseHistory([
      { id: 'c1', title: 'Fine', created: 1, updated: 2, turns: [{ role: 'user', content: 'q' }, { role: 'system', content: 'x' }] },
      { id: 'c2', turns: [] },
      { title: 'no id', turns: [{ role: 'user', content: 'q' }] },
      null,
    ]);
    assert.equal(chats.length, 1);
    assert.deepEqual(chats[0].turns, [{ role: 'user', content: 'q' }]);
    assert.deepEqual(assistant.normaliseHistory('nonsense'), []);
  });
});

describe('markdown', () => {
  it('escapes everything it does not write itself', () => {
    const html = markdown('<img src=x onerror=alert(1)> **bold**');
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; <strong>bold<\/strong>/);
  });

  it('draws the blocks an answer is made of', () => {
    const html = markdown('## Heading\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n```py\nx < 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    assert.match(html, /<h5>Heading<\/h5>/);
    assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
    assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
    assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
    assert.match(html, /<pre data-lang="py"><code>x &lt; 1<\/code><\/pre>/);
    assert.match(html, /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table>/);
  });

  it('keeps an unterminated fence readable while it streams', () => {
    assert.equal(markdown('```\nstill coming'), '<pre><code>still coming</code></pre>');
  });

  it('formats inline spans but never inside code', () => {
    assert.equal(inline('`**not bold**` and *it* and [link](https://arxiv.org)'),
      '<code>**not bold**</code> and <em>it</em> and <a href="https://arxiv.org" target="_blank" rel="noopener noreferrer">link</a>');
    assert.equal(inline('[bad](javascript:alert(1))'), '[bad](javascript:alert(1))');
    assert.equal(inline('snake_case_name and $x_i$'), 'snake_case_name and $x_i$');
  });
});

describe('the floating window', () => {
  const view = { width: 1440, height: 900 };

  it('starts as a tall column against the right edge, inside the page', () => {
    const r = win.defaultRect(view);
    assert.equal(r.x + r.w, view.width - win.PAD);
    assert.equal(r.y, win.PAD);
    assert.ok(r.h < view.height - 2 * win.PAD, 'leaves room to be dragged');
  });

  it('is kept on the page and never smaller than usable', () => {
    const r = win.fit({ x: -500, y: 5000, w: 10, h: 10 }, view);
    assert.equal(r.x, win.LEFT_GUTTER + win.PAD);
    assert.equal(r.w, win.MIN.w);
    assert.equal(r.h, win.MIN.h);
    assert.equal(r.y + r.h, view.height - win.PAD);
  });

  it('resizes from the west edge without moving the east one', () => {
    const start = { x: 800, y: 20, w: 400, h: 600 };
    const r = win.resize(start, 'w', -100, 0, view);
    assert.equal(r.x + r.w, start.x + start.w);
    assert.equal(r.w, 500);
  });

  it('snaps to an edge and cycles half, a third, two thirds', () => {
    const b = win.bounds(view);
    const widths = [0, 1, 2].map((step) => win.snap('right', step, view).w);
    assert.deepEqual(widths, [Math.round(b.w / 2), Math.round(b.w / 3), Math.round((b.w * 2) / 3)]);
    const right = win.snap('right', 0, view);
    assert.equal(right.x + right.w, b.x + b.w);
    assert.equal(right.h, b.h);
  });

  it('moves by a stride that grows while an arrow is held, and stops at the edge', () => {
    assert.equal(win.stride(null), win.NUDGE);
    assert.ok(win.stride(win.NUDGE) > win.NUDGE);
    assert.equal(win.stride(win.NUDGE_MAX), win.NUDGE_MAX);
    const r = win.defaultRect(view);
    assert.deepEqual(win.nudge(r, 'right', 200, view), r, 'already at the right edge');
    assert.equal(win.nudge(r, 'left', 44, view).x, r.x - 44);
  });

  it('zooms home, then to the whole workspace', () => {
    const home = win.defaultRect(view);
    assert.deepEqual(win.zoom({ x: 100, y: 100, w: 400, h: 400 }, view), home);
    assert.deepEqual(win.zoom(home, view), win.bounds(view));
  });
});

describe('recommended papers', () => {
  const answer = [
    'Read these first.',
    '',
    '```papers',
    '{"title": "Stacked generalization", "authors": "Wolpert", "year": 1992, "why": "the basis of late fusion"}',
    '{"title": "Stacked regressions", "authors": ["Leo Breiman"]}',
    'not json',
    '{"authors": "no title"}',
    '{"title": "stacked generalization"}',
    '```',
  ].join('\n');

  it('takes the block out of the prose and reads a paper from each line', () => {
    const { text, papers } = assistant.splitPapers(answer);
    assert.equal(text, 'Read these first.');
    assert.deepEqual(papers, [
      { title: 'Stacked generalization', authors: 'Wolpert', year: '1992', why: 'the basis of late fusion' },
      { title: 'Stacked regressions', authors: 'Leo Breiman', year: undefined, why: undefined },
    ]);
  });

  it('hides a block still streaming in, and keeps the lines that are whole', () => {
    const { text, papers } = assistant.splitPapers('Two to read.\n```papers\n{"title": "Stacked regressions"}\n{"title": "Stack');
    assert.equal(text, 'Two to read.');
    assert.deepEqual(papers.map((paper) => paper.title), ['Stacked regressions']);
  });

  it('leaves an answer with no block, and other code, as it is', () => {
    const plain = 'Some code:\n```js\nconst a = 1;\n```';
    assert.deepEqual(assistant.splitPapers(plain), { text: plain, papers: [] });
  });

  it('is asked for in the system prompt', () => {
    assert.match(assistant.SYSTEM, /```papers/);
  });
});

describe('the window beside Discover', () => {
  const view = { width: 1440, height: 900 };
  const rect = win.defaultRect(view);

  it('moves left of a pane it covers, keeping its size', () => {
    const next = win.clearOf(rect, 1092, view);
    assert.equal(next.x + next.w, 1092 - win.PAD);
    assert.equal(next.w, rect.w);
    assert.equal(next.y, rect.y);
  });

  it('stays where it is when it is clear already', () => {
    assert.equal(win.clearOf({ ...rect, x: 100 }, 1092, view), null);
  });

  it('narrows when the room is short, and gives up when there is none', () => {
    const wide = { ...rect, x: 100, w: 1200 };
    const next = win.clearOf(wide, 1092, view);
    assert.equal(next.x, win.LEFT_GUTTER + win.PAD);
    assert.equal(next.x + next.w, 1092 - win.PAD);
    assert.equal(win.clearOf(rect, 300, view), null);
  });
});
