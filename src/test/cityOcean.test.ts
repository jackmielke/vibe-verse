/**
 * The sea's terrain is written twice — once in TypeScript, once in GLSL — and
 * the whole design depends on the two agreeing.
 *
 * The sand mesh is built on the CPU from `bedHeight`, the player walks on
 * `beachHeightAt`, and every water fragment decides whether it is water at all
 * by evaluating the same function in the shader. Let those drift and the
 * failure is not a crash: it is water lapping a metre inland of the sand, or a
 * ring of seabed showing through the surf, and nothing in a build or a
 * typecheck says a word about it.
 *
 * So the constants are checked against the emitted shader source, and the
 * shape of the profile is checked against what a beach is supposed to be.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CITY_HALF, bedHeight, shoreDist, beachHeightAt, waterBedHeight } from "@/city/ocean";

const src = readFileSync(join(process.cwd(), "src", "city", "ocean.ts"), "utf8");

/** Points all the way round the coast, at a spread of distances offshore. */
function ring(offset: number, count = 64) {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    // Walk out along the ray until shoreDist reaches `offset`. The p-norm is
    // monotonic along a ray, so bisection always converges.
    let lo = 1;
    let hi = 4000;
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2;
      if (shoreDist(Math.cos(a) * mid, Math.sin(a) * mid) < offset) lo = mid;
      else hi = mid;
    }
    const r = (lo + hi) / 2;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return pts;
}

describe("the ocean's terrain", () => {
  it("keeps the city plate dry, so no water is ever drawn over downtown", () => {
    for (const [x, z] of [[0, 0], [100, 0], [0, -140], [120, 120], [-170, 20]]) {
      expect(shoreDist(x, z)).toBeLessThan(0);
      expect(bedHeight(x, z)).toBeGreaterThan(0.5);
    }
  });

  it("meets the asphalt flush and rises into a berm", () => {
    for (const [x, z] of ring(0.05)) {
      // Flush at the plate edge: any step here is a kerb the player trips on.
      expect(bedHeight(x, z)).toBeLessThan(0.05);
    }
    // Somewhere on every stretch of beach there is a crest to stand on.
    const crests = ring(0.05).map(([x, z], i) => {
      const a = Math.atan2(z, x);
      let best = 0;
      for (let s = 0; s < 40; s += 0.5) {
        const px = Math.cos(a) * (Math.hypot(x, z) + s);
        const pz = Math.sin(a) * (Math.hypot(x, z) + s);
        if (shoreDist(px, pz) > 0) best = Math.max(best, bedHeight(px, pz));
      }
      return { i, best };
    });
    for (const c of crests) expect(c.best).toBeGreaterThan(0.35);
    for (const c of crests) expect(c.best).toBeLessThan(1.6);
  });

  it("drops away under the waterline and keeps dropping", () => {
    for (const [x, z] of ring(0.05, 16)) {
      const a = Math.atan2(z, x);
      const r = Math.hypot(x, z);
      const at = (s: number) => bedHeight(Math.cos(a) * (r + s), Math.sin(a) * (r + s));
      // Sampled well past the widest possible beach (30 m mean, up to 68%
      // modulation) so these are all genuinely offshore.
      expect(at(90)).toBeLessThan(-1);
      expect(at(200)).toBeLessThan(at(90));
      expect(at(600)).toBeLessThan(at(200));
      expect(at(2000)).toBeGreaterThan(-200); // still a seabed, not a pit
    }
  });

  it("gives the player the berm to walk on and nothing else", () => {
    // Inside the city the ordinary y=0 plate has to win, or every street
    // within 30 m of the coast picks up a phantom slope.
    expect(beachHeightAt(0, 0)).toBeNull();
    expect(beachHeightAt(150, 20)).toBeNull();
    // Far out to sea it must also decline, so nobody stands on the seabed.
    expect(beachHeightAt(900, 0)).toBeNull();
    let walked = 0;
    for (const [x, z] of ring(6, 48)) {
      const h = beachHeightAt(x, z);
      expect(h).not.toBeNull();
      expect(h!).toBeGreaterThanOrEqual(0);
      expect(h!).toBeLessThan(2);
      walked++;
    }
    expect(walked).toBe(48);
  });

  it("never lets the sea round the back of the dune", () => {
    // The swash raises local sea level by 0.3 m anywhere near the coast, and
    // the berm comes back down to road level where it meets the asphalt — so
    // without a barrier the sea appears at the kerb with a metre of dune
    // between it and the ocean. Everywhere on the landward side of the crest,
    // the water has to be looking at high ground.
    for (const [x, z] of ring(0.05, 48)) {
      const a = Math.atan2(z, x);
      const r = Math.hypot(x, z);
      const at = (s: number) => [Math.cos(a) * (r + s), Math.sin(a) * (r + s)] as const;
      // Walk out to the crest, checking as we go.
      let crest = 0;
      let crestAt = 0;
      for (let s = 0; s < 60; s += 0.25) {
        const h = bedHeight(...at(s));
        if (h > crest) { crest = h; crestAt = s; }
      }
      expect(crest).toBeGreaterThan(0.35);
      for (let s = 0.25; s < crestAt; s += 0.25) {
        expect(waterBedHeight(...at(s))).toBeGreaterThan(0.35);
      }
      // And seaward of the crest the seal must not lift the bed at all, or it
      // would push the waterline out to sea.
      const far = at(crestAt + 25);
      expect(waterBedHeight(...far)).toBeCloseTo(bedHeight(...far), 6);
    }
  });

  it("does not bury the corner blocks in sand", () => {
    // The coast is a p=16 norm, which trims the plate's corners. Push that
    // exponent down and the sand climbs over the outermost block at each
    // corner instead of stopping at the kerb; 174 m is that block's outer
    // face (grid 9 x 40 m pitch, 28 m blocks).
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const s = shoreDist(sx * 174, sz * 174);
        // Either the corner is still inside the plate (the usual case), or the
        // sand has only just started and is still ankle-height.
        if (s > 0) expect(bedHeight(sx * 174, sz * 174)).toBeLessThan(0.5);
        else expect(s).toBeLessThan(0);
      }
    }
    expect(CITY_HALF).toBe(180);
  });
});

