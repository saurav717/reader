/**
 * "Work with others, and write": the Projects board, a shared project's
 * overview with the others in it (presence, a person's card, a toast as
 * someone opens a file), its papers by role and its bibliography; the Write
 * tab compiling the paper on this computer, the citation card at the end of
 * a sentence and the PDF with the citation in; the logbook's whiteboard with
 * Priya drawing; and the Calendar's week.
 *
 * Stood in for: Google (sign-in, Drive, Calendar — scripts/fakeGoogle.mjs),
 * the project's room (its state, its log and its live socket, as
 * scripts/live-smoke.mjs and logbook-smoke.mjs do), and this computer's
 * Companion (a folder on disk, .video/work/projects-reader, as
 * citations-smoke.mjs does) whose compile answers with a PDF Chromium
 * prints from the paper's text — there is no TeX here.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ROOT, BASE as SITE, json } from '../lib.mjs';
import { installGoogle, makePdf, settingsScript } from '../../fakeGoogle.mjs';

const ME = 'saurav@example.org';
const PRIYA = 'priya@example.org';
const MARCO = 'marco@example.org';
const LIN = 'lin@example.org';
const ROOM = 'c0ffee'.padEnd(32, '0');
const PASS = `rp1.${Buffer.from(JSON.stringify({ e: ME, x: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.sig`;
const PROJECT = 'p-moe';
const day = (ago) => new Date(Date.now() - ago * 24 * 3600 * 1000).toISOString();

// ------------------------------------------------------- the paper's folder ---

const COMPANION_ROOT = path.join(ROOT, '.video/work/projects-reader');
const FOLDER = 'papers/sparse-gated-moe';
const FILES = {
  'main.tex': '\\documentclass{article}\n\\usepackage{iclr2027_conference,times}\n\\usepackage{natbib}\n\\title{Loss-free routing at 8B}\n\\begin{document}\n\\maketitle\n\\input{sections/intro}\n\\input{sections/related}\n\\bibliographystyle{iclr2027_conference}\n\\bibliography{refs}\n\\end{document}\n',
  'iclr2027_conference.sty': '% ICLR 2027 style\n',
  'iclr2027_conference.bst': '% ICLR 2027 bibliography style\n',
  'sections/intro.tex': '\\section{Introduction}\nSparse mixture-of-experts models route each token to a few experts, so a model can grow without its compute growing with it.\n',
  'sections/related.tex':
    '\\section{Related work}\n\\paragraph{Load balancing.}\nMost MoE models keep experts busy with an auxiliary loss on the router~\\cite{fedus2021switch,zoph2022stmoe}.\nIts weight trades balance against quality: too small and experts collapse, too large and the LM loss suffers~\\cite{zoph2022stmoe}.\nExpert choice routing side-steps this by letting experts pick tokens~\\cite{zhou2022expert}.\n\n\\paragraph{Routing at scale.}\nGShard~\\cite{lepikhin2020gshard} trained a 600B-parameter MoE with top-2 gating.\n\n\\paragraph{Bias-based balancing.}\nClosest to us, a per-expert bias used only for selection, updated from the load each batch, balances without a loss.\n',
  'refs.bib':
    '@article{fedus2021switch,\n  title = {Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity},\n  author = {Fedus, William and Zoph, Barret and Shazeer, Noam},\n  journal = {Journal of Machine Learning Research},\n  volume = {23},\n  number = {120},\n  year = {2022}\n}\n\n@article{zoph2022stmoe,\n  title = {ST-MoE: Designing Stable and Transferable Sparse Expert Models},\n  author = {Zoph, Barret and Bello, Irwan and Kumar, Sameer and Du, Nan and Huang, Yanping and Dean, Jeff and Shazeer, Noam and Fedus, William},\n  journal = {Journal of Machine Learning Research},\n  year = {2022}\n}\n\n@inproceedings{zhou2022expert,\n  title = {Mixture-of-Experts with Expert Choice Routing},\n  author = {Zhou, Yanqi and Lei, Tao and Liu, Hanxiao and Du, Nan},\n  booktitle = {Advances in Neural Information Processing Systems},\n  year = {2022}\n}\n\n@inproceedings{lepikhin2020gshard,\n  title = {{GShard}: Scaling Giant Models with Conditional Computation and Automatic Sharding},\n  author = {Lepikhin, Dmitry and Lee, HyoukJoong and Xu, Yuanzhong},\n  booktitle = {International Conference on Learning Representations},\n  year = {2021}\n}\n',
};

/** The paper as pdflatex would set it, printed by Chromium: before and after the citation goes in. */
function paperHtml(cited) {
  const refs = [
    'Fedus, W., Zoph, B., and Shazeer, N. Switch Transformers: Scaling to trillion parameter models with simple and efficient sparsity. <i>Journal of Machine Learning Research</i>, 23(120), 2022.',
    'Lepikhin, D., Lee, H., and Xu, Y. GShard: Scaling giant models with conditional computation and automatic sharding. In <i>International Conference on Learning Representations</i>, 2021.',
    ...(cited ? ['Wang, L., Gao, H., Zhao, C., Sun, X., and Dai, D. Auxiliary-loss-free load balancing strategy for mixture-of-experts. <i>arXiv preprint arXiv:2408.15664</i>, 2024.'] : []),
    'Zhou, Y., Lei, T., Liu, H., and Du, N. Mixture-of-experts with expert choice routing. In <i>Advances in Neural Information Processing Systems</i>, 2022.',
    'Zoph, B., Bello, I., Kumar, S., Du, N., Huang, Y., Dean, J., Shazeer, N., and Fedus, W. ST-MoE: Designing stable and transferable sparse expert models. <i>Journal of Machine Learning Research</i>, 2022.',
  ];
  const c = (text) => `<span class="c">${text}</span>`;
  return `<!doctype html><html><head><style>
  @page { size: letter; margin: 1in 1.25in; }
  body { font-family: 'Times New Roman', Times, 'Liberation Serif', serif; font-size: 10pt; line-height: 1.32; color: #000; }
  .head { font-size: 8pt; border-bottom: 0.5pt solid #000; padding-bottom: 2pt; margin-bottom: 18pt; }
  h1 { font-size: 17pt; font-weight: bold; margin: 0 0 14pt; font-variant: small-caps; letter-spacing: 0.2pt; }
  .auth { margin-bottom: 22pt; } .auth b { display: block; }
  .abs-h { text-align: center; font-weight: bold; font-variant: small-caps; font-size: 12pt; margin: 0 0 6pt; }
  .abs { margin: 0 0.5in 18pt; text-align: justify; }
  h2 { font-size: 12pt; font-variant: small-caps; margin: 16pt 0 8pt; }
  p { text-align: justify; margin: 0 0 7pt; } .c { color: #1a4fa0; }
  .refs p { padding-left: 1.2em; text-indent: -1.2em; margin-bottom: 5pt; }
  .foot { position: fixed; bottom: 0; left: 0; right: 0; text-align: center; }
  </style></head><body>
  <div class="head">Under review as a conference paper at ICLR 2027</div>
  <h1>Loss-free routing at 8B</h1>
  <div class="auth"><b>Anonymous authors</b>Paper under double-blind review</div>
  <div class="abs-h">Abstract</div>
  <div class="abs">Mixture-of-experts language models keep their experts evenly loaded with an auxiliary loss, whose weight trades balance against quality. We train an 8B-parameter sparse model whose router is balanced by a per-expert bias, used only to pick experts and updated from each batch’s load, with no auxiliary loss at all. It matches the balance of the auxiliary loss and improves validation perplexity by 2.1%.</div>
  <h2>1&nbsp;&nbsp;&nbsp;Introduction</h2>
  <p>Sparse mixture-of-experts models route each token to a few experts, so a model can grow without its compute growing with it.</p>
  <h2>2&nbsp;&nbsp;&nbsp;Related work</h2>
  <p><b>Load balancing.</b> Most MoE models keep experts busy with an auxiliary loss on the router ${c('(Fedus et al., 2022; Zoph et al., 2022)')}. Its weight trades balance against quality: too small and experts collapse, too large and the LM loss suffers ${c('(Zoph et al., 2022)')}. Expert choice routing side-steps this by letting experts pick tokens ${c('(Zhou et al., 2022)')}.</p>
  <p><b>Routing at scale.</b> GShard ${c('(Lepikhin et al., 2021)')} trained a 600B-parameter MoE with top-2 gating.</p>
  <p><b>Bias-based balancing.</b> Closest to us, a per-expert bias used only for selection, updated from the load each batch, balances without a loss${cited ? ` ${c('(Wang et al., 2024)')}` : ''}.</p>
  <h2>References</h2>
  <div class="refs">${refs.map((r) => `<p>${r}</p>`).join('')}</div>
  </body></html>`;
}

