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
/* The one import here that no *system* is allowed: the benches come out of
   props.ts's own occupancy grid and RNG stream and are not derivable from the
   plan, so the engine carries the list from one to the other and this is the
   test of that join. A test may look at both sides of it; a system may not. */
import { buildProps } from "@/empyrean/props";
import { surfaceAt, walkableAt, HALO_R, LANDMARKS, RING_R } from "@/empyrean/cityplan";
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

  it("puts a thousand-odd people on the deck, in three levels of detail", () => {
    crowd.update?.(ctx);
    /* Sixteen hundred built, and never all of them out at once — the hour
       decides how many are, and this is the sunset. The number is pinned
       because "the streets are thin" was true for a long time and was
       invisible to every other test in this file: they all ask whether a body
       is somewhere legal, and none of them asks whether there are enough. */
    expect(crowd.count).toBeGreaterThan(1100);
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
    expect(c.people).toBeGreaterThan(1100);
    expect(c.families).toBeGreaterThan(60);
    expect(c.couples).toBeGreaterThan(80);
    // Roughly one person in ten is a child, and every one of them is with
    // somebody: a child alone on the pavement is a different sort of city.
    expect(c.children / c.people).toBeGreaterThan(0.06);
    expect(c.children / c.people).toBeLessThan(0.22);
    expect(c.dogs).toBeGreaterThan(5);
    expect(c.robots).toBeGreaterThan(8);
    expect(c.prams).toBeGreaterThan(4);

    const snap = crowd.snapshot();
    const kids = snap.people.filter((p) => p.role === "child" || p.role === "rider");
    expect(kids.length).toBeGreaterThan(100);
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
    expect(dark).toBeGreaterThan(700);

    const phone = buildCrowd({ quality: "low", seedSalt: "test" });
    const phoneCtx = makeCtx();
    phoneCtx.quality = "low";
    for (let f = 0; f < 600; f++) {
      phoneCtx.time += phoneCtx.dt;
      phone.update?.(phoneCtx);
    }
    /* The low tier is the 60% cut the world asks for, and it is applied once.
       It thins *proportionally*: the ratio is what is asserted, not an
       absolute headcount, so raising the population cannot quietly stop the
       phone being a phone. */
    expect(phone.count).toBeLessThan(bright * 0.55);
    expect(phone.count).toBeGreaterThan(bright * 0.28);
    expect(phone.count).toBeGreaterThan(350);
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
    /* Hard LOD is what keeps this small: nothing past 260 m is drawn at all,
       and nothing that is not a person past 155 m. Measured at sixteen
       hundred bodies it is about 23,000 from this camera against the world's
       400,000 ceiling — and the number that moved when the population doubled
       was *not* proportional, because the rings and not the headcount are
       what bounds it. */
    expect(high.tris, line).toBeLessThan(60_000);
    expect(low.tris, line).toBeLessThan(high.tris * 0.7);
  }, 30000);

  it("costs about half a microsecond a body, and stays linear in bodies", () => {
    /* The real cost of this system is CPU per frame, not triangles, and it is
       per *body*: the GPU poses a walk cycle and a bench sit for the same
       money, and the CPU writes twenty-two floats and decides nothing for
       anybody who is not a group leader with an expired clock.
       Measured on this container at the time of writing, from a street-level
       camera in the Bazaar: 0.81 ms a frame for 1317 bodies on the high tier
       and 0.38 for 527 on the low — 0.62 and 0.71 microseconds each. It was
       0.31 ms for 681 bodies before the population was doubled.
       Wall-clock is a terrible thing to assert on a shared box, so what is
       asserted is the *shape*: the high tier has two and a half times the
       low tier's population, so it may cost two and a half times as much and
       not six, which is what anything accidentally quadratic in here — a
       separation pass that stopped capping its neighbours, an A* budget that
       stopped being a budget — would cost. */
    const run = (quality: "low" | "high") => {
      const c = buildCrowd({ quality, seedSalt: "cost" });
      const local = makeCtx();
      local.quality = quality;
      local.camera.position.set(0, ISLAND_Y + 1.7, 175);
      local.camera.updateMatrixWorld(true);
      // Warm: the first hundred frames of a population are its slowest by a
      // wide margin, and they are the frames the engine spends compiling.
      for (let f = 0; f < 2000; f++) {
        local.time += local.dt;
        c.update?.(local);
      }
      const t0 = process.hrtime.bigint();
      for (let f = 0; f < 2000; f++) {
        local.time += local.dt;
        c.update?.(local);
      }
      const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 2000;
      const people = c.census.people;
      c.dispose();
      return { ms, people };
    };
    const hi = run("high");
    const lo = run("low");
    const line = `high ${hi.people} bodies ${hi.ms.toFixed(3)} ms, low ${lo.people} ${lo.ms.toFixed(3)} ms`;
    expect(hi.people / lo.people, line).toBeGreaterThan(2);
    expect(hi.ms / lo.ms, line).toBeLessThan(5);
  }, 120000);

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

