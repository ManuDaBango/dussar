// ---------------------------------------------------------------------------
// engine.ts: the rules of Dussar, and nothing else.
//
// No screens, no internet, no saving. Just: "given this game and this move, what happens?"
// The two functions that matter most:
//
//   legalActions(game, seat)       -> the list of moves that seat may make right now
//   applyAction(game, seat, move)  -> the new game state after that move (or an error)
//
// Every rule in the rules document lives here, so there is one place to look and one
// place to change if you want to alter a rule.
// ---------------------------------------------------------------------------
import {
  type Card,
  type Suit,
  SUITS,
  createDeck,
  sameCard,
  shuffle,
} from './cards';
import {
  type Action,
  type CallKind,
  type GameState,
  type Play,
  type RoundOutcome,
  type RoundState,
  type Seat,
  type Team,
  IllegalMoveError,
} from './types';

export const TARGET_SCORE = 104;
export const TRICKS_PER_ROUND = 13;

// ------------------------- small helpers -------------------------

export const nextSeat = (s: Seat): Seat => ((s + 1) % 4) as Seat;
export const partnerOf = (s: Seat): Seat => ((s + 2) % 4) as Seat;
export const teamOf = (s: Seat): Team => (s % 2) as Team;
export const otherTeam = (t: Team): Team => (t === 0 ? 1 : 0);

function fail(message: string): never {
  throw new IllegalMoveError(message);
}

function removeCard(hand: Card[], card: Card): void {
  const i = hand.findIndex((c) => sameCard(c, card));
  if (i < 0) fail('That card is not in the hand');
  hand.splice(i, 1);
}

function hasCard(hand: readonly Card[], card: Card): boolean {
  return hand.some((c) => sameCard(c, card));
}

// ------------------------- scoring -------------------------

/**
 * Add points for a team to the single net score.
 * Positive net = Team 0 holds points. Negative net = Team 1 holds points.
 * Gaining points first cancels the other team's points; any excess becomes yours.
 * Example from the rules: Team 0 on 18 loses a 26 call, so Team 1 scores 52:
 *   applyPoints(18, 1, 52) === -34  (that is, Team 1 now holds 34)
 */
export function applyPoints(netScore: number, scoringTeam: Team, points: number): number {
  return scoringTeam === 0 ? netScore + points : netScore - points;
}

/** Which team holds the points right now (null when the score is 0-0), and how many. */
export function scoreHolder(netScore: number): { team: Team | null; points: number } {
  if (netScore > 0) return { team: 0, points: netScore };
  if (netScore < 0) return { team: 1, points: -netScore };
  return { team: null, points: 0 };
}

/** Points for a finished special call or bid: [if it succeeds, if it fails (paid to the other team)]. */
function stakes(type: 'bid' | CallKind, bid: number): [number, number] {
  switch (type) {
    case 'bid': return [bid, 2 * bid];
    case '26': return [26, 52];
    case 'five': return [26, 52];
    case '52': return [52, 104];
  }
}

// ------------------------- the pile ("two in a row") -------------------------

export interface PileState {
  /** Tricks lying uncollected in the centre. */
  size: number;
  /** Winner of the latest trick in the pile (null if the latest trick was just collected or there is none). */
  lastWinner: Seat | null;
}

/**
 * The heart of Dussar. A trick has just been won by `winner`. Does the winner collect?
 *  - Yes if the SAME player also won the trick before it (and it is still in the pile).
 *  - Yes on the 13th trick: the winner takes whatever is in the centre.
 *  - Otherwise the trick joins the pile and waits.
 * Returns the new pile, and how many tricks were collected by the winner's team (0 if none).
 */
export function advancePile(pile: PileState, winner: Seat, isLastTrick: boolean): { pile: PileState; collected: number } {
  const size = pile.size + 1;
  if (isLastTrick || pile.lastWinner === winner) {
    return { pile: { size: 0, lastWinner: null }, collected: size };
  }
  return { pile: { size, lastWinner: winner }, collected: 0 };
}

// ------------------------- trump & tricks -------------------------

/**
 * Who wins a finished trick?
 * Trump cards win, but only trumps that were played AFTER the trump was revealed, and only if
 * they are not simply cards of the suit that was led. Otherwise the highest card of the suit led wins.
 */