// ------------------------------------------------------------------ papers ---

const variant = (source, bibtex, of) => ({ source, bibtex, fetchedAt: day(1), of });
const paper = (id, arxivId, title, authors, abstract, extra) => ({ id, source: 'arxiv', arxivId, title, authors, abstract, published: '2022-01-01', categories: ['cs.LG'], addedAt: day(5), collectionIds: [PROJECT], tags: [], progress: 0, ...extra });
const PAPERS = [
  paper('arxiv:2408.15664', '2408.15664', 'Auxiliary-Loss-Free Load Balancing Strategy for Mixture-of-Experts', ['Lean Wang', 'Huazuo Gao', 'Chenggang Zhao', 'Xu Sun', 'Damai Dai'], 'We propose Loss-Free Balancing: a bias term is added to the routing scores and used only for the top-K selection, updated by the load of each expert, so no auxiliary loss is needed.', {
    published: '2024-08-28',
    progress: 0.3,
    lastOpenedAt: day(0),
    citation: { lookedAt: day(1), variants: [variant('arxiv', '@misc{wang2024auxiliary,\n  title         = {Auxiliary-Loss-Free Load Balancing Strategy for Mixture-of-Experts},\n  author        = {Lean Wang and Huazuo Gao and Chenggang Zhao and Xu Sun and Damai Dai},\n  year          = {2024},\n  eprint        = {2408.15664},\n  archiveprefix = {arXiv},\n  primaryclass  = {cs.LG},\n  url           = {https://arxiv.org/abs/2408.15664}\n}', '2408.15664')] },
  }),
  paper('arxiv:2202.08906', '2202.08906', 'ST-MoE: Designing Stable and Transferable Sparse Expert Models', ['Barret Zoph', 'Irwan Bello', 'Sameer Kumar', 'Nan Du', 'Yanping Huang', 'Jeff Dean', 'Noam Shazeer', 'William Fedus'], 'Router z-loss stabilises the training of sparse expert models; we trade balance against quality.', {
    published: '2022-02-17',
    progress: 0.5,
    lastOpenedAt: day(1),
    citation: {
      lookedAt: day(1),
      publishedDoi: '10.5555/3586589.3586709',
      publishedIn: 'Journal of Machine Learning Research 2022',
      variants: [
        variant('arxiv', '@misc{zoph2022stmoe,\n  title         = {ST-MoE: Designing Stable and Transferable Sparse Expert Models},\n  author        = {Barret Zoph and Irwan Bello and Sameer Kumar and Nan Du and Yanping Huang and Jeff Dean and Noam Shazeer and William Fedus},\n  year          = {2022},\n  eprint        = {2202.08906},\n  archiveprefix = {arXiv},\n  primaryclass  = {cs.CL}\n}', '2202.08906'),
        variant('crossref', '@article{Zoph_2022,\n  title={ST-MoE: Designing Stable and Transferable Sparse Expert Models},\n  volume={23},\n  number={1},\n  journal={Journal of Machine Learning Research},\n  publisher={JMLR.org},\n  author={Zoph, Barret and Bello, Irwan and Kumar, Sameer and Du, Nan and Huang, Yanping and Dean, Jeff and Shazeer, Noam and Fedus, William},\n  year={2022},\n  pages={1--39}\n}', '10.5555/3586589.3586709'),
        variant('dblp', '@article{DBLP:journals/corr/abs-2202-08906,\n  author    = {Barret Zoph and Irwan Bello and Sameer Kumar and Nan Du and Yanping Huang and Jeff Dean and Noam Shazeer and William Fedus},\n  title     = {Designing Effective Sparse Expert Models},\n  journal   = {CoRR},\n  volume    = {abs/2202.08906},\n  year      = {2022}\n}', 'journals/corr/abs-2202-08906'),
      ],
    },
  }),
  paper('arxiv:2101.03961', '2101.03961', 'Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity', ['William Fedus', 'Barret Zoph', 'Noam Shazeer'], 'An auxiliary load balancing loss and expert capacity; top-1 routing is enough, and cheaper.', {
    published: '2021-01-11',
    doi: '10.5555/3586589.3586709',
    venue: 'Journal of Machine Learning Research',
    progress: 1,
    lastOpenedAt: day(3),
    citation: { lookedAt: day(1), variants: [variant('crossref', '@article{Fedus_2022,\n  title={Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity},\n  volume={23},\n  number={120},\n  journal={Journal of Machine Learning Research},\n  author={Fedus, William and Zoph, Barret and Shazeer, Noam},\n  year={2022},\n  pages={1--39}\n}', '10.5555/3586589.3586709')] },
  }),
  paper('arxiv:2006.16668', '2006.16668', 'GShard: Scaling Giant Models with Conditional Computation and Automatic Sharding', ['Dmitry Lepikhin', 'HyoukJoong Lee', 'Yuanzhong Xu', 'Dehao Chen', 'Orhan Firat'], 'A 600B-parameter multilingual MoE Transformer with top-2 gating.', {
    published: '2020-06-30',
    venue: 'International Conference on Learning Representations',
    progress: 1,
    lastOpenedAt: day(9),
    citation: { lookedAt: day(1), variants: [variant('dblp', '@inproceedings{DBLP:conf/iclr/LepikhinLXCFHKS21,\n  author    = {Dmitry Lepikhin and HyoukJoong Lee and Yuanzhong Xu and Dehao Chen and Orhan Firat},\n  title     = {{GShard}: Scaling Giant Models with Conditional Computation and Automatic Sharding},\n  booktitle = {9th International Conference on Learning Representations, {ICLR} 2021},\n  year      = {2021}\n}', 'conf/iclr/LepikhinLXCFHKS21')] },
  }),
  paper('arxiv:2202.09368', '2202.09368', 'Mixture-of-Experts with Expert Choice Routing', ['Yanqi Zhou', 'Tao Lei', 'Hanxiao Liu', 'Nan Du'], 'Experts pick the tokens: expert choice routing balances load without an auxiliary loss.', {
    published: '2022-02-18',
    venue: 'Advances in Neural Information Processing Systems',
    progress: 0.8,
    lastOpenedAt: day(2),
    citation: { lookedAt: day(1), variants: [variant('dblp', '@inproceedings{DBLP:conf/nips/ZhouLLDHZDLC22,\n  author    = {Yanqi Zhou and Tao Lei and Hanxiao Liu and Nan Du},\n  title     = {Mixture-of-Experts with Expert Choice Routing},\n  booktitle = {Advances in Neural Information Processing Systems 35},\n  year      = {2022}\n}', 'conf/nips/ZhouLLDHZDLC22')] },
  }),
  // The other projects' papers, for the board.
  { ...paper('arxiv:2010.08895', '2010.08895', 'Fourier Neural Operator for Parametric Partial Differential Equations', ['Zongyi Li', 'Nikola Kovachki', 'Kamyar Azizzadenesheli'], 'Learning mappings between function spaces with a Fourier layer.'), collectionIds: ['p-fno'], progress: 0.6, lastOpenedAt: day(4) },
  { ...paper('arxiv:1910.03193', '1910.03193', 'DeepONet: Learning nonlinear operators', ['Lu Lu', 'Pengzhan Jin', 'George Em Karniadakis'], 'Operator learning with branch and trunk networks.'), collectionIds: ['p-fno'], progress: 0.2 },
  { ...paper('arxiv:2205.09991', '2205.09991', 'Planning with Diffusion for Flexible Behavior Synthesis', ['Michael Janner', 'Yilun Du', 'Joshua Tenenbaum', 'Sergey Levine'], 'Diffuser: trajectory-level diffusion for planning.'), collectionIds: ['p-diff'], progress: 0.9, lastOpenedAt: day(6) },
];
const ROLES = { 'arxiv:2408.15664': 'core', 'arxiv:2202.08906': 'core', 'arxiv:2101.03961': 'baseline', 'arxiv:2006.16668': 'baseline', 'arxiv:2202.09368': 'method' };
const HIGHLIGHTS = [{ id: 'h-wang-1', paperId: 'arxiv:2408.15664', color: 'yellow', exact: 'a bias term is added to the routing scores and used only for the top-K selection, updated by the load of each expert', prefix: 'We propose Loss-Free Balancing: ', suffix: ', so no auxiliary loss', hint: 1, tags: [], createdAt: day(1) }];

