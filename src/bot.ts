// ---------------------------------------------------------------------------
// bot.ts: a computer player.
//
// A bot is just a function:   chooseAction(view) -> a move
// It is given exactly what a human in that seat would see (a PlayerView), and must pick
// one of the moves in view.legalActions. It never sees other players' cards, so it cannot cheat.
//
// This first version is a "rules of thumb" player, deliberately simple and predictable:
//   * Bidding: it counts high cards and a long suit in its first 5 cards.
//   * Playing: it thinks about the two-in-a-row rule. It asks "whose win is pending in the
//     pile?" and decides whether it needs to win this trick, help its partner, or just play low.
// Later versions can be smarter (remembering cards played, counting trumps) without changing
// anything else in the program, because everything talks to it only through chooseAction.
// ---------------------------------------------------------------------------
import type { Card, Suit } from './cards';
import { SUITS } from './cards';
import { trickWinner } from './engine';
import type { Action, Play, Seat } from './types';
import type { PlayerView } from './view';

const HIGH_CARD_VALUE: Record<number, number> = { 14: 2, 13: 1.4, 12: 0.8, 11: 0.4 };

function suitCards(cards: readonly Card[], suit: Suit): Card[] {
  return cards.filter((c) => c.suit === suit);
}

/** How good is this suit as a trump suit? Long suits and high cards are good. */
function suitStrength(cards: readonly Card[], suit: Suit): number {
  const mine = suitCards(cards, suit);
  return mine.length + mine.reduce((sum, c) => sum + (HIGH_CARD_VALUE[c.rank] ?? 0), 0);
}

function bestSuit(cards: readonly Card[]): Suit {
  let best: Suit = SUITS[0] as Suit;
  for (const s of SUITS) if (suitStrength(cards, s) > suitStrength(cards, best)) best = s;
  return best;
}

/** A rough "how strong is this hand" score from the first five cards. */
function handStrength(cards: readonly Card[]): number {
  const high = cards.reduce((sum, c) => sum + (HIGH_CARD_VALUE[c.rank] ?? 0), 0);
  const longest = Math.max(...SUITS.map((s) => suitCards(cards, s).length));
  return high + Math.max(0, longest - 2) * 0.7;
}

// ------------------------------------------------------------ the entry point

export function chooseAction(view: PlayerView): Action {
  const legal = view.legalActions;
  const first = legal[0];
  if (!first) throw new Error('The bot has no legal move');
  switch (view.phase) {
    case 'bidding': return chooseBid(view);
    case 'hide_trump': return chooseHiddenCard(view);
    case 'calls': return { type: 'no_call' };
    case 'choose_trump': return { type: 'choose_trump', suit: bestSuit(view.hand) };
    case 'play': return choosePlay(view);
    default: return first;
  }
}

// ------------------------------------------------------------ bidding & the hidden card

function chooseBid(view: PlayerView): Action {
  const amounts = view.legalActions.flatMap((a) => (a.type === 'bid' ? [a.amount] : []));
  const lowest = amounts[0];
  if (lowest === undefined) return { type: 'pass' };
  const strength = handStrength(view.hand);

  // The dealer may open with 8 when everyone else passed. That is a fairly safe bid.
  if (lowest === 8) return strength >= 2 ? { type: 'bid', amount: 8 } : { type: 'pass' };

  const wanted = strength >= 6 ? 10 : strength >= 4 ? 9 : 0;
  if (wanted === 0 || lowest > wanted) return { type: 'pass' };
  return { type: 'bid', amount: Math.max(lowest, wanted) };
}

function chooseHiddenCard(view: PlayerView): Action {
  const suit = bestSuit(view.hand);
  // Hide the lowest card of the chosen suit, keeping the high ones to play.
  const candidates = suitCards(view.hand, suit).sort((a, b) => a.rank - b.rank);
  const card = candidates[0] ?? (view.hand[0] as Card);
  return { type: 'hide_trump', card };
}

// ------------------------------------------------------------ playing tricks

const sameTeam = (a: Seat, b: Seat) => a % 2 === b % 2;

