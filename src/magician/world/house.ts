/**
 * A minka: the farmhouse of a Japanese mountain village.
 *
 * Built from the ground up the way one is: a low stone plinth, a floor
 * raised on it, a dark timber frame of posts and rails, charred cedar boards
 * to waist height and white plaster above, shoji windows in wooden lattice,
 * a veranda under deep eaves, and a roof that is either thick thatch
 * (kayabuki, straw-coloured, a dark ridge cap) or fired clay tile (kawara,
 * blue-grey, a ridge of tiles with end caps).
 *
 * Every piece is placed in the house's own space and then merged, one mesh
 * per material, so a house is about eight draw calls however much detail
 * is in it. The shoji keep their own material so they can glow at dusk.
 *
 * The front of the house faces +z; the door is on the front.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { boxUV, surfaceMaterial, TILE, type SurfaceName } from "./textures";

export interface Minka {
  group: THREE.Group;
  /** The shoji, for the lamp to light. */
  glow: THREE.MeshStandardMaterial;
  /** Where a porch light belongs, in house space. */
  lampAt: THREE.Vector3;
  /** Half extents of the walls, for collision: x, z. */
  half: [number, number];
  /** An open house can be walked into: its walls as segments (x1, z1, x2, z2) in house space, with a doorway gap. */
  walls?: Array<[number, number, number, number]>;
  /** The inside, for the interior builder: floor height, wall height, footprint and door. */
  room?: { FH: number; WH: number; w: number; d: number; doorX: number; ceiling: number };
  dispose(): void;
}

type MatKey = SurfaceName | "ridge" | "dark" | "noren" | "glow";

const shared = new Map<MatKey, THREE.MeshStandardMaterial>();
function mat(key: Exclude<MatKey, "glow">): THREE.MeshStandardMaterial {
  let m = shared.get(key);
  if (m) return m;
  switch (key) {
    case "ridge": m = new THREE.MeshStandardMaterial({ color: "#3a2e22", roughness: 0.95 }); break;
    case "dark": m = new THREE.MeshStandardMaterial({ color: "#1e1712", roughness: 0.9 }); break;
    case "noren": {
      // Indigo cloth in three panels with a white crest across them; the
      // slits are what make it read as a curtain and not as a closed door.
      const cv = document.createElement("canvas");
      cv.width = 256; cv.height = 110;
      const g = cv.getContext("2d")!;
      g.clearRect(0, 0, 256, 110);
      for (let i = 0; i < 3; i++) {
        g.fillStyle = "#2e4a86";
        g.fillRect(i * 86 + 2, 0, 80, 110);
        g.fillStyle = "rgba(0,0,0,0.12)";
        for (let y = 0; y < 110; y += 4) g.fillRect(i * 86 + 2, y, 80, 1);
      }
      g.strokeStyle = "#f4efe4"; g.lineWidth = 7;
      g.beginPath(); g.arc(128, 50, 28, 0, Math.PI * 2); g.stroke();
      g.fillStyle = "#f4efe4"; g.font = "bold 34px serif"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText("星", 128, 52);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      m = new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.5, roughness: 0.95, side: THREE.DoubleSide });
      break;
    }
    case "tiles": m = surfaceMaterial("tiles", { roughness: 0.55, bumpScale: 1.2 }); break;
    case "thatch": m = surfaceMaterial("thatch", { roughness: 1, bumpScale: 1.4 }); break;
    case "stone": m = surfaceMaterial("stone", { bumpScale: 1.2 }); break;
    case "boards": m = surfaceMaterial("boards", { roughness: 0.92 }); break;
    case "timber": m = surfaceMaterial("timber", { roughness: 0.85 }); break;
    case "plaster": m = surfaceMaterial("plaster", { roughness: 0.95, bumpScale: 0.3 }); break;
    default: m = surfaceMaterial(key as SurfaceName); break;
  }
  shared.set(key, m);
  return m;
}

export function disposeMinkaMaterials(): void {
  for (const [k, m] of shared) { if (k === "noren") m.map?.dispose(); m.dispose(); }
  shared.clear();
}

function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 7;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * A hip roof as one indexed surface with a thick edge and a soffit.
 * W, D are the eave extents, H the rise, T the visible thickness at the
 * eaves, ridge the fraction of W the ridge runs along.
 */
