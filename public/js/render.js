/* ============================================================
   TRENCHES — renderer
   ============================================================ */
'use strict';

const TC = {
  0: ['#4d5b36', '#48552f', '#525f3a', '#44512d', '#57643e', '#4a5733'],
  1: ['#6d5c42', '#66553c', '#736246', '#5f4f37', '#7a6949'],
  2: ['#4b3f2f', '#45392a', '#514533', '#3f3426', '#55482f'],
  3: ['#2b4c59', '#274552', '#2f515f', '#23404c'],
  4: ['#3f4d2a', '#3a4726', '#46532f'],
  5: ['#6a6250', '#655d4b', '#706855', '#5d5544'],
  6: ['#8e8060', '#887a5a', '#93845f', '#837556'],
  7: ['#342b22', '#2f271e', '#392f24', '#2a221a'],
  8: ['#6d5232', '#674c2e', '#735636', '#614828'],
  9: ['#575950', '#51534a', '#5d5f55'],
};

function resize() {
  S.viewW = window.innerWidth;
  S.viewH = window.innerHeight;
  canvas.width = Math.floor(S.viewW * DPR);
  canvas.height = Math.floor(S.viewH * DPR);
  canvas.style.width = S.viewW + 'px';
  canvas.style.height = S.viewH + 'px';
}
window.addEventListener('resize', resize);
resize();

const GROUND = {
  0: [[56, 68, 38], [88, 101, 60]],
  1: [[92, 79, 57], [128, 111, 78]],
  2: [[58, 48, 36], [84, 71, 50]],
  3: [[28, 52, 62], [50, 84, 96]],
  4: [[40, 53, 29], [64, 81, 45]],
  5: [[88, 82, 68], [118, 110, 92]],
  6: [[126, 114, 88], [158, 144, 110]],
  7: [[54, 45, 34], [80, 68, 49]],
  8: [[96, 74, 46], [124, 98, 62]],
  9: [[70, 72, 62], [96, 98, 86]],
  10: [[84, 79, 68], [112, 106, 92]],
  11: [[92, 72, 49], [126, 102, 70]],
};

function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function fbm(x, y) {
  return vnoise(x, y) * 0.62 +
    vnoise(x * 2.6 + 13.7, y * 2.6 + 7.1) * 0.28 +
    vnoise(x * 6.3 + 31.1, y * 6.3 + 19.3) * 0.10;
}

/* Coarse, blurred map of how churned-up each region is. Turns the random
   per-tile mud mask into large continuous stretches of broken ground. */
function buildBattleField() {
  const B = 3;
  const bw = Math.ceil(S.world.cols / B), bh = Math.ceil(S.world.rows / B);
  let f = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let sum = 0, cnt = 0;
      for (let ty = by * B; ty < Math.min((by + 1) * B, S.world.rows); ty++) {
        for (let tx = bx * B; tx < Math.min((bx + 1) * B, S.world.cols); tx++) {
          const i = idxAt(tx, ty);
          const t = S.terrain[i];
          if (S.trenches.has(i)) sum += 1.15;
          else if (t === 2 || t === 7) sum += 1;
          else if (t === 1) sum += 0.55;
          cnt++;
        }
      }
      f[by * bw + bx] = cnt ? sum / cnt : 0;
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
          s += f[ny * bw + nx]; n++;
        }
        out[y * bw + x] = s / n;
      }
    }
    f = out;
  }
  return { f, bw, bh, B };
}

function sampleBattle(bf, wx, wy) {
  const gx = clamp(wx / (bf.B * S.world.tile) - 0.5, 0, bf.bw - 1.001);
  const gy = clamp(wy / (bf.B * S.world.tile) - 0.5, 0, bf.bh - 1.001);
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = gx - x0, fy = gy - y0;
  const x1 = Math.min(x0 + 1, bf.bw - 1), y1 = Math.min(y0 + 1, bf.bh - 1);
  const a = bf.f[y0 * bf.bw + x0], b = bf.f[y0 * bf.bw + x1];
  const c = bf.f[y1 * bf.bw + x0], d = bf.f[y1 * bf.bw + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/* Paint a continuous, noise-driven ground layer. The tile mask is sampled
   through a warp field so biome borders become ragged and organic. */
function paintGround(g) {
  const GS = 8;
  const gw = Math.ceil(S.world.w / GS), gh = Math.ceil(S.world.h / GS);
  const off = document.createElement('canvas');
  off.width = gw; off.height = gh;
  const og = off.getContext('2d');
  const img = og.createImageData(gw, gh);
  const data = img.data;
  const tile = S.world.tile;
  const bf = S.battleField || buildBattleField();
  let p = 0;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const wx = x * GS + GS / 2, wy = y * GS + GS / 2;
      const n1 = fbm(wx * 0.0125, wy * 0.0125);
      const n2 = fbm(wx * 0.0125 + 41.3, wy * 0.0125 + 17.9);
      const sx = wx + (n1 - 0.5) * 30 + (hash2(x, y) - 0.5) * 8;
      const sy = wy + (n2 - 0.5) * 30 + (hash2(x + 7, y + 3) - 0.5) * 8;
      const tx = clamp(Math.floor(sx / tile), 0, S.world.cols - 1);
      const ty = clamp(Math.floor(sy / tile), 0, S.world.rows - 1);
      const type = S.terrain[idxAt(tx, ty)];
      const grind = clamp(n1 * 0.55 + n2 * 0.45 + (hash2(x + 13, y + 5) - 0.5) * 0.22, 0, 1);
      let R, G, B;
      if (type === 3 || type === 5 || type === 6 || type === 8 || type === 9 || type === 10 || type === 11) {
        const ramp = GROUND[type];
        R = ramp[0][0] + (ramp[1][0] - ramp[0][0]) * grind;
        G = ramp[0][1] + (ramp[1][1] - ramp[0][1]) * grind;
        B = ramp[0][2] + (ramp[1][2] - ramp[0][2]) * grind;
      } else {
        const battle = sampleBattle(bf, wx, wy);
        const broad = fbm(wx * 0.006 + 9.1, wy * 0.006 + 4.7);
        let mud = clamp(battle * 1.55 + (broad - 0.5) * 1.0 - 0.30, 0, 1);
        mud = mud * mud * (3 - 2 * mud);
        const gRamp = GROUND[type === 4 ? 4 : 0], mRamp = GROUND[2];
        const gR = gRamp[0][0] + (gRamp[1][0] - gRamp[0][0]) * grind;
        const gG = gRamp[0][1] + (gRamp[1][1] - gRamp[0][1]) * grind;
        const gB = gRamp[0][2] + (gRamp[1][2] - gRamp[0][2]) * grind;
        const mR = mRamp[0][0] + (mRamp[1][0] - mRamp[0][0]) * grind;
        const mG = mRamp[0][1] + (mRamp[1][1] - mRamp[0][1]) * grind;
        const mB = mRamp[0][2] + (mRamp[1][2] - mRamp[0][2]) * grind;
        R = gR + (mR - gR) * mud;
        G = gG + (mG - gG) * mud;
        B = gB + (mB - gB) * mud;
      }
      data[p++] = R;
      data[p++] = G;
      data[p++] = B;
      data[p++] = 255;
    }
  }
  og.putImageData(img, 0, 0);
  g.save();
  g.imageSmoothingEnabled = true;
  g.drawImage(off, 0, 0, gw, gh, 0, 0, S.world.w, S.world.h);
  g.restore();
}

function buildTerrain() {
  const c = document.createElement('canvas');
  c.width = S.world.w; c.height = S.world.h;
  const g = c.getContext('2d');
  const tile = S.world.tile;
  S.battleField = buildBattleField();
  paintGround(g);
  addTerrainGrain(g, c.width, c.height);
  for (let ty = 0; ty < S.world.rows; ty++) {
    for (let tx = 0; tx < S.world.cols; tx++) {
      drawTerrainDetail(g, tx, ty, S.terrain[idxAt(tx, ty)], tile);
    }
  }
  // facades, windows, doors and interior dressing on top of the tile base
  for (const st of S.structures || []) drawStructureDetail(g, st, tile);
  // trench networks on top
  for (const i of S.trenches) {
    const tx = i % S.world.cols, ty = Math.floor(i / S.world.cols);
    drawTrenchTile(g, tx, ty, tile);
  }
  decorateTerrain(g);
  S.terrainCanvas = c;
  S.terrainCtx = g;
  S.deployMapDirty = true;
}

/* A player-built trench section: stamp it straight into the baked terrain
   canvas so it costs nothing to render afterwards. */
function addTrenchTile(tx, ty) {
  if (!S.world || !S.terrainCanvas) return;
  S.trenches.add(idxAt(tx, ty));
  const g = S.terrainCtx, tile = S.world.tile;
  g.save();
  g.fillStyle = '#4a3c28';
  g.fillRect(tx * tile - 3, ty * tile - 3, tile + 6, tile + 6);
  g.restore();
  drawTrenchTile(g, tx, ty, tile);
  // blend the joints with already-dug neighbours
  if (isTrenchTile(tx - 1, ty)) drawTrenchTile(g, tx - 1, ty, tile);
  if (isTrenchTile(tx, ty - 1)) drawTrenchTile(g, tx, ty - 1, tile);
  buildMinimap();
  S.deployMapDirty = true;
}

