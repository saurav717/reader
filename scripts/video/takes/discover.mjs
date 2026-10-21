/**
 * "Find anything, and every copy of it." Home's Find papers asks Google
 * Scholar, OpenAlex and Semantic Scholar at once and merges what they say;
 * a result opens on everywhere it can be read and is saved with one press
 * (and an Undo); a name in Discover becomes the person's Scholar-style
 * profile with their papers beneath; and a paper whose first copy is the
 * conference poster opens on the copy that is the paper, with the list of
 * copies saying what each one answered.
 *
 * Every index is a stand-in, answering in its own API's shape with records
 * written to look like the real ones; the two PDFs (the poster and the
 * paper) are printed by Chromium in setup().
 */
import { json } from '../lib.mjs';

// ------------------------------------------------------------------ data ---

const Q = 'mixture of experts routing';

/** One paper as every index knows it. `arxiv` ties the records together; no arxiv → matched on the title. */
const PAPERS = [
  {
    key: 'outrageous',
    title: 'Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer',
    authors: ['Noam Shazeer', 'Azalia Mirhoseini', 'Krzysztof Maziarz', 'Andy Davis', 'Quoc Le', 'Geoffrey Hinton', 'Jeff Dean'],
    short: ['N Shazeer', 'A Mirhoseini', 'K Maziarz', 'A Davis'],
    year: 2017,
    venue: 'ICLR',
    arxiv: '1701.06538',
    cited: 3184,
    versions: 9,
    abstract:
      'The capacity of a neural network to absorb information is limited by its number of parameters. Conditional computation, where parts of the network are active on a per-example basis, has been proposed in theory as a way of dramatically increasing model capacity without a proportional increase in computation. We introduce a Sparsely-Gated Mixture-of-Experts layer (MoE), consisting of up to thousands of feed-forward sub-networks, and a trainable gating network which determines a sparse combination of these experts to use for each example.',
  },
  {
    key: 'switch',
    title: 'Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity',
    authors: ['William Fedus', 'Barret Zoph', 'Noam Shazeer'],
    short: ['W Fedus', 'B Zoph', 'N Shazeer'],
    year: 2022,
    venue: 'Journal of Machine Learning Research',
    arxiv: '2101.03961',
    cited: 2671,
    versions: 7,
    cluster: '9412361002741835167',
    abstract:
      'In deep learning, models typically reuse the same parameters for all inputs. Mixture of Experts (MoE) defies this and instead selects different parameters for each incoming example. The result is a sparsely-activated model — with outrageous numbers of parameters — but a constant computational cost. However, despite several notable successes of MoE, widespread adoption has been hindered by complexity, communication costs and training instability. We address these with the Switch Transformer: we simplify the MoE routing algorithm and design intuitive improved models with reduced communication and computational costs.',
  },
  {
    key: 'expert-choice',
    title: 'Mixture-of-Experts with Expert Choice Routing',
    authors: ['Yanqi Zhou', 'Tao Lei', 'Hanxiao Liu', 'Nan Du', 'Yanping Huang', 'Vincent Zhao', 'Andrew Dai', 'Zhifeng Chen', 'Quoc Le', 'James Laudon'],
    short: ['Y Zhou', 'T Lei', 'H Liu', 'N Du'],
    year: 2022,
    venue: 'Advances in Neural Information Processing Systems',
    cited: 412,
    versions: 5,
    cluster: '5521907736158042210',
    abstract:
      'Sparsely-activated Mixture-of-experts (MoE) models allow the number of parameters to greatly increase while keeping the amount of computation for a given token or a given sample unchanged. However, a poor expert routing strategy can cause certain experts to be under-trained, leading to an expert being under or over-specialized. Prior work allocates a fixed number of experts to each token using a top-k function regardless of the relative importance of different tokens. To address this, we propose a heterogeneous mixture-of-experts employing an expert choice method.',
  },
  {
    key: 'gshard',
    title: 'GShard: Scaling Giant Models with Conditional Computation and Automatic Sharding',
    authors: ['Dmitry Lepikhin', 'HyoukJoong Lee', 'Yuanzhong Xu', 'Dehao Chen', 'Orhan Firat', 'Yanping Huang', 'Maxim Krikun', 'Noam Shazeer', 'Zhifeng Chen'],
    short: ['D Lepikhin', 'HJ Lee', 'Y Xu', 'D Chen'],
    year: 2021,
    venue: 'ICLR',
    arxiv: '2006.16668',
    cited: 1406,
    versions: 6,
    abstract: 'Neural network scaling has been critical for improving the model quality in many real-world machine learning applications with vast amounts of training data and compute.',
  },
  {
    key: 'st-moe',
    title: 'ST-MoE: Designing Stable and Transferable Sparse Expert Models',
    authors: ['Barret Zoph', 'Irwan Bello', 'Sameer Kumar', 'Nan Du', 'Yanping Huang', 'Jeff Dean', 'Noam Shazeer', 'William Fedus'],
    short: ['B Zoph', 'I Bello', 'S Kumar', 'N Du'],
    year: 2022,
    arxiv: '2202.08906',
    cited: 298,
    versions: 4,
    abstract: 'Scale has opened new frontiers in natural language processing — but at a high cost. In response, Mixture-of-Experts (MoE) and Switch Transformers have been proposed as an energy efficient path to even larger and more capable language models.',
  },
  {
    key: 'hash',
    title: 'Hash Layers For Large Sparse Models',
    authors: ['Stephen Roller', 'Sainbayar Sukhbaatar', 'Arthur Szlam', 'Jason Weston'],
    short: ['S Roller', 'S Sukhbaatar', 'A Szlam', 'J Weston'],
    year: 2021,
    venue: 'NeurIPS',
    arxiv: '2106.04426',
    cited: 236,
    versions: 5,
    abstract: 'We investigate the training of sparse layers that use different parameters for different inputs based on hashing in large Transformer models.',
  },
  {
    key: 'base',
    title: 'BASE Layers: Simplifying Training of Large, Sparse Models',
    authors: ['Mike Lewis', 'Shruti Bhosale', 'Tim Dettmers', 'Naman Goyal', 'Luke Zettlemoyer'],
    short: ['M Lewis', 'S Bhosale', 'T Dettmers', 'N Goyal'],
    year: 2021,
    venue: 'ICML',
    arxiv: '2103.16716',
    cited: 214,
    versions: 6,
    abstract: 'We introduce a new balanced assignment of experts (BASE) layer for large language models that greatly simplifies existing high capacity sparse layers.',
  },
  {
    key: 'deepseekmoe',
    title: 'DeepSeekMoE: Towards Ultimate Expert Specialization in Mixture-of-Experts Language Models',
    authors: ['Damai Dai', 'Chengqi Deng', 'Chenggang Zhao', 'R. X. Xu', 'Huazuo Gao', 'Deli Chen'],
    short: ['D Dai', 'C Deng', 'C Zhao', 'RX Xu'],
    year: 2024,
    venue: 'ACL',
    arxiv: '2401.06066',
    cited: 352,
    versions: 3,
    abstract: 'In the era of large language models, Mixture-of-Experts (MoE) is a promising architecture for managing computational costs when scaling up model parameters.',
  },
  {
    key: 'mixtral',
    title: 'Mixtral of Experts',
    authors: ['Albert Q. Jiang', 'Alexandre Sablayrolles', 'Antoine Roux', 'Arthur Mensch', 'Blanche Savary'],
    short: ['AQ Jiang', 'A Sablayrolles', 'A Roux', 'A Mensch'],
    year: 2024,
    arxiv: '2401.04088',
    cited: 1532,
    versions: 3,
    abstract: 'We introduce Mixtral 8x7B, a Sparse Mixture of Experts (SMoE) language model. Mixtral has the same architecture as Mistral 7B, with the difference that each layer is composed of 8 feedforward blocks (i.e. experts).',
  },
  {
    key: 'survey',
    title: 'A Review of Sparse Expert Models in Deep Learning',
    authors: ['William Fedus', 'Jeff Dean', 'Barret Zoph'],
    short: ['W Fedus', 'J Dean', 'B Zoph'],
    year: 2022,
    arxiv: '2209.01667',
    cited: 187,
    abstract: 'Sparse expert models are a thirty-year old concept re-emerging as a popular architecture in deep learning.',
  },
  {
    key: 'jacobs',
    title: 'Adaptive Mixtures of Local Experts',
    authors: ['Robert A. Jacobs', 'Michael I. Jordan', 'Steven J. Nowlan', 'Geoffrey E. Hinton'],
    short: ['RA Jacobs', 'MI Jordan', 'SJ Nowlan', 'GE Hinton'],
    year: 1991,
    venue: 'Neural Computation',
    doi: '10.1162/neco.1991.3.1.79',
    cited: 6020,
    abstract: 'We present a new supervised learning procedure for systems composed of many separate networks, each of which learns to handle a subset of the complete set of training cases.',
  },
  {
    key: 'routing-survey',
    title: 'Routers in Vision Mixture of Experts: An Empirical Study',
    authors: ['Tianlin Liu', 'Mathieu Blondel', 'Carlos Riquelme', 'Joan Puigcerver'],
    short: ['T Liu', 'M Blondel', 'C Riquelme', 'J Puigcerver'],
    year: 2024,
    venue: 'Transactions on Machine Learning Research',
    arxiv: '2401.15969',
    cited: 21,
    abstract: 'Mixture-of-Experts (MoE) models are a promising way to scale up model capacity without significantly increasing computational cost.',
  },
];
const by = Object.fromEntries(PAPERS.map((paper) => [paper.key, paper]));

