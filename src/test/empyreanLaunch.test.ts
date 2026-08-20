/**
 * The launch site, and the two things about it that no render can check.
 *
 * The first is the **cycle**. It is a pure function of elapsed time by
 * construction, so a test can ask what the pad is doing an hour from now
 * without simulating an hour — and that is worth having, because the failures
 * available here are all slow ones. A vehicle that never comes back leaves an
 * empty pad for the rest of the session. A keyframe table with a gap in it
 * puts a NaN in a position attribute, which collapses a bounding sphere and
 * silently stops the mesh drawing. Neither shows up in a five-second look.
 *
 * The second is the **ground**. `launchsite.ts` may not import `terrain.ts` —
 * a system may not import another system — so it carries its own copy of the
 * height function. A copy drifts. This file may import both, so it does, and
 * asserts they still agree; if the ranges are ever retuned, this is what says
 * so rather than a launch pad hanging forty metres over a hillside.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { BuildContext, FrameContext } from "@/empyrean/types";
import { ISLAND_Y, KEEL_DEPTH, LAKE_R, PLATEAU_R, WORLD_R } from "@/empyrean/config";
import { groundHeight } from "@/empyrean/terrain";
import {
  APRON_X,
  APRON_Z,
  CYCLE,
  MOUNT_TOP,
  SITE_X,
  SITE_Z,
  buildLaunchSite,
  snowHeight,
  type LaunchPhase,
  type LaunchSnapshot,
} from "@/empyrean/launchsite";

const ctx: BuildContext = { quality: "high", seedSalt: "test" };

function frame(time: number, at = new THREE.Vector3(0, ISLAND_Y + 6, 120)): FrameContext {
  const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.3, 26000);
  camera.position.copy(at);
  camera.lookAt(SITE_X, 200, SITE_Z);
  camera.updateMatrixWorld(true);
  return {
    time,
    dt: 1 / 60,
    camera,
    player: {
      position: new THREE.Vector3(0, ISLAND_Y, 90),
      velocity: new THREE.Vector3(),
      yaw: 0,
      grounded: true,
      burn: 0,
      altitude: 0,
    },
    quality: "high",
    dayPhase: 0.75,
    sunDir: new THREE.Vector3(-0.95, 0.02, -0.32).normalize(),
    daylight: 0.32,
    gradeDaylight: 1,
    camRadiusSq: 120 * 120,
  };
}

/* -------------------------------------------------------------------------
 * The ground
 * ---------------------------------------------------------------------- */

