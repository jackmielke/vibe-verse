/**
 * VIBE CUP — drawing. Canvas 2D, a tilted top-down view of the cage that
 * follows the ball, turned on its side on a portrait phone so the pitch
 * always runs the long way of the screen.
 *
 * The pitch layer is drawn through one affine transform (scale, squash for
 * the tilt, and the quarter turn in portrait). Everything that stands up
 * (players, the ball, posts, the crowd) is drawn in screen space at the
 * projected point instead, so a number on a shirt is never sideways.
 */
import {
  attackDir, BALL_R, BOX_L, BOX_W, GOAL_D, GOAL_H, GOAL_W, L, W, type Club, type Game, type GameEvent, type Player,
} from "./game";

const TILT = 0.72;

export interface View {
  w: number;
  h: number;
  dpr: number;
  portrait: boolean;
  /** Pixels per metre. */
  s: number;
  camX: number;
  camY: number;
}

export function fitView(w: number, h: number, dpr: number, prev?: View): View {
  const portrait = h > w * 1.05;
  const long = portrait ? h / TILT : w;
  const across = portrait ? w : h / TILT;
  // About 32 m of pitch along the long side, never so close that the width does not fit half the pitch.
  const s = Math.max(long / 42, Math.min(long / 32, across / 21));
  return { w, h, dpr, portrait, s, camX: prev?.camX ?? 0, camY: prev?.camY ?? 0 };
}

/** A stick direction on screen (x right, y down) to a world direction. */
export function screenToWorld(v: View, sx: number, sy: number): { x: number; y: number } {
  return v.portrait ? { x: -sy, y: sx } : { x: sx, y: sy };
}

const project = (v: View, x: number, y: number, z = 0) => {
  const rx = x - v.camX;
  const ry = y - v.camY;
  return v.portrait
    ? { x: v.w / 2 + ry * v.s, y: v.h / 2 - rx * v.s * TILT - z * v.s }
    : { x: v.w / 2 + rx * v.s, y: v.h / 2 + ry * v.s * TILT - z * v.s };
};

const pitchTransform = (ctx: CanvasRenderingContext2D, v: View) => {
  const { s, dpr } = v;
  if (v.portrait) ctx.setTransform(0, -s * TILT * dpr, s * dpr, 0, (v.w / 2 - v.camY * s) * dpr, (v.h / 2 + v.camX * s * TILT) * dpr);
  else ctx.setTransform(s * dpr, 0, 0, s * TILT * dpr, (v.w / 2 - v.camX * s) * dpr, (v.h / 2 - v.camY * s * TILT) * dpr);
};

// ---------------------------------------------------------------------------
// Effects that live outside the rules: confetti, trails, the crowd.
// ---------------------------------------------------------------------------

interface Bit {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  color: string;
  size: number;
}

export interface Fx {
  bits: Bit[];
  trail: Array<{ x: number; y: number; z: number; t: number }>;
  cheer: number;
  cheerTeam: number;
  banner: { text: string; sub: string; color: string; t: number } | null;
  crowd: Array<{ x: number; y: number; c: string; ph: number }>;
  spin: number;
  t: number;
  seed: number;
}

export function newFx(clubs: [Club, Club]): Fx {
  const fx: Fx = { bits: [], trail: [], cheer: 0, cheerTeam: 0, banner: null, crowd: [], spin: 0, t: 0, seed: 7 };
  const r = () => ((fx.seed = (fx.seed * 16807) % 2147483647) / 2147483647);
  const colors = [clubs[0].shirt, clubs[0].trim, clubs[1].shirt, clubs[1].trim, "#f5d0a9", "#c58c5c", "#ffffff"];
  // Stands down both long sides and behind each goal.
  for (let i = 0; i < 520; i++) {
    const side = i % 4;
    let x: number;
    let y: number;
    if (side < 2) {
      x = (r() - 0.5) * (L + 10);
      y = (side ? 1 : -1) * (W / 2 + 1.8 + r() * 5.5);
    } else {
      x = (side === 2 ? 1 : -1) * (L / 2 + GOAL_D + 1.8 + r() * 4.5);
      y = (r() - 0.5) * (W + 8);
    }
    // Home fans on the home side.
    const home = x < 0 ? 0.7 : 0.3;
    const c = r() < 0.6 ? (r() < home ? colors[r() < 0.75 ? 0 : 1] : colors[r() < 0.75 ? 2 : 3]) : colors[4 + Math.floor(r() * 3)];
    fx.crowd.push({ x, y, c, ph: r() * 6.28 });
  }
  return fx;
}

