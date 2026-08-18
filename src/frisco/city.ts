/**
 * city.ts — builds Vibe Francisco, once, at load.
 *
 * The output is five meshes: ground, roads, pavements, buildings, and greenery.
 * That is the entire downtown. There is no streaming, no chunk queue, no level
 * of detail and no per-frame work of any kind in this file — `buildCity`
 * returns a `THREE.Group` and is never called again.
 *
 * Everything is a pure function of `map.ts` plus a seeded RNG, so the city is
 * identical on every machine and on every reload: the same corner shop is on
 * the same corner forever, which is what makes a place learnable.
 *
 * Order matters and it is the order a real city was made in: shape the land,
 * cut the streets into it, then fill what is left with buildings.
 */
import * as THREE from "three";
import { makeRng, type Rng } from "@/shared/proc/rng";
import { Batch, rgb, shade } from "./batch";
import { buildLandmarks } from "./landmarks";
import { buildCableTrack } from "./cablecar";
import { buildStreetFurniture, type SignalHead } from "./street";
import { COLORS, WALLS, addOutline, toon } from "./look";
import {
  BOUNDS,
  GRID_N,
  GRID_REACH,
  GRID_S,
  MARKET_ANGLE,
  MARKET_DIR,
  MARKET_HALF_WIDTH,
  SHORE,
  alongMarket,
  districtAt,
  groundHeight,
  isOpen,
  isRoad,
  SPAWNS,
  isWater,
  ll,
  roadAt,
  shoreSDF,
  sideOfMarket,
  walkHeight,
  type Vec2,
} from "./map";

export const CITY_SEED = "vibe-francisco-v1";

/**
 * Where the bay windows go.
 *
 * The residential districts, and not the Financial District, SoMa or the
 * Embarcadero — which is both true of the real city and the thing that keeps
 * the detail affordable.
 */
const VICTORIAN_DISTRICTS = new Set([
  "chinatown", "northbeach", "russianhill", "nobhill", "wharf", "mission", "hayes", "civic",
]);

/**
 * Where the fire escapes go.
 *
 * The pre-war districts plus Union Square and Civic Center, which are full of
 * six-storey brick with the ironwork still on the front. Not the Financial
 * District, not SoMa, not the Embarcadero: a curtain-wall tower puts its stairs
 * inside, and a fire escape on one is the sort of detail that is wrong in a way
 * you notice without being able to say why.
 */
const ESCAPE_DISTRICTS = new Set([
  "chinatown", "northbeach", "nobhill", "union", "civic", "mission", "hayes", "tenderloin",
]);

/** Blend two vertex colours. `t` of 0 is all `a`. */
function mix(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export interface CityBuild {
  group: THREE.Group;
  /** Solid boxes the player collides with, for `collision.ts`. */
  colliders: BuildingBox[];
  /** Where the lit lenses go, for `life.ts` to switch with the signal phase. */
  signals: SignalHead[];
  stats: {
    triangles: number; buildings: number; landmarks: number;
    furniture: number; parked: number; ms: number;
  };
}

/**
 * One building, as the collision system sees it.
 *
 * The two optional fields are the difference between "you can land on a
 * building" and "you can land on a rectangular building". Almost everything in
 * the generated city is a plain box and needs neither; almost everything
 * *interesting* — every tower with a setback, Salesforce, Coit Tower, the
 * Transamerica — is a shape whose footprint at the roof is not its footprint at
 * the pavement, and a collider that ignores that puts an invisible floor out in
 * mid-air around the top of it.
 */
export interface BuildingBox {
  x: number;
  z: number;
  /** Half extents at the BASE, in the building's own frame. */
  hw: number;
  hd: number;
  yaw: number;
  /** Ground level at its base, and the height of its roof. */
  baseY: number;
  roofY: number;
  /**
   * Half extents at the ROOF. Defaults to the base extents.
   *
   * This is what you stand on. A tower tapered to 82% is nearly two metres
   * narrower at the top than at the bottom on each side, and standing in that
   * margin is standing on nothing — you are outside the building you can see
   * and inside the box the collider believes in.
   */
  topHw?: number;
  topHd?: number;
  /**
   * Elliptical footprint rather than rectangular.
   *
   * Salesforce Tower is a 42 m circle and its collider was a 42 m square, so
   * the four corners — 21% of the roof area — were floor you could stand on
   * with nothing underneath. This is the bug you notice by landing on a round
   * building and finding yourself hovering beside it.
   */
  round?: boolean;
}

/* ------------------------------------------------------------------ *
 * The land
 * ------------------------------------------------------------------ */

/**
 * The ground: one heightfield over the whole map, vertex-coloured by what is
 * growing on it.
 *
 * Twelve-metre cells. Fine enough that Nob Hill is a smooth dome and coarse
 * enough that the whole 2.4 km map is 53 000 vertices — which is a rounding
 * error on a modern GPU and, more to the point, is a single mesh that is
 * uploaded once and never touched. The streets are laid on top as their own
 * geometry rather than being coloured into this, because a road edge that
 * steps in twelve-metre jumps looks like a bug and a road edge drawn as a
 * ribbon is exactly straight.
 */
function buildGround(batch: Batch): void {
  const CELL = 12;
  const x0 = BOUNDS.minX;
  const z0 = BOUNDS.minZ;
  const nx = Math.ceil((BOUNDS.maxX - x0) / CELL);
  const nz = Math.ceil((BOUNDS.maxZ - z0) / CELL);

  const grass = rgb(COLORS.grass);
  const sand = rgb(COLORS.sand);
  const rock = rgb(0x9c9384);
  /* The colour of "downtown, between the buildings", and it is deliberately
     not green.

     This layer only ever shows through in the gaps a generated city leaves —
     block courtyards, verges, the wedges where two street grids meet at an
     angle — and those gaps are everywhere. Painting them lawn-green turned the
     Financial District into a golf course with towers on it: from the air the
     dominant colour of San Francisco was grass. A dry warm grey reads as the
     back of a lot, and a park still reads as a park because `isOpen` gets the
     real green. */
  const lot = rgb(0xa9a291);

  const colourAt = (x: number, z: number, h: number): [number, number, number] => {
    const s = shoreSDF(x, z);
    /* Sand is a *beach*: low ground close to the seawall. The test used to be
       `shoreSDF < 34` on its own, which is true of everything on the far side
       of the seawall no matter how far away — so the whole of Alcatraz, twenty-
       six metres up and nine hundred metres out in the bay, came out the colour
       of a tideline. */
    if (h <= BOUNDS.seaLevel + 0.4) return sand;
    if (s < 34 && s > -70 && h < 7) return sand;
    if (isOpen(x, z)) return grass;
    const t = Math.min(1, h / 120);
    return mix(lot, rock, t);
  };

  // Build a vertex grid, then index it. Sharing vertices between cells is what
  // keeps this at 53k rather than 300k.
  const ids = new Int32Array((nx + 1) * (nz + 1));
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = x0 + i * CELL;
      const z = z0 + j * CELL;
      const h = groundHeight(x, z);
      // Central-difference normal: the toon ramp needs a real normal to band on.
      const hx = groundHeight(x + CELL, z) - groundHeight(x - CELL, z);
      const hz = groundHeight(x, z + CELL) - groundHeight(x, z - CELL);
      const n = new THREE.Vector3(-hx, 2 * CELL, -hz).normalize();
      ids[j * (nx + 1) + i] = batch.vertex(x, h, z, n.x, n.y, n.z, colourAt(x, z, h));
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = ids[j * (nx + 1) + i];
      const b = ids[j * (nx + 1) + i + 1];
      const c = ids[(j + 1) * (nx + 1) + i + 1];
      const d = ids[(j + 1) * (nx + 1) + i];
      batch.tri(a, d, c);
      batch.tri(a, c, b);
    }
  }
}

