'use strict';

/* ============================================================
   NE PTUNZINHO v3 — Bot IA Profesional 1v1 (node-haxball)
   Libreria: node-haxball  (github.com/wxyz-abcd/node-haxball)
   ------------------------------------------------------------
   Capas de decision re-evaluadas en cada tick:

   1) PORTERO     -> el balon en zona de peligro: se coloca en la
                     recta gol-balon usando la trayectoria predicha
                     (donde cruzaria la linea de gol) + sesgo de
                     esquinas del rival (aprendido). Si el balon
                     llega suelto y cercano, sale a despejar.
   2) SOMBRA      -> el rival lleva el balon: se interpone entre
                     balon y porteria, ajustando la profundidad.
   3) ATAQUE      -> yo llego antes al balon. Persigo/intercepto
                     por trayectoria predicha y al dominarlo elijo
                     la jugada (ELEGIDA POR APRENDIZAJE):
                       ROCKET : correr al balon a maxima velocidad
                                y patear en plena carrera -> balon
                                muy rapido (coje la velocidad del
                                bot + impulso de la patada).
                       BB KICK: con el rival encima, golpe corto
                                lateral para regatearlo y salir
                                corriendo por detras del balon.
                       DIRECTO: tiro al hueco elegido (esquina
                                preferida aprendida) ajustado.
                       DRIBLE : conduccion con golpecitos hacia el
                                hueco, rompiendo la sombra rival.
                       CLEAR  : despeje defensivo fuera del area.
   4) FORMACION   -> sin partido, vuelve al centro del campo.

   FISICA DE PATADA REAL: en HaxBall el balon sale con
   ~velocidad del jugador + impulso constante en la direccion
   jugador->balon. Por eso un bot que SPRINTA y patea en el momento
   justo hace ROCKETS (~40 px/frame), y un bot parado hace toques
   cortos (control). La IA de v3 explota exactamente esa fisica.

   Aprendizaje (heuristica ampliada):
   - Esquina preferida para tirar (refuerza la que convierte).
   - Tecnica preferida (rocket/directo/bb): aprende con que golpea
     mas a ESTE portero concreto (p. ej. si los rockets se la
     atajan, deja de probar y usa el BB).
   - Sesgo de portero por esquina del rival (saveBias).
   - Linea defensiva ajustada por marcador.

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
const TOKEN = process.env.HAXBALL_TOKEN || 'thr1.AAAAAGqq-UYhzhRA3A6Akg.5a1vu55uboc';

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
  predSteps: 42,                       // frames a futuro para interceptar
  maxSpeed: 26,                        // velocidad maxima estimada (px/tick)
  brakeAcc: 12,                        // deceleracion del crucero (px/tick^2)
  reachSpeed: 13,                      // velocidad media de desplazamiento
  reachEps: 28,                        // margen para "alcanzo el punto"
  // ---- Disparo / dribling ----
  kickRange: 55,                       // radio fisico de patada
  kickCooldown: 8,                     // ticks entre patadas lejos del arco
  quickCooldown: 3,                    // ticks entre patadas cerca del arco
  dribbleCooldown: 5,                  // cooldown del golpecito de conduccion
  kickLock: 30,                        // no patear en el arranque/kickoff
  alignRadians: 0.62,                  // tolerancia para tiro directo
  rocketAlign: 0.48,                   // tolerancia fina para ROCKET
  dribbleTol: 1.15,                    // tolerancia para golpecito de dribling
  finishRange: 640,                    // distancia desde la que "remata"
  shotRange: 760,                      // distancia para tiro directo
  rocketRange: 880,                    // distancia para intentar ROCKET
  touchRange: 28,                      // rango fisico de toque (radio jug+balon)
  dribbleBack: 10,                     // px "detras" del balon al driblar
  stealRange: 115,                     // amenaza de robo del rival
  // ---- Posicionamiento ----
  goalHalf: 180,                       // media altura de la porteria (Classic)
  deadzone: 0.18,
  avoidDist: 130,                      // rango para esquivar al rival
  dangerBase: 470,                     // radio de peligro en area propia
  blockBase: 130,
  shadowSharp: 0.52                    // agresividad de la linea defensiva
};

/* ============================================================
   CONSTANTES DEL MAPA (Classic)
   ============================================================ */
