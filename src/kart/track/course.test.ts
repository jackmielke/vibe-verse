import * as THREE from "three";
import { describe, it, expect } from "vitest";

/**
 * course.test.ts — drive Sunset Bluff and look for the things a still
 * screenshot cannot show you.
 *
 * The AI smoke test in `ai/drive.test.ts` asks "can the field get round". This
 * one asks the two questions that produced actual bug reports:
 *
 *  1. **Does any one section of the course eat karts?** Respawns are counted
 *     per named section rather than in total, because eight respawns spread
 *     over a lap is a hard course and eight respawns at the Bluff Jump is a
 *     broken jump — and the totals cannot tell the two apart.
 *
 *  2. **Does the camera end up inside the world?** The chase camera is a
 *     spring, and a spring lags. Every "the game glitches out here" report on
 *     this course has turned out to be the eye passing through a cliff, the
 *     underside of the ribbon or the sea while the pose it was chasing was
 *     perfectly legal. So the camera is booted headless (it never touches the
 *     renderer) and its settled position is checked against the terrain and the
 *     waterline every single frame.
 */
import { makeKartInput, makeRng, FIXED_DT, type KartCtx, type System } from "../types";
import createTrack from "../track";
import type { KartTrackService } from "../track";
import createPhysics from "../physics";
import type { KartPhysicsService } from "../physics";
import createAi from "../ai";
import createCamera from "../engine/camera";

function makeCtx(): KartCtx {
  const listeners = new Map<string, Set<(p: never) => void>>();
  return {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    renderer: {} as THREE.WebGLRenderer,
    services: {},
    input: makeKartInput(),
    elapsed: 0,
    dt: 0,
    quality: "high",
    rng: makeRng(1),
    viewport: { width: 1280, height: 720, aspect: 16 / 9, dpr: 1 },
    emit: (e, p) => {
      const s = listeners.get(e as string);
      if (s) for (const f of s) (f as (x: unknown) => void)(p);
    },
    on: (e, f) => {
      let s = listeners.get(e as string);
      if (!s) listeners.set(e as string, (s = new Set()));
      s.add(f);
      return () => s!.delete(f);
    },
  };
}

interface SectionTally {
  frames: number;
  respawns: number;
  camInside: number;
  camUnderSea: number;
  worstCam: number;
}

