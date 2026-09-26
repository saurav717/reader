/**
 * Does the Scholar side actually work, from this machine, right now?
 *
 * Everything else about Scholar in this repository is tested against saved
 * fixtures, because Scholar cannot be reached from CI — or from anywhere that
 * looks like a server. This is the one script that asks Scholar itself, and it
 * exists to be run by hand, from a laptop, on a connection Google trusts.
 *
 *   node scripts/scholar-live.mjs                      # the default checks
 *   node scripts/scholar-live.mjs "attention is all you need"
 *   node scholar-live.mjs --author "Saurav Chennuri"
 *   SCHOLAR_BROWSER=1 node scripts/scholar-live.mjs    # drive real Chromium
 *   SERPLY_KEY=… node scripts/scholar-live.mjs         # through Serply's page fetch
 *   SERPAPI_KEY=… node scripts/scholar-live.mjs        # through SerpApi instead
 *   node scripts/scholar-live.mjs --save               # refresh the fixtures
 *
 * It prints what came back, what was parsed out of it, and — the part that
 * matters — whether Scholar answered at all. A captcha here is the expected
 * result from a datacentre and a surprise from a laptop.
 *
 * `--save` overwrites `scripts/fixtures/scholar-*.html` with what Scholar
 * returned. Run it when `npm test` starts failing on the parsing: the diff
 * will show what Scholar changed.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  authorSearchUrl,
  blockedReason,
  getScholar,
  parseAuthors,
  parseCitationView,
  parseProfileWorks,
  parseResults,
  plainFetch,
  profileUrl,
  workUrl,
  searchUrl,
  versionsUrl,
} from '../server/scholar.js';
import { browserWanted, closeBrowser, scholarFetcher } from '../server/scholarBrowser.js';
import { askSerp } from '../server/serpapi.js';
import { askSerplyScholar, serplyFetcher, SERPLY_KINDS } from '../server/serply.js';

/**
 * With a Serply key, each ask goes where the proxy sends it — a search,
 * people and versions to Serply's Scholar endpoint, a profile and an entry
 * opened through Serply's page fetch — see server/serply.js. Otherwise, with
 * a SerpApi key, every ask goes through SerpApi — see server/serpapi.js.
 */
const SERPLY_KEY = (process.env.SERPLY_KEY || '').trim();
const SERPAPI_KEY = SERPLY_KEY ? '' : (process.env.SERPAPI_KEY || '').trim();

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueFor = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

const SAVE = flag('--save');
const QUERY = args.find((arg) => !arg.startsWith('--') && arg !== valueFor('--author')) || 'attention is all you need';
const AUTHOR = valueFor('--author') || 'Saurav Chennuri';

const fetchPage = SERPLY_KEY ? serplyFetcher(SERPLY_KEY) : SERPAPI_KEY ? null : await scholarFetcher(plainFetch);
console.log(
  SERPLY_KEY
    ? 'Asking Google Scholar through Serply, with the key in SERPLY_KEY. Each check spends one credit.\n'
    : SERPAPI_KEY
    ? 'Asking Google Scholar through SerpApi, with the key in SERPAPI_KEY. Each check spends one search of its allowance.\n'
    : `Asking Google Scholar ${browserWanted() ? 'through a real Chromium' : 'with plain HTTPS requests'}.\n` +
        'A captcha is the normal answer from a server; from a laptop it usually is not.\n',
);

let problems = 0;

async function step(label, url, parse, fixture, serp) {
  if (SERPLY_KEY && SERPLY_KINDS.has(serp.kind)) {
    process.stdout.write(`\n── ${label}\n   via Serply's Scholar endpoint: ${serp.kind} ${JSON.stringify(serp.params)}\n`);
    try {
      const parsed = await askSerplyScholar(serp.kind, serp.params, SERPLY_KEY);
      console.log(`   OK       ${parsed.length} results`);
      if (!parsed.length) console.log('   (nothing came back — an empty answer, or a field Serply renamed)');
      return parsed;
    } catch (error) {
      problems += 1;
      console.log(`   REFUSED  ${error.reason ? `(${error.reason}) ` : ''}${error.message}`);
      return null;
    }
  }
  if (SERPLY_KEY) process.stdout.write(`\n   (through Serply's page fetch, which Scholar often refuses — the proxy asks SerpApi for this page when it has that key)`);
  if (SERPAPI_KEY) {
    process.stdout.write(`\n── ${label}\n   via SerpApi: ${serp.kind} ${JSON.stringify(serp.params)}\n`);
    try {
      const parsed = await askSerp(serp.kind, serp.params, SERPAPI_KEY);
      console.log(`   OK       ${parsed.length} results`);
      if (!parsed.length) console.log('   (nothing came back — an empty answer, or a field SerpApi renamed; check the JSON on serpapi.com/searches)');
      return parsed;
    } catch (error) {
      problems += 1;
      console.log(`   REFUSED  ${error.reason ? `(${error.reason}) ` : ''}${error.message}`);
      return null;
    }
  }
  process.stdout.write(`\n── ${label}\n   ${url}\n`);
  let html;
  try {
    html = await getScholar(url, { fetchPage });
  } catch (error) {
    problems += 1;
    console.log(`   REFUSED  ${error.reason ? `(${error.reason}) ` : ''}${error.message}`);
    return null;
  }
  const reason = blockedReason(html, 200);
  if (reason) {
    problems += 1;
    console.log(`   REFUSED  (${reason})`);
    return null;
  }
  const parsed = parse(html);
  console.log(`   OK       ${html.length.toLocaleString()} bytes, ${parsed.length} parsed`);
  if (!parsed.length) {
    problems += 1;
    console.log('   ⚠  Scholar answered but nothing parsed — its markup may have changed. Re-run with --save and diff the fixture.');
  }
  if (SAVE && fixture) {
    await writeFile(path.join(here, 'fixtures', `${fixture}.html`), html);
    console.log(`   saved    scripts/fixtures/${fixture}.html`);
  }
  return parsed;
}

