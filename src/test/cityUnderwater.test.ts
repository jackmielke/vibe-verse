import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { wrapBox } from "@/city/underwater";

const underwaterSrc = readFileSync(resolve(__dirname, "../city/underwater.ts"), "utf8");
const oceanSrc = readFileSync(resolve(__dirname, "../city/ocean.ts"), "utf8");

describe("underwater: tiling around the swimmer", () => {
  it("keeps everything inside the box", () => {
    for (let v = -500; v <= 500; v += 3.7) {
      const w = wrapBox(v, 46);
      expect(w).toBeGreaterThanOrEqual(-23);
      expect(w).toBeLessThan(23);
    }
  });

  it("is the identity inside the box", () => {
    for (const v of [-22.9, -10, 0, 7.5, 22.9]) expect(wrapBox(v, 46)).toBeCloseTo(v, 9);
  });

  it("handles negatives without the JS modulo sign trap", () => {
    // `-30 % 46` is -30 in JavaScript, not 16. Getting this wrong puts half
    // the shafts on one side of the swimmer and none on the other.
    expect(wrapBox(-30, 46)).toBeCloseTo(16, 9);
    expect(wrapBox(-70, 46)).toBeCloseTo(22, 9);
  });

  /**
   * The one that matters.
   *
   * A shaft is placed at `eye + wrapBox(anchor - eye)`. The obvious alternative
   * — `eye + constant` — also keeps the shafts around the swimmer, also never
   * runs out, and is wrong: every blade then travels at exactly the camera's
   * speed, parallax against the seabed goes to zero, and sixteen volumes of
   * light read as sixteen decals stuck to the lens. That defect is invisible
   * in a screenshot and obvious in motion, so it is asserted here instead.
   */
  it("moves the shafts through the world as the swimmer moves", () => {
    const anchor = 11.3;
    const placed = (eye: number) => eye + wrapBox(anchor - eye, 46);
    // Away from a wrap point, the world position must not follow the eye.
    expect(placed(0)).toBeCloseTo(anchor, 9);
    expect(placed(5)).toBeCloseTo(anchor, 9);
    expect(placed(20)).toBeCloseTo(anchor, 9);
    // And once the eye has left it behind, it re-enters exactly one box ahead
    // rather than drifting.
    const far = placed(40);
    expect(far).toBeCloseTo(anchor + 46, 9);
  });
});

describe("underwater: the shaders", () => {
  const glsl = [
    ...[...underwaterSrc.matchAll(/\/\* glsl \*\/\s*`([\s\S]*?)\n\s*`/g)].map((m) => m[1]),
    ...[...oceanSrc.matchAll(/\/\* glsl \*\/\s*`([\s\S]*?)\n\s*`/g)].map((m) => m[1]),
  ];

  it("never puts a backtick inside a GLSL template literal", () => {
    // Ends the string early, and the parse errors land a hundred lines from
    // the cause. It has now happened three times in this repo.
    for (const g of glsl) expect(g.includes("`")).toBe(false);
  });

  it("balances braces", () => {
    for (const g of glsl) {
      expect((g.match(/{/g) ?? []).length).toBe((g.match(/}/g) ?? []).length);
    }
  });

  it("hooks caustics after <color_fragment>, not after <map_fragment>", () => {
    // The seabed is vertex-coloured. Anything injected at <map_fragment> is
    // overwritten by the vertex colour a few lines later and silently does
    // nothing — which is exactly how the snow patch failed on this same mesh.
    expect(underwaterSrc).toContain("#include <color_fragment>");
    expect(underwaterSrc).not.toContain("<map_fragment>");
  });

  it("takes the instance matrix into account", () => {
    // Without this every instance of an instanced mesh samples the caustic
    // field at the same world point and the whole batch flashes as one.
    expect(underwaterSrc).toContain("modelMatrix * instanceMatrix");
  });

  it("chains onBeforeCompile rather than replacing it", () => {
    // The seabed already carries the snow patch. Whichever of the two is
    // applied second would otherwise drop the first.
    expect(underwaterSrc).toMatch(/prev\?\.\(shader, renderer\)/);
  });
});

describe("ocean: the sea has an underside", () => {
  it("becomes double sided for anybody under it", () => {
    // Faces are wound upward. Single-sided, the entire ocean is culled the
    // moment the camera drops below the waterline: you dive, and the sea
    // simply is not there — you look up at the sky through it. A build, a
    // typecheck and a still of the surface all pass while that is true.
    //
    // It is a toggle rather than a constant because from above, the underside
    // is dead code on the most expensive fragment shader in the world.
    expect(oceanSrc).toMatch(/const want = on \? THREE\.DoubleSide : THREE\.FrontSide;/);
  });

  it("compiles the underside out when nobody is under it", () => {
    // A branch that is never taken still costs the test on every pixel of a
    // sea that fills the screen, and spends registers the rest of the shader
    // wanted.
    expect(oceanSrc).toContain("#ifdef UNDERSIDE");
    expect(oceanSrc).toMatch(/waterMat\.defines\.UNDERSIDE = "1";/);
    expect(oceanSrc).toMatch(/delete waterMat\.defines\.UNDERSIDE;/);
  });

  it("keeps the two toggles on the same condition", () => {
    // Culling the back faces and compiling out the code that shades them are
    // the same decision. Split them and you get a sea that is double-sided
    // with no underside shader — which renders the TOP of the water on the
    // bottom of every wave, and looks like the sea turning inside out.
    const setter = oceanSrc.slice(oceanSrc.indexOf("setUnderside(on) {"));
    expect(setter.slice(0, 900)).toContain("waterMat.side = want;");
    expect(setter.slice(0, 900)).toContain("UNDERSIDE");
  });

  it("renders the underside as a different surface", () => {
    expect(oceanSrc).toContain("gl_FrontFacing");
  });

  it("puts Snell's window at the critical angle", () => {
    // Light escapes water into air only within asin(1/1.333) = 48.6 degrees
    // of vertical, so the window's edge sits at cos(48.6 deg) = 0.661. The
    // shader softens it either side; the softened band has to straddle that
    // number or the window is the wrong size and the effect stops reading as
    // anything in particular.
    const m = oceanSrc.match(/float win = smoothstep\(([\d.]+), ([\d.]+), ct\);/);
    expect(m).not.toBeNull();
    const critical = Math.cos(Math.asin(1 / 1.333));
    expect(Number(m![1])).toBeLessThan(critical);
    expect(Number(m![2])).toBeGreaterThan(critical);
  });

  it("exposes the seabed material so caustics can reach it", () => {
    expect(oceanSrc).toContain("bedMaterial: sandMat");
  });
});
