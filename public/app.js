// ---------------------------------------------------------------------------
// app.js: the web page. It does three things:
//   1. keeps a live connection to the server (WebSocket) and remembers who you are,
//   2. receives "update" messages (the room, plus YOUR view of the game),
//   3. draws the screen from that data, and sends your clicks back as moves.
// The page never decides whether a move is legal. The server does. The page just
// shows the buttons and cards the server says are allowed.
// ---------------------------------------------------------------------------

const SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_NAME = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };
const SUIT_ORDER = ['S', 'H', 'C', 'D']; // alternating black/red looks tidy in a hand
const RANK = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const POSITIONS = ['bottom', 'left', 'top', 'right']; // seat relative to me, going clockwise

const state = {
  connected: false,
  session: loadSession(), // { code, token, name } remembered in this browser
  room: null,
  view: null,
  draftName: localStorage.getItem('dussar.name') || '',
  draftCode: new URLSearchParams(location.search).get('room')?.toUpperCase().slice(0, 4) || '',
  pendingName: '',
};
let ws = null;

// ------------------------------------------------------------ helpers
function loadSession() {
  try { return JSON.parse(localStorage.getItem('dussar.session') || 'null'); } catch { return null; }
}
function saveSession(s) {
  state.session = s;
  try { s ? localStorage.setItem('dussar.session', JSON.stringify(s)) : localStorage.removeItem('dussar.session'); } catch { /* private mode */ }
}
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const key = (c) => `${c.suit}${c.rank}`;
const isRed = (suit) => suit === 'H' || suit === 'D';

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
let toastTimer;
function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

// ------------------------------------------------------------ connection
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    state.connected = true;
    // Coming back (page refresh or lost signal): rejoin the same seat using our saved token.
    if (state.session) send({ t: 'join', code: state.session.code, name: state.session.name, token: state.session.token });
    render();
  };
  ws.onmessage = (ev) => handleMessage(JSON.parse(ev.data));
  ws.onclose = () => {
    state.connected = false;
    render();
    setTimeout(connect, 1500);
  };
}

function handleMessage(m) {
  if (m.t === 'joined') {
    saveSession({ code: m.code, token: m.token, name: state.session?.name || state.pendingName });
    history.replaceState(null, '', location.pathname);
  } else if (m.t === 'update') {
    state.room = m.room;
    state.view = m.view;
    render();
  } else if (m.t === 'error') {
    toast(m.message);
    // If our saved room no longer exists, go back to the start screen.
    if (!state.room && state.session) { saveSession(null); render(); }
  }
}

// ------------------------------------------------------------ names & teams
const seatName = (seat) => state.room?.seats[seat]?.name ?? `Seat ${seat + 1}`;
const teamName = (team) => `${seatName(team)} & ${seatName(team + 2)}`;
const rel = (seat) => (seat - state.room.youSeat + 4) % 4;

function cardHtml(c, extra = '', attrs = '') {
  return `<button class="card ${isRed(c.suit) ? 'red' : ''} ${extra}" ${attrs} aria-label="${RANK[c.rank]} of ${SUIT_NAME[c.suit]}"><span class="r">${RANK[c.rank]}</span><span class="s">${SYMBOL[c.suit]}</span></button>`;
}
function staticCard(c, extra = '') {
  return `<div class="card ${isRed(c.suit) ? 'red' : ''} ${extra}" role="img" aria-label="${RANK[c.rank]} of ${SUIT_NAME[c.suit]}"><span class="r">${RANK[c.rank]}</span><span class="s">${SYMBOL[c.suit]}</span></div>`;
}
const backCard = (extra = '') => `<div class="card back ${extra}" role="img" aria-label="face-down card"></div>`;

// ------------------------------------------------------------ screens
function render() {
  const app = document.getElementById('app');
  document.title = 'Dussar';
  const banner = state.connected ? '' : '<div class="conn">Reconnecting…</div>';
  if (!state.room) { app.innerHTML = banner + homeHtml(); wireHome(); return; }
  if (!state.room.started || !state.view) { app.innerHTML = banner + lobbyHtml(); return; }
  app.innerHTML = banner + gameHtml();
  const v = state.view;
  if (v.turn === v.seat && v.phase !== 'round_over' && v.phase !== 'game_over') document.title = '● Your turn — Dussar';
}

