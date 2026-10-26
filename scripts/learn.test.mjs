// Learn, without a browser or a key: how a map is read from the model's
// reply and laid out, where the reader stands on it, how a page's check and
// glossary are read and the check is marked, and what the next page is told.
//
//   node --test scripts/learn.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const learn = await load('src/lib/learn.ts', { external: ['@anthropic-ai/sdk'] });
const explain = await load('src/lib/explain.ts', { external: ['@anthropic-ai/sdk'] });
const wikimedia = await load('src/lib/wikimedia.ts', { external: ['@anthropic-ai/sdk'] });
const pictures = await load('src/lib/pictures.ts', { external: ['@anthropic-ai/sdk', '*/figureReader'] });
const learnDrive = await load('src/lib/learnDrive.ts', { external: ['@anthropic-ai/sdk'] });
const lineMotion = await load('src/lib/lineMotion.ts');
const generated = await load('src/lib/generated.ts');

after(cleanup);

const MAP = `Here is the map.
\`\`\`json
{
  "stages": ["Ground", "The trick", "Beyond"],
  "nodes": [
    { "id": "noise", "title": "Gaussian noise", "stage": "Ground", "needs": [], "blurb": "What noise does.", "kind": "page" },
    { "id": "markov", "title": "Markov chains", "stage": "Ground", "needs": [], "blurb": "One step at a time.", "kind": "page" },
    { "id": "forward", "title": "Forward process", "stage": "The trick", "needs": ["noise", "Markov chains", "reverse"], "blurb": "Dissolving a picture.", "kind": "page" },
    { "id": "reverse", "title": "Reverse process", "stage": "The trick", "needs": ["forward", "forward", "nowhere"], "blurb": "Running it backwards.", "kind": "page" },
    { "id": "forward", "title": "Read DDPM", "stage": "Beyond", "needs": ["reverse"], "blurb": "The paper.", "kind": "paper", "paper": { "title": "Denoising Diffusion Probabilistic Models", "arxivId": "2006.11239" } }
  ]
}
\`\`\``;

describe('the instructions', () => {
  it('ask for a map as JSON, and for pages with the blocks the page draws', () => {
    assert.match(learn.MAP_SYSTEM, /ONE JSON object/);
    assert.match(learn.MAP_SYSTEM, /never a cycle/);
    assert.match(learn.PAGE_SYSTEM, /```formal title=/);
    assert.match(learn.PAGE_SYSTEM, /```image query=/);
    assert.match(learn.PAGE_SYSTEM, /```check/);
    assert.match(learn.PAGE_SYSTEM, /```glossary/);
    assert.match(learn.PAGE_SYSTEM, /Never invent a citation/);
    assert.match(learn.PAGE_SYSTEM, /SCENES — a figure can be animated on request/);
    // For this course the scenes are written without being asked, and the figures are drawn in the order a hand would.
    assert.match(learn.PAGE_SYSTEM, /write a\s+```motion` block right after it/);
    assert.match(learn.PAGE_SYSTEM, /"on request" is relaxed/);
    assert.match(learn.PAGE_SYSTEM, /in the order a hand would draw it/);
    // And, where the page's idea is a process, the scene the Studio walks.
    assert.match(learn.PAGE_SYSTEM, /STUDIO — a page whose central idea is something that HAPPENS/);
    assert.match(learn.PAGE_SYSTEM, /FIRST decide what the paper.s own\s+best figure/);
    assert.match(learn.PAGE_SYSTEM, /Do not copy the arrangement of another page/);
    assert.match(learn.PAGE_SYSTEM, /most pages have none/);
  });
});

