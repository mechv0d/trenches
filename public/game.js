const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
let ws;
let me = null;
let world = null;
let players = [];
let bots = [];
let bullets = [];
let buildings = [];
let resources = [];
let war = null;
let trenches = new Set();
let ranks = [];
let markers = [];
let chatMsgs = [];
let keys = {};
let mouse = { x: 0, y: 0 };
let cam = { x: 0, y: 0 };
let fast = new URLSearchParams(location.search).has('fast');

// login flow
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {};
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleServer(msg);
  };
  ws.onclose = () => { console.log('disconnected'); };
}

function handleServer(msg) {
  switch (msg.type) {
    case 'init':
      world = msg.world; war = msg.war; ranks = msg.ranks;
      trenches = new Set(msg.trenches);
      me = msg.player;
      break;
    case 'state':
      players = msg.players; bots = msg.bots; bullets = msg.bullets;
      buildings = msg.buildings; resources = msg.resources; war = msg.war;
      const meNew = players.find(p => p.id === me.id);
      if (meNew) me = meNew;
      break;
    case 'chat':
      chatMsgs.push(msg);
      if (chatMsgs.length > 50) chatMsgs.shift();
      renderChat();
      break;
    case 'marker':
      markers.push(msg);
      if (markers.length > 100) markers.shift();
      break;
    case 'building_placed':
      buildings.push(msg.building);
      break;
    case 'resource_update':
      const r = resources.find(x => x.id === msg.r.id);
      if (r) r.amount = msg.r.amount;
      break;
    case 'rankup':
      if (me && msg.id === me.id) { me.rank = msg.rank; }
      break;
    case 'respawned':
      if (me) { me.x = msg.x; me.y = msg.y; me.hp = me.maxHp; }
      break;
    case 'war_end':
      alert('War ended! Winner: ' + msg.winner);
      break;
    case 'new_war':
      war = msg.war; markers = [];
      break;
    case 'auth_ok':
      me = msg.user;
      break;
    case 'side_set':
      me.side = msg.side ? msg.side : me.side;
      me.x = msg.x; me.y = msg.y;
      break;
    case 'profile':
      showProfile(msg.user);
      break;
  }
}

function showProfile(u) {
  const s = u.stats;
  alert(`Profile ${u.username||'guest'}\nRank: ${ranks[u.rank]||'Guest'}\nSide: ${u.side}\nKills: ${s.kills} Deaths: ${s.deaths}\nBuildings: ${s.buildings}\nWars: ${s.warsTotal} W:${s.warsWon} L:${s.warsLost}\nItems produced: ${s.itemsProduced}`);
}

