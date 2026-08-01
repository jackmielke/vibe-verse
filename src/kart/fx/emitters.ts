/**
 * Vibe Kart — continuous per-racer emitters.
 *
 * `updateRacerFx` runs once per racer per frame and turns `RacerState` into
 * particles. It is the busiest function in the module and therefore the one
 * with the strictest rule: **it must not allocate**. Every vector, colour and
 * temporary it needs lives at module scope; every emission goes through the
 * batch's shared parameter struct. A racer emitting three hundred particles a
 * second for four minutes has to cost the garbage collector exactly nothing.
 *
 * What comes out of it, in the order a player notices it:
 *
 * · **Drift sparks.** The signature. Two populations from the inside rear
 *   wheel — a short white-hot core and a longer tier-coloured streak — plus a
 *   soft glow bed underneath them for the bloom to catch. Blue, orange, purple.
 * · **Tyre smoke**, tinted by whatever the tyre is standing on.
 * · **Surface spray**, from a per-surface look table: dirt plumes, torn grass,
 *   sand, water droplets with a ripple, sparks off metal.
 * · **Skid marks**, laid by distance so the texel density is speed-independent.
 * · **Boost**, exhaust flame plus forward-stretched speed particles.
 * · **Star power**, a rainbow ribbon and a sparkle cloud.
 *
 * Everything is rate-based with an accumulator, so emission is frame-rate
 * independent: dropping to 30 fps halves the number of update calls and doubles
 * the particles each one emits, and the plume looks identical.
 */
import * as THREE from "three";
import { TUNING, type MiniTurboTier, type RacerState, type SurfaceKind, type SurfaceSample } from "../types";
import { TILE } from "./atlas";
import { DRIFT_TIERS, FX_COLORS, SKID_LOOKS, SURFACE_LOOKS, rainbowAt } from "./palette";
import { TrailWriter, type RibbonPool } from "./ribbons";
import { between, clamp01, spend, sym, type FxStage } from "./stage";

/** A wheel in racer-local space, as published by the models system. */
export interface WheelLocal {
  x: number;
  y: number;
  z: number;
  radius: number;
}

/** Everything the emitters need that they cannot read off `RacerState`. */
export interface RacerFx {
  id: number;
  /** Local wheel anchors; null until the models system has a rig for us. */
  wheels: WheelLocal[] | null;
  /** Exhaust tip nodes, read for their world matrices. */
  exhausts: THREE.Object3D[] | null;
  /** Seconds until we ask the models system for anchors again. */
  anchorRetry: number;
  /** `ctx.elapsed` of the last tick — the once-per-frame guard. */
  stamp: number;

  sparkAcc: number;
  glowAcc: number;
  smokeAcc: number;
  sprayAcc: number;
  flameAcc: number;
  speedAcc: number;
  starAcc: number;
  rippleCooldown: number;

  skid: TrailWriter[];
  trail: TrailWriter;
  trailPhase: number;

  prevBoost: number;
  prevStar: number;
  prevTier: MiniTurboTier;
  prevDrifting: boolean;
}

export function makeRacerFx(id: number, skidPool: RibbonPool, starPool: RibbonPool): RacerFx {
  return {
    id,
    wheels: null,
    exhausts: null,
    anchorRetry: 0,
    stamp: -1,
    sparkAcc: 0,
    glowAcc: 0,
    smokeAcc: 0,
    sprayAcc: 0,
    flameAcc: 0,
    speedAcc: 0,
    starAcc: 0,
    rippleCooldown: 0,
    // 0.34 m between cross-sections: fine enough that a hairpin's mark curves
    // instead of faceting, coarse enough that a 2400-quad ring holds two full
    // laps of a drifting field.
    skid: [new TrailWriter(skidPool, 0.34, 1.1), new TrailWriter(skidPool, 0.34, 1.1)],
    trail: new TrailWriter(starPool, 0.5, 3.2),
    trailPhase: 0,
    prevBoost: 0,
    prevStar: 0,
    prevTier: 0,
    prevDrifting: false,
  };
}

// ---------------------------------------------------------------------------
// Module-scope scratch. Nothing below this line may call `new`.
// ---------------------------------------------------------------------------

const fwd = new THREE.Vector3();
const right = new THREE.Vector3();
const up = new THREE.Vector3();
const contact = new THREE.Vector3();
const anchorPos = new THREE.Vector3();
const groundNormal = new THREE.Vector3();
const tint = new THREE.Color();

