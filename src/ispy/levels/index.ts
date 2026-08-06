/**
 * The levels.
 *
 * Each one is a hand-authored beat map with its own tuning, palette set,
 * background bars and mode order — and each is set somewhere in the vibeverse,
 * so playing through the list is a tour of the place in two dimensions.
 *
 * `build()` is called lazily, once, when a level is chosen. A level is a few
 * thousand plain objects, and eleven of them at boot for the ten you are not
 * playing would be eleven times the work for no reason.
 */
import type { Level } from "../types";
import { buildISpy } from "./ispy";
import {
  buildAfterparty, buildCardboard, buildFractalHall, buildFreeFall, buildGenesis,
  buildGrandPrix, buildHydro, buildLongSilence, buildNightShift, buildUnit7,
} from "./worlds";

export interface LevelDef {
  id: string;
  name: string;
  world: string;
  tagline: string;
  build: () => Level;
}

/** Ordered gently-to-hardest-ish, which is also roughly shortest-to-longest. */
const BUILDERS = [
  buildCardboard,
  buildUnit7,
  buildLongSilence,
  buildNightShift,
  buildGenesis,
  buildHydro,
  buildFreeFall,
  buildFractalHall,
  buildISpy,
  buildGrandPrix,
  buildAfterparty,
];

/**
 * The registry, built by asking each level for its own name.
 *
 * The card metadata lives in the level file next to the score it describes, so
 * there is exactly one place a level says what it is called and where it is
 * set. A second list would be a list that goes stale the first time somebody
 * renames one.
 */
export const LEVELS: LevelDef[] = BUILDERS.map((build) => {
  const l = build();
  return { id: l.id, name: l.name, world: l.world, tagline: l.tagline, build };
});

export function levelById(id: string | undefined): LevelDef {
  return LEVELS.find((l) => l.id === id) ?? LEVELS[0];
}
