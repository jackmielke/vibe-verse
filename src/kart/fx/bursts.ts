/**
 * Vibe Kart — one-shot bursts.
 *
 * Each recipe below is a *composite*. That is the whole thesis of the file: no
 * single particle population reads as an event. An explosion that is only a
 * fireball looks like a sprite; an explosion that is a flash, a fireball, a
 * shockwave, a debris field, a rising smoke column and a scorch ring — each
 * with its own lifetime and its own easing — reads as a detonation. The cost of
 * the extra populations is a hundred instances in a ring buffer that already
 * exists, which is nothing, and the payoff is the difference between a demo and
 * a game.
 *
 * Layering rules used consistently here:
 *   1. The **flash** is the shortest-lived thing and the brightest. Two frames.
 *   2. The **body** carries the colour and lasts a third of a second.
 *   3. The **shockwave** leaves fast, decelerates, and is gone before the body.
 *   4. The **debris and smoke** outlive everything and sell the scale.
 */
import * as THREE from "three";
import type { VfxBurst } from "../types";
import { TILE } from "./atlas";
import { FX_COLORS } from "./palette";
import { writeParticleColor as color } from "./emitters";
import { between, spend, sym, type FxStage } from "./stage";

const nrm = new THREE.Vector3();
const tanA = new THREE.Vector3();
const tanB = new THREE.Vector3();
const dir = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const SIDE = new THREE.Vector3(1, 0, 0);

/** Build an orthonormal frame around `normal` into `nrm`/`tanA`/`tanB`. */
function frame(normal: THREE.Vector3 | undefined): void {
  nrm.copy(normal ?? UP);
  if (nrm.lengthSq() < 1e-6) nrm.copy(UP);
  nrm.normalize();
  tanA.copy(Math.abs(nrm.y) > 0.94 ? SIDE : UP).cross(nrm).normalize();
  tanB.copy(nrm).cross(tanA).normalize();
}

/**
 * A direction in the hemisphere around `nrm`, biased toward the normal by
 * `lift` (0 = flat along the surface, 1 = straight out). Written into `dir`.
 */
function hemisphere(rng: () => number, lift: number): void {
  const ang = rng() * 6.283185;
  const flat = Math.sqrt(1 - lift * lift) * (0.4 + rng() * 0.6);
  dir.set(0, 0, 0)
    .addScaledVector(tanA, Math.cos(ang) * flat)
    .addScaledVector(tanB, Math.sin(ang) * flat)
    .addScaledVector(nrm, lift * (0.5 + rng() * 0.9));
}

export function playBurst(
  stage: FxStage,
  kind: VfxBurst,
  position: THREE.Vector3,
  normal: THREE.Vector3 | undefined,
  scale: number,
): void {
  frame(normal);
  const s = scale > 0 ? scale : 1;
  switch (kind) {
    case "impact":
      impact(stage, position, s);
      break;
    case "explosion":
      explosion(stage, position, s);
      break;
    case "boostFlame":
      boostFlame(stage, position, s);
      break;
    case "landing":
      landing(stage, position, s);
      break;
    case "splash":
      splash(stage, position, s);
      break;
    case "coin":
      coin(stage, position, s);
      break;
    case "itemBox":
      itemBox(stage, position, s);
      break;
    case "smokePuff":
      smokePuff(stage, position, s);
      break;
    case "shockwave":
      shockwave(stage, position, s);
      break;
    case "confetti":
      confetti(stage, position, s);
      break;
  }
}

// ---------------------------------------------------------------------------