// What each index ranks for the query, in its own order.
const SCHOLAR_ORDER = ['switch', 'outrageous', 'expert-choice', 'gshard', 'st-moe', 'hash', 'base', 'mixtral'];
const OPENALEX_ORDER = ['outrageous', 'switch', 'jacobs', 'gshard', 'deepseekmoe', 'mixtral'];
const S2_ORDER = ['switch', 'expert-choice', 'survey', 'routing-survey', 'base', 'deepseekmoe'];

const EXPERT_CHOICE = {
  landing: 'https://proceedings.neurips.cc/paper_files/paper/2022/hash/2f00ecd787b432c1d36f3de9800728eb-Abstract-Conference.html',
  proceedings: 'https://proceedings.neurips.cc/paper_files/paper/2022/file/2f00ecd787b432c1d36f3de9800728eb-Paper-Conference.pdf',
  poster: 'https://neurips.cc/media/PosterPDFs/NeurIPS%202022/54219.pdf',
  openreviewPdf: 'https://openreview.net/pdf?id=jdJo1HIVinI',
  openreview: 'https://openreview.net/forum?id=jdJo1HIVinI',
};

function scholarHit(paper) {
  const hit = {
    id: paper.cluster || paper.key,
    clusterId: paper.cluster || `${1e18 + paper.key.length * 7919}`.slice(0, 19),
    title: paper.title,
    authors: paper.short,
    venue: paper.venue,
    year: paper.year,
    snippet: paper.abstract.slice(0, 220),
    citedBy: paper.cited,
    versionCount: paper.versions,
  };
  if (paper.key === 'expert-choice') return { ...hit, url: EXPERT_CHOICE.landing, pdfUrl: EXPERT_CHOICE.poster, pdfHost: 'neurips.cc' };
  if (paper.key === 'switch') return { ...hit, url: 'https://www.jmlr.org/papers/v23/21-0998.html', pdfUrl: `https://arxiv.org/pdf/${paper.arxiv}`, pdfHost: 'arxiv.org' };
  if (paper.arxiv) return { ...hit, url: `https://arxiv.org/abs/${paper.arxiv}`, pdfUrl: `https://arxiv.org/pdf/${paper.arxiv}`, pdfHost: 'arxiv.org' };
  return hit;
}

