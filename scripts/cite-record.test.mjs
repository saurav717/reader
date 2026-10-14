// How a paper is cited: the BibTeX read and written, the entry made from a
// record, the cite keys in each style, the variant a draft takes under the
// preference and the published-version rule, and the text forms.
//
//   node --test scripts/cite-record.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const cr = await load('src/lib/citeRecord.ts');

const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  await cleanup();
});

const paper = (more = {}) => ({
  id: 'arxiv:2202.09368',
  source: 'arxiv',
  title: 'Mixture-of-Experts with Expert Choice Routing',
  authors: ['Yanqi Zhou', 'Tao Lei', 'Quoc V. Le'],
  abstract: '',
  published: '2022-02-18',
  categories: ['cs.LG'],
  arxivId: '2202.09368',
  addedAt: '2026-01-01T00:00:00.000Z',
  collectionIds: [],
  tags: [],
  progress: 0,
  ...more,
});

const DBLP = `@inproceedings{DBLP:conf/nips/ZhouLLDHZDCLL22,
  author    = {Yanqi Zhou and Tao Lei and Hanxiao Liu},
  title     = {Mixture-of-Experts with Expert Choice Routing},
  booktitle = {NeurIPS},
  pages     = {7103--7114},
  year      = {2022}
}`;

describe('BibTeX read and written', () => {
  it('reads every entry, braces nested, quotes and bare numbers, @comment left out', () => {
    const entries = cr.parseBibtex(`${DBLP}\n@comment{nothing}\n@article(a, title="T {Nested} x", journal={J}, volume=12)`);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].type, 'inproceedings');
    assert.equal(entries[0].key, 'DBLP:conf/nips/ZhouLLDHZDCLL22');
    assert.equal(entries[0].fields.pages, '7103--7114');
    assert.deepEqual(entries[1], { type: 'article', key: 'a', fields: { title: 'T {Nested} x', journal: 'J', volume: '12' } });
  });

  it('writes an entry back out in the order asked, and rekeys one without touching the rest', () => {
    const text = cr.formatBibtex({ type: 'article', key: 'k', fields: { year: '2020', title: 'T' } }, ['title', 'year']);
    assert.equal(text, '@article{k,\n  title = {T},\n  year  = {2020}\n}');
    assert.match(cr.rekey(DBLP, 'zhou2022mixture'), /^@inproceedings\{zhou2022mixture,\n  author/);
  });

  it('shows a field plainly: braces off, TeX accents turned into letters', () => {
    assert.equal(cr.plain('{GShard}: Scaling Schr\\"{o}der \\& co'), 'GShard: Scaling Schröder & co');
  });
});