// ---------------------------------------------------------------- papers ----

const results = await step(`Papers matching "${QUERY}"`, searchUrl(QUERY), parseResults, SAVE ? 'scholar-search' : null, {
  kind: 'search',
  params: { query: QUERY },
});
for (const result of (results || []).slice(0, 5)) {
  console.log(`\n   ${result.title}`);
  console.log(`     ${result.authors.join(', ')}${result.year ? ` · ${result.year}` : ''}${result.venue ? ` · ${result.venue}` : ''}`);
  console.log(`     file:     ${result.pdfUrl ? `${result.pdfUrl} (${result.pdfHost})` : '— none listed'}`);
  console.log(`     landing:  ${result.url || '—'}`);
  console.log(`     versions: ${result.versionCount ?? '—'}${result.clusterId ? ` (cluster ${result.clusterId})` : ''}`);
  console.log(`     cited by: ${result.citedBy ?? '—'}`);
}

// Every copy of the first result — the list this is all for.
const cluster = (results || []).find((result) => result.clusterId && result.versionCount)?.clusterId;
if (cluster) {
  const versions = await step(`Every version of the first result`, versionsUrl(cluster), parseResults, null, {
    kind: 'versions',
    params: { cluster },
  });
  for (const version of (versions || []).slice(0, 12)) {
    console.log(`     ${version.pdfUrl ? 'PDF ' : '    '} ${version.pdfHost || new URL(version.url || 'https://x/').hostname}`);
  }
  // A cluster ignored comes back as some other page of results, which parses fine: say so.
  const titleOf = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 24);
  const wanted = titleOf(results.find((result) => result.clusterId === cluster)?.title);
  const same = (versions || []).filter((version) => titleOf(version.title) === wanted).length;
  if (versions && versions.length && same < versions.length / 2) {
    problems += 1;
    console.log(`   ⚠  only ${same} of ${versions.length} look like versions of that paper — the cluster may not have been passed through.`);
  }
  const withFile = (versions || []).filter((version) => version.pdfUrl);
  console.log(`\n   ${withFile.length} of ${(versions || []).length} versions carry a direct file link.`);
}

// --------------------------------------------------------------- a person ---

const people = await step(
  `People matching "${AUTHOR}"`,
  authorSearchUrl(AUTHOR),
  parseAuthors,
  SAVE ? 'scholar-authors' : null,
  { kind: 'authors', params: { name: AUTHOR } },
);
if (people && !people.length) {
  console.log(`   Scholar has no profile under that name. That is an answer, not a failure — most people have none.`);
}
for (const person of people || []) {
  console.log(`\n   ${person.name}${person.affiliation ? ` — ${person.affiliation}` : ''}`);
  console.log(`     profile:  ${person.profileUrl}`);
  console.log(`     verified: ${person.verifiedEmail || '—'}`);
  console.log(`     cited by: ${person.citedBy ?? '—'}`);
}

// Their own list of works, which is what opening a person shows.
const first = (people || []).find((person) => person.userId);
if (first) {
  const works = await step(
    `Works on the profile of ${first.name}`,
    profileUrl(first.userId),
    parseProfileWorks,
    null,
    { kind: 'profile', params: { user: first.userId, start: 0 } },
  );
  for (const work of (works || []).slice(0, 5)) {
    console.log(`     ${work.year ?? '    '}  ${work.title}${work.citedBy ? ` (cited by ${work.citedBy})` : ''}`);
  }

  // One of them, opened: where the file Scholar found for it is shown — a
  // copy on the person's own site, as often as not — and the cluster.
  const entry = (works || []).find((work) => work.citationId);
  if (entry) {
    const [opened] = (await step(
      `The entry "${entry.title}", opened`,
      workUrl(first.userId, entry.citationId),
      parseCitationView,
      SAVE ? 'scholar-work' : null,
      { kind: 'work', params: { user: first.userId, citation: entry.citationId } },
    )) || [];
    if (opened) {
      console.log(`     file:     ${opened.pdfUrl ? `${opened.pdfUrl} (${opened.pdfHost})` : '— none listed'}`);
      console.log(`     landing:  ${opened.url || '—'}`);
      console.log(`     versions: ${opened.versionCount ?? '—'}${opened.clusterId ? ` (cluster ${opened.clusterId})` : ''}`);
      console.log(`     authors:  ${opened.authors.join(', ')}`);
    }
  }
}

await closeBrowser();

console.log(
  problems
    ? `\n${problems} of the checks did not get an answer. If they were all captchas, Scholar has decided this machine is a robot:` +
        '\n  · try again from a home connection rather than a server,' +
        '\n  · try SCHOLAR_BROWSER=1, which drives a real Chromium and gets through more often,' +
        '\n  · or search from the app against this proxy: when Scholar answers with a captcha, the panel offers to show it to you to solve,' +
        '\n  · or put a SerpApi key in SERPAPI_KEY, and Scholar is asked through SerpApi, which is never shown a captcha,' +
        '\n  · or leave Scholar off — the other four sources need no proxy and are never blocked.'
    : '\nEverything answered. The Scholar source works from this machine.',
);
process.exit(problems ? 1 : 0);
