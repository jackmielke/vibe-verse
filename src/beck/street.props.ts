/**
 * The things that stand at the edge of a Bainbridge road, as geometry: rural
 * mailboxes, garbage carts, a boat on its trailer, a basketball hoop, the
 * hardware on a power pole. Every prop is a few primitives merged into one
 * vertex-coloured geometry per material class, so each kind of thing is one
 * instanced draw call however many of it there are.
 *
 * Local frames: y up, origin on the ground under the prop, +z the way it
 * faces (a mailbox door, a boat's bow, the open side of a shelter).
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export interface Prop {
  /** Vertex-coloured, matte. */
  fixed?: THREE.BufferGeometry;
  /** White vertices, coloured per instance. */
  tinted?: THREE.BufferGeometry;
  /** Vertex-coloured, galvanised. */
  metal?: THREE.BufferGeometry;
  /** Vertex-coloured, see-through (nets, wire mesh). */
  sheer?: THREE.BufferGeometry;
}

export interface PropMaterials {
  fixed: THREE.Material;
  tinted: THREE.Material;
  metal: THREE.Material;
  sheer: THREE.Material;
}

/** A primitive with a colour and a transform, ready to merge. Scale, then rotate x/y/z, then translate. */
function part(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  if (sx !== 1 || sy !== 1 || sz !== 1) g.scale(sx, sy, sz);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  if (x || y || z) g.translate(x, y, z);
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  // Only position, normal, uv and colour travel: merging needs every geometry to agree.
  for (const name of Object.keys(g.attributes)) if (!["position", "normal", "uv", "color"].includes(name)) g.deleteAttribute(name);
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const m = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  if (!m) throw new Error("street prop failed to merge");
  return m;
}

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt: number, rb: number, h: number, seg = 10, open = false) => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);

// ---- Materials ----------------------------------------------------------------

export function propMaterials(): PropMaterials {
  return {
    fixed: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }),
    tinted: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.05 }),
    metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.65 }),
    sheer: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false }),
  };
}

// ---- Instancing ---------------------------------------------------------------

const _pos = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/** A placement matrix: on the ground at x,y,z, turned `yaw` about y, optionally scaled. */
export function pose(x: number, y: number, z: number, yaw: number, sx = 1, sy = sx, sz = sx): THREE.Matrix4 {
  _pos.set(x, y, z);
  _q.setFromAxisAngle(_up, yaw);
  _s.set(sx, sy, sz);
  return new THREE.Matrix4().compose(_pos, _q, _s);
}

export class Batch {
  private items = new Map<Prop, { m: THREE.Matrix4[]; c: THREE.Color[] }>();
  private meshes: THREE.InstancedMesh[] = [];
  constructor(private mats: PropMaterials) {}

  add(prop: Prop, matrix: THREE.Matrix4, tint: THREE.ColorRepresentation = 0xffffff): void {
    let e = this.items.get(prop);
    if (!e) {
      e = { m: [], c: [] };
      this.items.set(prop, e);
    }
    e.m.push(matrix);
    e.c.push(new THREE.Color(tint));
  }

  build(group: THREE.Group): void {
    for (const [prop, e] of this.items) {
      const n = e.m.length;
      if (!n) continue;
      const parts: [THREE.BufferGeometry | undefined, THREE.Material, boolean][] = [
        [prop.fixed, this.mats.fixed, true],
        [prop.tinted, this.mats.tinted, true],
        [prop.metal, this.mats.metal, true],
        [prop.sheer, this.mats.sheer, false],
      ];
      for (const [geo, mat, shadow] of parts) {
        if (!geo) continue;
        const mesh = new THREE.InstancedMesh(geo, mat, n);
        for (let i = 0; i < n; i++) {
          mesh.setMatrixAt(i, e.m[i]);
          if (geo === prop.tinted) mesh.setColorAt(i, e.c[i]);
        }
        mesh.castShadow = shadow;
        mesh.receiveShadow = shadow;
        mesh.frustumCulled = false;
        group.add(mesh);
        this.meshes.push(mesh);
      }
    }
  }

