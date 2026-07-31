/**
 * Vibe Kart — the ribbon: tarmac, kerbs, aprons, paint, boost panels.
 *
 * Everything here is a strip: a list of arc positions (`rings`) crossed with a
 * list of lateral offsets, evaluated through `surface.profile` so the geometry
 * is the same surface the physics probes. The rings are shared by every strip
 * in the module — road, kerb, quarter-pipe lip, apron, walls — which is what
 * makes the pieces butt together instead of merely nearly meeting.
 *
 * Ring spacing is curvature-adaptive: 2.2 m down the paddock straight, 0.9 m
 * round the 28 m hairpin, and always a ring exactly on every section boundary
 * so the change from tarmac to bridge planks happens on one edge loop.
 *
 * Draw-call discipline: one geometry per material, built by concatenating every
 * run of that material around the lap. The whole ribbon is about a dozen draws.
 *
 * UVs are in *metres*, divided by the material's tile size, so `v` is distance
 * along the track and a texture repeat is distance-correct whether the road is
 * 19 m wide at the start line or 11 m over the bridge. Nothing here relies on
 * texture `repeat`, which means the shared, animated library materials (boost
 * panels, anti-gravity plating) can be used directly.
 */
import * as THREE from "three";
import type { KartQuality } from "../types";
import { SEGMENTS, apronSurface } from "./layout";
import type { TrackCurve } from "./spline";
import { APRON_WIDTH, APRON_DROP, KERB_WIDTH, makeCross, type Cross, type TrackSurface } from "./surface";
import { MeshBuilder, clamp, lerp, smoothstep, type MaterialResolver } from "./util";

export interface RingSet {
  /** Arc positions, in order, wrapping at `curve.length`. */
  s: Float64Array;
  count: number;
}

export interface RibbonBuild {
  root: THREE.Object3D;
  geometries: THREE.BufferGeometry[];
  rings: RingSet;
}

/** Base ring spacing per quality tier, metres. */
const RING_STEP: Record<KartQuality, number> = { low: 4.5, medium: 3.2, high: 2.2, ultra: 1.8 };

/** Columns across the tarmac, per quality tier. */
const ROAD_COLS: Record<KartQuality, number> = { low: 4, medium: 6, high: 8, ultra: 10 };

export function buildRings(curve: TrackCurve, quality: KartQuality): RingSet {
  const base = RING_STEP[quality] ?? 2.2;
  const bounds = Array.from(curve.segStart).slice(0, SEGMENTS.length).sort((a, b) => a - b);
  const out: number[] = [];
  let s = 0;
  let guard = 0;
  while (s < curve.length && guard++ < 20000) {
    out.push(s);
    const i = Math.floor(curve.indexAt(s)) % curve.count;
    // A 28 m radius corner is κ ≈ 0.036; the divisor pulls the step to ~0.9 m
    // there and leaves the straights alone.
    const step = clamp(base / (1 + Math.abs(curve.curvature[i]) * 42), base * 0.4, base);
    let next = s + step;
    for (const b of bounds) {
      if (b > s + 1e-4 && b < next) {
        next = b;
        break;
      }
    }
    s = Math.max(next, s + 0.25);
  }
  return { s: Float64Array.from(out), count: out.length };
}

/** Maximal circular runs of equal key over the ring list. */
function runs(count: number, key: (i: number) => string): Array<{ start: number; len: number; key: string }> {
  const keys: string[] = [];
  for (let i = 0; i < count; i++) keys.push(key(i));
  // Rotate so index 0 begins a run, otherwise a run that spans the start/finish
  // line would be emitted as two pieces with a visible seam.
  let origin = 0;
  for (let i = 0; i < count; i++) {
    if (keys[i] !== keys[(i - 1 + count) % count]) {
      origin = i;
      break;
    }
  }
  const out: Array<{ start: number; len: number; key: string }> = [];
  let i = 0;
  while (i < count) {
    const a = (origin + i) % count;
    const k = keys[a];
    let len = 1;
    while (i + len < count && keys[(origin + i + len) % count] === k) len++;
    out.push({ start: a, len, key: k });
    i += len;
  }
  return out;
}

interface Ring {
  pos: THREE.Vector3;
  fwd: THREE.Vector3;
  rgt: THREE.Vector3;
  up: THREE.Vector3;
  cross: Cross;
  s: number;
}

