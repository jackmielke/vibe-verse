/**
 * The skin — play the island as anybody from the vibeverse.
 *
 * The royale's own character is a hand-built drop-suit rig with foot IK, a
 * glider, a wet look and forty joints of authored pose. It is also one
 * outfit. The rest of the vibeverse has a roster of seventy-odd characters
 * — the Quaternius GLBs, Vibey, the code-built cast — shared through
 * `src/lib/characters.ts` and picked once for every world through
 * `useActiveCharacter`. This system is the bridge: it reads that pick, loads
 * the rig through the same `loadCharacterRig` every other world uses, and
 * hands it to the player system, which mounts it over its own body.
 *
 * The player still SIMULATES the drop-suit — every step, every jump, the
 * foot plant, the glider — and only its meshes are hidden. That is
 * deliberate: the skin is a costume over an actor, not a replacement for the
 * actor. Nothing about movement, camera, combat or the glider changes when
 * you are a cow.
 *
 * "Drop Suit" is a choice too, kept as a flag of this world's own rather
 * than as an id in the shared roster, so choosing it here does not turn you
 * into somebody random in the city.
 */
import type { SystemFactory } from "../types";
import { findCharacter } from "@/lib/characters";
import { loadCharacterRig, type CharacterRig } from "@/lib/characterRig";
import { readActiveCharacterId, ROYALE_SUIT_KEY } from "./skinChoice";

/** Which animation the skin should be playing, from the actor's state. */
export type SkinAction = "locomotion" | "air" | "down" | "dead";

/**
 * Pure: the actor's state to the clip family the skin plays. Tested in
 * isolation; the player calls it every frame.
 */
export function skinActionFor(state: string, grounded: boolean): SkinAction {
  if (state === "dead") return "dead";
  if (state === "down") return "down";
  if (state === "skydive" || state === "glide" || state === "bus") return "air";
  if (!grounded || state === "air") return "air";
  return "locomotion";
}

interface PlayerWithSkin {
  setSkin?(rig: CharacterRig | null, characterId: string | null): void;
}

const createSkin: SystemFactory = (ctx) => {
  let current: CharacterRig | null = null;
  let currentId: string | null = null;
  let loading: string | null = null;
  let disposed = false;

  function wanted(): string | null {
    if (typeof window === "undefined") return null;
    try {
      if (localStorage.getItem(ROYALE_SUIT_KEY) === "1") return null;
    } catch {
      /* private mode: the suit */
    }
    return readActiveCharacterId();
  }

  function apply(): void {
    const id = wanted();
    if (id === currentId || id === loading) return;
    const player = ctx.services.player as unknown as PlayerWithSkin | undefined;
    if (!player?.setSkin) return;

    if (!id) {
      current?.dispose();
      current = null;
      currentId = null;
      player.setSkin(null, null);
      return;
    }

    const spec = findCharacter(id);
    loading = id;
    void loadCharacterRig(spec, {
      // A hair under the drop-suit's 1.85: the capsule is tuned to that, and a
      // skin taller than the hitbox is a skin that gets shot in the hat.
      height: 1.78,
      center: true,
      castShadow: true,
      walkSpeed: 5.9,
    })
      .then((rig) => {
        // The pick may have moved on while the GLB was in flight.
        if (disposed || wanted() !== id) {
          rig.dispose();
          return;
        }
        current?.dispose();
        current = rig;
        currentId = id;
        (ctx.services.player as unknown as PlayerWithSkin | undefined)?.setSkin?.(rig, id);
        ctx.emit("dz:skin", { id, name: spec.label });
      })
      .catch((err) => {
        console.error(`[Drop Zero] skin "${id}" failed to load:`, err);
      })
      .finally(() => {
        if (loading === id) loading = null;
      });
  }

  // Picks made in another tab, or in the locker while the world is up.
  const onChange = () => apply();
  if (typeof window !== "undefined") {
    window.addEventListener("vibe:character-changed", onChange);
    window.addEventListener("storage", onChange);
    window.addEventListener("royale:suit-changed", onChange);
  }

  return {
    name: "skin",
    update() {
      // The player publishes its service after this system boots; poll until
      // it is there, then only on change events.
      if (currentId === null && loading === null) apply();
    },
    dispose() {
      disposed = true;
      if (typeof window !== "undefined") {
        window.removeEventListener("vibe:character-changed", onChange);
        window.removeEventListener("storage", onChange);
        window.removeEventListener("royale:suit-changed", onChange);
      }
      current?.dispose();
      current = null;
    },
  };
};

export default createSkin;
