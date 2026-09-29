// Run in Colab, without a browser, a Google account or a runtime: how the
// page reads what a kernel sends back and compares it with what Claude
// expected; how the proxy's half (server/colab.js) talks to Colab's session
// backend and to a runtime's Jupyter server, on the person's own token and
// only to Colab's hosts; and the Node proxy's /colab routes.
//
//   node --test scripts/colab.test.mjs

import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanup, load } from './bundle.mjs';

process.env.READER_SCHOLAR_PROFILE_DIR = join(tmpdir(), `reader-no-scholar-profile-${process.pid}`);
process.env.READER_PROFILE_DIR = join(tmpdir(), `reader-no-profile-${process.pid}`);
delete process.env.READER_TOKEN;

const lib = await load('src/lib/colab.ts');
const telemetry = await load('src/lib/telemetry.ts');
const relay = await import('../server/colab.js');
const { default: apiRouter } = await import('../server/api.js');

after(cleanup);

const msg = (type, content, parent = 'req-1') => ({ header: { msg_id: `m-${Math.random()}`, msg_type: type, session: 's', username: 'k', version: '5.3', date: '' }, parent_header: { msg_id: parent }, metadata: {}, content, channel: 'iopub' });

describe('the Jupyter messages', () => {
  it('writes an execute_request with the code as given and no stdin', () => {
    const request = lib.executeRequest('print(1)\n', 'session-1');
    assert.equal(request.header.msg_type, 'execute_request');
    assert.equal(request.header.session, 'session-1');
    assert.equal(request.channel, 'shell');
    assert.equal(request.content.code, 'print(1)\n');
    assert.equal(request.content.allow_stdin, false);
    assert.equal(request.content.stop_on_error, true);
  });
  it('reads what the socket carries, and shrugs at anything else', () => {
    const text = JSON.stringify(msg('stream', { name: 'stdout', text: 'hi' }));
    assert.equal(lib.parseMessage(text).header.msg_type, 'stream');
    assert.equal(lib.parseMessage('not json'), null);
    assert.equal(lib.parseMessage('{"header":{}}'), null);
  });
});

describe('what a cell shows', () => {
  it('joins the kernel’s stdout as it streams, and keeps stderr apart', () => {
    let outputs = [];
    outputs = lib.reduceOutputs(outputs, msg('stream', { name: 'stdout', text: 'attention weights\n' }));
    outputs = lib.reduceOutputs(outputs, msg('stream', { name: 'stdout', text: ['  the ', '[0.4 0.2]\n'] }));
    outputs = lib.reduceOutputs(outputs, msg('stream', { name: 'stderr', text: 'warning\n' }));
    assert.deepEqual(outputs, [
      { type: 'stream', name: 'stdout', text: 'attention weights\n  the [0.4 0.2]\n' },
      { type: 'stream', name: 'stderr', text: 'warning\n' },
    ]);
  });
  it('shows a display by its text or its picture, never its HTML', () => {
    const html = lib.reduceOutputs([], msg('display_data', { data: { 'text/html': '<script>alert(1)</script>', 'text/plain': '<Figure>' } }));
    assert.deepEqual(html, [{ type: 'text', text: '<Figure>' }]);
    const png = lib.reduceOutputs([], msg('display_data', { data: { 'image/png': 'iVBOR\nw0KGgo=', 'text/plain': '<Figure>' } }));
    assert.deepEqual(png, [{ type: 'image', mime: 'image/png', data: 'iVBORw0KGgo=' }]);
    const js = lib.reduceOutputs([], msg('display_data', { data: { 'application/javascript': 'alert(1)' } }));
    assert.deepEqual(js, []);
    const result = lib.reduceOutputs([], msg('execute_result', { data: { 'text/plain': '42' }, execution_count: 3 }));
    assert.deepEqual(result, [{ type: 'text', text: '42' }]);
  });
  it('keeps a traceback with its colours taken off, and clears on clear_output', () => {
    const outputs = lib.reduceOutputs([], msg('error', { ename: 'ValueError', evalue: 'bad', traceback: ['\u001b[0;31mValueError\u001b[0m', 'Traceback'] }));
    assert.deepEqual(outputs, [{ type: 'error', ename: 'ValueError', evalue: 'bad', traceback: 'ValueError\nTraceback' }]);
    assert.deepEqual(lib.reduceOutputs(outputs, msg('clear_output', {})), []);
  });
  it('compares with what Claude expected, forgiving spacing and nothing else', () => {
    const printed = [{ type: 'stream', name: 'stdout', text: 'weights:\n  the [0.6 0.1]\noutput shape: (4, 8)\n' }];
    assert.equal(lib.compareOutput('weights:\n the  [0.6 0.1]\n\noutput shape: (4, 8)', printed), 'match');
    assert.equal(lib.compareOutput('weights:\n  the [0.4 0.2]\noutput shape: (4, 8)', printed), 'differs');
    assert.equal(lib.compareOutput(undefined, printed), 'none');
    assert.equal(lib.compareOutput('anything', [{ type: 'error', ename: 'E', evalue: '', traceback: '' }]), 'differs');
    assert.deepEqual([...lib.differingLines('weights:\n  the [0.4 0.2]\noutput shape: (4, 8)', lib.outputText(printed))], [1]);
  });
  it('keys a run by the cell’s code, so a rewritten cell is a cell not yet run', () => {
    assert.equal(lib.cellKey('print(1)'), lib.cellKey('print(1)'));
    assert.notEqual(lib.cellKey('print(1)'), lib.cellKey('print(2)'));
    assert.match(lib.cellKey('x'), /^c[0-9a-z]+$/);
  });
  it('offers the machines the pages write for, the CPU first and free', () => {
    assert.deepEqual(
      lib.MACHINES.map((m) => m.accelerator),
      ['NONE', 'T4', 'L4', 'A100'],
    );
    assert.equal(lib.machineLabel({ accelerator: null }), 'CPU');
    assert.equal(lib.machineLabel({ accelerator: 'T4', highMem: true }), 'T4 · high RAM');
  });
});