/* ------------------------------------------------------------------ *
 * The streets
 * ------------------------------------------------------------------ */

interface StreetLine {
  points: Vec2[];
  halfWidth: number;
  kind: "market" | "grid-n" | "grid-s" | "embarcadero";
}

/**
 * Enumerate every street centreline in the city.
 *
 * The grids are infinite by construction, so each line is walked from one edge
 * of the map to the other and clipped to the land — a street that runs into the
 * bay stops at the water, which is what gives the waterfront its ragged,
 * correct-looking edge without any special cases.
 */
function streetLines(): StreetLine[] {
  const out: StreetLine[] = [];
  const SAMPLE = 14;

  const walk = (
    origin: Vec2,
    dir: Vec2,
    halfWidth: number,
    kind: StreetLine["kind"],
    northOfMarket: boolean | null,
  ) => {
    // March from one side of the map to the other, collecting the runs that are
    // on land and on the right side of Market.
    const span = GRID_REACH * 2;
    let run: Vec2[] = [];
    for (let t = -span / 2; t <= span / 2; t += SAMPLE) {
      const x = origin.x + dir.x * t;
      const z = origin.z + dir.z * t;
      const inBounds =
        x > BOUNDS.minX && x < BOUNDS.maxX && z > BOUNDS.minZ && z < BOUNDS.maxZ;
      /* On land AND on the mainland side of the seawall. `isWater` alone is
         not enough now that there is an island out in the bay: Alcatraz is
         dry ground, so the grid cheerfully paved it with two of downtown's
         streets. Nothing is on the far side of the seawall except the rock. */
      const onLand = !isWater(x, z) && shoreSDF(x, z) > 0;
      const rightSide =
        northOfMarket === null
          ? true
          : northOfMarket
            ? sideOfMarket(x, z) > MARKET_HALF_WIDTH - 2
            : sideOfMarket(x, z) < -(MARKET_HALF_WIDTH - 2);
      if (inBounds && onLand && rightSide) {
        run.push({ x, z });
      } else if (run.length > 1) {
        out.push({ points: run, halfWidth, kind });
        run = [];
      } else {
        run = [];
      }
    }
    if (run.length > 1) out.push({ points: run, halfWidth, kind });
  };

  for (const [grid, kind, north] of [
    [GRID_N, "grid-n" as const, true],
    [GRID_S, "grid-s" as const, false],
  ] as const) {
    const c = Math.cos(grid.angle);
    const s = Math.sin(grid.angle);
    // Streets running along the grid's local +Z...
    const reachX = Math.ceil(GRID_REACH / grid.spacingX);
    for (let i = -reachX; i <= reachX; i++) {
      const off = i * grid.spacingX;
      walk({ x: off * c, z: off * s }, { x: -s, z: c }, grid.roadHalfWidth, kind, north);
    }
    // ...and along its local +X.
    const reachZ = Math.ceil(GRID_REACH / grid.spacingZ);
    for (let j = -reachZ; j <= reachZ; j++) {
      const off = j * grid.spacingZ;
      walk({ x: -off * s, z: off * c }, { x: c, z: s }, grid.roadHalfWidth, kind, north);
    }
  }

  // Market Street: the seam, and the only street that belongs to neither grid.
  const market: Vec2[] = [];
  for (let t = -820; t <= 1400; t += SAMPLE) {
    market.push({ x: MARKET_DIR.x * t, z: MARKET_DIR.z * t });
  }
  out.push({ points: market, halfWidth: MARKET_HALF_WIDTH, kind: "market" });

  // The Embarcadero, offset 26 m inland from the seawall.
  const emb: Vec2[] = [];
  for (let i = 0; i < SHORE.length - 1; i++) {
    const a = SHORE[i];
    const b = SHORE[i + 1];
    const steps = Math.max(2, Math.round(Math.hypot(b.x - a.x, b.z - a.z) / SAMPLE));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      // Step inland along the shore normal.
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      emb.push({ x: x + (dz / len) * -26, z: z - (dx / len) * -26 });
    }
  }
  out.push({ points: emb, halfWidth: 13, kind: "embarcadero" });

  return out;
}

function buildStreets(roads: Batch, walks: Batch, lines: StreetLine[]): void {
  const asphalt = rgb(COLORS.asphalt);
  const pave = rgb(COLORS.sidewalk);
  const line = rgb(COLORS.asphaltLine);

  for (const s of lines) {
    // The road surface, a hair above the ground so it never z-fights the hill
    // it is lying on. 6 cm is invisible and unambiguous.
    roads.ribbon(s.points, s.halfWidth, 0.06, asphalt, walkHeight);
    // Pavements as two ribbons alongside, stepped up by a kerb.
    const kerb = 0.16;
    for (const side of [1, -1]) {
      const shifted = s.points.map((p, i) => {
        const a = s.points[Math.max(0, i - 1)];
        const b = s.points[Math.min(s.points.length - 1, i + 1)];
        let dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len; dz /= len;
        const off = (s.halfWidth + 2.4) * side;
        return { x: p.x + dz * off, z: p.z - dx * off };
      });
      walks.ribbon(shifted, 2.4, kerb, pave, walkHeight);
    }
    // A centre line on the wider streets. Market gets the double yellow it has.
    if (s.halfWidth >= 11) {
      // Narrow, because a third-person camera sits a metre off the ground
      // and a 70 cm stripe fills the bottom third of the screen from there.
      roads.ribbon(s.points, 0.22, 0.09, line, walkHeight);
    }
  }
}

/**
 * Zebra crossings, at every intersection of every street.
 *
 * This is the highest-value mark on the ground in the whole world and it is
 * cheap. From the air, a grid of plain asphalt reads as a diagram; the moment
 * the junctions have crossings on them it reads as a city, because crossings
 * are the thing that says *people walk here* without drawing a single person.
 * At street level they do the other half of the job: they tell you where the
 * junction is on a road that is otherwise a uniform grey strip running downhill.
 *
 * Continental bars — thick, parallel to the direction the cars travel, arrayed
 * across the width — because that is what San Francisco paints. The ladder
 * style with bars across the road is the British one and reads wrong
 * immediately, in a way most people cannot name.
 *
 * **One quad each, not one box.** A bar is paint: three centimetres of it, on
 * a road, seen from above and never from the side. Built as boxes these were
 * twenty-eight thousand solids and a hundred and forty thousand of the
 * hundred and seventy thousand triangles were faces of a 3 cm cliff that no
 * camera in this world can ever be low enough to see. Every flat mark on the
 * ground here should be a quad; this is the only one that was not.
 */
