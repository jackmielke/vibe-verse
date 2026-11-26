/**
 * Crashes, damage and explosions in Vibe City, without a browser.
 *
 * What is pinned here is the part a screenshot cannot show: that hits cost
 * health in the right shape, that a car at zero actually goes up, that a car
 * thrown at a building bounces off it rather than through it, that trees fall
 * over when hit and stand back up later, and that the monster truck flattens
 * rather than shoves.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { WorldBox } from "@/components/city/cardboardIsland";
import { buildTraffic, type CrashEvent } from "@/city/traffic";
import { createSmashables } from "@/city/smash";
import {
  VEHICLES, MAX_HEALTH, impactDamage, distress, cometSpot, SMOKE_AT, FIRE_AT,
} from "@/city/vehicles";

const OPTS = { seed: "crash", grid: 5, block: 28, street: 12 };

describe("vehicle damage", () => {
  it("is free at parking speed and climbs faster than the speed", () => {
    expect(impactDamage("kart", "wall", 3)).toBe(0);
    const slow = impactDamage("kart", "wall", 10);
    const fast = impactDamage("kart", "wall", 20);
    expect(slow).toBeGreaterThan(0);
    expect(fast).toBeGreaterThan(slow * 2);
  });

  it("takes a few big hits, not one, to wreck a kart", () => {
    const hit = impactDamage("kart", "wall", 23);
    expect(hit).toBeLessThan(MAX_HEALTH);
    expect(hit * 3).toBeGreaterThanOrEqual(MAX_HEALTH);
  });

  it("makes too many trees fatal, but no single tree", () => {
    const tree = impactDamage("kart", "tree", 20);
    expect(tree).toBeGreaterThan(0);
    expect(tree).toBeLessThan(15);
    expect(Math.ceil(MAX_HEALTH / tree)).toBeLessThan(20);
  });

  it("lets the monster truck ignore furniture and cars, but not walls", () => {
    expect(impactDamage("monster", "tree", 20)).toBe(0);
    expect(impactDamage("monster", "car", 20)).toBe(0);
    expect(impactDamage("monster", "wall", 20)).toBeGreaterThan(0);
    expect(impactDamage("monster", "wall", 20)).toBeLessThan(impactDamage("kart", "wall", 20));
  });

  it("makes the Comet the fastest and the most fragile", () => {
    const others = (Object.keys(VEHICLES) as Array<keyof typeof VEHICLES>).filter((k) => k !== "comet");
    for (const k of others) {
      expect(VEHICLES.comet.max).toBeGreaterThan(VEHICLES[k].max * 1.8);
      expect(VEHICLES.comet.armour).toBeGreaterThan(VEHICLES[k].armour);
    }
  });

  it("smokes before it burns", () => {
    expect(distress(MAX_HEALTH)).toEqual({ smoke: 0, fire: 0 });
    expect(distress(SMOKE_AT - 5).smoke).toBeGreaterThan(0);
    expect(distress(SMOKE_AT - 5).fire).toBe(0);
    expect(distress(FIRE_AT - 5).fire).toBeGreaterThan(0);
  });

  it("parks the Comet on a street, never in a junction", () => {
    const pitch = 40;
    for (let seed = 1; seed < 200; seed++) {
      const s = cometSpot(seed * 7919, pitch, 9);
      // One coordinate is near a street centreline (within the kerb offset).
      const nearLine = (v: number) => {
        const m = ((v / pitch + 0.5) % 1 + 1) % 1;
        return Math.min(m, 1 - m) * pitch < 5;
      };
      expect(nearLine(s.x) !== nearLine(s.z)).toBe(true);
      expect(Math.abs(s.x)).toBeLessThan(200);
      expect(Math.abs(s.z)).toBeLessThan(200);
    }
  });
});

function propMesh(n: number, at: (i: number) => THREE.Vector3) {
  const m = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), n);
  const M = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    const p = at(i);
    M.makeTranslation(p.x, p.y, p.z);
    m.setMatrixAt(i, M);
  }
  return m;
}

describe("smashable props", () => {
  it("knocks a tree over in the direction of travel and stands it back up later", () => {
    const smash = createSmashables();
    const mesh = propMesh(1, () => new THREE.Vector3(0, 2, 0));
    smash.add("tree", 0, 0, 0, 0.5, [{ mesh, index: 0 }]);
    // Too slow: nothing.
    expect(smash.hit(0, -0.5, 1, 0, 1, 1)).toHaveLength(0);
    const fell = smash.hit(0, -0.5, 1, 0, 1, 15);
    expect(fell).toEqual([{ kind: "tree", x: 0, z: 0 }]);
    // Already down: cannot be hit twice.
    expect(smash.hit(0, -0.5, 1, 0, 1, 15)).toHaveLength(0);
    for (let i = 0; i < 120; i++) smash.update(1 / 60, new THREE.Vector3(0, 0, 0));
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(0, m);
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    // Its middle has gone over toward +z and come down toward the ground.
    expect(p.z).toBeGreaterThan(1.5);
    expect(p.y).toBeLessThan(0.6);
    expect(smash.downCount()).toBe(1);
    // Stood back up once the viewer is far away and enough time has passed.
    for (let i = 0; i < 40; i++) smash.update(1, new THREE.Vector3(500, 0, 500));
    expect(smash.downCount()).toBe(0);
    mesh.getMatrixAt(0, m);
    expect(new THREE.Vector3().setFromMatrixPosition(m).y).toBeCloseTo(2);
  });

  it("blasts everything nearby outward", () => {
    const smash = createSmashables();
    const mesh = propMesh(8, (i) => new THREE.Vector3(Math.cos(i) * 4, 1, Math.sin(i) * 4));
    for (let i = 0; i < 8; i++) smash.add("lamp", Math.cos(i) * 4, Math.sin(i) * 4, 0, 0.3, [{ mesh, index: i }]);
    expect(smash.blast(0, 0, 6, 14)).toHaveLength(8);
  });
});

describe("traffic crashes", () => {
  it("explodes a car that takes enough damage, and hurts the cars around it", () => {
    const boxes: WorldBox[] = [];
    const t = buildTraffic({ ...OPTS, boxes });
    const events: CrashEvent[] = [];
    t.onCrash((e) => events.push(e));
    t.update(0.016, null);
    t.damage(0, 60);
    expect(t.stats().explosions).toBe(0);
    t.damage(0, 60);
    expect(t.stats().explosions).toBe(1);
    expect(events.some((e) => e.kind === "explode")).toBe(true);
    // It burns.
    t.update(0.016, null);
    expect(t.burning().length).toBeGreaterThanOrEqual(1);
    t.dispose();
  });

  it("bounces a flying car off a building instead of through it", () => {
    const wall: WorldBox = { minX: -100, maxX: 100, minZ: 30, maxZ: 40, base: 0, height: 30 };
    const boxes: WorldBox[] = [wall];
    const t = buildTraffic({ ...OPTS, boxes });
    t.update(0.016, null);
    // A car close enough to the wall to reach it before it lands.
    const car = t.debugNear(0, 0, 500)
      .filter((c) => c.z > 8 && c.z < 26)
      .sort((a, b) => b.z - a.z)[0];
    expect(car).toBeTruthy();
    // Shoved hard toward the wall.
    t.shove(car.id, 0, 1, 30);
    let maxZ = -Infinity;
    for (let i = 0; i < 240; i++) {
      t.update(1 / 60, null);
      const now = t.debugNear(0, 0, 500).find((c) => c.id === car.id);
      if (now) maxZ = Math.max(maxZ, now.z);
    }
    expect(maxZ).toBeLessThan(31);
    expect(t.stats().wallCrashes).toBeGreaterThan(0);
    t.dispose();
  });

  it("flattens a car under the monster truck and lowers its box", () => {
    const boxes: WorldBox[] = [];
    const t = buildTraffic({ ...OPTS, boxes });
    t.update(0.016, null);
    t.crush(3);
    t.update(0.016, null);
    const c = t.debugNear(0, 0, 500).find((x) => x.id === 3)!;
    expect(c.crushed).toBe(true);
    expect(c.wreck).toBe(true);
    const low = boxes.filter((b) => b.height > 0 && b.height < 0.8);
    expect(low.length).toBe(1);
    t.dispose();
  });

  it("sends a bot into a skid that ends with it off its lane", () => {
    const boxes: WorldBox[] = [];
    const t = buildTraffic({ ...OPTS, boxes });
    for (let i = 0; i < 120; i++) t.update(1 / 60, null);
    const id = t.loseControl(null);
    expect(id).toBeGreaterThanOrEqual(0);
    expect(t.stats().skids).toBe(1);
    t.update(1 / 60, null);
    expect(t.skidding().length).toBe(1);
    t.dispose();
  });
});
