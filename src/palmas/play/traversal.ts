/**
 * San Palmas — traversal.
 *
 * The grappling hook, the wingsuit and the parachute: the three verbs that
 * turn a shooter into a Just Cause game. Everything here exists to serve one
 * loop — grapple ▸ launch ▸ wingsuit ▸ parachute ▸ grapple — which the player
 * must be able to run for ten minutes without ever touching the ground.
 *
 * ── Who owns motion ───────────────────────────────────────────────────────
 * `player.ts` integrates `position += velocity * dt`, resolves the capsule
 * against city colliders and clamps to the terrain **every frame**, but skips
 * its own *force* model whenever `state` is grapple/wingsuit/parachute/vehicle.
 * So this module never writes `position`; it writes `velocity` and `state` and
 * lets the controller do the integration and the collision. That is the whole
 * contract, and it is why a grapple can drag you up a cliff face without ever
 * tunnelling through it. Ground contact is detected here (the controller will
 * not leave our state on its own) and we hand the player back.
 *
 * ── The cable ─────────────────────────────────────────────────────────────
 * A straight line between two points is the tell of a prototype. The cable is
 * a 26-node Verlet rope with pinned ends, gravity, air drag and *pull-only*
 * distance constraints, so it sags into a real catenary when slack, snaps
 * straight and visibly stretches when the reel loads it, and whips when the
 * anchor or the hand moves fast. It is skinned every frame into a swept tube
 * with parallel-transport frames — 1 draw call, ~330 triangles — whose radius
 * thins with tension, because a rope under load is a thinner rope.
 *
 * ── Aerodynamics ──────────────────────────────────────────────────────────
 * The wingsuit is a real (if forgiving) thin-aerofoil model: lift and drag
 * both scale with v², the lift coefficient is linear in angle of attack with a
 * soft stall, and drag carries an induced term in CL². The consequences fall
 * out for free and are the entire reason it feels good — diving buys speed,
 * pulling out spends it for altitude, and holding a bank turns lift sideways
 * so you carve. The player steers by *looking*; the body chases the view and
 * banks into the turn like an aircraft.
 *
 * ── Camera ────────────────────────────────────────────────────────────────
 * `weapons.ts` stows itself and stops touching the camera in exactly our four
 * states, and this system boots after it, so its `lateUpdate` runs last and we
 * own FOV and roll outright while flying. We only ever add roll and FOV — the
 * player controller keeps pitch and yaw, always.
 *
 * ── Assets ────────────────────────────────────────────────────────────────
 * None. The aramid cable braid, the gunmetal claw, the ripstop wing membrane
 * and the ram-air canopy panels are all DataTextures baked from value noise at
 * boot, with normal maps derived from their own height fields.
 *
 * Reads: PlayerService (required for anything to happen), CollisionService,
 * TerrainService, VfxService, AudioService. All optional-chained; with none of
 * them present this module quietly does nothing rather than taking boot down.
 *
 * Audio names this module asks for: grapple_fire, grapple_hit, whoosh, chute.
 *
 * Convention: +X east, +Z south, +Y up. 1 unit = 1 metre.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type {
  QualityTier,
  System,
  SystemFactory,
  TerrainService,
  WorldCtx,
} from "../types";

/* ------------------------------------------------------------------------ *
 * 1. Tunables
 * ------------------------------------------------------------------------ */

/** Must match `player.ts` — we take over its force model, not its world. */
const GRAVITY = -26;
/** The FOV the player controller and weapons both settle on. */
const BASE_FOV = 68;

// --- Grapple ---------------------------------------------------------------
/** How far the hook can reach. Roughly the height of the tallest tower. */
const GRAPPLE_RANGE = 340;
/** Hook flight speed. Fast enough to feel instant, slow enough to read. */
const HOOK_SPEED = 178;
/** Retract speed when a shot misses or the line is cut. */
const HOOK_RETURN = 260;
/** Peak inward acceleration of the winch, m/s². */
const REEL_ACCEL = 82;
/** How fast the winch physically shortens the line, m/s. */
const REEL_RATE = 27;
/** The line never reels shorter than this — you stop *at* the ledge, not in it. */
const MIN_CABLE = 2.6;
/** Gravity is not switched off while attached; it is what makes swinging work. */
const GRAPPLE_GRAVITY = 0.62;
/** Lateral acceleration WASD can add to a swing. */
const SWING_CONTROL = 15;
/**
 * How far *above* the anchor the winch actually aims once you are close. This
 * one number is the difference between arcing over a parapet and face-planting
 * the wall two metres under it.
 */
const LIP_ARC = 6.5;
/** Distance at which we let go and let momentum carry you over. */
const DETACH_DIST = 3.4;
/** Minimum gap between shots. */
const GRAPPLE_COOLDOWN = 0.22;
/** Angular aim assist, radians. A 5-ray fan makes ledges forgiving to catch. */
const AIM_ASSIST = 0.045;

// --- Wingsuit --------------------------------------------------------------
/** Clearance above ground needed to deploy. */
const DEPLOY_CLEARANCE = 2.6;
/** Lift acceleration per unit CL per (m/s)². Tuned for a ~55 m/s trim speed. */
const LIFT_K = 0.0105;
/** Parasitic drag coefficient — the price of simply being in the air. */
const CD0 = 0.00092;
/** Induced drag factor: drag ∝ CL². The cost of making lift. */
const K_INDUCED = 0.0032;
/** Lift-curve slope, per radian, before stall. */
const CL_ALPHA = 5.1;
/** Angle of attack at which the flow separates. */
const STALL_ALPHA = 0.34;
/** Hard ceiling on airspeed so a 900 m dive off Alta Loma stays controllable. */
const MAX_AIRSPEED = 96;
/** Bank angle the suit will hold at full stick, radians. */
const MAX_BANK = 1.15;

// --- Parachute -------------------------------------------------------------
/** Seconds from pull to fully loaded canopy. */
const INFLATE_TIME = 0.44;
/** Steady-state sink rate under a full canopy, m/s. */
const CHUTE_SINK = 5.6;
/** Steady-state forward glide, m/s. */
const CHUTE_GLIDE = 15.5;
/** Sink rate in a full flare, before it stalls. */
const CHUTE_FLARE_SINK = 1.7;
/** How hard the canopy hauls you onto its trim speed once inflated. */
const CHUTE_AUTHORITY = 3.1;
/** Metres the canopy rides above the eye. */
const CANOPY_HEIGHT = 4.7;

/** Per-tier geometry budgets. Everything here is transient, so this is cheap. */
interface Tier {
  /** Verlet nodes in the cable. */
  rope: number;
  /** Radial segments in the cable tube. */
  ring: number;
  /** Speed-line segments. */
  streaks: number;
  /** Canopy tessellation, spanwise × chordwise. */
  span: number;
  chord: number;
  /** Procedural texture resolution. */
  tex: number;
}

const TIERS: Record<QualityTier, Tier> = {
  low: { rope: 12, ring: 4, streaks: 0, span: 14, chord: 5, tex: 64 },
  medium: { rope: 18, ring: 5, streaks: 72, span: 20, chord: 7, tex: 128 },
  high: { rope: 26, ring: 6, streaks: 128, span: 28, chord: 9, tex: 256 },
  ultra: { rope: 34, ring: 8, streaks: 192, span: 34, chord: 11, tex: 256 },
};

/* ------------------------------------------------------------------------ *
 * 2. Scratch + small maths
 *
 * Traversal runs every frame at every quality tier; nothing below allocates
 * once the system is built.
 * ------------------------------------------------------------------------ */

const UP = new THREE.Vector3(0, 1, 0);

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();
const _f = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _bodyUp = new THREE.Vector3();
const _lift = new THREE.Vector3();
const _hand = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _quat2 = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, "YXZ");

const clamp = THREE.MathUtils.clamp;

/** Frame-rate independent exponential approach. Identical to weapons.ts. */
function approach(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

/** Hermite smoothstep between two edges. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/* ------------------------------------------------------------------------ *
 * 3. Texture bakery
 *
 * DataTexture rather than Canvas2D throughout: it costs the same, it cannot
 * fail in a headless context, and it lets the normal map be differentiated
 * from the *same* height field that shaded the albedo, so the two agree.
 * ------------------------------------------------------------------------ */

/** Integer hash → [0,1). Cheap, well-mixed, no allocation. */
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 362437);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise on a lattice that wraps at `period`, so every map tiles. */
function noiseTiled(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = (n: number) => ((n % period) + period) % period;
  const x0 = w(xi);
  const x1 = w(xi + 1);
  const y0 = w(yi);
  const y1 = w(yi + 1);
  const n00 = hash2(x0, y0, seed);
  const n10 = hash2(x1, y0, seed);
  const n01 = hash2(x0, y1, seed);
  const n11 = hash2(x1, y1, seed);
  return (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v;
}

/** Octave stack of the tiling noise. `period` is in base-octave cells. */
function fbmTiled(x: number, y: number, period: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += noiseTiled(x * freq, y * freq, period * freq, seed + o * 71) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

function finish(tex: THREE.DataTexture, srgb: boolean, aniso: number): THREE.DataTexture {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = aniso;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Differentiate a height field into a tangent-space normal map. Central
 * differences with wraparound, so the normals tile as cleanly as the albedo.
 */
function normalFromHeight(h: Float32Array, size: number, strength: number, aniso: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const at = (x: number, y: number) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      // n = normalize(-dx, -dy, 1)
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * size + x) * 4;
      data[i] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  return finish(new THREE.DataTexture(data, size, size, THREE.RGBAFormat), false, aniso);
}

/** Pack a scalar field into the green channel — bound as `roughnessMap`. */
function roughnessTexture(rough: Float32Array, metal: Float32Array | null, size: number, aniso: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const j = i * 4;
    data[j] = 255;
    data[j + 1] = Math.round(clamp(rough[i], 0, 1) * 255);
    data[j + 2] = metal ? Math.round(clamp(metal[i], 0, 1) * 255) : 0;
    data[j + 3] = 255;
  }
  return finish(new THREE.DataTexture(data, size, size, THREE.RGBAFormat), false, aniso);
}

interface Maps {
  map: THREE.DataTexture;
  normal: THREE.DataTexture;
  /** G = roughness, B = metalness. */
  aux: THREE.DataTexture;
}

/**
 * Braided aramid cable. U runs around the circumference, V along the length,
 * so the strands are laid as a shear in U+V and they twist the way a real
 * laid rope does. Steel core shows through the wear.
 */
function bakeCable(size: number, aniso: number, seed: number): Maps {
  const albedo = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  const STRANDS = 6;

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      // Laid strands: the twist is a shear of the strand coordinate along V.
      const s = ((u * STRANDS + v * 2) % 1 + 1) % 1;
      // Rounded strand cross-section, plus the groove between strands.
      const bulge = Math.sin(s * Math.PI) ** 0.7;
      // Fibre grain running along each strand.
      const fibre = fbmTiled(u * size * 0.55, v * size * 0.18, size, 3, seed);
      // Scuffs from being dragged over concrete parapets.
      const wear = smoothstep(0.62, 0.92, fbmTiled(u * 5, v * 9, 16, 3, seed + 31));

      const h = bulge * 0.82 + fibre * 0.18 + wear * 0.05;
      height[y * size + x] = h;

      // Weathered ochre aramid, going pale where it is chewed, with the steel
      // core catching light in the deepest grooves.
      const core = smoothstep(0.34, 0.02, bulge);
      const shade = 0.42 + bulge * 0.5 + fibre * 0.22;
      let r = 0.40 * shade + wear * 0.30;
      let g = 0.31 * shade + wear * 0.27;
      let bl = 0.20 * shade + wear * 0.24;
      r = r * (1 - core) + 0.30 * core;
      g = g * (1 - core) + 0.32 * core;
      bl = bl * (1 - core) + 0.35 * core;

      const i = (y * size + x) * 4;
      albedo[i] = Math.round(clamp(r, 0, 1) * 255);
      albedo[i + 1] = Math.round(clamp(g, 0, 1) * 255);
      albedo[i + 2] = Math.round(clamp(bl, 0, 1) * 255);
      albedo[i + 3] = 255;
      rough[y * size + x] = 0.78 - bulge * 0.22 - wear * 0.16 - core * 0.28;
      metal[y * size + x] = core * 0.75 + wear * 0.12;
    }
  }

  return {
    map: finish(new THREE.DataTexture(albedo, size, size, THREE.RGBAFormat), true, aniso),
    normal: normalFromHeight(height, size, size * 0.06, aniso),
    aux: roughnessTexture(rough, metal, size, aniso),
  };
}

