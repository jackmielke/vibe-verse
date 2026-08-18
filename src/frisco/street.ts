/**
 * street.ts — the small stuff at eye level.
 *
 * Streetlights, signals, hydrants, benches, bins, bus shelters and the little
 * trolley wires over Market. None of it is visible from a jetpack and all of it
 * is the difference between "a street" and "a corridor between two extruded
 * blocks", because standing on a pavement is where a city is judged.
 *
 * **The whole file is a budget problem, and that is the interesting part.**
 * Vibe Francisco has something like two hundred kilometres of street in it. A
 * lamp post every thirty metres on both sides is thirteen thousand posts, and
 * even at thirty triangles each that is four hundred thousand triangles — half
 * the city again, for something you can only see from six feet up. So:
 *
 *  - Spacing is by street *importance*, not uniform. Market and the
 *    Embarcadero get furniture every 34 m; a numbered street in the Mission
 *    gets it every 96 m and only on one side.
 *  - Each piece is built at the smallest polygon count that still reads. A
 *    lamp is a four-sided post, a box arm and a box head: 30 triangles. A
 *    hydrant is two boxes.
 *  - There is a hard cap. `buildStreetFurniture` counts what it places and
 *    stops, and it returns the count so the caller can put it in the stats —
 *    silently truncating and calling it done is how a budget becomes a lie.
 *
 * The result is about four thousand objects and a hundred thousand triangles —
 * 12% on top of the city, for the thing that makes the city habitable. At the
 * current cadences that lands *under* the cap, which is the point: the cap is a
 * backstop against the city growing, not a truncation that is quietly happening
 * every build. `__frisco.stats().furniture` reports the real number, so the
 * difference between the two is always visible.
 */
import type { Batch } from "./batch";
import { rgb, shade } from "./batch";
import type { Vec2 } from "./map";
import { gridAxis, walkHeight } from "./map";
import type { Rng } from "@/shared/proc/rng";

/** Hard ceiling on placed objects. Reported, never silent. */
const BUDGET = 5200;

export interface FurnitureLine {
  points: Vec2[];
  halfWidth: number;
  kind: "market" | "grid-n" | "grid-s" | "embarcadero";
}

/**
 * Where one signal's lit lens goes, and which traffic it governs.
 *
 * `axis` is the grid axis of the street the signal faces down, in the sense
 * `map.stopLineAhead` uses. Two numbers is the whole interface between the
 * furniture and the traffic: everything on axis 1 goes green together, then
 * everything on axis 0, and no junction has to know about any other.
 */
export interface SignalHead {
  x: number;
  z: number;
  redY: number;
  greenY: number;
  yaw: number;
  axis: 0 | 1;
}

/** How often a street gets furniture, and on how many sides. */
function cadence(line: FurnitureLine): { every: number; sides: number[] } {
  if (line.kind === "market") return { every: 30, sides: [1, -1] };
  if (line.kind === "embarcadero") return { every: 38, sides: [1] };
  if (line.halfWidth >= 11) return { every: 46, sides: [1, -1] };
  return { every: 118, sides: [1] };
}

/** A lamp post: four-sided pole, an arm out over the road, a warm head. */
function lamp(b: Batch, x: number, z: number, toRoad: Vec2): void {
  const y = walkHeight(x, z);
  const metal = rgb(0x59606a);
  const glassy = rgb(0xf6e3b4);
  b.cylinder(x, y, z, 0.16, 0.11, 7.2, 4, metal, false);
  const ax = x + toRoad.x * 1.1;
  const az = z + toRoad.z * 1.1;
  const yaw = Math.atan2(toRoad.z, toRoad.x);
  b.box(ax, y + 7.0, az, 1.2, 0.14, 0.14, shade(metal, 1.05), 1, yaw);
  // The head glows; the pole does not. `box` has no glow parameter, so the
  // lamp is drawn as one quad face-up plus the box, and the quad carries it.
  b.box(x + toRoad.x * 2.1, y + 6.75, z + toRoad.z * 2.1, 0.5, 0.2, 0.28, glassy, 1, yaw);
  lampGlow(b, x + toRoad.x * 2.1, y + 6.64, z + toRoad.z * 2.1, yaw);
}