export function trickWinner(plays: readonly Play[]): Seat {
  const first = plays[0];
  if (!first) fail('Empty trick');
  const led = first.card.suit;
  const trumps = plays.filter((p) => p.asTrump && p.card.suit !== led);
  const pool = trumps.length > 0 ? trumps : plays.filter((p) => p.card.suit === led);
  let best = pool[0] as Play;
  for (const p of pool) if (p.card.rank > best.card.rank) best = p;
  return best.seat;
}

/** The next player who actually plays (skips a partner who is sitting out in a 52 call). */
function nextPlayer(r: RoundState, seat: Seat): Seat {
  let s = nextSeat(seat);
  if (r.sitOut === s) s = nextSeat(s);
  return s;
}

function cardsPerTrick(r: RoundState): number {
  return r.sitOut === null ? 4 : 3;
}

/** The cards a seat may legally play right now. */
export function playableCards(r: RoundState, seat: Seat): Card[] {
  const hand = r.hands[seat] as Card[];

  // Last trick, trump never revealed: the hidden card is the auction winner's only card left.
  if (hand.length === 0 && r.hiddenCard && seat === r.auctionWinner) return [r.hiddenCard];

  // A player who has just revealed the trump must play a trump if he can.
  if (r.mustTrump && r.trump) {
    const trumps = hand.filter((c) => c.suit === r.trump);
    return trumps.length > 0 ? trumps : [...hand];
  }

  const led = r.trick.plays[0]?.card.suit;
  if (!led) return [...hand]; // leading: anything
  const follow = hand.filter((c) => c.suit === led);
  return follow.length > 0 ? follow : [...hand]; // must follow suit if possible
}

/** May this seat ask for / reveal the trump right now? */
function canRevealTrump(r: RoundState, seat: Seat): boolean {
  if (r.phase !== 'play' || seat !== r.turn) return false;
  if (!r.hiddenCard || r.trumpRevealed || r.mustTrump) return false;
  const led = r.trick.plays[0]?.card.suit;
  if (!led) return seat === r.auctionWinner; // the auction winner may reveal when on lead
  const hand = r.hands[seat] as Card[];
  if (hand.length === 0) return false; // last card: nothing to decide
  return !hand.some((c) => c.suit === led); // anyone who cannot follow suit may ask
}

/** May the auction winner call "5 cards" right now? */
function canCallFive(r: RoundState, seat: Seat): boolean {
  if (r.phase !== 'play' || r.auctionWinner === null || seat !== r.auctionWinner) return false;
  if (r.call !== null) return false; // not with a 26/52 (or an earlier 5 cards call)
  if (r.trick.plays.length !== 0) return false; // only between tricks
  if (TRICKS_PER_ROUND - r.trickNumber <= 5) return false; // needs MORE than 5 cards left in each hand
  return r.collected[otherTeam(teamOf(seat))] === 0; // the opponents must have collected nothing
}

// ------------------------- creating games and rounds -------------------------

export interface StartOptions {
  /** A full 52-card deck in dealing order (for tests/replays). Otherwise a shuffled deck. */
  deck?: Card[];
  rng?: () => number;
}

function newRound(dealer: Seat, opts: StartOptions): RoundState {
  const deck = opts.deck ? [...opts.deck] : shuffle(createDeck(), opts.rng ?? Math.random);
  if (deck.length !== 52) throw new Error('A deck needs 52 cards');

  // First batch: 5 cards to each player, starting with the player to the dealer's left.
  const hands: Card[][] = [[], [], [], []];
  let i = 0;
  let seat = nextSeat(dealer);
  for (let n = 0; n < 4; n++) {
    hands[seat] = deck.slice(i, i + 5);
    i += 5;
    seat = nextSeat(seat);
  }
  const first = nextSeat(dealer);
  return {
    phase: 'bidding',
    dealer,
    turn: first,
    hands,
    stock: deck.slice(i),
    bids: [null, null, null, null],
    highBid: 0,
    auctionWinner: null,
    hiddenCard: null,
    trump: null,
    trumpRevealed: false,
    callResponses: [null, null, null, null],
    call: null,
    sitOut: null,
    trick: { leader: first, plays: [] },
    lastTrick: null,
    trickNumber: 0,
    pileSize: 0,
    lastTrickWinner: null,
    collected: [0, 0],
    mustTrump: false,
    outcome: null,
  };
}

