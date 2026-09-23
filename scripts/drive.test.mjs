// The Drive mirror: the folder a paper lands in, and what happens to a library
// that was synced under the older one-folder-per-collection layout. Drive is
// stubbed — these assertions are about the requests we make, not about Google
// being reachable.
//
//   node --test scripts/drive.test.mjs

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, loadTogether } from './bundle.mjs';

// The sync and the reader's fetch share one Google module — one token, one
// stubbed Drive — so what one puts there the other can find.
const {
  syncPaperToDrive,
  driveFolderUrl,
  ROOT_FOLDER,
  JUNK_FOLDER,
  whySaveToDriveUnavailable,
  junkPaperInDrive,
  describeRemovalInDrive,
  isInDrive,
  fetchPaperPdf,
  findPdfInDrive,
} = await loadTogether(['src/lib/driveSync.ts', 'src/lib/pdf.ts']);

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
  const folderById = (folderId) => {
    const entry = [...folders].find(([, id]) => id === folderId);
    if (!entry) return null;
    const [parent, name] = entry[0].split(/\/(.*)/s);
    return { parent, name };
  };

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

    // Reading one file's parents, before a move. A folder is a file too.
    if (method === 'GET' && /\/drive\/v3\/files\/[^?]+/.test(request.pathname)) {
      const fileId = decodeURIComponent(request.pathname.split('/').pop());
      const file = files.get(fileId);
      // The bytes themselves, for the reader opening a paper on its copy here.
      if (request.searchParams.get('alt') === 'media') {
        if (!file) return new Response('not found', { status: 404 });
        return new Response(file.bytes ?? '%PDF-1.4 stub', { headers: { 'Content-Type': 'application/pdf' } });
      }
      if (file) return json({ id: fileId, name: file.name, webViewLink: `link:${fileId}`, parents: file.parents });
      const folder = folderById(fileId);
      if (!folder) return new Response('not found', { status: 404 });
      return json({ id: fileId, name: folder.name, webViewLink: `link:${fileId}`, parents: [folder.parent] });
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
      const bytes = await init.body.get('file').text();
      files.set(fileId, { name: metadata.name, parents: metadata.parents ?? [], bytes });
      return json({ id: fileId, name: metadata.name, webViewLink: `link:${fileId}` });
    }

    // Moving: add the new parent, drop the old ones.
    if (method === 'PATCH' && /\/drive\/v3\/files\//.test(request.pathname)) {
      const fileId = decodeURIComponent(request.pathname.split('/').pop());
      const file = files.get(fileId);
      const remove = (request.searchParams.get('removeParents') || '').split(',').filter(Boolean);
      if (file) {
        file.parents = [...file.parents.filter((parent) => !remove.includes(parent)), request.searchParams.get('addParents')];
        return json({ id: fileId, name: file.name, webViewLink: `link:${fileId}` });
      }
      const folder = folderById(fileId);
      if (!folder) return new Response('not found', { status: 404 });
      folders.delete(`${folder.parent}/${folder.name}`);
      folders.set(`${request.searchParams.get('addParents')}/${folder.name}`, fileId);
      return json({ id: fileId, name: folder.name, webViewLink: `link:${fileId}` });
    }

    throw new Error(`unstubbed ${method} ${url}`);
  };

  return {
    calls,
    folders,
    files,
    folderId: (parent, name) => folders.get(`${parent}/${name}`),
    parentOfFolder: (folderId) => folderById(folderId)?.parent,
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

// What a search result says instead of offering to save. The button stays on
// the result whether or not it can run — it is the only place a reader is
// asking the question — so something has to say why it is greyed out, and
// "Drive is not connected" and "this deployment has no proxy" are fixed in
// different places.
describe('why Save to Drive is not offered', () => {
  it('says nothing when Drive and a proxy are both there', () => {
    assert.equal(whySaveToDriveUnavailable({ driveConnected: true, proxyReady: true }), null);
  });

  it('names the consent when only Drive is missing', () => {
    const reason = whySaveToDriveUnavailable({ driveConnected: false, proxyReady: true });
    assert.match(reason, /Connect Drive/);
    assert.doesNotMatch(reason, /proxy/i, 'the proxy is fine — mentioning it sends the reader nowhere');
  });

  it('explains the missing bytes when only the proxy is', () => {
    const reason = whySaveToDriveUnavailable({ driveConnected: true, proxyReady: false });
    assert.match(reason, /Paper proxy/);
    // The whole confusion this answers: the copies are listed and they open.
    assert.match(reason, /navigation/);
    assert.doesNotMatch(reason, /Connect Drive/);
  });

  it('names both when neither is there', () => {
    const reason = whySaveToDriveUnavailable({ driveConnected: false, proxyReady: false });
    assert.match(reason, /Drive connected and a proxy configured/);
    assert.match(reason, /no bytes to put in Drive/);
    // Both are fixed in Settings, and naming neither leaves the reader hunting.
    assert.match(reason, /Connect Drive/);
    assert.match(reason, /Paper proxy/);
  });
});

describe('removing a paper moves its copy in Drive to Junk', () => {
  let drive;
  beforeEach(() => {
    drive = stubDrive();
  });

  /** A paper as the library holds it once it has been through one sync. */
  const synced = async () => {
    const result = await syncPaperToDrive(paper(), context({ pdf: new Blob(['%PDF-1.4']) }));
    return paper({
      drive: {
        folderId: result.folderId,
        folderName: result.folderName,
        pdfFileId: result.pdfFileId,
        metaFileId: result.metaFileId,
      },
    });
  };

  it('re-parents the whole folder under <root>/Junk, PDF and sidecar inside it', async () => {
    const removed = await synced();
    const rootId = drive.folderId('root', ROOT_FOLDER);
    assert.equal(drive.parentOfFolder(removed.drive.folderId), rootId);

    drive.calls.length = 0;
    const result = await junkPaperInDrive(removed, settings);

    const junkId = drive.folderId(rootId, JUNK_FOLDER);
    assert.ok(junkId, 'expected a Junk folder inside the root');
    assert.equal(result.junkFolderId, junkId);
    assert.equal(result.junkFolderLink, driveFolderUrl(junkId));
    assert.equal(result.moved, 'folder');
    assert.equal(drive.parentOfFolder(removed.drive.folderId), junkId);
    // Nothing is deleted or uploaded: the folder moves, and its files with it.
    assert.equal(drive.calls.filter((call) => call.method === 'DELETE').length, 0);
    assert.equal(drive.calls.filter((call) => call.url.includes('/upload/')).length, 0);
    assert.deepEqual(drive.files.get(removed.drive.pdfFileId).parents, [removed.drive.folderId]);
  });

  it('leaves the same paper free to be saved again into a fresh folder', async () => {
    const removed = await synced();
    await junkPaperInDrive(removed, settings);

    const again = await syncPaperToDrive(paper(), context({ pdf: new Blob(['%PDF-1.4']) }));
    const rootId = drive.folderId('root', ROOT_FOLDER);
    assert.notEqual(again.folderId, removed.drive.folderId);
    assert.equal(drive.parentOfFolder(again.folderId), rootId);
    assert.equal(drive.parentOfFolder(removed.drive.folderId), drive.folderId(rootId, JUNK_FOLDER));
  });

  it('moves the files themselves for a library synced before papers had folders', async () => {
    const rootId = await (async () => {
      await syncPaperToDrive(paper(), context({ pdf: new Blob(['%PDF-1.4']) }));
      return drive.folderId('root', ROOT_FOLDER);
    })();
    drive.addFile('old-pdf', `${STEM}.pdf`, 'collection-folder');
    drive.addFile('old-json', `${STEM}.json`, 'collection-folder');
    const removed = paper({ drive: { pdfFileId: 'old-pdf', metaFileId: 'old-json' } });

    const result = await junkPaperInDrive(removed, settings);

    const junkId = drive.folderId(rootId, JUNK_FOLDER);
    assert.equal(result.moved, 'files');
    assert.deepEqual(drive.files.get('old-pdf').parents, [junkId]);
    assert.deepEqual(drive.files.get('old-json').parents, [junkId]);
  });

  it('is not an error when the folder was already deleted in Drive by hand', async () => {
    const removed = paper({ drive: { folderId: 'gone-by-hand', pdfFileId: 'gone-too' } });
    const result = await junkPaperInDrive(removed, settings);
    assert.equal(result.moved, 'nothing');
  });

  it('is a Drive refusal otherwise, so the paper stays in the library', async () => {
    const removed = await synced();
    const failing = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if ((init?.method || 'GET') === 'PATCH') return new Response('quota', { status: 403 });
      return failing(url, init);
    };
    await assert.rejects(junkPaperInDrive(removed, settings), /Drive request failed \(403\)/);
  });
});

