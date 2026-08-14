/**
 * Card art that moves — a few seconds of a world actually being played.
 *
 * A screenshot of a game is a picture of a game not being played. It shows the
 * art and hides the only thing anybody wants to know, which is what it feels
 * like to move in there. These are recordings of the real thing: no editing, no
 * capture card, no human — the world plays itself and we film it.
 *
 * ## Separate from `art.ts`, and only ever an upgrade
 *
 * Every world keeps its still, and the still is what loads. This map is
 * consulted on hover, so a visitor scrolling the grid downloads none of it. At
 * about 120 KB each that matters: fifty-two of these on the front door would be
 * six megabytes to look at a page whose whole argument is that it opens
 * instantly.
 *
 * A world in here without an entry in `art.ts` would be a card that is blank
 * until you hover it, so this map is strictly a superset relationship in the
 * other direction — `src/test/worldMotion.test.ts` asserts it.
 *
 * ## Which worlds can be in here
 *
 * Only worlds that do something without a player. COIL hands its snake to an AI
 * brain under `?shot` and respawns it on death, so the arena is always busy;
 * that mode was built for the still captures and it is exactly what a recording
 * needs. A world that waits at a title screen records a title screen.
 *
 *   node scripts/route-gif.mjs "/coil?shot" src/assets/worlds/coil.gif \
 *     --ms 2600 --width 320 --fps 12.5 --colors 64
 *
 * Re-record when the world changes enough that its card starts lying — the same
 * rule the stills follow, one step livelier.
 */
import coilMotion from "@/assets/worlds/coil.gif";

export const WORLD_MOTION: Record<string, string> = {
  coil: coilMotion,
};

/** The moving version of a world's card, when there is one. */
export const motionFor = (key: string): string | undefined => WORLD_MOTION[key];
