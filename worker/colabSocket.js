/**
 * The kernel's WebSocket, carried by the Worker — see the bridge notes in
 * server/colab.js. A WebSocketPair for the page's side; a fetch with
 * `Upgrade: websocket` for the runtime's, the way a Worker opens one
 * (worker/browserless.js does the same). Nothing in the frames is read:
 * the first names the runtime's token, and every one after goes through
 * as it came.
 */
import { closeCode, readHello, upstreamSocket } from '../server/colab.js';

export function bridgeSocket(ticket, doFetch = globalThis.fetch) {
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  let upstream = null;
  let dialing = false;
  const queued = [];
  const closeServer = (code, reason) => {
    try {
      server.close(closeCode(code), String(reason || '').slice(0, 120));
    } catch {
      // already closed
    }
  };
  server.addEventListener('message', async (event) => {
    if (upstream) {
      upstream.send(event.data);
      return;
    }
    if (dialing) {
      queued.push(event.data);
      return;
    }
    const token = readHello(event.data);
    if (!token) {
      closeServer(1008, 'hello first: the runtime token');
      return;
    }
    dialing = true;
    const { href, headers } = upstreamSocket({ ...ticket, token });
    try {
      const response = await doFetch(href.replace(/^wss:/, 'https:'), { headers: { Upgrade: 'websocket', ...headers } });
      const socket = response.webSocket;
      if (!socket) {
        closeServer(1011, `the runtime answered ${response.status}`);
        return;
      }
      socket.accept();
      socket.addEventListener('message', (incoming) => {
        try {
          server.send(incoming.data);
        } catch {
          socket.close(1000);
        }
      });
      socket.addEventListener('close', (closed) => closeServer(closed.code, closed.reason));
      socket.addEventListener('error', () => closeServer(1011, 'the runtime dropped the connection'));
      upstream = socket;
      dialing = false;
      server.send(JSON.stringify({ type: 'ready' }));
      for (const frame of queued.splice(0)) socket.send(frame);
    } catch {
      closeServer(1011, 'could not reach the runtime');
    }
  });
  server.addEventListener('close', () => upstream?.close(1000));
  server.addEventListener('error', () => upstream?.close(1011));
  return new Response(null, { status: 101, webSocket: client });
}