/* Fine grain plus large, very soft light/dark patches kill flat colour. */
function addTerrainGrain(g, w, h) {
  g.save();
  for (let i = 0; i < 70; i++) {
    const x = hash2(i, 1) * w, y = hash2(i, 2) * h;
    const r = 120 + hash2(i, 3) * 420;
    const dark = hash2(i, 4) > 0.52;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, dark ? 'rgba(12,16,8,.11)' : 'rgba(196,206,158,.055)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  }
  const n = document.createElement('canvas');
  n.width = 256; n.height = 256;
  const ng = n.getContext('2d');
  for (let i = 0; i < 5200; i++) {
    const a = Math.random();
    ng.fillStyle = a > 0.5
      ? `rgba(255,246,214,${0.03 + Math.random() * 0.06})`
      : `rgba(0,0,0,${0.03 + Math.random() * 0.07})`;
    ng.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
  const pat = g.createPattern(n, 'repeat');
  g.globalAlpha = 0.6;
  g.fillStyle = pat;
  g.fillRect(0, 0, w, h);
  g.restore();
}

function decorateTerrain(g) {
  const tile = S.world.tile;
  for (let ty = 2; ty < S.world.rows - 2; ty++) {
    for (let tx = 2; tx < S.world.cols - 2; tx++) {
      const t = S.terrain[idxAt(tx, ty)];
      if (S.trenches.has(idxAt(tx, ty))) continue;
      const px = tx * tile, py = ty * tile;
      const h = hash2(tx * 7 + 3, ty * 13 + 5);
      // scattered battle debris on dirt / mud / crater
      if ((t === 1 || t === 2 || t === 7) && h < 0.13) {
        g.save();
        g.translate(px + 6 + h * 20, py + 6 + hash2(tx, ty + 2) * 20);
        g.rotate(h * 6);
        g.fillStyle = 'rgba(50,40,26,.55)';
        g.fillRect(-4, -1, 9, 2);
        g.fillStyle = 'rgba(30,26,18,.5)';
        g.fillRect(-2, 1, 4, 2);
        g.restore();
      }
      // grass tufts / flowers
      if (t === 0 && h > 0.72) {
        const fx = px + 5 + hash2(tx + 4, ty) * 22;
        const fy = py + 5 + hash2(tx, ty + 4) * 22;
        g.fillStyle = h > 0.93 ? 'rgba(190,180,110,.55)' : 'rgba(120,135,75,.4)';
        g.fillRect(fx, fy, 2, 2);
      }
      // occasional stones
      if ((t === 0 || t === 1) && h > 0.965) {
        g.fillStyle = 'rgba(110,112,100,.5)';
        g.fillRect(px + 8 + h * 12, py + 10 + h * 8, 3, 2);
      }
      // barbed wire along trench approaches
      if (t === 0 || t === 2) {
        const nearTrench = S.trenches.has(idxAt(tx, ty - 1)) || S.trenches.has(idxAt(tx, ty + 1)) ||
          S.trenches.has(idxAt(tx - 1, ty)) || S.trenches.has(idxAt(tx + 1, ty));
        if (nearTrench && h > 0.62) {
          g.strokeStyle = 'rgba(152,150,132,.5)'; g.lineWidth = 1;
          const bx = px + 8 + h * 12, by = py + 8 + hash2(tx + 1, ty) * 12;
          g.beginPath(); g.moveTo(bx - 4, by + 3); g.lineTo(bx + 2, by - 2); g.moveTo(bx + 2, by + 3); g.lineTo(bx - 4, by - 2); g.stroke();
          g.beginPath(); g.moveTo(bx - 6, by); g.lineTo(bx + 4, by); g.stroke();
        }
      }
    }
  }
  // extra shell holes, concentrated in no man's land
  for (let i = 0; i < 190; i++) {
    const central = i < 130;
    const tx = central ? 34 + Math.floor(hash2(i, 3) * 32) : 4 + Math.floor(hash2(i, 9) * (S.world.cols - 8));
    const ty = 4 + Math.floor(hash2(i, 11) * (S.world.rows - 8));
    if (!inMap(tx, ty) || S.trenches.has(idxAt(tx, ty))) continue;
    const t = S.terrain[idxAt(tx, ty)];
    if (t === 3 || t === 8 || t === 9 || t === 5 || t === 10 || t === 11) continue;
    const x = tx * tile + 10 + hash2(i, 2) * 12;
    const y = ty * tile + 10 + hash2(i, 6) * 12;
    const r = 4 + hash2(i, 7) * 7;
    g.fillStyle = 'rgba(22,17,12,.55)';
    g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    g.strokeStyle = 'rgba(120,104,74,.28)'; g.lineWidth = 1.5;
    g.beginPath(); g.arc(x, y, r + 2, 2.2, 5.6); g.stroke();
    g.fillStyle = 'rgba(90,78,54,.35)';
    g.fillRect(x + r, y - 1, 3, 2);
  }
  // dead trees and splintered posts
  for (let i = 0; i < 70; i++) {
    const tx = 30 + Math.floor(hash2(i, 21) * 40);
    const ty = 3 + Math.floor(hash2(i, 23) * (S.world.rows - 6));
    if (!inMap(tx, ty)) continue;
    const t = S.terrain[idxAt(tx, ty)];
    if (t === 3 || t === 5 || t === 8 || t === 10 || t === 11 || S.trenches.has(idxAt(tx, ty))) continue;
    const x = tx * tile + 8 + hash2(i, 25) * 14, y = ty * tile + 8 + hash2(i, 27) * 14;
    g.strokeStyle = 'rgba(42,32,22,.75)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(x, y + 8); g.lineTo(x, y - 5); g.stroke();
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y - 2); g.lineTo(x - 5, y - 7); g.moveTo(x, y - 4); g.lineTo(x + 4, y - 8); g.stroke();
  }
}

function drawTerrainDetail(g, tx, ty, type, tile) {
  const px = tx * tile, py = ty * tile;
  const h = hash2(tx, ty);

  if (type === 0 || type === 4) {
    // grass blades, but not on churned ground
    const churn = S.battleField ? sampleBattle(S.battleField, px + 16, py + 16) : 0;
    if (type === 0 && churn > 0.55) return;
    if (churn <= 0.55) {
      const n = 2 + Math.floor(hash2(tx + 3, ty + 9) * 3);
      g.strokeStyle = 'rgba(28,42,18,.5)';
      g.lineWidth = 1;
      for (let i = 0; i < n; i++) {
        const gx = px + 4 + hash2(tx + i, ty + 4) * (tile - 8);
        const gy = py + 6 + hash2(tx + 2, ty + i) * (tile - 10);
        g.beginPath(); g.moveTo(gx, gy); g.lineTo(gx + 1, gy - 3); g.stroke();
      }
    }
  }
  if (type === 4) {
    // undergrowth only — the individual trees are drawn as objects above
    const n = 3 + Math.floor(hash2(tx + 11, ty + 13) * 3);
    for (let i = 0; i < n; i++) {
      const cx = px + 3 + hash2(tx + i * 3, ty + i * 7) * (tile - 6);
      const cy = py + 3 + hash2(tx + i * 5, ty + i * 2) * (tile - 6);
      const r = 2 + hash2(tx + i, ty + i * 9) * 3;
      g.fillStyle = 'rgba(22,36,18,.5)';
      g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill();
      g.fillStyle = 'rgba(58,84,42,.45)';
      g.beginPath(); g.arc(cx - 0.5, cy - 0.5, r * 0.55, 0, 7); g.fill();
    }
  }
  if (type === 3) {
    g.strokeStyle = 'rgba(160,200,205,.16)';
    g.lineWidth = 1;
    for (let i = 0; i < 2; i++) {
      const wy = py + 8 + i * 11 + hash2(tx, ty + i) * 4;
      g.beginPath(); g.moveTo(px + 3, wy); g.lineTo(px + tile - 3, wy + 2); g.stroke();
    }
  }
  if (type === 5) {
    const rl = inMap(tx - 1, ty) && S.terrain[idxAt(tx - 1, ty)] === 5;
    const rr = inMap(tx + 1, ty) && S.terrain[idxAt(tx + 1, ty)] === 5;
    const ru = inMap(tx, ty - 1) && S.terrain[idxAt(tx, ty - 1)] === 5;
    const rd = inMap(tx, ty + 1) && S.terrain[idxAt(tx, ty + 1)] === 5;
    const vertical = (ru || rd) && (!rl && !rr);
    g.fillStyle = 'rgba(46,38,26,.30)';
    if (vertical) {
      g.fillRect(px + 7, py, 3, tile);
      g.fillRect(px + 22, py, 3, tile);
      g.fillStyle = 'rgba(198,184,150,.07)';
      g.fillRect(px + 14, py, 5, tile);
    } else {
      g.fillRect(px, py + 7, tile, 3);
      g.fillRect(px, py + 22, tile, 3);
      g.fillStyle = 'rgba(198,184,150,.07)';
      g.fillRect(px, py + 14, tile, 5);
    }
    for (let i = 0; i < 5; i++) {
      const sx = px + 2 + hash2(tx + i * 3, ty + i) * 27;
      const sy = py + 2 + hash2(tx + i, ty + i * 5) * 27;
      g.fillStyle = i % 2 ? 'rgba(40,34,24,.34)' : 'rgba(196,184,152,.16)';
      g.fillRect(sx, sy, 2, 1);
    }
  }
  if (type === 6) {
    for (let i = 0; i < 6; i++) {
      const sx = px + 3 + hash2(tx + i * 2, ty + i) * 26;
      const sy = py + 3 + hash2(tx + i, ty + i * 3) * 26;
      g.fillStyle = i % 2 ? 'rgba(60,50,32,.28)' : 'rgba(220,208,170,.18)';
      g.fillRect(sx, sy, 2, 2);
    }
    if (hash2(tx * 2, ty * 3) > 0.8) {
      g.strokeStyle = 'rgba(86,74,50,.30)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(px + 4, py + 10); g.lineTo(px + 28, py + 12); g.stroke();
    }
  }
  if (type === 10) {
    // Masonry wall: mortar bed, staggered stone courses and chipped edges.
    const nb = (dx, dy) => inMap(tx + dx, ty + dy) && S.terrain[idxAt(tx + dx, ty + dy)] === 10;
    g.fillStyle = '#332f27';
    g.fillRect(px, py, tile, tile);
    for (let row = 0; row < 4; row++) {
      const by = py + row * 8;
      for (let col = 0; col < 2; col++) {
        const off = ((row + col) & 1) ? 8 : 0;
        const sx = px + off + col * 16;
        const sh = hash2(tx * 3 + col + row * 7, ty * 5 + row + col * 3);
        const dark = sh < 0.24;
        g.fillStyle = dark
          ? `rgba(${96 + Math.floor(sh * 60)},${89 + Math.floor(sh * 54)},${73 + Math.floor(sh * 44)},.96)`
          : `rgba(${116 + Math.floor(sh * 26)},${108 + Math.floor(sh * 22)},${90 + Math.floor(sh * 18)},.96)`;
        g.fillRect(sx + 1, by + 1, 14, 6);
        g.fillStyle = 'rgba(255,246,214,.07)';
        g.fillRect(sx + 1, by + 1, 14, 1);
        g.fillStyle = 'rgba(20,18,13,.16)';
        g.fillRect(sx + 1, by + 6, 14, 1);
        if (sh > 0.88) {
          g.fillStyle = 'rgba(28,25,20,.4)';
          g.fillRect(sx + 9, by + 2, 3, 2);
        }
      }
    }
    if (!nb(0, -1)) {
      g.fillStyle = 'rgba(224,214,186,.28)'; g.fillRect(px, py, tile, 3);
      g.fillStyle = 'rgba(26,23,18,.28)'; g.fillRect(px, py + 3, tile, 2);
    }
    if (!nb(0, 1)) { g.fillStyle = 'rgba(18,16,12,.44)'; g.fillRect(px, py + tile - 3, tile, 3); }
    if (!nb(-1, 0)) { g.fillStyle = 'rgba(214,204,178,.20)'; g.fillRect(px, py, 2, tile); }
    if (!nb(1, 0)) { g.fillStyle = 'rgba(18,16,12,.36)'; g.fillRect(px + tile - 2, py, 2, tile); }
    if (h > 0.72) {
      g.fillStyle = 'rgba(72,92,50,.30)';
      g.fillRect(px + 3 + h * 20, py + 4 + hash2(tx + 2, ty) * 22, 3, 2);
    }
  }
  if (type === 11) {
    // Interior timber boards: seams, planks, nails and grain.
    const vertical = hash2(tx * 2 + 1, ty * 2 + 5) > 0.5;
    for (let i = 0; i < 4; i++) {
      const v = hash2(tx * 5 + i, ty * 3 + i * 2);
      g.fillStyle = `rgba(${104 + Math.floor(v * 26)},${79 + Math.floor(v * 22)},${52 + Math.floor(v * 16)},1)`;
      if (vertical) g.fillRect(px + i * 8, py, 8, tile);
      else g.fillRect(px, py + i * 8, tile, 8);
      g.fillStyle = 'rgba(30,21,13,.52)';
      if (vertical) g.fillRect(px + i * 8, py, 1, tile);
      else g.fillRect(px, py + i * 8, tile, 1);
      // grain
      g.strokeStyle = 'rgba(54,38,22,.26)'; g.lineWidth = 0.8;
      if (vertical) {
        const gx = px + i * 8 + 3 + v * 3;
        g.beginPath(); g.moveTo(gx, py + 2); g.lineTo(gx + (v - .5) * 2, py + tile - 2); g.stroke();
      } else {
        const gy = py + i * 8 + 3 + v * 3;
        g.beginPath(); g.moveTo(px + 2, gy); g.lineTo(px + tile - 2, gy + (v - .5) * 2); g.stroke();
      }
      // nail heads at board ends
      if (v > 0.55) {
        g.fillStyle = 'rgba(38,30,20,.7)';
        if (vertical) { g.fillRect(px + i * 8 + 3, py + 3, 1.5, 1.5); g.fillRect(px + i * 8 + 3, py + tile - 5, 1.5, 1.5); }
        else { g.fillRect(px + 3, py + i * 8 + 3, 1.5, 1.5); g.fillRect(px + tile - 5, py + i * 8 + 3, 1.5, 1.5); }
      }
    }
    // knots and a broken board
    if (h > 0.82) {
      g.strokeStyle = 'rgba(44,30,17,.6)'; g.lineWidth = 1;
      g.beginPath(); g.ellipse(px + 8 + h * 14, py + 8 + h * 12, 2.4, 1.6, h, 0, 7); g.stroke();
    }
    if (h < 0.06) {
      g.fillStyle = 'rgba(22,16,10,.68)';
      g.fillRect(px + 6, py + 14, 9, 4);
    }
  }
  if (type === 7) {
    if (hash2(tx * 3 + 1, ty * 5 + 2) > 0.55) {
      const cx = px + 16 + (hash2(tx, ty) - 0.5) * 12;
      const cy = py + 16 + (hash2(tx + 5, ty + 5) - 0.5) * 12;
      const rr = 6 + hash2(tx + 1, ty + 2) * 7;
      const grd = g.createRadialGradient(cx, cy, rr * 0.15, cx, cy, rr * 1.25);
      grd.addColorStop(0, 'rgba(12,9,6,.72)');
      grd.addColorStop(0.7, 'rgba(28,22,15,.42)');
      grd.addColorStop(1, 'rgba(28,22,15,0)');
      g.fillStyle = grd;
      g.beginPath(); g.arc(cx, cy, rr * 1.25, 0, 7); g.fill();
      g.strokeStyle = 'rgba(150,132,96,.22)'; g.lineWidth = 2;
      g.beginPath(); g.arc(cx, cy, rr * 1.05, 2.1, 5.7); g.stroke();
    }
  }
  if (type === 8) {
    g.fillStyle = 'rgba(35,24,12,.55)';
    for (let i = 0; i < 4; i++) g.fillRect(px, py + 4 + i * 8, tile, 2);
    g.fillStyle = 'rgba(255,220,160,.08)';
    g.fillRect(px + 4, py, 2, tile);
  }
  if (type === 9) {
    // large boulder: fills and overlaps the tile so clusters read as solid cover
    g.save();
    g.translate(px + 16, py + 16);
    g.scale(1.5, 1.5);
    g.fillStyle = 'rgba(0,0,0,.34)';
    g.beginPath(); g.ellipse(2, 9, 17, 8, 0, 0, 7); g.fill();
    const bx = 0, by = -1;
    g.fillStyle = '#5b5d51';
    g.beginPath();
    g.moveTo(bx - 18, by + 8);
    g.lineTo(bx - 13, by - 8);
    g.lineTo(bx - 2, by - 14);
    g.lineTo(bx + 12, by - 10);
    g.lineTo(bx + 18, by + 2);
    g.lineTo(bx + 12, by + 12);
    g.lineTo(bx - 6, by + 13);
    g.closePath(); g.fill();
    g.fillStyle = 'rgba(255,255,255,.13)';
    g.beginPath(); g.moveTo(bx - 13, by - 8); g.lineTo(bx - 2, by - 14); g.lineTo(bx + 4, by - 5); g.lineTo(bx - 6, by + 1); g.closePath(); g.fill();
    g.fillStyle = 'rgba(0,0,0,.28)';
    g.beginPath(); g.moveTo(bx + 18, by + 2); g.lineTo(bx + 12, by + 12); g.lineTo(bx - 6, by + 13); g.lineTo(bx + 2, by + 2); g.closePath(); g.fill();
    g.fillStyle = 'rgba(86,112,54,.4)';
    g.beginPath(); g.arc(bx - 9, by + 7, 4.5, 0, 7); g.fill();
    g.fillStyle = 'rgba(104,128,68,.32)';
    g.beginPath(); g.arc(bx + 8, by + 8, 3.2, 0, 7); g.fill();
    g.restore();
  }
}

/* ------------------------------------------------------------ */
/*  enterable buildings                                         */
/* ------------------------------------------------------------ */
function drawWindow(g, win, tile) {
  const px = win.x * tile, py = win.y * tile;
  const horizontal = win.side === 'n' || win.side === 's';
  const cx = px + tile / 2, cy = py + tile / 2;
  const glow = 0.34 + hash2(win.x, win.y) * 0.22;
  const lit = hash2(win.x + 7, win.y + 3) > 0.72;
  const glass = lit ? `rgba(150,124,74,${glow + 0.12})` : `rgba(112,150,168,${glow})`;
  if (horizontal) {
    // stone lintel and sill frame the opening
    g.fillStyle = 'rgba(158,146,118,.42)'; g.fillRect(px + 4, cy - 7, tile - 8, 2);
    g.fillStyle = 'rgba(198,186,152,.30)'; g.fillRect(px + 4, cy - 7, tile - 8, 1);
    g.fillStyle = 'rgba(28,24,19,.42)'; g.fillRect(px + 4, cy + 5, tile - 8, 2);
    // opening, glass and glazing bars
    g.fillStyle = 'rgba(30,26,21,.94)'; g.fillRect(px + 5, cy - 5, tile - 10, 10);
    g.fillStyle = glass; g.fillRect(px + 7, cy - 3.5, tile - 14, 7);
    g.fillStyle = lit ? 'rgba(255,224,158,.34)' : 'rgba(232,242,246,.28)';
    g.fillRect(px + 8, cy - 3, 5, 2);
    g.fillStyle = 'rgba(24,20,16,.92)'; g.fillRect(cx - 0.5, cy - 4, 1.4, 8);
    // wooden shutters folded against the wall
    g.fillStyle = 'rgba(84,62,38,.92)';
    g.fillRect(px + 1.5, cy - 4.5, 3.5, 9); g.fillRect(px + tile - 5, cy - 4.5, 3.5, 9);
    g.fillStyle = 'rgba(140,110,70,.35)';
    g.fillRect(px + 2, cy - 3.5, 2.5, 1); g.fillRect(px + tile - 4.5, cy - 3.5, 2.5, 1);
  } else {
    g.fillStyle = 'rgba(158,146,118,.42)'; g.fillRect(cx - 7, py + 4, 2, tile - 8);
    g.fillStyle = 'rgba(198,186,152,.30)'; g.fillRect(cx - 7, py + 4, 1, tile - 8);
    g.fillStyle = 'rgba(28,24,19,.42)'; g.fillRect(cx + 5, py + 4, 2, tile - 8);
    g.fillStyle = 'rgba(30,26,21,.94)'; g.fillRect(cx - 5, py + 5, 10, tile - 10);
    g.fillStyle = glass; g.fillRect(cx - 3.5, py + 7, 7, tile - 14);
    g.fillStyle = lit ? 'rgba(255,224,158,.34)' : 'rgba(232,242,246,.28)';
    g.fillRect(cx - 3, py + 8, 2, 5);
    g.fillStyle = 'rgba(24,20,16,.92)'; g.fillRect(cx - 4, cy - 0.5, 8, 1.4);
    g.fillStyle = 'rgba(84,62,38,.92)';
    g.fillRect(cx - 4.5, py + 1.5, 9, 3.5); g.fillRect(cx - 4.5, py + tile - 5, 9, 3.5);
    g.fillStyle = 'rgba(140,110,70,.35)';
    g.fillRect(cx - 3.5, py + 2, 1, 2.5); g.fillRect(cx - 3.5, py + tile - 4.5, 1, 2.5);
  }
}
function drawDoor(g, door, tile) {
  const px = door.x * tile, py = door.y * tile;
  const vertical = door.side === 'n' || door.side === 's';
  const inward = { n: 1, s: -1, e: -1, w: 1 }[door.side];
  // worn stone step outside the threshold
  g.fillStyle = 'rgba(150,140,116,.45)';
  if (door.side === 'n') g.fillRect(px + 4, py - 5, tile - 8, 5);
  if (door.side === 's') g.fillRect(px + 4, py + tile, tile - 8, 5);
  if (door.side === 'w') g.fillRect(px - 5, py + 4, 5, tile - 8);
  if (door.side === 'e') g.fillRect(px + tile, py + 4, 5, tile - 8);
  if (vertical) {
    // stone threshold and wooden sill
    g.fillStyle = 'rgba(132,118,92,.60)'; g.fillRect(px + 2, py + 9, tile - 4, 14);
    g.fillStyle = 'rgba(74,57,36,.92)'; g.fillRect(px + 5, py + 12, tile - 10, 8);
    g.fillStyle = 'rgba(218,194,150,.38)'; g.fillRect(px + 6, py + 12, tile - 12, 1.5);
    // jambs
    g.fillStyle = 'rgba(22,18,13,.95)';
    g.fillRect(px, py + 5, 4, tile - 10); g.fillRect(px + tile - 4, py + 5, 4, tile - 10);
    // open leaf folded back against the inside face
    const ly = inward > 0 ? py + tile - 8 : py + 2;
    g.fillStyle = 'rgba(82,62,39,.96)'; g.fillRect(px + 7, ly, tile - 14, 6);
    g.fillStyle = 'rgba(126,98,62,.7)'; g.fillRect(px + 8, ly + 1, tile - 16, 1.5);
    g.strokeStyle = 'rgba(38,28,17,.7)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(px + 13, ly + 0.5); g.lineTo(px + 13, ly + 5.5); g.stroke();
    g.fillStyle = '#c9a65e'; g.fillRect(px + tile - 15, ly + 2, 2, 2);
  } else {
    g.fillStyle = 'rgba(132,118,92,.60)'; g.fillRect(px + 9, py + 2, 14, tile - 4);
    g.fillStyle = 'rgba(74,57,36,.92)'; g.fillRect(px + 12, py + 5, 8, tile - 10);
    g.fillStyle = 'rgba(218,194,150,.38)'; g.fillRect(px + 12, py + 6, 1.5, tile - 12);
    g.fillStyle = 'rgba(22,18,13,.95)';
    g.fillRect(px + 5, py, tile - 10, 4); g.fillRect(px + 5, py + tile - 4, tile - 10, 4);
    const lx = inward > 0 ? px + tile - 8 : px + 2;
    g.fillStyle = 'rgba(82,62,39,.96)'; g.fillRect(lx, py + 7, 6, tile - 14);
    g.fillStyle = 'rgba(126,98,62,.7)'; g.fillRect(lx + 1, py + 8, 1.5, tile - 16);
    g.strokeStyle = 'rgba(38,28,17,.7)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(lx + 0.5, py + 13); g.lineTo(lx + 5.5, py + 13); g.stroke();
    g.fillStyle = '#c9a65e'; g.fillRect(lx + 2, py + tile - 15, 2, 2);
  }
}
function drawStructureDetail(g, st, tile) {
  const x0 = st.x * tile, y0 = st.y * tile, w = st.w * tile, h = st.h * tile;
  // cast shadow on the street outside the south and east walls
  let grd = g.createLinearGradient(0, y0 + h, 0, y0 + h + 24);
  grd.addColorStop(0, 'rgba(7,6,4,.34)'); grd.addColorStop(1, 'rgba(7,6,4,0)');
  g.fillStyle = grd; g.fillRect(x0 + 4, y0 + h, w + 20, 24);
  grd = g.createLinearGradient(x0 + w, 0, x0 + w + 22, 0);
  grd.addColorStop(0, 'rgba(7,6,4,.28)'); grd.addColorStop(1, 'rgba(7,6,4,0)');
  g.fillStyle = grd; g.fillRect(x0 + w, y0 + 4, 22, h);
  // interior shadow cast by the north and west walls
  grd = g.createLinearGradient(0, y0 + tile, 0, y0 + tile + 20);
  grd.addColorStop(0, 'rgba(8,6,5,.44)'); grd.addColorStop(1, 'rgba(8,6,5,0)');
  g.fillStyle = grd; g.fillRect(x0 + tile, y0 + tile, w - 2 * tile, 20);
  grd = g.createLinearGradient(x0 + tile, 0, x0 + tile + 18, 0);
  grd.addColorStop(0, 'rgba(8,6,5,.38)'); grd.addColorStop(1, 'rgba(8,6,5,0)');
  g.fillStyle = grd; g.fillRect(x0 + tile, y0 + tile, 18, h - 2 * tile);
  // interior rugs / rubble
  const ii = hash2(st.id, 17);
  if (ii > 0.45) {
    const rx = x0 + tile + 8 + ii * (w - 2 * tile - 30);
    const ry = y0 + tile + 8 + hash2(st.id, 23) * (h - 2 * tile - 30);
    g.fillStyle = ii > 0.72 ? 'rgba(96,44,38,.55)' : 'rgba(72,56,36,.5)';
    g.fillRect(rx, ry, 20 + ii * 10, 14 + ii * 8);
    g.strokeStyle = 'rgba(210,186,140,.22)'; g.lineWidth = 1;
    g.strokeRect(rx + 2, ry + 2, 16 + ii * 10, 10 + ii * 8);
  }
  for (const win of st.windows || []) drawWindow(g, win, tile);
  if (st.door) drawDoor(g, st.door, tile);
}

function isTrenchTile(tx, ty) {
  return S.trenches.has(ty * S.world.cols + tx);
}
function inMap(tx, ty) {
  return tx >= 0 && ty >= 0 && tx < S.world.cols && ty < S.world.rows;
}
function drawTrenchTile(g, tx, ty, tile) {
  const px = tx * tile, py = ty * tile;
  const up = isTrenchTile(tx, ty - 1), down = isTrenchTile(tx, ty + 1);
  const left = isTrenchTile(tx - 1, ty), right = isTrenchTile(tx + 1, ty);
  const verticalRun = (up || down) && !(left || right);

  // churned earth lip
  g.fillStyle = '#4a3a25';
  g.fillRect(px, py, tile, tile);
  g.fillStyle = 'rgba(124,102,64,.35)';
  g.fillRect(px + 1, py + 1, tile - 2, 2);

  // pit with a vertical gradient: dark near wall at the top, lit floor below
  const grd = g.createLinearGradient(0, py + 3, 0, py + tile - 3);
  grd.addColorStop(0, '#140f09');
  grd.addColorStop(0.42, '#241a10');
  grd.addColorStop(1, '#3b2c1a');
  g.fillStyle = grd;
  g.fillRect(px + 3, py + 3, tile - 6, tile - 6);

  // near wall + side walls
  g.fillStyle = 'rgba(0,0,0,.45)';
  g.fillRect(px + 3, py + 3, tile - 6, 4);
  g.fillStyle = 'rgba(0,0,0,.22)';
  g.fillRect(px + 3, py + 3, 3, tile - 6);
  g.fillRect(px + tile - 6, py + 3, 3, tile - 6);
  // sunlit far lip
  g.fillStyle = 'rgba(196,164,106,.18)';
  g.fillRect(px + 4, py + tile - 6, tile - 8, 2);

  // timber revetment along the walls
  g.strokeStyle = 'rgba(92,68,40,.55)'; g.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const off = 6 + i * 6;
    if (!left) { g.beginPath(); g.moveTo(px + off, py + 4); g.lineTo(px + off, py + tile - 4); g.stroke(); }
    if (!right) { g.beginPath(); g.moveTo(px + tile - off, py + 4); g.lineTo(px + tile - off, py + tile - 4); g.stroke(); }
  }

  // duckboards
  g.fillStyle = 'rgba(122,94,58,.5)';
  if (verticalRun) {
    for (let i = 0; i < 4; i++) g.fillRect(px + 8, py + 7 + i * 6, tile - 16, 2);
  } else {
    for (let i = 0; i < 4; i++) g.fillRect(px + 7 + i * 6, py + 8, 2, tile - 16);
  }

  // grit and clods on the lip
  for (let i = 0; i < 6; i++) {
    const h = hash2(tx * 5 + i, ty * 7 + i * 3);
    g.fillStyle = h > 0.5 ? 'rgba(28,20,12,.5)' : 'rgba(168,142,96,.35)';
    g.fillRect(px + 1 + h * (tile - 4), py + 1 + hash2(tx + i, ty + 2) * 3, 2, 1);
  }

  // sandbag parapets on open edges
  const bag = (x, y, w, h, k) => {
    const tones = ['#6b5d3f', '#75664a', '#5f5238', '#7d6d4e'];
    g.fillStyle = tones[k % tones.length];
    g.fillRect(x, y, w, h);
    g.fillStyle = 'rgba(190,172,128,.30)';
    g.fillRect(x + 1, y + 1, w - 2, 1);
    g.fillStyle = 'rgba(24,19,11,.55)';
    g.fillRect(x, y + h - 1, w, 1);
    g.fillStyle = 'rgba(30,24,14,.45)';
    g.fillRect(x + w - 1, y, 1, h);
  };
  if (!up) for (let i = 0; i < 4; i++) bag(px + 1 + i * 8, py, 7, 6, i + tx);
  if (!down) for (let i = 0; i < 4; i++) bag(px + 1 + i * 8, py + tile - 6, 7, 6, i + ty + 1);
  if (!left) for (let i = 0; i < 4; i++) bag(px, py + 1 + i * 8, 6, 7, i + tx + 2);
  if (!right) for (let i = 0; i < 4; i++) bag(px + tile - 6, py + 1 + i * 8, 6, 7, i + ty + 3);

  // barbed wire tufts
  if (!up && hash2(tx, ty) > 0.55) {
    g.strokeStyle = 'rgba(150,148,130,.5)'; g.lineWidth = 1;
    for (let i = 0; i < 2; i++) {
      const x = px + 6 + i * 14;
      g.beginPath(); g.moveTo(x, py - 3); g.lineTo(x + 4, py + 2); g.moveTo(x + 4, py - 3); g.lineTo(x, py + 2); g.stroke();
    }
  }
}