describe("sunset bluff, driven", () => {
  const ctx = makeCtx();
  const systems: System[] = [
    createTrack(ctx) as System,
    createPhysics(ctx) as System,
    createAi(ctx) as System,
    createCamera(ctx) as System,
  ];
  const track = ctx.services.track as KartTrackService;
  const phys = ctx.services.physics as KartPhysicsService;
  phys.playerAi = true;

  const tally = new Map<string, SectionTally>();
  const of = (id: string): SectionTally => {
    let e = tally.get(id);
    if (!e) tally.set(id, (e = { frames: 0, respawns: 0, camInside: 0, camUnderSea: 0, worstCam: 0 }));
    return e;
  };
  const sectionAt = (t: number): string => {
    const s = t * track.length;
    for (const sec of track.sections) if (s >= sec.start && s < sec.end) return sec.id;
    return track.sections[track.sections.length - 1].id;
  };

  ctx.on("race:respawn", ((p: { racer?: number }) => {
    const r = phys.get(p?.racer ?? -1);
    if (r) of(sectionAt(r.t)).respawns++;
  }) as never);

  const player = phys.player;
  let travel = 0;
  let camTravel = 0;
  const lastCam = new THREE.Vector3().copy(ctx.camera.position);
  const steps = Math.round(180 / FIXED_DT);
  for (let n = 0; n < steps; n++) {
    ctx.elapsed += FIXED_DT;
    ctx.input.accel = 1;
    for (const s of systems) s.fixedUpdate?.(FIXED_DT, ctx);
    for (const s of systems) s.lateUpdate?.(FIXED_DT, ctx);

    const id = sectionAt(player.t);
    const e = of(id);
    e.frames++;

    // The camera is the subject here. `ground.height` is the same field the
    // terrain mesh is built from, so "below it" is literally "inside the hill".
    travel += Math.abs(player.speed) * FIXED_DT;
    const cam = ctx.camera.position;
    camTravel += lastCam.distanceTo(cam);
    lastCam.copy(cam);
    const gh = track.ground.height(cam.x, cam.z);
    const depth = gh - cam.y;
    if (depth > 0.05) {
      e.camInside++;
      if (depth > e.worstCam) e.worstCam = depth;
    }
    if (cam.y < track.seaLevel + 0.2) e.camUnderSea++;
  }

  const rows = track.sections
    .map((sec) => ({ id: sec.id, ...(tally.get(sec.id) ?? { frames: 0, respawns: 0, camInside: 0, camUnderSea: 0, worstCam: 0 }) }))
    .filter((r) => r.frames > 0);

  it("reports where the course misbehaves", () => {
    const lines = rows
      .filter((r) => r.respawns || r.camInside || r.camUnderSea)
      .map(
        (r) =>
          `${r.id.padEnd(13)} frames ${String(r.frames).padStart(5)}  respawns ${r.respawns}  camInside ${r.camInside} (worst ${r.worstCam.toFixed(1)}m)  camUnderSea ${r.camUnderSea}`,
      );
    console.log(
      `player travelled ${(travel / track.length).toFixed(2)} laps; camera moved ${camTravel.toFixed(0)} m; sections visited ${rows.length}`,
    );
    console.log(lines.length ? lines.join("\n") : "clean lap: no respawns, camera never inside the world");
    expect(rows.length).toBeGreaterThan(10);
    expect(travel / track.length).toBeGreaterThan(1);
    expect(camTravel).toBeGreaterThan(100);
  }, 180000);

  it("never films from inside the terrain", () => {
    const worst = rows.reduce((a, r) => (r.camInside > a.camInside ? r : a), rows[0]);
    // A frame or two on a hard landing is a spring catching up. A hundred is
    // the camera living in a hillside, which is what the bug reports look like.
    expect(`${worst.id}:${worst.camInside}`).toBe(`${worst.id}:0`);
  }, 180000);

  it("never films from under the sea", () => {
    const worst = rows.reduce((a, r) => (r.camUnderSea > a.camUnderSea ? r : a), rows[0]);
    expect(`${worst.id}:${worst.camUnderSea}`).toBe(`${worst.id}:0`);
  }, 180000);

  it("has no single section that eats karts", () => {
    // Three laps of a course with a jump and a shortcut will lose the odd kart.
    // A section losing it every lap is a section that is broken.
    for (const r of rows) expect(`${r.id}:${r.respawns <= 3}`).toBe(`${r.id}:true`);
  }, 180000);
});

/**
 * The camera, put somewhere the AI never goes.
 *
 * A clean AI lap proves nothing about the camera, because the pilot drives the
 * racing line and the boom never has to solve anything hard. Every real report
 * came from a player who had come *off* — into Gull Creek, over the side of the
 * anti-gravity plating, down into the quarry — and the frame filled with rock,
 * with the underside of the ribbon, or with the sea seen from below.
 *
 * So: drop the kart in each of those places by hand and film it.
 */
