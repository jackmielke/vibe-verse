/**
 * The water half of the city's audio.
 *
 * `citySounds` synthesises everything — there are no assets — so these are
 * assertions about a WebAudio graph and the envelopes hung off it. jsdom has no
 * AudioContext, so this reads the source rather than running it; what it is
 * guarding is the handful of decisions that are silently reversible. A wrong
 * filter frequency is audible. A `master` reconnected straight to the
 * destination is not audible at all — it just means going underwater stops
 * doing anything, and nobody notices until they go looking.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(__dirname, "../lib/citySounds.ts"), "utf8");
/**
 * Where the implementations start.
 *
 * Every method name appears twice in this file — once in the `CitySounds`
 * interface and once in the object `createCitySounds` returns — so slicing
 * from a bare `indexOf(name)` lands in the interface and hands you a
 * hundred-character block of type declarations that contains none of the
 * envelope you meant to check.
 */
const IMPL = src.indexOf("  return {");
const citySrc = readFileSync(resolve(__dirname, "../pages/City.tsx"), "utf8");

describe("the submerged filter", () => {
  it("is in the path everything leaves through", () => {
    // The whole value of this effect is that it applies to sounds nobody
    // wrote for it: the jetpack, the wind, the chimes, the city. Hang it off
    // individual sounds instead and you have muffled three things.
    expect(src).toMatch(/master\.connect\(submergeGain\)\.connect\(submerge\)\.connect\(ctx\.destination\)/);
  });

  it("does not fight setMuted over the same gain", () => {
    // Two things ramping one AudioParam with `setTargetAtTime` do not average,
    // they overwrite — and the loser is whichever ran first. Muting would come
    // undone every time the swimmer moved.
    expect(src).toMatch(/setMuted\(muted\) \{\s*\n\s*master\.gain\.setTargetAtTime/);
    expect(src).toMatch(/submergeGain\.gain\.setTargetAtTime/);
  });

  it("sweeps geometrically, not linearly", () => {
    // Pitch is heard logarithmically. A linear sweep down from 20 kHz spends
    // three quarters of its travel in a range where nothing audible changes,
    // then slams shut at the end — which reads as a switch, not as sinking.
    expect(src).toMatch(/20000 \* Math\.pow\(360 \/ 20000, x\)/);
  });

  it("opens all the way up when you are dry", () => {
    // A lowpass parked below the top of hearing is a permanent tone control on
    // the entire game.
    expect(src).toMatch(/submerge\.frequency\.value = 20000;/);
  });

  it("is driven by the camera's depth, not the swimmer's", () => {
    // The listener is the camera, for the same reason the fog is: a swimmer
    // six metres down with the chase camera up in the sunshine is, to both
    // eyes and ears, above water.
    expect(citySrc).toMatch(/setSubmerged\?\.\(THREE\.MathUtils\.clamp\(camDepth/);
  });
});

describe("the new sounds", () => {
  it("makes a splash out of noise, not an oscillator", () => {
    // Water has no pitch. An oscillator is a whistle.
    const splash = src.slice(src.indexOf("splash(strength", IMPL), src.indexOf("boom(strength", IMPL));
    expect(splash.length).toBeGreaterThan(200);
    expect(splash).toContain("noiseBuf");
    expect(splash).not.toContain("createOscillator");
  });

  it("sweeps the splash filter down rather than sitting still", () => {
    // Bright at contact, closing to a low churn as the froth collapses. A
    // fixed filter over noise is a hiss.
    const splash = src.slice(src.indexOf("splash(strength", IMPL), src.indexOf("boom(strength", IMPL));
    expect(splash).toMatch(/frequency\.exponentialRampToValueAtTime\(24\d/);
  });

  it("gives the explosion a body you feel and a tail you hear", () => {
    const boom = src.slice(src.indexOf("boom(strength", IMPL), src.indexOf("bubble(gain", IMPL));
    expect(boom.length).toBeGreaterThan(200);
    // The sine dropped through two octaves is the punch.
    expect(boom).toContain("createOscillator");
    // The noise closing to a rumble is the roll.
    expect(boom).toContain("noiseBuf");
  });

  it("makes bubbles rise in pitch", () => {
    // A bubble's resonant frequency CLIMBS as it shrinks. A falling blip
    // sounds like a game menu; a rising one sounds like air in water. This is
    // the single detail that decides which one you get.
    const bub = src.slice(src.indexOf("bubble(gain", IMPL), src.indexOf("setSubmerged(k)", IMPL));
    expect(bub).toMatch(/exponentialRampToValueAtTime\(f0 \* [\d.]+/);
    const m = bub.match(/exponentialRampToValueAtTime\(f0 \* ([\d.]+)/);
    expect(Number(m![1])).toBeGreaterThan(1);
  });
});

describe("what plays when", () => {
  it("uses a splash for water and keeps thud for landings", () => {
    // `thud` is a body hitting ground, and it is what stepping into the sea
    // sounded like until there was anything better.
    expect(citySrc).toMatch(/soundsRef\.current\?\.splash\?\.\(0\.15 \+ impact \* 0\.55\)/);
  });

  it("only detonates above the same speed the fireball needs", () => {
    // A splash with no explosion is a car rolling in off the sand. The two
    // gates have to agree or you get a bang with no fire, or fire in silence.
    expect(citySrc).toMatch(/if \(hit > 11\) \{[\s\S]{0,240}?soundsRef\.current\?\.boom\?\./);
  });

  it("throttles the bubbles well below the rate they are drawn", () => {
    // Thirty a second is not a wreck venting air, it is a kettle.
    expect(citySrc).toMatch(/bubbleSfx = 0\.\d+ \+ Math\.random\(\) \* 0\.\d+;/);
  });
});
