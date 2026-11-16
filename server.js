/* TRENCHES — authoritative WW1 campaign server */
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/*  Persistence                                                        */
/* ------------------------------------------------------------------ */
const DATA_FILE = path.join(__dirname, 'data.json');
let db = { users: {}, wars: 0 };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { /* fresh */ }
db.users = db.users || {};
let dirty = false;
function saveDb(force) {
  if (!force && !dirty) return;
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); dirty = false; } catch (e) { console.error(e); }
}
setInterval(() => saveDb(), 8000).unref?.();

const newStats = () => ({
  kills: 0, deaths: 0, assists: 0, buildings: 0, kmWalked: 0, kmDriven: 0,
  warsWon: 0, warsLost: 0, warsTotal: 0, itemsProduced: 0, captures: 0,
});

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */
const TILE = 32;
const COLS = 200;
const ROWS = 140;
const MAP_W = COLS * TILE;
const MAP_H = ROWS * TILE;

// Terrain
const T = { GRASS: 0, DIRT: 1, MUD: 2, WATER: 3, FOREST: 4, ROAD: 5, SAND: 6, CRATER: 7, BRIDGE: 8, ROCK: 9, WALL: 10, FLOOR: 11 };
const SOLID = new Set([T.WATER, T.ROCK, T.WALL]);
const INFANTRY_SOLID = new Set([T.ROCK, T.WALL]);

const WAR_MINUTES = Math.max(3, +(process.env.WAR_MINUTES || 20));
const WAR_DURATION = WAR_MINUTES * 60 * 1000;
// Spec is a 10-day campaign. Set WAR_MINUTES=14400 for the 10-day version,
// or WAR_DAYS=10 to use the exact specification.
const WAR_DAYS = +(process.env.WAR_DAYS || 0);
const WAR_LENGTH = WAR_DAYS > 0 ? WAR_DAYS * 24 * 60 * 60 * 1000 : WAR_DURATION;

// Balance / gameplay tuning
const BULLET_SPEED_MULT = 1.4;      // bots, turrets and vehicle MGs only
const MARKER_LIMIT = 3;             // regular markers per player
const MARKER_TTL = 10000;           // ms
const ORDER_TTL = 30000;            // ms (captain order tags)
const CARRY_CAP = 120;              // supplies a soldier can carry
const VEHICLE_CARGO_CAP = 300;      // supplies a vehicle can haul
const SCORE_PER_SECTOR = Math.max(0.05, +(process.env.SCORE_PER_SECTOR || 0.25));
const SCORE_LIMIT = Math.max(25, +(process.env.SCORE_LIMIT || 1000));
// Every sector opens neutral. Give both armies a short window to deploy
// before anyone can plant a flag.
const CAPTURE_GRACE = Math.max(0, +(process.env.CAPTURE_GRACE || 60)) * 1000;

const RANKS = [
  { name: 'Private', xp: 0, tag: 'PVT' },
  { name: 'Corporal', xp: 100, tag: 'CPL' },
  { name: 'Sergeant', xp: 250, tag: 'SGT' },
  { name: 'Staff Sergeant', xp: 500, tag: 'SSG' },
  { name: 'Sergeant Major', xp: 900, tag: 'SGM' },
  { name: 'Lieutenant', xp: 1500, tag: 'LT' },
  { name: 'Captain', xp: 2400, tag: 'CPT' },
  { name: 'Major', xp: 3600, tag: 'MAJ' },
  { name: 'Colonel', xp: 5200, tag: 'COL' },
  { name: 'General', xp: 7500, tag: 'GEN' },
];

const WEAPONS = {
  rifle:    { name: 'Bolt Rifle',    dmg: 46, rate: 0.85, speed: 1050, spread: 0.012, mag: 5,  reload: 2.3, range: 900, kind: 'rifle', ammoType: 'ammo', cost: { scrap: 0,  ammo: 0   }, minRank: 0 },
  smg:      { name: 'Trench SMG',    dmg: 17, rate: 0.11, speed: 850,  spread: 0.07,  mag: 30, reload: 2.0, range: 520, kind: 'smg',   ammoType: 'ammo', cost: { scrap: 60, ammo: 40  }, minRank: 1 },
  mg:       { name: 'Heavy MG',      dmg: 24, rate: 0.085,speed: 950,  spread: 0.045, mag: 60, reload: 4.2, range: 700, kind: 'mg',    ammoType: 'ammo', cost: { scrap: 120,ammo: 120 }, minRank: 3 },
  sniper:   { name: 'Marksman Rifle',dmg: 92, rate: 2.0,  speed: 1400, spread: 0.004, mag: 5,  reload: 3.0, range: 1200,kind: 'rifle', ammoType: 'ammo', cost: { scrap: 100,ammo: 60  }, minRank: 2 },
  pistol:   { name: 'Sidearm',       dmg: 24, rate: 0.35, speed: 750,  spread: 0.05,  mag: 8,  reload: 1.4, range: 400, kind: 'pistol',ammoType: 'ammo', cost: { scrap: 0,  ammo: 0   }, minRank: 0 },
};

const ARMOR = {
  none:        { name: 'No Armor',            reduction: 0.00, speed: 1.00, minRank: 0, cost: { scrap: 0 } },
  belt_helmet: { name: 'Belt + Helmet',        reduction: 0.15, speed: 1.00, minRank: 0, cost: { scrap: 0 } },
  vest_helmet: { name: 'Bulletproof Vest + Helmet', reduction: 0.38, speed: 0.92, minRank: 3, cost: { scrap: 90 } },
  vest_cap:    { name: 'Vest + Officer Cap',    reduction: 0.26, speed: 1.00, minRank: 5, cost: { scrap: 70 } },
};

const BUILDINGS = {
  trench:    { name: 'Trench Section', hp: 320, cost: { scrap: 40 }, minRank: 0, radius: 16, buildTime: 1.0, desc: 'Dug-in cover. 40% of incoming hits are absorbed.' },
  bridge:    { name: 'Field Bridge',   hp: 700, cost: { scrap: 140 }, minRank: 0, radius: 64, w: 8, h: 2, buildTime: 4.0, desc: 'Wooden span over water. Lets vehicles cross. Press R while placing to rotate.' },
  sandbag:   { name: 'Sandbag Line', hp: 250,  cost: { scrap: 60 },  minRank: 0, radius: 26, buildTime: 1.2, desc: 'Cheap cover. Blocks bullets.' },
  bunker:    { name: 'Bunker',       hp: 900,  cost: { scrap: 220 }, minRank: 1, radius: 34, buildTime: 3.5, desc: 'Heavy cover and forward spawn.' },
  turret:    { name: 'MG Nest',      hp: 400,  cost: { scrap: 180, ammo: 60 }, minRank: 2, radius: 22, buildTime: 3.0, desc: 'Auto-fires at enemies in range.' },
  factory:   { name: 'Factory',      hp: 1200, cost: { scrap: 400 }, minRank: 3, radius: 38, buildTime: 5.0, desc: 'Cuts equipment costs for your side.' },
  depot:     { name: 'Vehicle Depot',hp: 1200, cost: { scrap: 500 }, minRank: 4, radius: 38, buildTime: 4.5, desc: 'Forward vehicle spawn.' },
  radio:     { name: 'Radio Tower',  hp: 600,  cost: { scrap: 300 }, minRank: 2, radius: 26, buildTime: 2.5, desc: 'Reveals enemies on your minimap.' },
  armory:    { name: 'Armory',       hp: 1000, cost: { scrap: 350 }, minRank: 1, radius: 38, buildTime: 4.0, desc: 'Forward barracks. Access the Armory menu within its yard.' },
  mortar_crew:{ name: 'Mortar Crew', hp: 700,  cost: { scrap: 220, ammo: 80 }, minRank: 2, radius: 30, buildTime: 3.0, desc: 'Enables mortar strikes with Z. A second crew cuts the cooldown by 33%.' },
  hospital:  { name: 'Field Hospital',hp: 800, cost: { scrap: 380 }, minRank: 3, radius: 40, buildTime: 4.0, desc: 'Heals nearby soldiers to full over 10 seconds unless recently hit.' },
};

const VEHICLES = {
  // Base speeds reduced 30% across the board.
  truck:      { name: 'Supply Truck', hp: 450,  speed: 147, minRank: 2, cost: { scrap: 200, fuel: 80 },  armor: 0.15, gun: null, seats: 3 },
  apc:        { name: 'Armoured Carrier', hp: 900, speed: 119, minRank: 4, cost: { scrap: 380, fuel: 180, ammo: 80 }, armor: 0.60, gun: 'apc_mg', mag: 40, reload: 3.2, reserve: 160, seats: 4 },
  armored_car:{ name: 'Armored Car',  hp: 700,  speed: 126, minRank: 5, cost: { scrap: 320, fuel: 160 }, armor: 0.55, gun: 'mg', seats: 3 },
  tank:       { name: 'Landship',     hp: 1600, speed: 84, minRank: 7, cost: { scrap: 650, fuel: 320 }, armor: 0.75, gun: 'mg', seats: 3 },
};

const CAPTURE_RATE = 3.2 * 1.5; // % per second per net attacker (capture speed +50%)
const CAPTURE_RADIUS = 120;
const POP_REF = 24;
// Player-built structures persist for this many battles before a full sweep.
const STRUCTURE_RESET_EVERY = Math.max(1, +(process.env.STRUCTURE_RESET_EVERY || 3));

/* ------------------------------------------------------------------ */
/*  Map generation                                                     */
/* ------------------------------------------------------------------ */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const MAP_SEED = +(process.env.MAP_SEED || 1918);
const rng = mulberry32(MAP_SEED);
const terrain = new Uint8Array(COLS * ROWS).fill(T.GRASS);
const trenches = new Set();
const idx = (tx, ty) => ty * COLS + tx;
const inMap = (tx, ty) => tx >= 0 && ty >= 0 && tx < COLS && ty < ROWS;

function tset(tx, ty, v) { if (inMap(tx, ty)) terrain[idx(tx, ty)] = v; }
function tget(tx, ty) { return inMap(tx, ty) ? terrain[idx(tx, ty)] : T.WATER; }
function tileOf(x, y) { return { tx: Math.floor(x / TILE), ty: Math.floor(y / TILE) }; }

// Base texture: grass / mud bands
for (let ty = 0; ty < ROWS; ty++) {
  for (let tx = 0; tx < COLS; tx++) {
    const n = rng();
    if (n < 0.12) setT(tx, ty, T.DIRT);
    else if (n < 0.19) setT(tx, ty, T.MUD);
  }
}
function setT(tx, ty, v) { tset(tx, ty, v); }

// Central battlefield mud
for (let ty = 0; ty < ROWS; ty++) {
  for (let tx = 76; tx < 124; tx++) {
    if (rng() < 0.5) setT(tx, ty, rng() < 0.35 ? T.CRATER : T.MUD);
  }
}

// Central river. It meanders through the middle of the map with a strong
// double bend, and is 50% wider than the old channel. Roads laid afterwards
// cut natural crossings through it.
for (let ty = 0; ty < ROWS; ty++) {
  const rx = 88
    + Math.round(Math.sin(ty * 0.115) * 7)
    + Math.round(Math.sin(ty * 0.041 + 1.7) * 5)
    + Math.round(Math.sin(ty * 0.23 + 0.4) * 2);
  const width = 8;
  for (let w = 0; w < width; w++) setT(rx + w, ty, T.WATER);
}

// Pond west
for (let ty = 20; ty < 33; ty++) for (let tx = 16; tx < 33; tx++) {
  if (Math.hypot(tx - 24, (ty - 26) * 1.2) < 7.2) setT(tx, ty, T.WATER);
}

// Forests — vast, irregular woodland across the whole map (not just copses)
function forestBlob(cx, cy, rx, ry) {
  for (let ty = cy - ry; ty <= cy + ry; ty++) for (let tx = cx - rx; tx <= cx + rx; tx++) {
    if (!inMap(tx, ty)) continue;
    const base = tget(tx, ty);
    // Woodland only takes over open ground; it never swallows water or roads.
    if (base !== T.GRASS && base !== T.DIRT) continue;
    const nx = (tx - cx) / rx, ny = (ty - cy) / ry;
    const d = nx * nx + ny * ny;
    if (d >= 1) continue;
    // ragged, noisy rim rather than a clean circle
    if (rng() > 1.02 - d * 0.45) continue;
    setT(tx, ty, T.FOREST);
  }
}
forestBlob(42, 38, 40, 30);
forestBlob(150, 30, 44, 28);
forestBlob(26, 112, 32, 26);
forestBlob(120, 120, 50, 24);
forestBlob(186, 92, 20, 44);
forestBlob(96, 18, 34, 20);
forestBlob(70, 104, 26, 20);
forestBlob(168, 128, 26, 16);
forestBlob(12, 60, 16, 34);

// Rocks: individual boulders scattered as hard cover (never in clusters)
{
  let placed = 0, attempts = 0;
  while (placed < 170 && attempts < 6000) {
    attempts++;
    const tx = 6 + Math.floor(rng() * (COLS - 14));
    const ty = 6 + Math.floor(rng() * (ROWS - 14));
    const base = tget(tx, ty);
    if (base !== T.GRASS && base !== T.DIRT) continue;
    let nearRock = false;
    for (let dy = -1; dy <= 1 && !nearRock; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (tget(tx + dx, ty + dy) === T.ROCK) { nearRock = true; break; }
    }
    if (nearRock) continue;
    setT(tx, ty, T.ROCK);
    placed++;
  }
}

// Roads: main east-west + north-south links at each strongpoint
for (let tx = 2; tx < COLS - 2; tx++) {
  for (let w = 0; w < 3; w++) setT(tx, 68 + w, T.ROAD);
}
// Every sector starts unclaimed — each army holds only its own MOB.
const POINT_DEFS = [
  { id: 'west',   letter: 'A', name: 'HARLAN',     x: 1800, y: 2200, owner: 'neutral' },
  { id: 'somme',  letter: 'B', name: 'SOMME',      x: 2520, y: 1400, owner: 'neutral' },
  { id: 'cross',  letter: 'C', name: 'THE CROSS',  x: 3200, y: 2240, owner: 'neutral' },
  { id: 'marne',  letter: 'D', name: 'MARNE',      x: 3900, y: 2960, owner: 'neutral' },
  { id: 'east',   letter: 'E', name: 'VOSS',       x: 4660, y: 1800, owner: 'neutral' },
  { id: 'ridge',  letter: 'F', name: 'RIDGE',      x: 2300, y: 700,  owner: 'neutral' },
  { id: 'mill',   letter: 'G', name: 'MILL',       x: 4120, y: 760,  owner: 'neutral' },
  { id: 'works',  letter: 'H', name: 'WORKS',      x: 2320, y: 3800, owner: 'neutral' },
  { id: 'quarry', letter: 'I', name: 'QUARRY',     x: 4140, y: 3720, owner: 'neutral' },
];

/* Towns: real streets with enterable buildings. Each house has stone walls,
   plank floors, windows, a door that opens onto the street and a roof drawn
   by the client. */