  dispose(): void {
    for (const m of this.meshes) m.dispose();
    for (const prop of this.items.keys()) {
      prop.fixed?.dispose();
      prop.tinted?.dispose();
      prop.metal?.dispose();
      prop.sheer?.dispose();
    }
  }
}

// ---- Mailbox -----------------------------------------------------------------

const POST = 0x6e5a44;
const CEDAR = 0x8f7f6a;

/** 4x4 cedar post with a plank on top and a brace, the box overhanging toward the road (+z). */
export function mailboxMount(): Prop {
  return {
    fixed: merge([
      part(box(0.09, 1.02, 0.09), POST, 0, 0.51, 0),
      part(box(0.15, 0.035, 0.56), POST, 0, 1.037, 0.1),
      part(box(0.04, 0.04, 0.34), POST, 0, 0.88, 0.17, -Math.PI / 4),
    ]),
  };
}

/** The curved-top steel box itself, sitting on the plank, door toward +z. Coloured per instance. */
export function mailboxBody(): Prop {
  const s = new THREE.Shape();
  s.moveTo(-0.085, 0);
  s.lineTo(0.085, 0);
  s.lineTo(0.085, 0.11);
  s.absarc(0, 0.11, 0.085, 0, Math.PI, false);
  s.lineTo(-0.085, 0);
  const body = new THREE.ExtrudeGeometry(s, { depth: 0.5, bevelEnabled: false });
  body.translate(0, 0, -0.25);
  const door = new THREE.ExtrudeGeometry(s, { depth: 0.02, bevelEnabled: false });
  door.scale(1.06, 1.06, 1);
  door.translate(0, 0, 0.245);
  const y = 1.055;
  return {
    tinted: merge([part(body, 0xffffff, 0, y, 0), part(door, 0xffffff, 0, y, 0), part(box(0.04, 0.03, 0.02), 0xffffff, 0, y + 0.03, 0.275)]),
  };
}

/** The red carrier flag on the right-hand side, down or raised. */
export function mailboxFlag(up: boolean): Prop {
  const RED = 0xc4231b;
  const px = 0.1;
  const py = 1.13;
  const pz = 0.12;
  return {
    fixed: merge([
      part(cyl(0.018, 0.018, 0.02, 8), RED, px, py, pz, 0, 0, Math.PI / 2),
      up ? part(box(0.014, 0.22, 0.045), RED, px + 0.005, py + 0.11, pz) : part(box(0.014, 0.045, 0.22), RED, px + 0.005, py, pz - 0.1),
    ]),
  };
}

/** A newspaper tube under the box. */
export function paperTube(): Prop {
  return {
    fixed: merge([part(cyl(0.065, 0.065, 0.42, 10), 0xd9d6cc, 0, 0.8, 0.09, Math.PI / 2), part(box(0.04, 0.12, 0.04), 0x8a8a84, 0, 0.9, 0.0)]),
  };
}

// ---- Yard and driveway clutter ------------------------------------------------

/** Wheeled cart, Bainbridge Disposal style. Body coloured per instance; wheels and handle black. */
export function cart(): Prop {
  const body = box(0.6, 0.9, 0.64);
  body.translate(0, 0.5, 0);
  return {
    tinted: merge([part(body, 0xffffff), part(box(0.64, 0.07, 0.7), 0xffffff, 0, 0.985, 0.02)]),
    fixed: merge([
      part(cyl(0.12, 0.12, 0.05, 10), 0x111111, -0.28, 0.12, -0.3, 0, 0, Math.PI / 2),
      part(cyl(0.12, 0.12, 0.05, 10), 0x111111, 0.28, 0.12, -0.3, 0, 0, Math.PI / 2),
      part(cyl(0.015, 0.015, 0.52, 6), 0x111111, 0, 1.06, -0.33, 0, 0, Math.PI / 2),
    ]),
  };
}