describe("the camera, off the road", () => {
  const ctx = makeCtx();
  const systems: System[] = [
    createTrack(ctx) as System,
    createPhysics(ctx) as System,
    createCamera(ctx) as System,
  ];
  const track = ctx.services.track as KartTrackService;
  const phys = ctx.services.physics as KartPhysicsService;
  const curve = track.curve;

  /** A point `lateral` metres off the centreline of `seg` at fraction `f`. */
  const spot = (seg: string, f: number, lateral: number, rise: number): THREE.Vector3 => {
    const span = curve.spanOf(seg);
    const frame = curve.frameAtS(span.start + (span.end - span.start) * f);
    return frame.position.clone().addScaledVector(frame.right, lateral).addScaledVector(new THREE.Vector3(0, 1, 0), rise);
  };

  const places: Array<{ name: string; at: THREE.Vector3 }> = [
    { name: "in Gull Creek, under the bridge", at: spot("bridge", 0.5, 0, -13) },
    { name: "over the side of the creek", at: spot("chicane2", 0.3, 26, -12) },
    { name: "off the anti-gravity plating", at: spot("antigrav", 0.5, -16, 0) },
    { name: "behind the plating, in the headland", at: spot("antigrav", 0.5, 14, 0) },
    { name: "on the floor of the quarry chasm", at: spot("gap", 0.5, 0, -30) },
    { name: "short of the Bluff Jump landing", at: spot("gap", 0.8, 0, -8) },
    { name: "under the Bay Viaduct", at: spot("agExit", 0.5, 0, -16) },
    { name: "in the bowl, outside the banking", at: spot("bowl", 0.5, 34, -6) },
    { name: "in the bay", at: spot("antigrav", 0.5, -70, 0) },
    { name: "inside the bluff, beside the tunnel", at: spot("tunnel", 0.5, 30, 4) },
  ];

  const player = phys.player;
  const failures: string[] = [];

  for (const place of places) {
    let inside = 0;
    let underSea = 0;
    let worst = 0;
    for (let n = 0; n < 90; n++) {
      // Held there: the point is to film the spot, not to watch the physics
      // rescue the kart out of it before the camera has settled.
      player.position.copy(place.at);
      player.velocity.set(0, 0, 0);
      ctx.elapsed += FIXED_DT;
      for (const s of systems) s.fixedUpdate?.(FIXED_DT, ctx);
      for (const s of systems) s.lateUpdate?.(FIXED_DT, ctx);
      if (n < 30) continue; // let the spring arrive before judging the shot
      const cam = ctx.camera.position;
      const depth = track.ground.height(cam.x, cam.z) - cam.y;
      if (depth > 0.05) {
        inside++;
        worst = Math.max(worst, depth);
      }
      if (cam.y < track.seaLevel + 0.2) underSea++;
    }
    if (inside || underSea) {
      failures.push(
        `${place.name}: ${inside}/60 frames inside the terrain (worst ${worst.toFixed(1)} m), ${underSea}/60 under the sea`,
      );
    }
  }

  it("stays out of the world wherever the kart ends up", () => {
    if (failures.length) console.log(failures.join("\n"));
    expect(failures).toEqual([]);
  }, 180000);
});

/**
 * The same lap, driven badly.
 *
 * The AI pilot knows the line, so a clean AI lap says nothing about the places
 * a player actually gets into trouble. This one pins the throttle and saws at
 * the wheel — a reasonable model of somebody's first go — and counts what
 * happens per section. It asserts almost nothing about lap times and
 * everything about the course not having a hole a bad driver falls into on
 * every single lap.
 */
describe("sunset bluff, driven badly", () => {
  const ctx = makeCtx();
  const systems: System[] = [
    createTrack(ctx) as System,
    createPhysics(ctx) as System,
    createAi(ctx) as System,
    createCamera(ctx) as System,
  ];
  const track = ctx.services.track as KartTrackService;
  const phys = ctx.services.physics as KartPhysicsService;
  const player = phys.player;

  const tally = new Map<string, SectionTally>();
  const of = (id: string): SectionTally => {
    let e = tally.get(id);
    if (!e) tally.set(id, (e = { frames: 0, respawns: 0, camInside: 0, camUnderSea: 0, worstCam: 0 }));
    return e;
  };
  const sectionAt = (t: number): string => {
    const s = t * track.length;
    for (const sec of track.sections) if (s >= sec.start && s < sec.end) return sec.id;
    return track.sections[track.sections.length - 1].id;
  };

  ctx.on("race:respawn", ((p: { racer?: number }) => {
    if (p?.racer !== player.id) return;
    of(sectionAt(player.t)).respawns++;
  }) as never);

  let time = 0;
  const steps = Math.round(240 / FIXED_DT);
  for (let n = 0; n < steps; n++) {
    time += FIXED_DT;
    ctx.elapsed = time;
    ctx.input.accel = 1;
    ctx.input.brake = 0;
    // Two incommensurable periods, so the sawing never lines up with the
    // course and every corner is met with a different amount of nonsense.
    ctx.input.steer = 0.85 * Math.sin(time * 1.7) + 0.45 * Math.sin(time * 0.41);
    ctx.input.drift = Math.sin(time * 0.9) > 0.5;
    ctx.input.driftPressed = ctx.input.drift;
    for (const s of systems) s.fixedUpdate?.(FIXED_DT, ctx);
    for (const s of systems) s.lateUpdate?.(FIXED_DT, ctx);

    const e = of(sectionAt(player.t));
    e.frames++;
    const cam = ctx.camera.position;
    const depth = track.ground.height(cam.x, cam.z) - cam.y;
    if (depth > 0.05) {
      e.camInside++;
      e.worstCam = Math.max(e.worstCam, depth);
    }
    if (cam.y < track.seaLevel + 0.2) e.camUnderSea++;
  }

  const rows = track.sections
    .map((sec) => ({ id: sec.id, ...(tally.get(sec.id) ?? { frames: 0, respawns: 0, camInside: 0, camUnderSea: 0, worstCam: 0 }) }))
    .filter((r) => r.frames > 0);

  it("survives four minutes of a bad driver", () => {
    const noisy = rows
      .filter((r) => r.respawns || r.camInside || r.camUnderSea)
      .map((r) => `${r.id.padEnd(13)} respawns ${r.respawns}  camInside ${r.camInside} (worst ${r.worstCam.toFixed(1)}m)  camUnderSea ${r.camUnderSea}`);
    console.log(noisy.length ? noisy.join("\n") : "a bad driver bounces off the walls and nothing else happens");
    for (const r of rows) {
      expect(`${r.id} camInside:${r.camInside}`).toBe(`${r.id} camInside:0`);
      expect(`${r.id} camUnderSea:${r.camUnderSea}`).toBe(`${r.id} camUnderSea:0`);
    }
  }, 180000);
});

