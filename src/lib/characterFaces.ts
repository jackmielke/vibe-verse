/**
 * Faces, for wherever a character has to be somebody at avatar size.
 *
 * `characterArt` is the three-quarter portrait: right for a shop tile, useless
 * in a 28px circle, where a whole body reduces to a coloured smudge. These are
 * the same characters photographed from the same rig with the camera on the
 * head.
 *
 * ## Why they are rendered rather than cropped
 *
 * The obvious cheap version is `object-position` on the portrait we already
 * have. It does not work, and the reason is the interesting part: the portrait
 * frames a slice measured down from the top of the character, and "the top of
 * the character" is the skull only if the character is shaped like a person.
 * On a crab it is the middle of the shell, so a fixed crop that finds Monarch's
 * face photographs Pinch's back. `characterShot`'s `face` crop aims at
 * `pilot.head` — the joint the rig exposes so a hat can be parented to the
 * skull — which is the one landmark that means the same thing on a humanoid, a
 * crab, an arachnid and a hopper.
 *
 * ## What is not in here
 *
 * **Your hat.** These are per-*character* renders, and a loadout also carries a
 * hat, a flame and a jetpack. `buildProceduralPilot` takes a design id and
 * nothing else, so putting your actual outfit in the chip would mean a live
 * canvas per avatar — a WebGL context, on every page, for a 28px picture, when
 * browsers cap contexts at about sixteen and this repo already loses worlds to
 * that ceiling. The face is the part that says who you are; the hat can stay in
 * the world where you can see it.
 *
 * Rendered by `node scripts/character-shots.mjs --face`. Re-run it after
 * editing `PILOT_DESIGNS`, the same as the portraits.
 */

/* Globbed rather than sixty-three import lines. `characterArt` lists its
   imports one by one and should keep doing so — it is a curated set with
   comments explaining who is in it and why. This is not curated: it is every
   photographed character, and a hand-written copy of a directory listing is
   just a second place for one to go missing. */
const FILES = import.meta.glob("@/assets/characters/face/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

export const CHARACTER_FACES: Record<string, string> = Object.fromEntries(
  Object.entries(FILES).map(([path, url]) => [
    path.slice(path.lastIndexOf("/") + 1).replace(/\.png$/, ""),
    url,
  ]),
);

/**
 * Undefined for anything unphotographed — the GLB roster, which has a model
 * rather than a rig. Callers fall back to the character's emoji, which is the
 * same thing every one of these surfaces showed before there were faces.
 */
export const characterFace = (id: string | null | undefined): string | undefined =>
  id ? CHARACTER_FACES[id] : undefined;
