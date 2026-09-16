'use strict';

/* ============================================================
   NE PTUNZINHO v2 — Bot IA Profesional 1v1 (node-haxball)
   Libreria: node-haxball  (github.com/wxyz-abcd/node-haxball)
   ------------------------------------------------------------
   Basada en 4 capas de decision, re-evaluadas en cada tick:

   1) PORTERO     -> si el balon esta en zona de peligro, el bot
                     se coloca en la recta gol-balon usando la
                     trayectoria predicha (donde cruzaria la
                     linea de gol) + sesgo de esquinas que el
                     rival convierte habitualmente (aprendido).
   2) ATAQUE      -> si el bot es el mas cercano al balon, corre
                     al PRIMER punto de la trayectoria que puede
                     alcanzar (interceptacion, no persecucion),
                     y al llegar dribla controlando el balon con
                     golpecitos hacia la esquina elegida.
   3) SOMBRA      -> si el rival lleva el balon, se interpone
                     entre el balon y la porteria propia.
   4) FORMACION   -> sin partido, ocupa su posicion inicial.

   Control de velocidad con FRENO: el bot mide su velocidad real
   y frena antes de llegar (evita el "pase de largo" que hacia
   jugar tan mal a la v1). Movimiento en 8 direcciones digitales
   (la API no da velocidad proporcional), con deadzone.

   Aprendizaje (heuristico, igual que la v1 pero ampliado):
   - Esquina preferida para tirar (refuerza la que convierte,
     decae con el tiempo).
   - Sesgo de PORTERO: recuerda hacia que esquina del arco te
     tira/remata el rival y ajusta su posicion de guardameta.
   - Ajuste de la linea por marcador (perdiendo, defensa mas
     solida; ganando, presiona mas arriba).

   USO:
   1) npm install node-haxball
   2) Obten tu token en https://www.haxball.com/headlesstoken
   3) Ponlo en TOKEN o en la variable HAXBALL_TOKEN
   4) node index.js   -> el link se imprime en consola.
   ============================================================ */

const api = require('node-haxball')();
const { Utils, Room, RoomConfig, AllowFlags } = api;

/* ============================================================
   CONFIGURACIÓN
   ============================================================ */
const TOKEN = process.env.HAXBALL_TOKEN || 'thr1.AAAAAGqqAveOEyb13c4oqQ.GT0ifiv2I1U';

const CONFIG = {
  roomName: 'Sala Bot Pro | Neptunzinho (1v1)',
  botName: 'Neptunzinho',
  botAvatar: '\u26A1',                 // ⚡
  botId: 65535,                        // id del bot "en memoria"
  botTeam: 1,                          // 1 = Rojo | 2 = Azul
  adminKey: 'neptunzinho',
  scoreLimit: 3,
  timeLimit: 0,
  // ---- Física / predicción ----
  friction: 0.99,                      // decaimiento de velocidad del balon
  predSteps: 40,                       // frames a futuro para interceptar
  maxSpeed: 26,                        // velocidad maxima estimada (px/tick)
  brakeAcc: 5,                         // deceleracion del crucero (px/tick^2)
  reachSpeed: 13,                      // velocidad media de desplazamiento
  reachEps: 26,                        // margen para "alcanzo el punto"
  // ---- Disparo / dribling ----
  kickRange: 50,
  kickCooldown: 6,                     // ticks entre patadas lejos del arco
  quickCooldown: 3,                    // ticks entre patadas cerca del arco
  kickLock: 90,                        // no patear en el arranque/kickoff
  alignRadians: 0.75,                  // tolerancia de alineacion al tirar
  dribbleTol: 1.05,                    // tolerancia para golpecito de dribling
  finishRange: 620,                    // distancia desde la que se "remata"
  touchRange: 28,                      // rango fisico de toque (radio jug+balon)
  // ---- Posicionamiento ----
  goalHalf: 180,                       // media altura de la porteria (Classic)
  deadzone: 0.18,
  avoidDist: 150,                      // rango para esquivar al rival
  dangerBase: 480,                     // radio de peligro en area propia
  blockBase: 130,
  shadowSharp: 0.5                     // agresividad de la linea defensiva
};

