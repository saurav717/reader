/**
 * "A paper becomes a project: code, VS Code, and agents": the Playground's
 * From a paper start on "Attention Is All You Need", kept and run on this
 * computer through a real Companion; the project as VS Code lays one out —
 * the explorer, the README with the abstract, the console, and the agent
 * that has the paper; the model-and-write start, and the Claude Code / Codex
 * / Koios AI / terminal picker; the page's own agent asked for §3.2.1's
 * scaled dot-product attention and a test: it reads the paper, writes two
 * files (+lines, Undo), runs pytest in the project's console on the
 * machine, reads what it printed and answers; then Open in VS Code, and
 * VS Code itself in the page (`code serve-web` from that computer, through
 * the Companion) with the Koios extension's side bar — the Companion's
 * projects, the paper the project cites, the Companion — and a ¶ citation
 * in the code as a link to the paper.
 *
 * Real: the Companion (companion/, from .video/jvenv) with HOME at
 * .video/whome on 127.0.0.1:47521 (its own port, so it never meets the
 * companion take's), its files, its Python and pytest, and its console;
 * VS Code's own CLI (.video/wscode/bin/code, downloaded once from
 * update.code.visualstudio.com) and its server (cached under
 * .video/whome/.vscode/cli), started by the Companion; the Koios extension,
 * built from vscode/ (scripts/build-vscode.mjs) and unpacked into
 * .video/whome/.vscode/extensions.
 * Stood in for: Claude's answers to the agent (api.anthropic.com, as the
 * SSE stream the SDK reads, in the page — scripts/implement-smoke.mjs does
 * the same), and the Companion's name and hardware, put as a Mac would say
 * them, as the companion take does.
 *
 * Needs, once:  .video/jvenv (see companion.mjs) with pytest in it;
 *   curl -sSL -o .video/wscode/cli.tgz https://update.code.visualstudio.com/latest/cli-linux-x64/stable && tar xzf .video/wscode/cli.tgz -C .video/wscode/bin
 *   node scripts/build-vscode.mjs .video/wscode  (then unzip extension/ into .video/whome/.vscode/extensions/saurav717.reader-playground-0.3.0)
 * setup() checks for these and says what is missing.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, BASE, json, attentionPdf } from '../lib.mjs';

const VENV = path.join(ROOT, '.video/jvenv');
const HOME = path.join(ROOT, '.video/whome');
const CODE_BIN = path.join(ROOT, '.video/wscode/bin');
const PORT = 47521;
const URL_BASE = `http://127.0.0.1:${PORT}/`;
const NAME = 'Saurav’s MacBook Pro';
const HARDWARE = 'Apple M3 Pro · 12 cores · 36 GB';
// Kernels talk over Unix sockets, whose paths must stay under 107 characters: not under HOME here.
const RUNTIME = path.join(os.tmpdir(), 'koios-workspace-rt');
const SHOTS = path.join(ROOT, '.video/work/workspace');

// ------------------------------------------------------------- the paper ---

const TITLE = 'Attention Is All You Need';
const PAPER_ID = 'arxiv:1706.03762';
const ago = (hours) => new Date(Date.now() - hours * 3600 * 1000).toISOString();
const PAPER = {
  id: PAPER_ID,
  source: 'arxiv',
  arxivId: '1706.03762',
  title: TITLE,
  authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar', 'Jakob Uszkoreit', 'Llion Jones', 'Aidan N. Gomez', 'Lukasz Kaiser', 'Illia Polosukhin'],
  abstract:
    'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. The best performing models also connect the encoder and decoder through an attention mechanism. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely. Experiments on two machine translation tasks show these models to be superior in quality while being more parallelizable and requiring significantly less time to train.',
  published: '2017-06-12',
  categories: ['cs.CL', 'cs.LG'],
  pdfUrl: 'https://arxiv.org/pdf/1706.03762',
  landingUrl: 'https://arxiv.org/abs/1706.03762',
  addedAt: ago(240),
  collectionIds: ['c-reading'],
  tags: [],
  progress: 0.4,
  lastOpenedAt: ago(2),
};

// -------------------------------------------------------- the model's side ---

const ATTENTION_PY = `"""Scaled dot-product attention, as the Transformer defines it."""

import numpy as np


def softmax(x, axis=-1):
    x = x - x.max(axis=axis, keepdims=True)  # subtract the row's max: stable
    e = np.exp(x)
    return e / e.sum(axis=axis, keepdims=True)


# Attention(Q, K, V) = softmax(Q Kᵀ / √d_k) V, Eq. (1) — ¶ Attention Is All You Need §3.2.1
def scaled_dot_product_attention(q, k, v, mask=None):
    """q: (..., n_q, d_k), k: (..., n_k, d_k), v: (..., n_k, d_v).

    mask: (..., n_q, n_k), True where a query may attend (the decoder's, §3.2.3).
    Returns the output (..., n_q, d_v) and the weights (..., n_q, n_k).
    """
    d_k = q.shape[-1]
    # Scaled by 1/√d_k so large d_k doesn't push softmax into tiny gradients
    scores = q @ np.swapaxes(k, -1, -2) / np.sqrt(d_k)
    if mask is not None:
        scores = np.where(mask, scores, -1e9)  # illegal connections → −∞
    weights = softmax(scores, axis=-1)
    return weights @ v, weights


# The decoder's mask: position i sees positions ≤ i — ¶ Attention Is All You Need §3.2.3
def causal_mask(n):
    return np.tril(np.ones((n, n), dtype=bool))
`;

const TEST_PY = `import numpy as np

from attention import causal_mask, scaled_dot_product_attention

rng = np.random.default_rng(0)


def qkv(n=5, d_k=8, d_v=4, batch=2):
    return rng.normal(size=(batch, n, d_k)), rng.normal(size=(batch, n, d_k)), rng.normal(size=(batch, n, d_v))


def test_shapes():
    q, k, v = qkv()
    out, w = scaled_dot_product_attention(q, k, v)
    assert out.shape == (2, 5, 4) and w.shape == (2, 5, 5)


def test_weights_are_a_distribution():
    out, w = scaled_dot_product_attention(*qkv())
    assert np.allclose(w.sum(-1), 1.0) and (w >= 0).all()


def test_causal_mask_hides_the_future():
    q, k, v = qkv()
    _, w = scaled_dot_product_attention(q, k, v, mask=causal_mask(5))
    assert np.allclose(np.triu(w[0], 1), 0.0)


def test_scaled_by_root_dk():
    q, k, v = qkv(d_k=64)
    _, w = scaled_dot_product_attention(q, k, v)
    scores = q @ k.transpose(0, 2, 1) / 8.0
    e = np.exp(scores - scores.max(-1, keepdims=True))
    assert np.allclose(w, e / e.sum(-1, keepdims=True))
`;

const TASK = 'Implement scaled dot-product attention from §3.2.1 (Eq. 1, with the decoder’s mask) and a test';

const THINK_1 =
  'They want Eq. 1 from §3.2.1: softmax(QKᵀ/√d_k)V, and the mask from §3.2.3. Before writing it, read the paper’s own text in paper/paper.md for the exact definition and why it is scaled, then put it in a module of its own beside main.py, with a pytest file that checks the shapes, that each row of weights sums to one, that the mask hides the future, and the 1/√d_k.';
const REPLY_1 = 'Reading §3.2 first.\n\n```read\npaper/paper.md\n```\n';
const THINK_2 =
  'Section 3.2.1: “We compute the dot products of the query with all keys, divide each by √d_k, and apply a softmax function to obtain the weights on the values.” Masking in §3.2.3 sets illegal connections to −∞ before the softmax. NumPy is enough for this and runs anywhere; then run the tests in the console.';
const REPLY_2 = `Eq. (1) of §3.2.1 as its own module, with the decoder’s mask from §3.2.3, and four tests: the shapes, the weights as a distribution, the mask hiding later positions, and the 1/√d_k scaling. Running them now.

\`\`\`python file=attention.py
${ATTENTION_PY}\`\`\`

\`\`\`python file=test_attention.py
${TEST_PY}\`\`\`

\`\`\`sh run
python -m pytest -q test_attention.py
\`\`\`
`;
const REPLY_3 =
  'All four tests pass on Saurav’s MacBook Pro. `attention.py` is Eq. (1) — `softmax(QKᵀ/√d_k)V` — with the scores masked to −∞ where the decoder may not look (§3.2.3), and the citations in the comments link back to the paper. Next, multi-head attention (§3.2.2) can be built on `scaled_dot_product_attention`.';

/** Claude's stream, event by event, with its thinking first: the shape the SDK reads. */
function sse(thinking, text) {
  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const out = [event('message_start', { type: 'message_start', message: { id: 'msg_video', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 21000, output_tokens: 1 } } })];
  let index = 0;
  if (thinking) {
    out.push(event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }));
    for (let i = 0; i < thinking.length; i += 6) out.push(event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: thinking.slice(i, i + 6) } }));
    out.push(event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig' } }));
    out.push(event('content_block_stop', { type: 'content_block_stop', index }));
    index++;
  }
  out.push(event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }));
  for (let i = 0; i < text.length; i += 24) out.push(event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: text.slice(i, i + 24) } }));
  out.push(event('content_block_stop', { type: 'content_block_stop', index }));
  out.push(event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: Math.ceil((thinking.length + text.length) / 4) } }));
  out.push(event('message_stop', { type: 'message_stop' }));
  return out;
}