// --------------------------------------------------------------- the room ---

const place = (more) => ({ active: true, at: Date.now(), ...more });
const MEMBERS = [
  { email: ME, role: 'owner', name: 'Saurav C', color: '#8a3a6e', joinedAt: '2026-09-01T00:00:00.000Z', place: null, lastSeen: null, lastPlace: null },
  { email: PRIYA, role: 'editor', name: 'Priya Natarajan', color: '#b27414', joinedAt: '2026-09-02T00:00:00.000Z', place: place({ tab: 'code', path: 'src/train.py', line: 42, col: 9, offset: 1180 }), lastSeen: null, lastPlace: null },
  { email: MARCO, role: 'editor', name: 'Marco Ruiz', color: '#2d64a0', joinedAt: '2026-09-03T00:00:00.000Z', place: place({ tab: 'write', path: 'sections/related.tex', line: 4 }), lastSeen: null, lastPlace: null },
  { email: LIN, role: 'viewer', name: 'Lin Zhao', color: '#1f8a70', joinedAt: '2026-09-04T00:00:00.000Z', place: null, lastSeen: Date.now() - 26 * 3600_000, lastPlace: place({ tab: 'read' }) },
];
const OVERLEAF = { url: 'https://www.overleaf.com/project/66f1c0a9e2b7d4a1b2c3d4e5', keep: { where: 'computer', at: day(3) }, folders: { 'mac-1': { path: 'papers/sparse-gated-moe', sync: 'folder' } } };
const TODOS = [
  { id: 't0', text: 'Reproduce top-2 at 350M', done: true },
  { id: 't1', text: 'Draft §4: routing without aux loss', done: false },
];
let SUMMARY = {
  id: PROJECT,
  name: 'Sparse-gated MoE',
  color: '#1f5e52',
  question: 'Can a router balance experts with no auxiliary loss?',
  startedAt: '2026-09-01T00:00:00.000Z',
  papers: PAPERS.filter((p) => p.collectionIds.includes(PROJECT)).map((p) => ({ id: p.id, title: p.title, role: ROLES[p.id] ?? null, source: p.source, authors: p.authors, published: p.published, arxivId: p.arxivId })),
  todos: TODOS,
  overleaf: OVERLEAF,
};
let version = 1;
const roomState = () => ({ room: ROOM, owner: ME, version, project: SUMMARY, me: ME, role: 'owner', members: MEMBERS, invitations: [], link: { token: 't', on: false, domain: '' } });