describe('the proxy’s half', () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  const answers = [];
  const XSSI = ")]}'\n";
  const proxyInfo = { url: 'https://abc-colab.googleusercontent.com/tun/m/xyz/', token: 'ptok', tokenExpiresInSeconds: 3600 };
  afterEach(() => {
    globalThis.fetch = realFetch;
    calls.length = 0;
    answers.length = 0;
  });
  const fake = () => {
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
      const next = answers.shift() || { status: 200, body: '' };
      return new Response(next.body, { status: next.status });
    };
  };

  it('writes the notebook id the way Colab’s page does', () => {
    assert.equal(relay.notebookHash('0f6b2a1c-3d4e-4f5a-8b9c-0d1e2f3a4b5c'), '0f6b2a1c_3d4e_4f5a_8b9c_0d1e2f3a4b5c........');
    assert.throws(() => relay.notebookHash('not-a-uuid'), /UUID/);
  });
  it('checks the machine asked for', () => {
    assert.deepEqual(relay.checkMachine({ accelerator: 't4', highMem: 1, notebook: '0f6b2a1c-3d4e-4f5a-8b9c-0d1e2f3a4b5c' }), { accelerator: 'T4', highMem: true, notebook: '0f6b2a1c-3d4e-4f5a-8b9c-0d1e2f3a4b5c' });
    assert.throws(() => relay.checkMachine({ accelerator: 'H100', notebook: '0f6b2a1c-3d4e-4f5a-8b9c-0d1e2f3a4b5c' }), /no such machine/);
    assert.throws(() => relay.checkMachine({ accelerator: 'T4' }), /notebook id/);
  });
  it('fetches a runtime’s Jupyter server only where Colab puts one', () => {
    assert.equal(relay.checkRuntimeUrl('https://abc-colab.googleusercontent.com/tun/m/xyz'), 'https://abc-colab.googleusercontent.com/tun/m/xyz/');
    for (const bad of ['http://abc-colab.googleusercontent.com/', 'https://evil.example.com/googleusercontent.com/', 'https://user:pw@abc.googleusercontent.com/', 'https://169.254.169.254/', 'https://googleusercontent.com.evil.net/', 'nope']) {
      assert.throws(() => relay.checkRuntimeUrl(bad), /not a Colab runtime|not a URL/, bad);
    }
  });
  it('assigns a runtime: the GET for the token, the POST with it, on the person’s own Google token', async () => {
    fake();
    answers.push({ status: 200, body: `${XSSI}${JSON.stringify({ token: 'xsrf-1', acc: 'T4', nbh: 'x', variant: 'GPU' })}` });
    answers.push({ status: 200, body: `${XSSI}${JSON.stringify({ endpoint: 'm-abc', accelerator: 'T4', variant: 1, runtimeProxyInfo: proxyInfo })}` });
    const runtime = await relay.assignRuntime('google-token', { accelerator: 'T4', notebook: '0f6b2a1c-3d4e-4f5a-8b9c-0d1e2f3a4b5c' });
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /^https:\/\/colab\.research\.google\.com\/tun\/m\/assign\?/);
    assert.match(calls[0].url, /nbh=0f6b2a1c_3d4e_4f5a_8b9c_0d1e2f3a4b5c\.{8}/);
    assert.match(calls[0].url, /variant=GPU/);
    assert.match(calls[0].url, /accelerator=T4/);
    assert.match(calls[0].url, /authuser=0/);
    assert.equal(calls[0].headers.Authorization, 'Bearer google-token');
    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].headers['X-Goog-Colab-Token'], 'xsrf-1');
    assert.equal(runtime.endpoint, 'm-abc');
    assert.equal(runtime.accelerator, 'T4');
    assert.equal(runtime.proxy.url, proxyInfo.url);
    assert.equal(runtime.proxy.token, 'ptok');
    assert.ok(runtime.proxy.expiresAt > Date.now() + 3_500_000);
  });
  it('takes the runtime Colab already has for the notebook without a POST', async () => {
    fake();
    answers.push({ status: 200, body: `${XSSI}${JSON.stringify({ endpoint: 'm-old', runtimeProxyInfo: proxyInfo })}` });
    const runtime = await relay.assignRuntime('t', { accelerator: 'NONE', notebook: '0f6b2a1c-3d4e-4f5a-8b9c-0d1e2f3a4b5c' });
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0].url, /variant=/);
    assert.equal(runtime.accelerator, null);
  });
  it('says what Colab’s refusals mean', async () => {
    fake();
    answers.push({ status: 412, body: '' });
    await assert.rejects(relay.assignRuntime('t', { accelerator: 'T4', notebook: '0f6b2a1c-3d4e-4f5a-8b9c-0d1e2f3a4b5c' }), (error) => error.status === 412 && error.limit === true && /as many runtimes/.test(error.message));
    answers.push({ status: 401, body: '' });
    await assert.rejects(relay.listRuntimes('t'), (error) => error.reauth === true);
  });
  it('starts, interrupts and lists kernels on the runtime, with the proxy token where Colab wants it', async () => {
    fake();
    answers.push({ status: 200, body: JSON.stringify({ id: 'k1', name: 'python3' }) });
    const kernel = await relay.startKernel(proxyInfo);
    assert.deepEqual(kernel, { id: 'k1', name: 'python3' });
    assert.equal(calls[0].url, 'https://abc-colab.googleusercontent.com/tun/m/xyz/api/kernels?colab-runtime-proxy-token=ptok');
    assert.equal(calls[0].headers['X-Colab-Runtime-Proxy-Token'], 'ptok');
    answers.push({ status: 200, body: '' });
    await relay.interruptKernel(proxyInfo, 'k1');
    assert.match(calls[1].url, /api\/kernels\/k1\/interrupt\?/);
    await assert.rejects(relay.interruptKernel(proxyInfo, '../evil'), /not named/);
    answers.push({ status: 404, body: '' });
    await assert.rejects(relay.listKernels(proxyInfo), (error) => error.gone === true);
  });
  it('routes the page’s requests, and turns nobody’s away without a Google token', async () => {
    assert.deepEqual((await relay.handleColab('/colab/runtimes', 'GET', '', null)).status, 401);
    assert.deepEqual((await relay.handleColab('/colab/elsewhere', 'GET', 't', null)).status, 404);
    fake();
    answers.push({ status: 200, body: `${XSSI}{"assignments":[]}` });
    assert.deepEqual(await relay.handleColab('/colab/runtimes', 'GET', 't', null), { status: 200, body: { runtimes: [] } });
    const refused = await relay.handleColab('/colab/kernels', 'POST', 't', { proxy: { url: 'https://evil.example.com/', token: 'x' } });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /not a Colab runtime/);
    assert.equal(calls.length, 1, 'nothing was fetched from the URL that was refused');
  });
});

