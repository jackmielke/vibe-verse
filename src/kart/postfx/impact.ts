/**
 * The hit layer: what the screen does when something happens to you.
 *
 * Mario Kart's item feedback is almost entirely full-screen. Lightning is a
 * white blowout, a Blooper is ink across the windscreen, a shell is a
 * desaturating wobble, a Star is a rainbow bloom on everything. None of it is
 * subtle and none of it is optional — it is how a player who is looking at the
 * corner ahead learns that they have been hit.
 *
 * This file owns two things: the little state machine that turns discrete
 * events into continuous, *eased* 0..1 amounts (nothing here is allowed to pop
 * on or cut off — everything has an attack, a hold and a release), and the
 * procedurally generated ink splat the composite samples.
 */
import * as THREE from "three";
import type { Rng } from "../types";

export type ImpactKind = "flash" | "ink" | "stun" | "shock" | "star";

interface Channel {
  /** Current eased amount, 0..1 — what the shader reads. */
  value: number;
  /** Target the attack ramps toward. */
  peak: number;
  /** Seconds left in the whole event. */
  remaining: number;
  /** Total duration, for computing the envelope phase. */
  duration: number;
  /** Fraction of the duration spent ramping up. */
  attack: number;
}

function makeChannel(): Channel {
  return { value: 0, peak: 0, remaining: 0, duration: 1, attack: 0.12 };
}

function fire(ch: Channel, peak: number, duration: number, attack: number): void {
  // Re-triggering never *reduces* an effect in flight — being hit twice reads
  // as worse, not as a reset to a shorter timer. A channel that has already
  // expired starts clean, so a short flash after a long one is short.
  const live = ch.remaining > 0;
  ch.peak = live ? Math.max(ch.peak, peak) : peak;
  ch.remaining = live ? Math.max(ch.remaining, duration) : duration;
  ch.duration = live ? Math.max(ch.duration, ch.remaining) : duration;
  ch.attack = attack;
}

/** Cubic ease-out — fast in, gentle settle. The shape of every hit in the game. */
function easeOut(x: number): number {
  const t = 1 - Math.min(Math.max(x, 0), 1);
  return 1 - t * t * t;
}

function advance(ch: Channel, dt: number): void {
  if (ch.remaining <= 0) {
    ch.value = 0;
    ch.peak = 0;
    return;
  }
  ch.remaining = Math.max(0, ch.remaining - dt);
  const phase = 1 - ch.remaining / Math.max(ch.duration, 1e-4);
  if (phase < ch.attack) {
    ch.value = ch.peak * easeOut(phase / Math.max(ch.attack, 1e-4));
  } else {
    const release = (phase - ch.attack) / Math.max(1 - ch.attack, 1e-4);
    // Squared release: a long soft tail rather than a linear fade, which is
    // what stops a stun from ending on an obvious step.
    ch.value = ch.peak * (1 - release) * (1 - release);
  }
  if (ch.remaining <= 0) {
    ch.value = 0;
    ch.peak = 0;
  }
}

export interface ImpactState {
  flash: number;
  flashColor: THREE.Color;
  ink: number;
  /** 0..1 through the ink's life — drives the splat growth and the drip. */
  inkPhase: number;
  stun: number;
  shock: number;
  star: number;
}

/** Per-kind envelopes. Durations are in seconds and were tuned by feel. */
const PRESETS: Record<ImpactKind, { peak: number; duration: number; attack: number }> = {
  flash: { peak: 1, duration: 0.55, attack: 0.06 },
  ink: { peak: 1, duration: 3.4, attack: 0.07 },
  stun: { peak: 1, duration: 1.35, attack: 0.1 },
  shock: { peak: 1, duration: 1.1, attack: 0.04 },
  star: { peak: 1, duration: 7.5, attack: 0.03 },
};

export class ImpactMixer {
  readonly state: ImpactState = {
    flash: 0,
    flashColor: new THREE.Color(1, 1, 1),
    ink: 0,
    inkPhase: 0,
    stun: 0,
    shock: 0,
    star: 0,
  };

  private readonly channels: Record<ImpactKind, Channel> = {
    flash: makeChannel(),
    ink: makeChannel(),
    stun: makeChannel(),
    shock: makeChannel(),
    star: makeChannel(),
  };

  trigger(kind: ImpactKind, opts: { strength?: number; duration?: number; color?: number } = {}): void {
    const preset = PRESETS[kind];
    const strength = Math.min(Math.max(opts.strength ?? 1, 0), 1) * preset.peak;
    fire(this.channels[kind], strength, opts.duration ?? preset.duration, preset.attack);
    if (kind === "flash" && opts.color !== undefined) this.state.flashColor.setHex(opts.color);
  }

  /** Cancel everything — respawns, race restarts, pausing into a menu. */
  clear(): void {
    for (const key of Object.keys(this.channels) as ImpactKind[]) {
      const ch = this.channels[key];
      ch.value = 0;
      ch.peak = 0;
      ch.remaining = 0;
    }
    this.state.flash = 0;
    this.state.ink = 0;
    this.state.stun = 0;
    this.state.shock = 0;
    this.state.star = 0;
  }