// The whiteboard: a diagram drawn by hand, in a little stroke font (as logbook-smoke.mjs draws it).
const GLYPHS = {
  R: [[[0, 6], [0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]], [[2, 3], [4, 6]]],
  O: [[[1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0]]],
  U: [[[0, 0], [0, 5], [1, 6], [3, 6], [4, 5], [4, 0]]],
  T: [[[0, 0], [4, 0]], [[2, 0], [2, 6]]],
  E: [[[4, 0], [0, 0], [0, 6], [4, 6]], [[0, 3], [3, 3]]],
  P: [[[0, 6], [0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]]],
  L: [[[0, 0], [0, 6], [4, 6]]],
  A: [[[0, 6], [2, 0], [4, 6]], [[1, 3.6], [3, 3.6]]],
  D: [[[0, 0], [0, 6], [2.5, 6], [4, 4.5], [4, 1.5], [2.5, 0], [0, 0]]],
  B: [[[0, 3], [0, 0], [3, 0], [3.8, 0.8], [3.8, 2.2], [3, 3], [0, 3], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3]]],
  N: [[[0, 6], [0, 0], [4, 6], [4, 0]]],
  C: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5]]],
  K: [[[0, 0], [0, 6]], [[4, 0], [0, 3.5]], [[1.3, 2.7], [4, 6]]],
  S: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 2], [1, 3], [3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5]]],
  G: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 3.5], [2.5, 3.5]]],
  M: [[[0, 6], [0, 0], [2, 3], [4, 0], [4, 6]]],
  I: [[[2, 0], [2, 6]], [[1, 0], [3, 0]], [[1, 6], [3, 6]]],
  X: [[[0, 0], [4, 6]], [[4, 0], [0, 6]]],
  Z: [[[0, 0], [4, 0], [0, 6], [4, 6]]],
  1: [[[1, 1], [2, 0], [2, 6]]],
  2: [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [0, 6], [4, 6]]],
  3: [[[0, 0.5], [1, 0], [3, 0], [4, 1], [4, 2], [3, 3], [1.5, 3]], [[3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5.5]]],
  4: [[[3, 6], [3, 0], [0, 4], [4, 4]]],
  '-': [[[0.5, 3], [3.5, 3]]],
  '?': [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [2, 3.5], [2, 4.5]], [[2, 5.7], [2, 6]]],
};
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const jitter = (amount) => (rand() - 0.5) * amount;
let sid = 0;
function stroke(points, { color = '#1a1a17', width = 3, tool = 'pen', by = ME, wobble = 1.2 } = {}) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [[x1, y1], [x2, y2]] = [points[i], points[i + 1]];
    const steps = Math.max(2, Math.round(Math.hypot(x2 - x1, y2 - y1) / 6));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const along = (i + t) / (points.length - 1);
      out.push(Math.round((x1 + (x2 - x1) * t + jitter(wobble)) * 10) / 10, Math.round((y1 + (y2 - y1) * t + jitter(wobble)) * 10) / 10, Math.round((0.35 + 0.5 * Math.sin(Math.PI * along) + jitter(0.08)) * 100) / 100);
    }
  }
  const [lx, ly] = points[points.length - 1];
  out.push(lx, ly, 0.3);
  return { id: `s${++sid}`, by, color, width, tool, points: out, at: new Date(Date.now() - (400 - sid) * 1000).toISOString() };
}
function write(text, x, y, size, options) {
  const strokes = [];
  const unit = size / 6;
  let cursor = x;
  for (const char of text) {
    if (char === ' ') {
      cursor += unit * 4;
      continue;
    }
    for (const line of GLYPHS[char] ?? []) strokes.push(stroke(line.map(([gx, gy]) => [cursor + gx * unit + jitter(unit * 0.15), y + gy * unit + jitter(unit * 0.15)]), { ...options, wobble: unit * 0.12 }));
    cursor += unit * 6;
  }
  return strokes;
}
const box = (x, y, w, h, options) => stroke([[x, y], [x + w, y + 2], [x + w - 1, y + h], [x + 1, y + h - 1], [x, y + 3]], options);
const arrow = (x1, y1, x2, y2, options) => {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = 16;
  return [stroke([[x1, y1], [x2, y2]], options), stroke([[x2 - head * Math.cos(angle - 0.45), y2 - head * Math.sin(angle - 0.45)], [x2, y2], [x2 - head * Math.cos(angle + 0.45), y2 - head * Math.sin(angle + 0.45)]], options)];
};
const ellipse = (cx, cy, rx, ry, options) => stroke(Array.from({ length: 34 }, (_, i) => [cx + rx * Math.cos((i / 30) * Math.PI * 2 - 0.4), cy + ry * Math.sin((i / 30) * Math.PI * 2 - 0.4)]), options);
const BOARD = [
  ...write('MOE ROUTING', 70, 60, 34, { width: 3.4 }),
  stroke([[66, 112], [420, 116]], { width: 2.4 }),
  box(80, 400, 190, 110),
  ...write('TOKENS', 104, 438, 26, { width: 2.8 }),
  ...arrow(285, 455, 455, 455),
  box(470, 380, 230, 150),
  ...write('ROUTER', 508, 438, 28, { width: 3 }),
  ...[0, 1, 2, 3].flatMap((i) => [box(940, 180 + i * 175, 170, 110), ...write(`E${i + 1}`, 1000, 215 + i * 175, 30, { width: 3 })]),
  ...arrow(705, 425, 930, 240, { color: '#2d64a0', width: 3 }),
  ...arrow(705, 445, 930, 410, { color: '#2d64a0', width: 3 }),
  ...arrow(705, 470, 930, 585, { color: '#2d64a0', width: 1.6 }),
  ...arrow(705, 490, 930, 760, { color: '#2d64a0', width: 1.6 }),
  stroke([[742, 300], [905, 300]], { tool: 'marker', color: '#b27414', width: 9, wobble: 0.6 }),
  ...write('TOP-2', 760, 282, 22, { color: '#c0392b', width: 2.6 }),
  ellipse(1290, 520, 175, 70, { color: '#c0392b', width: 2.6, by: PRIYA }),
  ...write('LOAD BALANCE?', 1150, 506, 22, { color: '#c0392b', width: 2.4, by: PRIYA }),
  ...arrow(1215, 455, 1120, 360, { color: '#c0392b', width: 2.2, by: PRIYA }),
  ...write('NO AUX LOSS', 1150, 640, 22, { color: '#1f8a70', width: 2.6, by: MARCO }),
  ...write('Z-LOSS 1E-3', 1150, 690, 22, { color: '#1f8a70', width: 2.6, by: MARCO }),
  ...arrow(1165, 740, 1120, 790, { color: '#1f8a70', width: 2, by: MARCO }),
];
const LOG = {
  notes: [
    {
      id: 'granola:not_5Kd1',
      meeting: 'lab@group.calendar.google.com:moe-weekly_1',
      title: 'MoE weekly',
      start: day(2),
      end: day(2),
      source: 'granola',
      url: 'https://notes.granola.ai/d/5Kd1',
      call: 'https://iith.zoom.us/j/8123456789',
      attendees: ['Priya Natarajan', 'Marco Ruiz', 'Lin Zhao'],
      markdown: '### Where we are\n- Top-2 baseline reproduced at 350M; matches the paper within 0.01.\n- Expert-choice run diverges at 12k steps.\n\n### Action items\n- [x] Priya: write the capacity-factor sweep\n- [ ] Marco: find why the aux loss rises with batch size',
      by: ME,
      at: day(2),
    },
  ], links: [], pad: { text: '# Sparse-gated MoE — running notes\n', version: 1, by: MARCO, at: day(0) }, strokes: BOARD };