/** Metal on metal, or a kart on a wall. Sparks that bounce, not sparks that fly. */
function impact(stage: FxStage, pos: THREE.Vector3, s: number): void {
  const rng = stage.rng;
  const batch = stage.additive;
  const p = batch.p;

  const n = spend(stage, Math.round(20 * s * stage.density));
  for (let i = 0; i < n; i++) {
    hemisphere(rng, 0.35 + rng() * 0.5);
    const v = between(rng, 5, 15) * s;
    p.px = pos.x;
    p.py = pos.y;
    p.pz = pos.z;
    p.vx = dir.x * v + sym(rng) * 1.5;
    p.vy = dir.y * v + sym(rng) * 1.5 + 1.5;
    p.vz = dir.z * v + sym(rng) * 1.5;
    p.life = between(rng, 0.18, 0.5);
    p.size0 = between(rng, 0.09, 0.17) * s;
    p.size1 = 0.02;
    const hot = i % 3 === 0;
    color(
      p,
      hot ? FX_COLORS.impactCore : FX_COLORS.impactHue,
      hot ? 5.5 : 3.2,
      FX_COLORS.impactEmber,
      0.5,
      1,
      0,
    );
    p.tile = TILE.spark;
    p.rot = 0;
    p.spin = 0;
    p.drag = between(rng, 1.4, 3);
    p.gravity = -17;
    p.stretch = 0.04;
    p.flutter = 0;
    batch.emit();
  }

  // A puff of pulverised paint so the sparks have something to sit against.
  const dustN = spend(stage, Math.round(5 * s * stage.density));
  const dust = stage.alpha;
  const dp = dust.p;
  for (let i = 0; i < dustN; i++) {
    hemisphere(rng, 0.7);
    dp.px = pos.x + dir.x * 0.2;
    dp.py = pos.y + dir.y * 0.2;
    dp.pz = pos.z + dir.z * 0.2;
    dp.vx = dir.x * 2.5;
    dp.vy = dir.y * 2.5 + 0.8;
    dp.vz = dir.z * 2.5;
    dp.life = between(rng, 0.4, 0.8);
    dp.size0 = 0.2 * s;
    dp.size1 = 1.1 * s;
    color(dp, FX_COLORS.blastSmokeA, 1.2, FX_COLORS.blastSmokeA, 0.7, 0.3, 0);
    dp.tile = TILE.smoke;
    dp.rot = rng() * 6.283;
    dp.spin = sym(rng) * 1.2;
    dp.drag = 3;
    dp.gravity = 0.6;
    dp.stretch = 0;
    dp.flutter = 0;
    dust.emit();
  }

  stage.rings.spawn(pos, nrm, 0.1 * s, 1.6 * s, 0.25, 1.4, 1.1, 0.7, 0.7, TILE.ring, 0.04);
}

