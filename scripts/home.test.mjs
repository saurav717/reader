// The proxy at home, reachable from the site: how the tunnel's address is
// read and how cloudflared is told what to do.
//
//   node --test scripts/home.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { tunnelCommand, tunnelUrlIn } = await import('./home.mjs');

describe('the tunnel to the proxy at home', () => {
  it("reads the quick tunnel's address out of cloudflared's chatter", () => {
    assert.equal(
      tunnelUrlIn('2026-09-23T10:00:00Z INF |  https://quiet-otter-halt-bare.trycloudflare.com                                       |'),
      'https://quiet-otter-halt-bare.trycloudflare.com',
    );
    assert.equal(tunnelUrlIn('INF Requesting new quick Tunnel on trycloudflare.com...'), null);
    assert.equal(tunnelUrlIn(''), null);
  });

  it('runs a named tunnel by its token when there is one, else a quick tunnel to the port', () => {
    assert.deepEqual(tunnelCommand({}, 8080), { args: ['tunnel', '--url', 'http://localhost:8080'], host: null, named: false });
    assert.deepEqual(tunnelCommand({ READER_TUNNEL_TOKEN: ' abc ', READER_TUNNEL_HOST: 'proxy.example.org' }, 8080), {
      args: ['tunnel', 'run', '--token', 'abc'],
      host: 'proxy.example.org',
      named: true,
    });
    assert.equal(tunnelCommand({ READER_TUNNEL_TOKEN: 'abc' }, 8080).host, null);
  });
});

import { spawn } from 'node:child_process';

describe('the proxy started for a public address', () => {
  it('answers the site alone: a request without its origin is refused, one with it is not', async () => {
    // The gate is read when the proxy starts, so it is started afresh, in a process of its own.
    const script = `
      import { createServer } from 'node:http';
      const { default: apiRouter } = await import('./server/api.js');
      const server = createServer((req, res) => apiRouter(req, res));
      await new Promise((resolve) => server.listen(0, resolve));
      const base = 'http://localhost:' + server.address().port;
      const bare = await fetch(base + '/health');
      const fromSite = await fetch(base + '/health', { headers: { Origin: 'https://saurav717.github.io' } });
      const fromElsewhere = await fetch(base + '/health', { headers: { Origin: 'https://evil.example' } });
      const preflight = await fetch(base + '/health', { method: 'OPTIONS', headers: { Origin: 'https://saurav717.github.io' } });
      console.log(JSON.stringify([bare.status, fromSite.status, fromElsewhere.status, preflight.status]));
      server.close();
    `;
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, READER_ONLY_FROM_APP: '1', READER_PROFILE_DIR: '/nonexistent/reader-profile' },
        cwd: new URL('..', import.meta.url).pathname,
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (err += chunk));
      child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `exited ${code}`))));
    });
    assert.deepEqual(JSON.parse(output.trim().split('\n').pop()), [403, 200, 403, 204]);
  });
});
