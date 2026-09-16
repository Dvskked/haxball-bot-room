'use strict';

/* ============================================================
   NE PTUNZINHO — Bot IA para Node.js
   Libreria: node-haxball  (github.com/wxyz-abcd/node-haxball)
   ------------------------------------------------------------
   POR QUE ESTO FUNCIONA y la pagina oficial no:
   node-haxball emula el host completo en Node y expone el control
   real de input de cada jugador: room.fakeSendPlayerInput().
   La API oficial (haxball.com/headless) NO trae ese metodo.

   USO:
   1) npm install node-haxball
   2) Obten tu token en https://www.haxball.com/headlesstoken
      (formato: thr1.AAAA....BBB)
   3) Ponlo en TOKEN o en la variable HAXBALL_TOKEN
   4) node index.js
      El link de la sala se imprime en consola (onAfterRoomLink).
   ============================================================ */

const api = require('node-haxball')();
const { Utils, Room, RoomConfig, AllowFlags } = api;

/* ============================================================
   CONFIGURACIÓN (misma base que haxball-bot-ia.js)
   ============================================================ */
const TOKEN = process.env.HAXBALL_TOKEN || 'thr1.AAAAAGqqAveOEyb13c4oqQ.GT0ifiv2I1U';

const CONFIG = {
  roomName: 'Sala Bot Pro | Neptunzinho (1v1)',
  botName: 'Neptunzinho',
  botAvatar: '\u26A1',                 // ⚡
  botId: 65535,                        // id del bot "en memoria" (usado por node-haxball)
  botTeam: 1,                          // 1 = Rojo | 2 = Azul
  scoreLimit: 3,                       // goles para ganar (1v1)
  timeLimit: 0,                        // minutos (0 = sin tiempo)
  // ---- Física ----
  friction: 0.99,                      // decaimiento de velocidad del balon por tick
  predSteps: 30,                       // frames a futuro (~0.5 s)
  // ---- Disparo ----
  kickRange: 50,                       // rango maximo de patada
  kickCooldown: 8,                     // ticks entre patadas (~133 ms)
  quickCooldown: 4,                    // ticks cerca del arco (finishing)
  kickLock: 90,                        // no patear en el arranque del kickoff
  alignRadians: 0.6,                   // tolerancia de alineacion para disparar
  // ---- Movimiento ----
  deadzone: 0.18,                      // umbral dx/dy continuo -> teclas digitales
  stickDist: 22,                       // px "detras" del balon al atacar
  leadScale: 0.24,                     // anticipacion al punto futuro
  blockBase: 130,                      // linea de bloqueo defensivo
  dangerBase: 470,                     // radio de peligro en area propia
  goalHalf: 180,                       // media altura de la porteria (Classic)
  avoidDist: 170,                      // rango para esquivar rival
  finishRange: 420                     // distancia de inicio del modo finisher
};

/* ============================================================
   CONSTANTES DEL MAPA (Classic)
   ============================================================ */
const FIELD_W = 1880, FIELD_H = 1040;   // medias dimensiones del campo
const GOAL_X = 1860;                    // linea de gol
const MARGIN = 30;

/* ============================================================
   ESTADO GLOBAL
   ============================================================ */
