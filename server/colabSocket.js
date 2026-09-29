/**
 * The kernel's WebSocket, carried by the Node proxy — see the bridge notes
 * in server/colab.js. `ws` does the framing on the page's side; Node's own
 * WebSocket client is not yet a server. Nothing in the frames is read: a
 * ticket lets a socket in, the first frame names the runtime's token, and
 * from then on every frame goes through as it came.
 *
 * The secret the tickets are signed with is READER_TOKEN when there is
 * one — the same gate as the rest of what acts for a person — and a secret
 * of this process's own otherwise, for the proxy that listens on this
 * machine alone.
 */
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { closeCode, readHello, readSocketTicket, upstreamSocket } from './colab.js';

const OWN_SECRET = randomUUID();

/** The secret the Node proxy signs socket tickets with. */
export const socketSecret = () => (process.env.READER_TOKEN || '').trim() || OWN_SECRET;

const refuse = (socket, status, text) => {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${text}`);
  socket.destroy();
};

/** One page's socket, piped to one kernel's once the page has said hello. */
export function bridge(client, ticket, { dial = (href, headers) => new WebSocket(href, { headers }) } = {}) {
  let upstream = null;
  let dialing = false;
  const queued = [];
  const closeClient = (code, reason) => {
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(closeCode(code), String(reason || '').slice(0, 120));
  };
  client.on('message', (data, isBinary) => {
    if (upstream && upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
      return;
    }
    if (dialing) {
      queued.push([data, isBinary]);
      return;
    }
    const token = readHello(isBinary ? '' : data.toString());
    if (!token) {
      closeClient(1008, 'hello first: the runtime token');
      return;
    }
    dialing = true;
    let socket;
    try {
      const { href, headers } = upstreamSocket({ ...ticket, token });
      socket = dial(href, headers);
    } catch {
      closeClient(1011, 'that is not a Colab runtime');
      return;
    }
    socket.on('open', () => {
      upstream = socket;
      dialing = false;
      client.send(JSON.stringify({ type: 'ready' }));
      for (const [frame, binary] of queued.splice(0)) socket.send(frame, { binary });
    });
    socket.on('message', (frame, binary) => {
      if (client.readyState === WebSocket.OPEN) client.send(frame, { binary });
    });
    socket.on('close', (code, reason) => closeClient(code, reason.toString()));
    socket.on('error', () => closeClient(1011, 'could not reach the runtime'));
    socket.on('unexpected-response', (_req, res) => closeClient(1011, `the runtime answered ${res.statusCode}`));
  });
  client.on('close', () => upstream?.close(1000));
  client.on('error', () => upstream?.close(1011));
}

/**
 * Takes the /colab/socket upgrades off an http server. Anything else that
 * asks to upgrade is refused: the Node proxy has no other socket.
 */
export function attachColabSocket(server, { fromThisApp, secret = socketSecret } = {}) {
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://proxy');
    const path = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';
    if (path !== '/colab/socket') return refuse(socket, 404, 'no such socket');
    if (fromThisApp && !fromThisApp(req)) return refuse(socket, 403, 'not from this app');
    const ticket = await readSocketTicket(secret(), url.searchParams.get('ticket'));
    if (!ticket) return refuse(socket, 401, 'a ticket from /colab/socket/ticket, still fresh');
    sockets.handleUpgrade(req, socket, head, (client) => bridge(client, ticket));
  });
  return sockets;
}