// ------------------------------------------------------------ the calendar ---

const LAB = 'lab@group.calendar.google.com';
const CALENDARS = [
  { id: ME, summary: ME, backgroundColor: '#1f5e52', primary: true, selected: true, accessRole: 'owner' },
  { id: LAB, summary: 'Lab group', backgroundColor: '#7e57c2', selected: true, accessRole: 'writer' },
];
const pad = (n) => String(n).padStart(2, '0');
const startOfToday = new Date();
startOfToday.setHours(0, 0, 0, 0);
const at = (days, hour, minute = 0) => {
  const d = new Date(startOfToday.getTime() + days * 86_400_000);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};
const team = ['Priya Natarajan', 'Marco Ruiz', 'Lin Zhao'].map((name) => ({ email: `${name.toLowerCase().split(' ')[0]}@example.org`, displayName: name, responseStatus: 'accepted' }));
let eventN = 0;
const ev = (calendar, summary, start, end, extra = {}) => ({ calendar, item: { id: `e${++eventN}`, summary, status: 'confirmed', start: { dateTime: start }, end: { dateTime: end }, htmlLink: 'https://calendar.google.com/', attendees: [{ email: ME, self: true, responseStatus: 'accepted' }, ...team], ...extra } });
// The week around today (Sunday … Saturday), at hours that sit on the grid.
const dow = startOfToday.getDay();
const EVENTS = [
  ...[1, 4].map((d) => ev(LAB, 'MoE weekly', at(d - dow, 9), at(d - dow, 10), { location: 'https://iith.zoom.us/j/8123456789' })),
  ev(LAB, 'Router ablations sync', at(0, 15), at(0, 15, 45)),
  ev(ME, 'Reading group: Expert Choice routing', at(2 - dow + 1, 11), at(2 - dow + 1, 12)),
  ev(ME, '1:1 with Prof. Rao', at(2 - dow, 16), at(2 - dow, 16, 30)),
  ev(ME, 'Write §4: routing without aux loss', at(5 - dow, 10), at(5 - dow, 12, 30)),
  ev(LAB, 'Seminar: Scaling laws', at(4 - dow, 15), at(4 - dow, 16), { location: 'Auditorium' }),
  ev(ME, 'Lunch', at(0, 13), at(0, 14), { location: 'Canteen', attendees: [] }),
  ev(LAB, 'Cluster booking: 2×8 H100', at(1 - dow, 14), at(1 - dow, 15, 30)),
];
void pad;