const sample: SurfaceSample = {
  height: 0,
  normal: new THREE.Vector3(0, 1, 0),
  kind: "road",
  onTrack: true,
  lateral: 0,
  t: 0,
};

/** Rear wheels first — everything interesting happens at the back. */
const REAR = [2, 3] as const;

/** Fallback wheel layout when the models system never published a rig. */
const FALLBACK_WHEELS: WheelLocal[] = [
  { x: -0.58, y: 0.3, z: -0.72, radius: TUNING.wheelRadius },
  { x: 0.58, y: 0.3, z: -0.72, radius: TUNING.wheelRadius },
  { x: -0.62, y: 0.32, z: 0.78, radius: TUNING.wheelRadius },
  { x: 0.62, y: 0.32, z: 0.78, radius: TUNING.wheelRadius },
];

/** Surface query hook, supplied by the system so emitters stay service-free. */
export type SurfaceProbe = ((position: THREE.Vector3, out: SurfaceSample) => SurfaceSample) | null;

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export function updateRacerFx(
  fx: RacerFx,
  racer: RacerState,
  dt: number,
  stage: FxStage,
  probe: SurfaceProbe,
): void {
  fwd.set(0, 0, -1).applyQuaternion(racer.quaternion);
  right.set(1, 0, 0).applyQuaternion(racer.quaternion);
  up.set(0, 1, 0).applyQuaternion(racer.quaternion);

  // Distance LOD. A kart eight hundred metres back on the far straight still
  // needs *some* dust so the field reads as alive, but it does not need the
  // player's spark count.
  const camDist = stage.camera.position.distanceTo(racer.position);
  const lod = racer.isPlayer ? 1 : camDist < 30 ? 0.9 : camDist < 70 ? 0.55 : camDist < 140 ? 0.25 : 0.08;
  const density = stage.density * lod;
  if (density <= 0.02) {
    for (const w of fx.skid) w.end();
    fx.trail.end();
    return;
  }

  const speed = Math.abs(racer.speed);
  const speedFrac = clamp01(speed / TUNING.topSpeed);
  const lateral = racer.velocity.dot(right);
  const slip = clamp01(Math.abs(lateral) / 7);

  const look = SURFACE_LOOKS[racer.surface] ?? SURFACE_LOOKS.road;
  groundNormal.copy(racer.groundNormal);
  if (groundNormal.lengthSq() < 1e-5) groundNormal.set(0, 1, 0);

  fx.rippleCooldown = Math.max(0, fx.rippleCooldown - dt);

  const wheels = fx.wheels ?? FALLBACK_WHEELS;

  // A spin-out is a tyre-smoke event whether or not the driver asked for it —
  // the wheels are scrubbing sideways at full speed. Folding the stun into the
  // slip term is cheaper than a second code path and looks the same.
  const scrub = racer.stun > 0 ? Math.max(slip, 0.75) : slip;

  if (racer.grounded) {
    emitSpray(fx, racer, wheels, dt, stage, density, speedFrac, scrub, look, probe);
    emitTyreSmoke(fx, racer, wheels, dt, stage, density, speedFrac, scrub, look);
    if (racer.drifting && racer.stun <= 0) {
      emitDriftSparks(fx, racer, wheels, dt, stage, density, speedFrac, scrub);
    }
    layMarks(fx, racer, wheels, stage, speedFrac, scrub, probe);
  } else {
    for (const w of fx.skid) w.end();
  }

  emitBoost(fx, racer, dt, stage, density, speedFrac);
  emitStar(fx, racer, dt, stage, density);

  fx.prevBoost = racer.boost;
  fx.prevStar = racer.star;
  fx.prevTier = racer.driftTier;
  fx.prevDrifting = racer.drifting;
}

// ---------------------------------------------------------------------------
// Drift sparks — the signature effect
// ---------------------------------------------------------------------------

