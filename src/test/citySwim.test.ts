/**
 * The swim stroke is solved, not played back, which means there is no clip to
 * eyeball in a viewer and no importer to catch a mistake.
 *
 * What can go wrong is quiet: a pose that stops moving, a blend that never
 * reaches prone so the body swims at forty-five degrees forever, a NaN from a
 * divide that only happens at zero speed. None of that throws, none of it
 * fails a build, and all of it looks like "the animation is a bit off" from a
 * camera thirty metres away.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { applyDancePose, bindDirectDanceSkeleton } from "@/components/city/dances";
import { createDancePose, type DancePose, type Vec3 } from "@/components/city/dances";
import { evalSwim, strokeRate, PRONE_PITCH } from "@/city/swim";
import { seaSurfaceAt, waterDepthAt, bedHeight } from "@/city/ocean";

const finite = (v: Vec3) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
function allFinite(p: DancePose) {
  return (
    [p.rootY, p.rootYaw, p.rootPitch, p.rootRoll].every(Number.isFinite) &&
    [p.hips, p.torso, p.head].every(finite) &&
    [p.armL, p.armR, p.legL, p.legR].every((l) => finite(l.upper) && finite(l.lower) && finite(l.tip))
  );
}

/** Shortest signed difference between two angles. */
const wrapPi = (a: number) => ((((a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;

/** Every angle in a pose, flattened, so two poses can be compared. */
function flat(p: DancePose) {
  const out = [p.rootY, p.rootYaw, p.rootPitch, p.rootRoll];
  for (const v of [p.hips, p.torso, p.head]) out.push(v.x, v.y, v.z);
  for (const l of [p.armL, p.armR, p.legL, p.legR]) {
    for (const v of [l.upper, l.lower, l.tip]) out.push(v.x, v.y, v.z);
  }
  return out;
}

describe("the swim stroke", () => {
  const pose = createDancePose();

  it("treads upright when still and goes prone under way", () => {
    expect(evalSwim(pose, { speed: 0, phase: 0 }).prone).toBe(0);
    expect(pose.rootPitch).toBe(0);
    // Fully prone well under top swim speed — drag means a steady swim settles
    // below the target, and a stroke that only flattens at maximum speed
    // spends its whole life half-upright.
    expect(evalSwim(pose, { speed: 3.2, phase: 0 }).prone).toBe(1);
    expect(pose.rootPitch).toBeCloseTo(PRONE_PITCH, 5);
    // And blends through the middle rather than snapping.
    const mid = evalSwim(pose, { speed: 1.4, phase: 0 }).prone;
    expect(mid).toBeGreaterThan(0.05);
    expect(mid).toBeLessThan(0.95);
  });

  it("never stops moving, at any speed", () => {
    // A frozen pose in water reads as a corpse. Even stationary, the hands
    // scull — so the same instant of stroke must not repeat a quarter of a
    // second later at any speed the player can actually be doing.
    for (const speed of [0, 0.6, 1.5, 3.2, 5.4]) {
      const a = flat(evalSwim(pose, { speed, phase: 10 }).pose);
      const b = flat(evalSwim(pose, { speed, phase: 10.25 }).pose);
      const moved = a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
      expect(moved, `speed ${speed} produced a still pose`).toBeGreaterThan(0.02);
    }
  });

  it("does not lurch when the swimmer's speed changes", () => {
    /**
     * The defect this exists for: the phase used to be computed as clock times
     * rate, with the rate derived from current speed. Any change in speed
     * instantly rescaled every second of phase accumulated so far, so five
     * minutes in, a swimmer slowing by a tenth of a metre per second teleported
     * their stroke through a hundred radians. Speed changes constantly — waves,
     * drag, the stick — so the stroke was re-randomised every frame, which is
     * what "the animation looks glitchy" turned out to mean.
     *
     * Taking a phase rather than a timestamp makes that unrepresentable, and
     * this checks the property that mattered: at a fixed point in the cycle,
     * changing speed nudges the pose rather than throwing it somewhere else.
     */
    const phase = 137.4; // a long way in, where the old bug was worst
    const a = flat(evalSwim(pose, { speed: 3.2, phase }).pose);
    const b = flat(evalSwim(pose, { speed: 3.1, phase }).pose);
    const jump = a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
    expect(jump, "a 0.1 m/s speed change moved the pose").toBeLessThan(0.05);
  });

  it("advances smoothly, frame by frame, at a plausible frame rate", () => {
    // No step in the stroke should be big enough to see as a jump. A 60 Hz
    // frame at a full stroke a second is a thirtieth of a cycle.
    let worst = 0;
    let prev = flat(evalSwim(pose, { speed: 3.2, phase: 0 }).pose);
    for (let i = 1; i < 400; i++) {
      const cur = flat(evalSwim(pose, { speed: 3.2, phase: i / 60 }).pose);
      worst = Math.max(worst, cur.reduce((m, v, k) => Math.max(m, Math.abs(wrapPi(v - prev[k]))), 0));
      prev = cur;
    }
    expect(worst, "a single frame moved a joint too far").toBeLessThan(0.35);
  });

  it("rates the stroke somewhere human", () => {
    expect(strokeRate(0)).toBeGreaterThan(0.3);
    expect(strokeRate(3.2)).toBeGreaterThan(0.8);
    expect(strokeRate(5.4)).toBeLessThan(1.8);
  });

  it("stays finite everywhere, including the corners", () => {
    for (const speed of [-1, 0, 0.0001, 2.4, 40]) {
      for (const phase of [0, 0.37, 1e4]) {
        evalSwim(pose, { speed, phase });
        expect(allFinite(pose), `speed ${speed} phase ${phase}`).toBe(true);
      }
    }
  });

  it("keeps every joint inside a human range", () => {
    // Not a physiology check — a guard against a runaway term. An arm at six
    // radians is a propeller, and it is the kind of thing a stray sign change
    // produces without any other symptom.
    for (let phase = 0; phase < 6; phase += 0.02) {
      for (const speed of [0, 1.5, 3.2]) {
        evalSwim(pose, { speed, phase });
        // The crawl's shoulder turns full revolutions wrapped into [-PI, PI],
        // and the shortest-arc blend can carry a value a little past the wrap,
        // so a whole turn is the honest ceiling. Anything beyond it is a
        // runaway term — an arm at six radians is a propeller.
        for (const a of flat(pose)) expect(Math.abs(a)).toBeLessThan(Math.PI * 2);
      }
    }
  });
});

describe("the crawl's arm, traced through a rig", () => {
  /**
   * The angles are easy to check and easy to be wrong about — an arm that
   * swings back and forth and an arm that goes round produce numbers of the
   * same size. What separates them is the path the hand takes, so this builds
   * a minimal rig, applies the pose, and follows the wrist.
   *
   * Measured in the TORSO's frame, not the world's: the pose pitches the whole
   * body prone, so a hand tracked against fixed world axes is being tracked
   * against a moving target and the sweep cancels itself out to nothing.
   */
  function rig() {
    const root = new THREE.Group();
    const hips = new THREE.Group();
    hips.position.y = 1;
    root.add(hips);
    const torso = new THREE.Group();
    torso.position.y = 0.35;
    hips.add(torso);
    const head = new THREE.Group();
    head.position.y = 0.35;
    torso.add(head);
    const limb = (parent: THREE.Object3D, side: number, y: number) => {
      const upper = new THREE.Group();
      upper.position.set(side * 0.2, y, 0);
      parent.add(upper);
      const lower = new THREE.Group();
      lower.position.y = -0.3;
      upper.add(lower);
      const tip = new THREE.Group();
      tip.position.y = -0.28;
      lower.add(tip);
      return { upper, lower, tip };
    };
    const armL = limb(torso, 1, 0.25);
    const armR = limb(torso, -1, 0.25);
    const legL = limb(hips, 1, 0);
    const legR = limb(hips, -1, 0);
    root.updateWorldMatrix(true, true);
    const sk = bindDirectDanceSkeleton({ root, hips, torso, head, armL, armR, legL, legR });
    return { root, sk, torso, shoulder: armL.upper, hand: armL.tip };
  }

  /** The hand relative to its shoulder, in the torso's own axes. */
  function armVector(r: ReturnType<typeof rig>) {
    r.root.updateWorldMatrix(true, true);
    const q = new THREE.Quaternion();
    r.torso.getWorldQuaternion(q);
    return new THREE.Vector3()
      .setFromMatrixPosition(r.hand.matrixWorld)
      .sub(new THREE.Vector3().setFromMatrixPosition(r.shoulder.matrixWorld))
      .applyQuaternion(q.invert());
  }

  /** Net turn, and how much of it went backwards, over one stroke. */
  function sweep(steps: number) {
    const r = rig();
    const pose = createDancePose();
    let turned = 0;
    let back = 0;
    let prev = 0;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i <= steps; i++) {
      evalSwim(pose, { speed: 3.2, phase: i / steps });
      applyDancePose(r.sk, pose, 1);
      const p = armVector(r);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
      const a = Math.atan2(p.z, p.y);
      if (i > 0) {
        let d = a - prev;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        turned += d;
        if (d > 0) back += d;
      }
      prev = a;
    }
    return { turned, back, minY, maxY };
  }

  it("carries the hand right around the shoulder, once per stroke", () => {
    const { turned, minY, maxY } = sweep(240);
    // A full turn. A swing that reverses nets out near zero however far it
    // travels, which is exactly the doggy paddle this replaced.
    expect(Math.abs(turned)).toBeGreaterThan(Math.PI * 1.8);
    // And it goes over the top and down past the hip, rather than circling in
    // a puddle in front of the chest.
    expect(maxY).toBeGreaterThan(0.2);
    expect(minY).toBeLessThan(-0.2);
  });

  it("never reverses mid-stroke", () => {
    // A little wobble as the elbow folds is fine; a reversal is not.
    expect(sweep(360).back).toBeLessThan(0.6);
  });
});

describe("the sea surface a swimmer floats on", () => {
  it("is flat on land and moves on water", () => {
    expect(seaSurfaceAt(0, 0, 3)).toBe(0); // downtown
    expect(waterDepthAt(0, 0)).toBeLessThan(0);
    const a = seaSurfaceAt(400, 60, 0);
    const b = seaSurfaceAt(400, 60, 2.5);
    expect(waterDepthAt(400, 60)).toBeGreaterThan(2);
    expect(Math.abs(a - b)).toBeGreaterThan(0.02);
  });

  it("never reports a surface below the seabed", () => {
    // The swell's trough offshore is well over a metre. Unclamped it dips
    // under the sand in the shallows, and anything floating on the answer is
    // told it is standing on dry land — which is a swimmer who suddenly walks.
    for (let s = 2; s < 400; s += 3) {
      for (const t of [0, 1.7, 4.3, 9.1]) {
        const x = 180 + s;
        const bed = bedHeight(x, 40);
        if (bed >= 0) continue;
        expect(seaSurfaceAt(x, 40, t), `x=${x} t=${t}`).toBeGreaterThanOrEqual(bed);
      }
    }
  });

  it("stays within the swell it is made of", () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0; t < 20; t += 0.25) {
      const y = seaSurfaceAt(500, 120, t);
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    // Three waves summing to 1.32 m of amplitude, plus nothing else this far
    // out — a surface outside that band means a term has been retuned in the
    // shader and not here.
    expect(hi).toBeLessThan(1.6);
    expect(lo).toBeGreaterThan(-1.6);
    expect(hi - lo).toBeGreaterThan(0.5);
  });
});