/**
 * Brushed, anodised gunmetal for the claw. Long anisotropic brush marks, a
 * scatter of bright edge chips where it has hit stone, and a faint bloom of
 * heat colour near the barbs.
 */
function bakeGunmetal(size: number, aniso: number, seed: number): Maps {
  const albedo = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // Brushing: high frequency across, very low frequency along.
      const brush = fbmTiled(u * size * 0.9, v * 2.2, size, 2, seed);
      const grime = fbmTiled(u * 6, v * 6, 8, 4, seed + 17);
      const chip = smoothstep(0.80, 0.94, fbmTiled(u * 11, v * 11, 16, 3, seed + 53));

      const h = brush * 0.25 + grime * 0.35 + chip * 0.9;
      height[y * size + x] = h;

      const base = 0.20 + brush * 0.13 - grime * 0.07;
      const heat = smoothstep(0.55, 0.9, grime) * 0.5;
      const r = base + heat * 0.22 + chip * 0.42;
      const g = base * 0.98 + heat * 0.10 + chip * 0.40;
      const bl = base * 1.06 + chip * 0.36;

      const i = (y * size + x) * 4;
      albedo[i] = Math.round(clamp(r, 0, 1) * 255);
      albedo[i + 1] = Math.round(clamp(g, 0, 1) * 255);
      albedo[i + 2] = Math.round(clamp(bl, 0, 1) * 255);
      albedo[i + 3] = 255;
      rough[y * size + x] = 0.52 - brush * 0.2 + grime * 0.24 - chip * 0.22;
      metal[y * size + x] = 0.86 + chip * 0.14 - grime * 0.2;
    }
  }

  return {
    map: finish(new THREE.DataTexture(albedo, size, size, THREE.RGBAFormat), true, aniso),
    normal: normalFromHeight(height, size, size * 0.05, aniso),
    aux: roughnessTexture(rough, metal, size, aniso),
  };
}

/** Colour stop for the panelling pass of a fabric bake. */
interface Panel {
  /** Upper bound of this panel in the panel coordinate, 0..1. */
  to: number;
  rgb: [number, number, number];
}

interface FabricOpts {
  /** Panels are laid out along U (spanwise) unless `alongV`. */
  panels: Panel[];
  alongV?: boolean;
  /** Number of panel repeats across the sheet. */
  repeats: number;
  /** Ripstop grid pitch in texels. */
  ripstop: number;
  /** Extra darkening for stitched seams between panels. */
  seam: number;
  /** Base roughness of the coated nylon. */
  rough: number;
}

/**
 * Coated ripstop nylon: a plain weave at 2-texel pitch with a heavier
 * reinforcing thread every `ripstop` texels — the little grid you can see on
 * any real canopy — plus panel colours, seam stitching and use-grime. The
 * weave is what stops the wing reading as a flat coloured triangle.
 */
function bakeFabric(size: number, aniso: number, seed: number, o: FabricOpts): Maps {
  const albedo = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const rough = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;

      // --- Weave -------------------------------------------------------
      const warp = Math.sin(x * Math.PI) * 0.5 + 0.5;
      const weft = Math.sin(y * Math.PI) * 0.5 + 0.5;
      // Over-under: the warp sits proud where the weft dips and vice versa.
      const weave = warp * 0.5 + weft * 0.5;
      const ripX = Math.abs(((x % o.ripstop) + o.ripstop) % o.ripstop - o.ripstop * 0.5) < 1 ? 1 : 0;
      const ripY = Math.abs(((y % o.ripstop) + o.ripstop) % o.ripstop - o.ripstop * 0.5) < 1 ? 1 : 0;
      const rip = Math.max(ripX, ripY);

      // --- Panels ------------------------------------------------------
      const pc = ((o.alongV ? v : u) * o.repeats) % 1;
      let col = o.panels[o.panels.length - 1].rgb;
      let edge = 1;
      let lo = 0;
      for (const p of o.panels) {
        if (pc < p.to) {
          col = p.rgb;
          edge = Math.min(pc - lo, p.to - pc) * o.repeats * size;
          break;
        }
        lo = p.to;
      }
      const seam = smoothstep(3.2, 0.6, edge) * o.seam;

      // --- Grime + sun bleach -----------------------------------------
      const grime = fbmTiled(u * 7, v * 7, 8, 4, seed) - 0.5;
      const bleach = fbmTiled(u * 3, v * 3, 4, 3, seed + 91) - 0.5;

      const h = weave * 0.45 + rip * 0.55 + seam * 0.8 + grime * 0.12;
      height[y * size + x] = h;

      const shade = 0.86 + weave * 0.2 + rip * 0.1 + grime * 0.16 + bleach * 0.1;
      const i = (y * size + x) * 4;
      albedo[i] = Math.round(clamp(col[0] * shade * (1 - seam * 0.5), 0, 1) * 255);
      albedo[i + 1] = Math.round(clamp(col[1] * shade * (1 - seam * 0.5), 0, 1) * 255);
      albedo[i + 2] = Math.round(clamp(col[2] * shade * (1 - seam * 0.5), 0, 1) * 255);
      albedo[i + 3] = 255;
      rough[y * size + x] = o.rough + weave * 0.1 - rip * 0.12 + grime * 0.2;
    }
  }

  return {
    map: finish(new THREE.DataTexture(albedo, size, size, THREE.RGBAFormat), true, aniso),
    normal: normalFromHeight(height, size, size * 0.028, aniso),
    aux: roughnessTexture(rough, null, size, aniso),
  };
}

/* ------------------------------------------------------------------------ *
 * 4. The claw
 *
 * A four-barb folding hook: shaft, collar, four swept barbs and a lug for the
 * line. Merged to a single draw call, built once, reused forever.
 * ------------------------------------------------------------------------ */

function buildHookGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  // Shaft, +Z forward (the hook flies nose-first).
  const shaft = new THREE.CylinderGeometry(0.048, 0.036, 0.42, 10, 1);
  shaft.rotateX(Math.PI / 2);
  shaft.translate(0, 0, 0.03);
  parts.push(shaft);

  // Nose cone.
  const nose = new THREE.ConeGeometry(0.048, 0.16, 10);
  nose.rotateX(Math.PI / 2);
  nose.translate(0, 0, 0.32);
  parts.push(nose);

  // Collar the barbs hinge from.
  const collar = new THREE.CylinderGeometry(0.075, 0.075, 0.055, 12, 1);
  collar.rotateX(Math.PI / 2);
  collar.translate(0, 0, 0.09);
  parts.push(collar);

  // Four barbs, swept back and outward, each a tapered prism with a point.
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const barb = new THREE.CylinderGeometry(0.026, 0.012, 0.30, 6, 1);
    barb.translate(0, 0.15, 0);
    // Sweep: rotate back 42° from the shaft, then spin into place.
    barb.rotateX(Math.PI * 0.5 + 0.74);
    barb.rotateZ(0);
    barb.rotateY(0);
    const m = new THREE.Matrix4().makeRotationZ(ang);
    barb.applyMatrix4(m);
    barb.translate(0, 0, 0.10);
    parts.push(barb);

    const tip = new THREE.ConeGeometry(0.026, 0.075, 6);
    tip.translate(0, 0.30 + 0.037, 0);
    tip.rotateX(Math.PI * 0.5 + 0.74);
    tip.applyMatrix4(m);
    tip.translate(0, 0, 0.10);
    parts.push(tip);
  }

  // Line lug at the tail.
  const lug = new THREE.TorusGeometry(0.055, 0.017, 6, 12);
  lug.translate(0, 0, -0.20);
  parts.push(lug);

  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  const geo = merged ?? new THREE.SphereGeometry(0.09, 8, 6);
  geo.computeVertexNormals();
  return geo;
}

/* ------------------------------------------------------------------------ *
 * 5. The cable — Verlet rope + swept tube
 *
 * Pull-only constraints are the whole trick: a rope can yank you but it cannot
 * push, so relaxing only when a segment is *over* its rest length gives free
 * catenary sag while slack and a hard straight line under load. Running the
 * relaxation at less than full stiffness leaves a visible elastic stretch,
 * which is exactly what the eye reads as tension.
 * ------------------------------------------------------------------------ */

