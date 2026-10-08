// ---------------------------------------------------------------------------
// rooms.ts: the "host" of the game. It knows who is in which room, who sits where,
// and checks that each move comes from the right person before handing it to the
// rules engine. It knows nothing about the internet: the server layer calls it.
// ---------------------------------------------------------------------------
import { randomBytes } from 'node:crypto';
import { chooseAction } from '../bot';
import { applyAction, newGame, startNextRound } from '../engine';
import { IllegalMoveError, type Action, type GameState, type Seat } from '../types';
import { viewFor, type PlayerView } from '../view';
import type { RoomInfo } from './protocol';
import type { Store } from './store';

export class RoomError extends Error {}

export interface Player {
  /** A secret key, kept in the player's browser, that proves "this is still me". */
  token: string;
  name: string;
  seat: Seat;
  connected: boolean;
  /** A computer player. It has no browser, so it never connects. */
  bot?: boolean;
}

export interface Room {
  code: string;
  players: Player[];
  game: GameState | null;
  updatedAt: number;
}

// No I or O so codes are easy to read out loud.
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const SEATS: Seat[] = [0, 1, 2, 3];
const KEEP_ROOMS_MS = 14 * 24 * 60 * 60 * 1000;

export class RoomManager {
  private rooms = new Map<string, Room>();

  constructor(
    private store: Store,
    private rng: () => number = Math.random,
    private now: () => number = Date.now,
  ) {
    this.store.prune(this.now() - KEEP_ROOMS_MS);
    for (const stored of this.store.loadAll()) {
      const saved = JSON.parse(stored.data) as { players: Player[]; game: GameState | null };
      // After a restart nobody is connected yet.
      const players = saved.players.map((p) => ({ ...p, connected: false }));
      this.rooms.set(stored.code, { code: stored.code, players, game: saved.game, updatedAt: stored.updatedAt });
    }
  }

  // ---------- joining ----------

  create(name: string): { room: Room; player: Player } {
    let code = '';
    do {
      code = Array.from({ length: 4 }, () => CODE_LETTERS[Math.floor(this.rng() * CODE_LETTERS.length)]).join('');
    } while (this.rooms.has(code));
    const room: Room = { code, players: [], game: null, updatedAt: this.now() };
    this.rooms.set(code, room);
    const player = this.addPlayer(room, name);
    this.save(room);
    return { room, player };
  }

  join(code: string, name: string, token?: string): { room: Room; player: Player } {
    const room = this.rooms.get(code.trim().toUpperCase());
    if (!room) throw new RoomError('No room with that code');

    // Coming back with a known token: you get your old seat back.
    const existing = token ? room.players.find((p) => p.token === token) : undefined;
    if (existing) {
      existing.connected = true;
      return { room, player: existing };
    }
    if (room.game) throw new RoomError('That game has already started');
    if (room.players.length >= 4) throw new RoomError('That room is full');
    const player = this.addPlayer(room, name);
    this.save(room);
    return { room, player };
  }

  private addPlayer(room: Room, name: string): Player {
    const taken = new Set(room.players.map((p) => p.seat));
    const seat = SEATS.find((s) => !taken.has(s)) as Seat;
    const player: Player = {
      token: randomBytes(16).toString('hex'),
      name: name.trim().slice(0, 20) || `Player ${room.players.length + 1}`,
      seat,
      connected: true,
    };
    room.players.push(player);
    return player;
  }

  // ---------- computer players ----------

  addBot(code: string, token: string, seat: Seat): Room {
    const { room } = this.find(code, token);
    if (room.game) throw new RoomError('The game has already started');
    if (room.players.some((p) => p.seat === seat)) throw new RoomError('That seat is taken');
    const botNumber = room.players.filter((p) => p.bot).length + 1;
    room.players.push({ token: randomBytes(16).toString('hex'), name: `Computer ${botNumber}`, seat, connected: true, bot: true });
    this.save(room);
    return room;
  }

  removeBot(code: string, token: string, seat: Seat): Room {
    const { room } = this.find(code, token);
    if (room.game) throw new RoomError('The game has already started');
    const i = room.players.findIndex((p) => p.seat === seat && p.bot);
    if (i < 0) throw new RoomError('There is no computer player in that seat');
    room.players.splice(i, 1);
    this.save(room);
    return room;
  }

