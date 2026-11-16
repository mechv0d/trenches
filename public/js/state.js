/* ============================================================
   TRENCHES — core: state, network, input, audio
   ============================================================ */
'use strict';

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d', { alpha: false });
const DPR = Math.min(2, window.devicePixelRatio || 1);
const IS_TOUCH = matchMedia('(pointer: coarse)').matches;

const TEAM = {
  red:  { main: '#b23a32', bright: '#e2574a', dark: '#6e241f', tunic: '#7d3a2c', helmet: '#4a2a22', light: '#c9705f', name: 'RED' },
  blue: { main: '#34558c', bright: '#5a86c9', dark: '#22395f', tunic: '#33476b', helmet: '#25364f', light: '#7d9dcf', name: 'BLUE' },
  neutral: { main: '#8d8f7a', bright: '#c2c3ad', dark: '#4d4f3e', tunic: '#6d6f5a', helmet: '#4a4c3c', light: '#a8a992', name: 'NEUTRAL' },
};

const S = {
  ws: null, connected: false, token: null, username: null, authed: false, guest: false,
  me: null, world: null, terrain: null, terrainCanvas: null, terrainCtx: null,
  trenches: new Set(), config: null, ranks: [], mode: 'menu', serverMode: '',
  players: [], bots: [], bullets: [], grenades: [], vehicles: [], buildings: [], blueprints: [],
  resources: [], drops: [], cps: [], war: null, stock: { red: {}, blue: {} }, markers: [],
  deployed: false, chosenSide: null, sideLocked: false, spawnPoint: 'mob', deathUntil: 0, warEndUntil: 0,
  pred: { x: 0, y: 0, ang: 0 }, initialized: false, connectionLost: false,
  render: { players: new Map(), bots: new Map(), vehicles: new Map() },
  particles: [], floats: [], rings: [], rain: [], corpses: [],
  cam: { x: 0, y: 0 }, shake: 0,
  mouse: { x: innerWidth / 2, y: innerHeight / 2, down: false },
  keys: {}, touch: { active: false, dx: 0, dy: 0, fire: false, id: null },
  chatAll: [], knownFreqs: [], killFeed: [], selectedBuild: null, bridgeAxis: null, artillery: false, mortar: false,
  gfx: { grain: true, fog: true, shake: true },
  buildMenuAnchor: null, mortarTargets: [], radial: { open: false, cb: null },
  lastSend: 0, lastHud: 0, lastDeploy: 0, lastState: 0, mute: false,
  audio: null, ambience: null, lastShotSound: 0, menuT: 0, ping: 0, lastPing: 0,
  engineAudio: new Map(), engineLast: new Map(), stepT: 0, stepAlt: false,
  minimap: null, bigMap: null, deployMapDirty: true,
  trees: [], bushes: [], bushGrid: new Map(), buildMeta: new Map(), vehicleMeta: new Map(), cpById: new Map(), resourceMeta: new Map(),
  pendingAuth: false, paused: false, viewW: innerWidth, viewH: innerHeight,
  deathSpawn: 'mob', hints: { vehicle: null, resource: null, depot: false },
  playerCount: 0, lastFrame: 0, quality: 1,
};

/* ------------------------------------------------------------ */
/*  small helpers                                               */
/* ------------------------------------------------------------ */
function hash2(x, y) {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function lerp(a, b, k) { return a + (b - a) * k; }
function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }
function fmtTime(ms) {
  ms = Math.max(0, ms);
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (d > 0) return `${d}D ${String(h).padStart(2, '0')}H ${String(m).padStart(2, '0')}M`;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function fmtFreq(h, l) { return `${String(h).padStart(3, '0')}–${String(l).padStart(3, '0')}`; }
function sideName(s) { return s === 'red' ? 'RED' : s === 'blue' ? 'BLUE' : 'NEUTRAL'; }
function rankOf(me) { return (me && me.registered && S.ranks[me.rank]) ? S.ranks[me.rank] : { name: 'Guest Infantry', tag: 'GST', xp: 0 }; }
function myFreq() { return S.me ? fmtFreq(S.me.freq.high, S.me.freq.low) : '000–000'; }
function idxAt(tx, ty) { return ty * S.world.cols + tx; }
function tileAt(x, y) { return { tx: Math.floor(x / S.world.tile), ty: Math.floor(y / S.world.tile) }; }
function isTrench(x, y) {
  if (!S.world) return false;
  const t = tileAt(x, y);
  return S.trenches.has(idxAt(t.tx, t.ty));
}
function terrainType(x, y) {
  if (!S.world) return 0;
  const t = tileAt(x, y);
  if (t.tx < 0 || t.ty < 0 || t.tx >= S.world.cols || t.ty >= S.world.rows) return 3;
  return S.terrain[idxAt(t.tx, t.ty)];
}
const SOLID = new Set([9, 10]); // boulders and house walls; floors (11) and water are walkable
function isBridgeAt(x, y) {
  for (const b of S.buildings) {
    if (b.kind !== 'bridge' || b.hp <= 0) continue;
    const def = (S.config && S.config.buildings && S.config.buildings.bridge) || {};
    const w = (b.w || def.w || 8) * S.world.tile;
    const h = (b.h || def.h || 2) * S.world.tile;
    if (Math.abs(x - b.x) <= w / 2 && Math.abs(y - b.y) <= h / 2) return true;
  }
  return false;
}
function walkableAt(x, y) {
  if (!S.world) return false;
  if (x < 16 || y < 16 || x > S.world.w - 16 || y > S.world.h - 16) return false;
  return !SOLID.has(terrainType(x, y));
}
/* Bushes conceal infantry: standing inside one hides most of the silhouette. */
function concealedByBush(x, y) {
  if (!S.world || !S.bushGrid.size) return false;
  const tile = S.world.tile;
  const t = tileAt(x, y);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const list = S.bushGrid.get(idxAt(t.tx + dx, t.ty + dy));
    if (!list) continue;
    for (const b of list) {
      if (Math.hypot(x - b.x, y - b.y) < b.r * 0.9) return true;
    }
  }
  return false;
}
function meId() { return S.me ? S.me.id : null; }
function myPos() { return (S.deployed && S.me && !S.me.dead) ? S.pred : { x: S.me ? S.me.x : 0, y: S.me ? S.me.y : 0 }; }
function carryTotalOf(c) { return c ? (c.scrap || 0) + (c.fuel || 0) + (c.ammo || 0) : 0; }
function resHTML(type, val, extra) {
  const v = typeof val === 'number' ? Math.floor(val) : val;
  return `<span class="res res-${type}${extra ? ' ' + extra : ''}"><i class="ico-${type}"></i>${v == null ? '—' : v}</span>`;
}
function stockHTML(stock, extra) {
  const s = stock || {};
  return resHTML('scrap', s.scrap || 0, extra) + resHTML('fuel', s.fuel || 0, extra) + resHTML('ammo', s.ammo || 0, extra);
}
function myVehicle() { return (S.me && S.me.vehicle) ? S.vehicles.find(v => v.id === S.me.vehicle) : null; }