export function feedFx(fx: Fx, g: Game, events: GameEvent[]) {
  for (const e of events) {
    if (e.type === "goal") {
      fx.cheer = 4;
      fx.cheerTeam = e.team;
      const club = g.clubs[e.team];
      fx.banner = {
        text: e.fire ? "SUPER GOAL!" : "GOAL!",
        sub: e.own ? `Own goal, ${e.name}. ${club.short} lead the cheers` : `${e.name} for ${club.name}`,
        color: club.shirt,
        t: 0,
      };
      for (let i = 0; i < 160; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 3 + Math.random() * 9;
        fx.bits.push({
          x: g.ball.x,
          y: g.ball.y,
          z: 1 + Math.random(),
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          vz: 4 + Math.random() * 7,
          life: 2 + Math.random() * 1.5,
          color: [club.shirt, club.trim, "#ffffff", "#ffd23f"][i % 4],
          size: 0.12 + Math.random() * 0.12,
        });
      }
    } else if (e.type === "save") {
      fx.cheer = Math.max(fx.cheer, 1.2);
      fx.banner = { text: e.caught ? "CAUGHT!" : "SAVED!", sub: e.name, color: "#ffffff", t: 0 };
    } else if (e.type === "post") {
      fx.banner = { text: "OFF THE POST!", sub: "", color: "#ffd23f", t: 0 };
      fx.cheer = Math.max(fx.cheer, 0.8);
    } else if (e.type === "golden") {
      fx.banner = { text: "GOLDEN GOAL", sub: "Next goal wins it", color: "#ffd23f", t: 0 };
    } else if (e.type === "fulltime") {
      fx.banner = {
        text: "FULL TIME",
        sub: e.winner === null ? `${g.score[0]} – ${g.score[1]}, honours even` : `${g.clubs[e.winner].name} win ${Math.max(...g.score)}–${Math.min(...g.score)}`,
        color: e.winner === null ? "#ffffff" : g.clubs[e.winner].shirt,
        t: 0,
      };
      fx.cheer = 5;
      if (e.winner !== null) fx.cheerTeam = e.winner;
    } else if (e.type === "tackle") {
      for (let i = 0; i < 10; i++) {
        fx.bits.push({
          x: g.ball.x,
          y: g.ball.y,
          z: 0.1,
          vx: (Math.random() - 0.5) * 4,
          vy: (Math.random() - 0.5) * 4,
          vz: 1.5 + Math.random() * 2,
          life: 0.5,
          color: "#3f7d2c",
          size: 0.08,
        });
      }
    }
  }
}

