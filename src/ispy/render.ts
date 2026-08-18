/**
 * I SPY — the renderer.
 *
 * Plain 2D canvas. The single most important rule in this file is that it is
 * never told whether an object is real: `drawObject` draws a decoy spike with
 * exactly the code that draws a lethal one. The moment those two paths differ
 * by a pixel the level stops being I Spy and becomes a normal level with a lot
 * of clutter in it.
 *
 * The one exception is the sonar, and it is deliberate: for a second and a
 * half after a ping, the lie is drawn as a lie.
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

/**
 * One sample of where the player was. The engine keeps a short ring of these
 * and the renderer smears them into a motion trail — at ten blocks a second a
 * hard-edged icon reads as a sprite being teleported across the screen, and a
 * trail is what tells the eye it is *travelling*.
 */
export interface TrailPoint {
  x: number;
  y: number;
  rot: number;
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
  /** Where the player has been, oldest first. */
  trail: TrailPoint[];
  /**
   * 1 the instant the player touches down, decaying to 0.
   *
   * Squash and stretch. A rigid cube that lands with no give reads as a
   * sprite being snapped to a grid; a cube that flattens for a tenth of a
   * second and springs back reads as something with weight in it, and it is
   * two multiplies.
   */
  land: number;
  /** Seconds since the last sonar ping, or null. */
  sonarAge: number | null;
  dead: boolean;
  deathAge: number;
  /** 0..1 — decays after a death. Knocks the camera about for a moment. */
  shake: number;
  /** How many checkpoints the run has banked; earlier ones draw lit. */
  banked: number;
  /** Checkpoint banners are drawn in practice mode only. */
  showCheckpoints: boolean;
  /** The mix, low frequencies first, 0..1. Empty when nothing is playing. */
  spectrum: Float32Array;
  /** False when the spectrum is idle filler rather than real audio. */
  spectrumLive: boolean;
  /** x of every coin already taken this attempt. */
  collected: Set<number>;
  /** 0..1, dims everything for the menu. */
  dim: number;
  /**
   * Smoothed wall-clock milliseconds between frames.
   *
   * The renderer times its own `draw`, but on a machine with an accelerated
   * canvas those calls return long before the GPU has finished with them —
   * the timer would read three milliseconds on a page running at twenty
   * frames a second. The clock does not lie, so the budget watches both.
   */
  frameMs: number;
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

/** Fractional part, always positive. */
function frac(n: number): number {
  return n - Math.floor(n);
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
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

/** Fraction of the canvas the bloom buffer runs at. */
const BLOOM_SCALE = 0.2;
/** Edge of the grain tile, in device pixels. */
const GRAIN_TILE = 128;

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly index: DrawIndex;
  dpr = 1;
  width = 0;
  height = 0;
  /** Top edge and height of the play band. Equal to the canvas on desktop. */
  bandY = 0;
  bandH = 0;

  /**
   * The bloom buffer. The frame is downscaled into it, hard-clipped so only
   * the bright parts survive, blurred, and added back over itself. That is
   * what an actual camera does with a neon sign, and it is the single change
   * that moved this from "flat vector shapes" to "a lit scene" — everything
   * that glows now spills light onto what is next to it.
   */
  private bloom: HTMLCanvasElement | null = null;
  private bloomCtx: CanvasRenderingContext2D | null = null;
  /** Film grain, generated once. Kills the plastic look of flat gradients. */
  private grain: CanvasPattern | null = null;
  /** Gradients, keyed by what they were built from. */
  private readonly shades = new Map<string, CanvasGradient>();

  /**
   * 0…1 — how much of the lighting the machine can afford, measured rather
   * than guessed.
   *
   * Every effect below the geometry is optional, and every one of them costs
   * real milliseconds on a software canvas: the first version of this pass
   * looked exactly right and ran at twelve frames a second, which in a game
   * where one jump is one beat is not a look, it is a bug. So the renderer
   * times itself and spends what it has — a desktop keeps the reflection,
   * the grain and forty motes; a phone quietly drops them in that order and
   * keeps the bloom, which is the one that matters.
   *
   * Public so the capture script can report where it settled.
   */
  quality = 1;
  private cost = 8;
  /** Non-null freezes the budget — capture only. See `ISpyEngine.debugQuality`. */
  private pinned: number | null = null;

  /** Hold the lighting at a fixed level, or `null` to let it tune again. */
  pinQuality(q: number | null) {
    this.pinned = q;
    if (q !== null) this.quality = q;
  }

  constructor(private readonly canvas: HTMLCanvasElement, private readonly level: Level) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("I Spy needs a 2D canvas context");
    this.ctx = ctx;
    this.index = new DrawIndex(level.objects);
    this.makeGrain();
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
    this.shades.clear();

    const bw = Math.max(1, Math.round(this.canvas.width * BLOOM_SCALE));
    const bh = Math.max(1, Math.round(this.canvas.height * BLOOM_SCALE));
    if (!this.bloom) this.bloom = document.createElement("canvas");
    this.bloom.width = bw;
    this.bloom.height = bh;
    this.bloomCtx = this.bloom.getContext("2d", { alpha: true });
  }