/* ------------------------------------------------------------ */
/*  minimap / maps                                              */
/* ------------------------------------------------------------ */
function buildMinimap() {
  if (!S.terrainCanvas) return;
  const m = document.createElement('canvas');
  m.width = 260; m.height = 182;
  const g = m.getContext('2d');
  g.drawImage(S.terrainCanvas, 0, 0, m.width, m.height);
  g.fillStyle = 'rgba(8,10,6,.18)'; g.fillRect(0, 0, m.width, m.height);
  S.minimap = m;
  const b = document.createElement('canvas');
  b.width = 1000; b.height = 700;
  const bg = b.getContext('2d');
  bg.drawImage(S.terrainCanvas, 0, 0, b.width, b.height);
  S.bigMap = b;
}
function mapX(x) { return (x / S.world.w) * 260; }
function mapY(y) { return (y / S.world.h) * 182; }

function hasRadio(side) {
  return S.buildings.some(b => b.side === side && b.kind === 'radio' && b.hp > 0);
}

function drawMinimap() {
  const c = $('minimap');
  if (!c || !S.minimap) return;
  const g = c.getContext('2d');
  g.drawImage(S.minimap, 0, 0);
  // capture points
  for (const cp of S.cps) {
    const team = TEAM[cp.owner] || TEAM.neutral;
    const x = mapX(cp.x), y = mapY(cp.y);
    g.fillStyle = 'rgba(8,10,6,.75)';
    g.beginPath(); g.arc(x, y, 6.4, 0, 7); g.fill();
    g.fillStyle = team.bright;
    g.beginPath(); g.arc(x, y, 5.2, 0, 7); g.fill();
    g.fillStyle = '#0a0c07'; g.font = 'bold 7px Consolas, monospace';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(cp.letter || '?', x, y + 0.5);
  }
  g.textBaseline = 'alphabetic';
  // buildings
  for (const b of S.buildings) {
    if (b.kind === 'sandbag') continue;
    if (b.kind === 'bridge') {
      const def = S.config.buildings.bridge || {};
      const tw = 260 / S.world.cols, th = 182 / S.world.rows;
      const bw = (b.w || def.w || 8) * tw, bh = (b.h || def.h || 2) * th;
      g.fillStyle = 'rgba(180,150,100,.85)';
      g.fillRect(mapX(b.x) - bw / 2, mapY(b.y) - bh / 2, bw, bh);
      continue;
    }
    g.fillStyle = b.side === 'red' ? 'rgba(226,87,74,.8)' : 'rgba(90,134,201,.8)';
    g.fillRect(mapX(b.x) - 1, mapY(b.y) - 1, 2, 2);
  }
  const mine = S.me ? S.me.side : null;
  // allies
  for (const p of S.players) {
    if (p.dead || !p.side) continue;
    if (p.side === mine) {
      g.fillStyle = p.id === meId() ? '#f0c469' : TEAM[p.side].bright;
      g.fillRect(mapX(p.x) - 1.2, mapY(p.y) - 1.2, 2.4, 2.4);
    }
  }
  for (const b of S.bots) {
    if (b.dead || b.side !== mine) continue;
    g.fillStyle = 'rgba(217,214,196,.55)';
    g.fillRect(mapX(b.x) - 1, mapY(b.y) - 1, 2, 2);
  }
  // enemy revealed by radio
  if (mine && hasRadio(mine)) {
    for (const p of S.players) {
      if (p.dead || p.side === mine || !p.side) continue;
      g.fillStyle = TEAM[p.side].bright;
      g.fillRect(mapX(p.x) - 1.5, mapY(p.y) - 1.5, 3, 3);
    }
    for (const b of S.bots) {
      if (b.dead || b.side === mine) continue;
      g.fillStyle = 'rgba(226,87,74,.5)';
      g.fillRect(mapX(b.x) - 1, mapY(b.y) - 1, 2, 2);
    }
  }
  // markers
  for (const mk of S.markers) {
    if (mk.side !== mine) continue;
    g.strokeStyle = mk.kind === 'order' ? '#f0c469' : '#d9d6c4';
    g.lineWidth = 1;
    g.beginPath(); g.arc(mapX(mk.x), mapY(mk.y), 3.5, 0, 7); g.stroke();
  }
  // self arrow
  if (S.me && !S.me.dead) {
    const p = myPos();
    const x = mapX(p.x), y = mapY(p.y);
    g.save(); g.translate(x, y); g.rotate(S.pred.ang || 0);
    g.fillStyle = '#f0c469';
    g.beginPath(); g.moveTo(5, 0); g.lineTo(-3, -3); g.lineTo(-2, 0); g.lineTo(-3, 3); g.closePath(); g.fill();
    g.restore();
    // view rect
    const Z = S.zoom || 1;
    const vw = (S.viewW / Z) / S.world.w * 260, vh = (S.viewH / Z) / S.world.h * 182;
    g.strokeStyle = 'rgba(240,196,105,.35)'; g.lineWidth = 1;
    g.strokeRect(x - vw / 2, y - vh / 2, vw, vh);
  }
}

