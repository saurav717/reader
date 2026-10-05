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

import { cleanup, load, loadTogether } from './bundle.mjs';

process.env.READER_SCHOLAR_PROFILE_DIR = join(tmpdir(), `reader-no-scholar-profile-${process.pid}`);
process.env.READER_PROFILE_DIR = join(tmpdir(), `reader-no-profile-${process.pid}`);
delete process.env.READER_TOKEN;

const lib = await load('src/lib/colab.ts');
const telemetry = await load('src/lib/telemetry.ts');
const nbLib = await loadTogether(['src/lib/notebook.ts', 'src/lib/explain.ts', 'src/lib/notebookAsk.ts'], { external: ['@anthropic-ai/sdk'] });
const nav = await load('src/lib/notebookNav.ts');
const rt = await loadTogether(['src/lib/runtime.ts', 'src/lib/colabRun.ts', 'src/lib/hardware.ts'], { external: ['@anthropic-ai/sdk'] });
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

  it('lists the runtime’s disk through the contents API, and refuses a path that climbs', async () => {
    await ready;
    const saved = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(base)) return saved(input, init);
      sent.push({ url });
      return new Response(JSON.stringify({ content: [{ name: 'models', path: 'models', type: 'directory' }, { name: 'PLAN.md', path: 'PLAN.md', type: 'file', size: 2048, last_modified: '2026-09-30T10:00:00Z' }, { name: 'a.ipynb', path: 'a.ipynb', type: 'notebook', size: 10 }] }), { status: 200 });
    };
    try {
      const proxy = { url: 'https://abc.prod.colab.dev/', token: 'tok' };
      const ok = await (await saved(`${base}/colab/contents`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-google-token': 'g' }, body: JSON.stringify({ proxy, path: '' }) })).json();
      assert.equal(ok.path, '', JSON.stringify(ok));
      assert.deepEqual(ok.entries.map((e) => [e.name, e.type, e.size]), [['models', 'directory', null], ['a.ipynb', 'notebook', 10], ['PLAN.md', 'file', 2048]]);
      assert.match(sent.at(-1).url, /\/api\/contents\/\?type=directory&content=1&colab-runtime-proxy-token=tok/);
      const bad = await saved(`${base}/colab/contents`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-google-token': 'g' }, body: JSON.stringify({ proxy, path: '../etc' }) });
      assert.equal(bad.status, 400);
    } finally {
      globalThis.fetch = saved;
    }
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
  it('reads every metric a training loop prints, a series a split, for the Metrics tab', () => {
    const log = ['step 100: train_loss=1.2 val/loss=1.5 acc 0.61 lr=3e-4', 'step 200: train_loss=0.9 val/loss=1.3 acc 0.72 lr=2.5e-4', 'epoch 1 done, ppl 12.5', 'step 300: train_loss=0.7 val/loss=1.2 acc 0.8 lr=2e-4 grad_norm=0.9'].join('\n');
    const metrics = telemetry.metricSeries(log);
    assert.deepEqual(metrics.map((m) => m.name), ['loss', 'accuracy', 'lr', 'perplexity', 'grad norm']);
    const loss = metrics[0];
    assert.deepEqual(loss.series.map((s) => [s.name, s.stepped, s.points.length]), [['train', true, 3], ['val', true, 3]]);
    assert.deepEqual(loss.series[1].points[2], { x: 300, y: 1.2 });
    assert.deepEqual(metrics[1].series, [{ name: '', stepped: true, points: [{ x: 100, y: 0.61 }, { x: 200, y: 0.72 }, { x: 300, y: 0.8 }] }]);
    assert.deepEqual(metrics[2].series[0].points[0], { x: 100, y: 0.0003 });
    assert.deepEqual(metrics[3].series[0].points, [{ x: 1, y: 12.5 }], 'an epoch line with no step counts by epoch');
    assert.deepEqual(telemetry.metricSeries('attention weights (rows sum to 1):\n  the [0.6 0.1 0.2 0.1]\nrow 3 of 4'), [], 'numbers with no metric name are not metrics');
    assert.deepEqual(telemetry.metricSeries('the loss function is cross-entropy; accuracy matters'), []);
    const bar = ' 10%|█ | 5/50 loss=1.8 acc=0.5\r 20%|██ | 10/50 loss=1.4 acc=0.6';
    assert.deepEqual(telemetry.metricSeries(bar).map((m) => [m.name, m.series[0].points.map((p) => p.x)]), [['loss', [5, 10]], ['accuracy', [5, 10]]]);
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

describe('one notebook a paper', () => {
  const { loadNotebook, takeKept, seedCells, setSource, setCells, appendCells, notebookFor, newCell, isSeedOnly } = nbLib;
  const sections = nbLib.parseExplanation('## At a glance\n\nA line.\n\n```python\nprint(1)\n```');
  it('takes a kept record only when it is this paper’s, and whole', () => {
    const mine = { paperId: 'arxiv:1', title: 'A', cells: [newCell('code', 'print(1)')], updated: 1 };
    assert.equal(takeKept(mine, 'arxiv:1'), mine);
    assert.equal(takeKept(mine, 'arxiv:2'), null, 'another paper’s notebook is not shown for this one, whatever key it was found under');
    assert.equal(takeKept({ paperId: 'arxiv:1', title: 'A' }, 'arxiv:1'), null, 'nor a record with no cells');
    assert.equal(takeKept(undefined, 'arxiv:1'), null);
    const stale = { paperId: 'arxiv:1', title: 'A', cells: [newCell('markdown', '# A\n\n*Explained by Claude in Reader. The outputs under each cell were written by Claude, not run — run them to check.*')], updated: 1 };
    assert.equal(takeKept(stale, 'arxiv:1'), null, 'nor the header an earlier build kept alone');
  });
  it('opens blank whatever the pages hold, and takes a page’s cells only when asked — in place of the blank header, else at the end', async () => {
    // The store writes a moment later through window.setTimeout, and finds no IndexedDB here: nothing is kept between tests.
    globalThis.window ??= globalThis;
    const nb = await loadNotebook('test:fill', 'A paper', () => seedCells('A paper', []));
    assert.ok(isSeedOnly(nb.cells), 'blank: one header cell, though the paper has an explanation');
    assert.ok(!('fillBlank' in nbLib), 'nothing fills a blank notebook from a page on its own');
    // What the start's "add the explanation's cells" and Cells ▾ do (addFromSections in Notebook.tsx).
    setCells('test:fill', seedCells('A paper', sections, 'DeepSeek Flash'));
    const filled = notebookFor('test:fill');
    assert.deepEqual(filled.cells.map((c) => c.type), ['markdown', 'markdown', 'code']);
    assert.match(filled.cells[0].source, /Explained by DeepSeek Flash/);
    appendCells('test:fill', seedCells('A paper', sections));
    assert.equal(notebookFor('test:fill').cells.length, 6, 'asked again, the cells go at the end');
    const own = await loadNotebook('test:own', 'B paper', () => seedCells('B paper', []));
    setSource('test:own', own.cells[0].id, `${own.cells[0].source}\n\nMy notes.`);
    assert.ok(!isSeedOnly(notebookFor('test:own').cells), 'a notebook written in is no longer the blank one');
    assert.equal(notebookFor('test:own').cells.length, 1);
    assert.equal(notebookFor('test:fill').paperId, 'test:fill', 'and each is its own paper’s');
    assert.equal(notebookFor('test:own').paperId, 'test:own');
  });
});

describe('a notebook of the reader’s own', () => {
  const { seedCells, toIpynb, fromIpynb, notebookFileName, newCell } = nbLib;
  const sections = nbLib.parseExplanation('## At a glance\n\nA line.\n\n```python title="Two"\nprint(1 + 1)\n```\n\n```output\n2\n```\n\n## More\n\nText.');
  it('is seeded from the page’s cells, with the model’s expected outputs left out', () => {
    const cells = seedCells('A paper', sections);
    assert.deepEqual(cells.map((c) => c.type), ['markdown', 'markdown', 'code', 'markdown']);
    assert.match(cells[0].source, /^# A paper/);
    assert.equal(cells[2].source, '# Two\nprint(1 + 1)', 'the cell’s title rides along as a comment');
    assert.deepEqual(cells[2].outputs, []);
    assert.equal(cells[2].count, null);
    assert.ok(cells.every((c) => /^[\w-]{8}$/.test(c.id)));
  });
  it('signs the header with the model that wrote the page, Claude when nothing says', () => {
    assert.match(seedCells('A paper', sections, 'DeepSeek Flash')[0].source, /Explained by DeepSeek Flash in Reader\. The outputs under each cell were written by DeepSeek Flash, not run/);
    assert.match(seedCells('A paper', sections)[0].source, /Explained by Claude in Reader/);
    assert.doesNotMatch(seedCells('A paper', sections, 'Gemini 3.8 Flash')[0].source, /Claude/);
  });
  it('with no page written yet, is one text cell that names no model: the model is picked on the tab', () => {
    const cells = seedCells('A paper', []);
    assert.equal(cells.length, 1);
    assert.equal(cells[0].type, 'markdown');
    assert.match(cells[0].source, /^# A paper\n\n\*A notebook of your own in Reader/);
    assert.doesNotMatch(cells[0].source, /Claude|Explained by/);
    assert.ok(nbLib.isSeedOnly(cells), 'and is known as the blank notebook’s one cell');
    assert.ok(!nbLib.isSeedOnly([{ ...cells[0], source: `${cells[0].source}\n\nMy notes.` }]), 'until it is written in');
    assert.ok(!nbLib.isSeedOnly(seedCells('A paper', sections)), 'cells from a page are not it');
  });
  it('knows the one-cell header an earlier build kept, which always said Claude, so it can be seeded again', () => {
    const stale = [{ ...newCell('markdown', '# A paper\n\n*Explained by Claude in Reader. The outputs under each cell were written by Claude, not run — run them to check.*') }];
    assert.ok(nbLib.isStaleSeed(stale));
    assert.ok(!nbLib.isStaleSeed([{ ...stale[0], source: `${stale[0].source}\n\nMy notes.` }]), 'not once written in');
    assert.ok(!nbLib.isStaleSeed([...stale, newCell('code', 'print(1)')]), 'not with code');
    assert.ok(!nbLib.isStaleSeed(seedCells('A paper', sections)), 'not a notebook seeded from a page');
    assert.ok(!nbLib.isStaleSeed(seedCells('A paper', [])), 'not the blank notebook');
  });
  it('goes out as an .ipynb Colab reads, and comes back the same', () => {
    const cells = [
      { ...newCell('markdown', '## Hello'), id: 'm1' },
      { ...newCell('code', 'print("hi")'), id: 'c1', count: 3, outputs: [{ type: 'stream', name: 'stdout', text: 'hi\n' }, { type: 'text', text: '42' }, { type: 'image', mime: 'image/png', data: 'AAAA' }, { type: 'error', ename: 'E', evalue: 'v', traceback: 'a\nb' }] },
    ];
    const text = toIpynb({ title: 'T', cells });
    const book = JSON.parse(text);
    assert.equal(book.nbformat, 4);
    assert.equal(book.metadata.kernelspec.name, 'python3');
    assert.deepEqual(book.cells[1].outputs.map((o) => o.output_type), ['stream', 'execute_result', 'display_data', 'error']);
    assert.equal(book.cells[1].execution_count, 3);
    const back = fromIpynb(text);
    assert.deepEqual(back.map((c) => [c.type, c.source, c.count]), [['markdown', '## Hello', null], ['code', 'print("hi")', 3]]);
    assert.deepEqual(back[1].outputs, cells[1].outputs);
    // A notebook from elsewhere: HTML outputs are dropped, raw cells become text, sources as arrays are joined.
    const foreign = fromIpynb(JSON.stringify({ cells: [{ cell_type: 'raw', source: ['a\n', 'b'] }, { cell_type: 'code', source: 'x', outputs: [{ output_type: 'display_data', data: { 'text/html': '<b>no</b>', 'text/plain': 'yes' } }], execution_count: null }] }));
    assert.deepEqual(foreign.map((c) => [c.type, c.source]), [['markdown', 'a\nb'], ['code', 'x']]);
    assert.deepEqual(foreign[1].outputs, [{ type: 'text', text: 'yes' }]);
    assert.equal(fromIpynb('not json'), null);
    assert.equal(fromIpynb('{"cells": 3}'), null);
  });
  it('names the file from the title', () => {
    assert.equal(notebookFileName('Attention Is All You Need'), 'attention-is-all-you-need.ipynb');
    assert.equal(notebookFileName('!!!'), 'notebook.ipynb');
  });
});

describe('a reply still streaming, drafted into its cells', () => {
  const { draftsOf } = nbLib;
  it('shows a replacement where it is, as the words come, and knows when its fence has closed', () => {
    const open = draftsOf('Cell 3 again.\n\n```python cell=3\nimport torch\nprint(');
    assert.deepEqual(open, [{ cell: 3, type: 'code', source: 'import torch\nprint(', done: false }]);
    const closed = draftsOf('Cell 3 again.\n\n```python cell=3\nimport torch\nprint(1)\n```\n');
    assert.deepEqual(closed, [{ cell: 3, type: 'code', source: 'import torch\nprint(1)', done: true }]);
  });
  it('drafts nothing for a new cell, which has nowhere to go until the answer is whole', () => {
    assert.deepEqual(draftsOf('```python after=3\nx = 1\n```\n```python after=end\ny = 2'), []);
    assert.deepEqual(draftsOf('A line of prose, no fence yet'), []);
  });
  it('takes a fence naming no cell as the one being rewritten, cell by cell, and only then', () => {
    assert.deepEqual(draftsOf('```python\nprint("again")', 4), [{ cell: 4, type: 'code', source: 'print("again")', done: false }]);
    assert.deepEqual(draftsOf('```python\nprint("again")'), []);
    assert.deepEqual(draftsOf('```python after=2\nprint("new")', 4), [], 'a placed new cell is not the rewrite');
  });
  it('keeps every cell a reply names, a text cell included', () => {
    const drafts = draftsOf('```markdown cell=1\n## Setup\n```\n```python cell=2\nimport os');
    assert.deepEqual(drafts.map((d) => [d.cell, d.type, d.done]), [[1, 'markdown', true], [2, 'code', false]]);
  });
});

describe('the model picked to write the notebook', () => {
  const { pickNotebookModel, notebookAskFor } = nbLib;
  it('is kept with the notebook’s requests, so the header and the bar name it before anything is asked', () => {
    assert.equal(notebookAskFor('p-pick').model, undefined);
    pickNotebookModel('p-pick', 'deepseek-flash');
    assert.equal(notebookAskFor('p-pick').model, 'deepseek-flash');
    pickNotebookModel('p-pick', 'gemini-3.8-flash');
    assert.equal(notebookAskFor('p-pick').model, 'gemini-3.8-flash');
  });
});

describe('whether a cell has run', () => {
  const { cellStatus, newCell } = nbLib;
  it('says so from the run this session, else from what the notebook kept', () => {
    const fresh = newCell('code', 'x = 1');
    assert.equal(cellStatus(fresh), 'never');
    assert.equal(cellStatus(fresh, { state: 'queued' }), 'queued');
    assert.equal(cellStatus(fresh, { state: 'running' }), 'running');
    assert.equal(cellStatus(fresh, { state: 'ran' }), 'ran');
    assert.equal(cellStatus(fresh, { state: 'failed' }), 'failed');
    assert.equal(cellStatus(fresh, { state: 'interrupted' }), 'stopped');
    const ran = { ...fresh, count: 2, ranAt: 1000, ranSource: 'x = 1', outputs: [{ type: 'stream', name: 'stdout', text: '1\n' }] };
    assert.equal(cellStatus(ran), 'ran');
    assert.equal(cellStatus({ ...ran, source: 'x = 2' }), 'changed', 'edited since it ran');
    assert.equal(cellStatus({ ...ran, source: 'x = 2' }, { state: 'ran' }), 'changed', 'even with the run still shown');
    assert.equal(cellStatus({ ...ran, outputs: [{ type: 'error', ename: 'E', evalue: 'v', traceback: 't' }] }), 'failed', 'a kept traceback is a failure');
    assert.equal(cellStatus({ ...fresh, count: 4 }), 'earlier', 'a count from an .ipynb, with no run here');
    assert.equal(cellStatus(newCell('markdown', 'hi')), null);
  });
});

describe('cells named in an answer', () => {
  it('links every mention, outside code', () => {
    const { linkCells } = nav;
    const link = (n) => `<a class="chat-cell" href="#cell-${n}" data-cell="${n}" title="Go to cell ${n} in the notebook">${n}</a>`;
    assert.equal(linkCells('<p>Cell 5 prints them.</p>'), `<p>Cell ${link(5)} prints them.</p>`);
    assert.equal(linkCells('<p>see cells 3, 5 and 7</p>'), `<p>see cells ${link(3)}, ${link(5)} and ${link(7)}</p>`);
    assert.equal(linkCells('<p>cells 2–4 differ</p>'), `<p>cells ${link(2)}–${link(4)} differ</p>`);
    assert.equal(linkCells('<p><code>cell 5</code> and <pre>x = cell 9</pre> stay, cell 1 links</p>'), `<p><code>cell 5</code> and <pre>x = cell 9</pre> stay, cell ${link(1)} links</p>`);
    assert.equal(linkCells('<p>a cell phone, cellular</p>'), '<p>a cell phone, cellular</p>');
  });
});

describe('the notebook’s ask bar', () => {
  const { parseNotebookReply, resolveEdits, cellsBlock, requestText, newCell, REWRITE_REQUEST } = nbLib;
  const cells = [
    { ...newCell('markdown', '# Title'), id: 'm1' },
    { ...newCell('code', 'import numpy as np\nprint(np.ones(2))'), id: 'c1', count: 1, outputs: [{ type: 'stream', name: 'stdout', text: '[1. 1.]\n' }] },
    { ...newCell('code', 'raise ValueError("no")'), id: 'c2' },
  ];
  it('reads the reply: cells with where they go, and the prose as the note', () => {
    const reply = 'Two cells: the attention in PyTorch, and a check.\n\n```python after=2\nimport torch\nprint(torch.__version__)\n```\n\n```markdown after=2\n**A note.**\n```\n\n```python cell=3\nprint("fixed")\n```\n\n```bash\nls\n```\nThat is all.';
    const { note, edits } = parseNotebookReply(reply);
    assert.equal(note, 'Two cells: the attention in PyTorch, and a check.\nThat is all.');
    assert.deepEqual(edits, [
      { kind: 'insert', after: 2, type: 'code', source: 'import torch\nprint(torch.__version__)' },
      { kind: 'insert', after: 2, type: 'markdown', source: '**A note.**' },
      { kind: 'replace', cell: 3, type: 'code', source: 'print("fixed")' },
    ]);
    assert.deepEqual(parseNotebookReply('```python\nx = 1\n```').edits, [{ kind: 'insert', after: null, type: 'code', source: 'x = 1' }], 'a fence with no place is placed as it is applied');
    assert.deepEqual(parseNotebookReply('```py after=end\nx = 1\n```').edits[0].after, 'end');
    assert.deepEqual(parseNotebookReply('```python cell="2" title="Two"\nx = 1\n```').edits[0], { kind: 'replace', cell: 2, type: 'code', source: 'x = 1' });
    assert.deepEqual(parseNotebookReply('Just an answer, no code.'), { note: 'Just an answer, no code.', edits: [] });
    assert.deepEqual(parseNotebookReply('~~~python cell=2\nx = 1\n~~~').edits, [{ kind: 'replace', cell: 2, type: 'code', source: 'x = 1' }], 'tilde fences');
    assert.deepEqual(parseNotebookReply('````python after=end\nprint("```")\n````').edits, [{ kind: 'insert', after: 'end', type: 'code', source: 'print("```")' }], 'four backticks around three');
    assert.deepEqual(parseNotebookReply('```python cell=2\nx = 1\n').edits, [], 'an open fence is not a cell');
  });
  it('knows a request for the whole notebook again, and takes an answer that replaces every cell', () => {
    const { wantsWholeNotebook } = nbLib;
    for (const yes of ['Rewrite the whole notebook from scratch in PyTorch', 'regenerate all the code', 'Can you redo the entire notebook with JAX?', 'rewrite all my cells', 'start over: the notebook, but for CIFAR-10', 'Write the notebook again with a smaller model']) assert.equal(wantsWholeNotebook(yes), true, yes);
    for (const no of ['Rewrite cell 3 in PyTorch', 'what does the notebook print?', 'add a cell that plots the loss', 'fix the error in cell 7', 'Write a training loop']) assert.equal(wantsWholeNotebook(no), false, no);
    const reply = parseNotebookReply('The notebook again.\n\n```markdown notebook=new\n# Title\n```\n\n```python\nprint(1)\n```');
    assert.equal(reply.replaceAll, true);
    assert.deepEqual(reply.edits.map((e) => [e.type, e.source]), [['markdown', '# Title'], ['code', 'print(1)']]);
    assert.equal(parseNotebookReply('```python after=end\nprint(1)\n```').replaceAll, undefined);
  });
  it('says why an answer gave the notebook nothing', () => {
    const { nothingTaken } = nbLib;
    assert.match(nothingTaken('DeepSeek', '', 'thought and thought', 'max_tokens'), /ran out of room.*reasoning used up the answer.*Rewrite cell by cell/);
    assert.match(nothingTaken('DeepSeek', '', undefined, 'end_turn'), /empty answer/);
    assert.match(nothingTaken('Claude', 'Here it is:\n```python cell=2\nx = 1\n', undefined, 'max_tokens'), /cut off before the cell was complete/);
    assert.match(nothingTaken('Claude', 'Here it is:\n```python cell=2\nx = 1\n', undefined, 'end_turn'), /cut off/);
    assert.match(nothingTaken('Claude', 'I would rather not.', undefined, 'end_turn'), /answered without a cell.*I would rather not/);
  });
  it('applies the edits: replacements in place, new cells after the cell named as it was numbered, unplaced ones after the cell asked about', () => {
    const edits = [
      { kind: 'replace', cell: 3, type: 'code', source: 'print("fixed")' },
      { kind: 'insert', after: 1, type: 'markdown', source: 'After the title' },
      { kind: 'insert', after: 1, type: 'code', source: 'second after the title' },
      { kind: 'insert', after: null, type: 'code', source: 'after the one asked about' },
      { kind: 'insert', after: 'end', type: 'code', source: 'last' },
      { kind: 'replace', cell: 9, type: 'code', source: 'nowhere' },
    ];
    const out = resolveEdits(cells, edits, 1);
    assert.deepEqual(
      out.cells.map((c) => c.source),
      ['# Title', 'After the title', 'second after the title', 'import numpy as np\nprint(np.ones(2))', 'after the one asked about', 'print("fixed")', 'last'],
    );
    assert.deepEqual(out.cells.map((c) => c.fresh), [undefined, 'new', 'new', undefined, 'new', 'changed', 'new']);
    assert.equal(out.cells[5].id, 'c2', 'a replaced cell keeps its id, so its run stays with it');
    assert.deepEqual(out.cells[5].outputs, [], 'and loses its old output');
    assert.deepEqual(out.touched, out.cells.filter((c) => c.fresh).map((c) => c.id), 'touched, in notebook order');
    assert.equal(resolveEdits(cells, [{ kind: 'insert', after: null, type: 'code', source: 'x' }], null).cells.at(-1).source, 'x', 'with no cell asked about, an unplaced cell goes last');
  });
  it('shows the model the notebook numbered, with what each cell printed and how it went', () => {
    const runs = { 'nb:c2': { state: 'failed', outputs: [{ type: 'error', ename: 'ValueError', evalue: 'no', traceback: 'Traceback…\nValueError: no' }], startedAt: 1, where: 'Colab' } };
    const block = cellsBlock(cells, runs);
    assert.match(block, /### Cell 1 \(text\)\n# Title/);
    assert.match(block, /### Cell 2 \(code, ran earlier\)\n```python\nimport numpy as np/);
    assert.match(block, /Output:\n```\n\[1\. 1\.\]\n```/);
    assert.match(block, /### Cell 3 \(code, FAILED\)[\s\S]*ValueError: no/);
    const text = requestText('Fix it', { cell: 3, quote: 'ValueError: no' }, cells, runs, { explanation: '## At a glance\nx', plan: undefined });
    assert.match(text, /<explanation>\n## At a glance/);
    assert.ok(!/<implementation_plan>/.test(text), 'no plan, no tag');
    assert.match(text, /<about>\nValueError: no\n<\/about>/);
    assert.match(text, /The request is about cell 3\.[\s\S]*Request: Fix it$/);
    assert.match(REWRITE_REQUEST, /after=end/);
  });
});

describe('the Runtime pane’s sums', () => {
  const now = 1_000_000_000;
  it('counts the session against Colab’s cap for the machine', () => {
    assert.equal(rt.sessionCapHours('T4'), 12);
    assert.equal(rt.sessionCapHours('A100'), 24);
    assert.equal(rt.sessionCapHours(null), 12);
    const left = rt.sessionLeft('T4', now - 3 * 3_600_000, now);
    assert.equal(left.capHours, 12);
    assert.equal(left.leftMs, 9 * 3_600_000);
    assert.equal(left.share, 0.25);
    assert.equal(rt.sessionLeft('T4', undefined, now).usedMs, 0);
  });
  it('turns units and a rate into hours, and says nothing without both', () => {
    assert.equal(rt.unitsLeft({ balance: 10, ratePerHour: 2 }), 5);
    assert.equal(rt.unitsLeft({ balance: 10 }), null);
    assert.equal(rt.unitsLeft(undefined), null);
    assert.equal(rt.spanText(9 * 3_600_000), '9 h');
    assert.equal(rt.spanText(95 * 60_000), '1 h 35 min');
    assert.equal(rt.spanText(20_000), 'under a minute');
  });
  it('draws the last minutes as series, with only the lines the samples have', () => {
    const history = [
      { at: now - 15 * 60_000, sample: { t: 0, gpu: { t: 0, util: 99, memUsedMb: 1, memTotalMb: 2 }, cpu: 99 } },
      { at: now - 5 * 60_000, sample: { t: 0, gpu: { t: 0, util: 40, memUsedMb: 4096, memTotalMb: 15360 }, cpu: 20, ramUsedMb: 2048, ramTotalMb: 13000 } },
      { at: now, sample: { t: 0, cpu: 30, ramUsedMb: 3072, ramTotalMb: 13000 } },
    ];
    const { use, memory } = rt.timeline(history, now, 10 * 60_000);
    assert.deepEqual(use.map((s) => [s.name, s.points]), [['GPU', [{ x: -5, y: 40 }]], ['CPU', [{ x: -5, y: 20 }, { x: 0, y: 30 }]]]);
    assert.deepEqual(memory.map((s) => [s.name, s.points.length]), [['VRAM', 1], ['RAM', 2]]);
    assert.deepEqual(rt.timeline([], now, 60_000), { use: [], memory: [], from: now - 60_000 });
  });
  it('marks which cells ran when along the window, clipped, the live one to now', () => {
    const runs = {
      'nb:old': { state: 'ran', outputs: [], startedAt: now - 20 * 60_000, ms: 60_000, where: 'Colab' },
      'nb:a': { state: 'ran', outputs: [], startedAt: now - 12 * 60_000, ms: 4 * 60_000, where: 'Colab' },
      'nb:b': { state: 'failed', outputs: [], startedAt: now - 3 * 60_000, ms: 100, where: 'Colab' },
      'nb:c': { state: 'running', outputs: [], startedAt: now - 60_000, where: 'Colab' },
    };
    const segments = rt.rulerSegments(runs, now, 10 * 60_000);
    assert.deepEqual(segments.map((s) => [s.key, s.start, s.end, s.state, s.live]), [
      ['nb:a', -10, -8, 'ran', false],
      ['nb:b', -3, -2.98, 'failed', false],
      ['nb:c', -1, 0, 'running', true],
    ]);
  });
  it('takes the plan’s needs for the ticks, and knows a meter near its top', () => {
    assert.deepEqual(rt.needMarkers({ phases: [{ name: 'a', memoryGb: 9 }, { name: 'b', memoryGb: 22 }], ramGb: 16 }), { vramGb: 22, ramGb: 16 });
    assert.deepEqual(rt.needMarkers({ phases: [], minVramGb: 8 }), { vramGb: 8, ramGb: undefined });
    assert.deepEqual(rt.needMarkers(null), {});
    assert.equal(rt.nearFull(14, 15), true);
    assert.equal(rt.nearFull(5, 15), false);
    assert.equal(rt.nearFull(undefined, 15), false);
  });
});

describe('the Runtime pane’s strips, sparklines and peaks', () => {
  const now = 1_000_000_000;
  it('bins the window for the strips, the highest of each bin, empty where nothing was read', () => {
    const history = [
      { at: now - 55_000, sample: { t: 0, cpu: 10 } },
      { at: now - 52_000, sample: { t: 0, cpu: 40 } },
      { at: now - 5_000, sample: { t: 0, cpu: 20 } },
      { at: now - 200_000, sample: { t: 0, cpu: 99 } },
    ];
    const out = rt.bins(history, now, 60_000, 10_000, (s) => s.cpu);
    assert.deepEqual(out, [40, undefined, undefined, undefined, undefined, 20]);
    assert.equal(rt.peakOf(out), 40);
    assert.equal(rt.peakOf([undefined, undefined]), undefined);
  });
  it('gives the last minute as points over seconds before now', () => {
    const history = [{ at: now - 90_000, sample: { t: 0, cpu: 1 } }, { at: now - 30_000, sample: { t: 0, cpu: 2, gpu: { t: 0, util: 5, memUsedMb: 1024, memTotalMb: 2048 } } }, { at: now, sample: { t: 0, cpu: 3 } }];
    assert.deepEqual(rt.recent(history, now, 60_000, (s) => s.cpu), [{ x: -30, y: 2 }, { x: 0, y: 3 }]);
    assert.deepEqual(rt.recent(history, now, 60_000, (s) => s.gpu?.util), [{ x: -30, y: 5 }]);
  });
  it('lists the hungriest runs of the window by their peaks, the busiest first', () => {
    const runs = {
      'nb:a': { state: 'ran', outputs: [], startedAt: now - 60_000, ms: 10_000, where: 'Colab', samples: [{ t: 1, gpu: { t: 1, util: 20, memUsedMb: 2048, memTotalMb: 15360 }, cpu: 10 }, { t: 3, gpu: { t: 3, util: 70, memUsedMb: 9000, memTotalMb: 15360 }, cpu: 30 }] },
      'nb:b': { state: 'ran', outputs: [], startedAt: now - 30_000, ms: 10_000, where: 'Colab', samples: [{ t: 1, cpu: 55, ramUsedMb: 4096 }] },
      'nb:old': { state: 'ran', outputs: [], startedAt: now - 20 * 60_000, ms: 10_000, where: 'Colab', samples: [{ t: 1, gpu: { t: 1, util: 99, memUsedMb: 1, memTotalMb: 2 } }] },
      'nb:none': { state: 'ran', outputs: [], startedAt: now - 10_000, ms: 100, where: 'Colab' },
    };
    const peaks = rt.peaksByCell(runs, now, 10 * 60_000);
    assert.deepEqual(peaks.map((p) => [p.key, p.gpu, p.vramMb, p.cpu, p.ramMb]), [['nb:a', 70, 9000, 30, undefined], ['nb:b', undefined, undefined, 55, 4096]]);
  });
});
