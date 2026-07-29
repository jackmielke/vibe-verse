/**
 * grapple.ts — the hook.
 *
 * This is the most important system in the game. Everything else is scenery
 * for it. The design goal is the Just Cause loop: you should be able to leave
 * the Transamerica spike and never touch the ground again, because the hook
 * always gives you a way to convert altitude into speed and speed back into
 * altitude.
 *
 * The model, in order of how much it matters:
 *
 *  1. **Reel** — an acceleration toward the anchor, capped by `maxReelSpeed`,
 *     with a deliberate upward bias when the anchor is above you. Without that
 *     bias reeling onto a roof drags your face along the wall for the last ten
 *     metres, which is the single most common way a grapple feels bad.
 *
 *  2. **Tether/swing** — a soft spring plus a hard radial clamp. The spring
 *     alone stretches visibly under a 60 m/s load; the clamp alone is a rigid
 *     constraint that pops. Together you get a rope with give that still
 *     never lets you fall through the arc.
 *
 *  3. **Release boost** — cutting at the bottom of a swing multiplies your
 *     speed by up to `GRAPPLE.releaseBoost` and adds a lick of lift. This is
 *     the skill expression: a well-timed cut out of a swing is worth more
 *     than reeling in a straight line, so good players chain arcs.
 *
 *  4. **Object↔object tethers** — the signature. Fire once at a thing, once
 *     at another thing, and the line between them retracts until they meet.
 *     Vehicle-to-ground, enemy-to-vehicle, streetlamp-to-helicopter. This is
 *     implemented as an impulse pair applied at the contact points each frame
 *     with a rest length that shrinks, which is both stable and, importantly,
 *     visibly *violent* — Rapier resolves the interpenetration for us.
 *
 * Anchors are stored as a body-local offset, not a world point, so a tether
 * into a moving truck stays in the truck.
 *
 * The whole system degrades gracefully before Rapier boots: hooks fall back to
 * an analytic terrain march against `sfGeo`, so you can grapple the hillside
 * on the very first frame and nothing throws.
 *
 * Public API
 * ----------
 *   grappleSystem                       the singleton
 *   .fire(mode?) / .link() / .retract(slot) / .cutAll(boost?)
 *   .setReeling(on)                     hold-to-reel
 *   .update(dt)                         advances hook flight + world tethers
 *   .applyToPlayer(dt, pos, vel)        the forces on the player capsule
 *   .tethers / .worldTethers            read by Grapple.tsx
 *   .onImpact(cb)                       hook bites — rumble, audio, decals
 *   .onTetherPull(cb)                   AI hook for tethered characters
 */
import * as THREE from "three";
import type * as RAPIER from "@dimforge/rapier3d-compat";
import { GRAPPLE, PLAYER } from "../config";
import { frame, type TetherState } from "../state/store";
import { terrainHeight } from "../geo/sfGeo";
import { clamp, clamp01 } from "../math/rng";
import {
  GROUP,
  interactionGroups,
  makeRayHit,
  playerController,
  raycast,
  type PhysicsObject,
  type RayHit,
  type SurfaceTag,
} from "../physics";

/**
 * What the hook can bite.
 *
 * Deliberately *not* `QUERY_ALL`: that mask includes the player group, and the
 * muzzle sits 42 cm in front of the eye — inside the player's own capsule.
 * With Rapier's solid-ray default that scores a hit at t = 0 and every shot
 * lands on your own chest. Excluding the group and the collider both is belt
 * and braces, because this failure mode is silent and total.
 */
const HOOK_QUERY = interactionGroups(
  0xffff,
  GROUP.TERRAIN | GROUP.BUILDING | GROUP.VEHICLE | GROUP.PROP | GROUP.ENEMY |
    GROUP.DEBRIS | GROUP.RAGDOLL,
);

/* ------------------------------------------------------------------ *
 * Tuning that is specific to the hook and does not belong in config.ts
 * ------------------------------------------------------------------ */

