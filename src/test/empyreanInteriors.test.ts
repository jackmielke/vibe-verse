/**
 * The Empyrean's interiors, checked for the one thing a screenshot cannot
 * check: that you can get in.
 *
 * A room whose door is covered by its own collision is the classic failure
 * here — it builds, it renders, it photographs beautifully, and the player
 * bounces off the doorway and walks away. So the interesting assertions in
 * this file are the boring ones: walk the straight line from the pavement to
 * the middle of every room, at body height, against the very same blocker
 * arithmetic `world.ts` runs, and fail if anything is in the way.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ISLAND_Y } from "@/empyrean/config";
import { cityPlan, walkableAt, LANDMARKS, type Lot, type Vec2 } from "@/empyrean/cityplan";
import { BODY_R, CLIMB, makeFlyer, stepFlyer } from "@/empyrean/flight";
import { buildCollision } from "@/empyrean/collide";
import { SUN_DIR } from "@/empyrean/sky";
import { spirePlan, type SpirePlan } from "@/empyrean/spire";
import {
  buildInteriors,
  interiorPlan,
  type Blocker,
  type InteriorInfo,
} from "@/empyrean/interiors";
import type { FrameContext } from "@/empyrean/types";

const plan = interiorPlan();

/** The check `world.ts` makes, copied verbatim so this test fails with it. */
function blocked(blockers: Blocker[], x: number, y: number, z: number): Blocker | null {
  for (const b of blockers) {
    if (y >= b.top - 0.15 || y < b.bottom - 0.15) continue;
    if (Math.abs(x - b.x) <= b.hx + BODY_R && Math.abs(z - b.z) <= b.hz + BODY_R) return b;
  }
  return null;
}

/** Room-local (x across, z out through the door) → world. */
function toWorld(info: InteriorInfo, lx: number, lz: number): { x: number; z: number } {
  const s = Math.sin(info.yaw);
  const c = Math.cos(info.yaw);
  return { x: info.x + lx * s + lz * c, z: info.z - lx * c + lz * s };
}

function pointInPoly(p: { x: number; z: number }, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** The tower's own frame (x across, z out through the front door) → world. */
function spireToWorld(sp: SpirePlan, lx: number, lz: number): { x: number; z: number } {
  const s = Math.sin(sp.yaw);
  const c = Math.cos(sp.yaw);
  return { x: sp.x + lx * s + lz * c, z: sp.z - lx * c + lz * s };
}

function inLocalPoly(p: { x: number; z: number }, poly: { x: number; z: number }[]): boolean {
  return pointInPoly(p, poly as Vec2[]);
}

/** How wide a lot's shopfront is, which is what decides if a lobby will fit. */
function frontWidthOf(lot: Lot): number {
  const a = lot.poly[lot.frontEdge];
  const b = lot.poly[(lot.frontEdge + 1) % lot.poly.length];
  return Math.hypot(b.x - a.x, b.z - a.z);
}

/** Where the car floor is right now, in the tower's own frame. */
function carFloor(built: ReturnType<typeof buildInteriors>): number {
  const car = built.interactables().find((h) => h.id === "spire-car")!;
  return car.y - ISLAND_Y - 1.0;
}

function frame(x: number, y: number, z: number): FrameContext {
  return {
    time: 12,
    dt: 1 / 60,
    camera: new THREE.PerspectiveCamera(),
    player: {
      position: new THREE.Vector3(x, y, z),
      velocity: new THREE.Vector3(),
      yaw: 0,
      grounded: true,
      burn: 0,
      altitude: 0,
    },
    quality: "high",
    dayPhase: 0.75,
    sunDir: new THREE.Vector3(-0.62, 0.085, -0.78).normalize(),
    daylight: 0.5,
    gradeDaylight: 1,
    camRadiusSq: x * x + z * z,
  };
}

describe("empyrean interiors — the plan", () => {
  it("names nine rooms, each once", () => {
    expect(plan.length).toBe(9);
    expect(new Set(plan.map((r) => r.id)).size).toBe(9);
    for (const r of plan) {
      expect(r.name.length).toBeGreaterThan(3);
      expect(r.y).toBe(ISLAND_Y);
    }
  });

  it("keeps every landmark room inside the clearance the plan reserved", () => {
    const anchored = plan.filter((r) => r.landmark);
    expect(anchored.length).toBe(3);
    for (const r of anchored) {
      const l = LANDMARKS.find((k) => k.id === r.landmark);
      expect(l, `landmark ${r.landmark}`).toBeTruthy();
      const off = Math.hypot(r.x - l!.x, r.z - l!.z);
      // Centre on the landmark, and the furthest corner still inside `clear`.
      expect(off).toBeLessThan(0.001);
      expect(off + r.extent).toBeLessThanOrEqual(l!.clear);
    }
  });

  it("faces every opening the way its landmark does", () => {
    for (const r of plan.filter((k) => k.landmark)) {
      const l = LANDMARKS.find((k) => k.id === r.landmark)!;
      expect(Math.cos(r.yaw - l.yaw)).toBeGreaterThan(0.9999);
    }
  });

  it("faces every lot room out of its own shopfront, and stands inside the lot", () => {
    const lots = cityPlan().lots;
    const onLots = plan.filter((r) => r.lot);
    expect(onLots.length).toBe(6);
    // And no two of them on the same one, which is the failure mode of a rule
    // like "the nearest gardens shop" once two rooms both want one.
    expect(new Set(onLots.map((r) => r.lot)).size).toBe(6);
    for (const r of onLots) {
      const lot = lots.find((l) => l.id === r.lot);
      expect(lot, `lot ${r.lot}`).toBeTruthy();
      const dot =
        Math.cos(r.yaw) * lot!.frontNormal.x + Math.sin(r.yaw) * lot!.frontNormal.z;
      expect(dot).toBeGreaterThan(0.999);
      // All four corners of the room inside the lot it claims.
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        const p = toWorld(r, sx * r.hx, sz * r.hz);
        expect(pointInPoly(p, lot!.poly), `${r.id} corner ${sx},${sz}`).toBe(true);
      }
    }
  });

  it("gives every room a door you can walk through without aiming", () => {
    for (const r of plan) {
      expect(r.openWidth, r.id).toBeGreaterThanOrEqual(2.5);
      // The doorstep is outside the room, on the far side of the opening.
      const d = Math.hypot(r.doorstep.x - r.x, r.doorstep.z - r.z);
      expect(d).toBeGreaterThan(r.hz);
    }
  });
});

