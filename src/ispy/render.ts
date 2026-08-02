/**
 * I SPY — the renderer.
 *
 * Plain 2D canvas. The single most important rule in this file is that it is
 * never told whether an object is real: `drawObject` draws a decoy spike with
 * exactly the code that draws a lethal one. The moment those two paths differ
 * by a pixel the level stops being I Spy and becomes a normal level with a lot
 * of clutter in it.
 *
 * The one exception is the spy pulse, and it is deliberate: for a second and a
 * half after you spend one, the lie is drawn as a lie.
 */
import type { Level, Obj, PlayerState, Section } from "./types";

/** How many blocks of world fit vertically in the play band. */
export const VIEW_H = 15;
/** Where the player sits across the screen, 0 = left edge. */
export const PLAYER_SCREEN_X = 0.3;
/**
 * Narrowest the play band is ever allowed to get, width ÷ height.
 *
 * A portrait phone is about 0.46 wide, and at that shape fifteen blocks of
 * height leaves seven blocks of *width* — four of them ahead of the player,
 * which is 0.4 seconds of warning at 1×. That is not a hard level, it is a
 * broken one. So on a tall screen the world is letterboxed into a band of at
 * least this aspect and the bars become where the HUD lives.
 */
const MIN_ASPECT = 1.62;

export interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; max: number; size: number; color: string;
}

export interface RenderState {
  player: PlayerState;
  camX: number;
  camY: number;
  /** Seconds since the attempt began. */
  time: number;
  /** 0..1 within the current beat, for the strobe. */
  beat: number;
  particles: Particle[];
  /** Seconds since the last spy pulse, or null. */
  pulseAge: number | null;
  dead: boolean;
  deathAge: number;
  /** 0..1 — decays after a death. Knocks the camera about for a moment. */
  shake: number;
  /** How many checkpoints the run has banked; earlier ones draw lit. */
  banked: number;
  /** x of every coin already taken this attempt. */
  collected: Set<number>;
  /** 0..1, dims everything for the menu. */
  dim: number;
}

function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function pad2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

/**
 * Blend two colours. Returns `#rrggbb`, and that matters more than it looks:
 * every other helper in this file parses its input with `hex`, so a `mix`
 * that returned `rgb(…)` poisoned anything downstream of it with NaN. The
 * palette cross-fade at each section seam runs its colours through `mix`,
 * which meant that for fourteen blocks either side of all six seams the level
 * was drawing with invalid colours — the one place the game looked broken.
 */
function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hex(a);
  const [r2, g2, b2] = hex(b);
  const k = Math.max(0, Math.min(1, t));
  return `#${pad2(r1 + (r2 - r1) * k)}${pad2(g1 + (g2 - g1) * k)}${pad2(b1 + (b2 - b1) * k)}`;
}

function rgba(c: string, a: number): string {
  const [r, g, b] = hex(c);
  return `rgba(${r},${g},${b},${a})`;
}

