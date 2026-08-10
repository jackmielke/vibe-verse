/**
 * BLOB — the picture.
 *
 * Canvas 2D, deliberately. This is a game of a few hundred filled circles; WebGL
 * would be faster at ten thousand and slower to write, slower to read, and a
 * second live GL context in a building that already caps out browsers' WebGL
 * budget with worlds that genuinely need it. Everything here is chosen to keep
 * a phone at sixty frames:
 *
 * - Pellets are drawn from a pre-rendered sprite atlas — twelve hue buckets,
 *   one radial gradient each, baked once — instead of a thousand live
 *   gradients a frame. This is the single biggest win in the file.
 * - Nothing outside the viewport is drawn, and the wobble simulation is skipped
 *   entirely for anything smaller than a few pixels on screen.
 * - Cells and viruses are drawn in one list sorted by mass, which gets the
 *   depth ordering of the genre for free: a small cell tucks *under* a virus,
 *   a big one looms over it, and that is the whole tell for "am I safe here".
 *
 * ## The membrane
 *
 * The thing that makes a blob read as alive is that its edge is not a circle.
 * Each cell carries a ring of radial offsets on springs, coupled to their
 * neighbours; eating kicks one inwards, a split kicks the whole ring, and the
 * coupling spreads the dent around the rim like a ripple in a water balloon.
 * It is about fifteen lines of physics and it is most of the character in the
 * game.
 */
import { VIEW_MAX, VIEW_MIN, WORLD, radiusOf } from "./config";
import type { BlobSim } from "./sim";
import type { Cell, Virus } from "./types";

const TAU = Math.PI * 2;
/** Points around a membrane. Enough to ripple, few enough to be free. */
const RIM = 22;
/** Screen radius under which a cell is just a circle — nobody can see a wobble
 *  on an eight pixel dot, and there can be four hundred of them. */
const WOBBLE_MIN_PX = 11;

interface Membrane {
  off: Float32Array;
  vel: Float32Array;
  seen: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  r: number;
  hue: number;
  /** Rings expand and fade instead of flying; used for splits and pops. */
  ring: boolean;
}

export interface DrawOptions {
  /** 0–1 between each cell's previous and current position. */
  alpha: number;
  /** Player id whose cells get the extra attention (glow, name always on). */
  youId: number;
  /** Where the camera wants to be, in world space. */
  focusX: number;
  focusY: number;
  /** Half-height of the view in world units, before clamping. */
  span: number;
  /** Seconds of wall clock since the last draw. */
  dt: number;
  /** Joystick to draw, in css pixels, or null on a pointer device. */
  stick: { ox: number; oy: number; x: number; y: number; active: boolean } | null;
  /** The course a phone player is coasting on, drawn when no finger is down so
   *  the heading you set is still visible after you let go. */
  heading: { dx: number; dy: number; power: number } | null;
  /** Dimmed and desaturated while a menu is over the top. */
  dimmed: boolean;
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  /** Canvas size in css pixels. */
  w = 0;
  h = 0;

  /** Camera, smoothed towards the focus rather than snapped to it. */
  private camX = WORLD / 2;
  private camY = WORLD / 2;
  private camScale = 1;
  private started = false;