export function buildRibbon(
  curve: TrackCurve,
  surface: TrackSurface,
  mats: MaterialResolver,
  quality: KartQuality,
  rings: RingSet,
): RibbonBuild {
  const root = new THREE.Group();
  root.name = "track/ribbon";
  const geometries: THREE.BufferGeometry[] = [];
  const N = rings.count;

  const ring: Ring = {
    pos: new THREE.Vector3(),
    fwd: new THREE.Vector3(),
    rgt: new THREE.Vector3(),
    up: new THREE.Vector3(),
    cross: makeCross(),
    s: 0,
  };
  const probeCross = makeCross();

  const loadRing = (i: number): Ring => {
    const s = rings.s[i % N];
    curve.sample(s, ring.pos, ring.fwd, ring.rgt, ring.up);
    surface.crossAt(s, ring.cross);
    ring.s = s;
    return ring;
  };

  /** Arc distance from ring i-1 to ring i, unwrapped across the lap seam. */
  const ringStep = (i: number): number => {
    const a = rings.s[(i - 1 + N) % N];
    const b = rings.s[i % N];
    const d = b - a;
    return d > 0 ? d : d + curve.length;
  };

  const p = new THREE.Vector3();
  const n = new THREE.Vector3();

  /**
   * Emit one strip. `lat(r, col)` gives the lateral offset, `uv` maps to
   * texture space (with `v` running as accumulated metres along the run, so it
   * stays continuous across the start/finish seam), and `lift` pushes the
   * surface along its own normal for inset paint and panels.
   */
  function strip(
    mb: MeshBuilder,
    from: number,
    len: number,
    cols: number,
    lat: (r: Ring, c: number) => number,
    uv: (lateral: number, v: number, col: number) => [number, number],
    lift = 0,
  ): void {
    const base = mb.vertexCount;
    // Which way the columns run decides the winding. Rather than make every
    // call site remember (and get the left-hand kerb wrong, which is exactly
    // what happened), ask the lateral function.
    const probe = loadRing(from);
    const flip = lat(probe, cols - 1) > lat(probe, 0);
    let v = rings.s[from];
    for (let k = 0; k <= len; k++) {
      if (k > 0) v += ringStep(from + k);
      const r = loadRing(from + k);
      for (let c = 0; c < cols; c++) {
        const l = lat(r, c);
        const h = surface.profile(r.cross, l);
        const slope = surface.profileSlope(r.cross, l);
        n.copy(r.up).addScaledVector(r.rgt, -slope).normalize();
        p.copy(r.pos).addScaledVector(r.rgt, l).addScaledVector(r.up, h).addScaledVector(n, lift);
        const [tu, tv] = uv(l, v, c);
        mb.vertex(p.x, p.y, p.z, n.x, n.y, n.z, tu, tv);
      }
    }
    mb.grid(base, len + 1, cols, false, flip);
  }

  // ---------------------------------------------------------------------
  // Tarmac, planks, plating — one mesh per road kind
  // ---------------------------------------------------------------------
  const roadCols = ROAD_COLS[quality] ?? 8;
  const ROAD_MAT: Record<string, string> = {
    road: "asphalt",
    wood: "wood",
    metal: "metal",
    antigrav: "antigrav",
  };
  const roadBuilders = new Map<string, MeshBuilder>();

  for (const run of runs(N, (i) => SEGMENTS[curve.segOf[Math.floor(curve.indexAt(rings.s[i])) % curve.count]].road)) {
    if (run.key === "gap") continue;
    const matName = ROAD_MAT[run.key] ?? "asphalt";
    let mb = roadBuilders.get(matName);
    if (!mb) roadBuilders.set(matName, (mb = new MeshBuilder()));
    const tile = mats.tile(matName);
    strip(
      mb,
      run.start,
      run.len,
      roadCols + 1,
      (r, c) => {
        // Tarmac stops where the kerb starts; the kerb is its own strip.
        const l0 = -(r.cross.halfWidth - (r.cross.kerbL > 0.5 ? KERB_WIDTH : 0));
        const l1 = r.cross.halfWidth - (r.cross.kerbR > 0.5 ? KERB_WIDTH : 0);
        return lerp(l0, l1, c / roadCols);
      },
      (l, v) => [l / tile, v / tile],
    );
  }
  for (const [name, mb] of roadBuilders) {
    const g = mb.toGeometry(`track/road/${name}`);
    geometries.push(g);
    const mesh = new THREE.Mesh(g, mats.get(name));
    mesh.name = `track/road/${name}`;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    root.add(mesh);
  }

  // ---------------------------------------------------------------------
  // Kerbs
  // ---------------------------------------------------------------------
  {
    const mb = new MeshBuilder();
    const tile = mats.tile("kerb");
    for (const side of [0, 1] as const) {
      for (const run of runs(N, (i) => {
        const c = surface.crossAt(rings.s[i], probeCross);
        return (side === 0 ? c.kerbL : c.kerbR) > 0.5 ? "on" : "off";
      })) {
        if (run.key !== "on") continue;
        strip(
          mb,
          run.start,
          run.len,
          4,
          (r, c) => {
            const hw = r.cross.halfWidth;
            const inner = hw - KERB_WIDTH;
            const l = lerp(inner, hw, c / 3);
            return side === 0 ? -l : l;
          },
          (l, v) => [Math.abs(l) / tile, v / tile],
        );
      }
    }
    if (mb.vertexCount) {
      const g = mb.toGeometry("track/kerb");
      geometries.push(g);
      const mesh = new THREE.Mesh(g, mats.get("kerb"));
      mesh.name = "track/kerb";
      mesh.receiveShadow = true;
      root.add(mesh);
    }
  }

  // ---------------------------------------------------------------------
  // Quarter-pipe lips — the rideable banking in the Quarry Bowl
  // ---------------------------------------------------------------------
  {
    const mb = new MeshBuilder();
    const tile = mats.tile("concrete");
    for (const side of [0, 1] as const) {
      for (const run of runs(N, (i) => {
        const c = surface.crossAt(rings.s[i], probeCross);
        return (side === 0 ? c.lipWL : c.lipWR) > 0.1 ? "on" : "off";
      })) {
        if (run.key !== "on") continue;
        strip(
          mb,
          run.start,
          run.len,
          6,
          (r, c) => {
            const w = side === 0 ? r.cross.lipWL : r.cross.lipWR;
            const l = r.cross.halfWidth + (w * c) / 5;
            return side === 0 ? -l : l;
          },
          // Arc length across the lip would be nicer still; the lip is short
          // enough that the projected width is within a few per cent.
          (l, v) => [Math.abs(l) / tile, v / tile],
        );
      }
    }
    if (mb.vertexCount) {
      const g = mb.toGeometry("track/lip");
      geometries.push(g);
      const mesh = new THREE.Mesh(g, mats.get("concrete"));
      mesh.name = "track/lip";
      mesh.receiveShadow = true;
      root.add(mesh);
    }
  }

  // ---------------------------------------------------------------------
  // Aprons — the drivable, slow shoulder that meets the terrain
  // ---------------------------------------------------------------------
  {
    const cols = quality === "low" ? 3 : 5;
    const builders = new Map<string, MeshBuilder>();
    for (const side of [0, 1] as const) {
      for (const run of runs(N, (i) => {
        const g = SEGMENTS[curve.segOf[Math.floor(curve.indexAt(rings.s[i])) % curve.count]];
        if (g.elevated || g.road === "antigrav" || g.road === "gap") return "none";
        return apronSurface(g.id);
      })) {
        if (run.key === "none") continue;
        let mb = builders.get(run.key);
        if (!mb) builders.set(run.key, (mb = new MeshBuilder()));
        const tile = mats.tile(run.key);
        const base = mb.vertexCount;
        for (let k = 0; k <= run.len; k++) {
          const r = loadRing(run.start + k);
          const drive = side === 0 ? r.cross.driveL : r.cross.driveR;
          const sign = side === 0 ? -1 : 1;
          const edgeH = surface.profile(r.cross, drive * sign);
          for (let c = 0; c < cols; c++) {
            const d = (APRON_WIDTH * c) / (cols - 1);
            const drop = 0.3 + (APRON_DROP - 0.3) * smoothstep(0, APRON_WIDTH, d);
            p.copy(r.pos)
              .addScaledVector(r.rgt, sign * (drive + d))
              .addScaledVector(r.up, edgeH);
            p.y -= drop;
            const kk = smoothstep(0, APRON_WIDTH * 0.7, d);
            n.copy(r.up).lerp(UP, kk).normalize();
            mb.vertex(p.x, p.y, p.z, n.x, n.y, n.z, (sign * (drive + d)) / tile, r.s / tile);
          }
        }
        mb.grid(base, run.len + 1, cols, false, side === 1);
      }
    }
    for (const [name, mb] of builders) {
      const g = mb.toGeometry(`track/apron/${name}`);
      geometries.push(g);
      const mesh = new THREE.Mesh(g, mats.get(name));
      mesh.name = `track/apron/${name}`;
      mesh.receiveShadow = true;
      root.add(mesh);
    }
  }

  // ---------------------------------------------------------------------
  // Paint: edge lines, dashed centre, start/finish checker
  // ---------------------------------------------------------------------
  {
    const mb = new MeshBuilder();
    const tile = mats.tile("roadLine");
    const W = 0.16;
    for (const side of [0, 1] as const) {
      for (const run of runs(N, (i) => {
        const g = SEGMENTS[curve.segOf[Math.floor(curve.indexAt(rings.s[i])) % curve.count]];
        return g.road === "road" ? "on" : "off";
      })) {
        if (run.key !== "on") continue;
        strip(
          mb,
          run.start,
          run.len,
          2,
          (r, c) => {
            const hw = r.cross.halfWidth;
            const kerbW = (side === 0 ? r.cross.kerbL : r.cross.kerbR) > 0.5 ? KERB_WIDTH : 0.15;
            const inner = hw - kerbW - 0.05;
            const l = c === 0 ? inner - W : inner;
            return side === 0 ? -l : l;
          },
          // V runs *across* the paint: that is how the material is baked, and
          // it is what gives the line its thick bevelled edge.
          (_l, v, col) => [v / tile, col],
          0.013,
        );
      }
    }

    // A dashed centre line, but only where the road is straight enough that a
    // real circuit would bother painting one.
    let s = 0;
    while (s < curve.length) {
      const i = Math.floor(curve.indexAt(s)) % curve.count;
      const straight = Math.abs(curve.curvature[i]) < 0.004;
      const g = SEGMENTS[curve.segOf[i]];
      if (straight && g.road === "road") {
        dash(mb, curve, surface, s, Math.min(3.2, curve.length - s), 0, 0.14, tile, true);
        s += 6.4;
      } else {
        s += 3.2;
      }
    }

    if (mb.vertexCount) {
      const g = mb.toGeometry("track/paint");
      geometries.push(g);
      const mesh = new THREE.Mesh(g, mats.get("roadLine"));
      mesh.name = "track/paint";
      mesh.renderOrder = 1;
      mesh.receiveShadow = true;
      root.add(mesh);
    }
  }

  // Start/finish: a proper laid checker spanning the road, leading edge on s=0.
  {
    const mb = new MeshBuilder();
    const LEN = 2.4;
    const STEPS = 3;
    const base = mb.vertexCount;
    const cols = roadCols + 1;
    for (let k = 0; k <= STEPS; k++) {
      const s = (LEN * k) / STEPS;
      curve.sample(s, ring.pos, ring.fwd, ring.rgt, ring.up);
      surface.crossAt(s, ring.cross);
      const hw = ring.cross.halfWidth - KERB_WIDTH;
      for (let c = 0; c < cols; c++) {
        const l = lerp(-hw, hw, c / (cols - 1));
        const h = surface.profile(ring.cross, l);
        const slope = surface.profileSlope(ring.cross, l);
        n.copy(ring.up).addScaledVector(ring.rgt, -slope).normalize();
        p.copy(ring.pos).addScaledVector(ring.rgt, l).addScaledVector(ring.up, h).addScaledVector(n, 0.014);
        // 1 m squares across, two rows of 1.2 m along — the checker material
        // bakes 8 columns and 2 rows into one tile.
        mb.vertex(p.x, p.y, p.z, n.x, n.y, n.z, l / 8, s / LEN);
      }
    }
    mb.grid(base, STEPS + 1, cols, false, true);
    const g = mb.toGeometry("track/startLine");
    geometries.push(g);
    const mesh = new THREE.Mesh(g, mats.get("startLine"));
    mesh.name = "track/startLine";
    mesh.renderOrder = 2;
    mesh.receiveShadow = true;
    root.add(mesh);
  }

  // ---------------------------------------------------------------------
  // Boost panels
  // ---------------------------------------------------------------------
  {
    const mb = new MeshBuilder();
    for (const z of surface.boostZones) {
      const base = mb.vertexCount;
      const STEPS = 4;
      for (let k = 0; k <= STEPS; k++) {
        const s = lerp(z.s0, z.s1, k / STEPS);
        curve.sample(s, ring.pos, ring.fwd, ring.rgt, ring.up);
        surface.crossAt(s, ring.cross);
        for (let c = 0; c < 2; c++) {
          const l = c === 0 ? z.lat0 : z.lat1;
          const h = surface.profile(ring.cross, l);
          const slope = surface.profileSlope(ring.cross, l);
          n.copy(ring.up).addScaledVector(ring.rgt, -slope).normalize();
          p.copy(ring.pos).addScaledVector(ring.rgt, l).addScaledVector(ring.up, h).addScaledVector(n, 0.016);
          // 0..1 in both axes: the chevrons fly along +V, and the library
          // scrolls this material's emissive map for us.
          mb.vertex(p.x, p.y, p.z, n.x, n.y, n.z, c, k / STEPS);
        }
      }
      mb.grid(base, STEPS + 1, 2, false, true);
    }
    if (mb.vertexCount) {
      const g = mb.toGeometry("track/boost");
      geometries.push(g);
      const mesh = new THREE.Mesh(g, mats.get("boostPad"));
      mesh.name = "track/boost";
      mesh.renderOrder = 2;
      root.add(mesh);
    }
  }

  // ---------------------------------------------------------------------
  // The dirt cut through Lantern Hairpin
  // ---------------------------------------------------------------------
  {
    const sc = surface.shortcut;
    const mb = new MeshBuilder();
    const tile = mats.tile("dirt");
    const cols = 4;
    let run = 0;
    for (let i = 0; i < sc.count; i++) {
      const px = sc.pos[i * 3];
      const py = sc.pos[i * 3 + 1];
      const pz = sc.pos[i * 3 + 2];
      const rx = sc.rgt[i * 3];
      const rz = sc.rgt[i * 3 + 2];
      const fx = sc.fwd[i * 3];
      const fy = sc.fwd[i * 3 + 1];
      const fz = sc.fwd[i * 3 + 2];
      const fxz = Math.hypot(fx, fz) || 1e-6;
      const nx = (-fx * fy) / fxz;
      const nz = (-fz * fy) / fxz;
      if (i > 0) {
        run += Math.hypot(px - sc.pos[(i - 1) * 3], py - sc.pos[(i - 1) * 3 + 1], pz - sc.pos[(i - 1) * 3 + 2]);
      }
      for (let c = 0; c < cols; c++) {
        // Feather the edges down so the cut looks worn into the scrub rather
        // than laid on top of it.
        const f = c / (cols - 1);
        const l = lerp(-sc.halfWidth, sc.halfWidth, f);
        const edge = 1 - Math.abs(f * 2 - 1);
        const sink = 0.35 * (1 - smoothstep(0, 0.4, edge));
        mb.vertex(px + rx * l, py - sink, pz + rz * l, nx, fxz, nz, l / tile, run / tile);
      }
    }
    mb.grid(0, sc.count, cols, false, true);
    const g = mb.toGeometry("track/shortcut");
    geometries.push(g);
    const mesh = new THREE.Mesh(g, mats.get("dirt"));
    mesh.name = "track/shortcut";
    mesh.receiveShadow = true;
    root.add(mesh);
  }

  return { root, geometries, rings };
}

