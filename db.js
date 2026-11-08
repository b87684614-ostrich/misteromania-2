// База данных игры «Мистеромания» (SQLite).
// Используем ВСТРОЕННЫЙ в Node.js SQLite (node:sqlite) — никаких нативных
// C++ зависимостей, поэтому сборка на Render всегда зелёная (no node-gyp/make).
// Требуется Node.js >= 22.13 (задано в package.json engines).
// Путь к файлу БД можно задать через DATA_DIR (на Render — смонтируйте Disk и задайте DATA_DIR=/var/data)
const path = require('path');
const fs = require('fs');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('ОШИБКА: нужен Node.js >= 22.13 со встроенным модулем node:sqlite. Текущий: ' + process.version);
  throw e;
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'misteromania.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname TEXT NOT NULL,
  nick_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS captcha_sessions (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('normal','creative')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  passed INTEGER,
  ip TEXT,
  ua TEXT
);
CREATE TABLE IF NOT EXISTS drawings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  mode TEXT NOT NULL,
  strokes TEXT NOT NULL,
  image TEXT NOT NULL,
  metrics TEXT,
  passed INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ip TEXT
);
CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL REFERENCES players(id),
  mister_type TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bans (
  ip TEXT PRIMARY KEY,
  until INTEGER NOT NULL,
  reason TEXT
);
`);

const q = {
  playerByNick: db.prepare('SELECT * FROM players WHERE nick_key = ?'),
  insertPlayer: db.prepare('INSERT INTO players (nickname, nick_key, created_at, last_seen) VALUES (?, ?, ?, ?)'),
  touchPlayer: db.prepare('UPDATE players SET last_seen = ? WHERE id = ?'),
  insertSession: db.prepare('INSERT INTO captcha_sessions (id, nickname, mode, started_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?)'),
  getSession: db.prepare('SELECT * FROM captcha_sessions WHERE id = ?'),
  finishSession: db.prepare('UPDATE captcha_sessions SET finished_at = ?, passed = ? WHERE id = ?'),
  insertDrawing: db.prepare('INSERT INTO drawings (session_id, nickname, mode, strokes, image, metrics, passed, created_at, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  insertToken: db.prepare('INSERT INTO tokens (token, player_id, created_at) VALUES (?, ?, ?)'),
  getToken: db.prepare('SELECT t.token, t.player_id, p.nickname FROM tokens t JOIN players p ON p.id = t.player_id WHERE t.token = ?'),
  deleteToken: db.prepare('DELETE FROM tokens WHERE token = ?'),
  insertCapture: db.prepare('INSERT INTO captures (player_id, mister_type, at) VALUES (?, ?, ?)'),
  capturesOf: db.prepare('SELECT mister_type, COUNT(*) AS n FROM captures WHERE player_id = ? GROUP BY mister_type ORDER BY n DESC'),
  banGet: db.prepare('SELECT * FROM bans WHERE ip = ?'),
  banSet: db.prepare('INSERT OR REPLACE INTO bans (ip, until, reason) VALUES (?, ?, ?)'),
  banDel: db.prepare('DELETE FROM bans WHERE ip = ?'),
  failsByIp: db.prepare('SELECT COUNT(*) AS n FROM drawings WHERE ip = ? AND passed = 0 AND created_at > ?'),
  allDrawings: db.prepare('SELECT id, nickname, mode, image, metrics, passed, created_at FROM drawings ORDER BY created_at DESC LIMIT 500'),
  stats: db.prepare(`SELECT
    (SELECT COUNT(*) FROM players) AS players,
    (SELECT COUNT(*) FROM captcha_sessions) AS sessions,
    (SELECT COUNT(*) FROM captcha_sessions WHERE passed = 1) AS passed,
    (SELECT COUNT(*) FROM drawings WHERE passed = 0) AS cheaters,
    (SELECT COUNT(*) FROM captures) AS captures`),
};

module.exports = {
  db,
  playerByNick: (nick) => q.playerByNick.get(String(nick).toLowerCase()),
  createPlayer(nick) {
    const now = Date.now();
    const info = q.insertPlayer.run(nick, String(nick).toLowerCase(), now, now);
    return { id: Number(info.lastInsertRowid), nickname: nick, created_at: now };
  },
  touchPlayer: (id) => q.touchPlayer.run(Date.now(), id),
  startSession: (id, nick, mode, ip, ua) => q.insertSession.run(id, nick, mode, Date.now(), ip, ua),
  getSession: (id) => q.getSession.get(id),
  finishSession: (id, passed) => q.finishSession.run(Date.now(), passed ? 1 : 0, id),
  saveDrawing: (sessionId, nick, mode, strokes, image, metrics, passed, ip) =>
    q.insertDrawing.run(sessionId, nick, mode, strokes, image, metrics, passed ? 1 : 0, Date.now(), ip),
  createToken: (token, playerId) => q.insertToken.run(token, playerId, Date.now()),
  getToken: (token) => q.getToken.get(token),
  deleteToken: (token) => q.deleteToken.run(token),
  addCapture: (playerId, type) => q.insertCapture.run(playerId, type, Date.now()),
  capturesOf: (playerId) => q.capturesOf.all(playerId),
  getBan: (ip) => q.banGet.get(ip),
  setBan: (ip, until, reason) => q.banSet.run(ip, until, reason),
  clearBan: (ip) => q.banDel.run(ip),
  failsByIp: (ip, since) => Number(q.failsByIp.get(ip, since).n),
  allDrawings: () => q.allDrawings.all(),
  stats: () => q.stats.get(),
};
