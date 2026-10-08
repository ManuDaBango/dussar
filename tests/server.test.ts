import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { seededRng } from '../src/cards';
import type { Action } from '../src/types';
import { RoomError, RoomManager } from '../src/server/rooms';
import type { ClientMessage, ServerMessage } from '../src/server/protocol';
import { startServer, type AppServer } from '../src/server/server';
import { MemoryStore, SqliteStore } from '../src/server/store';

/** A fake player: connects to the server like a browser would. */
class Client {
  ws!: WebSocket;
  inbox: ServerMessage[] = [];
  token = '';
  code = '';
  static async connect(port: number): Promise<Client> {
    const c = new Client();
    c.ws = new WebSocket(`ws://localhost:${port}`);
    c.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as ServerMessage;
      c.inbox.push(m);
      if (m.t === 'joined') { c.token = m.token; c.code = m.code; }
    });
    await new Promise((ok, bad) => { c.ws.once('open', ok); c.ws.once('error', bad); });
    return c;
  }
  send(m: ClientMessage) { this.ws.send(JSON.stringify(m)); }
  async until(test: (m: ServerMessage) => boolean): Promise<ServerMessage> {
    for (let i = 0; i < 400; i++) {
      const found = [...this.inbox].reverse().find((m) => test(m));
      if (found) return found;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('timed out waiting for message; last: ' + JSON.stringify(this.inbox.at(-1))?.slice(0, 300));
  }
  /** wait for the next update AFTER now */
  async nextUpdate() {
    const n = this.inbox.length;
    for (let i = 0; i < 400; i++) {
      const m = this.inbox.slice(n).find((x) => x.t === 'update');
      if (m && m.t === 'update') return m;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('no update');
  }
  latest() {
    const m = [...this.inbox].reverse().find((x) => x.t === 'update');
    return m && m.t === 'update' ? m : undefined;
  }
  close() { this.ws.close(); }
}

let app: AppServer | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function startApp(store = new MemoryStore(), seed = 1) {
  app = await startServer({ port: 0, store, publicDir: 'public', rng: seededRng(seed) });
  return app;
}

async function fourPlayers(port: number) {
  const host = await Client.connect(port);
  host.send({ t: 'create', name: 'Asha' });
  await host.until((m) => m.t === 'joined');
  const others: Client[] = [];
  for (const name of ['Ben', 'Chitra', 'Dev']) {
    const c = await Client.connect(port);
    c.send({ t: 'join', code: host.code, name });
    await c.until((m) => m.t === 'joined');
    others.push(c);
  }
  return [host, ...others];
}

describe('rooms', () => {
  it('lets four players in, rejects a fifth, and lets players move seats in the lobby', () => {
    const m = new RoomManager(new MemoryStore(), seededRng(3));
    const { room, player: a } = m.create('Asha');
    const b = m.join(room.code, 'Ben').player;
    const c = m.join(room.code, 'Chitra').player;
    const d = m.join(room.code, 'Dev').player;
    expect([a.seat, b.seat, c.seat, d.seat]).toEqual([0, 1, 2, 3]);
    expect(() => m.join(room.code, 'Eve')).toThrow(RoomError);
    expect(() => m.sit(room.code, a.token, 1)).toThrow(/taken/);
    expect(() => m.start('XXXX', a.token)).toThrow(RoomError);
    expect(m.join(room.code.toLowerCase(), 'x', b.token).player.seat).toBe(1); // rejoin with token, any case
  });

  it('needs four players to start, and then strangers cannot join', () => {
    const m = new RoomManager(new MemoryStore(), seededRng(4));
    const { room, player: a } = m.create('Asha');
    expect(() => m.start(room.code, a.token)).toThrow(/four/);
    for (const n of ['B', 'C', 'D']) m.join(room.code, n);
    m.start(room.code, a.token);
    expect(() => m.join(room.code, 'Late')).toThrow(/started/);
    expect(() => m.start(room.code, a.token)).toThrow(/already/);
  });

  it('saves games to disk and restores them after a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dussar-'));
    try {
      const path = join(dir, 'test.db');
      const store1 = new SqliteStore(path);
      const m1 = new RoomManager(store1, seededRng(5));
      const { room, player: a } = m1.create('Asha');
      const tokens = [a.token];
      for (const n of ['B', 'C', 'D']) tokens.push(m1.join(room.code, n).player.token);
      m1.start(room.code, a.token);
      const seat = room.game!.round.turn;
      const who = room.players.find((p) => p.seat === seat)!;
      m1.act(room.code, who.token, { type: 'pass' });
      const before = JSON.stringify(room.game);
      store1.close();

      const m2 = new RoomManager(new SqliteStore(path));
      const restored = m2.join(room.code, 'x', tokens[1]).room;
      expect(JSON.stringify(restored.game)).toBe(before);
      expect(restored.players.map((p) => p.name)).toEqual(['Asha', 'B', 'C', 'D']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('live games over WebSockets', () => {
  it('serves the web page', async () => {
    const a = await startApp();
    const res = await fetch(`http://localhost:${a.port}/healthz`);
    expect(await res.text()).toBe('ok');
    const bad = await fetch(`http://localhost:${a.port}/..%2fpackage.json`);
    expect([403, 404]).toContain(bad.status);
  });

  it('rejects garbage and moves from people who are not in a room', async () => {
    const a = await startApp();
    const c = await Client.connect(a.port);
    c.ws.send('not json');
    expect((await c.until((m) => m.t === 'error')).t).toBe('error');
    c.send({ t: 'start' });
    const err = await c.until((m) => m.t === 'error' && /Join a room/.test(m.message));
    expect(err.t).toBe('error');
    c.ws.send(JSON.stringify({ t: 'action', action: { type: 'play', card: { suit: 'X', rank: 99 } } }));
    await c.until((m) => m.t === 'error' && /Bad card/.test(m.message));
    c.close();
  });

  it('four players play a whole round with random legal moves, and nobody ever sees another hand or token', async () => {
    const a = await startApp(new MemoryStore(), 9);
    const players = await fourPlayers(a.port);
    players[0]!.send({ t: 'start' });
    await Promise.all(players.map((p) => p.until((m) => m.t === 'update' && m.room.started)));

    const rng = seededRng(77);
    let guard = 0;
    while (guard++ < 3000) {
      const views = players.map((p) => p.latest()!.view!);
      if (views[0]!.phase === 'round_over' || views[0]!.phase === 'game_over') break;
      const i = views.findIndex((v) => v.turn === v.seat && v.legalActions.length > 0);
      const actions = views[i]!.legalActions as Action[];
      const pick = actions[Math.floor(rng() * actions.length)]!;
      const before = players.map((p) => p.inbox.length);
      players[i]!.send({ t: 'action', action: pick });
      await Promise.all(players.map((p, k) => (async () => {
        for (let t = 0; t < 400 && p.inbox.length === before[k]!; t++) await new Promise((r) => setTimeout(r, 5));
      })()));
    }
    const finalViews = players.map((p) => p.latest()!.view!);
    expect(['round_over', 'game_over']).toContain(finalViews[0]!.phase);
    expect(finalViews[0]!.outcome).not.toBeNull();

    // privacy checks over EVERYTHING each player ever received
    players.forEach((p, i) => {
      const everything = p.inbox.map((m) => JSON.stringify(m)).join('\n');
      players.forEach((q, j) => { if (i !== j) expect(everything.includes(q.token)).toBe(false); });
      for (const m of p.inbox) {
        if (m.t === 'update' && m.view) {
          expect('hands' in m.view).toBe(false);
          expect('stock' in m.view).toBe(false);
          expect(m.view.seat).toBe(i);
          expect(m.view.hand.length).toBe(m.view.handCounts[i]);
        }
      }
    });
    players.forEach((p) => p.close());
  });

  it('a player who disconnects can rejoin with their token and gets the same seat', async () => {
    const a = await startApp(new MemoryStore(), 12);
    const players = await fourPlayers(a.port);
    const c2 = players[2]!;
    const token = c2.token;
    c2.close();
    await players[0]!.until((m) => m.t === 'update' && m.room.seats[2]?.connected === false);
    const back = await Client.connect(a.port);
    back.send({ t: 'join', code: c2.code, name: 'ignored', token });
    const upd = await back.until((m) => m.t === 'update');
    expect(upd.t === 'update' && upd.room.youSeat).toBe(2);
    await players[0]!.until((m) => m.t === 'update' && m.room.seats[2]?.connected === true);
    [players[0]!, players[1]!, players[3]!, back].forEach((p) => p.close());
  });
});
