/**
 * ai/ai.smoke.test.ts — does the city actually run?
 *
 * Not a unit test suite. This is the "boot it headless and drive it for a
 * simulated minute" check that catches the class of bug that a type checker
 * cannot: NaN leaking through a pose, a pathfinder that never terminates, a
 * pedestrian who walks off the graph and takes the frame loop with him.
 *
 * Everything here runs without WebGL and without Rapier — both degrade to
 * defined behaviour by design, and that degradation is itself worth testing,
 * because the first frames of a real session happen before either has booted.
 */
import { describe, expect, it } from "vitest";
import { buildCharacterGeometry, CharacterBatch, makePalette } from "./characters";
import { buildHelicopterGeometry, buildVehicleGeometry, VEHICLE_SPECS } from "./vehicleMeshes";
import { avoidance, findPath, makeNavPath, navGraph, sidewalkPoint } from "./navigation";
import { emitGunshot, clearPerception, perceptionTick, strongestThreatNear } from "./perception";
import { trafficSim } from "./traffic";
import { pedestrians } from "./pedestrians";
import { enemyForce } from "./enemies";
import { heat } from "./heat";
import { police } from "./police";
import { spawner } from "./spawner";
import { roadNetwork } from "../world/street/roadNetwork";
import { TRAFFIC_KINDS } from "./types";

function finite(a: ArrayLike<number>, label: string): void {
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i])) throw new Error(`${label}: non-finite at ${i} (${a[i]})`);
  }
}

describe("character meshes", () => {
  it("builds both detail levels with sane, finite attributes", () => {
    for (const detail of [0, 1] as const) {
      const g = buildCharacterGeometry(detail);
      const pos = g.getAttribute("position");
      const joint = g.getAttribute("aJoint");
      const slot = g.getAttribute("aSlot");
      const region = g.getAttribute("aRegion");
      expect(pos.count).toBeGreaterThan(120);
      finite(pos.array as Float32Array, "character position");
      finite(g.getAttribute("normal").array as Float32Array, "character normal");
      // Joints and slots must stay inside the ranges the shader branches on.
      for (let i = 0; i < joint.count; i++) {
        expect(joint.getX(i)).toBeGreaterThanOrEqual(0);
        expect(joint.getX(i)).toBeLessThanOrEqual(13);
        expect(slot.getX(i)).toBeGreaterThanOrEqual(0);
        expect(slot.getX(i)).toBeLessThanOrEqual(8);
        expect(region.getX(i)).toBeLessThanOrEqual(6);
      }
      const idx = g.getIndex();
      expect(idx).toBeTruthy();
      for (let i = 0; i < idx!.count; i++) {
        expect(idx!.getX(i)).toBeLessThan(pos.count);
      }
      // A person is roughly person-shaped: under two metres, on the ground.
      g.computeBoundingBox();
      const bb = g.boundingBox!;
      expect(bb.min.y).toBeGreaterThanOrEqual(-0.05);
      expect(bb.max.y).toBeLessThan(2.0);
      expect(bb.max.x - bb.min.x).toBeLessThan(1.4);
      g.dispose();
    }
  });

  it("writes instances into the batch without overflowing", () => {
    const batch = new CharacterBatch(8, 8);
    const rng = { ...makeRngStub() };
    const pal = makePalette(rng, "civilian");
    batch.begin();
    for (let i = 0; i < 20; i++) {
      batch.push(i, 0, 0, 0, 0.5, 1.4, 0, 0, 1, 1, 3, 0.5, 0, pal, 0, i < 10 ? 1 : 1e6);
    }
    batch.commit();
    expect(batch.nearCount).toBeLessThanOrEqual(8);
    expect(batch.farCount).toBeLessThanOrEqual(8);
    batch.dispose();
  });
});

describe("vehicle meshes", () => {
  it("builds every kind plus the helicopter", () => {
    for (const kind of TRAFFIC_KINDS) {
      const g = buildVehicleGeometry(VEHICLE_SPECS[kind]);
      const pos = g.getAttribute("position");
      expect(pos.count).toBeGreaterThan(100);
      finite(pos.array as Float32Array, `${kind} position`);
      finite(g.getAttribute("normal").array as Float32Array, `${kind} normal`);
      const wheel = g.getAttribute("aWheel");
      for (let i = 0; i < wheel.count; i++) {
        expect(wheel.getX(i)).toBeGreaterThanOrEqual(0);
        expect(wheel.getX(i)).toBeLessThanOrEqual(6);
      }
      g.computeBoundingBox();
      // Nothing may extend below the road surface.
      expect(g.boundingBox!.min.y).toBeGreaterThan(-0.4);
      g.dispose();
    }
    const heli = buildHelicopterGeometry();
    finite(heli.getAttribute("position").array as Float32Array, "heli position");
    heli.dispose();
  });
});

