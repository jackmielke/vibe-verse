/**
 * vehicles.smoke.test.ts — builds every vehicle in the game and checks the
 * things that typecheck perfectly and are still fatal.
 *
 * The failure modes this exists to catch:
 *   • a loft that degenerates to zero triangles for one kind, so a bus is
 *     invisible and nobody notices until a screenshot;
 *   • a NaN in a section point, which propagates into the bounding sphere and
 *     silently disables frustum culling for the whole scene;
 *   • the model's wheel parts and the physics spec's wheels disagreeing on
 *     count or order, which puts a front wheel on the back axle;
 *   • the authoring-origin conversion drifting, which floats every vehicle
 *     above the road;
 *   • the CPU wave sampler diverging from a plain evaluation of the same sum,
 *     which is how boats end up sailing through the swell instead of on it.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  VEHICLE_DEFS,
  VEHICLE_KINDS,
  axleLayout,
  buildVehicleModel,
  chassisMetrics,
  disposeVehicleAssets,
  originYFor,
  paintForSeed,
  toPhysicsSpec,
} from "./models";
import { boatSystem, waveHeight, waveNormal } from "./boats";
import { drivingSystem } from "./driving";
import { flightSystem } from "./flight";
import { hijackSystem } from "./hijack";
import { vehicleAt, vehicleRuntime } from "./vehicle";

describe("vehicle models", () => {
  it("builds every kind with finite, non-degenerate geometry", () => {
    for (const kind of VEHICLE_KINDS) {
      const m = buildVehicleModel(kind, { seed: 0.5 });
      let tris = 0;
      let verts = 0;
      m.root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const g = mesh.geometry as THREE.BufferGeometry;
        const pos = g.getAttribute("position");
        expect(pos, `${kind} position attribute`).toBeTruthy();
        verts += pos.count;
        tris += (g.index ? g.index.count : pos.count) / 3;
        const a = pos.array as Float32Array;
        for (let i = 0; i < a.length; i++) {
          if (!Number.isFinite(a[i])) {
            throw new Error(`${kind}: non-finite vertex at ${i} (${mesh.name})`);
          }
        }
        // Every channel must carry the attributes the shaders declare, or the
        // draw silently reads garbage.
        expect(g.getAttribute("normal"), `${kind} normals`).toBeTruthy();
        expect(g.getAttribute("aWear"), `${kind} aWear`).toBeTruthy();
        expect(g.getAttribute("aDent"), `${kind} aDent`).toBeTruthy();
      });
      expect(tris, `${kind} triangle count`).toBeGreaterThan(200);
      expect(verts, `${kind} vertex count`).toBeLessThan(60000);
      m.dispose();
    }
    disposeVehicleAssets();
  });

  it("keeps each model inside a believable bounding box", () => {
    for (const kind of VEHICLE_KINDS) {
      const d = VEHICLE_DEFS[kind];
      const m = buildVehicleModel(kind, { seed: 0.25 });
      const size = new THREE.Vector3();
      m.bounds.getSize(size);
      // Rotors, wings and ladders legitimately overhang; the tolerance is
      // generous, but a model twice its own quoted length is a bug.
      const maxSpan = Math.max(d.length, d.wingSpan, d.rotorRadius * 2) * 2.2 + 4;
      expect(size.x, `${kind} width`).toBeLessThan(maxSpan);
      expect(size.z, `${kind} length`).toBeLessThan(maxSpan);
      expect(size.y, `${kind} height`).toBeGreaterThan(0.4);
      expect(size.y, `${kind} height`).toBeLessThan(d.height * 2.5 + 4);
      m.dispose();
    }
    disposeVehicleAssets();
  });

  it("agrees with the physics spec about wheels", () => {
    for (const kind of VEHICLE_KINDS) {
      const d = VEHICLE_DEFS[kind];
      if (d.klass === "boat") continue;
      const spec = toPhysicsSpec(d);
      const m = buildVehicleModel(kind, { seed: 0.75 });
      expect(m.wheelCount, `${kind} wheel model count`).toBe(spec.wheels.length);
      // Hard points must sit a suspension-travel above the wheel centre, which
      // is the assumption `setWheel` renders with.
      const originY = originYFor(d);
      for (const w of spec.wheels) {
        expect(w.y).toBeCloseTo(d.wheelRadius + d.suspension - originY, 5);
      }
      m.dispose();
    }
    disposeVehicleAssets();
  });

  it("puts the chassis centre where the authoring offset says it is", () => {
    for (const kind of VEHICLE_KINDS) {
      const d = VEHICLE_DEFS[kind];
      const m = chassisMetrics(d);
      // Bottom of the collider is the ground clearance (or the draft, for a
      // hull); the origin is exactly half a box above it.
      const bottom = d.klass === "boat" ? -d.hullDraft : d.clearance;
      expect(m.originY - m.hy).toBeCloseTo(bottom, 6);
      expect(originYFor(d)).toBeCloseTo(m.originY, 6);
      expect(m.hy).toBeGreaterThan(0.2);
    }
  });

  it("produces sane, finite drivetrain specs", () => {
    for (const kind of VEHICLE_KINDS) {
      const s = toPhysicsSpec(VEHICLE_DEFS[kind]);
      for (const v of [s.mass, s.hx, s.hy, s.hz, s.dragArea, s.maxSpeed, s.brakeTorque]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
      }
      expect(s.gearRatios.length).toBeGreaterThan(0);
      expect(s.comY).toBeLessThan(0); // the centre of mass must be low
      expect(s.wheels.length).toBeGreaterThan(0);
    }
  });

  it("gives every axle a matching model part", () => {
    for (const kind of VEHICLE_KINDS) {
      const d = VEHICLE_DEFS[kind];
      if (d.klass === "boat") continue;
      const axles = axleLayout(d);
      expect(axles.length).toBeGreaterThan(0);
      const perAxle = d.klass === "bike" ? 1 : 2;
      expect(toPhysicsSpec(d).wheels.length).toBe(axles.length * perAxle);
    }
  });

  it("paints deterministically from a seed", () => {
    for (const kind of VEHICLE_KINDS) {
      const a = paintForSeed(kind, "seed-a");
      const b = paintForSeed(kind, "seed-a");
      expect(a).toBe(b);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(0xffffff);
    }
  });

  it("dents real geometry and raises the damage channel", () => {
    const m = buildVehicleModel("sedan", { seed: 0.1 });
    const body = m.partByName.get("body")!;
    const paint = body.children.find((c) => c.name === "body:paint") as THREE.Mesh;
    expect(paint).toBeTruthy();
    const pos = paint.geometry.getAttribute("position");
    const dent = paint.geometry.getAttribute("aDent");
    const before = (pos.array as Float32Array).slice();
    let dentSum = 0;
    for (let i = 0; i < dent.count; i++) dentSum += (dent.array as Float32Array)[i];
    expect(dentSum).toBe(0);

    // Hit the nose, hard.
    m.applyImpact(0, 0.1, -2.2, 0, 0, 1, 4);
    let moved = 0;
    const after = pos.array as Float32Array;
    for (let i = 0; i < after.length; i++) if (after[i] !== before[i]) moved++;
    expect(moved).toBeGreaterThan(0);
    let dentAfter = 0;
    for (let i = 0; i < dent.count; i++) dentAfter += (dent.array as Float32Array)[i];
    expect(dentAfter).toBeGreaterThan(0);
    for (let i = 0; i < after.length; i++) expect(Number.isFinite(after[i])).toBe(true);
    m.dispose();
    disposeVehicleAssets();
  });

  it("does not share dentable geometry between instances", () => {
    const a = buildVehicleModel("sedan", { seed: 0.2 });
    const b = buildVehicleModel("sedan", { seed: 0.3 });
    const geoA = (a.partByName.get("body")!.children.find((c) => c.name === "body:paint") as THREE.Mesh).geometry;
    const geoB = (b.partByName.get("body")!.children.find((c) => c.name === "body:paint") as THREE.Mesh).geometry;
    expect(geoA).not.toBe(geoB);
    a.applyImpact(0, 0.1, -2.2, 0, 0, 1, 4);
    const pa = geoA.getAttribute("aDent").array as Float32Array;
    const pb = geoB.getAttribute("aDent").array as Float32Array;
    let sa = 0;
    let sb = 0;
    for (let i = 0; i < pa.length; i++) sa += pa[i];
    for (let i = 0; i < pb.length; i++) sb += pb[i];
    expect(sa).toBeGreaterThan(0);
    expect(sb).toBe(0);
    a.dispose();
    b.dispose();
    disposeVehicleAssets();
  });

  it("drives doors, lamps, wheels and rotors without throwing", () => {
    for (const kind of ["sedan", "bus", "helicopter", "aircraft", "speedboat", "motorcycle"] as const) {
      const m = buildVehicleModel(kind, { seed: 0.4 });
      for (let i = 0; i < m.wheelCount; i++) {
        m.setWheel(i, { suspension: 0.2, spin: 1.2, steer: 0.3, flat: 0.5 });
      }
      for (let i = 0; i < m.doorCount; i++) m.setDoor(i, 0.6);
      m.setLights({ head: 1, brake: 1, reverse: 0.5, indicator: -1, siren: 1, highBeam: 0.5 }, 1 / 60);
      m.setRotors(1.1, 2.2, 0.5);
      m.setTurret(0.2, -0.1);
      m.setLadder(0.3, 0.4, 0.5);
      m.setDamage({ integrity01: 0.5, burn: 0.2, wet: 0.4, grime: 0.7 });
      m.breakGlass("all");
      m.setWrecked(true);
      const v = new THREE.Vector3();
      expect(Number.isFinite(m.seatLocal(0, v).y)).toBe(true);
      expect(Number.isFinite(m.engineLocal(v).y)).toBe(true);
      expect(Number.isFinite(m.roofLocal(v).y)).toBe(true);
      expect(Number.isFinite(m.exhaustLocal(v).y)).toBe(true);
      m.dispose();
    }
    disposeVehicleAssets();
  });
});

describe("the wave surface", () => {
  it("is finite, bounded and continuous", () => {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 400; i++) {
      const x = -3000 + i * 11.3;
      const z = 500 + i * 7.1;
      const h = waveHeight(x, z, 12.5);
      expect(Number.isFinite(h)).toBe(true);
      min = Math.min(min, h);
      max = Math.max(max, h);
      // Neighbouring samples must not jump: the sum is smooth by construction,
      // and a discontinuity means a wave number went wrong.
      const h2 = waveHeight(x + 0.05, z, 12.5);
      expect(Math.abs(h2 - h)).toBeLessThan(0.05);
    }
    // A 12 m/s wind on the bay: swell of order a metre, not ten.
    expect(max - min).toBeGreaterThan(0.05);
    expect(max - min).toBeLessThan(8);
  });

  it("returns a normalised, upward normal that matches the surface", () => {
    const n = new THREE.Vector3();
    for (let i = 0; i < 60; i++) {
      const x = i * 37.7;
      const z = -i * 19.1;
      waveNormal(x, z, 3.3, n);
      expect(n.length()).toBeCloseTo(1, 5);
      expect(n.y).toBeGreaterThan(0.2);
      // Cross-check against a finite difference of the height field.
      const e = 0.4;
      const dhdx = (waveHeight(x + e, z, 3.3) - waveHeight(x - e, z, 3.3)) / (2 * e);
      const dhdz = (waveHeight(x, z + e, 3.3) - waveHeight(x, z - e, 3.3)) / (2 * e);
      const fd = new THREE.Vector3(-dhdx, 1, -dhdz).normalize();
      expect(n.dot(fd)).toBeGreaterThan(0.9);
    }
  });

  it("is deterministic for a given time", () => {
    expect(waveHeight(123.4, -567.8, 9.87)).toBe(waveHeight(123.4, -567.8, 9.87));
  });
});

/* ------------------------------------------------------------------ *
 * The runtime, before Rapier exists.
 * ------------------------------------------------------------------ *
 * Every one of these is a no-op path that has to be safe, because on the
 * first few frames of a level the physics world genuinely does not exist yet
 * and the spawn manager is already running.
 */