function buildCrossings(batch: Batch): void {
  const paint = rgb(COLORS.crossing);
  for (const [grid, north] of [
    [GRID_N, true],
    [GRID_S, false],
  ] as const) {
    const c = Math.cos(grid.angle);
    const s = Math.sin(grid.angle);
    const reachX = Math.ceil(GRID_REACH / grid.spacingX);
    const reachZ = Math.ceil(GRID_REACH / grid.spacingZ);
    const hw = grid.roadHalfWidth;
    for (let i = -reachX; i <= reachX; i++) {
      for (let j = -reachZ; j <= reachZ; j++) {
        const lx = i * grid.spacingX;
        const lz = j * grid.spacingZ;
        const x = lx * c - lz * s;
        const z = lx * s + lz * c;
        if (x < BOUNDS.minX || x > BOUNDS.maxX || z < BOUNDS.minZ || z > BOUNDS.maxZ) continue;
        if (isWater(x, z)) continue;
        const side = sideOfMarket(x, z);
        if (north && side < MARKET_HALF_WIDTH + 8) continue;
        if (!north && side > -(MARKET_HALF_WIDTH + 8)) continue;
        if (alongMarket(x, z) < -950) continue;

        // The four approaches: along the grid's own axes, both ways.
        const dirs: Array<[number, number]> = [
          [c, s], [-c, -s], [-s, c], [s, -c],
        ];
        for (const [dx, dz] of dirs) {
          // Just outside the junction box, where the stop line would be.
          const ox = x + dx * (hw + 3.4);
          const oz = z + dz * (hw + 3.4);
          if (isWater(ox, oz) || !isRoad(ox, oz) || isOpen(ox, oz)) continue;
          const yaw = Math.atan2(dz, dx);
          /* The stop line, across the road just behind the crossing. This is
             where the traffic actually halts now, so its absence was a car
             stopping at nothing. */
          {
            const by = walkHeight(ox, oz) + 0.085;
            const bx2 = ox + dx * 2.6;
            const bz2 = oz + dz * 2.6;
            const ax = dx * 0.3, az = dz * 0.3;
            const sx2 = -dz * (hw - 0.5), sz2 = dx * (hw - 0.5);
            batch.quad(
              [bx2 - ax - sx2, by, bz2 - az - sz2],
              [bx2 - ax + sx2, by, bz2 - az + sz2],
              [bx2 + ax + sx2, by, bz2 + az + sz2],
              [bx2 + ax - sx2, by, bz2 + az - sz2],
              paint,
              [0, 1, 0],
            );
          }
          // Six bars across the road, parallel to the traffic.
          for (let k = -2.5; k <= 2.5; k += 1) {
            const off = (k / 2.5) * (hw - 1.2);
            const bx = ox - dz * off;
            const bz = oz + dx * off;
            const by = walkHeight(bx, bz) + 0.085;
            // Local axes of the bar: `dx,dz` is along the traffic.
            const ax = dx * 1.9, az = dz * 1.9;
            const sx = -dz * 0.42, sz = dx * 0.42;
            batch.quad(
              [bx - ax - sx, by, bz - az - sz],
              [bx - ax + sx, by, bz - az + sz],
              [bx + ax + sx, by, bz + az + sz],
              [bx + ax - sx, by, bz + az - sz],
              paint,
              [0, 1, 0],
            );
          }
        }
      }
    }
  }
}

/**
 * Dashed lane lines down the middle of the grid streets.
 *
 * `buildStreets` paints a solid centre line on anything with a half-width of
 * eleven metres or more, which is Market, the Embarcadero and the SoMa grid —
 * and leaves every downtown street, which is most of the city you walk down, as
 * an unbroken sheet of grey. From the pavement that is the difference between a
 * road and a corridor; from the air it is the difference between a street grid
 * and a set of gaps between blocks.
 *
 * Two triangles a dash, and the dash is what a real one is: three metres of
 * paint, six of nothing.
 */
function buildLaneDashes(batch: Batch): void {
  const paint = rgb(COLORS.asphaltLine);
  const DASH = 3;
  const GAP = 6.2;
  for (const [grid, north] of [
    [GRID_N, true],
    [GRID_S, false],
  ] as const) {
    const c = Math.cos(grid.angle);
    const s = Math.sin(grid.angle);
    const reachX = Math.ceil(GRID_REACH / grid.spacingX);
    const reachZ = Math.ceil(GRID_REACH / grid.spacingZ);
    const hw = grid.roadHalfWidth;
    for (let i = -reachX; i <= reachX; i++) {
      for (let j = -reachZ; j <= reachZ; j++) {
        const lx = i * grid.spacingX;
        const lz = j * grid.spacingZ;
        const x = lx * c - lz * s;
        const z = lx * s + lz * c;
        if (x < BOUNDS.minX || x > BOUNDS.maxX || z < BOUNDS.minZ || z > BOUNDS.maxZ) continue;
        const side = sideOfMarket(x, z);
        if (north && side < MARKET_HALF_WIDTH + 8) continue;
        if (!north && side > -(MARKET_HALF_WIDTH + 8)) continue;

        // The two block faces leading away from this corner, dashed from just
        // past one junction box to just before the next.
        const runs: Array<[number, number, number]> = [
          [c, s, grid.spacingX],
          [-s, c, grid.spacingZ],
        ];
        for (const [dx, dz, len] of runs) {
          for (let t = hw + 8; t < len - hw - 8; t += DASH + GAP) {
            const mx = x + dx * (t + DASH / 2);
            const mz = z + dz * (t + DASH / 2);
            if (isWater(mx, mz) || !isRoad(mx, mz) || isOpen(mx, mz)) continue;
            const y = walkHeight(mx, mz) + 0.08;
            const ax = dx * (DASH / 2), az = dz * (DASH / 2);
            const sx = -dz * 0.16, sz = dx * 0.16;
            batch.quad(
              [mx - ax - sx, y, mz - az - sz],
              [mx - ax + sx, y, mz - az + sz],
              [mx + ax + sx, y, mz + az + sz],
              [mx + ax - sx, y, mz + az - sz],
              paint,
              [0, 1, 0],
            );
          }
        }
      }
    }
  }
}

/**
 * Cars parked at the kerb.
 *
 * The single loudest thing missing from these streets, and it took a while to
 * see because what is wrong is an absence. Every kerb in San Francisco is
 * solid with parked cars — it is most of what the ground floor of the city
 * looks like — and a street with a hundred and ninety moving cars on it and
 * nothing at the edges reads as a road, not as a place people live.
 *
 * These are static. They go into the same merged mesh as everything else and
 * are never touched again, which is why there can be fifteen hundred of them
 * for the price of forty-five thousand triangles: thirty each, and no
 * simulation at all. `life.ts` is for things that move, and a parked car
 * emphatically does not.
 *
 * Four boxes, not seven. Two dark blocks under the ends do the work of four
 * wheels: from the pavement opposite — which is where these are seen from —
 * what tells you a car has wheels is the gap of daylight between the axles,
 * not the wheels themselves. One continuous skirt was the first version and it
 * made every car look like a doorstop.
 *
 * **Budgeted, and sorted by distance from the nearest place you can start.**
 * The grid reaches the bounds, so parking every kerb in the map is seventy
 * thousand cars, and the budget has to be spent somewhere. Ranking by distance
 * from Market and Montgomery was the obvious first answer and the wrong one:
 * the Mission spawn is eighteen hundred metres out, so it got none at all and
 * opened on a street with empty kerbs in both directions — the exact absence
 * this whole function exists to fix, at one of the eight places somebody is
 * most likely to see it. Ranking against `SPAWNS` puts cars wherever a player
 * can actually arrive, and downtown still wins because four spawns are in it.
 */
