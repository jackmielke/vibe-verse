/**
 * The ring tram, and the thing this engine did not have until it had one: a
 * deck that carries its passenger sideways.
 *
 * A lift is easy. `flight.ts` looks support up from `prevY + CLIMB`, so a
 * floor that has risen under a body picks it up for free and `spire.ts`'s car
 * is a `Deck` whose `y` changes and nothing else. A tram is not easy, because
 * support is looked up **by XZ** and a floor that slides out from under a body
 * leaves that body standing in the air where the tram used to be.
 *
 * So most of this file is about one boolean: is this body standing on that
 * moving deck, or merely near it. Both answers are cheap to get wrong and only
 * one of them is cheap to be wrong about. A body carried too little falls off
 * a tram, which is visible, embarrassing and survivable. A body carried too
 * much is glued to a frame it is not standing in and gets dragged through a
 * building — so there are more tests here for the second than for the first.
 *
 * The step order matters and is not arbitrary: `world.ts` steps the body and
 * *then* updates the systems, so the body is always standing on the tram as it
 * was one frame ago. Every loop below does the same, because a test that
 * updates the tram first is testing a world that does not exist.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildTraffic } from "@/empyrean/traffic";
import { buildCollision, type CollisionWorld } from "@/empyrean/collide";
import { CLIMB, makeFlyer, stepFlyer, jump, type FlyerWorld } from "@/empyrean/flight";
import { surfaceAt, RING_R } from "@/empyrean/cityplan";
import { ISLAND_Y, KILL_Y, SPAWN } from "@/empyrean/config";
import type { FrameContext } from "@/empyrean/types";

/**
 * The two frame times this engine actually produces.
 *
 * 1/60 is a machine keeping up. 0.05 is the clamp in `world.ts` and
 * `stepFlyer`, which is what every frame gets the moment the machine is not
 * keeping up — and under the software rasteriser this world is checked on,
 * that is every frame, all the time. Every test in this file originally ran
 * only at 1/60, which is a frame rate this container has never once achieved.
 */
const DTS = [1 / 60, 0.05] as const;
const DT = 1 / 60;

function makeCtx(dt = DT): FrameContext {
  const camera = new THREE.PerspectiveCamera(58, 1.6, 0.35, 22000);
  camera.position.set(SPAWN.x, SPAWN.y + 4, SPAWN.z + 8);
  return {
    time: 0,
    dt,
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
    gradeDaylight: 1,
    camRadiusSq: 0,
  };
}

/**
 * A traffic system, a collision world built over its frames, and a body.
 *
 * No buildings and no props: the tram runs on a ring road with nothing on it,
 * so the only static geometry that matters is the ground, which `surfaceAt`
 * provides without anything being built.
 */
function rig(dt: number = DT) {
  const traffic = buildTraffic({ quality: "high", seedSalt: "test" });
  const collision: CollisionWorld = buildCollision([], [], traffic.frames);
  const ctx = makeCtx(dt);
  const flyWorld: FlyerWorld = {
    supportAt: (x, z, fromY) => collision.supportAt(x, z, fromY),
    blockedAt: (x, z, y) => collision.blockedAt(x, z, y),
    blockedStaticAt: (x, z, y) => collision.blockedStaticAt(x, z, y),
    carryAt: (x, z, y, out) => collision.carryAt(x, z, y, out),
    pushOutAt: (x, z, y, pad, out) => collision.pushOutAt(x, z, y, pad, out),
    killY: KILL_Y,
    spawn: SPAWN,
  };
  const body = makeFlyer(SPAWN);
  // The body is the player, so the system sees it where the engine would.
  ctx.player.position = body.position;
  ctx.player.velocity = body.velocity;
  const still = { forward: 0, strafe: 0, run: false, jet: false, camYaw: 0 };
  /** One frame of the world, in the engine's own order. */
  const frame = (input: Partial<typeof still> = {}) => {
    stepFlyer(body, { ...still, ...input }, flyWorld, dt);
    ctx.time += dt;
    traffic.update?.(ctx);
  };
  /** Spin the world without a body in it. */
  const idle = (n: number) => {
    for (let i = 0; i < n; i++) {
      ctx.time += dt;
      traffic.update?.(ctx);
    }
  };
  /** Seconds of world time, in frames. */
  const secs = (t: number) => Math.round(t / dt);
  return { traffic, collision, flyWorld, body, ctx, frame, idle, dt, secs };
}