/* ------------------------------------------------------------ */
/*  ambient + effects sound (procedural)                        */
/* ------------------------------------------------------------ */
function initAudio() {
  if (S.audio) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    S.audio = new AC();
    const sr = S.audio.sampleRate;
    const buf = S.audio.createBuffer(1, sr * 2, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.5;
    S.noiseBuf = buf;
    // ambient wind
    const src = S.audio.createBufferSource();
    src.buffer = buf; src.loop = true;
    const lp = S.audio.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 340;
    const g = S.audio.createGain(); g.gain.value = 0.035;
    const lfo = S.audio.createOscillator(); lfo.frequency.value = 0.08;
    const lfoG = S.audio.createGain(); lfoG.gain.value = 0.02;
    lfo.connect(lfoG); lfoG.connect(g.gain); lfo.start();
    src.connect(lp); lp.connect(g); g.connect(S.audio.destination); src.start();
    S.ambience = { src, g };
  } catch (e) { /* audio unavailable */ }
}
function withAudio(fn) {
  if (!S.audio || S.mute) return;
  if (S.audio.state === 'suspended') S.audio.resume();
  fn(S.audio);
}
function sfxShot(weapon, distance) {
  if (!S.audio || S.mute) return;
  if ((distance || 0) > 1500) return; // distant fire is below the audible threshold
  const now = S.audio.currentTime;
  if (now - S.lastShotSound < 0.012) return;
  S.lastShotSound = now;
  const att = clamp(1 - (distance || 0) / 1400, 0.05, 1);
  const base = weapon === 'mg' ? 90 : weapon === 'smg' ? 140 : weapon === 'sniper' ? 70 : 120;
  const dur = weapon === 'mg' ? 0.11 : 0.16;
  const noise = S.audio.createBufferSource(); noise.buffer = S.noiseBuf;
  const bp = S.audio.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900 + Math.random() * 700; bp.Q.value = 0.8;
  const g = S.audio.createGain();
  g.gain.setValueAtTime(0.22 * att, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + dur);
  noise.connect(bp); bp.connect(g); g.connect(S.audio.destination);
  noise.start(now); noise.stop(now + dur);
  const osc = S.audio.createOscillator(); osc.type = 'square';
  osc.frequency.setValueAtTime(base, now);
  osc.frequency.exponentialRampToValueAtTime(base * 0.4, now + dur);
  const og = S.audio.createGain();
  og.gain.setValueAtTime(0.09 * att, now);
  og.gain.exponentialRampToValueAtTime(0.001, now + dur);
  osc.connect(og); og.connect(S.audio.destination); osc.start(now); osc.stop(now + dur);
}
function sfxExplosion(distance) {
  if (!S.audio || S.mute) return;
  if ((distance || 0) > 2400) return;
  const now = S.audio.currentTime;
  const att = clamp(1 - (distance || 0) / 2200, 0.04, 1);
  const noise = S.audio.createBufferSource(); noise.buffer = S.noiseBuf;
  const lp = S.audio.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500;
  const g = S.audio.createGain();
  g.gain.setValueAtTime(0.5 * att, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
  noise.connect(lp); lp.connect(g); g.connect(S.audio.destination);
  noise.start(now); noise.stop(now + 0.9);
  const osc = S.audio.createOscillator(); osc.type = 'sine';
  osc.frequency.setValueAtTime(70, now); osc.frequency.exponentialRampToValueAtTime(26, now + 0.7);
  const og = S.audio.createGain(); og.gain.setValueAtTime(0.35 * att, now);
  og.gain.exponentialRampToValueAtTime(0.001, now + 0.8);
  osc.connect(og); og.connect(S.audio.destination); osc.start(now); osc.stop(now + 0.8);
}
function sfxCrash(distance, heavy) {
  if (!S.audio || S.mute) return;
  if ((distance || 0) > 1200) return;
  const now = S.audio.currentTime;
  const att = clamp(1 - (distance || 0) / 1100, 0.05, 1);
  const n = S.audio.createBufferSource(); n.buffer = S.noiseBuf;
  const bp = S.audio.createBiquadFilter(); bp.type = 'bandpass';
  bp.frequency.value = heavy ? 240 : 420; bp.Q.value = 0.9;
  const g = S.audio.createGain();
  g.gain.setValueAtTime((heavy ? 0.5 : 0.3) * att, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + (heavy ? 0.55 : 0.32));
  n.connect(bp); bp.connect(g); g.connect(S.audio.destination); n.start(now); n.stop(now + 0.6);
  const o = S.audio.createOscillator(); o.type = 'triangle';
  o.frequency.setValueAtTime(heavy ? 95 : 150, now);
  o.frequency.exponentialRampToValueAtTime(heavy ? 36 : 70, now + 0.4);
  const og = S.audio.createGain(); og.gain.setValueAtTime((heavy ? 0.28 : 0.15) * att, now);
  og.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
  o.connect(og); og.connect(S.audio.destination); o.start(now); o.stop(now + 0.5);
}
/* Falling mortar shell: a thin descending whistle, louder as it drops. */
function sfxWhistle(distance) {
  if (!S.audio || S.mute) return;
  if ((distance || 0) > 1800) return;
  const now = S.audio.currentTime;
  const att = clamp(1 - (distance || 0) / 1600, 0.05, 1);
  const o = S.audio.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(1500, now);
  o.frequency.exponentialRampToValueAtTime(420, now + 0.55);
  const g = S.audio.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.09 * att, now + 0.08);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
  o.connect(g); g.connect(S.audio.destination); o.start(now); o.stop(now + 0.62);
}
function sfxHit(kill) {
  withAudio((a) => {
    const now = a.currentTime;
    const osc = a.createOscillator(); osc.type = 'triangle';
    osc.frequency.setValueAtTime(kill ? 720 : 520, now);
    osc.frequency.exponentialRampToValueAtTime(kill ? 240 : 380, now + 0.08);
    const g = a.createGain(); g.gain.setValueAtTime(0.08, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    osc.connect(g); g.connect(a.destination); osc.start(now); osc.stop(now + 0.1);
  });
}
function sfxHurt() {
  withAudio((a) => {
    const now = a.currentTime;
    // dull thump of a round hitting the body
    const n = a.createBufferSource(); n.buffer = S.noiseBuf;
    const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    const ng = a.createGain(); ng.gain.setValueAtTime(0.22, now);
    ng.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    n.connect(lp); lp.connect(ng); ng.connect(a.destination); n.start(now); n.stop(now + 0.2);
    const o = a.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(190, now); o.frequency.exponentialRampToValueAtTime(70, now + 0.22);
    const og = a.createGain(); og.gain.setValueAtTime(0.08, now);
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
    o.connect(og); og.connect(a.destination); o.start(now); o.stop(now + 0.25);
  });
}
function sfxClick() {
  withAudio((a) => {
    const now = a.currentTime;
    const osc = a.createOscillator(); osc.type = 'square'; osc.frequency.value = 340;
    const g = a.createGain(); g.gain.setValueAtTime(0.03, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    osc.connect(g); g.connect(a.destination); osc.start(now); osc.stop(now + 0.06);
  });
}
function sfxRadio() {
  withAudio((a) => {
    const now = a.currentTime;
    const n = a.createBufferSource(); n.buffer = S.noiseBuf;
    const bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 2;
    const g = a.createGain(); g.gain.setValueAtTime(0.05, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    n.connect(bp); bp.connect(g); g.connect(a.destination); n.start(now); n.stop(now + 0.25);
  });
}
function sfxPromote() {
  withAudio((a) => {
    [392, 523, 659, 784].forEach((f, i) => {
      const t = a.currentTime + i * 0.11;
      const o = a.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
      const g = a.createGain(); g.gain.setValueAtTime(0.06, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + 0.22);
    });
  });
}

/* ------------------------------------------------------------ */
/*  engines, footsteps and war-end cues                          */
/* ------------------------------------------------------------ */
function engineNode(id) {
  let e = S.engineAudio.get(id);
  if (e) return e;
  const a = S.audio;
  const gain = a.createGain(); gain.gain.value = 0;
  const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 3;
  const o1 = a.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 52;
  const o2 = a.createOscillator(); o2.type = 'square'; o2.frequency.value = 26;
  const g2 = a.createGain(); g2.gain.value = 0.35;
  o1.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(gain); gain.connect(a.destination);
  o1.start(); o2.start();
  e = { gain, lp, o1, o2, lastX: null, lastY: null, lastT: 0 };
  S.engineAudio.set(id, e);
  return e;
}
function killEngineNode(id) {
  const e = S.engineAudio.get(id);
  if (!e) return;
  try {
    e.gain.gain.setTargetAtTime(0, S.audio.currentTime, 0.05);
    setTimeout(() => { try { e.o1.stop(); e.o2.stop(); e.gain.disconnect(); } catch (err) { /* already gone */ } }, 260);
  } catch (err) { /* audio context closed */ }
  S.engineAudio.delete(id);
}
/* Continuous engine drone for every vehicle in earshot. Pitch rises with the
   vehicle's actual speed and the whole drone is attenuated with distance. */
function updateEngineAudio(dt) {
  if (!S.audio) return;
  const now = S.audio.currentTime;
  const mePos = S.deployed && S.me && !S.me.dead ? myPos() : { x: S.cam.x + S.viewW / 2, y: S.cam.y + S.viewH / 2 };
  const live = new Set();
  for (const v of S.vehicles) {
    if (!v || v.hp <= 0) continue;
    const d = Math.hypot(v.x - mePos.x, v.y - mePos.y);
    if (d > 1100) continue;
    live.add(v.id);
    const e = engineNode(v.id);
    let prev = S.engineLast.get(v.id);
    if (!prev) { prev = { x: v.x, y: v.y, t: performance.now() }; S.engineLast.set(v.id, prev); }
    const t = performance.now();
    const travel = Math.hypot(v.x - prev.x, v.y - prev.y);
    const speed = Math.max(0, Math.min(320, (travel / Math.max(16, t - prev.t)) * 1000));
    prev.x = v.x; prev.y = v.y; prev.t = t;
    const tank = v.kind === 'tank';
    const truck = v.kind === 'truck';
    const base = tank ? 34 : truck ? 46 : 55;
    const rpm = base + speed * (tank ? 0.22 : 0.38);
    const att = clamp(1 - d / 1100, 0, 1);
    const own = S.me && S.me.vehicle === v.id;
    const vol = (S.mute ? 0 : 1) * att * (own ? 0.11 : 0.075) * (0.55 + Math.min(1, speed / 90) * 0.7);
    try {
      e.o1.frequency.setTargetAtTime(rpm, now, 0.08);
      e.o2.frequency.setTargetAtTime(rpm * 0.5, now, 0.08);
      e.lp.frequency.setTargetAtTime(360 + speed * 2.4, now, 0.1);
      e.gain.gain.setTargetAtTime(vol, now, 0.09);
    } catch (err) { /* ignore */ }
  }
  for (const id of Array.from(S.engineAudio.keys())) {
    if (!live.has(id)) { killEngineNode(id); S.engineLast.delete(id); }
  }
}
function sfxStep(surface, sprint) {
  withAudio((a) => {
    const now = a.currentTime;
    const n = a.createBufferSource(); n.buffer = S.noiseBuf;
    const f = a.createBiquadFilter();
    const g = a.createGain();
    let dur = 0.11, vol = sprint ? 0.05 : 0.038, freq = 780;
    if (surface === 'water') { f.type = 'lowpass'; freq = 620; dur = 0.2; vol = 0.085; }
    else if (surface === 'mud') { f.type = 'lowpass'; freq = 430; dur = 0.15; vol = 0.07; }
    else if (surface === 'hard') { f.type = 'bandpass'; freq = 1350; f.Q.value = 1.4; dur = 0.075; vol = 0.045; }
    else { f.type = 'bandpass'; freq = 720; f.Q.value = 0.9; }
    f.frequency.value = freq + (S.stepAlt ? 60 : 0);
    g.gain.setValueAtTime(vol, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    n.connect(f); f.connect(g); g.connect(a.destination);
    n.start(now); n.stop(now + dur + 0.02);
  });
  S.stepAlt = !S.stepAlt;
}
/* Footsteps follow the local soldier's input, not the network tick, so they
   stay in sync with what the player sees. */
function updateFootsteps(dt) {
  if (!S.audio || S.mute || !S.deployed || !S.me || S.me.dead || S.me.vehicle) { S.stepT = 0; return; }
  const iv = inputVector();
  if (!iv.active) { S.stepT = Math.min(S.stepT, 0.06); return; }
  const p = S.pred;
  const tt = terrainType(p.x, p.y);
  const surface = (tt === 3 && !isBridgeAt(p.x, p.y)) ? 'water'
    : (tt === 5 || tt === 6 || tt === 7) ? 'mud'
      : (tt === 4 || tt === 8 || tt === 11) ? 'hard' : 'grass';
  const interval = (iv.sprint ? 0.31 : 0.45) * (surface === 'water' ? 1.35 : 1);
  S.stepT += dt;
  // walking through water is continuous splashing rather than clean footfalls
  if (surface === 'water') {
    if (S.stepT > 0.28) { S.stepT = 0; sfxStep(surface, iv.sprint); }
  } else if (S.stepT >= interval) {
    S.stepT = 0;
    sfxStep(surface, iv.sprint);
  }
}
function sfxVictory() {
  withAudio((a) => {
    const now = a.currentTime;
    // bugle-like rising call, then a warm major chord
    const call = [[392, 0], [523, 0.16], [659, 0.32], [784, 0.5]];
    for (const [f, t] of call) {
      const o = a.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
      const g = a.createGain(); g.gain.setValueAtTime(0.0001, now + t);
      g.gain.exponentialRampToValueAtTime(0.09, now + t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, now + t + 0.34);
      o.connect(g); g.connect(a.destination); o.start(now + t); o.stop(now + t + 0.36);
    }
    [392, 494, 587, 784].forEach((f) => {
      const o = a.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const g = a.createGain(); g.gain.setValueAtTime(0.0001, now + 0.62);
      g.gain.exponentialRampToValueAtTime(0.05, now + 0.68);
      g.gain.exponentialRampToValueAtTime(0.001, now + 2.6);
      o.connect(g); g.connect(a.destination); o.start(now + 0.62); o.stop(now + 2.7);
    });
  });
}
function sfxDefeat() {
  withAudio((a) => {
    const now = a.currentTime;
    // slow descending minor figure, low drums underneath
    const notes = [[392, 0], [349, 0.28], [294, 0.6], [233, 1.0]];
    for (const [f, t] of notes) {
      const o = a.createOscillator(); o.type = 'triangle'; o.frequency.setValueAtTime(f, now + t);
      o.frequency.exponentialRampToValueAtTime(f * 0.94, now + t + 0.5);
      const g = a.createGain(); g.gain.setValueAtTime(0.0001, now + t);
      g.gain.exponentialRampToValueAtTime(0.075, now + t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.001, now + t + 0.75);
      o.connect(g); g.connect(a.destination); o.start(now + t); o.stop(now + t + 0.8);
    }
    for (const t of [0, 0.62, 1.24]) {
      const o = a.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(72, now + t);
      o.frequency.exponentialRampToValueAtTime(38, now + t + 0.4);
      const g = a.createGain(); g.gain.setValueAtTime(0.1, now + t);
      g.gain.exponentialRampToValueAtTime(0.001, now + t + 0.45);
      o.connect(g); g.connect(a.destination); o.start(now + t); o.stop(now + t + 0.5);
    }
  });
}

/* ------------------------------------------------------------ */
/*  networking                                                  */
/* ------------------------------------------------------------ */
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  S.ws = new WebSocket(`${proto}://${location.host}`);
  S.ws.onopen = () => {
    S.connected = true;
    $('fsOnline').textContent = 'CONNECTED';
    if (S.token && S.username) sendAuth();
    else if (S.pendingAuth) sendAuth();
  };
  S.ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    handleMessage(msg);
  };
  S.ws.onclose = () => {
    S.connected = false;
    if (S.initialized) toast('CONNECTION LOST — RECONNECTING', 'red');
    setTimeout(connect, 2200);
  };
  S.ws.onerror = () => {};
}
function sendMsg(obj) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
}
function sendAuth() {
  if (!S.token) return;
  S.pendingAuth = false;
  sendMsg({ type: 'auth', username: S.username, token: S.token });
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'init': onInit(msg); break;
    case 'state': onState(msg); break;
    case 'event': onEvent(msg); break;
    case 'chat': addChat(msg); break;
    case 'marker': addMarker(msg.marker); break;
    case 'toast': toast(msg.text, msg.level); break;
    case 'hitmark': showHitmark(msg.kill); sfxHit(msg.kill); break;
    case 'damaged': onDamaged(msg); break;
    case 'died': onDied(msg); break;
    case 'deployed': onDeployed(msg); break;
    case 'auth_ok': onAuthOk(msg); break;
    case 'auth_fail': onAuthFail(msg); break;
    case 'side_set': onSideSet(msg); break;
    case 'freq_set': onFreqSet(msg); break;
    case 'known_freq': addKnownFreq(msg.freq); break;
    case 'profile': renderProfile(msg.user); break;
    case 'kit': if (S.me) { S.me.weapon = msg.weapon; S.me.armor = msg.armor; S.me.ammo = msg.ammo; }
      if (!$('modalArmory').classList.contains('hidden')) renderArmory();
      updateHud();
      break;
    case 'vehicle': onVehicleMsg(msg); break;
    case 'gather': addFloat(myPos().x, myPos().y - 24, `+${msg.amount} ${msg.resource.toUpperCase()}`, '#d9a441'); break;
    case 'deposit': {
      addFloat(myPos().x, myPos().y - 30, `DELIVERED +${msg.total}`, '#d9a441');
      toast(`SUPPLIES DELIVERED — ${msg.total}`, 'gold');
      break;
    }
    case 'withdraw': {
      addFloat(myPos().x, myPos().y - 30, `LOADED +${msg.total}`, '#d9a441');
      toast(`LOADED FROM MOB — ${msg.total}`, 'gold');
      break;
    }
    case 'reloaded': sfxClick(); break;
    case 'rankup': onRankup(msg); break;
    case 'war_end': onWarEnd(msg); break;
    case 'new_war': onNewWar(msg); break;
    case 'building_added': addBuilding(msg.building); break;
    case 'vehicle_added': addVehicle(msg.vehicle); break;
    case 'trench_added': addTrenchTile(msg.tx, msg.ty); break;
    case 'blueprint': addBlueprint(msg.blueprint); break;
    case 'blueprint_done': S.blueprints = S.blueprints.filter(bp => bp.id !== msg.id); break;
    case 'vehicle_crew': {
      const v = S.vehicles.find(x => x.id === msg.id);
      if (v) v.crew = msg.crew;
      break;
    }
    case 'tree_hit': {
      const t = S.trees.find(x => x.id === msg.id);
      if (t) t.hp = msg.hp;
      break;
    }
    case 'renamed': if (S.me) S.me.name = msg.name; break;
    case 'pong': S.ping = Date.now() - msg.t; break;
  }
}