/** Shortest usable rope. Below this a swing is just a shove. */
const MIN_LENGTH = 4;
/** How much of the reel accel is redirected upward when the anchor is above. */
const REEL_LIFT = 0.42;
/** Detach when you get this close to the anchor while reeling. */
const ARRIVE_RADIUS = 3.0;
/** Rope stretch (fraction of rest length) before the hard clamp engages. */
const STRETCH_TOLERANCE = 0.045;
/** Rope snaps if you somehow exceed this multiple of max range. */
const BREAK_FACTOR = 1.45;
/** Muzzle offset from the eye: down and to the right, where the gun is. */
const MUZZLE_RIGHT = 0.26;
const MUZZLE_DOWN = 0.19;
const MUZZLE_FWD = 0.42;

/** Object↔object link: spring constant in m/s² per metre of overstretch. */
const LINK_K = 34;
/** How fast a link reels itself in, m/s. This is what drags cars together. */
const LINK_RETRACT = 11;
/** Links stop shrinking here so two bodies do not fight forever. */
const LINK_MIN_REST = 1.1;
/** Hard cap on link acceleration so a tethered lamppost cannot launch a bus. */
const LINK_MAX_ACCEL = 190;
/** Links expire — otherwise the world fills up with invisible rubber bands. */
const LINK_LIFETIME = 26;
export const MAX_WORLD_TETHERS = 4;

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export type TetherMode = "swing" | "reel";

/** Everything about one player tether that `frame.tethers` has no room for. */
export interface RuntimeTether {
  slot: number;
  mode: TetherMode;
  /** Mirror of the shared frame state for this slot. */
  shared: TetherState;
  /** Current hook position — mid-flight or planted. */
  hook: THREE.Vector3;
  /** Where the cable leaves the gun. Recomputed each frame. */
  muzzle: THREE.Vector3;
  /** Body the hook bit into, if it can move. */
  object: PhysicsObject | null;
  /** Anchor in the object's local frame. */
  local: THREE.Vector3;
  /** Flight interpolation. */
  flightFrom: THREE.Vector3;
  flightTo: THREE.Vector3;
  flightT: number;
  flightDuration: number;
  /** True when the shot found nothing and the hook is falling short. */
  missed: boolean;
  /** 0..1 rope load, for the renderer. */
  tension: number;
  /** Transverse vibration amplitude, metres. Decays. */
  vibration: number;
  vibPhase: number;
  /** frame.time at attach — drives the "snap taut" animation. */
  attachedAt: number;
  surface: SurfaceTag;
}

/** One end of an object↔object link. */
export interface TetherEnd {
  object: PhysicsObject | null;
  body: RAPIER.RigidBody | null;
  local: THREE.Vector3;
  world: THREE.Vector3;
  /** True when this end cannot be moved (terrain, building, missing body). */
  fixed: boolean;
}

export interface WorldTether {
  active: boolean;
  a: TetherEnd;
  b: TetherEnd;
  /** Current rest length; shrinks every frame. */
  rest: number;
  /** Length when the link was made — the renderer scales sag against it. */
  initial: number;
  life: number;
  tension: number;
  vibration: number;
  vibPhase: number;
}

export interface HookImpact {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  surface: SurfaceTag;
  object: PhysicsObject | null;
  /** Distance from the muzzle, metres. */
  distance: number;
}

type ImpactHandler = (i: HookImpact) => void;
type PullHandler = (obj: PhysicsObject, px: number, py: number, pz: number) => void;

/* ------------------------------------------------------------------ *
 * Scratch — nothing in this file allocates inside the frame loop
 * ------------------------------------------------------------------ */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _hit: RayHit = makeRayHit();
const _imp: HookImpact = {
  x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0,
  surface: "concrete", object: null, distance: 0,
};
const _rv = { x: 0, y: 0, z: 0 };
const _rp = { x: 0, y: 0, z: 0 };

function makeEnd(): TetherEnd {
  return {
    object: null,
    body: null,
    local: new THREE.Vector3(),
    world: new THREE.Vector3(),
    fixed: true,
  };
}

/* ------------------------------------------------------------------ *
 * The system
 * ------------------------------------------------------------------ */

class GrappleSystem {
  readonly tethers: RuntimeTether[] = [];
  readonly worldTethers: WorldTether[] = [];

