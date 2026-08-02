/**
 * Vibe Kart — the land the circuit sits on.
 *
 * ONE height function, used by both the terrain mesh and the off-road physics
 * query. That is the whole design rule here: if the mesh were built from a
 * heightmap and `surfaceAt` estimated something else, karts would float or sink
 * on the grass and nobody would ever find out why. Everything below is a pure
 * function of world XZ, evaluated ~50 000 times at boot to lay the mesh and a
 * few times a frame afterwards.
 *
 * The land is assembled in layers:
 *   · an island — rolling coastal turf inside a soft shoreline, sea outside,
 *   · a bay bitten out of it under the anti-gravity cliff,
 *   · the bluff itself, a pair of domes the tunnel bores through,
 *   · the quarry chasm the Bluff Jump flies over, and Gull Creek's gully,
 *   · and finally the road corridor, which pulls the ground up to meet the
 *     ribbon everywhere the ribbon is actually sitting on the ground.
 *
 * That last layer is why there is never a seam: within ~55 m of the centreline
 * the terrain simply *is* the road elevation minus a fixed drop, so the apron
 * skirt that hangs off the tarmac always has something to land on.
 */
import * as THREE from "three";
import { SEGMENTS } from "./layout";
import type { TrackCurve } from "./spline";
import { clamp01, fbm2, lerp, segmentDistance, smoothstep } from "./util";

/** World Y of the waterline. The paddock straight sits 8 m above it. */
export const SEA_LEVEL = -8;

/** Terrain within this lateral distance is fully graded to the road. */
const CORRIDOR_INNER = 52;
/** ...and fully wild beyond this. */
const CORRIDOR_OUTER = 155;
/** How far the graded shoulder sits below the centreline. */
const CORRIDOR_DROP = 2.4;

export interface GroundAnchors {
  centre: THREE.Vector2;
  bay: { x: number; z: number; radius: number };
  bluffs: Array<{ x: number; z: number; radius: number; height: number }>;
  chasm: { x: number; z: number; radius: number; floor: number };
  creek: { ax: number; az: number; bx: number; bz: number; floor: number };
}

export interface GroundField {
  readonly anchors: GroundAnchors;
  /**
   * Install the road's own shelf height, `(s, lateral) => world Y`. Until this
   * is called the corridor grades to the bare centreline, which is wrong by up
   * to six metres under the banking of the Quarry Bowl — the surface module
   * owns the cross-section, so it hands the function back once it exists.
   */
  setShelf(fn: (s: number, lateral: number) => number): void;
  /** Terrain height at a world XZ. */
  height(x: number, z: number): number;
  /** Terrain normal, by finite difference of `height`. */
  normal(x: number, z: number, out: THREE.Vector3): THREE.Vector3;
  /** Wilderness only, ignoring the road corridor — used by the cliff meshes. */
  wild(x: number, z: number): number;
  /** How strongly the road pulls the ground at this arc position, 0..1. */
  gradeAt(s: number): number;
}

