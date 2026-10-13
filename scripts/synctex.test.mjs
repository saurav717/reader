// SyncTeX in the page: a double-click on the compiled PDF opens the line of
// LaTeX that made it. The fixture is pdfLaTeX's own .synctex.gz for this
// two-column article (paths as the GitHub runner names them), and the points
// clicked are where PDF.js draws its words.
//
//   main.tex                                   sec/intro.tex
//   5  First paragraph on line five, …         1  Intro text from the section file
//   7  \input{sec/intro}                       2  and a second line of it.
//   11 \includegraphics[width=3cm,…]{fcunam}  (a figure at the column's top)
//   14 Last words.
//
//   node --test scripts/synctex.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { cleanup, load } from './bundle.mjs';

const st = await load('src/lib/synctex.ts');
after(cleanup);

const files = ['main.tex', 'sec/intro.tex', 'repbib.bib', 'escudos/fcunam.png'];
const sync = st.parseSyncTex(await st.unzipSyncTex(new Uint8Array(readFileSync(new URL('./fixtures/synctex-two-column.synctex.gz', import.meta.url)))));

describe('SyncTeX', () => {
  it('names the inputs as the project has them', () => {
    assert.equal(st.projectFile('/tmp/job/src/./main.tex', files), 'main.tex');
    assert.equal(st.projectFile('/tmp/job/src/./sec/intro.tex', files), 'sec/intro.tex');
    assert.equal(st.projectFile('/usr/share/texlive/texmf-dist/tex/latex/base/article.cls', files), null);
    assert.equal(st.projectFile('C:\\paper\\.\\sec\\intro.tex', files), 'sec/intro.tex');
    assert.equal(st.projectFile('./main.tex', files), 'main.tex');
  });

  it('takes a word to its line, in the file it was typed in', () => {
    assert.deepEqual(st.sourceAt(sync, 1, 150, 233, files), { file: 'main.tex', line: 5 });
    assert.deepEqual(st.sourceAt(sync, 1, 150, 257, files), { file: 'sec/intro.tex', line: 1 });
    // The end of the PDF's line, typed on the file's second line.
    assert.deepEqual(st.sourceAt(sync, 1, 280, 257, files), { file: 'sec/intro.tex', line: 2 });
    assert.deepEqual(st.sourceAt(sync, 1, 100, 281, files), { file: 'main.tex', line: 14 });
  });

  it('takes the figure to its \\includegraphics', () => {
    assert.deepEqual(st.sourceAt(sync, 1, 186, 160, files), { file: 'main.tex', line: 11 });
  });

  it('a click beside the text goes to the nearest line', () => {
    assert.equal(st.sourceAt(sync, 1, 30, 234, files)?.file, 'main.tex');
    assert.equal(st.sourceAt(sync, 2, 100, 100, files), null);
  });
});
