/**
 * MORT'S MAZE — drawing.
 *
 * Plain 2D canvas. Every character is drawn in code, so there is nothing to
 * load and the whole world is crisp at any size. The hedges are baked once per
 * maze and size into an offscreen canvas, because they never change and a
 * glow is the most expensive thing a 2D canvas can be asked to draw.
 */
import {
  BALLOON, BONUS_TILE, COIN, GATE, MAZE_H, MAZE_W, WALL, type BuiltMaze,
} from "./mazes";
import { CREW, DX, DY, SNACKS, type Chaser, type ChaserId, type Game } from "./game";

const COLORS: Record<ChaserId, string> = Object.fromEntries(
  CREW.map((c) => [c.id, c.color]),
) as Record<ChaserId, string>;

const wallCache = new Map<string, HTMLCanvasElement>();

function bakeWalls(maze: BuiltMaze, cell: number, dpr: number, flash: boolean): HTMLCanvasElement {
  const key = `${maze.def.name}:${cell}:${dpr}:${flash}`;
  const hit = wallCache.get(key);
  if (hit) return hit;
  if (wallCache.size > 12) wallCache.clear();
  const c = document.createElement("canvas");
  c.width = Math.ceil(MAZE_W * cell * dpr);
  c.height = Math.ceil(MAZE_H * cell * dpr);
  const ctx = c.getContext("2d")!;
  ctx.scale(dpr, dpr);
  const isWall = (x: number, y: number) =>
    x >= 0 && x < MAZE_W && y >= 0 && y < MAZE_H && maze.cells[y * MAZE_W + x] === WALL;

  const pass = (width: number, color: string, blur: number) => {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.beginPath();
    for (let y = 0; y < MAZE_H; y++) {
      for (let x = 0; x < MAZE_W; x++) {
        if (!isWall(x, y)) continue;
        const cx = (x + 0.5) * cell;
        const cy = (y + 0.5) * cell;
        let linked = false;
        if (isWall(x + 1, y)) { ctx.moveTo(cx, cy); ctx.lineTo(cx + cell, cy); linked = true; }
        if (isWall(x, y + 1)) { ctx.moveTo(cx, cy); ctx.lineTo(cx, cy + cell); linked = true; }
        if (!linked && !isWall(x - 1, y) && !isWall(x, y - 1)) {
          ctx.moveTo(cx, cy); ctx.lineTo(cx + 0.01, cy);
        }
      }
    }
    ctx.stroke();
    ctx.restore();
  };

  const outer = flash ? "#ffffff" : maze.def.wall;
  pass(cell * 0.56, outer, cell * 0.5);
  pass(cell * 0.34, flash ? "#d9f7ff" : maze.def.wallCore, 0);
  // A thin bright vein down the middle of every hedge.
  pass(cell * 0.06, flash ? "#ffffff" : outer + "88", 0);

  // The junkyard gate.
  for (let y = 0; y < MAZE_H; y++) {
    for (let x = 0; x < MAZE_W; x++) {
      if (maze.cells[y * MAZE_W + x] !== GATE) continue;
      ctx.fillStyle = "#ffd23f";
      ctx.fillRect(x * cell - cell * 0.1, (y + 0.42) * cell, cell * 1.2, cell * 0.16);
      ctx.fillStyle = "#1b1b1b";
      for (let i = 0; i < 4; i++) {
        ctx.fillRect(x * cell + i * cell * 0.3, (y + 0.42) * cell, cell * 0.14, cell * 0.16);
      }
    }
  }
  wallCache.set(key, c);
  return c;
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

/** Vibey: a little round robot with a visor, an antenna and a chomping grin. */
export function drawVibey(
  ctx: CanvasRenderingContext2D, x: number, y: number, r: number,
  dir: number, chomp: number, t: number, dying = 0,
) {
  ctx.save();
  ctx.translate(x, y);
  if (dying > 0) {
    ctx.rotate(dying * Math.PI * 4);
    const s = Math.max(0, 1 - dying);
    ctx.scale(s, s);
  }
  const lookX = dir >= 0 ? DX[dir] * r * 0.18 : 0;
  const lookY = dir >= 0 ? DY[dir] * r * 0.14 : 0;

  // Antenna.
  ctx.strokeStyle = "#9fb4c8";
  ctx.lineWidth = r * 0.12;
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.8);
  ctx.lineTo(r * 0.1, -r * 1.15);
  ctx.stroke();
  ctx.fillStyle = `hsl(${(t * 120) % 360} 100% 65%)`;
  ctx.beginPath();
  ctx.arc(r * 0.1, -r * 1.2, r * 0.16, 0, Math.PI * 2);
  ctx.fill();

  // Body.
  const body = ctx.createRadialGradient(-r * 0.3, -r * 0.4, r * 0.1, 0, 0, r);
  body.addColorStop(0, "#ffffff");
  body.addColorStop(1, "#b9e6ff");
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.92, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#5ab8ff";
  ctx.lineWidth = r * 0.08;
  ctx.stroke();

  // Visor.
  ctx.fillStyle = "#12233a";
  roundRect(ctx, -r * 0.62 + lookX, -r * 0.48 + lookY, r * 1.24, r * 0.5, r * 0.25);
  ctx.fill();
  ctx.fillStyle = "#56f0ff";
  ctx.shadowColor = "#56f0ff";
  ctx.shadowBlur = r * 0.5;
  for (const ex of [-0.28, 0.28]) {
    ctx.beginPath();
    ctx.ellipse(ex * r + lookX * 1.3, -r * 0.23 + lookY, r * 0.12, r * 0.15, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;

  // The chomp: a mouth that opens and shuts as Vibey rolls.
  const open = 0.08 + 0.32 * chomp;
  ctx.fillStyle = "#3a0d2e";
  roundRect(ctx, -r * 0.4 + lookX, r * 0.18 + lookY * 0.5, r * 0.8, r * open, r * 0.12);
  ctx.fill();
  if (open > 0.2) {
    ctx.fillStyle = "#ff6fa8";
    roundRect(ctx, -r * 0.2 + lookX, r * (0.18 + open * 0.55) + lookY * 0.5, r * 0.4, r * open * 0.4, r * 0.1);
    ctx.fill();
  }
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawHat(ctx: CanvasRenderingContext2D, id: ChaserId, r: number, t: number) {
  switch (id) {
    case "mort": {
      // A battered brown cowboy hat.
      ctx.fillStyle = "#7a4a22";
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.72, r * 1.05, r * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
      roundRect(ctx, -r * 0.5, -r * 1.22, r * 1.0, r * 0.55, r * 0.22);
      ctx.fill();
      ctx.fillStyle = "#3d2410";
      ctx.fillRect(-r * 0.5, -r * 0.84, r * 1.0, r * 0.12);
      break;
    }
    case "linda": {
      // A big pile of yellow curls.
      ctx.fillStyle = "#ffe14d";
      for (let i = 0; i < 5; i++) {
        const a = Math.PI + (i / 4) * Math.PI;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * r * 0.62, -r * 0.55 + Math.sin(a) * r * 0.5, r * 0.3, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "hank": {
      // A hubcap, spinning a little.
      ctx.save();
      ctx.translate(0, -r * 0.95);
      ctx.fillStyle = "#cfd8e3";
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.75, r * 0.26, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#7d8a99";
      ctx.lineWidth = r * 0.07;
      for (let i = 0; i < 5; i++) {
        const a = t * 3 + (i / 5) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a) * r * 0.7, Math.sin(a) * r * 0.24);
        ctx.stroke();
      }
      ctx.restore();
      break;
    }
    case "ray": {
      // A traffic cone.
      ctx.fillStyle = "#ff7a1a";
      ctx.beginPath();
      ctx.moveTo(-r * 0.42, -r * 0.7);
      ctx.lineTo(r * 0.42, -r * 0.7);
      ctx.lineTo(0, -r * 1.55);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(-r * 0.24, -r * 1.08, r * 0.48, r * 0.14);
      break;
    }
  }
}

/** A chaser: a stout little body on two wheels, with a hat. */
export function drawChaser(
  ctx: CanvasRenderingContext2D, c: Pick<Chaser, "id" | "mode" | "dir">,
  x: number, y: number, r: number, t: number, powerLeft: number,
) {
  ctx.save();
  ctx.translate(x, y);
  const lookX = c.dir >= 0 ? DX[c.dir] * r * 0.16 : 0;
  const lookY = c.dir >= 0 ? DY[c.dir] * r * 0.14 : 0;

  if (c.mode === "eyes") {
    // Just the eyes and the hat, dripping home.
    ctx.globalAlpha = 0.9;
    drawEyes(ctx, r, lookX, lookY, false);
    ctx.globalAlpha = 0.6;
    drawHat(ctx, c.id, r, t);
    ctx.restore();
    return;
  }

  const soaked = c.mode === "soaked";
  const blink = soaked && powerLeft < 2 && Math.floor(t * 6) % 2 === 0;
  const color = soaked ? (blink ? "#f4f8ff" : "#4d7dff") : COLORS[c.id];
  const wobble = soaked ? Math.sin(t * 14) * r * 0.05 : 0;

  // Wheels.
  ctx.fillStyle = "#14141c";
  for (const wx of [-0.5, 0.5]) {
    ctx.beginPath();
    ctx.arc(wx * r, r * 0.72, r * 0.24, 0, Math.PI * 2);
    ctx.fill();
  }

  // Body: rounded on top, flat at the bottom.
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = r * 0.6;
  ctx.beginPath();
  ctx.moveTo(-r * 0.9 + wobble, r * 0.65);
  ctx.lineTo(-r * 0.9 - wobble, -r * 0.05);
  ctx.quadraticCurveTo(-r * 0.9, -r * 0.88, 0, -r * 0.9);
  ctx.quadraticCurveTo(r * 0.9, -r * 0.88, r * 0.9 + wobble, -r * 0.05);
  ctx.lineTo(r * 0.9 - wobble, r * 0.65);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;

  if (soaked) {
    // Drips.
    ctx.fillStyle = "#bfe3ff";
    for (let i = 0; i < 3; i++) {
      const phase = (t * 1.8 + i * 0.33) % 1;
      ctx.beginPath();
      ctx.arc((i - 1) * r * 0.55, r * 0.7 + phase * r * 0.6, r * 0.09 * (1 - phase), 0, Math.PI * 2);
      ctx.fill();
    }
    // Worried face.
    ctx.fillStyle = blink ? "#ff4d5e" : "#ffffff";
    for (const ex of [-0.3, 0.3]) {
      ctx.beginPath();
      ctx.arc(ex * r, -r * 0.2, r * 0.11, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = blink ? "#ff4d5e" : "#ffffff";
    ctx.lineWidth = r * 0.09;
    ctx.beginPath();
    for (let i = 0; i <= 6; i++) {
      const px = -r * 0.45 + (i / 6) * r * 0.9;
      const py = r * 0.25 + (i % 2 ? -1 : 1) * r * 0.07;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  } else {
    drawEyes(ctx, r, lookX, lookY, true);
    if (c.id === "mort") {
      // That mustache.
      ctx.fillStyle = "#f2f2f2";
      ctx.beginPath();
      ctx.ellipse(-r * 0.25, r * 0.22, r * 0.3, r * 0.12, -0.3, 0, Math.PI * 2);
      ctx.ellipse(r * 0.25, r * 0.22, r * 0.3, r * 0.12, 0.3, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.lineWidth = r * 0.09;
      ctx.beginPath();
      ctx.moveTo(-r * 0.25, r * 0.3);
      ctx.lineTo(r * 0.25, r * 0.24);
      ctx.stroke();
    }
  }
  drawHat(ctx, c.id, r, t);
  ctx.restore();
}

function drawEyes(ctx: CanvasRenderingContext2D, r: number, lx: number, ly: number, angry: boolean) {
  for (const ex of [-0.32, 0.32]) {
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.ellipse(ex * r + lx * 0.4, -r * 0.2 + ly * 0.4, r * 0.22, r * 0.26, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1a2340";
    ctx.beginPath();
    ctx.arc(ex * r + lx, -r * 0.18 + ly, r * 0.11, 0, Math.PI * 2);
    ctx.fill();
  }
  if (angry) {
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.lineWidth = r * 0.1;
    ctx.beginPath();
    ctx.moveTo(-r * 0.55, -r * 0.5);
    ctx.lineTo(-r * 0.12, -r * 0.38);
    ctx.moveTo(r * 0.55, -r * 0.5);
    ctx.lineTo(r * 0.12, -r * 0.38);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

export interface View {
  /** CSS pixels per tile. */
  cell: number;
  dpr: number;
  /** CSS size of the canvas. */
  width: number;
  height: number;
}

export function fitView(width: number, height: number, dpr: number): View {
  const cell = Math.max(8, Math.floor(Math.min(width / MAZE_W, height / MAZE_H)));
  return { cell, dpr, width: cell * MAZE_W, height: cell * MAZE_H };
}

export function drawFrame(ctx: CanvasRenderingContext2D, g: Game, v: View) {
  const { cell, dpr } = v;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, v.width, v.height);

  // Night sea floor, with a slow shimmer.
  const bg = ctx.createLinearGradient(0, 0, 0, v.height);
  bg.addColorStop(0, "#081a33");
  bg.addColorStop(1, "#04101f");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, v.width, v.height);

  const flash = g.phase === "clear" && Math.floor(g.phaseT * 5) % 2 === 1;
  ctx.drawImage(bakeWalls(g.maze, cell, dpr, flash), 0, 0, v.width, v.height);

  // Coins and balloons.
  const t = g.time;
  for (let y = 0; y < MAZE_H; y++) {
    for (let x = 0; x < MAZE_W; x++) {
      const item = g.items[y * MAZE_W + x];
      if (!item) continue;
      const cx = (x + 0.5) * cell;
      const cy = (y + 0.5) * cell;
      if (item === COIN) {
        ctx.fillStyle = "#ffc93c";
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.13, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff4c2";
        ctx.beginPath();
        ctx.arc(cx - cell * 0.04, cy - cell * 0.04, cell * 0.045, 0, Math.PI * 2);
        ctx.fill();
      } else if (item === BALLOON) {
        const s = 1 + Math.sin(t * 6 + x) * 0.08;
        const r = cell * 0.34 * s;
        ctx.save();
        ctx.shadowColor = "#5cc8ff";
        ctx.shadowBlur = cell * 0.6;
        ctx.fillStyle = "#3aa8ff";
        ctx.beginPath();
        ctx.ellipse(cx, cy - r * 0.1, r * 0.85, r, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = "#3aa8ff";
        ctx.beginPath();
        ctx.moveTo(cx, cy + r * 0.85);
        ctx.lineTo(cx - r * 0.2, cy + r * 1.1);
        ctx.lineTo(cx + r * 0.2, cy + r * 1.1);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.75)";
        ctx.beginPath();
        ctx.ellipse(cx - r * 0.3, cy - r * 0.4, r * 0.16, r * 0.26, -0.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Bonus snack.
  if (g.bonus && (g.bonus.t > 2 || Math.floor(t * 8) % 2 === 0)) {
    const snack = SNACKS[g.bonus.snack];
    ctx.font = `${Math.round(cell * 0.95)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(snack.emoji, (BONUS_TILE.x + 0.5) * cell, (BONUS_TILE.y + 0.5) * cell + Math.sin(t * 4) * cell * 0.06);
  }

  // Clip the actors to the board so the tunnel swallows them.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, v.width, v.height);
  ctx.clip();

  const p = g.player;
  const chomp = g.phase === "play" && p.moving ? (Math.sin(p.odometer * Math.PI * 2) + 1) / 2 : 0.2;
  const drawAt = (x: number, y: number, fn: (px: number, py: number) => void) => {
    fn((x + 0.5) * cell, (y + 0.5) * cell);
    // Half in the tunnel: draw the other half on the far side too.
    if (x < 0.5) fn((x + MAZE_W + 0.5) * cell, (y + 0.5) * cell);
    if (x > MAZE_W - 1.5) fn((x - MAZE_W + 0.5) * cell, (y + 0.5) * cell);
  };

  if (g.phase !== "over") {
    const showCrew = g.phase !== "dying" || g.phaseT < 0.3;
    if (showCrew) {
      for (const c of g.chasers) {
        const bob = c.mode === "pen" ? Math.sin(t * 5 + c.home.x) * 0.18 : 0;
        drawAt(c.x, c.y + bob, (px, py) => drawChaser(ctx, c, px, py, cell * 0.44, t, g.powerT));
      }
    }
    const dying = g.phase === "dying" ? Math.min(1, g.phaseT / 1.2) : 0;
    drawAt(p.x, p.y, (px, py) => drawVibey(ctx, px, py, cell * 0.46, p.dir, chomp, t, dying));
  }
  ctx.restore();

  // Points floating up.
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `800 ${Math.round(cell * 0.6)}px system-ui, sans-serif`;
  for (const pop of g.popups) {
    ctx.globalAlpha = Math.min(1, pop.t * 2);
    ctx.fillStyle = "#7ef9ff";
    ctx.fillText(pop.text, (pop.x + 0.5) * cell, (pop.y + 0.5 - (1.2 - pop.t) * 0.6) * cell);
  }
  ctx.globalAlpha = 1;

  // READY banner, in the gap under the pen.
  if (g.phase === "ready") {
    ctx.font = `900 ${Math.round(cell * 0.8)}px system-ui, sans-serif`;
    ctx.fillStyle = "#ffd23f";
    ctx.shadowColor = "#ffd23f";
    ctx.shadowBlur = cell * 0.5;
    const word = g.phaseT < 1.5 ? "READY?" : "GO!";
    ctx.fillText(word, (MAZE_W / 2) * cell, (BONUS_TILE.y + 0.5) * cell);
    ctx.shadowBlur = 0;
  }
}
