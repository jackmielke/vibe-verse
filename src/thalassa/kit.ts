/**
 * The builder's kit: painted textures, shared materials, and a geometry
 * batcher that turns hundreds of boxes and prisms into one mesh per material.
 *
 * Every texture is drawn in a canvas at startup. They are light and nearly
 * neutral on purpose; the colour comes from vertex colours, so one stone
 * texture serves a sun-bleached wall, a honey-coloured tower and a grey quay.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { makeRng } from "@/shared/proc/rng";

/* ------------------------------------------------------------------ *
 * Textures
 * ------------------------------------------------------------------ */

function canvas(w: number, h = w): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return [c, c.getContext("2d")!];
}

function finish(c: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** Dressed limestone blocks: courses of slightly uneven ashlar with soft joints. One repeat = 2 m. */
function stoneTexture(): THREE.CanvasTexture {
  const n = 256;
  const [c, ctx] = canvas(n);
  const r = makeRng("stone");
  ctx.fillStyle = "#ddd6c8"; ctx.fillRect(0, 0, n, n);
  const rows = 5;
  const rh = n / rows;
  for (let j = 0; j < rows; j++) {
    let x = -r.next() * 40;
    while (x < n) {
      const w = 60 + r.next() * 70;
      const l = 214 + Math.floor(r.next() * 24);
      ctx.fillStyle = `rgb(${l},${l - 6},${l - 18})`;
      ctx.fillRect(x + 1.5, j * rh + 1.5, w - 3, rh - 3);
      // Weathering inside the block.
      for (let k = 0; k < 10; k++) {
        const a = 0.04 + r.next() * 0.06;
        ctx.fillStyle = r.next() < 0.5 ? `rgba(120,100,70,${a})` : `rgba(255,250,235,${a})`;
        ctx.beginPath();
        ctx.ellipse(x + r.next() * w, j * rh + r.next() * rh, 4 + r.next() * 12, 2 + r.next() * 6, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      x += w;
    }
  }
  // Wrap the blocks that cross the right edge.
  ctx.drawImage(c, n, 0, n, n, 0, 0, n, n);
  return finish(c);
}

/** Terracotta pan tiles: rows of rounded channels, each tile a slightly different fired colour. One repeat = 2 m. */
function roofTexture(): THREE.CanvasTexture {
  const n = 256;
  const [c, ctx] = canvas(n);
  const r = makeRng("roof");
  ctx.fillStyle = "#b8b8b8"; ctx.fillRect(0, 0, n, n);
  const cols = 10, rows = 7;
  const cw = n / cols, rh = n / rows;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = i * cw, y = j * rh;
      const l = 205 + Math.floor(r.next() * 50);
      const g = ctx.createLinearGradient(x, 0, x + cw, 0);
      g.addColorStop(0, `rgb(${l - 70},${l - 70},${l - 70})`);
      g.addColorStop(0.45, `rgb(${l},${l},${l})`);
      g.addColorStop(1, `rgb(${l - 90},${l - 90},${l - 90})`);
      ctx.fillStyle = g;
      ctx.fillRect(x, y, cw, rh);
      // The lower lip of each tile throws a shadow on the one below.
      ctx.fillStyle = "rgba(40,40,40,0.45)";
      ctx.fillRect(x, y + rh - 3, cw, 3);
    }
  }
  return finish(c);
}

/** Lime plaster, faintly clouded. */
function plasterTexture(): THREE.CanvasTexture {
  const n = 256;
  const [c, ctx] = canvas(n);
  const r = makeRng("plaster");
  ctx.fillStyle = "#efefef"; ctx.fillRect(0, 0, n, n);
  for (let i = 0; i < 70; i++) {
    const x = r.next() * n, y = r.next() * n, rad = 8 + r.next() * 40;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, r.next() < 0.5 ? "rgba(205,200,190,0.09)" : "rgba(255,255,255,0.12)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  return finish(c);
}

/** Planks, pale and grey, for docks and decks. One repeat = 2 m. */
function woodTexture(): THREE.CanvasTexture {
  const n = 256;
  const [c, ctx] = canvas(n);
  const r = makeRng("wood");
  const planks = 8;
  const pw = n / planks;
  for (let i = 0; i < planks; i++) {
    const l = 170 + Math.floor(r.next() * 60);
    ctx.fillStyle = `rgb(${l},${l - 4},${l - 12})`;
    ctx.fillRect(0, i * pw, n, pw);
    for (let k = 0; k < 14; k++) {
      ctx.strokeStyle = `rgba(70,50,30,${0.08 + r.next() * 0.1})`;
      ctx.beginPath();
      const y = i * pw + r.next() * pw;
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(n * 0.3, y + (r.next() - 0.5) * 6, n * 0.6, y + (r.next() - 0.5) * 6, n, y);
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(30,20,10,0.55)";
    ctx.fillRect(0, i * pw, n, 2);
    // Butt joints.
    const jx = r.next() * n;
    ctx.fillRect(jx, i * pw, 2, pw);
  }
  return finish(c);
}

/** Striped sailcloth. */
export function sailTexture(a: string, b: string, stripes = 5): THREE.CanvasTexture {
  const [c, ctx] = canvas(128);
  for (let i = 0; i < stripes * 2; i++) {
    ctx.fillStyle = i % 2 ? a : b;
    ctx.fillRect((i * 128) / (stripes * 2), 0, 128 / (stripes * 2) + 1, 128);
  }
  // Seams and a little weathering.
  ctx.fillStyle = "rgba(80,60,40,0.12)";
  for (let y = 0; y < 128; y += 16) ctx.fillRect(0, y, 128, 1);
  const t = finish(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/* ------------------------------------------------------------------ *
 * Materials
 * ------------------------------------------------------------------ */

export interface Kit {
  stone: THREE.MeshStandardMaterial;
  plaster: THREE.MeshStandardMaterial;
  roof: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
  marble: THREE.MeshStandardMaterial;
  cloth: THREE.MeshStandardMaterial;
  paint: THREE.MeshStandardMaterial;
  gold: THREE.MeshStandardMaterial;
  leaf: THREE.MeshStandardMaterial;
  dispose(): void;
}

let shared: Kit | null = null;
let users = 0;

export function kit(): Kit {
  users++;
  if (shared) return shared;
  const stoneMap = stoneTexture();
  const roofMap = roofTexture();
  const plasterMap = plasterTexture();
  const woodMap = woodTexture();
  const k: Kit = {
    stone: new THREE.MeshStandardMaterial({ map: stoneMap, vertexColors: true, roughness: 0.92 }),
    plaster: new THREE.MeshStandardMaterial({ map: plasterMap, vertexColors: true, roughness: 0.95 }),
    roof: new THREE.MeshStandardMaterial({ map: roofMap, vertexColors: true, roughness: 0.8 }),
    wood: new THREE.MeshStandardMaterial({ map: woodMap, vertexColors: true, roughness: 0.9 }),
    marble: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, color: "#fffdf8" }),
    cloth: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }),
    paint: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }),
    gold: new THREE.MeshStandardMaterial({ color: "#f0bf45", metalness: 0.85, roughness: 0.28, emissive: "#5a3a00", emissiveIntensity: 0.35 }),
    leaf: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }),
    dispose() {
      users--;
      if (users > 0) return;
      for (const m of [k.stone, k.plaster, k.roof, k.wood, k.marble, k.cloth, k.paint, k.gold, k.leaf]) m.dispose();
      for (const t of [stoneMap, roofMap, plasterMap, woodMap]) t.dispose();
      shared = null;
    },
  };
  shared = k;
  return k;
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/** A box whose UVs are in metres / `tile`, so textures keep their scale. */
export function box(w: number, h: number, d: number, tile = 2): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const dims: Array<[number, number]> = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const [a, b] = dims[f];
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, uv.getX(i) * (a / tile), uv.getY(i) * (b / tile));
    }
  }
  return g;
}