/** A 16 ft aluminium skiff with an outboard, on a galvanised trailer. Bow toward +z. */
export function boatOnTrailer(): Prop {
  const s = new THREE.Shape();
  const pts: [number, number][] = [
    [0.75, 2.3],
    [0.85, 0.6],
    [0.72, -1.3],
    [0.25, -2.35],
    [0, -2.5],
    [-0.25, -2.35],
    [-0.72, -1.3],
    [-0.85, 0.6],
    [-0.75, 2.3],
  ];
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  s.closePath();
  const hull = new THREE.ExtrudeGeometry(s, { depth: 0.72, bevelEnabled: false });
  const gunwale = new THREE.ExtrudeGeometry(s, { depth: 0.05, bevelEnabled: false });
  gunwale.scale(1.03, 1.03, 1);
  const HULL = 0xe4e6e2;
  const NAVY = 0x1e3d6b;
  const GALV = 0xa9aeb2;
  return {
    fixed: merge([
      part(hull, HULL, 0, 0.55, 0, -Math.PI / 2),
      part(gunwale, NAVY, 0, 1.27, 0, -Math.PI / 2),
      part(box(1.2, 0.05, 3.8), 0x6f7378, 0, 1.05, 0.1),
      part(box(1.3, 0.28, 0.32), 0x9a9ea2, 0, 1.2, -1.6),
      part(box(1.3, 0.28, 0.32), 0x9a9ea2, 0, 1.2, 0.2),
      part(box(0.55, 0.35, 0.3), 0xd8dad6, 0.25, 1.4, 0.9),
      part(box(0.9, 0.3, 0.02), 0xb9c9d6, 0, 1.55, 1.05, -0.35),
      part(box(0.34, 0.42, 0.3), 0x161616, 0, 1.45, -2.5),
      part(box(0.1, 0.7, 0.14), 0x2a2a2a, 0, 0.7, -2.55),
      part(cyl(0.32, 0.32, 0.2, 12), 0x141414, -0.98, 0.32, -0.6, 0, 0, Math.PI / 2),
      part(cyl(0.32, 0.32, 0.2, 12), 0x141414, 0.98, 0.32, -0.6, 0, 0, Math.PI / 2),
      part(cyl(0.11, 0.11, 0.22, 10), 0xc8ccd0, -0.98, 0.32, -0.6, 0, 0, Math.PI / 2),
      part(cyl(0.11, 0.11, 0.22, 10), 0xc8ccd0, 0.98, 0.32, -0.6, 0, 0, Math.PI / 2),
      part(box(0.1, 0.06, 2.4), 0x3a3a3a, -0.42, 0.52, -0.2),
      part(box(0.1, 0.06, 2.4), 0x3a3a3a, 0.42, 0.52, -0.2),
    ]),
    metal: merge([
      part(box(0.06, 0.09, 4.6), GALV, -0.55, 0.44, 0.1),
      part(box(0.06, 0.09, 4.6), GALV, 0.55, 0.44, 0.1),
      part(box(1.2, 0.06, 0.06), GALV, 0, 0.44, -1.4),
      part(box(1.2, 0.06, 0.06), GALV, 0, 0.44, 1.2),
      part(box(0.08, 0.08, 1.8), GALV, 0, 0.44, 3.2),
      part(box(0.06, 0.65, 0.06), GALV, 0, 0.78, 2.7),
      part(cyl(0.03, 0.03, 2.0, 6), GALV, 0, 0.34, -0.6, 0, 0, Math.PI / 2),
      part(box(0.3, 0.05, 0.9), GALV, -0.98, 0.7, -0.6),
      part(box(0.3, 0.05, 0.9), GALV, 0.98, 0.7, -0.6),
      part(cyl(0.02, 0.02, 0.5, 6), GALV, 0, 0.25, 3.6),
    ]),
  };
}

