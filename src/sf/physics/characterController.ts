/**
 * characterController.ts — the kinematic capsule the player and every enemy
 * stands on.
 *
 * Rapier's `KinematicCharacterController` gives us the hard parts for free:
 * depenetration, sliding along walls, autostep, ground snapping, slope limits.
 * What it does *not* give us — and what turns "a capsule that moves" into "a
 * character that feels like a Just Cause protagonist" — is everything in this
 * file around it:
 *
 *   • moving platforms, so standing on a cable car or a truck bed carries you;
 *   • a ceiling clamp, so jumping under an overhang kills upward velocity
 *     instead of letting you hover against it for the rest of the arc;
 *   • crouch resize with a stand-up clearance test, so you cannot pop through
 *     a ventilation duct;
 *   • swim mode below sea level, with a submersion fraction the caller uses to
 *     blend buoyancy and swap the movement model;
 *   • a ledge/vault probe that reports what is grabbable in front of you.
 *
 * The controller is a *service*, not an owner. It never writes to `frame` —
 * the player subsystem integrates its own velocity, hands us a translation
 * delta, and reads the result back. That keeps one authority over player
 * state and lets AI reuse the exact same code path.
 */
import type * as RAPIER from "@dimforge/rapier3d-compat";
import { PLAYER } from "../config";
import { WORLD } from "../geo/sfGeo";
import { clamp01 } from "../math/rng";
import { capsuleBlocked, makeRayHit, raycast, type RayHit } from "./raycast";
import {
  FILTER,
  GROUP,
  interactionGroups,
  objectForCollider,
  physics,
  rapier,
  registerObject,
  unregisterObject,
  type PhysicsObject,
} from "./world";

/* ------------------------------------------------------------------ *
 * Geometry constants derived from PLAYER
 * ------------------------------------------------------------------ */

/** Cylinder half-height of the standing capsule (total = 2*(hh + r)). */
export const STAND_HALF_HEIGHT = Math.max(0.05, (PLAYER.height - 2 * PLAYER.radius) * 0.5);
/** Crouched total height — eye height plus the bit of skull above the eyes. */
const CROUCH_TOTAL = PLAYER.crouchEyeHeight + 0.16;
export const CROUCH_HALF_HEIGHT = Math.max(0.03, (CROUCH_TOTAL - 2 * PLAYER.radius) * 0.5);

/** Max climbable slope. 54° is steep enough for SF's worst streets (~31%). */
const MAX_SLOPE_CLIMB = (54 * Math.PI) / 180;
/** Above this the character slides back down instead of standing. */
const MIN_SLOPE_SLIDE = (46 * Math.PI) / 180;
/** Rapier's skin. Too small and you jitter, too large and you float. */
const CONTROLLER_OFFSET = 0.02;

/** What the character capsule is allowed to collide with. */
const CHARACTER_QUERY = interactionGroups(
  GROUP.PLAYER,
  GROUP.TERRAIN | GROUP.BUILDING | GROUP.VEHICLE | GROUP.PROP,
);

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

export interface CharacterMoveResult {
  /** Feet are on something walkable. */
  grounded: boolean;
  /** Ground normal (0,1,0) when airborne. */
  nx: number;
  ny: number;
  nz: number;
  /** Ground slope in radians. */
  slope: number;
  /** Something above stopped upward motion this step. */
  hitCeiling: boolean;
  /** Something roughly vertical stopped horizontal motion. */
  hitWall: boolean;
  /** Wall normal when `hitWall`, else zero. */
  wallX: number;
  wallZ: number;
  /** The controller stepped up a kerb or stair this frame. */
  steppedUp: boolean;
  /** Translation actually applied, after sliding/depenetration. */
  dx: number;
  dy: number;
  dz: number;
  /** The object being stood on, if any (moving platform, vehicle roof). */
  groundObject: PhysicsObject | null;
  /** Fraction of the capsule below sea level, 0..1. */
  submersion: number;
  /** Deep enough that the caller should switch to the swim model. */
  swimming: boolean;
  /** Extra translation contributed by the platform underfoot. */
  platformX: number;
  platformY: number;
  platformZ: number;
}

function makeResult(): CharacterMoveResult {
  return {
    grounded: false,
    nx: 0, ny: 1, nz: 0,
    slope: 0,
    hitCeiling: false,
    hitWall: false,
    wallX: 0, wallZ: 0,
    steppedUp: false,
    dx: 0, dy: 0, dz: 0,
    groundObject: null,
    submersion: 0,
    swimming: false,
    platformX: 0, platformY: 0, platformZ: 0,
  };
}

