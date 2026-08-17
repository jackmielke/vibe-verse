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
  isWater,
  roadAt,
  shoreSDF,
  sideOfMarket,
  walkHeight,
  type Vec2,
} from "./map";

export const CITY_SEED = "vibe-francisco-v1";

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
  stats: { triangles: number; buildings: number; landmarks: number; ms: number };
}

/** One building, as the collision system sees it. */
export interface BuildingBox {
  x: number;
  z: number;
  /** Half extents in the building's own frame. */
  hw: number;
  hd: number;
  yaw: number;
  /** Ground level at its base, and the height of its roof. */
  baseY: number;
  roofY: number;
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
      roads.ribbon(s.points, 0.35, 0.1, line, walkHeight);
    }
  }
}

/* ------------------------------------------------------------------ *
 * The blocks
 * ------------------------------------------------------------------ */

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
    buildings.bandedBox(cx, base, cz, w, h, d, wall, glass, floors, rng.range(0.82, 1.0), yaw);
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
    colliders.push({ x: cx, z: cz, hw: w, hd: d, yaw, baseY: base, roofY: base + h });
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
      if (h < 24 && rng.chance(0.62)) {
        buildings.gable(p.x, base + h, p.z, hwB * 1.06, rng.range(1.8, 3.4), hdB * 1.06,
          shade(myRoof, rng.range(0.85, 1.05)), yaw + (side.along === "x" ? 0 : Math.PI / 2));
      } else {
        // A parapet, not a lid: 40 cm proud of the wall and barely wider than
        // it. The overhang used to be the loudest thing about every building.
        buildings.box(p.x, base + h, p.z, hwB * 1.012, 0.4, hdB * 1.012,
          shade(myRoof, 0.95), 1, yaw);
      }
      colliders.push({ x: p.x, z: p.z, hw: hwB, hd: hdB, yaw, baseY: base, roofY: base + h });
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
  const colliders: BuildingBox[] = [];

  buildGround(ground);
  buildStreets(roads, walks, streetLines());
  buildBlocks(buildings, colliders, rng.fork("blocks"));
  buildGreenery(green, rng.fork("trees"));
  buildWater(water);
  const landmarks = buildLandmarks(marks, colliders);

  const vertexColoured = toon(0xffffff, { vertexColors: true });
  let triangles = 0;
  for (const [name, batch, receive, cast] of [
    ["ground", ground, true, false],
    ["water", water, true, false],
    ["roads", roads, true, false],
    ["pavements", walks, true, false],
    ["buildings", buildings, true, true],
    ["greenery", green, true, true],
    ["landmarks", marks, true, true],
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
    stats: {
      triangles, buildings: colliders.length, landmarks,
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
