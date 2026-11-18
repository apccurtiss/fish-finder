'use strict';
// Fish finder: authoritative game server.
// Serves the static client over HTTP and runs the shared ocean over WebSockets.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const db = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------- constants
const W = 2400;
const H = 1600;
const TICK_HZ = 30;
const SNAP_EVERY = 2; // 15 snapshots per second
const ROUND_SECONDS = Number(process.env.ROUND_SECONDS) || 180;
const INTERMISSION_SECONDS = 12;
const MIN_BOATS = process.env.MIN_BOATS !== undefined ? Number(process.env.MIN_BOATS) : 4;
const MAX_PLAYERS = 40;
const BOAT = { acc: 460, max: 235, drag: 0.22, radius: 17 };
const PING_CD = 2.5;
const CAST_CD = 1.1;
const NET_R = 62;
const NET_AHEAD = 26;

const TYPES = [
  { key: 'sardine',  name: 'Sardine',      pts: 1,  speed: 50,  size: [10, 14], schools: 7, orbit: [10, 46], flee: 150 },
  { key: 'mackerel', name: 'Mackerel',     pts: 3,  speed: 70,  size: [6, 8],   schools: 4, orbit: [12, 40], flee: 170 },
  { key: 'tuna',     name: 'Bluefin Tuna', pts: 8,  speed: 100, size: [3, 4],   schools: 3, orbit: [14, 36], flee: 210 },
  { key: 'goldfin',  name: 'Goldfin',      pts: 30, speed: 125, size: [1, 1],   schools: 0, orbit: [0, 4],   flee: 270 },
  { key: 'jelly',    name: 'Jellyfish',    pts: -5, speed: 18,  size: [4, 6],   schools: 4, orbit: [14, 40], flee: 0 },
];
const GOLDFIN = 3;

const COLORS = ['#ff5d73', '#4d9dff', '#c3f73a', '#ff9ff3', '#ff7b2e', '#ffffff', '#a29bfe', '#00e0b0', '#f9f871', '#ff4fd8'];
const BOT_NAMES = ['Brine', 'Kelp', 'Barnacle', 'Squall', 'Marina', 'Gill', 'Driftwood', 'Tide'];
const NAME_A = ['Salty', 'Briny', 'Lucky', 'Rusty', 'Misty', 'Stormy', 'Old', 'Sunny', 'Foggy', 'Jolly'];
const NAME_B = ['Barnacle', 'Mackerel', 'Anchor', 'Pike', 'Squid', 'Gale', 'Marlin', 'Cod', 'Reef', 'Pelican'];

// ---------------------------------------------------------------- helpers
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const r1 = (v) => Math.round(v);
function angDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
const newSeed = () => crypto.randomInt(1, 2 ** 31 - 1);
const randomName = () => `${NAME_A[randInt(0, NAME_A.length - 1)]} ${NAME_B[randInt(0, NAME_B.length - 1)]}`;
function cleanName(s) {
  const n = String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return n || randomName();
}
function compass(x, y) {
  const ns = y < H / 3 ? 'north' : y > (H * 2) / 3 ? 'south' : '';
  const ew = x < W / 3 ? 'west' : x > (W * 2) / 3 ? 'east' : '';
  if (ns && ew) return `${ns}-${ew}ern`;
  if (ns || ew) return `${ns || ew}ern`;
  return 'central';
}

// ---------------------------------------------------------------- world state
let nextId = 1;
const schools = [];
const fish = new Map();
const players = new Map(); // id -> player (humans and bots)
const clients = new Set(); // connected sockets

let phase = 'play';
let phaseLeft = ROUND_SECONDS;
let round = 1;
let mapSeed = newSeed();
let goldTimer = rand(20, 35);

function boatNear(x, y, dist) {
  const d2 = dist * dist;
  for (const p of players.values()) {
    const dx = p.x - x, dy = p.y - y;
    if (dx * dx + dy * dy < d2) return true;
  }
  return false;
}

function farPoint(margin, minDist) {
  let x = W / 2, y = H / 2;
  for (let i = 0; i < 40; i++) {
    x = rand(margin, W - margin);
    y = rand(margin, H - margin);
    if (!boatNear(x, y, minDist)) break;
  }
  return { x, y };
}

