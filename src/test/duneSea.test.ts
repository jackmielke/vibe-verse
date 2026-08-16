/**
 * The Dune Sea — the ground, and what rolls down it.
 *
 * Two claims are worth holding down here, and neither is visible in a
 * screenshot.
 *
 * The first is that the terrain is *one* function. The mesh is built from
 * `duneHeight`, the board's physics reads `duneHeight`, and the camera
 * keeps itself out of the sand with `duneHeight`. Nothing here can drift
 * out of step with anything else — but only for as long as nobody adds a
 * second source of ground truth, so the test asserts the board's y is the
 * function's y, exactly, after a real ride.
 *
 * The second is that gravity points downhill. It shipped pointing uphill,
 * and the failure was not obvious: a board that climbs a dune while
 * shedding speed reads as heavy sand, not as inverted physics. It cost a
 * browser run and a printed number to notice. A sign is a cheap thing to
 * assert.
 */
import { describe, it, expect } from "vitest";
import { buildRider, type RiderInput } from "@/dunes/rider";
import { duneHeight, duneNormal, DUNE_RADIUS, OASIS_RADIUS } from "@/dunes/terrain";

const coast: RiderInput = { x: 0, y: 0, tuck: false, jump: false };

/**
 * A spot on a genuinely steep face.
 *
 * These tests used to start at a hard-coded (500, 260), which was fine
 * until the dune wavelength changed and that coordinate landed in a
 * hollow — two tests then failed for a reason that had nothing to do with
 * what they were checking. The claim is "a board left alone on a slope
 * runs downhill", so the test should go and find a slope.
 */
function steepSpot(): [number, number] {
  let best: [number, number] = [500, 260];
  let bestSlope = 0;
  for (let i = 0; i < 900; i++) {
    const a = i * 2.399963;
    const r = 120 + ((i * 37) % 600);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const n = duneNormal(x, z, 2);
    const slope = Math.hypot(n.x, n.z) / n.y;
    if (slope > bestSlope) {
      bestSlope = slope;
      best = [x, z];
    }
  }
  return best;
}

function run(rider: ReturnType<typeof buildRider>, seconds: number, input: RiderInput) {
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(seconds / dt); i++) rider.update(dt, input, 0);
}

describe("The Dune Sea — terrain", () => {
  it("is a bowl: everywhere out on the field is above the oasis", () => {
    const middle = duneHeight(0, 0);
    for (const r of [200, 400, 600, 800]) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        expect(duneHeight(Math.cos(a) * r, Math.sin(a) * r)).toBeGreaterThan(middle);
      }
    }
  });

  it("climbs into a rim at the edge of the world", () => {
    const inner = duneHeight(DUNE_RADIUS * 0.7, 0);
    const rim = duneHeight(DUNE_RADIUS * 0.99, 0);
    expect(rim).toBeGreaterThan(inner + 100);
  });

  it("flattens out at the oasis so the finish is landable", () => {
    // Within the oasis the dunes are eased away entirely; the spread of
    // heights across it should be a couple of metres, not thirty.
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const h = duneHeight(Math.cos(a) * OASIS_RADIUS * 0.5, Math.sin(a) * OASIS_RADIUS * 0.5);
      min = Math.min(min, h);
      max = Math.max(max, h);
    }
    expect(max - min).toBeLessThan(3);
  });

  it("has dunes on it — a slope steep enough to ride", () => {
    let steepest = 0;
    for (let i = 0; i < 400; i++) {
      const x = ((i * 37) % 700) - 350;
      const z = ((i * 91) % 700) - 350;
      const n = duneNormal(x, z, 1.2);
      steepest = Math.max(steepest, Math.hypot(n.x, n.z) / n.y);
    }
    // A slip face should be well past 25°, or there is nothing to board on.
    expect(steepest).toBeGreaterThan(Math.tan((25 * Math.PI) / 180));
  });

  it("is continuous across the rideable field — no cliffs to fall through", () => {
    // Inside the rim only. The rim itself is deliberately a wall — it climbs
    // 4.8 m per metre at the outer edge, which is the point: it turns "the
    // world ends here" into terrain instead of an invisible barrier, and the
    // board is clamped short of it anyway.
    const edge = DUNE_RADIUS * 0.86;
    for (let i = 0; i < 400; i++) {
      const a = (i * 2.399963) % (Math.PI * 2);
      const r = ((i * 53) % 1000) / 1000 * edge;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const step = Math.abs(duneHeight(x, z) - duneHeight(x + 0.5, z + 0.5));
      expect(step).toBeLessThan(2.5);
    }
  });
});

