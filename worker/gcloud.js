/**
 * The owner's Google Cloud project, for the Google Cloud tab of the Usage
 * page: the billing account it is billed to, each service running in it —
 * Cloud Run services and Compute Engine VMs — with whether it is up and what
 * it has served, what the project cost, and the charges and credits behind it.
 * The owner can start and stop a service from there.
 *
 * Google is asked as a service account whose JSON key is the Worker's secret
 * GCP_SERVICE_ACCOUNT_KEY; the Worker signs a token with it (a JWT, RS256)
 * and keeps it until shortly before it runs out. What the account may see and
 * do is what its roles allow (docs/deploy.md, "Google Cloud on the Usage page"):
 *
 *   roles/run.developer             Cloud Run: list, start and stop services
 *   roles/compute.instanceAdmin.v1  Compute Engine: list, start and stop VMs
 *   roles/monitoring.viewer         requests and instance time per service
 *   roles/billing.viewer            the billing account (granted on the account)
 *   roles/bigquery.jobUser and
 *   roles/bigquery.dataViewer       the billing export, for cost and charges
 *
 * Anything it may not do — or an API not turned on — comes back as that
 * part's `error`, with the rest of the page still filled in.
 *
 *   GCP_PROJECT               the project, if not the key's own project_id
 *   GCP_REGIONS               Cloud Run regions to list, comma separated (us-central1)
 *   GCP_BILLING_EXPORT_TABLE  project.dataset.table of the billing export to
 *                             BigQuery; without it, no cost or charges — Google
 *                             has no other API for them
 *
 * "Stop" on Cloud Run closes the service to the internet (ingress internal
 * only): nothing reaches it, so with no minimum instances it costs nothing;
 * "Start" opens it again. Cloud Run has no stopped state of its own. A VM is
 * stopped and started as Compute Engine does it.
 *
 * Google takes no payment through an API, so recharging the billing account
 * is a link to its payment page in the Cloud console.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DAY_MS = 86_400_000;
/** Days of requests the page shows per service. */
export const SERVICE_DAYS = 30;
/** Charges listed, newest first. */
export const CHARGES_KEPT = 200;

/** The service account's key, parsed, or null without a usable one. */
export function serviceAccount(env) {
  const raw = String(env.GCP_SERVICE_ACCOUNT_KEY || '').trim();
  if (!raw) return null;
  try {
    const key = JSON.parse(raw);
    return key.client_email && key.private_key ? key : null;
  } catch {
    return null;
  }
}

export const gcloudConfigured = (env) => Boolean(serviceAccount(env));

/** The project the page is about: GCP_PROJECT, or the key's own. */
export const projectOf = (env) => String(env.GCP_PROJECT || serviceAccount(env)?.project_id || '').trim();

const regionsOf = (env) =>
  String(env.GCP_REGIONS || 'us-central1')
    .split(',')
    .map((region) => region.trim())
    .filter((region) => /^[a-z]+-[a-z]+\d+$/.test(region));

const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const base64urlText = (text) => base64url(new TextEncoder().encode(text));