/* -------------------------------------------------------------------------
 * The benches
 *
 * `props.ts` puts 334 benches on this city's pavements and for a long time
 * nobody sat on a single one, because a bench comes out of that file's own
 * occupancy grid and its own RNG stream and is not derivable from the plan.
 * The engine now carries the list across, which makes this the test of a
 * *join* between two systems that may not import each other — and the failure
 * it exists for is not an exception. It is a body sitting nine inches to the
 * left of a bench, or two bodies in the same place on one, or a bench with
 * somebody sitting on it back to front. None of those throws, none of them
 * fails any other test here, and all of them are obvious the moment you look.
 * ---------------------------------------------------------------------- */
describe("the crowd, on the city's benches", () => {
  const props = buildProps({ quality: "high", seedSalt: "test" });
  const benches = props.placements.filter((p) => p.kind === "bench");
  const ctx = makeCtx();
  const crowd = buildCrowd({ quality: "high", seedSalt: "test" }, { seats: benches });

  /** Where the two places on a bench are, derived the way the crowd does it. */
  const seatAt = (seat: number) => {
    const b = benches[seat >> 1];
    const yaw = b.yaw ?? 0;
    const u = (seat & 1) === 0 ? -0.42 : 0.42;
    return { x: b.x + Math.cos(yaw) * u, z: b.z - Math.sin(yaw) * u, yaw };
  };

  it("is handed benches that know which way they face", () => {
    /* Half of this fix lives in props.ts and the other half here, and the
       join between them is one optional field. A placement that quietly
       stopped carrying it would leave everybody kerb-sitting again with
       nothing at all to show for it. */
    expect(benches.length).toBeGreaterThan(250);
    expect(benches.every((b) => b.yaw !== undefined && Number.isFinite(b.yaw))).toBe(true);
  });

  it("sits people on them, on them, and facing the way they face", () => {
    for (let f = 0; f < 60 * 240; f++) {
      ctx.time += ctx.dt;
      crowd.update?.(ctx);
    }
    const c = crowd.census;
    // Not "somebody, somewhere": a visible fraction of a sixteen-hundred-body
    // city, on furniture, at any given moment.
    expect(c.benched).toBeGreaterThan(25);
    expect(c.benched / Math.max(1, c.sitting)).toBeGreaterThan(0.3);

    const snap = crowd.snapshot();
    const seated = snap.people.filter((p) => p.active && p.seat >= 0 && p.state === "sit");
    expect(seated.length).toBeGreaterThan(20);

    let worst = "";
    let worstD = 0;
    for (const p of seated) {
      const s = seatAt(p.seat);
      const d = Math.hypot(p.x - s.x, p.z - s.z);
      if (d > worstD) {
        worstD = d;
        worst = `${p.id} is ${d.toFixed(2)} m off seat ${p.seat}`;
      }
      /* Half a metre. A seated body is held on its seat by the same home
         spring that holds a standing one on its spot, so the crowd walking
         past can push it a hand's breadth along the slats — which is what
         people on benches do — and cannot push it off one. */
      expect(d, worst).toBeLessThan(0.5);
    }

    /* Facing is measured after four seconds, not on the frame it is sampled.
     *
     * Sitting down is a *turn*, at the same 2.5 rad/s everything else here
     * turns at, and that is deliberate: snapping the yaw on arrival makes a
     * body pivot on the spot the instant its backside lands. So at any given
     * instant one or two of forty seated people are still swinging round, and
     * an assertion on a single frame fails on them — measured, at 1.13 rad
     * off, which is a body settling and not a body facing the wrong way.
     * Everybody who is still on the same seat four seconds later has
     * finished. */
    const wasOn = new Map<number, number>();
    for (const p of seated) wasOn.set(p.id, p.seat);
    for (let f = 0; f < 240; f++) {
      ctx.time += ctx.dt;
      crowd.update?.(ctx);
    }
    let settled = 0;
    for (const p of crowd.snapshot().people) {
      if (p.state !== "sit" || p.seat < 0 || wasOn.get(p.id) !== p.seat) continue;
      settled++;
      const s = seatAt(p.seat);
      let turn = p.yaw - s.yaw;
      while (turn > Math.PI) turn -= Math.PI * 2;
      while (turn < -Math.PI) turn += Math.PI * 2;
      // Facing along the bench's own axis, not across it and not off the back.
      expect(Math.abs(turn), `${p.id} is turned ${turn.toFixed(2)} rad on its bench`).toBeLessThan(0.3);
    }
    expect(settled).toBeGreaterThan(15);
  }, 300000);

  it("never puts two people in the same place on one, and lets two share", () => {
    /* A bench is 1.7 m of slat: two people fit and a third does not. The two
       places are handed out exclusively and given back when somebody leaves,
       and both halves of that matter — forget the giving back and the city's
       benches fill up over ten minutes and are never free again. */
    const held = new Map<number, number>();
    let sharedSeen = 0;
    let everFree = 0;
    for (let f = 0; f < 60 * 200; f++) {
      ctx.time += ctx.dt;
      crowd.update?.(ctx);
      if (f % 600 !== 0) continue;
      held.clear();
      const perBench = new Map<number, number>();
      for (const p of crowd.snapshot().people) {
        if (p.seat < 0) continue;
        expect(held.has(p.seat), `seat ${p.seat} held by ${held.get(p.seat)} and ${p.id}`).toBe(false);
        held.set(p.seat, p.id);
        perBench.set(p.seat >> 1, (perBench.get(p.seat >> 1) ?? 0) + 1);
      }
      for (const n of perBench.values()) {
        expect(n).toBeLessThanOrEqual(2);
        if (n === 2) sharedSeen++;
      }
      // …and the great majority of the city's benches are free, which is what
      // a city's benches are. A booking that is never returned shows up here.
      if (perBench.size < benches.length * 0.5) everFree++;
    }
    expect(sharedSeen).toBeGreaterThan(3);
    expect(everFree).toBeGreaterThan(15);
  }, 300000);

  it("still kerb-sits when it is given no benches at all", () => {
    /* The fallback, and the reason it has to stay: 334 benches against about
       a hundred thousand square metres of pavement. Built with no options the
       system must be exactly what it was — nobody on a bench, everybody who
       sits sitting on the kerb, and not one instance carrying a seat height
       into the shader. */
    const bare = buildCrowd({ quality: "high", seedSalt: "test" });
    const bareCtx = makeCtx();
    for (let f = 0; f < 60 * 120; f++) {
      bareCtx.time += bareCtx.dt;
      bare.update?.(bareCtx);
    }
    expect(bare.census.benched).toBe(0);
    expect(bare.census.sitting).toBeGreaterThan(5);
    expect(bare.snapshot().people.every((p) => p.seat === -1)).toBe(true);
    let checkedTiers = 0;
    for (const child of bare.group.children) {
      const geo = (child as THREE.Mesh).geometry as THREE.InstancedBufferGeometry;
      // Three of the six meshes are the dogs, the robots and the prams, and
      // none of them has a pose at all.
      const pose = geo.getAttribute("aPose");
      if (!pose) continue;
      checkedTiers++;
      expect(pose.itemSize).toBe(4);
      const arr = pose.array as ArrayLike<number>;
      for (let i = 0; i < (geo.instanceCount ?? 0); i++) expect(arr[i * 4 + 3]).toBe(0);
    }
    expect(checkedTiers).toBe(3);
    bare.dispose();
  }, 120000);

  it("hands the shader a seat height that is either a bench or nothing", () => {
    /* The pose is solved from `aPose.w` in the vertex shader, so a half-way
       value is a body half-way into a bench and a stale one is a body sitting
       47 cm above a pavement. Neither throws and neither is visible in a
       still that happens not to contain a bench. */
    const near = makeCtx();
    near.camera.position.set(0, ISLAND_Y + 1.7, 175);
    near.camera.updateMatrixWorld(true);
    let seatedInstances = 0;
    for (let f = 0; f < 60 * 90; f++) {
      near.time += near.dt;
      crowd.update?.(near);
    }
    for (const child of crowd.group.children) {
      const geo = (child as THREE.Mesh).geometry as THREE.InstancedBufferGeometry;
      const pose = geo.getAttribute("aPose");
      if (!pose) continue; // a dog, a robot or a pram
      const arr = pose.array as ArrayLike<number>;
      for (let i = 0; i < (geo.instanceCount ?? 0); i++) {
        const h = arr[i * 4 + 3];
        expect(h === 0 || Math.abs(h - 0.47) < 1e-5, `aPose.w[${i}] is ${h}`).toBe(true);
        if (h > 0) seatedInstances++;
      }
    }
    expect(seatedInstances).toBeGreaterThan(0);
  }, 120000);

  it("disposes, and lets its props go too", () => {
    crowd.dispose();
    expect(crowd.group.children.length).toBe(0);
    props.dispose();
  });
});