const FIELD_W = 1880, FIELD_H = 1040;   // medias dimensiones del campo
const GOAL_X = 1860;                    // linea de gol
const MARGIN = 34;
const BALL_R = 10, PLAYER_R = 15;
const KICK_BOOST = 20;                  // impulso de patada fisica de HaxBall

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
    techScore: { rocket: 1, direct: 1, bb: 1 },  // tecnica que MAS convierte
    lastShot: { corner: null, type: null, tick: -999 },
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

/* Distancia perpendicular de un punto al segmento (a-b). */
function distToSeg(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const l2 = abx * abx + aby * aby || 1;
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / l2, 0, 1);
  return len(px - (ax + abx * t), py - (ay + aby * t));
}

/* ============================================================
   PREDICCIÓN FÍSICA: simula el balon tick a tick (friccion,
   rebotes en muros y parada). Devuelve la LISTA de puntos.
   ============================================================ */
function forecastBall(x, y, vx, vy, steps) {
  const pts = [];
  if (!isFinite(x) || !isFinite(y)) return pts;
  if (!isFinite(vx)) vx = 0;
  if (!isFinite(vy)) vy = 0;
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
  if (!N) return { x: meX, y: meY };
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
  if (!gs || !gs.physicsState) return null;
  const b = gs.physicsState.discs[0];
  if (!b || !b.pos) return null;
  const x = b.pos.x, y = b.pos.y;
  if (!isFinite(x) || !isFinite(y)) return null;
  return {
    x: x,
    y: y,
    xspeed: isFinite(b.speed && b.speed.x) ? b.speed.x : 0,
    yspeed: isFinite(b.speed && b.speed.y) ? b.speed.y : 0
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
   el input. En modo "sprint" (ROCKET) no se frena: se corre a
   través del balon para patearlo a máxima velocidad.
   ============================================================ */
function moveControl(meX, meY, Vx, Vy, tx, ty, sprint) {
  const dx = tx - meX, dy = ty - meY;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < 5) return { dx: 0, dy: 0 };
  const ux = dx / d, uy = dy / d;
  const spd = Vx * ux + Vy * uy;                       // componente de avance
  if (!sprint) {
    const stopD = (spd * spd) / (2 * CONFIG.brakeAcc) + 6;
    if (d > CONFIG.kickRange && spd > 4 && stopD > d) {
      return { dx: 0, dy: 0 };                         // crucero: soltar teclas
    }
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
   CONTENCION: el objetivo NUNCA debe meter al bot por la boca
   de una porteria (ahi no hay pared y se sale del mapa).
   ============================================================ */
function sanitizeTarget(tx, ty) {
  tx = clamp(tx, -FIELD_W + MARGIN, FIELD_W - MARGIN);
  ty = clamp(ty, -FIELD_H + MARGIN, FIELD_H - MARGIN);
  const nearWall = Math.abs(tx) > GOAL_X - 56;           // pegado a la linea de gol
  const inMouth = Math.abs(ty) < CONFIG.goalHalf - 40;   // dentro del corredor de la boca
  if (nearWall && inMouth) {                             // no cruzar por la boca: a la esquina
    const sY = ty >= 0 ? 1 : -1;
    tx = clamp(tx, -(GOAL_X - 40), GOAL_X - 40);
    ty = (CONFIG.goalHalf + 26) * sY;
  }
  return { x: tx, y: ty };
}

/* mueve hacia un punto, con contencion de stewards */
function steer(meX, meY, Vx, Vy, tx, ty, sprint) {
  const s = sanitizeTarget(tx, ty);
  return moveControl(meX, meY, Vx, Vy, s.x, s.y, sprint);
}

/* ============================================================
   SELECCIÓN DEL TIRO (ataque)
   Evalua los candidatos (esquinas y centro del arco) y elige el
   que menos bloquea el portero, mas cerca del balon y mas
   reforzado por el aprendizaje. Devolvemos "gy" (punto en la
   linea de gol) y si la linea directa queda libre.
   ============================================================ */
function chooseShotAim(ball, enemy) {
  const half = CONFIG.goalHalf;
  const cands = [
    { y: -half * 0.94, key: 'up' },
    { y: 0, key: null },
    { y: half * 0.94, key: 'down' }
  ];
  let best = cands[0], bestS = -1e9;
  const L = Bot.learn;
  for (const c of cands) {
    let s = (L.cornerScore[c.key || 'up'] || 0) * 2.2;      // preferencia aprendida
    if (enemy) {
      const bl = distToSeg(enemy.pos.x, enemy.pos.y, ball.x, ball.y, enemyGoalX(Bot.team), c.y);
      s -= Math.max(0, 92 - bl) * 1.15;                      // portero tapa esa linea?
      s -= Math.max(0, 75 - len(enemy.pos.x - enemyGoalX(Bot.team), enemy.pos.y - c.y)) * 0.4;
    }
    s -= Math.min(10, Math.abs(ball.y - c.y) * 0.03);        // reajuste vertical barato
    if (s > bestS) { bestS = s; best = c; }
  }
  return {
    y: best.y,
    open: enemy ? distToSeg(enemy.pos.x, enemy.pos.y, ball.x, ball.y, enemyGoalX(Bot.team), best.y) : 1e9
  };
}

/* ============================================================
   DECISIONES DE POSICIONAMIENTO DEFENSIVO
   ============================================================ */
function keeperTarget(ball, pts, ownGoalX) {
  const half = CONFIG.goalHalf;
  const s = ball.x > ownGoalX ? 1 : -1;
  let cy = null;
  if (Math.sign(ball.xspeed) === s && Math.abs(ball.xspeed) > 0.35) {
    cy = crossingAtGoal(pts, ownGoalX);
  }
  let baseY = cy != null ? cy : clamp(ball.y, -half, half);
  baseY = clamp(baseY + Bot.learn.saveBias * 30, -(half - 8), half - 8);
  const dOwn = Math.abs(ownGoalX - ball.x);
  let f = 0.30;
  if (dOwn < 300) f = 0.16;            // peligro inminente -> linea
  else if (dOwn < 700) f = 0.24;
  const tx = clamp(ownGoalX + (ball.x - ownGoalX) * f,
    Math.min(ownGoalX + s * 16, ownGoalX + s * 400),
    Math.max(ownGoalX + s * 16, ownGoalX + s * 400));
  const ty = clamp(ball.y * 0.25 + baseY * 0.75, -(half + 30), (half + 30));
  return { x: tx, y: ty };
}

function shadowTarget(ball, ownGoalX, enemy) {
  const d = Math.abs(ownGoalX - ball.x);
  let f = clamp(CONFIG.shadowSharp - d / (FIELD_W * 1.6), 0.18, CONFIG.shadowSharp);
  const s = ball.x > ownGoalX ? 1 : -1;
  if (enemy && enemy.pos) {
    const enemyDeep = Math.abs(enemy.pos.x - ownGoalX) < d;  // rival ya penetro
    if (enemyDeep) f = Math.min(f, 0.30);
  }
  const tx = clamp(ownGoalX + (ball.x - ownGoalX) * f,
    Math.min(ownGoalX + s * 90, ownGoalX + s * 560),
    Math.max(ownGoalX + s * 90, ownGoalX + s * 560));
  const ty = clamp(ball.y * 0.6 + Bot.learn.saveBias * 26, -(CONFIG.goalHalf + 95), CONFIG.goalHalf + 95);
  return { x: tx, y: ty };
}

function avoidPoint(tx, ty, meX, meY, dbp, enemyD) {
  if (!enemyD || !enemyD.pos) return { x: tx, y: ty };
  if (dbp < CONFIG.touchRange + 4) return { x: tx, y: ty };  // con el balon: se conduce
  const ex = enemyD.pos.x, ey = enemyD.pos.y;
  const bdx = tx - meX, bdy = ty - meY;
  const bl = len(bdx, bdy) || 1;
  const ux = bdx / bl, uy = bdy / bl;
  const t = ((ex - meX) * ux + (ey - meY) * uy) / bl;        // proyeccion rival 0..1
  if (t < 0 || t > 0.9) return { x: tx, y: ty };
  const pd = Math.abs((ex - meX) * (-uy) + (ey - meY) * ux);
  if (pd > CONFIG.avoidDist) return { x: tx, y: ty };
  const side = ((ex - meX) * (-uy) + (ey - meY) * ux) >= 0 ? 1 : -1;
  return { x: tx + (-uy) * side * 42, y: ty + ux * side * 42 };
}

/* ============================================================
   APRENDIZAJE (heuristico)
   ============================================================ */
function selectShotType() {
  const T = Bot.learn.techScore;
  const keys = ['rocket', 'direct', 'bb'];
  if (Math.random() < 0.12) return keys[Math.floor(Math.random() * keys.length)];  // exploracion
  let best = keys[0];
  for (const k of keys) if (T[k] > T[best]) best = k;
  return best;
}
function recordShot(type) {
  const L = Bot.learn;
  const corner = Bot.aimY >= 0 ? 'down' : 'up';
  L.lastShot = { corner: corner, type: type, tick: Bot.tick };
}
function reinforceTech() {
  const L = Bot.learn;
  if (Bot.tick - L.lastShot.tick < 150 && L.lastShot.type &&
      L.techScore[L.lastShot.type] != null) {
    L.techScore[L.lastShot.type] = Math.min(5, L.techScore[L.lastShot.type] + 0.6);
    console.log('[Neptunzinho] Aprendizaje: +1 tecnica ' + L.lastShot.type +
      ' (corner ' + L.lastShot.corner + ')');
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
    for (const k in L.techScore) L.techScore[k] = Math.max(0.4, L.techScore[k] * 0.94);
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
      ' ball(' + Bot.dbgT.bx.toFixed(0) + ',' + Bot.dbgT.by.toFixed(0) + ') g(' + Bot.dbgT.gx.toFixed(0) + ',' + Bot.dbgT.gy.toFixed(0) + ') dbp=' + Bot.dbgT.dbp.toFixed(0) +
      ' en(' + (Bot.dbgT.ex == null ? '-' : Bot.dbgT.ex.toFixed(0)) + ',' + (Bot.dbgT.ey == null ? '-' : Bot.dbgT.ey.toFixed(0)) + ') ebp=' + (Bot.dbgT.ebp == null ? '-' : Bot.dbgT.ebp.toFixed(0));
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
    }
  });
}

function kickReady() {
  return Bot.tick > Bot.kickLockUntil && Bot.tick >= Bot.lastKickTick + CONFIG.kickCooldown;
}
function quickKickReady() {
  return Bot.tick > Bot.kickLockUntil && Bot.tick >= Bot.lastKickTick + CONFIG.quickCooldown;
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

  /* ---- RECUPERACION: si salio fuera del campo (por la boca de la
     porteria), volver al centro. ---- */
  if (Math.abs(meX) > FIELD_W + 200 || Math.abs(meY) > FIELD_H + 200) {
    Bot.debugMode = 'R';
    const m = moveControl(meX, meY, 0, 0, 0, 0);
    const k = toKeys(m.dx, m.dy);
    sendInput(room, k.dx, k.dy, false);
    return;
  }

  const ball = readBall(room);
  let wantKick = false;

  /* ---- SIN PARTIDO: espera en el CENTRO del campo ---- */
  if (!ball) {
    Bot.debugMode = 'F';
    const m = steer(meX, meY, Bot.Vx, Bot.Vy, 0, 0);
    const k = toKeys(m.dx, m.dy);
    sendInput(room, k.dx, k.dy, false);
    return;
  }

  const bx = ball.x, by = ball.y;
  const pts = forecastBall(bx, by, ball.xspeed, ball.yspeed, CONFIG.predSteps);

  const ownGoalX = -enemyGoalX(Bot.team);
  const gx = enemyGoalX(Bot.team);

  /* ---- Balon fuera del campo (gol ya producido o saque en curso):
     ocupar la formacion en la propia mitad. ---- */
  if (Math.abs(bx) > FIELD_W || Math.abs(by) > FIELD_H) {
    Bot.debugMode = 'F';
    const m = steer(meX, meY, Bot.Vx, Bot.Vy, ownGoalX + Math.sign(ownGoalX) * 60, 0);
    const k = toKeys(m.dx, m.dy);
    sendInput(room, k.dx, k.dy, false);
    return;
  }

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
  const dbp = len(meX - bx, meY - by);                       // dist bot<->balon
  const ebp = enemyD && enemyD.pos ? len(enemyD.pos.x - bx, enemyD.pos.y - by) : 1e9;

  /* ---- NO perseguir una bola que esta entrando por la boca rival:
     colocarse en la esquina de ataque y esperar a que el balon
     vuelva al campo (gol/saque). ---- */
  if (Math.abs(by) < CONFIG.goalHalf - 40 && Math.abs(bx) > GOAL_X - 50) {
    Bot.debugMode = 'F';
    const m = steer(meX, meY, Bot.Vx, Bot.Vy,
      gx - Math.sign(gx) * 130, (by >= 0 ? 1 : -1) * (CONFIG.goalHalf + 60));
    const k = toKeys(m.dx, m.dy);
    sendInput(room, k.dx, k.dy, false);
    return;
  }

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
    if (dbp < CONFIG.kickRange && kickReady()) {
      wantKick = true;
      Bot.lastKickTick = Bot.tick;
      recordShot('clear');
    }
    sendInput(room, k.dx, k.dy, wantKick);
    return;
  }

  /* ================= SOMBRA (enemigo mas cerca y con el balon) ========== */
  if (ebp < dbp - 30) {
    Bot.debugMode = 'S';
    const sp = shadowTarget(ball, ownGoalX, enemyD || null);
    const m = steer(meX, meY, Bot.Vx, Bot.Vy, sp.x, sp.y);
    const k = toKeys(m.dx, m.dy);
    if (dbp < CONFIG.kickRange && kickReady()) {
      wantKick = true;
      Bot.lastKickTick = Bot.tick;
      recordShot('clear');
    }
    sendInput(room, k.dx, k.dy, wantKick);
    return;
  }

  /* ================= ATAQUE ================= */
  const aim = chooseShotAim(ball, enemyD || null);
  const gy = aim.y;
  Bot.aimY = gy;

  const gdx = gx - bx, gdy = gy - by;
  const distGoal = len(gdx, gdy) || 1;
  const ugx = gdx / distGoal, ugy = gdy / distGoal;
  const nearBall = dbp < CONFIG.kickRange;
  const enemyDistBall = enemyD ? len(enemyD.pos.x - bx, enemyD.pos.y - by) : 1e9;

  let tx, ty, sprint = false;
  let aimAng = Math.atan2(ugy, ugx);
  let shotType = null;

  const aMeB = Math.atan2(by - meY, bx - meX);
  const ownDeep = Math.abs(bx - ownGoalX) < CONFIG.dangerBase * 0.75;
  const enemyThreat = enemyD && enemyDistBall < CONFIG.stealRange;
  const enemyInLane = enemyD &&
    distToSeg(enemyD.pos.x, enemyD.pos.y, bx, by, gx, gy) < 70;
  const planType = selectShotType();
  const rocketOk = planType === 'rocket' && distGoal < CONFIG.rocketRange &&
    aim.open > 70 && !enemyInLane;
  const distOff = Math.abs((meX - bx) * ugy - (meY - by) * ugx);   // desalineacion lateral
  const behind = (meX - bx) * ugx + (meY - by) * ugy < -10;        // estoy detras del balon?

  if (rocketOk && distOff < 55 && behind) {
    /* ROCKET: alineado DETRAS del balon -> SPRINTAR a traves de el.
       Cada contacto lo empuja con la velocidad del bot + impulso:
       la primera patada lo manda a ~20, y las siguientes suman
       hasta dejarlo "rocketeado" (~40 px/tick). */
    Bot.debugMode = 'R';
    shotType = 'rocket';
    sprint = true;
    tx = bx; ty = by;
  } else if (!nearBall) {
    /* PERSEGUIR / INTERCEPTAR, llegando ligeramente "detras" del
       balon para poder empujarlo hacia el arco (no pasarse). */
    Bot.debugMode = 'P';
    const p = interceptionPoint(meX, meY, pts);
    tx = p.x - ugx * 8;
    ty = p.y - ugy * 8;
  } else {
    if (ownDeep) {
      /* CLEAR defensivo: sacarla lejos del area */
      Bot.debugMode = 'X';
      shotType = 'clear';
      const side = by >= 0 ? 1 : -1;
      tx = ownGoalX + (bx - ownGoalX) * 0.7 + (Bot.team === 1 ? 180 : -180);
      ty = clamp(by + side * 240, -FIELD_H * 0.7, FIELD_H * 0.7);
      aimAng = Math.atan2(ty - by, tx - bx);
    } else if (enemyThreat && distGoal < CONFIG.finishRange * 1.7) {
      /* BB KICK: regatear al rival con un golpe corto al lado libre */
      Bot.debugMode = 'B';
      shotType = 'bb';
      const dAng = normAngle(Math.atan2(ugy, ugx) - Math.atan2(enemyD.pos.y - by, enemyD.pos.x - bx));
      const side = dAng < 0 ? -1 : 1;
      const tapAng = normAngle(Math.atan2(ugy, ugx) + side * 1.05);
      aimAng = tapAng;
      tx = bx - Math.cos(tapAng) * 10;
      ty = by - Math.sin(tapAng) * 10;
    } else if (rocketOk) {
      /* ROCKET fase previa: colocarse detras del balon en la linea. */
      Bot.debugMode = 'R';
      shotType = 'rocket';
      tx = bx - ugx * 8;
      ty = by - ugy * 8;
    } else if (distGoal < CONFIG.shotRange) {
      /* TIRO DIRECTO ajustado al hueco elegido */
      Bot.debugMode = 'S';
      shotType = 'direct';
      tx = bx - ugx * 10;
      ty = by - ugy * 10;
    } else {
      /* DRIBLE con golpecitos hacia el hueco elegido */
      Bot.debugMode = 'D';
      shotType = 'direct';
      tx = bx - ugx * CONFIG.dribbleBack;
      ty = by - ugy * CONFIG.dribbleBack;
    }
  }

  /* ---- PATADA según la jugada ---- */
  if (dbp <= CONFIG.kickRange) {
    const approach = Bot.Vx * ugx + Bot.Vy * ugy;
    const diff = Math.abs(normAngle(aMeB - aimAng));
    let allow = false;

    if (Bot.debugMode === 'R') {
      allow = diff < CONFIG.rocketAlign && quickKickReady();
    } else if (Bot.debugMode === 'B') {
      allow = diff < CONFIG.dribbleTol && kickReady();
    } else if (Bot.debugMode === 'S') {
      allow = diff < CONFIG.alignRadians && quickKickReady();
    } else if (Bot.debugMode === 'D') {
      allow = diff < CONFIG.dribbleTol && approach > 1 &&
        Bot.tick > Bot.kickLockUntil && Bot.tick >= Bot.lastKickTick + CONFIG.dribbleCooldown;
    } else if (Bot.debugMode === 'X') {
      allow = diff < 1.2 && kickReady();
    }

    if (allow) {
      wantKick = true;
      Bot.lastKickTick = Bot.tick;
      recordShot(shotType || 'direct');
    }
  }

  /* ---- Esquive al rival y confines del campo ---- */
  if (enemyD) {
    const av = avoidPoint(tx, ty, meX, meY, dbp, enemyD);
    tx = av.x; ty = av.y;
  }
  tx = clamp(tx, -FIELD_W + MARGIN, FIELD_W - MARGIN);
  ty = clamp(ty, -FIELD_H + MARGIN, FIELD_H - MARGIN);
  if (process.env.NEPT_DEBUG) Bot.dbgT = { x: tx, y: ty, near: nearBall, dbp: dbp, mx: meX, my: meY, vx: Bot.Vx, vy: Bot.Vy, bx: bx, by: by, gx: gx, gy: gy, ex: (enemyD && enemyD.pos ? enemyD.pos.x : null), ey: (enemyD && enemyD.pos ? enemyD.pos.y : null), ebp: ebp };

  const m = steer(meX, meY, Bot.Vx, Bot.Vy, tx, ty, sprint);
  const k = toKeys(m.dx, m.dy);
  sendInput(room, k.dx, k.dy, wantKick);
}

