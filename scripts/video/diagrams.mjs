/**
 * Diagrams for the videos (edit.mjs): each is a list of steps, a full frame
 * of HTML each, revealed in turn at `at` seconds into the shot.
 */

const BG = `position:absolute; inset:0; background: radial-gradient(1200px 700px at 30% 20%, #18213a 0%, #0c111f 55%, #080b14 100%);`;
const STARS = Array.from({ length: 90 }, (_, i) => {
  const x = (i * 197) % 1920;
  const y = (i * 263) % 1080;
  const r = (i % 3) * 0.5 + 0.6;
  return `<circle cx="${x}" cy="${y}" r="${r}" fill="#e9dcb8" opacity="${0.12 + (i % 5) * 0.06}"/>`;
}).join('');

const box = ({ x, y, w, h, title, kicker, items = [], accent = '#d8b46a', on = true }) => `
  <div style="position:absolute; left:${x}px; top:${y}px; width:${w}px; height:${h}px; box-sizing:border-box; border-radius:22px;
    background:rgba(21,28,48,0.92); border:1.5px solid ${accent}66; box-shadow:0 24px 60px rgba(0,0,0,0.45); padding:26px 30px;
    opacity:${on ? 1 : 0}">
    <div style="font-family:'Plex Mono'; font-size:17px; letter-spacing:0.14em; color:${accent}; text-transform:uppercase">${kicker}</div>
    <div style="font-family:'Newsreader'; font-size:40px; line-height:1.1; margin:8px 0 14px">${title}</div>
    ${items.map((t) => `<div style="font-size:21px; line-height:1.35; color:#cfc8b8; margin:7px 0; display:flex; gap:12px"><span style="color:${accent}">•</span><span>${t}</span></div>`).join('')}
  </div>`;

/** An arrow from (x1,y1) to (x2,y2), with its label at the middle; both ends when two-way. */
const arrow = ({ x1, y1, x2, y2, label, two = false, on = true, dy = -16 }) => {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  return `<g opacity="${on ? 1 : 0}">
    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#d8b46a" stroke-width="3" stroke-dasharray="10 9" marker-end="url(#head)" ${two ? 'marker-start="url(#tail)"' : ''}/>
    <text x="${mx}" y="${my + dy}" text-anchor="middle" font-family="Plex" font-size="21" fill="#efe6cf" paint-order="stroke" stroke="#0c111f" stroke-width="8">${[].concat(label).map((line, i) => `<tspan x="${mx}" dy="${i ? 26 : 0}">${line}</tspan>`).join('')}</text>
  </g>`;
};

const frame = (title, parts, arrows) => `
  <div style="${BG}"></div>
  <svg width="1920" height="1080" style="position:absolute; inset:0">${STARS}</svg>
  <div style="position:absolute; left:120px; top:70px; font-family:'Newsreader'; font-size:58px; letter-spacing:-0.01em">${title}</div>
  ${parts.join('')}
  <svg width="1920" height="1080" style="position:absolute; inset:0">
    <defs>
      <marker id="head" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="12" markerHeight="12" orient="auto"><path d="M1 1 L11 6 L1 11 Z" fill="#d8b46a"/></marker>
      <marker id="tail" viewBox="0 0 12 12" refX="2" refY="6" markerWidth="12" markerHeight="12" orient="auto"><path d="M11 1 L1 6 L11 11 Z" fill="#d8b46a"/></marker>
    </defs>
    ${arrows.join('')}
  </svg>`;

