/**
 * worldPhysics — the ONE set of movement constants for every world.
 *
 * Vibe City is the flagship, so its tuning is canonical: any world
 * with a walking character (City, Island Explorer, future worlds)
 * imports gravity/speeds/jump from here instead of hard-coding its
 * own. Same body, same physics, everywhere in the VibeVerse.
 */

/** Downward acceleration, m/s². */
export const GRAVITY = 24;

/** Ground speeds, m/s. */
export const WALK_SPEED = 7;
export const RUN_SPEED = 16;

/** Jetpack cruising / throttle-open speeds, m/s. */
export const FLY_SPEED = 22;
export const FLY_RUN_SPEED = 34;

/** Initial vertical velocity of a jump, m/s (apex ≈ 2.5m). */
export const JUMP_VELOCITY = 11;

/** Vertical speed clamps while airborne, m/s. */
export const MAX_RISE = 19;
export const MAX_FALL = 32;

/** Body capsule radius used for wall collision, m. */
export const PLAYER_RADIUS = 0.55;