/* ============================================================
   HOST / ROOM CONFIG (callbacks)
   ============================================================ */
let currentRoom = null;
let logError = -99999;   // tick del ultimo error logueado

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
    version: '3.0',
    author: 'Neptunzinho',
    description: 'IA profesional 1v1 con rockets, BB kicks, dribling y aprendizaje (node-haxball)',
    allowFlags: AllowFlags.CreateRoom
  });

  const that = this;

  this.onGameTick = function () {
    try {
      tickUpdate(that.room);
    } catch (e) {
      const t = Bot.tick || 0;
      if (t - logError > 600) { logError = t; console.error('[Neptunzinho] Error en onGameTick t' + t + ':', e && e.stack ? e.stack : e); }
      try {
        // NUNCA dejar teclas pegadas: ante error, soltar todo.
        if (Bot.lastSentState !== 0) {
          Bot.lastSentState = 0;
          that.room.fakeSendPlayerInput(0, CONFIG.botId);
        }
      } catch (_e) {}
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
        reinforceTech();
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
        const T = Bot.learn.techScore;
        sendAnnouncement(that.room,
          'IA: ' + Bot.learn.goalsFor + ' a favor, ' + Bot.learn.goalsAgainst +
          ' en contra | esquinas: arriba=' + Bot.learn.cornerScore.up.toFixed(1) +
          ' abajo=' + Bot.learn.cornerScore.down.toFixed(1) +
          ' | tecnica: rocket=' + T.rocket.toFixed(1) + ' directo=' + T.direct.toFixed(1) + ' bb=' + T.bb.toFixed(1) +
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

    return handled ? false : true;
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

      console.log('[Neptunzinho] Creando sala "' + CONFIG.roomName + '" con IA v3 (rockets/BB/learn)...');
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