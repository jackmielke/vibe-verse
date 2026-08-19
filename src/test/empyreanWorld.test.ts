/**
 * Build every system in The Empyrean, headlessly, and check the things that
 * are silently wrong rather than loudly wrong.
 *
 * The individual systems each have their own tests for their own rules. This
 * one exists for the failures that only appear when they are all built
 * together, and — more importantly — for the class of bug that a green build,
 * a green typecheck and a green unit test all miss, because the symptom is a
 * black screen rather than an exception:
 *
 *  - **A NaN in a position attribute.** One is enough: it collapses the
 *    geometry's bounding sphere to NaN, every frustum test against it returns
 *    false, and the mesh silently stops being drawn. Nothing throws. The world
 *    just quietly loses a system.
 *  - **Geometry a very long way from where it belongs.** A transform applied
 *    in the wrong space puts a building at the origin six hundred metres under
 *    the deck, which also inflates its chunk's bounding sphere until distance
 *    culling stops working for everything else in that chunk. This has already
 *    happened here once, to a hundred and seventy-three flower beds.
 *  - **Collision that disagrees with the plan**: a blocker outside the island,
 *    a deck below the keel, an infinite half-extent.
 *
 * No WebGL context is needed: building geometry and materials does not touch
 * the driver. `lighting.ts` and `postfx.ts` need a renderer and are therefore
 * not covered here — they have their own test.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { BuildContext, FrameContext, System } from "@/empyrean/types";
import { DECKS, ISLAND_Y, KEEL_DEPTH, PLATEAU_R } from "@/empyrean/config";
import { cityPlan, surfaceAt } from "@/empyrean/cityplan";
import { buildKeel } from "@/empyrean/keel";
import { buildStreets } from "@/empyrean/streets";
import { buildBuildings } from "@/empyrean/buildings";
import { buildProps } from "@/empyrean/props";
import { buildCrowd } from "@/empyrean/crowd";
import { buildTraffic } from "@/empyrean/traffic";
import { buildInteriors } from "@/empyrean/interiors";
import { buildActivities } from "@/empyrean/activities";
import { buildWeather } from "@/empyrean/weather";
import { buildVehicles } from "@/empyrean/vehicles";
import { buildCollision } from "@/empyrean/collide";

const ctx: BuildContext = { quality: "high", seedSalt: "test" };

/** Everything that can be built without a renderer. */
function buildAll(): System[] {
  return [
    buildKeel(ctx),
    buildStreets(ctx),
    buildBuildings(ctx),
    buildProps(ctx),
    buildCrowd(ctx),
    buildTraffic(ctx),
    buildInteriors(ctx),
    buildActivities(ctx),
    buildWeather(ctx),
    buildVehicles(ctx),
  ];
}

/**
 * A frame context good enough to step every system with.
 *
 * Systems that place instanced geometry — the crowd, the traffic — do it in
 * `update`, not at build time, so anything measuring where they are has to
 * run a frame first. Stepping them here also means this file exercises every
 * `update` path headlessly, which is where a divide-by-zero or an unguarded
 * array index turns into the NaN the sweep below is looking for.
 */
function frame(time: number, dt: number): FrameContext {
  const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.3, 26000);
  camera.position.set(0, ISLAND_Y + 6, 120);
  camera.updateMatrixWorld(true);
  return {
    time,
    dt,
    camera,
    player: {
      position: new THREE.Vector3(0, ISLAND_Y, 90),
      velocity: new THREE.Vector3(),
      yaw: 0,
      grounded: true,
      burn: 0,
      altitude: 0,
    },
    quality: "high",
    dayPhase: 0.75,
    sunDir: new THREE.Vector3(-0.62, 0.085, -0.78).normalize(),
    daylight: 0.32,
    camRadiusSq: 120 * 120,
  };
}

let systems: System[] | null = null;
const all = () => {
  if (!systems) {
    systems = buildAll();
    // Two frames: one to place, one to move.
    for (let i = 0; i < 2; i++) {
      const f = frame(i / 60, 1 / 60);
      for (const s of systems) s.update?.(f);
    }
  }
  return systems;
};