describe("empyrean interiors — the build", () => {
  const built = buildInteriors({ quality: "high", seedSalt: "test" });

  it("stands up, and claims only lots the plan actually has", () => {
    expect(built.name).toBe("interiors");
    expect(built.reflected).toBeFalsy();
    expect(built.blockers.length).toBeGreaterThan(40);
    expect(built.decks.length).toBeGreaterThan(10);
    const ids = cityPlan().lots.map((l) => l.id);
    // Six lot rooms — the cafe, the gallery, the flat, the glasshouse, the
    // workshop and the bath — plus the tower The Meridian stands in; see
    // `spire.ts`, and the spire suite at the bottom of this file for what
    // happens if that claim ever goes missing.
    expect(built.claimedLots.length).toBe(7);
    expect(new Set(built.claimedLots).size).toBe(7);
    for (const id of built.claimedLots) expect(ids).toContain(id);
  });

  it("spends no more than six real lights on the whole world", () => {
    let lights = 0;
    built.group.traverse((o) => {
      if ((o as THREE.Light).isLight) lights++;
    });
    expect(lights).toBeLessThanOrEqual(6);
  });

  it("draws each room in a handful of calls", () => {
    for (const info of built.rooms) {
      const rg = built.group.getObjectByName(`empyrean-interior-${info.id}`);
      expect(rg, info.id).toBeTruthy();
      let meshes = 0;
      rg!.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) meshes++;
      });
      expect(meshes, `${info.id} draws`).toBeLessThanOrEqual(8);
      expect(meshes, `${info.id} draws`).toBeGreaterThan(0);
    }
  });

  it("keeps every blocker and deck the right way up", () => {
    for (const b of built.blockers) {
      expect(b.top).toBeGreaterThan(b.bottom);
      expect(b.hx).toBeGreaterThan(0);
      expect(b.hz).toBeGreaterThan(0);
      expect(Number.isFinite(b.x) && Number.isFinite(b.z)).toBe(true);
    }
    for (const d of built.decks) {
      expect(d.y).toBeGreaterThan(ISLAND_Y - 1);
      expect(Number.isFinite(d.y)).toBe(true);
    }
  });

  /* ------------------------------------------------------------------
   * The one that matters
   * --------------------------------------------------------------- */

  it("leaves a gap in the doorway a body actually fits through", () => {
    /* Not "the opening is 4.2 m wide" — that is a number in a struct. Walk a
     * body across the threshold and measure the widest run it can stand in,
     * which is the opening minus the jambs, minus the body, minus whatever
     * the axis-aligned blocker approximation added back on. */
    for (const info of built.rooms) {
      for (const lz of [info.hz + 0.6, info.hz, info.hz - 0.6]) {
        let run = 0;
        let best = 0;
        let bestHasAxis = false;
        let hasAxis = false;
        const step = 0.05;
        for (let t = -info.openWidth; t <= info.openWidth + 1e-9; t += step) {
          const p = toWorld(info, t, lz);
          if (blocked(built.blockers, p.x, ISLAND_Y + 0.1, p.z)) {
            run = 0;
            hasAxis = false;
            continue;
          }
          run += step;
          if (Math.abs(t) < step) hasAxis = true;
          if (run > best) {
            best = run;
            bestHasAxis = hasAxis;
          }
        }
        expect(best, `${info.id}: clear doorway at z=${lz.toFixed(1)}`).toBeGreaterThanOrEqual(2.5);
        // And the gap has to be the one you walk in along, not one beside it.
        expect(bestHasAxis, `${info.id}: the clear gap is off the entry axis`).toBe(true);
      }
    }
  });

  it("lets you walk straight from the doorstep to the middle of every room", () => {
    for (const info of built.rooms) {
      const from = info.doorstep;
      const steps = Math.ceil(Math.hypot(from.x - info.x, from.z - info.z) / 0.2);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = from.x + (info.x - from.x) * t;
        const z = from.z + (info.z - from.z) * t;
        const hit = blocked(built.blockers, x, ISLAND_Y + 0.1, z);
        expect(hit, `${info.id}: walk-in obstructed ${(t * 100) | 0}% of the way`).toBe(null);
      }
    }
  });

  it("knows which room you are standing in, and which you are not", () => {
    for (const info of built.rooms) {
      expect(built.inside(info.x, ISLAND_Y + 1.2, info.z), info.id).toBe(info.id);
      // A metre inside the back wall is still inside.
      const back = toWorld(info, 0, -info.hz + 1);
      expect(built.inside(back.x, ISLAND_Y + 1.2, back.z), `${info.id} back`).toBe(info.id);
      // Ten metres out of the front door is not.
      const out = toWorld(info, 0, info.hz + 10);
      expect(built.inside(out.x, ISLAND_Y + 1.2, out.z), `${info.id} outside`).not.toBe(info.id);
      // Neither is standing on the roof.
      expect(
        built.inside(info.x, ISLAND_Y + info.height + 6, info.z),
        `${info.id} above`,
      ).toBeNull();
    }
    // The middle of the plaza is in nothing at all.
    expect(built.inside(0, ISLAND_Y + 1, 0)).toBeNull();
    expect(built.inside(0, 0, 0)).toBeNull();
  });

  it("offers something to press a key on in every room", () => {
    const hits = built.interactables();
    expect(hits.length).toBeGreaterThanOrEqual(plan.length);
    for (const info of built.rooms) {
      const mine = hits.filter(
        (h) => Math.hypot(h.x - info.x, h.z - info.z) < info.extent + 4,
      );
      expect(mine.length, `${info.id} interactables`).toBeGreaterThanOrEqual(1);
    }
    for (const h of hits) {
      expect(h.label.length).toBeGreaterThan(3);
      expect(h.radius).toBeGreaterThan(0.5);
      expect(h.y).toBeGreaterThan(ISLAND_Y);
    }
    expect(new Set(hits.map((h) => h.id)).size).toBe(hits.length);
  });

  it("routes an activation to whatever the engine gave it", () => {
    const said: string[] = [];
    built.onToast = (text) => said.push(text);
    built.interactables()[0].activate();
    expect(said.length).toBe(1);
    expect(said[0].length).toBeGreaterThan(8);
    built.onToast = null;
    built.interactables()[0].activate();
    expect(said.length).toBe(1);
  });

  it("wakes only the room you are near, and sleeps the rest", () => {
    const hall = built.rooms.find((r) => r.id === "market-hall")!;
    const lights = () => {
      const on: number[] = [];
      built.group.traverse((o) => {
        const l = o as THREE.PointLight;
        if (l.isPointLight) on.push(l.intensity);
      });
      return on;
    };

    // Far away: nothing burning.
    for (let i = 0; i < 30; i++) built.update!(frame(0, ISLAND_Y + 200, 0));
    expect(lights().every((v) => v === 0)).toBe(true);

    // Standing in the hall: the pool is spent, and only on this room.
    for (let i = 0; i < 60; i++) built.update!(frame(hall.x, ISLAND_Y + 1.2, hall.z));
    const lit = lights().filter((v) => v > 0.01);
    expect(lit.length).toBeGreaterThan(0);
    expect(lit.length).toBeLessThanOrEqual(6);

    // And back out again.
    for (let i = 0; i < 90; i++) built.update!(frame(0, ISLAND_Y + 400, 0));
    expect(lights().every((v) => v < 0.01)).toBe(true);
  });

  it("counts the tram down and lets go of everything", () => {
    const station = built.rooms.find((r) => r.id === "tram-halo")!;
    const board = built.group.getObjectByName("empyrean-tram-board") as THREE.Mesh;
    expect(board).toBeTruthy();
    const mat = board.material as THREE.ShaderMaterial;
    const read = () => (mat.uniforms.uMask.value as THREE.Vector4).toArray().join(",");
    const ctx = frame(station.x, ISLAND_Y + 1.2, station.z);
    ctx.time = 10;
    built.update!(ctx);
    const a = read();
    ctx.time = 40;
    built.update!(ctx);
    expect(read()).not.toBe(a);

    expect(() => built.dispose()).not.toThrow();
    expect(built.group.children.length).toBe(0);
  });
});

