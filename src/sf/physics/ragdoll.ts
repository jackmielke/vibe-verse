/**
 * ragdoll.ts — a 12-bone humanoid, blended in from the death frame.
 *
 * Three things make a ragdoll read as a body rather than a bag of capsules,
 * and all three are here:
 *
 *  **Joint limits that mean something.** Rapier's JS bindings expose angular
 *  limits on revolute joints only; spherical joints have none. So elbows and
 *  knees are true revolute hinges with hard limits, and the ball joints
 *  (hips, shoulders, spine, neck) get a swing-twist limit solved in this file:
 *  each fixed step we decompose the relative rotation about the bone axis,
 *  and apply a corrective torque impulse plus damping whenever the swing cone
 *  or the twist range is exceeded. That is a soft constraint, which is exactly
 *  what you want — a hard cone makes shoulders pop, a soft one makes them
 *  resist. Nobody's arm bends backwards, and nothing explodes.
 *
 *  **Blend-in from the death frame.** The instant a character dies we snapshot
 *  its animated skeleton and spawn the bodies *at that pose*, then cross-fade
 *  the rendered bones from the snapshot to the simulation over ~180 ms. Cutting
 *  straight to physics produces the classic "the corpse flinched" pop, because
 *  the solver's first frame always disagrees with the animator slightly.
 *
 *  **Get-up-or-die settling.** A ragdoll that keeps solving forever is a
 *  permanent tax on the frame. We track the skeleton's kinetic energy; once it
 *  stays under a threshold for a beat the ragdoll is *settled*, and then either
 *  hands control back (get-up, for a knockdown) or dies — sleeping every body
 *  so a street full of corpses costs nothing.
 *
 * Public API
 * ----------
 *   BONES, BONE_COUNT, BoneName
 *   defaultPose(x, y, z, yaw, out)      canonical standing skeleton
 *   ragdolls.spawn(pose, vel, opts) → Ragdoll | null
 *   ragdolls.update(dt)                 call once per frame
 *   ragdoll.sampleBone(i, out7)         blended pose for the renderer
 *   ragdoll.applyImpulse(bone, ...)     shooting a corpse still moves it
 *   ragdolls.despawn(r) / clear()
 */
import type * as RAPIER from "@dimforge/rapier3d-compat";
import { QUALITY, type QualityTier } from "../config";
import { clamp01 } from "../math/rng";
import {
  FILTER,
  physics,
  rapier,
  registerObject,
  sampleTransform,
  unregisterObject,
  type PhysicsObject,
} from "./world";

/* ================================================================== *
 * Rig definition
 * ================================================================== */

export type BoneName =
  | "pelvis"
  | "spine"
  | "chest"
  | "head"
  | "upperArmL"
  | "lowerArmL"
  | "upperArmR"
  | "lowerArmR"
  | "thighL"
  | "shinL"
  | "thighR"
  | "shinR";