// ------------------------------------------------------------------- setup ---

let socket = null;
const tell = (message) => socket?.send(JSON.stringify(message));

export async function setup(context) {
  // The paper's folder, fresh each take.
  rmSync(COMPANION_ROOT, { recursive: true, force: true });
  mkdirSync(path.join(COMPANION_ROOT, FOLDER, 'sections'), { recursive: true });
  for (const [file, text] of Object.entries(FILES)) writeFileSync(path.join(COMPANION_ROOT, FOLDER, file), text);

  // The two PDFs the compile answers with, set by Chromium.
  const printer = await context.newPage();
  const pdfs = {};
  for (const cited of [false, true]) {
    await printer.setContent(paperHtml(cited));
    pdfs[cited] = (await printer.pdf({ format: 'Letter', printBackground: true })).toString('base64');
  }
  await printer.close();

  await installGoogle(context, { pdf: makePdf(['A paper']), profile: { name: 'Saurav C', email: ME }, settings: { ...settingsScript({ navStyle: 'labelled', proxyToken: PASS, write: { pdf: 'here', compile: 'manual', engine: 'auto', layout: 'side', sync: 'manual', citations: 'drawer', errors: 'continue' } }), theme: undefined } });
  await context.addInitScript(() => {
    localStorage.setItem('reader.tour', 'seen');
    // Each scope asked for is granted, as Google would once you said yes.
    window.google.accounts.oauth2.initTokenClient = (config) => ({
      requestAccessToken: () => setTimeout(() => config.callback({ access_token: `token-${config.scope.split(' ').length}`, expires_in: 3600, scope: config.scope }), 10),
    });
  });
  await context.route('**/www.googleapis.com/calendar/v3/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/users/me/calendarList')) return route.fulfill(json({ items: CALENDARS }));
    const list = url.pathname.match(/\/calendars\/([^/]+)\/events$/);
    if (list && route.request().method() === 'GET') {
      const min = Date.parse(url.searchParams.get('timeMin'));
      const max = Date.parse(url.searchParams.get('timeMax'));
      const id = decodeURIComponent(list[1]);
      const items = EVENTS.filter((event) => event.calendar === id && Date.parse(event.item.start.dateTime) < max && Date.parse(event.item.end.dateTime) > min).map((event) => event.item);
      return route.fulfill(json({ items }));
    }
    return route.fulfill({ status: 404, ...json({}) });
  });

  // The room: its state, its log, and its live socket.
  await context.route('**/api/rooms/mine', (route) => route.fulfill(json({ rooms: [] })));
  await context.route('**/api/invites/**', (route) => route.fulfill(json({ invitations: [] })));
  await context.route(`**/api/rooms/${ROOM}**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/project')) {
      const body = route.request().postDataJSON();
      SUMMARY = { ...SUMMARY, ...body.project, id: PROJECT };
      version += 1;
    }
    if (!url.pathname.endsWith('/log')) return route.fulfill(json(roomState()));
    if (route.request().method() !== 'POST') return route.fulfill(json(LOG));
    const body = route.request().postDataJSON();
    if (body.op === 'stroke') {
      LOG.strokes = [...LOG.strokes, ...body.strokes];
      return route.fulfill(json({ strokes: body.strokes }));
    }
    return route.fulfill(json({ ok: true }));
  });
  await context.routeWebSocket(`**/api/rooms/${ROOM}/live`, (ws) => {
    socket = ws;
    ws.onMessage(() => undefined);
    ws.send(JSON.stringify({ type: 'here', state: roomState() }));
  });

  // This computer's Companion, stood in for: the paper's folder, and a compile that makes the PDF.
  await context.route(/^https?:\/\/127\.0\.0\.1:473[23]1\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS' };
    if (url.port === '47331') return route.abort();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
    if (url.pathname === '/companion/info') return reply({ app: 'reader-companion', version: '0.20.0', id: 'mac-1', name: 'Saurav’s MacBook Pro', hardware: 'Apple M3 Pro · 12 cores · 36 GB', root: '~/Reader' });
    if (request.headers().authorization !== 'token pc-token') return reply({ error: 'Pair first' }, 403);
    if (url.pathname === '/companion/paper' && request.method() === 'GET') return reply({ latexmk: '/Library/TeX/texbin/latexmk', tectonic: '', git: '/usr/bin/git', tectonicInstallable: false, texlive: { installed: true, state: 'idle', path: '/Library/TeX/texbin' } });
    if (url.pathname === '/companion/paper') {
      const body = request.postDataJSON();
      if (body.action === 'remote') return reply({ url: '', token: false });
      if (body.action === 'templates') return reply({ templates: [] });
      if (body.action === 'texlive') return reply({ installed: true, state: 'idle', path: '/Library/TeX/texbin' });
      if (body.action === 'token') return reply({ known: false });
      if (body.action === 'compile') {
        const cited = readFileSync(path.join(COMPANION_ROOT, FOLDER, 'sections/related.tex'), 'utf8').includes('wang2024');
        await new Promise((resolve) => setTimeout(resolve, 1400));
        return reply({ ok: true, main: 'main.tex', engine: 'latexmk', compiler: 'pdflatex', pdf: pdfs[cited], errors: [], warnings: [], log: 'Output written on main.pdf (1 page).', ms: 1840 });
      }
      return reply({ error: 'no' }, 404);
    }
    if (url.pathname.startsWith('/api/contents')) {
      const at = decodeURIComponent(url.pathname.replace(/^\/api\/contents\/?/, ''));
      const full = path.join(COMPANION_ROOT, at);
      if (request.method() === 'PUT') {
        const body = request.postDataJSON();
        if (body.type === 'directory') mkdirSync(full, { recursive: true });
        else writeFileSync(full, body.format === 'base64' ? Buffer.from(body.content, 'base64') : body.content);
        return reply({ name: at.split('/').pop(), path: at, type: body.type, last_modified: new Date().toISOString() });
      }
      if (!existsSync(full)) return reply({ message: 'No such file' }, 404);
      if (statSync(full).isDirectory()) {
        const content = readdirSync(full).map((name) => ({ name, path: at ? `${at}/${name}` : name, type: statSync(path.join(full, name)).isDirectory() ? 'directory' : 'file', size: null, last_modified: null }));
        return reply({ name: at.split('/').pop(), path: at, type: 'directory', content });
      }
      return reply({ name: at.split('/').pop(), path: at, type: 'file', format: 'text', content: readFileSync(full, 'utf8'), last_modified: null });
    }
    return reply({ error: 'no' }, 404);
  });
}

// ----------------------------------------------------------------- prepare ---

export async function prepare({ page }) {
  const BASE = SITE.replace(/\/?$/, '/');
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(`${BASE}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /Connect Google Drive|Sign in with Google/i }).first().click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /Start reading|Not now/i }).first().click().catch(() => undefined);
  await page.waitForTimeout(500);
  await page.evaluate(
    async ({ ROOM, ME, PROJECT, PAPERS, HIGHLIGHTS, ROLES, TODOS, OVERLEAF }) => {
      localStorage.setItem('reader.playground.servers', JSON.stringify([{ id: 's-mac', name: 'Saurav’s MacBook Pro', url: 'http://127.0.0.1:47321/', token: 'pc-token', where: 'pc', companionId: 'mac-1' }]));
      const name = (await indexedDB.databases()).map((item) => item.name).find((item) => item.includes(ME)) ?? 'reader';
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const put = (store, value) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).put(value);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      await put('collections', {
        id: PROJECT,
        name: 'Sparse-gated MoE',
        color: '#1f5e52',
        createdAt: '2026-09-01T00:00:00.000Z',
        project: {
          question: 'Can a router balance experts with no auxiliary loss?',
          startedAt: '2026-09-01T00:00:00.000Z',
          roles: ROLES,
          todos: TODOS,
          shared: { room: ROOM, owner: ME, role: 'owner' },
          overleaf: OVERLEAF,
        },
      });
      await put('collections', { id: 'p-fno', name: 'Neural operators', color: '#2d64a0', createdAt: '2026-09-10T00:00:00.000Z', project: { question: 'Do neural operators transfer across resolutions?', startedAt: '2026-09-10T00:00:00.000Z', roles: { 'arxiv:2010.08895': 'core', 'arxiv:1910.03193': 'baseline' }, todos: [] } });
      await put('collections', { id: 'p-diff', name: 'Diffusion for planning', color: '#b27414', createdAt: '2026-09-20T00:00:00.000Z', project: { question: 'Can a diffusion planner replan in under 50 ms?', startedAt: '2026-09-20T00:00:00.000Z', roles: { 'arxiv:2205.09991': 'core' }, todos: [] } });
      for (const paper of PAPERS) await put('papers', paper);
      for (const highlight of HIGHLIGHTS) await put('highlights', highlight);
      db.close();
    },
    { ROOM, ME, PROJECT, PAPERS, HIGHLIGHTS, ROLES, TODOS, OVERLEAF },
  );
  // The calendar connected once, off camera.
  await page.goto(`${BASE}calendar`, { waitUntil: 'networkidle' });
  const connect = page.getByRole('button', { name: 'Connect Google Calendar' });
  if (await connect.isVisible().catch(() => false)) await connect.click();
  await page.waitForSelector('.cal-time', { timeout: 10_000 });
  await page.goto(`${BASE}projects`, { waitUntil: 'networkidle' });
  for (const label of ['Close the library panel', 'Close the discover panel']) {
    const button = page.getByRole('button', { name: label });
    if (await button.isVisible().catch(() => false)) await button.click();
  }
  await page.waitForTimeout(1200);
}