/* =========================================================================
 * The four rooms that are chosen rather than inherited
 *
 * The café and the gallery take "the nearest shop to the landmark" and that
 * is the whole rule. These four each want something more specific — a lot big
 * enough, a lot the right *height*, a lot whose front faces off the edge of
 * the island — and every one of those is a rule over the plan rather than a
 * coordinate, for the reason `spire.ts` gives: reseed `cityplan.ts` and a
 * coordinate is a photograph of whatever ended up standing there instead.
 *
 * So the assertions here are the ones that catch a rule that has quietly
 * stopped being a rule: every lot the rule passed over has to fail it.
 * ====================================================================== */

describe("empyrean interiors — the rooms on chosen lots", () => {
  const lots = cityPlan().lots;
  const built = buildInteriors({ quality: "high", seedSalt: "rooms" });
  const world = buildCollision(built.blockers as never[], built.decks as never[]);
  const room = (id: string) => plan.find((r) => r.id === id)!;
  const lotOf = (id: string) => lots.find((l) => l.id === room(id).lot)!;
  const near = (l: Lot, to: { x: number; z: number }) =>
    Math.hypot(l.centroid.x - to.x, l.centroid.z - to.z);

  /** The placement's own fit test, restated: all four corners inside the lot. */
  function fits(lot: Lot, hx: number, hz: number): boolean {
    const yaw = Math.atan2(lot.frontNormal.z, lot.frontNormal.x);
    const cx = lot.frontMid.x - lot.frontNormal.x * (hz + 0.5);
    const cz = lot.frontMid.z - lot.frontNormal.z * (hz + 0.5);
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const p = { x: cx + sx * hx * s + sz * hz * c, z: cz - sx * hx * c + sz * hz * s };
      if (!pointInPoly(p, lot.poly)) return false;
    }
    return true;
  }

  it("puts the flat and the workshop on the nearest lot that will hold them", () => {
    const tram = LANDMARKS.find((l) => l.id === "tram-halo")!;
    for (const [id, use, district] of [
      ["home", "block", "market"],
      ["armature", "civic", "core"],
    ] as const) {
      const r = room(id);
      const mine = lotOf(id);
      expect(mine, `${id} has no lot`).toBeTruthy();
      expect(mine.use, id).toBe(use);
      expect(mine.district, id).toBe(district);
      const d = near(mine, tram);
      for (const other of lots) {
        if (other.id === mine.id || other.use !== use || other.district !== district) continue;
        if (other.landmark || built.claimedLots.includes(other.id)) continue;
        if (near(other, tram) >= d) continue;
        expect(
          fits(other, r.hx, r.hz),
          `${other.id} is nearer the tram than ${mine.id} and was passed over`,
        ).toBe(false);
      }
    }
  });

  it("puts the glasshouse on a lot the right height to be one", () => {
    /* Not "near the Hall" — near is the tie-break. A glasshouse under six
       storeys of somebody's flat is a cellar with tomatoes in it, so the rule
       leads with the lot's own eaves and this is that half of it. */
    const lot = lotOf("glasshouse");
    expect(lot.use).toBe("shop");
    expect(lot.district).toBe("gardens");
    expect(Math.abs(lot.height - room("glasshouse").height)).toBeLessThan(2.5);
  });

  it("faces the bath off the edge of the island, into the sunset", () => {
    const lot = lotOf("bath");
    expect(lot.use).toBe("pavilion");
    expect(lot.district).toBe("rim");
    const sunAz = Math.atan2(SUN_DIR.z, SUN_DIR.x);
    const off = (l: Lot) => {
      let d = (Math.atan2(l.frontNormal.z, l.frontNormal.x) - sunAz) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      return Math.abs(d);
    };
    const outward = (l: Lot) => {
      const rl = Math.hypot(l.frontMid.x, l.frontMid.z) || 1;
      return (l.frontMid.x / rl) * l.frontNormal.x + (l.frontMid.z / rl) * l.frontNormal.z;
    };
    // The rim's lots face outward or along the ring, never in. This one faces
    // out, or the entire room is a glass wall onto the back of a shop.
    expect(outward(lot)).toBeGreaterThan(0.8);
    expect(off(lot)).toBeLessThan(Math.PI / 3);
    const r = room("bath");
    for (const other of lots) {
      if (other.id === lot.id || other.use !== "pavilion" || other.district !== "rim") continue;
      if (other.landmark || built.claimedLots.includes(other.id)) continue;
      if (outward(other) <= 0.8 || !fits(other, r.hx, r.hz)) continue;
      expect(off(other), `${other.id} looks nearer the sunset and was passed over`)
        .toBeGreaterThanOrEqual(off(lot) - 1e-9);
    }
  });

  it("builds the rest of the building over a room shorter than its lot", () => {
    /* A claimed lot is a lot `buildings.ts` never builds. For a three-metre
       flat on a thirty-five-metre block that is a hole in the street, and
       `props.ts` — which is handed no claim list — goes on putting that lot's
       roof clutter at `lot.y + lot.height` regardless. Two things have to be
       true or the shell is worse than nothing: it is solid, and it has a floor
       on top. A blocker with no deck over it is a roof you fall through. */
    for (const id of ["home", "armature"] as const) {
      const r = room(id);
      const lot = lotOf(id);
      expect(lot.height, `${id}: lot is not tall enough to be worth testing`)
        .toBeGreaterThan(r.height + 6);
      // `Lot.height` is eaves above the lot's own deck, and every lot on this
      // island stands on the main one — so the shell's top is ISLAND_Y + it.
      const top = lot.height;
      for (const t of [0.35, 0.6, 0.9]) {
        const y = ISLAND_Y + r.height + (top - r.height) * t;
        expect(world.blockedAt(r.x, r.z, y, BODY_R), `${id} is hollow at ${y | 0}`).toBe(true);
      }
      expect(
        world.supportAt(r.x, r.z, ISLAND_Y + top + 0.5) - ISLAND_Y,
        `${id}: nothing to land on at the lot's own eaves`,
      ).toBeCloseTo(top, 1);
    }
  });

  it("lets you climb into the bath, and stops you everywhere else", () => {
    const r = room("bath");
    const flyWorld = {
      supportAt: world.supportAt,
      blockedAt: (x: number, z: number, y: number) => world.blockedAt(x, z, y),
      killY: -400,
      spawn: { x: 0, y: ISLAND_Y, z: 0, yaw: 0 },
    };
    /* The tank is *raised*, not sunk, and this is the test that says why: a
       `Deck` below the deck is not a hole you can stand in, because the ground
       always wins, so a sunk bath is one the body strolls over the top of. */
    const s = makeFlyer({ x: r.doorstep.x, y: ISLAND_Y + 0.3, z: r.doorstep.z, yaw: 0 });
    const camYaw = Math.atan2(-(r.x - r.doorstep.x), -(r.z - r.doorstep.z));
    for (let i = 0; i < 600; i++) {
      stepFlyer(s, { forward: 1, strafe: 0, run: false, jet: false, camYaw }, flyWorld, 1 / 60);
    }
    expect(s.grounded).toBe(true);
    expect(built.inside(s.position.x, s.position.y + 1.2, s.position.z)).toBe("bath");
    // Standing in the water, which is above the tiled floor and below the rim.
    expect(s.position.y - ISLAND_Y, "walked in but never got in").toBeGreaterThan(0.1);
    expect(s.position.y - ISLAND_Y).toBeLessThan(CLIMB);

    /* And there is exactly one way over the coping. Scanned across the front
       of the tank only — past its ends the floor is open and a run out there
       would pass this test while the bath stayed sealed. */
    let run = 0;
    let best = 0;
    let hasAxis = false;
    let bestHasAxis = false;
    for (let x = -8; x <= 8; x += 0.05) {
      const p = toWorld(r, x, 1.6);
      if (world.blockedAt(p.x, p.z, ISLAND_Y + 0.1, BODY_R)) {
        run = 0;
        hasAxis = false;
        continue;
      }
      run += 0.05;
      if (Math.abs(x) < 0.05) hasAxis = true;
      if (run > best) {
        best = run;
        bestHasAxis = hasAxis;
      }
    }
    expect(best, "no way over the coping at all").toBeGreaterThan(1.2);
    expect(best, "the coping is not a coping").toBeLessThan(6);
    expect(bestHasAxis, "the way in is not the way you walk in").toBe(true);
  });

  it("lets go of all four", () => {
    expect(() => built.dispose()).not.toThrow();
  });
});

