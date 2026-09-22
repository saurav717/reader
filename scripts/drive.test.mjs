// The Drive mirror: the folder a paper lands in, and what happens to a library
// that was synced under the older one-folder-per-collection layout. Drive is
// stubbed — these assertions are about the requests we make, not about Google
// being reachable.
//
//   node --test scripts/drive.test.mjs

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const { syncPaperToDrive, driveFolderUrl, ROOT_FOLDER } = await load('src/lib/driveSync.ts');

const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  await cleanup();
});

const paper = (overrides = {}) => ({
  id: 'arxiv:2010.08895',
  source: 'arxiv',
  title: 'Fourier Neural Operator for Parametric PDEs',
  authors: ['Zongyi Li'],
  abstract: 'An operator learning method.',
  published: '2020-10-18',
  categories: ['cs.LG'],
  arxivId: '2010.08895',
  addedAt: '2024-01-01T00:00:00.000Z',
  collectionIds: ['c1'],
  tags: [],
  progress: 0,
  ...overrides,
});

const STEM = 'Fourier Neural Operator for Parametric PDEs (arXiv 2010.08895)';

const settings = {
  googleClientId: 'test-client',
  driveFolderName: ROOT_FOLDER,
  savePdf: true,
};

const context = (overrides = {}) => ({
  collections: [{ id: 'c1', name: 'Operator learning', color: '#000', createdAt: '2024-01-01' }],
  highlights: [],
  settings,
  ...overrides,
});

/**
 * A Drive with folders and files in it. Names are unique per parent, which is
 * all the code relies on, and every request made is recorded for inspection.
 */
function stubDrive() {
  const folders = new Map(); // `${parent}/${name}` -> id
  const files = new Map(); // id -> { name, parents }
  const calls = [];
  let next = 0;
  const id = (prefix) => `${prefix}-${++next}`;

  // The token comes from Google Identity Services, which does not exist here.
  globalThis.window = {
    google: {
      accounts: {
        oauth2: {
          initTokenClient: ({ callback }) => ({
            requestAccessToken: () =>
              callback({ access_token: 'token', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file' }),
          }),
        },
      },
    },
  };
  globalThis.document = { querySelector: () => ({}), head: { appendChild() {} }, createElement: () => ({ addEventListener() {} }) };

  const json = (body) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

  globalThis.fetch = async (url, init = {}) => {
    const request = new URL(String(url));
    const method = init.method || 'GET';
    calls.push({ method, url: String(url) });

    // A query: folder lookup, or a file lookup by name and parent.
    if (method === 'GET' && request.searchParams.has('q')) {
      const q = request.searchParams.get('q');
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1].replace(/\\'/g, "'");
      const parent = /'([^']+)' in parents/.exec(q)?.[1] ?? 'root';
      if (q.includes('vnd.google-apps.folder')) {
        const found = folders.get(`${parent}/${name}`);
        return json({ files: found ? [{ id: found, name }] : [] });
      }
      const match = [...files].find(([, file]) => file.name === name && file.parents.includes(parent));
      return json({ files: match ? [{ id: match[0], name, webViewLink: `link:${match[0]}` }] : [] });
    }

    // Reading one file's parents, before a move.
    if (method === 'GET' && /\/drive\/v3\/files\/[^?]+/.test(request.pathname)) {
      const fileId = decodeURIComponent(request.pathname.split('/').pop());
      const file = files.get(fileId);
      if (!file) return new Response('not found', { status: 404 });
      return json({ id: fileId, name: file.name, webViewLink: `link:${fileId}`, parents: file.parents });
    }

    // Creating a folder.
    if (method === 'POST' && request.pathname === '/drive/v3/files') {
      const body = JSON.parse(init.body);
      const created = id('folder');
      folders.set(`${body.parents?.[0] ?? 'root'}/${body.name}`, created);
      return json({ id: created });
    }

    // Uploading, new or replacing.
    if (request.pathname.startsWith('/upload/drive/v3/files')) {
      const metadata = JSON.parse(await init.body.get('metadata').text());
      if (method === 'PATCH') {
        const fileId = decodeURIComponent(request.pathname.split('/').pop());
        const file = files.get(fileId);
        if (!file) return new Response('not found', { status: 404 });
        file.name = metadata.name;
        return json({ id: fileId, name: file.name, webViewLink: `link:${fileId}` });
      }
      const fileId = id('file');
      files.set(fileId, { name: metadata.name, parents: metadata.parents ?? [] });
      return json({ id: fileId, name: metadata.name, webViewLink: `link:${fileId}` });
    }

    // Moving: add the new parent, drop the old ones.
    if (method === 'PATCH' && /\/drive\/v3\/files\//.test(request.pathname)) {
      const fileId = decodeURIComponent(request.pathname.split('/').pop());
      const file = files.get(fileId);
      if (!file) return new Response('not found', { status: 404 });
      const remove = (request.searchParams.get('removeParents') || '').split(',').filter(Boolean);
      file.parents = [...file.parents.filter((parent) => !remove.includes(parent)), request.searchParams.get('addParents')];
      return json({ id: fileId, name: file.name, webViewLink: `link:${fileId}` });
    }

    throw new Error(`unstubbed ${method} ${url}`);
  };

  return {
    calls,
    folders,
    files,
    folderId: (parent, name) => folders.get(`${parent}/${name}`),
    addFile: (fileId, name, parent) => files.set(fileId, { name, parents: [parent] }),
  };
}

