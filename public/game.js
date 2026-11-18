/* Fish finder client: networking, input, sonar rendering, HUD. */
(function () {
  'use strict';

  // ------------------------------------------------------------------ config
  var TYPES = [
    { key: 'sardine', name: 'Sardine', pts: 1, color: '#7af5ff', size: 4.5, note: 'big, slow schools' },
    { key: 'mackerel', name: 'Mackerel', pts: 3, color: '#7dffa8', size: 6.5, note: 'mid-sized schools' },
    { key: 'tuna', name: 'Bluefin Tuna', pts: 8, color: '#ffa94d', size: 9.5, note: 'fast and skittish' },
    { key: 'goldfin', name: 'Goldfin', pts: 30, color: '#ffe14d', size: 10, note: 'rare, flees hard' },
    { key: 'jelly', name: 'Jellyfish', pts: -5, color: '#e08cff', size: 7, note: 'avoid, costs points' }
  ];
  var PING_SPEED = 720;   // px/s ring expansion
  var PING_RANGE = 470;
  var REVEAL_MS = 3400;
  var SWEEP_R = 150;
  var NET_R = 62, NET_AHEAD = 26, PING_CD = 2.5, CAST_CD = 1.1;

  // ------------------------------------------------------------------ utils
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function angDiff(a, b) {
    var d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function store(k, v) {
    try { if (v === undefined) return window.localStorage.getItem(k); window.localStorage.setItem(k, v); } catch (e) { /* storage blocked */ }
    return null;
  }
  function fmtTime(s) { s = Math.max(0, s | 0); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  function hexA(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  var NAME_A = ['Salty', 'Briny', 'Lucky', 'Rusty', 'Misty', 'Stormy', 'Old', 'Sunny', 'Foggy', 'Jolly', 'Captain', 'Skipper'];
  var NAME_B = ['Barnacle', 'Mackerel', 'Anchor', 'Pike', 'Squid', 'Gale', 'Marlin', 'Cod', 'Reef', 'Pelican', 'Kraken', 'Herring'];
  function randomName() {
    return NAME_A[Math.floor(Math.random() * NAME_A.length)] + ' ' + NAME_B[Math.floor(Math.random() * NAME_B.length)];
  }

  // ------------------------------------------------------------------ state
  var S = {
    W: 2400, H: 1600, seed: 1, round: 1,
    me: null, joined: false, wantJoin: false, name: '',
    roster: {}, boats: {}, fish: {},
    phase: 0, timeLeft: 0,
    lastSnap: 0, snapDt: 66,
    pings: [], nets: [], wakes: [], floaters: [], splashes: [],
    cam: { x: 1200, y: 800 }, camScale: 1,
    myPingCd: 0, myCastCd: 0,
    lastResults: null, hall: null
  };

  // ------------------------------------------------------------------ canvas
  var cv = $('game');
  var ctx = cv.getContext('2d');
  var mini = $('minimap');
  var mctx = mini.getContext('2d');
  var vw = 0, vh = 0, dpr = 1, baseScale = 1;

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    vw = window.innerWidth;
    vh = window.innerHeight;
    cv.width = Math.round(vw * dpr);
    cv.height = Math.round(vh * dpr);
    baseScale = clamp(Math.min(vw, vh) / 820, 0.55, 1.15);
    var md = Math.min(2, window.devicePixelRatio || 1);
    mini.width = 200 * md;
    mini.height = 134 * md;
    buildPlankton();
  }
  window.addEventListener('resize', resize);

  // ------------------------------------------------------------------ seeded terrain
  var mapCanvas = null, miniMapCanvas = null;

  function hash2(x, y, s) {
    var h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 982451653)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(x, y, s) {
    var xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    var a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function depthAt(wx, wy, seed) {
    var x = wx / 520, y = wy / 520;
    return 0.55 * vnoise(x, y, seed) + 0.3 * vnoise(x * 2.1 + 7.3, y * 2.1 + 1.7, seed + 1) + 0.15 * vnoise(x * 4.3 + 3.1, y * 4.3 + 9.2, seed + 2);
  }

  function buildMap() {
    var W = S.W, H = S.H, seed = S.seed;
    var STEP = 16;
    var gw = Math.ceil(W / STEP) + 1, gh = Math.ceil(H / STEP) + 1;
    var g = new Float32Array(gw * gh);
    for (var j = 0; j < gh; j++) for (var i = 0; i < gw; i++) g[j * gw + i] = depthAt(i * STEP, j * STEP, seed);

    // depth shading: small image scaled up smoothly
    var small = document.createElement('canvas');
    small.width = gw; small.height = gh;
    var sctx = small.getContext('2d');
    var img = sctx.createImageData(gw, gh);
    for (var k = 0; k < g.length; k++) {
      var t = clamp((g[k] - 0.2) / 0.6, 0, 1);
      t = t * t;
      img.data[k * 4] = lerp(2, 14, t);
      img.data[k * 4 + 1] = lerp(12, 62, t);
      img.data[k * 4 + 2] = lerp(24, 72, t);
      img.data[k * 4 + 3] = 255;
    }
    sctx.putImageData(img, 0, 0);

    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var x = c.getContext('2d');
    x.imageSmoothingEnabled = true;
    x.drawImage(small, 0, 0, gw, gh, 0, 0, (gw - 1) * STEP + STEP, (gh - 1) * STEP + STEP);

    // contour lines (marching squares)
    var levels = [];
    for (var l = 0.18; l < 0.86; l += 0.04) levels.push(l);
    levels.forEach(function (lv, li) {
      var major = li % 4 === 0;
      x.beginPath();
      for (var j = 0; j < gh - 1; j++) {
        for (var i = 0; i < gw - 1; i++) {
          var a = g[j * gw + i], b = g[j * gw + i + 1], cc = g[(j + 1) * gw + i + 1], d = g[(j + 1) * gw + i];
          var idx = (a > lv ? 8 : 0) | (b > lv ? 4 : 0) | (cc > lv ? 2 : 0) | (d > lv ? 1 : 0);
          if (idx === 0 || idx === 15) continue;
          var px = i * STEP, py = j * STEP;
          var top = [px + ((lv - a) / (b - a)) * STEP, py];
          var right = [px + STEP, py + ((lv - b) / (cc - b)) * STEP];
          var bottom = [px + ((lv - d) / (cc - d)) * STEP, py + STEP];
          var left = [px, py + ((lv - a) / (d - a)) * STEP];
          var segs;
          switch (idx) {
            case 1: case 14: segs = [left, bottom]; break;
            case 2: case 13: segs = [bottom, right]; break;
            case 3: case 12: segs = [left, right]; break;
            case 4: case 11: segs = [top, right]; break;
            case 5: segs = [top, left, bottom, right]; break;
            case 6: case 9: segs = [top, bottom]; break;
            case 7: case 8: segs = [top, left]; break;
            case 10: segs = [top, right, left, bottom]; break;
          }
          for (var s = 0; s < segs.length; s += 2) {
            x.moveTo(segs[s][0], segs[s][1]);
            x.lineTo(segs[s + 1][0], segs[s + 1][1]);
          }
        }
      }
      x.strokeStyle = major ? 'rgba(60,242,200,0.26)' : 'rgba(60,242,200,0.09)';
      x.lineWidth = major ? 1.4 : 1;
      x.stroke();
    });

    // nautical grid
    x.strokeStyle = 'rgba(160,230,255,0.05)';
    x.lineWidth = 1;
    x.beginPath();
    for (var gx = 200; gx < W; gx += 200) { x.moveTo(gx + 0.5, 0); x.lineTo(gx + 0.5, H); }
    for (var gy = 200; gy < H; gy += 200) { x.moveTo(0, gy + 0.5); x.lineTo(W, gy + 0.5); }
    x.stroke();
    x.fillStyle = 'rgba(160,230,255,0.22)';
    x.font = '600 12px "Chakra Petch", monospace';
    for (var cx = 0; cx < W / 200; cx++) {
      for (var cy = 0; cy < H / 200; cy++) {
        x.fillText(String.fromCharCode(65 + cx) + (cy + 1), cx * 200 + 8, cy * 200 + 18);
      }
    }
    // border
    x.strokeStyle = 'rgba(60,242,200,0.55)';
    x.lineWidth = 3;
    x.strokeRect(1.5, 1.5, W - 3, H - 3);

    mapCanvas = c;
    miniMapCanvas = document.createElement('canvas');
    miniMapCanvas.width = 200; miniMapCanvas.height = 134;
    var mc = miniMapCanvas.getContext('2d');
    mc.drawImage(small, 0, 0, 200, 134);
  }

  // glow sprites per species
  var glow = TYPES.map(function (T) {
    var c = document.createElement('canvas');
    c.width = c.height = 64;
    var x = c.getContext('2d');
    var gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, hexA(T.color, 0.7));
    gr.addColorStop(0.35, hexA(T.color, 0.22));
    gr.addColorStop(1, hexA(T.color, 0));
    x.fillStyle = gr;
    x.fillRect(0, 0, 64, 64);
    return c;
  });

  // drifting plankton (screen space, parallax)
  var plankton = [];
  function buildPlankton() {
    plankton = [];
    var n = Math.round((vw * vh) / 9000);
    for (var i = 0; i < n; i++) {
      plankton.push({ x: Math.random() * vw, y: Math.random() * vh, z: 0.3 + Math.random() * 0.6, s: Math.random() * 1.6 + 0.4, ph: Math.random() * 6.28 });
    }
  }

  // ------------------------------------------------------------------ networking
  var ws = null, retry = 0;
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

  function setStatus(text, cls) {
    var s = $('status');
    s.textContent = text;
    s.className = 'status' + (cls ? ' ' + cls : '');
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try { ws = new WebSocket(proto + '//' + location.host + '/ws'); } catch (e) { scheduleReconnect(); return; }
    ws.onopen = function () {
      retry = 0;
      setStatus('Connected. The water is live.', 'ok');
      $('sail').disabled = false;
      if (S.wantJoin) send({ t: 'hello', name: S.name });
    };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      handle(m);
    };
    ws.onclose = function () {
      S.me = null;
      $('sail').disabled = true;
      setStatus('Lost the harbor signal. Reconnecting…', 'bad');
      if (S.joined) addFeed('Connection lost, reconnecting…', 'bad');
      scheduleReconnect();
    };
    ws.onerror = function () { /* onclose follows */ };
  }
  function scheduleReconnect() {
    setTimeout(connect, Math.min(5000, 400 * Math.pow(2, retry++)));
  }

  function handle(m) {
    switch (m.t) {
      case 's': onSnap(m); break;
      case 'welcome':
        S.W = m.W; S.H = m.H; S.round = m.round;
        NET_R = m.netR; NET_AHEAD = m.netAhead; PING_CD = m.pingCd; CAST_CD = m.castCd;
        if (m.seed !== S.seed || !mapCanvas) { S.seed = m.seed; buildMap(); }
        S.fish = {}; S.boats = {};
        break;
      case 'you':
        S.me = m.id;
        if (!S.joined) {
          S.joined = true;
          $('intro').hidden = true;
          $('hud').hidden = false;
          addFeed('You set sail as ' + S.name + '. Ping to find fish!', 'join');
        }
        break;
      case 'roster':
        S.roster = {};
        m.players.forEach(function (p) { S.roster[p.id] = p; });
        break;
      case 'ping': onPing(m); break;
      case 'cast': onCast(m); break;
      case 'feed': addFeed(m.text, m.kind); break;
      case 'roundEnd': onRoundEnd(m); break;
      case 'hall': S.hall = m.hall; renderHall(); break;
      case 'round':
        S.round = m.round;
        S.seed = m.seed;
        buildMap();
        $('results').hidden = true;
        S.pings = []; S.nets = [];
        break;
      case 'full':
        setStatus('The harbor is full right now. Try again shortly.', 'bad');
        S.wantJoin = false;
        break;
    }
  }

  function onSnap(m) {
    var now = performance.now();
    if (S.lastSnap) S.snapDt = clamp(lerp(S.snapDt, now - S.lastSnap, 0.1), 40, 160);
    S.lastSnap = now;
    S.phase = m.ph;
    S.timeLeft = m.tl;

    var seen = {}, p = m.p, i, id, b;
    for (i = 0; i < p.length; i += 5) {
      id = p[i];
      b = S.boats[id];
      if (!b) {
        b = S.boats[id] = { id: id, x: p[i + 1], y: p[i + 2], a: p[i + 3], fx: p[i + 1], fy: p[i + 2], fa: p[i + 3], spd: 0, wakeT: 0 };
      } else {
        b.fx = b.x; b.fy = b.y; b.fa = b.a;
      }
      b.spd = lerp(b.spd, Math.hypot(p[i + 1] - b.tx, p[i + 2] - b.ty) / (S.snapDt / 1000) || 0, 0.5);
      b.tx = p[i + 1]; b.ty = p[i + 2]; b.ta = p[i + 3]; b.score = p[i + 4]; b.t0 = now;
      seen[id] = 1;
    }
    for (id in S.boats) if (!seen[id]) delete S.boats[id];

    var f = m.f, fseen = {}, fi;
    for (i = 0; i < f.length; i += 4) {
      id = f[i];
      fi = S.fish[id];
      if (!fi) {
        fi = S.fish[id] = { id: id, type: f[i + 3], x: f[i + 1], y: f[i + 2], fx: f[i + 1], fy: f[i + 2], h: Math.random() * 6.28, rv: 0, rt: 0, wob: Math.random() * 6.28 };
      } else {
        fi.fx = fi.x; fi.fy = fi.y;
        var dx = f[i + 1] - fi.tx, dy = f[i + 2] - fi.ty;
        if (dx * dx + dy * dy > 0.5) fi.th = Math.atan2(dy, dx);
      }
      fi.tx = f[i + 1]; fi.ty = f[i + 2]; fi.t0 = now;
      fseen[id] = 1;
    }
    for (id in S.fish) if (!fseen[id]) delete S.fish[id];
  }

  function onPing(m) {
    var own = m.id === S.me;
    var r = S.roster[m.id];
    S.pings.push({ x: m.x, y: m.y, t0: performance.now(), own: own, color: r ? r.color : '#3cf2c8', hit: {} });
    if (own) S.myPingCd = PING_CD;
  }

  function onCast(m) {
    var now = performance.now();
    var own = m.id === S.me;
    var r = S.roster[m.id];
    var color = r ? r.color : '#ffffff';
    S.nets.push({ x: m.x, y: m.y, t0: now, color: color, own: own, n: m.c.length });
    if (own) S.myCastCd = CAST_CD;
    var b = S.boats[m.id];
    for (var i = 0; i < 16; i++) {
      var a = Math.random() * Math.PI * 2, sp = 40 + Math.random() * 120;
      S.splashes.push({ x: m.x, y: m.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t0: now, life: 500 + Math.random() * 400 });
    }
    m.c.forEach(function (c, k) {
      var T = TYPES[c[1]];
      S.floaters.push({ kind: 'fish', type: c[1], x: c[2], y: c[3], tx: b ? b.x : m.x, ty: b ? b.y : m.y, t0: now + k * 25, life: 700 });
      delete S.fish[c[0]];
      void T;
    });
    if (m.c.length) {
      S.floaters.push({
        kind: 'text', x: m.x, y: m.y - 20, t0: now, life: 1400,
        text: (m.pts >= 0 ? '+' : '') + m.pts, color: m.pts < 0 ? '#ff5d73' : own ? '#3cf2c8' : '#ffffff', big: own
      });
    }
    if (own && m.c.length) {
      var sc = $('score');
      sc.classList.remove('bump'); void sc.offsetWidth; sc.classList.add('bump');
    }
  }

  // ------------------------------------------------------------------ input
  var keys = {};
  var steer = { active: false, id: null, x: 0, y: 0 };
  var lastSent = { x: 0, y: 0, t: 0 };

  function typing(e) {
    var t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
  }
  window.addEventListener('keydown', function (e) {
    if (typing(e)) return;
    var k = e.key.toLowerCase();
    if (k === ' ' || k === 'spacebar') { e.preventDefault(); if (!e.repeat) doCast(); return; }
    if (k === 'e' || k === 'q' || k === 'shift') { if (!e.repeat) doPing(); return; }
    if (k.indexOf('arrow') === 0) e.preventDefault();
    keys[k] = true;
  });
  window.addEventListener('keyup', function (e) { keys[e.key.toLowerCase()] = false; });
  window.addEventListener('blur', function () { keys = {}; steer.active = false; });

  cv.addEventListener('pointerdown', function (e) {
    if (!S.joined) return;
    if (e.button === 2) { doCast(); return; }
    steer.active = true; steer.id = e.pointerId; steer.x = e.clientX; steer.y = e.clientY;
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });
  cv.addEventListener('pointermove', function (e) {
    if (steer.active && e.pointerId === steer.id) { steer.x = e.clientX; steer.y = e.clientY; }
  });
  function endSteer(e) { if (e.pointerId === steer.id) steer.active = false; }
  cv.addEventListener('pointerup', endSteer);
  cv.addEventListener('pointercancel', endSteer);
  cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  function bindBtn(id, fn) {
    var b = $(id);
    b.addEventListener('pointerdown', function (e) { e.preventDefault(); fn(); });
    b.addEventListener('keydown', function (e) { if (e.key === 'Enter') fn(); });
  }
  bindBtn('btnPing', doPing);
  bindBtn('btnCast', doCast);

  function doPing() { if (S.joined && S.myPingCd <= 0) send({ t: 'ping' }); }
  function doCast() { if (S.joined && S.myCastCd <= 0 && S.phase === 0) send({ t: 'cast' }); }

  function worldToScreen(x, y) {
    return { x: (x - S.cam.x) * S.camScale + vw / 2, y: (y - S.cam.y) * S.camScale + vh / 2 };
  }

  function sendInput(now) {
    if (!S.joined) return;
    var x = 0, y = 0;
    if (keys.a || keys.arrowleft) x -= 1;
    if (keys.d || keys.arrowright) x += 1;
    if (keys.w || keys.arrowup) y -= 1;
    if (keys.s || keys.arrowdown) y += 1;
    var me = S.boats[S.me];
    if (steer.active && me) {
      var sp = worldToScreen(me.x, me.y);
      var dx = steer.x - sp.x, dy = steer.y - sp.y, d = Math.hypot(dx, dy);
      if (d > 8) {
        var mag = clamp((d - 8) / 110, 0, 1);
        x = (dx / d) * mag; y = (dy / d) * mag;
      }
    }
    var m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    x = Math.round(x * 100) / 100; y = Math.round(y * 100) / 100;
    var changed = Math.abs(x - lastSent.x) > 0.04 || Math.abs(y - lastSent.y) > 0.04;
    if ((changed && now - lastSent.t > 50) || now - lastSent.t > 400) {
      send({ t: 'in', x: x, y: y });
      lastSent = { x: x, y: y, t: now };
    }
  }

  // ------------------------------------------------------------------ rendering
  function reveal(f, str, now) {
    var cur = fishAlpha(f, now);
    if (str >= cur) { f.rv = str; f.rt = now; }
  }
  function fishAlpha(f, now) {
    if (!f.rt) return 0;
    var k = 1 - (now - f.rt) / REVEAL_MS;
    return k <= 0 ? 0 : f.rv * Math.min(1, k * 1.6);
  }

  function drawBoatShape(c, color) {
    c.beginPath();
    c.moveTo(20, 0);
    c.quadraticCurveTo(12, -9, -2, -9.5);
    c.lineTo(-15, -8);
    c.quadraticCurveTo(-17, 0, -15, 8);
    c.lineTo(-2, 9.5);
    c.quadraticCurveTo(12, 9, 20, 0);
    c.closePath();
    c.fillStyle = color;
    c.fill();
  }

  function drawBoat(b, now, isMe) {
    var r = S.roster[b.id] || { name: '?', color: '#ffffff', bot: false };
    ctx.save();
    ctx.translate(b.x, b.y);

    if (isMe) {
      // radar sweep
      var sa = (now / 1000) * 1.7;
      for (var i = 0; i < 14; i++) {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, SWEEP_R, sa - 0.06 * (i + 1), sa - 0.06 * i);
        ctx.closePath();
        ctx.fillStyle = 'rgba(60,242,200,' + (0.12 * (1 - i / 14)) + ')';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(0, 0, SWEEP_R, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(60,242,200,0.12)';
      ctx.setLineDash([3, 6]);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      // net target reticle
      var nx = Math.cos(b.a) * NET_AHEAD, ny = Math.sin(b.a) * NET_AHEAD;
      ctx.beginPath();
      ctx.arc(nx, ny, NET_R, 0, Math.PI * 2);
      ctx.strokeStyle = S.myCastCd > 0 ? 'rgba(255,179,71,0.12)' : 'rgba(255,179,71,0.35)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([8, 6]);
      ctx.lineDashOffset = -now / 60;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.rotate(b.a);
    // shadow
    ctx.save();
    ctx.translate(3, 4);
    ctx.globalAlpha = 0.35;
    drawBoatShape(ctx, '#000');
    ctx.restore();
    // hull
    drawBoatShape(ctx, r.color);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.stroke();
    // deck + cabin
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(-9, -5, 10, 10);
    ctx.fillStyle = 'rgba(3,16,26,0.7)';
    ctx.fillRect(-1, -4, 3, 8);
    // sonar beacon
    var pulse = 0.5 + 0.5 * Math.sin(now / 200 + b.id);
    ctx.beginPath();
    ctx.arc(-12, 0, 2.2 + pulse, 0, Math.PI * 2);
    ctx.fillStyle = isMe ? '#3cf2c8' : hexA(r.color, 0.9);
    ctx.fill();
    ctx.restore();

    // name tag
    var label = r.name + (r.bot ? ' · bot' : '');
    ctx.font = '600 12px "Chakra Petch", monospace';
    var w = ctx.measureText(label).width + 12;
    ctx.fillStyle = isMe ? 'rgba(60,242,200,0.9)' : 'rgba(3,16,26,0.7)';
    roundRect(ctx, b.x - w / 2, b.y - 40, w, 18, 9);
    ctx.fill();
    ctx.fillStyle = isMe ? '#02221a' : '#dafff5';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, b.x, b.y - 30.5);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function drawFish(f, a, now) {
    var T = TYPES[f.type];
    var s = T.size;
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = a;
    var gs = s * 7;
    ctx.drawImage(glow[f.type], -gs / 2, -gs / 2, gs, gs);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = T.color;
    if (f.type === 4) {
      // jellyfish: bell + trailing tentacles
      var bob = Math.sin(now / 400 + f.wob) * 1.5;
      ctx.beginPath();
      ctx.arc(0, bob, s, Math.PI, 0);
      ctx.quadraticCurveTo(0, bob + 3, -s, bob);
      ctx.fill();
      ctx.strokeStyle = T.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var t = -2; t <= 2; t++) {
        ctx.moveTo(t * 2.5, bob + 2);
        ctx.quadraticCurveTo(t * 2.5 + Math.sin(now / 300 + t) * 3, bob + 8, t * 2.5, bob + 13);
      }
      ctx.stroke();
    } else {
      ctx.rotate(f.h);
      var wag = Math.sin(now / 90 + f.wob) * 0.35;
      ctx.beginPath();
      ctx.ellipse(0, 0, s, s * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.translate(-s * 0.85, 0);
      ctx.rotate(wag);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-s * 0.75, -s * 0.5);
      ctx.lineTo(-s * 0.75, s * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      if (f.type === 3) {
        // goldfin sparkle
        ctx.rotate(-f.h + now / 500);
        ctx.strokeStyle = 'rgba(255,240,170,' + (0.6 * a) + ')';
        ctx.beginPath();
        ctx.moveTo(-s * 2, 0); ctx.lineTo(s * 2, 0);
        ctx.moveTo(0, -s * 2); ctx.lineTo(0, s * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawPing(p, now) {
    var r = Math.max(0, ((now - p.t0) / 1000) * PING_SPEED);
    if (r > PING_RANGE + 60) return false;
    var life = clamp(1 - r / PING_RANGE, 0, 1);
    var base = p.own ? 1 : 0.45;
    // trailing band
    var inner = Math.max(0, r - 60);
    var gr = ctx.createRadialGradient(p.x, p.y, inner, p.x, p.y, Math.max(inner + 1, r));
    gr.addColorStop(0, 'rgba(60,242,200,0)');
    gr.addColorStop(1, 'rgba(60,242,200,' + (0.16 * life * base) + ')');
    ctx.fillStyle = gr;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = p.own ? 'rgba(160,255,230,' + (0.85 * life) + ')' : hexA(p.color, 0.5 * life);
    ctx.lineWidth = p.own ? 2.5 : 1.5;
    ctx.stroke();
    if (r < PING_RANGE) {
      var str = !S.joined ? 1 : p.own ? 1 : 0.4;
      var r2 = r * r;
      for (var id in S.fish) {
        if (p.hit[id]) continue;
        var f = S.fish[id];
        var dx = f.x - p.x, dy = f.y - p.y;
        if (dx * dx + dy * dy <= r2) { p.hit[id] = 1; reveal(f, str, now); }
      }
    }
    return true;
  }

  function drawNet(n, now) {
    var t = Math.max(0, (now - n.t0) / 800);
    if (t >= 1) return false;
    var open = t < 0.35 ? t / 0.35 : 1;
    var r = lerp(14, NET_R, 1 - Math.pow(1 - open, 3));
    var alpha = t < 0.35 ? 1 : 1 - (t - 0.35) / 0.65;
    if (t > 0.35) r *= 1 - 0.35 * ((t - 0.35) / 0.65);
    ctx.save();
    ctx.translate(n.x, n.y);
    ctx.rotate(t * 1.5);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = n.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (var i = 0; i < 8; i++) {
      var a = (i / 8) * Math.PI * 2;
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.arc(0, 0, r * 0.66, 0, Math.PI * 2);
    ctx.moveTo(r * 0.33, 0);
    ctx.arc(0, 0, r * 0.33, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    return true;
  }

  function drawWakes(now) {
    ctx.lineWidth = 1.2;
    for (var i = S.wakes.length - 1; i >= 0; i--) {
      var w = S.wakes[i];
      var t = Math.max(0, (now - w.t0) / 1700);
      if (t >= 1) { S.wakes.splice(i, 1); continue; }
      ctx.beginPath();
      ctx.arc(w.x, w.y, 3 + t * 20, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(200,255,245,' + (0.28 * (1 - t)) + ')';
      ctx.stroke();
    }
  }

  function drawSplashes(now) {
    ctx.fillStyle = '#e8fffb';
    for (var i = S.splashes.length - 1; i >= 0; i--) {
      var s = S.splashes[i];
      var t = Math.max(0, (now - s.t0) / s.life);
      if (t >= 1) { S.splashes.splice(i, 1); continue; }
      var e = 1 - Math.pow(1 - t, 2);
      ctx.globalAlpha = 1 - t;
      ctx.beginPath();
      ctx.arc(s.x + s.vx * e * 0.6, s.y + s.vy * e * 0.6, 1.8 * (1 - t) + 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawFloaters(now) {
    for (var i = S.floaters.length - 1; i >= 0; i--) {
      var f = S.floaters[i];
      var t = (now - f.t0) / f.life;
      if (t >= 1) { S.floaters.splice(i, 1); continue; }
      if (t < 0) continue;
      if (f.kind === 'fish') {
        var e = t * t;
        var x = lerp(f.x, f.tx, e), y = lerp(f.y, f.ty, e) - Math.sin(t * Math.PI) * 30;
        var T = TYPES[f.type];
        ctx.globalAlpha = 1 - t * 0.6;
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(glow[f.type], x - 20, y - 20, 40, 40);
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = T.color;
        ctx.beginPath();
        ctx.arc(x, y, T.size * 0.6 * (1 - t * 0.5), 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.globalAlpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
        ctx.font = '700 ' + (f.big ? 26 : 16) + 'px "Chakra Petch", monospace';
        ctx.textAlign = 'center';
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(3,16,26,0.8)';
        var yy = f.y - t * 40;
        ctx.strokeText(f.text, f.x, yy);
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, f.x, yy);
        ctx.textAlign = 'start';
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawAmbient(now) {
    // slow light caustics
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < 3; i++) {
      var x = vw * (0.5 + 0.45 * Math.sin(now / (9000 + i * 3100) + i * 2));
      var y = vh * (0.5 + 0.45 * Math.cos(now / (11000 + i * 2700) + i));
      var r = Math.max(vw, vh) * 0.45;
      var g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(60,242,200,0.045)');
      g.addColorStop(1, 'rgba(60,242,200,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, vw, vh);
    }
    ctx.globalCompositeOperation = 'source-over';
    // plankton with parallax
    ctx.fillStyle = 'rgba(190,255,240,0.5)';
    for (var j = 0; j < plankton.length; j++) {
      var p = plankton[j];
      var px = (((p.x - S.cam.x * p.z * 0.5 + Math.sin(now / 3000 + p.ph) * 10) % vw) + vw) % vw;
      var py = (((p.y - S.cam.y * p.z * 0.5 + now / 1000 * 4 * p.z) % vh) + vh) % vh;
      ctx.globalAlpha = 0.15 + 0.35 * p.z;
      ctx.fillRect(px, py, p.s, p.s);
    }
    ctx.globalAlpha = 1;
  }

  function drawMinimap(now) {
    var md = mini.width / 200;
    mctx.setTransform(md, 0, 0, md, 0, 0);
    mctx.clearRect(0, 0, 200, 134);
    if (miniMapCanvas) {
      mctx.globalAlpha = 0.9;
      mctx.drawImage(miniMapCanvas, 0, 0);
      mctx.globalAlpha = 1;
    }
    var sx = 200 / S.W, sy = 134 / S.H;
    // view rect
    var hw = vw / 2 / S.camScale, hh = vh / 2 / S.camScale;
    mctx.strokeStyle = 'rgba(255,255,255,0.35)';
    mctx.lineWidth = 1;
    mctx.strokeRect((S.cam.x - hw) * sx, (S.cam.y - hh) * sy, hw * 2 * sx, hh * 2 * sy);
    // pings
    S.pings.forEach(function (p) {
      var r = Math.max(0, ((now - p.t0) / 1000) * PING_SPEED);
      mctx.beginPath();
      mctx.arc(p.x * sx, p.y * sy, r * sx, 0, Math.PI * 2);
      mctx.strokeStyle = hexA(p.color, 0.5 * clamp(1 - r / PING_RANGE, 0, 1));
      mctx.stroke();
    });
    for (var id in S.boats) {
      var b = S.boats[id], r = S.roster[id];
      var me = +id === S.me;
      mctx.beginPath();
      mctx.arc(b.x * sx, b.y * sy, me ? 3.5 : 2.5, 0, Math.PI * 2);
      mctx.fillStyle = r ? r.color : '#ffffff';
      mctx.fill();
      if (me) { mctx.strokeStyle = '#fff'; mctx.stroke(); }
    }
  }

  var spectT = Math.random() * 1000;
  var lastFrame = performance.now();

  // One clock for everything: event timestamps (pings, casts, snapshots) come from
  // performance.now(), so the renderer must use it too. The rAF timestamp can lag it.
  // A bad frame is logged and skipped, never allowed to stop the loop.
  function frame() {
    requestAnimationFrame(frame);
    try { render(performance.now()); } catch (err) { if (window.console) console.error(err); }
  }

  function render(now) {
    var dt = clamp((now - lastFrame) / 1000, 0, 0.05);
    lastFrame = now;
    S.myPingCd = Math.max(0, S.myPingCd - dt);
    S.myCastCd = Math.max(0, S.myCastCd - dt);
    sendInput(now);

    // interpolate entities
    var id, b, f, k;
    for (id in S.boats) {
      b = S.boats[id];
      k = Math.min(1, (now - b.t0) / S.snapDt);
      b.x = lerp(b.fx, b.tx, k);
      b.y = lerp(b.fy, b.ty, k);
      b.a = b.fa + angDiff(b.fa, b.ta) * k;
      if (b.spd > 30 && now - b.wakeT > 70) {
        b.wakeT = now;
        S.wakes.push({ x: b.x - Math.cos(b.a) * 16, y: b.y - Math.sin(b.a) * 16, t0: now });
      }
    }
    if (S.wakes.length > 500) S.wakes.splice(0, S.wakes.length - 500);
    for (id in S.fish) {
      f = S.fish[id];
      k = Math.min(1, (now - f.t0) / S.snapDt);
      f.x = lerp(f.fx, f.tx, k);
      f.y = lerp(f.fy, f.ty, k);
      if (f.th != null) f.h += angDiff(f.h, f.th) * 0.15;
    }

    // camera
    var me = S.me != null ? S.boats[S.me] : null;
    var targetScale, tx, ty;
    if (me) {
      tx = me.x; ty = me.y;
      targetScale = baseScale;
    } else {
      spectT += dt;
      tx = S.W / 2 + Math.cos(spectT * 0.05) * S.W * 0.28;
      ty = S.H / 2 + Math.sin(spectT * 0.07) * S.H * 0.25;
      targetScale = baseScale * 0.8;
    }
    var follow = me ? 1 - Math.pow(0.0015, dt) : 1 - Math.pow(0.3, dt);
    S.cam.x = lerp(S.cam.x, tx, follow);
    S.cam.y = lerp(S.cam.y, ty, follow);
    S.camScale = lerp(S.camScale, targetScale, 1 - Math.pow(0.05, dt));
    var sc = S.camScale;

    // background
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#010a10';
    ctx.fillRect(0, 0, vw, vh);

    // world
    ctx.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * (vw / 2 - S.cam.x * sc), dpr * (vh / 2 - S.cam.y * sc));
    if (mapCanvas) {
      var x0 = clamp(Math.floor(S.cam.x - vw / 2 / sc), 0, S.W), y0 = clamp(Math.floor(S.cam.y - vh / 2 / sc), 0, S.H);
      var x1 = clamp(Math.ceil(S.cam.x + vw / 2 / sc), 0, S.W), y1 = clamp(Math.ceil(S.cam.y + vh / 2 / sc), 0, S.H);
      if (x1 > x0 && y1 > y0) ctx.drawImage(mapCanvas, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
    }

    drawWakes(now);

    // sweep reveal + proximity
    var sweepA = (now / 1000) * 1.7;
    for (id in S.fish) {
      f = S.fish[id];
      if (me) {
        var dx = f.x - me.x, dy = f.y - me.y, d2 = dx * dx + dy * dy;
        if (d2 < SWEEP_R * SWEEP_R && Math.abs(angDiff(Math.atan2(dy, dx), sweepA)) < 0.25) reveal(f, 0.8, now);
      }
      var a = fishAlpha(f, now);
      if (a > 0.01) drawFish(f, a, now);
    }

    for (var i = S.nets.length - 1; i >= 0; i--) if (!drawNet(S.nets[i], now)) S.nets.splice(i, 1);
    for (id in S.boats) if (+id !== S.me) drawBoat(S.boats[id], now, false);
    if (me) drawBoat(me, now, true);
    for (var j = S.pings.length - 1; j >= 0; j--) if (!drawPing(S.pings[j], now)) S.pings.splice(j, 1);
    drawSplashes(now);
    drawFloaters(now);

    // screen-space ambience
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawAmbient(now);

    if (S.joined) {
      drawMinimap(now);
      updateHud(now);
    }
  }

  // ------------------------------------------------------------------ HUD
  var hudT = 0;
  function updateHud(now) {
    var pb = $('btnPing'), cb = $('btnCast');
    var pp = 1 - S.myPingCd / PING_CD, cp = S.phase === 0 ? 1 - S.myCastCd / CAST_CD : 0;
    pb.style.setProperty('--p', pp.toFixed(3));
    cb.style.setProperty('--p', cp.toFixed(3));
    pb.classList.toggle('ready', pp >= 1);
    cb.classList.toggle('ready', cp >= 1);

    if (now - hudT < 200) return;
    hudT = now;
    var me = S.boats[S.me];
    $('score').textContent = me ? me.score : 0;
    $('phaseLabel').textContent = S.phase === 0 ? 'Round ' + S.round : 'Next round';
    var t = $('timer');
    t.textContent = fmtTime(S.timeLeft);
    t.classList.toggle('low', S.phase === 0 && S.timeLeft <= 20);

    var list = Object.keys(S.boats).map(function (id) { return S.boats[id]; });
    list.sort(function (a, b) { return b.score - a.score; });
    var board = $('board');
    board.textContent = '';
    list.slice(0, 8).forEach(function (b) {
      var r = S.roster[b.id] || { name: '?', color: '#ffffff' };
      var li = el('li', b.id === S.me ? 'me' : '');
      var sw = el('span', 'swatch'); sw.style.background = r.color;
      var who = el('span', 'who', r.name);
      if (r.bot) who.appendChild(el('span', 'tag-bot', 'BOT'));
      li.appendChild(sw); li.appendChild(who); li.appendChild(el('span', 'sc', String(b.score)));
      board.appendChild(li);
    });

    if (!$('results').hidden) $('nextIn').textContent = String(Math.max(0, S.timeLeft));
  }

  function addFeed(text, kind) {
    var feed = $('feed');
    var li = el('li', kind || '', text);
    feed.appendChild(li);
    while (feed.children.length > 5) feed.removeChild(feed.firstChild);
    setTimeout(function () { li.classList.add('out'); }, 6000);
    setTimeout(function () { if (li.parentNode) li.parentNode.removeChild(li); }, 6700);
  }

  function onRoundEnd(m) {
    S.lastResults = m.results;
    S.pings = [];
    if (!S.joined) return;
    var list = $('resultsList');
    list.textContent = '';
    var myRank = -1;
    m.results.forEach(function (r, i) {
      if (r.id === S.me) myRank = i;
      var li = el('li', r.id === S.me ? 'me' : '');
      li.style.animationDelay = i * 60 + 'ms';
      li.appendChild(el('span', 'rank', String(i + 1)));
      var sw = el('span', 'swatch'); sw.style.background = r.color;
      li.appendChild(sw);
      var who = el('span', 'who', r.name);
      if (r.bot) who.appendChild(el('span', 'tag-bot', 'BOT'));
      if (r.best) { who.appendChild(document.createTextNode(' ')); who.appendChild(el('span', 'best', 'best: ' + r.best)); }
      li.appendChild(who);
      li.appendChild(el('span', 'sc', String(r.score)));
      list.appendChild(li);
    });
    $('resultsKicker').textContent = 'Round ' + m.round + ' over';
    $('resultsTitle').textContent = myRank === 0 ? 'You topped the haul!' : myRank > 0 ? 'You placed #' + (myRank + 1) : 'Results';
    $('results').hidden = false;
  }

  // ------------------------------------------------------------------ hall of fame
  function hallItems(target, rows) {
    target.textContent = '';
    if (!rows || !rows.length) {
      target.appendChild(el('li', 'empty', 'No rounds logged yet. Be the first.'));
      return;
    }
    rows.slice(0, 8).forEach(function (r) {
      var li = el('li');
      var who = el('span', 'who', r.name);
      if (r.best_catch) { who.appendChild(document.createTextNode(' ')); who.appendChild(el('span', 'best', r.best_catch)); }
      li.appendChild(who);
      li.appendChild(el('span', 'sc', String(r.score)));
      target.appendChild(li);
    });
  }
  function renderHall() {
    var h = S.hall;
    if (!h) return;
    hallItems($('hallList'), h.allTime);
    hallItems($('hallList2'), h.allTime);
    var total = 0, parts = [];
    TYPES.forEach(function (T) {
      var n = (h.species && h.species[T.key]) || 0;
      total += n;
      if (n) parts.push(n.toLocaleString() + ' ' + T.name.toLowerCase());
    });
    $('totals').textContent = total
      ? total.toLocaleString() + ' creatures netted across ' + (h.rounds || 0).toLocaleString() + ' logged hauls (' + parts.join(', ') + ').'
      : '';
  }
  function fetchHall() {
    if (!window.fetch) return;
    fetch('/api/leaderboard').then(function (r) { return r.ok ? r.json() : null; }).then(function (h) {
      if (h) { S.hall = h; renderHall(); }
    }).catch(function () { /* offline */ });
  }

  // ------------------------------------------------------------------ intro
  function renderSpecies() {
    var ul = $('speciesList');
    TYPES.forEach(function (T) {
      var li = el('li');
      var dot = el('span', 'dot'); dot.style.color = T.color;
      li.appendChild(dot);
      var nm = el('span', null, T.name + ' ');
      nm.appendChild(el('span', 'note', T.note));
      li.appendChild(nm);
      li.appendChild(el('span', 'pts' + (T.pts < 0 ? ' neg' : T.pts >= 30 ? ' gold' : ''), (T.pts > 0 ? '+' : '') + T.pts));
      ul.appendChild(li);
    });
  }

  var nameInput = $('name');
  nameInput.value = store('ff-name') || randomName();
  $('dice').addEventListener('click', function () { nameInput.value = randomName(); nameInput.focus(); });
  $('joinForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var n = nameInput.value.replace(/\s+/g, ' ').trim().slice(0, 16) || randomName();
    S.name = n;
    store('ff-name', n);
    S.wantJoin = true;
    send({ t: 'hello', name: n });
    nameInput.blur();
  });

  // ------------------------------------------------------------------ boot
  resize();
  renderSpecies();
  buildMap();
  fetchHall();
  connect();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { buildMap(); });
  requestAnimationFrame(frame);
})();