function drawDeployMap() {
  const c = $('deployMap');
  if (!c || !S.terrainCanvas) return;
  const g = c.getContext('2d');
  const w = c.width, h = c.height;
  g.drawImage(S.terrainCanvas, 0, 0, w, h);
  g.fillStyle = 'rgba(8,10,6,.25)'; g.fillRect(0, 0, w, h);
  const sx = w / S.world.w, sy = h / S.world.h;
  // fronts
  for (const cp of S.cps) {
    const team = TEAM[cp.owner] || TEAM.neutral;
    const x = cp.x * sx, y = cp.y * sy;
    g.strokeStyle = team.bright; g.lineWidth = 2; g.globalAlpha = .8;
    g.beginPath(); g.arc(x, y, 16, 0, 7); g.stroke();
    g.globalAlpha = 1;
    g.fillStyle = team.bright;
    g.beginPath(); g.arc(x, y, 9, 0, 7); g.fill();
    g.fillStyle = '#0a0c07'; g.font = 'bold 10px Consolas, monospace'; g.textAlign = 'center';
    g.fillText(cp.letter || '?', x, y + 3);
    g.fillStyle = 'rgba(10,12,8,.85)';
    g.fillRect(x - 26, y + 19, 52, 13);
    g.fillStyle = '#d9d6c4'; g.font = '9px Consolas, monospace';
    g.fillText(cp.name, x, y + 29);
    g.fillStyle = team.bright; g.font = '8px Consolas, monospace';
    g.fillText(team.name, x, y + 16);
    // progress
    if (cp.progress) {
      const p = Math.abs(cp.progress) / 100;
      g.fillStyle = 'rgba(0,0,0,.7)'; g.fillRect(x - 20, y - 24, 40, 4);
      g.fillStyle = cp.progress > 0 ? TEAM.red.bright : TEAM.blue.bright;
      g.fillRect(x - 20, y - 24, 40 * p, 4);
    }
  }
  // MOBs
  for (const side of ['red', 'blue']) {
    const mob = S.war ? (side === 'red' ? S.war.redMob : S.war.blueMob) : null;
    if (!mob) continue;
    const x = mob.x * sx, y = mob.y * sy;
    g.fillStyle = TEAM[side].main;
    g.beginPath(); g.arc(x, y, 9, 0, 7); g.fill();
    g.strokeStyle = TEAM[side].bright; g.lineWidth = 2; g.stroke();
    g.fillStyle = '#e9e4cf'; g.font = 'bold 9px Consolas, monospace'; g.textAlign = 'center';
    g.fillText('MOB', x, y + 3);
  }
  g.textAlign = 'left';
}

function drawBigMap() {
  const c = $('bigMap');
  if (!c || !S.bigMap) return;
  const g = c.getContext('2d');
  const w = c.width, h = c.height;
  g.drawImage(S.bigMap, 0, 0);
  const sx = w / S.world.w, sy = h / S.world.h;
  for (const cp of S.cps) {
    const team = TEAM[cp.owner] || TEAM.neutral;
    const x = cp.x * sx, y = cp.y * sy;
    g.fillStyle = team.main + '33';
    g.beginPath(); g.arc(x, y, cp.radius * sx, 0, 7); g.fill();
    g.strokeStyle = team.bright; g.lineWidth = 2;
    g.setLineDash([4, 4]); g.beginPath(); g.arc(x, y, cp.radius * sx, 0, 7); g.stroke(); g.setLineDash([]);
    g.fillStyle = team.bright; g.beginPath(); g.arc(x, y, 11, 0, 7); g.fill();
    g.strokeStyle = 'rgba(8,10,6,.7)'; g.lineWidth = 2; g.stroke();
    g.fillStyle = '#0a0c07'; g.font = 'bold 13px Consolas, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(cp.letter || '?', x, y + 1);
    g.textBaseline = 'alphabetic';
    g.fillStyle = 'rgba(8,10,6,.8)'; g.fillRect(x - 34, y - 34, 68, 18);
    g.fillStyle = '#e9e4cf'; g.font = 'bold 11px Consolas, monospace';
    g.fillText(cp.name, x, y - 21);
    if (cp.progress) {
      const p = Math.abs(cp.progress) / 100;
      g.fillStyle = 'rgba(0,0,0,.7)'; g.fillRect(x - 26, y + 12, 52, 4);
      g.fillStyle = cp.progress > 0 ? TEAM.red.bright : TEAM.blue.bright;
      g.fillRect(x - 26, y + 12, 52 * p, 4);
    }
  }
  for (const side of ['red', 'blue']) {
    const mob = S.war ? (side === 'red' ? S.war.redMob : S.war.blueMob) : null;
    if (!mob) continue;
    const x = mob.x * sx, y = mob.y * sy;
    g.fillStyle = TEAM[side].main;
    g.beginPath(); g.arc(x, y, 10, 0, 7); g.fill();
    g.fillStyle = '#e9e4cf'; g.font = 'bold 10px Consolas, monospace'; g.textAlign = 'center';
    g.fillText('MOB', x, y + 3);
  }
  const mine = S.me ? S.me.side : null;
  for (const b of S.buildings) {
    if (b.kind !== 'bridge') continue;
    const def = S.config.buildings.bridge || {};
    const bw = (b.w || def.w || 8) * (w / S.world.cols);
    const bh = (b.h || def.h || 2) * (h / S.world.rows);
    g.fillStyle = 'rgba(180,150,100,.9)';
    g.fillRect(b.x * sx - bw / 2, b.y * sy - bh / 2, bw, bh);
  }
  for (const p of S.players) {
    if (p.dead || !p.side) continue;
    if (p.side !== mine && !(mine && hasRadio(mine))) continue;
    g.fillStyle = p.id === meId() ? '#f0c469' : TEAM[p.side].bright;
    g.fillRect(p.x * sx - 2, p.y * sy - 2, 4, 4);
  }
  for (const mk of S.markers) {
    if (mk.side !== mine) continue;
    g.strokeStyle = mk.kind === 'order' ? '#f0c469' : '#d9d6c4'; g.lineWidth = 2;
    g.beginPath(); g.arc(mk.x * sx, mk.y * sy, 6, 0, 7); g.stroke();
  }
  if (S.me && !S.me.dead) {
    const p = myPos();
    g.fillStyle = '#f0c469';
    g.beginPath(); g.arc(p.x * sx, p.y * sy, 5, 0, 7); g.fill();
  }
  g.textAlign = 'left';
}

/* ------------------------------------------------------------ */
/*  effects                                                     */
/* ------------------------------------------------------------ */
function addMuzzle(x, y, angle, side) {
  const col = side === 'red' ? '#ffc27a' : '#ffe09a';
  for (let i = 0; i < 5; i++) {
    const a = angle + (Math.random() - 0.5) * 0.7;
    const sp = 40 + Math.random() * 120;
    S.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.09 + Math.random() * 0.08, max: 0.17, size: 1.5 + Math.random() * 2, color: col, drag: 0.9 });
  }
  S.particles.push({ x, y, vx: 0, vy: 0, life: 0.05, max: 0.05, size: 9, color: 'rgba(255,220,150,.55)', drag: 1, glow: true });
}
function addImpact(x, y, kind) {
  const blood = kind === 'blood';
  for (let i = 0; i < 6; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 15 + Math.random() * 55;
    S.particles.push({
      x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: 0.25 + Math.random() * 0.35, max: 0.6, size: 1 + Math.random() * 2,
      color: blood ? (Math.random() > 0.4 ? '#8e2a22' : '#b5412f') : '#6a5a40', drag: 0.88,
    });
  }
  if (blood) {
    S.terrainCtx.fillStyle = 'rgba(90,24,18,.28)';
    S.terrainCtx.beginPath(); S.terrainCtx.arc(x, y, 4 + Math.random() * 3, 0, 7); S.terrainCtx.fill();
  }
}
function addExplosion(x, y, radius) {
  S.rings.push({ x, y, r: 6, max: radius * 1.15, life: 0.45, maxLife: 0.45, color: 'rgba(255,196,110,.8)' });
  S.rings.push({ x, y, r: 2, max: radius * 0.9, life: 0.75, maxLife: 0.75, color: 'rgba(60,50,40,.5)' });
  for (let i = 0; i < 20; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 30 + Math.random() * 150;
    S.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.3 + Math.random() * 0.7, max: 1, size: 2 + Math.random() * 4, color: Math.random() > 0.5 ? '#ffb45a' : '#5a4a36', drag: 0.9 });
  }
  for (let i = 0; i < 12; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 8 + Math.random() * 34;
    S.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1 + Math.random() * 1.6, max: 2.6, size: 8 + Math.random() * 14, color: 'rgba(56,52,44,.30)', drag: 0.96, smoke: true });
  }
}
function scorch(x, y, r) {
  if (!S.terrainCtx) return;
  const g = S.terrainCtx;
  g.save();
  g.fillStyle = 'rgba(20,16,11,.5)';
  g.beginPath(); g.arc(x, y, r * 0.55, 0, 7); g.fill();
  g.fillStyle = 'rgba(10,8,6,.4)';
  g.beginPath(); g.arc(x, y, r * 0.3, 0, 7); g.fill();
  g.strokeStyle = 'rgba(120,105,78,.22)'; g.lineWidth = 3;
  g.beginPath(); g.arc(x, y, r * 0.5, 0, 7); g.stroke();
  g.restore();
}
function addFloat(x, y, text, color) {
  if (!text) return;
  S.floats.push({ x, y, text, color: color || '#d9d6c4', life: 1.6, max: 1.6 });
}
function updateEffects(dt) {
  for (let i = S.particles.length - 1; i >= 0; i--) {
    const p = S.particles[i];
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vx *= Math.pow(p.drag || 0.9, dt * 60);
    p.vy *= Math.pow(p.drag || 0.9, dt * 60);
    if (p.smoke) p.vy -= 4 * dt;
    p.life -= dt;
    if (p.life <= 0) S.particles.splice(i, 1);
  }
  for (let i = S.rings.length - 1; i >= 0; i--) {
    const r = S.rings[i];
    r.life -= dt;
    const k = 1 - r.life / r.maxLife;
    r.r = 6 + (r.max - 6) * k;
    if (r.life <= 0) S.rings.splice(i, 1);
  }
  for (let i = S.floats.length - 1; i >= 0; i--) {
    const f = S.floats[i];
    f.y -= 14 * dt; f.life -= dt;
    if (f.life <= 0) S.floats.splice(i, 1);
  }
  S.shake *= Math.pow(0.02, dt);
  if (S.shake < 0.1) S.shake = 0;
  // factory smoke
  if (Math.random() < dt * 3) {
    for (const b of S.buildings) {
      if (b.kind === 'factory' && b.hp > 0) {
        S.particles.push({ x: b.x + 14, y: b.y - 16, vx: 4 + Math.random() * 4, vy: -12 - Math.random() * 8, life: 2.2, max: 3, size: 5 + Math.random() * 5, color: 'rgba(58,54,46,.22)', drag: 0.99, smoke: true });
      }
    }
  }
  // rain
  if (S.rain.length === 0) {
    for (let i = 0; i < 90; i++) S.rain.push({ x: Math.random() * S.viewW, y: Math.random() * S.viewH, s: 340 + Math.random() * 260, l: 8 + Math.random() * 12 });
  }
  for (const d of S.rain) {
    d.y += d.s * dt;
    d.x -= d.s * 0.18 * dt;
    if (d.y > S.viewH + 20) { d.y = -20; d.x = Math.random() * S.viewW; }
    if (d.x < -20) d.x = S.viewW + 20;
  }
}

/* ------------------------------------------------------------ */
/*  main draw                                                   */
/* Lush trees. Sprites are pre-rendered once, then blended with a bare
   branch version as the tree takes bullet/explosion damage. */
let TREE_SPRITES = null;
function treeSprites() {
  if (TREE_SPRITES) return TREE_SPRITES;
  const SIZE = 160, N = 6;
  const out = [];
  const greens = ['#1f3319', '#27411f', '#2f4d25', '#38592c', '#406334', '#487038'];
  for (let v = 0; v < N; v++) {
    let seed = 217 + v * 977;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const c = document.createElement('canvas'); c.width = c.height = SIZE;
    const g = c.getContext('2d');
    const cx = SIZE / 2, cy = SIZE / 2;

    // A real tree: rooted trunk, branching limbs and a tall, tiered crown.
    const baseY = cy + 54;
    g.lineCap = 'round';
    // roots
    g.strokeStyle = '#241a11'; g.lineWidth = 5;
    for (let i = 0; i < 5; i++) {
      const dir = i % 2 ? 1 : -1;
      g.beginPath(); g.moveTo(cx, baseY - 2);
      g.lineTo(cx + dir * (8 + rnd() * 10), baseY + 3 + rnd() * 4); g.stroke();
    }
    // trunk with bark shading
    const tw = 10 + rnd() * 5;
    const bark = g.createLinearGradient(cx - tw, 0, cx + tw, 0);
    bark.addColorStop(0, '#241a11'); bark.addColorStop(0.45, '#4b3825');
    bark.addColorStop(0.7, '#584330'); bark.addColorStop(1, '#221910');
    g.strokeStyle = bark; g.lineWidth = tw;
    g.beginPath(); g.moveTo(cx, baseY);
    g.quadraticCurveTo(cx + (rnd() - 0.5) * 8, cy + 24, cx + (rnd() - 0.5) * 10, cy - 2);
    g.stroke();
    // limbs reaching into the crown
    g.strokeStyle = '#3a2a1b';
    for (let i = 0; i < 7; i++) {
      const a = -Math.PI / 2 + (rnd() - 0.5) * 2.2;
      const len = 22 + rnd() * 24;
      g.lineWidth = 3 + rnd() * 3;
      g.beginPath(); g.moveTo(cx, cy + 8);
      g.lineTo(cx + Math.cos(a) * len, cy + 8 + Math.sin(a) * len); g.stroke();
    }
    // under-crown shade
    g.fillStyle = 'rgba(10,18,9,.3)';
    g.beginPath(); g.ellipse(cx, cy + 14, 34, 12, 0, 0, 7); g.fill();
    // tiered crown — narrow at the top, broad at the bottom
    const tiers = [
      { y: cy - 48, rx: 20, ry: 16 },
      { y: cy - 30, rx: 30, ry: 19 },
      { y: cy - 12, rx: 38, ry: 21 },
      { y: cy + 4,  rx: 32, ry: 17 },
    ];
    for (let ti = 0; ti < tiers.length; ti++) {
      const tr = tiers[ti];
      g.fillStyle = greens[Math.max(0, 2 - ti)];
      g.beginPath(); g.ellipse(cx, tr.y, tr.rx, tr.ry, 0, 0, 7); g.fill();
      for (let i = 0; i < 7; i++) {
        const a = rnd() * Math.PI * 2, rad = rnd() * tr.rx * 0.9;
        const bx = cx + Math.cos(a) * rad, by = tr.y + Math.sin(a) * rad * 0.7;
        const br = 6 + rnd() * 9;
        g.fillStyle = greens[Math.min(5, 1 + Math.floor(rnd() * 4) + (ti === 0 ? 1 : 0))];
        g.beginPath(); g.arc(bx, by, br, 0, 7); g.fill();
      }
    }
    // dappled sunlight
    for (let i = 0; i < 26; i++) {
      const a = rnd() * Math.PI * 2, rad = rnd() * 40;
      const bx = cx + Math.cos(a) * rad, by = cy - 20 + Math.sin(a) * rad * 0.75;
      g.fillStyle = `rgba(152,198,106,${(0.06 + rnd() * 0.16).toFixed(2)})`;
      g.beginPath(); g.arc(bx, by, 1.4 + rnd() * 3.6, 0, 7); g.fill();
    }
    // dark rim at the bottom of the crown
    g.fillStyle = 'rgba(12,20,10,.35)';
    g.beginPath(); g.ellipse(cx, cy + 30, 42, 12, 0, 0, 7); g.fill();

    const b = document.createElement('canvas'); b.width = b.height = SIZE;
    const bg = b.getContext('2d');
    bg.lineCap = 'round'; bg.strokeStyle = '#3c2c1d';
    // trunk
    bg.lineWidth = 9; bg.beginPath(); bg.moveTo(cx, cy + 44); bg.lineTo(cx, cy + 2); bg.stroke();
    bg.strokeStyle = '#4a3826';
    // primary limbs, then secondary twigs
    const limbAngle = [];
    for (let i = 0; i < 8; i++) {
      const a = -Math.PI / 2 + (rnd() - 0.5) * 2.4;
      limbAngle.push(a);
      const len = 26 + rnd() * 30;
      const mx = cx + Math.cos(a) * len * 0.55, my = cy - 2 + Math.sin(a) * len * 0.55;
      const ex = cx + Math.cos(a) * len, ey = cy - 2 + Math.sin(a) * len;
      bg.lineWidth = 5;
      bg.beginPath(); bg.moveTo(cx, cy + 2); bg.lineTo(mx, my); bg.lineTo(ex, ey); bg.stroke();
      bg.lineWidth = 2.4;
      for (let j = 0; j < 3; j++) {
        const aa = a + (rnd() - 0.5) * 1.35;
        const tl = 9 + rnd() * 17;
        const bxs = mx + (ex - mx) * (0.25 + rnd() * 0.65);
        const bys = my + (ey - my) * (0.25 + rnd() * 0.65);
        bg.beginPath(); bg.moveTo(bxs, bys);
        bg.lineTo(bxs + Math.cos(aa) * tl, bys + Math.sin(aa) * tl); bg.stroke();
      }
    }
    // snapped stubs around the crown
    bg.strokeStyle = '#2f2217'; bg.lineWidth = 3;
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (rnd() - 0.5) * 2.8;
      const len = 10 + rnd() * 16;
      bg.beginPath(); bg.moveTo(cx, cy - 2); bg.lineTo(cx + Math.cos(a) * len, cy - 2 + Math.sin(a) * len); bg.stroke();
    }
    out.push({ lush: c, bare: b });
  }
  TREE_SPRITES = out;
  return out;
}