function openAlexWork(paper) {
  const doi = paper.doi || (paper.arxiv ? `10.48550/arxiv.${paper.arxiv}` : null);
  const arxivLoc = paper.arxiv
    ? { pdf_url: `https://arxiv.org/pdf/${paper.arxiv}`, landing_page_url: `https://arxiv.org/abs/${paper.arxiv}`, source: { display_name: 'arXiv (Cornell University)', type: 'repository' }, version: 'submittedVersion', is_oa: true }
    : null;
  const work = {
    id: `https://openalex.org/W${3000000000 + paper.key.length * 104729 + paper.year}`,
    doi: doi ? `https://doi.org/${doi}` : null,
    display_name: paper.title,
    publication_date: `${paper.year}-${paper.key === 'switch' ? '01-11' : '06-01'}`,
    abstract_inverted_index: Object.fromEntries(paper.abstract.split(' ').reduce((map, word, at) => (map.set(word, [...(map.get(word) || []), at]), map), new Map())),
    authorships: paper.authors.map((name) => ({ author: { display_name: name } })),
    primary_location: arxivLoc ?? { pdf_url: null, landing_page_url: paper.doi ? `https://doi.org/${paper.doi}` : null, source: { display_name: paper.venue ?? null, type: 'journal' } },
    best_oa_location: arxivLoc,
    locations: arxivLoc ? [arxivLoc] : [],
    open_access: { is_oa: Boolean(arxivLoc), oa_url: arxivLoc?.pdf_url ?? null },
    concepts: [{ display_name: 'Computer science' }, { display_name: 'Artificial neural network' }],
    cited_by_count: paper.cited,
    ids: paper.arxiv ? { arxiv: `https://arxiv.org/abs/${paper.arxiv}` } : {},
  };
  if (paper.key === 'switch') {
    const jmlr = { pdf_url: 'https://jmlr.org/papers/volume23/21-0998/21-0998.pdf', landing_page_url: 'https://jmlr.org/papers/v23/21-0998.html', source: { display_name: 'Journal of Machine Learning Research', type: 'journal' }, version: 'publishedVersion', is_oa: true };
    work.locations = [jmlr, arxivLoc];
  }
  if (paper.key === 'expert-choice') {
    // The proceedings, the version of record; no preprint in this index's record.
    const neurips = { pdf_url: EXPERT_CHOICE.proceedings, landing_page_url: EXPERT_CHOICE.landing, source: { display_name: 'NeurIPS Proceedings', type: 'conference' }, version: 'publishedVersion', is_oa: true };
    Object.assign(work, { doi: null, primary_location: neurips, best_oa_location: neurips, locations: [neurips], open_access: { is_oa: true, oa_url: neurips.pdf_url } });
  }
  return work;
}