/* ============================================================
   CONSTANTES DEL MAPA (Classic)
   ============================================================ */
const FIELD_W = 1880, FIELD_H = 1040;   // medias dimensiones del campo
const GOAL_X = 1860;                    // linea de gol
const MARGIN = 34;
const BALL_R = 10, PLAYER_R = 15;

/* ============================================================
   ESTADO GLOBAL
   ============================================================ */
const Bot = {
  tick: 0,
  lastKickTick: -1000,
  kickLockUntil: 0,
  lastSentState: 0,
  team: CONFIG.botTeam,
  aimY: 0,
  // velocidad estimada del bot (derivada de posiciones)
  pvX: null, pvY: null, Vx: 0, Vy: 0,
  learn: {
    goalsFor: 0,
    goalsAgainst: 0,
    cornerScore: { up: 0, down: 0 },   // preferencia de esquina aprendida
    oppShots: { up: 0, down: 0 },      // esquina preferida del RIVAL (para el portero)
    saveBias: 0,                       // sesgo vertical del portero (-1 arriba..1 abajo)
    lastShot: { corner: null, tick: -999 },
    decayTick: 0
  }
};

/* ============================================================
   MATEMÁTICA (vanilla)
   ============================================================ */
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function len(x, y) { return Math.sqrt(x * x + y * y); }
function normAngle(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
function enemyGoalX(team) { return team === 1 ? GOAL_X : -GOAL_X; }

/* ============================================================
   PREDICCIÓN FÍSICA: simula el balon tick a tick (friccion,
   rebotes en muros y parada). Devuelve la LISTA de puntos.
   ============================================================ */
function forecastBall(x, y, vx, vy, steps) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    x += vx; y += vy;
    if (x > FIELD_W - 8) { x = FIELD_W - 8; vx = -vx * 0.9; }
    else if (x < -FIELD_W + 8) { x = -FIELD_W + 8; vx = -vx * 0.9; }
    if (y > FIELD_H - 8) { y = FIELD_H - 8; vy = -vy * 0.9; }
    else if (y < -FIELD_H + 8) { y = -FIELD_H + 8; vy = -vy * 0.9; }
    vx *= CONFIG.friction; vy *= CONFIG.friction;
    if (Math.abs(vx) < 0.06 && Math.abs(vy) < 0.06) { vx = 0; vy = 0; }
    pts.push({ x: x, y: y });
  }
  return pts;
}

/* Primer punto de la trayectoria que el bot PUEDE alcanzar.
   Con esto el bot "sale al encuentro" del balon en vez de ir detras. */
function interceptionPoint(meX, meY, pts) {
  const N = pts.length;
  for (let t = 1; t < N; t++) {
    const p = pts[t];
    const d = len(meX - p.x, meY - p.y);
    if (d < CONFIG.reachSpeed * t + CONFIG.reachEps) return p;
  }
  return pts[N - 1];
}

/* Y donde el balon CRUZARIA la linea de gol si sigue su trayectoria. */
function crossingAtGoal(pts, ownGoalX) {
  const s = ownGoalX > 0 ? 1 : -1;
  for (const p of pts) {
    if ((s > 0 && p.x >= ownGoalX - 3) || (s < 0 && p.x <= ownGoalX + 3)) return p.y;
  }
  return null;
}

/* ============================================================
   LECTURA DEL MUNDO (node-haxball, estado extrapolado)
   ============================================================ */
function readBall(room) {
  const gs = room.gameStateExt || room.gameState;
  if (!gs) return null;
  const b = gs.physicsState.discs[0];
  if (!b || !b.pos) return null;
  return {
    x: b.pos.x,
    y: b.pos.y,
    xspeed: b.speed ? b.speed.x : 0,
    yspeed: b.speed ? b.speed.y : 0
  };
}
function playerDisc(player) {
  if (!player || !player.disc) return null;
  return player.disc.ext || player.disc;
}
function trackMyMotion(x, y) {
  const CAP = CONFIG.maxSpeed * 1.3, SMOOTH = 0.35;
  if (Bot.pvX != null) {
    const dx = x - Bot.pvX, dy = y - Bot.pvY;
    const jump = Math.abs(dx) + Math.abs(dy);
    if (jump > CAP * 2.5) {            // respawn/teleport -> no muestrear
      Bot.Vx = 0; Bot.Vy = 0;
    } else {
      Bot.Vx = Bot.Vx * SMOOTH + clamp(dx, -CAP, CAP) * (1 - SMOOTH);
      Bot.Vy = Bot.Vy * SMOOTH + clamp(dy, -CAP, CAP) * (1 - SMOOTH);
    }
  }
  Bot.pvX = x; Bot.pvY = y;
}

