/**
 * Portraits, keyed by character id.
 *
 * Same idea as `src/worlds/art.ts` one level down: the data about what is for
 * sale lives in `characterShop.ts`, which is imported by things that must stay
 * light, and the pictures live here so importing a price does not drag half a
 * megabyte of PNG into a chunk.
 *
 * Every image is a render of the real rig, produced by
 * `node scripts/character-shots.mjs`. Nobody draws these by hand, which is the
 * point: a portrait cannot flatter a design or fall behind a change to it.
 * Re-run the script after editing `PILOT_DESIGNS` — a stale portrait is the
 * one way a character can lie about itself, because everything else you see of
 * it is built at runtime from the same table.
 *
 * The backgrounds are transparent. The tint under a portrait is CSS, so the
 * violet shelf, the starfield grid and whatever comes next all share one file
 * per character instead of one file per character per surface.
 */
import auroraArt from "@/assets/characters/aurora.png";
import bumbleArt from "@/assets/characters/bumble.png";
import chromeArt from "@/assets/characters/chrome.png";
import grimlockArt from "@/assets/characters/grimlock.png";
import pixelArt from "@/assets/characters/pixel.png";
import sableArt from "@/assets/characters/sable.png";
import spaceRexArt from "@/assets/characters/space-rex.png";

export const CHARACTER_ART: Record<string, string> = {
  aurora: auroraArt,
  bumble: bumbleArt,
  chrome: chromeArt,
  grimlock: grimlockArt,
  pixel: pixelArt,
  sable: sableArt,
  "space-rex": spaceRexArt,
};

/**
 * Undefined for anything unphotographed, which callers render as a drawn
 * fallback rather than a broken image. The free roster is sixty-odd GLBs and
 * is deliberately not in here — this is the shop's art, not the world's.
 */
export const characterArt = (id: string | null | undefined): string | undefined =>
  id ? CHARACTER_ART[id] : undefined;