function drawTrees(g, inView, front, refY) {
  if (!S.trees || !S.trees.length) return;
  const sprites = treeSprites();
  for (const t of S.trees) {
    const r = t.r || 24;
    if (!inView(t.x, t.y, r + 70)) continue;
    // Split the stand around the local soldier's depth line: crowns south of
    // him are drawn in the foreground, crowns north of him behind the troops.
    if (front != null && (t.y > refY) !== front) continue;
    const maxHp = t.maxHp || 100;
    const dmg = 1 - clamp((t.hp == null ? maxHp : t.hp) / maxHp, 0, 1);

    // ground shadow
    g.fillStyle = 'rgba(6,10,5,.19)';
    g.beginPath(); g.ellipse(t.x + r * 0.14, t.y + r * 0.46, r * 1.02, r * 0.34, 0, 0, 7); g.fill();

    const sp = sprites[t.id % sprites.length];
    const scale = r / 58;
    const w = 160 * scale;
    // root the trunk at the tree's world position and let the crown rise above
    const x = t.x - w / 2, y = t.y + r * 0.1 - w * 0.8375;

    const lushA = clamp(1 - dmg * 1.7, 0, 1);
    if (lushA > 0.02) {
      g.globalAlpha = lushA;
      g.drawImage(sp.lush, x, y, w, w);
    }
    const bareA = clamp((dmg - 0.22) * 1.7, 0, 1);
    if (bareA > 0.02) {
      g.globalAlpha = bareA;
      g.drawImage(sp.bare, x, y, w, w);
    }
    g.globalAlpha = 1;
  }
}

/* Low scrub — the old round canopy look, now used for bushes only. */
let BUSH_SPRITES = null;
function bushSprites() {
  if (BUSH_SPRITES) return BUSH_SPRITES;
  const SIZE = 96, N = 5;
  const out = [];
  const greens = ['#63853a', '#739843', '#84ab4d', '#95bd59', '#a7cd67', '#b9dc79'];
  for (let v = 0; v < N; v++) {
    let seed = 433 + v * 811;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const c = document.createElement('canvas'); c.width = c.height = SIZE;
    const g = c.getContext('2d');
    const cx = SIZE / 2, cy = SIZE * 0.58;
    // dark base clump
    for (let i = 0; i < 12; i++) {
      const a = rnd() * Math.PI * 2, rad = rnd() * 20;
      const bx = cx + Math.cos(a) * rad, by = cy + Math.sin(a) * rad * 0.55;
      const br = 9 + rnd() * 10;
      g.fillStyle = greens[Math.floor(rnd() * 3)];
      g.beginPath(); g.arc(bx, by, br, 0, 7); g.fill();
    }
    // lit top
    for (let i = 0; i < 10; i++) {
      const a = rnd() * Math.PI * 2, rad = rnd() * 16;
      const bx = cx + Math.cos(a) * rad, by = cy - 5 + Math.sin(a) * rad * 0.5;
      const br = 5 + rnd() * 8;
      g.fillStyle = greens[2 + Math.floor(rnd() * 4)];
      g.beginPath(); g.arc(bx, by, br, 0, 7); g.fill();
    }
    for (let i = 0; i < 14; i++) {
      const a = rnd() * Math.PI * 2, rad = rnd() * 22;
      g.fillStyle = `rgba(205,235,140,${(0.06 + rnd() * 0.14).toFixed(2)})`;
      g.beginPath(); g.arc(cx + Math.cos(a) * rad, cy - 4 + Math.sin(a) * rad * 0.55, 1 + rnd() * 2.4, 0, 7); g.fill();
    }
    out.push(c);
  }
  BUSH_SPRITES = out;
  return out;
}

function drawBushes(g, inView) {
  if (!S.bushes || !S.bushes.length) return;
  const sprites = bushSprites();
  for (const b of S.bushes) {
    const r = b.r || 16;
    if (!inView(b.x, b.y, r + 30)) continue;
    const w = r * 3.2;
    const sp = sprites[b.id % sprites.length];
    g.fillStyle = 'rgba(6,10,5,.2)';
    g.beginPath(); g.ellipse(b.x, b.y + 3, w * 0.34, w * 0.12, 0, 0, 7); g.fill();
    g.drawImage(sp, b.x - w / 2, b.y - w * 0.62, w, w);
  }
}

/* Smart roofs: a roof is drawn over every intact house, but it fades out
   when the local soldier is inside so the interior stays readable. */
const ROOF_STYLES = [
  { a: '#9a6644', b: '#7a4a31', c: '#5b3422', d: '#3a2015', eave: '#2a1e16', ridge: '#a87f5a' },
  { a: '#7a878b', b: '#5c686c', c: '#414b4f', d: '#2b3336', eave: '#1e2528', ridge: '#8d9a9e' },
  { a: '#988252', b: '#7a673e', c: '#5b4b2b', d: '#3d311c', eave: '#292216', ridge: '#a8905e' },
];

function drawRoof(g, st, x0, y0, w, h, alpha) {
  const pal = ROOF_STYLES[(st.style || 0) % ROOF_STYLES.length];
  const e = 6;
  const rx = x0 - e, ry = y0 - e, rw = w + e * 2, rh = h + e * 2;
  // cast shadow on the street
  g.fillStyle = 'rgba(4,4,3,.34)';
  g.fillRect(rx + 8, ry + 10, rw, rh);
  // eaves fascia
  g.fillStyle = pal.eave;
  g.fillRect(rx, ry, rw, rh);
  g.fillStyle = 'rgba(255,238,200,.12)';
  g.fillRect(rx, ry, rw, 2);
  const sx = rx + 3, sy = ry + 3, sw = rw - 6, sh = rh - 6;
  const horiz = st.ridge === 'x';
  // two pitched planes, lit from the north-west
  if (horiz) {
    const mid = sy + sh / 2;
    let grd = g.createLinearGradient(0, sy, 0, mid);
    grd.addColorStop(0, pal.c); grd.addColorStop(1, pal.a);
    g.fillStyle = grd; g.fillRect(sx, sy, sw, sh / 2);
    grd = g.createLinearGradient(0, mid, 0, sy + sh);
    grd.addColorStop(0, pal.b); grd.addColorStop(1, pal.d);
    g.fillStyle = grd; g.fillRect(sx, mid, sw, sh / 2);
  } else {
    const mid = sx + sw / 2;
    let grd = g.createLinearGradient(sx, 0, mid, 0);
    grd.addColorStop(0, pal.a); grd.addColorStop(1, pal.c);
    g.fillStyle = grd; g.fillRect(sx, sy, sw / 2, sh);
    grd = g.createLinearGradient(mid, 0, sx + sw, 0);
    grd.addColorStop(0, pal.b); grd.addColorStop(1, pal.d);
    g.fillStyle = grd; g.fillRect(mid, sy, sw / 2, sh);
  }
  g.save();
  g.beginPath(); g.rect(sx, sy, sw, sh); g.clip();
  // shingle courses
  if (horiz) {
    let row = 0;
    for (let y = sy; y < sy + sh; y += 7, row++) {
      g.fillStyle = row & 1 ? 'rgba(255,240,208,.035)' : 'rgba(10,6,4,.05)';
      g.fillRect(sx, y, sw, Math.min(7, sy + sh - y));
      g.fillStyle = 'rgba(18,11,7,.26)'; g.fillRect(sx, y, sw, 1);
      for (let x = sx + (row & 1 ? 7 : 0); x < sx + sw; x += 14) {
        const t = hash2(st.id * 7 + Math.floor((x - sx) / 14), st.id * 3 + row);
        if (t > 0.84) { g.fillStyle = 'rgba(12,8,5,.16)'; g.fillRect(x, y + 1, 12, 5); }
        else if (t < 0.12) { g.fillStyle = 'rgba(255,244,214,.05)'; g.fillRect(x, y + 1, 12, 5); }
        g.fillStyle = 'rgba(255,236,202,.06)'; g.fillRect(x, y + 1, 11, 1.5);
        g.fillStyle = 'rgba(20,12,8,.12)'; g.fillRect(x, y + 5, 11, 1);
      }
    }
  } else {
    let col = 0;
    for (let x = sx; x < sx + sw; x += 7, col++) {
      g.fillStyle = col & 1 ? 'rgba(255,240,208,.035)' : 'rgba(10,6,4,.05)';
      g.fillRect(x, sy, Math.min(7, sx + sw - x), sh);
      g.fillStyle = 'rgba(18,11,7,.26)'; g.fillRect(x, sy, 1, sh);
      for (let y = sy + (col & 1 ? 7 : 0); y < sy + sh; y += 14) {
        const t = hash2(st.id * 3 + col, st.id * 7 + Math.floor((y - sy) / 14));
        if (t > 0.84) { g.fillStyle = 'rgba(12,8,5,.16)'; g.fillRect(x + 1, y, 5, 12); }
        else if (t < 0.12) { g.fillStyle = 'rgba(255,244,214,.05)'; g.fillRect(x + 1, y, 5, 12); }
        g.fillStyle = 'rgba(255,236,202,.06)'; g.fillRect(x + 1, y, 1.5, 11);
        g.fillStyle = 'rgba(20,12,8,.12)'; g.fillRect(x + 5, y, 1, 11);
      }
    }
  }
  // ridge shadow and capstone
  if (horiz) {
    const mid = sy + sh / 2;
    g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(sx, mid + 3, sw, 5);
    g.fillStyle = pal.ridge; g.fillRect(sx, mid - 3, sw, 6);
    g.fillStyle = 'rgba(255,244,214,.10)'; g.fillRect(sx, mid - 3, sw, 1.5);
    g.fillStyle = 'rgba(0,0,0,.16)'; g.fillRect(sx, mid + 2, sw, 1);
  } else {
    const mid = sx + sw / 2;
    g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(mid + 3, sy, 5, sh);
    g.fillStyle = pal.ridge; g.fillRect(mid - 3, sy, 6, sh);
    g.fillStyle = 'rgba(255,244,214,.10)'; g.fillRect(mid - 3, sy, 1.5, sh);
    g.fillStyle = 'rgba(0,0,0,.16)'; g.fillRect(mid + 2, sy, 1, sh);
  }
  // eave lip
  g.fillStyle = 'rgba(255,240,205,.10)';
  g.fillRect(sx, sy, sw, 2);
  g.fillRect(sx, sy + sh - 2, sw, 2);
  g.fillRect(sx, sy, 2, sh);
  g.fillRect(sx + sw - 2, sy, 2, sh);
  // moss / damp patches
  for (let i = 0; i < 5; i++) {
    const mx = sx + 6 + hash2(st.id * 3 + i, 5) * (sw - 12);
    const my = sy + 6 + hash2(st.id * 5 + i, 9) * (sh - 12);
    g.fillStyle = `rgba(88,106,60,${(0.08 + hash2(st.id, i) * 0.12).toFixed(2)})`;
    g.beginPath(); g.ellipse(mx, my, 6 + hash2(i, st.id) * 9, 4 + hash2(i, st.id + 1) * 6, 0, 0, 7); g.fill();
  }
  // collapsed roof holes with charred beams
  if (st.damaged) {
    for (let i = 0; i < 2; i++) {
      if (hash2(st.id + i, 31) < 0.3) continue;
      const hx = sx + 10 + hash2(st.id + i, 41) * (sw - 32);
      const hy = sy + 10 + hash2(st.id + i, 43) * (sh - 32);
      const hr = 7 + hash2(st.id + i, 47) * 8;
      g.fillStyle = 'rgba(8,6,4,.88)';
      g.beginPath(); g.ellipse(hx, hy, hr * 1.3, hr, hash2(i, 2) * 3, 0, 7); g.fill();
      g.strokeStyle = 'rgba(62,42,25,.85)'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(hx - hr, hy + hr * 0.5); g.lineTo(hx + hr, hy - hr * 0.4); g.stroke();
      g.strokeStyle = 'rgba(22,16,11,.85)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(hx - hr * 0.6, hy - hr); g.lineTo(hx + hr * 0.3, hy + hr * 0.8); g.stroke();
      g.strokeStyle = 'rgba(255,224,176,.16)'; g.lineWidth = 1;
      g.beginPath(); g.ellipse(hx, hy, hr * 1.4, hr * 1.12, 0, 0, 7); g.stroke();
    }
  }
  g.restore();
  // chimney stack
  if (st.chimney) {
    const chx = rx + rw * (0.2 + hash2(st.id, 3) * 0.55);
    const chy = ry + rh * (0.2 + hash2(st.id, 7) * 0.5);
    g.fillStyle = 'rgba(5,4,3,.4)'; g.fillRect(chx + 5, chy + 6, 14, 16);
    g.fillStyle = '#514a3b'; g.fillRect(chx, chy, 14, 16);
    for (let r = 0; r < 3; r++) {
      g.fillStyle = r & 1 ? '#5e5646' : '#665e4c';
      g.fillRect(chx + 1, chy + 2 + r * 4, 12, 3);
    }
    g.fillStyle = '#7b7160'; g.fillRect(chx - 1, chy - 3, 16, 4);
    g.fillStyle = '#2a241c'; g.fillRect(chx + 3, chy - 4, 8, 3);
    g.fillStyle = 'rgba(255,240,205,.18)'; g.fillRect(chx - 1, chy - 3, 16, 1);
  }
  // eave trim
  g.strokeStyle = 'rgba(14,10,7,.65)'; g.lineWidth = 1.5;
  g.strokeRect(rx + 1, ry + 1, rw - 2, rh - 2);
  if (alpha < 0.35) {
    g.strokeStyle = 'rgba(230,214,178,.22)'; g.lineWidth = 1;
    g.setLineDash([7, 6]);
    g.strokeRect(x0 + 1, y0 + 1, w - 2, h - 2);
    g.setLineDash([]);
  }
}

