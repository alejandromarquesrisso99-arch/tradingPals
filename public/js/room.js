// One room = one market + up to 8 human players, run inside the host's browser.
// The room owns the clock: it advances the market every 200 ms and sends one compact update per tick.
// Players reach it through a `conn` ({ send(text), close() }): a WebRTC data channel for guests,
// a direct hand-off inside the page for the host (conn.local).
import { Market, CFG, BOT_DEFS, makeTrader, lobbyBots, rint } from './market.js';

const SIZES = new Set([0.25, 0.5, 1]);
const LOBBY_WAIT = 150;      // 30 s countdown in public rooms once someone joins
const QUICK_START = 15;      // 3 s once everyone is ready or the host presses start
const RESULTS_TICKS = 75;    // 15 s on the results screen before going back to the lobby
export const MAX_HUMANS = CFG.tableSize;

const r2 = n => Math.round(n * 100) / 100;
const candleOut = c => ({ i: c.i, o: r2(c.o), h: r2(c.h), l: r2(c.l), c: r2(c.c), bv: Math.round(c.bv), sv: Math.round(c.sv) });
const evOut = e => e.type === 'trade' ? { ...e, notional: Math.round(e.notional), px: r2(e.px) } : e;
const hex = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');
export const cleanName = n => String(n ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 18) || 'Jugador';