describe("the ground under the pad", () => {
  it("is the terrain's own, not a second opinion", () => {
    /* Sampled over the whole basin the site sits in, and out past it, because
       the two functions agree trivially inside the lake and it is the ranges
       that get retuned. */
    let worst = 0;
    let where = "";
    for (let x = -3600; x <= 800; x += 137) {
      for (let z = -2600; z <= 1200; z += 131) {
        const d = Math.abs(snowHeight(x, z) - groundHeight(x, z));
        if (d > worst) {
          worst = d;
          where = `(${x}, ${z})`;
        }
      }
    }
    expect(worst, `launchsite's copy of groundHeight has drifted at ${where}`).toBe(0);
  });

  it("puts the site outside the lake and well inside the world", () => {
    const r = Math.hypot(SITE_X, SITE_Z);
    // Clear of the ice by a good three hundred metres, and nowhere near the
    // edge of the world. The plain it stands on runs out at about 1950.
    expect(r).toBeGreaterThan(LAKE_R + 250);
    expect(r).toBeLessThan(WORLD_R * 0.6);
  });

  it("takes its deck height from the terrain rather than assuming one", () => {
    const site = buildLaunchSite(ctx);
    const padY = site.pad.y - MOUNT_TOP;
    const yaw = Math.atan2(-SITE_X, -SITE_Z);
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    let highest = -Infinity;
    for (let i = -12; i <= 12; i++) {
      for (let j = -12; j <= 12; j++) {
        const lx = (i / 12) * APRON_X;
        const lz = (j / 12) * APRON_Z;
        highest = Math.max(highest, snowHeight(SITE_X + lx * cy + lz * sy, SITE_Z + -lx * sy + lz * cy));
      }
    }
    /* The plain out here is flat but it is not level, and it is certainly not
       `GROUND_Y`: the drifts run a few metres and the pad is graded to the
       highest ground under it, plus a margin. Assert the relationship rather
       than the number, so retuning the drifts moves the pad instead of
       burying it. */
    expect(padY).toBeGreaterThan(highest);
    expect(padY).toBeLessThan(highest + 4);
    expect(padY).not.toBe(0);
    // And it is far below the deck: nothing here competes with the island.
    expect(padY).toBeLessThan(ISLAND_Y * 0.5);
    site.dispose();
  });

  it("never lets the terrain up through the apron", () => {
    const site = buildLaunchSite(ctx);
    const padY = site.pad.y - MOUNT_TOP;
    const yaw = Math.atan2(-SITE_X, -SITE_Z);
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    /* Sampled on a finer, *offset* grid from the one the build used. Sampling
       the same points would only prove the maximum was taken correctly; the
       question is whether the ground rises between them. */
    let worst = -Infinity;
    for (let i = -21; i <= 21; i++) {
      for (let j = -21; j <= 21; j++) {
        const lx = ((i + 0.37) / 21) * APRON_X;
        const lz = ((j + 0.37) / 21) * APRON_Z;
        const x = SITE_X + lx * cy + lz * sy;
        const z = SITE_Z + -lx * sy + lz * cy;
        worst = Math.max(worst, snowHeight(x, z) - padY);
      }
    }
    expect(worst, "the snow comes up through the launch pad").toBeLessThan(0);
    site.dispose();
  });
});

/* -------------------------------------------------------------------------
 * The cycle
 * ---------------------------------------------------------------------- */