  /** A tile of monochrome noise, drawn once and repeated forever after. */
  private makeGrain() {
    const c = document.createElement("canvas");
    c.width = GRAIN_TILE;
    c.height = GRAIN_TILE;
    const g = c.getContext("2d");
    if (!g) return;
    const img = g.createImageData(GRAIN_TILE, GRAIN_TILE);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 110 + Math.random() * 90;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    this.grain = this.ctx.createPattern(c, "repeat");
  }

  /**
   * A vertical light ramp for a face: lit along its top edge, falling into
   * shadow at its bottom. Cached, because a frame can hold eighty objects and
   * building eighty gradients sixty times a second is real time on a phone.
   *
   * The gradient lives in the object's own translated space, which is why it
   * can be cached at all — every block of the same colour and height gets the
   * same ramp regardless of where on the screen it is.
   */
  private shade(color: string, h: number, amt: number): CanvasGradient {
    return this.cached(`v|${color}|${Math.round(h)}|${Math.round(amt * 100)}`, () => {
      const g = this.ctx.createLinearGradient(0, -h / 2, 0, h / 2);
      g.addColorStop(0, mix(color, "#ffffff", amt));
      g.addColorStop(0.5, color);
      g.addColorStop(1, mix(color, "#000000", amt * 1.45));
      return g;
    });
  }

  private cached(key: string, make: () => CanvasGradient): CanvasGradient {
    let g = this.shades.get(key);
    if (!g) {
      g = make();
      if (this.shades.size > 600) this.shades.clear();
      this.shades.set(key, g);
    }
    return g;
  }

  /** Pixels per block. */
  get scale(): number {
    return this.bandH / VIEW_H;
  }

  draw(s: RenderState) {
    const t0 = performance.now();
    const { ctx } = this;
    const top = this.bandY;
    const bottom = this.bandY + this.bandH;
    const bandH = this.bandH;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    const pal = paletteAt(this.level, s.player.x);
    const ink = inkFor(pal);
    const brightBg = luma(pal.bg[0]) + luma(pal.bg[1]) > 1;
    // Beat pulse: a hard flash on the downbeat, decaying over the beat.
    const pulse = Math.pow(1 - s.beat, 2.2) * pal.strobe;
    // …and the lens breathes with it. Under a percent, which is exactly why
    // it works: you do not see the camera move, you feel the room thump.
    const S = this.scale * (1 + pulse * 0.007);

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

    // A light source. Everything in the level is lit from above and behind by
    // the section's accent, so there has to be somewhere for that light to be
    // coming *from* — otherwise the shading on the geometry is a lie the eye
    // notices without being able to say why.
    if (this.quality > 0.25) {
      const sunX = this.width * 0.62;
      const sunY = top + bandH * 0.18;
      const sun = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, bandH * 0.9);
      sun.addColorStop(0, rgba(pal.accent, (brightBg ? 0.07 : 0.14) + pulse * 0.12));
      sun.addColorStop(0.45, rgba(pal.accent, brightBg ? 0.02 : 0.045));
      sun.addColorStop(1, rgba(pal.accent, 0));
      ctx.fillStyle = sun;
      ctx.fillRect(0, top, this.width, bandH);
    }