function s2Paper(paper) {
  return {
    paperId: `s2${paper.key}`.padEnd(40, '0').slice(0, 40),
    title: paper.title,
    abstract: paper.abstract,
    venue: paper.venue ?? 'arXiv.org',
    year: paper.year,
    publicationDate: null,
    citationCount: paper.cited,
    authors: paper.authors.map((name) => ({ name })),
    externalIds: { ...(paper.arxiv ? { ArXiv: paper.arxiv } : {}), ...(paper.doi ? { DOI: paper.doi } : {}) },
    openAccessPdf: paper.key === 'switch' ? { url: 'https://www.jmlr.org/papers/volume23/21-0998/21-0998.pdf' } : paper.arxiv ? { url: `https://arxiv.org/pdf/${paper.arxiv}` } : null,
  };
}

// Noam Shazeer, as Scholar and OpenAlex keep him.
const SHAZEER_ID = 'wsGvgA8AAAAJ';
const SCHOLAR_PERSON = {
  userId: SHAZEER_ID,
  name: 'Noam Shazeer',
  profileUrl: `https://scholar.google.com/citations?user=${SHAZEER_ID}&hl=en`,
  affiliation: 'Google',
  verifiedEmail: 'google.com',
  interests: ['Deep learning', 'Language models', 'Mixture of experts', 'Machine translation'],
  citedBy: 262418,
};
const OPENALEX_PEOPLE = [
  { id: 'https://openalex.org/A5014829317', display_name: 'Noam Shazeer', orcid: null, works_count: 96, cited_by_count: 241377, summary_stats: { h_index: 47 }, last_known_institutions: [{ display_name: 'Google (United States)' }] },
  { id: 'https://openalex.org/A5090377012', display_name: 'N. Shazeer', orcid: null, works_count: 4, cited_by_count: 212, summary_stats: { h_index: 3 }, last_known_institutions: [] },
];
const SHAZEER_WORKS = [
  ['Gemini: A Family of Highly Capable Multimodal Models', ['R Anil', 'S Borgeaud', 'Y Wu', 'JB Alayrac'], 'arXiv preprint arXiv:2312.11805', '2023-12-19', 3412],
  ['Gemini 1.5: Unlocking Multimodal Understanding across Millions of Tokens of Context', ['M Reid', 'N Savinov', 'D Teplyashin', 'D Lepikhin'], 'arXiv preprint arXiv:2403.05530', '2024-03-08', 2087],
  ['LaMDA: Language Models for Dialog Applications', ['R Thoppilan', 'D De Freitas', 'J Hall', 'N Shazeer'], 'arXiv preprint arXiv:2201.08239', '2022-01-20', 1934],
  ['ST-MoE: Designing Stable and Transferable Sparse Expert Models', ['B Zoph', 'I Bello', 'S Kumar', 'N Du'], 'arXiv preprint arXiv:2202.08906', '2022-02-17', 298],
  ['Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity', ['W Fedus', 'B Zoph', 'N Shazeer'], 'Journal of Machine Learning Research 23 (120), 1-39', '2022-01-01', 2671],
  ['GShard: Scaling Giant Models with Conditional Computation and Automatic Sharding', ['D Lepikhin', 'HJ Lee', 'Y Xu', 'D Chen'], 'International Conference on Learning Representations', '2021-01-12', 1406],
  ['GLU Variants Improve Transformer', ['N Shazeer'], 'arXiv preprint arXiv:2002.05202', '2020-02-12', 1188],
  ['Exploring the Limits of Transfer Learning with a Unified Text-to-Text Transformer', ['C Raffel', 'N Shazeer', 'A Roberts', 'K Lee'], 'Journal of Machine Learning Research 21 (140), 1-67', '2020-01-01', 21950],
  ['Fast Transformer Decoding: One Write-Head is All You Need', ['N Shazeer'], 'arXiv preprint arXiv:1911.02150', '2019-11-06', 512],
  ['Mesh-TensorFlow: Deep Learning for Supercomputers', ['N Shazeer', 'Y Cheng', 'N Parmar', 'D Tran'], 'Advances in Neural Information Processing Systems 31', '2018-11-05', 402],
  ['Adafactor: Adaptive Learning Rates with Sublinear Memory Cost', ['N Shazeer', 'M Stern'], 'International Conference on Machine Learning, 4596-4604', '2018-04-11', 1311],
  ['Image Transformer', ['N Parmar', 'A Vaswani', 'J Uszkoreit', 'L Kaiser'], 'International Conference on Machine Learning, 4055-4064', '2018-02-15', 2205],
  ['Attention Is All You Need', ['A Vaswani', 'N Shazeer', 'N Parmar', 'J Uszkoreit'], 'Advances in Neural Information Processing Systems 30', '2017-06-12', 178320],
  ['Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer', ['N Shazeer', 'A Mirhoseini', 'K Maziarz', 'A Davis'], 'International Conference on Learning Representations', '2017-01-23', 3184],
  ['Exploring the Limits of Language Modeling', ['R Jozefowicz', 'O Vinyals', 'M Schuster', 'N Shazeer'], 'arXiv preprint arXiv:1602.02410', '2016-02-07', 1290],
  ['Scheduled Sampling for Sequence Prediction with Recurrent Neural Networks', ['S Bengio', 'O Vinyals', 'N Jaitly', 'N Shazeer'], 'Advances in Neural Information Processing Systems 28', '2015-06-09', 2391],
].map(([title, authors, venue, published, citedBy], at) => ({
  title,
  authors,
  venue,
  published,
  year: Number(published.slice(0, 4)),
  citedBy,
  snippet: '',
  url: `https://scholar.google.com/citations?view_op=view_citation&hl=en&user=${SHAZEER_ID}&citation_for_view=${SHAZEER_ID}:${String(at).padStart(2, 'u')}9yKSN-GCB0IC`,
  citationId: `${SHAZEER_ID}:${String(at).padStart(2, 'u')}9yKSN-GCB0IC`,
  authorIds: [{ name: 'N Shazeer', userId: SHAZEER_ID }],
}));

