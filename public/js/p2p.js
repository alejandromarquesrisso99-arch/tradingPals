// Peer-to-peer networking. There is no game server: the browser that opens a room runs it (room.js)
// and every other player opens one WebRTC data channel to that browser. PeerJS's free public
// signalling server only introduces the browsers to each other; game traffic never goes through it.
//
// Room addresses on the signalling server:
//   private rooms  PREFIX + the 4-letter code (KQBT)
//   public rooms   PREFIX + pub-1 … pub-12: quick match joins the first one waiting for players, or opens one.
//
// Both kinds of session expose the same surface to the page:
//   session.send(msg) · session.leave() · session.host · session.code
//   hooks.onmessage(msg) · hooks.onstatus(online) · hooks.onend(reason)
import { Room } from './room.js';

const PREFIX = 'parque-relampago-v1-';
const PUBLIC_SLOTS = 12;
const TIMEOUT = 9000;          // ms to reach the signalling server or to open a data channel
const GIVE_UP = 25000;         // a guest stops looking for a vanished host after this long
const SILENT = 15000;          // the host drops a guest it has not heard from in this long (guests ping every 2 s)
const MAX_MSG = 2048, MAX_RATE = 20, MAX_LINKS = 16;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const SEAT = 'pr-seat';
// To use your own PeerJS server or TURN relay, set window.PR_PEER before this module loads, e.g.
// { host: 'peer.example.com', port: 443, path: '/', secure: true, config: { iceServers: [...] } }.
const peerOptions = () => ({ debug: 0, ...(globalThis.PR_PEER || {}) });

const MESSAGES = {
  network: 'No se ha podido contactar con el servidor de señalización (PeerJS). Revisa tu conexión.',
  unsupported: 'Tu navegador no permite conexiones WebRTC, o no se ha podido cargar PeerJS.',
  gone: 'No existe ninguna sala con ese código.',
  failed: 'No se ha podido conectar con el anfitrión. Puede que vuestras redes bloqueen las conexiones directas.',
  full: 'Esa sala está llena (8 jugadores).',
  busy: 'Esa sala ya no admite jugadores.',
  taken: 'No se ha podido abrir la sala. Inténtalo de nuevo.',
  'no-slot': 'Todas las salas públicas están ocupadas. Crea una sala privada.',
};
class NetError extends Error {
  constructor(code, text) { super(text || MESSAGES[code] || MESSAGES.network); this.code = code; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), b => CODE_CHARS[b % CODE_CHARS.length]).join('');
const seat = {
  get() { try { return JSON.parse(sessionStorage.getItem(SEAT)); } catch (e) { return null; } },
  set(v) { try { sessionStorage.setItem(SEAT, JSON.stringify(v)); } catch (e) {} },
  del() { try { sessionStorage.removeItem(SEAT); } catch (e) {} },
};

// Settles with whichever listener answers first (a value resolves, an Error rejects), then detaches them all.
function race(handlers, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    const off = () => { clearTimeout(t); for (const [obj, ev, fn] of bound) obj.off(ev, fn); };
    const bound = handlers.map(([obj, ev, fn]) => [obj, ev, (...a) => {
      const r = fn(...a);
      off(); r instanceof Error ? reject(r) : resolve(r);
    }]);
    const t = setTimeout(() => { off(); reject(onTimeout()); }, ms);
    for (const [obj, ev, fn] of bound) obj.on(ev, fn);
  });
}

// ---------- signalling ----------
// Registers with the signalling server, under `id` (to host) or a random id (to join).
async function openPeer(id) {
  const Peer = globalThis.peerjs && globalThis.peerjs.Peer;
  if (!Peer || !globalThis.RTCPeerConnection) throw new NetError('unsupported');
  const peer = id ? new Peer(id, peerOptions()) : new Peer(peerOptions());
  try {
    await race([
      [peer, 'open', () => true],
      [peer, 'error', e => new NetError(e.type === 'unavailable-id' ? 'taken' : e.type === 'browser-incompatible' ? 'unsupported' : 'network')],
    ], TIMEOUT, () => new NetError('network'));
    return peer;
  } catch (e) { peer.destroy(); throw e; }
}

async function online(peer) {
  if (peer.destroyed) throw new NetError('network');
  if (peer.open) return;
  await race([[peer, 'open', () => true], [peer, 'error', () => new NetError('network')]], TIMEOUT, () => new NetError('network'));
}
function keepRegistered(peer) {
  let wait = 1000;
  peer.on('open', () => { wait = 1000; });
  peer.on('disconnected', () => {
    if (peer.destroyed) return;
    setTimeout(() => { if (peer.disconnected && !peer.destroyed) { peer.reconnect(); wait = Math.min(wait * 2, 15000); } }, wait);
  });
}