function tickFx(fx: Fx, g: Game, dt: number) {
  fx.t += dt;
  fx.cheer = Math.max(0, fx.cheer - dt);
  if (fx.banner) {
    fx.banner.t += dt;
    if (fx.banner.t > (fx.banner.text === "FULL TIME" ? 99 : fx.banner.text.includes("GOAL") ? 2.8 : 1.2)) fx.banner = null;
  }
  for (const b of fx.bits) {
    b.vz -= 9.8 * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z += b.vz * dt;
    if (b.z < 0) {
      b.z = 0;
      b.vz = 0;
      b.vx *= 0.8;
      b.vy *= 0.8;
    }
    b.life -= dt;
  }
  fx.bits = fx.bits.filter((b) => b.life > 0);
  const ball = g.ball;
  if (ball.fire > 0 || Math.hypot(ball.vx, ball.vy) > 17) fx.trail.push({ x: ball.x, y: ball.y, z: ball.z, t: fx.t });
  fx.trail = fx.trail.filter((p) => fx.t - p.t < 0.35);
  fx.spin += Math.hypot(ball.vx, ball.vy) * dt * 2.2;
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

const KEEPER_SHIRT = ["#a3e635", "#f472b6"];
export const PAD_COLORS = ["#38bdf8", "#fb7185", "#facc15", "#a3e635"];

export function drawFrame(ctx: CanvasRenderingContext2D, g: Game, v: View, fx: Fx, dt: number, labels: string[]) {
  tickFx(fx, g, dt);
  // Camera: ahead of the ball, clamped so the far end of the cage stays on.
  const b = g.ball;
  const lookX = b.x + b.vx * 0.25;
  const lookY = b.y + b.vy * 0.25;
  const halfLong = (v.portrait ? v.h / TILT : v.w) / 2 / v.s;
  const halfAcross = (v.portrait ? v.w : v.h / TILT) / 2 / v.s;
  const maxX = Math.max(0, L / 2 + 5 - halfLong);
  const maxY = Math.max(0, W / 2 + 4 - halfAcross);
  const k = Math.min(1, dt * 4);
  v.camX += (Math.max(-maxX, Math.min(maxX, lookX)) - v.camX) * k;
  v.camY += (Math.max(-maxY, Math.min(maxY, lookY * 0.8)) - v.camY) * k;
  const shake = g.shake > 0 ? g.shake * 10 : 0;
  const sx = shake ? (Math.random() - 0.5) * shake : 0;
  const sy = shake ? (Math.random() - 0.5) * shake : 0;
  const cv = { ...v, camX: v.camX + sx / v.s, camY: v.camY + sy / v.s };

  ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
  ctx.fillStyle = "#13202e";
  ctx.fillRect(0, 0, v.w, v.h);

  drawPitch(ctx, cv);
  drawCrowd(ctx, cv, g, fx);
  ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);

  // Goal backs (behind everybody).
  drawGoal(ctx, cv, -1, true);
  drawGoal(ctx, cv, 1, true);

  // Shadows.
  for (const p of g.players) shadow(ctx, cv, p.x, p.y, 0.42, 0.35);
  shadow(ctx, cv, b.x, b.y, 0.26 * Math.max(0.5, 1 - b.z * 0.08), 0.4 * Math.max(0.3, 1 - b.z * 0.1));

  // Markers under the people's players.
  g.ctrls.forEach((c, n) => {
    const p = g.players[c.active];
    const q = project(cv, p.x, p.y);
    ctx.strokeStyle = PAD_COLORS[n % PAD_COLORS.length];
    ctx.lineWidth = Math.max(2, v.s * 0.09);
    ctx.beginPath();
    ctx.ellipse(q.x, q.y, v.s * 0.62, v.s * 0.62 * TILT, 0, 0, Math.PI * 2);
    ctx.stroke();
  });

  // Sorted by depth on screen.
  const items: Array<{ y: number; draw: () => void }> = [];
  for (const p of g.players) {
    const q = project(cv, p.x, p.y);
    items.push({ y: q.y, draw: () => drawPlayer(ctx, cv, g, p, fx) });
  }
  const bq = project(cv, b.x, b.y);
  items.push({ y: bq.y + 0.01, draw: () => drawBall(ctx, cv, g, fx) });
  for (const bit of fx.bits) {
    const q = project(cv, bit.x, bit.y);
    items.push({
      y: q.y,
      draw: () => {
        const p = project(cv, bit.x, bit.y, bit.z);
        ctx.fillStyle = bit.color;
        const s = bit.size * v.s;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(bit.life * 9 + bit.x);
        ctx.fillRect(-s, -s * 0.5, s * 2, s);
        ctx.restore();
      },
    });
  }
  items.sort((a, z) => a.y - z.y);
  for (const it of items) it.draw();

  drawGoal(ctx, cv, -1, false);
  drawGoal(ctx, cv, 1, false);

  // Labels and the shot meter above the people's players.
  g.ctrls.forEach((c, n) => {
    const p = g.players[c.active];
    const q = project(cv, p.x, p.y, 2.2);
    const col = PAD_COLORS[n % PAD_COLORS.length];
    ctx.font = `900 ${Math.max(11, v.s * 0.42)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillStyle = col;
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = 3;
    ctx.strokeText(labels[n] ?? `P${n + 1}`, q.x, q.y);
    ctx.fillText(labels[n] ?? `P${n + 1}`, q.x, q.y);
    // Down-pointing triangle.
    const t = Math.max(5, v.s * 0.16);
    ctx.beginPath();
    ctx.moveTo(q.x - t, q.y + 4);
    ctx.lineTo(q.x + t, q.y + 4);
    ctx.lineTo(q.x, q.y + 4 + t);
    ctx.fill();
    if (c.charge > 0 && g.ball.owner === p.i) {
      const w = v.s * 1.4;
      const hgt = Math.max(5, v.s * 0.16);
      const x0 = q.x - w / 2;
      const y0 = q.y - v.s * 0.75;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(x0 - 2, y0 - 2, w + 4, hgt + 4);
      const full = c.charge >= 0.97;
      ctx.fillStyle = full ? (Math.floor(fx.t * 12) % 2 ? "#ff3b1f" : "#ffd23f") : c.charge > 0.66 ? "#ff8a3d" : "#7dfce0";
      ctx.fillRect(x0, y0, w * c.charge, hgt);
      if (full) {
        ctx.font = `900 ${Math.max(10, v.s * 0.32)}px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillStyle = "#ffd23f";
        ctx.fillText("SUPER!", q.x, y0 - 4);
      }
    }
  });

  drawRadar(ctx, v, g);
  drawBanner(ctx, v, fx);
}