/**
 * Falling off has to *end*.
 *
 * Sunset Bluff drops away in several places — the quarry chasm, Gull Creek's
 * gully, the bay under the plating — and the recovery rule is a mixture of
 * "the surface said void", "you have been in water for most of a second" and
 * "you are 26 m below the road". A hole that satisfies none of those is a hole
 * the player sits at the bottom of, revving, until they pause and restart,
 * which is what "it glitches out here" describes from the outside.
 */
describe("falling off recovers", () => {
  const ctx = makeCtx();
  const systems: System[] = [
    createTrack(ctx) as System,
    createPhysics(ctx) as System,
  ];
  const track = ctx.services.track as KartTrackService;
  const phys = ctx.services.physics as KartPhysicsService;
  const curve = track.curve;

  const spot = (seg: string, f: number, lateral: number, rise: number): THREE.Vector3 => {
    const span = curve.spanOf(seg);
    const frame = curve.frameAtS(span.start + (span.end - span.start) * f);
    return frame.position.clone().addScaledVector(frame.right, lateral).addScaledVector(new THREE.Vector3(0, 1, 0), rise);
  };

  const holes: Array<{ name: string; at: THREE.Vector3 }> = [
    { name: "Gull Creek, under the bridge", at: spot("bridge", 0.5, 0, -11) },
    { name: "Gull Creek, downstream", at: spot("chicane2", 0.3, 24, -11) },
    { name: "the quarry chasm", at: spot("gap", 0.5, 0, -26) },
    { name: "the bay under the plating", at: spot("antigrav", 0.5, -60, -20) },
    { name: "beside the Bay Viaduct", at: spot("agExit", 0.5, 0, -18) },
  ];

  const player = phys.player;
  const stuck: string[] = [];

  for (const hole of holes) {
    player.position.copy(hole.at);
    player.velocity.set(0, 0, 0);
    phys.setControls(player.id, { accel: 1, brake: 0, steer: 0, drift: false });
    let recovered = -1;
    let surface = player.surface;
    // Eight seconds: the respawn choreography is under two, so anything that
    // has not started by then is not going to.
    const frames = Math.round(8 / FIXED_DT);
    for (let n = 0; n < frames; n++) {
      ctx.elapsed += FIXED_DT;
      for (const s of systems) s.fixedUpdate?.(FIXED_DT, ctx);
      if (n === 30) surface = player.surface;
      if (player.respawning) {
        recovered = n * FIXED_DT;
        break;
      }
    }
    if (recovered < 0) stuck.push(`${hole.name}: never respawned (surface "${surface}", y ${player.position.y.toFixed(1)})`);
    else if (recovered > 2.5) stuck.push(`${hole.name}: took ${recovered.toFixed(1)}s to respawn`);
  }

  it("never leaves the kart at the bottom of a hole", () => {
    if (stuck.length) console.log(stuck.join("\n"));
    expect(stuck).toEqual([]);
  }, 180000);
});
