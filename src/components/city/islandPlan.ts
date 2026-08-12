/**
 * islandPlan — where everything on Vibe Island is, in one table.
 *
 * ## Why this file exists
 *
 * Two reasons, and the second is the important one.
 *
 * The first is that the island's coordinates were spread across two files and
 * repeated inside them. The graffiti wall's position appeared three times in
 * `City.tsx` alone — once to place it, once to register it as a landmark, once
 * in the proximity check that opens it — and moving it meant finding all three.
 * They are all here now, once.
 *
 * The second is that Vibe Island had no plan. Everything on it was placed
 * wherever there was room at the time, so from the air it read as a green disc
 * with objects sprinkled on it: two shops sitting at angles in the middle of a
 * lawn, a painted road cross that nothing was built along, thirteen things
 * crammed into the southern quarter and two empty quarters opposite. Every
 * individual object was fine. The town was not a town.
 *
 * ## The plan
 *
 * A village green with four roads off it, and every road going somewhere:
 *
 *   - **The plaza** (centre). Jerry, the pond, the benches. Everything is
 *     within sight of it, which is what makes an island this size legible.
 *   - **The Approach** (north). You arrive here: the welcome arch straddles the
 *     road, Mission Control and the Studio Embassy face each other across it,
 *     and it runs out to the beacon on the north rim.
 *   - **The High Street** (south). Shops and stalls flanking the road,
 *     alternating sides so you always have a frontage on one hand, ending at
 *     the Character Studio — a lit hologram at the end of the street.
 *   - **Trader Joe's** (west) and **Ninja's Palace** (east) sit square on their
 *     roads at the far end, so each road runs into a door. A building at the end
 *     of a street is the oldest trick there is for making a street read as one.
 *   - **Four quarters** in the green between the roads, one feature each: the
 *     Spring (NE), the Bonfire (NW), the Grove (SW), the Yard (SE).
 *
 * ## Constraints worth knowing before you move anything
 *
 *   - The **zipline** rings the island at r = 42, at head height. Anything tall
 *     has to sit wholly inside or wholly outside that circle or the cable goes
 *     through it. That is why the two shops stop at r ≈ 40 and the windmill
 *     starts at r ≈ 43.
 *   - The **walkable cap** ends at r = 54 (the collision strips in
 *     `cardboardIsland`), and grass runs a little past that.
 *   - `ROAD.arm` lengths are used twice: to paint the roads into the ground
 *     texture, and to keep grass off them. Change one and the other follows;
 *     that is the point of them being here.
 */

/** Island-local (x, z). The island's own origin is the plaza centre. */
export interface Spot {
  x: number;
  z: number;
}

/**
 * The road cross.
 *
 * Arms are measured from the island centre, so an arm of 26 reaches from the
 * plaza (r = 11) out to r = 26. They are deliberately different lengths — the
 * east and west arms stop at a shop door, the north and south arms run further
 * out to the beacon and the Character Studio.
 */
export const ROAD = {
  /** Half-width of the painted road surface, metres. */
  half: 4,
  /** Grass thins to nothing over this distance beside the road. */
  verge: 1.6,
  /**
   * Arms from the island centre, so an arm of 27 reaches from the plaza
   * (r = 11) out to r = 27.
   *
   * Deliberately unequal. North and south are avenues and run all the way to
   * the promenade; east and west are short spurs that stop at a shop door.
   */
  arm: { north: 46, south: 46, east: 27, west: 27 },
  /**
   * The promenade: a walk right round the rim, joining the two avenues.
   *
   * Before this the four roads dead-ended in open grass and the outer third of
   * the island was blank lawn nobody had a reason to cross. A ring path gives
   * the rim a purpose, turns the island into a circuit you can walk, and — the
   * part that ties it together — the zipline runs directly above it at the same
   * radius, so the cable is following the road rather than cutting across the
   * place at a random distance from the middle.
   *
   * Anything tall has to stay inside this radius or wholly outside it; see the
   * note on the zipline at the top of this file.
   */
  ring: { r: 46, half: 2.6 },
} as const;

export const PLAZA = { x: 0, z: 0, r: 11 } as const;

/** Where a visitor lands: inside the plaza, at its south gate, facing in. */
export const SPAWN: Spot = { x: 0, z: 7 };

/**
 * The site plan.
 *
 * Grouped by quarter rather than alphabetically, because the grouping *is* the
 * design — if you are adding something, the question to answer first is which
 * quarter it belongs to.
 */
