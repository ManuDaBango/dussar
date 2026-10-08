import { describe, expect, it } from 'vitest';
import { createDeck, parseCards, seededRng, shuffle, cardToString } from '../src/cards';
import {
  advancePile, applyAction, applyPoints, currentActor, evaluateRound, legalActions,
  newGame, scoreHolder, startNextRound, trickWinner,
} from '../src/engine';
import { IllegalMoveError, type Action, type GameState, type Seat } from '../src/types';
import { viewFor } from '../src/view';
import { c, playState } from './helpers';

const play = (g: GameState, seat: Seat, card: string) => applyAction(g, seat, { type: 'play', card: c(card) });

describe('cards', () => {
  it('has 52 different cards', () => {
    const d = createDeck();
    expect(d).toHaveLength(52);
    expect(new Set(d.map(cardToString)).size).toBe(52);
  });
  it('shuffles the same way for the same seed', () => {
    const a = shuffle(createDeck(), seededRng(7)).map(cardToString);
    const b = shuffle(createDeck(), seededRng(7)).map(cardToString);
    expect(a).toEqual(b);
  });
});

describe('dealing and bidding', () => {
  it('deals 5 cards each and the player left of the dealer bids first', () => {
    const g = newGame({ dealer: 2, rng: seededRng(1) });
    expect(g.round.hands.map((h) => h.length)).toEqual([5, 5, 5, 5]);
    expect(g.round.stock).toHaveLength(32);
    expect(g.round.turn).toBe(3);
  });

  it('only allows 9-13 and each bid must beat the last', () => {
    let g = newGame({ dealer: 3, rng: seededRng(2) }); // first bidder is seat 0
    expect(() => applyAction(g, 0, { type: 'bid', amount: 8 })).toThrow(IllegalMoveError);
    expect(() => applyAction(g, 1, { type: 'bid', amount: 9 })).toThrow(/turn/);
    g = applyAction(g, 0, { type: 'bid', amount: 10 });
    expect(() => applyAction(g, 1, { type: 'bid', amount: 10 })).toThrow(IllegalMoveError);
    expect(() => applyAction(g, 1, { type: 'bid', amount: 14 })).toThrow(IllegalMoveError);
    g = applyAction(g, 1, { type: 'bid', amount: 11 });
    expect(g.round.highBid).toBe(11);
    expect(g.round.auctionWinner).toBe(1);
  });

  it('lets the dealer open with 8 only if the first three passed', () => {
    let g = newGame({ dealer: 3, rng: seededRng(3) });
    for (const s of [0, 1, 2] as Seat[]) g = applyAction(g, s, { type: 'pass' });
    expect(legalActions(g, 3).filter((a) => a.type === 'bid').map((a) => (a as { amount: number }).amount)).toEqual([8, 9, 10, 11, 12, 13]);

    let h = newGame({ dealer: 3, rng: seededRng(3) });
    h = applyAction(h, 0, { type: 'bid', amount: 9 });
    h = applyAction(h, 1, { type: 'pass' });
    h = applyAction(h, 2, { type: 'pass' });
    expect(legalActions(h, 3).filter((a) => a.type === 'bid').map((a) => (a as { amount: number }).amount)).toEqual([10, 11, 12, 13]);
  });

  it('redeals with the next dealer when all four pass', () => {
    let g = newGame({ dealer: 3, rng: seededRng(4) });
    for (const s of [0, 1, 2, 3] as Seat[]) g = applyAction(g, s, { type: 'pass' }, { rng: seededRng(5) });
    expect(g.redeals).toBe(1);
    expect(g.round.dealer).toBe(0);
    expect(g.round.phase).toBe('bidding');
    expect(g.round.turn).toBe(1);
  });

  it('after the auction: winner hides a card, then everyone has 13 (winner 12 + hidden)', () => {
    let g = newGame({ dealer: 3, rng: seededRng(6) });
    g = applyAction(g, 0, { type: 'bid', amount: 9 });
    for (const s of [1, 2, 3] as Seat[]) g = applyAction(g, s, { type: 'pass' });
    expect(g.round.phase).toBe('hide_trump');
    expect(g.round.turn).toBe(0);
    const card = (g.round.hands[0] ?? [])[2]!;
    expect(() => applyAction(g, 1, { type: 'hide_trump', card })).toThrow(IllegalMoveError);
    g = applyAction(g, 0, { type: 'hide_trump', card });
    expect(g.round.hands.map((h) => h.length)).toEqual([12, 13, 13, 13]);
    expect(g.round.hiddenCard).toEqual(card);
    expect(g.round.phase).toBe('calls');
    const all = [...g.round.hands.flat(), card].map(cardToString);
    expect(new Set(all).size).toBe(52);
  });
});