describe("the launch cycle", () => {
  const site = buildLaunchSite(ctx);
  const snap: LaunchSnapshot = site.stateAt(0);

  /** Every state through `n` cycles, at `step` seconds. */
  function sweep(n: number, step: number, from = 0): LaunchSnapshot[] {
    const out: LaunchSnapshot[] = [];
    for (let t = from; t < from + CYCLE * n; t += step) out.push(site.stateAt(t));
    return out;
  }

  it("launches, and comes back to a vehicle on the pad", () => {
    const all = sweep(1, 0.25);
    const phases = new Set<LaunchPhase>(all.map((s) => s.phase));
    for (const p of ["quiet", "prep", "ignition", "ascent", "staging", "return", "catch", "stack"]) {
      expect(phases.has(p as LaunchPhase), `never reaches "${p}"`).toBe(true);
    }
    const peak = Math.max(...all.map((s) => s.altitude));
    expect(peak).toBeGreaterThan(4000);
    expect(peak).toBeLessThan(9000);
    // And it ends where it started: on the mount, at rest, engines cold.
    const rest = all.filter((s) => s.phase === "quiet");
    expect(rest.length / all.length).toBeGreaterThan(0.4);
    for (const s of rest) {
      expect(s.altitude).toBe(0);
      expect(s.thrust).toBe(0);
      expect(s.flying).toBe(false);
    }
  });

  it("spends most of the cycle doing nothing, which is the point", () => {
    const all = sweep(1, 0.5);
    const busy = all.filter((s) => s.flying).length / all.length;
    expect(busy).toBeLessThan(0.35);
    expect(busy).toBeGreaterThan(0.15);
  });

  it("never produces a NaN, at any time, forwards or backwards", () => {
    const times = [-9999.5, -1, 0, 0.001, 1e-9, 61.25, 259, 419.999, 1e5, 3_600_000];
    for (const t of times) {
      const s = site.stateAt(t, snap);
      for (const [k, v] of Object.entries(s)) {
        if (typeof v === "number") {
          expect(Number.isFinite(v), `${k} at t=${t} is ${v}`).toBe(true);
        }
      }
    }
    for (const s of sweep(2, 0.13)) {
      expect(Number.isFinite(s.altitude + s.downrange + s.thrust + s.x + s.y + s.z)).toBe(true);
    }
  });

  it("is the same launch an hour from now as it is now", () => {
    for (let t = 0; t < CYCLE; t += 3.7) {
      const a = site.stateAt(t);
      const b = site.stateAt(t + CYCLE * 9); // an hour and three minutes later
      expect(b.phase).toBe(a.phase);
      expect(b.altitude).toBeCloseTo(a.altitude, 6);
      expect(b.thrust).toBeCloseTo(a.thrust, 6);
      expect(b.x).toBeCloseTo(a.x, 6);
      expect(b.y).toBeCloseTo(a.y, 6);
      expect(b.z).toBeCloseTo(a.z, 6);
    }
  });

  it("agrees with a second, independently built site", () => {
    const other = buildLaunchSite({ quality: "low", seedSalt: "something-else" });
    for (let t = 0; t < CYCLE; t += 7.3) {
      const a = site.stateAt(t);
      const b = other.stateAt(t);
      expect(b.phase).toBe(a.phase);
      expect(b.y).toBeCloseTo(a.y, 6);
      expect(b.countdown).toBeCloseTo(a.countdown, 6);
    }
    other.dispose();
  });

  it("counts down continuously and always to a real ignition", () => {
    let prev = site.stateAt(0).countdown;
    for (let t = 0.5; t < CYCLE * 2; t += 0.5) {
      const c = site.stateAt(t).countdown;
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(CYCLE);
      // Either it ticked down half a second, or it just wrapped past T-0.
      const stepped = Math.abs(prev - c - 0.5) < 1e-6 || c > CYCLE - 2;
      expect(stepped, `countdown jumped ${prev} -> ${c} at t=${t}`).toBe(true);
      prev = c;
    }
    // And `nextIgnition` is the same number, from the same clock.
    for (const t of [0, 12.5, 300, 1234.5]) {
      expect(site.nextIgnition(t)).toBeCloseTo(site.stateAt(t).countdown, 9);
      expect(site.stateAt(t + site.nextIgnition(t)).t).toBeCloseTo(0, 6);
    }
  });

  it("keeps the throttle between nothing and everything", () => {
    for (const s of sweep(1, 0.05)) {
      expect(s.thrust).toBeGreaterThanOrEqual(0);
      expect(s.thrust).toBeLessThanOrEqual(1);
    }
  });

  it("moves the vehicle smoothly — no teleports inside a burn", () => {
    let prev = site.stateAt(0);
    for (let t = 0.05; t < CYCLE; t += 0.05) {
      const s = site.stateAt(t);
      const d = Math.hypot(s.x - prev.x, s.y - prev.y, s.z - prev.z);
      // 0.05 s of flight. Nothing here goes faster than 600 m/s.
      expect(d, `jumped ${d.toFixed(1)} m at t=${s.t.toFixed(2)}`).toBeLessThan(30);
      prev = s;
    }
  });

  it("gives the sound nine seconds' worth of head start", () => {
    // From the plaza, at rest on the pad.
    const quiet = site.stateAt(site.nextIgnition(0) - 60 + 0, snap);
    expect(quiet.altitude).toBe(0);
    const delay = site.soundDelayFrom(0, ISLAND_Y, 0);
    expect(delay).toBeGreaterThan(5);
    expect(delay).toBeLessThan(12);
  });
});

/* -------------------------------------------------------------------------
 * Where it flies
 * ---------------------------------------------------------------------- */

