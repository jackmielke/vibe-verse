/**
 * Vegetation.tsx — the trees, and they are specific trees.
 *
 * San Francisco's planting is not generic. The hills and the Presidio are dark
 * with Monterey cypress and blue-grey eucalyptus, both of them wind-sheared
 * flat on the ocean side. Downtown is London plane and ficus in cast-iron tree
 * wells, pollarded into tight balls. Dolores Street has its double row of
 * Canary Island palms, and the Embarcadero got the same treatment in the
 * nineties. Golden Gate Park is Monterey pine over everything. Getting that mix
 * right per district is most of what makes the foliage read as *this* city
 * rather than as "trees".
 *
 * Technically: crossed-quad canopies on a single alpha-tested foliage material,
 * one InstancedMesh per species, a shared trunk pool, a shared billboard pool
 * for everything past the near ring, and a vertex-shader wind that reads
 * `frame.windDirection` / `frame.windSpeed` so the whole canopy layer breathes
 * with the same gust the flags and the bay are using.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { QUALITY } from "../../config";
import { frame, useSfStore } from "../../state/store";
import { getMaterial } from "../../materials";
import { clamp, hashSeed, makeRng, type Rng } from "../../math/rng";
import {
  districtAt,
  isPark,
  isRoad,
  landSDF,
  terrainHeight,
  terrainSlope,
} from "../../geo/sfGeo";
import { MeshSink, addCrossQuads, addCylinder, addPanel, rgb, type RGB } from "./geom";
import {
  ChunkStreamer,
  InstancePool,
  blockFor,
  reportPending,
  type InstanceChunk,
} from "./chunker";
import { SIDEWALK_WIDTH, edgeSpan, roadNetwork, roadSurface, type RoadEdge, type SurfacePoint } from "./roadNetwork";
import { treeWells } from "./streetFurniture";

/* ================================================================== *
 * Species
 * ================================================================== */

export type Species = "cypress" | "eucalyptus" | "plane" | "ficus" | "palm" | "pine";

interface SpeciesDef {
  /** Canopy colour multiplier over the shared foliage albedo. */
  tint: number;
  /** Trunk colour multiplier. */
  bark: number;
  /** Trunk height range, metres. */
  trunkH: [number, number];
  /** Trunk base radius. */
  trunkR: number;
  /** Canopy width / height, metres, at unit scale. */
  crownW: number;
  crownH: number;
  /** How much the canopy sways. Eucalyptus whips; ficus barely moves. */
  sway: number;
}

const SPECIES: Record<Species, SpeciesDef> = {
  // Wind-sheared, almost flat-topped, very dark.
  cypress: { tint: 0x8ea080, bark: 0x8a7a66, trunkH: [3.2, 5.4], trunkR: 0.34, crownW: 9.5, crownH: 5.0, sway: 0.55 },
  // Tall, sparse, pale peeling trunk, blue-grey drooping foliage.
  eucalyptus: { tint: 0xa8bda2, bark: 0xcfc4b0, trunkH: [9, 16], trunkR: 0.30, crownW: 7.5, crownH: 8.5, sway: 1.35 },
  // The street tree: mottled trunk, tight rounded crown from pollarding.
  plane: { tint: 0xc2c88e, bark: 0xa9a292, trunkH: [3.0, 4.6], trunkR: 0.19, crownW: 5.4, crownH: 4.4, sway: 0.85 },
  // Dense, dark, evergreen, low branching.
  ficus: { tint: 0x7d9470, bark: 0x8e857a, trunkH: [2.4, 3.6], trunkR: 0.22, crownW: 6.0, crownH: 4.6, sway: 0.35 },
  palm: { tint: 0xa8b884, bark: 0x9a8b70, trunkH: [7, 13], trunkR: 0.24, crownW: 6.2, crownH: 2.8, sway: 1.1 },
  pine: { tint: 0x8fa07c, bark: 0x7d6a55, trunkH: [6, 11], trunkR: 0.31, crownW: 8.0, crownH: 6.5, sway: 0.7 },
};

const SPECIES_LIST: Species[] = ["cypress", "eucalyptus", "plane", "ficus", "palm", "pine"];