describe('the two-in-a-row collecting rule', () => {
  it("matches the rules-document example: 4 in the centre, A then C win -> no collection; C again -> collect all 7", () => {
    // seats: A=0, B=1, C=2, D=3. Partnerships AC and BD.
    let pile = { size: 4, lastWinner: null as Seat | null };
    let r = advancePile(pile, 0, false); // A wins
    expect(r.collected).toBe(0);
    r = advancePile(r.pile, 2, false); // C wins (partner, different player)
    expect(r.collected).toBe(0);
    expect(r.pile.size).toBe(6);
    r = advancePile(r.pile, 2, false); // C wins again
    expect(r.collected).toBe(7);
    expect(r.pile.size).toBe(0);
  });

  it('after collecting, the next trick starts a new pile and needs another win to collect', () => {
    let r = advancePile({ size: 0, lastWinner: null }, 1, false);
    r = advancePile(r.pile, 1, false);
    expect(r.collected).toBe(2);
    r = advancePile(r.pile, 1, false); // wins the next one too: NOT collected yet
    expect(r.collected).toBe(0);
    r = advancePile(r.pile, 1, false); // now two in a row again
    expect(r.collected).toBe(2);
  });

  it('the winner of the 13th trick takes everything in the centre, even a single trick', () => {
    const r = advancePile({ size: 3, lastWinner: 0 }, 1, true);
    expect(r.collected).toBe(4);
  });

  it('a scripted round: one player wins everything, collecting every second trick; bid of 9 is made on trick 10', () => {
    // Seat 0 holds all spades, seat 1 hearts, seat 2 diamonds, seat 3 clubs. Seat 0 always wins.
    let g = playState({
      hands: [
        'AS KS QS JS 10S 9S 8S 7S 6S 5S 4S 3S 2S',
        'AH KH QH JH 10H 9H 8H 7H 6H 5H 4H 3H 2H',
        'AD KD QD JD 10D 9D 8D 7D 6D 5D 4D 3D 2D',
        'AC KC QC JC 10C 9C 8C 7C 6C 5C 4C 3C 2C',
      ],
      bid: 9, auctionWinner: 0, trump: 'C', hidden: undefined, revealed: false,
    });
    const ranks = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'];
    for (let t = 0; t < 10; t++) {
      expect(g.round.phase).toBe('play');
      g = play(g, 0, ranks[t] + 'S');
      g = play(g, 1, ranks[t] + 'H');
      g = play(g, 2, ranks[t] + 'D');
      g = play(g, 3, ranks[t] + 'C');
      if (t === 0) { expect(g.round.collected).toEqual([0, 0]); expect(g.round.pileSize).toBe(1); }
      if (t === 1) { expect(g.round.collected).toEqual([2, 0]); expect(g.round.pileSize).toBe(0); }
      if (t === 8) { expect(g.round.collected).toEqual([8, 0]); expect(g.round.pileSize).toBe(1); }
    }
    expect(g.round.phase).toBe('round_over');
    expect(g.round.trickNumber).toBe(10);
    expect(g.round.outcome).toMatchObject({ type: 'bid', success: true, scoringTeam: 0, points: 9 });
    expect(g.netScore).toBe(9);
  });
});