export interface BoneDef {
  name: BoneName;
  /** Index of the parent bone, or -1 for the root. */
  parent: number;
  /** Capsule cylinder half-height and radius, metres. */
  halfHeight: number;
  radius: number;
  /** Mass, kg. Anthropometric fractions of a 73 kg adult. */
  mass: number;
  /** Bone's long axis in its own local frame. */
  ax: number;
  ay: number;
  az: number;
  /** Bind-pose offset of the bone centre from the pelvis centre. */
  bx: number;
  by: number;
  bz: number;
  /** Joint anchor in the parent's local frame. */
  px: number;
  py: number;
  pz: number;
  /** Joint anchor in this bone's local frame. */
  cx: number;
  cy: number;
  cz: number;
  /** "ball" = spherical + soft swing/twist limit. "hinge" = revolute. */
  joint: "ball" | "hinge" | "none";
  /** Hinge axis in local space, and its hard limits (radians). */
  hx?: number;
  hy?: number;
  hz?: number;
  hmin?: number;
  hmax?: number;
  /** Ball joint cone half-angle and twist range, radians. */
  swing?: number;
  twist?: number;
  /**
   * Capsules are oriented along local +Y by Rapier. A bone whose axis is not
   * +Y needs its collider rotated; this is that rotation as a quaternion.
   */
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

const D = Math.PI / 180;

/** Rotation taking +Y to +X — used for the arms, which lie along X in bind. */
const Y_TO_X = { qx: 0, qy: 0, qz: -Math.SQRT1_2, qw: Math.SQRT1_2 };
const IDENT = { qx: 0, qy: 0, qz: 0, qw: 1 };

/**
 * The rig. Bind pose is a relaxed T: pelvis at the origin, arms out along ±X,
 * legs down. Every bone's rest rotation is identity, so a joint's deviation is
 * simply `conj(qParent) * qChild` — which is what makes the limit solver below
 * one page instead of five.
 */
export const BONES: BoneDef[] = [
  {
    name: "pelvis", parent: -1, halfHeight: 0.06, radius: 0.135, mass: 11,
    ax: 0, ay: 1, az: 0, bx: 0, by: 0, bz: 0,
    px: 0, py: 0, pz: 0, cx: 0, cy: 0, cz: 0,
    joint: "none", ...IDENT,
  },
  {
    name: "spine", parent: 0, halfHeight: 0.075, radius: 0.115, mass: 9,
    ax: 0, ay: 1, az: 0, bx: 0, by: 0.20, bz: 0,
    px: 0, py: 0.10, pz: 0, cx: 0, cy: -0.10, cz: 0,
    joint: "ball", swing: 32 * D, twist: 26 * D, ...IDENT,
  },
  {
    name: "chest", parent: 1, halfHeight: 0.095, radius: 0.148, mass: 15,
    ax: 0, ay: 1, az: 0, bx: 0, by: 0.42, bz: 0,
    px: 0, py: 0.11, pz: 0, cx: 0, cy: -0.11, cz: 0,
    joint: "ball", swing: 26 * D, twist: 22 * D, ...IDENT,
  },
  {
    name: "head", parent: 2, halfHeight: 0.03, radius: 0.112, mass: 5,
    ax: 0, ay: 1, az: 0, bx: 0, by: 0.70, bz: 0,
    px: 0, py: 0.15, pz: 0, cx: 0, cy: -0.13, cz: 0,
    joint: "ball", swing: 52 * D, twist: 70 * D, ...IDENT,
  },
  {
    name: "upperArmL", parent: 2, halfHeight: 0.105, radius: 0.052, mass: 2.1,
    ax: 1, ay: 0, az: 0, bx: 0.34, by: 0.50, bz: 0,
    px: 0.18, py: 0.11, pz: 0, cx: -0.14, cy: 0, cz: 0,
    joint: "ball", swing: 88 * D, twist: 62 * D, ...Y_TO_X,
  },
  {
    name: "lowerArmL", parent: 4, halfHeight: 0.105, radius: 0.046, mass: 1.6,
    ax: 1, ay: 0, az: 0, bx: 0.60, by: 0.50, bz: 0,
    px: 0.14, py: 0, pz: 0, cx: -0.13, cy: 0, cz: 0,
    joint: "hinge", hx: 0, hy: 1, hz: 0, hmin: 0, hmax: 145 * D, ...Y_TO_X,
  },
  {
    name: "upperArmR", parent: 2, halfHeight: 0.105, radius: 0.052, mass: 2.1,
    ax: -1, ay: 0, az: 0, bx: -0.34, by: 0.50, bz: 0,
    px: -0.18, py: 0.11, pz: 0, cx: 0.14, cy: 0, cz: 0,
    joint: "ball", swing: 88 * D, twist: 62 * D, ...Y_TO_X,
  },
  {
    name: "lowerArmR", parent: 6, halfHeight: 0.105, radius: 0.046, mass: 1.6,
    ax: -1, ay: 0, az: 0, bx: -0.60, by: 0.50, bz: 0,
    px: -0.14, py: 0, pz: 0, cx: 0.13, cy: 0, cz: 0,
    joint: "hinge", hx: 0, hy: 1, hz: 0, hmin: -145 * D, hmax: 0, ...Y_TO_X,
  },
  {
    name: "thighL", parent: 0, halfHeight: 0.165, radius: 0.082, mass: 8.5,
    ax: 0, ay: -1, az: 0, bx: 0.10, by: -0.42, bz: 0,
    px: 0.10, py: -0.06, pz: 0, cx: 0, cy: 0.185, cz: 0,
    joint: "ball", swing: 72 * D, twist: 34 * D, ...IDENT,
  },
  {
    name: "shinL", parent: 8, halfHeight: 0.175, radius: 0.058, mass: 4.2,
    ax: 0, ay: -1, az: 0, bx: 0.10, by: -0.86, bz: 0,
    px: 0, py: -0.185, pz: 0, cx: 0, cy: 0.195, cz: 0,
    joint: "hinge", hx: 1, hy: 0, hz: 0, hmin: -150 * D, hmax: 0, ...IDENT,
  },
  {
    name: "thighR", parent: 0, halfHeight: 0.165, radius: 0.082, mass: 8.5,
    ax: 0, ay: -1, az: 0, bx: -0.10, by: -0.42, bz: 0,
    px: -0.10, py: -0.06, pz: 0, cx: 0, cy: 0.185, cz: 0,
    joint: "ball", swing: 72 * D, twist: 34 * D, ...IDENT,
  },
  {
    name: "shinR", parent: 10, halfHeight: 0.175, radius: 0.058, mass: 4.2,
    ax: 0, ay: -1, az: 0, bx: -0.10, by: -0.86, bz: 0,
    px: 0, py: -0.185, pz: 0, cx: 0, cy: 0.195, cz: 0,
    joint: "hinge", hx: 1, hy: 0, hz: 0, hmin: -150 * D, hmax: 0, ...IDENT,
  },
];

export const BONE_COUNT = BONES.length;
/** Pelvis centre height above the feet in the bind pose. */
export const PELVIS_HEIGHT = 0.94;

/** Index lookup by name, for callers that would rather not count. */
export const BONE_INDEX: Record<BoneName, number> = BONES.reduce(
  (acc, b, i) => {
    acc[b.name] = i;
    return acc;
  },
  {} as Record<BoneName, number>,
);

/**
 * Fill `out` (length ≥ BONE_COUNT * 7) with the canonical standing skeleton at
 * a world position and heading. Callers with a real animated skeleton should
 * pass theirs instead; this is the fallback for characters that have none.
 */
export function defaultPose(
  x: number,
  y: number,
  z: number,
  yaw: number,
  out: Float32Array,
): Float32Array {
  const h = yaw * 0.5;
  const qy = Math.sin(h);
  const qw = Math.cos(h);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const pelvisY = y + PELVIS_HEIGHT;
  for (let i = 0; i < BONE_COUNT; i++) {
    const b = BONES[i];
    const o = i * 7;
    out[o] = x + b.bx * c + b.bz * s;
    out[o + 1] = pelvisY + b.by;
    out[o + 2] = z - b.bx * s + b.bz * c;
    // Bone rotation = yaw ∘ collider alignment.
    out[o + 3] = qw * b.qx + qy * b.qz;
    out[o + 4] = qw * b.qy + qy * b.qw;
    out[o + 5] = qw * b.qz - qy * b.qx;
    out[o + 6] = qw * b.qw - qy * b.qy;
  }
  return out;
}

/* ================================================================== *
 * Quaternion scratch
 * ================================================================== */

const _q = new Float64Array(4);
const _q2 = new Float64Array(4);
const _v = new Float64Array(3);
const _vec = { x: 0, y: 0, z: 0 };
const _vec2 = { x: 0, y: 0, z: 0 };
const _quat = { x: 0, y: 0, z: 0, w: 1 };
const _poseScratch = new Float32Array(7);

/** out = conj(a) * b, both as {x,y,z,w}. */
function qRelative(
  ax: number, ay: number, az: number, aw: number,
  bx: number, by: number, bz: number, bw: number,
  out: Float64Array,
): void {
  // conj(a) = (-ax,-ay,-az,aw)
  const cx = -ax, cy = -ay, cz = -az, cw = aw;
  out[0] = cw * bx + cx * bw + cy * bz - cz * by;
  out[1] = cw * by - cx * bz + cy * bw + cz * bx;
  out[2] = cw * bz + cx * by - cy * bx + cz * bw;
  out[3] = cw * bw - cx * bx - cy * by - cz * bz;
}

/** Rotate a vector by a quaternion, writing into `out`. */
function qRotate(
  qx: number, qy: number, qz: number, qw: number,
  vx: number, vy: number, vz: number,
  out: Float64Array,
): void {
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out[0] = vx + qw * tx + qy * tz - qz * ty;
  out[1] = vy + qw * ty + qz * tx - qx * tz;
  out[2] = vz + qw * tz + qx * ty - qy * tx;
}

/* ================================================================== *
 * Instances
 * ================================================================== */

export type RagdollState = "active" | "settling" | "settled" | "getup" | "dead";

interface Bone {
  body: RAPIER.RigidBody | null;
  collider: RAPIER.Collider | null;
  obj: PhysicsObject | null;
  joint: RAPIER.ImpulseJoint | null;
}

export interface RagdollOptions {
  /** Health at the moment of collapse; > 0 allows a get-up. */
  canGetUp?: boolean;
  /** Seconds of stillness required before settling. */
  settleHold?: number;
  /** Seconds after settling before a dead ragdoll despawns. -1 keeps it. */
  corpseLifetime?: number;
  /** Blend duration from the death frame to physics, seconds. */
  blendTime?: number;
  /** Anything the owner wants back from the instance. */
  ref?: unknown;
}

export class Ragdoll {
  readonly bones: Bone[] = [];
  state: RagdollState = "active";
  /** 1 = fully animated snapshot, 0 = fully simulated. */
  blend = 1;
  /** Sim time of spawn. */
  born = 0;
  /** Sim time the ragdoll first went quiet. */
  private quietSince = Infinity;
  private settledAt = -1;
  ref: unknown = null;

