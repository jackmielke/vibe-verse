/**
 * The Deep is the first place in Vibe City that is below the seabed, and
 * "below the seabed" is a state four separate systems in `City.tsx` were
 * written to treat as impossible.
 *
 * What can be checked here is the arithmetic and the wiring, not the picture.
 * The funnel is the load-bearing part — physics and geometry both read it, and
 * if they ever stop agreeing the symptom is a player hovering above visible
 * rock or falling through it, which no screenshot shows and no build catches.
 * The rest of these are guards on the specific ways this feature has already
 * broken once: an eye clamped to the wrong floor, an emissive that ignores the
 * instance colour set for it, and a light that recompiles the world when it is
 * hidden.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTrench } from "@/city/trench";

const trenchSrc = readFileSync(resolve(__dirname, "../city/trench.ts"), "utf8");
const citySrc = readFileSync(resolve(__dirname, "../pages/City.tsx"), "utf8");
const underwaterSrc = readFileSync(resolve(__dirname, "../city/underwater.ts"), "utf8");

describe("the trench: the funnel", () => {
  const t = createTrench();

  it("is a hole in the seabed, not a hole in the map", () => {
    // Outside the rim the world is unchanged — `floorAt` says "not mine" so
    // every caller falls back to the bay's own seabed.
    expect(t.floorAt(t.mouth.x + t.mouth.rim + 1, t.mouth.z)).toBeNull();
    expect(t.inside(t.mouth.x + t.mouth.rim + 1, t.mouth.z)).toBe(false);
    expect(t.inside(t.mouth.x, t.mouth.z)).toBe(true);
  });

  it("meets the seabed exactly at the rim", () => {
    // A step here is a lip you fall off or a wall you swim into. The profile
    // is smoothstepped precisely so the two surfaces join flush.
    const rimY = t.floorAt(t.mouth.x + t.mouth.rim - 1e-6, t.mouth.z);
    expect(rimY).not.toBeNull();
    expect(rimY as number).toBeCloseTo(t.mouth.y, 3);
  });

  it("only ever goes down, and monotonically, from rim to centre", () => {
    let last = Infinity;
    for (let d = t.mouth.rim; d >= 0; d -= 0.25) {
      const y = t.floorAt(t.mouth.x + d, t.mouth.z);
      expect(y).not.toBeNull();
      expect(y as number).toBeLessThanOrEqual(last + 1e-9);
      last = y as number;
    }
    // And the bottom really is the bottom.
    expect(t.floorAt(t.mouth.x, t.mouth.z) as number).toBeCloseTo(t.mouth.y - 78, 6);
  });

  it("is radially symmetric, which is what lets the wall be a cone", () => {
    const r = t.mouth.rim * 0.5;
    const base = t.floorAt(t.mouth.x + r, t.mouth.z) as number;
    for (const a of [0.7, 1.9, 3.3, 5.1]) {
      const y = t.floorAt(t.mouth.x + Math.cos(a) * r, t.mouth.z + Math.sin(a) * r);
      expect(y as number).toBeCloseTo(base, 9);
    }
  });

  it("reports descent as 0 at the mouth and 1 on the floor", () => {
    expect(t.descent(t.mouth.y)).toBeCloseTo(0, 6);
    expect(t.descent(t.mouth.y - 78)).toBeCloseTo(1, 6);
    // Clamped both ways: a swimmer above the sea and a swimmer who somehow got
    // under the floor both have to produce a number the shaders can use.
    expect(t.descent(50)).toBe(0);
    expect(t.descent(-9999)).toBe(1);
  });

  it("puts the prize somewhere you can actually stand", () => {
    const p = t.prize();
    expect(t.inside(p.x, p.z)).toBe(true);
    const floor = t.floorAt(p.x, p.z) as number;
    expect(p.y).toBeGreaterThan(floor);
    expect(p.y - floor).toBeLessThan(6);
  });

  it("is far enough offshore to be out at sea", () => {
    expect(Math.hypot(t.mouth.x, t.mouth.z)).toBeGreaterThan(300);
    expect(t.mouth.y).toBeLessThan(-10);
  });
});

/**
 * Four bounds in `City.tsx` hard-coded "nobody is ever below −40 m", and the
 * trench floor is at −92. Each of these was a separate, differently-shaped bug
 * — you stopped swimming, you lost the water, the camera stayed at the rim, or
 * the world decided you had fallen out of it and respawned you in the sky.
 */