function drawCityRoofs(g, inView, dt) {
  const list = S.structures;
  if (!list || !list.length) return;
  const me = (S.deployed && S.me && !S.me.dead) ? myPos() : null;
  const tile = S.world.tile;
  for (const st of list) {
    const x0 = st.x * tile, y0 = st.y * tile, w = st.w * tile, h = st.h * tile;
    if (!inView(x0 + w / 2, y0 + h / 2, Math.max(w, h) * 0.7 + 90)) continue;
    const inside = me && me.x > x0 - 20 && me.x < x0 + w + 20 && me.y > y0 - 20 && me.y < y0 + h + 20;
    const target = inside ? 0.13 : 1;
    const k = 1 - Math.pow(0.0012, dt);
    st._roofA = st._roofA == null ? target : st._roofA + (target - st._roofA) * k;
    if (st._roofA < 0.035) continue;
    g.save();
    g.globalAlpha = st._roofA;
    drawRoof(g, st, x0, y0, w, h, st._roofA);
    g.restore();
  }
}

/* ------------------------------------------------------------ */
function drawFrame(now) {
  const dt = S.lastFrame ? Math.min(0.05, (now - S.lastFrame) / 1000) : 0.016;
  S.lastFrame = now;
  if (!S.initialized) { ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.fillStyle = '#0c0e09'; ctx.fillRect(0, 0, S.viewW, S.viewH); return; }
  updateEffects(dt);
  // interpolation
  for (const arr of [S.render.players, S.render.bots, S.render.vehicles]) {
    for (const r of arr.values()) {
      const k = 1 - Math.pow(0.0025, dt);
      r.x = lerp(r.x, r.tx, k); r.y = lerp(r.y, r.ty, k);
      let da = (r.ta || 0) - (r.a || 0);
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      r.a = (r.a || 0) + da * k;
    }
  }
  // camera
  const Z = S.zoom || 1;
  const vw = S.viewW / Z, vh = S.viewH / Z;
  if (S.deployed && S.me) {
    const p = S.me.dead ? { x: S.me.x, y: S.me.y } : myPos();
    const tx = clamp(p.x - vw / 2, 0, Math.max(0, S.world.w - vw));
    const ty = clamp(p.y - vh / 2, 0, Math.max(0, S.world.h - vh));
    S.cam.x = lerp(S.cam.x, tx, 1 - Math.pow(0.001, dt));
    S.cam.y = lerp(S.cam.y, ty, 1 - Math.pow(0.001, dt));
  } else {
    // cinematic pan
    S.menuT += dt;
    const cx = S.world.w * 0.5 + Math.sin(S.menuT * 0.055) * S.world.w * 0.22;
    const cy = S.world.h * 0.5 + Math.cos(S.menuT * 0.041) * S.world.h * 0.16;
    S.cam.x = clamp(cx - vw / 2, 0, Math.max(0, S.world.w - vw));
    S.cam.y = clamp(cy - vh / 2, 0, Math.max(0, S.world.h - vh));
  }
  S.mouseWorld = { x: S.cam.x + S.mouse.x / Z, y: S.cam.y + S.mouse.y / Z };
  updatePrediction(dt);
  updateEngineAudio(dt);
  updateFootsteps(dt);

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#1a2015'; ctx.fillRect(0, 0, S.viewW, S.viewH);

  const shx = S.shake ? (Math.random() - 0.5) * S.shake * 2 : 0;
  const shy = S.shake ? (Math.random() - 0.5) * S.shake * 2 : 0;
  ctx.save();
  ctx.translate(-S.cam.x * Z + shx, -S.cam.y * Z + shy);
  ctx.scale(Z, Z);

  // terrain crop
  const cx0 = clamp(Math.floor(S.cam.x) - 40, 0, S.world.w);
  const cy0 = clamp(Math.floor(S.cam.y) - 40, 0, S.world.h);
  const cw = Math.min(S.world.w - cx0, Math.ceil(vw) + 80);
  const ch = Math.min(S.world.h - cy0, Math.ceil(vh) + 80);
  ctx.drawImage(S.terrainCanvas, cx0, cy0, cw, ch, cx0, cy0, cw, ch);

  const view = { x0: S.cam.x - 80, y0: S.cam.y - 80, x1: S.cam.x + vw + 80, y1: S.cam.y + vh + 80 };
  const inView = (x, y, m = 40) => x > view.x0 - m && x < view.x1 + m && y > view.y0 - m && y < view.y1 + m;

  drawCaptureZones(ctx, now, inView);
  drawResources(ctx, inView);
  drawDrops(ctx, inView);
  drawCorpses(ctx);
  const treeRefY = (S.deployed && S.me && !S.me.dead) ? myPos().y : S.cam.y + vh / 2;
  drawTrees(ctx, inView, false, treeRefY);
  drawBuildings(ctx, inView);
  drawVehicles(ctx, inView);
  drawMarkersWorld(ctx, inView, now);
  drawBots(ctx, now, inView);
  drawPlayers(ctx, now, inView);
  drawBushes(ctx, inView);
  drawTrees(ctx, inView, true, treeRefY);
  drawCityRoofs(ctx, inView, dt);
  drawProjectiles(ctx, now, inView);
  drawEffects(ctx);
  drawPlacementGhost(ctx);

  ctx.restore();

  // screen-space weather + cinematic shade
  drawWeather(ctx);
  if (!S.deployed) {
    ctx.fillStyle = 'rgba(8,10,6,.35)'; ctx.fillRect(0, 0, S.viewW, S.viewH);
  }
  updateCrosshair();
}

/* ------------------------------------------------------------ */
/*  world drawing                                               */
/* ------------------------------------------------------------ */
const RES_COLORS = { scrap: '#cfcabb', fuel: '#e8ad42', ammo: '#a3d06a' };
function resIcon(g, type, x, y, s) {
  g.fillStyle = RES_COLORS[type] || '#ccc';
  if (type === 'scrap') {
    g.fillRect(x - s * 0.5, y - s * 0.4, s, s * 0.8);
    g.fillStyle = 'rgba(0,0,0,.35)';
    g.fillRect(x - s * 0.15, y - s * 0.15, s * 0.3, s * 0.3);
  } else if (type === 'fuel') {
    g.beginPath(); g.arc(x, y, s * 0.5, 0, 7); g.fill();
    g.fillStyle = 'rgba(0,0,0,.4)';
    g.fillRect(x - s * 0.12, y - s * 0.45, s * 0.24, s * 0.35);
  } else {
    g.fillRect(x - s * 0.55, y - s * 0.3, s * 1.1, s * 0.6);
    g.fillStyle = 'rgba(0,0,0,.35)';
    g.fillRect(x - s * 0.1, y - s * 0.3, s * 0.2, s * 0.6);
  }
}
function drawStockPips(g, stock, cx, y) {
  const items = [['scrap', Math.floor(stock.scrap || 0)], ['fuel', Math.floor(stock.fuel || 0)], ['ammo', Math.floor(stock.ammo || 0)]];
  g.save();
  g.font = 'bold 8px Consolas, monospace';
  g.textAlign = 'left';
  const step = 52;
  let x = cx - (step * items.length) / 2 + 6;
  for (const [type, val] of items) {
    g.fillStyle = 'rgba(8,10,6,.62)';
    g.fillRect(x - 9, y - 8, step - 2, 12);
    resIcon(g, type, x, y - 2, 7);
    g.fillStyle = RES_COLORS[type];
    g.fillText(String(val), x + 6, y + 1);
    x += step;
  }
  g.restore();
}
function drawCaptureZones(g, now, inView) {
  for (const cp of S.cps) {
    if (!inView(cp.x, cp.y, cp.radius + 60)) continue;
    const team = TEAM[cp.owner] || TEAM.neutral;
    g.save();
    g.globalAlpha = 0.10;
    g.fillStyle = team.main;
    g.beginPath(); g.arc(cp.x, cp.y, cp.radius, 0, 7); g.fill();
    g.globalAlpha = 0.45;
    g.strokeStyle = team.bright; g.lineWidth = 2; g.setLineDash([10, 9]);
    g.beginPath(); g.arc(cp.x, cp.y, cp.radius, 0, 7); g.stroke();
    g.setLineDash([]);
    g.restore();

    // flag
    const wave = Math.sin(now / 260 + cp.x) * 3;
    g.strokeStyle = '#2b2419'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(cp.x, cp.y + 6); g.lineTo(cp.x, cp.y - 58); g.stroke();
    g.fillStyle = team.bright;
    g.beginPath();
    g.moveTo(cp.x, cp.y - 58);
    g.lineTo(cp.x + 26, cp.y - 54 + wave);
    g.lineTo(cp.x + 22, cp.y - 44 + wave);
    g.lineTo(cp.x, cp.y - 47);
    g.closePath(); g.fill();
    g.fillStyle = 'rgba(0,0,0,.35)';
    g.beginPath(); g.moveTo(cp.x, cp.y - 47); g.lineTo(cp.x + 22, cp.y - 44 + wave); g.lineTo(cp.x + 20, cp.y - 40 + wave); g.lineTo(cp.x, cp.y - 42); g.closePath(); g.fill();

    // nameplate
    g.textAlign = 'center';
    g.font = 'bold 12px Consolas, monospace';
    g.fillStyle = 'rgba(8,10,6,.75)';
    g.fillRect(cp.x - 52, cp.y + 54, 104, 30);
    g.fillStyle = team.bright;
    g.fillText(`${cp.letter ? cp.letter + ' · ' : ''}${cp.name}`, cp.x, cp.y + 67);
    g.font = '9px Consolas, monospace';
    g.fillStyle = '#b9b6a2';
    g.fillText(team.name + ' SECTOR', cp.x, cp.y + 79);

    if (cp.progress && Math.abs(cp.progress) > 1) {
      const p = Math.abs(cp.progress) / 100;
      g.fillStyle = 'rgba(0,0,0,.8)';
      g.fillRect(cp.x - 44, cp.y + 86, 88, 7);
      g.fillStyle = cp.progress > 0 ? TEAM.red.bright : TEAM.blue.bright;
      if (cp.progress > 0) g.fillRect(cp.x - 44, cp.y + 86, 88 * p, 7);
      else g.fillRect(cp.x + 44 - 88 * p, cp.y + 86, 88 * p, 7);
    }
    if (cp.contesting === 'both') {
      g.fillStyle = '#f0c469'; g.font = 'bold 10px Consolas, monospace';
      g.fillText('CONTESTED', cp.x, cp.y - 70);
    }
    if (cp.stock) drawStockPips(g, cp.stock, cp.x, cp.y + 102);
  }
  // MOB markers
  if (S.war) {
    for (const side of ['red', 'blue']) {
      const mob = side === 'red' ? S.war.redMob : S.war.blueMob;
      if (!inView(mob.x, mob.y, 100)) continue;
      const team = TEAM[side];
      g.save();
      g.globalAlpha = .14; g.fillStyle = team.main;
      g.beginPath(); g.arc(mob.x, mob.y, 90, 0, 7); g.fill();
      g.restore();
      g.strokeStyle = team.bright; g.lineWidth = 3; g.setLineDash([6, 6]);
      g.beginPath(); g.arc(mob.x, mob.y, 78, 0, 7); g.stroke(); g.setLineDash([]);
      // HQ building
      g.fillStyle = '#2a2418'; g.fillRect(mob.x - 34, mob.y - 26, 68, 52);
      g.fillStyle = team.dark; g.fillRect(mob.x - 30, mob.y - 22, 60, 44);
      g.fillStyle = team.main; g.fillRect(mob.x - 30, mob.y - 22, 60, 7);
      g.fillStyle = '#14110b'; g.fillRect(mob.x - 10, mob.y - 2, 20, 24);
      g.fillStyle = team.bright; g.font = 'bold 11px Consolas, monospace'; g.textAlign = 'center';
      g.fillText(sideName(side) + ' MOB', mob.x, mob.y - 36);
      // hp
      g.fillStyle = 'rgba(0,0,0,.7)'; g.fillRect(mob.x - 40, mob.y + 34, 80, 7);
      g.fillStyle = team.bright; g.fillRect(mob.x - 40, mob.y + 34, 80 * (mob.hp / mob.maxHp), 7);
      if (mob.stock) drawStockPips(g, mob.stock, mob.x, mob.y + 55);
    }
  }
}

function drawResources(g, inView) {
  for (const r of S.resources) {
    if (!inView(r.x, r.y)) continue;
    if (r.amount <= 0) continue;
    g.save();
    g.translate(r.x, r.y);
    g.fillStyle = 'rgba(0,0,0,.3)';
    g.beginPath(); g.ellipse(2, 7, 16, 6, 0, 0, 7); g.fill();
    if (r.type === 'scrap') {
      g.fillStyle = '#6d7069';
      g.fillRect(-12, -4, 20, 10);
      g.fillStyle = '#878b82'; g.fillRect(-9, -8, 14, 7);
      g.fillStyle = '#55584f'; g.fillRect(3, -9, 8, 6);
      g.strokeStyle = '#3e403a'; g.lineWidth = 1; g.strokeRect(-12, -4, 20, 10);
    } else if (r.type === 'fuel') {
      g.fillStyle = '#5a4a24'; g.fillRect(-11, -10, 10, 16); g.fillRect(2, -8, 10, 15);
      g.fillStyle = '#8a7436'; g.fillRect(-10, -12, 8, 3); g.fillRect(3, -10, 8, 3);
      g.fillStyle = '#d9a441'; g.fillRect(-8, -6, 4, 4);
    } else {
      g.fillStyle = '#5e5130'; g.fillRect(-13, -8, 26, 16);
      g.fillStyle = '#87733d'; g.fillRect(-13, -8, 26, 3);
      g.strokeStyle = '#3d3420'; g.strokeRect(-13, -8, 26, 16);
      g.fillStyle = '#c9a24a'; g.fillRect(-3, -3, 6, 8);
    }
    // amount ring
    const p = r.amount / (r.max || 600);
    g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 3;
    g.beginPath(); g.arc(0, 0, 18, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2); g.stroke();
    g.strokeStyle = r.type === 'scrap' ? '#a8ab9f' : r.type === 'fuel' ? '#d9a441' : '#7f9d54';
    g.beginPath(); g.arc(0, 0, 18, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p); g.stroke();
    g.fillStyle = 'rgba(10,12,8,.7)'; g.font = '8px Consolas, monospace'; g.textAlign = 'center';
    g.fillText(r.type.toUpperCase(), 0, -22);
    g.restore();
  }
}