const hold = (page, ms) => page.waitForTimeout(ms);
const shot = (page, name) => page.screenshot({ path: path.join(ROOT, `.video/work/projects-${name}.png`) });

export default async function ({ page, pointer, mark, spot, unspot }) {
  await hold(page, 1500);
  mark('board');
  const card = page.locator('.pj-card', { hasText: 'Sparse-gated MoE' });
  await spot(card);
  await pointer.moveTo(card);
  await hold(page, 2500);
  await shot(page, 'board');

  mark('overview');
  unspot();
  await pointer.click(card.getByRole('button', { name: 'Overview' }));
  await page.locator('.pj-people-btn').waitFor({ timeout: 15_000 });
  await hold(page, 2200);

  mark('presence');
  const avatars = page.locator('.pj-people-btn');
  await spot(avatars);
  await pointer.moveTo(avatars, { dx: 0.05 });
  await hold(page, 1500);
  await pointer.moveTo(page.locator('.pj-avatars .pj-av[title^="Priya"]'));
  await page.locator('.pj-person').waitFor({ timeout: 5000 }).catch(() => undefined);
  await spot([avatars, page.locator('.pj-person')]);
  await hold(page, 2600);
  await shot(page, 'presence');
  unspot();
  await pointer.moveTo({ x: 900, y: 500 });
  tell({ type: 'place', who: PRIYA, place: place({ tab: 'code', path: 'src/router.py', line: 118, col: 1, offset: 4100 }) });
  await page.locator('.pj-toast').waitFor({ timeout: 5000 }).catch(() => undefined);
  await spot(page.locator('.pj-toast'));
  await hold(page, 2800);
  await shot(page, 'toast');

  mark('papers');
  unspot();
  await page.mouse.wheel(0, 650);
  await hold(page, 900);
  await spot([page.locator('.pj-group').nth(0), page.locator('.pj-group').nth(1), page.locator('.pj-group').nth(2)]);
  await hold(page, 2400);
  await shot(page, 'papers');

  mark('bibliography');
  unspot();
  const bib = page.locator('.bib-card');
  await bib.scrollIntoViewIfNeeded();
  const stmoe = bib.locator('.bib-row', { hasText: 'ST-MoE' });
  await pointer.moveTo(stmoe.locator('.bib-main'));
  await hold(page, 300);
  await spot(stmoe);
  await pointer.click(stmoe.locator('.bib-main'));
  await bib.locator('.bib-variant').first().waitFor();
  await hold(page, 500);
  await spot([stmoe, bib.locator('.bib-variant').nth(0), bib.locator('.bib-variant').nth(1), bib.locator('.bib-variant').nth(2), bib.locator('.bib-text')]);
  await hold(page, 3000);
  await shot(page, 'bib');

  mark('write');
  unspot();
  await pointer.click(page.locator('.pj-views').getByRole('button', { name: 'Write' }));
  const doc = page.locator('.wr-doc').first();
  await Promise.race([doc.waitFor({ timeout: 20_000 }), page.locator('.wr-tree-item').first().waitFor({ timeout: 20_000 })]);
  if (await doc.isVisible().catch(() => false)) await pointer.click(doc);
  const related = page.locator('.wr-tree-item', { hasText: 'related.tex' });
  await related.waitFor({ timeout: 20_000 });
  await pointer.click(related);
  const area = page.locator('.wr-editor textarea');
  await page.waitForFunction(() => /balances without a loss/.test(document.querySelector('.wr-editor textarea')?.value ?? ''), null, { timeout: 10_000 });
  await spot(page.locator('.wr-editor'));
  await hold(page, 1600);

  mark('compile');
  const recompile = page.getByRole('button', { name: /^(Recompile|Compiling…)$/ });
  await spot(recompile);
  await pointer.click(recompile);
  await page.locator('.wr-pdf canvas, .wr-pdf img, .wr-pdf-pages *').first().waitFor({ timeout: 15_000 });
  await spot(page.locator('.wr-pdf'));
  await hold(page, 3000);
  await shot(page, 'compiled');

  mark('cite');
  unspot();
  const box = await area.boundingBox();
  await pointer.moveTo({ x: box.x + box.width * 0.6, y: box.y + box.height * 0.45 });
  await page.evaluate(() => {
    const element = document.querySelector('.wr-editor textarea');
    const end = element.value.indexOf('without a loss.') + 'without a loss.'.length;
    element.focus();
    element.setSelectionRange(end, end);
    element.dispatchEvent(new Event('select', { bubbles: true }));
  });
  await page.keyboard.press('End');
  const helper = page.locator('.wr-helper');
  await helper.waitFor({ timeout: 8000 });
  // The sentence: the two lines above the card, which opens under the caret.
  const lineHeight = await area.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 22);
  const card2 = await helper.boundingBox();
  const sentence = { x: box.x, y: card2.y - lineHeight * 2.4, w: box.width, h: lineHeight * 2.2 };
  await spot([sentence, helper]);
  await hold(page, 1200);
  const first = page.locator('.wr-helper-item').first();
  await pointer.moveTo(first);
  await hold(page, 2400);
  await shot(page, 'cite-card');
  await pointer.click(first, { pause: 900 });
  await spot(sentence);
  await hold(page, 1500);

  mark('recompile');
  unspot();
  await pointer.click(recompile);
  await page.waitForTimeout(2600);
  // Where the citation and its reference are on the page, as the PDF is set (paperHtml).
  const sheet = await page.locator('.wr-page').first().boundingBox();
  if (sheet) {
    const at = (top, bottom) => ({ x: sheet.x + sheet.width * 0.12, y: sheet.y + sheet.height * top, w: sheet.width * 0.76, h: sheet.height * (bottom - top) });
    await spot([at(0.592, 0.632), at(0.758, 0.792)]);
  } else await spot(page.locator('.wr-pdf'));
  await pointer.moveTo(page.locator('.wr-pdf'), { dy: 0.6 });
  await hold(page, 3000);
  await shot(page, 'recompiled');

  mark('logbook');
  unspot();
  await pointer.click(page.locator('.pj-views').getByRole('button', { name: 'Logbook' }));
  await pointer.click(page.locator('.lb-tab', { hasText: 'Whiteboard' }));
  const canvas = page.locator('.lb-canvas');
  await canvas.waitFor();
  await spot(canvas);
  await hold(page, 1600);
  tell({ type: 'place', who: PRIYA, place: place({ tab: 'logbook', path: 'board' }) });
  const tick = [[1125, 400], [1132, 410], [1140, 420], [1150, 404], [1160, 388], [1170, 372]];
  const board = await canvas.boundingBox();
  const k = board.width / 1600;
  await spot([{ x: board.x + 920 * k, y: board.y + 330 * k, w: 560 * k, h: 300 * k }, page.locator('.lb-drawing')]);
  for (let i = 2; i <= tick.length; i++) {
    tell({ type: 'ink', who: PRIYA, stroke: stroke(tick.slice(0, i), { color: '#b27414', width: 4, by: PRIYA }) });
    await hold(page, 160);
  }
  await hold(page, 3000);
  await shot(page, 'board-drawing');

  mark('calendar');
  unspot();
  await pointer.click(page.locator('nav.rail').getByRole('button', { name: 'Calendar' }).first());
  await page.waitForSelector('.cal-time', { timeout: 10_000 });
  await hold(page, 300);
  // The morning into view, smoothly, as a scroll of the grid would.
  await page.evaluate(() => {
    const label = [...document.querySelectorAll('.cal-time *')].find((el) => !el.children.length && /^8\s?AM$/i.test(el.textContent.trim()));
    label?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  await pointer.moveTo(page.locator('.cal-time').first(), { dy: 0.3 });
  await hold(page, 2200);
  const event = page.locator('.cal-ev', { hasText: 'Router ablations sync' }).first();
  await spot(event);
  await pointer.click(event);
  await page.locator('.cal-card').waitFor({ timeout: 5000 }).catch(() => undefined);
  await spot([event, page.locator('.cal-card')]);
  await hold(page, 3000);
  await shot(page, 'calendar');
  unspot();
  await hold(page, 500);
}
