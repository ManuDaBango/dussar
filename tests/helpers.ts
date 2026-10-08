import { parseCards, type Card } from '../src/cards';
import type { GameState, RoundState, Seat } from '../src/types';

/** Build a game that is already in the middle of play, with hands we choose. */
export function playState(opts: {
  hands: [string, string, string, string];
  auctionWinner?: Seat;
  bid?: number;
  trump?: 'S' | 'H' | 'D' | 'C';
  hidden?: string; // the hidden card, e.g. "2S"
  revealed?: boolean;
  trickNumber?: number;
  leader?: Seat;
  netScore?: number;
  collected?: [number, number];
}): GameState {
  const hands = opts.hands.map((h) => parseCards(h)) as Card[][];
  const round: RoundState = {
    phase: 'play',
    dealer: 3,
    turn: opts.leader ?? 0,
    hands,
    stock: [],
    bids: [9, 0, 0, 0],
    highBid: opts.bid ?? 9,
    auctionWinner: opts.auctionWinner ?? 0,
    hiddenCard: opts.hidden ? (parseCards(opts.hidden)[0] as Card) : null,
    trump: opts.trump ?? null,
    trumpRevealed: opts.revealed ?? false,
    callResponses: ['none', 'none', 'none', 'none'],
    call: null,
    sitOut: null,
    trick: { leader: opts.leader ?? 0, plays: [] },
    lastTrick: null,
    trickNumber: opts.trickNumber ?? 0,
    pileSize: 0,
    lastTrickWinner: null,
    collected: opts.collected ?? [0, 0],
    mustTrump: false,
    outcome: null,
  };
  return { netScore: opts.netScore ?? 0, roundNumber: 1, redeals: 0, winner: null, round };
}

export const c = (text: string): Card => parseCards(text)[0] as Card;