const structures = [];
const doorSteps = new Set(); // tiles just outside a doorway, kept clear
function townGround(t) {
  return t === T.GRASS || t === T.DIRT || t === T.MUD || t === T.CRATER || t === T.FOREST || t === T.ROCK;
}
function makeStreet(tx, ty) {
  if (inMap(tx, ty)) setT(tx, ty, T.ROAD);
}
function canBuild(tx, ty, w, h) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (doorSteps.has((ty + y) * COLS + (tx + x))) return false;
    const t = tget(tx + x, ty + y);
    if (t === T.WATER || t === T.ROAD || t === T.SAND || t === T.BRIDGE || t === T.WALL || t === T.FLOOR) return false;
  }
  return true;
}
function makeBuilding(bx, by, w, h, complex) {
  if (!canBuild(bx, by, w, h)) return false;
  // Snapshot the ground so a rejected lot can be restored exactly.
  const saved = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    saved.push([bx + x, by + y, tget(bx + x, by + y)]);
  }
  // One-tile masonry shell around a walkable interior.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
    setT(bx + x, by + y, edge ? T.WALL : T.FLOOR);
  }
  // A doorway cut through one wall, facing open ground.
  const sides = ['s', 'n', 'e', 'w'];
  for (let i = sides.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [sides[i], sides[j]] = [sides[j], sides[i]];
  }
  let door = null;
  for (const side of sides) {
    const cand = [];
    if (side === 'n' || side === 's') {
      for (let x = 1; x < w - 1; x++) cand.push({ x: bx + x, y: side === 's' ? by + h - 1 : by });
    } else {
      for (let y = 1; y < h - 1; y++) cand.push({ x: side === 'e' ? bx + w - 1 : bx, y: by + y });
    }
    if (!cand.length) continue;
    const c = cand[Math.floor(cand.length / 2)];
    const ox = c.x + (side === 'e' ? 1 : side === 'w' ? -1 : 0);
    const oy = c.y + (side === 's' ? 1 : side === 'n' ? -1 : 0);
    const outside = tget(ox, oy);
    if (outside === T.WATER || outside === T.ROCK || outside === T.WALL || outside === T.FLOOR) continue;
    door = { x: c.x, y: c.y, side };
    break;
  }
  if (!door) {
    for (const [x, y, v] of saved) setT(x, y, v);
    return false;
  }
  setT(door.x, door.y, T.FLOOR);
  const stepX = door.x + (door.side === 'e' ? 1 : door.side === 'w' ? -1 : 0);
  const stepY = door.y + (door.side === 's' ? 1 : door.side === 'n' ? -1 : 0);
  doorSteps.add(stepY * COLS + stepX);
  // Big houses near the centre get interior partitions, so a squad has to
  // clear several rooms instead of one open hall.
  let rooms = 1;
  if (complex && w >= 7) {
    const px = bx + Math.max(2, Math.floor(w / 2));
    const gapA = by + 2 + Math.floor(rng() * Math.max(1, h - 4));
    for (let y = 1; y < h - 1; y++) {
      if (y === gapA) continue;
      if (tget(px, by + y) === T.FLOOR && !(px === door.x && by + y === door.y)) setT(px, by + y, T.WALL);
    }
    rooms++;
    if (h >= 8 && rng() < 0.7) {
      const py = by + Math.max(2, Math.floor(h / 2));
      const gapB = bx + 2 + Math.floor(rng() * Math.max(1, w - 4));
      for (let x = 1; x < w - 1; x++) {
        if (x === gapB) continue;
        if (tget(bx + x, py) === T.FLOOR && !(bx + x === door.x && py === door.y)) setT(bx + x, py, T.WALL);
      }
      rooms += 2;
    }
  }
  // Windows punched into the facades.
  const windows = [];
  const addWindows = (side) => {
    const horizontal = side === 'n' || side === 's';
    const len = (horizontal ? w : h) - 2;
    for (let i = 1; i < len; i += 2) {
      if (rng() < 0.22) continue;
      const x = horizontal ? bx + i : (side === 'e' ? bx + w - 1 : bx);
      const y = horizontal ? (side === 'n' ? by : by + h - 1) : by + i;
      if ((x === door.x && y === door.y) || windows.some(v => v.x === x && v.y === y)) continue;
      windows.push({ x, y, side });
    }
  };
  for (const s of ['n', 'e', 's', 'w']) addWindows(s);
  structures.push({
    id: structures.length + 1, x: bx, y: by, w, h,
    style: Math.floor(rng() * 3), door, windows, rooms,
    porch: { x: stepX, y: stepY, side: door.side },
    damaged: rng() < 0.28,
    chimney: rng() < 0.6,
    ridge: w >= h ? 'x' : 'y',
  });
  return true;
}
function makeTown(cx, cy, span, complex) {
  for (let d = -span; d <= span; d++) {
    for (let w = -1; w <= 1; w++) {
      if (townGround(tget(cx + d, cy + w)) || tget(cx + d, cy + w) === T.ROAD) makeStreet(cx + d, cy + w);
      if (townGround(tget(cx + w, cy + d)) || tget(cx + w, cy + d) === T.ROAD) makeStreet(cx + w, cy + d);
    }
  }
  // paved central plaza
  for (let oy = -3; oy <= 3; oy++) for (let ox = -3; ox <= 3; ox++) {
    if (inMap(cx + ox, cy + oy)) setT(cx + ox, cy + oy, T.SAND);
  }
  // Building lots. Interior towns get big multi-room houses; the map edges
  // keep small single-room cottages.
  const lots = [];
  const step = complex ? 9 : 7;
  for (let gy = -span + 1; gy <= span - 2; gy += step) {
    for (let gx = -span + 1; gx <= span - 2; gx += step) lots.push([gx, gy]);
  }
  for (let i = lots.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [lots[i], lots[j]] = [lots[j], lots[i]];
  }
  for (const [gx, gy] of lots) {
    if (rng() < 0.25) continue;
    const w = complex ? 7 + Math.floor(rng() * 3) : 6 + Math.floor(rng() * 2);
    const h = complex ? 7 + Math.floor(rng() * 3) : 6 + Math.floor(rng() * 2);
    makeBuilding(cx + gx, cy + gy, w, h, complex);
  }
}
for (const p of POINT_DEFS) {
  const ptx = Math.floor(p.x / TILE), pty = Math.floor(p.y / TILE);
  const nearCentre = Math.hypot(p.x - MAP_W / 2, p.y - MAP_H / 2) < 1900;
  makeTown(ptx, pty, p.id === 'cross' ? 13 : 10, nearCentre);
}
// A ruined city sprawls across the very centre of no man's land.
makeTown(88, 58, 9, true);
makeTown(112, 82, 9, true);
// Simple cottages near the outer edges.
makeTown(24, 40, 7, false);
makeTown(176, 100, 7, false);

// MOB pads
const RED_MOB = { x: 460, y: 2200 };
const BLUE_MOB = { x: MAP_W - 460, y: 2200 };
for (const mob of [RED_MOB, BLUE_MOB]) {
  const ptx = Math.floor(mob.x / TILE), pty = Math.floor(mob.y / TILE);
  for (let ty = pty - 9; ty <= pty + 9; ty++) for (let tx = ptx - 9; tx <= ptx + 9; tx++) {
    setT(tx, ty, T.SAND);
  }
}

/* Trees are individual world objects: they can be shot to pieces and
   gradually lose their canopy. */
const trees = [];
const treeGrid = new Map();
(function makeTrees() {
  let id = 1;
  for (let ty = 1; ty < ROWS - 1; ty++) {
    for (let tx = 1; tx < COLS - 1; tx++) {
      if (tget(tx, ty) !== T.FOREST) continue;
      if (((tx + ty) & 1) === 1) continue;
      if (rng() > 0.6) continue;
      const x = tx * TILE + 6 + rng() * (TILE - 12);
      const y = ty * TILE + 6 + rng() * (TILE - 12);
      const t = { id: id++, x: Math.round(x), y: Math.round(y), r: 24 + rng() * 20, hp: 100, maxHp: 100 };
      trees.push(t);
      const key = idx(tx, ty);
      if (!treeGrid.has(key)) treeGrid.set(key, []);
      treeGrid.get(key).push(t);
    }
  }
  // Scattered lone trees across the open field, with a denser stand at the centre.
  const addLoneTree = (tx, ty) => {
    const t = tget(tx, ty);
    if (t !== T.GRASS && t !== T.DIRT && t !== T.MUD && t !== T.CRATER) return false;
    const x = tx * TILE + 6 + rng() * (TILE - 12);
    const y = ty * TILE + 6 + rng() * (TILE - 12);
    const tree = { id: id++, x: Math.round(x), y: Math.round(y), r: 20 + rng() * 16, hp: 100, maxHp: 100 };
    trees.push(tree);
    const key = idx(tx, ty);
    if (!treeGrid.has(key)) treeGrid.set(key, []);
    treeGrid.get(key).push(tree);
    return true;
  };
  let extra = 0, tries = 0;
  while (extra < 180 && tries < 6000) {
    tries++;
    if (addLoneTree(4 + Math.floor(rng() * (COLS - 8)), 4 + Math.floor(rng() * (ROWS - 8)))) extra++;
  }
  let centre = 0; tries = 0;
  while (centre < 90 && tries < 4000) {
    tries++;
    if (addLoneTree(78 + Math.floor(rng() * 44), 50 + Math.floor(rng() * 40))) centre++;
  }
})();

/* Bushes are low, non-blocking undergrowth. Soldiers standing inside one are
   hard to see. They thicken the woods and dot the open ground. */
const bushes = [];
(function makeBushes() {
  let id = 1;
  for (let ty = 1; ty < ROWS - 1; ty++) {
    for (let tx = 1; tx < COLS - 1; tx++) {
      const t = tget(tx, ty);
      if (t === T.WATER || t === T.ROCK || t === T.ROAD || t === T.SAND || t === T.BRIDGE || t === T.WALL || t === T.FLOOR) continue;
      let nearForest = false;
      for (let dy = -1; dy <= 1 && !nearForest; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (tget(tx + dx, ty + dy) === T.FOREST) { nearForest = true; break; }
      }
      const chance = t === T.FOREST ? 0.22 : nearForest ? 0.06
        : (tx >= 78 && tx <= 122 && ty >= 50 && ty <= 92) ? 0.05 : 0.012;
      if (rng() > chance) continue;
      const x = tx * TILE + 6 + rng() * (TILE - 12);
      const y = ty * TILE + 6 + rng() * (TILE - 12);
      bushes.push({ id: id++, x: Math.round(x), y: Math.round(y), r: 12 + rng() * 10 });
    }
  }
})();
function treesNear(x, y) {
  const t = tileOf(x, y);
  const out = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const list = treeGrid.get(idx(t.tx + dx, t.ty + dy));
    if (list) out.push(...list);
  }
  return out;
}
/* Solid trunk check. Damaged or felled trees stop blocking once their hp is gone. */
function treeBlockAt(x, y, rad) {
  for (const t of treesNear(x, y)) {
    if (t.hp <= 0) continue;
    if (Math.hypot(t.x - x, t.y - y) < t.r * 0.34 + (rad || 0)) return t;
  }
  return null;
}
function resetTrees() { for (const t of trees) t.hp = t.maxHp; }

/* Boulders are drawn wider than their tile, so bullets must be tested against
   the visible rock rather than the raw tile the bullet centre lands in. */
const ROCK_RADIUS = 27;
function rockHitAt(x, y) {
  const t = tileOf(x, y);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const tx = t.tx + dx, ty = t.ty + dy;
    if (dx === 0 && dy === 0 && tget(tx, ty) === T.WALL) return true;
    if (tget(tx, ty) !== T.ROCK) continue;
    const cx = tx * TILE + TILE / 2, cy = ty * TILE + TILE / 2;
    if (Math.hypot(x - cx, y - cy) <= ROCK_RADIUS) return true;
  }
  return false;
}
function segmentHitsRock(x0, y0, x1, y1) {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(dist / 6));
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    if (rockHitAt(x0 + (x1 - x0) * k, y0 + (y1 - y0) * k)) return true;
  }
  return false;
}

function isTrenchAt(x, y) {
  const t = tileOf(x, y);
  return trenches.has(idx(t.tx, t.ty));
}
function terrainAt(x, y) {
  const t = tileOf(x, y);
  return tget(t.tx, t.ty);
}
function walkable(x, y, ignoreTrees) {
  if (x < 16 || y < 16 || x > MAP_W - 16 || y > MAP_H - 16) return false;
  if (INFANTRY_SOLID.has(terrainAt(x, y))) return false;
  if (!ignoreTrees && treeBlockAt(x, y, 5)) return false;
  return true;
}
/* Nudge a deployment point out of a wall, boulder or river. */
function safeSpot(x, y) {
  if (walkable(x, y)) return { x, y };
  for (let r = 24; r <= 300; r += 24) {
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + r * 0.11;
      const nx = x + Math.cos(a) * r, ny = y + Math.sin(a) * r;
      if (walkable(nx, ny)) return { x: nx, y: ny };
    }
  }
  return { x, y };
}

/* ------------------------------------------------------------------ */
/*  Bot navigation                                                     */
/*  A* over the tile grid keeps the AI out of walls, boulders and the   */
/*  new enterable houses. Paths are cached per bot and only rebuilt     */
/*  when the goal moves, the path goes stale or the bot gets wedged.    */
/* ------------------------------------------------------------------ */
const WALK_GRID = new Uint8Array(COLS * ROWS);
let walkGridBuilt = false;
function buildWalkGrid() {
  for (let i = 0; i < WALK_GRID.length; i++) {
    const t = terrain[i];
    WALK_GRID[i] = (t === T.ROCK || t === T.WALL) ? 0 : 1;
  }
  walkGridBuilt = true;
}
function walkTile(tx, ty) {
  if (!walkGridBuilt) buildWalkGrid();
  if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) return 0;
  return WALK_GRID[idx(tx, ty)];
}
function nearestWalkTile(tx, ty, maxR = 8) {
  if (walkTile(tx, ty)) return { tx, ty };
  for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      if (walkTile(tx + dx, ty + dy)) return { tx: tx + dx, ty: ty + dy };
    }
  }
  return null;
}

