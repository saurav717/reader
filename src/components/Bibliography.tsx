/**
 * A project's bibliography: every paper in it with the key it goes by, the
 * entry chosen for it and where that came from, the published version
 * where a preprint has one, and Copy citation in every form. Each paper's
 * variants can be seen and one picked; an entry can be pasted in; the
 * whole set exported as a .bib. On the project's overview, under the
 * paper card.
 */
import { useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { papersIn, type Project } from '../lib/projects';
import { SOURCE_LABELS, bibtexOf, citationState, keyIn, keyOf, parseBibtex, rekey, tidy, variantOf, isPublishedVersion } from '../lib/citeRecord';
import { CITATION_DEFAULTS, CITATION_OPTIONS, type CitationSource, type Paper } from '../types';
import CiteMenu, { copyText } from './CiteMenu';

export default function BibliographyCard({ project }: { project: Project }) {
  const { papers, settings, setPaperCitation, lookupPaperCitations, citationsLooking, updateSettings } = useStore();
  const opts = settings.citations ?? CITATION_DEFAULTS;
  const mine = useMemo(() => papersIn(project.id, papers), [project.id, papers]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [pasting, setPasting] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newKey, setNewKey] = useState('');

  const states = useMemo(() => new Map(mine.map((paper) => [paper.id, citationState(paper, opts)])), [mine, opts]);
  const official = mine.filter((paper) => states.get(paper.id)?.official).length;
  const published = mine.filter((paper) => states.get(paper.id)?.published).length;
  const looking = mine.filter((paper) => citationsLooking.has(paper.id)).length;
  const keyStyle = CITATION_OPTIONS.find((group) => group.key === 'keyStyle')!;

  const say = (what: string) => {
    setSaid(what);
    window.setTimeout(() => setSaid(null), 1600);
  };
  const exportBib = async () => {
    const text = mine
      .slice()
      .sort((a, b) => keyOf(a, opts).localeCompare(keyOf(b, opts)))
      .map((paper) => bibtexOf(paper, opts))
      .join('\n\n');
    const ok = await copyText(`${text}\n`);
    say(ok ? `Copied ${mine.length} entries` : 'Could not copy');
  };
  const choose = (paper: Paper, source: CitationSource | undefined) => void setPaperCitation(paper.id, (current) => ({ ...current, chosen: source }));
  const paste = (paper: Paper) => {
    const record = parseBibtex(pasted)[0];
    if (!record) return say('That is not a BibTeX entry');
    void setPaperCitation(paper.id, (current) => ({
      ...current,
      chosen: 'pasted',
      variants: [...current.variants.filter((variant) => variant.source !== 'pasted'), { source: 'pasted', bibtex: tidy(pasted), fetchedAt: new Date().toISOString() }],
    }));
    setPasting(null);
    setPasted('');
  };
  const rename = (paper: Paper) => {
    const key = newKey.trim().replace(/[\s,{}]/g, '');
    if (!key) return;
    void setPaperCitation(paper.id, { key });
    setRenaming(null);
  };

  if (!mine.length) return null;
  return (
    <section className="pj-card ol-card bib-card" style={{ ['--pj' as string]: project.color }}>
      <div className="pj-card-top">
        <div className="ol-head">
          <h2>Bibliography</h2>
          <span className="ol-sync" title="Entries from Crossref, Semantic Scholar, dblp, OpenReview or arXiv; the rest made here from the record">
            {official} of {mine.length} official
          </span>
          {published ? (
            <span className="ol-sync bib-warn" title="A preprint whose published version an index knows">
              {published} preprint{published === 1 ? '' : 's'} since published
            </span>
          ) : null}
          <span className="pj-sp" />
          <button type="button" className="btn sm" disabled={looking > 0} onClick={() => void lookupPaperCitations(mine.map((paper) => paper.id))} title="Ask Crossref, Semantic Scholar, dblp and OpenReview for each paper's own entry">
            {looking ? `Looking… ${looking} left` : 'Fetch official citations'}
          </button>
          <button type="button" className="btn sm" onClick={() => void exportBib()} title="Every entry, as references.bib would have them, to the clipboard">
            {said ?? 'Copy the .bib'}
          </button>
        </div>
        <p className="pj-sub">
          The entry a draft takes: <b>{CITATION_OPTIONS[0].choices.find((choice) => choice.id === opts.prefer)?.label.toLowerCase()}</b> · keys as <b className="mono">{keyStyle.choices.find((choice) => choice.id === opts.keyStyle)?.label}</b> ·{' '}
          <button type="button" className="link-btn bib-link" onClick={() => updateSettings({ citations: { ...CITATION_DEFAULTS, ...opts, keyStyle: keyStyle.choices[(keyStyle.choices.findIndex((choice) => choice.id === opts.keyStyle) + 1) % keyStyle.choices.length].id as typeof opts.keyStyle } })}>
            next key style
          </button>{' '}
          · the rest in Settings → Citations. A key is the same in every project; switching entries never changes it.
        </p>
      </div>
      <div className="bib-rows">
        {mine.map((paper) => {
          const state = states.get(paper.id)!;
          const open = openId === paper.id;
          const chosen = variantOf(paper, opts);
          return (
            <div key={paper.id} className={`bib-row${open ? ' is-open' : ''}`}>
              <button type="button" className="bib-main" onClick={() => setOpenId(open ? null : paper.id)} aria-expanded={open}>
                <span className="bib-title">{paper.title}</span>
                <span className="bib-key mono">{state.key}</span>
                <span className="bib-state">
                  <span className={`wr-cite-chip${state.official ? ' is-official' : ''}${state.published ? ' is-warn' : ''}`}>{state.published ? 'preprint' : state.label}</span>
                  {state.published ? <span className="bib-quiet">published · {state.published.in}</span> : state.summary ? <span className="bib-quiet">{state.summary}</span> : null}
                  {citationsLooking.has(paper.id) ? <span className="bib-quiet">looking…</span> : paper.citation?.error && !state.official ? <span className="bib-quiet">{paper.citation.error}</span> : null}
                </span>
              </button>
              <CiteMenu paper={paper} label="Copy" onLookup={() => lookupPaperCitations([paper.id])} />
              {open ? (
                <div className="bib-detail">
                  <div className="bib-variants">
                    <span className="ol-label">Entry to use</span>
                    {[...(paper.citation?.variants ?? []), ...(paper.citation?.variants.some((variant) => variant.source === 'generated') ? [] : [{ source: 'generated' as const, bibtex: '', fetchedAt: '', of: undefined }])].map((variant) => {
                      const record = variant.bibtex ? parseBibtex(variant.bibtex)[0] : undefined;
                      const isChosen = chosen.source === variant.source;
                      const isPublished = variant.bibtex ? isPublishedVersion(paper, variant) : false;
                      return (
                        <button key={variant.source} type="button" className={`bib-variant${isChosen ? ' is-on' : ''}`} onClick={() => choose(paper, paper.citation?.chosen === variant.source ? undefined : variant.source)} title={paper.citation?.chosen === variant.source ? 'Chosen by hand: click to let Settings pick again' : 'Use this entry'}>
                          <i className="bib-radio" />
                          <span>
                            <b>
                              {isPublished ? 'Published version · ' : ''}
                              {SOURCE_LABELS[variant.source]}
                            </b>
                            <small>
                              {record ? `@${record.type}` : paper.citation?.lookedAt ? 'from the record — no source had it' : 'from the record — not looked up yet'}
                              {record?.fields.booktitle || record?.fields.journal ? ` · ${(record.fields.booktitle ?? record.fields.journal ?? '').replace(/[{}]/g, '').slice(0, 60)}` : ''}
                              {variant.of && !variant.url ? ` · ${variant.of}` : ''}
                              {isChosen && paper.citation?.chosen === variant.source ? ' · chosen by hand' : isChosen ? ' · by Settings' : ''}
                            </small>
                            {variant.url ? (
                              <small>
                                fetched from{' '}
                                <a href={variant.url} target="_blank" rel="noreferrer noopener" onClick={(event) => event.stopPropagation()}>
                                  {variant.url.replace(/^https?:\/\//, '').replace(/\?.*$/, '').slice(0, 70)}
                                </a>
                                {variant.fetchedAt ? ` · ${variant.fetchedAt.slice(0, 10)}` : ''}
                              </small>
                            ) : null}
                          </span>
                        </button>
                      );
                    })}
                    <div className="bib-actions">
                      {pasting === paper.id ? (
                        <form
                          className="bib-paste"
                          onSubmit={(event) => {
                            event.preventDefault();
                            paste(paper);
                          }}
                        >
                          <textarea value={pasted} onChange={(event) => setPasted(event.target.value)} placeholder="@inproceedings{key, … } — from the venue's own Cite button" rows={5} spellCheck={false} />
                          <div>
                            <button type="submit" className="btn sm primary">
                              Use it
                            </button>
                            <button type="button" className="btn sm" onClick={() => setPasting(null)}>
                              Cancel
                            </button>
                          </div>
                        </form>
                      ) : (
                        <button type="button" className="btn sm" onClick={() => (setPasting(paper.id), setPasted(''))}>
                          Paste one…
                        </button>
                      )}
                      {renaming === paper.id ? (
                        <form
                          className="bib-rename"
                          onSubmit={(event) => {
                            event.preventDefault();
                            rename(paper);
                          }}
                        >
                          <input className="mono" value={newKey} onChange={(event) => setNewKey(event.target.value)} aria-label="The cite key" />
                          <button type="submit" className="btn sm primary">
                            Rename
                          </button>
                          <button type="button" className="btn sm" onClick={() => setRenaming(null)}>
                            Cancel
                          </button>
                        </form>
                      ) : (
                        <button type="button" className="btn sm" onClick={() => (setRenaming(paper.id), setNewKey(state.key))} title={`A key of your own, kept on the paper; by the style in Settings it would be ${keyIn(paper, opts.keyStyle)}`}>
                          Rename the key
                        </button>
                      )}
                      {paper.citation?.key ? (
                        <button type="button" className="link-btn bib-link" onClick={() => void setPaperCitation(paper.id, { key: undefined })}>
                          back to {keyIn(paper, opts.keyStyle)}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <pre className="bib-text mono">{rekey(chosen.bibtex, state.key)}</pre>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