/** The lit underside of a lamp head — one quad, glowing. */
function lampGlow(b: Batch, x: number, y: number, z: number, yaw: number): void {
  const glassy = rgb(0xfff0c4);
  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const P = (lx: number, lz: number): [number, number, number] => [
    x + lx * cs - lz * sn, y, z + lx * sn + lz * cs,
  ];
  // Face down: wound clockwise seen from above is counter-clockwise from below.
  b.quad(P(-0.46, -0.24), P(-0.46, 0.24), P(0.46, 0.24), P(0.46, -0.24), glassy, [0, -1, 0], 1);
}

/**
 * A traffic signal: a post, a mast arm, and a three-lamp head.
 *
 * The three lenses are drawn DARK. They used to be drawn red, amber and green
 * all at once — which was right at the time, because nothing was simulating
 * traffic and a signal showing one colour would have been a signal permanently
 * lying about a junction where cars sailed straight through. Now the cars stop,
 * so the lit lens is an instanced overlay that `life.ts` switches with the
 * phase, and the static geometry is just the housing it sits in.
 *
 * Returns where the head ended up, so the overlay can be hung on it.
 */
function signal(b: Batch, x: number, z: number, toRoad: Vec2): SignalHead {
  const y = walkHeight(x, z);
  const metal = rgb(0x3c4450);
  const yaw = Math.atan2(toRoad.z, toRoad.x);
  b.cylinder(x, y, z, 0.2, 0.15, 5.6, 4, metal, false);
  b.box(x + toRoad.x * 2.2, y + 5.4, z + toRoad.z * 2.2, 2.3, 0.16, 0.16, metal, 1, yaw);
  const hx = x + toRoad.x * 4.2;
  const hz = z + toRoad.z * 4.2;
  b.box(hx, y + 4.1, hz, 0.28, 1.15, 0.22, shade(metal, 0.9), 1, yaw);
  const dark = rgb(0x22262c);
  for (const ly of [4.95, 4.6, 4.25]) {
    b.box(hx + toRoad.x * -0.16, y + ly, hz + toRoad.z * -0.16, 0.13, 0.13, 0.06, dark, 1, yaw);
  }
  return {
    x: hx + toRoad.x * -0.24,
    z: hz + toRoad.z * -0.24,
    redY: y + 4.95,
    greenY: y + 4.25,
    yaw,
    axis: 0,
  };
}

function hydrant(b: Batch, x: number, z: number): void {
  const y = walkHeight(x, z);
  const paint = rgb(0xd0512f);
  b.cylinder(x, y, z, 0.24, 0.2, 0.62, 6, paint, false);
  b.cylinder(x, y + 0.62, z, 0.26, 0.13, 0.28, 6, shade(paint, 1.08));
  b.box(x, y + 0.34, z, 0.34, 0.1, 0.1, shade(paint, 0.9));
}

function bench(b: Batch, x: number, z: number, yaw: number): void {
  const y = walkHeight(x, z);
  const wood = rgb(0x8a6a44);
  const metal = rgb(0x4a5058);
  b.box(x, y + 0.42, z, 0.9, 0.08, 0.26, wood, 1, yaw);
  b.box(x, y + 0.72, z, 0.9, 0.28, 0.06, shade(wood, 0.94), 1, yaw);
  for (const s of [-1, 1]) {
    b.box(x + Math.cos(yaw) * s * 0.8, y, z + Math.sin(yaw) * s * 0.8, 0.06, 0.42, 0.24, metal, 1, yaw);
  }
}

function bin(b: Batch, x: number, z: number): void {
  const y = walkHeight(x, z);
  const green = rgb(0x3f5f47);
  b.cylinder(x, y, z, 0.3, 0.32, 0.9, 6, green, false);
  b.cylinder(x, y + 0.9, z, 0.34, 0.28, 0.14, 6, shade(green, 1.1));
}

/** A bus shelter: a glass box with a roof and a bench under it. */
function shelter(b: Batch, x: number, z: number, yaw: number): void {
  const y = walkHeight(x, z);
  const frame = rgb(0x4a5058);
  const glass = rgb(0xbfd8e4);
  for (const s of [-1, 1]) {
    b.box(x + Math.cos(yaw) * s * 2.2, y, z + Math.sin(yaw) * s * 2.2, 0.1, 2.5, 0.1, frame, 1, yaw);
  }
  // The back panel, on the pavement side.
  const nx = -Math.sin(yaw);
  const nz = Math.cos(yaw);
  b.box(x + nx * 0.7, y + 0.4, z + nz * 0.7, 2.3, 1.9, 0.06, glass, 1, yaw);
  b.box(x, y + 2.5, z, 2.4, 0.12, 0.9, shade(frame, 1.06), 1, yaw);
  bench(b, x + nx * 0.35, z + nz * 0.35, yaw);
}

