/* ============================================================
   TRENCHES — interface
   ============================================================ */
'use strict';

const SCREENS = ['menu', 'deploy', 'hud'];
function showScreen(name) {
  for (const s of SCREENS) {
    const el = $(s);
    if (el) el.classList.toggle('hidden', s !== name);
  }
  if (name === 'hud') {
    $('deploy').classList.add('hidden');
    $('menu').classList.add('hidden');
  }
}

function openModal(id) { const el = $(id); if (el) el.classList.remove('hidden'); }
function closeModal(id) { const el = $(id); if (el) el.classList.add('hidden'); }
function isModalOpen() { return ['modalBuild', 'modalArmory', 'modalProfile', 'modalMap', 'pause'].some(id => !$(id).classList.contains('hidden')); }

/* ------------------------------------------------------------ */
/*  menu / front status                                         */
/* ------------------------------------------------------------ */
function updateFrontStatus() {
  if (!S.war) return;
  const total = Math.max(1, S.war.redPoints + S.war.bluePoints);
  $('fsRed').style.width = Math.round((S.war.redPoints / total) * 100) + '%';
  $('fsBlue').style.width = Math.round((S.war.bluePoints / total) * 100) + '%';
  $('fsOnline').textContent = `${S.playerCount || 0} ENLISTED`;
  $('fsMode').textContent = (S.serverMode || 'CAMPAIGN').toUpperCase();
  $('fsTime').textContent = `T−${fmtTime(S.war.remaining)}`;
  $('hudTimer').textContent = fmtTime(S.war.remaining);
}
function updateMenuState() {
  if (!S.initialized) return;
  const now = performance.now();
  if (now - (S._lastMenu || 0) < 300) return;
  S._lastMenu = now;
  updateFrontStatus();
  if (S.war) {
    const pop = Math.round((S.war.popMod - 1) * 100);
    $('hudPop').textContent = pop > 0 ? `LOW-POP +${pop}%` : `POP ${S.playerCount || 0}`;
  }
}
function authMsg(text, ok) {
  const el = $('authMsg');
  if (!el) return;
  el.textContent = text;
  el.className = 'auth-msg' + (ok ? ' ok' : '');
}

/* ------------------------------------------------------------ */
/*  deploy screen                                               */
/* ------------------------------------------------------------ */
function spawnOptions(side) {
  const out = [{ id: 'mob', name: side === 'red' ? 'RED MAIN BASE' : 'BLUE MAIN BASE', sub: 'Main Operational Base' }];
  for (const cp of S.cps) if (cp.owner === side) out.push({ id: cp.id, name: cp.name, sub: 'Forward sector' });
  return out;
}
function renderSpawnList(container, side, selected, cb) {
  if (!container) return;
  container.innerHTML = '';
  if (!side) {
    container.innerHTML = '<div class="spawn-item" style="opacity:.5">Choose an army to see deployment points</div>';
    return;
  }
  const opts = spawnOptions(side);
  for (const o of opts) {
    const b = document.createElement('button');
    b.className = 'spawn-item' + (o.id === selected ? ' chosen' : '');
    b.innerHTML = `<span>${o.name}<br/><small>${o.sub}</small></span><span class="tag">${o.id === 'mob' ? 'HQ' : 'SECTOR'}</span>`;
    b.onclick = () => cb(o.id);
    container.appendChild(b);
  }
}
function renderSideCards() {
  const mine = S.me ? S.me.side : null;
  const chosen = S.chosenSide || mine;
  const locked = !!S.sideLocked;
  const counts = { red: 0, blue: 0 };
  for (const p of S.players) if (p.side) counts[p.side]++;
  const pts = { red: S.war ? S.war.redPoints : 0, blue: S.war ? S.war.bluePoints : 0 };
  for (const side of ['red', 'blue']) {
    const el = $('pick' + side[0].toUpperCase() + side.slice(1));
    const meta = $(side + 'Meta');
    const lock = $(side + 'Lock');
    if (!el) continue;
    el.classList.toggle('chosen', chosen === side);
    el.classList.toggle('locked', locked && chosen !== side);
    if (meta) meta.textContent = `${counts[side]} enlisted · ${pts[side]} sectors`;
    if (lock) lock.textContent = chosen === side
      ? (locked ? '◆ ENLISTED — LOCKED FOR THIS WAR' : '◆ SELECTED — CHANGEABLE UNTIL DEPLOY')
      : (locked ? 'ENLISTED ELSEWHERE' : (chosen ? 'SWITCH ARMY' : ''));
  }
}
function renderDeploy() {
  if (!S.me) return;
  const me = S.me;
  const chosen = S.chosenSide || me.side || null;
  renderSideCards();
  renderSpawnList($('spawnList'), chosen, S.spawnPoint, (id) => { S.spawnPoint = id; renderDeploy(); });
  // rank card
  const rk = rankOf(me);
  const next = (me.registered && me.rank >= 0 && me.rank < 9) ? S.ranks[me.rank + 1] : null;
  const xpNow = me.registered ? me.xp : 0;
  const prevXp = (me.registered && me.rank >= 0) ? S.ranks[me.rank].xp : 0;
  const nextXp = next ? next.xp : Math.max(1, xpNow);
  const pct = next ? clamp((xpNow - prevXp) / Math.max(1, nextXp - prevXp), 0, 1) : 1;
  const perks = [];
  if (me.registered) {
    for (const [k, w] of Object.entries(S.config.weapons)) if (w.minRank <= me.rank) perks.push(w.name);
    const builds = Object.entries(S.config.buildings).filter(([, b]) => b.minRank <= me.rank).map(([, b]) => b.name);
    if (builds.length) perks.push(...builds.slice(0, 3));
  }
  $('rankCard').innerHTML = `
    <div class="rk-top">
      <div class="rk-name">${me.registered ? rk.name : 'Guest Infantry'}</div>
      <div class="rk-tag">${me.registered ? rk.tag : 'GST'} · ${me.registered ? 'ENLISTED' : 'UNREGISTERED'}</div>
    </div>
    <div class="rk-xp"><i style="width:${Math.round(pct * 100)}%"></i></div>
    <div class="rk-sub">${me.registered
      ? (next ? `${xpNow} XP / ${nextXp} XP — next: ${next.name}` : `${xpNow} XP — maximum rank`)
      : 'Guests fight as ordinary infantry. Enlist to earn ranks, crew vehicles and build defences.'}</div>
    <div class="rk-perks">${perks.slice(0, 8).map(p => `<span>${p}</span>`).join('')}</div>`;
  const dep = $('btnDeploy');
  dep.disabled = !chosen;
  dep.textContent = chosen ? `DEPLOY TO ${(spawnOptions(chosen).find(o => o.id === S.spawnPoint) || spawnOptions(chosen)[0]).name}` : 'CHOOSE YOUR ARMY';
  $('deployNote').innerHTML = S.war
    ? `LOW-POP MODIFIER <b style="color:#d9a441">×${S.war.popMod.toFixed(2)}</b> — construction and equipment costs reduced, capture speed increased, AI support expanded.<br/>War ends in <b style="color:#d9a441">${fmtTime(S.war.remaining)}</b>, at <b style="color:#d9a441">${S.war.scoreLimit || 1000}</b> conquest points, or when an MOB falls. You may change army until your first deployment.`
    : 'Awaiting front-line telemetry…';
  updateDeployWarLine();
  drawDeployMap();
}
function updateDeployWarLine() {
  if (!S.war) return;
  const sc = S.war.score || { red: 0, blue: 0 };
  $('deployWar').innerHTML = `<b>${S.war.redPoints}</b> RED &nbsp;·&nbsp; <b>${S.war.bluePoints}</b> BLUE
    &nbsp;·&nbsp; SCORE <b>${sc.red}</b>–<b>${sc.blue}</b>/${S.war.scoreLimit || 1000}
    &nbsp;·&nbsp; T−${fmtTime(S.war.remaining)} &nbsp;·&nbsp; ${S.playerCount || 0} ENLISTED`;
}
function updateDeployLive() {
  if (!S.me) return;
  if (S.mode === 'deploy') {
    renderSideCards();
    updateDeployWarLine();
    if (S.chosenSide) renderSpawnList($('spawnList'), S.chosenSide, S.spawnPoint, (id) => { S.spawnPoint = id; renderDeploy(); });
    if (S.deployMapDirty) { drawDeployMap(); S.deployMapDirty = false; }
  }
}
function chooseSide(side) {
  if (S.sideLocked || S.deployed) return toast('Army locked — you have already deployed this war', 'red');
  if (!S.me) return;
  S.chosenSide = side;
  S.spawnPoint = 'mob';
  sendMsg({ type: 'side_select', side });
  renderDeploy();
}
function deployNow() {
  if (!S.chosenSide) return toast('Choose an army first', 'red');
  sendMsg({ type: 'spawn', point: S.spawnPoint || 'mob' });
  const b = $('btnDeploy'); b.disabled = true; b.textContent = 'DEPLOYING…';
}