/** A bob-omb. The most expensive effect in the game, and it should look it. */
function explosion(stage: FxStage, pos: THREE.Vector3, s: number): void {
  const rng = stage.rng;
  const add = stage.additive;
  const p = add.p;
  const density = stage.density;

  // 1 — the flash. Three concentric glows, two frames long, no colour to speak
  // of. This is what makes the eye read "detonation" before anything expands.
  for (let i = 0; i < 3; i++) {
    if (spend(stage, 1) === 0) break;
    p.px = pos.x;
    p.py = pos.y;
    p.pz = pos.z;
    p.vx = p.vy = p.vz = 0;
    p.life = 0.1 + i * 0.05;
    p.size0 = (1.4 + i * 1.6) * s;
    p.size1 = (4.5 + i * 3.2) * s;
    color(p, FX_COLORS.blastFlash, 9 - i * 2.5, FX_COLORS.blastCore, 1.5, 1, 0);
    p.tile = TILE.glow;
    p.rot = 0;
    p.spin = 0;
    p.drag = 1;
    p.gravity = 0;
    p.stretch = 0;
    p.flutter = 0;
    add.emit();
  }

  // 2 — the fireball: rolling tongues that rise and burn down to soot.
  const fire = spend(stage, Math.round(24 * s * density));
  for (let i = 0; i < fire; i++) {
    hemisphere(rng, 0.15 + rng() * 0.85);
    const v = between(rng, 3, 11) * s;
    p.px = pos.x + dir.x * 0.3 * s;
    p.py = pos.y + dir.y * 0.3 * s;
    p.pz = pos.z + dir.z * 0.3 * s;
    p.vx = dir.x * v;
    p.vy = dir.y * v + 2.5;
    p.vz = dir.z * v;
    p.life = between(rng, 0.3, 0.7);
    p.size0 = between(rng, 0.6, 1.3) * s;
    p.size1 = between(rng, 1.6, 3.0) * s;
    // Kept off the ceiling on purpose: at 5× everything tone-maps to white and
    // the fireball loses its orange. The flash above is what carries the punch.
    color(p, FX_COLORS.blastCore, 3.4, FX_COLORS.blastMid, 0.8, 1, 0);
    // Billowing, not licking: a fireball is a turbulent volume, and the smoke
    // silhouette carries that far better than a rotated flame tongue does.
    p.tile = i % 3 === 0 ? TILE.glow : TILE.smoke;
    p.rot = rng() * 6.283;
    p.spin = sym(rng) * 3;
    p.drag = between(rng, 2.2, 4);
    p.gravity = 3.5;
    p.stretch = 0;
    p.flutter = 0;
    add.emit();
  }

  // 3 — sparks, thrown further than anything else and streaked hard.
  const sparks = spend(stage, Math.round(34 * s * density));
  for (let i = 0; i < sparks; i++) {
    hemisphere(rng, 0.2 + rng() * 0.8);
    const v = between(rng, 9, 26) * s;
    p.px = pos.x;
    p.py = pos.y;
    p.pz = pos.z;
    p.vx = dir.x * v;
    p.vy = dir.y * v + 4;
    p.vz = dir.z * v;
    p.life = between(rng, 0.4, 1.1);
    p.size0 = between(rng, 0.07, 0.16) * s;
    p.size1 = 0.02;
    color(p, FX_COLORS.impactCore, 5, FX_COLORS.impactEmber, 0.4, 1, 0);
    p.tile = TILE.spark;
    p.rot = 0;
    p.spin = 0;
    p.drag = between(rng, 0.9, 2.2);
    p.gravity = -18;
    p.stretch = 0.045;
    p.flutter = 0;
    add.emit();
  }

  // 4 — the smoke column. Long-lived, slow, and the reason the blast still
  // exists two seconds later when the camera has caught up with it.
  const alpha = stage.alpha;
  const ap = alpha.p;
  const smoke = spend(stage, Math.round(30 * s * density));
  for (let i = 0; i < smoke; i++) {
    hemisphere(rng, 0.1 + rng() * 0.9);
    const v = between(rng, 1.5, 6) * s;
    ap.px = pos.x + dir.x * 0.4 * s;
    ap.py = pos.y + dir.y * 0.4 * s;
    ap.pz = pos.z + dir.z * 0.4 * s;
    ap.vx = dir.x * v;
    ap.vy = dir.y * v + 1.6;
    ap.vz = dir.z * v;
    ap.life = between(rng, 1.3, 2.6);
    ap.size0 = between(rng, 0.7, 1.4) * s;
    ap.size1 = between(rng, 3.5, 6.5) * s;
    const t = rng();
    color(ap, FX_COLORS.blastSmokeA, 1 - t * 0.4, FX_COLORS.blastSmokeB, 0.8, 0.72, 0);
    ap.tile = TILE.smoke;
    ap.rot = rng() * 6.283;
    ap.spin = sym(rng) * 0.9;
    ap.drag = 1.5;
    ap.gravity = 1.4;
    ap.stretch = 0;
    ap.flutter = 0;
    alpha.emit();
  }

  // 5 — debris. Solid, spinning, gravity-bound, and it lands.
  const debris = spend(stage, Math.round(22 * s * density));
  for (let i = 0; i < debris; i++) {
    hemisphere(rng, 0.3 + rng() * 0.7);
    const v = between(rng, 6, 18) * s;
    ap.px = pos.x;
    ap.py = pos.y;
    ap.pz = pos.z;
    ap.vx = dir.x * v;
    ap.vy = dir.y * v + 5;
    ap.vz = dir.z * v;
    ap.life = between(rng, 1.1, 2.2);
    ap.size0 = between(rng, 0.12, 0.3) * s;
    ap.size1 = ap.size0 * 0.8;
    color(ap, FX_COLORS.blastDebris, 1, FX_COLORS.blastDebris, 0.6, 1, 0);
    ap.tile = TILE.shard;
    ap.rot = rng() * 6.283;
    ap.spin = sym(rng) * 14;
    ap.drag = 0.5;
    ap.gravity = -20;
    ap.stretch = 0;
    ap.flutter = 0;
    alpha.emit();
  }

  // 6 — the pressure front and the scorch it leaves.
  stage.rings.spawn(pos, nrm, 0.6 * s, 6.5 * s, 0.45, 3.2, 2.6, 1.6, 0.95, TILE.ring, 0.08);
  stage.rings.spawn(pos, nrm, 0.3 * s, 3.2 * s, 0.26, 4.5, 3.4, 1.2, 0.6, TILE.glow, 0.06);
  stage.dustRings.spawn(pos, nrm, 1.0 * s, 4.4 * s, 1.4, 0.06, 0.05, 0.045, 0.28, TILE.ring, 0.03);
}

