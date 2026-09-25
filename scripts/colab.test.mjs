// Colab, over Drive, without a browser: the cell that reports back, the
// notebook it goes at the top of, and how what comes back — status.json,
// metrics.jsonl, the notebook's saved outputs — is read.
//
//   node --test scripts/colab.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { cleanup, loadTogether } from './bundle.mjs';

const lib = await loadTogether(['src/lib/explain.ts', 'src/lib/implement.ts', 'src/lib/colab.ts'], { external: ['@anthropic-ai/sdk'] });
const PAGE = await readFile(new URL('./fixtures/implement-minitron.md', import.meta.url), 'utf8');
const TITLE = 'Compact Language Models via Pruning and Knowledge Distillation';

after(cleanup);

describe('the notebook', () => {
  const sections = lib.parseExplanation(PAGE);
  const path = lib.runPathInColab('Papers_collection', 'compact-language-models (arXiv 2407.14679)', 'compact');
  const book = JSON.parse(lib.colabNotebook(TITLE, sections, path));
  it('puts the run where the app made its files', () => {
    assert.equal(path, '/content/drive/MyDrive/Papers_collection/compact-language-models (arXiv 2407.14679)/runs/compact');
  });
  it('reports back from its second cell, and says it is done in its last', () => {
    const reporter = book.cells[1].source.join('');
    assert.equal(book.cells[0].cell_type, 'markdown');
    assert.match(reporter, /drive\.mount\('\/content\/drive'\)/);
    assert.ok(reporter.includes(`RUN = ${JSON.stringify(path)}`));
    assert.match(reporter, /status\.json/);
    assert.match(reporter, /log\.txt/);
    assert.match(reporter, /metrics\.jsonl/);
    assert.match(reporter, /post_run_cell/);
    assert.match(reporter, /def metric\(step, \*\*values\)/);
    assert.match(book.cells.at(-1).source.join(''), /status\(state="done"\)/);
  });
  it('keeps the scaffold’s cells between them', () => {
    const writes = book.cells.filter((cell) => cell.cell_type === 'code' && cell.source[0].startsWith('%%writefile'));
    assert.equal(writes.length, 6);
    assert.ok(book.cells.findIndex((cell) => cell.source[0].startsWith('%%writefile')) > 1);
  });
});

describe('what comes back', () => {
  it('reads a status, and takes an old running one as stale', () => {
    const now = Date.parse('2026-09-25T12:00:00Z');
    const fresh = lib.parseStatus('{"state":"running","gpu":"Tesla T4, 15360 MiB","cell":3,"updated":"2026-09-25T11:55:00Z","steps":1000,"step":120}', now);
    assert.equal(fresh.state, 'running');
    assert.equal(fresh.gpu, 'Tesla T4, 15360 MiB');
    assert.equal(fresh.cell, 3);
    assert.equal(fresh.step, 120);
    const old = lib.parseStatus('{"state":"running","updated":"2026-09-25T11:00:00Z"}', now);
    assert.equal(old.state, 'stale');
    assert.equal(lib.parseStatus('', now).state, 'waiting');
    assert.equal(lib.parseStatus('{"state":"waiting"}', now).state, 'waiting');
    assert.equal(lib.parseStatus('{"state":"failed","error":"NameError: x"}', now).error, 'NameError: x');
  });
  it('reads metrics a line at a time, dropping a half-written last line', () => {
    const points = lib.parseMetrics('{"step":0,"loss":4.2}\n{"step":10,"loss":3.1,"lr":0.0001}\n{"step":20,"lo');
    assert.equal(points.length, 2);
    assert.deepEqual(points[1], { step: 10, t: undefined, values: { loss: 3.1, lr: 0.0001 } });
  });
  it('tails the log', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    assert.equal(lib.logTail(text, 3), 'line 27\nline 28\nline 29');
  });
  it('matches the notebook’s outputs to the page’s cells by title', () => {
    const notebook = JSON.stringify({
      cells: [
        { cell_type: 'markdown', source: ['# x'] },
        {
          cell_type: 'code',
          source: ['# The headline: did distillation recover what pruning lost?\n', 'import numpy as np\n'],
          outputs: [
            { output_type: 'stream', name: 'stdout', text: ['teacher ppl 9.8\n'] },
            { output_type: 'stream', name: 'stdout', text: ['recovered: 93%\n'] },
            { output_type: 'display_data', data: { 'image/png': 'iVBORw0KGgo=\n', 'text/plain': '<Figure>' } },
          ],
        },
        { cell_type: 'code', source: ['%%bash\n', '# Get the teacher\n', 'ls\n'], outputs: [{ output_type: 'error', ename: 'CalledProcessError', evalue: 'exit 1', traceback: [] }] },
        { cell_type: 'code', source: ['print(1)'], outputs: [{ output_type: 'stream', name: 'stdout', text: ['1'] }] },
      ],
    });
    const outputs = lib.parseNotebookOutputs(notebook);
    assert.deepEqual([...outputs.keys()], ['The headline: did distillation recover what pruning lost?', 'Get the teacher']);
    const headline = outputs.get('The headline: did distillation recover what pruning lost?');
    assert.equal(headline.length, 2, 'the two stream writes are one text output');
    assert.equal(headline[0].text, 'teacher ppl 9.8\nrecovered: 93%\n');
    assert.equal(headline[1].kind, 'image');
    assert.equal(headline[1].src, 'data:image/png;base64,iVBORw0KGgo=');
    assert.deepEqual(outputs.get('Get the teacher'), [{ kind: 'error', name: 'CalledProcessError', value: 'exit 1' }]);
    assert.equal(lib.parseNotebookOutputs('not json').size, 0);
  });
});