function choosePlay(view: PlayerView): Action {
  const me = view.seat;
  const partner = ((me + 2) % 4) as Seat;
  const plays = view.legalActions.flatMap((a) => (a.type === 'play' ? [a.card] : []));
  const canReveal = view.legalActions.some((a) => a.type === 'reveal_trump');
  const isTrump = (c: Card) => view.trumpRevealed && view.trump === c.suit;
  const first = plays[0];
  if (!first) {
    // Only a non-play move is possible (should not happen). Take whatever is allowed.
    return view.legalActions[0] as Action;
  }

  // Who is waiting to collect the pile? (The winner of the latest trick, if it is still in the pile.)
  const pending: Seat | null = view.pileSize > 0 && view.lastTrick ? view.lastTrick.winner : null;
  const needToWin = pending !== null && !sameTeam(pending, me) ? 'stop' : pending === me ? 'streak' : 'free';
  const helpingPartner = pending === partner;

  // Cards ordered cheapest first (non-trumps before trumps).
  const cheapFirst = [...plays].sort((a, b) => Number(isTrump(a)) - Number(isTrump(b)) || a.rank - b.rank);
  const cheapest = cheapFirst[0] as Card;
  const strongestPlain = [...plays].sort((a, b) => Number(isTrump(a)) - Number(isTrump(b)) || b.rank - a.rank)[0] as Card;

  /**
   * Leading into an EMPTY pile. Winning this trick only starts the streak; the next trick is the
   * one that collects. So a good player saves the Ace for trick two and opens with a card that
   * is strong but not the top one:
   *   1. a King (or lower) from a suit where we also hold the Ace: this wins the trick for sure,
   *      and the Ace is waiting for the next one;
   *   2. otherwise the highest non-Ace, non-trump card;
   *   3. if we only have Aces and trumps, the cheapest card (never waste an Ace here).
   */
  const freeLead = (): Card => {
    const plain = plays.filter((c) => !isTrump(c));
    const aceSuits = new Set(plain.filter((c) => c.rank === 14).map((c) => c.suit));
    const nonAce = plain.filter((c) => c.rank < 14);
    const backed = nonAce.filter((c) => aceSuits.has(c.suit)).sort((a, b) => b.rank - a.rank)[0];
    if (backed) return backed;
    const best = nonAce.sort((a, b) => b.rank - a.rank)[0];
    return best ?? cheapest;
  };

  const trick = view.trick.plays;
  const play = (card: Card): Action => ({ type: 'play', card });

  // ---- leading ----
  if (trick.length === 0) {
    if (helpingPartner) return play(cheapest); // let partner win the next trick
    // Otherwise lead a strong card. Win the trick, and the next one too.
    if (canReveal && (needToWin === 'stop' || needToWin === 'streak') && strongestPlain.rank < 14 && view.trump !== null) {
      return { type: 'reveal_trump' }; // the owner knows he has trumps; lead one
    }
    if (needToWin === 'free') return play(freeLead());
    return play(strongestPlain); // 'stop' or 'streak': we must win this trick, so use the best card
  }

  // ---- following ----
  const remaining = (view.sitOut === null ? 4 : 3) - trick.length - 1; // players still to come after me
  const currentWinner = trickWinner(trick);
  const candidatePlay = (card: Card): Play => ({ seat: me, card, asTrump: isTrump(card) });
  const winners = cheapFirst.filter((c) => trickWinner([...trick, candidatePlay(c)]) === me);
  const partnerWinning = currentWinner === partner;
  const winningCard = trick.find((p) => p.seat === currentWinner)?.card;
  const partnerSafe = partnerWinning && (remaining === 0 || (winningCard !== undefined && (winningCard.rank >= 12 || (view.trumpRevealed && view.trump === winningCard.suit))));

  const wantsWin = helpingPartner ? !partnerWinning : !partnerSafe;
  if (wantsWin) {
    const cheapestWinner = winners[0];
    if (cheapestWinner) return play(cheapestWinner);
    // Cannot win with a card of the suit led. If we cannot follow suit, gamble on asking for the trump.
    if (canReveal && (needToWin !== 'free' || !sameTeam(currentWinner, me))) return { type: 'reveal_trump' };
  }
  return play(cheapest);
}