class Cable {
  readonly nodes: THREE.Vector3[] = [];
  private readonly prev: THREE.Vector3[] = [];
  private readonly seg: number;
  /** Unstretched length of the whole line. */
  restLength = 1;
  /** 0..1, how hard the line is being pulled. Drives radius + shading. */
  tension = 0;

  readonly mesh: THREE.Mesh;
  private readonly positions: Float32Array;
  private readonly normals: Float32Array;
  private readonly uvs: Float32Array;
  private readonly geo: THREE.BufferGeometry;
  private readonly ring: number;
  // Parallel-transport frame carried along the curve.
  private readonly frameN = new THREE.Vector3();
  private readonly frameB = new THREE.Vector3();
  private readonly tan = new THREE.Vector3();

  constructor(segments: number, ring: number, material: THREE.Material) {
    this.seg = segments;
    this.ring = ring;
    for (let i = 0; i <= segments; i++) {
      this.nodes.push(new THREE.Vector3());
      this.prev.push(new THREE.Vector3());
    }

    const verts = (segments + 1) * (ring + 1);
    this.positions = new Float32Array(verts * 3);
    this.normals = new Float32Array(verts * 3);
    this.uvs = new Float32Array(verts * 2);
    const index: number[] = [];
    for (let i = 0; i < segments; i++) {
      for (let j = 0; j < ring; j++) {
        const a0 = i * (ring + 1) + j;
        const a1 = a0 + 1;
        const b0 = (i + 1) * (ring + 1) + j;
        const b1 = b0 + 1;
        index.push(a0, b0, a1, a1, b0, b1);
      }
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.geo.setAttribute("normal", new THREE.BufferAttribute(this.normals, 3));
    this.geo.setAttribute("uv", new THREE.BufferAttribute(this.uvs, 2));
    this.geo.setIndex(index);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.visible = false;
    this.mesh.matrixAutoUpdate = false;
  }

  /** Lay the rope out dead straight between two points and kill its motion. */
  reset(from: THREE.Vector3, to: THREE.Vector3): void {
    for (let i = 0; i <= this.seg; i++) {
      this.nodes[i].lerpVectors(from, to, i / this.seg);
      this.prev[i].copy(this.nodes[i]);
    }
    this.restLength = Math.max(0.2, from.distanceTo(to));
    this.tension = 0;
  }

  /**
   * One Verlet step. `windRel` is the *relative* air velocity (player velocity
   * negated) — it is what makes a slack line stream behind you rather than
   * hanging like a dead thing.
   */
  simulate(dt: number, from: THREE.Vector3, to: THREE.Vector3, rest: number, windRel: THREE.Vector3): void {
    const n = this.seg;
    this.restLength = Math.max(0.2, rest);
    const dt2 = dt * dt;
    const drag = 0.985;

    for (let i = 1; i < n; i++) {
      const p = this.nodes[i];
      const q = this.prev[i];
      _a.copy(p);
      // v = p - prev, damped; a = gravity + a slice of the relative wind.
      _b.subVectors(p, q).multiplyScalar(drag);
      p.add(_b);
      p.y += GRAVITY * 0.42 * dt2;
      p.addScaledVector(windRel, dt2 * 0.55);
      q.copy(_a);
    }
    this.nodes[0].copy(from);
    this.prev[0].copy(from);
    this.nodes[n].copy(to);
    this.prev[n].copy(to);

    // --- Relaxation ---------------------------------------------------
    const restSeg = this.restLength / n;
    const stiff = 0.78;
    let strain = 0;
    for (let it = 0; it < 4; it++) {
      // Alternate sweep direction so error does not pile up at one end.
      const forward = (it & 1) === 0;
      for (let k = 0; k < n; k++) {
        const i = forward ? k : n - 1 - k;
        const p0 = this.nodes[i];
        const p1 = this.nodes[i + 1];
        _c.subVectors(p1, p0);
        const len = _c.length();
        if (len < 1e-5 || len <= restSeg) continue; // pull-only: never push
        const diff = ((len - restSeg) / len) * stiff;
        if (it === 0) strain = Math.max(strain, (len - restSeg) / restSeg);
        const pin0 = i === 0;
        const pin1 = i + 1 === n;
        if (pin0 && pin1) continue;
        const w0 = pin0 ? 0 : pin1 ? 1 : 0.5;
        const w1 = pin1 ? 0 : pin0 ? 1 : 0.5;
        p0.addScaledVector(_c, diff * w0);
        p1.addScaledVector(_c, -diff * w1);
      }
    }
    this.tension = approach(this.tension, clamp(strain * 7, 0, 1), 14, dt);
  }

  /**
   * Skin the polyline into a tube. Parallel transport rather than Frenet
   * frames: a straight, taut rope has no curvature, and Frenet frames are
   * undefined there — they flip and the texture spins.
   */
  skin(radius: number, vRepeat: number): void {
    const n = this.seg;
    const ring = this.ring;
    // Seed the frame with any axis not parallel to the first tangent.
    this.tan.subVectors(this.nodes[1], this.nodes[0]);
    if (this.tan.lengthSq() < 1e-9) this.tan.set(0, 0, 1);
    this.tan.normalize();
    this.frameN.set(0, 1, 0);
    if (Math.abs(this.frameN.dot(this.tan)) > 0.94) this.frameN.set(1, 0, 0);
    this.frameN.projectOnPlane(this.tan).normalize();
    this.frameB.crossVectors(this.tan, this.frameN);

    let arc = 0;
    for (let i = 0; i <= n; i++) {
      if (i > 0) {
        arc += this.nodes[i].distanceTo(this.nodes[i - 1]);
        // Advance the frame: new tangent, re-orthogonalise the old normal.
        if (i < n) this.tan.subVectors(this.nodes[i + 1], this.nodes[i - 1]);
        else this.tan.subVectors(this.nodes[n], this.nodes[n - 1]);
        if (this.tan.lengthSq() > 1e-9) {
          this.tan.normalize();
          this.frameN.projectOnPlane(this.tan);
          if (this.frameN.lengthSq() < 1e-8) {
            this.frameN.set(0, 1, 0).projectOnPlane(this.tan);
            if (this.frameN.lengthSq() < 1e-8) this.frameN.set(1, 0, 0).projectOnPlane(this.tan);
          }
          this.frameN.normalize();
          this.frameB.crossVectors(this.tan, this.frameN);
        }
      }
      // Taper: thin at the hand (it feeds through the winch), full at the claw.
      const t = i / n;
      const r = radius * (0.62 + 0.38 * smoothstep(0, 0.18, t)) * (0.92 + 0.08 * Math.sin(t * 31));
      const p = this.nodes[i];
      for (let j = 0; j <= ring; j++) {
        const ang = (j / ring) * Math.PI * 2;
        const cs = Math.cos(ang);
        const sn = Math.sin(ang);
        const nx = this.frameN.x * cs + this.frameB.x * sn;
        const ny = this.frameN.y * cs + this.frameB.y * sn;
        const nz = this.frameN.z * cs + this.frameB.z * sn;
        const o = (i * (ring + 1) + j) * 3;
        this.positions[o] = p.x + nx * r;
        this.positions[o + 1] = p.y + ny * r;
        this.positions[o + 2] = p.z + nz * r;
        this.normals[o] = nx;
        this.normals[o + 1] = ny;
        this.normals[o + 2] = nz;
        const u = (i * (ring + 1) + j) * 2;
        this.uvs[u] = j / ring;
        this.uvs[u + 1] = arc * vRepeat;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
    this.geo.attributes.uv.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
  }
}

/* ------------------------------------------------------------------------ *
 * 6. The system
 * ------------------------------------------------------------------------ */

type Mode = "idle" | "flying" | "attached" | "returning" | "wingsuit" | "parachute";

const createTraversal: SystemFactory = (ctx: WorldCtx) => {
  const tier = TIERS[ctx.quality] ?? TIERS.high;
  const scene = ctx.scene;
  const camera = ctx.camera;
  const terrain: TerrainService | undefined = ctx.services.terrain;
  const rng = ctx.rng;
  const seed = Math.floor(rng() * 100000);
  let aniso = 4;
  try {
    aniso = Math.min(8, ctx.renderer.capabilities.getMaxAnisotropy?.() ?? 4);
  } catch {
    /* headless — anisotropy is a hint, not a requirement */
  }

  // Everything we create, so dispose() is exhaustive without bookkeeping at
  // each call site.
  const textures: THREE.Texture[] = [];
  const materials: THREE.Material[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const objects: THREE.Object3D[] = [];

  const track = <T extends Maps>(m: T): T => {
    textures.push(m.map, m.normal, m.aux);
    return m;
  };

  /* ---------------------------------------------------------------- *
   * 6a. Materials
   * ---------------------------------------------------------------- */

  const cableMaps = track(bakeCable(Math.min(128, tier.tex), aniso, seed));
  cableMaps.map.repeat.set(1, 1);
  const cableMat = new THREE.MeshStandardMaterial({
    map: cableMaps.map,
    normalMap: cableMaps.normal,
    roughnessMap: cableMaps.aux,
    metalnessMap: cableMaps.aux,
    roughness: 1,
    metalness: 1,
    normalScale: new THREE.Vector2(1.15, 1.15),
  });
  materials.push(cableMat);

  const metalMaps = track(bakeGunmetal(Math.min(128, tier.tex), aniso, seed + 7));
  const hookMat = new THREE.MeshStandardMaterial({
    map: metalMaps.map,
    normalMap: metalMaps.normal,
    roughnessMap: metalMaps.aux,
    metalnessMap: metalMaps.aux,
    roughness: 1,
    metalness: 1,
    envMapIntensity: 1.25,
  });
  materials.push(hookMat);

  // Deep teal suit with a coral leading edge and a cream pinstripe — the
  // palette the rest of the island is painted in.
  const wingMaps = track(
    bakeFabric(tier.tex, aniso, seed + 13, {
      panels: [
        { to: 0.16, rgb: [0.86, 0.32, 0.22] },
        { to: 0.22, rgb: [0.94, 0.90, 0.80] },
        { to: 0.72, rgb: [0.07, 0.30, 0.34] },
        { to: 0.80, rgb: [0.94, 0.90, 0.80] },
        { to: 1.0, rgb: [0.10, 0.40, 0.44] },
      ],
      alongV: true,
      repeats: 1,
      ripstop: Math.max(6, Math.round(tier.tex / 22)),
      seam: 0.35,
      rough: 0.46,
    }),
  );
  const wingMat = new THREE.MeshStandardMaterial({
    map: wingMaps.map,
    normalMap: wingMaps.normal,
    roughnessMap: wingMaps.aux,
    roughness: 1,
    metalness: 0.02,
    side: THREE.DoubleSide,
    normalScale: new THREE.Vector2(1.4, 1.4),
  });
  materials.push(wingMat);

  const suitMat = new THREE.MeshStandardMaterial({
    map: wingMaps.map,
    normalMap: wingMaps.normal,
    roughnessMap: wingMaps.aux,
    roughness: 1,
    metalness: 0.03,
    color: 0x9fb0b4,
  });
  materials.push(suitMat);

  // Ram-air canopy: coral / cream / turquoise cells, laid out spanwise.
  const canopyMaps = track(
    bakeFabric(tier.tex, aniso, seed + 23, {
      panels: [
        { to: 0.34, rgb: [0.93, 0.38, 0.26] },
        { to: 0.5, rgb: [0.96, 0.93, 0.86] },
        { to: 0.84, rgb: [0.14, 0.62, 0.63] },
        { to: 1.0, rgb: [0.96, 0.93, 0.86] },
      ],
      repeats: 3,
      ripstop: Math.max(6, Math.round(tier.tex / 26)),
      seam: 0.45,
      rough: 0.42,
    }),
  );
  const canopyMat = new THREE.MeshStandardMaterial({
    map: canopyMaps.map,
    normalMap: canopyMaps.normal,
    roughnessMap: canopyMaps.aux,
    roughness: 1,
    metalness: 0.0,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 1,
    normalScale: new THREE.Vector2(1.25, 1.25),
  });
  materials.push(canopyMat);

  const lineMat = new THREE.LineBasicMaterial({
    color: 0xd8cdb4,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  materials.push(lineMat);

  const streakMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    opacity: 0.9,
  });
  materials.push(streakMat);

  /* ---------------------------------------------------------------- *
   * 6b. Objects
   * ---------------------------------------------------------------- */

  const cable = new Cable(tier.rope, tier.ring, cableMat);
  scene.add(cable.mesh);
  objects.push(cable.mesh);

  const hookGeo = buildHookGeometry();
  geometries.push(hookGeo);
  const hook = new THREE.Mesh(hookGeo, hookMat);
  hook.visible = false;
  hook.frustumCulled = false;
  scene.add(hook);
  objects.push(hook);

  // --- Wingsuit rig, carried in front of the camera like a viewmodel ---
  const wingRig = new THREE.Group();
  wingRig.visible = false;
  wingRig.renderOrder = 6;
  wingRig.matrixAutoUpdate = false;
  scene.add(wingRig);
  objects.push(wingRig);

  const SP = 10; // spanwise membrane divisions
  const CH = 6; // chordwise membrane divisions
  const membraneGeo = new THREE.BufferGeometry();
  {
    const verts = 2 * (SP + 1) * (CH + 1);
    membraneGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    membraneGeo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    const uv = new Float32Array(verts * 2);
    const index: number[] = [];
    for (let side = 0; side < 2; side++) {
      const base = side * (SP + 1) * (CH + 1);
      for (let i = 0; i <= SP; i++) {
        for (let j = 0; j <= CH; j++) {
          const k = base + i * (CH + 1) + j;
          uv[k * 2] = i / SP;
          uv[k * 2 + 1] = j / CH;
        }
      }
      for (let i = 0; i < SP; i++) {
        for (let j = 0; j < CH; j++) {
          const a0 = base + i * (CH + 1) + j;
          const a1 = a0 + 1;
          const b0 = base + (i + 1) * (CH + 1) + j;
          const b1 = b0 + 1;
          if (side === 0) index.push(a0, b0, a1, a1, b0, b1);
          else index.push(a0, a1, b0, a1, b1, b0);
        }
      }
    }
    membraneGeo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    membraneGeo.setIndex(index);
    membraneGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3);
  }
  geometries.push(membraneGeo);
  const membrane = new THREE.Mesh(membraneGeo, wingMat);
  membrane.frustumCulled = false;
  wingRig.add(membrane);

  /** Forearm + glove, modelled along +Y at unit-arm length so it only rotates. */
  const ARM_LEN = 0.7;
  const armGeo = (() => {
    const parts: THREE.BufferGeometry[] = [];
    const sleeve = new THREE.CylinderGeometry(0.058, 0.043, ARM_LEN * 0.82, 8, 1);
    sleeve.translate(0, ARM_LEN * 0.41, 0);
    parts.push(sleeve);
    const cuff = new THREE.CylinderGeometry(0.05, 0.05, 0.05, 8, 1);
    cuff.translate(0, ARM_LEN * 0.84, 0);
    parts.push(cuff);
    const glove = new THREE.BoxGeometry(0.075, 0.15, 0.055, 1, 1, 1);
    glove.translate(0, ARM_LEN * 0.93, 0);
    parts.push(glove);
    const merged = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    const g = merged ?? new THREE.BoxGeometry(0.08, ARM_LEN, 0.08);
    g.computeVertexNormals();
    return g;
  })();
  geometries.push(armGeo);
  const armL = new THREE.Mesh(armGeo, suitMat);
  const armR = new THREE.Mesh(armGeo, suitMat);
  armL.frustumCulled = false;
  armR.frustumCulled = false;
  wingRig.add(armL, armR);

  // --- Parachute -------------------------------------------------------
  const chuteRoot = new THREE.Group();
  chuteRoot.visible = false;
  scene.add(chuteRoot);
  objects.push(chuteRoot);

  const canopyGeo = new THREE.BufferGeometry();
  {
    const verts = (tier.span + 1) * (tier.chord + 1);
    canopyGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    canopyGeo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    const uv = new Float32Array(verts * 2);
    const index: number[] = [];
    for (let i = 0; i <= tier.span; i++) {
      for (let j = 0; j <= tier.chord; j++) {
        const k = i * (tier.chord + 1) + j;
        uv[k * 2] = i / tier.span;
        uv[k * 2 + 1] = j / tier.chord;
      }
    }
    for (let i = 0; i < tier.span; i++) {
      for (let j = 0; j < tier.chord; j++) {
        const a0 = i * (tier.chord + 1) + j;
        const a1 = a0 + 1;
        const b0 = (i + 1) * (tier.chord + 1) + j;
        const b1 = b0 + 1;
        index.push(a0, b0, a1, a1, b0, b1);
      }
    }
    canopyGeo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    canopyGeo.setIndex(index);
    canopyGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 8);
  }
  geometries.push(canopyGeo);
  const canopy = new THREE.Mesh(canopyGeo, canopyMat);
  canopy.frustumCulled = false;
  chuteRoot.add(canopy);

  // Suspension lines: 12 risers, 4 segments each so they sag and swing.
  const RISERS = 12;
  const RISER_SEG = 4;
  const riserGeo = new THREE.BufferGeometry();
  const riserPos = new Float32Array(RISERS * RISER_SEG * 2 * 3);
  riserGeo.setAttribute("position", new THREE.BufferAttribute(riserPos, 3));
  riserGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  geometries.push(riserGeo);
  const risers = new THREE.LineSegments(riserGeo, lineMat);
  risers.frustumCulled = false;
  risers.matrixAutoUpdate = false;
  risers.visible = false;
  scene.add(risers);
  objects.push(risers);

  // --- Speed lines -----------------------------------------------------
  const STREAKS = tier.streaks;
  const streakPos = new Float32Array(Math.max(1, STREAKS) * 6);
  const streakCol = new Float32Array(Math.max(1, STREAKS) * 6);
  const streakGeo = new THREE.BufferGeometry();
  streakGeo.setAttribute("position", new THREE.BufferAttribute(streakPos, 3));
  streakGeo.setAttribute("color", new THREE.BufferAttribute(streakCol, 3));
  streakGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  geometries.push(streakGeo);
  const streaks = new THREE.LineSegments(streakGeo, streakMat);
  streaks.frustumCulled = false;
  streaks.matrixAutoUpdate = false;
  streaks.visible = false;
  scene.add(streaks);
  objects.push(streaks);

  /** Particle pool for the speed lines: world-space points with a life. */
  const streakP = new Float32Array(Math.max(1, STREAKS) * 3);
  const streakLife = new Float32Array(Math.max(1, STREAKS));

  /* ---------------------------------------------------------------- *
   * 6c. Mutable state
   * ---------------------------------------------------------------- */

  let mode: Mode = "idle";
  let cooldown = 0;

  const anchor = new THREE.Vector3();
  const anchorNormal = new THREE.Vector3(0, 1, 0);
  const hookPos = new THREE.Vector3();
  const hookVel = new THREE.Vector3();
  const handPos = new THREE.Vector3();
  const windRel = new THREE.Vector3();
  let hookTravel = 0;
  let flightRange = 0;
  /** Unstretched line length. The winch shortens this; it never lengthens. */
  let cableLen = 0;
  let boostWindow = 0;

  // Wingsuit / parachute flight state.
  let bank = 0;
  let bankTarget = 0;
  let inflate = 0;
  let chuteBrake = 0;
  let chuteTurn = 0;
  let stallTimer = 0;
  const heading = new THREE.Vector3(0, 0, -1);
  const canopyPos = new THREE.Vector3();
  const canopyLag = new THREE.Vector3();
  let cutaway = 0;
  const cutVel = new THREE.Vector3();
  let armSpread = 0.5;

  // Camera layer.
  let fov = BASE_FOV;
  let roll = 0;
  let lastYaw = 0;
  let yawRate = 0;

  // Membrane animation clock, decoupled from ctx.elapsed so it can slow down.
  let flutter = 0;

  /* ---------------------------------------------------------------- *
   * 6d. Anchor finding
   * ---------------------------------------------------------------- */

  /**
   * March a ray against the terrain height field. Sphere-tracing style: step
   * by the vertical gap, which converges fast over open water and slowly (but
   * safely) up the flank of a hill.
   */
  function terrainRay(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, out: THREE.Vector3): number {
    if (!terrain) return -1;
    let t = 0.6;
    let prevGap = origin.y + dir.y * t - terrain.heightAt(origin.x + dir.x * t, origin.z + dir.z * t);
    if (prevGap < 0) return -1; // started underground; nothing sensible to hit
    let prevT = t;
    while (t < maxDist) {
      const x = origin.x + dir.x * t;
      const y = origin.y + dir.y * t;
      const z = origin.z + dir.z * t;
      const gap = y - terrain.heightAt(x, z);
      if (gap <= 0) {
        // Bisect between the last airborne sample and this one.
        let lo = prevT;
        let hi = t;
        for (let i = 0; i < 10; i++) {
          const mid = (lo + hi) * 0.5;
          const g = origin.y + dir.y * mid - terrain.heightAt(origin.x + dir.x * mid, origin.z + dir.z * mid);
          if (g <= 0) hi = mid;
          else lo = mid;
        }
        out.copy(origin).addScaledVector(dir, hi);
        return hi;
      }
      prevT = t;
      prevGap = gap;
      t += Math.max(1.1, prevGap * 0.55);
    }
    return -1;
  }

  /**
   * Find the best anchor along a look direction. Fires a small fan so that a
   * parapet edge you *nearly* hit still catches — the assist is angular, so it
   * scales with distance the way the player expects it to.
   */
  function findAnchor(origin: THREE.Vector3, dir: THREE.Vector3): boolean {
    const collision = ctx.services.collision;
    let bestDist = Infinity;
    let found = false;

    // Build an orthonormal basis around the aim direction for the fan.
    _a.set(0, 1, 0);
    if (Math.abs(_a.dot(dir)) > 0.94) _a.set(1, 0, 0);
    _b.crossVectors(dir, _a).normalize();
    _c.crossVectors(_b, dir).normalize();

    for (let i = 0; i < 5; i++) {
      _d.copy(dir);
      if (i > 0) {
        const ang = (i - 1) * (Math.PI / 2);
        _d.addScaledVector(_b, Math.cos(ang) * AIM_ASSIST);
        _d.addScaledVector(_c, Math.sin(ang) * AIM_ASSIST);
        _d.normalize();
      }

      const hit = collision?.raycast(origin, _d, GRAPPLE_RANGE) ?? null;
      if (hit && hit.distance < bestDist) {
        bestDist = hit.distance;
        anchor.copy(hit.point);
        anchorNormal.copy(hit.normal);
        found = true;
      }

      const t = terrainRay(origin, _d, Math.min(GRAPPLE_RANGE, bestDist), _e);
      if (t > 0 && t < bestDist) {
        // Water is not an anchor. Nothing to bite into.
        const seaLevel = terrain?.seaLevel ?? 0;
        if (_e.y > seaLevel + 0.4) {
          bestDist = t;
          anchor.copy(_e);
          terrain?.normalAt(_e.x, _e.z, anchorNormal);
          found = true;
        }
      }
    }

    if (!found) return false;
    // Lift the anchor a hair off the surface so the claw does not z-fight the
    // wall it just bit into.
    anchor.addScaledVector(anchorNormal, 0.08);
    return true;
  }

  /* ---------------------------------------------------------------- *
   * 6e. Mode transitions
   * ---------------------------------------------------------------- */

  const player = () => ctx.services.player;

  function setState(s: "air" | "grapple" | "wingsuit" | "parachute"): void {
    const p = player();
    if (p) p.state = s;
  }

  function fireHook(): void {
    const p = player();
    if (!p || cooldown > 0) return;
    camera.getWorldDirection(_fwd).normalize();
    _a.copy(camera.position);
    cooldown = GRAPPLE_COOLDOWN;

    if (!findAnchor(_a, _fwd)) {
      // A miss still fires: the hook flies its full range and comes back. It
      // reads as "I missed", not as "the button did nothing".
      anchor.copy(_a).addScaledVector(_fwd, GRAPPLE_RANGE);
      anchorNormal.copy(_fwd).negate();
      flightRange = GRAPPLE_RANGE * 0.55;
      mode = "flying";
      hookPos.copy(handPos);
      hookVel.copy(_fwd).multiplyScalar(HOOK_SPEED);
      hookTravel = 0;
      hook.visible = true;
      cable.reset(handPos, hookPos);
      cable.mesh.visible = true;
      ctx.services.audio?.play("grapple_fire", { volume: 0.75 });
      return;
    }

    flightRange = handPos.distanceTo(anchor);
    mode = "flying";
    hookPos.copy(handPos);
    hookVel.copy(anchor).sub(handPos).normalize().multiplyScalar(HOOK_SPEED);
    hookTravel = 0;
    hook.visible = true;
    cable.reset(handPos, hookPos);
    cable.mesh.visible = true;
    ctx.services.audio?.play("grapple_fire", { volume: 0.8 });
  }

  function attach(): void {
    const p = player();
    if (!p) return;
    mode = "attached";
    cableLen = Math.max(MIN_CABLE, p.position.distanceTo(anchor));
    setState("grapple");
    ctx.services.audio?.play("grapple_hit", { volume: 0.8, position: anchor });
    ctx.services.vfx?.impact(anchor, anchorNormal, "concrete");
  }

  /** Cut the line. `pop` adds the release kick that carries you over a lip. */
  function releaseGrapple(pop: number): void {
    const p = player();
    if (mode === "attached" && p) {
      if (pop > 0) {
        // Keep every scrap of horizontal momentum, add a vertical pop scaled
        // by how hard the winch was working. This is the launch.
        p.velocity.y = Math.max(p.velocity.y, 0) + pop;
        boostWindow = 0.38;
      }
      if (p.state === "grapple") setState("air");
    }
    mode = "returning";
    hook.visible = true;
  }

  function stowHook(): void {
    mode = "idle";
    hook.visible = false;
    cable.mesh.visible = false;
  }

  function enterWingsuit(): void {
    const p = player();
    if (!p) return;
    if (mode === "attached") releaseGrapple(0);
    if (mode === "parachute") cutCanopy();
    setState("wingsuit");
    mode = "wingsuit";
    // Give the suit something to fly: a dead-stop deploy would just stall.
    const sp = p.velocity.length();
    if (sp < 12) {
      camera.getWorldDirection(_fwd);
      _fwd.y = Math.min(_fwd.y, -0.15);
      _fwd.normalize();
      p.velocity.addScaledVector(_fwd, 12 - sp);
    }
    armSpread = 0.5;
    ctx.services.audio?.play("whoosh", { volume: 0.7 });
  }

  function enterParachute(): void {
    const p = player();
    if (!p) return;
    if (mode === "attached") releaseGrapple(0);
    setState("parachute");
    mode = "parachute";
    inflate = 0;
    stallTimer = 0;
    cutaway = 0;
    canopyMat.opacity = 1;
    chuteRoot.visible = true;
    risers.visible = true;
    // Seed the canopy directly overhead so the first frame is not a snap-in.
    canopyPos.copy(p.position).addScaledVector(UP, CANOPY_HEIGHT);
    canopyLag.set(0, 0, 0);
    camera.getWorldDirection(_fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-4) _fwd.set(0, 0, -1);
    heading.copy(_fwd).normalize();
    ctx.services.audio?.play("chute", { volume: 0.9 });
  }

  /** Chop the canopy away and let it tumble off downwind. */
  function cutCanopy(): void {
    if (mode !== "parachute") return;
    cutaway = 1.5;
    const p = player();
    cutVel.set((rng() - 0.5) * 4, 3.5 + rng() * 2, (rng() - 0.5) * 4);
    if (p) cutVel.addScaledVector(p.velocity, 0.35);
    mode = "idle";
    if (p && p.state === "parachute") setState("air");
    risers.visible = false;
  }

  /** Everything off — used on death and on landing. */
  function resetAll(toState: "air" | null): void {
    if (mode === "attached" || mode === "flying" || mode === "returning") stowHook();
    if (mode === "parachute") cutCanopy();
    mode = "idle";
    const p = player();
    if (p && toState && (p.state === "grapple" || p.state === "wingsuit" || p.state === "parachute")) {
      p.state = toState;
    }
    inflate = 0;
  }

  /* ---------------------------------------------------------------- *
   * 6f. Flight models
   * ---------------------------------------------------------------- */

  /**
   * Winch + pendulum. Two forces and one constraint:
   *   • a strong pull toward an aim point that drifts *above* the anchor as
   *     you close, which is what arcs you over the parapet;
   *   • reduced gravity, so a swing is still a swing;
   *   • a pull-only length constraint at `cableLen`, which is what makes the
   *     tangential component survive and become a swing rather than a snap.
   */
  function updateGrapple(dt: number): void {
    const p = player();
    if (!p) return;
    const vel = p.velocity;

    _a.subVectors(anchor, p.position);
    const dist = _a.length();
    if (dist < 1e-4) {
      releaseGrapple(6);
      return;
    }
    _b.copy(_a).divideScalar(dist); // radial unit, pointing at the anchor

    // Aim above the anchor as we close so the arc clears the lip. Falls to
    // zero at range, where a straight pull is what you want.
    const closeness = 1 - smoothstep(8, 52, dist);
    const rise = clamp((anchor.y - p.position.y) / 24, 0, 1);
    _c.copy(anchor).addScaledVector(UP, LIP_ARC * closeness * (0.35 + 0.65 * rise));
    _d.subVectors(_c, p.position);
    if (_d.lengthSq() < 1e-6) _d.copy(_b);
    else _d.normalize();

    // --- Winch ---------------------------------------------------------
    const radial = vel.dot(_b);
    const reelRamp = 0.5 + 0.5 * smoothstep(4, 30, dist);
    if (radial < REEL_RATE * 1.9) {
      vel.addScaledVector(_d, REEL_ACCEL * reelRamp * dt);
    }

    // --- Gravity, reduced ----------------------------------------------
    vel.y += GRAVITY * GRAPPLE_GRAVITY * dt;

    // --- Air control ----------------------------------------------------
    const input = ctx.input;
    if (input.moveX !== 0 || input.moveZ !== 0) {
      _euler.set(0, camera.rotation.y, 0, "YXZ");
      _e.set(input.moveX, 0, -input.moveZ).applyEuler(_euler);
      const l = _e.length();
      if (l > 1e-4) vel.addScaledVector(_e.divideScalar(l), SWING_CONTROL * dt);
    }

    // --- Rope constraint -------------------------------------------------
    // The winch physically shortens the line; the line then refuses to be
    // longer than it is. That single inequality is the whole pendulum.
    cableLen = Math.min(cableLen, dist);
    cableLen = Math.max(MIN_CABLE, cableLen - REEL_RATE * dt);
    if (dist > cableLen) {
      const outward = vel.dot(_b);
      if (outward < 0) vel.addScaledVector(_b, -outward); // kill outward radial
      // Position error → an inward corrective velocity. Half-strength so it
      // reads as an elastic line rather than a steel bar.
      vel.addScaledVector(_b, Math.min((dist - cableLen) / Math.max(dt, 1e-3) * 0.5, 40));
    }

    // Light tangential drag so a long swing decays instead of perpetuating.
    const rad2 = vel.dot(_b);
    _e.copy(vel).addScaledVector(_b, -rad2);
    vel.addScaledVector(_e, -0.45 * dt);

    // --- Release conditions ----------------------------------------------
    const closing = -vel.dot(_b);
    if (dist < DETACH_DIST || (dist < 9 && closing < -2)) {
      // Arrival pop: momentum plus a vertical kick that scales with how fast
      // the winch was hauling. Slow crawls get a hop; a 40 m/s reel launches.
      releaseGrapple(clamp(Math.abs(closing) * 0.26, 2.5, 10.5));
    }
  }

  /**
   * Thin-aerofoil wingsuit. Lift and drag both go as v², CL is linear in AoA
   * up to a soft stall, and drag carries the induced CL² term. Bank rotates
   * the lift vector, which is how the turn happens — there is no "turn rate"
   * anywhere in here, and that is the point.
   */
  function updateWingsuit(dt: number): void {
    const p = player();
    if (!p) return;
    const vel = p.velocity;
    const input = ctx.input;

    camera.getWorldDirection(_fwd).normalize();
    _right.crossVectors(_fwd, UP);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();

    // Bank: mostly from how fast you are swinging the view, like a real
    // aircraft, plus direct stick from A/D.
    bankTarget = clamp(-yawRate * 6.5 + input.moveX * 0.85, -1, 1) * MAX_BANK;
    bank = approach(bank, bankTarget, 4.2, dt);

    // Body up = world up rolled about the flight axis by the bank angle.
    _bodyUp.crossVectors(_right, _fwd).normalize();
    _quat.setFromAxisAngle(_fwd, -bank);
    _bodyUp.applyQuaternion(_quat);

    const speed = vel.length();
    if (speed < 0.5) {
      vel.y += GRAVITY * dt;
      return;
    }
    _a.copy(vel).divideScalar(speed); // flight path unit vector

    // --- Angle of attack --------------------------------------------------
    const vf = _a.dot(_fwd);
    const vu = _a.dot(_bodyUp);
    const alpha = Math.atan2(-vu, Math.max(vf, 0.05));

    // Tuck (W) flattens the suit for speed; flare (S) drives the nose up.
    const tuck = clamp(input.moveZ, -1, 1);
    const alphaCmd = alpha - tuck * 0.11;

    // --- Coefficients ------------------------------------------------------
    // Linear then soft-stalled: past STALL_ALPHA the flow separates and lift
    // collapses toward a flat-plate value while drag climbs. Diving out of a
    // stall recovers, exactly as it should.
    const mag = Math.abs(alphaCmd);
    const stall = mag <= STALL_ALPHA ? 1 : Math.max(0.28, 1 - (mag - STALL_ALPHA) * 2.1);
    let cl = CL_ALPHA * alphaCmd * stall;
    cl = clamp(cl, -1.45, 1.45);
    const cd = CD0 * (1 + (1 - stall) * 2.4) + K_INDUCED * cl * cl;

    const q = speed * speed;

    // --- Lift: perpendicular to the flight path, in the body's roll plane --
    _lift.copy(_bodyUp).addScaledVector(_a, -_bodyUp.dot(_a));
    if (_lift.lengthSq() < 1e-6) _lift.copy(UP);
    else _lift.normalize();
    vel.addScaledVector(_lift, LIFT_K * cl * q * dt);

    // --- Drag: straight back down the flight path --------------------------
    vel.addScaledVector(_a, -cd * q * dt);

    // --- Gravity, and a little sideslip damping so the suit tracks true ----
    vel.y += GRAVITY * dt;
    const slip = vel.dot(_right) - (_a.dot(_right) * speed);
    vel.addScaledVector(_right, -slip * 0.35 * dt);

    const newSpeed = vel.length();
    if (newSpeed > MAX_AIRSPEED) vel.multiplyScalar(MAX_AIRSPEED / newSpeed);

    // Arm pose follows the commanded attitude: tucked in a dive, spread in a
    // flare, asymmetric in a bank.
    armSpread = approach(armSpread, clamp(0.5 - tuck * 0.45 + clamp(alpha, -0.3, 0.3), 0, 1), 5, dt);
  }

  /**
   * Ram-air canopy. Once inflated it is a velocity-authority model rather than
   * a force model — a real canopy is so heavily damped that it *is* its trim
   * speed within a second — but the inflation transient is a genuine drag
   * spike, which is what makes the opening shock land.
   */
  function updateParachute(dt: number): void {
    const p = player();
    if (!p) return;
    const vel = p.velocity;
    const input = ctx.input;

    const wasInflating = inflate < 1;
    inflate = Math.min(1, inflate + dt / INFLATE_TIME);
    // Snap curve: slow start (the slider is doing its job), then a hard grab.
    const load = inflate * inflate * (3 - 2 * inflate);

    camera.getWorldDirection(_fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-5) _fwd.copy(heading);
    _fwd.normalize();
    // The canopy has inertia in yaw — you steer it, you do not carry it.
    heading.lerp(_fwd, 1 - Math.exp(-3.4 * dt)).normalize();
    _right.crossVectors(heading, UP).normalize();

    // Toggles: S / crouch flares, W lets it run.
    const brakeIn = clamp(-input.moveZ, 0, 1) + (input.crouch ? 1 : 0);
    chuteBrake = approach(chuteBrake, clamp(brakeIn, 0, 1), 5.5, dt);
    chuteTurn = approach(chuteTurn, clamp(input.moveX + -yawRate * 5, -1, 1), 4.5, dt);

    // A held flare bleeds energy and eventually stalls the canopy — you get
    // one good landing flare, not a hover.
    if (chuteBrake > 0.75) stallTimer += dt;
    else stallTimer = Math.max(0, stallTimer - dt * 1.6);
    const stalled = clamp((stallTimer - 1.4) * 1.2, 0, 1);

    const glide = CHUTE_GLIDE * (1 - chuteBrake * 0.82) * (1 - stalled * 0.6);
    const sink = THREE.MathUtils.lerp(CHUTE_SINK, CHUTE_FLARE_SINK, chuteBrake * (1 - stalled)) +
      stalled * 9;

    // Target velocity under the canopy, then haul toward it. Authority ramps
    // with inflation, so the shock is felt over the opening, not applied to a
    // rag.
    _a.copy(heading).multiplyScalar(glide);
    _a.addScaledVector(_right, chuteTurn * 5.5);
    _a.y = -sink;

    const lambda = CHUTE_AUTHORITY * load;
    const k = 1 - Math.exp(-lambda * dt);
    vel.x += (_a.x - vel.x) * k;
    vel.z += (_a.z - vel.z) * k;
    // Vertical gets extra bite during the opening — that is the snap.
    const kv = 1 - Math.exp(-(lambda + (wasInflating ? 5.5 * load : 0)) * dt);
    vel.y += (_a.y - vel.y) * kv;
    // Residual gravity so it never feels weightless.
    vel.y += GRAVITY * (1 - load) * dt;
  }

  /* ---------------------------------------------------------------- *
   * 6g. Visual update — cable, wings, canopy, streaks
   * ---------------------------------------------------------------- */

  function updateCableVisual(dt: number, tip: THREE.Vector3, rest: number): void {
    const p = player();
    windRel.set(0, 0, 0);
    if (p) windRel.copy(p.velocity).multiplyScalar(-1.15);
    cable.simulate(dt, handPos, tip, rest, windRel);
    // A loaded line is a thinner line. 26 mm slack, 17 mm at full tension.
    const radius = THREE.MathUtils.lerp(0.026, 0.017, cable.tension);
    cable.skin(radius, 1.6);
    // Squeeze the braid along the line as it stretches, so the twist visibly
    // pulls out under load.
    cableMat.normalScale.set(1.15 - cable.tension * 0.5, 1.15 - cable.tension * 0.5);
  }

  const armDirL = new THREE.Vector3();
  const armDirR = new THREE.Vector3();
  const SHOULDER_L = new THREE.Vector3(-0.235, -0.10, 0.02);
  const SHOULDER_R = new THREE.Vector3(0.235, -0.10, 0.02);
  const HIP_L = new THREE.Vector3(-0.125, -0.66, 0.16);
  const HIP_R = new THREE.Vector3(0.125, -0.66, 0.16);
  const handL = new THREE.Vector3();
  const handR = new THREE.Vector3();

  /**
   * Pose and re-skin the wing membranes. All in rig space, which is glued to
   * the camera — everything here stays inside ~0.62 m of the eye so a wall
   * clipped at speed cannot swallow an arm.
   */
  function updateWings(dt: number, speed: number): void {
    flutter += dt * (14 + speed * 0.34);

    // Arm direction: out and forward when spread, in and down when tucked.
    // Bank pushes the low wing out and pulls the high wing in, which is what
    // a real flier does and reads instantly as intent.
    const spreadL = clamp(armSpread + bank * 0.28, 0, 1);
    const spreadR = clamp(armSpread - bank * 0.28, 0, 1);
    armDirL.set(
      THREE.MathUtils.lerp(-0.34, -0.88, spreadL),
      THREE.MathUtils.lerp(-0.44, -0.20, spreadL),
      THREE.MathUtils.lerp(-0.93, -0.44, spreadL),
    ).normalize();
    armDirR.set(-armDirL.x, armDirL.y, armDirL.z);

    handL.copy(SHOULDER_L).addScaledVector(armDirL, ARM_LEN);
    handR.copy(SHOULDER_R).addScaledVector(armDirR, ARM_LEN);

    armL.position.copy(SHOULDER_L);
    armL.quaternion.setFromUnitVectors(UP, armDirL);
    armR.position.copy(SHOULDER_R);
    armR.quaternion.setFromUnitVectors(UP, armDirR);

    const pos = membraneGeo.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const billow = 0.10 + clamp(speed / 90, 0, 1) * 0.06;

    for (let side = 0; side < 2; side++) {
      const shoulder = side === 0 ? SHOULDER_L : SHOULDER_R;
      const hip = side === 0 ? HIP_L : HIP_R;
      const hand = side === 0 ? handL : handR;
      const base = side * (SP + 1) * (CH + 1);
      for (let i = 0; i <= SP; i++) {
        const t = i / SP;
        // Leading edge rides the arm; trailing edge runs hip → hand.
        _a.lerpVectors(shoulder, hand, t);
        _b.lerpVectors(hip, hand, t);
        for (let j = 0; j <= CH; j++) {
          const cch = j / CH;
          _c.lerpVectors(_a, _b, cch);
          // Billow: the membrane bags downward between its two edges, most at
          // mid-chord and mid-span, and ripples at speed.
          const bag = Math.sin(Math.PI * cch) * Math.sin(Math.PI * Math.min(t * 0.92 + 0.08, 1));
          const ripple = Math.sin(t * 8.5 + flutter) * Math.sin(cch * 5.0 - flutter * 0.7) * 0.012 * (0.3 + t);
          _c.y -= bag * billow + ripple;
          _c.z += ripple * 0.5;
          const k = (base + i * (CH + 1) + j) * 3;
          arr[k] = _c.x;
          arr[k + 1] = _c.y;
          arr[k + 2] = _c.z;
        }
      }
    }
    pos.needsUpdate = true;
    membraneGeo.computeVertexNormals();
  }

  /**
   * Build the canopy surface. Local space: +X spanwise, -Z is the direction of
   * flight, +Y up. Inflation blends span, chord and cell bulge together from a
   * streamered rag to a pressurised wing.
   */
  function updateCanopy(dt: number, elapsed: number): void {
    const pos = canopyGeo.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const infl = inflate;
    const halfSpan = THREE.MathUtils.lerp(0.7, 3.35, infl);
    const chordLen = THREE.MathUtils.lerp(0.6, 2.55, infl);
    // Anhedral arc: a real ram-air hangs in a shallow arc, tips low.
    const arc = 0.72 * infl;
    const cells = 9;

    for (let i = 0; i <= tier.span; i++) {
      const s = (i / tier.span) * 2 - 1; // -1..1 spanwise
      for (let j = 0; j <= tier.chord; j++) {
        const c = j / tier.chord; // 0 = nose, 1 = tail
        let x = s * halfSpan;
        let z = (c - 0.35) * chordLen;
        // Aerofoil: thick nose, thin tail, cambered.
        let y = -arc * s * s;
        y += Math.sin(Math.PI * Math.pow(c, 0.72)) * 0.30 * infl;
        // Cell bulge between the ribs — the scalloped underside.
        const cell = ((s + 1) * 0.5) * cells;
        y -= Math.abs(Math.sin(cell * Math.PI)) * 0.055 * infl * Math.sin(Math.PI * c);
        // Turn: the inside wing dips and the whole canopy skews.
        y -= chuteTurn * s * 0.42 * infl;
        // Brakes haul the tail down.
        if (c > 0.62) {
          const tail = (c - 0.62) / 0.38;
          y -= chuteBrake * tail * tail * 0.85 * infl;
          z += chuteBrake * tail * 0.18 * infl;
        }
        // Breathing: pressurised fabric is never still.
        const breathe = Math.sin(s * 4.1 + elapsed * 3.1) * Math.sin(c * 3.3 - elapsed * 2.2);
        y += breathe * 0.035 * infl;
        x += breathe * 0.012;

        const k = (i * (tier.chord + 1) + j) * 3;
        arr[k] = x;
        arr[k + 1] = y + 0.2;
        arr[k + 2] = z;
      }
    }
    pos.needsUpdate = true;
    canopyGeo.computeVertexNormals();

    // --- Riser lines --------------------------------------------------
    // Recomputed in world space so they can sag independently of the canopy's
    // transform, and so they connect to the harness, not to a bone.
    chuteRoot.updateMatrixWorld(true);
    const p = player();
    _f.copy(p ? p.position : canopyPos);
    _f.y += 1.35; // harness, roughly at the chest
    let w = 0;
    for (let r = 0; r < RISERS; r++) {
      const side = r < RISERS / 2 ? -1 : 1;
      const k = r % (RISERS / 2);
      const s = side * (0.24 + (k / (RISERS / 2 - 1)) * 0.72);
      const c = k % 2 === 0 ? 0.22 : 0.78;
      _a.set(s * halfSpan, -arc * s * s + 0.2, (c - 0.35) * chordLen);
      chuteRoot.localToWorld(_a);
      for (let seg = 0; seg < RISER_SEG; seg++) {
        const t0 = seg / RISER_SEG;
        const t1 = (seg + 1) / RISER_SEG;
        for (const t of [t0, t1]) {
          _b.lerpVectors(_a, _f, t);
          // Sag: a line under light load bows, and the bow scales down as the
          // canopy loads up.
          _b.y -= Math.sin(Math.PI * t) * 0.10 * (1 - infl * 0.75);
          riserPos[w++] = _b.x;
          riserPos[w++] = _b.y;
          riserPos[w++] = _b.z;
        }
      }
    }
    (riserGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    void dt;
  }

  /**
   * Speed lines. World-space segments recycled through a ring of radius ~14 m
   * around the eye, each drawn along the *relative wind* so they read as air
   * going past rather than as confetti.
   */
  function updateStreaks(dt: number, intensity: number): void {
    if (STREAKS === 0) {
      streaks.visible = false;
      return;
    }
    const p = player();
    if (!p || intensity <= 0.01) {
      streaks.visible = false;
      return;
    }
    streaks.visible = true;
    const vel = p.velocity;
    const speed = vel.length();
    if (speed < 1e-3) return;
    _a.copy(vel).divideScalar(speed);
    const active = Math.round(STREAKS * clamp(intensity, 0, 1));
    const len = 2.5 + speed * 0.22;

    for (let i = 0; i < STREAKS; i++) {
      const k = i * 3;
      streakLife[i] -= dt;
      if (i >= active || streakLife[i] <= 0) {
        if (i < active) {
          // Respawn on a disc ahead of the eye, spread wide enough that the
          // streaks sweep past at the screen edges.
          const ang = rng() * Math.PI * 2;
          const rad = 2.2 + rng() * 12;
          _b.set(0, 1, 0);
          if (Math.abs(_b.dot(_a)) > 0.94) _b.set(1, 0, 0);
          _c.crossVectors(_a, _b).normalize();
          _d.crossVectors(_c, _a).normalize();
          _e.copy(camera.position)
            .addScaledVector(_a, 6 + rng() * 26)
            .addScaledVector(_c, Math.cos(ang) * rad)
            .addScaledVector(_d, Math.sin(ang) * rad);
          streakP[k] = _e.x;
          streakP[k + 1] = _e.y;
          streakP[k + 2] = _e.z;
          streakLife[i] = 0.35 + rng() * 0.5;
        } else {
          // Parked off-screen and black: costs nothing, draws nothing.
          streakPos[i * 6] = streakPos[i * 6 + 3] = 0;
          streakPos[i * 6 + 1] = streakPos[i * 6 + 4] = -1e5;
          streakPos[i * 6 + 2] = streakPos[i * 6 + 5] = 0;
          continue;
        }
      }
      const x = streakP[k];
      const y = streakP[k + 1];
      const z = streakP[k + 2];
      const o = i * 6;
      streakPos[o] = x;
      streakPos[o + 1] = y;
      streakPos[o + 2] = z;
      streakPos[o + 3] = x - _a.x * len;
      streakPos[o + 4] = y - _a.y * len;
      streakPos[o + 5] = z - _a.z * len;
      // Fade in and out over the life so nothing ever pops.
      const life = streakLife[i];
      const fade = Math.min(1, life * 4) * Math.min(1, (0.85 - life) * 6 + 1) * intensity;
      const g = clamp(fade, 0, 1) * 0.85;
      streakCol[o] = g * 0.72;
      streakCol[o + 1] = g * 0.86;
      streakCol[o + 2] = g;
      streakCol[o + 3] = 0;
      streakCol[o + 4] = 0;
      streakCol[o + 5] = 0;
    }
    (streakGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (streakGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  /* ---------------------------------------------------------------- *
   * 6h. Frame
   * ---------------------------------------------------------------- */

  let hudTimer = 0;

  const sys: System = {
    name: "traversal",

    update(dt) {
      const p = ctx.services.player;
      if (!p) return;
      const input = ctx.input;
      cooldown = Math.max(0, cooldown - dt);
      boostWindow = Math.max(0, boostWindow - dt);

      // Yaw rate drives banking and canopy steering. The controller has
      // already written the camera this frame, so this is current.
      const yawNow = camera.rotation.y;
      let dYaw = yawNow - lastYaw;
      while (dYaw > Math.PI) dYaw -= Math.PI * 2;
      while (dYaw < -Math.PI) dYaw += Math.PI * 2;
      lastYaw = yawNow;
      yawRate = approach(yawRate, dt > 1e-4 ? dYaw / dt : 0, 18, dt);

      // The winch muzzle sits at the right hip, so the cable enters frame from
      // the lower right the way the viewmodel arm would.
      camera.getWorldDirection(_fwd).normalize();
      _right.crossVectors(_fwd, UP);
      if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
      _right.normalize();
      _a.crossVectors(_right, _fwd).normalize();
      handPos
        .copy(camera.position)
        .addScaledVector(_right, 0.26)
        .addScaledVector(_a, -0.24)
        .addScaledVector(_fwd, 0.18);

      // --- Dead players do not fly -------------------------------------
      if (p.health <= 0) {
        if (mode !== "idle") resetAll("air");
        wingRig.visible = false;
        chuteRoot.visible = cutaway > 0;
        return;
      }

      const groundY = terrain?.heightAt(p.position.x, p.position.z) ?? 0;
      const altitude = p.position.y - groundY;
      const airborne = altitude > DEPLOY_CLEARANCE;

      // --- Input ---------------------------------------------------------
      const wantGrapple = input.pressed.has("KeyQ");
      const wantWing = input.pressed.has("KeyF");
      const wantChute = input.pressed.has("KeyE") || (input.pressed.has("Space") && mode !== "attached" && airborne);
      const wantRelease = input.pressed.has("Space") && mode === "attached";

      if (wantGrapple) {
        // Re-firing while attached is the chaining move: it swaps anchors in
        // one keypress instead of making you let go first.
        if (mode === "attached") {
          releaseGrapple(0);
          stowHook();
          fireHook();
        } else if (mode === "flying") {
          mode = "returning";
        } else {
          if (mode === "parachute") cutCanopy();
          fireHook();
        }
      }
      if (wantRelease) {
        releaseGrapple(2.2);
      }
      if (wantWing) {
        if (mode === "wingsuit") {
          mode = "idle";
          if (p.state === "wingsuit") setState("air");
        } else if (airborne) {
          enterWingsuit();
        }
      }
      if (wantChute && mode !== "parachute" && airborne) {
        enterParachute();
      }

      // --- Hook flight -----------------------------------------------------
      if (mode === "flying") {
        const step = HOOK_SPEED * dt;
        hookTravel += step;
        hookPos.addScaledVector(hookVel, dt);
        // Gravity droop over long shots, so a 300 m throw arcs.
        hookVel.y += GRAVITY * 0.18 * dt;
        if (hookTravel >= flightRange) {
          if (flightRange >= GRAPPLE_RANGE * 0.54) mode = "returning"; // it was a miss
          else {
            hookPos.copy(anchor);
            attach();
          }
        }
      } else if (mode === "returning") {
        _b.subVectors(handPos, hookPos);
        const d = _b.length();
        if (d < 1.2) stowHook();
        else hookPos.addScaledVector(_b.divideScalar(d), Math.min(d, HOOK_RETURN * dt));
      }

      // --- Flight models ----------------------------------------------------
      if (mode === "attached") updateGrapple(dt);
      else if (mode === "wingsuit") updateWingsuit(dt);
      else if (mode === "parachute") updateParachute(dt);
      else if (boostWindow > 0) {
        // Brief anti-gravity right after a launch, so the arc over the parapet
        // is generous instead of technically-correct-but-annoying.
        p.velocity.y -= GRAVITY * 0.32 * dt;
      }

      // --- Ground contact ---------------------------------------------------
      // The controller clamps us to the terrain but will not leave our state,
      // so touchdown is detected here.
      if (altitude <= 0.35 && p.velocity.y <= 0.1) {
        if (mode === "parachute") {
          cutCanopy();
          ctx.services.audio?.play("chute", { volume: 0.35, rate: 1.5 });
        } else if (mode === "wingsuit") {
          mode = "idle";
          if (p.state === "wingsuit") setState("air");
        } else if (mode === "attached" && anchor.y < p.position.y + 1.5) {
          // Reeling into the deck: let go rather than grind along it.
          releaseGrapple(0);
        }
      }
      if (terrain && p.position.y < terrain.seaLevel && mode !== "idle") {
        resetAll("air");
      }

      // --- HUD ----------------------------------------------------------------
      hudTimer -= dt;
      if (hudTimer <= 0) {
        hudTimer = 1 / 20;
        ctx.emit("palmas:traversal", {
          mode,
          attached: mode === "attached",
          cable: mode === "attached" ? cableLen : 0,
          distance: mode === "attached" || mode === "flying" ? p.position.distanceTo(anchor) : 0,
          tension: cable.tension,
          anchor: mode === "attached" ? [anchor.x, anchor.y, anchor.z] : null,
          speed: p.velocity.length(),
          altitude,
          bank,
          inflation: mode === "parachute" ? inflate : 0,
          brake: chuteBrake,
          ready: cooldown <= 0 && mode === "idle",
        });
      }
    },

    /**
     * Everything camera-relative happens here: weapons has already stowed
     * itself for our states, and we boot after it, so this is the last word on
     * FOV and roll.
     */
    lateUpdate(dt) {
      const p = ctx.services.player;
      const elapsed = ctx.elapsed;
      if (!p) return;
      const speed = p.velocity.length();

      // --- Cable + hook -------------------------------------------------
      if (mode === "flying" || mode === "returning" || mode === "attached") {
        const tip = mode === "attached" ? anchor : hookPos;
        // Slack: the line pays out behind a flying hook, and is hauled taut
        // once the winch takes the load.
        let rest: number;
        if (mode === "attached") {
          rest = cableLen * (1.0 + 0.055 * (1 - cable.tension));
        } else {
          rest = handPos.distanceTo(tip) * 1.14 + 0.5;
        }
        updateCableVisual(dt, tip, rest);
        cable.mesh.visible = true;

        hook.position.copy(tip);
        if (mode === "attached") {
          // Bitten in: point the claw into the surface it caught.
          _a.copy(anchorNormal);
          if (_a.lengthSq() < 1e-6) _a.set(0, 1, 0);
          hook.quaternion.setFromUnitVectors(_c.set(0, 0, 1), _a.normalize());
        } else {
          _a.copy(mode === "flying" ? hookVel : _b.subVectors(handPos, hookPos));
          if (_a.lengthSq() > 1e-6) {
            _a.normalize();
            _quat2.setFromUnitVectors(_c.set(0, 0, 1), _a);
            hook.quaternion.copy(_quat2);
            // Spin about its axis in flight — it reads as thrown, not floated.
            _quat.setFromAxisAngle(_c.set(0, 0, 1), elapsed * 14);
            hook.quaternion.multiply(_quat);
          }
        }
        hook.visible = true;
      } else {
        cable.mesh.visible = false;
        hook.visible = false;
      }

      // --- Wingsuit rig ---------------------------------------------------
      const wingOn = mode === "wingsuit";
      wingRig.visible = wingOn;
      if (wingOn) {
        updateWings(dt, speed);
        wingRig.position.copy(camera.position);
        wingRig.quaternion.copy(camera.quaternion);
        wingRig.updateMatrix();
        wingRig.updateMatrixWorld(true);
      }

      // --- Canopy ----------------------------------------------------------
      if (mode === "parachute") {
        chuteRoot.visible = true;
        risers.visible = true;
        // The canopy leads the swing: it lags the harness horizontally, which
        // is exactly the pendulum a real jumper feels.
        _a.copy(p.position).addScaledVector(UP, CANOPY_HEIGHT);
        _b.copy(p.velocity);
        _b.y = 0;
        canopyLag.lerp(_b.multiplyScalar(-0.055), 1 - Math.exp(-4 * dt));
        canopyPos.lerp(_a.add(canopyLag), 1 - Math.exp(-11 * dt));
        chuteRoot.position.copy(canopyPos);
        _euler.set(
          clamp(-p.velocity.y * 0.012, -0.25, 0.25) - 0.06,
          Math.atan2(heading.x, heading.z) + Math.PI,
          -chuteTurn * 0.36,
          "YXZ",
        );
        chuteRoot.quaternion.setFromEuler(_euler);
        canopyMat.opacity = 1;
        updateCanopy(dt, elapsed);
      } else if (cutaway > 0) {
        // Cut away: tumble off downwind and fade. Costs one draw call for a
        // second and a half and sells the whole transition.
        cutaway -= dt;
        cutVel.y += GRAVITY * 0.12 * dt;
        cutVel.multiplyScalar(1 - 0.6 * dt);
        chuteRoot.position.addScaledVector(cutVel, dt);
        chuteRoot.rotateZ(dt * 1.6);
        chuteRoot.rotateX(dt * 0.7);
        inflate = Math.max(0, inflate - dt * 0.9);
        canopyMat.opacity = clamp(cutaway / 1.5, 0, 1);
        updateCanopy(dt, elapsed);
        chuteRoot.visible = cutaway > 0;
        risers.visible = false;
      } else {
        chuteRoot.visible = false;
        risers.visible = false;
      }

      // --- Speed lines -------------------------------------------------------
      let streakAmt = 0;
      if (mode === "wingsuit") streakAmt = smoothstep(26, 72, speed);
      else if (mode === "attached") streakAmt = smoothstep(30, 60, speed) * 0.7;
      else if (mode === "parachute") streakAmt = smoothstep(34, 60, speed) * 0.4;
      updateStreaks(dt, streakAmt);

      // --- Camera: FOV + roll ------------------------------------------------
      const owns =
        p.state === "grapple" || p.state === "wingsuit" || p.state === "parachute";
      if (owns) {
        let targetFov = BASE_FOV;
        let targetRoll = 0;
        if (mode === "attached") {
          // FOV kicks with the reel-in rate, not raw speed — the shove you
          // feel is the winch, so that is what the lens should react to.
          _a.subVectors(anchor, p.position);
          const dist = _a.length();
          if (dist > 1e-4) _a.divideScalar(dist);
          const closing = Math.max(0, p.velocity.dot(_a));
          targetFov = BASE_FOV + clamp(closing * 0.42, 0, 17) + cable.tension * 3.5;
          // Roll into the swing: lean toward whichever way you are being
          // carried laterally.
          camera.getWorldDirection(_fwd);
          _right.crossVectors(_fwd, UP).normalize();
          targetRoll = clamp(-p.velocity.dot(_right) / 44, -0.34, 0.34);
        } else if (mode === "wingsuit") {
          targetFov = BASE_FOV + clamp((speed - 22) * 0.52, 0, 27);
          targetRoll = -bank * 0.72;
        } else if (mode === "parachute") {
          targetFov = BASE_FOV + clamp((speed - 16) * 0.22, 0, 9) + (1 - inflate) * 6;
          targetRoll = -chuteTurn * 0.20;
        }
        fov = approach(fov, targetFov, 6, dt);
        roll = approach(roll, targetRoll, 7, dt);
        camera.rotation.z = roll;
        if (Math.abs(camera.fov - fov) > 0.01) {
          camera.fov = fov;
          camera.updateProjectionMatrix();
        }
      } else {
        // Hand the lens back gracefully rather than snapping.
        fov = approach(fov, camera.fov, 10, dt);
        roll = approach(roll, 0, 8, dt);
      }
    },

    dispose() {
      for (const o of objects) {
        o.parent?.remove(o);
      }
      cable.dispose();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
    },
  };

  return sys;
};

export default createTraversal;
