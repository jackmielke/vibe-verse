/**
 * San Palmas — weapons.
 *
 * Viewmodel, ballistics and feel. Everything here is generated at boot:
 * the guns are extruded/bevelled geometry built in code, the gunmetal and
 * polymer surfaces are Canvas2D noise baked to CanvasTextures, and the only
 * external dependency is the service registry.
 *
 * ── Architecture ──────────────────────────────────────────────────────────
 * The arsenal is pure data (`ARSENAL`). A `WeaponDef` describes role, fire
 * mode, ballistics, recoil pattern, reload timings and which builder assembles
 * its mesh, so adding a seventh gun is a data entry plus a builder function.
 *
 * ── Viewmodel clipping ────────────────────────────────────────────────────
 * The classic failure mode of an FPS viewmodel is punching through a wall.
 * We solve it geometrically rather than with a second camera pass, because the
 * post-processing stack owns the render override and we refuse to fight it for
 * the frame.
 *
 * The player is a capsule of radius 0.42 m and `collision.resolveCapsule`
 * guarantees no world collider ever gets closer than that to the player's
 * axis — which the eye sits on. So anything that stays inside a 0.40 m sphere
 * centred on the eye is *provably* unable to intersect the world. Each rig is
 * therefore auto-fitted at build time (`fitViewmodelScale`) — we bisect its
 * scale until every bounding-box corner, in every pose it can reach, lies
 * inside that sphere and outside the near plane. Belt and braces: a forward
 * probe ray tucks the weapon against walls, which is good feel anyway.
 *
 * ── Camera ownership ──────────────────────────────────────────────────────
 * The player owns pitch/yaw. We layer recoil, shake and FOV on top in
 * `lateUpdate` (after the player has written the camera), and fire along the
 * *kicked* orientation so recoil genuinely moves the bullets, not just the
 * picture. Because the engine clears `input.lookX/lookY` after the frame we
 * cannot push aim punch back into the controller; instead the kick springs
 * back on its own — the modern "recoil recovery" model.
 *
 * ── Audio names this module asks for ──────────────────────────────────────
 * pistol, rifle, shotgun, rocket, minigun, railgun, railCharge, dryFire,
 * magOut, magIn, boltBack, boltForward, pump, shellDrop, weaponSwitch,
 * spinUp, spinDown, hitmarker, explosion, whizz.
 */
import * as THREE from "three";
import type {
  ImpactMaterial,
  QualityTier,
  RayHit,
  System,
  SystemFactory,
  WorldCtx,
} from "../types";

// ───────────────────────────────────────────────────────────────────────────
// Tunables
// ───────────────────────────────────────────────────────────────────────────

/**
 * The clearance volume the viewmodel must never leave, expressed relative to
 * the eye. It is deliberately capsule-shaped rather than spherical because the
 * player's collider is a capsule: `resolveCapsule` guarantees no collider gets
 * within 0.42 m of the player axis *horizontally* at any height the capsule
 * spans, so horizontal reach is the binding constraint and hanging the weapon
 * below the eye costs nothing. `SAFE_DOWN`/`SAFE_UP` still bound it so we
 * cannot poke through a floor or a low ceiling.
 */
const SAFE_H = 0.375;
const SAFE_DOWN = 0.55;
const SAFE_UP = 0.12;
/** Minimum distance in front of the camera any viewmodel vertex may sit. */
const NEAR_MARGIN = 0.095;
/** How far in front of the eye the sight line sits when aiming. */
const ADS_Z = -0.19;
/** Base field of view the player controller settles on when standing still. */
const BASE_FOV = 68;
const WALK_SPEED = 6.2;
const SPRINT_SPEED = 11.5;

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, -1);

// Scratch. Nothing in the update path allocates.
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
// Private to firstTargetAlong / hitscan. Kept separate from the general
// scratch pool because those two nest, and sharing them silently aliases the
// caller's `origin` argument.
const _ta = new THREE.Vector3();
const _tb = new THREE.Vector3();
const _hs = new THREE.Vector3();
/**
 * Reusable RayHit for terrain impacts. `CollisionService.raycast` allocates its
 * own, but terrain is marched here and a 1450 rpm minigun would otherwise
 * produce 24 throwaway hits and 48 vectors a second.
 */
const _terrainHit: RayHit = {
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(0, 1, 0),
  distance: 0,
  tag: "dirt",
};
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e1 = new THREE.Euler(0, 0, 0, "YXZ");
const _mat4 = new THREE.Matrix4();
const _box = new THREE.Box3();

/** Frame-rate independent exponential approach. */
function approach(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

// ───────────────────────────────────────────────────────────────────────────
// Procedural textures — Canvas2D, no assets on disk
// ───────────────────────────────────────────────────────────────────────────

function makeCanvas(size: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  return { c, g: c.getContext("2d")! };
}

/**
 * Brushed gunmetal: horizontal machining grain plus a scatter of scratches.
 * Used as a roughness map so the highlight streaks along the receiver.
 */
function makeMetalRoughness(rng: () => number, size = 256): THREE.CanvasTexture {
  const { c, g } = makeCanvas(size);
  g.fillStyle = "#6a6a6a";
  g.fillRect(0, 0, size, size);
  // Machining grain.
  for (let i = 0; i < size * 3; i++) {
    const y = rng() * size;
    const l = 20 + rng() * size;
    const v = 90 + rng() * 90;
    g.strokeStyle = `rgba(${v},${v},${v},0.16)`;
    g.lineWidth = 0.6 + rng() * 1.4;
    g.beginPath();
    g.moveTo(rng() * size, y);
    g.lineTo(rng() * size + l, y + (rng() - 0.5) * 2);
    g.stroke();
  }
  // Scratches — a few brighter, deeper marks.
  for (let i = 0; i < 40; i++) {
    g.strokeStyle = `rgba(220,220,220,${0.1 + rng() * 0.22})`;
    g.lineWidth = 0.5 + rng();
    g.beginPath();
    const x = rng() * size;
    const y = rng() * size;
    g.moveTo(x, y);
    g.lineTo(x + (rng() - 0.5) * 90, y + (rng() - 0.5) * 26);
    g.stroke();
  }
  // Blotchy wear so edges read as polished.
  for (let i = 0; i < 90; i++) {
    const r = 4 + rng() * 26;
    const grd = g.createRadialGradient(rng() * size, rng() * size, 0, 0, 0, 1);
    void grd;
    g.fillStyle = `rgba(${40 + rng() * 40 | 0},${40 + rng() * 40 | 0},${40 + rng() * 40 | 0},0.06)`;
    g.beginPath();
    g.arc(rng() * size, rng() * size, r, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.anisotropy = 4;
  return tex;
}

/** Stippled polymer — the moulded, slightly matte grip/handguard surface. */
function makePolymerRoughness(rng: () => number, size = 256): THREE.CanvasTexture {
  const { c, g } = makeCanvas(size);
  g.fillStyle = "#b4b4b4";
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 9000; i++) {
    const v = 140 + rng() * 110;
    g.fillStyle = `rgba(${v},${v},${v},0.35)`;
    g.fillRect(rng() * size, rng() * size, 1 + rng() * 2, 1 + rng() * 2);
  }
  // Moulded checkering, so the grip catches light in a pattern.
  g.strokeStyle = "rgba(70,70,70,0.35)";
  g.lineWidth = 1;
  for (let i = -size; i < size * 2; i += 9) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + size, size);
    g.stroke();
    g.beginPath();
    g.moveTo(i + size, 0);
    g.lineTo(i, size);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  return tex;
}

/** Additive muzzle-flash star: hot core, four-point flare, soft halo. */
function makeFlashSprite(size = 128): THREE.CanvasTexture {
  const { c, g } = makeCanvas(size);
  const h = size / 2;
  g.clearRect(0, 0, size, size);
  const halo = g.createRadialGradient(h, h, 0, h, h, h);
  halo.addColorStop(0, "rgba(255,250,225,1)");
  halo.addColorStop(0.18, "rgba(255,214,130,0.92)");
  halo.addColorStop(0.45, "rgba(255,140,40,0.32)");
  halo.addColorStop(1, "rgba(255,90,10,0)");
  g.fillStyle = halo;
  g.fillRect(0, 0, size, size);
  // Star points.
  g.globalCompositeOperation = "lighter";
  for (let i = 0; i < 4; i++) {
    g.save();
    g.translate(h, h);
    g.rotate((i * Math.PI) / 4 + Math.PI / 8);
    const spike = g.createLinearGradient(0, 0, h, 0);
    spike.addColorStop(0, "rgba(255,255,240,0.95)");
    spike.addColorStop(1, "rgba(255,160,60,0)");
    g.fillStyle = spike;
    g.beginPath();
    g.moveTo(0, -h * 0.07);
    g.lineTo(h, 0);
    g.lineTo(0, h * 0.07);
    g.closePath();
    g.fill();
    g.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ───────────────────────────────────────────────────────────────────────────
// Geometry helpers — real bevels, not boxes
// ───────────────────────────────────────────────────────────────────────────

function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = w / 2;
  const y = h / 2;
  const c = Math.max(0.0004, Math.min(r, x * 0.85, y * 0.85));
  s.moveTo(-x + c, -y);
  s.lineTo(x - c, -y);
  s.quadraticCurveTo(x, -y, x, -y + c);
  s.lineTo(x, y - c);
  s.quadraticCurveTo(x, y, x - c, y);
  s.lineTo(-x + c, y);
  s.quadraticCurveTo(-x, y, -x, y - c);
  s.lineTo(-x, -y + c);
  s.quadraticCurveTo(-x, -y, -x + c, -y);
  return s;
}

/**
 * A box with a genuine chamfer on all twelve edges, centred on the origin and
 * extruded along Z. This is the workhorse — receivers, handguards, stocks and
 * magazines are all bevelled boxes with different proportions.
 */
function bevelBox(w: number, h: number, d: number, bevel = 0.004, corner = 0.006): THREE.BufferGeometry {
  const b = Math.max(0.0006, Math.min(bevel, w * 0.28, h * 0.28, d * 0.28));
  const shape = roundedRect(w - 2 * b, h - 2 * b, corner);
  const depth = d - 2 * b;
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: 1,
    curveSegments: 2,
    steps: 1,
  });
  geo.translate(0, 0, -depth / 2);
  geo.computeVertexNormals();
  return geo;
}

/** Barrel/tube along Z (three's cylinders default to Y, so we rotate). */
function tube(rTop: number, rBottom: number, len: number, seg = 12, open = false): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(rTop, rBottom, len, seg, 1, open);
  geo.rotateX(Math.PI / 2);
  return geo;
}

/** Rounded slab used for cheek risers, foregrips and shrouds. */
function capsuleBox(w: number, h: number, d: number): THREE.BufferGeometry {
  return bevelBox(w, h, d, Math.min(w, h) * 0.24, Math.min(w, h) * 0.3);
}

// ───────────────────────────────────────────────────────────────────────────
// Material kit — shared across every weapon so we pay for them once
// ───────────────────────────────────────────────────────────────────────────

interface Kit {
  gunmetal: THREE.MeshStandardMaterial;
  darkSteel: THREE.MeshStandardMaterial;
  polymer: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  brass: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  reticle: THREE.MeshBasicMaterial;
  glow: THREE.MeshStandardMaterial;
  textures: THREE.Texture[];
  materials: THREE.Material[];
  geometries: THREE.BufferGeometry[];
  /** Track a geometry so dispose() can reach it. */
  geo<T extends THREE.BufferGeometry>(g: T): T;
}

function makeKit(rng: () => number): Kit {
  const metalRough = makeMetalRoughness(rng);
  const polyRough = makePolymerRoughness(rng);

  const gunmetal = new THREE.MeshStandardMaterial({
    color: 0x5c6167,
    metalness: 0.94,
    roughness: 0.4,
    roughnessMap: metalRough,
    envMapIntensity: 1.1,
  });
  const darkSteel = new THREE.MeshStandardMaterial({
    color: 0x2a2d31,
    metalness: 0.88,
    roughness: 0.52,
    roughnessMap: metalRough,
  });
  const polymer = new THREE.MeshStandardMaterial({
    color: 0x24262a,
    metalness: 0.04,
    roughness: 0.78,
    roughnessMap: polyRough,
  });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x141518, metalness: 0.0, roughness: 0.95 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xc9a24a, metalness: 1.0, roughness: 0.3 });
  const accent = new THREE.MeshStandardMaterial({
    // Tropical anodising — this is San Palmas, the hardware is not grey-on-grey.
    color: 0x1f7a6a,
    metalness: 0.75,
    roughness: 0.34,
  });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x8fd8ff,
    metalness: 0.2,
    roughness: 0.06,
    transparent: true,
    opacity: 0.36,
  });
  const reticle = new THREE.MeshBasicMaterial({ color: 0xff5533, toneMapped: false });
  const glow = new THREE.MeshStandardMaterial({
    color: 0x0a2b33,
    emissive: new THREE.Color(0x35f0ff),
    emissiveIntensity: 0.2,
    metalness: 0.6,
    roughness: 0.3,
  });

  const materials = [gunmetal, darkSteel, polymer, rubber, brass, accent, glass, reticle, glow];
  const geometries: THREE.BufferGeometry[] = [];
  return {
    gunmetal,
    darkSteel,
    polymer,
    rubber,
    brass,
    accent,
    glass,
    reticle,
    glow,
    textures: [metalRough, polyRough],
    materials,
    geometries,
    geo<T extends THREE.BufferGeometry>(g: T): T {
      geometries.push(g);
      return g;
    },
  };
}

