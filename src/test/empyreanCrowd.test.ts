/**
 * The crowd and the traffic, simulated headlessly for long enough that a slow
 * mistake has time to show.
 *
 * Everything here is a thing that looks fine for ten seconds and is wrong
 * after five minutes: a pedestrian who gets shoved a centimetre off the
 * pavement per frame, a path that never terminates, a tram whose lap creeps,
 * a per-frame array that grows. None of it is visible in a screenshot and all
 * of it is cheap to assert.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildCrowd } from "@/empyrean/crowd";
import { buildTraffic } from "@/empyrean/traffic";
import { surfaceAt } from "@/empyrean/cityplan";
import { ISLAND_Y, PLATEAU_R, SPAWN } from "@/empyrean/config";
import type { FrameContext } from "@/empyrean/types";

function makeCtx(): FrameContext {
  const camera = new THREE.PerspectiveCamera(58, 1.6, 0.35, 22000);
  camera.position.set(SPAWN.x, SPAWN.y + 4, SPAWN.z + 8);
  return {
    time: 0,
    dt: 1 / 60,
    camera,
    player: {
      position: new THREE.Vector3(SPAWN.x, SPAWN.y, SPAWN.z),
      velocity: new THREE.Vector3(),
      yaw: 0,
      grounded: true,
      burn: 0,
      altitude: 0,
    },
    quality: "high",
    dayPhase: 0.75,
    sunDir: new THREE.Vector3(-0.62, 0.085, -0.78).normalize(),
    daylight: 0.35,
    camRadiusSq: SPAWN.z * SPAWN.z,
  };
}

describe("the crowd", () => {
  const ctx = makeCtx();
  const crowd = buildCrowd({ quality: "high", seedSalt: "test" });

  it("puts several hundred people on the deck", () => {
    crowd.update?.(ctx);
    expect(crowd.count).toBeGreaterThan(250);
  });

  it("keeps every body on something walkable for five simulated minutes", () => {
    const positions = crowd.group.children as THREE.Mesh[];
    expect(positions.length).toBe(3);

    let worst = "";
    let offSurface = 0;
    let onLot = 0;
    let checked = 0;

    for (let f = 0; f < 18000; f++) {
      ctx.time += ctx.dt;
      // The day turns over the run, which is what moves the district weights.
      ctx.daylight = 0.5 + 0.5 * Math.sin(f / 3000);
      crowd.update?.(ctx);

      if (f % 250 !== 0) continue;
      // Sampled through the public surface: every body the crowd will admit
      // to, at a spread of points around the island.
      for (let a = 0; a < 64; a++) {
        const ang = (a / 64) * Math.PI * 2;
        for (const r of [20, 80, 150, 220, 300, 330]) {
          const hit = crowd.nearest(Math.cos(ang) * r, Math.sin(ang) * r, 12);
          if (!hit) continue;
          checked++;
          const s = surfaceAt(hit.x, hit.z);
          if (s.kind === "void" || s.kind === "parapet") {
            offSurface++;
            worst = `${s.kind} at ${hit.x.toFixed(1)},${hit.z.toFixed(1)}`;
          } else if (s.kind === "lot") {
            onLot++;
          }
          expect(hit.y).toBeGreaterThan(ISLAND_Y - 2);
          expect(hit.y).toBeLessThan(ISLAND_Y + 2);
          expect(Math.hypot(hit.x, hit.z)).toBeLessThan(PLATEAU_R);
        }
      }
    }

    expect(checked).toBeGreaterThan(2000);
    expect(offSurface, worst).toBe(0);
    // A body may clip the dead ground in front of a shopfront while a crowd
    // shoves it about; it may not live there.
    expect(onLot / checked).toBeLessThan(0.02);
  }, 60000);

  it("still has a population after the long run, and it tracks the light", () => {
    ctx.daylight = 1;
    for (let f = 0; f < 900; f++) {
      ctx.time += ctx.dt;
      crowd.update?.(ctx);
    }
    const bright = crowd.count;
    ctx.daylight = 0;
    for (let f = 0; f < 3600; f++) {
      ctx.time += ctx.dt;
      crowd.update?.(ctx);
    }
    const dark = crowd.count;
    expect(bright).toBeGreaterThan(dark);
    expect(dark).toBeGreaterThan(200);
  }, 30000);

  it("disposes without complaint", () => {
    crowd.dispose();
    expect(crowd.group.children.length).toBe(0);
  });
});

describe("the traffic", () => {
  it("runs a lap in about ninety seconds and stops everywhere", () => {
    const ctx = makeCtx();
    const traffic = buildTraffic({ quality: "high", seedSalt: "test" });
    expect(traffic.stops.length).toBeGreaterThanOrEqual(4);

    const seen = new Set<string>();
    let lapStart = -1;
    let lap = -1;
    let lastAngle = Math.atan2(traffic.tram.z, traffic.tram.x);
    let turned = 0;

    for (let f = 0; f < 60 * 200; f++) {
      ctx.time += ctx.dt;
      traffic.update?.(ctx);
      if (traffic.tram.stopped) seen.add(traffic.tram.nextStop);
      const a = Math.atan2(traffic.tram.z, traffic.tram.x);
      let d = a - lastAngle;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      turned += d;
      lastAngle = a;
      if (lapStart < 0 && Math.abs(turned) > 0.2) lapStart = f;
      if (lapStart >= 0 && lap < 0 && Math.abs(turned) >= Math.PI * 2) lap = (f - lapStart) / 60;
    }

    expect(lap).toBeGreaterThan(0);
    expect(lap).toBeLessThan(105);
    expect(lap).toBeGreaterThan(75);
    expect(seen.size).toBe(traffic.stops.length);
    traffic.dispose();
  }, 30000);
});
