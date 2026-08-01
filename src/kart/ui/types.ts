/**
 * Vibe Kart — local contracts for the presentation layer.
 *
 * `types.ts` at the root of `src/kart` is shared law and this module does not
 * get to edit it, so the two things the UI needs that are not in the contract
 * live here instead:
 *
 *   · `KartUiService` — published on `ctx.services.ui`. The race system checks
 *     for it (`play/race.ts`) and stands down from handling the pause button
 *     the moment it exists, so publishing this is what makes the pause *menu*
 *     rather than a bare freeze. It also carries `tick`, which is how React
 *     gets a callback from *inside* the engine loop — see below.
 *
 *   · `KartMinimapService` — `MinimapService` plus the handful of baked extras
 *     the HUD wants (the projection in raw coordinates, a heading transform,
 *     the start/finish marker, the road width in map units).
 *
 * Why `tick` exists. Edge-triggered input (`pausePressed`) is cleared by the
 * engine at the end of every frame, and a `requestAnimationFrame` callback
 * registered by React always runs *after* the engine's — so React can never see
 * an edge. Worse, the screenshot harness calls `engine.step()` by hand with rAF
 * stopped, so a rAF-driven HUD freezes on a still frame. Both problems go away
 * if the HUD is pumped from a system's `lateUpdate`, which is what the minimap
 * system does. The React layer keeps a rAF fallback for the case where the
 * minimap system failed to boot.
 */
import type * as THREE from "three";
import type { MinimapService } from "../types";

/** Which of the five screens is in front of the player. */
export type UiScreen = "loading" | "title" | "select" | "race" | "paused" | "results";

export interface KartUiService {
  readonly screen: UiScreen;
  setScreen(screen: UiScreen): void;
  /**
   * Pumped once per frame from inside the engine's `lateUpdate`, before the
   * input edges are cleared. Must never throw — the caller catches, but a HUD
   * that throws every frame is a HUD nobody can debug.
   */
  tick(dt: number): void;
}

export interface KartMinimapService extends MinimapService {
  /** Projection in raw world coordinates, for anything that has no Vector3. */
  project(x: number, z: number): { x: number; y: number };
  /**
   * Map-space heading of a world direction, radians, 0 = up the widget and
   * positive clockwise — i.e. straight into an SVG `rotate()`.
   */
  heading(forward: THREE.Vector3): number;
  /** Width of the road in map units, so the HUD can stroke the ribbon to scale. */
  roadWidth: number;
  /** The start/finish line as a segment in map space. */
  startLine: { x1: number; y1: number; x2: number; y2: number };
  /** Centreline samples in map space, x,y interleaved. Same curve as `path`. */
  points: Float32Array;
  /** False when there was no track to bake and the projection is a guess. */
  baked: boolean;
}
