(function () {
  'use strict';

  /* ============================================================
     GUARD: debe ejecutarse dentro de https://haxball.com/headless
     ============================================================ */
  if (typeof HBInit !== 'function') {
    if (typeof console !== 'undefined') {
      console.error('HBInit no esta definido. Abre https://haxball.com/headless y pega el script ahi.');
    }
    return;
  }

  /* ============================================================
     CREACIÓN DE LA SALA (1v1)
     ============================================================ */
  var room = HBInit({
    roomName: 'Sala Bot Pro | Neptunzinho (1v1 AF)',
    maxPlayers: 4,
    public: false,
    noPlayer: false
  });

  if (!room) {
    console.log('[Neptunzinho] Ya existe una sala activa en esta cuenta. Cierra la otra o usa otro navegador.');
    return;
  }

  /* ============================================================
     CONFIGURACIÓN EDITABLE
     ============================================================ */
  var CFG = {
    botName: 'Neptunzinho',   // El jugador a controlar (busqueda ignora mayus/espacios)
    botAvatar: '\u26A1',      // ⚡
    botTeam: 1,               // 1 = Rojo | 2 = Azul
    grabFirst: true,          // Si nadie se llama botName, controla al primer jugador que entre
    allAdmins: true,          // Todos entran como admin
    autoBalance: true,        // Reparte espectadores en equipos
    autoStart: true,          // Lanza el partido cuando hay 1 jugador por equipo
    stadium: '',              // '' = lo pone el admin; o 'Classic', '1v1 AF', etc.
    // ---- Parámetros físicos ----
    friction: 0.99,           // Decaimiento de la velocidad del balon por tick
    predSteps: 30,            // Frames a futuro para interceptar (~0.5 s)
    // ---- Parámetros de disparo ----
    kickRange: 50,            // Distancia maxima bot-balon para patear
    kickCooldown: 8,          // Cooldown normal en ticks (~133 ms)
    quickCooldown: 4,         // Cooldown rápido cerca del arco rival (finishing)
    kickLock: 90,             // No patear justo tras el kickoff (regla)
    alignRadians: 0.6,        // Tolerancia de alineacion para disparar
    // ---- Parámetros de movimiento ----
    stickDist: 22,            // px "detras" del balon al atacar
    leadScale: 0.24,          // Anticipacion hacia la posicion futura del balon
    blockBase: 130,           // Distancia base de la linea de bloqueo defensivo
    dangerBase: 470,          // Radio base de peligro en area propia
    goalHalf: 180,            // Media altura de la porteria (Classic)
    avoidDist: 170,           // Rango para esquivar al rival al llevar el balon
    finishRange: 420          // Distancia al arco rival para modo finisher
  };

  /* ============================================================
     CONSTANTES DEL MAPA (Classic ~3760x2080)
     ============================================================ */
  var FIELD_W = 1880, FIELD_H = 1040;   // Medias dimensiones del campo
  var GOAL_X = 1860;                    // Linea de gol
  var MARGIN = 30;

  /* ============================================================
     ESTADO GLOBAL
     ============================================================ */
  var bot = { playerId: null, team: CFG.botTeam };
  var tick = 0;
  var lastKickTick = -1000;
  var kickLockUntil = 0;
  var lastStartTry = -60;
  var tickError = false;
  var predX = 0, predY = 0;             // Salida de prediccion (sin allocs por frame)

  /* ============================================================
     SISTEMA DE APRENDIZAJE (memoria de partido)
     == Refuerza buenas decisiones y corrige las malas. ==========
     - goalsFor/goalsAgainst => influye en qué tan defensivo juega.
     - cornerScore           => aprende qué esquina convierte mas
       (refuerza la esquina del utlimo disparo cuando hay gol).
     ============================================================ */
  var Learn = {
    goalsFor: 0,
    goalsAgainst: 0,
    cornerScore: { up: 0, down: 0 },    // Preferencia por esquina (evidencia acumulada)
    lastShot: { corner: null, tick: -999 },
    decayTick: 0,
    reinforce: function () {
      if (tick - this.lastShot.tick < 150 && this.lastShot.corner) {
        this.cornerScore[this.lastShot.corner] = Math.min(4, this.cornerScore[this.lastShot.corner] + 1);
        console.log('[Neptunzinho] Aprendizaje: +1 esquina ' + this.lastShot.corner);
      }
    },
    decay: function () {
      this.cornerScore.up *= 0.92;
      this.cornerScore.down *= 0.92;
    }
  };

  /* ============================================================
     DETECCIÓN DE API (clave: versiones viejas NO tienen
     setPlayerInputs; usan setPlayerInputControls(id, {up,down,...}))
     ============================================================ */
  var API = { power: 'setPlayerInputs', legacy: null };
  if (typeof room.setPlayerInputs !== 'function') {
    API.power = null;
    if (typeof room.setPlayerInputControls === 'function') API.legacy = 'setPlayerInputControls';
    else if (typeof room.setPlayerInputControl === 'function') API.legacy = 'setPlayerInputControl';
  }
  console.log('[Neptunzinho] API detectada:', API.power ? 'moderna (setPlayerInputs)' : 'legacy (' + API.legacy + ')');

  /* ============================================================
     MATEMÁTICA VECTORIAL (vanilla, sin allocs pesados)
     ============================================================ */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function len(x, y) { return Math.sqrt(x * x + y * y); }
  function normAngle(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
  function enemyGoalX(team) { return team === 1 ? GOAL_X : -GOAL_X; }

  // Prediccion fisica: posicion += velocidad con friccion 0.99 y rebote
  // en los muros. Salida en predX/predY para no asignar por frame.
  function predictBall(ball, steps) {
    var x = ball.x, y = ball.y;
    var vx = ball.xspeed, vy = ball.yspeed;
    for (var i = 0; i < steps; i++) {
      x += vx; y += vy;
      if (x > FIELD_W - 8) { x = FIELD_W - 8; vx = -vx; }
      else if (x < -FIELD_W + 8) { x = -FIELD_W + 8; vx = -vx; }
      if (y > FIELD_H - 8) { y = FIELD_H - 8; vy = -vy; }
      else if (y < -FIELD_H + 8) { y = -FIELD_H + 8; vy = -vy; }
      vx *= CFG.friction; vy *= CFG.friction;
    }
    predX = x; predY = y;
  }

  function matchName(name) {
    if (!name) return false;
    return String(name).trim().toLowerCase() === String(CFG.botName).trim().toLowerCase();
  }

  /* ============================================================
     ENVÍO DE CONTROL (compatible con ambas generaciones de API)
     ============================================================ */
  function sendInputs(id, dx, dy, kick, dash) {
    if (API.power) {
      room.setPlayerInputs({ dx: dx, dy: dy, kick: !!kick, dash: !!dash }, id);
    } else if (API.legacy) {
      room[API.legacy](id, {
        up: dy < -0.15,
        down: dy > 0.15,
        left: dx < -0.15,
        right: dx > 0.15,
        kick: !!kick
      });
    } else {
      console.error('[Neptunzinho] No existe funcion de control en esta version.');
    }
  }

  /* ============================================================
     GESTIÓN DEL BOT (asignacion, avatar, reconexion)
     ============================================================ */
  function bond(player, forceTeam) {
    bot.playerId = player.id;
    if (forceTeam) bot.team = forceTeam;
    else if (player.team !== 0) bot.team = player.team;
    try { room.setPlayerAvatar(player.id, CFG.botAvatar); } catch (e) {}
    if (player.team === 0) room.setPlayerTeam(player.id, bot.team);
    room.sendAnnouncement(CFG.botAvatar + ' Neptunzinho IA conectado en equipo ' + (bot.team === 1 ? 'ROJO' : 'AZUL'));
  }

  function reclaimBot() {
    var pl;
    try { pl = room.getPlayerList(); } catch (e) { return false; }
    for (var i = 0; i < pl.length; i++) {
      if (matchName(pl[i].name)) { bond(pl[i], pl[i].team || CFG.botTeam); return true; }
    }
    return false;
  }

  // Escaneo inicial: si el host ya estaba dentro cuando se pego el script,
  // este enlace lo recupera y el bot empieza a moverse de inmediato.
  function claimHost() {
    if (bot.playerId !== null) return;
    var pl;
    try { pl = room.getPlayerList(); } catch (e) { return; }
    var firstTeam = null, first = null;
    for (var i = 0; i < pl.length; i++) {
      var p = pl[i];
      if (matchName(p.name)) { bond(p, p.team || CFG.botTeam); return; }
      if (!first) first = p;
      if (p.team !== 0 && !firstTeam) firstTeam = p;
    }
    if (CFG.grabFirst && (firstTeam || first)) bond(firstTeam || first);
  }

  function balanceTeams() {
    if (!CFG.autoBalance) return;
    var pl;
    try { pl = room.getPlayerList(); } catch (e) { return; }
    var r = 0, bl = 0;
    for (var i = 0; i < pl.length; i++) {
      if (pl[i].team === 1) r++;
      else if (pl[i].team === 2) bl++;
    }
    for (var j = 0; j < pl.length; j++) {
      var p = pl[j];
      if (p.team === 0) {
        var t = r <= bl ? 1 : 2;
        room.setPlayerTeam(p.id, t);
        if (t === 1) r++; else bl++;
      }
    }
  }

  // Arranque automatico del partido: falla seguro si la sala no inicio.
  function maybeStartGame() {
    if (!CFG.autoStart || typeof room.startGame !== 'function') return;
    if (tick - lastStartTry < 60) return;
    lastStartTry = tick;
    try {
      var s = room.getScores();
      if (!s || !s.scores) {
        var pl = room.getPlayerList();
        var r = 0, bl = 0;
        for (var i = 0; i < pl.length; i++) {
          if (pl[i].team === 1) r++;
          else if (pl[i].team === 2) bl++;
        }
        if (r >= 1 && bl >= 1) room.startGame();
      }
    } catch (e) {}
  }

  /* ============================================================
     EVENTOS DE SALA
     ============================================================ */
  room.onPlayerJoin = function (player) {
    if (matchName(player.name)) { bond(player, player.team); return; }
    if (CFG.grabFirst && bot.playerId === null) bond(player);
    if (CFG.allAdmins) { try { room.setPlayerAdmin(player.id, true); } catch (e) {} }
    balanceTeams();
  };

  room.onPlayerLeave = function (player) {
    if (player.id === bot.playerId) {
      bot.playerId = null;
      reclaimBot();
    }
    balanceTeams();
  };

  room.onPlayerTeamChange = function (player) {
    if (player.id === bot.playerId) bot.team = player.team;
  };

  room.onPositionsReset = function () { kickLockUntil = tick + CFG.kickLock; };
  room.onGameStart = function () { kickLockUntil = tick + CFG.kickLock; };

  room.onTeamGoal = function (team) {
    kickLockUntil = tick + CFG.kickLock;
    if (team === bot.team) {
      Learn.goalsFor++;
      Learn.reinforce();
    } else {
      Learn.goalsAgainst++;
    }
    room.sendAnnouncement('GOL | ' + (team === bot.team ? 'NOSOTROS' : 'RIVAL') +
      ' | aprendizaje: defensa ' + (Learn.goalsAgainst >= Learn.goalsFor ? 'mas solida' : 'mas ofensiva'));
  };

  room.onPlayerChat = function (player, message) {
    var m = String(message).trim().toLowerCase();
    var isAdmin = !player || player.admin;

    if (m === '!bot' || m === '/bot') {
      bot.playerId = null;
      if (!reclaimBot()) room.sendAnnouncement('No hay nadie llamado "' + CFG.botName + '" en la sala.');
      else room.sendAnnouncement('IA reasignada.');
      return false;
    }
    if (m === '!rojo' || m === '/team 1') {
      bot.team = 1;
      if (bot.playerId !== null) room.setPlayerTeam(bot.playerId, 1);
      return false;
    }
    if (m === '!azul' || m === '/team 2') {
      bot.team = 2;
      if (bot.playerId !== null) room.setPlayerTeam(bot.playerId, 2);
      return false;
    }
    if (m === '!ia' || m === '/ia') {
      room.sendAnnouncement('IA con ' + Learn.goalsFor + ' goles a favor y ' + Learn.goalsAgainst +
        ' en contra. Esquinas: arriba=' + Learn.cornerScore.up.toFixed(1) + ' abajo=' + Learn.cornerScore.down.toFixed(1));
      return false;
    }
    if (isAdmin && m.indexOf('/stadium ') === 0) {
      var sname = String(message).trim().substr(9).trim();
      if (sname) {
        try {
          if (typeof room.setDefaultStadium === 'function') room.setDefaultStadium(sname);
          room.sendAnnouncement('Estadio: ' + sname);
        } catch (e) { room.sendAnnouncement('No se pudo cambiar el estadio.'); }
      }
      return false;
    }
    return false;
  };

  if (CFG.stadium && typeof room.setDefaultStadium === 'function') {
    try { room.setDefaultStadium(CFG.stadium); } catch (e) {}
  }

  /* ============================================================
     IA: SELECCIÓN DE TIRO CON APRENDIZAJE
     == Elige la esquina MÁS LEJANA del rival, pero inclinada por
        la evidencia de goles (cornerScore). Eso la hace adaptarse
        a lo que funciona en cada partido. ======================
     ============================================================ */
  function selectAimY(by, enemy) {
    var UP = -130, DOWN = 130;   // Puntos dentro de la porteria, lejos de los postes
    if (enemy) {
      var upScore = Math.abs(enemy.y - UP) + Learn.cornerScore.up;
      var downScore = Math.abs(enemy.y - DOWN) + Learn.cornerScore.down;
      return upScore >= downScore ? UP : DOWN;
    }
    if (by > 0) return UP;      // Balon abajo -> tiro cruzado arriba
    if (by < 0) return DOWN;    // Balon arriba -> tiro cruzado abajo
    return 0;
  }

  // Aprender del movimiento: en cada tick decaen lentamente las
  // preferencias y cada 600 ticks se recalibra la agresividad.
  function decayLearning() {
    Learn.decayTick++;
    if (Learn.decayTick >= 600) {
      Learn.decayTick = 0;
      Learn.decay();
    }
  }

  /* ============================================================
     IA: LÓGICA PRINCIPAL (60 FPS)
     ============================================================ */
  function tickUpdate() {
    tick++;
    decayLearning();

    // Reconexion periodica barata: nunca dejar la IA muerta
    if (tick % 240 === 0 && bot.playerId !== null) {
      var found = false;
      var pl0;
      try { pl0 = room.getPlayerList(); } catch (e) {}
      if (pl0) {
        for (var k = 0; k < pl0.length; k++) {
          if (pl0[k].id === bot.playerId) { found = true; break; }
        }
      }
      if (!found) { bot.playerId = null; reclaimBot(); }
    }
    if (tick % 300 === 0 && bot.playerId === null) claimHost();

    maybeStartGame();
    if (!bot.playerId) return;

    var players;
    try { players = room.getPlayerList(); } catch (e) { return; }
    var me = null, enemy = null;
    for (var i = 0; i < players.length; i++) {
      var p = players[i];
      if (p.team === 0) continue;
      if (p.id === bot.playerId) me = p;
      else if (!enemy) enemy = p;
    }
    if (!me) return;   // El bot no esta en un equipo activo: no calcular fisica

    var ball;
    try { ball = room.getBallPosition(); } catch (e) { ball = null; }

    // Si aun no hay partido en curso, el bot se coloca en posicion
    // de formacion (asi se le ve moviendose y no se queda congelado).
    if (!ball) {
      var fx = bot.team === 1 ? -FIELD_W * 0.18 : FIELD_W * 0.18;
      var fy = -FIELD_H * 0.15;
      var fdx = fx - me.position.x, fdy = fy - me.position.y;
      var fd = len(fdx, fdy);
      if (fd > 40) {
        sendInputs(bot.playerId, (fdx / fd), (fdy / fd), false, false);
      } else {
        sendInputs(bot.playerId, 0, 0, false, false);
      }
      return;
    }

    predictBall(ball, CFG.predSteps);
    var bx = ball.x, by = ball.y;

    var ownGoalX = -enemyGoalX(bot.team);
    var attackSide = bot.team === 1 ? 1 : -1;

    // Aprendizaje: si vamos perdiendo, la linea defensiva se hunde;
    // si vamos ganando, presionamos mas arriba.
    var drift = clamp((Learn.goalsAgainst - Learn.goalsFor) * 6, -45, 45);
    var dangerDist = CFG.dangerBase + drift * 0.6;
    var blockDist = clamp(CFG.blockBase - drift, 80, 210);

    var danger = (Math.abs(bx - ownGoalX) < dangerDist) && (Math.abs(by) < CFG.goalHalf + 150);

    var gx = enemyGoalX(bot.team);
    var gy = selectAimY(by, enemy);

    var targetX, targetY;

    if (danger) {
      // DEFENSA: punto P_def en la recta porteria propia -> balon.
      targetX = ownGoalX + (bx - ownGoalX) * 0.42;
      targetY = by * 0.38;
    } else if ((bx - ownGoalX) * attackSide < 0) {
      // CAMPO PROPIO: misma linea, un poco mas adelantada.
      targetX = ownGoalX + (bx - ownGoalX) * 0.48;
      targetY = by * 0.45;
    } else {
      // ATAQUE: interceptar la posicion FUTURA del balon y colocarse
      // "detras" de el (apartado del arco) para empujarlo.
      var dxg = predX - gx, dyg = predY - gy;
      var lg = len(dxg, dyg) || 1;
      var dbp = len(me.position.x - bx, me.position.y - by);
      var close = Math.abs(bx - gx) < CFG.finishRange;   // cerca del arco: menos lead
      var lead = Math.min(70, dbp * CFG.leadScale) * (close ? 0.55 : 1);
      targetX = predX + (dxg / lg) * (CFG.stickDist + lead);
      targetY = predY + (dyg / lg) * (CFG.stickDist + lead);

      // Esquivar al rival cuando esta disputando el balon: nudge
      // perpendicular para rodearlo por el lado mas libre.
      if (enemy) {
        var ex = enemy.x - bx, ey = enemy.y - by;
        var ed = len(ex, ey);
        if (ed > 0 && ed < CFG.avoidDist) {
          var ux = ex / ed, uy = ey / ed;
          var pxx = -uy, pyy = ux;
          if (len(enemy.x - (targetX + pxx * 45), enemy.y - (targetY + pyy * 45)) >=
              len(enemy.x - (targetX - pxx * 45), enemy.y - (targetY - pyy * 45))) {
            targetX += pxx * 45; targetY += pyy * 45;
          } else {
            targetX -= pxx * 45; targetY -= pyy * 45;
          }
        }
      }
    }

    targetX = clamp(targetX, -FIELD_W + MARGIN, FIELD_W - MARGIN);
    targetY = clamp(targetY, -FIELD_H + MARGIN, FIELD_H - MARGIN);

    // Movimiento: vector normalizado con frenada al acercarse
    var ddx = targetX - me.position.x, ddy = targetY - me.position.y;
    var distT = len(ddx, ddy) || 1;
    var speed = Math.min(1, distT / 55);
    var dx = (ddx / distT) * speed;
    var dy = (ddy / distT) * speed;

    // Disparo: alineacion balon->esquina < 0.6 rad con cooldown.
    var kick = false, dash = false;
    var distBP = len(bx - me.position.x, by - me.position.y);

    if (distBP <= CFG.kickRange + 6 && tick > kickLockUntil) {
      var aBotToBall = Math.atan2(by - me.position.y, bx - me.position.x);
      var aBallToGoal = Math.atan2(gy - by, gx - bx);
      var diff = Math.abs(normAngle(aBotToBall - aBallToGoal));
      var aligned = diff < CFG.alignRadians;
      if (danger && distBP <= CFG.kickRange) aligned = true;   // despeje

      var nearGoal = Math.abs(bx - gx) < CFG.finishRange;
      var cd = nearGoal ? CFG.quickCooldown : CFG.kickCooldown;

      if (aligned && tick >= lastKickTick + cd) {
        kick = true;
        lastKickTick = tick;
        Learn.lastShot = { corner: gy >= 0 ? 'down' : 'up', tick: tick };
      }
    }

    // Sprint (solo API moderna) si estamos muy lejos del balon
    if (API.power && distBP > 170) dash = true;

    sendInputs(bot.playerId, dx, dy, kick, dash);
  }

  room.onGameTick = function () {
    try {
      tickUpdate();
    } catch (e) {   // Nunca dejar caer el loop del servidor
      if (!tickError) {
        tickError = true;
        console.error('[Neptunzinho] Error en onGameTick:', e);
      }
    }
  };

  /* ============================================================
     ARRANQUE: si el host ya estaba en la sala, enlazarlo ya.
     ============================================================ */
  claimHost();

  room.sendAnnouncement('Bot IA con aprendizaje cargado. Controla a "' + CFG.botName + '" (o al primer jugador).');
  window.HAXBOT = { room: room, cfg: CFG, bot: bot, learn: Learn, api: API };
})();