/** How the pieces fit: the app, the Companion on your computer, a GPU elsewhere, and where things are kept. */
function companion(step) {
  const show = (n) => step >= n;
  const parts = [
    box({ x: 120, y: 330, w: 450, h: 330, kicker: 'Koios', title: 'In your browser, or the desktop app', items: ['Find, read, annotate', 'Ask AI · Explain · Implement', 'Notebooks and projects'] }),
    box({ x: 720, y: 290, w: 470, h: 410, kicker: 'Your computer', title: 'The Companion', items: ['Your project folder, <i>~/Reader</i>', 'A Jupyter kernel and a terminal', 'Code runs here, on your machine', 'Paired once — no tokens to paste'], on: show(1) }),
    box({ x: 1420, y: 190, w: 400, h: 300, kicker: 'Elsewhere', title: 'A GPU', items: ['Colab, or your own GPU box', 'Mounts your folder live', '<i>koios run train.py</i>'], accent: '#7fb7a3', on: show(2) }),
    box({ x: 1420, y: 560, w: 400, h: 150, kicker: 'Google Drive', title: 'Your PDFs and library', on: show(3) }),
    box({ x: 1420, y: 760, w: 400, h: 150, kicker: 'Git', title: 'Notes, code, references.bib', on: show(3) }),
  ];
  const arrows = [
    arrow({ x1: 574, y1: 495, x2: 715, y2: 495, label: 'pairs once', two: true, on: show(1) }),
    arrow({ x1: 1194, y1: 400, x2: 1415, y2: 340, label: ['tunnel:', 'mount + run'], two: true, on: show(2), dy: -48 }),
    arrow({ x1: 1194, y1: 600, x2: 1415, y2: 635, label: 'mirror', on: show(3), dy: -14 }),
    arrow({ x1: 1194, y1: 660, x2: 1415, y2: 830, label: 'git sync', two: true, on: show(3), dy: -10 }),
  ];
  return frame('How it fits together', parts, arrows);
}

/** Where the Companion comes from. */
function getIt(step) {
  const show = (n) => step >= n;
  const option = (x, n, title, lines) => `
    <div style="position:absolute; left:${x}px; top:330px; width:520px; height:440px; box-sizing:border-box; border-radius:22px; background:rgba(21,28,48,0.92); border:1.5px solid #d8b46a66; padding:34px; opacity:${show(n) ? 1 : 0}; box-shadow:0 24px 60px rgba(0,0,0,0.45)">
      <div style="font-family:'Plex Mono'; font-size:18px; color:#d8b46a; letter-spacing:0.14em">${n + 1}</div>
      <div style="font-family:'Newsreader'; font-size:44px; margin:10px 0 22px">${title}</div>
      ${lines.join('')}
    </div>`;
  const p = (t) => `<div style="font-size:23px; line-height:1.45; color:#cfc8b8; margin:10px 0">${t}</div>`;
  const code = (t) => `<div style="font-family:'Plex Mono'; font-size:19px; background:#0a0e19; border:1px solid #2c3550; border-radius:10px; padding:14px 16px; color:#efe6cf; margin:14px 0">${t}</div>`;
  return `
    <div style="${BG}"></div>
    <svg width="1920" height="1080" style="position:absolute; inset:0">${STARS}</svg>
    <div style="position:absolute; left:120px; top:70px; font-family:'Newsreader'; font-size:58px">Getting the Companion</div>
    <div style="position:absolute; left:120px; top:160px; font-size:26px; color:#cfc8b8; max-width:1500px">Playground → <b style="color:#efe6cf">Connect this computer</b> offers three ways in. Each one ends with the same small program running on your machine.</div>
    ${option(120, 0, 'The Koios app', [p('<b style="color:#efe6cf">Download for Mac, Windows or Linux.</b>'), p('It carries the Companion inside, starts it whenever the app opens, and pairs without a code.')])}
    ${option(700, 1, 'One command', [p('Already live in a terminal?'), code('curl -LsSf koios.dev/companion.sh | sh'), p('Then type the code it shows into the page, and Connect.')])}
    ${option(1280, 2, 'VS Code', [p('The Koios extension shows your projects and the papers they cite, beside your code.'), p('Same folder, same Python as the site.')])}`;
}

export const DIAGRAMS = {
  companion: [0, 1, 2, 3].map((step, i) => ({ html: companion(step), at: [0, 3.2, 8.5, 14.5][i] })),
  'get-companion': [0, 1, 2].map((step, i) => ({ html: getIt(step), at: [0, 4.5, 10][i] })),
};