function onInit(msg) {
  S.world = msg.world;
  S.terrain = new Uint8Array(msg.terrain);
  S.trenches = new Set(msg.trenches);
  S.trees = (msg.trees || []).map(t => ({ ...t, maxHp: t.maxHp || 100 }));
  S.bushes = msg.bushes || [];
  S.bushGrid = new Map();
  for (const b of S.bushes) {
    const key = idxAt(Math.floor(b.x / msg.world.tile), Math.floor(b.y / msg.world.tile));
    if (!S.bushGrid.has(key)) S.bushGrid.set(key, []);
    S.bushGrid.get(key).push(b);
  }
  S.config = msg.config;
  S.ranks = msg.ranks;
  S.serverMode = msg.mode;
  S.me = msg.player;
  S.mode = 'menu';
  S.sideLocked = !!(msg.player && msg.player.sideLocked);
  S.cps = msg.capturePoints || [];
  S.cpById = new Map(S.cps.map(c => [c.id, c]));
  S.buildings = [];
  S.buildMeta = new Map();
  (msg.buildings || []).forEach(b => { S.buildings.push(b); S.buildMeta.set(b.id, b); });
  S.vehicles = [];
  S.vehicleMeta = new Map();
  (msg.vehicles || []).forEach(v => { S.vehicles.push(v); S.vehicleMeta.set(v.id, v); });
  S.resources = msg.resources || [];
  S.resourceMeta = new Map(S.resources.map(r => [r.id, r]));
  S.drops = msg.drops || [];
  S.blueprints = msg.blueprints || [];
  S.war = msg.war;
  S.stock = msg.stock;
  S.structures = (msg.structures || []).map(st => ({ ...st, _roofA: 1 }));
  S.initialized = true;
  buildTerrain();
  buildMinimap();
  renderDeploy();
  updateFrontStatus();
  updateMenuState();
  if (S.pendingAuth) sendAuth();
  // initial cinematic camera
  S.cam.x = S.world.w / 2 - S.viewW / 2;
  S.cam.y = S.world.h / 2 - S.viewH / 2;
}

