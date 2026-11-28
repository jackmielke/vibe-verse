import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { boxSegmentDistance, createCollapse, hpFor, swing } from "@/city/collapse";

function tower(minX: number, minZ: number, h: number) {
  const box = { minX, maxX: minX + 10, minZ, maxZ: minZ + 10, base: 0, height: h };
  const geo = new THREE.BoxGeometry(10, h, 10).translate(minX + 5, h / 2, minZ + 5);
  const mesh = new THREE.Mesh(geo);
  return { rec: { minX, maxX: minX + 10, minZ, maxZ: minZ + 10, height: h, boxes: [box], parts: [{ kind: "geo" as const, mesh, start: 0, count: geo.getAttribute("position").count }] }, box, geo };
}

describe("falling buildings", () => {
  it("swings down faster the further over it is", () => {
    let a = 0.02;
    let v = 0.12;
    let t = 0;
    while (a < 1.42 && t < 20) {
      [a, v] = swing(a, v, 40, 1 / 60);
      t += 1 / 60;
    }
    expect(t).toBeGreaterThan(1);
    expect(t).toBeLessThan(8);
  });

  it("measures how close a box is to a fall line", () => {
    const b = { minX: 10, maxX: 20, minZ: -5, maxZ: 5 };
    expect(boxSegmentDistance(b, 0, 0, 30, 0)).toBe(0);
    expect(boxSegmentDistance(b, 0, 20, 30, 20)).toBeCloseTo(15, 5);
  });

  it("drops a tower over, clears its collision, and knocks the next one down", () => {
    const a = tower(0, 0, 40);
    const b = tower(25, 0, 30);
    const col = createCollapse([a.rec, b.rec]);
    const events: string[] = [];
    col.onEvent((e) => events.push(e.kind));
    expect(col.damage(0, 10, -50, 5)).toBe("hit");
    expect(col.damage(0, hpFor(40), -50, 5)).toBe("topple");
    expect(a.box.height).toBeLessThan(0.1);
    for (let i = 0; i < 60 * 30; i++) col.update(1 / 60);
    expect(events).toContain("crash");
    expect(col.info(1)!.standing).toBe(false);
    expect(col.debug().down).toBe(2);
    // The geometry really moved: its top is no longer 40 m up.
    a.geo.computeBoundingBox();
    expect(a.geo.boundingBox!.max.y).toBeLessThan(20);
  });
});
