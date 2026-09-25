// Fetching a PDF from a host we do not control, safely.
//
// arXiv is one host with one URL shape; open-access PDFs are anything OpenAlex
// or Semantic Scholar happens to point at — a publisher, a repository, a
// university server. That makes this route the one place in the app that
// fetches an attacker-influenceable URL, so it is narrow on purpose:
//
//   - https only, and never at a private, loopback or link-local address;
//   - every redirect hop re-checked, so a public URL cannot bounce us inside;
//   - the body has to actually be a PDF, which stops the route being a general
//     -purpose proxy for anything else on the internet;
//   - a size cap, so one bad link cannot exhaust the process.
//
// The Workers copy in worker/index.js imports this same file.

export const MAX_PDF_BYTES = 64 * 1024 * 1024;
const MAX_HOPS = 5;
/** How long one upstream request may take before it is given up on. */
export const FETCH_TIMEOUT_MS = 30_000;

/**
 * An error whose message was written for the person reading, and may be
 * shown to them as it is. Everything else that is thrown — a DNS failure,
 * a TLS complaint, a library's call log — is for the server's log only;
 * server/api.js tells the two apart by this mark.
 */
export function worded(message) {
  return Object.assign(new Error(message), { forPerson: true });
}

/** Reserved IPv4 space, as [first octet, mask, value] tests over the octets. */
export function isPrivateIPv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b] = octets;
  return (
    a === 0 || // this network
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 198 && b >= 18 && b <= 19) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

/**
 * The IPv4 address an IPv6 one carries, when it is one of the forms that
 * carry one: IPv4-mapped (`::ffff:127.0.0.1`, which Node also writes in hex
 * as `::ffff:7f00:1`) and NAT64 (`64:ff9b::a9fe:a9fe`). Null otherwise.
 * Both are how a public-looking IPv6 literal ends up connecting to this
 * machine or the cloud's metadata service, so the IPv4 rules apply to them.
 */
export function embeddedIPv4(address) {
  const lower = address.toLowerCase();
  const prefixes = ['::ffff:', '64:ff9b::'];
  for (const prefix of prefixes) {
    if (!lower.startsWith(prefix)) continue;
    const rest = lower.slice(prefix.length);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return rest;
    // Two hex groups, `7f00:1`, are the same four octets written as a number.
    const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const high = parseInt(hex[1], 16);
      const low = parseInt(hex[2], 16);
      return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
    }
  }
  return null;
}

/** Whether an IPv6 address is a private, loopback, link-local or site-local one, or wraps an IPv4 one that is. */
export function isPrivateIPv6(host) {
  const address = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (address === '::1' || address === '::') return true;
  const inner = embeddedIPv4(address);
  if (inner) return isPrivateIPv4(inner);
  // Unique-local (fc00::/7), link-local (fe80::/10) and the deprecated
  // site-local range (fec0::/10), which some networks still route inside.
  return /^f[cd]/.test(address) || /^fe[89ab]/.test(address) || /^fec/.test(address);
}

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/**
 * Whether a hostname names something that is not on the public internet —
 * this machine, the network it is on, a cloud's metadata service. The same
 * test `rejectUrl` applies, on its own for the browser session in
 * server/browse.js, which follows links a person clicks rather than URLs an
 * index handed over and so cannot check the whole URL up front.
 */
export function isPrivateHost(hostname) {
  // A trailing dot is the fully-qualified spelling of the same name —
  // `localhost.` resolves exactly as `localhost` does — so it is dropped
  // before anything is compared, or the suffix checks would miss it.
  const host = (hostname || '').toLowerCase().replace(/\.+$/, '');
  if (!host) return true;
  if (host === 'localhost' || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  return isPrivateIPv4(host) || isPrivateIPv6(host);
}

/**
 * Why this URL may not be fetched, or null if it may. Hostnames are all we can
 * check without resolving ourselves; a name that resolves to a private address
 * still gets through, which is why the PDF check below matters as much.
 */
export function rejectUrl(target) {
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return 'that is not a URL';
  }
  if (parsed.protocol !== 'https:') return 'only https URLs are fetched';
  const host = parsed.hostname.toLowerCase();
  if (!host) return 'that URL has no host';
  if (isPrivateHost(host)) return 'that host is not reachable from here';
  return null;
}

/**
 * fetch(), but following redirects by hand so every hop is checked. Returns the
 * final response, or throws with a message meant for the person reading.
 * `check`, when given, is asked about every hop as well — the Node proxy
 * hands in the DNS test from server/guard.js there, which the hostname rules
 * alone cannot do — and answers a reason, or nothing. Each hop gets its own
 * deadline, so a host that accepts the connection and never answers cannot
 * hold the request open indefinitely.
 */
export async function fetchChecked(target, { userAgent, headers = {}, check, timeoutMs = FETCH_TIMEOUT_MS }) {
  let current = target;
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    const reason = rejectUrl(current) || (check ? await check(current) : null);
    if (reason) throw worded(reason);
    const response = await fetch(current, {
      headers: { 'User-Agent': userAgent, Accept: 'application/pdf,*/*', ...headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: current };
    const location = response.headers.get('location');
    if (!location) return { response, url: current };
    current = new URL(location, current).toString();
  }
  throw worded('that link redirects too many times');
}

/** The body, if it is a PDF and within the cap. Throws with a reason if not. */
export async function readPdf(response, contentType) {
  const declared = (contentType || '').toLowerCase();
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_PDF_BYTES) throw worded('that PDF is too large to fetch');

  const chunks = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (!reader) throw worded('the server sent no PDF');
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_PDF_BYTES) {
      await reader.cancel();
      throw worded('that PDF is too large to fetch');
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }

  // A landing page served where a PDF was promised is the common failure: the
  // publisher wants a session, or the link has rotted. Say which it was.
  const magic = String.fromCharCode(...bytes.slice(0, 5));
  if (!magic.startsWith('%PDF') && !declared.includes('pdf')) {
    throw worded('that link gave a web page rather than a PDF');
  }
  return bytes;
}

/** A Content-Disposition value: `download=1` saves, anything else displays. */
export function disposition(params) {
  const wanted = (params.get('name') || '').replace(/[\r\n"\\]/g, '').trim();
  const stem = (wanted || 'paper').replace(/\.pdf$/i, '').slice(0, 120);
  const kind = params.get('download') === '1' ? 'attachment' : 'inline';
  return `${kind}; filename="${stem}.pdf"; filename*=UTF-8''${encodeURIComponent(`${stem}.pdf`)}`;
}