const UP = new THREE.Vector3(0, 1, 0);

/** One dash of paint, `len` metres long, centred on lateral `lat`. */
function dash(
  mb: MeshBuilder,
  curve: TrackCurve,
  surface: TrackSurface,
  s0: number,
  len: number,
  lat: number,
  width: number,
  tile: number,
  crossV: boolean,
): void {
  const pos = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const rgt = new THREE.Vector3();
  const up = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const pt = new THREE.Vector3();
  const cross = makeCross();
  const base = mb.vertexCount;
  for (let k = 0; k <= 1; k++) {
    const s = s0 + len * k;
    curve.sample(s, pos, fwd, rgt, up);
    surface.crossAt(s, cross);
    for (let c = 0; c < 2; c++) {
      const l = lat + (c === 0 ? -width * 0.5 : width * 0.5);
      const h = surface.profile(cross, l);
      const slope = surface.profileSlope(cross, l);
      nrm.copy(up).addScaledVector(rgt, -slope).normalize();
      pt.copy(pos).addScaledVector(rgt, l).addScaledVector(up, h).addScaledVector(nrm, 0.013);
      mb.vertex(pt.x, pt.y, pt.z, nrm.x, nrm.y, nrm.z, crossV ? s / tile : l / tile, c);
    }
  }
  mb.grid(base, 2, 2, false, true);
}
