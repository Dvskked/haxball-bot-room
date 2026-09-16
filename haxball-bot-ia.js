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
     CONFIGURACIÓN DE LA SALA
     ============================================================ */
  var room = HBInit({
    roomName: 'Sala Bot Pro | Neptunzinho (1v1 AF)',
    maxPlayers: 12,
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
    botName: 'Neptunzinho',     // Jugador que sera controlado por la IA
    botAvatar: '\u26A1',        // ⚡
    botTeam: 1,                 // 1 = Rojo | 2 = Azul
    grabFirst: true,            // Sin bot con el nombre -> controla al primer jugador
    allAdmins: true,            // Todos los que entren son admin
    autoBalance: true,          // Reparte automáticamente los espectadores en equipos
    stadium: '',                // '' = no tocar el estadio (lo pone el admin); o 'Classic', '1v1 AF', etc.
    // ---- Parámetros de la IA ----
    friction: 0.99,             // Decaimiento de velocidad del balon por tick
    predSteps: 30,              // Frames a futuro para interceptar (~0.5 s)
    kickRange: 48,              // Distancia maxima bot-balon para patear
    kickCooldown: 8,            // Cooldown en ticks (~133 ms a 60 FPS)
    kickLock: 90,               // No patear justo tras el kickoff (regla)
    alignRadians: 0.55,         // Tolerancia de alineacion para disparar
    stickDist: 22,              // px "detras" del balon al atacar
    leadScale: 0.30,            // Anticipacion hacia la posicion futura del balon
    blockDist: 130,             // Distancia de la linea de bloqueo defensivo
    dangerDist: 470,            // Radio de peligro en area propia
    goalHalf: 180               // Media altura de la porteria (Classic)
  };

  /* ============================================================
     CONSTANTES DEL MAPA (Classic ~3760x2080)
     ============================================================ */
  var FIELD_W = 1880, FIELD_H = 1040;  // Medias dimensiones
  var GOAL_X = 1860;                   // Linea de gol
  var MARGIN = 30;

  /* ============================================================
     ESTADO GLOBAL
     ============================================================ */
  var bot = { playerId: null, team: CFG.botTeam };
  var tick = 0;
  var lastKickTick = -1000;
  var kickLockUntil = 0;
  var tickError = false;
  var predX = 0, predY = 0;   // Salida de la prediccion (sin objetos por frame)

  /* ============================================================
     DETECCIÓN DE API (importante: versiones viejas no tienen
     setPlayerInputs; usan setPlayerInputControls(id, {up,down,...}))
     AQUI estaba el crash: TypeError room.setPlayerInputs is not a function
     ============================================================ */
  var API = { power: 'setPlayerInputs', legacyControls: null };
  if (typeof room.setPlayerInputs !== 'function') {
    API.power = null;
    if (typeof room.setPlayerInputControls === 'function') API.legacyControls = 'setPlayerInputControls';
    else if (typeof room.setPlayerInputControl === 'function') API.legacyControls = 'setPlayerInputControl';
  }
  console.log('[Neptunzinho] API detectada:', API.power ? 'moderna (setPlayerInputs)' : 'legacy (' + API.legacyControls + ')');

  /* ============================================================
     MATEMÁTICA VECTORIAL (vanilla, sin allocs pesados)
     ============================================================ */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function len(x, y) { return Math.sqrt(x * x + y * y); }

  function normAngle(a) {           // Angulo normalizado a [-PI, PI]
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }

  function enemyGoalX(team) {       // Rojo ataca +x, Azul ataca -x
    return team === 1 ? GOAL_X : -GOAL_X;
  }

  /* Prediccion fisica: integra posicion += velocidad con friccion 0.99
     y rebote simple en los muros. Resultado en predX/predY. */
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

  /* ============================================================
     ENVÍO DE CONTROL (compatible con ambas generaciones de API)
     ============================================================ */
  function sendInputs(id, dx, dy, kick, dash) {
    if (API.power) {
      room.setPlayerInputs({ dx: dx, dy: dy, kick: !!kick, dash: !!dash }, id);
    } else if (API.legacyControls) {
      room[API.legacyControls](id, {
        up: dy < -0.15,
        down: dy > 0.15,
        left: dx < -0.15,
        right: dx > 0.15,
        kick: !!kick
      });
    } else {
      console.error('[Neptunzinho] No existe ninguna funcion de control en esta version.');
    }
  }

  /* ============================================================
     GESTIÓN DEL BOT (asignacion, avatar, reconexion de ID)
     ============================================================ */
  function bond(player, forceTeam) {
    bot.playerId = player.id;
    if (forceTeam) bot.team = forceTeam;
    else if (player.team !== 0) bot.team = player.team;
    try { room.setPlayerAvatar(player.id, CFG.botAvatar); } catch (e) {}
    if (player.team === 0) room.setPlayerTeam(player.id, bot.team);
    room.sendAnnouncement(CFG.botAvatar + ' Neptunzinho IA conectado en equipo ' + (bot.team === 1 ? 'ROJO' : 'AZUL'));
  }

  // Si el bot se fue, rebusca en la sala a alguien con el nombre reservado
  function reclaimBot() {
    var pl = room.getPlayerList();
    for (var i = 0; i < pl.length; i++) {
      if (pl[i].name === CFG.botName) { bond(pl[i]); return true; }
    }
    return false;
  }

  function balanceTeams() {
    if (!CFG.autoBalance) return;
    var pl;
    try { pl = room.getPlayerList(); } catch (e) { return; }
    var r = 0, b = 0;
    for (var i = 0; i < pl.length; i++) {
      if (pl[i].team === 1) r++;
      else if (pl[i].team === 2) b++;
    }
    for (var j = 0; j < pl.length; j++) {
      var p = pl[j];
      if (p.team === 0) {
        var t = r <= b ? 1 : 2;
        room.setPlayerTeam(p.id, t);
        if (t === 1) r++; else b++;
      }
    }
  }

  /* ============================================================
     EVENTOS DE SALA
     ============================================================ */
  room.onPlayerJoin = function (player) {
    if (player.name === CFG.botName) { bond(player, CFG.botTeam); }
    else if (CFG.grabFirst && bot.playerId === null) bond(player);
    if (CFG.allAdmins) {
      try { room.setPlayerAdmin(player.id, true); } catch (e) {}
    }
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
    var pl;
    try { pl = room.getPlayerList(); } catch (e) { return; }
    var name = '';
    for (var i = 0; i < pl.length; i++) {
      if (pl[i].team === team) { name = pl[i].name; break; }
    }
    room.sendAnnouncement('GOL de ' + (name ? name : 'Equipo ' + team));
  };

  room.onPlayerChat = function (player, message) {
    var m = String(message).trim().toLowerCase();
    var isAdmin = !player || player.admin;

    if (m === '!bot') {                       // Reasignar/rebuscar el bot
      bot.playerId = null;
      if (!reclaimBot()) room.sendAnnouncement('No hay nadie llamado "' + CFG.botName + '" en la sala.');
      return false;
    }
    if (m === '/team rojo' || m === '/team 1' || m === '!rojo') {
      bot.team = 1;
      if (bot.playerId !== null) room.setPlayerTeam(bot.playerId, 1);
      return false;
    }
    if (m === '/team azul' || m === '/team 2' || m === '!azul') {
      bot.team = 2;
      if (bot.playerId !== null) room.setPlayerTeam(bot.playerId, 2);
      return false;
    }
    if (isAdmin && m.indexOf('/stadium ') === 0) {
      var sname = String(message).trim().substr(9).trim();
      if (sname) {
        try {
          if (typeof room.setDefaultStadium === 'function') { room.setDefaultStadium(sname); }
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
     LÓGICA IA (60 FPS)
     ============================================================ */
  // Elegir esquina del arco rival preferida: la MAS LEJANA del rival
  // (asegura orificios abiertos) o tiro cruzado si no hay rival visible.
  function cornerAim(by, enemy) {
    var half = (CFG.goalHalf - 45) * 0.95;   // ~128 px, lejos de los postes
    var top = -half, bottom = half;
    if (enemy) {
      return Math.abs(top - enemy.y) > Math.abs(bottom - enemy.y) ? top : bottom;
    }
    if (by > 0) return top;                   // balon abajo -> esquina arriba
    if (by < 0) return bottom;                // balon arriba -> esquina abajo
    return 0;
  }

  function tickUpdate() {
    tick++;
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
    if (!me) return;                          // El bot no esta en un equipo activo

    var ball;
    try { ball = room.getBallPosition(); } catch (e) { ball = null; }
    if (!ball) return;

    predictBall(ball, CFG.predSteps);
    var bx = ball.x, by = ball.y;

    var ownGoalX = -enemyGoalX(bot.team);
    var attackSide = bot.team === 1 ? 1 : -1;
    var danger = (Math.abs(bx - ownGoalX) < CFG.dangerDist) && (Math.abs(by) < CFG.goalHalf + 150);

    // Punto de disparo: esquina rival segun posicion del rival/balon
    var gx = enemyGoalX(bot.team);
    var gy = cornerAim(by, enemy);

    var targetX, targetY;

    if (danger) {
      // DEFENSA: punto P_def en la recta porteria propia -> balon.
      // Pararse en esa linea bloquea tiros y corta pases (despeje automatico).
      targetX = ownGoalX + (bx - ownGoalX) * 0.42;
      targetY = by * 0.38;
    } else if ((bx - ownGoalX) * attackSide < 0) {
      // CAMPO PROPIO: misma linea, un poco mas atacada.
      targetX = ownGoalX + (bx - ownGoalX) * 0.48;
      targetY = by * 0.45;
    } else {
      // ATAQUE: correr hacia la posicion FUTURA del balon y colocarse
      // CFG.stickDist px "detras" de el (apartado del arco) para empujarlo.
      var dxg = predX - gx, dyg = predY - gy;
      var lg = len(dxg, dyg) || 1;
      var distMeBall = len(me.position.x - bx, me.position.y - by);
      var lead = Math.min(70, distMeBall * CFG.leadScale);
      targetX = predX + (dxg / lg) * (CFG.stickDist + lead);
      targetY = predY + (dyg / lg) * (CFG.stickDist + lead);
    }

    targetX = clamp(targetX, -FIELD_W + MARGIN, FIELD_W - MARGIN);
    targetY = clamp(targetY, -FIELD_H + MARGIN, FIELD_H - MARGIN);

    // Movimiento: vector normalizado con frenada al acercarse
    var ddx = targetX - me.position.x, ddy = targetY - me.position.y;
    var distT = len(ddx, ddy) || 1;
    var speed = Math.min(1, distT / 55);
    var dx = (ddx / distT) * speed;
    var dy = (ddy / distT) * speed;

    // Disparo: alineacion balon -> esquina rival < 0.55 rad y cooldown.
    // "Rockets" = disparos largos: con el balon lejos seguimos pateando
    // cuando estamos alineados, sin importar la distancia.
    var kick = false, dash = false;
    var dbp = len(bx - me.position.x, by - me.position.y);

    if (dbp < CFG.kickRange + 6 && tick > kickLockUntil) {
      var aBotToBall = Math.atan2(by - me.position.y, bx - me.position.x);
      var aBallToGoal = Math.atan2(gy - by, gx - bx);
      var diff = Math.abs(normAngle(aBotToBall - aBallToGoal));
      var aligned = diff < CFG.alignRadians;

      // Despeje de emergencia en area propia -> patear casi siempre
      if (danger && dbp < CFG.kickRange) aligned = true;

      if (aligned && tick >= lastKickTick + CFG.kickCooldown) {
        kick = true;
        lastKickTick = tick;
      }
    }

    // Sprint (solo API moderna) cuando estamos muy lejos del balon
    if (API.power && distMeBall > 170) dash = true;

    sendInputs(bot.playerId, dx, dy, kick, dash);
  }

  room.onGameTick = function () {
    try {
      tickUpdate();
    } catch (e) {                          // Nunca dejar caer el loop del servidor
      if (!tickError) {
        tickError = true;
        console.error('[Neptunzinho] Error en onGameTick:', e);
      }
    }
  };

  room.sendAnnouncement('Bot IA profesional cargado. El jugador "' + CFG.botName + '" sera controlado por la IA.');
  window.HAXBOT = { room: room, cfg: CFG, bot: bot, api: API };
})();