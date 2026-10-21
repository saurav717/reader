/**
 * What every take shares (scripts/video/take.mjs): a browser at 1536×864
 * at twice the pixels, in the look the app ships with; the app's own faces
 * served from .video/fonts; nothing reaching the network but localhost;
 * a pointer the viewer can follow; and Chrome's screencast written to
 * frames, then to footage at a constant 30 fps.
 */
import { chromium } from 'playwright';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const ROOT = new URL('../../', import.meta.url).pathname;
export const BASE = process.env.VIDEO_BASE || 'http://localhost:8080';
export const VIEWPORT = { width: 1536, height: 864 };
export const SCALE = Number(process.env.SCALE || 2);
const FONTS = path.join(ROOT, '.video/fonts/node_modules');
const FPS = 30;

export const json = (body) => ({ status: 200, contentType: 'application/json', body: typeof body === 'string' ? body : JSON.stringify(body) });

/** The real "Attention Is All You Need", from arXiv once, then from disk. */
export async function attentionPdf() {
  const at = path.join(ROOT, '.video/attention.pdf');
  if (!existsSync(at)) {
    const response = await fetch('https://arxiv.org/pdf/1706.03762');
    if (!response.ok) throw new Error(`arXiv answered ${response.status} for the PDF`);
    await mkdir(path.dirname(at), { recursive: true });
    await writeFile(at, Buffer.from(await response.arrayBuffer()));
  }
  return readFile(at);
}

export async function openBrowser() {
  return chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
}

export async function newContext(browser) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
  // The app's faces, from the local copies, in place of Google Fonts.
  const css = [];
  const faces = [
    ['@fontsource/ibm-plex-sans', ['400.css', '500.css', '600.css'], null],
    ['@fontsource/ibm-plex-mono', ['400.css', '500.css'], null],
    ['@fontsource-variable/newsreader', ['opsz.css', 'opsz-italic.css'], ['Newsreader Variable', 'Newsreader']],
  ];
  for (const [pkg, files, rename] of faces) {
    for (const file of files) {
      const at = path.join(FONTS, pkg, file);
      if (!existsSync(at)) continue;
      let text = (await readFile(at, 'utf8')).replace(/url\(\.\/files\/([^)]+)\)/g, `url(https://fonts.gstatic.com/local/${pkg}/files/$1)`);
      if (rename) text = text.replaceAll(`'${rename[0]}'`, `'${rename[1]}'`);
      css.push(text);
    }
  }
  if (css.length) {
    await context.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: css.join('\n') }));
    await context.route('https://fonts.gstatic.com/local/**', async (route) => {
      const rest = new URL(route.request().url()).pathname.replace('/local/', '');
      route.fulfill({ status: 200, contentType: 'font/woff2', body: await readFile(path.join(FONTS, rest)) });
    });
  } else console.log('  (no local fonts in .video/fonts — the app falls back to system faces)');
  return context;
}

/** Routed last, so it is asked first: nothing leaves the machine unless a take routes it after this. */
export async function sealNetwork(context) {
  await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1|fonts\.)/, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
}

/** Past the welcome and the tour, in the look the app ships with (or THEME). */
export async function arrive(page, { theme = process.env.THEME || 'koios', settings = {}, storage = {}, path: at = '/' } = {}) {
  await page.goto(BASE + at, { waitUntil: 'networkidle' });
  await page.evaluate(
    ({ theme, settings, storage }) => {
      localStorage.setItem('reader.welcomed', 'true');
      localStorage.setItem('reader.tour', 'seen');
      const saved = JSON.parse(localStorage.getItem('reader.settings') || '{}');
      if (theme !== 'koios') Object.assign(saved, { theme, themeChosen: true });
      localStorage.setItem('reader.settings', JSON.stringify({ ...saved, ...settings }));
      for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    },
    { theme, settings, storage },
  );
  await page.reload({ waitUntil: 'networkidle' });
  const skip = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.evaluate(() => document.fonts.ready);
}

// ------------------------------------------------------------ the pointer ---

const ARROW =
  '<span class="sc-ring"></span><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M5 3l14 8.5-6.2 1.6L16 20l-2.4 1.1-3.2-6.9L5 18.5z" fill="#fff" stroke="#1a1a17" stroke-width="1.4" stroke-linejoin="round"/></svg>';

/**
 * A pointer the viewer can follow: the showcase's arrow, glided by the
 * compositor (a transform, eased), with the real mouse following it so
 * every hover and click is the app's own.
 */
