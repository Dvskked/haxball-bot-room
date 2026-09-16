(function () {
  'use strict';

  if (typeof HBInit !== 'function') {
    if (typeof console !== 'undefined') {
      console.error('HBInit no esta definido. Ejecuta el script dentro de la consola del navegador abriendo: https://haxball.com/headless');
    }
    return;
  }

  var ROOM_CONFIG = {
    roomName: 'Bot IA Competitivo [Vanilla]',
    maxPlayers: 8,
    public: false,
    noPlayer: false,
    token: ''
  };

  var room = HBInit(ROOM_CONFIG);

  var CFG = {
    botEnabled: true,
    allAdmins: true,
    ballLookAhead: 2.0,
    kickRange: 34,
    kickCooldown: 0.08,
    alignCosClose: 0.92,
    alignCosFar: 0.97,
    stickDist: 24,
    longDist: 140,
    dangerClear: 120,
    blockDist: 85,
    goalHalf: 6,
    ballSpeed: 0.3,
    restartDelay: 4000,
    restartGap: 1000
  };

  var P = { W: 800, H: 400, BALL_R: 10, FRICTION: 0.5, DT: 1 / 60 };

  var V = {
    sub: function (a, b) { return { x: a.x - b.x, y: a.y - b.y }; },
    add: function (a, b) { return { x: a.x + b.x, y: a.y + b.y }; },
    mul: function (a, s) { return { x: a.x * s, y: a.y * s }; },
    dist: function (a, b) { return Math.hypot(a.x - b.x, a.y - b.y); },
    len: function (a) { return Math.hypot(a.x, a.y); },
    dot: function (a, b) { return a.x * b.x + a.y * b.y; },
    norm: function (a) { var l = Math.hypot(a.x, a.y); return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 }; },
    clamp: function (v, lo, hi) { return Math.min(Math.max(v, lo), hi); },
    angleDiff: function (a, b) { return Math.acos(V.clamp(V.dot(a, b), -1, 1)); }
  };

  var bot = { playerId: null };
  var lastKickAt = 0;

  function timeNow() { return new Date().getTime() / 1000; }

  function goalsInfo(selfTeam) {
    if (selfTeam === 1) return { own: { x: 790, y: 200 }, opp: { x: 10, y: 200 } };
    return { own: { x: 10, y: 200 }, opp: { x: 790, y: 200 } };
  }

  function simulateBall(ball, steps) {
    var dt = P.DT, f0 = Math.pow(1 - P.FRICTION, dt);
    var x = ball.x, y = ball.y, vx = ball.vx, vy = ball.vy;
    for (var i = 0; i < steps; i++) {
      vx *= f0; vy *= f0;
      var nx = x + vx * dt;
      var ny = y + vy * dt;
      if (nx < P.BALL_R || nx > P.W - P.BALL_R) vx = -vx;
      if (ny < P.BALL_R || ny > P.H - P.BALL_R) vy = -vy;
      x = V.clamp(nx, P.BALL_R, P.W - P.BALL_R);
      y = V.clamp(ny, P.BALL_R, P.H - P.BALL_R);
      if (Math.abs(vx) < 0.001 && Math.abs(vy) < 0.001) break;
    }
    return { x: x, y: y };
  }

  function behindBall(anchor, oppGoal, stick) {
    var toGoal = V.norm(V.sub(oppGoal, anchor));
    return V.sub(anchor, V.mul(toGoal, stick));
  }

  function leadPoint(pred, oppGoal, mePos) {
    var distMe = V.dist(mePos, pred);
    var lead = Math.min(65, distMe * 0.25);
    return behindBall(pred, oppGoal, CFG.stickDist + lead);
  }

  function blockPoint(ball, pred, ownGoal) {
    var ref = ball;
    var dirToOwn = V.norm(V.sub(ownGoal, ball));
    var travel = V.sub(pred, ball);
    var dirVel = V.norm(travel);
    var usePred = V.dot(dirToOwn, dirVel) > 0.7 && V.len(travel) > 40;
    if (usePred) ref = pred;
    var dline = V.norm(V.sub(ref, ownGoal));
    var toOwn = V.dist(ball, ownGoal);
    var perp = { x: -dline.y, y: dline.x };
    var off = 14 * (1 - Math.min(1, toOwn / 350));
    var pt = V.add(ownGoal, V.mul(dline, CFG.blockDist));
    return V.add(pt, V.mul(perp, off));
  }

  function wantKick(me, ball, aim) {
    var d = V.dist(me.position, ball);
    if (d > CFG.kickRange) return false;
    var toBall = V.norm(V.sub(ball, me.position));
    var toAim = V.norm(V.sub(aim, ball));
    var farShot = V.dist(me.position, aim) > 300;
    var th = farShot ? CFG.alignCosFar : CFG.alignCosClose;
    return V.dot(toBall, toAim) > th;
  }

  function drive(me, target) {
    var out = { left: false, right: false, up: false, down: false, kick: false };
    var dx = target.x - me.position.x;
    var dy = target.y - me.position.y;
    var d = Math.hypot(dx, dy);
    if (d < 3) return out;
    var nx = dx / d, ny = dy / d;
    if (nx > 0.18) out.right = true; else if (nx < -0.18) out.left = true;
    if (ny > 0.18) out.down = true; else if (ny < -0.18) out.up = true;
    return out;
  }

  function bouncesIntoGoal(ball, target, opp) {
    var dt = P.DT, R = P.BALL_R, W = P.W, H = P.H;
    var dir = V.norm(V.sub(target, ball));
    var sx = ball.x, sy = ball.y;
    var vx = dir.x * CFG.ballSpeed, vy = dir.y * CFG.ballSpeed;
    var isLeft = opp.x < 400;
    for (var i = 0; i < 180; i++) {
      var f = Math.pow(1 - P.FRICTION, dt);
      vx *= f; vy *= f;
      sx += vx * dt; sy += vy * dt;
      if (sy > opp.y - CFG.goalHalf && sy < opp.y + CFG.goalHalf) {
        if (isLeft && sx <= R - 0.1) return true;
        if (!isLeft && sx >= W - R + 0.1) return true;
      }
      if (isLeft && sx <= R) { sx = R; vx = -vx; }
      if (!isLeft && sx >= W - R) { sx = W - R; vx = -vx; }
      if (sy <= R) { sy = R; vy = -vy; }
      else if (sy >= H - R) { sy = H - R; vy = -vy; }
      if (Math.abs(vx) < 0.01 && Math.abs(vy) < 0.01) return false;
    }
    return false;
  }

  function scoreShot(ball, botPos, opp, cand) {
    var want = V.norm(V.sub(opp, ball));
    var dirC = V.norm(V.sub(cand, ball));
    var a1 = V.angleDiff(want, dirC);
    var a2 = V.angleDiff(V.norm(V.sub(ball, botPos)), dirC);
    return a1 + a2 + V.dist(ball, cand) * 0.002;
  }

  function planShot(ball, botPos, opp) {
    var cands = [
      { x: opp.x, y: opp.y },
      { x: opp.x, y: opp.y - CFG.goalHalf * 0.8 },
      { x: opp.x, y: opp.y + CFG.goalHalf * 0.8 }
    ];
    [0, -CFG.goalHalf * 0.8, CFG.goalHalf * 0.8].forEach(function (dy) {
      var my = opp.y + dy;
      cands.push({ x: opp.x, y: 2 * P.BALL_R - my });
      cands.push({ x: opp.x, y: 2 * (P.H - P.BALL_R) - my });
    });
    var best = null, bestScore = Infinity;
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (!bouncesIntoGoal(ball, c, opp)) continue;
      var s = scoreShot(ball, botPos, opp, c);
      if (s < bestScore) { bestScore = s; best = c; }
    }
    return best;
  }

  function pickClearAim(goals, ball) {
    var side = goals.opp.x < goals.own.x ? -1 : 1;
    var lane = V.clamp(ball.y, 170, 230);
    var aim = { x: ball.x + side * 380, y: lane };
    if (ball.y < 60) aim.y = V.clamp(ball.y + 120, 100, 340);
    if (ball.y > 340) aim.y = V.clamp(ball.y - 120, 60, 300);
    return aim;
  }

  function updateBot() {
    if (!CFG.botEnabled || bot.playerId === null) return;
    var players = room.getPlayerList();
    var me = null;
    for (var i = 0; i < players.length; i++) {
      if (players[i].id === bot.playerId && players[i].team !== 0) { me = players[i]; break; }
    }
    if (!me) return;
    var ball = room.getBall();
    if (!ball) return;

    var goals = goalsInfo(me.team);
    var distBall = V.dist(me.position, ball);
    var distOwn = V.dist(ball, goals.own);
    var steps = Math.max(1, Math.round(CFG.ballLookAhead * 60));
    var pred = simulateBall(ball, steps);

    var target, aim = { x: goals.opp.x, y: goals.opp.y };
    var kick = false;

    if (distOwn < V.dist(ball, goals.opp)) {
      if (distOwn < CFG.dangerClear) {
        target = pred;
        aim = pickClearAim(goals, ball);
        kick = wantKick(me, ball, aim);
      } else {
        target = blockPoint(ball, pred, goals.own);
      }
    } else {
      if (distBall > CFG.longDist) target = leadPoint(pred, goals.opp, me.position);
      else target = behindBall(pred, goals.opp, CFG.stickDist);
      var shot = planShot(ball, me.position, goals.opp);
      if (shot) aim = shot;
      kick = wantKick(me, ball, aim);
    }

    target.x = V.clamp(target.x, 20, P.W - 20);
    target.y = V.clamp(target.y, 20, P.H - 20);

    var input = drive(me, target);
    var now = timeNow();
    input.kick = kick && now - lastKickAt > CFG.kickCooldown;
    if (input.kick) lastKickAt = now;

    room.setPlayerInputs(me.id, input);
  }

  function balanceTeams() {
    var pl = room.getPlayerList();
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

  room.onPlayerJoin = function (player) {
    if (bot.playerId === null) bot.playerId = player.id;
    if (CFG.allAdmins) {
      try { room.setPlayerAdmin(player.id, true); } catch (e) {}
    }
    balanceTeams();
  };

  room.onPlayerLeave = function (player) {
    if (player.id === bot.playerId) {
      var pl = room.getPlayerList().filter(function (p) { return p.team !== 0; });
      bot.playerId = pl.length ? pl[0].id : null;
    }
    balanceTeams();
  };

  room.onTeamVictory = function (scores) {
    if (CFG.restartDelay <= 0) return;
    setTimeout(function () { try { room.stopGame(); } catch (e) {} }, CFG.restartDelay);
  };

  room.onGameStop = function () {
    setTimeout(function () {
      var pl = room.getPlayerList().filter(function (p) { return p.team !== 0; });
      if (pl.length && CFG.restartGap > 0) {
        try { room.startGame(); } catch (e) {}
      }
    }, CFG.restartGap);
  };

  room.onPlayerChat = function (player, message) {
    var m = String(message).trim().toLowerCase();
    if (m === '!bot') {
      CFG.botEnabled = !CFG.botEnabled;
      room.sendAnnouncement(CFG.botEnabled ? 'IA del bot ACTIVADA' : 'IA del bot DESACTIVADA');
    }
    return true;
  };

  room.onGameTick = function () { updateBot(); };

  try { room.setDefaultStadium('Classic'); } catch (e) {}

  room.sendAnnouncement('Bot IA cargado. Usa !bot para activar/desactivar.');
  window.HAXBOT = { room: room, cfg: CFG, bot: bot };
})();