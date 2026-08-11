/**
 * COIL — who is in the arena.
 *
 * This is the file that makes this world part of the vibeverse rather than a
 * slither clone with a coat of paint. Every snake is one of the characters that
 * already exist here: the one you bought in the shop and are wearing rides the
 * front of yours, and the rest of the arena is drawn from the same cast, with
 * their own names on the leaderboard and their own accent colour down the body.
 *
 * Two consequences worth stating:
 *
 * - The leaderboard reads as people. "Sable — 340" is a thing that happened to
 *   somebody; "Bot 12 — 340" is a benchmark.
 * - Buying a character in the arcade changes something you can see here, which
 *   is the first time a cosmetic in this building has been visible in a world
 *   that is not made of Three.js.
 *
 * The portraits are the ones the shop uses — real renders of the real rig, made
 * by `scripts/character-shots.mjs` — so a snake cannot flatter a design or fall
 * behind a change to it.
 */
import { CHARACTER_ART, characterArt } from "@/lib/characterArt";
import { findCharacter } from "@/lib/characters";
import { getWardrobeState } from "@/lib/wardrobe";
import type { Rng } from "./rng";

/**
 * The cast the bots are drawn from: everybody with a portrait.
 *
 * Deliberately not the whole sixty-odd roster. The free characters are GLBs
 * with no 2D art, and a snake wearing a blank head next to one wearing Sable
 * looks like a bug rather than a choice — see `headFor`, which does have a
 * fallback, but it is for the player who has equipped one of those, not
 * something to fill an arena with.
 */
export const PORTRAIT_IDS: string[] = Object.keys(CHARACTER_ART).sort();

export interface Look {
  charId: string;
  name: string;
  color: string;
  /** Portrait URL, or undefined for a character with no 2D art. */
  art?: string;
  /** The fallback when there is no portrait: the character's own emoji. */
  emoji: string;
}

export function lookFor(charId: string): Look {
  const spec = findCharacter(charId);
  return {
    charId: spec.id,
    name: spec.label,
    color: spec.accent || "#eaeaf0",
    art: characterArt(spec.id),
    emoji: spec.emoji || "✦",
  };
}

/**
 * What the player is wearing.
 *
 * Read from the wardrobe's cache, which answers instantly and reconciles with
 * the server later — a world builds its player on the frame it mounts and
 * cannot wait on a round trip. If they have never picked anything, they get
 * Flux, which is the vibeverse's default face everywhere else too.
 */
export function playerLook(): Look {
  const equipped = getWardrobeState().loadout.character;
  return lookFor(equipped || "flux");
}

/**
 * Pick `count` distinct characters for the bots, never including the player's.
 *
 * Distinct because two identical snakes on one leaderboard is a bug report, and
 * excluding the player's because the whole point is that yours is *yours*.
 */
export function botLooks(count: number, avoid: string, rng: Rng): Look[] {
  const pool = PORTRAIT_IDS.filter((id) => id !== avoid);
  // Fisher–Yates, so a short roster is not always the same alphabetical prefix.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const out: Look[] = [];
  for (let i = 0; i < count; i++) {
    if (i < pool.length) {
      out.push(lookFor(pool[i]));
    } else {
      // More bots than portraits is a legal setting. Reuse a face, but never a
      // name — the leaderboard has to stay readable.
      const base = lookFor(pool[i % pool.length]);
      out.push({ ...base, name: `${base.name} ${Math.floor(i / pool.length) + 1}` });
    }
  }
  return out;
}