function emitDriftSparks(
  fx: RacerFx,
  racer: RacerState,
  wheels: WheelLocal[],
  dt: number,
  stage: FxStage,
  density: number,
  speedFrac: number,
  slip: number,
): void {
  const rng = stage.rng;
  const tier = racer.driftTier;
  const look = DRIFT_TIERS[tier];
  const next = DRIFT_TIERS[Math.min(3, tier + 1) as MiniTurboTier];

  // Charge is the *anticipation*: the rate climbs toward the next tier's
  // through the charge window, so the moment before a mini-turbo pops is
  // visibly hotter than the moment after the last one did.
  const charge = clamp01(racer.driftCharge);
  const rate = (look.rate + (next.rate - look.rate) * charge * 0.55) * (0.4 + 0.6 * speedFrac) * density;

  fx.sparkAcc += rate * dt;
  const wantSparks = Math.min(Math.floor(fx.sparkAcc), 80);
  fx.sparkAcc -= wantSparks;
  const nSparks = spend(stage, wantSparks);

  fx.glowAcc += (26 + 46 * charge) * density * dt;
  const wantGlow = Math.min(Math.floor(fx.glowAcc), 10);
  fx.glowAcc -= wantGlow;
  const nGlow = spend(stage, wantGlow);

  const dir = racer.driftDir === 0 ? (lateralSign(racer) as 1 | -1) : racer.driftDir;
  // Inside rear wheel — the one the kart is pivoting around, the one carrying
  // the load, and the one the genre has always thrown sparks off.
  const inside = dir > 0 ? 3 : 2;
  const outside = dir > 0 ? 2 : 3;

  const batch = stage.additive;
  const p = batch.p;
  const streakVel = 5.5 + 13 * speedFrac;

  for (let i = 0; i < nSparks; i++) {
    // Three quarters from the inside wheel, the rest from the outside — a
    // single point source reads as a bug, two weighted ones read as a kart.
    const wi = rng() < 0.78 ? inside : outside;
    const w = wheels[wi] ?? wheels[wheels.length - 1];
    wheelContact(racer, w);

    const core = i % 3 === 0;
    const jitter = 0.5 + rng() * 0.9;

    p.px = contact.x + sym(rng) * 0.09;
    p.py = contact.y + rng() * 0.1;
    p.pz = contact.z + sym(rng) * 0.09;

    // Sparks leave along the slide, not along the heading: backwards down the
    // kart's axis, outwards along the drift, and up off the contact patch.
    p.vx = -fwd.x * streakVel * jitter + right.x * dir * (1.6 + 2.4 * slip) + up.x * (1.4 + rng() * 2.6);
    p.vy = -fwd.y * streakVel * jitter + right.y * dir * (1.6 + 2.4 * slip) + up.y * (1.4 + rng() * 2.6) + 0.7;
    p.vz = -fwd.z * streakVel * jitter + right.z * dir * (1.6 + 2.4 * slip) + up.z * (1.4 + rng() * 2.6);
    p.vx += sym(rng) * 2.2;
    p.vy += sym(rng) * 1.1;
    p.vz += sym(rng) * 2.2;

    if (core) {
      // Core: tiny, white-hot, gone in a tenth of a second. It is what gives
      // the effect a hard centre instead of a coloured smudge.
      p.life = between(rng, 0.09, 0.18);
      p.size0 = look.size * 0.7;
      p.size1 = look.size * 0.2;
      writeColor(p, look.core, look.intensity * 1.6, look.hue, look.intensity * 1.0, 1, 0.9);
      p.stretch = 0.055;
    } else {
      p.life = between(rng, 0.22, 0.48);
      p.size0 = look.size * (0.8 + rng() * 0.7);
      p.size1 = look.size * 0.12;
      writeColor(p, look.hue, look.intensity, look.ember, look.intensity * 0.25, 1, 0);
      // Heavy screen-space stretch is the difference between a swarm of dots
      // and a spray of sparks: at 15 m/s these draw as 30 cm streaks.
      p.stretch = 0.14;
    }
    p.tile = TILE.spark;
    p.rot = rng() * 6.283;
    p.spin = 0;
    p.drag = between(rng, 1.8, 3.4);
    p.gravity = -13;
    p.flutter = 0;
    batch.emit();
  }

  // A soft bed of glow under the sparks. Without it the sparks are a swarm of
  // dots; with it the wheel arch actually looks lit from inside.
  for (let i = 0; i < nGlow; i++) {
    const w = wheels[inside] ?? wheels[wheels.length - 1];
    wheelContact(racer, w);
    p.px = contact.x + sym(rng) * 0.14;
    p.py = contact.y + 0.06 + rng() * 0.12;
    p.pz = contact.z + sym(rng) * 0.14;
    p.vx = -fwd.x * 1.6 + up.x * 0.8;
    p.vy = -fwd.y * 1.6 + up.y * 0.8 + 0.5;
    p.vz = -fwd.z * 1.6 + up.z * 0.8;
    p.life = between(rng, 0.16, 0.32);
    p.size0 = look.size * 3.8;
    p.size1 = look.size * 6.4;
    // Kept well under the sparks' exposure: the bed is there to give them a
    // coloured floor to sit on, not to become the effect.
    writeColor(p, look.hue, look.intensity * 0.3, look.hue, 0, 0.55, 0);
    p.tile = TILE.glow;
    p.rot = rng() * 6.283;
    p.spin = 0;
    p.drag = 5;
    p.gravity = 0.4;
    p.stretch = 0;
    p.flutter = 0;
    batch.emit();
  }
}

