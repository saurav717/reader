#!/usr/bin/env node
// Draw with OpenAI's image models from a terminal: `npm run draw -- "a prompt"`.
//
// Studies for the Koios drawing, mostly: `npm run draw -- --koios` renders the
// preset prompts below, one PNG each, into docs/koios/studies. Any other text
// is a prompt of its own.
//
// The key comes from OPENAI_API_KEY. In a cloud session with a network secret
// for api.openai.com the variable can be absent: the session's proxy attaches
// the key itself, so the request is sent without one. curl does the HTTP,
// since it honours HTTPS_PROXY and the proxy's CA bundle where Node's own
// fetch does not.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KOIOS = [
  ['axis', 'Minimal single-line ink drawing in the manner of a red-figure Greek vase: the Titan Koios standing, tall and calm, one arm raised holding a vertical pole that reaches above his head, a small four-pointed star at the top of the pole. Flat, no shading, no background, cream paper, one line weight, blank face.'],
  ['perceiver', 'Minimal continuous-line drawing of a classical Greek profile head, calm archaic expression, a single four-pointed star where the eye is, thin constellation lines fanning out from the star. Ink on cream paper, no shading, no background.'],
  ['bookmark', 'A flat vector logo: a bookmark ribbon shape with a four-pointed star cut out of it, a sparse field of faint falling stars behind, deep blue-black night sky, gold star, cream bookmark. Clean geometric, no text, no gradients.'],
  ['chart', 'A seventeenth-century celestial atlas plate in the style of Cellarius: a lone Titan figure holding the celestial pole, drawn as a constellation of connected stars over a faint engraved star chart, parchment paper, fine engraving lines, muted indigo and ochre.'],
];

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const koios = args.includes('--koios') && (args.splice(args.indexOf('--koios'), 1), true);
const out = flag('--out', koios ? 'docs/koios/studies' : 'docs/koios/drawings');
const n = Number(flag('--n', '1'));
const size = flag('--size', '1024x1024');
const model = flag('--model', 'gpt-image-1');
const quality = flag('--quality', 'medium');
const prompt = args.join(' ').trim();

if (!koios && !prompt) {
  console.error('usage: npm run draw -- "a prompt" [--n 2] [--size 1024x1024|1536x1024|1024x1536] [--quality low|medium|high] [--model gpt-image-1] [--out dir]');
  console.error('       npm run draw -- --koios          the preset Koios studies');
  process.exit(2);
}

mkdirSync(out, { recursive: true });
const jobs = koios ? KOIOS : [['drawing', prompt]];
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
let failed = false;

for (const [name, text] of jobs) {
  const body = JSON.stringify({ model, prompt: text, n, size, quality });
  const headers = ['-H', 'Content-Type: application/json'];
  if (process.env.OPENAI_API_KEY) headers.push('-H', `Authorization: Bearer ${process.env.OPENAI_API_KEY}`);
  const res = spawnSync('curl', ['-sS', '-w', '\n%{http_code}', 'https://api.openai.com/v1/images/generations', ...headers, '-d', body], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    console.error(`${name}: could not run curl: ${res.error.message}`);
    process.exit(1);
  }
  const cut = res.stdout.lastIndexOf('\n');
  const status = res.stdout.slice(cut + 1).trim();
  const text_ = res.stdout.slice(0, cut);
  if (status !== '200') {
    let why = text_.trim();
    try { why = JSON.parse(text_).error?.message ?? why; } catch {}
    if (status === '401') why = `${why}\nNo key reached OpenAI. Set OPENAI_API_KEY, or in a cloud session add a network secret for api.openai.com.`;
    if (status === '403' || status === '407' || status === '000') why = `${why || res.stderr.trim()}\nThe request did not reach api.openai.com: allow that host in the environment's network settings.`;
    console.error(`${name}: HTTP ${status}. ${why}`);
    failed = true;
    continue;
  }
  const data = JSON.parse(text_).data ?? [];
  data.forEach((image, i) => {
    const file = join(out, `${name}-${stamp}${data.length > 1 ? `-${i + 1}` : ''}.png`);
    writeFileSync(file, Buffer.from(image.b64_json, 'base64'));
    console.log(file);
  });
}
process.exit(failed ? 1 : 0);
