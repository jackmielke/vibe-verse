/**
 * Vibe Kart — the minimap bake, and the UI's bridge into the engine loop.
 *
 * Two jobs, both of them cheap:
 *
 * **1. Project the world onto a 200-pixel square.** The transform is a
 * rotation, a uniform scale and an offset — nothing else. Uniform matters: a
 * map that stretches each axis independently turns a circuit's hairpin into a
 * chicane and the player stops trusting it. The rotation is *searched* at boot:
 * the course is fitted at 24 angles and the one whose axis-aligned bounding box
 * is squarest wins, which is worth ~20% more map on screen than the naïve
 * north-up fit, for one loop of trigonometry at load time.
 *
 * The centreline is baked once into an SVG path in the same [0,1]² space the
 * projection returns, so the HUD draws the track with `<path d={path}/>` and
 * places the dots with `toMinimap()` and the two are guaranteed to agree. The
 * path is deliberately *not* smoothed into béziers: at 256 samples a polyline
 * is already sub-pixel at HUD size, and a polyline cannot overshoot the way a
 * Catmull-Rom conversion does on a hairpin.
 *
 * **2. Pump the React HUD.** See `ui/types.ts` for why the HUD cannot use
 * `requestAnimationFrame`: the short version is that input edges are cleared
 * before rAF callbacks run, and the screenshot harness stops rAF entirely. This
 * system boots last, so its `lateUpdate` is the last thing to run in a frame —
 * exactly where a HUD wants to sample.
 *
 * With no track service this still publishes a working `minimap`: a unit circle
 * and a metres-to-map guess. A missing track is somebody else's failure and the
 * HUD should still draw something rather than crash the page.
 */
import * as THREE from "three";
import type { KartCtx, System, TrackService } from "../types";
import type { KartMinimapService, KartUiService } from "./types";

/** Centreline samples. Enough that the polyline is sub-pixel at HUD size. */
const SAMPLES: Record<string, number> = { low: 128, medium: 192, high: 256, ultra: 320 };

/** Rotation candidates tested for the squarest fit. 24 × 7.5° covers the circle. */
const FIT_STEPS = 24;

/** Fraction of the widget left empty around the course, so dots never clip out. */
const MARGIN = 0.055;

export default function createMinimap(ctx: KartCtx): System {
  const track = ctx.services.track as TrackService | undefined;
  const count = SAMPLES[ctx.quality] ?? 256;

  const bake = track ? bakeTrack(track, count) : bakeFallback();

  const _v = new THREE.Vector3();

  const service: KartMinimapService = {
    path: bake.path,
    roadWidth: bake.roadWidth,
    startLine: bake.startLine,
    points: bake.points,
    baked: bake.baked,

    toMinimap(position) {
      return service.project(position.x, position.z);
    },

    project(x, z) {
      const dx = x - bake.cx;
      const dz = z - bake.cz;
      return {
        x: 0.5 + (dx * bake.cos - dz * bake.sin) * bake.scale,
        y: 0.5 + (dx * bake.sin + dz * bake.cos) * bake.scale,
      };
    },

    heading(forward) {
      _v.copy(forward);
      const rx = _v.x * bake.cos - _v.z * bake.sin;
      const ry = _v.x * bake.sin + _v.z * bake.cos;
      // Map +Y runs down the widget, so "up" is -Y: atan2(x, -y) puts 0 at the
      // top and turns clockwise, which is what an SVG rotate() wants.
      return Math.atan2(rx, -ry);
    },
  };

  ctx.services.minimap = service;

  // -- the UI bridge ---------------------------------------------------------
  // One warning, then silence: a HUD that throws every frame drowns the console
  // and takes the useful errors with it.
  let uiFailed = false;

  return {
    lateUpdate(dt) {
      const ui = ctx.services.ui as KartUiService | undefined;
      if (!ui || uiFailed || typeof ui.tick !== "function") return;
      try {
        ui.tick(dt);
      } catch (err) {
        uiFailed = true;
        console.error("[Vibe Kart/ui] HUD tick failed; the HUD is now static:", err);
      }
    },

    dispose() {
      if (ctx.services.minimap === service) delete ctx.services.minimap;
    },
  };
}

// ---------------------------------------------------------------------------
// The bake
// ---------------------------------------------------------------------------

interface Bake {
  cx: number;
  cz: number;
  cos: number;
  sin: number;
  scale: number;
  path: string;
  points: Float32Array;
  roadWidth: number;
  startLine: { x1: number; y1: number; x2: number; y2: number };
  baked: boolean;
}