/** Start a brand new game. The first dealer is chosen at random unless you say otherwise. */
export function newGame(opts: StartOptions & { dealer?: Seat } = {}): GameState {
  const rng = opts.rng ?? Math.random;
  const dealer = opts.dealer ?? (Math.floor(rng() * 4) as Seat);
  return {
    netScore: 0,
    roundNumber: 1,
    redeals: 0,
    winner: null,
    round: newRound(dealer, opts),
  };
}

/** After a round is over: deal the next one. The deal passes one player clockwise. */
export function startNextRound(game: GameState, opts: StartOptions = {}): GameState {
  if (game.round.phase !== 'round_over') fail('The round is not over yet');
  const g = structuredClone(game);
  g.roundNumber += 1;
  g.round = newRound(nextSeat(game.round.dealer), opts);
  return g;
}

// ------------------------- which moves are legal -------------------------

/** Everything this seat is allowed to do right now. Empty if it is not their move. */
export function legalActions(game: GameState, seat: Seat): Action[] {
  const r = game.round;
  const out: Action[] = [];
  switch (r.phase) {
    case 'bidding': {
      if (seat !== r.turn) return out;
      out.push({ type: 'pass' });
      const min = minimumBid(r, seat);
      for (let amount = min; amount <= 13; amount++) out.push({ type: 'bid', amount });
      return out;
    }
    case 'hide_trump': {
      if (seat !== r.turn) return out;
      for (const card of r.hands[seat] as Card[]) out.push({ type: 'hide_trump', card });
      return out;
    }
    case 'calls': {
      if (seat !== r.turn) return out;
      out.push({ type: 'no_call' }, { type: 'call', kind: '26' }, { type: 'call', kind: '52' });
      return out;
    }
    case 'choose_trump': {
      if (seat !== r.turn) return out;
      for (const suit of SUITS) out.push({ type: 'choose_trump', suit });
      return out;
    }
    case 'play': {
      if (canCallFive(r, seat)) out.push({ type: 'call_five' });
      if (seat === r.turn) {
        if (canRevealTrump(r, seat)) out.push({ type: 'reveal_trump' });
        for (const card of playableCards(r, seat)) out.push({ type: 'play', card });
      }
      return out;
    }
    default:
      return out;
  }
}

/** The lowest bid this seat may make: 9, one more than the current high bid, or 8 for the dealer if everyone passed. */
function minimumBid(r: RoundState, seat: Seat): number {
  if (seat === r.dealer && r.highBid === 0) return 8;
  return Math.max(9, r.highBid + 1);
}

// ------------------------- making a move -------------------------

/** Make a move. Returns the NEW game state (the old one is left untouched). Throws IllegalMoveError if the move is not allowed. */
export function applyAction(game: GameState, seat: Seat, action: Action, opts: StartOptions = {}): GameState {
  const g = structuredClone(game);
  const r = g.round;

  switch (action.type) {
    case 'bid':
    case 'pass':
      doBid(g, seat, action.type === 'bid' ? action.amount : 0, opts);
      break;
    case 'hide_trump':
      doHideTrump(r, seat, action.card);
      break;
    case 'call':
    case 'no_call':
      doCallResponse(r, seat, action.type === 'call' ? action.kind : 'none');
      break;
    case 'choose_trump':
      doChooseTrump(r, seat, action.suit);
      break;
    case 'reveal_trump':
      doRevealTrump(r, seat);
      break;
    case 'call_five':
      if (!canCallFive(r, seat)) fail('You cannot call 5 cards now');
      r.call = { kind: 'five', caller: seat };
      break;
    case 'play':
      doPlay(g, seat, action.card);
      break;
  }
  return g;
}

// ---- bidding ----

