// Market simulation for one room. Pure game logic: no sockets, no timers.
// The room calls step() once per tick and execute() whenever an order arrives.

export const CFG = {
  tickMs: 200,
  candleTicks: 25,     // 25 ticks x 200 ms = 5 s candles
  startCash: 10000,
  base: 48,
  liq: 220000,         // money needed to move the log price by 1.0
  alpha: 0.55,         // share of each order's impact that is permanent
  decay: 0.962,        // per-tick decay of the temporary impact
  fee: 0.0006,
  sigma: 0.0017,
  lev: 1,              // max position = 100 % of equity, long or short
  closeTicks: 150,     // final 30 s: settlement price is their average
  flowWin: 50,         // pressure meter window (10 s)
  bigTrade: 1500,      // trades from this notional up appear on the tape
  tableSize: 8,        // bots fill the room up to this many traders
};

// Avatar = [body colour, eyes, mouth, hat, background]; the client draws it from these indexes.
export const AV_N = [8, 7, 7, 9, 6];
export const randomAv = () => AV_N.map(n => Math.floor(Math.random() * n));
export const cleanAv = a => Array.isArray(a) && a.length === AV_N.length && a.every((v, i) => Number.isInteger(v) && v >= 0 && v < AV_N[i]) ? a.slice() : randomAv();

export const BOT_DEFS = [
  ['La Ballena', 'whale', [4, 3, 5, 1, 1]], ['Rubén·Quant', 'momentum', [3, 2, 2, 6, 0]], ['HODLer_93', 'momentum', [6, 1, 1, 3, 2]],
  ['Tía Paqui', 'contrarian', [2, 0, 0, 5, 3]], ['Dip_Buyer', 'contrarian', [5, 6, 3, 4, 5]], ['Cuñado Inversor', 'noise', [1, 4, 4, 7, 4]], ['Lobo de Lavapiés', 'noise', [7, 5, 6, 8, 5]],
];

const NEWS = {
  good: ['NOVA confirma un yacimiento de litio en su concesión del sur', 'Un fondo soberano compra un 4 % de NOVA', 'NOVA bate las previsiones de beneficio del trimestre', 'Aprobada la licencia de extracción en la mina Altamira Sur', 'NOVA firma un contrato de suministro a diez años'],
  bad: ['Una inundación paraliza la mina principal de NOVA', 'El regulador abre expediente a NOVA por sus cuentas', 'NOVA recorta previsiones por la caída del cobre', 'Dimite por sorpresa el director financiero de NOVA', 'Huelga indefinida en la planta de refino de NOVA'],
  rumorGood: ['Se habla de una OPA sobre NOVA con prima del 20 %', 'Un foro asegura que NOVA ha encontrado oro'],
  rumorBad: ['Circula que NOVA prepara una ampliación de capital', 'Dicen que el consejero delegado está vendiendo acciones'],
};

export const rand = (a, b) => a + Math.random() * (b - a);
export const rint = (a, b) => Math.floor(rand(a, b + 1));
const pick = a => a[Math.floor(Math.random() * a.length)];
const randn = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

export function makeTrader(id, name, kind, av) {
  return { id, name, kind, av, cash: CFG.startCash, pos: 0, avg: 0, trades: 0, vol: 0, liq: false, ver: 0,
    st: { q: 0, chunk: 0, cool: rint(0, 40), hold: 0 } };
}
export const lobbyBots = () => BOT_DEFS.map((b, i) => makeTrader('b' + i, b[0], b[1], b[2]));

export class Market {
  constructor() {
    this.tick = 0; this.F = 0; this.dev = 0;
    this.candles = []; this.buys = []; this.sells = []; this.curB = 0; this.curS = 0;
    this.ema = CFG.base; this.hist = [];
    this.newsApply = { left: 0, per: 0 }; this.pending = []; this.nextNews = 150;
    this.burst = { dir: 0, left: 0, len: 1 }; this.nextBurst = 90;
    this.events = []; this.eid = 0; this.live = false;
    this.newCandle();
  }

