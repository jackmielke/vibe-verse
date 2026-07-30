/**
 * weapons.test.ts — the parts of the gunplay that can be checked without a GPU.
 *
 * Everything here runs headless: the registry's invariants, the damage curve,
 * dispersion, the recoil contract (it must *return to the original aim point*),
 * capsule intersection and the projectile integrator's degradation when Rapier
 * has not booted. The rendering layers are verified in the screenshot harness,
 * not here.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { frame } from "../state/store";
import { makeRng } from "../math/rng";
import {
  WEAPONS,
  WEAPON_ORDER,
  damageAtRange,
  fireInterval,
  getWeapon,
  recoilStep,
  spreadDegrees,
} from "./registry";
import {
  clearBallistics,
  detonateSticky,
  fireHitscan,
  forEachProjectile,
  segmentCapsule,
  spawnProjectile,
  spreadDirection,
  stickyCount,
  updateBallistics,
} from "./ballistics";
import { recoilSystem } from "./recoil";
import { setHitboxProvider } from "./bridge";
import type { ShotContext } from "./types";

const ctx: ShotContext = {
  ads: 0, crouched: false, moving: false, airborne: false, sprinting: false, time: 0,
};

describe("registry", () => {
  it("has every weapon the design calls for", () => {
    for (const key of WEAPON_ORDER) expect(WEAPONS[key], key).toBeTruthy();
    expect(WEAPON_ORDER.length).toBeGreaterThanOrEqual(11);
  });

  it("keeps every profile internally consistent", () => {
    for (const key of WEAPON_ORDER) {
      const d = getWeapon(key);
      expect(d.rpm, key).toBeGreaterThan(0);
      expect(d.magazine, key).toBeGreaterThan(0);
      expect(d.recoil.pattern.length, key).toBeGreaterThan(0);
      // Damage curves must be monotonic in range and never increase with it.
      for (let i = 1; i < d.damage.length; i++) {
        expect(d.damage[i].d, key).toBeGreaterThan(d.damage[i - 1].d);
        expect(d.damage[i].dmg, key).toBeLessThanOrEqual(d.damage[i - 1].dmg);
      }
      // ADS is always tighter than the hip, crouch always helps.
      expect(d.spread.ads, key).toBeLessThan(d.spread.hip);
      expect(d.spread.crouch, key).toBeLessThan(1);
      // Reloading from empty is never faster than a tactical reload.
      expect(d.handling.reloadEmpty, key).toBeGreaterThanOrEqual(d.handling.reloadTactical);
      expect(d.handling.magInAt, key).toBeGreaterThan(d.handling.magOutAt);
    }
  });

  it("interpolates the damage curve", () => {
    const d = getWeapon("rifle");
    expect(damageAtRange(d, 0)).toBe(31);
    expect(damageAtRange(d, 40)).toBe(31);
    expect(damageAtRange(d, 1000)).toBe(19);
    const mid = damageAtRange(d, 62.5);
    expect(mid).toBeGreaterThan(23);
    expect(mid).toBeLessThan(31);
  });

  it("prices fire rate in seconds", () => {
    expect(fireInterval(getWeapon("smg"))).toBeCloseTo(60 / 900, 6);
  });

  it("widens the cone for every state the player can be in", () => {
    const d = getWeapon("rifle");
    const hip = spreadDegrees(d, ctx, 0);
    const ads = spreadDegrees(d, { ...ctx, ads: 1 }, 0);
    const moving = spreadDegrees(d, { ...ctx, moving: true }, 0);
    const air = spreadDegrees(d, { ...ctx, airborne: true }, 0);
    const crouch = spreadDegrees(d, { ...ctx, crouched: true }, 0);
    expect(ads).toBeLessThan(hip);
    expect(moving).toBeGreaterThan(hip);
    expect(air).toBeGreaterThan(moving);
    expect(crouch).toBeLessThan(hip);
    // Bloom is clamped at the weapon's ceiling, never past it.
    expect(spreadDegrees(d, ctx, 999)).toBe(d.spread.max);
  });

  it("authors recoil rather than randomising it", () => {
    const d = getWeapon("rifle");
    const out = { v: 0, h: 0 };
    const rng = makeRng("test");
    // The first five shots of an AR climb, and they climb nearly straight.
    let last = 0;
    for (let i = 0; i < 5; i++) {
      recoilStep(d, i, rng, out);
      expect(out.v).toBeGreaterThan(0.4);
      expect(Math.abs(out.h)).toBeLessThan(out.v);
      last = out.v;
    }
    expect(last).toBeGreaterThan(0);
    // Past the pattern it settles rather than exploding.
    recoilStep(d, 400, rng, out);
    expect(out.v).toBeLessThan(1);
  });
});

describe("dispersion", () => {
  it("stays inside the cone and fills it evenly", () => {
    const rng = makeRng("spread");
    const cone = 5;
    let maxAngle = 0;
    let inHalf = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const d = spreadDirection(0, 0, -1, cone, rng);
      const len = Math.hypot(d.x, d.y, d.z);
      expect(len).toBeCloseTo(1, 5);
      const a = (Math.acos(Math.min(1, -d.z)) * 180) / Math.PI;
      maxAngle = Math.max(maxAngle, a);
      if (a <= cone * 0.7071) inHalf++;
    }
    expect(maxAngle).toBeLessThanOrEqual(cone + 1e-6);
    // Uniform over the disc means ~half the shots land inside r/√2.
    expect(inHalf / N).toBeGreaterThan(0.4);
    expect(inHalf / N).toBeLessThan(0.6);
  });

  it("passes a zero cone straight through", () => {
    const d = spreadDirection(0, 1, 0, 0, makeRng("z"));
    expect(d.x).toBe(0);
    expect(d.y).toBe(1);
  });
});

describe("segmentCapsule", () => {
  it("hits a capsule dead on and misses beside it", () => {
    // Upright capsule at the origin, 1.8 m tall, 0.3 m radius.
    const t = segmentCapsule(0, 1, -5, 0, 0, 1, 20, 0, 0.5, 0, 0, 1.5, 0, 0.3);
    expect(t).toBeGreaterThan(4.6);
    expect(t).toBeLessThan(4.8);
    expect(segmentCapsule(2, 1, -5, 0, 0, 1, 20, 0, 0.5, 0, 0, 1.5, 0, 0.3)).toBe(-1);
  });

  it("hits the end cap above the segment", () => {
    const t = segmentCapsule(0, 1.7, -5, 0, 0, 1, 20, 0, 0.5, 0, 0, 1.5, 0, 0.3);
    expect(t).toBeGreaterThan(0);
  });
});

describe("recoil", () => {
  beforeEach(() => {
    recoilSystem.reset();
    frame.yaw = 0;
    frame.pitch = 0;
    frame.time = 0;
  });

  it("moves the aim up and then returns it to the original point", () => {
    const d = getWeapon("battle");
    recoilSystem.update(1 / 60, d, ctx, true); // prime the look-delta tracker
    const pitch0 = frame.pitch;
    recoilSystem.onShot(d, ctx);
    for (let i = 0; i < 12; i++) {
      frame.time += 1 / 60;
      recoilSystem.update(1 / 60, d, ctx, true);
    }
    expect(frame.pitch).toBeGreaterThan(pitch0 + 0.005);
    // Let it recover.
    for (let i = 0; i < 240; i++) {
      frame.time += 1 / 60;
      recoilSystem.update(1 / 60, d, ctx, true);
    }
    expect(frame.pitch).toBeCloseTo(pitch0, 3);
  });

  it("lets the player eat the punch by pulling down", () => {
    const d = getWeapon("battle");
    recoilSystem.update(1 / 60, d, ctx, true);
    recoilSystem.onShot(d, ctx);
    for (let i = 0; i < 6; i++) {
      frame.time += 1 / 60;
      recoilSystem.update(1 / 60, d, ctx, true);
    }
    const climbed = frame.pitch;
    expect(climbed).toBeGreaterThan(0);
    // The player drags the view back down by exactly the punch.
    frame.pitch -= climbed;
    frame.time += 1 / 60;
    recoilSystem.update(1 / 60, d, ctx, true);
    // …and the recovery must not then push it *below* where it started.
    for (let i = 0; i < 240; i++) {
      frame.time += 1 / 60;
      recoilSystem.update(1 / 60, d, ctx, true);
    }
    expect(frame.pitch).toBeGreaterThan(-0.02);
    expect(frame.pitch).toBeLessThan(0.02);
  });

  it("blooms with fire and recovers when the trigger is released", () => {
    const d = getWeapon("smg");
    for (let i = 0; i < 10; i++) recoilSystem.onShot(d, ctx);
    const bloomed = recoilSystem.bloom;
    expect(bloomed).toBeGreaterThan(0);
    for (let i = 0; i < 120; i++) {
      frame.time += 1 / 60;
      recoilSystem.update(1 / 60, d, ctx, true);
    }
    expect(recoilSystem.bloom).toBe(0);
  });
});

describe("ballistics without a physics world", () => {
  beforeEach(() => {
    clearBallistics();
    setHitboxProvider(null);
    frame.time = 0;
  });

  it("degrades to zero impacts rather than throwing", () => {
    const d = getWeapon("rifle");
    let impacts = 0;
    const n = fireHitscan(d, 0, 50, 0, 0, 0, -1, ctx, makeRng("shot"), () => {
      impacts++;
    });
    expect(n).toBe(0);
    expect(impacts).toBe(0);
  });

  it("resolves a hit against a registered hitbox, with the head multiplier", () => {
    const d = getWeapon("rifle");
    setHitboxProvider({
      query(_t, _ax, _ay, _az, _bx, _by, _bz, out) {
        out[0].targetId = 7;
        out[0].part = "head";
        out[0].ax = 0; out[0].ay = 61.7; out[0].az = -30;
        out[0].bx = 0; out[0].by = 61.8; out[0].bz = -30;
        out[0].radius = 0.12;
        out[0].scale = 1;
        out[0].alive = true;
        return 1;
      },
    });
    let hitDamage = 0;
    let part = "";
    fireHitscan(d, 0, 61.75, 0, 0, 0, -1, ctx, makeRng("shot"), (h) => {
      hitDamage = h.damage;
      part = h.part;
    });
    expect(part).toBe("head");
    // 31 base × 2.0 head multiplier at 30 m.
    expect(hitDamage).toBeCloseTo(62, 0);
    setHitboxProvider(null);
  });

  it("arcs a grenade and detonates it on the fuse", () => {
    const d = getWeapon("grenade");
    const p = spawnProjectile(d, 0, 200, 0, 0, 0.2, -1, ctx, { fuse: 1.2 });
    expect(p).toBeTruthy();
    let live = 0;
    forEachProjectile(() => live++);
    expect(live).toBe(1);

    let z = p!.z;
    updateBallistics(0.1, () => undefined);
    expect(p!.z).toBeLessThan(z); // travelling forward (-Z)
    z = p!.z;

    for (let i = 0; i < 20; i++) updateBallistics(0.1, () => undefined);
    live = 0;
    forEachProjectile(() => live++);
    expect(live).toBe(0); // fuse blew it
  });

  it("holds sticky mines until the detonator is pressed", () => {
    const d = getWeapon("sticky");
    // Fired straight down from just above the terrain: the ground backstop
    // catches it even with no colliders streamed in.
    spawnProjectile(d, 0, 40, 0, 0, -1, 0, ctx);
    for (let i = 0; i < 150; i++) updateBallistics(1 / 60, () => undefined);
    expect(stickyCount()).toBe(1);
    // A sticky has an infinite fuse: time alone must never set it off.
    for (let i = 0; i < 300; i++) updateBallistics(1 / 60, () => undefined);
    expect(stickyCount()).toBe(1);
    const n = detonateSticky(() => undefined, true);
    expect(n).toBe(1);
    expect(stickyCount()).toBe(0);
  });
});