function spawnFish(s, scatter) {
  const T = TYPES[s.type];
  const f = {
    id: nextId++,
    type: s.type,
    school: s,
    x: s.x + (scatter ? rand(-30, 30) : rand(-4, 4)),
    y: s.y + (scatter ? rand(-30, 30) : rand(-4, 4)),
    vx: 0,
    vy: 0,
    r: rand(T.orbit[0], T.orbit[1]),
    ph: rand(0, Math.PI * 2),
    w: rand(0.4, 1.2) * (Math.random() < 0.5 ? -1 : 1),
  };
  fish.set(f.id, f);
  s.members.add(f);
  return f;
}

function makeSchool(type, x, y) {
  const T = TYPES[type];
  const s = { id: nextId++, type, x, y, h: rand(0, Math.PI * 2), turn: 0, target: randInt(T.size[0], T.size[1]), members: new Set(), refill: 0 };
  schools.push(s);
  for (let i = 0; i < s.target; i++) spawnFish(s, true);
  return s;
}

function resetFish() {
  fish.clear();
  schools.length = 0;
  TYPES.forEach((T, type) => {
    for (let i = 0; i < T.schools; i++) {
      const p = farPoint(150, 260);
      makeSchool(type, p.x, p.y);
    }
  });
}

function updateFish(dt) {
  const boats = [...players.values()];
  for (let i = schools.length - 1; i >= 0; i--) {
    const s = schools[i];
    if (s.type === GOLDFIN && s.members.size === 0) {
      schools.splice(i, 1);
      continue;
    }
    const T = TYPES[s.type];
    let speed = T.speed * 0.55;
    s.turn = clamp(s.turn + rand(-1, 1) * 2.5 * dt, -0.9, 0.9);
    s.h += s.turn * dt;

    const m = 160;
    if (s.x < m || s.x > W - m || s.y < m || s.y > H - m) {
      const toC = Math.atan2(H / 2 - s.y, W / 2 - s.x);
      s.h += angDiff(s.h, toC) * Math.min(1, dt * 2.5);
    }
    if (T.flee) {
      let fx = 0, fy = 0, threat = 0;
      for (const b of boats) {
        const dx = s.x - b.x, dy = s.y - b.y;
        const d = Math.hypot(dx, dy);
        if (d < T.flee && d > 0.01) {
          const w = 1 - d / T.flee;
          fx += (dx / d) * w;
          fy += (dy / d) * w;
          if (w > threat) threat = w;
        }
      }
      if (threat > 0) {
        s.h += angDiff(s.h, Math.atan2(fy, fx)) * Math.min(1, dt * 4 * threat);
        speed = T.speed * (0.55 + 1.1 * threat);
      }
    }
    s.x = clamp(s.x + Math.cos(s.h) * speed * dt, 40, W - 40);
    s.y = clamp(s.y + Math.sin(s.h) * speed * dt, 40, H - 40);

    if (s.type !== GOLDFIN && s.members.size < s.target) {
      s.refill += dt;
      if (s.refill > 2.5) {
        s.refill = 0;
        if (!boatNear(s.x, s.y, 260)) spawnFish(s, false);
      }
    }
  }

  for (const f of fish.values()) {
    const s = f.school;
    f.ph += f.w * dt;
    const tx = s.x + Math.cos(f.ph) * f.r;
    const ty = s.y + Math.sin(f.ph) * f.r * 0.75;
    f.vx += ((tx - f.x) * 4 - f.vx * 2.2) * dt;
    f.vy += ((ty - f.y) * 4 - f.vy * 2.2) * dt;
    if (TYPES[f.type].flee) {
      for (const b of boats) {
        const dx = f.x - b.x, dy = f.y - b.y;
        const d = Math.hypot(dx, dy);
        if (d < 70 && d > 0.01) {
          const k = (1 - d / 70) * 900 * dt;
          f.vx += (dx / d) * k;
          f.vy += (dy / d) * k;
        }
      }
    }
    f.x = clamp(f.x + f.vx * dt, 10, W - 10);
    f.y = clamp(f.y + f.vy * dt, 10, H - 10);
  }

  if (phase === 'play') {
    goldTimer -= dt;
    if (goldTimer <= 0) {
      goldTimer = rand(25, 40);
      if (!schools.some((s) => s.type === GOLDFIN)) {
        const p = farPoint(220, 520);
        makeSchool(GOLDFIN, p.x, p.y);
        feed(`A Goldfin surfaced in the ${compass(p.x, p.y)} waters!`, 'gold');
      }
    }
  }
}