// ------------------------------------------------------------- the PDFs ---

async function printPdfs(context) {
  const printer = await context.newPage();
  const ec = by['expert-choice'];
  // The poster shown at NeurIPS: one landscape page, 48×36 in.
  await printer.setContent(`<!doctype html><html><body style="margin:0;font-family:Helvetica,Arial,sans-serif;color:#1d2433">
  <div style="background:#2b3f8f;color:#fff;padding:60px 90px"><div style="font-size:110px;font-weight:700">${ec.title}</div>
  <div style="font-size:52px;margin-top:24px">${ec.authors.join(' · ')}</div><div style="font-size:44px;margin-top:12px;opacity:.85">Google · NeurIPS 2022</div></div>
  <div style="display:flex;gap:60px;padding:70px 90px;font-size:40px;line-height:1.4">
  ${['Motivation', 'Expert choice', 'Results'].map((h, i) => `<div style="flex:1;border:6px solid #2b3f8f;border-radius:30px;padding:50px"><h2 style="font-size:72px;color:#2b3f8f;margin:0 0 30px">${h}</h2>
  <p>${['Token-choice routing leaves experts under- or over-trained: load imbalance needs an auxiliary loss.', 'Experts pick their top-k tokens instead. Each expert has a fixed bucket; each token can go to a variable number of experts.', 'More than 2× faster training convergence than Switch top-1 and GShard top-2 at the same compute; better on 7 of 11 GLUE/SuperGLUE tasks.'][i]}</p>
  <div style="height:520px;margin-top:40px;background:linear-gradient(180deg,#e7ecfb,#c9d3f5);border-radius:20px;display:flex;align-items:flex-end;gap:30px;padding:40px">${[40, 70, 55, 90, 65].map((v) => `<div style="flex:1;height:${v}%;background:#2b3f8f;border-radius:8px"></div>`).join('')}</div></div>`).join('')}
  </div></body></html>`);
  const poster = await printer.pdf({ width: '48in', height: '36in', printBackground: true });

  const para = (text) => `<p style="margin:0 0 9px;text-align:justify">${text}</p>`;
  const lorem = [
    'Scaling up model capacity has been one of the most reliable ways of improving quality in language modeling, and sparsely-activated models make it possible to grow the number of parameters without growing the computation spent on each token.',
    'In a token-choice router each token independently selects its top-k experts. Because the selection ignores the load on each expert, some experts receive far more tokens than their capacity allows while others are left idle, and the overflow is dropped.',
    'We instead let each expert select the top-k tokens it is best suited to. The capacity of every expert is then fixed by construction, load balancing is guaranteed, and a token may be processed by a variable number of experts depending on its difficulty.',
    'We pre-train a family of decoder models from 100M to 8B activated parameters and compare against Switch Transformer top-1 and GShard top-2 gating at equal compute, measuring perplexity, convergence time and downstream fine-tuning quality.',
  ];
  await printer.setContent(`<!doctype html><html><body style="font-family:'Times New Roman',Times,serif;font-size:10.5pt;line-height:1.38;margin:0 0.9in;color:#111">
  <h1 style="text-align:center;font-size:17pt;margin:6px 0 14px;border-top:3px solid #111;border-bottom:1px solid #111;padding:10px 0">${ec.title}</h1>
  <p style="text-align:center;margin:0 0 4px">${ec.authors.slice(0, 5).join(', ')}<br>${ec.authors.slice(5).join(', ')}</p>
  <p style="text-align:center;font-style:italic;margin:0 0 18px">Google, Mountain View, CA, USA<br><span style="font-family:monospace;font-style:normal">{yanqiz, taole, hanxiaol, dunan}@google.com</span></p>
  <h3 style="text-align:center;margin:0 0 6px">Abstract</h3>
  <p style="margin:0 0.45in 16px;text-align:justify">${ec.abstract} Instead of letting tokens select the top-k experts, we have experts selecting the top-k tokens. As a result, each token can be routed to a variable number of experts and each expert can have a fixed bucket size. We find that our method improves training convergence time by more than 2×.</p>
  ${['1 Introduction', '2 Related Work', '3 Method', '4 Experiments', '5 Results', '6 Conclusion'].map((h, s) => `<section style="break-after:${s % 2 ? 'page' : 'auto'}"><h3 style="margin:12px 0 6px">${h}</h3>${[0, 1, 2, 3, 0, 1].map((i) => para(lorem[(i + s) % 4])).join('')}${s === 2 ? '<p style="text-align:center;font-style:italic">G = TopK(S<sup>T</sup>, k), &nbsp; S = Softmax(X · W<sub>g</sub>) &nbsp;&nbsp;&nbsp; (1)</p>' : ''}</section>`).join('')}
  </body></html>`);
  const paper = await printer.pdf({ format: 'Letter', printBackground: true, margin: { top: '0.9in', bottom: '0.9in' } });
  await printer.close();
  return { poster, paper };
}