function onState(msg) {
  S.lastState = performance.now();
  const oldMe = S.me;
  const myId = meId();
  S.players = msg.players || [];
  S.bots = msg.bots || [];
  S.bullets = msg.bullets || [];
  S.grenades = msg.grenades || [];
  S.cps = mergeCps(S.cps, msg.capturePoints);
  S.cpById = new Map(S.cps.map(c => [c.id, c]));
  if (msg.buildings) {
    const alive = new Set();
    for (const b of msg.buildings) {
      alive.add(b.id);
      const meta = S.buildMeta.get(b.id);
      if (meta) meta.hp = b.hp; else S.buildMeta.set(b.id, { ...b });
    }
    for (const id of Array.from(S.buildMeta.keys())) if (!alive.has(id)) S.buildMeta.delete(id);
  }
  S.buildings = Array.from(S.buildMeta.values()).filter(b => b.hp > 0);
  if (msg.vehicles) {
    const list = [];
    for (const v of msg.vehicles) {
      S.vehicleMeta.set(v.id, v);
      list.push(v);
    }
    S.vehicles = list;
  }
  if (msg.resources) for (const r of msg.resources) {
    const meta = S.resourceMeta.get(r.id);
    if (meta) meta.amount = r.amount; else S.resourceMeta.set(r.id, { ...r });
  }
  S.resources = Array.from(S.resourceMeta.values());
  S.drops = msg.drops || [];
  S.blueprints = msg.blueprints || [];
  S.war = msg.war;
  S.stock = msg.stock;
  S.markers = msg.markers || [];
  S.playerCount = S.players.length;
  S.me = S.players.find(p => p.id === myId) || S.me;
  if (S.me) S.sideLocked = !!S.me.sideLocked;
  if (S.me && S.me.side && !S.chosenSide) S.chosenSide = S.me.side;
  if (S.me && !S.me.side && S.mode !== 'hud') S.chosenSide = null;

  // interpolate targets
  syncRenderMap(S.render.players, S.players, true);
  syncRenderMap(S.render.bots, S.bots, true);
  syncRenderMap(S.render.vehicles, S.vehicles, true);
  if (S.deployed && S.me && !S.me.dead && !S.me.vehicle) {
    // reconcile prediction gently
    const d = dist(S.pred.x, S.pred.y, S.me.x, S.me.y);
    if (d > 160) { S.pred.x = S.me.x; S.pred.y = S.me.y; }
    else { S.pred.x = lerp(S.pred.x, S.me.x, 0.13); S.pred.y = lerp(S.pred.y, S.me.y, 0.13); }
  }
  if (S.mode === 'deploy' && performance.now() - S.lastDeploy > 700) { S.lastDeploy = performance.now(); updateDeployLive(); }
  if (S.mode === 'hud' || S.mode === 'death') {
    if (performance.now() - S.lastHud > 90) { S.lastHud = performance.now(); updateHud(); }
  }
  updateMenuState();
}