function drawPitch(ctx: CanvasRenderingContext2D, v: View) {
  pitchTransform(ctx, v);
  // Concrete round the cage, then the stand floors.
  ctx.fillStyle = "#24364a";
  ctx.fillRect(-L / 2 - 12, -W / 2 - 10, L + 24, W + 20);
  ctx.fillStyle = "#1a2838";
  ctx.fillRect(-L / 2 - 12, -W / 2 - 8, L + 24, 6.5);
  ctx.fillRect(-L / 2 - 12, W / 2 + 1.5, L + 24, 6.5);
  // Grass with mowing stripes.
  const stripes = 13;
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 ? "#3f9a3c" : "#46a842";
    ctx.fillRect(-L / 2 - 1 + ((L + 2) * i) / stripes, -W / 2, (L + 2) / stripes + 0.02, W);
  }
  // Lines.
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 0.14;
  ctx.strokeRect(-L / 2, -W / 2 + 0.6, L, W - 1.2);
  ctx.beginPath();
  ctx.moveTo(0, -W / 2 + 0.6);
  ctx.lineTo(0, W / 2 - 0.6);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, 4.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.beginPath();
  ctx.arc(0, 0, 0.25, 0, Math.PI * 2);
  ctx.fill();
  for (const s of [-1, 1]) {
    const gx = (s * L) / 2;
    ctx.strokeRect(s > 0 ? gx - BOX_L : gx, -BOX_W / 2, BOX_L, BOX_W);
    ctx.strokeRect(s > 0 ? gx - 3 : gx, -GOAL_W / 2 - 1.5, 3, GOAL_W + 3);
    ctx.beginPath();
    ctx.arc(gx - s * 6.5, 0, 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(gx - s * BOX_L, 0, 3, s > 0 ? Math.PI / 2 : -Math.PI / 2, s > 0 ? (3 * Math.PI) / 2 : Math.PI / 2);
    ctx.stroke();
    // Goal floor (inside the net).
    ctx.fillStyle = "rgba(0,0,0,0.12)";
    ctx.fillRect(s > 0 ? gx : gx - GOAL_D, -GOAL_W / 2, GOAL_D, GOAL_W);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
  }
  // The VIBE CUP crest in the centre circle.
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(0, 0, 3.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Boards: alternating panels round the cage.
  const panel = (x0: number, y0: number, x1: number, y1: number, i: number) => {
    ctx.fillStyle = ["#1fd1b0", "#8b5cf6", "#ffd23f", "#ff5cc8"][i % 4];
    ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0) || 0.5, Math.abs(y1 - y0) || 0.5);
  };
  const n = 13;
  for (let i = 0; i < n; i++) {
    const x0 = -L / 2 - 0.8 + ((L + 1.6) * i) / n;
    const x1 = x0 + (L + 1.6) / n - 0.15;
    panel(x0, -W / 2 - 0.5, x1, -W / 2, i);
    panel(x0, W / 2, x1, W / 2 + 0.5, i + 2);
  }
  for (const s of [-1, 1]) {
    const x = s > 0 ? L / 2 + 0.6 : -L / 2 - 1.1;
    panel(x, -W / 2 - 0.5, x + 0.5, -GOAL_W / 2 - 0.3, 1);
    panel(x, GOAL_W / 2 + 0.3, x + 0.5, W / 2 + 0.5, 3);
  }
  ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
}

