/**
 * Cuts the footage from record.mjs into a finished video, from an edit
 * decision list (scripts/video/ad.json by default): title cards over the
 * app's night scenes, each shot a run of clips from raw.mp4 — sped up,
 * pushed in on the part that matters — with a caption over it and a line of
 * voice-over under it.
 *
 *   node scripts/video/edit.mjs [scripts/video/ad.json]
 *
 * The voice-over is read by OpenAI's speech model once per line and kept in
 * .video/vo/, so a re-cut with the same words costs nothing; a line whose
 * words change is read again. Without the API the video comes out silent.
 */
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const EDL = JSON.parse(await readFile(process.argv[2] || path.join(ROOT, 'scripts/video/ad.json'), 'utf8'));
const RAW = path.join(ROOT, '.video/raw/raw.mp4');
const VO = path.join(ROOT, '.video/vo');
const WORK = path.join(ROOT, '.video/work', EDL.name);
const OUT = path.join(ROOT, '.video', `${EDL.name}.mp4`);
const FONTS = path.join(ROOT, '.video/fonts/node_modules');
const W = 1920;
const H = 1080;
const FPS = 30;
const SRC = { w: 3072, h: 1728 }; // record.mjs at scale 2

await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });
await mkdir(VO, { recursive: true });

const ffmpeg = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
const duration = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());

// ------------------------------------------------------------ the voice ---

async function speak(text) {
  const key = createHash('sha1').update(`${EDL.voice.name}|${EDL.voice.instructions}|${text}`).digest('hex').slice(0, 12);
  const file = path.join(VO, `${key}.wav`);
  if (existsSync(file)) return file;
  // curl rather than fetch: it goes through HTTPS_PROXY when the machine has one.
  const raw = path.join(WORK, `${key}-raw.wav`);
  const body = JSON.stringify({ model: 'gpt-4o-mini-tts', voice: EDL.voice.name, input: text, instructions: EDL.voice.instructions, response_format: 'wav' });
  const status = execFileSync('curl', [
    '-sS', '-o', raw, '-w', '%{http_code}', 'https://api.openai.com/v1/audio/speech', '-H', 'Content-Type: application/json',
    ...(process.env.OPENAI_API_KEY ? ['-H', `Authorization: Bearer ${process.env.OPENAI_API_KEY}`] : []), '-d', body,
  ]).toString();
  if (status !== '200') {
    console.log(`  (no voice for "${text}" — ${status})`);
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
@font-face { font-family: 'Plex'; src: url('file://${FONTS}/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2'); font-weight: 500; }
@font-face { font-family: 'Plex'; src: url('file://${FONTS}/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2'); font-weight: 400; }
`;
const MARK = (await readFile(path.join(ROOT, 'public/icons/koios.svg'), 'utf8')).replace(/<!--[\s\S]*?-->/g, '');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: W, height: H } });
async function render(html, file) {
  await page.setContent(`<!doctype html><html><head><style>${fontFaces}
    html, body { margin: 0; width: ${W}px; height: ${H}px; background: transparent; }
    body { font-family: 'Plex', sans-serif; -webkit-font-smoothing: antialiased; }
  </style></head><body>${html}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file, omitBackground: true });
  return file;
}

/** A caption: a navy pill at the foot of the frame, cream words, gold on the stressed ones. */
const caption = (text) =>
  render(
    `<div style="position:absolute; left:0; right:0; bottom:64px; display:flex; justify-content:center;">
      <div style="background:rgba(21,28,48,0.92); color:#f6f4ec; border:1px solid rgba(216,180,106,0.45); border-radius:22px; padding:22px 40px 24px; font-family:'Newsreader'; font-size:54px; line-height:1.15; letter-spacing:-0.01em; box-shadow:0 18px 50px rgba(10,14,25,0.35);">
        ${text.replace(/\*(.+?)\*/g, '<span style="color:#e3c27d; font-style:italic">$1</span>')}
      </div></div>`,
    path.join(WORK, `cap-${createHash('sha1').update(text).digest('hex').slice(0, 8)}.png`),
  );

/** A title card's words: big serif lines, a small line under them, the mark when asked for. */
const cardWords = (card, file) =>
  render(
    `<div style="position:absolute; inset:0; background:linear-gradient(90deg, rgba(8,10,18,0.78) 0%, rgba(8,10,18,0.35) 55%, rgba(8,10,18,0) 80%);"></div>
     <div style="position:absolute; left:150px; top:0; bottom:0; display:flex; flex-direction:column; justify-content:center; color:#f2ede1; max-width:1100px;">
      ${card.mark ? `<div style="display:flex; align-items:center; gap:26px; margin-bottom:46px;"><div style="width:96px; height:96px">${MARK.replace('<svg', '<svg width="96" height="96"')}</div><div style="font-family:'Newsreader'; font-size:76px; letter-spacing:0.01em;">Koios</div></div>` : ''}
      <div style="font-family:'Newsreader'; font-weight:400; font-size:${card.size || 96}px; line-height:1.08; letter-spacing:-0.015em;">${card.lines.map((l) => l.replace(/\*(.+?)\*/g, '<i style="color:#e3c27d">$1</i>')).join('<br>')}</div>
      ${card.sub ? `<div style="margin-top:40px; font-size:34px; color:#d8b46a; letter-spacing:0.04em;">${card.sub}</div>` : ''}
     </div>`,
    file,
  );

