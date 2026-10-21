/**
 * "Work from anywhere", drawn rather than shown: you in a browser, the code
 * on a computer of yours, the compute on a GPU somewhere else, the data in
 * Drive, each joined in turn, with work flowing along the links. A page of
 * its own, set up here and stepped on camera; each step is a mark.
 */
const STEP = 9000; // ms on camera per step

const css = `
  :root { --gold: #d8b46a; --ink: #f2ede1; --soft: #cfc8b8; --card: rgba(21, 28, 48, 0.94); --teal: #7fb7a3; }
  html, body { margin: 0; width: 1536px; height: 864px; overflow: hidden; background: radial-gradient(1100px 650px at 30% 15%, #18213a 0%, #0c111f 55%, #070a12 100%); color: var(--ink); font-family: 'IBM Plex Sans', sans-serif; -webkit-font-smoothing: antialiased; }
  .title { position: absolute; left: 64px; top: 44px; font-family: 'Newsreader', serif; font-size: 44px; letter-spacing: -0.01em; }
  .title i { color: #e3c27d; }
  .sub { position: absolute; left: 66px; top: 104px; font-size: 19px; color: var(--soft); transition: opacity 600ms ease; }
  .sub.off { opacity: 0; }
  .node { position: absolute; box-sizing: border-box; border-radius: 18px; background: var(--card); border: 1.5px solid rgba(216, 180, 106, 0.45); box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5); padding: 18px 22px; opacity: 0; transform: translateY(14px) scale(0.97); transition: opacity 700ms ease, transform 700ms cubic-bezier(.2,.7,.2,1), box-shadow 600ms ease, border-color 600ms ease; }
  .node.on { opacity: 1; transform: none; }
  .node.hot { border-color: rgba(227, 194, 125, 0.95); box-shadow: 0 0 0 4px rgba(216, 180, 106, 0.16), 0 20px 50px rgba(0, 0, 0, 0.5); }
  .kicker { font-family: 'IBM Plex Mono', monospace; font-size: 13px; letter-spacing: 0.16em; color: var(--gold); text-transform: uppercase; }
  .name { font-family: 'Newsreader', serif; font-size: 30px; margin: 4px 0 8px; display: flex; align-items: center; gap: 12px; }
  .line { font-size: 15.5px; line-height: 1.45; color: var(--soft); }
  .line b { color: var(--ink); font-weight: 500; }
  .mono { font-family: 'IBM Plex Mono', monospace; font-size: 13.5px; color: var(--ink); background: #0a0e19; border: 1px solid #2c3550; border-radius: 8px; padding: 7px 10px; margin-top: 10px; }
  svg.links { position: absolute; inset: 0; }
  .link { opacity: 0; transition: opacity 700ms ease; }
  .link.on { opacity: 1; }
  .link path.track { fill: none; stroke: rgba(216, 180, 106, 0.55); stroke-width: 2.5; stroke-dasharray: 8 8; }
  .link text { font-family: 'IBM Plex Sans'; font-size: 15px; fill: var(--ink); paint-order: stroke; stroke: #0c111f; stroke-width: 7px; }
  .dot { fill: #f1d48f; filter: drop-shadow(0 0 6px rgba(241, 212, 143, 0.9)); }
  .dot.teal { fill: #9fe0c8; filter: drop-shadow(0 0 6px rgba(159, 224, 200, 0.9)); }
  .badge { display: inline-block; font-family: 'IBM Plex Mono'; font-size: 12px; padding: 3px 8px; border-radius: 999px; background: rgba(127, 183, 163, 0.16); color: #9fe0c8; border: 1px solid rgba(127, 183, 163, 0.5); margin-left: 6px; vertical-align: 2px; }
  .tag { position: absolute; left: 66px; top: 98px; font-family: 'Newsreader', serif; font-size: 28px; opacity: 0; transition: opacity 900ms ease; }
  .tag.on { opacity: 1; }
  .tag i { color: #e3c27d; }
`;

const icon = {
  browser: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#d8b46a" stroke-width="1.6"><rect x="2.5" y="4" width="19" height="15" rx="2.5"/><path d="M2.5 8.5h19"/><circle cx="5.5" cy="6.3" r=".6" fill="#d8b46a"/><circle cx="7.6" cy="6.3" r=".6" fill="#d8b46a"/></svg>',
  laptop: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#d8b46a" stroke-width="1.6"><rect x="4" y="5" width="16" height="10.5" rx="1.5"/><path d="M2 19h20l-2-3.5H4z"/></svg>',
  chip: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#7fb7a3" stroke-width="1.6"><rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3"/></svg>',
  drive: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#d8b46a" stroke-width="1.6"><path d="M8.5 3.5h7l6 10.5-3.5 6h-12L2.5 14z"/><path d="M8.5 3.5l6 10.5M15.5 3.5L9.5 14M2.5 14h19"/></svg>',
  tablet: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#d8b46a" stroke-width="1.6"><rect x="5" y="2.5" width="14" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg>',
};

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Newsreader:ital,opsz,wght@0,6..72,300..700;1,6..72,300..500&display=swap">
<style>${css}</style></head><body>
<div class="title">Code <i>here</i>. Compute <i>there</i>. Data in Drive. You, <i>anywhere</i>.</div>
<div class="sub">Each part of the work can live on a different machine, and Koios joins them up.</div>