/* ============================================================
   CONTROL DE MOVIMIENTO (sin invertir nunca).
   Si va demasiado rápido y está cerca del objetivo, SOLTAR las
   teclas (coast) para que la fricción lo frene; jamás se invierte
   el input (eso mandaba al bot para atrás / fuera del mapa).
   ============================================================ */
function moveControl(meX, meY, Vx, Vy, tx, ty) {
  const dx = tx - meX, dy = ty - meY;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < 5) return { dx: 0, dy: 0 };
  const ux = dx / d, uy = dy / d;
  const spd = Vx * ux + Vy * uy;                       // componente de avance
  const stopD = (spd * spd) / (2 * CONFIG.brakeAcc) + 10;

  if (spd > 4 && stopD > d) {
    return { dx: 0, dy: 0 };                           // crucero: soltar teclas
  }
  return { dx: ux, dy: uy };
}

function toKeys(dx, dy) {
  return {
    dx: dx < -CONFIG.deadzone ? -1 : (dx > CONFIG.deadzone ? 1 : 0),
    dy: dy < -CONFIG.deadzone ? -1 : (dy > CONFIG.deadzone ? 1 : 0)
  };
}

/* ============================================================
   DECISIONES DE POSICIONAMIENTO
   ============================================================ */
function selectAimY(by, enemyY) {
  const UP = -130, DOWN = 130;
  const w = Bot.learn.cornerScore;
  if (enemyY != null) {
    // esquina MAS lejana del rival, con sesgo de lo aprendido
    const upS = Math.abs(enemyY - UP) - w.up * 12;
    const dnS = Math.abs(enemyY - DOWN) - w.down * 12;
    return upS >= dnS ? UP : DOWN;
  }
  return by > 0 ? UP : DOWN;
}

function keeperTarget(ball, pts, ownGoalX) {
  const half = CONFIG.goalHalf;
  const s = ball.x > ownGoalX ? 1 : -1;
  let cy = null;
  if (Math.sign(ball.xspeed) === s && Math.abs(ball.xspeed) > 0.4) {
    cy = crossingAtGoal(pts, ownGoalX);
  }
  let baseY = cy != null ? cy : clamp(ball.y, -half, half);
  baseY = clamp(baseY + Bot.learn.saveBias * 26, -(half - 6), half - 6);
  let f = 0.30;
  if (Math.abs(ownGoalX - ball.x) < 260) f = 0.18;     // peligro inminente -> linea
  // El portero NUNCA atraviesa la linea de gol: se mantiene 20..320 px hacia el campo
  const tx = clamp(ownGoalX + (ball.x - ownGoalX) * f, ownGoalX + s * 20, ownGoalX + s * 320);
  const ty = clamp(ball.y * 0.3 + baseY * 0.7, -(half + 40), (half + 40));
  return { x: tx, y: ty };
}

function shadowTarget(ball, ownGoalX) {
  const d = Math.abs(ownGoalX - ball.x);
  let f = clamp(CONFIG.shadowSharp - d / (FIELD_W * 1.7), 0.16, CONFIG.shadowSharp);
  const s = ball.x > ownGoalX ? 1 : -1;
  const tx = clamp(ownGoalX + (ball.x - ownGoalX) * f, ownGoalX + s * 110, ownGoalX + s * 520);
  const ty = clamp(ball.y * 0.75 + Bot.learn.saveBias * 24, -(CONFIG.goalHalf + 90), CONFIG.goalHalf + 90);
  return { x: tx, y: ty };
}