  /** True while the player is holding the reel input. */
  private reelHeld = false;
  /** Cooldown between shots, seconds. */
  private cooldown = 0;
  /** Pending first end of an object↔object link. */
  private linkPending: TetherEnd | null = null;
  private linkPendingAt = -100;
  /** Slot to fire into next — round-robin so a second shot never steals the
   *  rope you are currently swinging on unless every slot is full. */
  private nextSlot = 0;

  private impactHandlers: ImpactHandler[] = [];
  private pullHandlers: PullHandler[] = [];

  /** Accumulated reel acceleration this frame, for the HUD/audio. */
  reelIntensity = 0;
  /** Set for one frame when a swing was cut with a boost. */
  boostedRelease = 0;

  constructor() {
    for (let i = 0; i < GRAPPLE.maxTethers; i++) {
      this.tethers.push({
        slot: i,
        mode: "swing",
        // frame.tethers is sized from GRAPPLE.maxTethers by the store; if a
        // future config bump outruns it, own a private state object instead of
        // writing past the end of the shared array.
        shared: frame.tethers[i] ?? {
          active: false,
          anchor: new THREE.Vector3(),
          attachedTo: null,
          length: 0,
          flying: false,
          flyProgress: 0,
          reeling: false,
        },
        hook: new THREE.Vector3(),
        muzzle: new THREE.Vector3(),
        object: null,
        local: new THREE.Vector3(),
        flightFrom: new THREE.Vector3(),
        flightTo: new THREE.Vector3(),
        flightT: 0,
        flightDuration: 0,
        missed: false,
        tension: 0,
        vibration: 0,
        vibPhase: 0,
        attachedAt: -100,
        surface: "concrete",
      });
    }
    for (let i = 0; i < MAX_WORLD_TETHERS; i++) {
      this.worldTethers.push({
        active: false,
        a: makeEnd(),
        b: makeEnd(),
        rest: 0,
        initial: 0,
        life: 0,
        tension: 0,
        vibration: 0,
        vibPhase: 0,
      });
    }
  }

  /* ---------------- subscriptions ---------------- */

  /** Hook bit something. VFX, audio and rumble hang off this. */
  onImpact(cb: ImpactHandler): () => void {
    this.impactHandlers.push(cb);
    return () => {
      const i = this.impactHandlers.indexOf(cb);
      if (i >= 0) this.impactHandlers.splice(i, 1);
    };
  }

  /**
   * A link is pulling on something the physics engine cannot move for us —
   * an enemy on a kinematic capsule, say. The AI system subscribes and decides
   * whether that becomes a stagger, a ragdoll, or a very short flight.
   */
  onTetherPull(cb: PullHandler): () => void {
    this.pullHandlers.push(cb);
    return () => {
      const i = this.pullHandlers.indexOf(cb);
      if (i >= 0) this.pullHandlers.splice(i, 1);
    };
  }

  /* ---------------- queries ---------------- */

  /** Number of tethers currently biting something. */
  get attachedCount(): number {
    let n = 0;
    for (const t of this.tethers) if (t.shared.active && !t.shared.flying) n++;
    return n;
  }

  get anyLoaded(): boolean {
    return this.attachedCount > 0;
  }

  /** True while a link is half-made and waiting for its second shot. */
  get linkArmed(): boolean {
    return this.linkPending !== null;
  }

  /** Direction from the player to the primary anchor — the camera leans on it. */
  primaryAnchorDir(out: THREE.Vector3): boolean {
    for (const t of this.tethers) {
      if (t.shared.active && !t.shared.flying) {
        out.copy(t.shared.anchor).sub(frame.position);
        const l = out.length();
        if (l > 1e-3) out.multiplyScalar(1 / l);
        return true;
      }
    }
    return false;
  }

  /* ---------------- firing ---------------- */

  setReeling(on: boolean): void {
    this.reelHeld = on;
  }

