// Compiling on GitHub: the workflow Reader writes, the branch a project
// compiles on, and the errors read out of the log that comes back.
//
//   node --test scripts/latex-github.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const gh = await load('src/lib/latexGithub.ts');
after(cleanup);

describe('the workflow', () => {
  it('compiles a push to reader/** with all of TeX Live and hands the PDF back on reader-pdf/**', () => {
    const text = gh.workflow();
    assert.match(text, /branches: \['reader\/\*\*'\]/);
    assert.match(text, /cancel-in-progress: true/);
    assert.match(text, /contents: write/);
    assert.ok(text.includes(gh.TEXLIVE_IMAGE));
    assert.match(text, /set \+e/);
    assert.match(text, /latexmk "\$FLAG" -cd -g -f/);
    assert.match(text, /BRANCH="reader-pdf\/\$\{GITHUB_REF_NAME#reader\/\}"/);
    assert.match(text, /\$\{\{ github\.token \}\}/);
    assert.ok(text.includes(`(version ${gh.WORKFLOW_VERSION})`));
  });

  it('names a branch git allows for any project id', () => {
    assert.equal(gh.branchFor('119e7355-6a93-419b-8896-e95ebc42ae80'), 'reader/119e7355-6a93-419b-8896-e95ebc42ae80');
    assert.equal(gh.branchFor('a b/c:d'), 'reader/a-b-c-d');
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