export class Pointer {
  constructor(page) {
    this.page = page;
    this.x = VIEWPORT.width / 2;
    this.y = VIEWPORT.height / 2;
  }

  async show() {
    await this.page.evaluate(
      ({ arrow, x, y }) => {
        document.querySelector('.video-pointer')?.remove();
        const el = document.createElement('div');
        el.className = 'sc-cursor video-pointer';
        el.innerHTML = arrow;
        Object.assign(el.style, { left: '0px', top: '0px', transform: `translate(${x}px, ${y}px)`, willChange: 'transform' });
        document.body.append(el);
        if (!document.querySelector('.video-key')) {
          const key = document.createElement('div');
          key.className = 'sc-key video-key';
          document.body.append(key);
        }
      },
      { arrow: ARROW, x: this.x, y: this.y },
    );
  }

  /** Glide to a point, or to the middle of a locator (offset as a fraction of its box). */
  async moveTo(target, { dx = 0.5, dy = 0.5, ms } = {}) {
    let x;
    let y;
    if (typeof target === 'object' && 'x' in target) ({ x, y } = target);
    else {
      const locator = typeof target === 'string' ? this.page.locator(target).first() : target;
      await locator.scrollIntoViewIfNeeded().catch(() => undefined);
      const box = await locator.boundingBox();
      if (!box) throw new Error(`nothing to point at: ${target}`);
      x = box.x + Math.min(box.width * dx, dx === 0.5 ? 140 : box.width * dx);
      y = box.y + box.height * dy;
    }
    const distance = Math.hypot(x - this.x, y - this.y);
    const time = ms ?? Math.round(Math.min(1100, Math.max(420, distance * 0.9)));
    await this.page.evaluate(
      ({ x, y, time }) => {
        const el = document.querySelector('.video-pointer');
        if (!el) return;
        el.style.transition = `transform ${time}ms cubic-bezier(0.25, 0.7, 0.25, 1)`;
        el.style.transform = `translate(${x}px, ${y}px)`;
      },
      { x, y, time },
    );
    // The real mouse follows in steps, so hover cards and tooltips come up as they would.
    await this.page.mouse.move(x, y, { steps: Math.max(4, Math.round(time / 40)) });
    await this.page.waitForTimeout(Math.max(0, time - Math.round(time / 40) * 4) + 60);
    this.x = x;
    this.y = y;
  }

  async click(target, { pause = 500, button = 'left', ...rest } = {}) {
    if (target) await this.moveTo(target, rest);
    await this.page.evaluate(() => {
      const el = document.querySelector('.video-pointer');
      el?.classList.remove('is-down');
      void el?.offsetWidth;
      el?.classList.add('is-down');
    });
    await this.page.mouse.click(this.x, this.y, { button });
    await this.page.waitForTimeout(pause);
  }

  /** Type as a person would, a little unevenly. */
  async type(text, { delay = 55 } = {}) {
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      await this.page.waitForTimeout(delay + Math.round(Math.random() * delay * 0.6));
    }
  }

  /** Press a key and show it on screen, the way the showcase does. */
  async key(combo, label = combo, pause = 700) {
    await this.page.evaluate((label) => {
      const el = document.querySelector('.video-key');
      if (!el) return;
      el.textContent = label;
      el.classList.add('is-shown');
      clearTimeout(window.__videoKey);
      window.__videoKey = setTimeout(() => el.classList.remove('is-shown'), 1100);
    }, label);
    await this.page.keyboard.press(combo);
    await this.page.waitForTimeout(pause);
  }

  async hide() {
    await this.page.evaluate(() => document.querySelector('.video-pointer')?.remove());
  }
}

// ------------------------------------------------------------ the camera ---

/**
 * Chrome's screencast into frames; stop() writes footage at a constant 30 fps and the marks beside it.
 * No page.screenshot() while it runs: a screenshot resizes what the screencast sees, and those frames land in the take.
 */