describe('following suit and the hidden trump', () => {
  const base = () =>
    playState({
      hands: ['AH 2D', 'KH 9S', '3H 4S', 'QH 5D'],
      auctionWinner: 0, bid: 9, trump: 'S', hidden: '2S', trickNumber: 11, leader: 0,
    });

  it('must follow suit when able, may discard when void', () => {
    let g = base();
    g = play(g, 0, 'AH');
    expect(legalActions(g, 1).filter((a) => a.type === 'play')).toHaveLength(1); // KH only
    expect(() => play(g, 1, '9S')).toThrow(IllegalMoveError);
  });

  it('the hidden card cannot be played while hidden (it is not in the hand)', () => {
    const g = base();
    expect(() => play(g, 0, '2S')).toThrow(IllegalMoveError);
    const cards = legalActions(g, 0).filter((a) => a.type === 'play').map((a) => (a as { card: { suit: string; rank: number } }).card);
    expect(cards).toHaveLength(2);
  });

  it('asking for the trump: card returns to owner, asker must trump if able', () => {
    let g = playState({
      hands: ['AH 2D', '5D 9S', '3D 4S', 'QH 5C'],
      auctionWinner: 0, bid: 9, trump: 'S', hidden: '2S', trickNumber: 11, leader: 0,
    });
    g = play(g, 0, 'AH');
    // seat 1 has no hearts so may ask
    expect(legalActions(g, 1).some((a) => a.type === 'reveal_trump')).toBe(true);
    g = applyAction(g, 1, { type: 'reveal_trump' });
    expect(g.round.trumpRevealed).toBe(true);
    expect(g.round.hiddenCard).toBeNull();
    expect(g.round.hands[0]).toHaveLength(2); // AH played, 2D + returned 2S
    // seat 1 holds 9S, so must play it
    expect(legalActions(g, 1).filter((a) => a.type === 'play')).toHaveLength(1);
    expect(() => play(g, 1, '5D')).toThrow(IllegalMoveError);
    g = play(g, 1, '9S');
    // others are not forced to trump
    expect(legalActions(g, 2).filter((a) => a.type === 'play')).toHaveLength(2);
  });

  it('a player who can follow suit cannot ask for the trump', () => {
    let g = base();
    g = play(g, 0, 'AH');
    expect(legalActions(g, 1).some((a) => a.type === 'reveal_trump')).toBe(false);
    expect(() => applyAction(g, 1, { type: 'reveal_trump' })).toThrow(IllegalMoveError);
  });

  it('the auction winner may reveal when on lead, and then must lead a trump', () => {
    let g = base();
    expect(legalActions(g, 0).some((a) => a.type === 'reveal_trump')).toBe(true);
    g = applyAction(g, 0, { type: 'reveal_trump' });
    const plays = legalActions(g, 0).filter((a) => a.type === 'play');
    expect(plays).toHaveLength(1); // only the 2S
    expect(() => play(g, 0, 'AH')).toThrow(IllegalMoveError);
  });

  it('only the owner of the hidden card can reveal it on lead; others cannot', () => {
    const g = base();
    expect(legalActions(g, 1)).toHaveLength(0); // not their turn
  });

  it('trumps played BEFORE the reveal do not count; trumps after it do', () => {
    // Hearts led. Seat 1 is void and discards a high spade (spades are the hidden trump) BEFORE any reveal.
    // Seat 2 is void, asks for the trump and plays a low spade: seat 2 should win, not seat 1.
    let g = playState({
      hands: ['AH 2D', 'KS 5D', '3S 4D', 'QH 5C'],
      auctionWinner: 0, bid: 9, trump: 'S', hidden: '2S', trickNumber: 11, leader: 0,
    });
    g = play(g, 0, 'AH');
    g = play(g, 1, 'KS'); // discard (no trump live yet)
    g = applyAction(g, 2, { type: 'reveal_trump' });
    g = play(g, 2, '3S');
    g = play(g, 3, 'QH');
    expect(g.round.lastTrickWinner).toBe(2);
  });

  it('highest trump wins; otherwise highest of the suit led', () => {
    const plays = (xs: [Seat, string, boolean][]) => xs.map(([seat, card, asTrump]) => ({ seat, card: c(card), asTrump }));
    expect(trickWinner(plays([[0, 'AH', false], [1, 'KH', false], [2, '2S', true], [3, '3S', true]]))).toBe(3);
    expect(trickWinner(plays([[0, '5H', false], [1, 'KH', false], [2, 'AD', false], [3, '3H', false]]))).toBe(1);
  });

  it('on the last trick the hidden card is played as the final card and reveals the trump', () => {
    // Trick 13: seat 0 has only the hidden 2S. Hearts are led by seat 1.
    let g = playState({
      hands: ['', 'AH', 'KH', 'QH'],
      auctionWinner: 0, bid: 9, trump: 'S', hidden: '2S', trickNumber: 12, leader: 1,
      collected: [4, 8],
    });
    g.round.pileSize = 0;
    g = play(g, 1, 'AH');
    g = play(g, 2, 'KH');
    g = play(g, 3, 'QH');
    expect(legalActions(g, 0).filter((a) => a.type === 'play')).toHaveLength(1);
    g = play(g, 0, '2S');
    expect(g.round.trickNumber).toBe(13);
    expect(g.round.collected[0]).toBe(5); // seat 0's lone trump wins the 13th trick
  });
});