/** Where a world point falls in the front car's own frame. */
function inCar(t: { x: number; z: number; yaw: number }, x: number, z: number) {
  const dx = x - t.x;
  const dz = z - t.z;
  const c = Math.cos(t.yaw);
  const s = Math.sin(t.yaw);
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

/** A world point from a point in the front car's frame. */
function fromCar(t: { x: number; z: number; yaw: number }, lx: number, lz: number) {
  const c = Math.cos(t.yaw);
  const s = Math.sin(t.yaw);
  return { x: t.x + lx * c + lz * s, z: t.z - lx * s + lz * c };
}

/** Run until a predicate holds, or blow up saying it never did. */
function until(idle: (n: number) => void, what: string, ok: () => boolean, cap = 60 * 200) {
  for (let i = 0; i < cap; i++) {
    if (ok()) return i;
    idle(1);
  }
  throw new Error(`never happened: ${what}`);
}

describe("the tram is a place you can stand", () => {
  it("puts the platform one walkable step from the road and from the car floor", () => {
    /* The whole of boarding is two steps, and both have to be under CLIMB or
       the step-up never finds the next surface and the tram is scenery. This
       is the assertion that catches somebody retuning the platform height or
       the car's floor without checking the other. */
    const { traffic, collision, idle } = rig();
    idle(1);
    const stop = traffic.stops[0];
    const road = surfaceAt(stop.x, stop.z);
    const platform = collision.supportAt(stop.x, stop.z, 1e4);

    expect(road.kind).toBe("road");
    expect(platform).toBeGreaterThan(road.y);
    expect(platform - road.y).toBeLessThan(CLIMB);

    until(idle, "the tram to stand at a stop", () => traffic.tram.atStop === stop.id);
    const t = traffic.tram;
    const floor = collision.supportAt(t.x, t.z, 1e4);
    expect(floor).toBeGreaterThan(platform);
    expect(floor - platform).toBeLessThan(CLIMB);
    // And the floor really is the car's, not the road under it.
    expect(floor - road.y).toBeGreaterThan(0.8);
    traffic.dispose();
  });

  it("carries a body that is standing on it", () => {
    const { traffic, body, frame, idle } = rig();
    idle(1);
    const t = traffic.tram;
    // Put the body in the middle of the leading car and let go of it.
    body.position.set(t.x, t.y + 1.2, t.z);
    body.velocity.set(0, 0, 0);

    const startX = body.position.x;
    const startZ = body.position.z;
    let worstLocalZ = 0;
    let worstLocalX = 0;
    let carriedFrames = 0;
    let travelled = 0;
    let px = body.position.x;
    let pz = body.position.z;

    for (let f = 0; f < 60 * 100; f++) {
      frame();
      travelled += Math.hypot(body.position.x - px, body.position.z - pz);
      px = body.position.x;
      pz = body.position.z;
      if (f < 30) continue; // let it settle onto the floor
      const l = inCar(t, body.position.x, body.position.z);
      worstLocalZ = Math.max(worstLocalZ, Math.abs(l.z));
      worstLocalX = Math.max(worstLocalX, Math.abs(l.x));
      if (body.carried) carriedFrames++;
    }

    /* A whole lap of a 1370 m ring, which is the point: it is not a lift with
       a longer shaft, it is a body that has been round the city. */
    expect(travelled).toBeGreaterThan(1200);
    // Still in the car it started in, at the end of a lap.
    expect(Math.abs(inCar(t, body.position.x, body.position.z).z)).toBeLessThan(5);
    expect(body.grounded).toBe(true);
    expect(body.carried).toBe(true);
    /* Never left the car, and these two bounds are tight on purpose.
     *
     * Fore and aft there is real sway, and it is meant to be there: the carry
     * is one frame behind the tram's own acceleration, so a passenger drifts
     * back under power and forward under braking, exactly like a passenger.
     * It peaks near a metre and returns.
     *
     * Sideways there must be nothing at all, and that is the assertion that
     * earns its place. Both of the ways this was got wrong showed up here and
     * nowhere else: publishing the carry velocity from the lane's
     * interpolated heading rather than from the motion the car actually made
     * (7 mm a frame outward, on the roadway in three seconds), and rotating
     * the passenger about the pivot without rotating the carry vector with
     * them (0.7 mm a frame, out through the side of the car in a minute).
     * Neither is visible in a still, both pass every other test in this file,
     * and a loose bound here would have shipped both. */
    expect(worstLocalZ).toBeLessThan(1.6);
    expect(worstLocalX).toBeLessThan(0.15);
    expect(carriedFrames).toBeGreaterThan(60 * 90);
    // And it did not simply teleport to the tram: it went the long way round.
    expect(Math.hypot(body.position.x - startX, body.position.z - startZ)).toBeLessThan(60);
    traffic.dispose();
  });

  it("does not carry a body standing beside it on the platform", () => {
    /* The failure this is here for is the one that is worse than falling
       through a tram: a deck that claims more ground than it has. Somebody
       waiting on the platform is 15 cm from a car doing 30 m/s and must not
       move a millimetre when it goes past. */
    const { traffic, body, frame, idle } = rig();
    idle(1);
    const stop = traffic.stops[1];
    // A metre in from the platform's outer edge, which is as close to the
    // track as a person can stand.
    const a = Math.atan2(stop.z, stop.x);
    const r = Math.hypot(stop.x, stop.z) + 3.2;
    body.position.set(Math.cos(a) * r, stop.y + 0.5, Math.sin(a) * r);
    body.velocity.set(0, 0, 0);
    for (let i = 0; i < 40; i++) frame();

    const restX = body.position.x;
    const restZ = body.position.z;
    let sawTramPass = false;
    let moved = 0;
    for (let f = 0; f < 60 * 120; f++) {
      frame();
      moved = Math.max(moved, Math.hypot(body.position.x - restX, body.position.z - restZ));
      if (Math.hypot(traffic.tram.x - restX, traffic.tram.z - restZ) < 12) sawTramPass = true;
    }
    expect(sawTramPass).toBe(true);
    expect(moved).toBeLessThan(0.02);
    expect(body.grounded).toBe(true);
    traffic.dispose();
  });

  it("does not carry a body in the air over it, or on the road under it", () => {
    const { traffic, collision, idle } = rig();
    idle(1);
    const t = traffic.tram;
    const out = { x: 0, y: 0, z: 0, w: 0, px: 0, pz: 0 };
    const floor = collision.supportAt(t.x, t.z, 1e4);

    // On the floor: carried.
    expect(collision.carryAt(t.x, t.z, floor, out)).toBe(true);
    // Head height above the floor: not carried. `carryAt` answers for the
    // supporting deck and nothing else, which is what stops a jump becoming a
    // free ride.
    expect(collision.carryAt(t.x, t.z, floor + 1.4, out)).toBe(false);
    // On the road under it: not carried.
    expect(collision.carryAt(t.x, t.z, ISLAND_Y - 0.16, out)).toBe(false);
    // Three metres to the side at floor height, which is over open roadway.
    const side = fromCar(t, 3.4, 0);
    expect(collision.carryAt(side.x, side.z, floor, out)).toBe(false);
    // And just past the end of the car, over the coupling gap.
    const past = fromCar(t, 0, -6.4);
    expect(collision.carryAt(past.x, past.z, floor, out)).toBe(false);
    traffic.dispose();
  });

  it("does not claim the roadway beside an oblique platform", () => {
    /* The reason the platforms are frames rather than decks in the grid.
       Two of the four sit at 45 degrees, and an oblique rectangle indexed by
       its bounding box reports solid platform over several metres of open
       road — which is a body standing on nothing, a metre in the air, beside
       a tram stop. It is invisible in a still and it is the exact shape of
       the tapering-spire bug this world already paid for once. */
    const { traffic, collision, idle } = rig();
    idle(1);
    const stop = traffic.stops.find((s) => s.id === "market")!;
    const a = Math.atan2(stop.z, stop.x);
    // 45 degrees, or this test is testing nothing.
    expect(Math.abs(Math.abs(a) % (Math.PI / 2))).toBeGreaterThan(0.3);

    const deckY = collision.supportAt(stop.x, stop.z, 1e4);
    expect(deckY).toBeGreaterThan(ISLAND_Y);

    /* The far corner of the slab, and then eight metres further along the
       tangent — inside the axis-aligned box of the rotated rectangle, well
       outside the rectangle. */
    const tx = -Math.sin(a);
    const tz = Math.cos(a);
    const ox = Math.cos(a);
    const oz = Math.sin(a);
    const cornerX = stop.x + tx * 8.0 + ox * 4.2;
    const cornerZ = stop.z + tz * 8.0 + oz * 4.2;
    expect(collision.supportAt(cornerX, cornerZ, 1e4)).toBeCloseTo(deckY, 3);

    const offX = cornerX + tx * 9.0;
    const offZ = cornerZ + tz * 9.0;
    const off = collision.supportAt(offX, offZ, 1e4);
    expect(off).toBeLessThan(deckY - 0.3);
    expect(off).toBeCloseTo(surfaceAt(offX, offZ).y, 3);
    traffic.dispose();
  });

  it("stops with every one of its doors over a platform", () => {
    /* A three-car train is 35 m long and stops with its *leading* car at the
       stop, so a platform centred on the stopping point and as long as one
       car has four of its five doorways opening onto the carriageway. That is
       a door inviting you out onto a road, half a metre down, and it is
       exactly the sort of thing that looks completely fine from the front of
       the train. */
    const { traffic, collision, idle } = rig();
    idle(1);
    until(idle, "the tram to stand at a stop", () => traffic.tram.stopped && traffic.tram.doorsOpen);
    const t = traffic.tram;
    const floor = collision.supportAt(t.x, t.z, 1e4);
    const CAR_GAP = 11.6;
    for (let car = 0; car < 3; car++) {
      // The doorway of each car: on the inner side, in the middle, at floor
      // height. The cars are strung out behind the leading one along the ring,
      // so this walks back round the circle rather than along a straight line.
      const a0 = Math.atan2(t.z, t.x);
      const a = a0 - (car * CAR_GAP) / RING_R[1];
      const doorR = RING_R[1] - 1.45 - 0.4;
      const dx = Math.cos(a) * doorR;
      const dz = Math.sin(a) * doorR;
      const under = collision.supportAt(dx, dz, floor);
      expect(under, `car ${car} opens onto nothing`).toBeGreaterThan(ISLAND_Y + 0.2);
      expect(under, `car ${car} opens onto the roadway`).toBeLessThan(floor);
    }
    traffic.dispose();
  });

  it("keeps its doors shut and its doorway solid whenever it is moving", () => {
    /* A door that is only a picture is a player stepping out of a moving tram
       at 12 m/s, and the first version of this did exactly that. */
    const { traffic, collision, idle } = rig();
    idle(1);
    let openWhileMoving = 0;
    let unblockedWhileMoving = 0;
    let openAtAStop = 0;
    let passableAtAStop = 0;
    let lastX = traffic.tram.x;
    let lastZ = traffic.tram.z;

    for (let f = 0; f < 60 * 200; f++) {
      idle(1);
      const t = traffic.tram;
      const speed = Math.hypot(t.x - lastX, t.z - lastZ) / DT;
      lastX = t.x;
      lastZ = t.z;
      // The middle of the inner doorway, at floor height.
      const floor = t.y + 0.74;
      const door = fromCar(t, 1.45, 0);
      const blocked = collision.blockedAt(door.x, door.z, floor);
      if (speed > 1.5) {
        if (t.doorsOpen) openWhileMoving++;
        if (!blocked) unblockedWhileMoving++;
      }
      if (t.stopped && t.doorsOpen) {
        openAtAStop++;
        if (!blocked) passableAtAStop++;
      }
    }
    expect(openWhileMoving).toBe(0);
    expect(unblockedWhileMoving).toBe(0);
    // And it does open, for long enough to walk through.
    expect(openAtAStop).toBeGreaterThan(60 * 3);
    expect(passableAtAStop).toBe(openAtAStop);
    traffic.dispose();
  });

  it("only offers to board while it is standing there with the doors open", () => {
    const { traffic, idle } = rig();
    idle(1);
    const hits = traffic.interactables();
    expect(hits.length).toBe(traffic.stops.length);
    for (const h of hits) expect(h.enabled).toBeTypeOf("function");

    let offeredWrongly = 0;
    let offered = 0;
    const seen = new Set<string>();
    for (let f = 0; f < 60 * 200; f++) {
      idle(1);
      const t = traffic.tram;
      for (let i = 0; i < hits.length; i++) {
        const on = hits[i].enabled!();
        if (!on) continue;
        offered++;
        seen.add(traffic.stops[i].id);
        if (!t.stopped || !t.doorsOpen || t.atStop !== traffic.stops[i].id) offeredWrongly++;
      }
    }
    expect(offeredWrongly).toBe(0);
    expect(offered).toBeGreaterThan(0);
    // Every platform, over two laps — not just the one it happens to start at.
    expect(seen.size).toBe(traffic.stops.length);
    traffic.dispose();
  });

  it("lets you board from the platform, ride a lap, and be there at the end", () => {
    /* The end-to-end one, and the only test in this file that would have
       caught "you can stand on it for two seconds and then fall through".
       Ninety seconds is not a figure of speech here. */
    const { traffic, collision, body, frame, idle } = rig();
    idle(1);
    const stop = traffic.stops[0];
    const a = Math.atan2(stop.z, stop.x);
    const r = Math.hypot(stop.x, stop.z) + 3.0;
    body.position.set(Math.cos(a) * r, stop.y, Math.sin(a) * r);
    body.velocity.set(0, 0, 0);

    // Wait on the platform for it to come in.
    let waited = 0;
    while (!(traffic.tram.atStop === stop.id && traffic.tram.doorsOpen) && waited < 60 * 200) {
      frame();
      waited++;
    }
    expect(waited).toBeLessThan(60 * 200);
    expect(body.grounded).toBe(true);

    // Board with the prompt, which is the same deck a walk through the door
    // would have put you on.
    const hit = traffic.interactables()[0];
    expect(hit.enabled!()).toBe(true);
    hit.activate();
    frame();
    expect(body.carried).toBe(true);

    const seen = new Set<string>();
    let offDeck = 0;
    let turned = 0;
    let last = Math.atan2(body.position.z, body.position.x);
    for (let f = 0; f < 60 * 200 && Math.abs(turned) < Math.PI * 2; f++) {
      frame();
      const t = traffic.tram;
      if (t.stopped) seen.add(t.atStop);
      if (!body.carried || !body.grounded) offDeck++;
      const now = Math.atan2(body.position.z, body.position.x);
      let d = now - last;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      turned += d;
      last = now;
    }
    expect(Math.abs(turned)).toBeGreaterThanOrEqual(Math.PI * 2);
    expect(seen.size).toBe(traffic.stops.length);
    // Not one frame of the whole lap standing in mid-air.
    expect(offDeck).toBe(0);
    // Still standing on the car's floor rather than on the road below it.
    const floor = collision.supportAt(body.position.x, body.position.z, body.position.y + CLIMB);
    expect(floor).toBeGreaterThan(ISLAND_Y + 0.5);
    expect(Math.abs(body.position.y - floor)).toBeLessThan(0.05);
    expect(Math.hypot(body.position.x, body.position.z)).toBeGreaterThan(RING_R[1] - 6);

    // And you can get off again.
    while (!(traffic.tram.stopped && traffic.tram.doorsOpen)) frame();
    const idx = traffic.stops.findIndex((s) => s.id === traffic.tram.atStop);
    const off = traffic.interactables()[idx];
    expect(off.label).toContain("Step off");
    off.activate();
    for (let i = 0; i < 90; i++) frame();
    expect(body.grounded).toBe(true);
    expect(Math.hypot(body.position.x, body.position.z)).toBeLessThan(RING_R[1] - 2);
    traffic.dispose();
  }, 60000);

  it("stops carrying you the moment you jump, and does not fling you when you land", () => {
    /* Mid-air is not carried, and that is the design and not an omission: you
       land where physics puts you, which on a moving tram is nearer the back.
       The thing that must never happen is the other one — the carry going
       into the body's velocity, so that stepping off a tram at 30 m/s fires
       you across the city. */
    const { traffic, body, frame, idle } = rig();
    idle(1);
    until(idle, "the tram to be running", () => !traffic.tram.stopped);
    idle(120);
    const t = traffic.tram;
    body.position.set(t.x, t.y + 1.2, t.z);
    body.velocity.set(0, 0, 0);
    for (let i = 0; i < 40; i++) frame();
    expect(body.carried).toBe(true);

    const before = inCar(t, body.position.x, body.position.z).z;
    jump(body);
    let airborneCarried = 0;
    let topSpeed = 0;
    for (let i = 0; i < 120; i++) {
      frame();
      if (!body.grounded && body.carried) airborneCarried++;
      topSpeed = Math.max(topSpeed, Math.hypot(body.velocity.x, body.velocity.z));
    }
    expect(airborneCarried).toBe(0);
    // The body's own velocity never picked up the tram's 30 m/s.
    expect(topSpeed).toBeLessThan(2);
    // And it landed further back down the car than it left.
    const after = inCar(t, body.position.x, body.position.z).z;
    expect(after).toBeGreaterThan(before + 0.5);
    traffic.dispose();
  });

  it("publishes a seat for every place there is to sit, and moves them with it", () => {
    /* Not used by anything yet. `crowd.ts` is a different system and may not
       import this one, so the only way a pedestrian ever sits on the tram is
       if the tram says where its seats are — and the only way that is true
       when it matters is if it is true now. */
    const { traffic, idle } = rig();
    idle(1);
    const seats = traffic.seats;
    expect(seats.length).toBe(36);
    const first = { x: seats[0].x, z: seats[0].z };
    for (const s of seats) {
      expect(Number.isFinite(s.x)).toBe(true);
      expect(s.y).toBeGreaterThan(ISLAND_Y);
      expect(s.y).toBeLessThan(ISLAND_Y + 3);
      const r = Math.hypot(s.x, s.z);
      expect(r).toBeGreaterThan(RING_R[1] - 3);
      expect(r).toBeLessThan(RING_R[1] + 3);
      expect(s.car).toBeGreaterThanOrEqual(0);
      expect(s.car).toBeLessThan(3);
    }
    idle(60 * 20);
    expect(Math.hypot(seats[0].x - first.x, seats[0].z - first.z)).toBeGreaterThan(50);
    traffic.dispose();
  });

  it("gives back every mesh it made", () => {
    const { traffic } = rig();
    traffic.dispose();
    expect(traffic.group.children.length).toBe(0);
  });
});

/* -------------------------------------------------------------------------
 * The frame rate this world is actually checked at
 *
 * Everything above runs at 1/60. `world.ts` clamps `dt` to 0.05 and so does
 * `stepFlyer`, and under the software rasteriser these worlds are verified on
 * the page draws well under two frames a second — so 0.05 is not the unusual
 * case, it is every frame. Sixty hertz was the frame rate none of this had
 * ever been run at.
 *
 * It matters here more than in most systems because the tram's whole state
 * machine is a countdown against `dt`, its arrival test is a distance
 * threshold crossed in one step, and the carry is a per-step displacement:
 * all three are things a twenty-times-longer step can walk straight over.
 * ---------------------------------------------------------------------- */
describe.each(DTS)("at dt = %f", (dt) => {
  it("departs on the same schedule whether or not anybody boards", () => {
    /* The failure this exists for was reported as "the tram never departs
       once you are aboard", and it was not real — the world was running at
       0.6 frames a second, so a seven-second dwell was four real minutes and
       the observer stopped twenty seconds early. It cost a bug report and an
       afternoon, and the reason it was even plausible is that nothing
       anywhere asserted the obvious thing: a passenger is a passenger, and
       the timetable is not theirs to change. Now something does. */
    const departures = (withPassenger: boolean) => {
      const { traffic, body, frame, idle, secs } = rig(dt);
      idle(1);
      const stop = traffic.stops.find((s) => s.id === traffic.tram.atStop)!;
      const idx = traffic.stops.indexOf(stop);
      /* Both runs burn the same frames before the clock starts, or the
         comparison is measuring the settle and not the timetable. */
      const a = Math.atan2(stop.z, stop.x);
      const r = Math.hypot(stop.x, stop.z) + 3.0;
      body.position.set(Math.cos(a) * r, stop.y, Math.sin(a) * r);
      body.velocity.set(0, 0, 0);
      for (let i = 0; i < secs(1); i++) frame();
      if (withPassenger) {
        const hit = traffic.interactables()[idx];
        expect(hit.enabled!()).toBe(true);
        hit.activate();
      }
      const out: number[] = [];
      let was = traffic.tram.stopped;
      for (let f = 0; f < secs(150) && out.length < 5; f++) {
        frame();
        if (was && !traffic.tram.stopped) out.push(Math.round((f * dt) * 100) / 100);
        was = traffic.tram.stopped;
      }
      const carried = withPassenger ? body.carried : null;
      traffic.dispose();
      return { out, carried };
    };
    const alone = departures(false);
    const laden = departures(true);
    expect(laden.out.length).toBe(5);
    expect(laden.out).toEqual(alone.out);
    // And it really did have somebody on it the whole way.
    expect(laden.carried).toBe(true);
  }, 60000);

  it("carries a passenger a whole lap, at this frame time too", () => {
    const { traffic, body, frame, idle, secs } = rig(dt);
    idle(1);
    const t = traffic.tram;
    body.position.set(t.x, t.y + 1.2, t.z);
    body.velocity.set(0, 0, 0);
    for (let i = 0; i < secs(1); i++) frame();

    let offDeck = 0;
    let worstX = 0;
    let turned = 0;
    let last = Math.atan2(body.position.z, body.position.x);
    for (let f = 0; f < secs(200) && Math.abs(turned) < Math.PI * 2; f++) {
      frame();
      if (!body.carried || !body.grounded) offDeck++;
      worstX = Math.max(worstX, Math.abs(inCar(t, body.position.x, body.position.z).x));
      const now = Math.atan2(body.position.z, body.position.x);
      let d = now - last;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      turned += d;
      last = now;
    }
    expect(Math.abs(turned)).toBeGreaterThanOrEqual(Math.PI * 2);
    expect(offDeck).toBe(0);
    expect(worstX).toBeLessThan(0.2);
    traffic.dispose();
  }, 60000);

  it("shoves you out of a door that is closing on you, rather than pinning you in it", () => {
    /* A 0.6 m body against a 0.14 m door is a 1.48 m exclusion band, and the
       band *arrives*. A body already inside one cannot walk out of it: every
       step it can take is still inside, all three of `stepFlyer`'s slide
       tests fail, and it sits there frozen — which is both miserable and
       indistinguishable, from outside, from a tram that has stopped working.
       Nothing static in this world can do that to you, because a building
       does not pull up next to you. */
    const { traffic, collision, body, frame, idle, secs } = rig(dt);
    idle(1);
    const t = traffic.tram;
    // The doors take about a second to open; there is no doorway before that.
    until(idle, "the doors to open", () => traffic.tram.doorsOpen);
    // Standing in the doorway: on the deck, hard up against the open door.
    const inDoor = fromCar(t, 1.35, 0);
    body.position.set(inDoor.x, t.y + 0.76, inDoor.z);
    body.velocity.set(0, 0, 0);
    frame();

    // Run until the doors are shut and it has pulled away.
    for (let f = 0; f < secs(40) && (traffic.tram.stopped || traffic.tram.doorsOpen); f++) frame();
    expect(traffic.tram.doorsOpen).toBe(false);

    // Inside the car, off the door, and still on the train.
    const local = inCar(traffic.tram, body.position.x, body.position.z);
    expect(local.x).toBeLessThan(0.7);
    expect(local.x).toBeGreaterThan(-1.6);
    expect(body.carried).toBe(true);
    expect(collision.blockedAt(body.position.x, body.position.z, body.position.y)).toBe(false);

    // And not merely repositioned — able to move under its own power again.
    const before = inCar(traffic.tram, body.position.x, body.position.z);
    for (let i = 0; i < secs(0.6); i++) frame({ forward: 1, camYaw: traffic.tram.yaw });
    const after = inCar(traffic.tram, body.position.x, body.position.z);
    expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeGreaterThan(0.5);
    traffic.dispose();
  }, 60000);

  it("nudges somebody off the platform edge instead of freezing them there", () => {
    /* Same band, arriving the other way round: the platform stops fifteen
       centimetres from the car, so anybody standing on its edge is inside the
       tram's exclusion band the moment one pulls in. They should be moved a
       step back onto their own platform, not pinned to it. */
    const { traffic, collision, body, frame, idle, secs } = rig(dt);
    idle(1);
    const stop = traffic.stops.find((s) => s.id === "market")!;
    const a = Math.atan2(stop.z, stop.x);
    // The outermost standable point on the platform: its edge, by the track.
    const r = RING_R[1] - 1.62;
    body.position.set(Math.cos(a) * r, stop.y + 0.3, Math.sin(a) * r);
    body.velocity.set(0, 0, 0);
    for (let i = 0; i < secs(1); i++) frame();
    expect(body.grounded).toBe(true);

    // Wait for the train to pull in on top of them.
    let arrived = false;
    for (let f = 0; f < secs(200) && !arrived; f++) {
      frame();
      arrived = traffic.tram.atStop === "market";
    }
    expect(arrived).toBe(true);
    for (let i = 0; i < secs(1); i++) frame();

    // Standing clear, on the platform, and free to walk.
    expect(body.grounded).toBe(true);
    expect(collision.blockedAt(body.position.x, body.position.z, body.position.y)).toBe(false);
    expect(Math.hypot(body.position.x, body.position.z)).toBeLessThan(r);
    expect(body.position.y).toBeCloseTo(stop.y, 2);
    const before = [body.position.x, body.position.z];
    for (let i = 0; i < secs(0.6); i++) frame({ forward: 1, camYaw: a + Math.PI / 2 });
    expect(Math.hypot(body.position.x - before[0], body.position.z - before[1])).toBeGreaterThan(0.5);
    traffic.dispose();
  }, 60000);
});

describe("the tram, from outside the world", () => {
  it("says how long it is standing there for", () => {
    /* The single number whose absence turned a working tram into a bug
       report. A stopped tram and a broken tram look the same; this is what
       tells them apart, and under a rasteriser that runs the world at a
       fiftieth of real time it is the difference between "wait four minutes"
       and "something is wrong". */
    const { traffic, idle } = rig();
    idle(1);
    expect(traffic.tram.stopped).toBe(true);
    const first = traffic.tram.dwell;
    expect(first).toBeGreaterThan(0);
    idle(120);
    expect(traffic.tram.dwell).toBeLessThan(first);
    until(idle, "the tram to leave", () => !traffic.tram.stopped);
    expect(traffic.tram.dwell).toBe(0);
    until(idle, "the tram to arrive somewhere", () => traffic.tram.stopped);
    expect(traffic.tram.dwell).toBeGreaterThan(0);
    traffic.dispose();
  }, 60000);
});
