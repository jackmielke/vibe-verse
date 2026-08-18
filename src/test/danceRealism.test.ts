/**
 * The realism pass, tested where a filmstrip runs out.
 *
 * `scripts/dance-gif.mjs` renders four dancers and a control with the groove
 * switched off, which is the right instrument for "does this read as people".
 * It is a bad instrument for the two claims underneath that, because both are
 * about magnitudes of a few milliseconds and a few degrees:
 *
 *   1. that a body has follow-through, and that it runs *down* the body — the
 *      hips lead and the hands arrive last. Get the ladder backwards and the
 *      render still looks fine in stills and subtly wrong in motion.
 *   2. that two dancers are actually different people rather than the same
 *      person with a different name. The first pass of `makeGroove` used
 *      ranges so tight that the grooved render and the control were nearly
 *      indistinguishable, which is the same as not having built it.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";

import {
  DANCE_LAG,
  STRAIGHT,
  applyDancePose,
  bindDirectDanceSkeleton,
  createDancePose,
  evalDance,
  evalDanceGrooved,
  findDance,
  makeGroove,
  resetDancePose,
} from "@/components/city/dances";

/** A bare two-arm rig, so a joint's angle can be read straight off. */
function rig() {
  const root = new THREE.Group();
  const hips = new THREE.Group();
  const torso = new THREE.Group();
  const upper = new THREE.Group();
  const lower = new THREE.Group();
  root.add(hips);
  hips.add(torso);
  torso.add(upper);
  upper.add(lower);
  const sk = bindDirectDanceSkeleton({
    root,
    hips,
    torso,
    armL: { upper, lower },
  });
  return { root, hips, torso, upper, lower, sk };
}

describe("follow-through", () => {
  it("does not arrive instantly", () => {
    const { upper, sk } = rig();
    const pose = resetDancePose(createDancePose());
    pose.armL.upper.z = 1.2;
    // One 60fps frame of a 45ms lag gets most of the way, never all of it.
    applyDancePose(sk, pose, 1, 1 / 60);
    const reached = upper.rotation.z;
    expect(reached).toBeGreaterThan(0);
    expect(reached).toBeLessThan(1.2);
  });

  it("runs down the body — hips lead, hands arrive last", () => {
    /*
     * The claim that makes this look like a body instead of a puppet. Same
     * pose, same frame, on four joints at increasing distance from the root:
     * each one must be a smaller fraction of the way there than the last.
     */
    const { hips, torso, upper, lower, sk } = rig();
    const pose = resetDancePose(createDancePose());
    pose.hips.z = 1;
    pose.torso.z = 1;
    pose.armL.upper.z = 1;
    pose.armL.lower.z = 1;
    applyDancePose(sk, pose, 1, 1 / 60);

    // `torso` also receives the spine's share, so read the raw progress of
    // each joint toward its own target of 1 radian.
    const progress = [hips.rotation.z, torso.rotation.z, upper.rotation.z, lower.rotation.z];
    for (let i = 1; i < progress.length; i++) {
      expect(
        progress[i],
        `joint ${i} should trail joint ${i - 1}`,
      ).toBeLessThan(progress[i - 1]);
    }
  });

  it("is the same lag at 30fps as at 144fps", () => {
    // Framerate-independent, or follow-through becomes a property of the
    // player's machine: a fast laptop would dance tighter than a slow one.
    const slow = rig();
    const fast = rig();
    const pose = resetDancePose(createDancePose());
    pose.armL.upper.z = 1;
    const SECONDS = 0.25;
    for (let t = 0; t < SECONDS; t += 1 / 30) applyDancePose(slow.sk, pose, 1, 1 / 30);
    for (let t = 0; t < SECONDS; t += 1 / 144) applyDancePose(fast.sk, pose, 1, 1 / 144);
    expect(slow.upper.rotation.z).toBeCloseTo(fast.upper.rotation.z, 2);
  });

  it("snaps when a dance asks it to", () => {
    // The robot's whole joke is that the joints arrive instantly and hold.
    const { upper, sk } = rig();
    const pose = resetDancePose(createDancePose());
    pose.armL.upper.z = 1.2;
    applyDancePose(sk, pose, 1, 1 / 60, findDance("robot")!.lag);
    expect(upper.rotation.z).toBeCloseTo(1.2, 2);
    // ...and that the default is NOT a snap, or the override means nothing.
    const soft = rig();
    applyDancePose(soft.sk, pose, 1, 1 / 60, DANCE_LAG);
    expect(soft.upper.rotation.z).toBeLessThan(1.15);
  });
});

describe("groove", () => {
  const def = findDance("floss")!;
  const angles = (g: ReturnType<typeof makeGroove>, ms: number) => {
    const p = evalDanceGrooved(def, createDancePose(), g, ms);
    return [p.armL.upper.z, p.armR.upper.z, p.hips.z, p.rootY];
  };

  it("makes two dancers visibly different at the same instant", () => {
    /*
     * The number that matters. Two dancers on the same move at the same
     * millisecond have to differ by something a person can see — a couple of
     * degrees is not it. The first version of this passed a "they differ"
     * check while being invisible on screen, so the threshold is set where the
     * eye is, not where floating point is.
     */
    const a = makeGroove(11);
    const b = makeGroove(12);
    let worst = 0;
    for (let ms = 0; ms < 4000; ms += 40) {
      const x = angles(a, ms);
      const y = angles(b, ms);
      for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(x[i] - y[i]));
    }
    expect(worst).toBeGreaterThan(0.12); // ~7 degrees, plainly visible
  });

  it("is the same person every time you meet them", () => {
    // Seeded, so the regular who rushes is always the regular who rushes.
    expect(makeGroove(7)).toEqual(makeGroove(7));
    expect(makeGroove(7).push).not.toBe(makeGroove(8).push);
  });

  it("stays within a believable band", () => {
    // Loose enough to read, tight enough that nobody looks like they cannot
    // hear the music. A third of a beat late is not feel, it is a mistake.
    for (let seed = 0; seed < 200; seed++) {
      const g = makeGroove(seed);
      expect(Math.abs(g.push)).toBeLessThan(0.09);
      expect(g.amp).toBeGreaterThan(0.7);
      expect(g.amp).toBeLessThan(1.3);
      expect(g.lift).toBeGreaterThan(0.6);
      expect(g.lift).toBeLessThan(1.4);
    }
  });

  it("leaves the straight groove exactly as the ungrooved dance", () => {
    // STRAIGHT has to be a true no-op, because it is what everything that
    // does not care about feel passes in.
    const plain = evalDance(def, createDancePose(), 123_456);
    const straight = evalDanceGrooved(def, createDancePose(), STRAIGHT, 123_456);
    expect(straight.armL.upper.z).toBeCloseTo(plain.armL.upper.z, 12);
    expect(straight.rootY).toBeCloseTo(plain.rootY, 12);
  });

  it("never wanders far enough to fall off the beat", () => {
    // The wander is what stops a groove being a constant offset. It must not
    // grow into somebody dancing to a different bar.
    const g = makeGroove(3);
    for (let ms = 0; ms < 120_000; ms += 250) {
      const p = evalDanceGrooved(def, createDancePose(), g, ms);
      for (const v of [p.armL.upper.z, p.hips.z, p.torso.y]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(Math.abs(v)).toBeLessThan(3.4);
      }
    }
  });
});
