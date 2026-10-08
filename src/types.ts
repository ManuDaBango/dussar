// ---------------------------------------------------------------------------
// types.ts: the *shape* of a game: what information we keep, and what moves exist.
//
// The whole state of a game is plain data (numbers, text, lists). No hidden magic.
// That is what makes it easy to save to a database, send over the internet, replay,
// and let a computer player look at it.
// ---------------------------------------------------------------------------
import type { Card, Suit } from './cards';

/** Seats 0..3 go clockwise. Partners sit opposite: seats 0 and 2 are one team, 1 and 3 the other. */
export type Seat = 0 | 1 | 2 | 3;
export type Team = 0 | 1;

/** The special calls. 'five' is the "5 cards" call. */
export type CallKind = '26' | '52' | 'five';

/**
 * Where a round is up to.
 *  bidding       players bid or pass, using their first 5 cards
 *  hide_trump    the auction winner hides one card to set the trump
 *  calls         every player may call 26 / 52 (or say no) before the first lead
 *  choose_trump  a 26/52 caller names the trump openly
 *  play          the 13 tricks
 *  round_over    the round is finished, waiting for the next one
 *  game_over     a team has reached 104
 */
export type Phase =
  | 'bidding'
  | 'hide_trump'
  | 'calls'
  | 'choose_trump'
  | 'play'
  | 'round_over'
  | 'game_over';

/** One card played into a trick. */
export interface Play {
  seat: Seat;
  card: Card;
  /** Was the trump suit "live" when this card was played? (Cards played before the trump is revealed are not trumps.) */
  asTrump: boolean;
}

export interface Trick {
  leader: Seat;
  plays: Play[];
}

/** The trick that just finished, kept so players can see it. `collected` = tricks the winner's team collected with it (0 = it joined the pile). */
export interface LastTrick {
  plays: Play[];
  winner: Seat;
  collected: number;
}

/** How a finished round turned out. */
export interface RoundOutcome {
  /** 'bid' = an ordinary bid, otherwise the special call that was in force. */
  type: 'bid' | CallKind;
  /** The team that made the bid or the call. */
  team: Team;
  success: boolean;
  /** The team that receives points because of this result. */
  scoringTeam: Team;
  points: number;
  collected: [number, number];
}

export interface RoundState {
  phase: Phase;
  dealer: Seat;
  /** Whose action is expected next. */
  turn: Seat;

  /** hands[seat]. NOTE: while the trump card is hidden it is NOT in the owner's hand. */
  hands: Card[][];
  /** Cards not yet dealt (the last 32, dealt after the auction). */
  stock: Card[];

  /** Bids by seat: null = hasn't spoken yet, 0 = passed, otherwise the bid. */
  bids: (number | null)[];
  highBid: number;
  auctionWinner: Seat | null;

  /** The face-down trump-setting card (owned by the auction winner), or null once revealed. */
  hiddenCard: Card | null;
  /** The trump suit. Set when the card is hidden, but only "live" once trumpRevealed is true. */
  trump: Suit | null;
  trumpRevealed: boolean;

  /** 26/52 call responses by seat during the calls phase. */
  callResponses: ('26' | '52' | 'none' | null)[];
  /** The call in force (26, 52 or five), if any. */
  call: { kind: CallKind; caller: Seat } | null;
  /** In a 52 call, the caller's partner sits out (hand face up, takes no part). */
  sitOut: Seat | null;

  trick: Trick;
  lastTrick: LastTrick | null;
  /** How many tricks have been completed (0..13). */
  trickNumber: number;
  /** Tricks won but not yet collected, lying face down in the centre. */
  pileSize: number;
  /** The player who won the most recent trick, if that trick is still in the pile. Used for the "two in a row" rule. */
  lastTrickWinner: Seat | null;
  /** Tricks collected by each team. Only collected tricks count. */
  collected: [number, number];

  /** True while a player who has just revealed the trump still has to play a trump. */
  mustTrump: boolean;

  outcome: RoundOutcome | null;
}

export interface GameState {
  /**
   * The score is a single number. Positive = Team 0 has that many points,
   * negative = Team 1 has that many points, zero = nobody has points.
   * (This is exactly the rule "only one team holds points at a time".)
   */
  netScore: number;
  roundNumber: number;
  /** How many times the cards were thrown in because all four players passed. */
  redeals: number;
  winner: Team | null;
  round: RoundState;
}

/** Every move a player can make. */
export type Action =
  | { type: 'bid'; amount: number }
  | { type: 'pass' }
  | { type: 'hide_trump'; card: Card }
  | { type: 'call'; kind: '26' | '52' }
  | { type: 'no_call' }
  | { type: 'choose_trump'; suit: Suit }
  | { type: 'play'; card: Card }
  | { type: 'reveal_trump' }
  | { type: 'call_five' };

export class IllegalMoveError extends Error {}