// ---------------------------------------------------------------- routes ---

export async function setup(context) {
  const { poster, paper } = await printPdfs(context);

  // Google Scholar, through the proxy.
  await context.route('**/api/scholar/**', (route) => {
    const url = new URL(route.request().url());
    const kind = url.pathname.split('/').pop();
    const delay = (ms, body) => new Promise((resolve) => setTimeout(() => resolve(route.fulfill(json(body))), ms));
    if (kind === 'search') {
      const q = url.searchParams.get('q') || '';
      if (/^"/.test(q)) return route.fulfill(json({ results: [] }));
      if (/shazeer/i.test(q)) return delay(500, { results: SHAZEER_WORKS.slice(0, 10) });
      return delay(700, { results: SCHOLAR_ORDER.map((key) => scholarHit(by[key])) });
    }
    if (kind === 'authors') return delay(900, { results: /shazeer/i.test(url.searchParams.get('name') || '') ? [SCHOLAR_PERSON] : [] });
    if (kind === 'profile') return delay(600, { results: SHAZEER_WORKS });
    if (kind === 'versions') {
      const cluster = url.searchParams.get('cluster');
      if (cluster === by.switch.cluster)
        return delay(300, {
          results: [
            { title: by.switch.title, authors: by.switch.short, snippet: '', url: 'https://research.google/pubs/switch-transformers-scaling-to-trillion-parameter-models-with-simple-and-efficient-sparsity/' },
            { title: by.switch.title, authors: by.switch.short, snippet: '', url: 'https://dl.acm.org/doi/abs/10.5555/3586589.3586709', pdfUrl: 'https://jmlr.org/papers/volume23/21-0998/21-0998.pdf', pdfHost: 'jmlr.org' },
          ],
        });
      if (cluster === by['expert-choice'].cluster)
        return delay(300, {
          results: [
            { title: by['expert-choice'].title, authors: by['expert-choice'].short, snippet: '', url: EXPERT_CHOICE.openreview, pdfUrl: EXPERT_CHOICE.openreviewPdf, pdfHost: 'openreview.net' },
            { title: by['expert-choice'].title, authors: by['expert-choice'].short, snippet: '', url: EXPERT_CHOICE.landing, pdfUrl: EXPERT_CHOICE.poster, pdfHost: 'neurips.cc' },
          ],
        });
      return route.fulfill(json({ results: [] }));
    }
    return route.fulfill(json({ results: [] }));
  });

  // OpenAlex: a search, one work by its id, a title match, and people.
  await context.route('**/api.openalex.org/**', (route) => {
    const url = new URL(route.request().url());
    const delay = (ms, body) => new Promise((resolve) => setTimeout(() => resolve(route.fulfill(json(body))), ms));
    if (url.pathname.startsWith('/authors')) return delay(400, { results: /shazeer/i.test(url.searchParams.get('search') || '') ? OPENALEX_PEOPLE : [] });
    const single = /^\/works\/(.+)$/.exec(url.pathname);
    if (single) {
      const key = decodeURIComponent(single[1]).toLowerCase();
      const paper = PAPERS.find((p) => (p.arxiv && key.endsWith(p.arxiv)) || (p.doi && key.endsWith(p.doi.toLowerCase())));
      return paper ? delay(250, openAlexWork(paper)) : route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    }
    const filter = url.searchParams.get('filter') || '';
    if (filter.startsWith('title.search:')) {
      const wanted = filter.slice('title.search:'.length).toLowerCase();
      const paper = PAPERS.find((p) => p.title.toLowerCase().replace(/[,:|]+/g, ' ').startsWith(wanted.slice(0, 30)));
      return delay(250, { results: paper ? [openAlexWork(paper)] : [] });
    }
    if (/shazeer/i.test(url.searchParams.get('search') || '')) return delay(400, { results: [] });
    if (url.searchParams.get('search')) return delay(500, { results: OPENALEX_ORDER.map((key) => openAlexWork(by[key])) });
    return route.fulfill(json({ results: [] }));
  });

  // Semantic Scholar: a search, and one paper by its arXiv id.
  await context.route('**/api.semanticscholar.org/**', (route) => {
    const url = new URL(route.request().url());
    const delay = (ms, body) => new Promise((resolve) => setTimeout(() => resolve(route.fulfill(json(body))), ms));
    if (url.pathname.endsWith('/paper/search')) return delay(600, { data: S2_ORDER.map((key) => s2Paper(by[key])) });
    const one = /\/paper\/(.+)$/.exec(url.pathname);
    if (one) {
      const key = decodeURIComponent(one[1]);
      const paper = PAPERS.find((p) => p.arxiv && key.endsWith(p.arxiv));
      if (paper) {
        const record = s2Paper(paper);
        return delay(250, { openAccessPdf: record.openAccessPdf, externalIds: record.externalIds });
      }
    }
    return route.fulfill(json({ data: [] }));
  });
  await context.route('**/api.crossref.org/**', (route) => route.fulfill(json({ message: { items: [] } })));
  await context.route('**/api.unpaywall.org/**', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));

  // arXiv and the copies' files, through the proxy.
  await context.route('**/api/arxiv/**', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"none"}' }));
  await context.route('**/api/pdf?*', (route) => {
    const target = new URL(route.request().url()).searchParams.get('url') || '';
    if (target.includes('PosterPDFs')) return route.fulfill({ status: 200, contentType: 'application/pdf', body: poster });
    if (target.includes('openreview.net') || target.includes('proceedings.neurips.cc')) return route.fulfill({ status: 200, contentType: 'application/pdf', body: paper });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' });
  });
}

