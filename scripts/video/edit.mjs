/**
 * Cuts recorded takes into a finished video from an edit decision list:
 *
 *   node scripts/video/edit.mjs scripts/video/explainer.json   # → .video/explainer.mp4
 *
 * The list is a run of shots. A shot is footage (clips of a take recorded
 * by take.mjs, each sped up or slowed, pushed in about a point, and held on
 * its last frame if asked), a title card over one of the night scenes in
 * public/loading/, or a diagram from diagrams.mjs revealed step by step.
 * Over a shot go a caption and a chapter label; under it, its voice-over.
 * A shot is never cut shorter than what is said over it: footage that runs
 * out is held on its last frame until the line is done.
 *
 * Here the words, the cards and the voice are prepared; render.py composes
 * the frames; ffmpeg lays the voice under them. The voice-over is OpenAI's
 * speech model, once per line, kept in .video/vo/ so a re-cut costs nothing
 * until the words change; without the API the video comes out silent.
 */
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DIAGRAMS } from './diagrams.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const EDL = JSON.parse(await readFile(process.argv[2] || path.join(ROOT, 'scripts/video/explainer.json'), 'utf8'));
const VO = path.join(ROOT, '.video/vo');
const WORK = path.join(ROOT, '.video/work', EDL.name);
const OUT = path.join(ROOT, '.video', `${EDL.name}.mp4`);
const FONTS = path.join(ROOT, '.video/fonts/node_modules');
const W = 1920;
const H = 1080;
const FPS = 30;
const GAP = EDL.voice?.gap ?? 0.45; // between lines said over one shot

await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });
await mkdir(VO, { recursive: true });

const ffmpeg = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
const duration = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());
const hash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12);
const frames = (seconds) => Math.round(seconds * FPS);

// ------------------------------------------------------------ the voice ---

function speak(text) {
  const file = path.join(VO, `${hash(`${EDL.voice.name}|${EDL.voice.instructions}|${text}`)}.wav`);
  if (existsSync(file)) return file;
  // curl rather than fetch: it goes through HTTPS_PROXY when the machine has one.
  const raw = path.join(WORK, `${path.basename(file, '.wav')}-raw.wav`);
  const body = JSON.stringify({ model: 'gpt-4o-mini-tts', voice: EDL.voice.name, input: text, instructions: EDL.voice.instructions, response_format: 'wav' });
  const status = execFileSync('curl', [
    '-sS', '-o', raw, '-w', '%{http_code}', 'https://api.openai.com/v1/audio/speech', '-H', 'Content-Type: application/json',
    ...(process.env.OPENAI_API_KEY ? ['-H', `Authorization: Bearer ${process.env.OPENAI_API_KEY}`] : []), '-d', body,
  ]).toString();
  if (status !== '200') {
    console.log(`  (no voice for "${text.slice(0, 50)}…" — ${status})`);
    return null;
  }
  // The model leaves air at both ends: the edit decides where the pauses go.
  const trim = 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse';
  ffmpeg(['-i', raw, '-af', trim, '-ar', '48000', '-ac', '2', file]);
  return file;
}

// ----------------------------------------------------- words and cards ---

