/**
 * Vibe Golf — portals and teleporters.
 *
 * Linked portal pairs that preserve momentum through the transit, plus the
 * cannons that share their "the course moves the ball for you" family.
 *
 * The mechanic only earns its place if it is *deterministic*: speed in equals
 * speed out, and the exit direction is the entry direction rotated by the
 * difference between the two mouths' orientations. That makes a portal a
 * mirror you can aim at, which is the entire skill of an SSG3 portal hole.
 *
 * Detection is a segment/segment test between the ball's motion over the last
 * frame and the portal's mouth line — never a distance check. A 60 m/s drive
 * covers a metre per frame and the physics solver has already substepped it
 * past the mouth by the time we look; a proximity test would silently miss it
 * exactly on the shots the player cares most about.
 *
 * Renders on `LAYER.props`: a dark elliptical throat with a swirling interior,
 * an emissive rim in the pair's hue (each pair gets its own, so the mapping is
 * readable at a glance on a phone), a soft halo, and particles spiralling in.
 * The interior is deliberately *dark* — a portal must never read as solid.
 */
import * as THREE from "three";
import type {
  BallState,
  Hole,
  PropSpec,
  System,
  SystemFactory,
  Vec2,
} from "../types";
import { v2 } from "../types";
import { LAYER } from "../engine/core";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** One hue per linked pair. Teal/amber house palette first, then the spread. */
const PAIR_HUES = [0x2dd4bf, 0xfbbf24, 0xc084fc, 0x38bdf8, 0xf472b6, 0x86efac];
/** A portal that links to nothing renders inert rather than lying to the player. */
const DEAD_HUE = 0x64748b;

/** Mouth half-length (the ellipse's major half-axis), metres. */
const DEFAULT_RADIUS = 1.75;
/** Visual minor half-axis — how "edge on" the ring reads. */
const DEFAULT_THICK = 0.52;
/** Slack added to the mouth for the crossing test, so grazes still count. */
const MOUTH_PAD = 0.16;
/**
 * A single frame can never legitimately move a ball this far — the engine
 * clamps dt to 1/20 s and nothing launches above ~65 m/s. Anything longer is
 * another system warping the ball (a reset, a drop), and treating that as a
 * flight path would teleport it through whatever portal the straight line
 * between the two lies happened to clip.
 */
const WARP_DIST = 12;
/** How far beyond the exit mouth the ball is placed, on top of its radius. */
const EXIT_CLEAR = 0.58;
/** Ball must get this far past the exit mouth before that portal re-arms. */
const CLEAR_MARGIN = 1.1;
/** Hard ceiling on the suppression, so a portal can never latch off forever. */
const SUPPRESS_MAX = 1.4;
/** Seconds a transit flash takes to decay. */
const FLASH_DECAY = 3.4;

/** Cannon defaults. */
const CANNON_RADIUS = 1.5;
const CANNON_POWER = 32;
const CANNON_HOLD = 0.42;
const CANNON_RECHARGE = 0.7;

const PARTICLES: Record<string, number> = { low: 0, medium: 12, high: 22 };

/**
 * Cannons live in the seam between this module and `hazards`. First system to
 * boot claims them; hazards boots first, so if it ever claims the same key we
 * quietly stand down rather than firing every ball twice.
 */
const CANNON_CLAIM = "__vibeGolfCannonOwner";

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

interface Portal {
  id: string;
  linkId: string | null;
  partner: Portal | null;
  /** Mouth centre, world metres. */
  c: Vec2;
  /** Facing angle: the outward normal of the mouth, radians. */
  a: number;
  nx: number;
  ny: number;
  /** Mouth tangent (left perpendicular of the normal). */
  tx: number;
  ty: number;
  r: number;
  thick: number;
  live: boolean;
  /** The pair's hue, reused by the transit FX so entry and exit read as one. */
  hue: number;
  group: THREE.Group;
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
  /** Ball currently in the barrel, plus its countdown. */
  held: BallState | null;
  hold: number;
  /** Muzzle-flash / recoil decay. */
  kick: number;
  group: THREE.Group;
  barrel: THREE.Object3D;
  uCharge: { value: number };
}