export function buildGround(curve: TrackCurve): GroundField {
  const count = curve.count;

  // --- where the landforms go, read off the course itself ------------------
  const p = new THREE.Vector3();
  const f = new THREE.Vector3();
  const r = new THREE.Vector3();
  const u = new THREE.Vector3();
  const flat = new THREE.Vector3();

  const midOf = (id: string) => {
    const span = curve.spanOf(id);
    const s = (span.start + span.end) * 0.5;
    curve.sample(s, p, f, r, u);
    curve.flatRightAt(s, flat);
    return { x: p.x, y: p.y, z: p.z, rx: flat.x, rz: flat.z };
  };

  let cx = 0;
  let cz = 0;
  for (let i = 0; i < count; i++) {
    cx += curve.pos[i * 3];
    cz += curve.pos[i * 3 + 2];
  }
  cx /= count;
  cz /= count;

  const ag = midOf("antigrav");
  const tun = midOf("tunnel");
  const gap = midOf("gap");
  const br = midOf("bridge");

  const anchors: GroundAnchors = {
    centre: new THREE.Vector2(cx, cz),
    // The bay bites in from the seaward (left) side of the plating.
    bay: { x: ag.x - ag.rx * 250, z: ag.z - ag.rz * 250, radius: 330 },
    bluffs: [
      // The mass the tunnel is bored through.
      { x: tun.x + tun.rx * 25, z: tun.z + tun.rz * 25, radius: 185, height: tun.y + 33 },
      // The headland the plating is bolted to. Pushed well inland on purpose:
      // a heightfield cannot be vertical, so the ground has to be *away* from
      // the plating and the gap is filled by the rock slab in structures.ts.
      { x: ag.x + ag.rx * 128, z: ag.z + ag.rz * 128, radius: 132, height: ag.y + 20 },
    ],
    chasm: { x: gap.x, z: gap.z, radius: 58, floor: gap.y - 32 },
    creek: {
      ax: br.x - br.rx * 460,
      az: br.z - br.rz * 460,
      bx: br.x + br.rx * 300,
      bz: br.z + br.rz * 300,
      floor: br.y - 14.5,
    },
  };

  // --- how hard the road grades the land, per station ----------------------
  // A bridge deck, a viaduct and a tunnel bore must not drag the ground with
  // them; the mask is smoothed over ~26 m so the transition into a gully looks
  // like a bank rather than a step.
  const grade = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const g = SEGMENTS[curve.segOf[i]];
    grade[i] = g.elevated || g.tunnel || g.road === "antigrav" ? 0 : 1;
  }
  const smoothed = new Float32Array(count);
  const R = Math.max(1, Math.round(26 / curve.ds));
  for (let i = 0; i < count; i++) {
    let acc = 0;
    let wsum = 0;
    for (let k = -R; k <= R; k++) {
      const w = 1 - Math.abs(k) / (R + 1);
      acc += grade[(i + k + count * 2) % count] * w;
      wsum += w;
    }
    // min() with the raw mask: smoothing may only *widen* the ungraded span,
    // never let the ground creep back up into the middle of a bridge.
    smoothed[i] = Math.min(grade[i], acc / wsum);
  }

  const gradeAt = (s: number): number => {
    const idx = curve.indexAt(s);
    const i0 = Math.floor(idx) % count;
    const i1 = (i0 + 1) % count;
    const w = idx - Math.floor(idx);
    return smoothed[i0] + (smoothed[i1] - smoothed[i0]) * w;
  };

  // --- the wilderness ------------------------------------------------------
  const bay = anchors.bay;
  const chasm = anchors.chasm;
  const creek = anchors.creek;

  function wild(x: number, z: number): number {
    const dx = x - cx;
    const dz = z - cz;
    const rad = Math.sqrt(dx * dx + dz * dz);

    // Rolling turf: one big form for the shape of the headland, one small one
    // for the lumps you actually see when you spin off into it.
    const macro = fbm2(x * 0.0032, z * 0.0032, 4, 11);
    const meso = fbm2(x * 0.0115, z * 0.0115, 3, 29);
    let land = 2 + macro * 34 + meso * 9;

    // The bluffs. `max` rather than `+`, so two overlapping domes make one
    // ridge instead of a suspiciously tall cone.
    for (const b of anchors.bluffs) {
      const d = Math.hypot(x - b.x, z - b.z) / b.radius;
      if (d < 1) {
        const k = 1 - d * d;
        // A dome multiplied by a smooth mask is a scoop of ice cream. The
        // ridged term is what turns it into a headland with shoulders and
        // gullies — and it is what pushes the slopes past the threshold where
        // the terrain shades itself as rock rather than turf.
        const ridge = Math.abs(fbm2(x * 0.0072, z * 0.0072, 3, 53) * 2 - 1);
        land = Math.max(land, b.height * k * k * (0.5 + macro * 0.45 + ridge * 0.42));
      }
    }

    // Shoreline, and the bay carved out of it under the plating.
    const island = smoothstep(640, 430, rad);
    const bayMask = smoothstep(bay.radius, bay.radius - 130, Math.hypot(x - bay.x, z - bay.z));
    const mask = clamp01(island * (1 - bayMask));
    const floor = SEA_LEVEL - 10 - fbm2(x * 0.006, z * 0.006, 2, 77) * 16;
    let h = lerp(floor, Math.max(land, SEA_LEVEL + 0.5), mask);

    // The quarry chasm the jump flies over — steep walls, flat rubble floor.
    const dCh = Math.hypot(x - chasm.x, z - chasm.z) / chasm.radius;
    if (dCh < 1.35) {
      const k = 1 - smoothstep(0.62, 1.15, dCh);
      h = lerp(h, chasm.floor + fbm2(x * 0.05, z * 0.05, 2, 5) * 3.5, k);
    }

    // Gull Creek's gully. A carve along a line rather than a disc, because a
    // creek is a line and a round hole reads as a crater.
    const seg = segmentDistance(x, z, creek.ax, creek.az, creek.bx, creek.bz);
    const gully = 1 - smoothstep(16, 62, seg.d);
    if (gully > 0) {
      const drift = (fbm2(x * 0.02, z * 0.02, 2, 41) - 0.5) * 6;
      h = lerp(h, creek.floor + drift + seg.d * 0.16, gully);
    }

    return h;
  }

  const _probe = new THREE.Vector3();
  let shelfFn: ((s: number, lateral: number) => number) | null = null;

  function height(x: number, z: number): number {
    const w = wild(x, z);
    // Project twice where it matters. The first pass has to guess a height and
    // the only guess available is the wilderness, which under a banked corner
    // can be ten metres out — enough to snap to the wrong station and grade the
    // ground straight up through the tarmac. The second pass is hinted, so it
    // costs almost nothing.
    const first = curve.project(_probe.set(x, w, z));
    // Always twice, never conditionally: a threshold here makes the height
    // field *discontinuous*, and a discontinuous height field terraces the
    // hillside into staircases you can see from the far side of the bay.
    const pr = curve.project(_probe.set(x, first.centreY, z), first.t);
    const lat = Math.abs(pr.lateral);
    let k = 1 - smoothstep(CORRIDOR_INNER, CORRIDOR_OUTER, lat);
    k *= gradeAt(pr.s);
    if (k <= 0.001) return w;
    let shelf: number;
    if (shelfFn) {
      shelf = shelfFn(pr.s, pr.lateral);
    } else {
      const idx = curve.indexAt(pr.s);
      const i0 = Math.floor(idx) % count;
      const i1 = (i0 + 1) % count;
      const fw = idx - Math.floor(idx);
      shelf = curve.pos[i0 * 3 + 1] * (1 - fw) + curve.pos[i1 * 3 + 1] * fw - CORRIDOR_DROP;
    }
    // Beyond the apron the graded shelf falls away gently, so the road never
    // sits on a table with vertical sides.
    shelf -= Math.max(0, lat - 30) * 0.09;
    return lerp(w, Math.max(shelf, SEA_LEVEL - 1), k);
  }

  return {
    anchors,
    height,
    wild,
    gradeAt,
    setShelf(fn) {
      shelfFn = fn;
    },
    normal(x, z, out) {
      const e = 1.6;
      const h0 = height(x, z);
      const hx = height(x + e, z);
      const hz = height(x, z + e);
      return out.set(-(hx - h0) / e, 1, -(hz - h0) / e).normalize();
    },
  };
}