  /**
   * Fire a hook at the crosshair.
   *
   * Returns false when it could not fire at all (cooldown). A shot that finds
   * nothing still *fires* — the hook flies out to full range and falls short,
   * because a grapple that silently does nothing when you miss feels broken.
   */
  fire(mode: TetherMode = "swing"): boolean {
    if (this.cooldown > 0) return false;
    const t = this.pickSlot();
    if (!t) return false;
    this.cooldown = GRAPPLE.cooldown;

    this.computeMuzzle(t.muzzle);
    const found = this.probe(t.muzzle, frame.forward, GRAPPLE.maxRange);

    t.mode = mode;
    t.shared.active = true;
    t.shared.flying = true;
    t.shared.flyProgress = 0;
    t.shared.reeling = false;
    t.shared.attachedTo = null;
    t.flightFrom.copy(t.muzzle);
    t.flightT = 0;
    t.vibration = 0;
    t.tension = 0;
    t.object = null;

    if (found) {
      t.missed = false;
      t.flightTo.set(_hit.px, _hit.py, _hit.pz);
      t.surface = _hit.surface;
      // Store the anchor in the target's local frame so a tether into a truck
      // travels with the truck.
      this.captureLocal(t, _hit.object, _hit.px, _hit.py, _hit.pz);
    } else {
      t.missed = true;
      t.flightTo
        .copy(t.muzzle)
        .addScaledVector(frame.forward, GRAPPLE.maxRange)
        // Missed hooks droop as they run out of line; it reads as weight.
        .addScaledVector(_v.set(0, -1, 0), GRAPPLE.maxRange * 0.06);
      t.surface = "concrete";
    }
    const dist = t.flightFrom.distanceTo(t.flightTo);
    t.flightDuration = Math.max(0.02, dist / GRAPPLE.projectileSpeed);
    t.hook.copy(t.flightFrom);
    t.shared.anchor.copy(t.flightTo);
    t.shared.length = dist;
    return true;
  }

  /**
   * Object↔object link.
   *
   * First call captures whatever is under the crosshair; the second links it
   * to the new target and the rest length starts winding in. Firing at nothing
   * cancels a half-made link, which is the forgiving behaviour: you should be
   * able to abort by shooting the sky.
   */
  link(): boolean {
    if (this.cooldown > 0) return false;
    this.cooldown = GRAPPLE.cooldown;
    this.computeMuzzle(_v2);
    const found = this.probe(_v2, frame.forward, GRAPPLE.maxRange);
    if (!found) {
      this.linkPending = null;
      return false;
    }

    this.emitImpact(_v2);

    const end = makeEnd();
    this.fillEnd(end, _hit.object, _hit.px, _hit.py, _hit.pz);

    if (!this.linkPending) {
      this.linkPending = end;
      this.linkPendingAt = frame.time;
      return true;
    }

    // Two fixed ends would be an invisible no-op — reject rather than pretend.
    const a = this.linkPending;
    this.linkPending = null;
    if (a.fixed && end.fixed) return false;

    const wt = this.worldTethers.find((w) => !w.active) ?? this.oldestWorldTether();
    a.world.copy(a.world);
    wt.active = true;
    copyEnd(wt.a, a);
    copyEnd(wt.b, end);
    wt.rest = wt.a.world.distanceTo(wt.b.world);
    wt.initial = Math.max(1, wt.rest);
    wt.life = LINK_LIFETIME;
    wt.tension = 0;
    wt.vibration = 0.28;
    wt.vibPhase = 0;
    return true;
  }

  /** Retract one tether. No boost — this is the polite release. */
  retract(slot: number): void {
    const t = this.tethers[slot];
    if (!t || !t.shared.active) return;
    this.clear(t);
  }

  /**
   * Cut every tether.
   *
   * With `boost`, a swing released while moving fast and roughly tangentially
   * gets its velocity scaled toward `GRAPPLE.releaseBoost` and a touch of
   * lift. That is the slingshot; it is what makes chaining arcs faster than
   * reeling in a straight line, and therefore what makes traversal a skill.
   */
  cutAll(boost = true): void {
    let bestQuality = 0;
    for (const t of this.tethers) {
      if (!t.shared.active) continue;
      if (boost && !t.shared.flying && t.mode === "swing") {
        _dir.copy(t.shared.anchor).sub(frame.position);
        const d = _dir.length();
        if (d > 1e-3) {
          _dir.multiplyScalar(1 / d);
          const radial = frame.velocity.dot(_dir);
          const tangential = Math.sqrt(
            Math.max(0, frame.velocity.lengthSq() - radial * radial),
          );
          // Quality peaks when you are fast, moving across the rope rather
          // than along it, and the anchor is above you — the bottom of an arc.
          const q =
            clamp01(tangential / 34) *
            clamp01(1 - Math.abs(radial) / Math.max(6, tangential + 6)) *
            clamp01(0.35 + _dir.y);
          if (q > bestQuality) bestQuality = q;
        }
      }
      this.clear(t);
    }
    this.linkPending = null;

    if (bestQuality > 0.02) {
      const mul = 1 + (GRAPPLE.releaseBoost - 1) * bestQuality;
      frame.velocity.multiplyScalar(mul);
      // A little free altitude: without it a perfect swing still ends in a
      // shallow dive and the loop dies at street level.
      frame.velocity.y += 3.4 * bestQuality;
      this.boostedRelease = bestQuality;
    }
  }