describe('reading the map', () => {
  const map = learn.parseMap(MAP);
  it('keeps the stages and the nodes, in stage order', () => {
    assert.deepEqual(map.stages, ['Ground', 'The trick', 'Beyond']);
    assert.deepEqual(
      map.nodes.map((n) => n.id),
      ['noise', 'markov', 'forward', 'reverse', 'forward-2'],
    );
  });
  it('points needs at nodes, by id or by title, and drops the ones that would cycle or go nowhere', () => {
    const by = Object.fromEntries(map.nodes.map((n) => [n.id, n]));
    assert.deepEqual(by.forward.needs, ['noise', 'markov']);
    assert.deepEqual(by.reverse.needs, ['forward']);
  });
  it('keeps a paper node with its paper', () => {
    const paper = map.nodes.at(-1);
    assert.equal(paper.kind, 'paper');
    assert.equal(paper.paper.arxivId, '2006.11239');
  });
  it('reads a reply with no fence, and refuses one with no nodes', () => {
    assert.equal(learn.parseMap('{"stages":["A"],"nodes":[{"title":"One"}]}').nodes[0].id, 'one');
    assert.equal(learn.parseMap('nothing here'), null);
    assert.equal(learn.parseMap('{"nodes":[]}'), null);
  });
  it('puts a node with an unknown stage in a stage of its own, and one with none in the first', () => {
    const odd = learn.parseMap('{"stages":["A"],"nodes":[{"title":"One","stage":"B"},{"title":"Two"}]}');
    assert.deepEqual(odd.stages, ['A', 'B']);
    assert.equal(odd.nodes.find((n) => n.id === 'two').stage, 'A');
  });
});

describe('where the reader stands', () => {
  const { stages, nodes } = learn.parseMap(MAP);
  it('starts with the first page up next and the rest ready or locked', () => {
    const states = learn.nodeStates({ nodes, progress: {} });
    assert.equal(states.noise, 'next');
    assert.equal(states.markov, 'ready');
    assert.equal(states.forward, 'locked');
    assert.equal(learn.nextNode({ nodes, progress: {} }).id, 'noise');
  });
  it('unlocks a page once everything it needs is read', () => {
    const states = learn.nodeStates({ nodes, progress: { noise: 'read', markov: 'confident' } });
    assert.equal(states.forward, 'next');
    assert.equal(states.reverse, 'locked');
    assert.deepEqual(learn.countRead({ nodes, progress: { noise: 'read', markov: 'confident' } }), { read: 2, confident: 1, total: 5 });
  });
  it('lays the map out as columns, every node a box, every need a curve', () => {
    const layout = learn.layoutMap({ stages, nodes });
    assert.equal(layout.columns.length, 3);
    assert.equal(layout.boxes.length, 5);
    assert.equal(layout.edges.length, 4);
    const at = Object.fromEntries(layout.boxes.map((b) => [b.id, b]));
    assert.ok(at.noise.x < at.forward.x && at.forward.x < at['forward-2'].x);
    assert.ok(at.noise.y < at.markov.y);
    assert.ok(layout.width > at['forward-2'].x + learn.BOX_W);
    assert.match(layout.edges[0].d, /^M[\d.]+ [\d.]+ C /);
  });
  it('knows the page after and before one', () => {
    assert.equal(learn.nodeAfter({ nodes }, 'noise').id, 'markov');
    assert.equal(learn.nodeBefore({ nodes }, 'noise'), undefined);
    assert.equal(learn.nodeAfter({ nodes }, 'forward-2'), undefined);
  });
});

const PAGE = `## Why we walk backwards

Last page we watched a photo dissolve. The idea is to run that film backwards [1].

\`\`\`formal title="One step, exactly"
$$p_\\theta(x_{t-1}|x_t) = \\mathcal{N}(x_{t-1}; \\mu_\\theta(x_t, t), \\sigma_t^2 I)$$
where $\\mu_\\theta$ is the only thing learned.
\`\`\`

\`\`\`image query="gaussian noise added to photograph" must="a photograph at several noise levels" caption="What mostly-noise looks like."
A real photograph, not a cartoon.
\`\`\`

## References

[1] Ho, Jain, Abbeel. Denoising Diffusion Probabilistic Models. 2020.

\`\`\`check
{"questions":[
 {"kind":"pick","q":"Which drawing shows what is learned?","options":[{"text":"One jump","svg":"<svg viewBox=\\"0 0 10 10\\"></svg>"},{"text":"One step back, repeated"},{"text":"Add noise"}],"answer":1,"why":"The network guesses the noise and steps back one frame."},
 {"kind":"order","q":"One step of sampling.","steps":["Show x_t","Predict the noise","Subtract it","Add fresh noise"],"why":"The fresh noise goes in after the mean."},
 {"kind":"fill","q":"The reverse steps are Gaussian because ___.","answer":"the forward steps were tiny","accept":["small steps"],"why":"Small forward steps have Gaussian reverses."}
]}
\`\`\`

\`\`\`glossary
reverse process — running the noising film backwards
- **μ_θ** — the mean the network supplies
\`\`\`
`;