function hipRoof(W: number, D: number, H: number, T: number, tile: number, droop: number): THREE.BufferGeometry {
  const hw = W / 2, hd = D / 2;
  const rl = Math.max(0.2, W - D) / 2; // half ridge length
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], uw: number, vh: number) => {
    const i = pos.length / 3;
    pos.push(...a, ...b, ...c, ...d);
    uv.push(0, 0, uw / tile, 0, uw / tile, vh / tile, 0, vh / tile);
    idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  };
  const tri = (a: number[], b: number[], c: number[], uw: number, vh: number) => {
    const i = pos.length / 3;
    pos.push(...a, ...b, ...c);
    uv.push(0, 0, uw / tile, 0, uw / (2 * tile), vh / tile);
    idx.push(i, i + 1, i + 2);
  };
  // Eave corners sag slightly toward the middle of each side, the way a
  // real roof reads from the ground: a flat eave looks like a lid.
  const y0 = 0;
  const e = (x: number, z: number) => [x, y0 - droop * (1 - Math.abs(x) / hw) * (1 - Math.abs(z) / hd) * 0, z];
  const slopeFB = Math.hypot(hd, H), slopeLR = Math.hypot(hw - rl, H);
  const r0 = [-rl, H, 0], r1 = [rl, H, 0];
  // Front and back trapezoids, left and right triangles. Counter-clockwise
  // seen from outside.
  quad(e(-hw, hd), e(hw, hd), r1, r0, W, slopeFB);
  quad(e(hw, -hd), e(-hw, -hd), r0, r1, W, slopeFB);
  tri(e(hw, hd), e(hw, -hd), r1, D, slopeLR);
  tri(e(-hw, -hd), e(-hw, hd), r0, D, slopeLR);
  // The thickness at the eaves, all round.
  const edge = (a: number[], b: number[], len: number) => quad([a[0], a[1] - T, a[2]], [b[0], b[1] - T, b[2]], b, a, len, T);
  edge(e(-hw, hd), e(hw, hd), W);
  edge(e(hw, -hd), e(-hw, -hd), W);
  edge(e(hw, hd), e(hw, -hd), D);
  edge(e(-hw, -hd), e(-hw, hd), D);
  // Soffit, seen from underneath.
  quad([-hw, y0 - T, -hd], [hw, y0 - T, -hd], [hw, y0 - T, hd], [-hw, y0 - T, hd], W, D);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function buildMinka(seed: number, opts: { roof?: "thatch" | "tiles"; wall?: string; open?: boolean } = {}): Minka {
  const r = rng(seed);
  // A house you can walk into is a little bigger, so a room fits inside.
  const w = opts.open ? 7.8 : 6 + r() * 1.4;
  const d = opts.open ? 5.8 : 4.4 + r() * 0.7;
  const open = !!opts.open;
  const roof = opts.roof ?? (r() < 0.55 ? "thatch" : "tiles");
  const FH = 0.55; // floor height
  const WH = 2.45; // wall height above floor
  const SK = 0.95; // skirt height
  const parts = new Map<MatKey, THREE.BufferGeometry[]>();
  const add = (key: MatKey, g: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0) => {
    g.rotateY(ry);
    g.translate(x, y, z);
    if (!g.index) g = g.toNonIndexed(); // never happens for our primitives; keeps types honest
    const list = parts.get(key) ?? [];
    list.push(g);
    parts.set(key, list);
  };
  const box = (key: MatKey, sx: number, sy: number, sz: number, x: number, y: number, z: number, ry = 0) => {
    const tile = key in TILE ? TILE[key as SurfaceName] : 1;
    add(key, boxUV(new THREE.BoxGeometry(sx, sy, sz), sx, sy, sz, tile), x, y, z, ry);
  };

  // Plinth and floor.
  box("stone", w + 0.5, 0.4, d + 0.5, 0, 0.2, 0);
  box("timber", w + 0.1, 0.16, d + 0.1, 0, FH - 0.08, 0);

  // Walls: skirt boards, then plaster, on all four sides. Slightly inset
  // from the frame so the posts stand proud and cast a shadow line.
  const t = 0.1;
  const inset = 0.04;
  const sides: Array<{ len: number; x: number; z: number; ry: number }> = [
    { len: w, x: 0, z: d / 2 - inset, ry: 0 },
    { len: w, x: 0, z: -d / 2 + inset, ry: Math.PI },
    { len: d, x: w / 2 - inset, z: 0, ry: Math.PI / 2 },
    { len: d, x: -w / 2 + inset, z: 0, ry: -Math.PI / 2 },
  ];
  // The door is chosen first, because an open house leaves a gap for it.
  const doorX = open ? -w * 0.18 : (r() - 0.5) * w * 0.3;
  const DOOR_W = 1.5, DOOR_H = 1.95;
  const g0 = doorX - DOOR_W / 2, g1 = doorX + DOOR_W / 2;
  for (const s of sides) {
    if (open && s.ry === 0) {
      // Front wall in two pieces either side of the doorway, a lintel above.
      for (const [a, b] of [[-w / 2, g0], [g1, w / 2]]) {
        box("boards", b - a, SK, t, (a + b) / 2, FH + SK / 2, s.z, 0);
        box("plaster", b - a, WH - SK, t, (a + b) / 2, FH + SK + (WH - SK) / 2, s.z, 0);
      }
      box("plaster", DOOR_W, WH - DOOR_H, t, doorX, FH + DOOR_H + (WH - DOOR_H) / 2, s.z, 0);
      continue;
    }
    box("boards", s.len, SK, t, s.x, FH + SK / 2, s.z, s.ry);
    box("plaster", s.len, WH - SK, t, s.x, FH + SK + (WH - SK) / 2, s.z, s.ry);
  }

  // Frame: posts every metre and a half, a rail at the skirt, a beam on top.
  const post = 0.17;
  const addPosts = (len: number, fixed: number, alongX: boolean) => {
    const n = Math.max(2, Math.round(len / 1.5) + 1);
    for (let i = 0; i < n; i++) {
      const a = -len / 2 + (i / (n - 1)) * len;
      const x = alongX ? a : fixed, z = alongX ? fixed : a;
      // Nothing stands in the doorway.
      if (open && alongX && fixed > 0 && a > g0 - 0.15 && a < g1 + 0.15) continue;
      box("timber", post, WH, post, x, FH + WH / 2, z);
    }
    if (open && alongX && fixed > 0) for (const a of [g0 - 0.08, g1 + 0.08]) box("timber", post, WH, post, a, FH + WH / 2, fixed);
  };
  addPosts(w, d / 2, true);
  addPosts(w, -d / 2, true);
  addPosts(d, w / 2, false);
  addPosts(d, -w / 2, false);
  for (const s of sides) {
    const outX = s.ry === Math.PI / 2 ? 0.05 : s.ry === -Math.PI / 2 ? -0.05 : 0;
    const outZ = s.ry === 0 ? 0.05 : s.ry === Math.PI ? -0.05 : 0;
    if (open && s.ry === 0) {
      for (const [a, b] of [[-w / 2 - post / 2, g0], [g1, w / 2 + post / 2]]) box("timber", b - a, 0.12, 0.14, (a + b) / 2, FH + SK, s.z + outZ, 0);
    } else box("timber", s.len + post, 0.12, 0.14, s.x + outX, FH + SK, s.z + outZ, s.ry);
    box("timber", s.len + post + 0.3, 0.22, 0.2, s.x + outX, FH + WH, s.z + outZ, s.ry);
  }

  // Front: sliding doors off centre, a noren over them, shoji either side.
  if (open) {
    // The sliding doors stand open, pushed aside over the wall.
    box("dark", DOOR_W / 2, DOOR_H, 0.05, g0 - DOOR_W / 4 - 0.05, FH + DOOR_H / 2, d / 2 + 0.06);
    box("timber", 0.06, DOOR_H, 0.08, g0 - 0.06, FH + DOOR_H / 2, d / 2 + 0.08);
    box("timber", DOOR_W + 0.1, 0.1, 0.12, doorX, FH + DOOR_H + 0.05, d / 2 + 0.02); // the lintel's rail
    box("timber", DOOR_W, 0.05, t + 0.06, doorX, FH + 0.025, d / 2 - inset); // the sill
  } else {
    box("dark", 1.5, 1.95, 0.06, doorX, FH + 0.98, d / 2 + 0.03);
    box("timber", 0.06, 1.95, 0.08, doorX, FH + 0.98, d / 2 + 0.06); // the meeting stile
  }
  const noren = new THREE.PlaneGeometry(1.4, 0.6, 3, 1);
  add("noren", noren, doorX, FH + 1.75, d / 2 + 0.12);
  // Shoji windows sit in the plaster band; the glow material is theirs alone.
  const shojiAt: Array<{ x: number; z: number; ry: number }> = [];
  for (const sx of [doorX - 1.9, doorX + 1.9]) if (Math.abs(sx) < w / 2 - 0.8) shojiAt.push({ x: sx, z: d / 2 + 0.02, ry: 0 });
  shojiAt.push({ x: w / 2 + 0.02, z: 0, ry: Math.PI / 2 }, { x: -w / 2 - 0.02, z: 0.4, ry: -Math.PI / 2 });
  for (const s of shojiAt) {
    const g = new THREE.PlaneGeometry(1.2, 0.95);
    add("glow", g, s.x, FH + SK + 0.75, s.z, s.ry);
    // A slim timber frame around each window.
    box("timber", 1.32, 0.07, 0.06, s.x, FH + SK + 0.75 + 0.5, s.z, s.ry);
    box("timber", 1.32, 0.07, 0.06, s.x, FH + SK + 0.75 - 0.5, s.z, s.ry);
  }

  // Veranda: a deck along the front on short legs, a step stone at the door.
  box("timber", w + 0.3, 0.07, 0.9, 0, FH - 0.05, d / 2 + 0.5);
  for (const lx of [-w / 2, 0, w / 2]) box("timber", 0.1, FH - 0.05, 0.1, lx, (FH - 0.05) / 2, d / 2 + 0.9);
  box("stone", 0.9, 0.18, 0.5, doorX, 0.09, d / 2 + 1.25);

  // Roof.
  const ov = roof === "thatch" ? 1.05 : 0.95;
  const W = w + ov * 2, D = d + ov * 2;
  const H = roof === "thatch" ? 3.1 : 2.1;
  const T = roof === "thatch" ? 0.42 : 0.14;
  const roofY = FH + WH + 0.12 + T * 0.6;
  add(roof, hipRoof(W, D, H, T, TILE[roof], 0), 0, roofY, 0);
  const ridgeLen = Math.max(0.4, W - D) + (roof === "thatch" ? 1.0 : 0.6);
  if (roof === "thatch") {
    // A dark bundled ridge cap with cross pieces, as on a kayabuki roof.
    const cap = new THREE.CylinderGeometry(0.32, 0.32, ridgeLen, 10, 1);
    cap.rotateZ(Math.PI / 2);
    add("ridge", cap, 0, roofY + H - 0.05, 0);
    const n = Math.max(3, Math.round(ridgeLen / 0.7));
    for (let i = 0; i < n; i++) {
      const x = -ridgeLen / 2 + 0.3 + (i / (n - 1)) * (ridgeLen - 0.6);
      box("dark", 0.12, 0.5, 0.9, x, roofY + H + 0.12, 0);
    }
  } else {
    box("tiles", ridgeLen, 0.34, 0.42, 0, roofY + H + 0.1, 0);
    box("dark", 0.36, 0.56, 0.5, ridgeLen / 2, roofY + H + 0.18, 0);
    box("dark", 0.36, 0.56, 0.5, -ridgeLen / 2, roofY + H + 0.18, 0);
  }

  // A few things people leave outside: a woodpile, a rain barrel.
  if (r() < 0.7) {
    const logs = new THREE.CylinderGeometry(0.1, 0.1, 1.1, 7, 1);
    logs.rotateZ(Math.PI / 2);
    for (let row = 0; row < 3; row++) {
      for (let k = 0; k < 4 - row; k++) {
        add("timber", logs.clone(), -w / 2 - 0.5, 0.12 + row * 0.19, -d / 2 + 0.6 + k * 0.21 + row * 0.1, Math.PI / 2);
      }
    }
    logs.dispose();
  }
  if (r() < 0.6) {
    const barrel = new THREE.CylinderGeometry(0.3, 0.27, 0.7, 12, 1);
    add("timber", barrel, w / 2 + 0.45, 0.35, d / 2 - 0.3);
  }

  // Merge each material's pieces into one mesh.
  const group = new THREE.Group();
  const glow = surfaceMaterial("shoji", { emissive: new THREE.Color("#ffb866"), emissiveIntensity: 0, roughness: 0.9, bumpScale: 0.3, side: THREE.DoubleSide });
  glow.emissiveMap = glow.map;
  const merged: THREE.BufferGeometry[] = [];
  for (const [key, list] of parts) {
    for (const g of list) if (!g.attributes.normal) g.computeVertexNormals();
    const g = mergeGeometries(list, false);
    for (const p of list) p.dispose();
    if (!g) continue;
    merged.push(g);
    const m = new THREE.Mesh(g, key === "glow" ? glow : mat(key as Exclude<MatKey, "glow">));
    m.castShadow = key !== "glow" && key !== "noren";
    m.receiveShadow = true;
    m.name = `minka-${key}`;
    group.add(m);
  }

  const wx = w / 2, wz = d / 2;
  return {
    group,
    glow,
    lampAt: new THREE.Vector3(doorX, FH + 1.9, d / 2 + 0.9),
    half: [w / 2 + 0.3, d / 2 + 0.3],
    walls: open ? [[-wx, -wz, wx, -wz], [-wx, -wz, -wx, wz], [wx, -wz, wx, wz], [-wx, wz, g0, wz], [g1, wz, wx, wz]] : undefined,
    room: open ? { FH, WH, w, d, doorX, ceiling: roofY - T } : undefined,
    dispose() {
      for (const g of merged) g.dispose();
      glow.dispose();
    },
  };
}