describe("the trench: the bounds it relaxes", () => {
  /**
   * The LAST match, not the first.
   *
   * `atSeaLevel` is declared twice in this file — once for a kart, once for
   * the swimmer — and `indexOf` finds the kart's, which correctly still stops
   * at −40 because a car has no business at the bottom of a trench. So the
   * first version of this test asserted the wrong declaration and failed
   * against working code. Anything checked here is late in the frame loop.
   */
  const line = (needle: string) => {
    const i = citySrc.lastIndexOf(needle);
    expect(i, `expected to find ${needle} in City.tsx`).toBeGreaterThan(-1);
    return citySrc.slice(i, i + 400);
  };

  it("keeps you swimming below the old floor", () => {
    expect(line("const atSeaLevel =")).toMatch(/trench\.inside|inTrench/);
  });

  it("lets the underwater atmosphere follow you past −40", () => {
    expect(line("camera.position.y > -40")).toContain("trench.inside(");
  });

  it("does not treat the bottom of the trench as falling out of the world", () => {
    expect(line("const fellOutOfWorld =")).toContain("trench.inside(");
  });

  /**
   * The one that passed every numeric check and still shipped a black frame.
   *
   * The eye's floor clamp used the BAY's seabed, so the camera stopped at the
   * rim while the swimmer went down another seventy-five metres. Because the
   * whole underwater atmosphere keys off the camera's depth, the abyss
   * rendered as mid-teal shallows containing nothing — and the harness passed,
   * because everything it measured was about the swimmer.
   */
  it("clamps the camera to the trench floor, not the bay's", () => {
    expect(line("const eyeTrenchFloor")).toContain("trench.floorAt(eye.x, eye.z)");
    expect(line("eye.y = Math.max(")).toContain("eyeTrenchFloor");
  });
});

describe("the trench: the ways it has been made invisible", () => {
  /**
   * `instanceColor` multiplies the diffuse term. An emissive is added after it
   * and never sees it — so 260 polyps set to two different colours all emitted
   * the same one, and a material with both is a bug that looks like a working
   * feature.
   */
  it("does not set a per-instance colour on an emissive material", () => {
    const usesInstanceColour = /polyps\.setColorAt/.test(trenchSrc);
    expect(usesInstanceColour).toBe(true);
    const decl = trenchSrc.slice(
      trenchSrc.indexOf("const polypMat"),
      trenchSrc.indexOf("const polyps ="),
    );
    expect(decl).toContain("MeshBasicMaterial");
    expect(decl).not.toContain("emissive");
  });

  /**
   * Hiding a light is not dimming it: three.js skips invisible objects when it
   * gathers lights, so the point-light count changes and every material in the
   * city recompiles — on the frame the player crosses the rim, and again on the
   * way out.
   */
  it("never hides the lamp, only dims it", () => {
    expect(trenchSrc).toContain("group.add(lamp)");
    expect(trenchSrc).toMatch(/body\.visible = near/);
    expect(trenchSrc).not.toMatch(/lamp\.visible/);
    // And the far case has to zero it, or the abyss lights the open sea.
    expect(trenchSrc.slice(trenchSrc.indexOf("body.visible = near"))).toMatch(
      /if \(!near\)[\s\S]{0,120}lamp\.intensity = 0/,
    );
  });

  it("puts every visible thing under the switch, and only the lamp outside it", () => {
    // A prop added straight to `group` renders at full cost from two kilometres
    // away, which is the entire reason the switch exists.
    const added = [...trenchSrc.matchAll(/^\s*(group|body)\.add\((\w+)\);/gm)].map(
      (m) => [m[1], m[2]] as const,
    );
    expect(added.length).toBeGreaterThan(6);
    for (const [parent, what] of added) {
      if (what === "lamp" || what === "body") expect(parent).toBe("group");
      else expect(parent, `${what} should be hidden with the rest`).toBe("body");
    }
  });

  /**
   * The abyss fog closed to thirteen metres inside a room thirty-two across,
   * so the walls, the floor and every light on them were past the far plane
   * the whole way down. It rendered as a black rectangle, which reads as a
   * missing texture rather than as darkness.
   */
  it("keeps the abyss sight line longer than the shaft is wide", () => {
    const m = underwaterSrc.match(/lerp\(FOG_FAR,\s*([\d.]+),\s*abyss\)/);
    expect(m, "expected the abyss fog-far lerp in underwater.ts").not.toBeNull();
    const abyssFar = Number((m as RegExpMatchArray)[1]);
    const t = createTrench();
    // The funnel is 2·rim·taper across at the floor, and the chase camera adds
    // its own arm on top of that.
    expect(abyssFar).toBeGreaterThan(2 * t.mouth.rim * 0.62);
  });
});
