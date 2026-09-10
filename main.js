"use strict";

const fs = require("fs");
const path = require("path");

const {
  Room,
  Utils,
} = (() => {
  try {
    return require("node-haxball")(null, { proxy: { WebSocketChangeOriginAllowed: true } });
  } catch (e) {
    console.error("[error] No se pudo cargar node-haxball:", e.message);
    console.error("[ayuda] Ejecuta primero: npm install");
    process.exit(1);
  }
})();

const { makeBrain, buildWorld } = require("./neptunzinho");

const CONFIG = {
  roomName: "Futsal Pro | NeptunZinho",
  adminPassword: "admin",
  hostName: "NeptunZinho Host",
  hostAvatar: "NZ",
  maxPlayers: 10,
  publicize: true,
  geo: { code: "eu", lat: 0, lon: 0 },
  token: null,
  stadium: "Classic",
  scoreLimit: 5,
  timeLimit: 6,
  autoStart: true,
  autoRestart: true,
  botEnabled: true,
  botTeam: 2,
  botRole: "all-round",
  wallPasses: true,
};

for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--name" && process.argv[i + 1]) CONFIG.roomName = process.argv[++i];
  else if (a === "--pw" && process.argv[i + 1]) CONFIG.adminPassword = process.argv[++i];
  else if (a === "--map" && process.argv[i + 1]) CONFIG.stadium = process.argv[++i];
  else if (a === "--score" && process.argv[i + 1]) CONFIG.scoreLimit = parseInt(process.argv[++i], 10) || CONFIG.scoreLimit;
  else if (a === "--time" && process.argv[i + 1]) CONFIG.timeLimit = parseInt(process.argv[++i], 10) || CONFIG.timeLimit;
  else if (a === "--no-bot") CONFIG.botEnabled = false;
  else if (a === "--gk") CONFIG.botRole = "gk";
  else if (a === "--no-auto") { CONFIG.autoStart = false; CONFIG.autoRestart = false; }
}

function readToken() {
  if (CONFIG.token) return CONFIG.token;
  if (process.env.HAXBALL_TOKEN) return process.env.HAXBALL_TOKEN;
  try {
    const p = path.join(__dirname, "token.txt");
    if (fs.existsSync(p)) {
      const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
      for (const line of lines) {
        const t = line.trim();
        if (t && !t.startsWith("#")) return t;
      }
    }
  } catch (e) {}
  return null;
}

function die(msg) {
  console.error(msg);
  console.error("Crea el archivo F:\\hxb\\token.txt (o F:/hxb/token.txt) y pega dentro tu token de https://www.haxball.com/headlesstoken");
  process.exit(1);
}

const token = readToken();
if (!token) die("[error] No se encontró el token de la sala headless.");
console.log("[sala] Token cargado (termina en …" + token.slice(-4) + "). Conectando al servidor de HaxBall…");
console.log("[sala] ====================================================================");
console.log("[sala] CUANDO LA SALA ESTÉ ARRIBA, HAZ ESTO PARA ENTRAR:");
console.log("[sala]   1) Abre el navegador en  https://www.haxball.com");
console.log("[sala]   2) Pon tu nombre, dale PLAY y busca la sala con el nombre: " + CONFIG.roomName);
console.log("[sala]   3) Entra en esa sala y escribe en el chat:  !admin " + CONFIG.adminPassword);
console.log("[sala] Eso te hace administrador. La sala sigue online mientras esta ventana siga abierta.");
console.log("[sala] ====================================================================");

let room = null;
const playersMap = new Map();
const banned = new Set();
const bots = [];
const botIds = new Set();
const timers = [];
const keyStatesToSend = {};
let gameOn = false;

function later(fn, ms) {
  const t = setTimeout(fn, ms);
  timers.push(t);
  return t;
}

function clearTimers() {
  for (const t of timers) clearTimeout(t);
  timers.length = 0;
}

function log() {
  const args = Array.from(arguments);
  console.log.apply(console, ["[" + new Date().toLocaleTimeString() + "]"].concat(args));
}

function nameOf(player) {
  return player ? String(player.name || "unnamed") : "";
}

function isBot(player) {
  return player && botIds.has(player.id);
}

function countField() {
  let count = 0;
  for (const p of playersMap.values()) {
    if (!isBot(p) && p.team !== 0) count++;
  }
  return count;
}

function smallerTeam() {
  let t1 = 0;
  let t2 = 0;
  for (const p of playersMap.values()) {
    if (p.team === 1) t1++;
    else if (p.team === 2) t2++;
  }
  return t1 <= t2 ? 1 : 2;
}