/** Portable basketball hoop, backboard facing +z. */
export function hoop(): Prop {
  return {
    fixed: merge([
      part(box(1.1, 0.3, 0.75), 0x1b1b1b, 0, 0.15, -0.35),
      part(cyl(0.05, 0.05, 2.9, 8), 0x1b1b1b, 0, 1.75, -0.55),
      part(box(0.06, 0.06, 0.8), 0x1b1b1b, 0, 3.2, -0.2, -0.6),
      part(box(1.1, 0.75, 0.03), 0xdde3e8, 0, 3.35, 0.18),
      part(box(0.02, 0.02, 0.02), 0xdde3e8, 0, 3.0, 0.2),
      part(new THREE.TorusGeometry(0.23, 0.012, 6, 16), 0xe2521d, 0, 3.05, 0.42, Math.PI / 2),
    ]),
    sheer: merge([part(cyl(0.23, 0.15, 0.42, 10, true), 0xf0f0f0, 0, 2.84, 0.42)]),
  };
}

/** Contractor's wheelbarrow, wheel toward +z. */
export function wheelbarrow(colour: THREE.ColorRepresentation): Prop {
  const tray = cyl(0.36, 0.25, 0.28, 4);
  tray.rotateY(Math.PI / 4);
  tray.scale(1.5, 1, 1);
  return {
    fixed: merge([
      part(tray, colour, 0, 0.44, 0.05),
      part(box(0.04, 0.04, 1.5), 0x8a7a62, -0.28, 0.42, -0.35, 0.18),
      part(box(0.04, 0.04, 1.5), 0x8a7a62, 0.28, 0.42, -0.35, 0.18),
      part(box(0.04, 0.4, 0.04), 0x2a2a2a, -0.25, 0.2, -0.5),
      part(box(0.04, 0.4, 0.04), 0x2a2a2a, 0.25, 0.2, -0.5),
      part(cyl(0.18, 0.18, 0.08, 10), 0x111111, 0, 0.18, 0.55, 0, 0, Math.PI / 2),
    ]),
  };
}

/** Backyard trampoline with a safety net. */
export function trampoline(): Prop {
  const parts: THREE.BufferGeometry[] = [];
  const mat = new THREE.CircleGeometry(1.85, 28);
  parts.push(part(mat, 0x141414, 0, 0.85, 0, -Math.PI / 2));
  parts.push(part(new THREE.TorusGeometry(1.92, 0.1, 6, 28), 0x2a5fb0, 0, 0.86, 0, Math.PI / 2));
  const poles: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const x = Math.cos(a) * 1.85;
    const z = Math.sin(a) * 1.85;
    parts.push(part(box(0.04, 0.84, 0.04), 0x8a8f94, x, 0.42, z));
    parts.push(part(box(0.04, 0.04, 0.9), 0x8a8f94, x, 0.02, z, 0, -a));
    poles.push(part(cyl(0.02, 0.02, 1.95, 6), 0x1b1b1b, Math.cos(a) * 2.02, 1.82, Math.sin(a) * 2.02));
    poles.push(part(cyl(0.045, 0.045, 1.2, 6), 0x2a5fb0, Math.cos(a) * 2.02, 1.7, Math.sin(a) * 2.02));
  }
  return {
    fixed: merge([...parts, ...poles]),
    sheer: merge([part(cyl(2.0, 2.0, 1.85, 28, true), 0x202020, 0, 1.78, 0)]),
  };
}

/** Fire hydrant. */
export function hydrant(): Prop {
  const RED = 0xc0301c;
  const CAP = 0xbfc3c6;
  return {
    fixed: merge([
      part(cyl(0.17, 0.17, 0.06, 12), RED, 0, 0.03, 0),
      part(cyl(0.12, 0.14, 0.62, 12), RED, 0, 0.37, 0),
      part(cyl(0.03, 0.15, 0.16, 12), RED, 0, 0.76, 0),
      part(cyl(0.03, 0.03, 0.05, 6), CAP, 0, 0.86, 0),
      part(cyl(0.06, 0.06, 0.12, 10), CAP, -0.15, 0.42, 0, 0, 0, Math.PI / 2),
      part(cyl(0.06, 0.06, 0.12, 10), CAP, 0.15, 0.42, 0, 0, 0, Math.PI / 2),
      part(cyl(0.075, 0.075, 0.14, 10), CAP, 0, 0.4, 0.15, Math.PI / 2),
    ]),
  };
}

