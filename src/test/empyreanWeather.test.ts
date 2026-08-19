/**
 * The Empyrean's weather, simulated headlessly.
 *
 * Everything asserted here is something that is invisible in a screenshot and
 * expensive to find in a browser: a cycle that lands on a condition nobody
 * wrote, a wind vector that goes `NaN` on the island's own axis and takes six
 * thousand flakes with it, a drift accumulator that grows without bound over an
 * hour of flying, a particle count that quietly doubles on the low tier, a
 * `force()` that never lets go, and a `dispose()` that leaves geometry on the
 * card. None of it renders; all of it is cheap.
 */
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";

import { buildWeather, CONDITIONS, type Condition } from "@/empyrean/weather";
import { ISLAND_Y, LAKE_R, PLATEAU_R, SPAWN, WORLD_R } from "@/empyrean/config";
import type { FrameContext } from "@/empyrean/types";

function makeCtx(quality: "low" | "high" = "high"): FrameContext {
  const camera = new THREE.PerspectiveCamera(58, 1.6, 0.3, 26000);
  camera.position.set(SPAWN.x, SPAWN.y + 4, SPAWN.z + 8);
  camera.updateMatrixWorld();
  return {
    time: 0,
    dt: 1 / 60,
    camera,
    player: {
      position: new THREE.Vector3(SPAWN.x, SPAWN.y, SPAWN.z),
      velocity: new THREE.Vector3(),
      yaw: 0,
      grounded: true,
      burn: 0,
      altitude: 0,
    },
    quality,
    dayPhase: 0.75,
    sunDir: new THREE.Vector3(-0.62, 0.085, -0.78).normalize(),
    daylight: 0.32,
    gradeDaylight: 1,
    camRadiusSq: SPAWN.z * SPAWN.z,
  };
}

/** Advance real seconds at a plausible frame time. */
function run(w: { update?: (c: FrameContext) => void }, ctx: FrameContext, seconds: number) {
  const dt = 1 / 30;
  ctx.dt = dt;
  for (let t = 0; t < seconds; t += dt) {
    ctx.time += dt;
    w.update?.(ctx);
  }
}

/* ------------------------------------------------------------------ */

