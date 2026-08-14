/**
 * Moving card art, tested where it can quietly be wrong.
 *
 * The recording is an *upgrade* to a still, never a replacement for one. Every
 * failure mode here is silent — a card that is blank until you hover it, a clip
 * for a world that no longer exists, a still swapped for something that is not
 * animated at all — and none of them break a build or fail a render.
 */
import { describe, expect, it } from "vitest";

import { WORLD_MOTION, motionFor } from "@/worlds/motion";
import { WORLD_ART } from "@/worlds/art";
import { WORLDS } from "@/worlds/registry";

describe("world motion", () => {
  it("only covers worlds that exist", () => {
    const keys = new Set(WORLDS.map((w) => w.key));
    for (const key of Object.keys(WORLD_MOTION)) {
      expect(keys, `${key} has a clip but is not in the registry`).toContain(key);
    }
  });

  it("never replaces a still — every animated world also has one", () => {
    /* The clip is fetched on hover. A world with a clip and no still is a card
       that is blank until somebody points at it, which is worse than a card
       that never moves. */
    for (const key of Object.keys(WORLD_MOTION)) {
      expect(WORLD_ART[key], `${key} has a clip but no still`).toBeTruthy();
    }
  });

  it("points at animated files, not at stills renamed", () => {
    /* A `.jpg` in here is somebody wiring up a screenshot and wondering why the
       card does not move. Only formats that can actually carry frames. */
    for (const [key, src] of Object.entries(WORLD_MOTION)) {
      expect(src, `${key} is not an animated format`).toMatch(/\.(gif|webp|apng|avif)($|\?)/i);
    }
  });

  it("is undefined for anything without a recording", () => {
    expect(motionFor("terminal")).toBeUndefined();
    expect(motionFor("no-such-world")).toBeUndefined();
  });

  it("has COIL, which is the one world built to play itself", () => {
    expect(motionFor("coil")).toBeTruthy();
  });
});