// ---------------------------------------------------------------------------
// Tyre smoke
// ---------------------------------------------------------------------------

function emitTyreSmoke(
  fx: RacerFx,
  racer: RacerState,
  wheels: WheelLocal[],
  dt: number,
  stage: FxStage,
  density: number,
  speedFrac: number,
  slip: number,
  look: (typeof SURFACE_LOOKS)[SurfaceKind],
): void {
  const heat = racer.drifting ? Math.max(slip, 0.55) : slip;
  if (heat < 0.16 || speedFrac < 0.1) return;

  const rng = stage.rng;
  const rate = look.smokeRate * heat * (0.35 + 0.65 * speedFrac) * density;
  fx.smokeAcc += rate * dt;
  const want = Math.min(Math.floor(fx.smokeAcc), 12);
  fx.smokeAcc -= want;
  const n = spend(stage, want);
  if (n === 0) return;

  const batch = stage.alpha;
  const p = batch.p;
  for (let i = 0; i < n; i++) {
    const w = wheels[REAR[i & 1]] ?? wheels[wheels.length - 1];
    wheelContact(racer, w);
    p.px = contact.x + sym(rng) * 0.22;
    p.py = contact.y + 0.1 + rng() * 0.18;
    p.pz = contact.z + sym(rng) * 0.22;
    // Smoke is left behind, so it barely inherits the kart's velocity — a
    // plume that keeps pace with the kart looks welded to the bodywork.
    p.vx = -fwd.x * (1.2 + speedFrac * 3.4) + sym(rng) * 0.9;
    p.vy = 0.7 + rng() * 0.9;
    p.vz = -fwd.z * (1.2 + speedFrac * 3.4) + sym(rng) * 0.9;
    p.life = between(rng, 0.85, 1.7);
    p.size0 = look.size * between(rng, 0.7, 1.15);
    p.size1 = look.size * between(rng, 3.4, 5.2);
    const bright = 0.85 + rng() * 0.3;
    writeColor(p, look.smoke, bright, look.smoke, bright * 0.55, 0.34 * heat, 0);
    p.tile = look.smokeTile;
    p.rot = rng() * 6.283;
    p.spin = sym(rng) * 0.7;
    p.drag = 1.35;
    p.gravity = 0.55;
    p.stretch = 0;
    p.flutter = 0;
    batch.emit();
  }
}

// ---------------------------------------------------------------------------
// Surface spray
// ---------------------------------------------------------------------------