/** A jet of flame along `nrm` — mini-turbo release, mushroom, boost pad. */
function boostFlame(stage: FxStage, pos: THREE.Vector3, s: number): void {
  const rng = stage.rng;
  const add = stage.additive;
  const p = add.p;

  const n = spend(stage, Math.round(26 * s * stage.density));
  for (let i = 0; i < n; i++) {
    hemisphere(rng, 0.75 + rng() * 0.25);
    const v = between(rng, 6, 16) * s;
    p.px = pos.x;
    p.py = pos.y;
    p.pz = pos.z;
    p.vx = dir.x * v;
    p.vy = dir.y * v;
    p.vz = dir.z * v;
    p.life = between(rng, 0.14, 0.34);
    p.size0 = between(rng, 0.35, 0.7) * s;
    p.size1 = 0.06;
    color(p, FX_COLORS.turboCore, 5, FX_COLORS.turboMid, 1.2, 1, 0);
    p.tile = i % 3 === 0 ? TILE.glow : TILE.flame;
    p.rot = rng() * 6.283;
    p.spin = sym(rng) * 6;
    p.drag = 5;
    p.gravity = 2.5;
    p.stretch = 0.012;
    p.flutter = 0;
    add.emit();
  }
  stage.rings.spawn(pos, nrm, 0.25 * s, 3.4 * s, 0.36, 1.2, 2.4, 4.2, 0.85, TILE.ring, 0.05);
}

/** Wheels hitting the deck: a flat ring of dust, thrown outward, not upward. */
function landing(stage: FxStage, pos: THREE.Vector3, s: number): void {
  const rng = stage.rng;
  const alpha = stage.alpha;
  const p = alpha.p;

  const n = spend(stage, Math.round(24 * s * stage.density));
  for (let i = 0; i < n; i++) {
    // Deliberately flat: `lift` near zero throws the dust along the ground,
    // which is what an impact does. A vertical puff reads as a smoke bomb.
    hemisphere(rng, 0.12 + rng() * 0.16);
    const v = between(rng, 3.5, 9) * s;
    p.px = pos.x + dir.x * 0.3;
    p.py = pos.y + 0.05;
    p.pz = pos.z + dir.z * 0.3;
    p.vx = dir.x * v;
    p.vy = Math.abs(dir.y) * v + 0.8;
    p.vz = dir.z * v;
    p.life = between(rng, 0.5, 1.1);
    p.size0 = between(rng, 0.3, 0.6) * s;
    p.size1 = between(rng, 1.6, 2.8) * s;
    color(p, FX_COLORS.landing, 1, FX_COLORS.landing, 0.6, 0.42, 0);
    p.tile = TILE.dust;
    p.rot = rng() * 6.283;
    p.spin = sym(rng) * 1.1;
    p.drag = 3.4;
    p.gravity = 0.5;
    p.stretch = 0;
    p.flutter = 0;
    alpha.emit();
  }
  stage.dustRings.spawn(pos, nrm, 0.35 * s, 2.8 * s, 0.5, 0.55, 0.5, 0.44, 0.5, TILE.ring, 0.04);
}

