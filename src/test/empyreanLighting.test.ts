/**
 * The Empyrean's day cycle and shadow fit.
 *
 * Everything here is the *pure* half of `lighting.ts` — the half that decides
 * what an hour looks like and where a shadow camera goes. None of it needs a
 * GL context, which is the whole reason it was written as functions over
 * numbers rather than as methods on a rig.
 *
 * The one assertion worth defending: the day cycle and `sky.ts` must agree on
 * where the sun is at every hour, because a key light two degrees off the
 * sky's blown-out disc is unplaceably wrong in a still and impossible to find
 * in a build log.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { SUN_DIR, sunDirFor, skyPalette } from "@/empyrean/sky";
import {
  PHASE_SUNSET,
  dayLook,
  daylightAt,
  fitShadowCamera,
  makeDayLook,
  setShadowFlags,
  sunDirection,
} from "@/empyrean/lighting";

const HOURS: [string, number][] = [
  ["midnight", 0],
  ["dawn", 0.25],
  ["noon", 0.5],
  ["sunset", 0.75],
];

describe("the day cycle", () => {
  it("puts the sun exactly where the sky paints it", () => {
    const here = sunDirection(PHASE_SUNSET);
    expect(here.distanceTo(SUN_DIR)).toBeLessThan(1e-6);
    for (const [, p] of HOURS) {
      expect(sunDirection(p).distanceTo(sunDirFor(p))).toBeLessThan(1e-9);
    }
  });

  it("produces a unit sun direction at every hour", () => {
    for (let p = 0; p < 1; p += 1 / 96) {
      const d = sunDirection(p);
      expect(Number.isFinite(d.x + d.y + d.z)).toBe(true);
      expect(d.length()).toBeCloseTo(1, 6);
    }
  });

  it("puts the sun under the world at midnight, over it at noon", () => {
    expect(sunDirection(0).y).toBeLessThan(-0.5);
    expect(sunDirection(0.5).y).toBeGreaterThan(0.5);
    // Dawn and sunset are the two horizon crossings.
    expect(Math.abs(sunDirection(0.25).y)).toBeLessThan(0.05);
    expect(Math.abs(sunDirection(0.75).y)).toBeLessThan(0.05);
  });

  it("has daylight at 0 at midnight and 1 at noon", () => {
    expect(daylightAt(0)).toBeCloseTo(0, 6);
    expect(daylightAt(0.5)).toBeCloseTo(1, 6);
    expect(dayLook(0).daylight).toBeCloseTo(0, 6);
    expect(dayLook(0.5).daylight).toBeCloseTo(1, 6);
  });

  it("wraps, so a clock that runs past midnight keeps working", () => {
    const a = dayLook(0.75, makeDayLook());
    const b = dayLook(2.75, makeDayLook());
    expect(b.sunDir.distanceTo(a.sunDir)).toBeLessThan(1e-9);
    expect(dayLook(-0.25, makeDayLook()).sunDir.distanceTo(a.sunDir)).toBeLessThan(1e-9);
  });

  it("produces finite, in-gamut colours and sane intensities at every hour", () => {
    for (const [name, p] of HOURS) {
      const look = dayLook(p);
      const colours = [look.sunColor, look.skyColor, look.groundColor, look.rimColor, look.fogColor];
      for (const c of colours) {
        expect(Number.isFinite(c.r + c.g + c.b), name).toBe(true);
        expect(Math.min(c.r, c.g, c.b), name).toBeGreaterThanOrEqual(0);
        expect(Math.max(c.r, c.g, c.b), name).toBeLessThanOrEqual(1.0001);
      }
      expect(look.sunIntensity, name).toBeGreaterThan(0);
      expect(look.hemiIntensity, name).toBeGreaterThan(0);
      expect(look.exposure, name).toBeGreaterThan(0);
      expect(look.fogDensity, name).toBeGreaterThan(0);
    }
  });

  it("is brightest at noon and dimmest at midnight", () => {
    const night = dayLook(0, makeDayLook());
    const dusk = dayLook(0.75, makeDayLook());
    const noon = dayLook(0.5, makeDayLook());
    expect(night.sunIntensity).toBeLessThan(dusk.sunIntensity);
    expect(dusk.sunIntensity).toBeLessThan(noon.sunIntensity);
    expect(night.hemiIntensity).toBeLessThan(noon.hemiIntensity);
    // And the exposure goes the other way, which is the whole point of it.
    expect(night.exposure).toBeGreaterThan(noon.exposure);
  });

  it("makes the sky dome the light source at dusk and the sun's at noon", () => {
    /* The frames this table was tuned against: at 1.75 against a key of 3.2
     * the snowfield's own shading fell under `terrain.ts`'s floor and four
     * kilometres of mountains rendered as one flat plate. A sun on the
     * horizon is going through forty times the air a noon sun is; the dome
     * is what is lighting the world at that hour, and the ratio has to say
     * so rather than being a constant fraction of the key. */
    const dusk = dayLook(0.75, makeDayLook());
    const noon = dayLook(0.5, makeDayLook());
    expect(dusk.hemiIntensity / dusk.sunIntensity).toBeGreaterThan(0.8);
    expect(noon.hemiIntensity / noon.sunIntensity).toBeLessThan(0.75);
    expect(dusk.hemiIntensity / dusk.sunIntensity).toBeGreaterThan(
      noon.hemiIntensity / noon.sunIntensity,
    );
  });

  it("moves the fill and the exposure together, so the frame does not blow", () => {
    // The two are one decision: a table of light this much brighter through
    // an unchanged grade is a white one. Any hour whose product leaves this
    // band is an hour somebody raised one of them and forgot the other.
    for (let p = 0; p < 1; p += 1 / 96) {
      const look = dayLook(p, makeDayLook());
      const product = look.hemiIntensity * look.exposure;
      expect(product, `phase ${p.toFixed(3)}`).toBeGreaterThan(0.7);
      expect(product, `phase ${p.toFixed(3)}`).toBeLessThan(1.8);
    }
  });

  it("gives a vertical surface a fill worth having", () => {
    /* A hemisphere light weights the sky half out at `n.y = 0`, so a wall is
     * lit by `0.5 * (sky + ground)` and nothing else — which makes the ground
     * colour, not the sky colour, half of every facade in the city. It was
     * dark enough that shadowed walls had no colour left in them. */
    const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const dusk = dayLook(0.75, makeDayLook());
    const wall = 0.5 * (lum(dusk.skyColor) + lum(dusk.groundColor)) * dusk.hemiIntensity;
    expect(wall).toBeGreaterThan(0.8);
    // And it is a bounce off pale stone and ice, not a black card.
    expect(lum(dusk.groundColor)).toBeGreaterThan(0.1);
  });

  it("keeps the fog thin enough that a long view stays a view", () => {
    /* Aerial perspective is the point and a uniform milky wash is not. At
     * 0.00016 the ranges were 80% gone at eight kilometres, which is inside
     * the world's own extent; this keeps the distance beautiful and the
     * middle distance legible. */
    for (let p = 0; p < 1; p += 1 / 96) {
      const d = dayLook(p, makeDayLook()).fogDensity;
      expect(d, `phase ${p.toFixed(3)}`).toBeGreaterThan(0);
      expect(d, `phase ${p.toFixed(3)}`).toBeLessThanOrEqual(0.00011);
    }
  });

  it("keeps the sunset warm and the night cold", () => {
    const dusk = dayLook(0.75, makeDayLook());
    const night = dayLook(0, makeDayLook());
    expect(dusk.sunColor.r).toBeGreaterThan(dusk.sunColor.b);
    expect(night.sunColor.b).toBeGreaterThan(night.sunColor.r);
    // The sky fill at sunset must not be a blue cast on a burning city.
    expect(dusk.skyColor.r).toBeGreaterThan(dusk.skyColor.b);
  });

  it("never lets the key light drop below the horizon", () => {
    for (let p = 0; p < 1; p += 1 / 96) {
      const look = dayLook(p, makeDayLook());
      expect(look.keyDir.y).toBeGreaterThan(0.02);
      expect(look.keyDir.length()).toBeCloseTo(1, 6);
      // And it stays on the sun's side of the world, so the shading and the
      // sky never disagree about which way is west.
      const flat = new THREE.Vector2(look.sunDir.x, look.sunDir.z).normalize();
      const keyFlat = new THREE.Vector2(look.keyDir.x, look.keyDir.z).normalize();
      expect(flat.dot(keyFlat)).toBeGreaterThan(0.999);
    }
  });

  it("separates the lamp switch from the grade control", () => {
    // The palette's daylight is already well down at the hour the world is
    // painted at — right for lamps, and ruinous if it reached the grade.
    const dusk = dayLook(0.75, makeDayLook());
    expect(dusk.daylight).toBeLessThan(0.5);
    expect(dusk.gradeDaylight).toBeGreaterThan(0.95);
    expect(dusk.lampLevel).toBeGreaterThan(0.5);

    const night = dayLook(0, makeDayLook());
    expect(night.gradeDaylight).toBeCloseTo(0, 3);
    expect(night.lampLevel).toBeCloseTo(1, 3);

    const noon = dayLook(0.5, makeDayLook());
    expect(noon.gradeDaylight).toBeCloseTo(1, 6);
    expect(noon.lampLevel).toBeCloseTo(0, 3);
  });

  it("does not keep a reference into the sky's shared palette", () => {
    const look = dayLook(0.75, makeDayLook());
    const dusk = look.fogColor.clone();
    // Move the shared object on to another hour behind the look's back.
    skyPalette(0.5);
    expect(look.fogColor.equals(dusk)).toBe(true);
  });

  it("allocates nothing when handed an out", () => {
    const out = makeDayLook();
    const sun = out.sunDir;
    const col = out.sunColor;
    dayLook(0.31, out);
    expect(out.sunDir).toBe(sun);
    expect(out.sunColor).toBe(col);
  });
});