function drawDrops(g, inView) {
  const now = performance.now();
  for (const d of (S.drops || [])) {
    if (!inView(d.x, d.y, 40)) continue;
    const bob = Math.sin(now / 420 + d.id) * 1.5;
    g.save();
    g.translate(d.x, d.y + bob);
    g.fillStyle = 'rgba(0,0,0,.34)';
    g.beginPath(); g.ellipse(1, 9, 17, 6, 0, 0, 7); g.fill();
    // canvas satchel with a strap
    g.fillStyle = '#5c5136';
    g.beginPath();
    g.moveTo(-14, -9); g.lineTo(13, -6); g.lineTo(15, 8); g.lineTo(-12, 10); g.closePath(); g.fill();
    g.strokeStyle = '#8a7a50'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(-9, -9); g.lineTo(-3, 9); g.stroke();
    g.fillStyle = '#3e3624'; g.fillRect(-2, -10, 7, 5);
    // resource swatches
    const cols = [['scrap', '#c8c3b2'], ['fuel', '#e0a63a'], ['ammo', '#9fce66']];
    let i = 0;
    for (const [k, col] of cols) {
      if ((d[k] || 0) <= 0) continue;
      g.fillStyle = col;
      g.beginPath(); g.arc(-8 + i * 8, 2, 3, 0, 7); g.fill();
      i++;
    }
    g.strokeStyle = 'rgba(240,222,160,.55)'; g.lineWidth = 1;
    g.strokeRect(-15, -10, 31, 21);
    g.restore();
  }
}

function drawBuildings(g, inView) {
  for (const b of S.buildings) {
    if (b.hp <= 0 || !inView(b.x, b.y, 60)) continue;
    const team = TEAM[b.side] || TEAM.neutral;
    g.save();
    g.translate(b.x, b.y);
    g.fillStyle = 'rgba(0,0,0,.32)';
    g.beginPath(); g.ellipse(2, 10, 26, 9, 0, 0, 7); g.fill();
    if (b.kind === 'bridge') {
      const def = S.config.buildings.bridge || {};
      const bw = (b.w || def.w || 8) * S.world.tile;
      const bh = (b.h || def.h || 2) * S.world.tile;
      g.fillStyle = 'rgba(0,0,0,.4)';
      g.fillRect(-bw / 2 + 6, -bh / 2 + 7, bw, bh);
      g.fillStyle = '#3a2d1c';
      g.fillRect(-bw / 2, -bh / 2, bw, bh);
      g.fillStyle = '#6a5333';
      g.fillRect(-bw / 2 + 3, -bh / 2 + 3, bw - 6, bh - 6);
      g.strokeStyle = 'rgba(34,24,12,.75)'; g.lineWidth = 2;
      if (bw >= bh) {
        for (let x = -bw / 2 + 10; x < bw / 2 - 5; x += 12) {
          g.beginPath(); g.moveTo(x, -bh / 2 + 4); g.lineTo(x, bh / 2 - 4); g.stroke();
        }
        g.fillStyle = '#4b3a22';
        g.fillRect(-bw / 2, -bh / 2, 4, bh);
        g.fillRect(bw / 2 - 4, -bh / 2, 4, bh);
      } else {
        for (let y = -bh / 2 + 10; y < bh / 2 - 5; y += 12) {
          g.beginPath(); g.moveTo(-bw / 2 + 4, y); g.lineTo(bw / 2 - 4, y); g.stroke();
        }
        g.fillStyle = '#4b3a22';
        g.fillRect(-bw / 2, -bh / 2, bw, 4);
        g.fillRect(-bw / 2, bh / 2 - 4, bw, 4);
      }
      g.fillStyle = team.main;
      g.fillRect(-bw / 2, -bh / 2, 6, bh);
      g.fillRect(bw / 2 - 6, -bh / 2, 6, bh);
    } else if (b.kind === 'sandbag') {
      g.fillStyle = '#6f6041';
      for (let row = 0; row < 2; row++) {
        for (let i = 0; i < 3; i++) {
          g.fillRect(-17 + i * 12 + (row ? 6 : 0), -6 + row * 7, 11, 6);
        }
      }
      g.fillStyle = '#877650';
      for (let i = 0; i < 3; i++) g.fillRect(-17 + i * 12, -6, 9, 2);
    } else if (b.kind === 'bunker') {
      g.fillStyle = '#3f4136'; g.fillRect(-24, -18, 48, 36);
      g.fillStyle = '#55584a'; g.fillRect(-20, -22, 40, 12);
      g.fillStyle = '#1a1c15'; g.fillRect(-14, -8, 28, 8);
      g.fillStyle = team.main; g.fillRect(-24, 12, 48, 4);
      g.fillStyle = '#2a2c24'; g.fillRect(-26, -10, 4, 24);
    } else if (b.kind === 'turret') {
      g.fillStyle = '#5a5c4e';
      g.beginPath(); g.arc(0, 0, 14, 0, 7); g.fill();
      g.fillStyle = '#3a3c31';
      g.beginPath(); g.arc(0, 0, 9, 0, 7); g.fill();
      g.strokeStyle = '#22241c'; g.lineWidth = 4;
      g.beginPath(); g.moveTo(0, 0); g.lineTo(20, -6); g.stroke();
      g.fillStyle = team.main; g.fillRect(-14, 10, 28, 3);
    } else if (b.kind === 'factory') {
      g.fillStyle = '#4a4433'; g.fillRect(-30, -20, 60, 40);
      g.fillStyle = '#625a44'; g.fillRect(-30, -26, 60, 10);
      g.fillStyle = '#2e2a1e';
      for (let i = 0; i < 3; i++) g.fillRect(-22 + i * 16, -8, 10, 16);
      g.fillStyle = '#3a3a33'; g.fillRect(16, -44, 9, 24);
      g.fillStyle = team.main; g.fillRect(-30, 16, 60, 4);
    } else if (b.kind === 'depot') {
      g.fillStyle = '#4d4a3b'; g.fillRect(-28, -18, 56, 36);
      g.fillStyle = '#68634e'; g.fillRect(-30, -24, 60, 9);
      g.fillStyle = '#24251d'; g.fillRect(-12, -6, 24, 24);
      g.fillStyle = team.main; g.fillRect(-28, 14, 56, 4);
      g.strokeStyle = '#8d8f7a'; g.lineWidth = 1; g.strokeRect(-12, -6, 24, 24);
    } else if (b.kind === 'radio') {
      g.strokeStyle = '#5d6250'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(-14, 16); g.lineTo(0, -34); g.lineTo(14, 16); g.stroke();
      for (let i = 0; i < 3; i++) {
        const y = 8 - i * 12, w = 9 - i * 2;
        g.beginPath(); g.moveTo(-w, y); g.lineTo(w, y); g.stroke();
      }
      g.fillStyle = Math.sin(performance.now() / 400) > 0 ? '#e2574a' : '#5a2018';
      g.fillRect(-2, -38, 4, 4);
      g.fillStyle = team.main; g.fillRect(-14, 16, 28, 3);
    }
    if (b.hp < b.maxHp) {
      g.fillStyle = 'rgba(0,0,0,.7)'; g.fillRect(-22, -30, 44, 4);
      g.fillStyle = team.bright; g.fillRect(-22, -30, 44 * (b.hp / b.maxHp), 4);
    }
    g.restore();
  }
}

function drawVehicles(g, inView) {
  for (const v of S.vehicles) {
    if (v.hp <= 0 || !inView(v.x, v.y, 60)) continue;
    const r = S.render.vehicles.get(v.id);
    const x = r ? r.x : v.x, y = r ? r.y : v.y;
    const a = r ? r.a : v.angle;
    drawVehicleSprite(g, x, y, a, v, v.side === (S.me && S.me.side));
  }
}
function drawVehicleSprite(g, x, y, angle, v, friendly) {
  const team = TEAM[v.side] || TEAM.neutral;
  g.save();
  g.translate(x, y); g.rotate(angle);
  g.fillStyle = 'rgba(0,0,0,.35)';
  g.beginPath(); g.ellipse(-2, 8, 26, 10, 0, 0, 7); g.fill();
  if (v.kind === 'truck') {
    g.fillStyle = '#4c5038'; g.fillRect(-24, -13, 42, 26);
    g.fillStyle = '#5d6247'; g.fillRect(-24, -13, 26, 26);
    g.fillStyle = '#33362a'; g.fillRect(2, -13, 16, 26);
    g.fillStyle = '#24261d'; g.fillRect(-20, -17, 13, 6); g.fillRect(-20, 11, 13, 6);
    g.fillRect(8, -17, 11, 6); g.fillRect(8, 11, 11, 6);
    g.fillStyle = team.main; g.fillRect(-24, -13, 5, 26);
    g.fillStyle = '#8b8e7c'; g.fillRect(14, -8, 6, 16);
  } else if (v.kind === 'apc') {
    // boxy armoured carrier with sloped glacis and a small turret
    g.fillStyle = '#47523f'; g.fillRect(-28, -16, 52, 32);
    g.fillStyle = '#59664c'; g.fillRect(-28, -16, 20, 32);
    g.fillStyle = '#2c3328'; g.fillRect(-23, -19, 13, 6); g.fillRect(-23, 13, 13, 6);
    g.fillRect(9, -19, 12, 6); g.fillRect(9, 13, 12, 6);
    g.fillStyle = '#37402f'; g.fillRect(12, -10, 12, 20);
    g.fillStyle = '#67745a'; g.fillRect(-4, -8, 18, 16);
    g.fillStyle = team.main; g.fillRect(-28, -16, 5, 32);
    g.strokeStyle = '#20251c'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(8, 0); g.lineTo(30, 0); g.stroke();
  } else if (v.kind === 'armored_car') {
    g.fillStyle = '#4a4d3b'; g.fillRect(-26, -15, 48, 30);
    g.fillStyle = '#5d604b'; g.fillRect(-26, -15, 20, 30);
    g.fillStyle = '#2b2d24'; g.fillRect(-22, -18, 12, 6); g.fillRect(-22, 12, 12, 6);
    g.fillRect(8, -18, 11, 6); g.fillRect(8, 12, 11, 6);
    g.fillStyle = '#3a3c2f'; g.beginPath(); g.arc(0, 0, 10, 0, 7); g.fill();
    g.strokeStyle = '#24261d'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(4, 0); g.lineTo(30, 0); g.stroke();
    g.fillStyle = team.main; g.fillRect(-26, -15, 48, 4);
  } else {
    // landship
    g.fillStyle = '#34362b'; g.fillRect(-30, -18, 60, 36);
    g.fillStyle = '#24261d'; g.fillRect(-30, -20, 60, 7); g.fillRect(-30, 13, 60, 7);
    g.fillStyle = '#4b4e3b'; g.fillRect(-24, -14, 48, 28);
    g.fillStyle = '#3d4031'; g.fillRect(-6, -12, 28, 24);
    g.fillStyle = team.main; g.fillRect(-24, -14, 48, 4);
    g.strokeStyle = '#24261d'; g.lineWidth = 6;
    g.beginPath(); g.moveTo(6, 0); g.lineTo(38, 0); g.stroke();
    g.fillStyle = '#25271e'; g.fillRect(-14, -6, 8, 12);
  }
  g.restore();
  // hp bar + crew
  if (v.hp < v.maxHp) {
    g.fillStyle = 'rgba(0,0,0,.7)'; g.fillRect(x - 24, y - 34, 48, 4);
    g.fillStyle = team.bright; g.fillRect(x - 24, y - 34, 48 * (v.hp / v.maxHp), 4);
  }
  if (friendly) {
    g.fillStyle = 'rgba(233,228,207,.75)'; g.font = '8px Consolas, monospace'; g.textAlign = 'center';
    g.fillText((v.kind === 'armored_car' ? 'AC' : v.kind === 'truck' ? 'TRUCK' : v.kind === 'apc' ? 'APC' : 'LANDSHIP') + (v.driver ? ' ◆' : ''), x, y - 38);
  }
}

function drawMarkersWorld(g, inView, now) {
  const mine = S.me ? S.me.side : null;
  for (const mk of S.markers) {
    if (mk.side !== mine) continue;
    if (!inView(mk.x, mk.y, 60)) continue;
    const age = (now - (mk.t || now)) / 1000;
    if (age > (mk.kind === 'order' ? 30 : 10)) continue;
    const isOrder = mk.kind === 'order';
    const col = isOrder ? '#f0c469' : '#d9d6c4';
    const pulse = 1 + Math.sin(now / 220) * 0.12;
    g.save();
    g.translate(mk.x, mk.y);
    g.strokeStyle = col; g.globalAlpha = .8; g.lineWidth = 2;
    g.beginPath(); g.arc(0, 0, (isOrder ? 14 : 9) * pulse, 0, 7); g.stroke();
    g.globalAlpha = 1;
    g.fillStyle = isOrder ? 'rgba(240,196,105,.9)' : 'rgba(217,214,196,.85)';
    g.beginPath();
    g.moveTo(0, -16); g.lineTo(5, -8); g.lineTo(0, -4); g.lineTo(-5, -8); g.closePath(); g.fill();
    g.font = 'bold 9px Consolas, monospace'; g.textAlign = 'center';
    g.fillStyle = 'rgba(8,10,6,.75)';
    const label = isOrder ? 'ORDER' : mk.by;
    g.fillRect(-30, 14, 60, 12);
    g.fillStyle = col;
    g.fillText(label.toUpperCase().slice(0, 14), 0, 23);
    const my = myPos();
    g.fillStyle = 'rgba(217,214,196,.75)'; g.font = '8px Consolas, monospace';
    g.fillText(Math.round(dist(mk.x, mk.y, my.x, my.y) / 10) + 'm', 0, 35);
    g.restore();
  }
}

function drawBots(g, now, inView) {
  for (const b of S.bots) {
    if (b.dead || !inView(b.x, b.y)) continue;
    const r = S.render.bots.get(b.id);
    const bx = r ? r.x : b.x, by = r ? r.y : b.y;
    drawSoldier(g, bx, by, r ? r.a : b.angle, {
      side: b.side, isBot: true, name: b.name, hp: b.hp, maxHp: b.maxHp,
      trench: isTrench(bx, by), friendly: b.side === (S.me && S.me.side),
      weapon: 'rifle', rank: 0, armor: 'belt_helmet', moving: false, now,
      concealed: concealedByBush(bx, by),
      inWater: terrainType(bx, by) === 3 && !isBridgeAt(bx, by),
    });
  }
}

function drawPlayers(g, now, inView) {
  for (const p of S.players) {
    if (p.dead) {
      if (p.id === meId()) continue;
      if (!inView(p.x, p.y)) continue;
      drawCorpse(g, p.x, p.y, p.side);
      continue;
    }
    if (p.vehicle) continue;
    if (!inView(p.x, p.y)) continue;
    const isMe = p.id === meId();
    const r = S.render.players.get(p.id);
    let x = r ? r.x : p.x, y = r ? r.y : p.y, a = r ? r.a : p.angle;
    if (isMe) { x = S.pred.x; y = S.pred.y; a = Math.atan2(S.mouseWorld.y - y, S.mouseWorld.x - x); }
    const moving = isMe ? inputVector().active : false;
    drawSoldier(g, x, y, a, {
      side: p.side, name: p.name, hp: p.hp, maxHp: p.maxHp,
      trench: isTrench(x, y), friendly: p.side === (S.me && S.me.side) || isMe,
      weapon: p.weapon, rank: p.rank, armor: p.armor, isMe, moving, now,
      exposed: p.exposed, registered: p.registered, id: p.id,
      concealed: concealedByBush(x, y),
      inWater: terrainType(x, y) === 3 && !isBridgeAt(x, y),
    });
    if (isMe) {
      // selection ring
      g.strokeStyle = 'rgba(240,196,105,.35)'; g.lineWidth = 1;
      g.beginPath(); g.arc(x, y, 15, 0, 7); g.stroke();
    }
  }
}