// --------------------------------------------------------- the Companion ---

let child = null;
let config = null;

function startCompanion() {
  for (const [what, at] of [
    ['the Companion’s venv (see companion.mjs)', path.join(VENV, 'bin/reader-companion')],
    ['pytest in that venv (.video/jvenv/bin/pip install pytest)', path.join(VENV, 'bin/pytest')],
    ['VS Code’s CLI in .video/wscode/bin', path.join(CODE_BIN, 'code')],
    ['the Koios extension in .video/whome/.vscode/extensions', path.join(HOME, '.vscode/extensions/saurav717.reader-playground-0.3.0/package.json')],
  ]) {
    if (!existsSync(at)) throw new Error(`workspace needs ${what}: ${at} is missing`);
  }
  // A fresh folder each take: the project is made on camera.
  rmSync(path.join(HOME, 'Reader/playgrounds'), { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
  rmSync(path.join(SHOTS, 'companion.log'), { force: true });
  mkdirSync(path.join(HOME, 'Reader'), { recursive: true });
  mkdirSync(RUNTIME, { recursive: true });
  // VS Code in the page: no welcome, no trust prompt, no chat; the site's look, from the Koios extension.
  const user = path.join(HOME, '.reader-companion/vscode/data/User');
  mkdirSync(user, { recursive: true });
  writeFileSync(
    path.join(user, 'settings.json'),
    JSON.stringify(
      {
        'workbench.colorTheme': 'Koios Dark',
        'workbench.startupEditor': 'none',
        'security.workspace.trust.enabled': false,
        'chat.disableAIFeatures': true,
        'workbench.secondarySideBar.defaultVisibility': 'hidden',
        'workbench.tips.enabled': false,
        'editor.minimap.enabled': false,
        'window.commandCenter': false,
        'workbench.layoutControl.enabled': false,
        'update.mode': 'none',
        'extensions.ignoreRecommendations': true,
        'telemetry.telemetryLevel': 'off',
        'editor.fontSize': 14,
      },
      null,
      2,
    ),
  );
  child = spawn(path.join(VENV, 'bin/reader-companion'), ['--site', BASE, '--name', NAME, '--port', String(PORT), '--root', path.join(HOME, 'Reader'), '--python', path.join(VENV, 'bin/python'), '--no-browser', '--no-tunnel'], {
    env: { ...process.env, HOME, JUPYTER_RUNTIME_DIR: RUNTIME, SHELL: '/bin/bash', VIRTUAL_ENV_DISABLE_PROMPT: '1', PATH: `${CODE_BIN}:${path.join(VENV, 'bin')}:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const kill = () => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // gone already
    }
  };
  process.on('exit', kill);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the Companion did not start in 60 s')), 60_000);
    let said = '';
    const read = (chunk) => {
      said += String(chunk);
      try {
        writeFileSync(path.join(SHOTS, 'companion.log'), String(chunk), { flag: 'a' });
      } catch {
        // no log
      }
      if (/code (?:\u001b\[[0-9;]*m)*[A-Z0-9]{3}-[A-Z0-9]{3}/.test(said)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('exit', (status) => reject(new Error(`the Companion exited (${status}): ${said.slice(-400)}`)));
  });
}

export async function setup(context) {
  await startCompanion();
  config = JSON.parse(readFileSync(path.join(HOME, '.reader-companion/config.json'), 'utf8'));
  // VS Code's server, started now off camera, as it would be from an earlier day: the first start downloads it.
  await fetch(`${URL_BASE}companion/vscode-web`, { method: 'POST', headers: { Authorization: `token ${config.token}`, 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ folder: '' }) }).catch(() => undefined);

  const cors = { 'Access-Control-Allow-Origin': BASE, 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  // Any other Companion on the usual ports (the companion take's) is not this one: unseen.
  await context.route(/^https?:\/\/127\.0\.0\.1:473[23]1\//, (route) => route.abort());
  await context.route(new RegExp(`^http://127\\.0\\.0\\.1:${PORT}/companion/(info|vscode)(\\?|$)`), async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/companion/vscode' && route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ editors: [{ name: 'Visual Studio Code', installed: true }] }) });
    if (url.pathname === '/companion/info') {
      const response = await route.fetch();
      const body = await response.json().catch(() => null);
      if (body && typeof body === 'object' && 'name' in body) Object.assign(body, { hardware: HARDWARE });
      return route.fulfill({ response, body: JSON.stringify(body) });
    }
    return route.fallback();
  });

  // VS Code's page itself, through the Companion. Its proxy (extension.VsCodeProxy) hands VS Code's own
  // Content-Security-Policy on as it came, and VS Code 1.143 writes that header over several lines, which
  // Tornado 6.6 refuses to send (a 500, "Invalid header value"). Only that one page is fetched here instead,
  // from the same `code serve-web` the Companion started, and given the headers the Companion means to give
  // it (the policy on one line, framed only by the site); everything after it goes through the Companion.
  await context.route(new RegExp(`^http://127\\.0\\.0\\.1:${PORT}/companion/vscode/[^/]+/(\\?.*)?$`), async (route) => {
    const args = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).split('\n').find((line) => line.includes(' serve-web ') && line.includes(HOME));
    const port = /--port (\d+)/.exec(args || '')?.[1];
    const token = /--connection-token (\S+)/.exec(args || '')?.[1];
    if (!port || !token) return route.fallback();
    const asked = new URL(route.request().url());
    const response = await fetch(`http://127.0.0.1:${port}${asked.pathname}${asked.search}`, { headers: { Cookie: `vscode-tkn=${token}` } });
    const headers = {};
    response.headers.forEach((value, name) => {
      if (['set-cookie', 'x-frame-options', 'content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name)) return;
      headers[name] = name === 'content-security-policy' ? value.replace(/\s+/g, ' ').split(';').filter((part) => !/^\s*frame-ancestors/i.test(part)).join(';') + `; frame-ancestors 'self' ${BASE}` : value;
    });
    return route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
  });

  // The paper, for the folder's paper/ files.
  const PDF = await attentionPdf();
  const pdf = (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF });
  await context.route('**/pdf?*', pdf);
  await context.route('**/arxiv/pdf*', pdf);
  await context.route('**/api/arxiv/html*', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"none"}' }));
  for (const host of ['api.crossref.org', 'api.semanticscholar.org', 'api.openalex.org', 'dblp.org', 'api.unpaywall.org']) {
    await context.route(`**/${host}/**`, (route) => route.fulfill(json('{"results":[],"data":[],"message":{"items":[]}}')));
  }

  // Claude, answering the page's agent: a stream per round, told apart by what the round hands back.
  await context.addInitScript(
    ({ replies }) => {
      const real = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (!url.startsWith('https://api.anthropic.com')) return real(input, init);
        const body = JSON.parse(init?.body ?? '{}');
        const system = JSON.stringify(body.system ?? '');
        if (!/coding agent inside the Playground/.test(system)) {
          return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'not in this take' } }), { status: 400, headers: { 'content-type': 'application/json' } });
        }
        const last = JSON.stringify(body.messages?.at(-1)?.content ?? '');
        const round = /Go on: fix what failed/.test(last) ? 2 : /Now answer the request/.test(last) ? 1 : 0;
        const events = replies[round];
        // How long each round takes on screen, as a person would see it think and write.
        const pace = [3200, 9000, 4200][round] / events.length;
        (window.__wsLog ??= []).push(`round ${round} asked at ${Math.round(performance.now())}`);
        const stream = new ReadableStream({
          async start(controller) {
            await new Promise((resolve) => setTimeout(resolve, 800));
            for (const event of events) {
              controller.enqueue(new TextEncoder().encode(event));
              await new Promise((resolve) => setTimeout(resolve, pace));
            }
            window.__wsLog.push(`round ${round} done at ${Math.round(performance.now())}`);
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_video' } });
      };
    },
    { replies: [sse(THINK_1, REPLY_1), sse(THINK_2, REPLY_2), sse('', REPLY_3)] },
  );
}

export async function prepare({ page, arrive }) {
  mkdirSync(SHOTS, { recursive: true });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(async ({ paper }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('reader', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = (store, fn) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, 'readwrite');
        fn(t.objectStore(store));
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      });
    for (const store of ['papers', 'collections']) await tx(store, (s) => s.clear());
    await tx('collections', (s) => s.put({ id: 'c-reading', name: 'Reading list', color: '#2f7d6d', createdAt: new Date().toISOString() }));
    await tx('papers', (s) => s.put(paper));
    db.close();
  }, { paper: PAPER });
  const server = { id: 's-mac', name: NAME, url: URL_BASE, token: config.token, where: 'pc', companionId: config.id, root: config.root };
  await arrive({
    path: '/playground',
    storage: { 'reader.playground.servers': [server], 'reader.anthropic-key': 'sk-ant-video', 'reader.pgAgentMode': '"reader"' },
  });
  await page.waitForSelector('.pg-hero', { timeout: 20_000 });
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
}