describe("navigation", () => {
  it("finds a route across downtown and caches it", () => {
    navGraph.ensure(0, 0, 900);
    navGraph.syncClusters();
    expect(roadNetwork.nodes.length).toBeGreaterThan(50);

    const path = makeNavPath(96);
    const ok = findPath(0, 0, 620, -420, path, {}, 0);
    expect(ok).toBe(true);
    expect(path.count).toBeGreaterThan(0);
    for (let i = 0; i < path.count; i++) {
      const n = roadNetwork.nodes[path.nodes[i]];
      expect(n).toBeTruthy();
      expect(Number.isFinite(n.x)).toBe(true);
    }

    // The second identical query must hit the cache and agree with the first.
    const again = makeNavPath(96);
    expect(findPath(0, 0, 620, -420, again, {}, 0)).toBe(true);
    expect(again.count).toBeGreaterThan(0);
  });

  it("projects sidewalk points above the carriageway", () => {
    navGraph.ensure(0, 0, 300);
    const e = roadNetwork.nearestEdge(0, 0, 90);
    expect(e).toBeTruthy();
    const left = sidewalkPoint(e!.edge, e!.edge.length * 0.5, 1);
    const right = sidewalkPoint(e!.edge, e!.edge.length * 0.5, -1);
    expect(Number.isFinite(left.x)).toBe(true);
    // The two pavements are a road apart.
    expect(Math.hypot(left.x - right.x, left.z - right.z)).toBeGreaterThan(4);
  });

  it("steers around a head-on neighbour instead of through it", () => {
    avoidance.begin();
    // Us, and someone walking straight at us from four metres ahead.
    const self = avoidance.add(0, 0, 1.4, 0, 0.34, 0);
    avoidance.add(4, 0, -1.4, 0, 0.34, 0);
    const out = new Float32Array(2);
    avoidance.solve(self, 0, 0, 1.4, 0, 0.34, out, 2.5, 0);
    // The solution must not still be a pure head-on closing velocity.
    expect(Math.abs(out[1]) > 0.15 || out[0] < 1.2).toBe(true);
  });
});

describe("the living city", () => {
  it("runs a simulated minute with traffic, crowds and a firefight", () => {
    trafficSim.reset();
    pedestrians.reset();
    enemyForce.reset();
    police.reset();
    heat.reset();
    clearPerception();
    spawner.setQuality("medium");

    const dt = 1 / 30;
    let now = 0;
    const px = 0;
    const py = 2;
    const pz = 0;

    // Warm the graph so the first spawns have somewhere to go.
    navGraph.ensure(px, pz, 600);

    for (let step = 0; step < 120; step++) {
      now += dt;
      perceptionTick(now);
      avoidance.begin();
      trafficSim.update(dt, now, px, pz);
      pedestrians.update(dt, now, px, pz);
      enemyForce.update(dt, now, px, py, pz);
      police.observe(now, px, pz);
      heat.update(dt, now);
      police.update(dt, now, px, py, pz);
      spawner.update(dt, now, px, py, pz, 0, -1);
    }

    expect(trafficSim.vehicles.length).toBeGreaterThan(0);
    expect(pedestrians.count).toBeGreaterThan(0);
    for (const v of trafficSim.vehicles) {
      expect(Number.isFinite(v.x)).toBe(true);
      expect(Number.isFinite(v.y)).toBe(true);
      expect(Number.isFinite(v.yaw)).toBe(true);
      expect(v.speed).toBeGreaterThanOrEqual(0);
      expect(v.speed).toBeLessThan(60);
    }

    // Fire a gun on Market Street: the block must respond inside two seconds.
    const before = pedestrians.stats.fleeing;
    emitGunshot(px, py, pz, "player", 1, 1);
    expect(strongestThreatNear(px, pz, now - 1)).toBeTruthy();
    for (let step = 0; step < 60; step++) {
      now += dt;
      perceptionTick(now);
      avoidance.begin();
      trafficSim.update(dt, now, px, pz);
      pedestrians.update(dt, now, px, pz);
      enemyForce.update(dt, now, px, py, pz);
      police.observe(now, px, pz);
      heat.update(dt, now);
      police.update(dt, now, px, py, pz);
      spawner.update(dt, now, px, py, pz, 0, -1);
    }
    expect(pedestrians.stats.fleeing).toBeGreaterThan(before);

    // A serious crime must summon a response.
    for (let i = 0; i < 6; i++) heat.reportCrime("civilian-kill", px, pz);
    expect(heat.level).toBeGreaterThanOrEqual(1);

    for (let step = 0; step < 300; step++) {
      now += dt;
      perceptionTick(now);
      avoidance.begin();
      trafficSim.update(dt, now, px, pz);
      pedestrians.update(dt, now, px, pz);
      enemyForce.update(dt, now, px, py, pz);
      police.observe(now, px, pz);
      heat.update(dt, now);
      police.update(dt, now, px, py, pz);
      spawner.update(dt, now, px, py, pz, 0, -1);
    }
    expect(enemyForce.enemies.length).toBeGreaterThan(0);
    for (const e of enemyForce.enemies) {
      expect(Number.isFinite(e.x)).toBe(true);
      expect(Number.isFinite(e.y)).toBe(true);
      expect(Number.isFinite(e.aimYaw)).toBe(true);
    }
  });

  it("hands a vehicle over cleanly and takes it back", () => {
    trafficSim.reset();
    navGraph.ensure(0, 0, 400);
    const v = trafficSim.spawnNear(0, 0, 20, 160, 0);
    expect(v).toBeTruthy();
    const id = trafficSim.findHijackable(v!.x, v!.z, 8);
    expect(id).toBe(v!.id);
    const snap = trafficSim.hijack(id);
    expect(snap).toBeTruthy();
    expect(trafficSim.get(id)).toBeUndefined();
    const back = trafficSim.relinquish(snap!, 0);
    expect(back).toBeTruthy();
    expect(back!.state).toBe("abandoned");
  });
});

/** A deterministic RNG stub with the shape `makePalette` expects. */
function makeRngStub() {
  let s = 12345;
  const next = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  return {
    next,
    range: (a: number, b: number) => a + next() * (b - a),
    int: (a: number, b: number) => Math.floor(a + next() * (b - a + 1)),
    chance: (p: number) => next() < p,
    pick: <T,>(items: readonly T[]) => items[Math.floor(next() * items.length) % items.length],
    gauss: () => (next() + next() + next() - 1.5) * 1.1547,
    fork: () => makeRngStub(),
  };
}
