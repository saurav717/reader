// Compiling on GitHub: the files the Worker takes for a job (worker/latex.js),
// and the errors read out of the log that comes back (src/lib/latexGithub.ts).
//
//   node --test scripts/latex-github.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';
import { cleanFiles, isLatexPath } from '../worker/latex.js';

const gh = await load('src/lib/latexGithub.ts');
after(cleanup);

describe('a job’s files', () => {
  it('takes relative paths as base64, and nothing that climbs out', () => {
    assert.deepEqual(cleanFiles([{ path: '/paper/main.tex', base64: 'XGRvYw==' }]), [{ path: 'paper/main.tex', base64: 'XGRvYw==' }]);
    assert.equal(cleanFiles([{ path: '../etc/passwd', base64: '' }]), null);
    assert.equal(cleanFiles([{ path: 'a//b.tex', base64: '' }]), null);
    assert.equal(cleanFiles([{ path: 'main.tex', base64: 'not base64!' }]), null);
    assert.equal(cleanFiles('nope'), null);
    assert.equal(cleanFiles([{ path: 'big.pdf', base64: 'A'.repeat(28 * 1024 * 1024) }]), null);
  });

  it('knows its routes', () => {
    assert.ok(isLatexPath('/latex/jobs'));
    assert.ok(isLatexPath('/latex/runner/abc/source'));
    assert.ok(!isLatexPath('/latexy'));
  });
});

describe('the log', () => {
  it('reads located errors, bare ! errors with their line, and warnings', () => {
    const log = [
      './main.tex:16: LaTeX Error: File `physics.sty\' not found.',
      '! Undefined control sequence.',
      'l.42 \\secondinstitute',
      'LaTeX Warning: Citation `oda\' on page 3 undefined on input line 120.',
      'Package hyperref Warning: Token not allowed in a PDF string.',
    ].join('\n');
    const read = gh.readTexLog(log);
    assert.deepEqual(read.errors, [
      { file: 'main.tex', line: 16, message: "LaTeX Error: File `physics.sty' not found." },
      { file: '', line: 42, message: 'Undefined control sequence.' },
    ]);
    assert.deepEqual(read.warnings.map((item) => item.line), [120, null]);
  });
});
