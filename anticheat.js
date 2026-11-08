// Антижульничество капчи: сервер сам декодирует PNG рисунка и проверяет,
// что это не «одна точка», не «одна линия» и не пустой холст.
const zlib = require('zlib');

// Минимальный декодер PNG: 8 бит, цветовые типы 6 (RGBA) и 2 (RGB), без interlace.
// Возвращает { width, height, data } где data — Buffer RGBA.
function decodePNG(buf) {
  if (!buf || buf.length < 8) throw new Error('not a png');
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(sig)) throw new Error('bad signature');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (!width || !height || width > 4000 || height > 4000) throw new Error('bad size');
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
    throw new Error('unsupported png');
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      line[x] = v;
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels, d = (y * width + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

// Анализ пикселей: доля «чернил», число цветов чернил.
function inkStats(png) {
  const { width, height, data } = png;
  let ink = 0;
  const colors = new Set();
  for (let i = 0; i < width * height; i++) {
    const d = i * 4;
    const a = data[d + 3];
    const r = data[d], g = data[d + 1], b = data[d + 2];
    const isInk = a > 10 && !(r > 245 && g > 245 && b > 245);
    if (isInk) {
      ink++;
      if (colors.size < 256) colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    }
  }
  return { inkRatio: ink / (width * height), inkColors: colors.size, inkPixels: ink };
}

// Анализ мазков, которые прислал клиент (дополнительный сигнал).
function strokeStats(strokes) {
  let totalPoints = 0, pathLen = 0;
  const colors = new Set();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  if (!Array.isArray(strokes)) strokes = [];
  for (const s of strokes) {
    if (!s || !Array.isArray(s.points)) continue;
    if (s.color) colors.add(String(s.color));
    const pts = s.points;
    totalPoints += pts.length;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!Array.isArray(p) || p.length < 2) continue;
      const x = +p[0], y = +p[1];
      if (!isFinite(x) || !isFinite(y)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (i > 0) {
        const q = pts[i - 1];
        if (Array.isArray(q) && q.length >= 2) pathLen += Math.hypot(x - +q[0], y - +q[1]);
      }
    }
  }
  const bboxW = maxX === -Infinity ? 0 : maxX - minX;
  const bboxH = maxY === -Infinity ? 0 : maxY - minY;
  return { strokes: strokes.length, totalPoints, pathLen, colors: colors.size, bboxW, bboxH };
}

// Главная проверка. mode: 'normal' (5 минут) или 'creative' (без лимита времени).
// elapsedMs — сколько прошло на сервере с начала капчи.
function validateCaptcha({ mode, elapsedMs, strokes, imageDataUrl }) {
  const fail = (reason, cheat = true) => ({ ok: false, reason, cheat });

  if (mode === 'normal' && elapsedMs < 5 * 60 * 1000 - 1500) {
    // сдача раньше времени — не жульничество с рисунком, а нетерпение: без счётчика бана
    return fail(`Обычная капча длится 5 минут. Осталось примерно ${Math.ceil((5 * 60 * 1000 - elapsedMs) / 1000)} сек.`, false);
  }
  if (mode !== 'normal' && mode !== 'creative') return fail('Неизвестный режим капчи.');

  // 1) Рисунок вообще прислан?
  if (typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/png;base64,')) {
    return fail('Рисунок не прислан. Нарисуйте себя в Paint-окне.');
  }
  let pngBuf;
  try {
    pngBuf = Buffer.from(imageDataUrl.slice('data:image/png;base64,'.length), 'base64');
  } catch {
    return fail('Рисунок повреждён.');
  }
  if (pngBuf.length < 1500) return fail('Рисунок слишком маленький — похоже на жульничество (одна точка?).');

  // 2) Декодируем картинку и смотрим на реальные пиксели.
  let png, ink;
  try {
    png = decodePNG(pngBuf);
    ink = inkStats(png);
  } catch (e) {
    return fail('Не удалось прочитать рисунок: ' + e.message);
  }

  // 3) Анализ мазков клиента.
  let ss;
  try {
    ss = strokeStats(strokes);
  } catch {
    return fail('Данные мазков повреждены.');
  }

  const creative = mode === 'creative';
  const min = creative
    ? { strokes: 5, points: 60, path: 800, bw: 80, bh: 80, ink: 0.004, colors: 2, bytes: 5000 }
    : { strokes: 3, points: 30, path: 400, bw: 50, bh: 50, ink: 0.003, colors: 1, bytes: 3000 };

  if (ss.strokes < min.strokes) return fail(`Слишком мало мазков (${ss.strokes}). Нарисуйте себя по-нормальному — это не одна точка и не одна линия.`);
  if (ss.totalPoints < min.points) return fail('Рисунок слишком простой: мало точек. Нарисуйте себя properly.');
  if (ss.pathLen < min.path) return fail('Рисунок слишком короткий: похоже на одну линию. Нарисуйте себя целиком.');
  if (ss.bboxW < min.bw || ss.bboxH < min.bh) return fail('Рисунок слишком маленький по размеру. Нарисуйте себя крупнее.');
  if (ink.inkRatio < min.ink) return fail('На холсте почти ничего нет (пустой рисунок). Нарисуйте себя!');
  if (ink.inkRatio > 0.97) return fail('Холст залит целиком — так не рисуют. Нарисуйте себя по-нормальному.');
  if (ink.inkColors < min.colors) return fail(creative ? 'В творческом режиме используйте хотя бы 2 цвета.' : 'Добавьте цветов в рисунок.');
  if (pngBuf.length < min.bytes) return fail('Файл рисунка подозрительно маленький — похоже на жульничество.');

  return {
    ok: true,
    metrics: { ...ss, inkRatio: +ink.inkRatio.toFixed(5), inkColors: ink.inkColors, inkPixels: ink.inkPixels, pngBytes: pngBuf.length, w: png.width, h: png.height },
  };
}

module.exports = { decodePNG, inkStats, strokeStats, validateCaptcha };
