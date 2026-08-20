/**
 * The Long Night, checked without a screen.
 *
 * The festival is the one system in this world with **no state at all** — every
 * lantern and every spark is a closed-form function of the clock, and `update`
 * writes four uniforms and returns. That is the property worth defending,
 * because it is the property that makes the whole thing free to scrub through
 * and free to switch off, and it is the one a later change would quietly take
 * away: somebody adds a spawn queue, everything still looks right, and now
 * dragging the hour slider from noon to midnight produces half-formed
 * fireworks that were never there before.
 *
 * So: no allocation in a frame, no dependence on how you got to a time, and the
 * same picture whether you arrive at t=400 in one step or twelve thousand.
 *
 * The rest is the usual set of things that are invisible in a screenshot and
 * expensive to find in a browser — a NaN in an attribute (one collapses the
 * bounding sphere and the mesh silently stops drawing), a tier that does not
 * actually cost less, a fade driven off the wrong daylight, and a `dispose`
 * that leaves geometry on the card.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { buildFestival } from "@/empyrean/festival";
import { ISLAND_Y, SPAWN } from "@/empyrean/config";
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

/** Point the sun at a given altitude, which is the only input that matters. */
function sunAt(ctx: FrameContext, y: number) {
  ctx.sunDir.set(-0.62, y, -0.78).normalize();
  /* Deliberately left disagreeing with the sun. `daylight` is the lamp switch
     and is 0.32 at the sunset this world is painted at; if the festival ever
     starts reading it instead, these fixtures will catch it, because a system
     driven off `daylight` cannot tell a sunset from midnight. */
  ctx.daylight = 0.32;
  ctx.gradeDaylight = 1;
}

const meshes = (g: THREE.Object3D) => {
  const out: THREE.Mesh[] = [];
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
};

/* ------------------------------------------------------------------ */

describe("when the festival happens", () => {
  it("is switched off, and free, while the sun is up", () => {
    const f = buildFestival({ quality: "high", seedSalt: "when" });
    const ctx = makeCtx();
    for (const y of [0.9, 0.4, 0.12, 0.03]) {
      sunAt(ctx, y);
      f.update?.(ctx);
      expect(f.night).toBe(0);
      expect(f.group.visible).toBe(false);
    }
    f.dispose();
  });

  it("does not start at the sunset the world is painted at", () => {
    /* The reference sunset sits at sunDir.y ≈ 0.085 with `daylight` at 0.32.
       A festival that fades in against `daylight` would already be at two
       thirds strength here, over a sky that is still orange. */
    const f = buildFestival({ quality: "high", seedSalt: "sunset" });
    const ctx = makeCtx();
    sunAt(ctx, 0.085);
    f.update?.(ctx);
    expect(f.night).toBe(0);
    f.dispose();
  });

  it("is at full strength once the sun is properly under", () => {
    const f = buildFestival({ quality: "high", seedSalt: "night" });
    const ctx = makeCtx();
    sunAt(ctx, -0.35);
    f.update?.(ctx);
    expect(f.night).toBe(1);
    expect(f.group.visible).toBe(true);
    f.dispose();
  });

  it("fades rather than snapping, and never overshoots", () => {
    const f = buildFestival({ quality: "high", seedSalt: "fade" });
    const ctx = makeCtx();
    let prev = -1;
    for (let y = 0.06; y >= -0.2; y -= 0.005) {
      sunAt(ctx, y);
      f.update?.(ctx);
      expect(f.night).toBeGreaterThanOrEqual(0);
      expect(f.night).toBeLessThanOrEqual(1);
      /* Monotone as the sun goes down: a festival that brightens and dims on
         the way into the night reads as a flicker in the whole sky. */
      expect(f.night).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = f.night;
    }
    expect(prev).toBe(1);
    f.dispose();
  });
});

describe("the show has no memory", () => {
  it("looks identical whether you arrive in one step or twelve thousand", () => {
    /* This is the whole architectural claim. Scrubbing the hour slider moves
       `dayPhase` at 0.17 a second, so a player reaches midnight in three
       seconds; the show must be correct at a time it has never been stepped
       through. */
    const a = buildFestival({ quality: "high", seedSalt: "jump" });
    const b = buildFestival({ quality: "high", seedSalt: "jump" });

    const ctxA = makeCtx();
    sunAt(ctxA, -0.4);
    ctxA.time = 400;
    a.update?.(ctxA);

    const ctxB = makeCtx();
    sunAt(ctxB, -0.4);
    for (let t = 0; t <= 400; t += 1 / 30) {
      ctxB.time = t;
      b.update?.(ctxB);
    }
    ctxB.time = 400;
    b.update?.(ctxB);

    const uni = (h: { group: THREE.Object3D }) =>
      meshes(h.group).map((m) => {
        const u = (m.material as THREE.ShaderMaterial).uniforms;
        return [u.uTime.value, u.uNight.value];
      });
    expect(uni(a)).toEqual(uni(b));
    a.dispose();
    b.dispose();
  });

  it("allocates nothing on a frame", () => {
    const f = buildFestival({ quality: "high", seedSalt: "alloc" });
    const ctx = makeCtx();
    sunAt(ctx, -0.4);

    /* The same measurement `empyreanCrowd.test.ts` makes, for the same reason:
       an ES module namespace is frozen, so THREE's constructors cannot be
       spied on, and the honest remaining signal is the heap. */
    const run = (frames: number) => {
      for (let i = 0; i < frames; i++) {
        ctx.time += 1 / 60;
        f.update?.(ctx);
      }
    };
    run(2000);
    const before = process.memoryUsage().heapUsed;
    run(20000);
    const after = process.memoryUsage().heapUsed;

    /* Twenty thousand frames. One scratch Vector3 per frame is 20k objects and
       would still be small — so the bar is not "did it allocate a little", it
       is that a per-particle allocation, which is what a rewrite into a
       simulation would introduce, is 620 lanterns × 20k frames and could not
       possibly hide under a few megabytes. */
    expect(after - before).toBeLessThan(8 * 1024 * 1024);
    f.dispose();
  }, 30000);
});