  private opts: Required<Omit<RagdollOptions, "ref">>;
  /** The animated pose captured at the death frame, 12 × 7 floats. */
  private snapshot = new Float32Array(BONE_COUNT * 7);
  /** Blended output, refreshed lazily by `sampleBone`. */
  private out = new Float32Array(7);

  alive = false;

  constructor(opts: RagdollOptions = {}) {
    this.opts = {
      canGetUp: opts.canGetUp ?? false,
      settleHold: opts.settleHold ?? 0.8,
      corpseLifetime: opts.corpseLifetime ?? 26,
      blendTime: opts.blendTime ?? 0.18,
    };
    this.ref = opts.ref ?? null;
  }

  /* ---------------- construction ---------------- */

  build(pose: Float32Array, vx: number, vy: number, vz: number): boolean {
    const r = rapier();
    const w = physics.world;
    if (!r || !w) return false;

    this.snapshot.set(pose.subarray(0, BONE_COUNT * 7));
    this.blend = 1;
    this.state = "active";
    this.born = physics.simTime;
    this.quietSince = Infinity;
    this.settledAt = -1;

    for (let i = 0; i < BONE_COUNT; i++) {
      const def = BONES[i];
      const o = i * 7;
      const bodyDesc = r.RigidBodyDesc.dynamic()
        .setTranslation(pose[o], pose[o + 1], pose[o + 2])
        .setLinearDamping(0.14)
        // Heavy angular damping is the single biggest anti-jitter lever on a
        // jointed chain; real limbs are damped by muscle and skin.
        .setAngularDamping(2.2)
        .setCanSleep(true)
        .setLinvel(vx, vy, vz);
      _quat.x = pose[o + 3];
      _quat.y = pose[o + 4];
      _quat.z = pose[o + 5];
      _quat.w = pose[o + 6];
      bodyDesc.setRotation(_quat);
      const body = w.createRigidBody(bodyDesc);
      // Extra solver iterations on the ragdoll only: a 12-body joint chain
      // stretches visibly at the global iteration count, and paying for it
      // globally would slow down every vehicle in the city.
      body.setAdditionalSolverIterations(4);

      // The capsule lies along the bone; `q*` rotates +Y onto the bone axis.
      _quat.x = def.qx; _quat.y = def.qy; _quat.z = def.qz; _quat.w = def.qw;
      const collider = w.createCollider(
        r.ColliderDesc.capsule(def.halfHeight, def.radius)
          .setRotation(_quat)
          .setMass(def.mass)
          .setFriction(0.62)
          .setRestitution(0.02)
          .setCollisionGroups(FILTER.ragdoll),
        body,
      );

      const obj = registerObject({
        kind: "ragdoll",
        body,
        colliders: [collider],
        surface: "flesh",
        ref: this,
        interpolate: true,
      });
      this.bones.push({ body, collider, obj, joint: null });
    }

    // Joints, parent-first (the array is topologically ordered by construction).
    for (let i = 1; i < BONE_COUNT; i++) {
      const def = BONES[i];
      if (def.joint === "none" || def.parent < 0) continue;
      const parent = this.bones[def.parent].body!;
      const child = this.bones[i].body!;
      _vec.x = def.px; _vec.y = def.py; _vec.z = def.pz;
      _vec2.x = def.cx; _vec2.y = def.cy; _vec2.z = def.cz;

      let joint: RAPIER.ImpulseJoint;
      if (def.joint === "hinge") {
        const axis = { x: def.hx ?? 1, y: def.hy ?? 0, z: def.hz ?? 0 };
        const jd = r.JointData.revolute(_vec, _vec2, axis);
        joint = w.createImpulseJoint(jd, parent, child, true);
        // Revolute limits are applied post-construction: `JointData.limits` is
        // only honoured for prismatic joints in this binding.
        const unit = joint as unknown as RAPIER.RevoluteImpulseJoint;
        if (typeof unit.setLimits === "function") {
          unit.setLimits(def.hmin ?? -Math.PI, def.hmax ?? Math.PI);
        }
      } else {
        joint = w.createImpulseJoint(r.JointData.spherical(_vec, _vec2), parent, child, true);
      }
      // Adjacent bones overlap by design; letting them collide is pure jitter.
      if (typeof joint.setContactsEnabled === "function") joint.setContactsEnabled(false);
      this.bones[i].joint = joint;
    }

    this.alive = true;
    return true;
  }