describe('reading a page', () => {
  const sections = explain.parseExplanation(PAGE);
  it('finds the formal account and the picture request as blocks of their own', () => {
    const kinds = sections[0].blocks.map((b) => b.kind);
    assert.deepEqual(kinds, ['prose', 'formal', 'image']);
    const formal = sections[0].blocks[1];
    assert.equal(formal.title, 'One step, exactly');
    assert.match(formal.md, /mu_\\theta/);
    const image = sections[0].blocks[2];
    assert.equal(image.query, 'gaussian noise added to photograph');
    assert.equal(image.must, 'a photograph at several noise levels');
    assert.equal(image.md, 'A real photograph, not a cartoon.');
    assert.equal(image.open, false);
  });
  it('reads the check', () => {
    const questions = learn.checkOf(sections);
    assert.equal(questions.length, 3);
    assert.deepEqual(
      questions.map((q) => q.kind),
      ['pick', 'order', 'fill'],
    );
    assert.equal(questions[0].options.length, 3);
    assert.match(questions[0].options[0].svg, /^<svg/);
    assert.equal(questions[0].answer, 1);
    assert.equal(questions[1].steps.length, 4);
    assert.deepEqual(questions[2].accept, ['small steps']);
  });
  it('reads the glossary, in either shape of line', () => {
    const entries = learn.glossaryOf(sections, 'reverse');
    assert.deepEqual(
      entries.map((e) => [e.term, e.meaning, e.nodeId]),
      [
        ['reverse process', 'running the noising film backwards', 'reverse'],
        ['μ_θ', 'the mean the network supplies', 'reverse'],
      ],
    );
  });
  it('leaves the check and glossary out of what is read', () => {
    const shown = learn.pageSections(sections);
    assert.ok(shown.every((s) => s.blocks.every((b) => b.kind !== 'check' && b.kind !== 'glossary')));
    assert.deepEqual(
      shown.map((s) => s.title),
      ['Why we walk backwards', 'References'],
    );
  });
  it('drops a check it cannot read, question by question', () => {
    assert.deepEqual(learn.parseCheck('not json'), []);
    const partial = learn.parseCheck('{"questions":[{"kind":"pick","q":"?","options":["a"],"answer":0},{"kind":"fill","q":"?","answer":"x"}]}');
    assert.equal(partial.length, 1);
    assert.equal(partial[0].kind, 'fill');
  });
});

