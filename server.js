// Сервер «Мистеромания»: капча «нарисуй себя» + онлайн-бои.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./db');
const { validateCaptcha } = require('./anticheat');
const { Game } = require('./game');

const PORT = process.env.PORT || 3000;
const NORMAL_CAPTCHA_MS = 5 * 60 * 1000; // 5 минут для обычной капчи
const MAX_FAILS_PER_IP = 3;              // после 3 провалов — бан на 10 минут
const BAN_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 60 * 60 * 1000;   // капча-сессия живёт час

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 8 * 1024 * 1024 });

app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const game = new Game(io);

const NICK_RE = /^[\p{L}\p{N}_\- ]{2,16}$/u;
const ipOf = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- API: капча ----------

// Старт капчи: создаём сессию на сервере (время отсчитывает сервер!)
app.post('/api/captcha/start', (req, res) => {
  const { nickname, mode } = req.body || {};
  const ip = ipOf(req);

  const ban = db.getBan(ip);
  if (ban && ban.until > Date.now()) {
    return res.status(403).json({ ok: false, reason: `Вы забанены за жульничество до ${new Date(ban.until).toLocaleTimeString('ru-RU')}. Нарисуйте себя по-нормальному!` });
  }
  if (!nickname || !NICK_RE.test(nickname)) {
    return res.status(400).json({ ok: false, reason: 'Никнейм: 2–16 символов (буквы, цифры, _ - пробел).' });
  }
  if (mode !== 'normal' && mode !== 'creative') {
    return res.status(400).json({ ok: false, reason: 'Выберите режим капчи.' });
  }
  if (db.playerByNick(nickname)) {
    return res.status(409).json({ ok: false, reason: `Ник «${nickname}» уже занят. Придумайте другой.` });
  }
  const sessionId = crypto.randomBytes(24).toString('hex');
  db.startSession(sessionId, nickname, mode, ip, String(req.headers['user-agent'] || '').slice(0, 300));
  res.json({
    ok: true, sessionId, mode, startedAt: Date.now(), serverNow: Date.now(),
    minMs: mode === 'normal' ? NORMAL_CAPTCHA_MS : 0,
    canvas: { w: 960, h: 600 },
  });
});

// Подтверждение капчи: сервер проверяет время И рисунок.
app.post('/api/captcha/ok', (req, res) => {
  const { sessionId, nickname, strokes, image } = req.body || {};
  const ip = ipOf(req);

  const ban = db.getBan(ip);
  if (ban && ban.until > Date.now()) {
    return res.status(403).json({ ok: false, reason: 'Бан за жульничество активен. Нарисуйте себя по-нормальному в следующий раз.' });
  }
  const session = db.getSession(sessionId);
  if (!session) return res.status(404).json({ ok: false, reason: 'Сессия капчи не найдена. Начните заново.' });
  if (session.finished_at) return res.status(409).json({ ok: false, reason: 'Эта капча уже завершена. Начните заново.' });
  if (Date.now() - session.started_at > SESSION_TTL_MS) {
    db.finishSession(sessionId, false);
    return res.status(410).json({ ok: false, reason: 'Время капчи истекло. Начните заново.' });
  }
  if (session.nickname !== nickname) return res.status(400).json({ ok: false, reason: 'Никнейм не совпадает с сессией.' });

  const elapsedMs = Date.now() - session.started_at;
  const result = validateCaptcha({ mode: session.mode, elapsedMs, strokes, imageDataUrl: image });

  // сохраняем ВСЁ в базу: и честные рисунки, и попытки обмана
  let metrics = null;
  try { metrics = JSON.stringify(result.metrics || null); } catch { metrics = null; }
  db.saveDrawing(sessionId, session.nickname, session.mode,
    JSON.stringify(strokes || []).slice(0, 200000), String(image || '').slice(0, 2000000),
    metrics, result.ok ? 1 : 0, ip);
  db.finishSession(sessionId, result.ok);

  if (!result.ok) {
    // в бан считаем только жульничество с рисунком (одна точка/линия/пусто), не «сдал раньше 5 минут»
    const fails = result.cheat === false ? 0 : db.failsByIp(ip, Date.now() - 30 * 60 * 1000);
    if (fails >= MAX_FAILS_PER_IP) {
      db.setBan(ip, Date.now() + BAN_MS, 'captcha cheating');
      return res.status(403).json({ ok: false, reason: `Жульничество! ${result.reason} За ${fails} попыток обмана вы забанены на 10 минут.` });
    }
    const suffix = result.cheat === false ? '' : ` (попытка жульничества №${fails}/${MAX_FAILS_PER_IP} — дальше будет бан)`;
    return res.status(422).json({ ok: false, reason: result.reason + suffix });
  }

  // Капча пройдена — создаём игрока и выдаём токен входа в игру
  let player = db.playerByNick(nickname);
  if (!player) player = db.createPlayer(nickname);
  const token = crypto.randomBytes(32).toString('hex');
  db.createToken(token, player.id);
  res.json({ ok: true, token, playerId: player.id, nickname: player.nickname, mode: session.mode, elapsedMs });
});