  /* ---------------- soft joint limits ---------------- */

  /**
   * Enforce swing-cone and twist limits on the ball joints.
   *
   * Runs inside the fixed step. For each limited joint we take the relative
   * rotation `qRel = conj(qParent) · qChild` (identity at bind), split it into
   * a twist about the bone axis and the remaining swing, and if either exceeds
   * its limit apply an equal-and-opposite angular impulse proportional to the
   * excess, damped by the relative angular velocity along the corrective axis.
   *
   * A soft limit rather than a hard constraint on purpose: hard cones fight
   * the contact solver and pop, soft ones just resist, and the difference is
   * invisible except that one of them looks like a body and the other looks
   * like a bug.
   */
  private solveLimits(dt: number): void {
    const stiffness = 26; // N·m·s per radian of excess
    const damping = 2.4;

    for (let i = 1; i < BONE_COUNT; i++) {
      const def = BONES[i];
      if (def.joint !== "ball") continue;
      const pb = this.bones[def.parent].body;
      const cb = this.bones[i].body;
      if (!pb || !cb || !pb.isValid() || !cb.isValid()) continue;
      if (pb.isSleeping() && cb.isSleeping()) continue;

      const qp = pb.rotation();
      const qc = cb.rotation();
      qRelative(qp.x, qp.y, qp.z, qp.w, qc.x, qc.y, qc.z, qc.w, _q);

      // --- swing-twist decomposition about the bone axis ---------
      const ax = def.ax, ay = def.ay, az = def.az;
      const proj = _q[0] * ax + _q[1] * ay + _q[2] * az;
      let tx = ax * proj, ty = ay * proj, tz = az * proj;
      let tw = _q[3];
      let tl = Math.hypot(tx, ty, tz, tw);
      if (tl < 1e-8) {
        tx = 0; ty = 0; tz = 0; tw = 1; tl = 1;
      }
      tx /= tl; ty /= tl; tz /= tl; tw /= tl;

      // swing = qRel · conj(twist)
      const cxq = -tx, cyq = -ty, czq = -tz, cwq = tw;
      const sx = _q[3] * cxq + _q[0] * cwq + _q[1] * czq - _q[2] * cyq;
      const sy = _q[3] * cyq - _q[0] * czq + _q[1] * cwq + _q[2] * cxq;
      const sz = _q[3] * czq + _q[0] * cyq - _q[1] * cxq + _q[2] * cwq;
      const sw = _q[3] * cwq - _q[0] * cxq - _q[1] * cyq - _q[2] * czq;

      const swingLimit = def.swing ?? Math.PI;
      const twistLimit = def.twist ?? Math.PI;

      const swingSin = Math.hypot(sx, sy, sz);
      const swingAngle = 2 * Math.atan2(swingSin, Math.abs(sw));
      const twistAngle = 2 * Math.atan2(proj >= 0 ? Math.hypot(tx, ty, tz) : -Math.hypot(tx, ty, tz), Math.abs(tw));

      // Relative angular velocity, world space.
      const wp = pb.angvel();
      const wc = cb.angvel();
      const rvx = wc.x - wp.x;
      const rvy = wc.y - wp.y;
      const rvz = wc.z - wp.z;

      let cx2 = 0, cy2 = 0, cz2 = 0;

      if (swingAngle > swingLimit && swingSin > 1e-6) {
        // Corrective axis: the swing axis, expressed in the parent's frame and
        // then in world space. Negative because we push the child back.
        qRotate(qp.x, qp.y, qp.z, qp.w, sx / swingSin, sy / swingSin, sz / swingSin, _v);
        const excess = swingAngle - swingLimit;
        const along = rvx * _v[0] + rvy * _v[1] + rvz * _v[2];
        const mag = -(stiffness * excess + damping * Math.max(0, along)) * dt;
        cx2 += _v[0] * mag;
        cy2 += _v[1] * mag;
        cz2 += _v[2] * mag;
      }

      const twistAbs = Math.abs(twistAngle);
      if (twistAbs > twistLimit) {
        qRotate(qp.x, qp.y, qp.z, qp.w, ax, ay, az, _v);
        const sign = twistAngle >= 0 ? 1 : -1;
        const excess = twistAbs - twistLimit;
        const along = (rvx * _v[0] + rvy * _v[1] + rvz * _v[2]) * sign;
        const mag = -sign * (stiffness * 0.7 * excess + damping * Math.max(0, along)) * dt;
        cx2 += _v[0] * mag;
        cy2 += _v[1] * mag;
        cz2 += _v[2] * mag;
      }

      if (cx2 !== 0 || cy2 !== 0 || cz2 !== 0) {
        _vec.x = cx2; _vec.y = cy2; _vec.z = cz2;
        cb.applyTorqueImpulse(_vec, true);
        _vec.x = -cx2; _vec.y = -cy2; _vec.z = -cz2;
        pb.applyTorqueImpulse(_vec, true);
      }
    }
  }