describe('marking the check', () => {
  const questions = learn.checkOf(explain.parseExplanation(PAGE));
  it('marks a pick', () => {
    assert.equal(learn.markAnswer(questions[0], 1), 1);
    assert.equal(learn.markAnswer(questions[0], 0), 0);
  });
  it('marks an order by its pairs, so one swap is half marks at most', () => {
    assert.equal(learn.markAnswer(questions[1], [0, 1, 2, 3]), 1);
    assert.equal(learn.markAnswer(questions[1], [0, 1, 3, 2]), 0.5);
    assert.equal(learn.markAnswer(questions[1], [3, 2, 1, 0]), 0);
    assert.equal(learn.markAnswer(questions[1], null), 0);
  });
  it('marks a sentence by its words', () => {
    assert.equal(learn.markAnswer(questions[2], 'because the forward steps were tiny!'), 1);
    assert.equal(learn.markAnswer(questions[2], 'Small steps'), 1);
    assert.equal(learn.markAnswer(questions[2], 'the steps forward are tiny'), 0.5);
    assert.equal(learn.markAnswer(questions[2], 'magic'), 0);
  });
  it('scores the whole check and keeps what was missed for the next page', () => {
    const result = learn.markCheck(questions, [1, [0, 1, 3, 2], 'magic']);
    assert.equal(result.score, 0.5);
    assert.deepEqual(result.missed, ['The fresh noise goes in after the mean.', 'Small forward steps have Gaussian reverses.']);
    assert.equal(learn.verdictOf(result).title, 'Mostly there.');
    assert.equal(learn.verdictOf({ score: 1 }).confident, true);
    assert.equal(learn.verdictOf({ score: 0.2 }).title, 'Not yet.');
  });
  it('shuffles the steps the same way every time, and never leaves them as they were', () => {
    const a = learn.shuffled([0, 1, 2, 3], 'seed');
    assert.deepEqual(a, learn.shuffled([0, 1, 2, 3], 'seed'));
    assert.notDeepEqual(a, [0, 1, 2, 3]);
    assert.deepEqual([...a].sort(), [0, 1, 2, 3]);
  });
});

describe('what the next page is told', () => {
  const { stages, nodes } = learn.parseMap(MAP);
  const track = {
    id: 't',
    topic: 'Diffusion models',
    from: 'basic probability',
    to: 'read DDPM',
    prefs: learn.DEFAULT_PREFS,
    model: 'm',
    created: 0,
    updated: 0,
    stages,
    nodes,
    progress: { noise: 'read', markov: 'read', forward: 'read' },
    glossary: [{ term: 'β_t', meaning: 'the noise schedule', nodeId: 'forward' }],
    pages: { forward: { nodeId: 'forward', content: 'x', model: 'm', created: 0, updated: 0, check: { at: 1, score: 0.5, missed: ['The fresh noise goes in after the mean.'], answers: [] } } },
  };
  it('names the pages read, the glossary, and bridges what the last check missed', () => {
    const request = learn.pageRequest(track, 'reverse');
    assert.match(request, /<pages_read>[\s\S]*Forward process/);
    assert.match(request, /<glossary_so_far>[\s\S]*β_t — the noise schedule/);
    assert.match(request, /<bridge>[\s\S]*“Forward process”[\s\S]*fresh noise goes in after the mean/);
    assert.match(request, /Write the page “Reverse process” \(reverse\)/);
  });
  it('asks for the first page with no bridge and nothing read', () => {
    const request = learn.pageRequest({ ...track, progress: {}, glossary: [], pages: {} }, 'noise');
    assert.doesNotMatch(request, /<bridge>|<pages_read>|<glossary_so_far>/);
  });
  it('writes a page out as a file with its front matter', () => {
    const file = learn.pageFile(track, track.pages.forward);
    assert.match(file, /^---\ngenerator: "reader"\ntopic: "Diffusion models"\npage: "Forward process"/);
    assert.match(file, /check: 0.5/);
  });
});