function doBid(g: GameState, seat: Seat, amount: number, opts: StartOptions): void {
  const r = g.round;
  if (r.phase !== 'bidding') fail('It is not the bidding phase');
  if (seat !== r.turn) fail('It is not your turn to bid');
  if (amount !== 0) {
    if (!Number.isInteger(amount) || amount > 13) fail('A bid must be a whole number up to 13');
    if (amount < minimumBid(r, seat)) fail(`Your bid must be at least ${minimumBid(r, seat)}`);
    r.highBid = amount;
    r.auctionWinner = seat;
  }
  r.bids[seat] = amount;

  if (r.bids.some((b) => b === null)) {
    r.turn = nextSeat(seat);
    return;
  }
  // Everyone has spoken.
  if (r.highBid === 0) {
    // All four passed: throw the cards in, the next dealer deals again.
    g.redeals += 1;
    g.round = newRound(nextSeat(r.dealer), opts);
    return;
  }
  r.phase = 'hide_trump';
  r.turn = r.auctionWinner as Seat;
}

// ---- hiding the trump card, then dealing the rest ----

function doHideTrump(r: RoundState, seat: Seat, card: Card): void {
  if (r.phase !== 'hide_trump') fail('It is not time to hide the trump');
  if (seat !== r.turn) fail('Only the auction winner hides the trump');
  const hand = r.hands[seat] as Card[];
  if (!hasCard(hand, card)) fail('You can only hide a card from your hand');
  removeCard(hand, card);
  r.hiddenCard = card;
  r.trump = card.suit;
  r.trumpRevealed = false;

  // Deal the remaining 32 cards in two batches of four, starting left of the dealer.
  let i = 0;
  for (let batch = 0; batch < 2; batch++) {
    let s = nextSeat(r.dealer);
    for (let n = 0; n < 4; n++) {
      (r.hands[s] as Card[]).push(...r.stock.slice(i, i + 4));
      i += 4;
      s = nextSeat(s);
    }
  }
  r.stock = [];

  r.phase = 'calls';
  r.turn = nextSeat(r.dealer);
}

// ---- 26 / 52 calls ----

function doCallResponse(r: RoundState, seat: Seat, response: '26' | '52' | 'none'): void {
  if (r.phase !== 'calls') fail('It is not the time for 26/52 calls');
  if (seat !== r.turn) fail('It is not your turn');
  r.callResponses[seat] = response;

  if (r.callResponses.some((c) => c === null)) {
    r.turn = nextSeat(seat);
    return;
  }

  // Everyone has answered. 52 beats 26; between equal calls the first to speak (left of the dealer) wins.
  let chosen: { kind: '26' | '52'; caller: Seat } | null = null;
  let s = nextSeat(r.dealer);
  for (let n = 0; n < 4; n++) {
    const c = r.callResponses[s];
    if (c === '52' && (!chosen || chosen.kind === '26')) chosen = { kind: '52', caller: s };
    else if (c === '26' && !chosen) chosen = { kind: '26', caller: s };
    s = nextSeat(s);
  }

  if (!chosen) {
    // Normal round: the auction winner leads, trump stays hidden.
    startPlay(r, r.auctionWinner as Seat);
    return;
  }

  // The auction is cancelled: the auction winner takes his hidden card back.
  if (r.hiddenCard && r.auctionWinner !== null) {
    (r.hands[r.auctionWinner] as Card[]).push(r.hiddenCard);
  }
  r.hiddenCard = null;
  r.trump = null;
  r.trumpRevealed = false;
  r.call = { kind: chosen.kind, caller: chosen.caller };
  if (chosen.kind === '52') r.sitOut = partnerOf(chosen.caller);
  r.phase = 'choose_trump';
  r.turn = chosen.caller;
}

function doChooseTrump(r: RoundState, seat: Seat, suit: Suit): void {
  if (r.phase !== 'choose_trump') fail('It is not time to choose the trump');
  if (seat !== r.turn) fail('Only the caller chooses the trump');
  r.trump = suit;
  r.trumpRevealed = true; // named openly: trump is live from the first trick
  startPlay(r, seat);
}

function startPlay(r: RoundState, leader: Seat): void {
  r.phase = 'play';
  r.turn = leader;
  r.trick = { leader, plays: [] };
}

// ---- asking for / revealing the trump ----

function doRevealTrump(r: RoundState, seat: Seat): void {
  if (!canRevealTrump(r, seat)) fail('You cannot ask for the trump now');
  const owner = r.auctionWinner as Seat;
  // The hidden card is turned face up and goes back into its owner's hand.
  (r.hands[owner] as Card[]).push(r.hiddenCard as Card);
  r.hiddenCard = null;
  r.trumpRevealed = true;
  r.mustTrump = true; // whoever revealed must now play a trump if they can
}

