/**
 * The Empyrean's activities, checked against the geometry they were laid out
 * against.
 *
 * Four courses, eight viewpoints, forty-eight collectibles and a courier
 * dispatcher are all *hand-placed coordinates*, and hand-placed coordinates go
 * stale the moment somebody changes a ring radius or a building height. None
 * of it is checkable by eye: a gate inside a tower looks exactly like a gate
 * behind a tower until you fly the corner at thirty metres a second, and a
 * collectible inside the rock looks like a collectible that is not there.
 *
 * So: every gate, every viewpoint and every find is re-derived here from
 * `cityplan.ts`, `config.ts` and the keel envelope, on every test run.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import { cityPlan, surfaceAt, LANDMARKS } from "@/empyrean/cityplan";
import { DECKS, ISLAND_Y, PLATEAU_R } from "@/empyrean/config";
import {
  buildingBlocked,
  distToPoly,
  keelBlocked,
  keelBlockedNear,
  keelRockRadius,
  landmarkBlocked,
  pointInPoly,
  readStore,
  writeStore,
} from "@/empyrean/activities/common";
import {
  buildActivities,
  buildChain,
  chainSeed,
  COURSES,
  gateNormals,
  gatePoints,
  legPay,
  placeFinds,
  racePayout,
  SHOTS,
  tierMultiplier,
  FINDS_KEY,
  RACE_KEY,
  STATIONS,
} from "@/empyrean/activities";
import type { FrameContext } from "@/empyrean/types";

const plan = cityPlan();

/* -------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------- */

/** Every point on a gate's rim, plus its centre. What the player can touch. */
function ringSamples(centre: THREE.Vector3, normal: THREE.Vector3, radius: number) {
  const out: THREE.Vector3[] = [centre.clone()];
  const u = new THREE.Vector3(0, 1, 0);
  if (Math.abs(normal.y) > 0.9) u.set(1, 0, 0);
  const a = new THREE.Vector3().crossVectors(normal, u).normalize();
  const b = new THREE.Vector3().crossVectors(normal, a).normalize();
  for (let i = 0; i < 12; i++) {
    const t = (i / 12) * Math.PI * 2;
    out.push(
      centre
        .clone()
        .addScaledVector(a, Math.cos(t) * radius)
        .addScaledVector(b, Math.sin(t) * radius),
    );
  }
  return out;
}

function clearOfEverything(p: THREE.Vector3, label: string, keelMargin = 6) {
  expect(buildingBlocked(p.x, p.z, p.y, 2), `${label} is inside a building`).toBe(false);
  expect(landmarkBlocked(p.x, p.z, p.y, 2), `${label} is inside a landmark`).toBe(false);
  expect(keelBlockedNear(p.x, p.z, p.y, keelMargin), `${label} is inside the keel`).toBe(false);
  expect(p.y, `${label} is under the ice`).toBeGreaterThan(20);
}

/** A frame context good enough to drive an activity from a test. */
function makeFrame(): FrameContext {
  const camera = new THREE.PerspectiveCamera(58, 1.6, 0.35, 22000);
  return {
    time: 0,
    dt: 1 / 60,
    camera,
    player: {
      position: new THREE.Vector3(0, ISLAND_Y, 80),
      velocity: new THREE.Vector3(),
      yaw: 0,
      grounded: true,
      burn: 0,
      altitude: 0,
    },
    quality: "high",
    dayPhase: 0.75,
    sunDir: new THREE.Vector3(0, 1, 0),
    daylight: 0.6,
    camRadiusSq: 0,
  };
}

function countNodes(root: THREE.Object3D): number {
  let n = 0;
  root.traverse(() => n++);
  return n;
}

/* -------------------------------------------------------------------------
 * The keel envelope itself
 * ---------------------------------------------------------------------- */