const PG = new Float32Array(COLS * ROWS);
const PF = new Float32Array(COLS * ROWS);
const PFROM = new Int32Array(COLS * ROWS);
const PSTAMP = new Uint32Array(COLS * ROWS);
const PCLOSED = new Uint32Array(COLS * ROWS);
let pathGen = 0;
const hNode = [], hFn = [];
function heapClear() { hNode.length = 0; hFn.length = 0; }
function heapPush(node, f) {
  let i = hNode.length;
  hNode.push(node); hFn.push(f);
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (hFn[p] <= hFn[i]) break;
    [hNode[p], hNode[i]] = [hNode[i], hNode[p]];
    [hFn[p], hFn[i]] = [hFn[i], hFn[p]];
    i = p;
  }
}
function heapPop() {
  const top = hNode[0];
  const lastN = hNode.pop(), lastF = hFn.pop();
  if (hNode.length) {
    hNode[0] = lastN; hFn[0] = lastF;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < hNode.length && hFn[l] < hFn[m]) m = l;
      if (r < hNode.length && hFn[r] < hFn[m]) m = r;
      if (m === i) break;
      [hNode[m], hNode[i]] = [hNode[i], hNode[m]];
      [hFn[m], hFn[i]] = [hFn[i], hFn[m]];
      i = m;
    }
  }
  return top;
}
function octile(ax, ay, bx, by) {
  const dx = Math.abs(ax - bx), dy = Math.abs(ay - by);
  return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy);
}
function findPath(sx, sy, gx, gy) {
  if (!walkGridBuilt) buildWalkGrid();
  const stx = Math.max(0, Math.min(COLS - 1, Math.floor(sx / TILE)));
  const sty = Math.max(0, Math.min(ROWS - 1, Math.floor(sy / TILE)));
  const gtx = Math.max(0, Math.min(COLS - 1, Math.floor(gx / TILE)));
  const gty = Math.max(0, Math.min(ROWS - 1, Math.floor(gy / TILE)));
  const goalT = nearestWalkTile(gtx, gty);
  if (!goalT) return null;
  const start = idx(stx, sty);
  const goal = idx(goalT.tx, goalT.ty);
  if (start === goal) return [];
  const gen = ++pathGen;
  PG[start] = 0; PF[start] = octile(stx, sty, goalT.tx, goalT.ty);
  PFROM[start] = -1; PSTAMP[start] = gen;
  heapClear(); heapPush(start, PF[start]);
  let expanded = 0;
  while (hNode.length && expanded < 9000) {
    const cur = heapPop();
    if (PCLOSED[cur] === gen) continue;
    if (cur === goal) {
      const tiles = [];
      let n = cur;
      while (n !== -1 && tiles.length < 1200) { tiles.push(n); n = PFROM[n]; }
      tiles.reverse();
      const path = [];
      for (let i = 1; i < tiles.length; i++) {
        const t = tiles[i];
        path.push({ x: (t % COLS) * TILE + TILE / 2, y: Math.floor(t / COLS) * TILE + TILE / 2 });
      }
      return path;
    }
    PCLOSED[cur] = gen;
    expanded++;
    const cx = cur % COLS, cy = (cur / COLS) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (!walkTile(nx, ny)) continue;
      // do not cut corners through a wall
      if (dx && dy && (!walkTile(cx + dx, cy) || !walkTile(cx, cy + dy))) continue;
      const ni = idx(nx, ny);
      if (PCLOSED[ni] === gen) continue;
      const ng = PG[cur] + ((dx && dy) ? Math.SQRT2 : 1);
      if (PSTAMP[ni] !== gen || ng < PG[ni]) {
        PSTAMP[ni] = gen; PG[ni] = ng; PFROM[ni] = cur;
        PF[ni] = ng + octile(nx, ny, goalT.tx, goalT.ty);
        heapPush(ni, PF[ni]);
      }
    }
  }
  return null;
}
function lineWalkable(x0, y0, x1, y1) {
  const d = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(d / 12));
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    if (!walkable(x0 + (x1 - x0) * k, y0 + (y1 - y0) * k, true)) return false;
  }
  return true;
}
function botCanStand(x, y) {
  return walkable(x, y, true) && walkable(x + 7, y, true) && walkable(x - 7, y, true) && walkable(x, y + 7, true) && walkable(x, y - 7, true);
}
const BOT_STEER = [0, 0.4, -0.4, 0.85, -0.85, 1.3, -1.3, 1.9, -1.9, 2.6, -2.6];
function botStep(b, ang, speed, dt) {
  const dist = speed * dt;
  for (const off of BOT_STEER) {
    const a = ang + off;
    const nx = b.x + Math.cos(a) * dist;
    const ny = b.y + Math.sin(a) * dist;
    if (botCanStand(nx, ny)) { b.x = nx; b.y = ny; return true; }
  }
  return false;
}
function botSetPath(b, gx, gy, now, ttl) {
  const gtx = Math.floor(gx / TILE), gty = Math.floor(gy / TILE);
  if (b.path && b.pathGoal && b.pathGoal.tx === gtx && b.pathGoal.ty === gty && now - (b.pathT || 0) < ttl) return false;
  b.path = findPath(b.x, b.y, gx, gy);
  b.pathI = 0;
  b.pathGoal = { tx: gtx, ty: gty };
  b.pathT = now;
  return true;
}
function botFollow(b, dt, speed) {
  if (!b.path || !b.path.length) return false;
  while (b.pathI < b.path.length && Math.hypot(b.path[b.pathI].x - b.x, b.path[b.pathI].y - b.y) < 22) b.pathI++;
  if (b.pathI >= b.path.length) { b.path = null; return false; }
  // skip ahead when the next waypoint is already in sight
  while (b.pathI + 1 < b.path.length) {
    const next = b.path[b.pathI + 1];
    if (lineWalkable(b.x, b.y, next.x, next.y)) b.pathI++;
    else break;
  }
  const wp = b.path[b.pathI];
  return botStep(b, Math.atan2(wp.y - b.y, wp.x - b.x), speed, dt);
}
function botStuckCheck(b, now) {
  if (now - (b.checkT || 0) < 1100) return false;
  b.checkT = now;
  const moved = Math.hypot(b.x - (b.checkX ?? b.x), b.y - (b.checkY ?? b.y));
  b.checkX = b.x; b.checkY = b.y;
  if (moved >= 7) return false;
  // wedged: drop the path and give the bot a small sideways nudge
  b.path = null; b.pathT = 0;
  for (let i = 0; i < 8; i++) {
    const a = Math.random() * Math.PI * 2;
    const nx = b.x + Math.cos(a) * 20, ny = b.y + Math.sin(a) * 20;
    if (botCanStand(nx, ny)) { b.x = nx; b.y = ny; break; }
  }
  return true;
}
function vehicleWalkable(x, y, ignoreTrees) {
  if (x < 24 || y < 24 || x > MAP_W - 24 || y > MAP_H - 24) return false;
  const t = terrainAt(x, y);
  if (t === T.WATER) return isBridgeAt(x, y); // vehicles ford only on bridges
  // Interior plank floors are inside houses: vehicles cannot drive in.
  if (t === T.FLOOR) return false;
  if (SOLID.has(t)) return false;
  if (!ignoreTrees && treeBlockAt(x, y, 15)) return false;
  return true;
}
function isWaterAt(x, y) { return terrainAt(x, y) === T.WATER; }
function isBridgeAt(x, y) {
  for (const b of buildings) {
    if (b.kind !== 'bridge' || b.hp <= 0) continue;
    const w = b.w || BUILDINGS.bridge.w, h = b.h || BUILDINGS.bridge.h;
    if (Math.abs(x - b.x) <= (w * TILE) / 2 && Math.abs(y - b.y) <= (h * TILE) / 2) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  Runtime world                                                      */
/* ------------------------------------------------------------------ */
function emptyTeam() { return { scrap: 400, fuel: 220, ammo: 300, points: [] }; }
function emptyCarry() { return { scrap: 0, fuel: 0, ammo: 0 }; }
function carryTotal(c) { return c ? (c.scrap || 0) + (c.fuel || 0) + (c.ammo || 0) : 0; }
function stockKey(type) { return type === 'fuel' ? 'fuel' : type === 'ammo' ? 'ammo' : 'scrap'; }
function stockCap(type) { return type === 'fuel' ? 2000 : 3000; }
function addTeamStock(side, type, amt) {
  const s = teamStock[side];
  if (!s || amt <= 0) return 0;
  const k = stockKey(type);
  const before = s[k] || 0;
  s[k] = Math.min(stockCap(type), before + amt);
  return s[k] - before;
}
/* Every sector and both MOBs hold their own supplies. teamStock stays as a
   cached sum so older UI and purchase code keep working. */
function emptyStock() { return { scrap: 0, fuel: 0, ammo: 0 }; }
function startMobStock() { return { scrap: 600, fuel: 350, ammo: 450 }; }
let mobStock = { red: startMobStock(), blue: startMobStock() };
function aggregateStock(side) {
  const sum = emptyStock();
  const add = (st) => { if (!st) return; sum.scrap += st.scrap || 0; sum.fuel += st.fuel || 0; sum.ammo += st.ammo || 0; };
  add(mobStock[side]);
  for (const cp of capturePoints) if (cp.owner === side) add(cp.stock);
  return sum;
}
function syncTeamStock(side) {
  const t = teamStock[side];
  if (!t) return;
  const a = aggregateStock(side);
  t.scrap = Math.min(3000, Math.round(a.scrap * 10) / 10);
  t.fuel = Math.min(2000, Math.round(a.fuel * 10) / 10);
  t.ammo = Math.min(3000, Math.round(a.ammo * 10) / 10);
}
function stockOfPoint(cp) { return cp ? cp.stock : null; }
function mobOfSide(side) { return side === 'red' ? RED_MOB : BLUE_MOB; }
function nearestAlliedPoint(p, range) {
  const r = range == null ? 180 : range;
  let best = null, bd = r;
  for (const cp of capturePoints) {
    if (cp.owner !== p.side) continue;
    const d = Math.hypot(cp.x - p.x, cp.y - p.y);
    if (d < bd) { bd = d; best = { kind: 'point', cp, stock: cp.stock, x: cp.x, y: cp.y, name: cp.name, d }; }
  }
  const mob = mobOfSide(p.side);
  const dm = Math.hypot(mob.x - p.x, mob.y - p.y);
  if (dm < bd) best = { kind: 'mob', stock: mobStock[p.side], x: mob.x, y: mob.y, name: 'MOB', d: dm };
  return best;
}
function addToStock(stock, k, amt, cap) {
  const key = stockKey(k);
  const before = stock[key] || 0;
  stock[key] = Math.min(cap == null ? stockCap(key) : cap, before + amt);
  return stock[key] - before;
}

let war = null;
let players = new Map(); // ws -> player
let bots = [];
let bullets = [];
let grenades = [];
let particles = []; // server-driven particles for state sync? no, events only
let vehicles = [];
let buildings = [];
let markers = [];
let resources = [];
let drops = [];
let blueprints = [];
let capturePoints = [];
let teamStock = { red: emptyTeam(), blue: emptyTeam() };
let nextId = 1;

const BOT_NAMES = ['Kowalski','Dubois','Miller','Volkov','Carter','Fischer','Moreau','Novak','Hayes','Bauer','Roux','Ivanov','Walker','Klein','Girard','Petrov','Bishop','Weiss','Laurent','Sokolov'];
const BARKS = ['Advance!', 'Hold the line!', 'Contact front!', 'Over the top!', 'Cover me!', 'Grenade!'];

function bcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of players.keys()) if (ws.readyState === 1) ws.send(data);
}
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function evt(kind, data) { bcast({ type: 'event', kind, ...data, t: Date.now() }); }
function warHighlight(text, side) {
  if (!war) return;
  war.highlights.push({ t: Date.now(), text, side: side || null });
  if (war.highlights.length > 40) war.highlights.shift();
}

function popMod() {
  const n = players.size;
  // fewer players -> faster capture, cheaper build, more AI support
  return Math.max(0.55, Math.min(1.65, 1.65 - n * 0.035));
}
function teamPlayers(side) {
  let n = 0;
  for (const p of players.values()) if (p.side === side) n++;
  return n;
}
function sideHasFactory(side) {
  return buildings.some(b => b.side === side && b.kind === 'factory' && b.hp > 0);
}

/* ------------------------------------------------------------------ */
/*  War lifecycle                                                      */
/* ------------------------------------------------------------------ */
function initWorld() {
  resources = [];
  capturePoints = POINT_DEFS.map(p => ({
    id: p.id, letter: p.letter, name: p.name, x: p.x, y: p.y, radius: CAPTURE_RADIUS,
    owner: p.owner, progress: p.owner === 'red' ? 100 : p.owner === 'blue' ? -100 : 0, contesting: null, spawn: p.owner !== 'neutral',
    stock: { scrap: 90 + Math.round(Math.random() * 50), fuel: 45 + Math.round(Math.random() * 30), ammo: 60 + Math.round(Math.random() * 40) },
  }));
  buildings = [];
  vehicles = [];
  bullets = [];
  grenades = [];
  markers = [];
  drops.length = 0;
  blueprints = [];
  trenches.clear();
  resetTrees();
  teamStock = { red: emptyTeam(), blue: emptyTeam() };
  mobStock = { red: startMobStock(), blue: startMobStock() };
  teamStock.red.points = capturePoints.filter(c => c.owner === 'red').map(c => c.id);
  teamStock.blue.points = capturePoints.filter(c => c.owner === 'blue').map(c => c.id);
  syncTeamStock('red'); syncTeamStock('blue');

  // Starting structures at MOBs
  for (const [side, mob] of [['red', RED_MOB], ['blue', BLUE_MOB]]) {
    buildings.push({ id: nextId++, kind: 'bunker', side, x: mob.x + (side === 'red' ? 70 : -70), y: mob.y - 60, hp: 900, maxHp: 900, angle: 0 });
    buildings.push({ id: nextId++, kind: 'turret', side, x: mob.x + (side === 'red' ? 90 : -90), y: mob.y + 80, hp: 400, maxHp: 400, angle: 0 });
    buildings.push({ id: nextId++, kind: 'factory', side, x: mob.x + (side === 'red' ? 120 : -120), y: mob.y + 190, hp: 1200, maxHp: 1200, angle: 0 });
    buildings.push({ id: nextId++, kind: 'armory', side, x: mob.x + (side === 'red' ? 150 : -150), y: mob.y - 130, hp: 1000, maxHp: 1000, angle: 0 });
    vehicles.push({ id: nextId++, kind: 'truck', side, x: mob.x + (side === 'red' ? 160 : -160), y: mob.y + 40, angle: 0, heading: 0, speed: 0, hp: 450, maxHp: 450, driver: null, crew: {}, cooldown: 0, cargo: emptyCarry() });
  }

  // Bot army
  bots = [];
  const names = [...BOT_NAMES];
  for (let i = 0; i < 20; i++) spawnBot(i < 10 ? 'red' : 'blue', names[i % names.length] + '_' + (1 + (i % 7)));
}

function spawnBot(side, name) {
  const mob = side === 'red' ? RED_MOB : BLUE_MOB;
  const spot = safeSpot(mob.x + (Math.random() - 0.5) * 120, mob.y + (Math.random() - 0.5) * 160);
  const b = {
    id: 'bot' + nextId++, name, side, x: spot.x, y: spot.y,
    angle: side === 'red' ? 0 : Math.PI, hp: 100, maxHp: 100, weapon: 'rifle', armor: 'belt_helmet',
    z: 0, cooldown: 0, reload: 0, ammo: 5, target: null, respawn: 0, dead: false,
    kills: 0, deaths: 0, assists: 0, recentHits: [], burst: 0,
    wander: Math.random() * 10, barkTimer: 6 + Math.random() * 10, xp: 0, isBot: true,
  };
  bots.push(b);
  return b;
}

function startWar() {
  db.wars = (db.wars || 0) + 1;
  dirty = true;
  // Player-built structures survive between battles and are swept away
  // every N battles (default 3, adjustable with STRUCTURE_RESET_EVERY).
  const carryStructures = db.wars % STRUCTURE_RESET_EVERY !== 0;
  const keptBuildings = carryStructures ? buildings.filter(b => b.by && b.hp > 0) : [];
  const keptTrenches = carryStructures ? Array.from(trenches) : [];
  war = {
    id: randomUUID(), start: Date.now(), duration: WAR_LENGTH, winner: null, ending: false,
    cause: null, score: { red: 0, blue: 0 }, battle: db.wars,
    timeline: [], highlights: [], lastMinute: 0,
    redMob: { x: RED_MOB.x, y: RED_MOB.y, hp: 3000, maxHp: 3000 },
    blueMob: { x: BLUE_MOB.x, y: BLUE_MOB.y, hp: 3000, maxHp: 3000 },
  };
  initWorld();
  if (carryStructures) {
    for (const b of keptBuildings) if (!buildings.some(x => x.id === b.id)) buildings.push(b);
    for (const t of keptTrenches) trenches.add(t);
  }
  for (const p of players.values()) {
    p.side = null; p.sideLocked = false; p.hp = 0; p.dead = true; p.vehicle = null;
    p.kills = 0; p.deaths = 0; p.carry = emptyCarry();
    p.x = MAP_W / 2; p.y = MAP_H / 2;
  }
  for (const u of Object.values(db.users)) { u.side = null; u.sideLocked = false; }
  saveDb(true);
  bcast({ type: 'new_war', war: warPublic() });
}

function warPublic() {
  const elapsed = Date.now() - war.start;
  let remaining = Math.max(0, war.duration - elapsed);
  if (war.duration <= 0) remaining = 0;
  return {
    id: war.id, remaining, duration: war.duration, winner: war.winner, cause: war.cause,
    score: { red: Math.floor(war.score.red), blue: Math.floor(war.score.blue) },
    scoreLimit: SCORE_LIMIT,
    redMob: { x: war.redMob.x, y: war.redMob.y, hp: war.redMob.hp, maxHp: war.redMob.maxHp, stock: { ...mobStock.red } },
    blueMob: { x: war.blueMob.x, y: war.blueMob.y, hp: war.blueMob.hp, maxHp: war.blueMob.maxHp, stock: { ...mobStock.blue } },
    redPoints: capturePoints.filter(c => c.owner === 'red').length,
    bluePoints: capturePoints.filter(c => c.owner === 'blue').length,
    popMod: popMod(),
    playerCount: players.size,
  };
}

