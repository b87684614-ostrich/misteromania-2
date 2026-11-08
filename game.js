// Игровая логика «Мистеромания» в реальном времени.
// Игрок — «Сосуд». Мистеры бродят по миру и нападают. Побеждённый мистер
// попадает в команду игрока и воюет бок о бок с ним.
const db = require('./db');

const WORLD = { w: 2400, h: 2400 };
const TICK_MS = 1000 / 30;          // логика 30 Гц
const SEND_MS = 50;                 // рассылка состояния 20 Гц
const PLAYER_SPEED = 235;
const PLAYER_MAX_HP = 100;
const ATTACK_CD = 260;              // мс между ударами игрока
const ATTACK_RANGE = 95;            // радиус удара вокруг точки клика
const ATTACK_DMG = 14;
const TEAM_MAX = 10;                // сколько мистеров может быть в команде
const MISTER_CAP = 14;              // сколько мистеров одновременно в мире
const RESPAWN_MISTER_MS = 2500;
const RESPAWN_PLAYER_MS = 4000;

// Характеристики мистеров по картинкам
const MISTER_TYPES = [
  { key: '111', img: '/img/m111.png', name: 'Мистер 111', hp: 40,  dmg: 6,  speed: 60, r: 34, score: 1, w: 30 },
  { key: '222', img: '/img/m222.png', name: 'Мистер 222', hp: 70,  dmg: 9,  speed: 48, r: 36, score: 2, w: 25 },
  { key: '333', img: '/img/m333.png', name: 'Мистер 333', hp: 110, dmg: 13, speed: 68, r: 38, score: 3, w: 20 },
  { key: '444', img: '/img/m444.png', name: 'Мистер 444', hp: 160, dmg: 16, speed: 52, r: 40, score: 4, w: 15 },
  { key: '555', img: '/img/m555.png', name: 'Мистер 555', hp: 130, dmg: 11, speed: 85, r: 38, score: 5, w: 12 },
  { key: '666', img: '/img/m666.png', name: 'Мистер 666', hp: 220, dmg: 20, speed: 62, r: 44, score: 6, w: 10 },
  { key: '777', img: '/img/m777.png', name: 'Мистер 777', hp: 280, dmg: 24, speed: 72, r: 46, score: 7, w: 8 },
  { key: '888', img: '/img/m888.png', name: 'Мистер 888', hp: 340, dmg: 28, speed: 56, r: 48, score: 8, w: 6 },
  { key: '999', img: '/img/m999.png', name: 'Мистер 999', hp: 460, dmg: 34, speed: 50, r: 52, score: 9, w: 4 },
];
const TYPE_BY_KEY = Object.fromEntries(MISTER_TYPES.map((t) => [t.key, t]));

function pickType() {
  const total = MISTER_TYPES.reduce((s, t) => s + t.w, 0);
  let x = Math.random() * total;
  for (const t of MISTER_TYPES) { x -= t.w; if (x <= 0) return t; }
  return MISTER_TYPES[0];
}

class Game {
  constructor(io) {
    this.io = io;
    this.players = new Map(); // id -> player
    this.misters = new Map(); // id -> mister
    this.nextMisterId = 1;
    this.respawnQueue = [];
    for (let i = 0; i < MISTER_CAP; i++) this.spawnMister();
    this.lastTick = Date.now();
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.sendTimer = setInterval(() => this.broadcast(), SEND_MS);
  }

  spawnMister() {
    const t = pickType();
    const edge = Math.floor(Math.random() * 4);
    const m = { x: 0, y: 0 };
    if (edge === 0) { m.x = Math.random() * WORLD.w; m.y = 20; }
    else if (edge === 1) { m.x = Math.random() * WORLD.w; m.y = WORLD.h - 20; }
    else if (edge === 2) { m.x = 20; m.y = Math.random() * WORLD.h; }
    else { m.x = WORLD.w - 20; m.y = Math.random() * WORLD.h; }
    const mister = {
      id: this.nextMisterId++, type: t.key, x: m.x, y: m.y,
      hp: t.hp, maxHp: t.hp, angle: 0, attackCd: 0, lastHitBy: null, flashUntil: 0,
    };
    this.misters.set(mister.id, mister);
    return mister;
  }

