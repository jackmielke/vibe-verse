/**
 * The skin's two pure decisions, without a renderer.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { skinActionFor } from "@/royale/play/skin";
import {
  ROYALE_SUIT_KEY,
  SUIT_ID,
  lockerSelection,
  readActiveCharacterId,
  setWearsSuit,
  wearsSuit,
} from "@/royale/play/skinChoice";
import { DEFAULT_CHARACTER_ID } from "@/lib/characters";

describe("which clip family the skin plays", () => {
  it("follows the actor's state, and the ground under it", () => {
    expect(skinActionFor("ground", true)).toBe("locomotion");
    expect(skinActionFor("sprint", true)).toBe("locomotion");
    expect(skinActionFor("ground", false)).toBe("air");
    expect(skinActionFor("air", false)).toBe("air");
    expect(skinActionFor("skydive", false)).toBe("air");
    expect(skinActionFor("glide", false)).toBe("air");
    expect(skinActionFor("bus", false)).toBe("air");
    expect(skinActionFor("down", true)).toBe("down");
    expect(skinActionFor("dead", true)).toBe("dead");
    // Down and dead win over everything, whatever the feet say.
    expect(skinActionFor("dead", false)).toBe("dead");
  });
});

describe("who the island dresses you as", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("is the vibeverse-wide pick by default", () => {
    expect(readActiveCharacterId()).toBe(DEFAULT_CHARACTER_ID);
    localStorage.setItem("lobby.character", "Wizard");
    expect(readActiveCharacterId()).toBe("Wizard");
    expect(lockerSelection()).toBe("Wizard");
    expect(wearsSuit()).toBe(false);
  });

  it("keeps the drop suit as this world's own flag, never as a roster id", () => {
    localStorage.setItem("lobby.character", "Wizard");
    setWearsSuit(true);
    expect(wearsSuit()).toBe(true);
    expect(lockerSelection()).toBe(SUIT_ID);
    // The shared pick is untouched: in the city you are still the wizard.
    expect(localStorage.getItem("lobby.character")).toBe("Wizard");
    expect(localStorage.getItem(ROYALE_SUIT_KEY)).toBe("1");
    setWearsSuit(false);
    expect(lockerSelection()).toBe("Wizard");
    expect(localStorage.getItem(ROYALE_SUIT_KEY)).toBeNull();
  });
});