function endWar(winner, cause) {
  if (war.ending) return;
  war.ending = true;
  war.winner = winner;
  war.cause = cause || 'time';
  for (const p of players.values()) {
    if (!p.username || !db.users[p.username]) continue;
    const u = db.users[p.username];
    u.stats.warsTotal++;
    if (p.side === winner) u.stats.warsWon++;
    else if (p.side) u.stats.warsLost++;
    u.stats.kills += 0; // already tracked live
    dirty = true;
  }
  for (const u of Object.values(db.users)) {
    if (u.side && u.stats) {
      // wars counted for connected players only; offline side data resets anyway
    }
    // Every campaign is a fresh enlistment: rank and experience reset.
    u.rank = 0;
    u.xp = 0;
  }
  for (const p of players.values()) {
    if (!p.registered) continue;
    p.rank = 0; p.xp = 0;
  }
  dirty = true;
  saveDb(true);
  const top = [...players.values(), ...bots]
    .filter(e => e.side)
    .sort((a, b) => (b.kills | 0) - (a.kills | 0))
    .slice(0, 6)
    .map(e => ({ name: e.name, side: e.side, kills: e.kills | 0, deaths: e.deaths | 0, bot: !!e.isBot }));
  const payload = {
    type: 'war_end', winner, cause: war.cause, score: warPublic().score, next: 25000,
    scoreLimit: SCORE_LIMIT,
    timeline: war.timeline.slice(), highlights: war.highlights.slice(-14), top,
    redPoints: capturePoints.filter(c => c.owner === 'red').length,
    bluePoints: capturePoints.filter(c => c.owner === 'blue').length,
    duration: Date.now() - war.start,
    your: null,
  };
  for (const p of players.values()) {
    const own = { ...payload, your: {
      kills: p.kills | 0, deaths: p.deaths | 0, captures: p.captures | 0,
      side: p.side, name: p.name,
    } };
    send(p.ws, own);
  }
  if (!players.size) bcast(payload);
  setTimeout(() => { startWar(); }, 25000);
}

/* ------------------------------------------------------------------ */
/*  Players                                                            */
/* ------------------------------------------------------------------ */
function makePlayer(ws) {
  return {
    id: nextId++, ws, name: 'Guest_' + Math.floor(1000 + Math.random() * 9000),
    registered: false, username: null, rank: -1, xp: 0,
    side: null, sideLocked: false,
    x: MAP_W / 2, y: MAP_H / 2, angle: 0, z: 0,
    hp: 0, maxHp: 100, dead: true, deathAt: 0,
    weapon: 'rifle', armor: 'belt_helmet', ammo: 5, grenades: 2,
    reloading: 0, cooldown: 0, exposed: 0, protect: 0,
    vehicle: null, freq: { high: 0, low: 0 }, knownFreqs: [],
    kills: 0, deaths: 0, assists: 0, captures: 0, gatherTimer: 0,
    carry: emptyCarry(), carryMax: CARRY_CAP, lastDeposit: 0, fullNotice: 0,
    recentHits: [],
    stats: newStats(), input: { up: false, down: false, left: false, right: false, sprint: false, aimX: 0, aimY: 0, shoot: false, interact: false },
    radioCaptured: false, lastBark: 0, spawnPoint: null,
  };
}

function sanitize(p) {
  return {
    id: p.id, name: p.name, registered: p.registered, username: p.username, side: p.side,
    sideLocked: !!p.sideLocked,
    rank: p.rank, xp: p.xp, x: p.x, y: p.y, angle: p.angle, z: p.z,
    hp: Math.max(0, Math.round(p.hp)), maxHp: p.maxHp, dead: p.dead,
    weapon: p.weapon, armor: p.armor, ammo: p.ammo, grenades: p.grenades,
    reloading: p.reloading > 0, exposed: p.exposed > Date.now(),
    carry: p.carry, carryMax: p.carryMax || CARRY_CAP,
    vehicle: p.vehicle ? p.vehicle.id : null, kills: p.kills, deaths: p.deaths, assists: p.assists | 0,
    freq: p.freq, stats: p.registered ? p.stats : undefined,
  };
}

function rankName(p) { return p.registered ? RANKS[p.rank].name : 'Guest Infantry'; }
function rankTag(p) { return p.registered ? RANKS[p.rank].tag : 'GST'; }

function addXp(p, amount) {
  if (!p.registered || p.rank >= 9) return;
  p.xp += amount;
  const u = db.users[p.username];
  if (u) { u.xp = p.xp; dirty = true; }
  while (p.rank < 9 && p.xp >= RANKS[p.rank + 1].xp) {
    p.rank++;
    if (u) { u.rank = p.rank; dirty = true; }
    send(p.ws, { type: 'toast', text: `PROMOTED — ${RANKS[p.rank].name}`, level: 'gold' });
    evt('rankup', { id: p.id, name: p.name, rank: p.rank, rankName: RANKS[p.rank].name });
  }
}

function giveKit(p, weapon, armor, free) {
  p.weapon = weapon; p.armor = armor;
  p.ammo = WEAPONS[weapon].mag;
  p.maxHp = armor === 'vest_helmet' ? 115 : 100;
  p.hp = Math.min(p.maxHp, p.hp || p.maxHp);
  if (!free) evt('toast', { to: p.id, text: `Equipped ${WEAPONS[weapon].name} / ${ARMOR[armor].name}` });
}
function giveKitOnSpawn(p) {
  p.weapon = 'rifle';
  p.armor = p.rank >= 5 ? 'vest_cap' : 'belt_helmet';
  p.ammo = WEAPONS.rifle.mag;
  p.maxHp = 100;
  p.grenades = 2;
  p.hp = p.maxHp;
}

function spawnPlayer(p, pointId) {
  const side = p.side;
  // A soldier may switch armies freely until their first deployment.
  if (side && !p.sideLocked) {
    p.sideLocked = true;
    if (p.registered && db.users[p.username]) {
      const u = db.users[p.username];
      u.side = side; u.sideLocked = true; dirty = true;
    }
  }
  let sx, sy;
  let contested = false;
  if (pointId && pointId !== 'mob') {
    const cp = capturePoints.find(c => c.id === pointId);
    if (cp && cp.owner === side) {
      sx = cp.x + (Math.random() - 0.5) * 60;
      sy = cp.y + (Math.random() - 0.5) * 60;
      // A sector under attack pushes reinforcements 15-25 metres out, with no
      // spawn shield, so defenders cannot simply materialise on the flag.
      let ex = 0, ey = 0, n = 0;
      for (const e of [...players.values(), ...bots]) {
        if (e.dead || e.side === side) continue;
        if (Math.hypot(e.x - cp.x, e.y - cp.y) > 850) continue;
        ex += e.x; ey += e.y; n++;
      }
      if (cp.contesting || n > 0) {
        contested = true;
        const away = n ? Math.atan2(cp.y - ey / n, cp.x - ex / n) : Math.random() * Math.PI * 2;
        const dist = 280 + Math.random() * 140;
        sx = cp.x + Math.cos(away) * dist;
        sy = cp.y + Math.sin(away) * dist;
      }
    }
  }
  if (sx == null) {
    const mob = side === 'red' ? RED_MOB : BLUE_MOB;
    const depot = buildings.find(b => b.side === side && b.kind === 'depot' && b.hp > 0);
    sx = (depot ? depot.x : mob.x) + (side === 'red' ? 40 : -40) + (Math.random() - 0.5) * 40;
    sy = (depot ? depot.y : mob.y) + (Math.random() - 0.5) * 90;
  }
  const spot = safeSpot(sx, sy);
  sx = spot.x; sy = spot.y;
  p.x = sx; p.y = sy; p.z = isTrenchAt(sx, sy) ? -1 : 0;
  p.hp = p.maxHp; p.dead = false;
  p.protect = contested ? 0 : Date.now() + 5000;
  p.reloading = 0; p.cooldown = 0; p.exposed = 0; p.recentHits = [];
  p.vehicle = null;
  giveKitOnSpawn(p);
  send(p.ws, { type: 'deployed', x: p.x, y: p.y });
}

function respawnPoint(p) {
  if (p.hp <= 0) {
    if (Date.now() - p.deathAt < 3000) return;
    spawnPlayer(p, p.spawnPoint || 'mob');
  }
}

function recordHit(target, attacker) {
  if (!attacker || attacker === target) return;
  const now = Date.now();
  target.recentHits = (target.recentHits || []).filter(h => now - h.t < 12000);
  target.recentHits.push({ id: attacker.id, t: now });
  if (target.recentHits.length > 8) target.recentHits.shift();
}

function awardAssists(victim, killer) {
  const now = Date.now();
  for (const h of victim.recentHits || []) {
    if (now - h.t > 12000) continue;
    if (killer && h.id === killer.id) continue;
    const a = findOwner(h.id);
    if (!a || a.dead || a.side === victim.side) continue;
    a.assists = (a.assists || 0) + 1;
    if (!a.isBot) {
      addXp(a, 12);
      if (a.registered && db.users[a.username]) { db.users[a.username].stats.assists = (db.users[a.username].stats.assists || 0) + 1; dirty = true; }
      send(a.ws, { type: 'toast', text: `ASSIST — ${victim.name}`, level: 'amber' });
    }
  }
  victim.recentHits = [];
}

function spawnDrop(x, y, stock, side) {
  if (!stock) return null;
  const scrap = Math.max(0, Math.round(stock.scrap || 0));
  const fuel = Math.max(0, Math.round(stock.fuel || 0));
  const ammo = Math.max(0, Math.round(stock.ammo || 0));
  if (scrap + fuel + ammo <= 0) return null;
  const drop = { id: nextId++, x: Math.round(x), y: Math.round(y), scrap, fuel, ammo, side: side || null, t: Date.now() };
  drops.push(drop);
  if (drops.length > 60) drops.shift();
  evt('drop_spawned', { id: drop.id, x: drop.x, y: drop.y, scrap, fuel, ammo, side: drop.side });
  return drop;
}
/* Walking (or driving) over a supply drop loads it automatically. */
function pickupDrops(p) {
  if (p.dead) return;
  const cap = p.vehicle ? VEHICLE_CARGO_CAP : (p.carryMax || CARRY_CAP);
  const target = p.vehicle ? (p.vehicle.cargo || (p.vehicle.cargo = emptyCarry())) : p.carry;
  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];
    if (Math.hypot(d.x - p.x, d.y - p.y) > (p.vehicle ? 42 : 30)) continue;
    let space = cap - carryTotal(target);
    if (space <= 0) break;
    let got = 0;
    for (const k of ['scrap', 'fuel', 'ammo']) {
      const take = Math.min(d[k] || 0, space, p.vehicle ? 300 : 120);
      if (take <= 0) continue;
      d[k] -= take; target[k] = (target[k] || 0) + take; space -= take; got += take;
    }
    if (got > 0) {
      send(p.ws, { type: 'gather', resource: 'supplies', amount: got, carry: carryTotal(target), cap });
      evt('drop_taken', { id: d.id, by: p.id, x: d.x, y: d.y });
    }
    if ((d.scrap || 0) + (d.fuel || 0) + (d.ammo || 0) <= 0) drops.splice(i, 1);
  }
}

function killPlayer(p, killer, weaponName) {
  if (p.dead) return;
  awardAssists(p, killer);
  p.dead = true; p.hp = 0; p.deathAt = Date.now();
  p.deaths++; p.kills = p.kills;
  if (p.vehicle) { p.vehicle.driver = null; p.vehicle = null; }
  // Fallen soldiers spill whatever they were hauling.
  spawnDrop(p.x, p.y, p.carry, p.side);
  p.carry = emptyCarry();
  if (p.registered && db.users[p.username]) { db.users[p.username].stats.deaths++; dirty = true; }
  // dropped intel: reveal victim radio frequency to killer
  if (killer && killer.ws && p.freq && (p.freq.high || p.freq.low)) {
    if (!killer.knownFreqs) killer.knownFreqs = [];
    const key = `${String(p.freq.high).padStart(3, '0')}-${String(p.freq.low).padStart(3, '0')}`;
    if (!killer.knownFreqs.includes(key)) {
      killer.knownFreqs.push(key);
      if (killer.knownFreqs.length > 8) killer.knownFreqs.shift();
    }
    send(killer.ws, { type: 'toast', text: `RADIO CAPTURED — enemy net ${key}`, level: 'amber' });
    send(killer.ws, { type: 'known_freq', freq: key });
  }
  evt('kill', { killer: killer ? killer.name : 'The Front', killerSide: killer ? killer.side : null, victim: p.name, victimSide: p.side, weapon: weaponName || 'rifle', x: p.x, y: p.y });
  if (killer && killer.ws) warHighlight(`${killer.name} eliminated ${p.name}`, killer.side);
  send(p.ws, { type: 'died', respawnIn: 3000 });
}

function killBot(b, killer, weaponName) {
  if (b.dead) return;
  awardAssists(b, killer);
  b.dead = true; b.hp = 0; b.respawn = Date.now() + 9000;
  b.deaths = (b.deaths || 0) + 1;
  if (killer) {
    if (killer.isBot) { killer.kills = (killer.kills || 0) + 1; }
    else {
      killer.kills++;
      addXp(killer, 25);
      if (killer.registered && db.users[killer.username]) { db.users[killer.username].stats.kills++; dirty = true; }
    }
  }
  evt('kill', { killer: killer ? killer.name : 'The Front', killerSide: killer ? killer.side : null, victim: b.name, victimSide: b.side, weapon: weaponName || 'rifle', x: b.x, y: b.y });
  // AI soldiers carry a small, randomized kit of supplies.
  spawnDrop(b.x, b.y, {
    scrap: 12 + Math.floor(Math.random() * 34),
    fuel: Math.floor(Math.random() * 16),
    ammo: 8 + Math.floor(Math.random() * 26),
  }, b.side);
  setTimeout(() => {
    if (!b.dead) return;
    const cp = capturePoints.find(c => c.owner === b.side && Math.hypot(c.x - b.x, c.y - b.y) < 900);
    const mob = b.side === 'red' ? RED_MOB : BLUE_MOB;
    const sp = cp || mob;
    const spot = safeSpot(sp.x + (Math.random() - 0.5) * 80, sp.y + (Math.random() - 0.5) * 80);
    b.x = spot.x; b.y = spot.y;
    b.hp = b.maxHp; b.dead = false; b.respawn = 0; b.z = isTrenchAt(b.x, b.y) ? -1 : 0; b.exposed = 0;
    b.path = null; b.pathT = 0;
  }, 9000);
}

/* ------------------------------------------------------------------ */
/*  Combat                                                             */
/* ------------------------------------------------------------------ */
function reloadWeapon(p, now) {
  const w = WEAPONS[p.weapon] || WEAPONS.rifle;
  if (p.reloading > now) return;
  p.reloading = now + w.reload * 1000;
  setTimeout(() => {
    if (!p.dead) { p.ammo = w.mag; p.reloading = 0; send(p.ws, { type: 'reloaded' }); }
  }, w.reload * 1000);
}

function fire(p, now) {
  if (p.dead || p.vehicle || p.reloading > now) return;
  const w = WEAPONS[p.weapon] || WEAPONS.rifle;
  if (now - p.cooldown < w.rate * 1000) return;
  if (p.ammo <= 0) { reloadWeapon(p, now); return; }
  p.ammo--;
  p.cooldown = now;
  p.protect = 0;
  const spread = (Math.random() - 0.5) * w.spread * 2;
  const ang = p.angle + spread;
  const inTrench = isTrenchAt(p.x, p.y);
  if (inTrench) p.exposed = now + 280;
  const z = inTrench ? 0 : p.z;
  const muzzle = 20;
  const bx = p.x + Math.cos(ang) * muzzle, by = p.y + Math.sin(ang) * muzzle;
  bullets.push({
    id: nextId++, owner: p.id, ownerName: p.name, side: p.side,
    x: bx, y: by, z, vx: Math.cos(ang) * w.speed, vy: Math.sin(ang) * w.speed,
    dmg: w.dmg, life: w.range / w.speed, kind: w.kind,
  });
  evt('shot', { x: bx, y: by, angle: ang, side: p.side, weapon: p.weapon, id: p.id });
}

function findOwner(id) {
  if (!id) return null;
  for (const q of players.values()) if (q.id === id) return q;
  for (const b of bots) if (b.id === id) return b;
  return null;
}