// ------------------------------------------------------------- shots ---

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** One clip of the footage: [from, to] at a speed, pushed from zoom z[0] to z[1] about a point (0–1 of the frame). */
function clip(c, file) {
  const speed = c.speed || 1;
  const out = (c.to - c.from) / speed;
  const n = Math.max(1, Math.round(out * FPS));
  const [z0, z1] = c.zoom || [1, 1];
  const [cx, cy] = c.at || [0.5, 0.5];
  // Eased, so a push starts and settles rather than crawling at one rate.
  const ease = `(1-cos(PI*min(on/${n},1)))/2`;
  const z = `${z0}+(${z1 - z0})*${ease}`;
  const x = `max(0,min(iw-iw/zoom,${cx}*iw-iw/zoom/2))`;
  const y = `max(0,min(ih-ih/zoom,${cy}*ih-ih/zoom/2))`;
  ffmpeg([
    '-ss', String(c.from), '-to', String(c.to), '-i', RAW,
    '-vf', `setpts=(PTS-STARTPTS)/${speed},fps=${FPS},zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${W}x${H}:fps=${FPS},format=yuv420p`,
    '-frames:v', String(n), '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', file,
  ]);
  return out;
}

/** A title card: the night scene drifting slowly, the words faded in over it. */
async function card(shot, i, length) {
  const n = Math.round(length * FPS);
  const words = await cardWords(shot.card, path.join(WORK, `card-${i}.png`));
  const file = path.join(WORK, `shot-${i}.mp4`);
  const [fx, fy] = shot.card.focus || [0.5, 0.5];
  ffmpeg([
    '-loop', '1', '-i', path.join(ROOT, 'public/loading', shot.card.scene), '-loop', '1', '-i', words,
    '-filter_complex',
    [
      // Cover the frame, then drift in by 8% across the card.
      `[0:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2}:(iw-ow)*${fx}:(ih-oh)*${fy},zoompan=z='1+0.08*on/${n}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${W}x${H}:fps=${FPS}[bg]`,
      `[1:v]format=rgba,fade=in:st=0.35:d=0.7:alpha=1[w]`,
      `[bg][w]overlay=0:0,fade=in:st=0:d=0.5,fade=out:st=${length - 0.45}:d=0.45,format=yuv420p[v]`,
    ].join(';'),
    '-map', '[v]', '-frames:v', String(n), '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', file,
  ]);
  return file;
}

async function footage(shot, i) {
  const parts = [];
  let length = 0;
  for (const [j, c] of shot.clips.entries()) {
    const file = path.join(WORK, `shot-${i}-${j}.mp4`);
    length += clip(c, file);
    parts.push(file);
  }
  const list = path.join(WORK, `shot-${i}.txt`);
  await writeFile(list, parts.map((p) => `file '${p}'`).join('\n'));
  const joined = path.join(WORK, `shot-${i}-joined.mp4`);
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
  const file = path.join(WORK, `shot-${i}.mp4`);
  if (shot.caption) {
    const words = await caption(shot.caption);
    ffmpeg([
      '-i', joined, '-loop', '1', '-i', words,
      '-filter_complex', `[1:v]format=rgba,fade=in:st=0.15:d=0.3:alpha=1[c];[0:v][c]overlay=0:0:shortest=1,format=yuv420p[v]`,
      '-map', '[v]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', file,
    ]);
  } else ffmpeg(['-i', joined, '-c', 'copy', file]);
  return { file, length: duration(file) };
}

// ------------------------------------------------------------- the cut ---

const shots = [];
let at = 0;
const voices = [];
for (const [i, shot] of EDL.shots.entries()) {
  const voice = shot.vo ? await speak(shot.vo) : null;
  const lead = shot.voAt ?? 0.25;
  let made;
  if (shot.card) {
    const said = voice ? duration(voice) : 0;
    const length = Math.max(shot.length || 0, said + lead + 0.9);
    made = { file: await card(shot, i, length), length };
  } else made = await footage(shot, i);
  if (voice) voices.push({ file: voice, at: at + lead });
  console.log(`  ${String(i + 1).padStart(2)}  ${shot.name.padEnd(9)} ${at.toFixed(1).padStart(5)}s  +${made.length.toFixed(1)}s${voice ? `  voice ${duration(voice).toFixed(1)}s` : ''}`);
  shots.push(made.file);
  at += made.length;
}
await browser.close();

const list = path.join(WORK, 'shots.txt');
await writeFile(list, shots.map((p) => `file '${p}'`).join('\n'));
const picture = path.join(WORK, 'picture.mp4');
ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', picture]);

if (voices.length) {
  const inputs = voices.flatMap((v) => ['-i', v.file]);
  const placed = voices.map((v, i) => `[${i + 1}:a]adelay=${Math.round(v.at * 1000)}|${Math.round(v.at * 1000)}[a${i}]`);
  const mix = `${voices.map((_, i) => `[a${i}]`).join('')}amix=inputs=${voices.length}:normalize=0,apad,loudnorm=I=-16:TP=-1.5:LRA=11[a]`;
  ffmpeg(['-i', picture, ...inputs, '-filter_complex', [...placed, mix].join(';'), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', OUT]);
} else ffmpeg(['-i', picture, '-c', 'copy', '-movflags', '+faststart', OUT]);
console.log(`\n${at.toFixed(1)} s → ${OUT}`);