/** Per-ball bookkeeping. Weak so retired balls cost nothing. */
interface Track {
  px: number;
  py: number;
  /** Portal id that must be cleared before the ball may use it again. */
  suppress: string | null;
  suppressT: number;
  /** Cannon id on cooldown for this ball. */
  cannonBlock: string | null;
  cannonT: number;
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

/** The throat: a dark funnel with a swirl advancing inward. */
const FRAG_CORE = /* glsl */ `
  varying vec2 vUv;
  uniform float uTime;
  uniform float uFlash;
  uniform float uAlive;
  uniform vec3 uColor;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;

    float t = uTime * uAlive;
    float ang = atan(p.y, p.x);
    // Twist grows toward the centre so the interior reads as depth, not a disc.
    float sw = ang + t * 1.55 + (1.0 - r) * 4.4;
    float bands = 0.5 + 0.5 * sin(sw * 3.0);
    float n = noise(vec2(sw * 1.7, r * 3.6 - t * 1.2));

    // The throat is DARK at the centre and only picks up the pair's hue as it
    // approaches the rim. That contrast is the whole readability contract: a
    // portal must never be mistakable for a solid disc.
    float depth = smoothstep(0.0, 0.8, r);
    vec3 deep = vec3(0.012, 0.020, 0.048);
    vec3 c = deep + uColor * (0.06 + bands * 0.38 + n * 0.22) * depth;
    // A transit briefly lights the tunnel all the way down.
    c += uColor * pow(1.0 - r, 2.6) * uFlash * 4.5;

    float alpha = (0.78 + 0.2 * bands * depth) * smoothstep(1.0, 0.9, r);
    gl_FragColor = vec4(c, clamp(alpha + uFlash * 0.2, 0.0, 1.0));
  }
`;

/** The rim: a thin emissive band with a travelling shimmer. */
const FRAG_RIM = /* glsl */ `
  varying vec2 vUv;
  uniform float uTime;
  uniform float uFlash;
  uniform vec3 uColor;

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float band = smoothstep(0.80, 0.91, r) * (1.0 - smoothstep(0.975, 1.0, r));
    if (band <= 0.001) discard;
    float ang = atan(p.y, p.x);
    float shimmer = 0.74 + 0.26 * sin(ang * 6.0 - uTime * 3.1);
    gl_FragColor = vec4(uColor * (2.3 + uFlash * 5.5) * shimmer, band * (1.0 + uFlash));
  }
`;

/** Soft round halo, kept circular so a thin ellipse still glows evenly. */
const FRAG_HALO = /* glsl */ `
  varying vec2 vUv;
  uniform float uTime;
  uniform float uFlash;
  uniform vec3 uColor;

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float g = pow(max(0.0, 1.0 - r), 2.4);
    float pulse = 0.78 + 0.22 * sin(uTime * 2.05);
    gl_FragColor = vec4(uColor * g * (pulse + uFlash * 3.0), g * (0.6 + uFlash));
  }
`;

/**
 * Particles are entirely GPU-side: `position` carries (centreX, centreY, seed)
 * and `aParams` the mouth frame, so nothing is written per frame.
 */
const VERT_DUST = /* glsl */ `
  attribute vec4 aParams;
  attribute vec3 aColor;
  uniform float uTime;
  uniform float uPix;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float seed = position.z;
    float ang = aParams.x;
    float R = aParams.y;
    float thick = aParams.z;
    float life = aParams.w;

    float ph = fract(seed * 7.31 + uTime / life);
    // Ease inward so dust lingers at the edge and snaps into the throat.
    float rr = mix(2.5, 0.05, pow(ph, 0.7));
    float dir = sign(fract(seed * 3.77) - 0.5);
    float spin = seed * 6.28318 + ph * 5.2 * dir;

    vec2 n = vec2(cos(ang), sin(ang));
    vec2 tg = vec2(-n.y, n.x);
    vec2 local = vec2(cos(spin) * rr * R, sin(spin) * rr * thick * 1.7);
    vec2 world = position.xy + tg * local.x + n * local.y;

    vAlpha = smoothstep(0.0, 0.12, ph) * (1.0 - smoothstep(0.7, 1.0, ph));
    vColor = aColor;

    vec4 mv = modelViewMatrix * vec4(world, 0.0, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = max(1.0, mix(0.30, 0.09, ph) * uPix);
  }
`;

const FRAG_DUST = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.1, d) * vAlpha;
    gl_FragColor = vec4(vColor, a);
  }