describe("the weather cycle", () => {
  it("always lands on a condition that exists, at every hour of a long day", () => {
    const w = buildWeather({ quality: "high", seedSalt: "cycle" });
    const ctx = makeCtx();
    ctx.dt = 0.05;
    const seen = new Set<Condition>();
    // The schedule is analytic in `ctx.time`, so an hour can be sampled rather
    // than simulated — which is the whole reason it was written that way.
    for (let i = 0; i < 900; i++) {
      ctx.time = i * 4;
      ctx.dayPhase = (0.75 + i / 900) % 1;
      w.update?.(ctx);
      expect(CONDITIONS).toContain(w.condition);
      expect(Number.isFinite(w.blend)).toBe(true);
      expect(w.blend).toBeGreaterThanOrEqual(0);
      expect(w.blend).toBeLessThanOrEqual(1);
      seen.add(w.condition);
    }
    // Over an hour it must actually move. A cycle stuck on one condition is a
    // hash that always returns the same bucket, and it looks fine for a minute.
    expect(seen.size).toBeGreaterThanOrEqual(3);
    w.dispose();
  });

  it("transitions over minutes rather than seconds", () => {
    const w = buildWeather({ quality: "high", seedSalt: "slow" });
    const ctx = makeCtx();
    ctx.dt = 0.05;
    let changes = 0;
    let prev: Condition | null = null;
    for (let i = 0; i < 2000; i++) {
      ctx.time = i * 1.5; // 50 minutes
      w.update?.(ctx);
      if (prev !== null && w.condition !== prev) changes++;
      prev = w.condition;
    }
    // 3000 seconds against a 260-second slot is a dozen-odd slots, and a good
    // fraction of those repeat. Anything near the sample count means the
    // condition is flickering frame to frame.
    expect(changes).toBeGreaterThan(2);
    expect(changes).toBeLessThan(30);
    w.dispose();
  });

  it("is reproducible from the seed and the elapsed time", () => {
    const a = buildWeather({ quality: "high", seedSalt: "same" });
    const b = buildWeather({ quality: "high", seedSalt: "same" });
    const c = buildWeather({ quality: "high", seedSalt: "different" });
    const ctxA = makeCtx();
    const ctxB = makeCtx();
    const ctxC = makeCtx();
    const seqA: Condition[] = [];
    const seqB: Condition[] = [];
    const seqC: Condition[] = [];
    for (let i = 0; i < 200; i++) {
      const t = i * 37;
      for (const [w, ctx, seq] of [
        [a, ctxA, seqA],
        [b, ctxB, seqB],
        [c, ctxC, seqC],
      ] as const) {
        ctx.time = t;
        ctx.dt = 0.05;
        w.update?.(ctx);
        seq.push(w.condition);
      }
    }
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    a.dispose();
    b.dispose();
    c.dispose();
  });

  it("forces a condition, and lets go of it again", () => {
    const w = buildWeather({ quality: "high", seedSalt: "force" });
    const ctx = makeCtx();

    run(w, ctx, 30);
    const natural = w.condition;

    w.force("snow");
    expect(w.condition).toBe("snow");
    run(w, ctx, 6);
    expect(w.condition).toBe("snow");
    expect(w.blend).toBeGreaterThan(0.95);
    // A forced squall is a squall: it has to actually make weather.
    expect(w.fogBoost).toBeGreaterThan(0);

    for (const c of CONDITIONS) {
      w.force(c);
      run(w, ctx, 6);
      expect(w.condition).toBe(c);
      expect(w.blend).toBeGreaterThan(0.95);
    }

    w.force(null);
    run(w, ctx, 12);
    expect(CONDITIONS).toContain(w.condition);
    expect(w.blend).toBeGreaterThan(0.9);

    // Back on the schedule: the cycle it resumes is the one it would have been
    // on had nobody forced anything.
    const fresh = buildWeather({ quality: "high", seedSalt: "force" });
    const ctx2 = makeCtx();
    ctx2.dt = 0.05;
    ctx2.time = ctx.time;
    fresh.update?.(ctx2);
    expect(w.condition).toBe(fresh.condition);
    expect(natural).toBeDefined();
    fresh.dispose();
    w.dispose();
  });
});

/* ------------------------------------------------------------------ */