describe('ending a round early', () => {
  it('the bid fails as soon as the other team has collected 14 - bid', () => {
    const g = playState({ hands: ['', '', '', ''], bid: 9, auctionWinner: 0, collected: [3, 5] });
    expect(evaluateRound(g.round)).toMatchObject({ success: false, scoringTeam: 1, points: 18 });
  });
  it('the bid succeeds as soon as the bidding team has collected the bid', () => {
    const g = playState({ hands: ['', '', '', ''], bid: 11, auctionWinner: 1, collected: [1, 11] });
    expect(evaluateRound(g.round)).toMatchObject({ success: true, scoringTeam: 1, points: 11 });
  });
  it('is not decided while neither limit is reached', () => {
    const g = playState({ hands: ['', '', '', ''], bid: 9, auctionWinner: 0, collected: [6, 4] });
    expect(evaluateRound(g.round)).toBeNull();
  });
  it('bid of 8 (dealer) needs 6 to defeat it', () => {
    const g = playState({ hands: ['', '', '', ''], bid: 8, auctionWinner: 0, collected: [2, 6] });
    expect(evaluateRound(g.round)).toMatchObject({ success: false, points: 16 });
  });
});

describe('the net score', () => {
  it('matches the examples in the rules document', () => {
    let net = 0;
    net = applyPoints(net, 0, 9);
    net = applyPoints(net, 0, 9);
    expect(scoreHolder(net)).toEqual({ team: 0, points: 18 });
    net = applyPoints(net, 1, 52); // Team 0's 26 call fails
    expect(net).toBe(-34);
    expect(scoreHolder(net)).toEqual({ team: 1, points: 34 });
    net = applyPoints(net, 1, 10);
    expect(scoreHolder(net)).toEqual({ team: 1, points: 44 });
    net = applyPoints(net, 0, 12);
    expect(scoreHolder(net)).toEqual({ team: 1, points: 32 });
  });

  it('the game ends when a team reaches 104', () => {
    let g = playState({
      hands: ['', '', '', ''], bid: 13, auctionWinner: 0, netScore: 95, collected: [12, 0],
    });
    g.round.hands = [parseCards('AS'), parseCards('AH'), parseCards('AD'), parseCards('AC')];
    g.round.trickNumber = 12;
    g.round.trump = 'S';
    g = play(g, 0, 'AS'); g = play(g, 1, 'AH'); g = play(g, 2, 'AD'); g = play(g, 3, 'AC');
    expect(g.netScore).toBe(108);
    expect(g.winner).toBe(0);
    expect(g.round.phase).toBe('game_over');
    expect(currentActor(g)).toBeNull();
  });
});