/* -------------------------------------------------------------------------
 * The Halo
 *
 * The great circular plaza at the middle of the city, with the Beacon in it,
 * and for a long time not one pedestrian at any hour. It was not a weighting
 * problem: `buildNav` gives the plaza one ring of nodes round its *kerb* and
 * nothing across it, so there was no route through the middle of the city and
 * the Beacon — the thing the whole map is oriented on — had zero standing
 * spots of the ten it asks for, because the nearest node to any point on its
 * circle was 24 m away. `crowd.ts` paves it.
 * ---------------------------------------------------------------------- */
describe("the crowd, in the Halo", () => {
  const ctx = makeCtx();
  const crowd = buildCrowd({ quality: "high", seedSalt: "test" });
  const beacon = LANDMARKS.find((l) => l.id === "beacon")!;
  const cistern = LANDMARKS.find((l) => l.id === "fountain")!;

  it("walks people across it and stands them in front of the Beacon", () => {
    let emptyFrames = 0;
    let samples = 0;
    let atBeacon = 0;
    let inPlaza = 0;
    for (let f = 0; f < 60 * 300; f++) {
      ctx.time += ctx.dt;
      crowd.update?.(ctx);
      if (f % 900 !== 0) continue;
      samples++;
      let here = 0;
      let looking = 0;
      for (const p of crowd.snapshot().people) {
        if (!p.active) continue;
        const r = Math.hypot(p.x, p.z);
        if (r >= HALO_R) continue;
        here++;
        if (r < beacon.clear + 18) looking++;
      }
      inPlaza += here;
      atBeacon += looking;
      if (here === 0) emptyFrames++;
    }
    const line = `${(inPlaza / samples).toFixed(0)} in the plaza, ${(atBeacon / samples).toFixed(0)} at the Beacon`;
    // Never once empty, and not by one or two people either.
    expect(emptyFrames, line).toBe(0);
    expect(inPlaza / samples, line).toBeGreaterThan(15);
    expect(atBeacon / samples, line).toBeGreaterThan(3);
  }, 300000);

  it("keeps them out of the things standing in it", () => {
    /* The plaza is paved *round* what is on it, from the clearance each
       landmark declares for itself, so the graph survives the plan moving
       either of them. Nobody stands inside the Beacon's base and nobody
       paddles in the Cistern. */
    let worst = "";
    for (let f = 0; f < 60 * 120; f++) {
      ctx.time += ctx.dt;
      crowd.update?.(ctx);
      if (f % 300 !== 0) continue;
      for (const p of crowd.snapshot().people) {
        if (!p.active) continue;
        const rb = Math.hypot(p.x - beacon.x, p.z - beacon.z);
        const rc = Math.hypot(p.x - cistern.x, p.z - cistern.z);
        if (rb < beacon.clear || rc < cistern.clear) {
          worst = `${p.id} at ${p.x.toFixed(1)},${p.z.toFixed(1)}: ${rb.toFixed(1)} m from the Beacon, ${rc.toFixed(1)} from the Cistern`;
        }
        /* The clearance each landmark declares, exactly, and not a metre
           inside it. A pedestrian is not held on a nav node — it is offset
           across the pavement it is walking and shoved by everybody around
           it — so the plaza is laid out with room for all of that, and this
           is the assertion that the room is enough. */
        expect(rb, worst).toBeGreaterThan(beacon.clear);
        expect(rc, worst).toBeGreaterThan(cistern.clear);
        // …and on the plaza itself rather than in the void beside it.
        if (Math.hypot(p.x, p.z) < HALO_R) {
          expect(surfaceAt(p.x, p.z).kind).toBe("plaza");
        }
      }
    }
  }, 180000);

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