function bakeTrack(track: TrackService, count: number): Bake {
  const xs = new Float64Array(count);
  const zs = new Float64Array(count);
  let halfWidth = 5;

  const frame = track.frameAt(0);
  for (let i = 0; i < count; i++) {
    const f = track.frameAt(i / count, frame);
    xs[i] = f.position.x;
    zs[i] = f.position.z;
    halfWidth = Math.max(halfWidth, f.halfWidth);
  }

  // Centre on the bounding box of the centreline rather than the mean of the
  // samples: an uneven sample density (long straight, tight hairpin) drags a
  // mean off-centre and wastes half the widget.
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (zs[i] < minZ) minZ = zs[i];
    if (zs[i] > maxZ) maxZ = zs[i];
  }
  const cx = (minX + maxX) * 0.5;
  const cz = (minZ + maxZ) * 0.5;

  // Search the rotation that packs the course into the squarest box. The score
  // is the larger of the two extents — minimise it and the uniform scale that
  // fits the widget is maximised.
  let bestAngle = 0;
  let bestExtent = Infinity;
  let bestW = 1;
  let bestH = 1;
  for (let step = 0; step < FIT_STEPS; step++) {
    const a = (step / FIT_STEPS) * Math.PI;
    const c = Math.cos(a);
    const s = Math.sin(a);
    let lo0 = Infinity;
    let hi0 = -Infinity;
    let lo1 = Infinity;
    let hi1 = -Infinity;
    for (let i = 0; i < count; i++) {
      const dx = xs[i] - cx;
      const dz = zs[i] - cz;
      const u = dx * c - dz * s;
      const v = dx * s + dz * c;
      if (u < lo0) lo0 = u;
      if (u > hi0) hi0 = u;
      if (v < lo1) lo1 = v;
      if (v > hi1) hi1 = v;
    }
    const w = hi0 - lo0;
    const h = hi1 - lo1;
    const extent = Math.max(w, h);
    if (extent < bestExtent - 1e-6) {
      bestExtent = extent;
      bestAngle = a;
      bestW = w;
      bestH = h;
    }
  }

  const cos = Math.cos(bestAngle);
  const sin = Math.sin(bestAngle);
  // Pad by the road's own half-width so the ribbon stroke stays inside the
  // widget, then by the margin so a dot on the outside kerb is still drawn.
  const extent = Math.max(bestW, bestH) + halfWidth * 2;
  const scale = (1 - MARGIN * 2) / Math.max(1e-3, extent);

  const points = new Float32Array(count * 2);
  let path = "";
  for (let i = 0; i < count; i++) {
    const dx = xs[i] - cx;
    const dz = zs[i] - cz;
    const x = 0.5 + (dx * cos - dz * sin) * scale;
    const y = 0.5 + (dx * sin + dz * cos) * scale;
    points[i * 2] = x;
    points[i * 2 + 1] = y;
    path += `${i === 0 ? "M" : "L"}${x.toFixed(4)} ${y.toFixed(4)}`;
  }
  path += "Z";

  // The start/finish tick, drawn across the road at t = 0.
  const start = track.frameAt(0, frame);
  const hw = start.halfWidth * scale;
  const rx = start.right.x * cos - start.right.z * sin;
  const ry = start.right.x * sin + start.right.z * cos;
  const len = Math.hypot(rx, ry) || 1;
  const sx = 0.5 + ((start.position.x - cx) * cos - (start.position.z - cz) * sin) * scale;
  const sy = 0.5 + ((start.position.x - cx) * sin + (start.position.z - cz) * cos) * scale;

  return {
    cx,
    cz,
    cos,
    sin,
    scale,
    path,
    points,
    roadWidth: halfWidth * 2 * scale,
    startLine: {
      x1: sx - (rx / len) * hw,
      y1: sy - (ry / len) * hw,
      x2: sx + (rx / len) * hw,
      y2: sy + (ry / len) * hw,
    },
    baked: true,
  };
}

/** No track: a ring, and 400 metres of world across the widget. */
function bakeFallback(): Bake {
  const count = 64;
  const points = new Float32Array(count * 2);
  let path = "";
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const x = 0.5 + Math.cos(a) * 0.4;
    const y = 0.5 + Math.sin(a) * 0.4;
    points[i * 2] = x;
    points[i * 2 + 1] = y;
    path += `${i === 0 ? "M" : "L"}${x.toFixed(4)} ${y.toFixed(4)}`;
  }
  return {
    cx: 0,
    cz: 0,
    cos: 1,
    sin: 0,
    scale: 1 / 400,
    path: `${path}Z`,
    points,
    roadWidth: 0.06,
    startLine: { x1: 0.9, y1: 0.46, x2: 0.9, y2: 0.54 },
    baked: false,
  };
}
