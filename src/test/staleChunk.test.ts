/**
 * The stale-chunk recovery has exactly two ways to be wrong, and both of them
 * are worse than the bug it fixes:
 *
 *  - too eager, and an ordinary crash reloads the page under somebody
 *    mid-game, which looks like the app deciding to throw their run away;
 *  - unbounded, and a chunk that is missing for any other reason (offline, a
 *    proxy, a bad deploy) reloads forever.
 *
 * So: the classifier is pinned against the real wording of the error in each
 * engine, and against a handful of genuine crashes that must *not* match. And
 * the reload claim is pinned to once per cooldown.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  RELOAD_COOLDOWN_MS,
  claimStaleChunkReload,
  isStaleChunkError,
} from "@/lib/staleChunk";

describe("recognising a chunk that is no longer being served", () => {
  /* Verbatim from the browsers, because this is string matching and a
     paraphrase would test nothing. */
  const REAL = [
    // Chrome / Edge
    "Failed to fetch dynamically imported module: https://vibeverse.app/assets/SanPalmas-CMTPbMrg.js",
    // Firefox
    "error loading dynamically imported module",
    // Safari
    "Importing a module script failed.",
    // A host that answers a missing asset with the SPA's index.html
    "Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of \"text/html\". Strict MIME type checking is enforced for module scripts per HTML spec.",
    // webpack's name for it, in case anything vendored still throws it
    "ChunkLoadError: Loading chunk 42 failed.",
  ];

  for (const message of REAL) {
    it(`matches: ${message.slice(0, 48)}…`, () => {
      expect(isStaleChunkError(new Error(message))).toBe(true);
    });
  }

  /* The expensive half. Every one of these is a real crash somebody needs to
     see the error screen for, and reloading would hide it. */
  const NOT = [
    "Cannot read properties of undefined (reading 'position')",
    "Error creating WebGL context.",
    "THREE.WebGLRenderer: Context Lost.",
    "NetworkError when attempting to fetch resource.",
    "Failed to fetch",
    "Maximum update depth exceeded",
  ];

  for (const message of NOT) {
    it(`leaves alone: ${message.slice(0, 48)}`, () => {
      expect(isStaleChunkError(new Error(message))).toBe(false);
    });
  }

  it("does not fall over on a thrown non-Error", () => {
    expect(isStaleChunkError(undefined)).toBe(false);
    expect(isStaleChunkError(null)).toBe(false);
    expect(isStaleChunkError("Failed to fetch dynamically imported module")).toBe(true);
  });
});

describe("claiming the reload", () => {
  beforeEach(() => sessionStorage.clear());

  it("says yes the first time", () => {
    expect(claimStaleChunkReload(1_000)).toBe(true);
  });

  it("says no again inside the cooldown", () => {
    expect(claimStaleChunkReload(1_000)).toBe(true);
    expect(claimStaleChunkReload(1_000 + RELOAD_COOLDOWN_MS - 1)).toBe(false);
  });

  it("says yes again once the cooldown is over", () => {
    expect(claimStaleChunkReload(1_000)).toBe(true);
    expect(claimStaleChunkReload(1_000 + RELOAD_COOLDOWN_MS)).toBe(true);
  });

  it("refuses when there is nowhere to remember the attempt", () => {
    /* No storage, no way to bound a loop — so it must not start one. */
    const real = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("The operation is insecure.");
      },
    });
    try {
      expect(claimStaleChunkReload(1_000)).toBe(false);
    } finally {
      if (real) Object.defineProperty(window, "sessionStorage", real);
    }
  });
});