const PARKED_BUDGET = 1500;
/** Along-kerb pitch: a 4.5 m car plus a gap you could not actually get into. */
const PARK_PITCH = 6.4;
/** Kept clear at each end of a block, where the crossings and hydrants are. */
const PARK_CLEAR = 16;

interface ParkSlot { x: number; z: number; yaw: number; rank: number; paint: number }

/** Metres to the nearest spawn point. Projected once — this is called per slot. */
const SPAWN_XZ: Vec2[] = SPAWNS.map((s) => ll(s.lat, s.lon));
function nearestSpawn(x: number, z: number): number {
  let best = Infinity;
  for (const p of SPAWN_XZ) {
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < best) best = d;
  }
  return best;
}

/** Muted, and the same family as the moving traffic. */
const PARKED_PAINT = [
  0xd9534f, 0x4a6fa5, 0xe8c05a, 0xe8e4dc, 0x5b6878,
  0x6fa07a, 0xcf7f4a, 0x8e6fa8, 0xd8d3c6, 0x4a5766,
  0x8f5a4a, 0xb0aa9c,
] as const;

function buildParked(batch: Batch, colliders: BuildingBox[], rng: Rng): number {
  const slots: ParkSlot[] = [];

  for (const [grid, north] of [
    [GRID_N, true],
    [GRID_S, false],
  ] as const) {
    const c = Math.cos(grid.angle);
    const s = Math.sin(grid.angle);
    const reachX = Math.ceil(GRID_REACH / grid.spacingX);
    const reachZ = Math.ceil(GRID_REACH / grid.spacingZ);
    const hw = grid.roadHalfWidth;
    for (let i = -reachX; i <= reachX; i++) {
      for (let j = -reachZ; j <= reachZ; j++) {
        const lx = i * grid.spacingX;
        const lz = j * grid.spacingZ;
        const x = lx * c - lz * s;
        const z = lx * s + lz * c;
        if (x < BOUNDS.minX || x > BOUNDS.maxX || z < BOUNDS.minZ || z > BOUNDS.maxZ) continue;
        // Cheap reject before any of the expensive per-slot work.
        if (nearestSpawn(x, z) > 700) continue;
        const side = sideOfMarket(x, z);
        if (north && side < MARKET_HALF_WIDTH + 8) continue;
        if (!north && side > -(MARKET_HALF_WIDTH + 8)) continue;

        // The two block faces leading away from this corner.
        const runs: Array<[number, number, number]> = [
          [c, s, grid.spacingX],
          [-s, c, grid.spacingZ],
        ];
        for (const [dx, dz, len] of runs) {
          for (let t = PARK_CLEAR; t <= len - PARK_CLEAR; t += PARK_PITCH) {
            const px = x + dx * t;
            const pz = z + dz * t;
            if (isWater(px, pz) || !isRoad(px, pz) || isOpen(px, pz)) continue;
            for (const kerb of [1, -1] as const) {
              // Hard against the kerb: the moving traffic runs at 0.48 of the
              // half-width, so 0.82 of it leaves a clear lane between them.
              const off = hw * 0.82;
              const kx = px + dz * off * kerb;
              const kz = pz - dx * off * kerb;
              /* `isRoad` is true across Union Square and every other plaza —
                 the grid is a pure function and does not know the square is
                 there, and the open space is simply drawn on top. So the first
                 version parked forty cars in the middle of Union Square, on the
                 paving, in front of the palms. Anything placed on the road has
                 to ask `isOpen` as well. */
              if (!isRoad(kx, kz) || isWater(kx, kz) || isOpen(kx, kz)) continue;
              // A third of the spaces empty, or every kerb is a solid wall of
              // car and the street stops having a shape.
              if (!rng.chance(0.66)) continue;
              // Facing the way traffic goes on that side of the road.
              const yaw = Math.atan2(dz, dx) + (kerb > 0 ? 0 : Math.PI);
              slots.push({
                x: kx, z: kz, yaw,
                rank: nearestSpawn(kx, kz),
                paint: PARKED_PAINT[rng.int(0, PARKED_PAINT.length - 1)],
              });
            }
          }
        }
      }
    }
  }

  slots.sort((a, b) => a.rank - b.rank);
  const take = Math.min(slots.length, PARKED_BUDGET);
  for (let n = 0; n < take; n++) {
    const p = slots[n];
    const y = walkHeight(p.x, p.z);
    const paint = rgb(p.paint);
    const cs = Math.cos(p.yaw);
    const sn = Math.sin(p.yaw);
    // Two axles, with daylight between them.
    const axle = rgb(0x24262b);
    for (const end of [-1, 1] as const) {
      batch.box(
        p.x + cs * end * 1.42, y + 0.02, p.z + sn * end * 1.42,
        0.56, 0.38, 0.88, axle, 1, p.yaw,
      );
    }
    // Tapered, so the top of the body is narrower than the sills. Untapered it
    // is a shoebox, and a shoebox seen from a first-floor window — which is
    // most of where you see these from — is all roof and no shape.
    batch.box(p.x, y + 0.34, p.z, 2.25, 0.66, 0.9, paint, 0.93, p.yaw);
    /* The cabin is GLASS coloured, not a darker shade of the body. Shaded paint
       was the first version and the dark cars came out as one flat charcoal
       lump with no shape in them at all — the glazing is most of what tells you
       which way a car is facing, and a navy car with navy windows has none.
       It also sits back from the middle, which is what makes three boxes read
       as a car and not as a loaf. */
    batch.box(
      p.x - cs * 0.36, y + 1.0, p.z - sn * 0.36,
      1.0, 0.56, 0.74, mix(rgb(0x9fc9dd), paint, 0.38), 0.86, p.yaw,
    );
    colliders.push({
      x: p.x, z: p.z, hw: 2.25, hd: 0.96, yaw: p.yaw,
      baseY: y, roofY: y + 1.56,
    });
  }
  return take;
}

/* ------------------------------------------------------------------ *
 * The blocks
 * ------------------------------------------------------------------ */

/**
 * The bay window, the cornice and the stoop — a San Francisco Victorian in
 * about thirty triangles.
 *
 * This is the highest-value detail in the whole world per polygon, and it is
 * worth being clear about why. Everything else here is generic: a grid of
 * streets over hills with pastel boxes on it could be almost any western city
 * at this level of abstraction. The projecting bay window is not generic. It is
 * on tens of thousands of houses in the Mission, North Beach, the Haight and
 * the Richmond, it is the reason the streets read as *rows* rather than as
 * walls, and it is the one thing a person who has been to San Francisco will
 * notice is missing without being able to say what it was.
 *
 * The budget matters, because there are seven thousand perimeter buildings and
 * anything spent here is spent seven thousand times. A bay is five quads, the
 * cornice is a box, the stoop is a box and the door is a quad: about thirty
 * triangles, or a hundred thousand across the residential half of the city.
 * A version with a proper hipped bay roof and window mullions was four times
 * that and looked, from any distance you actually see a house at, identical.
 *
 * `out` is the outward normal in the BLOCK's local frame; the yaw rotates it
 * into the world. Getting that wrong builds the bay window into the courtyard
 * at the back, where it is both invisible and inside the neighbour.
 */
