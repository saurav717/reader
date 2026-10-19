// A project's data place as the compute is told it (src/lib/dataStore.ts), without a browser: the environment and
// the file beside the module for a Drive place (through a data link) and for the machine's own disk, and the line
// the briefings say.
//
//   node --test scripts/data-store.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const store = await load('src/lib/dataStore.ts', { external: ['react', '@anthropic-ai/sdk', 'pdfjs-dist/*', 'dompurify'], imports: true });
after(cleanup);

describe('the data place, as the compute is told it', () => {
  it('is a Drive link — the Worker, the move, its key and the folder — with a cache under the project’s .reader', () => {
    const link = { id: 'a'.repeat(32), key: 'k'.repeat(48), api: 'https://w.example/api', folder: 'folder123', made: Date.now() };
    const setup = store.dataSetup({ kind: 'drive' }, '/content/playgrounds/p1/', 'Colab · T4', link);
    assert.deepEqual(setup.env, { KOIOS_DATA: `drive|https://w.example/api|${'a'.repeat(32)}|${'k'.repeat(48)}|folder123|Google Drive`, KOIOS_DATA_CACHE: '/content/playgrounds/p1/.reader/data-cache' });
    assert.deepEqual(setup.config, { kind: 'drive', api: 'https://w.example/api', id: 'a'.repeat(32), key: 'k'.repeat(48), folder: 'folder123', label: 'Google Drive' });
    assert.equal(setup.link, 'https://drive.google.com/drive/folders/folder123');
    assert.match(setup.label, /^Google Drive · Koios\/Data/);
  });
  it('falls back to the machine’s disk while the link is not there yet, and names it', () => {
    const setup = store.dataSetup({ kind: 'drive' }, '/content/playgrounds/p1', 'Colab · T4');
    assert.deepEqual(setup.env, { KOIOS_DATA: 'local|/content/playgrounds/p1/.reader/data|Colab · T4', KOIOS_DATA_CACHE: '/content/playgrounds/p1/.reader/data-cache' });
    assert.deepEqual(store.dataSetup({ kind: 'machine' }, '/home/me/p1', 'Lab box').config, { kind: 'local', dir: '/home/me/p1/.reader/data', label: 'Lab box' });
  });
  it('is a computer of yours, through its Companion, under koios-data beside its playgrounds', () => {
    const setup = store.dataSetup({ kind: 'server', serverId: 's1' }, '/content/playgrounds/p1', 'Colab · T4', undefined, { url: 'https://ann-mac.example/', token: 't-1', name: 'Ann’s Mac', root: '/Users/ann/Reader', project: 'Trying-p1' });
    assert.deepEqual(setup.env, { KOIOS_DATA: 'server|https://ann-mac.example|t-1|koios-data/Trying-p1|Ann’s Mac', KOIOS_DATA_CACHE: '/content/playgrounds/p1/.reader/data-cache' });
    assert.equal(setup.label, 'Ann’s Mac · /Users/ann/Reader/koios-data/Trying-p1');
    // The computer gone from the list: the machine's disk, not a broken link.
    assert.equal(store.dataSetup({ kind: 'server', serverId: 's1' }, '/content/playgrounds/p1', 'Colab · T4', undefined, null).config.kind, 'local');
  });
  it('names the Drive folder after the project, as its Playgrounds folder is named, and says the line the briefings share', () => {
    assert.equal(store.dataFolderNameOf({ id: 'p1', title: 'Trying: Dreamer/v3?' }), 'Trying  Dreamer v3-p1');
    assert.match(store.DATA_NOTE('Google Drive'), /^Data, checkpoints and run outputs live in the project's data place — Google Drive — not on this machine's disk/);
    assert.match(store.DATA_NOTE('x'), /koios_data\.path\("datasets\/<name>"\)/);
  });
});