// ---- playing a card ----

function doPlay(g: GameState, seat: Seat, card: Card): void {
  const r = g.round;
  if (r.phase !== 'play') fail('It is not the playing phase');
  if (seat !== r.turn) fail('It is not your turn');
  if (!playableCards(r, seat).some((c) => sameCard(c, card))) {
    fail('You must follow suit (or, if you cannot, play a trump when you have asked for one)');
  }

  if (r.hiddenCard && sameCard(card, r.hiddenCard)) {
    // The hidden card can only be played as the very last card; playing it reveals the trump.
    r.hiddenCard = null;
    r.trumpRevealed = true;
  } else {
    removeCard(r.hands[seat] as Card[], card);
  }
  r.mustTrump = false;

  const asTrump = r.trumpRevealed && r.trump === card.suit;
  r.trick.plays.push({ seat, card, asTrump });

  if (r.trick.plays.length < cardsPerTrick(r)) {
    r.turn = nextPlayer(r, seat);
    return;
  }
  finishTrick(g);
}

function finishTrick(g: GameState): void {
  const r = g.round;
  const winner = trickWinner(r.trick.plays);
  r.trickNumber += 1;

  const { pile, collected } = advancePile(
    { size: r.pileSize, lastWinner: r.lastTrickWinner },
    winner,
    r.trickNumber === TRICKS_PER_ROUND,
  );
  r.pileSize = pile.size;
  r.lastTrickWinner = pile.lastWinner;
  r.collected[teamOf(winner)] += collected;

  // Remember the trick for display, then the winner leads next.
  r.lastTrick = { plays: r.trick.plays, winner, collected };
  r.trick = { leader: winner, plays: [] };
  r.turn = winner;

  const outcome = evaluateRound(r);
  if (outcome) finishRound(g, outcome);
}

// ------------------------- ending a round -------------------------

/**
 * Is the round decided yet? Returns the outcome if so, otherwise null.
 *  - Ordinary bid: success once the bidding team has collected its bid;
 *    failure once the other team has collected 14 minus the bid (so the bid can no longer be made).
 *  - 26 / 52 / 5 cards: failure the moment the other team collects any trick; success after all 13 are collected.
 */
export function evaluateRound(r: RoundState): RoundOutcome | null {
  const collected: [number, number] = [r.collected[0], r.collected[1]];

  if (r.call) {
    const team = r.call.kind === 'five' ? teamOf(r.auctionWinner as Seat) : teamOf(r.call.caller);
    const [win, lose] = stakes(r.call.kind, r.highBid);
    if (collected[otherTeam(team)] >= 1) {
      return { type: r.call.kind, team, success: false, scoringTeam: otherTeam(team), points: lose, collected };
    }
    if (collected[team] === TRICKS_PER_ROUND) {
      return { type: r.call.kind, team, success: true, scoringTeam: team, points: win, collected };
    }
    return null;
  }

  if (r.auctionWinner === null) return null;
  const team = teamOf(r.auctionWinner);
  const bid = r.highBid;
  const [win, lose] = stakes('bid', bid);
  if (collected[team] >= bid) {
    return { type: 'bid', team, success: true, scoringTeam: team, points: win, collected };
  }
  if (collected[otherTeam(team)] >= TRICKS_PER_ROUND + 1 - bid) {
    return { type: 'bid', team, success: false, scoringTeam: otherTeam(team), points: lose, collected };
  }
  return null;
}

function finishRound(g: GameState, outcome: RoundOutcome): void {
  const r = g.round;
  r.outcome = outcome;
  g.netScore = applyPoints(g.netScore, outcome.scoringTeam, outcome.points);
  const { team, points } = scoreHolder(g.netScore);
  if (team !== null && points >= TARGET_SCORE) {
    g.winner = team;
    r.phase = 'game_over';
  } else {
    r.phase = 'round_over';
  }
}

/** Whose move is it (for the phases where one player acts at a time)? null if the round/game is over. */
export function currentActor(game: GameState): Seat | null {
  const p = game.round.phase;
  return p === 'round_over' || p === 'game_over' ? null : game.round.turn;
}