function avoidPoint(tx, ty, enemyD) {
  if (!enemyD || !enemyD.pos) return { x: tx, y: ty };
  const dx = tx - enemyD.pos.x, dy = ty - enemyD.pos.y;
  const d = len(dx, dy);
  if (d > 0 && d < CONFIG.avoidDist) {
    const ux = dx / d, uy = dy / d;
    return { x: tx + ux * 55, y: ty + uy * 55 };
  }
  return { x: tx, y: ty };
}

/* ============================================================
   APRENDIZAJE (heuristico)
   ============================================================ */
function reinforceCorner() {
  const L = Bot.learn;
  if (Bot.tick - L.lastShot.tick < 150 && L.lastShot.corner) {
    L.cornerScore[L.lastShot.corner] = Math.min(4, L.cornerScore[L.lastShot.corner] + 1);
    console.log('[Neptunzinho] Aprendizaje: +1 esquina ' + L.lastShot.corner);
  }
}
function decayLearning() {
  const L = Bot.learn;
  L.decayTick++;
  if (L.decayTick >= 600) {
    L.decayTick = 0;
    L.cornerScore.up *= 0.9;
    L.cornerScore.down *= 0.9;
    L.oppShots.up *= 0.92;
    L.oppShots.down *= 0.92;
    L.saveBias = clamp((L.oppShots.up - L.oppShots.down) * 0.22, -1, 1);
  }
}

/* ============================================================
   ENVÍO DE INPUT (node-haxball). Desync = solo enviar al cambiar.
   ============================================================ */
function sendInput(room, dirX, dirY, wantKick) {
  if (process.env.NEPT_DEBUG) {
    const dbg = (dirX < 0 ? 'L' : dirX > 0 ? 'R' : '-') + (dirY < 0 ? 'U' : dirY > 0 ? 'D' : '-');
    let tinfo = '';
    if (Bot.dbgT) tinfo = ' tgt(' + Bot.dbgT.x.toFixed(0) + ',' + Bot.dbgT.y.toFixed(0) + ') near=' + Bot.dbgT.near +
      ' me(' + Bot.dbgT.mx.toFixed(0) + ',' + Bot.dbgT.my.toFixed(0) + ') V(' + Bot.dbgT.vx.toFixed(1) + ',' + Bot.dbgT.vy.toFixed(1) + ')' +
      ' ball(' + Bot.dbgT.bx.toFixed(0) + ',' + Bot.dbgT.by.toFixed(0) + ') g(' + Bot.dbgT.gx.toFixed(0) + ',' + Bot.dbgT.gy.toFixed(0) + ') dbp=' + Bot.dbgT.dbp.toFixed(0);
    console.log('[d] t' + Bot.tick + ' ' + Bot.debugMode + ' keys=' + dbg + ' kick=' + (wantKick ? 1 : 0) + tinfo);
  }
  let desired = Utils.keyState(dirX, dirY, !!wantKick);
  const me = room.getPlayer(CONFIG.botId);
  const isKicking = !!(me && me.isKicking);

  Utils.runAfterGameTick(() => {
    if (desired !== Bot.lastSentState || wantKick !== isKicking) {
      if (desired === Bot.lastSentState && wantKick && !isKicking) {
        room.fakeSendPlayerInput(desired & -17, CONFIG.botId);   // soltar kick para poder repetirlo
      }
      room.fakeSendPlayerInput(desired, CONFIG.botId);
      Bot.lastSentState = desired;
      if (wantKick) {
        Bot.learn.lastShot = { corner: (Bot.aimY >= 0 ? 'down' : 'up'), tick: Bot.tick };
      }
    }
  });
}

function kickReady() {
  return Bot.tick > Bot.kickLockUntil && Bot.tick >= Bot.lastKickTick + CONFIG.kickCooldown;
}

/* ============================================================
   IA PRINCIPAL (cada game tick)
   ============================================================ */
function ensureBot(room) {
  if (!room.getPlayer(CONFIG.botId)) {
    try {
      room.fakePlayerJoin(CONFIG.botId, CONFIG.botName, 'us', CONFIG.botAvatar,
        'fake-ip-do-not-believe', 'fake-auth-do-not-believe');
      room.setPlayerTeam(CONFIG.botId, Bot.team);
    } catch (e) {}
  }
}