  /** Is it a computer player's turn to act in this room? */
  botToAct(code: string): boolean {
    const room = this.rooms.get(code);
    const game = room?.game;
    if (!room || !game) return false;
    const phase = game.round.phase;
    if (phase === 'round_over' || phase === 'game_over') return false;
    return room.players.some((p) => p.bot && p.seat === game.round.turn);
  }

  /** Make exactly one move for the computer player whose turn it is. Returns the room if a move was made. */
  botTurn(code: string): Room | undefined {
    if (!this.botToAct(code)) return undefined;
    const room = this.rooms.get(code) as Room;
    const game = room.game as GameState;
    const seat = game.round.turn;
    room.game = applyAction(game, seat, chooseAction(viewFor(game, seat)), { rng: this.rng });
    this.save(room);
    return room;
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  codes(): string[] {
    return [...this.rooms.keys()];
  }

  setConnected(code: string, token: string, connected: boolean): Room | undefined {
    const room = this.rooms.get(code);
    const player = room?.players.find((p) => p.token === token);
    if (!room || !player) return undefined;
    player.connected = connected;
    return room;
  }

  // ---------- the lobby ----------

  sit(code: string, token: string, seat: Seat): Room {
    const { room, player } = this.find(code, token);
    if (room.game) throw new RoomError('The game has already started');
    if (room.players.some((p) => p.seat === seat && p !== player)) throw new RoomError('That seat is taken');
    player.seat = seat;
    this.save(room);
    return room;
  }

  start(code: string, token: string): Room {
    const { room } = this.find(code, token);
    if (room.game) throw new RoomError('The game has already started');
    if (room.players.length < 4) throw new RoomError('You need four players to start');
    room.game = newGame({ rng: this.rng });
    this.save(room);
    return room;
  }

  // ---------- playing ----------

  act(code: string, token: string, action: Action): Room {
    const { room, player } = this.find(code, token);
    const game = this.requireGame(room);
    try {
      room.game = applyAction(game, player.seat, action, { rng: this.rng });
    } catch (e) {
      if (e instanceof IllegalMoveError) throw new RoomError(e.message);
      throw new RoomError('That move was not understood');
    }
    this.save(room);
    return room;
  }

  nextRound(code: string, token: string): Room {
    const { room } = this.find(code, token);
    const game = this.requireGame(room);
    // Two players pressing "next round" at once is harmless: the second press does nothing.
    if (game.round.phase === 'round_over') {
      room.game = startNextRound(game, { rng: this.rng });
      this.save(room);
    }
    return room;
  }

  newGame(code: string, token: string): Room {
    const { room } = this.find(code, token);
    const game = this.requireGame(room);
    if (game.round.phase === 'game_over') {
      room.game = newGame({ rng: this.rng });
      this.save(room);
    }
    return room;
  }

  // ---------- what each player gets to see ----------

  info(room: Room, player: Player): RoomInfo {
    const seats: RoomInfo['seats'] = [null, null, null, null];
    for (const p of room.players) seats[p.seat] = { name: p.name, connected: p.connected, bot: p.bot === true };
    return { code: room.code, started: room.game !== null, seats, youSeat: player.seat };
  }

  view(room: Room, player: Player): PlayerView | null {
    return room.game ? viewFor(room.game, player.seat) : null;
  }

  // ---------- helpers ----------

  private find(code: string, token: string): { room: Room; player: Player } {
    const room = this.rooms.get(code);
    const player = room?.players.find((p) => p.token === token);
    if (!room || !player) throw new RoomError('You are not in that room');
    return { room, player };
  }

  private requireGame(room: Room): GameState {
    if (!room.game) throw new RoomError('The game has not started yet');
    return room.game;
  }

  private save(room: Room): void {
    room.updatedAt = this.now();
    this.store.save({
      code: room.code,
      data: JSON.stringify({ players: room.players, game: room.game }),
      updatedAt: room.updatedAt,
    });
  }
}
