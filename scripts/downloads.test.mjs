// The paper from your own Downloads folder: which file the watch takes, and
// which it leaves alone.
//
//   node --test scripts/downloads.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, load } from './bundle.mjs';

const { PART_FILE, watchForPdf } = await load('src/lib/downloads.ts');
after(cleanup);

/** A folder whose listing is whatever the test puts in it; a file is its name, bytes and when it was written. */
function folder(files = []) {
  const dir = {
    files,
    async *values() {
      for (const file of dir.files) {
        yield {
          kind: file.kind || 'file',
          name: file.name,
          getFile: file.unreadable
            ? async () => {
                throw new Error('being written');
              }
            : async () => new File([file.bytes ?? ''], file.name, { lastModified: file.lastModified ?? Date.now() }),
        };
      }
    },
  };
  return dir;
}

const PDF = '%PDF-1.7 a paper';

/** A watch whose looks are scripted: after each sleep, the next change to the folder is made. */
const watched = (dir, steps, options = {}) => {
  let look = 0;
  return watchForPdf(dir, {
    every: 1,
    sleep: async () => {
      steps[look]?.();
      look += 1;
      if (look > 50) throw new Error('nothing came');
    },
    ...options,
  });
};

describe('the PDF taken from the Downloads folder', () => {
  it('is a file that was not there before, once it has stopped growing, and is a PDF', async () => {
    const dir = folder([{ name: 'old.pdf', bytes: PDF, lastModified: 1 }]);
    const file = await watched(dir, [
      () => dir.files.push({ name: 'paper.pdf', bytes: '%PDF' }),
      () => (dir.files[1].bytes = PDF),
      () => undefined, // the same size twice: done
    ]);
    assert.equal(file.name, 'paper.pdf');
    assert.equal(file.size, PDF.length);
  });

  it("passes over part-files, folders, other kinds of file, an empty file, and what is not a PDF despite its name", async () => {
    const dir = folder([]);
    const file = await watched(dir, [
      () =>
        dir.files.push(
          { name: 'paper.pdf.crdownload', bytes: PDF },
          { name: 'paper.pdf.part', bytes: PDF },
          { name: 'notes', kind: 'directory' },
          { name: 'paper.html', bytes: '<html>' },
          { name: 'empty.pdf', bytes: '' },
          { name: 'login-page.pdf', bytes: '<html>Sign in</html>' },
        ),
      () => undefined,
      () => undefined,
      () => dir.files.push({ name: 'real.pdf', bytes: PDF }),
      () => undefined,
      () => undefined,
    ]);
    assert.equal(file.name, 'real.pdf');
  });

  it('takes a file that was there before only if it has been written since the watch began', async () => {
    const since = 1_000_000;
    const dir = folder([{ name: 'paper.pdf', bytes: PDF, lastModified: since - 1 }]);
    const file = await watched(dir, [() => (dir.files[0].lastModified = since + 1), () => undefined, () => undefined], { since });
    assert.equal(file.name, 'paper.pdf');
  });

  it('waits out a file that cannot be read yet', async () => {
    const dir = folder([]);
    const file = await watched(dir, [
      () => dir.files.push({ name: 'paper.pdf', bytes: PDF, unreadable: true }),
      () => (dir.files[0].unreadable = false),
      () => undefined,
      () => undefined,
    ]);
    assert.equal(file.name, 'paper.pdf');
  });

  it('stops when told to', async () => {
    const controller = new AbortController();
    const dir = folder([]);
    await assert.rejects(
      watchForPdf(dir, {
        every: 1,
        sleep: async () => controller.abort(),
        signal: controller.signal,
      }),
      (error) => error.name === 'AbortError',
    );
  });

  it("knows the browsers' part-files by name", () => {
    for (const name of ['a.pdf.crdownload', 'a.pdf.part', 'a.pdf.download', 'a.pdf.tmp']) assert.equal(PART_FILE.test(name), true, name);
    assert.equal(PART_FILE.test('a.pdf'), false);
  });
});