function emitSpray(
  fx: RacerFx,
  racer: RacerState,
  wheels: WheelLocal[],
  dt: number,
  stage: FxStage,
  density: number,
  speedFrac: number,
  slip: number,
  look: (typeof SURFACE_LOOKS)[SurfaceKind],
  probe: SurfaceProbe,
): void {
  if (look.rate <= 0 || speedFrac < 0.05) return;

  const rng = stage.rng;
  // Off-road you throw material simply by rolling; slip multiplies it. That
  // ordering matters — a straight-line dirt section should still smoke.
  const drive = 0.4 + 0.6 * slip;
  const rate = look.rate * speedFrac * drive * density;
  fx.sprayAcc += rate * dt;
  const want = Math.min(Math.floor(fx.sprayAcc), 26);
  fx.sprayAcc -= want;
  const n = spend(stage, want);
  if (n === 0) return;

  const batch = look.additive ? stage.additive : stage.alpha;
  const p = batch.p;
  const throwSpeed = look.speed * (0.45 + 0.85 * speedFrac);

  for (let i = 0; i < n; i++) {
    // Seven of ten off the rear (the rooster tail), the rest off the fronts so
    // the kart looks like it is ploughing rather than trailing.
    const wi = rng() < 0.7 ? REAR[i & 1] : i & 1;
    const w = wheels[wi] ?? wheels[wheels.length - 1];
    wheelContact(racer, w);
    if (probe) {
      const s = probe(contact, sample);
      contact.y = s.height + 0.03;
    }

    p.px = contact.x + sym(rng) * 0.2;
    p.py = contact.y + rng() * 0.08;
    p.pz = contact.z + sym(rng) * 0.2;

    const back = throwSpeed * between(rng, 0.5, 1.15);
    const lift = throwSpeed * between(rng, 0.45, 1.0);
    p.vx = -fwd.x * back + up.x * lift + right.x * lateralSign(racer) * slip * 3.2 + sym(rng) * 1.6;
    p.vy = -fwd.y * back + up.y * lift + right.y * lateralSign(racer) * slip * 3.2 + 0.6;
    p.vz = -fwd.z * back + up.z * lift + right.z * lateralSign(racer) * slip * 3.2 + sym(rng) * 1.6;

    p.life = between(rng, 0.4, 1.05);
    const sz = look.size * between(rng, 0.55, 1.25);
    p.size0 = sz;
    p.size1 = look.additive ? sz * 0.2 : sz * 1.5;
    const mix = rng();
    tint.copy(look.sprayA).lerp(look.sprayB, mix);
    writeColor(p, tint, look.additive ? 2.4 : 1, tint, look.additive ? 0.3 : 0.6, look.additive ? 1 : 0.9, 0);
    p.tile = look.sprayTile;
    p.rot = rng() * 6.283;
    p.spin = sym(rng) * look.spin;
    p.drag = look.drag;
    p.gravity = look.gravity;
    p.stretch = look.stretch;
    p.flutter = 0;
    batch.emit();
  }

  // Water gets a wake: an expanding ripple where the wheels break the surface,
  // throttled so a straight through a ford is not a strobe of rings.
  if (look.ripple && fx.rippleCooldown <= 0 && speedFrac > 0.2) {
    fx.rippleCooldown = 0.14;
    const w = wheels[REAR[0]] ?? wheels[0];
    wheelContact(racer, w);
    if (probe) contact.y = probe(contact, sample).height + 0.02;
    stage.rings.spawn(
      contact,
      groundNormal,
      0.25,
      1.6 + speedFrac * 1.8,
      0.75,
      look.smoke.r,
      look.smoke.g,
      look.smoke.b,
      0.5,
      TILE.ring,
      0.03,
    );
  }
}

// ---------------------------------------------------------------------------
// Skid marks
// ---------------------------------------------------------------------------

function layMarks(
  fx: RacerFx,
  racer: RacerState,
  wheels: WheelLocal[],
  stage: FxStage,
  speedFrac: number,
  slip: number,
  probe: SurfaceProbe,
): void {
  const skidLook = SKID_LOOKS[racer.surface];
  const heat = racer.drifting ? Math.max(slip, 0.5) : slip;
  if (!skidLook || heat < 0.24 || speedFrac < 0.1) {
    for (const w of fx.skid) w.end();
    return;
  }

  const fade = skidLook.opacity * clamp01(heat * 1.25) * clamp01(speedFrac * 2.2);
  for (let i = 0; i < 2; i++) {
    const w = wheels[REAR[i]] ?? wheels[wheels.length - 1];
    wheelContact(racer, w);
    let ny = groundNormal.y;
    if (probe) {
      const s = probe(contact, sample);
      contact.y = s.height;
      ny = s.normal.y;
    }
    // Two centimetres of lift plus the material's polygon offset: enough to
    // clear the tarmac's own normal-mapped relief without floating.
    contact.y += 0.02 * (ny > 0 ? 1 : -1);
    fx.skid[i].extend(contact.x, contact.y, contact.z, right.x, right.y, right.z, 0.17, fade);
  }
}

// ---------------------------------------------------------------------------
// Boost
// ---------------------------------------------------------------------------

