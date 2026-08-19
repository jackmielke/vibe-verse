/**
 * THE EMPYREAN — the rooms you can walk into.
 *
 * Everything else in this world is sky: glass towers with a sunset behind
 * them, a lake nine hundred metres down, air on all six sides. That is the
 * whole picture and it is also the whole problem — after two minutes of it the
 * eye has nothing left to be surprised by. The strongest contrast available in
 * a place made of sky is a small warm room with a ceiling on it, so these five
 * rooms are where the contrast budget gets spent.
 *
 * ## The rules they are built to
 *
 * **You walk in.** There is no loading screen, no fade, no door to press a key
 * on. Every interior is real geometry standing on the deck from the first
 * frame; the opening is a hole in a wall, aligned with the landmark's `yaw`,
 * wide enough to walk through without aiming, and there is never a blocker
 * across it. A room you cannot enter is the classic failure here and
 * `src/test/empyreanInteriors.test.ts` walks the straight line from the
 * doorstep to the middle of every room to prove it.
 *
 * **The sun does not come inside.** The world's key light is a directional
 * light aimed at a city of glass; indoors it reaches only what is under a
 * skylight. So the surface shader here does its own lighting from a handful of
 * *virtual* lamps carried in a uniform — free, unlimited, and they cannot
 * trigger a light-count recompile — and the sun contributes only where a
 * vertex is marked `aSky`, which is to say under the Market Hall's glazing and
 * through the Observatory's shutter. Six *real* `PointLight`s exist as a pool
 * on top of that, so the character walking in is lit warm by the room. The
 * pool is built once and never resized: its lights are moved and their
 * intensity is driven to zero, because toggling `visible` changes the light
 * count and every lit material in the scene recompiles the frame you do it.
 *
 * **Local space, one group, one matrix.** Each room is authored with +Z
 * pointing out through its own front door and the floor at y = 0, and is then
 * hung on a `THREE.Group` rotated to the landmark's yaw. Nothing is baked into
 * world coordinates except the things that have to be: blockers, decks, lamp
 * positions and interactables.
 *
 * ## The one ugly compromise, written down
 *
 * `Blocker` is an axis-aligned box in *world* XZ, and the Market Hall stands
 * at 135°. A rotated wall cannot be an AABB, so oblique walls and counters are
 * chopped into ~1.2 m pieces before they are converted, each piece becoming
 * the AABB that contains it. That is a handful of centimetres of invisible
 * padding on an oblique surface and a few hundred boxes in a list the engine
 * scans linearly twice a frame — which is nothing — in exchange for never
 * needing an oriented-box test in the flight code. Rooms whose yaw happens to
 * be axis-aligned (the Observatory at -90°, Halo Station at 180°) are detected
 * and not chopped at all.
 *
 * ## Reserved volumes
 *
 * `buildings.ts` owns the shells; this file owns what is inside them and
 * assumes nothing about how they look. Each room keeps well inside its
 * landmark's `clear` radius — the numbers are on `interiorPlan()` — and the
 * two lot rooms (the café, the gallery) name the lot they are standing in on
 * `claimedLots`, so the exterior can skip a facade or the engine can drop that
 * lot's blocker.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { makeRng, type Rng } from "@/shared/proc/rng";
import { ISLAND_Y } from "./config";
import { cityPlan, LANDMARKS, type Landmark, type Lot } from "./cityplan";
import { SUN_DIR } from "./sky";
import type { BuildContext, FrameContext, Interactable, System } from "./types";

/* -------------------------------------------------------------------------
 * The exported shape
 * ---------------------------------------------------------------------- */

/** A solid box in world XZ. The same shape `citadel.ts` and `world.ts` use. */
export interface Blocker {
  x: number;
  z: number;
  hx: number;
  hz: number;
  /** Walkable roof. */
  top: number;
  /** Underside — you can walk beneath a mezzanine without being stopped. */
  bottom: number;
}

/** A flat surface you can stand on: a platform, a mezzanine, one stair tread. */
export interface Deck {
  y: number;
  x?: number;
  z?: number;
  hx?: number;
  hz?: number;
  r?: number;
}

/** What one interior is, without any THREE in it. Pure, and cheap to test. */
export interface InteriorInfo {
  id: string;
  name: string;
  /** Middle of the floor, world. */
  x: number;
  y: number;
  z: number;
  /** Which way the opening faces, radians, matching the landmark convention. */
  yaw: number;
  /** Interior half-extents in the room's own frame: hx across, hz front-to-back. */
  hx: number;
  hz: number;
  /** True for a room whose plan is a circle of radius `hx`, not a rectangle. */
  round?: boolean;
  /** Ceiling, or the crown of the vault. */
  height: number;
  /** Clear width of the opening, metres. */
  openWidth: number;
  /** The pavement outside the opening — where you are standing when you see in. */
  doorstep: { x: number; z: number };
  /** Furthest corner of the room from its centre. */
  extent: number;
  /** Landmark this room belongs to, if any. */
  landmark?: string;
  /** Lot this room stands on, if any. `buildings.ts` may want to know. */
  lot?: string;
}

export interface InteriorsHandle extends System {
  blockers: Blocker[];
  decks: Deck[];
  interactables(): Interactable[];
  /** Which interior the player is inside, or null. For audio and the HUD. */
  inside(x: number, y: number, z: number): string | null;
  /** The rooms, as data. Same array `interiorPlan()` returns. */
  readonly rooms: readonly InteriorInfo[];
  /** Lots these interiors stand in. Nothing else should build on them. */
  readonly claimedLots: readonly string[];
  /**
   * Where an interactable's message goes. The engine sets this to whatever
   * pushes a `Toast`; until it does, activating something is a no-op.
   */
  onToast: ((text: string, tone?: "info" | "good" | "warn") => void) | null;
}

/* -------------------------------------------------------------------------
 * Numbers
 * ---------------------------------------------------------------------- */

/** How near you have to be for a room's real lights and animation to run. */
const WAKE_R = 60;
/** Past this the room is not drawn at all — the shell is in the way anyway. */
const DRAW_R = 320;
/** Real `PointLight`s, total, across every interior in the world. */
const LIGHT_POOL = 6;
/** Virtual lamps per room, in the surface shader. Free; this is just the array size. */
const NL = 6;

const TAU = Math.PI * 2;

/** Sun azimuth, world. The Observatory's shutter is cut to look down it. */
const SUN_AZ = Math.atan2(SUN_DIR.z, SUN_DIR.x);

/* -------------------------------------------------------------------------
 * Materials
 * ---------------------------------------------------------------------- */

const SURFACE_VERT = /* glsl */ `
attribute vec3 aCol;
attribute vec3 aTint;
attribute float aEmit;
attribute float aSky;
varying vec3 vCol;
varying vec3 vNrm;
varying vec3 vPos;
varying float vEmit;
varying float vSky;
void main() {
  vCol = aCol * aTint;
  vEmit = aEmit;
  vSky = aSky;
  vec4 p = vec4(position, 1.0);
  vec3 n = normal;
  #ifdef USE_INSTANCING
    p = instanceMatrix * p;
    n = mat3(instanceMatrix) * n;
  #endif
  vec4 world = modelMatrix * p;
  vPos = world.xyz;
  vNrm = normalize(mat3(modelMatrix) * n);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * One room's worth of lighting, computed here rather than by the renderer.
 *
 * Six point positions in a uniform, an inverse-square-ish falloff and a
 * wrapped Lambert. It costs six loop iterations a pixel and it buys the thing
 * that actually matters indoors: light that has a *place* — brightest at the
 * lamp, dying two stalls away — rather than a flat ambient that makes a room
 * look like a diagram of a room.
 */
const SURFACE_FRAG = /* glsl */ `
precision highp float;
uniform vec4 uLamp[${NL}];
uniform vec3 uLampC[${NL}];
uniform vec3 uAmbTop;
uniform vec3 uAmbFloor;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
varying vec3 vCol;
varying vec3 vNrm;
varying vec3 vPos;
varying float vEmit;
varying float vSky;

void main() {
  vec3 N = normalize(vNrm);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vPos);

  /* Ambient is two colours, not one: the cool bounce off whatever glazing the
     room has, and the warm bounce back up off its own floor. A single ambient
     term is the flattest a room can look. */
  float up = N.y * 0.5 + 0.5;
  vec3 lit = mix(uAmbFloor, uAmbTop, up);

  /* The sun, but only where a vertex has been told it can see sky. */
  lit += uSunCol * max(dot(N, uSunDir), 0.0) * vSky;
  lit += uSunCol * 0.22 * vSky;

  float spec = 0.0;
  for (int i = 0; i < ${NL}; i++) {
    vec3 d = uLamp[i].xyz - vPos;
    float dist = length(d);
    float att = clamp(1.0 - dist / max(uLamp[i].w, 0.001), 0.0, 1.0);
    att *= att;
    if (att <= 0.0) continue;
    vec3 L = d / max(dist, 0.001);
    float lam = max(dot(N, L), 0.0) * 0.86 + 0.14;
    lit += uLampC[i] * att * lam;
    vec3 H = normalize(L + V);
    spec += pow(max(dot(N, H), 0.0), 42.0) * att;
  }

  vec3 col = vCol * lit;
  col += vCol * vEmit * 2.4;
  col += spec * 0.16;
  /* A whisper of fresnel keeps glass and polished counters from reading as
     matte cardboard at grazing angles, which indoors is most of them. */
  col += vCol * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0) * 0.30;
  gl_FragColor = vec4(col, 1.0);
}
`;

function makeSurfaceMaterial(): THREE.ShaderMaterial {
  const lamp: THREE.Vector4[] = [];
  const lampC: THREE.Vector3[] = [];
  for (let i = 0; i < NL; i++) {
    lamp.push(new THREE.Vector4(0, -9999, 0, 1));
    lampC.push(new THREE.Vector3(0, 0, 0));
  }
  return new THREE.ShaderMaterial({
    name: "EmpyreanInterior",
    vertexShader: SURFACE_VERT,
    fragmentShader: SURFACE_FRAG,
    uniforms: {
      uLamp: { value: lamp },
      uLampC: { value: lampC },
      uAmbTop: { value: new THREE.Color(0x2a2740) },
      uAmbFloor: { value: new THREE.Color(0x1d1620) },
      uSunDir: { value: SUN_DIR.clone() },
      uSunCol: { value: new THREE.Color(0xffc98e).multiplyScalar(1.5) },
    },
    side: THREE.DoubleSide,
    fog: false,
  });
}

/**
 * Everything that emits: bulbs, panes, the spill on the pavement, the shafts
 * of roof light. Additive and depth-read-only, so it never occludes and never
 * needs sorting against itself.
 */
const GLOW_VERT = /* glsl */ `
attribute vec3 aCol;
attribute vec3 aTint;
attribute float aFlick;
uniform float uTime;
uniform float uAnim;
varying vec3 vCol;
void main() {
  float f = 1.0 + uAnim * (0.10 * sin(uTime * 2.3 + aFlick * 6.2831) + 0.05 * sin(uTime * 7.7 + aFlick * 12.0));
  vCol = aCol * aTint * f;
  vec4 p = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    p = instanceMatrix * p;
  #endif
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * p;
}
`;

const GLOW_FRAG = /* glsl */ `
precision highp float;
varying vec3 vCol;
void main() { gl_FragColor = vec4(vCol, 1.0); }
`;

function makeGlowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "EmpyreanInteriorGlow",
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    uniforms: { uTime: { value: 0 }, uAnim: { value: 1 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
}

/**
 * The departure board, which really does count down.
 *
 * Seven-segment digits drawn as quads, with the lit/unlit state of all seven
 * segments of a digit packed into one float and unpacked per vertex. No
 * texture, no atlas, no dynamic indexing into a uniform array — the last of
 * which is exactly the thing GLSL ES 1.0 will not let you do and is why this
 * is four scalars and a chain of comparisons rather than the obvious loop.
 */
const BOARD_VERT = /* glsl */ `
attribute vec3 aCol;
attribute float aDigit;
attribute float aSeg;
uniform vec4 uMask;
uniform float uOn;
varying vec3 vCol;
void main() {
  float mask = aDigit < 0.5 ? uMask.x : (aDigit < 1.5 ? uMask.y : (aDigit < 2.5 ? uMask.z : uMask.w));
  float bit = aSeg < 0.0 ? 1.0 : mod(floor(mask / exp2(aSeg)), 2.0);
  vCol = aCol * mix(0.045, 1.0, bit) * uOn;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}
