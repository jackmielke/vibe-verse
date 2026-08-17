/**
 * Dances, tested where a contact sheet cannot help.
 *
 * `scripts/dance-shots.mjs` is the check on whether a move *looks* like the
 * thing it is named after — no assertion can do that job, and none here tries.
 * What is testable is everything a strip of eight frames quietly misses:
 *
 *   1. a dance that has gone numerically wrong (a NaN from a divide, an angle
 *      of forty radians) still renders — as a character folded inside out, or
 *      as a limb that vanishes, on somebody else's screen and not on the one
 *      the frames were captured from;
 *   2. a dance with a dead half-bar, which a strip only catches if the strip
 *      happens to span it — the "raise the roof" that pushed on every OTHER
 *      beat shipped past two rounds of looking at pictures;
 *   3. the shared clock, which is what makes a crowd dance together and is
 *      invisible in any single-character capture;
 *   4. the rig binder's promise that a pose applied at weight 0 is the same as
 *      no pose at all, since that is the whole basis of the fade.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";

import {
  DANCES,
  applyDancePose,
  bindDirectDanceSkeleton,
  createDancePose,
  danceBeats,
  danceBpm,
  evalDance,
  findDance,
  randomDanceId,
  resetDancePose,
  stepDanceWeight,
  type DancePose,
} from "@/components/city/dances";

/** Every angle in a pose, flattened, so a whole frame can be swept at once. */
function angles(p: DancePose): number[] {
  const out = [p.rootY, p.rootYaw, p.rootPitch, p.rootRoll];
  for (const v of [p.hips, p.torso, p.head]) out.push(v.x, v.y, v.z);
  for (const l of [p.armL, p.armR, p.legL, p.legR]) {
    for (const v of [l.upper, l.lower, l.tip]) out.push(v.x, v.y, v.z);
  }
  return out;
}

/**
 * Sample one dance densely over four bars — `steps + 1` frames, so the last
 * beat's window has a frame on the far side of it to compare against. The
 * moves that hold a pose for a whole beat and snap between them (the robot)
 * put *all* their motion on that boundary, and dropping it reads as a dance
 * that stopped.
 */
function sweep(id: string, steps = 128, beats = 16): number[][] {
  const def = findDance(id)!;
  const pose = createDancePose();
  const frames: number[][] = [];
  for (let i = 0; i <= steps; i++) {
    const b = (i / steps) * beats;
    evalDance(def, pose, (b / (danceBpm(def) / 60)) * 1000);
    frames.push(angles(pose));
  }
  return frames;
}