/* =========================================================================
 * The Meridian: the tower with the lift in it
 *
 * The failures this suite is written against are the ones whose symptom is
 * silence. A lobby you cannot get into from the tower's own door still
 * builds, still renders and still photographs. A lift whose top stop is
 * half a metre off the floor it is supposed to serve looks perfect until you
 * ride it. A sky deck an axis-aligned approximation has pushed two metres
 * outside its own tower is a slab of clear air three hundred metres up, and
 * the README says in as many words that there is no cheap test for that one
 * — so this file tests the arithmetic that produces it instead.
 * ====================================================================== */

describe("empyrean interiors — The Meridian", () => {
  const sp = spirePlan();
  const lots = cityPlan().lots;
  const lot = lots.find((l) => l.id === sp.lot)!;

  it("stands on a tower lot the plan actually has, chosen by a rule", () => {
    expect(lot, `lot ${sp.lot} is gone from the plan`).toBeTruthy();
    expect(lot.use).toBe("tower");
    expect(lot.district).toBe("core");
    expect(lot.landmark).toBeUndefined();
    /* The rule is "the tallest tower whose footprint will hold a lobby".
       Every tower taller than this one has to fail the second half of it, or
       the rule has quietly stopped being the rule. */
    for (const other of lots) {
      if (other.use !== "tower" || other.height <= lot.height || other.id === lot.id) continue;
      const front = frontWidthOf(other);
      expect(
        front,
        `${other.id} is taller (${other.height.toFixed(0)} m) and was passed over`,
      ).toBeLessThan(16);
    }
  });

  it("rides more than the three hundred metres it promises", () => {
    expect(sp.stops.length).toBeGreaterThanOrEqual(2);
    expect(sp.travel).toBeGreaterThan(300);
    expect(sp.travel).toBeLessThan(sp.height);
    // Every stop is a floor somebody can stand on, in order, and the last one
    // is the sky deck rather than a number near it.
    expect(sp.stops[0]).toBe(0);
    expect(sp.stops[sp.stops.length - 1]).toBe(sp.deckY);
    for (let i = 1; i < sp.stops.length; i++) expect(sp.stops[i]).toBeGreaterThan(sp.stops[i - 1]);
    expect(sp.deckCeil).toBeGreaterThan(sp.deckY + 4);
    expect(sp.deckCeil).toBeLessThan(sp.height);
  });

  it("keeps every room inside the tower's own footprint", () => {
    for (const [name, r] of [["lobby", sp.lobby], ["deck", sp.deck], ["bay", sp.bay]] as const) {
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        const p = { x: r.cx + sx * r.hx, z: r.cz + sz * r.hz };
        expect(inLocalPoly(p, sp.shell), `${name} corner ${sx},${sz} is outside the tower`).toBe(true);
      }
    }
    // …and the lift bay inside both the rooms it opens onto, or the lift is
    // reachable from neither of them.
    for (const r of [sp.lobby, sp.deck]) {
      expect(sp.bay.cx - sp.bay.hx).toBeGreaterThanOrEqual(r.cx - r.hx - 1e-6);
      expect(sp.bay.cx + sp.bay.hx).toBeLessThanOrEqual(r.cx + r.hx + 1e-6);
    }
    // The whole tower inside the lot line, which is what claiming a lot buys.
    for (const p of sp.shell) {
      const w = spireToWorld(sp, p.x, p.z);
      expect(pointInPoly(w, lot.poly), "the shell escapes its own lot").toBe(true);
    }
  });

  it("hangs its glass floor out past the wall and over the street", () => {
    expect(sp.ledge.cz - sp.ledge.hz).toBeGreaterThanOrEqual(sp.frontZ - 0.01);
    expect(sp.ledge.hz * 2).toBeGreaterThan(2);
    // Directly under the middle of it is pavement, not more tower.
    const mid = { x: sp.ledge.cx, z: sp.ledge.cz };
    expect(inLocalPoly(mid, sp.shell), "the glass floor is over the tower, not the street").toBe(false);
    const w = spireToWorld(sp, mid.x, mid.z);
    expect(walkableAt(w.x, w.z), "nothing to look down at").toBe(true);
    // And it is a long way down.
    expect(sp.deckY).toBeGreaterThan(280);
  });
});