/** Residential propane tank on legs, long axis along x. */
export function propaneTank(): Prop {
  const WHITE = 0xe6e6e1;
  return {
    fixed: merge([
      part(cyl(0.38, 0.38, 1.4, 16), WHITE, 0, 0.66, 0, 0, 0, Math.PI / 2),
      part(new THREE.SphereGeometry(0.38, 16, 10), WHITE, -0.7, 0.66, 0, 0, 0, 0, 0.5, 1, 1),
      part(new THREE.SphereGeometry(0.38, 16, 10), WHITE, 0.7, 0.66, 0, 0, 0, 0, 0.5, 1, 1),
      part(box(0.05, 0.4, 0.6), 0x5a5a5a, -0.45, 0.2, 0),
      part(box(0.05, 0.4, 0.6), 0x5a5a5a, 0.45, 0.2, 0),
      part(cyl(0.12, 0.12, 0.12, 10), 0x8a8a84, 0, 1.08, 0),
    ]),
  };
}

/** Pad-mounted transformer, the green cabinet. */
export function padTransformer(): Prop {
  return {
    fixed: merge([part(box(1.5, 0.1, 1.2), 0xb5b2aa, 0, 0.05, 0), part(box(1.2, 0.95, 0.9), 0x2f5b3a, 0, 0.57, 0), part(box(1.22, 0.04, 0.92), 0x27492f, 0, 1.06, 0)]),
  };
}

/** Recycling and garbage dumpster. */
export function dumpster(): Prop {
  return {
    fixed: merge([part(box(1.8, 1.25, 1.2), 0x2c5e3a, 0, 0.72, 0), part(box(1.84, 0.08, 1.24), 0x151515, 0, 1.38, 0)]),
  };
}

// ---- Power ----------------------------------------------------------------------

/** Weathered pole wood: grey-brown with vertical checking. */
export function poleTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 512;
  const g = c.getContext("2d")!;
  g.fillStyle = "#6a5a4a";
  g.fillRect(0, 0, 128, 512);
  let seed = 7;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 260; i++) {
    const x = r() * 128;
    const w = 1 + r() * 3;
    const l = 30 + r() * 200;
    const y = r() * 512;
    const k = r();
    g.fillStyle = k < 0.5 ? `rgba(40,30,22,${0.25 + r() * 0.35})` : `rgba(130,118,100,${0.2 + r() * 0.3})`;
    g.fillRect(x, y, w, l);
  }
  // Creosote darkening low down, silvering high up.
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, "rgba(150,145,135,0.35)");
  grad.addColorStop(0.7, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(20,15,10,0.45)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

export const POLE_H = 10.4;
export const ARM_Y = 9.55;
export const PIN_Y = POLE_H + 0.22;
export const NEUTRAL_Y = 8.4;
export const TELECOM_Y = 6.9;
export const DROP_Y = 7.6;
export const ARM_HALF = 1.0;

/** Tapered pole, base at the origin. Its own textured material. */
export function poleGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.13, 0.19, POLE_H, 9);
  g.translate(0, POLE_H / 2, 0);
  return g;
}

