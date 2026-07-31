import * as THREE from "three";
import { describe, it, expect } from "vitest";

/**
 * A headless race. The track, the physics and the AI are booted without a
 * renderer and stepped at the fixed rate for two and a half minutes, and the
 * result is checked for the two failure modes that are invisible in a still
 * screenshot and obvious in motion: rivals that cannot make the jump, and
 * rivals that never drift.
 */
import { makeKartInput, makeRng, FIXED_DT, type KartCtx, type System } from "../types";
import createTrack from "../track";
import createPhysics from "../physics";
import createAi from "./index";
import type { KartAiService } from "./index";

function makeCtx(quality: "low" | "high"): KartCtx {
  const listeners = new Map<string, Set<(p: never) => void>>();
  return {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    renderer: {} as THREE.WebGLRenderer,
    services: {},
    input: makeKartInput(),
    elapsed: 0,
    dt: 0,
    quality,
    rng: makeRng(1),
    viewport: { width: 1280, height: 720, aspect: 16 / 9, dpr: 1 },
    emit: (e, p) => { const s = listeners.get(e as string); if (s) for (const f of s) (f as (x: unknown) => void)(p); },
    on: (e, f) => { let s = listeners.get(e as string); if (!s) listeners.set(e as string, (s = new Set())); s.add(f); return () => s!.delete(f); },
  };
}

for (const q of ["high"] as const) {
  describe(`ai smoke ${q}`, () => {
    it("races clean", () => {
      const ctx = makeCtx(q);
      const systems: System[] = [createTrack(ctx) as System, createPhysics(ctx) as System];
      const t0 = Date.now();
      systems.push(createAi(ctx) as System);
      const bake = Date.now() - t0;
      const ai = ctx.services.ai as KartAiService;
      const phys = ctx.services.physics as import("../physics").KartPhysicsService;
      let resp = 0;
      let turbo = 0;
      ctx.on("race:respawn", (() => { resp++; }) as never);
      ctx.on("kart:miniTurbo", (() => { turbo++; }) as never);
      let drift = 0;
      let off = 0;
      const travelled = new Map<number, number>();
      const steps = Math.round(150 / FIXED_DT);
      for (let n = 0; n < steps; n++) {
        ctx.elapsed += FIXED_DT;
        for (const s of systems) s.fixedUpdate?.(FIXED_DT, ctx);
        for (const r of phys.racers) {
          if (r.isPlayer) continue;
          if (r.drifting) drift += FIXED_DT;
          if (r.grounded && (r.surface === "grass" || r.surface === "dirt")) off += FIXED_DT;
          travelled.set(r.id, (travelled.get(r.id) ?? 0) + Math.abs(r.speed) * FIXED_DT);
        }
      }
      // The race system is not booted here, so lap counting is done the honest
      // way: metres covered against the length of the course.
      const track = ctx.services.track as import("../types").TrackService;
      let minLaps = Infinity;
      for (const r of phys.racers) {
        if (r.isPlayer) continue;
        minLaps = Math.min(minLaps, (travelled.get(r.id) ?? 0) / track.length);
      }
      console.log(`${q}: bake ${bake}ms  stations ${ai.line?.count}  drift ${(drift / 7).toFixed(1)}s/kart  mt ${turbo}  offroad ${(off / 7).toFixed(2)}s  respawns ${resp}  laps ${minLaps.toFixed(2)}`);
      // Deliberately generous. This is a smoke test for "the field can drive
      // this course", not a lap-time lock: the numbers should only go red when
      // something is genuinely broken — the rivals cannot clear the Bluff Jump,
      // or they are living in the scenery, or nobody is drifting at all.
      expect(resp).toBeLessThan(8);
      expect(turbo).toBeGreaterThan(0);
      expect(off / 7).toBeLessThan(8);
      expect(minLaps).toBeGreaterThan(1);
    }, 120000);
  });
}