describe('the entry made from the record', () => {
  it('is @inproceedings with a booktitle for a conference, the arXiv ids kept on a preprint', () => {
    const text = cr.generatedBibtex(paper({ venue: 'Advances in Neural Information Processing Systems' }));
    assert.match(text, /^@inproceedings\{zhou2022mixture,/);
    assert.match(text, /booktitle\s+= \{Advances in Neural Information Processing Systems\}/);
    assert.match(text, /eprint\s+= \{2202\.09368\}/);
  });

  it('is @article with volume and pages for a journal, the eprint dropped once there is a DOI', () => {
    const text = cr.generatedBibtex(paper({ venue: 'Journal of Machine Learning Research', doi: '10.5555/1' }), { placement: 'Vol. 23, issue 120, pp. 1–39' });
    assert.match(text, /^@article\{/);
    assert.match(text, /volume\s+= \{23\}/);
    assert.match(text, /number\s+= \{120\}/);
    assert.match(text, /pages\s+= \{1--39\}/);
    assert.doesNotMatch(text, /eprint/);
  });

  it('is @misc with the eprint for a preprint with no venue', () => {
    const text = cr.generatedBibtex(paper());
    assert.match(text, /^@misc\{/);
    assert.match(text, /archiveprefix\s+= \{arXiv\}/);
    assert.match(text, /url\s+= \{https:\/\/arxiv\.org\/abs\/2202\.09368\}/);
  });

  it('tells a conference from a journal from a preprint by the venue name', () => {
    assert.equal(cr.venueKindOf('Proceedings of the 39th International Conference on Machine Learning'), 'conference');
    assert.equal(cr.venueKindOf('ICLR'), 'conference');
    assert.equal(cr.venueKindOf('Nature Machine Intelligence'), 'journal');
    assert.equal(cr.venueKindOf('arXiv.org'), 'preprint');
    assert.equal(cr.venueKindOf(undefined), undefined);
  });
});

describe('cite keys', () => {
  it('come in each style, from the first author, year and first long word', () => {
    const p = paper();
    assert.equal(cr.keyIn(p, 'scholar'), 'zhou2022mixture');
    assert.equal(cr.keyIn(p, 'colon'), 'zhou:2022:mixture');
    assert.equal(cr.keyIn(p, 'authorYear'), 'Zhou2022');
  });

  it("take dblp's own key when the paper has dblp's entry, Scholar's otherwise", () => {
    const withDblp = paper({ citation: { variants: [{ source: 'dblp', bibtex: DBLP, fetchedAt: 'x', of: 'conf/nips/ZhouLLDHZDCLL22' }] } });
    assert.equal(cr.keyIn(withDblp, 'dblp'), 'DBLP:conf/nips/ZhouLLDHZDCLL22');
    assert.equal(cr.keyIn(paper(), 'dblp'), 'zhou2022mixture');
  });

  it('are the one kept on the paper first, then the style in Settings', () => {
    assert.equal(cr.keyOf(paper({ citation: { key: 'zhou-ec', variants: [] } })), 'zhou-ec');
    assert.equal(cr.keyOf(paper(), { ...cr.citationOptions(), keyStyle: 'colon' }), 'zhou:2022:mixture');
  });
});

describe('the variant a draft takes', () => {
  const CROSSREF = '@article{Zoph_2022, title={ST-MoE}, journal={JMLR}, year={2022}}';
  const ARXIV = '@misc{x, title={ST-MoE}, eprint={2202.08906}}';
  const stmoe = (more = {}) =>
    paper({
      id: 'arxiv:2202.08906',
      arxivId: '2202.08906',
      title: 'ST-MoE: Designing Stable and Transferable Sparse Expert Models',
      citation: {
        variants: [
          { source: 'arxiv', bibtex: ARXIV, fetchedAt: 'x', of: '2202.08906' },
          { source: 'crossref', bibtex: CROSSREF, fetchedAt: 'x', of: '10.5555/x' },
        ],
        publishedDoi: '10.5555/x',
        publishedIn: 'JMLR 23 (2022)',
        ...more,
      },
    });
  const opts = cr.citationOptions();

  it('is the official one first, the generated one only when nothing was found', () => {
    assert.equal(cr.variantOf(paper({ citation: { variants: [{ source: 'dblp', bibtex: DBLP, fetchedAt: 'x' }] } })).source, 'dblp');
    assert.equal(cr.variantOf(paper()).source, 'generated');
    assert.equal(cr.variantOf(paper({ citation: { variants: [{ source: 'dblp', bibtex: DBLP, fetchedAt: 'x' }] } }), { ...opts, prefer: 'generated' }).source, 'generated');
  });

  it("holds the preprint until the published version is switched to, as Settings' default says", () => {
    const state = cr.citationState(stmoe());
    assert.equal(state.source, 'arxiv');
    assert.deepEqual(state.published, { doi: '10.5555/x', in: 'JMLR 23 (2022)' });
    assert.equal(cr.variantOf(stmoe(), { ...opts, published: 'switch' }).source, 'crossref');
    assert.equal(cr.variantOf(stmoe({ chosen: 'crossref' })).source, 'crossref');
    assert.equal(cr.citationState(stmoe({ chosen: 'crossref' })).published, undefined);
    assert.equal(cr.citationState(stmoe(), { ...opts, published: 'keep' }).published, undefined);
  });

  it("is written under the paper's key whichever variant it is, so a \\cite never changes", () => {
    assert.match(cr.bibtexOf(stmoe({ chosen: 'crossref' })), /^@article\{zhou2022designing,/);
    assert.match(cr.bibtexOf(stmoe()), /^@misc\{zhou2022designing,/);
  });

  it('keeps every source once, the newest kept', () => {
    const record = cr.withVariants({ variants: [{ source: 'dblp', bibtex: 'old', fetchedAt: '1' }] }, [{ source: 'dblp', bibtex: 'new', fetchedAt: '2' }, { source: 'arxiv', bibtex: 'a', fetchedAt: '2' }], { lookedAt: 'now' });
    assert.deepEqual(record.variants.map((variant) => `${variant.source}:${variant.bibtex}`), ['dblp:new', 'arxiv:a']);
    assert.equal(record.lookedAt, 'now');
  });
});

describe('the text forms', () => {
  const p = paper({ citation: { variants: [{ source: 'dblp', bibtex: DBLP, fetchedAt: 'x' }] } });
  it('APA, IEEE and Chicago from the chosen entry, initials and "and" as each wants them', () => {
    assert.equal(cr.citationAs(p, 'apa'), 'Zhou, Y., Lei, T., & Liu, H. (2022). Mixture-of-Experts with Expert Choice Routing. In *NeurIPS* (pp. 7103–7114).');
    assert.equal(cr.citationAs(p, 'ieee'), 'Y. Zhou, T. Lei, and H. Liu, “Mixture-of-Experts with Expert Choice Routing,” in *NeurIPS*, 2022, pp. 7103–7114.');
    assert.equal(cr.citationAs(p, 'chicago'), 'Zhou, Yanqi, Tao Lei, and Hanxiao Liu. 2022. “Mixture-of-Experts with Expert Choice Routing.” In *NeurIPS*, 7103–7114.');
  });

  it('RIS with a start and end page, BibLaTeX with a date, a Markdown link to the paper', () => {
    assert.match(cr.citationAs(p, 'ris'), /^TY {2}- CONF\nTI {2}- Mixture/);
    assert.match(cr.citationAs(p, 'ris'), /SP {2}- 7103\nEP {2}- 7114/);
    assert.match(cr.citationAs(p, 'biblatex'), /date\s+= \{2022\}/);
    assert.equal(cr.citationAs(p, 'markdown'), '[Mixture-of-Experts with Expert Choice Routing](https://arxiv.org/abs/2202.09368) — Zhou, Lei and Liu, NeurIPS, 2022');
  });

  it('a preprint with nothing fetched: APA names arXiv, BibLaTeX makes it @online', () => {
    assert.match(cr.citationAs(paper(), 'apa'), /\(2022\)\. Mixture-of-Experts with Expert Choice Routing\. arXiv\. https:\/\/arxiv\.org\/abs\/2202\.09368/);
    assert.match(cr.citationAs(paper(), 'biblatex'), /^@online\{zhou2022mixture,[\s\S]*eprinttype\s+= \{arxiv\}/);
  });
});

describe('looking the entries up', () => {
  it('asks every source at once — arXiv’s export, DataCite, Semantic Scholar, dblp, OpenReview, the Anthology — then Crossref by the published DOI, and keeps each answer with where it came from', async () => {
    const asked = [];
    globalThis.fetch = async (url, init) => {
      asked.push(String(url));
      const respond = (body, text = false) => ({ ok: true, status: 200, json: async () => body, text: async () => (text ? body : JSON.stringify(body)) });
      if (/arxiv\.org\/bibtex/.test(url)) return respond('@misc{zhou2022mixtureofexperts,\n  title={Mixture-of-Experts with Expert Choice Routing},\n  eprint={2202.09368}\n}', true);
      if (/api\.datacite\.org/.test(url)) return respond('@misc{https://doi.org/10.48550/arxiv.2202.09368, doi = {10.48550/ARXIV.2202.09368}, title = {Mixture-of-Experts with Expert Choice Routing}}', true);
      if (/semanticscholar/.test(url)) return respond({ externalIds: { DOI: '10.5555/x' }, citationStyles: { bibtex: '@Article{Zhou2022, title={Mixture-of-Experts with Expert Choice Routing}}' }, venue: 'NeurIPS', year: 2022, publicationVenue: { name: 'Neural Information Processing Systems' } });
      if (/dblp\.org\/search/.test(url)) return respond({ result: { hits: { hit: [{ info: { key: 'journals/corr/abs-2202-09368', title: 'Mixture-of-Experts with Expert Choice Routing.', venue: 'CoRR', year: '2022' } }, { info: { key: 'conf/nips/ZhouLLDHZDCLL22', title: 'Mixture-of-Experts with Expert Choice Routing.', venue: 'NeurIPS', year: '2022', doi: '10.5555/x', type: 'Conference and Workshop Papers', pages: '7103-7114', authors: { author: [{ text: 'Yanqi Zhou' }] } } }] } } });
      if (/dblp\.org\/rec/.test(url)) return respond('@inproceedings{DBLP:conf/nips/ZhouLLDHZDCLL22,\n  author = {Yanqi Zhou},\n  title = {Mixture-of-Experts with Expert Choice Routing},\n  booktitle = {NeurIPS},\n  year = {2022}\n}', true);
      if (/openreview/.test(url)) return respond({ notes: [] });
      if (/aclanthology/.test(url)) return respond('nothing', true);
      if (/crossref/.test(url)) {
        assert.equal(init?.headers?.Accept, 'application/x-bibtex');
        return respond('@inproceedings{Zhou_2022, title={Mixture-of-Experts with Expert Choice Routing}, booktitle={NeurIPS}}', true);
      }
      return { ok: false, status: 404, json: async () => null, text: async () => null };
    };
    const record = await cr.lookupCitations(paper());
    assert.deepEqual(record.variants.map((variant) => variant.source).sort(), ['arxiv', 'crossref', 'datacite', 'dblp', 'semanticscholar']);
    assert.equal(record.publishedDoi, '10.5555/x');
    assert.equal(record.publishedIn, 'Neural Information Processing Systems 2022');
    const dblp = record.variants.find((variant) => variant.source === 'dblp');
    assert.match(dblp.bibtex, /^@inproceedings\{DBLP:conf\/nips\/ZhouLLDHZDCLL22,/);
    assert.equal(dblp.url, 'https://dblp.org/rec/conf/nips/ZhouLLDHZDCLL22');
    assert.equal(record.variants.find((variant) => variant.source === 'arxiv').url, 'https://arxiv.org/bibtex/2202.09368');
    assert.equal(record.variants.find((variant) => variant.source === 'datacite').url, 'https://api.datacite.org/dois/application/x-bibtex/10.48550/arXiv.2202.09368');
    assert.equal(asked.filter((url) => /crossref/.test(url)).length, 1);
    assert.match(asked.find((url) => /crossref/.test(url)), /works\/10\.5555%2Fx\/transform\/application\/x-bibtex/);
    // The Anthology was not asked: the paper has no ACL id.
    assert.equal(asked.some((url) => /aclanthology/.test(url)), false);
  });

  it('makes dblp’s entry from its record when the .bib will not come, and never from thin air', async () => {
    globalThis.fetch = async (url) => {
      if (/dblp\.org\/search/.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ result: { hits: { hit: [{ info: { key: 'conf/nips/ZhouLLDHZDCLL22', title: 'Mixture-of-Experts with Expert Choice Routing.', venue: 'NeurIPS', year: '2022', type: 'Conference and Workshop Papers', pages: '7103-7114', authors: { author: [{ text: 'Yanqi Zhou' }, { text: 'Tao Lei' }] } } }] } } }) };
      return { ok: false, status: 404, text: async () => null };
    };
    const record = await cr.lookupCitations(paper());
    assert.deepEqual(record.variants.map((variant) => variant.source), ['dblp']);
    assert.match(record.variants[0].bibtex, /^@inproceedings\{DBLP:conf\/nips\/ZhouLLDHZDCLL22,[\s\S]*author\s+= \{Yanqi Zhou and Tao Lei\}[\s\S]*bibsource/);
  });

  it('says so when no source had it, keeps no made-up entry, and the draft falls back to one made from the record', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => null, text: async () => null });
    const record = await cr.lookupCitations(paper());
    assert.deepEqual(record.variants, []);
    assert.match(record.error, /No source/);
    const state = cr.citationState(paper({ citation: record }));
    assert.equal(state.source, 'generated');
    assert.equal(state.label, 'made here · no source had it');
    assert.equal(state.official, false);
  });

  it('knows an ACL paper by its DOI or its page, and asks the Anthology for it', async () => {
    assert.equal(cr.aclIdOf({ doi: '10.18653/v1/2020.acl-main.1' }), '2020.acl-main.1');
    assert.equal(cr.aclIdOf({ landingUrl: 'https://aclanthology.org/2023.emnlp-main.12/' }), '2023.emnlp-main.12');
    assert.equal(cr.aclIdOf({ landingUrl: 'https://arxiv.org/abs/1' }), null);
    globalThis.fetch = async (url) => (/aclanthology\.org\/2020\.acl-main\.1\.bib$/.test(url) ? { ok: true, status: 200, text: async () => '@inproceedings{acl-1, title = {T}, booktitle = {Proceedings of ACL}}' } : { ok: false, status: 404, text: async () => null });
    const variant = await cr.fetchAcl({ doi: '10.18653/v1/2020.acl-main.1' });
    assert.equal(variant.source, 'acl');
    assert.equal(variant.url, 'https://aclanthology.org/2020.acl-main.1.bib');
  });
});