export type LedgeKind = "none" | "step" | "vault" | "mantle";

export interface LedgeInfo {
  kind: LedgeKind;
  /** Top surface of the obstacle, world space. */
  x: number;
  y: number;
  z: number;
  /** Outward normal of the face you are up against (horizontal). */
  nx: number;
  nz: number;
  /** Height of the ledge above the character's feet. */
  height: number;
  /** Depth of clear standing space behind the lip; < 0.5 means "grab, don't mantle". */
  depth: number;
}

export function makeLedgeInfo(): LedgeInfo {
  return { kind: "none", x: 0, y: 0, z: 0, nx: 0, nz: 0, height: 0, depth: 0 };
}

/* ------------------------------------------------------------------ *
 * Scratch
 * ------------------------------------------------------------------ */

const _desired = { x: 0, y: 0, z: 0 };
const _next = { x: 0, y: 0, z: 0 };
const _point = { x: 0, y: 0, z: 0 };
const _hit: RayHit = makeRayHit();
const _hit2: RayHit = makeRayHit();

/* ------------------------------------------------------------------ *
 * The controller
 * ------------------------------------------------------------------ */

export interface CharacterOptions {
  radius?: number;
  /** Total standing height, metres. */
  height?: number;
  /** Membership/filter for the capsule collider. Defaults to the player's. */
  collisionGroups?: number;
  kind?: "player" | "enemy";
  /** Push dynamic bodies out of the way (shoving barrels aside while running). */
  pushBodies?: boolean;
  /** Effective mass used when pushing dynamic bodies, kg. */
  mass?: number;
}

export class SfCharacterController {
  body: RAPIER.RigidBody | null = null;
  collider: RAPIER.Collider | null = null;
  private ctrl: RAPIER.KinematicCharacterController | null = null;
  private collision: RAPIER.CharacterCollision | null = null;
  object: PhysicsObject | null = null;

  radius: number;
  /** Cylinder half-height currently in use. */
  halfHeight: number;
  private standHalf: number;
  private crouchHalf: number;
  crouched = false;

  /** Capsule centre. Authoritative between calls; mirrors the rapier body. */
  readonly position = new Float32Array(3);

  /** Body we were standing on last step, for platform carry. */
  private platformBody: RAPIER.RigidBody | null = null;
  private platformValid = false;

  readonly result: CharacterMoveResult = makeResult();

  private groups: number;
  private opts: CharacterOptions;

  constructor(opts: CharacterOptions = {}) {
    this.opts = opts;
    this.radius = opts.radius ?? PLAYER.radius;
    const total = opts.height ?? PLAYER.height;
    this.standHalf = Math.max(0.05, (total - 2 * this.radius) * 0.5);
    this.crouchHalf = Math.max(0.03, (CROUCH_TOTAL - 2 * this.radius) * 0.5);
    this.halfHeight = this.standHalf;
    this.groups = opts.collisionGroups ?? (opts.kind === "enemy" ? FILTER.enemy : FILTER.player);
  }

  /** True once the rapier objects exist. */
  get ready(): boolean {
    return this.ctrl !== null && this.collider !== null;
  }

  /** Total capsule height, metres. */
  get totalHeight(): number {
    return 2 * (this.halfHeight + this.radius);
  }

  /** World Y of the bottom of the capsule. */
  get feetY(): number {
    return this.position[1] - this.halfHeight - this.radius;
  }

  /**
   * Build the rapier objects. Safe to call repeatedly; no-ops before boot, so
   * the caller can simply try again next frame.
   */
  spawn(x: number, y: number, z: number): boolean {
    if (this.ready) {
      this.setPosition(x, y, z);
      return true;
    }
    const r = rapier();
    const w = physics.world;
    if (!r || !w) return false;

    this.body = w.createRigidBody(
      r.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y, z),
    );
    this.collider = w.createCollider(
      r.ColliderDesc.capsule(this.halfHeight, this.radius)
        .setCollisionGroups(this.groups)
        .setFriction(0)
        .setRestitution(0),
      this.body,
    );