/**
 * A pitched roof over a w x d rectangle, ridge along x. `hip` > 0 pulls the
 * ends in, so 0 is a gable and w/2 a pyramid. UVs run down the slope.
 */
export function roof(w: number, d: number, rise: number, hip = 0, tile = 2): THREE.BufferGeometry {
  const hw = w / 2, hd = d / 2;
  const rx = Math.max(0, hw - hip);
  const pos: number[] = [];
  const uv: number[] = [];
  const slope = Math.hypot(hd, rise);
  const quad = (a: number[], b: number[], c: number[], e: number[], ua: number[], ub: number[], uc: number[], ue: number[]) => {
    pos.push(...a, ...b, ...c, ...a, ...c, ...e);
    uv.push(...ua, ...ub, ...uc, ...ua, ...uc, ...ue);
  };
  const tri = (a: number[], b: number[], c: number[], ua: number[], ub: number[], uc: number[]) => {
    pos.push(...a, ...b, ...c);
    uv.push(...ua, ...ub, ...uc);
  };
  const s = slope / tile;
  // South (+z) and north (-z) slopes.
  quad([-hw, 0, hd], [hw, 0, hd], [rx, rise, 0], [-rx, rise, 0], [-hw / tile, 0], [hw / tile, 0], [rx / tile, s], [-rx / tile, s]);
  quad([hw, 0, -hd], [-hw, 0, -hd], [-rx, rise, 0], [rx, rise, 0], [-hw / tile, 0], [hw / tile, 0], [rx / tile, s], [-rx / tile, s]);
  if (hip > 0) {
    const hs = Math.hypot(hip, rise) / tile;
    tri([hw, 0, hd], [hw, 0, -hd], [rx, rise, 0], [-hd / tile, 0], [hd / tile, 0], [0, hs]);
    tri([-hw, 0, -hd], [-hw, 0, hd], [-rx, rise, 0], [-hd / tile, 0], [hd / tile, 0], [0, hs]);
  } else {
    // Gable ends, in the wall's material by colour; they are triangles of wall.
    tri([hw, 0, hd], [hw, 0, -hd], [hw, rise, 0], [-hd / tile, 0], [hd / tile, 0], [0, rise / tile]);
    tri([-hw, 0, -hd], [-hw, 0, hd], [-hw, rise, 0], [-hd / tile, 0], [hd / tile, 0], [0, rise / tile]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

const tmpColor = new THREE.Color();

/** Collects geometries for one material and merges them into a single mesh. */
export class Batch {
  private parts: THREE.BufferGeometry[] = [];
  constructor(private material: THREE.Material, private name: string) {}

  /** Adds `geo` (consumed) with a flat colour, transformed by position / rotation y / scale. */
  add(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0): void {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array((g.attributes.position.count) * 2), 2));
    for (const name of Object.keys(g.attributes)) if (!["position", "normal", "uv", "color"].includes(name)) g.deleteAttribute(name);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, "YXZ")),
      new THREE.Vector3(1, 1, 1),
    );
    g.applyMatrix4(m);
    if (!g.attributes.color) {
      tmpColor.set(color);
      const n = g.attributes.position.count;
      const c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { c[i * 3] = tmpColor.r; c[i * 3 + 1] = tmpColor.g; c[i * 3 + 2] = tmpColor.b; }
      g.setAttribute("color", new THREE.BufferAttribute(c, 3));
    }
    this.parts.push(g);
  }

  /** Adds a geometry already placed in world space by a matrix. */
  addMatrix(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, m: THREE.Matrix4): void {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    if (!g.attributes.uv) g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array((g.attributes.position.count) * 2), 2));
    for (const name of Object.keys(g.attributes)) if (!["position", "normal", "uv", "color"].includes(name)) g.deleteAttribute(name);
    if (!g.attributes.normal) g.computeVertexNormals();
    g.applyMatrix4(m);
    tmpColor.set(color);
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { c[i * 3] = tmpColor.r; c[i * 3 + 1] = tmpColor.g; c[i * 3 + 2] = tmpColor.b; }
    g.setAttribute("color", new THREE.BufferAttribute(c, 3));
    this.parts.push(g);
  }

  get size(): number { return this.parts.length; }

  build(opts: { shadows?: boolean; receive?: boolean } = {}): THREE.Mesh | null {
    if (!this.parts.length) return null;
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    if (!merged) return null;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, this.material);
    mesh.name = this.name;
    mesh.castShadow = opts.shadows ?? true;
    mesh.receiveShadow = opts.receive ?? true;
    return mesh;
  }
}