// auth buttons
document.getElementById('btnGuest').onclick = () => {
  document.getElementById('login').style.display = 'none';
  document.getElementById('wrap').style.display = 'flex';
  connect();
};
document.getElementById('btnLogin').onclick = async () => {
  const u = document.getElementById('uname').value;
  const p = document.getElementById('upass').value;
  const r = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:u,password:p}) });
  const j = await r.json();
  if (!j.ok) { document.getElementById('lmsg').textContent = j.error; return; }
  document.getElementById('login').style.display = 'none';
  document.getElementById('wrap').style.display = 'flex';
  connect();
  // after connect, send auth
  setTimeout(() => { ws.send(JSON.stringify({ type:'auth', username: u })); }, 300);
};
document.getElementById('btnReg').onclick = async () => {
  const u = document.getElementById('uname').value;
  const p = document.getElementById('upass').value;
  const r = await fetch('/api/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:u,password:p}) });
  const j = await r.json();
  if (!j.ok) { document.getElementById('lmsg').textContent = j.error; return; }
  document.getElementById('lmsg').textContent = 'Registered. Now login.';
};

// side selection
document.getElementById('btnRed').onclick = () => { if (ws) ws.send(JSON.stringify({ type:'side_select', side:'red' })); };
document.getElementById('btnBlue').onclick = () => { if (ws) ws.send(JSON.stringify({ type:'side_select', side:'blue' })); };

// radio
document.getElementById('btnSetFreq').onclick = () => {
  const h = +document.getElementById('rHigh').value;
  const l = +document.getElementById('rLow').value;
  if (ws) ws.send(JSON.stringify({ type:'set_freq', high:h, low:l }));
  if (me) me.freq = { high:h, low:l };
};
document.getElementById('btnSend').onclick = sendChat;
document.getElementById('chatInput').addEventListener('keydown', e => { if (e.key==='Enter') sendChat(); });
function sendChat() {
  const t = document.getElementById('chatInput').value.trim();
  if (!t || !ws) return;
  ws.send(JSON.stringify({ type:'chat', text:t }));
  document.getElementById('chatInput').value = '';
}

// build
document.getElementById('btnBuild').onclick = () => {
  if (!me || !ws) return;
  const kind = document.getElementById('buildKind').value;
  ws.send(JSON.stringify({ type:'build', kind, x: me.x, y: me.y }));
};
// actions
document.getElementById('btnMarker').onclick = () => {
  if (!me || !ws) return;
  ws.send(JSON.stringify({ type:'marker', order:false, x: me.x, y: me.y }));
};
document.getElementById('btnOrder').onclick = () => {
  if (!me || !ws) return;
  ws.send(JSON.stringify({ type:'marker', order:true, x: me.x, y: me.y }));
};
document.getElementById('btnGather').onclick = () => { if (ws) ws.send(JSON.stringify({ type:'gather' })); };
document.getElementById('btnProfile').onclick = () => { if (ws) ws.send(JSON.stringify({ type:'profile' })); };

// input
window.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (k==='w') keys.up=true;
  if (k==='s') keys.down=true;
  if (k==='a') keys.left=true;
  if (k==='d') keys.right=true;
  if (k==='shift') keys.sprint=true;
  if (k==='m') document.getElementById('btnMarker').click();
  if (k==='g') document.getElementById('btnGather').click();
  if (k==='b') document.getElementById('btnBuild').click();
  if (me && me.hp<=0 && k==='r') { ws.send(JSON.stringify({type:'respawn'})); }
  sendInput();
});
window.addEventListener('keyup', e => {
  const k = e.key.toLowerCase();
  if (k==='w') keys.up=false;
  if (k==='s') keys.down=false;
  if (k==='a') keys.left=false;
  if (k==='d') keys.right=false;
  if (k==='shift') keys.sprint=false;
  sendInput();
});
canvas.addEventListener('mousemove', e => {
  const rect = canvas.getBoundingClientRect();
  mouse.x = e.clientX - rect.left;
  mouse.y = e.clientY - rect.top;
});
canvas.addEventListener('mousedown', e => {
  if (me) { me.input = me.input||{}; me.input.shoot = true; sendInput(); }
});
function sendInput() {
  if (!ws || !me) return;
  const wx = cam.x + mouse.x;
  const wy = cam.y + mouse.y;
  ws.send(JSON.stringify({ type:'input', input: {
    up: keys.up, down: keys.down, left: keys.left, right: keys.right,
    sprint: keys.sprint, aimX: wx, aimY: wy, shoot: !!(me.input&&me.input.shoot)
  } }));
  if (me.input) me.input.shoot = false;
}