  addPlayer(socket, playerRow) {
    const p = {
      id: playerRow.id, socketId: socket.id, nickname: playerRow.nickname,
      x: WORLD.w / 2 + (Math.random() * 200 - 100),
      y: WORLD.h / 2 + (Math.random() * 200 - 100),
      hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP,
      angle: 0, attacking: false, mx: 0, my: 0,
      up: false, down: false, left: false, right: false,
      lastAttack: 0, alive: true, respawnAt: 0,
      team: [], score: 0, kills: 0,
    };
    this.players.set(p.id, p);
    db.touchPlayer(p.id);
    socket.emit('welcome', { id: p.id, world: WORLD, types: MISTER_TYPES });
    this.io.emit('ev', { type: 'join', text: `${p.nickname} вошёл в игру (сосуд)` });
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.io.emit('ev', { type: 'leave', text: `${p.nickname} вышел из игры` });
  }

  setInput(id, input) {
    const p = this.players.get(id);
    if (!p || !input) return;
    for (const k of ['up', 'down', 'left', 'right', 'attacking']) p[k] = !!input[k];
    if (isFinite(input.mx)) p.mx = input.mx;
    if (isFinite(input.my)) p.my = input.my;
    if (isFinite(input.angle)) p.angle = input.angle;
  }

  nearestPlayer(x, y) {
    let best = null, bd = Infinity;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    return best ? { p: best, d: Math.sqrt(bd) } : null;
  }

  tick() {
    const now = Date.now();
    const dt = Math.min(0.1, (now - this.lastTick) / 1000);
    this.lastTick = now;

    // --- respawn мистеров
    while (this.respawnQueue.length && this.respawnQueue[0].at <= now) this.respawnQueue.shift();
    while (this.misters.size + this.respawnQueue.length < MISTER_CAP) this.spawnMister();

    // --- игроки
    for (const p of this.players.values()) {
      if (!p.alive) {
        if (now >= p.respawnAt) {
          p.alive = true; p.hp = p.maxHp;
          p.x = WORLD.w / 2 + (Math.random() * 300 - 150);
          p.y = WORLD.h / 2 + (Math.random() * 300 - 150);
          this.io.emit('ev', { type: 'respawn', id: p.id, text: `${p.nickname} восстал из сосуда!` });
        }
        continue;
      }
      let vx = (p.right ? 1 : 0) - (p.left ? 1 : 0);
      let vy = (p.down ? 1 : 0) - (p.up ? 1 : 0);
      if (vx || vy) {
        const len = Math.hypot(vx, vy);
        p.x = Math.max(30, Math.min(WORLD.w - 30, p.x + (vx / len) * PLAYER_SPEED * dt));
        p.y = Math.max(30, Math.min(WORLD.h - 30, p.y + (vy / len) * PLAYER_SPEED * dt));
      }
      p.hp = Math.min(p.maxHp, p.hp + 2.5 * dt); // регенерация

      // удар игрока по точке клика
      if (p.attacking && now - p.lastAttack >= ATTACK_CD) {
        p.lastAttack = now;
        this.playerAttack(p, p.mx, p.my);
      }

      // --- команда игрока (пойманные мистеры)
      for (const tm of p.team) {
        const t = TYPE_BY_KEY[tm.type];
        // ищем ближайшего вражеского мистера рядом с игроком/товарищем
        let best = null, bd = 320 * 320;
        for (const m of this.misters.values()) {
          const d = (m.x - tm.x) ** 2 + (m.y - tm.y) ** 2;
          if (d < bd) { bd = d; best = m; }
        }
        if (!best) {
          // просто идём за хозяином
          const d = Math.hypot(p.x - tm.x, p.y - tm.y);
          if (d > 70) {
            tm.x += ((p.x - tm.x) / d) * 260 * dt;
            tm.y += ((p.y - tm.y) / d) * 260 * dt;
            tm.angle = Math.atan2(p.y - tm.y, p.x - tm.x);
          }
          continue;
        }
        const d = Math.sqrt(bd);
        tm.angle = Math.atan2(best.y - tm.y, best.x - tm.x);
        if (d > t.r + best.r + 6) {
          tm.x += Math.cos(tm.angle) * 280 * dt;
          tm.y += Math.sin(tm.angle) * 280 * dt;
        } else if (now - tm.cd >= 700) {
          tm.cd = now;
          this.damageMister(best, Math.round(t.dmg * 0.7), p.id);
          this.io.emit('ev', { type: 'thit', x: best.x, y: best.y, by: p.id });
        }
        tm.x = Math.max(20, Math.min(WORLD.w - 20, tm.x));
        tm.y = Math.max(20, Math.min(WORLD.h - 20, tm.y));
      }
    }

    // --- мистеры
    for (const m of [...this.misters.values()]) {
      const t = TYPE_BY_KEY[m.type];
      const near = this.nearestPlayer(m.x, m.y);
      if (near) {
        const d = near.d;
        m.angle = Math.atan2(near.p.y - m.y, near.p.x - m.x);
        if (d > t.r + 26) {
          m.x += Math.cos(m.angle) * t.speed * dt;
          m.y += Math.sin(m.angle) * t.speed * dt;
        } else if (now - m.attackCd >= 900) {
          m.attackCd = now;
          const p = near.p;
          p.hp -= t.dmg;
          this.io.emit('ev', { type: 'hit', id: p.id, x: p.x, y: p.y, dmg: t.dmg, by: m.type });
          if (p.hp <= 0) {
            p.hp = 0; p.alive = false; p.respawnAt = now + RESPAWN_PLAYER_MS;
            this.io.emit('ev', { type: 'death', id: p.id, text: `${p.nickname} был одолён мистером ${m.type}! Воскрес через ${RESPAWN_PLAYER_MS / 1000} сек.` });
          }
        }
      }
      m.x = Math.max(20, Math.min(WORLD.w - 20, m.x));
      m.y = Math.max(20, Math.min(WORLD.h - 20, m.y));
    }
  }