// Opens a data channel to the room `code`. Rejects with 'gone' if nobody hosts it.
async function dial(peer, code) {
  if (peer.disconnected && !peer.destroyed) peer.reconnect();
  await online(peer);
  const dc = peer.connect(PREFIX + code, { serialization: 'raw', reliable: true });
  if (!dc) throw new NetError('network');
  try {
    await race([
      [dc, 'open', () => true],
      [dc, 'error', () => new NetError('failed')],
      [dc, 'close', () => new NetError('failed')],
      [peer, 'error', e => new NetError(e.type === 'peer-unavailable' ? 'gone' : 'network')],
    ], TIMEOUT, () => new NetError('failed'));
    return dc;
  } catch (e) { dc.close(); throw e; }
}

// ---------- guest ----------
class GuestSession {
  constructor(peer, code, hello, hooks, persist) {
    Object.assign(this, { peer, code, hello, hooks, persist, host: false, dc: null, online: false, ended: false, lostAt: 0, joined: null });
  }

  // Sends `join` on a fresh channel. Resolves on `welcome`; an `error` reply or a closed channel rejects.
  attach(dc) {
    this.dc = dc;
    dc.on('data', raw => this.receive(dc, raw));
    dc.on('close', () => this.lost(dc));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => this.joined(new NetError('failed')), TIMEOUT);
      this.joined = err => {
        clearTimeout(t); this.joined = null;
        if (err) { if (this.dc === dc) this.dc = null; dc.close(); return reject(err); }
        this.online = true; this.lostAt = 0;
        this.hooks.onstatus(true);
        resolve();
      };
      dc.send(JSON.stringify({ type: 'join', ...this.hello }));
    });
  }

  receive(dc, raw) {
    if (dc !== this.dc || this.ended || typeof raw !== 'string') return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.type !== 'string') return;
    if (this.joined && m.type === 'error') return this.joined(new NetError(m.code, m.text));
    if (m.type === 'closed' || m.type === 'replaced') return this.end(m.type);
    if (m.type === 'welcome') {
      this.hello.token = m.token;
      if (this.persist) seat.set({ role: 'guest', code: this.code, token: m.token });
    }
    this.hooks.onmessage(m);
    if (m.type === 'welcome' && this.joined) this.joined();
  }

  send(msg) {
    if (!this.online || !this.dc || !this.dc.open) return false;
    this.dc.send(JSON.stringify(msg));
    return true;
  }

  lost(dc) {
    if (dc !== this.dc || this.ended) return;
    if (this.joined) return this.joined(new NetError('failed'));
    this.dc = null; this.online = false; this.lostAt = Date.now();
    this.hooks.onstatus(false);
    this.retry();
  }

  // The host may be reloading its page (it reopens the same room) or have dropped off for a moment.
  async retry() {
    for (let n = 0; !this.ended && !this.online; n++) {
      await sleep(Math.min(5000, 500 * 2 ** n));
      if (this.ended) return;
      try {
        await this.attach(await dial(this.peer, this.code));
      } catch (e) {
        if (e.code === 'full' || e.code === 'busy') return this.end(e.code);
        if (Date.now() - this.lostAt > GIVE_UP) return this.end('gone');
      }
    }
  }

  close() {
    this.ended = true; this.online = false;
    if (this.persist) seat.del();
    const dc = this.dc; this.dc = null;
    setTimeout(() => { if (dc) dc.close(); this.peer.destroy(); }, 200);    // let a last `leave` go out first
  }
  end(reason) {
    if (this.ended) return;
    this.close();
    this.hooks.onend(reason);
  }
  leave() {
    if (this.ended) return;
    this.send({ type: 'leave' });
    this.close();
  }
}

async function guest(peer, code, hello, hooks, persist) {
  const s = new GuestSession(peer, code, { ...hello }, hooks, persist);
  await s.attach(await dial(peer, code));
  return s;
}