function renderChat() {
  const el = document.getElementById('chat');
  const cur = me ? `${String(me.freq.high).padStart(3,'0')}-${String(me.freq.low).padStart(3,'0')}` : null;
  const shown = cur ? chatMsgs.filter(m => m.freq === cur) : chatMsgs;
  el.innerHTML = shown.map(m => `<div class="msg"><b>${m.from}</b> [${m.freq}]: ${escapeHtml(m.text)}</div>`).join('');
  el.scrollTop = el.scrollHeight;
}
function escapeHtml(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;'); }

// drawing
function isTrenchTile(tx,ty){ return trenches.has(`${tx},${ty}`); }

function draw() {
  if (!world) { requestAnimationFrame(draw); return; }
  // camera follow me
  if (me) {
    cam.x = me.x - canvas.width/2;
    cam.y = me.y - canvas.height/2;
  }
  cam.x = Math.max(0, Math.min(world.w - canvas.width, cam.x));
  cam.y = Math.max(0, Math.min(world.h - canvas.height, cam.y));

  ctx.fillStyle = '#3a4a2a';
  ctx.fillRect(0,0,canvas.width,canvas.height);

  // grid/tiles
  const ts = world.tile;
  const sx = Math.floor(cam.x/ts), sy = Math.floor(cam.y/ts);
  const ex = Math.ceil((cam.x+canvas.width)/ts), ey = Math.ceil((cam.y+canvas.height)/ts);
  for (let ty=sy; ty<ey; ty++) {
    for (let tx=sx; tx<ex; tx++) {
      const key = `${tx},${ty}`;
      const isTr = trenches.has(key);
      const px = tx*ts - cam.x, py = ty*ts - cam.y;
      ctx.fillStyle = isTr ? '#1a2a1a' : '#3a4a2a';
      ctx.fillRect(px,py,ts,ts);
      if (isTr) {
        ctx.strokeStyle = '#0a1a0a'; ctx.strokeRect(px+2,py+2,ts-4,ts-4);
      }
    }
  }

  // resources
  for (const r of resources) {
    if (r.amount<=0) continue;
    const col = r.type==='scrap'?'#888':r.type==='fuel'?'#aa4':'#4a4';
    ctx.fillStyle = col;
    ctx.fillRect(r.x-cam.x-6, r.y-cam.y-6, 12, 12);
  }

  // buildings
  for (const b of buildings) {
    ctx.fillStyle = b.side==='red'?'#a33':'#33a';
    ctx.fillRect(b.x-cam.x-12, b.y-cam.y-12, 24, 24);
    ctx.strokeStyle = '#000'; ctx.strokeRect(b.x-cam.x-12, b.y-cam.y-12, 24, 24);
    // hp bar
    ctx.fillStyle = '#0f0'; ctx.fillRect(b.x-cam.x-12, b.y-cam.y-16, 24*(b.hp/b.maxHp), 3);
  }

  // MOBs
  for (const side of ['red','blue']) {
    const m = war.sides[side].mob;
    ctx.fillStyle = side==='red'?'#f22':'#22f';
    ctx.beginPath(); ctx.arc(m.x-cam.x, m.y-cam.y, 24, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font='10px monospace'; ctx.fillText(side.toUpperCase()+' MOB', m.x-cam.x-20, m.y-cam.y-30);
    ctx.fillStyle = '#0f0'; ctx.fillRect(m.x-cam.x-24, m.y-cam.y-26, 48*(m.hp/m.maxHp), 4);
  }

  // markers
  for (const mk of markers) {
    if (me && mk.side !== me.side) continue; // only allies see markers? spec: allies. orders high rank. keep allies only
    const age = (Date.now()-mk.t)/1000;
    if (age > 60) continue;
    ctx.strokeStyle = mk.kind==='order'?'#ff0':'#fff';
    ctx.beginPath(); ctx.arc(mk.x-cam.x, mk.y-cam.y, 8+age*2, 0, Math.PI*2); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font='10px monospace'; ctx.fillText(mk.kind, mk.x-cam.x+10, mk.y-cam.y);
  }

  // bullets
  for (const b of bullets) {
    ctx.fillStyle = b.side==='red'?'#fa0':'#0af';
    ctx.fillRect(b.x-cam.x-2, b.y-cam.y-2, 4, 4);
  }

  // bots
  for (const b of bots) {
    drawEntity(b, b.side==='red'?'#c33':'#33c', 'B');
  }

  // players
  for (const p of players) {
    const col = p.side==='red'?'#f44':p.side==='blue'?'#44f':'#888';
    drawEntity(p, col, p.id===me?.id ? '*' : '');
  }

  // HUD
  ctx.fillStyle = '#fff'; ctx.font = '14px monospace';
  if (me) {
    ctx.fillText(`HP: ${Math.ceil(me.hp)}/${me.maxHp}  Side: ${me.side||'none'}  Rank: ${me.registered?ranks[me.rank]:'Guest Infantry'}`, 10, 20);
    if (war) {
      const rem = Math.max(0, war.remaining);
      const mins = Math.floor(rem/60000), secs = Math.floor((rem%60000)/1000);
      ctx.fillText(`War: ${mins}:${String(secs).padStart(2,'0')}  Red MOB: ${Math.ceil(war.redMob.hp)}  Blue MOB: ${Math.ceil(war.blueMob.hp)}`, 10, 40);
    }
    // depth indicator
    ctx.fillText(`Depth: ${me.z===-1?'TRENCH':'GROUND'}`, 10, 60);
  }

  // freq label
  if (me) document.getElementById('freqLabel').textContent = `Freq: ${String(me.freq.high).padStart(3,'0')}-${String(me.freq.low).padStart(3,'0')}`;
  // status panel
  if (me) document.getElementById('status').innerHTML =
    `Name: ${me.name}<br/>Registered: ${me.registered}<br/>Side: ${me.side||'choose'}<br/>Rank: ${me.registered?ranks[me.rank]:'Guest'}<br/>Kills: ${me.kills||0} Deaths: ${me.deaths||0}`;

  requestAnimationFrame(draw);
}

function drawEntity(e, col, label) {
  ctx.fillStyle = col;
  ctx.fillRect(e.x-cam.x-8, e.y-cam.y-8, 16, 16);
  // armor indicator
  ctx.strokeStyle = '#ff0'; ctx.lineWidth = 1;
  ctx.strokeRect(e.x-cam.x-10, e.y-cam.y-10, 20, 20);
  ctx.fillStyle = '#fff'; ctx.font = '9px monospace';
  if (label) ctx.fillText(label, e.x-cam.x-3, e.y-cam.y-12);
  if (e.hp < e.maxHp) {
    ctx.fillStyle = '#f00'; ctx.fillRect(e.x-cam.x-8, e.y-cam.y-14, 16, 2);
    ctx.fillStyle = '#0f0'; ctx.fillRect(e.x-cam.x-8, e.y-cam.y-14, 16*(e.hp/e.maxHp), 2);
  }
}

// input loop for sending input periodically
setInterval(() => { if (me && ws && ws.readyState===1) sendInput(); }, 50);

draw();
connect();
// if fast mode
if (fast) { /* server handles via env; client just display */ }