describe('what the notice says about Drive before a paper is removed', () => {
  const rootName = 'My papers';

  it('knows which papers Drive holds', () => {
    assert.equal(isInDrive(paper()), false);
    assert.equal(isInDrive(paper({ drive: { error: 'failed' } })), false);
    assert.equal(isInDrive(paper({ drive: { folderId: 'f' } })), true);
    assert.equal(isInDrive(paper({ drive: { pdfFileId: 'p' } })), true);
  });

  it('says the folder goes to Junk, by name, and that it can be got back', () => {
    const notice = describeRemovalInDrive(paper({ drive: { folderId: 'f', folderName: STEM } }), {
      driveConnected: true,
      rootName,
    });
    assert.equal(notice.moves, true);
    assert.match(notice.text, new RegExp(`Its folder in Drive, ${STEM.replace(/[()]/g, '\\$&')},`));
    assert.match(notice.text, /moved to My papers\/Junk rather than deleted/);
    assert.match(notice.text, /Get it back/);
  });

  it('says the files go, for a paper synced before it had a folder', () => {
    const notice = describeRemovalInDrive(paper({ drive: { pdfFileId: 'p' } }), { driveConnected: true, rootName });
    assert.equal(notice.moves, true);
    assert.match(notice.text, /^Its files in Drive will be moved to My papers\/Junk/);
  });

  it('says nothing moves when Drive is not connected, and what to do about it', () => {
    const notice = describeRemovalInDrive(paper({ drive: { folderId: 'f' } }), { driveConnected: false, rootName });
    assert.equal(notice.moves, false);
    assert.match(notice.text, /stays where it is/);
    assert.match(notice.text, /Connect Drive first/);
  });

  it('says there is nothing to move for a paper Drive never held', () => {
    const notice = describeRemovalInDrive(paper(), { driveConnected: true, rootName });
    assert.equal(notice.moves, false);
    assert.match(notice.text, /never saved to Drive/);
  });

  it('falls back to the default root name', () => {
    const notice = describeRemovalInDrive(paper({ drive: { folderId: 'f' } }), { driveConnected: true });
    assert.match(notice.text, new RegExp(`${ROOT_FOLDER}/${JUNK_FOLDER}`));
  });
});