/** Perceived brightness, 0..1. */
function luma(c: string): number {
  const [r, g, b] = hex(c);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * The outline colour for a section, computed rather than authored.
 *
 * Every edge in the level used to be stroked in the section's accent, which
 * is fine on the black sections and invisible in the strobe — yellow on
 * yellow. So: measure what is actually behind the object and stroke against
 * it. A bright section gets ink, a dark one gets its accent.
 */
/**
 * The inner wedge every spike carries. Computed from the spike's own fill so
 * the two tones always separate: in the dark sections the hazard is white and
 * the core is the accent, and in the strobe the hazard is red and the core has
 * to go lighter instead. Authoring it per section got it wrong every time a
 * palette changed.
 */
function coreFor(hazard: string, accent: string): string {
  return Math.abs(luma(hazard) - luma(accent)) > 0.22
    ? accent
    : mix(hazard, luma(hazard) > 0.55 ? "#000000" : "#ffffff", 0.55);
}

function inkFor(pal: Section): string {
  const bright = (luma(pal.bg[0]) + luma(pal.bg[1])) / 2;
  return bright > 0.5 ? mix(pal.bg[1], "#000000", 0.82) : pal.accent;
}

/** The palette at x, cross-faded across the seam so sections bleed into
    each other instead of cutting — the level is one continuous strobe. */
export function paletteAt(level: Level, x: number): Section {
  const FADE = 14;
  let i = 0;
  for (let k = 0; k < level.sections.length; k++) if (level.sections[k].x <= x) i = k;
  const cur = level.sections[i];
  const next = level.sections[i + 1];
  if (!next || x < next.x - FADE) return cur;
  const t = (x - (next.x - FADE)) / FADE;
  return {
    ...cur,
    bg: [mix(cur.bg[0], next.bg[0], t), mix(cur.bg[1], next.bg[1], t)] as [string, string],
    solid: mix(cur.solid, next.solid, t),
    hazard: mix(cur.hazard, next.hazard, t),
    accent: mix(cur.accent, next.accent, t),
    ground: mix(cur.ground, next.ground, t),
    strobe: cur.strobe + (next.strobe - cur.strobe) * t,
  };
}

/** Objects sorted by x, plus the handful of very wide ones (roofs, tunnels)
    that have to be considered on every frame no matter where the camera is. */
export class DrawIndex {
  private readonly sorted: Obj[];
  private readonly wide: Obj[];

  constructor(objects: Obj[]) {
    this.wide = objects.filter((o) => o.w > 8);
    this.sorted = objects.filter((o) => o.w <= 8).sort((a, b) => a.x - b.x);
  }

  inView(x0: number, x1: number): Obj[] {
    let lo = 0;
    let hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.sorted[mid].x < x0 - 8) lo = mid + 1;
      else hi = mid;
    }
    const out: Obj[] = [];
    for (const o of this.wide) if (o.x < x1 && o.x + o.w > x0) out.push(o);
    for (let i = lo; i < this.sorted.length && this.sorted[i].x <= x1; i++) out.push(this.sorted[i]);
    return out;
  }
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly index: DrawIndex;
  dpr = 1;
  width = 0;
  height = 0;
  /** Top edge and height of the play band. Equal to the canvas on desktop. */
  bandY = 0;
  bandH = 0;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly level: Level) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("I Spy needs a 2D canvas context");
    this.ctx = ctx;
    this.index = new DrawIndex(level.objects);
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.dpr = dpr;
    this.width = w;
    this.height = h;
    this.bandH = Math.min(h, w / MIN_ASPECT);
    // Sat a little above centre: the action lives on the ground, and the eye
    // wants more room above the player than below them.
    this.bandY = (h - this.bandH) * 0.42;
  }

  /** Pixels per block. */
  get scale(): number {
    return this.bandH / VIEW_H;
  }

  draw(s: RenderState) {
    const { ctx } = this;
    const S = this.scale;
    const top = this.bandY;
    const bottom = this.bandY + this.bandH;
    const bandH = this.bandH;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    const pal = paletteAt(this.level, s.player.x);
    const ink = inkFor(pal);
    // Beat pulse: a hard flash on the downbeat, decaying over the beat.
    const pulse = Math.pow(1 - s.beat, 2.2) * pal.strobe;

    // Letterbox. Painted from the palette rather than left black, so a phone
    // reads as a widescreen game and not as a broken layout.
    if (bandH < this.height) {
      ctx.fillStyle = mix(pal.bg[1], "#000000", 0.72);
      ctx.fillRect(0, 0, this.width, this.height);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, this.width, bandH);
    ctx.clip();

    // ── background ───────────────────────────────────────────────────────
    const g = ctx.createLinearGradient(0, top, 0, bottom);
    g.addColorStop(0, mix(pal.bg[0], "#ffffff", pulse * 0.5));
    g.addColorStop(1, mix(pal.bg[1], "#000000", 0.1));
    ctx.fillStyle = g;
    ctx.fillRect(0, top, this.width, bandH);

    // Parallax bars — the vertical streaks in the original's darker sections.
    ctx.save();
    ctx.globalAlpha = 0.13 + pulse * 0.25;
    ctx.fillStyle = pal.accent;
    const bw = this.width / 26;
    for (let i = -1; i < 28; i++) {
      const px = ((i * bw - (s.camX * S * 0.22) % (bw * 2)) + this.width * 2) % (this.width + bw * 2) - bw;
      const hgt = bandH * (0.25 + ((i * 37) % 11) / 20);
      ctx.fillRect(px, bottom - hgt, bw * 0.32, hgt);
    }
    ctx.restore();

    // ── world transform ──────────────────────────────────────────────────
    // Death shake. Deterministic in the frame, so it never jitters at rest.
    const k = s.shake * s.shake;
    const shakeX = k * Math.sin(s.time * 91) * 13;
    const shakeY = k * Math.sin(s.time * 77 + 2) * 11;
    const originX = this.width * PLAYER_SCREEN_X - s.camX * S + shakeX;
    const originY = bottom + s.camY * S + shakeY;
    const toScreenX = (x: number) => originX + x * S;
    const toScreenY = (y: number) => originY - y * S;

    const x0 = s.camX - (this.width * PLAYER_SCREEN_X) / S - 4;
    const x1 = s.camX + (this.width * (1 - PLAYER_SCREEN_X)) / S + 4;

    // Ground slab, drawn under everything.
    const groundY = toScreenY(0);
    if (groundY < bottom) {
      ctx.fillStyle = mix(pal.ground, "#ffffff", pulse * 0.35);
      ctx.fillRect(0, groundY, this.width, bottom - groundY);
      // Scrolling tick marks, so the floor has speed and the eye has
      // something to read the 1× against.
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = pal.accent;
      const tick = S;
      const off = (toScreenX(0) % (tick * 2) + tick * 2) % (tick * 2);
      for (let px = off - tick * 2; px < this.width; px += tick * 2) {
        ctx.fillRect(px, groundY + 4, tick, Math.max(2, bottom - groundY - 8));
      }
      ctx.restore();
      ctx.fillStyle = rgba(pal.accent, 0.95);
      ctx.fillRect(0, groundY - 3, this.width, 4);
      const glow = ctx.createLinearGradient(0, groundY - 26, 0, groundY);
      glow.addColorStop(0, rgba(pal.accent, 0));
      glow.addColorStop(1, rgba(pal.accent, 0.16 + pulse * 0.2));
      ctx.fillStyle = glow;
      ctx.fillRect(0, groundY - 26, this.width, 26);
    }

    // ── objects ──────────────────────────────────────────────────────────
    const objs = this.index.inView(x0, x1);
    const reveal = this.revealState(s);

    for (const o of objs) if (o.back) this.drawObject(o, pal, ink, toScreenX, toScreenY, S, s, reveal, pulse);
    for (const o of objs) if (!o.back) this.drawObject(o, pal, ink, toScreenX, toScreenY, S, s, reveal, pulse);

    // ── finish line ──────────────────────────────────────────────────────
    const fx = toScreenX(this.level.length);
    if (fx > -40 && fx < this.width + 40) {
      ctx.save();
      const fg = ctx.createLinearGradient(fx - 30, 0, fx + 30, 0);
      fg.addColorStop(0, rgba(pal.accent, 0));
      fg.addColorStop(0.5, rgba(pal.accent, 0.85));
      fg.addColorStop(1, rgba(pal.accent, 0));
      ctx.fillStyle = fg;
      ctx.fillRect(fx - 30, top, 60, bandH);
      ctx.restore();
    }

    // ── particles ────────────────────────────────────────────────────────
    for (const p of s.particles) {
      const a = Math.max(0, p.life / p.max);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      const sz = p.size * S * (0.4 + a * 0.6);
      ctx.fillRect(toScreenX(p.x) - sz / 2, toScreenY(p.y) - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;

    // ── player ───────────────────────────────────────────────────────────
    if (!s.dead) this.drawPlayer(s.player, pal, toScreenX, toScreenY, S);

    // ── the pulse ring ───────────────────────────────────────────────────
    if (s.pulseAge !== null && s.pulseAge < 2.4) {
      const r = s.pulseAge * 34 * S;
      const a = Math.max(0, 1 - s.pulseAge / 2.4);
      ctx.save();
      ctx.strokeStyle = rgba("#ffffff", a * 0.7);
      ctx.lineWidth = 2 + a * 5;
      ctx.beginPath();
      ctx.arc(toScreenX(s.player.x), toScreenY(s.player.y + 0.5), r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // ── vignette ─────────────────────────────────────────────────────────
    const midY = top + bandH / 2;
    const v = ctx.createRadialGradient(
      this.width / 2, midY, bandH * 0.35,
      this.width / 2, midY, bandH * 0.95,
    );
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = v;
    ctx.fillRect(0, top, this.width, bandH);
    ctx.restore();

    if (s.dim > 0) {
      ctx.fillStyle = `rgba(2,2,6,${s.dim * 0.72})`;
      ctx.fillRect(0, 0, this.width, this.height);
    }
  }

  /** Ring radius in blocks and how strongly the truth is showing, 0..1. */
  private revealState(s: RenderState): { radius: number; strength: number } | null {
    if (s.pulseAge === null) return null;
    const age = s.pulseAge;
    const strength = age < 1.6 ? 1 : Math.max(0, 1 - (age - 1.6) / 0.8);
    if (strength <= 0) return null;
    return { radius: age * 34, strength };
  }

  private drawObject(
    o: Obj,
    pal: Section,
    ink: string,
    sx: (x: number) => number,
    sy: (y: number) => number,
    S: number,
    st: RenderState,
    reveal: { radius: number; strength: number } | null,
    pulse: number,
  ) {
    const { ctx } = this;
    let alpha = o.alpha ?? 1;
    let outline: string | null = null;

    // The pulse only ever speaks about things that collide: it dims the paint
    // and outlines the danger. Orbs, pads, portals and checkpoints are already
    // honest, and lighting them up would just add noise to the one moment in
    // the level that is supposed to be quiet.
    const speaks = o.kind === "spike" || o.kind === "saw" || o.kind === "block";
    if (reveal && speaks) {
      const dx = o.x + o.w / 2 - st.player.x;
      const dy = o.y + o.h / 2 - (st.player.y + 0.5);
      if (Math.hypot(dx, dy) < reveal.radius) {
        if (o.decoy) alpha *= 1 - 0.88 * reveal.strength;
        else {
          alpha = alpha + (1 - alpha) * reveal.strength;
          outline = o.kind === "block" ? "#38f5ff" : "#ff2b4d";
        }
      }
    } else if (reveal && o.kind === "glyph") {
      const dx = o.x + o.w / 2 - st.player.x;
      const dy = o.y + o.h / 2 - (st.player.y + 0.5);
      if (Math.hypot(dx, dy) < reveal.radius) alpha *= 1 - 0.88 * reveal.strength;
    }
    if (o.back) alpha *= 0.5;
    if (alpha <= 0.01) return;

    const cx = sx(o.x + o.w / 2);
    const cy = sy(o.y + o.h / 2);
    const w = o.w * S;
    const h = o.h * S;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    if (o.rot) ctx.rotate((o.rot * Math.PI) / 180);

    // Scenery is mixed toward the background rather than toward white, so it
    // sits behind the play layer instead of competing with it.
    const hazardColor = o.color ??
      (o.back ? mix(pal.hazard, pal.bg[1], 0.62) : mix(pal.hazard, "#ffffff", pulse * 0.6));
    const solidColor = o.color ??
      (o.back ? mix(pal.solid, pal.bg[1], 0.68) : mix(pal.solid, "#ffffff", pulse * 0.4));

    switch (o.kind) {
      case "spike": {
        ctx.beginPath();
        ctx.moveTo(-w / 2, h / 2);
        ctx.lineTo(w / 2, h / 2);
        ctx.lineTo(0, -h / 2);
        ctx.closePath();
        ctx.fillStyle = hazardColor;
        ctx.fill();
        ctx.strokeStyle = outline ?? rgba(ink, o.back ? 0.35 : 0.9);
        ctx.lineWidth = outline ? 3 : 2;
        ctx.stroke();
        // The inner wedge every I Spy spike has, real or not.
        ctx.beginPath();
        ctx.moveTo(-w / 5, h / 2 - 1);
        ctx.lineTo(w / 5, h / 2 - 1);
        ctx.lineTo(0, -h / 6);
        ctx.closePath();
        ctx.fillStyle = rgba(coreFor(pal.hazard, pal.accent), 0.95);
        ctx.fill();
        break;
      }
      case "block": {
        ctx.fillStyle = solidColor;
        ctx.fillRect(-w / 2, -h / 2, w, h);
        if (!o.plain || outline) {
          // Two strokes: the accent edge, and an inset line a few pixels in.
          // That inset is most of what makes the original's blocks read as
          // solid objects rather than as flat rectangles.
          ctx.strokeStyle = outline ?? rgba(ink, o.back ? 0.3 : 0.9);
          ctx.lineWidth = outline ? 3 : 2;
          ctx.strokeRect(-w / 2, -h / 2, w, h);
          const inset = Math.min(w, h) * 0.16;
          if (inset > 2) {
            ctx.strokeStyle = rgba(ink, 0.32);
            ctx.lineWidth = 1.5;
            ctx.strokeRect(-w / 2 + inset, -h / 2 + inset, w - inset * 2, h - inset * 2);
          }
        }
        break;
      }
      case "saw": {
        // A toothed blade, deliberately NOT the player's pinwheel: the player
        // has to stay findable in a frame with forty of these in it.
        const r = Math.min(w, h) / 2;
        ctx.rotate(st.time * 6 + o.x);
        ctx.fillStyle = outline ?? hazardColor;
        ctx.beginPath();
        const TEETH = 9;
        for (let i = 0; i < TEETH * 2; i++) {
          const a = (i / (TEETH * 2)) * Math.PI * 2;
          const rad = i % 2 === 0 ? r : r * 0.62;
          ctx[i === 0 ? "moveTo" : "lineTo"](Math.cos(a) * rad, Math.sin(a) * rad);
        }
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = rgba(ink, 0.9);
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.34, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case "pad": {
        ctx.fillStyle = "#ffd400";
        ctx.fillRect(-w / 2, -h / 2, w, h);
        ctx.shadowBlur = 18;
        ctx.shadowColor = "#ffd400";
        ctx.fillRect(-w / 2, -h / 2, w, h);
        break;
      }
      case "orb": {
        ctx.strokeStyle = "#ffd400";
        ctx.lineWidth = 3;
        ctx.shadowBlur = 20;
        ctx.shadowColor = "#ffd400";
        ctx.beginPath();
        ctx.arc(0, 0, Math.min(w, h) / 2.6, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case "portal": {
        ctx.strokeStyle = pal.accent;
        ctx.lineWidth = 5;
        ctx.shadowBlur = 30;
        ctx.shadowColor = pal.accent;
        ctx.beginPath();
        ctx.ellipse(0, 0, w * 0.45, h * 0.5, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case "coin": {
        if (st.collected.has(o.x)) break;
        const r = Math.min(w, h) / 2;
        const spin = st.time * 2.4;
        // A halo that does not turn, so the coin is still findable at the
        // moment the disc is edge-on and two pixels wide.
        const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 2.6);
        glow.addColorStop(0, "rgba(255,212,0,0.5)");
        glow.addColorStop(0.5, "rgba(255,212,0,0.14)");
        glow.addColorStop(1, "rgba(255,212,0,0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(0, 0, r * 2.6, 0, Math.PI * 2);
        ctx.fill();
        // Squashed on a sine so it reads as a disc turning in space, which is
        // how every collectible in every platformer has announced itself.
        ctx.scale(Math.abs(Math.cos(spin)) * 0.65 + 0.35, 1);
        ctx.shadowBlur = 28;
        ctx.shadowColor = "#ffd400";
        ctx.fillStyle = "#ffd400";
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = "#7a4a00";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = "#fff3b0";
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.45, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case "checkpoint": {
        // A banner you pass through. Lit once the run is past it.
        const lit = o.x <= st.player.x;
        const c = lit ? "#7dffd0" : "#ffffff";
        ctx.globalAlpha = alpha * (lit ? 0.9 : 0.22);
        ctx.fillStyle = c;
        ctx.shadowBlur = lit ? 26 : 0;
        ctx.shadowColor = c;
        ctx.fillRect(-w / 2, -h / 2, Math.max(2, w), h);
        ctx.beginPath();
        ctx.moveTo(0, -h / 2 - S * 0.55);
        ctx.lineTo(S * 0.4, -h / 2);
        ctx.lineTo(0, -h / 2 + S * 0.55);
        ctx.lineTo(-S * 0.4, -h / 2);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case "glyph": {
        ctx.fillStyle = o.color ?? pal.accent;
        ctx.font = `900 ${Math.round(h)}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("?", 0, 0);
        break;
      }
    }
    ctx.restore();
  }

  /** The icon: a white square with a red pinwheel in it, as in the level. */
  private drawPlayer(
    p: PlayerState,
    pal: Section,
    sx: (x: number) => number,
    sy: (y: number) => number,
    S: number,
  ) {
    const { ctx } = this;
    const cx = sx(p.x);
    const cy = sy(p.y + 0.5);
    ctx.save();
    ctx.translate(cx, cy);
    // A halo under the icon. Without it the player disappears into the noise
    // in the bright sections, and "where am I" is not the puzzle this level
    // is trying to set.
    const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, S * 1.8);
    halo.addColorStop(0, "rgba(255,255,255,0.72)");
    halo.addColorStop(0.42, "rgba(255,255,255,0.2)");
    halo.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, S * 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate((p.rot * Math.PI) / 180);
    ctx.shadowBlur = 22;
    ctx.shadowColor = pal.accent;

    const drawIcon = (size: number) => {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(-size / 2, -size / 2, size, size);
      ctx.strokeStyle = "#0a0a0a";
      ctx.lineWidth = 3;
      ctx.strokeRect(-size / 2, -size / 2, size, size);
      ctx.fillStyle = "#e11d48";
      for (let i = 0; i < 4; i++) {
        ctx.save();
        ctx.rotate((i * Math.PI) / 2);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(size * 0.42, -size * 0.1, size * 0.42, size * 0.3);
        ctx.lineTo(0, 0);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    };

    if (p.mode === "ship") {
      // Hull, then the icon riding in it.
      ctx.save();
      ctx.scale(1, p.grav);
      ctx.fillStyle = pal.accent;
      ctx.beginPath();
      ctx.moveTo(-0.65 * S, 0.1 * S);
      ctx.lineTo(0.75 * S, 0);
      ctx.lineTo(-0.65 * S, -0.45 * S);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      drawIcon(0.62 * S);
    } else if (p.mode === "wave") {
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.moveTo(0.45 * S, 0);
      ctx.lineTo(-0.4 * S, -0.36 * S);
      ctx.lineTo(-0.4 * S, 0.36 * S);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = pal.accent;
      ctx.lineWidth = 2;
      ctx.stroke();
    } else if (p.mode === "ball") {
      ctx.beginPath();
      ctx.arc(0, 0, 0.5 * S, 0, Math.PI * 2);
      ctx.clip();
      drawIcon(1.0 * S);
    } else {
      drawIcon(0.94 * S);
    }
    ctx.restore();
  }
}