  /* ---------------- per-frame ---------------- */

  /** Advance blend, limits and the settling state machine. */
  step(dt: number): void {
    if (!this.alive) return;

    if (this.blend > 0) {
      this.blend = Math.max(0, this.blend - dt / this.opts.blendTime);
    }

    this.solveLimits(dt);

    // Kinetic energy proxy: sum of |v| + |ω| over the skeleton. Cheap, and it
    // catches the case a pure velocity test misses — a corpse spinning on a
    // railing with almost no linear speed.
    let energy = 0;
    let awake = false;
    for (let i = 0; i < BONE_COUNT; i++) {
      const b = this.bones[i].body;
      if (!b || !b.isValid()) continue;
      if (!b.isSleeping()) awake = true;
      const v = b.linvel();
      const a = b.angvel();
      energy += Math.hypot(v.x, v.y, v.z) + Math.hypot(a.x, a.y, a.z) * 0.25;
    }

    const now = physics.simTime;
    if (energy < 1.6 || !awake) {
      if (this.quietSince === Infinity) this.quietSince = now;
      if (this.state === "active") this.state = "settling";
      if (now - this.quietSince > this.opts.settleHold && this.state === "settling") {
        this.state = this.opts.canGetUp ? "getup" : "settled";
        this.settledAt = now;
        if (!this.opts.canGetUp) this.sleepAll();
      }
    } else {
      this.quietSince = Infinity;
      if (this.state === "settling") this.state = "active";
    }

    if (this.state === "settled") {
      this.settledAt = this.settledAt < 0 ? now : this.settledAt;
      if (this.opts.corpseLifetime > 0 && now - this.settledAt > this.opts.corpseLifetime) {
        this.state = "dead";
      }
    }
  }

