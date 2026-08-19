/**
 * What The Empyrean is allowed to cost.
 *
 * Frame rate cannot be measured here — CI and this container have no GPU and
 * Chromium falls back to a software rasteriser — but the numbers that *cause*
 * frame rate can, and they are exact: how many draw calls the page asks the
 * driver for, and how many triangles it hands over. Those are identical on a
 * real GPU, so they are the thing to hold a line on.
 *
 * The budgets below are ceilings with real headroom, not targets. They exist
 * to catch the specific regression this architecture invites: a system that
 * stops merging or stops instancing and quietly turns eight hundred objects
 * into eight hundred draws. Nothing about that shows up in a build, a
 * typecheck, or any of the per-system tests — the world simply gets slower on
 * somebody else's laptop.
 *
 * If a change genuinely needs more, raise the number *and say why in the
 * commit*. A budget nobody may ever raise is a budget people route around.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { BuildContext, FrameContext, System } from "@/empyrean/types";
import { ISLAND_Y } from "@/empyrean/config";
import { buildKeel } from "@/empyrean/keel";
import { buildStreets } from "@/empyrean/streets";
import { buildBuildings } from "@/empyrean/buildings";
import { buildProps } from "@/empyrean/props";
import { buildCrowd } from "@/empyrean/crowd";
import { buildTraffic } from "@/empyrean/traffic";
import { buildInteriors } from "@/empyrean/interiors";
import { buildActivities } from "@/empyrean/activities";
import { buildWeather } from "@/empyrean/weather";
import { buildVehicles } from "@/empyrean/vehicles";

/**
 * Draws and triangles under an object, counted the way the driver would.
 *
 * An `InstancedMesh` is one draw whatever its count — that is the entire
 * reason to use one — but its triangles are per instance, and a system that
 * instances a thousand trees is cheap on calls and not on fill.
 */
function cost(root: THREE.Object3D): { draws: number; tris: number } {
  let draws = 0;
  let tris = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    const inst = o as THREE.InstancedMesh;
    const pts = o as THREE.Points;
    const isDrawable = m.isMesh || pts.isPoints || (o as THREE.LineSegments).isLineSegments;
    if (!isDrawable || !o.visible) return;
    const geo = m.geometry as THREE.BufferGeometry | undefined;
    if (!geo) return;
    draws += 1;
    const index = geo.getIndex();
    const verts = index ? index.count : (geo.getAttribute("position")?.count ?? 0);
    const per = m.isMesh ? verts / 3 : 0;
    tris += per * (inst.isInstancedMesh ? inst.count : 1);
  });
  return { draws, tris: Math.round(tris) };
}

/**
 * Stepped twice before measuring, on purpose.
 *
 * A population allocates its instances up front and sets `InstancedMesh.count`
 * on its first update, so a system measured at build time reports the crowd as
 * costing nothing at all — which is the most expensive system in the world
 * being invisible to its own budget.
 */
function frame(time: number): FrameContext {
  const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.3, 26000);
  camera.position.set(0, ISLAND_Y + 6, 120);
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
    sunDir: new THREE.Vector3(-0.62, 0.085, -0.78).normalize(),
    daylight: 0.32,
    gradeDaylight: 1,
    camRadiusSq: 14400,
  };
}

function buildAll(quality: "low" | "high"): Array<{ name: string } & ReturnType<typeof cost>> {
  const ctx: BuildContext = { quality, seedSalt: "budget" };
  const interiors = buildInteriors(ctx);
  const systems: System[] = [
    buildKeel(ctx),
    buildStreets(ctx),
    buildBuildings(ctx, { skipLots: interiors.claimedLots }),
    buildProps(ctx),
    interiors,
    buildCrowd(ctx),
    buildTraffic(ctx),
    buildActivities(ctx),
    buildWeather(ctx),
    buildVehicles(ctx),
  ];
  /* Two seconds of frames, not two.
   *
   * Populations do not reach their steady state on the first update: bodies
   * are spawned over time, LOD buckets are filled as agents come into range,
   * and a system measured at t=0 reports a crowd of zero. Two seconds is
   * enough for every one of them here and still costs a few milliseconds. */
  for (let i = 0; i < 120; i++) {
    const f = frame(i / 60);
    for (const s of systems) s.update?.(f);
  }
  const out = systems.map((s) => ({ name: s.name, ...cost(s.group) }));
  for (const s of systems) s.dispose();
  return out;
}

/**
 * Per-system ceilings.
 *
 * Draws are the number that matters most on the weak hardware this has to run
 * on: every one is a state change and a validation pass in the browser's GL
 * layer, and a few hundred is where a phone starts to care. Triangles matter
 * on desktop, where fill and vertex work dominate instead.
 */
const CEILING: Record<string, { draws: number; tris: number }> = {
  keel: { draws: 8, tris: 60_000 },
  streets: { draws: 6, tris: 120_000 },
  buildings: { draws: 12, tris: 600_000 },
  props: { draws: 40, tris: 1_200_000 },
  interiors: { draws: 40, tris: 90_000 },
  crowd: { draws: 8, tris: 400_000 },
  traffic: { draws: 12, tris: 120_000 },
  activities: { draws: 14, tris: 120_000 },
  weather: { draws: 10, tris: 90_000 },
  vehicles: { draws: 20, tris: 60_000 },
};

/** What the whole world may cost before anything is culled. */
const TOTAL = {
  high: { draws: 150, tris: 2_600_000 },
  low: { draws: 120, tris: 1_100_000 },
};

describe("what the world costs", () => {
  for (const quality of ["high", "low"] as const) {
    describe(quality, () => {
      const built = buildAll(quality);

      it("keeps every system inside its own ceiling", () => {
        const over: string[] = [];
        for (const s of built) {
          const cap = CEILING[s.name];
          if (!cap) {
            over.push(`${s.name} has no budget — add one`);
            continue;
          }
          if (s.draws > cap.draws) over.push(`${s.name} draws ${s.draws} > ${cap.draws}`);
          if (s.tris > cap.tris) {
            over.push(`${s.name} tris ${(s.tris / 1000).toFixed(0)}k > ${(cap.tris / 1000).toFixed(0)}k`);
          }
        }
        expect(over).toEqual([]);
      });

      it("keeps the whole world inside the frame budget", () => {
        const draws = built.reduce((a, s) => a + s.draws, 0);
        const tris = built.reduce((a, s) => a + s.tris, 0);
        const cap = TOTAL[quality];
        const line = built
          .slice()
          .sort((a, b) => b.tris - a.tris)
          .map((s) => `${s.name} ${s.draws}d/${(s.tris / 1000).toFixed(0)}k`)
          .join("  ");
        expect(draws, `draws: ${line}`).toBeLessThanOrEqual(cap.draws);
        expect(tris, `tris: ${line}`).toBeLessThanOrEqual(cap.tris);
      });
    });
  }

  it("makes the low tier meaningfully cheaper than the high one", () => {
    /* The tiers must actually differ. A "low" setting that builds the same
       geometry is worse than no setting at all: it costs the same and tells
       everybody the phone case is handled. */
    const hi = buildAll("high").reduce((a, s) => a + s.tris, 0);
    const lo = buildAll("low").reduce((a, s) => a + s.tris, 0);
    expect(lo).toBeLessThan(hi * 0.7);
  });
});
