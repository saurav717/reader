// Run in Colab, without a browser, a Google account or a runtime: how the
// page reads what a kernel sends back and compares it with what Claude
// expected; how the proxy's half (server/colab.js) talks to Colab's session
// backend and to a runtime's Jupyter server, on the person's own token and
// only to Colab's hosts; and the Node proxy's /colab routes.
//
//   node --test scripts/colab.test.mjs

import { after, afterEach, before, describe, it } from 'node:test';
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
  let before = null;
  const calls = [];
  const answers = [];
  const XSSI = ")]}'\n";
  const proxyInfo = { url: 'https://abc-colab.googleusercontent.com/tun/m/xyz/', token: 'ptok', tokenExpiresInSeconds: 3600 };
  afterEach(() => {
    // Put back whatever fetch was there — another suite's stand-in, or the real one — not a copy taken earlier.
    if (before) globalThis.fetch = before;
    before = null;
    calls.length = 0;
    answers.length = 0;
  });
  const fake = () => {
    before = globalThis.fetch;
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
    assert.equal(relay.checkRuntimeUrl('https://m-s-2r3ptqkc7gsj0-s.us-west1-a.prod.colab.dev'), 'https://m-s-2r3ptqkc7gsj0-s.us-west1-a.prod.colab.dev/');
    assert.throws(() => relay.checkRuntimeUrl('https://evil.example.com/'), /not a Colab runtime \(https:\/\/evil\.example\.com\)/);
    for (const bad of ['http://abc-colab.googleusercontent.com/', 'https://evil.example.com/googleusercontent.com/', 'https://user:pw@abc.googleusercontent.com/', 'https://169.254.169.254/', 'https://googleusercontent.com.evil.net/', 'https://colab.dev.evil.net/', 'https://notcolab.dev/', 'nope']) {
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
  });
  before(async () => {
    await ready;
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
    assert.equal(telemetry.gigabytes(15360), '15 GB');
  });
  it('reads the machine probe’s line: the GPU by name, the CPU, the memory, the disk', () => {
    assert.match(telemetry.MACHINE_PROBE, /nvidia-smi/);
    assert.match(telemetry.MACHINE_PROBE, /\/proc\/stat/);
    assert.match(telemetry.MACHINE_PROBE, /json\.dumps/);
    const line = '{"gpu": "Tesla T4, 63, 3012, 15360", "cpu": 41, "cpus": 2, "ram": [5200, 13000], "disk": [71, 78]}';
    const sample = telemetry.parseMachineSample(`some warning first\n${line}\n`, 4.2);
    assert.deepEqual(sample, { t: 4.2, gpu: { t: 4.2, name: 'Tesla T4', util: 63, memUsedMb: 3012, memTotalMb: 15360 }, cpu: 41, cpus: 2, ramUsedMb: 5200, ramTotalMb: 13000, diskFreeGb: 71, diskTotalGb: 78 });
    assert.deepEqual(telemetry.specsOf(sample), { gpuName: 'Tesla T4', vramMb: 15360, cpus: 2, ramTotalMb: 13000, diskTotalGb: 78, diskFreeGb: 71 });
    // A CPU runtime: no GPU line, the rest as before.
    const cpuOnly = telemetry.parseMachineSample('{"gpu": "", "cpu": 12, "cpus": 2, "ram": [1200, 13000], "disk": [100, 107]}', 0);
    assert.equal(cpuOnly.gpu, undefined);
    assert.equal(cpuOnly.cpu, 12);
    assert.equal(cpuOnly.ramTotalMb, 13000);
    // Two cards are named once, with the count; the numbers are summed as before.
    const two = telemetry.parseMachineSample('{"gpu": "NVIDIA A100-SXM4-40GB, 90, 30000, 40960\\nNVIDIA A100-SXM4-40GB, 10, 100, 40960", "cpu": null, "cpus": 12, "ram": null, "disk": null}', 1);
    assert.deepEqual(two.gpu, { t: 1, name: '2× NVIDIA A100-SXM4-40GB', util: 90, memUsedMb: 30100, memTotalMb: 81920 });
    assert.equal(two.cpu, undefined);
    assert.equal(two.ramUsedMb, undefined);
    // Not the probe's line at all.
    assert.equal(telemetry.parseMachineSample('Traceback (most recent call last):\n  NameError', 1), null);
    assert.equal(telemetry.parseMachineSample('{"weights": [1, 2]}', 1), null);
  });
  it('picks clean ticks and short numbers for the axes', () => {
    assert.deepEqual(telemetry.ticks(0, 100, 3), [0, 50, 100]);
    assert.deepEqual(telemetry.ticks(0.71, 1.5, 3), [0.75, 1, 1.25, 1.5]);
    assert.equal(telemetry.short(0.5), '0.5');
    assert.equal(telemetry.short(1234), '1.2k');
    assert.equal(telemetry.short(0.00042), '4.2e-4');
  });
});