describe("the shadow fit", () => {
  const mkLight = (mapSize = 2048) => {
    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.shadow.mapSize.set(mapSize, mapSize);
    return light;
  };

  it("produces finite bounds at every hour", () => {
    const light = mkLight();
    const focus = new THREE.Vector3(12, 620, -40);
    for (let p = 0; p < 1; p += 1 / 96) {
      const look = dayLook(p, makeDayLook());
      const fit = fitShadowCamera(light, look.keyDir, focus, 120);
      for (const v of [fit.left, fit.right, fit.bottom, fit.top, fit.near, fit.far]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(Number.isFinite(fit.center.length())).toBe(true);
      expect(Number.isFinite(light.position.length())).toBe(true);
      expect(fit.near).toBeGreaterThan(0);
      expect(fit.far).toBeGreaterThan(fit.near);
      expect(fit.right).toBeGreaterThan(fit.left);
      expect(fit.top).toBeGreaterThan(fit.bottom);
      // The frustum reaches further up than out: a raking sun needs the
      // parapets and mid-rise blocks in it, not just the ground.
      expect(fit.top).toBeGreaterThan(fit.right);
      expect(fit.texel.x).toBeGreaterThan(0);
      expect(fit.texel.y).toBeGreaterThan(0);
    }
  });

  it("covers the disc it was asked for, from far enough back", () => {
    const light = mkLight();
    const look = dayLook(0.75, makeDayLook());
    const focus = new THREE.Vector3(0, 620, 0);
    const fit = fitShadowCamera(light, look.keyDir, focus, 120);
    expect(fit.radius).toBe(120);
    // Everything in the disc is inside the frustum's cross-section...
    expect(Math.min(fit.right, -fit.left, -fit.bottom)).toBeGreaterThanOrEqual(120);
    // ...and the whole disc sits between the near and far planes.
    const along = light.position.distanceTo(fit.center);
    expect(along - 120).toBeGreaterThan(fit.near);
    expect(along + 120).toBeLessThan(fit.far);
  });

  it("resolves a shadow texel finer than a pace", () => {
    const light = mkLight(2048);
    const fit = fitShadowCamera(light, dayLook(0.75, makeDayLook()).keyDir, new THREE.Vector3(0, 620, 0), 120);
    // Contact shadows are the whole argument for a small map; 0.2 m is about
    // a boot, and anything coarser stops being contact and starts being a
    // smudge that follows you around.
    expect(fit.texel.x).toBeLessThan(0.2);
    expect(fit.texel.y).toBeLessThan(0.2);
  });

  it("snaps to its own texel grid, so shadows do not crawl", () => {
    const light = mkLight();
    const key = dayLook(0.75, makeDayLook()).keyDir;
    const a = fitShadowCamera(light, key, new THREE.Vector3(0, 620, 0), 120);
    const posA = light.position.clone();
    // A tenth of a texel of movement must not move the projection at all.
    const b = fitShadowCamera(light, key, new THREE.Vector3(0.005, 620, 0.005), 120);
    expect(b.center.distanceTo(a.center)).toBeLessThan(1e-9);
    expect(light.position.distanceTo(posA)).toBeLessThan(1e-9);

    // And a large movement must land on the grid rather than near it — which
    // is what a snap that quantises in the wrong basis fails to do, and what
    // makes every edge in the frame shimmer as you walk.
    const c = fitShadowCamera(light, key, new THREE.Vector3(0, 620, 60), 120);
    expect(c.center.distanceTo(a.center)).toBeGreaterThan(1);

    // Rebuild the basis three's own `lookAt` will use, and check the centre
    // sits on whole texels in it.
    const lz = key.clone().normalize();
    const lx = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), lz).normalize();
    const ly = new THREE.Vector3().crossVectors(lz, lx).normalize();
    const offGrid = (v: number, q: number) => Math.abs(v / q - Math.round(v / q));
    expect(offGrid(c.center.dot(lx), c.texel.x)).toBeLessThan(1e-6);
    expect(offGrid(c.center.dot(ly), c.texel.y)).toBeLessThan(1e-6);
  });

  it("survives a degenerate key direction rather than producing NaN", () => {
    const light = mkLight();
    const fit = fitShadowCamera(light, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 620, 0), 120);
    expect(Number.isFinite(fit.center.length())).toBe(true);
    expect(Number.isFinite(light.position.length())).toBe(true);
    const straightUp = fitShadowCamera(light, new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 620, 0), 120);
    expect(Number.isFinite(straightUp.center.length())).toBe(true);
    expect(Number.isFinite(light.position.length())).toBe(true);
  });

  it("gives the light a bias that scales with its own texel", () => {
    const coarse = mkLight(512);
    fitShadowCamera(coarse, dayLook(0.75, makeDayLook()).keyDir, new THREE.Vector3(0, 620, 0), 120);
    const coarseBias = coarse.shadow.normalBias;
    const fine = mkLight(4096);
    fitShadowCamera(fine, dayLook(0.75, makeDayLook()).keyDir, new THREE.Vector3(0, 620, 0), 120);
    expect(fine.shadow.normalBias).toBeLessThan(coarseBias);
    expect(fine.shadow.bias).toBeLessThan(0);
  });
});

describe("shadow flags", () => {
  const tree = () => {
    const root = new THREE.Group();
    const solid = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    solid.name = "solid";
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(),
      new THREE.MeshBasicMaterial({ depthWrite: false, transparent: true }),
    );
    glow.name = "glow";
    root.add(solid, glow);
    return { root, solid, glow };
  };

  it("casts from what writes depth and nothing else", () => {
    const { root, solid, glow } = tree();
    setShadowFlags(root, true);
    expect(solid.castShadow).toBe(true);
    expect(solid.receiveShadow).toBe(true);
    // An additive glow card that cast would put a black rectangle on the deck.
    expect(glow.castShadow).toBe(false);
    expect(glow.receiveShadow).toBe(false);
  });

  it("turns everything off again, which is what the mirror needs", () => {
    const { root, solid } = tree();
    setShadowFlags(root, true);
    setShadowFlags(root, false);
    expect(solid.castShadow).toBe(false);
    expect(solid.receiveShadow).toBe(false);
  });
});