describe("the trajectory", () => {
  const site = buildLaunchSite(ctx);

  it("never comes near the island", () => {
    /* The island is a 356 m disc at y=620 with 560 m of rock under it. A
       rocket that clips any of that is not a bug you find by looking — it
       happens once every seven minutes, for four seconds, from one angle. */
    let closest = Infinity;
    let when = 0;
    for (let t = 0; t < CYCLE; t += 0.1) {
      const s = site.stateAt(t);
      const r = Math.hypot(s.x, s.z);
      const inBand = s.y > ISLAND_Y - KEEL_DEPTH - 60 && s.y < ISLAND_Y + 900;
      const clear = inBand ? r - (PLATEAU_R + 60) : Infinity;
      if (clear < closest) {
        closest = clear;
        when = s.t;
      }
    }
    expect(closest, `closest approach at T${when.toFixed(0)}`).toBeGreaterThan(500);
  });

  it("flies away from the city, not over it", () => {
    const start = Math.hypot(SITE_X, SITE_Z);
    for (let t = 0; t < 60; t += 0.5) {
      const s = site.stateAt(t);
      // Downrange is outward: the radius never drops below the pad's own.
      expect(Math.hypot(s.x, s.z)).toBeGreaterThan(start - 1);
    }
  });

  it("keeps everything standing on the pad below the plaza", () => {
    const bounds = new THREE.Box3();
    site.group.updateMatrixWorld(true);
    site.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || o.name === "launchsite-trail" || o.name.endsWith("plume")) return;
      bounds.expandByObject(m);
    });
    // The tower's mast is the tallest thing here and it is 250 m under the
    // deck. The ranges are capped below the plaza for a reason and a launch
    // pad is not an exemption from it.
    expect(bounds.max.y).toBeLessThan(ISLAND_Y - 150);
    expect(bounds.min.y).toBeGreaterThan(-200);
  });
});

/* -------------------------------------------------------------------------
 * The system
 * ---------------------------------------------------------------------- */