/** Crossarm with braces, two pin insulators and the pole-top pin. Arm along x, origin on the pole axis at the arm. */
export function crossarm(): Prop {
  const ARM = 0x5e4e3e;
  const INS = 0xd9d7cc;
  const ins = (x: number, y: number) => [part(cyl(0.012, 0.012, 0.14, 6), 0x777, x, y + 0.07, 0), part(cyl(0.05, 0.055, 0.07, 8), INS, x, y + 0.12, 0), part(cyl(0.04, 0.05, 0.07, 8), INS, x, y + 0.19, 0)];
  return {
    fixed: merge([
      part(box(2.4, 0.1, 0.12), ARM, 0, 0, 0),
      part(box(0.035, 1.1, 0.035), 0x8a8f94, 0.375, -0.42, 0.08, 0, 0, -0.75),
      part(box(0.035, 1.1, 0.035), 0x8a8f94, -0.375, -0.42, 0.08, 0, 0, 0.75),
      ...ins(-ARM_HALF, 0.05),
      ...ins(ARM_HALF, 0.05),
      ...ins(0, POLE_H - ARM_Y - 0.15),
      // Neutral spool below the arm, telecom bracket lower still.
      part(cyl(0.05, 0.05, 0.08, 8), INS, 0.22, NEUTRAL_Y - ARM_Y, 0, Math.PI / 2),
      part(box(0.06, 0.04, 0.2), 0x2a2a2a, 0.12, TELECOM_Y - ARM_Y, 0),
    ]),
  };
}

/** Transformer can hung on the +x side of the pole; origin on the pole axis at the can's centre. */
export function transformerCan(): Prop {
  return {
    fixed: merge([
      part(cyl(0.3, 0.3, 0.9, 14), 0x8f9494, 0.46, 0, 0),
      part(cyl(0.31, 0.31, 0.06, 14), 0x6f7474, 0.46, 0.46, 0),
      part(cyl(0.045, 0.05, 0.22, 8), 0x8a5a3a, 0.4, 0.58, 0),
      part(box(0.1, 0.5, 0.36), 0x8a8f94, 0.2, 0, 0),
    ]),
  };
}

/** Guy anchor: a short rod at the ground end of a guy wire. */
export function guyAnchor(): Prop {
  return { fixed: merge([part(cyl(0.02, 0.02, 0.8, 6), 0x8a8f94, 0, 0.3, 0, 0.5), part(box(0.1, 0.03, 0.1), 0x8a8f94, 0, 0.02, 0)]) };
}

// ---- Signs and posts -------------------------------------------------------------

/** Unit-height u-channel sign post; scale y to the height wanted. */
export function signPost(): Prop {
  return { metal: merge([part(box(0.06, 1, 0.035), 0x9aa39b, 0, 0.5, 0)]) };
}

/** Unit fence post, 4x4 to 6x6, scaled to height. */
export function fencePost(colour: THREE.ColorRepresentation = CEDAR): Prop {
  return { fixed: merge([part(box(0.12, 1, 0.12), colour, 0, 0.5, 0)]) };
}

/** Unit-length rail along z, scaled to span. */
export function rail(colour: THREE.ColorRepresentation = CEDAR): Prop {
  return { fixed: merge([part(box(0.06, 0.13, 1), colour, 0, 0, 0.5)]) };
}

/** Unit cube for hedges: scaled per segment. */
export function hedgeBlock(): Prop {
  return { fixed: merge([part(box(1, 1, 1), 0x3a6229, 0, 0.5, 0)]) };
}

/** Steel T-post for field fence. */
export function tPost(): Prop {
  return { fixed: merge([part(box(0.04, 1.5, 0.04), 0x3e3f38, 0, 0.75, 0)]) };
}

/** Unit-length field-fence mesh panel along z, 1.2 m high; scaled in z. */
export function fieldMesh(): Prop {
  const g = new THREE.PlaneGeometry(1, 1.2);
  g.rotateY(Math.PI / 2);
  g.translate(0, 0.6, 0.5);
  return { sheer: merge([part(g, 0x4a4b45)]) };
}

