/**
 * Who may ask this proxy for what — the Node side of it.
 *
 * Most of what the proxy does is harmless to hand to anyone: fetching an
 * arXiv listing, or a public PDF. Some of it is not. The sign-in and the
 * browser inside the reader drive a Chromium with somebody's institutional
 * session in it, on the machine the proxy runs on; a fetch through that
 * session reads with that person's subscriptions; SerpApi is metered on a
 * key the proxy holds. A proxy that reaches past this machine — pointed at
 * from the site on GitHub Pages, say, or on Vercel — needs to know that the
 * one asking is the person who set it up, and the way it knows is a token:
 * `READER_TOKEN` on the server, pasted into Settings → Paper proxy in the
 * app, sent as `Authorization: Bearer …` with every request.
 *
 * Without a token the proxy is for this machine only — server/index.js binds
 * to loopback and refuses to do otherwise — so the routes above stay open to
 * whoever can reach it, which is whoever is sitting at it. Vercel has no
 * loopback to hide behind, so there a missing token closes those routes.
 *
 * The rest of this file is the other two things a proxy on the open
 * internet needs: a check that the name a URL carries does not resolve to
 * somewhere inside (server/fetchPdf.js checks the name itself; this asks DNS
 * what it means), and a small rate limit on the routes that cost something,
 * so one page cannot burn a machine's bandwidth or a SerpApi quota through
 * it. Node only — `node:dns`, `node:crypto` — which is why none of it lives
 * in the files the Worker shares.
 */
import { timingSafeEqual } from 'node:crypto';
import dns from 'node:dns';
import { isPrivateIPv4, isPrivateIPv6 } from './fetchPdf.js';

// ---------------------------------------------------------------- token ----

/** The token this proxy wants, or an empty string for none. */
const configuredToken = () => (process.env.READER_TOKEN || '').trim();

/**
 * Whether the gated routes want a token. Yes when one is set; yes on Vercel
 * whatever is set, since a serverless function is reachable by anyone and
 * has no loopback-only mode to fall back to; no otherwise, which is the
 * proxy on this machine, listening on this machine alone.
 */
export function tokenRequired() {
  return Boolean(configuredToken()) || Boolean(process.env.VERCEL);
}

/**
 * Whether the request carries the token. Compared in constant time, the way
 * secrets are compared: a comparison that stops at the first wrong byte
 * tells a patient caller how many bytes were right.
 */