<svg class="links" width="1536" height="864">
  <g class="link" id="l-you-code">
    <path class="track" id="p-you-code" d="M 372 472 C 450 472, 470 330, 560 318"/>
    <text x="400" y="370">pairs once</text>
    <circle class="dot" r="5"><animateMotion dur="2.2s" repeatCount="indefinite"><mpath href="#p-you-code"/></animateMotion></circle>
  </g>
  <g class="link" id="l-code-gpu">
    <path class="track" id="p-code-gpu" d="M 922 300 L 1108 300"/>
    <path class="track" id="p-gpu-code" d="M 1108 336 L 922 336"/>
    <text x="1015" y="285" text-anchor="middle">mounts the folder, live</text>
    <circle class="dot" r="5"><animateMotion dur="1.6s" repeatCount="indefinite"><mpath href="#p-code-gpu"/></animateMotion></circle>
    <circle class="dot teal" r="5"><animateMotion dur="1.6s" begin="0.8s" repeatCount="indefinite"><mpath href="#p-gpu-code"/></animateMotion></circle>
  </g>
  <g class="link" id="l-gpu-data">
    <path class="track" id="p-gpu-data" d="M 1320 412 L 1320 560"/>
    <path class="track" id="p-data-gpu" d="M 1260 560 L 1260 412"/>
    <text x="1336" y="492">checkpoints</text>
    <text x="1244" y="492" text-anchor="end">datasets</text>
    <circle class="dot teal" r="5"><animateMotion dur="1.4s" repeatCount="indefinite"><mpath href="#p-gpu-data"/></animateMotion></circle>
    <circle class="dot" r="5"><animateMotion dur="1.4s" begin="0.7s" repeatCount="indefinite"><mpath href="#p-data-gpu"/></animateMotion></circle>
  </g>
  <g class="link" id="l-gpu-you">
    <path class="track" id="p-gpu-you" d="M 1108 392 C 900 520, 640 560, 372 540"/>
    <text x="745" y="560" text-anchor="middle">live output, wherever you are</text>
    <circle class="dot teal" r="5"><animateMotion dur="2.4s" repeatCount="indefinite"><mpath href="#p-gpu-you"/></animateMotion></circle>
    <circle class="dot teal" r="5"><animateMotion dur="2.4s" begin="1.2s" repeatCount="indefinite"><mpath href="#p-gpu-you"/></animateMotion></circle>
  </g>
  <g class="link" id="l-gpu-other">
    <path class="track" id="p-gpu-other" d="M 1108 400 C 900 640, 620 700, 372 700"/>
    <text x="700" y="690" text-anchor="middle">pick the run up from another computer</text>
    <circle class="dot teal" r="5"><animateMotion dur="2.4s" repeatCount="indefinite"><mpath href="#p-gpu-other"/></animateMotion></circle>
  </g>
</svg>

<div class="node" id="you" style="left:70px; top:380px; width:300px; height:190px">
  <div class="kicker">You · anywhere</div>
  <div class="name">${icon.browser} Koios</div>
  <div class="line">In <b>any browser</b>, or the desktop app: a café, the library, the lab.</div>
</div>
<div class="node" id="code" style="left:560px; top:196px; width:360px; height:224px">
  <div class="kicker">Code · your computer</div>
  <div class="name">${icon.laptop} Your desktop at home</div>
  <div class="line">The <b>Companion</b> keeps the project folder, its Python and a terminal.</div>
  <div class="mono">~/Reader/transformer-from-scratch</div>
</div>
<div class="node" id="gpu" style="left:1108px; top:196px; width:370px; height:216px">
  <div class="kicker" style="color:#7fb7a3">Compute · somewhere bigger</div>
  <div class="name">${icon.chip} A GPU <span class="badge">A100</span></div>
  <div class="line">Colab, or the lab's server. It <b>reads your folder live</b>; nothing is copied first.</div>
  <div class="mono">koios run python train.py</div>
</div>
<div class="node" id="data" style="left:1108px; top:560px; width:370px; height:176px">
  <div class="kicker">Data · Google Drive</div>
  <div class="name">${icon.drive} The data place</div>
  <div class="line">Datasets come in, <b>checkpoints and logs</b> go out: never back over the wire.</div>
</div>
<div class="node" id="other" style="left:70px; top:636px; width:300px; height:120px">
  <div class="kicker">You · later, elsewhere</div>
  <div class="name" style="font-size:26px">${icon.tablet} Another computer</div>
</div>
<div class="tag" id="tag">Start it here. Run it there. Keep it in Drive. <i>Watch from anywhere.</i></div>
</body></html>`;

export const pointer = false;

export async function prepare({ page }) {
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

const show = (page, on, hot = []) =>
  page.evaluate(
    ({ on, hot }) => {
      for (const id of on) document.getElementById(id)?.classList.add('on');
      document.querySelectorAll('.node').forEach((n) => n.classList.toggle('hot', hot.includes(n.id)));
    },
    { on, hot },
  );

export default async function ({ page, mark }) {
  await page.waitForTimeout(1200);
  mark('you');
  await show(page, ['you'], ['you']);
  await page.waitForTimeout(STEP);
  mark('code');
  await show(page, ['code', 'l-you-code'], ['code']);
  await page.waitForTimeout(STEP);
  mark('compute');
  await show(page, ['gpu', 'l-code-gpu'], ['gpu']);
  await page.waitForTimeout(STEP);
  mark('data');
  await show(page, ['data', 'l-gpu-data'], ['data']);
  await page.waitForTimeout(STEP);
  mark('watch');
  await show(page, ['l-gpu-you'], ['you']);
  await page.waitForTimeout(STEP);
  mark('other');
  await show(page, ['other', 'l-gpu-other'], ['other']);
  await page.waitForTimeout(STEP);
  mark('all');
  await page.evaluate(() => document.querySelector('.sub').classList.add('off'));
  await show(page, ['tag'], []);
  await page.waitForTimeout(STEP);
}