// ---------------------------------------------------------------- players
function pickColor() {
  const used = new Map(COLORS.map((c) => [c, 0]));
  for (const p of players.values()) used.set(p.color, (used.get(p.color) || 0) + 1);
  let best = COLORS[0], n = Infinity;
  for (const [c, k] of used) if (k < n) { n = k; best = c; }
  return best;
}

function addPlayer(name, bot) {
  const pos = farPoint(200, 220);
  const p = {
    id: nextId++,
    name,
    bot,
    color: pickColor(),
    x: pos.x, y: pos.y, vx: 0, vy: 0, a: rand(0, Math.PI * 2),
    ix: 0, iy: 0,
    score: 0, catches: 0, best: null,
    pingCd: 0, castCd: 0,
    ai: bot ? { think: 0, pingT: rand(1, 4), target: null, wx: pos.x, wy: pos.y } : null,
  };
  players.set(p.id, p);
  return p;
}

function humans() {
  let n = 0;
  for (const p of players.values()) if (!p.bot) n++;
  return n;
}

function ensureBots() {
  const want = Math.max(0, MIN_BOATS - humans());
  const bots = [...players.values()].filter((p) => p.bot);
  let changed = false;
  while (bots.length > want) {
    const b = bots.pop();
    players.delete(b.id);
    changed = true;
  }
  const usedNames = new Set(bots.map((b) => b.name));
  while (bots.length < want) {
    const free = BOT_NAMES.filter((n) => !usedNames.has(n));
    const name = free.length ? free[randInt(0, free.length - 1)] : `Bot ${nextId}`;
    usedNames.add(name);
    bots.push(addPlayer(name, true));
    changed = true;
  }
  if (changed) broadcastRoster();
}

function stepPlayers(dt) {
  for (const p of players.values()) {
    if (p.bot) botThink(p, dt);
    let ix = p.ix, iy = p.iy;
    const m = Math.hypot(ix, iy);
    if (m > 1) { ix /= m; iy /= m; }
    const k = p.bot ? 0.85 : 1;
    p.vx += ix * BOAT.acc * k * dt;
    p.vy += iy * BOAT.acc * k * dt;
    const drag = Math.pow(BOAT.drag, dt);
    p.vx *= drag;
    p.vy *= drag;
    const sp = Math.hypot(p.vx, p.vy);
    const max = BOAT.max * k;
    if (sp > max) { p.vx *= max / sp; p.vy *= max / sp; }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.x < 20 || p.x > W - 20) { p.x = clamp(p.x, 20, W - 20); p.vx = 0; }
    if (p.y < 20 || p.y > H - 20) { p.y = clamp(p.y, 20, H - 20); p.vy = 0; }
    if (sp > 8) p.a += angDiff(p.a, Math.atan2(p.vy, p.vx)) * Math.min(1, dt * 8);
    p.pingCd = Math.max(0, p.pingCd - dt);
    p.castCd = Math.max(0, p.castCd - dt);
  }
  // soft boat-to-boat collisions
  const list = [...players.values()];
  const minD = BOAT.radius * 2;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d < minD && d > 0.01) {
        const push = (minD - d) / 2;
        const nx = dx / d, ny = dy / d;
        a.x -= nx * push; a.y -= ny * push;
        b.x += nx * push; b.y += ny * push;
      }
    }
  }
}

function netValue(x, y) {
  let v = 0;
  const r2 = NET_R * NET_R;
  for (const f of fish.values()) {
    const dx = f.x - x, dy = f.y - y;
    if (dx * dx + dy * dy <= r2) v += TYPES[f.type].pts;
  }
  return v;
}

