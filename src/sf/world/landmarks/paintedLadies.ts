/**
 * "Postcard Row" — 710–720 Steiner Street, and the slope of Alamo Square in
 * front of it.
 *
 * Seven Queen Anne Victorians built by one developer between 1892 and 1896, so
 * they are the *same house* seven times, differing only in paint and in the
 * ornament above the cornice. That is the key insight for modelling them: build
 * one house properly and vary the colour scheme, the gable and the trim, rather
 * than building seven vaguely Victorian boxes.
 *
 * The anatomy of one of them, bottom to top:
 *   0.0–1.5 m   rusticated basement storey, garage door, and the stoop beside it
 *   1.5–5.6 m   parlour floor, raised, reached by a flight of steps
 *   5.6–9.7 m   second floor
 *   9.7–13.8 m  third floor
 *   13.8 m      bracketed cornice with dentils
 *   to 17 m     false gable / parapet with applied ornament
 *
 * Running up the front from the parlour floor to the cornice is the angled bay
 * window — three faces, projecting about a metre. It is 70% of why the row
 * reads as Victorian and not as terraced housing.
 *
 * Colours come from the Alamo Square district palette in `sfGeo`, so the row
 * agrees with the neighbourhood the procedural generator builds around it.
 */
import * as THREE from "three";
import * as M from "./materials";
import { Batch, box, gableRoof, hipRoof, loft, stairs, taperBoxCyl, xform } from "./kit";
import { streetYaw, type LandmarkCtx, type LandmarkModule } from "./types";
import { districtAt, type LandmarkDef } from "../../geo/sfGeo";
import type { Rng } from "../../math/rng";

const HOUSES = 7;
const W = 7.8; // party-wall to party-wall
const DEPTH = 17;
const BASEMENT = 1.5;
const FLOOR = 4.1;
const EAVE = BASEMENT + FLOOR * 3;
const GABLE = 3.4;

interface Scheme {
  body: number;
  trim: number;
  accent: number;
  roof: number;
}

/**
 * Shared trim, accent and roof palettes.
 *
 * Every distinct colour is a distinct material, and a distinct material is a
 * draw call the batch cannot merge away. Seven houses with five bespoke colours
 * each is thirty-five draw calls for one landmark, which is more than the whole
 * of the Financial District costs. So the *body* colour is per-house — that is
 * what the row is famous for — and the trim, accent and roof are drawn from
 * small shared sets. Nobody has ever looked at Postcard Row and complained that
 * two of the houses share a shade of dark green window sash.
 */
const TRIMS = [0x8a8073, 0x6f6a60, 0xa39887, 0x4f5a52];
const ACCENTS = [0x8f4a3a, 0x2f5a6b, 0x6a5a2c, 0x53603f, 0x7a3f56];
const ROOFS = [0x5a5148, 0x4a4b4a, 0x6a5c4c];

function scheme(palette: number[], rng: Rng, i: number): Scheme {
  const body = palette[i % palette.length];
  // Real painted ladies use three to five colours: a light field, a deeper
  // trim, and one saturated accent picking out the ornament.
  return {
    body,
    trim: TRIMS[rng.int(0, TRIMS.length - 1)],
    accent: ACCENTS[(i + rng.int(0, 2)) % ACCENTS.length],
    roof: ROOFS[rng.int(0, ROOFS.length - 1)],
  };
}

/** Instanced buckets shared by the whole row — opened once, not per house. */
interface RowKit {
  win: ReturnType<Batch["instances"]>;
  surround: ReturnType<Batch["instances"]>;
  dentil: ReturnType<Batch["instances"]>;
  bracket: ReturnType<Batch["instances"]>;
}

