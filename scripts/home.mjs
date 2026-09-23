#!/usr/bin/env node
// The proxy at home, reachable from the site: `npm run home`.
//
// Every wall the reader meets from the Cloudflare Worker — a site's check
// for a person, Google Scholar's opinion of a datacenter, a publisher's
// sign-in — waves an ordinary browser on an ordinary connection through.
// This starts the reader's proxy on this machine, with this machine's
// Chromium and this connection, and opens a Cloudflare Tunnel to it so the
// site on GitHub Pages can reach it from anywhere: the address it prints
// goes into Settings → Paper proxy. Only the site's requests to the proxy
// go through the tunnel; what the proxy fetches from publishers leaves
// from here, which is the point.
//
//   npm run home                      # a quick tunnel: a random *.trycloudflare.com address, new each start
//   READER_TUNNEL_TOKEN=… READER_TUNNEL_HOST=proxy.example.org npm run home
//                                     # a named tunnel from your Cloudflare dashboard, at a fixed address
//
// The proxy answers only requests that carry the site's own origin
// (READER_ONLY_FROM_APP=1 in server/api.js), since a tunnel makes it
// reachable by anyone who learns the address; a named tunnel can add
// Cloudflare Access in front as well. `cloudflared` has to be installed
// (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/);
// without it the proxy still starts, reachable from this machine alone.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The tunnel's public address, from a line of cloudflared's output, or null. */
export function tunnelUrlIn(line) {
  return String(line || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i)?.[0] || null;
}

/**
 * How to run cloudflared, from the environment: a named tunnel's token when
 * there is one (its route to this port is set in the dashboard), else a
 * quick tunnel to the proxy's port.
 */
export function tunnelCommand(env, port) {
  const token = (env.READER_TUNNEL_TOKEN || '').trim();
  if (token) return { args: ['tunnel', 'run', '--token', token], host: (env.READER_TUNNEL_HOST || '').trim() || null, named: true };
  return { args: ['tunnel', '--url', `http://localhost:${port}`], host: null, named: false };
}

/** Whether a program is on the PATH: it answers `--version`. */
function available(program) {
  return new Promise((resolve) => {
    const child = spawn(program, ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

async function main() {
  const port = Number(process.env.PORT) || 8080;
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  if (!existsSync(join(root, 'dist', 'index.html'))) {
    console.log('Building the app first (once)…');
    await new Promise((resolve, reject) => {
      const build = spawn(npm, ['run', 'build'], { cwd: root, stdio: 'inherit' });
      build.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`build exited ${code}`))));
    });
  }

  const { browseAvailability } = await import('../server/access.js');
  const browser = await browseAvailability();
  if (!browser.available) {
    console.log(`No browser for the proxy to drive: ${browser.reason}`);
    console.log('PDFs still fetch; the sign-in window, the browser in the pane and Scholar\'s browser mode need one.');
  }

  const env = {
    ...process.env,
    PORT: String(port),
    READER_ONLY_FROM_APP: '1',
    SCHOLAR_BROWSER: process.env.SCHOLAR_BROWSER ?? (browser.available ? '1' : ''),
  };
  const proxy = spawn(process.execPath, [join(root, 'server', 'index.js')], { env, stdio: 'inherit' });
  proxy.on('exit', (code) => {
    console.log(`The proxy stopped (${code}).`);
    process.exit(code || 0);
  });

  const stop = () => {
    proxy.kill();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  if (!(await available('cloudflared'))) {
    console.log('');
    console.log(`The proxy is up at http://localhost:${port}, reachable from this machine only:`);
    console.log('cloudflared is not installed, so there is no tunnel. Install it to reach the proxy from anywhere:');
    console.log('  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
    console.log(`Until then, paste http://localhost:${port} into Settings → Paper proxy on the site, from this machine.`);
    return;
  }

  const tunnel = tunnelCommand(process.env, port);
  const cloudflared = spawn('cloudflared', tunnel.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let announced = false;
  const announce = (url) => {
    if (announced) return;
    announced = true;
    console.log('');
    console.log('The proxy is reachable from anywhere at:');
    console.log('');
    console.log(`    ${url}`);
    console.log('');
    console.log('Paste that into Settings → Paper proxy on the site and press Test it. It answers the site alone.');
    console.log(tunnel.named ? 'The address is yours and stays the same.' : 'A quick tunnel: the address changes each start, so paste it again next time.');
    console.log('Ctrl-C stops both.');
  };
  if (tunnel.named) announce(tunnel.host ? `https://${tunnel.host}` : 'the hostname the tunnel routes to in your Cloudflare dashboard');
  for (const stream of [cloudflared.stdout, cloudflared.stderr]) {
    stream.on('data', (chunk) => {
      const url = tunnelUrlIn(String(chunk));
      if (url) announce(url);
    });
  }
  cloudflared.on('exit', (code) => {
    if (!announced) console.log(`cloudflared exited (${code}) before announcing an address; the proxy is still up at http://localhost:${port}.`);
  });
  process.on('exit', () => cloudflared.kill());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(String(error?.message || error));
    process.exit(1);
  });
}