export async function startCamera(context, page, out) {
  await rm(out, { recursive: true, force: true });
  await mkdir(path.join(out, 'frames'), { recursive: true });
  const frames = [];
  const marks = [];
  const cdp = await context.newCDPSession(page);
  const pending = [];
  let stopped = false;
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    // A frame can still arrive after the camera stops: it is not part of the take.
    if (stopped) return;
    const file = `f${String(frames.length).padStart(6, '0')}.jpg`;
    frames.push({ file, t: metadata.timestamp });
    pending.push(writeFile(path.join(out, 'frames', file), Buffer.from(data, 'base64')));
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: Number(process.env.QUALITY || 88), maxWidth: VIEWPORT.width * SCALE, maxHeight: VIEWPORT.height * SCALE, everyNthFrame: 1 });
  const started = Date.now() / 1000;
  // What the video lights up: boxes on screen, read from the page for as long as a spot lasts.
  const spots = [];
  let current = null;
  const measure = async (targets) => {
    const rects = [];
    for (const target of targets) {
      if (target && typeof target === 'object' && 'w' in target) rects.push(target);
      else {
        const locator = typeof target === 'string' ? page.locator(target).first() : target;
        const box = await locator.boundingBox().catch(() => null);
        if (box && box.width > 0 && box.height > 0) rects.push({ x: box.x, y: box.y, w: box.width, h: box.height });
      }
    }
    return rects.map((r) => ({ x: r.x / VIEWPORT.width, y: r.y / VIEWPORT.height, w: r.w / VIEWPORT.width, h: r.h / VIEWPORT.height }));
  };
  const unspot = () => {
    if (!current) return;
    clearInterval(current.timer);
    current.spot.to = Date.now() / 1000;
    current = null;
  };
  return {
    mark(name) {
      marks.push({ name, t: Date.now() / 1000 });
      console.log(`    ${(Date.now() / 1000 - started).toFixed(1).padStart(6)}s  ${name}`);
    },
    /**
     * Light up a part of the screen and dim the rest, until the next spot or unspot():
     * a locator, a selector, a box in CSS pixels { x, y, w, h }, or a list of them.
     * A box is read again every quarter second, so the light follows what moves.
     */
    async spot(target, { pad = 8 } = {}) {
      unspot();
      const targets = [].concat(target);
      const padded = async () => (await measure(targets)).map((r) => ({ x: r.x - pad / VIEWPORT.width, y: r.y - pad / VIEWPORT.height, w: r.w + (2 * pad) / VIEWPORT.width, h: r.h + (2 * pad) / VIEWPORT.height }));
      const spot = { from: Date.now() / 1000, to: null, samples: [{ t: Date.now() / 1000, rects: await padded() }] };
      spots.push(spot);
      const state = { spot, timer: setInterval(async () => {
        if (current !== state) return;
        const rects = await padded();
        if (current === state && rects.length) spot.samples.push({ t: Date.now() / 1000, rects });
      }, 250) };
      current = state;
    },
    unspot,
    async stop() {
      // A last frame of what is on screen, so the footage runs to the end of the take.
      await page.waitForTimeout(400);
      await cdp.send('Page.stopScreencast');
      stopped = true;
      await Promise.all(pending);
      if (!frames.length) throw new Error('the camera saw nothing');
      // Frames can arrive out of order under load: the time Chrome painted them is what counts.
      frames.sort((a, b) => a.t - b.t);
      const t0 = frames[0].t;
      const end = Date.now() / 1000;
      const list = frames.map((f, i) => `file 'frames/${f.file}'\nduration ${Math.max(0.001, (frames[i + 1]?.t ?? end) - f.t).toFixed(4)}`);
      list.push(`file 'frames/${frames.at(-1).file}'`);
      await writeFile(path.join(out, 'frames.txt'), list.join('\n'));
      unspot();
      await writeFile(
        path.join(out, 'spots.json'),
        JSON.stringify(
          spots.filter((s) => s.samples.some((x) => x.rects.length)).map((s) => ({ from: +(s.from - t0).toFixed(3), to: +((s.to ?? end) - t0).toFixed(3), samples: s.samples.map((x) => ({ at: +(x.t - t0).toFixed(3), rects: x.rects.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, +v.toFixed(4)]))) })) })),
          null,
          1,
        ),
      );
      await writeFile(path.join(out, 'timeline.json'), JSON.stringify(marks.map(({ name, t }) => ({ name, at: +(t - t0).toFixed(3) })), null, 2));
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'frames.txt', '-vf', `fps=${FPS},format=yuv420p`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '12', 'raw.mp4'], { cwd: out, stdio: 'inherit' });
      await rm(path.join(out, 'frames'), { recursive: true, force: true });
      console.log(`  ${frames.length} frames over ${(end - t0).toFixed(1)} s → ${path.join(out, 'raw.mp4')}`);
    },
  };
}