describe('the socket bridge', () => {
  const SECRET = 'bridge-secret';
  const RUNTIME = 'https://m-s-abc.us-west1-a.prod.colab.dev/';
  it('signs a ticket for one kernel on one runtime, good for a minute, and reads nothing else', async () => {
    const ticket = await relay.issueSocketTicket(SECRET, { url: RUNTIME, kernel: 'k1', session: 's1' }, 1_000_000);
    assert.match(ticket, /^rct1\./);
    assert.deepEqual(await relay.readSocketTicket(SECRET, ticket, 1_000_000 + 30_000), { url: RUNTIME, kernel: 'k1', session: 's1' });
    assert.equal(await relay.readSocketTicket(SECRET, ticket, 1_000_000 + 61_000), null, 'expired');
    assert.equal(await relay.readSocketTicket('other-secret', ticket, 1_000_000), null, 'another secret');
    assert.equal(await relay.readSocketTicket(SECRET, `${ticket}x`, 1_000_000), null, 'tampered');
    assert.equal(await relay.readSocketTicket('', ticket, 1_000_000), null, 'no secret');
    await assert.rejects(relay.issueSocketTicket(SECRET, { url: 'https://evil.example.com/', kernel: 'k1' }), /not a Colab runtime/);
    await assert.rejects(relay.issueSocketTicket('', { url: RUNTIME, kernel: 'k1' }), /no secret/);
  });
  it('dials the runtime as Colab’s own client does: the token in the query and the header, Colab as the origin', () => {
    const { href, headers } = relay.upstreamSocket({ url: RUNTIME, kernel: 'k1', session: 's1', token: 'ptok' });
    assert.equal(href, 'wss://m-s-abc.us-west1-a.prod.colab.dev/api/kernels/k1/channels?session_id=s1&colab-runtime-proxy-token=ptok');
    assert.equal(headers['X-Colab-Runtime-Proxy-Token'], 'ptok');
    assert.equal(headers.Origin, 'https://colab.research.google.com');
    assert.equal(relay.readHello(JSON.stringify({ type: 'hello', token: 'ptok' })), 'ptok');
    assert.equal(relay.readHello(JSON.stringify({ type: 'execute_request' })), null);
    assert.equal(relay.readHello('nonsense'), null);
    assert.equal(relay.closeCode(1006), 1000);
    assert.equal(relay.closeCode(1011), 1011);
    assert.equal(relay.closeCode(4001), 4001);
  });
  it('hands a ticket out over /colab/socket/ticket, for a Colab runtime only', async () => {
    const given = await relay.handleColab('/colab/socket/ticket', 'POST', 't', { proxy: { url: RUNTIME }, kernel: 'k1', session: 's1' }, { secret: SECRET });
    assert.equal(given.status, 200);
    assert.deepEqual(await relay.readSocketTicket(SECRET, given.body.ticket), { url: RUNTIME, kernel: 'k1', session: 's1' });
    const refused = await relay.handleColab('/colab/socket/ticket', 'POST', 't', { proxy: { url: 'https://evil.example.com/' }, kernel: 'k1' }, { secret: SECRET });
    assert.equal(refused.status, 400);
  });
});