function pemBody(pem) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A signed JWT asking Google for an access token as `key`'s account. */
export async function signedAssertion(key, now = Date.now()) {
  const issued = Math.floor(now / 1000);
  const header = base64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...(key.private_key_id ? { kid: key.private_key_id } : {}) }));
  const claims = base64urlText(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat: issued, exp: issued + 3600 }));
  const signer = await crypto.subtle.importKey('pkcs8', pemBody(key.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signer, new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${base64url(signature)}`;
}

// Access tokens by account, until a minute before Google says they end; the
// asks the page makes at once share the one being fetched.
const tokens = new Map();

export function forgetTokens() {
  tokens.clear();
}

async function fetchToken(key, fetcher) {
  const response = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: await signedAssertion(key) }).toString(),
  });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok || !answer.access_token) throw new Error(`Google refused the service account: ${answer.error_description || answer.error || response.status}`);
  return { token: answer.access_token, until: Date.now() + (Number(answer.expires_in) || 3600) * 1000 - 60_000 };
}

async function accessToken(env, fetcher) {
  const key = serviceAccount(env);
  if (!key) throw new Error('no GCP_SERVICE_ACCOUNT_KEY on the Worker');
  const held = tokens.get(key.client_email);
  if (held && (!held.until || held.until > Date.now())) return (await held.pending)?.token ?? held.token;
  const pending = fetchToken(key, fetcher);
  tokens.set(key.client_email, { pending });
  try {
    const fresh = await pending;
    tokens.set(key.client_email, fresh);
    return fresh.token;
  } catch (error) {
    tokens.delete(key.client_email);
    throw error;
  }
}

/** Ask a Google API as the service account; its JSON, or throws with Google's reason. */
async function google(env, fetcher, url, init = {}) {
  const token = await accessToken(env, fetcher);
  const response = await fetcher(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) },
  });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(answer?.error?.message || `${response.status} from ${new URL(url).hostname}`);
  return answer;
}

const settle = async (work) => {
  try {
    return { value: await work() };
  } catch (error) {
    return { error: String(error?.message || error) };
  }
};

const last = (path) => String(path || '').split('/').pop();

// ---------------------------------------------------------------- billing

/** The billing account the project is on, and the console's pages for it. */
export async function readBilling(env, fetcher = fetch) {
  const project = projectOf(env);
  const info = await google(env, fetcher, `https://cloudbilling.googleapis.com/v1/projects/${encodeURIComponent(project)}/billingInfo`);
  const id = last(info.billingAccountName);
  const billing = { id, enabled: Boolean(info.billingEnabled), name: id, open: null, currency: null };
  if (id) {
    const account = await settle(() => google(env, fetcher, `https://cloudbilling.googleapis.com/v1/billingAccounts/${encodeURIComponent(id)}`));
    if (account.value) Object.assign(billing, { name: account.value.displayName || id, open: Boolean(account.value.open), currency: account.value.currencyCode || null });
    else billing.accountError = account.error;
  }
  const consoleBase = 'https://console.cloud.google.com/billing';
  return {
    ...billing,
    overviewUrl: id ? `${consoleBase}/${id}?project=${project}` : `${consoleBase}?project=${project}`,
    paymentUrl: id ? `${consoleBase}/${id}/payment?project=${project}` : `${consoleBase}?project=${project}`,
    reportsUrl: id ? `${consoleBase}/${id}/reports?project=${project}` : `${consoleBase}?project=${project}`,
  };
}

// --------------------------------------------------------------- services

/** A Cloud Run service as the page shows it. */
export function runService(service) {
  const [, , , location, , name] = String(service.name).split('/');
  const closed = service.ingress === 'INGRESS_TRAFFIC_INTERNAL_ONLY';
  const condition = service.terminalCondition || {};
  const reconciling = Boolean(service.reconciling);
  const failed = condition.state === 'CONDITION_FAILED';
  const status = reconciling ? (closed ? 'stopping' : 'starting') : failed ? 'error' : closed ? 'stopped' : 'running';
  const scaling = service.template?.scaling || {};
  // Billed while idle: instances kept running (a minimum), or CPU always
  // allocated (instance-based billing) on whatever is up. Otherwise Cloud Run
  // bills only while a request is being served, and scales to zero between.
  const minInstances = Math.max(Number(scaling.minInstanceCount) || 0, Number(service.scaling?.minInstanceCount) || 0);
  const cpuAlways = (service.template?.containers || []).some((container) => container.resources?.cpuIdle === false);
  const idle = closed ? 'closed: costs nothing while it stays so' + (minInstances ? `, but for its ${minInstances} kept instance${minInstances > 1 ? 's' : ''}` : '')
    : minInstances
      ? `${minInstances} instance${minInstances > 1 ? 's' : ''} always on: billed while idle`
      : cpuAlways
        ? 'CPU always allocated: billed while an instance is up'
        : 'scales to zero: billed only while serving requests';
  return {
    kind: 'cloudrun',
    id: service.name,
    name,
    location,
    type: 'Cloud Run service',
    status,
    detail: failed ? condition.message || 'not ready' : closed ? 'closed to the internet (internal ingress)' : service.uri || '',
    url: service.uri || null,
    updated: service.updateTime || null,
    minInstances,
    billedIdle: Boolean(minInstances || cpuAlways),
    billing: idle,
    maxInstances: Number(scaling.maxInstanceCount) || null,
    consoleUrl: `https://console.cloud.google.com/run/detail/${location}/${name}/metrics?project=${String(service.name).split('/')[1]}`,
  };
}

const VM_STATUS = { RUNNING: 'running', TERMINATED: 'stopped', STOPPED: 'stopped', SUSPENDED: 'stopped', STOPPING: 'stopping', SUSPENDING: 'stopping', PROVISIONING: 'starting', STAGING: 'starting', REPAIRING: 'starting' };

/** A Compute Engine VM as the page shows it. */
export function vmInstance(instance, project) {
  const zone = last(instance.zone);
  return {
    kind: 'vm',
    id: `projects/${project}/zones/${zone}/instances/${instance.name}`,
    name: instance.name,
    location: zone,
    type: `VM · ${last(instance.machineType)}`,
    status: VM_STATUS[instance.status] || 'error',
    detail: instance.status === 'RUNNING' && instance.lastStartTimestamp ? `up since ${instance.lastStartTimestamp}` : String(instance.status || '').toLowerCase(),
    url: null,
    updated: instance.lastStartTimestamp || null,
    consoleUrl: `https://console.cloud.google.com/compute/instancesDetail/zones/${zone}/instances/${instance.name}?project=${project}`,
  };
}

async function listRun(env, fetcher) {
  const project = projectOf(env);
  const lists = await Promise.all(
    regionsOf(env).map((region) => google(env, fetcher, `https://run.googleapis.com/v2/projects/${project}/locations/${region}/services?pageSize=100`)),
  );
  return lists.flatMap((list) => (list.services || []).map(runService));
}

async function listVms(env, fetcher) {
  const project = projectOf(env);
  const answer = await google(env, fetcher, `https://compute.googleapis.com/compute/v1/projects/${project}/aggregated/instances?returnPartialSuccess=true&maxResults=200`);
  return Object.values(answer.items || {}).flatMap((zone) => (zone.instances || []).map((instance) => vmInstance(instance, project)));
}

/**
 * Cloud Run's own count of each service's requests and billable instance
 * time, a day at a time for the last SERVICE_DAYS days: Cloud Monitoring.
 * `{ [service]: { requests: [{day, n}], seconds: [{day, n}] } }`.
 */
export async function readRunMetrics(env, fetcher = fetch, now = Date.now()) {
  const project = projectOf(env);
  const end = new Date(Math.floor(now / DAY_MS) * DAY_MS + DAY_MS);
  const start = new Date(end.getTime() - SERVICE_DAYS * DAY_MS);
  const series = async (metric, aligner) => {
    const params = new URLSearchParams({
      filter: `metric.type="${metric}" AND resource.type="cloud_run_revision"`,
      'interval.startTime': start.toISOString(),
      'interval.endTime': end.toISOString(),
      'aggregation.alignmentPeriod': '86400s',
      'aggregation.perSeriesAligner': aligner,
      'aggregation.crossSeriesReducer': 'REDUCE_SUM',
      'aggregation.groupByFields': 'resource.labels.service_name',
    });
    const answer = await google(env, fetcher, `https://monitoring.googleapis.com/v3/projects/${project}/timeSeries?${params}`);
    return answer.timeSeries || [];
  };
  const [requests, seconds] = await Promise.all([
    series('run.googleapis.com/request_count', 'ALIGN_SUM'),
    series('run.googleapis.com/container/billable_instance_time', 'ALIGN_SUM'),
  ]);
  const out = {};
  const put = (list, field) => {
    for (const one of list) {
      const name = one.resource?.labels?.service_name;
      if (!name) continue;
      out[name] ??= { requests: [], seconds: [] };
      for (const point of one.points || []) {
        // A day's sum ends at the next midnight: the day is the one before it.
        const day = new Date(Date.parse(point.interval?.endTime) - 1).toISOString().slice(0, 10);
        const n = Number(point.value?.int64Value ?? point.value?.doubleValue) || 0;
        out[name][field].push({ day, n });
      }
      out[name][field].sort((a, b) => a.day.localeCompare(b.day));
    }
  };
  put(requests, 'requests');
  put(seconds, 'seconds');
  return out;
}

// ------------------------------------------------------------------ costs

const TABLE = /^[A-Za-z0-9-]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;

/**
 * What the project cost, from the billing export in BigQuery: this month by
 * service, each day, and the charges and credits behind them, newest first.
 * Null without GCP_BILLING_EXPORT_TABLE.
 */
export async function readCosts(env, fetcher = fetch, now = Date.now()) {
  const table = String(env.GCP_BILLING_EXPORT_TABLE || '').trim();
  if (!table) return null;
  if (!TABLE.test(table)) throw new Error('GCP_BILLING_EXPORT_TABLE is not project.dataset.table');
  const project = projectOf(env);
  const month = new Date(now).toISOString().slice(0, 7);
  const since = new Date(now - 90 * DAY_MS).toISOString().slice(0, 10);
  // One row per day, service, SKU and kind of charge; credits are negative, as Google keeps them.
  const query = `
    SELECT FORMAT_DATE('%F', DATE(usage_start_time)) AS day, service.description AS service, sku.description AS sku,
      cost_type AS type, currency, SUM(cost) AS cost,
      SUM(IFNULL((SELECT SUM(credit.amount) FROM UNNEST(credits) AS credit), 0)) AS credits,
      SUM(usage.amount_in_pricing_units) AS amount, ANY_VALUE(usage.pricing_unit) AS unit
    FROM \`${table}\`
    WHERE DATE(usage_start_time) >= '${since}' AND project.id = @project
    GROUP BY day, service, sku, type, currency
    HAVING ROUND(cost, 6) != 0 OR ROUND(credits, 6) != 0
    ORDER BY day DESC, cost DESC`;
  const answer = await google(env, fetcher, `https://bigquery.googleapis.com/bigquery/v2/projects/${table.split('.')[0]}/queries`, {
    method: 'POST',
    body: JSON.stringify({
      query,
      useLegacySql: false,
      timeoutMs: 20_000,
      parameterMode: 'NAMED',
      queryParameters: [{ name: 'project', parameterType: { type: 'STRING' }, parameterValue: { value: project } }],
    }),
  });
  const fields = (answer.schema?.fields || []).map((field) => field.name);
  const rows = (answer.rows || []).map((row) => Object.fromEntries(row.f.map((cell, index) => [fields[index], cell.v])));
  const money = (value) => Math.round((Number(value) || 0) * 100) / 100;
  const charges = rows.map((row) => ({
    day: row.day,
    service: row.service || '—',
    sku: row.sku || '',
    type: row.type || 'regular',
    currency: row.currency || 'USD',
    cost: Number(row.cost) || 0,
    credits: Number(row.credits) || 0,
    amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
    unit: row.unit || '',
  }));
  const byService = new Map();
  const byDay = new Map();
  let cost = 0;
  let credits = 0;
  for (const charge of charges) {
    byDay.set(charge.day, (byDay.get(charge.day) || 0) + charge.cost + charge.credits);
    if (!charge.day.startsWith(month)) continue;
    cost += charge.cost;
    credits += charge.credits;
    const service = byService.get(charge.service) || { service: charge.service, cost: 0, credits: 0 };
    service.cost += charge.cost;
    service.credits += charge.credits;
    byService.set(charge.service, service);
  }
  return {
    month,
    currency: charges[0]?.currency || 'USD',
    cost: money(cost),
    credits: money(credits),
    net: money(cost + credits),
    byService: [...byService.values()]
      .map((service) => ({ service: service.service, cost: money(service.cost), credits: money(service.credits), net: money(service.cost + service.credits) }))
      .sort((a, b) => b.net - a.net),
    days: [...byDay.entries()].map(([day, net]) => ({ day, net: money(net) })).sort((a, b) => a.day.localeCompare(b.day)),
    charges: charges.slice(0, CHARGES_KEPT),
  };
}

// --------------------------------------------------------------- overview

/** Everything the Google Cloud tab shows, each part with its own error. */
export async function gcloudOverview(env, fetcher = fetch, now = Date.now()) {
  if (!gcloudConfigured(env)) return { configured: false };
  const project = projectOf(env);
  const [billing, run, vms, metrics, costs] = await Promise.all([
    settle(() => readBilling(env, fetcher)),
    settle(() => listRun(env, fetcher)),
    settle(() => listVms(env, fetcher)),
    settle(() => readRunMetrics(env, fetcher, now)),
    settle(() => readCosts(env, fetcher, now)),
  ]);
  const usage = metrics.value || {};
  const services = [
    ...(run.value || []).map((service) => {
      const seen = usage[service.name];
      const total = (list) => (list || []).reduce((sum, point) => sum + point.n, 0);
      return { ...service, requests: total(seen?.requests), instanceSeconds: Math.round(total(seen?.seconds)), daily: seen?.requests || [] };
    }),
    ...(vms.value || []),
  ];
  return {
    configured: true,
    project,
    at: now,
    billing: billing.value || { error: billing.error },
    services,
    errors: {
      ...(run.error ? { cloudrun: run.error } : {}),
      ...(vms.error ? { compute: vms.error } : {}),
      ...(metrics.error ? { monitoring: metrics.error } : {}),
    },
    costs: costs.value ?? (costs.error ? { error: costs.error } : null),
  };
}

// ---------------------------------------------------------------- actions

const RUN_ID = /^projects\/([a-z0-9-]+)\/locations\/([a-z0-9-]+)\/services\/([a-z0-9-]+)$/;
const VM_ID = /^projects\/([a-z0-9-]+)\/zones\/([a-z0-9-]+)\/instances\/([a-z0-9-]+)$/;

/**
 * Start or stop one service in the project: `{ kind, id, action }`, with
 * `action` "start" or "stop". Answers `{ ok, status }` — the state it is on
 * its way to — or throws with the reason. Only the project's own services.
 */
export async function gcloudAction(env, { kind, id, action } = {}, fetcher = fetch) {
  if (action !== 'start' && action !== 'stop') throw new Error('start or stop?');
  const project = projectOf(env);
  if (kind === 'cloudrun') {
    const match = RUN_ID.exec(String(id || ''));
    if (!match || match[1] !== project) throw new Error('not a Cloud Run service in this project');
    const url = `https://run.googleapis.com/v2/${id}`;
    const service = await google(env, fetcher, url);
    const ingress = action === 'stop' ? 'INGRESS_TRAFFIC_INTERNAL_ONLY' : 'INGRESS_TRAFFIC_ALL';
    if (service.ingress === ingress) return { ok: true, status: action === 'stop' ? 'stopped' : 'running' };
    await google(env, fetcher, url, { method: 'PATCH', body: JSON.stringify({ ...service, ingress }) });
    return { ok: true, status: action === 'stop' ? 'stopping' : 'starting' };
  }
  if (kind === 'vm') {
    const match = VM_ID.exec(String(id || ''));
    if (!match || match[1] !== project) throw new Error('not a VM in this project');
    await google(env, fetcher, `https://compute.googleapis.com/compute/v1/${id}/${action}`, { method: 'POST' });
    return { ok: true, status: action === 'stop' ? 'stopping' : 'starting' };
  }
  throw new Error('a Cloud Run service or a VM');
}