describe("the keel envelope", () => {
  it("is wider than the rock keel.ts actually builds, at every height", () => {
    /* The envelope in `common.ts` is the analytic worst case of the same
     * profile `keel.ts` laths. Re-derive the real thing here — sampling every
     * angle, with the same noise term bounded at its ceiling — and check the
     * envelope is never the smaller of the two. If keel.ts's profile changes,
     * this is what says so. */
    const topY = DECKS[DECKS.length - 1].y - 6;
    const tipY = 60;
    const topR = DECKS[DECKS.length - 1].outer * 0.99;
    for (let y = tipY; y <= topY; y += 8) {
      const t = (topY - y) / (topY - tipY);
      const base = topR * Math.pow(1 - t, 1.22) * (1 - 0.12 * Math.sin(t * Math.PI * 2.1));
      let widest = 0;
      for (let j = 0; j < 180; j++) {
        const a = (j / 180) * Math.PI * 2;
        const lobe = 1 + Math.sin(a * 4 + 0.7) * 0.1 + Math.sin(a * 3 - 2.1) * 0.06;
        const flute = 1 + Math.sin(a * 17 + t * 2.2) * 0.055 * (0.35 + t);
        // fbm2 is bounded by 1; use the ceiling rather than the field.
        const rough = 1 + 0.34 * (0.3 + t * 1.1);
        widest = Math.max(widest, base * lobe * flute * rough);
      }
      expect(keelRockRadius(y), `rock envelope at y=${y}`).toBeGreaterThanOrEqual(widest - 1e-6);
    }
  });

  it("calls the axis blocked where the great spike hangs, and the open lake clear", () => {
    expect(keelBlocked(0, 0, 200)).toBe(true);
    expect(keelBlocked(1200, 0, 200)).toBe(false);
    expect(keelBlocked(0, 0, ISLAND_Y + 40)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * Races
 * ---------------------------------------------------------------------- */

describe("race courses", () => {
  it("has four of them, each with enough gates to be a course", () => {
    expect(COURSES).toHaveLength(4);
    for (const c of COURSES) {
      expect(c.gates.length, `${c.id} gate count`).toBeGreaterThanOrEqual(9);
      expect(c.radius).toBeGreaterThanOrEqual(8);
      expect(c.par).toBeGreaterThan(10);
      expect(c.base).toBeGreaterThan(0);
    }
  });

  it("puts no part of a gate inside a building, a landmark or the rock", () => {
    for (const course of COURSES) {
      const pts = gatePoints(course);
      const nrm = gateNormals(pts);
      for (let i = 0; i < pts.length; i++) {
        for (const s of ringSamples(pts[i], nrm[i], course.radius)) {
          clearOfEverything(s, `${course.id} gate ${i}`);
        }
      }
    }
  });

  it("keeps every gate above the deck or provably outside the keel", () => {
    for (const course of COURSES) {
      for (const p of gatePoints(course)) {
        const r = Math.hypot(p.x, p.z);
        if (p.y > ISLAND_Y) continue;
        // Below deck height there are only two safe places to be: outside the
        // rock, or in under it at a radius no stalactite can reach.
        expect(keelBlocked(p.x, p.z, p.y), `${course.id} gate at r=${r.toFixed(0)}`).toBe(false);
      }
    }
  });

  it("keeps the ideal line between gates out of the buildings and the rock", () => {
    for (const course of COURSES) {
      const pts = gatePoints(course);
      const step = new THREE.Vector3();
      const at = new THREE.Vector3();
      for (let i = 0; i + 1 < pts.length; i++) {
        step.subVectors(pts[i + 1], pts[i]);
        const len = step.length();
        const n = Math.max(2, Math.ceil(len / 8));
        for (let k = 1; k < n; k++) {
          at.copy(pts[i]).addScaledVector(step, k / n);
          expect(
            buildingBlocked(at.x, at.z, at.y, 1),
            `${course.id} line ${i}→${i + 1} crosses a building at ${at.x.toFixed(0)},${at.y.toFixed(0)},${at.z.toFixed(0)}`,
          ).toBe(false);
          expect(
            keelBlockedNear(at.x, at.z, at.y, 4),
            `${course.id} line ${i}→${i + 1} crosses the keel`,
          ).toBe(false);
        }
      }
    }
  });

  it("starts each course somewhere a body can stand", () => {
    for (const course of COURSES) {
      const s = surfaceAt(course.startAt.x, course.startAt.z);
      expect(s.kind, `${course.id} start`).not.toBe("void");
    }
  });

  it("fits every hoop between the facades it flies between", () => {
    /* The clearance a block is held at is a *lane* width outside the first
     * ring road, not an avenue width, so the real gap on 45th at r = 250 is
     * 21 m rather than the 29 m the street looks. This is the check that
     * caught it, and it is the reason the sprint's hoops are 8 m and not 10. */
    for (const course of COURSES) {
      for (const p of gatePoints(course)) {
        const r = Math.hypot(p.x, p.z);
        if (r > PLATEAU_R || p.y > ISLAND_Y + 60) continue;
        let gap = Infinity;
        for (const lot of plan.lots) {
          if (lot.use === "garden") continue;
          if (p.y > lot.y + lot.height) continue;
          if (Math.abs(lot.r - r) > 90) continue;
          gap = Math.min(gap, distToPoly(lot.poly, p.x, p.z));
        }
        if (!Number.isFinite(gap)) continue;
        expect(
          gap,
          `${course.id} hoop at r=${r.toFixed(0)} y=${p.y.toFixed(0)} has ${gap.toFixed(1)} m of street`,
        ).toBeGreaterThan(course.radius + 1.5);
      }
    }
  });

  it("counts a gate you fly through and not one you fly past", () => {
    const handle = buildActivities({ quality: "high", seedSalt: "test" });
    const frame = makeFrame();
    handle.interact("race.sprint");
    for (let i = 0; i < 40; i++) {
      frame.time += 0.1;
      handle.update!(frame);
    }
    const pts = gatePoints(COURSES.find((c) => c.id === "sprint")!);
    // Sixty metres wide of the first gate, twice: nothing should register.
    for (let k = 0; k < 4; k++) {
      frame.player.position.set(pts[0].x + 60, pts[0].y + 40, pts[0].z + 60);
      frame.time += 0.2;
      handle.update!(frame);
    }
    expect(handle.activity()!.lines[1]).toContain("Gate 1 of");
    frame.player.position.copy(pts[0]);
    frame.time += 0.2;
    handle.update!(frame);
    frame.time += 0.2;
    handle.update!(frame);
    expect(handle.activity()!.lines[1]).toContain("Gate 2 of");
    handle.dispose();
  });

  it("pays something for a race you walk away from", () => {
    const handle = buildActivities({ quality: "high", seedSalt: "test" });
    const frame = makeFrame();
    handle.interact("race.sprint");
    for (let i = 0; i < 40; i++) {
      frame.time += 0.1;
      handle.update!(frame);
    }
    const pts = gatePoints(COURSES.find((c) => c.id === "sprint")!);
    for (let i = 0; i < 3; i++) {
      frame.player.position.copy(pts[i]);
      frame.time += 0.2;
      handle.update!(frame);
      frame.time += 0.2;
      handle.update!(frame);
    }
    handle.abort();
    expect(handle.activity()).toBeNull();
    expect(handle.earned, "three gates should still be worth something").toBeGreaterThan(0);
    handle.dispose();
  });

  it("pays more for a faster lap, and never nothing for a slow one", () => {
    const c = COURSES[0];
    const quick = racePayout(c, c.par * 0.6, false, false);
    const par = racePayout(c, c.par, false, false);
    const slow = racePayout(c, c.par * 4, false, false);
    expect(quick).toBeGreaterThan(par);
    expect(par).toBeGreaterThan(slow);
    expect(slow).toBeGreaterThan(0);
    expect(racePayout(c, c.par, true, true)).toBeGreaterThan(par);
  });
});

/* -------------------------------------------------------------------------
 * Courier runs
 * ---------------------------------------------------------------------- */

describe("courier runs", () => {
  const doors = new Map(plan.doors.map((d) => [d.lot, d]));

  it("only ever routes to a real doorstep", () => {
    for (let drops = 2; drops <= 5; drops++) {
      for (let seed = 0; seed < 6; seed++) {
        const chain = buildChain(`test-${seed}`, drops, { x: 0, z: 120 });
        expect(chain.length, "chain length").toBe(drops + 1);
        for (const stop of chain) {
          const door = doors.get(stop.lot);
          expect(door, `${stop.lot} is not a door in the plan`).toBeTruthy();
          expect(Math.hypot(stop.x - door!.x, stop.z - door!.z)).toBeLessThan(0.001);
          // And the doorstep is somewhere a body can stand — which is the
          // whole reason `Lot.door` exists rather than `Lot.frontMid`.
          const s = surfaceAt(stop.x, stop.z);
          expect(["walk", "plaza", "road"], `${stop.lot} doorstep is ${s.kind}`).toContain(s.kind);
        }
      }
    }
  });

  it("never visits the same address twice in one chain, and never a trivial leg", () => {
    for (let seed = 0; seed < 8; seed++) {
      const chain = buildChain(`spread-${seed}`, 5, { x: 120, z: 0 });
      const ids = new Set(chain.map((s) => s.lot));
      expect(ids.size).toBe(chain.length);
      for (let i = 1; i < chain.length; i++) {
        expect(chain[i].dist, `leg ${i}`).toBeGreaterThan(50);
        expect(chain[i].allowance).toBeGreaterThan(10);
      }
    }
  });

  it("pays less for a slow leg and less again for a jolted one, but always pays", () => {
    expect(legPay(300, 10, 30, false)).toBeGreaterThan(legPay(300, 60, 30, false));
    expect(legPay(300, 20, 30, true)).toBeLessThan(legPay(300, 20, 30, false));
    expect(legPay(300, 9999, 30, true)).toBeGreaterThan(0);
    expect(tierMultiplier(5)).toBeGreaterThan(tierMultiplier(2));
  });
});

/* -------------------------------------------------------------------------
 * The photo hunt
 * ---------------------------------------------------------------------- */

describe("photo viewpoints", () => {
  it("stands you somewhere real and points you at something else", () => {
    for (const shot of SHOTS) {
      const p = new THREE.Vector3(shot.at.x, shot.at.y, shot.at.z);
      expect(buildingBlocked(p.x, p.z, p.y, 1), `${shot.id} is inside a building`).toBe(false);
      // A viewpoint you stand on is a metre above a deck by definition, so the
      // margin only makes sense for the ones hanging in mid-air.
      const standing = DECKS.some((d) => Math.abs(shot.at.y - d.y) < 3) || shot.at.y < 4;
      expect(
        standing ? keelBlocked(p.x, p.z, p.y) : keelBlockedNear(p.x, p.z, p.y, 4),
        `${shot.id} is inside the keel`,
      ).toBe(false);
      const look = new THREE.Vector3(shot.look.x, shot.look.y, shot.look.z);
      expect(look.distanceTo(p), `${shot.id} looks at itself`).toBeGreaterThan(30);
      expect(shot.near).toBeGreaterThan(10);
      expect(shot.arc).toBeGreaterThan(12);
    }
  });

  it("puts the standing shots on a surface and the hovering ones in open air", () => {
    for (const shot of SHOTS) {
      const s = surfaceAt(shot.at.x, shot.at.z);
      const onDeck = Math.abs(shot.at.y - ISLAND_Y) < 3;
      const onPromenade = DECKS.some((d) => Math.abs(shot.at.y - d.y) < 3);
      if (onDeck || (onPromenade && shot.at.y < ISLAND_Y)) {
        expect(s.kind, `${shot.id} stands on ${s.kind}`).not.toBe("void");
        expect(s.kind, `${shot.id} stands on a parapet`).not.toBe("parapet");
      }
    }
  });

  it("covers more than one part of the world", () => {
    const heights = SHOTS.map((s) => s.at.y);
    expect(Math.min(...heights)).toBeLessThan(50);
    expect(Math.max(...heights)).toBeGreaterThan(1000);
    expect(new Set(SHOTS.map((s) => s.id)).size).toBe(SHOTS.length);
    expect(SHOTS.length).toBeGreaterThanOrEqual(8);
  });
});

/* -------------------------------------------------------------------------
 * Sunmotes
 * ---------------------------------------------------------------------- */

describe("sunmotes", () => {
  const finds = placeFinds();

  it("deals out between forty and sixty, all with distinct ids", () => {
    expect(finds.length).toBeGreaterThanOrEqual(40);
    expect(finds.length).toBeLessThanOrEqual(60);
    expect(new Set(finds.map((f) => f.id)).size).toBe(finds.length);
  });

  it("spreads them across every kind of place", () => {
    const kinds = new Set(finds.map((f) => f.kind));
    for (const k of ["deck", "roof", "cornice", "promenade", "keel", "air", "interior"]) {
      expect(kinds.has(k as never), `no ${k} finds`).toBe(true);
    }
  });

  it("puts none of them inside a wall or inside the rock", () => {
    for (const f of finds) {
      // A roof find sits on top of its own building, so its own lot is not a
      // collision — anything else is.
      const lot = f.lot ? plan.lots.find((l) => l.id === f.lot) : undefined;
      const inOwn =
        lot && pointInPoly(lot.poly, f.x, f.z) && f.y <= lot.y + lot.height + 0.01;
      expect(inOwn ?? false, `${f.id} is buried in its own building`).toBe(false);
      expect(buildingBlocked(f.x, f.z, f.y, 0), `${f.id} is inside a building`).toBe(false);
      expect(keelBlocked(f.x, f.z, f.y), `${f.id} is inside the keel`).toBe(false);
    }
  });

  it("keeps every one of them reachable", () => {
    for (const f of finds) {
      const s = surfaceAt(f.x, f.z);
      switch (f.kind) {
        case "deck":
          // Standing height over walkable ground.
          expect(s.kind, `${f.id} on ${s.kind}`).not.toBe("void");
          expect(f.y - s.y, `${f.id} height over the pavement`).toBeGreaterThan(0.5);
          expect(f.y - s.y).toBeLessThan(3);
          break;
        case "promenade": {
          const deck = DECKS.find((d) => Math.abs(f.y - 1.2 - d.y) < 0.01);
          expect(deck, `${f.id} is not on a promenade ring`).toBeTruthy();
          const r = Math.hypot(f.x, f.z);
          expect(r).toBeLessThanOrEqual(deck!.outer);
          expect(r).toBeGreaterThanOrEqual(deck!.outer - deck!.width);
          break;
        }
        case "roof": {
          const lot = plan.lots.find((l) => l.id === f.lot)!;
          expect(lot, `${f.id} has no lot`).toBeTruthy();
          // Within a couple of metres of the roof you land on.
          expect(f.y - (lot.y + lot.height)).toBeGreaterThan(0.5);
          expect(f.y - (lot.y + lot.height)).toBeLessThan(3);
          expect(distToPoly(lot.poly, f.x, f.z)).toBeLessThan(12);
          break;
        }
        case "cornice": {
          const lot = plan.lots.find((l) => l.id === f.lot)!;
          expect(pointInPoly(lot.poly, f.x, f.z), `${f.id} is inside the wall`).toBe(false);
          // Close enough to the facade to be a cornice, far enough out to hover.
          expect(distToPoly(lot.poly, f.x, f.z)).toBeLessThan(6);
          expect(f.y).toBeGreaterThan(lot.y + 6);
          expect(f.y).toBeLessThan(lot.y + lot.height);
          break;
        }
        case "keel":
        case "air":
          // Nothing holds these up; they are reachable because the jetpack
          // climbs at 19 m/s and there is nothing between them and the sky.
          expect(keelBlockedNear(f.x, f.z, f.y, 6), `${f.id}`).toBe(false);
          expect(f.y, `${f.id} is below the ice`).toBeGreaterThan(60);
          break;
        case "interior": {
          const hall = LANDMARKS.find((l) => l.id === "market-hall")!;
          expect(Math.hypot(f.x - hall.x, f.z - hall.z)).toBeLessThan(hall.clear);
          expect(f.y - ISLAND_Y).toBeGreaterThan(1);
          expect(f.y - ISLAND_Y).toBeLessThan(12);
          break;
        }
      }
    }
  });

  it("keeps them out of each other's pockets", () => {
    for (let i = 0; i < finds.length; i++) {
      for (let j = i + 1; j < finds.length; j++) {
        const d = Math.hypot(
          finds[i].x - finds[j].x,
          finds[i].y - finds[j].y,
          finds[i].z - finds[j].z,
        );
        expect(d, `${finds[i].id} and ${finds[j].id}`).toBeGreaterThan(8);
      }
    }
  });

  it("is deterministic", () => {
    const again = placeFinds();
    expect(again.map((f) => f.id)).toEqual(finds.map((f) => f.id));
    expect(again[7].x).toBeCloseTo(finds[7].x, 6);
  });
});

/* -------------------------------------------------------------------------
 * The prompts
 * ---------------------------------------------------------------------- */

describe("interactables", () => {
  it("stands every prompt on solid ground, far enough apart to be reachable", () => {
    const handle = buildActivities({ quality: "high", seedSalt: "test" });
    const list = handle.interactables().filter((i) => i.id !== "activity.stop");
    expect(list.length).toBeGreaterThanOrEqual(7);
    for (const item of list) {
      const s = surfaceAt(item.x, item.z);
      expect(s.kind, `${item.id} stands on ${s.kind}`).not.toBe("void");
      // Inside the parapet, which starts 1.4 m in from the plateau's edge.
      expect(Math.hypot(item.x, item.z), `${item.id} is off the island`).toBeLessThan(
        PLATEAU_R - 2,
      );
      expect(buildingBlocked(item.x, item.z, item.y, 0), `${item.id} is in a wall`).toBe(false);
      expect(landmarkBlocked(item.x, item.z, item.y, 0), `${item.id} is in a landmark`).toBe(false);
    }
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const d = Math.hypot(list[i].x - list[j].x, list[i].z - list[j].z);
        expect(d, `${list[i].id} and ${list[j].id} overlap`).toBeGreaterThan(
          list[i].radius + list[j].radius,
        );
      }
    }
    handle.dispose();
  });

  it("returns the same array every time, because the engine holds on to it", () => {
    const handle = buildActivities({ quality: "high", seedSalt: "test" });
    expect(handle.interactables()).toBe(handle.interactables());
    handle.dispose();
  });
});

/* -------------------------------------------------------------------------
 * Lifecycle
 * ---------------------------------------------------------------------- */

describe("the activity lifecycle", () => {
  beforeEach(() => {
    try {
      window.localStorage.clear();
    } catch {
      /* nothing to clear */
    }
  });

  it("runs one activity at a time, completes it, and pays", () => {
    const handle = buildActivities({ quality: "high", seedSalt: "test" });
    const frame = makeFrame();
    const before = countNodes(handle.group);

    expect(handle.activity()).toBeNull();
    handle.interact("race.sprint");
    expect(handle.activity()).not.toBeNull();

    // A second activity cannot start on top of the first.
    handle.interact("courier.market");
    expect(handle.activity()!.title).toContain("Sprint");

    // Wait out the countdown.
    for (let i = 0; i < 40; i++) {
      frame.time += 0.1;
      handle.update!(frame);
    }

    const course = COURSES.find((c) => c.id === "sprint")!;
    for (const p of gatePoints(course)) {
      for (let k = 0; k < 2; k++) {
        frame.time += 0.2;
        frame.player.position.copy(p);
        handle.update!(frame);
      }
    }

    expect(handle.activity(), "the race should have finished").toBeNull();
    expect(handle.earned).toBeGreaterThan(0);
    const banked = handle.drainBanked();
    expect(banked).toBe(handle.earned);
    expect(handle.drainBanked()).toBe(0);

    const toasts = handle.drainToasts();
    expect(toasts.length).toBeGreaterThan(0);
    expect(handle.drainToasts()).toHaveLength(0);

    // And the record went to disk.
    const book = readStore<Record<string, { best: number }>>(RACE_KEY, {});
    expect(book.sprint?.best).toBeGreaterThan(0);

    // Nothing accumulated in the scene graph.
    expect(countNodes(handle.group)).toBe(before);
    handle.dispose();
  });

  it("aborts cleanly and can start again afterwards", () => {
    const handle = buildActivities({ quality: "high", seedSalt: "test" });
    const frame = makeFrame();

    handle.interact("race.climb");
    expect(handle.activity()).not.toBeNull();
    handle.abort();
    expect(handle.activity()).toBeNull();

    handle.interact("courier.station");
    expect(handle.activity()).not.toBeNull();
    handle.abort();
    expect(handle.activity()).toBeNull();

    handle.interact("photo.hunt");
    expect(handle.activity()).not.toBeNull();
    frame.time += 0.1;
    handle.update!(frame);
    handle.abort();
    expect(handle.activity()).toBeNull();

    handle.interact("race.slalom");
    expect(handle.activity()).not.toBeNull();
    handle.dispose();
  });

  it("collects a sunmote when you fly into it, once, and remembers", () => {
    const handle = buildActivities({ quality: "high", seedSalt: "test" });
    const frame = makeFrame();
    const finds = placeFinds();
    expect(handle.found.total).toBe(finds.length);
    expect(handle.found.got).toBe(0);

    frame.player.position.set(finds[0].x, finds[0].y, finds[0].z);
    frame.time += 0.1;
    handle.update!(frame);
    expect(handle.found.got).toBe(1);
    frame.time += 0.1;
    handle.update!(frame);
    expect(handle.found.got, "picked the same one up twice").toBe(1);
    expect(handle.earned).toBeGreaterThan(0);
    handle.dispose();

    // A second world in the same browser starts with it already collected.
    const again = buildActivities({ quality: "high", seedSalt: "test" });
    expect(again.found.got).toBe(1);
    again.dispose();
    expect(readStore<{ got: string[] }>(FINDS_KEY, { got: [] }).got).toContain(finds[0].id);
  });

  it("delivers a courier chain end to end", () => {
    const handle = buildActivities({ quality: "high", seedSalt: "test" });
    const frame = makeFrame();
    handle.interact("courier.market");
    const view = handle.activity()!;
    expect(view.title.length).toBeGreaterThan(0);

    /* Fly the chain. The dispatcher's seed is public precisely so this is
     * possible: the first run of a session is two drops out of the Market
     * Hall's window, and rebuilding it here is the same arithmetic the runner
     * did. */
    const chain = buildChain(chainSeed("Market Hall-test", 0), 2, STATIONS.courierMarket);
    for (const stop of chain) {
      frame.player.position.set(stop.x, ISLAND_Y, stop.z);
      for (let k = 0; k < 2; k++) {
        frame.time += 0.5;
        handle.update!(frame);
      }
    }
    expect(handle.activity(), "the run should have completed").toBeNull();
    expect(handle.earned).toBeGreaterThan(10);
    handle.dispose();
  });

  it("survives dispose without an activity running", () => {
    const handle = buildActivities({ quality: "high", seedSalt: "test" });
    expect(() => handle.dispose()).not.toThrow();
  });
});

/* -------------------------------------------------------------------------
 * Storage that is not there
 * ---------------------------------------------------------------------- */

describe("a browser with no usable localStorage", () => {
  let original: Storage;

  beforeEach(() => {
    original = window.localStorage;
    const angry = {
      getItem() {
        throw new DOMException("denied");
      },
      setItem() {
        throw new DOMException("quota");
      },
      removeItem() {
        throw new DOMException("denied");
      },
      clear() {
        throw new DOMException("denied");
      },
      key() {
        return null;
      },
      length: 0,
    } as unknown as Storage;
    Object.defineProperty(window, "localStorage", { value: angry, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(window, "localStorage", { value: original, configurable: true });
  });

  it("reads and writes without throwing", () => {
    expect(() => writeStore("empyrean.test", { a: 1 })).not.toThrow();
    expect(readStore("empyrean.test", { a: 2 })).toEqual({ a: 2 });
  });

  it("builds, runs and completes an activity anyway", () => {
    const handle = buildActivities({ quality: "high", seedSalt: "test" });
    const frame = makeFrame();
    expect(() => {
      handle.interact("race.sprint");
      for (let i = 0; i < 40; i++) {
        frame.time += 0.1;
        handle.update!(frame);
      }
      for (const p of gatePoints(COURSES[0])) {
        for (let k = 0; k < 2; k++) {
          frame.time += 0.2;
          frame.player.position.copy(p);
          handle.update!(frame);
        }
      }
    }).not.toThrow();
    expect(handle.activity()).toBeNull();
    expect(handle.earned).toBeGreaterThan(0);
    expect(() => handle.dispose()).not.toThrow();
  });
});

/* -------------------------------------------------------------------------
 * Sanity on the plan this all rests on
 * ---------------------------------------------------------------------- */

describe("the ground under all of it", () => {
  it("still has doors, lots and a deck where this module expects them", () => {
    expect(plan.doors.length).toBeGreaterThan(40);
    expect(PLATEAU_R).toBe(340);
    expect(ISLAND_Y).toBe(620);
    expect(DECKS[DECKS.length - 1].outer).toBe(400);
  });
});
