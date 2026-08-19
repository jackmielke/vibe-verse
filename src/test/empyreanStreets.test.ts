/**
 * The street system is the only thing in The Empyrean a player is guaranteed
 * to be standing on, and the failures that matter here are all silent: a deck
 * that quietly stops covering the plaza, a low-quality tier that builds the
 * same forty thousand triangles as the high one, geometry drifting outside the
 * island, a `dispose` that leaves the WebGL context holding the whole thing.
 *
 * None of those break a build, a typecheck or a smoke run. They break the
 * frame, or they break the *next* world the visitor opens.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildStreets } from "@/empyrean/streets";
import { DECKS, ISLAND_Y, PARAPET_H, PLATEAU_R } from "@/empyrean/config";
import { HALO_R, KERB_H, RING_R, W, surfaceAt } from "@/empyrean/cityplan";

const high = buildStreets({ quality: "high", seedSalt: "test" });
const low = buildStreets({ quality: "low", seedSalt: "test" });

function meshOf(sys: { group: THREE.Object3D }): THREE.Mesh {
  const found: THREE.Mesh[] = [];
  sys.group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) found.push(o as THREE.Mesh);
  });
  expect(found.length, "one mesh, one draw call").toBe(1);
  return found[0];
}

function positionsOf(sys: { group: THREE.Object3D }): THREE.BufferAttribute {
  return meshOf(sys).geometry.getAttribute("position") as THREE.BufferAttribute;
}

describe("the system contract", () => {
  it("is a System with a group, a name and no reflection", () => {
    expect(high.name).toBe("streets");
    expect(high.group).toBeInstanceOf(THREE.Group);
    // Detail, not silhouette. A kerb in the lake is a second draw of nothing.
    expect(high.reflected).toBeFalsy();
  });

  it("draws the whole ground in one call", () => {
    expect(high.stats.draws).toBe(1);
    expect(low.stats.draws).toBe(1);
  });

  it("updates without allocating a thing", () => {
    const mesh = meshOf(high);
    const mat = mesh.material as THREE.ShaderMaterial;
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(10, ISLAND_Y + 2, 30);
    const sun = new THREE.Vector3(-0.62, 0.085, -0.78).normalize();
    const before = mat.uniforms.uCam.value;
    high.update?.({
      time: 1,
      dt: 0.016,
      camera,
      player: {
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        yaw: 0,
        grounded: true,
        burn: 0,
        altitude: 0,
      },
      quality: "high",
      dayPhase: 0.75,
      sunDir: sun,
      daylight: 0.4,
      camRadiusSq: 0,
    });
    // Copied in place: the same Vector3 object, carrying the new value.
    expect(mat.uniforms.uCam.value).toBe(before);
    expect((mat.uniforms.uCam.value as THREE.Vector3).z).toBe(30);
    expect(mat.uniforms.uDusk.value).toBeCloseTo(0.6, 5);
  });
});

describe("what it covers", () => {
  const pos = positionsOf(high);

  it("has ground under the spawn, the Halo and every ring road", () => {
    // A grid of probes across the deck: every one of them must have a vertex
    // of street geometry within a few metres, in plan.
    const probes: Array<[number, number, string]> = [
      [0, 0, "the Beacon"],
      [0, 40, "the Halo ring"],
      [0, 78, "the spawn"],
      [0, HALO_R - 2, "the plaza edge"],
      [RING_R[0], 0, "ring 0"],
      [0, RING_R[1], "ring 1, the tram"],
      [-RING_R[2], 0, "ring 2"],
      [PLATEAU_R - 6, 0, "the rim"],
      [Math.cos(Math.PI / 16) * 200, Math.sin(Math.PI / 16) * 200, "mid block"],
    ];
    for (const [px, pz, what] of probes) {
      let best = Infinity;
      for (let i = 0; i < pos.count; i++) {
        const d = Math.hypot(pos.getX(i) - px, pos.getZ(i) - pz);
        if (d < best) best = d;
      }
      expect(best, `no ground near ${what}`).toBeLessThan(8);
    }
  });

  it("keeps the plaza flat where the plan says it is flat", () => {
    // The Halo's relief is deliberately below trip height: the plan answers
    // ISLAND_Y for the whole plaza and every body in the world stands on that
    // answer, so anything taller here is something a player walks through.
    let lift = 0;
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getZ(i));
      if (r > HALO_R) continue;
      lift = Math.max(lift, pos.getY(i) - ISLAND_Y);
    }
    expect(lift).toBeGreaterThan(0); // there *is* relief
    expect(lift).toBeLessThanOrEqual(0.2); // and you cannot trip on it
  });

  it("sinks the roadway a kerb below the pavement", () => {
    const off = Math.PI / 16; // clear of every avenue and lane
    const at = (r: number) => [Math.cos(off) * r, Math.sin(off) * r] as const;
    // The plan's own contract, restated: if this ever stops being true the
    // kerbs this module builds are walls around nothing.
    expect(surfaceAt(...at(RING_R[0])).y).toBeCloseTo(ISLAND_Y - KERB_H, 6);

    // And the geometry agrees: something sits near the sunk road height.
    let lowest = Infinity;
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getZ(i));
      if (Math.abs(r - RING_R[0]) > W.ring.half) continue;
      lowest = Math.min(lowest, pos.getY(i));
    }
    expect(lowest).toBeLessThan(ISLAND_Y - KERB_H + 0.01);
    expect(lowest).toBeGreaterThan(ISLAND_Y - KERB_H - 0.2);
  });

  it("builds a parapet of the height config asks for", () => {
    let top = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getZ(i));
      if (r < PLATEAU_R - 2 || r > PLATEAU_R + 0.1) continue;
      top = Math.max(top, pos.getY(i));
    }
    expect(top).toBeCloseTo(ISLAND_Y + PARAPET_H, 3);
  });

  it("reaches every promenade ring and lands the stairs on them", () => {
    for (let d = 1; d < DECKS.length; d++) {
      const deck = DECKS[d];
      let n = 0;
      for (let i = 0; i < pos.count; i++) {
        if (Math.abs(pos.getY(i) - deck.y) > 0.05) continue;
        const r = Math.hypot(pos.getX(i), pos.getZ(i));
        if (r >= deck.outer - deck.width - 0.5 && r <= deck.outer + 0.5) n++;
      }
      expect(n, `nothing on promenade ${d}`).toBeGreaterThan(200);
    }
  });

  it("puts real steps between every pair of decks", () => {
    // Somewhere between each deck and the next there has to be geometry at
    // intermediate heights, or the "stairs" are a hole with a rail round it.
    for (let d = 0; d + 1 < DECKS.length; d++) {
      const hi = DECKS[d].y;
      const lo = DECKS[d + 1].y;
      let n = 0;
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        if (y < lo + 2 || y > hi - 2) continue;
        n++;
      }
      expect(n, `no steps between deck ${d} and ${d + 1}`).toBeGreaterThan(100);
    }
  });
});

describe("the budget", () => {
  it("stays inside the island", () => {
    // The last promenade is the outermost thing there is. Anything past it is
    // a stair flying off into the void, which is a bug you only see from a
    // camera nobody points there.
    const limit = DECKS[DECKS.length - 1].outer + 2;
    for (const sys of [high, low]) {
      const pos = positionsOf(sys);
      let far = 0;
      for (let i = 0; i < pos.count; i++) {
        far = Math.max(far, Math.hypot(pos.getX(i), pos.getZ(i)));
      }
      expect(far).toBeLessThanOrEqual(limit);
    }
  });

  it("never builds below the lowest promenade or above the parapet", () => {
    const pos = positionsOf(high);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      lo = Math.min(lo, pos.getY(i));
      hi = Math.max(hi, pos.getY(i));
    }
    expect(hi).toBeLessThanOrEqual(ISLAND_Y + PARAPET_H + 0.01);
    expect(lo).toBeGreaterThan(DECKS[DECKS.length - 1].y - 6);
  });

  it("is a street system, not a scene", () => {
    expect(high.stats.triangles).toBeGreaterThan(20000);
    expect(high.stats.triangles).toBeLessThan(140000);
  });

  it("builds meaningfully less on a phone", () => {
    // Not a token reduction: the low tier exists because the high one does not
    // fit, and a tier that saves ten per cent has not saved anything.
    expect(low.stats.triangles).toBeLessThan(high.stats.triangles * 0.5);
    expect(low.stats.triangles).toBeGreaterThan(4000);
  });
});

describe("teardown", () => {
  it("releases every geometry and material it made", () => {
    const sys = buildStreets({ quality: "low", seedSalt: "teardown" });
    const mesh = meshOf(sys);
    const geo = mesh.geometry;
    const mat = mesh.material as THREE.Material;

    let geoGone = 0;
    let matGone = 0;
    geo.addEventListener("dispose", () => geoGone++);
    mat.addEventListener("dispose", () => matGone++);

    sys.dispose();

    expect(geoGone, "geometry leaked").toBe(1);
    expect(matGone, "material leaked").toBe(1);
    expect(sys.group.children.length).toBe(0);
  });
});
