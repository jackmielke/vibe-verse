/**
 * COIL — the picture.
 *
 * ## The body is one stroke, not four hundred circles
 *
 * The obvious way to draw a snake is a circle per segment. At full length that
 * is four hundred arcs each, thirty snakes, sixty times a second, and it is
 * both slow and worse-looking: consecutive circles alias against each other
 * along the edge.
 *
 * A single `stroke()` of the trail with `lineWidth = 2r`, `lineCap: "round"`
 * and `lineJoin: "round"` produces exactly the same rounded tube in one call,
 * anti-aliased along its whole length, with a clean cap at the tail for free.
 * Three passes give it depth — a dark rim underneath, the body, then a thin
 * off-centre highlight — and that is the entire snake apart from its face.
 *
 * ## The face
 *
 * The head is the character you are wearing, drawn from the shop's own
 * portrait. Two decisions in there worth keeping:
 *
 * - The portrait does **not** rotate with the heading. A face upside down is a
 *   face nobody recognises, and recognising it is the whole point. It flips
 *   horizontally instead, the way a 2D platformer sprite does, so it always
 *   looks the way it is going.
 * - There is a drawn fallback. Sixty-odd characters in this building are GLBs
 *   with no 2D art, and somebody wearing one must still get a head — so they
 *   get a disc in their accent colour with their own emoji on it, which is
 *   legible at any size and never a broken-image box.
 */
import { ARENA_R, DRAW_SPACING, VIEW_MAX, VIEW_MIN, lengthOf, radiusOf } from "./config";
import { lookFor } from "./roster";
import type { CoilSim } from "./sim";
import type { Snake } from "./types";

const TAU = Math.PI * 2;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  r: number;
  color: string;
  ring: boolean;
}

export interface DrawOptions {
  /** 0–1 between the previous and current sim state. */
  alpha: number;
  youId: number;
  focusX: number;
  focusY: number;
  span: number;
  dt: number;
  stick: { ox: number; oy: number; x: number; y: number; active: boolean } | null;
  heading: { dx: number; dy: number; power: number } | null;
  dimmed: boolean;
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  w = 0;
  h = 0;

  private camX = 0;
  private camY = 0;
  private camScale = 1;
  private started = false;
  private shake = 0;
  private readonly particles: Particle[] = [];
  private frame = 0;
  fps = 60;

  /**
   * Portraits, decoded once and cached by character id.
   *
   * Loaded lazily: an arena of thirty snakes wants thirty PNGs, and requesting
   * them all on the first frame stalls the boot for a picture of a snake that
   * is currently off screen. `null` means "asked for, not here yet" and draws
   * the fallback, which is why the fallback has to be good rather than a
   * placeholder.
   */
  private readonly portraits = new Map<string, HTMLImageElement | null>();
  private readonly orbSprites: HTMLCanvasElement[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("COIL needs a 2D canvas context, and this browser did not give one");
    this.ctx = ctx;
    this.bakeOrbs();
    this.resize();
  }

