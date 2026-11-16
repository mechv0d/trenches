/* ============================================================
   TRENCHES — boot + main loop
   ============================================================ */
'use strict';

const _lastPos = { x: 0, y: 0 };
function updatePrediction(dt) {
  if (!S.deployed || !S.me || S.me.dead) return;
  const p = S.pred;
  if (S.me.vehicle) {
    const v = S.vehicles.find(x => x.id === S.me.vehicle);
    if (v) { p.x = v.x; p.y = v.y; }
    if (S.mouseWorld) p.ang = Math.atan2(S.mouseWorld.y - p.y, S.mouseWorld.x - p.x);
    return;
  }
  const iv = inputVector();
  const armor = (S.config.armor[S.me.armor] || { speed: 1 }).speed;
  let spd = 132 * armor * (iv.sprint ? 1.32 : 1);
  if (isTrench(p.x, p.y)) spd *= 0.82;
  const tt = terrainType(p.x, p.y);
  if (tt === 2 || tt === 7) spd *= 0.86;
  if (tt === 3 && !isBridgeAt(p.x, p.y)) spd *= 0.52; // swimming — slow and with no cover
  if (iv.active) {
    const nx = p.x + iv.mx * spd * dt;
    const ny = p.y + iv.my * spd * dt;
    if (walkableAt(nx, p.y)) p.x = nx;
    if (walkableAt(p.x, ny)) p.y = ny;
    p.x = clamp(p.x, 16, S.world.w - 16);
    p.y = clamp(p.y, 16, S.world.h - 16);
  }
  if (S.mouseWorld) p.ang = Math.atan2(S.mouseWorld.y - p.y, S.mouseWorld.x - p.x);
}

/* Readability pass: all interface copy is 25% larger. Headings are exempt,
   as is the war clock (it has its own compact treatment). */
const BOOST_SKIP = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SCRIPT', 'STYLE']);
function boostTextNode(el) {
  if (!el || el.nodeType !== 1 || BOOST_SKIP.has(el.tagName) || el.dataset.txtBoost) return;
  if (el.classList && (el.classList.contains('tb-timer') || el.classList.contains('brand'))) return;
  let hasText = false;
  for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) { hasText = true; break; }
  if (!hasText) return;
  const fs = parseFloat(getComputedStyle(el).fontSize);
  if (!fs || fs < 5) return;
  el.style.fontSize = (fs * 1.25).toFixed(1) + 'px';
  el.dataset.txtBoost = '1';
}
function applyTextBoost(root) {
  const host = root && root.nodeType === 1 ? root : document.body;
  if (!host) return;
  if (host !== document.body) boostTextNode(host);
  for (const el of host.querySelectorAll('*')) boostTextNode(el);
}
function watchTextBoost() {
  applyTextBoost(document.body);
  const mo = new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) applyTextBoost(n);
  });
  mo.observe(document.body, { childList: true, subtree: true });
}

function boot() {
  if (S.token && S.username) {
    authMsg('Restoring previous session…', true);
    $('username').value = S.username;
  }
  // poll front status even if the socket drops
  setInterval(() => {
    if (!S.initialized) fetch('/api/status').then(r => r.json()).then(j => {
      if (j.war) {
        S.war = j.war;
        S.playerCount = j.online;
        S.serverMode = j.mode;
        updateFrontStatus();
      }
    }).catch(() => {});
  }, 8000);

  // close overlays with escape
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isModalOpen()) {
      document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
      S.paused = false;
    }
  });

  requestAnimationFrame(function loop(now) {
    requestAnimationFrame(loop);
    drawFrame(now);
  });

  // little boot flourish
  setTimeout(() => {
    if (!S.initialized) authMsg('Contacting front-line server…', true);
  }, 900);
  watchTextBoost();
}

boot();