describe('26, 52 and 5 cards', () => {
  function toCalls(): GameState {
    let g = newGame({ dealer: 3, rng: seededRng(11) });
    g = applyAction(g, 0, { type: 'bid', amount: 9 });
    for (const s of [1, 2, 3] as Seat[]) g = applyAction(g, s, { type: 'pass' });
    g = applyAction(g, 0, { type: 'hide_trump', card: (g.round.hands[0] ?? [])[0]! });
    return g;
  }

  it('with no calls, the auction winner leads and trump stays hidden', () => {
    let g = toCalls();
    expect(g.round.phase).toBe('calls');
    expect(g.round.turn).toBe(0);
    for (const s of [0, 1, 2, 3] as Seat[]) g = applyAction(g, s, { type: 'no_call' });
    expect(g.round.phase).toBe('play');
    expect(g.round.turn).toBe(0);
    expect(g.round.hiddenCard).not.toBeNull();
    expect(g.round.trumpRevealed).toBe(false);
  });

  it('52 beats 26 regardless of order; the auction is cancelled and the card returns', () => {
    let g = toCalls();
    g = applyAction(g, 0, { type: 'call', kind: '26' });
    g = applyAction(g, 1, { type: 'no_call' });
    g = applyAction(g, 2, { type: 'call', kind: '52' });
    g = applyAction(g, 3, { type: 'no_call' });
    expect(g.round.call).toEqual({ kind: '52', caller: 2 });
    expect(g.round.sitOut).toBe(0); // partner of seat 2
    expect(g.round.hiddenCard).toBeNull();
    expect(g.round.hands[0]).toHaveLength(13);
    expect(g.round.phase).toBe('choose_trump');
    g = applyAction(g, 2, { type: 'choose_trump', suit: 'H' });
    expect(g.round.trumpRevealed).toBe(true);
    expect(g.round.turn).toBe(2);
    expect(g.round.phase).toBe('play');
  });

  it('between equal calls the player closest to the dealer\'s left wins', () => {
    let g = toCalls();
    g = applyAction(g, 0, { type: 'no_call' });
    g = applyAction(g, 1, { type: 'call', kind: '26' });
    g = applyAction(g, 2, { type: 'no_call' });
    g = applyAction(g, 3, { type: 'call', kind: '26' });
    expect(g.round.call).toEqual({ kind: '26', caller: 1 });
  });

  it('in a 52 call tricks have three cards, the partner sits out and is visible to everyone', () => {
    let g = playState({
      hands: ['AS KS', 'AH KH', '2S 3S', '2H 3H'],
      auctionWinner: 0, bid: 9, trump: 'D', revealed: true, trickNumber: 11, leader: 1,
    });
    g.round.call = { kind: '52', caller: 1 };
    g.round.sitOut = 3;
    g = play(g, 1, 'AH');
    expect(g.round.turn).toBe(2); // seat 3 skipped...
    g = play(g, 2, '2S');
    expect(g.round.turn).toBe(0); // ...and then straight to seat 0
    expect(viewFor(g, 0).exposedHand).toEqual({ seat: 3, cards: g.round.hands[3] });
  });

  it('a 26 call fails the moment the opponents collect a trick, scoring 52 for them', () => {
    const g = playState({ hands: ['', '', '', ''], bid: 9, auctionWinner: 0, collected: [3, 2] });
    g.round.call = { kind: '26', caller: 0 };
    expect(evaluateRound(g.round)).toMatchObject({ type: '26', success: false, scoringTeam: 1, points: 52 });
    const h = playState({ hands: ['', '', '', ''], bid: 9, auctionWinner: 0, collected: [13, 0] });
    h.round.call = { kind: '52', caller: 2 };
    expect(evaluateRound(h.round)).toMatchObject({ type: '52', success: true, scoringTeam: 0, points: 52 });
    const k = playState({ hands: ['', '', '', ''], bid: 9, auctionWinner: 0, collected: [3, 1] });
    k.round.call = { kind: '52', caller: 0 };
    expect(evaluateRound(k.round)).toMatchObject({ points: 104, scoringTeam: 1 });
  });

  it('a won-but-uncollected trick does not count against the caller', () => {
    const g = playState({ hands: ['', '', '', ''], bid: 9, auctionWinner: 0, collected: [4, 0] });
    g.round.call = { kind: '26', caller: 0 };
    g.round.pileSize = 3; g.round.lastTrickWinner = 1;
    expect(evaluateRound(g.round)).toBeNull();
  });

  it('"5 cards" rules: auction winner only, between tricks, >5 cards left, opponents collected nothing, no other call', () => {
    const mk = (over: Partial<Parameters<typeof playState>[0]> = {}) =>
      playState({ hands: ['AS KS QS JS 10S 9S 8S 7S', 'AH', 'AD', 'AC'], auctionWinner: 0, bid: 9, trickNumber: 5, ...over });
    expect(legalActions(mk(), 0).some((a) => a.type === 'call_five')).toBe(true);
    expect(legalActions(mk(), 2).some((a) => a.type === 'call_five')).toBe(false); // partner cannot
    expect(legalActions(mk({ trickNumber: 8 }), 0).some((a) => a.type === 'call_five')).toBe(false); // only 5 cards left
    expect(legalActions(mk({ trickNumber: 7 }), 0).some((a) => a.type === 'call_five')).toBe(true); // 6 left
    expect(legalActions(mk({ collected: [2, 1] }), 0).some((a) => a.type === 'call_five')).toBe(false);
    const withCall = mk(); withCall.round.call = { kind: '26', caller: 1 };
    expect(legalActions(withCall, 0).some((a) => a.type === 'call_five')).toBe(false);
    const mid = mk(); mid.round.trick.plays = [{ seat: 0, card: c('AS'), asTrump: false }];
    expect(legalActions(mid, 0).some((a) => a.type === 'call_five')).toBe(false);

    let g = applyAction(mk(), 0, { type: 'call_five' });
    expect(g.round.call).toEqual({ kind: 'five', caller: 0 });
    g.round.collected = [4, 1];
    expect(evaluateRound(g.round)).toMatchObject({ type: 'five', success: false, scoringTeam: 1, points: 52 });
    g.round.collected = [13, 0];
    expect(evaluateRound(g.round)).toMatchObject({ type: 'five', success: true, scoringTeam: 0, points: 26 });
  });
});

