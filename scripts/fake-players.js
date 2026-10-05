// Connects N fake human players over WebSocket so you can test a room without friends.
// Usage: node scripts/fake-players.js [count] [roomCode] [serverUrl]
//   npm run bots -- 3          -> 3 players join quick match
//   npm run bots -- 2 KQBT     -> 2 players join private room KQBT
import WebSocket from 'ws';

const count = Number(process.argv[2]) || 3;
const code = process.argv[3] && process.argv[3] !== '-' ? process.argv[3].toUpperCase() : null;
const url = process.argv[4] || 'ws://localhost:3000/ws';
const names = ['Marta_FX', 'Javi Velas', 'Señor Dividendo', 'Ana Corto', 'Pepe Stop-Loss', 'Lucía HFT', 'Toni Bajista'];

function player(i) {
  const name = names[i % names.length];
  const ws = new WebSocket(url);
  const st = { phase: null, fills: 0, rejects: 0, seq: 0 };
  ws.on('open', () => ws.send(JSON.stringify(code ? { type: 'join', code, name } : { type: 'quick', name })));
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type === 'welcome') console.log(`[${name}] en la sala ${m.code}`);
    if (m.type === 'error') { console.log(`[${name}] error: ${m.text}`); ws.close(); }
    if (m.type === 'room' && m.phase === 'lobby') {
      const me = m.players.find(p => p.name.startsWith(name));
      if (me && !me.ready) setTimeout(() => ws.send(JSON.stringify({ type: 'ready', ready: true })), 500 + Math.random() * 1500);
    }
    if (m.type === 'start') console.log(`[${name}] ¡campana! partida de ${m.game.mins} min contra ${m.players.length - 1} rivales`);
    if (m.type === 'tick') st.phase = m.ph;
    if (m.type === 'fill') st.fills++;
    if (m.type === 'reject') st.rejects++;
    if (m.type === 'end') {
      const k = m.results.rows.findIndex(r => r.name.startsWith(name));
      const r = m.results.rows[k];
      console.log(`[${name}] puesto ${k + 1}/${m.results.rows.length} · ${(r.pnl * 100).toFixed(2)} % · ${st.fills} órdenes, ${st.rejects} rechazadas`);
    }
  });
  ws.on('close', () => console.log(`[${name}] desconectado`));
  // Trade at random while the game is live.
  setInterval(() => {
    if (st.phase !== 'live' || Math.random() > 0.25) return;
    const side = ['buy', 'sell', 'close'][Math.floor(Math.random() * 3)];
    const size = [0.25, 0.5, 1][Math.floor(Math.random() * 3)];
    ws.send(JSON.stringify({ type: 'order', side, size, seq: ++st.seq }));
  }, 1000);
}

for (let i = 0; i < count; i++) setTimeout(() => player(i), i * 200);