  private sleepAll(): void {
    for (let i = 0; i < BONE_COUNT; i++) {
      const b = this.bones[i].body;
      if (b && b.isValid()) b.sleep();
    }
  }

  /** Wake the whole skeleton — a corpse that gets shot should react. */
  wake(): void {
    for (let i = 0; i < BONE_COUNT; i++) {
      const b = this.bones[i].body;
      if (b && b.isValid()) b.wakeUp();
    }
    if (this.state === "settled") {
      this.state = "active";
      this.quietSince = Infinity;
    }
  }

  /* ---------------- sampling ---------------- */

  /**
   * Blended world transform of a bone: [x,y,z,qx,qy,qz,qw].
   *
   * The returned array is scratch — copy out of it before the next call.
   */
  sampleBone(index: number, out?: Float32Array): Float32Array {
    const dst = out ?? this.out;
    const bone = this.bones[index];
    if (!bone || !bone.obj) {
      dst.set(this.snapshot.subarray(index * 7, index * 7 + 7));
      return dst;
    }
    // Interpolated simulated pose.
    const objSample = _poseScratch;
    if (!sampleTransform(bone.obj, objSample)) {
      dst.set(this.snapshot.subarray(index * 7, index * 7 + 7));
      return dst;
    }
    const t = this.blend;
    if (t <= 0) {
      dst.set(objSample);
      return dst;
    }
    // Ease the blend: linear cross-fades read as a slide, smoothstep as a
    // settle. The animator's pose has to *give way*, not slew.
    const e = t * t * (3 - 2 * t);
    const o = index * 7;
    for (let i = 0; i < 3; i++) {
      dst[i] = objSample[i] + (this.snapshot[o + i] - objSample[i]) * e;
    }
    let dot = 0;
    for (let i = 3; i < 7; i++) dot += objSample[i] * this.snapshot[o + i];
    const s = dot < 0 ? -1 : 1;
    let len = 0;
    for (let i = 3; i < 7; i++) {
      dst[i] = objSample[i] + (this.snapshot[o + i] * s - objSample[i]) * e;
      len += dst[i] * dst[i];
    }
    len = Math.sqrt(len) || 1;
    for (let i = 3; i < 7; i++) dst[i] /= len;
    return dst;
  }