function damagePlayer(target, dmg, attacker, weaponName, ignoreArmor) {
  if (target.dead || target.protect > Date.now()) return;
  const inTrench = isTrenchAt(target.x, target.y);
  // Trench cover: only 40% of incoming fire actually connects.
  if (inTrench && !ignoreArmor && Math.random() > 0.40) {
    if (attacker && attacker.ws) send(attacker.ws, { type: 'hitmark', damage: 0, kill: false, covered: true });
    return;
  }
  recordHit(target, attacker);
  const armor = ARMOR[target.armor] || ARMOR.none;
  let final = dmg * (1 - (ignoreArmor ? 0 : armor.reduction));
  target.hp -= final;
  if (target.hp <= 0) {
    target.hp = 0;
    if (attacker) {
      if (attacker.isBot) { attacker.kills = (attacker.kills || 0) + 1; }
      else { attacker.kills++; addXp(attacker, 35); if (attacker.registered && db.users[attacker.username]) { db.users[attacker.username].stats.kills++; dirty = true; } }
    }
    killPlayer(target, attacker, weaponName);
    if (attacker && attacker.ws) send(attacker.ws, { type: 'hitmark', damage: Math.round(final), kill: true });
  } else if (attacker && attacker.ws) {
    send(attacker.ws, { type: 'hitmark', damage: Math.round(final), kill: false });
  }
  send(target.ws, { type: 'damaged', amount: Math.round(final), from: attacker ? attacker.name : null, hp: Math.round(target.hp) });
}

function damageBot(target, dmg, attacker, weaponName, ignoreArmor) {
  if (target.dead) return;
  if (isTrenchAt(target.x, target.y) && !ignoreArmor && Math.random() > 0.40) return;
  recordHit(target, attacker);
  const armor = ARMOR[target.armor] || ARMOR.none;
  let final = dmg * (1 - (ignoreArmor ? 0 : armor.reduction));
  target.hp -= final;
  if (target.hp <= 0) {
    target.hp = 0;
    killBot(target, attacker, weaponName);
  } else if (attacker && attacker.ws) {
    send(attacker.ws, { type: 'hitmark', damage: Math.round(final), kill: false });
  }
}

function damageVehicle(v, dmg, attacker, weaponName) {
  if (v.hp <= 0) return;
  const def = VEHICLES[v.kind] || VEHICLES.truck;
  v.hp -= dmg * (1 - def.armor);
  if (v.hp <= 0) {
    v.hp = 0;
    // Blown-up transports spill their hold onto the field.
    if (v.cargo && carryTotal(v.cargo) > 0) spawnDrop(v.x, v.y, v.cargo, v.side);
    explode(v.x, v.y, 100, 90, attacker, 'vehicle');
    if (v.driver) {
      const drv = [...players.values()].find(p => p.id === v.driver);
      if (drv) { damagePlayer(drv, 150, attacker, 'vehicle explosion', true); drv.vehicle = null; }
      v.driver = null;
    }
    if (attacker && attacker.ws) {
      addXp(attacker, 60);
      send(attacker.ws, { type: 'toast', text: `DESTROYED — ${def.name}`, level: 'amber' });
    }
    evt('vehicle_destroyed', { x: v.x, y: v.y, kind: v.kind, side: v.side });
    warHighlight(`${def.name} destroyed`, attacker ? attacker.side : null);
    setTimeout(() => { const i = vehicles.indexOf(v); if (i >= 0) vehicles.splice(i, 1); }, 100);
  }
}

/* Small secondary blast for APC rounds: hurts everyone hostile around the
   impact point without levelling buildings. */
function splashDamage(x, y, radius, dmg, side, attacker, source, skipId) {
  for (const p of players.values()) {
    if (p.dead || !p.side || p.side === side || p.id === skipId) continue;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < radius) damagePlayer(p, dmg * (1 - d / radius), attacker && !attacker.isBot ? attacker : null, source || 'splash', true);
  }
  for (const b of bots) {
    if (b.dead || b.side === side || b.id === skipId) continue;
    const d = Math.hypot(b.x - x, b.y - y);
    if (d < radius) damageBot(b, dmg * (1 - d / radius), attacker, source || 'splash', true);
  }
  for (const v of vehicles) {
    if (v.hp <= 0 || v.side === side || v.id === skipId) continue;
    const d = Math.hypot(v.x - x, v.y - y);
    if (d < radius + 14) damageVehicle(v, dmg * (1 - d / (radius + 14)) * 0.7, attacker, source || 'splash');
  }
}

function explode(x, y, radius, dmg, attacker, source) {
  evt('explosion', { x, y, radius, source: source || 'grenade' });
  for (const p of players.values()) {
    if (p.dead) continue;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < radius) {
      const falloff = 1 - d / radius;
      damagePlayer(p, dmg * falloff, attacker && !attacker.isBot ? attacker : null, source || 'explosion', true);
    }
  }
  for (const b of bots) {
    if (b.dead) continue;
    const d = Math.hypot(b.x - x, b.y - y);
    if (d < radius) {
      const falloff = 1 - d / radius;
      damageBot(b, dmg * falloff, attacker, source || 'explosion', true);
    }
  }
  for (const v of vehicles) {
    const d = Math.hypot(v.x - x, v.y - y);
    if (d < radius + 20) damageVehicle(v, dmg * (1 - d / (radius + 20)) * 0.8, attacker, source);
  }
  for (const b of buildings) {
    if (b.hp <= 0) continue;
    if (attacker && attacker.side === b.side) continue;
    const d = Math.hypot(b.x - x, b.y - y);
    if (d < radius + 20) b.hp -= dmg * (1 - d / (radius + 20)) * 0.6;
  }
  for (const t of trees) {
    if (t.hp <= 0) continue;
    const d = Math.hypot(t.x - x, t.y - y);
    if (d < radius * 0.85) {
      t.hp -= dmg * 0.55 * (1 - d / (radius * 0.85));
      evt('tree_hit', { id: t.id, hp: Math.max(0, Math.round(t.hp)), maxHp: t.maxHp });
    }
  }
  // foxholes crater the ground lightly? server terrain stays static; visual only.
}

function throwGrenade(p, now) {
  if (p.dead || p.grenades <= 0) return;
  if (now - (p.lastGrenade || 0) < 900) return;
  p.grenades--; p.lastGrenade = now;
  const ang = p.angle;
  grenades.push({
    id: nextId++, owner: p.id, side: p.side, x: p.x + Math.cos(ang) * 18, y: p.y + Math.sin(ang) * 18,
    vx: Math.cos(ang) * 300, vy: Math.sin(ang) * 300, fuse: 1.5, z: 0,
  });
}

function callBarrage(p, x, y) {
  if (!p.side || p.dead) return;
  if (!p.registered || p.rank < 6) { send(p.ws, { type: 'toast', text: 'Command rank required (Captain+)', level: 'red' }); return; }
  const stock = teamStock[p.side];
  if (!canAfford(p.side, { ammo: 120 })) { send(p.ws, { type: 'toast', text: 'Not enough ammunition (120)', level: 'red' }); return; }
  if (p.barrageCooldown && Date.now() < p.barrageCooldown) { send(p.ws, { type: 'toast', text: 'Artillery is reloading', level: 'red' }); return; }
  pay(p.side, { ammo: 120 });
  p.barrageCooldown = Date.now() + 45000;
  evt('barrage', { x, y, side: p.side, by: p.name });
  for (let i = 0; i < 9; i++) {
    setTimeout(() => {
      const ang = Math.random() * Math.PI * 2;
      const r = Math.random() * 190;
      explode(x + Math.cos(ang) * r, y + Math.sin(ang) * r, 110, 120, p, 'artillery');
    }, 2200 + i * 360);
  }
}

/* ------------------------------------------------------------------ */
/*  Economy / building / production                                    */
/* ------------------------------------------------------------------ */
function costMod(side) {
  let m = popMod();
  if (sideHasFactory(side)) m *= 0.78;
  return m;
}
function canAfford(side, cost) {
  const s = aggregateStock(side);
  return (!cost.scrap || s.scrap >= cost.scrap * costMod(side)) &&
         (!cost.fuel || s.fuel >= cost.fuel * costMod(side)) &&
         (!cost.ammo || s.ammo >= cost.ammo * costMod(side));
}
function pay(side, cost) {
  const mod = costMod(side);
  for (const k of ['scrap', 'fuel', 'ammo']) {
    if (!cost[k]) continue;
    let rem = Math.round(cost[k] * mod);
    // Sector and MOB stockpiles are separate: draw the MOB first, then the
    // nearest sectors in point order.
    const sources = [mobStock[side], ...capturePoints.filter(c => c.owner === side).map(c => c.stock)];
    for (const src of sources) {
      if (rem <= 0) break;
      if (!src) continue;
      const take = Math.min(src[k] || 0, rem);
      src[k] = (src[k] || 0) - take;
      rem -= take;
    }
  }
  syncTeamStock(side);
}

function equip(p, weapon, armor) {
  if (!p.registered) return send(p.ws, { type: 'toast', text: 'Register to unlock kits', level: 'red' });
  if (p.dead || !p.side) return;
  const w = WEAPONS[weapon]; if (!w) return;
  if (p.rank < w.minRank) return send(p.ws, { type: 'toast', text: `Rank required: ${RANKS[w.minRank].name}`, level: 'red' });
  const a = ARMOR[armor]; if (!a) return;
  if (p.rank < a.minRank) return send(p.ws, { type: 'toast', text: `Rank required: ${RANKS[a.minRank].name}`, level: 'red' });
  const cost = { scrap: (w.cost.scrap || 0) + (a.cost.scrap || 0), ammo: w.cost.ammo || 0 };
  // free if already at MOB and same kit? still charge production unless standard
  const standard = weapon === 'rifle' && (armor === 'belt_helmet' || armor === 'vest_cap');
  if (!standard) {
    if (!canAfford(p.side, cost)) return send(p.ws, { type: 'toast', text: 'Team stockpile insufficient', level: 'red' });
    pay(p.side, cost);
    if (db.users[p.username]) { db.users[p.username].stats.itemsProduced++; dirty = true; }
    p.stats.itemsProduced++;
  }
  giveKit(p, weapon, armor, standard);
  send(p.ws, { type: 'kit', weapon, armor, ammo: p.ammo });
}

/* Construction is no longer instant. A blueprint is paid for and placed,
   then a friendly soldier must hold position next to it while it is raised. */
function consumeForBlueprint(p, cost, x, y) {
  const mod = costMod(p.side);
  const need = {};
  for (const k of ['scrap', 'fuel', 'ammo']) if (cost[k]) need[k] = Math.round(cost[k] * mod);
  // Available: pockets + nearby dropped supplies + the nearest depot yard.
  const nearby = drops.filter(d => Math.hypot(d.x - x, d.y - y) < 220);
  const loc = nearestAlliedPoint({ ...p, x, y }, 260);
  const have = {};
  for (const k of ['scrap', 'fuel', 'ammo']) {
    have[k] = (p.carry[k] || 0)
      + (p.vehicle && p.vehicle.cargo ? (p.vehicle.cargo[k] || 0) : 0)
      + nearby.reduce((s, d) => s + (d[k] || 0), 0)
      + (loc && loc.stock ? (loc.stock[k] || 0) : 0);
  }
  for (const k of Object.keys(need)) {
    if (have[k] < need[k]) {
      send(p.ws, { type: 'toast', text: `Not enough ${k} within reach`, level: 'red' });
      return false;
    }
  }
  for (const k of Object.keys(need)) {
    let rem = need[k];
    const takeFrom = (src) => {
      if (rem <= 0 || !src) return;
      const take = Math.min(src[k] || 0, rem);
      src[k] = (src[k] || 0) - take; rem -= take;
    };
    takeFrom(p.carry);
    if (p.vehicle && p.vehicle.cargo) takeFrom(p.vehicle.cargo);
    for (const d of nearby) {
      if (rem <= 0) break;
      takeFrom(d);
      if ((d.scrap || 0) + (d.fuel || 0) + (d.ammo || 0) <= 0) {
        const di = drops.indexOf(d); if (di >= 0) drops.splice(di, 1);
      }
    }
    if (loc && loc.stock) takeFrom(loc.stock);
    if (rem > 0) {
      const sources = [mobStock[p.side], ...capturePoints.filter(c => c.owner === p.side).map(c => c.stock)];
      for (const src of sources) takeFrom(src);
    }
  }
  syncTeamStock(p.side);
  return true;
}

function build(p, kind, x, y, horizontal) {
  if (!p.registered) return send(p.ws, { type: 'toast', text: 'Register to build', level: 'red' });
  if (p.dead || !p.side) return;
  const def = BUILDINGS[kind]; if (!def) return;
  if (p.rank < def.minRank) return send(p.ws, { type: 'toast', text: `Rank required: ${RANKS[def.minRank].name}`, level: 'red' });
  // Construction range: two tiles around the soldier.
  if (Math.hypot(p.x - x, p.y - y) > 72) return send(p.ws, { type: 'toast', text: 'Too far away (2 tiles max)', level: 'red' });
  if (!walkable(x, y)) return send(p.ws, { type: 'toast', text: 'Cannot build here', level: 'red' });
  // One blueprint at a time per soldier keeps the field readable.
  if (blueprints.some(bp => bp.byId === p.id && bp.side === p.side)) return send(p.ws, { type: 'toast', text: 'You already have a blueprint in progress', level: 'red' });
  const buildTile = tileOf(x, y);
  const buildIdx = idx(buildTile.tx, buildTile.ty);
  const tt = tget(buildTile.tx, buildTile.ty);
  let w = 0, h = 0;
  if (kind === 'bridge') {
    if (tt !== T.WATER) return send(p.ws, { type: 'toast', text: 'Bridges must span water', level: 'red' });
    if (isBridgeAt(x, y)) return send(p.ws, { type: 'toast', text: 'A bridge already spans this water', level: 'red' });
    let hWater = 0, vWater = 0;
    for (let d = -4; d <= 4; d++) {
      if (tget(buildTile.tx + d, buildTile.ty) === T.WATER) hWater++;
      if (tget(buildTile.tx, buildTile.ty + d) === T.WATER) vWater++;
    }
    const orient = typeof horizontal === 'boolean' ? horizontal : (vWater >= hWater);
    w = orient ? def.w : def.h;
    h = orient ? def.h : def.w;
  } else if (kind === 'trench') {
    if (trenches.has(buildIdx)) return send(p.ws, { type: 'toast', text: 'A trench is already dug here', level: 'red' });
  } else {
    if (tt === T.WATER || tt === T.BRIDGE || tt === T.WALL || tt === T.FLOOR) return send(p.ws, { type: 'toast', text: 'Cannot build here', level: 'red' });
    if (buildings.some(b => b.hp > 0 && Math.hypot(b.x - x, b.y - y) < 60)) return send(p.ws, { type: 'toast', text: 'Too close to another structure', level: 'red' });
  }
  if (!consumeForBlueprint(p, def.cost, x, y)) return;
  const bp = {
    id: nextId++, kind, side: p.side, x, y, w, h, tx: buildTile.tx, ty: buildTile.ty,
    angle: p.angle, by: p.name, byId: p.id, progress: 0,
    duration: Math.max(1, def.buildTime || 2), hp: def.hp, maxHp: def.hp,
  };
  blueprints.push(bp);
  bcast({ type: 'blueprint', blueprint: bp });
  send(p.ws, { type: 'toast', text: `BLUEPRINT PLACED — HOLD F TO BUILD (${bp.duration.toFixed(1)}s)`, level: 'amber' });
  evt('blueprint', { x, y, kind, side: p.side, by: p.name });
}

