/* Tidebreak game server
   - Serves the game (public/index.html) over HTTP
   - Runs room-code multiplayer on /ws
   - Referees every player's reported hits before relaying them:
     damage caps per weapon, damage-per-second caps, range checks,
     movement speed checks and message rate limits.            */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 8;
// The game page can live in ./public/index.html or right next to this file (./index.html).
const PUBLIC = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : null;
const ROOT_INDEX = path.join(__dirname, 'index.html');
const MAX_HIT = { ar: 60, smg: 40, shotgun: 215, sniper: 250, pistol: 70, grenade: 165, burst: 70, lmg: 50, dmr: 125, revolver: 135, jug: 40, bazooka: 220, viper: 125, maelstrom: 185, predator: 200, beast: 260, clarity: 220 };
const SERVER_VERSION = '18.3';  // the game warns players when the server is older than it expects
const MAX_DPS = 420;           // damage one player may deal per second, all targets combined
const MAX_SPEED = 32;          // m/s, generous for jump pads + slides
const MAX_RANGE = 270;         // metres between shooter and target
const MAX_MSGS_PER_SEC = 50;
const MAX_MSG_BYTES = 6000;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: countPlayers() })); return; }
  let file;
  if (PUBLIC) {
    file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  } else {
    // flat upload: only the game page is served, never the server's own files
    if (url.pathname !== '/' && url.pathname !== '/index.html') { res.writeHead(404); res.end('Not found'); return; }
    file = ROOT_INDEX;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    let body = data;
    // tell the page it is hosted here, so it connects to this server's /ws
    if (file.endsWith('index.html')) body = Buffer.from(data.toString().replace('<head>', '<head><script>window.TIDEBREAK_HOSTED=true</script>'));
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  });
});

const rooms = new Map(); // name -> Map(id -> player)
let nextId = 1;
const countPlayers = () => [...rooms.values()].reduce((n, r) => n + r.size, 0);
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
const finite = v => typeof v === 'number' && Number.isFinite(v);

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MSG_BYTES });
wss.on('connection', ws => {
  let me = null, roomName = null;
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'join' && !me) {
      let name = String(m.room || '').toLowerCase();
      if (name === 'tidebreak-quick') {           // matchmaking: fill the fullest public room that has space
        let best = null;
        for (const [n, r] of rooms) if (n.startsWith('tidebreak-q') && n !== 'tidebreak-quick' && r.size < MAX_PLAYERS && (!best || r.size > rooms.get(best).size)) best = n;
        name = best || 'tidebreak-q' + Math.random().toString(36).slice(2, 7);
      } else if (!/^tidebreak-[a-z0-9]{5}$/.test(name)) { ws.close(); return; }
      const room = rooms.get(name) || new Map();
      if (room.size >= MAX_PLAYERS) { send(ws, { t: 'full' }); ws.close(); return; }
      rooms.set(name, room); roomName = name;
      me = { id: 'p' + (nextId++).toString(36) + Math.random().toString(36).slice(2, 6), ws, p: null, window: [], dmgLog: [], lastHitSeq: 0, lastPos: null, lastPosT: 0, flags: 0 };
      room.set(me.id, me);
      send(ws, { t: 'welcome', sv: SERVER_VERSION, id: me.id, peers: [...room.values()].filter(o => o !== me).map(o => ({ id: o.id, p: o.p })) });
      return;
    }
    if (m.t !== 'p' || !me || !m.p || typeof m.p !== 'object') return;
    // rate limit
    const t = Date.now();
    me.window = me.window.filter(x => t - x < 1000); if (me.window.length >= MAX_MSGS_PER_SEC) return; me.window.push(t);
    const room = rooms.get(roomName); if (!room) return;
    const p = sanitize(me, m.p, room, t);
    me.p = p;
    for (const o of room.values()) if (o !== me) send(o.ws, { t: 'p', id: me.id, p });
  });
  ws.on('close', () => {
    if (!me) return;
    const room = rooms.get(roomName); if (!room) return;
    room.delete(me.id);
    for (const o of room.values()) send(o.ws, { t: 'left', id: me.id });
    if (!room.size) rooms.delete(roomName);
  });
});

function sanitize(me, p, room, t) {
  const out = Object.assign({}, p);
  if (typeof out.n === 'string') out.n = out.n.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '').slice(0, 14);
  // movement check
  if (Array.isArray(p.p) && p.p.length === 3 && p.p.every(finite)) {
    if (me.lastPos && p.a && me.p && me.p.a && (p.ds | 0) === (me.p.ds | 0)) {
      const dt = Math.max(0.03, (t - me.lastPosT) / 1000);
      const d = Math.hypot(p.p[0] - me.lastPos[0], p.p[2] - me.lastPos[2]);
      if (d > MAX_SPEED * dt + 2) { me.flags++; out.p = me.lastPos; }
    }
    if (out.p === p.p) { me.lastPos = p.p; me.lastPosT = t; }
  } else out.p = me.lastPos || [0, 0, 0];
  // hit validation: only new hits are checked; rejected ones are stripped
  if (Array.isArray(p.ht)) {
    me.dmgLog = me.dmgLog.filter(x => t - x.t < 1000);
    const kept = [];
    for (const h of p.ht) {
      if (!Array.isArray(h) || h.length < 6 || !finite(h[0]) || !finite(h[2])) continue;
      if (h[0] <= me.lastHitSeq) { if (h.ok) kept.push(h); else if (me.accepted && me.accepted.has(h[0])) kept.push(h); continue; }
      me.lastHitSeq = h[0];
      const victim = room.get(h[1]);
      let ok = !!victim && victim !== me && !!(p.a);
      const known = Object.prototype.hasOwnProperty.call(MAX_HIT, h[4]);
      ok = ok && h[2] >= 0 && h[2] <= (known ? MAX_HIT[h[4]] : 250);   // a weapon newer than this server gets a generous cap instead of being rejected
      const dmgSoFar = me.dmgLog.reduce((n, x) => n + x.d, 0);
      ok = ok && (h[4] === 'grenade' || h[4] === 'bazooka' || h[4] === 'maelstrom' || h[4] === 'predator' || h[4] === 'beast' || h[4] === 'clarity' || dmgSoFar + h[2] <= (known ? MAX_DPS : MAX_DPS * 3));   // explosions are capped per hit instead
      if (ok && victim.p && Array.isArray(victim.p.p) && me.lastPos) {
        const vp = victim.p.p, d = Math.hypot(vp[0] - me.lastPos[0], vp[1] - me.lastPos[1], vp[2] - me.lastPos[2]);
        ok = d <= (h[4] === 'grenade' ? 40 : MAX_RANGE);
      }
      if (ok) { me.dmgLog.push({ t, d: h[2] }); (me.accepted = me.accepted || new Set()).add(h[0]); if (me.accepted.size > 40) me.accepted.delete(me.accepted.values().next().value); kept.push(h); }
      else me.flags++;
    }
    out.ht = kept;
  }
  // kill credit can only come from someone who hit you
  if (out.kb && !room.has(out.kb)) out.kb = null;
  return out;
}

// drop dead connections
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 15000);
server.listen(PORT, () => console.log(`Tidebreak server on http://localhost:${PORT}`));