  private bakeOrbs(): void {
    const S = 44;
    for (let i = 0; i < 12; i++) {
      const hue = (i / 12) * 360;
      const c = document.createElement("canvas");
      c.width = S;
      c.height = S;
      const g = c.getContext("2d");
      if (!g) continue;
      const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      grad.addColorStop(0, `hsla(${hue}, 100%, 88%, 1)`);
      grad.addColorStop(0.35, `hsla(${hue}, 95%, 66%, 0.95)`);
      grad.addColorStop(0.7, `hsla(${hue}, 90%, 56%, 0.3)`);
      grad.addColorStop(1, `hsla(${hue}, 90%, 50%, 0)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, S, S);
      this.orbSprites.push(c);
    }
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, Math.round(rect.width || window.innerWidth));
    this.h = Math.max(1, Math.round(rect.height || window.innerHeight));
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  dispose(): void {
    this.particles.length = 0;
    this.portraits.clear();
    this.orbSprites.length = 0;
  }

  screenToWorld(px: number, py: number): { x: number; y: number } {
    return {
      x: (px - this.w / 2) / this.camScale + this.camX,
      y: (py - this.h / 2) / this.camScale + this.camY,
    };
  }

  burst(x: number, y: number, color: string, count: number, speed = 120): void {
    for (let i = 0; i < count; i++) {
      if (this.particles.length > 600) break;
      const a = Math.random() * TAU;
      const sp = speed * (0.35 + Math.random());
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0,
        max: 0.35 + Math.random() * 0.45,
        r: 2 + Math.random() * 4,
        color,
        ring: false,
      });
    }
  }

  ring(x: number, y: number, color: string, r: number): void {
    this.particles.push({ x, y, vx: 0, vy: 0, life: 0, max: 0.55, r, color, ring: true });
  }

  jolt(amount: number): void {
    this.shake = Math.min(26, this.shake + amount);
  }

  // -------------------------------------------------------------------------

  draw(sim: CoilSim, o: DrawOptions): void {
    const ctx = this.ctx;
    const dt = Math.min(0.05, o.dt);
    this.frame++;
    if (dt > 0) this.fps += (1 / dt - this.fps) * 0.06;

    const span = Math.max(VIEW_MIN, Math.min(VIEW_MAX, o.span));
    // Fit by area rather than by the short side — on a portrait phone `min`
    // spends the whole span horizontally and stretches the view vertically to
    // nearly three times it. Same reasoning as BLOB's camera.
    const targetScale = Math.sqrt(this.w * this.h) / 2 / span;
    if (!this.started) {
      this.camX = o.focusX;
      this.camY = o.focusY;
      this.camScale = targetScale;
      this.started = true;
    } else {
      const kPos = 1 - Math.exp(-12 * dt);
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
    const toX = (x: number) => (x - cx) * scale + this.w / 2;
    const toY = (y: number) => (y - cy) * scale + this.h / 2;
    const halfW = this.w / 2 / scale;
    const halfH = this.h / 2 / scale;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawBackground(ctx);
    this.drawGrid(ctx, cx, cy, scale);
    this.drawArena(ctx, toX, toY, scale);
    this.drawOrbs(sim, ctx, toX, toY, scale, cx, cy, halfW, halfH);

    // Longest last, so the leader is drawn over the crowd rather than under it.
    const order = sim.snakes.filter((s) => s.alive).sort((a, b) => a.score - b.score);
    for (const s of order) this.drawSnake(sim, s, ctx, toX, toY, scale, cx, cy, halfW, halfH, o);

    this.drawParticles(ctx, toX, toY, scale, dt);
    this.drawVignette(ctx, o.dimmed);
    this.drawMinimap(sim, ctx, o.youId);
    if (o.heading && o.heading.power > 0 && !(o.stick && o.stick.active)) {
      const you = sim.snakes[o.youId];
      const at =
        you && you.alive
          ? { x: toX(you.body.headX), y: toY(you.body.headY), r: radiusOf(you.score) * scale }
          : { x: this.w / 2, y: this.h / 2, r: 26 };
      this.drawHeading(ctx, o.heading, at);
    }
    if (o.stick) this.drawStick(ctx, o.stick);
  }

  // -------------------------------------------------------------------------

  private drawBackground(ctx: CanvasRenderingContext2D): void {
    const g = ctx.createLinearGradient(0, 0, 0, this.h);
    g.addColorStop(0, "#0a0714");
    g.addColorStop(0.55, "#0d0a1c");
    g.addColorStop(1, "#070512");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  private drawGrid(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    scale: number,
  ): void {
    let step = 64;
    while (step * scale < 34) step *= 2;
    const alpha = Math.min(0.5, Math.max(0.1, step * scale * 0.007));
    ctx.strokeStyle = `rgba(170, 130, 245, ${alpha * 0.24})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const left = cx - this.w / 2 / scale;
    const top = cy - this.h / 2 / scale;
    for (let x = Math.floor(left / step) * step; x < left + this.w / scale + step; x += step) {
      const px = Math.round((x - cx) * scale + this.w / 2) + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, this.h);
    }
    for (let y = Math.floor(top / step) * step; y < top + this.h / scale + step; y += step) {
      const py = Math.round((y - cy) * scale + this.h / 2) + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(this.w, py);
    }
    ctx.stroke();
  }

  /** The wall: a bright ring, with everything past it dimmed so the edge reads
   *  as an edge rather than as the end of the texture. It kills on contact, and
   *  it has to look like it. */
  private drawArena(
    ctx: CanvasRenderingContext2D,
    toX: (x: number) => number,
    toY: (y: number) => number,
    scale: number,
  ): void {
    const x = toX(0);
    const y = toY(0);
    const r = ARENA_R * scale;
    ctx.save();
    // Outside the ring, dark. One even-odd fill rather than four rectangles,
    // because the shape is a disc.
    ctx.beginPath();
    ctx.rect(0, 0, this.w, this.h);
    ctx.arc(x, y, r, 0, TAU, true);
    ctx.fillStyle = "rgba(3, 2, 10, 0.72)";
    ctx.fill("evenodd");

    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.strokeStyle = "rgba(255, 106, 213, 0.55)";
    ctx.lineWidth = 3;
    ctx.shadowColor = "rgba(255, 106, 213, 0.6)";
    ctx.shadowBlur = 24;
    ctx.stroke();
    ctx.restore();
  }

  private drawOrbs(
    sim: CoilSim,
    ctx: CanvasRenderingContext2D,
    toX: (x: number) => number,
    toY: (y: number) => number,
    scale: number,
    cx: number,
    cy: number,
    halfW: number,
    halfH: number,
  ): void {
    const t = sim.time;
    for (const o of sim.orbs) {
      if (Math.abs(o.x - cx) > halfW + 30 || Math.abs(o.y - cy) > halfH + 30) continue;
      const pulse = 1 + Math.sin(t * 2.4 + o.phase) * 0.14;
      const rad = o.r * pulse * 2.3 * scale;
      const sprite = this.orbSprites[((o.hue / 360) * 12) | 0] ?? this.orbSprites[0];
      if (!sprite) continue;
      ctx.drawImage(sprite, toX(o.x) - rad, toY(o.y) - rad, rad * 2, rad * 2);
    }
  }

  // -------------------------------------------------------------------------

  private drawSnake(
    sim: CoilSim,
    s: Snake,
    ctx: CanvasRenderingContext2D,
    toX: (x: number) => number,
    toY: (y: number) => number,
    scale: number,
    cx: number,
    cy: number,
    halfW: number,
    halfH: number,
    o: DrawOptions,
  ): void {
    const r = radiusOf(s.score);
    const len = lengthOf(s.score);
    const mine = s.id === o.youId;

    // Gather the trail as screen points, culling anything well off screen. The
    // cull is generous because a body that crosses the view has to be drawn
    // even when both of its ends are outside it.
    const pts: number[] = [];
    let visible = false;
    const margin = r + 80;
    s.body.walk(Math.max(4, r * DRAW_SPACING), len, (x, y) => {
      pts.push(toX(x), toY(y));
      if (!visible && Math.abs(x - cx) < halfW + margin && Math.abs(y - cy) < halfH + margin) {
        visible = true;
      }
    });
    if (!visible || pts.length < 4) return;

    const w = r * 2 * scale;
    const trace = () => {
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    };

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Rim, body, highlight. Three strokes of one path is the whole snake.
    trace();
    ctx.lineWidth = w + Math.max(2, w * 0.14);
    ctx.strokeStyle = this.shade(s.color, -0.55);
    ctx.stroke();

    if (mine || s.boosting) {
      ctx.shadowColor = s.color;
      ctx.shadowBlur = Math.min(30, w * 0.7);
    }
    ctx.lineWidth = w;
    ctx.strokeStyle = s.color;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // The highlight runs slightly narrower and is what stops the body reading
    // as a flat noodle. Boosting brightens it, which is the tell that somebody
    // is spending score to come at you.
    ctx.lineWidth = Math.max(1, w * 0.3);
    ctx.strokeStyle = this.shade(s.color, s.boosting ? 0.75 : 0.42);
    ctx.globalAlpha = s.boosting ? 0.9 : 0.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();

    this.drawHead(s, ctx, pts[0], pts[1], r * scale, mine);

    // Name, above the head, once it is big enough to be worth reading.
    const hr = r * scale;
    if (hr > 9) {
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const size = Math.max(10, Math.min(30, hr * 0.72));
      ctx.font = `800 ${size}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
      ctx.lineJoin = "round";
      ctx.lineWidth = Math.max(2, size * 0.24);
      ctx.strokeStyle = "rgba(4, 3, 12, 0.75)";
      ctx.fillStyle = mine ? "#ffffff" : "rgba(255,255,255,0.9)";
      const label = `${s.name} · ${Math.round(s.score)}`;
      ctx.strokeText(label, pts[0], pts[1] - hr - size * 0.75);
      ctx.fillText(label, pts[0], pts[1] - hr - size * 0.75);
      ctx.restore();
    }
  }

  /**
   * The character on the front.
   *
   * A disc in the snake's colour, then the portrait on top of it, upright and
   * flipped to face the way it is going. The disc matters: portraits are
   * transparent renders with a lot of empty corner, and without something
   * behind them a head reads as a floating sticker rather than the end of the
   * snake.
   */
  private drawHead(
    s: Snake,
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    mine: boolean,
  ): void {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r * 1.12, 0, TAU);
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r * 1.12);
    g.addColorStop(0, this.shade(s.color, 0.55));
    g.addColorStop(1, this.shade(s.color, -0.15));
    ctx.fillStyle = g;
    if (mine) {
      ctx.shadowColor = s.color;
      ctx.shadowBlur = Math.min(34, r);
    }
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = Math.max(1.5, r * 0.1);
    ctx.strokeStyle = this.shade(s.color, -0.6);
    ctx.stroke();

    const img = this.portrait(s.charId);
    // Below about this size a face is three pixels of mud; the disc alone reads
    // better, and there are thirty of them on screen.
    if (img && img.complete && img.naturalWidth > 0 && r > 7) {
      const size = r * 2.5;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r * 1.12, 0, TAU);
      ctx.clip();
      ctx.translate(x, y);
      // Face the way it is going, without ever going upside down.
      if (Math.cos(s.angle) < 0) ctx.scale(-1, 1);
      ctx.drawImage(img, -size / 2, -size * 0.56, size, size);
      ctx.restore();
    } else if (r > 7) {
      // No portrait for this character — its own emoji, which every character
      // in the building has.
      ctx.font = `${r * 1.25}px ui-sans-serif, system-ui, "Apple Color Emoji", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(lookFor(s.charId).emoji, x, y + r * 0.06);
    }
    ctx.restore();
  }

  /** Fetch a portrait, starting the load the first time it is asked for. */
  private portrait(charId: string): HTMLImageElement | null {
    const had = this.portraits.get(charId);
    if (had !== undefined) return had;
    const url = lookFor(charId).art;
    if (!url) {
      this.portraits.set(charId, null);
      return null;
    }
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    this.portraits.set(charId, img);
    return img;
  }

  // -------------------------------------------------------------------------

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
        this.particles[i] = this.particles[this.particles.length - 1];
        this.particles.pop();
        continue;
      }
      const t = p.life / p.max;
      ctx.globalAlpha = 1 - t;
      if (p.ring) {
        ctx.beginPath();
        ctx.arc(toX(p.x), toY(p.y), p.r * (0.6 + t * 1.6) * scale, 0, TAU);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(1, 3 * (1 - t));
        ctx.stroke();
      } else {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= damp;
        p.vy *= damp;
        ctx.beginPath();
        ctx.arc(toX(p.x), toY(p.y), Math.max(0.6, p.r * (1 - t) * scale), 0, TAU);
        ctx.fillStyle = p.color;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
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
      ctx.fillStyle = "rgba(7, 5, 18, 0.35)";
      ctx.fillRect(0, 0, this.w, this.h);
    }
  }

  /** The arena, you, and the four longest. A minimap with every snake on it is
   *  a screensaver in the corner; five dots is a decision about which way to
   *  go. */
  private drawMinimap(sim: CoilSim, ctx: CanvasRenderingContext2D, youId: number): void {
    const size = Math.min(140, Math.max(84, Math.min(this.w, this.h) * 0.18));
    const pad = 16;
    const x0 = pad;
    const y0 = this.h - size - pad;
    const c = size / 2;
    const k = size / (ARENA_R * 2);

    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(x0 + c, y0 + c, c, 0, TAU);
    ctx.fillStyle = "rgba(6, 4, 16, 0.62)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 106, 213, 0.28)";
    ctx.lineWidth = 1;
    ctx.stroke();

    for (const s of sim.standings(5)) {
      if (s.id === youId) continue;
      const snake = sim.snakes[s.id];
      ctx.beginPath();
      ctx.arc(x0 + c + snake.body.headX * k, y0 + c + snake.body.headY * k, 2.5, 0, TAU);
      ctx.fillStyle = s.color;
      ctx.fill();
    }
    const you = sim.snakes[youId];
    if (you && you.alive) {
      ctx.beginPath();
      ctx.arc(x0 + c + you.body.headX * k, y0 + c + you.body.headY * k, 4, 0, TAU);
      ctx.fillStyle = "#ffffff";
      ctx.shadowColor = you.color;
      ctx.shadowBlur = 8;
      ctx.fill();
    }
    ctx.restore();
  }

  private drawHeading(
    ctx: CanvasRenderingContext2D,
    h: { dx: number; dy: number; power: number },
    at: { x: number; y: number; r: number },
  ): void {
    const gap = at.r + 22;
    const x = at.x + h.dx * gap;
    const y = at.y + h.dy * gap;
    const size = 9 + h.power * 7;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.atan2(h.dy, h.dx));
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
    ctx.restore();
  }

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

  /** Lighten (positive) or darken (negative) a hex colour. Characters carry
   *  one accent each, and a body needs three tones of it. */
  private shade(hex: string, amount: number): string {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    const mix = (c: number) =>
      Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount));
    const r = mix((n >> 16) & 255);
    const g = mix((n >> 8) & 255);
    const b = mix(n & 255);
    return `rgb(${r}, ${g}, ${b})`;
  }
}