  update(dt: number): void {
    for (const key of Object.keys(this.channels) as ImpactKind[]) advance(this.channels[key], dt);
    const s = this.state;
    s.flash = this.channels.flash.value;
    s.ink = this.channels.ink.value;
    s.stun = this.channels.stun.value;
    s.shock = this.channels.shock.value;
    s.star = this.channels.star.value;
    const inkCh = this.channels.ink;
    s.inkPhase = inkCh.duration > 0 ? 1 - inkCh.remaining / inkCh.duration : 0;
  }
}

// ---------------------------------------------------------------------------
// The ink splat
// ---------------------------------------------------------------------------

/**
 * A metaball splat with a noisy boundary, baked once into a 256² texture.
 *
 * Two channels do the work:
 *   · **red** — coverage. Soft-edged so the ink has a wet meniscus rather than
 *     a cut-out silhouette.
 *   · **green** — arrival time, 0 at the impact centre and 1 at the furthest
 *     satellite droplet. The shader reveals coverage where `green < phase`,
 *     which makes the splat *land* — a hit at the middle of the windscreen
 *     that throws out tendrils — instead of fading up as a whole image.
 *
 * The boundary noise is three sinusoid octaves in polar angle rather than a
 * value-noise lattice: it costs nothing, it is continuous across the seam at
 * ±π by construction, and tendrils are an angular phenomenon anyway.
 */
export function bakeInkTexture(rng: Rng, size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);

  interface Blob {
    x: number;
    y: number;
    r: number;
    /** Per-blob angular noise phases and amplitudes. */
    p1: number;
    p2: number;
    p3: number;
    wobble: number;
    delay: number;
  }

  const blobs: Blob[] = [];
  // One dominant central mass, offset a little so it never looks like a target.
  const cx = 0.5 + (rng() - 0.5) * 0.16;
  const cy = 0.52 + (rng() - 0.5) * 0.16;
  blobs.push({
    x: cx,
    y: cy,
    r: 0.3,
    p1: rng() * 6.283,
    p2: rng() * 6.283,
    p3: rng() * 6.283,
    wobble: 0.3,
    delay: 0,
  });

  // Lobes: big secondary masses fused into the main body.
  for (let i = 0; i < 6; i++) {
    const a = rng() * Math.PI * 2;
    const d = 0.16 + rng() * 0.16;
    blobs.push({
      x: cx + Math.cos(a) * d,
      y: cy + Math.sin(a) * d * 0.85,
      r: 0.1 + rng() * 0.11,
      p1: rng() * 6.283,
      p2: rng() * 6.283,
      p3: rng() * 6.283,
      wobble: 0.42,
      delay: 0.18 + rng() * 0.3,
    });
  }

  // Droplets: small, detached, and late. These are what sell it as a splat.
  for (let i = 0; i < 16; i++) {
    const a = rng() * Math.PI * 2;
    const d = 0.26 + rng() * 0.3;
    blobs.push({
      x: cx + Math.cos(a) * d,
      y: cy + Math.sin(a) * d * 0.9,
      r: 0.012 + rng() * 0.045,
      p1: rng() * 6.283,
      p2: rng() * 6.283,
      p3: rng() * 6.283,
      wobble: 0.5,
      delay: 0.4 + rng() * 0.6,
    });
  }

  for (let py = 0; py < size; py++) {
    const v = (py + 0.5) / size;
    for (let px = 0; px < size; px++) {
      const u = (px + 0.5) / size;

      // Metaball accumulation: the max of each blob's field, plus a fraction of
      // the sum so overlapping blobs fuse with a fillet instead of a crease.
      let field = 0;
      let sum = 0;
      let delay = 1;
      for (let i = 0; i < blobs.length; i++) {
        const b = blobs[i];
        const dx = u - b.x;
        const dy = v - b.y;
        const d2 = dx * dx + dy * dy;
        // Reject before the transcendentals. A blob's radius never exceeds
        // r·(1+wobble), so anything beyond that contributes exactly zero — and
        // skipping it turns a 1.5-million-atan2 bake into a few milliseconds.
        const reach = b.r * (1 + b.wobble);
        if (d2 > reach * reach) continue;
        const dist = Math.sqrt(d2);
        const ang = Math.atan2(dy, dx);
        // Angular noise on the radius — tendrils and a ragged rim.
        const wob =
          Math.sin(ang * 3 + b.p1) * 0.55 +
          Math.sin(ang * 7 + b.p2) * 0.3 +
          Math.sin(ang * 13 + b.p3) * 0.15;
        const radius = b.r * (1 + wob * b.wobble);
        const f = radius <= 0 ? 0 : Math.max(0, 1 - dist / radius);
        const contrib = f * f;
        sum += contrib;
        if (contrib > field) {
          field = contrib;
          delay = b.delay;
        }
      }
      const merged = Math.min(field + sum * 0.22, 1.4);

      // Soft threshold. The 0.06 band is the wet edge; a hard step here reads
      // as a decal sticker.
      const t = (merged - 0.16) / 0.14;
      const coverage = Math.min(Math.max(t, 0), 1);
      const smooth = coverage * coverage * (3 - 2 * coverage);

      const i4 = (py * size + px) * 4;
      data[i4 + 0] = Math.round(smooth * 255);
      data[i4 + 1] = Math.round(Math.min(Math.max(delay, 0), 1) * 255);
      data[i4 + 2] = 0;
      data[i4 + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, size, size);
  tex.name = "KartInkSplat";
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