  /** Drop everything, no boost, no events. Respawn and vehicle entry use it. */
  clearAll(): void {
    for (const t of this.tethers) this.clear(t);
    for (const w of this.worldTethers) w.active = false;
    this.linkPending = null;
    this.reelHeld = false;
    this.reelIntensity = 0;
  }

  /* ---------------- per-frame ---------------- */

  /**
   * Advance hook flight, refresh moving anchors, and solve object↔object
   * links. Call before `applyToPlayer` so the player sees this frame's anchor.
   */
  update(dt: number): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.boostedRelease = Math.max(0, this.boostedRelease - dt * 4);
    if (this.linkPending && frame.time - this.linkPendingAt > 6) {
      // A half-made link should not linger across a whole rooftop chase.
      this.linkPending = null;
    }

    this.computeMuzzle(_v2);

    for (const t of this.tethers) {
      if (!t.shared.active) continue;
      t.muzzle.copy(_v2);

      // Refresh the anchor from the (possibly moving) target every frame.
      this.resolveAnchor(t);

      if (t.shared.flying) {
        t.flightT += dt;
        const p = clamp01(t.flightT / t.flightDuration);
        t.shared.flyProgress = p;
        // Re-aim at the live anchor so a hook fired at a moving car still
        // connects; ease slightly so it does not visibly home in.
        t.flightTo.copy(t.shared.anchor);
        t.hook.lerpVectors(t.flightFrom, t.flightTo, p);
        if (p >= 1) {
          if (t.missed) {
            this.clear(t);
          } else {
            this.bite(t);
          }
        }
        continue;
      }

      t.hook.copy(t.shared.anchor);

      // Rope length bookkeeping.
      const dist = frame.position.distanceTo(t.shared.anchor);
      if (dist > GRAPPLE.maxRange * BREAK_FACTOR) {
        this.clear(t);
        continue;
      }
      // Slack rope shortens for free: without this you can drift toward an
      // anchor and then get yanked by a rope you never re-tensioned.
      if (dist < t.shared.length) {
        t.shared.length = Math.max(MIN_LENGTH, dist);
      }
      t.tension = clamp01((dist - t.shared.length) / (t.shared.length * 0.12 + 0.5));
      t.vibration *= Math.exp(-dt * 3.4);
      t.vibPhase += dt * (26 + t.tension * 34);
    }