const Bot = {
  tick: 0,
  lastKickTick: -1000,
  kickLockUntil: 0,
  lastSentState: 0,
  lastBall: null,
  team: CONFIG.botTeam,
  learn: {
    goalsFor: 0,              // goles a favor
    goalsAgainst: 0,          // goles en contra
    cornerScore: { up: 0, down: 0 },   // preferencia aprendida por esquina
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

/* Prediccion fisica: posicion += velocidad con friccion 0.99 por tick
   y rebote en los muros. Salida en predX/predY (sin objetos por frame). */
let predX = 0, predY = 0;
function predictBall(x, y, vx, vy, steps) {
  for (let i = 0; i < steps; i++) {
    x += vx; y += vy;
    if (x > FIELD_W - 8) { x = FIELD_W - 8; vx = -vx; }
    else if (x < -FIELD_W + 8) { x = -FIELD_W + 8; vx = -vx; }
    if (y > FIELD_H - 8) { y = FIELD_H - 8; vy = -vy; }
    else if (y < -FIELD_H + 8) { y = -FIELD_H + 8; vy = -vy; }
    vx *= CONFIG.friction; vy *= CONFIG.friction;
  }
  predX = x; predY = y;
}

/* ============================================================
   LECTURA DEL BALON en node-haxball:
   room.gameStateExt (extrapolado) -> physicsState.discs[0].
   El disco trae pos {x,y} y speed {x,y} (px/tick). Si no hay
   partido, ball.pos es null -> devolvemos null.
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

/* ============================================================
   LECTURA DE UN JUGADOR (disco extrapolado)
   ============================================================ */
function playerDisc(player) {
  if (!player || !player.disc) return null;
  return player.disc.ext || player.disc;
}

/* ============================================================
   APRENDIZAJE (igual que la version browser)
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
    L.cornerScore.up *= 0.92;
    L.cornerScore.down *= 0.92;
  }
}

/* Esquina mas lejana del rival, con sesgo aprendido */
function selectAimY(by, enemyY) {
  const UP = -130, DOWN = 130;
  if (enemyY != null) {
    const upS = Math.abs(enemyY - UP) + Bot.learn.cornerScore.up;
    const dnS = Math.abs(enemyY - DOWN) + Bot.learn.cornerScore.down;
    return upS >= dnS ? UP : DOWN;
  }
  if (by > 0) return UP;
  if (by < 0) return DOWN;
  return 0;
}

/* ============================================================
   ENVÍO DE INPUT en node-haxball.
   Utils.keyState(dirX, dirY, kick) devuelve un int 0..31:
     [kick]*16 + [right]*8 + [left]*4 + [up]*2 + [down]*1
   room.fakeSendPlayerInput(input, byId) lo aplica al bot.
   IMPORTANTE (documentado en el repo): si cada tick enviamos el
   mismo valor, se produce desync; solo enviamos cuando cambia y
   para repetir kick hay que soltar el bit primero (& -17).
   ============================================================ */
function sendInput(room, dirX, dirY, wantKick) {
  let desired = Utils.keyState(dirX, dirY, !!wantKick);
  const me = room.getPlayer(CONFIG.botId);
  const isKicking = !!(me && me.isKicking);

  // Diferir el envio fuera del onGameTick (recomendacion del repo)
  Utils.runAfterGameTick(() => {
    if (desired !== Bot.lastSentState || wantKick !== isKicking) {
      if (desired === Bot.lastSentState && wantKick && !isKicking) {
        room.fakeSendPlayerInput(desired & -17, CONFIG.botId);   // soltar kick para poder repetir
      }
      room.fakeSendPlayerInput(desired, CONFIG.botId);
      Bot.lastSentState = desired;
      if (wantKick) {
        Bot.learn.lastShot = { corner: (Bot.aimY >= 0 ? 'down' : 'up'), tick: Bot.tick };
      }
    }
  });
}

/* ============================================================
   IA PRINCIPAL (cada game tick)
   ============================================================ */
function tickUpdate(room) {
  Bot.tick++;
  decayLearning();

  // Seguridad: si el bot en memoria se perdio, recrearlo
  if (!room.getPlayer(CONFIG.botId)) {
    try {
      room.fakePlayerJoin(CONFIG.botId, CONFIG.botName, 'us', CONFIG.botAvatar,
        'fake-ip-do-not-believe', 'fake-auth-do-not-believe');
      room.setPlayerTeam(CONFIG.botId, Bot.team);
    } catch (e) {}
    return;
  }

  room.extrapolate();

  const me = room.getPlayer(CONFIG.botId);
  const disc = playerDisc(me);
  if (!disc || !disc.pos) return;
  const meX = disc.pos.x, meY = disc.pos.y;

  const ball = readBall(room);

  // Sin partido en curso: el bot se coloca en formacion (se le ve vivo).
  if (!ball) {
    const fx = Bot.team === 1 ? -FIELD_W * 0.18 : FIELD_W * 0.18;
    const fy = -FIELD_H * 0.15;
    const dx = fx - meX, dy = fy - meY;
    if (len(dx, dy) > 40) {
      sendInput(room, dx < -CONFIG.deadzone ? -1 : (dx > CONFIG.deadzone ? 1 : 0),
                       dy < -CONFIG.deadzone ? -1 : (dy > CONFIG.deadzone ? 1 : 0), false);
    } else {
      sendInput(room, 0, 0, false);
    }
    return;
  }

  predictBall(ball.x, ball.y, ball.xspeed, ball.yspeed, CONFIG.predSteps);
  const bx = ball.x, by = ball.y;

  const ownGoalX = -enemyGoalX(Bot.team);
  const attackSide = Bot.team === 1 ? 1 : -1;

  // Rival (primer jugador real del otro equipo, si existe)
  let enemyD = null;
  const players = room.players || [];
  for (const p of players) {
    if (p.id === CONFIG.botId) continue;
    if (p.team !== 0 && p.team === (Bot.team === 1 ? 2 : 1)) {
      enemyD = playerDisc(p);
      if (enemyD) break;
    }
  }
  const enemyY = enemyD ? enemyD.pos.y : null;

  // Aprendizaje por marcador: perdiendo -> defensa mas honda
  const drift = clamp((Bot.learn.goalsAgainst - Bot.learn.goalsFor) * 6, -45, 45);
  const dangerDist = CONFIG.dangerBase + drift * 0.6;
  const blockDist = clamp(CONFIG.blockBase - drift, 80, 210);
  const danger = (Math.abs(bx - ownGoalX) < dangerDist) && (Math.abs(by) < CONFIG.goalHalf + 150);

  const gx = enemyGoalX(Bot.team);
  const gy = selectAimY(by, enemyY);
  Bot.aimY = gy;

  let targetX, targetY;

  if (danger) {
    // DEFENSA: P_def en la recta porteria propia -> balon (bloqueo de tiro)
    targetX = ownGoalX + (bx - ownGoalX) * 0.42;
    targetY = by * 0.38;
  } else if ((bx - ownGoalX) * attackSide < 0) {
    // CAMPO PROPIO: misma linea, mas adelantada
    targetX = ownGoalX + (bx - ownGoalX) * 0.48;
    targetY = by * 0.45;
  } else {
    // ATAQUE: interceptar posicion FUTURA del balon y colocarse "detras"
    const dxg = predX - gx, dyg = predY - gy;
    const lg = len(dxg, dyg) || 1;
    const dbp = len(meX - bx, meY - by);
    const close = Math.abs(bx - gx) < CONFIG.finishRange;
    const lead = Math.min(70, dbp * CONFIG.leadScale) * (close ? 0.55 : 1);
    targetX = predX + (dxg / lg) * (CONFIG.stickDist + lead);
    targetY = predY + (dyg / lg) * (CONFIG.stickDist + lead);

    // Esquivar al rival cuando disputa el balon (nudge perpendicular)
    if (enemyD) {
      const ex = enemyD.pos.x - bx, ey = enemyD.pos.y - by;
      const ed = len(ex, ey);
      if (ed > 0 && ed < CONFIG.avoidDist) {
        const ux = ex / ed, uy = ey / ed;
        const pxx = -uy, pyy = ux;
        if (len(enemyD.pos.x - (targetX + pxx * 45), enemyD.pos.y - (targetY + pyy * 45)) >=
            len(enemyD.pos.x - (targetX - pxx * 45), enemyD.pos.y - (targetY - pyy * 45))) {
          targetX += pxx * 45; targetY += pyy * 45;
        } else {
          targetX -= pxx * 45; targetY -= pyy * 45;
        }
      }
    }
  }

  targetX = clamp(targetX, -FIELD_W + MARGIN, FIELD_W - MARGIN);
  targetY = clamp(targetY, -FIELD_H + MARGIN, FIELD_H - MARGIN);

  // Direccion digital (el jugador de haxball se mueve a velocidad
  // maxima en 8 direcciones, no hay control de velocidad proporcional)
  const ddx = targetX - meX, ddy = targetY - meY;
  const distT = len(ddx, ddy);
  let dirX = 0, dirY = 0;
  if (distT > 8) {
    dirX = ddx / distT < -CONFIG.deadzone ? -1 : (ddx / distT > CONFIG.deadzone ? 1 : 0);
    dirY = ddy / distT < -CONFIG.deadzone ? -1 : (ddy / distT > CONFIG.deadzone ? 1 : 0);
  }

  // Disparo: alineacion balon->esquina < 0.6 rad con cooldown
  let wantKick = false;
  const distBP = len(bx - meX, by - meY);
  if (distBP <= CONFIG.kickRange + 6 && Bot.tick > Bot.kickLockUntil) {
    const aBotToBall = Math.atan2(by - meY, bx - meX);
    const aBallToGoal = Math.atan2(gy - by, gx - bx);
    const diff = Math.abs(normAngle(aBotToBall - aBallToGoal));
    let aligned = diff < CONFIG.alignRadians;
    if (danger && distBP <= CONFIG.kickRange) aligned = true;   // despeje

    const nearGoal = Math.abs(bx - gx) < CONFIG.finishRange;
    const cd = nearGoal ? CONFIG.quickCooldown : CONFIG.kickCooldown;

    if (aligned && Bot.tick >= Bot.lastKickTick + cd) {
      wantKick = true;
      Bot.lastKickTick = Bot.tick;
    }
  }

  sendInput(room, dirX, dirY, wantKick);
}

/* ============================================================
   ROOM CONFIG (los callbacks del host)
   ============================================================ */
let logError = false;

function sendAnnouncement(room, msg) {
  try { room.sendAnnouncement(msg, 0x00FF00, 'bold', 1); }
  catch (e) { console.log('[Announcement]', msg); }
}

function NeptunBot(api) {
  Object.setPrototypeOf(this, RoomConfig.prototype);
  RoomConfig.call(this, {
    name: 'Neptunzinho',
    version: '1.0',
    author: 'Neptunzinho',
    description: 'IA profesional 1v1 con aprendizaje (node-haxball)',
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
      if (playerObj.id !== CONFIG.botId && playerObj.team === 0) {
        // El humano va al equipo contrario del bot (1v1) y obtiene admin.
        that.room.setPlayerTeam(playerObj.id, CONFIG.botTeam === 1 ? 2 : 1);
        that.room.setPlayerAdmin(playerObj.id, true);
        sendAnnouncement(that.room, 'Recibiste admin. Bienvenido, ' + playerObj.name);
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
      if (tg === Bot.team) { Bot.learn.goalsFor++; reinforceCorner(); }
      else { Bot.learn.goalsAgainst++; }
      sendAnnouncement(that.room,
        'GOL | ' + (tg === Bot.team ? 'NOSOTROS' : 'RIVAL') +
        ' | IA: defensa ' + (Bot.learn.goalsAgainst >= Bot.learn.goalsFor ? 'mas solida' : 'mas ofensiva'));
    } catch (e) {}
  };

  this.onPlayerChat = function (playerObj, message) {
    try {
      const m = String(message).trim().toLowerCase();
      if (m === '!ia') {
        sendAnnouncement(that.room,
          'IA: ' + Bot.learn.goalsFor + ' a favor, ' + Bot.learn.goalsAgainst +
          ' en contra | esquinas: arriba=' + Bot.learn.cornerScore.up.toFixed(1) +
          ' abajo=' + Bot.learn.cornerScore.down.toFixed(1));
      }
      if (m === '!admin') { that.room.setPlayerAdmin(playerObj.id, true); }
      if (m === '!rojo') { Bot.team = 1; that.room.setPlayerTeam(CONFIG.botId, 1); }
      if (m === '!azul') { Bot.team = 2; that.room.setPlayerTeam(CONFIG.botId, 2); }
    } catch (e) {}
  };
}

/* ============================================================
   CREACIÓN DE LA SALA (host headless en Node)
   ============================================================ */
Room.create({
  name: CONFIG.roomName,
  password: null,
  showInRoomList: false,
  maxPlayerCount: 4,
  noPlayer: true,            // host sin jugador humano -> usamos el bot "en memoria"
  token: TOKEN
}, {
  storage: {
    player_name: CONFIG.botName,   // nombre que se mostrara para el host
    avatar: CONFIG.botAvatar,
    geo: { lat: -34, lon: -64, flag: 'ar' }   // ajusta tu pais si quieres
  },
  config: new NeptunBot(api),

  onOpen(room) {
    try {
      // Crear el bot "en memoria" (id 65535) y ponerlo en rojo
      room.fakePlayerJoin(CONFIG.botId, CONFIG.botName, 'us', CONFIG.botAvatar,
        'fake-ip-do-not-believe', 'fake-auth-do-not-believe');
      room.setPlayerTeam(CONFIG.botId, CONFIG.botTeam);

      if (typeof room.setScoreLimit === 'function') room.setScoreLimit(CONFIG.scoreLimit);
      if (typeof room.setTimeLimit === 'function') room.setTimeLimit(CONFIG.timeLimit);

      try { // Estadio Classic (disco 0 = balon)
        const defs = Utils.getDefaultStadiums();
        if (defs && defs[0] && typeof room.setStadium === 'function') room.setStadium(defs[0]);
      } catch (e) {}

      room.onAfterRoomLink = function (link) {
        console.log('\n==========================================');
        console.log('  Sala lista. Entra aqui: ' + link);
        console.log('  El bot "' + CONFIG.botName + '" juega en equipo ' + (Bot.team === 1 ? 'ROJO' : 'AZUL') +
          '. Tu enemigo entra por el link.');
        console.log('  Chat: !ia (stats), !admin, !rojo / !azul (lado del bot)');
        console.log('==========================================\n');
      };

      console.log('[Neptunzinho] Creando sala "' + CONFIG.roomName + '" con el bot en memoria...');

      // Arranque del partido (el bot juega solo contra arco vacio o contra el humano)
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