`;

/** Cannon muzzle charge — a round bloom that swells as the shot loads. */
const FRAG_MUZZLE = /* glsl */ `
  varying vec2 vUv;
  uniform float uCharge;
  uniform vec3 uColor;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float g = pow(max(0.0, 1.0 - r), 2.2);
    gl_FragColor = vec4(uColor * g * (0.4 + uCharge * 3.0), g * (0.25 + uCharge * 0.85));
  }
`;

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

const createPortals: SystemFactory = (ctx) => {
  const globals = globalThis as unknown as Record<string, unknown>;
  if (!globals[CANNON_CLAIM]) globals[CANNON_CLAIM] = "portals";
  const ownsCannons = globals[CANNON_CLAIM] === "portals";

  const root = new THREE.Group();
  root.position.z = LAYER.props;
  ctx.scene.add(root);

  // Shared geometry — a hole never has enough portals to justify per-instance
  // buffers, and sharing keeps the dispose path to one line each.
  const coreGeo = new THREE.CircleGeometry(1, 48);
  const rimGeo = new THREE.RingGeometry(0.82, 1.0, 56);
  const quadGeo = new THREE.PlaneGeometry(1, 1);
  const drumGeo = new THREE.CylinderGeometry(0.95, 0.95, 1.2, 18);
  const barrelGeo = new THREE.CylinderGeometry(0.44, 0.56, 2.5, 14, 1, true);

  /** One clock for every material on screen. */
  const uTime = { value: 0 };
  const uPix = { value: 40 };

  const portals: Portal[] = [];
  const cannons: Cannon[] = [];
  const byId = new Map<string, Portal>();
  const tracks = new WeakMap<BallState, Track>();
  const disposables: Array<{ dispose(): void }> = [];

  let dust: THREE.Points | null = null;
  let dustMat: THREE.ShaderMaterial | null = null;
  const scratch = new THREE.Vector2();

  const quality = ctx.quality ?? "high";

  // --- Material factories -------------------------------------------------

  function shader(frag: string, extra: Record<string, { value: unknown }>, additive: boolean): THREE.ShaderMaterial {
    const m = new THREE.ShaderMaterial({
      vertexShader: VERT_UV,
      fragmentShader: frag,
      uniforms: { uTime, ...extra },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    disposables.push(m);
    return m;
  }

  // --- Build --------------------------------------------------------------

  function clear(): void {
    for (const d of disposables.splice(0)) d.dispose();
    while (root.children.length) root.remove(root.children[0]);
    portals.length = 0;
    cannons.length = 0;
    byId.clear();
    if (dust) {
      dust.geometry.dispose();
      dust = null;
      dustMat = null;
    }
  }

  function makePortal(spec: PropSpec, index: number): Portal {
    const a = spec.angle ?? 0;
    const r = Math.max(0.6, spec.size?.y ?? DEFAULT_RADIUS);
    // Floor the minor axis against the major one: a mouth authored as a sliver
    // is unreadable at phone scale, and a portal you can't see is a cheat.
    const thick = Math.max(spec.size?.x ?? DEFAULT_THICK, r * 0.36);
    const group = new THREE.Group();
    group.position.set(spec.at.x, spec.at.y, 0);

    const p: Portal = {
      id: spec.id ?? `portal${index}`,
      linkId: spec.link ?? null,
      partner: null,
      c: v2(spec.at.x, spec.at.y),
      a,
      nx: Math.cos(a),
      ny: Math.sin(a),
      tx: -Math.sin(a),
      ty: Math.cos(a),
      r,
      thick,
      live: false,
      hue: DEAD_HUE,
      group,
      uFlash: { value: 0 },
      flash: 0,
    };
    root.add(group);
    return p;
  }

  /** Dress a portal once its pair colour is known. */
  function dressPortal(p: Portal, hue: number): void {
    p.hue = hue;
    const color = { value: new THREE.Color(hue) };
    const uAlive = { value: p.live ? 1 : 0.18 };

    const halo = new THREE.Mesh(quadGeo, shader(FRAG_HALO, { uFlash: p.uFlash, uColor: color }, true));
    halo.scale.setScalar(p.r * 3.1);
    halo.position.z = -0.04;
    halo.renderOrder = 1;

    const core = new THREE.Mesh(coreGeo, shader(FRAG_CORE, { uFlash: p.uFlash, uColor: color, uAlive }, false));
    core.scale.set(p.thick, p.r, 1);
    core.rotation.z = p.a;
    core.renderOrder = 2;

    const rim = new THREE.Mesh(rimGeo, shader(FRAG_RIM, { uFlash: p.uFlash, uColor: color }, true));
    rim.scale.set(p.thick, p.r, 1);
    rim.rotation.z = p.a;
    rim.position.z = 0.02;
    rim.renderOrder = 3;

    p.group.add(halo, core, rim);
  }

  function makeCannon(spec: PropSpec, index: number): Cannon {
    const a = spec.angle ?? 0;
    const group = new THREE.Group();
    group.position.set(spec.at.x, spec.at.y, 0);

    const metal = new THREE.MeshStandardMaterial({
      color: 0x3c4551,
      roughness: 0.42,
      metalness: 0.8,
    });
    disposables.push(metal);

    const drum = new THREE.Mesh(drumGeo, metal);
    drum.rotation.x = Math.PI / 2; // face the camera
    drum.castShadow = quality !== "low";

    const barrelPivot = new THREE.Group();
    const barrel = new THREE.Mesh(barrelGeo, metal);
    barrel.rotation.z = -Math.PI / 2; // cylinder's +Y axis onto +X
    barrel.position.x = 1.25;
    barrel.castShadow = quality !== "low";
    barrelPivot.add(barrel);
    barrelPivot.rotation.z = a;

    const uCharge = { value: 0 };
    const muzzle = new THREE.Mesh(
      quadGeo,
      shader(FRAG_MUZZLE, { uCharge, uColor: { value: new THREE.Color(0xfbbf24) } }, true),
    );
    muzzle.scale.setScalar(3.0);
    muzzle.position.set(Math.cos(a) * 2.5, Math.sin(a) * 2.5, 0.05);
    muzzle.renderOrder = 3;

    group.add(drum, barrelPivot, muzzle);
    root.add(group);

    return {
      id: spec.id ?? `cannon${index}`,
      c: v2(spec.at.x, spec.at.y),
      a,
      nx: Math.cos(a),
      ny: Math.sin(a),
      radius: Math.max(0.6, spec.size?.x ?? CANNON_RADIUS),
      power: spec.power ?? CANNON_POWER,
      held: null,
      hold: 0,
      kick: 0,
      group,
      barrel: barrelPivot,
      uCharge,
    };
  }

  /** Rebuild every prop this module owns from the live hole. */
  function build(hole: Hole | null): void {
    clear();
    if (!hole) return;

    const specs = hole.props ?? [];
    let pi = 0;
    for (const spec of specs) {
      if (!spec || !spec.at) continue;
      if (spec.kind === "portal") {
        const p = makePortal(spec, pi++);
        portals.push(p);
        byId.set(p.id, p);
      } else if (spec.kind === "cannon" && ownsCannons) {
        cannons.push(makeCannon(spec, cannons.length));
      }
    }

    // Resolve links, then hand each pair its own hue so the player can read
    // which mouth feeds which without having to discover it the hard way.
    for (const p of portals) {
      p.partner = p.linkId ? byId.get(p.linkId) ?? null : null;
      p.live = Boolean(p.partner);
    }
    const hues = new Map<Portal, number>();
    let pair = 0;
    for (const p of portals) {
      if (hues.has(p)) continue;
      if (!p.live) {
        hues.set(p, DEAD_HUE);
        continue;
      }
      const hue = PAIR_HUES[pair++ % PAIR_HUES.length];
      hues.set(p, hue);
      if (p.partner) hues.set(p.partner, hue);
    }
    for (const p of portals) dressPortal(p, hues.get(p) ?? DEAD_HUE);

    buildDust(hues);
  }

  /** One Points cloud for every portal on the hole; animated purely in GLSL. */
  function buildDust(hues: Map<Portal, number>): void {
    const per = PARTICLES[quality] ?? 0;
    const live = portals.filter((p) => p.live);
    const total = per * live.length;
    if (total <= 0) return;

    const pos = new Float32Array(total * 3);
    const params = new Float32Array(total * 4);
    const cols = new Float32Array(total * 3);
    const tint = new THREE.Color();
    let k = 0;
    for (const p of live) {
      tint.setHex(hues.get(p) ?? DEAD_HUE);
      for (let i = 0; i < per; i++, k++) {
        pos[k * 3] = p.c.x;
        pos[k * 3 + 1] = p.c.y;
        pos[k * 3 + 2] = ctx.rng() * 997.0;
        params[k * 4] = p.a;
        params[k * 4 + 1] = p.r;
        params[k * 4 + 2] = p.thick;
        params[k * 4 + 3] = 1.6 + ctx.rng() * 1.5;
        cols[k * 3] = tint.r;
        cols[k * 3 + 1] = tint.g;
        cols[k * 3 + 2] = tint.b;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aParams", new THREE.BufferAttribute(params, 4));
    geo.setAttribute("aColor", new THREE.BufferAttribute(cols, 3));
    // Vertex positions are portal centres, not particle positions — let the
    // shader place them and skip culling entirely.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    dustMat = new THREE.ShaderMaterial({
      vertexShader: VERT_DUST,
      fragmentShader: FRAG_DUST,
      uniforms: { uTime, uPix },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    disposables.push(dustMat);

    dust = new THREE.Points(geo, dustMat);
    dust.frustumCulled = false;
    dust.position.z = 0.04;
    dust.renderOrder = 4;
    root.add(dust);
  }

  // --- Geometry helpers ---------------------------------------------------

  /**
   * Does the ball's path (x0,y0)->(x1,y1) cross this mouth? Returns the
   * fraction along the path and the signed offset along the mouth, or null.
   */
  function crossMouth(
    p: Portal,
    x0: number, y0: number, x1: number, y1: number,
  ): { u: number; off: number } | null {
    const mx = x1 - x0;
    const my = y1 - y0;
    if (mx === 0 && my === 0) return null;

    const half = p.r + MOUTH_PAD;
    const ax = p.c.x - p.tx * half;
    const ay = p.c.y - p.ty * half;
    const ex = p.tx * 2 * half;
    const ey = p.ty * 2 * half;

    const den = mx * ey - my * ex;
    if (Math.abs(den) < 1e-9) return null; // parallel — sliding along the mouth

    const dx = ax - x0;
    const dy = ay - y0;
    const u = (dx * ey - dy * ex) / den;
    const s = (dx * my - dy * mx) / den;
    if (u < 0 || u > 1 || s < 0 || s > 1) return null;

    return { u, off: (s - 0.5) * 2 * half };
  }

  /** Squared distance from the segment (x0,y0)->(x1,y1) to a point. */
  function segDistSq(x0: number, y0: number, x1: number, y1: number, px: number, py: number): number {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 1e-12 ? ((px - x0) * dx + (py - y0) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = x0 + dx * t - px;
    const cy = y0 + dy * t - py;
    return cx * cx + cy * cy;
  }

  function track(b: BallState): Track {
    let t = tracks.get(b);
    if (!t) {
      t = { px: b.pos.x, py: b.pos.y, suppress: null, suppressT: 0, cannonBlock: null, cannonT: 0 };
      tracks.set(b, t);
    }
    return t;
  }

  /** Stereo pan from world X, so a portal on the far side of the hole sits off-centre. */
  function panAt(x: number): number {
    const halfW = Math.max(1, (ctx.camera.right - ctx.camera.left) * 0.5);
    const v = (x - ctx.camera.position.x) / halfW;
    return v < -1 ? -1 : v > 1 ? 1 : v;
  }

  function flashPortal(p: Portal): void {
    p.flash = 1;
  }

  // --- Transit ------------------------------------------------------------

  /**
   * Move `b` from `from` to `to`. The whole mechanic is this rotation:
   * φ = to.angle − from.angle + π maps a velocity heading *into* `from` onto
   * one heading *out of* `to`, with the magnitude untouched. The entry offset
   * along the mouth rides the same rotation, so the trajectory is continuous
   * rather than snapping to the portal's centre.
   */
  function transit(b: BallState, from: Portal, to: Portal, off: number, hitX: number, hitY: number): void {
    const phi = to.a - from.a + Math.PI;
    const cs = Math.cos(phi);
    const sn = Math.sin(phi);

    const vx = b.vel.x;
    const vy = b.vel.y;
    b.vel.x = vx * cs - vy * sn;
    b.vel.y = vx * sn + vy * cs;
    // Spin is a scalar about Z; a planar rotation leaves it alone. Nothing to do.

    const ox = from.tx * off;
    const oy = from.ty * off;
    const rox = ox * cs - oy * sn;
    const roy = ox * sn + oy * cs;

    // Two-sided mouths: leave on whichever side the rotated velocity points.
    const side = b.vel.x * to.nx + b.vel.y * to.ny >= 0 ? 1 : -1;
    const clearDist = b.radius + EXIT_CLEAR;
    let ex = to.c.x + rox + to.nx * side * clearDist;
    let ey = to.c.y + roy + to.ny * side * clearDist;

    // If the author parked the exit against geometry, nudge clear of it so the
    // ball doesn't spawn embedded and get flung by the contact solver.
    const near = ctx.services.physics?.probe(v2(ex, ey), b.radius + 0.6);
    if (near) {
      const d = Math.hypot(ex - near.point.x, ey - near.point.y);
      if (d < b.radius + 0.06) {
        const push = b.radius + 0.1 - d;
        ex += near.normal.x * push;
        ey += near.normal.y * push;
      }
    }

    b.pos.x = ex;
    b.pos.y = ey;
    b.resting = false;
    b.restTimer = 0;
    // Break the trail so the renderer doesn't draw a streak across the hole.
    b.trail.length = 0;

    const t = track(b);
    t.px = ex;
    t.py = ey;
    t.suppress = to.id;
    t.suppressT = SUPPRESS_MAX;

    // --- Feedback -----------------------------------------------------
    flashPortal(from);
    flashPortal(to);
    const speed = Math.hypot(b.vel.x, b.vel.y);
    const vfx = ctx.services.vfx;
    vfx?.ring(v2(hitX, hitY), from.r * 1.15, from.hue);
    vfx?.ring(v2(ex, ey), to.r * 1.15, to.hue);
    vfx?.burst(v2(hitX, hitY), 14, { color: from.hue, speed: 5 + speed * 0.12, spread: Math.PI * 2, life: 0.36 });
    vfx?.burst(v2(ex, ey), 18, { color: to.hue, speed: 6 + speed * 0.14, spread: Math.PI * 2, life: 0.42 });
    vfx?.screenShake(0.1 + Math.min(0.16, speed * 0.004));
    ctx.services.audio?.play("portal", {
      volume: 0.55 + Math.min(0.35, speed * 0.008),
      rate: 0.92 + ctx.rng() * 0.16,
      pan: panAt(ex),
    });
    ctx.emit("golf:portal", {
      from: from.id,
      to: to.id,
      at: { x: ex, y: ey },
      speed,
    });
  }

  // --- Cannons ------------------------------------------------------------

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
    b.pos.x = cn.c.x + cn.nx * (b.radius + 2.3);
    b.pos.y = cn.c.y + cn.ny * (b.radius + 2.3);
    b.trail.length = 0;

    const t = track(b);
    t.px = b.pos.x;
    t.py = b.pos.y;
    t.cannonBlock = cn.id;
    t.cannonT = CANNON_RECHARGE;

    const vfx = ctx.services.vfx;
    vfx?.burst(v2(b.pos.x, b.pos.y), 22, { color: 0xfbbf24, speed: 12, spread: 0.9, life: 0.4 });
    vfx?.ring(v2(cn.c.x, cn.c.y), 2.0, 0xfbbf24);
    vfx?.screenShake(0.3);
    ctx.services.audio?.play("cannon", { volume: 0.8, pan: panAt(cn.c.x) });
    ctx.emit("golf:cannon", { id: cn.id, at: { x: b.pos.x, y: b.pos.y }, power: cn.power });
  }

  function tryCapture(cn: Cannon, b: BallState, t: Track, x0: number, y0: number): boolean {
    if (cn.held) return false;
    if (t.cannonBlock === cn.id && t.cannonT > 0) return false;
    const rr = cn.radius + b.radius;
    if (segDistSq(x0, y0, b.pos.x, b.pos.y, cn.c.x, cn.c.y) > rr * rr) return false;

    cn.held = b;
    cn.hold = CANNON_HOLD;
    b.vel.x = 0;
    b.vel.y = 0;
    b.spin = 0;
    b.pos.x = cn.c.x;
    b.pos.y = cn.c.y;
    b.resting = false;
    b.restTimer = 0;
    // Freezing via `stuck` is what stops the solver advancing it while loaded.
    b.stuck = true;
    b.trail.length = 0;
    t.px = b.pos.x;
    t.py = b.pos.y;

    ctx.services.audio?.play("portal", { volume: 0.4, rate: 0.7, pan: panAt(cn.c.x) });
    ctx.services.vfx?.burst(v2(cn.c.x, cn.c.y), 10, { color: 0xfbbf24, speed: 4, spread: Math.PI * 2, life: 0.3 });
    return true;
  }

  // --- Wiring -------------------------------------------------------------

  const offHole = ctx.on("golf:hole", (payload) => {
    const p = payload as { hole?: Hole } | undefined;
    build(p?.hole ?? null);
  });

  let seenHole: Hole | null = null;

  const sys: System = {
    name: "portals",

    update(dt) {
      // Cold-start guard: the course loads its first hole from its own update,
      // so if we ever boot after that event we still pick the hole up.
      const current = ctx.services.course?.current ?? null;
      if (current !== seenHole) {
        if (current && portals.length === 0 && cannons.length === 0) build(current);
        seenHole = current;
      }

      const phys = ctx.services.physics;
      if (!phys) return;

      for (const b of phys.balls) {
        if (!b.active) continue;
        const t = track(b);
        const x0 = t.px;
        const y0 = t.py;

        if (t.suppressT > 0) t.suppressT -= dt;
        if (t.suppressT <= 0) t.suppress = null;
        if (t.cannonT > 0) t.cannonT -= dt;
        if (t.cannonT <= 0) t.cannonBlock = null;

        // Re-arm the exit as soon as the ball is genuinely clear of its mouth,
        // rather than waiting out the whole timer.
        if (t.suppress) {
          const sp = byId.get(t.suppress);
          if (sp) {
            const d = Math.hypot(b.pos.x - sp.c.x, b.pos.y - sp.c.y);
            if (d > sp.r + b.radius + CLEAR_MARGIN) t.suppress = null;
          } else {
            t.suppress = null;
          }
        }

        // A hazard reset or a power-up drop moves the ball without flying it
        // there; the straight line between the two lies is not a trajectory.
        const warped = Math.hypot(b.pos.x - x0, b.pos.y - y0) > WARP_DIST;

        // Cannons swallow first — a loaded ball has no path to test.
        let swallowed = false;
        if (!warped && !b.stuck) {
          for (const cn of cannons) {
            if (tryCapture(cn, b, t, x0, y0)) {
              swallowed = true;
              break;
            }
          }
        }

        if (!warped && !swallowed && !b.stuck) {
          // Earliest crossing wins, so two portals on one flight path resolve
          // in the order the ball actually met them.
          let bestU = 2;
          let bestP: Portal | null = null;
          let bestOff = 0;
          for (const p of portals) {
            if (!p.live || !p.partner) continue;
            if (t.suppress === p.id) continue;
            const hit = crossMouth(p, x0, y0, b.pos.x, b.pos.y);
            if (!hit || hit.u >= bestU) continue;
            bestU = hit.u;
            bestP = p;
            bestOff = hit.off;
          }
          if (bestP && bestP.partner) {
            const hx = x0 + (b.pos.x - x0) * bestU;
            const hy = y0 + (b.pos.y - y0) * bestU;
            transit(b, bestP, bestP.partner, bestOff, hx, hy);
          }
        }

        const t2 = tracks.get(b);
        if (t2) {
          t2.px = b.pos.x;
          t2.py = b.pos.y;
        }
      }

      // Cannon countdowns.
      for (const cn of cannons) {
        if (cn.held) {
          if (!cn.held.active) {
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
    },

    lateUpdate(dt) {
      uTime.value = ctx.elapsed;

      // Point sprites are sized in pixels, so they need the current metres-to-
      // pixels scale or they bloat when the camera zooms out.
      if (dust) {
        ctx.renderer.getDrawingBufferSize(scratch);
        const span = Math.max(1e-3, ctx.camera.top - ctx.camera.bottom);
        uPix.value = scratch.y / span;
      }

      for (const p of portals) {
        if (p.flash > 0) p.flash = Math.max(0, p.flash - dt * FLASH_DECAY);
        p.uFlash.value = p.flash;
        // Idle breathing plus a pop on transit — the pop is what the eye reads.
        const breathe = 1 + Math.sin(ctx.elapsed * 1.7 + p.c.x * 0.3) * 0.018;
        p.group.scale.setScalar(breathe + p.flash * 0.2);
      }

      for (const cn of cannons) {
        // Recoil: the barrel slams back and eases forward again.
        const back = cn.kick * cn.kick * 0.55;
        cn.barrel.position.set(-cn.nx * back, -cn.ny * back, 0);
      }
    },

    dispose() {
      offHole();
      clear();
      ctx.scene.remove(root);
      coreGeo.dispose();
      rimGeo.dispose();
      quadGeo.dispose();
      drumGeo.dispose();
      barrelGeo.dispose();
    },
  };

  return sys;
};

export default createPortals;
