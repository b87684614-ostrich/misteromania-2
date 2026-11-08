// E2E-тест: капча (честная и жульническая), токен, сокет-игра.
// Запуск: npm test   (поднимает сервер на порту 3100 сам)
const { spawn } = require('child_process');
const zlib = require('zlib');
const path = require('path');

const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;

// --- минимальный энкодер PNG (RGBA, filter 0) для генерации «честного» рисунка ---
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function makePng(w, h, draw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { px[i * 4] = 255; px[i * 4 + 1] = 255; px[i * 4 + 2] = 255; px[i * 4 + 3] = 255; }
  draw((x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const d = (y * w + x) * 4;
    px[d] = r; px[d + 1] = g; px[d + 2] = b; px[d + 3] = 255;
  });
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const toDataUrl = (buf) => 'data:image/png;base64,' + buf.toString('base64');

// «Честный» рисунок: человечек из ~11 мазков, 4 цвета
function honestDrawing() {
  const strokes = [];
  const mk = (color, size, pts) => strokes.push({ color, size, points: pts });
  const circle = (cx, cy, r, n = 48) => Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2; return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  });
  mk('#111111', 8, circle(480, 180, 70));                       // голова
  mk('#111111', 8, [[410, 260], [550, 260], [560, 420], [400, 420], [410, 260]]); // туловище
  mk('#111111', 8, [[410, 290], [300, 360]]);                     // рука
  mk('#111111', 8, [[550, 290], [660, 360]]);                     // рука
  mk('#111111', 8, [[440, 420], [420, 540]]);                     // нога
  mk('#111111', 8, [[520, 420], [540, 540]]);                     // нога
  mk('#e53935', 8, circle(455, 170, 8, 24));                      // глаз
  mk('#e53935', 8, circle(505, 170, 8, 24));                      // глаз
  mk('#1565c0', 8, [[440, 210], [480, 225], [520, 210]]);         // рот
  mk('#2e7d32', 6, [[200, 500], [300, 480], [380, 510], [460, 490], [560, 515], [640, 495], [740, 520]]);
  mk('#f9a825', 6, [[180, 120], [260, 90], [350, 130], [430, 95], [520, 135], [620, 100], [720, 140], [790, 110]]);

  const W = 960, H = 600;
  const png = makePng(W, H, (set) => {
    const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    for (const s of strokes) {
      const [r, g, b] = hex(s.color);
      for (let i = 1; i < s.points.length; i++) {
        const n = Math.ceil(Math.hypot(s.points[i][0] - s.points[i - 1][0], s.points[i][1] - s.points[i - 1][1])) * 2;
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          set(Math.round(s.points[i - 1][0] + (s.points[i][0] - s.points[i - 1][0]) * t),
              Math.round(s.points[i - 1][1] + (s.points[i][1] - s.points[i - 1][1]) * t), r, g, b);
        }
      }
    }
  });
  return { strokes, image: toDataUrl(png) };
}

// «Жульнический» рисунок: одна точка
function cheatDrawing() {
  const png = makePng(960, 600, (set) => set(100, 100, 0, 0, 0));
  return { strokes: [{ color: '#000000', size: 30, points: [[100, 100]] }], image: toDataUrl(png) };
}