/**
 * A whole world, per test.
 *
 * The lift is the one thing here that carries state between frames, so tests
 * that share a build share a car: the second one starts with it parked at the
 * top and rides an empty shaft, which fails in a way that looks like the lift
 * being broken rather than like the test being wrong. It costs a fifth of a
 * second to build a fresh one.
 */
function rig() {
  const built = buildInteriors({ quality: "high", seedSalt: "lift" });
  const sp = built.spire;
  const world = buildCollision(built.blockers as never[], built.decks as never[]);
  const flyWorld = {
    supportAt: world.supportAt,
    blockedAt: (x: number, z: number, y: number) => world.blockedAt(x, z, y),
    killY: -400,
    spawn: { x: 0, y: ISLAND_Y, z: 0, yaw: 0 },
  };
  const bayW = spireToWorld(sp, sp.bay.cx, sp.bay.cz);
  const lift = () => built.interactables().find((h) => h.id === "spire-car")!;

  /** One engine frame, in `world.ts`'s order: the body steps, then systems. */
  const tick = (s: ReturnType<typeof makeFlyer>, dt: number) => {
    stepFlyer(s, { forward: 0, strafe: 0, run: false, jet: false, camYaw: 0 }, flyWorld, dt);
    const f = frame(s.position.x, s.position.y, s.position.z);
    f.dt = dt;
    f.player.position = s.position;
    f.player.velocity = s.velocity;
    built.update!(f);
  };
  const board = () => {
    const s = makeFlyer({ x: bayW.x, y: ISLAND_Y, z: bayW.z, yaw: 0 });
    for (let i = 0; i < 20; i++) tick(s, 1 / 60);
    return s;
  };
  /** Ride until the car stops moving, or give up. Returns frames taken. */
  const ride = (s: ReturnType<typeof makeFlyer>, dt: number, to: number) => {
    for (let i = 0; i < 6000; i++) {
      tick(s, dt);
      if (Math.abs(carFloor(built) - to) < 0.02) return i;
    }
    return -1;
  };
  return { built, sp, world, bayW, lift, tick, board, ride };
}

