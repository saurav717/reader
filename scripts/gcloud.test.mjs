// The Google Cloud tab of the Usage page (worker/gcloud.js): that the Worker
// signs in as the service account with a JWT Google can check, reads the
// billing account, the Cloud Run services and VMs with their state and
// requests, and the billing export's cost and charges — each part with its
// own error when Google refuses it — and starts and stops only the project's
// own services. Google is a fake here, answering by URL.
//
//   node --test scripts/gcloud.test.mjs

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';

const gcloud = await import('../worker/gcloud.js');
const { default: worker } = await import('../worker/index.js');

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const KEY = { type: 'service_account', project_id: 'reader-509409', client_email: 'usage@reader-509409.iam.gserviceaccount.com', private_key: privateKey, private_key_id: 'k1' };
const ENV = { GCP_SERVICE_ACCOUNT_KEY: JSON.stringify(KEY), GCP_BILLING_EXPORT_TABLE: 'reader-509409.billing.gcp_billing_export_v1_0X' };
const NOW = Date.parse('2026-10-12T15:00:00Z');

const RUN = {
  name: 'projects/reader-509409/locations/us-central1/services/reader-latex',
  uri: 'https://reader-latex-fgk7igwsuq-uc.a.run.app',
  ingress: 'INGRESS_TRAFFIC_ALL',
  terminalCondition: { state: 'CONDITION_SUCCEEDED' },
  template: { scaling: { maxInstanceCount: 1 } },
};

/** A fake Google: each request is recorded and answered by the first handler whose pattern its URL matches. */
function fakeGoogle(handlers = {}) {
  const asked = [];
  const fetcher = async (url, init = {}) => {
    const href = String(url);
    asked.push({ url: href, method: init.method || 'GET', body: init.body, auth: init.headers?.Authorization });
    if (href === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'ya29.test', expires_in: 3600 });
    for (const [pattern, answer] of Object.entries(handlers)) {
      if (href.includes(pattern)) return typeof answer === 'function' ? answer(href, init) : Response.json(answer);
    }
    return Response.json({ error: { message: `nothing at ${href}` } }, { status: 404 });
  };
  return { fetcher, asked };
}

const ALL = {
  '/billingInfo': { billingAccountName: 'billingAccounts/0123AB-CDEF45-678901', billingEnabled: true },
  'cloudbilling.googleapis.com/v1/billingAccounts/': { displayName: 'My Billing Account', open: true, currencyCode: 'USD' },
  'run.googleapis.com/v2/projects/reader-509409/locations/us-central1/services': { services: [RUN] },
  '/aggregated/instances': {
    items: {
      'zones/us-central1-a': {
        instances: [{ name: 'gpu-box', zone: '.../zones/us-central1-a', status: 'TERMINATED', machineType: '.../machineTypes/g2-standard-4' }],
      },
      'zones/us-east1-b': { warning: { code: 'NO_RESULTS_ON_PAGE' } },
    },
  },
  'monitoring.googleapis.com': (url) => {
    const requests = decodeURIComponent(url).includes('request_count');
    return Response.json({
      timeSeries: [
        {
          resource: { labels: { service_name: 'reader-latex' } },
          points: [
            { interval: { endTime: '2026-10-12T00:00:00Z' }, value: requests ? { int64Value: '40' } : { doubleValue: 120.5 } },
            { interval: { endTime: '2026-10-11T00:00:00Z' }, value: requests ? { int64Value: '2' } : { doubleValue: 10 } },
          ],
        },
      ],
    });
  },
  'bigquery.googleapis.com': {
    schema: { fields: ['day', 'service', 'sku', 'type', 'currency', 'cost', 'credits', 'amount', 'unit'].map((name) => ({ name })) },
    rows: [
      ['2026-10-11', 'Cloud Run', 'CPU Allocation Time', 'regular', 'USD', '1.25', '-1.25', '52000', 'vCPU-second'],
      ['2026-10-10', 'Artifact Registry', 'Storage', 'regular', 'USD', '0.2', '0', '2.5', 'gibibyte month'],
      ['2026-09-30', 'Compute Engine', 'G2 instance core', 'regular', 'USD', '3.1', '0', '4', 'hour'],
    ].map((row) => ({ f: row.map((v) => ({ v })) })),
  },
};

afterEach(() => gcloud.forgetTokens());