describe('the folder a paper lands in', () => {
  let drive;
  beforeEach(() => {
    drive = stubDrive();
  });

  it('is one of its own, inside the collection root', async () => {
    const result = await syncPaperToDrive(paper(), context({ pdf: new Blob(['%PDF-1.4']) }));

    const rootId = drive.folderId('root', ROOT_FOLDER);
    assert.ok(rootId, `expected a top-level ${ROOT_FOLDER} folder`);
    assert.equal(result.folderId, drive.folderId(rootId, STEM));
    assert.equal(result.folderName, STEM);
    assert.equal(result.folderLink, driveFolderUrl(result.folderId));
  });

  it('is named after the paper, not after a collection it happens to be in', async () => {
    const result = await syncPaperToDrive(paper(), context({ pdf: new Blob(['%PDF-1.4']) }));
    const rootId = drive.folderId('root', ROOT_FOLDER);
    assert.equal(drive.folderId(rootId, 'Operator learning'), undefined);
    assert.equal(result.folderName, STEM);
  });

  it('holds the PDF and the sidecar', async () => {
    const result = await syncPaperToDrive(paper(), context({ pdf: new Blob(['%PDF-1.4']) }));
    assert.ok(result.pdfFileId, 'expected the PDF to be uploaded');
    assert.ok(result.metaFileId, 'expected the sidecar to be uploaded');

    const uploads = drive.calls.filter((call) => call.url.includes('/upload/drive/v3/files'));
    assert.equal(uploads.length, 2);
  });

  it('is the same folder on a second sync, and the PDF is not uploaded twice', async () => {
    const first = await syncPaperToDrive(paper(), context({ pdf: new Blob(['%PDF-1.4']) }));
    const synced = paper({
      drive: {
        folderId: first.folderId,
        pdfFileId: first.pdfFileId,
        pdfLink: first.pdfLink,
        metaFileId: first.metaFileId,
      },
    });

    drive.calls.length = 0;
    const second = await syncPaperToDrive(synced, context({ pdf: new Blob(['%PDF-1.4']) }));

    assert.equal(second.folderId, first.folderId);
    assert.equal(second.pdfFileId, first.pdfFileId);
    const uploads = drive.calls.filter((call) => call.url.includes('/upload/drive/v3/files'));
    assert.equal(uploads.length, 1, 'only the sidecar should be rewritten');
  });
});

describe('a library synced under the older layout', () => {
  let drive;
  beforeEach(() => {
    drive = stubDrive();
  });

  it('has its files moved into the paper folder rather than uploaded again', async () => {
    // As the previous layout left it: a folder named after the collection,
    // holding both files.
    drive.folders.set(`root/${ROOT_FOLDER}`, 'old-root');
    drive.folders.set('old-root/Operator learning', 'old-folder');
    drive.addFile('old-pdf', `${STEM}.pdf`, 'old-folder');
    drive.addFile('old-meta', `${STEM}.json`, 'old-folder');

    const result = await syncPaperToDrive(
      paper({ drive: { folderId: 'old-folder', pdfFileId: 'old-pdf', metaFileId: 'old-meta' } }),
      context(),
    );

    const paperFolder = drive.folderId('old-root', STEM);
    assert.equal(result.folderId, paperFolder);
    assert.equal(result.pdfFileId, 'old-pdf', 'the PDF should be the same file, moved');
    assert.deepEqual(drive.files.get('old-pdf').parents, [paperFolder]);
    assert.deepEqual(drive.files.get('old-meta').parents, [paperFolder]);

    const uploads = drive.calls.filter((call) => call.url.includes('/upload/drive/v3/files'));
    assert.equal(uploads.length, 1, 'only the sidecar should be rewritten');
  });

  it('starts over for a file that has since been deleted by hand', async () => {
    drive.folders.set(`root/${ROOT_FOLDER}`, 'old-root');
    drive.folders.set('old-root/Operator learning', 'old-folder');

    const result = await syncPaperToDrive(
      paper({ drive: { folderId: 'old-folder', pdfFileId: 'gone', metaFileId: 'gone-too' } }),
      context({ pdf: new Blob(['%PDF-1.4']) }),
    );

    assert.equal(result.folderId, drive.folderId('old-root', STEM));
    assert.notEqual(result.pdfFileId, 'gone');
    assert.ok(result.pdfFileId, 'expected a fresh PDF to be uploaded');
    assert.notEqual(result.metaFileId, 'gone-too');
  });
});
