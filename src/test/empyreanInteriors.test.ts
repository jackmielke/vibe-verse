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
import { cityPlan, LANDMARKS, type Vec2 } from "@/empyrean/cityplan";
import { BODY_R } from "@/empyrean/flight";
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
  it("names five rooms, each once", () => {
    expect(plan.length).toBe(5);
    expect(new Set(plan.map((r) => r.id)).size).toBe(5);
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
    expect(onLots.length).toBe(2);
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
    expect(built.claimedLots.length).toBe(2);
    expect(new Set(built.claimedLots).size).toBe(2);
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