describe('signing in as the service account', () => {
  it('signs a JWT for the cloud-platform scope that the account’s public key verifies', async () => {
    const jwt = await gcloud.signedAssertion(KEY, NOW);
    const [header, claims, signature] = jwt.split('.');
    const decoded = JSON.parse(Buffer.from(claims, 'base64url').toString());
    assert.equal(decoded.iss, KEY.client_email);
    assert.equal(decoded.scope, 'https://www.googleapis.com/auth/cloud-platform');
    assert.equal(decoded.exp - decoded.iat, 3600);
    assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString()).alg, 'RS256');
    assert.ok(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url')));
  });

  it('is not configured without a usable key', () => {
    assert.equal(gcloud.gcloudConfigured({}), false);
    assert.equal(gcloud.gcloudConfigured({ GCP_SERVICE_ACCOUNT_KEY: 'not json' }), false);
    assert.equal(gcloud.gcloudConfigured(ENV), true);
    assert.equal(gcloud.projectOf({ ...ENV, GCP_PROJECT: 'other-1' }), 'other-1');
  });
});

describe('the overview', () => {
  it('has the billing account, each service with its state and requests, and the month’s cost and charges', async () => {
    const google = fakeGoogle(ALL);
    const overview = await gcloud.gcloudOverview(ENV, google.fetcher, NOW);
    assert.equal(overview.project, 'reader-509409');
    assert.equal(overview.billing.name, 'My Billing Account');
    assert.equal(overview.billing.enabled, true);
    assert.match(overview.billing.paymentUrl, /billing\/0123AB-CDEF45-678901\/payment/);

    const [run, vm] = overview.services;
    assert.equal(run.status, 'running');
    assert.equal(run.requests, 42);
    assert.equal(run.instanceSeconds, 131);
    assert.deepEqual(run.daily, [
      { day: '2026-10-10', n: 2 },
      { day: '2026-10-11', n: 40 },
    ]);
    assert.equal(vm.status, 'stopped');
    assert.equal(vm.id, 'projects/reader-509409/zones/us-central1-a/instances/gpu-box');
    assert.equal(vm.type, 'VM · g2-standard-4');
    assert.deepEqual(overview.errors, {});

    assert.equal(overview.costs.month, '2026-10');
    assert.equal(overview.costs.cost, 1.45, 'September’s VM is not this month’s');
    assert.equal(overview.costs.credits, -1.25);
    assert.equal(overview.costs.net, 0.2);
    assert.equal(overview.costs.byService[0].service, 'Artifact Registry');
    assert.equal(overview.costs.charges.length, 3);
    assert.ok(google.asked.filter((ask) => ask.url.startsWith('https://oauth2')).length === 1, 'one token, kept for every ask');
    assert.ok(google.asked.filter((ask) => !ask.url.startsWith('https://oauth2')).every((ask) => ask.auth === 'Bearer ya29.test'));
  });

  it('asks BigQuery for the project alone, as a parameter, and refuses a table that is not project.dataset.table', async () => {
    const google = fakeGoogle(ALL);
    await gcloud.readCosts(ENV, google.fetcher, NOW);
    const body = JSON.parse(google.asked.find((ask) => ask.url.includes('bigquery')).body);
    assert.equal(body.queryParameters[0].parameterValue.value, 'reader-509409');
    assert.match(body.query, /`reader-509409\.billing\.gcp_billing_export_v1_0X`/);
    await assert.rejects(gcloud.readCosts({ ...ENV, GCP_BILLING_EXPORT_TABLE: 'x`; DROP' }, google.fetcher, NOW), /project\.dataset\.table/);
    assert.equal(await gcloud.readCosts({ ...ENV, GCP_BILLING_EXPORT_TABLE: '' }, google.fetcher, NOW), null);
  });

  it('keeps each part Google refuses as that part’s error, with the rest filled in', async () => {
    const refuse = (message) => () => Response.json({ error: { message } }, { status: 403 });
    const google = fakeGoogle({ ...ALL, '/aggregated/instances': refuse('Compute Engine API has not been used in project'), 'bigquery.googleapis.com': refuse('Access Denied: Table') });
    const overview = await gcloud.gcloudOverview(ENV, google.fetcher, NOW);
    assert.equal(overview.services.length, 1);
    assert.match(overview.errors.compute, /Compute Engine API/);
    assert.match(overview.costs.error, /Access Denied/);
    assert.equal(overview.billing.name, 'My Billing Account');
  });

  it('reads a closed Cloud Run service as stopped, and one being changed as on its way', () => {
    assert.equal(gcloud.runService({ ...RUN, ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY' }).status, 'stopped');
    assert.equal(gcloud.runService({ ...RUN, ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY', reconciling: true }).status, 'stopping');
    assert.equal(gcloud.runService({ ...RUN, reconciling: true }).status, 'starting');
    assert.equal(gcloud.runService({ ...RUN, terminalCondition: { state: 'CONDITION_FAILED', message: 'image gone' } }).status, 'error');
  });

  it('says whether a Cloud Run service costs anything while idle', () => {
    assert.equal(gcloud.runService(RUN).billedIdle, false);
    assert.match(gcloud.runService(RUN).billing, /scales to zero/);
    const kept = gcloud.runService({ ...RUN, template: { scaling: { minInstanceCount: 1 } } });
    assert.equal(kept.billedIdle, true);
    assert.match(kept.billing, /1 instance always on/);
    assert.equal(gcloud.runService({ ...RUN, template: { containers: [{ resources: { cpuIdle: false } }] } }).billedIdle, true);
  });
});

describe('starting and stopping', () => {
  it('stops a Cloud Run service by closing its ingress, and starts it by opening it', async () => {
    const google = fakeGoogle({ 'run.googleapis.com/v2/projects/reader-509409/locations/us-central1/services/reader-latex': (url, init) => Response.json(init.method === 'PATCH' ? { name: 'operations/1' } : RUN) });
    const stopped = await gcloud.gcloudAction(ENV, { kind: 'cloudrun', id: RUN.name, action: 'stop' }, google.fetcher);
    assert.deepEqual(stopped, { ok: true, status: 'stopping' });
    const patch = google.asked.find((ask) => ask.method === 'PATCH');
    assert.equal(JSON.parse(patch.body).ingress, 'INGRESS_TRAFFIC_INTERNAL_ONLY');
    assert.equal(JSON.parse(patch.body).uri, RUN.uri, 'the rest of the service as it was');
    // Already open: nothing to change.
    const before = google.asked.length;
    assert.deepEqual(await gcloud.gcloudAction(ENV, { kind: 'cloudrun', id: RUN.name, action: 'start' }, google.fetcher), { ok: true, status: 'running' });
    assert.equal(google.asked.filter((ask, index) => index >= before && ask.method === 'PATCH').length, 0);
  });

  it('starts and stops a VM with Compute Engine', async () => {
    const google = fakeGoogle({ '/instances/gpu-box/start': { name: 'operation-1' } });
    const id = 'projects/reader-509409/zones/us-central1-a/instances/gpu-box';
    assert.deepEqual(await gcloud.gcloudAction(ENV, { kind: 'vm', id, action: 'start' }, google.fetcher), { ok: true, status: 'starting' });
    assert.equal(google.asked.at(-1).method, 'POST');
  });

  it('touches nothing outside the project, and nothing but start and stop', async () => {
    const google = fakeGoogle({});
    await assert.rejects(gcloud.gcloudAction(ENV, { kind: 'vm', id: 'projects/someone-else/zones/us-central1-a/instances/x', action: 'stop' }, google.fetcher), /this project/);
    await assert.rejects(gcloud.gcloudAction(ENV, { kind: 'cloudrun', id: '../../x', action: 'stop' }, google.fetcher), /this project/);
    await assert.rejects(gcloud.gcloudAction(ENV, { kind: 'vm', id: RUN.name, action: 'delete' }, google.fetcher), /start or stop/);
    assert.equal(google.asked.length, 0);
  });
});

describe('the Worker’s routes', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const ask = (env, path, init = {}) =>
    worker.fetch(new Request(`https://proxy.example${path}`, { ...init, headers: { Origin: 'http://localhost:5173', ...(init.headers || {}) } }), env);

  it('are the owner’s alone', async () => {
    const env = { ...ENV, READER_TOKEN: 'owner-token' };
    assert.equal((await ask(env, '/usage/gcloud')).status, 401);
    assert.equal((await ask(env, '/usage/gcloud/service', { method: 'POST', body: '{}' })).status, 401);
  });

  it('answers the owner with the overview, and with { configured: false } without a key', async () => {
    globalThis.fetch = fakeGoogle(ALL).fetcher;
    const headers = { Authorization: 'Bearer owner-token' };
    const answer = await ask({ ...ENV, READER_TOKEN: 'owner-token' }, '/usage/gcloud', { headers });
    assert.equal(answer.status, 200);
    assert.equal((await answer.json()).billing.name, 'My Billing Account');
    assert.deepEqual(await (await ask({ READER_TOKEN: 'owner-token' }, '/usage/gcloud', { headers })).json(), { configured: false });
  });

  it('starts or stops a service on a POST, and says why not when it cannot', async () => {
    globalThis.fetch = fakeGoogle({ '/instances/gpu-box/stop': { name: 'operation-2' } }).fetcher;
    const env = { ...ENV, READER_TOKEN: 'owner-token' };
    const post = (body) => ask(env, '/usage/gcloud/service', { method: 'POST', headers: { Authorization: 'Bearer owner-token' }, body: JSON.stringify(body) });
    const answer = await post({ kind: 'vm', id: 'projects/reader-509409/zones/us-central1-a/instances/gpu-box', action: 'stop' });
    assert.deepEqual(await answer.json(), { ok: true, status: 'stopping' });
    const refused = await post({ kind: 'vm', id: 'projects/x/zones/z/instances/y', action: 'stop' });
    assert.equal(refused.status, 400);
    assert.equal((await ask(env, '/usage/gcloud/service', { headers: { Authorization: 'Bearer owner-token' } })).status, 405);
  });
});