/** One house, centred on local x, facing +Z. */
function house(ctx: LandmarkCtx, x: number, s: Scheme, rng: Rng, kit: RowKit): void {
  const { batch, detail } = ctx;
  const g = ctx.ground(x, -DEPTH / 2);
  const body = M.clapboard(s.body);
  const trim = M.victorianTrim(s.trim);
  const accent = M.victorianTrim(s.accent);
  const glass = M.curtainGlass(0x505c64);

  /* ---- the box ---- */
  // One shared rusticated basement colour for the whole row: it is in shadow
  // behind the stoops and nobody can tell it apart house to house.
  batch.add(M.paintedMasonry(0xb4aea0), box(W, BASEMENT, DEPTH), xform(x, g + BASEMENT / 2, 0));
  batch.add(body, box(W, EAVE - BASEMENT, DEPTH), xform(x, g + (EAVE + BASEMENT) / 2, 0));
  ctx.collide.box(x, g + EAVE / 2, 0, W / 2, EAVE / 2, DEPTH / 2, 0, { walkable: false });

  /* ---- the angled bay ---- */
  // Three faces: a 45-degree cheek, a flat front, another cheek. Lofted as one
  // prism from the parlour floor to the cornice so the reveals stay crisp.
  const bayW = 4.6;
  const bayOut = 1.15;
  const bayPlan: [number, number][] = [
    [-bayW / 2, 0],
    [-bayW / 2 + 0.75, bayOut],
    [bayW / 2 - 0.75, bayOut],
    [bayW / 2, 0],
  ];
  const bayRings: Float32Array[] = [];
  for (const y of [BASEMENT, EAVE]) {
    const arr: number[] = [];
    for (const [u, n] of bayPlan) arr.push(x + u, g + y, DEPTH / 2 + n);
    for (const [u, n] of [...bayPlan].reverse()) arr.push(x + u, g + y, DEPTH / 2 - 0.4 + n * 0);
    bayRings.push(new Float32Array(arr));
  }
  batch.add(body, loft(bayRings, false, false));

  if (detail) {
    // Sash windows: three per floor in the bay, two either side of it. The
    // buckets belong to the row, and the trim colour rides along per instance.
    const { win, surround } = kit;
    for (let f = 0; f < 3; f++) {
      const y = g + BASEMENT + FLOOR * f + 2.1;
      for (const [u, n] of [
        [-bayW / 2 + 0.36, bayOut * 0.5],
        [0, bayOut],
        [bayW / 2 - 0.36, bayOut * 0.5],
      ] as const) {
        const yaw = u === 0 ? 0 : u < 0 ? 0.62 : -0.62;
        surround.atPos(x + u, y, DEPTH / 2 + n + 0.03, yaw, 0, 0, 1, 1, 1, s.trim);
        win.atPos(x + u, y, DEPTH / 2 + n + 0.12, yaw);
      }
      // Flanking window on the wall beside the bay.
      surround.atPos(x + W / 2 - 1.15, y, DEPTH / 2 + 0.03, 0, 0, 0, 1, 1, 1, s.trim);
      win.atPos(x + W / 2 - 1.15, y, DEPTH / 2 + 0.12);
    }
    // Bay cornice caps at each floor line — the horizontal banding.
    for (let f = 1; f <= 3; f++) {
      const y = g + BASEMENT + FLOOR * f - 0.3;
      batch.add(trim, box(bayW + 0.5, 0.42, bayOut + 0.75), xform(x, y, DEPTH / 2 + bayOut * 0.6));
    }
  }

  /* ---- the stoop ---- */
  const stoopX = x - W / 2 + 1.35;
  batch.add(M.paving(0xc3bcae), stairs(9, 0.185, 0.31, 2.0), xform(stoopX, g, DEPTH / 2 + 3.6, -Math.PI / 2));
  batch.add(trim, box(2.5, 0.4, 2.4), xform(stoopX, g + BASEMENT + 0.5, DEPTH / 2 + 1.1));
  batch.add(accent, box(1.15, 2.5, 0.16), xform(stoopX, g + BASEMENT + 1.95, DEPTH / 2 + 0.1));
  if (detail) {
    // Porch hood on scrolled brackets, and the newel posts.
    batch.add(trim, box(2.7, 0.3, 1.3), xform(stoopX, g + BASEMENT + 3.5, DEPTH / 2 + 0.55));
    for (const sx of [-1, 1]) {
      batch.add(trim, box(0.22, 1.1, 1.0), xform(stoopX + sx * 1.15, g + BASEMENT + 2.9, DEPTH / 2 + 0.5));
      batch.add(trim, taperBoxCyl(0.13, 0.1, 1.0, 8), xform(stoopX + sx * 1.0, g + BASEMENT + 0.7, DEPTH / 2 + 2.1));
    }
    // Garage door in the rusticated basement.
    batch.add(trim, box(3.0, 1.2, 0.14), xform(x + 1.4, g + 0.75, DEPTH / 2 + 0.05));
  }

  /* ---- cornice ---- */
  batch.add(trim, box(W + 0.7, 0.9, DEPTH + 0.7), xform(x, g + EAVE + 0.45, 0));
  if (detail) {
    const { dentil, bracket } = kit;
    const n = Math.round((W + 0.7) / 0.34);
    for (let i = 0; i < n; i++) {
      dentil.atPos(x - (W + 0.7) / 2 + (i + 0.5) * 0.34, g + EAVE + 0.15, DEPTH / 2 + 0.5, 0, 0, 0, 1, 1, 1, s.trim);
    }
    for (let i = 0; i < 5; i++) {
      bracket.atPos(x - W / 2 + 0.5 + (i * (W - 1)) / 4, g + EAVE - 0.45, DEPTH / 2 + 0.55, 0, 0, 0, 1, 1, 1, s.accent);
    }
  }

  /* ---- the false gable ---- */
  // Each house in the row has a different crown: two gabled, some with a
  // segmental pediment, some flat with an ornamented parapet.
  const kind = rng.int(0, 2);
  if (kind === 0) {
    batch.add(M.roofTile(s.roof), gableRoof(W + 0.4, DEPTH, GABLE, 0.45), xform(x, g + EAVE + 0.9, 0, Math.PI / 2));
    if (detail) batch.add(accent, box(2.2, 1.5, 0.2), xform(x, g + EAVE + 2.0, DEPTH / 2 + 0.35));
  } else if (kind === 1) {
    batch.add(body, box(W + 0.3, GABLE, 1.4), xform(x, g + EAVE + 0.9 + GABLE / 2, DEPTH / 2 - 0.3));
    batch.add(trim, box(W + 0.9, 0.5, 1.8), xform(x, g + EAVE + 0.9 + GABLE, DEPTH / 2 - 0.3));
    if (detail) {
      batch.add(accent, box(2.6, 1.7, 0.2), xform(x, g + EAVE + 2.2, DEPTH / 2 + 0.45));
      for (const sx of [-1, 1]) {
        batch.add(trim, taperBoxCyl(0.28, 0.2, 1.2, 8), xform(x + sx * (W / 2 - 0.3), g + EAVE + 0.9 + GABLE, DEPTH / 2 - 0.3));
      }
    }
    batch.add(M.flatRoof(), box(W, 0.3, DEPTH - 1.4), xform(x, g + EAVE + 1.0, -0.7));
  } else {
    batch.add(M.roofTile(s.roof), hipRoof(W + 0.4, DEPTH, GABLE * 0.7, 0.4), xform(x, g + EAVE + 0.9, 0));
    if (detail) {
      batch.add(accent, box(3.0, 1.3, 0.9), xform(x, g + EAVE + 1.6, DEPTH / 2 - 0.1));
    }
  }
  // Chimney: every one of them has one, on the party wall.
  batch.add(M.brick(0xb0705a), box(0.95, 3.4, 1.5), xform(x + W / 2 - 0.6, g + EAVE + 2.2, -DEPTH / 4));
  ctx.collide.box(x, g + EAVE + 1.2, 0, W / 2, 1.2, DEPTH / 2, 0, { walkable: true });
}