/** Add a mesh with position/rotation in one call — keeps builders readable. */
function part(
  parent: THREE.Object3D,
  kit: Kit,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
  rx = 0,
  ry = 0,
  rz = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(kit.geo(geo), mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = false;
  m.receiveShadow = false;
  m.frustumCulled = false;
  parent.add(m);
  return m;
}

// ───────────────────────────────────────────────────────────────────────────
// Weapon data
// ───────────────────────────────────────────────────────────────────────────

type FireMode = "semi" | "auto" | "pump" | "spin" | "charge";
type Ballistic = "hitscan" | "rocket";
type ShellKind = "none" | "brass" | "shotgun";

/**
 * Every field is a *peak* displacement — metres or radians at the top of the
 * spring's first swing. `fireShot` converts them into impulses using the
 * spring's own natural frequency, so retuning stiffness never silently
 * changes how far the gun kicks.
 */
interface RecoilProfile {
  /** Viewmodel kick: metres back, radians of muzzle climb, radians of roll. */
  back: number;
  vmPitch: number;
  vmYaw: number;
  vmRoll: number;
  /** Camera kick in radians. */
  camPitch: number;
  camYaw: number;
  /** Positional camera shake, metres. */
  shake: number;
  /**
   * Per-shot multipliers [yaw, pitch]. Cycled by shot index so a burst traces
   * a learnable path, then jittered by `jitter` so it never reads as canned.
   */
  pattern: [number, number][];
  jitter: number;
  /** Spring constants for the recovery. Higher = snappier. */
  stiffness: number;
  damping: number;
}

interface WeaponDef {
  id: string;
  name: string;
  /** Short tag for the HUD. */
  short: string;
  slot: number;
  role: string;

  ballistic: Ballistic;
  mode: FireMode;
  /** Rounds per minute (for `charge`, the post-shot cooldown). */
  rpm: number;
  damage: number;
  pellets: number;
  /** Hitscan reach, metres. */
  range: number;
  /** Pierce this many actors before stopping (railgun). */
  pierce: number;

  /** Cone half-angle in radians. */
  spread: number;
  spreadAds: number;
  /** Extra cone while moving/airborne, scaled by speed. */
  spreadMove: number;
  /** Bloom added per shot, and how fast it bleeds off. */
  bloom: number;
  bloomDecay: number;
  bloomMax: number;

  magSize: number;
  reserveMax: number;
  reload: number;
  /** Fraction of the reload spent on drop / insert / charge. */
  reloadBeats: [number, number, number];

  recoil: RecoilProfile;

  /** Slide/bolt travel in metres, and how long a full cycle takes. */
  slideTravel: number;
  slideTime: number;
  shell: ShellKind;
  shellEjectSpeed: number;

  /** Optional behaviours. */
  spinUp?: number;
  spinDown?: number;
  chargeTime?: number;
  rocket?: { speed: number; gravity: number; drag: number; radius: number; force: number; fuse: number };

  adsAllowed: boolean;
  adsTime: number;
  adsFov: number;
  /** How heavy it feels: drives sway lag, bob amplitude and swap speed. */
  weight: number;
  swapTime: number;

  sound: string;
  soundVolume: number;
  /** Suppressed weapons get a tiny flash and a quiet report. */
  flashScale: number;
  tracerEvery: number;

  build: (kit: Kit) => Rig;
  /** Hip-fire pose, metres in camera space. Auto-fit shrinks the mesh to suit. */
  hip: [number, number, number];
  hipRot: [number, number, number];
  designScale: number;
}

/** The animatable handles a builder must hand back. */
interface Rig {
  root: THREE.Group;
  /** Everything that recoils as one mass. */
  body: THREE.Group;
  /** Reciprocating mass: slide, bolt carrier, pump. */
  slide: THREE.Object3D | null;
  /** Detachable magazine — animated out and back during a reload. */
  mag: THREE.Object3D | null;
  /** Muzzle tip; flash and projectile origin. */
  muzzle: THREE.Object3D;
  /** Ejection port. */
  eject: THREE.Object3D;
  /** Sight line — ADS aligns this with screen centre. */
  optic: THREE.Object3D;
  /** Spinning barrel cluster, if any. */
  barrels: THREE.Object3D | null;
  /** Material we may pulse for charge/heat. */
  emissive: THREE.MeshStandardMaterial | null;
}

// ── Builders ───────────────────────────────────────────────────────────────
// Local space: -Z is downrange, +Y up, +X right. Real-world metres; the
// auto-fitter scales the whole thing down to viewmodel size afterwards.

/** Trigger group shared by every gun: guard loop, blade, grip. */
function addTriggerGroup(parent: THREE.Object3D, kit: Kit, z: number, gripLen = 0.115, gripTilt = 0.3) {
  const guard = new THREE.TorusGeometry(0.026, 0.005, 6, 14, Math.PI * 1.25);
  part(parent, kit, guard, kit.darkSteel, 0, -0.036, z, 0, Math.PI / 2, -Math.PI * 0.62);
  part(parent, kit, bevelBox(0.007, 0.026, 0.008, 0.002), kit.gunmetal, 0, -0.03, z + 0.004);
  const grip = part(
    parent,
    kit,
    capsuleBox(0.032, gripLen, 0.05),
    kit.polymer,
    0,
    -0.036 - gripLen * 0.46,
    z + 0.052,
    gripTilt,
  );
  // Palm swell + backstrap texture break.
  part(grip, kit, capsuleBox(0.034, gripLen * 0.42, 0.016), kit.rubber, 0, -gripLen * 0.1, -0.02);
  return grip;
}

/** Iron/red-dot sight. Returns the object ADS should align to screen centre. */
function addOptic(parent: THREE.Object3D, kit: Kit, y: number, z: number, big = false): THREE.Object3D {
  const s = big ? 1.25 : 1;
  const hood = new THREE.Group();
  hood.position.set(0, y, z);
  parent.add(hood);
  part(hood, kit, bevelBox(0.038 * s, 0.04 * s, 0.088 * s, 0.005), kit.darkSteel, 0, 0.019 * s, 0);
  part(hood, kit, bevelBox(0.03 * s, 0.014, 0.05, 0.003), kit.gunmetal, 0, -0.002, 0.004);
  // Glass, front and rear.
  const lens = tube(0.014 * s, 0.014 * s, 0.002, 14);
  part(hood, kit, lens, kit.glass, 0, 0.019 * s, -0.04 * s);
  part(hood, kit, lens.clone(), kit.glass, 0, 0.019 * s, 0.04 * s);
  // The dot itself. Unlit + untonemapped so it stays hot at night.
  part(hood, kit, new THREE.SphereGeometry(0.0022, 6, 5), kit.reticle, 0, 0.019 * s, -0.02);
  // Mount lugs.
  part(hood, kit, bevelBox(0.024, 0.016, 0.02, 0.003), kit.darkSteel, 0, -0.012, -0.026);
  part(hood, kit, bevelBox(0.024, 0.016, 0.02, 0.003), kit.darkSteel, 0, -0.012, 0.026);

  const aim = new THREE.Object3D();
  aim.position.set(0, y + 0.019 * s, z);
  parent.add(aim);
  return aim;
}

/** Picatinny-style rail: a run of slots, cheap but reads as machined. */
function addRail(parent: THREE.Object3D, kit: Kit, len: number, y: number, z: number, w = 0.021) {
  part(parent, kit, bevelBox(w, 0.008, len, 0.002), kit.darkSteel, 0, y, z);
  const n = Math.max(2, Math.floor(len / 0.02));
  const slot = bevelBox(w * 1.06, 0.006, 0.006, 0.0015);
  for (let i = 0; i < n; i++) {
    part(parent, kit, i === 0 ? slot : slot.clone(), kit.gunmetal, 0, y + 0.004, z - len / 2 + 0.01 + i * (len / n));
  }
}

function buildPistol(kit: Kit): Rig {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // Frame + grip.
  const frame = part(body, kit, bevelBox(0.026, 0.03, 0.17, 0.004), kit.polymer, 0, -0.016, -0.01);
  void frame;
  addTriggerGroup(body, kit, 0.012, 0.105, 0.24);

  // Slide — the reciprocating mass.
  const slide = new THREE.Group();
  body.add(slide);
  part(slide, kit, bevelBox(0.028, 0.032, 0.185, 0.005, 0.005), kit.gunmetal, 0, 0.012, -0.02);
  // Serrations at the rear.
  for (let i = 0; i < 6; i++) {
    part(slide, kit, bevelBox(0.029, 0.022, 0.003, 0.001), kit.darkSteel, 0, 0.012, 0.05 + i * 0.007);
  }
  // Ejection port cut.
  part(slide, kit, bevelBox(0.02, 0.012, 0.03, 0.002), kit.darkSteel, 0.006, 0.02, 0.012);
  // Front sight + rear notch.
  part(slide, kit, bevelBox(0.004, 0.008, 0.004, 0.001), kit.darkSteel, 0, 0.03, -0.1);
  part(slide, kit, bevelBox(0.016, 0.008, 0.006, 0.001), kit.darkSteel, 0, 0.03, 0.055);

  // Barrel + suppressor. The can is why this thing exists.
  part(body, kit, tube(0.008, 0.008, 0.06, 10), kit.gunmetal, 0, 0.012, -0.12);
  const can = part(body, kit, tube(0.021, 0.022, 0.16, 16), kit.darkSteel, 0, 0.012, -0.2);
  for (let i = 0; i < 5; i++) {
    part(can, kit, tube(0.0225, 0.0225, 0.004, 16), kit.gunmetal, 0, 0, -0.06 + i * 0.03);
  }
  part(body, kit, tube(0.014, 0.014, 0.006, 12, true), kit.rubber, 0, 0.012, -0.279);

  // Magazine.
  const mag = new THREE.Group();
  body.add(mag);
  part(mag, kit, bevelBox(0.022, 0.1, 0.032, 0.003), kit.darkSteel, 0, -0.095, 0.06);
  part(mag, kit, bevelBox(0.028, 0.01, 0.042, 0.003), kit.polymer, 0, -0.15, 0.062);

  const optic = addOptic(body, kit, 0.036, -0.03);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.012, -0.285);
  body.add(muzzle);
  const eject = new THREE.Object3D();
  eject.position.set(0.02, 0.026, 0.01);
  body.add(eject);

  return { root, body, slide, mag, muzzle, eject, optic, barrels: null, emissive: null };
}

