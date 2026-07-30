/**
 * A headless smoke test for the VFX stack.
 *
 * There is no WebGL and no canvas in the test environment, which is exactly the
 * point: every generator here has a documented fallback for that case, and the
 * whole system has to be *constructible* and *drivable* without a GPU. If this
 * file fails, the screenshot harness will fail too, just more slowly and with a
 * worse error message.
 *
 * What it actually checks:
 *   - the system builds at every quality tier and disposes cleanly;
 *   - spawns before init are no-ops rather than crashes;
 *   - an explosion produces live particles, a decal and debris;
 *   - particles retire on schedule and the instance count returns to zero;
 *   - the emitters are deterministic — the same call order gives the same
 *     buffer, which is what the offline capture depends on.
 */
import { describe, expect, it, beforeEach } from "vitest";
import * as THREE from "three";
import { frame } from "../state/store";
import { walkableHeight } from "../geo/sfGeo";
import { particles, resetDesc, P, emitSphere, setParticleScale } from "./particles";
import { decals } from "./decals";
import { trails, rocketTrail } from "./trails";
import { debris, spawnDebrisBurst } from "./debris";
import { fire, igniteFire } from "./fire";
import { explosions, spawnExplosion, shockwaveBuffer } from "./explosion";
import { environment, setWeather, weather } from "./environmental";

function camera(): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(74, 16 / 9, 0.15, 9000);
  c.position.set(0, 60, 0);
  c.updateMatrixWorld();
  return c;
}

function bootAll(tier: "low" | "medium" | "high" | "ultra" = "high") {
  // Always tear down first: a failed assertion skips the trailing
  // `shutdownAll()`, and an `init` that early-returns on an unchanged tier
  // would then quietly inherit the previous test's live particles.
  shutdownAll();
  setParticleScale(tier);
  particles.init(tier);
  decals.init(tier);
  trails.init(tier);
  debris.init(tier);
  fire.init(tier);
  explosions.init(tier);
  environment.init(tier);
}

function shutdownAll() {
  particles.dispose();
  decals.dispose();
  trails.dispose();
  debris.dispose();
  fire.dispose();
  explosions.dispose();
  environment.dispose();
}

function tick(cam: THREE.PerspectiveCamera, dt = 1 / 60) {
  frame.dt = dt;
  frame.time += dt;
  explosions.update(dt, null);
  fire.update(dt, cam);
  debris.update(dt);
  environment.update(dt, cam);
  trails.update(null);
  decals.update(null);
  particles.update(cam, null, 1920, 1080);
}