/** Every geometry under an object, with the object that owns it. */
function geometries(root: THREE.Object3D): Array<{ name: string; geo: THREE.BufferGeometry }> {
  const out: Array<{ name: string; geo: THREE.BufferGeometry }> = [];
  root.traverse((o) => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (g?.isBufferGeometry) out.push({ name: o.name || o.type, geo: g });
  });
  return out;
}

describe("the world, assembled", () => {
  it("gives every system a distinct name", () => {
    const names = all().map((s) => s.name);
    expect(new Set(names).size, names.join(",")).toBe(names.length);
  });

  it("has no NaN anywhere in any position attribute", () => {
    /* One NaN collapses a bounding sphere, every frustum test fails, and the
       mesh stops drawing without anything throwing. It is the single most
       expensive-to-find bug available in this codebase. */
    const bad: string[] = [];
    for (const s of all()) {
      for (const { name, geo } of geometries(s.group)) {
        const pos = geo.getAttribute("position") as THREE.BufferAttribute | undefined;
        if (!pos) continue;
        const a = pos.array as ArrayLike<number>;
        for (let i = 0; i < a.length; i++) {
          if (!Number.isFinite(a[i])) {
            bad.push(`${s.name}/${name} index ${i}`);
            break;
          }
        }
      }
    }
    expect(bad.slice(0, 6)).toEqual([]);
  });

  it("keeps every mesh inside the world it belongs to", () => {
    /* Generous bounds — this is not an art review, it is a check that nothing
       was transformed in the wrong space. The island is 400 m in radius and
       spans from the keel's tip to the top of the Beacon; anything an order of
       magnitude outside that is a bug, and weather and activities are exempt
       because both legitimately work in camera space or high above the city. */
    const EXEMPT = new Set(["weather", "activities"]);
    const bad: string[] = [];
    const box = new THREE.Box3();
    const size = new THREE.Vector3();
    for (const s of all()) {
      if (EXEMPT.has(s.name)) continue;
      s.group.updateMatrixWorld(true);
      s.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!(m as THREE.Mesh).isMesh && !(m as THREE.InstancedMesh).isInstancedMesh) return;
        const name = o.name || o.type;
        /* `setFromObject`, not `geometry.boundingBox`.
         *
         * Half of this world is `InstancedMesh`, whose base geometry is
         * authored at the origin with every placement in an instance matrix —
         * so reading the geometry's own box says "this lamp is at y=0", which
         * is true and useless. `setFromObject` walks the instance matrices and
         * the object transforms and answers where the thing actually is. */
        box.setFromObject(m);
        if (box.isEmpty()) return;
        const r = Math.max(
          Math.hypot(box.min.x, box.min.z),
          Math.hypot(box.max.x, box.max.z),
        );
        if (r > 2200) bad.push(`${s.name}/${name} reaches r=${r.toFixed(0)}`);
        /* "Entirely below the world", not "touches the origin".
         *
         * The bug this is for is a whole system left in local space — a
         * hundred and seventy-three flower beds that sat six hundred metres
         * under the deck and inflated their chunk's bounding sphere until
         * distance culling stopped working for everything else in it. Those
         * are objects of real size lying wholly below the keel.
         *
         * "Touches y=0" is not that. Populations allocate their instances up
         * front and park the unused ones at the origin with a zero scale,
         * which is the correct way to vary a crowd without reallocating a
         * buffer — so their world box always reaches the origin and a naive
         * floor test flags every one of them, every time. */
        box.getSize(size);
        if (size.length() > 5 && box.max.y < ISLAND_Y - KEEL_DEPTH) {
          bad.push(`${s.name}/${name} lies wholly below the world, at y=${box.max.y.toFixed(0)}`);
        }
        if (box.max.y > ISLAND_Y + 900) {
          bad.push(`${s.name}/${name} tops at y=${box.max.y.toFixed(0)}`);
        }
      });
    }
    expect(bad.slice(0, 8)).toEqual([]);
  });

  it("disposes cleanly, twice", () => {
    // Built fresh: the shared instance is needed by the tests above.
    const fresh = buildAll();
    for (const s of fresh) expect(() => s.dispose()).not.toThrow();
    for (const s of fresh) expect(() => s.dispose()).not.toThrow();
  });
});