function homeHtml() {
  const joining = state.draftCode.length === 4;
  return `
  <div class="screen home stack">
    <div>
      <h1>Dussar</h1>
      <p class="tag">Win two tricks in a row to collect the cards.</p>
    </div>
    <label>Your name
      <input id="name" type="text" maxlength="20" autocomplete="nickname" value="${esc(state.draftName)}" placeholder="e.g. Manu">
    </label>
    <button class="btn" data-act="create" ${state.connected ? '' : 'disabled'}>Create a room</button>
    <div class="divider">or join a room someone else made</div>
    <div class="row">
      <input id="code" type="text" maxlength="4" autocapitalize="characters" autocomplete="off" placeholder="Room code" value="${esc(state.draftCode)}" aria-label="Room code">
      <button class="btn ${joining ? '' : 'secondary'}" data-act="join" ${state.connected ? '' : 'disabled'}>Join</button>
    </div>
  </div>`;
}

function wireHome() {
  const name = document.getElementById('name');
  const code = document.getElementById('code');
  name?.addEventListener('input', () => { state.draftName = name.value; try { localStorage.setItem('dussar.name', name.value); } catch {} });
  code?.addEventListener('input', () => { state.draftCode = code.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); code.value = state.draftCode; });
}

function lobbyHtml() {
  const r = state.room;
  const taken = r.seats.filter(Boolean).length;
  const link = `${location.origin}/?room=${r.code}`;
  const seatBtn = (seat) => {
    const s = r.seats[seat];
    const pos = POSITIONS[rel(seat)];
    const me = seat === r.youSeat;
    const partner = seat === (r.youSeat + 2) % 4;
    const label = me ? 'You' : partner ? 'Your partner' : 'Opponent';
    if (s) {
      const note = s.bot ? `Computer player · ${label.toLowerCase()}` : `${label}${s.connected ? '' : ' <span class="offline">· offline</span>'}`;
      const remove = s.bot ? `<button class="btn small secondary" data-act="remove_bot" data-seat="${seat}">Remove</button>` : '';
      return `<div class="seat-pick taken ${me ? 'me' : ''}" style="grid-area:${pos}"><b>${esc(s.name)}</b><small>${note}</small>${remove}</div>`;
    }
    return `<div class="seat-pick" style="grid-area:${pos}"><b>Empty seat</b><small>${label}</small>
      <div class="btns seat-btns"><button class="btn small" data-act="sit" data-seat="${seat}">Sit here</button><button class="btn small secondary" data-act="add_bot" data-seat="${seat}">Add computer</button></div></div>`;
  };
  return `
  <div class="screen stack">
    <h2>Waiting for players</h2>
    <div class="code-box">
      <div class="meta">Room code. Share it, or send the link below.</div>
      <div class="code-big" aria-label="Room code ${r.code.split('').join(' ')}">${r.code}</div>
      <div class="row" style="margin-top:8px">
        <input type="text" readonly value="${esc(link)}" aria-label="Invite link" onclick="this.select()">
        <button class="btn small secondary" data-act="copy" data-link="${esc(link)}">Copy link</button>
      </div>
    </div>
    <div class="lobby-grid">${[0, 1, 2, 3].map(seatBtn).join('')}</div>
    <p class="meta">Partners sit opposite each other. Short of players? Add a computer player to any empty seat.</p>
    <button class="btn" data-act="start" ${taken === 4 ? '' : 'disabled'}>${taken === 4 ? 'Start the game' : `Waiting for ${4 - taken} more player${4 - taken === 1 ? '' : 's'}…`}</button>
  </div>`;
}

// ------------------------------------------------------------ the game table
function gameHtml() {
  const v = state.view;
  return `
  <div class="game">
    ${topbarHtml(v)}
    <div class="table">
      ${[0, 1, 2, 3].map((seat) => plateHtml(v, seat)).join('')}
      ${centreHtml(v)}
    </div>
    <div class="panel">${panelHtml(v)}</div>
    ${handHtml(v)}
    ${rulesHtml()}
  </div>`;
}

function topbarHtml(v) {
  const holder = v.netScore > 0 ? 0 : v.netScore < 0 ? 1 : null;
  const pts = Math.abs(v.netScore);
  const chip = (team) => `<div class="scorechip t${team} ${holder === team ? 'holder' : ''}"><b>${holder === team ? pts : 0}</b> <span class="meta">/ 104</span><div class="names">${esc(teamName(team))}</div></div>`;
  return `<div class="topbar"><div class="chips">${chip(0)}${chip(1)}</div><div class="meta">Room ${state.room.code} · Round ${v.roundNumber}</div></div>`;
}