const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => undefined);

export default async function ({ page, pointer, mark, spot, unspot }) {
  const hold = (ms) => page.waitForTimeout(ms);
  await hold(1200);

  // 1. Project mode: a paper from the library, as a project on this computer.
  mark('from-a-paper');
  const start = page.locator('.pg-start', { hasText: 'From a paper' });
  await spot(start);
  await pointer.moveTo(start);
  await hold(2200);
  await pointer.click(start, { pause: 400 });
  await pointer.type('attention', { delay: 70 });
  const pick = page.locator('.pg-papers li button').first();
  await pick.waitFor();
  await spot(page.locator('.pg-ask'));
  await hold(1200);
  await pointer.click(pick, { pause: 600 });
  await page.locator('.pg-sheet').waitFor();
  await shot(page, '1-sheet');

  mark('where');
  const pc = page.locator('.pg-mode-top', { has: page.locator('b', { hasText: /^This PC$/ }) });
  await pointer.click(pc, { pause: 400 });
  await spot(page.locator('.pg-sheet'));
  await hold(2200);
  await shot(page, '2-sheet-pc');
  await pointer.click(page.locator('.pg-sheet-foot .btn.primary'));

  mark('project');
  await page.locator('.vs-activity').waitFor({ timeout: 20_000 });
  unspot();
  const write = page.locator('section.pg-write');
  await write.waitFor({ timeout: 15_000 });
  await hold(1200);
  await spot(write.locator('.nb-start-head'));
  await pointer.moveTo(write.locator('h2'));
  await hold(2600);
  await spot([write.locator('.model-pick'), write.locator('.btn.primary.cta')]);
  await pointer.moveTo(write.locator('.btn.primary.cta'));
  await hold(2600);
  const cli = write.locator('.pg-write-cli');
  if (await cli.count()) {
    await cli.scrollIntoViewIfNeeded();
    await spot(cli);
    await pointer.moveTo(cli.locator('.btn').first());
    await hold(2600);
  }
  await shot(page, '4-start');

  mark('files');
  await pointer.click(write.getByRole('button', { name: 'write the files yourself' }), { pause: 900 });
  await spot('.vs-groups');
  await pointer.moveTo({ x: 760, y: 330 });
  await hold(2600);
  await shot(page, '5-readme');
  const paperDir = page.locator('.vs-explorer .pg-entry').filter({ hasText: /paper\s*$/ }).first();
  await spot('.vs-sidebar');
  await pointer.click(paperDir, { pause: 600 });
  await hold(2400);
  await spot('.vs-agent');
  await pointer.moveTo('.vs-agent-hello');
  await hold(2800);
  await spot('.pg-console');
  await pointer.moveTo('.pg-console .xterm');
  await hold(2400);
  await shot(page, '6-agent');

  // 2. The agents: which, then the page's own one, asked for §3.2.1.
  mark('agents');
  await spot('.vs-agent-pick');
  await pointer.moveTo(page.locator('.vs-agent-pick [role=radio]').first());
  await hold(1400);
  await pointer.moveTo(page.locator('.vs-agent-pick [role=radio]').nth(1));
  await hold(1200);
  await pointer.moveTo(page.locator('.vs-agent-pick [role=radio]', { hasText: 'Koios AI' }));
  await hold(1000);

  mark('ask');
  const box = page.getByLabel('Ask the agent');
  await spot('.vs-agent-box');
  await pointer.click(box, { pause: 300 });
  await pointer.type(TASK, { delay: 32 });
  await hold(600);
  await pointer.key('Enter', '⏎', 300);

  mark('thinking');
  await spot('.vs-agent-log');
  await page.locator('.vs-turn.is-live').waitFor();
  await hold(2400);
  await shot(page, '7-thinking');
  // The paper read, then its second thought, then the files as they stream.
  await page.locator('.vs-turn-stream', { hasText: 'file=attention.py' }).waitFor({ timeout: 60_000 });

  mark('writing');
  await hold(2600);
  await shot(page, '9-writing');

  mark('test-run');
  await page.locator('.vs-turn-step', { hasText: /Running/ }).waitFor({ timeout: 60_000 });
  await spot(['.pg-console', '.vs-turn.is-live']);
  await page.locator('.pg-console', { hasText: /passed/ }).waitFor({ timeout: 60_000 });
  await hold(2600);
  await shot(page, '10-ran');
  console.log('    ', await page.evaluate(() => (window.__wsLog || []).join(' · ')));

  mark('answer');
  await page.locator('.vs-turn.is-live').waitFor({ state: 'detached', timeout: 60_000 });
  const turn = page.locator('.vs-turn.is-agent').last();
  await spot(turn);
  await hold(2800);
  await spot(turn.locator('.vs-changes'));
  await pointer.moveTo(turn.locator('.vs-change').first());
  await hold(2200);
  await shot(page, '11-answer');

  mark('code');
  await pointer.click(turn.locator('.vs-change').first(), { pause: 800 });
  await spot('.vs-groups');
  await hold(2800);
  await shot(page, '12-code');
  unspot();

  // 3. VS Code: a link to open it, or VS Code itself in the page, with the Koios extension.
  mark('vscode-open');
  const openIn = page.getByRole('link', { name: /Open in VS Code/ });
  await spot(openIn);
  await pointer.moveTo(openIn);
  await hold(2600);

  mark('vscode-page');
  const sw = page.locator('.pg-editor-switch').first();
  await spot(sw);
  await pointer.click(sw.getByRole('radio', { name: 'VS Code' }), { pause: 600 });
  const frame = page.frameLocator('iframe.pg-vscode-frame');
  await frame.locator('.monaco-workbench').waitFor({ timeout: 60_000 });
  await hold(4000);
  unspot();
  await shot(page, '13-vscode');
  const koios = frame.locator('.activitybar [aria-label^="Koios"]').first();
  await pointer.click(koios, { pause: 1500 });
  await spot(frame.locator('.sidebar'));
  await hold(3000);
  await shot(page, '14-koios');
}
