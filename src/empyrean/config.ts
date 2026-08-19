/**
 * The numbers the whole world agrees on.
 *
 * Everything here is metres. The scale is chosen against the movement
 * constants in `@/lib/worldPhysics` rather than against the reference
 * painting: a jetpack cruises at 22 m/s and boosts at 34, a body walks at 7
 * and runs at 16.
 *
 * ## Why the island got four times bigger
 *
 * The first build was a 310 m disc with sixty boxes on it. As a picture it was
 * finished; as a *place* it was a diorama — there was nowhere to walk, so
 * there was nothing to do but fly, and a world where walking is pointless is a
 * world with one verb in it.
 *
 * 680 m across is the smallest thing that is honestly a city: eight blocks
 * corner to corner, ninety seconds to cross on foot at a walk, twenty seconds
 * on the jetpack. Big enough that the far side is somewhere you go, small
 * enough that you always know where you are — which is the trade every good
 * open-world map makes and the reason they are all smaller than they feel.
 *
 * The silhouette survives the change because everything scaled with it: the
 * keel is deeper, the island floats higher, the lake is wider, and the ranges
 * are still capped below the plaza so the city is never behind a mountain.
 */

/** Height of the island's main deck above the snow. */
export const ISLAND_Y = 620;

/** Radius of the city deck, out to the rim wall. */
export const PLATEAU_R = 340;

/**
 * How far the rock hangs below the deck, tip included.
 *
 * Deep on purpose: the reference is a spike longer than the city is tall, and
 * shortening it turns the island into a plate.
 */
export const KEEL_DEPTH = 560;

/** The frozen lake the island hangs over, centred on the origin. */
export const LAKE_R = 1500;

/** Where the ground is. The lake surface sits fractionally above it. */
export const GROUND_Y = 0;
export const WATER_Y = 0.35;

/** Outer edge of the snow field — past this there is only mountain and haze. */
export const WORLD_R = 9000;

/** Anything below this has left the world and gets put back on the deck. */
export const KILL_Y = -400;

/* -------------------------------------------------------------------------
 * The decks
 * ---------------------------------------------------------------------- */

/**
 * The city is on four levels and you can walk between all of them.
 *
 * Level 0 is the deck the streets are on. The three below it are promenade
 * rings cut into the rim — sixteen metres wide, stepping out and down, joined
 * by stairs at the eight avenue ends. They exist because the best thing about
 * living on a floating island is standing at the edge of it, and a single
 * guard rail around one disc gives you exactly one place to do that.
 */
export const DECKS = [
  { y: ISLAND_Y, outer: PLATEAU_R, width: PLATEAU_R },
  { y: ISLAND_Y - 22, outer: 362, width: 18 },
  { y: ISLAND_Y - 46, outer: 382, width: 16 },
  { y: ISLAND_Y - 72, outer: 400, width: 14 },
] as const;

/**
 * The gap between one promenade's inner edge and the one above's outer edge.
 *
 * Non-zero on purpose: the rings must not overlap in plan, or a body standing
 * on the lower one is also standing on the upper one and `supportAt` has to
 * pick, which it will get wrong exactly where somebody is looking over a rail.
 */
export const PROMENADE_GAP = 4;

/** Height of the parapet along every open edge. Waist-high on a 1.8 m body. */
export const PARAPET_H = 1.1;

/* -------------------------------------------------------------------------
 * Where you arrive
 * ---------------------------------------------------------------------- */

/**
 * The south end of the Halo, looking up the avenue at the Beacon.
 *
 * Yaw 0 is forward = -Z in this codebase's convention, which from the +Z side
 * of the plaza points at the middle of the city. It was Math.PI in the first
 * build and the world opened with your back to everything it is about.
 */
export const SPAWN = { x: 0, y: ISLAND_Y + 0.2, z: 78, yaw: 0 };