export function validToken(req) {
  const wanted = configuredToken();
  if (!wanted) return false;
  const header = String(req.headers?.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const given = Buffer.from(match[1].trim(), 'utf8');
  const expected = Buffer.from(wanted, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Why a request may not use a gated route, worded for the person, or null
 * when it may: no token wanted, or the right one given. The Vercel case is
 * worded for whoever deployed it, since nothing they paste in Settings will
 * help until the server has a token to compare against.
 */
export function tokenRefusal(req) {
  if (!tokenRequired()) return null;
  if (!configuredToken()) return 'this deployment has no READER_TOKEN set, so its sign-in and browser routes are off';
  if (validToken(req)) return null;
  return 'this proxy needs its token — Settings → Paper proxy';
}

/**
 * Whether a Host header names this machine: `localhost`, `127.0.0.1` or
 * `[::1]`, with or without a port. A request with no Origin header from one
 * of these is a tool on this machine — curl, a script — rather than a page.
 */
export function loopbackHost(host) {
  const value = String(host || '').trim().toLowerCase();
  return /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(value);
}

// ------------------------------------------------------------------ DNS ----

/** What resolves names. Swapped out by the tests, which have no network to ask. */
let lookup = (host) => dns.promises.lookup(host, { all: true });

/** Hand in another resolver — the tests do — or nothing to put the real one back. */
export function setLookup(fn) {
  lookup = fn || ((host) => dns.promises.lookup(host, { all: true }));
}

/** How long an answer about a host is kept: long enough to cover the redirects and links of one fetch. */
const DNS_CACHE_MS = 60_000;
const dnsCache = new Map();

/** Whether an address DNS gave back is one the hostname rules would have refused. */
function privateAddress(address) {
  return address.includes(':') ? isPrivateIPv6(address) : isPrivateIPv4(address);
}

/**
 * Whether a hostname resolves to somewhere that is not the public internet.
 * A name is just a name: `evil.example` can point at 127.0.0.1 or at the
 * cloud's metadata address as easily as at a server, and the checks on the
 * name in server/fetchPdf.js cannot see that. This asks DNS, and says yes
 * if any of the answers is private — any, because which one a connection
 * ends up using is not ours to pick. A name that will not resolve at all
 * counts as private too: there is nothing safe to be done with it, and the
 * fetch would only fail more slowly. An address literal is answered from
 * the rules alone, and answers are kept for a minute per host, since one
 * PDF fetch asks about the same host several times over.
 */
export async function resolvesPrivately(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.+$/, '');
  if (!host) return true;
  const literal = host.replace(/^\[|\]$/g, '');
  if (/^[\d.]+$/.test(literal) || literal.includes(':')) return privateAddress(literal);
  const cached = dnsCache.get(host);
  if (cached && cached.until > Date.now()) return cached.answer;
  let answer;
  try {
    const addresses = await lookup(host);
    const list = Array.isArray(addresses) ? addresses : [addresses];
    answer = !list.length || list.some((entry) => privateAddress(String(entry?.address ?? entry)));
  } catch {
    answer = true;
  }
  dnsCache.set(host, { answer, until: Date.now() + DNS_CACHE_MS });
  if (dnsCache.size > 1000) {
    for (const [key, entry] of dnsCache) if (entry.until <= Date.now()) dnsCache.delete(key);
  }
  return answer;
}

/** The DNS test in the shape `fetchChecked` takes: a reason for the person, or null. */
export async function privateReason(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return 'that is not a URL';
  }
  return (await resolvesPrivately(host)) ? 'that host is not reachable from here' : null;
}

// ----------------------------------------------------------- rate limit ----

/**
 * Requests a minute, per client address, for the routes that cost something
 * — bandwidth on a PDF, a browser launch, a SerpApi search. Small numbers:
 * a person reading papers asks for one at a time, and anything asking
 * faster is not a person. A request with the token is not counted, since
 * the token already says who it is.
 */
const DEFAULT_LIMITS = { pdf: 30, scholar: 20, browse: 10 };
let limits = { ...DEFAULT_LIMITS };
const buckets = new Map();

/** Change the limits — the tests do, to hit one — or put the defaults back with nothing. */
export function setRateLimits(overrides) {
  limits = { ...DEFAULT_LIMITS, ...(overrides || {}) };
}

/** Forget every client's bucket; the tests call it between runs. */
export function resetRateLimits() {
  buckets.clear();
}

/**
 * Who is asking, as an address. The socket's, unless the proxy has been
 * told it sits behind another one (`TRUST_PROXY`), in which case the first
 * entry of X-Forwarded-For — the one the nearest trusted proxy wrote — is
 * the client. Trusting that header without being told to would let anyone
 * pick their own bucket by setting it.
 */
export function clientAddress(req) {
  if (process.env.TRUST_PROXY) {
    const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Take one request from a client's bucket for a kind of route. Null when
 * there was one to take; otherwise the seconds until there will be, for
 * Retry-After. A token bucket: `limit` tokens, refilled at `limit` a minute,
 * so a short burst goes through and a steady stream is held to the rate.
 */
export function rateLimit(req, kind) {
  const limit = limits[kind];
  if (!limit || validToken(req)) return null;
  const key = `${kind}:${clientAddress(req)}`;
  const now = Date.now();
  const perMs = limit / 60_000;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: limit, at: now };
    buckets.set(key, bucket);
  }
  bucket.tokens = Math.min(limit, bucket.tokens + (now - bucket.at) * perMs);
  bucket.at = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return null;
  }
  if (buckets.size > 10_000) {
    // A quiet proxy forgets: a full bucket is the same as no bucket.
    for (const [other, entry] of buckets) if (entry.tokens >= limit - 1 && other !== key) buckets.delete(other);
  }
  return Math.max(1, Math.ceil((1 - bucket.tokens) / perMs / 1000));
}