// Hidden tabs throttle setInterval to once a second, but timers inside a worker keep their pace,
// so the host can switch tabs without the game stuttering for everyone else.
function ticker(fn, ms) {
  try {
    const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms})`], { type: 'text/javascript' }));
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    w.onmessage = fn;
    return () => w.terminate();
  } catch (e) {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  }
}

export class Room {
  constructor({ code, isPrivate, mins = 5 }) {
    this.code = code;
    this.isPrivate = isPrivate;
    this.mins = mins;
    this.market = new Market();
    this.traders = lobbyBots();
    this.players = new Map();          // token -> player
    this.phase = 'lobby';
    this.countdown = null;             // tick at which the game starts
    this.game = null;
    this.results = null;
    this.backAt = 0;
    this.tape = [];                    // recent public events, for players who join mid-way
    this.sentCandle = 0;
    for (let i = 0; i < 30 * CFG.candleTicks; i++) this.market.step(this.traders);   // pre-market history
    this.market.events = [];
    this.sentCandle = this.market.cur().i;
    this.last = performance.now(); this.acc = 0;
    this.stopClock = ticker(() => this.loop(), 50);
  }

  // ---------- membership ----------
  humans() { return [...this.players.values()]; }
  connected() { return this.humans().filter(p => p.connected); }
  isFull() { return this.players.size >= MAX_HUMANS; }

  join(conn, msg) {
    if (conn.player) return;
    const name = cleanName(msg.name);
    if (typeof msg.token === 'string' && this.players.has(msg.token)) return this.addPlayer(conn, name, msg.token);
    // Quick match only fills public rooms that are still waiting for the bell; the guest then tries the next one.
    if (msg.quick && (this.isPrivate || this.phase !== 'lobby' || this.isFull())) return this.send({ conn }, { type: 'error', code: 'busy' });
    if (this.isFull()) return this.send({ conn }, { type: 'error', code: 'full', text: 'Esa sala está llena (8 jugadores).' });
    this.addPlayer(conn, name);
  }

  addPlayer(conn, name, token) {
    let p = token && this.players.get(token);
    if (p) {                                   // reconnect: same seat, same position
      // The same seat opened in another tab: the old one stops instead of reclaiming it.
      if (p.conn && p.conn !== conn) { this.send(p, { type: 'replaced' }); p.conn.player = null; p.conn.close(); }
      p.conn = conn; p.connected = true; p.goneAt = null;
    } else {
      const taken = new Set(this.humans().map(h => h.name));
      let nm = name, k = 2;
      while (taken.has(nm)) nm = `${name} (${k++})`;
      p = {
        id: 'p' + hex(4), token: hex(16),
        name: nm, conn, connected: true, ready: false,
        host: !!conn.local,                    // the player whose browser runs the room
        spectator: this.phase !== 'lobby',
        trader: null, sentVer: -1, bucket: { tokens: 5, at: Date.now() },
      };
      this.players.set(p.token, p);
    }
    conn.player = p;
    if (this.phase === 'lobby' && !this.isPrivate && this.countdown === null) this.countdown = this.market.tick + LOBBY_WAIT;
    if (this.phase === 'lobby' && this.players.size >= MAX_HUMANS) this.shortenCountdown(25);
    this.send(p, { type: 'welcome', id: p.id, token: p.token, code: this.code, host: p.host });
    this.send(p, this.snapshot(p));
    this.broadcastRoster();
  }

  removePlayer(conn, leaving) {
    const p = conn.player; if (!p || p.conn !== conn) return;
    conn.player = null;
    p.connected = false; p.conn = null;
    // Players in a running game keep their seat (and their position) until it ends.
    // Anyone else gets a short grace period to reconnect (e.g. a page reload).
    if (leaving) this.players.delete(p.token);
    else if (!p.trader) p.goneAt = Date.now();
    this.broadcastRoster();
  }

  // ---------- player actions ----------
  receive(conn, msg) {
    const p = conn.player;
    switch (msg.type) {
      case 'join': this.join(conn, msg); break;
      case 'leave': this.removePlayer(conn, true); break;
      case 'ready': if (p) this.setReady(p, msg.ready); break;
      case 'start': if (p) this.hostStart(p); break;
      case 'config': if (p) this.configure(p, msg.mins); break;
      case 'order': if (p) this.order(p, msg); break;
      case 'ping': this.send({ conn }, { type: 'pong', t: msg.t }); break;
    }
  }

  setReady(p, ready) {
    if (this.phase !== 'lobby') return;
    p.ready = !!ready;
    const hs = this.connected();
    if (hs.length && hs.every(h => h.ready) && (hs.length >= 2 || !this.isPrivate)) this.shortenCountdown(QUICK_START);
    this.broadcastRoster();
  }
  hostStart(p) {
    if (this.phase !== 'lobby' || !p.host || !this.isPrivate) return;
    this.shortenCountdown(QUICK_START);
    this.broadcastRoster();
  }
  configure(p, mins) {
    if (this.phase !== 'lobby' || !p.host || !this.isPrivate || ![1, 3, 5].includes(mins)) return;
    this.mins = mins;
    this.broadcastRoster();
  }
  shortenCountdown(ticks) {
    const t = this.market.tick + ticks;
    this.countdown = this.countdown === null ? t : Math.min(this.countdown, t);
  }

  order(p, msg) {
    const reject = reason => this.send(p, { type: 'reject', seq: msg.seq, reason });
    if (this.phase !== 'live' || !p.trader) return reject('Ahora mismo no puedes operar.');
    const b = p.bucket, now = Date.now();                  // 5 orders/s, bursts of 5
    b.tokens = Math.min(5, b.tokens + (now - b.at) / 200); b.at = now;
    if (b.tokens < 1) return reject('Demasiadas órdenes seguidas. Espera un momento.');
    b.tokens -= 1;
    const size = Number(msg.size);
    if (!SIZES.has(size) || !['buy', 'sell', 'close'].includes(msg.side)) return reject('Orden no válida.');
    const m = this.market, t = p.trader, px = m.price(), eq = m.equity(t);
    if (eq <= 0) return reject('Te has quedado sin patrimonio.');
    const maxPos = eq * CFG.lev / px;
    let q;
    if (msg.side === 'close') q = -t.pos;
    else {
      const target = msg.side === 'buy' ? Math.min(t.pos + size * eq / px, maxPos) : Math.max(t.pos - size * eq / px, -maxPos);
      q = Math.trunc(target - t.pos);
    }
    if (!q || Math.abs(q) < 1) return reject(msg.side === 'close' ? 'No tienes ninguna posición abierta.' : 'Has llegado al límite: 100 % de tu patrimonio.');
    const res = m.execute(t, q);
    p.sentVer = t.ver;
    this.send(p, { type: 'fill', seq: msg.seq, q, px: r2(res.px), eid: res.eid, notional: Math.round(res.notional), me: this.me(t) });
  }

  // ---------- game flow ----------
  startGame() {
    const hs = this.connected();
    for (const p of [...this.players.values()]) if (!p.connected) this.players.delete(p.token);
    for (const p of hs) { p.spectator = false; p.ready = false; p.trader = makeTrader(p.id, p.name, 'human'); p.sentVer = -1; }
    const bots = BOT_DEFS.slice(0, Math.max(0, CFG.tableSize - hs.length)).map((b, i) => makeTrader('b' + i, b[0], b[1]));
    this.traders = [...hs.map(p => p.trader), ...bots];
    const m = this.market;
    this.game = { start: m.tick, end: m.tick + Math.round(this.mins * 60000 / CFG.tickMs), mins: this.mins, startPrice: r2(m.price()), closeTicks: CFG.closeTicks };
    this.twapSum = 0; this.twapN = 0;
    this.phase = 'live'; this.countdown = null; this.results = null; this.tape = [];
    m.live = true; m.pending = []; m.nextNews = m.tick + rint(60, 150);
    m.emit({ type: 'sys', text: `Suena la campana: empieza la partida de ${this.mins} min` });
    this.broadcast({ type: 'start', game: this.game, players: this.traders.map(t => ({ id: t.id, name: t.name, bot: t.kind !== 'human' })) });
    for (const p of hs) { this.send(p, { type: 'me', me: this.me(p.trader) }); p.sentVer = p.trader.ver; }
    this.broadcastRoster();
  }

  endGame() {
    const m = this.market, settle = this.twapN ? this.twapSum / this.twapN : m.price();
    const rows = this.traders.map(t => {
      const eq = t.cash + t.pos * settle;
      return { id: t.id, name: t.name, bot: t.kind !== 'human', eq: Math.round(eq), pnl: eq / CFG.startCash - 1, trades: t.trades, liq: t.liq };
    }).sort((a, b) => b.eq - a.eq);
    for (const t of this.traders) { t.cash += t.pos * settle; t.pos = 0; t.avg = 0; t.st.q = 0; }
    this.results = { settle: r2(settle), rows };
    this.phase = 'ended'; this.backAt = m.tick + RESULTS_TICKS; m.live = false;
    m.emit({ type: 'sys', text: `Campana de cierre. Liquidación a ${settle.toFixed(2).replace('.', ',')} (media de los últimos 30 s)` });
    this.broadcast({ type: 'end', results: this.results });
  }

  toLobby() {
    for (const p of [...this.players.values()]) if (!p.connected) this.players.delete(p.token);
    for (const p of this.players.values()) { p.trader = null; p.spectator = false; p.ready = false; }
    this.traders = lobbyBots();
    this.game = null; this.results = null; this.phase = 'lobby';
    this.countdown = !this.isPrivate && this.connected().length ? this.market.tick + LOBBY_WAIT : null;
    this.broadcast({ type: 'lobby' });
    this.broadcastRoster();
  }

  // ---------- clock ----------
  loop() {
    const now = performance.now(); this.acc += now - this.last; this.last = now;
    if (this.acc > CFG.tickMs * 50) this.acc = CFG.tickMs * 50;     // never try to catch up more than 10 s
    let n = 0;
    while (this.acc >= CFG.tickMs) { this.step(); this.acc -= CFG.tickMs; n++; }
    if (n) this.flush();
    this.purgeGone();
  }

  purgeGone() {
    let changed = false;
    for (const p of [...this.players.values()]) {
      if (!p.connected && !p.trader && p.goneAt && Date.now() - p.goneAt > 10000) { this.players.delete(p.token); changed = true; }
    }
    if (changed) this.broadcastRoster();
  }

  step() {
    const m = this.market;
    m.step(this.traders);
    if (this.phase === 'lobby') {
      if (this.countdown !== null && m.tick >= this.countdown) {
        if (this.connected().length) this.startGame(); else this.countdown = null;
      }
    } else if (this.phase === 'live') {
      if (m.tick > this.game.end - CFG.closeTicks) { this.twapSum += m.price(); this.twapN++; }
      if (m.tick >= this.game.end) this.endGame();
    } else if (this.phase === 'ended' && m.tick >= this.backAt) this.toLobby();
  }

  left() {
    const t = this.market.tick;
    if (this.phase === 'live') return this.game.end - t;
    if (this.phase === 'ended') return this.backAt - t;
    return this.countdown === null ? null : Math.max(0, this.countdown - t);
  }

  rank() {
    if (this.phase !== 'live') return null;
    const m = this.market;
    return this.traders.map(t => ({ id: t.id, name: t.name, pnl: Math.round((m.equity(t) / CFG.startCash - 1) * 1e5) / 1e5, liq: t.liq, bot: t.kind !== 'human' }))
      .sort((a, b) => b.pnl - a.pnl);
  }

  flush() {
    const m = this.market, pr = m.pressure();
    const cs = m.candles.filter(c => c.i >= this.sentCandle).map(candleOut);
    this.sentCandle = m.cur().i;
    const ev = m.events.map(evOut); m.events = [];
    for (const e of ev) { this.tape.unshift(e); }
    if (this.tape.length > 60) this.tape.length = 60;
    this.broadcast({ type: 'tick', k: m.tick, px: r2(m.price()), cs, pr: [Math.round(pr.b), Math.round(pr.s)], ph: this.phase, left: this.left(), ev, rk: this.rank() });
    for (const p of this.players.values()) {           // position changes not caused by a fill (liquidations)
      if (p.trader && p.trader.ver !== p.sentVer) { p.sentVer = p.trader.ver; this.send(p, { type: 'me', me: this.me(p.trader) }); }
    }
  }

  // ---------- messages ----------
  me(t) { return { cash: r2(t.cash), pos: t.pos, avg: r2(t.avg), trades: t.trades, liq: t.liq }; }

  roster() {
    return {
      type: 'room', code: this.code, private: this.isPrivate, mins: this.mins, phase: this.phase,
      players: this.humans().map(h => ({ id: h.id, name: h.name, ready: h.ready, host: h.host, connected: h.connected, spectator: h.spectator })),
    };
  }

  snapshot(p) {
    const m = this.market;
    return {
      type: 'state', cfg: { tickMs: CFG.tickMs, candleTicks: CFG.candleTicks, startCash: CFG.startCash, closeTicks: CFG.closeTicks },
      room: this.roster(), k: m.tick, px: r2(m.price()), ph: this.phase, left: this.left(),
      candles: m.candles.slice(-120).map(candleOut), tape: this.tape.slice(0, 40), game: this.game, results: this.results,
      rk: this.rank(), me: p.trader ? this.me(p.trader) : null, spectator: p.spectator,
    };
  }

  send(p, msg) { if (p.conn) p.conn.send(JSON.stringify(msg)); }
  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const p of this.players.values()) if (p.conn) p.conn.send(s);
  }
  broadcastRoster() { this.broadcast(this.roster()); }

  // The host is leaving: tell everyone the room is gone and stop the clock.
  close() {
    this.stopClock();
    const s = JSON.stringify({ type: 'closed' });
    for (const p of this.players.values()) if (p.conn && !p.conn.local) p.conn.send(s);
    this.players.clear();
  }
}
