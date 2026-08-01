/**
 * The two things in Five Nights that fail quietly.
 *
 * The floor plan and the route graphs are separate data structures that have to
 * agree, and nothing in the type system makes them. If a route sends Bonnie
 * from the dining room to a room the navmesh cannot reach, he does not crash —
 * he walks the straight line and clips through the show stage's west wall, on
 * camera, once, at 3 AM, in front of whoever opened the link. The compiler is
 * no help and neither is a screenshot taken at the wrong second.
 */
import { describe, expect, it } from "vitest";
import { NIGHTS, NIGHT_COUNT, ROUTES_FOR_TEST } from "@/fnaf/ai";
import { CAMERA_ORDER, MAP_POINTS, pathBetween, ROOMS, type RoomId } from "@/fnaf/rooms";

describe("the floor plan", () => {
  it("can walk from any room to any other room", () => {
    const ids = Object.keys(ROOMS) as RoomId[];
    for (const from of ids) {
      for (const to of ids) {
        if (from === to) continue;
        // A path may legitimately be empty only for adjacent rooms; what must
        // never happen is an unreachable pair, which BFS reports the same way.
        const direct = pathBetween(from, to);
        expect(direct.length, `${from} → ${to} is unreachable`).toBeGreaterThan(0);
      }
    }
  });

  it("routes the long way round rather than through a wall", () => {
    // Dining to backstage is not adjacent: the only door is off the show
    // stage, so the path has to go through it.
    const p = pathBetween("dining", "backstage");
    expect(p).toEqual([
      [0, -21],
      [-6, -25.5],
    ]);
  });

  it("gives every room the camera says it has a camera pose", () => {
    for (const id of CAMERA_ORDER) {
      expect(ROOMS[id].cam, `${id} is on the monitor with no camera`).toBeDefined();
    }
  });

  it("puts every camera inside the room it is filming", () => {
    for (const id of CAMERA_ORDER) {
      const { bounds } = ROOMS[id];
      const [x, y, z] = ROOMS[id].cam!.pos;
      expect(x, `${id} camera x`).toBeGreaterThanOrEqual(bounds.x0 - 0.5);
      expect(x, `${id} camera x`).toBeLessThanOrEqual(bounds.x1 + 0.5);
      expect(z, `${id} camera z`).toBeGreaterThanOrEqual(bounds.z0 - 0.5);
      expect(z, `${id} camera z`).toBeLessThanOrEqual(bounds.z1 + 0.5);
      // Below the ceiling, or it films the tiles from inside them.
      expect(y, `${id} camera y`).toBeLessThan(ROOMS[id].height);
    }
  });

  it("gives every camera a spot on the monitor map", () => {
    for (const id of CAMERA_ORDER) {
      const p = MAP_POINTS[id];
      expect(p, `${id} is missing from the map`).toBeDefined();
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(1);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(1);
    }
  });

  it("does not stack two map labels on top of each other", () => {
    const pts = CAMERA_ORDER.map((id) => MAP_POINTS[id]);
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
        expect(d, `${CAMERA_ORDER[i]} and ${CAMERA_ORDER[j]} overlap`).toBeGreaterThan(0.08);
      }
    }
  });
});

describe("the route graphs", () => {
  it("only ever sends someone somewhere the navmesh can reach", () => {
    for (const [kind, graph] of Object.entries(ROUTES_FOR_TEST)) {
      for (const [from, options] of Object.entries(graph)) {
        for (const to of options ?? []) {
          if (to === "office") continue; // the doorway, not a walk
          expect(
            pathBetween(from as RoomId, to as RoomId).length,
            `${kind}: ${from} → ${to} has no route`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it("ends every walker's route at one of the two office doors", () => {
    for (const kind of ["freddy", "bonnie", "chica"] as const) {
      const graph = ROUTES_FOR_TEST[kind];
      const reachesOffice = Object.values(graph).some((opts) => opts?.includes("office"));
      expect(reachesOffice, `${kind} can never actually reach you`).toBe(true);
    }
  });

  it("leaves nobody stranded in a room with no way out", () => {
    for (const [kind, graph] of Object.entries(ROUTES_FOR_TEST)) {
      if (kind === "foxy") continue; // Foxy has no graph; he has a curtain
      const reachable = new Set<string>(["stage"]);
      const queue = ["stage"];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const next of graph[cur as RoomId] ?? []) {
          if (next === "office" || reachable.has(next)) continue;
          reachable.add(next);
          queue.push(next);
        }
      }
      for (const room of reachable) {
        expect(
          (graph[room as RoomId] ?? []).length,
          `${kind} can walk into ${room} and never leave`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe("the difficulty table", () => {
  it("has an entry for every night the menu offers", () => {
    expect(NIGHTS).toHaveLength(NIGHT_COUNT);
  });

  it("never eases off as the week goes on", () => {
    for (let i = 1; i < NIGHTS.length; i++) {
      const prev = NIGHTS[i - 1];
      const cur = NIGHTS[i];
      for (const k of ["freddy", "bonnie", "chica", "foxy"] as const) {
        expect(cur[k], `night ${i + 1} ${k} is easier than night ${i}`).toBeGreaterThanOrEqual(prev[k]);
      }
    }
  });

  it("keeps every level inside the d20 the director rolls", () => {
    for (const night of NIGHTS) {
      for (const level of Object.values(night)) {
        expect(level).toBeGreaterThanOrEqual(0);
        expect(level).toBeLessThanOrEqual(20);
      }
    }
  });

  it("gives night 1 something to teach with", () => {
    // All-zeroes is the original's night 1 and it is the wrong first minute
    // for a world somebody opens from a link — see src/fnaf/README.md.
    const total = Object.values(NIGHTS[0]).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
  });
});