function drawSoldier(g, x, y, angle, o) {
  const team = TEAM[o.side] || TEAM.neutral;
  const inTrench = o.trench;
  const inWater = !!o.inWater;
  const bob = o.moving ? Math.sin(o.now / 90) * 1.2 : 0;
  const yy = y + bob + (inTrench ? 5 : 0);
  g.save();
  if (inTrench) g.globalAlpha = 0.92;
  if (o.concealed) g.globalAlpha = o.isMe ? 0.55 : 0.24; // bushes swallow the silhouette
  // shadow (or a ripple when submerged)
  if (inWater) {
    g.strokeStyle = 'rgba(168,206,210,.35)'; g.lineWidth = 1.5;
    g.beginPath(); g.ellipse(x, yy + 5, 11, 4.5, 0, 0, 7); g.stroke();
    g.strokeStyle = 'rgba(168,206,210,.18)';
    g.beginPath(); g.ellipse(x, yy + 5, 15, 6.5, 0, 0, 7); g.stroke();
  } else {
    g.fillStyle = 'rgba(0,0,0,.32)';
    g.beginPath(); g.ellipse(x, yy + 8, o.isMe ? 10 : 8, 4, 0, 0, 7); g.fill();
  }
  // legs (hidden below the surface while swimming)
  if (!inWater) {
    g.fillStyle = team.dark;
    const legOff = o.moving ? Math.sin(o.now / 80) * 3 : 0;
    g.fillRect(x - 5, yy + 2 + legOff, 4, 7);
    g.fillRect(x + 1, yy + 2 - legOff, 4, 7);
  }
  // torso
  g.fillStyle = team.tunic;
  g.fillRect(x - 7, yy - 5, 14, 10);
  g.fillStyle = 'rgba(0,0,0,.18)';
  g.fillRect(x - 7, yy + 2, 14, 3);
  // belt
  g.fillStyle = '#3d3322'; g.fillRect(x - 7, yy + 1, 14, 2);
  // shoulders
  g.fillStyle = team.light;
  g.fillRect(x - 8, yy - 5, 3, 6); g.fillRect(x + 5, yy - 5, 3, 6);
  // rank stripe
  if (o.friendly && o.rank >= 0) {
    const stripes = Math.min(4, 1 + Math.floor(o.rank / 3));
    g.fillStyle = '#d9c27a';
    for (let i = 0; i < stripes; i++) g.fillRect(x + 5, yy - 5 + i * 2, 4, 1);
  }
  // head / helmet
  const hx = x + Math.cos(angle) * 2, hy = yy - 7;
  g.fillStyle = o.armor === 'vest_cap' ? '#3d3a2a' : team.helmet;
  g.beginPath(); g.arc(hx, hy, 6, 0, 7); g.fill();
  if (o.armor === 'vest_cap') {
    g.fillStyle = '#4a4733'; g.fillRect(hx - 6, hy - 1, 12, 3);
    g.fillStyle = '#2c2a1e'; g.fillRect(hx + 3, hy - 1, 5, 2);
  } else {
    g.fillStyle = team.light;
    g.beginPath(); g.arc(hx - 2, hy - 2, 3, 0, 7); g.fill();
    g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(hx - 7, hy + 2, 14, 2);
  }
  // face direction
  g.fillStyle = '#c9a07a'; g.fillRect(hx + Math.cos(angle) * 4 - 1, hy + Math.sin(angle) * 4 - 1, 2, 2);
  // weapon
  const w = o.weapon || 'rifle';
  const len = w === 'sniper' ? 26 : w === 'mg' ? 22 : w === 'smg' ? 15 : w === 'pistol' ? 10 : 20;
  const thick = w === 'mg' ? 3 : 2;
  g.strokeStyle = '#2b2419'; g.lineWidth = thick;
  const wx = x + Math.cos(angle) * 7, wy = yy - 2 + Math.sin(angle) * 4;
  g.beginPath(); g.moveTo(wx, wy); g.lineTo(wx + Math.cos(angle) * len, wy + Math.sin(angle) * len); g.stroke();
  g.strokeStyle = '#6b5030'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(wx, wy); g.lineTo(wx + Math.cos(angle) * 5, wy + Math.sin(angle) * 5); g.stroke();
  // hands
  g.fillStyle = '#c9a07a';
  g.fillRect(wx + Math.cos(angle) * 6 - 1, wy + Math.sin(angle) * 6 - 1, 2, 2);

  // waterline: the lower body dissolves into the river
  if (inWater) {
    g.fillStyle = 'rgba(34,62,70,.9)';
    g.beginPath(); g.ellipse(x, yy + 5, 13, 6.5, 0, 0, 7); g.fill();
    g.strokeStyle = 'rgba(170,210,214,.4)'; g.lineWidth = 1;
    g.beginPath(); g.ellipse(x, yy + 3.5, 10, 4, 0, 0, 7); g.stroke();
  }

  // trench parapet in front
  if (inTrench) {
    g.globalAlpha = 1;
    g.fillStyle = 'rgba(24,19,13,.85)';
    g.fillRect(x - 11, yy + 7, 22, 4);
    g.fillStyle = '#6f6041';
    for (let i = 0; i < 3; i++) g.fillRect(x - 10 + i * 8, yy + 8, 6, 3);
  }
  g.restore();

  // health / name (a concealed soldier shows no marker)
  if (o.friendly && !o.isMe && !o.concealed) {
    g.textAlign = 'center';
    g.font = '8px Consolas, monospace';
    g.fillStyle = 'rgba(8,10,6,.65)';
    g.fillRect(x - 30, y - 30, 60, 11);
    g.fillStyle = team.light;
    g.fillText((o.name || '').slice(0, 15), x, y - 21);
    if (o.hp < o.maxHp) {
      g.fillStyle = 'rgba(0,0,0,.7)'; g.fillRect(x - 9, y - 17, 18, 3);
      g.fillStyle = o.hp / o.maxHp > 0.35 ? '#6f8a4a' : '#c34a3d';
      g.fillRect(x - 9, y - 17, 18 * (o.hp / o.maxHp), 3);
    }
  } else if (!o.friendly && !o.concealed) {
    if (o.hp < o.maxHp) {
      g.fillStyle = 'rgba(0,0,0,.7)'; g.fillRect(x - 9, y - 18, 18, 3);
      g.fillStyle = '#c34a3d'; g.fillRect(x - 9, y - 18, 18 * (o.hp / o.maxHp), 3);
    }
  }
}
function addCorpse(x, y, side) {
  S.corpses.push({ x, y, side, t: performance.now() });
  if (S.corpses.length > 120) S.corpses.shift();
  if (S.terrainCtx) {
    S.terrainCtx.fillStyle = 'rgba(88,24,18,.3)';
    S.terrainCtx.beginPath();
    S.terrainCtx.arc(x + (Math.random() - .5) * 8, y + 4, 7 + Math.random() * 7, 0, 7);
    S.terrainCtx.fill();
  }
}
function drawCorpses(g) {
  const now = performance.now();
  for (const c of S.corpses) {
    const age = (now - c.t) / 1000;
    if (age > 120) continue;
    const a = age > 90 ? 1 - (age - 90) / 30 : 1;
    g.save(); g.globalAlpha = 0.55 * a;
    const team = TEAM[c.side] || TEAM.neutral;
    g.fillStyle = 'rgba(70,20,16,.35)';
    g.beginPath(); g.ellipse(c.x + 1, c.y + 4, 12, 7, 0.5, 0, 7); g.fill();
    g.fillStyle = team.dark;
    g.fillRect(c.x - 8, c.y - 3, 15, 6);
    g.fillStyle = team.helmet;
    g.beginPath(); g.arc(c.x - 9, c.y, 4, 0, 7); g.fill();
    g.fillStyle = '#3d3322'; g.fillRect(c.x - 2, c.y - 8, 9, 2);
    g.restore();
  }
}
function drawCorpse(g, x, y, side) {
  const team = TEAM[side] || TEAM.neutral;
  g.save();
  g.globalAlpha = .75;
  g.fillStyle = 'rgba(60,18,14,.35)';
  g.beginPath(); g.ellipse(x, y + 3, 11, 6, 0, 0, 7); g.fill();
  g.fillStyle = team.dark;
  g.fillRect(x - 7, y - 3, 13, 5);
  g.fillStyle = team.helmet;
  g.beginPath(); g.arc(x - 8, y - 1, 4, 0, 7); g.fill();
  g.restore();
}

function drawProjectiles(g, now, inView) {
  const age = Math.min(0.06, (performance.now() - S.lastState) / 1000);
  for (const b of S.bullets) {
    const x = b.x + (b.vx || 0) * age;
    const y = b.y + (b.vy || 0) * age;
    if (!inView(x, y, 20)) continue;
    const tx = x - (b.vx || 0) * 0.018;
    const ty = y - (b.vy || 0) * 0.018;
    g.strokeStyle = 'rgba(255,214,140,.9)'; g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(tx, ty); g.lineTo(x, y); g.stroke();
    g.strokeStyle = 'rgba(255,240,190,.25)'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(tx, ty); g.lineTo(x, y); g.stroke();
  }
  for (const gr of S.grenades) {
    if (!inView(gr.x, gr.y, 20)) continue;
    g.fillStyle = '#2f3524';
    g.beginPath(); g.arc(gr.x, gr.y, 4, 0, 7); g.fill();
    g.fillStyle = Math.sin(now / 70) > 0 ? '#e2574a' : '#5a2018';
    g.fillRect(gr.x - 1, gr.y - 6, 2, 3);
  }
}

function drawEffects(g) {
  for (const p of S.particles) {
    const a = clamp(p.life / p.max, 0, 1);
    g.globalAlpha = p.smoke ? a * 0.7 : a;
    g.fillStyle = p.color;
    if (p.glow) {
      g.beginPath(); g.arc(p.x, p.y, p.size, 0, 7); g.fill();
    } else if (p.smoke) {
      g.beginPath(); g.arc(p.x, p.y, p.size, 0, 7); g.fill();
    } else {
      g.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
  }
  g.globalAlpha = 1;
  for (const r of S.rings) {
    const a = clamp(r.life / r.maxLife, 0, 1);
    g.globalAlpha = a;
    g.strokeStyle = r.color; g.lineWidth = 3;
    g.beginPath(); g.arc(r.x, r.y, r.r, 0, 7); g.stroke();
  }
  g.globalAlpha = 1;
  for (const f of S.floats) {
    const a = clamp(f.life / f.max, 0, 1);
    g.globalAlpha = a;
    g.font = 'bold 10px Consolas, monospace'; g.textAlign = 'center';
    g.fillStyle = 'rgba(8,10,6,.75)';
    const w = g.measureText(f.text).width;
    g.fillRect(f.x - w / 2 - 3, f.y - 10, w + 6, 13);
    g.fillStyle = f.color;
    g.fillText(f.text, f.x, f.y);
  }
  g.globalAlpha = 1;
}

function bridgeGhostOrientation(x, y) {
  if (S.bridgeAxis === 'h') return true;
  if (S.bridgeAxis === 'v') return false;
  const t = tileAt(x, y);
  let hWater = 0, vWater = 0;
  for (let d = -4; d <= 4; d++) {
    const tx1 = t.tx + d, ty1 = t.ty, tx2 = t.tx, ty2 = t.ty + d;
    if (tx1 >= 0 && ty1 >= 0 && tx1 < S.world.cols && ty1 < S.world.rows && S.terrain[idxAt(tx1, ty1)] === 3) hWater++;
    if (tx2 >= 0 && ty2 >= 0 && tx2 < S.world.cols && ty2 < S.world.rows && S.terrain[idxAt(tx2, ty2)] === 3) vWater++;
  }
  return vWater >= hWater;
}

function drawPlacementGhost(g) {
  if (!S.selectedBuild || !S.mouseWorld) return;
  const def = S.config.buildings[S.selectedBuild];
  if (!def) return;
  const x = S.mouseWorld.x, y = S.mouseWorld.y;
  const ok = dist(x, y, myPos().x, myPos().y) <= 260;
  g.save();
  g.globalAlpha = 0.5;
  if (S.selectedBuild === 'bridge') {
    const horizontal = bridgeGhostOrientation(x, y);
    const w = (horizontal ? def.w : def.h) * S.world.tile;
    const h = (horizontal ? def.h : def.w) * S.world.tile;
    const good = ok && terrainType(x, y) === 3;
    g.strokeStyle = good ? '#f0c469' : '#e2574a'; g.lineWidth = 2;
    g.setLineDash([6, 5]);
    g.strokeRect(x - w / 2, y - h / 2, w, h);
    g.setLineDash([]);
    g.fillStyle = good ? 'rgba(240,196,105,.22)' : 'rgba(226,87,74,.22)';
    g.fillRect(x - w / 2, y - h / 2, w, h);
    g.globalAlpha = 1;
    g.fillStyle = good ? '#f0c469' : '#e2574a'; g.font = 'bold 10px Consolas, monospace'; g.textAlign = 'center';
    g.fillText((horizontal ? 'EAST–WEST' : 'NORTH–SOUTH') + ' BRIDGE', x, y - h / 2 - 8);
    g.restore();
    return;
  }
  g.strokeStyle = ok ? '#f0c469' : '#e2574a'; g.lineWidth = 2;
  g.setLineDash([6, 5]);
  g.beginPath(); g.arc(x, y, def.radius || 24, 0, 7); g.stroke();
  g.setLineDash([]);
  g.fillStyle = ok ? 'rgba(240,196,105,.25)' : 'rgba(226,87,74,.25)';
  g.beginPath(); g.arc(x, y, def.radius || 24, 0, 7); g.fill();
  g.globalAlpha = 1;
  g.fillStyle = '#f0c469'; g.font = 'bold 10px Consolas, monospace'; g.textAlign = 'center';
  g.fillText(def.name.toUpperCase(), x, y - 34);
  g.restore();
}

function drawWeather(g) {
  g.save();
  g.strokeStyle = 'rgba(180,200,210,.12)'; g.lineWidth = 1;
  for (const d of S.rain) {
    g.beginPath(); g.moveTo(d.x, d.y); g.lineTo(d.x - d.l * 0.18, d.y + d.l); g.stroke();
  }
  g.restore();
}

function updateCrosshair() {
  const ch = $('crosshair');
  if (!ch) return;
  if (S.mode !== 'hud' || !S.deployed || isModalOpen()) { ch.classList.add('hidden'); return; }
  ch.classList.remove('hidden');
  ch.style.left = S.mouse.x + 'px';
  ch.style.top = S.mouse.y + 'px';
  ch.style.opacity = S.artillery || S.selectedBuild ? .5 : 1;
}

/* particles are also used before build */
function bootRender() {
  // nothing; draw loop in main.js
}