describe('pictures from Commons', () => {
  it('asks Commons for pictures only, with their licence', () => {
    const url = new URL(wikimedia.commonsSearchUrl('mitochondrion micrograph'));
    assert.equal(url.searchParams.get('origin'), '*');
    assert.equal(url.searchParams.get('gsrnamespace'), '6');
    assert.match(url.searchParams.get('gsrsearch'), /^filetype:bitmap\|drawing mitochondrion micrograph$/);
    assert.match(url.searchParams.get('iiprop'), /extmetadata/);
  });
  it('reads the candidates in order, skipping what is not a picture or has no licence', () => {
    const json = {
      query: {
        pages: {
          2: { index: 2, title: 'File:B.png', imageinfo: [{ mime: 'image/png', url: 'u2', thumburl: 't2', descriptionurl: 'd2', thumbwidth: 900, thumbheight: 600, extmetadata: { Artist: { value: '<a href="x">Jane Doe</a>' }, LicenseShortName: { value: 'CC BY-SA 4.0' }, LicenseUrl: { value: 'l' } } }] },
          1: { index: 1, title: 'File:A.jpg', imageinfo: [{ mime: 'image/jpeg', url: 'u1', thumburl: 't1', descriptionurl: 'd1', extmetadata: { LicenseShortName: { value: 'Public domain' }, ImageDescription: { value: 'A &amp; B' } } }] },
          3: { index: 3, title: 'File:C.pdf', imageinfo: [{ mime: 'application/pdf', extmetadata: { LicenseShortName: { value: 'CC0' } } }] },
          4: { index: 4, title: 'File:D.jpg', imageinfo: [{ mime: 'image/jpeg', extmetadata: {} }] },
        },
      },
    };
    const images = wikimedia.fromCommons(json);
    assert.deepEqual(
      images.map((i) => i.title),
      ['A.jpg', 'B.png'],
    );
    assert.equal(images[0].author, 'unknown author');
    assert.equal(images[0].description, 'A & B');
    assert.equal(images[1].author, 'Jane Doe');
    assert.equal(images[1].licence, 'CC BY-SA 4.0');
    assert.equal(images[1].width, 900);
    assert.deepEqual(wikimedia.fromCommons({}), []);
  });
  it('reads a paper named on an image block, and the figure wanted', () => {
    const [section] = explain.parseExplanation('## A\n```image query="DDPM samples" must="faces a model produced" paper="arXiv:2006.11239v2" figure="Figure 1"\nwhy\n```');
    const image = section.blocks[0];
    assert.equal(image.kind, 'image');
    assert.equal(image.paper, '2006.11239');
    assert.equal(image.figure, 'Figure 1');
    assert.equal(explain.parseExplanation('## A\n```image query="x" must="y"\n```')[0].blocks[0].paper, undefined);
  });
  it('names where a picture came from', () => {
    assert.equal(pictures.sourceLabel({ kind: 'commons', src: '', page: '', title: '', source: 'Wikimedia Commons' }), 'Found on the web · Wikimedia Commons');
    assert.equal(pictures.sourceLabel({ kind: 'paper', src: '', page: '', title: '', source: 'arXiv:2006.11239' }), 'From a paper · arXiv:2006.11239');
    assert.equal(pictures.sourceLabel({ kind: 'web', src: '', page: '', title: '', source: 'x', via: 'Google Images' }), 'Found on the web · Google Images');
    assert.equal(pictures.sourceLabel({ kind: 'generated', src: '', page: '', title: '', source: 'FLUX via Pollinations.ai' }), 'Made for this page · FLUX via Pollinations.ai');
  });
  it('reads the checker’s verdict', () => {
    assert.deepEqual(pictures.readVerdict('2\nA photograph at four noise levels.'), { pick: 2, note: 'A photograph at four noise levels.' });
    assert.deepEqual(pictures.readVerdict('Picture 3 — shows the apparatus.'), { pick: 3, note: 'shows the apparatus.' });
    assert.equal(pictures.readVerdict('0. None of them.').pick, 0);
    assert.equal(pictures.readVerdict('none of these').pick, 0);
  });
});

describe('a track in Drive', () => {
  const { stages, nodes } = learn.parseMap(MAP);
  const track = {
    id: 'k7x9', topic: 'Diffusion: models / basics?', from: '', to: '', prefs: learn.DEFAULT_PREFS, model: 'm', created: 1, updated: 2, stages, nodes,
    pages: { noise: { nodeId: 'noise', content: '## A\n\nx', model: 'm', created: 1, updated: 2, streaming: true, thinking: 'hm', pending: { request: 'r', reply: '' } } },
    progress: { noise: 'read' }, glossary: [], mapping: true, error: 'e', drive: { folderId: 'f' },
  };
  it('names the folder by the topic and the id, and reads the id back', () => {
    const name = learnDrive.trackFolderName(track);
    assert.equal(name, 'Diffusion models basics (k7x9)');
    assert.equal(learnDrive.trackIdOf(name), 'k7x9');
    assert.equal(learnDrive.trackIdOf('Something else'), null);
    assert.equal(learnDrive.pageFileName(track, 'markov'), '02 Markov chains.md');
  });
  it('writes track.json without what is only this browser’s, and reads it back', () => {
    const text = learnDrive.trackJson(track);
    const raw = JSON.parse(text);
    assert.equal(raw.generator, 'reader');
    assert.equal(raw.mapping, undefined);
    assert.equal(raw.error, undefined);
    assert.equal(raw.drive, undefined);
    assert.equal(raw.pages.noise.streaming, undefined);
    assert.equal(raw.pages.noise.pending, undefined);
    const back = learnDrive.fromTrackJson(text);
    assert.equal(back.id, 'k7x9');
    assert.equal(back.nodes.length, 5);
    assert.equal(back.pages.noise.content, '## A\n\nx');
    assert.deepEqual(back.progress, { noise: 'read' });
    assert.equal(learnDrive.fromTrackJson('{"nope":1}'), null);
    assert.equal(learnDrive.fromTrackJson('not json'), null);
  });
});

