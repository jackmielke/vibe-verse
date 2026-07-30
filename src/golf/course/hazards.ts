/**
 * Vibe Golf — hazards and moving parts.
 *
 * Everything the course designer can bolt onto a hole that *acts on the ball*:
 * bumpers, fans, conveyors, moving platforms, wind zones, boost pads,
 * breakables and cannons. Portals are next door in `portals.ts`.
 *
 * Three rules shaped this module.
 *
 * 1. **A prop must be legible before it fires.** Every kind gets its own
 *    silhouette and its own colour, and every one of them animates while idle
 *    so it reads as live machinery rather than scenery. A player who has never
 *    seen a fan should still guess which way it blows.
 * 2. **A prop must never strand the ball.** Fields (fans, wind) are skipped for
 *    balls that are slow *and* supported, so a ball can always settle inside a
 *    column instead of hovering in it forever; belts have a stall cut-out; and
 *    a breakable is only ever damaged by an impact fast enough that the ball
 *    was never resting on it.
 * 3. **Moving colliders are ours, not the broadphase's.** The physics
 *    broadphase is flattened once per hole from static segments, so a surface
 *    that moves cannot live in it. On hole load we *remove* the mover and
 *    breakable slabs from `hole.surfaces` and rebuild the broadphase once
 *    (`setHole` is ~1 ms; per-frame it would be unaffordable), then resolve the
 *    ball against those boxes ourselves with a swept test every frame. We run
 *    after `physics.update`, so we see the ball where the solver left it and
 *    fix it up before anything draws. The removal is undone on hole change and
 *    on dispose — `COURSES` is shared, immutable-by-convention data.
 *
 * Because we own those colliders we also own their *rendering* (the scene
 * renderer only draws what is in `hole.surfaces`), which is what makes a
 * breakable able to actually disappear when it shatters.
 *
 * Publishes no service. Emits `golf:bumper`, `golf:boost`, `golf:break`,
 * `golf:cannon`, `golf:mover`. Consumes `golf:hole`.
 */
import * as THREE from "three";
import type {
  BallState,
  Hole,
  PropSpec,
  Surface,
  SurfaceMaterial,
  System,
  SystemFactory,
  Vec2,
} from "../types";
import { BALL_TYPES, MATERIALS, v2 } from "../types";
import { LAYER } from "../engine/core";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Separation kept after a push-out, metres. Mirrors the solver's SKIN. */
const SKIN = 0.006;
/** Contacts shallower than this against a mover roll instead of bouncing. */
const ROLL_REL = 1.5;
/** Relative speed under which a ball riding a platform is captured. */
const CARRY_SPEED = 2.2;
/** A single frame can never legitimately move a ball further than this. */
const WARP_DIST = 12;

/** Fan acceleration is `power` m/s² outright — gravity is 22, so 34 lifts. */
const FAN_GAIN = 1.0;
/** Wind zones are broad and permanent, so they get a fraction of their power. */
const WIND_GAIN = 0.42;
/** A ball this slow and touching something is allowed to settle in a field. */
const FIELD_SETTLE_SPEED = 1.35;

/** Belt pull, and the acceleration ceiling that lets a fast ball fight it. */
const BELT_GAIN = 6;
const BELT_MAX_ACCEL = 26;
/** Seconds a ball may be jammed on a belt before the belt gives up on it. */
const BELT_STALL = 1.2;

/** Bumper: outgoing speed is at least this, or the incoming speed times this. */
const BUMPER_GAIN = 1.35;
const BUMPER_MAX = 56;
const BUMPER_COOLDOWN = 0.14;

/** Boost pads redirect rather than add, so their effect is predictable. */
const BOOST_GAIN = 1.2;
const BOOST_COOLDOWN = 0.45;
const BOOST_MIN_SPEED = 1.4;

/** Breakables ignore anything gentler than this — a resting ball is safe. */
const BREAK_MIN_SPEED = 9;
/** Speed retained by the ball on the impact that finally destroys a slab. */
const BREAK_PUNCH = 0.72;

const CANNON_HOLD = 0.42;
const CANNON_RECHARGE = 0.75;
const CANNON_POWER = 32;

/** Total field particles, by quality tier. */
const FIELD_BUDGET: Record<string, number> = { low: 0, medium: 90, high: 190 };
const DEBRIS_MAX = 44;

/** House palette: amber acts, teal blows, rose kicks. */
const C_BUMPER = 0xf43f5e;
const C_BUMPER_HOT = 0xffe8b0;
const C_FAN = 0x2dd4bf;
const C_WIND = 0xa8d8ff;
const C_BOOST = 0xfbbf24;
const C_BELT = 0xfbbf24;
const C_MOVER = 0x2dd4bf;
const C_BREAK = 0xff8a3d;
const C_CANNON = 0xfbbf24;

/**
 * Cannons live in the seam between this module and `portals`. First system to
 * boot claims them; hazards boots first, so portals stands down — but if we
 * ever fail to boot, portals picks them up and the mechanic still works.
 */
const CANNON_CLAIM = "__vibeGolfCannonOwner";

// ---------------------------------------------------------------------------
// Canvas helpers — all textures are drawn once, at boot.
// ---------------------------------------------------------------------------

interface Pad { cv: HTMLCanvasElement; g: CanvasRenderingContext2D }

function pad(w: number, h: number): Pad | null {
  if (typeof document === "undefined") return null;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const g = cv.getContext("2d");
  return g ? { cv, g } : null;
}

const rgba = (n: number, a: number) =>
  `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;

function texFrom(p: Pad | null, repeatX = 1, repeatY = 1): THREE.CanvasTexture | null {
  if (!p) return null;
  const t = new THREE.CanvasTexture(p.cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Diagonal hazard stripes — the universal "this thing moves" signal. */
function stripePad(): Pad | null {
  const S = 128;
  const p = pad(S, S);
  if (!p) return null;
  const { g } = p;
  g.fillStyle = "#191410";
  g.fillRect(0, 0, S, S);
  g.strokeStyle = rgba(C_BOOST, 0.92);
  g.lineWidth = S * 0.18;
  for (let i = -2; i < 4; i++) {
    g.beginPath();
    g.moveTo(i * S * 0.5 - S, -S * 0.2);
    g.lineTo(i * S * 0.5 + S * 0.4, S * 1.2);
    g.stroke();
  }
  // Worn edges so the stripes read as painted steel, not vinyl.
  g.globalAlpha = 0.5;
  for (let i = 0; i < 240; i++) {
    g.fillStyle = Math.random() < 0.5 ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.22)";
    g.fillRect(Math.random() * S, Math.random() * S, 1 + Math.random() * 3, 1 + Math.random() * 2);
  }
  g.globalAlpha = 1;
  return p;
}

/** Belt tread: dark rubber with bright cleats, tiling along X. */
function treadPad(): Pad | null {
  const S = 128;
  const p = pad(S, S);
  if (!p) return null;
  const { g } = p;
  g.fillStyle = "#14100c";
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 4; i++) {
    const x = (i / 4) * S;
    g.fillStyle = "rgba(255,255,255,0.07)";
    g.fillRect(x, 0, S * 0.06, S);
    // Cleat: a bright chevron pointing along +X.
    g.strokeStyle = rgba(C_BELT, 0.9);
    g.lineWidth = S * 0.055;
    g.beginPath();
    g.moveTo(x + S * 0.06, S * 0.16);
    g.lineTo(x + S * 0.19, S * 0.5);
    g.lineTo(x + S * 0.06, S * 0.84);
    g.stroke();
  }
  g.fillStyle = "rgba(0,0,0,0.45)";
  g.fillRect(0, 0, S, S * 0.1);
  g.fillRect(0, S * 0.9, S, S * 0.1);
  return p;
}

/** Riveted panel — the breakable's albedo, deliberately unlike any terrain. */
function panelPad(): Pad | null {
  const S = 128;
  const p = pad(S, S);
  if (!p) return null;
  const { g } = p;
  const gr = g.createLinearGradient(0, 0, 0, S);
  gr.addColorStop(0, "#6b5540");
  gr.addColorStop(0.5, "#4a3a2b");
  gr.addColorStop(1, "#6b5540");
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 3; i++) {
    const y = ((i + 1) / 3) * S;
    g.strokeStyle = "rgba(12,8,5,0.7)";
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(S, y);
    g.stroke();
    for (let k = 0; k < 6; k++) {
      const x = (k + 0.5) * (S / 6);
      const rg = g.createRadialGradient(x - 1, y - 5, 0, x, y - 4, 4);
      rg.addColorStop(0, "rgba(255,235,200,0.7)");
      rg.addColorStop(1, "rgba(30,20,12,0.6)");
      g.fillStyle = rg;
      g.beginPath();
      g.arc(x, y - 4, 4, 0, 6.2832);
      g.fill();
    }
  }
  return p;
}

/**
 * Crack network. The red channel encodes *seniority* — the shader reveals
 * cracks whose seniority is under the current damage, so a slab visibly
 * fractures further with every hit instead of just glowing brighter.
 */
function crackPad(rng: () => number): Pad | null {
  const S = 256;
  const p = pad(S, S);
  if (!p) return null;
  const { g } = p;
  g.fillStyle = "#000000";
  g.fillRect(0, 0, S, S);
  g.lineCap = "round";
  for (let i = 0; i < 26; i++) {
    // Early cracks are bright (low seniority = revealed first).
    const seniority = 0.25 + (i / 26) * 0.7;
    g.strokeStyle = `rgba(${Math.round(255 * (1.02 - seniority))},60,20,1)`;
    let x = rng() * S;
    let y = rng() * S;
    let a = rng() * 6.2832;
    const segs = 4 + Math.floor(rng() * 5);
    g.lineWidth = 3.4 - seniority * 1.9;
    g.beginPath();
    g.moveTo(x, y);
    for (let s = 0; s < segs; s++) {
      a += (rng() - 0.5) * 1.3;
      x += Math.cos(a) * S * 0.075;
      y += Math.sin(a) * S * 0.075;
      g.lineTo(x, y);
    }
    g.stroke();
    // A short fork keeps the network from reading as scratches.
    if (rng() < 0.6) {
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a + 1.1) * S * 0.09, y + Math.sin(a + 1.1) * S * 0.09);
      g.stroke();
    }
  }
  return p;
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const VERT_UV = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** Bumper face: a hot ring with rotating spokes, flaring white on contact. */
const FRAG_BUMPER = /* glsl */ `
  varying vec2 vUv;
  uniform float uTime, uHit;
  uniform vec3 uColor, uHot;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    float ang = atan(p.y, p.x);
    float spokes = 0.5 + 0.5 * sin(ang * 6.0 - uTime * 2.2);
    float ring = smoothstep(0.58, 0.70, r) * (1.0 - smoothstep(0.90, 1.0, r));
    float core = pow(max(0.0, 1.0 - r), 1.6);
    float pulse = 0.82 + 0.18 * sin(uTime * 3.1);
    // Spokes only show inside the hub, so the rim stays a clean bright circle
    // and the centre is what animates.
    float hub = (1.0 - smoothstep(0.20, 0.56, r)) * (0.55 + spokes * 0.45);
    vec3 c = uColor * (ring * 1.5 * pulse + core * 0.5) + uHot * hub * 0.7;
    c += uHot * uHit * (core * 3.4 + ring * 2.0);
    float a = clamp(ring * 0.98 + core * 0.5 + hub * 0.35 + uHit * 0.35, 0.0, 1.0);
    gl_FragColor = vec4(c, a);
  }