// ---------- host ----------
class HostSession {
  constructor(peer, code, opts, hooks, persist) {
    Object.assign(this, { peer, code, hooks, persist, host: true, ended: false });
    this.room = new Room({ code, isPrivate: opts.isPrivate, mins: opts.mins });
    this.links = new Set();
    // The host plays through the same message protocol as everyone else, without the network.
    this.local = { local: true, send: text => queueMicrotask(() => { if (!this.ended) hooks.onmessage(JSON.parse(text)); }), close() {} };
    keepRegistered(peer);
    peer.on('connection', dc => this.accept(dc));
    this.sweep = setInterval(() => {
      const now = Date.now();
      for (const l of this.links) if (now - l.seen > SILENT) l.close();
    }, 2000);
    this.save = () => { if (this.persist && !this.ended) seat.set({ role: 'host', code, isPrivate: this.room.isPrivate, mins: this.room.mins }); };
    this.save();
    addEventListener('pagehide', this.save);
    this.room.receive(this.local, { type: 'join', name: opts.name });
    hooks.onstatus(true);
  }

  // Every guest gets a conn for the room, with the limits the old server enforced per socket.
  accept(dc) {
    if (this.ended || this.links.size >= MAX_LINKS) { dc.on('open', () => dc.close()); return; }
    const conn = {
      dc, seen: Date.now(), n: 0, at: Date.now(), player: null,
      send: text => { if (dc.open) dc.send(text); },
      close: () => { this.links.delete(conn); this.room.removePlayer(conn, false); dc.close(); },
    };
    this.links.add(conn);
    dc.on('data', raw => {
      if (this.ended || typeof raw !== 'string' || raw.length > MAX_MSG) return;
      const now = Date.now();
      if (now - conn.at > 1000) { conn.at = now; conn.n = 0; }
      if (++conn.n > MAX_RATE) return;
      let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
      if (!msg || typeof msg.type !== 'string') return;
      conn.seen = now;
      this.room.receive(conn, msg);
    });
    dc.on('close', () => { this.links.delete(conn); if (!this.ended) this.room.removePlayer(conn, false); });
    dc.on('error', () => {});
  }

  send(msg) {
    queueMicrotask(() => { if (!this.ended) this.room.receive(this.local, msg); });
    return true;
  }

  leave() {
    if (this.ended) return;
    this.room.close();
    this.ended = true;
    clearInterval(this.sweep);
    removeEventListener('pagehide', this.save);
    if (this.persist) seat.del();
    setTimeout(() => this.peer.destroy(), 300);         // let the `closed` notice reach the guests
  }
}

async function host(code, opts, hooks, persist, tries = 1) {
  for (let i = 0; ; i++) {
    try {
      const peer = await openPeer(PREFIX + code);
      return new HostSession(peer, code, opts, hooks, persist);
    } catch (e) {
      if (e.code !== 'taken' || i + 1 >= tries) throw e;
      await sleep(1500);
    }
  }
}

// ---------- what the page calls ----------
export async function createRoom(name, mins, hooks, { persist = true } = {}) {
  for (let i = 0; i < 5; i++) {
    try { return await host(newCode(), { name, mins, isPrivate: true }, hooks, persist); }
    catch (e) { if (e.code !== 'taken') throw e; }
  }
  throw new NetError('taken');
}

export async function joinRoom(code, hello, hooks, { persist = true } = {}) {
  const peer = await openPeer();
  keepRegistered(peer);
  try { return await guest(peer, code, hello, hooks, persist); }
  catch (e) { peer.destroy(); throw e; }
}

// Joins the first public room that is waiting for players, or opens one. Claiming a free address is
// instant while finding out that nobody is behind one takes seconds, so each slot is tried as host first.
export async function quickMatch(name, hooks, { persist = true } = {}) {
  let peer = null;                                      // random id for visiting rooms other people host
  try {
    for (let i = 1; i <= PUBLIC_SLOTS; i++) {
      const code = 'pub-' + i;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const s = await host(code, { name, mins: 5, isPrivate: false }, hooks, persist);
          if (peer) peer.destroy();
          return s;
        } catch (e) { if (e.code !== 'taken') throw e; }
        if (!peer) { peer = await openPeer(); keepRegistered(peer); }
        try { return await guest(peer, code, { name, quick: true }, hooks, persist); }
        catch (e) {
          if (e.code === 'network') throw e;
          if (e.code !== 'gone') break;                 // busy, full or unreachable: next room
        }                                               // its host has just left: try to open it ourselves
      }
    }
    throw new NetError('no-slot');
  } catch (e) { if (peer) peer.destroy(); throw e; }
}

// After a reload: rejoin the room this tab was in, or reopen it if this tab was hosting it.
export function resume(name, hooks) {
  const s = seat.get();
  if (!s || typeof s.code !== 'string') return null;
  seat.del();
  if (s.role === 'host') return host(s.code, { name, mins: [1, 3, 5].includes(s.mins) ? s.mins : 5, isPrivate: !!s.isPrivate }, hooks, true, 4);
  return joinRoom(s.code, { name, token: s.token }, hooks);
}