function buildRifle(kit: Kit): Rig {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // Upper + lower receiver.
  part(body, kit, bevelBox(0.05, 0.056, 0.24, 0.005, 0.008), kit.gunmetal, 0, 0.014, 0.02);
  part(body, kit, bevelBox(0.046, 0.05, 0.19, 0.005, 0.008), kit.polymer, 0, -0.03, 0.03);
  part(body, kit, bevelBox(0.052, 0.014, 0.1, 0.003), kit.accent, 0, 0.04, -0.02);
  addRail(body, kit, 0.3, 0.045, -0.06);

  // Handguard with cooling slots.
  const hg = part(body, kit, bevelBox(0.046, 0.05, 0.22, 0.006, 0.01), kit.polymer, 0, 0.012, -0.21);
  for (let i = 0; i < 5; i++) {
    part(hg, kit, bevelBox(0.05, 0.006, 0.03, 0.002), kit.darkSteel, 0, 0.014, -0.07 + i * 0.035);
    part(hg, kit, bevelBox(0.05, 0.006, 0.03, 0.002), kit.darkSteel, 0, -0.014, -0.07 + i * 0.035);
  }
  part(hg, kit, capsuleBox(0.03, 0.03, 0.07), kit.rubber, 0, -0.03, 0.02, 0.2);

  // Barrel, gas block, brake.
  part(body, kit, tube(0.0095, 0.011, 0.36, 12), kit.darkSteel, 0, 0.012, -0.25);
  part(body, kit, bevelBox(0.022, 0.03, 0.03, 0.003), kit.gunmetal, 0, 0.02, -0.31);
  const brake = part(body, kit, tube(0.016, 0.018, 0.055, 14), kit.gunmetal, 0, 0.012, -0.44);
  for (let i = 0; i < 3; i++) {
    part(brake, kit, bevelBox(0.038, 0.006, 0.006, 0.002), kit.darkSteel, 0, 0, -0.016 + i * 0.014);
  }

  // Bolt carrier / charging handle.
  const slide = new THREE.Group();
  body.add(slide);
  part(slide, kit, bevelBox(0.04, 0.012, 0.05, 0.003), kit.gunmetal, 0, 0.044, 0.125);
  part(slide, kit, bevelBox(0.06, 0.01, 0.014, 0.003), kit.darkSteel, 0, 0.044, 0.15);
  part(slide, kit, bevelBox(0.012, 0.02, 0.036, 0.003), kit.darkSteel, 0.026, 0.02, 0.03);

  // Magazine — canted, with a visible follower window.
  const mag = new THREE.Group();
  body.add(mag);
  part(mag, kit, bevelBox(0.028, 0.15, 0.075, 0.004, 0.012), kit.polymer, 0, -0.13, 0.005, 0.1);
  part(mag, kit, bevelBox(0.032, 0.012, 0.085, 0.003), kit.rubber, 0, -0.205, 0.013, 0.1);
  part(mag, kit, bevelBox(0.03, 0.05, 0.006, 0.002), kit.accent, 0, -0.14, -0.033, 0.1);

  addTriggerGroup(body, kit, 0.052, 0.12, 0.3);

  // Stock with cheek riser and rubber pad. Kept short: every centimetre of
  // rear overhang costs viewmodel scale once the near-plane fit runs.
  part(body, kit, bevelBox(0.028, 0.03, 0.11, 0.005), kit.polymer, 0, 0.006, 0.175);
  part(body, kit, bevelBox(0.042, 0.05, 0.085, 0.006, 0.012), kit.polymer, 0, 0.008, 0.245);
  part(body, kit, capsuleBox(0.036, 0.024, 0.09), kit.polymer, 0, 0.036, 0.22);
  part(body, kit, bevelBox(0.046, 0.062, 0.014, 0.004), kit.rubber, 0, 0.004, 0.285);

  const optic = addOptic(body, kit, 0.058, -0.03);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.012, -0.47);
  body.add(muzzle);
  const eject = new THREE.Object3D();
  eject.position.set(0.03, 0.024, 0.03);
  body.add(eject);

  return { root, body, slide, mag, muzzle, eject, optic, barrels: null, emissive: null };
}

function buildShotgun(kit: Kit): Rig {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // Receiver + shell lifter.
  part(body, kit, bevelBox(0.05, 0.062, 0.2, 0.006, 0.01), kit.darkSteel, 0, 0.008, 0.03);
  part(body, kit, bevelBox(0.054, 0.016, 0.12, 0.004), kit.accent, 0, 0.042, 0.02);
  part(body, kit, bevelBox(0.03, 0.03, 0.05, 0.004), kit.gunmetal, 0.026, -0.004, 0.02);

  // Barrel + heat shield + tube magazine.
  part(body, kit, tube(0.0165, 0.018, 0.44, 14), kit.darkSteel, 0, 0.022, -0.25);
  const shroud = part(body, kit, tube(0.026, 0.026, 0.24, 12, true), kit.gunmetal, 0, 0.022, -0.24);
  for (let i = 0; i < 4; i++) {
    part(shroud, kit, bevelBox(0.056, 0.005, 0.03, 0.002), kit.darkSteel, 0, 0, -0.08 + i * 0.055);
  }
  part(body, kit, tube(0.014, 0.014, 0.34, 12), kit.gunmetal, 0, -0.014, -0.2);

  // Pump — the slide for this gun.
  const slide = new THREE.Group();
  body.add(slide);
  const pump = part(slide, kit, capsuleBox(0.05, 0.05, 0.12), kit.polymer, 0, -0.012, -0.19);
  for (let i = 0; i < 7; i++) {
    part(pump, kit, bevelBox(0.052, 0.052, 0.005, 0.0015), kit.rubber, 0, 0, -0.045 + i * 0.015);
  }

  addTriggerGroup(body, kit, 0.05, 0.11, 0.34);

  // Skeleton stock — reads as a breaching gun.
  part(body, kit, bevelBox(0.026, 0.026, 0.1, 0.005), kit.gunmetal, 0, 0.0, 0.17);
  part(body, kit, bevelBox(0.02, 0.075, 0.02, 0.004), kit.gunmetal, 0, -0.028, 0.215, 0.35);
  part(body, kit, bevelBox(0.03, 0.05, 0.014, 0.004), kit.rubber, 0, 0.006, 0.245);
  part(body, kit, capsuleBox(0.03, 0.02, 0.09), kit.polymer, 0, 0.03, 0.19);
  // Shell carrier on the side — visible ammo is free readability.
  for (let i = 0; i < 5; i++) {
    part(body, kit, tube(0.0095, 0.0095, 0.055, 8), kit.brass, -0.03, -0.006 + i * 0.019, 0.06, 0, Math.PI / 2, 0);
  }

  const optic = addOptic(body, kit, 0.056, -0.05);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.022, -0.47);
  body.add(muzzle);
  const eject = new THREE.Object3D();
  eject.position.set(0.03, 0.01, 0.03);
  body.add(eject);

  return { root, body, slide, mag: null, muzzle, eject, optic, barrels: null, emissive: null };
}

function buildLauncher(kit: Kit): Rig {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // Launch tube with a flared venturi at the back. The whole weapon is
  // deliberately front-heavy — the breech end is mostly past the eye anyway,
  // and rear overhang is what forces the fitter to shrink the model.
  part(body, kit, tube(0.045, 0.045, 0.66, 18, true), kit.accent, 0, 0.02, -0.19);
  part(body, kit, tube(0.048, 0.068, 0.12, 18, true), kit.darkSteel, 0, 0.02, 0.17);
  part(body, kit, tube(0.05, 0.05, 0.06, 18), kit.gunmetal, 0, 0.02, -0.48);
  // Reinforcing bands.
  for (let i = 0; i < 4; i++) {
    part(body, kit, new THREE.TorusGeometry(0.047, 0.005, 5, 16), kit.darkSteel, 0, 0.02, -0.42 + i * 0.16);
  }
  // Sight bridge + big optic block.
  part(body, kit, bevelBox(0.02, 0.05, 0.16, 0.004), kit.darkSteel, 0, 0.075, -0.12);
  const optic = addOptic(body, kit, 0.115, -0.12, true);

  // Warhead visible in the tube — instant ammo readout.
  const mag = new THREE.Group();
  body.add(mag);
  part(mag, kit, new THREE.ConeGeometry(0.036, 0.11, 14), kit.accent, 0, 0.02, -0.5, -Math.PI / 2);
  part(mag, kit, tube(0.032, 0.032, 0.12, 14), kit.darkSteel, 0, 0.02, -0.41);

  addTriggerGroup(body, kit, -0.02, 0.13, 0.28);
  // Forward grip + shoulder pad.
  part(body, kit, capsuleBox(0.032, 0.12, 0.05), kit.polymer, 0, -0.06, -0.26, -0.28);
  part(body, kit, capsuleBox(0.07, 0.03, 0.1), kit.rubber, 0, -0.02, 0.16, 0.25);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.02, -0.52);
  body.add(muzzle);
  const eject = new THREE.Object3D();
  eject.position.set(0, 0.02, 0.2);
  body.add(eject);

  return { root, body, slide: null, mag, muzzle, eject, optic, barrels: null, emissive: null };
}

function buildMinigun(kit: Kit): Rig {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // Housing.
  part(body, kit, bevelBox(0.11, 0.12, 0.26, 0.008, 0.016), kit.darkSteel, 0, 0, 0.05);
  part(body, kit, bevelBox(0.115, 0.03, 0.14, 0.005), kit.accent, 0, 0.06, 0.03);
  part(body, kit, tube(0.055, 0.06, 0.1, 14), kit.gunmetal, 0, 0.01, -0.1);

  // Rotating barrel cluster.
  const barrels = new THREE.Group();
  barrels.position.set(0, 0.01, -0.34);
  body.add(barrels);
  const barrelGeo = tube(0.011, 0.011, 0.42, 8);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    part(barrels, kit, i === 0 ? barrelGeo : barrelGeo.clone(), kit.darkSteel, Math.cos(a) * 0.028, Math.sin(a) * 0.028, 0);
  }
  part(barrels, kit, tube(0.042, 0.042, 0.02, 16), kit.gunmetal, 0, 0, -0.2);
  part(barrels, kit, tube(0.042, 0.042, 0.02, 16), kit.gunmetal, 0, 0, 0.16);
  // Heat glow ring — driven by the heat value at runtime.
  const heatMat = kit.glow.clone();
  heatMat.emissive = new THREE.Color(0xff5510);
  heatMat.emissiveIntensity = 0;
  heatMat.color = new THREE.Color(0x1a1210);
  kit.materials.push(heatMat);
  part(barrels, kit, tube(0.044, 0.044, 0.05, 16, true), heatMat, 0, 0, -0.15);

  // Ammo drum + feed chute.
  const mag = new THREE.Group();
  body.add(mag);
  // Drum lies on its side — axis along X, so it reads as a can, not a barrel.
  part(mag, kit, tube(0.075, 0.075, 0.09, 18), kit.gunmetal, 0.0, -0.115, 0.11, 0, Math.PI / 2, 0);
  part(mag, kit, bevelBox(0.05, 0.04, 0.07, 0.005), kit.polymer, 0, -0.06, 0.11);
  for (let i = 0; i < 8; i++) {
    part(mag, kit, tube(0.007, 0.007, 0.03, 6), kit.brass, -0.02 + i * 0.005, -0.075 - i * 0.001, 0.09);
  }

  // Spade grips.
  part(body, kit, bevelBox(0.2, 0.018, 0.03, 0.005), kit.gunmetal, 0, -0.02, 0.19);
  part(body, kit, capsuleBox(0.03, 0.1, 0.04), kit.rubber, 0.09, -0.07, 0.19, 0.15);
  part(body, kit, capsuleBox(0.03, 0.1, 0.04), kit.rubber, -0.09, -0.07, 0.19, 0.15);
  part(body, kit, capsuleBox(0.045, 0.06, 0.1), kit.polymer, 0, 0.02, 0.21);

  const optic = new THREE.Object3D();
  optic.position.set(0, 0.075, -0.1);
  body.add(optic);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.01, -0.56);
  body.add(muzzle);
  const eject = new THREE.Object3D();
  eject.position.set(0.06, -0.03, 0.06);
  body.add(eject);

  return { root, body, slide: null, mag, muzzle, eject, optic, barrels, emissive: heatMat };
}

function buildRailgun(kit: Kit): Rig {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // Chassis: a long, flat, angular thing. Nothing about it says "gunpowder".
  part(body, kit, bevelBox(0.052, 0.07, 0.42, 0.006, 0.012), kit.gunmetal, 0, 0.01, -0.02);
  part(body, kit, bevelBox(0.058, 0.02, 0.3, 0.004), kit.accent, 0, 0.052, -0.06);
  part(body, kit, bevelBox(0.04, 0.05, 0.16, 0.005), kit.polymer, 0, -0.02, 0.2);

  // Twin accelerator rails with the coil stack between them.
  const coil = kit.glow.clone();
  coil.emissiveIntensity = 0.15;
  kit.materials.push(coil);
  for (const side of [-1, 1]) {
    part(body, kit, bevelBox(0.012, 0.016, 0.5, 0.003), kit.darkSteel, side * 0.028, 0.026, -0.26);
  }
  for (let i = 0; i < 7; i++) {
    part(body, kit, new THREE.TorusGeometry(0.026, 0.006, 6, 14), coil, 0, 0.026, -0.11 - i * 0.062);
  }
  part(body, kit, tube(0.013, 0.013, 0.5, 12), coil, 0, 0.026, -0.26);
  part(body, kit, tube(0.03, 0.026, 0.05, 14, true), kit.gunmetal, 0, 0.026, -0.5);

  // Capacitor bank doubles as the magazine.
  const mag = new THREE.Group();
  body.add(mag);
  part(mag, kit, capsuleBox(0.05, 0.11, 0.09), kit.darkSteel, 0, -0.1, 0.02);
  part(mag, kit, bevelBox(0.056, 0.03, 0.05, 0.004), coil, 0, -0.13, 0.02);

  addTriggerGroup(body, kit, 0.06, 0.12, 0.32);
  part(body, kit, capsuleBox(0.03, 0.028, 0.11), kit.polymer, 0, 0.052, 0.16);
  part(body, kit, bevelBox(0.05, 0.07, 0.014, 0.004), kit.rubber, 0, -0.005, 0.275);

  const optic = addOptic(body, kit, 0.072, -0.02);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.026, -0.53);
  body.add(muzzle);
  const eject = new THREE.Object3D();
  eject.position.set(0.03, 0.0, 0.05);
  body.add(eject);

  return { root, body, slide: null, mag, muzzle, eject, optic, barrels: null, emissive: coil };
}