async function main() {
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: path.join(__dirname, 'tmp-data') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', (d) => process.stdout.write('[srv] ' + d));
  srv.stderr.on('data', (d) => process.stdout.write('[srv!] ' + d));
  await new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(async () => {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) { clearInterval(iv); res(); }
      } catch { if (Date.now() - t0 > 15000) { clearInterval(iv); rej(new Error('server did not start')); } }
    }, 250);
  });
  console.log('✅ сервер поднят');

  const post = (p, body, ip = '10.0.0.1') => fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
  let pass = 0, failCount = 0;
  const check = (name, cond, debug) => {
    if (cond) { pass++; console.log('✅', name); }
    else { failCount++; console.log('❌', name, debug !== undefined ? '| debug: ' + JSON.stringify(debug).slice(0, 400) : ''); }
  };

  // 1) валидация ника
  let r = await post('/api/captcha/start', { nickname: 'x', mode: 'normal' }, '10.0.0.1');
  check('короткий ник отклонён (400)', r.status === 400, r);

  // 2) обычная капча: попытка сдать сразу → отказ по времени (серверное время!)
  r = await post('/api/captcha/start', { nickname: 'Тестер', mode: 'normal' }, '10.0.0.2');
  check('старт обычной капчи ок', r.status === 200 && r.data && r.data.ok && r.data.minMs === 300000, r);
  const s1 = r.data.sessionId;
  const honest = honestDrawing();
  r = await post('/api/captcha/ok', { sessionId: s1, nickname: 'Тестер', strokes: honest.strokes, image: honest.image }, '10.0.0.2');
  check('капча сдана раньше 5 минут → отклонена', r.status === 422 && /5 минут/i.test((r.data && r.data.reason) || ''), r);

  // 3) творческая капча: жульничество (одна точка) → отклонено
  r = await post('/api/captcha/start', { nickname: 'Жулик', mode: 'creative' }, '10.0.0.3');
  const s2 = r.data.sessionId;
  const cheat = cheatDrawing();
  r = await post('/api/captcha/ok', { sessionId: s2, nickname: 'Жулик', strokes: cheat.strokes, image: cheat.image }, '10.0.0.3');
  check('жульничество (1 точка) отклонено', r.status === 422 && r.data && !r.data.ok, r);

  // 4) творческая капча: одна линия → тоже отклонено
  r = await post('/api/captcha/start', { nickname: 'Линия', mode: 'creative' }, '10.0.0.4');
  const s4 = r.data.sessionId;
  const linePng = makePng(960, 600, (set) => { for (let x = 100; x < 500; x++) set(x, 300, 0, 0, 0); });
  r = await post('/api/captcha/ok', { sessionId: s4, nickname: 'Линия',
    strokes: [{ color: '#000', size: 5, points: Array.from({ length: 60 }, (_, i) => [100 + i * 7, 300]) }],
    image: toDataUrl(linePng) }, '10.0.0.4');
  check('жульничество (одна линия) отклонено', r.status === 422 && r.data && !r.data.ok, r);

  // 5) творческая капча: честный рисунок → токен
  r = await post('/api/captcha/start', { nickname: 'Художник', mode: 'creative' }, '10.0.0.5');
  const s3 = r.data.sessionId;
  r = await post('/api/captcha/ok', { sessionId: s3, nickname: 'Художник', strokes: honest.strokes, image: honest.image }, '10.0.0.5');
  check('честный рисунок принят, выдан токен', r.status === 200 && r.data && r.data.ok && !!r.data.token, r);
  const token = r.data && r.data.token;

  // 6) занятый ник → 409
  r = await post('/api/captcha/start', { nickname: 'художник', mode: 'creative' }, '10.0.0.6');
  check('занятый ник отклонён (409)', r.status === 409, r);

  // 6b) 3 жульничества с одного IP → бан на 10 минут
  const BAN_IP = '10.0.0.9';
  for (let i = 1; i <= 3; i++) {
    const rr = await post('/api/captcha/start', { nickname: 'Бан' + i, mode: 'creative' }, BAN_IP);
    await post('/api/captcha/ok', { sessionId: rr.data.sessionId, nickname: 'Бан' + i, strokes: cheat.strokes, image: cheat.image }, BAN_IP);
  }
  r = await post('/api/captcha/start', { nickname: 'Бан4', mode: 'creative' }, BAN_IP);
  check('3 жульничества → бан IP (403)', r.status === 403 && /бан/i.test((r.data && r.data.reason) || ''), r);

  // 7) сокет без токена → отказ
  const { io: ioc } = require('socket.io-client');
  const bad = ioc(BASE, { auth: { token: 'fake' }, transports: ['websocket'] });
  const badErr = await new Promise((res) => { bad.on('connect_error', res); bad.on('connect', () => res(null)); setTimeout(() => res('timeout'), 4000); });
  check('сокет без токена отклонён', !!badErr && badErr !== 'timeout', badErr);
  bad.close();

  // 8) сокет с токеном → welcome + state
  const sock = ioc(BASE, { auth: { token }, transports: ['websocket'] });
  const welcome = await new Promise((res, rej) => { sock.on('welcome', res); sock.on('connect_error', rej); setTimeout(() => rej(new Error('no welcome')), 5000); });
  check('welcome получен (id, мир, 9 типов мистеров)', !!welcome.id && welcome.world.w === 2400 && welcome.types.length === 9, welcome);
  const st = await new Promise((res, rej) => { sock.on('state', res); setTimeout(() => rej(new Error('no state')), 5000); });
  check('state: есть игрок и мистеры в мире', st.players.length >= 1 && st.misters.length > 0, { players: st.players.length, misters: st.misters.length });

  // 9) input двигает игрока
  const me0 = st.players.find((p) => p.id === welcome.id);
  sock.emit('input', { up: false, down: false, left: false, right: true, mx: 1300, my: 1300, angle: 0, attacking: false });
  await new Promise((res) => setTimeout(res, 700));
  const st2 = await new Promise((res) => { sock.on('state', res); });
  const me1 = st2.players.find((p) => p.id === welcome.id);
  check('игрок двигается по input', !!me0 && !!me1 && me1.x > me0.x, { x0: me0 && me0.x, x1: me1 && me1.x });

  // 10) статистика и галерея из БД
  const stats = await (await fetch(`${BASE}/api/stats`)).json();
  check('статистика из БД: игроки/капчи/жулики', stats.ok && stats.players >= 1 && stats.sessions >= 4 && stats.cheaters >= 2, stats);
  const gal = await (await fetch(`${BASE}/gallery`)).text();
  check('галерея отдаёт рисунки из БД', gal.includes('Галерея капч') && gal.includes('data:image/png'));

  sock.close();
  srv.kill();
  setTimeout(() => {
    console.log(`\nИТОГ: ${pass} passed, ${failCount} failed`);
    process.exit(failCount ? 1 : 0);
  }, 300);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
