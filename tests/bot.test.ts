import { describe, expect, it } from 'vitest';
import { chooseAction } from '../src/bot';
import { cardToString, seededRng } from '../src/cards';
import { applyAction, legalActions, newGame, startNextRound } from '../src/engine';
import { RoomManager } from '../src/server/rooms';
import { MemoryStore } from '../src/server/store';
import type { Action, GameState, Seat } from '../src/types';
import { viewFor } from '../src/view';
import { playState } from './helpers';

/** A deliberately silly opponent: any legal move, but it avoids the big calls. */
function randomAction(g: GameState, seat: Seat, rng: () => number): Action {
  const all = legalActions(g, seat).filter((a) => a.type !== 'call' && a.type !== 'call_five');
  return all[Math.floor(rng() * all.length)] as Action;
}

/** Plays a whole game. `botSeats` use the bot, everyone else plays randomly. Returns the winning team. */
function playGame(seed: number, botSeats: Seat[]): { winner: number; rounds: number } {
  const rng = seededRng(seed);
  let g = newGame({ rng });
  let guard = 0;
  while (g.winner === null) {
    if (++guard > 30000) throw new Error('game did not finish');
    if (g.round.phase === 'round_over') { g = startNextRound(g, { rng }); continue; }
    const seat = g.round.turn;
    const action = botSeats.includes(seat) ? chooseAction(viewFor(g, seat)) : randomAction(g, seat, rng);
    g = applyAction(g, seat, action, { rng }); // throws if the bot ever picks an illegal move
  }
  return { winner: g.winner, rounds: g.roundNumber };
}

describe('the bot', () => {
  it('four bots play 40 whole games without ever making an illegal move', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = playGame(seed, [0, 1, 2, 3]);
      expect([0, 1]).toContain(r.winner);
    }
  }, 120_000);

  it('a bot team beats a random-play team clearly (as team 0 and as team 1)', () => {
    let botWins = 0;
    const games = 60;
    for (let seed = 100; seed < 100 + games; seed++) {
      const botsAreTeam0 = seed % 2 === 0;
      const r = playGame(seed, botsAreTeam0 ? [0, 2] : [1, 3]);
      if ((r.winner === 0) === botsAreTeam0) botWins++;
    }
    console.log(`bots won ${botWins} of ${games}`);
    expect(botWins / games).toBeGreaterThan(0.65);
  }, 120_000);

  it('never looks at hidden information: it only needs the view', () => {
    const g = newGame({ rng: seededRng(5), dealer: 3 });
    const view = viewFor(g, 0);
    expect('hands' in view).toBe(false);
    expect(chooseAction(view).type).toMatch(/bid|pass/);
  });
});

describe('rooms with computer players', () => {
  it('lets a human add computers, start, and play a round while the bots answer', () => {
    const m = new RoomManager(new MemoryStore(), seededRng(8));
    const { room, player: human } = m.create('Manu');
    expect(() => m.addBot(room.code, human.token, 0)).toThrow(/taken/);
    for (const seat of [1, 2, 3] as Seat[]) m.addBot(room.code, human.token, seat);
    expect(() => m.join(room.code, 'Late')).toThrow(/full/);
    m.removeBot(room.code, human.token, 3);
    m.addBot(room.code, human.token, 3);
    expect(m.info(room, human).seats.map((s) => s?.bot)).toEqual([false, true, true, true]);
    m.start(room.code, human.token);

    const rng = seededRng(9);
    let guard = 0;
    while (room.game!.round.phase !== 'round_over' && room.game!.round.phase !== 'game_over') {
      if (++guard > 2000) throw new Error('stuck');
      if (m.botToAct(room.code)) { m.botTurn(room.code); continue; }
      const acts = legalActions(room.game!, human.seat).filter((a) => a.type !== 'call' && a.type !== 'call_five');
      m.act(room.code, human.token, acts[Math.floor(rng() * acts.length)] as Action);
    }
    expect(room.game!.round.outcome).not.toBeNull();
  });
});

describe('opening a trick when the pile is empty', () => {
  const lead = (hand: string) => {
    const g = playState({ hands: [hand, '2D 3D 4D 5D', '6D 7D 8D 9D', '2C 3C 4C 5C'], leader: 0, trump: 'H', hidden: '2H' });
    const a = chooseAction(viewFor(g, 0));
    return a.type === 'play' ? cardToString(a.card) : a.type;
  };

  it('keeps the Ace back and leads the King of the same suit', () => {
    expect(lead('AS KS 9C 4D')).toBe('KS');
  });
  it('with two Aces, leads the highest non-Ace instead', () => {
    expect(lead('AS AC 10D 4D')).toBe('10D');
  });
  it('never spends an Ace as the opener if it has anything else', () => {
    expect(lead('AS AC 3D')).toBe('3D');
  });
  it('still plays the Ace when it is already holding the pending win', () => {
    const g = playState({ hands: ['AS KS 4D 9C', '2D 3D', '6D 7D', '2C 3C'], leader: 0, trump: 'H', hidden: '2H' });
    g.round.pileSize = 4;
    g.round.lastTrickWinner = 0;
    g.round.lastTrick = { plays: [], winner: 0, collected: false } as never;
    const a = chooseAction(viewFor(g, 0));
    expect(a.type === 'play' && cardToString(a.card)).toBe('AS');
  });
});
