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
import { surfaceAt, walkableAt, RING_R } from "@/empyrean/cityplan";
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
    // The lamp switch is low at sunset; the light is not. Two fields, and
    // the systems under test read a different one for each job.
    daylight: 0.35,
    gradeDaylight: 1,
    camRadiusSq: SPAWN.z * SPAWN.z,
  };
}

/** The translation column of every live instance matrix on a fleet. */
function instancePositions(mesh: THREE.InstancedMesh): Float32Array {
  const m = mesh.instanceMatrix.array as Float32Array;
  const out = new Float32Array(mesh.count * 3);
  for (let i = 0; i < mesh.count; i++) {
    out[i * 3] = m[i * 16 + 12];
    out[i * 3 + 1] = m[i * 16 + 13];
    out[i * 3 + 2] = m[i * 16 + 14];
  }
  return out;
}

describe("the crowd", () => {
  const ctx = makeCtx();
  const crowd = buildCrowd({ quality: "high", seedSalt: "test" });

  it("puts several hundred people on the deck, in three levels of detail", () => {
    crowd.update?.(ctx);
    expect(crowd.count).toBeGreaterThan(400);
    /* Six meshes: three tiers of body, and one each for the dogs, the robots
       and the prams. Six is the number to hold the line on — a population
       that stops instancing turns eight hundred people into eight hundred
       draws without failing anything else. */
    expect(crowd.group.children.length).toBe(6);
  });

  it("puts families, couples, dogs and robots on the street, not just adults", () => {
    /* The mix is the deliverable, so it is asserted rather than admired. A
       street of eight hundred identically-sized adults all in transit passes
       every other test in this file. */
    const c = crowd.census;
    expect(c.people).toBeGreaterThan(400);
    expect(c.families).toBeGreaterThan(30);
    expect(c.couples).toBeGreaterThan(40);
    // Roughly one person in ten is a child, and every one of them is with
    // somebody: a child alone on the pavement is a different sort of city.
    expect(c.children / c.people).toBeGreaterThan(0.06);
    expect(c.children / c.people).toBeLessThan(0.22);
    expect(c.dogs).toBeGreaterThan(5);
    expect(c.robots).toBeGreaterThan(8);
    expect(c.prams).toBeGreaterThan(4);

    const snap = crowd.snapshot();
    const kids = snap.people.filter((p) => p.role === "child" || p.role === "rider");
    expect(kids.length).toBeGreaterThan(50);
    expect(kids.every((k) => k.lead !== k.id)).toBe(true);
    // Every group is contiguous and led from the front, which is what lets a
    // follower read a leader that has already moved this frame.
    for (const p of snap.people) {
      expect(p.lead).toBeLessThanOrEqual(p.id);
      if (p.lead !== p.id) expect(snap.people[p.lead].lead).toBe(p.lead);
    }
    expect(snap.robots.some((r) => r.kind === "sweeper")).toBe(true);
    expect(snap.robots.some((r) => r.kind === "courier")).toBe(true);
    expect(snap.robots.some((r) => r.kind === "companion")).toBe(true);
  });

  it("keeps a family together for five simulated minutes, junctions included", () => {
    /* The failure this exists for is the one that makes a family stop being a
       family: two bodies handed the same destination, pathing separately, and
       taking different sides of the same block at the first junction. They
       arrive together, having walked two different streets, and from thirty
       metres they are two strangers who happen to be going the same way.
       Followers therefore walk their leader's own trail, and this is the
       assertion that says so — over long enough for a group to cross the
       city several times and be shoved through several crowds doing it. */
    let worst = 0;
    let worstWho = "";
    let over3 = 0;
    let apart = 0;
    let samples = 0;

    for (let f = 0; f < 18000; f++) {
      ctx.time += ctx.dt;
      crowd.update?.(ctx);
      if (f % 300 !== 0) continue;
      const snap = crowd.snapshot();
      for (const p of snap.people) {
        if (!p.active || p.lead === p.id || p.role === "rider") continue;
        const lead = snap.people[p.lead];
        const d = Math.hypot(p.x - lead.x, p.z - lead.z);
        samples++;
        if (d > 3) over3++;
        if (d > 1.4) apart++;
        if (d > worst) {
          worst = d;
          worstWho = `${p.role} ${p.id} is ${d.toFixed(1)} m from ${p.lead}`;
        }
        // Followers stand on pavement too, not only leaders.
        expect(walkableAt(p.x, p.z)).toBe(true);
      }
    }

    expect(samples).toBeGreaterThan(3000);
    // Nobody is ever left behind — an arm's length of slack, never a street.
    expect(worst, worstWho).toBeLessThan(6);
    expect(over3 / samples, worstWho).toBeLessThan(0.02);
    /* …and they are not welded together either. A child that keeps perfect
       station is a small adult on a rail; the gap has to open and close. */
    expect(apart / samples).toBeGreaterThan(0.02);
  }, 120000);

  it("carries children on shoulders rather than dragging them through the deck", () => {
    const snap = crowd.snapshot();
    const riders = snap.people.filter((p) => p.role === "rider");
    expect(riders.length).toBeGreaterThan(3);
    for (const r of riders) {
      const parent = snap.people[r.lead];
      // Directly above whoever is carrying them, and above their head height.
      expect(Math.hypot(r.x - parent.x, r.z - parent.z)).toBeLessThan(0.05);
      expect(r.y - parent.y).toBeGreaterThan(0.6);
      expect(r.y - parent.y).toBeLessThan(1.4);
    }
    /* And `nearest` does not offer one, because everything that calls it
       wants a body another body could walk up to. */
    for (const r of riders) {
      const hit = crowd.nearest(r.x, r.z, 0.4);
      if (hit) expect(hit.id).not.toBe(r.id);
    }
  });

  it("never leaves anybody sitting in the carriageway", () => {
    /* A destination is somewhere a body stops for a minute or two, and the
       nav graph legitimately contains road nodes because a crossing is one.
       Sitting on a crossing is not a crossing. Nearly a third of everybody
       seated was in a junction before the destinations were filtered, which
       no test in this file could see: they were on the island, on the deck,
       and on something walkable the whole time. */
    const kinds: Record<string, number> = {};
    let stopped = 0;
    let inRoad = 0;
    for (let f = 0; f < 6000; f++) {
      ctx.time += ctx.dt;
      crowd.update?.(ctx);
      if (f % 250 !== 0) continue;
      for (const p of crowd.snapshot().people) {
        if (!p.active) continue;
        if (p.state !== "sit" && p.state !== "lean" && p.state !== "stand") continue;
        const kind = surfaceAt(p.x, p.z).kind;
        kinds[kind] = (kinds[kind] ?? 0) + 1;
        stopped++;
        if (kind === "road") inRoad++;
        expect(kind).not.toBe("void");
        expect(kind).not.toBe("parapet");
      }
    }
    expect(stopped).toBeGreaterThan(2000);
    const line = JSON.stringify(kinds);
    // A body shoved a few centimetres over a kerb by the queue behind it is
    // not the bug; a bench in the middle of an avenue is.
    expect(inRoad / stopped, line).toBeLessThan(0.05);
  }, 60000);

  it("walks its dogs on the pavement and on the end of a lead", () => {
    let checks = 0;
    for (let f = 0; f < 5400; f++) {
      ctx.time += ctx.dt;
      crowd.update?.(ctx);
      if (f % 300 !== 0) continue;
      const snap = crowd.snapshot();
      for (const dog of snap.dogs) {
        const owner = snap.people[dog.owner];
        if (!owner.active) continue;
        checks++;
        const kind = surfaceAt(dog.x, dog.z).kind;
        expect(kind).not.toBe("void");
        expect(kind).not.toBe("parapet");
        expect(Math.abs(dog.y - ISLAND_Y)).toBeLessThan(1);
        // A lead is a lead. If a dog can be further from its owner than one
        // is long, the lead drawn between them is a line across the street.
        expect(Math.hypot(dog.x - owner.x, dog.z - owner.z)).toBeLessThan(3.2);
      }
      for (const bot of snap.robots) {
        const kind = surfaceAt(bot.x, bot.z).kind;
        expect(kind).not.toBe("void");
        expect(kind).not.toBe("parapet");
        expect(Math.abs(bot.y - ISLAND_Y)).toBeLessThan(1.2);
      }
    }
    expect(checks).toBeGreaterThan(100);
  }, 60000);

  it("has no NaN in anything it hands the driver", () => {
    /* One NaN collapses a bounding sphere and the mesh silently stops being
       drawn. The crowd writes twenty-odd floats per body per frame into
       buffers three tiers deep, and a divide by a zero-length segment is one
       line away at all times. */
    for (let f = 0; f < 600; f++) {
      ctx.time += ctx.dt;
      crowd.update?.(ctx);
    }
    for (const child of crowd.group.children) {
      const geo = (child as THREE.Mesh).geometry as THREE.InstancedBufferGeometry;
      for (const name of Object.keys(geo.attributes)) {
        const arr = geo.getAttribute(name).array as ArrayLike<number>;
        const live = Math.min(arr.length, Math.max(1, geo.instanceCount) * 4);
        for (let i = 0; i < live; i++) {
          if (!Number.isFinite(arr[i])) {
            throw new Error(`${child.name || child.type} ${name}[${i}] is ${arr[i]}`);
          }
        }
      }
    }
  }, 30000);

  it("is a different street in the afternoon than it is at three in the morning", () => {
    /* `dayPhase` already thins the crowd. This is the other half: *which*
       people. Families are an afternoon and early-evening thing; couples are
       a dusk thing. Both are one multiplier on the chance of stepping back
       out of a door, so it takes a couple of minutes of world time to show,
       which is exactly why it is measured rather than eyeballed. */
    const settle = (phase: number, light: number) => {
      ctx.dayPhase = phase;
      ctx.daylight = light;
      ctx.gradeDaylight = light > 0.02 ? 1 : 0;
      for (let f = 0; f < 10800; f++) {
        ctx.time += ctx.dt;
        crowd.update?.(ctx);
      }
      const c = crowd.census;
      return {
        people: c.people,
        family: c.families / Math.max(1, c.people),
        couple: c.couples / Math.max(1, c.people),
        kids: c.children,
      };
    };
    const afternoon = settle(0.6, 1);
    const dusk = settle(0.79, 0.3);
    const small = settle(0.06, 0);

    // Half past four: the street is as full as it gets and it is full of
    // families. Four in the morning: thinner, and what is left is adults.
    expect(afternoon.family).toBeGreaterThan(small.family * 1.6);
    expect(afternoon.kids).toBeGreaterThan(small.kids * 1.8);
    // Dusk belongs to couples — they are a larger share of a smaller street
    // than they are at any other hour.
    expect(dusk.couple).toBeGreaterThan(afternoon.couple);
    expect(dusk.couple).toBeGreaterThan(small.couple);
    // And the headcount still falls with the light, which is what it did
    // before any of this and must go on doing.
    expect(afternoon.people).toBeGreaterThan(dusk.people);
    expect(dusk.people).toBeGreaterThan(small.people);

    ctx.dayPhase = 0.75;
    ctx.daylight = 0.35;
    ctx.gradeDaylight = 1;
    for (let f = 0; f < 3600; f++) {
      ctx.time += ctx.dt;
      crowd.update?.(ctx);
    }
  }, 120000);

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
      ctx.gradeDaylight = ctx.daylight > 0.02 ? 1 : 0;
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

  it("is neither a conveyor belt nor a museum", () => {
    /* The failure this guards is not a crash, it is a mood. Tune the errands
       a little too long and every single body is in transit for ever, which
       reads as a commute; tune the dwells too long and the pavement is a
       waxwork. Both look completely fine in a screenshot.

       Measured through the only door there is: note who is standing where,
       wait five seconds, and ask who is still standing there. */
    const probes: Array<{ id: number; x: number; z: number }> = [];
    for (let a = 0; a < 90; a++) {
      const ang = (a / 90) * Math.PI * 2;
      for (const r of [70, 150, 210, 270, 320]) {
        const hit = crowd.nearest(Math.cos(ang) * r, Math.sin(ang) * r, 16);
        if (hit) probes.push({ id: hit.id, x: hit.x, z: hit.z });
      }
    }
    expect(probes.length).toBeGreaterThan(80);

    for (let f = 0; f < 300; f++) {
      ctx.time += ctx.dt;
      crowd.update?.(ctx);
    }

    let stayed = 0;
    for (const p of probes) {
      const hit = crowd.nearest(p.x, p.z, 1.1);
      if (hit && hit.id === p.id) stayed++;
    }
    const still = stayed / probes.length;
    // Somebody is always talking outside a shop, sitting, or on the rail…
    expect(still).toBeGreaterThan(0.08);
    // …and the street is never a waiting room.
    expect(still).toBeLessThan(0.7);
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

  it("costs six draws and a few thousand triangles, on both tiers", () => {
    /* The world's budget test cannot see any of this, and it is worth knowing
       why: it multiplies a geometry's triangles by `InstancedMesh.count`, and
       the crowd is not an `InstancedMesh`. It is a `Mesh` over an
       `InstancedBufferGeometry`, because a body needs a dozen custom
       per-instance attributes — pose weights, colours, what its hands are
       doing — and an instance matrix is none of them. So the most expensive
       system in this world reports about two hundred triangles over there,
       which is the cost of one person. This is the real number. */
    const cost = (root: THREE.Object3D) => {
      let draws = 0;
      let tris = 0;
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const geo = mesh.geometry as THREE.InstancedBufferGeometry;
        const index = geo.getIndex();
        const verts = index ? index.count : geo.getAttribute("position").count;
        draws++;
        tris += (verts / 3) * (geo.instanceCount ?? 1);
      });
      return { draws, tris: Math.round(tris) };
    };

    const near = makeCtx();
    near.camera.position.set(0, ISLAND_Y + 6, 120);
    near.camera.updateMatrixWorld(true);
    const measure = (quality: "low" | "high") => {
      const c = buildCrowd({ quality, seedSalt: "budget" });
      near.quality = quality;
      for (let f = 0; f < 240; f++) {
        near.time += near.dt;
        c.update?.(near);
      }
      const out = cost(c.group);
      c.dispose();
      return out;
    };

    const high = measure("high");
    const low = measure("low");
    const line = `high ${high.draws}d/${high.tris} low ${low.draws}d/${low.tris}`;
    // Three tiers of body plus a dog, a robot and a pram: six, whatever the
    // tier. Anything more means somebody stopped instancing something.
    expect(high.draws, line).toBe(6);
    expect(low.draws, line).toBe(6);
    // Hard LOD is what keeps this small: nothing past 260 m is drawn at all,
    // and nothing that is not a person past 155 m.
    expect(high.tris, line).toBeLessThan(45_000);
    expect(low.tris, line).toBeLessThan(high.tris * 0.6);
  }, 30000);

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
    const cars = traffic.group.children[0] as THREE.InstancedMesh;
    expect(cars.isInstancedMesh).toBe(true);
    const count = cars.count;
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

  it("keeps the tram's cars where the tram says the tram is", () => {
    /* The state object and the scene graph are two different things and it is
       entirely possible to move one and not the other — the tram reported the
       right coordinates for a while with its three cars sitting at the origin
       on the ice, six hundred metres below the city, because the transform
       lived in a custom vertex attribute that no three.js utility reads.
       This asserts the join: what `tram` says, and where the meshes are, over
       enough frames to cover a stop and a run between two. */
    const cars = traffic.group.children[1] as THREE.InstancedMesh;
    expect(cars.isInstancedMesh).toBe(true);
    expect(cars.count).toBe(3);

    const box = new THREE.Box3();
    const m = new THREE.Matrix4();
    const at = new THREE.Vector3();
    let checks = 0;
    for (let f = 0; f < 60 * 60; f++) {
      ctx.time += ctx.dt;
      traffic.update?.(ctx);
      if (f % 137 !== 0) continue;
      checks++;

      // The leading car's own matrix is the published position, to the metre.
      cars.getMatrixAt(0, m);
      at.setFromMatrixPosition(m);
      expect(Math.hypot(at.x - traffic.tram.x, at.z - traffic.tram.z)).toBeLessThan(1);
      expect(at.y).toBeCloseTo(traffic.tram.y, 3);

      // And the whole three-car set is up on the deck, on the ring, where a
      // player standing on the platform could be hit by it.
      box.setFromObject(cars);
      expect(box.min.y).toBeGreaterThan(ISLAND_Y - 4);
      expect(box.max.y).toBeLessThan(ISLAND_Y + 12);
      const r = Math.hypot((box.min.x + box.max.x) / 2, (box.min.z + box.max.z) / 2);
      expect(r).toBeGreaterThan(RING_R[1] - 40);
      expect(r).toBeLessThan(RING_R[1] + 6);
    }
    expect(checks).toBeGreaterThan(20);
  }, 30000);

  it("builds and runs on a phone, with no birds and a quarter of the cars", () => {
    // The low tier takes `BIRDS` to zero, which means an InstancedMesh with a
    // count of nothing — a shape that is easy to get wrong and never exercised
    // by the world test, which only ever builds the high tier.
    const phone = buildTraffic({ quality: "low", seedSalt: "test" });
    const phoneCtx = makeCtx();
    phoneCtx.quality = "low";
    for (let f = 0; f < 600; f++) {
      phoneCtx.time += phoneCtx.dt;
      expect(() => phone.update?.(phoneCtx)).not.toThrow();
    }
    const cars = phone.group.children[0] as THREE.InstancedMesh;
    const birds = phone.group.children[3] as THREE.InstancedMesh;
    expect(cars.count).toBeLessThan(20);
    expect(cars.count).toBeGreaterThan(4);
    expect(birds.count).toBe(0);
    expect(phone.stops.length).toBe(4);
    phone.dispose();
  }, 20000);

  it("disposes without leaving anything in the scene", () => {
    traffic.dispose();
    expect(traffic.group.children.length).toBe(0);
  });
});