describe("what it is made of", () => {
  it("is two draw calls, whatever the tier", () => {
    for (const quality of ["low", "high"] as const) {
      const f = buildFestival({ quality, seedSalt: "draws" });
      expect(meshes(f.group)).toHaveLength(2);
      f.dispose();
    }
  });

  it("costs meaningfully less on the low tier", () => {
    const count = (quality: "low" | "high") => {
      const f = buildFestival({ quality, seedSalt: "tier" });
      const n = meshes(f.group).reduce(
        (sum, m) => sum + (m.geometry as THREE.InstancedBufferGeometry).instanceCount * 2,
        0,
      );
      f.dispose();
      return n;
    };
    const high = count("high");
    const low = count("low");
    expect(low).toBeLessThan(high * 0.55);
    /* And an upper bound on the whole thing, because this is additively
       blended and every quad is overdraw. Two thousand triangles of glow is a
       festival; twenty thousand is a fill-rate bill on the tier least able to
       pay it. */
    expect(high).toBeLessThan(6200);
    expect(low).toBeLessThan(2000);
  });

  it("has no NaN in any attribute", () => {
    /* One NaN collapses a bounding sphere and the mesh silently stops
       drawing — no error, no warning, just an empty sky. */
    for (const quality of ["low", "high"] as const) {
      const f = buildFestival({ quality, seedSalt: "nan" });
      for (const m of meshes(f.group)) {
        for (const [name, attr] of Object.entries(m.geometry.attributes)) {
          const arr = (attr as THREE.BufferAttribute).array as ArrayLike<number>;
          for (let i = 0; i < arr.length; i++) {
            if (!Number.isFinite(arr[i])) {
              throw new Error(`${m.name}.${name}[${i}] is ${arr[i]}`);
            }
          }
        }
      }
      f.dispose();
    }
  });

  it("releases lanterns from over the city, not over the void", () => {
    const f = buildFestival({ quality: "high", seedSalt: "where" });
    const m = meshes(f.group).find((x) => x.name === "empyrean-lanterns");
    expect(m).toBeDefined();
    const o = m!.geometry.getAttribute("aOrigin");
    for (let i = 0; i < o.count; i++) {
      const r = Math.hypot(o.getX(i), o.getZ(i));
      /* Inside the plateau, so every one of them starts over ground somebody
         could be standing on. Outside it they would rise out of thin air off
         the rim, which is the one place the illusion is checkable by eye. */
      expect(r).toBeLessThan(200);
      expect(r).toBeGreaterThan(20);
      expect(o.getY(i)).toBeGreaterThan(ISLAND_Y);
      expect(o.getY(i)).toBeLessThan(ISLAND_Y + 4);
    }
    f.dispose();
  });

  it("bursts its shells above the towers and below the sky", () => {
    const f = buildFestival({ quality: "high", seedSalt: "apex" });
    const m = meshes(f.group).find((x) => x.name === "empyrean-shells");
    const a = m!.geometry.getAttribute("aApex");
    for (let i = 0; i < a.count; i++) {
      expect(a.getY(i)).toBeGreaterThan(ISLAND_Y + 100);
      expect(a.getY(i)).toBeLessThan(ISLAND_Y + 400);
    }
    f.dispose();
  });

  it("staggers its shells instead of firing them on a metronome", () => {
    /* Evenly spaced bursts are the one thing that gives a 96-second loop
       away. Assert the gaps are not all equal. */
    const f = buildFestival({ quality: "high", seedSalt: "stagger" });
    const m = meshes(f.group).find((x) => x.name === "empyrean-shells");
    const w = m!.geometry.getAttribute("aWhen");
    const times = [...new Set(Array.from({ length: w.count }, (_, i) => w.getX(i)))].sort(
      (p, q) => p - q,
    );
    expect(times.length).toBeGreaterThan(8);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const spread = Math.max(...gaps) - Math.min(...gaps);
    expect(spread).toBeGreaterThan(mean * 0.3);
    f.dispose();
  });
});

describe("teardown", () => {
  it("gives back every geometry and material it made", () => {
    const f = buildFestival({ quality: "high", seedSalt: "dispose" });
    const geos = meshes(f.group).map((m) => m.geometry);
    const mats = meshes(f.group).map((m) => m.material as THREE.Material);
    const freed = new Set<string>();
    for (const g of geos) g.addEventListener("dispose", () => freed.add(`g${g.id}`));
    for (const m of mats) m.addEventListener("dispose", () => freed.add(`m${m.id}`));

    f.dispose();
    for (const g of geos) expect(freed.has(`g${g.id}`)).toBe(true);
    for (const m of mats) expect(freed.has(`m${m.id}`)).toBe(true);
    expect(f.group.children).toHaveLength(0);
  });
});