describe("the city's shaders", () => {
  // Every GLSL literal under src/city, not just the ocean's. The narrower
  // version of this check lives in starfleet-shaders.test.ts and watches only
  // the directory the first accident happened in; the backtick trap has since
  // caught two more files, both of them here.
  const cityFiles = readdirSync(join(process.cwd(), "src", "city"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(join(process.cwd(), "src", "city", f), "utf8"));
  const shaders = cityFiles.flatMap((text) =>
    [...text.matchAll(/\/\* glsl \*\/\s*`([\s\S]*?)\n\s*`/g)].map((m) => m[1]),
  );

  it("declares some", () => {
    expect(shaders.length).toBeGreaterThan(2);
  });

  it("never puts a backtick inside a GLSL template literal", () => {
    // A stray backtick ends the string early and the parse errors land a
    // hundred lines away from the cause. It has happened twice in this repo.
    for (const g of shaders) expect(g.includes("`")).toBe(false);
  });

  it("balances braces in every shader", () => {
    for (const g of shaders) {
      const opens = (g.match(/{/g) ?? []).length;
      const closes = (g.match(/}/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });

  it("uses the same terrain constants as the TypeScript", () => {
    const terrain = shaders.find((g) => g.includes("float bedHeight"));
    expect(terrain).toBeDefined();
    // Every coefficient that decides where the water's edge is. If you retune
    // one of these in TS and not here, the sea stops meeting the sand.
    for (const frag of [
      "0.081", "0.043", "1.2", // scallop
      "0.037", "0.094", "2.1", "0.9",
      "0.026", "4.3", "0.7",
      "0.34", "0.0121", "0.0074", "0.6", // beachWidth
      "0.22", "0.0053", "0.0169", "2.4",
      "0.12", "0.0281", "5.1",
      "16.0", "0.0625", // the p-norm
      "1.6", "60.0", "0.045", // the shelf
      "1.43", "0.3", // the berm
      "0.44", // the dune seal
    ]) {
      expect(terrain!.includes(frag), `shader is missing ${frag}`).toBe(true);
    }
    // Read as SOURCE, so this asserts the shader interpolates the TypeScript
    // constant rather than repeating the number — a stronger guarantee than
    // comparing two literals that happen to match today.
    expect(terrain!).toContain("CITY_HALF.toFixed(1)");
    expect(CITY_HALF).toBe(180);
  });
});