/** Galvanised tube farm gate, 3.6 m wide along x, hinge posts included. */
export function farmGate(): Prop {
  const GALV = 0xa9aeb2;
  const bars: THREE.BufferGeometry[] = [];
  for (const y of [0.25, 0.5, 0.75, 1.0, 1.25]) bars.push(part(cyl(0.02, 0.02, 3.6, 6), GALV, 0, y, 0, 0, 0, Math.PI / 2));
  bars.push(part(cyl(0.025, 0.025, 1.1, 6), GALV, -1.78, 0.75, 0));
  bars.push(part(cyl(0.025, 0.025, 1.1, 6), GALV, 1.78, 0.75, 0));
  bars.push(part(cyl(0.025, 0.025, 1.1, 6), GALV, 0, 0.75, 0));
  bars.push(part(cyl(0.015, 0.015, 3.7, 6), GALV, 0, 0.75, 0, 0, 0, Math.PI / 2 - 0.27));
  return {
    metal: merge(bars),
    fixed: merge([part(box(0.15, 1.5, 0.15), POST, -1.92, 0.75, 0), part(box(0.15, 1.5, 0.15), POST, 1.92, 0.75, 0)]),
  };
}

/** Wooden driveway gate: two posts, a frame of cedar rails, a diagonal. Along x. */
export function woodGate(): Prop {
  const C = 0x9a8a72;
  return {
    fixed: merge([
      part(box(0.15, 1.5, 0.15), POST, -1.95, 0.75, 0),
      part(box(0.15, 1.5, 0.15), POST, 1.95, 0.75, 0),
      part(box(3.7, 0.12, 0.05), C, 0, 1.25, 0),
      part(box(3.7, 0.12, 0.05), C, 0, 0.85, 0),
      part(box(3.7, 0.12, 0.05), C, 0, 0.45, 0),
      part(box(0.12, 1.1, 0.05), C, -1.75, 0.85, 0),
      part(box(0.12, 1.1, 0.05), C, 1.75, 0.85, 0),
      part(box(0.1, 3.7, 0.04), C, 0, 0.85, 0.03, 0, 0, Math.PI / 2 - 0.29),
    ]),
  };
}

// ---- Public places ---------------------------------------------------------------

/** Park bench, seat facing +z. */
export function bench(): Prop {
  const W = 0x7a6a52;
  const IRON = 0x2b2b2b;
  return {
    fixed: merge([
      part(box(0.06, 0.45, 0.48), IRON, -0.8, 0.225, 0),
      part(box(0.06, 0.45, 0.48), IRON, 0.8, 0.225, 0),
      part(box(0.06, 0.5, 0.05), IRON, -0.8, 0.7, -0.22, -0.15),
      part(box(0.06, 0.5, 0.05), IRON, 0.8, 0.7, -0.22, -0.15),
      part(box(1.8, 0.04, 0.12), W, 0, 0.46, -0.14),
      part(box(1.8, 0.04, 0.12), W, 0, 0.46, 0.0),
      part(box(1.8, 0.04, 0.12), W, 0, 0.46, 0.14),
      part(box(1.8, 0.1, 0.04), W, 0, 0.66, -0.22, -0.15),
      part(box(1.8, 0.1, 0.04), W, 0, 0.82, -0.245, -0.15),
    ]),
  };
}

/** A driftwood log to sit on, along x. */
export function logBench(len = 3.6): Prop {
  return {
    fixed: merge([part(cyl(0.27, 0.33, len, 12), 0xa8a094, 0, 0.3, 0, 0, 0, Math.PI / 2), part(box(len * 0.85, 0.06, 0.28), 0xbdb6a9, 0, 0.58, 0)]),
  };
}

/** Wooden bus shelter, open toward +z. */
export function busShelter(): Prop {
  const SH = 0x4a4642;
  return {
    fixed: merge([
      part(box(0.12, 2.3, 0.12), POST, -1.4, 1.15, 0.9),
      part(box(0.12, 2.3, 0.12), POST, 1.4, 1.15, 0.9),
      part(box(0.12, 2.3, 0.12), POST, -1.4, 1.15, -0.9),
      part(box(0.12, 2.3, 0.12), POST, 1.4, 1.15, -0.9),
      part(box(3.0, 2.1, 0.05), CEDAR, 0, 1.15, -0.92),
      part(box(0.05, 2.1, 1.85), CEDAR, -1.45, 1.15, 0),
      part(box(0.05, 2.1, 1.85), CEDAR, 1.45, 1.15, 0),
      part(box(3.3, 0.06, 1.3), SH, 0, 2.65, -0.55, -0.42),
      part(box(3.3, 0.06, 1.3), SH, 0, 2.65, 0.55, 0.42),
      part(box(3.3, 0.08, 0.1), SH, 0, 2.92, 0),
      part(box(2.6, 0.05, 0.4), CEDAR, 0, 0.48, -0.55),
      part(box(0.1, 0.46, 0.35), POST, -1.1, 0.23, -0.55),
      part(box(0.1, 0.46, 0.35), POST, 1.1, 0.23, -0.55),
    ]),
  };
}