`;

/**
 * Chevrons marching along +U. One shader for the fan column, the boost arrow
 * and the conveyor's direction flash — the same visual verb every time, which
 * is most of what makes a prop guessable on sight.
 */
const FRAG_CHEVRON = /* glsl */ `
  varying vec2 vUv;
  uniform float uTime, uRate, uSpeed, uGain, uFade;
  uniform vec3 uColor;
  void main() {
    float u = vUv.x;
    float v = vUv.y * 2.0 - 1.0;
    float k = fract(u * uRate - uTime * uSpeed);
    float d = abs(v);
    // A proper arrowhead: the leading edge rakes back with distance from the
    // axis, and a hot core line down the middle keeps it crisp at phone size.
    float w = abs(k - 0.5 + d * 0.40);
    float chev = smoothstep(0.20, 0.03, w);
    float core = smoothstep(0.07, 0.0, w);
    // Fade in at the throat and out at the mouth so the field has no hard edge.
    float ends = smoothstep(0.0, uFade, u) * (1.0 - smoothstep(1.0 - uFade, 1.0, u));
    float sides = 1.0 - smoothstep(0.66, 1.0, d);
    float a = (chev * 0.72 + core * 0.28 + 0.04) * ends * sides * uGain;
    gl_FragColor = vec4(uColor * (chev * 1.3 + core * 1.5 + 0.12) * uGain, a);
  }
`;

/**
 * Crack reveal. `uMap.r` is crack seniority; only cracks under the current
 * damage show, so the fracture network genuinely spreads hit by hit.
 */
const FRAG_CRACK = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uMap;
  uniform float uTime, uDamage, uFlash;
  uniform vec2 uTile;
  uniform vec3 uColor;
  void main() {
    // Tiled in the shader, not by texture.repeat — a custom material never
    // gets three's uv transform, and an unstretched crack is the whole point.
    float t = texture2D(uMap, vUv * uTile).r;
    float on = smoothstep(0.0, 0.18, t - (1.0 - uDamage));
    if (on <= 0.001) discard;
    // Even undamaged, the hairlines breathe — that idle ember is the only
    // warning the player gets that this wall is not like the others.
    float breathe = 0.78 + 0.22 * sin(uTime * 1.9);
    float glow = on * (0.4 * breathe + uDamage * 1.1 + uFlash * 2.6);
    gl_FragColor = vec4(uColor * glow * 1.8, on * (0.45 + uDamage * 0.3 + uFlash * 0.45));
  }
`;

/**
 * An even glowing strip. A radial bloom stretched into a bar puddles in the
 * middle and leaves the ends dark, which is exactly wrong for an edge lamp.
 */
const FRAG_BAR = /* glsl */ `
  varying vec2 vUv;
  uniform float uTime, uGain;
  uniform vec3 uColor;
  void main() {
    float v = abs(vUv.y * 2.0 - 1.0);
    float g = pow(max(0.0, 1.0 - v), 2.4)
            * smoothstep(0.0, 0.05, vUv.x) * (1.0 - smoothstep(0.95, 1.0, vUv.x));
    float pulse = 0.86 + 0.14 * sin(uTime * 2.4);
    gl_FragColor = vec4(uColor * g * uGain * pulse * 1.7, g * 0.72 * uGain);
  }
`;

/** Soft round bloom — cannon muzzle charge and fan throats. */
const FRAG_BLOOM = /* glsl */ `
  varying vec2 vUv;
  uniform float uCharge;
  uniform vec3 uColor;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float g = pow(max(0.0, 1.0 - r), 2.2);
    gl_FragColor = vec4(uColor * g * (0.35 + uCharge * 3.2), g * (0.22 + uCharge * 0.8));
  }
`;

/**
 * Field particles are entirely GPU-side: `position` carries (regionX, regionY,
 * seed) and `aField` the region's frame, so nothing is written per frame and
 * every fan and wind zone on the hole is one draw call.
 */
const VERT_FIELD = /* glsl */ `
  attribute vec4 aField;
  attribute vec2 aExtra;
  attribute vec3 aColor;
  uniform float uTime, uPix;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float seed = position.z;
    float ang = aField.x;
    float halfLen = aField.y;
    float halfWid = aField.z;
    float life = aField.w;
    float size = aExtra.x;

    float ph = fract(seed * 13.17 + uTime / life);
    float lat = (fract(seed * 7.77) - 0.5) * 1.85 * halfWid;
    vec2 d = vec2(cos(ang), sin(ang));
    vec2 world = position.xy + d * (ph - 0.5) * 2.0 * halfLen + vec2(-d.y, d.x) * lat;

    vAlpha = smoothstep(0.0, 0.12, ph) * (1.0 - smoothstep(0.72, 1.0, ph)) * aExtra.y;
    vColor = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 0.0, 1.0);
    gl_PointSize = max(1.0, size * uPix);
  }
`;

const FRAG_FIELD = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    gl_FragColor = vec4(vColor, smoothstep(0.5, 0.05, d) * vAlpha);
  }