describe("dances", () => {
  it("has unique ids and a sane tempo for each move", () => {
    const ids = DANCES.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of DANCES) {
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.emoji.length).toBeGreaterThan(0);
      // Outside this range it is not a dance tempo, it is a bug in a constant.
      expect(danceBpm(d)).toBeGreaterThanOrEqual(50);
      expect(danceBpm(d)).toBeLessThanOrEqual(260);
      // Whole-number subdivisions only: a move at ×1.37 would never land on
      // the bar, and one track under nine dances is the whole point.
      expect([0.25, 0.5, 1, 2, 4]).toContain(d.beat);
    }
  });

  it("never produces a NaN or a joint angle past what a body can do", () => {
    for (const d of DANCES) {
      for (const frame of sweep(d.id)) {
        for (const a of frame) {
          expect(Number.isFinite(a)).toBe(true);
          // π is already "the limb has folded all the way through the body";
          // anything past 3.4 rad is arithmetic, not choreography.
          expect(Math.abs(a)).toBeLessThan(3.4);
        }
      }
    }
  });

  it("keeps the whole body within a hop of the floor", () => {
    for (const d of DANCES) {
      for (const frame of sweep(d.id)) {
        const rootY = frame[0];
        expect(rootY).toBeGreaterThan(-0.5);
        expect(rootY).toBeLessThan(0.6);
      }
    }
  });

  it("moves on every beat, not every other one", () => {
    // The failure this exists for: a half-bar where the character stands
    // perfectly still because a `clamp01(sin)` only ever fires on the upswing.
    for (const d of DANCES) {
      const frames = sweep(d.id, 96, 12);
      // Slide a one-beat window across and demand real movement inside it.
      const perBeat = 96 / 12;
      for (let beat = 0; beat < 12; beat++) {
        const window = frames.slice(beat * perBeat, (beat + 1) * perBeat + 1);
        let spread = 0;
        for (let j = 0; j < window[0].length; j++) {
          const col = window.map((f) => f[j]);
          spread = Math.max(spread, Math.max(...col) - Math.min(...col));
        }
        expect(
          spread,
          `${d.id} barely moves during beat ${beat} (max spread ${spread.toFixed(3)} rad)`,
        ).toBeGreaterThan(0.08);
      }
    }
  });

  it("puts everybody on the same beat from the same clock", () => {
    // Two dancers who started at different times must still agree, because
    // that is the entire reason the network carries an id and not a phase.
    const def = findDance("floss")!;
    const a = createDancePose();
    const b = createDancePose();
    evalDance(def, a, 1_700_000_000_000);
    evalDance(def, b, 1_700_000_000_000);
    expect(angles(a)).toEqual(angles(b));

    // And the clock has to actually advance: one bar later is a different pose.
    evalDance(def, b, 1_700_000_000_000 + (60_000 / danceBpm(def)) * 0.5);
    expect(angles(a)).not.toEqual(angles(b));
    expect(danceBeats(def, 60_000)).toBeCloseTo(danceBpm(def), 6);
  });

  it("always hands you a different dance than the one you're doing", () => {
    for (let i = 0; i < 200; i++) {
      expect(randomDanceId("floss")).not.toBe("floss");
    }
    // An unknown id excludes nothing, and must still return something real.
    expect(findDance(randomDanceId("not-a-dance"))).not.toBeNull();
    expect(findDance(null)).toBeNull();
  });

  it("fades in and out at the same rate in both directions", () => {
    let w = 0;
    for (let i = 0; i < 60; i++) w = stepDanceWeight(w, true, 1 / 60);
    expect(w).toBe(1);
    for (let i = 0; i < 60; i++) w = stepDanceWeight(w, false, 1 / 60);
    expect(w).toBe(0);
    // A single enormous frame (tab-switch, GC pause) must not overshoot.
    expect(stepDanceWeight(0, true, 10)).toBe(1);
    expect(stepDanceWeight(1, false, 10)).toBe(0);
  });

  it("leaves a rig untouched at weight zero", () => {
    // The fade rests on this: at 0 the dance must be indistinguishable from
    // never having been applied, or every character twitches on release.
    const root = new THREE.Group();
    const hips = new THREE.Group();
    const shoulder = new THREE.Group();
    root.add(hips);
    hips.add(shoulder);
    shoulder.rotation.set(0.3, -0.2, 0.1); // some live gait pose
    const before = shoulder.quaternion.clone();

    const sk = bindDirectDanceSkeleton({ root, hips, armL: { upper: shoulder } });
    const pose = createDancePose();
    findDance("floss")!.pose(1.37, pose);
    applyDancePose(sk, pose, 0);

    expect(shoulder.quaternion.angleTo(before)).toBeCloseTo(0, 10);
    expect(root.position.y).toBeCloseTo(0, 10);
  });

  it("reaches the pose exactly at weight one", () => {
    const root = new THREE.Group();
    const shoulder = new THREE.Group();
    root.add(shoulder);
    const sk = bindDirectDanceSkeleton({ root, armR: { upper: shoulder } });

    const pose = resetDancePose(createDancePose());
    pose.armR.upper.z = -0.9; // right arm out to its own side
    applyDancePose(sk, pose, 1);

    const want = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -0.9, "ZYX"));
    expect(shoulder.quaternion.angleTo(want)).toBeCloseTo(0, 6);
  });

  it("levels the ankle against the knee it hangs off", () => {
    // No foot IK here: without this the character dances on its toes. The
    // ankle has to cancel exactly what the hip and knee put into it.
    const pose = createDancePose();
    for (const d of DANCES) {
      for (let i = 0; i < 64; i++) {
        evalDance(d, pose, i * 37);
        for (const leg of [pose.legL, pose.legR]) {
          const residual = leg.upper.x + leg.lower.x + leg.tip.x;
          // Zero for a planted foot; non-zero only where a dance deliberately
          // lets the feet hang (the jump), and never more than a full flex.
          expect(Math.abs(residual), `${d.id} ankle residual`).toBeLessThan(1.1);
        }
      }
    }
  });
});
