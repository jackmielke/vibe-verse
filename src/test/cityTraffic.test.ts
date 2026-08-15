/**
 * The traffic's rules, without a browser.
 *
 * `buildTraffic` is pure three.js — geometry, materials and arithmetic, no
 * canvas — so the interesting half of it can be driven straight from a test.
 * What is worth pinning here is not how the cars look but the three things
 * that are invisible in a screenshot and would rot silently:
 *
 *  1. Cars are solid. Every car owns a live `WorldBox` in the world's
 *     collision array, and it tracks the car.
 *  2. Cars stop for the player. This is the whole reason the player position
 *     is threaded from `City` through `district.update` into here.
 *  3. `dispose` takes the boxes back out. A stale box is an invisible wall in
 *     the middle of a street, and nothing else in the app would ever notice.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { WorldBox } from "@/components/city/cardboardIsland";
import { buildTraffic } from "@/city/traffic";

const OPTS = { seed: "test", grid: 5, block: 28, street: 12 };

function traffic(boxes: WorldBox[] = []) {
  return { t: buildTraffic({ ...OPTS, boxes }), boxes };
}

describe("city traffic", () => {
  it("registers one live collision box per car", () => {
    const { t, boxes } = traffic();
    expect(boxes.length).toBeGreaterThan(20);
    t.update(0.016, null);
    // Every box is a real volume sitting on the road.
    for (const b of boxes) {
      expect(b.maxX - b.minX).toBeGreaterThan(1);
      expect(b.maxZ - b.minZ).toBeGreaterThan(1);
      expect(b.base).toBe(0);
      // Tall enough to block a walker, short enough to be a car.
      expect(b.height).toBeGreaterThan(1);
      expect(b.height).toBeLessThan(2.2);
    }
    t.dispose();
  });

  it("moves the boxes with the cars", () => {
    const { t, boxes } = traffic();
    t.update(0.016, null);
    const before = boxes.map((b) => `${b.minX.toFixed(2)},${b.minZ.toFixed(2)}`);
    for (let i = 0; i < 60; i++) t.update(1 / 60, null);
    const after = boxes.map((b) => `${b.minX.toFixed(2)},${b.minZ.toFixed(2)}`);
    // Not every car moves — some are held at a red — but most must.
    const moved = before.filter((b, i) => b !== after[i]).length;
    expect(moved).toBeGreaterThan(before.length / 2);
    t.dispose();
  });

  it("stops for a player standing in the road", () => {
    // A lane on the 5×5 grid runs down x = -20; a car heading +z in it keeps
    // right, so it sits a couple of metres off the centreline.
    const { t, boxes } = traffic();
    t.update(0.016, null);
    // Find a box in that street and plant the player just ahead of it.
    const car = boxes.find((b) => Math.abs((b.minX + b.maxX) / 2 + 20) < 4);
    expect(car).toBeDefined();
    const cx = (car!.minX + car!.maxX) / 2;
    const cz = (car!.minZ + car!.maxZ) / 2;

    // Plant the player 6 m up the road and run four seconds. Whichever way
    // this car is pointing, it must never arrive on top of them: either it
    // stopped short, or (if it came from behind) it pushed them clear.
    const player = new THREE.Vector3(cx, 0, cz + 6);
    for (let i = 0; i < 240; i++) {
      t.update(1 / 60, player);
      for (const b of boxes) {
        const inside =
          player.x > b.minX && player.x < b.maxX && player.z > b.minZ && player.z < b.maxZ;
        expect(inside).toBe(false);
      }
    }
    t.dispose();
  });

  it("takes its boxes back out on dispose", () => {
    const other: WorldBox = { minX: 0, maxX: 1, minZ: 0, maxZ: 1, base: 0, height: 1 };
    const boxes: WorldBox[] = [other];
    const t = buildTraffic({ ...OPTS, boxes });
    expect(boxes.length).toBeGreaterThan(1);
    t.dispose();
    expect(boxes).toEqual([other]);
  });
});