function emitBoost(
  fx: RacerFx,
  racer: RacerState,
  dt: number,
  stage: FxStage,
  density: number,
  speedFrac: number,
): void {
  if (racer.boost <= 0) {
    // Idle exhaust: a thread of heat shimmer so the pipes are never dead.
    if (racer.rpm > 0.45 && racer.grounded && stage.quality !== "low") {
      fx.flameAcc += racer.rpm * 5 * density * dt;
      const n = spend(stage, Math.min(Math.floor(fx.flameAcc), 2));
      fx.flameAcc -= n;
      for (let i = 0; i < n; i++) emitExhaustPuff(fx, racer, stage, 0.1, 0.6);
    }
    return;
  }

  const rng = stage.rng;
  const turbo = racer.boostSource === "miniTurbo";
  const coreCol = turbo ? FX_COLORS.turboCore : FX_COLORS.flameCore;
  const midCol = turbo ? FX_COLORS.turboMid : FX_COLORS.flameMid;
  const tailCol = turbo ? FX_COLORS.turboTail : FX_COLORS.flameTail;

  fx.flameAcc += 165 * density * dt;
  const wantFlame = Math.min(Math.floor(fx.flameAcc), 34);
  fx.flameAcc -= wantFlame;
  const nFlame = spend(stage, wantFlame);

  const batch = stage.additive;
  const p = batch.p;
  const exhausts = fx.exhausts;
  const count = exhausts && exhausts.length > 0 ? exhausts.length : 1;

  for (let i = 0; i < nFlame; i++) {
    if (exhausts && exhausts.length > 0) {
      const node = exhausts[i % count];
      node.getWorldPosition(anchorPos);
    } else {
      // No rig: fall back to a point off the back of the body.
      anchorPos.copy(racer.position).addScaledVector(fwd, -1.15).addScaledVector(up, 0.5);
    }

    const jet = 8 + rng() * 11;
    p.px = anchorPos.x + sym(rng) * 0.05;
    p.py = anchorPos.y + sym(rng) * 0.05;
    p.pz = anchorPos.z + sym(rng) * 0.05;
    p.vx = -fwd.x * jet + right.x * sym(rng) * 1.8 + sym(rng) * 0.5;
    p.vy = -fwd.y * jet + sym(rng) * 0.9 + 0.5;
    p.vz = -fwd.z * jet + right.z * sym(rng) * 1.8 + sym(rng) * 0.5;

    const role = i % 5;
    if (role === 0) {
      // Embers, thrown further than the flame and outliving it.
      p.life = between(rng, 0.24, 0.5);
      p.size0 = 0.08;
      p.size1 = 0.02;
      writeColor(p, coreCol, 3.6, tailCol, 0.6, 1, 0);
      p.tile = TILE.ember;
      p.stretch = 0.1;
      p.drag = 2;
      p.gravity = -3.5;
    } else if (role === 1) {
      // The soft cone the flame tongues live inside. Without this bed the
      // afterburner is a handful of separate sprites, not a plume.
      p.life = between(rng, 0.18, 0.34);
      p.size0 = between(rng, 0.5, 0.85);
      p.size1 = between(rng, 1.0, 1.6);
      writeColor(p, midCol, 1.35, tailCol, 0.25, 0.6, 0);
      p.tile = TILE.glow;
      p.stretch = 0;
      p.drag = 3.6;
      p.gravity = 1.4;
    } else {
      // The flame itself is short-lived and grows *down* in size: a plume that
      // expands as it leaves reads as smoke, not as combustion.
      // The tongue *widens* as it leaves and dies by opacity rather than by
      // shrinking. Shrinking makes the plume a point; widening makes it a cone.
      p.life = between(rng, 0.22, 0.44);
      p.size0 = between(rng, 0.26, 0.5);
      p.size1 = p.size0 * 1.6;
      // Authored on the *mantle* colour, not the core: additive blending
      // already blows the dense middle to white, so starting from white
      // instead only costs the plume its blue.
      writeColor(p, midCol, 3.4, tailCol, 0.55, 1, 0);
      p.tile = TILE.flame;
      p.stretch = 0.03;
      p.drag = 3.2;
      p.gravity = 2.2;
    }
    p.rot = rng() * 6.283;
    p.spin = sym(rng) * 5;
    p.flutter = 0;
    batch.emit();
  }

  // Forward-stretched speed particles streaming past the bodywork. These are
  // the world-space half of the speed read; the post stack owns the
  // screen-space lines.
  if (stage.quality !== "low") {
    fx.speedAcc += 55 * density * dt;
    const want = Math.min(Math.floor(fx.speedAcc), 12);
    fx.speedAcc -= want;
    const n = spend(stage, want);
    for (let i = 0; i < n; i++) {
      const ang = rng() * 6.283;
      const rad = 0.7 + rng() * 1.5;
      p.px = racer.position.x + Math.cos(ang) * rad + fwd.x * between(rng, -1, 2.5);
      p.py = racer.position.y + 0.25 + rng() * 1.1;
      p.pz = racer.position.z + Math.sin(ang) * rad + fwd.z * between(rng, -1, 2.5);
      p.vx = -fwd.x * (16 + 26 * speedFrac);
      p.vy = -fwd.y * (16 + 26 * speedFrac);
      p.vz = -fwd.z * (16 + 26 * speedFrac);
      p.life = between(rng, 0.16, 0.32);
      p.size0 = between(rng, 0.14, 0.3);
      p.size1 = 0.03;
      writeColor(p, coreCol, 1.8, midCol, 0.25, 0.8, 0);
      p.tile = TILE.wisp;
      p.rot = 0;
      p.spin = 0;
      p.drag = 0.6;
      p.gravity = 0;
      p.stretch = 0.09;
      p.flutter = 0;
      batch.emit();
    }
  }
}

