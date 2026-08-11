/**
 * The marks that are the Vibeverse, in one place.
 *
 * `src/assets/brand/README.md` has told people to reference the marks through
 * this file for a while; the file did not exist, so every surface imported the
 * asset JSON directly and there was no single place to look when one of them
 * changed. This is that place.
 *
 * ## What is actually here, and what is not
 *
 * The README documents two files. Only one of them exists:
 *
 * - **`vibe-wink-glass.png`** — the iridescent glass render. 327 KB, served
 *   from the asset CDN rather than from our own origin. Present.
 * - **`vibe-wink-white.svg`** — the flat white mark, which the README says is
 *   "what you reach for … when the mark has to be 16 px". **Missing.**
 *
 * That gap is not cosmetic. Because the small mark does not exist, the 327 KB
 * glass render is what draws the wink beside a wallet balance at *eleven
 * pixels* — a third of a megabyte, off a third origin, to fill 121 px² . The
 * fix is one exported SVG, not code: drop it in beside the README, point
 * `WINK_FLAT` at it, and `VibeWink` will use it below `GLASS_MIN_PX` on its
 * own.
 *
 * The rule that stops this being fixed the wrong way is in that README and it
 * is a good one: **never redraw the wink.** A hand-traced logo is a
 * slightly-wrong logo, and slightly-wrong is worse than absent — so this file
 * declares the missing asset rather than approximating it.
 */
import winkGlass from "@/assets/brand/vibe-wink-glass.png.asset.json";

/** The glass render. A hero asset: dark, quiet grounds and generous sizes. */
export const WINK_GLASS: string = winkGlass.url;

/** Its intrinsic pixel size, for `width`/`height` so nothing reflows. */
export const WINK_GLASS_INTRINSIC = 512;

/**
 * The flat one-colour mark, for small sizes and busy grounds.
 *
 * `null` until somebody exports it. Everything that needs it degrades to the
 * glass render, which is heavy but correct — the alternative is drawing a
 * shape that is nearly the logo, which the brand rules rule out for reasons
 * worth agreeing with.
 */
export const WINK_FLAT: string | null = null;

/**
 * Below this, the glass render is doing no work a flat mark could not do.
 *
 * 48 px is where the iridescence stops being legible — the lightning eyes and
 * the curl of the smile land on about two pixels each — so anything smaller is
 * paying a hero asset's price for a silhouette.
 */
export const GLASS_MIN_PX = 48;

/** Which file a mark of this size should use. */
export const winkSrcFor = (size: number): string =>
  size < GLASS_MIN_PX && WINK_FLAT ? WINK_FLAT : WINK_GLASS;