`;

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

interface Bumper {
  c: Vec2;
  r: number;
  power: number;
  group: THREE.Group;
  uHit: { value: number };
  hit: number;
  /** Contact normal of the last strike — the squash axis. */
  nx: number;
  ny: number;
}

interface Field {
  kind: "fan" | "windZone";
  c: Vec2;
  hx: number;
  hy: number;
  /** Blow direction. */
  dx: number;
  dy: number;
  power: number;
}

interface Conveyor {
  c: Vec2;
  hx: number;
  /** Belt surface height, world Y. */
  top: number;
  dir: number;
  speed: number;
  map: THREE.Texture | null;
  rollers: THREE.Object3D[];
}

interface Mover {
  id: string;
  path: Vec2[];
  /** Cumulative arc length at each waypoint, plus the closing leg. */
  arc: number[];
  total: number;
  s: number;
  speed: number;
  hx: number;
  hy: number;
  material: SurfaceMaterial;
  cx: number;
  cy: number;
  ocx: number;
  ocy: number;
  vx: number;
  vy: number;
  carried: BallState | null;
  group: THREE.Group;
  /** Waypoint index the platform most recently passed, for the end clank. */
  leg: number;
}

interface Boost {
  c: Vec2;
  hx: number;
  hy: number;
  dx: number;
  dy: number;
  power: number;
  group: THREE.Group;
  flash: number;
  uGain: { value: number };
}

interface Breakable {
  id: string;
  c: Vec2;
  hx: number;
  hy: number;
  material: SurfaceMaterial;
  hp: number;
  maxHp: number;
  alive: boolean;
  group: THREE.Group;
  uDamage: { value: number };
  uFlash: { value: number };
  flash: number;
}

interface Cannon {
  id: string;
  c: Vec2;
  a: number;
  nx: number;
  ny: number;
  radius: number;
  power: number;
  held: BallState | null;
  hold: number;
  kick: number;
  group: THREE.Group;
  pivot: THREE.Object3D;
  uCharge: { value: number };
}

/** Per-ball bookkeeping. Weak, so retired balls cost nothing. */
interface Track {
  px: number;
  py: number;
  /** Prop-keyed cooldowns, so one contact never fires twice. */
  bumpT: number;
  boostT: number;
  cannonBlock: string | null;
  cannonT: number;
  beltStall: number;
  fieldIn: boolean;
  /**
   * Seconds spent slow on top of a collider we own. The solver's settle test
   * probes the broadphase, which by definition cannot see our boxes, so a ball
   * parked on a breakable would never be called resting and the hole could
   * never end. We run the same test ourselves.
   */
  boxRest: number;
}

interface Chunk {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  spin: number;
  size: number;
  life: number;
  maxLife: number;
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

const createHazards: SystemFactory = (ctx) => {
  const globals = globalThis as unknown as Record<string, unknown>;
  if (!globals[CANNON_CLAIM]) globals[CANNON_CLAIM] = "hazards";
  const ownsCannons = globals[CANNON_CLAIM] === "hazards";

  const quality = ctx.quality ?? "high";
  const shadows = quality !== "low";

  const root = new THREE.Group();
  root.position.z = LAYER.props;
  ctx.scene.add(root);

  // --- Shared resources (built once, live for the system's lifetime) -------

  const quadGeo = new THREE.PlaneGeometry(1, 1);
  const circGeo = new THREE.CircleGeometry(1, 40);
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const discGeo = new THREE.CylinderGeometry(1, 1, 1, 26);
  const rollerGeo = new THREE.CylinderGeometry(0.7, 0.7, 1, 16);
  const barrelGeo = new THREE.CylinderGeometry(0.44, 0.56, 2.5, 14, 1, true);
  const drumGeo = new THREE.CylinderGeometry(0.95, 0.95, 1.2, 18);

  const stripeMap = texFrom(stripePad(), 1, 1);
  const treadMap = texFrom(treadPad(), 1, 1);
  const panelMap = texFrom(panelPad(), 1, 1);
  const crackMap = texFrom(crackPad(ctx.rng), 1, 1);

  const uTime = { value: 0 };
  const uPix = { value: 30 };
  const drawSize = new THREE.Vector2();
  const tmpColor = new THREE.Color();
  const dummy = new THREE.Object3D();

  // --- Per-hole state ------------------------------------------------------

  const bumpers: Bumper[] = [];
  const fields: Field[] = [];
  const conveyors: Conveyor[] = [];
  const movers: Mover[] = [];
  const boosts: Boost[] = [];
  const breakables: Breakable[] = [];
  const cannons: Cannon[] = [];
  const tracks = new WeakMap<BallState, Track>();
  /** Everything built for the current hole, torn down on the next one. */
  const perHole: Array<{ dispose(): void }> = [];
  /** Surfaces lifted out of the live hole so we can own them. */
  let lifted: Array<{ list: Surface[]; surface: Surface; index: number }> = [];
  let heldHole: Hole | null = null;

  let fieldPoints: THREE.Points | null = null;

  // --- Debris pool (one instanced draw for every shard on the hole) --------

  const chunks: Chunk[] = [];
  const debrisMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.85,
    metalness: 0.05,
    transparent: true,
  });
  const debris = new THREE.InstancedMesh(boxGeo, debrisMat, DEBRIS_MAX);
  debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  debris.frustumCulled = false;
  debris.castShadow = shadows;
  debris.count = DEBRIS_MAX;
  debris.visible = false;
  root.add(debris);
  for (let i = 0; i < DEBRIS_MAX; i++) {
    chunks.push({ x: 0, y: 0, vx: 0, vy: 0, rot: 0, spin: 0, size: 0, life: 0, maxLife: 1 });
    debris.setColorAt(i, tmpColor.setHex(0x888888));
  }

  // --- Small helpers -------------------------------------------------------

  function shader(
    frag: string,
    extra: Record<string, { value: unknown }>,
    additive: boolean,
    vert = VERT_UV,
  ): THREE.ShaderMaterial {
    const m = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { uTime, ...extra },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    perHole.push(m);
    return m;
  }

  function standard(opts: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial(opts);
    perHole.push(m);
    return m;
  }

  /** Stereo pan from world X, so a prop across the hole sits off-centre. */
  function panAt(x: number): number {
    const halfW = Math.max(1, (ctx.camera.right - ctx.camera.left) * 0.5);
    const v = (x - ctx.camera.position.x) / halfW;
    return v < -1 ? -1 : v > 1 ? 1 : v;
  }

  function track(b: BallState): Track {
    let t = tracks.get(b);
    if (!t) {
      t = {
        px: b.pos.x, py: b.pos.y,
        bumpT: 0, boostT: 0,
        cannonBlock: null, cannonT: 0,
        beltStall: 0, fieldIn: false, boxRest: 0,
      };
      tracks.set(b, t);
    }
    return t;
  }

  /** A chevron field quad oriented along `a`, sized to span the region. */
  function chevronQuad(
    a: number, halfLen: number, halfWid: number, color: number,
    rate: number, speed: number, gain: number, fade: number,
    uGain?: { value: number },
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(
      quadGeo,
      shader(FRAG_CHEVRON, {
        uColor: { value: new THREE.Color(color) },
        uRate: { value: rate },
        uSpeed: { value: speed },
        uGain: uGain ?? { value: gain },
        uFade: { value: fade },
      }, true),
    );
    mesh.scale.set(halfLen * 2, halfWid * 2, 1);
    mesh.rotation.z = a;
    return mesh;
  }

  // --- Build ---------------------------------------------------------------

  /** Put every surface we lifted back where it came from. */
  function restoreSurfaces(): void {
    // Removed high-index-first, so reinsert in the reverse order.
    for (let i = lifted.length - 1; i >= 0; i--) {
      const r = lifted[i];
      if (r.list.indexOf(r.surface) >= 0) continue;
      r.list.splice(Math.min(r.index, r.list.length), 0, r.surface);
    }
    lifted = [];
  }

  function clear(): void {
    // Never leave a ball frozen on a platform that is about to stop existing.
    for (const m of movers) dropCarried(m, false);
    for (const m of perHole.splice(0)) m.dispose();
    for (let i = root.children.length - 1; i >= 0; i--) {
      const child = root.children[i];
      if (child !== debris) root.remove(child);
    }
    bumpers.length = 0;
    fields.length = 0;
    conveyors.length = 0;
    movers.length = 0;
    boosts.length = 0;
    breakables.length = 0;
    cannons.length = 0;
    for (const c of chunks) c.life = 0;
    if (fieldPoints) {
      fieldPoints.geometry.dispose();
      fieldPoints = null;
    }
    restoreSurfaces();
    heldHole = null;
  }

  function makeBumper(spec: PropSpec): Bumper {
    const r = Math.max(0.5, spec.size?.x ?? 1.3);
    const group = new THREE.Group();
    group.position.set(spec.at.x, spec.at.y, 0);

    // A real extruded puck so the key light and the shadow map have something
    // to work with — this is the difference between "sticker" and "object".
    const body = new THREE.Mesh(discGeo, standard({
      color: 0x2a1520,
      roughness: 0.62,
      metalness: 0.1,
      emissive: new THREE.Color(C_BUMPER).multiplyScalar(0.18),
    }));
    body.scale.set(r, 1.05, r);
    body.rotation.x = Math.PI / 2;
    body.castShadow = shadows;

    const uHit = { value: 0 };
    const face = new THREE.Mesh(circGeo, shader(FRAG_BUMPER, {
      uHit,
      uColor: { value: new THREE.Color(C_BUMPER) },
      uHot: { value: new THREE.Color(C_BUMPER_HOT) },
    }, true));
    face.scale.setScalar(r * 1.02);
    face.position.z = 0.62;
    face.renderOrder = 3;

    const halo = new THREE.Mesh(quadGeo, shader(FRAG_BLOOM, {
      uCharge: uHit,
      uColor: { value: new THREE.Color(C_BUMPER) },
    }, true));
    halo.scale.setScalar(r * 4.2);
    halo.position.z = -0.5;
    halo.renderOrder = 1;

    group.add(halo, body, face);
    root.add(group);
    return { c: v2(spec.at.x, spec.at.y), r, power: spec.power ?? 19, group, uHit, hit: 0, nx: 0, ny: 1 };
  }

  function makeField(spec: PropSpec, kind: "fan" | "windZone"): Field {
    const a = spec.angle ?? 0;
    const hx = Math.max(0.4, spec.size?.x ?? 3);
    const hy = Math.max(0.4, spec.size?.y ?? 3);
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const ca = Math.abs(dx);
    const sa = Math.abs(dy);
    // Extent of the region measured along the blow direction, and across it.
    const halfLen = hx * ca + hy * sa;
    const halfWid = hx * sa + hy * ca;

    const group = new THREE.Group();
    group.position.set(spec.at.x, spec.at.y, 0);

    if (kind === "fan") {
      group.add(chevronQuad(a, halfLen, halfWid, C_FAN, Math.max(2, halfLen * 0.55), 0.55, 0.62, 0.16));
      // The throat: a bright bar at the upwind face, so the source is obvious
      // even when the emitter itself is buried in the rock it vents from.
      const mouth = new THREE.Mesh(quadGeo, shader(FRAG_BLOOM, {
        uCharge: { value: 0.55 },
        uColor: { value: new THREE.Color(C_FAN) },
      }, true));
      mouth.scale.set(halfWid * 2.4, halfWid * 2.4, 1);
      mouth.position.set(-dx * halfLen, -dy * halfLen, -0.1);
      mouth.renderOrder = 1;
      group.add(mouth);
    } else {
      // A gale gets the same arrows as a fan, but confined to a narrow band
      // through the middle of the region and dimmed right down. Stretching
      // them over the whole 40 m box turns them into light shafts, which is
      // both unreadable and a lie about where the wind is; the particles carry
      // the extent, the band only states the direction.
      const band = Math.min(halfWid, 3.4);
      const gust = chevronQuad(a, halfLen, band, C_WIND, Math.max(3, halfLen / 2.6), 0.3, 0.22, 0.2);
      gust.position.z = -1.4;
      gust.renderOrder = 0;
      group.add(gust);
    }
    root.add(group);

    return { kind, c: v2(spec.at.x, spec.at.y), hx, hy, dx, dy, power: spec.power ?? (kind === "fan" ? 32 : 11) };
  }

  function makeConveyor(spec: PropSpec): Conveyor {
    const hx = Math.max(0.5, spec.size?.x ?? 4);
    const top = spec.at.y;
    const dir = Math.cos(spec.angle ?? 0) >= 0 ? 1 : -1;
    const speed = Math.abs(spec.speed ?? 6);

    const group = new THREE.Group();
    group.position.set(spec.at.x, top, 0);

    const map = treadMap ? treadMap.clone() : null;
    if (map) {
      map.needsUpdate = true;
      map.wrapS = map.wrapT = THREE.RepeatWrapping;
      map.repeat.set(Math.max(1, Math.round(hx * 2 / 1.8)), 1);
      perHole.push(map);
    }
    // The belt band sits just proud of the slab the renderer already drew.
    const band = new THREE.Mesh(boxGeo, standard({
      color: 0xffffff,
      map: map ?? undefined,
      roughness: 0.72,
      metalness: 0.15,
      emissive: new THREE.Color(C_BELT).multiplyScalar(0.1),
    }));
    band.scale.set(hx * 2, 0.42, 2.4);
    band.position.set(0, -0.06, 0);
    band.castShadow = false;
    band.receiveShadow = shadows;

    const rollerMat = standard({ color: 0x3b4149, roughness: 0.4, metalness: 0.75 });
    const rollers: THREE.Object3D[] = [];
    for (const sx of [-1, 1]) {
      const roll = new THREE.Mesh(rollerGeo, rollerMat);
      roll.scale.set(0.42, 2.8, 0.42);
      roll.rotation.x = Math.PI / 2;
      roll.position.set(sx * (hx - 0.32), -0.22, 0);
      roll.castShadow = shadows;
      rollers.push(roll);
      group.add(roll);
    }

    // A single travelling chevron strip states the direction unambiguously.
    const arrow = chevronQuad(dir > 0 ? 0 : Math.PI, hx, 0.5, C_BELT, Math.max(2, hx * 0.5), 0.75, 0.55, 0.1);
    arrow.position.set(0, 0.5, 0.6);
    arrow.renderOrder = 3;

    group.add(band, arrow);
    root.add(group);
    return { c: v2(spec.at.x, top), hx, top, dir, speed, map, rollers };
  }

  function makeMover(spec: PropSpec): Mover | null {
    const raw = spec.path && spec.path.length >= 2 ? spec.path : null;
    const hx = Math.max(0.5, spec.size?.x ?? 3);
    const hy = Math.max(0.3, spec.size?.y ?? 0.8);
    // No path is a parked platform — still ours to draw and collide with.
    const path = raw ? raw.map((p) => v2(p.x, p.y)) : [v2(spec.at.x, spec.at.y)];

    const arc: number[] = [0];
    let total = 0;
    for (let i = 0; i < path.length; i++) {
      const a = path[i];
      const b = path[(i + 1) % path.length];
      total += Math.hypot(b.x - a.x, b.y - a.y);
      arc.push(total);
    }
    if (total < 1e-4) total = 1e-4;

    const group = new THREE.Group();

    const map = stripeMap ? stripeMap.clone() : null;
    if (map) {
      map.needsUpdate = true;
      map.wrapS = map.wrapT = THREE.RepeatWrapping;
      map.repeat.set(Math.max(1, Math.round(hx)), 1);
      perHole.push(map);
    }
    const deck = new THREE.Mesh(boxGeo, standard({
      color: 0xffffff,
      map: map ?? undefined,
      roughness: 0.55,
      metalness: 0.35,
    }));
    deck.scale.set(hx * 2, hy * 2, 2.4);
    deck.castShadow = shadows;
    deck.receiveShadow = shadows;

    // A teal lamp strip along the leading edge: the "powered" tell, and the
    // brightest thing on the platform so its top face is unmistakable.
    const lamp = new THREE.Mesh(quadGeo, shader(FRAG_BAR, {
      uGain: { value: 0.9 },
      uColor: { value: new THREE.Color(C_MOVER) },
    }, true));
    lamp.scale.set(hx * 2.02, 1.6, 1);
    lamp.position.set(0, hy, 1.3);
    lamp.renderOrder = 2;

    group.add(deck, lamp);
    root.add(group);

    // The rail the platform runs on, dotted so it never reads as solid.
    if (raw && total > 0.5) {
      const step = 1.1;
      const n = Math.max(2, Math.min(220, Math.floor(total / step)));
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const p = samplePath(path, arc, total, (i / n) * total);
        pos[i * 3] = p.x;
        pos[i * 3 + 1] = p.y;
        pos[i * 3 + 2] = -1.2;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const railMat = new THREE.PointsMaterial({
        color: C_MOVER,
        size: 2.6,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
      });
      perHole.push(railMat);
      const rail = new THREE.Points(geo, railMat);
      rail.renderOrder = 1;
      perHole.push({ dispose: () => geo.dispose() });
      root.add(rail);
    }

    const start = path[0];
    return {
      id: spec.id ?? `mover${movers.length}`,
      path, arc, total, s: 0,
      speed: Math.abs(spec.speed ?? 3.2),
      hx, hy,
      material: spec.material ?? "metal",
      cx: start.x, cy: start.y, ocx: start.x, ocy: start.y,
      vx: 0, vy: 0,
      carried: null,
      group,
      leg: 0,
    };
  }

  function makeBoost(spec: PropSpec): Boost {
    const a = spec.angle ?? 0;
    const hx = Math.max(0.5, spec.size?.x ?? 1.8);
    const hy = Math.max(0.3, spec.size?.y ?? 0.6);
    const group = new THREE.Group();
    group.position.set(spec.at.x, spec.at.y, 0);

    const map = stripeMap ? stripeMap.clone() : null;
    if (map) {
      map.needsUpdate = true;
      map.wrapS = map.wrapT = THREE.RepeatWrapping;
      map.repeat.set(Math.max(1, Math.round(hx * 1.2)), 1);
      perHole.push(map);
    }
    const plate = new THREE.Mesh(boxGeo, standard({
      color: 0xffffff,
      map: map ?? undefined,
      roughness: 0.5,
      metalness: 0.5,
      emissive: new THREE.Color(C_BOOST).multiplyScalar(0.18),
    }));
    plate.scale.set(hx * 2, hy * 1.3, 1.8);
    plate.castShadow = shadows;
    plate.receiveShadow = shadows;

    // A lit lip along the pad's face, so it never disappears into the terrain.
    const lip = new THREE.Mesh(quadGeo, shader(FRAG_BAR, {
      uGain: { value: 0.85 },
      uColor: { value: new THREE.Color(C_BOOST) },
    }, true));
    lip.scale.set(hx * 2.1, 1.5, 1);
    lip.position.set(0, hy * 0.7, 0.9);
    lip.renderOrder = 2;

    const uGain = { value: 1 };
    // The arrow is drawn along the launch axis rather than along the plate, so
    // a pad that throws you upward looks nothing like one that throws you on.
    const arrow = chevronQuad(a, hx * 1.5, hy * 1.6, C_BOOST, 3, 1.35, 1, 0.12, uGain);
    arrow.position.set(Math.cos(a) * hx * 1.2, Math.sin(a) * hx * 1.2 + hy, 0.8);
    arrow.renderOrder = 3;

    group.add(plate, lip, arrow);
    root.add(group);
    return {
      c: v2(spec.at.x, spec.at.y), hx, hy,
      dx: Math.cos(a), dy: Math.sin(a),
      power: spec.power ?? 24,
      group, flash: 0, uGain,
    };
  }

  function makeBreakable(spec: PropSpec): Breakable {
    const hx = Math.max(0.3, spec.size?.x ?? 2);
    const hy = Math.max(0.3, spec.size?.y ?? 2);
    const material = spec.material ?? "wood";
    const hard = material === "stone" || material === "metal";
    const group = new THREE.Group();
    group.position.set(spec.at.x, spec.at.y, 0);

    const map = panelMap ? panelMap.clone() : null;
    if (map) {
      map.needsUpdate = true;
      map.wrapS = map.wrapT = THREE.RepeatWrapping;
      map.repeat.set(Math.max(1, Math.round(hx * 0.7)), Math.max(1, Math.round(hy * 0.7)));
      perHole.push(map);
    }
    const slab = new THREE.Mesh(boxGeo, standard({
      color: hard ? 0x9aa3ad : 0xd8c0a0,
      map: map ?? undefined,
      roughness: hard ? 0.7 : 0.88,
      metalness: hard ? 0.3 : 0.02,
    }));
    slab.scale.set(hx * 2, hy * 2, 2.8);
    slab.castShadow = shadows;
    slab.receiveShadow = shadows;

    const uDamage = { value: 0.16 };
    const uFlash = { value: 0 };
    const cracks = new THREE.Mesh(quadGeo, shader(FRAG_CRACK, {
      uMap: { value: crackMap },
      uTile: {
        value: new THREE.Vector2(
          Math.max(1, Math.round(hx / 1.6)),
          Math.max(1, Math.round(hy / 1.6)),
        ),
      },
      uDamage,
      uFlash,
      uColor: { value: new THREE.Color(C_BREAK) },
    }, true));
    cracks.scale.set(hx * 2, hy * 2, 1);
    cracks.position.z = 1.45;
    cracks.renderOrder = 3;

    group.add(slab, cracks);
    root.add(group);

    const maxHp = hard ? 3 : 2;
    return {
      id: spec.id ?? `brk${breakables.length}`,
      c: v2(spec.at.x, spec.at.y), hx, hy, material,
      hp: maxHp, maxHp, alive: true,
      group, uDamage, uFlash, flash: 0,
    };
  }

  function makeCannon(spec: PropSpec): Cannon {
    const a = spec.angle ?? 0;
    const group = new THREE.Group();
    group.position.set(spec.at.x, spec.at.y, 0);

    // Bright enough to hold a silhouette against a dark canyon wall — a cannon
    // the player cannot find is a cannon that eats a stroke.
    const metal = standard({
      color: 0x76818f,
      roughness: 0.36,
      metalness: 0.85,
      emissive: new THREE.Color(C_CANNON).multiplyScalar(0.08),
    });
    const drum = new THREE.Mesh(drumGeo, metal);
    drum.rotation.x = Math.PI / 2;
    drum.castShadow = shadows;

    const uCharge = { value: 0 };

    // Amber collar around the breech: the "loaded and waiting" tell, and the
    // thing that reads at a glance from across the hole.
    const collar = new THREE.Mesh(circGeo, shader(FRAG_BUMPER, {
      uHit: uCharge,
      uColor: { value: new THREE.Color(C_CANNON) },
      uHot: { value: new THREE.Color(0xfff0c0) },
    }, true));
    collar.scale.setScalar(1.4);
    collar.position.z = 0.7;
    collar.renderOrder = 2;

    const pivot = new THREE.Group();
    const barrel = new THREE.Mesh(barrelGeo, metal);
    barrel.rotation.z = -Math.PI / 2;
    barrel.position.x = 1.25;
    barrel.castShadow = shadows;
    pivot.add(barrel);
    pivot.rotation.z = a;

    const muzzle = new THREE.Mesh(quadGeo, shader(FRAG_BLOOM, {
      uCharge,
      uColor: { value: new THREE.Color(C_CANNON) },
    }, true));
    muzzle.scale.setScalar(3.2);
    muzzle.position.set(Math.cos(a) * 2.5, Math.sin(a) * 2.5, 0.4);
    muzzle.renderOrder = 3;

    group.add(drum, collar, pivot, muzzle);
    root.add(group);

    return {
      id: spec.id ?? `cannon${cannons.length}`,
      c: v2(spec.at.x, spec.at.y), a,
      nx: Math.cos(a), ny: Math.sin(a),
      radius: Math.max(0.6, spec.size?.x ?? 1.5),
      power: spec.power ?? CANNON_POWER,
      held: null, hold: 0, kick: 0,
      group, pivot, uCharge,
    };
  }

  function build(hole: Hole | null): void {
    clear();
    if (!hole) return;
    heldHole = hole;

    const specs = hole.props ?? [];
    const claims: string[] = [];
    for (const spec of specs) {
      if (!spec || !spec.at) continue;
      switch (spec.kind) {
        case "bumper": bumpers.push(makeBumper(spec)); break;
        case "fan": fields.push(makeField(spec, "fan")); break;
        case "windZone": fields.push(makeField(spec, "windZone")); break;
        case "conveyor": conveyors.push(makeConveyor(spec)); break;
        case "boost": boosts.push(makeBoost(spec)); break;
        case "mover": {
          const m = makeMover(spec);
          if (m) { movers.push(m); if (spec.id) claims.push(spec.id); }
          break;
        }
        case "breakable": {
          breakables.push(makeBreakable(spec));
          if (spec.id) claims.push(spec.id);
          break;
        }
        case "cannon": if (ownsCannons) cannons.push(makeCannon(spec)); break;
        default: break;
      }
    }

    // Lift the slabs we now own. Highest index first so the earlier indices
    // stay valid while we splice, and so restore can simply walk backwards.
    const indices: number[] = [];
    for (const id of claims) {
      const i = hole.surfaces?.findIndex((s) => s.id === id) ?? -1;
      if (i >= 0) indices.push(i);
    }
    indices.sort((a, b) => b - a);
    for (const i of indices) {
      lifted.push({ list: hole.surfaces, surface: hole.surfaces[i], index: i });
      hole.surfaces.splice(i, 1);
    }
    // One rebuild, on load only. The course already called setHole with the
    // full list a moment ago; this replaces it with the list we actually want.
    if (indices.length) ctx.services.physics?.setHole(hole);

    // Park each mover on the first waypoint and snap its mesh there.
    for (const m of movers) {
      const p = samplePath(m.path, m.arc, m.total, 0);
      m.cx = m.ocx = p.x;
      m.cy = m.ocy = p.y;
      m.group.position.set(m.cx, m.cy, 0);
    }

    buildFieldParticles();
  }

  /** Position along a looped waypoint path at arc length `s`. */
  const pathOut = { x: 0, y: 0, dx: 1, dy: 0 };
  function samplePath(path: Vec2[], arc: number[], total: number, s: number): typeof pathOut {
    if (path.length < 2) {
      pathOut.x = path[0]?.x ?? 0;
      pathOut.y = path[0]?.y ?? 0;
      pathOut.dx = 0;
      pathOut.dy = 0;
      return pathOut;
    }
    let d = s % total;
    if (d < 0) d += total;
    let i = 0;
    while (i < arc.length - 2 && arc[i + 1] <= d) i++;
    const a = path[i];
    const b = path[(i + 1) % path.length];
    const segLen = Math.max(1e-6, arc[i + 1] - arc[i]);
    const u = (d - arc[i]) / segLen;
    pathOut.x = a.x + (b.x - a.x) * u;
    pathOut.y = a.y + (b.y - a.y) * u;
    pathOut.dx = (b.x - a.x) / segLen;
    pathOut.dy = (b.y - a.y) / segLen;
    return pathOut;
  }

  /** One Points cloud for every fan and wind zone on the hole. */
  function buildFieldParticles(): void {
    const budget = FIELD_BUDGET[quality] ?? 0;
    if (budget <= 0 || fields.length === 0) return;

    // Share the budget by area so a 40 m gale isn't as sparse as a 6 m vent.
    let area = 0;
    for (const f of fields) area += Math.sqrt(f.hx * f.hy);
    const counts = fields.map((f) => Math.max(6, Math.round((Math.sqrt(f.hx * f.hy) / area) * budget)));
    const total = counts.reduce((a, b) => a + b, 0);

    const pos = new Float32Array(total * 3);
    const fieldA = new Float32Array(total * 4);
    const extra = new Float32Array(total * 2);
    const cols = new Float32Array(total * 3);

    let k = 0;
    fields.forEach((f, fi) => {
      const a = Math.atan2(f.dy, f.dx);
      const ca = Math.abs(f.dx);
      const sa = Math.abs(f.dy);
      const halfLen = f.hx * ca + f.hy * sa;
      const halfWid = f.hx * sa + f.hy * ca;
      const fan = f.kind === "fan";
      tmpColor.setHex(fan ? C_FAN : C_WIND);
      // Life is time-to-cross: fast fans stream, wind zones drift.
      const life = Math.max(0.5, (halfLen * 2) / Math.max(2, f.power * (fan ? 0.6 : 0.28)));
      for (let i = 0; i < counts[fi]; i++, k++) {
        pos[k * 3] = f.c.x;
        pos[k * 3 + 1] = f.c.y;
        pos[k * 3 + 2] = ctx.rng() * 997;
        fieldA[k * 4] = a;
        fieldA[k * 4 + 1] = halfLen;
        fieldA[k * 4 + 2] = halfWid;
        fieldA[k * 4 + 3] = life * (0.75 + ctx.rng() * 0.5);
        extra[k * 2] = fan ? 0.16 + ctx.rng() * 0.1 : 0.12 + ctx.rng() * 0.09;
        extra[k * 2 + 1] = fan ? 0.95 : 0.72;
        cols[k * 3] = tmpColor.r;
        cols[k * 3 + 1] = tmpColor.g;
        cols[k * 3 + 2] = tmpColor.b;
      }
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aField", new THREE.BufferAttribute(fieldA, 4));
    geo.setAttribute("aExtra", new THREE.BufferAttribute(extra, 2));
    geo.setAttribute("aColor", new THREE.BufferAttribute(cols, 3));
    // Vertices are region centres, not particle positions — skip culling.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT_FIELD,
      fragmentShader: FRAG_FIELD,
      uniforms: { uTime, uPix },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    perHole.push(mat);
    perHole.push({ dispose: () => geo.dispose() });

    fieldPoints = new THREE.Points(geo, mat);
    fieldPoints.frustumCulled = false;
    fieldPoints.position.z = 0.5;
    fieldPoints.renderOrder = 4;
    root.add(fieldPoints);
  }

  // --- Collision -----------------------------------------------------------

  /** Contact report from `collideBox`, reused to stay allocation-free. */
  const contact = { nx: 0, ny: 0, speed: 0 };

  /**
   * Swept ball-versus-moving-AABB, with the same restitution / rolling /
   * friction model the solver uses so a mover feels like the ground does.
   *
   * The test runs in the box's frame — the ball's motion is measured against
   * the box's own — which is what makes a platform that moves *into* the ball
   * push it rather than swallow it. Returns true on contact and leaves the
   * normal in `contact`.
   */
  function collideBox(
    b: BallState, prevX: number, prevY: number,
    cx: number, cy: number, ocx: number, ocy: number,
    hx: number, hy: number, pvx: number, pvy: number,
    material: SurfaceMaterial, dt: number,
  ): boolean {
    const r = b.radius;
    const ex = hx + r;
    const ey = hy + r;
    let lx = b.pos.x - cx;
    let ly = b.pos.y - cy;
    let nx = 0;
    let ny = 0;

    if (Math.abs(lx) < ex && Math.abs(ly) < ey) {
      // Overlapping now: push out along the axis of least penetration.
      const px = ex - Math.abs(lx);
      const py = ey - Math.abs(ly);
      if (px < py) {
        nx = lx >= 0 ? 1 : -1;
        lx = nx * (ex + SKIN);
      } else {
        ny = ly >= 0 ? 1 : -1;
        ly = ny * (ey + SKIN);
      }
    } else {
      // Clear now — but it may have passed straight through this frame.
      const sx = prevX - ocx;
      const sy = prevY - ocy;
      const dx = lx - sx;
      const dy = ly - sy;
      let tEnter = 0;
      let tExit = 1;
      let axis = -1;
      let sgn = 0;

      if (Math.abs(dx) < 1e-9) {
        if (Math.abs(sx) > ex) return false;
      } else {
        const t1 = (-ex - sx) / dx;
        const t2 = (ex - sx) / dx;
        const lo = Math.min(t1, t2);
        const hi = Math.max(t1, t2);
        if (lo > tEnter) { tEnter = lo; axis = 0; sgn = t1 < t2 ? -1 : 1; }
        if (hi < tExit) tExit = hi;
      }
      if (Math.abs(dy) < 1e-9) {
        if (Math.abs(sy) > ey) return false;
      } else {
        const t1 = (-ey - sy) / dy;
        const t2 = (ey - sy) / dy;
        const lo = Math.min(t1, t2);
        const hi = Math.max(t1, t2);
        if (lo > tEnter) { tEnter = lo; axis = 1; sgn = t1 < t2 ? -1 : 1; }
        if (hi < tExit) tExit = hi;
      }
      if (axis < 0 || tEnter > tExit || tEnter > 1 || tExit < 0) return false;

      lx = sx + dx * tEnter;
      ly = sy + dy * tEnter;
      if (axis === 0) { nx = sgn; lx = nx * (ex + SKIN); }
      else { ny = sgn; ly = ny * (ey + SKIN); }
    }

    b.pos.x = cx + lx;
    b.pos.y = cy + ly;

    // Response in the box's frame, then hand the box's velocity back so the
    // ball inherits the ride.
    const props = BALL_TYPES[b.type] ?? BALL_TYPES.standard;
    const mat = MATERIALS[material] ?? MATERIALS.stone;
    const rvx = b.vel.x - pvx;
    const rvy = b.vel.y - pvy;
    const vn = rvx * nx + rvy * ny;
    const tx = -ny;
    const ty = nx;
    let vt = rvx * tx + rvy * ty;
    let newVn = vn;

    if (vn < 0) {
      const speedIn = -vn;
      const rolling = speedIn < ROLL_REL;
      newVn = rolling ? 0 : speedIn * Math.min(0.95, mat.restitution * props.bounce);
      const surfaceSpeed = vt - b.spin * b.radius;
      const fr = Math.min(1, mat.friction * (rolling ? 0.5 : 1));
      const dvt = -surfaceSpeed * fr;
      vt += dvt;
      b.spin -= (dvt / b.radius) * 0.55;
      if (rolling) {
        const decel = mat.rollDrag * 9.81 * dt;
        vt = Math.abs(vt) <= decel ? 0 : vt - Math.sign(vt) * decel;
      }
      contact.speed = speedIn;
    } else {
      contact.speed = 0;
    }

    b.vel.x = pvx + nx * newVn + tx * vt;
    b.vel.y = pvy + ny * newVn + ty * vt;
    contact.nx = nx;
    contact.ny = ny;
    return true;
  }

  /** Swept circle-versus-circle. Returns the entry fraction, or -1. */
  function sweepCircle(
    prevX: number, prevY: number, x: number, y: number,
    cx: number, cy: number, R: number,
  ): number {
    const sx = prevX - cx;
    const sy = prevY - cy;
    const cq = sx * sx + sy * sy - R * R;
    if (cq <= 0) return 0;
    const dx = x - prevX;
    const dy = y - prevY;
    const a = dx * dx + dy * dy;
    if (a < 1e-12) return -1;
    const bq = 2 * (sx * dx + sy * dy);
    const disc = bq * bq - 4 * a * cq;
    if (disc < 0) return -1;
    const t = (-bq - Math.sqrt(disc)) / (2 * a);
    return t >= 0 && t <= 1 ? t : -1;
  }

  // --- Debris --------------------------------------------------------------

  function spawnDebris(cx: number, cy: number, hx: number, hy: number, color: number, n: number): void {
    let spawned = 0;
    for (let i = 0; i < DEBRIS_MAX && spawned < n; i++) {
      const c = chunks[i];
      if (c.life > 0) continue;
      c.x = cx + (ctx.rng() * 2 - 1) * hx;
      c.y = cy + (ctx.rng() * 2 - 1) * hy;
      const a = ctx.rng() * 6.2832;
      const sp = 3 + ctx.rng() * 11;
      c.vx = Math.cos(a) * sp;
      c.vy = Math.abs(Math.sin(a)) * sp * 0.9 + 2;
      c.rot = ctx.rng() * 6.2832;
      c.spin = (ctx.rng() - 0.5) * 14;
      c.size = 0.28 + ctx.rng() * Math.min(0.85, Math.min(hx, hy) * 0.7);
      c.maxLife = 1.1 + ctx.rng() * 0.9;
      c.life = c.maxLife;
      tmpColor.setHex(color).multiplyScalar(0.6 + ctx.rng() * 0.6);
      debris.setColorAt(i, tmpColor);
      spawned++;
    }
    if (debris.instanceColor) debris.instanceColor.needsUpdate = true;
  }

  function stepDebris(dt: number): void {
    // The pool is idle almost all the time; don't rewrite 44 matrices for it.
    if (!debris.visible) {
      let pending = false;
      for (let i = 0; i < DEBRIS_MAX && !pending; i++) pending = chunks[i].life > 0;
      if (!pending) return;
    }
    let any = false;
    for (let i = 0; i < DEBRIS_MAX; i++) {
      const c = chunks[i];
      if (c.life <= 0) {
        dummy.position.set(0, 0, -9999);
        dummy.scale.setScalar(0.0001);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        debris.setMatrixAt(i, dummy.matrix);
        continue;
      }
      any = true;
      c.life -= dt;
      c.vy -= 26 * dt;
      c.vx *= 1 - Math.min(0.5, 0.9 * dt);
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.rot += c.spin * dt;
      const k = Math.max(0, c.life / c.maxLife);
      dummy.position.set(c.x, c.y, 0.8);
      dummy.rotation.set(0, 0, c.rot);
      dummy.scale.setScalar(c.size * (0.35 + k * 0.65));
      dummy.updateMatrix();
      debris.setMatrixAt(i, dummy.matrix);
    }
    debris.instanceMatrix.needsUpdate = true;
    debrisMat.opacity = any ? 1 : 0;
    debris.visible = any;
  }

  // --- Prop behaviour ------------------------------------------------------

  function hitBumper(bp: Bumper, b: BallState, t: Track): void {
    const R = bp.r + b.radius;
    const u = sweepCircle(t.px, t.py, b.pos.x, b.pos.y, bp.c.x, bp.c.y, R);
    if (u < 0) return;

    const hx = t.px + (b.pos.x - t.px) * u;
    const hy = t.py + (b.pos.y - t.py) * u;
    let nx = hx - bp.c.x;
    let ny = hy - bp.c.y;
    const d = Math.hypot(nx, ny);
    if (d < 1e-6) {
      // Dead centre: kick it the way it was already going.
      const sp = Math.hypot(b.vel.x, b.vel.y) || 1;
      nx = b.vel.x / sp;
      ny = b.vel.y / sp;
    } else {
      nx /= d;
      ny /= d;
    }

    const speed = Math.hypot(b.vel.x, b.vel.y);
    const out = Math.min(BUMPER_MAX, Math.max(bp.power, speed * BUMPER_GAIN));
    // Keep a sliver of the tangential motion so a glancing hit still glances.
    const tx = -ny;
    const ty = nx;
    const vt = (b.vel.x * tx + b.vel.y * ty) * 0.3;

    b.pos.x = bp.c.x + nx * (R + SKIN);
    b.pos.y = bp.c.y + ny * (R + SKIN);
    b.vel.x = nx * out + tx * vt;
    b.vel.y = ny * out + ty * vt;
    b.spin += (ctx.rng() - 0.5) * 6 - nx * 3;
    b.resting = false;
    b.restTimer = 0;
    b.stuck = false;
    t.px = b.pos.x;
    t.py = b.pos.y;
    t.bumpT = BUMPER_COOLDOWN;

    bp.hit = 1;
    bp.nx = nx;
    bp.ny = ny;
    const vfx = ctx.services.vfx;
    vfx?.ring(v2(bp.c.x, bp.c.y), bp.r * 1.6, C_BUMPER);
    vfx?.burst(v2(hx, hy), 16, { color: C_BUMPER_HOT, speed: 6 + out * 0.2, spread: 1.5, life: 0.35 });
    vfx?.screenShake(0.12 + Math.min(0.2, out * 0.004));
    ctx.services.audio?.play("bumper", {
      volume: 0.5 + Math.min(0.45, out * 0.008),
      rate: 0.92 + ctx.rng() * 0.2,
      pan: panAt(bp.c.x),
    });
    ctx.emit("golf:bumper", { at: { x: bp.c.x, y: bp.c.y }, speed: out });
  }

  function hitBoost(bo: Boost, b: BallState, t: Track): void {
    const speed = Math.hypot(b.vel.x, b.vel.y);
    if (speed < BOOST_MIN_SPEED) return;
    const R = b.radius;
    // Sample the frame's motion so a fast ball can't skip over the pad.
    const steps = Math.min(8, 1 + Math.ceil(Math.hypot(b.pos.x - t.px, b.pos.y - t.py) / 0.6));
    let inside = false;
    for (let i = 0; i <= steps && !inside; i++) {
      const u = i / steps;
      const x = t.px + (b.pos.x - t.px) * u;
      const y = t.py + (b.pos.y - t.py) * u;
      inside = Math.abs(x - bo.c.x) <= bo.hx + R && Math.abs(y - bo.c.y) <= bo.hy + R;
    }
    if (!inside) return;

    const out = Math.max(bo.power, speed * BOOST_GAIN);
    b.vel.x = bo.dx * out;
    b.vel.y = bo.dy * out;
    b.spin = -bo.dx * 7;
    b.resting = false;
    b.restTimer = 0;
    b.stuck = false;
    t.boostT = BOOST_COOLDOWN;

    bo.flash = 1;
    const vfx = ctx.services.vfx;
    vfx?.burst(v2(b.pos.x, b.pos.y), 14, { color: C_BOOST, speed: out * 0.35, spread: 0.5, life: 0.32 });
    vfx?.ring(v2(bo.c.x, bo.c.y), 1.8, C_BOOST);
    vfx?.screenShake(0.1);
    ctx.services.audio?.play("boost", { volume: 0.65, rate: 0.95 + ctx.rng() * 0.15, pan: panAt(bo.c.x) });
    ctx.emit("golf:boost", { at: { x: bo.c.x, y: bo.c.y }, speed: out });
  }

  function damageFor(speed: number, b: BallState): number {
    const props = BALL_TYPES[b.type] ?? BALL_TYPES.standard;
    if (props.ghost) return 0;
    if (b.type === "nitro") return 99;
    if (speed < BREAK_MIN_SPEED) return 0;
    if (speed < 18) return 1;
    if (speed < 30) return 2;
    return 3;
  }

  function shatter(br: Breakable): void {
    br.alive = false;
    br.group.visible = false;
    // Give the collider back to nobody: the surface stays lifted, so nothing
    // in the broadphase or the renderer refers to it any more.
    const col = br.material === "stone" || br.material === "metal" ? 0x9aa3ad : 0xc79a63;
    spawnDebris(br.c.x, br.c.y, br.hx, br.hy, col, 16);
    const vfx = ctx.services.vfx;
    vfx?.burst(v2(br.c.x, br.c.y), 26, { color: C_BREAK, speed: 11, spread: Math.PI * 2, life: 0.5 });
    vfx?.ring(v2(br.c.x, br.c.y), Math.max(br.hx, br.hy) * 1.6, C_BREAK);
    vfx?.screenShake(0.36);
    ctx.services.audio?.play("shatter", { volume: 0.85, pan: panAt(br.c.x) });
    ctx.emit("golf:break", { id: br.id, at: { x: br.c.x, y: br.c.y } });
  }

  function fireCannon(cn: Cannon): void {
    const b = cn.held;
    cn.held = null;
    cn.hold = 0;
    cn.kick = 1;
    if (!b || !b.active) return;

    b.stuck = false;
    b.resting = false;
    b.restTimer = 0;
    b.vel.x = cn.nx * cn.power;
    b.vel.y = cn.ny * cn.power;
    b.spin = -cn.nx * 6;
    b.pos.x = cn.c.x + cn.nx * (b.radius + 2.4);
    b.pos.y = cn.c.y + cn.ny * (b.radius + 2.4);
    b.trail.length = 0;

    const t = track(b);
    t.px = b.pos.x;
    t.py = b.pos.y;
    t.cannonBlock = cn.id;
    t.cannonT = CANNON_RECHARGE;

    const vfx = ctx.services.vfx;
    vfx?.burst(v2(b.pos.x, b.pos.y), 24, { color: C_CANNON, speed: 14, spread: 0.85, life: 0.42 });
    vfx?.ring(v2(cn.c.x, cn.c.y), 2.2, C_CANNON);
    vfx?.screenShake(0.34);
    ctx.services.audio?.play("cannon", { volume: 0.85, pan: panAt(cn.c.x) });
    ctx.emit("golf:cannon", { id: cn.id, at: { x: b.pos.x, y: b.pos.y }, power: cn.power });
  }

  function tryCapture(cn: Cannon, b: BallState, t: Track): boolean {
    if (cn.held || b.stuck) return false;
    if (t.cannonBlock === cn.id && t.cannonT > 0) return false;
    if (sweepCircle(t.px, t.py, b.pos.x, b.pos.y, cn.c.x, cn.c.y, cn.radius + b.radius) < 0) return false;

    cn.held = b;
    cn.hold = CANNON_HOLD;
    b.vel.x = 0;
    b.vel.y = 0;
    b.spin = 0;
    b.pos.x = cn.c.x;
    b.pos.y = cn.c.y;
    b.resting = false;
    b.restTimer = 0;
    // Freezing via `stuck` is what stops the solver advancing a loaded ball.
    b.stuck = true;
    b.trail.length = 0;
    t.px = b.pos.x;
    t.py = b.pos.y;
    ctx.services.audio?.play("cannonLoad", { volume: 0.5, pan: panAt(cn.c.x) });
    ctx.services.vfx?.burst(v2(cn.c.x, cn.c.y), 10, { color: C_CANNON, speed: 4, spread: Math.PI * 2, life: 0.3 });
    return true;
  }

  /** Release a ball this platform was carrying, handing it the platform's ride. */
  function dropCarried(m: Mover, fling: boolean): void {
    const b = m.carried;
    m.carried = null;
    if (!b || !b.active) return;
    b.stuck = false;
    b.resting = false;
    b.restTimer = 0;
    if (fling) {
      b.vel.x = m.vx;
      b.vel.y = m.vy;
    }
    const t = tracks.get(b);
    if (t) {
      t.px = b.pos.x;
      t.py = b.pos.y;
    }
  }

  // --- Wiring --------------------------------------------------------------

  const offHole = ctx.on("golf:hole", (payload) => {
    const p = payload as { hole?: Hole } | undefined;
    try {
      build(p?.hole ?? null);
    } catch (err) {
      console.error("[golf/hazards] hole build failed", err);
    }
  });

  /**
   * The rules layer replays a lost ball from the lie the shot was struck from.
   * If that lie was a moving platform the platform is somewhere else by now,
   * and the drop is into thin air — over Cinder Rise's lava that would replay
   * the penalty forever. Slide the platform back under the drop instead.
   */
  const offPenalty = ctx.on("golf:penalty", () => {
    const b = ctx.services.physics?.balls.find((x) => x.active);
    if (!b) return;
    for (const m of movers) {
      if (m.path.length < 2) continue;
      const steps = Math.max(8, Math.min(400, Math.ceil(m.total / 0.35)));
      let bestS = -1;
      let bestD = Infinity;
      for (let i = 0; i <= steps; i++) {
        const s = (i / steps) * m.total;
        const p = samplePath(m.path, m.arc, m.total, s);
        const dx = Math.abs(p.x - b.pos.x);
        const dy = Math.abs(p.y + m.hy + b.radius - b.pos.y);
        if (dx > m.hx + 0.6 || dy > 1.4) continue;
        const d = dx + dy;
        if (d < bestD) { bestD = d; bestS = s; }
      }
      if (bestS < 0) continue;
      m.s = bestS;
      const p = samplePath(m.path, m.arc, m.total, m.s);
      m.cx = m.ocx = p.x;
      m.cy = m.ocy = p.y;
      m.vx = 0;
      m.vy = 0;
      m.leg = legIndex(m);
      m.group.position.set(m.cx, m.cy, 0);
    }
  });

  let seenHole: Hole | null = null;

  const sys: System = {
    name: "hazards",

    update(dt) {
      // Cold-start guard: the course loads its first hole from its own update,
      // so if we ever boot after that event we still pick the hole up.
      const current = ctx.services.course?.current ?? null;
      if (current !== seenHole) {
        if (current && current !== heldHole) build(current);
        seenHole = current;
      }

      const phys = ctx.services.physics;
      if (!phys) return;
      const balls = phys.balls;

      // 1. Advance the platforms. Everything below resolves against where they
      //    are *now*, having remembered where they were a frame ago.
      for (const m of movers) {
        m.ocx = m.cx;
        m.ocy = m.cy;
        if (m.path.length >= 2 && m.speed > 0) {
          // Ease through the waypoints so a reversal is a decelerate-and-go
          // rather than an instant flip of the ride the ball is standing on.
          const legEnd = m.arc[Math.min(m.arc.length - 1, legIndex(m) + 1)];
          const toEnd = Math.max(0, legEnd - (m.s % m.total));
          const fromStart = Math.max(0, (m.s % m.total) - m.arc[legIndex(m)]);
          const ease = Math.min(1, Math.min(toEnd, fromStart) / 0.7) * 0.65 + 0.35;
          m.s += m.speed * ease * dt;
          const p = samplePath(m.path, m.arc, m.total, m.s);
          m.cx = p.x;
          m.cy = p.y;
          const leg = legIndex(m);
          if (leg !== m.leg) {
            m.leg = leg;
            ctx.services.audio?.play("platformClank", { volume: 0.3, pan: panAt(m.cx) });
            ctx.emit("golf:mover", { id: m.id, at: { x: m.cx, y: m.cy } });
          }
        }
        m.vx = (m.cx - m.ocx) / Math.max(1e-5, dt);
        m.vy = (m.cy - m.ocy) / Math.max(1e-5, dt);
        m.group.position.set(m.cx, m.cy, 0);
      }

      // 2. Carried balls ride positionally, frozen, so the settle test in the
      //    solver never fights us and the player can putt from a moving deck.
      for (const m of movers) {
        const b = m.carried;
        if (!b) continue;
        if (!b.active || balls.indexOf(b) < 0) {
          m.carried = null;
          continue;
        }
        b.pos.x += m.cx - m.ocx;
        b.pos.y = m.cy + m.hy + b.radius + SKIN;
        if (Math.abs(b.pos.x - m.cx) > m.hx + b.radius * 0.9) {
          dropCarried(m, true);
          continue;
        }
        b.vel.x = 0;
        b.vel.y = 0;
        b.spin *= 0.9;
        b.stuck = true;
        b.resting = true;
        b.restTimer = 1;
        const t = track(b);
        t.px = b.pos.x;
        t.py = b.pos.y;
      }

      // 3. Everything that acts on a live ball.
      for (const b of balls) {
        if (!b.active) continue;
        const t = track(b);
        const x0 = t.px;
        const y0 = t.py;
        const props = BALL_TYPES[b.type] ?? BALL_TYPES.standard;

        if (t.bumpT > 0) t.bumpT -= dt;
        if (t.boostT > 0) t.boostT -= dt;
        if (t.cannonT > 0) t.cannonT -= dt;
        if (t.cannonT <= 0) t.cannonBlock = null;

        // A hazard reset or a power-up drop moves the ball without flying it
        // there; the line between the two lies is not a trajectory.
        const warped = Math.hypot(b.pos.x - x0, b.pos.y - y0) > WARP_DIST;
        const carried = movers.some((m) => m.carried === b);
        /** Set when a collider we own is holding the ball up this frame. */
        let onOurBox = false;

        if (!carried && !b.stuck) {
          // --- Movers ----------------------------------------------------
          // A phasing ghost passes through our colliders exactly as it passes
          // through the solver's — anything else and the power-up lies.
          for (const m of props.ghost ? [] : movers) {
            if (m.carried) continue;
            if (collideBox(b, warped ? b.pos.x : x0, warped ? b.pos.y : y0,
              m.cx, m.cy, warped ? m.cx : m.ocx, warped ? m.cy : m.ocy,
              m.hx, m.hy, m.vx, m.vy, m.material, dt)) {
              b.restTimer = 0;
              const relx = b.vel.x - m.vx;
              const rely = b.vel.y - m.vy;
              if (contact.ny > 0.55 && Math.hypot(relx, rely) < CARRY_SPEED) {
                m.carried = b;
                b.pos.y = m.cy + m.hy + b.radius + SKIN;
                b.vel.x = 0;
                b.vel.y = 0;
                b.stuck = true;
                b.resting = true;
                b.restTimer = 1;
              } else if (contact.speed > 4) {
                ctx.services.vfx?.trailPuff(v2(b.pos.x, b.pos.y), C_MOVER);
                ctx.services.audio?.play("platformClank", {
                  volume: Math.min(0.5, 0.15 + contact.speed * 0.012),
                  pan: panAt(b.pos.x),
                });
              }
            }
          }

          // --- Breakables -------------------------------------------------
          if (!props.ghost) {
            for (const br of breakables) {
              if (!br.alive) continue;
              const vx0 = b.vel.x;
              const vy0 = b.vel.y;
              const px0 = b.pos.x;
              const py0 = b.pos.y;
              if (!collideBox(b, warped ? b.pos.x : x0, warped ? b.pos.y : y0,
                br.c.x, br.c.y, br.c.x, br.c.y, br.hx, br.hy, 0, 0, br.material, dt)) continue;
              if (contact.ny > 0.55 && Math.hypot(b.vel.x, b.vel.y) < 0.42) onOurBox = true;
              const dmg = damageFor(contact.speed, b);
              if (dmg <= 0) continue;
              br.hp -= dmg;
              br.flash = 1;
              br.uDamage.value = Math.min(1, 0.16 + (1 - br.hp / br.maxHp) * 0.9);
              if (br.hp > 0) {
                spawnDebris(
                  b.pos.x - contact.nx * 0.4, b.pos.y - contact.ny * 0.4,
                  0.4, 0.4, C_BREAK, 4,
                );
                ctx.services.vfx?.burst(v2(b.pos.x, b.pos.y), 10, {
                  color: C_BREAK, speed: 7, spread: 2.2, life: 0.3,
                });
                ctx.services.audio?.play("breakHit", {
                  volume: 0.5, rate: 0.9 + ctx.rng() * 0.25, pan: panAt(br.c.x),
                });
              } else {
                // The blow that kills it should feel like a punch-through, not
                // a bounce off something that then politely vanishes.
                shatter(br);
                b.pos.x = px0;
                b.pos.y = py0;
                b.vel.x = vx0 * BREAK_PUNCH;
                b.vel.y = vy0 * BREAK_PUNCH;
                b.resting = false;
                b.restTimer = 0;
              }
            }
          }

          // --- Bumpers ----------------------------------------------------
          if (t.bumpT <= 0 && !warped && !props.ghost) {
            for (const bp of bumpers) {
              hitBumper(bp, b, t);
              if (t.bumpT > 0) break;
            }
          }

          // --- Boost pads --------------------------------------------------
          if (t.boostT <= 0 && !warped) {
            for (const bo of boosts) {
              hitBoost(bo, b, t);
              if (t.boostT > 0) break;
            }
          }

          // --- Cannons ------------------------------------------------------
          if (!warped) {
            for (const cn of cannons) {
              if (tryCapture(cn, b, t)) break;
            }
          }
        }

        // Our own settle test, for balls the broadphase cannot support.
        t.boxRest = onOurBox ? t.boxRest + dt : 0;
        if (t.boxRest >= 0.28) {
          b.vel.x = 0;
          b.vel.y = 0;
          b.spin = 0;
          b.resting = true;
        }

        if (b.stuck || carried || movers.some((m) => m.carried === b)) {
          t.px = b.pos.x;
          t.py = b.pos.y;
          continue;
        }

        // --- Fields and belts ---------------------------------------------
        // One support probe per ball, shared by every field on the hole: a
        // ball that is slow AND touching something must always be allowed to
        // settle, or a fan column becomes a place the game can never leave.
        const speed = Math.hypot(b.vel.x, b.vel.y);
        let supported = false;
        if (speed < FIELD_SETTLE_SPEED || conveyors.length) {
          const sup = phys.probe(b.pos, b.radius + 0.12);
          supported = Boolean(sup && sup.normal.y > 0.25);
        }
        const settling = b.resting || (speed < FIELD_SETTLE_SPEED && supported);

        if (!settling) {
          let inAny = false;
          for (const f of fields) {
            const ddx = b.pos.x - f.c.x;
            const ddy = b.pos.y - f.c.y;
            if (Math.abs(ddx) > f.hx + b.radius || Math.abs(ddy) > f.hy + b.radius) continue;
            // Soften the boundary so the field never snaps on.
            const fx = Math.min(1, (f.hx + b.radius - Math.abs(ddx)) / 1.2);
            const fy = Math.min(1, (f.hy + b.radius - Math.abs(ddy)) / 1.2);
            const k = Math.max(0, Math.min(fx, fy));
            const gain = f.kind === "fan" ? FAN_GAIN : WIND_GAIN * (props.drag > 1.3 ? 0.15 : 1);
            const acc = f.power * gain * k * dt;
            b.vel.x += f.dx * acc;
            b.vel.y += f.dy * acc;
            b.restTimer = 0;
            inAny = true;
          }
          if (inAny && !t.fieldIn) {
            ctx.services.audio?.play("fanWhoosh", { volume: 0.4, pan: panAt(b.pos.x) });
          }
          t.fieldIn = inAny;
        } else {
          t.fieldIn = false;
        }

        for (const cv of conveyors) {
          if (Math.abs(b.pos.x - cv.c.x) > cv.hx + b.radius) continue;
          const dy = b.pos.y - cv.top;
          if (dy < -0.35 || dy > b.radius + 0.5) continue;
          if (!supported) continue;
          // Stall cut-out: a belt that has been shoving a wedged ball for over
          // a second lets go, so the ball can settle and the hole can end.
          const moving = Math.hypot(b.vel.x, b.vel.y) > 0.7;
          t.beltStall = moving ? 0 : t.beltStall + dt;
          if (t.beltStall > BELT_STALL) continue;
          const target = cv.dir * cv.speed;
          const acc = Math.max(-BELT_MAX_ACCEL, Math.min(BELT_MAX_ACCEL, (target - b.vel.x) * BELT_GAIN));
          b.vel.x += acc * dt;
          b.spin -= (acc * dt) / b.radius * 0.4;
          if (Math.abs(b.vel.x) > 0.6) {
            b.resting = false;
            b.restTimer = 0;
          }
        }

        t.px = b.pos.x;
        t.py = b.pos.y;
      }

      // 4. Cannon countdowns.
      for (const cn of cannons) {
        if (cn.held) {
          if (!cn.held.active || balls.indexOf(cn.held) < 0) {
            cn.held = null;
            cn.hold = 0;
          } else {
            cn.held.pos.x = cn.c.x;
            cn.held.pos.y = cn.c.y;
            cn.hold -= dt;
            cn.uCharge.value = 1 - Math.max(0, cn.hold) / CANNON_HOLD;
            if (cn.hold <= 0) fireCannon(cn);
          }
        } else if (cn.kick > 0) {
          cn.kick = Math.max(0, cn.kick - dt * 4.5);
          cn.uCharge.value = cn.kick * 0.8;
        } else {
          cn.uCharge.value = 0;
        }
      }

      stepDebris(dt);
    },

    lateUpdate(dt) {
      uTime.value = ctx.elapsed;

      // Point sprites are sized in pixels, so they need the current metres-to-
      // pixels scale or they bloat when the camera pulls back.
      if (fieldPoints) {
        ctx.renderer.getDrawingBufferSize(drawSize);
        const span = Math.max(1e-3, ctx.camera.top - ctx.camera.bottom);
        uPix.value = drawSize.y / span;
      }

      for (const bp of bumpers) {
        if (bp.hit > 0) bp.hit = Math.max(0, bp.hit - dt * 3.6);
        bp.uHit.value = bp.hit;
        // Squash along the contact normal, stretch across it — the classic
        // read, and the reason a bumper feels like it *threw* the ball.
        const sq = bp.hit * bp.hit;
        bp.group.rotation.z = Math.atan2(bp.ny, bp.nx);
        bp.group.scale.set(1 - sq * 0.3, 1 + sq * 0.26, 1);
      }

      for (const cv of conveyors) {
        if (cv.map) cv.map.offset.x -= cv.dir * cv.speed * dt * 0.28;
        for (const r of cv.rollers) r.rotation.y -= cv.dir * cv.speed * dt * 1.6;
      }

      for (const bo of boosts) {
        if (bo.flash > 0) bo.flash = Math.max(0, bo.flash - dt * 3);
        bo.uGain.value = 1 + bo.flash * 2.6;
        bo.group.scale.setScalar(1 + bo.flash * 0.12);
      }

      for (const br of breakables) {
        if (!br.alive) continue;
        if (br.flash > 0) br.flash = Math.max(0, br.flash - dt * 3.4);
        br.uFlash.value = br.flash;
        // A struck slab shivers; an idle one is dead still, so movement always
        // means "you just did that".
        const j = br.flash * 0.16;
        br.group.position.set(
          br.c.x + (ctx.rng() - 0.5) * j,
          br.c.y + (ctx.rng() - 0.5) * j,
          0,
        );
      }

      for (const cn of cannons) {
        const back = cn.kick * cn.kick * 0.55;
        cn.pivot.position.set(-cn.nx * back, -cn.ny * back, 0);
      }
    },

    dispose() {
      offHole();
      offPenalty();
      clear();
      ctx.scene.remove(root);
      debris.dispose();
      debrisMat.dispose();
      quadGeo.dispose();
      circGeo.dispose();
      boxGeo.dispose();
      discGeo.dispose();
      rollerGeo.dispose();
      barrelGeo.dispose();
      drumGeo.dispose();
      stripeMap?.dispose();
      treadMap?.dispose();
      panelMap?.dispose();
      crackMap?.dispose();
    },
  };

  /** Which leg of its path a mover is currently on. */
  function legIndex(m: Mover): number {
    let d = m.s % m.total;
    if (d < 0) d += m.total;
    let i = 0;
    while (i < m.arc.length - 2 && m.arc[i + 1] <= d) i++;
    return i;
  }

  return sys;
};

export default createHazards;