/** Extra pools that are not species canopies. */
type VegPool = Species | "trunk" | "palm-trunk" | "shrub" | "grass" | "ivy" | "billboard";

const VEG_CAPACITY: Record<VegPool, number> = {
  cypress: 700, eucalyptus: 600, plane: 1100, ficus: 800, palm: 320, pine: 700,
  trunk: 2600, "palm-trunk": 320, shrub: 2000, grass: 10000, ivy: 500, billboard: 4000,
};

/* ================================================================== *
 * Canopy geometry
 * ================================================================== *
 * Crossed cards with a few offset satellite clusters. The satellites are what
 * turn "two flat sheets" into a mass with a silhouette: they break the hard
 * X-shape you get from a bare cross-quad and give the canopy something to
 * self-shadow against.
 */

function canopyGeometry(sp: Species): THREE.BufferGeometry {
  const d = SPECIES[sp];
  const s = new MeshSink(1024);
  const c: RGB = rgb(d.tint);
  const rng = makeRng(`canopy:${sp}`);

  if (sp === "palm") {
    // Fronds: long tapering cards radiating from the crown, drooping at the tip.
    const n = 11;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng.range(-0.12, 0.12);
      const droop = rng.range(0.35, 0.85);
      const L = d.crownW * 0.5 * rng.range(0.8, 1.15);
      const cx = Math.cos(a) * L * 0.55;
      const cz = Math.sin(a) * L * 0.55;
      const cy = 0.55 - droop * 0.9;
      addCrossQuads(s, cx, cy, cz, L * 1.1, 1.05, 1, a, c);
    }
    // The crown shaft and the dead frond skirt.
    addCrossQuads(s, 0, 0.2, 0, 1.7, 1.9, 2, 0.3, rgb(0x8e8460));
    return s.finalize()!;
  }

  const planes = sp === "eucalyptus" ? 2 : 3;
  addCrossQuads(s, 0, 0, 0, d.crownW, d.crownH, planes, 0.4, c);

  // Satellites. Cypress spreads sideways and flattens; eucalyptus stacks
  // vertically in loose tufts; the rest cluster around a rounded mass.
  const sats = sp === "eucalyptus" ? 5 : sp === "cypress" ? 6 : 4;
  for (let i = 0; i < sats; i++) {
    const a = rng.next() * Math.PI * 2;
    const spread = sp === "cypress" ? 0.42 : sp === "eucalyptus" ? 0.24 : 0.34;
    const rise = sp === "eucalyptus" ? rng.range(-0.35, 0.42) : rng.range(-0.26, 0.24);
    const r = rng.range(0.25, 1) * d.crownW * spread;
    const sc = rng.range(0.42, 0.68);
    // Slightly varied tint per satellite: a canopy is never one green.
    const v = 0.86 + rng.next() * 0.28;
    const cc: RGB = { r: c.r * v, g: c.g * v, b: c.b * v * 0.98 };
    addCrossQuads(
      s,
      Math.cos(a) * r, rise * d.crownH, Math.sin(a) * r,
      d.crownW * sc, d.crownH * sc * (sp === "cypress" ? 0.72 : 1),
      2, a, cc,
    );
  }
  return s.finalize()!;
}

/** A single crossed card, tinted per instance — the distance LOD. */
function billboardGeometry(): THREE.BufferGeometry {
  const s = new MeshSink(64);
  addCrossQuads(s, 0, 0, 0, 1, 1, 2, 0.3, rgb(0xffffff));
  return s.finalize()!;
}