function mergeCps(old, incoming) {
  if (!incoming) return old;
  const map = new Map((old || []).map(c => [c.id, c]));
  for (const c of incoming) {
    const o = map.get(c.id);
    map.set(c.id, o ? { ...o, ...c } : c);
  }
  return Array.from(map.values());
}
function syncRenderMap(map, list, hasAngle) {
  const seen = new Set();
  for (const e of list) {
    seen.add(e.id);
    let r = map.get(e.id);
    if (!r) { map.set(e.id, { x: e.x, y: e.y, tx: e.x, ty: e.y, a: e.angle || 0, ta: e.angle || 0 }); }
    else { r.tx = e.x; r.ty = e.y; if (hasAngle) r.ta = e.angle || 0; }
  }
  for (const id of map.keys()) if (!seen.has(id)) map.delete(id);
}

function addBuilding(b) {
  if (!b || b.id == null) return;
  S.buildMeta.set(b.id, { ...b });
  S.buildings = Array.from(S.buildMeta.values()).filter(x => x.hp > 0);
  S.deployMapDirty = true;
}

function addVehicle(v) {
  if (!v || v.id == null) return;
  S.vehicleMeta.set(v.id, { ...v });
  if (!S.vehicles.some(x => x.id === v.id)) S.vehicles.push({ ...v });
}