function onSideSet(msg) {
  S.chosenSide = msg.side;
  if (S.me) S.me.side = msg.side;
  sfxClick();
  renderDeploy();
}
function onDeployed(msg) {
  S.deployed = true;
  S.sideLocked = true;
  S.mode = 'hud';
  S.paused = false;
  S.pred.x = msg.x; S.pred.y = msg.y;
  if (S.me) { S.me.dead = false; S.me.x = msg.x; S.me.y = msg.y; }
  S.deathUntil = 0;
  S.mouse.down = false;
  closeModal('modalBuild'); closeModal('modalArmory'); closeModal('modalProfile'); closeModal('modalMap'); closeModal('pause');
  closeRadio();
  toggleScoreboard(false);
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  $('death').classList.add('hidden');
  $('warEnd').classList.add('hidden');
  showScreen('hud');
  updateHud();
  toast('DEPLOYED — GOOD LUCK', 'gold');
}

/* ------------------------------------------------------------ */
/*  death / war end                                             */
/* ------------------------------------------------------------ */
function showDeath(opts, isDeath) {
  S.mode = 'death';
  S.deathSpawn = S.deathSpawn || 'mob';
  $('deathName').textContent = opts.name || (S.me ? S.me.name : '—');
  $('deathMeta').textContent = opts.meta || '';
  $('death').classList.remove('hidden');
  renderSpawnList($('deathSpawns'), S.chosenSide, S.deathSpawn, (id) => { S.deathSpawn = id; showDeath(opts, isDeath); });
  const btn = $('btnRespawn');
  btn.disabled = true;
  btn.textContent = isDeath ? 'RESPAWN IN 3…' : 'RECONNECTING…';
  if (!isDeath) btn.textContent = 'AWAITING SIGNAL…';
  updateDeath();
}
function onDied(msg) {
  S.deathUntil = Date.now() + (msg.respawnIn || 3000);
  const killer = msg.killer ? `KILLED BY ${msg.killer.toUpperCase()}` : 'KILLED IN ACTION';
  showDeath({ name: S.me ? S.me.name : '—', meta: `${killer} · ${msg.weapon ? msg.weapon.toUpperCase() : 'THE FRONT'}` }, true);
}
function updateDeath() {
  const btn = $('btnRespawn');
  if (!$('death').classList.contains('hidden')) {
    const left = Math.ceil((S.deathUntil - Date.now()) / 1000);
    if (left > 0) { btn.disabled = true; btn.textContent = `RESPAWN IN ${left}…`; }
    else if (S.connected) { btn.disabled = false; btn.textContent = 'RETURN TO THE FRONT'; }
  }
  if (S.warEndUntil > 0) {
    const left = Math.max(0, Math.ceil((S.warEndUntil - Date.now()) / 1000));
    $('warendNext').textContent = left > 0 ? `NEW CAMPAIGN BEGINS IN ${left}s` : 'NEW CAMPAIGN BEGINNING…';
  }
}
function onWarEnd(msg) {
  S.warEndUntil = Date.now() + (msg.next || 25000);
  S.warEndData = msg;
  S.warPage = 0;
  const won = S.me && S.me.side === msg.winner;
  $('warendKicker').textContent = won ? 'VICTORY' : (S.me && S.me.side ? 'DEFEAT' : 'ARMISTICE');
  $('warendKicker').style.color = msg.winner === 'red' ? TEAM.red.bright : TEAM.blue.bright;
  $('warendTitle').textContent = `${sideName(msg.winner)} VICTORY`;
  $('warendTitle').style.color = msg.winner === 'red' ? TEAM.red.bright : TEAM.blue.bright;
  const cause = msg.cause || 'time';
  const army = msg.winner === 'red' ? 'Red Army' : 'Blue Army';
  const foe = msg.winner === 'red' ? 'Blue line' : 'Red line';
  $('warendSub').textContent = cause === 'mob'
    ? `The ${army} has broken the ${foe}. The enemy MOB is taken.`
    : cause === 'score'
      ? `The ${army} has won the war of attrition on conquest points.`
      : `The ${army} holds the field as the campaign clock runs out.`;
  $('warEnd').classList.remove('hidden');
  renderWarPage();
  if (won) sfxVictory();
  else if (S.me && S.me.side) sfxDefeat();
  else sfxPromote();
}
function warPageCount() { return 4; }
function renderWarPage() {
  const msg = S.warEndData;
  if (!msg) return;
  const page = S.warPage | 0;
  const pages = $('warPages');
  const sub = $('warendSub');
  if (!pages) return;
  sub.style.display = page === 0 ? '' : 'none';
  let html = '';
  if (page === 0) {
    html = `<div class="war-page-title">DISPATCH FROM THE FRONT</div>
      <div class="war-highlight">Campaign ended after ${fmtTime(msg.duration || 0)}. Final score
      <b class="r">${msg.score.red}</b> — <b class="b">${msg.score.blue}</b> of ${msg.scoreLimit || 1000}.</div>
      <div class="war-highlight">Territory: RED ${msg.redPoints || 0} sectors · BLUE ${msg.bluePoints || 0} sectors.</div>`;
  } else if (page === 1) {
    const tl = (msg.timeline && msg.timeline.length) ? msg.timeline : [{ m: 0, red: 0, blue: 0, redPoints: msg.redPoints, bluePoints: msg.bluePoints }];
    const max = Math.max(1, msg.scoreLimit || 1000, ...tl.map(r => Math.max(r.red, r.blue)));
    html = `<div class="war-page-title">WAR PROGRESS BY MINUTE</div>` + tl.map(r => {
      const rr = Math.round((r.red / max) * 100), bb = Math.round((r.blue / max) * 100);
      return `<div class="war-progress-row">
        <span>M${r.m}</span>
        <span><b class="r">${r.red}</b><span class="war-bars"><i style="width:${rr}%;background:var(--red-2)"></i></span></span>
        <span><b class="b">${r.blue}</b><span class="war-bars"><i style="width:${bb}%;background:var(--blue-2)"></i></span></span>
        <span>${r.redPoints}R / ${r.bluePoints}B</span>
      </div>`;
    }).join('');
  } else if (page === 2) {
    const hs = (msg.highlights && msg.highlights.length) ? msg.highlights : [{ text: 'No decisive moments were recorded.', side: null }];
    html = `<div class="war-page-title">HIGHLIGHTS</div>` + hs.map(h => {
      const cls = h.side === 'red' ? 'r' : h.side === 'blue' ? 'b' : '';
      return `<div class="war-highlight"><span class="${cls}">${h.side ? sideName(h.side) : 'FRONT'}</span> · ${escapeHtml(h.text || '')}</div>`;
    }).join('');
  } else {
    const top = msg.top || [];
    const your = msg.your || {};
    html = `<div class="war-page-title">RESULTS</div>
      <div class="war-result-grid">
        <div><span>WINNER</span><b>${sideName(msg.winner)}</b></div>
        <div><span>CAUSE</span><b>${String(msg.cause || 'time').toUpperCase()}</b></div>
        <div><span>FINAL SCORE</span><b>${msg.score.red} — ${msg.score.blue}</b></div>
        <div><span>YOUR K/D</span><b>${your.kills || 0} / ${your.deaths || 0}</b></div>
        <div><span>YOUR CAPTURES</span><b>${your.captures || 0}</b></div>
        <div><span>RANK</span><b>RESET FOR NEXT CAMPAIGN</b></div>
      </div>
      <div class="war-page-title" style="margin-top:12px">TOP SOLDIERS</div>
      ${top.map((t, i) => `<div class="war-highlight">${i + 1}. <span class="${t.side === 'red' ? 'r' : 'b'}">${escapeHtml(t.name)}</span> — ${t.kills} K / ${t.deaths} D</div>`).join('') || '<div class="war-highlight">No soldiers on record.</div>'}`;
  }
  pages.innerHTML = html;
  const dots = $('warDots');
  if (dots) dots.innerHTML = Array.from({ length: warPageCount() }, (_, i) => `<i class="${i === page ? 'on' : ''}"></i>`).join('');
  $('warPrev').disabled = page <= 0;
  $('warNext').disabled = page >= warPageCount() - 1;
}
function warPageStep(dir) {
  S.warPage = Math.max(0, Math.min(warPageCount() - 1, (S.warPage | 0) + dir));
  renderWarPage();
}
function onNewWar(msg) {
  S.war = msg.war;
  S.warEndUntil = 0;
  S.deployed = false;
  S.mode = 'deploy';
  S.chosenSide = null;
  S.sideLocked = false;
  S.spawnPoint = 'mob';
  S.deathUntil = 0;
  S.artillery = false;
  S.selectedBuild = null;
  S.markers = [];
  if (S.me) { S.me.side = null; S.me.dead = true; }
  $('warEnd').classList.add('hidden');
  $('death').classList.add('hidden');
  showScreen('deploy');
  renderDeploy();
  toast('A NEW CAMPAIGN HAS BEGUN', 'gold');
}