function tryAutoStart(reason) {
  if (!CONFIG.autoStart) return;
  if (gameOn) return;
  if (countField() < 2) return;
  log("Inicio automático de partida:", reason);
  room.sendAnnouncement("Arrancando el partido en 3 segundos...");
  later(() => {
    if (gameOn) return;
    room.startGame();
  }, 3000);
}

function sendAdminSecret() {
  room.sendAnnouncement("Contraseña de administrador: " + CONFIG.adminPassword);
}

function rebalance() {
  if (room.teamsLocked) return;
  const missing = playersMap.size - (countField() + bots.length);
  // mover suplentes con equipo 0 a un equipo, y equilibrar
  for (const p of playersMap.values()) {
    if (missing <= 0) break;
    if (p.team !== 0 || isBot(p)) continue;
    room.setPlayerTeam(p.id, smallerTeam());
  }
  for (const p of playersMap.values()) {
    const a = p.team === 1;
    const b = p.team === 2;
    if (a && b) {
      const s = smallerTeam();
      room.setPlayerTeam(p.id, s);
    }
  }
}

function promoteIfNoAdmin(spawner) {
  let hasAdmin = false;
  for (const p of playersMap.values()) {
    if (p.isAdmin && !isBot(p)) {
      hasAdmin = true;
      break;
    }
  }
  if (!hasAdmin && spawner && !isBot(spawner)) {
    room.setPlayerAdmin(spawner.id, true);
    log("Admin asignado a", nameOf(spawner));
    room.sendAnnouncement("Eres administrador. Usa !admin " + CONFIG.adminPassword + " para confirmar.");
    room.sendPlayerAnnouncement(spawner.id, "Administrador asignado", 0xff00ff);
  }
}

const COMMANDS = [
  ["!admin <contraseña>", "Hacerte administrador de la sala."],
  ["!logout", "Quitarse el rango de administrador."],
  ["!help", "Mostrar esta lista de comandos."],
  ["!red / !blue / !spec / !auto", "Cambiar tu equipo."],
  ["-- ADMINISTRADOR --", ""],
  ["!tag <nombre>", "Cambiar el nombre de la sala."],
  ["!password <clave> (+ para bloquear, - para abrir)", "Cambiar la contraseña de la sala."],
  ["!map <estadio>", "Cambiar de estadio (Classic, Small, Big, Rounded, Hockey, Easy, Multi-goal)."],
  ["!score <n> / !time <n>", "Límite de goles / minutos."],
  ["!kick <nombre> / !ban <nombre> / !clearbans", "Expulsar / banear / limpiar baneos."],
  ["!lock / !unlock", "Bloquear / desbloquear los equipos."],
  ["!start / !stop", "Empezar / parar el partido."],
  ["!gk / !field", "NeptunZinho de portero / de líbero."],
  ["!swap", "Cambiar a NeptunZinho de equipo."],
  ["!count", "Lista de jugadores conectados."],
];

function sendHelp(player) {
  let msg = "Comandos: ";
  for (const [c, d] of COMMANDS) msg += c + (d ? " (" + d + ") " : "") + "· ";
  room.sendPlayerAnnouncement(player.id, msg, 0x00bfff);
}

