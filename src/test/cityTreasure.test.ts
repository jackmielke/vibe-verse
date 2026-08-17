/**
 * A reason to dive, and a camera that can look at it.
 *
 * The sea had waves, a floor, caustics on the floor, fish over the caustics
 * and a way to swim down through all of it — and nothing to do once you got
 * there, which makes a very good set and not a place. These are the two halves
 * of fixing that: things on the bottom worth the swim, and a camera that can
 * aim somewhere other than down at your own head.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { waterDepthAt } from "@/city/ocean";

const wrecksSrc = readFileSync(resolve(__dirname, "../city/wrecks.ts"), "utf8");
const citySrc = readFileSync(resolve(__dirname, "../pages/City.tsx"), "utf8");

/**
 * The site placement, re-derived.
 *
 * `siteSpots` is not exported and building the real module needs a DOM, so
 * this is the same walk against the same `waterDepthAt`. What it is checking
 * is the PROPERTY — that walking out along a bearing until the water is deep
 * enough actually lands somewhere worth diving to — which is a fact about the
 * coastline, not about the code that reads it.
 */
function spots() {
  const BEARINGS = [0.4, 1.75, 2.9, 4.1, 5.4];
  const out: Array<{ x: number; z: number; depth: number }> = [];
  for (const a of BEARINGS) {
    const dx = Math.sin(a);
    const dz = Math.cos(a);
    let r = 180 + 40;
    let found = false;
    for (let i = 0; i < 200; i++) {
      if (waterDepthAt(dx * r, dz * r) > 5) { found = true; break; }
      r += 4;
    }
    if (!found) continue;
    r += 25;
    out.push({ x: dx * r, z: dz * r, depth: waterDepthAt(dx * r, dz * r) });
  }
  return out;
}

describe("where the treasure ends up", () => {
  const sites = spots();

  it("finds a spot on every bearing", () => {
    // The walk gives up after 200 steps. On a coastline that shelves as gently
    // as this one that is not obviously enough, and a bearing that gives up
    // silently loses a chest.
    expect(sites.length).toBe(5);
  });

  it("puts all of them in water you have to dive for", () => {
    // A chest in ankle-deep water on the beach is not treasure, it is litter —
    // and it is exactly what the bearing walk produces if the depth test is
    // wrong or the coastline moves under it.
    for (const s of sites) expect(s.depth).toBeGreaterThan(5);
  });

  it("keeps them further apart than you can see", () => {
    // Underwater visibility is forty metres. Two chests inside that are one
    // chest, and the search — which is the entire feature — evaporates.
    for (let i = 0; i < sites.length; i++) {
      for (let j = i + 1; j < sites.length; j++) {
        const d = Math.hypot(sites[i].x - sites[j].x, sites[i].z - sites[j].z);
        expect(d).toBeGreaterThan(60);
      }
    }
  });

  it("keeps them off the city plate", () => {
    // The plate is 360 m across and dry. A site inside it would be buried in a
    // street.
    for (const s of sites) {
      expect(Math.max(Math.abs(s.x), Math.abs(s.z))).toBeGreaterThan(180);
    }
  });
});