function plateHtml(v, seat) {
  const info = state.room.seats[seat];
  const me = seat === v.seat;
  const active = v.phase !== 'round_over' && v.phase !== 'game_over';
  const cls = ['plate', `pos-${POSITIONS[rel(seat)]}`, `t${seat % 2}`, active && v.turn === seat ? 'turn' : '', info?.connected === false ? 'off' : ''].join(' ');
  const badges = [];
  if (v.dealer === seat) badges.push('<span class="badge dim">Dealer</span>');
  if (v.auctionWinner === seat && v.phase !== 'bidding' && !v.call) badges.push(`<span class="badge">Bid ${v.highBid}</span>`);
  if (v.call && v.call.caller === seat) badges.push(`<span class="badge">${v.call.kind === 'five' ? '5 cards' : v.call.kind + ' call'}</span>`);
  if (v.call?.kind === 'five' && v.auctionWinner === seat) badges.push('<span class="badge">5 cards</span>');
  if (v.phase === 'bidding' && v.bids[seat] !== null) badges.push(`<span class="badge ${v.bids[seat] === 0 ? 'dim' : ''}">${v.bids[seat] === 0 ? 'Pass' : v.bids[seat]}</span>`);
  if (v.sitOut === seat) badges.push('<span class="badge dim">Sitting out</span>');
  const sub = `${info?.bot ? 'Computer · ' : ''}${v.handCounts[seat]} card${v.handCounts[seat] === 1 ? '' : 's'}${info?.connected === false ? ' · offline' : ''}`;
  let exposed = '';
  if (v.exposedHand && v.exposedHand.seat === seat && !me) {
    exposed = `<div class="exposed">${sortCards(v.exposedHand.cards).map((c) => staticCard(c)).join('')}</div>`;
  }
  return `<div class="${cls}"><div class="pname">${esc(info?.name ?? '?')}${me ? ' (you)' : ''}</div><div class="psub">${sub}</div><div>${badges.join('')}</div>${exposed}</div>`;
}

function trumpChipHtml(v) {
  if (v.trump && v.trumpRevealed) return `<div class="trump-chip ${isRed(v.trump) ? 'red' : ''}">Trump ${SYMBOL[v.trump]}</div>`;
  if (v.hiddenCard) return `<div class="trump-chip hidden">Your hidden trump ${SYMBOL[v.hiddenCard.suit]}</div>`;
  if (v.hasHiddenCard) return '<div class="trump-chip hidden">Trump hidden</div>';
  return '';
}

function centreHtml(v) {
  const playing = v.phase === 'play' || v.phase === 'round_over' || v.phase === 'game_over';
  let slots = '';
  let caption = '';
  const showLast = v.trick.plays.length === 0 && v.lastTrick && playing;
  const plays = showLast ? v.lastTrick.plays : v.trick.plays;
  for (const p of plays) {
    slots += `<div class="slot s-${POSITIONS[rel(p.seat)]} ${showLast ? 'faded' : ''}">${staticCard(p.card)}</div>`;
  }
  if (showLast) {
    const lt = v.lastTrick;
    caption = `Last trick: ${esc(seatName(lt.winner))} won.${lt.collected ? ` Collected ${lt.collected} for ${esc(teamName(lt.winner % 2))}.` : ' Left in the pile.'}`;
  }
  const collected = playing || v.pileSize || v.trickNumber
    ? `<div>Collected: <span class="c0">${v.collected[0]}</span> – <span class="c1">${v.collected[1]}</span></div>` : '';
  const pile = playing ? `<div class="big">Pile: ${v.pileSize}</div>` : '';
  return `<div class="centre">${slots}<div class="centre-info">${trumpChipHtml(v)}${pile}${collected}<div class="meta">${caption}</div></div></div>`;
}

function sortCards(cards) {
  return [...cards].sort((a, b) => SUIT_ORDER.indexOf(a.suit) - SUIT_ORDER.indexOf(b.suit) || b.rank - a.rank);
}