/** Jitter a colour's lightness and hue a little, deterministically. */
export function vary(base: string, r: () => number, amount = 0.06): THREE.Color {
  const c = new THREE.Color(base);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h + (r() - 0.5) * amount * 0.3, Math.min(1, Math.max(0, hsl.s + (r() - 0.5) * amount)), Math.min(1, Math.max(0, hsl.l + (r() - 0.5) * amount * 1.4)));
  return c;
}

/**
 * Fold every mesh under `parent` (except `keep` and their subtrees) into one
 * mesh per material, in `parent`'s space. A galley is forty-odd small parts
 * that never move relative to each other; drawn separately they were most of
 * the frame's draw calls, and a headset draws every one of them twice.
 */
export function mergeStatic(parent: THREE.Object3D, keep: Set<THREE.Object3D> = new Set(), disposeSources = true): void {
  parent.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
  const buckets = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[]; shadow: boolean; meshes: THREE.Mesh[] }>();
  const visit = (o: THREE.Object3D) => {
    for (const c of [...o.children]) {
      if (keep.has(c)) continue;
      const m = c as THREE.Mesh;
      if (m.isMesh && !(m as unknown as THREE.SkinnedMesh).isSkinnedMesh && !Array.isArray(m.material)) {
        const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone());
        g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
        for (const name of Object.keys(g.attributes)) if (!["position", "normal", "uv", "color"].includes(name)) g.deleteAttribute(name);
        const sig = m.material.uuid + "|" + Object.keys(g.attributes).sort().join(",");
        let b = buckets.get(sig);
        if (!b) buckets.set(sig, (b = { mat: m.material, geos: [], shadow: false, meshes: [] }));
        b.geos.push(g);
        b.shadow ||= m.castShadow;
        b.meshes.push(m);
      }
      visit(c);
    }
  };
  visit(parent);
  for (const b of buckets.values()) {
    if (b.meshes.length < 2) { for (const g of b.geos) g.dispose(); continue; }
    const merged = mergeGeometries(b.geos);
    for (const g of b.geos) g.dispose();
    if (!merged) continue;
    for (const m of b.meshes) { m.removeFromParent(); if (disposeSources) m.geometry.dispose(); }
    const mesh = new THREE.Mesh(merged, b.mat);
    mesh.castShadow = b.shadow;
    mesh.receiveShadow = true;
    parent.add(mesh);
  }
  // Drop the groups that are now empty.
  const empty: THREE.Object3D[] = [];
  parent.traverse((o) => { if (o !== parent && !(o as THREE.Mesh).isMesh && o.children.length === 0 && !keep.has(o)) empty.push(o); });
  for (const o of empty) o.removeFromParent();
}