/** One lazy curl of exhaust heat, used at idle and while coasting. */
function emitExhaustPuff(fx: RacerFx, racer: RacerState, stage: FxStage, size: number, alpha: number): void {
  const rng = stage.rng;
  if (fx.exhausts && fx.exhausts.length > 0) {
    fx.exhausts[(rng() * fx.exhausts.length) | 0].getWorldPosition(anchorPos);
  } else {
    anchorPos.copy(racer.position).addScaledVector(fwd, -0.95).addScaledVector(up, 0.28);
  }
  const batch = stage.alpha;
  const p = batch.p;
  p.px = anchorPos.x;
  p.py = anchorPos.y;
  p.pz = anchorPos.z;
  p.vx = -fwd.x * 1.6 + sym(rng) * 0.3;
  p.vy = 0.9 + rng() * 0.5;
  p.vz = -fwd.z * 1.6 + sym(rng) * 0.3;
  p.life = between(rng, 0.4, 0.8);
  p.size0 = size;
  p.size1 = size * 6;
  writeColor(p, FX_COLORS.blastSmokeA, 1.1, FX_COLORS.blastSmokeA, 0.8, alpha * 0.16, 0);
  p.tile = TILE.smoke;
  p.rot = rng() * 6.283;
  p.spin = sym(rng) * 0.6;
  p.drag = 2.2;
  p.gravity = 0.8;
  p.stretch = 0;
  p.flutter = 0;
  batch.emit();
}

// ---------------------------------------------------------------------------
// Star power
// ---------------------------------------------------------------------------

function emitStar(fx: RacerFx, racer: RacerState, dt: number, stage: FxStage, density: number): void {
  if (racer.star <= 0) {
    fx.trail.end();
    return;
  }

  const rng = stage.rng;
  fx.trailPhase += dt * 0.9;

  // The ribbon: laid a metre behind the tail, banked with the kart, wide
  // enough to read at speed and narrow enough not to hide the bodywork.
  contact
    .copy(racer.position)
    .addScaledVector(fwd, -1.15)
    .addScaledVector(up, 0.55);
  fx.trail.extend(contact.x, contact.y, contact.z, right.x, right.y, right.z, 0.7, 1);

  fx.starAcc += 115 * density * dt;
  const want = Math.min(Math.floor(fx.starAcc), 22);
  fx.starAcc -= want;
  const n = spend(stage, want);
  if (n === 0) return;

  const batch = stage.additive;
  const p = batch.p;
  for (let i = 0; i < n; i++) {
    const ang = rng() * 6.283;
    const rad = 0.4 + rng() * 1.0;
    p.px = racer.position.x + Math.cos(ang) * rad;
    p.py = racer.position.y + 0.1 + rng() * 1.0;
    p.pz = racer.position.z + Math.sin(ang) * rad;
    p.vx = -fwd.x * between(rng, 1, 5) + sym(rng) * 1.4;
    p.vy = between(rng, 0.4, 2.2);
    p.vz = -fwd.z * between(rng, 1, 5) + sym(rng) * 1.4;
    p.life = between(rng, 0.35, 0.75);
    p.size0 = between(rng, 0.2, 0.44);
    p.size1 = 0.02;
    // Hue walks with time rather than being random per particle: a random
    // rainbow is confetti, a walking one is a shimmer.
    const hue = rainbowAt(fx.trailPhase + i * 0.07);
    // Hot white for a heartbeat, then the hue — a sparkle that is coloured
    // from birth never reads as a *spark*, only as a dot.
    writeColor(p, FX_COLORS.starCore, 2.2, hue, 1.8, 1, 0);
    p.tile = i % 3 === 0 ? TILE.sparkle : TILE.glow;
    p.rot = rng() * 6.283;
    p.spin = sym(rng) * 4;
    p.drag = 2.4;
    p.gravity = 1.2;
    p.stretch = 0;
    p.flutter = 0;
    batch.emit();
  }
}