function completeBlueprint(bp) {
  const def = BUILDINGS[bp.kind] || {};
  const builder = [...players.values()].find(q => q.id === bp.byId);
  if (bp.kind === 'trench') {
    trenches.add(idx(bp.tx, bp.ty));
    if (builder) {
      builder.stats.buildings++;
      if (db.users[builder.username]) { db.users[builder.username].stats.buildings++; dirty = true; }
      addXp(builder, constructionXp(bp.x, bp.y, bp.side));
    }
    evt('built', { x: bp.x, y: bp.y, kind: bp.kind, side: bp.side, by: bp.by });
    bcast({ type: 'trench_added', tx: bp.tx, ty: bp.ty, side: bp.side });
    return;
  }
  if (bp.kind === 'bridge') {
    const bridge = { id: bp.id, kind: 'bridge', side: bp.side, x: bp.x, y: bp.y, hp: bp.hp, maxHp: bp.maxHp, angle: 0, w: bp.w, h: bp.h, cooldown: 0, by: bp.by };
    buildings.push(bridge);
    if (builder) {
      builder.stats.buildings++;
      if (db.users[builder.username]) { db.users[builder.username].stats.buildings++; dirty = true; }
      addXp(builder, constructionXp(bp.x, bp.y, bp.side));
    }
    evt('built', { x: bp.x, y: bp.y, kind: bp.kind, side: bp.side, by: bp.by });
    bcast({ type: 'building_added', building: bridge });
    return;
  }
  const b = { id: bp.id, kind: bp.kind, side: bp.side, x: bp.x, y: bp.y, hp: bp.hp, maxHp: bp.maxHp, angle: bp.angle, cooldown: 0, by: bp.by };
  buildings.push(b);
  if (builder) {
    builder.stats.buildings++;
    if (db.users[builder.username]) { db.users[builder.username].stats.buildings++; dirty = true; }
    addXp(builder, constructionXp(bp.x, bp.y, bp.side));
  }
  evt('built', { x: bp.x, y: bp.y, kind: bp.kind, side: bp.side, by: bp.by });
  bcast({ type: 'building_added', building: b });
}
function updateBlueprints(dt) {
  for (let i = blueprints.length - 1; i >= 0; i--) {
    const bp = blueprints[i];
    let working = false;
    for (const p of players.values()) {
      if (p.dead || p.side !== bp.side || !p.input.holdBuild) continue;
      if (Math.hypot(p.x - bp.x, p.y - bp.y) < 100) { working = true; break; }
    }
    if (working) bp.progress += dt;
    else bp.progress = Math.max(0, bp.progress - dt * 0.35);
    if (bp.progress >= bp.duration) {
      blueprints.splice(i, 1);
      completeBlueprint(bp);
      bcast({ type: 'blueprint_done', id: bp.id });
    }
  }
}
/* Construction XP was cut by 25%, and frontline / freshly captured ground
   grants a 15% bonus. */
function constructionXp(x, y, side) {
  let xp = 15;
  const front = capturePoints.some(cp => {
    if (cp.owner !== side && cp.owner !== 'neutral') return true;
    if (cp.owner === side && Date.now() - (cp.capturedAt || 0) < 180000) return true;
    return false;
  });
  const nearFront = capturePoints.some(cp => Math.hypot(cp.x - x, cp.y - y) < 520 && cp.owner !== side);
  if (front || nearFront) xp *= 1.15;
  return Math.round(xp);
}

function requestVehicle(p, kind, x, y) {
  if (!p.registered) return send(p.ws, { type: 'toast', text: 'Register to use vehicles', level: 'red' });
  if (p.dead || !p.side) return;
  const def = VEHICLES[kind]; if (!def) return;
  if (p.rank < def.minRank) return send(p.ws, { type: 'toast', text: `Rank required: ${RANKS[def.minRank].name}`, level: 'red' });
  if (!canAfford(p.side, def.cost)) return send(p.ws, { type: 'toast', text: 'Team stockpile insufficient', level: 'red' });
  const near = buildings.some(b => b.side === p.side && (b.kind === 'depot' || b.kind === 'factory') && b.hp > 0 && Math.hypot(b.x - p.x, b.y - p.y) < 160)
    || Math.hypot(p.x - (p.side === 'red' ? RED_MOB.x : BLUE_MOB.x), p.y - (p.side === 'red' ? RED_MOB.y : BLUE_MOB.y)) < 260;
  if (!near) return send(p.ws, { type: 'toast', text: 'Return to MOB or a depot', level: 'red' });
  pay(p.side, def.cost);
  const v = { id: nextId++, kind, side: p.side, x, y, angle: p.angle, heading: p.angle, speed: 0, hp: def.hp, maxHp: def.hp, driver: null, crew: {},
    cooldown: 0, cargo: emptyCarry(), ammo: def.reserve || 0, magAmmo: def.mag || 0, reloadingUntil: 0 };
  vehicles.push(v);
  p.stats.itemsProduced++;
  if (db.users[p.username]) { db.users[p.username].stats.itemsProduced++; dirty = true; }
  evt('vehicle_spawned', { x, y, kind, side: p.side });
  bcast({ type: 'vehicle_added', vehicle: v });
}

function vehicleSeatCount(v) { return (VEHICLES[v.kind] || VEHICLES.truck).seats || 3; }
function vehicleSeatOccupied(v, seat) {
  if (seat === 0 && v.driver) return true;
  return Object.values(v.crew || {}).includes(seat);
}
function enterVehicle(p) {
  if (p.dead || !p.side) return;
  if (p.vehicle) {
    const v = p.vehicle;
    if (v.driver === p.id) v.driver = null;
    if (v.crew) for (const id of Object.keys(v.crew)) if (+id === p.id) delete v.crew[id];
    p.x = v.x + 30; p.y = v.y + 20;
    p.vehicle = null; p.seat = null;
    send(p.ws, { type: 'vehicle', vehicle: null }); return;
  }
  let best = null, bd = 120;
  for (const v of vehicles) {
    if (v.side !== p.side || v.hp <= 0) continue;
    const d = Math.hypot(v.x - p.x, v.y - p.y);
    if (d < bd) { bd = d; best = v; }
  }
  if (!best) return send(p.ws, { type: 'toast', text: 'No vehicle nearby', level: 'red' });
  const seats = vehicleSeatCount(best);
  let seat = -1;
  for (let s = 0; s < seats; s++) if (!vehicleSeatOccupied(best, s)) { seat = s; break; }
  if (seat < 0) return send(p.ws, { type: 'toast', text: 'Vehicle is full', level: 'red' });
  if (!best.crew) best.crew = {};
  if (seat === 0) best.driver = p.id; else best.crew[p.id] = seat;
  p.vehicle = best;
  p.seat = seat;
  p.x = best.x; p.y = best.y;
  send(p.ws, { type: 'vehicle', vehicle: { id: best.id, kind: best.kind, seat, seats } });
  bcast({ type: 'vehicle_crew', id: best.id, crew: vehicleCrewInfo(best) });
}
function vehicleCrewInfo(v) {
  const seats = vehicleSeatCount(v);
  const info = [];
  for (let s = 0; s < seats; s++) {
    let who = null;
    if (s === 0 && v.driver) { const p = [...players.values()].find(q => q.id === v.driver); if (p) who = p.name; }
    for (const [id, seat] of Object.entries(v.crew || {})) if (seat === s) { const p = [...players.values()].find(q => q.id === +id); if (p) who = p.name; }
    info.push({ seat: s, name: who, driver: s === 0 });
  }
  return info;
}
function switchSeat(p, seat) {
  const v = p.vehicle;
  if (!v || p.dead) return;
  const seats = vehicleSeatCount(v);
  seat = Math.max(0, Math.min(seats - 1, seat | 0));
  if (vehicleSeatOccupied(v, seat)) return send(p.ws, { type: 'toast', text: 'Seat occupied', level: 'amber' });
  if (v.driver === p.id) v.driver = null;
  if (v.crew) for (const id of Object.keys(v.crew)) if (+id === p.id) delete v.crew[id];
  if (seat === 0) v.driver = p.id; else { if (!v.crew) v.crew = {}; v.crew[p.id] = seat; }
  p.seat = seat;
  send(p.ws, { type: 'vehicle', vehicle: { id: v.id, kind: v.kind, seat, seats } });
  bcast({ type: 'vehicle_crew', id: v.id, crew: vehicleCrewInfo(v) });
}

