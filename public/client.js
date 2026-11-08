/* Мистеромания — клиент */
(() => {
  const $ = (id) => document.getElementById(id);
  const show = (id) => { ['login', 'captcha', 'game'].forEach((s) => $(s).classList.toggle('hidden', s !== id)); };

  // ================= ВХОД =================
  let session = null; // { sessionId, mode, startedAt, serverNow, minMs }

  $('notRobot').onclick = async () => {
    const nickname = $('nick').value.trim();
    const mode = document.querySelector('input[name=mode]:checked').value;
    $('loginError').textContent = '';
    if (nickname.length < 2) { $('loginError').textContent = 'Введи никнейм (мин. 2 символа).'; return; }
    $('notRobot').disabled = true;
    try {
      const r = await fetch('/api/captcha/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname, mode }),
      });
      const data = await r.json();
      if (!data.ok) { $('loginError').textContent = data.reason; return; }
      session = data;
      session.serverOffset = data.serverNow - Date.now();
      openCaptcha();
    } catch (e) {
      $('loginError').textContent = 'Сервер недоступен: ' + e.message;
    } finally {
      $('notRobot').disabled = false;
    }
  };

  // ================= КАПЧА (PAINT) =================
  const paint = $('paint');
  const pctx = paint.getContext('2d');
  pctx.fillStyle = '#ffffff';
  pctx.fillRect(0, 0, paint.width, paint.height);
  pctx.lineCap = 'round';
  pctx.lineJoin = 'round';

  let strokes = [];
  let drawing = false;
  let current = null;
  let erasing = false;

  function pos(e) {
    const r = paint.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * paint.width, ((e.clientY - r.top) / r.height) * paint.height];
  }
  paint.addEventListener('pointerdown', (e) => {
    drawing = true;
    paint.setPointerCapture(e.pointerId);
    current = { color: erasing ? '#ffffff' : $('color').value, size: +$('size').value, points: [pos(e)] };
    strokes.push(current);
    dot(current, current.points[0]);
  });
  paint.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pos(e);
    const last = current.points[current.points.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 2) return;
    current.points.push(p);
    line(current, last, p);
  });
  const stop = () => { drawing = false; current = null; };
  paint.addEventListener('pointerup', stop);
  paint.addEventListener('pointercancel', stop);

  function dot(s, p) {
    pctx.fillStyle = s.color;
    pctx.beginPath();
    pctx.arc(p[0], p[1], s.size / 2, 0, Math.PI * 2);
    pctx.fill();
  }
  function line(s, a, b) {
    pctx.strokeStyle = s.color;
    pctx.lineWidth = s.size;
    pctx.beginPath();
    pctx.moveTo(a[0], a[1]);
    pctx.lineTo(b[0], b[1]);
    pctx.stroke();
  }
  $('eraser').onclick = () => { erasing = !erasing; $('eraser').classList.toggle('active', erasing); };
  $('clear').onclick = () => {
    strokes = [];
    pctx.fillStyle = '#ffffff';
    pctx.fillRect(0, 0, paint.width, paint.height);
  };

  // Таймер обычной капчи (5 минут). Сервер тоже проверяет время — двойная защита.
  let timerInt = null;
  function openCaptcha() {
    show('captcha');
    $('capError').textContent = '';
    strokes = [];
    pctx.fillStyle = '#ffffff';
    pctx.fillRect(0, 0, paint.width, paint.height);
    const creative = session.mode === 'creative';
    $('capTimer').classList.toggle('hidden', creative);
    $('capHint').textContent = creative
      ? '🎨 Творческий режим: рисуй сколько угодно — это искусство! Когда допишешь шедевр — жми «О\'кей». Не жульничай: одна точка/линия не пройдёт.'
      : '⏱ Обычная капча: рисуй себя, пока идёт таймер. Кнопка «О\'кей» разблокируется только через 5 минут (проверяет сервер). Одна точка или линия = бан попытки.';
    $('capOk').disabled = !creative;
    clearInterval(timerInt);
    if (!creative) {
      const endAt = session.startedAt + session.minMs;
      const tickTimer = () => {
        const left = endAt - (Date.now() + session.serverOffset);
        if (left <= 0) {
          $('timerText').textContent = '0:00 — можно нажимать О\'кей!';
          $('capOk').disabled = false;
          clearInterval(timerInt);
          return;
        }
        const s = Math.ceil(left / 1000);
        $('timerText').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        if (!$('capOk').disabled) $('capOk').disabled = true;
      };
      tickTimer();
      timerInt = setInterval(tickTimer, 500);
    }
  }

  $('capOk').onclick = async () => {
    if (!session) return;
    $('capOk').disabled = true;
    $('capError').textContent = 'Проверяю рисунок на сервере…';
    try {
      const r = await fetch('/api/captcha/ok', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: session.sessionId,
          nickname: $('nick').value.trim(),
          strokes,
          image: paint.toDataURL('image/png'),
        }),
      });
      const data = await r.json();
      if (data.ok) {
        clearInterval(timerInt);
        $('capError').textContent = '✅ Капча пройдена! Вход в игру…';
        startGame(data.token, data.nickname);
      } else {
        $('capError').textContent = '🚫 ' + data.reason + '\nНачни капчу заново.';
        // сброс: новая сессия при следующем нажатии
        session = null;
        setTimeout(() => { show('login'); }, 2600);
      }
    } catch (e) {
      $('capError').textContent = 'Ошибка сети: ' + e.message;
      $('capOk').disabled = false;
    }
  };

  // ================= ИГРА =================
  const world = $('world');
  const wctx = world.getContext('2d');
  let socket = null;
  let myId = null;
  let worldSize = { w: 2400, h: 2400 };
  let types = [];
  let state = { players: [], misters: [] };
  let myNick = '';
  const imgCache = {};
  function img(src) {
    if (!imgCache[src]) { const i = new Image(); i.src = src; imgCache[src] = i; }
    return imgCache[src];
  }
  const typeImg = (key) => img(`/img/m${key}.png`);

  const keys = {};
  const mouse = { x: 0, y: 0, down: false };
  let camX = 0, camY = 0;
  let effects = []; // {type,x,y,t}

  function startGame(token, nick) {
    myNick = nick;
    show('game');
    resize();
    socket = io({ auth: { token } });

    socket.on('welcome', (d) => {
      myId = d.id;
      worldSize = d.world;
      types = d.types;
      buildTeamRow([]);
    });
    socket.on('state', (s) => {
      state = s;
      const me = s.players.find((p) => p.id === myId);
      if (me) {
        camX += (me.x - camX) * 0.2;
        camY += (me.y - camY) * 0.2;
        updateHud(me, s.players);
        if (me.team.length !== lastTeamSize) { lastTeamSize = me.team.length; buildTeamRow(me.team); }
      }
    });
    socket.on('ev', (e) => {
      if (e.type === 'swing' || e.type === 'thit') effects.push({ ...e, t: performance.now() });
      if (e.text) feed(e.text);
      const me = state.players.find((p) => p.id === myId);
      if (me && e.id === myId && (e.type === 'hit' || e.type === 'death' || e.type === 'respawn' || e.type === 'capture')) {
        // обновится на следующем state
      }
    });
    socket.on('connect_error', (e) => feed('⚠ ' + e.message));

    // ввод
    addEventListener('keydown', (e) => { keys[e.key.toLowerCase()] = true; });
    addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });
    world.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
    world.addEventListener('mousedown', (e) => { mouse.down = true; });
    addEventListener('mouseup', () => { mouse.down = false; });
    world.addEventListener('contextmenu', (e) => e.preventDefault());

    setInterval(sendInput, 50);
    requestAnimationFrame(render);
  }

  let lastTeamSize = -1;
  function sendInput() {
    if (!socket || !socket.connected) return;
    const me = state.players.find((p) => p.id === myId);
    const wx = mouse.x + camX - world.width / 2;
    const wy = mouse.y + camY - world.height / 2;
    const angle = me ? Math.atan2(wy - me.y, wx - me.x) : 0;
    socket.emit('input', {
      up: keys['w'] || keys['arrowup'], down: keys['s'] || keys['arrowdown'],
      left: keys['a'] || keys['arrowleft'], right: keys['d'] || keys['arrowright'],
      mx: wx, my: wy, angle, attacking: mouse.down,
    });
  }

  function resize() {
    world.width = innerWidth;
    world.height = innerHeight;
  }
  addEventListener('resize', resize);

  function updateHud(me, players) {
    $('hpFill').style.width = Math.max(0, (me.hp / me.maxHp) * 100) + '%';
    $('hpFill').style.background = me.hp > 40 ? 'linear-gradient(90deg,#43d17c,#a5e88a)' : 'linear-gradient(90deg,#e53935,#ff8a65)';
    $('hpText').textContent = `${me.hp}/${me.maxHp}`;
    $('score').textContent = me.score;
    $('kills').textContent = me.kills;
    $('online').textContent = players.length;
    $('playerList').innerHTML = players.map((p) =>
      `<li class="${p.id === myId ? 'me' : ''}">${escHtml(p.nick)} — ⭐${p.score} (👥${p.team.length})</li>`).join('');
    $('deathOverlay').classList.toggle('hidden', me.alive);
    if (!me.alive) $('respawnSec').textContent = '4';
  }

  function buildTeamRow(team) {
    $('teamRow').innerHTML = team.map((t) => `<img src="/img/m${t.type}.png" title="Мистер ${t.type} в команде">`).join('');
  }

  function feed(text) {
    const f = $('feed');
    const d = document.createElement('div');
    d.textContent = text;
    f.appendChild(d);
    while (f.children.length > 7) f.removeChild(f.firstChild);
    setTimeout(() => { d.style.opacity = '0'; d.style.transition = 'opacity .6s'; setTimeout(() => d.remove(), 650); }, 6000);
  }

  function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  function render(now) {
    requestAnimationFrame(render);
    if (!state.players.length && myId === null) { wctx.fillStyle = '#0d0d16'; wctx.fillRect(0, 0, world.width, world.height); return; }
    const me = state.players.find((p) => p.id === myId);
    if (me && (camX === 0 && camY === 0)) { camX = me.x; camY = me.y; }
    const ox = world.width / 2 - camX;
    const oy = world.height / 2 - camY;

    // фон
    wctx.fillStyle = '#101018';
    wctx.fillRect(0, 0, world.width, world.height);
    wctx.strokeStyle = '#1d1d2e';
    wctx.lineWidth = 1;
    const step = 100;
    for (let x = -((camX - world.width / 2) % step); x < world.width; x += step) { wctx.beginPath(); wctx.moveTo(x, 0); wctx.lineTo(x, world.height); wctx.stroke(); }
    for (let y = -((camY - world.height / 2) % step); y < world.height; y += step) { wctx.beginPath(); wctx.moveTo(0, y); wctx.lineTo(world.width, y); wctx.stroke(); }
    // границы мира
    wctx.strokeStyle = '#6a5af9';
    wctx.lineWidth = 4;
    wctx.strokeRect(ox, oy, worldSize.w, worldSize.h);

    // мистеры-враги
    for (const m of state.misters) {
      const x = m.x + ox, y = m.y + oy;
      if (x < -80 || y < -80 || x > world.width + 80 || y > world.height + 80) continue;
      const t = types.find((tt) => tt.key === m.type) || { r: 36, name: m.type };
      const im = typeImg(m.type);
      const s = t.r * 2;
      wctx.save();
      wctx.translate(x, y);
      if (m.flash) { wctx.shadowColor = '#fff'; wctx.shadowBlur = 18; }
      if (im.complete && im.naturalWidth) wctx.drawImage(im, -s / 2, -s / 2, s, s);
      else { wctx.fillStyle = '#a33'; wctx.beginPath(); wctx.arc(0, 0, t.r, 0, Math.PI * 2); wctx.fill(); }
      wctx.restore();
      // полоса хп
      const w = t.r * 2;
      wctx.fillStyle = '#000a'; wctx.fillRect(x - w / 2, y - t.r - 12, w, 6);
      wctx.fillStyle = '#ff5252'; wctx.fillRect(x - w / 2, y - t.r - 12, w * (m.hp / m.maxHp), 6);
      wctx.fillStyle = '#fff'; wctx.font = '11px system-ui'; wctx.textAlign = 'center';
      wctx.fillText('Мистер ' + m.type, x, y + t.r + 14);
    }

    // игроки (сосуды) и их команды
    for (const p of state.players) {
      // команда
      for (const tm of p.team) {
        const x = tm.x + ox, y = tm.y + oy;
        const t = types.find((tt) => tt.key === tm.type) || { r: 30 };
        const im = typeImg(tm.type);
        const s = t.r * 1.5;
        wctx.save();
        wctx.translate(x, y);
        wctx.shadowColor = '#6a5af9'; wctx.shadowBlur = 10;
        if (im.complete && im.naturalWidth) wctx.drawImage(im, -s / 2, -s / 2, s, s);
        wctx.restore();
      }
      if (!p.alive) continue;
      const x = p.x + ox, y = p.y + oy;
      const im = img('/img/vessel.png');
      const s = 76;
      wctx.save();
      wctx.translate(x, y);
      wctx.rotate(p.angle || 0);
      if (im.complete && im.naturalWidth) wctx.drawImage(im, -s / 2, -s / 2, s, s);
      else { wctx.fillStyle = '#888'; wctx.fillRect(-20, -20, 40, 40); }
      wctx.restore();
      // ник + хп
      wctx.fillStyle = p.id === myId ? '#ffd54f' : '#fff';
      wctx.font = 'bold 13px system-ui'; wctx.textAlign = 'center';
      wctx.fillText(p.nick, x, y - 48);
      const w = 60;
      wctx.fillStyle = '#000a'; wctx.fillRect(x - w / 2, y - 42, w, 6);
      wctx.fillStyle = '#43d17c'; wctx.fillRect(x - w / 2, y - 42, w * (p.hp / p.maxHp), 6);
    }

    // эффекты ударов
    effects = effects.filter((e) => now - e.t < 220);
    for (const e of effects) {
      const x = e.x + ox, y = e.y + oy;
      const a = 1 - (now - e.t) / 220;
      wctx.strokeStyle = `rgba(255,255,255,${a})`;
      wctx.lineWidth = 3;
      wctx.beginPath(); wctx.arc(x, y, 20 + (1 - a) * 30, 0, Math.PI * 2); wctx.stroke();
    }

    // прицел
    wctx.strokeStyle = '#ff5252';
    wctx.lineWidth = 2;
    wctx.beginPath(); wctx.arc(mouse.x, mouse.y, 12, 0, Math.PI * 2); wctx.stroke();
    wctx.beginPath();
    wctx.moveTo(mouse.x - 18, mouse.y); wctx.lineTo(mouse.x - 6, mouse.y);
    wctx.moveTo(mouse.x + 6, mouse.y); wctx.lineTo(mouse.x + 18, mouse.y);
    wctx.moveTo(mouse.x, mouse.y - 18); wctx.lineTo(mouse.x, mouse.y - 6);
    wctx.moveTo(mouse.x, mouse.y + 6); wctx.lineTo(mouse.x, mouse.y + 18);
    wctx.stroke();
  }

  show('login');
})();