describe("the wind", () => {
  const w = buildWeather({ quality: "high", seedSalt: "wind" });
  const ctx = makeCtx();
  const out = new THREE.Vector3();

  const finite = (v: THREE.Vector3) =>
    Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

  it("is finite on the island's own axis, where the tangent is undefined", () => {
    for (const y of [-4000, 0, ISLAND_Y, ISLAND_Y + 5000]) {
      w.windAt(0, y, 0, out);
      expect(finite(out)).toBe(true);
    }
  });

  it("is finite everywhere in the world, and outside it", () => {
    const coords = [
      0,
      1e-9,
      -1e-9,
      1,
      PLATEAU_R,
      LAKE_R,
      WORLD_R,
      -WORLD_R,
      1e6,
      -1e9,
      1e12,
      Number.MAX_SAFE_INTEGER,
      -Number.MAX_SAFE_INTEGER,
    ];
    for (const x of coords) {
      for (const z of coords) {
        for (const y of [0, ISLAND_Y, -1e9, 1e9]) {
          w.windAt(x, y, z, out);
          expect(finite(out)).toBe(true);
        }
      }
    }
  });

  it("returns the vector it was handed, so callers can preallocate", () => {
    const target = new THREE.Vector3();
    expect(w.windAt(10, ISLAND_Y, 10, target)).toBe(target);
  });

  it("is stronger over the rim than in the middle of the Halo", () => {
    w.force("snow");
    run(w, ctx, 8);
    let rim = 0;
    let halo = 0;
    // Sampled over time, because the gust field varies in space and one sample
    // proves nothing about a sinusoid.
    for (let i = 0; i < 200; i++) {
      run(w, ctx, 0.2);
      rim += w.windAt(PLATEAU_R - 6, ISLAND_Y + 2, 0, out).length();
      halo += w.windAt(4, ISLAND_Y + 2, 0, out).length();
    }
    expect(rim).toBeGreaterThan(halo * 1.3);
  });

  it("is stronger high above the deck than on it", () => {
    let high = 0;
    let low = 0;
    for (let i = 0; i < 120; i++) {
      run(w, ctx, 0.2);
      high += w.windAt(900, ISLAND_Y + 900, 900, out).length();
      low += w.windAt(900, 40, 900, out).length();
    }
    expect(high).toBeGreaterThan(low);
  });

  it("is calmer in a golden calm than in a squall", () => {
    w.force("calm");
    run(w, ctx, 8);
    let calm = 0;
    for (let i = 0; i < 60; i++) {
      run(w, ctx, 0.2);
      calm += w.windAt(600, ISLAND_Y, 0, out).length();
    }
    w.force("snow");
    run(w, ctx, 8);
    let squall = 0;
    for (let i = 0; i < 60; i++) {
      run(w, ctx, 0.2);
      squall += w.windAt(600, ISLAND_Y, 0, out).length();
    }
    expect(squall).toBeGreaterThan(calm * 3);
    w.force(null);
  });

  it("still answers when the system is switched off", () => {
    w.setEnabled(false);
    run(w, ctx, 2);
    w.windAt(100, ISLAND_Y, 100, out);
    expect(finite(out)).toBe(true);
    expect(out.length()).toBeGreaterThan(0);
    w.setEnabled(true);
  });
});

/* ------------------------------------------------------------------ */

describe("the budgets", () => {
  function countOf(w: ReturnType<typeof buildWeather>, name: string): number {
    const o = w.group.getObjectByName(name);
    if (!o) return 0;
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry &
      Partial<THREE.InstancedBufferGeometry>;
    const pos = g.getAttribute("position");
    const inst = g.getAttribute("iPos");
    if (inst) return (g.instanceCount as number) ?? inst.count;
    return pos ? pos.count : 0;
  }

  it("keeps snow inside the tier caps, in one draw call each", () => {
    const hi = buildWeather({ quality: "high", seedSalt: "budget" });
    const lo = buildWeather({ quality: "low", seedSalt: "budget" });

    expect(countOf(hi, "empyrean-snow-volume")).toBe(6000);
    expect(countOf(hi, "empyrean-snow-volume")).toBeLessThanOrEqual(6000);
    expect(countOf(lo, "empyrean-snow-volume")).toBe(1500);
    expect(countOf(lo, "empyrean-snow-volume")).toBeLessThanOrEqual(1500);

    // One object per system means one draw call per system: the snow is a
    // single `Points`, not a pool of them.
    const snowHi = hi.group.getObjectByName("empyrean-snow-volume");
    expect(snowHi).toBeInstanceOf(THREE.Points);
    expect(snowHi?.children.length).toBe(0);

    hi.dispose();
    lo.dispose();
  });

  it("draws the whole atmosphere in six objects at high and five at low", () => {
    const hi = buildWeather({ quality: "high", seedSalt: "draws" });
    const lo = buildWeather({ quality: "low", seedSalt: "draws" });
    let drawablesHi = 0;
    hi.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine) {
        drawablesHi++;
      }
    });
    expect(drawablesHi).toBe(6);

    // Light shafts are the one thing the low tier does without; the object is
    // still there, with nothing instanced into it.
    const shafts = lo.group.getObjectByName("empyrean-shafts") as THREE.Mesh;
    const g = shafts.geometry as THREE.InstancedBufferGeometry;
    expect(g.instanceCount).toBe(0);
    expect(shafts.visible).toBe(false);

    // And every other budget is smaller on low than on high.
    for (const name of ["empyrean-cloudbanks", "empyrean-birds"]) {
      expect(countOf(lo, name)).toBeLessThan(countOf(hi, name));
    }

    hi.dispose();
    lo.dispose();
  });

  it("caps the cloud and mist puffs well under a thousand", () => {
    const hi = buildWeather({ quality: "high", seedSalt: "puffs" });
    const lo = buildWeather({ quality: "low", seedSalt: "puffs" });
    expect(countOf(hi, "empyrean-cloudbanks")).toBeLessThanOrEqual(600);
    expect(countOf(lo, "empyrean-cloudbanks")).toBeLessThanOrEqual(200);
    expect(countOf(hi, "empyrean-birds")).toBeLessThanOrEqual(96);
    hi.dispose();
    lo.dispose();
  });

  it("shows nothing at all when it is switched off", () => {
    const w = buildWeather({ quality: "high", seedSalt: "off" });
    const ctx = makeCtx();
    w.force("snow");
    run(w, ctx, 6);
    expect(w.group.getObjectByName("empyrean-snow-volume")?.visible).toBe(true);
    w.setEnabled(false);
    run(w, ctx, 2);
    expect(w.group.visible).toBe(false);
    w.group.traverse((o) => {
      if (o !== w.group) expect(o.visible).toBe(false);
    });
    w.dispose();
  });
});