describe("the system", () => {
  it("steps a whole launch without putting a NaN in a buffer", () => {
    const site = buildLaunchSite(ctx);
    const first = site.nextIgnition(0);
    // Through the countdown, the launch, the catch and the restack.
    for (let t = first - 50; t < first + 175; t += 1 / 12) site.update?.(frame(t));
    const bad: string[] = [];
    site.group.traverse((o) => {
      const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      if (!g?.isBufferGeometry) return;
      for (const name of Object.keys(g.attributes)) {
        const a = g.attributes[name].array as ArrayLike<number>;
        for (let i = 0; i < a.length; i++) {
          if (!Number.isFinite(a[i])) {
            bad.push(`${o.name}/${name}[${i}]`);
            break;
          }
        }
      }
    });
    expect(bad.slice(0, 5)).toEqual([]);
    site.dispose();
  });

  it("moves the tower's arms without a jump between phases", () => {
    /* The arm animation is five branches of `t` and every boundary is a value
       two of them have to agree on. They did not: the countdown left the
       carriage at 112 m and the receive phase started it at 100, so a piece of
       machinery that had been still for four minutes teleported twelve metres
       the instant the booster turned for home. Nothing catches that but this. */
    const site = buildLaunchSite(ctx);
    const carriage = site.group.getObjectByName("launchsite-carriage")!;
    const arm = site.group.getObjectByName("launchsite-arm-n")!;
    const f = frame(0);
    const step = 0.1;
    let prev: { y: number; yaw: number; open: number } | null = null;
    const first = site.nextIgnition(0);
    for (let t = first - 215; t < first + 215; t += step) {
      f.time = t;
      site.update?.(f);
      const now = { y: carriage.position.y, yaw: carriage.rotation.y, open: arm.rotation.y };
      if (prev) {
        const at = `T${(t - first).toFixed(1)}`;
        expect(Math.abs(now.y - prev.y), `carriage jumped at ${at}`).toBeLessThan(2);
        expect(Math.abs(now.yaw - prev.yaw), `arms slewed at ${at}`).toBeLessThan(0.1);
        expect(Math.abs(now.open - prev.open), `arms snapped at ${at}`).toBeLessThan(0.1);
      }
      prev = now;
    }
    site.dispose();
  });

  it("moves the upper stage in one jump, and only one, and where nobody is", () => {
    /* The cycle has to close, so at some instant a stage that flew away has to
       become a stage waiting on the cradle. That is one unavoidable cut, and
       it is placed at T+60 — when the thing that flew is seventeen kilometres
       up and a pixel wide, and the launch it came from is what everybody is
       still looking at. If a second cut ever appears, it is a bug. */
    const site = buildLaunchSite(ctx);
    const ship = site.group.getObjectByName("launchsite-ship")!;
    const f = frame(0);
    const first = site.nextIgnition(0);
    const jumps: string[] = [];
    let prev: THREE.Vector3 | null = null;
    for (let t = first - 215; t < first + 215; t += 0.1) {
      f.time = t;
      site.update?.(f);
      /* 800 m in a tenth of a second. The stage is genuinely doing 850 m/s
         by the time it fades, so the threshold has to clear real flight and
         still catch a seventeen-kilometre teleport. */
      if (prev && ship.position.distanceTo(prev) > 800) jumps.push(`T${(t - first).toFixed(1)}`);
      prev = ship.position.clone();
    }
    expect(jumps.length, jumps.join(", ")).toBe(1);
    expect(Number(jumps[0].slice(1))).toBeGreaterThan(58);
    expect(Number(jumps[0].slice(1))).toBeLessThan(62);
    site.dispose();
  });

  it("puts the vehicle where it says it does", () => {
    const site = buildLaunchSite(ctx);
    const t = site.nextIgnition(0) + 18;
    site.update?.(frame(t));
    const booster = site.group.getObjectByName("launchsite-booster")!;
    site.group.updateMatrixWorld(true);
    const world = booster.getWorldPosition(new THREE.Vector3());
    // `vehicle` is computed with hand-rolled 2-D maths rather than by walking
    // the scene graph, so the two have to be checked against each other.
    expect(world.x).toBeCloseTo(site.vehicle.x, 3);
    expect(world.y).toBeCloseTo(site.vehicle.y, 3);
    expect(world.z).toBeCloseTo(site.vehicle.z, 3);
    site.dispose();
  });

  it("costs nothing when nobody is looking at it", () => {
    const site = buildLaunchSite(ctx);
    const away = frame(site.nextIgnition(0) + 10);
    away.camera.lookAt(SITE_X * -1, ISLAND_Y, SITE_Z * -1);
    away.camera.updateMatrixWorld(true);
    site.update?.(away);
    expect(site.group.visible).toBe(false);
    expect(site.onScreen).toBe(false);
    // But the state is still true, because audio does not have a frustum.
    expect(site.thrust).toBeGreaterThan(0);
    site.update?.(frame(site.nextIgnition(0) + 10));
    expect(site.group.visible).toBe(true);
    site.dispose();
  });

  it("stays out of the lake's reflection", () => {
    const site = buildLaunchSite(ctx);
    // Two kilometres past the shore and two hundred metres above the ice: a
    // mirrored copy would be buried in a hillside and cost a second draw.
    expect(site.reflected).toBeFalsy();
    site.dispose();
  });

  it("builds cheaper at the low tier", () => {
    const count = (q: "low" | "high") => {
      const s = buildLaunchSite({ quality: q, seedSalt: "budget" });
      s.update?.(frame(s.nextIgnition(0) + 10));
      let tris = 0;
      let draws = 0;
      s.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh && !(o as THREE.Points).isPoints) return;
        if (!o.visible) return;
        draws++;
        const idx = m.geometry?.getIndex();
        if (m.isMesh) tris += (idx ? idx.count : m.geometry.getAttribute("position").count) / 3;
      });
      s.dispose();
      return { tris, draws };
    };
    const hi = count("high");
    const lo = count("low");
    expect(lo.tris).toBeLessThan(hi.tris * 0.8);
    // The budget this has to fit inside once it is registered.
    expect(hi.draws, `${hi.draws} draws while flying`).toBeLessThanOrEqual(14);
    expect(hi.tris, `${hi.tris} triangles`).toBeLessThanOrEqual(40_000);
  });

  it("disposes cleanly, twice", () => {
    const site = buildLaunchSite(ctx);
    site.update?.(frame(0));
    expect(() => site.dispose()).not.toThrow();
    expect(() => site.dispose()).not.toThrow();
  });
});