function tickUpdate(room) {
  Bot.tick++;
  decayLearning();
  ensureBot(room);

  room.extrapolate();

  const me = room.getPlayer(CONFIG.botId);
  const disc = playerDisc(me);
  if (!disc || !disc.pos) return;
  const meX = disc.pos.x, meY = disc.pos.y;
  trackMyMotion(meX, meY);

  const ball = readBall(room);
  let wantKick = false;

  /* ---- SIN PARTIDO: espera en el CENTRO del campo ----
     En el kickoff el balon reaparece en el centro; estando ahi
     gana la posesion al inicio. (Antes se retiraba a su arco y
     parecia que "se iba para atras".) */
  if (!ball) {
    Bot.debugMode = 'F';
    const m = moveControl(meX, meY, Bot.Vx, Bot.Vy, 0, 0);
    const k = toKeys(m.dx, m.dy);
    sendInput(room, k.dx, k.dy, false);
    return;
  }

  const bx = ball.x, by = ball.y;
  const pts = forecastBall(bx, by, ball.xspeed, ball.yspeed, CONFIG.predSteps);

  const ownGoalX = -enemyGoalX(Bot.team);
  const gx = enemyGoalX(Bot.team);

  /* ---- Rival (primer jugador real del otro equipo) ---- */
  let enemyD = null;
  const players = room.players || [];
  for (const p of players) {
    if (p.id === CONFIG.botId) continue;
    if (p.team && p.team.id === (Bot.team === 1 ? 2 : 1)) {
      enemyD = playerDisc(p);
      if (enemyD) break;
    }
  }
  const enemyY = enemyD && enemyD.pos ? enemyD.pos.y : null;

  const dbp = len(meX - bx, meY - by);                       // dist bot<->balon
  const ebp = enemyD && enemyD.pos ? len(enemyD.pos.x - bx, enemyD.pos.y - by) : 1e9;

  const gy = selectAimY(by, enemyY);
  Bot.aimY = gy;

  /* ---- Linea de peligro ajustada por marcador ---- */
  const drift = clamp((Bot.learn.goalsAgainst - Bot.learn.goalsFor) * 6, -45, 45);
  const dangerDist = CONFIG.dangerBase + drift * 0.6;
  const inDanger = (Math.abs(bx - ownGoalX) < dangerDist) && (Math.abs(by) < CONFIG.goalHalf + 170);

  /* ================= PORTERO ================= */
  if (inDanger) {
    Bot.debugMode = 'K';
    const kp = keeperTarget(ball, pts, ownGoalX);
    const m = moveControl(meX, meY, Bot.Vx, Bot.Vy, kp.x, kp.y);
    const k = toKeys(m.dx, m.dy);
    if (dbp < CONFIG.touchRange && kickReady()) { wantKick = true; Bot.lastKickTick = Bot.tick; }   // despeje
    sendInput(room, k.dx, k.dy, wantKick);
    return;
  }

  /* ================= SOMBRA (el rival lleva el balon) ================= */
  if (ebp < dbp - 15) {
    Bot.debugMode = 'S';
    const sp = shadowTarget(ball, ownGoalX);
    const m = moveControl(meX, meY, Bot.Vx, Bot.Vy, sp.x, sp.y);
    const k = toKeys(m.dx, m.dy);
    if (dbp < CONFIG.touchRange && kickReady()) { wantKick = true; Bot.lastKickTick = Bot.tick; }   // robo/globo
    sendInput(room, k.dx, k.dy, wantKick);
    return;
  }

  /* ================= ATAQUE (yo soy el mas cercano) ================= */
  const nearBall = dbp < CONFIG.touchRange + 12;
  let tx, ty;
  const gdx = gx - bx, gdy = gy - by;
  const gl = len(gdx, gdy) || 1;
  const ugx = gdx / gl, ugy = gdy / gl;
  Bot.debugMode = 'A';

  if (nearBall) {
    /* DRIBLING: colocarse ligeramente "detras" del balon respecto a la
       esquina elegida y empujarlo con golpecitos. Asi controla y conduce. */
    tx = bx - ugx * (BALL_R + 10);
    ty = by - ugy * (BALL_R + 10);

    const aMeB = Math.atan2(by - meY, bx - meX);
    const aBC = Math.atan2(ugy, ugx);
    const diff = Math.abs(normAngle(aMeB - aBC));
    const approach = Bot.Vx * ugx + Bot.Vy * ugy;      // velocidad hacia la esquina
    const nearGoal = Math.abs(bx - gx) < CONFIG.finishRange;

    if (kickReady() && dbp <= CONFIG.touchRange + 6) {
      // ROCKET: viniendo con carrera y alineado -> golpe fuerte;
      // en conduccion lenta -> golpecito de control.
      const tol = nearGoal ? CONFIG.alignRadians : (approach > 12 ? CONFIG.alignRadians : CONFIG.dribbleTol);
      if (diff < tol) {
        wantKick = true;
        Bot.lastKickTick = Bot.tick;
      }
    }
  } else {
    /* PERSEGUIR / INTERCEPTAR: ir al punto mas temprano alcanzable. */
    const p = interceptionPoint(meX, meY, pts);
    tx = p.x; ty = p.y;
  }

  if (enemyD) {
    const av = avoidPoint(tx, ty, enemyD);
    tx = av.x; ty = av.y;
  }
  tx = clamp(tx, -FIELD_W + MARGIN, FIELD_W - MARGIN);
  ty = clamp(ty, -FIELD_H + MARGIN, FIELD_H - MARGIN);
  if (process.env.NEPT_DEBUG) Bot.dbgT = { x: tx, y: ty, near: nearBall, dbp: dbp, mx: meX, my: meY, vx: Bot.Vx, vy: Bot.Vy, bx: bx, by: by, gx: gx, gy: gy };

  const m = moveControl(meX, meY, Bot.Vx, Bot.Vy, tx, ty);
  const k = toKeys(m.dx, m.dy);
  sendInput(room, k.dx, k.dy, wantKick);
}