// ---------- Информационные страницы ----------
app.get('/api/health', (req, res) => res.json({ ok: true, players: game.players.size, misters: game.misters.size, uptime: process.uptime() }));

app.get('/api/stats', (req, res) => {
  const s = db.stats();
  res.json({ ok: true, ...s, online: game.players.size });
});

// Галерея всех капча-рисунков из базы данных
app.get('/gallery', (req, res) => {
  const rows = db.allDrawings();
  const cards = rows.map((r) => `
    <div class="card ${r.passed ? 'ok' : 'cheat'}">
      <img src="${r.image}" alt="рисунок ${esc(r.nickname)}" loading="lazy">
      <div class="meta"><b>${esc(r.nickname)}</b> · ${r.mode === 'creative' ? '🎨 творчество' : '⏱ 5 минут'}<br>
      ${r.passed ? '✅ прошёл' : '🚫 жульничество'}<br><small>${new Date(r.created_at).toLocaleString('ru-RU')}</small></div>
    </div>`).join('');
  res.send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Галерея капч — Мистеромания</title>
<style>
body{font-family:system-ui;background:#14141f;color:#eee;margin:0;padding:24px}
h1{font-size:22px} a{color:#8ab4ff}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin-top:16px}
.card{background:#1e1e2e;border-radius:10px;overflow:hidden;border:2px solid #333}
.card.ok{border-color:#2e7d32}.card.cheat{border-color:#b71c1c;opacity:.75}
.card img{width:100%;height:160px;object-fit:contain;background:#fff;display:block}
.meta{padding:8px 10px;font-size:12px;line-height:1.5}
</style></head><body>
<h1>🖼 Галерея капч «Нарисуй себя» (из базы данных)</h1>
<p>Всего рисунков: ${rows.length}. <a href="/">← назад в игру</a> · <a href="/api/stats">статистика JSON</a></p>
<div class="grid">${cards || '<p>Пока пусто.</p>'}</div>
</body></html>`);
});

// ---------- Сокеты: вход только с токеном после капчи ----------
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const row = token && db.getToken(token);
  if (!row) return next(new Error('Нужно пройти капчу «нарисуй себя»!'));
  socket.data.token = token;
  socket.data.player = row;
  next();
});

io.on('connection', (socket) => {
  const p = game.addPlayer(socket, { id: socket.data.player.player_id, nickname: socket.data.player.nickname });
  socket.emit('captures', db.capturesOf(p.id));

  socket.on('input', (input) => game.setInput(p.id, input));

  socket.on('disconnect', () => {
    game.removePlayer(p.id);
    db.deleteToken(socket.data.token);
  });
});

server.listen(PORT, () => {
  console.log(`Мистеромания запущена: http://localhost:${PORT}`);
});
