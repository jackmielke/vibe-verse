/**
 * The Glass Lake — skating, asserted.
 *
 * The look of this world can only be judged by opening it (see
 * `scripts/lake-shot.mjs`). The *feel* can be pinned down here, and it is
 * worth pinning down, because the whole world rests on one claim: a blade
 * slides along its length and bites across it. Every number in `skater.ts`
 * is tuned against that, and a well-meaning tweak to the damping constants
 * turns carving into driving without breaking anything a compiler notices.
 */
import { describe, it, expect } from "vitest";
import { buildSkater, type SkaterInput } from "@/glasslake/skater";
import { buildShards } from "@/glasslake/shards";
import * as THREE from "three";

const LAKE = 190;
const still: SkaterInput = { x: 0, y: 0, boost: false, hop: false };

/** Drive the skater for `seconds` at a fixed 60 Hz. */
function run(skater: ReturnType<typeof buildSkater>, seconds: number, input: SkaterInput) {
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    skater.update(dt, input, 0, LAKE);
  }
}

describe("The Glass Lake — skating", () => {
  it("builds speed under a push and settles under the cap", () => {
    const skater = buildSkater();
    run(skater, 4, { x: 0, y: -1, boost: false, hop: false });
    expect(skater.speed).toBeGreaterThan(8);
    expect(skater.speed).toBeLessThan(22);
    skater.dispose();
  });

  it("glides — a lifted stick bleeds speed slowly, not instantly", () => {
    const skater = buildSkater();
    run(skater, 4, { x: 0, y: -1, boost: false, hop: false });
    const entry = skater.speed;
    run(skater, 1, still);
    // A second of coasting on ice should cost a fifth of your speed, not all
    // of it. This is the constant that separates a lake from a carpet.
    expect(skater.speed).toBeGreaterThan(entry * 0.72);
    expect(skater.speed).toBeLessThan(entry);
    skater.dispose();
  });

  it("bites sideways — lateral velocity is gone in well under a second", () => {
    const skater = buildSkater();
    // Straight up the +Z axis is heading 0; push velocity purely across it.
    skater.velocity.set(10, 0, 0);
    run(skater, 0.5, still);
    expect(Math.abs(skater.velocity.x)).toBeLessThan(0.6);
    skater.dispose();
  });

  it("carves — a 90° turn keeps most of the speed it entered with", () => {
    const skater = buildSkater();
    run(skater, 4, { x: 0, y: -1, boost: false, hop: false });
    const entry = skater.speed;
    // Hold a stick 90° off the direction of travel: the skater should come
    // round on an arc rather than scrubbing to a stop and setting off again.
    run(skater, 1.2, { x: 1, y: 0, boost: false, hop: false });
    expect(skater.speed).toBeGreaterThan(entry * 0.6);
    expect(Math.abs(skater.heading)).toBeGreaterThan(0.5);
    skater.dispose();
  });

  it("turns harder when slow than when fast", () => {
    const turnFrom = (speed: number) => {
      const skater = buildSkater();
      if (speed > 0) {
        skater.velocity.set(0, 0, speed);
        run(skater, 0.4, { x: 0, y: -1, boost: false, hop: false });
      }
      const before = skater.heading;
      run(skater, 0.4, { x: 1, y: 0, boost: false, hop: false });
      const turned = Math.abs(skater.heading - before);
      skater.dispose();
      return turned;
    };
    expect(turnFrom(0)).toBeGreaterThan(turnFrom(26));
  });

  it("hops, and comes back down", () => {
    const skater = buildSkater();
    skater.update(1 / 60, { x: 0, y: -1, boost: false, hop: true }, 0, LAKE);
    expect(skater.airborne).toBe(true);
    run(skater, 1.5, { x: 0, y: -1, boost: false, hop: false });
    expect(skater.airborne).toBe(false);
    expect(skater.position.y).toBeCloseTo(0, 5);
    skater.dispose();
  });

  it("cannot leave the lake", () => {
    const skater = buildSkater();
    run(skater, 30, { x: 0, y: -1, boost: true, hop: false });
    expect(Math.hypot(skater.position.x, skater.position.z)).toBeLessThanOrEqual(LAKE - 4 + 1e-6);
    skater.dispose();
  });
});

describe("The Glass Lake — shards", () => {
  it("scatters twelve of them inside the lake and never on top of each other", () => {
    const shards = buildShards(LAKE, 12);
    const spots: THREE.Vector3[] = [];
    shards.group.traverse((o) => {
      // The cores are the pickups; halos and rings ride along with them.
      if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry?.type === "OctahedronGeometry") {
        const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry;
        if (g.boundingSphere === null) g.computeBoundingSphere();
        if ((g.boundingSphere?.radius ?? 0) < 1) spots.push(o.position.clone());
      }
    });
    expect(spots).toHaveLength(12);
    for (const p of spots) {
      expect(Math.hypot(p.x, p.z)).toBeLessThan(LAKE - 4);
    }
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        expect(spots[i].distanceTo(spots[j])).toBeGreaterThan(8);
      }
    }
    shards.dispose();
  });

  it("is collected by skating into it, once", () => {
    const shards = buildShards(LAKE, 12);
    const target = new THREE.Vector3();
    shards.group.children[0].getWorldPosition(target);

    expect(shards.update(1 / 60, 0, new THREE.Vector3(0, 0, 0))).toBe(0);
    expect(shards.update(1 / 60, 0, target)).toBe(1);
    expect(shards.taken).toBe(1);
    // Standing in the same place must not keep paying out.
    expect(shards.update(1 / 60, 0, target)).toBe(0);
    expect(shards.taken).toBe(1);

    shards.reset();
    expect(shards.taken).toBe(0);
    shards.dispose();
  });
});