/* ------------------------------------------------------------------ */

describe("flying through it", () => {
  it("never lets the snow's drift accumulators run away", () => {
    const w = buildWeather({ quality: "high", seedSalt: "drift" });
    const ctx = makeCtx();
    w.force("snow");
    const snow = w.group.getObjectByName("empyrean-snow-volume") as THREE.Points;
    const mat = snow.material as THREE.ShaderMaterial;
    const half = mat.uniforms.uHalf.value as THREE.Vector3;

    // Ten minutes of boosting in a straight line, which is what a player who
    // has found the horizon actually does.
    ctx.dt = 1 / 30;
    for (let i = 0; i < 18000; i++) {
      ctx.time += ctx.dt;
      ctx.camera.position.x += 34 * ctx.dt;
      ctx.camera.position.y += 3 * ctx.dt;
      w.update?.(ctx);
    }
    const wind = mat.uniforms.uWindDrift.value as THREE.Vector3;
    const cam = mat.uniforms.uCamDrift.value as THREE.Vector3;
    for (const v of [wind, cam]) {
      expect(Number.isFinite(v.x)).toBe(true);
      expect(Number.isFinite(v.y)).toBe(true);
      expect(Number.isFinite(v.z)).toBe(true);
      expect(Math.abs(v.x)).toBeLessThanOrEqual(half.x + 1e-3);
      expect(Math.abs(v.y)).toBeLessThanOrEqual(half.y + 1e-3);
      expect(Math.abs(v.z)).toBeLessThanOrEqual(half.z + 1e-3);
    }
    // The volume follows the camera; it is 144 m across and the world is 18 km.
    expect(snow.position.x).toBeCloseTo(ctx.camera.position.x, 3);
    w.dispose();
  });

  it("keeps the fog boost inside something the city stays visible through", () => {
    const w = buildWeather({ quality: "high", seedSalt: "fog" });
    const ctx = makeCtx();
    for (const c of CONDITIONS) {
      w.force(c);
      for (const camY of [4, 200, ISLAND_Y, ISLAND_Y + 900]) {
        ctx.camera.position.y = camY;
        run(w, ctx, 6);
        expect(w.fogBoost).toBeGreaterThanOrEqual(0);
        // The engine's own density tops out at 0.00016; anything past a
        // quarter-thousandth and the far ranges stop existing.
        expect(w.fogBoost).toBeLessThanOrEqual(0.00024);
      }
    }

    // Mist is the thick one, and it is thick in the basin and not on the deck.
    w.force("mist");
    ctx.dayPhase = 0.22; // dawn, when the basin actually fills
    ctx.camera.position.y = 8;
    run(w, ctx, 8);
    const inBasin = w.fogBoost;
    ctx.camera.position.y = ISLAND_Y;
    run(w, ctx, 8);
    const onDeck = w.fogBoost;
    expect(inBasin).toBeGreaterThan(onDeck);
    w.dispose();
  });

  it("keeps the birds on the island and pointing somewhere", () => {
    const w = buildWeather({ quality: "high", seedSalt: "birds" });
    const ctx = makeCtx();
    const birds = w.group.getObjectByName("empyrean-birds") as THREE.Mesh;
    const geo = birds.geometry as THREE.InstancedBufferGeometry;

    run(w, ctx, 240);
    const pos = geo.getAttribute("iPos");
    const fwd = geo.getAttribute("iFwd");
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)).toBe(true);
      expect(Math.hypot(x, z)).toBeLessThan(2500);
      expect(y).toBeGreaterThan(-200);
      expect(y).toBeLessThan(ISLAND_Y + 800);
      const len = Math.hypot(fwd.getX(i), fwd.getY(i), fwd.getZ(i));
      expect(len).toBeGreaterThan(0.9);
      expect(len).toBeLessThan(1.1);
    }
    w.dispose();
  });

  it("scatters a flock the player flies into", () => {
    const w = buildWeather({ quality: "high", seedSalt: "scatter" });
    const ctx = makeCtx();
    const birds = w.group.getObjectByName("empyrean-birds") as THREE.Mesh;
    const geo = birds.geometry as THREE.InstancedBufferGeometry;
    const pos = geo.getAttribute("iPos");

    run(w, ctx, 60);
    const spread = () => {
      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < 22; i++) {
        cx += pos.getX(i);
        cy += pos.getY(i);
        cz += pos.getZ(i);
      }
      cx /= 22; cy /= 22; cz /= 22;
      let s = 0;
      for (let i = 0; i < 22; i++) {
        s += Math.hypot(pos.getX(i) - cx, pos.getY(i) - cy, pos.getZ(i) - cz);
      }
      return s / 22;
    };
    const before = spread();

    // Put the player in the middle of the first flock.
    ctx.player.position.set(pos.getX(0), pos.getY(0), pos.getZ(0));
    run(w, ctx, 1.5);
    expect(spread()).toBeGreaterThan(before);
    w.dispose();
  });
});

