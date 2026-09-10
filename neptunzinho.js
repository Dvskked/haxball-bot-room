"use strict";

const KICK_EXTRA = 4;
const PLAYER_RADIUS = 15;
const MAX_PLAYER_SPEED = 2.5;
const MAX_PLAYER_ACCEL = 0.1;
const BALL_DAMPING = 0.99;

function clamp(v, a, b) {
  return v < a ? a : (v > b ? b : v);
}

function len2(x, y) {
  return x * x + y * y;
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

function mul(a, k) {
  return { x: a.x * k, y: a.y * k };
}

function dist(a, b) {
  return Math.sqrt(len2(a.x - b.x, a.y - b.y));
}

function len(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

function norm(v) {
  const l = len(v) || 1e-9;
  return { x: v.x / l, y: v.y / l };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

function lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function collinear(a, b, c) {
  const t = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return Math.abs(t) < 1e-6;
}

function segClosest(seg, p) {
  const abx = seg.v1.x - seg.v0.x;
  const aby = seg.v1.y - seg.v0.y;
  const l2 = abx * abx + aby * aby;
  let t = l2 > 0 ? ((p.x - seg.v0.x) * abx + (p.y - seg.v0.y) * aby) / l2 : 0;
  t = clamp(t, 0, 1);
  return { x: seg.v0.x + abx * t, y: seg.v0.y + aby * t };
}

function distToSegment(seg, p) {
  const c = segClosest(seg, p);
  return dist(c, p);
}

function collideSegment(p, v, seg, radius) {
  const abx = seg.v1.x - seg.v0.x;
  const aby = seg.v1.y - seg.v0.y;
  const l2 = abx * abx + aby * aby;
  let t = l2 > 0 ? ((p.x - seg.v0.x) * abx + (p.y - seg.v0.y) * aby) / l2 : 0;
  t = clamp(t, 0, 1);
  const cx = seg.v0.x + abx * t;
  const cy = seg.v0.y + aby * t;
  let dx = p.x - cx;
  let dy = p.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 > radius * radius) return null;
  const d = Math.sqrt(d2) || 1e-9;
  const nx = dx / d;
  const ny = dy / d;
  const vn = v.x * nx + v.y * ny;
  if (vn >= -0.001) return null;
  const bCoef = seg.bCoef != null && seg.bCoef > 0 ? seg.bCoef : 0.8;
  return {
    pos: { x: cx + nx * radius, y: cy + ny * radius },
    vel: { x: (v.x - 2 * vn * nx) * bCoef, y: (v.y - 2 * vn * ny) * bCoef },
  };
}

function collidePlane(p, v, plane, radius) {
  const nx = plane.normal.x;
  const ny = plane.normal.y;
  const d = p.x * nx + p.y * ny - plane.dist;
  if (d >= -radius) return null;
  const vn = v.x * nx + v.y * ny;
  if (vn <= 0) return null;
  const bCoef = plane.bCoef != null && plane.bCoef > 0 ? plane.bCoef : 0.8;
  return {
    pos: { x: p.x - nx * (d + radius), y: p.y - ny * (d + radius) },
    vel: { x: (v.x - 2 * vn * nx) * bCoef, y: (v.y - 2 * vn * ny) * bCoef },
  };
}

function bounce(pos, vel, segments, planes, radius) {
  pos = { x: pos.x, y: pos.y };
  vel = { x: vel.x, y: vel.y };
  for (let iter = 0; iter < 6; iter++) {
    let hit = null;
    for (let i = 0; i < segments.length; i++) {
      const r = collideSegment(pos, vel, segments[i], radius);
      if (r && (!hit || dist(r.pos, pos) < dist(hit.pos, pos))) {
        hit = { ...r, seg: segments[i] };
      }
    }
    for (let i = 0; i < planes.length; i++) {
      const r = collidePlane(pos, vel, planes[i], radius);
      if (r && (!hit || dist(r.pos, pos) < dist(hit.pos, pos))) {
        hit = { ...r, plane: planes[i] };
      }
    }
    if (!hit) break;
    pos = hit.pos;
    vel = hit.vel;
  }
  return { pos, vel };
}

function reflectDir(dir, wallNormal) {
  const n = norm(wallNormal);
  const vn = dot(dir, n);
  return { x: dir.x - 2 * vn * n.x, y: dir.y - 2 * vn * n.y };
}

function predictBall(ball, segments, planes, ticks) {
  let pos = { x: ball.pos.x, y: ball.pos.y };
  let vel = { x: ball.speed.x, y: ball.speed.y };
  const trace = [{ x: pos.x, y: pos.y }];
  const radius = ball.radius;
  for (let i = 0; i < ticks; i++) {
    pos = add(pos, vel);
    vel = mul(vel, BALL_DAMPING);
    const b = bounce(pos, vel, segments, planes, radius);
    pos = b.pos;
    vel = b.vel;
    if (i % 5 === 0) trace.push({ x: pos.x, y: pos.y });
  }
  return { pos, vel, trace };
}

function arrivalTicks(from, to, mySpeed) {
  const d = dist(from, to);
  if (d < 1e-6) return 0;
  const avgSpeed = 0.35 * mySpeed + 1.85;
  return clamp(Math.ceil(d / avgSpeed) + 4, 0, 60);
}

function segPt(o) {
  if (!o) return { x: 0, y: 0 };
  if (o.pos) return { x: o.pos.x, y: o.pos.y };
  if (o.h) return { x: o.h.x, y: o.h.y };
  return { x: o.x || 0, y: o.y || 0 };
}

function discPos(d) {
  if (!d) return { x: 0, y: 0 };
  if (d.pos) return { x: d.pos.x, y: d.pos.y };
  return { x: d.x || 0, y: d.y || 0 };
}

function discSpeed(d) {
  if (!d) return { x: 0, y: 0 };
  if (d.speed) return { x: d.speed.x, y: d.speed.y };
  return { x: d.xspeed || 0, y: d.yspeed || 0 };
}

function discRadius(d) {
  if (!d) return 10;
  if (d.pos) return d.radius;
  return d.radius;
}

function buildWorld(state, gameState, playerId) {
  const stadium = state.stadium;
  const players = [];
  for (const p of state.players) {
    if (!p.disc) continue;
    const disc = p.disc && p.disc.ext ? p.disc.ext : p.disc;
    const t = p.team && p.team.id != null ? p.team.id : p.team;
    players.push({
      id: p.id,
      team: t,
      pos: discPos(disc),
      speed: discSpeed(disc),
      radius: discRadius(disc),
      isBot: p.customData && p.customData.isBot === true,
      isKicking: p.isKicking === true,
      isAdmin: p.isAdmin === true,
    });
  }

  const ballDisc = gameState && gameState.physicsState && gameState.physicsState.discs ? gameState.physicsState.discs[0] : null;
  const ball = ballDisc
    ? {
        pos: discPos(ballDisc),
        speed: discSpeed(ballDisc),
        radius: discRadius(ballDisc),
      }
    : { pos: { x: 0, y: 0 }, speed: { x: 0, y: 0 }, radius: 10 };

  const goals = (stadium.goals || []).map((g) => {
    const p0 = g.p0 ? { x: g.p0.x, y: g.p0.y } : { x: 0, y: 0 };
    const p1 = g.p1 ? { x: g.p1.x, y: g.p1.y } : { x: 0, y: 0 };
    const team = g.team ? (g.team.id != null ? g.team.id : g.team) : 0;
    return {
      p0,
      p1,
      mid: { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 },
      team,
      openDir: p1.x < p0.x ? -1 : 1,
    };
  });

  const segments = (stadium.segments || []).map((s) => ({
    v0: segPt(s.v0),
    v1: segPt(s.v1),
    bCoef: s.bCoef != null ? s.bCoef : s.P != null ? s.P : null,
  }));

  const planes = (stadium.planes || []).map((p) => ({
    normal: { x: p.normal.x, y: p.normal.y },
    dist: p.dist,
    bCoef: p.bCoef,
  }));

  const me = players.find((p) => p.id === playerId);
  return { players, me, ball, goals, stadium, segments, planes, width: stadium.width, height: stadium.height };
}

function makeBrain(opts) {
  opts = opts || {};
  const brain = {
    role: opts.role || "all-round",
    plan: null,
    planAge: 0,
    stallAge: 0,
    lastPos: null,
    flip: 1,
  };

  function ownGoal(ctx) {
    const g = ctx.goals.find((g) => g.team === ctx.me.team);
    return g ? g : ctx.goals[0];
  }

  function oppGoal(ctx) {
    const g = ctx.goals.find((g) => g.team !== ctx.me.team);
    return g ? g : ctx.goals[1];
  }

  function opponents(ctx) {
    return ctx.players.filter((p) => p.team !== ctx.me.team);
  }

  function teammates(ctx) {
    return ctx.players.filter((p) => p.team === ctx.me.team && p.id !== ctx.me.id);
  }

  function laneClear(ctx, a, b, margin) {
    const d = dist(a, b);
    if (d < 1e-6) return false;
    const n = { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
    const ops = opponents(ctx);
    let minBlock = 1e9;
    for (const o of ops) {
      const t = clamp((o.pos.x - a.x) * n.x + (o.pos.y - a.y) * n.y, 0, d);
      if (t < 4 || t > d - 4) continue;
      const proj = add(a, mul(n, t));
      const pd = dist(o.pos, proj);
      if (pd < minBlock) minBlock = pd;
    }
    return minBlock > margin;
  }

  function openMate(ctx) {
    const og = oppGoal(ctx);
    const ops = opponents(ctx);
    let best = null;
    let bestScore = -1e9;
    for (const m of teammates(ctx)) {
      if (!laneClear(ctx, m.pos, og.mid, 34)) continue;
      let dNear = 1e9;
      for (const o of ops) dNear = Math.min(dNear, dist(o.pos, m.pos));
      const score = 260 - dist(m.pos, og.mid) * 0.25 - dNear;
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return best;
  }

  function wallPassScore(ctx, W, wallNormal) {
    const ball = ctx.ball;
    const og = oppGoal(ctx);
    const inDir = norm(sub(W.pos, ball.pos));
    const exitDir = reflectDir(inDir, wallNormal);
    const res = predictBall(
      { pos: W.exitStart || W.pos, speed: mul(exitDir, 5.0), radius: ball.radius },
      ctx.segments,
      ctx.planes,
      70
    );
    const end = res.pos;
    const ops = opponents(ctx);
    let dBlock = 0;
    for (const o of ops) {
      dBlock += Math.max(0, 24 - dist(o.pos, end));
      dBlock += Math.max(0, 24 - dist(o.pos, W.pos));
    }
    let score = -dist(end, og.mid) * 0.12 - dBlock;
    const gx = og.mid.x + og.openDir * 12;
    if (Math.sign(end.x - og.mid.x) === og.openDir && Math.abs(end.y - og.mid.y) < 80) {
      score += 220;
    }
    return score;
  }

  function bestWallPass(ctx) {
    const W = ctx.width;
    const H = ctx.height;
    const og = oppGoal(ctx);
    const candidates = [];
    const sideY = [-H + 12, H - 12];
    sideY.forEach((y) => {
      const ny = y < 0 ? 1 : -1;
      for (let x = -W * 0.55; x <= W * 0.55; x += W * 0.22) {
        candidates.push({ pos: { x, y }, wallNormal: { x: 0, y: ny } });
      }
    });
    const backX = og.openDir > 0 ? W - 24 : -W + 24;
    for (let y = -120; y <= 120; y += 48) {
      candidates.push({ pos: { x: backX, y }, wallNormal: { x: -og.openDir, y: 0 } });
    }
    let best = null;
    let bestScore = -1e9;
    for (const c of candidates) {
      const s = wallPassScore(ctx, c, c.wallNormal);
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    return bestScore > 40 ? { point: best.pos, normal: best.wallNormal, score: bestScore } : null;
  }

  function shootDir(ctx) {
    const og = oppGoal(ctx);
    const ops = opponents(ctx);
    let aim = og.mid;
    const gK = ops.find((o) => dist(o.pos, og.mid) < 40);
    if (gK) {
      const side = gK.pos.y < og.mid.y ? 1 : -1;
      const half = Math.abs(og.p0.y - og.p1.y) / 2;
      aim = { x: og.mid.x + og.openDir * 4, y: og.mid.y + side * (half - 6) };
    }
    return { aim, fromBall: norm(sub(aim, ctx.ball.pos)) };
  }

  function clearDir(ctx) {
    const own = ownGoal(ctx);
    const away = mul(norm(sub(own.mid, ctx.ball.pos)), -1);
    const side = Math.abs(away.x) < 0.4 ? norm(sub(ctx.ball.pos, own.mid)).y : away.y;
    if (Math.abs(away.x) < 0.4) {
      return norm({ x: away.x, y: side < 0 ? -1 : 1 });
    }
    return away;
  }

  function steer(ctx, target, out) {
    const me = ctx.me;
    return steerVec(ctx, sub(target, me.pos), out);
  }

  function steerVec(ctx, delta, out) {
    const me = ctx.me;
    const dx = delta.x;
    const dy = delta.y;
    const dead = 3.5;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    out.dirX = adx > dead ? Math.sign(dx) : 0;
    out.dirY = ady > dead ? Math.sign(dy) : 0;
    return out;
  }

  function shootOnBall(ctx, aim, range, out) {
    const me = ctx.me;
    const ball = ctx.ball;
    const kickReach = me.radius + ball.radius + KICK_EXTRA;
    const d = dist(me.pos, ball.pos);
    const a = norm(sub(aim, ball.pos));
    const perp = { x: -a.y, y: a.x };
    const toTarget = dot(sub(me.pos, ball.pos), a);
    let target;
    if (d <= kickReach + 2 || toTarget <= kickReach * 0.5) {
      target = ball.pos;
    } else {
      const arm = Math.min(Math.max(range, 36), 90);
      const side = dot(sub(me.pos, ball.pos), perp) >= 0 ? 1 : -1;
      target = add(sub(ball.pos, mul(a, arm)), mul(perp, arm * side));
    }
    steer(ctx, target, out);
    const vd = dot(me.speed, a);
    const mySpeed = len(me.speed);
    if (d <= kickReach && vd > 0.22 && mySpeed > 0.35) {
      out.kick = true;
    }
    return out;
  }

  function playWithBall(ctx, out) {
    const me = ctx.me;
    const ball = ctx.ball;
    const og = oppGoal(ctx);
    const kickReach = me.radius + ball.radius + KICK_EXTRA;
    const dGoal = dist(ball.pos, og.mid);
    const dOwn = dist(ball.pos, ownGoal(ctx).mid);
    if (dOwn < 170) {
      return shootOnBall(ctx, clearDir(ctx), 40, out);
    }
    const aimInfo = shootDir(ctx);
    const directOpen = laneClear(ctx, ball.pos, aimInfo.aim, 28);

    if (directOpen || dGoal < 120) {
      const range = dGoal > 200 ? 180 : dGoal > 110 ? 90 : 45;
      return shootOnBall(ctx, aimInfo.aim, range, out);
    }

    const mate = openMate(ctx);
    if (mate && !laneClear(ctx, ball.pos, og.mid, 22)) {
      return shootOnBall(ctx, mate.pos, 80, out);
    }

    const wall = bestWallPass(ctx);
    if (wall && dGoal > 120) {
      const wd = dist(ball.pos, wall.point);
      if (wd < 420 && laneClear(ctx, ball.pos, wall.point, 20)) {
        return shootOnBall(ctx, wall.point, Math.min(wd * 0.2 + 40, 110), out);
      }
    }

    let aim = aimInfo.aim;
    const blocked = opponents(ctx).filter((o) => dist(o.pos, ball.pos) < 60 && Math.abs(o.pos.x - ball.pos.x) < 70);
    if (blocked.length > 0) {
      const bx = blocked[0].pos.y < ball.pos.y ? 1 : -1;
      const offset = norm({ x: aim.x - ball.pos.x, y: (aim.y - ball.pos.y) + bx * 70 });
      aim = { x: ball.pos.x + offset.x * 140, y: ball.pos.y + offset.y * 140 };
    }
    return shootOnBall(ctx, aim, 60, out);
  }

  function chase(ctx, out) {
    const me = ctx.me;
    const ball = ctx.ball;
    const kickReach = me.radius + ball.radius + KICK_EXTRA;
    const d = dist(me.pos, ball.pos);
    let target = { x: ball.pos.x, y: ball.pos.y };
    if (len(ball.speed) > 0.05) {
      const res = predictBall(ball, ctx.segments, ctx.planes, 24);
      target = res.pos;
    }
    steer(ctx, target, out);
    if (d <= kickReach) {
      if (!laneClear(ctx, ball.pos, oppGoal(ctx).mid, 20)) {
        out.kick = true;
      }
    }
    return out;
  }

  function defend(ctx, out) {
    const me = ctx.me;
    const ball = ctx.ball;
    const own = ownGoal(ctx);
    const kickReach = me.radius + ball.radius + KICK_EXTRA;
    const d = dist(me.pos, ball.pos);
    const dGoal = dist(ball.pos, own.mid);
    const ops = opponents(ctx);

    if (dGoal < 160) {
      const anchor = lerp(ball.pos, own.mid, 0.62);
      steer(ctx, anchor, out);
      if (d <= kickReach) {
        const cd = clearDir(ctx);
        if (dot(me.speed, cd) > 0.05 || len(me.speed) < 0.2) {
          out.kick = true;
          return out;
        }
      }
      return out;
    }

    const onLine = lerp(ball.pos, own.mid, 0.32);
    const side = ball.pos.y < own.mid.y ? -1 : 1;
    const anchor = {
      x: onLine.x + side * 2,
      y: clamp(onLine.y + Math.sin(ctx.tick / 9) * 6, -ctx.height * 0.75 + me.radius, ctx.height * 0.75 - me.radius),
    };
    steer(ctx, anchor, out);
    if (d <= kickReach && dot(me.speed, clearDir(ctx)) > 0.05) {
      out.kick = true;
    }
    return out;
  }

  function gk(ctx, out) {
    const me = ctx.me;
    const ball = ctx.ball;
    const own = ownGoal(ctx);
    const kickReach = me.radius + ball.radius + KICK_EXTRA;
    const d = dist(me.pos, ball.pos);
    const half = Math.abs(own.p0.y - own.p1.y) / 2;
    const minY = own.p0.y < own.p1.y ? own.p0.y : own.p1.y;
    const maxY = own.p0.y < own.p1.y ? own.p1.y : own.p0.y;
    const goalX = own.mid.x;
    const inside = own.openDir < 0 ? ball.pos.x < goalX : ball.pos.x > goalX;
    const danger = dist(ball.pos, own.mid) < 170 || inside;

    let ty = clamp(ball.pos.y, minY - 2, maxY + 2);
    let target = { x: goalX + (inside ? own.openDir * 6 : own.openDir * 10), y: ty };

    if (danger && d <= kickReach) {
      const cd = clearDir(ctx);
      out.dirX = cd.x < 0 ? -1 : 1;
      out.dirY = cd.y < 0 ? -1 : 1;
      out.kick = true;
      brain.clear = 6;
      return out;
    }
    if (danger) {
      target = ball.pos;
    }
    steer(ctx, target, out);
    return out;
  }

  brain.think = function (ctx) {
    ctx.tick = (ctx.tick || 0) + 1;
    const out = { dirX: 0, dirY: 0, kick: false };
    if (!ctx.me || !ctx.ball) return out;
    if (brain.role === "gk") return gk(ctx, out);

    const me = ctx.me;
    const ball = ctx.ball;
    const kickReach = me.radius + ball.radius + KICK_EXTRA;
    const d = dist(me.pos, ball.pos);

    if (brain.lastPos) {
      const moved = dist(me.pos, brain.lastPos);
      if (moved < 0.03) brain.stallAge++;
      else brain.stallAge = 0;
    }
    brain.lastPos = { x: me.pos.x, y: me.pos.y };

    const ops = opponents(ctx);
    const myArrival = arrivalTicks(me.pos, ball.pos, len(me.speed));
    let oppArrival = 1e9;
    for (const o of ops) {
      oppArrival = Math.min(oppArrival, arrivalTicks(o.pos, ball.pos, len(o.speed)));
    }

    if (d <= kickReach) {
      return playWithBall(ctx, out);
    }

    const inMyHalf = Math.abs(ball.pos.x - ownGoal(ctx).mid.x) < Math.abs(ball.pos.x - oppGoal(ctx).mid.x);
    const canWin = myArrival <= oppArrival + 3 + (inMyHalf ? 2 : 0);
    const ballStill = Math.abs(ball.speed.x) < 0.12 && Math.abs(ball.speed.y) < 0.12;
    if (d <= kickReach + 90 && (canWin || ballStill)) {
      return playWithBall(ctx, out);
    }
    if (canWin || ballStill) {
      return chase(ctx, out);
    }

    return defend(ctx, out);
  };

  return brain;
}

module.exports = {
  makeBrain,
  buildWorld,
  predictBall,
  bounce,
  collideSegment,
  collidePlane,
  reflectDir,
  distToSegment,
  segClosest,
  arrivalTicks,
  consts: {
    KICK_EXTRA,
    PLAYER_RADIUS,
    MAX_PLAYER_SPEED,
    MAX_PLAYER_ACCEL,
    BALL_DAMPING,
  },
};