function drawCrowd(ctx: CanvasRenderingContext2D, v: View, g: Game, fx: Fx) {
  ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
  const r = Math.max(1.5, v.s * 0.2);
  for (const c of fx.crowd) {
    const p = project(v, c.x, c.y);
    if (p.x < -10 || p.y < -10 || p.x > v.w + 10 || p.y > v.h + 10) continue;
    const loud = fx.cheer > 0 && (c.c === g.clubs[fx.cheerTeam].shirt || c.c === g.clubs[fx.cheerTeam].trim) ? 1 : 0.15;
    const hop = Math.abs(Math.sin(fx.t * (loud > 0.5 ? 11 : 2) + c.ph)) * v.s * 0.22 * loud;
    ctx.fillStyle = c.c;
    ctx.fillRect(p.x - r, p.y - r * 1.4 - hop, r * 2, r * 2.2);
    ctx.fillStyle = "#e9b98f";
    ctx.beginPath();
    ctx.arc(p.x, p.y - r * 2 - hop, r * 0.8, 0, Math.PI * 2);
    ctx.fill();
    if (loud > 0.5 && fx.cheer > 0) {
      ctx.fillStyle = c.c;
      ctx.fillRect(p.x - r * 1.4, p.y - r * 3.4 - hop, r * 0.5, r * 1.6);
      ctx.fillRect(p.x + r * 0.9, p.y - r * 3.4 - hop, r * 0.5, r * 1.6);
    }
  }
}