describe("collision, assembled", () => {
  const buildings = buildBuildings(ctx);
  const interiors = buildInteriors(ctx);
  const props = buildProps(ctx);
  const blockers = [...buildings.blockers, ...interiors.blockers, ...(props.blockers ?? [])];
  const decks = [...buildings.decks, ...interiors.decks];

  it("has finite, sane boxes", () => {
    const bad = blockers.filter(
      (b) =>
        !Number.isFinite(b.x + b.z + b.hx + b.hz + b.top + b.bottom) ||
        b.hx <= 0 ||
        b.hz <= 0 ||
        b.top <= b.bottom ||
        Math.hypot(b.x, b.z) > PLATEAU_R + 40,
    );
    expect(bad.length, `${bad.length} of ${blockers.length} blockers are wrong`).toBe(0);
  });

  it("puts every standable deck between the keel and the sky", () => {
    const bad = decks.filter((d) => !Number.isFinite(d.y) || d.y < ISLAND_Y - 4 || d.y > ISLAND_Y + 900);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it("agrees with the plan about the ground", () => {
    const world = buildCollision(blockers, decks);
    // The middle of the Halo is the deck and nothing else.
    expect(world.supportAt(0, 40, ISLAND_Y + 1)).toBeCloseTo(ISLAND_Y, 3);
    // Off the island entirely is the void, not the deck.
    expect(world.supportAt(0, 3000, ISLAND_Y + 1)).toBe(-Infinity);
  });

  it("makes the middle of a built lot solid", () => {
    /* Sampled at the centroid of every lot that is supposed to carry a
       building, rather than over the whole deck.
       "The plan says lot" is much broader than "there is a building here" —
       it also covers the service gaps between lots and the clearance margins
       around the roads, which are meant to be walkable. Sampling those and
       expecting them solid measures the wrong thing; the first version of this
       test did exactly that and failed at 39%, which was the test being wrong
       rather than the city. */
    const world = buildCollision(blockers, decks);
    const built = cityPlan().lots.filter((l) => l.use !== "garden");
    const hollow = built.filter(
      (l) =>
        !world.blockedAt(l.centroid.x, l.centroid.z, ISLAND_Y + 1.5, 0) &&
        world.supportAt(l.centroid.x, l.centroid.z, ISLAND_Y + 900) <= ISLAND_Y + 2,
    );
    expect(built.length).toBeGreaterThan(100);
    expect(
      hollow.length / built.length,
      `${hollow.length} of ${built.length} built lots are hollow: ${hollow.slice(0, 5).map((l) => l.id).join(", ")}`,
    ).toBeLessThan(0.1);
  });
});

describe("the decks", () => {
  it("never overlap in plan, at any count", () => {
    /* `DECKS` has been three entries and four. Both times something indexed it
       by hand. The rule that matters is only that consecutive rings leave a
       gap, so it is asserted over the array rather than over its length. */
    /* They step OUTWARD as they step down, so the rule is that the next ring
       out starts beyond where the last one ended — not, as this test first
       had it, the other way round. */
    for (let i = 1; i + 1 < DECKS.length; i++) {
      const next = DECKS[i + 1];
      expect(next.outer - next.width, `deck ${i + 1} overlaps deck ${i}`).toBeGreaterThanOrEqual(
        DECKS[i].outer - 0.001,
      );
    }
  });

  it("steps outward and downward, every time", () => {
    for (let i = 1; i < DECKS.length; i++) {
      expect(DECKS[i].outer).toBeGreaterThan(DECKS[i - 1].outer);
      expect(DECKS[i].y).toBeLessThan(DECKS[i - 1].y);
    }
  });

  it("is reported by surfaceAt at the middle of every promenade", () => {
    for (let i = 1; i < DECKS.length; i++) {
      const mid = DECKS[i].outer - DECKS[i].width / 2;
      const hit = surfaceAt(mid, 0);
      expect(hit.kind, `deck ${i}`).toBe("promenade");
      expect(hit.y).toBe(DECKS[i].y);
    }
  });
});