/* ============================================================
   HOST / ROOM CONFIG (callbacks)
   ============================================================ */
let currentRoom = null;
let logError = false;

function sendAnnouncement(room, msg, targetId) {
  try {
    if (targetId != null) room.sendAnnouncement(msg, 0x00FF00, 'bold', 1, targetId);
    else room.sendAnnouncement(msg, 0x00FF00, 'bold', 1);
  } catch (e) { console.log('[Announcement]', msg); }
}

function NeptunBot(api) {
  Object.setPrototypeOf(this, RoomConfig.prototype);
  RoomConfig.call(this, {
    name: 'Neptunzinho',
    version: '2.0',
    author: 'Neptunzinho',
    description: 'IA profesional 1v1 con aprendizaje y prediccion fisica (node-haxball)',
    allowFlags: AllowFlags.CreateRoom
  });

  const that = this;

  this.onGameTick = function () {
    try {
      tickUpdate(that.room);
    } catch (e) {
      if (!logError) { logError = true; console.error('[Neptunzinho] Error en onGameTick:', e); }
    }
  };

  this.onPlayerJoin = function (playerObj) {
    try {
      if (!playerObj) return;
      if (playerObj.id !== CONFIG.botId && playerObj.team.id === 0) {
        that.room.setPlayerTeam(playerObj.id, CONFIG.botTeam === 1 ? 2 : 1);
      }
      if (playerObj.id !== CONFIG.botId && !that.room.getScores()) {
        that.room.startGame();
      }
    } catch (e) {}
  };

  this.onPlayerLeave = function (playerObj) {
    try { if (playerObj) that.room.sendAnnouncement(playerObj.name + ' salio de la sala'); } catch (e) {}
  };

  this.onPositionsReset = function () { Bot.kickLockUntil = Bot.tick + CONFIG.kickLock; };
  this.onGameStart = function () { Bot.kickLockUntil = Bot.tick + CONFIG.kickLock; };

  this.onTeamGoal = function (teamId) {
    Bot.kickLockUntil = Bot.tick + CONFIG.kickLock;
    try {
      const tg = teamId && typeof teamId === 'object' ? teamId.team : teamId;
      if (tg === Bot.team) {
        Bot.learn.goalsFor++;
        reinforceCorner();
      } else {
        Bot.learn.goalsAgainst++;
        try {
          const b = readBall(that.room);
          if (b && b.y != null) Bot.learn.oppShots[b.y < 0 ? 'up' : 'down']++;
        } catch (e) {}
      }
      sendAnnouncement(that.room,
        'GOL | ' + (tg === Bot.team ? 'NOSOTROS' : 'RIVAL') +
        ' | IA: defensa ' + (Bot.learn.goalsAgainst >= Bot.learn.goalsFor ? 'mas solida' : 'mas ofensiva'));
    } catch (e) {}
  };

  this.onPlayerChat = function (id, message) {
    let handled = false;
    try {
      const pl = that.room.getPlayer(id);
      const m = String(message);
      const low = m.trim().toLowerCase();

      if (low === '!ia') {
        handled = true;
        sendAnnouncement(that.room,
          'IA: ' + Bot.learn.goalsFor + ' a favor, ' + Bot.learn.goalsAgainst +
          ' en contra | esquinas: arriba=' + Bot.learn.cornerScore.up.toFixed(1) +
          ' abajo=' + Bot.learn.cornerScore.down.toFixed(1) +
          ' | rival tira: ' + (Bot.learn.saveBias < 0 ? 'arriba' : (Bot.learn.saveBias > 0 ? 'abajo' : '?')),
          id);
      } else if (low === '!admin' || low.indexOf('!admin ') === 0) {
        handled = true;
        const pass = m.slice(7).trim();
        if (pass === CONFIG.adminKey) {
          that.room.setPlayerAdmin(id, true);
          sendAnnouncement(that.room, 'Sos admin. Bienvenido, ' + (pl ? pl.name : 'jugador'), id);
        } else {
          sendAnnouncement(that.room, 'Clave incorrecta.', id);
        }
      } else if (low === '!rojo') {
        handled = true;
        Bot.team = 1; that.room.setPlayerTeam(CONFIG.botId, 1);
        sendAnnouncement(that.room, 'Bot -> equipo ROJO.', id);
      } else if (low === '!azul') {
        handled = true;
        Bot.team = 2; that.room.setPlayerTeam(CONFIG.botId, 2);
        sendAnnouncement(that.room, 'Bot -> equipo AZUL.', id);
      }
    } catch (e) {}

    return handled ? false : true;   // los comandos no se publican en el chat
  };
}

