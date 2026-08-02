import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { bus } from "../core/EventBus";
import type { GameModule, ModuleContext } from "../ModuleTypes";
import type { QualityProfile } from "../core/Settings";
import { WEAPONS, type WeaponDef } from "../systems/Weapons";
import { atmosphere } from "../world/Sky";
import type { Rng } from "../core/Assets";

/**
 * First-person viewmodel: the gun in your hands.
 *
 * ── how it gets on screen ──────────────────────────────────────────────────
 * The weapon lives in its own scene with its own camera, so it is completely
 * immune to the main camera's ADS zoom (the sniper pulls the world FOV to 14°;
 * a camera-parented weapon would fill the screen). That scene is drawn into the
 * *same* render target as the world, from `scene.onAfterRender`, which is the
 * only hook a module gets into Engine's composer chain.
 *
 * It must never clip through geometry, and it must never destroy the world's
 * depth buffer either — Engine's aerial-perspective and god-ray passes read
 * that depth back. So instead of a depth clear, the viewmodel camera's
 * projection is post-multiplied to squash its whole depth range into the
 * nearest 2% of the buffer. Nothing in the world can be closer than 8 cm, so
 * the weapon always wins the depth test, its own parts still self-occlude
 * correctly, and the pixels it covers read back as ~8 cm away — i.e. with no
 * aerial perspective and correctly blocking god rays.
 *
 * The same hook also draws the weapon into GTAO's depth/normal prepasses. If it
 * did not, the occlusion computed from the *world* geometry hiding behind the
 * gun would be multiplied straight onto the gun's pixels — grass tufts and
 * crate silhouettes smeared across the receiver. GTAO's own thickness
 * heuristic (|Δz| < 1 m) then keeps the 8 cm-deep weapon from casting occlusion
 * onto the 20 m-deep world, so there is no halo either. See the note above
 * `drawViewmodel` for the proper fix, which needs an Engine-side pass slot.
 *
 * ── colour ────────────────────────────────────────────────────────────────
 * Scene-linear, same anchors as Sky.ts. The sun is the same
 * DirectionalLight(0xfff4e2, 3.35) the world uses, rotated into view space so
 * the weapon relights as you turn; 0.18 albedo facing it lands at
 * 0.18 * 3.35 / PI ≈ 0.19. Ambient is a PMREM probe built from Sky's own
 * single-scattering model for the current sun elevation, so when the sky
 * changes the gun changes with it. There are no invented key lights: the only
 * other source is a 0.4 rim, which is there to draw an edge, not to add
 * exposure.
 */

// ─────────────────────────────────────────────────────────────── utilities ──

const lin = (r: number, g: number, b: number): THREE.Color =>
  new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);

const sat = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const seg = (t: number, a: number, b: number): number => sat((t - a) / (b - a));
const smooth = (x: number): number => x * x * (3 - 2 * x);
/** 0 → 1 → 0 over [a,b], peaking at the midpoint. */
const hump = (t: number, a: number, b: number): number => Math.sin(Math.PI * seg(t, a, b));