/** Water. Droplets that fall, a crown at the contact point, a ripple that stays. */
function splash(stage: FxStage, pos: THREE.Vector3, s: number): void {
  const rng = stage.rng;
  const alpha = stage.alpha;
  const p = alpha.p;

  const n = spend(stage, Math.round(34 * s * stage.density));
  for (let i = 0; i < n; i++) {
    hemisphere(rng, 0.45 + rng() * 0.5);
    const v = between(rng, 3, 10) * s;
    p.px = pos.x;
    p.py = pos.y + 0.05;
    p.pz = pos.z;
    p.vx = dir.x * v;
    p.vy = Math.abs(dir.y) * v + 2.5;
    p.vz = dir.z * v;
    p.life = between(rng, 0.35, 0.85);
    p.size0 = between(rng, 0.1, 0.24) * s;
    p.size1 = p.size0 * 0.7;
    color(p, FX_COLORS.coinCore, 1.1, FX_COLORS.landing, 0.9, 0.85, 0);
    p.tile = TILE.drop;
    p.rot = rng() * 6.283;
    p.spin = sym(rng) * 2;
    p.drag = 0.9;
    p.gravity = -19;
    p.stretch = 0.012;
    p.flutter = 0;
    alpha.emit();
  }

  if (spend(stage, 1) > 0) {
    p.px = pos.x;
    p.py = pos.y + 0.05;
    p.pz = pos.z;
    p.vx = p.vz = 0;
    p.vy = 1.2;
    p.life = 0.36;
    p.size0 = 0.5 * s;
    p.size1 = 1.9 * s;
    color(p, FX_COLORS.coinCore, 1.2, FX_COLORS.landing, 0.8, 0.8, 0);
    p.tile = TILE.crown;
    p.rot = 0;
    p.spin = 0;
    p.drag = 3;
    p.gravity = -2;
    p.stretch = 0;
    p.flutter = 0;
    alpha.emit();
  }
  stage.rings.spawn(pos, nrm, 0.3 * s, 3.2 * s, 0.9, 0.9, 1.1, 1.3, 0.55, TILE.ring, 0.02);
}

/** A coin pickup: gold, quick, and gone before it can clutter the screen. */
function coin(stage: FxStage, pos: THREE.Vector3, s: number): void {
  const rng = stage.rng;
  const add = stage.additive;
  const p = add.p;

  const n = spend(stage, Math.round(16 * s * stage.density));
  for (let i = 0; i < n; i++) {
    const ang = (i / Math.max(1, n)) * 6.283 + rng() * 0.5;
    const v = between(rng, 1.6, 4.5) * s;
    p.px = pos.x;
    p.py = pos.y;
    p.pz = pos.z;
    p.vx = Math.cos(ang) * v;
    p.vy = between(rng, 1.5, 4.5);
    p.vz = Math.sin(ang) * v;
    p.life = between(rng, 0.3, 0.6);
    p.size0 = between(rng, 0.12, 0.26) * s;
    p.size1 = 0.02;
    color(p, FX_COLORS.coinCore, 4, FX_COLORS.coin, 1.2, 1, 0);
    p.tile = i % 2 === 0 ? TILE.sparkle : TILE.glow;
    p.rot = rng() * 6.283;
    p.spin = sym(rng) * 5;
    p.drag = 2.6;
    p.gravity = -5;
    p.stretch = 0;
    p.flutter = 0;
    add.emit();
  }

  if (spend(stage, 1) > 0) {
    p.px = pos.x;
    p.py = pos.y;
    p.pz = pos.z;
    p.vx = p.vy = p.vz = 0;
    p.life = 0.22;
    p.size0 = 0.5 * s;
    p.size1 = 1.5 * s;
    color(p, FX_COLORS.coinCore, 3.5, FX_COLORS.coin, 0.6, 0.9, 0);
    p.tile = TILE.glow;
    p.rot = 0;
    p.spin = 0;
    p.drag = 1;
    p.gravity = 0;
    p.stretch = 0;
    p.flutter = 0;
    add.emit();
  }
}