function victorianFront(
  b: Batch,
  x: number, base: number, z: number,
  hwB: number, h: number, hdB: number,
  out: Vec2,
  yaw: number,
  wall: [number, number, number],
  glass: [number, number, number],
  rng: Rng,
): void {
  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  // The outward direction in world space, and the along-facade direction.
  const ox = out.x * cs - out.z * sn;
  const oz = out.x * sn + out.z * cs;
  const facing = Math.atan2(oz, ox);
  // Half-width of the facade this bay sits on: whichever extent runs across it.
  const faceHalf = Math.abs(out.x) > 0.5 ? hdB : hwB;
  const depth = Math.abs(out.x) > 0.5 ? hwB : hdB;

  const trim = shade(wall, 1.1);
  const shadowed = shade(wall, 0.9);

  // The bay: a shallow box projecting from the facade, glazed on three sides.
  const bayHalf = Math.min(faceHalf * 0.42, 3.2);
  const proj = 0.85;
  const y0 = base + 1.1;
  const bayH = Math.max(2.2, h - 2.0);
  const bx = x + ox * (depth + proj * 0.5);
  const bz = z + oz * (depth + proj * 0.5);
  // Two courses, not three: the third is invisible at any range a house is
  // actually seen from and it is eleven thousand triangles across the city.
  b.bandedBox(bx, y0, bz, proj * 0.5, bayH, bayHalf, shadowed, glass, 2, 1, facing);
  // Its little roof, and a cornice across the whole front.
  b.box(bx, y0 + bayH, bz, proj * 0.62, 0.34, bayHalf * 1.08, trim, 1, facing);
  b.box(
    x + ox * (depth + 0.12), base + h - 0.55, z + oz * (depth + 0.12),
    0.3, 0.55, faceHalf * 1.02, trim, 1, facing,
  );

  // A stoop, off to one side of the bay, because a door in the middle of a bay
  // window is the one arrangement no Victorian has.
  const doorSide = rng.chance(0.5) ? 1 : -1;
  const dOff = bayHalf + Math.min(1.5, (faceHalf - bayHalf) * 0.5);
  const px = -oz * doorSide * dOff;
  const pz = ox * doorSide * dOff;
  b.box(x + px + ox * (depth + 0.5), base, z + pz + oz * (depth + 0.5),
    0.55, 0.85, 0.9, shade(trim, 0.96), 1, facing);
  b.box(x + px + ox * (depth + 0.06), base + 0.85, z + pz + oz * (depth + 0.06),
    0.12, 2.1, 0.55, shade(wall, 0.72), 1, facing);
}

/**
 * A ground floor that is a shop, not more of the same wall.
 *
 * Real streets are two buildings stacked: whatever is above, and a band of
 * glass, awning and signage at eye level that belongs to a different world. A
 * generated city that extrudes one facade from pavement to parapet is
 * recognisably wrong from the pavement and nowhere else, which is exactly the
 * viewpoint everybody starts in.
 *
 * Twelve triangles: a dark glazed panel set into the facade, a sloped awning
 * over it, and a sign board above that. On the street face only — a shopfront
 * facing the middle of the block is money spent on something nobody can see.
 */
function shopFront(
  b: Batch,
  x: number, base: number, z: number,
  hwB: number, hdB: number,
  out: Vec2,
  yaw: number,
  awning: [number, number, number],
  rng: Rng,
): void {
  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const ox = out.x * cs - out.z * sn;
  const oz = out.x * sn + out.z * cs;
  const facing = Math.atan2(oz, ox);
  const faceHalf = Math.abs(out.x) > 0.5 ? hdB : hwB;
  const depth = Math.abs(out.x) > 0.5 ? hwB : hdB;

  const glass = rgb(0x2f3a44);
  const w = faceHalf * 0.82;

  // The glazing, set a hair proud of the wall so it never z-fights it.
  b.box(x + ox * (depth + 0.04), base + 0.35, z + oz * (depth + 0.04),
    0.06, 2.9, w, glass, 1, facing);
  /* The awning: a slab out over the pavement. Capped at three metres of half
     width rather than running the whole frontage — a forty-metre block got a
     forty-metre awning, and on a Chinatown hill, where the building behind you
     is a storey lower than the one you are standing beside, that reads as a
     enormous orange sheet lying across the road. An awning is over a shop
     door, not over a building. */
  const ay = base + 3.35;
  const aw = Math.min(w * 0.96, 3);
  b.box(x + ox * (depth + 0.62), ay, z + oz * (depth + 0.62),
    0.7, 0.16, aw, awning, 1, facing);
  // A sign board above it, in the awning colour a shade darker.
  if (rng.chance(0.62)) {
    b.box(x + ox * (depth + 0.1), ay + 0.34, z + oz * (depth + 0.1),
      0.1, 0.62, Math.min(w * 0.7, 3.4), shade(awning, 0.82), 1, facing);
  }
}

/**
 * A fire escape.
 *
 * The single most San Francisco thing that can be bolted to a facade, and the
 * one piece of street-level detail that a flat banded wall most obviously
 * lacks. Chinatown, North Beach, the Tenderloin and the Mission are zigzagged
 * with them; downtown mostly is not, which is why this is gated on the
 * district and on the building being an old-enough height.
 *
 * The stair between two landings is a QUAD, not a box. `Batch.box` only yaws —
 * there is no pitch — so a sloped member cannot be a box at all, and the naive
 * fix of a very long thin box laid flat gives you a landing with a shelf under
 * it and no diagonal anywhere. A quad takes four arbitrary corners, so the
 * flight is two triangles and reads correctly from both sides of the street.
 *
 * About a hundred triangles each, on roughly a fifth of the low-rise
 * buildings.
 */
function fireEscape(
  b: Batch,
  x: number, base: number, z: number,
  hwB: number, h: number, hdB: number,
  out: Vec2,
  yaw: number,
  rng: Rng,
): void {
  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const ox = out.x * cs - out.z * sn;
  const oz = out.x * sn + out.z * cs;
  const facing = Math.atan2(oz, ox);
  const faceHalf = Math.abs(out.x) > 0.5 ? hdB : hwB;
  const depth = Math.abs(out.x) > 0.5 ? hwB : hdB;
  // Sideways along the facade, which is `out` turned a quarter turn.
  const sx = -oz;
  const sz = ox;

  const iron = rgb(0x4d5058);
  const rail = rgb(0x5c6068);
  const half = Math.min(1.9, faceHalf * 0.42);
  // Offset along the facade, so a row of them is not a row of identical
  // centred ladders — real ones sit wherever the stairwell happens to be.
  const shift = rng.range(-1, 1) * Math.max(0, faceHalf - half - 0.6);
  const px = x + sx * shift;
  const pz = z + sz * shift;
  // Out from the wall by the landing's depth plus a hand's breadth.
  const stand = depth + 0.82;

  // Landings start at the first floor, not the ground: the bottom flight of a
  // real one is a counterweighted ladder that hangs above head height.
  const floor = 4.2;
  const top = Math.min(h - 1.6, 26);
  let n = 0;
  for (let y = base + floor; y < top; y += floor) {
    // The landing.
    b.box(px + ox * stand, y, pz + oz * stand, 0.7, 0.1, half, iron, 1, facing);
    // Its railing, on the street side.
    b.box(px + ox * (stand + 0.66), y + 0.1, pz + oz * (stand + 0.66), 0.06, 0.9, half, rail, 1, facing);
    // The flight up to the next one, alternating which end it climbs from.
    const nextY = y + floor;
    if (nextY < top) {
      const dir = n % 2 === 0 ? 1 : -1;
      const a0x = px + ox * (depth + 0.2) + sx * half * dir;
      const a0z = pz + oz * (depth + 0.2) + sz * half * dir;
      const a1x = px + ox * (stand + 0.5) - sx * half * dir;
      const a1z = pz + oz * (stand + 0.5) - sz * half * dir;
      const w = 0.34;
      b.quad(
        [a0x - sx * w, nextY + 0.1, a0z - sz * w],
        [a1x - sx * w, y + 0.1, a1z - sz * w],
        [a1x + sx * w, y + 0.1, a1z + sz * w],
        [a0x + sx * w, nextY + 0.1, a0z + sz * w],
        iron,
      );
    }
    n++;
  }
  if (n === 0) return;
  // Two verticals tying the landings together, which is what makes it read as
  // one structure rather than a stack of shelves.
  for (const e of [-1, 1] as const) {
    b.box(
      px + ox * (stand + 0.6) + sx * half * e, base + floor - 0.4,
      pz + oz * (stand + 0.6) + sz * half * e,
      0.07, n * floor, 0.07, rail, 1, facing,
    );
  }
}

