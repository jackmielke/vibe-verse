/**
 * physics.smoke.test.ts — boots the real Rapier WASM and drives every
 * subsystem for a few hundred simulated frames.
 *
 * This is not a unit test suite; it is the thing that catches the class of bug
 * that unit tests cannot: a transposed heightfield index, a character
 * controller that never reports grounded, a vehicle whose wheels point the
 * wrong way. All of those typecheck perfectly and all of them are fatal.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { terrainHeight } from "../geo/sfGeo";
import {
  Vehicle,
  Helicopter,
  SEDAN_SPEC,
  defaultPose,
  destruction,
  initSfPhysics,
  isPhysicsReady,
  makeRayHit,
  playerController,
  physics,
  ragdolls,
  raycast,
  rigidBodyPool,
  terrainCollider,
  updateSfPhysics,
  BONE_COUNT,
} from "./index";

const DT = 1 / 60;

/** Run n frames of the whole stack at a fixed dt. */
function frames(n: number, camX = 0, camY = 60, camZ = 0): void {
  for (let i = 0; i < n; i++) updateSfPhysics(DT, camX, camY, camZ);
}

/**
 * Fill the collider ring around a point before anything is asked to stand on
 * it — and step once, because Rapier's scene queries only see colliders that
 * existed at the last `world.step()`.
 */
function warmTerrain(x: number, z: number, iterations = 40): void {
  for (let i = 0; i < iterations; i++) terrainCollider.update(x, z, 200);
  physics.step(DT);
}

