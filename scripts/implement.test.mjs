// The Implementation page, without a browser or a key: how the plan's own
// blocks are read (a tree, starter files, the compute budget), how the budget
// becomes hours and dollars on a machine, how the scaffold becomes a zip, a
// notebook and a commit's worth of files, and how a detected card is matched.
//
//   node --test scripts/implement.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { cleanup, loadTogether } from './bundle.mjs';

const lib = await loadTogether(['src/lib/explain.ts', 'src/lib/implement.ts', 'src/lib/hardware.ts', 'src/lib/zip.ts'], { external: ['@anthropic-ai/sdk'] });
const PAGE = await readFile(new URL('./fixtures/implement-minitron.md', import.meta.url), 'utf8');
const REVISION = await readFile(new URL('./fixtures/implement-revise-dataset.md', import.meta.url), 'utf8');

after(cleanup);

describe('the instructions', () => {
  it('ask for the blocks the page draws, and for FLOPs rather than hours', () => {
    assert.match(lib.IMPLEMENT_SYSTEM, /```tree/);
    assert.match(lib.IMPLEMENT_SYSTEM, /```file path=/);
    assert.match(lib.IMPLEMENT_SYSTEM, /```compute/);
    assert.match(lib.IMPLEMENT_SYSTEM, /do NOT put\s+hours in the block/);
    assert.match(lib.IMPLEMENT_SYSTEM, /Never invent datasets/);
  });
});

describe('reading the plan', () => {
  const sections = lib.parseExplanation(PAGE);
  const blocks = sections.flatMap((s) => s.blocks);
  it('finds the ten sections in the order asked for', () => {
    assert.deepEqual(
      sections.map((s) => s.title),
      ['At a glance', 'What to build, and what to leave out', 'Datasets', 'Repository layout', 'Starter files', 'The pipeline, step by step', 'Compute budget', 'Constraints and pitfalls', 'Evaluation', 'Milestones'],
    );
  });
  it('reads the tree, the starter files and the budget as their own blocks', () => {
    assert.equal(blocks.filter((b) => b.kind === 'tree').length, 1);
    const files = blocks.filter((b) => b.kind === 'file');
    assert.deepEqual(
      files.map((f) => f.path),
      ['configs/prune_width_0.8b.yaml', 'minitron/importance.py', 'minitron/distill.py', 'minitron/train.py', 'configs/distill.yaml', 'Makefile'],
    );
    assert.deepEqual(
      files.map((f) => f.lang),
      ['yaml', 'python', 'python', 'python', 'yaml', 'bash'],
    );
    assert.equal(blocks.filter((b) => b.kind === 'compute').length, 1);
  });
  it('makes a titled bash fence a shell cell, and leaves a plain one as Markdown', () => {
    const shells = blocks.filter((b) => b.kind === 'code' && b.lang === 'bash');
    assert.equal(shells.length, 2);
    assert.ok(shells[0].output?.includes('244,140 sequences'), 'the output fence attaches to the shell cell');
    const [section] = lib.parseExplanation('## A\n```bash\nls\n```\ntext');
    assert.equal(section.blocks[0].kind, 'prose');
    assert.match(section.blocks[0].md, /```bash\nls\n```/);
  });
  it('still reads figures, python cells and caveats', () => {
    assert.equal(blocks.filter((b) => b.kind === 'figure').length, 1);
    assert.equal(blocks.filter((b) => b.kind === 'code' && b.lang === 'python').length, 1);
    assert.equal(lib.caveatsOf(sections).length, 1);
  });
  it('keeps a file still streaming open, and out of the scaffold', () => {
    const [section] = lib.parseExplanation('## Starter files\n```file path="a.py"\nprint(1)');
    assert.equal(section.blocks[0].open, true);
    assert.deepEqual(lib.starterFiles([section]), {});
  });
  it('colours a file by its name', () => {
    assert.equal(lib.langOf('src/train.py'), 'python');
    assert.equal(lib.langOf('Makefile'), 'bash');
    assert.equal(lib.langOf('configs/a.yaml'), 'yaml');
    assert.equal(lib.langOf('README.md'), 'markdown');
  });
});

describe('the tree', () => {
  it('reads box-drawing indentation, directories and notes', () => {
    const rows = lib.parseTree(['repo/', '├── configs/            # the numbers', '│   └── a.yaml', '├── src/', '│   ├── model.py  # Eq. 1', '│   └── train.py', '└── README.md'].join('\n'));
    assert.deepEqual(
      rows.map((r) => [r.depth, r.name, r.dir, r.note]),
      [
        [0, 'repo/', true, ''],
        [1, 'configs/', true, 'the numbers'],
        [2, 'a.yaml', false, ''],
        [1, 'src/', true, ''],
        [2, 'model.py', false, 'Eq. 1'],
        [2, 'train.py', false, ''],
        [1, 'README.md', false, ''],
      ],
    );
  });
  it('reads plain two-space indentation too', () => {
    const rows = lib.parseTree('repo/\n  src/\n    a.py\n  b.py');
    assert.deepEqual(
      rows.map((r) => r.depth),
      [0, 1, 2, 1],
    );
  });
  it('reads the fixture’s tree', () => {
    const tree = lib.parseExplanation(PAGE).flatMap((s) => s.blocks).find((b) => b.kind === 'tree');
    const rows = lib.parseTree(tree.text);
    assert.equal(rows[0].name, 'minitron-repro/');
    assert.ok(rows.some((r) => r.name === 'importance.py' && r.depth === 2 && /Eq\. 1–3/.test(r.note)));
  });
});

describe('the compute budget', () => {
  const compute = lib.computeOf(lib.parseExplanation(PAGE));
  it('reads the block', () => {
    assert.equal(compute.paramsB, 0.8);
    assert.equal(compute.phases.length, 4);
    assert.equal(compute.phases[0].parallel, false);
    assert.equal(compute.phases[3].h100Hours, 0.5);
    assert.equal(compute.minVramGb, 22);
  });
  it('reads numbers written as strings, and gives up on half a block', () => {
    assert.equal(lib.parseCompute('{"phases":[{"name":"x","flops":"3e19"}]}').phases[0].flops, 3e19);
    assert.equal(lib.parseCompute('{"phases":[{"name":'), null);
  });
  it('turns FLOPs into hours on the card, and scales with cards and utilisation', () => {
    const t4 = lib.estimate(compute, { ...lib.DEFAULT_HARDWARE, gpu: 'colab-t4', count: 1, mfu: 0.35 });
    const distil = t4.phases[2];
    // 7.8e18 / (65e12 × 0.35) seconds — times 2.5, since 22 GB only fits a 16 GB card with offloading
    assert.equal(distil.fit, 'tight');
    assert.ok(Math.abs(distil.hours - (2.5 * 7.8e18) / (65e12 * 0.35) / 3600) < 1e-6);
    const h100 = lib.estimate(compute, { ...lib.DEFAULT_HARDWARE, gpu: 'h100', count: 1, mfu: 0.35 });
    assert.ok(h100.phases[2].hours < 8 && h100.phases[2].hours > 5, `${h100.phases[2].hours} h on an H100`);
    const eight = lib.estimate(compute, { ...lib.DEFAULT_HARDWARE, gpu: 'h100', count: 8, mfu: 0.35 });
    assert.ok(Math.abs(eight.phases[2].hours * 8 - h100.phases[2].hours) < 1e-9, 'data-parallel phases divide by the cards');
    assert.equal(eight.phases[0].hours, h100.phases[0].hours, 'a serial phase does not');
  });
  it('converts H100-hours by the card’s peak', () => {
    const a100 = lib.estimate(compute, { ...lib.DEFAULT_HARDWARE, gpu: 'a100-80', count: 1 });
    assert.ok(Math.abs(a100.phases[3].hours - 0.5 * (989 / 312)) < 1e-9);
  });
  it('says whether it fits, and charges for the tricks it needs', () => {
    assert.equal(lib.estimate(compute, { ...lib.DEFAULT_HARDWARE, gpu: 'colab-t4' }).fit, 'tight');
    assert.equal(lib.estimate(compute, { ...lib.DEFAULT_HARDWARE, gpu: 'a100-80' }).fit, 'fits');
    assert.equal(lib.estimate(compute, { ...lib.DEFAULT_HARDWARE, gpu: 'rtx-3090', count: 2 }).fit, 'sharded');
    assert.equal(lib.estimate(compute, { ...lib.DEFAULT_HARDWARE, gpu: 'cpu' }).fit, 'no');
    const tight = lib.estimate(compute, { ...lib.DEFAULT_HARDWARE, gpu: 'colab-t4', mfu: 0.35 });
    const roomy = lib.estimate({ ...compute, phases: compute.phases.map((p) => ({ ...p, memoryGb: 1 })), minVramGb: 1 }, { ...lib.DEFAULT_HARDWARE, gpu: 'colab-t4', mfu: 0.35 });
    assert.ok(tight.phases[2].hours > roomy.phases[2].hours * 2, 'offloading costs time');
  });
  it('counts Colab sessions, cost, disk and RAM', () => {
    const t4 = lib.estimate(compute, { ...lib.DEFAULT_HARDWARE, gpu: 'colab-t4', diskGb: 20, ramGb: 8 });
    assert.ok(t4.sessions > 1);
    assert.equal(t4.usd, 0);
    assert.equal(t4.disk, 'no');
    assert.equal(t4.ram, 'no');
    const h100 = lib.estimate(compute, { ...lib.DEFAULT_HARDWARE, gpu: 'h100', count: 2 });
    assert.equal(h100.sessions, undefined);
    assert.ok(Math.abs(h100.usd - h100.hours * 3 * 2) < 1e-9);
  });
  it('words hours, dollars and FLOPs the way a person would', () => {
    assert.equal(lib.hoursText(0.5), '30 min');
    assert.equal(lib.hoursText(3.25), '3.3 h');
    assert.equal(lib.hoursText(30), '30 h');
    assert.equal(lib.hoursText(120), '5 days');
    assert.equal(lib.hoursText(24 * 21), '3 weeks');
    assert.equal(lib.usdText(0), 'free');
    assert.equal(lib.usdText(1234.5), '$1,235');
    assert.equal(lib.flopsText(7.8e18), '7.8 EFLOP');
    assert.equal(lib.flopsText(1.3e16), '13 PFLOP');
  });
  it('keeps a machine within the catalogue', () => {
    const fixed = lib.normaliseHardware({ gpu: 'nope', count: 9, ramGb: -1, diskGb: 100, mfu: 2, hoursPerDay: 0 });
    assert.equal(fixed.gpu, 'colab-t4');
    assert.equal(fixed.count, 1);
    assert.equal(fixed.mfu, 0.8);
    assert.equal(fixed.hoursPerDay, 1);
    assert.equal(lib.normaliseHardware({ ...lib.DEFAULT_HARDWARE, gpu: 'h100', count: 9 }).count, 8);
  });
  it('matches a card the proxy found to the catalogue', () => {
    assert.equal(lib.matchGpu('NVIDIA GeForce RTX 4090', 24).id, 'rtx-4090');
    assert.equal(lib.matchGpu('NVIDIA H100 80GB HBM3', 80).id, 'h100');
    assert.equal(lib.matchGpu('Tesla T4', 15).id, 'colab-t4');
    assert.equal(lib.matchGpu('NVIDIA RTX A6000', 48).id, 'rtx-5090', 'an unknown card goes by the nearest memory');
    assert.equal(lib.matchGpu('Something', undefined), null);
  });
});

describe('the scaffold', () => {
  const sections = lib.parseExplanation(PAGE);
  const title = 'Compact Language Models via Pruning and Knowledge Distillation';
  it('collects the starter files by path', () => {
    const files = lib.starterFiles(sections);
    assert.equal(Object.keys(files).length, 6);
    assert.match(files['minitron/distill.py'], /def logit_kl/);
    assert.ok(files['Makefile'].endsWith('\n'));
  });
  it('puts them, the plan and the notebook under one folder', () => {
    const { folder, files } = lib.scaffold(title, PAGE, sections);
    assert.equal(folder, 'implementations/compact-language-models-via-pruning-and-knowledge');
    assert.ok(files[`${folder}/PLAN.md`].startsWith('# Compact Language Models'));
    assert.ok(files[`${folder}/compact-language-models-via-pruning-and-knowledge.ipynb`]);
    assert.equal(Object.keys(files).length, 8);
  });
  it('writes a notebook whose first cells lay the directories and files out', () => {
    const book = JSON.parse(lib.scaffoldNotebook(title, sections));
    assert.equal(book.cells[0].cell_type, 'markdown');
    const dirs = book.cells[1].source.join('');
    assert.match(dirs, /os\.makedirs/);
    assert.match(dirs, /"configs"/);
    assert.match(dirs, /"minitron"/);
    const writes = book.cells.filter((c) => c.cell_type === 'code' && c.source[0].startsWith('%%writefile'));
    assert.equal(writes.length, 6);
    assert.equal(writes[0].source[0], '%%writefile configs/prune_width_0.8b.yaml\n');
    const shells = book.cells.filter((c) => c.cell_type === 'code' && c.source[0].startsWith('%%bash'));
    assert.equal(shells.length, 2);
    assert.equal(book.cells.filter((c) => c.cell_type === 'code' && /^import numpy/.test(c.source[1] ?? '')).length, 1);
  });
  it('cuts the folder name at a word', () => {
    assert.equal(lib.slugOf('Attention Is All You Need'), 'attention-is-all-you-need');
    assert.equal(lib.slugOf(''), 'paper');
    assert.ok(lib.slugOf('x'.repeat(30) + ' ' + 'y'.repeat(40)).length <= 60);
  });
  it('makes a zip that unzip would read', () => {
    const bytes = lib.scaffoldZip(title, PAGE, sections);
    assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
    const end = bytes.length - 22;
    assert.deepEqual([...bytes.slice(end, end + 4)], [0x50, 0x4b, 0x05, 0x06]);
    const entries = new DataView(bytes.buffer, bytes.byteOffset).getUint16(end + 10, true);
    assert.equal(entries, 8);
    const text = new TextDecoder().decode(bytes);
    assert.ok(text.includes('compact-language-models-via-pruning-and-knowledge/Makefile'), 'paths lose the implementations/ prefix');
  });
  it('checks CRC-32 the standard way', () => {
    assert.equal(lib.crc32(new TextEncoder().encode('123456789')).toString(16), 'cbf43926');
  });
  it('makes the Colab link for a file in the repository', () => {
    assert.equal(lib.colabUrl('me', 'papers', 'main', 'implementations/x/x.ipynb'), 'https://colab.research.google.com/github/me/papers/blob/main/implementations/x/x.ipynb');
  });
});

describe('a request from the bar', () => {
  it('replaces the section, shell cell and output included', () => {
    const out = lib.applyEdits(PAGE, REVISION, 'Datasets');
    assert.deepEqual(out.touched, ['Datasets']);
    assert.match(out.note, /stream/);
    const sections = lib.parseExplanation(out.content);
    const datasets = sections.find((s) => s.title === 'Datasets');
    const shell = datasets.blocks.find((b) => b.kind === 'code');
    assert.match(shell.code, /--streaming/);
    assert.match(shell.output, /41 min/);
    assert.equal(sections.length, 10);
  });
});