function botThink(p, dt) {
  const ai = p.ai;
  ai.think -= dt;
  ai.pingT -= dt;
  if (ai.pingT <= 0) {
    ai.pingT = rand(4, 8);
    handlePing(p);
  }
  if (ai.think <= 0) {
    ai.think = rand(0.4, 0.9);
    let best = null, bs = 0;
    for (const f of fish.values()) {
      const T = TYPES[f.type];
      if (T.pts <= 0) continue;
      const d = Math.hypot(f.x - p.x, f.y - p.y);
      if (d > 650) continue;
      const sc = (T.pts / (d + 120)) * rand(0.7, 1.3);
      if (sc > bs) { bs = sc; best = f; }
    }
    ai.target = best ? best.id : null;
  }
  const f = ai.target != null ? fish.get(ai.target) : null;
  let tx, ty;
  if (f) {
    tx = f.x; ty = f.y;
  } else {
    if (Math.hypot(ai.wx - p.x, ai.wy - p.y) < 60) {
      ai.wx = rand(200, W - 200);
      ai.wy = rand(200, H - 200);
    }
    tx = ai.wx; ty = ai.wy;
  }
  const dx = tx - p.x, dy = ty - p.y;
  const d = Math.hypot(dx, dy) || 1;
  const mag = d < 40 ? 0.3 : 1;
  p.ix = (dx / d) * mag;
  p.iy = (dy / d) * mag;

  if (f && p.castCd <= 0 && phase === 'play') {
    const v = netValue(p.x + Math.cos(p.a) * NET_AHEAD, p.y + Math.sin(p.a) * NET_AHEAD);
    if (v >= 3 || (v > 0 && Math.random() < dt * 1.5)) handleCast(p);
  }
}

function handlePing(p) {
  if (p.pingCd > 0) return;
  p.pingCd = PING_CD;
  broadcast(JSON.stringify({ t: 'ping', id: p.id, x: r1(p.x), y: r1(p.y) }));
}

function handleCast(p) {
  if (phase !== 'play' || p.castCd > 0) return;
  p.castCd = CAST_CD;
  const nx = p.x + Math.cos(p.a) * NET_AHEAD;
  const ny = p.y + Math.sin(p.a) * NET_AHEAD;
  const r2 = NET_R * NET_R;
  const caught = [];
  for (const f of fish.values()) {
    const dx = f.x - nx, dy = f.y - ny;
    if (dx * dx + dy * dy <= r2) caught.push(f);
  }
  let pts = 0, good = 0, gold = false;
  for (const f of caught) {
    const T = TYPES[f.type];
    fish.delete(f.id);
    f.school.members.delete(f);
    pts += T.pts;
    if (T.pts > 0) good++;
    if (f.type === GOLDFIN) gold = true;
    if (!p.best || T.pts > p.best.pts) p.best = { pts: T.pts, name: T.name };
    db.addCatch(T.key, 1);
  }
  p.score = Math.max(0, p.score + pts);
  p.catches += good;
  broadcast(JSON.stringify({
    t: 'cast', id: p.id, x: r1(nx), y: r1(ny), pts,
    c: caught.map((f) => [f.id, f.type, r1(f.x), r1(f.y)]),
  }));
  if (gold) feed(`${p.name} landed the Goldfin! +${TYPES[GOLDFIN].pts}`, 'gold');
  else if (good >= 8) feed(`${p.name} hauled ${good} fish in a single cast!`, 'big');
  if (caught.length - good >= 3) feed(`${p.name} netted a bloom of jellyfish. Ouch.`, 'bad');
}

// ---------------------------------------------------------------- rounds
function endRound() {
  phase = 'inter';
  phaseLeft = INTERMISSION_SECONDS;
  const ranked = [...players.values()].sort((a, b) => b.score - a.score);
  const results = ranked.slice(0, 12).map((p) => ({
    id: p.id, name: p.name, color: p.color, score: p.score, bot: p.bot, best: p.best ? p.best.name : null,
  }));
  broadcast(JSON.stringify({ t: 'roundEnd', round, results }));
  const rows = ranked
    .filter((p) => !p.bot && p.score > 0)
    .map((p) => ({ name: p.name, score: p.score, best_catch: p.best ? p.best.name : null }));
  db.saveRound(rows)
    .catch((e) => console.error('[db] saveRound', e.message))
    .then(() => db.leaderboard(true))
    .then((hall) => broadcast(JSON.stringify({ t: 'hall', hall })))
    .catch((e) => console.error('[db] leaderboard', e.message));
}

function startRound() {
  round++;
  phase = 'play';
  phaseLeft = ROUND_SECONDS;
  mapSeed = newSeed();
  goldTimer = rand(20, 35);
  for (const p of players.values()) {
    p.score = 0; p.catches = 0; p.best = null;
  }
  resetFish();
  broadcast(JSON.stringify({ t: 'round', round, seed: mapSeed }));
  feed(`Round ${round}: new waters charted. Good luck, captains.`, 'info');
}

