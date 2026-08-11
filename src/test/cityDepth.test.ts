/**
 * Vibe City's ground is a stack of near-coplanar surfaces, and from the air
 * the depth buffer cannot tell them apart.
 *
 * The asphalt plate is at y=0, the sidewalks 1.2 cm above it, the crossings
 * 2 cm above that, and the beach runs a few metres underneath the plate's edge.
 * Depth precision falls off with the square of range, so at 600 m a near plane
 * of 0.1 leaves about 21 cm of resolution — every one of those gaps rounds to
 * the same number and the whole district boils. A burst measured 6.9% of the
 * pixels inside the district being decided by depth precision rather than by
 * geometry; the two fixes below took that to 0.01%.
 *
 * Neither fix is self-evident from reading the line it lives on, and both look
 * exactly like the kind of thing a tidy-up deletes. `scripts/city-flicker.mjs`
 * is how you re-measure; this is how you find out you broke it without having
 * to remember to.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

describe("the city's depth budget", () => {
  it("scales the camera's near plane with the zoom", () => {
    const src = read("src", "pages", "City.tsx");
    // A constant near plane is the bug. It has to come from camDist, because
    // camDist is precisely how far away the thing being looked at is.
    expect(src).toMatch(/wantNear\s*=\s*THREE\.MathUtils\.clamp\(\s*camDist\s*\*/);
    expect(src).toContain("camera.updateProjectionMatrix()");
    // And VR has to get the tight one back, or a headset entered from a
    // god-view zoom clips away the room you are standing in.
    expect(src).toMatch(/camera\.near\s*!==\s*0\.1/);
  });

  it("keeps the ground stack on polygon offsets", () => {
    // Resolution-independent, unlike the near plane — this is what covers the
    // case the near plane cannot: a player who jetpacks to 300 m with the
    // camera still tight behind them.
    const district = read("src", "city", "district.ts");
    expect(district).toContain("polygonOffset: true");
    // Pavement, and paint that has to clear the pavement in turn.
    expect(district).toMatch(/decal\(-4\)[\s\S]*decal\(-4\)[\s\S]*decal\(-4\)/);
    expect(district).toMatch(/polygonOffsetFactor:\s*-2,\s*polygonOffsetUnits:\s*-10/);

    // The sand runs under the plate, so it is pushed the other way: where the
    // two overlap the asphalt is the one that should win.
    const ocean = read("src", "city", "ocean.ts");
    expect(ocean).toMatch(/polygonOffsetFactor:\s*1,\s*\n\s*polygonOffsetUnits:\s*4/);
  });
});