describe("empyrean interiors — the lift", () => {
  it("parks at the lobby floor, with a prompt you can reach from it", () => {
    const r = rig();
    const s = r.board();
    expect(s.grounded).toBe(true);
    expect(s.position.y).toBeCloseTo(ISLAND_Y, 2);
    expect(carFloor(r.built)).toBeCloseTo(0, 2);
    const l = r.lift();
    expect(Math.hypot(l.x - s.position.x, l.z - s.position.z)).toBeLessThan(l.radius);
    r.built.dispose();
  });

  it("carries a body all the way up, at the worst frame the engine allows", () => {
    /* dt is clamped to 0.05 s by `world.ts`, so this is the slowest the world
       is ever stepped and the case the car's per-frame cap exists for. It is
       also the case that breaks: measured against this very physics, a deck
       rising at 12.4 m/s still carries a body at dt = 0.05 and one at 13.0
       leaves it standing at the bottom of the shaft. */
    const r = rig();
    const s = r.board();
    r.lift().activate();
    let worst = 0;
    let ungrounded = 0;
    for (let i = 0; i < 6000; i++) {
      const before = s.position.y;
      r.tick(s, 0.05);
      worst = Math.max(worst, Math.abs(s.position.y - before));
      if (!s.grounded) ungrounded++;
      if (s.position.y > ISLAND_Y + r.sp.deckY - 0.02) break;
    }
    expect(s.position.y, "the body was left behind in the shaft").toBeCloseTo(
      ISLAND_Y + r.sp.deckY, 1,
    );
    expect(s.grounded).toBe(true);
    expect(ungrounded, "the body came off the floor on the way up").toBe(0);
    // The invariant: a floor that never outruns the body's own step-up.
    expect(worst, "the car moved further in one frame than CLIMB").toBeLessThan(CLIMB);
    expect(worst).toBeLessThanOrEqual(0.46);
    r.built.dispose();
  });

  it("puts the character's feet on the floor it is drawn on", () => {
    /* The car is drawn a frame behind its own deck on purpose. Without that
       the body rides sunk into the floor by one frame of travel, which at
       eleven metres a second is eighteen centimetres of boot through a
       glass platform. */
    const r = rig();
    const s = r.board();
    r.lift().activate();
    let worst = 0;
    for (let i = 0; i < 6000; i++) {
      r.tick(s, 1 / 60);
      worst = Math.max(worst, Math.abs(s.position.y - ISLAND_Y - carFloor(r.built)));
      if (s.position.y > ISLAND_Y + r.sp.deckY - 0.02) break;
    }
    expect(worst, "the body and the car it is standing in disagree").toBeLessThan(0.02);
    r.built.dispose();
  });

  it("brings it back down without leaving it floating", () => {
    const r = rig();
    const s = r.board();
    r.lift().activate();
    expect(r.ride(s, 1 / 60, r.sp.deckY), "never reached the top").toBeGreaterThan(0);
    for (let i = 0; i < 200; i++) r.tick(s, 1 / 60);
    r.lift().activate();
    let worstSag = 0;
    for (let i = 0; i < 6000; i++) {
      r.tick(s, 1 / 60);
      worstSag = Math.max(worstSag, Math.abs(s.position.y - ISLAND_Y - carFloor(r.built)));
      if (s.position.y < ISLAND_Y + 0.02) break;
    }
    expect(s.position.y).toBeCloseTo(ISLAND_Y, 1);
    // Feet on the floor the whole way, not a metre above a descending one.
    expect(worstSag, "the body sagged behind the car").toBeLessThan(0.05);
    r.built.dispose();
  });

  it("takes long enough to be a ride and not so long it is a wait", () => {
    const r = rig();
    const s = r.board();
    r.lift().activate();
    const frames = r.ride(s, 1 / 60, r.sp.deckY);
    expect(frames).toBeGreaterThan(0);
    const seconds = frames / 60;
    expect(seconds).toBeGreaterThan(20);
    expect(seconds).toBeLessThan(50);
    r.built.dispose();
  });

  it("will not let you walk out of a car that is moving", () => {
    const r = rig();
    const s = r.board();
    r.lift().activate();
    for (let i = 0; i < 600; i++) r.tick(s, 1 / 60);
    const y = s.position.y;
    expect(y, "the car never left the lobby").toBeGreaterThan(ISLAND_Y + 20);
    // Every direction out of the car, at the height the body is standing.
    let open = 0;
    for (let a = 0; a < 16; a++) {
      const t = (a / 16) * Math.PI * 2;
      const x = s.position.x + Math.cos(t) * 3.2;
      const z = s.position.z + Math.sin(t) * 3.2;
      if (!r.world.blockedAt(x, z, y, 0.6) && r.world.supportAt(x, z, y + 0.6) < y - 3) open++;
    }
    expect(open, "there is a way to step out of a lift at altitude").toBe(0);
    r.built.dispose();
  });

  it("closes the landing at the top when the car is not standing there", () => {
    /* With the car at the bottom the shaft at deck level is a three-hundred-
       metre hole in the floor of a room full of people looking at a view.
       The gate is the only thing between the two, and its whole failure mode
       is silent: the room looks identical either way. */
    const r = rig();
    const s = r.board();
    const y = ISLAND_Y + r.sp.deckY;
    const sill = spireToWorld(r.sp, r.sp.bay.cx, r.sp.bay.cz - r.sp.bay.hz + 0.5);
    const landing = spireToWorld(r.sp, r.sp.bay.cx, r.sp.bay.cz - r.sp.bay.hz - 1.2);
    // Standing room on the deck side of it, either way.
    expect(r.world.supportAt(landing.x, landing.z, y + 0.6)).toBeCloseTo(y, 1);
    // Car at the bottom: the way in is shut.
    expect(r.world.blockedAt(sill.x, sill.z, y + 0.05, 0.6), "the shaft is open").toBe(true);
    expect(r.world.supportAt(r.bayW.x, r.bayW.z, y + 0.6), "the shaft has a floor in it")
      .toBeLessThan(y - 100);
    r.lift().activate();
    expect(r.ride(s, 1 / 60, r.sp.deckY)).toBeGreaterThan(0);
    for (let i = 0; i < 200; i++) r.tick(s, 1 / 60);
    // Car at the top: the gate is a sill and the car floor is the floor.
    expect(r.world.blockedAt(sill.x, sill.z, y + 0.05, 0.6), "the doors never open").toBe(false);
    expect(r.world.supportAt(r.bayW.x, r.bayW.z, y + 0.6)).toBeCloseTo(y, 1);
    r.built.dispose();
  });
});