// ------------------------------------------------------------- the start ---

export async function prepare({ page, arrive }) {
  await arrive({
    storage: {
      'reader.home': { opensOn: 'search', tabs: ['search', 'continue', 'today', 'inbox', 'board'], last: 'search', clearPanels: true, saveTo: 'c-sparse', v: 2 },
      'reader.view': { kind: 'all' },
    },
  });
  await page.evaluate(async (gshard) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('reader');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const run = (store, act) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        act(tx.objectStore(store));
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    for (const store of ['papers', 'collections']) await run(store, (s) => s.clear());
    const at = (days) => new Date(Date.now() - days * 864e5).toISOString();
    await run('collections', (s) => {
      s.put({ id: 'c-sparse', name: 'Sparse models', color: '#7c6cd8', createdAt: at(30) });
      s.put({ id: 'c-reading', name: 'Reading list', color: '#2f7d6d', createdAt: at(40) });
      s.put({ id: 'c-thesis', name: 'Thesis — related work', color: '#c9803a', createdAt: at(20) });
    });
    await run('papers', (s) =>
      s.put({ id: `arxiv:${gshard.arxiv}`, source: 'arxiv', arxivId: gshard.arxiv, title: gshard.title, authors: gshard.authors, abstract: gshard.abstract, published: '2020-06-30', categories: ['cs.CL'], addedAt: at(6), collectionIds: ['c-reading'], tags: [], progress: 0 }),
    );
    db.close();
  }, by.gshard);
  await page.reload({ waitUntil: 'networkidle' });
  const skip = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.locator('.find').waitFor({ timeout: 15000 });
  await page.evaluate(() => document.fonts.ready);
}

// ------------------------------------------------------------ on camera ---

