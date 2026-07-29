/**
 * Moved to `@/shared/proc/rng` — the seeded RNG and noise toolkit turned out
 * to be world-agnostic, and Vibe Island II wants the same primitives.
 *
 * Re-exported here so every existing `../math/rng` import under src/sf keeps
 * working; there is no second copy of the implementation.
 */
export * from "@/shared/proc/rng";
