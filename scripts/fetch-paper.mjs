/**
 * Find a paper and download it, from a terminal. No browser, no proxy, no
 * Google account.
 *
 *   node scripts/fetch-paper.mjs "attention is all you need"
 *   node scripts/fetch-paper.mjs 1706.03762
 *   node scripts/fetch-paper.mjs --doi 10.5555/3295222.3295349
 *   node scripts/fetch-paper.mjs "attention is all you need" --list
 *
 * This is the app's own resolution and download logic — `src/lib/locations.ts`
 * for where a paper lives, `server/fetchPdf.js` for getting it safely — run
 * from Node instead of from a page. Which makes it the straight answer to
 * "can this paper actually be downloaded, from this machine, right now": if
 * this works and the app does not, the problem is the proxy or the browser,
 * not the paper.
 *
 * There is no proxy in the middle here and there does not need to be. A page
 * cannot fetch arxiv.org because arxiv.org sends no CORS headers, and that is
 * the browser refusing, not the network; Node has no such rule. The PDF is
 * still fetched through the same guards the proxy uses — https only, every
 * redirect re-checked, never a private address, and the body has to really be
 * a PDF — because they are the same file.
 *
 * ## Getting it into Google Drive
 *
 * With Google Drive for desktop, a folder *is* Drive, so `--out` is the whole
 * story:
 *
 *   node scripts/fetch-paper.mjs "attention is all you need" \
 *     --out ~/"Google Drive/My Drive/Papers_collection"
 *
 * The file is named exactly as the app names it, so a paper fetched this way
 * lands where the app would have put it. Without Drive for desktop, use the
 * app's own Save to Drive: uploading needs a Google token, the app has one in
 * the browser, and nothing here should be holding a refresh token on disk.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchChecked, readPdf } from '../server/fetchPdf.js';
import { cleanup, loadTogether } from './bundle.mjs';

const UA = 'reader/0.1 (personal research reading tool)';
const dirname = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------ the arguments --

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : argv[at + 1];
};
const positional = argv.filter((arg, index) => {
  if (arg.startsWith('--')) return false;
  const before = argv[index - 1];
  return !(before && before.startsWith('--') && !['--list'].includes(before));
});

if (flag('--help') || (!positional.length && !value('--doi'))) {
  console.log(
    [
      'Find a paper and download it.',
      '',
      '  node scripts/fetch-paper.mjs "<title or topic>"',
      '  node scripts/fetch-paper.mjs <arXiv id>',
      '  node scripts/fetch-paper.mjs --doi <doi>',
      '',
      '  --out DIR     where to write it (default ./papers). Point it at your',
      '                Google Drive folder and the download goes straight there.',
      '  --email ADDR  your address: Unpaywall requires one and it is what finds',
      '                the repository copies. Also read from CONTACT_EMAIL.',
      '  --pick N      use the Nth search result rather than the first.',
      '  --list        list every copy and stop, downloading nothing.',
    ].join('\n'),
  );
  process.exit(0);
}

const QUERY = positional.join(' ').trim();
const DOI = value('--doi');
const OUT = value('--out', path.join(dirname, '..', 'papers'));
const EMAIL = value('--email', process.env.CONTACT_EMAIL || '');
const PICK = Math.max(1, Number(value('--pick', '1')) || 1);
const LIST_ONLY = flag('--list');

// ------------------------------------------------------------- the app code --

// One bundle, so that the contact address set here is the one Unpaywall's
// lookup reads: module state does not cross two separately bundled copies.
const { arxivIdFromQuery, baseName, findLocations, fromOpenAlex, search, setContactEmail } = await loadTogether([
  'src/lib/sources.ts',
  'src/lib/locations.ts',
  'src/lib/contact.ts',
  'src/lib/sidecar.ts',
]);

setContactEmail(EMAIL);
if (!EMAIL) {
  console.log(
    'No contact address given, so Unpaywall is skipped — which is where most of the\n' +
      'repository copies come from. Pass --email you@example.org for the full list.\n',
  );
}

/** What OpenAlex calls this identifier, or nothing if it cannot be asked. */
async function titleFor(key) {
  try {
    const response = await fetch(`https://api.openalex.org/works/${encodeURIComponent(key)}`);
    if (!response.ok) return null;
    return fromOpenAlex(await response.json());
  } catch {
    return null;
  }
}

const fail = (message) => {
  console.error(`\n${message}`);
  process.exitCode = 1;
};

/**
 * A paper to go and find. A DOI or an arXiv id is one already; anything else
 * is a search, against the indexes that answer without a proxy.
 */
