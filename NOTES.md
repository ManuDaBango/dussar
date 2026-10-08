# Dussar: project notes

## What exists so far

Step 1: the rules engine. Step 2: the server (rooms, join codes, saved games) and the web page.
See README.md for the schematic.

### Step 1 files

    src/cards.ts    suits, ranks, the deck, shuffling
    src/types.ts    the shape of a game (state) and of every possible move (actions)
    src/engine.ts   ALL the rules: bidding, hiding trump, calls, tricks, collecting, scoring
    src/view.ts     what one player is allowed to see (hides other hands / the hidden trump)
    tests/          checks written from the rules document

Run the checks:   npm test        Check for typing mistakes:   npm run typecheck

## The idea

The engine is a "referee" with no screen and no internet. Two functions do the work:

    legalActions(game, seat)        what may this player do right now?
    applyAction(game, seat, move)   what is the game after this move? (or an error)

A human player (through a web page) and a computer player (a bot) will both use exactly
these two functions, so they follow identical rules.

## Rule choices that go beyond the written rules (please confirm)

1. Trump only counts for cards played AFTER it is revealed. A trump-suit card someone
   discarded earlier in the same trick (before anyone asked) does not count as a trump.
2. The score is one number: positive = Team 0 holds points, negative = Team 1.
   Any points a team gains first cancel the other team's points.
3. In 26 / 52 / 5-cards rounds a trick the opponents won but never collected does not
   count against the caller (only collected tricks count).
4. On the 13th trick, if the trump was never revealed, the hidden card is the auction
   winner's last card; playing it reveals the trump.
5. "5 cards" can be called between tricks while every hand has more than 5 cards.