  price() { return CFG.base * Math.exp(this.F + this.dev); }
  equity(t) { return t.cash + t.pos * this.price(); }
  cur() { return this.candles[this.candles.length - 1]; }
  newCandle() {
    const p = this.price();
    this.candles.push({ i: Math.floor(this.tick / CFG.candleTicks), o: p, h: p, l: p, c: p, bv: 0, sv: 0 });
    if (this.candles.length > 240) this.candles.shift();
  }
  touch(p) { const c = this.cur(); if (p > c.h) c.h = p; if (p < c.l) c.l = p; c.c = p; }
  emit(e) { e.tick = this.tick; this.events.push(e); return e; }
  pressure() {
    let b = this.curB, s = this.curS;
    for (const v of this.buys) b += v;
    for (const v of this.sells) s += v;
    return { b, s, p: (b - s) / (b + s + 1) };
  }
  ret(n) { const h = this.hist; return h.length <= n ? 0 : Math.log(h[h.length - 1] / h[h.length - 1 - n]); }

  // Every order walks the price: part of the impact stays (fair value), part fades within seconds.
  execute(tr, q) {
    if (!q || !isFinite(q)) return null;
    const p0 = this.price(), x = q * p0 / CFG.liq;
    this.F += CFG.alpha * x; this.dev += (1 - CFG.alpha) * x;
    const p1 = this.price(), s = Math.sign(q);
    const px = (p0 + p1) / 2 * (1 + s * CFG.fee), notional = Math.abs(q * px);
    this.touch(p1);
    const c = this.cur();
    if (q > 0) { c.bv += notional; this.curB += notional; } else { c.sv += notional; this.curS += notional; }
    if (tr) fill(tr, q, px);
    const eid = ++this.eid;
    // The tape is anonymous: it never says who traded. Owners learn about their own fills separately.
    if (notional >= CFG.bigTrade) this.emit({ type: 'trade', eid, side: s, notional, px });
    return { px, eid, notional };
  }

  step(traders) {
    this.tick++;
    if (this.tick % CFG.candleTicks === 0) this.newCandle();
    this.F += randn() * CFG.sigma;
    this.dev *= CFG.decay;
    this.newsTick();
    this.marketFlow();
    for (const t of traders) if (t.kind !== 'human') this.botTick(t);
    const p = this.price();
    this.touch(p);
    this.ema += (p - this.ema) / 100;
    this.hist.push(p); if (this.hist.length > 60) this.hist.shift();
    this.buys.push(this.curB); this.sells.push(this.curS); this.curB = this.curS = 0;
    if (this.buys.length > CFG.flowWin) { this.buys.shift(); this.sells.shift(); }
    for (const t of traders) {
      if (t.pos && this.equity(t) < CFG.startCash * 0.05) {
        this.execute(t, -t.pos); t.liq = true; t.st.q = 0;
        if (this.live) this.emit({ type: 'sys', text: t.name + ' ha sido liquidado' });
      }
    }
  }

  // Anonymous market: small random orders, plus occasional sustained one-sided "institutional" bursts.
  marketFlow() {
    const b = this.burst; let bias = this.pressure().p * 0.12, mult = 1;
    if (b.left > 0) { const k = 1 - Math.abs(1 - 2 * (b.len - b.left) / b.len); bias += b.dir * 0.45 * k; mult = 1 + 1.5 * k; b.left--; }
    else if (this.tick >= this.nextBurst) { b.dir = Math.random() < .5 ? 1 : -1; b.len = b.left = rint(60, 140); this.nextBurst = this.tick + b.len + rint(100, 300); }
    const n = Math.random() < .7 ? 1 : (Math.random() < .5 ? 2 : 0);
    for (let i = 0; i < n; i++) {
      const notional = Math.exp(randn() * 0.8 + 5.4) * mult;
      const s = Math.random() < 0.5 + bias / 2 ? 1 : -1;
      this.execute(null, s * notional / this.price());
    }
  }