`;

function makeBoardMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "EmpyreanInteriorBoard",
    vertexShader: BOARD_VERT,
    fragmentShader: GLOW_FRAG,
    uniforms: { uMask: { value: new THREE.Vector4(63, 63, 63, 63) }, uOn: { value: 1 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
}

/* -------------------------------------------------------------------------
 * Geometry helpers
 * ---------------------------------------------------------------------- */

/** Non-indexed, uv-free, ready to be merged with anything else here. */
function prep(g: THREE.BufferGeometry): THREE.BufferGeometry {
  let out = g;
  if (g.index) {
    out = g.toNonIndexed();
    g.dispose();
  }
  out.deleteAttribute("uv");
  out.deleteAttribute("uv1");
  out.deleteAttribute("uv2");
  return out;
}

type Field = number | ((x: number, y: number, z: number) => number);

interface Skin {
  col: number;
  /** Second colour; vertices lerp toward it by `mix`. */
  col2?: number;
  mix?: (x: number, y: number, z: number) => number;
  /** 0..1 self-illumination. A lamp shade, a pane, a hot coal. */
  emit?: Field;
  /** 0..1 how much of the sun this vertex can see. Skylights only. */
  sky?: Field;
}

const _cA = new THREE.Color();
const _cB = new THREE.Color();

function evalField(f: Field | undefined, x: number, y: number, z: number): number {
  if (f === undefined) return 0;
  return typeof f === "number" ? f : f(x, y, z);
}

function paint(g: THREE.BufferGeometry, skin: Skin): THREE.BufferGeometry {
  const pos = g.getAttribute("position");
  const n = pos.count;
  const col = new Float32Array(n * 3);
  const tint = new Float32Array(n * 3);
  const emit = new Float32Array(n);
  const sky = new Float32Array(n);
  _cA.setHex(skin.col, THREE.SRGBColorSpace);
  if (skin.col2 !== undefined) _cB.setHex(skin.col2, THREE.SRGBColorSpace);
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    let r = _cA.r;
    let gg = _cA.g;
    let b = _cA.b;
    if (skin.col2 !== undefined) {
      const t = skin.mix ? Math.min(1, Math.max(0, skin.mix(x, y, z))) : 0.5;
      r += (_cB.r - r) * t;
      gg += (_cB.g - gg) * t;
      b += (_cB.b - b) * t;
    }
    col[i * 3] = r;
    col[i * 3 + 1] = gg;
    col[i * 3 + 2] = b;
    tint[i * 3] = 1;
    tint[i * 3 + 1] = 1;
    tint[i * 3 + 2] = 1;
    emit[i] = evalField(skin.emit, x, y, z);
    sky[i] = evalField(skin.sky, x, y, z);
  }
  g.setAttribute("aCol", new THREE.BufferAttribute(col, 3));
  g.setAttribute("aTint", new THREE.BufferAttribute(tint, 3));
  g.setAttribute("aEmit", new THREE.BufferAttribute(emit, 1));
  g.setAttribute("aSky", new THREE.BufferAttribute(sky, 1));
  return g;
}

interface GlowSkin {
  col: number;
  /** Radiance multiplier. Above 1 on purpose — postfx has a bloom threshold. */
  power: Field;
  /** 0..1 phase, so a hundred bulbs do not all flicker together. */
  flick?: number;
}

function paintGlow(g: THREE.BufferGeometry, skin: GlowSkin): THREE.BufferGeometry {
  const pos = g.getAttribute("position");
  const n = pos.count;
  const col = new Float32Array(n * 3);
  const tint = new Float32Array(n * 3);
  const flick = new Float32Array(n);
  _cA.setHex(skin.col, THREE.SRGBColorSpace);
  for (let i = 0; i < n; i++) {
    const p = evalField(skin.power, pos.getX(i), pos.getY(i), pos.getZ(i));
    col[i * 3] = _cA.r * p;
    col[i * 3 + 1] = _cA.g * p;
    col[i * 3 + 2] = _cA.b * p;
    tint[i * 3] = 1;
    tint[i * 3 + 1] = 1;
    tint[i * 3 + 2] = 1;
    flick[i] = skin.flick ?? 0;
  }
  g.setAttribute("aCol", new THREE.BufferAttribute(col, 3));
  g.setAttribute("aTint", new THREE.BufferAttribute(tint, 3));
  g.setAttribute("aFlick", new THREE.BufferAttribute(flick, 1));
  return g;
}

/** Four corners, wound so the normal comes out of the front. */
function quad(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const p = new Float32Array([
    ax, ay, az, bx, by, bz, cx, cy, cz,
    ax, ay, az, cx, cy, cz, dx, dy, dz,
  ]);
  g.setAttribute("position", new THREE.BufferAttribute(p, 3));
  g.computeVertexNormals();
  return g;
}

/* -------------------------------------------------------------------------
 * The room builder
 * ---------------------------------------------------------------------- */

interface LBox {
  x: number;
  z: number;
  hx: number;
  hz: number;
  ry: number;
  top: number;
  bottom: number;
}

interface LDeck {
  x: number;
  z: number;
  hx: number;
  hz: number;
  y: number;
}

interface LLamp {
  x: number;
  y: number;
  z: number;
  col: number;
  /** Radiance for the shader lamp. */
  power: number;
  /** Metres to nothing. */
  range: number;
  /** Priority for the real-light pool: highest first. */
  rank: number;
}

interface LHit {
  id: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  label: string;
  detail?: string;
  text: string;
}

interface InstSet {
  geo: THREE.BufferGeometry;
  glow: boolean;
  m: THREE.Matrix4[];
  tint: number[];
}

/** Authoring space for one room: +Z out of the front door, y = 0 on the floor. */
class Rb {
  readonly solid: THREE.BufferGeometry[] = [];
  readonly glow: THREE.BufferGeometry[] = [];
  readonly boxes: LBox[] = [];
  readonly decks: LDeck[] = [];
  readonly lamps: LLamp[] = [];
  readonly hits: LHit[] = [];
  readonly sets = new Map<string, InstSet>();
  readonly extra: THREE.Mesh[] = [];

  constructor(readonly rng: Rng, readonly quality: "low" | "high") {}

  add(g: THREE.BufferGeometry, skin: Skin): void {
    this.solid.push(paint(prep(g), skin));
  }

  lit(g: THREE.BufferGeometry, skin: GlowSkin): void {
    this.glow.push(paintGlow(prep(g), skin));
  }

  box(w: number, h: number, d: number, x: number, y: number, z: number, skin: Skin, ry = 0): void {
    const g = new THREE.BoxGeometry(w, h, d);
    if (ry) g.rotateY(ry);
    g.translate(x, y, z);
    this.add(g, skin);
  }

  /** A box that is also solid to a body. `bottom`/`top` default to the box. */
  solidBox(
    w: number, h: number, d: number, x: number, y: number, z: number, skin: Skin, ry = 0,
  ): void {
    this.box(w, h, d, x, y, z, skin, ry);
    this.blocker(x, z, w / 2, d / 2, y - h / 2, y + h / 2, ry);
  }

  blocker(x: number, z: number, hx: number, hz: number, bottom: number, top: number, ry = 0): void {
    this.boxes.push({ x, z, hx, hz, ry, bottom, top });
  }

  deck(x: number, z: number, hx: number, hz: number, y: number): void {
    this.decks.push({ x, z, hx, hz, y });
  }

  lamp(
    x: number, y: number, z: number, col: number, power: number, range: number, rank = 1,
  ): void {
    this.lamps.push({ x, y, z, col, power, range, rank });
  }

  hit(h: LHit): void {
    this.hits.push(h);
  }

  /** One instanced copy. Repeated furniture costs one draw per kind, not per chair. */
  inst(key: string, make: () => THREE.BufferGeometry, m: THREE.Matrix4, tint = 0xffffff, glow = false): void {
    let set = this.sets.get(key);
    if (!set) {
      set = { geo: prep(make()), glow, m: [], tint: [] };
      this.sets.set(key, set);
    }
    set.m.push(m.clone());
    set.tint.push(tint);
  }
}

/** A matrix, without allocating one at every call site. */
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

function trs(x: number, y: number, z: number, ry = 0, s = 1): THREE.Matrix4 {
  _e.set(0, ry, 0);
  _q.setFromEuler(_e);
  _v.set(x, y, z);
  _s.set(s, s, s);
  return _m.compose(_v, _q, _s);
}

/* -------------------------------------------------------------------------
 * Palette
 * ---------------------------------------------------------------------- */

const P = {
  floorWarm: 0x8a7261,
  floorCool: 0x6d5f66,
  runner: 0x9c5a46,
  plaster: 0x8a7468,
  plasterDark: 0x5d4d4c,
  pier: 0x6b5a55,
  iron: 0x2e2833,
  ironLight: 0x453b46,
  brass: 0xb08144,
  timber: 0x6b4a33,
  timberPale: 0x9b7550,
  glassCool: 0x9fc8e8,
  glassWarm: 0xffb47a,
  cloth: [0xd8624a, 0xe0a03c, 0x4f8f86, 0xc75f8a, 0xdcc48a, 0x5f7fb5],
  produce: [0xe4642f, 0xf0b429, 0xc0392b, 0x7fae3a, 0xa64ac9, 0xe9d9a0, 0xd94f70],
  bulb: 0xffb164,
  bulbPale: 0xffd9ad,
  sky: 0x8fb6e8,
  green: 0x6fae5a,
} as const;

/* -------------------------------------------------------------------------
 * Shared furniture
 * ---------------------------------------------------------------------- */

/** A chair you could sit in: seat, four legs, a back. ~0.46 m to the seat. */
function chairGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const seat = new THREE.BoxGeometry(0.46, 0.06, 0.44);
  seat.translate(0, 0.46, 0);
  parts.push(prep(seat));
  const back = new THREE.BoxGeometry(0.44, 0.5, 0.05);
  back.translate(0, 0.72, -0.2);
  parts.push(prep(back));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.BoxGeometry(0.05, 0.46, 0.05);
      leg.translate(sx * 0.19, 0.23, sz * 0.18);
      parts.push(prep(leg));
    }
  }
  const g = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  return paint(g, {
    col: P.timber,
    col2: P.timberPale,
    mix: (_x, y) => THREE.MathUtils.clamp(y / 0.8, 0, 1),
  });
}

/** A round café table, 0.74 m to the top. */
function tableGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const top = new THREE.CylinderGeometry(0.42, 0.42, 0.05, 14);
  top.translate(0, 0.74, 0);
  parts.push(prep(top));
  const stem = new THREE.CylinderGeometry(0.05, 0.06, 0.72, 8);
  stem.translate(0, 0.37, 0);
  parts.push(prep(stem));
  const foot = new THREE.CylinderGeometry(0.28, 0.3, 0.04, 12);
  foot.translate(0, 0.02, 0);
  parts.push(prep(foot));
  const g = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  return paint(g, { col: P.timberPale, col2: P.iron, mix: (_x, y) => (y < 0.1 ? 1 : 0) });
}

/** A mug. Small, and it is the whole reason a table looks used. */
function mugGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.CylinderGeometry(0.045, 0.038, 0.095, 10);
  body.translate(0, 0.048, 0);
  parts.push(prep(body));
  const handle = new THREE.TorusGeometry(0.032, 0.009, 5, 8, Math.PI * 1.3);
  handle.rotateY(Math.PI / 2);
  handle.translate(0.05, 0.05, 0);
  parts.push(prep(handle));
  const g = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  return paint(g, { col: 0xe8ddd0 });
}

/** A crate, for stacking under a stall. */
function crateGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const shell = new THREE.BoxGeometry(0.62, 0.34, 0.44);
  shell.translate(0, 0.17, 0);
  parts.push(prep(shell));
  for (const y of [0.06, 0.28]) {
    const band = new THREE.BoxGeometry(0.64, 0.045, 0.46);
    band.translate(0, y, 0);
    parts.push(prep(band));
  }
  const g = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  return paint(g, { col: P.timber, col2: P.timberPale, mix: (_x, y) => (y > 0.2 ? 0.8 : 0.2) });
}

/** A fruit. Faceted, because a smooth sphere at this size reads as plastic. */
function produceGeo(): THREE.BufferGeometry {
  return paint(prep(new THREE.IcosahedronGeometry(0.09, 0)), { col: 0xffffff });
}

/** A bench: slats and two iron ends. */
function benchGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const slat = new THREE.BoxGeometry(1.9, 0.05, 0.12);
    slat.translate(0, 0.45, -0.16 + i * 0.16);
    parts.push(prep(slat));
  }
  for (let i = 0; i < 2; i++) {
    const slat = new THREE.BoxGeometry(1.9, 0.12, 0.05);
    slat.translate(0, 0.66 + i * 0.17, -0.22);
    parts.push(prep(slat));
  }
  for (const sx of [-1, 1]) {
    const leg = new THREE.BoxGeometry(0.08, 0.45, 0.5);
    leg.translate(sx * 0.85, 0.22, -0.05);
    parts.push(prep(leg));
  }
  const g = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  return paint(g, {
    col: P.timberPale,
    col2: P.iron,
    mix: (_x, y, z) => (y < 0.42 || z < -0.19 ? 0.85 : 0),
  });
}

/** A hanging bulb, as a glow. Two crossed cards plus a core. */
function bulbGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 2; i++) {
    const g = new THREE.PlaneGeometry(0.55, 0.55);
    g.rotateY((i * Math.PI) / 2);
    parts.push(prep(g));
  }
  const core = new THREE.IcosahedronGeometry(0.07, 0);
  parts.push(prep(core));
  const g = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  return paintGlow(g, {
    col: P.bulb,
    power: (x, y) => (Math.hypot(x, y) < 0.09 ? 3.2 : 0.9 * Math.max(0, 1 - Math.hypot(x, y) / 0.3)),
  });
}

/* -------------------------------------------------------------------------
 * Pieces every room wants
 * ---------------------------------------------------------------------- */

/**
 * A wall with a hole in the middle of it.
 *
 * The hole is the entire point of this file, so it is one function rather than
 * four rectangles written out five times, and the blockers it emits stop dead
 * at the jambs.
 */
function wallWithOpening(
  b: Rb,
  opts: {
    /** Wall runs along local X at this Z. */
    z: number;
    x0: number;
    x1: number;
    thick: number;
    top: number;
    openW: number;
    openH: number;
    /** Centre of the opening along X. */
    openX?: number;
    skin: Skin;
  },
): void {
  const { z, x0, x1, thick, top, openW, openH, skin } = opts;
  const ox = opts.openX ?? (x0 + x1) / 2;
  const l0 = ox - openW / 2;
  const l1 = ox + openW / 2;
  if (l0 > x0) {
    b.box(l0 - x0, top, thick, (x0 + l0) / 2, top / 2, z, skin);
    b.blocker((x0 + l0) / 2, z, (l0 - x0) / 2, thick / 2, 0, top);
  }
  if (x1 > l1) {
    b.box(x1 - l1, top, thick, (l1 + x1) / 2, top / 2, z, skin);
    b.blocker((l1 + x1) / 2, z, (x1 - l1) / 2, thick / 2, 0, top);
  }
  if (top > openH) {
    b.box(openW, top - openH, thick, ox, (top + openH) / 2, z, skin);
    // Deliberately no blocker: a lintel you can walk under is a lintel.
  }
}

/** A plain wall along X, solid all the way. */
function wallX(
  b: Rb, z: number, x0: number, x1: number, thick: number, top: number, skin: Skin, bottom = 0,
): void {
  b.box(x1 - x0, top - bottom, thick, (x0 + x1) / 2, (top + bottom) / 2, z, skin);
  b.blocker((x0 + x1) / 2, z, (x1 - x0) / 2, thick / 2, bottom, top);
}

/** A plain wall along Z. */
function wallZ(
  b: Rb, x: number, z0: number, z1: number, thick: number, top: number, skin: Skin, bottom = 0,
): void {
  b.box(thick, top - bottom, z1 - z0, x, (top + bottom) / 2, (z0 + z1) / 2, skin);
  b.blocker(x, (z0 + z1) / 2, thick / 2, (z1 - z0) / 2, bottom, top);
}

/**
 * A box stretched between two points — a rib, a brace, a handrail.
 *
 * `Object3D.lookAt` sends -Z at the target, so the box is authored along -Z
 * and turned once. Doing it with two Euler rotations instead is the version
 * that comes out subtly twisted on anything that is not in a cardinal plane.
 */
function strut(
  b: Rb,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  w: number, d: number, skin: Skin,
): void {
  const len = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
  if (len < 1e-4) return;
  const g = new THREE.BoxGeometry(w, d, len);
  const obj = new THREE.Object3D();
  obj.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  obj.lookAt(x1, y1, z1);
  obj.updateMatrix();
  g.applyMatrix4(obj.matrix);
  b.add(g, skin);
}

/** A paved floor, tile by tile, so it has grain instead of being one flat sheet. */
function pavedFloor(
  b: Rb, hx: number, hz: number, tile: number, skin: (x: number, z: number) => Skin,
): void {
  const nx = Math.max(1, Math.round((hx * 2) / tile));
  const nz = Math.max(1, Math.round((hz * 2) / tile));
  const tx = (hx * 2) / nx;
  const tz = (hz * 2) / nz;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const x = -hx + tx * (i + 0.5);
      const z = -hz + tz * (j + 0.5);
      const g = quad(
        x - tx / 2 + 0.02, 0, z - tz / 2 + 0.02,
        x + tx / 2 - 0.02, 0, z - tz / 2 + 0.02,
        x + tx / 2 - 0.02, 0, z + tz / 2 - 0.02,
        x - tx / 2 + 0.02, 0, z + tz / 2 - 0.02,
      );
      b.add(g, skin(x, z));
    }
  }
}

/**
 * The warm patch a lit room throws onto the pavement outside its door.
 *
 * Additive, on the ground, fading to nothing at the edges. It is the cheapest
 * possible version of light leaving a building and it is the single thing that
 * makes a doorway look like it has somewhere behind it, from across a street,
 * in a world where every other surface is a shader that lights itself.
 */
function doorSpill(b: Rb, z: number, halfW: number, reach: number, col: number, power: number): void {
  const steps = 5;
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    const w0 = halfW * (1 + t0 * 1.5);
    const w1 = halfW * (1 + t1 * 1.5);
    const g = quad(
      -w0, 0.05, z + reach * t0,
      w0, 0.05, z + reach * t0,
      w1, 0.05, z + reach * t1,
      -w1, 0.05, z + reach * t1,
    );
    b.lit(g, {
      col,
      power: (_x, _y, zz) => power * Math.pow(Math.max(0, 1 - (zz - z) / reach), 1.8),
    });
  }
  // And the door itself, glowing, seen edge-on from the street.
  const g = quad(-halfW, 0.05, z, halfW, 0.05, z, halfW, 3.4, z, -halfW, 3.4, z);
  b.lit(g, { col, power: (_x, y) => power * 0.5 * Math.max(0, 1 - y / 3.4) });
}

/** A shaft of roof light: two crossed tapered cards, brightest at the top. */
function lightShaft(
  b: Rb, x: number, z: number, yTop: number, yBot: number, wTop: number, wBot: number,
  lean: number, col: number, power: number,
): void {
  const dx = Math.cos(lean) * (yTop - yBot) * 0.34;
  const dz = Math.sin(lean) * (yTop - yBot) * 0.34;
  for (let k = 0; k < 2; k++) {
    const ax = k === 0 ? 1 : 0;
    const az = k === 0 ? 0 : 1;
    const g = quad(
      x - ax * wTop, yTop, z - az * wTop,
      x + ax * wTop, yTop, z + az * wTop,
      x + ax * wBot - dx, yBot, z + az * wBot - dz,
      x - ax * wBot - dx, yBot, z - az * wBot - dz,
    );
    b.lit(g, {
      col,
      power: (_x, y) => {
        const t = THREE.MathUtils.clamp((y - yBot) / (yTop - yBot), 0, 1);
        return power * (0.12 + t * t * 0.88);
      },
      flick: 0.4,
    });
  }
}

/* -------------------------------------------------------------------------
 * 1. The Market Hall
 * ---------------------------------------------------------------------- */

const HALL = { hx: 14, hz: 22, eaves: 9, crown: 16.2, openW: 9, openH: 7.4 };

function buildMarketHall(b: Rb): void {
  const { hx, hz, eaves, crown, openW, openH } = HALL;
  const rng = b.rng;

  /* ---- floor: warm stone, a rose runner down the middle aisle ---- */
  pavedFloor(b, hx, hz, 2.2, (x, z) => {
    const runner = Math.abs(x) < 3.1;
    const n = (Math.sin(x * 1.7 + z * 0.9) + Math.sin(z * 2.3 - x * 0.4)) * 0.5;
    return {
      col: runner ? P.runner : P.floorWarm,
      col2: runner ? P.floorWarm : P.floorCool,
      mix: () => 0.28 + n * 0.22,
    };
  });

  /* ---- side walls: piers, infill, clerestory glazing ---- */
  const bays = 9;
  const bayZ = (hz * 2 - 2) / bays;
  for (const sx of [-1, 1]) {
    const x = sx * hx;
    for (let i = 0; i <= bays; i++) {
      const z = -hz + 1 + i * bayZ;
      b.box(1.5, eaves + 0.6, 1.4, x - sx * 0.55, (eaves + 0.6) / 2, z, {
        col: P.pier,
        col2: P.plasterDark,
        mix: (_px, py) => THREE.MathUtils.clamp(1 - py / eaves, 0, 1) * 0.7,
      });
      b.blocker(x - sx * 0.55, z, 0.75, 0.7, 0, eaves);
    }
    for (let i = 0; i < bays; i++) {
      const z0 = -hz + 1 + i * bayZ + 0.7;
      const z1 = z0 + bayZ - 1.4;
      // Solid dado below, glazing above: the light comes in over your head.
      b.box(0.5, 5.6, z1 - z0, x, 2.8, (z0 + z1) / 2, {
        col: P.plaster,
        col2: P.plasterDark,
        mix: (_px, py) => THREE.MathUtils.clamp(1 - py / 5, 0, 1),
      });
      b.blocker(x, (z0 + z1) / 2, 0.25, (z1 - z0) / 2, 0, eaves);
      const paneG = new THREE.BoxGeometry(0.16, 3.1, z1 - z0);
      paneG.translate(x, 7.2, (z0 + z1) / 2);
      b.add(paneG, { col: P.glassWarm, col2: P.glassCool, mix: (_px, py) => (py - 5.6) / 3.2, emit: 0.5, sky: 0.55 });
      const glowG = new THREE.PlaneGeometry(z1 - z0, 3.1);
      glowG.rotateY(sx * Math.PI * 0.5);
      glowG.translate(x - sx * 0.12, 7.2, (z0 + z1) / 2);
      b.lit(glowG, { col: P.glassWarm, power: (_px, py) => 0.9 * (1 - (py - 5.6) / 3.4), flick: 0.1 });
      // Mullions.
      for (let k = 1; k < 3; k++) {
        b.box(0.22, 3.2, 0.1, x, 7.2, z0 + ((z1 - z0) * k) / 3, { col: P.iron });
      }
    }
  }

  /* ---- back wall: three lancets and a clock ---- */
  wallX(b, -hz, -hx, hx, 0.6, eaves + 0.4, {
    col: P.plaster,
    col2: P.plasterDark,
    mix: (_px, py) => THREE.MathUtils.clamp(1 - py / 7, 0, 1),
  });
  for (let i = -1; i <= 1; i++) {
    const x = i * 6.2;
    const g = new THREE.BoxGeometry(3.0, 4.4, 0.18);
    g.translate(x, 5.4, -hz + 0.25);
    b.add(g, { col: P.glassWarm, col2: P.glassCool, mix: (_px, py) => (py - 3) / 5, emit: 0.55, sky: 0.4 });
    const gl = new THREE.PlaneGeometry(3.0, 4.4);
    gl.translate(x, 5.4, -hz + 0.4);
    b.lit(gl, { col: P.glassWarm, power: (_px, py) => 1.1 * (1 - (py - 3.2) / 5), flick: 0.05 });
    b.box(0.16, 4.5, 0.24, x, 5.4, -hz + 0.36, { col: P.iron });
  }
  // The hall clock, over the back wall. Not a working one; a face and hands.
  const face = new THREE.CylinderGeometry(1.15, 1.15, 0.14, 20);
  face.rotateX(Math.PI / 2);
  face.translate(0, 9.6, -hz + 0.4);
  b.add(face, { col: 0xf0e2c8, emit: 0.25 });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    b.box(0.09, 0.22, 0.06, Math.sin(a) * 0.92, 9.6 + Math.cos(a) * 0.92, -hz + 0.48, { col: P.iron });
  }
  for (const [len, ang] of [[0.8, 0.5] as const, [1.05, -1.1] as const]) {
    // About Z, not Y: a hand turned about the vertical vanishes into the face.
    const g = new THREE.BoxGeometry(0.07, len, 0.06);
    g.translate(0, len / 2, 0);
    g.rotateZ(ang);
    g.translate(0, 9.6, -hz + 0.5);
    b.add(g, { col: P.iron });
  }

  /* ---- front: the portal ---- */
  wallWithOpening(b, {
    z: hz,
    x0: -hx,
    x1: hx,
    thick: 0.6,
    top: eaves + 0.4,
    openW,
    openH,
    skin: { col: P.plaster, col2: P.plasterDark, mix: (_px, py) => THREE.MathUtils.clamp(1 - py / 7, 0, 1) },
  });
  // A fanlight over the portal, and the arch of it.
  const fan = new THREE.CylinderGeometry(openW / 2 - 0.1, openW / 2 - 0.1, 0.2, 18, 1, false, 0, Math.PI);
  fan.rotateX(Math.PI / 2);
  fan.rotateZ(Math.PI);
  fan.translate(0, openH, hz - 0.05);
  b.add(fan, { col: P.glassWarm, emit: 0.6, sky: 0.5 });
  for (let i = 1; i < 6; i++) {
    const a = (i / 6) * Math.PI;
    const rr = openW / 2 - 0.2;
    const g = new THREE.BoxGeometry(rr, 0.1, 0.16);
    g.rotateZ(a);
    g.translate(Math.cos(a) * rr * 0.5, openH + Math.sin(a) * rr * 0.5, hz - 0.05);
    b.add(g, { col: P.iron });
  }

  /* ---- the vault: fourteen segments of glass on iron arches ---- */
  const SEG = 14;
  const rise = crown - eaves;
  const arcY = (t: number) => eaves + rise * Math.sqrt(Math.max(0, 1 - t * t));
  for (let i = 0; i < SEG; i++) {
    const t0 = -1 + (2 * i) / SEG;
    const t1 = -1 + (2 * (i + 1)) / SEG;
    const x0 = t0 * hx;
    const x1 = t1 * hx;
    const y0 = arcY(t0);
    const y1 = arcY(t1);
    const g = quad(x0, y0, -hz, x1, y1, -hz, x1, y1, hz, x0, y0, hz);
    b.add(g, {
      col: P.glassCool,
      col2: P.glassWarm,
      // Cool at the crown, gold at the eaves where the sunset gets in low.
      mix: (_x, y) => THREE.MathUtils.clamp(1 - (y - eaves) / rise, 0, 1),
      emit: (_x, y) => 0.22 + 0.5 * THREE.MathUtils.clamp(1 - (y - eaves) / rise, 0, 1),
      sky: 1,
    });
  }
  // Ribs, every bay, following the same curve.
  for (let i = 0; i <= bays; i++) {
    const z = -hz + 1 + i * bayZ;
    for (let k = 0; k < SEG; k++) {
      const t0 = -1 + (2 * k) / SEG;
      const t1 = -1 + (2 * (k + 1)) / SEG;
      const x0 = t0 * hx;
      const x1 = t1 * hx;
      const y0 = arcY(t0);
      const y1 = arcY(t1);
      const len = Math.hypot(x1 - x0, y1 - y0);
      const g = new THREE.BoxGeometry(len + 0.06, 0.3, 0.42);
      g.rotateZ(Math.atan2(y1 - y0, x1 - x0));
      g.translate((x0 + x1) / 2, (y0 + y1) / 2 - 0.16, z);
      b.add(g, { col: P.iron, col2: P.ironLight, mix: (_x, y) => (y - eaves) / rise });
    }
    // A tie rod across the springing — the thing that stops a vault spreading.
    b.box(hx * 2, 0.1, 0.1, 0, eaves + 0.3, z, { col: P.iron });
  }
  // Ridge lantern: the strip of glass along the crown, and the light from it.
  const ridge = new THREE.BoxGeometry(2.4, 0.5, hz * 2);
  ridge.translate(0, crown + 0.3, 0);
  b.add(ridge, { col: P.glassCool, emit: 0.85, sky: 1 });

  /* ---- the light: five shafts down the nave ---- */
  const shafts = b.quality === "high" ? 5 : 3;
  for (let i = 0; i < shafts; i++) {
    const z = -hz + 6 + (i * (hz * 2 - 12)) / Math.max(1, shafts - 1);
    lightShaft(b, -2.5, z, crown - 0.5, 0.1, 2.2, 4.6, 0.4, 0xffcf96, 0.30);
  }

  /* ---- banners between the piers ---- */
  for (let i = 0; i < bays; i++) {
    if (!rng.chance(0.6)) continue;
    const z = -hz + 1 + i * bayZ + bayZ / 2;
    const sx = rng.chance(0.5) ? -1 : 1;
    const col = rng.pick(P.cloth);
    const g = quad(
      sx * (hx - 0.8), eaves - 0.4, z - 1.2,
      sx * (hx - 0.8), eaves - 0.4, z + 1.2,
      sx * (hx - 2.6), eaves - 3.9, z + 1.0,
      sx * (hx - 2.6), eaves - 3.9, z - 1.0,
    );
    b.add(g, { col, emit: 0.16 });
  }

  /* ---- the stalls ---- */
  const rows = [-11.2, -6.3, 6.3, 11.2];
  const perRow = 6;
  let stallIndex = 0;
  for (const rx of rows) {
    for (let i = 0; i < perRow; i++) {
      const z = -hz + 4.4 + i * ((hz * 2 - 8.8) / (perRow - 1));
      buildStall(b, rx, z, stallIndex++);
    }
  }

  /* ---- what you can press a key on ---- */
  b.hit({
    id: "market-bread",
    x: -6.3,
    y: 1.4,
    z: -hz + 4.4,
    radius: 3.2,
    label: "Buy a warm roll",
    detail: "The bread stall, first on the left",
    text: "Still warm. The baker says the oven has not been off in nine years.",
  });
  b.hit({
    id: "market-flowers",
    x: 6.3,
    y: 1.4,
    z: hz - 4.4,
    radius: 3.2,
    label: "Ask about the flowers",
    detail: "Grown two streets away, on the Terraces",
    text: "“All of it grown on the island. Nothing here has ever been down there.”",
  });
  b.hit({
    id: "market-hall",
    x: 0,
    y: 1.6,
    z: 0,
    radius: 6,
    label: "Stand in the middle of the hall",
    detail: "Four hundred stalls, and the roof is all glass",
    text: "Four hundred stalls, and the roof is all glass. Loud, warm, open late.",
  });

  /* ---- the spill onto the street ---- */
  doorSpill(b, hz + 0.31, openW / 2, 7, 0xffb877, 0.5);
}

/** One stall: counter, posts, a cloth canopy, a bulb, crates and produce. */
function buildStall(b: Rb, x: number, z: number, idx: number): void {
  const rng = b.rng;
  const w = 3.4;
  const d = 1.7;
  const cloth = P.cloth[idx % P.cloth.length];

  // Counter.
  b.box(w, 1.0, d, x, 0.5, z, { col: P.timber, col2: P.timberPale, mix: (_px, py) => (py > 0.9 ? 1 : 0.15) });
  b.box(w + 0.24, 0.09, d + 0.24, x, 1.04, z, { col: P.timberPale });
  b.blocker(x, z, w / 2 + 0.12, d / 2 + 0.12, 0, 1.1);

  // Posts and canopy.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.box(0.09, 2.5, 0.09, x + sx * (w / 2 - 0.1), 1.25, z + sz * (d / 2 - 0.1), { col: P.iron });
    }
  }
  const cy = 2.5;
  const g = quad(
    x - w / 2 - 0.4, cy + 0.42, z - d / 2 - 0.5,
    x + w / 2 + 0.4, cy + 0.42, z - d / 2 - 0.5,
    x + w / 2 + 0.4, cy - 0.12, z + d / 2 + 0.5,
    x - w / 2 - 0.4, cy - 0.12, z + d / 2 + 0.5,
  );
  b.add(g, { col: cloth, emit: 0.2 });
  // A scalloped valance along the front, which is what makes cloth read as cloth.
  for (let i = 0; i < 5; i++) {
    const cx = x - w / 2 - 0.3 + (i * (w + 0.6)) / 5;
    const gv = quad(
      cx, cy - 0.12, z + d / 2 + 0.5,
      cx + (w + 0.6) / 5 - 0.06, cy - 0.12, z + d / 2 + 0.5,
      cx + (w + 0.6) / 5 - 0.06, cy - 0.52, z + d / 2 + 0.5,
      cx, cy - 0.52, z + d / 2 + 0.5,
    );
    b.add(gv, { col: cloth, emit: 0.14 });
  }

  // The bulb under the canopy, and a virtual lamp for it.
  b.inst("bulb", bulbGeo, trs(x, cy - 0.55, z), 0xffffff, true);
  b.lamp(x, cy - 0.6, z, P.bulb, 1.15, 9.5, idx % 6 === 0 ? 2 : 0.4);

  // Produce on the counter.
  const kinds = rng.int(2, 3);
  for (let k = 0; k < kinds; k++) {
    const col = rng.pick(P.produce);
    const px = x - w / 2 + 0.5 + (k * (w - 1)) / Math.max(1, kinds - 1);
    // A tray, and a small heap on it.
    b.box(0.8, 0.08, 0.6, px, 1.12, z, { col: P.timberPale });
    const heap = b.quality === "high" ? 7 : 4;
    for (let m = 0; m < heap; m++) {
      const a = (m / heap) * TAU + idx;
      const rr = m === 0 ? 0 : 0.17;
      b.inst(
        "produce",
        produceGeo,
        trs(px + Math.cos(a) * rr, 1.24 + (m === 0 ? 0.09 : 0), z + Math.sin(a) * rr * 0.7),
        col,
      );
    }
  }

  // Crates under the front edge.
  for (let k = 0; k < rng.int(1, 3); k++) {
    b.inst("crate", crateGeo, trs(x - w / 2 + 0.5 + k * 0.75, 0, z + d / 2 + 0.45, rng.range(-0.2, 0.2)));
  }
  // And a stack behind, so the aisle is not a corridor of identical fronts.
  if (rng.chance(0.5)) {
    b.inst("crate", crateGeo, trs(x + w / 2 - 0.4, 0, z - d / 2 - 0.5, rng.range(-0.3, 0.3)));
    b.inst("crate", crateGeo, trs(x + w / 2 - 0.4, 0.36, z - d / 2 - 0.5, rng.range(-0.3, 0.3)));
  }
}

/* -------------------------------------------------------------------------
 * 2. The café
 * ---------------------------------------------------------------------- */

const CAFE = { hx: 4.8, hz: 5.2, ceil: 3.5, openW: 4.2, openH: 2.7 };

function buildCafe(b: Rb): void {
  const { hx, hz, ceil, openW, openH } = CAFE;
  const rng = b.rng;

  const wallSkin: Skin = {
    col: 0x7a5c4a,
    col2: 0x3a2a28,
    mix: (_x, y) => THREE.MathUtils.clamp(1 - y / ceil, 0, 1) * 0.8,
  };

  pavedFloor(b, hx, hz, 1.05, (x, z) => ({
    col: (Math.round(x / 1.05) + Math.round(z / 1.05)) % 2 === 0 ? 0x6e5347 : 0x866754,
    col2: 0x2e2220,
    mix: () => 0.25,
  }));

  // Ceiling with beams — low, and the reason the room feels like a room.
  b.box(hx * 2, 0.3, hz * 2, 0, ceil + 0.15, 0, { col: 0x4a3730 });
  for (let i = -2; i <= 2; i++) {
    b.box(hx * 2, 0.22, 0.24, 0, ceil - 0.11, i * 2, { col: P.timber });
  }

  wallX(b, -hz, -hx, hx, 0.3, ceil, wallSkin);
  wallZ(b, -hx, -hz, hz, 0.3, ceil, wallSkin);
  wallZ(b, hx, -hz, hz, 0.3, ceil, wallSkin);

  /* ---- the shopfront: a door in the middle, glass either side ---- */
  wallWithOpening(b, {
    z: hz,
    x0: -hx,
    x1: hx,
    thick: 0.3,
    top: ceil,
    openW,
    openH,
    skin: wallSkin,
  });
  /* Both windows, and the door dead centre between them.
   *
   * Off-centre reads better in a drawing and is wrong here: the door is the
   * only part of this room a body can pass through, and putting it anywhere
   * but on the axis you walk in along means the first thing the room does is
   * catch your shoulder on a jamb. */
  for (const side of [-1, 1]) {
    const winX0 = side < 0 ? -hx + 0.35 : openW / 2 + 0.25;
    const winX1 = side < 0 ? -openW / 2 - 0.25 : hx - 0.35;
    const winW = winX1 - winX0;
    const winC = (winX0 + winX1) / 2;
    b.box(winW, 0.9, 0.34, winC, 0.45, hz, { col: 0x4a3730 });
    b.blocker(winC, hz, winW / 2, 0.2, 0, ceil);
    b.box(winW, 1.5, 0.08, winC, 1.7, hz, {
      col: P.glassCool,
      col2: P.glassWarm,
      mix: (x) => THREE.MathUtils.clamp((x - winX0) / winW, 0, 1),
      emit: 0.3,
      sky: 0.35,
    });
    for (let i = 1; i < 3; i++) {
      b.box(0.09, 1.6, 0.14, winX0 + (winW * i) / 3, 1.7, hz, { col: 0x4a3730 });
    }
    b.box(winW + 0.3, 0.16, 0.4, winC, 2.55, hz, { col: 0x4a3730 });
    if (side < 0) {
      // Lettering on the glass: three warm bars, which at this distance is
      // exactly as legible as a name would be, and needs no font.
      for (let i = 0; i < 3; i++) {
        const g = new THREE.PlaneGeometry(winW * 0.19, 0.12);
        g.translate(winX0 + winW * (0.22 + i * 0.24), 2.15, hz - 0.06);
        b.lit(g, { col: 0xffd9a0, power: 1.1 });
      }
    }
  }

  /* ---- the counter, along the left wall ---- */
  const cx = -hx + 1.05;
  b.box(1.5, 1.05, 6.4, cx, 0.525, -1.1, { col: P.timber });
  b.box(1.75, 0.09, 6.6, cx, 1.09, -1.1, { col: 0x2f2a2c });
  b.blocker(cx, -1.1, 0.88, 3.3, 0, 1.15);
  // Back shelf with bottles, cups and a warm strip light under it.
  b.box(0.42, 0.07, 5.8, -hx + 0.4, 1.75, -1.3, { col: P.timberPale });
  b.box(0.42, 0.07, 5.8, -hx + 0.4, 2.35, -1.3, { col: P.timberPale });
  const strip = new THREE.PlaneGeometry(5.6, 0.1);
  strip.rotateY(Math.PI / 2);
  strip.translate(-hx + 0.62, 1.68, -1.3);
  b.lit(strip, { col: 0xffc07a, power: 1.6 });
  for (let i = 0; i < 16; i++) {
    const z = -4.0 + (i * 5.4) / 15;
    const shelf = i % 2 === 0 ? 1.82 : 2.42;
    const g = new THREE.CylinderGeometry(0.045, 0.05, rng.range(0.16, 0.3), 7);
    g.translate(-hx + 0.4 + rng.range(-0.08, 0.08), shelf + 0.12, z);
    b.add(g, { col: rng.pick([0xd8d2c4, 0x8a6a4a, 0x4f6f68, 0xb8523f, 0xe0c07a]) });
  }
  // The machine: a chrome box that hisses. Two knobs and a lit gauge.
  b.box(0.7, 0.62, 1.1, cx - 0.2, 1.44, -3.1, { col: 0xb9b2ac });
  b.box(0.74, 0.1, 1.14, cx - 0.2, 1.78, -3.1, { col: P.brass });
  const gauge = new THREE.PlaneGeometry(0.22, 0.22);
  gauge.translate(cx + 0.16, 1.5, -2.53);
  b.lit(gauge, { col: 0x9fe8c0, power: 1.5, flick: 0.3 });
  for (const z of [-3.4, -2.85]) {
    const k = new THREE.CylinderGeometry(0.05, 0.05, 0.14, 8);
    k.rotateX(Math.PI / 2);
    k.translate(cx + 0.14, 1.28, z);
    b.add(k, { col: P.brass });
  }
  // A menu board over the counter.
  b.box(1.6, 1.0, 0.06, cx + 0.2, 2.6, -1.1, { col: 0x241d20 }, Math.PI / 2);
  for (let i = 0; i < 5; i++) {
    const g = new THREE.PlaneGeometry(0.06, 0.85 - (i % 3) * 0.2);
    g.rotateY(Math.PI / 2);
    g.translate(cx + 0.16, 2.92 - i * 0.16, -1.1);
    b.lit(g, { col: 0xffe0b0, power: 0.9 });
  }

  /* ---- tables, chairs, mugs ---- */
  const tables: Array<[number, number]> = [
    [2.2, -3.2],
    [2.2, 0.2],
    [-2.4, 3.1],
    [2.5, 3.1],
  ];
  tables.forEach(([tx, tz], i) => {
    b.inst("table", tableGeo, trs(tx, 0, tz, i * 0.4));
    b.blocker(tx, tz, 0.44, 0.44, 0, 0.8);
    const seats = i === 2 ? 2 : 3;
    for (let k = 0; k < seats; k++) {
      const a = i * 0.7 + (k / seats) * TAU;
      b.inst("chair", chairGeo, trs(tx + Math.cos(a) * 0.78, 0, tz + Math.sin(a) * 0.78, -a + Math.PI / 2));
    }
    if (i !== 3) {
      b.inst("mug", mugGeo, trs(tx + rng.range(-0.16, 0.16), 0.79, tz + rng.range(-0.16, 0.16), rng.range(0, TAU)));
      // Steam, barely. Two tiny cards.
      const st = new THREE.PlaneGeometry(0.1, 0.26);
      st.translate(tx, 1.02, tz);
      b.lit(st, { col: 0xffd9b0, power: (_x, y) => 0.35 * (1 - (y - 0.9) / 0.4), flick: 0.6 + i * 0.1 });
    }
  });

  /* ---- pendant lamps, and the light they make ---- */
  for (const [lx, lz] of [[2.2, -1.6] as const, [1.0, 2.6] as const, [-2.6, -2.6] as const]) {
    b.box(0.05, 1.15, 0.05, lx, ceil - 0.58, lz, { col: P.iron });
    const shade = new THREE.ConeGeometry(0.34, 0.34, 12, 1, true);
    shade.translate(lx, ceil - 1.15, lz);
    b.add(shade, { col: 0xe8b878, emit: 0.5 });
    b.inst("bulb", bulbGeo, trs(lx, ceil - 1.3, lz), 0xffffff, true);
    b.lamp(lx, ceil - 1.32, lz, P.bulb, 1.5, 7.5, lz > 0 ? 3 : 2.2);
  }
  // A plant in the window, because somebody lives here.
  b.box(0.34, 0.3, 0.34, 3.4, 0.15 + 0.9, hz - 0.55, { col: 0x9a5b45 });
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU;
    const g = new THREE.BoxGeometry(0.07, 0.5, 0.16);
    g.rotateZ(Math.cos(a) * 0.5);
    g.rotateX(Math.sin(a) * 0.5);
    g.translate(3.4 + Math.cos(a) * 0.1, 1.5, hz - 0.55 + Math.sin(a) * 0.1);
    b.add(g, { col: P.green, col2: 0x3d6b34, mix: () => (i % 2) * 0.6 });
  }

  b.hit({
    id: "cafe-counter",
    x: cx + 1.1,
    y: 1.2,
    z: -1.1,
    radius: 2.6,
    label: "Order a coffee",
    detail: "Beans from the Terraces, milk from nowhere at all",
    text: "“Sit anywhere. It comes to you.”",
  });
  b.hit({
    id: "cafe-window",
    x: -3.3,
    y: 1.3,
    z: hz - 0.9,
    radius: 2.2,
    label: "Take the window seat",
    detail: "The whole street, and nine hundred metres of nothing under it",
    text: "From here the street looks like any street, until you look down.",
  });

  doorSpill(b, hz + 0.16, openW / 2, 4.5, 0xffb877, 0.42);
}

/* -------------------------------------------------------------------------
 * 3. The Observatory
 * ---------------------------------------------------------------------- */

const OBS = { r: 13.5, wall: 6.4, crown: 15.9, openW: 5.4, openH: 3.8, mezz: 4.2 };

function buildObservatory(b: Rb, slotAz: number): void {
  const { r, wall, crown, openW, openH, mezz } = OBS;
  const rng = b.rng;
  const domeR = r;
  const rise = crown - wall;

  const openHalf = Math.asin(openW / 2 / r);
  const slotHalf = 0.15;
  const inSlot = (a: number) => Math.abs(angDiff(a, slotAz)) < slotHalf;
  const inDoor = (a: number) => Math.abs(angDiff(a, Math.PI / 2)) < openHalf;

  /* ---- floor: a compass rose in stone ---- */
  const SEGA = 32;
  for (let i = 0; i < SEGA; i++) {
    const a0 = (i / SEGA) * TAU;
    const a1 = ((i + 1) / SEGA) * TAU;
    for (const [r0, r1] of [[0, 4.2] as const, [4.2, 9] as const, [9, r] as const]) {
      const g = quad(
        Math.cos(a0) * r0, 0, Math.sin(a0) * r0,
        Math.cos(a0) * r1, 0, Math.sin(a0) * r1,
        Math.cos(a1) * r1, 0, Math.sin(a1) * r1,
        Math.cos(a1) * r0, 0, Math.sin(a1) * r0,
      );
      const band = r0 === 0 ? 0 : r0 === 4.2 ? 1 : 2;
      b.add(g, {
        col: band === 1 ? 0x3b3450 : 0x554a5c,
        col2: band === 0 ? P.brass : 0x2a2436,
        mix: () => (band === 0 ? (i % 4 === 0 ? 0.55 : 0.12) : i % 2 === 0 ? 0.45 : 0.1),
        emit: band === 0 && i % 8 === 0 ? 0.2 : 0,
        // The shutter throws a stripe of real sunset across the floor.
        sky: (x, _y, z) => (inSlot(Math.atan2(z, x)) ? 0.7 : 0),
      });
    }
  }

  /* ---- drum wall: a 32-gon with a door and a shutter cut out of it ---- */
  for (let i = 0; i < SEGA; i++) {
    const a0 = (i / SEGA) * TAU;
    const a1 = ((i + 1) / SEGA) * TAU;
    const am = (a0 + a1) / 2;
    const door = inDoor(am);
    const slot = inSlot(am);
    const y0 = slot ? 1.2 : 0;
    const y1 = door ? wall : wall;
    if (door) {
      // Lintel above the doorway only.
      pushRingPanel(b, a0, a1, r, openH, y1, 0.45, false);
      continue;
    }
    pushRingPanel(b, a0, a1, r, y0, y1, 0.45, slot);
    if (slot) pushRingSill(b, a0, a1, r, y0);
    // The panel as it really is — a chord, thick radially, turned to face the
    // middle — and the world AABB comes out of the same code every other
    // blocker in this file goes through.
    const chord = r * Math.sin((a1 - a0) / 2) + 0.1;
    b.blocker(
      Math.cos(am) * (r + 0.22), Math.sin(am) * (r + 0.22),
      chord, 0.32, 0, slot ? 1.2 : wall, Math.PI / 2 - am,
    );
  }
  // Door jambs and a lintel beam, so the opening reads as built rather than missing.
  for (const s of [-1, 1]) {
    const a = Math.PI / 2 + s * openHalf;
    const jx = Math.cos(a) * (r - 0.1);
    const jz = Math.sin(a) * (r - 0.1);
    b.box(0.5, wall, 0.9, jx, wall / 2, jz, { col: P.pier }, Math.PI / 2 - a);
    b.blocker(jx, jz, 0.25, 0.45, 0, wall, Math.PI / 2 - a);
  }

  /* ---- the dome ---- */
  const EL = 9;
  for (let i = 0; i < SEGA; i++) {
    const a0 = (i / SEGA) * TAU;
    const a1 = ((i + 1) / SEGA) * TAU;
    const am = (a0 + a1) / 2;
    if (inSlot(am)) continue;
    for (let j = 0; j < EL; j++) {
      const e0 = (j / EL) * (Math.PI / 2);
      const e1 = ((j + 1) / EL) * (Math.PI / 2);
      const r0 = Math.cos(e0) * domeR;
      const r1 = Math.cos(e1) * domeR;
      const y0 = wall + Math.sin(e0) * rise;
      const y1 = wall + Math.sin(e1) * rise;
      const g = quad(
        Math.cos(a0) * r0, y0, Math.sin(a0) * r0,
        Math.cos(a1) * r0, y0, Math.sin(a1) * r0,
        Math.cos(a1) * r1, y1, Math.sin(a1) * r1,
        Math.cos(a0) * r1, y1, Math.sin(a0) * r1,
      );
      b.add(g, {
        col: 0x241f3a,
        col2: 0x3d3358,
        mix: (_x, y) => THREE.MathUtils.clamp((y - wall) / rise, 0, 1) * 0.8,
      });
    }
    // Meridian ribs every fourth segment.
    if (i % 4 === 0) {
      for (let j = 0; j < EL; j++) {
        const e0 = (j / EL) * (Math.PI / 2);
        const e1 = ((j + 1) / EL) * (Math.PI / 2);
        strut(
          b,
          Math.cos(a0) * Math.cos(e0) * (domeR - 0.12), wall + Math.sin(e0) * rise, Math.sin(a0) * Math.cos(e0) * (domeR - 0.12),
          Math.cos(a0) * Math.cos(e1) * (domeR - 0.12), wall + Math.sin(e1) * rise, Math.sin(a0) * Math.cos(e1) * (domeR - 0.12),
          0.18, 0.24,
          { col: P.iron, col2: P.brass, mix: (_x, y) => THREE.MathUtils.clamp((y - wall) / rise, 0, 1) },
        );
      }
    }
  }
  // The shutter jambs, running up over the crown.
  for (const s of [-1, 1]) {
    const a = slotAz + s * slotHalf;
    for (let j = 0; j < EL; j++) {
      const e0 = (j / EL) * (Math.PI / 2);
      const e1 = ((j + 1) / EL) * (Math.PI / 2);
      const y0 = wall + Math.sin(e0) * rise;
      const y1 = wall + Math.sin(e1) * rise;
      const r0 = Math.cos(e0) * domeR;
      const r1 = Math.cos(e1) * domeR;
      const g = quad(
        Math.cos(a) * r0, y0, Math.sin(a) * r0,
        Math.cos(a) * r0 * 0.965, y0, Math.sin(a) * r0 * 0.965,
        Math.cos(a) * r1 * 0.965, y1, Math.sin(a) * r1 * 0.965,
        Math.cos(a) * r1, y1, Math.sin(a) * r1,
      );
      b.add(g, { col: P.iron, col2: P.brass, mix: (_x, y) => (y - wall) / rise });
    }
  }

  /* ---- the painted sky on the inside of the dome ---- */
  const stars = b.quality === "high" ? 150 : 70;
  for (let i = 0; i < stars; i++) {
    const a = rng.range(0, TAU);
    if (inSlot(a)) continue;
    const e = Math.asin(rng.range(0.02, 0.99));
    const rr = Math.cos(e) * (domeR - 0.25);
    const y = wall + Math.sin(e) * rise;
    const size = rng.range(0.09, 0.3);
    const g = new THREE.PlaneGeometry(size, size);
    g.lookAt(new THREE.Vector3(-Math.cos(a), -0.4, -Math.sin(a)));
    g.translate(Math.cos(a) * rr, y, Math.sin(a) * rr);
    b.lit(g, {
      col: rng.chance(0.2) ? 0xffc98a : 0xcfe4ff,
      power: rng.range(0.9, 2.4),
      flick: rng.next(),
    });
  }

  /* ---- the mezzanine, its rail, its stair ---- */
  const mz0 = -11.0;
  const mz1 = -7.2;
  const mhx = 7.6;
  b.box(mhx * 2, 0.3, mz1 - mz0, 0, mezz - 0.15, (mz0 + mz1) / 2, { col: P.timber, col2: P.iron, mix: (_x, y) => (y < mezz - 0.2 ? 0.8 : 0) });
  b.deck(0, (mz0 + mz1) / 2, mhx, (mz1 - mz0) / 2, mezz);
  // Rail along the open edge — a blocker that only exists once you are up there.
  b.box(mhx * 2, 0.1, 0.1, 0, mezz + 1.05, mz1, { col: P.brass });
  for (let i = 0; i <= 10; i++) {
    b.box(0.07, 1.05, 0.07, -mhx + (i * mhx * 2) / 10, mezz + 0.5, mz1, { col: P.iron });
  }
  b.blocker(0, mz1, mhx, 0.2, mezz, mezz + 1.15);
  // Posts holding it up.
  for (const px of [-5.4, 0, 5.4]) {
    b.box(0.32, mezz, 0.32, px, mezz / 2, mz1 - 0.4, { col: P.iron });
    b.blocker(px, mz1 - 0.4, 0.2, 0.2, 0, mezz);
  }

  const stx = -9.6;
  const steps = 12;
  for (let i = 0; i < steps; i++) {
    const z = 2.0 - (i * 7.2) / steps;
    const y = ((i + 1) / steps) * mezz;
    b.box(1.7, 0.18, 0.62, stx, y - 0.09, z, { col: P.timber });
    b.deck(stx, z, 0.85, 0.31, y);
  }
  // The landing that joins the stair to the gallery.
  b.box(3.0, 0.28, 2.0, -9.1, mezz - 0.14, -6.2, { col: P.timber });
  b.deck(-9.1, -6.2, 1.5, 1.0, mezz);
  for (let i = 0; i <= 6; i++) {
    const z = 2.0 - (i * 7.2) / 6;
    const y = (i / 6) * mezz;
    b.box(0.07, 1.0, 0.07, stx + 0.9, y + 0.5, z, { col: P.iron });
  }

  /* ---- the telescope ---- */
  const tx = 3.4;
  const tz = -3.2;
  const tilt = 0.72;
  b.box(2.6, 1.5, 2.6, tx, 0.75, tz, { col: 0x4a4250 });
  b.blocker(tx, tz, 1.35, 1.35, 0, 1.5);
  const pier = new THREE.CylinderGeometry(0.55, 0.75, 1.9, 12);
  pier.translate(tx, 2.4, tz);
  b.add(pier, { col: 0x5b5260 });
  for (const s of [-1, 1]) {
    b.box(0.28, 2.2, 0.34, tx + Math.cos(slotAz + Math.PI / 2) * s * 0.95, 4.2, tz + Math.sin(slotAz + Math.PI / 2) * s * 0.95, { col: P.brass });
  }
  const tube = new THREE.CylinderGeometry(0.62, 0.7, 7.4, 16, 1, false);
  tube.rotateZ(Math.PI / 2 - tilt);
  tube.rotateY(-slotAz);
  tube.translate(tx, 4.9, tz);
  b.add(tube, { col: 0x8a6a3f, col2: 0x2f2a30, mix: (_x, y) => THREE.MathUtils.clamp((y - 3) / 5, 0, 1) * 0.6 });
  b.blocker(tx, tz, 1.1, 1.1, 1.5, 6.4);
  // Bands, an eyepiece, and a finder scope.
  for (const t of [-2.2, 0.6, 2.6]) {
    const band = new THREE.CylinderGeometry(0.72, 0.72, 0.16, 14);
    band.rotateZ(Math.PI / 2 - tilt);
    band.rotateY(-slotAz);
    band.translate(tx + Math.cos(slotAz) * Math.cos(tilt) * t, 4.9 + Math.sin(tilt) * t, tz + Math.sin(slotAz) * Math.cos(tilt) * t);
    b.add(band, { col: P.brass });
  }
  const eyeX = tx - Math.cos(slotAz) * Math.cos(tilt) * 3.9;
  const eyeZ = tz - Math.sin(slotAz) * Math.cos(tilt) * 3.9;
  const eyeY = 4.9 - Math.sin(tilt) * 3.9;
  const eye = new THREE.CylinderGeometry(0.16, 0.2, 0.5, 10);
  eye.rotateZ(Math.PI / 2 - tilt);
  eye.rotateY(-slotAz);
  eye.translate(eyeX, eyeY, eyeZ);
  b.add(eye, { col: P.brass, emit: 0.2 });
  const glint = new THREE.PlaneGeometry(0.18, 0.18);
  glint.translate(eyeX, eyeY + 0.05, eyeZ);
  b.lit(glint, { col: 0xbfe0ff, power: 2.2, flick: 0.2 });

  /* ---- charts, an orrery, a desk ---- */
  for (let i = 0; i < 3; i++) {
    const a = Math.PI * 1.15 + i * 0.42;
    const g = new THREE.PlaneGeometry(2.6, 1.8);
    g.lookAt(new THREE.Vector3(-Math.cos(a), 0, -Math.sin(a)));
    g.translate(Math.cos(a) * (r - 0.55), 3.2, Math.sin(a) * (r - 0.55));
    b.add(g, { col: 0x2a3a52, emit: 0.3 });
    for (let k = 0; k < 9; k++) {
      const s = new THREE.PlaneGeometry(0.09, 0.09);
      s.lookAt(new THREE.Vector3(-Math.cos(a), 0, -Math.sin(a)));
      s.translate(
        Math.cos(a) * (r - 0.62) + Math.sin(a) * rng.range(-1.1, 1.1),
        3.2 + rng.range(-0.7, 0.7),
        Math.sin(a) * (r - 0.62) - Math.cos(a) * rng.range(-1.1, 1.1),
      );
      b.lit(s, { col: 0xdfe9ff, power: 1.6 });
    }
  }
  const dx = -4.6;
  const dz = 5.4;
  b.box(2.6, 0.09, 1.3, dx, 0.86, dz, { col: P.timberPale });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.box(0.09, 0.86, 0.09, dx + sx * 1.15, 0.43, dz + sz * 0.55, { col: P.timber });
  }
  b.blocker(dx, dz, 1.35, 0.7, 0, 0.95);
  b.inst("chair", chairGeo, trs(dx + 0.2, 0, dz + 1.15, Math.PI));
  b.inst("mug", mugGeo, trs(dx + 0.9, 0.91, dz - 0.2));
  // An open ledger, lit by the desk lamp.
  b.box(0.7, 0.03, 0.5, dx - 0.4, 0.92, dz, { col: 0xe6dcc6, emit: 0.25 }, 0.2);
  b.box(0.05, 0.5, 0.05, dx + 1.0, 1.15, dz - 0.4, { col: P.brass });
  const shade = new THREE.ConeGeometry(0.22, 0.2, 10, 1, true);
  shade.translate(dx + 1.0, 1.45, dz - 0.4);
  b.add(shade, { col: P.brass, emit: 0.6 });
  b.inst("bulb", bulbGeo, trs(dx + 1.0, 1.33, dz - 0.4), 0xffe0b0, true);
  b.lamp(dx + 1.0, 1.3, dz - 0.4, 0xffc07a, 1.35, 7, 2.6);

  // The orrery: three brass rings on a stand.
  const ox = -3.0;
  const oz = -1.2;
  b.box(0.7, 0.9, 0.7, ox, 0.45, oz, { col: P.timber });
  b.blocker(ox, oz, 0.4, 0.4, 0, 0.95);
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.TorusGeometry(0.34 + i * 0.16, 0.022, 5, 22);
    ring.rotateX(Math.PI / 2 + (i - 1) * 0.32);
    ring.rotateZ(i * 0.5);
    ring.translate(ox, 1.35, oz);
    b.add(ring, { col: P.brass, emit: 0.25 });
  }
  const core = new THREE.IcosahedronGeometry(0.09, 0);
  core.translate(ox, 1.35, oz);
  b.add(core, { col: 0xffd08a, emit: 1.0 });
  b.lamp(ox, 1.35, oz, 0xffb060, 0.55, 4.5, 0.6);

  /* ---- light: two warm pools and the cold slot ---- */
  b.lamp(0, 5.0, 3.0, 0xffb878, 1.05, 13, 3);
  b.lamp(0, mezz + 1.6, -8.6, 0xffb878, 0.9, 10, 1.8);
  for (const [lx, lz] of [[0, 3.0] as const, [0, -8.6] as const]) {
    const y = lz > 0 ? 5.0 : mezz + 1.6;
    b.box(0.05, 1.2, 0.05, lx, y + 0.7, lz, { col: P.iron });
    b.inst("bulb", bulbGeo, trs(lx, y, lz), 0xffffff, true);
  }
  // Sunset coming through the shutter, as a shaft.
  lightShaft(
    b,
    Math.cos(slotAz) * 5.5, Math.sin(slotAz) * 5.5,
    wall + rise * 0.55, 0.1, 1.5, 3.4, slotAz + Math.PI, 0xffb98a, 0.26,
  );

  b.hit({
    id: "obs-telescope",
    x: eyeX,
    y: eyeY,
    z: eyeZ,
    radius: 2.6,
    label: "Look through the eyepiece",
    detail: "It is pointed at the sun, which has not moved in some time",
    text: "The ranges, upside down, and the sun sitting on them like it means to stay.",
  });
  b.hit({
    id: "obs-orrery",
    x: ox,
    y: 1.35,
    z: oz,
    radius: 2.2,
    label: "Wind the orrery",
    detail: "Brass, and one planet missing",
    text: "It ticks twice and stops. Somebody has taken the fourth planet.",
  });

  doorSpill(b, r - 0.1, openW / 2, 5.5, 0xffb877, 0.4);
}

/** Shortest signed angle from `a` to `b`. */
function angDiff(a: number, bb: number): number {
  let d = (a - bb) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** One panel of the drum wall, inner and outer face. */
function pushRingPanel(
  b: Rb, a0: number, a1: number, r: number, y0: number, y1: number, thick: number, warm: boolean,
): void {
  if (y1 <= y0) return;
  const skin: Skin = {
    col: warm ? 0x6a5a58 : 0x584c58,
    col2: 0x2b2434,
    mix: (_x, y) => THREE.MathUtils.clamp(1 - (y - y0) / Math.max(y1 - y0, 0.01), 0, 1) * 0.75,
  };
  for (const rr of [r, r + thick]) {
    const g = quad(
      Math.cos(a0) * rr, y0, Math.sin(a0) * rr,
      Math.cos(a1) * rr, y0, Math.sin(a1) * rr,
      Math.cos(a1) * rr, y1, Math.sin(a1) * rr,
      Math.cos(a0) * rr, y1, Math.sin(a0) * rr,
    );
    b.add(g, skin);
  }
  const cap = quad(
    Math.cos(a0) * r, y1, Math.sin(a0) * r,
    Math.cos(a1) * r, y1, Math.sin(a1) * r,
    Math.cos(a1) * (r + thick), y1, Math.sin(a1) * (r + thick),
    Math.cos(a0) * (r + thick), y1, Math.sin(a0) * (r + thick),
  );
  b.add(cap, skin);
}

/** The sill under the shutter, so the opening has a bottom edge to lean on. */
function pushRingSill(b: Rb, a0: number, a1: number, r: number, y: number): void {
  const g = quad(
    Math.cos(a0) * r, y, Math.sin(a0) * r,
    Math.cos(a1) * r, y, Math.sin(a1) * r,
    Math.cos(a1) * (r + 0.45), y, Math.sin(a1) * (r + 0.45),
    Math.cos(a0) * (r + 0.45), y, Math.sin(a0) * (r + 0.45),
  );
  b.add(g, { col: P.brass, emit: 0.15, sky: 0.8 });
}

/* -------------------------------------------------------------------------
 * 4. Halo Station
 * ---------------------------------------------------------------------- */

const STATION = { hx: 12, hz: 5.5, deckY: 1.1, canopy: 4.6, openW: 5 };

/** Which segments of a seven-segment digit each numeral lights. */
const SEG7 = [63, 6, 91, 79, 102, 109, 125, 7, 127, 111];

function buildStation(b: Rb): void {
  const { hx, hz, deckY, canopy, openW } = STATION;

  /* ---- the platform ---- */
  b.box(hx * 2, deckY, hz * 2 - 1.2, 0, deckY / 2, -0.6, { col: 0x4d4450, col2: 0x2a2432, mix: (_x, y) => (y < deckY - 0.12 ? 0.9 : 0) });
  b.deck(0, -0.6, hx, hz - 0.6, deckY);
  // Tactile edge along the tram side, in warm brass.
  b.box(hx * 2, 0.03, 0.5, 0, deckY + 0.02, -hz + 0.4, { col: P.brass, emit: 0.25 });
  b.blocker(0, -hz - 0.4, hx, 0.4, 0, deckY + 0.9);

  /* ---- the ramp down to the street, in the middle of the front edge ---- */
  const steps = 6;
  for (let i = 0; i < steps; i++) {
    const z = hz - 0.6 + (i * 3.0) / steps;
    const y = deckY * (1 - (i + 1) / (steps + 1));
    b.box(openW, 0.2, 3.0 / steps + 0.06, 0, y - 0.06, z, { col: 0x4d4450 });
    b.deck(0, z, openW / 2, 3.0 / steps / 2 + 0.03, y);
  }
  // Cheek walls either side of the ramp, so it reads as cut into the platform.
  for (const s of [-1, 1]) {
    b.box(0.4, deckY + 0.5, 3.2, s * (openW / 2 + 0.2), (deckY + 0.5) / 2, hz + 0.9, { col: 0x3a3340 });
    b.blocker(s * (openW / 2 + 0.2), hz + 0.9, 0.2, 1.6, 0, deckY + 0.5);
    // And the rest of the front edge is a low wall you cannot walk over.
    const x0 = s * (openW / 2 + 0.4);
    const x1 = s * hx;
    b.box(Math.abs(x1 - x0), deckY + 0.95, 0.4, (x0 + x1) / 2, (deckY + 0.95) / 2, hz - 0.6, { col: 0x3a3340, col2: P.brass, mix: (_x, y) => (y > deckY + 0.75 ? 0.7 : 0) });
    b.blocker((x0 + x1) / 2, hz - 0.6, Math.abs(x1 - x0) / 2, 0.2, 0, deckY + 0.95);
  }

  /* ---- the canopy ---- */
  /* Six columns, at half-steps: no column on the centre line, because the
     centre line is the ramp and the way in. */
  for (let i = -2.5; i <= 2.5; i++) {
    const x = (i * (hx - 1)) / 2.7;
    b.box(0.34, canopy - deckY, 0.34, x, deckY + (canopy - deckY) / 2, -hz + 1.6, { col: P.iron });
    b.blocker(x, -hz + 1.6, 0.2, 0.2, deckY, canopy);
    b.box(0.34, canopy - deckY, 0.34, x, deckY + (canopy - deckY) / 2, hz - 2.2, { col: P.iron });
    b.blocker(x, hz - 2.2, 0.2, 0.2, deckY, canopy);
    // Brackets, splayed off the head of each column.
    for (const s of [-1, 1]) {
      const g = new THREE.BoxGeometry(0.14, 0.95, 0.14);
      g.rotateX(s * 0.62);
      g.translate(x, canopy - 0.5, s < 0 ? -hz + 2.05 : hz - 2.65);
      b.add(g, { col: P.iron });
    }
  }
  // Roof: two slopes to a shallow ridge, and a lit soffit under it.
  const ridge = canopy + 0.9;
  const g1 = quad(-hx, canopy, -hz + 1.0, hx, canopy, -hz + 1.0, hx, ridge, -0.6, -hx, ridge, -0.6);
  const g2 = quad(-hx, ridge, -0.6, hx, ridge, -0.6, hx, canopy, hz - 1.2, -hx, canopy, hz - 1.2);
  b.add(g1, { col: 0x3d3648, col2: 0x241f30, mix: (_x, y) => (y - canopy) / 0.9 });
  b.add(g2, { col: 0x3d3648, col2: 0x241f30, mix: (_x, y) => (y - canopy) / 0.9 });
  const soffit = new THREE.PlaneGeometry(hx * 2 - 0.6, hz * 2 - 2.4);
  soffit.rotateX(Math.PI / 2);
  soffit.translate(0, canopy - 0.16, -0.1);
  b.lit(soffit, { col: 0xffbe86, power: 0.55, flick: 0.15 });
  for (let i = -2.5; i <= 2.5; i++) {
    const x = (i * (hx - 1)) / 2.7;
    b.box(0.14, 0.14, hz * 2 - 2.2, x, canopy - 0.08, -0.1, { col: P.ironLight });
  }

  /* ---- benches, a bin, a clock, a route diagram ---- */
  for (const x of [-8.4, -4.2, 4.2, 8.4]) {
    b.inst("bench", benchGeo, trs(x, deckY, hz - 2.9, Math.PI));
    b.blocker(x, hz - 2.9, 0.95, 0.35, deckY, deckY + 0.75);
  }
  b.box(0.6, 0.9, 0.6, 1.6, deckY + 0.45, hz - 2.9, { col: P.ironLight });
  b.blocker(1.6, hz - 2.9, 0.32, 0.32, deckY, deckY + 0.9);

  // The route diagram: the ring, with eight stops on it.
  const dg = new THREE.PlaneGeometry(2.6, 1.5);
  dg.translate(-6.4, deckY + 2.0, hz - 2.4);
  b.add(dg, { col: 0x1d1a28, emit: 0.15 });
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU;
    const s = new THREE.PlaneGeometry(0.09, 0.09);
    s.translate(-6.4 + Math.cos(a) * 0.55, deckY + 2.0 + Math.sin(a) * 0.5, hz - 2.45);
    b.lit(s, { col: i % 3 === 0 ? 0xffd08a : 0x7fd8ff, power: i % 3 === 0 ? 2.0 : 1.0 });
  }

  /* ---- the departure board ---- */
  buildBoard(b, 0, deckY + 3.0, -0.4);

  /* ---- light ---- */
  b.lamp(-6.5, canopy - 0.4, -0.1, 0xffb878, 1.15, 12, 2.4);
  b.lamp(6.5, canopy - 0.4, -0.1, 0xffb878, 1.15, 12, 2.4);
  b.lamp(0, deckY + 3.2, -0.4, 0xffd6a0, 0.7, 7, 1.2);
  for (const x of [-6.5, 6.5]) b.inst("bulb", bulbGeo, trs(x, canopy - 0.42, -0.1), 0xffffff, true);

  b.hit({
    id: "tram-board",
    x: 0,
    y: deckY + 2.2,
    z: 0.6,
    radius: 4,
    label: "Read the departure board",
    detail: "Ring line, every ninety seconds, all the way round",
    text: "Ring line. Ninety seconds. It has never once been late.",
  });
  b.hit({
    id: "tram-bench",
    x: -4.2,
    y: deckY + 0.6,
    z: hz - 2.9,
    radius: 2.4,
    label: "Wait for the tram",
    detail: "There is nothing else you have to do",
    text: "You sit. The island turns very slightly under the sunset. Nobody hurries.",
  });

  doorSpill(b, hz + 2.1, openW / 2 + 0.6, 5, 0xffbe86, 0.34);
}

/**
 * The board itself: a frame, a header and four seven-segment digits.
 *
 * Returned as its own mesh because it is the only thing in these rooms with a
 * material that has state in it, and the update loop wants to find it without
 * traversing anything.
 */
function buildBoard(b: Rb, x: number, y: number, z: number): void {
  b.box(3.2, 1.25, 0.16, x, y, z, { col: 0x14121c });
  b.box(3.34, 0.1, 0.22, x, y + 0.66, z, { col: P.iron });
  b.box(3.34, 0.1, 0.22, x, y - 0.66, z, { col: P.iron });
  // Header bar — "NEXT RING TRAM", as five warm ticks.
  for (let i = 0; i < 5; i++) {
    const g = new THREE.PlaneGeometry(0.34, 0.07);
    g.translate(x - 1.1 + i * 0.52, y + 0.44, z - 0.1);
    b.lit(g, { col: 0xffc98a, power: 1.4 });
  }

  const parts: THREE.BufferGeometry[] = [];
  const digitX = [-0.95, -0.42, 0.42, 0.95];
  for (let d = 0; d < 4; d++) {
    for (let s = 0; s < 7; s++) {
      parts.push(segQuad(x + digitX[d], y - 0.12, z - 0.1, s, d));
    }
  }
  // The colon between the pairs, always lit: aSeg < 0 means "on".
  for (const dy of [0.12, -0.16]) {
    const g = new THREE.PlaneGeometry(0.07, 0.07);
    g.translate(x, y - 0.12 + dy, z - 0.1);
    parts.push(tagBoard(prep(g), -1, 0, 0x8ff0c0));
  }
  const merged = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  const mesh = new THREE.Mesh(merged, makeBoardMaterial());
  mesh.name = "empyrean-tram-board";
  b.extra.push(mesh);
}

/** One bar of a seven-segment digit, positioned by its index. */
function segQuad(x: number, y: number, z: number, seg: number, digit: number): THREE.BufferGeometry {
  const w = 0.30;
  const h = 0.62;
  const t = 0.062;
  const layout: Array<[number, number, number, number]> = [
    [0, h / 2, w - t, t], // a  top
    [w / 2 - t / 2, h / 4, t, h / 2 - t], // b  top right
    [w / 2 - t / 2, -h / 4, t, h / 2 - t], // c  bottom right
    [0, -h / 2, w - t, t], // d  bottom
    [-w / 2 + t / 2, -h / 4, t, h / 2 - t], // e  bottom left
    [-w / 2 + t / 2, h / 4, t, h / 2 - t], // f  top left
    [0, 0, w - t, t], // g  middle
  ];
  const [ox, oy, sw, sh] = layout[seg];
  const g = new THREE.PlaneGeometry(sw, sh);
  g.translate(x + ox, y + oy, z);
  return tagBoard(prep(g), seg, digit, 0x8ff0c0);
}

function tagBoard(g: THREE.BufferGeometry, seg: number, digit: number, col: number): THREE.BufferGeometry {
  const n = g.getAttribute("position").count;
  const c = new Float32Array(n * 3);
  const d = new Float32Array(n);
  const s = new Float32Array(n);
  _cA.setHex(col, THREE.SRGBColorSpace);
  for (let i = 0; i < n; i++) {
    c[i * 3] = _cA.r * 2.1;
    c[i * 3 + 1] = _cA.g * 2.1;
    c[i * 3 + 2] = _cA.b * 2.1;
    d[i] = digit;
    s[i] = seg;
  }
  g.setAttribute("aCol", new THREE.BufferAttribute(c, 3));
  g.setAttribute("aDigit", new THREE.BufferAttribute(d, 1));
  g.setAttribute("aSeg", new THREE.BufferAttribute(s, 1));
  return g;
}

/* -------------------------------------------------------------------------
 * 5. The Lantern Gallery
 * ---------------------------------------------------------------------- */

const GALLERY = { hx: 5.4, hz: 6.6, ceil: 4.4, openW: 4.2, openH: 2.9 };

function buildGallery(b: Rb): void {
  const { hx, hz, ceil, openW, openH } = GALLERY;
  const rng = b.rng;
  const wallSkin: Skin = {
    col: 0x8d8296,
    col2: 0x342c3c,
    mix: (_x, y) => THREE.MathUtils.clamp(1 - y / ceil, 0, 1) * 0.85,
  };

  pavedFloor(b, hx, hz, 1.8, (x, z) => ({
    col: 0x574c58,
    col2: 0x7a6c72,
    mix: () => 0.2 + 0.3 * Math.abs(Math.sin(x * 0.9 + z * 1.3)),
  }));
  wallX(b, -hz, -hx, hx, 0.3, ceil, wallSkin);
  wallZ(b, -hx, -hz, hz, 0.3, ceil, wallSkin);
  wallZ(b, hx, -hz, hz, 0.3, ceil, wallSkin);
  wallWithOpening(b, {
    z: hz, x0: -hx, x1: hx, thick: 0.3, top: ceil, openW, openH, skin: wallSkin,
  });

  // A coffered ceiling with a long skylight down the middle.
  b.box(hx * 2, 0.3, hz * 2, 0, ceil + 0.15, 0, { col: 0x2e2734 });
  b.box(2.0, 0.34, hz * 2 - 1.6, 0, ceil + 0.1, 0, { col: P.glassCool, emit: 0.7, sky: 1 });
  for (let i = -3; i <= 3; i++) {
    b.box(0.16, 0.3, 2.0, i * 0.9, ceil - 0.05, 0, { col: P.iron });
  }
  lightShaft(b, 0, 0, ceil - 0.4, 0.1, 1.0, 2.6, 0.5, 0xbcd4ff, 0.16);

  /* ---- the pictures. Each one is a lit gradient in a frame ---- */
  const hang: Array<[number, number, number]> = [
    [-hx + 0.2, -3.6, Math.PI / 2],
    [-hx + 0.2, 0.4, Math.PI / 2],
    [-hx + 0.2, 4.0, Math.PI / 2],
    [hx - 0.2, -3.6, -Math.PI / 2],
    [hx - 0.2, 0.4, -Math.PI / 2],
    [0, -hz + 0.2, 0],
  ];
  hang.forEach(([px, pz, ry], i) => {
    const w = i === 5 ? 3.2 : 1.9;
    const h = i === 5 ? 2.0 : 1.4;
    b.box(w + 0.2, h + 0.2, 0.12, px, 2.3, pz, { col: P.brass, emit: 0.2 }, ry);
    const canvasCol = P.produce[i % P.produce.length];
    b.box(w, h, 0.06, px + Math.sin(ry) * 0.05, 2.3, pz + Math.cos(ry) * 0.05, {
      col: canvasCol,
      col2: 0x1a1626,
      mix: (_x, y) => THREE.MathUtils.clamp(1 - (y - 1.6) / 1.4, 0, 1),
      emit: 0.45,
    }, ry);
    // The picture light above it.
    b.box(w * 0.5, 0.1, 0.3, px, 3.25, pz, { col: P.brass }, ry);
    const glowG = new THREE.PlaneGeometry(w, h * 0.9);
    glowG.rotateY(ry);
    glowG.translate(px + Math.sin(ry) * 0.12, 2.3, pz + Math.cos(ry) * 0.12);
    b.lit(glowG, { col: canvasCol, power: (_x, y) => 0.55 * (1 - (y - 1.7) / 1.6), flick: 0.1 + i * 0.07 });
    b.lamp(px + Math.sin(ry) * 0.9, 3.0, pz + Math.cos(ry) * 0.9, 0xffd0a0, 0.55, 5.5, i === 5 ? 1.4 : 0.5);
  });

  /* A bench, set back off the way in.
   *
   * The obvious place for it is the middle of the room and the middle of the
   * room is the line you walk along, so the first thing the gallery would do
   * is trip you. It faces the big picture instead. */
  b.inst("bench", benchGeo, trs(0, 0, -2.4, Math.PI));
  b.blocker(0, -2.4, 0.95, 0.35, 0, 0.75);
  for (const px of [-2.2, 2.2]) {
    b.box(0.1, 0.9, 0.1, px, 0.45, -hz + 1.4, { col: P.brass });
  }
  b.box(4.3, 0.05, 0.05, 0, 0.82, -hz + 1.4, { col: 0x8a2f3a });

  // A guest book on a stand by the door.
  b.box(0.5, 1.0, 0.4, hx - 1.3, 0.5, hz - 1.4, { col: P.timber }, -0.3);
  b.box(0.44, 0.05, 0.34, hx - 1.3, 1.03, hz - 1.4, { col: 0xe6dcc6, emit: 0.3 }, -0.3);
  b.blocker(hx - 1.3, hz - 1.4, 0.3, 0.3, 0, 1.05);

  b.hit({
    id: "gallery-book",
    x: hx - 1.3,
    y: 1.1,
    z: hz - 1.4,
    radius: 2.2,
    label: "Sign the book",
    detail: "Eleven thousand names, and room for yours",
    text: "You add your name under somebody who came here in the first week.",
  });
  b.hit({
    id: "gallery-big",
    x: 0,
    y: 2.3,
    z: -hz + 1.6,
    radius: 3,
    label: "Look at the big one",
    detail: "“The Lake, Before It Froze”",
    text: "“The Lake, Before It Froze.” Nobody alive has seen it that colour.",
  });

  void rng;
  doorSpill(b, hz + 0.16, openW / 2, 4.5, 0xffc79a, 0.36);
}

/* -------------------------------------------------------------------------
 * Placement
 * ---------------------------------------------------------------------- */

interface Placement {
  id: string;
  name: string;
  x: number;
  z: number;
  yaw: number;
  hx: number;
  hz: number;
  height: number;
  openW: number;
  round?: boolean;
  landmark?: string;
  lot?: string;
  build: (b: Rb) => void;
}

function landmarkNamed(id: string): Landmark {
  const l = LANDMARKS.find((k) => k.id === id);
  if (!l) throw new Error(`empyrean/interiors: no landmark "${id}"`);
  return l;
}

/**
 * The café's lot, and the gallery's: chosen from the plan, not invented.
 *
 * "The shop nearest the Market Hall" and "the shop nearest the Observatory"
 * are one line each, they are stable for as long as the plan's seed is, and
 * they put both rooms on a walk somebody was already making.
 */
function nearestLot(use: Lot["use"], district: Lot["district"], to: { x: number; z: number }): Lot {
  const lots = cityPlan()
    .lots.filter((l) => l.use === use && l.district === district)
    .sort((a, b) => {
      const da = Math.hypot(a.centroid.x - to.x, a.centroid.z - to.z);
      const db = Math.hypot(b.centroid.x - to.x, b.centroid.z - to.z);
      return da === db ? a.id.localeCompare(b.id) : da - db;
    });
  if (!lots.length) throw new Error(`empyrean/interiors: no ${district}/${use} lot`);
  return lots[0];
}

function placements(): Placement[] {
  const hall = landmarkNamed("market-hall");
  const obs = landmarkNamed("observatory");
  const tram = landmarkNamed("tram-halo");

  const cafeLot = nearestLot("shop", "market", hall);
  const cafeYaw = Math.atan2(cafeLot.frontNormal.z, cafeLot.frontNormal.x);
  const cafeX = cafeLot.frontMid.x - cafeLot.frontNormal.x * (CAFE.hz + 0.5);
  const cafeZ = cafeLot.frontMid.z - cafeLot.frontNormal.z * (CAFE.hz + 0.5);

  const galLot = nearestLot("shop", "gardens", obs);
  const galYaw = Math.atan2(galLot.frontNormal.z, galLot.frontNormal.x);
  const galX = galLot.frontMid.x - galLot.frontNormal.x * (GALLERY.hz + 0.5);
  const galZ = galLot.frontMid.z - galLot.frontNormal.z * (GALLERY.hz + 0.5);

  // The Observatory's shutter is cut toward the sunset, expressed in the
  // room's own frame: a local azimuth `al` points at world `al + yaw - PI/2`.
  const slotAz = SUN_AZ - obs.yaw + Math.PI / 2;

  return [
    {
      id: "market-hall",
      name: "The Market Hall",
      x: hall.x,
      z: hall.z,
      yaw: hall.yaw,
      hx: HALL.hx,
      hz: HALL.hz,
      height: HALL.crown,
      openW: HALL.openW,
      landmark: hall.id,
      build: buildMarketHall,
    },
    {
      id: "cafe",
      name: "The Kettle & Keel",
      x: cafeX,
      z: cafeZ,
      yaw: cafeYaw,
      hx: CAFE.hx,
      hz: CAFE.hz,
      height: CAFE.ceil,
      openW: CAFE.openW,
      lot: cafeLot.id,
      build: buildCafe,
    },
    {
      id: "observatory",
      name: "The Observatory",
      x: obs.x,
      z: obs.z,
      yaw: obs.yaw,
      hx: OBS.r,
      hz: OBS.r,
      height: OBS.crown,
      openW: OBS.openW,
      round: true,
      landmark: obs.id,
      build: (b) => buildObservatory(b, slotAz),
    },
    {
      id: "tram-halo",
      name: "Halo Station",
      x: tram.x,
      z: tram.z,
      yaw: tram.yaw,
      hx: STATION.hx,
      hz: STATION.hz,
      height: STATION.canopy + 1.2,
      openW: STATION.openW,
      landmark: tram.id,
      build: buildStation,
    },
    {
      id: "gallery",
      name: "The Lantern Gallery",
      x: galX,
      z: galZ,
      yaw: galYaw,
      hx: GALLERY.hx,
      hz: GALLERY.hz,
      height: GALLERY.ceil,
      openW: GALLERY.openW,
      lot: galLot.id,
      build: buildGallery,
    },
  ];
}

/**
 * The rooms as data, with no THREE in the answer.
 *
 * Cheap, deterministic and pure, so the tests can assert where every room is
 * and how wide its door is without building a single triangle.
 */
export function interiorPlan(): InteriorInfo[] {
  return placements().map((p) => ({
    id: p.id,
    name: p.name,
    x: p.x,
    y: ISLAND_Y,
    z: p.z,
    yaw: p.yaw,
    hx: p.hx,
    hz: p.hz,
    round: p.round,
    height: p.height,
    openWidth: p.openW,
    doorstep: {
      x: p.x + Math.cos(p.yaw) * (p.hz + 2.5),
      z: p.z + Math.sin(p.yaw) * (p.hz + 2.5),
    },
    extent: Math.hypot(p.hx, p.hz),
    landmark: p.landmark,
    lot: p.lot,
  }));
}

/* -------------------------------------------------------------------------
 * Build
 * ---------------------------------------------------------------------- */

interface Room {
  info: InteriorInfo;
  group: THREE.Group;
  surface: THREE.ShaderMaterial;
  glow: THREE.ShaderMaterial | null;
  board: THREE.Mesh | null;
  /** World-space lamps, best first. */
  lamps: LLamp[];
  geos: THREE.BufferGeometry[];
  mats: THREE.Material[];
  /** Squared distance gate, precomputed. */
  cx: number;
  cz: number;
  cy: number;
  /** Fade of the real lights, 0..1, eased each frame. */
  mix: number;
}

/** local → world for a room at (px, pz) facing `yaw`. */
function toWorld(px: number, pz: number, yaw: number, ox: number, oz: number): [number, number] {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  return [ox + px * s + pz * c, oz - px * c + pz * s];
}

export function buildInteriors(ctx: BuildContext): InteriorsHandle {
  const group = new THREE.Group();
  group.name = "empyrean-interiors";
  const rng = makeRng("empyrean-interiors-v1");

  const rooms: Room[] = [];
  const blockers: Blocker[] = [];
  const decks: Deck[] = [];
  const hits: Interactable[] = [];
  const claimed: string[] = [];
  const infos = interiorPlan();

  const handle: InteriorsHandle = {
    name: "interiors",
    group,
    reflected: false,
    blockers,
    decks,
    rooms: infos,
    claimedLots: claimed,
    onToast: null,
    interactables: () => hits,
    inside: () => null,
    update: () => undefined,
    dispose: () => undefined,
  };

  const specs = placements();
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const info = infos[i];
    if (spec.lot) claimed.push(spec.lot);

    const b = new Rb(rng.fork(spec.id), ctx.quality);
    spec.build(b);

    /* ---- one group, one rotation, everything else stays local ---- */
    const rg = new THREE.Group();
    rg.name = `empyrean-interior-${spec.id}`;
    // Local +Z must come out along `yaw`; three's rotateY(t) sends +Z to
    // (sin t, cos t), so t = PI/2 - yaw.
    rg.rotation.y = Math.PI / 2 - spec.yaw;
    rg.position.set(spec.x, ISLAND_Y, spec.z);
    rg.matrixAutoUpdate = false;
    rg.updateMatrix();
    group.add(rg);

    const geos: THREE.BufferGeometry[] = [];
    const mats: THREE.Material[] = [];
    const surface = makeSurfaceMaterial();
    mats.push(surface);

    if (b.solid.length) {
      const merged = mergeGeometries(b.solid, false)!;
      b.solid.forEach((g) => g.dispose());
      geos.push(merged);
      const mesh = new THREE.Mesh(merged, surface);
      mesh.name = `${spec.id}-shell`;
      mesh.frustumCulled = false;
      rg.add(mesh);
    }

    let glowMat: THREE.ShaderMaterial | null = null;
    if (b.glow.length) {
      glowMat = makeGlowMaterial();
      mats.push(glowMat);
      const merged = mergeGeometries(b.glow, false)!;
      b.glow.forEach((g) => g.dispose());
      geos.push(merged);
      const mesh = new THREE.Mesh(merged, glowMat);
      mesh.name = `${spec.id}-glow`;
      mesh.frustumCulled = false;
      mesh.renderOrder = 3;
      rg.add(mesh);
    }

    for (const [key, set] of b.sets) {
      if (!set.m.length) {
        set.geo.dispose();
        continue;
      }
      let mat: THREE.ShaderMaterial;
      if (set.glow) {
        if (!glowMat) {
          glowMat = makeGlowMaterial();
          mats.push(glowMat);
        }
        mat = glowMat;
      } else {
        mat = surface;
      }
      const mesh = new THREE.InstancedMesh(set.geo, mat, set.m.length);
      mesh.name = `${spec.id}-${key}`;
      mesh.frustumCulled = false;
      if (set.glow) mesh.renderOrder = 3;
      const tint = new Float32Array(set.m.length * 3);
      for (let k = 0; k < set.m.length; k++) {
        mesh.setMatrixAt(k, set.m[k]);
        _cA.setHex(set.tint[k], THREE.SRGBColorSpace);
        tint[k * 3] = _cA.r;
        tint[k * 3 + 1] = _cA.g;
        tint[k * 3 + 2] = _cA.b;
      }
      mesh.instanceMatrix.needsUpdate = true;
      // Overwrites the per-vertex aTint with a per-instance one; same name,
      // same meaning, and the shader never has to know which it got.
      set.geo.setAttribute("aTint", new THREE.InstancedBufferAttribute(tint, 3));
      geos.push(set.geo);
      rg.add(mesh);
    }

    for (const mesh of b.extra) {
      mesh.frustumCulled = false;
      mesh.renderOrder = 4;
      geos.push(mesh.geometry);
      mats.push(mesh.material as THREE.Material);
      rg.add(mesh);
    }

    /* ---- blockers: local boxes, chopped if the room sits oblique ---- */
    const rot = Math.PI / 2 - spec.yaw;
    for (const box of b.boxes) {
      pushWorldBlockers(blockers, box, rot, spec.x, spec.z);
    }
    for (const d of b.decks) {
      pushWorldDecks(decks, d, rot, spec.x, spec.z);
    }

    /* ---- lamps, world space, strongest first ---- */
    const lamps = b.lamps
      .map((l) => {
        const [wx, wz] = toWorld(l.x, l.z, spec.yaw, spec.x, spec.z);
        return { ...l, x: wx, z: wz, y: ISLAND_Y + l.y };
      })
      .sort((a, bb) => bb.rank - a.rank);

    // The shader's six virtual lamps are the six best; the rest still exist as
    // geometry, which for a bulb under a canopy is most of what they were for.
    const uLamp = surface.uniforms.uLamp.value as THREE.Vector4[];
    const uLampC = surface.uniforms.uLampC.value as THREE.Vector3[];
    for (let k = 0; k < NL; k++) {
      const l = lamps[k];
      if (!l) {
        uLamp[k].set(0, -9999, 0, 1);
        uLampC[k].set(0, 0, 0);
        continue;
      }
      uLamp[k].set(l.x, l.y, l.z, l.range);
      _cA.setHex(l.col, THREE.SRGBColorSpace);
      uLampC[k].set(_cA.r * l.power, _cA.g * l.power, _cA.b * l.power);
    }

    /* ---- interactables ---- */
    for (const h of b.hits) {
      const [wx, wz] = toWorld(h.x, h.z, spec.yaw, spec.x, spec.z);
      hits.push({
        id: h.id,
        x: wx,
        y: ISLAND_Y + h.y,
        z: wz,
        radius: h.radius,
        label: h.label,
        detail: h.detail,
        activate: () => handle.onToast?.(h.text, "info"),
      });
    }

    rooms.push({
      info,
      group: rg,
      surface,
      glow: glowMat,
      board: b.extra.length ? b.extra[0] : null,
      lamps,
      geos,
      mats,
      cx: spec.x,
      cz: spec.z,
      cy: ISLAND_Y + Math.min(6, spec.height / 2),
      mix: 0,
    });
  }

  /* ---- the real lights: six, made once, never added or removed ---- */
  const pool: THREE.PointLight[] = [];
  for (let i = 0; i < LIGHT_POOL; i++) {
    const light = new THREE.PointLight(0xffb878, 0, 14, 2);
    light.position.set(0, ISLAND_Y - 500, 0);
    light.name = `empyrean-interior-light-${i}`;
    group.add(light);
    pool.push(light);
  }

  const sunCol = new THREE.Color();

  handle.inside = (x: number, y: number, z: number): string | null => {
    for (const r of rooms) {
      const dx = x - r.info.x;
      const dz = z - r.info.z;
      const s = Math.sin(r.info.yaw);
      const c = Math.cos(r.info.yaw);
      // Inverse of `toWorld`: the rotation is orthonormal, so it is a transpose.
      const lx = dx * s - dz * c;
      const lz = dx * c + dz * s;
      if (r.info.round) {
        if (lx * lx + lz * lz > r.info.hx * r.info.hx) continue;
      } else if (Math.abs(lx) > r.info.hx || Math.abs(lz) > r.info.hz) {
        continue;
      }
      const ly = y - r.info.y;
      if (ly < -1.5 || ly > r.info.height + 1.5) continue;
      return r.info.id;
    }
    return null;
  };

  handle.update = (frame: FrameContext): void => {
    const p = frame.player.position;

    /* Which room is worth spending the six lights on: the one you are in,
       else the nearest within WAKE_R. One pass, no allocation. */
    let best: Room | null = null;
    let bestD = WAKE_R * WAKE_R;
    for (const r of rooms) {
      const dx = p.x - r.cx;
      const dz = p.z - r.cz;
      const dy = p.y - r.cy;
      const d = dx * dx + dz * dz + dy * dy;
      const near = d < DRAW_R * DRAW_R;
      if (r.group.visible !== near) r.group.visible = near;
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }

    const ease = Math.min(1, frame.dt * 3.5);
    for (const r of rooms) {
      const want = r === best ? 1 : 0;
      if (r.mix === want && want === 0) continue;
      r.mix += (want - r.mix) * ease;
      if (r.mix < 0.002) r.mix = 0;
    }

    /* Sun and sky, for the handful of vertices that can see either. */
    const daylight = frame.daylight;
    sunCol.setRGB(1.0, 0.79, 0.56).multiplyScalar(0.35 + daylight * 1.5);
    for (const r of rooms) {
      if (!r.group.visible) continue;
      (r.surface.uniforms.uSunDir.value as THREE.Vector3).copy(frame.sunDir);
      (r.surface.uniforms.uSunCol.value as THREE.Color).copy(sunCol);
    }

    /* Animation, only for the room you are at. Everything else is still. */
    for (const r of rooms) {
      const on = r === best ? 1 : 0;
      if (r.glow) {
        const u = r.glow.uniforms;
        if (on) u.uTime.value = frame.time;
        if (u.uAnim.value !== on) u.uAnim.value = on;
      }
    }

    if (best?.board) {
      const mat = best.board.material as THREE.ShaderMaterial;
      const left = 90 - (frame.time % 90);
      const mm = Math.floor(left / 60);
      const ss = Math.floor(left % 60);
      const mask = mat.uniforms.uMask.value as THREE.Vector4;
      mask.set(
        SEG7[Math.floor(mm / 10) % 10],
        SEG7[mm % 10],
        SEG7[Math.floor(ss / 10) % 10],
        SEG7[ss % 10],
      );
      // The last ten seconds blink, because a countdown that does not is a clock.
      mat.uniforms.uOn.value = left < 10 && Math.floor(frame.time * 3) % 2 === 0 ? 0.35 : 1;
    }

    /* The six real lights follow whichever room is lit. */
    let slot = 0;
    if (best && best.mix > 0.002) {
      const lamps = best.lamps;
      for (let i = 0; i < lamps.length && slot < LIGHT_POOL; i++, slot++) {
        const l = lamps[i];
        const light = pool[slot];
        light.position.set(l.x, l.y, l.z);
        light.color.setHex(l.col);
        light.distance = l.range;
        light.intensity = l.power * 22 * best.mix;
      }
    }
    for (; slot < LIGHT_POOL; slot++) pool[slot].intensity = 0;
  };

  handle.dispose = () => {
    for (const r of rooms) {
      for (const g of r.geos) g.dispose();
      for (const m of r.mats) m.dispose();
      r.group.clear();
    }
    for (const l of pool) l.dispose();
    group.clear();
    rooms.length = 0;
  };

  return handle;
}

/* -------------------------------------------------------------------------
 * Local boxes → world AABBs
 * ---------------------------------------------------------------------- */

/** Below this the room is square to the world and nothing has to be chopped. */
const AXIS_EPS = 1e-3;
/** Piece length for an oblique wall. See the note at the top of the file. */
const CHOP = 1.2;

function pushWorldBlockers(out: Blocker[], box: LBox, rot: number, ox: number, oz: number): void {
  const phi = rot + box.ry;
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const oblique = Math.abs(c * s) > AXIS_EPS;

  // Chop along the longer axis so each piece is close to square.
  let nx = 1;
  let nz = 1;
  if (oblique) {
    nx = Math.max(1, Math.ceil((box.hx * 2) / CHOP));
    nz = Math.max(1, Math.ceil((box.hz * 2) / CHOP));
  }
  const px = box.hx / nx;
  const pz = box.hz / nz;
  const cr = Math.cos(box.ry);
  const sr = Math.sin(box.ry);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const lx = -box.hx + px * (2 * i + 1);
      const lz = -box.hz + pz * (2 * j + 1);
      // Out of the box's own frame into the room's, then into the world.
      const cx = box.x + lx * cr + lz * sr;
      const cz = box.z - lx * sr + lz * cr;
      const [wx, wz] = toWorldRot(cx, cz, rot, ox, oz);
      out.push({
        x: wx,
        z: wz,
        hx: px * Math.abs(c) + pz * Math.abs(s),
        hz: px * Math.abs(s) + pz * Math.abs(c),
        top: ISLAND_Y + box.top,
        bottom: ISLAND_Y + box.bottom,
      });
    }
  }
}

function toWorldRot(x: number, z: number, rot: number, ox: number, oz: number): [number, number] {
  return [ox + x * Math.cos(rot) + z * Math.sin(rot), oz - x * Math.sin(rot) + z * Math.cos(rot)];
}

/**
 * A deck cannot be over-approximated — an AABB bigger than the platform is
 * floor you can stand on that is not there — so an oblique one is inset by the
 * worst-case overshoot before it is tiled.
 */
function pushWorldDecks(out: Deck[], d: LDeck, rot: number, ox: number, oz: number): void {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  if (Math.abs(c * s) <= AXIS_EPS) {
    const [wx, wz] = toWorldRot(d.x, d.z, rot, ox, oz);
    out.push({
      y: ISLAND_Y + d.y,
      x: wx,
      z: wz,
      hx: d.hx * Math.abs(c) + d.hz * Math.abs(s),
      hz: d.hx * Math.abs(s) + d.hz * Math.abs(c),
    });
    return;
  }
  const nx = Math.max(1, Math.ceil((d.hx * 2) / CHOP));
  const nz = Math.max(1, Math.ceil((d.hz * 2) / CHOP));
  const px = d.hx / nx;
  const pz = d.hz / nz;
  const hx = px * Math.abs(c) + pz * Math.abs(s);
  const hz = px * Math.abs(s) + pz * Math.abs(c);
  const inx = Math.max(0.05, hx - (px * Math.abs(c) + pz * Math.abs(s) - px));
  const inz = Math.max(0.05, hz - (px * Math.abs(s) + pz * Math.abs(c) - pz));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const lx = -d.hx + px * (2 * i + 1);
      const lz = -d.hz + pz * (2 * j + 1);
      const [wx, wz] = toWorldRot(d.x + lx, d.z + lz, rot, ox, oz);
      out.push({ y: ISLAND_Y + d.y, x: wx, z: wz, hx: inx, hz: inz });
    }
  }
}