// ── The arsenal ────────────────────────────────────────────────────────────

const ARSENAL: WeaponDef[] = [
  {
    id: "susurro",
    name: "Susurro .45",
    short: "SUSURRO",
    slot: 1,
    role: "suppressed sidearm",
    ballistic: "hitscan",
    mode: "semi",
    rpm: 340,
    damage: 36,
    pellets: 1,
    range: 180,
    pierce: 0,
    spread: 0.006,
    spreadAds: 0.0016,
    spreadMove: 0.012,
    bloom: 0.012,
    bloomDecay: 5.5,
    bloomMax: 0.05,
    magSize: 12,
    reserveMax: 108,
    reload: 1.55,
    reloadBeats: [0.26, 0.62, 0.85],
    recoil: {
      back: 0.016,
      vmPitch: 0.13,
      vmYaw: 0.02,
      vmRoll: 0.05,
      camPitch: 0.014,
      camYaw: 0.004,
      shake: 0.004,
      pattern: [[0.2, 1], [-0.4, 0.9], [0.6, 1.05], [-0.1, 0.95]],
      jitter: 0.5,
      stiffness: 190,
      damping: 20,
    },
    slideTravel: 0.03,
    slideTime: 0.09,
    shell: "brass",
    shellEjectSpeed: 2.4,
    adsAllowed: true,
    adsTime: 0.16,
    adsFov: 56,
    weight: 0.45,
    swapTime: 0.34,
    sound: "pistol",
    soundVolume: 0.34,
    flashScale: 0.35,
    tracerEvery: 2,
    build: buildPistol,
    hip: [0.105, -0.1, -0.185],
    hipRot: [0.02, -0.075, 0.02],
    designScale: 0.44,
  },
  {
    id: "vaquero",
    name: "Vaquero CR-7",
    short: "CR-7",
    slot: 2,
    role: "assault rifle",
    ballistic: "hitscan",
    mode: "auto",
    rpm: 720,
    damage: 24,
    pellets: 1,
    range: 320,
    pierce: 0,
    spread: 0.012,
    spreadAds: 0.0022,
    spreadMove: 0.022,
    bloom: 0.0075,
    bloomDecay: 4.2,
    bloomMax: 0.055,
    magSize: 30,
    reserveMax: 270,
    reload: 2.15,
    reloadBeats: [0.22, 0.56, 0.8],
    recoil: {
      back: 0.02,
      vmPitch: 0.1,
      vmYaw: 0.03,
      vmRoll: 0.07,
      camPitch: 0.0115,
      camYaw: 0.0045,
      // Classic three-stage climb: straight up, drift right, whip left.
      pattern: [
        [0, 1.25], [0.05, 1.15], [-0.1, 1.05], [0.35, 0.95], [0.6, 0.9],
        [0.85, 0.85], [0.7, 0.8], [0.2, 0.85], [-0.45, 0.9], [-0.85, 0.85],
        [-1, 0.8], [-0.6, 0.8], [0.1, 0.85], [0.6, 0.85],
      ],
      jitter: 0.38,
      shake: 0.006,
      stiffness: 165,
      damping: 18,
    },
    slideTravel: 0.022,
    slideTime: 0.06,
    shell: "brass",
    shellEjectSpeed: 3.1,
    adsAllowed: true,
    adsTime: 0.2,
    adsFov: 52,
    weight: 0.8,
    swapTime: 0.42,
    sound: "rifle",
    soundVolume: 0.75,
    flashScale: 1,
    tracerEvery: 3,
    build: buildRifle,
    hip: [0.115, -0.115, -0.2],
    hipRot: [0.015, -0.06, 0.015],
    designScale: 0.33,
  },
  {
    id: "marejada",
    name: "Marejada 12",
    short: "MAREJADA",
    slot: 3,
    role: "pump shotgun",
    ballistic: "hitscan",
    mode: "pump",
    rpm: 78,
    damage: 13,
    pellets: 9,
    range: 60,
    pierce: 0,
    spread: 0.075,
    spreadAds: 0.05,
    spreadMove: 0.02,
    bloom: 0.02,
    bloomDecay: 3,
    bloomMax: 0.06,
    magSize: 6,
    reserveMax: 54,
    reload: 2.6,
    reloadBeats: [0.18, 0.7, 0.9],
    recoil: {
      back: 0.05,
      vmPitch: 0.3,
      vmYaw: 0.05,
      vmRoll: 0.16,
      camPitch: 0.055,
      camYaw: 0.012,
      shake: 0.03,
      pattern: [[0.4, 1], [-0.5, 1.05], [0.7, 0.95], [-0.25, 1]],
      jitter: 0.8,
      stiffness: 110,
      damping: 15,
    },
    slideTravel: 0.075,
    slideTime: 0.42,
    shell: "shotgun",
    shellEjectSpeed: 2.2,
    adsAllowed: true,
    adsTime: 0.22,
    adsFov: 60,
    weight: 1.0,
    swapTime: 0.46,
    sound: "shotgun",
    soundVolume: 0.95,
    flashScale: 1.7,
    tracerEvery: 4,
    build: buildShotgun,
    hip: [0.115, -0.115, -0.2],
    hipRot: [0.02, -0.055, 0.02],
    designScale: 0.33,
  },
  {
    id: "bandera",
    name: "Bandera RPG",
    short: "BANDERA",
    slot: 4,
    role: "rocket launcher",
    ballistic: "rocket",
    mode: "semi",
    rpm: 48,
    damage: 0,
    pellets: 1,
    range: 900,
    pierce: 0,
    spread: 0.008,
    spreadAds: 0.002,
    spreadMove: 0.01,
    bloom: 0.02,
    bloomDecay: 2,
    bloomMax: 0.04,
    magSize: 1,
    reserveMax: 9,
    reload: 3.1,
    reloadBeats: [0.2, 0.68, 0.9],
    recoil: {
      back: 0.075,
      vmPitch: 0.34,
      vmYaw: 0.06,
      vmRoll: 0.14,
      camPitch: 0.07,
      camYaw: 0.016,
      shake: 0.055,
      pattern: [[0.3, 1], [-0.3, 1]],
      jitter: 0.6,
      stiffness: 85,
      damping: 13,
    },
    slideTravel: 0,
    slideTime: 0,
    shell: "none",
    shellEjectSpeed: 0,
    rocket: { speed: 62, gravity: -5.2, drag: 0.12, radius: 11, force: 165, fuse: 9 },
    adsAllowed: true,
    adsTime: 0.3,
    adsFov: 58,
    weight: 1.35,
    swapTime: 0.62,
    sound: "rocket",
    soundVolume: 1,
    flashScale: 2.4,
    tracerEvery: 0,
    build: buildLauncher,
    hip: [0.115, -0.115, -0.18],
    hipRot: [0.02, -0.05, 0.03],
    designScale: 0.3,
  },
  {
    id: "tormenta",
    name: "Tormenta M-90",
    short: "TORMENTA",
    slot: 5,
    role: "rotary heavy",
    ballistic: "hitscan",
    mode: "spin",
    rpm: 1450,
    damage: 15,
    pellets: 1,
    range: 260,
    pierce: 0,
    spread: 0.026,
    spreadAds: 0.014,
    spreadMove: 0.02,
    bloom: 0.0035,
    bloomDecay: 2.6,
    bloomMax: 0.07,
    magSize: 220,
    reserveMax: 440,
    reload: 5.0,
    reloadBeats: [0.16, 0.72, 0.92],
    recoil: {
      back: 0.012,
      vmPitch: 0.05,
      vmYaw: 0.045,
      vmRoll: 0.03,
      camPitch: 0.006,
      camYaw: 0.005,
      shake: 0.012,
      pattern: [[1, 0.6], [0.4, 0.9], [-0.6, 0.8], [-1, 0.5], [-0.3, 0.9], [0.7, 0.7]],
      jitter: 1.1,
      stiffness: 210,
      damping: 24,
    },
    slideTravel: 0,
    slideTime: 0,
    shell: "brass",
    shellEjectSpeed: 3.6,
    spinUp: 0.72,
    spinDown: 1.1,
    adsAllowed: false,
    adsTime: 0.3,
    adsFov: 64,
    weight: 1.8,
    swapTime: 0.75,
    sound: "minigun",
    soundVolume: 0.62,
    flashScale: 1.5,
    tracerEvery: 2,
    build: buildMinigun,
    hip: [0.075, -0.135, -0.2],
    hipRot: [0.01, -0.02, 0.0],
    designScale: 0.28,
  },
  {
    id: "aguja",
    name: "Aguja RAIL-9",
    short: "AGUJA",
    slot: 6,
    role: "charged railgun",
    ballistic: "hitscan",
    mode: "charge",
    rpm: 55,
    damage: 165,
    pellets: 1,
    range: 900,
    pierce: 4,
    spread: 0.0,
    spreadAds: 0.0,
    spreadMove: 0.008,
    bloom: 0.01,
    bloomDecay: 2.4,
    bloomMax: 0.03,
    magSize: 5,
    reserveMax: 25,
    reload: 2.8,
    reloadBeats: [0.22, 0.64, 0.88],
    recoil: {
      back: 0.06,
      vmPitch: 0.26,
      vmYaw: 0.03,
      vmRoll: 0.1,
      camPitch: 0.05,
      camYaw: 0.008,
      shake: 0.036,
      pattern: [[0.2, 1], [-0.2, 1]],
      jitter: 0.25,
      stiffness: 120,
      damping: 16,
    },
    slideTravel: 0.05,
    slideTime: 0.5,
    shell: "none",
    shellEjectSpeed: 0,
    chargeTime: 0.95,
    adsAllowed: true,
    adsTime: 0.26,
    adsFov: 38,
    weight: 1.2,
    swapTime: 0.55,
    sound: "railgun",
    soundVolume: 0.95,
    flashScale: 1.8,
    tracerEvery: 1,
    build: buildRailgun,
    hip: [0.115, -0.115, -0.2],
    hipRot: [0.015, -0.05, 0.02],
    designScale: 0.3,
  },
];

// ───────────────────────────────────────────────────────────────────────────
// Viewmodel auto-fit — the anti-clipping guarantee
// ───────────────────────────────────────────────────────────────────────────

/**
 * Bisect the rig's scale until every bounding-box corner, in every pose the
 * weapon can reach, sits inside the clearance capsule and behind NEAR_MARGIN.
 * Because `resolveCapsule` keeps colliders 0.42 m away from the player axis,
 * a rig that satisfies this can never intersect world geometry — no second
 * camera pass, no depth hacks, no clipping.
 *
 * Two constraint sets, because they protect against different things:
 *  - `poses` (every pose the weapon reaches) must satisfy the clearance
 *    capsule. That is the anti-clipping guarantee and it is non-negotiable.
 *  - `nearPoses` (hip and ADS, where the player actually lives) additionally
 *    must clear the near plane. The transient reload/tuck poses are exempt:
 *    they pull the stock toward the cheek by design, that geometry is in the
 *    bottom corner of the frame, and enforcing it there would shrink every
 *    weapon by a third for a beat nobody looks at.
 *
 * The remaining animated channels — sway, bob, recoil — are bounded to roughly
 * 0.04 m of lateral travel, which is the slack between SAFE_H and the 0.42 m
 * collider margin. The swap dive is excluded on purpose: it only moves the
 * weapon downward and rearward, both of which are strictly safer.
 */
function fitViewmodelScale(
  root: THREE.Object3D,
  poses: THREE.Vector3[],
  nearPoses: THREE.Vector3[],
  design: number,
): number {
  root.updateMatrixWorld(true);
  _box.setFromObject(root);
  if (!isFinite(_box.min.x)) return design;

  const corners: THREE.Vector3[] = [];
  for (let i = 0; i < 8; i++) {
    corners.push(
      new THREE.Vector3(
        i & 1 ? _box.max.x : _box.min.x,
        i & 2 ? _box.max.y : _box.min.y,
        i & 4 ? _box.max.z : _box.min.z,
      ),
    );
  }

  const fits = (s: number) => {
    for (const p of poses) {
      for (const c of corners) {
        const x = p.x + s * c.x;
        const y = p.y + s * c.y;
        const z = p.z + s * c.z;
        if (x * x + z * z > SAFE_H * SAFE_H) return false;
        if (y < -SAFE_DOWN || y > SAFE_UP) return false;
      }
    }
    for (const p of nearPoses) {
      for (const c of corners) {
        if (p.z + s * c.z > -NEAR_MARGIN) return false;
      }
    }
    return true;
  };

  if (fits(design)) return design;
  let lo = 0.02;
  let hi = design;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) * 0.5;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

