// ---------------------------------------------------------------------------
// protocol.ts: the "language" the browser and the server speak to each other.
//
// Every message is a small piece of JSON with a "t" (type) field.
// Messages arriving from the internet are UNTRUSTED, so parseClientMessage checks
// every field before the rest of the program is allowed to see it.
// ---------------------------------------------------------------------------
import { SUITS, type Card, type Suit } from '../cards';
import type { Action, Seat } from '../types';
import type { PlayerView } from '../view';

// ---- browser -> server ----
export type ClientMessage =
  | { t: 'create'; name: string }
  | { t: 'join'; code: string; name: string; token?: string }
  | { t: 'sit'; seat: Seat }
  | { t: 'start' }
  | { t: 'action'; action: Action }
  | { t: 'next_round' }
  | { t: 'new_game' }
  | { t: 'add_bot'; seat: Seat }
  | { t: 'remove_bot'; seat: Seat }
  /** Sent every few minutes by an open page, so a free host does not put the server to sleep mid-game. */
  | { t: 'ping' };

// ---- server -> browser ----
export interface SeatInfo {
  name: string;
  connected: boolean;
  /** True for a computer player. */
  bot: boolean;
}

export interface RoomInfo {
  code: string;
  started: boolean;
  /** One entry per seat 0..3; null = empty. */
  seats: (SeatInfo | null)[];
  youSeat: Seat;
}

export type ServerMessage =
  /** Sent once after create/join. `token` is the player's secret key for rejoining. */
  | { t: 'joined'; code: string; token: string }
  /** Sent after every change: the room, and (once started) what this player may see. */
  | { t: 'update'; room: RoomInfo; view: PlayerView | null }
  | { t: 'error'; message: string };

// ---- checking untrusted input ----

export class BadMessage extends Error {}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function str(x: unknown, max: number): string {
  if (typeof x !== 'string') throw new BadMessage('Expected text');
  return x.slice(0, max);
}

function seat(x: unknown): Seat {
  if (x !== 0 && x !== 1 && x !== 2 && x !== 3) throw new BadMessage('Bad seat');
  return x;
}

function card(x: unknown): Card {
  if (!isObj(x)) throw new BadMessage('Bad card');
  const suit = x.suit;
  const rank = x.rank;
  if (typeof suit !== 'string' || !SUITS.includes(suit as Suit)) throw new BadMessage('Bad card');
  if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 2 || rank > 14) throw new BadMessage('Bad card');
  return { suit: suit as Suit, rank };
}

function parseAction(x: unknown): Action {
  if (!isObj(x)) throw new BadMessage('Bad action');
  switch (x.type) {
    case 'bid':
      if (typeof x.amount !== 'number') throw new BadMessage('Bad bid');
      return { type: 'bid', amount: x.amount };
    case 'pass':
    case 'no_call':
    case 'reveal_trump':
    case 'call_five':
      return { type: x.type };
    case 'hide_trump':
      return { type: 'hide_trump', card: card(x.card) };
    case 'play':
      return { type: 'play', card: card(x.card) };
    case 'call':
      if (x.kind !== '26' && x.kind !== '52') throw new BadMessage('Bad call');
      return { type: 'call', kind: x.kind };
    case 'choose_trump':
      if (typeof x.suit !== 'string' || !SUITS.includes(x.suit as Suit)) throw new BadMessage('Bad suit');
      return { type: 'choose_trump', suit: x.suit as Suit };
    default:
      throw new BadMessage('Unknown action');
  }
}

export function parseClientMessage(raw: string): ClientMessage {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new BadMessage('Not valid JSON');
  }
  if (!isObj(data)) throw new BadMessage('Expected an object');
  switch (data.t) {
    case 'create':
      return { t: 'create', name: str(data.name, 20) };
    case 'join': {
      const msg: ClientMessage = { t: 'join', code: str(data.code, 8), name: str(data.name, 20) };
      if (data.token !== undefined) msg.token = str(data.token, 64);
      return msg;
    }
    case 'sit':
      return { t: 'sit', seat: seat(data.seat) };
    case 'add_bot':
      return { t: 'add_bot', seat: seat(data.seat) };
    case 'remove_bot':
      return { t: 'remove_bot', seat: seat(data.seat) };
    case 'start':
    case 'next_round':
    case 'new_game':
    case 'ping':
      return { t: data.t };
    case 'action':
      return { t: 'action', action: parseAction(data.action) };
    default:
      throw new BadMessage('Unknown message');
  }
}