/** Post-and-panel board, panel facing +z; the printed face is added separately. */
export function boardPosts(): Prop {
  return { fixed: merge([part(box(0.12, 2.0, 0.12), 0x4e3a26, -0.7, 1.0, 0), part(box(0.12, 2.0, 0.12), 0x4e3a26, 0.7, 1.0, 0)]) };
}

/** A 9 m white flagpole with a ball finial; the flag itself is printed and hung by the caller. */
export function flagpole(): Prop {
  return {
    fixed: merge([part(cyl(0.04, 0.07, 9, 8), 0xe9e9e6, 0, 4.5, 0), part(new THREE.SphereGeometry(0.1, 8, 6), 0xd9b64a, 0, 9.05, 0), part(cyl(0.3, 0.3, 0.3, 10), 0xb5b2aa, 0, 0.15, 0)]),
  };
}

/** Street lamp, head toward +z. */
export function lampPost(): Prop {
  return {
    fixed: merge([
      part(cyl(0.06, 0.09, 6, 8), 0x5a5e62, 0, 3, 0),
      part(box(0.06, 0.06, 1.2), 0x5a5e62, 0, 5.9, 0.55),
      part(box(0.5, 0.15, 0.3), 0x3a3d40, 0, 5.85, 1.15),
      part(box(0.4, 0.02, 0.2), 0xfff2cc, 0, 5.77, 1.15),
    ]),
  };
}

export function bollard(): Prop {
  return { fixed: merge([part(cyl(0.08, 0.08, 0.9, 8), 0x6e5a44, 0, 0.45, 0), part(cyl(0.083, 0.083, 0.06, 8), 0xe8e8e0, 0, 0.8, 0)]) };
}

/** Monopole cell tower with a triangular antenna array. */
export function cellTower(): Prop {
  const parts = [part(cyl(0.32, 0.62, 36, 12), 0xa2a7ab, 0, 18, 0), part(new THREE.TorusGeometry(1.7, 0.05, 6, 18), 0xa2a7ab, 0, 34.2, 0, Math.PI / 2)];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    parts.push(part(box(0.3, 2.4, 0.1), 0xe4e4e0, Math.cos(a) * 1.8, 34.5, Math.sin(a) * 1.8, 0, -a));
    parts.push(part(box(0.3, 2.4, 0.1), 0xe4e4e0, Math.cos(a + 0.35) * 1.8, 34.5, Math.sin(a + 0.35) * 1.8, 0, -a - 0.35));
  }
  return { fixed: merge(parts) };
}

/** Silvered cedar boards, 1.2 m of fence per repeat, for the board-fence panels. */
export function boardTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const g = c.getContext("2d")!;
  let seed = 3;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 8; i++) {
    const t = 140 + r() * 40;
    g.fillStyle = `rgb(${t + 8},${t - 4},${t - 22})`;
    g.fillRect(i * 32, 0, 30, 256);
    g.fillStyle = "rgba(30,24,18,0.8)";
    g.fillRect(i * 32 + 30, 0, 2, 256);
    for (let k = 0; k < 12; k++) {
      g.fillStyle = `rgba(60,50,40,${0.08 + r() * 0.12})`;
      g.fillRect(i * 32 + r() * 28, 0, 1 + r() * 2, 256);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}
