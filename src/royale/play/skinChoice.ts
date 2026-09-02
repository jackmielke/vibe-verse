/**
 * What the island remembers about who you are. No THREE, no React — the
 * locker UI and the skin system both read it, and a test can too.
 *
 * The character itself is the vibeverse-wide pick (`lobby.character`, owned
 * by `use-active-character`). The one thing that is this world's alone is
 * "actually, the drop suit" — a flag rather than a roster id, so choosing the
 * suit here never changes who you are in the city.
 */
import { DEFAULT_CHARACTER_ID } from "@/lib/characters";

export const ROYALE_SUIT_KEY = "royale.suit";
/** The locker's id for the built-in rig. Never written to `lobby.character`. */
export const SUIT_ID = "dz-suit";

export function readActiveCharacterId(): string {
  if (typeof window === "undefined") return DEFAULT_CHARACTER_ID;
  try {
    return (
      localStorage.getItem("lobby.character") ??
      localStorage.getItem("city.character") ??
      DEFAULT_CHARACTER_ID
    );
  } catch {
    return DEFAULT_CHARACTER_ID;
  }
}

/** True when the player has asked for the drop suit over their character. */
export function wearsSuit(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(ROYALE_SUIT_KEY) === "1";
  } catch {
    return false;
  }
}

export function setWearsSuit(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (on) localStorage.setItem(ROYALE_SUIT_KEY, "1");
    else localStorage.removeItem(ROYALE_SUIT_KEY);
  } catch {
    /* quota / private mode */
  }
  window.dispatchEvent(new CustomEvent("royale:suit-changed", { detail: on }));
}

/** The id the locker should show as selected. */
export function lockerSelection(): string {
  return wearsSuit() ? SUIT_ID : readActiveCharacterId();
}
