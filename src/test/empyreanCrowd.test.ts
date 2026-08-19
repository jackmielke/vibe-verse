/**
 * The crowd and the traffic, run headlessly for long enough that a slow
 * mistake has time to show.
 *
 * Everything asserted here is a thing that looks perfectly fine for ten
 * seconds and is wrong after five minutes: a pedestrian nudged a centimetre
 * off the pavement per frame by the people around them, a path that never
 * terminates so its owner stands in the road for ever, a tram that brakes to
 * a halt a metre short of a platform it can then never reach, a per-frame
 * allocation that a profiler would find and a screenshot never will. None of
 * it is visible in a still and all of it is cheap to check.
 *
 * The two systems are simulated at a fixed 60 Hz, which is also why the RNG
 * they use in `update` does not make this flaky: same steps, same numbers.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildCrowd } from "@/empyrean/crowd";
import { buildTraffic } from "@/empyrean/traffic";
import { surfaceAt, RING_R } from "@/empyrean/cityplan";
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

/** Instanced positions off a fleet mesh, which is how the vehicles are read. */
function instancePositions(mesh: THREE.Mesh): Float32Array {
  const attr = mesh.geometry.getAttribute("aPos") as THREE.BufferAttribute;
  return attr.array as Float32Array;
}

describe("the crowd", () => {
  const ctx = makeCtx();
  const crowd = buildCrowd({ quality: "high", seedSalt: "test" });

  it("puts several hundred people on the deck, in three levels of detail", () => {
    crowd.update?.(ctx);
    expect(crowd.count).toBeGreaterThan(400);
    expect(crowd.group.children.length).toBe(3);
  });

  it("keeps every body on something walkable for five simulated minutes", () => {
    let worst = "";
    let offSurface = 0;
    let onLot = 0;
    let checked = 0;

    for (let f = 0; f < 18000; f++) {
      ctx.time += ctx.dt;
      // The day turns over the run, which is what moves the district weights
      // and the headcount, so this exercises both.
      ctx.daylight = 0.5 + 0.5 * Math.sin(f / 3000);
      crowd.update?.(ctx);

      if (f % 200 !== 0) continue;
      // Sampled through the public surface at a spread of points, so this is
      // testing what another system would actually be handed.
      for (let a = 0; a < 64; a++) {
        const ang = (a / 64) * Math.PI * 2;
        for (const r of [20, 80, 150, 220, 300, 332]) {
          const hit = crowd.nearest(Math.cos(ang) * r, Math.sin(ang) * r, 14);
          if (!hit) continue;
          checked++;
          const s = surfaceAt(hit.x, hit.z);
          if (s.kind === "void" || s.kind === "parapet") {
            offSurface++;
            worst = `${s.kind} at ${hit.x.toFixed(1)},${hit.z.toFixed(1)}`;
          } else if (s.kind === "lot") {
            onLot++;
          }
          // On the deck, on the island, and neither sunk into it nor floating.
          expect(hit.y).toBeGreaterThan(ISLAND_Y - 1);
          expect(hit.y).toBeLessThan(ISLAND_Y + 1);
          expect(Math.hypot(hit.x, hit.z)).toBeLessThan(PLATEAU_R);
        }
      }
    }

    expect(checked).toBeGreaterThan(5000);
    // The void and the parapet are absolute: nobody walks off the edge, ever.
    expect(offSurface, worst).toBe(0);
    /* A block interior is not. Between a shopfront and the kerb there are two
       or three metres of dead ground, and a body queueing at a door with four
       others shoving it is legitimately standing in it. It may visit; it may
       not live there. */
    expect(onLot / checked).toBeLessThan(0.03);
  }, 90000);

  it("keeps its paths terminating — nobody is left standing for ever", () => {
    /* A body whose path never completes stops moving for good. There is no
       way to ask the crowd how many of those there are, so this asks the
       question the player would: is the same person still standing there a
       minute later? */
    const before: Array<{ x: number; z: number } | null> = [];
    for (let a = 0; a < 40; a++) {
      const ang = (a / 40) * Math.PI * 2;
      const hit = crowd.nearest(Math.cos(ang) * 170, Math.sin(ang) * 170, 40);
      before.push(hit ? { x: hit.x, z: hit.z } : null);
    }
    for (let f = 0; f < 3600; f++) {
      ctx.time += ctx.dt;
      crowd.update?.(ctx);
    }
    let moved = 0;
    let seen = 0;
    for (let a = 0; a < 40; a++) {
      const ang = (a / 40) * Math.PI * 2;
      const hit = crowd.nearest(Math.cos(ang) * 170, Math.sin(ang) * 170, 40);
      const was = before[a];
      if (!hit || !was) continue;
      seen++;
      if (Math.hypot(hit.x - was.x, hit.z - was.z) > 2) moved++;
    }
    expect(seen).toBeGreaterThan(20);
    expect(moved / seen).toBeGreaterThan(0.5);
  }, 30000);

  it("answers `nearest` honestly", () => {
    const hit = crowd.nearest(0, 0, 900);
    expect(hit).not.toBeNull();
    expect(Math.hypot(hit!.x, hit!.z)).toBeLessThan(900);
    // Nobody is out over the lake.
    expect(crowd.nearest(2000, 2000, 50)).toBeNull();
  });

  it("thins out with the light and with the quality tier", () => {
    ctx.daylight = 1;
    for (let f = 0; f < 1800; f++) {
      ctx.time += ctx.dt;
      crowd.update?.(ctx);
    }
    const bright = crowd.count;
    ctx.daylight = 0;
    for (let f = 0; f < 5400; f++) {
      ctx.time += ctx.dt;
      crowd.update?.(ctx);
    }
    const dark = crowd.count;
    expect(bright).toBeGreaterThan(dark);
    expect(dark).toBeGreaterThan(300);

    const phone = buildCrowd({ quality: "low", seedSalt: "test" });
    const phoneCtx = makeCtx();
    phoneCtx.quality = "low";
    for (let f = 0; f < 600; f++) {
      phoneCtx.time += phoneCtx.dt;
      phone.update?.(phoneCtx);
    }
    // The low tier is the 60% cut the world asks for, and it is applied once.
    expect(phone.count).toBeLessThan(bright * 0.55);
    expect(phone.count).toBeGreaterThan(150);
    phone.dispose();
  }, 60000);

  it("does not allocate per frame", () => {
    const buffers = crowd.group.children.map((child) =>
      (child as THREE.Mesh).geometry.getAttribute("aPos").array,
    );

    const run = (frames: number) => {
      for (let f = 0; f < frames; f++) {
        ctx.time += ctx.dt;
        crowd.update?.(ctx);
      }
    };

    run(1200);
    const before = process.memoryUsage().heapUsed;
    run(6000);
    const after = process.memoryUsage().heapUsed;

    // The instance buffers are the same objects they were: nothing has been
    // reallocated behind the LOD tiers.
    crowd.group.children.forEach((child, i) => {
      expect((child as THREE.Mesh).geometry.getAttribute("aPos").array).toBe(buffers[i]);
    });
    /* Six thousand frames of eight hundred bodies. One scratch vector per body
       per frame would be about a quarter of a gigabyte through here; anything
       under a few megabytes is the interpreter breathing. */
    expect(after - before).toBeLessThan(24 * 1024 * 1024);
  }, 60000);

  it("disposes without leaving anything in the scene", () => {
    crowd.dispose();
    expect(crowd.group.children.length).toBe(0);
  });
});

