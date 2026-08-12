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
import { createDancePose, type DancePose, type Vec3 } from "@/components/city/dances";
import { evalSwim, PRONE_PITCH } from "@/city/swim";
import { seaSurfaceAt, waterDepthAt, bedHeight } from "@/city/ocean";

const finite = (v: Vec3) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
function allFinite(p: DancePose) {
  return (
    [p.rootY, p.rootYaw, p.rootPitch, p.rootRoll].every(Number.isFinite) &&
    [p.hips, p.torso, p.head].every(finite) &&
    [p.armL, p.armR, p.legL, p.legR].every((l) => finite(l.upper) && finite(l.lower) && finite(l.tip))
  );
}

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
    expect(evalSwim(pose, { speed: 0, t: 0 }).prone).toBe(0);
    expect(pose.rootPitch).toBe(0);
    // Fully prone well under top swim speed — drag means a steady swim settles
    // below the target, and a stroke that only flattens at maximum speed
    // spends its whole life half-upright.
    expect(evalSwim(pose, { speed: 3.2, t: 0 }).prone).toBe(1);
    expect(pose.rootPitch).toBeCloseTo(PRONE_PITCH, 5);
    // And blends through the middle rather than snapping.
    const mid = evalSwim(pose, { speed: 1.4, t: 0 }).prone;
    expect(mid).toBeGreaterThan(0.05);
    expect(mid).toBeLessThan(0.95);
  });

  it("never stops moving, at any speed", () => {
    // A frozen pose in water reads as a corpse. Even stationary, the hands
    // scull — so the same instant of stroke must not repeat a quarter of a
    // second later at any speed the player can actually be doing.
    for (const speed of [0, 0.6, 1.5, 3.2, 5.4]) {
      const a = flat(evalSwim(pose, { speed, t: 10 }).pose);
      const b = flat(evalSwim(pose, { speed, t: 10.25 }).pose);
      const moved = a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
      expect(moved, `speed ${speed} produced a still pose`).toBeGreaterThan(0.02);
    }
  });

  it("stays finite everywhere, including the corners", () => {
    for (const speed of [-1, 0, 0.0001, 2.4, 40]) {
      for (const t of [0, 0.37, 1e4]) {
        evalSwim(pose, { speed, t });
        expect(allFinite(pose), `speed ${speed} t ${t}`).toBe(true);
      }
    }
  });

  it("keeps every joint inside a human range", () => {
    // Not a physiology check — a guard against a runaway term. An arm at six
    // radians is a propeller, and it is the kind of thing a stray sign change
    // produces without any other symptom.
    for (let t = 0; t < 6; t += 0.05) {
      for (const speed of [0, 1.5, 3.2]) {
        evalSwim(pose, { speed, t });
        for (const a of flat(pose)) expect(Math.abs(a)).toBeLessThan(Math.PI);
      }
    }
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