/**
 * What is actually on a roof.
 *
 * From the street, nothing — which is why it took a jetpack to notice that
 * every roof in the city was a bare slab. From two hundred metres up, roofs are
 * most of what you can see of a city, and a real one is covered in machinery:
 * lift overruns, stair bulkheads, air handling, water tanks on legs, which is
 * the specifically-San-Francisco one.
 *
 * Ten to thirty triangles on the buildings big enough to have any, which is the
 * cheapest realism in the file per unit of time spent looking at it.
 */
function roofClutter(
  b: Batch,
  cx: number, roofY: number, cz: number,
  hw: number, hd: number,
  yaw: number,
  rng: Rng,
): void {
  const metal = rgb(0x8f959d);
  const tank = rgb(0x7b6a52);
  const dark = rgb(0x5d636b);

  // A stair bulkhead: every building with a roof has one, and it is the
  // shape that reads as "this roof is reachable".
  b.box(
    cx + rng.range(-hw * 0.4, hw * 0.4), roofY, cz + rng.range(-hd * 0.4, hd * 0.4),
    Math.min(2.4, hw * 0.3), rng.range(2.2, 3.2), Math.min(2.2, hd * 0.3), metal, 1, yaw,
  );
  // Air handling: a squat wide box, sometimes two.
  const units = rng.int(1, 2);
  for (let i = 0; i < units; i++) {
    b.box(
      cx + rng.range(-hw * 0.6, hw * 0.6), roofY, cz + rng.range(-hd * 0.6, hd * 0.6),
      Math.min(1.8, hw * 0.24), rng.range(0.7, 1.3), Math.min(1.4, hd * 0.24), dark, 1, yaw,
    );
  }
  // The water tank on legs, which is the one that says San Francisco.
  if (rng.chance(0.3) && Math.min(hw, hd) > 5) {
    const tx = cx + rng.range(-hw * 0.45, hw * 0.45);
    const tz = cz + rng.range(-hd * 0.45, hd * 0.45);
    const r = Math.min(1.9, Math.min(hw, hd) * 0.26);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.78;
      b.box(tx + Math.cos(a) * r * 0.7, roofY, tz + Math.sin(a) * r * 0.7,
        0.11, 2.0, 0.11, dark);
    }
    b.cylinder(tx, roofY + 2.0, tz, r, r * 0.94, r * 1.5, 8, tank);
    b.cylinder(tx, roofY + 2.0 + r * 1.5, tz, r * 0.96, 0, r * 0.7, 8, shade(tank, 0.9), false);
  }
}

/**
 * Fill one city block with buildings.
 *
 * The block is the rectangle between four streets; buildings are laid around
 * its edge facing out, with a courtyard left in the middle, which is how a
 * dense downtown block is actually built and is much cheaper than subdividing
 * a polygon properly. A block in the Financial District gets one big tower
 * instead, because that is also true.
 */