export default async function ({ page, pointer, mark }) {
  const hold = (ms) => page.waitForTimeout(ms);
  await hold(2000);

  // 1. Find papers: a topic, more sources, one merged list.
  mark('query');
  const box = page.getByLabel('Search for papers');
  await pointer.click(box, { dx: 0.3, pause: 300 });
  await pointer.type(Q, { delay: 65 });
  await hold(900);

  mark('sources');
  const chip = (label) => page.locator('.find-options .chip', { hasText: new RegExp(`^${label}$`) });
  await pointer.moveTo(chip('Google Scholar'));
  await hold(700);
  await pointer.click(chip('OpenAlex'), { pause: 700 });
  await pointer.click(chip('Semantic Scholar'), { pause: 1200 });

  mark('results');
  await pointer.click(page.locator('.find-box button[type=submit]'), { pause: 200 });
  await page.locator('.find-row').nth(7).waitFor({ timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('.find-box .spinner'));
  await hold(1200);
  // Down the list, slowly, so the bylines and years read.
  await pointer.moveTo(page.locator('.find-row').nth(1), { dx: 0.35 });
  await hold(900);
  await pointer.moveTo(page.locator('.find-row').nth(3), { dx: 0.35 });
  await hold(900);
  await pointer.moveTo(page.locator('.find-row').nth(5), { dx: 0.35 });
  await hold(1200);

  // 2. One result: its abstract and every copy of it.
  mark('detail');
  const switchRow = page.locator('.find-row', { hasText: 'Switch Transformers' });
  await pointer.click(switchRow.locator('.find-title'), { dx: 0.3, pause: 300 });
  await page.locator('.find-detail .locations .eyebrow').first().filter({ hasText: /Readable in/ }).waitFor({ timeout: 15000 });
  await hold(1500);
  mark('copies');
  const copies = page.locator('.find-detail .locations li');
  await pointer.moveTo(copies.first(), { dx: 0.2 });
  await hold(1000);
  await pointer.moveTo(copies.nth(2), { dx: 0.2 });
  await hold(1000);
  await pointer.moveTo(copies.last(), { dx: 0.2 });
  await hold(1500);

  mark('save');
  await pointer.click(page.locator('.find-detail-actions').getByRole('button', { name: /Save to Sparse models/ }), { pause: 400 });
  await page.locator('.find-toast').waitFor({ timeout: 5000 });
  // On the toast, so it stays while it is read.
  await pointer.moveTo(page.locator('.find-toast').getByRole('button', { name: 'Undo' }));
  await hold(2800);

  // 3. A person: Discover lays a name out as their profile.
  mark('people');
  await pointer.click(page.getByRole('button', { name: 'Discover papers' }), { pause: 900 });
  const panel = page.locator('.discover-panel');
  await panel.waitFor({ timeout: 10000 });
  const field = panel.getByLabel('Search papers and people');
  await pointer.click(field, { dx: 0.3, pause: 300 });
  await pointer.type('Noam Shazeer', { delay: 75 });
  await hold(500);
  await pointer.click(panel.locator('.chip', { hasText: /^OpenAlex$/ }), { pause: 700 });
  await pointer.click(field, { dx: 0.6, pause: 200 });
  await pointer.key('Enter', '↵', 300);
  await panel.locator('article.result.person').waitFor({ timeout: 15000 });
  await panel.locator('article.result:not(.person)').nth(3).waitFor({ timeout: 15000 });
  await hold(800);
  mark('profile');
  await pointer.moveTo(panel.locator('article.result.person h3'), { dx: 0.3 });
  await hold(1400);
  await pointer.moveTo(panel.locator('article.result.person .meta'), { dx: 0.4 });
  await hold(1800);

  mark('most-cited');
  const order = panel.getByRole('group', { name: 'Order of the papers' });
  await pointer.click(order.getByRole('button', { name: 'Most cited' }), { pause: 300 });
  await page.waitForFunction(() => !document.querySelector('.discover-panel .spinner'));
  await panel.locator('article.result:not(.person)', { hasText: 'Attention Is All You Need' }).first().waitFor({ timeout: 10000 });
  await hold(1000);
  await pointer.moveTo(panel.locator('article.result:not(.person)').first(), { dx: 0.4 });
  await hold(2200);

  // 4. A paper whose first copy is the poster: read on the copy that is the paper.
  mark('poster');
  const ecRow = page.locator('.find-row', { hasText: 'Expert Choice Routing' });
  await pointer.click(ecRow.getByRole('button', { name: /^Read$/ }), { pause: 600 });
  const pdfMode = page.locator('.segmented button', { hasText: 'PDF' });
  await pdfMode.waitFor({ timeout: 15000 });
  if ((await pdfMode.getAttribute('aria-pressed')) !== 'true') await pointer.click(pdfMode, { pause: 400 });
  await page.locator('.copy-bar').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => /openreview|NeurIPS/i.test(document.querySelector('.copy-current')?.textContent || ''), null, { timeout: 20000 });
  await hold(1500);
  mark('copy-bar');
  await pointer.moveTo(page.locator('.copy-current'));
  await hold(1500);
  mark('copy-picker');
  await pointer.click(page.locator('.copy-current'), { pause: 600 });
  await page.locator('.copy-picker').waitFor({ timeout: 5000 });
  await hold(800);
  await pointer.moveTo(page.locator('.copy-option', { hasText: 'neurips.cc' }).first(), { dx: 0.3 });
  await hold(2500);
  await pointer.moveTo(page.locator('.copy-option.showing'), { dx: 0.3 });
  await hold(2500);
}
