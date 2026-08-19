/**
 * The numbers the whole world agrees on.
 *
 * Everything here is metres. The scale was chosen against the movement
 * constants in `@/lib/worldPhysics` rather than against the reference
 * painting: a jetpack cruises at 22 m/s and climbs at 19, so the drop from
 * the plaza to the ice is a deliberate twenty-five seconds of falling and the
 * lake is about a minute across. Bigger than this and the place stops being
 * somewhere you can cross; smaller and the island stops being enormous, which
 * is the only thing the painting is really about.
 */

/** Height of the island's plaza deck above the snow. */
export const ISLAND_Y = 420;

/** Radius of the flat top of the island, before the terraces step down. */
export const PLATEAU_R = 155;

/** How far the rock hangs below the plaza, tip included. Deep: the reference
 *  is a spike longer than the city is tall, and shortening it turns the island
 *  into a plate. */
export const KEEL_DEPTH = 380;

/** The frozen lake the island hangs over, centred on the origin. */
export const LAKE_R = 900;

/** Where the ground is. The lake surface sits fractionally above it. */
export const GROUND_Y = 0;
export const WATER_Y = 0.35;

/** Outer edge of the snow field — past this there is only mountain and haze. */
export const WORLD_R = 6000;

/** Anything below this has left the world and gets put back on the plaza. */
export const KILL_Y = -260;

/**
 * Where you arrive: the southern lip of the plaza, looking in at the towers.
 *
 * Yaw 0 is forward = -Z in this codebase's convention, which from the +Z rim
 * points at the middle of the city. It was Math.PI in the first build and the
 * world therefore opened with your back to everything it is about.
 */
export const SPAWN = { x: 0, y: ISLAND_Y + 1, z: PLATEAU_R - 26, yaw: 0 };