describe("vfx", () => {
  beforeEach(() => {
    shutdownAll();
    frame.time = 10;
    frame.dt = 1 / 60;
  });

  it("no-ops before init instead of throwing", () => {
    shutdownAll();
    expect(() => spawnExplosion(0, 20, 0, "tank")).not.toThrow();
    expect(() => spawnDebrisBurst({ x: 0, y: 1, z: 0, count: 5, speed: 5, size: 0.2 })).not.toThrow();
    expect(() => igniteFire(0, 1, 0)).not.toThrow();
    expect(particles.counts().total).toBe(0);
  });

  it("builds and tears down at every tier", () => {
    for (const tier of ["low", "medium", "high", "ultra"] as const) {
      bootAll(tier);
      expect(particles.ready).toBe(true);
      const cam = camera();
      tick(cam);
      shutdownAll();
      expect(particles.ready).toBe(false);
    }
  });

  it("an explosion produces particles, a scorch decal and debris", () => {
    bootAll("high");
    const cam = camera();
    // On the deck: the ground layers (scorch, dust wave) only run for a blast
    // that is actually near a surface, which is the behaviour we want to pin.
    const gy = walkableHeight(120, -80);
    spawnExplosion(120, gy + 1.2, -80, "tank");
    tick(cam);
    const counts = particles.counts();
    expect(counts.total).toBeGreaterThan(50);
    expect(counts.add).toBeGreaterThan(0);
    expect(counts.smoke).toBeGreaterThan(0);
    expect(counts.flame).toBeGreaterThan(0);
    expect(decals.liveCount).toBeGreaterThan(0);
    expect(debris.liveCount).toBeGreaterThan(0);
    // The shockwave must be published for the post stack on the same frame.
    expect(shockwaveBuffer[3]).toBeGreaterThan(0);
    shutdownAll();
  });

  it("retires particles when their lifetime expires", () => {
    bootAll("high");
    const cam = camera();
    resetDesc();
    P.layer = "add";
    P.x = 0; P.y = 50; P.z = 0;
    P.life = 0.5;
    emitSphere(P, { count: 200, speed: [1, 4] });
    tick(cam);
    expect(particles.counts().add).toBe(200);
    for (let i = 0; i < 60; i++) tick(cam, 1 / 60);
    expect(particles.counts().add).toBe(0);
    shutdownAll();
  });

  it("never exceeds the tier's particle cap", () => {
    bootAll("low");
    const cam = camera();
    for (let i = 0; i < 40; i++) spawnExplosion(i * 12, 30, 0, "tank");
    tick(cam);
    const counts = particles.counts();
    // 3000 is the low-tier cap; the sum of the layer capacities is at most that.
    expect(counts.total).toBeLessThanOrEqual(3000);
    shutdownAll();
  });

  it("is deterministic across identical spawn sequences", () => {
    const run = () => {
      bootAll("medium");
      const cam = camera();
      frame.time = 10;
      spawnExplosion(50, 20, 50, "car");
      tick(cam);
      const c = particles.counts();
      const out = `${c.add}/${c.alpha}/${c.smoke}/${c.flame}|${debris.liveCount}|${decals.liveCount}`;
      shutdownAll();
      return out;
    };
    expect(run()).toBe(run());
  });

  it("fire burns, lights and eventually goes out", () => {
    bootAll("high");
    const cam = camera();
    const slot = igniteFire(0, 12, 0, { radius: 2, duration: 1.0, intensity: 1 });
    expect(slot).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < 36; i++) tick(cam);
    expect(fire.liveCount).toBe(1);
    expect(particles.counts().flame).toBeGreaterThan(0);
    for (let i = 0; i < 120; i++) tick(cam);
    expect(fire.liveCount).toBe(0);
    shutdownAll();
  });

  it("trails acquire, follow and release", () => {
    bootAll("high");
    // Deliberately no environment tick here: the flock system pulls contrails
    // off its own trail pool, and an aircraft happening to cross during the
    // test would make an absolute count assertion flaky for the right reason.
    environment.dispose();
    const h = rocketTrail(0, 30, 0);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(trails.liveCount).toBe(1);
    for (let i = 0; i < 20; i++) {
      frame.time += 1 / 60;
      trails.move(h, i * 3, 30, 0);
      trails.update(null);
    }
    trails.release(h);
    for (let i = 0; i < 120; i++) {
      frame.time += 1 / 60;
      trails.update(null);
    }
    expect(trails.liveCount).toBe(0);
    shutdownAll();
  });

  it("weather wetness lags rain in both directions", () => {
    bootAll("medium");
    const cam = camera();
    setWeather({ rain: 0 });
    weather.wetness = 0;
    setWeather({ rain: 1 });
    tick(cam);
    const afterOne = weather.wetness;
    expect(afterOne).toBeGreaterThan(0);
    expect(afterOne).toBeLessThan(1);
    for (let i = 0; i < 200; i++) tick(cam);
    expect(weather.wetness).toBeGreaterThan(0.9);
    setWeather({ rain: 0 });
    tick(cam);
    // Dries far more slowly than it wets — one frame must barely move it.
    expect(weather.wetness).toBeGreaterThan(0.85);
    shutdownAll();
  });
});