function trunkGeometry(palm: boolean): THREE.BufferGeometry {
  const s = new MeshSink(512);
  const c = rgb(0xffffff);
  if (palm) {
    // A palm trunk leans and is ringed by old frond scars.
    const N = 7;
    for (let i = 0; i < N; i++) {
      const t = i / N;
      const lean = Math.sin(t * 1.3) * 0.22;
      addCylinder(s, lean, t, 0, 0.13 - t * 0.03, 0.125 - (t + 1 / N) * 0.03, 1 / N + 0.005, 6, c, 0.8, false);
    }
  } else {
    addCylinder(s, 0, 0, 0, 0.16, 0.10, 0.62, 6, c, 1.2, false);
    addCylinder(s, 0, 0.62, 0, 0.10, 0.075, 0.42, 5, c, 1.2, false);
    // One stubby limb so the trunk does not read as a pole. Two looked better
    // and cost a third more triangles across nine thousand trees.
    addCylinder(s, 0.09, 0.72, 0.05, 0.05, 0.03, 0.26, 4, c, 1.0);
    // Root flare.
    addCylinder(s, 0, -0.02, 0, 0.24, 0.17, 0.10, 6, c, 1.0, false);
  }
  return s.finalize()!;
}

function shrubGeometry(): THREE.BufferGeometry {
  const s = new MeshSink(256);
  const rng = makeRng("shrub");
  for (let i = 0; i < 4; i++) {
    const a = rng.next() * Math.PI * 2;
    const r = rng.range(0, 0.32);
    addCrossQuads(
      s, Math.cos(a) * r, rng.range(0.22, 0.5), Math.sin(a) * r,
      rng.range(0.7, 1.2), rng.range(0.55, 0.95), 2, a, rgb(0xb8c49a),
    );
  }
  return s.finalize()!;
}

function grassGeometry(): THREE.BufferGeometry {
  const s = new MeshSink(64);
  addCrossQuads(s, 0, 0.19, 0, 0.62, 0.38, 2, 0.7, rgb(0xc4cc9a));
  return s.finalize()!;
}

function ivyGeometry(): THREE.BufferGeometry {
  const s = new MeshSink(256);
  const rng = makeRng("ivy");
  // A ragged vertical mat that hugs a wall: several overlapping cards on one
  // plane, with the top edge broken up.
  for (let i = 0; i < 6; i++) {
    const y = rng.range(0.3, 2.6);
    addPanel(
      s, rng.range(-0.7, 0.7), y, rng.range(-0.04, 0.04),
      rng.range(1.1, 2.0), rng.range(1.0, 2.2), 0,
      rgb(0x9fb083), [0, 0, 1, 1], true,
    );
  }
  return s.finalize()!;
}

/* ================================================================== *
 * Wind material
 * ================================================================== */

interface WindUniforms {
  uTime: { value: number };
  uWind: { value: THREE.Vector2 };
  uGust: { value: number };
  uSway: { value: number };
}

/**
 * Patch a foliage material with a vertex-shader wind.
 *
 * The motion is two out-of-phase sines plus a fast flutter, phased off the
 * instance's world position so a row of street trees does not move as one
 * object — the single most common tell in a game with animated foliage. The
 * sway weight rises with height inside the canopy so the base of the mass stays
 * anchored to the trunk it is supposed to be growing out of.
 */