function addBlueprint(bp) {
  if (!bp || bp.id == null) return;
  const i = S.blueprints.findIndex(x => x.id === bp.id);
  if (i >= 0) S.blueprints[i] = bp; else S.blueprints.push(bp);
}

function onEvent(ev) {
  switch (ev.kind) {
    case 'shot': {
      const my = myPos();
      const d = dist(ev.x, ev.y, my.x, my.y);
      addMuzzle(ev.x, ev.y, ev.angle, ev.side);
      sfxShot(ev.weapon, d);
      if (ev.id === meId()) { S.shake = Math.min(S.shake + 1.4, 4); }
      break;
    }
    case 'impact':
      addImpact(ev.x, ev.y, ev.kind);
      break;
    case 'explosion': {
      const my = myPos();
      const d = dist(ev.x, ev.y, my.x, my.y);
      addExplosion(ev.x, ev.y, ev.radius);
      scorch(ev.x, ev.y, ev.radius);
      sfxExplosion(d);
      S.shake = Math.min(S.shake + clamp(22 - d / 30, 1, 22), 26);
      break;
    }
    case 'kill':
      addKillFeed(ev);
      if (ev.x != null) addCorpse(ev.x, ev.y, ev.victimSide);
      if (ev.killerSide === (S.me && S.me.side)) {
        addFloat(ev.x || 0, ev.y || 0, '', '#fff');
      }
      break;
    case 'capture': {
      const c = S.cpById.get(ev.id);
      if (c) c.owner = ev.side;
      addSystem(`${ev.name} ${ev.side === 'neutral' ? 'abandoned' : 'captured by ' + sideName(ev.side)}`, 'warn');
      toast(`${ev.name} — ${sideName(ev.side)}`, ev.side === 'red' ? 'red' : 'blue');
      S.deployMapDirty = true;
      break;
    }
    case 'built':
      toast(`${ev.kind.toUpperCase()} CONSTRUCTED`, 'gold');
      addFloat(ev.x, ev.y - 20, '+20 XP', '#d9a441');
      break;
    case 'vehicle_spawned':
      toast(`${ev.kind.replace('_', ' ').toUpperCase()} ROLLING OUT`, 'gold');
      break;
    case 'vehicle_destroyed':
      addSystem(`Vehicle destroyed`, 'warn');
      break;
    case 'vehicle_impact': {
      const my = myPos();
      const d = dist(ev.x, ev.y, my.x, my.y);
      sfxCrash(d, ev.heavy);
      if (d < 420) S.shake = Math.min(S.shake + (ev.heavy ? 5 : 3), 16);
      break;
    }
    case 'building_destroyed':
      addSystem(`${ev.kind} destroyed`, 'warn');
      break;
    case 'barrage':
      if (ev.side === (S.me && S.me.side)) {
        toast('ARTILLERY FIRE MISSION — SPLASH IN 3s', 'amber');
        addSystem('Friendly barrage incoming. Danger close.', 'warn');
      } else {
        addSystem('Enemy artillery falling!', 'warn');
      }
      break;
    case 'mortar_incoming': {
      const my = myPos();
      const d = dist(ev.x, ev.y, my.x, my.y);
      S.mortarTargets.push({ x: ev.x, y: ev.y, side: ev.side, at: performance.now() + 6800 });
      if (ev.side === (S.me && S.me.side)) {
        toast('MORTAR STRIKE INBOUND — SHELLS FALLING', 'amber');
        addSystem(`${ev.by || 'A spotter'} called mortars onto the grid.`, 'warn');
      } else {
        toast('ENEMY MORTARS — TAKE COVER', 'red');
        addSystem('Incoming mortar fire!', 'warn');
      }
      for (let i = 0; i < 7; i++) setTimeout(() => sfxWhistle(d), 2150 + i * 620);
      break;
    }
    case 'medkit':
      addFloat(ev.x, ev.y - 26, 'MEDKIT +', '#7fbf6a');
      if (S.me && dist(ev.x, ev.y, myPos().x, myPos().y) < 500) {
        S.rings.push({ x: ev.x, y: ev.y, r: 6, max: 46, life: 0.9, maxLife: 0.9, color: 'rgba(127,191,106,.8)' });
      }
      break;
    case 'bark':
      addFloat(ev.x, ev.y - 26, ev.text, '#d9cfa8');
      break;
    case 'rankup':
      if (S.me && ev.id === S.me.id) { sfxPromote(); }
      if (ev.side === (S.me && S.me.side)) addSystem(`${ev.name} promoted to ${ev.rankName}`, 'warn');
      break;
    case 'toast':
      if (!ev.to || ev.to === meId()) toast(ev.text, ev.level);
      break;
    case 'resource_back':
      break;
  }
}

function onAuthOk(msg) {
  S.authed = true;
  S.me = msg.player;
  S.sideLocked = !!(msg.player && msg.player.sideLocked);
  S.deployed = false;
  S.chosenSide = S.me.side || null;
  S.guest = false;
  S.mode = 'deploy';
  S.pendingAuth = false;
  $('authMsg').textContent = '';
  showScreen('deploy');
  renderDeploy();
  updateMenuState();
}
function onAuthFail(msg) {
  S.pendingAuth = false;
  S.token = null;
  $('authMsg').textContent = msg.error || 'Session expired — sign in again';
  $('authMsg').className = 'auth-msg';
  showScreen('menu');
}

