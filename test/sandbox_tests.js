"use strict";

const { Room, Utils } = require("node-haxball")(null, { proxy: { WebSocketChangeOriginAllowed: true } });
const { makeBrain, buildWorld, arrivalTicks, predictBall } = require("../neptunzinho");

const RED_GOAL_X = -370;
const BLUE_GOAL_X = 370;

function goalCount(state) {
  let count = 0;
  const g = state.goals || [];
  for (const goal of g) {
    if (goal.team && goal.team.id === 1) count++;
  }
  return count;
}

function len(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

function main() {
  console.log("====[ NeptunZinho · Prueba de fútbol offline ]====");

  const s = Room.sandbox({}, {});
  if (!s) {
    console.error("[FALLO] No se pudo crear el sandbox.");
    process.exit(1);
  }

  const BOT_ID = 65535;
  const OPP_ID = 1;

  if (typeof s.setSimulationSpeed === "function") s.setSimulationSpeed(0);

  s.playerJoin(BOT_ID, "NeptunZinho", "br", "NZ", "fake-ip-do-not-believe-it", "fake-auth-do-not-believe-it");
  s.playerJoin(OPP_ID, "rival", "es", "XX", "fake-ip-rival", "fake-auth-rival");

  // NeptunZinho juega con ROJO (equipo del kickoff) para poder arrancar la jugada.
  s.setPlayerTeam(BOT_ID, 1, BOT_ID);
  s.setPlayerTeam(OPP_ID, 2, OPP_ID);

  // arrancar juego y avanzar la cuenta regresiva del kickoff
  s.startGame(0);
  s.runSteps(160);

  const bot = { id: BOT_ID, brain: makeBrain({ role: "all-round" }), prevKeyState: 0 };

  let crossings = 0;
  let wasIn = false;
  let ballReachedGoalside = false;

  const totalTicks = 3600;
  let lastBallX = 0;
  let kickoffDone = true;

  for (let tick = 0; tick < totalTicks; tick++) {
    const state = s.state;
    if (!state.gameState) {
      s.runSteps(1);
      continue;
    }
    if (state.gameState.state === 0 && kickoffDone) {
      kickoffDone = false;
      const unlockSteps = 200;
      s.runSteps(unlockSteps);
      bot.prevKeyState = 0;
      continue;
    }
    kickoffDone = true;
    s.extrapolate();
    const gameState = state.gameState.ext || state.gameState;

    if (!gameState) {
      s.runSteps(1);
      continue;
    }

    const w = buildWorld(state, gameState, BOT_ID);
    const world = w;

    const out = world.me ? bot.brain.think(world) : { dirX: 0, dirY: 0, kick: false };
    const keyState = Utils.keyState(out.dirX | 0, out.dirY | 0, out.kick === true);

    if (tick % 50 === 0 && tick > 120) {
      const me = world.me;
      const b = gameState.physicsState.discs[0];
      const bPos = { x: b.pos.x, y: b.pos.y };
      const ops = world.players.filter((p) => p.team !== world.me.team);
      const d = Math.hypot(me.pos.x - bPos.x, me.pos.y - bPos.y);
      let oppD = Infinity;
      let oppArr = Infinity;
      for (const o of ops) {
        const od = Math.hypot(o.pos.x - bPos.x, o.pos.y - bPos.y);
        if (od < oppD) { oppD = od; oppArr = arrivalTicks(o.pos, bPos, Math.hypot(o.speed.x, o.speed.y)); }
      }
      const myArr = arrivalTicks(me.pos, bPos, Math.hypot(me.speed.x, me.speed.y));
      const pred = predictBall({ pos: bPos, speed: { x: b.speed.x, y: b.speed.y }, radius: b.radius }, world.segments, world.planes, 24);
      const bspd = Math.hypot(b.speed.x, b.speed.y);
      const inMyHalf = Math.abs(bPos.x - world.goals.find((g) => g.team === world.me.team).mid.x) < Math.abs(bPos.x - world.goals.find((g) => g.team !== world.me.team).mid.x);
      const canWin = myArr <= oppArr + 3 + (inMyHalf ? 2 : 0);
      const rate = (out.dirX > 0 ? ">" : out.dirX < 0 ? "<" : "-") + (out.dirY > 0 ? "v" : out.dirY < 0 ? "^" : "-");
      console.log(
        `t=${tick} me=(${me.pos.x.toFixed(0)},${me.pos.y.toFixed(0)}) ball=(${bPos.x.toFixed(0)},${bPos.y.toFixed(0)}) d=${d.toFixed(0)}`,
        `myArr=${myArr} oppArr=${oppArr} inMyHalf=${inMyHalf} canWin=${canWin} mode=${d <= 29 ? "ball" : canWin ? "chase" : "defend"} keys=${keyState} move=${rate}`,
        `bspd=${bspd.toFixed(2)} pred=(${(pred.pos.x || 0).toFixed(0)},${(pred.pos.y || 0).toFixed(0)})`
      );
    }

    const cp = state.getPlayer(BOT_ID);
    const playerIsKicking = !!cp && cp.isKicking === true;
    if (keyState === bot.prevKeyState) {
      if (!(keyState & 16)) {
        s.runSteps(1);
        continue;
      }
      if (playerIsKicking) {
        s.runSteps(1);
        continue;
      }
      s.playerInput(keyState & -17, BOT_ID);
    }
    s.playerInput(keyState, BOT_ID);
    bot.prevKeyState = keyState;
    s.runSteps(1);

    const ball = gameState.physicsState.discs[0];
    const bP = ball.pos || ball;
    const bx = bP.x;
    lastBallX = bx;

    if (Math.abs(bP.y) < 66) {
      const inside = bx > BLUE_GOAL_X - 3;
      if (inside && !wasIn) {
        crossings++;
        console.log(`  [gol #${crossings}] tick=${tick} ball=(${bx.toFixed(0)},${bP.y.toFixed(0)})`);
      }
      wasIn = inside;
    }
    if (bx > 250) ballReachedGoalside = true;
  }

  const st = s.state;
  console.log("----------------------------------------------");
  const gs = st.gameState;
  if (!gs || !gs.physicsState || !gs.physicsState.discs.length) {
    console.log("estado final sin balón (gameState=", gs && gs.state, ")");
  } else {
    const ball = gs.physicsState.discs[0];
    const bP = ball.pos || ball;
    const bS = ball.speed || ball;
    console.log(`balón final: (${(bP.x || 0).toFixed(0)}, ${(bP.y || 0).toFixed(0)}) velocidad ${Math.sqrt((bS.x || 0) ** 2 + (bS.y || 0) ** 2).toFixed(2)}`);
  }
  console.log(`llegó al lado del gol azul: ${ballReachedGoalside}`);
  console.log(`tocó dentro del gol (cabezazo/remate): ${crossings}`);

  let ok = ballReachedGoalside;
  console.log(ok ? "[OK] NeptunZinho avanzó con/contra el balón hacia el gol." : "[FALLO] El bot no generó juego ofensivo.");
  console.log("[DONE]");
  process.exit(ok ? 0 : 1);
}

try {
  main();
} catch (e) {
  console.error("[FALLO]", e && e.stack ? e.stack : e);
  process.exit(1);
}