// ---------------------------------------------------------------- networking
function broadcast(msg) {
  for (const c of clients) {
    if (c.ws.readyState === 1 && c.ws.bufferedAmount < 1_000_000) c.ws.send(msg);
  }
}

function feed(text, kind) {
  broadcast(JSON.stringify({ t: 'feed', text, kind }));
}

function rosterMsg() {
  return JSON.stringify({
    t: 'roster',
    players: [...players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, bot: p.bot })),
  });
}
function broadcastRoster() { broadcast(rosterMsg()); }

function snapshot() {
  const p = [];
  for (const pl of players.values()) p.push(pl.id, r1(pl.x), r1(pl.y), Math.round(pl.a * 100) / 100, pl.score);
  const f = [];
  for (const fi of fish.values()) f.push(fi.id, r1(fi.x), r1(fi.y), fi.type);
  return JSON.stringify({ t: 's', ph: phase === 'play' ? 0 : 1, tl: Math.ceil(phaseLeft), p, f });
}

// ---------------------------------------------------------------- http
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
  const pathname = url.pathname;

  if (pathname === '/healthz') return sendJson(res, 200, { ok: true, players: humans(), round });
  if (pathname === '/api/leaderboard') {
    try { return sendJson(res, 200, await db.leaderboard()); }
    catch (e) { console.error('[db]', e.message); return sendJson(res, 503, { error: 'unavailable' }); }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }

  let rel;
  try { rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); }
  catch { res.writeHead(400); return res.end(); }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 });

wss.on('connection', (ws) => {
  const c = { ws, player: null, budget: 80, alive: true };
  clients.add(c);
  ws.on('pong', () => (c.alive = true));

  ws.send(JSON.stringify({
    t: 'welcome', W, H, seed: mapSeed, round, phase,
    netR: NET_R, netAhead: NET_AHEAD, pingCd: PING_CD, castCd: CAST_CD,
    types: TYPES.map((T) => ({ key: T.key, name: T.name, pts: T.pts })),
  }));
  ws.send(rosterMsg());

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    if (--c.budget < 0) return;
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const p = c.player;
    switch (m.t) {
      case 'hello': {
        if (p) {
          p.name = cleanName(m.name);
          broadcastRoster();
          return;
        }
        if (humans() >= MAX_PLAYERS) {
          ws.send(JSON.stringify({ t: 'full' }));
          return;
        }
        c.player = addPlayer(cleanName(m.name), false);
        ws.send(JSON.stringify({ t: 'you', id: c.player.id }));
        ensureBots();
        broadcastRoster();
        feed(`${c.player.name} set sail.`, 'join');
        return;
      }
      case 'in':
        if (p) {
          p.ix = clamp(Number(m.x) || 0, -1, 1);
          p.iy = clamp(Number(m.y) || 0, -1, 1);
        }
        return;
      case 'ping':
        if (p) handlePing(p);
        return;
      case 'cast':
        if (p) handleCast(p);
        return;
    }
  });

  ws.on('close', () => {
    clients.delete(c);
    if (c.player) {
      players.delete(c.player.id);
      feed(`${c.player.name} returned to port.`, 'leave');
      c.player = null;
      ensureBots();
      broadcastRoster();
    }
  });
  ws.on('error', () => {});
});

// keepalive + per-second message budget
setInterval(() => {
  for (const c of clients) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    try { c.ws.ping(); } catch { /* ignore */ }
  }
}, 30_000).unref();
setInterval(() => { for (const c of clients) c.budget = 80; }, 1000).unref();

// ---------------------------------------------------------------- main loop
let last = Date.now();
let tick = 0;
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  phaseLeft -= dt;
  if (phaseLeft <= 0) {
    if (phase === 'play') endRound();
    else startRound();
  }

  stepPlayers(dt);
  updateFish(dt);

  if (++tick % SNAP_EVERY === 0 && clients.size > 0) broadcast(snapshot());
}, 1000 / TICK_HZ);

// ---------------------------------------------------------------- boot
(async () => {
  await db.init();
  resetFish();
  ensureBots();
  server.listen(PORT, () => console.log(`Fish finder listening on :${PORT}`));
})();

function shutdown() {
  console.log('shutting down');
  wss.clients.forEach((ws) => ws.close(1001, 'server restarting'));
  server.close();
  db.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