  /** Pelvis world position — the AI/camera "where is the body" query. */
  rootPosition(out: Float32Array): Float32Array {
    return this.sampleBone(0, out);
  }

  applyImpulse(boneIndex: number, ix: number, iy: number, iz: number): void {
    const b = this.bones[boneIndex]?.body;
    if (!b || !b.isValid()) return;
    _vec.x = ix; _vec.y = iy; _vec.z = iz;
    b.applyImpulse(_vec, true);
    this.wake();
  }

  applyImpulseAt(
    boneIndex: number,
    ix: number, iy: number, iz: number,
    px: number, py: number, pz: number,
  ): void {
    const b = this.bones[boneIndex]?.body;
    if (!b || !b.isValid()) return;
    _vec.x = ix; _vec.y = iy; _vec.z = iz;
    _vec2.x = px; _vec2.y = py; _vec2.z = pz;
    b.applyImpulseAtPoint(_vec, _vec2, true);
    this.wake();
  }

  /** Which bone owns a physics object, or -1. Weapons use it for hit zones. */
  boneOf(obj: PhysicsObject | null): number {
    if (!obj) return -1;
    for (let i = 0; i < this.bones.length; i++) if (this.bones[i].obj === obj) return i;
    return -1;
  }

  destroy(): void {
    const w = physics.world;
    for (const b of this.bones) {
      unregisterObject(b.obj);
      if (w && b.body && b.body.isValid()) w.removeRigidBody(b.body);
      b.body = null;
      b.collider = null;
      b.obj = null;
      b.joint = null;
    }
    this.bones.length = 0;
    this.alive = false;
  }
}

/* ================================================================== *
 * The manager
 * ================================================================== */

class RagdollManager {
  private live: Ragdoll[] = [];
  private tier: QualityTier = "high";