/** Shortest signed difference between two angles. */
function angleDelta(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// ─────────────────────────────────────────────────────────── part builder ──

type MatKey = "poly" | "steel" | "dark" | "trim" | "glass" | "glow" | "shell" | "armor" | "glove";

/** One wear-map tile covers 35 cm of surface, whatever part it lands on. */
const UV_PER_METRE = 2.85;

/**
 * Box with every edge cut back by `c`. Chamfers are the cheapest thing in a
 * gun's look: a 2 mm cut turns the boundary between two faces from a flat
 * value change into a bright line the sun runs along, which is most of what
 * separates a shipped asset from a grey box. Built non-indexed so the faces
 * stay flat and the bevels stay crisp.
 */
function bevelBoxGeometry(sx: number, sy: number, sz: number, chamfer: number): THREE.BufferGeometry {
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  const c = Math.min(chamfer, hx * 0.45, hy * 0.45, hz * 0.45);

  const oct = (ax: number, ay: number): [number, number][] => [
    [ax, ay - c],
    [ax - c, ay],
    [-ax + c, ay],
    [-ax, ay - c],
    [-ax, -ay + c],
    [-ax + c, -ay],
    [ax - c, -ay],
    [ax, -ay + c],
  ];

  const rings: { p: [number, number][]; z: number }[] = [
    { p: oct(hx - c, hy - c), z: -hz },
    { p: oct(hx, hy), z: -hz + c },
    { p: oct(hx, hy), z: hz - c },
    { p: oct(hx - c, hy - c), z: hz },
  ];

  const v: number[] = [];
  const push = (p: [number, number], z: number): void => {
    v.push(p[0], p[1], z);
  };

  for (let r = 0; r < 3; r++) {
    const a = rings[r];
    const b = rings[r + 1];
    for (let k = 0; k < 8; k++) {
      const k2 = (k + 1) % 8;
      push(a.p[k], a.z);
      push(a.p[k2], a.z);
      push(b.p[k2], b.z);
      push(a.p[k], a.z);
      push(b.p[k2], b.z);
      push(b.p[k], b.z);
    }
  }
  // Caps: the far one fans forward, the near one reversed so it faces -Z.
  const top = rings[3];
  const bot = rings[0];
  for (let k = 1; k < 7; k++) {
    push(top.p[0], top.z);
    push(top.p[k], top.z);
    push(top.p[k + 1], top.z);
    push(bot.p[0], bot.z);
    push(bot.p[k + 1], bot.z);
    push(bot.p[k], bot.z);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * Triplanar UVs at a fixed texel density, assigned after the part is placed.
 * Box UVs would stretch one tile across a 40 cm receiver and the same tile
 * across a 4 cm sight block; at 10× different densities the same map reads as
 * surface on one and as chunky repeating noise on the other.
 */
function projectUV(g: THREE.BufferGeometry): void {
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const nrm = g.getAttribute("normal") as THREE.BufferAttribute | undefined;
  const n = pos.count;
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    const nx = nrm ? Math.abs(nrm.getX(i)) : 0;
    const ny = nrm ? Math.abs(nrm.getY(i)) : 1;
    const nz = nrm ? Math.abs(nrm.getZ(i)) : 0;
    let u: number;
    let vv: number;
    if (nx >= ny && nx >= nz) {
      u = pz;
      vv = py;
    } else if (ny >= nz) {
      u = px;
      vv = pz;
    } else {
      u = px;
      vv = py;
    }
    uv[i * 2] = u * UV_PER_METRE;
    uv[i * 2 + 1] = vv * UV_PER_METRE;
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

/**
 * Collects transformed primitives per material and merges them into one mesh
 * each. A whole rifle ends up as five or six draw calls instead of sixty.
 */
class Bin {
  private readonly bins = new Map<MatKey, THREE.BufferGeometry[]>();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly p = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly shift = new THREE.Vector3();

  constructor(private readonly seg: number) {}

  /** Rigid offset applied to every part, so a recipe can be re-balanced in the
   *  hand without every coordinate in it being rewritten. */
  setShift(x: number, y: number, z: number): void {
    this.shift.set(x, y, z);
  }

  private place(
    key: MatKey,
    g: THREE.BufferGeometry,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0,
  ): void {
    this.e.set(rx, ry, rz);
    this.q.setFromEuler(this.e);
    this.m.compose(this.p.set(x, y, z).add(this.shift), this.q, this.one);
    g.applyMatrix4(this.m);
    projectUV(g);
    // mergeGeometries refuses a mix of indexed and non-indexed inputs, and the
    // bevelled boxes are built flat-shaded, i.e. without an index.
    if (!g.getIndex()) {
      const n = g.getAttribute("position").count;
      const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      g.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    let list = this.bins.get(key);
    if (!list) this.bins.set(key, (list = []));
    list.push(g);
  }

  /** Chamfered box — the default. Everything with an edge facing the light. */
  box(k: MatKey, sx: number, sy: number, sz: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void {
    const c = Math.min(0.0018 + Math.min(sx, sy, sz) * 0.06, 0.004);
    this.place(k, bevelBoxGeometry(sx, sy, sz, c), x, y, z, rx, ry, rz);
  }

  /** Sharp box, for thin shims and inlays where a chamfer would eat the part. */
  slab(k: MatKey, sx: number, sy: number, sz: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void {
    this.place(k, new THREE.BoxGeometry(sx, sy, sz), x, y, z, rx, ry, rz);
  }

  /** Cylinder with its axis along Z (forward). */
  tube(k: MatKey, r1: number, r2: number, len: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void {
    const g = new THREE.CylinderGeometry(r1, r2, len, this.seg, 1, false);
    g.rotateX(Math.PI / 2);
    this.place(k, g, x, y, z, rx, ry, rz);
  }

  /** Cylinder with its axis along Y — grips, magazine wells, drums. */
  post(k: MatKey, r1: number, r2: number, len: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void {
    this.place(k, new THREE.CylinderGeometry(r1, r2, len, this.seg, 1, false), x, y, z, rx, ry, rz);
  }

  ring(k: MatKey, r: number, tube: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void {
    const g = new THREE.TorusGeometry(r, tube, Math.max(4, this.seg >> 1), this.seg);
    this.place(k, g, x, y, z, rx, ry, rz);
  }

  ball(k: MatKey, r: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): void {
    const g = new THREE.SphereGeometry(r, this.seg, Math.max(4, this.seg >> 1));
    g.scale(sx, sy, sz);
    this.place(k, g, x, y, z);
  }

  /** Capsule along Y before rotation — limbs and fingers. */
  limb(k: MatKey, r: number, len: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void {
    const g = new THREE.CapsuleGeometry(r, len, 2, Math.max(5, this.seg >> 1));
    this.place(k, g, x, y, z, rx, ry, rz);
  }

  /** Merge into meshes under `parent`. Returns the geometries to dispose. */
  flush(parent: THREE.Object3D, mats: Record<MatKey, THREE.Material>): THREE.BufferGeometry[] {
    const out: THREE.BufferGeometry[] = [];
    for (const [key, list] of this.bins) {
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mats[key]);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      parent.add(mesh);
      out.push(merged);
    }
    this.bins.clear();
    return out;
  }
}

// ────────────────────────────────────────────────────────────── materials ──

interface MatSet extends Record<MatKey, THREE.Material> {
  poly: THREE.MeshStandardMaterial;
  steel: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  glow: THREE.MeshStandardMaterial;
  shell: THREE.MeshStandardMaterial;
  armor: THREE.MeshStandardMaterial;
  glove: THREE.MeshStandardMaterial;
}

interface SurfaceMaps {
  rough: THREE.Texture;
  albedo: THREE.Texture;
  normal: THREE.Texture | null;
  dispose: () => void;
}

/**
 * Grain, scratches and edge wear. One sheet drives roughness, a subtle albedo
 * modulation and (above low) a normal map, so a large flat face still has
 * something happening on it. All three come from the same height field, which
 * is why a scratch is simultaneously smoother, lighter and a groove.
 */
function surfaceMaps(size: number, rng: Rng, wantNormal: boolean): SurfaceMaps {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const c = canvas.getContext("2d")!;

  c.fillStyle = "#ffffff";
  c.fillRect(0, 0, size, size);

  // Blotchy base: handled areas polish smooth, neglected areas stay matte.
  for (let i = 0; i < 90; i++) {
    const r = (0.05 + rng() * 0.22) * size;
    const x = rng() * size;
    const y = rng() * size;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    const v = Math.round(150 + rng() * 80);
    g.addColorStop(0, `rgba(${v},${v},${v},0.55)`);
    g.addColorStop(1, `rgba(${v},${v},${v},0)`);
    c.fillStyle = g;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  }

  // Machining grain.
  c.globalAlpha = 0.13;
  for (let i = 0; i < size * 3; i++) {
    c.strokeStyle = rng() > 0.5 ? "#ffffff" : "#606060";
    c.beginPath();
    const y = rng() * size;
    c.moveTo(0, y);
    c.lineTo(size, y + (rng() - 0.5) * 3);
    c.stroke();
  }

  // Scratches: bare metal under the finish, smoother and lighter than around it.
  c.globalAlpha = 0.45;
  c.strokeStyle = "#8c8c8c";
  for (let i = 0; i < 46; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const a = rng() * Math.PI;
    const l = (0.03 + rng() * 0.2) * size;
    c.lineWidth = rng() * 1.6 + 0.5;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    c.stroke();
  }
  c.globalAlpha = 1;

  const px = c.getImageData(0, 0, size, size).data;

  const rough = new THREE.CanvasTexture(canvas);
  rough.wrapS = rough.wrapT = THREE.RepeatWrapping;
  rough.colorSpace = THREE.NoColorSpace;
  rough.anisotropy = 4;

  // Albedo modulation stays inside ±10% — a weapon is one colour, it is the
  // light that varies. Kept linear because it is a multiplier, not a colour.
  const aCanvas = document.createElement("canvas");
  aCanvas.width = aCanvas.height = size;
  const ac = aCanvas.getContext("2d")!;
  const aImg = ac.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = Math.round(212 + (px[i * 4] / 255) * 43);
    aImg.data[i * 4] = v;
    aImg.data[i * 4 + 1] = v;
    aImg.data[i * 4 + 2] = v;
    aImg.data[i * 4 + 3] = 255;
  }
  ac.putImageData(aImg, 0, 0);
  const albedo = new THREE.CanvasTexture(aCanvas);
  albedo.wrapS = albedo.wrapT = THREE.RepeatWrapping;
  albedo.colorSpace = THREE.NoColorSpace;
  albedo.anisotropy = 4;

  let normal: THREE.Texture | null = null;
  if (wantNormal) {
    const nCanvas = document.createElement("canvas");
    nCanvas.width = nCanvas.height = size;
    const nc = nCanvas.getContext("2d")!;
    const nImg = nc.createImageData(size, size);
    const at = (x: number, y: number): number =>
      px[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = at(x + 1, y) - at(x - 1, y);
        const dy = at(x, y + 1) - at(x, y - 1);
        const s = 4.0;
        const nx = -dx * s;
        const ny = dy * s;
        const l = Math.hypot(nx, ny, 1);
        const i = (y * size + x) * 4;
        nImg.data[i] = Math.round((nx / l) * 127.5 + 127.5);
        nImg.data[i + 1] = Math.round((ny / l) * 127.5 + 127.5);
        nImg.data[i + 2] = Math.round((1 / l) * 127.5 + 127.5);
        nImg.data[i + 3] = 255;
      }
    }
    nc.putImageData(nImg, 0, 0);
    normal = new THREE.CanvasTexture(nCanvas);
    normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
    normal.colorSpace = THREE.NoColorSpace;
    normal.anisotropy = 4;
  }

  return {
    rough,
    albedo,
    normal,
    dispose: () => {
      rough.dispose();
      albedo.dispose();
      normal?.dispose();
    },
  };
}

/** Soft radial blob used for the muzzle flash billboards. */
function flareTexture(size: number): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const c = canvas.getContext("2d")!;
  const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, "rgba(255,255,255,1)");
  g.addColorStop(0.22, "rgba(255,232,180,0.85)");
  g.addColorStop(0.55, "rgba(255,150,60,0.22)");
  g.addColorStop(1.0, "rgba(255,120,40,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

// ───────────────────────────────────────────────────────────── ambient ──

/**
 * TS mirror of Sky's `atmosphereRadiance`, which is not exported. Same
 * constants, same units: the value it returns is the scene-linear radiance the
 * sky dome paints in that direction.
 */
function skyRadiance(dir: THREE.Vector3, out: THREE.Color): THREE.Color {
  const a = atmosphere;
  const c = Math.max(dir.y, -0.1);
  const zdeg = (Math.acos(THREE.MathUtils.clamp(c, -1, 1)) * 180) / Math.PI;
  const am = 1 / (c + 0.15 * Math.pow(Math.max(93.885 - zdeg, 1e-3), -1.253));

  const betaR = [5.8e-6, 13.5e-6, 33.1e-6];
  const tauM = 21e-6 * a.mie * 1250 * am;
  const cosT = dir.dot(a.sunDirection);
  const pr = 0.0596831 * (1 + cosT * cosT);
  const g2 = a.mieG * a.mieG;
  const d = Math.max(1 + g2 - 2 * a.mieG * cosT, 1e-4);
  const pm = (0.0795775 * (1 - g2)) / (d * Math.sqrt(d));

  const ms = [0.055, 0.085, 0.135];
  const rgb = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const tauR = betaR[i] * a.rayleigh * 8400 * am;
    const sr = 1 - Math.exp(-tauR);
    rgb[i] = (pr * sr + pm * (1 - Math.exp(-tauM)) + ms[i] * sr * 0.0125) * a.skyLuminance;
  }
  return out.setRGB(rgb[0] * a.sunTint.r, rgb[1] * a.sunTint.g, rgb[2] * a.sunTint.b);
}

/**
 * Equirect probe built from the real sky for the current sun elevation, then
 * PMREM-filtered. Azimuthally averaged, because the probe is fixed in view
 * space and a sun-side bright patch would swing around the weapon as you
 * turned; the sun's own directionality is the DirectionalLight's job.
 *
 * `gain` is the one fudge. The world's HemisphereLight carries roughly a third
 * of the true sky irradiance, so a physically complete probe would light the
 * weapon three times brighter than the terrain it is held over. Splitting the
 * difference keeps the gun inside the frame's exposure instead of punching a
 * hole in it.
 */
function skyProbe(renderer: THREE.WebGLRenderer, gain: number): { tex: THREE.Texture; dispose: () => void } {
  const w = 24;
  const h = 16;
  const data = new Float32Array(w * h * 4);
  const dir = new THREE.Vector3();
  const col = new THREE.Color();
  const acc = new THREE.Color();
  const AZ = 12;

  // Sunlit ground, seen by everything on the underside of the weapon.
  const groundAlbedo = lin(0.30, 0.26, 0.20);
  const sunUp = Math.max(0.05, atmosphere.sunDirection.y);
  skyRadiance(dir.set(0, 0.35, 0).normalize(), col);
  const skyMid = (col.r + col.g + col.b) / 3;
  const groundE = (3.35 * sunUp) / Math.PI + skyMid * 0.8;

  for (let y = 0; y < h; y++) {
    const theta = ((y + 0.5) / h) * Math.PI;
    const cy = Math.cos(theta);
    const sy = Math.sin(theta);
    acc.setRGB(0, 0, 0);
    if (cy > -0.02) {
      for (let k = 0; k < AZ; k++) {
        const phi = ((k + 0.5) / AZ) * Math.PI * 2;
        dir.set(Math.cos(phi) * sy, cy, Math.sin(phi) * sy);
        skyRadiance(dir, col);
        acc.add(col);
      }
      acc.multiplyScalar(1 / AZ);
    } else {
      acc.copy(groundAlbedo).multiplyScalar(groundE);
    }
    acc.multiplyScalar(gain);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i + 0] = acc.r;
      data[i + 1] = acc.g;
      data[i + 2] = acc.b;
      data[i + 3] = 1;
    }
  }

  const src = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  src.mapping = THREE.EquirectangularReflectionMapping;
  src.colorSpace = THREE.NoColorSpace;
  src.needsUpdate = true;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromEquirectangular(src);
  pmrem.dispose();
  src.dispose();
  return { tex: rt.texture, dispose: () => rt.dispose() };
}

// ─────────────────────────────────────────────────────────────────── rigs ──

type ReloadStyle = "mag" | "vent" | "tube";

interface Rig {
  root: THREE.Group;
  body: THREE.Group;
  mag: THREE.Group;
  bolt: THREE.Group;
  /** Support hand, which rides the magazine through a reload. */
  lhand: THREE.Group;
  muzzle: THREE.Object3D;
  eject: THREE.Object3D;
  hipPos: THREE.Vector3;
  hipRot: THREE.Euler;
  adsPos: THREE.Vector3;
  adsRot: THREE.Euler;
  sprintPos: THREE.Vector3;
  sprintRot: THREE.Euler;
  reloadStyle: ReloadStyle;
  /** Multiplier on the recoil spring impulse. */
  kick: number;
  ejects: boolean;
  /** Scoped weapons vanish at full ADS — the world FOV is doing the aiming. */
  hideAtAds: boolean;
  glow: THREE.MeshStandardMaterial[];
  geoms: THREE.BufferGeometry[];
  mats: THREE.Material[];
}

/** Shared pistol grip + trigger guard, positioned by the caller. */
function grip(b: Bin, z: number, tilt = 0.30): void {
  b.box("poly", 0.036, 0.135, 0.055, 0, -0.088, z + 0.030, tilt);
  b.box("poly", 0.040, 0.030, 0.062, 0, -0.020, z + 0.012, tilt * 0.4);
  // Moulded finger swells down the front strap.
  for (let i = 0; i < 3; i++) {
    b.box("dark", 0.038, 0.008, 0.010, 0, -0.048 - i * 0.026, z + 0.058 + i * 0.008, tilt);
  }
  b.box("dark", 0.030, 0.011, 0.075, 0, -0.049, z - 0.036);
  b.box("dark", 0.030, 0.038, 0.011, 0, -0.032, z - 0.070);
  b.box("steel", 0.010, 0.026, 0.011, 0, -0.032, z - 0.012, 0.25);
}

/**
 * Armoured firing hand wrapped on the grip, plus the forearm running back out
 * of frame. Blocky is fine — at this distance the silhouette is the whole
 * read, and a floating rifle is the loudest tell there is.
 */
function firingHand(b: Bin, z: number, tilt = 0.30): void {
  const x = 0.008;
  // Palm and the back-of-hand plate.
  b.box("glove", 0.054, 0.098, 0.062, x, -0.062, z + 0.028, tilt);
  b.box("armor", 0.030, 0.086, 0.052, x + 0.020, -0.060, z + 0.028, tilt);
  // Fingers curling around the front strap, second knuckles proud.
  for (let i = 0; i < 4; i++) {
    const fy = -0.030 - i * 0.024;
    const fz = z + 0.062 + i * 0.006;
    b.limb("glove", 0.0125, 0.036, x, fy, fz, 0, 0, Math.PI / 2);
    b.box("armor", 0.040, 0.014, 0.014, x, fy + 0.008, fz + 0.004);
  }
  // Trigger finger, forward onto the guard.
  b.limb("glove", 0.011, 0.030, x - 0.006, -0.030, z - 0.020, 0.5, 0, Math.PI / 2);
  // Thumb over the far side of the grip.
  b.limb("glove", 0.013, 0.030, x - 0.026, -0.044, z + 0.020, 0.9, 0.5, 0);
  // Wrist and gauntlet, angled back toward the shoulder.
  b.box("armor", 0.056, 0.062, 0.070, x + 0.006, -0.120, z + 0.062, 0.35);
  b.limb("armor", 0.036, 0.150, x + 0.020, -0.205, z + 0.150, 0.95, 0.18, 0);
  b.box("armor", 0.052, 0.030, 0.090, x + 0.030, -0.175, z + 0.135, 0.95);
}

/**
 * Support hand on the handguard. The player sees it from above and slightly
 * inboard, so everything that has to read — the knuckle plates and the gaps
 * between them — is on the near face, outboard of every other part of the
 * hand. A plate buried inside another plate is a plate nobody sees.
 */
function supportHand(b: Bin, z: number, y = 0, w = 0.066): void {
  const r = w / 2;
  const xo = -(r + 0.013);

  // Palm cupping the underside, and the wrist behind it.
  b.box("glove", 0.058, 0.038, 0.096, -0.008, y - 0.044, z, 0, 0, 0.05);
  b.box("armor", 0.030, 0.070, 0.052, xo - 0.006, y - 0.028, z + 0.038, 0.05, 0, 0.10);

  for (let i = 0; i < 4; i++) {
    const fz = z - 0.034 + i * 0.023;
    const drop = i * 0.004;
    // Knuckle plate, proud of everything else and separated by a real gap.
    b.box("armor", 0.020, 0.040, 0.018, xo - 0.010, y + 0.004 - drop, fz, 0, 0, 0.18);
    // Finger segment behind it, and the joint over the top of the handguard.
    b.limb("glove", 0.0110, 0.036, xo + 0.004, y - 0.006 - drop, fz, 0, 0, 0.20);
    b.box("armor", 0.058, 0.020, 0.019, 0.002, y + 0.045 - drop * 0.5, fz);
    b.limb("glove", 0.0100, 0.042, 0.004, y + 0.039 - drop * 0.5, fz, 0, 0, Math.PI / 2);
  }

  // Thumb, angled forward along the near face.
  b.limb("glove", 0.0125, 0.040, xo + 0.002, y + 0.006, z + 0.044, 0.6, 0, 0.30);
  b.box("armor", 0.018, 0.020, 0.030, xo - 0.008, y + 0.020, z + 0.052, 0.5, 0, 0.30);

  // Gauntlet cuff and forearm, running down and out of frame.
  b.box("armor", 0.060, 0.062, 0.070, -0.022, y - 0.076, z + 0.070, 0.45, 0, 0.12);
  b.box("armor", 0.052, 0.032, 0.048, -0.032, y - 0.106, z + 0.112, 0.6, 0, 0.12);
  b.limb("armor", 0.034, 0.170, -0.066, y - 0.160, z + 0.178, 0.95, -0.26, -0.30);
}

function makeGlow(color: THREE.Color, intensity: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: lin(0.02, 0.02, 0.02),
    emissive: color,
    emissiveIntensity: intensity,
    roughness: 0.35,
    metalness: 0,
    toneMapped: false,
  });
}

/** Per-weapon geometry authoring. Everything is in weapon-local metres with
 *  -Z forward, and the iron/optic sight line sitting on x = 0 at `sightY`. */
interface Recipe {
  emit: (b: Bin, magBin: Bin, boltBin: Bin, handBin: Bin) => void;
  /** Rigid offset on every part. Bulk needs distance from the eye, and a long
   *  weapon needs less of it than a short fat one. */
  shift: [number, number, number];
  muzzle: [number, number, number];
  eject: [number, number, number];
  sightY: number;
  reloadStyle: ReloadStyle;
  kick: number;
  ejects: boolean;
  hideAtAds: boolean;
  /** Rest position of the rig root in view space. */
  hip: [number, number, number];
  /** How far the eye sits behind the rear sight when aiming. */
  adsZ: number;
  glowColor: THREE.Color;
  glowIntensity: number;
}

function arRecipe(): Recipe {
  return {
    emit: (b, mag, bolt, hand) => {
      // ── receiver ──
      b.box("poly", 0.080, 0.100, 0.400, 0, 0.012, -0.200);
      b.box("dark", 0.084, 0.020, 0.360, 0, 0.062, -0.200);
      b.box("poly", 0.070, 0.030, 0.070, 0, -0.030, -0.055);
      // Proud panel line breaking the flank into two volumes.
      b.slab("dark", 0.0032, 0.006, 0.300, -0.041, 0.030, -0.205);
      b.slab("dark", 0.0032, 0.006, 0.300, 0.041, 0.030, -0.205);

      // ── carry handle: two towers, a rail and an aperture ──
      b.box("dark", 0.022, 0.052, 0.028, 0, 0.096, -0.075);
      b.box("dark", 0.022, 0.052, 0.028, 0, 0.096, -0.330);
      b.box("dark", 0.054, 0.024, 0.290, 0, 0.132, -0.200);
      b.box("dark", 0.048, 0.016, 0.032, 0, 0.150, -0.245);
      b.ring("dark", 0.018, 0.005, 0, 0.132, -0.062);
      b.box("dark", 0.026, 0.030, 0.010, 0, 0.146, -0.062);
      b.box("dark", 0.030, 0.026, 0.014, 0, 0.132, -0.078);
      // Rail forward of the handle, carrying the sight tower.
      b.box("dark", 0.030, 0.014, 0.190, 0, 0.126, -0.440);
      for (let i = 0; i < 5; i++) b.slab("dark", 0.034, 0.004, 0.008, 0, 0.134, -0.370 - i * 0.030);

      // ── handguard ──
      b.box("poly", 0.066, 0.068, 0.230, 0, 0.006, -0.520);
      for (let i = 0; i < 4; i++) {
        b.box("dark", 0.070, 0.009, 0.034, 0, 0.030 - i * 0.021, -0.520 + (i % 2) * 0.024);
      }
      // Gas block and front sight tower — everything on a rifle is supported.
      b.box("dark", 0.030, 0.062, 0.038, 0, 0.062, -0.610);
      b.box("dark", 0.020, 0.030, 0.026, 0, 0.104, -0.610);
      b.box("dark", 0.036, 0.014, 0.022, 0, 0.124, -0.610);
      b.box("dark", 0.008, 0.020, 0.008, 0, 0.136, -0.610);

      // ── barrel ──
      b.tube("steel", 0.019, 0.018, 0.320, 0, 0.006, -0.720);
      b.tube("steel", 0.030, 0.027, 0.070, 0, 0.006, -0.895);
      b.ring("dark", 0.028, 0.007, 0, 0.006, -0.928);
      b.ring("dark", 0.026, 0.006, 0, 0.006, -0.856);
      for (let i = 0; i < 3; i++) b.ring("trim", 0.035, 0.008, 0, 0.006, -0.430 - i * 0.075);
      b.box("trim", 0.068, 0.006, 0.150, 0, 0.041, -0.520);

      // ── stock: three volumes, a real gap, and a cheek riser ──
      b.box("poly", 0.050, 0.052, 0.180, 0, 0.030, 0.092);
      b.box("poly", 0.044, 0.026, 0.140, 0, 0.062, 0.078, -0.07);
      b.box("dark", 0.036, 0.020, 0.110, 0, 0.080, 0.070, -0.07);
      b.box("poly", 0.044, 0.034, 0.150, 0, -0.038, 0.086, 0.06);
      b.slab("dark", 0.020, 0.030, 0.120, 0, -0.002, 0.098);
      b.box("dark", 0.058, 0.104, 0.022, 0, 0.010, 0.186, 0.10);
      b.slab("dark", 0.050, 0.014, 0.008, 0, 0.048, 0.176);
      b.slab("dark", 0.050, 0.014, 0.008, 0, -0.028, 0.176);
      b.ring("steel", 0.010, 0.004, -0.030, 0.014, 0.060, 0, Math.PI / 2, 0);
      b.box("dark", 0.006, 0.008, 0.140, -0.040, -0.020, -0.170);

      // ── ammo counter ──
      b.box("dark", 0.012, 0.048, 0.104, -0.042, 0.028, -0.150);
      b.slab("glow", 0.004, 0.030, 0.078, -0.049, 0.028, -0.150);
      for (let i = 0; i < 3; i++) b.slab("dark", 0.006, 0.030, 0.005, -0.050, 0.028, -0.176 + i * 0.026);
      // Stencilled unit marks: proud strips, not a painted rectangle.
      for (let i = 0; i < 4; i++) b.slab("trim", 0.003, 0.014, 0.006, -0.042, 0.064, -0.300 - i * 0.012);

      grip(b, -0.030);

      mag.box("poly", 0.050, 0.150, 0.086, 0, -0.115, -0.180, 0.07);
      mag.box("dark", 0.054, 0.018, 0.090, 0, -0.048, -0.184);
      mag.box("trim", 0.052, 0.010, 0.030, 0, -0.188, -0.190, 0.07);
      for (let i = 0; i < 3; i++) mag.slab("dark", 0.052, 0.005, 0.070, 0, -0.086 - i * 0.026, -0.182);

      bolt.box("steel", 0.014, 0.022, 0.055, -0.047, 0.052, -0.115);
      bolt.box("steel", 0.024, 0.014, 0.016, -0.056, 0.052, -0.100);

      firingHand(b, -0.030);
      supportHand(hand, -0.440, 0.006);
    },
    shift: [0, 0, -0.12],
    muzzle: [0, 0.006, -0.930],
    eject: [0.046, 0.045, -0.120],
    sightY: 0.132,
    reloadStyle: "mag",
    kick: 1,
    ejects: true,
    hideAtAds: false,
    hip: [0.150, -0.205, -0.255],
    adsZ: -0.30,
    glowColor: lin(2.4, 1.15, 0.22),
    glowIntensity: 1,
  };
}

function brRecipe(): Recipe {
  return {
    emit: (b, mag, bolt, hand) => {
      // Angular receiver — a wedge next to the AR's brick.
      b.box("poly", 0.068, 0.086, 0.330, 0, 0.010, -0.175);
      b.box("poly", 0.056, 0.042, 0.320, 0, 0.052, -0.175);
      b.box("dark", 0.050, 0.020, 0.300, 0, 0.072, -0.175);
      b.box("poly", 0.062, 0.028, 0.090, 0, -0.036, -0.070);
      b.slab("dark", 0.0032, 0.006, 0.250, -0.035, 0.026, -0.180);

      // Scope: short, fat, mounted low and far back.
      b.tube("dark", 0.028, 0.028, 0.180, 0, 0.120, -0.230);
      b.tube("dark", 0.033, 0.033, 0.022, 0, 0.120, -0.150);
      b.tube("dark", 0.034, 0.030, 0.034, 0, 0.120, -0.332);
      b.tube("glass", 0.026, 0.026, 0.004, 0, 0.120, -0.138);
      b.box("dark", 0.038, 0.038, 0.018, 0, 0.098, -0.190);
      b.box("dark", 0.038, 0.038, 0.018, 0, 0.098, -0.290);
      b.post("dark", 0.014, 0.014, 0.020, -0.032, 0.140, -0.250, 0, 0, Math.PI / 2);
      b.slab("glow", 0.004, 0.006, 0.030, -0.030, 0.120, -0.200);

      // Handguard, vented, three fins.
      b.box("poly", 0.056, 0.056, 0.200, 0, 0.004, -0.440);
      for (let i = 0; i < 3; i++) b.box("dark", 0.060, 0.009, 0.150, 0, 0.022 - i * 0.020, -0.440);

      b.tube("steel", 0.013, 0.013, 0.240, 0, 0.004, -0.620);
      b.tube("dark", 0.019, 0.017, 0.045, 0, 0.004, -0.750);
      b.box("dark", 0.024, 0.038, 0.030, 0, 0.026, -0.545);
      b.box("dark", 0.010, 0.024, 0.010, 0, 0.056, -0.545);

      // Stock.
      b.box("poly", 0.048, 0.050, 0.160, 0, 0.026, 0.078);
      b.box("poly", 0.040, 0.024, 0.120, 0, 0.056, 0.068, -0.06);
      b.box("poly", 0.040, 0.030, 0.130, 0, -0.030, 0.072, 0.05);
      b.box("dark", 0.050, 0.092, 0.018, 0, 0.006, 0.160, 0.12);
      for (let i = 0; i < 3; i++) b.slab("trim", 0.003, 0.012, 0.006, -0.036, 0.038, -0.262 - i * 0.012);

      grip(b, -0.020);

      mag.box("poly", 0.044, 0.130, 0.078, 0, -0.100, -0.165, 0.05);
      mag.box("dark", 0.048, 0.016, 0.082, 0, -0.042, -0.168);
      mag.box("trim", 0.046, 0.009, 0.028, 0, -0.163, -0.172, 0.05);

      bolt.box("steel", 0.012, 0.020, 0.050, -0.040, 0.040, -0.100);

      firingHand(b, -0.020);
      supportHand(hand, -0.400, 0.004, 0.056);
    },
    shift: [0, 0, -0.10],
    muzzle: [0, 0.004, -0.780],
    eject: [0.040, 0.038, -0.105],
    sightY: 0.120,
    reloadStyle: "mag",
    kick: 1.15,
    ejects: true,
    hideAtAds: false,
    hip: [0.148, -0.200, -0.270],
    adsZ: -0.30,
    glowColor: lin(0.5, 2.6, 1.6),
    glowIntensity: 1,
  };
}

function plasmaRecipe(): Recipe {
  return {
    emit: (b, _mag, _bolt, hand) => {
      // Covenant tooling: no flat plates, everything is a swelling or a fork.
      b.ball("shell", 0.075, 0, 0.012, -0.180, 1.0, 0.95, 2.6);
      b.ball("shell", 0.062, 0, 0.030, -0.360, 1.0, 0.85, 1.5);
      b.tube("shell", 0.052, 0.030, 0.120, 0, 0.026, -0.470);

      for (const s of [-1, 1]) {
        b.tube("shell", 0.022, 0.011, 0.230, s * 0.046, 0.030, -0.600, 0, s * 0.10, 0);
        b.ball("shell", 0.024, s * 0.038, 0.030, -0.492, 1, 1, 1.3);
        b.tube("glow", 0.006, 0.004, 0.180, s * 0.046, 0.030, -0.605, 0, s * 0.10, 0);
      }
      b.tube("glow", 0.014, 0.008, 0.240, 0, 0.028, -0.600);
      b.ball("glow", 0.020, 0, 0.028, -0.470, 1, 1, 1.4);

      for (let i = 0; i < 5; i++) {
        const z = -0.130 - i * 0.048;
        b.box("shell", 0.086, 0.020, 0.016, 0, 0.062, z);
        b.slab("glow", 0.070, 0.008, 0.020, 0, 0.048, z + 0.024);
      }

      b.ball("shell", 0.048, 0, 0.006, 0.040, 1.1, 1.0, 1.5);
      b.tube("glow", 0.026, 0.026, 0.030, -0.030, 0.006, 0.052, 0, 1.35, 0);
      b.slab("glow", 0.006, 0.030, 0.070, -0.048, 0.010, -0.040);

      b.ball("shell", 0.030, 0, 0.070, -0.090, 1.0, 0.6, 1.6);
      b.box("shell", 0.010, 0.024, 0.050, 0, 0.098, -0.140);

      // Organic grip: a swept hook rather than a pistol grip.
      b.ball("shell", 0.030, 0, -0.070, -0.010, 0.9, 2.0, 1.1);
      b.ball("shell", 0.026, 0, -0.130, 0.030, 0.9, 1.2, 1.0);
      b.box("dark", 0.020, 0.030, 0.012, 0, -0.052, -0.062, 0.2);

      firingHand(b, -0.006, 0.18);
      supportHand(hand, -0.310, 0.026, 0.070);
    },
    shift: [0, 0, -0.04],
    muzzle: [0, 0.028, -0.740],
    eject: [0, 0, 0],
    sightY: 0.104,
    reloadStyle: "vent",
    kick: 0.55,
    ejects: false,
    hideAtAds: false,
    hip: [0.146, -0.192, -0.290],
    adsZ: -0.32,
    glowColor: lin(0.55, 3.4, 5.2),
    glowIntensity: 1,
  };
}

function sniperRecipe(): Recipe {
  return {
    emit: (b, mag, bolt, hand) => {
      b.box("poly", 0.062, 0.090, 0.420, 0, 0.004, -0.240);
      b.box("dark", 0.070, 0.020, 0.400, 0, 0.056, -0.240);
      b.box("poly", 0.058, 0.026, 0.110, 0, -0.040, -0.090);
      b.slab("dark", 0.0032, 0.006, 0.340, -0.032, 0.020, -0.245);

      // The scope is the read: long, thick, high over the bore.
      b.tube("dark", 0.032, 0.032, 0.440, 0, 0.128, -0.330);
      b.tube("dark", 0.040, 0.040, 0.030, 0, 0.128, -0.132);
      b.tube("dark", 0.032, 0.046, 0.050, 0, 0.128, -0.520);
      b.tube("dark", 0.052, 0.048, 0.060, 0, 0.128, -0.560);
      b.tube("glass", 0.046, 0.046, 0.005, 0, 0.128, -0.585);
      b.tube("glass", 0.038, 0.038, 0.005, 0, 0.128, -0.132);
      b.box("dark", 0.048, 0.062, 0.022, 0, 0.096, -0.200);
      b.box("dark", 0.048, 0.062, 0.022, 0, 0.096, -0.420);
      b.post("dark", 0.018, 0.018, 0.024, -0.044, 0.150, -0.300, 0, 0, Math.PI / 2);
      b.slab("glow", 0.004, 0.008, 0.044, -0.043, 0.128, -0.230);

      // Heavy fluted barrel.
      b.tube("steel", 0.024, 0.021, 0.240, 0, 0.000, -0.560);
      b.tube("steel", 0.018, 0.017, 0.340, 0, 0.000, -0.840);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        b.box("dark", 0.007, 0.007, 0.220, Math.cos(a) * 0.021, Math.sin(a) * 0.021, -0.560);
      }
      b.tube("dark", 0.026, 0.024, 0.090, 0, 0.000, -1.040);
      for (let i = 0; i < 3; i++) b.slab("dark", 0.056, 0.006, 0.012, 0, 0.000, -1.020 + i * 0.022);

      for (const s of [-1, 1]) {
        b.tube("dark", 0.006, 0.005, 0.170, s * 0.016, -0.028, -0.700, 0.14, 0, 0);
      }

      // Stock: cheek riser, cut-out, recoil pad.
      b.box("poly", 0.052, 0.056, 0.200, 0, 0.030, 0.110);
      b.box("poly", 0.042, 0.030, 0.150, 0, 0.066, 0.096, -0.05);
      b.box("dark", 0.034, 0.020, 0.110, 0, 0.086, 0.090, -0.05);
      b.box("poly", 0.044, 0.036, 0.160, 0, -0.040, 0.104, 0.05);
      b.slab("dark", 0.022, 0.032, 0.130, 0, 0.000, 0.120);
      b.box("dark", 0.054, 0.108, 0.022, 0, 0.010, 0.214, 0.10);
      for (let i = 0; i < 3; i++) b.slab("trim", 0.003, 0.014, 0.006, -0.033, 0.030, -0.352 - i * 0.013);

      grip(b, -0.055);

      mag.box("poly", 0.038, 0.100, 0.100, 0, -0.086, -0.230);
      mag.box("dark", 0.042, 0.014, 0.104, 0, -0.038, -0.232);

      bolt.post("steel", 0.010, 0.010, 0.070, -0.052, 0.040, -0.135, 0, 0, Math.PI / 2);
      bolt.ball("steel", 0.016, -0.086, 0.040, -0.135);

      firingHand(b, -0.055);
      supportHand(hand, -0.500, 0.000, 0.052);
    },
    shift: [0, 0, -0.02],
    muzzle: [0, 0, -1.100],
    eject: [0.042, 0.040, -0.140],
    sightY: 0.128,
    reloadStyle: "mag",
    kick: 3.2,
    ejects: true,
    hideAtAds: true,
    hip: [0.150, -0.212, -0.250],
    adsZ: -0.29,
    glowColor: lin(3.0, 0.9, 0.25),
    glowIntensity: 1,
  };
}

function rocketRecipe(): Recipe {
  return {
    emit: (b, mag, _bolt, hand) => {
      // Twin tubes, stacked.
      for (const y of [0.112, -0.042]) {
        b.tube("poly", 0.058, 0.058, 0.640, 0, y, -0.330);
        b.ring("dark", 0.057, 0.009, 0, y, -0.645);
        b.ring("dark", 0.057, 0.009, 0, y, -0.030);
        b.ring("trim", 0.057, 0.008, 0, y, -0.520);
        b.tube("dark", 0.049, 0.049, 0.050, 0, y, -0.634);
      }
      b.box("dark", 0.030, 0.040, 0.560, 0, 0.035, -0.330);
      b.box("poly", 0.086, 0.052, 0.500, 0, 0.035, -0.330);
      b.box("dark", 0.108, 0.016, 0.070, 0, 0.035, -0.180);
      b.box("dark", 0.108, 0.016, 0.070, 0, 0.035, -0.470);

      // Optic block and range readout, angled toward the eye.
      b.box("dark", 0.070, 0.056, 0.120, 0, 0.190, -0.240);
      b.box("dark", 0.062, 0.048, 0.010, 0, 0.192, -0.180);
      b.slab("glow", 0.038, 0.024, 0.006, 0, 0.192, -0.176);
      b.slab("dark", 0.004, 0.024, 0.008, 0, 0.192, -0.173);
      b.tube("dark", 0.020, 0.026, 0.050, 0.022, 0.190, -0.320);
      b.box("dark", 0.020, 0.040, 0.024, 0, 0.238, -0.300);
      b.box("dark", 0.086, 0.022, 0.150, 0, 0.152, -0.300);

      b.box("dark", 0.024, 0.050, 0.028, 0, 0.150, 0.020);
      b.box("dark", 0.030, 0.022, 0.120, 0, 0.170, 0.060);

      b.box("poly", 0.080, 0.070, 0.150, 0, -0.010, 0.070);
      b.box("dark", 0.084, 0.100, 0.020, 0, -0.020, 0.150, 0.12);
      for (let i = 0; i < 3; i++) b.slab("trim", 0.004, 0.014, 0.008, -0.052, 0.035, -0.390 - i * 0.014);

      grip(b, 0.010);
      b.box("poly", 0.030, 0.090, 0.048, 0, -0.062, -0.400, -0.25);

      // Warhead noses sitting in the tubes — these ride out on reload.
      for (const y of [0.098, -0.028]) {
        mag.tube("dark", 0.052, 0.030, 0.070, 0, y, -0.690);
        mag.tube("glow", 0.030, 0.014, 0.030, 0, y, -0.664);
      }

      firingHand(b, 0.010);
      supportHand(hand, -0.380, -0.042, 0.052);
    },
    shift: [0, -0.02, -0.10],
    muzzle: [0, 0.098, -0.700],
    eject: [0, 0, 0],
    sightY: 0.190,
    reloadStyle: "tube",
    kick: 3.6,
    ejects: false,
    hideAtAds: false,
    hip: [0.150, -0.215, -0.300],
    adsZ: -0.34,
    glowColor: lin(3.4, 1.0, 0.18),
    glowIntensity: 1,
  };
}

const RECIPES: Record<string, () => Recipe> = {
  ar: arRecipe,
  br: brRecipe,
  plasma: plasmaRecipe,
  sniper: sniperRecipe,
  rocket: rocketRecipe,
};

/** Shot-harness handle: lets a screenshot force a weapon state that would
 *  otherwise need a held mouse button. Read-only from the module's side. */
interface ViewmodelDebug {
  ads?: number | null;
  hide?: boolean;
  /** Narrow the viewmodel camera to inspect the model itself. */
  fov?: number | null;
  /** [x,y,z,rx,ry,rz] replacing the composed rest pose, for model review. */
  pose?: number[] | null;
}

// ─────────────────────────────────────────────────────────── the module ──

const mod: GameModule = {
  id: "viewmodel",
  order: 15,

  build(ctx: ModuleContext) {
    const profile: QualityProfile = ctx.profile;
    const low = profile.tier === "low";
    const segs = low ? 8 : profile.tier === "medium" ? 12 : 16;
    const texSize = Math.max(128, Math.min(512, Math.round(profile.textureSize / 2)));

    // ── scene, camera, lights ────────────────────────────────────────────
    const vmScene = new THREE.Scene();
    // Narrower than the world camera: a viewmodel FOV near the world's puts the
    // buttstock in your face and splays the receiver into near-field slabs.
    const BASE_FOV = 45;
    const vmCamera = new THREE.PerspectiveCamera(BASE_FOV, ctx.camera.aspect, 0.01, 6);

    const probe = skyProbe(ctx.renderer, 1.0);
    vmScene.environment = probe.tex;
    const env = probe.tex;

    // Same rig Sky.ts installs in the world, so the weapon is exposed to the
    // same key the terrain is. Direction is rotated into view space each frame.
    const sun = new THREE.DirectionalLight(0xfff4e2, 3.35);
    const bounce = new THREE.DirectionalLight(0x8fc4e0, 0.34);
    // Not a light source: an edge. Grazes the top and outboard silhouette so
    // the gun separates from a bright lake without being lifted off the world's
    // exposure.
    const rim = new THREE.DirectionalLight(0xfff2dc, 0.4);
    rim.position.set(-1.30, 0.85, -0.35);
    // The world's own ambient, copied verbatim each frame, with the one
    // justified boost: the terrain is a horizontal slab that sees half the sky
    // and shadows itself, while a rifle held out in front of you sees all of
    // it. Without this the weapon drifts to a different exposure than the
    // ground it is held over, which is the whole failure mode.
    const hemi = new THREE.HemisphereLight(0x9ccdf5, 0x4a6b62, 1.05);
    const HEMI_BOOST = 1.7;
    vmScene.add(sun, bounce, rim, hemi);

    // Every light aims at the weapon, not at the camera origin. Deliberately
    // no shadow map: the viewmodel is drawn from inside another scene's render
    // and a shadow pass would mean a render-target switch nested two deep.
    const lightPivot = new THREE.Object3D();
    lightPivot.position.set(0.12, -0.18, -0.62);
    vmScene.add(lightPivot);
    sun.target = lightPivot;
    bounce.target = lightPivot;
    rim.target = lightPivot;
    rim.position.add(lightPivot.position);

    const flashLight = new THREE.PointLight(0xffd9a0, 0, 3.2, 2);
    flashLight.visible = false;
    vmScene.add(flashLight);

    const rigRoot = new THREE.Group();
    vmScene.add(rigRoot);

    // ── shared materials ─────────────────────────────────────────────────
    const maps = surfaceMaps(texSize, ctx.rng, !low);
    const flare = flareTexture(low ? 64 : 128);
    const nScale = new THREE.Vector2(0.55, 0.55);

    const mats: MatSet = {
      // Gun polymer with a matte finish sits near 10% reflectance, not the 5%
      // of the raw resin — the texture on it is doing half the work.
      poly: new THREE.MeshStandardMaterial({
        color: lin(0.118, 0.121, 0.104),
        roughness: 0.70,
        metalness: 0.05,
        map: maps.albedo,
        roughnessMap: maps.rough,
        normalMap: maps.normal,
        normalScale: nScale,
        envMap: env,
        envMapIntensity: 1.5,
      }),
      steel: new THREE.MeshStandardMaterial({
        color: lin(0.62, 0.62, 0.64),
        // Below ~0.4 the thin rings and barrel edges return sub-pixel specular
        // slivers that clip to white and scintillate on any head movement.
        roughness: 0.46,
        metalness: 1,
        map: maps.albedo,
        roughnessMap: maps.rough,
        normalMap: maps.normal,
        normalScale: nScale,
        envMap: env,
        envMapIntensity: 1.3,
      }),
      // Parkerised furniture: dark, but a metal, so it picks the sky up.
      dark: new THREE.MeshStandardMaterial({
        color: lin(0.108, 0.108, 0.118),
        roughness: 0.56,
        metalness: 0.30,
        map: maps.albedo,
        roughnessMap: maps.rough,
        normalMap: maps.normal,
        normalScale: nScale,
        envMap: env,
        envMapIntensity: 1.4,
      }),
      // Stencilled unit markings and rail furniture: light enough to break the
      // receiver into panels, dark enough that the sun-blown lake behind it
      // does not turn them into white stickers.
      trim: new THREE.MeshStandardMaterial({
        color: lin(0.185, 0.190, 0.168),
        roughness: 0.60,
        metalness: 0.05,
        map: maps.albedo,
        envMap: env,
        envMapIntensity: 1.3,
      }),
      glass: new THREE.MeshStandardMaterial({
        color: lin(0.03, 0.07, 0.10),
        roughness: 0.10,
        metalness: 1,
        envMap: env,
        envMapIntensity: 1.4,
      }),
      glow: makeGlow(lin(2.4, 1.15, 0.22), 1),
      shell: new THREE.MeshStandardMaterial({
        color: lin(0.135, 0.125, 0.185),
        roughness: 0.38,
        metalness: 0.50,
        map: maps.albedo,
        roughnessMap: maps.rough,
        normalMap: maps.normal,
        normalScale: nScale,
        envMap: env,
        envMapIntensity: 1.4,
      }),
      // Mjolnir plate: olive over a dark undersuit.
      armor: new THREE.MeshStandardMaterial({
        color: lin(0.118, 0.132, 0.086),
        roughness: 0.54,
        metalness: 0.18,
        map: maps.albedo,
        roughnessMap: maps.rough,
        normalMap: maps.normal,
        normalScale: nScale,
        envMap: env,
        envMapIntensity: 1.5,
      }),
      glove: new THREE.MeshStandardMaterial({
        color: lin(0.062, 0.062, 0.068),
        roughness: 0.82,
        metalness: 0.05,
        map: maps.albedo,
        roughnessMap: maps.rough,
        envMap: env,
        envMapIntensity: 1.4,
      }),
    };

    const brass = new THREE.MeshStandardMaterial({
      color: lin(0.62, 0.44, 0.16),
      roughness: 0.40,
      metalness: 1,
      envMap: env,
      envMapIntensity: 0.9,
    });

    // ── muzzle flash ─────────────────────────────────────────────────────
    const flashGroup = new THREE.Group();
    flashGroup.visible = false;
    const flashMat = new THREE.MeshBasicMaterial({
      map: flare,
      color: lin(9, 6.0, 2.4),
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    const flashPlane = new THREE.PlaneGeometry(1, 1);
    const flashCards: THREE.Mesh[] = [];
    for (let i = 0; i < (low ? 2 : 3); i++) {
      const card = new THREE.Mesh(flashPlane, flashMat);
      card.rotation.z = (i / 3) * Math.PI;
      card.frustumCulled = false;
      flashGroup.add(card);
      flashCards.push(card);
    }
    const flashConeGeo = new THREE.ConeGeometry(0.05, 0.20, low ? 5 : 8, 1, true);
    flashConeGeo.rotateX(-Math.PI / 2);
    flashConeGeo.translate(0, 0, -0.08);
    const flashCone = new THREE.Mesh(flashConeGeo, flashMat);
    flashCone.frustumCulled = false;
    flashGroup.add(flashCone);
    vmScene.add(flashGroup);

    // ── shell casings ────────────────────────────────────────────────────
    const shellCount = low ? 4 : 10;
    const shellGeo = new THREE.CylinderGeometry(0.0042, 0.0046, 0.024, low ? 5 : 8);
    const shells = new THREE.InstancedMesh(shellGeo, brass, shellCount);
    shells.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    shells.frustumCulled = false;
    shells.count = shellCount;
    vmScene.add(shells);
    interface Shell {
      life: number;
      pos: THREE.Vector3;
      vel: THREE.Vector3;
      spin: THREE.Vector3;
      rot: THREE.Euler;
    }
    const shellPool: Shell[] = Array.from({ length: shellCount }, () => ({
      life: 0,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      spin: new THREE.Vector3(),
      rot: new THREE.Euler(),
    }));
    let shellCursor = 0;
    const hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < shellCount; i++) shells.setMatrixAt(i, hiddenMatrix);
    shells.instanceMatrix.needsUpdate = true;

    // ── rig construction ─────────────────────────────────────────────────
    const rigs = new Map<string, Rig>();

    function buildRig(def: WeaponDef): Rig {
      const make = RECIPES[def.id] ?? RECIPES.ar;
      const r = make();

      const root = new THREE.Group();
      const body = new THREE.Group();
      const mag = new THREE.Group();
      const bolt = new THREE.Group();
      const lhand = new THREE.Group();
      root.add(body, mag, bolt, lhand);
      root.visible = false;

      // Each rig gets its own emissive material so a plasma vent can flare
      // without the assault rifle's ammo counter flaring with it.
      const glowMat = makeGlow(r.glowColor, r.glowIntensity);
      const local: MatSet = { ...mats, glow: glowMat };

      const bins = [new Bin(segs), new Bin(segs), new Bin(segs), new Bin(segs)];
      for (const bin of bins) bin.setShift(r.shift[0], r.shift[1], r.shift[2]);
      r.emit(bins[0], bins[1], bins[2], bins[3]);

      const geoms = [
        ...bins[0].flush(body, local),
        ...bins[1].flush(mag, local),
        ...bins[2].flush(bolt, local),
        ...bins[3].flush(lhand, local),
      ];

      const muzzle = new THREE.Object3D();
      muzzle.position.set(r.muzzle[0] + r.shift[0], r.muzzle[1] + r.shift[1], r.muzzle[2] + r.shift[2]);
      body.add(muzzle);
      const eject = new THREE.Object3D();
      eject.position.set(r.eject[0] + r.shift[0], r.eject[1] + r.shift[1], r.eject[2] + r.shift[2]);
      body.add(eject);

      // Hip: right of centre and low, with the buttstock running off the
      // bottom-right corner rather than sitting in front of the eye. The yaw
      // turns the receiver far enough to read as a profile instead of a slab.
      const hipPos = new THREE.Vector3().fromArray(r.hip);
      const hipRot = new THREE.Euler(0.0, 0.145, -0.15);
      // ADS puts the sight line exactly on the camera axis.
      const adsPos = new THREE.Vector3(-r.shift[0], -(r.sightY + r.shift[1]), r.adsZ);
      const adsRot = new THREE.Euler(0, 0, 0);
      const sprintPos = new THREE.Vector3(hipPos.x + 0.075, hipPos.y - 0.075, hipPos.z + 0.055);
      const sprintRot = new THREE.Euler(-0.26, -0.60, 0.42);

      return {
        root,
        body,
        mag,
        bolt,
        lhand,
        muzzle,
        eject,
        hipPos,
        hipRot,
        adsPos,
        adsRot,
        sprintPos,
        sprintRot,
        reloadStyle: r.reloadStyle,
        kick: r.kick,
        ejects: r.ejects,
        hideAtAds: r.hideAtAds,
        glow: [glowMat],
        geoms,
        mats: [glowMat],
      };
    }

    function rigFor(def: WeaponDef): Rig {
      let rig = rigs.get(def.id);
      if (!rig) {
        rig = buildRig(def);
        rigs.set(def.id, rig);
        rigRoot.add(rig.root);
      }
      return rig;
    }

    for (const id of Object.keys(RECIPES)) rigFor(WEAPONS[id]);
    let current: Rig = rigFor(ctx.weapons.current.def);
    let currentDef: WeaponDef = ctx.weapons.current.def;
    current.root.visible = true;

    // ── animation state ──────────────────────────────────────────────────
    let lastYaw = ctx.player.yaw;
    let lastPitch = ctx.player.pitch;
    let swayX = 0;
    let swayY = 0;
    let bobPhase = 0;
    let sprintBlend = 0;
    let adsBlend = 0;
    let dip = 0;
    let dipVel = 0;
    let wasGrounded = true;
    let prevVy = 0;

    const recoilPos = new THREE.Vector3();
    const recoilVel = new THREE.Vector3();
    const recoilRot = new THREE.Vector3();
    const recoilRotVel = new THREE.Vector3();

    let reloadT = 0;
    let reloadDur = 0;
    let swapT = 0;
    let pendingDef: WeaponDef | null = null;
    let flashT = 0;
    let ventGlow = 0;

    const tmpPos = new THREE.Vector3();
    const tmpRot = new THREE.Vector3();
    const tmpQuat = new THREE.Quaternion();
    const poseQuat = new THREE.Quaternion();
    const otherQuat = new THREE.Quaternion();
    const poseEuler = new THREE.Euler();
    const tmpVec = new THREE.Vector3();
    const tmpMat = new THREE.Matrix4();
    const tmpScale = new THREE.Vector3(1, 1, 1);

    function fire(): void {
      const def = ctx.weapons.current.def;
      const k = current.kick;

      // Backwards along the bore, up, and a touch of roll — scaled by the
      // weapon's own recoil profile so the SPNKr genuinely shoves.
      recoilVel.z += 1.55 * k;
      recoilVel.y += 0.30 * k;
      recoilVel.x += (ctx.rng() - 0.5) * 0.35 * k;
      recoilRotVel.x += 4.6 * k;
      recoilRotVel.y += (ctx.rng() - 0.5) * 2.2 * k;
      recoilRotVel.z += (ctx.rng() - 0.5) * 2.6 * k;

      flashT = def.flavor === "explosive" ? 0.085 : 0.055;
      flashGroup.rotation.z = ctx.rng() * Math.PI * 2;
      const s = def.flavor === "explosive" ? 2.0 : def.flavor === "plasma" ? 0.85 : 1;
      flashGroup.scale.setScalar(s * (0.85 + ctx.rng() * 0.3));
      flashMat.color.copy(
        def.flavor === "plasma"
          ? lin(2.0, 8.0, 12.0)
          : def.flavor === "explosive"
            ? lin(14, 5.5, 1.2)
            : lin(9, 6.0, 2.4),
      );
      flashLight.color.copy(flashMat.color).multiplyScalar(1 / Math.max(1, flashMat.color.r));

      if (current.ejects) spawnShell();
    }

    function spawnShell(): void {
      const s = shellPool[shellCursor];
      shellCursor = (shellCursor + 1) % shellCount;
      s.life = 1;
      current.eject.getWorldPosition(s.pos);
      s.vel.set(1.5 + ctx.rng() * 0.7, 1.0 + ctx.rng() * 0.5, 0.5 + ctx.rng() * 0.6);
      s.spin.set((ctx.rng() - 0.5) * 30, (ctx.rng() - 0.5) * 30, (ctx.rng() - 0.5) * 30);
      s.rot.set(ctx.rng() * 3, ctx.rng() * 3, ctx.rng() * 3);
    }

    const offFired = bus.on("weapon:fired", fire);
    const offReload = bus.on("weapon:reload", ({ duration }) => {
      reloadDur = duration;
      reloadT = duration;
    });
    const offChanged = bus.on("weapon:changed", () => {
      const def = ctx.weapons.current.def;
      if (def.id === currentDef.id) return;
      pendingDef = def;
      swapT = 0.5;
      reloadT = 0;
    });

    // ── the composite hook ───────────────────────────────────────────────
    //
    // The right place for this is an Engine-side pass between GTAO and bloom.
    // Until that exists, the weapon is composited from `scene.onAfterRender` at
    // the end of AtmospherePass's scene render, and is *also* drawn into GTAO's
    // depth/normal prepasses so world occlusion is not painted over it.
    let armed = false;

    function drawViewmodel(renderer: THREE.WebGLRenderer, override: THREE.Material | null): void {
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      vmScene.overrideMaterial = override;
      renderer.render(vmScene, vmCamera);
      vmScene.overrideMaterial = null;
      renderer.autoClear = autoClear;
    }

    type AfterRender = THREE.Scene["onAfterRender"];
    const prevAfterRender = ctx.scene.onAfterRender as AfterRender | undefined;
    const hook = ((renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) => {
      (prevAfterRender as unknown as ((...a: unknown[]) => void) | undefined)?.call(
        scene,
        renderer,
        scene,
        camera,
      );
      // The water reflection renders the same scene from a different camera.
      if (camera !== ctx.camera) return;
      if (scene.overrideMaterial) {
        drawViewmodel(renderer, scene.overrideMaterial);
        return;
      }
      if (!armed) return;
      armed = false;
      drawViewmodel(renderer, null);
    }) as unknown as AfterRender;
    ctx.scene.onAfterRender = hook;

    /**
     * Squash the viewmodel's whole depth range into the first 2% of the buffer
     * so it can never lose the depth test to world geometry, while still
     * self-occluding and still leaving usable depth for the atmosphere pass.
     * ndc' = EPS * ndc + (EPS - 1), folded into the projection's z row.
     */
    const DEPTH_SQUASH = 0.02;
    function refreshProjection(fov: number, aspect: number): void {
      vmCamera.fov = fov;
      vmCamera.aspect = aspect;
      vmCamera.updateProjectionMatrix();
      const e = vmCamera.projectionMatrix.elements;
      e[10] = DEPTH_SQUASH * e[10] - DEPTH_SQUASH + 1;
      e[14] = DEPTH_SQUASH * e[14];
      vmCamera.projectionMatrixInverse.copy(vmCamera.projectionMatrix).invert();
    }
    refreshProjection(BASE_FOV, ctx.camera.aspect);
    let lastFov = -1;
    let lastAspect = -1;

    // ── per-frame ────────────────────────────────────────────────────────
    function update(dt: number, elapsed: number): void {
      const player = ctx.player;
      const w = ctx.weapons.current;
      const dbg = (window as unknown as { __VIEWMODEL__?: ViewmodelDebug }).__VIEWMODEL__;

      // --- weapon swap: lower the old, raise the new ---
      if (swapT > 0) {
        swapT = Math.max(0, swapT - dt);
        const p = 1 - swapT / 0.5;
        if (pendingDef && p >= 0.5) {
          current.root.visible = false;
          currentDef = pendingDef;
          pendingDef = null;
          current = rigFor(currentDef);
          current.root.visible = true;
          recoilPos.set(0, 0, 0);
          recoilVel.set(0, 0, 0);
          recoilRot.set(0, 0, 0);
          recoilRotVel.set(0, 0, 0);
        }
      }
      const swapP = swapT > 0 ? 1 - swapT / 0.5 : 1;
      const swapDown = swapT > 0 ? (swapP < 0.5 ? smooth(swapP * 2) : 1 - smooth((swapP - 0.5) * 2)) : 0;

      // --- ADS ---
      adsBlend = dbg && typeof dbg.ads === "number" ? dbg.ads : w.ads;
      const adsE = smooth(adsBlend);

      // --- sprint ---
      const sprinting = player.sprinting && adsBlend < 0.15 && reloadT <= 0 && swapT <= 0;
      sprintBlend += ((sprinting ? 1 : 0) - sprintBlend) * Math.min(1, dt * 9);

      // --- look lag: the weapon trails the camera, then catches up ---
      const dYaw = angleDelta(player.yaw, lastYaw);
      const dPitch = player.pitch - lastPitch;
      lastYaw = player.yaw;
      lastPitch = player.pitch;
      swayX += dYaw * 1.15;
      swayY += dPitch * 1.15;
      const settle = 1 - Math.exp(-9.5 * dt);
      swayX -= swayX * settle;
      swayY -= swayY * settle;
      swayX = THREE.MathUtils.clamp(swayX, -0.34, 0.34);
      swayY = THREE.MathUtils.clamp(swayY, -0.30, 0.30);

      // --- bob, phase-locked to the same rate the head bob uses ---
      const speed = Math.hypot(player.velocity.x, player.velocity.z);
      const moving = player.grounded && speed > 0.6;
      const bobRate = player.sprinting ? 13.5 : 9.6;
      if (moving) bobPhase += dt * bobRate;
      const bobAmp =
        THREE.MathUtils.clamp(speed / Math.max(1, player.config.walkSpeed), 0, 1.7) *
        (player.sprinting ? 1.5 : 1) *
        (1 - adsE * 0.72);
      const bobFade = moving ? 1 : Math.max(0, 1 - dt * 6);
      const bx = Math.cos(bobPhase) * 0.020 * bobAmp * bobFade;
      const by = (Math.abs(Math.sin(bobPhase)) - 0.5) * 0.018 * bobAmp * bobFade;
      const bz = Math.sin(bobPhase * 2) * 0.009 * bobAmp * bobFade;
      const bRoll = Math.cos(bobPhase) * 0.050 * bobAmp * bobFade;

      // --- idle breathing ---
      const idle = (1 - Math.min(1, speed)) * (1 - adsE * 0.6);
      const breatheX = Math.sin(elapsed * 0.9) * 0.0045 * idle;
      const breatheY = Math.sin(elapsed * 1.37 + 1.1) * 0.0055 * idle;

      // --- jump / landing dip ---
      if (wasGrounded && !player.grounded && prevVy > 1) dipVel -= 1.9;
      if (!wasGrounded && player.grounded && prevVy < -3.5)
        dipVel += THREE.MathUtils.clamp(-prevVy * 0.55, 0, 9);
      wasGrounded = player.grounded;
      prevVy = player.velocity.y;
      // Semi-implicit, sub-stepped: an explicit spring this stiff blows up at
      // the 50 ms frames the engine allows itself on a bad hitch.
      const dipSteps = Math.max(1, Math.ceil(dt / 0.012));
      const dipDt = dt / dipSteps;
      for (let i = 0; i < dipSteps; i++) {
        dipVel += (-dip * 220 - dipVel * 21) * dipDt;
        dip += dipVel * dipDt;
      }
      dip = THREE.MathUtils.clamp(dip, -0.09, 0.11);
      dipVel = THREE.MathUtils.clamp(dipVel, -9, 9);

      // --- recoil spring ---
      const stiff = 165 + current.kick * 25;
      const steps = Math.max(1, Math.ceil(dt / 0.012));
      const sdt = dt / steps;
      for (let i = 0; i < steps; i++) {
        for (const [v, a, k] of [
          [recoilPos, recoilVel, stiff] as const,
          [recoilRot, recoilRotVel, stiff * 1.25] as const,
        ]) {
          const d = 2 * Math.sqrt(k) * 0.72;
          a.x += (-v.x * k - a.x * d) * sdt;
          a.y += (-v.y * k - a.y * d) * sdt;
          a.z += (-v.z * k - a.z * d) * sdt;
          v.addScaledVector(a, sdt);
        }
      }

      // --- reload / vent timeline ---
      const rPos = tmpPos.set(0, 0, 0);
      const rRot = tmpRot.set(0, 0, 0);
      const mag = current.mag;
      const bolt = current.bolt;
      const lhand = current.lhand;
      mag.position.set(0, 0, 0);
      mag.rotation.set(0, 0, 0);
      bolt.position.set(0, 0, 0);
      lhand.position.set(0, 0, 0);
      lhand.rotation.set(0, 0, 0);
      ventGlow = 0;

      if (reloadT > 0) {
        reloadT = Math.max(0, reloadT - dt);
        const t = reloadDur > 0 ? 1 - reloadT / reloadDur : 1;
        const tilt = smooth(seg(t, 0, 0.16)) - smooth(seg(t, 0.84, 1));

        if (current.reloadStyle === "mag") {
          rRot.set(-0.34 * tilt, 0.30 * tilt, 0.58 * tilt);
          rPos.set(0.030 * tilt, -0.070 * tilt, 0.040 * tilt);
          const drop = seg(t, 0.13, 0.34);
          const insert = seg(t, 0.40, 0.62);
          mag.position.y = drop < 1 ? -0.34 * drop * drop : -0.34 * (1 - smooth(insert));
          mag.position.z = drop < 1 ? 0.05 * drop * drop : 0.05 * (1 - smooth(insert));
          mag.rotation.x = drop < 1 ? 0.9 * drop : 0.45 * (1 - smooth(insert));
          // The support hand goes with it: down out of frame for the fresh mag,
          // back up onto the handguard as the bolt is released.
          const away = smooth(seg(t, 0.10, 0.30)) - smooth(seg(t, 0.62, 0.82));
          lhand.position.set(0.02 * away, -0.30 * away, 0.14 * away);
          lhand.rotation.set(0.5 * away, 0.35 * away, 0);
          rPos.y -= 0.014 * hump(t, 0.60, 0.68);
          bolt.position.z = 0.048 * hump(t, 0.72, 0.88);
          rPos.z += 0.020 * hump(t, 0.72, 0.80);
        } else if (current.reloadStyle === "vent") {
          // Battery weapons do not reload — they crack open and dump heat.
          rRot.set(0.12 * tilt, 0.95 * tilt, -0.95 * tilt);
          rPos.set(-0.075 * tilt, -0.045 * tilt, 0.055 * tilt);
          ventGlow = 2.8 * (smooth(seg(t, 0.12, 0.34)) - smooth(seg(t, 0.55, 0.92)));
          const away = smooth(seg(t, 0.14, 0.32)) - smooth(seg(t, 0.66, 0.88));
          lhand.position.set(-0.05 * away, -0.10 * away, 0.16 * away);
          lhand.rotation.set(0.2 * away, -0.5 * away, 0);
          rPos.x -= 0.012 * hump(t, 0.30, 0.40);
        } else {
          rRot.set(-0.55 * tilt, 0.30 * tilt, 0.20 * tilt);
          rPos.set(0.030 * tilt, -0.100 * tilt, 0.070 * tilt);
          const out = seg(t, 0.16, 0.40);
          const back = seg(t, 0.52, 0.80);
          mag.position.z = -0.34 * smooth(out) + 0.34 * smooth(back);
          const away = smooth(seg(t, 0.12, 0.34)) - smooth(seg(t, 0.60, 0.84));
          lhand.position.set(0.03 * away, -0.26 * away, 0.10 * away);
          lhand.rotation.set(0.45 * away, 0.2 * away, 0);
          rPos.y -= 0.018 * hump(t, 0.80, 0.92);
        }
      }

      // --- compose the pose ---
      const rig = current;
      tmpVec.copy(rig.hipPos).lerp(rig.adsPos, adsE);
      poseQuat.setFromEuler(rig.hipRot);
      otherQuat.setFromEuler(rig.adsRot);
      poseQuat.slerp(otherQuat, adsE);

      const sB = sprintBlend * (1 - adsE);
      tmpVec.lerp(rig.sprintPos, sB);
      otherQuat.setFromEuler(rig.sprintRot);
      poseQuat.slerp(otherQuat, sB);

      const swayScale = 1 - adsE * 0.7;
      tmpVec.x += (bx + breatheX - swayX * 0.10) * swayScale;
      tmpVec.y += (by + breatheY + swayY * 0.10 - dip) * swayScale;
      tmpVec.z += bz * swayScale;
      tmpVec.x += rPos.x + recoilPos.x * 0.026;
      tmpVec.y += rPos.y + recoilPos.y * 0.026 - swapDown * 0.34;
      tmpVec.z += rPos.z + recoilPos.z * 0.055;

      rig.root.position.copy(tmpVec);

      poseEuler.setFromQuaternion(poseQuat);
      poseEuler.x += recoilRot.x * 0.055 + rRot.x - swayY * 0.55 * swayScale - dip * 1.6 - swapDown * 0.85;
      poseEuler.y += recoilRot.y * 0.02 + rRot.y - swayX * 0.85 * swayScale;
      poseEuler.z += recoilRot.z * 0.02 + rRot.z + bRoll * swayScale + swayX * 0.45 * swayScale;
      rig.root.rotation.copy(poseEuler);
      if (dbg?.pose) {
        rig.root.position.set(dbg.pose[0], dbg.pose[1], dbg.pose[2]);
        rig.root.rotation.set(dbg.pose[3], dbg.pose[4], dbg.pose[5]);
      }

      // Scoped weapons hand over to the world FOV rather than float in it.
      rig.root.visible = !player.dead && !(rig.hideAtAds && adsBlend > 0.9) && !dbg?.hide;

      // --- emissives ---
      for (const g of rig.glow) {
        g.emissiveIntensity = 1 + ventGlow + (rig.reloadStyle === "vent" ? Math.sin(elapsed * 2.1) * 0.12 : 0);
      }

      // --- muzzle flash ---
      if (flashT > 0) {
        flashT = Math.max(0, flashT - dt);
        const f = flashT / 0.055;
        flashGroup.visible = true;
        rig.muzzle.updateWorldMatrix(true, false);
        flashGroup.position.setFromMatrixPosition(rig.muzzle.matrixWorld);
        flashGroup.quaternion.setFromRotationMatrix(rig.muzzle.matrixWorld);
        const size = 0.44 * (0.45 + f * 0.65);
        for (const card of flashCards) card.scale.setScalar(size);
        flashCone.scale.set(0.9 + f * 0.5, 0.9 + f * 0.5, 0.7 + f * 1.4);
        flashMat.opacity = Math.min(1, f);
        flashLight.position.copy(flashGroup.position);
        flashLight.intensity = 26 * f * f;
        flashLight.visible = true;
      } else if (flashGroup.visible) {
        flashGroup.visible = false;
        flashLight.visible = false;
      }

      // --- shells ---
      let anyShell = false;
      for (let i = 0; i < shellCount; i++) {
        const s = shellPool[i];
        if (s.life <= 0) {
          shells.setMatrixAt(i, hiddenMatrix);
          continue;
        }
        anyShell = true;
        s.life -= dt * 1.6;
        s.vel.y -= 5.5 * dt;
        s.pos.addScaledVector(s.vel, dt);
        s.rot.x += s.spin.x * dt;
        s.rot.y += s.spin.y * dt;
        s.rot.z += s.spin.z * dt;
        tmpQuat.setFromEuler(s.rot);
        tmpScale.setScalar(s.life > 0 ? 1 : 0);
        tmpMat.compose(s.pos, tmpQuat, tmpScale);
        shells.setMatrixAt(i, s.life > 0 ? tmpMat : hiddenMatrix);
      }
      if (anyShell || shells.instanceMatrix.needsUpdate) shells.instanceMatrix.needsUpdate = true;

      // --- lighting: rotate the world sun into view space ---
      ctx.camera.updateWorldMatrix(true, false);
      tmpQuat.setFromRotationMatrix(ctx.camera.matrixWorld).invert();
      tmpVec.copy(ctx.sky.sunDirection).applyQuaternion(tmpQuat);
      sun.position.copy(lightPivot.position).addScaledVector(tmpVec, 4);
      sun.color.copy(ctx.sky.sun.color);
      sun.intensity = ctx.sky.sun.intensity;
      hemi.color.copy(ctx.sky.hemi.color);
      hemi.groundColor.copy(ctx.sky.hemi.groundColor);
      hemi.intensity = ctx.sky.hemi.intensity * HEMI_BOOST;
      bounce.position.set(
        lightPivot.position.x - tmpVec.x * 3,
        lightPivot.position.y - Math.abs(tmpVec.y) * 3 - 1,
        lightPivot.position.z - tmpVec.z * 3,
      );

      // --- projection: constant viewmodel FOV, tightening slightly on ADS ---
      const fov = (dbg && typeof dbg.fov === "number" ? dbg.fov : BASE_FOV) - adsE * 6;
      if (Math.abs(fov - lastFov) > 0.01 || Math.abs(ctx.camera.aspect - lastAspect) > 1e-4) {
        lastFov = fov;
        lastAspect = ctx.camera.aspect;
        refreshProjection(fov, ctx.camera.aspect);
      }

      armed = true;
    }

    return {
      update,
      dispose() {
        ctx.scene.onAfterRender = (prevAfterRender ?? (() => {})) as AfterRender;
        offFired();
        offReload();
        offChanged();
        for (const rig of rigs.values()) {
          for (const g of rig.geoms) g.dispose();
          for (const m of rig.mats) m.dispose();
        }
        rigs.clear();
        for (const m of Object.values(mats)) m.dispose();
        brass.dispose();
        flashMat.dispose();
        flashPlane.dispose();
        flashConeGeo.dispose();
        shellGeo.dispose();
        shells.dispose();
        maps.dispose();
        flare.dispose();
        probe.dispose();
      },
    };
  },
};

export default mod;