    // ── the spectrum ─────────────────────────────────────────────────────
    // The vertical bars behind the level are not decoration any more: they
    // are the score, tapped off the master bus. In a level whose one honest
    // signal is a sound, the background should be that sound.
    ctx.save();
    const bars = s.spectrum.length;
    const bw = this.width / bars;
    for (let i = 0; i < bars; i++) {
      const v = s.spectrum[i];
      if (v <= 0.004) continue;
      const hgt = bandH * (0.06 + v * 0.72);
      const px = i * bw;
      const g2 = ctx.createLinearGradient(0, bottom - hgt, 0, bottom);
      g2.addColorStop(0, rgba(pal.accent, 0));
      g2.addColorStop(1, rgba(pal.accent, (s.spectrumLive ? 0.3 : 0.16) + pulse * 0.28));
      ctx.fillStyle = g2;
      ctx.fillRect(px + bw * 0.22, bottom - hgt, bw * 0.56, hgt);
      // A bright cap, so a loud band reads as a hit rather than as a smear.
      ctx.fillStyle = rgba(pal.accent, 0.5 * v + pulse * 0.3);
      ctx.fillRect(px + bw * 0.22, bottom - hgt, bw * 0.56, Math.max(2, bandH * 0.006));
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

    // Parallax for the scenery. The same projection, run at 94% about the
    // player's column and about the ground line — so distant buildings slide
    // a little slower and stand a little shorter, which is the whole of what
    // "further away" can mean to a flat renderer. Pivoting on the ground is
    // the part that matters: scale about anything else and the back layer
    // lifts off the floor it is supposed to be standing on.
    const PARA = 0.94;
    const anchorX = this.width * PLAYER_SCREEN_X + shakeX;
    const toBackX = (x: number) => anchorX + (x - s.camX) * S * PARA;
    const toBackY = (y: number) => originY - y * S * PARA;

    const x0 = s.camX - (this.width * PLAYER_SCREEN_X) / S - 4;
    const x1 = s.camX + (this.width * (1 - PLAYER_SCREEN_X)) / S + 4;

    // Ground slab, drawn under everything.
    const groundY = toScreenY(0);
    if (groundY < bottom) {
      // A real base, not a line. Three courses of block, a bright lip, and a
      // glow above it — the ground is the one thing on screen that is never
      // lying to you, so it should look like something you can stand on.
      // The palettes' ground colours are nearly black, so the base has to be
      // lifted toward the section's accent to be a surface at all rather than
      // the place the picture stops.
      const course = S;
      const face = mix(pal.ground, pal.accent, 0.22);
      ctx.fillStyle = mix(pal.ground, "#000000", 0.45);
      ctx.fillRect(0, groundY, this.width, bottom - groundY);
      ctx.fillStyle = mix(face, "#ffffff", pulse * 0.3);
      ctx.fillRect(0, groundY, this.width, Math.min(course, bottom - groundY));
      ctx.fillStyle = mix(pal.ground, pal.accent, 0.1);
      ctx.fillRect(0, groundY + course, this.width, Math.max(0, bottom - groundY - course));

      // Mortar. Vertical joints on the block grid, offset on the lower
      // course, so the base reads as masonry rather than as a fill.
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = mix(pal.ground, "#000000", 0.8);
      const originPx = toScreenX(0);
      for (let row = 0; row < 3; row++) {
        const y = groundY + row * course;
        if (y > bottom) break;
        const shift = row % 2 ? course / 2 : 0;
        const off = ((originPx + shift) % course + course) % course;
        for (let px = off - course; px < this.width; px += course) {
          ctx.fillRect(px, y, 2, Math.min(course, bottom - y));
        }
        ctx.fillRect(0, y, this.width, 2);
      }
      ctx.restore();

      // The lip, and the light it throws up into the level.
      ctx.fillStyle = rgba(pal.accent, 0.95);
      ctx.fillRect(0, groundY - 3, this.width, 4);
      const glow = ctx.createLinearGradient(0, groundY - 30, 0, groundY);
      glow.addColorStop(0, rgba(pal.accent, 0));
      glow.addColorStop(1, rgba(pal.accent, 0.18 + pulse * 0.22));
      ctx.fillStyle = glow;
      ctx.fillRect(0, groundY - 30, this.width, 30);
    }

    // ── objects ──────────────────────────────────────────────────────────
    const objs = this.index.inView(x0, x1);
    const reveal = this.revealState(s);

    for (const o of objs) if (o.back) this.drawObject(o, pal, ink, toBackX, toBackY, s, reveal, pulse);

    // Aerial perspective: a wash of the air's own colour between the scenery
    // and the level. Distance is not sharpness, it is *contrast* — there is
    // atmosphere in the way, and it is doing this to everything behind it.
    //
    // This started life as a `blur()` filter on the back layer and it looked
    // wonderful and cost four fifths of the frame rate, because a canvas
    // filter forces a compositing layer per draw call. A single translucent
    // rectangle buys most of the same depth for one fill.
    // Stops at the floor: the ground is foreground, and hazing it would put
    // the thing you are standing on behind the weather.
    ctx.fillStyle = rgba(pal.bg[1], brightBg ? 0.34 : 0.42);
    ctx.fillRect(0, top, this.width, Math.max(0, Math.min(bottom, groundY) - top));

    for (const o of objs) if (!o.back) this.drawObject(o, pal, ink, toScreenX, toScreenY, s, reveal, pulse);

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

    // ── contact shadow ───────────────────────────────────────────────────
    // The only cue in a side-on game that says how high off the floor you
    // are. It widens and washes out as the player climbs, which is what a
    // real shadow does and what makes the jump read as an arc through a room
    // rather than a sprite sliding up a wall.
    if (!s.dead && s.player.grav === 1 && this.quality > 0.1) {
      const gy = toScreenY(0);
      const alt = Math.max(0, s.player.y);
      if (gy > top && gy < bottom + 40 && alt < 10) {
        const a = Math.max(0, 0.45 - alt * 0.042);
        ctx.save();
        ctx.translate(toScreenX(s.player.x), gy);
        ctx.scale(1 + alt * 0.2, 0.3);
        ctx.globalAlpha = a;
        ctx.fillStyle = this.cached(`sh|${Math.round(S)}`, () => {
          const sh = ctx.createRadialGradient(0, 0, 0, 0, 0, S * 0.9);
          sh.addColorStop(0, "rgba(0,0,0,1)");
          sh.addColorStop(0.6, "rgba(0,0,0,0.4)");
          sh.addColorStop(1, "rgba(0,0,0,0)");
          return sh;
        });
        ctx.beginPath();
        ctx.arc(0, 0, S * 0.9, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    // ── particles ────────────────────────────────────────────────────────
    // Added rather than painted, on the dark sections: sparks are light, and
    // light adds. On a bright palette that would only wash the frame out, so
    // there they go back to being paint.
    ctx.save();
    if (!brightBg) ctx.globalCompositeOperation = "lighter";
    for (const p of s.particles) {
      const a = Math.max(0, p.life / p.max);
      ctx.globalAlpha = a * (brightBg ? 1 : 0.85);
      ctx.fillStyle = p.color;
      const sz = p.size * S * (0.4 + a * 0.6);
      ctx.fillRect(toScreenX(p.x) - sz / 2, toScreenY(p.y) - sz / 2, sz, sz);
    }
    ctx.restore();
    ctx.globalAlpha = 1;

    // ── player ───────────────────────────────────────────────────────────
    if (!s.dead) {
      this.drawTrail(s, pal, toScreenX, toScreenY, S);
      this.drawPlayer(s.player, pal, toScreenX, toScreenY, S, s.land);
    }

    // ── the wet floor ────────────────────────────────────────────────────
    // Everything above the lip, mirrored into the stone below it. Drawn last
    // of the world so the player is in it, which is the point: you can see
    // yourself land.
    this.reflect(toScreenY(0), top, bottom, s.time, brightBg);

    // ── the sonar sweep ──────────────────────────────────────────────────
    // Two rings, half a beat apart, because the ping is two notes half a beat
    // apart: the one you send and the one that comes back.
    if (s.sonarAge !== null && s.sonarAge < 2.6) {
      ctx.save();
      const cxp = toScreenX(s.player.x);
      const cyp = toScreenY(s.player.y + 0.5);
      for (const lag of [0, 0.375]) {
        const age = s.sonarAge - lag;
        if (age <= 0 || age > 2.4) continue;
        const r = age * 34 * S;
        const a = Math.max(0, 1 - age / 2.4) * (lag ? 0.4 : 1);
        ctx.strokeStyle = rgba("#ffffff", a * 0.65);
        ctx.lineWidth = 2 + a * 5;
        ctx.beginPath();
        ctx.arc(cxp, cyp, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    // ── atmosphere ───────────────────────────────────────────────────────
    // Dust in the beam. Nothing in this game is airtight, and a room with
    // nothing suspended in it photographs like a vacuum.
    if (this.quality > 0.3) this.motes(s, pal, top, bandH);

    // ── bloom ────────────────────────────────────────────────────────────
    // Last thing to go, because it is the one doing the most work.
    if (this.quality > 0.15) this.bloomPass(brightBg);

    // ── grain ────────────────────────────────────────────────────────────
    if (this.quality > 0.75) this.grainPass(s.time, top, bandH);

    // ── vignette ─────────────────────────────────────────────────────────
    const midY = top + bandH / 2;
    const v = ctx.createRadialGradient(
      this.width / 2, midY, bandH * 0.35,
      this.width / 2, midY, bandH * 0.95,
    );
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(0,0,0,0.44)");
    ctx.fillStyle = v;
    ctx.fillRect(0, top, this.width, bandH);
    ctx.restore();

    if (s.dim > 0) {
      ctx.fillStyle = `rgba(2,2,6,${s.dim * 0.72})`;
      ctx.fillRect(0, 0, this.width, this.height);
    }

    // Spend what the machine has. A sixty-hertz frame is 16.7 ms of which the
    // renderer can have about half — the rest is the simulation, and in
    // attract mode a solver searching a second and a third of futures twenty
    // times a second. Drop fast, recover slowly, so a single expensive frame
    // does not strip the lighting and a genuinely slow machine settles.
    if (this.pinned !== null) return;
    this.cost += (performance.now() - t0 - this.cost) * 0.06;
    const slow = this.cost > 8.5 || s.frameMs > 24;
    const roomy = this.cost < 5 && s.frameMs < 19;
    if (slow) this.quality = Math.max(0, this.quality - 0.02);
    else if (roomy) this.quality = Math.min(1, this.quality + 0.004);
  }

  /**
   * Mirror the play area into the floor.
   *
   * Five strips rather than one, each a little fainter and a little more
   * offset than the one above it. That is the cheap way to get a reflection
   * that falls off with depth and shimmers, and the seams are invisible
   * because the whole thing is added at a quarter strength.
   */
  private reflect(groundY: number, top: number, bottom: number, time: number, brightBg: boolean) {
    const { ctx, dpr } = this;
    if (this.quality < 0.45) return;
    if (groundY <= top + 4 || groundY >= bottom - 6) return;
    // Only what is close to the floor gets mirrored. The sky does not have a
    // reflection worth two milliseconds of frame time, and copying the whole
    // band back into the stone was most of what made this pass expensive.
    const h = Math.min(bottom - groundY, groundY - top, this.bandH * 0.2);
    if (h < 10) return;

    const BANDS = 3;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, groundY, this.width, bottom - groundY);
    ctx.clip();
    ctx.globalCompositeOperation = "lighter";
    ctx.translate(0, groundY * 2);
    ctx.scale(1, -1);
    for (let i = 0; i < BANDS; i++) {
      const hh = h / BANDS;
      const y0 = groundY + i * hh;
      // Both source and destination land on the same coordinate once the
      // flip is in the transform — the mirror of a strip below the lip is
      // the strip the same distance above it.
      const uy = 2 * groundY - y0 - hh;
      if (uy < 0) break;
      const ripple = Math.sin(time * 1.7 + i * 1.3) * (0.6 + i * 0.5);
      // A lit floor under a lit sky adds up to a white floor, so the bright
      // palettes get a far weaker mirror than the black ones do.
      ctx.globalAlpha = (brightBg ? 0.13 : 0.3) * Math.pow(1 - i / BANDS, 1.5);
      ctx.drawImage(
        this.canvas,
        0, uy * dpr, this.canvas.width, hh * dpr,
        ripple, uy, this.width, hh,
      );
    }
    ctx.restore();
  }

  /** Slow motes of dust, parallaxed against the camera. No RNG at runtime:
      each one's home is a hash of its index, so the air never re-rolls. */
  private motes(s: RenderState, pal: Section, top: number, bandH: number) {
    const { ctx } = this;
    const N = Math.round(40 * this.quality);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = pal.accent;
    for (let i = 0; i < N; i++) {
      const fx = frac(Math.sin(i * 12.9898) * 43758.5453);
      const fy = frac(Math.sin(i * 78.233) * 12345.6789);
      const depth = 0.22 + fy * 0.78;
      const x = mod(fx * this.width - s.camX * depth * 24 + s.time * depth * 6, this.width + 40) - 20;
      const y = top + mod(fy * bandH - s.time * (5 + depth * 13), bandH);
      const r = 0.6 + depth * 2;
      ctx.globalAlpha = 0.05 + depth * 0.085;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Bloom. The frame is shrunk into a quarter-size buffer, the mid-tones are
   * crushed out of it with contrast so only the highlights survive, it is
   * blurred, and it is added back over itself.
   *
   * This is the change that made the level look photographed rather than
   * drawn: the accent lip on the floor now throws light onto the blocks near
   * it, the coins halo, and the strobe on the downbeat blows out the way a
   * real over-bright frame does.
   */
  private bloomPass(brightBg: boolean) {
    const bc = this.bloomCtx;
    const buf = this.bloom;
    if (!bc || !buf || buf.width < 2) return;
    bc.setTransform(1, 0, 0, 1, 0, 0);
    bc.globalCompositeOperation = "source-over";
    bc.globalAlpha = 1;
    bc.clearRect(0, 0, buf.width, buf.height);
    // The threshold, and it has to be a real one. Adding a blurred copy of
    // the whole frame back over itself turns a bright section into a wall of
    // fog — the yellow movement went completely white the first time this
    // ran. Knocking the exposure down *before* the contrast puts the pivot up
    // around 0.55 luminance, so everything but the actual highlights lands on
    // black and only the lights bloom.
    bc.filter = "brightness(0.5) contrast(3.6) saturate(1.15) blur(3px)";
    bc.drawImage(
      this.canvas,
      0, 0, this.canvas.width, this.canvas.height,
      0, 0, buf.width, buf.height,
    );
    bc.filter = "none";

    const { ctx } = this;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = brightBg ? 0.26 : 0.5;
    ctx.drawImage(buf, 0, 0, this.width, this.height);
    ctx.restore();
  }

  /** Film grain, jittered 24 times a second so it crawls like film and not
      like dirt on the screen. */
  private grainPass(time: number, top: number, bandH: number) {
    if (!this.grain) return;
    const { ctx } = this;
    const f = Math.floor(time * 24);
    const ox = ((f * 37) % GRAIN_TILE + GRAIN_TILE) % GRAIN_TILE;
    const oy = ((f * 71) % GRAIN_TILE + GRAIN_TILE) % GRAIN_TILE;
    ctx.save();
    ctx.globalCompositeOperation = "overlay";
    ctx.globalAlpha = 0.055;
    ctx.fillStyle = this.grain;
    ctx.translate(-ox, -oy);
    ctx.fillRect(ox, top + oy, this.width, bandH);
    ctx.restore();
  }

  /** The smear behind the icon. */
  private drawTrail(
    s: RenderState,
    pal: Section,
    sx: (x: number) => number,
    sy: (y: number) => number,
    S: number,
  ) {
    const t = s.trail;
    if (t.length < 2) return;
    const { ctx } = this;
    const round = s.player.mode === "ball" || s.player.mode === "wave";
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = pal.accent;
    for (let i = 0; i < t.length; i++) {
      const f = (i + 1) / t.length;
      const a = Math.pow(f, 2.4) * 0.42;
      if (a < 0.012) continue;
      ctx.globalAlpha = a;
      ctx.save();
      ctx.translate(sx(t[i].x), sy(t[i].y + 0.5));
      const size = S * (0.42 + f * 0.46);
      if (round) {
        ctx.beginPath();
        ctx.arc(0, 0, size * 0.5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.rotate((t[i].rot * Math.PI) / 180);
        ctx.fillRect(-size / 2, -size / 2, size, size);
      }
      ctx.restore();
    }
    ctx.restore();
  }

  /** Ring radius in blocks and how strongly the truth is showing, 0..1. */
  private revealState(s: RenderState): { radius: number; strength: number } | null {
    if (s.sonarAge === null) return null;
    const age = s.sonarAge;
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
    st: RenderState,
    reveal: { radius: number; strength: number } | null,
    pulse: number,
  ) {
    const { ctx } = this;
    let alpha = o.alpha ?? 1;
    let outline: string | null = null;

    // The ping speaks about the play layer only: scenery drops back, hazards
    // light up, and the one spike drawn at 15% opacity comes all the way in.
    // Orbs, pads, portals and checkpoints are already honest, and lighting
    // them up would add noise to the one quiet moment in the level.
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

    // Size comes from the projection rather than from a scale, so the back
    // layer's parallax falls out of the same code the play layer uses.
    const left = sx(o.x);
    const right = sx(o.x + o.w);
    const topY = sy(o.y + o.h);
    const botY = sy(o.y);
    const cx = (left + right) / 2;
    const cy = (topY + botY) / 2;
    const w = right - left;
    const h = botY - topY;
    /** One block, in this layer's pixels. */
    const S = o.w > 0 ? w / o.w : o.h > 0 ? h / o.h : 1;

    /** Whether this frame can afford to shade a face rather than fill it. */
    const lit = this.quality > 0.2;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    if (o.rot) ctx.rotate((o.rot * Math.PI) / 180);

    // Scenery recedes toward whatever is *behind* it — which on a dark level
    // means the background colour and on a bright one means black. Mixing a
    // near-white building toward a near-white sky, as this used to, makes the
    // whole back layer vanish; the island and the museum are lit like day.
    const bright = luma(pal.bg[0]) + luma(pal.bg[1]) > 1;
    const behind = bright ? "#101018" : pal.bg[1];
    const sink = bright ? 0.5 : 0.65;
    const hazardColor = o.color ??
      (o.back ? mix(pal.hazard, behind, sink) : mix(pal.hazard, "#ffffff", pulse * 0.6));
    const solidColor = o.color ??
      (o.back ? mix(pal.solid, behind, sink) : mix(pal.solid, "#ffffff", pulse * 0.4));

    switch (o.kind) {
      case "spike": {
        ctx.beginPath();
        ctx.moveTo(-w / 2, h / 2);
        ctx.lineTo(w / 2, h / 2);
        ctx.lineTo(0, -h / 2);
        ctx.closePath();
        // A spike has two faces and the light is off to one side, so they
        // cannot be the same colour. Lit on the left, shadowed on the right —
        // the same convention the ground lip and the blocks are lit by.
        ctx.fillStyle = o.back || !lit
          ? hazardColor
          : this.cached(`sp|${hazardColor}|${Math.round(w)}`, () => {
              const face = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
              face.addColorStop(0, mix(hazardColor, "#ffffff", 0.24));
              face.addColorStop(0.46, hazardColor);
              face.addColorStop(1, mix(hazardColor, "#000000", 0.34));
              return face;
            });
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
        // A specular flick down the lit edge. One line, and it is the whole
        // difference between a triangle and a piece of metal.
        if (!o.back && lit && w > 6) {
          ctx.strokeStyle = rgba("#ffffff", 0.4);
          ctx.lineWidth = Math.max(1, w * 0.045);
          ctx.beginPath();
          ctx.moveTo(-w * 0.16, h * 0.16);
          ctx.lineTo(-w * 0.03, -h * 0.34);
          ctx.stroke();
        }
        break;
      }
      case "block": {
        // Lit along the top, falling into shadow at the bottom. Flat fills
        // are why vector platformers read as paper; one ramp per face is why
        // this one reads as a wall with a light above it.
        ctx.fillStyle = o.back || !lit ? solidColor : this.shade(solidColor, h, 0.22);
        ctx.fillRect(-w / 2, -h / 2, w, h);
        if (!o.back && lit) {
          // The lit top edge and the shadow it casts on whatever is under it.
          const lip = Math.max(1, Math.min(3, h * 0.06));
          ctx.fillStyle = rgba("#ffffff", 0.2);
          ctx.fillRect(-w / 2, -h / 2, w, lip);
          ctx.fillStyle = "rgba(0,0,0,0.22)";
          ctx.fillRect(-w / 2, h / 2 - lip, w, lip);
        }
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
        // The blur of a blade that is actually turning. Drawn before the
        // teeth and not rotated with them, so the disc reads as a solid
        // spinning thing rather than as a shape being stepped round a circle.
        if (!o.back && r > 5 && this.quality > 0.4) {
          ctx.fillStyle = this.cached(`sm|${hazardColor}|${Math.round(r)}`, () => {
            const smear = ctx.createRadialGradient(0, 0, r * 0.5, 0, 0, r * 1.05);
            smear.addColorStop(0, rgba(hazardColor, 0));
            smear.addColorStop(0.72, rgba(hazardColor, 0.3));
            smear.addColorStop(1, rgba(hazardColor, 0));
            return smear;
          });
          ctx.beginPath();
          ctx.arc(0, 0, r * 1.05, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.rotate(st.time * 6 + o.x);
        if (outline) ctx.fillStyle = outline;
        else if (o.back || !lit) ctx.fillStyle = hazardColor;
        else {
          // Ground steel: bright where the light hits the top-left of the
          // disc, dark on the far side of it.
          ctx.fillStyle = this.cached(`mt|${hazardColor}|${Math.round(r)}`, () => {
            const metal = ctx.createLinearGradient(-r, -r, r, r);
            metal.addColorStop(0, mix(hazardColor, "#ffffff", 0.45));
            metal.addColorStop(0.5, hazardColor);
            metal.addColorStop(1, mix(hazardColor, "#000000", 0.42));
            return metal;
          });
        }
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
        // Three bolt holes in the hub. Turning with the blade, they are what
        // tells you at a glance that the thing is spinning at all.
        if (!o.back && lit && r > 8) {
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          for (let i = 0; i < 3; i++) {
            const a = (i / 3) * Math.PI * 2;
            ctx.beginPath();
            ctx.arc(Math.cos(a) * r * 0.2, Math.sin(a) * r * 0.2, r * 0.07, 0, Math.PI * 2);
            ctx.fill();
          }
        }
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
        // Drawn as a doorway near the floor, whatever the trigger's height.
        // The box is deliberately tall enough that nothing can jump over it
        // (see `Builder.portal`); a twelve-block ellipse would be a silo.
        const gate = Math.min(h, S * 3.4);
        const lift = h / 2 - gate / 2;
        ctx.strokeStyle = pal.accent;
        ctx.lineWidth = 5;
        ctx.shadowBlur = 30;
        ctx.shadowColor = pal.accent;
        ctx.beginPath();
        ctx.ellipse(0, lift, w * 0.45, gate * 0.5, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case "coin": {
        if (st.collected.has(o.x)) break;
        const r = Math.min(w, h) / 2;
        const spin = st.time * 2.4;
        // A halo that does not turn, so the coin is still findable at the
        // moment the disc is edge-on and two pixels wide.
        ctx.fillStyle = this.cached(`cn|${Math.round(r)}`, () => {
          const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 2.6);
          glow.addColorStop(0, "rgba(255,212,0,0.5)");
          glow.addColorStop(0.5, "rgba(255,212,0,0.14)");
          glow.addColorStop(1, "rgba(255,212,0,0)");
          return glow;
        });
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
        if (!st.showCheckpoints) break;
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
    land: number,
  ) {
    const { ctx } = this;
    const cx = sx(p.x);
    const cy = sy(p.y + 0.5);
    ctx.save();
    ctx.translate(cx, cy);
    // A halo under the icon. Without it the player disappears into the noise
    // in the bright sections, and "where am I" is not the puzzle this level
    // is trying to set.
    ctx.fillStyle = this.cached(`hl|${Math.round(S)}`, () => {
      const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, S * 1.8);
      halo.addColorStop(0, "rgba(255,255,255,0.72)");
      halo.addColorStop(0.42, "rgba(255,255,255,0.2)");
      halo.addColorStop(1, "rgba(255,255,255,0)");
      return halo;
    });
    ctx.beginPath();
    ctx.arc(0, 0, S * 1.8, 0, Math.PI * 2);
    ctx.fill();
    if (land > 0.01 && (p.mode === "cube" || p.mode === "ball")) {
      // Hardest at the moment of impact, springing back as it decays. The
      // squash is vertical whichever way gravity is pulling, because either
      // way the thing it hit is under its feet.
      const k = 0.32 * land * land;
      ctx.scale(1 + k, 1 - k);
    }
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
