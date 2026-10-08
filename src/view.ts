// ---------------------------------------------------------------------------
// view.ts: "what can THIS player see?"
//
// The game state holds everybody's cards. You must never send all of that to every
// player's browser, or a curious player could peek at the other hands (just by looking
// at the data their browser receives). So the server will always send each player a
// *view*: only what that seat is allowed to know.
//
// The same view is what a computer player gets, so it cannot cheat either.
// ---------------------------------------------------------------------------
import type { Card, Suit } from './cards';
import { legalActions } from './engine';
import type { Action, CallKind, GameState, LastTrick, Phase, RoundOutcome, Seat, Team, Trick } from './types';

export interface PlayerView {
  seat: Seat;
  phase: Phase;
  turn: Seat;
  dealer: Seat;
  netScore: number;
  roundNumber: number;
  winner: Team | null;

  /** Your own cards. */
  hand: Card[];
  /** How many cards each seat holds (you can see the counts, not the cards). */
  handCounts: number[];
  /** The 52-call partner's cards, face up for everyone. */
  exposedHand: { seat: Seat; cards: Card[] } | null;

  bids: (number | null)[];
  highBid: number;
  auctionWinner: Seat | null;

  /** Only the owner sees the hidden trump card. Everyone else just learns that one exists. */
  hiddenCard: Card | null;
  hasHiddenCard: boolean;
  /** The trump suit: visible once revealed (or always to the owner of the hidden card). */
  trump: Suit | null;
  trumpRevealed: boolean;

  call: { kind: CallKind; caller: Seat } | null;
  sitOut: Seat | null;

  trick: Trick;
  lastTrick: LastTrick | null;
  trickNumber: number;
  pileSize: number;
  collected: [number, number];
  outcome: RoundOutcome | null;

  /** The moves you may make right now. */
  legalActions: Action[];
}

export function viewFor(game: GameState, seat: Seat): PlayerView {
  const r = game.round;
  const isOwner = r.auctionWinner === seat;
  const exposed =
    r.sitOut !== null ? { seat: r.sitOut, cards: [...(r.hands[r.sitOut] as Card[])] } : null;

  return {
    seat,
    phase: r.phase,
    turn: r.turn,
    dealer: r.dealer,
    netScore: game.netScore,
    roundNumber: game.roundNumber,
    winner: game.winner,

    hand: [...(r.hands[seat] as Card[])],
    handCounts: r.hands.map((h) => h.length),
    exposedHand: exposed,

    bids: [...r.bids],
    highBid: r.highBid,
    auctionWinner: r.auctionWinner,

    hiddenCard: isOwner && r.hiddenCard ? { ...r.hiddenCard } : null,
    hasHiddenCard: r.hiddenCard !== null,
    trump: r.trumpRevealed || (isOwner && r.hiddenCard) ? r.trump : null,
    trumpRevealed: r.trumpRevealed,

    call: r.call ? { ...r.call } : null,
    sitOut: r.sitOut,

    trick: structuredClone(r.trick),
    lastTrick: r.lastTrick ? structuredClone(r.lastTrick) : null,
    trickNumber: r.trickNumber,
    pileSize: r.pileSize,
    collected: [r.collected[0], r.collected[1]],
    outcome: r.outcome ? structuredClone(r.outcome) : null,

    legalActions: legalActions(game, seat),
  };
}