describe("empyrean interiors — walking into The Meridian", () => {
  const built = buildInteriors({ quality: "high", seedSalt: "walk" });
  const sp = built.spire;
  const world = buildCollision(built.blockers as never[], built.decks as never[]);

  it("lets you walk in from the lot's own front door", () => {
    /* `Lot.door` is the first walkable point outward from the wall, and it is
       the point every courier and pedestrian in the city is sent to. If the
       straight line from it to the middle of the lobby is blocked, the tower
       has a front door nobody can use. */
    const from = sp.doorstep;
    const to = spireToWorld(sp, sp.lobby.cx, sp.lobby.cz);
    const steps = Math.ceil(Math.hypot(from.x - to.x, from.z - to.z) / 0.15);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = from.x + (to.x - from.x) * t;
      const z = from.z + (to.z - from.z) * t;
      expect(
        world.blockedAt(x, z, ISLAND_Y + 0.1, BODY_R),
        `walk in obstructed ${(t * 100) | 0}% of the way`,
      ).toBe(false);
    }
    expect(built.inside(to.x, ISLAND_Y + 1.2, to.z)).toBe("spire-lobby");
  });

  it("gives the way in a gap a body fits through without aiming", () => {
    let run = 0;
    let best = 0;
    const step = 0.05;
    for (let t = -12; t <= 12; t += step) {
      const p = spireToWorld(sp, sp.lobby.cx + t, sp.frontZ + 0.9);
      if (world.blockedAt(p.x, p.z, ISLAND_Y + 0.1, BODY_R)) run = 0;
      else run += step;
      best = Math.max(best, run);
    }
    expect(best).toBeGreaterThanOrEqual(2.5);
  });

  it("has a floor everywhere on the sky deck you can reach", () => {
    /* The deck is a rectangle inside a wedge, and the band between the two is
       fenced rather than floored. So the test is not "is there floor" but
       "is there anywhere a body can stand that has nothing under it" — which
       is the fall, and is what a tiled deck gets wrong. */
    const y = ISLAND_Y + sp.deckY;
    let holes = 0;
    for (let ix = -sp.deck.hx; ix <= sp.deck.hx; ix += 0.4) {
      for (let iz = -sp.deck.hz; iz <= sp.deck.hz; iz += 0.4) {
        const lx = sp.deck.cx + ix;
        const lz = sp.deck.cz + iz;
        // The lift bay is a hole on purpose; the car is what fills it.
        if (Math.abs(lx - sp.bay.cx) <= sp.bay.hx && lz >= sp.bay.cz - sp.bay.hz) continue;
        const p = spireToWorld(sp, lx, lz);
        if (world.blockedAt(p.x, p.z, y + 0.05, BODY_R)) continue;
        if (world.supportAt(p.x, p.z, y + 0.6) < y - 0.5) holes++;
      }
    }
    expect(holes, "somewhere on the sky deck has nothing under it").toBe(0);
  });

  it("puts standable glass out over the street, and nothing under it", () => {
    const p = spireToWorld(sp, sp.ledge.cx, sp.ledge.cz);
    const y = ISLAND_Y + sp.deckY;
    expect(world.supportAt(p.x, p.z, y + 0.6)).toBeCloseTo(y, 1);
    // Step off it and the next thing is the pavement, three hundred metres down.
    const out = spireToWorld(sp, sp.ledge.cx, sp.ledge.cz + sp.ledge.hz + 1.5);
    expect(world.supportAt(out.x, out.z, y + 0.6)).toBeLessThan(ISLAND_Y + 2);
  });

  it("is solid inside, between the lobby ceiling and the sky deck", () => {
    /* Nobody walks in there — but the camera boom does, and a lens parked
       inside a hollow tower gives you a black frame with the player two
       metres away behind a wall. That does not read as a collision bug when
       you are looking at it; it reads as the world being broken. */
    for (const h of [20, 60, 150, 280]) {
      for (const [lx, lz] of [
        [sp.deck.cx, sp.deck.cz],
        [sp.deck.cx - sp.deck.hx * 0.6, sp.deck.cz],
        [sp.deck.cx + sp.deck.hx * 0.6, sp.deck.cz - sp.deck.hz * 0.5],
      ] as const) {
        const p = spireToWorld(sp, lx, lz);
        expect(
          world.blockedAt(p.x, p.z, ISLAND_Y + h, 0.6),
          `the tower is hollow at ${h} m`,
        ).toBe(true);
      }
    }
    // …and the shaft is not: that is where the car and the player are.
    const bay = spireToWorld(sp, sp.bay.cx, sp.bay.cz);
    expect(world.blockedAt(bay.x, bay.z, ISLAND_Y + 150, 0.4), "the shaft is filled in").toBe(false);
  });

  it("has a facade you cannot fly through, all the way up", () => {
    /* The tower is a shell, not a solid: there is nothing inside it above the
       lobby ceiling and nothing needs to be, because there is no way in. What
       there does have to be is a wall on every edge at every height — a
       jetpack passing through the glass of the one tower in the city that has
       an inside is the tell that this file forgot a band. */
    for (const h of [20, 40, 120, 240, sp.deckY + 4]) {
      for (let i = 0; i < sp.shell.length; i++) {
        const a = sp.shell[i];
        const b = sp.shell[(i + 1) % sp.shell.length];
        const mid = spireToWorld(sp, (a.x + b.x) / 2, (a.z + b.z) / 2);
        // The way in, and the lift bay, are openings on purpose.
        const lx = (a.x + b.x) / 2;
        const inFront = Math.abs((a.z + b.z) / 2 - sp.frontZ) < 0.01;
        if (inFront && lx > sp.entrance.x0 - 2 && lx < sp.entrance.x1 + 2 && h < 20) continue;
        expect(
          world.blockedAt(mid.x, mid.z, ISLAND_Y + h, 0.2),
          `edge ${i} of the tower is open at ${h.toFixed(0)} m`,
        ).toBe(true);
      }
    }
  });
});