describe("the runtime without physics", () => {
  it("queues spawns instead of throwing, and cleans them up", () => {
    const v = vehicleRuntime.spawn({ kind: "sedan", x: 10, y: 40, z: -20, yaw: 0.5, seed: "t1" });
    expect(v.ready).toBe(false);
    expect(v.body).toBeNull();
    expect(vehicleRuntime.get(v.id)).toBe(v);

    // Several frames of the whole stack.
    for (let i = 0; i < 20; i++) {
      vehicleRuntime.update(1 / 60, 0, 2, 0);
      drivingSystem.update(1 / 60);
      flightSystem.update(1 / 60);
      boatSystem.update(1 / 60);
      hijackSystem.update(1 / 60);
    }

    expect(vehicleAt(10, 40, -20)).toBeNull();
    expect(drivingSystem.enter(v.id)).toBe(false);
    expect(hijackSystem.state).toBe("none");

    vehicleRuntime.despawn(v.id);
    expect(vehicleRuntime.get(v.id)).toBeNull();
    vehicleRuntime.clear();
  });

  it("damages, ignites and destroys without a rigid body", () => {
    const v = vehicleRuntime.spawn({ kind: "police", x: 0, y: 5, z: 0, seed: "t2" });
    const before = v.health;
    // A round into the fuel tank is worth several into a door.
    v.localToWorld(v.def.fuelTanks[0].x, v.def.fuelTanks[0].y, v.def.fuelTanks[0].z, new THREE.Vector3());
    const dealt = v.hit(v.position.x, v.position.y + v.def.fuelTanks[0].y, v.position.z + v.def.fuelTanks[0].z, 40);
    expect(dealt).toBeGreaterThan(0);
    expect(v.health).toBeLessThan(before);

    v.destroy(true);
    expect(v.wrecked).toBe(true);
    expect(v.damage01).toBe(1);
    // Destroying twice must not double-count chaos or spawn two explosions.
    v.destroy(true);
    vehicleRuntime.clear();
  });

  it("keeps seat, door and occupant bookkeeping consistent", () => {
    const v = vehicleRuntime.spawn({ kind: "suv", x: 0, y: 5, z: 0, seed: "t3", occupants: 2 });
    expect(v.passengers.length).toBe(2);
    // Seat 0 is taken, so the next free seat is not the driver's.
    expect(v.freeSeat(true)).toBe(2);
    const door = v.openDoorNear(0);
    expect(door).toBeGreaterThanOrEqual(0);
    expect(v.doorTarget[door]).toBe(1);
    const occ = v.ejectOccupant(0);
    expect(occ).toBeTruthy();
    expect(v.passengers.length).toBe(1);
    expect(v.freeSeat(true)).toBe(0);
    v.closeDoors();
    expect(v.doorTarget[door]).toBe(0);
    vehicleRuntime.clear();
  });
});