function makeWindMaterial(swayScale: number, name: string): {
  material: THREE.MeshStandardMaterial;
  uniforms: WindUniforms;
} {
  const material = getMaterial("foliage", {
    unique: true,
    vertexColors: true,
    repeat: 1,
    detail: false,
    name,
  });
  const uniforms: WindUniforms = {
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector2(1, 0) },
    uGust: { value: 1 },
    uSway: { value: swayScale },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
uniform float uTime;
uniform vec2 uWind;
uniform float uGust;
uniform float uSway;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec3 sfOrigin = instanceMatrix[3].xyz;
#else
  vec3 sfOrigin = vec3(0.0);
#endif
  float sfPhase = sfOrigin.x * 0.117 + sfOrigin.z * 0.091;
  float sfT = uTime * (0.35 + uGust * 0.09);
  float sfWave = sin(sfT * 0.9 + sfPhase) * 0.62 + sin(sfT * 1.73 + sfPhase * 1.7) * 0.26;
  // Weight by height inside the canopy; the geometry is centred on its own
  // origin so a small bias keeps the underside from shearing off the trunk.
  float sfW = clamp(transformed.y * 0.32 + 0.55, 0.0, 1.4);
  float sfAmp = uSway * (0.10 + uGust * 0.028) * sfW;
  transformed.xz += uWind * sfWave * sfAmp;
  // Leaf flutter: high frequency, tiny amplitude, decorrelated per vertex.
  transformed.x += sin(sfT * 4.1 + transformed.y * 3.1 + sfPhase) * sfAmp * 0.16;
  transformed.z += cos(sfT * 3.7 + transformed.x * 2.9 + sfPhase) * sfAmp * 0.16;`,
      );
  };
  material.customProgramCacheKey = () => `sf-wind-${name}`;
  return { material, uniforms };
}

/* ================================================================== *
 * Species selection
 * ================================================================== */

const DOLORES = { x: -1120, z: 1670 };   // Dolores Street's palm rows, roughly
const EMBARCADERO_X = 400;

/**
 * What grows here. Driven by district, elevation and how close the ocean wind
 * gets — which is, near enough, how the real planting decisions were made.
 */
function speciesFor(x: number, z: number, height: number, rng: Rng, street: boolean): Species {
  const d = districtAt(x, z);
  const k = d.key;

  // The palm corridors.
  if (street) {
    const dol = Math.hypot(x - DOLORES.x, z - DOLORES.z);
    if (dol < 700 && rng.chance(0.55)) return "palm";
    if (x > EMBARCADERO_X - 260 && k === "embarcadero" && rng.chance(0.5)) return "palm";
  }

  if (k === "presidio" || k === "richmond" || k === "sunset") {
    const r = rng.next();
    if (street) return r < 0.45 ? "plane" : r < 0.75 ? "cypress" : "ficus";
    return r < 0.42 ? "cypress" : r < 0.76 ? "eucalyptus" : "pine";
  }

  // Anything high and open is hill planting: cypress, eucalyptus, pine.
  if (!street && height > 70) {
    const r = rng.next();
    return r < 0.4 ? "cypress" : r < 0.75 ? "eucalyptus" : "pine";
  }

  if (k === "fidi" || k === "soma" || k === "civiccenter" || k === "rincon" || k === "embarcadero") {
    return rng.chance(0.58) ? "plane" : "ficus";
  }
  if (k === "mission" || k === "castro" || k === "haight" || k === "hayesvalley" || k === "alamo") {
    const r = rng.next();
    return r < 0.42 ? "plane" : r < 0.72 ? "ficus" : r < 0.88 ? "palm" : "eucalyptus";
  }
  if (!street) {
    const r = rng.next();
    return r < 0.34 ? "cypress" : r < 0.62 ? "eucalyptus" : r < 0.84 ? "pine" : "plane";
  }
  return rng.chance(0.6) ? "plane" : "ficus";
}

/* ================================================================== *
 * Placement
 * ================================================================== */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _S1: SurfacePoint = { x: 0, y: 0, z: 0, rx: 0, rz: 0, tx: 0, ty: 0, tz: 0 };
const _wells = new Float32Array(64);
const _edges: RoadEdge[] = [];

function pushTree(
  chunk: InstanceChunk, sp: Species, x: number, y: number, z: number,
  scale: number, yaw: number, rng: Rng, lod: number,
): void {
  const d = SPECIES[sp];
  const trunkH = rng.range(d.trunkH[0], d.trunkH[1]) * scale;
  const lean = rng.range(-0.05, 0.05);

  if (lod > 0) {
    // Distance LOD: one crossed card standing on the ground, species-tinted.
    const h = trunkH + d.crownH * scale * 0.9;
    const w = d.crownW * scale * 0.82;
    _e.set(0, yaw, 0);
    _q.setFromEuler(_e);
    _p.set(x, y + h * 0.5, z);
    _s.set(w, h, w);
    _m.compose(_p, _q, _s);
    const c = rgb(d.tint);
    blockFor(chunk, "billboard").push(_m, c.r, c.g, c.b);
    return;
  }

  // Trunk.
  const palm = sp === "palm";
  _e.set(lean, yaw, lean * 0.7);
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  const tr = d.trunkR * scale * rng.range(0.85, 1.2);
  _s.set(tr / 0.16, palm ? trunkH : trunkH / 1.04, tr / 0.16);
  if (palm) _s.set(tr / 0.13, trunkH, tr / 0.13);
  _m.compose(_p, _q, _s);
  const bark = rgb(d.bark);
  const bv = rng.range(0.86, 1.14);
  blockFor(chunk, palm ? "palm-trunk" : "trunk").push(_m, bark.r * bv, bark.g * bv, bark.b * bv);

  // Canopy, sitting on top of the trunk.
  const cs = scale * rng.range(0.86, 1.18);
  const cy = y + trunkH + SPECIES[sp].crownH * cs * (palm ? 0.1 : 0.34);
  _e.set(0, yaw + rng.range(0, Math.PI), 0);
  _q.setFromEuler(_e);
  _p.set(x + lean * trunkH * 0.5, cy, z);
  _s.set(cs, cs, cs);
  _m.compose(_p, _q, _s);
  // Per-tree colour: the same species varies enormously with age and exposure.
  const v = rng.range(0.82, 1.16);
  blockFor(chunk, sp).push(_m, v, v * rng.range(0.96, 1.04), v * rng.range(0.9, 1.0));
}

/**
 * Bake one vegetation chunk.
 *
 * Three sources, in order of how much they matter to the look of the city:
 * street trees in their wells (which is what you see walking), park and hill
 * scatter (which is what you see flying), and the ground layer of shrubs,
 * grass and wall ivy.
 */
export function buildVegChunk(
  x: number, z: number, size: number, lod: number, foliage: number,
): InstanceChunk {
  const chunk: InstanceChunk = new Map();
  const rng = makeRng(hashSeed(`veg|${x}|${z}|${size}`));

  /* --- street trees --- */
  roadNetwork.ensureRect(x - 300, z - 300, x + size + 300, z + size + 300);
  roadNetwork.edgesInRect(x, z, x + size, z + size, _edges);
  for (const e of _edges) {
    const span = edgeSpan(e);
    if (span.len < 6) continue;
    for (const side of [1, -1] as const) {
      const n = treeWells(e, side, span.s0, span.s1, _wells);
      const lat = e.carriageway + 1.1;
      for (let i = 0; i < n; i++) {
        if (!rng.chance(foliage)) continue;
        const s = _wells[i];
        roadSurface(e, s, side * lat, _S1);
        const kerbY = roadSurface(e, s, side * e.carriageway).y + 0.152;
        const sp = speciesFor(_S1.x, _S1.z, kerbY, rng, true);
        pushTree(chunk, sp, _S1.x, kerbY - 0.05, _S1.z, rng.range(0.8, 1.15), rng.next() * 6.28, rng, lod);
      }
    }
  }

  /* --- park / open-ground scatter --- */
  // A jittered grid: cheap, deterministic, and with enough jitter it is
  // indistinguishable from a Poisson disc at this density.
  const CELL = 13;
  const i0 = Math.floor(x / CELL);
  const i1 = Math.floor((x + size) / CELL);
  const j0 = Math.floor(z / CELL);
  const j1 = Math.floor((z + size) / CELL);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const cr = makeRng((Math.imul(i, 374761393) ^ Math.imul(j, 668265263)) >>> 0);
      const px = i * CELL + cr.range(1, CELL - 1);
      const pz = j * CELL + cr.range(1, CELL - 1);
      if (px < x || px >= x + size || pz < z || pz >= z + size) continue;
      const park = isPark(px, pz);
      const d = districtAt(px, pz);
      const wild = d.key === "presidio" || d.key === "bayview";
      if (!park && !wild) continue;
      if (landSDF(px, pz) < 24) continue;
      const h = terrainHeight(px, pz);
      if (h < 1.5) continue;
      const slope = terrainSlope(px, pz, 8);
      if (slope > 0.72) continue;
      if (isRoad(px, pz)) continue;
      // Density: a park is not uniformly wooded — meadows matter as much as
      // trees, and they are what make Golden Gate Park read as a park.
      const cover = park ? 0.55 : 0.16;
      if (!cr.chance(cover * foliage)) {
        // Ground layer where there is no tree.
        if (park && cr.chance(0.55 * foliage) && lod === 0) {
          _e.set(0, cr.next() * 6.28, 0);
          _q.setFromEuler(_e);
          const gs = cr.range(0.8, 1.6);
          _p.set(px, h, pz);
          _s.set(gs, cr.range(0.7, 1.5), gs);
          _m.compose(_p, _q, _s);
          const gv = cr.range(0.8, 1.2);
          blockFor(chunk, "grass").push(_m, gv, gv * cr.range(0.94, 1.06), gv * 0.94);
        }
        continue;
      }
      if (cr.chance(0.22) && lod === 0) {
        _e.set(0, cr.next() * 6.28, 0);
        _q.setFromEuler(_e);
        const ss = cr.range(0.7, 1.5);
        _p.set(px, h, pz);
        _s.set(ss, ss, ss);
        _m.compose(_p, _q, _s);
        const sv = cr.range(0.8, 1.15);
        blockFor(chunk, "shrub").push(_m, sv, sv, sv * 0.95);
        continue;
      }
      const sp = speciesFor(px, pz, h, cr, false);
      pushTree(chunk, sp, px, h, pz, cr.range(0.8, 1.45), cr.next() * 6.28, cr, lod);
    }
  }

  /* --- ivy on the party walls facing the street --- */
  if (lod === 0) {
    for (const e of _edges) {
      if (e.isAlley) continue;
      const d = e.district;
      if (d.maxHeight > 44) continue;
      const span = edgeSpan(e);
      const r2 = makeRng(e.seed ^ 0x4f21);
      for (let s = span.s0 + r2.range(4, 20); s < span.s1 - 4; s += r2.range(22, 70)) {
        if (!r2.chance(0.5 * foliage)) continue;
        const side: 1 | -1 = r2.chance(0.5) ? 1 : -1;
        const lat = e.halfWidth + SIDEWALK_WIDTH - 0.25;
        roadSurface(e, s, side * lat, _S1);
        const y = roadSurface(e, s, side * e.carriageway).y + 0.152;
        // The panel's local normal is +Z; aim it back down the street.
        const yaw = Math.atan2(-side * e.rx, -side * e.rz);
        _e.set(0, yaw, 0);
        _q.setFromEuler(_e);
        _p.set(_S1.x, y, _S1.z);
        const sc = r2.range(0.8, 1.5);
        _s.set(sc, r2.range(0.9, 1.6), 1);
        _m.compose(_p, _q, _s);
        const iv = r2.range(0.8, 1.15);
        blockFor(chunk, "ivy").push(_m, iv, iv, iv * 0.92);
      }
    }
  }

  return chunk;
}

/* ================================================================== *
 * Component
 * ================================================================== */

interface VegChunkRec {
  key: string;
  x: number;
  z: number;
  size: number;
  data: InstanceChunk;
}

const _cam = new THREE.Vector3();

export default function Vegetation() {
  const tier = useSfStore((s) => s.quality);
  const q = QUALITY[tier];
  const { camera } = useThree();
  const group = useRef<THREE.Group>(null);

  /* ---- materials ---- */
  const wind = useMemo(() => {
    const canopy = makeWindMaterial(1.0, "sf/foliage-canopy");
    const ground = makeWindMaterial(0.32, "sf/foliage-ground");
    return { canopy, ground };
  }, []);

  const barkMat = useMemo(
    () => getMaterial("wood-siding", { vertexColors: true, repeat: 1, name: "sf/bark", detail: false }),
    [],
  );

  /* ---- pools ---- */
  const pools = useMemo(() => {
    const map = new Map<VegPool, InstancePool>();
    const density = clamp(q.foliageDensity, 0.3, 1.5);
    const castShadow = tier === "high" || tier === "ultra";
    const geo: Record<string, THREE.BufferGeometry> = {};
    for (const sp of SPECIES_LIST) geo[sp] = canopyGeometry(sp);
    geo.trunk = trunkGeometry(false);
    geo["palm-trunk"] = trunkGeometry(true);
    geo.shrub = shrubGeometry();
    geo.grass = grassGeometry();
    geo.ivy = ivyGeometry();
    geo.billboard = billboardGeometry();

    const add = (k: VegPool, material: THREE.Material, shadow: boolean) => {
      map.set(
        k,
        new InstancePool(geo[k], material, Math.round(VEG_CAPACITY[k] * density), {
          castShadow: shadow,
          receiveShadow: true,
          color: true,
          name: `sf-veg-${k}`,
        }),
      );
    };
    for (const sp of SPECIES_LIST) add(sp, wind.canopy.material, castShadow);
    add("trunk", barkMat, castShadow);
    add("palm-trunk", barkMat, castShadow);
    add("shrub", wind.ground.material, false);
    add("grass", wind.ground.material, false);
    add("ivy", wind.ground.material, false);
    add("billboard", wind.canopy.material, false);
    return { map, geo };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier, wind, barkMat, q.foliageDensity]);

  const chunks = useRef(new Map<string, VegChunkRec>()).current;
  const streamer = useRef<ChunkStreamer | null>(null);
  const dirty = useRef(true);

  useEffect(() => {
    const g = group.current;
    if (!g) return;
    for (const p of pools.map.values()) g.add(p.mesh);

    const foliage = clamp(q.foliageDensity, 0.25, 1.5);
    const s = new ChunkStreamer(
      new THREE.Group(),
      (x, z, size, lod) => {
        const key = `${x}:${z}:${size}`;
        chunks.set(key, { key, x, z, size, data: buildVegChunk(x, z, size, lod, foliage) });
        dirty.current = true;
        return null;
      },
      () => clamp(q.detailRadius * 0.55, 240, 720),
      () => clamp(q.detailRadius * 2.2, 700, 2800),
      { cell: 256, farCell: 768, budgetMs: 2.4, warmupMs: 7 },
    );
    streamer.current = s;

    return () => {
      s.dispose();
      streamer.current = null;
      chunks.clear();
      for (const p of pools.map.values()) {
        g.remove(p.mesh);
        p.dispose();
      }
      for (const key of Object.keys(pools.geo)) pools.geo[key].dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pools, q.detailRadius, q.foliageDensity, chunks]);

  useEffect(
    () => () => {
      wind.canopy.material.dispose();
      wind.ground.material.dispose();
    },
    [wind],
  );

  const refill = (cx: number, cz: number): void => {
    const list = Array.from(chunks.values());
    list.sort(
      (a, b) =>
        (a.x + a.size * 0.5 - cx) ** 2 + (a.z + a.size * 0.5 - cz) ** 2 -
        ((b.x + b.size * 0.5 - cx) ** 2 + (b.z + b.size * 0.5 - cz) ** 2),
    );
    for (const p of pools.map.values()) p.begin();
    for (const rec of list) {
      for (const [kind, block] of rec.data) {
        const pool = pools.map.get(kind as VegPool);
        if (pool) pool.pushBlock(block.mat, block.n, block.col);
      }
    }
    for (const p of pools.map.values()) p.end();
  };

  useFrame(() => {
    const s = streamer.current;
    if (!s) return;
    camera.getWorldPosition(_cam);
    s.update(_cam.x, _cam.z, frame.time, () => {
      const live = new Set<string>();
      s.forEachResident((_k, x, z, size) => live.add(`${x}:${z}:${size}`));
      for (const key of Array.from(chunks.keys())) if (!live.has(key)) chunks.delete(key);
      dirty.current = true;
    });
    if (dirty.current) {
      dirty.current = false;
      refill(_cam.x, _cam.z);
    }

    // Wind. One shared gust drives every leaf in the city, taken straight from
    // the frame state so the bay, the flags and the trees agree.
    const wd = frame.windDirection;
    const len = Math.hypot(wd.x, wd.y) || 1;
    for (const w of [wind.canopy, wind.ground]) {
      w.uniforms.uTime.value = frame.time;
      w.uniforms.uWind.value.set(wd.x / len, wd.y / len);
      w.uniforms.uGust.value = clamp(frame.windSpeed, 0, 30);
    }
    reportPending(s.pending);
  });

  return <group ref={group} name="sf-vegetation" />;
}