// ---------------------------------------------------------------------------
// World-space wind streaks
// ---------------------------------------------------------------------------

const windDir = new THREE.Vector3();
const windSide = new THREE.Vector3();
const windUp = new THREE.Vector3();

/**
 * Streaks tearing past the camera at high speed. Emitted in a tube around the
 * view axis and given a velocity straight down it, so they read as air being
 * displaced rather than as particles orbiting the kart.
 */
export function updateWindStreaks(
  stage: FxStage,
  dt: number,
  speedFrac: number,
  accumulator: number,
): number {
  if (stage.quality === "low") return 0;
  const drive = clamp01((speedFrac - 0.68) / 0.32);
  if (drive <= 0) return 0;

  const rng = stage.rng;
  const cam = stage.camera;
  cam.getWorldDirection(windDir);
  windSide.set(windDir.z, 0, -windDir.x).normalize();
  windUp.copy(windSide).cross(windDir).normalize();

  let acc = accumulator + drive * 90 * stage.density * dt;
  const want = Math.min(Math.floor(acc), 14);
  acc -= want;
  const n = spend(stage, want);

  const batch = stage.alpha;
  const p = batch.p;
  for (let i = 0; i < n; i++) {
    // A ring, not a disc: streaks in the middle of the screen sit on the kart
    // and read as dirt on the lens.
    const ang = rng() * 6.283;
    const rad = between(rng, 2.6, 7.5);
    const ahead = between(rng, 4, 26);
    const ox = windSide.x * Math.cos(ang) * rad + windUp.x * Math.sin(ang) * rad;
    const oy = windSide.y * Math.cos(ang) * rad + windUp.y * Math.sin(ang) * rad;
    const oz = windSide.z * Math.cos(ang) * rad + windUp.z * Math.sin(ang) * rad;
    p.px = cam.position.x + windDir.x * ahead + ox;
    p.py = cam.position.y + windDir.y * ahead + oy;
    p.pz = cam.position.z + windDir.z * ahead + oz;
    const back = between(rng, 34, 62) * (0.6 + drive * 0.7);
    p.vx = -windDir.x * back;
    p.vy = -windDir.y * back;
    p.vz = -windDir.z * back;
    p.life = between(rng, 0.16, 0.34);
    p.size0 = between(rng, 0.18, 0.42);
    p.size1 = p.size0 * 0.6;
    writeColor(p, FX_COLORS.wind, 1, FX_COLORS.wind, 1, 0.12 * drive, 0);
    p.tile = TILE.wisp;
    p.rot = 0;
    p.spin = 0;
    p.drag = 0.2;
    p.gravity = 0;
    p.stretch = 0.06;
    p.flutter = 0;
    batch.emit();
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** World-space contact patch of a local wheel, written into `contact`. */
function wheelContact(racer: RacerState, w: WheelLocal): void {
  contact.set(w.x, w.y, w.z).applyQuaternion(racer.quaternion).add(racer.position);
  contact.addScaledVector(up, -w.radius * 0.94);
}

/** Which way the kart is sliding, as a sign, with 1 as the tie-break. */
function lateralSign(racer: RacerState): number {
  const l = racer.velocity.dot(right);
  return l > 0.05 ? 1 : l < -0.05 ? -1 : 1;
}

/** Write a birth/death colour pair with an exposure on each end. */
function writeColor(
  p: { r0: number; g0: number; b0: number; a0: number; r1: number; g1: number; b1: number; a1: number },
  c0: THREE.Color,
  i0: number,
  c1: THREE.Color,
  i1: number,
  a0: number,
  a1: number,
): void {
  p.r0 = c0.r * i0;
  p.g0 = c0.g * i0;
  p.b0 = c0.b * i0;
  p.a0 = a0;
  p.r1 = c1.r * i1;
  p.g1 = c1.g * i1;
  p.b1 = c1.b * i1;
  p.a1 = a1;
}

export { writeColor as writeParticleColor };