function nearbyResource(p) {
  let best = null, bd = 52;
  for (const r of resources) {
    if (r.amount <= 0) continue;
    const d = Math.hypot(r.x - p.x, r.y - p.y);
    if (d < bd) { bd = d; best = r; }
  }
  return best;
}
function nearbySuppliesVehicle(p) {
  let best = null, bd = 92;
  for (const v of vehicles) {
    if (v.side !== p.side || v.hp <= 0 || v.driver) continue;
    const d = Math.hypot(v.x - p.x, v.y - p.y);
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}
function transferSupplies(p) {
  const v = nearbySuppliesVehicle(p);
  if (!v) return false;
  if (!v.cargo) v.cargo = emptyCarry();
  let moved = 0;
  const space = VEHICLE_CARGO_CAP - carryTotal(v.cargo);
  for (const k of ['scrap', 'fuel', 'ammo']) {
    const take = Math.min(p.carry[k] || 0, Math.max(0, space - moved));
    if (take <= 0) continue;
    p.carry[k] -= take; v.cargo[k] = (v.cargo[k] || 0) + take; moved += take;
  }
  if (moved > 0) {
    send(p.ws, { type: 'toast', text: `LOADED ${moved} SUPPLIES`, level: 'amber' });
    return true;
  }
  const room = (p.carryMax || CARRY_CAP) - carryTotal(p.carry);
  for (const k of ['scrap', 'fuel', 'ammo']) {
    const take = Math.min(v.cargo[k] || 0, Math.max(0, room - moved));
    if (take <= 0) continue;
    v.cargo[k] -= take; p.carry[k] = (p.carry[k] || 0) + take; moved += take;
  }
  if (moved > 0) send(p.ws, { type: 'toast', text: `UNLOADED ${moved} SUPPLIES`, level: 'amber' });
  else send(p.ws, { type: 'toast', text: 'No supplies to transfer', level: 'amber' });
  return moved > 0;
}
function depositAtPoint(p, force, pointsOnly) {
  if (p.dead || !p.side) return false;
  const loc = nearestAlliedPoint(p, 170);
  if (!loc) return false;
  if (pointsOnly && loc.kind === 'mob') return false;
  const totals = emptyCarry();
  const deposit = (carry) => {
    if (!carry) return;
    for (const k of ['scrap', 'fuel', 'ammo']) {
      const amt = carry[k] || 0;
      if (amt <= 0) continue;
      const stored = addToStock(loc.stock, k, amt);
      carry[k] = Math.max(0, amt - stored);
      totals[k] += stored;
    }
  };
  if (p.vehicle && p.vehicle.cargo) deposit(p.vehicle.cargo);
  deposit(p.carry);
  const total = carryTotal(totals);
  if (total <= 0) return false;
  syncTeamStock(p.side);
  if (!force && Date.now() - (p.lastDeposit || 0) < 1500) return true;
  p.lastDeposit = Date.now();
  send(p.ws, { type: 'deposit', scrap: totals.scrap, fuel: totals.fuel, ammo: totals.ammo, total, point: loc.kind === 'mob' ? 'MOB' : loc.name });
  return true;
}
/* Draw supplies from the MOB into the soldier's hands or a vehicle hold.
   Enlisted ranks only — guests cannot pull from the depot. */
function withdrawAtMob(p) {
  if (p.dead || !p.side) return false;
  if (!p.registered) {
    send(p.ws, { type: 'toast', text: 'Register to draw MOB supplies', level: 'red' });
    return true;
  }
  const mob = mobOfSide(p.side);
  if (Math.hypot(mob.x - p.x, mob.y - p.y) > 240) return false;
  const stock = mobStock[p.side];
  const target = p.vehicle ? (p.vehicle.cargo || (p.vehicle.cargo = emptyCarry())) : p.carry;
  const cap = p.vehicle ? VEHICLE_CARGO_CAP : (p.carryMax || CARRY_CAP);
  const space = cap - carryTotal(target);
  if (space <= 0) {
    send(p.ws, { type: 'toast', text: p.vehicle ? 'Vehicle hold full' : 'Carry full', level: 'amber' });
    return true;
  }
  let moved = 0;
  const got = emptyCarry();
  for (const k of ['scrap', 'fuel', 'ammo']) {
    const take = Math.min(stock[k] || 0, space - moved, 80);
    if (take <= 0) continue;
    stock[k] -= take; target[k] = (target[k] || 0) + take;
    got[k] += take; moved += take;
  }
  syncTeamStock(p.side);
  if (moved <= 0) {
    send(p.ws, { type: 'toast', text: 'MOB stockpile is empty', level: 'red' });
    return true;
  }
  send(p.ws, { type: 'withdraw', scrap: got.scrap, fuel: got.fuel, ammo: got.ammo, total: moved });
  return true;
}
function replenishVehicleAmmo(p) {
  const v = p.vehicle;
  if (!v) return false;
  const def = VEHICLES[v.kind];
  if (!def || !def.mag) return false;
  const loc = nearestAlliedPoint(p, 190);
  if (!loc) return false;
  const maxRes = def.reserve || 160;
  const need = maxRes - (v.ammo || 0);
  if (need <= 0) {
    send(p.ws, { type: 'toast', text: 'Vehicle ammunition full', level: 'amber' });
    return true;
  }
  const take = Math.min(need, Math.floor(loc.stock.ammo || 0), 80);
  if (take <= 0) {
    send(p.ws, { type: 'toast', text: 'No ammunition at this depot', level: 'red' });
    return true;
  }
  loc.stock.ammo -= take;
  v.ammo = (v.ammo || 0) + take;
  syncTeamStock(p.side);
  send(p.ws, { type: 'toast', text: `VEHICLE REARMED — +${take} AMMO`, level: 'amber' });
  return true;
}
function interact(p) {
  if (p.dead || !p.side) return;
  const carried = carryTotal(p.carry) + (p.vehicle ? carryTotal(p.vehicle.cargo) : 0);
  const loc = nearestAlliedPoint(p, 190);
  if (loc) {
    // Carrying anything? Deposit it here. Empty-handed at the MOB? Draw fresh supplies.
    if (carried > 0 && depositAtPoint(p, true)) return;
    if (p.vehicle && replenishVehicleAmmo(p)) return;
    if (loc.kind === 'mob') { withdrawAtMob(p); return; }
    if (carried <= 0) {
      const s = loc.stock || emptyStock();
      send(p.ws, { type: 'toast', text: `${loc.name}: ${Math.floor(s.scrap)} scrap / ${Math.floor(s.fuel)} fuel / ${Math.floor(s.ammo)} ammo`, level: 'amber' });
      return;
    }
  }
  if (p.vehicle) { enterVehicle(p); return; }
  // Near a friendly empty vehicle: move supplies between soldier and cargo,
  // or fall through to boarding when there is nothing to transfer.
  if (nearbySuppliesVehicle(p) && transferSupplies(p)) return;
  if (vehicles.some(v => v.side === p.side && v.hp > 0 && !v.driver && Math.hypot(v.x - p.x, v.y - p.y) < 120)) enterVehicle(p);
}

/* ------------------------------------------------------------------ */
/*  Capture / AI                                                       */
/* ------------------------------------------------------------------ */
function presenceAt(cp) {
  const out = { red: 0, blue: 0, redPlayers: 0, bluePlayers: 0 };
  for (const p of players.values()) {
    if (p.dead || !p.side) continue;
    if (Math.hypot(p.x - cp.x, p.y - cp.y) < cp.radius) {
      out[p.side] += 1.8; out[p.side + 'Players']++;
    }
  }
  for (const b of bots) {
    if (b.dead) continue;
    if (Math.hypot(b.x - cp.x, b.y - cp.y) < cp.radius) out[b.side] += 0.5;
  }
  return out;
}

function baselineProgress(owner) { return owner === 'red' ? 100 : owner === 'blue' ? -100 : 0; }
function syncPointLists() {
  teamStock.red.points = capturePoints.filter(c => c.owner === 'red').map(c => c.id);
  teamStock.blue.points = capturePoints.filter(c => c.owner === 'blue').map(c => c.id);
  syncTeamStock('red'); syncTeamStock('blue');
}
function neutralizePoint(cp) {
  const old = cp.owner;
  cp.owner = 'neutral';
  syncPointLists();
  evt('capture', { id: cp.id, name: cp.name, side: 'neutral', old });
  warHighlight(`${cp.name} has been neutralised`, null);
}

function updateCapture(dt) {
  if (Date.now() - war.start < CAPTURE_GRACE) return; // deployment window: sectors stay neutral
  const pm = popMod();
  for (const cp of capturePoints) {
    const pr = presenceAt(cp);
    cp.contesting = (pr.red > 0 && pr.blue > 0) ? 'both' : pr.red > 0 ? 'red' : pr.blue > 0 ? 'blue' : null;
    // Capture pressure is allies minus enemies. A single enemy no longer
    // freezes the flag: numbers simply cancel out, and a larger force wins.
    const net = pr.red - pr.blue;
    if (Math.abs(net) < 0.01) {
      // Nobody pushing: an interrupted capture falls back immediately.
      cp.progress = baselineProgress(cp.owner);
      continue;
    }
    const dir = net > 0 ? 1 : -1;
    const rate = Math.abs(net) * CAPTURE_RATE * pm;
    cp.progress = Math.max(-100, Math.min(100, (cp.progress || 0) + dir * rate * dt));
    // An enemy-held sector must pass through neutral before it turns.
    if (cp.owner === 'red' && cp.progress < 0) neutralizePoint(cp);
    else if (cp.owner === 'blue' && cp.progress > 0) neutralizePoint(cp);
    if (cp.progress >= 100) capturePoint(cp, 'red');
    else if (cp.progress <= -100) capturePoint(cp, 'blue');
  }
}

function capturePoint(cp, side) {
  const old = cp.owner;
  if (old === side) return;
  cp.owner = side;
  cp.progress = baselineProgress(side);
  cp.capturedAt = Date.now();
  syncPointLists();
  evt('capture', { id: cp.id, name: cp.name, side, old });
  warHighlight(`${cp.name} fell to the ${side.toUpperCase()} line`, side);
  for (const p of players.values()) {
    if (p.side === side && !p.dead && Math.hypot(p.x - cp.x, p.y - cp.y) < cp.radius + 80) {
      p.captures++; addXp(p, 50);
      if (db.users[p.username]) { db.users[p.username].stats.captures++; dirty = true; }
    }
  }
}

const TARGET_NAMES = new Set();
function updateBots(dt, now) {
  for (const b of bots) {
    if (b.dead) continue;
    b._wantMove = false;
    if (!b.objective || now > (b.nextThink || 0)) {
      b.nextThink = now + 800 + Math.random() * 900;
      // Captains' order tags override the default plan most of the time.
      let order = null;
      for (const m of markers) {
        if (m.kind !== 'order' || m.side !== b.side) continue;
        if (now - (m.t || 0) > ORDER_TTL) continue;
        order = m;
      }
      if (order && Math.random() < 0.72) {
        b.objective = { x: order.x, y: order.y, radius: 90, ordered: true };
      } else {
        // Attack the nearest hostile sector; fall back to the enemy MOB.
        let best = null, bd = 1e9;
        for (const cp of capturePoints) {
          if (cp.owner === b.side) continue;
          const d = Math.hypot(cp.x - b.x, cp.y - b.y);
          if (d < bd) { bd = d; best = cp; }
        }
        if (!best || (bd > 1800 && Math.random() < 0.5)) {
          const enemyMob = b.side === 'red' ? war.blueMob : war.redMob;
          best = { x: enemyMob.x, y: enemyMob.y, radius: 100 };
        }
        b.objective = best;
      }
    }
    // find target
    let target = null, td = 1e9;
    for (const p of players.values()) {
      if (p.dead || p.side === b.side || !p.side) continue;
      const d = Math.hypot(p.x - b.x, p.y - b.y);
      if (d < 700 && d < td) { td = d; target = p; }
    }
    for (const o of bots) {
      if (o === b || o.dead || o.side === b.side) continue;
      const d = Math.hypot(o.x - b.x, o.y - b.y);
      if (d < 600 && d < td) { td = d; target = o; }
    }
    if (target) {
      b.target = target;
      const ang = Math.atan2(target.y - b.y, target.x - b.x);
      b.angle = ang;
      b.cooldown = Math.max(0, (b.cooldown || 0) - dt * 1000);
      // Without a clear line of fire the bot must push around the cover
      // instead of standing still and shooting into a wall or boulder.
      const los = lineWalkable(b.x, b.y, target.x, target.y);
      if (td > 240 || !los) {
        b._wantMove = true;
        if (los) {
          b.path = null;
          botStep(b, ang, 78, dt);
        } else {
          botSetPath(b, target.x, target.y, now, 1200);
          if (!botFollow(b, dt, 78)) botStep(b, ang, 78, dt);
        }
      }
      if (los && td < 700 && b.cooldown <= 0 && now - (b.lastShot || 0) > 650 + Math.random() * 450) {
        b.lastShot = now;
        b.burst = (b.burst || 0) + 1;
        if (b.burst >= 4) { b.burst = 0; b.cooldown = 1400 + Math.random() * 1600; }
        const spread = (Math.random() - 0.5) * 0.11;
        const a = ang + spread;
        const inTrench = isTrenchAt(b.x, b.y);
        const z = inTrench ? 0 : b.z;
        if (inTrench) b.exposed = now + 280;
        bullets.push({
          id: nextId++, owner: b.id, ownerName: b.name, side: b.side, x: b.x + Math.cos(a) * 18, y: b.y + Math.sin(a) * 18,
          z, vx: Math.cos(a) * 850 * BULLET_SPEED_MULT, vy: Math.sin(a) * 850 * BULLET_SPEED_MULT, dmg: 20, life: 0.8 / BULLET_SPEED_MULT, kind: 'rifle',
        });
        evt('shot', { x: b.x + Math.cos(a) * 18, y: b.y + Math.sin(a) * 18, angle: a, side: b.side, weapon: 'rifle', id: b.id });
      }
      // bark occasionally
      if (now - (b.lastBark || 0) > 14000 && Math.random() < 0.008) {
        b.lastBark = now;
        evt('bark', { x: b.x, y: b.y, text: BARKS[Math.floor(Math.random() * BARKS.length)] });
      }
    } else {
      // advance on the objective
      if (b.objective) {
        const ang = Math.atan2(b.objective.y - b.y, b.objective.x - b.x);
        b.angle = ang;
        const d = Math.hypot(b.objective.x - b.x, b.objective.y - b.y);
        if (d > 45) {
          b._wantMove = true;
          const spd = b.objective.ordered ? 84 : 72;
          if (lineWalkable(b.x, b.y, b.objective.x, b.objective.y)) {
            b.path = null;
            botStep(b, ang, spd, dt);
          } else {
            botSetPath(b, b.objective.x, b.objective.y, now, 2600);
            if (!botFollow(b, dt, spd)) botStep(b, ang, spd, dt);
          }
        }
      }
    }
    if (b._wantMove) botStuckCheck(b, now);
    b.z = isTrenchAt(b.x, b.y) ? -1 : 0;
    b.x = Math.max(24, Math.min(MAP_W - 24, b.x));
    b.y = Math.max(24, Math.min(MAP_H - 24, b.y));
  }
}

function updateTurrets(dt, now) {
  for (const b of buildings) {
    if (b.kind !== 'turret' || b.hp <= 0) continue;
    b.cooldown = (b.cooldown || 0) - dt;
    if (b.cooldown > 0) continue;
    let target = null, td = 420;
    for (const p of players.values()) {
      if (p.dead || p.side === b.side || !p.side) continue;
      const d = Math.hypot(p.x - b.x, p.y - b.y);
      if (d < td) { td = d; target = p; }
    }
    if (!target) for (const o of bots) {
      if (o.dead || o.side === b.side) continue;
      const d = Math.hypot(o.x - b.x, o.y - b.y);
      if (d < td) { td = d; target = o; }
    }
    if (target) {
      b.cooldown = 0.55;
      const ang = Math.atan2(target.y - b.y, target.x - b.x);
      const z = target.z;
      bullets.push({
        id: nextId++, owner: 'turret' + b.id, ownerName: 'MG Nest', side: b.side,
        x: b.x + Math.cos(ang) * 22, y: b.y + Math.sin(ang) * 22, z,
        vx: Math.cos(ang) * 900 * BULLET_SPEED_MULT, vy: Math.sin(ang) * 900 * BULLET_SPEED_MULT, dmg: 16, life: 0.5 / BULLET_SPEED_MULT, kind: 'mg',
      });
      evt('shot', { x: b.x, y: b.y, angle: ang, side: b.side, weapon: 'mg', id: 'turret' });
    }
  }
}

function updateMobDamage(dt) {
  for (const [side, mob] of [['red', war.blueMob], ['blue', war.redMob]]) {
    // attackers of 'side' damage the *enemy* mob
    const enemy = side;
    let attackers = 0;
    for (const p of players.values()) {
      if (p.dead || p.side !== enemy) continue;
      if (Math.hypot(p.x - mob.x, p.y - mob.y) < 140) attackers += 1.5;
    }
    for (const b of bots) {
      if (b.dead || b.side !== enemy) continue;
      if (Math.hypot(b.x - mob.x, b.y - mob.y) < 140) attackers += 0.5;
    }
    if (attackers > 0) {
      mob.hp -= attackers * 9 * dt;
      if (mob.hp <= 0) {
        mob.hp = 0;
        endWar(enemy, 'mob');
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Auth API                                                          */
/* ------------------------------------------------------------------ */
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'Bad input' });
  const name = username.trim().slice(0, 18);
  if (name.length < 3 || password.length < 4) return res.status(400).json({ error: 'Username 3+, password 4+ characters' });
  if (db.users[name]) return res.status(409).json({ error: 'That name is taken' });
  const hash = await bcrypt.hash(password, 10);
  const token = randomUUID();
  db.users[name] = {
    passwordHash: hash, token, registered: true, side: null, rank: 0, xp: 0,
    stats: newStats(), createdAt: Date.now(),
  };
  dirty = true; saveDb(true);
  res.json({ ok: true, token });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const u = db.users[String(username || '').trim()];
  if (!u) return res.status(401).json({ error: 'No such soldier' });
  if (!(await bcrypt.compare(String(password || ''), u.passwordHash))) return res.status(401).json({ error: 'Wrong password' });
  u.token = u.token || randomUUID();
  if (!u.stats) u.stats = newStats();
  dirty = true; saveDb(true);
  res.json({ ok: true, token: u.token, user: { username, rank: u.rank, xp: u.xp, stats: u.stats } });
});

app.get('/api/status', (req, res) => {
  res.json({
    online: players.size, war: war ? warPublic() : null,
    servers: 1, mode: WAR_DAYS > 0 ? `${WAR_DAYS}-day campaign` : `${WAR_MINUTES}-minute campaign`,
  });
});

/* ------------------------------------------------------------------ */
/*  WebSocket                                                          */
/* ------------------------------------------------------------------ */
wss.on('connection', (ws) => {
  const p = makePlayer(ws);
  players.set(ws, p);

  send(ws, {
    type: 'init', player: sanitize(p),
    world: { w: MAP_W, h: MAP_H, tile: TILE, cols: COLS, rows: ROWS, seed: MAP_SEED },
    terrain: Array.from(terrain), trenches: Array.from(trenches),
    structures: structures.map(s => ({ ...s })),
    trees: trees.map(t => ({ id: t.id, x: t.x, y: t.y, r: Math.round(t.r), hp: Math.round(t.hp) })),
    bushes: bushes.map(b => ({ id: b.id, x: b.x, y: b.y, r: Math.round(b.r) })),
    capturePoints: capturePoints.map(c => ({ ...c })),
    buildings: buildings.map(b => ({ ...b })),
    vehicles: vehicles.map(v => ({ ...v })),
    resources: resources.map(r => ({ ...r })),
    drops: drops.map(d => ({ ...d })),
    war: warPublic(), ranks: RANKS, config: { weapons: WEAPONS, armor: ARMOR, buildings: BUILDINGS, vehicles: VEHICLES, captureRadius: CAPTURE_RADIUS },
    stock: teamStock, mode: WAR_DAYS > 0 ? `${WAR_DAYS}-day campaign` : `${WAR_MINUTES}-minute campaign`,
  });

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    handle(ws, p, msg);
  });
  ws.on('close', () => {
    if (p.vehicle) { p.vehicle.driver = null; p.vehicle = null; }
    players.delete(ws);
    saveDb();
  });
});

function handle(ws, p, msg) {
  switch (msg.type) {
    case 'auth': {
      const u = db.users[String(msg.username || '').trim()];
      if (!u || !msg.token || u.token !== msg.token) return send(ws, { type: 'auth_fail', error: 'Session expired' });
      if (!u.stats) u.stats = newStats();
      p.registered = true; p.username = msg.username; p.name = msg.username;
      p.rank = u.rank; p.xp = u.xp; p.stats = u.stats;
      p.side = u.side || null; p.sideLocked = u.sideLocked != null ? !!u.sideLocked : !!u.side;
      send(ws, { type: 'auth_ok', player: sanitize(p) });
      break;
    }
    case 'rename': {
      if (p.registered) return;
      const n = String(msg.name || '').replace(/[^\w\- ]/g, '').trim().slice(0, 16);
      if (n.length >= 2) { p.name = n; send(ws, { type: 'renamed', name: n }); }
      break;
    }
    case 'side_select': {
      if (p.sideLocked) return send(ws, { type: 'toast', text: 'Your army is locked — you have already deployed this war', level: 'red' });
      if (msg.side !== 'red' && msg.side !== 'blue') return;
      p.side = msg.side;
      if (p.registered && db.users[p.username]) { db.users[p.username].side = msg.side; dirty = true; }
      send(ws, { type: 'side_set', side: p.side });
      evt('toast', { to: p.id, text: `Enlisted with the ${p.side === 'red' ? 'RED' : 'BLUE'} army — changeable until deployment` });
      break;
    }
    case 'input':
      if (msg.input && typeof msg.input === 'object') {
        p.input.up = !!msg.input.up; p.input.down = !!msg.input.down;
        p.input.left = !!msg.input.left; p.input.right = !!msg.input.right;
        p.input.sprint = !!msg.input.sprint;
        p.input.interact = !!msg.input.interact;
        if (typeof msg.input.aimX === 'number') p.input.aimX = msg.input.aimX;
        if (typeof msg.input.aimY === 'number') p.input.aimY = msg.input.aimY;
        p.input.shoot = !!msg.input.shoot;
      }
      break;
    case 'aim':
      if (typeof msg.angle === 'number') p.angle = msg.angle;
      break;
    case 'shoot': p.input.shoot = true; break;
    case 'reload': if (!p.dead) reloadWeapon(p, Date.now()); break;
    case 'grenade': if (!p.dead) throwGrenade(p, Date.now()); break;
    case 'interact': interact(p); break;
    case 'vehicle': if (!p.dead) enterVehicle(p); break;
    case 'chat': {
      const text = String(msg.text || '').slice(0, 180).trim();
      if (!text) return;
      const f = p.freq;
      const freq = `${String(f.high).padStart(3, '0')}-${String(f.low).padStart(3, '0')}`;
      bcast({ type: 'chat', from: p.name, side: p.side, freq, high: f.high, low: f.low, text, t: Date.now(), rank: p.rank });
      break;
    }
    case 'set_freq': {
      p.freq.high = Math.max(0, Math.min(999, parseInt(msg.high, 10) || 0));
      p.freq.low = Math.max(0, Math.min(999, parseInt(msg.low, 10) || 0));
      send(ws, { type: 'freq_set', high: p.freq.high, low: p.freq.low });
      break;
    }
    case 'marker': {
      if (!p.side || p.dead) return;
      const order = !!msg.order && p.registered && p.rank >= 6;
      const now = Date.now();
      const kind = order ? 'order' : 'marker';
      // Expire stale tags before applying the per-player limit.
      markers = markers.filter(m => now - (m.t || 0) < (m.kind === 'order' ? ORDER_TTL : MARKER_TTL));
      if (order) {
        markers = markers.filter(m => !(m.byId === p.id && m.kind === 'order'));
      } else {
        const own = markers.filter(m => m.byId === p.id && m.kind === 'marker');
        const excess = own.length - (MARKER_LIMIT - 1);
        if (excess > 0) {
          const doomed = new Set(own.sort((a, b) => a.t - b.t).slice(0, excess).map(m => m.id));
          markers = markers.filter(m => !doomed.has(m.id));
        }
      }
      const marker = { id: nextId++, kind, side: p.side, x: +msg.x || p.x, y: +msg.y || p.y, by: p.name, byId: p.id, t: now, ttl: order ? ORDER_TTL : MARKER_TTL };
      markers.push(marker);
      bcast({ type: 'marker', marker });
      break;
    }
    case 'barrage':
      if (p.registered && p.rank >= 6) callBarrage(p, +msg.x || p.x, +msg.y || p.y);
      break;
    case 'build': build(p, msg.kind, +msg.x, +msg.y, msg.horizontal); break;
    case 'equip': equip(p, msg.weapon, msg.armor); break;
    case 'vehicle_request': requestVehicle(p, msg.kind, +msg.x || p.x, +msg.y || p.y); break;
    case 'spawn':
      if (p.side && (!p.dead || Date.now() - p.deathAt >= 3000)) {
        p.spawnPoint = msg.point || 'mob';
        spawnPlayer(p, p.spawnPoint);
      }
      break;
    case 'respawn': if (p.side) respawnPoint(p); break;
    case 'profile': {
      if (p.username && db.users[p.username]) send(ws, { type: 'profile', user: { username: p.username, rank: p.rank, xp: p.xp, stats: db.users[p.username].stats, wars: db.wars } });
      else send(ws, { type: 'profile', user: { username: p.name, rank: -1, xp: 0, stats: p.stats, wars: db.wars } });
      break;
    }
    case 'ping': send(ws, { type: 'pong', t: msg.t }); break;
  }
}