    this.updateWorldTethers(dt);
  }

  /**
   * The forces a live tether puts on the player. Called by the controller with
   * the position and velocity it is about to integrate; mutates `vel`.
   */
  applyToPlayer(dt: number, pos: THREE.Vector3, vel: THREE.Vector3): void {
    this.reelIntensity = 0;
    let anyLoaded = false;

    for (const t of this.tethers) {
      const s = t.shared;
      if (!s.active || s.flying) continue;
      anyLoaded = true;

      _dir.copy(s.anchor).sub(pos);
      const dist = _dir.length();
      if (dist < 1e-3) continue;
      _dir.multiplyScalar(1 / dist);

      const reeling = this.reelHeld || t.mode === "reel";
      s.reeling = reeling;

      if (reeling) {
        /* ---- reel ---- */
        const along = vel.dot(_dir);
        if (along < GRAPPLE.maxReelSpeed) {
          const room = clamp01((GRAPPLE.maxReelSpeed - along) / GRAPPLE.maxReelSpeed);
          const a = GRAPPLE.reelAcceleration * room;
          vel.addScaledVector(_dir, a * dt);
          // Upward bias when the anchor is above: this is what turns a reel
          // into an arc onto the roof instead of a scrape up the wall.
          if (_dir.y > 0.1) vel.y += a * REEL_LIFT * _dir.y * dt;
          this.reelIntensity = Math.max(this.reelIntensity, room);
        }
        // Wind the rope in so it never goes slack behind you.
        s.length = Math.max(MIN_LENGTH, Math.min(s.length, dist));
        t.tension = 1;

        if (dist < ARRIVE_RADIUS) {
          // Arrived. Keep a slice of the momentum — being stopped dead at the
          // anchor is the fastest way to kill a traversal chain.
          vel.multiplyScalar(0.55);
          this.clear(t);
          continue;
        }
      } else {
        /* ---- swing ---- */
        const ext = dist - s.length;
        if (ext > 0) {
          const radial = vel.dot(_dir); // >0 means closing on the anchor
          // Soft spring first: gives the rope visible give under load.
          let a = GRAPPLE.springK * ext;
          if (radial < 0) a += -radial * GRAPPLE.springDamping;
          vel.addScaledVector(_dir, a * dt);

          // Then a hard clamp past the stretch tolerance. The spring alone
          // lets a 60 m/s dive stretch the rope by ten metres before it bites.
          if (ext > s.length * STRETCH_TOLERANCE) {
            const outward = vel.dot(_dir);
            if (outward < 0) vel.addScaledVector(_dir, -outward);
            const excess = ext - s.length * STRETCH_TOLERANCE;
            pos.addScaledVector(_dir, Math.min(excess, 40 * dt + 0.05));
          }
          if (ext > 0.05) t.vibration = Math.max(t.vibration, clamp01(ext * 0.4) * 0.5);
        }
      }
    }

    if (!anyLoaded) this.reelHeld = false;
  }

  /* ---------------- internals ---------------- */

  private pickSlot(): RuntimeTether | null {
    const n = this.tethers.length;
    for (let i = 0; i < n; i++) {
      const t = this.tethers[(this.nextSlot + i) % n];
      if (!t.shared.active) {
        this.nextSlot = (t.slot + 1) % n;
        return t;
      }
    }
    // Everything is loaded: recycle the oldest rope rather than refuse to fire.
    let oldest = this.tethers[0];
    for (const t of this.tethers) if (t.attachedAt < oldest.attachedAt) oldest = t;
    this.clear(oldest);
    this.nextSlot = (oldest.slot + 1) % n;
    return oldest;
  }

  private clear(t: RuntimeTether): void {
    t.shared.active = false;
    t.shared.flying = false;
    t.shared.reeling = false;
    t.shared.attachedTo = null;
    t.shared.flyProgress = 0;
    t.object = null;
    t.tension = 0;
    t.vibration = 0;
    t.missed = false;
  }

  private bite(t: RuntimeTether): void {
    t.shared.flying = false;
    t.shared.flyProgress = 1;
    t.attachedAt = frame.time;
    t.hook.copy(t.shared.anchor);
    const dist = frame.position.distanceTo(t.shared.anchor);
    // 0.985 so the rope is faintly taut the instant it lands; a rope that
    // starts slack has a dead beat in it before the swing begins.
    t.shared.length = Math.max(MIN_LENGTH, dist * 0.985);
    t.vibration = 0.55;
    t.vibPhase = 0;
    t.tension = 0.4;

    _imp.x = t.shared.anchor.x;
    _imp.y = t.shared.anchor.y;
    _imp.z = t.shared.anchor.z;
    _imp.nx = 0;
    _imp.ny = 1;
    _imp.nz = 0;
    _imp.surface = t.surface;
    _imp.object = t.object;
    _imp.distance = dist;
    for (const h of this.impactHandlers) h(_imp);
  }

  private emitImpact(from: THREE.Vector3): void {
    _imp.x = _hit.px;
    _imp.y = _hit.py;
    _imp.z = _hit.pz;
    _imp.nx = _hit.nx;
    _imp.ny = _hit.ny;
    _imp.nz = _hit.nz;
    _imp.surface = _hit.surface;
    _imp.object = _hit.object;
    _imp.distance = Math.hypot(_hit.px - from.x, _hit.py - from.y, _hit.pz - from.z);
    for (const h of this.impactHandlers) h(_imp);
  }

  private computeMuzzle(out: THREE.Vector3): void {
    // The cable leaves the gun, not the eyeball. Half a metre of offset is the
    // difference between a rope that reads as attached to the player and one
    // that reads as attached to the camera.
    out.copy(frame.position);
    out.y += PLAYER.eyeHeight - PLAYER.height * 0.5;
    out.addScaledVector(frame.right, MUZZLE_RIGHT);
    out.addScaledVector(frame.forward, MUZZLE_FWD);
    out.y -= MUZZLE_DOWN;
  }

  /**
   * Find what the crosshair is on.
   *
   * Falls back to an analytic march against the terrain field when Rapier has
   * not booted, so the hook works on frame one — it is the primary way of
   * moving and it must never be dead.
   */
  private probe(origin: THREE.Vector3, dir: THREE.Vector3, range: number): boolean {
    if (raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, range, _hit, {
      groups: HOOK_QUERY,
      excludeCollider: playerController.collider,
    })) {
      return true;
    }
    return this.terrainMarch(origin, dir, range);
  }

  private terrainMarch(origin: THREE.Vector3, dir: THREE.Vector3, range: number): boolean {
    // 3 m steps then a short bisection: accurate to a few centimetres over a
    // 240 m ray for ~80 height samples, which is nothing.
    const step = 3;
    let prevT = 0;
    let prevAbove = origin.y - terrainHeight(origin.x, origin.z);
    if (prevAbove < 0) return false;
    for (let d = step; d <= range; d += step) {
      const x = origin.x + dir.x * d;
      const y = origin.y + dir.y * d;
      const z = origin.z + dir.z * d;
      const above = y - terrainHeight(x, z);
      if (above <= 0) {
        let lo = prevT;
        let hi = d;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) * 0.5;
          const mx = origin.x + dir.x * mid;
          const my = origin.y + dir.y * mid;
          const mz = origin.z + dir.z * mid;
          if (my - terrainHeight(mx, mz) > 0) lo = mid;
          else hi = mid;
        }
        _hit.hit = true;
        _hit.distance = hi;
        _hit.px = origin.x + dir.x * hi;
        _hit.py = origin.y + dir.y * hi;
        _hit.pz = origin.z + dir.z * hi;
        _hit.nx = 0;
        _hit.ny = 1;
        _hit.nz = 0;
        _hit.collider = null;
        _hit.object = null;
        _hit.surface = "dirt";
        return true;
      }
      prevT = d;
      prevAbove = above;
    }
    return false;
  }

  /** Store the hit point in the target's local frame when the target can move. */
  private captureLocal(
    t: RuntimeTether,
    obj: PhysicsObject | null,
    x: number,
    y: number,
    z: number,
  ): void {
    t.object = null;
    t.local.set(0, 0, 0);
    if (!obj || !obj.body || obj.body.isFixed()) return;
    t.object = obj;
    worldToLocal(obj.body, x, y, z, t.local);
    t.shared.attachedTo = obj.id;
  }

  private resolveAnchor(t: RuntimeTether): void {
    const obj = t.object;
    if (!obj || !obj.body) return;
    if (!obj.body.isValid || !obj.body.isValid()) {
      // The thing we were attached to was destroyed. Let go rather than hang
      // off a dangling handle.
      t.object = null;
      t.shared.attachedTo = null;
      return;
    }
    localToWorld(obj.body, t.local, t.shared.anchor);
  }

  private fillEnd(
    end: TetherEnd,
    obj: PhysicsObject | null,
    x: number,
    y: number,
    z: number,
  ): void {
    end.object = obj;
    end.world.set(x, y, z);
    const body = obj?.body ?? null;
    if (body && !body.isFixed()) {
      end.body = body;
      end.fixed = false;
      worldToLocal(body, x, y, z, end.local);
    } else {
      end.body = null;
      end.fixed = true;
      end.local.set(x, y, z);
    }
  }

  private oldestWorldTether(): WorldTether {
    let best = this.worldTethers[0];
    for (const w of this.worldTethers) if (w.life < best.life) best = w;
    return best;
  }

  /**
   * Solve the object↔object links.
   *
   * A spring with a shrinking rest length, applied as impulses at the contact
   * points so the pull produces torque as well as translation — a car tethered
   * by its rear bumper should slew, not slide. Impulses are scaled by mass so
   * a link drags a bin and a bus at comparable rates, which is what players
   * expect even though it is not what physics does.
   */
  private updateWorldTethers(dt: number): void {
    for (const w of this.worldTethers) {
      if (!w.active) continue;
      w.life -= dt;
      if (w.life <= 0) {
        w.active = false;
        continue;
      }

      if (!resolveEnd(w.a) || !resolveEnd(w.b)) {
        w.active = false;
        continue;
      }

      _dir.copy(w.b.world).sub(w.a.world);
      const dist = _dir.length();
      if (dist < 1e-4) continue;
      _dir.multiplyScalar(1 / dist);

      w.rest = Math.max(LINK_MIN_REST, w.rest - LINK_RETRACT * dt);
      const ext = dist - w.rest;
      w.tension = clamp01(ext / Math.max(1, w.initial * 0.25));
      w.vibration *= Math.exp(-dt * 2.2);
      w.vibPhase += dt * (18 + w.tension * 26);
      if (ext <= 0) continue;

      const accel = Math.min(LINK_MAX_ACCEL, LINK_K * ext);
      // Pull A toward B and B toward A.
      this.pullEnd(w.a, _dir.x, _dir.y, _dir.z, accel, dt);
      this.pullEnd(w.b, -_dir.x, -_dir.y, -_dir.z, accel, dt);
    }
  }

  private pullEnd(
    end: TetherEnd,
    dx: number,
    dy: number,
    dz: number,
    accel: number,
    dt: number,
  ): void {
    if (end.fixed) return;
    const obj = end.object;
    if (obj && (obj.kind === "enemy" || obj.kind === "player") && this.pullHandlers.length) {
      // Kinematic characters cannot be impulsed; hand it to whoever owns them.
      for (const h of this.pullHandlers) h(obj, dx * accel, dy * accel, dz * accel);
      return;
    }
    const body = end.body;
    if (!body || !body.isValid()) return;
    const mass = Math.max(1, body.mass());
    const j = accel * mass * dt;
    _rv.x = dx * j;
    _rv.y = dy * j;
    _rv.z = dz * j;
    _rp.x = end.world.x;
    _rp.y = end.world.y;
    _rp.z = end.world.z;
    body.applyImpulseAtPoint(_rv, _rp, true);
  }
}