// ───────────────────────────────────────────────────────────────────────────
// Springs
// ───────────────────────────────────────────────────────────────────────────

/** Damped harmonic spring on three axes — used for every recoil channel. */
class Spring3 {
  value = new THREE.Vector3();
  vel = new THREE.Vector3();

  kick(x: number, y: number, z: number) {
    this.vel.x += x;
    this.vel.y += y;
    this.vel.z += z;
  }

  step(dt: number, stiffness: number, damping: number) {
    // Semi-implicit Euler, substepped so a stiff spring can't explode at 20 fps.
    const steps = dt > 0.02 ? 3 : 1;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.vel.x += (-stiffness * this.value.x - damping * this.vel.x) * h;
      this.vel.y += (-stiffness * this.value.y - damping * this.vel.y) * h;
      this.vel.z += (-stiffness * this.value.z - damping * this.vel.z) * h;
      this.value.x += this.vel.x * h;
      this.value.y += this.vel.y * h;
      this.value.z += this.vel.z * h;
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Pools
// ───────────────────────────────────────────────────────────────────────────

interface Shell {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  rot: THREE.Euler;
  life: number;
  bounces: number;
  resting: boolean;
}

/** Instanced brass. One draw call for every casing on the ground. */
class ShellPool {
  readonly mesh: THREE.InstancedMesh;
  private shells: Shell[] = [];
  private cursor = 0;
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3(1, 1, 1);

  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, readonly capacity: number, readonly ttl: number) {
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.count = capacity;
    for (let i = 0; i < capacity; i++) {
      this.shells.push({
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        rot: new THREE.Euler(),
        life: 0,
        bounces: 0,
        resting: false,
      });
      _mat4.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(i, _mat4);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  spawn(pos: THREE.Vector3, vel: THREE.Vector3, rng: () => number) {
    const s = this.shells[this.cursor];
    this.cursor = (this.cursor + 1) % this.capacity;
    s.pos.copy(pos);
    s.vel.copy(vel);
    s.spin.set((rng() - 0.5) * 34, (rng() - 0.5) * 26, (rng() - 0.5) * 40);
    s.rot.set(rng() * 6.28, rng() * 6.28, rng() * 6.28);
    s.life = this.ttl;
    s.bounces = 0;
    s.resting = false;
  }

  update(dt: number, groundAt: (x: number, z: number) => number, onBounce: (p: THREE.Vector3, hard: boolean) => void) {
    let dirty = false;
    for (let i = 0; i < this.capacity; i++) {
      const s = this.shells[i];
      if (s.life <= 0) continue;
      dirty = true;
      s.life -= dt;

      if (!s.resting) {
        s.vel.y -= 24 * dt;
        s.pos.addScaledVector(s.vel, dt);
        s.rot.x += s.spin.x * dt;
        s.rot.y += s.spin.y * dt;
        s.rot.z += s.spin.z * dt;

        const gy = groundAt(s.pos.x, s.pos.z);
        if (s.pos.y <= gy + 0.008) {
          s.pos.y = gy + 0.008;
          if (s.vel.y < -0.4 && s.bounces < 3) {
            const hard = s.bounces === 0;
            onBounce(s.pos, hard);
            s.vel.y = -s.vel.y * 0.34;
            s.vel.x *= 0.55;
            s.vel.z *= 0.55;
            s.spin.multiplyScalar(0.5);
            s.bounces++;
          } else {
            // Settled: lie flat and stop paying for it.
            s.vel.set(0, 0, 0);
            s.spin.set(0, 0, 0);
            s.rot.x = Math.PI / 2;
            s.resting = true;
          }
        }
      }

      // Fade out by shrinking — InstancedMesh has no per-instance alpha.
      const fade = Math.min(1, s.life / (this.ttl * 0.25));
      this.q.setFromEuler(s.rot);
      this.s.setScalar(fade);
      _mat4.compose(s.pos, this.q, this.s);
      this.mesh.setMatrixAt(i, _mat4);

      if (s.life <= 0) {
        _mat4.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, _mat4);
      }
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

interface Rocket {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  trail: number;
  spec: NonNullable<WeaponDef["rocket"]>;
  mesh: THREE.Object3D;
}

// ───────────────────────────────────────────────────────────────────────────
// System
// ───────────────────────────────────────────────────────────────────────────

interface WeaponState {
  def: WeaponDef;
  rig: Rig;
  scale: number;
  ammo: number;
  reserve: number;
  /** Rolling shot index — drives the recoil pattern. */
  shotIndex: number;
}

const SHELL_CAPACITY: Record<QualityTier, number> = { low: 20, medium: 44, high: 80, ultra: 120 };
const ROCKET_CAPACITY: Record<QualityTier, number> = { low: 4, medium: 8, high: 12, ultra: 16 };

const createWeapons: SystemFactory = (ctx: WorldCtx) => {
  const kit = makeKit(ctx.rng);
  const quality = ctx.quality;
  const cheap = quality === "low";

  // ── Rig root: a group in the scene that mirrors the camera every frame. ──
  // We deliberately do NOT parent to ctx.camera: the camera is not guaranteed
  // to be in the scene graph, and other systems own its transform. Copying the
  // transform in lateUpdate (after the player has written it) is equivalent
  // and keeps us out of everyone's way.
  const rig = new THREE.Group();
  rig.matrixAutoUpdate = true;
  rig.frustumCulled = false;
  rig.renderOrder = 8;
  ctx.scene.add(rig);

  // Viewmodel fill light: a tight point light so the gun reads at night and in
  // shadow without lighting the world. Distance-limited, so it is nearly free.
  let fillLight: THREE.PointLight | null = null;
  let flashLight: THREE.PointLight | null = null;
  if (!cheap) {
    fillLight = new THREE.PointLight(0xbfd6ff, 1.1, 1.4, 2);
    fillLight.position.set(0.18, 0.22, 0.05);
    rig.add(fillLight);
    // Muzzle light. Kept in the graph permanently at zero intensity so adding
    // it never triggers a shader recompile mid-firefight.
    flashLight = new THREE.PointLight(0xffb055, 0, 22, 2);
    flashLight.intensity = 0;
    rig.add(flashLight);
  }

  // Muzzle flash billboard, in viewmodel space.
  const flashTex = makeFlashSprite();
  kit.textures.push(flashTex);
  const flashMat = new THREE.MeshBasicMaterial({
    map: flashTex,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
    opacity: 0,
  });
  kit.materials.push(flashMat);
  const flashGeo = kit.geo(new THREE.PlaneGeometry(1, 1));
  const flash = new THREE.Mesh(flashGeo, flashMat);
  flash.frustumCulled = false;
  flash.renderOrder = 20;
  flash.visible = false;
  rig.add(flash);

  // ── Build the arsenal ───────────────────────────────────────────────────
  const weapons: WeaponState[] = [];
  for (const def of ARSENAL) {
    const built = def.build(kit);
    const hip = new THREE.Vector3(def.hip[0], def.hip[1], def.hip[2]);
    // ADS pose: slide the gun so its optic lands dead centre (computed with
    // the design scale, which is an upper bound on the fitted scale).
    const ads = new THREE.Vector3(
      -built.optic.position.x * def.designScale,
      -built.optic.position.y * def.designScale,
      ADS_Z,
    );
    const scale = fitViewmodelScale(
      built.root,
      [
        hip,
        ads,
        new THREE.Vector3(hip.x - 0.02, hip.y - 0.075, hip.z), // reload dip
        new THREE.Vector3(hip.x, hip.y - 0.03, hip.z + 0.05), // wall tuck
      ],
      [hip, ads],
      def.designScale,
    );
    built.root.scale.setScalar(scale);
    built.root.visible = false;
    built.root.frustumCulled = false;
    built.root.traverse((o) => {
      o.frustumCulled = false;
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = false;
        m.receiveShadow = false;
      }
    });
    rig.add(built.root);
    weapons.push({
      def,
      rig: built,
      scale,
      ammo: def.magSize,
      reserve: Math.floor(def.reserveMax * 0.6),
      shotIndex: 0,
    });
  }

  // ── Shell pools ─────────────────────────────────────────────────────────
  const cap = SHELL_CAPACITY[quality] ?? 60;
  const brassGeo = kit.geo(tube(0.0052, 0.0058, 0.024, 7));
  const hullGeo = kit.geo(tube(0.0092, 0.0092, 0.05, 8));
  const hullMat = new THREE.MeshStandardMaterial({ color: 0x8e2018, metalness: 0.15, roughness: 0.7 });
  kit.materials.push(hullMat);
  const brassShells = new ShellPool(brassGeo, kit.brass, cap, 7);
  const hullShells = new ShellPool(hullGeo, hullMat, Math.max(8, cap >> 2), 9);
  ctx.scene.add(brassShells.mesh, hullShells.mesh);

  // ── Rocket pool ─────────────────────────────────────────────────────────
  const rocketGeo = kit.geo(tube(0.05, 0.05, 0.34, 10));
  const rocketNose = kit.geo(new THREE.ConeGeometry(0.055, 0.16, 10));
  const rocketFin = kit.geo(bevelBox(0.006, 0.07, 0.1, 0.002));
  const exhaustMat = new THREE.MeshBasicMaterial({ color: 0xffb347, toneMapped: false });
  kit.materials.push(exhaustMat);
  const rockets: Rocket[] = [];
  for (let i = 0; i < (ROCKET_CAPACITY[quality] ?? 8); i++) {
    const g = new THREE.Group();
    const bodyMesh = new THREE.Mesh(rocketGeo, kit.accent);
    const nose = new THREE.Mesh(rocketNose, kit.darkSteel);
    nose.rotation.x = -Math.PI / 2;
    nose.position.z = -0.24;
    g.add(bodyMesh, nose);
    for (let f = 0; f < 4; f++) {
      const fin = new THREE.Mesh(rocketFin, kit.darkSteel);
      fin.position.z = 0.16;
      fin.rotation.z = (f / 4) * Math.PI * 2;
      fin.position.x = Math.cos((f / 4) * Math.PI * 2) * 0.045;
      fin.position.y = Math.sin((f / 4) * Math.PI * 2) * 0.045;
      g.add(fin);
    }
    const plume = new THREE.Mesh(rocketGeo, exhaustMat);
    plume.scale.set(0.7, 0.7, 0.5);
    plume.position.z = 0.24;
    g.add(plume);
    g.visible = false;
    g.frustumCulled = false;
    ctx.scene.add(g);
    rockets.push({
      active: false,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      life: 0,
      trail: 0,
      spec: ARSENAL[3].rocket!,
      mesh: g,
    });
  }

  // ── Runtime state ───────────────────────────────────────────────────────
  let index = 1; // start on the rifle
  let current = weapons[index];
  current.rig.root.visible = true;

  let cooldown = 0;
  let reloading = 0;
  let reloadTotal = 0;
  let reloadBeat = 0;
  let swap = 0;
  let swapTotal = 0;
  let pendingIndex = -1;
  let bloom = 0;
  let spin = 0; // minigun spool 0..1
  let spinAngle = 0;
  let charge = 0;
  let chargeAudio = false;
  let heat = 0;
  let hitstop = 0;
  let slidePhase = 0; // 0 = at rest, 1 = fully back
  let slideTimer = 0;
  let adsT = 0;
  let sprintT = 0;
  let tuckT = 0;
  let fovBase = BASE_FOV;
  let fovPunch = 0;
  let flashTime = 0;
  let lastFireHeld = false;
  let shotsSinceTracer = 0;
  let hudKey = "";
  let lastCrosshair = -1;
  let rigWarm = false;

  // Feel channels.
  const recoilPos = new Spring3();
  const recoilRot = new Spring3();
  const camKick = new Spring3();
  const sway = new THREE.Vector2();
  const swayVel = new THREE.Vector2();
  const shake = new THREE.Vector3();
  const shakeVel = new THREE.Vector3();
  let bobPhase = 0;
  let bobAmp = 0;

  // Reusable pose accumulators.
  const posePos = new THREE.Vector3();
  const poseRot = new THREE.Euler(0, 0, 0, "YXZ");

  const targetsScratch: { object: THREE.Object3D; radius: number }[] = [];

  // ── Helpers ─────────────────────────────────────────────────────────────

  function groundAt(x: number, z: number): number {
    return ctx.services.terrain?.heightAt(x, z) ?? 0;
  }

  function impactMaterialFor(hit: RayHit, point: THREE.Vector3): ImpactMaterial {
    const tag = hit.tag ?? "";
    if (tag.includes("water")) return "water";
    if (tag.includes("glass") || tag.includes("window")) return "glass";
    if (tag.includes("vehicle") || tag.includes("metal") || tag.includes("crane")) return "metal";
    if (tag.includes("tree") || tag.includes("palm") || tag.includes("wood")) return "wood";
    if (tag.includes("enemy") || tag.includes("flesh")) return "flesh";
    if (tag.includes("terrain") || tag.includes("dirt") || tag.includes("sand")) return "dirt";
    if (ctx.services.terrain?.isWater(point.x, point.z) && point.y < (ctx.services.terrain?.seaLevel ?? 0) + 0.4) {
      return "water";
    }
    return "concrete";
  }

  /** Uniform cone jitter around `dir`, written back into `dir`. */
  function coneJitter(dir: THREE.Vector3, halfAngle: number) {
    if (halfAngle <= 0.00001) return;
    _t1.copy(Math.abs(dir.y) > 0.95 ? _v4.set(1, 0, 0) : UP).cross(dir).normalize();
    _t2.crossVectors(dir, _t1).normalize();
    const ang = ctx.rng() * Math.PI * 2;
    const rad = Math.sqrt(ctx.rng()) * halfAngle;
    const t = Math.tan(rad);
    dir.addScaledVector(_t1, t * Math.cos(ang)).addScaledVector(_t2, t * Math.sin(ang)).normalize();
  }

  /**
   * Ray-vs-registered-target sweep. CombatService has no ray query, so we grab
   * every actor whose sphere could touch the segment with a single broadphase
   * call, then do exact ray/sphere on the shortlist.
   */
  function firstTargetAlong(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number {
    const combat = ctx.services.combat;
    if (!combat || maxDist <= 0) return -1;
    _ta.copy(origin).addScaledVector(dir, maxDist * 0.5);
    const list = combat.queryTargets(_ta, maxDist * 0.5 + 6);
    if (!list.length) return -1;
    let best = -1;
    for (const t of list) {
      if (t.faction === "player") continue;
      _tb.copy(t.object.position).sub(origin);
      const along = _tb.dot(dir);
      if (along < 0 || along > maxDist) continue;
      const perp2 = _tb.lengthSq() - along * along;
      const r = t.radius + 0.15;
      if (perp2 > r * r) continue;
      const back = Math.sqrt(Math.max(0, r * r - perp2));
      const d = Math.max(0, along - back);
      if (best < 0 || d < best) best = d;
    }
    return best;
  }

  /** Fire one hitscan ray: world hit, actor hit, VFX, damage. */
  function hitscan(origin: THREE.Vector3, dir: THREE.Vector3, def: WeaponDef): boolean {
    const collision = ctx.services.collision;
    const vfx = ctx.services.vfx;
    const terrain = ctx.services.terrain;

    let dist = def.range;
    let hit: RayHit | null = collision?.raycast(origin, dir, def.range) ?? null;
    if (hit) dist = hit.distance;

    // Terrain is not part of the collision broadphase — march it coarsely.
    // 14 samples out to the weapon's range is plenty for a ballistic impact.
    if (terrain) {
      const steps = 14;
      for (let i = 1; i <= steps; i++) {
        const d = (dist * i) / steps;
        _v3.copy(origin).addScaledVector(dir, d);
        const h = _v3.y - terrain.heightAt(_v3.x, _v3.z);
        if (h <= 0) {
          // Refine with a couple of bisections so the decal sits on the surface.
          let lo = (dist * (i - 1)) / steps;
          let hi = d;
          for (let k = 0; k < 6; k++) {
            const mid = (lo + hi) * 0.5;
            _v3.copy(origin).addScaledVector(dir, mid);
            if (_v3.y - terrain.heightAt(_v3.x, _v3.z) <= 0) hi = mid;
            else lo = mid;
          }
          dist = hi;
          _terrainHit.point.copy(origin).addScaledVector(dir, dist);
          terrain.normalAt(_terrainHit.point.x, _terrainHit.point.z, _terrainHit.normal);
          _terrainHit.distance = dist;
          _terrainHit.tag = terrain.isWater(_terrainHit.point.x, _terrainHit.point.z) ? "water" : "dirt";
          hit = _terrainHit;
          break;
        }
      }
    }

    let didHit = false;
    let pierced = 0;
    let searchFrom = 0;
    // Piercing weapons keep walking the ray through actors.
    for (;;) {
      _hs.copy(origin).addScaledVector(dir, searchFrom);
      const td = firstTargetAlong(_hs, dir, Math.max(0, dist - searchFrom));
      if (td < 0) break;
      _v2.copy(_hs).addScaledVector(dir, td);
      ctx.services.combat?.damageAt(_v2, def.damage, def.id);
      ctx.services.vfx?.impact(_v2, _v3.copy(dir).negate(), "flesh");
      didHit = true;
      if (pierced++ >= def.pierce) {
        dist = searchFrom + td;
        break;
      }
      searchFrom += td + 0.6;
      if (searchFrom >= dist) break;
    }

    _v1.copy(origin).addScaledVector(dir, dist);
    if (!didHit && hit) {
      vfx?.impact(hit.point, hit.normal, impactMaterialFor(hit, hit.point));
      ctx.services.combat?.damageAt(hit.point, def.damage * 0.5, def.id);
    }

    if (def.tracerEvery > 0 && shotsSinceTracer % def.tracerEvery === 0) {
      _v2.copy(origin).addScaledVector(dir, 0.6);
      vfx?.tracer(_v2, _v1);
    }
    shotsSinceTracer++;
    return didHit;
  }

  function launchRocket(origin: THREE.Vector3, dir: THREE.Vector3, def: WeaponDef) {
    const spec = def.rocket!;
    let r = rockets.find((x) => !x.active);
    if (!r) r = rockets[0]; // Recycle the oldest rather than dropping the shot.
    r.active = true;
    r.spec = spec;
    r.pos.copy(origin).addScaledVector(dir, 0.5);
    r.vel.copy(dir).multiplyScalar(spec.speed);
    // Inherit the shooter's momentum so firing from a car feels right.
    const pv = ctx.services.player?.velocity;
    if (pv) r.vel.addScaledVector(pv, 0.6);
    r.life = spec.fuse;
    r.trail = 0;
    r.mesh.visible = true;
    r.mesh.position.copy(r.pos);
  }

  function detonate(r: Rocket, point: THREE.Vector3) {
    r.active = false;
    r.mesh.visible = false;
    const spec = r.spec;
    ctx.services.combat?.explode(point, spec.radius, spec.force);
    ctx.services.vfx?.explosion(point, 1.5);
    ctx.services.vfx?.smoke(point, 12);
    ctx.services.audio?.play("explosion", { position: point, volume: 1 });

    const player = ctx.services.player;
    if (player) {
      const d = player.position.distanceTo(point);
      if (d < spec.radius * 1.6) {
        const f = 1 - d / (spec.radius * 1.6);
        // Rocket jumping: shove the player, don't just hurt them.
        _v1.copy(player.position).sub(point);
        if (_v1.lengthSq() < 0.01) _v1.set(0, 1, 0);
        _v1.normalize();
        player.velocity.addScaledVector(_v1, f * 16);
        player.velocity.y += f * 6;
        addShake(f * 0.16, f * 0.05);
        ctx.emit("palmas:shake", { amount: f });
      }
    }
  }

  function addShake(amount: number, rot: number) {
    shakeVel.x += (ctx.rng() - 0.5) * amount * 60;
    shakeVel.y += (ctx.rng() - 0.5) * amount * 60;
    shakeVel.z += (ctx.rng() - 0.5) * amount * 40;
    camKick.kick((ctx.rng() - 0.5) * rot * 8, (ctx.rng() - 0.5) * rot * 8, 0);
  }

  // ── Firing ──────────────────────────────────────────────────────────────

  function fireShot() {
    const def = current.def;
    const cam = ctx.camera;

    // Compose the true aim: the player's look plus the recoil already applied
    // to the camera. Bullets go where the picture points.
    _e1.set(camKick.value.x, camKick.value.y, 0, "YXZ");
    _q1.setFromEuler(_e1);
    _q2.copy(cam.quaternion).multiply(_q1);
    _origin.copy(cam.position);

    const player = ctx.services.player;
    const speed = player ? Math.hypot(player.velocity.x, player.velocity.z) : 0;
    const airborne = player?.state === "air";
    const base = THREE.MathUtils.lerp(def.spread, def.spreadAds, adsT);
    const moveCone = def.spreadMove * (Math.min(speed / SPRINT_SPEED, 1) * 0.7 + (airborne ? 0.6 : 0));
    const cone = base + moveCone + bloom;

    let anyHit = false;
    if (def.ballistic === "rocket") {
      _dir.copy(FORWARD).applyQuaternion(_q2);
      coneJitter(_dir, cone);
      launchRocket(_origin, _dir, def);
    } else {
      for (let p = 0; p < def.pellets; p++) {
        _dir.copy(FORWARD).applyQuaternion(_q2);
        coneJitter(_dir, p === 0 && def.pellets > 1 ? cone * 0.25 : cone);
        if (hitscan(_origin, _dir, def)) anyHit = true;
      }
    }

    // ── Reaction ──────────────────────────────────────────────────────────
    const r = def.recoil;
    const pat = r.pattern[current.shotIndex % r.pattern.length];
    const jY = 1 + (ctx.rng() - 0.5) * r.jitter;
    const jX = 1 + (ctx.rng() - 0.5) * r.jitter * 0.5;
    const adsDamp = 1 - adsT * 0.35;
    current.shotIndex++;

    // Convert peak displacements into spring impulses: for a lightly damped
    // oscillator the first peak is v0/ω, so v0 = peak · ω.
    const wPos = Math.sqrt(r.stiffness);
    const wRot = Math.sqrt(r.stiffness * 1.15);
    const wCam = Math.sqrt(r.stiffness * 0.55);

    recoilPos.kick(
      (ctx.rng() - 0.5) * r.back * 0.4 * wPos,
      r.back * 0.25 * wPos,
      r.back * wPos * adsDamp,
    );
    // +X pitches the muzzle up, which is exactly what recoil should do.
    recoilRot.kick(
      r.vmPitch * wRot * pat[1] * adsDamp,
      r.vmYaw * wRot * pat[0] * jY * adsDamp,
      r.vmRoll * wRot * pat[0] * jX * adsDamp,
    );
    camKick.kick(
      r.camPitch * wCam * pat[1] * jX * adsDamp,
      r.camYaw * wCam * pat[0] * jY * adsDamp,
      0,
    );
    addShake(r.shake * adsDamp, r.shake * 0.5);
    fovPunch += def.ballistic === "rocket" ? 4.5 : 1.1;

    bloom = Math.min(def.bloomMax, bloom + def.bloom);
    flashTime = def.flashScale > 0.5 ? 0.055 : 0.03;
    if (flashLight) flashLight.intensity = 26 * def.flashScale;

    // World-space muzzle flash for the VFX layer (other players/reflections).
    if (rigWarm) {
      current.rig.muzzle.updateWorldMatrix(true, false);
      _mat4.copy(current.rig.muzzle.matrixWorld);
      ctx.services.vfx?.muzzleFlash(_mat4, def.flashScale);
    }

    // Slide/bolt cycle.
    if (def.slideTravel > 0 && def.mode !== "pump") {
      slidePhase = 1;
      slideTimer = def.slideTime;
    }

    // Brass.
    if (def.shell !== "none") ejectShell(def);

    ctx.services.audio?.play(def.sound, { volume: def.soundVolume, rate: 0.96 + ctx.rng() * 0.08 });

    if (anyHit) {
      hitstop = 0.045;
      ctx.emit("palmas:hitmarker", { kind: "hit" });
      ctx.services.audio?.play("hitmarker", { volume: 0.4 });
    }

    current.ammo--;
    if (def.mode === "pump" && current.ammo > 0) {
      slidePhase = 1;
      slideTimer = def.slideTime;
    }
  }

  function ejectShell(def: WeaponDef) {
    if (!rigWarm) return;
    const pool = def.shell === "shotgun" ? hullShells : brassShells;
    current.rig.eject.getWorldPosition(_v1);
    // Eject to the shooter's right and slightly up, with a bit of forward carry.
    _v2.set(1, 0, 0).applyQuaternion(ctx.camera.quaternion).multiplyScalar(def.shellEjectSpeed * (0.8 + ctx.rng() * 0.5));
    _v2.y += 1.6 + ctx.rng() * 0.9;
    _v3.copy(FORWARD).applyQuaternion(ctx.camera.quaternion).multiplyScalar(0.4);
    _v2.add(_v3);
    const pv = ctx.services.player?.velocity;
    if (pv) _v2.addScaledVector(pv, 0.85);
    pool.spawn(_v1, _v2, ctx.rng);
  }

  function beginReload() {
    const def = current.def;
    if (reloading > 0 || swap > 0) return;
    if (current.ammo >= def.magSize || current.reserve <= 0) return;
    reloadTotal = def.reload;
    reloading = def.reload;
    reloadBeat = 0;
    charge = 0;
    ctx.services.audio?.play("magOut", { volume: 0.5 });
    markHudDirty();
  }

  function finishReload() {
    const def = current.def;
    const want = def.magSize - current.ammo;
    const take = Math.min(want, current.reserve);
    current.ammo += take;
    current.reserve -= take;
    current.shotIndex = 0;
    slidePhase = 0;
    markHudDirty();
  }

  function requestSwitch(next: number) {
    if (next === index || next < 0 || next >= weapons.length) return;
    if (swap > 0) return;
    pendingIndex = next;
    swapTotal = current.def.swapTime;
    swap = swapTotal;
    reloading = 0;
    charge = 0;
    spin = 0;
    ctx.services.audio?.play("weaponSwitch", { volume: 0.4 });
  }

  const offWheel = ctx.on("palmas:wheel", (payload) => {
    const dir = typeof payload === "number" ? Math.sign(payload) : 1;
    requestSwitch((index + dir + weapons.length) % weapons.length);
  });

  let hudDirty = true;
  function markHudDirty() {
    hudDirty = true;
  }

  // ── Pose evaluation ─────────────────────────────────────────────────────

  /**
   * Build the viewmodel transform for this frame. Every channel is additive so
   * they layer cleanly: base pose -> ADS blend -> sprint -> wall tuck -> sway
   * -> bob -> recoil -> reload choreography -> swap.
   */
  function poseViewmodel(dt: number) {
    const def = current.def;
    const rg = current.rig;

    // Base and ADS poses.
    const hip = _v1.set(def.hip[0], def.hip[1], def.hip[2]);
    const ads = _v2.set(-rg.optic.position.x * current.scale, -rg.optic.position.y * current.scale, ADS_Z);
    posePos.copy(hip).lerp(ads, adsT);
    poseRot.set(
      THREE.MathUtils.lerp(def.hipRot[0], 0, adsT),
      THREE.MathUtils.lerp(def.hipRot[1], 0, adsT),
      THREE.MathUtils.lerp(def.hipRot[2], 0, adsT),
    );

    // Sprint: drop and cant the weapon out of the way. Reads instantly.
    if (sprintT > 0.001) {
      posePos.y -= 0.075 * sprintT;
      posePos.z += 0.045 * sprintT;
      posePos.x += 0.02 * sprintT;
      poseRot.x -= 0.5 * sprintT;
      poseRot.y -= 0.55 * sprintT;
      poseRot.z += 0.42 * sprintT;
    }

    // Wall tuck: port arms. Muzzle up (+X) and pulled in, so the barrel goes
    // over the obstruction instead of into it.
    if (tuckT > 0.001) {
      posePos.z += 0.05 * tuckT;
      posePos.y -= 0.03 * tuckT;
      poseRot.x += 0.5 * tuckT;
      poseRot.y -= 0.28 * tuckT;
    }

    // Sway — the viewmodel lags the mouse, heavier guns lag more. Positional
    // sway is kept inside the 0.04 m budget the clearance fit reserves for it;
    // the rotational component carries most of the read anyway.
    const swayScale = 1 - adsT * 0.6;
    posePos.x += sway.x * 0.03 * swayScale;
    posePos.y += sway.y * 0.03 * swayScale;
    poseRot.y += sway.x * 0.2 * swayScale;
    poseRot.x += -sway.y * 0.17 * swayScale;
    poseRot.z += sway.x * 0.13 * swayScale;

    // Walk / sprint bob — figure-eight, halved while aiming.
    const amp = bobAmp * (1 - adsT * 0.72);
    posePos.x += Math.sin(bobPhase) * 0.016 * amp;
    posePos.y += Math.sin(bobPhase * 2) * 0.011 * amp;
    poseRot.z += Math.sin(bobPhase) * 0.05 * amp;
    poseRot.x += Math.sin(bobPhase * 2) * 0.022 * amp;

    // Recoil springs.
    posePos.add(recoilPos.value);
    poseRot.x += recoilRot.value.x;
    poseRot.y += recoilRot.value.y;
    poseRot.z += recoilRot.value.z;

    // Reload choreography.
    if (reloading > 0 && reloadTotal > 0) {
      const t = 1 - reloading / reloadTotal;
      const [dropAt, insertAt, chargeAt] = def.reloadBeats;
      // Tilt the gun toward the player and down while the hands work.
      const tilt = Math.sin(Math.min(1, t / 0.18) * Math.PI * 0.5) * (1 - Math.max(0, (t - 0.82) / 0.18));
      posePos.y -= 0.06 * tilt;
      posePos.x -= 0.02 * tilt;
      poseRot.z += 0.55 * tilt;
      poseRot.x -= 0.25 * tilt;
      poseRot.y += 0.3 * tilt;

      if (rg.mag) {
        let magY = 0;
        let magT = 0;
        if (t < dropAt) {
          magY = 0;
        } else if (t < insertAt) {
          // Free-fall out of frame.
          const k = (t - dropAt) / (insertAt - dropAt);
          magY = -k * k * 0.45;
          magT = k * 0.6;
        } else {
          // New mag rises into the well and seats with a snap.
          const k = Math.min(1, (t - insertAt) / Math.max(0.001, chargeAt - insertAt));
          const e = 1 - Math.pow(1 - k, 3);
          magY = -0.45 * (1 - e);
          magT = 0.6 * (1 - e);
        }
        rg.mag.position.y = magY;
        rg.mag.rotation.x = magT;
        rg.mag.visible = !(t >= insertAt - 0.02 && t < insertAt + 0.02);
      }

      // Charge the bolt at the end of the sequence.
      if (def.slideTravel > 0) {
        const k = (t - chargeAt) / Math.max(0.001, 1 - chargeAt);
        if (k > 0 && k < 1) slidePhase = Math.sin(k * Math.PI);
      }
    } else if (rg.mag) {
      rg.mag.position.y = 0;
      rg.mag.rotation.x = 0;
      rg.mag.visible = true;
    }

    // Swap: dive out of frame, switch, rise back in.
    if (swap > 0 && swapTotal > 0) {
      const t = 1 - swap / swapTotal;
      const k = t < 0.5 ? t / 0.5 : 1 - (t - 0.5) / 0.5;
      const e = k * k;
      posePos.y -= 0.2 * e;
      posePos.z += 0.06 * e;
      // Muzzle down and out of frame — -X, not +X.
      poseRot.x -= 1.15 * e;
      poseRot.z += 0.35 * e;
    }

    rg.root.position.copy(posePos);
    rg.root.rotation.copy(poseRot);

    // Reciprocating mass — slide, bolt carrier or pump, all travel rearward.
    if (rg.slide) rg.slide.position.z = def.slideTravel * slidePhase;

    // Rotary barrels.
    if (rg.barrels) {
      spinAngle += spin * 42 * dt;
      rg.barrels.rotation.z = spinAngle;
    }

    // Emissive channels: railgun charge, minigun heat.
    if (rg.emissive) {
      if (def.mode === "charge") {
        rg.emissive.emissiveIntensity = 0.12 + charge * charge * 5.5 + flashTime * 40;
      } else {
        rg.emissive.emissiveIntensity = heat * 4.2;
      }
    }

    // Muzzle flash billboard, placed at the real muzzle in viewmodel space.
    if (flashTime > 0) {
      const s = (0.16 + ctx.rng() * 0.1) * def.flashScale * current.scale * 3.2;
      flash.visible = true;
      flash.position.copy(rg.muzzle.position).multiplyScalar(current.scale).applyEuler(poseRot).add(posePos);
      flash.rotation.set(0, 0, ctx.rng() * Math.PI * 2);
      flash.scale.setScalar(s);
      flashMat.opacity = Math.min(1, flashTime * 22);
      // Push the muzzle light slightly downrange of the flash so the bloom
      // lands on the wall you're shooting, not on the receiver.
      if (flashLight) flashLight.position.copy(flash.position).addScaledVector(FORWARD, 0.25);
    } else if (flash.visible) {
      flash.visible = false;
    }
  }

  // ── Update ──────────────────────────────────────────────────────────────

  const sys: System = {
    name: "weapons",

    update(dt) {
      const input = ctx.input;
      const player = ctx.services.player;
      const def = current.def;

      // Traversal and vehicles own the player during their states; stow the
      // weapon and stay out of the camera entirely.
      const stowed =
        !player ||
        player.health <= 0 ||
        player.state === "wingsuit" ||
        player.state === "parachute" ||
        player.state === "grapple" ||
        player.state === "vehicle";

      // Hitstop: freeze the viewmodel (not the world) for a few frames on a
      // confirmed hit. Cheap, and it makes every connection feel solid.
      hitstop = Math.max(0, hitstop - dt);
      const vdt = hitstop > 0 ? dt * 0.18 : dt;

      // ── Weapon selection ────────────────────────────────────────────────
      if (!stowed && input.weaponSlot != null) {
        const found = weapons.findIndex((w) => w.def.slot === input.weaponSlot);
        if (found >= 0) requestSwitch(found);
      }

      if (swap > 0) {
        swap = Math.max(0, swap - dt);
        if (pendingIndex >= 0 && swap <= swapTotal * 0.5) {
          current.rig.root.visible = false;
          index = pendingIndex;
          pendingIndex = -1;
          current = weapons[index];
          current.rig.root.visible = !stowed;
          bloom = 0;
          slidePhase = 0;
          markHudDirty();
        }
      }

      // Only the active weapon is ever in the frame; the rest sit at
      // visible=false and cost nothing but a matrix update.
      current.rig.root.visible = !stowed;
      if (stowed) {
        // Bleed everything down so we don't snap back on re-entry.
        adsT = approach(adsT, 0, 14, dt);
        spin = approach(spin, 0, 3, dt);
        charge = 0;
      }

      // ── Reload ──────────────────────────────────────────────────────────
      if (reloading > 0) {
        const prev = 1 - reloading / reloadTotal;
        reloading = Math.max(0, reloading - dt);
        const now = 1 - reloading / reloadTotal;
        const [dropAt, insertAt, chargeAt] = def.reloadBeats;
        if (prev < dropAt && now >= dropAt) {
          ctx.services.audio?.play("shellDrop", { volume: 0.35 });
          reloadBeat = 1;
        }
        if (prev < insertAt && now >= insertAt) {
          ctx.services.audio?.play("magIn", { volume: 0.55 });
          reloadBeat = 2;
        }
        if (prev < chargeAt && now >= chargeAt) {
          ctx.services.audio?.play("boltBack", { volume: 0.5 });
          reloadBeat = 3;
        }
        if (reloading <= 0) {
          finishReload();
          reloadBeat = 0;
        }
      } else if (!stowed && input.reload) {
        beginReload();
      }

      // ── Sprint / tuck gates ─────────────────────────────────────────────
      const speed = player ? Math.hypot(player.velocity.x, player.velocity.z) : 0;
      const sprinting =
        !stowed && input.sprint && input.moveZ > 0.2 && speed > WALK_SPEED * 0.9 && !input.aim && reloading <= 0;
      sprintT = approach(sprintT, sprinting ? 1 : 0, 11, dt);

      // Wall probe — the second line of defence against clipping and a nice
      // "gun up against a wall" beat in tight interiors.
      let tuckTarget = 0;
      if (!stowed && ctx.services.collision) {
        _dir.copy(FORWARD).applyQuaternion(ctx.camera.quaternion);
        const probe = ctx.services.collision.raycast(ctx.camera.position, _dir, 1.15);
        if (probe) tuckTarget = THREE.MathUtils.clamp(1 - probe.distance / 1.15, 0, 1);
      }
      tuckT = approach(tuckT, tuckTarget, 12, dt);

      // ── ADS ─────────────────────────────────────────────────────────────
      const wantAds = !stowed && input.aim && def.adsAllowed && sprintT < 0.4 && reloading <= 0;
      adsT = approach(adsT, wantAds ? 1 : 0, 1 / Math.max(0.02, def.adsTime * 0.34), dt);

      // ── Fire control ────────────────────────────────────────────────────
      cooldown = Math.max(0, cooldown - dt);
      const interval = 60 / Math.max(1, def.rpm);
      const held = !stowed && input.fire && reloading <= 0 && swap <= 0 && sprintT < 0.5 && tuckT < 0.85;
      const edge = held && !lastFireHeld;

      // Minigun spool.
      if (def.mode === "spin") {
        const wantSpin = held && current.ammo > 0;
        const rate = wantSpin ? 1 / Math.max(0.05, def.spinUp ?? 0.6) : -1 / Math.max(0.05, def.spinDown ?? 1);
        const before = spin;
        spin = THREE.MathUtils.clamp(spin + rate * dt, 0, 1);
        if (before < 0.02 && spin >= 0.02) ctx.services.audio?.play("spinUp", { volume: 0.5 });
        if (before > 0.02 && spin <= 0.02) ctx.services.audio?.play("spinDown", { volume: 0.4 });
        heat = THREE.MathUtils.clamp(heat + (spin > 0.9 && held ? dt * 0.7 : -dt * 0.4), 0, 1);
      } else {
        spin = approach(spin, 0, 4, dt);
        heat = approach(heat, 0, 1.2, dt);
      }

      // Railgun charge. Gated on the cooldown so every shot pays the ritual.
      if (def.mode === "charge") {
        if (held && current.ammo > 0 && cooldown <= 0) {
          if (charge <= 0 && !chargeAudio) {
            ctx.services.audio?.play("railCharge", { volume: 0.6 });
            chargeAudio = true;
          }
          charge = Math.min(1, charge + dt / Math.max(0.05, def.chargeTime ?? 1));
        } else if (charge > 0) {
          charge = Math.max(0, charge - dt * 2.2);
          if (charge <= 0) chargeAudio = false;
        }
      }

      let wantsShot = false;
      if (held && current.ammo > 0 && cooldown <= 0) {
        switch (def.mode) {
          case "auto":
            wantsShot = true;
            break;
          case "semi":
          case "pump":
            wantsShot = edge;
            break;
          case "spin":
            wantsShot = spin >= 0.995;
            break;
          case "charge":
            wantsShot = charge >= 1;
            break;
        }
      }

      if (wantsShot) {
        fireShot();
        cooldown = def.mode === "pump" ? Math.max(interval, def.slideTime + 0.06) : interval;
        if (def.mode === "charge") {
          charge = 0;
          chargeAudio = false;
        }
        if (current.ammo <= 0) beginReload();
        markHudDirty();
      } else if (edge && current.ammo <= 0 && reloading <= 0 && def.mode !== "spin" && def.mode !== "charge") {
        ctx.services.audio?.play("dryFire", { volume: 0.4 });
        recoilPos.kick(0, 0, 3.5);
        beginReload();
      }
      lastFireHeld = held;

      // ── Feel channels ───────────────────────────────────────────────────
      bloom = Math.max(0, bloom - def.bloomDecay * bloom * dt - 0.0006 * dt);
      if (bloom < 0.00005) bloom = 0;

      // Sway: a critically damped follow of accumulated look delta.
      const lag = 1 / (0.055 + def.weight * 0.055);
      const swayTargetX = THREE.MathUtils.clamp(-input.lookX * 12, -1, 1);
      const swayTargetY = THREE.MathUtils.clamp(input.lookY * 12, -1, 1);
      swayVel.x += (swayTargetX - sway.x) * lag * 8 * vdt;
      swayVel.y += (swayTargetY - sway.y) * lag * 8 * vdt;
      swayVel.multiplyScalar(Math.max(0, 1 - 11 * vdt));
      sway.x += swayVel.x * vdt;
      sway.y += swayVel.y * vdt;

      // Bob.
      const grounded = player?.state === "ground";
      const bobSpeed = grounded ? Math.min(speed / SPRINT_SPEED, 1.3) : 0;
      bobPhase += vdt * (4.4 + bobSpeed * 7.5) * (bobSpeed > 0.05 ? 1 : 0);
      bobAmp = approach(bobAmp, grounded ? bobSpeed : 0, 8, dt);

      // Springs.
      const r = def.recoil;
      recoilPos.step(vdt, r.stiffness, r.damping);
      recoilRot.step(vdt, r.stiffness * 1.15, r.damping * 1.05);
      camKick.step(dt, r.stiffness * 0.55, r.damping * 0.8);

      // Shake decays independently — a spring to zero with heavy damping.
      shakeVel.multiplyScalar(Math.max(0, 1 - 9 * dt));
      shake.addScaledVector(shakeVel, dt);
      shake.multiplyScalar(Math.max(0, 1 - 13 * dt));

      // Reset the pattern once the player stops shooting.
      if (!held && cooldown <= 0 && recoilRot.value.lengthSq() < 0.0004) current.shotIndex = 0;

      // Slide cycle.
      if (slideTimer > 0) {
        slideTimer = Math.max(0, slideTimer - vdt);
        const k = slideTimer / Math.max(0.0001, def.slideTime);
        // Snap back fast, return slower — that asymmetry is the whole read.
        slidePhase = k > 0.6 ? (1 - k) / 0.4 : k / 0.6;
        if (def.mode === "pump" && slideTimer <= 0) ctx.services.audio?.play("pump", { volume: 0.5 });
        if (slideTimer <= 0) slidePhase = 0;
      } else if (reloading <= 0) {
        slidePhase = current.ammo <= 0 && def.slideTravel > 0 ? 1 : slidePhase;
      }

      flashTime = Math.max(0, flashTime - dt);
      if (flashLight) flashLight.intensity = Math.max(0, flashLight.intensity - dt * 900);
      fovPunch = approach(fovPunch, 0, 9, dt);

      // ── Pools ───────────────────────────────────────────────────────────
      brassShells.update(dt, groundAt, (p, hard) => {
        if (hard && ctx.rng() < 0.5) ctx.services.audio?.play("shellDrop", { position: p, volume: 0.16 });
      });
      hullShells.update(dt, groundAt, (p, hard) => {
        if (hard) ctx.services.audio?.play("shellDrop", { position: p, volume: 0.22, rate: 0.7 });
      });
      updateRockets(dt);

      // ── HUD ─────────────────────────────────────────────────────────────
      emitHud();
    },

    lateUpdate(dt) {
      const player = ctx.services.player;
      const cam = ctx.camera;
      const stowed =
        !player ||
        player.health <= 0 ||
        player.state === "wingsuit" ||
        player.state === "parachute" ||
        player.state === "grapple" ||
        player.state === "vehicle";

      if (!stowed) {
        // ── Camera layer ────────────────────────────────────────────────
        // The player controller has already written pitch/yaw this frame; we
        // add recoil and shake on top, then the rig copies the result so the
        // viewmodel rides the kicked view.
        cam.rotation.x += camKick.value.x + shake.x * 0.35;
        cam.rotation.y += camKick.value.y + shake.y * 0.35;
        cam.rotation.z += shake.z * 0.6 + camKick.value.y * 0.5;
        cam.position.x += shake.x * 0.02;
        cam.position.y += shake.y * 0.02;

        // Weapons owns the final FOV: we replicate the controller's
        // speed-scaled target so ADS pull and fire punch survive its lerp.
        const speed = Math.hypot(player.velocity.x, player.velocity.z);
        const target = BASE_FOV + THREE.MathUtils.clamp((speed - WALK_SPEED) * 0.9, 0, 14);
        fovBase = approach(fovBase, target, 5, dt);
        const adsFov = THREE.MathUtils.lerp(fovBase, current.def.adsFov, adsT);
        const wanted = adsFov + fovPunch + charge * -4;
        if (Math.abs(cam.fov - wanted) > 0.01) {
          cam.fov = wanted;
          cam.updateProjectionMatrix();
        }
      }

      rig.position.copy(cam.position);
      rig.quaternion.copy(cam.quaternion);
      rig.visible = !stowed;
      if (!stowed) {
        poseViewmodel(hitstop > 0 ? dt * 0.18 : dt);
        rigWarm = true;
      }
      rig.updateMatrixWorld(true);
    },

    dispose() {
      offWheel();
      ctx.scene.remove(rig, brassShells.mesh, hullShells.mesh);
      for (const r of rockets) ctx.scene.remove(r.mesh);
      for (const g of kit.geometries) g.dispose();
      for (const m of kit.materials) m.dispose();
      for (const t of kit.textures) t.dispose();
      brassShells.mesh.dispose();
      hullShells.mesh.dispose();
    },
  };

  // ── Rocket integration ────────────────────────────────────────────────────

  function updateRockets(dt: number) {
    const collision = ctx.services.collision;
    const terrain = ctx.services.terrain;
    for (const r of rockets) {
      if (!r.active) continue;
      r.life -= dt;
      if (r.life <= 0) {
        detonate(r, r.pos);
        continue;
      }

      const spec = r.spec;
      // Drag then gravity — a rocket that only ever flies straight is boring.
      r.vel.multiplyScalar(Math.max(0, 1 - spec.drag * dt));
      r.vel.y += spec.gravity * dt;

      const step = r.vel.length() * dt;
      if (step > 0.0001) {
        _dir.copy(r.vel).divideScalar(r.vel.length());

        // Actors first — a rocket should detonate on the thing you aimed at.
        const td = firstTargetAlong(r.pos, _dir, step + 0.6);
        if (td >= 0 && td <= step + 0.6) {
          _v1.copy(r.pos).addScaledVector(_dir, td);
          detonate(r, _v1);
          continue;
        }

        const hit = collision?.raycast(r.pos, _dir, step + 0.5);
        if (hit) {
          detonate(r, hit.point);
          continue;
        }

        r.pos.addScaledVector(r.vel, dt);

        if (terrain) {
          const gy = terrain.heightAt(r.pos.x, r.pos.z);
          const sea = terrain.seaLevel;
          if (r.pos.y <= gy) {
            r.pos.y = gy;
            detonate(r, r.pos);
            continue;
          }
          if (r.pos.y <= sea && terrain.isWater(r.pos.x, r.pos.z)) {
            r.pos.y = sea;
            // Water kills it without the fireball.
            r.active = false;
            r.mesh.visible = false;
            ctx.services.vfx?.impact(r.pos, UP, "water");
            ctx.services.audio?.play("explosion", { position: r.pos, volume: 0.35, rate: 0.7 });
            continue;
          }
        }

        r.mesh.position.copy(r.pos);
        _v1.copy(r.pos).add(r.vel);
        r.mesh.lookAt(_v1);
        r.mesh.rotateY(Math.PI); // model points down -Z

        // Smoke trail, rate-limited so we don't flood the particle budget.
        r.trail += dt;
        const trailStep = cheap ? 0.09 : 0.035;
        if (r.trail >= trailStep) {
          r.trail = 0;
          ctx.services.vfx?.smoke(r.pos, 1);
        }
      }
    }
  }

  // ── HUD emission ────────────────────────────────────────────────────────

  function emitHud() {
    const def = current.def;
    const key = `${def.id}|${current.ammo}|${current.reserve}|${reloading > 0 ? 1 : 0}|${reloadBeat}`;
    if (hudDirty || key !== hudKey) {
      hudKey = key;
      hudDirty = false;
      ctx.emit("palmas:weapon", {
        id: def.id,
        name: def.name,
        short: def.short,
        role: def.role,
        slot: def.slot,
        mode: def.mode,
        ammo: current.ammo,
        magSize: def.magSize,
        reserve: current.reserve,
        reloading: reloading > 0,
        reloadProgress: reloading > 0 && reloadTotal > 0 ? 1 - reloading / reloadTotal : 0,
        lowAmmo: current.ammo <= Math.max(1, Math.ceil(def.magSize * 0.25)),
        empty: current.ammo <= 0,
        slots: weapons.map((w) => ({ slot: w.def.slot, short: w.def.short, id: w.def.id, active: w === current })),
      });
    }

    // Crosshair bloom is its own, cheaper channel — it changes every frame
    // while shooting and the HUD wants it without a full weapon payload.
    const base = THREE.MathUtils.lerp(def.spread, def.spreadAds, adsT);
    const spreadNorm = THREE.MathUtils.clamp((base + bloom) / 0.09, 0, 1);
    const quantised = Math.round(spreadNorm * 60) / 60;
    if (quantised !== lastCrosshair) {
      lastCrosshair = quantised;
      ctx.emit("palmas:crosshair", {
        spread: quantised,
        ads: adsT,
        charge,
        spin,
        heat,
        hidden: sprintT > 0.5,
      });
    }
  }

  return sys;
};

export default createWeapons;