  playerAttack(p, mx, my) {
    let hitAny = false;
    for (const m of [...this.misters.values()]) {
      const t = TYPE_BY_KEY[m.type];
      const d = Math.hypot(m.x - mx, m.y - my);
      if (d <= t.r + ATTACK_RANGE * 0.6) {
        hitAny = true;
        this.damageMister(m, ATTACK_DMG, p.id);
      }
    }
    this.io.emit('ev', { type: 'swing', id: p.id, x: mx, y: my, hit: hitAny });
  }

  damageMister(m, dmg, byPlayerId) {
    if (!this.misters.has(m.id)) return;
    m.hp -= dmg;
    m.lastHitBy = byPlayerId;
    m.flashUntil = Date.now() + 90;
    if (m.hp <= 0) {
      this.misters.delete(m.id);
      this.respawnQueue.push({ at: Date.now() + RESPAWN_MISTER_MS });
      const p = this.players.get(byPlayerId);
      if (p) {
        const t = TYPE_BY_KEY[m.type];
        p.kills++;
        p.score += t.score;
        if (p.team.length < TEAM_MAX) {
          p.team.push({ type: m.type, x: p.x + 40, y: p.y + 40, cd: 0 });
          db.addCapture(p.id, m.type);
          this.io.emit('ev', { type: 'capture', id: p.id, mister: m.type, teamSize: p.team.length,
            text: `🎉 ${p.nickname} победил ${t.name} — он теперь в команде! (${p.team.length}/${TEAM_MAX})` });
        } else {
          p.score += 2;
          this.io.emit('ev', { type: 'teamfull', id: p.id, mister: m.type,
            text: `${p.nickname} победил ${t.name}, но команда полная — бонус +2 очка!` });
        }
      } else {
        this.io.emit('ev', { type: 'kill', mister: m.type, text: `${t.name} повержен!` });
      }
    }
  }

  broadcast() {
    const players = [...this.players.values()].map((p) => ({
      id: p.id, nick: p.nickname, x: Math.round(p.x), y: Math.round(p.y),
      hp: Math.round(p.hp), maxHp: p.maxHp, angle: +p.angle.toFixed(2),
      alive: p.alive, score: p.score, kills: p.kills,
      team: p.team.map((t) => ({ type: t.type, x: Math.round(t.x), y: Math.round(t.y) })),
    }));
    const misters = [...this.misters.values()].map((m) => ({
      id: m.id, type: m.type, x: Math.round(m.x), y: Math.round(m.y),
      hp: Math.max(0, Math.round(m.hp)), maxHp: m.maxHp, flash: m.flashUntil > Date.now(),
    }));
    this.io.emit('state', { t: Date.now(), players, misters });
  }
}

module.exports = { Game, MISTER_TYPES, WORLD };