describe('hidden information', () => {
  it('a player view never contains other hands, and hides the trump from non-owners', () => {
    let g = newGame({ dealer: 3, rng: seededRng(21) });
    g = applyAction(g, 0, { type: 'bid', amount: 9 });
    for (const s of [1, 2, 3] as Seat[]) g = applyAction(g, s, { type: 'pass' });
    g = applyAction(g, 0, { type: 'hide_trump', card: (g.round.hands[0] ?? [])[1]! });

    const owner = viewFor(g, 0);
    const other = viewFor(g, 1);
    expect(owner.hiddenCard).not.toBeNull();
    expect(owner.trump).not.toBeNull();
    expect(other.hiddenCard).toBeNull();
    expect(other.hasHiddenCard).toBe(true);
    expect(other.trump).toBeNull();
    expect(other.hand).toEqual(g.round.hands[1]);
    expect(other.handCounts).toEqual([12, 13, 13, 13]);
    expect('hands' in other).toBe(false);
    expect('stock' in other).toBe(false);
    // the other player's cards never appear anywhere in the data sent to seat 1
    const text = JSON.stringify(other);
    for (const card of g.round.hands[2] ?? []) {
      expect(text.includes(JSON.stringify(card))).toBe(false);
    }
  });
});

describe('whole random games', () => {
  /** Plays a game by choosing random legal moves. Checks the rules never break. */
  function simulate(seed: number): GameState {
    const rng = seededRng(seed);
    let g = newGame({ rng });
    let steps = 0;
    while (g.winner === null) {
      if (++steps > 20000) throw new Error('game did not finish');
      if (g.round.phase === 'round_over') { g = startNextRound(g, { rng }); continue; }
      const seat = g.round.turn;
      let actions: Action[] = legalActions(g, seat);
      // sometimes the auction winner shouts "5 cards"
      const aw = g.round.auctionWinner;
      if (g.round.phase === 'play' && aw !== null && rng() < 0.08) {
        const five = legalActions(g, aw).find((a) => a.type === 'call_five');
        if (five) { g = applyAction(g, aw, five); continue; }
      }
      // keep the game moving: prefer bidding sometimes, and 26/52 only rarely
      if (g.round.phase === 'bidding') actions = rng() < 0.45 ? actions : actions.filter((a) => a.type === 'pass' || a.type === 'bid');
      if (g.round.phase === 'calls') actions = rng() < 0.9 ? actions.filter((a) => a.type === 'no_call') : actions;
      expect(actions.length).toBeGreaterThan(0);
      const pick = actions[Math.floor(rng() * actions.length)] as Action;
      g = applyAction(g, seat, pick, { rng });

      // invariants
      const r = g.round;
      const inHands = r.hands.reduce((n, h) => n + h.length, 0) + (r.hiddenCard ? 1 : 0) + r.stock.length;
      const inPlay = r.trick.plays.length;
      expect(r.collected[0] + r.collected[1] + r.pileSize).toBe(r.trickNumber);
      if (r.phase === 'play' || r.phase === 'round_over' || r.phase === 'game_over') {
        const played = r.trickNumber * (r.sitOut === null ? 4 : 3) + inPlay;
        expect(inHands + played).toBe(52);
      }
    }
    return g;
  }

  it('50 random games all finish, never break a rule, and always have a winner at 104+', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const g = simulate(seed);
      expect(Math.abs(g.netScore)).toBeGreaterThanOrEqual(104);
      expect(g.winner).toBe(g.netScore > 0 ? 0 : 1);
    }
  });
});