function findPlayer(name) {
  const q = name.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const p of playersMap.values()) {
    if (isBot(p)) continue;
    const n = nameOf(p).toLowerCase();
    let score = 0;
    if (n === q) score = 100;
    else if (n.startsWith(q)) score = 80;
    else if (n.includes(q)) score = 40;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

function isTrueAdmin(player, msg) {
  if (!msg) return player.isAdmin;
  const ok = msg.trim().toLowerCase() === CONFIG.adminPassword.toLowerCase();
  if (ok) {
    room.setPlayerAdmin(player.id, true);
    room.sendPlayerAnnouncement(player.id, "Administrador confirmado.", 0x00ff00);
  } else {
    room.sendPlayerAnnouncement(player.id, "Contraseña incorrecta.", 0xff0000);
  }
  return ok;
}

function walkCommand(player, msg) {
  const text = msg.replace(/\s+/g, " ").trim();
  const low = text.toLowerCase();
  const parts = low.split(" ");
  const cmd = parts[0];
  const rest = text.slice(cmd.length).trim();
  const id = player.id;

  switch (cmd) {
    case "!admin":
      return isTrueAdmin(player, rest);
    case "!logout":
      room.setPlayerAdmin(id, false);
      return false;
    case "!help":
    case "!commands":
      sendHelp(player);
      return false;

    case "!red":
      return teamChange(player, 1);
    case "!blue":
      return teamChange(player, 2);
    case "!spec":
      return teamChange(player, 0);
    case "!auto":
      if (room.teamsLocked) {
        room.sendPlayerAnnouncement(id, "Los equipos están bloqueados.", 0xff0000);
        return false;
      }
      room.setPlayerTeam(id, smallerTeam());
      return false;

    case "!count": {
      let msg2 = "Jugadores: ";
      for (const p of playersMap.values()) {
        msg2 += nameOf(p) + (p.team === 1 ? "(R)" : p.team === 2 ? "(B)" : "(A)") + " ";
      }
      room.sendPlayerAnnouncement(id, msg2, 0x00bfff);
      return false;
    }
  }

  if (!player.isAdmin) {
    room.sendPlayerAnnouncement(id, "Ese comando es solo para administradores.", 0xff0000);
    return false;
  }

  switch (cmd) {
    case "!tag":
    case "!roomname":
      if (!rest) {
        room.sendPlayerAnnouncement(id, "Uso: !tag <nombre>", 0x00bfff);
        return false;
      }
      CONFIG.roomName = rest;
      room.setRoomName(rest);
      room.sendAnnouncement("Nombre de la sala cambiado a: " + rest);
      return false;
    case "!password":
    case "!pwd":
      if (rest === "-" || rest === "") {
        room.setPassword("");
        room.sendAnnouncement("Sala abierta (sin contraseña).");
      } else if (rest === "+" || rest === "close" || rest === "lock") {
        room.setPassword("haxball");
        room.sendAnnouncement("Sala con contraseña: haxball");
      } else {
        room.setPassword(rest);
        room.sendAnnouncement("Contraseña actualizada.");
      }
      return false;
    case "!map": {
      const maps = Utils.getDefaultStadiums().map((s) => s.name);
      if (!rest) {
        room.sendPlayerAnnouncement(id, "Estadios: " + maps.join(", "), 0x00bfff);
        return false;
      }
      const found = Utils.getDefaultStadiums().find((s) => s.name.toLowerCase() === rest.toLowerCase());
      if (!found) {
        room.sendPlayerAnnouncement(id, "No existe ese estadio. Opciones: " + maps.join(", "), 0xff0000);
        return false;
      }
      CONFIG.stadium = found.name;
      room.setStadium(found.name);
      room.sendAnnouncement("Estadio cambiado a " + found.name + ".");
      if (room.gameState && room.gameState.state > 0) room.stopGame(false);
      return false;
    }
    case "!score":
    case "!scorelimit":
      if (!/^\d+$/.test(rest) || +rest < 1 || +rest > 20) {
        room.sendPlayerAnnouncement(id, "Uso: !score <1-20>", 0x00bfff);
        return false;
      }
      CONFIG.scoreLimit = +rest;
      room.setScoreLimit(+rest);
      room.sendAnnouncement("Límite de goles: " + rest);
      return false;
    case "!time":
    case "!timelimit":
      if (!/^\d+$/.test(rest) || +rest < 1 || +rest > 60) {
        room.sendPlayerAnnouncement(id, "Uso: !time <1-60> (minutos)", 0x00bfff);
        return false;
      }
      CONFIG.timeLimit = +rest;
      room.setTimeLimit(+rest);
      room.sendAnnouncement("Límite de tiempo: " + rest + " min");
      return false;

    case "!kick": {
      const target = findPlayer(rest);
      if (!target) {
        room.sendPlayerAnnouncement(id, "No encuentro a: " + rest, 0xff0000);
        return false;
      }
      room.kickPlayer(target.id, "Expulsado por un administrador.", false);
      room.sendAnnouncement(nameOf(target) + " expulsado.");
      return false;
    }
    case "!ban": {
      const target = findPlayer(rest);
      if (!target) {
        banned.add(rest.toLowerCase());
        room.sendAnnouncement("Nombre baneado: " + rest);
        return false;
      }
      banned.add(nameOf(target).toLowerCase());
      room.kickPlayer(target.id, "Baneado por un administrador.", true);
      room.sendAnnouncement(nameOf(target) + " baneado.");
      return false;
    }
    case "!clearbans":
      banned.clear();
      room.clearBans();
      room.sendAnnouncement("Lista de baneos limpiada.");
      return false;

    case "!lock":
      room.setTeamsLock(true);
      room.sendAnnouncement("Equipos bloqueados.");
      return false;
    case "!unlock":
      room.setTeamsLock(false);
      room.sendAnnouncement("Equipos desbloqueados.");
      return false;

    case "!start":
      if (gameOn) {
        room.sendPlayerAnnouncement(id, "El partido ya está en juego.", 0xff0000);
        return false;
      }
      room.startGame();
      room.sendAnnouncement("¡Partido comenzado!");
      return false;
    case "!stop":
    case "!pause":
    case "!restart":
      room.stopGame(false);
      room.sendAnnouncement("Partido parado.");
      return false;

    case "!gk":
      CONFIG.botRole = "gk";
      setBotRole("gk");
      return false;
    case "!field":
      CONFIG.botRole = "all-round";
      setBotRole("all-round");
      return false;
    case "!swap":
      for (const b of bots) room.setPlayerTeam(b.id, b.team === 1 ? 2 : 1);
      room.sendAnnouncement("NeptunZinho cambió de equipo.");
      return false;

    case "!pw":
    case "!adminpw":
      if (rest) {
        CONFIG.adminPassword = rest;
        room.sendAnnouncement("Contraseña de administrador actualizada.");
      }
      return false;
  }

  room.sendPlayerAnnouncement(id, "Comando no reconocido. Usa !help", 0xff0000);
  return false;
}

function teamChange(player, team) {
  if (room.teamsLocked) {
    room.sendPlayerAnnouncement(player.id, "Los equipos están bloqueados.", 0xff0000);
    return false;
  }
  if (player.team === team) return false;
  if (team !== 0) {
    room.setPlayerTeam(player.id, team);
  } else {
    room.setPlayerTeam(player.id, 0);
  }
  return false;
}

function setBotRole(role) {
  for (const b of bots) b.brain.role = role;
  const gk = role === "gk";
  room.setPlayerAdmin(bots[0].id, false);
  room.sendAnnouncement(gk ? "NeptunZinho ahora es PORTERO." : "NeptunZinho vuelve al campo.");
}

function initRoom(r) {
  room = r;
  log("Sala en línea:", room.link);
  console.log("");
  console.log("[sala] ====================================================================");
  console.log("[sala] ¡SALA CREADA! CÓPIA ESTE ENLACE Y ÁBRELO EN EL NAVEGADOR:");
  console.log("[sala]   " + (room.link || "https://www.haxball.com"));
  console.log("[sala] Si no usas el enlace, abre https://www.haxball.com y busca la sala: " + CONFIG.roomName);
  console.log("[sala] Al entrar, escribe en el chat:  !admin " + CONFIG.adminPassword);
  console.log("[sala] ====================================================================");
  console.log("");

  // configuración base
  try {
    room.setRoomName(CONFIG.roomName);
    room.setMaxPlayers(CONFIG.maxPlayers);
    room.setScoreLimit(CONFIG.scoreLimit);
    room.setTimeLimit(CONFIG.timeLimit);
    room.setTeamsLock(false);
    if (CONFIG.stadium) room.setStadium(CONFIG.stadium);
  } catch (e) {
    log("[warn] Configuración parcial:", e.message);
  }

  sendAdminSecret();

  r.onPlayerJoin = (player) => {
    playersMap.set(player.id, player);
    if (banned.has(nameOf(player).toLowerCase())) {
      room.kickPlayer(player.id, "Estás baneado de esta sala.", true);
      return;
    }
    log("+", nameOf(player), "(" + player.id + ")");
    room.sendAnnouncement(nameOf(player) + " se unió.");
    if (!player.isAdmin) promoteIfNoAdmin(player);
    if (!room.teamsLocked && player.team === 0 && countField() < 2) {
      room.setPlayerTeam(player.id, smallerTeam());
    }
    tryAutoStart("jugador conectado");
  };

  r.onPlayerLeave = (player) => {
    playersMap.delete(player.id);
    log("-", nameOf(player), "(" + player.id + ")");
    room.sendAnnouncement(nameOf(player) + " se fue.");
  };

  r.onPlayerChat = (player, message) => {
    if (!message || !message.startsWith("!")) return true;
    return walkCommand(player, message);
  };

  r.onGameTick = () => {
    if (bots.length === 0) return;
    if (!room.gameState) return;
    room.extrapolate();
    const gameState = room.gameStateExt || room.gameState;
    const state = room.state || room.currentGameState || gameState;
    for (const b of bots) {
      const cp = state.getPlayer ? state.getPlayer(b.id) : null;
      if (!cp || !cp.disc) {
        keyStatesToSend[b.id] = 0;
        continue;
      }
      const w = buildWorld(state, gameState, b.id);
      const out = b.brain.think(w);
      keyStatesToSend[b.id] = Utils.keyState(out.dirX | 0, out.dirY | 0, out.kick === true);
    }
    Utils.runAfterGameTick(() => {
      if (!room.gameState) return;
      const st = room.state || room.currentGameState || room.gameState;
      for (const b of bots) {
        const keyState = keyStatesToSend[b.id];
        if (keyState === undefined) continue;
        const cp = st.getPlayer ? st.getPlayer(b.id) : null;
        const playerIsKicking = !!cp && cp.isKicking === true;
        if (keyState === b.prevKeyState) {
          if (!(keyState & 16)) continue;
          if (playerIsKicking) continue;
          room.fakeSendPlayerInput(keyState & -17, b.id);
        }
        room.fakeSendPlayerInput(keyState, b.id);
        b.prevKeyState = keyState;
      }
    }, 1);
  };

  r.onGameStart = () => {
    gameOn = true;
    log("Partido iniciado.");
    room.sendAnnouncement("¡A jugar!");
  };

  r.onGameEnd = (scores) => {
    gameOn = false;
    const winner = scores.red === scores.blue ? "EMPATE" : scores.red > scores.blue ? "ROJO" : "AZUL";
    log("Fin del partido:", JSON.stringify(scores), "->", winner);
    room.sendAnnouncement("Fin del partido. Ganador: " + winner + ".");
    if (CONFIG.autoRestart && countField() >= 2) {
      room.sendAnnouncement("Nuevo partido en 8 segundos...");
      later(() => {
        if (room && !gameOn) {
          room.startGame();
        }
      }, 8000);
    }
  };

  r.onTeamGoal = (team) => {
    const s = room.getScores();
    log("GOOOL equipo", team, "->", JSON.stringify(s));
  };

  r.onPlayerBallKick = () => {};

  r.onPositionsReset = () => {
    log("Posiciones reiniciadas.");
  };

  r.onGameStop = () => {
    gameOn = false;
    log("Partido detenido.");
  };

  // alta del bot
  if (CONFIG.botEnabled) {
    later(() => {
      try {
        const botPlayer = room.fakePlayerJoin(65535, "NeptunZinho", "br", "NZ", "fake-ip-do-not-believe-it", "fake-auth-do-not-believe-it");
        if (!botPlayer) {
          log("[warn] No se pudo crear el bot.");
          return;
        }
        if (botPlayer.customData) botPlayer.customData.isBot = true;
        botIds.add(botPlayer.id);
        const brain = makeBrain({ role: CONFIG.botRole });
        bots.push({ id: botPlayer.id, brain, team: CONFIG.botTeam, prevKeyState: 0, role: CONFIG.botRole });
        room.setPlayerTeam(botPlayer.id, CONFIG.botTeam);
        log("Bot NeptunZinho creado (equipo " + CONFIG.botTeam + ").");
        room.sendAnnouncement("NeptunZinho alineado en el equipo " + (CONFIG.botTeam === 1 ? "ROJO" : "AZUL") + ".");
        tryAutoStart("bot conectado");
      } catch (e) {
        log("[warn] Fallo al crear el bot:", e.message);
      }
    }, 1500);
  }
}

let _salaAbierta = false;
room = Room.create(
  {
    name: CONFIG.roomName,
    token,
    maxPlayers: CONFIG.maxPlayers,
    public: CONFIG.publicize,
    geo: CONFIG.geo,
    tokenDev: false,
  },
  {
    storage: {},
    config: {
      onOpen: (r) => {
        _salaAbierta = true;
        initRoom(r);
      },
    },
    onClose: () => {
      log("La sala se cerró. (onClose)");
      console.error("[sala] No se pudo mantener la sala: el token puede estar vencido o los servidores de HaxBall están saturados.");
      console.error("[sala] Prueba generando un TOKEN NUEVO en https://www.haxball.com/headlesstoken y pégalo en F:\\hxb\\token.txt");
      process.exit(1);
    },
  }
);

setTimeout(() => {
  if (!_salaAbierta) {
    console.error("[sala] Lleva 60 segundos intentando conectar. Si sigue así: el token está vencido o los servidores están saturados.");
    console.error("[sala] Genera un token nuevo en https://www.haxball.com/headlesstoken y ponlo en F:\\hxb\\token.txt");
  }
}, 60000);
setTimeout(() => {
  if (!_salaAbierta) {
    console.error("[sala] 120 segundos sin conectar. Cerrando. Genera un TOKEN NUEVO y vuelve a abrir sala.bat");
    process.exit(1);
  }
}, 120000);

// seguridad: si onClose no llega, salir con/pm
process.on("SIGINT", () => {
  log("Deteniendo host...");
  for (const b of bots) {
    try {
      room && room.fakePlayerLeave(b.id);
    } catch (e) {}
  }
  process.exit(0);
});