/** An item box shattering: coloured glass, a sparkle cloud, a snap of a ring. */
function itemBox(stage: FxStage, pos: THREE.Vector3, s: number): void {
  const rng = stage.rng;
  const alpha = stage.alpha;
  const ap = alpha.p;

  const shards = spend(stage, Math.round(20 * s * stage.density));
  for (let i = 0; i < shards; i++) {
    hemisphere(rng, rng() * 2 - 1);
    const v = between(rng, 3, 9) * s;
    ap.px = pos.x;
    ap.py = pos.y;
    ap.pz = pos.z;
    ap.vx = dir.x * v;
    ap.vy = dir.y * v + 2.5;
    ap.vz = dir.z * v;
    ap.life = between(rng, 0.5, 1.1);
    ap.size0 = between(rng, 0.1, 0.22) * s;
    ap.size1 = ap.size0 * 0.6;
    const cool = rng() < 0.5;
    color(ap, cool ? FX_COLORS.boxA : FX_COLORS.boxB, 1.6, cool ? FX_COLORS.boxA : FX_COLORS.boxB, 0.4, 0.95, 0);
    ap.tile = TILE.shard;
    ap.rot = rng() * 6.283;
    ap.spin = sym(rng) * 16;
    ap.drag = 1.1;
    ap.gravity = -14;
    ap.stretch = 0;
    ap.flutter = 0;
    alpha.emit();
  }

  const add = stage.additive;
  const p = add.p;
  const sparkles = spend(stage, Math.round(18 * s * stage.density));
  for (let i = 0; i < sparkles; i++) {
    hemisphere(rng, rng() * 2 - 1);
    const v = between(rng, 2, 7) * s;
    p.px = pos.x;
    p.py = pos.y;
    p.pz = pos.z;
    p.vx = dir.x * v;
    p.vy = dir.y * v + 1.5;
    p.vz = dir.z * v;
    p.life = between(rng, 0.25, 0.55);
    p.size0 = between(rng, 0.14, 0.3) * s;
    p.size1 = 0.02;
    color(p, FX_COLORS.blastFlash, 3.6, i % 2 ? FX_COLORS.boxA : FX_COLORS.boxB, 1, 1, 0);
    p.tile = TILE.sparkle;
    p.rot = rng() * 6.283;
    p.spin = sym(rng) * 7;
    p.drag = 3;
    p.gravity = -3;
    p.stretch = 0;
    p.flutter = 0;
    add.emit();
  }
  stage.rings.spawn(pos, nrm, 0.2 * s, 2.6 * s, 0.3, 1.6, 2.2, 2.8, 0.8, TILE.ring, 0.02);
}