function handHtml(v) {
  const legal = new Set(v.legalActions.filter((a) => a.type === 'play' || a.type === 'hide_trump').map((a) => key(a.card)));
  const myTurn = v.turn === v.seat;
  const kind = v.phase === 'hide_trump' ? 'hide_trump' : 'play';
  const cards = sortCards(v.hand).map((c) => {
    const ok = legal.has(key(c));
    if (ok) return cardHtml(c, 'legal', `data-act="card" data-kind="${kind}" data-suit="${c.suit}" data-rank="${c.rank}"`);
    return cardHtml(c, myTurn && (v.phase === 'play' || v.phase === 'hide_trump') ? 'dim' : '', 'disabled');
  }).join('');
  const hidden = v.hiddenCard
    ? `<div class="hidden-slot">${staticCard(v.hiddenCard)}<span>Your hidden trump card. It can't be played until the trump is revealed.</span></div>` : '';
  const label = v.sitOut === v.seat ? '<div class="meta">You are sitting out this round. Your hand is shown to everyone.</div>' : '';
  return `<div class="hand-wrap">${label}<div class="hand" aria-label="Your hand">${cards}</div>${hidden}</div>`;
}

// ------------------------------------------------------------ the action panel
function panelHtml(v) {
  const myTurn = v.turn === v.seat;
  const who = `<b>${esc(seatName(v.turn))}</b>`;
  const has = (type) => v.legalActions.some((a) => a.type === type);
  switch (v.phase) {
    case 'bidding': {
      const high = v.auctionWinner !== null ? `Highest bid so far: <b>${v.highBid}</b> by ${esc(seatName(v.auctionWinner))}.` : 'No bids yet.';
      if (!myTurn) return `<div class="status">Waiting for ${who} to bid… ${high}</div>`;
      const bids = v.legalActions.filter((a) => a.type === 'bid').map((a) => a.amount);
      const dealerNote = bids[0] === 8 ? ' You are the dealer and everyone passed, so you may bid 8.' : '';
      return `<div class="status"><b>Your bid.</b> How many of the 13 tricks will you and your partner collect? Decide from your first 5 cards. ${high}${dealerNote}</div>
        <div class="btns">${bids.map((n) => `<button class="btn" data-act="bid" data-amount="${n}">${n}</button>`).join('')}<button class="btn secondary" data-act="simple" data-type="pass">Pass</button></div>`;
    }
    case 'hide_trump':
      return myTurn
        ? `<div class="status"><b>You won the auction with ${v.highBid}.</b> Tap one card in your hand to hide it face down. Its suit becomes the trump, but nobody else will know it until it is revealed.</div>`
        : `<div class="status">${who} won the auction with ${v.highBid} and is hiding the trump card…</div>`;
    case 'calls':
      return myTurn
        ? `<div class="status"><b>Any special call?</b> Say <b>26</b> if you and your partner can take all 13 tricks, or <b>52</b> to play alone while your partner shows their hand. A call cancels the auction.</div>
           <div class="btns"><button class="btn secondary" data-act="simple" data-type="no_call">No call</button><button class="btn" data-act="call" data-kind="26">Call 26</button><button class="btn" data-act="call" data-kind="52">Call 52</button></div>`
        : `<div class="status">Waiting for ${who} to answer 26 / 52…</div>`;
    case 'choose_trump':
      return myTurn
        ? `<div class="status"><b>You called ${v.call.kind}.</b> Choose the trump suit. It is announced to everyone.</div>
           <div class="btns">${['S', 'H', 'D', 'C'].map((s) => `<button class="btn suit ${isRed(s) ? 'red' : ''}" data-act="trump" data-suit="${s}" aria-label="${SUIT_NAME[s]}">${SYMBOL[s]}</button>`).join('')}</div>`
        : `<div class="status">${who} called ${v.call.kind} and is choosing the trump…</div>`;
    case 'play': return playPanel(v, myTurn, who, has);
    case 'round_over':
    case 'game_over': return overPanel(v);
  }
  return '';
}

function playPanel(v, myTurn, who, has) {
  let line;
  if (v.sitOut === v.seat) line = `You are sitting out. ${who} to play.`;
  else if (!myTurn) line = `Waiting for ${who} to play…`;
  else {
    const led = v.trick.plays[0]?.card.suit;
    const plays = v.legalActions.filter((a) => a.type === 'play');
    if (!led) line = '<b>Your lead.</b> Play any card.';
    else if (plays.length && plays.every((a) => a.card.suit === led)) line = `<b>Your turn.</b> You must follow suit: <b>${SUIT_NAME[led]}</b>.`;
    else line = `<b>Your turn.</b> You have no ${SUIT_NAME[led]}${has('reveal_trump') ? ': play any card, or ask for the trump' : ': play any card'}.`;
  }
  const owner = v.auctionWinner === v.seat;
  const buttons = [];
  if (has('reveal_trump')) buttons.push(`<button class="btn secondary" data-act="simple" data-type="reveal_trump">${owner ? 'Reveal trump' : 'Ask for trump'}</button>`);
  if (has('call_five')) buttons.push('<button class="btn secondary" data-act="simple" data-type="call_five">Call 5 cards</button>');
  const progress = `<div class="meta">Trick ${Math.min(v.trickNumber + 1, 13)} of 13</div>`;
  return `<div class="status">${line}</div>${buttons.length ? `<div class="btns">${buttons.join('')}</div>` : ''}${progress}`;
}