describe("The Dune Sea — the board", () => {
  it("accelerates downhill with no input at all", () => {
    const rider = buildRider();
    rider.reset(...steepSpot());
    run(rider, 4, coast);
    // The slope is the engine. If this ever fails, check the sign on the
    // gravity projection in rider.ts before anything else.
    expect(rider.speed).toBeGreaterThan(6);
    rider.dispose();
  });

  it("ends up lower than it started, left to itself", () => {
    const rider = buildRider();
    rider.reset(...steepSpot());
    const startY = rider.position.y;
    run(rider, 6, coast);
    expect(rider.position.y).toBeLessThan(startY - 10);
    rider.dispose();
  });

  it("heads for the oasis rather than the rim", () => {
    const rider = buildRider();
    rider.reset(...steepSpot());
    const startR = Math.hypot(rider.position.x, rider.position.z);
    run(rider, 8, coast);
    expect(Math.hypot(rider.position.x, rider.position.z)).toBeLessThan(startR);
    rider.dispose();
  });

  it("stays on the sand — the mesh and the physics read one function", () => {
    const rider = buildRider();
    rider.reset(...steepSpot());
    const dt = 1 / 60;
    for (let i = 0; i < 600; i++) {
      rider.update(dt, { x: Math.sin(i / 40), y: -1, tuck: false, jump: false }, 0);
      if (rider.airborne) continue;
      expect(rider.position.y).toBeCloseTo(duneHeight(rider.position.x, rider.position.z), 6);
    }
    rider.dispose();
  });

  it("gets air off a crest, and lands", () => {
    const rider = buildRider();
    rider.reset(...steepSpot());
    run(rider, 3, coast);
    rider.update(1 / 60, { x: 0, y: 0, tuck: false, jump: true }, 0);
    expect(rider.airborne).toBe(true);
    run(rider, 4, coast);
    expect(rider.airborne).toBe(false);
    rider.dispose();
  });

  it("cannot leave the bowl", () => {
    const rider = buildRider();
    rider.reset(DUNE_RADIUS * 0.9, 0);
    // Point straight at the rim and hold it there.
    run(rider, 20, { x: 1, y: 0, tuck: true, jump: false });
    expect(Math.hypot(rider.position.x, rider.position.z)).toBeLessThanOrEqual(
      DUNE_RADIUS * 0.985 + 1e-6,
    );
    rider.dispose();
  });

  it("covers more ground tucked than upright", () => {
    // Distance, not speed-at-a-moment. Both riders take the same line, but
    // the tucked one is further along it, so on a field of 250 m dunes the
    // two are sampled at different points on different faces — comparing
    // their instantaneous speeds compares two bits of terrain, and the
    // answer flips depending on where the crests fall.
    const measure = (tuck: boolean) => {
      const rider = buildRider();
      rider.reset(...steepSpot());
      const x0 = rider.position.x;
      const z0 = rider.position.z;
      run(rider, 7, { x: 0, y: 0, tuck, jump: false });
      const d = Math.hypot(rider.position.x - x0, rider.position.z - z0);
      rider.dispose();
      return d;
    };
    expect(measure(true)).toBeGreaterThan(measure(false) * 1.05);
  });
});
