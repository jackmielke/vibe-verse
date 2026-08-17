/**
 * useActiveCharacter — single source of truth for "which 3D character
 * am I playing as". Worlds (City, Lobby, HubV2, Profile, the LogIn
 * dropdown emoji in the top-right) all read/write through this hook so
 * picking a character anywhere updates everywhere.
 *
 * Storage:
 *   localStorage.lobby.character — canonical id
 *   localStorage.city.character  — mirrored for legacy City reader
 *   vibe_loadout.char_id         — the same fact, about a person
 *
 * The local copy stays canonical *for rendering*, and that is deliberate: a
 * world builds its player model on the frame it mounts and cannot wait on a
 * round trip, and a visitor with no account at all still gets to pick one.
 * The server copy exists because the arcade sells characters now, and a
 * purchase your laptop remembers and your phone does not is not a purchase.
 *
 * So: every pick writes both, and a signed-in session adopts the server's
 * answer once, on the first refresh that actually reaches the server.
 *
 * Updates fan out via a window CustomEvent so other components in the
 * same tab re-render immediately (the native `storage` event only fires
 * across tabs).
 */
import { useEffect, useState, useCallback } from "react";
import { CHARACTERS, findCharacter, type CharSpec } from "@/lib/characters";
import {
  DEFAULT_LOADOUT,
  SERVER_UNSET_CHARACTER,
  equip,
  owns,
  subscribeWardrobe,
  type WardrobeState,
} from "@/lib/wardrobe";
import { SHOP_CHARACTERS } from "@/lib/characterShop";


const LS_KEY = "lobby.character";
const LS_KEY_CITY = "city.character";
const EVT = "vibe:character-changed";

function readId(): string {
  /* The app's default, not the column's — see SERVER_UNSET_CHARACTER. This is
     the one that decides who a first-time visitor actually is, before any
     wardrobe fetch has landed, so it is the answer to "who shows up". */
  if (typeof window === "undefined") return DEFAULT_LOADOUT.character;
  return (
    localStorage.getItem(LS_KEY) ??
    localStorage.getItem(LS_KEY_CITY) ??
    DEFAULT_LOADOUT.character
  );
}

/* Module-level rather than per-component, because the adoption below has to
   happen once per page load and not once per mount — the hub alone calls this
   hook from five places, and five components racing to adopt the same value
   would each fire their own write. */
let adopted = false;
let pickedThisSession = false;

/** Write the local copy and tell the tab. No network. */
function writeLocal(nextId: string): void {
  try {
    localStorage.setItem(LS_KEY, nextId);
    localStorage.setItem(LS_KEY_CITY, nextId);
  } catch {
    /* ignore quota / private mode */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVT, { detail: nextId }));
  }
}

/** Imperative setter usable from non-hook code (e.g. inside a Three.js
 *  scene callback that already has its own state). */
export function setActiveCharacter(nextId: string) {
  pickedThisSession = true;
  adopted = true; // a deliberate pick outranks anything the server has to say
  writeLocal(nextId);
  /* Best-effort, and deliberately not awaited: putting on a different body
     should happen on the frame you tap it. The local copy is what renders
     either way.

     Don't even ask the till for a character that is for sale and not owned:
     the server answers "you do not own X" with a 500, which the client's
     error reporting surfaces as a runtime error even though `equip` swallows
     it. Wearing an unowned shop skin locally is the pre-existing behaviour;
     it just no longer generates a failed request per pick. */
  const priced = SHOP_CHARACTERS.find((c) => c.id === nextId);
  if (priced && !owns("character", nextId, priced.price)) return;
  void equip({ character: nextId }).catch(() => {});
}


export function useActiveCharacter(): {
  charId: string;
  character: CharSpec;
  setCharId: (id: string) => void;
  all: CharSpec[];
} {
  const [charId, setCharIdState] = useState<string>(readId);

  useEffect(() => {
    const onChange = (e: Event) => {
      const next =
        (e as CustomEvent<string>).detail ??
        localStorage.getItem(LS_KEY) ??
        DEFAULT_LOADOUT.character;
      setCharIdState(next);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === LS_KEY || e.key === LS_KEY_CITY) {
        setCharIdState(readId());
      }
    };
    window.addEventListener(EVT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  /* Adopt the server's character, once, on the first refresh that actually
     reached the server.

     Two guards, and both matter. `sawFetch` is why we wait for a snapshot that
     went loading→settled: `subscribeWardrobe` replays a snapshot built from
     localStorage cache, and adopting from the cache would mean adopting
     DEFAULT_LOADOUT on a first run and stamping over a pick the visitor made
     months ago. And we ignore the default value even when it does come from
     the server, because the column defaults to `vibey` and there is no way to
     tell "they chose Vibey" from "nobody has ever told us" — so a wallet that
     has never equipped anything must not overrule a local choice.

     That check is against SERVER_UNSET_CHARACTER, deliberately, and NOT against
     the app's own default. They used to be the same string and are not any
     more: the app opens on Toadstool while the column still says `vibey`.
     Comparing to the app default here would mean the server's `vibey` no
     longer looked like "unset", and every signed-in visitor would be flipped
     off Toadstool a half-second after the page painted. */
  useEffect(() => {
    if (adopted) return;
    let sawFetch = false;
    const consider = (s: WardrobeState) => {
      if (s.loading) {
        sawFetch = true;
        return;
      }
      if (!sawFetch || adopted || pickedThisSession || s.stale) return;
      adopted = true;
      const server = s.loadout.character;
      if (!server || server === SERVER_UNSET_CHARACTER) return;
      if (server === readId()) return;
      writeLocal(server);
    };
    return subscribeWardrobe(consider);
  }, []);

  const setCharId = useCallback((id: string) => {
    setCharIdState(id);
    setActiveCharacter(id);
  }, []);

  return {
    charId,
    character: findCharacter(charId),
    setCharId,
    all: CHARACTERS,
  };
}