describe('the Node proxy’s /colab routes', () => {
  const server = createServer((req, res) => apiRouter(req, res));
  const realFetch = globalThis.fetch;
  const sent = [];
  let base;
  const ready = new Promise((resolve) => server.listen(0, resolve)).then(() => {
    base = `http://localhost:${server.address().port}`;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(base)) return realFetch(input, init);
      sent.push({ url, auth: init.headers?.Authorization });
      return new Response(")]}'\n{\"assignments\":[]}", { status: 200 });
    };
  });
  afterEach(() => {
    delete process.env.READER_TOKEN;
    sent.length = 0;
  });
  after(() => {
    globalThis.fetch = realFetch;
    server.close();
  });

  it('says in /health that cells can be run through it', async () => {
    await ready;
    const health = await (await realFetch(`${base}/health`)).json();
    assert.equal(health.colab, true);
  });
  it('relays a list on the person’s Google token, and asks for one when there is none', async () => {
    await ready;
    const without = await realFetch(`${base}/colab/runtimes`);
    assert.equal(without.status, 401);
    const listed = await realFetch(`${base}/colab/runtimes`, { headers: { 'X-Google-Token': 'g-1' } });
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { runtimes: [] });
    assert.equal(sent[0].auth, 'Bearer g-1');
    assert.match(sent[0].url, /colab\.research\.google\.com\/tun\/m\/assignments/);
  });
  it('takes a POST from this app only', async () => {
    await ready;
    const elsewhere = await realFetch(`${base}/colab/runtimes/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://elsewhere.example', 'X-Google-Token': 'g' }, body: '{"endpoint":"m"}' });
    assert.equal(elsewhere.status, 403);
    const denied = await realFetch(`${base}/colab/runtimes`, { method: 'DELETE', headers: { 'X-Google-Token': 'g' } });
    assert.equal(denied.status, 405);
  });
  it('wants the proxy’s token when one is set, like the rest of what acts for a person', async () => {
    await ready;
    process.env.READER_TOKEN = 'secret-1';
    const refused = await realFetch(`${base}/colab/runtimes`, { headers: { 'X-Google-Token': 'g' } });
    assert.equal(refused.status, 401);
    const allowed = await realFetch(`${base}/colab/runtimes`, { headers: { 'X-Google-Token': 'g', Authorization: 'Bearer secret-1' } });
    assert.equal(allowed.status, 200);
  });
});

describe('what a running cell says about itself', () => {
  it('reads loss curves off a training log, by step when the log names one', () => {
    const log = ['epoch 1 step 100: loss=1.234 val_loss=1.5', 'epoch 1 step 200: loss=0.98 val_loss=1.31', 'saving checkpoint', 'epoch 2 step 300: loss=0.71 val_loss=1.2'].join('\n');
    const series = telemetry.lossSeries(log);
    assert.deepEqual(
      series.map((s) => [s.name, s.stepped, s.points]),
      [
        ['loss', true, [{ x: 100, y: 1.234 }, { x: 200, y: 0.98 }, { x: 300, y: 0.71 }]],
        ['val', true, [{ x: 100, y: 1.5 }, { x: 200, y: 1.31 }, { x: 300, y: 1.2 }]],
      ],
    );
    assert.equal(telemetry.hasCurve(series), true);
  });
  it('counts lines when there is no step, and reads a progress bar’s redraws', () => {
    const bar = '  0%|          | 0/50 loss=2.31\r 10%|█         | 5/50 loss=1.8\r 20%|██        | 10/50 loss=1.42';
    const [series] = telemetry.lossSeries(bar);
    assert.deepEqual(series.points, [{ x: 0, y: 2.31 }, { x: 5, y: 1.8 }, { x: 10, y: 1.42 }]);
    const plain = telemetry.lossSeries('Training loss: 0.5\nTraining loss: 0.4\nTraining loss: 3e-1');
    assert.deepEqual(plain, [{ name: 'train', stepped: false, points: [{ x: 1, y: 0.5 }, { x: 2, y: 0.4 }, { x: 3, y: 0.3 }] }]);
  });
  it('draws nothing for output that names no loss, or too little of one', () => {
    assert.deepEqual(telemetry.lossSeries('attention weights (rows sum to 1):\n  the [0.6 0.1]'), []);
    assert.equal(telemetry.hasCurve(telemetry.lossSeries('loss 0.5\nloss 0.4')), false);
    assert.deepEqual(telemetry.lossSeries('the loss function is cross-entropy'), []);
  });
  it('keeps a long run drawable', () => {
    const long = Array.from({ length: 5000 }, (_, i) => `step ${i} loss ${(1 / (i + 1)).toFixed(4)}`).join('\n');
    const [series] = telemetry.lossSeries(long);
    assert.ok(series.points.length <= telemetry.MAX_POINTS + 1);
    assert.equal(series.points[series.points.length - 1].x, 4999);
  });
  it('reads nvidia-smi’s numbers, and nothing else', () => {
    assert.deepEqual(telemetry.parseGpuSample('63, 3012, 15360\n', 4.2), { t: 4.2, util: 63, memUsedMb: 3012, memTotalMb: 15360 });
    assert.deepEqual(telemetry.parseGpuSample('63, 3012, 15360\n12, 100, 15360\n', 1), { t: 1, util: 63, memUsedMb: 3112, memTotalMb: 30720 });
    assert.equal(telemetry.parseGpuSample('nvidia-smi: command not found', 1), null);
    assert.match(telemetry.GPU_PROBE, /nvidia-smi/);
    assert.equal(telemetry.gigabytes(15360), '15 GB');
  });
  it('picks clean ticks and short numbers for the axes', () => {
    assert.deepEqual(telemetry.ticks(0, 100, 3), [0, 50, 100]);
    assert.deepEqual(telemetry.ticks(0.71, 1.5, 3), [0.75, 1, 1.25, 1.5]);
    assert.equal(telemetry.short(0.5), '0.5');
    assert.equal(telemetry.short(1234), '1.2k');
    assert.equal(telemetry.short(0.00042), '4.2e-4');
  });
});
