// HTTP (serves the client) + WebSocket (game) on a single port.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room } from './room.js';
import { cleanAv } from './market.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const rooms = new Map();   // code -> Room
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function newCode() {
  let c;
  do { c = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join(''); } while (rooms.has(c));
  return c;
}
function createRoom(isPrivate, mins) {
  const room = new Room({ code: newCode(), isPrivate, mins });
  rooms.set(room.code, room);
  return room;
}
function quickRoom() {
  for (const r of rooms.values()) if (!r.isPrivate && r.phase === 'lobby' && !r.isFull()) return r;
  return createRoom(false, 5);
}
const cleanName = n => String(n ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 18) || 'Jugador';

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: [...rooms.values()].reduce((n, r) => n + r.connected().length, 0) }));
  }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('No encontrado');
  }
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });

wss.on('connection', ws => {
  ws.alive = true; ws.room = null; ws.player = null; ws.name = 'Jugador'; ws.av = cleanAv();
  ws.rate = { n: 0, at: Date.now() };
  ws.on('pong', () => { ws.alive = true; });
  const send = msg => ws.readyState === 1 && ws.send(JSON.stringify(msg));
  const leave = () => ws.room && ws.room.removePlayer(ws, true);

  ws.on('message', raw => {
    const now = Date.now();                                   // max 20 messages per second per socket
    if (now - ws.rate.at > 1000) { ws.rate.at = now; ws.rate.n = 0; }
    if (++ws.rate.n > 20) return;
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    const room = ws.room, p = ws.player;

    switch (msg.type) {
      case 'hello': {
        ws.name = cleanName(msg.name); if (msg.av) ws.av = cleanAv(msg.av);
        const r = typeof msg.code === 'string' && rooms.get(msg.code);
        if (r && typeof msg.token === 'string' && r.hasToken(msg.token)) r.addPlayer(ws, ws.name, msg.token);
        else send({ type: 'hello' });
        break;
      }
      case 'quick': leave(); if (msg.name) ws.name = cleanName(msg.name); if (msg.av) ws.av = cleanAv(msg.av); quickRoom().addPlayer(ws, ws.name); break;
      case 'create': {
        leave(); if (msg.name) ws.name = cleanName(msg.name); if (msg.av) ws.av = cleanAv(msg.av);
        const mins = [1, 3, 5].includes(msg.mins) ? msg.mins : 5;
        createRoom(true, mins).addPlayer(ws, ws.name);
        break;
      }
      case 'join': {
        if (msg.name) ws.name = cleanName(msg.name); if (msg.av) ws.av = cleanAv(msg.av);
        const r = rooms.get(String(msg.code || '').toUpperCase().trim());
        if (!r) return send({ type: 'error', text: 'No existe ninguna sala con ese código.' });
        if (r === room) return;
        if (r.isFull()) return send({ type: 'error', text: 'Esa sala está llena (8 jugadores).' });
        leave(); r.addPlayer(ws, ws.name);
        break;
      }
      case 'leave': leave(); send({ type: 'left' }); break;
      case 'ready': if (room) room.setReady(p, msg.ready); break;
      case 'start': if (room) room.hostStart(p); break;
      case 'config': if (room) room.configure(p, msg.mins); break;
      case 'order': if (room) room.order(p, msg); break;
      case 'ping': send({ type: 'pong', t: msg.t }); break;
    }
  });
  ws.on('close', () => { if (ws.room) ws.room.removePlayer(ws, false); });
});

// Drop dead sockets and empty rooms.
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); }
  for (const [code, r] of rooms) if (r.isDead()) { r.destroy(); rooms.delete(code); }
}, 15000);

server.listen(PORT, () => console.log(`Parqué Relámpago escuchando en http://localhost:${PORT}`));