/* ------------------------------------------------------------ */
/*  chat / radio                                                */
/* ------------------------------------------------------------ */
function addChat(msg) {
  S.chatAll.push(msg);
  if (S.chatAll.length > 220) S.chatAll.shift();
  if (msg.freq === myFreq()) { renderChat(); sfxRadio(); }
}
function addSystem(text, cls) {
  S.chatAll.push({ sys: true, text, cls: cls || '', t: Date.now() });
  if (S.chatAll.length > 220) S.chatAll.shift();
  if (S.mode === 'hud' || S.mode === 'deploy') renderChat();
}
function renderChat() {
  const el = $('chatLog');
  if (!el) return;
  const freq = myFreq();
  const rows = S.chatAll.filter(m => m.sys || m.freq === freq);
  el.innerHTML = rows.map(m => {
    if (m.sys) return `<div class="sys ${m.cls || ''}">${escapeHtml(m.text)}</div>`;
    const enemy = S.me && m.side && m.side !== S.me.side;
    return `<div class="msg${enemy ? ' enemy' : ''}"><span class="f">[${m.freq}]</span> <span class="who">${escapeHtml(m.from)}</span>: ${escapeHtml(m.text)}</div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
  const ch = $('radioChannel');
  if (ch) ch.textContent = freq;
}
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function sendChat() {
  const inp = $('chatInput');
  const text = inp.value.trim();
  if (!text) return;
  sendMsg({ type: 'chat', text });
  inp.value = '';
  sfxRadio();
}
function tuneRadio() {
  let hi = clamp(parseInt($('freqHi').value, 10) || 0, 0, 999);
  let lo = clamp(parseInt($('freqLo').value, 10) || 0, 0, 999);
  $('freqHi').value = hi; $('freqLo').value = lo;
  sendMsg({ type: 'set_freq', high: hi, low: lo });
  if (S.me) S.me.freq = { high: hi, low: lo };
  sfxRadio();
  renderChat();
  toast(`RADIO TUNED — ${fmtFreq(hi, lo)}`, 'amber');
}
/* Field radio stays stowed until the soldier opens it (button or ENTER). */
function radioOpen() {
  const p = $('radioPanel');
  return p && !p.classList.contains('hidden');
}
function openRadio(focus) {
  const p = $('radioPanel');
  if (!p) return;
  p.classList.remove('hidden');
  const b = $('btnRadio');
  if (b) b.classList.add('on');
  renderChat();
  if (focus) { const inp = $('chatInput'); if (inp) setTimeout(() => inp.focus(), 30); }
}
function closeRadio() {
  const p = $('radioPanel');
  if (p) p.classList.add('hidden');
  const b = $('btnRadio');
  if (b) b.classList.remove('on');
}
function toggleRadio() {
  if (radioOpen()) closeRadio(); else openRadio(true);
}
function onFreqSet(msg) {  if (S.me) S.me.freq = { high: msg.high, low: msg.low };
  $('freqHi').value = msg.high;
  $('freqLo').value = msg.low;
  renderChat();
}
function addKnownFreq(freq) {
  if (!freq || S.knownFreqs.includes(freq)) return;
  S.knownFreqs.push(freq);
  renderKnownFreqs();
}
function renderKnownFreqs() {
  const el = $('knownFreqs');
  if (!el) return;
  if (!S.knownFreqs.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<span class="kf-label">CAPTURED NETS:</span>' + S.knownFreqs.map(f =>
    `<button data-freq="${f}">${f}</button>`).join('');
  el.querySelectorAll('button').forEach(b => b.onclick = () => {
    const [h, l] = b.dataset.freq.split('–');
    $('freqHi').value = h; $('freqLo').value = l;
    tuneRadio();
  });
}

/* ------------------------------------------------------------ */
/*  toasts / killfeed / hitmark                                 */
/* ------------------------------------------------------------ */
function toast(text, level) {
  const layer = $('toasts');
  if (!layer) return;
  const el = document.createElement('div');
  el.className = 'toast ' + (level || '');
  el.textContent = text;
  layer.appendChild(el);
  while (layer.children.length > 5) layer.removeChild(layer.firstChild);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 320); }, 2800);
}
function showHitmark(kill) {
  const el = $('hitmark');
  if (!el) return;
  el.style.left = S.mouse.x + 'px';
  el.style.top = S.mouse.y + 'px';
  el.classList.remove('show', 'kill');
  void el.offsetWidth;
  el.classList.add('show');
  if (kill) el.classList.add('kill');
}
function onDamaged(msg) {
  const f = $('damageFlash');
  if (f) {
    f.classList.add('show');
    setTimeout(() => f.classList.remove('show'), 170);
  }
  sfxHurt();
  S.shake = Math.min(S.shake + 3.2, 9);
  if (S.me) S.me.hp = msg.hp;
  if (msg.amount) {
    const p = myPos();
    addFloat(p.x + (Math.random() - 0.5) * 14, p.y - 22, `-${msg.amount}`, '#e2574a');
  }
  updateHud();
}
function addKillFeed(ev) {
  S.killFeed.push({ ...ev, at: Date.now() });
  if (S.killFeed.length > 7) S.killFeed.shift();
  renderKillFeed();
}
function renderKillFeed() {
  const el = $('killFeed');
  if (!el) return;
  const now = Date.now();
  S.killFeed = S.killFeed.filter(k => now - k.at < 9000);
  el.innerHTML = S.killFeed.map(k => {
    const kc = k.killerSide === 'red' ? 'r' : k.killerSide === 'blue' ? 'b' : '';
    const vc = k.victimSide === 'red' ? 'r' : k.victimSide === 'blue' ? 'b' : '';
    return `<div class="kf-item"><span class="${kc}">${escapeHtml(k.killer || '?')}</span> <span class="w">[${escapeHtml((k.weapon || 'rifle'))}]</span> <span class="${vc}">${escapeHtml(k.victim || '?')}</span></div>`;
  }).join('');
}
setInterval(renderKillFeed, 1000);

/* ------------------------------------------------------------ */
/*  HUD                                                         */
/* ------------------------------------------------------------ */
function updateHud() {
  if (!S.me || !S.war) return;
  const me = S.me;
  const w = S.war;
  $('hudTimer').textContent = fmtTime(w.remaining);
  const pop = Math.round((w.popMod - 1) * 100);
  $('hudPop').textContent = pop > 0 ? `LOW-POP +${pop}%` : `${S.playerCount || 0} ONLINE`;
  const sc = w.score || { red: 0, blue: 0 };
  $('hudRedScore').textContent = sc.red | 0;
  $('hudBlueScore').textContent = sc.blue | 0;
  $('hudScoreLimit').textContent = `/${w.scoreLimit || 1000}`;
  renderSectors();

  const rk = rankOf(me);
  $('hudRank').textContent = me.registered ? `${rk.name.toUpperCase()} · ${me.name}` : `GUEST INFANTRY · ${me.name}`;
  let xpPct = 0, xpTxt = 'ENLIST TO EARN RANKS';
  if (me.registered) {
    const next = me.rank < 9 ? S.ranks[me.rank + 1] : null;
    const prev = S.ranks[me.rank] ? S.ranks[me.rank].xp : 0;
    xpPct = next ? clamp((me.xp - prev) / Math.max(1, next.xp - prev), 0, 1) : 1;
    xpTxt = next ? `${me.xp} / ${next.xp} XP · ${next.name.toUpperCase()}` : `${me.xp} XP · MAX RANK`;
  }
  $('hudXp').style.width = Math.round(xpPct * 100) + '%';
  $('hudXpLabel').textContent = xpTxt;

  const hp = Math.max(0, Math.round(me.hp));
  const hpFrac = clamp(hp / me.maxHp, 0, 1);
  $('hudHp').style.width = hpFrac * 100 + '%';
  $('hudHpText').textContent = `${hp} / ${me.maxHp}`;
  $('hudHp').parentElement.classList.toggle('low', hpFrac < 0.3);
  const armor = (S.config.armor[me.armor] || {}).name || 'No Armor';
  $('hudArmor').textContent = armor.toUpperCase();
  const veh = myVehicle();
  if (veh) $('hudCarry').innerHTML = `CARGO ${stockHTML(veh.cargo)}`;
  else $('hudCarry').innerHTML = `CARRY ${stockHTML(me.carry)}`;
  const detail = me.vehicle && veh ? veh.cargo : me.carry;
  const cap = me.vehicle ? 300 : (me.carryMax || 120);
  $('hudCarryDetail').innerHTML = stockHTML(detail) + `<span class="res" style="color:#8c8f7c">${carryTotalOf(detail)}/${cap}</span>`;
  // nearest friendly supply point, top-left, no panel
  const ns = $('nearStock');
  if (ns && S.deployed && me.side && !me.dead) {
    const pos = myPos();
    let best = null, bd = 1e9;
    for (const cp of S.cps) {
      if (cp.owner !== me.side) continue;
      const d = Math.hypot(cp.x - pos.x, cp.y - pos.y);
      if (d < bd) { bd = d; best = { name: `${cp.letter ? cp.letter + ' · ' : ''}${cp.name}`, stock: cp.stock }; }
    }
    const mob = me.side === 'red' ? (S.war && S.war.redMob) : (S.war && S.war.blueMob);
    if (mob) {
      const d = Math.hypot(mob.x - pos.x, mob.y - pos.y);
      if (d < bd) { bd = d; best = { name: sideName(me.side) + ' MOB', stock: mob.stock }; }
    }
    if (best) {
      ns.innerHTML = `<div class="ns-name">NEAREST DEPOT · ${escapeHtml(best.name)}</div><div class="ns-row">${stockHTML(best.stock)}</div>`;
      ns.style.display = '';
    } else ns.style.display = 'none';
  } else if (ns) ns.style.display = 'none';
  $('hudSide').textContent = me.side ? sideName(me.side) : 'NO SIDE';
  const lowEl = $('lowHp');
  if (lowEl) lowEl.classList.toggle('show', hpFrac > 0 && hpFrac < 0.38);

  const wdef = S.config.weapons[me.weapon] || { name: me.weapon, mag: 1 };
  $('hudWeapon').textContent = wdef.name.toUpperCase();
  $('hudAmmo').textContent = me.reloading ? '—' : me.ammo;
  $('hudMag').textContent = `/ ${wdef.mag}`;
  $('hudReload').style.width = me.reloading ? '100%' : '0%';
  $('hudGrenades').textContent = '✦'.repeat(Math.max(0, me.grenades)) + '·'.repeat(Math.max(0, 2 - me.grenades));
  $('hudVehicle').textContent = me.vehicle ? (veh && veh.kind === 'apc' ? `APC ${veh.magAmmo || 0}/${veh.ammo || 0}` : 'IN VEHICLE') : '';
  $('radioChannel').textContent = myFreq();
  const top = $('radioChannelTop');
  if (top) top.textContent = myFreq();

  updateHint();
  updateDeath();
  if (performance.now() - (S._lastMap || 0) > 120) { S._lastMap = performance.now(); drawMinimap(); }
  if (S.scoreboardOpen) renderScoreboard();
  drawDeployMapSafe();
}

/* Sector indicators: every captured/neutral sector sits in one row centred
   under the clock, in map order. */
function renderSectors() {
  const row = $('sectorRow');
  if (!row) return;
  if (!S.cps || !S.cps.length) { row.innerHTML = ''; return; }
  const chip = (cp) => {
    const owner = cp.owner || 'neutral';
    const pr = clamp(Math.abs(cp.progress || 0), 0, 100);
    const tag = pr > 0 ? Math.round(pr) + '%' : (owner === 'neutral' ? '—' : sideName(owner));
    return `<div class="sector-sq ${owner}" title="${escapeHtml(cp.name || '')}">
      <span>${escapeHtml(cp.letter || '?')}</span>
      <small>${tag}</small>
      <i style="width:${pr}%"></i>
    </div>`;
  };
  row.innerHTML = S.cps.map(chip).join('');
}

/* TAB roster with kills / deaths / assists for everyone in the round. */
function toggleScoreboard(force) {
  const el = $('scoreboard');
  if (!el) return;
  const open = force != null ? force : el.classList.contains('hidden');
  S.scoreboardOpen = open;
  el.classList.toggle('hidden', !open);
  if (open) renderScoreboard();
}
function renderScoreboard() {
  const body = $('sbBody');
  if (!body) return;
  const myId = meId();
  const rows = [];
  for (const p of S.players) rows.push({ name: p.name, side: p.side, k: p.kills | 0, d: p.deaths | 0, a: p.assists | 0, me: p.id === myId, bot: false });
  for (const b of S.bots) rows.push({ name: b.name, side: b.side, k: b.kills | 0, d: b.deaths | 0, a: b.assists | 0, me: false, bot: true });
  rows.sort((x, y) => (y.k - x.k) || (x.d - y.d));
  body.innerHTML = rows.map((r, i) => {
    const side = r.side || 'neutral';
    return `<tr class="${side}${r.me ? ' me' : ''}">
      <td class="num">${i + 1}</td>
      <td class="soldier">${escapeHtml(r.name)}${r.bot ? ' <em>AI</em>' : ''}${r.me ? ' <em>YOU</em>' : ''}</td>
      <td class="side ${side}">${r.side ? sideName(r.side) : '—'}</td>
      <td class="num">${r.k}</td>
      <td class="num">${r.d}</td>
      <td class="num">${r.a}</td>
    </tr>`;
  }).join('');
  const cnt = $('sbCount');
  if (cnt) cnt.textContent = `${rows.length} ON THE FRONT · ${S.players.length} HUMAN`;
}
function drawDeployMapSafe() {
  if (S.mode === 'deploy' && S.deployMapDirty) { drawDeployMap(); S.deployMapDirty = false; }
}
function updateHint() {
  const el = $('hint');
  if (!el || S.mode !== 'hud' || !S.me || S.me.dead) { if (el) el.classList.remove('show'); return; }
  const p = myPos();
  const me = S.me;
  const carry = carryTotalOf(me.carry);
  const cap = me.carryMax || 120;
  const veh = myVehicle();
  const cargo = veh ? carryTotalOf(veh.cargo) : 0;
  const mob = S.war ? (me.side === 'red' ? S.war.redMob : me.side === 'blue' ? S.war.blueMob : null) : null;
  const atMob = mob ? dist(p.x, p.y, mob.x, mob.y) < 240 : false;
  let atPoint = null;
  for (const cp of S.cps) {
    if (cp.owner !== me.side) continue;
    if (dist(p.x, p.y, cp.x, cp.y) < 180) { atPoint = cp; break; }
  }
  const atSupply = atMob || atPoint;
  let nearV = null, vd = 90;
  for (const v of S.vehicles) {
    if (v.side !== me.side || v.driver || v.hp <= 0) continue;
    const d = dist(v.x, v.y, p.x, p.y);
    if (d < vd) { vd = d; nearV = v; }
  }
  let text = '';
  if (S.selectedBuild) {
    text = S.selectedBuild === 'bridge'
      ? 'CLICK TO PLACE BRIDGE · R — ROTATE · RIGHT-CLICK TO CANCEL'
      : 'CLICK THE GROUND TO PLACE · RIGHT-CLICK TO CANCEL';
  }
  else if (S.artillery) text = 'CLICK THE MAP TO CALL ARTILLERY · RIGHT-CLICK TO CANCEL';
  else if (me.vehicle) {
    if (atSupply) text = cargo > 0 ? 'E — DEPOSIT VEHICLE SUPPLIES' : (atMob ? 'E — LOAD SUPPLIES FROM MOB' : 'DEPOT SUPPLIES — WITHDRAW AT MOB');
    else text = 'F — EXIT VEHICLE · MOUSE — FIRE MG';
  } else if (atSupply) {
    if (carry > 0) text = 'E — DEPOSIT SUPPLIES AT ' + (atMob ? 'MOB' : atPoint.name.toUpperCase());
    else text = atMob ? 'E — DRAW SUPPLIES FROM MOB' : 'DEPOT STOCK — SUPPLIES ARE SEPARATE PER POINT';
  } else if (nearV) {
    text = `F — CREW ${(S.config.vehicles[nearV.kind] || {}).name || 'VEHICLE'}`;
    if (carry > 0 || carryTotalOf(nearV.cargo) > 0) text += ' · E — TRANSFER SUPPLIES';
  }
  el.textContent = text;
  el.classList.toggle('show', !!text);
}

/* ------------------------------------------------------------ */
/*  build                                                       */
/* ------------------------------------------------------------ */
function openBuild() {
  if (S.mode !== 'hud' || !S.me || S.me.dead) return;
  renderBuildCards();
  openModal('modalBuild');
}
function costText(cost, mod) {
  const parts = [];
  if (cost.scrap) parts.push(resHTML('scrap', Math.round(cost.scrap * mod)));
  if (cost.fuel) parts.push(resHTML('fuel', Math.round(cost.fuel * mod)));
  if (cost.ammo) parts.push(resHTML('ammo', Math.round(cost.ammo * mod)));
  return parts.join(' ') || 'FREE';
}
function renderBuildCards() {
  const el = $('buildCards');
  if (!el) return;
  const me = S.me;
  const mod = (S.war ? S.war.popMod : 1) * (sideHasFactory(me.side) ? 0.78 : 1);
  el.innerHTML = '';
  for (const [kind, b] of Object.entries(S.config.buildings)) {
    const locked = !me.registered || me.rank < b.minRank;
    const card = document.createElement('button');
    card.className = 'card' + (locked ? ' locked' : '');
    card.innerHTML = `
      <div class="c-rank">${b.minRank > 0 ? (S.ranks[b.minRank] ? S.ranks[b.minRank].tag : 'R' + b.minRank) : 'PVT'}</div>
      <div class="c-name">${b.name.toUpperCase()}</div>
      <div class="c-desc">${b.desc}</div>
      <div class="c-stats"><span>HP <b>${b.hp}</b></span></div>
      <div class="c-cost">${costText(b.cost, mod)}</div>
      ${locked ? '<div class="c-badge" style="background:#5a2e2a;color:#e2574a">RANK LOCKED</div>' : '<div class="c-badge">SELECT</div>'}`;
    card.onclick = () => {
      if (locked) return toast('Rank or enlistment required', 'red');
      S.selectedBuild = kind;
      S.bridgeAxis = null;
      closeModal('modalBuild');
      toast(`BLUEPRINT — ${b.name.toUpperCase()}`, 'gold');
    };
    el.appendChild(card);
  }
}
function sideHasFactory(side) {
  return S.buildings.some(b => b.side === side && b.kind === 'factory' && b.hp > 0);
}
function placeBuildAtMouse() {
  if (!S.selectedBuild || !S.mouseWorld) return;
  const p = S.mouseWorld;
  const msg = { type: 'build', kind: S.selectedBuild, x: Math.round(p.x), y: Math.round(p.y) };
  if (S.selectedBuild === 'bridge') {
    if (S.bridgeAxis === 'h') msg.horizontal = true;
    else if (S.bridgeAxis === 'v') msg.horizontal = false;
  }
  sendMsg(msg);
  S.selectedBuild = null;
  S.bridgeAxis = null;
  sfxClick();
}

/* ------------------------------------------------------------ */
/*  armory                                                      */
/* ------------------------------------------------------------ */
function openArmory() {
  if (!S.me) return;
  renderArmory();
  openModal('modalArmory');
}
function renderArmory() {
  const me = S.me;
  const mod = (S.war ? S.war.popMod : 1) * (sideHasFactory(me.side) ? 0.78 : 1);
  $('armoryStock').innerHTML = `${stockHTML(S.stock[me.side] || {})}
    <span>COST MOD <b>×${mod.toFixed(2)}</b></span>`;
  const wEl = $('weaponCards'); wEl.innerHTML = '';
  for (const [key, w] of Object.entries(S.config.weapons)) {
    const locked = !me.registered || me.rank < w.minRank;
    const active = me.weapon === key;
    const card = document.createElement('button');
    card.className = 'card' + (locked ? ' locked' : '');
    card.innerHTML = `
      <div class="c-rank">${w.minRank > 0 ? (S.ranks[w.minRank] ? S.ranks[w.minRank].tag : 'R' + w.minRank) : 'PVT'}</div>
      <div class="c-name">${w.name.toUpperCase()}</div>
      <div class="c-desc">${w.kind.toUpperCase()} · ${w.mag} ROUNDS · ${w.reload}s RELOAD</div>
      <div class="c-stats"><span>DMG <b>${w.dmg}</b></span><span>RATE <b>${(1 / w.rate).toFixed(1)}/s</b></span><span>RANGE <b>${w.range}</b></span></div>
      <div class="c-cost">${costText(w.cost, mod)}</div>
      ${active ? '<div class="c-badge">EQUIPPED</div>' : locked ? '<div class="c-badge" style="background:#5a2e2a;color:#e2574a">RANK LOCKED</div>' : '<div class="c-badge">EQUIP</div>'}`;
    card.onclick = () => { if (locked) return toast('Rank or enlistment required', 'red'); sendMsg({ type: 'equip', weapon: key, armor: me.armor }); sfxClick(); };
    wEl.appendChild(card);
  }
  const aEl = $('armorCards'); aEl.innerHTML = '';
  for (const [key, a] of Object.entries(S.config.armor)) {
    if (key === 'none') continue;
    const locked = !me.registered || me.rank < a.minRank;
    const active = me.armor === key;
    const card = document.createElement('button');
    card.className = 'card' + (locked ? ' locked' : '');
    card.innerHTML = `
      <div class="c-rank">${a.minRank > 0 ? (S.ranks[a.minRank] ? S.ranks[a.minRank].tag : 'R' + a.minRank) : 'PVT'}</div>
      <div class="c-name">${a.name.toUpperCase()}</div>
      <div class="c-stats"><span>DMG REDUCTION <b>${Math.round(a.reduction * 100)}%</b></span><span>MOVE <b>${Math.round(a.speed * 100)}%</b></span></div>
      <div class="c-cost">${costText(a.cost, mod)}</div>
      ${active ? '<div class="c-badge">EQUIPPED</div>' : locked ? '<div class="c-badge" style="background:#5a2e2a;color:#e2574a">RANK LOCKED</div>' : '<div class="c-badge">EQUIP</div>'}`;
    card.onclick = () => { if (locked) return toast('Rank or enlistment required', 'red'); sendMsg({ type: 'equip', weapon: me.weapon, armor: key }); sfxClick(); };
    aEl.appendChild(card);
  }
  const vEl = $('vehicleCards'); vEl.innerHTML = '';
  for (const [key, v] of Object.entries(S.config.vehicles)) {
    const locked = !me.registered || me.rank < v.minRank;
    const card = document.createElement('button');
    card.className = 'card' + (locked ? ' locked' : '');
    card.innerHTML = `
      <div class="c-rank">${v.minRank > 0 ? (S.ranks[v.minRank] ? S.ranks[v.minRank].tag : 'R' + v.minRank) : 'PVT'}</div>
      <div class="c-name">${v.name.toUpperCase()}</div>
      <div class="c-desc">ARMOR ${Math.round(v.armor * 100)}% · SPEED ${v.speed} · ${v.gun ? 'MOUNTED MG' : 'SUPPLY'}</div>
      <div class="c-stats"><span>HULL <b>${v.hp}</b></span></div>
      <div class="c-cost">${costText(v.cost, mod)}</div>
      ${locked ? '<div class="c-badge" style="background:#5a2e2a;color:#e2574a">RANK LOCKED</div>' : '<div class="c-badge">REQUEST</div>'}`;
    card.onclick = () => {
      if (locked) return toast('Rank or enlistment required', 'red');
      const p = myPos();
      sendMsg({ type: 'vehicle_request', kind: key, x: Math.round(p.x + 40), y: Math.round(p.y) });
      sfxClick();
    };
    vEl.appendChild(card);
  }
  if (!me.registered) toast('ENLIST TO UNLOCK THE ARMORY', 'red');
}

/* ------------------------------------------------------------ */
/*  profile                                                     */
/* ------------------------------------------------------------ */
function openProfile() {
  openModal('modalProfile');
  $('profileBody').innerHTML = '<div class="modal-sub">Retrieving service record…</div>';
  sendMsg({ type: 'profile' });
}
function renderProfile(user) {
  const rk = (user.rank >= 0 && S.ranks[user.rank]) ? S.ranks[user.rank].name : 'Guest Infantry';
  const s = user.stats || {};
  const row = (label, val) => `<div><span>${label}</span><b>${val}</b></div>`;
  $('profileBody').innerHTML = `
    <div class="profile-head">
      <div><div class="profile-name">${escapeHtml(user.username || '—')}</div>
      <div class="profile-rank">${rk.toUpperCase()} · ${user.username ? 'ENLISTED' : 'UNREGISTERED GUEST'}</div></div>
      <div style="text-align:right"><div class="profile-rank">XP</div><div class="profile-name" style="font-size:24px">${user.xp || 0}</div></div>
    </div>
    <div class="profile-grid">
      ${row('Kills', s.kills || 0)}
      ${row('Deaths', s.deaths || 0)}
      ${row('K/D', (s.deaths ? (s.kills / s.deaths).toFixed(2) : (s.kills || 0).toFixed(2)))}
      ${row('Buildings built', s.buildings || 0)}
      ${row('Kilometres walked', ((s.kmWalked || 0)).toFixed(2) + ' km')}
      ${row('Kilometres driven', ((s.kmDriven || 0)).toFixed(2) + ' km')}
      ${row('Wars won', s.warsWon || 0)}
      ${row('Wars lost', s.warsLost || 0)}
      ${row('Wars served', s.warsTotal || 0)}
      ${row('Items produced', s.itemsProduced || 0)}
      ${row('Sectors captured', s.captures || 0)}
      ${row('Campaigns on record', user.wars || 0)}
    </div>
    <div class="profile-actions"><button id="btnProfileRanks" class="ghost small">RANKS &amp; EXPERIENCE</button></div>
    <div class="profile-ranks hidden" id="profileRanks"></div>
    <div class="profile-note">Rank is earned through combat, construction, production and capture. Sides are locked once per campaign. Guests may fight as infantry but cannot earn rank or use the war economy.</div>`;
  const rb = $('btnProfileRanks');
  if (rb) rb.onclick = () => {
    const panel = $('profileRanks');
    if (!panel) return;
    panel.classList.toggle('hidden');
    if (panel.classList.contains('hidden')) return;
    const rows = S.ranks.map((r, i) => {
      const active = (user.rank | 0) === i;
      return `<div class="rank-line${active ? ' active' : ''}">
        <span class="rk-tag">${r.tag}</span>
        <span class="rk-name">${r.name.toUpperCase()}</span>
        <span class="rk-xp">${r.xp} XP</span>
      </div>`;
    }).join('');
    panel.innerHTML = `<div class="rank-title">RANKS OF THE CAMPAIGN</div>${rows}
      <div class="rank-foot">Your rank resets when the campaign ends. Experience is earned in battle, construction and supply work.</div>`;
  };
}

/* ------------------------------------------------------------ */
/*  map / pause                                                 */
/* ------------------------------------------------------------ */
function toggleMap() {
  if (S.mode !== 'hud') return;
  if (!$('modalMap').classList.contains('hidden')) { closeModal('modalMap'); return; }
  drawBigMap();
  openModal('modalMap');
}
function togglePause() {
  if (S.mode !== 'hud' && S.mode !== 'death') return;
  if (!$('pause').classList.contains('hidden')) { closeModal('pause'); S.paused = false; return; }
  openModal('pause'); S.paused = true;
  S.keys = {}; S.mouse.down = false; S.touch.fire = false;
}
function toggleSound() {
  S.mute = !S.mute;
  const b = $('btnSound');
  if (b) b.textContent = 'SOUND: ' + (S.mute ? 'OFF' : 'ON');
  if (S.ambience) S.ambience.g.gain.value = S.mute ? 0 : 0.035;
  if (!S.mute) { initAudio(); sfxClick(); }
}

/* ------------------------------------------------------------ */
/*  markers / artillery                                         */
/* ------------------------------------------------------------ */
function placeMarker(order) {
  if (S.mode !== 'hud' || !S.me || S.me.dead) return;
  if (order && (!S.me.registered || S.me.rank < 6)) return toast('Command rank required (Captain+)', 'red');
  const p = S.mouseWorld || myPos();
  sendMsg({ type: 'marker', x: Math.round(p.x), y: Math.round(p.y), order });
  sfxClick();
  toast(order ? 'ORDER TAG PLACED' : 'MARKER PLACED', 'amber');
}
function addMarker(mk) {
  if (!mk) return;
  if (!S.markers.some(m => m.id === mk.id)) S.markers.push(mk);
}
function startBarrage() {
  if (!S.me) return;
  if (!S.me.registered || S.me.rank < 6) return toast('Command rank required (Captain+)', 'red');
  S.artillery = true;
  toast('ARTILLERY — CLICK TARGET (120 AMMO)', 'amber');
}
function fireBarrageAtMouse() {
  if (!S.artillery || !S.mouseWorld) return;
  sendMsg({ type: 'barrage', x: Math.round(S.mouseWorld.x), y: Math.round(S.mouseWorld.y) });
  S.artillery = false;
  sfxClick();
}

/* ------------------------------------------------------------ */
/*  misc handlers                                               */
/* ------------------------------------------------------------ */
function onVehicleMsg(msg) {
  if (msg.vehicle) toast(`CREWING ${(S.config.vehicles[msg.vehicle.kind] || {}).name || 'VEHICLE'}`.toUpperCase(), 'gold');
  else toast('DISMOUNTED', 'amber');
}
function onRankup(msg) {
  if (S.me && msg.id === S.me.id) {
    addSystem(`You are promoted to ${msg.rankName}`, 'warn');
    toast(`PROMOTED — ${msg.rankName.toUpperCase()}`, 'gold');
  }
}

/* ------------------------------------------------------------ */
/*  wiring                                                      */
/* ------------------------------------------------------------ */
function setupUI() {
  $('btnLogin').onclick = () => { initAudio(); doLogin(); };
  $('btnRegister').onclick = () => { initAudio(); doRegister(); };
  $('btnGuest').onclick = () => { doGuest(); };
  $('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('pickRed').onclick = () => chooseSide('red');
  $('pickBlue').onclick = () => chooseSide('blue');
  $('btnDeploy').onclick = deployNow;
  $('btnArmory').onclick = openArmory;
  $('btnProfileTop').onclick = openProfile;
  $('btnRespawn').onclick = () => {
    sendMsg({ type: 'spawn', point: S.deathSpawn || 'mob' });
    $('death').classList.add('hidden');
    showScreen('hud');
    S.mode = 'hud';
    S.deployed = true;
  };
  const wPrev = $('warPrev'), wNext = $('warNext');
  if (wPrev) wPrev.onclick = () => warPageStep(-1);
  if (wNext) wNext.onclick = () => warPageStep(1);
  $('btnTune').onclick = tuneRadio;
  $('btnSend').onclick = sendChat;
  const bRadio = $('btnRadio');
  if (bRadio) bRadio.onclick = toggleRadio;
  const bRadioClose = $('btnRadioClose');
  if (bRadioClose) bRadioClose.onclick = closeRadio;
  $('chatInput').addEventListener('keydown', (e) => { if (e.code === 'Enter') { e.preventDefault(); sendChat(); } });
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => {
    const id = b.dataset.close;
    closeModal(id);
    if (id === 'pause') S.paused = false;
  });
  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('mousedown', (e) => {
      if (e.target === m) { m.classList.add('hidden'); if (m.id === 'pause') S.paused = false; }
    });
  });
  document.querySelectorAll('.act').forEach(b => {
    b.onclick = () => {
      const act = b.dataset.act;
      if (act === 'build') openBuild();
      else if (act === 'armory') openArmory();
      else if (act === 'map') toggleMap();
      else if (act === 'score') toggleScoreboard();
      else if (act === 'marker') placeMarker(false);
      else if (act === 'order') placeMarker(true);
      else if (act === 'barrage') startBarrage();
      else if (act === 'interact') sendMsg({ type: 'interact' });
      else if (act === 'vehicle') sendMsg({ type: 'vehicle' });
      else if (act === 'profile') openProfile();
    };
  });
  $('btnResume').onclick = () => { closeModal('pause'); S.paused = false; };
  $('btnSound').onclick = toggleSound;
  $('btnLeave').onclick = () => { location.reload(); };
  // map click for deploy not needed
  renderChat();
}

setupUI();
