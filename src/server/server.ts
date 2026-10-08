// ---------------------------------------------------------------------------
// server.ts: the internet-facing part.
//   1. Serves the web page files in /public to anyone who visits.
//   2. Keeps a live "WebSocket" connection open to every player's browser, so a move
//      made by one person appears on everyone's screen immediately.
// It does no game logic itself: it passes each message to the RoomManager and then
// sends every player their own personal view of the result.
// ---------------------------------------------------------------------------
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { BadMessage, parseClientMessage, type ClientMessage, type ServerMessage } from './protocol';
import { RoomError, RoomManager, type Room } from './rooms';
import type { Store } from './store';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

interface Session {
  ws: WebSocket;
  code?: string;
  token?: string;
  alive: boolean;
}

export interface AppServer {
  server: Server;
  port: number;
  manager: RoomManager;
  close(): Promise<void>;
}

export async function startServer(opts: {
  port: number;
  store: Store;
  publicDir: string;
  rng?: () => number;
  /** How long a computer player "thinks" before moving, so humans can follow the game (default 1 second). */
  botDelayMs?: number;
}): Promise<AppServer> {
  const manager = new RoomManager(opts.store, opts.rng);
  const publicDir = resolve(opts.publicDir);

  // --- the web page files ---
  async function serveFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    let rel = normalize(decodeURIComponent(url.pathname));
    if (rel === sep || rel === '/') rel = '/index.html';
    const file = join(publicDir, rel);
    // Never serve anything outside the public folder.
    if (!file.startsWith(publicDir + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  }

  const server = createServer((req, res) => {
    serveFile(req, res).catch(() => res.writeHead(500).end('Server error'));
  });
  const wss = new WebSocketServer({ server, maxPayload: 10_000 });

  // --- who is connected where ---
  const sockets = new Map<string, Map<string, Set<Session>>>(); // room code -> token -> sessions
  const allSessions = new Set<Session>();

  function attach(s: Session, code: string, token: string): void {
    detach(s);
    s.code = code;
    s.token = token;
    const room = sockets.get(code) ?? new Map<string, Set<Session>>();
    sockets.set(code, room);
    const set = room.get(token) ?? new Set<Session>();
    room.set(token, set);
    set.add(s);
  }

  /** Remove a connection. Returns true if that player now has no connection left. */
  function detach(s: Session): boolean {
    if (!s.code || !s.token) return false;
    const set = sockets.get(s.code)?.get(s.token);
    set?.delete(s);
    const gone = !set || set.size === 0;
    if (gone) sockets.get(s.code)?.delete(s.token);
    s.code = undefined;
    s.token = undefined;
    return gone;
  }

  function send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  // --- computer players take their turns on a timer, one move at a time ---
  const botTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const botDelay = opts.botDelayMs ?? 1000;

  function scheduleBots(code: string): void {
    if (botTimers.has(code) || !manager.botToAct(code)) return;
    const round = manager.getRoom(code)?.game?.round;
    // Linger a little longer right after a trick finishes, so people can see it.
    const justFinishedTrick = round?.phase === 'play' && round.trick.plays.length === 0 && round.trickNumber > 0;
    const delay = botDelay === 0 ? 0 : justFinishedTrick ? botDelay * 2 : botDelay;
    botTimers.set(code, setTimeout(() => {
      botTimers.delete(code);
      const room = manager.botTurn(code);
      if (room) broadcast(room);
    }, delay));
  }

  /** Send each connected player in the room THEIR OWN view. */
  function broadcast(room: Room): void {
    scheduleBots(room.code);
    for (const player of room.players) {
      const sessions = sockets.get(room.code)?.get(player.token);
      if (!sessions) continue;
      const update: ServerMessage = { t: 'update', room: manager.info(room, player), view: manager.view(room, player) };
      for (const s of sessions) send(s.ws, update);
    }
  }

  function handle(s: Session, msg: ClientMessage): void {
    if (msg.t === 'create' || msg.t === 'join') {
      const { room, player } =
        msg.t === 'create' ? manager.create(msg.name) : manager.join(msg.code, msg.name, msg.token);
      attach(s, room.code, player.token);
      player.connected = true;
      send(s.ws, { t: 'joined', code: room.code, token: player.token });
      broadcast(room);
      return;
    }
    if (!s.code || !s.token) throw new RoomError('Join a room first');
    let room: Room;
    switch (msg.t) {
      case 'sit': room = manager.sit(s.code, s.token, msg.seat); break;
      case 'start': room = manager.start(s.code, s.token); break;
      case 'action': room = manager.act(s.code, s.token, msg.action); break;
      case 'next_round': room = manager.nextRound(s.code, s.token); break;
      case 'new_game': room = manager.newGame(s.code, s.token); break;
      case 'add_bot': room = manager.addBot(s.code, s.token, msg.seat); break;
      case 'remove_bot': room = manager.removeBot(s.code, s.token, msg.seat); break;
      case 'ping': return;
    }
    broadcast(room);
  }

  wss.on('connection', (ws) => {
    const session: Session = { ws, alive: true };
    allSessions.add(session);
    ws.on('pong', () => (session.alive = true));
    ws.on('message', (raw) => {
      try {
        handle(session, parseClientMessage(raw.toString()));
      } catch (e) {
        if (e instanceof RoomError || e instanceof BadMessage) send(ws, { t: 'error', message: e.message });
        else {
          console.error(e);
          send(ws, { t: 'error', message: 'Something went wrong on the server' });
        }
      }
    });
    ws.on('close', () => {
      allSessions.delete(session);
      const { code, token } = session;
      if (detach(session) && code && token) {
        const room = manager.setConnected(code, token, false);
        if (room) broadcast(room);
      }
    });
  });

  // Every 30 seconds, check each connection is still alive; drop the dead ones.
  const heartbeat = setInterval(() => {
    for (const s of allSessions) {
      if (!s.alive) { s.ws.terminate(); continue; }
      s.alive = false;
      s.ws.ping();
    }
  }, 30_000);

  // After a restart, a computer player might be the one to move in a saved game.
  for (const code of manager.codes()) scheduleBots(code);

  await new Promise<void>((ok) => server.listen(opts.port, ok));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;

  return {
    server,
    port,
    manager,
    close: () =>
      new Promise<void>((ok) => {
        clearInterval(heartbeat);
        for (const t of botTimers.values()) clearTimeout(t);
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => server.close(() => ok()));
      }),
  };
}