/**
 * Overhead trolley wire, which is a real and very visible feature of Market
 * Street and costs almost nothing: two thin boxes strung between poles.
 */
function trolleyWire(b: Batch, a: Vec2, c: Vec2, height: number): void {
  const wire = rgb(0x2e3238);
  const mid = { x: (a.x + c.x) / 2, z: (a.z + c.z) / 2 };
  const len = Math.hypot(c.x - a.x, c.z - a.z);
  if (len < 0.5) return;
  const yaw = Math.atan2(c.z - a.z, c.x - a.x);
  const y = (walkHeight(a.x, a.z) + walkHeight(c.x, c.z)) / 2 + height;
  for (const off of [-1.6, 1.6]) {
    b.box(
      mid.x - Math.sin(yaw) * off, y, mid.z + Math.cos(yaw) * off,
      len / 2, 0.05, 0.05, wire, 1, yaw,
    );
  }
}

/**
 * Walk every street and dress it.
 *
 * Returns how many objects were placed, so the caller can report it. If this
 * ever hits `BUDGET` the city has grown and the cadences need revisiting —
 * which is a decision, not something to discover from a frame rate.
 */
export function buildStreetFurniture(
  b: Batch,
  lines: FurnitureLine[],
  rng: Rng,
): { placed: number; signals: SignalHead[] } {
  let placed = 0;
  const signals: SignalHead[] = [];
  /* Important streets first, because the budget is spent in order and
     `streetLines()` hands them over grid-first. Left alone, four thousand lamp
     posts went onto numbered cross-streets in the Mission and Market Street —
     the one street in the city everybody walks down — got none of them. A cap
     without a priority is a lottery. */
  const order = (l: FurnitureLine) =>
    l.kind === "market" ? 0 : l.kind === "embarcadero" ? 1 : l.halfWidth >= 11 ? 2 : 3;
  const sorted = [...lines].sort((a, c) => order(a) - order(c));

  for (const line of sorted) {
    if (placed >= BUDGET) break;
    const { every, sides } = cadence(line);
    // Walk the polyline by arc length so spacing is even regardless of how
    // finely the line happens to be sampled.
    let until = rng.range(0, every);
    for (let i = 1; i < line.points.length; i++) {
      const p0 = line.points[i - 1];
      const p1 = line.points[i];
      const dx = p1.x - p0.x;
      const dz = p1.z - p0.z;
      const seg = Math.hypot(dx, dz);
      if (seg < 1e-3) continue;
      const ux = dx / seg;
      const uz = dz / seg;
      let t = until;
      while (t < seg) {
        if (placed >= BUDGET) return { placed, signals };
        const px = p0.x + ux * t;
        const pz = p0.z + uz * t;
        for (const side of sides) {
          // Just outside the kerb, on the pavement.
          const nx = uz * side;
          const nz = -ux * side;
          const off = line.halfWidth + 1.5;
          const x = px + nx * off;
          const z = pz + nz * off;
          const toRoad: Vec2 = { x: -nx, z: -nz };

          const roll = rng.next();
          if (roll < 0.72) lamp(b, x, z, toRoad);
          else if (roll < 0.8) hydrant(b, x, z);
          else if (roll < 0.86) bin(b, x, z);
          else if (roll < 0.94) bench(b, x, z, Math.atan2(uz, ux));
          else if (line.halfWidth >= 11) shelter(b, x, z, Math.atan2(uz, ux));
          else lamp(b, x, z, toRoad);
          placed++;

          // A signal at roughly every third furniture point on a wide street,
          // which lands them near enough to junctions to read as junction kit.
          if (line.halfWidth >= 11 && rng.chance(0.16)) {
            const head = signal(b, x, z, toRoad);
            // The traffic it governs runs along the line, not across it.
            head.axis = gridAxis(x, z, ux, uz);
            signals.push(head);
            placed++;
          }
        }
        if (line.kind === "market") {
          trolleyWire(b, { x: px, z: pz }, { x: px + ux * every, z: pz + uz * every }, 9.4);
          placed++;
        }
        t += every;
      }
      // Carry the leftover into the next segment so spacing does not restart at
      // every vertex of the polyline.
      until = t - seg;
    }
  }
  return { placed, signals };
}