describe('opening a paper reads the copy in Drive first', () => {
  let drive;
  beforeEach(() => {
    drive = stubDrive();
  });
  const opts = { clientId: 'test-client', driveConnected: true, rootFolderName: ROOT_FOLDER };

  it('finds the file by name when the library has no id for it, and says where it was', async () => {
    // Saved from another browser: Drive has the file, this library does not know.
    const saved = await syncPaperToDrive(paper(), context({ pdf: new Blob(['%PDF-1.4 saved elsewhere']) }));

    drive.calls.length = 0;
    const opened = await fetchPaperPdf(paper(), opts);

    assert.equal(opened.from, 'drive');
    assert.equal(await opened.blob.text(), '%PDF-1.4 saved elsewhere');
    assert.deepEqual(opened.drive, { folderId: saved.folderId, pdfFileId: saved.pdfFileId, pdfLink: saved.pdfLink });
    // Three looks and one download; nothing created, and nothing asked of a proxy.
    assert.equal(drive.calls.filter((call) => call.method !== 'GET').length, 0);
    assert.equal(drive.calls.filter((call) => call.url.includes('alt=media')).length, 1);
    assert.ok(drive.calls.every((call) => call.url.startsWith('https://www.googleapis.com/')));
  });

  it('goes straight to the paper\'s folder when the library knows it', async () => {
    const saved = await syncPaperToDrive(paper(), context({ pdf: new Blob(['%PDF-1.4']) }));

    drive.calls.length = 0;
    const opened = await fetchPaperPdf(paper(), { ...opts, driveFolderId: saved.folderId });

    assert.equal(opened.from, 'drive');
    const looks = drive.calls.filter((call) => call.url.includes('q='));
    assert.equal(looks.length, 1, 'one look, for the file itself');
  });

  it('still opens by the id it recorded, without a look', async () => {
    const saved = await syncPaperToDrive(paper(), context({ pdf: new Blob(['%PDF-1.4']) }));

    drive.calls.length = 0;
    const opened = await fetchPaperPdf(paper(), { ...opts, driveFileId: saved.pdfFileId });

    assert.equal(opened.from, 'drive');
    assert.equal(opened.drive, undefined, 'nothing new for the library to record');
    assert.equal(drive.calls.filter((call) => call.url.includes('q=')).length, 0);
  });

  it('leaves nothing behind for a paper Drive does not have, and goes on to the copies', async () => {
    await syncPaperToDrive(paper(), context({ pdf: new Blob(['%PDF-1.4']) }));
    const other = paper({ id: 'arxiv:1706.03762', arxivId: '1706.03762', title: 'Attention Is All You Need' });

    drive.calls.length = 0;
    // No proxy in a test bundle, so no copy can answer — and the copies
    // being tried at all is what says Drive was passed over first.
    await assert.rejects(() => fetchPaperPdf(other, opts), /known cop/);

    assert.equal(drive.calls.filter((call) => call.method !== 'GET').length, 0, 'a look must not create folders');
    assert.equal(drive.folderId(drive.folderId('root', ROOT_FOLDER), 'Attention Is All You Need (arXiv 1706.03762)'), undefined);
    assert.equal(drive.calls.filter((call) => call.url.includes('alt=media')).length, 0);
  });

  it('is not asked at all when Drive is not connected', async () => {
    await assert.rejects(() => fetchPaperPdf(paper(), { ...opts, driveConnected: false }), /known cop/);
    assert.equal(drive.calls.filter((call) => call.url.includes('googleapis.com')).length, 0);
  });

  it('answers null, not a folder, when the root itself is missing', async () => {
    assert.equal(await findPdfInDrive('token', paper(), { rootFolderName: ROOT_FOLDER }), null);
    assert.equal(drive.folderId('root', ROOT_FOLDER), undefined);
  });
});