describe("empyrean interiors — The Meridian, built", () => {
  it("draws in a handful of calls and never a NaN", () => {
    const built = buildInteriors({ quality: "high", seedSalt: "nan" });
    const g = built.group.getObjectByName("empyrean-spire")!;
    expect(g).toBeTruthy();
    let meshes = 0;
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      meshes++;
      for (const name of Object.keys(m.geometry.attributes)) {
        const a = m.geometry.getAttribute(name);
        for (let i = 0; i < a.array.length; i++) {
          if (!Number.isFinite(a.array[i])) {
            throw new Error(`${m.name}: NaN in ${name} at ${i}`);
          }
        }
      }
    });
    expect(meshes).toBeGreaterThan(3);
    expect(meshes).toBeLessThanOrEqual(8);
    built.dispose();
  });

  it("lets go of everything, twice", () => {
    const built = buildInteriors({ quality: "high", seedSalt: "dispose" });
    const disposed: string[] = [];
    built.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const geo = m.geometry;
      const orig = geo.dispose.bind(geo);
      geo.dispose = () => {
        disposed.push(m.name);
        orig();
      };
    });
    expect(() => built.dispose()).not.toThrow();
    expect(disposed.length).toBeGreaterThan(6);
    expect(built.group.children.length).toBe(0);
    // The second one is the one that finds a dispose that assumed it was
    // going to be called exactly once.
    expect(() => built.dispose()).not.toThrow();
    expect(
      (globalThis as { __empyreanLift?: unknown }).__empyreanLift,
      "the debug hook outlived the world",
    ).toBeUndefined();
  });
});