/* ------------------------------------------------------------------ *
 * Alamo Square
 * ------------------------------------------------------------------ */

/** A terrain-conforming lawn. Reads `ctx.ground`, so it never floats or sinks. */
function lawn(ctx: LandmarkCtx, z0: number, z1: number, halfW: number, cells: number): void {
  const nz = cells;
  const nx = cells;
  const pos = new Float32Array((nx + 1) * (nz + 1) * 3);
  const uv = new Float32Array((nx + 1) * (nz + 1) * 2);
  const idx: number[] = [];
  for (let j = 0; j <= nz; j++) {
    const lz = z0 + ((z1 - z0) * j) / nz;
    for (let i = 0; i <= nx; i++) {
      const lx = -halfW + (2 * halfW * i) / nx;
      const k = j * (nx + 1) + i;
      pos[k * 3] = lx;
      // Sit 60 mm proud of the terrain: turf over soil, and it stops the mesh
      // z-fighting with the clipmap on the shallow parts of the slope.
      pos[k * 3 + 1] = ctx.ground(lx, lz) + 0.06;
      pos[k * 3 + 2] = lz;
      uv[k * 2] = i / nx;
      uv[k * 2 + 1] = j / nz;
      if (i < nx && j < nz) {
        const a = k;
        const b = k + 1;
        const c = k + nx + 2;
        const d = k + nx + 1;
        idx.push(a, c, b, a, d, c);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  ctx.batch.add(M.grass(0xcfd6a8), geo);
}

function build(ctx: LandmarkCtx): void {
  const { batch, detail, rng } = ctx;
  const palette = districtAt(ctx.def.x, ctx.def.z).palette;

  const rowW = HOUSES * W;
  const kit: RowKit = {
    win: batch.instances(M.curtainGlass(0x505c64), box(1.05, 2.3, 0.12)),
    surround: batch.instances(M.victorianTrim(0xffffff), box(1.5, 2.9, 0.16)),
    dentil: batch.instances(M.victorianTrim(0xffffff), box(0.16, 0.24, 0.3)),
    bracket: batch.instances(M.victorianTrim(0xffffff), box(0.3, 0.85, 0.62)),
  };
  for (let i = 0; i < HOUSES; i++) {
    const x = -rowW / 2 + W * (i + 0.5);
    house(ctx, x, scheme(palette, rng.fork(`house${i}`), i), rng.fork(`shape${i}`), kit);
  }

  /* ---- Steiner Street and the sidewalk in front ---- */
  const sidewalkZ = DEPTH / 2 + 5.4;
  const walkPts: THREE.Vector3[] = [];
  for (let i = 0; i <= 12; i++) {
    const x = -rowW / 2 - 8 + ((rowW + 16) * i) / 12;
    walkPts.push(new THREE.Vector3(x, ctx.ground(x, sidewalkZ) + 0.16, sidewalkZ));
  }
  batch.add(M.paving(0xc6bfb1), buildStrip(walkPts, 2.6));
  ctx.collide.ribbon(walkPts, 2.6, 0.4, { drivable: false, walkable: true });

  /* ---- Alamo Square: the lawn the photograph is taken from ---- */
  lawn(ctx, sidewalkZ + 12, sidewalkZ + 120, 78, detail ? 26 : 8);

  if (detail) {
    // A diagonal asphalt path and the row of palms and cypresses along it.
    const path: THREE.Vector3[] = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      const lx = -60 + 120 * t;
      const lz = sidewalkZ + 20 + 88 * t * (1 - t) * 1.4 + 20 * t;
      path.push(new THREE.Vector3(lx, ctx.ground(lx, lz) + 0.1, lz));
    }
    batch.add(M.paving(0x9a938a), buildStrip(path, 1.6));

    const trunk = batch.instances(M.deckTimber(0x8b7d6b), box(1, 1, 1));
    const canopy = batch.instances(M.foliage(0x93a86a), box(1, 0.1, 1));
    const treeRng = rng.fork("trees");
    for (let i = 0; i < 22; i++) {
      const lx = treeRng.range(-72, 72);
      const lz = sidewalkZ + treeRng.range(20, 112);
      const gy = ctx.ground(lx, lz);
      const h = treeRng.range(7, 13);
      const r = treeRng.range(2.6, 4.6);
      trunk.atPos(lx, gy + h / 2, lz, 0, 0, 0, 0.5, h, 0.5);
      // Crossed cutout quads: three planes make a convincing canopy from any
      // angle for six triangles, and the foliage material is alpha-tested.
      for (let k = 0; k < 3; k++) {
        canopy.atPos(lx, gy + h * 0.82, lz, (k / 3) * Math.PI, 0, Math.PI / 2, r * 2, 1, r * 2);
        canopy.atPos(lx, gy + h * 0.72 + k * 1.1, lz, (k / 3) * Math.PI + 0.6, 0, 0, r * 2, 1, r * 2);
      }
    }
  }
}

/** A flat strip along a polyline — sidewalks and park paths. */
function buildStrip(points: THREE.Vector3[], halfWidth: number): THREE.BufferGeometry {
  const n = points.length;
  const pos = new Float32Array(n * 2 * 3);
  const uv = new Float32Array(n * 2 * 2);
  const idx: number[] = [];
  const dir = new THREE.Vector3();
  const side = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(n - 1, i + 1)];
    dir.subVectors(b, a);
    dir.y = 0;
    if (dir.lengthSq() < 1e-8) dir.set(1, 0, 0);
    dir.normalize();
    side.crossVectors(up, dir).multiplyScalar(halfWidth);
    const p = points[i];
    pos[i * 6] = p.x + side.x;
    pos[i * 6 + 1] = p.y;
    pos[i * 6 + 2] = p.z + side.z;
    pos[i * 6 + 3] = p.x - side.x;
    pos[i * 6 + 4] = p.y;
    pos[i * 6 + 5] = p.z - side.z;
    uv[i * 4] = 0;
    uv[i * 4 + 1] = i;
    uv[i * 4 + 2] = 1;
    uv[i * 4 + 3] = i;
    if (i < n - 1) idx.push(i * 2, i * 2 + 1, i * 2 + 3, i * 2, i * 2 + 3, i * 2 + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export const paintedLadies: LandmarkModule = {
  // The row faces west across Steiner into the park; the grid decides which
  // "west" that is, so the houses line up with the street the city generates.
  yaw: (def: LandmarkDef) => streetYaw(def.x, def.z, Math.PI),
  build,
  nearRange: (def) => Math.max(480, def.radius * 7),
};