export const SITE = {
  // ---- The two road-terminus shops --------------------------------
  // Centres chosen so each front door lands just past the end of its road
  // arm, and so the far wall stops short of the zipline circle at r = 42.
  traderJoes: { x: -33, z: 0 },
  ninjasPalace: { x: 33, z: 0 },
  ninjaPortal: { x: 33, z: -13 },

  // ---- The Approach (north avenue) --------------------------------
  welcomeArch: { x: 0, z: -20 },
  missionControl: { x: -11, z: -27 },
  studioEmbassy: { x: 11, z: -27 },
  beacon: { x: 0, z: -40 },

  // ---- The High Street (south avenue) -----------------------------
  // Alternating sides, walking out from the plaza. Frontages are at |x| ≈ 10,
  // which clears the road (half 4) and its verge (1.6) with room to stand.
  newsstand: { x: -10, z: 15 },
  snackFe: { x: 12, z: 19 },
  rosterBoard: { x: -10, z: 24 },
  vibeShop: { x: 11, z: 28 },
  makerPortal: { x: -11, z: 31 },
  arcade: { x: 10, z: 33 },
  rpsTable: { x: -9, z: 36 },
  characterStudio: { x: 0, z: 39 },

  // ---- The Spring (north-east quarter) ----------------------------
  pool: { x: 26, z: -24 },
  /* Pulled in from the rim so the windmill's tower clears the zipline, which
     now rings the island at the promenade's radius. */
  windmill: { x: 36, z: -19 },

  // ---- The Bonfire (north-west quarter) ---------------------------
  firewall: { x: -33, z: -19 },
  swing: { x: -24, z: -27 },
  /** The floating paper lantern — a position in 3D, unlike everything else. */
  lantern: { x: -19, y: 12, z: -13 },

  // ---- The Grove (south-west quarter) -----------------------------
  dreamTree: { x: -27, z: 21 },
  wishGarden: { x: -20, z: 30 },
  wishSites: { x: -23, z: 34 },
  karts: { x: -19, z: 11 },

  // ---- The Yard (south-east quarter) ------------------------------
  cardboardTv: { x: 27, z: 21 },
  graffitiWall: { x: 22, z: 30 },
  radio: { x: 30, z: 12 },

  // ---- Rim --------------------------------------------------------
  skiGate: { x: 43, z: 12 },
} as const;

/**
 * How much grass grows at an island-local point, 0..1.
 *
 * Lives here rather than in `cardboardIsland` because it is a fact about the
 * *plan* — where the hard surfaces and the roads are — and the ground texture
 * that paints those roads needs to agree with it exactly. Both read `ROAD`.
 *
 * `hard` is the list of things with a floor: pads and building footprints,
 * where the answer is a flat zero. Everything else feathers.
 */
export function makeGrassDensity(hard: {
  circles: Array<[number, number, number]>;
  rects: Array<[number, number, number, number]>;
}): (x: number, z: number) => number {
  const feather = (dist: number) => Math.max(0, Math.min(1, dist / ROAD.verge));
  return (x, z) => {
    // Distance out of the road cross. Each arm is a capsule from the origin,
    // so a point is "on the road" if it is within `half` of the arm's line AND
    // no further out than the arm is long.
    const onArm = (across: number, along: number, len: number) =>
      along >= 0 && along <= len ? Math.abs(across) : Infinity;
    let d = feather(
      Math.min(
        onArm(x, -z, ROAD.arm.north),
        onArm(x, z, ROAD.arm.south),
        onArm(z, x, ROAD.arm.east),
        onArm(z, -x, ROAD.arm.west),
      ) - ROAD.half,
    );
    if (d <= 0) return 0;
    // The promenade — distance from the ring itself, not from its centre.
    d = Math.min(d, feather(Math.abs(Math.hypot(x, z) - ROAD.ring.r) - ROAD.ring.half));
    if (d <= 0) return 0;
    for (const [cx, cz, r] of hard.circles) {
      d = Math.min(d, feather(Math.hypot(x - cx, z - cz) - r));
      if (d <= 0) return 0;
    }
    for (const [rx, rz, hw, hd] of hard.rects) {
      // Outside distance from an axis-aligned box; inside, at least one axis
      // goes negative and `feather` clamps the result to zero.
      d = Math.min(d, feather(Math.max(Math.abs(x - rx) - hw, Math.abs(z - rz) - hd)));
      if (d <= 0) return 0;
    }
    return d;
  };
}