const fontFaces = `
@font-face { font-family: 'Newsreader'; src: url('file://${FONTS}/@fontsource-variable/newsreader/files/newsreader-latin-opsz-normal.woff2'); font-weight: 200 800; }
@font-face { font-family: 'Newsreader'; font-style: italic; src: url('file://${FONTS}/@fontsource-variable/newsreader/files/newsreader-latin-opsz-italic.woff2'); font-weight: 200 800; }
@font-face { font-family: 'Plex'; src: url('file://${FONTS}/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2'); font-weight: 400; }
@font-face { font-family: 'Plex'; src: url('file://${FONTS}/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2'); font-weight: 500; }
@font-face { font-family: 'Plex'; src: url('file://${FONTS}/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2'); font-weight: 600; }
@font-face { font-family: 'Plex Mono'; src: url('file://${FONTS}/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2'); font-weight: 400; }
`;
export const MARK = (await readFile(path.join(ROOT, 'public/icons/koios.svg'), 'utf8')).replace(/<!--[\s\S]*?-->/g, '');
const gold = (text) => text.replace(/\*(.+?)\*/g, '<i style="color:#e3c27d">$1</i>');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: W, height: H } });
async function render(html, name, { transparent = true } = {}) {
  const file = path.join(WORK, `${name}.png`);
  await page.setContent(`<!doctype html><html><head><style>${fontFaces}
    html, body { margin: 0; width: ${W}px; height: ${H}px; background: transparent; overflow: hidden; }
    body { font-family: 'Plex', sans-serif; -webkit-font-smoothing: antialiased; color: #f2ede1; }
  </style></head><body>${html}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file, omitBackground: transparent });
  return file;
}

/** A caption: a navy pill at the foot of the frame, cream words, gold on the *stressed* ones. */
const caption = (text, name) =>
  render(
    `<div style="position:absolute; left:0; right:0; bottom:56px; display:flex; justify-content:center;">
      <div style="max-width:1500px; text-align:center; background:rgba(14,19,34,0.9); border:1px solid rgba(216,180,106,0.4); border-radius:20px; padding:18px 36px 20px; font-family:'Newsreader'; font-size:48px; line-height:1.18; letter-spacing:-0.01em; box-shadow:0 18px 50px rgba(0,0,0,0.4);">${gold(text)}</div></div>`,
    name,
  );

/** The chapter, small at the top left: a number and a name. */
const chapter = ([number, title], name) =>
  render(
    `<div style="position:absolute; left:44px; top:36px; display:flex; align-items:center; gap:14px; background:rgba(14,19,34,0.86); border:1px solid rgba(216,180,106,0.35); border-radius:999px; padding:10px 22px 10px 12px; box-shadow:0 10px 30px rgba(0,0,0,0.35);">
      <div style="width:34px; height:34px">${MARK.replace('<svg', '<svg width="34" height="34"')}</div>
      <span style="font-family:'Plex Mono'; font-size:20px; color:#d8b46a; letter-spacing:0.08em">${number}</span>
      <span style="font-size:22px; font-weight:500; letter-spacing:0.02em">${title}</span></div>`,
    name,
  );

/** A title card's words: big serif lines, a small line under them, the mark when asked for. */
const cardWords = (card, name) =>
  render(
    `<div style="position:absolute; inset:0; background:linear-gradient(90deg, rgba(6,8,15,0.82) 0%, rgba(6,8,15,0.45) 50%, rgba(6,8,15,0) 78%);"></div>
     <div style="position:absolute; left:150px; top:0; bottom:0; display:flex; flex-direction:column; justify-content:center; max-width:1150px;">
      ${card.kicker ? `<div style="font-family:'Plex Mono'; font-size:26px; color:#d8b46a; letter-spacing:0.14em; margin-bottom:34px">${card.kicker}</div>` : ''}
      ${card.mark ? `<div style="display:flex; align-items:center; gap:26px; margin-bottom:46px;"><div style="width:96px; height:96px">${MARK.replace('<svg', '<svg width="96" height="96"')}</div><div style="font-family:'Newsreader'; font-size:76px; letter-spacing:0.01em;">Koios</div></div>` : ''}
      <div style="font-family:'Newsreader'; font-weight:400; font-size:${card.size || 92}px; line-height:1.08; letter-spacing:-0.015em;">${card.lines.map(gold).join('<br>')}</div>
      ${card.sub ? `<div style="margin-top:40px; font-size:${card.subSize || 32}px; line-height:1.45; color:${card.subColor || '#cfc8b8'}; max-width:980px">${gold(card.sub)}</div>` : ''}
     </div>`,
    name,
  );

// ------------------------------------------------------------- the plan ---

const probe = (file) => {
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim().split(',').map(Number);
  return { w, h };
};

const plan = { width: W, height: H, fps: FPS, crossfade: EDL.crossfade ?? 0.4, picture: path.join(WORK, 'picture.mp4'), shots: [] };
const voices = [];
let at = 0;
for (const [i, shot] of EDL.shots.entries()) {
  const id = `${String(i + 1).padStart(2, '0')}-${shot.name}`;
  // What is said over the shot, line after line.
  const lines = (Array.isArray(shot.vo) ? shot.vo : shot.vo ? [shot.vo] : []).map((text) => ({ text, file: speak(text) }));
  const lead = shot.voAt ?? 0.5;
  let said = lead;
  for (const line of lines) {
    if (!line.file) continue;
    voices.push({ file: line.file, at: at + said });
    said += duration(line.file) + GAP;
  }
  const needed = lines.some((l) => l.file) ? said - GAP + (shot.after ?? 0.8) : 0;

  const out = { name: shot.name, overlays: [] };
  if (shot.card) {
    out.kind = 'card';
    out.background = path.join(ROOT, 'public/loading', shot.card.scene);
    out.focus = shot.card.focus;
    out.layers = [{ file: await cardWords(shot.card, `${id}-words`), at: [0.35, 0.8] }];
    out.length = frames(Math.max(shot.length || 0, needed));
  } else if (shot.diagram) {
    out.kind = 'still';
    const steps = DIAGRAMS[shot.diagram];
    out.steps = [];
    for (const [j, step] of steps.entries()) {
      out.steps.push({ file: await render(step.html, `${id}-step${j}`, { transparent: false }), at: shot.stepsAt?.[j] ?? step.at });
    }
    out.length = frames(Math.max(shot.length || 0, needed, out.steps.at(-1).at + 2.5));
  } else {
    out.kind = 'footage';
    const take = path.join(ROOT, '.video/takes', shot.take || EDL.take, 'raw.mp4');
    if (!existsSync(take)) throw new Error(`no take at ${take} — record it with take.mjs`);
    const { w, h } = probe(take);
    out.clips = shot.clips.map((c) => ({ ...c, file: path.join(ROOT, '.video/takes', c.take || shot.take || EDL.take, 'raw.mp4'), srcW: w, srcH: h, srcFps: FPS, frames: frames((c.to - c.from) / (c.speed || 1)), holdFrames: frames(c.hold || 0) }));
    const own = out.clips.reduce((sum, c) => sum + c.frames + c.holdFrames, 0);
    out.tailFrames = Math.max(0, frames(needed) - own);
    out.length = own + out.tailFrames;
    if (shot.chapter) out.overlays.push({ file: await chapter(shot.chapter, `${id}-chapter`), from: 0.2 });
  }
  if (shot.caption) out.overlays.push({ file: await caption(shot.caption, `${id}-caption`), from: shot.captionAt ?? 0.35 });
  if (shot.fadeIn === false) out.fadeIn = false;
  plan.shots.push(out);
  console.log(`  ${id.padEnd(18)} ${at.toFixed(1).padStart(6)}s  +${(out.length / FPS).toFixed(1)}s${lines.length ? `  voice ${(needed - lead).toFixed(1)}s` : ''}`);
  at += out.length / FPS;
}
await browser.close();
await writeFile(path.join(WORK, 'plan.json'), JSON.stringify(plan, null, 1));
console.log(`\n  ${at.toFixed(1)} s planned — composing the frames`);

execFileSync('python3', [path.join(ROOT, 'scripts/video/render.py'), path.join(WORK, 'plan.json')], { stdio: 'inherit' });

// ------------------------------------------------------------ the sound ---

const audio = [];
const inputs = [];
voices.forEach((v, i) => {
  inputs.push('-i', v.file);
  const ms = Math.round(v.at * 1000);
  audio.push(`[${i + 1}:a]adelay=${ms}|${ms}[v${i}]`);
});
let mixed = voices.map((_, i) => `[v${i}]`).join('');
if (EDL.music && existsSync(path.join(ROOT, EDL.music))) {
  // A music bed under the voice, quiet, ducked further while someone speaks.
  inputs.push('-stream_loop', '-1', '-i', path.join(ROOT, EDL.music));
  const m = voices.length + 1;
  audio.push(`${mixed}amix=inputs=${voices.length}:normalize=0[voice]`, `[voice]asplit=2[vo][key]`, `[${m}:a]volume=${EDL.musicVolume ?? 0.18},afade=t=in:d=2[bed]`, `[bed][key]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=400[ducked]`);
  mixed = '[vo][ducked]';
  audio.push(`${mixed}amix=inputs=2:normalize=0,apad,loudnorm=I=-16:TP=-1.5:LRA=11[a]`);
} else if (voices.length) {
  audio.push(`${mixed}amix=inputs=${voices.length}:normalize=0,apad,loudnorm=I=-16:TP=-1.5:LRA=11[a]`);
}
if (audio.length) {
  ffmpeg(['-i', plan.picture, ...inputs, '-filter_complex', audio.join(';'), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', OUT]);
} else ffmpeg(['-i', plan.picture, '-c', 'copy', '-movflags', '+faststart', OUT]);
console.log(`\n${at.toFixed(1)} s → ${OUT}`);