function fillBlock(
  buildings: Batch,
  colliders: BuildingBox[],
  cx: number,
  cz: number,
  hw: number,
  hd: number,
  yaw: number,
  rng: Rng,
): void {
  if (isWater(cx, cz)) return;
  const { district, weight: raw } = districtAt(cx, cz);
  /* Every block on land gets built. `districtAt` returns a negative weight
     beyond a district's nominal radius, and cutting there left the map full of
     green holes between the neighbourhoods — downtown San Francisco does not
     have meadows in it. The weight still does its job: it decides how tall and
     how dense, so the edges of a district taper instead of stopping. */
  const weight = Math.max(0.28, raw);

  const wall = rgb(WALLS[district.palette[rng.int(0, district.palette.length - 1)]]);
  /* Glass is tinted toward its own building rather than being one global cyan.
     A single window colour across the city flattens every district into the
     same object; mixing it halfway to the wall keeps Chinatown red and the
     Financial District cold while still reading as glazing. */
  const glassBase = rgb(COLORS.window);
  const glass: [number, number, number] = [
    (glassBase[0] + wall[0]) * 0.5,
    (glassBase[1] + wall[1]) * 0.5,
    (glassBase[2] + wall[2]) * 0.5,
  ];
  const roofC = rgb(COLORS.roof);

  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const toWorld = (lx: number, lz: number): Vec2 => ({
    x: cx + lx * cs - lz * sn,
    z: cz + lx * sn + lz * cs,
  });

  const tower = rng.chance(district.towerBias * (0.55 + weight * 0.8));

  if (tower) {
    // One tower, set back from the street on all sides.
    const w = hw * rng.range(0.5, 0.78);
    const d = hd * rng.range(0.5, 0.78);
    const h = rng.range(district.minH, district.maxH) * (0.75 + weight * 0.45);
    const base = walkHeight(cx, cz);
    const floors = Math.max(3, Math.round(h / 7));
    const taper = rng.range(0.82, 1.0);
    buildings.bandedBox(cx, base, cz, w, h, d, wall, glass, floors, taper, yaw);
    // A parapet and a rooftop box, which is what makes a flat roof read as a
    // roof rather than as the top of a box.
    const towerRoof = mix(roofC, wall, 0.3);
    buildings.box(cx, base + h, cz, w * 0.92, 1.1, d * 0.92, shade(towerRoof, 1.0), 1, yaw);
    if (rng.chance(0.7)) {
      buildings.box(
        cx + rng.range(-w * 0.3, w * 0.3), base + h + 1.1, cz + rng.range(-d * 0.3, d * 0.3),
        w * rng.range(0.15, 0.32), rng.range(2.5, 7), d * rng.range(0.15, 0.32),
        shade(towerRoof, 0.9), 1, yaw,
      );
    }
    roofClutter(buildings, cx, base + h + 1.1, cz, w * taper * 0.9, d * taper * 0.9, yaw, rng);
    /* The collider tapers with the building. The parapet is 92% of the tower's
       top and is what you actually land on, so that — not `w` — is the roof
       footprint. Standing in the difference used to mean standing on air a
       metre and a half out from a fortieth-floor wall. */
    colliders.push({
      x: cx, z: cz, hw: w, hd: d, yaw, baseY: base, roofY: base + h,
      topHw: w * taper * 0.92, topHd: d * taper * 0.92,
    });
    return;
  }

  // A perimeter of shopfronts and walk-ups.
  const depth = Math.min(hw, hd) * rng.range(0.42, 0.6);
  const sides: Array<{ along: "x" | "z"; sign: number }> = [
    { along: "x", sign: -1 },
    { along: "x", sign: 1 },
    { along: "z", sign: -1 },
    { along: "z", sign: 1 },
  ];
  for (const side of sides) {
    const runLength = side.along === "x" ? hw * 2 : hd * 2;
    const count = Math.max(1, Math.round(runLength / rng.range(17, 27)));
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const along = -runLength / 2 + runLength * t;
      /* HALF the slot, times 0.94 — and the halving is the part to be careful
         with, because `hwB` below is a half-extent and the slot is a full
         width. Passing the full width here builds every shopfront at twice its
         size: neighbours interpenetrate, the block spills across the street it
         faces, and the little roof caps merge into one continuous slab that
         hangs over the road with nothing under it. From the air that reads as
         "the walls failed to render", which is a long way from the actual
         mistake. 0.94 rather than 1.0 leaves a seam between shopfronts, so a
         downtown block is a continuous street wall with joints in it rather
         than a row of detached houses. */
      const halfWidth = (runLength / count) * 0.47;
      const lx = side.along === "x" ? along : side.sign * (hw - depth / 2);
      const lz = side.along === "x" ? side.sign * (hd - depth / 2) : along;
      const p = toWorld(lx, lz);
      if (isRoad(p.x, p.z) || isOpen(p.x, p.z) || isWater(p.x, p.z)) continue;
      /* Height is skewed, not uniform, and that is what makes a street look
         like a street. A uniform range gives every building on the block the
         same storey count give or take one, and from the air the whole city
         becomes a single extruded slab with a texture on it. Squaring the roll
         keeps most of the run low — two and three storeys, which is what North
         Beach actually is — while letting the occasional one go five or six
         and break the roofline. */
      const skew = rng.next() * rng.next();
      const h =
        district.minH + (district.maxH - district.minH) * 0.52 * skew + rng.range(0, 3.5);
      const base = walkHeight(p.x, p.z);
      const hwB = side.along === "x" ? halfWidth : depth / 2;
      const hdB = side.along === "x" ? depth / 2 : halfWidth;
      const floors = Math.max(2, Math.round(h / 4.2));
      const myWall = rng.chance(0.35)
        ? rgb(WALLS[district.palette[rng.int(0, district.palette.length - 1)]])
        : wall;
      buildings.bandedBox(p.x, base, p.z, hwB, h, hdB, myWall, glass, floors, 1, yaw);
      /* The roof, tinted a third of the way toward its own building's walls.
         A single grey for every roof in the city is invisible from the street
         and is *the* dominant colour from the air — where the city is nothing
         but roofs — so a uniform one flattens every district back into the
         same beige field the wall palettes exist to break up. */
      const myRoof = mix(roofC, myWall, 0.34);
      // Low buildings get a pitched roof; it is most of what separates North
      // Beach from the Financial District at a glance.
      let roofRise = 0.4;
      if (h < 24 && rng.chance(0.62)) {
        const rise = rng.range(1.8, 3.4);
        roofRise = rise * 0.5;
        buildings.gable(p.x, base + h, p.z, hwB * 1.06, rise, hdB * 1.06,
          shade(myRoof, rng.range(0.85, 1.05)), yaw + (side.along === "x" ? 0 : Math.PI / 2));
      } else {
        // A parapet, not a lid: 40 cm proud of the wall and barely wider than
        // it. The overhang used to be the loudest thing about every building.
        buildings.box(p.x, base + h, p.z, hwB * 1.012, 0.4, hdB * 1.012,
          shade(myRoof, 0.95), 1, yaw);
      }
      /* A pitched roof is not a floor, but the alternative — a collider that
         stops at the eaves — drops you waist-deep into the gable every time you
         land on a North Beach walk-up. Half the ridge height is the compromise
         that reads right from the street and from the air. */
      /* The Victorian front, on the low-rise residential districts only.
         A bay window on a forty-metre Financial District block is a
         forty-metre bay window, and downtown does not have them anyway. */
      /* Not every house. Real blocks mix bay-fronted and flat-fronted, so
         three in four is both truer and forty thousand triangles cheaper than
         all of them. */
      const outLocalFront: Vec2 =
        side.along === "x" ? { x: 0, z: side.sign } : { x: side.sign, z: 0 };
      /* A shop on the ground floor of anything on a street — which in a
         perimeter block is all of them, since the whole point of the layout is
         that they face out. */
      if (h > 7 && rng.chance(0.78)) {
        const awn = rgb(WALLS[district.palette[rng.int(0, district.palette.length - 1)]]);
        shopFront(buildings, p.x, base, p.z, hwB, hdB, outLocalFront, yaw, shade(awn, 0.85), rng);
      }
      /* A fire escape on the older, lower districts. Downtown is a curtain
         wall with the stairs inside it; Chinatown is not. */
      if (h > 11 && h < 34 && ESCAPE_DISTRICTS.has(district.key) && rng.chance(0.46)) {
        fireEscape(buildings, p.x, base, p.z, hwB, h, hdB, outLocalFront, yaw, rng);
      }
      // Flat-roofed and tall enough to have plant on it.
      if (h >= 24) {
        roofClutter(buildings, p.x, base + h + roofRise, p.z, hwB * 0.85, hdB * 0.85, yaw, rng);
      }
      if (h < 26 && VICTORIAN_DISTRICTS.has(district.key) && rng.chance(0.74)) {
        victorianFront(buildings, p.x, base, p.z, hwB, h, hdB, outLocalFront, yaw, myWall, glass, rng);
      }
      colliders.push({
        x: p.x, z: p.z, hw: hwB, hd: hdB, yaw,
        baseY: base, roofY: base + h + roofRise,
      });
    }
  }
}

