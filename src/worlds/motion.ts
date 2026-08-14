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
import blobMotion from "@/assets/worlds/blob.gif";
import coilMotion from "@/assets/worlds/coil.gif";
import fnafMotion from "@/assets/worlds/fnaf.gif";
import golfMotion from "@/assets/worlds/golf.gif";
import iSpyMotion from "@/assets/worlds/i-spy.gif";
import island2Motion from "@/assets/worlds/island-2.gif";
import runMotion from "@/assets/worlds/run.gif";

/**
 * Seven, out of fourteen worlds that were tried.
 *
 * The list is a *result*, not a choice. `node scripts/world-gifs.mjs` runs
 * every world with a `?shot` mode through the recorder and the recorder refuses
 * anything under eight distinct frames, so what is in here is exactly what
 * turned out to move on its own:
 *
 *   too still  home-alone (6 frames), sf (3), san-palmas (2) — the camera sits
 *              still and nothing walks past
 *   nothing    splash-royale, drop-zero — their `?shot` mode is for taking a
 *              still, and it does that job perfectly
 *   no canvas  seafair, 2048 — drawn in the DOM, so there is nothing to read
 *
 * Which is the answer to "why not all of them": having a `?shot` hook is not
 * the same as having an attract mode, and no amount of wanting makes a static
 * hallway animate.
 */
export const WORLD_MOTION: Record<string, string> = {
  blob: blobMotion,
  coil: coilMotion,
  fnaf: fnafMotion,
  golf: golfMotion,
  "i-spy": iSpyMotion,
  "island-2": island2Motion,
  run: runMotion,
};

/** The moving version of a world's card, when there is one. */
export const motionFor = (key: string): string | undefined => WORLD_MOTION[key];