describe('the Node proxy carries a kernel’s socket', async () => {
  const { WebSocket, WebSocketServer } = await import('ws');
  const { createServer: createHttpServer } = await import('node:http');
  const { attachColabSocket, bridge, socketSecret } = await import('../server/colabSocket.js');
  const RUNTIME = 'https://m-s-abc.us-west1-a.prod.colab.dev/';
  // A stand-in runtime: a WebSocket server that echoes frames back, tagged.
  const runtime = createHttpServer();
  const kernels = new WebSocketServer({ server: runtime });
  kernels.on('connection', (socket) => socket.on('message', (data) => socket.send(`echo:${data}`)));
  await new Promise((resolve) => runtime.listen(0, resolve));
  const runtimeAddress = `ws://localhost:${runtime.address().port}/`;
  // What the bridge dials is recorded, and the stand-in answers in the runtime's place.
  const dialled = [];
  const dial = (href, headers) => {
    dialled.push({ href, headers });
    return new WebSocket(runtimeAddress);
  };
  const proxy = createHttpServer((req, res) => apiRouter(req, res));
  const secret = 'node-bridge-secret';
  const sockets = attachColabSocket(proxy, { secret: () => secret, fromThisApp: (req) => !req.headers.origin || req.headers.origin === 'http://localhost:5173' });
  await new Promise((resolve) => proxy.listen(0, resolve));
  const base = `ws://localhost:${proxy.address().port}`;
  const opened = [];
  after(() => {
    for (const socket of opened) socket.terminate();
    kernels.close();
    runtime.close();
    sockets.close();
    proxy.close();
  });

  const open = (url, headers = {}) =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers });
      opened.push(socket);
      const frames = [];
      const closed = new Promise((done) => socket.on('close', (code, reason) => done({ code, reason: reason.toString() })));
      socket.on('message', (data) => frames.push(data.toString()));
      socket.on('open', () => resolve({ socket, frames, closed }));
      socket.on('error', reject);
      socket.on('unexpected-response', (_req, res) => reject(Object.assign(new Error(`refused ${res.statusCode}`), { status: res.statusCode })));
    });
  const until = (frames, count) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => (frames.length >= count ? resolve(frames) : Date.now() - started > 5000 ? reject(new Error(`only ${frames.length} frames`)) : setTimeout(tick, 10));
      tick();
    });
  /** A bridge of its own for one test, on a stand-in runtime, closed after. */
  const withBridge = async (run) => {
    const direct = createHttpServer();
    const server = new WebSocketServer({ server: direct });
    server.on('connection', (client) => bridge(client, { url: RUNTIME, kernel: 'k1', session: 's1' }, { dial }));
    await new Promise((resolve) => direct.listen(0, resolve));
    try {
      await run(`ws://localhost:${direct.address().port}/`);
    } finally {
      for (const client of server.clients) client.terminate();
      server.close();
      direct.close();
    }
  };

  it('refuses a socket without a fresh ticket, or from elsewhere', async () => {
    await assert.rejects(open(`${base}/colab/socket`), (error) => error.status === 401);
    await assert.rejects(open(`${base}/colab/socket?ticket=rct1.bad.bad`), (error) => error.status === 401);
    const ticket = await relay.issueSocketTicket(secret, { url: RUNTIME, kernel: 'k1' });
    await assert.rejects(open(`${base}/colab/socket?ticket=${ticket}`, { Origin: 'https://elsewhere.example' }), (error) => error.status === 403);
    await assert.rejects(open(`${base}/elsewhere`), (error) => error.status === 404);
  });
  it('closes a socket whose first frame is not the hello', () =>
    withBridge(async (address) => {
      const { socket, closed } = await open(address);
      socket.send(JSON.stringify({ header: { msg_type: 'execute_request' } }));
      assert.equal((await closed).code, 1008);
    }));
  it('pipes frames both ways once the page has said hello, dialling the runtime as Colab’s client does', () =>
    withBridge(async (address) => {
      const { socket, frames } = await open(address);
      socket.send(JSON.stringify({ type: 'hello', token: 'ptok' }));
      // A frame sent before the runtime answers is held, and goes through once it has.
      socket.send('first');
      await until(frames, 2);
      assert.deepEqual(frames, [JSON.stringify({ type: 'ready' }), 'echo:first']);
      socket.send('second');
      await until(frames, 3);
      assert.equal(frames[2], 'echo:second');
      assert.equal(dialled.length, 1);
      assert.equal(dialled[0].href, 'wss://m-s-abc.us-west1-a.prod.colab.dev/api/kernels/k1/channels?session_id=s1&colab-runtime-proxy-token=ptok');
      assert.equal(dialled[0].headers['X-Colab-Runtime-Proxy-Token'], 'ptok');
      assert.equal(dialled[0].headers.Origin, 'https://colab.research.google.com');
    }));
  it('lets a ticketed socket through /colab/socket to the bridge', async () => {
    const ticket = await relay.issueSocketTicket(secret, { url: RUNTIME, kernel: 'k1', session: 's1' });
    const { socket, closed } = await open(`${base}/colab/socket?ticket=${ticket}`, { Origin: 'http://localhost:5173' });
    socket.send('not a hello');
    assert.equal((await closed).code, 1008);
  });
  it('is signed with READER_TOKEN when there is one, and with its own secret otherwise', () => {
    delete process.env.READER_TOKEN;
    const own = socketSecret();
    assert.ok(own.length > 20);
    process.env.READER_TOKEN = 'the-token';
    assert.equal(socketSecret(), 'the-token');
    delete process.env.READER_TOKEN;
  });
});