describe("collecting one", () => {
  it("remembers finds across reloads, not just across the session", () => {
    // A per-session flag re-arms every chest in the bay on refresh, and a
    // payout you can farm with F5 is not a discovery, it is a button.
    expect(wrecksSrc).toContain("localStorage.getItem(STORE)");
    expect(wrecksSrc).toContain("localStorage.setItem(STORE");
  });

  it("survives storage being unavailable", () => {
    // Private mode, a full quota, a value somebody hand-edited. None of those
    // should cost anybody the sea.
    expect(wrecksSrc).toMatch(/catch \{[\s\S]{0,200}?return new Set\(\);/);
  });

  it("opens the lid of a chest emptied during play, not only one loaded empty", () => {
    // Building the open state once at construction covers chests found on a
    // previous visit and leaves the one you just swam into sitting shut — the
    // coins arrive and the world disagrees.
    expect(wrecksSrc).toContain("function openLid(");
    const collect = wrecksSrc.slice(wrecksSrc.indexOf("site.found = true;"));
    expect(collect.slice(0, 300)).toContain("openLid(lids[i]);");
  });

  it("shuts them again on reset", () => {
    // Otherwise a reset hands you five open chests that still pay out.
    const reset = wrecksSrc.slice(wrecksSrc.indexOf("reset() {"));
    expect(reset.slice(0, 400)).toMatch(/lids\[i\]\.rotation\.x = 0;/);
  });

  it("gates the reach on the swimmer being under, not the camera", () => {
    // Everything else down here keys off the camera, because the camera is
    // what sees. Reaching into a chest is the one thing that is about the
    // body — and a camera-gated version would let you collect from a boat.
    const call = citySrc.slice(citySrc.indexOf("const got = wrecks.update("));
    expect(call.slice(0, 300)).toContain("player.position");
    expect(call.slice(0, 300)).toContain("swimming && player.position.y <");
  });

  it("does not fog the glint", () => {
    // The glint is the thing that has to punch through forty metres of fog.
    // Fogged, it is exactly as invisible as the chest it is advertising, and
    // the honest failure mode of hidden treasure in heavy fog is that nobody
    // finds any and concludes there is nothing there.
    const mat = wrecksSrc.slice(wrecksSrc.indexOf("const glintMat"));
    expect(mat.slice(0, 400)).toContain("fog: false");
  });
});

describe("the camera underwater", () => {
  it("may aim below level only while swimming", () => {
    // On land a negative pitch puts the eye in the pavement and the floor
    // clamp shoves it back up through the model.
    expect(citySrc).toMatch(/const minCamPitch = \(\) => \(swimming \? -[\d.]+ : 0\.06\);/);
  });

  it("uses that limit everywhere the pitch is set", () => {
    // Two places set it — a drag and the dev hook — and a clamp that is only
    // relaxed in one of them is a control that works until you use the other.
    const clamps = [...citySrc.matchAll(/clamp\((?:camPitch \+ dy \* [\d.]+|pitch), ([^,]+), 1\.25\)/g)];
    expect(clamps.length).toBe(2);
    for (const c of clamps) expect(c[1]).toBe("minCamPitch()");
  });

  it("eases back to a legal pitch once you are out of the water", () => {
    // Otherwise the camera stays below the waterline on dry land.
    expect(citySrc).toMatch(/if \(!swimming && camPitch < 0\.06\) \{/);
  });

  it("never lets the dive override an upward aim", () => {
    // The dive pulls the eye down to 0.35 so it does not hover overhead while
    // you aim at the seabed. Applied unconditionally it also cancels the whole
    // free-look: hold a dive, aim at the surface, and the camera sits at 0.35
    // looking down at you. Measured exactly that — pitch -0.72 requested, eye
    // still a metre and a half above the swimmer's head.
    expect(citySrc).toMatch(
      /camPitch > 0\.35 \? THREE\.MathUtils\.lerp\(camPitch, 0\.35, diveEased\) : camPitch/,
    );
  });
});

describe("holding depth", () => {
  it("has a glide that needs you to be swimming", () => {
    // The safety property of the whole sea is that doing nothing floats you
    // up. Gliding is allowed to suspend that only for as long as you are
    // actively working at it.
    expect(citySrc).toMatch(/const wantGlide = paddling \* levelish \* \(1 - diveEased\);/);
  });

  it("decays the glide the moment you leave the water", () => {
    expect(citySrc).toMatch(/glideEased \*= Math\.pow\(0\.05, dt\);/);
  });

  it("keeps the dive's measured descent rate intact", () => {
    // The 1.1 cap against the 3.4 sink term is the 2.3 m/s descent the dive
    // harness measures. Gliding gets its own, tighter cap; taking the min of
    // the two must not change what diving does.
    expect(citySrc).toMatch(/THREE\.MathUtils\.lerp\(9, 1\.1, diveEased\)/);
    expect(citySrc).toMatch(/THREE\.MathUtils\.lerp\(9, 0\.35, glideEased\)/);
    expect(citySrc).toContain("const held = Math.min(rise, cap);");
  });
});