/** Walk both grids and fill every block between the streets. */
function buildBlocks(buildings: Batch, colliders: BuildingBox[], rng: Rng): void {
  for (const [grid, north] of [
    [GRID_N, true],
    [GRID_S, false],
  ] as const) {
    const c = Math.cos(grid.angle);
    const s = Math.sin(grid.angle);
    const reachX = Math.ceil(GRID_REACH / grid.spacingX);
    const reachZ = Math.ceil(GRID_REACH / grid.spacingZ);
    for (let i = -reachX; i < reachX; i++) {
      for (let j = -reachZ; j < reachZ; j++) {
        // Block centre = halfway between two streets in each direction.
        const lx = (i + 0.5) * grid.spacingX;
        const lz = (j + 0.5) * grid.spacingZ;
        const x = lx * c - lz * s;
        const z = lx * s + lz * c;
        if (x < BOUNDS.minX || x > BOUNDS.maxX || z < BOUNDS.minZ || z > BOUNDS.maxZ) continue;
        const side = sideOfMarket(x, z);
        if (north && side < MARKET_HALF_WIDTH + 8) continue;
        if (!north && side > -(MARKET_HALF_WIDTH + 8)) continue;
        /* Past the *foot* of Market the grids have no business existing —
           that end is the Ferry Building and then the bay. The other end runs
           as far as the map does, which is a change from the original 1560 m
           cut: that stopped the city dead a third of the way up Market and
           left the western third of the map as bare hillside. San Francisco
           does not have a green belt in the middle of it.

           The grids stay plausible that far out, incidentally, because they
           are the real ones: the Mission is laid out on SoMa's angle and the
           avenues are laid out on downtown's, so extending both is closer to
           the truth than stopping them. */
        const t = alongMarket(x, z);
        if (t < -950) continue;
        const hw = grid.spacingX / 2 - grid.roadHalfWidth - 3.4;
        const hd = grid.spacingZ / 2 - grid.roadHalfWidth - 3.4;
        fillBlock(buildings, colliders, x, z, hw, hd, grid.angle, rng.fork(`b:${north}:${i}:${j}`));
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Greenery
 * ------------------------------------------------------------------ */

/**
 * Street trees and park trees.
 *
 * Two cones and a trunk each. Trees are the cheapest thing in a toy city that
 * makes it feel inhabited, so there are a lot of them — and because they are
 * merged into one mesh with everything else green, a thousand of them is one
 * draw call.
 */
function buildGreenery(batch: Batch, rng: Rng): void {
  const trunk = rgb(COLORS.trunk);
  const leaf = rgb(COLORS.leaf);
  const leafDark = rgb(COLORS.leafDark);

  const plant = (x: number, z: number, scale: number) => {
    const y = walkHeight(x, z);
    batch.cylinder(x, y, z, 0.28 * scale, 0.22 * scale, 2.4 * scale, 5, trunk, false);
    batch.cylinder(x, y + 2.0 * scale, z, 2.1 * scale, 1.2 * scale, 2.4 * scale, 7, leaf);
    batch.cylinder(x, y + 3.9 * scale, z, 1.5 * scale, 0, 2.6 * scale, 7, leafDark);
  };

  // Street trees, spaced along the pavement edge.
  for (let i = 0; i < 2600; i++) {
    const x = rng.range(BOUNDS.minX, BOUNDS.maxX);
    const z = rng.range(BOUNDS.minZ, BOUNDS.maxZ);
    if (isWater(x, z)) continue;
    const r = roadAt(x, z);
    const onVerge = r.distance > r.halfWidth + 2.2 && r.distance < r.halfWidth + 4.6;
    if (!onVerge && !isOpen(x, z)) continue;
    if (isOpen(x, z) && rng.chance(0.55)) continue;
    plant(x, z, rng.range(0.8, 1.35));
  }
}

/* ------------------------------------------------------------------ *
 * Water
 * ------------------------------------------------------------------ */

/**
 * The bay: one big quad at sea level, plus a foam ribbon along the shore.
 *
 * Flat and unanimated on purpose. A toy boat sits in a painted sea, and the
 * moment the water has waves the rest of the city has to answer for not
 * having them.
 */
function buildWater(batch: Batch): void {
  const water = rgb(COLORS.water);
  const deep = rgb(COLORS.waterDeep);
  const foam = rgb(COLORS.waterFoam);
  const R = 5200;
  // A radial fan so the bay reads as deepening away from the shore.
  const centre = batch.vertex(0, BOUNDS.seaLevel - 0.05, -700, 0, 1, 0, water);
  const ring: number[] = [];
  const SEG = 48;
  for (let i = 0; i <= SEG; i++) {
    const a = (i / SEG) * Math.PI * 2;
    ring.push(batch.vertex(Math.cos(a) * R, BOUNDS.seaLevel - 0.05, -700 + Math.sin(a) * R, 0, 1, 0, deep));
  }
  // Wound so the fan faces UP. Taking the ring anticlockwise in XZ and fanning
  // (centre, i, i+1) faces the triangles DOWN — the sea was there the whole
  // time and back-face culling meant nobody could see it from the sky.
  for (let i = 0; i < SEG; i++) batch.tri(centre, ring[i + 1], ring[i]);
  // Foam where the water meets the land.
  const foamLine = SHORE.map((p, i) => {
    const a = SHORE[Math.max(0, i - 1)];
    const b = SHORE[Math.min(SHORE.length - 1, i + 1)];
    let dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    return { x: p.x + dz * 3, z: p.z - dx * 3 };
  });
  batch.ribbon(foamLine, 5, 0.08, foam, () => BOUNDS.seaLevel);
}

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

export function buildCity(): CityBuild {
  const t0 = performance.now();
  const rng = makeRng(CITY_SEED);
  const group = new THREE.Group();
  group.name = "frisco-city";

  const ground = new Batch();
  const roads = new Batch();
  const walks = new Batch();
  const buildings = new Batch();
  const green = new Batch();
  const water = new Batch();
  const marks = new Batch();
  const props = new Batch();
  const colliders: BuildingBox[] = [];

  buildGround(ground);
  const lines = streetLines();
  buildStreets(roads, walks, lines);
  buildCrossings(roads);
  buildLaneDashes(roads);
  const street = buildStreetFurniture(props, lines, rng.fork("street"));
  buildCableTrack(props);
  buildBlocks(buildings, colliders, rng.fork("blocks"));
  buildGreenery(green, rng.fork("trees"));
  buildWater(water);
  const landmarks = buildLandmarks(marks, colliders);
  /* Last, so `stats.buildings` stays a count of buildings. Fifteen hundred
     parked cars are colliders — you cannot walk through one, and you can stand
     on the roof — but reporting them as buildings would put the city at eleven
     thousand and quietly break every judgement anyone makes from that number. */
  const structures = colliders.length;
  const parked = buildParked(props, colliders, rng.fork("parked"));

  // `glow: true` — the window courses and the lamp heads light up at night.
  const vertexColoured = toon(0xffffff, { vertexColors: true, glow: true });
  let triangles = 0;
  for (const [name, batch, receive, cast] of [
    ["ground", ground, true, false],
    ["water", water, true, false],
    ["roads", roads, true, false],
    ["pavements", walks, true, false],
    ["buildings", buildings, true, true],
    ["greenery", green, true, true],
    ["landmarks", marks, true, true],
    ["props", props, true, true],
  ] as const) {
    const geo = batch.finish();
    if (!geo) continue;
    triangles += batch.triangles;
    const mesh = new THREE.Mesh(geo, vertexColoured);
    mesh.name = `frisco-${name}`;
    mesh.receiveShadow = receive;
    mesh.castShadow = cast;
    // The city never moves, so it never needs its matrix recomputed.
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
    /* The landmarks, and only the landmarks, get the cartoon outline.
       It doubles their draw and it is what separates the twelve buildings
       somebody came here to see from the three thousand that are scenery —
       an outline on everything is an outline on nothing. */
    if (name === "landmarks") {
      const shell = addOutline(mesh, 0.006);
      if (shell) {
        shell.matrixAutoUpdate = false;
        shell.updateMatrix();
      }
    }
  }

  return {
    group,
    colliders,
    signals: street.signals,
    stats: {
      triangles, buildings: structures, landmarks,
      furniture: street.placed, parked,
      ms: performance.now() - t0,
    },
  };
}

/** Free everything `buildCity` allocated. */
export function disposeCity(build: CityBuild): void {
  build.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.geometry?.dispose();
  });
  build.group.clear();
}

export { MARKET_ANGLE };