async function resolvePaper() {
  const arxivId = QUERY && arxivIdFromQuery(QUERY);
  if (arxivId || DOI) {
    // An identifier says which paper but not what it is called, and the title
    // is what the file gets named. OpenAlex answers to either, so ask — and
    // carry on without it if that fails, rather than refusing to download a
    // paper over its filename.
    const key = arxivId ? `doi:10.48550/arXiv.${arxivId}` : `doi:${DOI}`;
    const named = await titleFor(key);
    const paper = {
      id: arxivId ? `arxiv:${arxivId}` : `doi:${DOI}`,
      source: arxivId ? 'arxiv' : 'crossref',
      // No title rather than a made-up one: `baseName` falls back to the
      // identifier, which reads better than "arXiv 170603762 (arXiv …)".
      title: named?.title || '',
      authors: named?.authors || [],
      abstract: '',
      published: named?.published || '',
      categories: [],
      ...(arxivId ? { arxivId } : { doi: DOI }),
    };
    console.log(`${paper.title || key}\n`);
    return paper;
  }

  process.stdout.write(`Searching OpenAlex, Crossref and Semantic Scholar for "${QUERY}"…\n`);
  const outcome = await search(QUERY, ['openalex', 'crossref', 'semanticscholar'], { limit: 5 });
  for (const error of outcome.errors) console.log(`  ${error.source}: ${error.message}`);
  if (!outcome.results.length) return null;

  outcome.results.slice(0, 5).forEach((paper, index) => {
    const mark = index + 1 === PICK ? '›' : ' ';
    const year = paper.published ? new Date(paper.published).getFullYear() : '';
    console.log(`${mark} ${index + 1}. ${paper.title}`);
    console.log(`     ${paper.authors.slice(0, 4).join(', ')}${year ? ` · ${year}` : ''}${paper.venue ? ` · ${paper.venue}` : ''}`);
  });
  console.log('');
  return outcome.results[PICK - 1] || null;
}

const paper = await resolvePaper().catch((error) => {
  fail(`The search itself failed: ${error.message}\nIf that is a network refusal, nothing here can reach the indexes.`);
  return null;
});

if (!paper) {
  if (process.exitCode !== 1) fail('Nothing matched.');
  await cleanup();
  process.exit(1);
}

// ----------------------------------------------------------- where it lives --

process.stdout.write('Looking for every copy…\n');
const locations = await findLocations(paper).catch((error) => {
  fail(`Could not look up where it is published: ${error.message}`);
  return [];
});

if (!locations.length) {
  fail('No copy of this paper could be found anywhere the indexes can see.');
  await cleanup();
  process.exit(1);
}

console.log(`\n${locations.length} ${locations.length === 1 ? 'copy' : 'copies'}, best first:\n`);
for (const [index, location] of locations.entries()) {
  console.log(
    `  ${String(index + 1).padStart(2)}. ${location.isPdf ? 'PDF ' : 'page'}  ${location.label}` +
      `${location.version ? `  (${location.version})` : ''}\n      ${location.url}`,
  );
}

if (LIST_ONLY) {
  await cleanup();
  process.exit(0);
}

// -------------------------------------------------------------- getting it --

console.log('\nTrying them in turn.\n');
let bytes = null;
let from = null;
const refused = [];

for (const location of locations) {
  process.stdout.write(`  ${location.label} … `);
  try {
    const { response } = await fetchChecked(location.url, { userAgent: UA });
    if (!response.ok) throw new Error(`answered ${response.status}`);
    // The same check the proxy makes: a landing page where a PDF was promised
    // is the common failure, and it has to count as one.
    bytes = await readPdf(response, response.headers.get('content-type'));
    from = location;
    console.log(`${(bytes.length / 1024).toFixed(0)} KB`);
    break;
  } catch (error) {
    console.log(error.message);
    refused.push({ location, message: error.message });
  }
}

if (!bytes) {
  fail(
    `None of the ${locations.length} copies would hand over a PDF.\n` +
      'If every line above is a refusal from the network rather than from the host —\n' +
      '"fetch failed", a 403 from a proxy — then this machine cannot reach them at all,\n' +
      'and that is the thing to fix. If they are 403s and 404s from the hosts themselves,\n' +
      'the paper is not free to read anywhere the indexes can see.',
  );
  await cleanup();
  process.exit(1);
}

await mkdir(OUT, { recursive: true });
const file = path.join(OUT, `${baseName(paper)}.pdf`);
await writeFile(file, bytes);

console.log(`\nSaved  ${file}`);
console.log(`From   ${from.label} — ${from.url}`);
if (refused.length) console.log(`       after ${refused.length} that would not.`);
if (/Google Drive|GoogleDrive/i.test(OUT)) {
  console.log('\nThat folder is synced by Google Drive, so it is in your Drive already.');
} else {
  console.log(
    '\nTo put it in Drive: re-run with --out pointed at your Google Drive folder, or use\n' +
      "Save to Drive in the app, which also records the file against the paper so the\n" +
      'reader opens that copy.',
  );
}

await cleanup();