/* ------------------------------------------------------------------ */

describe("teardown", () => {
  it("disposes every geometry, material and texture it made", () => {
    const w = buildWeather({ quality: "high", seedSalt: "dispose" });
    const ctx = makeCtx();
    run(w, ctx, 4);

    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    const texs = new Set<THREE.Texture>();
    w.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) geos.add(m.geometry);
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => mats.add(x));
      else if (mat) mats.add(mat);
    });
    for (const m of mats) {
      const sm = m as THREE.ShaderMaterial;
      if (!sm.uniforms) continue;
      for (const k of Object.keys(sm.uniforms)) {
        const v = sm.uniforms[k].value as THREE.Texture | undefined;
        if (v && (v as THREE.Texture).isTexture) texs.add(v);
      }
    }

    expect(geos.size).toBe(6);
    expect(mats.size).toBe(6);
    expect(texs.size).toBeGreaterThanOrEqual(1);

    const spies = [
      ...[...geos].map((g) => vi.spyOn(g, "dispose")),
      ...[...mats].map((m) => vi.spyOn(m, "dispose")),
      ...[...texs].map((t) => vi.spyOn(t, "dispose")),
    ];

    w.dispose();

    for (const s of spies) expect(s).toHaveBeenCalled();
    expect(w.group.children.length).toBe(0);
  });

  it("survives being disposed without ever having been updated", () => {
    const w = buildWeather({ quality: "low", seedSalt: "cold" });
    expect(() => w.dispose()).not.toThrow();
  });
});