  readonly stats = { live: 0, spawned: 0, retired: 0 };

  setQuality(tier: QualityTier): void {
    this.tier = tier;
    while (this.live.length > this.maxRagdolls()) this.despawn(this.live[0]);
  }

  /**
   * Twelve bodies and eleven joints each is expensive, so the ragdoll budget
   * is a fraction of the global body budget: roughly one ragdoll per forty
   * bodies, which lands at 1 on Low and 10 on Ultra.
   */
  private maxRagdolls(): number {
    return Math.max(1, Math.floor(QUALITY[this.tier].maxRigidBodies / 40));
  }

  /**
   * Spawn a ragdoll at an animated pose.
   *
   * `pose` is BONE_COUNT × 7 floats — the death frame. Use `defaultPose()` if
   * the caller has no skeleton. Returns null before physics boots or if the
   * budget could not be freed.
   */
  spawn(
    pose: Float32Array,
    vx = 0,
    vy = 0,
    vz = 0,
    opts: RagdollOptions = {},
  ): Ragdoll | null {
    if (!physics.world) return null;
    while (this.live.length >= this.maxRagdolls()) {
      // Oldest first — the corpse the player has had the longest to look at.
      this.despawn(this.live[0]);
    }
    const r = new Ragdoll(opts);
    if (!r.build(pose, vx, vy, vz)) {
      r.destroy();
      return null;
    }
    this.live.push(r);
    this.stats.live = this.live.length;
    this.stats.spawned++;
    return r;
  }

  /** Step every live ragdoll. Call from the fixed step. */
  update(dt: number): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const r = this.live[i];
      r.step(dt);
      if (r.state === "dead") this.despawn(r);
    }
    this.stats.live = this.live.length;
  }

  despawn(r: Ragdoll): void {
    // splice, not swap-and-pop: the list is kept oldest-first so the budget
    // eviction above always retires the corpse that has been around longest.
    const i = this.live.indexOf(r);
    if (i >= 0) this.live.splice(i, 1);
    r.destroy();
    this.stats.live = this.live.length;
    this.stats.retired++;
  }

  /** Find the ragdoll that owns a physics object (bullet hit → hit zone). */
  ragdollFor(obj: PhysicsObject | null): Ragdoll | null {
    if (!obj || obj.kind !== "ragdoll") return null;
    return obj.ref instanceof Ragdoll ? obj.ref : null;
  }

  clear(): void {
    for (let i = this.live.length - 1; i >= 0; i--) this.live[i].destroy();
    this.live.length = 0;
    this.stats.live = 0;
  }

  /** All live ragdolls, for the renderer's skinning pass. */
  all(): readonly Ragdoll[] {
    return this.live;
  }
}

export const ragdolls = new RagdollManager();

/** Blend factor helper for callers driving their own crossfade. */
export function ragdollBlendEase(t: number): number {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}