/* ============================================================
   CREACIÓN DE LA SALA
   ============================================================ */
Room.create({
  name: CONFIG.roomName,
  password: null,
  showInRoomList: false,
  maxPlayerCount: 4,
  noPlayer: true,
  token: TOKEN
}, {
  storage: {
    player_name: CONFIG.botName,
    avatar: CONFIG.botAvatar,
    geo: { lat: -34, lon: -64, flag: 'ar' }
  },
  config: new NeptunBot(api),

  onOpen(room) {
    try {
      currentRoom = room;
      ensureBot(room);

      if (typeof room.setScoreLimit === 'function') room.setScoreLimit(CONFIG.scoreLimit);
      if (typeof room.setTimeLimit === 'function') room.setTimeLimit(CONFIG.timeLimit);

      try {
        const defs = Utils.getDefaultStadiums();
        if (defs && defs[0] && typeof room.setStadium === 'function') room.setStadium(defs[0]);
      } catch (e) {}

      room.onAfterRoomLink = function (link) {
        console.log('\n==========================================');
        console.log('  Sala lista. Entra aqui: ' + link);
        console.log('  El bot "' + CONFIG.botName + '" juega en equipo ' + (Bot.team === 1 ? 'ROJO' : 'AZUL') +
          '. Tu enemigo entra por el link.');
        console.log('  Chat: !ia (stats/aprendizaje), !admin neptunzinho (admin, invisible), !rojo / !azul');
        console.log('==========================================\n');
      };

      console.log('[Neptunzinho] Creando sala "' + CONFIG.roomName + '" con IA v2...');
      setTimeout(() => { try { room.startGame(); } catch (e) {} }, 2500);
    } catch (e) {
      console.error('[Neptunzinho] Error creando la sala:', e);
    }
  },

  onClose(error) {
    console.error('[Neptunzinho] La sala se cerro:', error);
  }
});

console.log('[Neptunzinho] Inicializando node-haxball (requiere Node >= 16.9). Si no obtienes el link, revisa tu TOKEN.');