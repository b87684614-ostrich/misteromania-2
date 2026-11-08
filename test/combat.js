// Б omvой тест: находим ближайшего мистера, бьём по нему, проверяем захват в команду.
const { spawn } = require('child_process');
const path = require('path');
const zlib = require('zlib');

const PORT = 3102;
const BASE = `http://127.0.0.1:${PORT}`;

// генерим «честный» рисунок (та же логика, что в e2e)
const crcTable = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const tt = Buffer.from(t); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([tt, d]))); return Buffer.concat([l, tt, d, c]); };
function makePng(w, h, draw) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = 255; px[i * 4 + 3] = 255; }
  draw((x, y, r, g, b) => { if (x < 0 || y < 0 || x >= w || y >= h) return; const d = (y * w + x) * 4; px[d] = r; px[d + 1] = g; px[d + 2] = b; px[d + 3] = 255; });
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function honest() {
  const strokes = [];
  const mk = (c, s, p) => strokes.push({ color: c, size: s, points: p });
  const circ = (cx, cy, r, n = 48) => Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; });
  mk('#111', 8, circ(480, 180, 70)); mk('#111', 8, [[410, 260], [550, 260], [560, 420], [400, 420], [410, 260]]);
  mk('#111', 8, [[410, 290], [300, 360]]); mk('#111', 8, [[550, 290], [660, 360]]);
  mk('#111', 8, [[440, 420], [420, 540]]); mk('#111', 8, [[520, 420], [540, 540]]);
  mk('#e53935', 8, circ(455, 170, 8, 24)); mk('#e53935', 8, circ(505, 170, 8, 24));
  mk('#1565c0', 8, [[440, 210], [480, 225], [520, 210]]);
  mk('#2e7d32', 6, [[200, 500], [300, 480], [380, 510], [460, 490], [560, 515]]);
  mk('#f9a825', 6, [[180, 120], [260, 90], [350, 130], [430, 95], [520, 135]]);
  const png = makePng(960, 600, (set) => {
    const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    for (const s of strokes) { const [r, g, b] = hex(s.color);
      for (let i = 1; i < s.points.length; i++) { const n = Math.ceil(Math.hypot(s.points[i][0] - s.points[i - 1][0], s.points[i][1] - s.points[i - 1][1])) * 2;
        for (let k = 0; k <= n; k++) { const t = k / n; set(Math.round(s.points[i-1][0] + (s.points[i][0]-s.points[i-1][0])*t), Math.round(s.points[i-1][1] + (s.points[i][1]-s.points[i-1][1])*t), r, g, b); } } }
  });
  return { strokes, image: 'data:image/png;base64,' + png.toString('base64') };
}

async function main() {
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: path.join(__dirname, 'tmp-combat') }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', (d) => process.stdout.write('[srv!] ' + d));
  await new Promise((res) => { const iv = setInterval(async () => { try { if ((await fetch(`${BASE}/api/health`)).ok) { clearInterval(iv); res(); } } catch {} }, 250); });

  const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '10.9.9.9' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, data: await r.json() }));
  let r = await post('/api/captcha/start', { nickname: 'Боец', mode: 'creative' });
  const d = honest();
  r = await post('/api/captcha/ok', { sessionId: r.data.sessionId, nickname: 'Боец', strokes: d.strokes, image: d.image });
  if (!r.data.ok) throw new Error('captcha failed: ' + JSON.stringify(r.data));
  const token = r.data.token;

  const { io } = require('socket.io-client');
  const sock = io(BASE, { auth: { token }, transports: ['websocket'] });
  const welcome = await new Promise((res, rej) => { sock.on('welcome', res); sock.on('connect_error', rej); });
  let lastState = null, captured = null;
  sock.on('state', (s) => { lastState = s; });
  sock.on('ev', (e) => { if (e.type === 'capture') captured = e; });
  await new Promise((res) => setTimeout(res, 500));

  // бьём по ближайшему мистеру, пока он не пойман
  const iv = setInterval(() => {
    if (!lastState) return;
    const me = lastState.players.find((p) => p.id === welcome.id);
    if (!me || !me.alive) return;
    let best = null, bd = Infinity;
    for (const m of lastState.misters) { const dd = (m.x - me.x) ** 2 + (m.y - me.y) ** 2; if (dd < bd) { bd = dd; best = m; } }
    if (best) sock.emit('input', { right: false, left: false, up: false, down: false, mx: best.x, my: best.y, angle: 0, attacking: true });
  }, 100);

  const t0 = Date.now();
  while (!captured && Date.now() - t0 < 30000) await new Promise((res) => setTimeout(res, 300));
  clearInterval(iv);
  const me = lastState.players.find((p) => p.id === welcome.id);
  console.log(captured ? `✅ мистер ${captured.mister} пойман в команду! team=${me.team.length}, score=${me.score}, kills=${me.kills}` : '❌ захват не произошёл за 30 сек');
  console.log('✅ команда в state:', JSON.stringify(me.team));
  sock.close(); srv.kill();
  setTimeout(() => process.exit(captured ? 0 : 1), 300);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