describe('searching what has been learned', () => {
  const { stages, nodes } = learn.parseMap(MAP);
  const base = { id: 't1', topic: 'Diffusion models', from: 'basic probability', to: 'read DDPM', prefs: learn.DEFAULT_PREFS, model: 'm', created: 0, updated: 5, opened: 5, stages, nodes, progress: { noise: 'read' }, glossary: [{ term: 'β_t', meaning: 'the noise schedule', nodeId: 'forward' }], pages: { reverse: { nodeId: 'reverse', content: PAGE, model: 'm', created: 0, updated: 0 } } };
  const other = { ...base, id: 't2', topic: 'How the immune system remembers', from: '', to: '', nodes: [{ id: 'b', title: 'B cells', stage: 'A', needs: [], blurb: 'Antibodies.', kind: 'page' }], stages: ['A'], glossary: [], pages: {}, progress: {}, opened: 9, updated: 9 };
  it('finds a topic, a page, a term and a passage, and says which', () => {
    const [match] = learn.searchTracks([base, other], 'noise');
    assert.equal(match.track.id, 't1');
    assert.deepEqual(
      match.hits.map((h) => h.kind),
      ['page', 'term', 'text'],
    );
    assert.equal(match.hits[0].label, 'Gaussian noise');
    assert.equal(match.hits[1].label, 'β_t');
    assert.equal(match.hits[2].nodeId, 'reverse');
    assert.equal(learn.searchTracks([base, other], 'noise').length, 1);
    // A word in a page's prose comes back with the words round it.
    const [inText] = learn.searchTracks([base, other], 'dissolve');
    assert.equal(inText.hits[0].kind, 'text');
    assert.match(inText.hits[0].snippet, /watched a photo dissolve/);
  });
  it('puts a track whose topic matches first, and wants every word somewhere', () => {
    assert.equal(learn.searchTracks([base, other], 'immune')[0].track.id, 't2');
    assert.equal(learn.searchTracks([base, other], 'immune noise').length, 0);
    assert.equal(learn.searchTracks([base, other], 'ddpm probability')[0].hits[0].kind, 'topic');
    assert.deepEqual(learn.searchTracks([base, other], '   '), []);
  });
  it('knows where a track stands', () => {
    const now = 100 * 24 * 3600 * 1000;
    assert.equal(learn.trackStatus(other, now), 'new');
    assert.equal(learn.trackStatus({ ...base, opened: now - 1000 }, now), 'reading');
    assert.equal(learn.trackStatus({ ...base, opened: now - 10 * 24 * 3600 * 1000 }, now), 'stalled');
    assert.equal(learn.trackStatus({ ...base, progress: Object.fromEntries(nodes.map((n) => [n.id, 'read'])) }, now), 'finished');
  });
  it('cuts a snippet round the match, without the markdown', () => {
    assert.equal(learn.snippetOf('## A\n\nThe **whole** idea is to run that film backwards.', 'film', 8), '…un that film backwar…');
    assert.equal(learn.snippetOf('## A\n\nThe **whole** idea is to run that film backwards.', 'film'), 'A The whole idea is to run that film backwards.');
    assert.equal(learn.snippetOf('nothing here', 'film'), '');
  });
});