describe("the traffic", () => {
  const ctx = makeCtx();
  const traffic = buildTraffic({ quality: "high", seedSalt: "test" });

  it("puts its platforms on the middle ring, at deck height", () => {
    expect(traffic.stops.length).toBe(4);
    for (const stop of traffic.stops) {
      const r = Math.hypot(stop.x, stop.z);
      // Beside the road and not in it: the inner pavement of the ring.
      expect(r).toBeGreaterThan(RING_R[1] - 14);
      expect(r).toBeLessThan(RING_R[1] - 5);
      expect(stop.y).toBeGreaterThan(ISLAND_Y);
      expect(stop.y).toBeLessThan(ISLAND_Y + 1);
      expect(surfaceAt(stop.x, stop.z).kind).not.toBe("void");
    }
  });

  it("runs a lap in about ninety seconds and calls at every stop", () => {
    const seen = new Set<string>();
    let lapStart = -1;
    let lap = -1;
    let last = Math.atan2(traffic.tram.z, traffic.tram.x);
    let turned = 0;
    let offRing = 0;

    for (let f = 0; f < 60 * 400; f++) {
      ctx.time += ctx.dt;
      traffic.update?.(ctx);
      if (traffic.tram.stopped) seen.add(traffic.tram.nextStop);

      const r = Math.hypot(traffic.tram.x, traffic.tram.z);
      if (Math.abs(r - RING_R[1]) > 1.5) offRing++;

      const a = Math.atan2(traffic.tram.z, traffic.tram.x);
      let d = a - last;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      turned += d;
      last = a;
      if (lapStart < 0 && Math.abs(turned) > 0.25) lapStart = f;
      if (lapStart >= 0 && lap < 0 && Math.abs(turned) >= Math.PI * 2) {
        lap = (f - lapStart) / 60;
      }
    }

    expect(offRing).toBe(0);
    expect(lap).toBeGreaterThan(80);
    expect(lap).toBeLessThan(100);
    expect(seen.size).toBe(traffic.stops.length);
  }, 60000);

  it("flies its skycars in their lanes without ever sharing a metre of air", () => {
    const cars = traffic.group.children[0] as THREE.Mesh;
    const count = (cars.geometry as THREE.InstancedBufferGeometry).instanceCount;
    expect(count).toBeGreaterThan(20);

    let worstGap = Infinity;
    let lowest = Infinity;
    let highest = -Infinity;
    for (let f = 0; f < 60 * 180; f++) {
      ctx.time += ctx.dt;
      traffic.update?.(ctx);
      if (f % 17 !== 0) continue;
      const pos = instancePositions(cars);
      for (let i = 0; i < count; i++) {
        lowest = Math.min(lowest, pos[i * 3 + 1]);
        highest = Math.max(highest, pos[i * 3 + 1]);
        for (let j = i + 1; j < count; j++) {
          const d = Math.hypot(
            pos[i * 3] - pos[j * 3],
            pos[i * 3 + 1] - pos[j * 3 + 1],
            pos[i * 3 + 2] - pos[j * 3 + 2],
          );
          if (d < worstGap) worstGap = d;
        }
      }
    }
    /* Lanes are ten metres of air apart wherever they cross, and the queue
       discipline holds everything on one lane very much further apart than
       that. A craft is six metres long. */
    expect(worstGap).toBeGreaterThan(9);
    expect(lowest).toBeGreaterThan(ISLAND_Y + 18);
    expect(highest).toBeLessThan(ISLAND_Y + 95);
  }, 60000);

  it("disposes without leaving anything in the scene", () => {
    traffic.dispose();
    expect(traffic.group.children.length).toBe(0);
  });
});