  private shake = 0;
  private readonly membranes = new Map<number, Membrane>();
  private readonly particles: Particle[] = [];
  private frame = 0;
  private readonly foodSprites: HTMLCanvasElement[] = [];
  /** Rolling average frame cost, surfaced to the HUD so a slow phone is a
   *  visible fact rather than a vague feeling. */
  fps = 60;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("BLOB needs a 2D canvas context, and this browser did not give one");
    this.ctx = ctx;
    this.bakeFood();
    this.resize();
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  /** Twelve pellet sprites, one per hue bucket. Baked once, drawn thousands of
   *  times. A live radial gradient per pellet per frame costs ~4 ms on a phone;
   *  this costs nothing measurable. */
  private bakeFood(): void {
    const S = 48;
    for (let i = 0; i < 12; i++) {
      const hue = (i / 12) * 360;
      const c = document.createElement("canvas");
      c.width = S;
      c.height = S;
      const g = c.getContext("2d");
      if (!g) continue;
      const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      grad.addColorStop(0, `hsla(${hue}, 100%, 82%, 1)`);
      grad.addColorStop(0.42, `hsla(${hue}, 95%, 62%, 0.95)`);
      grad.addColorStop(0.72, `hsla(${hue}, 90%, 52%, 0.28)`);
      grad.addColorStop(1, `hsla(${hue}, 90%, 50%, 0)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, S, S);
      this.foodSprites.push(c);
    }
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    // Cap the device pixel ratio at 2. A 3× phone screen triples the fill cost
    // for a difference nobody can see on a blob with a soft edge.
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, Math.round(rect.width || window.innerWidth));
    this.h = Math.max(1, Math.round(rect.height || window.innerHeight));
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  /** Where a point on the canvas is in the dish. The engine needs this every
   *  frame to turn a cursor into an aim, and the camera lives in here. */
  screenToWorld(px: number, py: number): { x: number; y: number } {
    return {
      x: (px - this.w / 2) / this.camScale + this.camX,
      y: (py - this.h / 2) / this.camScale + this.camY,
    };
  }

  dispose(): void {
    this.membranes.clear();
    this.particles.length = 0;
    this.foodSprites.length = 0;
  }

  // -------------------------------------------------------------------------
  // Things the engine tells the picture about
  // -------------------------------------------------------------------------

  /** A spray of specks, for an eat. */
  burst(x: number, y: number, hue: number, count: number, speed = 90): void {
    for (let i = 0; i < count; i++) {
      if (this.particles.length > 700) break;
      const a = Math.random() * TAU;
      const s = speed * (0.35 + Math.random());
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: 0,
        max: 0.32 + Math.random() * 0.4,
        r: 2 + Math.random() * 4,
        hue,
        ring: false,
      });
    }
  }

  /** An expanding ring, for a split or a pop. */
  ring(x: number, y: number, hue: number, r: number): void {
    this.particles.push({
      x,
      y,
      vx: 0,
      vy: 0,
      life: 0,
      max: 0.5,
      r,
      hue,
      ring: true,
    });
  }

  /** Kick the camera. Used sparingly — a shake on every eat is a headache. */
  jolt(amount: number): void {
    this.shake = Math.min(26, this.shake + amount);
  }

  /** Dent a cell's rim towards a point, so eating visibly deforms you. */
  dent(cell: Cell, x: number, y: number, amount: number): void {
    const m = this.membranes.get(cell.id);
    if (!m) return;
    const a = Math.atan2(y - cell.y, x - cell.x);
    const i = (Math.round((a / TAU) * RIM) + RIM * 2) % RIM;
    m.vel[i] -= amount;
    m.vel[(i + 1) % RIM] -= amount * 0.55;
    m.vel[(i + RIM - 1) % RIM] -= amount * 0.55;
  }

  // -------------------------------------------------------------------------
  // The frame
  // -------------------------------------------------------------------------

  draw(sim: BlobSim, o: DrawOptions): void {
    const ctx = this.ctx;
    const dt = Math.min(0.05, o.dt);
    this.frame++;
    if (dt > 0) this.fps += (1 / dt - this.fps) * 0.06;

    // --- camera ------------------------------------------------------------
    const span = Math.max(VIEW_MIN, Math.min(VIEW_MAX, o.span));
    /* Fit by area, not by the shorter side.
       `min(w, h)` is the obvious choice and it is wrong on a phone: portrait
       makes the *width* the short side, so the span is spent horizontally and
       the vertical view stretches to nearly three times it. The blob ends up
       1.5% of the screen and the dish reads as empty. The geometric mean keeps
       the amount of dish on screen roughly constant whatever the aspect ratio,
       which zooms a portrait phone in by about half and leaves a 16:9 desktop
       where it already was. */
    const targetScale = Math.sqrt(this.w * this.h) / 2 / span;
    if (!this.started) {
      this.camX = o.focusX;
      this.camY = o.focusY;
      this.camScale = targetScale;
      this.started = true;
    } else {
      // Exponential smoothing written frame-rate independently: the same
      // easing at 30 fps and 144 fps, which a naive `+= (t - c) * 0.1` is not.
      const kPos = 1 - Math.exp(-11 * dt);
      const kZoom = 1 - Math.exp(-3.5 * dt);
      this.camX += (o.focusX - this.camX) * kPos;
      this.camY += (o.focusY - this.camY) * kPos;
      this.camScale += (targetScale - this.camScale) * kZoom;
    }
    this.shake *= Math.exp(-7 * dt);
    const sx = this.shake > 0.2 ? (Math.random() - 0.5) * this.shake : 0;
    const sy = this.shake > 0.2 ? (Math.random() - 0.5) * this.shake : 0;

    const scale = this.camScale;
    const cx = this.camX + sx / scale;
    const cy = this.camY + sy / scale;
    // World → screen, in one place: everything below uses these two.
    const toX = (x: number) => (x - cx) * scale + this.w / 2;
    const toY = (y: number) => (y - cy) * scale + this.h / 2;
    // The world rectangle currently on screen, with a margin so a big blob
    // half off the edge still draws its half.
    const halfW = this.w / 2 / scale;
    const halfH = this.h / 2 / scale;
    const viewL = cx - halfW;
    const viewR = cx + halfW;
    const viewT = cy - halfH;
    const viewB = cy + halfH;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    this.drawBackground(ctx);
    this.drawGrid(ctx, cx, cy, scale);
    this.drawBounds(ctx, toX, toY, scale);
    this.drawFood(sim, ctx, toX, toY, scale, viewL, viewR, viewT, viewB);
    this.drawPellets(sim, ctx, toX, toY, scale, viewL, viewR, viewT, viewB);
    this.drawBodies(sim, o, ctx, toX, toY, scale, dt, viewL, viewR, viewT, viewB);
    this.drawParticles(ctx, toX, toY, scale, dt);
    this.drawVignette(ctx, o.dimmed);
    this.drawMinimap(sim, ctx, o.youId);
    if (o.heading && o.heading.power > 0 && !(o.stick && o.stick.active)) {
      // Where the arrow goes is derivable here and nowhere else — it needs the
      // camera, which lives in this file. The engine would have to be handed a
      // scale it has no other use for.
      const you = sim.players[o.youId];
      let ar = 30;
      let ax = this.w / 2;
      let ay = this.h / 2;
      if (you && you.cells.length) {
        const c = sim.centroid(you, o.alpha);
        ax = toX(c.x);
        ay = toY(c.y);
        for (const cell of you.cells) ar = Math.max(ar, cell.r * scale);
      }
      this.drawHeading(ctx, o.heading, { x: ax, y: ay, r: ar });
    }
    if (o.stick) this.drawStick(ctx, o.stick);

    // Membranes for cells that no longer exist would otherwise accumulate for
    // the length of the match. Swept every couple of seconds.
    if (this.frame % 180 === 0) this.sweep();
  }

  // -------------------------------------------------------------------------
  // Layers
  // -------------------------------------------------------------------------

  private drawBackground(ctx: CanvasRenderingContext2D): void {
    const g = ctx.createLinearGradient(0, 0, 0, this.h);
    g.addColorStop(0, "#070c16");
    g.addColorStop(0.55, "#08111f");
    g.addColorStop(1, "#050810");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  private drawGrid(ctx: CanvasRenderingContext2D, cx: number, cy: number, scale: number): void {
    /* Grid spacing steps by powers of two as you zoom out, so the lines stay
       roughly the same distance apart on screen for the whole match instead of
       collapsing into grey mush once you are big. */
    let step = 64;
    while (step * scale < 34) step *= 2;
    const alpha = Math.min(0.5, Math.max(0.1, step * scale * 0.007));
    ctx.strokeStyle = `rgba(120, 170, 230, ${alpha * 0.28})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const left = cx - this.w / 2 / scale;
    const top = cy - this.h / 2 / scale;
    const first = Math.floor(left / step) * step;
    for (let x = first; x < left + this.w / scale + step; x += step) {
      const px = Math.round((x - cx) * scale + this.w / 2) + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, this.h);
    }
    const firstY = Math.floor(top / step) * step;
    for (let y = firstY; y < top + this.h / scale + step; y += step) {
      const py = Math.round((y - cy) * scale + this.h / 2) + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(this.w, py);
    }
    ctx.stroke();
  }

  /** The rim of the dish: a glowing edge, and everything past it goes dark so
   *  the wall reads as a wall rather than as the end of the texture. */
  private drawBounds(
    ctx: CanvasRenderingContext2D,
    toX: (x: number) => number,
    toY: (y: number) => number,
    scale: number,
  ): void {
    const x0 = toX(0);
    const y0 = toY(0);
    const size = WORLD * scale;
    ctx.save();
    ctx.fillStyle = "rgba(2, 4, 10, 0.66)";
    // Four rectangles around the dish rather than one clipped fill: cheaper,
    // and it does not need a path the size of the world.
    if (x0 > 0) ctx.fillRect(0, 0, x0, this.h);
    if (x0 + size < this.w) ctx.fillRect(x0 + size, 0, this.w - (x0 + size), this.h);
    if (y0 > 0) ctx.fillRect(Math.max(0, x0), 0, Math.min(size, this.w), Math.max(0, y0));
    if (y0 + size < this.h) {
      ctx.fillRect(Math.max(0, x0), y0 + size, Math.min(size, this.w), this.h - (y0 + size));
    }
    ctx.strokeStyle = "rgba(94, 240, 168, 0.5)";
    ctx.lineWidth = 3;
    ctx.shadowColor = "rgba(94, 240, 168, 0.55)";
    ctx.shadowBlur = 22;
    ctx.strokeRect(x0, y0, size, size);
    ctx.restore();
  }

  private drawFood(
    sim: BlobSim,
    ctx: CanvasRenderingContext2D,
    toX: (x: number) => number,
    toY: (y: number) => number,
    scale: number,
    l: number,
    r: number,
    t: number,
    b: number,
  ): void {
    const time = sim.time;
    for (const f of sim.food) {
      if (f.x < l - 20 || f.x > r + 20 || f.y < t - 20 || f.y > b + 20) continue;
      // Breathing, out of phase per pellet. Costs one sine and makes a still
      // frame look alive.
      const pulse = 1 + Math.sin(time * 2.2 + f.phase) * 0.13;
      const rad = radiusOf(f.mass) * pulse * 2.6 * scale;
      const sprite = this.foodSprites[((f.hue / 360) * 12) | 0] ?? this.foodSprites[0];
      if (!sprite) continue;
      ctx.drawImage(sprite, toX(f.x) - rad, toY(f.y) - rad, rad * 2, rad * 2);
    }
  }

  private drawPellets(
    sim: BlobSim,
    ctx: CanvasRenderingContext2D,
    toX: (x: number) => number,
    toY: (y: number) => number,
    scale: number,
    l: number,
    r: number,
    t: number,
    b: number,
  ): void {
    for (const p of sim.pellets) {
      if (p.x < l - 40 || p.x > r + 40 || p.y < t - 40 || p.y > b + 40) continue;
      const rad = radiusOf(p.mass) * scale;
      ctx.beginPath();
      ctx.arc(toX(p.x), toY(p.y), rad, 0, TAU);
      ctx.fillStyle = `hsl(${p.hue}, 80%, 62%)`;
      ctx.fill();
      ctx.lineWidth = Math.max(1, rad * 0.16);
      ctx.strokeStyle = `hsl(${p.hue}, 72%, 40%)`;
      ctx.stroke();
    }
  }

  /**
   * Cells and viruses, in one pass, ordered by mass.
   *
   * One list is not a shortcut — it is the rule. In this genre "can I hide
   * behind that virus" is answered by whether you are drawn under it, so the
   * draw order has to be the same comparison the sim makes.
   */
  private drawBodies(
    sim: BlobSim,
    o: DrawOptions,
    ctx: CanvasRenderingContext2D,
    toX: (x: number) => number,
    toY: (y: number) => number,
    scale: number,
    dt: number,
    l: number,
    r: number,
    t: number,
    b: number,
  ): void {
    type Body = { mass: number; cell?: Cell; virus?: Virus };
    const bodies: Body[] = [];
    for (const p of sim.players) {
      for (const c of p.cells) {
        const x = c.px + (c.x - c.px) * o.alpha;
        const y = c.py + (c.y - c.py) * o.alpha;
        if (x + c.r < l || x - c.r > r || y + c.r < t || y - c.r > b) continue;
        bodies.push({ mass: c.mass, cell: c });
      }
    }
    for (const v of sim.viruses) {
      const vr = radiusOf(v.mass);
      if (v.x + vr < l || v.x - vr > r || v.y + vr < t || v.y - vr > b) continue;
      bodies.push({ mass: v.mass, virus: v });
    }
    bodies.sort((a, c) => a.mass - c.mass);

    for (const body of bodies) {
      if (body.virus) this.drawVirus(ctx, body.virus, toX, toY, scale);
      else if (body.cell) this.drawCell(sim, o, ctx, body.cell, toX, toY, scale, dt);
    }
  }

  private drawVirus(
    ctx: CanvasRenderingContext2D,
    v: Virus,
    toX: (x: number) => number,
    toY: (y: number) => number,
    scale: number,
  ): void {
    const x = toX(v.x);
    const y = toY(v.y);
    const rad = radiusOf(v.mass) * scale;
    const spikes = 22;
    ctx.beginPath();
    for (let i = 0; i <= spikes * 2; i++) {
      const a = (i / (spikes * 2)) * TAU + v.spin;
      // Fed viruses bulge: you can see the one that is about to shoot.
      const bulge = 1 + (v.fed / 7) * 0.1;
      const rr = rad * (i % 2 === 0 ? 1 * bulge : 0.845 * bulge);
      const px = x + Math.cos(a) * rr;
      const py = y + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    const g = ctx.createRadialGradient(x - rad * 0.3, y - rad * 0.3, rad * 0.1, x, y, rad);
    g.addColorStop(0, "#7dff9b");
    g.addColorStop(0.6, "#2fce62");
    g.addColorStop(1, "#12a544");
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, rad * 0.07);
    ctx.strokeStyle = "rgba(9, 74, 34, 0.9)";
    ctx.stroke();
  }

  private drawCell(
    sim: BlobSim,
    o: DrawOptions,
    ctx: CanvasRenderingContext2D,
    c: Cell,
    toX: (x: number) => number,
    toY: (y: number) => number,
    scale: number,
    dt: number,
  ): void {
    const owner = sim.players[c.owner];
    const wx = c.px + (c.x - c.px) * o.alpha;
    const wy = c.py + (c.y - c.py) * o.alpha;
    const x = toX(wx);
    const y = toY(wy);
    let rad = c.r * scale;

    // Newborn cells swell into place over a fifth of a second. Without it a
    // split is sixteen blobs appearing out of nothing, which reads as a glitch.
    const age = sim.time - c.bornAt;
    if (age < 0.2) rad *= 0.62 + 0.38 * (age / 0.2);

    const hue = owner ? owner.hue : 200;
    const mine = c.owner === o.youId;

    ctx.save();
    if (mine && rad > 6) {
      ctx.shadowColor = `hsla(${hue}, 95%, 62%, 0.55)`;
      ctx.shadowBlur = Math.min(38, rad * 0.5);
    }

    if (rad >= WOBBLE_MIN_PX) {
      this.membranePath(ctx, c, x, y, rad, dt);
    } else {
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, TAU);
    }

    const g = ctx.createRadialGradient(
      x - rad * 0.32,
      y - rad * 0.36,
      rad * 0.05,
      x,
      y,
      rad * 1.02,
    );
    g.addColorStop(0, `hsl(${hue}, 92%, 74%)`);
    g.addColorStop(0.55, `hsl(${hue}, 86%, 58%)`);
    g.addColorStop(1, `hsl(${hue}, 78%, 44%)`);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = Math.max(1.5, rad * 0.055);
    ctx.strokeStyle = `hsla(${hue}, 70%, ${mine ? 82 : 30}%, ${mine ? 0.85 : 0.75})`;
    ctx.stroke();

    // A crescent of light along the top-left edge. One arc, and it is the
    // difference between a disc and something with a surface.
    if (rad > 14) {
      ctx.beginPath();
      ctx.arc(x, y, rad * 0.78, Math.PI * 0.85, Math.PI * 1.65);
      ctx.lineWidth = Math.max(1, rad * 0.1);
      ctx.strokeStyle = `hsla(${hue}, 100%, 90%, 0.25)`;
      ctx.stroke();
    }
    ctx.restore();

    // --- label -------------------------------------------------------------
    if (rad < 15) return;
    const name = owner ? owner.name : "";
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const size = Math.max(11, Math.min(46, rad * 0.4));
    ctx.font = `800 ${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(2, size * 0.22);
    ctx.strokeStyle = "rgba(4, 8, 16, 0.72)";
    ctx.fillStyle = "rgba(255,255,255,0.96)";
    const showMass = rad > 30;
    const nameY = showMass ? y - size * 0.42 : y;
    ctx.strokeText(name, x, nameY);
    ctx.fillText(name, x, nameY);
    if (showMass) {
      const ms = size * 0.68;
      ctx.font = `700 ${ms}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.lineWidth = Math.max(2, ms * 0.22);
      ctx.strokeText(String(Math.round(c.mass)), x, y + size * 0.6);
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.fillText(String(Math.round(c.mass)), x, y + size * 0.6);
    }
    ctx.restore();
  }

  /**
   * Build the wobbling rim path, stepping its springs on the way.
   *
   * Springs, coupling and damping in one loop: each point is pulled back to the
   * circle, pulled towards the mean of its neighbours (that is what turns a
   * single dent into a travelling ripple) and bled of energy so the whole thing
   * settles instead of ringing forever.
   */
  private membranePath(
    ctx: CanvasRenderingContext2D,
    c: Cell,
    x: number,
    y: number,
    rad: number,
    dt: number,
  ): void {
    let m = this.membranes.get(c.id);
    if (!m) {
      m = { off: new Float32Array(RIM), vel: new Float32Array(RIM), seen: this.frame };
      // A brand new cell starts slightly squashed, so it visibly settles.
      for (let i = 0; i < RIM; i++) m.off[i] = (Math.random() - 0.5) * 0.05;
      this.membranes.set(c.id, m);
    }
    m.seen = this.frame;

    const { off, vel } = m;
    const damp = Math.exp(-5.5 * dt);
    // Idle shimmer, scaled down on big cells: a whale should look ponderous.
    const shimmer = 0.5 / (1 + rad * 0.02);
    for (let i = 0; i < RIM; i++) {
      const prev = off[(i + RIM - 1) % RIM];
      const next = off[(i + 1) % RIM];
      const acc = (prev + next - 2 * off[i]) * 55 - off[i] * 42 + (Math.random() - 0.5) * shimmer;
      vel[i] = (vel[i] + acc * dt) * damp;
      off[i] += vel[i] * dt;
      // Hard clamp: a numerically unlucky frame must never turn a blob inside
      // out, and a rim that can reach -1 is a rim that can.
      if (off[i] > 0.16) off[i] = 0.16;
      else if (off[i] < -0.16) off[i] = -0.16;
    }

    ctx.beginPath();
    let prevX = 0;
    let prevY = 0;
    for (let i = 0; i <= RIM; i++) {
      const idx = i % RIM;
      const a = (idx / RIM) * TAU;
      const rr = rad * (1 + off[idx]);
      const px = x + Math.cos(a) * rr;
      const py = y + Math.sin(a) * rr;
      if (i === 0) {
        prevX = px;
        prevY = py;
        // Start on the midpoint so the closing curve has a partner.
        const lastA = ((RIM - 1) / RIM) * TAU;
        const lr = rad * (1 + off[RIM - 1]);
        ctx.moveTo((x + Math.cos(lastA) * lr + px) / 2, (y + Math.sin(lastA) * lr + py) / 2);
        continue;
      }
      // Quadratic through the midpoints: a closed C1 curve with one control
      // point per rim point, which is as smooth as this needs to be.
      ctx.quadraticCurveTo(prevX, prevY, (prevX + px) / 2, (prevY + py) / 2);
      prevX = px;
      prevY = py;
    }
    ctx.closePath();
  }

  private sweep(): void {
    for (const [id, m] of this.membranes) {
      if (this.frame - m.seen > 240) this.membranes.delete(id);
    }
  }

  private drawParticles(
    ctx: CanvasRenderingContext2D,
    toX: (x: number) => number,
    toY: (y: number) => number,
    scale: number,
    dt: number,
  ): void {
    const damp = Math.exp(-3.2 * dt);
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      if (p.life >= p.max) {
        // Swap-remove: order does not matter and splice on a hot array does.
        this.particles[i] = this.particles[this.particles.length - 1];
        this.particles.pop();
        continue;
      }
      const t = p.life / p.max;
      if (p.ring) {
        ctx.beginPath();
        ctx.arc(toX(p.x), toY(p.y), (p.r * (0.6 + t * 1.5)) * scale, 0, TAU);
        ctx.strokeStyle = `hsla(${p.hue}, 95%, 72%, ${(1 - t) * 0.5})`;
        ctx.lineWidth = Math.max(1, 3 * (1 - t));
        ctx.stroke();
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= damp;
      p.vy *= damp;
      ctx.beginPath();
      ctx.arc(toX(p.x), toY(p.y), Math.max(0.6, p.r * (1 - t) * scale), 0, TAU);
      ctx.fillStyle = `hsla(${p.hue}, 95%, 70%, ${(1 - t) * 0.85})`;
      ctx.fill();
    }
  }

  private drawVignette(ctx: CanvasRenderingContext2D, dimmed: boolean): void {
    const g = ctx.createRadialGradient(
      this.w / 2,
      this.h / 2,
      Math.min(this.w, this.h) * 0.34,
      this.w / 2,
      this.h / 2,
      Math.max(this.w, this.h) * 0.78,
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);
    if (dimmed) {
      // Light: the menu sits on a DOM panel that does the real work of making
      // text legible. Doubling up here only hid the live match, which is the
      // best thing about the title screen.
      ctx.fillStyle = "rgba(5, 9, 18, 0.35)";
      ctx.fillRect(0, 0, this.w, this.h);
    }
  }

  /**
   * The minimap.
   *
   * Only the dish, you, and the four biggest blobs. A minimap with every cell
   * on it is a screensaver in the corner of the screen; four dots is a piece of
   * information — it tells you which quarter of the dish to stay out of.
   */
  private drawMinimap(sim: BlobSim, ctx: CanvasRenderingContext2D, youId: number): void {
    const size = Math.min(148, Math.max(84, Math.min(this.w, this.h) * 0.19));
    const pad = 16;
    const x0 = pad;
    const y0 = this.h - size - pad;
    const k = size / WORLD;

    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = "rgba(4, 9, 18, 0.62)";
    ctx.strokeStyle = "rgba(126, 232, 255, 0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    // `roundRect` is recent enough that a browser without it should still get a
    // minimap rather than an exception.
    if (typeof ctx.roundRect === "function") ctx.roundRect(x0, y0, size, size, 8);
    else ctx.rect(x0, y0, size, size);
    ctx.fill();
    ctx.stroke();

    // Everyone, faintly — the shape of where the dish is busy — with the top
    // five picked out, because those are the ones worth avoiding.
    for (const p of sim.players) {
      if (!p.alive || p.id === youId) continue;
      const c = sim.centroid(p);
      ctx.beginPath();
      ctx.arc(x0 + c.x * k, y0 + c.y * k, 1.6, 0, TAU);
      ctx.fillStyle = `hsla(${p.hue}, 70%, 60%, 0.3)`;
      ctx.fill();
    }
    const top = sim.standings(5);
    for (const s of top) {
      if (s.id === youId) continue;
      const p = sim.players[s.id];
      const c = sim.centroid(p);
      ctx.beginPath();
      ctx.arc(x0 + c.x * k, y0 + c.y * k, 3, 0, TAU);
      ctx.fillStyle = `hsla(${s.hue}, 85%, 62%, 0.9)`;
      ctx.fill();
    }
    const you = sim.players[youId];
    if (you && you.alive) {
      const c = sim.centroid(you);
      ctx.beginPath();
      ctx.arc(x0 + c.x * k, y0 + c.y * k, 4, 0, TAU);
      ctx.fillStyle = "#ffffff";
      ctx.shadowColor = `hsla(${you.hue}, 95%, 65%, 0.9)`;
      ctx.shadowBlur = 8;
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * The course arrow: a chevron sitting just off the blob's nose.
   *
   * On a phone the heading outlives the finger that set it, and a control you
   * cannot see the state of is a control you do not trust. Two strokes are
   * enough — it reads as "this way, this fast" and disappears the moment a
   * thumb comes back down and the stick takes over.
   */
  private drawHeading(
    ctx: CanvasRenderingContext2D,
    h: { dx: number; dy: number; power: number },
    at: { x: number; y: number; r: number },
  ): void {
    const gap = at.r + 20;
    const x = at.x + h.dx * gap;
    const y = at.y + h.dy * gap;
    const a = Math.atan2(h.dy, h.dx);
    const size = 9 + h.power * 7;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.globalAlpha = 0.35 + h.power * 0.45;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(-size * 0.6, -size * 0.7);
    ctx.lineTo(size * 0.55, 0);
    ctx.lineTo(-size * 0.6, size * 0.7);
    ctx.stroke();
    // A second, fainter chevron behind it — motion, without an animation.
    ctx.globalAlpha *= 0.4;
    ctx.beginPath();
    ctx.moveTo(-size * 1.25, -size * 0.55);
    ctx.lineTo(-size * 0.15, 0);
    ctx.lineTo(-size * 1.25, size * 0.55);
    ctx.stroke();
    ctx.restore();
  }

  /** The thumb stick, drawn only when a finger is down. */
  private drawStick(
    ctx: CanvasRenderingContext2D,
    s: { ox: number; oy: number; x: number; y: number; active: boolean },
  ): void {
    if (!s.active) return;
    const dx = s.x - s.ox;
    const dy = s.y - s.oy;
    const d = Math.hypot(dx, dy);
    const max = 62;
    const k = d > max ? max / d : 1;
    ctx.save();
    ctx.beginPath();
    ctx.arc(s.ox, s.oy, max, 0, TAU);
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(s.ox + dx * k, s.oy + dy * k, 24, 0, TAU);
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.stroke();
    ctx.restore();
  }
}