describe('the lines drawing themselves', () => {
  it('spreads the strokes over the figure’s time, a cascade when there are many', () => {
    assert.deepEqual(lineMotion.stagger(0), []);
    assert.deepEqual(lineMotion.stagger(1), [0]);
    const few = lineMotion.stagger(3);
    assert.equal(few[0], 0);
    assert.ok(few[2] <= lineMotion.DRAW_MS - lineMotion.STROKE_MS);
    const many = lineMotion.stagger(40);
    assert.equal(many.length, 40);
    assert.ok(many[1] - many[0] <= lineMotion.STROKE_MS * 0.6 + 1);
    assert.ok(many[39] <= lineMotion.DRAW_MS - lineMotion.STROKE_MS + 1);
    assert.ok(many.every((d, i) => i === 0 || d >= many[i - 1]));
  });
});

describe('a picture made for the page', () => {
  it('asks for what must be shown, in a style a generator does well, with no text', () => {
    const prompt = generated.illustrationPrompt('mitochondrion micrograph', 'a mitochondrion with its folded inner membrane');
    assert.match(prompt, /^a mitochondrion with its folded inner membrane, mitochondrion micrograph\. /);
    assert.match(prompt, /no text, no labels/);
    assert.ok(generated.illustrationPrompt('x', 'x').startsWith('x. '), 'the same words once');
  });
  it('addresses Pollinations with the prompt, a size and a seed, the same seed for the same ask', () => {
    const url = new URL(generated.generatedImageUrl('a red cube', { seed: 7 }));
    assert.equal(url.origin, generated.POLLINATIONS_HOST);
    assert.equal(decodeURIComponent(url.pathname), '/prompt/a red cube');
    assert.equal(url.searchParams.get('seed'), '7');
    assert.equal(url.searchParams.get('model'), 'flux');
    assert.equal(url.searchParams.get('nologo'), 'true');
    assert.equal(generated.seedFor('abc'), generated.seedFor('abc'));
    assert.notEqual(generated.seedFor('abc'), generated.seedFor('abc', 1));
    assert.ok(generated.seedFor('anything') < 1_000_000);
  });
});

describe('where the Studios are', () => {
  it('reads the map\'s word on which pages get a Studio, on pages only', () => {
    const map = learn.parseMap('{"stages":["A"],"nodes":[{"title":"One","studio":"a point descending a loss surface"},{"title":"Two"},{"title":"Three","kind":"paper","studio":"nothing"}]}');
    assert.equal(map.nodes[0].studio, 'a point descending a loss surface');
    assert.equal(map.nodes[1].studio, undefined);
    assert.equal(map.nodes[2].studio, undefined, 'a paper has no Studio');
    assert.match(learn.MAP_SYSTEM, /"studio": one phrase of what its Studio will show/);
  });
  it('tells a written scene from a planned one, for the map', () => {
    const track = {
      nodes: [
        { id: 'a', kind: 'page', studio: 'planned' },
        { id: 'b', kind: 'page', studio: 'planned too' },
        { id: 'c', kind: 'page' },
        { id: 'd', kind: 'page' },
      ],
      pages: {
        b: { content: '## One\n\nProse.\n\n```studio title="x"\n{"slots":["a","b"],"show":{"kind":"bars","values":[[1]]}}\n```\n' },
        c: { content: '## One\n\n```studio title="x"\n{"slots":["a","b"]' },
        d: { content: '## One\n\n```studio title="x"\n{"slots":["a","b"],"show":{"kind":"bars","values":[[1]]}}\n```\n' },
      },
    };
    const scenes = learn.sceneNodes(track);
    assert.equal(scenes.get('a'), 'planned');
    assert.equal(scenes.get('b'), 'written', 'written wins over planned');
    assert.equal(scenes.get('c'), undefined, 'a fence still open is not written');
    assert.equal(scenes.get('d'), 'written', 'written even when the map did not plan it');
  });
});