/* ------------------------------------------------------------ */
/*  auth                                                        */
/* ------------------------------------------------------------ */
async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
async function doLogin() {
  const u = $('username').value.trim();
  const p = $('password').value;
  if (!u || !p) return authMsg('Enter name and password');
  try {
    authMsg('Signing in…', true);
    const j = await api('/api/login', { username: u, password: p });
    S.token = j.token; S.username = u; S.authed = true; S.guest = false;
    storeSession();
    if (S.initialized) sendAuth(); else S.pendingAuth = true;
    authMsg('Authenticated. Awaiting orders.', true);
  } catch (e) { authMsg(e.message); }
}
async function doRegister() {
  const u = $('username').value.trim();
  const p = $('password').value;
  if (!u || !p) return authMsg('Enter name and password');
  if (p.length < 4) return authMsg('Password must be 4+ characters');
  try {
    authMsg('Enlisting…', true);
    const j = await api('/api/register', { username: u, password: p });
    S.token = j.token; S.username = u; S.authed = true; S.guest = false;
    storeSession();
    if (S.initialized) sendAuth(); else S.pendingAuth = true;
    authMsg('Enlisted. Welcome to the front.', true);
  } catch (e) { authMsg(e.message); }
}
function doGuest() {
  initAudio();
  const typed = $('username').value.trim().replace(/[^\w\- ]/g, '').slice(0, 16);
  S.guest = true;
  S.username = null;
  S.chosenSide = null;
  if (typed) sendMsg({ type: 'rename', name: typed });
  S.mode = 'deploy';
  showScreen('deploy');
  renderDeploy();
  updateMenuState();
}
function storeSession() {
  try { localStorage.setItem('trenches_session', JSON.stringify({ username: S.username, token: S.token })); } catch { /* ignore */ }
}
function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem('trenches_session') || 'null');
    if (s && s.token) { S.token = s.token; S.username = s.username; S.pendingAuth = true; }
  } catch { /* ignore */ }
}
function loadGfx() {
  try {
    const g = JSON.parse(localStorage.getItem('trenches_gfx') || 'null');
    if (g && typeof g === 'object') Object.assign(S.gfx, g);
  } catch { /* ignore */ }
}
function saveGfx() {
  try { localStorage.setItem('trenches_gfx', JSON.stringify(S.gfx)); } catch { /* ignore */ }
}
function authMsg(text, ok) {
  const el = $('authMsg');
  el.textContent = text;
  el.className = 'auth-msg' + (ok ? ' ok' : '');
}

/* ------------------------------------------------------------ */
/*  input                                                       */
/* ------------------------------------------------------------ */
function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
/* Physical key code, with a fallback for environments that only fill e.key. */
function codeOf(e) {
  if (e.code) return e.code;
  const k = String(e.key || '').toLowerCase();
  const map = {
    w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD', r: 'KeyR', g: 'KeyG', e: 'KeyE',
    f: 'KeyF', v: 'KeyV', n: 'KeyN', m: 'KeyM', b: 'KeyB', h: 'KeyH', p: 'KeyP',
    t: 'KeyT', tab: 'Tab', enter: 'Enter', escape: 'Escape', shift: 'ShiftLeft',
    arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  };
  return map[k] || '';
}
function keydown(e) {
  if (isTyping(e)) {
    if (codeOf(e) === 'Escape') e.target.blur();
    else if (codeOf(e) === 'Tab') { e.preventDefault(); toggleScoreboard(); e.target.blur(); }
    return;
  }
  // Physical codes: works with any keyboard layout (e.g. Russian ЙЦУКЕН).
  const c = codeOf(e);
  if (!c) return;
  if (c === 'KeyW' || c === 'ArrowUp') { S.keys.w = true; e.preventDefault(); return; }
  if (c === 'KeyS' || c === 'ArrowDown') { S.keys.s = true; e.preventDefault(); return; }
  if (c === 'KeyA' || c === 'ArrowLeft') { S.keys.a = true; e.preventDefault(); return; }
  if (c === 'KeyD' || c === 'ArrowRight') { S.keys.d = true; e.preventDefault(); return; }
  if (c === 'ShiftLeft' || c === 'ShiftRight') { S.keys.shift = true; return; }
  if (c === 'Escape') {
    if (S.radial.open) { closeRadial(); return; }
    togglePause(); return;
  }
  if (S.mode !== 'hud' || !S.deployed) return;
  // An open radio in the field locks every control except movement.
  if (radioRestricted()) return;
  if (e.repeat) return;
  switch (c) {
    case 'KeyR':
      if (S.selectedBuild === 'bridge') {
        S.bridgeAxis = S.bridgeAxis === null ? 'h' : S.bridgeAxis === 'h' ? 'v' : null;
        toast(S.bridgeAxis === null ? 'BRIDGE ORIENTATION — AUTO' : S.bridgeAxis === 'h' ? 'BRIDGE ORIENTATION — EAST–WEST' : 'BRIDGE ORIENTATION — NORTH–SOUTH', 'amber');
        e.preventDefault(); break;
      }
      if (S.me && !S.me.dead) sendMsg({ type: 'reload' });
      e.preventDefault(); break;
    case 'KeyG': sendMsg({ type: 'grenade' }); e.preventDefault(); break;
    case 'KeyE': S.keys.e = true; sendMsg({ type: 'interact' }); e.preventDefault(); break;
    case 'KeyF':
      S.keys.f = true;
      // Hold F beside a blueprint to build; otherwise F mounts/dismounts.
      if (!nearBlueprint()) sendMsg({ type: 'vehicle' });
      e.preventDefault(); break;
    case 'KeyV':
      if (S.me && S.me.vehicle) openSeatRadial();
      else placeMarker(false);
      e.preventDefault(); break;
    case 'KeyN': placeMarker(true); e.preventDefault(); break;
    case 'KeyM': toggleMap(); e.preventDefault(); break;
    case 'KeyB': openBuild(); e.preventDefault(); break;
    case 'KeyH': openArmory(); e.preventDefault(); break;
    case 'KeyC': openVehicles(); e.preventDefault(); break;
    case 'KeyZ': startMortar(); e.preventDefault(); break;
    case 'KeyP': openProfile(); e.preventDefault(); break;
    case 'KeyT': startBarrage(); e.preventDefault(); break;
    case 'Tab': toggleScoreboard(); e.preventDefault(); break;
    case 'Enter': case 'NumpadEnter': openRadio(); e.preventDefault(); break;
  }
}
function keyup(e) {
  const c = codeOf(e);
  if (c === 'KeyW' || c === 'ArrowUp') S.keys.w = false;
  else if (c === 'KeyS' || c === 'ArrowDown') S.keys.s = false;
  else if (c === 'KeyA' || c === 'ArrowLeft') S.keys.a = false;
  else if (c === 'KeyD' || c === 'ArrowRight') S.keys.d = false;
  else if (c === 'ShiftLeft' || c === 'ShiftRight') S.keys.shift = false;
  else if (c === 'KeyE') S.keys.e = false;
  else if (c === 'KeyF') S.keys.f = false;
}
function bindInput() {
  window.addEventListener('keydown', keydown);
  window.addEventListener('keyup', keyup);
  window.addEventListener('blur', () => { S.keys = {}; S.mouse.down = false; });
  window.addEventListener('mousemove', (e) => {
    S.mouse.x = e.clientX; S.mouse.y = e.clientY;
  });
  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    initAudio();
    if (S.mode !== 'hud' || !S.deployed) return;
    if (radioRestricted()) return;
    if (S.mortar) { fireMortarAtMouse(); return; }
    if (S.selectedBuild) { placeBuildAtMouse(); return; }
    if (S.artillery) { fireBarrageAtMouse(); return; }
    S.mouse.down = true;
    sendMsg({ type: 'shoot' });
  });
  window.addEventListener('mouseup', () => { S.mouse.down = false; });
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (S.selectedBuild) { S.selectedBuild = null; toast('Blueprint cancelled', 'amber'); }
    if (S.artillery) { S.artillery = false; toast('Artillery mission cancelled', 'amber'); }
    if (S.mortar) { S.mortar = false; toast('Mortar mission cancelled', 'amber'); }
    if (S.radial.open) closeRadial();
  });
  window.addEventListener('wheel', (e) => {
    if (S.mode !== 'hud' || !S.deployed) return;
    // handled in render (zoom)
    S.zoom = clamp((S.zoom || 1) - Math.sign(e.deltaY) * 0.08, 0.9, 1.8);
  }, { passive: true });
  S.zoom = 1.3;

  // touch controls
  const stick = $('stick'), nub = $('stickNub');
  if (stick) {
    const start = (e) => {
      e.preventDefault(); initAudio();
      S.touch.active = true; S.touch.id = e.pointerId;
      stick.setPointerCapture(e.pointerId);
      moveTouch(e);
    };
    const moveTouch = (e) => {
      if (!S.touch.active || e.pointerId !== S.touch.id) return;
      const r = stick.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let dx = (e.clientX - cx) / (r.width / 2), dy = (e.clientY - cy) / (r.height / 2);
      const m = Math.hypot(dx, dy); if (m > 1) { dx /= m; dy /= m; }
      S.touch.dx = dx; S.touch.dy = dy;
      nub.style.transform = `translate(${dx * r.width * 0.32}px, ${dy * r.height * 0.32}px)`;
    };
    const end = (e) => {
      S.touch.active = false; S.touch.dx = 0; S.touch.dy = 0; S.touch.id = null;
      nub.style.transform = '';
    };
    stick.addEventListener('pointerdown', start);
    stick.addEventListener('pointermove', moveTouch);
    stick.addEventListener('pointerup', end);
    stick.addEventListener('pointercancel', end);
  }
  const mFire = $('mFire');
  if (mFire) {
    mFire.addEventListener('pointerdown', (e) => { e.preventDefault(); initAudio(); S.touch.fire = true; sendMsg({ type: 'shoot' }); });
    mFire.addEventListener('pointerup', () => { S.touch.fire = false; });
    mFire.addEventListener('pointercancel', () => { S.touch.fire = false; });
  }
  const bindBtn = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  bindBtn('mReload', () => sendMsg({ type: 'reload' }));
  bindBtn('mGrenade', () => sendMsg({ type: 'grenade' }));
  const mInteract = $('mInteract');
  if (mInteract) {
    mInteract.addEventListener('pointerdown', (e) => { e.preventDefault(); S.touch.interact = true; sendMsg({ type: 'interact' }); });
    mInteract.addEventListener('pointerup', () => { S.touch.interact = false; });
    mInteract.addEventListener('pointercancel', () => { S.touch.interact = false; });
    mInteract.addEventListener('pointerleave', () => { S.touch.interact = false; });
  }
}

