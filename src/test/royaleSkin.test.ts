/**
 * The skin's two pure decisions, without a renderer.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { handBoneName, skinActionFor } from "@/royale/play/skin";
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

describe("where the weapon hangs on a skin", () => {
  // Names as three's GLTFLoader hands them back: dots stripped.
  const wizard = ["CharacterArmature", "Root", "UpperArmL", "LowerArmL", "FistL", "UpperArmR", "LowerArmR", "FistR", "Head"];
  const anne = ["Pirate_Anne", "Root", "LowerArmL", "UpperArmL", "LowerArmR", "UpperArmR", "Cube117", "Weapon_DoubleAxe"];

  it("takes the right fist on a Quaternius rig", () => {
    expect(handBoneName(wizard)).toBe("FistR");
  });

  it("falls back to the right forearm when a rig has no hand bone", () => {
    expect(handBoneName(anne)).toBe("LowerArmR");
  });

  it("never picks the left side, the armature, or nothing at all by accident", () => {
    expect(handBoneName(["FistL", "LowerArmL", "CharacterArmature"])).toBeNull();
    expect(handBoneName(["mixamorig:RightHand".replace(":", "")])).toBe("mixamorigRightHand");
    expect(handBoneName(["Hand_R", "Hand_L"])).toBe("Hand_R");
    expect(handBoneName(["Fist.R"])).toBe("Fist.R");
  });
});