    const ctrl = w.createCharacterController(CONTROLLER_OFFSET);
    ctrl.setUp({ x: 0, y: 1, z: 0 });
    ctrl.setSlideEnabled(true);
    ctrl.setMaxSlopeClimbAngle(MAX_SLOPE_CLIMB);
    ctrl.setMinSlopeSlideAngle(MIN_SLOPE_SLIDE);
    // Autostep over kerbs and stairs. minWidth is the free space that must
    // exist on top — without it the controller happily steps onto a railing.
    ctrl.enableAutostep(PLAYER.stepHeight, this.radius * 0.75, true);
    // Snap distance a shade under the step height: enough to hold you to a
    // 30% grade going downhill, not enough to yank you back onto a roof you
    // just walked off.
    ctrl.enableSnapToGround(PLAYER.stepHeight * 0.85);
    ctrl.setApplyImpulsesToDynamicBodies(this.opts.pushBodies ?? true);
    ctrl.setCharacterMass(this.opts.mass ?? 82);
    this.ctrl = ctrl;
    this.collision = new r.CharacterCollision();

    this.position[0] = x;
    this.position[1] = y;
    this.position[2] = z;

    this.object = registerObject({
      kind: this.opts.kind ?? "player",
      body: this.body,
      colliders: [this.collider],
      surface: "flesh",
      ref: this,
    });
    return true;
  }

  /** Teleport. Clears platform carry so a respawn does not inherit a truck. */
  setPosition(x: number, y: number, z: number): void {
    this.position[0] = x;
    this.position[1] = y;
    this.position[2] = z;
    this.platformBody = null;
    this.platformValid = false;
    if (this.body) {
      _next.x = x; _next.y = y; _next.z = z;
      this.body.setTranslation(_next, true);
      this.body.setNextKinematicTranslation(_next);
    }
  }

  /**
   * Move by a translation delta and report what happened.
   *
   * The caller owns velocity: it integrates gravity, applies input, and hands
   * over `delta = velocity * dt`. On return it should zero the components the
   * result says were blocked (grounded → vy, hitCeiling → vy, hitWall →
   * project horizontal velocity onto the wall plane).
   *
   * Before physics boots this still updates `position` by the raw delta so the
   * player free-falls through an empty world rather than freezing at spawn.
   */
  move(dx: number, dy: number, dz: number, dt: number): CharacterMoveResult {
    const res = this.result;
    res.grounded = false;
    res.hitCeiling = false;
    res.hitWall = false;
    res.wallX = 0;
    res.wallZ = 0;
    res.steppedUp = false;
    res.groundObject = null;
    res.nx = 0; res.ny = 1; res.nz = 0;
    res.slope = 0;
    res.platformX = 0; res.platformY = 0; res.platformZ = 0;

    if (!this.ready) {
      this.position[0] += dx;
      this.position[1] += dy;
      this.position[2] += dz;
      res.dx = dx; res.dy = dy; res.dz = dz;
      this.updateSubmersion(res);
      return res;
    }

    // --- moving platform carry ------------------------------------
    // Sample the platform's velocity at the contact point rather than its
    // linear velocity, so a rotating cable car turntable spins you with it.
    if (this.platformValid && this.platformBody && this.platformBody.isValid()) {
      _point.x = this.position[0];
      _point.y = this.feetY;
      _point.z = this.position[2];
      const v = this.platformBody.velocityAtPoint(_point);
      // Guard against the pathological: a body launched by an explosion should
      // fling you off, not teleport you 400 m.
      const cap = 40;
      const px = Math.max(-cap, Math.min(cap, v.x)) * dt;
      const py = Math.max(-cap, Math.min(cap, v.y)) * dt;
      const pz = Math.max(-cap, Math.min(cap, v.z)) * dt;
      res.platformX = px;
      res.platformY = py;
      res.platformZ = pz;
      dx += px;
      dy += py;
      dz += pz;
    }

    const ctrl = this.ctrl!;
    const collider = this.collider!;
    const self = collider;

    _desired.x = dx;
    _desired.y = dy;
    _desired.z = dz;

    const r = rapier();
    ctrl.computeColliderMovement(
      collider,
      _desired,
      r ? r.QueryFilterFlags.EXCLUDE_SENSORS : undefined,
      CHARACTER_QUERY,
      (c) => c.handle !== self.handle,
    );

    const mv = ctrl.computedMovement();
    res.dx = mv.x;
    res.dy = mv.y;
    res.dz = mv.z;
    res.grounded = ctrl.computedGrounded();

    // The controller absorbed more upward travel than it applied, and we were
    // trying to rise: that is a ceiling.
    if (dy > 1e-4 && mv.y < dy - 1e-3) res.hitCeiling = true;
    // Same test horizontally, before we look for an actual wall normal.
    const wantH = Math.hypot(dx, dz);
    const gotH = Math.hypot(mv.x, mv.z);
    if (wantH > 1e-4 && gotH < wantH - 1e-3) res.hitWall = true;

    // --- inspect the contacts -------------------------------------
    let bestNy = -2;
    let groundCollider: RAPIER.Collider | null = null;
    const n = ctrl.numComputedCollisions();
    for (let i = 0; i < n; i++) {
      const c = ctrl.computedCollision(i, this.collision ?? undefined);
      if (!c) continue;
      const ny = c.normal1.y;
      if (ny > 0.5 && ny > bestNy) {
        bestNy = ny;
        res.nx = c.normal1.x;
        res.ny = ny;
        res.nz = c.normal1.z;
        groundCollider = c.collider;
      } else if (ny < -0.4) {
        res.hitCeiling = true;
      } else if (Math.abs(ny) <= 0.5) {
        // Vertical-ish face. Keep the one most opposed to travel.
        const dot = -(c.normal1.x * dx + c.normal1.z * dz);
        if (dot > 0) {
          res.wallX = c.normal1.x;
          res.wallZ = c.normal1.z;
          res.hitWall = true;
        }
      }
      if (c.toi <= 1e-6 && ny > 0.5 && mv.y > 1e-4 && dy <= 0) res.steppedUp = true;
    }
    if (bestNy < -1) {
      res.nx = 0; res.ny = 1; res.nz = 0;
    }
    res.slope = Math.acos(Math.max(-1, Math.min(1, res.ny)));

    // --- remember the platform ------------------------------------
    this.platformBody = null;
    this.platformValid = false;
    if (res.grounded && groundCollider) {
      res.groundObject = objectForCollider(groundCollider);
      const parent = groundCollider.parent();
      // Only non-fixed bodies can carry you. Terrain and buildings are fixed,
      // and asking a fixed body for velocityAtPoint every frame is waste.
      if (parent && !parent.isFixed()) {
        this.platformBody = parent;
        this.platformValid = true;
      }
    }

    // --- commit ---------------------------------------------------
    this.position[0] += mv.x;
    this.position[1] += mv.y;
    this.position[2] += mv.z;
    _next.x = this.position[0];
    _next.y = this.position[1];
    _next.z = this.position[2];
    this.body!.setNextKinematicTranslation(_next);

    this.updateSubmersion(res);
    return res;
  }

  /**
   * Submersion is measured from the capsule, not the eye: at 0.55 you are
   * chest-deep and wading, at 1.0 the top of your head is under.
   */
  private updateSubmersion(res: CharacterMoveResult): void {
    const h = this.totalHeight;
    const feet = this.feetY;
    const depth = WORLD.seaLevel - feet;
    res.submersion = clamp01(depth / h);
    // Wading is not swimming. The threshold is set so you can walk out of the
    // surf at Ocean Beach and only start swimming past the sandbar.
    res.swimming = res.submersion > 0.72;
  }

  /* ---------------- crouch ---------------- */

  /**
   * Enter or leave the crouch capsule.
   *
   * Returns false when standing up is blocked — the caller must keep the
   * player crouched and not simply set an animation flag, or the camera ends
   * up inside a duct.
   */
  setCrouch(want: boolean): boolean {
    if (want === this.crouched) return true;
    if (!this.ready) {
      this.crouched = want;
      this.halfHeight = want ? this.crouchHalf : this.standHalf;
      return true;
    }
    const feet = this.feetY;

    if (want) {
      // Shrinking always succeeds. Keep the feet planted: the capsule centre
      // drops by the height difference.
      this.halfHeight = this.crouchHalf;
      this.crouched = true;
      this.collider!.setHalfHeight(this.crouchHalf);
      this.setPosition(this.position[0], feet + this.crouchHalf + this.radius, this.position[2]);
      return true;
    }

    const standCentre = feet + this.standHalf + this.radius;
    const blocked = capsuleBlocked(
      this.position[0], standCentre, this.position[2],
      this.standHalf, this.radius * 0.97,
      { groups: CHARACTER_QUERY, excludeCollider: this.collider },
    );
    if (blocked) return false;

    this.halfHeight = this.standHalf;
    this.crouched = false;
    this.collider!.setHalfHeight(this.standHalf);
    this.setPosition(this.position[0], standCentre, this.position[2]);
    return true;
  }

  /* ---------------- ledge / vault ---------------- */

  /**
   * Look for something climbable directly ahead.
   *
   * Three probes, cheapest first:
   *   1. a chest-height ray forward — is there a face at all, and is it steep?
   *   2. a downward ray from above and just past that face — where is its top?
   *   3. a capsule overlap at the landing spot — is there room to end up there?
   *
   * The classification is what the animation system actually wants:
   *   step   (< stepHeight)          the autostep already handled it
   *   vault  (< 1.3 m, deep top)     hands-on-the-rail hop
   *   mantle (< 2.3 m or thin lip)   pull yourself up / hang
   */
  detectLedge(dirX: number, dirZ: number, out: LedgeInfo, maxHeight = 2.3): boolean {
    out.kind = "none";
    out.height = 0;
    out.depth = 0;
    if (!this.ready) return false;

    const len = Math.hypot(dirX, dirZ);
    if (len < 1e-6) return false;
    dirX /= len;
    dirZ /= len;

    const feet = this.feetY;
    const reach = this.radius + 0.72;

    // 1. Is there a wall in front of us at chest height?
    const chestY = feet + Math.min(1.05, this.totalHeight * 0.6);
    if (!raycast(
      this.position[0], chestY, this.position[2],
      dirX, 0, dirZ, reach, _hit,
      { groups: CHARACTER_QUERY, excludeCollider: this.collider, skipSurface: true },
    )) {
      return false;
    }
    // Only near-vertical faces are ledges. A 40° hillside is a walk, not a vault.
    if (Math.abs(_hit.ny) > 0.42) return false;
    // And it must actually be facing us.
    if (_hit.nx * dirX + _hit.nz * dirZ > -0.25) return false;

    const wallX = _hit.px;
    const wallZ = _hit.pz;
    const wallNx = _hit.nx;
    const wallNz = _hit.nz;

    // 2. Where is the top? Probe from above, a little past the face.
    const probeX = wallX + dirX * 0.35;
    const probeZ = wallZ + dirZ * 0.35;
    const probeTop = feet + maxHeight + 0.35;
    if (!raycast(
      probeX, probeTop, probeZ,
      0, -1, 0, maxHeight + 0.5, _hit,
      { groups: CHARACTER_QUERY, excludeCollider: this.collider, skipSurface: true },
    )) {
      return false; // no top within reach — it is a wall, not a ledge
    }
    if (_hit.ny < 0.6) return false; // sloped cap, not standable

    const topY = _hit.py;
    const height = topY - feet;
    if (height < 0.08 || height > maxHeight) return false;

    out.x = probeX;
    out.y = topY;
    out.z = probeZ;
    out.nx = wallNx;
    out.nz = wallNz;
    out.height = height;

    // 3. How deep is the top surface? Walk a second down-probe further in;
    //    a parapet with 20 cm of ledge is a hang, a roof deck is a mantle.
    const deepX = wallX + dirX * 1.15;
    const deepZ = wallZ + dirZ * 1.15;
    const deep = raycast(
      deepX, topY + 0.45, deepZ,
      0, -1, 0, 0.9, _hit2,
      { groups: CHARACTER_QUERY, excludeCollider: this.collider, skipSurface: true },
    );
    out.depth = deep && Math.abs(_hit2.py - topY) < 0.35 ? 1.15 : 0.35;

    // 4. Is there room to stand up there?
    const landCentre = topY + this.standHalf + this.radius + 0.04;
    const landX = out.depth > 0.8 ? deepX : probeX;
    const landZ = out.depth > 0.8 ? deepZ : probeZ;
    const blocked = capsuleBlocked(
      landX, landCentre, landZ,
      this.standHalf, this.radius * 0.9,
      { groups: CHARACTER_QUERY, excludeCollider: this.collider },
    );
    if (blocked && out.depth > 0.8) {
      // Deep landing blocked — fall back to hanging on the lip.
      out.depth = 0.35;
    } else if (blocked) {
      return false;
    }

    out.kind =
      height <= PLAYER.stepHeight ? "step" :
      height <= 1.3 && out.depth > 0.8 ? "vault" :
      "mantle";
    return true;
  }

  /* ---------------- housekeeping ---------------- */

  /** Remove the capsule from the world. */
  destroy(): void {
    const w = physics.world;
    unregisterObject(this.object);
    this.object = null;
    if (w) {
      if (this.ctrl) w.removeCharacterController(this.ctrl);
      if (this.body) w.removeRigidBody(this.body);
    }
    this.ctrl = null;
    this.body = null;
    this.collider = null;
    this.collision = null;
    this.platformBody = null;
    this.platformValid = false;
  }
}

/**
 * The player's controller. A singleton because there is exactly one player and
 * half a dozen systems (camera, grapple, wingsuit, HUD) need to reach it
 * without the composition root threading a prop through all of them.
 */
export const playerController = new SfCharacterController({ kind: "player" });