describe("sf physics", () => {
  beforeAll(async () => {
    await initSfPhysics({ quality: "high" });
  });

  it("boots", () => {
    expect(isPhysicsReady()).toBe(true);
  });

  it("streams a terrain heightfield that matches sfGeo", () => {
    // Somewhere on land with real relief: Nob Hill.
    const x = -180;
    const z = -80;
    warmTerrain(x, z);
    expect(terrainCollider.stats.terrainChunks).toBeGreaterThan(0);

    const hit = makeRayHit();
    const expected = terrainHeight(x, z);
    const ok = raycast(x, expected + 300, z, 0, -1, 0, 600, hit);
    expect(ok).toBe(true);
    const surfaceY = expected + 300 - hit.distance;
    // 4 m sample spacing means the collider is a linear interpolant of the
    // analytic field; a couple of metres of disagreement on a hillside is the
    // discretisation, not a transposed index. A transpose would be tens of metres.
    expect(Math.abs(surfaceY - expected)).toBeLessThan(3.5);
    expect(hit.ny).toBeGreaterThan(0.3);
  });

  it("resolves a surface tag for terrain", () => {
    const x = 0;
    const z = 0;
    warmTerrain(x, z);
    const hit = makeRayHit();
    const ok = raycast(x, terrainHeight(x, z) + 120, z, 0, -1, 0, 400, hit);
    expect(ok).toBe(true);
    expect(typeof hit.surface).toBe("string");
    expect(hit.object?.kind).toBe("terrain");
  });

  it("lands and grounds the character controller", () => {
    const x = -180;
    const z = -80;
    warmTerrain(x, z);
    const ground = terrainHeight(x, z);
    expect(playerController.spawn(x, ground + 4, z)).toBe(true);

    let vy = 0;
    let grounded = false;
    for (let i = 0; i < 240; i++) {
      vy -= 22.5 * DT;
      const res = playerController.move(0, vy * DT, 0, DT);
      if (res.grounded) {
        vy = 0;
        grounded = true;
      }
      updateSfPhysics(DT, x, playerController.position[1], z);
    }
    expect(grounded).toBe(true);
    expect(playerController.feetY).toBeGreaterThan(ground - 1.5);
    expect(playerController.feetY).toBeLessThan(ground + 2.5);
    expect(playerController.result.swimming).toBe(false);
  });

  it("crouches and stands back up", () => {
    const tall = playerController.totalHeight;
    expect(playerController.setCrouch(true)).toBe(true);
    expect(playerController.totalHeight).toBeLessThan(tall);
    expect(playerController.setCrouch(false)).toBe(true);
    expect(playerController.totalHeight).toBeCloseTo(tall, 3);
  });

  it("pools rigid bodies and respects the cap", () => {
    rigidBodyPool.clearAll();
    const x = -180;
    const z = -80;
    const y = terrainHeight(x, z) + 12;
    const handles: number[] = [];
    for (let i = 0; i < 40; i++) {
      const h = rigidBodyPool.spawn({
        shape: "box",
        hx: 0.2, hy: 0.2, hz: 0.2,
        x: x + (i % 8) * 0.6,
        y: y + Math.floor(i / 8) * 0.6,
        z,
        density: 2400,
      });
      expect(h).not.toBe(0);
      handles.push(h);
    }
    expect(rigidBodyPool.stats.alive).toBe(40);

    const pose = new Float32Array(7);
    expect(rigidBodyPool.poseNow(handles[0], pose)).toBe(true);
    const startY = pose[1];

    frames(120, x, y, z);
    rigidBodyPool.poseNow(handles[0], pose);
    expect(pose[1]).toBeLessThan(startY);
    expect(Number.isFinite(pose[1])).toBe(true);

    // Blowing past the cap must recycle rather than refuse.
    rigidBodyPool.cap = 12;
    for (let i = 0; i < 30; i++) {
      // Age the pool past the recycle grace window.
      frames(2, x, y, z);
      rigidBodyPool.spawn({ shape: "sphere", radius: 0.15, x, y: y + 5, z });
    }
    expect(rigidBodyPool.stats.alive).toBeLessThanOrEqual(12);
    rigidBodyPool.clearAll();
    rigidBodyPool.cap = 260;
  });

  it("destroys, fractures and chains", () => {
    const x = -180;
    const z = -80;
    const y = terrainHeight(x, z) + 1.2;

    let destroyedCount = 0;
    let explosionCount = 0;

    const crate = destruction.register({
      x, y, z,
      hx: 0.6, hy: 0.6, hz: 0.6,
      hp: 60,
      archetype: "test-crate",
      cells: 10,
      material: "wood",
      chaosPoints: 5,
    });
    const drum = destruction.register({
      x: x + 3, y, z,
      hx: 0.35, hy: 0.55, hz: 0.35,
      hp: 40,
      archetype: "test-drum",
      cells: 8,
      material: "thinMetal",
      explosiveRadius: 9,
      explosiveForce: 7000,
      explosiveDamage: 160,
    });
    // A shelf held up by the crate: destroying the crate must drop it.
    const shelf = destruction.register({
      x, y: y + 1.6, z,
      hx: 0.9, hy: 0.1, hz: 0.4,
      hp: 30,
      archetype: "test-shelf",
      cells: 6,
      material: "wood",
    });
    destruction.registerSupport(shelf.id, crate.id);

    expect(destruction.get(crate.id)).not.toBeNull();

    const before = destruction.stats.destroyed;
    destruction.applyDamage(crate.id, 100, x, y, z, 0, 400, 0);
    expect(destruction.stats.destroyed).toBe(before + 1);
    expect(destruction.get(crate.id)).toBeNull();
    expect(destruction.stats.shardsSpawned).toBeGreaterThan(0);

    // The shelf lost its only support; a beat later it should be gone.
    frames(90, x, y, z);
    expect(destruction.get(shelf.id)).toBeNull();

    // A blast next to the drum should light its fuse, not detonate inline.
    destruction.explode(x + 3.5, y, z, 8, 6000, 200);
    expect(destruction.get(drum.id)).not.toBeNull();
    frames(60, x, y, z);
    expect(destruction.get(drum.id)).toBeNull();

    destroyedCount = destruction.stats.destroyed;
    explosionCount = destruction.stats.explosions;
    expect(destroyedCount).toBeGreaterThanOrEqual(3);
    expect(explosionCount).toBeGreaterThanOrEqual(2);
    destruction.clear();
    rigidBodyPool.clearAll();
  });

  it("spawns a ragdoll that settles", () => {
    const x = -180;
    const z = -80;
    const ground = terrainHeight(x, z);
    warmTerrain(x, z);
    const pose = new Float32Array(BONE_COUNT * 7);
    defaultPose(x, ground + 1.4, z, 0.7, pose);

    const r = ragdolls.spawn(pose, 2, 1, 0, { corpseLifetime: -1 });
    expect(r).not.toBeNull();
    expect(r!.bones.length).toBe(BONE_COUNT);
    expect(r!.blend).toBe(1);

    const out = new Float32Array(7);
    frames(30, x, ground + 2, z);
    expect(r!.blend).toBeLessThan(1);
    r!.sampleBone(0, out);
    for (let i = 0; i < 7; i++) expect(Number.isFinite(out[i])).toBe(true);

    frames(400, x, ground + 2, z);
    // Joint limits must have kept the skeleton together rather than launching it.
    r!.sampleBone(3, out); // head
    expect(Math.abs(out[0] - x)).toBeLessThan(6);
    expect(out[1]).toBeGreaterThan(ground - 2);
    expect(out[1]).toBeLessThan(ground + 6);
    expect(["settling", "settled", "active", "getup"]).toContain(r!.state);

    ragdolls.clear();
  });

  it("drives a car", () => {
    const x = 60;
    const z = 40;
    warmTerrain(x, z, 60);
    const ground = terrainHeight(x, z);

    const car = new Vehicle(SEDAN_SPEC);
    expect(car.spawn(x, ground + 1.4, z, 0)).toBe(true);

    // Settle on the suspension. Sample across the window: a car rocking on
    // its springs is legitimately airborne on individual frames.
    let maxDown = 0;
    for (let i = 0; i < 120; i++) {
      updateSfPhysics(DT, x, ground + 3, z);
      if (car.wheelsDown > maxDown) maxDown = car.wheelsDown;
    }
    expect(maxDown).toBe(4);

    const start = new Float32Array(7);
    car.pose(start);
    expect(start[1]).toBeGreaterThan(ground - 0.5);

    car.input.throttle = 1;
    frames(240, x, ground + 3, z);

    const end = new Float32Array(7);
    car.pose(end);
    const travelled = Math.hypot(end[0] - start[0], end[2] - start[2]);
    expect(Number.isFinite(travelled)).toBe(true);
    // -Z is forward, so a throttled car must have moved that way.
    expect(end[2]).toBeLessThan(start[2] - 3);
    expect(travelled).toBeGreaterThan(3);
    expect(car.speed).toBeGreaterThan(1);
    expect(car.rpm).toBeGreaterThan(SEDAN_SPEC.idleRpm - 1);
    expect(car.gear).toBeGreaterThanOrEqual(1);

    // Steering sign: facing -Z with steer = +1 (right) must curve toward +X.
    const preSteer = new Float32Array(7);
    car.pose(preSteer);
    car.input.steer = 1;
    frames(180, x, ground + 3, z);
    const postSteer = new Float32Array(7);
    car.pose(postSteer);
    expect(postSteer[0]).toBeGreaterThan(preSteer[0] + 1);
    expect(Number.isFinite(car.slip)).toBe(true);

    car.input.steer = 0;
    car.input.throttle = 0;
    car.input.brake = 1;
    frames(240, x, ground + 3, z);
    expect(Math.abs(car.speed)).toBeLessThan(3);

    car.destroy();
  });

  it("hovers a helicopter and autorotates", () => {
    const x = 300;
    const z = 300;
    warmTerrain(x, z, 60);
    const ground = terrainHeight(x, z);

    const heli = new Helicopter();
    expect(heli.spawn(x, ground + 40, z, 0)).toBe(true);
    heli.input.collective = 0.52;
    frames(240, x, ground + 45, z);

    const pose = new Float32Array(7);
    // Roughly holding altitude with a hover collective — not falling like a rock.
    expect(heli.rotorSpeed).toBeGreaterThan(0.85);
    heli.body!.translation();
    pose[1] = heli.body!.translation().y;
    expect(pose[1]).toBeGreaterThan(ground + 5);

    // Engine failure: the descent keeps the rotor turning (autorotation)...
    heli.engineOn = false;
    heli.input.collective = 0.05;
    frames(180, x, pose[1], z);
    expect(heli.rotorSpeed).toBeGreaterThan(0.2);
    expect(heli.rotorSpeed).toBeLessThanOrEqual(1.12);
    expect(Number.isFinite(heli.body!.translation().y)).toBe(true);

    // ...and pulling collective spends that stored rpm on the flare.
    const stored = heli.rotorSpeed;
    heli.input.collective = 1;
    frames(120, x, heli.body!.translation().y, z);
    expect(heli.rotorSpeed).toBeLessThan(stored);

    heli.destroy();
  });

  it("keeps the fixed timestep honest", () => {
    const before = physics.stepCount;
    // Ten frames of 1/60 s must be ten substeps, not nine or eleven.
    for (let i = 0; i < 10; i++) physics.step(DT);
    expect(physics.stepCount - before).toBe(10);
    // A monstrous frame must be clamped, not chased.
    const b2 = physics.stepCount;
    physics.step(4);
    expect(physics.stepCount - b2).toBeLessThanOrEqual(4);
  });
});