function shadow(ctx: CanvasRenderingContext2D, v: View, x: number, y: number, rx: number, alpha: number) {
  const q = project(v, x, y);
  ctx.fillStyle = `rgba(0,0,0,${alpha})`;
  ctx.beginPath();
  ctx.ellipse(q.x, q.y, rx * v.s, rx * v.s * TILT * 0.8, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** Screen direction of a world angle. */
const screenDir = (v: View, a: number) => {
  const wx = Math.cos(a);
  const wy = Math.sin(a);
  return v.portrait ? { x: wy, y: -wx * TILT } : { x: wx, y: wy * TILT };
};

function drawPlayer(ctx: CanvasRenderingContext2D, v: View, g: Game, p: Player, fx: Fx) {
  const club = g.clubs[p.team];
  const gk = p.role === "gk";
  const shirt = gk ? KEEPER_SHIRT[p.team] : club.shirt;
  const s = v.s;
  const foot = project(v, p.x, p.y);
  const d = screenDir(v, p.face);
  const sp = Math.hypot(p.vx, p.vy);
  const swing = Math.sin(p.stride * 2.2) * Math.min(1, sp / 6) * 0.28 * s;
  const sliding = p.slide > 0;
  const down = p.stun > 0 && !sliding;
  // Celebration: hop.
  const hop = g.phase !== "play" && g.phase !== "kickoff" && p.team === (g.lastGoal?.team ?? -1) && !gk ? Math.abs(Math.sin(fx.t * 9 + p.i)) * s * 0.35 : 0;

  ctx.save();
  ctx.translate(foot.x, foot.y - hop);
  if (sliding || down) {
    // Lying along the way they were going.
    const ang = Math.atan2(d.y, d.x);
    ctx.rotate(ang + (d.x < 0 ? Math.PI : 0));
    const dir = d.x < 0 ? -1 : 1;
    ctx.fillStyle = club.shorts;
    ctx.fillRect(-0.1 * s * dir, -0.25 * s, 0.5 * s * dir, 0.22 * s);
    ctx.fillStyle = "#f1c7a5";
    ctx.fillRect(0.35 * s * dir, -0.2 * s, 0.4 * s * dir, 0.12 * s);
    ctx.fillStyle = shirt;
    ctx.fillRect(-0.6 * s * dir, -0.36 * s, 0.55 * s * dir, 0.34 * s);
    ctx.fillStyle = "#f1c7a5";
    ctx.beginPath();
    ctx.arc(-0.78 * s * dir, -0.22 * s, 0.17 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    if (down) {
      // Stars.
      for (let k = 0; k < 3; k++) {
        const a = fx.t * 6 + (k * Math.PI * 2) / 3;
        ctx.fillStyle = "#ffd23f";
        ctx.font = `${Math.max(9, s * 0.32)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText("★", foot.x + Math.cos(a) * s * 0.45, foot.y - s * 0.9 + Math.sin(a) * s * 0.15);
      }
    }
    return;
  }
  // Legs.
  const hipY = -0.75 * s;
  const kick = p.kick > 0 ? Math.sin((p.kick / 0.3) * Math.PI) * 0.45 * s : 0;
  ctx.strokeStyle = "#f1c7a5";
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(2, 0.15 * s);
  for (const side of [-1, 1]) {
    const sw = side * swing + (side > 0 ? kick : 0);
    ctx.beginPath();
    ctx.moveTo(side * 0.1 * s, hipY);
    ctx.lineTo(side * 0.1 * s + d.x * sw, -0.12 * s + d.y * sw * 0.5);
    ctx.stroke();
    // Boot.
    ctx.fillStyle = "#151515";
    ctx.beginPath();
    ctx.arc(side * 0.1 * s + d.x * sw, -0.08 * s + d.y * sw * 0.5, 0.09 * s, 0, Math.PI * 2);
    ctx.fill();
  }
  // Shorts.
  ctx.fillStyle = club.shorts;
  roundRect(ctx, -0.24 * s, hipY - 0.12 * s, 0.48 * s, 0.26 * s, 0.06 * s);
  // Shirt.
  ctx.fillStyle = shirt;
  roundRect(ctx, -0.27 * s, hipY - 0.68 * s, 0.54 * s, 0.6 * s, 0.14 * s);
  // Trim: a band across the chest.
  ctx.fillStyle = gk ? "#111" : club.trim;
  ctx.fillRect(-0.27 * s, hipY - 0.5 * s, 0.54 * s, 0.08 * s);
  // Arms, swinging opposite the legs (keepers' up when diving is the slide pose above).
  ctx.strokeStyle = shirt;
  ctx.lineWidth = Math.max(2, 0.12 * s);
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * 0.27 * s, hipY - 0.58 * s);
    const arm = hop ? -0.5 * s : 0;
    ctx.lineTo(side * 0.36 * s - d.x * side * swing * 0.6, hipY - 0.2 * s + arm);
    ctx.stroke();
    if (gk) {
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(side * 0.36 * s - d.x * side * swing * 0.6, hipY - 0.2 * s + arm, 0.08 * s, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Number: on the back when they face away from the camera, a badge dot on the front otherwise.
  const away = v.portrait ? d.y < -0.15 : d.y < -0.15;
  ctx.fillStyle = gk ? "#111" : club.ink;
  ctx.font = `900 ${Math.max(8, 0.3 * s)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (away || Math.abs(d.x) > 0.6) ctx.fillText(String(p.num), d.x * 0.06 * s, hipY - 0.3 * s);
  else {
    ctx.beginPath();
    ctx.arc(0.12 * s, hipY - 0.38 * s, 0.05 * s, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.textBaseline = "alphabetic";
  // Head.
  const hx = d.x * 0.04 * s;
  const hy = hipY - 0.86 * s;
  ctx.fillStyle = ["#f1c7a5", "#d9a27c", "#a86f4c", "#7b4a2e", "#ffd9b8"][p.i % 5];
  ctx.beginPath();
  ctx.arc(hx, hy, 0.2 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = ["#2b1d14", "#e8c35a", "#111", "#8a3b12", "#4a2a1a"][(p.i * 3) % 5];
  ctx.beginPath();
  if (away) ctx.arc(hx, hy, 0.2 * s, 0, Math.PI * 2);
  else ctx.arc(hx, hy - 0.04 * s, 0.2 * s, Math.PI * 1.05, Math.PI * 1.95);
  ctx.fill();
  if (!away) {
    ctx.fillStyle = "#111";
    ctx.fillRect(hx + d.x * 0.08 * s - 0.08 * s, hy - 0.02 * s, 0.04 * s, 0.05 * s);
    ctx.fillRect(hx + d.x * 0.08 * s + 0.04 * s, hy - 0.02 * s, 0.04 * s, 0.05 * s);
  }
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

function drawBall(ctx: CanvasRenderingContext2D, v: View, g: Game, fx: Fx) {
  const b = g.ball;
  // Flame trail.
  for (const t of fx.trail) {
    const age = (fx.t - t.t) / 0.35;
    const q = project(v, t.x, t.y, t.z);
    ctx.fillStyle = b.fire > 0 ? `rgba(255,${Math.round(180 - age * 150)},40,${0.7 * (1 - age)})` : `rgba(255,255,255,${0.35 * (1 - age)})`;
    ctx.beginPath();
    ctx.arc(q.x, q.y, v.s * BALL_R * 1.6 * (1 - age * 0.6), 0, Math.PI * 2);
    ctx.fill();
  }
  const q = project(v, b.x, b.y, b.z);
  const r = v.s * BALL_R * 1.45;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 1;
  ctx.stroke();
  // Spots that roll.
  ctx.save();
  ctx.beginPath();
  ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = "#1b1b1b";
  for (let k = 0; k < 3; k++) {
    const ph = fx.spin + k * 2.1;
    const ox = Math.sin(ph) * r * 0.75;
    const oy = Math.cos(ph * 0.7 + k) * r * 0.5;
    ctx.beginPath();
    ctx.arc(q.x + ox, q.y + oy, r * 0.32 * (0.6 + 0.4 * Math.cos(ph)), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  if (b.fire > 0) {
    ctx.strokeStyle = "#ffd23f";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(q.x, q.y, r + 2, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/** A goal: back net (behind everybody) or the frame and front net edges. */
function drawGoal(ctx: CanvasRenderingContext2D, v: View, side: -1 | 1, back: boolean) {
  const gx = (side * L) / 2;
  const bx = gx + side * GOAL_D;
  const corners = [
    [gx, -GOAL_W / 2],
    [gx, GOAL_W / 2],
    [bx, GOAL_W / 2],
    [bx, -GOAL_W / 2],
  ];
  const P = (x: number, y: number, z: number) => project(v, x, y, z);
  if (back) {
    // Net: back and roof, as a translucent mesh.
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.lineWidth = 1;
    const quad = (pts: Array<{ x: number; y: number }>) => {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fill();
    };
    quad([P(bx, -GOAL_W / 2, 0), P(bx, GOAL_W / 2, 0), P(bx, GOAL_W / 2, GOAL_H * 0.85), P(bx, -GOAL_W / 2, GOAL_H * 0.85)]);
    quad([P(gx, -GOAL_W / 2, GOAL_H), P(gx, GOAL_W / 2, GOAL_H), P(bx, GOAL_W / 2, GOAL_H * 0.85), P(bx, -GOAL_W / 2, GOAL_H * 0.85)]);
    for (let i = 0; i <= 10; i++) {
      const y = -GOAL_W / 2 + (GOAL_W * i) / 10;
      const a = P(gx, y, GOAL_H);
      const m = P(bx, y, GOAL_H * 0.85);
      const z = P(bx, y, 0);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(m.x, m.y);
      ctx.lineTo(z.x, z.y);
      ctx.stroke();
    }
    for (let i = 1; i < 5; i++) {
      const h = (GOAL_H * 0.85 * i) / 5;
      const a = P(bx, -GOAL_W / 2, h);
      const c = P(bx, GOAL_W / 2, h);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(c.x, c.y);
      ctx.stroke();
    }
    void corners;
    return;
  }
  // The frame.
  ctx.strokeStyle = "#ffffff";
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(2.5, v.s * 0.13);
  const l0 = P(gx, -GOAL_W / 2, 0);
  const l1 = P(gx, -GOAL_W / 2, GOAL_H);
  const r0 = P(gx, GOAL_W / 2, 0);
  const r1 = P(gx, GOAL_W / 2, GOAL_H);
  ctx.beginPath();
  ctx.moveTo(l0.x, l0.y);
  ctx.lineTo(l1.x, l1.y);
  ctx.lineTo(r1.x, r1.y);
  ctx.lineTo(r0.x, r0.y);
  ctx.stroke();
  // Side nets.
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 1;
  for (const y of [-GOAL_W / 2, GOAL_W / 2]) {
    const a = P(gx, y, GOAL_H);
    const b2 = P(bx, y, GOAL_H * 0.85);
    const c = P(bx, y, 0);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b2.x, b2.y);
    ctx.lineTo(c.x, c.y);
    ctx.stroke();
  }
}

function drawRadar(ctx: CanvasRenderingContext2D, v: View, g: Game) {
  const small = v.w < 640;
  const w = small ? 92 : 132;
  const h = (w * W) / L;
  const rw = v.portrait ? h : w;
  const rh = v.portrait ? w : h;
  const x0 = v.w / 2 - rw / 2;
  const y0 = v.h - rh - (small ? 10 : 14);
  ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(x0 - 3, y0 - 3, rw + 6, rh + 6);
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x0, y0, rw, rh);
  const map = (x: number, y: number) =>
    v.portrait ? { x: x0 + ((y + W / 2) / W) * rw, y: y0 + ((L / 2 - x) / L) * rh } : { x: x0 + ((x + L / 2) / L) * rw, y: y0 + ((y + W / 2) / W) * rh };
  const mid = map(0, -W / 2);
  const mid2 = map(0, W / 2);
  ctx.beginPath();
  ctx.moveTo(mid.x, mid.y);
  ctx.lineTo(mid2.x, mid2.y);
  ctx.stroke();
  for (const p of g.players) {
    const q = map(p.x, p.y);
    const human = g.ctrls.findIndex((c) => c.active === p.i);
    ctx.fillStyle = human >= 0 ? PAD_COLORS[human % PAD_COLORS.length] : g.clubs[p.team].shirt;
    ctx.beginPath();
    ctx.arc(q.x, q.y, human >= 0 ? 3.2 : 2.3, 0, Math.PI * 2);
    ctx.fill();
  }
  const bq = map(g.ball.x, g.ball.y);
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(bq.x, bq.y, 2, 0, Math.PI * 2);
  ctx.fill();
}

function drawBanner(ctx: CanvasRenderingContext2D, v: View, fx: Fx) {
  const bn = fx.banner;
  if (!bn) return;
  ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
  const t = bn.t;
  const big = bn.text.includes("GOAL") || bn.text === "FULL TIME";
  const pop = Math.min(1, t * 5);
  const scale = big ? 0.6 + pop * 0.4 + Math.max(0, 0.15 - Math.abs(t - 0.25)) : 0.8 + pop * 0.2;
  const size = Math.min(v.w / (bn.text.length * 0.62), big ? 110 : 54) * scale;
  ctx.textAlign = "center";
  ctx.font = `900 italic ${size}px ui-sans-serif, system-ui, sans-serif`;
  const y = v.h * (big ? 0.42 : 0.3);
  ctx.lineWidth = Math.max(4, size * 0.1);
  ctx.strokeStyle = "rgba(0,0,0,0.75)";
  ctx.strokeText(bn.text, v.w / 2, y);
  ctx.fillStyle = bn.color;
  ctx.fillText(bn.text, v.w / 2, y);
  if (bn.sub) {
    ctx.font = `800 ${Math.max(13, size * 0.24)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.lineWidth = 4;
    ctx.strokeText(bn.sub, v.w / 2, y + size * 0.45);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(bn.sub, v.w / 2, y + size * 0.45);
  }
}

/** For the attract screen: a team's direction label. */
export const attacking = (t: 0 | 1) => (attackDir(t) > 0 ? "→" : "←");
export { GOAL_H };