function describeResult(v) {
  const o = v.outcome;
  if (!o) return '';
  const what = o.type === 'bid' ? `bid of ${v.highBid}` : o.type === 'five' ? '5 cards call' : `${o.type} call`;
  const verb = o.success ? 'made' : 'failed';
  return `<b>${esc(teamName(o.team))}</b> ${verb} their ${what}. <b>${esc(teamName(o.scoringTeam))}</b> score${o.points === 1 ? 's' : ''} <b>${o.points}</b>. Tricks collected: ${esc(teamName(0))} <span class="c0">${o.collected[0]}</span>, ${esc(teamName(1))} <span class="c1">${o.collected[1]}</span>.`;
}

function overPanel(v) {
  const result = `<div class="result">${describeResult(v)}</div>`;
  if (v.phase === 'game_over') {
    return `${result}<div class="status"><b>${esc(teamName(v.winner))} win the game!</b></div><div class="btns"><button class="btn" data-act="simple2" data-type="new_game">Play a new game</button></div>`;
  }
  return `${result}<div class="btns"><button class="btn" data-act="simple2" data-type="next_round">Deal the next round</button></div>`;
}

function rulesHtml() {
  return `<details><summary>Quick rules</summary><ul>
    <li>Win a trick and the cards stay in the middle. The <b>same player</b> must win two tricks in a row to collect the whole pile for their team. Partners winning one each does not count.</li>
    <li>The winner of the 13th trick collects whatever is left in the middle.</li>
    <li>Bid 9 to 13 tricks using your first 5 cards. The top bidder hides a card whose suit is the trump. If you can't follow suit you may ask for the trump to be shown, and then you must play a trump if you have one.</li>
    <li>Make your bid: score the bid. Fail: the other team scores double. Only one team holds points at a time. First to 104 wins.</li>
    <li>Call 26 (you and partner take every trick) or 52 (you alone) for bigger stakes.</li>
  </ul></details>`;
}

// ------------------------------------------------------------ clicks
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const d = el.dataset;
  switch (d.act) {
    case 'create': return startSession('create');
    case 'join': return startSession('join');
    case 'copy': return copyLink(d.link);
    case 'sit': return send({ t: 'sit', seat: Number(d.seat) });
    case 'add_bot': return send({ t: 'add_bot', seat: Number(d.seat) });
    case 'remove_bot': return send({ t: 'remove_bot', seat: Number(d.seat) });
    case 'start': return send({ t: 'start' });
    case 'bid': return send({ t: 'action', action: { type: 'bid', amount: Number(d.amount) } });
    case 'simple': return send({ t: 'action', action: { type: d.type } });
    case 'simple2': return send({ t: d.type });
    case 'call': return send({ t: 'action', action: { type: 'call', kind: d.kind } });
    case 'trump': return send({ t: 'action', action: { type: 'choose_trump', suit: d.suit } });
    case 'card': return send({ t: 'action', action: { type: d.kind, card: { suit: d.suit, rank: Number(d.rank) } } });
  }
});

function startSession(kind) {
  const name = document.getElementById('name').value.trim() || 'Player';
  state.pendingName = name;
  state.draftName = name;
  try { localStorage.setItem('dussar.name', name); } catch {}
  saveSession(null);
  if (kind === 'create') return send({ t: 'create', name });
  const code = document.getElementById('code').value.trim().toUpperCase();
  if (code.length !== 4) return toast('Enter the 4-letter room code');
  state.session = { code, token: undefined, name }; // name is saved properly once the server says "joined"
  send({ t: 'join', code, name });
}

async function copyLink(link) {
  try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch { toast('Select the link and copy it'); }
}

// A free host puts the server to sleep after 15 quiet minutes. A tiny message every 4 minutes,
// while this page is open, keeps the game alive.
setInterval(() => send({ t: 'ping' }), 4 * 60 * 1000);

connect();
render();