/* ------------------------------------------------------------------ *
 * Body-space helpers
 * ------------------------------------------------------------------ */

function worldToLocal(
  body: RAPIER.RigidBody,
  x: number,
  y: number,
  z: number,
  out: THREE.Vector3,
): void {
  const p = body.translation();
  const r = body.rotation();
  _q.set(r.x, r.y, r.z, r.w).invert();
  out.set(x - p.x, y - p.y, z - p.z).applyQuaternion(_q);
}

function localToWorld(body: RAPIER.RigidBody, local: THREE.Vector3, out: THREE.Vector3): void {
  const p = body.translation();
  const r = body.rotation();
  _q.set(r.x, r.y, r.z, r.w);
  out.copy(local).applyQuaternion(_q);
  out.x += p.x;
  out.y += p.y;
  out.z += p.z;
}

function resolveEnd(end: TetherEnd): boolean {
  if (end.fixed) {
    end.world.copy(end.local);
    return true;
  }
  const body = end.body;
  if (!body || !body.isValid()) return false;
  localToWorld(body, end.local, end.world);
  return true;
}

function copyEnd(dst: TetherEnd, src: TetherEnd): void {
  dst.object = src.object;
  dst.body = src.body;
  dst.local.copy(src.local);
  dst.world.copy(src.world);
  dst.fixed = src.fixed;
}

/** Re-exported for renderers that want to clamp their own values. */
export { clamp, clamp01 };

/** The one grapple. */
export const grappleSystem = new GrappleSystem();
export type { GrappleSystem };