  applyNews(text, m, tag) {
    this.newsApply = { left: 12, per: m / 12 };
    this.emit({ type: 'news', text, tag, dir: Math.sign(m) });
  }
  newsTick() {
    if (this.newsApply.left > 0) { this.F += this.newsApply.per; this.newsApply.left--; }
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const e = this.pending[i];
      if (this.tick >= e.at) { this.applyNews(e.text, e.m, 'DESMENTIDO'); this.pending.splice(i, 1); }
    }
    if (this.tick >= this.nextNews) {
      const good = Math.random() < .5, rumor = Math.random() < .3;
      const m = (good ? 1 : -1) * rand(.02, .05);
      const text = rumor ? pick(good ? NEWS.rumorGood : NEWS.rumorBad) : pick(good ? NEWS.good : NEWS.bad);
      this.applyNews(text, m, rumor ? 'RUMOR' : good ? 'POSITIVA' : 'NEGATIVA');
      if (rumor && Math.random() < .6) this.pending.push({ at: this.tick + rint(60, 140), text: 'NOVA desmiente: «' + text + '»', m: -m * .85 });
      this.nextNews = this.tick + rint(180, 360);
    }
  }

  botTick(b) {
    const st = b.st;
    if (st.q) {
      const c = Math.abs(st.q) <= Math.abs(st.chunk) ? st.q : st.chunk;
      this.execute(b, c); st.q -= c; if (Math.abs(st.q) < 1) st.q = 0;
      return;
    }
    if (st.cool > 0) { st.cool--; return; }
    const p = this.price(), eq = this.equity(b);
    if (eq <= 0) return;
    const order = (shares, chunks) => { shares = Math.trunc(shares); if (!shares) return; chunks = Math.max(1, Math.round(chunks)); st.q = shares; st.chunk = Math.trunc(shares / chunks) || Math.sign(shares); };
    const open = (dir, frac, chunks) => order(dir * frac * eq * CFG.lev / p - b.pos, chunks);
    const close = chunks => order(-b.pos, chunks);
    const pr = this.pressure().p, d = Math.log(p / this.ema);
    const upnl = b.pos ? (p / b.avg - 1) * Math.sign(b.pos) : 0;
    switch (b.kind) {
      case 'momentum': {
        const sig = this.ret(15) * 40 + pr * 0.8;
        if (!b.pos) { if (Math.abs(sig) > 0.55 && Math.random() < 0.12) { open(Math.sign(sig), rand(.35, .75), rand(2, 6)); st.cool = rint(10, 30); } }
        else if (upnl > rand(.02, .045) || upnl < -.018 || (sig * Math.sign(b.pos) < -.4 && Math.random() < .15)) { close(rand(2, 5)); st.cool = rint(20, 60); }
        break;
      }
      case 'contrarian': {
        if (!b.pos) { if (Math.abs(d) > .03 && Math.random() < .08) { open(-Math.sign(d), rand(.4, .8), rand(3, 8)); st.cool = rint(15, 40); } }
        else if (Math.abs(d) < .006 || upnl < -.045 || upnl > .05) { close(rand(3, 6)); st.cool = rint(30, 80); }
        break;
      }
      case 'whale': {
        if (!b.pos) { if (Math.random() < .0035) { open(Math.random() < .5 + pr * .3 ? 1 : -1, rand(.8, 1), rint(25, 50)); st.hold = rint(80, 220); } }
        else { st.hold--; if (st.hold <= 0 || upnl < -.05) { close(rint(20, 45)); st.cool = rint(100, 250); } }
        break;
      }
      case 'noise': {
        if (Math.random() < .012) {
          if (b.pos && Math.random() < .5) close(rint(1, 3));
          else open(Math.random() < .5 ? 1 : -1, rand(.1, .4), rint(1, 3));
          st.cool = rint(20, 80);
        }
        break;
      }
    }
  }
}

function fill(tr, q, px) {
  const pos = tr.pos, np = pos + q;
  if (pos === 0 || Math.sign(pos) === Math.sign(q)) tr.avg = (tr.avg * Math.abs(pos) + px * Math.abs(q)) / Math.abs(np);
  else if (np !== 0 && Math.sign(np) !== Math.sign(pos)) tr.avg = px;
  tr.cash -= q * px; tr.pos = np;
  if (Math.abs(tr.pos) < 1e-9) { tr.pos = 0; tr.avg = 0; }
  tr.trades++; tr.vol += Math.abs(q * px); tr.ver++;
}