/** Cheap connective tissue — respawns, near-misses, anything needing a beat. */
function smokePuff(stage: FxStage, pos: THREE.Vector3, s: number): void {
  const rng = stage.rng;
  const alpha = stage.alpha;
  const p = alpha.p;
  const n = spend(stage, Math.round(8 * s * stage.density));
  for (let i = 0; i < n; i++) {
    hemisphere(rng, 0.4 + rng() * 0.6);
    p.px = pos.x + dir.x * 0.2 * s;
    p.py = pos.y + dir.y * 0.2 * s;
    p.pz = pos.z + dir.z * 0.2 * s;
    p.vx = dir.x * 2.2 * s;
    p.vy = dir.y * 2.2 * s + 1;
    p.vz = dir.z * 2.2 * s;
    p.life = between(rng, 0.7, 1.4);
    p.size0 = between(rng, 0.35, 0.7) * s;
    p.size1 = between(rng, 1.8, 3.2) * s;
    color(p, FX_COLORS.blastSmokeA, 1.2, FX_COLORS.blastSmokeA, 0.7, 0.4, 0);
    p.tile = TILE.smoke;
    p.rot = rng() * 6.283;
    p.spin = sym(rng) * 1;
    p.drag = 2;
    p.gravity = 1;
    p.stretch = 0;
    p.flutter = 0;
    alpha.emit();
  }
}

/** A bare pressure front — lightning, a horn, the start lights going out. */
function shockwave(stage: FxStage, pos: THREE.Vector3, s: number): void {
  stage.rings.spawn(pos, nrm, 0.4 * s, 7 * s, 0.5, 2.2, 2.4, 2.8, 0.9, TILE.ring, 0.06);
  const rng = stage.rng;
  const add = stage.additive;
  const p = add.p;
  const n = spend(stage, Math.round(10 * s * stage.density));
  for (let i = 0; i < n; i++) {
    hemisphere(rng, 0.1);
    const v = between(rng, 8, 18) * s;
    p.px = pos.x;
    p.py = pos.y;
    p.pz = pos.z;
    p.vx = dir.x * v;
    p.vy = dir.y * v;
    p.vz = dir.z * v;
    p.life = 0.3;
    p.size0 = 0.4 * s;
    p.size1 = 0.1;
    color(p, FX_COLORS.blastFlash, 2.2, FX_COLORS.blastCore, 0.3, 0.6, 0);
    p.tile = TILE.wisp;
    p.rot = 0;
    p.spin = 0;
    p.drag = 4;
    p.gravity = 0;
    p.stretch = 0.05;
    p.flutter = 0;
    add.emit();
  }
}

/** The chequered flag. Long-lived, fluttering, and it lands on the track. */
function confetti(stage: FxStage, pos: THREE.Vector3, s: number): void {
  const rng = stage.rng;
  const alpha = stage.alpha;
  const p = alpha.p;
  const palette = FX_COLORS.confetti;

  const n = spend(stage, Math.round(150 * s * stage.density));
  for (let i = 0; i < n; i++) {
    const ang = rng() * 6.283;
    const rad = rng() * 6 * s;
    p.px = pos.x + Math.cos(ang) * rad;
    p.py = pos.y + between(rng, 0, 4) * s;
    p.pz = pos.z + Math.sin(ang) * rad;
    p.vx = Math.cos(ang) * between(rng, 1, 5) + sym(rng) * 2;
    p.vy = between(rng, 3, 10);
    p.vz = Math.sin(ang) * between(rng, 1, 5) + sym(rng) * 2;
    p.life = between(rng, 3.2, 6.5);
    p.size0 = between(rng, 0.12, 0.24);
    p.size1 = p.size0;
    const c = palette[(rng() * palette.length) | 0];
    color(p, c, 1.15, c, 0.85, 1, 0);
    p.tile = TILE.confetti;
    p.rot = rng() * 6.283;
    p.spin = sym(rng) * 11;
    p.drag = 1.6;
    p.gravity = -3.2;
    p.stretch = 0;
    // The flutter is the effect. Confetti that falls in a straight line is
    // rain with a nicer palette.
    p.flutter = between(rng, 0.35, 1.1);
    alpha.emit();
  }
}