function inputVector() {
  let mx = 0, my = 0;
  if (S.keys.w || S.keys.arrowup) my--;
  if (S.keys.s || S.keys.arrowdown) my++;
  if (S.keys.a || S.keys.arrowleft) mx--;
  if (S.keys.d || S.keys.arrowright) mx++;
  if (S.touch.active) { mx += S.touch.dx; my += S.touch.dy; }
  const m = Math.hypot(mx, my);
  if (m > 1) { mx /= m; my /= m; }
  return { mx, my, active: m > 0.12, sprint: !!S.keys.shift };
}

function sendInput() {
  if (!S.ws || S.ws.readyState !== 1 || !S.me) return;
  const p = myPos();
  const aim = S.mouseWorld || { x: p.x, y: p.y };
  const locked = radioRestricted();
  sendMsg({
    type: 'input',
    input: {
      up: !!(S.keys.w || S.keys.arrowup || (S.touch.active && S.touch.dy < -0.25)),
      down: !!(S.keys.s || S.keys.arrowdown || (S.touch.active && S.touch.dy > 0.25)),
      left: !!(S.keys.a || S.keys.arrowleft || (S.touch.active && S.touch.dx < -0.25)),
      right: !!(S.keys.d || S.keys.arrowright || (S.touch.active && S.touch.dx > 0.25)),
      sprint: !!S.keys.shift && !locked,
      interact: (!!S.keys.e || !!S.touch.interact) && !locked,
      holdBuild: !!S.keys.f && !!nearBlueprint(),
      radio: locked,
      aimX: aim.x, aimY: aim.y,
      shoot: (S.mouse.down || S.touch.fire) && !locked,
    },
  });
  sendMsg({ type: 'aim_now' });
}

/* periodic input sender */
setInterval(() => {
  if (S.mode === 'hud' && S.deployed && S.me && !S.me.dead && !S.paused) sendInput();
}, 50);

/* ping */
setInterval(() => {
  if (S.ws && S.ws.readyState === 1) sendMsg({ type: 'ping', t: Date.now() });
}, 4000);

/* session */
loadSession();
bindInput();
connect();

/* auto login from stored session once init arrives */
window.addEventListener('load', () => {
  if (S.token && S.username) {
    authMsg('Restoring session…', true);
  }
});