/* ------------------------------------------------------------------ */
/*  Simulation loop                                                    */
/* ------------------------------------------------------------------ */
let lastTick = Date.now();
let lastBroadcast = 0;
let lastIncome = Date.now();

setInterval(() => {
  const now = Date.now();
  let dt = (now - lastTick) / 1000;
  lastTick = now;
  if (dt > 0.25) dt = 0.25;
  markers = markers.filter(m => now - (m.t || 0) < (m.kind === 'order' ? ORDER_TTL : MARKER_TTL));
  if (!war || war.ending) { /* still update minimal */ }

  // war clock
  if (war && !war.ending) {
    if (now - war.start >= war.duration) {
      const r = warPublic();
      let winner = 'red';
      if (r.bluePoints > r.redPoints) winner = 'blue';
      else if (r.bluePoints === r.redPoints) winner = war.blueMob.hp > war.redMob.hp ? 'blue' : 'red';
      endWar(winner, 'time');
    }
  }

  if (war && !war.ending) {
    // players
    for (const p of players.values()) {
      if (p.dead) continue;
      const armorDef = ARMOR[p.armor] || ARMOR.none;
      let mx = 0, my = 0;
      if (p.input.up) my--;
      if (p.input.down) my++;
      if (p.input.left) mx--;
      if (p.input.right) mx++;
      const len = Math.hypot(mx, my);
      if (len > 0) { mx /= len; my /= len; }

      p.angle = Math.atan2(p.input.aimY - p.y, p.input.aimX - p.x);
      if (!p.vehicle) {
        let spd = 132 * armorDef.speed * (p.input.sprint ? 1.32 : 1);
        if (isTrenchAt(p.x, p.y)) spd *= 0.82;
        const tt = terrainAt(p.x, p.y);
        if (tt === T.MUD || tt === T.CRATER) spd *= 0.86;
        // A decked bridge is firm footing; only open water forces a slow swim.
        if (tt === T.WATER && !isBridgeAt(p.x, p.y)) spd *= 0.52; // swimming: slow and completely exposed
        if (len > 0) {
          const nx = p.x + mx * spd * dt, ny = p.y + my * spd * dt;
          if (walkable(nx, p.y)) p.x = nx;
          if (walkable(p.x, ny)) p.y = ny;
          if (p.registered && db.users[p.username]) { db.users[p.username].stats.kmWalked += (spd * dt) / 1000; dirty = true; }
        }
      } else {
        const v = p.vehicle;
        const def = VEHICLES[v.kind] || VEHICLES.truck;
        if (len > 0) {
          const targetAng = Math.atan2(my, mx);
          v.angle = targetAng;
          let spd = def.speed * (p.input.sprint ? 1.15 : 1);
          const nx = v.x + mx * spd * dt, ny = v.y + my * spd * dt;
          const tree = treeBlockAt(nx, ny, 15);
          if (tree) {
            // Heavy machinery ploughs through timber. A tank fells a tree in
            // one pass; trucks need a couple of hits and take more damage.
            const heavy = v.kind === 'tank' ? 2.1 : v.kind === 'armored_car' ? 1.2 : 0.65;
            tree.hp = Math.max(0, tree.hp - spd * 0.42 * heavy);
            evt('tree_hit', { id: tree.id, hp: Math.round(tree.hp), maxHp: tree.maxHp });
            if (tree.hp <= 0) evt('tree_felled', { id: tree.id, x: tree.x, y: tree.y });
            if (!v.lastImpact || now - v.lastImpact > 320) {
              v.lastImpact = now;
              evt('vehicle_impact', { x: v.x, y: v.y, kind: v.kind, side: v.side, heavy: v.kind === 'tank', tree: true });
              damageVehicle(v, spd * 0.055 * heavy, p, 'collision');
            }
          } else if (vehicleWalkable(nx, ny, true)) {
            v.x = nx; v.y = ny;
          } else if (!v.lastImpact || now - v.lastImpact > 420) {
            // solid masonry, boulders and river banks punish careless driving
            v.lastImpact = now;
            evt('vehicle_impact', { x: v.x, y: v.y, kind: v.kind, side: v.side, heavy: v.kind === 'tank', tree: false });
            damageVehicle(v, spd * 0.045, p, 'collision');
          }
          if (p.registered && db.users[p.username]) { db.users[p.username].stats.kmDriven += (spd * dt) / 1000; dirty = true; }
        }
        p.x = v.x; p.y = v.y;
        p.z = 0;
        if (p.input.shoot && def.gun) {
          // vehicle MG / APC autocannon
          const apc = v.kind === 'apc';
          if (apc) {
            if ((v.magAmmo || 0) <= 0) {
              if ((v.ammo || 0) > 0 && now >= (v.reloadingUntil || 0)) {
                if (!v.reloadingUntil) v.reloadingUntil = now + (def.reload || 3) * 1000;
                else if (now >= v.reloadingUntil) {
                  const load = Math.min(def.mag || 40, v.ammo);
                  v.magAmmo = load; v.ammo -= load; v.reloadingUntil = 0;
                  evt('vehicle_reload', { x: v.x, y: v.y, id: v.id, ammo: v.ammo });
                }
              }
            }
          }
          const canFire = !apc || (v.magAmmo || 0) > 0;
          if (canFire && now - (v.cooldown || 0) > (apc ? 150 : 130)) {
            v.cooldown = now;
            if (apc) v.magAmmo--;
            const a = p.angle + (Math.random() - 0.5) * (apc ? 0.06 : 0.09);
            bullets.push({
              id: nextId++, owner: p.id, ownerName: p.name, side: p.side,
              x: v.x + Math.cos(a) * 30, y: v.y + Math.sin(a) * 30, z: 0,
              vx: Math.cos(a) * 1000 * BULLET_SPEED_MULT, vy: Math.sin(a) * 1000 * BULLET_SPEED_MULT,
              dmg: apc ? 26 : 22, life: 1 / BULLET_SPEED_MULT, kind: apc ? 'apc' : 'mg',
              splash: apc ? 36 : 0, splashDmg: apc ? 15 : 0,
            });
            evt('shot', { x: v.x, y: v.y, angle: a, side: p.side, weapon: apc ? 'apc' : 'mg', id: p.id });
          }
        }
      }
      if (!p.vehicle) {
        p.z = isTrenchAt(p.x, p.y) ? -1 : 0;
        if (p.input.shoot) fire(p, now);
      }
      depositAtPoint(p, false, true);
      pickupDrops(p);
    }

    updateBots(dt, now);
    updateTurrets(dt, now);
    updateCapture(dt);
    updateMobDamage(dt);

    // Conquest score: each owned sector accumulates pressure every second.
    let redOwned = 0, blueOwned = 0;
    for (const cp of capturePoints) {
      if (cp.owner === 'red') redOwned++;
      else if (cp.owner === 'blue') blueOwned++;
    }
    war.score.red += redOwned * SCORE_PER_SECTOR * dt;
    war.score.blue += blueOwned * SCORE_PER_SECTOR * dt;
    const minute = Math.floor((now - war.start) / 60000);
    if (minute !== war.lastMinute) {
      war.lastMinute = minute;
      war.timeline.push({
        m: minute, red: Math.floor(war.score.red), blue: Math.floor(war.score.blue),
        redPoints: redOwned, bluePoints: blueOwned,
      });
      if (war.timeline.length > 240) war.timeline.shift();
    }
    if (war.score.red >= SCORE_LIMIT || war.score.blue >= SCORE_LIMIT) {
      endWar(war.score.red >= war.score.blue ? 'red' : 'blue', 'score');
    }

    // bullets
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      const px = b.x, py = b.y;
      b.x += b.vx * dt; b.y += b.vy * dt;
      b.life -= dt;
      if (b.life <= 0 || b.x < 0 || b.y < 0 || b.x > MAP_W || b.y > MAP_H) { bullets.splice(i, 1); continue; }
      // Bullets fly across water. Boulders and structures stop them; sweep the
      // whole travel path so fast rounds cannot slip past a rock's edge.
      if (segmentHitsRock(px, py, b.x, b.y)) {
        evt('impact', { x: b.x, y: b.y, kind: 'dirt' });
        bullets.splice(i, 1); continue;
      }
      const nearTrees = treesNear(b.x, b.y);
      for (const tr of nearTrees) {
        if (tr.hp <= 0) continue;
        if (Math.hypot(tr.x - b.x, tr.y - b.y) < tr.r * 0.72) {
          tr.hp = Math.max(0, tr.hp - b.dmg * 0.55);
          evt('tree_hit', { id: tr.id, hp: Math.round(tr.hp), maxHp: tr.maxHp });
          break;
        }
      }
      // hit players
      let hit = false;
      for (const t of players.values()) {
        if (t.dead || t.side === b.side || !t.side || t.vehicle) continue;
        if (Math.hypot(t.x - b.x, t.y - b.y) > 15) continue;
        // A soldier hugging the trench floor is below the bullet's flight path.
        if (isTrenchAt(t.x, t.y) && (t.exposed || 0) <= now) continue;
        damagePlayer(t, b.dmg, findOwner(b.owner), b.kind);
        hit = true; break;
      }
      if (!hit) {
        for (const t of bots) {
          if (t.dead || t.side === b.side) continue;
          if (Math.hypot(t.x - b.x, t.y - b.y) > 15) continue;
          if (isTrenchAt(t.x, t.y) && (t.exposed || 0) <= now) continue;
          damageBot(t, b.dmg, findOwner(b.owner), b.kind);
          hit = true; break;
        }
      }
      if (!hit) {
        for (const v of vehicles) {
          if (v.side === b.side || v.hp <= 0) continue;
          if (Math.hypot(v.x - b.x, v.y - b.y) > 26) continue;
          damageVehicle(v, b.dmg, findOwner(b.owner), b.kind);
          hit = true; break;
        }
      }
      if (!hit) {
        for (const bd of buildings) {
          if (bd.side === b.side || bd.hp <= 0 || bd.kind === 'bridge') continue;
          if (Math.hypot(bd.x - b.x, bd.y - b.y) > 26) continue;
          bd.hp -= b.dmg * 0.6;
          if (bd.hp <= 0) { evt('building_destroyed', { x: bd.x, y: bd.y, kind: bd.kind, side: bd.side }); }
          hit = true; break;
        }
      }
      if (hit) {
        if (b.splash) {
          splashDamage(b.x, b.y, b.splash, b.splashDmg, b.side, findOwner(b.owner), 'apc');
          evt('impact', { x: b.x, y: b.y, kind: 'blast' });
        } else evt('impact', { x: b.x, y: b.y, kind: 'blood' });
        bullets.splice(i, 1);
      }
    }

    // grenades
    for (let i = grenades.length - 1; i >= 0; i--) {
      const g = grenades[i];
      g.x += g.vx * dt; g.y += g.vy * dt;
      g.vx *= 0.94; g.vy *= 0.94;
      g.fuse -= dt;
      if (g.fuse <= 0) {
        let attacker = null;
        for (const q of players.values()) if (q.id === g.owner) attacker = q;
        explode(g.x, g.y, 92, 95, attacker, 'grenade');
        grenades.splice(i, 1);
      }
    }

    // supply drops fade after a minute on the field
    for (let i = drops.length - 1; i >= 0; i--) {
      if (now - (drops[i].t || 0) > 60000) drops.splice(i, 1);
    }

    // income: every MOB produces on its own, and each held sector adds a
    // smaller trickle into that sector's own stockpile.
    if (now - lastIncome > 1000) {
      lastIncome = now;
      const pm = popMod();
      for (const side of ['red', 'blue']) {
        const mob = mobStock[side];
        addToStock(mob, 'scrap', 2.4 * pm);
        addToStock(mob, 'fuel', 1.3 * pm);
        addToStock(mob, 'ammo', 1.7 * pm);
        for (const cp of capturePoints) {
          if (cp.owner !== side) continue;
          if (!cp.stock) cp.stock = emptyStock();
          addToStock(cp.stock, 'scrap', 0.9 * pm);
          addToStock(cp.stock, 'fuel', 0.5 * pm);
          addToStock(cp.stock, 'ammo', 0.7 * pm);
        }
        syncTeamStock(side);
      }
    }

    // cleanup broken buildings
    for (let i = buildings.length - 1; i >= 0; i--) {
      if (buildings[i].hp <= 0) buildings.splice(i, 1);
    }
  }

  // state broadcast 20hz
  if (now - lastBroadcast > 50) {
    lastBroadcast = now;
    const stock = { red: { ...teamStock.red, points: undefined }, blue: { ...teamStock.blue, points: undefined } };
    bcast({
      type: 'state', t: now,
      players: [...players.values()].map(sanitize),
      bots: bots.map(b => ({ id: b.id, name: b.name, side: b.side, x: Math.round(b.x), y: Math.round(b.y), z: b.z, hp: Math.max(0, Math.round(b.hp)), maxHp: b.maxHp, angle: b.angle, dead: b.dead, kills: b.kills | 0, deaths: b.deaths | 0, assists: b.assists | 0 })),
      bullets: bullets.map(b => ({ id: b.id, x: Math.round(b.x), y: Math.round(b.y), z: b.z, side: b.side, vx: b.vx, vy: b.vy })),
      grenades: grenades.map(g => ({ id: g.id, x: Math.round(g.x), y: Math.round(g.y), fuse: g.fuse })),
      vehicles: vehicles.map(v => ({ id: v.id, kind: v.kind, side: v.side, x: Math.round(v.x), y: Math.round(v.y), angle: v.angle, hp: Math.max(0, Math.round(v.hp)), maxHp: v.maxHp, driver: v.driver, cargo: v.cargo, ammo: v.ammo, magAmmo: v.magAmmo })),
      capturePoints: capturePoints.map(c => ({ id: c.id, owner: c.owner, progress: Math.round(c.progress || 0), contesting: c.contesting,
        stock: c.stock ? { scrap: Math.floor(c.stock.scrap), fuel: Math.floor(c.stock.fuel), ammo: Math.floor(c.stock.ammo) } : null })),
      buildings: buildings.map(b => ({ id: b.id, hp: Math.round(b.hp) })),
      resources: resources.map(r => ({ id: r.id, amount: r.amount })),
      drops: drops.map(d => ({ id: d.id, x: d.x, y: d.y, scrap: d.scrap, fuel: d.fuel, ammo: d.ammo, side: d.side })),
      war: warPublic(),
      stock,
      markers,
    });
  }
}, 1000 / 30);

/* boot */
startWar();

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`TRENCHES server ready → http://localhost:${PORT}  (${WAR_DAYS > 0 ? WAR_DAYS + '-day' : WAR_MINUTES + '-min'} campaign)`));
