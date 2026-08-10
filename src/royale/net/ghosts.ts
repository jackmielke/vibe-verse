/**
 * SPLASH ROYALE — remote player rendering ("ghosts").
 *
 * `net.ts` gets other people's positions into this browser. This file is the
 * reason you can see them. Without it multiplayer is a chat log with a
 * physics engine attached.
 *
 * ── What it is ────────────────────────────────────────────────────────────
 * A read-only System. It publishes no packets, owns no gameplay state and
 * arbitrates nothing: every frame it reads `ctx.services.net.peers` — already
 * interpolated by the transport — and makes the world agree with it. One
 * stylised humanoid per peer, animated from the motion the interpolator
 * produced, wet in proportion to `peer.dry`, with a nameplate over its head.
 *
 * ── Why it is built out of InstancedMesh ──────────────────────────────────
 * A chunky humanoid is ~18 pieces. A dozen peers is 216 objects, and at one
 * draw call each that is a quarter of the entire frame budget spent on
 * people standing around. So the rig is inverted: one InstancedMesh per body
 * PART, shared across every ghost, with each ghost writing its 18 matrices
 * into those shared buffers. Twelve part meshes, one droplet pool, one glue
 * strand pool, plus a quad per nameplate — about thirty draw calls for a full
 * lobby, and flat in the number of peers for everything except the plates.
 *
 * Per-ghost colour rides on `instanceColor`, which three multiplies into
 * albedo for free. Per-ghost WETNESS rides on a custom instanced float
 * (`aWet`) injected into the standard material, because the whole art
 * direction of this mode says water reads as gloss, not as blue paint — and
 * roughness is not something `instanceColor` can carry.
 *
 * ── Cost when nobody is online ────────────────────────────────────────────
 * Zero. Nothing is allocated until the first peer with an actual pose shows
 * up, so `/drop-zero` — single-player, live, and not to be regressed — never
 * pays for a mesh, a texture or a shader compile from this file.
 *
 * ── Timing ────────────────────────────────────────────────────────────────
 * Everything is measured in SIMULATED seconds: `ctx.elapsed` and the `dt`
 * handed to `update`/`fixed`. Under SwiftSHADER this container simulates
 * ~400x slower than wall clock, so a gait cycle keyed off `performance.now()`
 * would spin like a cartoon. There is not one wall-clock read in this file.
 */
import * as THREE from "three";
import { makeRng, type DamageTarget, type System, type SystemFactory, type WorldCtx } from "../types";
import type { PeerState } from "./types";
import { DRYNESS, GLUE, WATER_BALLOON, drynessBand } from "../mode/water";

/* ------------------------------------------------------------------------ *
 * Contract
 * ------------------------------------------------------------------------ */

/**
 * What other systems may ask the ghost renderer for.
 *
 * Deliberately tiny and entirely read-only-ish: this system is a *view* of
 * `net.peers`, and the moment it starts owning gameplay truth there are two
 * copies of where everybody is. `anchor()`/`head()` exist because weapons,
 * combat and the glue system all need a world point to aim a splash at and
 * none of them should be re-deriving a torso height from a raw peer packet.
 */
export interface GhostsService {
  /** Ghosts drawn this frame. */
  readonly count: number;
  /** Chest-height world point for a peer, or null if they are not drawn. */
  anchor(peerId: string, out?: THREE.Vector3): THREE.Vector3 | null;
  /** Head world point for a peer, or null. Faceful hits, camera focus. */
  head(peerId: string, out?: THREE.Vector3): THREE.Vector3 | null;
  /** Throw a burst of droplets at a peer (or a world point). Cosmetic only. */
  splash(at: string | THREE.Vector3, strength?: number): void;
  /**
   * Draw a glue strand between two endpoints for `seconds`. Endpoints are
   * peer ids, `net.selfId`, or a fixed world point. Idempotent per pair — a
   * second call re-arms the same strand rather than stacking one on top.
   */
  link(a: string | THREE.Vector3, b: string | THREE.Vector3, seconds?: number): void;
  /** Remove a strand between two endpoints, if there is one. */
  unlink(a: string | THREE.Vector3, b: string | THREE.Vector3): void;
}

declare module "../types" {
  interface WorldServices {
    /**
     * Remote-player rendering. Absent until the first peer arrives — a solo
     * match never boots it, which is how `/drop-zero` stays untouched.
     */
    ghosts?: GhostsService;
  }
}

/* ------------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------------ */

/** Hard ceiling on simultaneously rendered peers. Buffers size off this. */
const MAX_GHOSTS = 16;

/**
 * The hit capsule a remote player presents, mirroring the local one in
 * `play/player.ts` (RADIUS, STAND_HEIGHT, STAND_EYE).
 *
 * Deliberately the standing figures rather than anything crouch-aware: the
 * pose a ghost is *drawn* in comes from a smoothed blend of packets, so a
 * capsule that chased it would shrink and grow a few frames behind what the
 * shooter can see. A fixed capsule is honest about that latency instead of
 * pretending to a precision the wire cannot deliver.
 */
const GHOST_RADIUS = 0.4;
const GHOST_HEIGHT = 1.85;
const GHOST_HEAD_Y = 1.62;

/** Body proportions, metres, feet at y = 0. Matches the player's 1.85 m. */
const BODY = {
  height: 1.85,
  hipY: 1.06,
  /** Hip → knee and knee → ankle, both legs. */
  thigh: 0.44,
  shin: 0.44,
  ankleY: 0.18,
  hipX: 0.155,
  shoulderY: 1.5,
  shoulderX: 0.35,
  upperArm: 0.32,
  foreArm: 0.32,
  neckY: 1.54,
  headY: 1.68,
} as const;

/** Distance bands for the level of detail. Metres from the camera. */
const LOD_NEAR = 40;
const LOD_MID = 110;
/** Past this a peer is not drawn at all — they are a pixel and a nameplate. */
const LOD_CULL = 460;

/** Nameplates: full opacity out to `PLATE_FULL`, gone by `PLATE_FADE`. */
const PLATE_FULL = 55;
const PLATE_FADE = 115;

/** Metres a full gait cycle (two steps) covers. Sets cadence against speed. */
const STRIDE_CYCLE = 2.0;

/** Droplet pool. A dozen dripping ghosts is ~30 live drops at any moment. */
const DROP_CAP = 384;
/** Splash-ring pool — the join/leave flourish and heavy impacts. */
const RING_CAP = 8;
/** Glue strands drawn at once, and the segments each is built from. */
const STRAND_CAP = 6;
const STRAND_SEGMENTS = GLUE.segments;

/** Gravity on a falling droplet, m/s². Heavier than air drag deserves. */
const DROP_GRAVITY = 17.5;

/**
 * Squad colour: a fixed saturation and lightness, with only the hue varying.
 *
 * Pinning S and L is what keeps every possible outcome on-art — bright,
 * sunny, block-party, never a muddy olive or a washed-out pastel — while
 * leaving the hue free to carry the identity.
 */
const TEAM_SAT = 0.74;
const TEAM_LIGHT = 0.585;

/* ------------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------------ */

const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Frame-rate-independent exponential smoothing toward `to`. */
const approach = (from: number, to: number, rate: number, dt: number) =>
  from + (to - from) * (1 - Math.exp(-rate * dt));

/** FNV-1a. Stable across clients — that is the whole requirement. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The states a peer can publish, folded into the handful of poses the rig
 * actually knows how to strike.
 *
 * `NetPose.state` is a free string on purpose (see `net/types.ts`) — SPLASH ROYALE
 * adds states DROP ZERO never had, and more will arrive. Anything unknown
 * lands on "ground", which is a walk cycle, which is never a T-pose. That
 * fallback is the entire reason this is a lookup and not a switch.
 */
type Pose = "ground" | "air" | "skydive" | "glide" | "crouch" | "swim" | "down" | "prone";

function poseFor(state: string, dry: number): Pose {
  switch (state) {
    case "bus":
    case "skydive":
      return "skydive";
    case "glide":
      return "glide";
    case "air":
    case "jump":
      return "air";
    case "crouch":
      return "crouch";
    case "swim":
      return "swim";
    case "down":
    case "dead":
    case "soaked":
    case "waterlogged":
      return "down";
    case "stumble":
    case "fallen":
    case "tripped":
      return "prone";
    default:
      // Belt and braces: a peer at zero dryness is out, whatever string their
      // client sent. Someone standing bolt upright at 0% reads as a bug.
      return dry <= 0.001 ? "down" : "ground";
  }
}

/* ------------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------------ */

/** Index into the part-mesh array. Order is authoring order, nothing more. */
const P_HEAD = 0;
const P_CAP = 1;
const P_BRIM = 2;
const P_TORSO = 3;
const P_HIPS = 4;
const P_ARM_U = 5;
const P_ARM_L = 6;
const P_HAND = 7;
const P_LEG_U = 8;
const P_LEG_L = 9;
const P_SHOE = 10;
const P_PACK = 11;
const PART_COUNT = 12;

/** Which palette slot a part takes its colour and its base roughness from. */
type Slot = "skin" | "shirt" | "shorts" | "gear";

interface PartSpec {
  name: string;
  slot: Slot;
  /** Instances of this part per ghost — 1 for the torso, 2 for a leg. */
  per: number;
  /** Nominal length along local Y, for capsules that get stretched by LOD. */
  nominal: number;
  castShadow: boolean;
  build(): THREE.BufferGeometry;
}

/**
 * The parts, in full.
 *
 * Capsules for limbs, boxes for the blocky bits, a sphere for the head: chunky
 * Fortnite proportions where the silhouette is legible at 200 m and the joints
 * are all spheres so a bent elbow never shows a seam. Segment counts are as
 * low as they can go and still round — at LOD_NEAR a limb is 40 px tall.
 */
const PARTS: readonly PartSpec[] = [
  {
    name: "head",
    slot: "skin",
    per: 1,
    nominal: 1,
    castShadow: true,
    // Slightly squashed sphere: a perfectly round head reads as a snowman.
    build: () => new THREE.SphereGeometry(0.2, 14, 10).scale(1, 0.94, 0.96),
  },
  {
    name: "cap",
    // Team-coloured, not gear-coloured: a dark crown reads as a helmet, and
    // this is a block party. A squad-coloured cap is also the highest thing
    // on the silhouette, which makes it the part that identifies a squad
    // first when someone peeks over a wall.
    slot: "shirt",
    per: 1,
    nominal: 1,
    castShadow: true,
    build: () => new THREE.SphereGeometry(0.205, 14, 6, 0, TAU, 0, Math.PI * 0.52).scale(1, 0.95, 1),
  },
  {
    name: "brim",
    slot: "gear",
    per: 1,
    nominal: 1,
    castShadow: false,
    build: () => new THREE.BoxGeometry(0.34, 0.045, 0.22),
  },
  {
    name: "torso",
    slot: "shirt",
    per: 1,
    nominal: 1,
    castShadow: true,
    // Wider at the shoulders than the waist — the taper is what makes a box
    // read as a person rather than a fridge.
    build: () => taperedBox(0.62, 0.46, 0.36, 0.78),
  },
  {
    name: "hips",
    slot: "shorts",
    per: 1,
    nominal: 1,
    castShadow: true,
    build: () => new THREE.BoxGeometry(0.5, 0.26, 0.34),
  },
  {
    name: "armUpper",
    slot: "shirt",
    per: 2,
    nominal: BODY.upperArm,
    castShadow: true,
    build: () => new THREE.CapsuleGeometry(0.105, BODY.upperArm, 2, 8),
  },
  {
    name: "armLower",
    slot: "skin",
    per: 2,
    nominal: BODY.foreArm,
    castShadow: false,
    build: () => new THREE.CapsuleGeometry(0.092, BODY.foreArm, 2, 8),
  },
  {
    name: "hand",
    slot: "skin",
    per: 2,
    nominal: 1,
    castShadow: false,
    build: () => new THREE.SphereGeometry(0.1, 8, 6),
  },
  {
    name: "legUpper",
    slot: "shorts",
    per: 2,
    nominal: BODY.thigh,
    castShadow: true,
    build: () => new THREE.CapsuleGeometry(0.145, BODY.thigh, 2, 8),
  },
  {
    name: "legLower",
    slot: "skin",
    per: 2,
    nominal: BODY.shin,
    castShadow: true,
    build: () => new THREE.CapsuleGeometry(0.118, BODY.shin, 2, 8),
  },
  {
    name: "shoe",
    slot: "gear",
    per: 2,
    nominal: 1,
    castShadow: true,
    // Offset forward in the geometry so the ankle sits at the heel, which is
    // where an ankle is. Feet centred on the joint look like flippers.
    build: () => new THREE.BoxGeometry(0.24, 0.15, 0.4).translate(0, 0, -0.07),
  },
  {
    name: "tank",
    slot: "gear",
    per: 1,
    nominal: 1,
    castShadow: true,
    // The water tank on their back. Reads instantly as "this is a water
    // fight" from behind, which is the angle you see most of in a chase.
    build: () => new THREE.CylinderGeometry(0.135, 0.135, 0.42, 10, 1),
  },
];

/** A box whose top face is `topScale` of the bottom. Cheap taper, no lathe. */
function taperedBox(w: number, h: number, d: number, topScale: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d, 1, 1, 1);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    // +h/2 is the top ring; scale x/z toward `topScale` as y climbs.
    const t = (y + h / 2) / h;
    const k = 1 + (topScale - 1) * (1 - t);
    pos.setX(i, pos.getX(i) * k);
    pos.setZ(i, pos.getZ(i) * k);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/* ------------------------------------------------------------------------ *
 * Materials
 * ------------------------------------------------------------------------ */

/**
 * Wetness, injected into the standard material.
 *
 * `instanceColor` already darkens a wet shirt for free, but darkening alone
 * reads as "someone turned the lights down". What actually says *wet* is the
 * specular: a soaked surface is smoother than a dry one, so the sun picks out
 * a hard highlight along every edge of it. That is per-instance roughness,
 * which three has no built-in channel for, so we add one.
 *
 * `customProgramCacheKey` is set explicitly rather than leaning on the default
 * (which stringifies `onBeforeCompile`) so that a minifier renaming locals can
 * never split this into two identical programs.
 */
function injectWetness(m: THREE.MeshStandardMaterial): void {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = `attribute float aWet;\nvarying float vWet;\n${shader.vertexShader}`.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n\tvWet = aWet;",
    );
    shader.fragmentShader = `varying float vWet;\n${shader.fragmentShader}`.replace(
      "#include <roughnessmap_fragment>",
      // 0.055 is a wet-plastic gloss. Going lower turns a drenched player into
      // a mirror, which is funny for one frame and unreadable after that.
      "#include <roughnessmap_fragment>\n\troughnessFactor = mix(roughnessFactor, 0.055, clamp(vWet, 0.0, 1.0));",
    );
  };
  m.customProgramCacheKey = () => "soaked-ghost-wet-v1";
}

/** Base roughness per palette slot, dry. Variation here is what avoids plastic. */
const SLOT_ROUGHNESS: Record<Slot, number> = {
  skin: 0.68,
  shirt: 0.88,
  shorts: 0.82,
  gear: 0.52,
};

/**
 * How much a soaked surface darkens, per slot. Cotton drinks water and goes
 * two stops down; skin barely changes; rubber and plastic gear hardly at all.
 * Getting this ratio right is most of why a drenched ghost reads as drenched
 * rather than as a ghost standing in shade.
 */
const SLOT_WET_DARKEN: Record<Slot, number> = {
  skin: 0.18,
  shirt: 0.58,
  shorts: 0.54,
  gear: 0.3,
};

/* ------------------------------------------------------------------------ *
 * Nameplate shader
 * ------------------------------------------------------------------------ */

const PLATE_W = 1.75;
const PLATE_H = 0.6;
const PLATE_TEX_W = 256;
const PLATE_TEX_H = 64;

const PLATE_VERT = /* glsl */ `
uniform float uW;
uniform float uH;
varying vec2 vUv;

void main() {
  vUv = uv;
  // Billboard in view space off the object's origin, so the plate never
  // rolls with the camera and never shears at the edge of a wide FOV.
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float dist = max(-mv.z, 0.001);
  // Constant angular size out to 22 m, then a slow grow so a plate at 80 m is
  // still legible without a lobby's worth of them tiling the sky.
  float scale = clamp(dist / 22.0, 1.0, 3.0);
  mv.xy += position.xy * vec2(uW, uH) * scale;
  gl_Position = projectionMatrix * mv;
}
`;

/**
 * NOTE, and it cost this project a day once already: do NOT add
 * `#include <colorspace_pars_fragment>` here. three r160's WebGLProgram
 * prepends that chunk to every non-raw ShaderMaterial, so including it again
 * declares its functions twice and the whole fragment shader fails to link —
 * the plates then render as absolutely nothing, silently. The *tonemapping*
 * pars include is different and must stay: this material sets
 * `toneMapped: false`, so three skips prepending that one.
 */
const PLATE_FRAG = /* glsl */ `
precision highp float;
#include <common>
#include <tonemapping_pars_fragment>

uniform sampler2D uMap;
uniform vec3 uTeam;
uniform vec3 uBand;
uniform float uDry;
uniform float uFade;
uniform float uAgent;
uniform float uDown;
varying vec2 vUv;

float sdRound(vec2 p, vec2 b, float r) {
  vec2 d = abs(p) - b + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

void main() {
  if (uFade <= 0.004) discard;

  vec3 col = vec3(0.0);
  float alpha = 0.0;

  // ---- name -------------------------------------------------------------
  // The atlas holds the glyph in .r and a fat dilated copy in .g, used as a
  // soft dark halo. Flat white text over a sunlit beach is unreadable, and an
  // outline stroke thickens the letterforms; a halo does neither.
  float ty = (vUv.y - 0.40) / 0.60;
  if (ty > 0.0 && ty < 1.0) {
    vec4 tex = texture2D(uMap, vec2(vUv.x, ty));
    float glyph = tex.r;
    float halo = tex.g;
    vec3 tint = mix(vec3(1.0), uTeam, 0.5);
    tint = mix(tint, vec3(1.0, 0.88, 0.45), uAgent * 0.55);
    tint = mix(tint, vec3(0.55, 0.72, 0.9), uDown * 0.8);
    col += vec3(0.012) * halo * (1.0 - glyph);
    col += tint * glyph;
    alpha = max(halo * 0.5, glyph);
  }

  vec2 p = vec2(vUv.x - 0.5, vUv.y);

  // ---- dryness bar ------------------------------------------------------
  // Not a health bar. Full means bone dry; empty means they are out.
  const float barW = 0.42;
  float d = sdRound(vec2(p.x, p.y - 0.235), vec2(barW, 0.048), 0.034);
  float mask = 1.0 - smoothstep(0.0, 0.013, d);
  if (mask > 0.001) {
    vec3 track = vec3(0.035, 0.045, 0.062);
    float filled = step(p.x, -barW + clamp(uDry, 0.0, 1.0) * barW * 2.0);
    vec3 bar = mix(track, uBand, filled);
    // Highlight along the top of the fill: makes it a solid object catching
    // the sun instead of a coloured rectangle.
    bar += uBand * filled * smoothstep(0.030, 0.052, p.y - 0.235) * 0.55;
    col = mix(col, bar, mask);
    alpha = max(alpha, mask);
  }

  // ---- team stripe ------------------------------------------------------
  // A hairline under the bar in the squad colour. Two squadmates share it;
  // their names and their bars still tell them apart.
  float ds = sdRound(vec2(p.x, p.y - 0.115), vec2(0.26, 0.014), 0.014);
  float m2 = 1.0 - smoothstep(0.0, 0.011, ds);
  col = mix(col, uTeam, m2);
  alpha = max(alpha, m2 * 0.92);

  gl_FragColor = vec4(col, alpha * uFade);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Bake one peer's name into a two-channel data texture: red is the glyph,
 * green is the glyph plus a fat skirt. Re-baked only when the name changes,
 * which in practice is once, on join.
 */
function bakeName(text: string): THREE.CanvasTexture | null {
  const canvas = document.createElement("canvas");
  canvas.width = PLATE_TEX_W;
  canvas.height = PLATE_TEX_H;
  const c2d = canvas.getContext("2d");
  if (!c2d) return null;

  c2d.clearRect(0, 0, canvas.width, canvas.height);
  c2d.textAlign = "center";
  c2d.textBaseline = "middle";
  c2d.font = `700 ${Math.floor(PLATE_TEX_H * 0.56)}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const cx = canvas.width * 0.5;
  const cy = canvas.height * 0.5;
  const maxW = canvas.width - 14;

  // Pass 1: halo into green, by stroking fat.
  c2d.strokeStyle = "rgba(0,255,0,1)";
  c2d.lineJoin = "round";
  c2d.lineWidth = 8;
  c2d.strokeText(text, cx, cy, maxW);
  // Pass 2: the letterform itself into red, over the top. The two channels
  // stay independent because neither pass writes the other's channel.
  c2d.fillStyle = "rgba(255,255,0,1)";
  c2d.fillText(text, cx, cy, maxW);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------------ *
 * Per-ghost state
 * ------------------------------------------------------------------------ */

interface Ghost {
  id: string;
  /** Live reference into `net.peers`. Never mutated from here. */
  peer: PeerState;

  /** Rendered transform. Follows the peer, smoothed, never snaps mid-stride. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;

  /** Measured from successive interpolated positions — the animation driver. */
  speed: number;
  vy: number;
  lastX: number;
  lastY: number;
  lastZ: number;
  /** Gait phase, radians. Advances with distance travelled, never with time. */
  phase: number;
  /** Smoothed 0..1 wetness. 0 = bone dry, 1 = soaked through. */
  wet: number;
  /** Smoothed pose blend weights, so a landing is not a pop. */
  airBlend: number;
  downBlend: number;
  proneBlend: number;
  crouchBlend: number;

  /** Simulated seconds since this ghost appeared. Drives the spawn flourish. */
  age: number;
  /** Droplet spawn accumulator, in whole drops. */
  dripAccum: number;

  team: THREE.Color;
  teamHex: number;
  plate: THREE.Mesh | null;
  plateMat: THREE.ShaderMaterial | null;
  nameTex: THREE.CanvasTexture | null;
  nameText: string;

  /**
   * Standing in for this ghost in the combat system.
   *
   * The bodies are drawn from instanced meshes, so there is no per-ghost
   * `Object3D` to hand `DamageTarget` — and it only ever wants one to call
   * `getWorldPosition` on. A parentless anchor moved to the ghost's feet each
   * frame answers that exactly, without putting anything in the scene graph.
   */
  anchor: THREE.Object3D;
  target: DamageTarget | null;
  unregister: (() => void) | null;
}

/** Palette resolved per ghost, in LINEAR space — instanceColor is not sRGB. */
interface Palette {
  skin: THREE.Color;
  shirt: THREE.Color;
  shorts: THREE.Color;
  gear: THREE.Color;
}

/* ------------------------------------------------------------------------ *
 * The system
 * ------------------------------------------------------------------------ */

export const createGhostsSystem: SystemFactory = (ctx: WorldCtx): System => {
  // A private RNG. Sharing `ctx.rng` would let a cosmetic droplet shift the
  // sequence every other system draws from, which is the kind of bug that
  // only shows up as "the map is different when someone joins".
  const rng = makeRng(0x50a6ed);

  const ghosts = new Map<string, Ghost>();
  const scratch = {
    v: new THREE.Vector3(),
    v2: new THREE.Vector3(),
    q: new THREE.Quaternion(),
    m: new THREE.Matrix4(),
    root: new THREE.Matrix4(),
    dir: new THREE.Vector3(),
    up: new THREE.Vector3(0, 1, 0),
    camPos: new THREE.Vector3(),
  };
  const palette: Palette = {
    skin: new THREE.Color(),
    shirt: new THREE.Color(),
    shorts: new THREE.Color(),
    gear: new THREE.Color(),
  };

  /** Everything below is null until the first peer with a pose turns up. */
  let group: THREE.Group | null = null;
  let partMeshes: THREE.InstancedMesh[] = [];
  let partWet: THREE.InstancedBufferAttribute[] = [];
  let slotMaterials: Record<Slot, THREE.MeshStandardMaterial> | null = null;
  let plateGeo: THREE.PlaneGeometry | null = null;

  let dropMesh: THREE.InstancedMesh | null = null;
  let ringMesh: THREE.InstancedMesh | null = null;
  let strandMesh: THREE.InstancedMesh | null = null;

  /** Per-part write cursor, reset every frame. */
  const cursor = new Int32Array(PART_COUNT);

  // ---- droplet pool (SoA: one allocation, no per-drop objects) ------------
  const dPos = new Float32Array(DROP_CAP * 3);
  const dVel = new Float32Array(DROP_CAP * 3);
  const dLife = new Float32Array(DROP_CAP);
  const dSize = new Float32Array(DROP_CAP);
  const dFloor = new Float32Array(DROP_CAP);
  let dropCursor = 0;

  // ---- splash rings ------------------------------------------------------
  const rPos = new Float32Array(RING_CAP * 3);
  const rLife = new Float32Array(RING_CAP);
  const rSpan = new Float32Array(RING_CAP);
  let ringCursor = 0;

  // ---- glue strands ------------------------------------------------------
  interface Strand {
    key: string;
    a: string | THREE.Vector3;
    b: string | THREE.Vector3;
    /** Simulated seconds remaining. */
    ttl: number;
  }
  const strands: Strand[] = [];

  const unsubs: Array<() => void> = [];
  let disposed = false;

  /* ---------------------------------------------------------------- build */

  /**
   * Allocate the whole rendering apparatus. Called exactly once, lazily, the
   * first time a peer actually has a position to draw at. Everything it
   * creates is torn down in `dispose()`.
   */
  function build(): void {
    if (group) return;

    group = new THREE.Group();
    group.name = "soaked:ghosts";
    // Ghosts are placed in world space every frame; letting three re-derive a
    // parent transform for a group that never moves is pure overhead.
    group.matrixAutoUpdate = false;
    ctx.scene.add(group);

    const mats: Record<Slot, THREE.MeshStandardMaterial> = {
      skin: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: SLOT_ROUGHNESS.skin, metalness: 0.02 }),
      shirt: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: SLOT_ROUGHNESS.shirt, metalness: 0.0 }),
      shorts: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: SLOT_ROUGHNESS.shorts, metalness: 0.0 }),
      gear: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: SLOT_ROUGHNESS.gear, metalness: 0.12 }),
    };
    for (const k of Object.keys(mats) as Slot[]) injectWetness(mats[k]);
    slotMaterials = mats;

    partMeshes = [];
    partWet = [];
    for (let i = 0; i < PARTS.length; i++) {
      const spec = PARTS[i];
      const geo = spec.build();
      const capacity = MAX_GHOSTS * spec.per;
      const mesh = new THREE.InstancedMesh(geo, mats[spec.slot], capacity);
      mesh.name = `soaked:ghost-${spec.name}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = spec.castShadow;
      mesh.receiveShadow = true;
      // Ghosts are written in world space each frame; a stale bounding sphere
      // computed at the origin would frustum-cull the entire lobby.
      mesh.frustumCulled = false;
      mesh.count = 0;

      const wet = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
      wet.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute("aWet", wet);
      partWet.push(wet);

      partMeshes.push(mesh);
      group.add(mesh);
    }

    plateGeo = new THREE.PlaneGeometry(1, 1);

    // ---- droplets --------------------------------------------------------
    // Low roughness plus partial transparency is the whole trick: water reads
    // through the light it bends, never through being coloured blue.
    const dropGeo = new THREE.IcosahedronGeometry(0.05, 0);
    const dropMat = new THREE.MeshStandardMaterial({
      color: 0xdff4ff,
      roughness: 0.05,
      metalness: 0.0,
      transparent: true,
      opacity: 0.66,
      depthWrite: false,
    });
    dropMesh = new THREE.InstancedMesh(dropGeo, dropMat, DROP_CAP);
    dropMesh.name = "soaked:ghost-drips";
    dropMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    dropMesh.frustumCulled = false;
    dropMesh.count = 0;
    group.add(dropMesh);

    // ---- splash rings ----------------------------------------------------
    const ringGeo = new THREE.RingGeometry(0.62, 1.0, 26, 1).rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    ringMesh = new THREE.InstancedMesh(ringGeo, ringMat, RING_CAP);
    ringMesh.name = "soaked:ghost-splash-rings";
    ringMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    ringMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(RING_CAP * 3), 3);
    ringMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    ringMesh.frustumCulled = false;
    ringMesh.count = 0;
    group.add(ringMesh);

    // ---- glue strands ----------------------------------------------------
    const strandGeo = new THREE.CylinderGeometry(GLUE.strandRadius, GLUE.strandRadius, 1, 6, 1, true);
    const strandMat = new THREE.MeshStandardMaterial({
      color: GLUE.color,
      emissive: new THREE.Color(GLUE.glowColor),
      emissiveIntensity: 0.35,
      roughness: 0.3,
      metalness: 0.0,
      transparent: true,
      opacity: 0.9,
    });
    strandMesh = new THREE.InstancedMesh(strandGeo, strandMat, STRAND_CAP * STRAND_SEGMENTS);
    strandMesh.name = "soaked:ghost-glue";
    strandMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    strandMesh.frustumCulled = false;
    strandMesh.count = 0;
    group.add(strandMesh);
  }

  /* ------------------------------------------------------------- palettes */

  /**
   * Squad colour, then a small per-player hue jitter on top.
   *
   * The squad colour has to be identical in every client (so it is a hash of
   * the team id, not a local counter), and two squadmates have to be
   * distinguishable at a glance (so the jitter is a hash of the peer id).
   * Together: same family, different shirt.
   */
  function teamColorFor(peer: PeerState): number {
    const teamKey = peer.team ?? peer.id;
    // A CONTINUOUS hue off the hash, not an index into a fixed palette. With
    // a hand-picked palette of eight and a modulo, two different squads
    // collide roughly one match in eight — and two squads in the same colour
    // is exactly the thing this function exists to prevent. ("alpha" and
    // "bravo" collided; that is how this was found.) Sixteen bits of hue
    // makes a collision a curiosity rather than a weekly occurrence.
    const hue = ((hashString(teamKey) >>> 8) & 0xffff) / 0x10000;
    const base = new THREE.Color();
    base.setHSL(hue, TEAM_SAT, TEAM_LIGHT);
    if (peer.team) {
      // Squadmates keep the hue and separate on lightness: the same family
      // across the street, still individuals at arm's length.
      const j = ((hashString(peer.id) & 0xffff) / 0x10000 - 0.5);
      base.setHSL((hue + j * 0.03 + 1) % 1, TEAM_SAT, clamp(TEAM_LIGHT + j * 0.17, 0.4, 0.72));
    }
    return base.getHex();
  }

  /** Resolve the four slot colours for a ghost at its current wetness. */
  function resolvePalette(g: Ghost): void {
    const wet = clamp01(g.wet);
    const t = g.team;

    palette.shirt.copy(t);
    palette.shorts.copy(t).multiplyScalar(0.42).offsetHSL(0, -0.12, 0);
    // Skin is a warm neutral shifted slightly toward the squad hue so the
    // whole figure looks lit by one sun rather than assembled from parts.
    palette.skin.setRGB(0.78, 0.6, 0.48).lerp(t, 0.12);
    // Light rubber-and-plastic, not gunmetal — shoes, brim and water tank.
    palette.gear.setRGB(0.3, 0.33, 0.38).lerp(t, 0.22);

    // Wet cloth goes darker AND deeper in colour — a soaked t-shirt is not a
    // t-shirt in shadow, it is a richer version of itself. The saturation
    // lift is what stops the whole effect reading as "the sun went in", and
    // it is what makes a drenched player legible from across a street.
    for (const k of ["skin", "shirt", "shorts", "gear"] as Slot[]) {
      const c = palette[k];
      c.multiplyScalar(1 - SLOT_WET_DARKEN[k] * wet);
      if (k === "shirt" || k === "shorts") c.offsetHSL(0, 0.16 * wet, 0);
    }
  }

  /* -------------------------------------------------------------- writing */

  /** Write one instance of `part` at the given local transform. */
  function writePart(
    part: number,
    px: number,
    py: number,
    pz: number,
    quat: THREE.Quaternion | null,
    sx: number,
    sy: number,
    sz: number,
    color: THREE.Color,
    wet: number,
  ): void {
    const mesh = partMeshes[part];
    if (!mesh) return;
    const i = cursor[part];
    if (i >= mesh.instanceMatrix.count) return;

    scratch.v.set(px, py, pz);
    scratch.v2.set(sx, sy, sz);
    scratch.m.compose(scratch.v, quat ?? IDENTITY_Q, scratch.v2);
    scratch.m.premultiply(scratch.root);
    mesh.setMatrixAt(i, scratch.m);
    mesh.instanceColor!.setXYZ(i, color.r, color.g, color.b);
    partWet[part].setX(i, wet);
    cursor[part] = i + 1;
  }

  const IDENTITY_Q = new THREE.Quaternion();

  /** Place a capsule spanning two local points, stretching along its axis. */
  function writeLimb(
    part: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    color: THREE.Color,
    wet: number,
  ): void {
    scratch.dir.set(bx - ax, by - ay, bz - az);
    const len = scratch.dir.length();
    if (len < 1e-4) return;
    scratch.dir.multiplyScalar(1 / len);
    scratch.q.setFromUnitVectors(scratch.up, scratch.dir);
    const nominal = PARTS[part].nominal || 1;
    writePart(
      part,
      (ax + bx) * 0.5,
      (ay + by) * 0.5,
      (az + bz) * 0.5,
      scratch.q,
      1,
      len / nominal,
      1,
      color,
      wet,
    );
  }

  /* -------------------------------------------------------------- droplets */

  function spawnDrop(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    size: number,
    floor: number,
  ): void {
    const i = dropCursor;
    dropCursor = (dropCursor + 1) % DROP_CAP;
    const o = i * 3;
    dPos[o] = x;
    dPos[o + 1] = y;
    dPos[o + 2] = z;
    dVel[o] = vx;
    dVel[o + 1] = vy;
    dVel[o + 2] = vz;
    dLife[i] = 1.6;
    dSize[i] = size;
    dFloor[i] = floor;
  }

  /** Ground height under a point, so droplets land instead of falling forever. */
  function floorAt(x: number, y: number, z: number): number {
    const terrain = ctx.services.terrain;
    if (!terrain) return y - 4;
    const h = terrain.heightAt(x, z);
    // A droplet shed on a rooftop should not fall to sea level; clamp the
    // drop to something short when the peer is well above the terrain.
    return Math.max(h, y - 3.2);
  }

  function spawnRing(x: number, y: number, z: number, span: number): void {
    const i = ringCursor;
    ringCursor = (ringCursor + 1) % RING_CAP;
    rPos[i * 3] = x;
    rPos[i * 3 + 1] = y;
    rPos[i * 3 + 2] = z;
    rLife[i] = 1;
    rSpan[i] = span;
  }

  /** The join/leave/impact flourish: a ring plus a crown of droplets. */
  function splashAt(x: number, y: number, z: number, strength: number): void {
    if (!group) return;
    const s = clamp(strength, 0.2, 3);
    spawnRing(x, y + 0.03, z, 0.9 + s * 0.8);
    const n = Math.round(10 + s * 14);
    const floor = floorAt(x, y, z);
    for (let i = 0; i < n; i++) {
      const a = rng() * TAU;
      const r = 0.1 + rng() * 0.35 * s;
      const out = 1.6 + rng() * 2.6 * s;
      spawnDrop(
        x + Math.cos(a) * r,
        y + 0.12 + rng() * 0.25,
        z + Math.sin(a) * r,
        Math.cos(a) * out,
        2.4 + rng() * 3.4 * s,
        Math.sin(a) * out,
        0.7 + rng() * 0.8,
        floor,
      );
    }
  }

  /* ---------------------------------------------------------------- ghosts */

  function makeGhost(peer: PeerState): Ghost {
    const hex = teamColorFor(peer);
    const g: Ghost = {
      id: peer.id,
      peer,
      x: peer.x,
      y: peer.y,
      z: peer.z,
      yaw: peer.yaw,
      pitch: peer.pitch,
      speed: 0,
      vy: 0,
      lastX: peer.x,
      lastY: peer.y,
      lastZ: peer.z,
      phase: rng() * TAU,
      wet: 1 - clamp01(peer.dry / DRYNESS.max),
      airBlend: 0,
      downBlend: 0,
      proneBlend: 0,
      crouchBlend: 0,
      age: 0,
      dripAccum: 0,
      team: new THREE.Color(hex),
      teamHex: hex,
      plate: null,
      plateMat: null,
      nameTex: null,
      nameText: "",
      anchor: new THREE.Object3D(),
      target: null,
      unregister: null,
    };
    registerTarget(g);
    buildPlate(g);
    splashAt(peer.x, peer.y, peer.z, 1.35);
    return g;
  }

  function buildPlate(g: Ghost): void {
    if (!group || !plateGeo) return;
    const mat = new THREE.ShaderMaterial({
      vertexShader: PLATE_VERT,
      fragmentShader: PLATE_FRAG,
      uniforms: {
        uMap: { value: null },
        uTeam: { value: new THREE.Color(g.teamHex) },
        uBand: { value: new THREE.Color(0xffe9a8) },
        uDry: { value: 1 },
        uFade: { value: 0 },
        uAgent: { value: g.peer.agent ? 1 : 0 },
        uDown: { value: 0 },
        uW: { value: PLATE_W },
        uH: { value: PLATE_H },
      },
      transparent: true,
      // Depth-TESTED but not depth-writing: a nameplate that shines through
      // a wall is an aimbot, and one that occludes the world is a sticker.
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(plateGeo, mat);
    mesh.name = `soaked:plate-${g.id}`;
    mesh.frustumCulled = false;
    mesh.renderOrder = 12;
    mesh.visible = false;
    group.add(mesh);
    g.plate = mesh;
    g.plateMat = mat;
    refreshName(g);
  }

  function refreshName(g: Ghost): void {
    const raw = (g.peer.name || "player").slice(0, 14);
    const text = g.peer.agent ? `${raw} ✦` : raw;
    if (text === g.nameText && g.nameTex) return;
    const tex = bakeName(text);
    if (!tex) return;
    g.nameTex?.dispose();
    g.nameTex = tex;
    g.nameText = text;
    if (g.plateMat) g.plateMat.uniforms.uMap.value = tex;
  }

  /**
   * Make a remote player shootable.
   *
   * Until this existed, streams passed straight through every human in the
   * lobby: the local player registered a target, ghosts never did, and nothing
   * on the wire carried a hit. You could see each other and could not play
   * each other.
   *
   * The victim stays the authority on their own dryness. `onDamage` does not
   * touch `hp` — it puts the hit on the wire addressed to that peer and lets
   * their client decide what it cost them, which is the same trust model
   * `soaked` has always used. `hp` and `alive` are mirrored from their pose
   * every frame instead, so local aim feedback reads true without this client
   * ever being the one who decides.
   */
  function registerTarget(g: Ghost): void {
    const combat = ctx.services.combat;
    if (!combat || typeof combat.registerTarget !== "function") return;

    const target: DamageTarget = {
      id: g.id,
      object: g.anchor,
      radius: GHOST_RADIUS,
      height: GHOST_HEIGHT,
      hp: g.peer.dry,
      shield: 0,
      headY: GHOST_HEAD_Y,
      faction: "player",
      alive: g.peer.dry > 0,
      onDamage(amount, point, _source, headshot) {
        const net = ctx.services.net;
        if (!net || !net.online) return;
        if (!(amount > 0)) return;
        // Same squad = you can't soak each other. The lobby promises this in
        // as many words, and it has to hold here rather than at the victim:
        // a teammate should never even see the packet.
        if (sameSquad(g.peer)) return;
        net.send("hit", {
          to: g.id,
          amount,
          x: point.x,
          y: point.y,
          z: point.z,
          headshot: !!headshot,
        });
      },
    };

    g.target = target;
    try {
      g.unregister = combat.registerTarget(target);
    } catch {
      // A combat system that refuses a registration is not a reason to stop
      // drawing people. They simply stay unshootable, as they were before.
      g.target = null;
      g.unregister = null;
    }
  }

  /** True when this peer rides with us, and so must never take our water. */
  function sameSquad(peer: PeerState): boolean {
    const mine = ctx.services.net?.selfTeam;
    if (!mine || !peer.team) return false;
    return mine.trim().toLowerCase() === peer.team.trim().toLowerCase();
  }

  function destroyGhost(g: Ghost, flourish: boolean): void {
    g.unregister?.();
    g.unregister = null;
    g.target = null;
    if (flourish) splashAt(g.x, g.y, g.z, 0.9);
    if (g.plate) {
      group?.remove(g.plate);
      (g.plate.material as THREE.Material).dispose();
    }
    g.nameTex?.dispose();
    g.plate = null;
    g.plateMat = null;
    g.nameTex = null;
  }

  /* ------------------------------------------------------------- animation */

  /**
   * Pose one ghost and write its parts.
   *
   * All of the maths below is in the ghost's local frame — feet at the origin,
   * facing −Z, which is the convention the player rig uses — and `scratch.root`
   * carries it into the world. Doing it that way means the pose code never has
   * to think about yaw, and the yaw code never has to think about knees.
   */
  function poseGhost(g: Ghost, lod: number): void {
    const wet = clamp01(g.wet);
    resolvePalette(g);

    const air = g.airBlend;
    const down = g.downBlend;
    const prone = g.proneBlend;
    const crouch = g.crouchBlend;
    const upright = clamp01(1 - down - prone);

    // ---- gait -------------------------------------------------------------
    const spd = g.speed;
    const moving = clamp01((spd - 0.25) / 1.2);
    const swing = clamp(0.26 + spd * 0.072, 0, 0.98) * moving * upright * (1 - air * 0.55);
    const s1 = Math.sin(g.phase);
    const c1 = Math.cos(g.phase);

    // Idle is never still — a breathing sway is the cheapest possible
    // insurance against the "mannequin standing in a field" look.
    const idle = (1 - moving) * upright;
    const breathe = Math.sin(ctx.elapsed * 1.5 + g.phase) * 0.016 * idle;

    // ---- root -------------------------------------------------------------
    // Vertical bob is twice gait frequency (one dip per footfall) and the
    // lean scales with speed, which together sell weight more than any
    // amount of limb detail does.
    const bob = -Math.abs(s1) * (0.018 + spd * 0.011) * moving * upright;
    const lean = clamp(spd * 0.032, 0, 0.3) * upright * (1 - air * 0.6);
    const rootY =
      g.y + bob + breathe - crouch * 0.34 - down * 0.62 - prone * 0.72 + air * 0.02;
    const rootPitch = lean + down * 0.55 + prone * 1.42;
    const rollAmt = c1 * 0.05 * moving * upright;

    scratch.q.setFromEuler(TMP_EULER.set(rootPitch, g.yaw, rollAmt, "YXZ"));
    scratch.v.set(g.x, rootY, g.z);
    scratch.v2.set(1, 1, 1);
    scratch.root.compose(scratch.v, scratch.q, scratch.v2);

    // ---- joint angles -----------------------------------------------------
    // Skydive and glide are read straight off the blends rather than as
    // separate branches so a peer who opens their glider mid-frame does not
    // teleport from one pose into another.
    const spread = air * (g.peer.state === "skydive" || g.peer.state === "bus" ? 1 : 0);
    const glideAmt = air * (g.peer.state === "glide" ? 1 : 0);
    const tuck = air - spread - glideAmt;

    const hipSwingL = s1 * swing + tuck * 0.62 + spread * 0.34 + glideAmt * 0.5 + crouch * 0.85 + down * 0.95 + prone * 0.2;
    const hipSwingR = -s1 * swing + tuck * 0.62 + spread * 0.34 + glideAmt * 0.5 + crouch * 0.85 + down * 0.95 + prone * 0.2;
    // Knee bends on the recovery half of the stride, never on the plant —
    // getting that backwards is what makes procedural walks look like wading.
    const kneeL = Math.max(0, -s1) * (0.5 + spd * 0.1) * moving * upright + tuck * 1.05 + crouch * 1.5 + down * 1.7 + prone * 0.5;
    const kneeR = Math.max(0, s1) * (0.5 + spd * 0.1) * moving * upright + tuck * 1.05 + crouch * 1.5 + down * 1.7 + prone * 0.5;
    const hipSplayL = spread * 0.34 + prone * 0.22;
    const hipSplayR = -spread * 0.34 - prone * 0.22;

    const armSwing = swing * 0.8;
    const shoulderL = -s1 * armSwing - spread * 0.15 - glideAmt * 1.4 + down * 0.35 + prone * 1.1;
    const shoulderR = s1 * armSwing - spread * 0.15 - glideAmt * 1.4 + down * 0.35 + prone * 1.1;
    const armOutL = spread * 1.15 + glideAmt * 0.55 + 0.14 + down * 0.1;
    const armOutR = -(spread * 1.15 + glideAmt * 0.55 + 0.14 + down * 0.1);
    const elbowL = 0.22 + Math.max(0, s1) * 0.34 * moving * upright + spread * 0.55 + glideAmt * 1.35 + down * 0.9;
    const elbowR = 0.22 + Math.max(0, -s1) * 0.34 * moving * upright + spread * 0.55 + glideAmt * 1.35 + down * 0.9;

    // ---- legs -------------------------------------------------------------
    for (let side = 0; side < 2; side++) {
      const sx = side === 0 ? -1 : 1;
      const hipX = sx * BODY.hipX;
      const hipY = BODY.hipY;
      const hipA = side === 0 ? hipSwingL : hipSwingR;
      const splay = side === 0 ? hipSplayL : hipSplayR;
      const knee = side === 0 ? kneeL : kneeR;

      const kx = hipX + Math.sin(splay) * BODY.thigh;
      const ky = hipY - Math.cos(hipA) * Math.cos(splay) * BODY.thigh;
      const kz = -Math.sin(hipA) * BODY.thigh;

      const shinA = hipA - knee;
      const ax = kx + Math.sin(splay) * BODY.shin * 0.35;
      const ay = ky - Math.cos(shinA) * BODY.shin;
      const az = kz - Math.sin(shinA) * BODY.shin;

      if (lod >= 2) {
        // Far LOD: one stretched capsule from hip to ankle. At 110 m a knee is
        // sub-pixel; the silhouette is all that survives, so spend the
        // instances on the silhouette.
        writeLimb(P_LEG_U, hipX, hipY, 0, ax, ay, az, palette.shorts, wet);
      } else {
        writeLimb(P_LEG_U, hipX, hipY, 0, kx, ky, kz, palette.shorts, wet);
        writeLimb(P_LEG_L, kx, ky, kz, ax, ay, az, palette.skin, wet);
        // Foot pitch tracks the shin so the toe is not permanently dug in.
        scratch.q.setFromEuler(TMP_EULER.set(shinA * 0.45 - 0.06, 0, 0, "YXZ"));
        writePart(P_SHOE, ax, ay - 0.06, az - 0.02, scratch.q, 1, 1, 1, palette.gear, wet * 0.7);
      }
    }

    // ---- arms -------------------------------------------------------------
    for (let side = 0; side < 2; side++) {
      const sx = side === 0 ? -1 : 1;
      const shX = sx * BODY.shoulderX;
      const shY = BODY.shoulderY;
      const shA = side === 0 ? shoulderL : shoulderR;
      const out = side === 0 ? armOutL : armOutR;
      const elbow = side === 0 ? elbowL : elbowR;

      const ex = shX + Math.sin(out) * BODY.upperArm;
      const ey = shY - Math.cos(shA) * Math.cos(out) * BODY.upperArm;
      const ez = -Math.sin(shA) * BODY.upperArm;

      const foreA = shA + elbow;
      const wx = ex + Math.sin(out) * BODY.foreArm * 0.5;
      const wy = ey - Math.cos(foreA) * BODY.foreArm;
      const wz = ez - Math.sin(foreA) * BODY.foreArm;

      if (lod >= 2) {
        writeLimb(P_ARM_U, shX, shY, 0, wx, wy, wz, palette.shirt, wet);
      } else {
        writeLimb(P_ARM_U, shX, shY, 0, ex, ey, ez, palette.shirt, wet);
        writeLimb(P_ARM_L, ex, ey, ez, wx, wy, wz, palette.skin, wet);
        if (lod === 0) writePart(P_HAND, wx, wy - 0.04, wz, null, 1, 1, 1, palette.skin, wet);
      }
    }

    // ---- trunk ------------------------------------------------------------
    writePart(P_HIPS, 0, BODY.hipY + 0.06, 0, null, 1, 1, 1, palette.shorts, wet);
    const torsoTwist = -s1 * 0.09 * moving * upright;
    scratch.q.setFromEuler(TMP_EULER.set(0.06 + crouch * 0.2, torsoTwist, 0, "YXZ"));
    writePart(P_TORSO, 0, BODY.hipY + 0.35, 0, scratch.q, 1, 1, 1, palette.shirt, wet);

    if (lod <= 1) {
      // The tank rides on the back — remember +Z is behind a −Z-facing rig.
      scratch.q.setFromEuler(TMP_EULER.set(0.12, 0, 0, "YXZ"));
      writePart(P_PACK, 0, BODY.hipY + 0.34, 0.27, scratch.q, 1, 1, 1, palette.gear, wet * 0.5);
    }

    // ---- head -------------------------------------------------------------
    const headPitch = clamp(g.pitch, -1.1, 1.1) * 0.62 * upright - down * 0.5 - prone * 0.6;
    const headYaw = torsoTwist * -0.6;
    scratch.q.setFromEuler(TMP_EULER.set(headPitch, headYaw, 0, "YXZ"));
    writePart(P_HEAD, 0, BODY.headY, 0, scratch.q, 1, 1, 1, palette.skin, wet * 0.8);
    writePart(P_CAP, 0, BODY.headY + 0.02, 0, scratch.q, 1, 1, 1, palette.shirt, wet);
    if (lod === 0) {
      // Brim rides the head's rotation, offset forward in the head's frame.
      scratch.v.set(0, 0.03, -0.21).applyQuaternion(scratch.q);
      writePart(
        P_BRIM,
        scratch.v.x,
        BODY.headY + scratch.v.y,
        scratch.v.z,
        scratch.q,
        1,
        1,
        1,
        palette.gear,
        wet,
      );
    }
  }

  const TMP_EULER = new THREE.Euler();

  /* ---------------------------------------------------------------- anchors */

  /** Chest point of a peer, in world space. Null when they are not drawn. */
  function anchorOf(id: string, out?: THREE.Vector3): THREE.Vector3 | null {
    const g = ghosts.get(id);
    if (g) return (out ?? new THREE.Vector3()).set(g.x, g.y + BODY.shoulderY - 0.14, g.z);
    // The local player is a legitimate endpoint for a glue strand.
    const net = ctx.services.net;
    const player = ctx.services.player;
    if (net && player && id === net.selfId) {
      return (out ?? new THREE.Vector3()).set(
        player.position.x,
        player.position.y + BODY.shoulderY - 0.14,
        player.position.z,
      );
    }
    return null;
  }

  function endpoint(e: string | THREE.Vector3, out: THREE.Vector3): boolean {
    if (typeof e === "string") return anchorOf(e, out) !== null;
    out.copy(e);
    return true;
  }

  const strandKey = (a: string | THREE.Vector3, b: string | THREE.Vector3): string => {
    const ka = typeof a === "string" ? a : `@${a.x.toFixed(1)},${a.y.toFixed(1)},${a.z.toFixed(1)}`;
    const kb = typeof b === "string" ? b : `@${b.x.toFixed(1)},${b.y.toFixed(1)},${b.z.toFixed(1)}`;
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };

  function linkStrand(a: string | THREE.Vector3, b: string | THREE.Vector3, seconds: number): void {
    const key = strandKey(a, b);
    const existing = strands.find((s) => s.key === key);
    if (existing) {
      existing.ttl = Math.max(existing.ttl, seconds);
      return;
    }
    if (strands.length >= STRAND_CAP) strands.shift();
    strands.push({ key, a, b, ttl: seconds });
  }

  function unlinkStrand(a: string | THREE.Vector3, b: string | THREE.Vector3): void {
    const key = strandKey(a, b);
    const i = strands.findIndex((s) => s.key === key);
    if (i >= 0) strands.splice(i, 1);
  }

  /* ------------------------------------------------------------ net events */

  /**
   * Glue events, parsed defensively.
   *
   * The glue system is somebody else's file and its payload shape is not
   * nailed down in `net/types.ts` — the contract there says only that the
   * kind is `"glue"`. Rather than guess once and render nothing forever if
   * the guess is wrong, accept every plausible spelling of "these two are
   * stuck together" and ignore anything that does not resolve to two
   * endpoints we can actually draw.
   */
  interface GluePayload {
    a?: unknown;
    b?: unknown;
    from?: unknown;
    to?: unknown;
    target?: unknown;
    other?: unknown;
    id?: unknown;
    kind?: unknown;
    anchor?: { x?: number; y?: number; z?: number };
    point?: { x?: number; y?: number; z?: number };
    x?: number;
    y?: number;
    z?: number;
    duration?: number;
    ttl?: number;
    broken?: boolean;
    break?: boolean;
    end?: boolean;
    off?: boolean;
  }

  function asId(v: unknown): string | null {
    return typeof v === "string" && v.length > 0 ? v : null;
  }

  function asPoint(p: GluePayload): THREE.Vector3 | null {
    const src = p.anchor ?? p.point ?? (typeof p.x === "number" ? { x: p.x, y: p.y, z: p.z } : null);
    if (!src) return null;
    const { x, y, z } = src;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return new THREE.Vector3(x as number, y as number, z as number);
  }

  function onGlue(from: string, raw: unknown): void {
    const p = (raw ?? {}) as GluePayload;
    const a = asId(p.a) ?? asId(p.from) ?? from;
    const b = asId(p.b) ?? asId(p.to) ?? asId(p.target) ?? asId(p.other) ?? asId(p.id);
    const point = asPoint(p);
    const far: string | THREE.Vector3 | null = b ?? point;
    if (!far) return;

    if (p.broken || p.break || p.end || p.off) {
      unlinkStrand(a, far);
      return;
    }
    const ttl = Number.isFinite(p.duration)
      ? (p.duration as number)
      : Number.isFinite(p.ttl)
        ? (p.ttl as number)
        : GLUE.duration;
    linkStrand(a, far, clamp(ttl, 0.2, 60));
  }

  /** A peer got hit. Make them visibly splash — the feedback other clients see. */
  function onSplash(from: string, raw: unknown): void {
    const p = (raw ?? {}) as { x?: number; y?: number; z?: number; strength?: number };
    const strength = Number.isFinite(p.strength) ? clamp(p.strength as number, 0.2, 3) : 0.8;
    if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
      splashAt(p.x as number, p.y as number, p.z as number, strength);
      return;
    }
    const g = ghosts.get(from);
    if (g) splashAt(g.x, g.y + 1.0, g.z, strength);
  }

  /** A balloon burst. Big ring, lots of droplets — the signature moment. */
  function onBalloon(_from: string, raw: unknown): void {
    const p = (raw ?? {}) as { x?: number; y?: number; z?: number; burst?: boolean };
    if (!p.burst) return;
    if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
      splashAt(p.x as number, p.y as number, p.z as number, WATER_BALLOON.radius / 3.2);
    }
  }

  function onSoaked(from: string, _raw: unknown): void {
    const g = ghosts.get(from);
    if (g) splashAt(g.x, g.y + 0.6, g.z, 2.2);
    // A soaked player's strands all let go — the glue does not survive them.
    for (let i = strands.length - 1; i >= 0; i--) {
      if (strands[i].key.includes(from)) strands.splice(i, 1);
    }
  }

  /* ---------------------------------------------------------------- service */

  const service: GhostsService = {
    get count() {
      return ghosts.size;
    },
    anchor: (id, out) => anchorOf(id, out),
    head(id, out) {
      const g = ghosts.get(id);
      if (!g) return null;
      return (out ?? new THREE.Vector3()).set(g.x, g.y + BODY.headY, g.z);
    },
    splash(at, strength = 1) {
      if (typeof at === "string") {
        const g = ghosts.get(at);
        if (g) splashAt(g.x, g.y + 1.0, g.z, strength);
        return;
      }
      splashAt(at.x, at.y, at.z, strength);
    },
    link: (a, b, seconds = GLUE.duration) => linkStrand(a, b, clamp(seconds, 0.2, 60)),
    unlink: (a, b) => unlinkStrand(a, b),
  };
  ctx.services.ghosts = service;

  /* ------------------------------------------------------------------ hooks */

  /** Subscribe to the net kinds we render. Safe to call before net exists. */
  function ensureSubscribed(): void {
    if (unsubs.length > 0) return;
    const net = ctx.services.net;
    if (!net) return;
    unsubs.push(net.on("glue", onGlue));
    unsubs.push(net.on("splash", onSplash));
    unsubs.push(net.on("balloon", onBalloon));
    unsubs.push(net.on("soaked", onSoaked));
  }

  return {
    name: "ghosts",

    /**
     * Cosmetic work: reconcile the ghost set with `net.peers`, animate, and
     * write every instance buffer. `update` and not `fixed` — none of this is
     * simulation, and running a skeleton six times a frame would be absurd.
     */
    update(dt: number, c: WorldCtx) {
      if (disposed) return;
      // No transport is not an error: that is the shipped single-player game,
      // and there is simply nobody to draw.
      const net = c.services.net;
      if (!net) return;
      ensureSubscribed();

      const peers = net.peers;
      // ---- reap ------------------------------------------------------------
      for (const [id, g] of ghosts) {
        const still = peers.get(id);
        if (!still || !still.posed) {
          destroyGhost(g, true);
          ghosts.delete(id);
          for (let i = strands.length - 1; i >= 0; i--) {
            if (strands[i].key.includes(id)) strands.splice(i, 1);
          }
        } else {
          // The transport may replace the record object on a rejoin.
          g.peer = still;
        }
      }

      // ---- adopt -----------------------------------------------------------
      for (const [id, peer] of peers) {
        if (!peer.posed) continue;
        if (ghosts.has(id)) continue;
        if (ghosts.size >= MAX_GHOSTS) break;
        build();
        ghosts.set(id, makeGhost(peer));
      }

      if (!group || ghosts.size === 0) {
        // Nothing to draw. Zero the counts so a lobby that empties does not
        // leave the last frame's bodies standing in the field.
        for (let i = 0; i < partMeshes.length; i++) partMeshes[i].count = 0;
        if (strandMesh) strandMesh.count = 0;
        return;
      }

      c.camera.getWorldPosition(scratch.camPos);
      cursor.fill(0);

      // ---- per-ghost -------------------------------------------------------
      for (const g of ghosts.values()) {
        const peer = g.peer;
        g.age += dt;

        // Position comes straight from the transport, which has already done
        // the interpolation. Smoothing it again here would add a second lag
        // on top of `INTERP_DELAY`; all we do is note how far it moved.
        const px = peer.x;
        const py = peer.y;
        const pz = peer.z;
        const invDt = dt > 1e-5 ? 1 / dt : 0;
        const rawSpeed = Math.hypot(px - g.lastX, pz - g.lastZ) * invDt;
        const rawVy = (py - g.lastY) * invDt;
        g.lastX = px;
        g.lastY = py;
        g.lastZ = pz;
        g.x = px;
        g.y = py;
        g.z = pz;
        g.yaw = peer.yaw;
        g.pitch = peer.pitch;

        // Keep the hit capsule on the body. `combat` reads this through
        // `getWorldPosition`, so the anchor has to be moved every frame or a
        // ghost is shootable only where it first appeared.
        g.anchor.position.set(px, py, pz);
        if (g.target) {
          // Mirrored, never decided here: the victim's own client owns their
          // dryness and publishes it. `alive` going false is what stops a
          // spectator from being shot again on the way out.
          g.target.hp = peer.dry;
          g.target.alive = peer.dry > 0;
        }

        // Speed is smoothed hard: at a 10 Hz packet rate the raw per-frame
        // delta alternates between "a whole packet" and "nothing at all", and
        // driving a gait off that is exactly what foot-sliding looks like.
        g.speed = approach(g.speed, clamp(rawSpeed, 0, 14), 8, dt);
        g.vy = approach(g.vy, clamp(rawVy, -30, 30), 8, dt);
        // Phase advances with DISTANCE, so the feet always cover the ground
        // the body covers. This is the entire anti-foot-slide mechanism.
        g.phase = (g.phase + (g.speed / STRIDE_CYCLE) * TAU * dt) % TAU;

        const pose = poseFor(peer.state, peer.dry);
        g.airBlend = approach(g.airBlend, pose === "air" || pose === "skydive" || pose === "glide" ? 1 : 0, 9, dt);
        g.downBlend = approach(g.downBlend, pose === "down" ? 1 : 0, 6, dt);
        g.proneBlend = approach(g.proneBlend, pose === "prone" ? 1 : 0, 7, dt);
        g.crouchBlend = approach(g.crouchBlend, pose === "crouch" || pose === "swim" ? 1 : 0, 9, dt);

        const targetWet = 1 - clamp01(peer.dry / DRYNESS.max);
        // Getting wet is instant; drying off is slow. Asymmetric on purpose —
        // a hit should read immediately, and a towel should not.
        g.wet = approach(g.wet, targetWet, targetWet > g.wet ? 14 : 1.6, dt);

        refreshName(g);

        const dist = Math.hypot(g.x - scratch.camPos.x, g.y - scratch.camPos.y, g.z - scratch.camPos.z);
        const lod = dist < LOD_NEAR ? 0 : dist < LOD_MID ? 1 : 2;
        if (dist < LOD_CULL) poseGhost(g, lod);

        // ---- nameplate -----------------------------------------------------
        const plate = g.plate;
        const pm = g.plateMat;
        if (plate && pm) {
          const fade = 1 - clamp01((dist - PLATE_FULL) / Math.max(1, PLATE_FADE - PLATE_FULL));
          // Fade in over the first half second so a joining peer's plate does
          // not pop in before their splash has landed.
          const born = clamp01(g.age / 0.5);
          const vis = fade > 0.01 && dist < PLATE_FADE;
          plate.visible = vis;
          if (vis) {
            plate.position.set(g.x, g.y + BODY.height + 0.36 - g.downBlend * 0.9 - g.proneBlend * 1.1, g.z);
            const dry01 = clamp01(peer.dry / DRYNESS.max);
            pm.uniforms.uDry.value = dry01;
            pm.uniforms.uFade.value = fade * born;
            pm.uniforms.uDown.value = g.downBlend;
            (pm.uniforms.uBand.value as THREE.Color).setHex(drynessBand(peer.dry).color);
          }
        }

        // ---- drips ---------------------------------------------------------
        // Only near ghosts drip. Past 40 m a 4 cm droplet is a subpixel and
        // the pool is better spent on the fight in front of you.
        if (g.wet > 0.22 && dist < LOD_NEAR) {
          // Quadratic in wetness, not linear: a damp player sheds the odd
          // drop, a drenched one runs. The gap between those two readings is
          // the whole point of drawing drips at all.
          g.dripAccum += (g.wet - 0.2) * (1 + g.wet * 6) * 2.4 * dt;
          while (g.dripAccum >= 1) {
            g.dripAccum -= 1;
            emitDrip(g);
          }
        } else {
          g.dripAccum = 0;
        }
      }

      // ---- publish instance counts ------------------------------------------
      for (let i = 0; i < partMeshes.length; i++) {
        const mesh = partMeshes[i];
        mesh.count = cursor[i];
        if (cursor[i] > 0) {
          mesh.instanceMatrix.needsUpdate = true;
          mesh.instanceColor!.needsUpdate = true;
          partWet[i].needsUpdate = true;
        }
      }

      updateStrands(dt);
      updateRings(dt);
    },

    /**
     * Droplet integration. In `fixed` because it is the one genuinely
     * physical thing in this file — gravity at a variable dt makes an arc
     * that changes shape with the frame rate, and the whole art direction
     * rests on water falling like water.
     */
    fixed(dt: number) {
      if (disposed || !dropMesh) return;
      for (let i = 0; i < DROP_CAP; i++) {
        if (dLife[i] <= 0) continue;
        const o = i * 3;
        dVel[o + 1] -= DROP_GRAVITY * dt;
        dPos[o] += dVel[o] * dt;
        dPos[o + 1] += dVel[o + 1] * dt;
        dPos[o + 2] += dVel[o + 2] * dt;
        dLife[i] -= dt;
        if (dPos[o + 1] <= dFloor[i]) {
          dLife[i] = 0;
          // A droplet that lands leaves a whisper of a ring — the ground
          // acknowledging it is the difference between rain and confetti.
          if (dSize[i] > 1.1) spawnRing(dPos[o], dFloor[i] + 0.02, dPos[o + 2], 0.28);
        }
      }
    },

    /** Camera-relative work: droplet billboards want the final camera pose. */
    lateUpdate() {
      if (disposed || !dropMesh) return;
      let n = 0;
      for (let i = 0; i < DROP_CAP && n < DROP_CAP; i++) {
        if (dLife[i] <= 0) continue;
        const o = i * 3;
        // Stretch along the fall direction: a falling droplet is a teardrop,
        // and the streak is most of what makes it read as water at speed.
        const vy = dVel[o + 1];
        const stretch = clamp(1 + Math.abs(vy) * 0.06, 1, 2.6);
        const s = dSize[i];
        scratch.v.set(dPos[o], dPos[o + 1], dPos[o + 2]);
        scratch.v2.set(s, s * stretch, s);
        scratch.m.compose(scratch.v, IDENTITY_Q, scratch.v2);
        dropMesh.setMatrixAt(n, scratch.m);
        n++;
      }
      dropMesh.count = n;
      if (n > 0) dropMesh.instanceMatrix.needsUpdate = true;
    },

    dispose() {
      disposed = true;
      for (const fn of unsubs.splice(0)) {
        try {
          fn();
        } catch {
          /* the transport may already be gone; unsubscribing twice is fine. */
        }
      }
      for (const g of ghosts.values()) destroyGhost(g, false);
      ghosts.clear();
      strands.length = 0;

      const disposeMesh = (m: THREE.InstancedMesh | null) => {
        if (!m) return;
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      };
      // Part meshes share the four slot materials, so geometries go here and
      // the materials go once, below — disposing a shared material per mesh
      // is harmless but it is also a lie about ownership.
      for (const m of partMeshes) m.geometry.dispose();
      partMeshes = [];
      partWet = [];
      if (slotMaterials) {
        for (const k of Object.keys(slotMaterials) as Slot[]) slotMaterials[k].dispose();
        slotMaterials = null;
      }
      disposeMesh(dropMesh);
      disposeMesh(ringMesh);
      disposeMesh(strandMesh);
      dropMesh = null;
      ringMesh = null;
      strandMesh = null;
      plateGeo?.dispose();
      plateGeo = null;

      if (group) {
        group.clear();
        ctx.scene.remove(group);
        group = null;
      }
      if (ctx.services.ghosts === service) ctx.services.ghosts = undefined;
    },
  };

  /* ------------------------------------------------------------- internals */

  /** One droplet shed from a wet body, at a plausible place on it. */
  function emitDrip(g: Ghost): void {
    const spots = DRIP_SPOTS[Math.floor(rng() * DRIP_SPOTS.length) % DRIP_SPOTS.length];
    scratch.v.set(spots[0] * (rng() < 0.5 ? -1 : 1), spots[1], spots[2]);
    // Rotate the local spot into world space by the ghost's yaw only — the
    // full root matrix has already been consumed by the pose pass.
    const s = Math.sin(g.yaw);
    const cq = Math.cos(g.yaw);
    const wx = g.x + scratch.v.x * cq + scratch.v.z * s;
    const wz = g.z - scratch.v.x * s + scratch.v.z * cq;
    const wy = g.y + scratch.v.y;
    spawnDrop(
      wx,
      wy,
      wz,
      (rng() - 0.5) * 0.35,
      -0.2 - rng() * 0.4,
      (rng() - 0.5) * 0.35,
      0.7 + rng() * 0.7,
      floorAt(wx, wy, wz),
    );
  }

  /** Splash rings: expand and fade. Purely cosmetic, so `update` time. */
  function updateRings(dt: number): void {
    if (!ringMesh) return;
    let n = 0;
    for (let i = 0; i < RING_CAP; i++) {
      if (rLife[i] <= 0) continue;
      rLife[i] = Math.max(0, rLife[i] - dt * 1.9);
      const t = 1 - rLife[i];
      const r = rSpan[i] * (0.25 + t * 1.0);
      scratch.v.set(rPos[i * 3], rPos[i * 3 + 1] + t * 0.05, rPos[i * 3 + 2]);
      scratch.v2.set(r, 1, r);
      scratch.m.compose(scratch.v, IDENTITY_Q, scratch.v2);
      ringMesh.setMatrixAt(n, scratch.m);
      // Additive blending: fading toward black IS fading out, and it avoids a
      // per-instance opacity three does not have.
      const k = rLife[i] * rLife[i] * 0.85;
      ringMesh.instanceColor!.setXYZ(n, k * 0.75, k * 0.95, k);
      n++;
    }
    ringMesh.count = n;
    if (n > 0) {
      ringMesh.instanceMatrix.needsUpdate = true;
      ringMesh.instanceColor!.needsUpdate = true;
    }
  }

  /**
   * Glue strands: a sagging rope between two chest anchors, built from
   * cylinder segments so it has real thickness at 3 m. A `Line` would be one
   * pixel wide however close you stood, which for the single most important
   * piece of social feedback in the mode is not good enough.
   */
  function updateStrands(dt: number): void {
    if (!strandMesh) return;
    const a = STRAND_A;
    const b = STRAND_B;
    let n = 0;

    for (let i = strands.length - 1; i >= 0; i--) {
      const s = strands[i];
      // Simulated seconds, like everything else here. A strand nobody sends a
      // break event for still has to let go on its own — packets get lost, and
      // a permanent tether between two players is a stuck game.
      s.ttl -= dt;
      if (s.ttl <= 0) {
        strands.splice(i, 1);
        continue;
      }
      if (!endpoint(s.a, a) || !endpoint(s.b, b)) {
        // An endpoint we can no longer resolve (peer left, or never arrived).
        strands.splice(i, 1);
        continue;
      }
      const span = a.distanceTo(b);
      // Past the snap length the strand is about to give anyway; drawing it
      // stretched to the horizon looks like a bug, so stop at a margin.
      if (span > GLUE.maxLength * 1.6) {
        strands.splice(i, 1);
        continue;
      }
      // Sag scales down as the strand is pulled taut, which is the readable
      // signal that someone is about to be yanked over.
      const taut = clamp01((span - GLUE.restLength) / Math.max(0.001, GLUE.maxLength - GLUE.restLength));
      const sag = GLUE.sag * (1 - taut) * (0.5 + span / Math.max(0.001, GLUE.maxLength));

      for (let k = 0; k < STRAND_SEGMENTS; k++) {
        if (n >= strandMesh.instanceMatrix.count) break;
        const t0 = k / STRAND_SEGMENTS;
        const t1 = (k + 1) / STRAND_SEGMENTS;
        catenary(a, b, t0, sag, STRAND_P0);
        catenary(a, b, t1, sag, STRAND_P1);
        scratch.dir.subVectors(STRAND_P1, STRAND_P0);
        const len = scratch.dir.length();
        if (len < 1e-5) continue;
        scratch.dir.multiplyScalar(1 / len);
        scratch.q.setFromUnitVectors(scratch.up, scratch.dir);
        scratch.v.addVectors(STRAND_P0, STRAND_P1).multiplyScalar(0.5);
        // Thicker in the middle, tapered at the ends — a strand of glue, not
        // a length of pipe.
        const thick = 0.7 + Math.sin(((k + 0.5) / STRAND_SEGMENTS) * Math.PI) * 0.9;
        scratch.v2.set(thick, len, thick);
        scratch.m.compose(scratch.v, scratch.q, scratch.v2);
        strandMesh.setMatrixAt(n, scratch.m);
        n++;
      }
    }
    strandMesh.count = n;
    if (n > 0) strandMesh.instanceMatrix.needsUpdate = true;
  }

  /** Point at `t` along a strand that sags `sag` metres at its midpoint. */
  function catenary(
    a: THREE.Vector3,
    b: THREE.Vector3,
    t: number,
    sag: number,
    out: THREE.Vector3,
  ): THREE.Vector3 {
    out.lerpVectors(a, b, t);
    out.y -= sag * 4 * t * (1 - t);
    return out;
  }
};

/**
 * Local body points a droplet can run off, in the ghost's local frame
 * (x is mirrored at random). Chin, elbows, shirt hem, knees, heels — the
 * places water actually collects and lets go.
 */
const DRIP_SPOTS: ReadonlyArray<readonly [number, number, number]> = [
  [0.05, 1.5, -0.16], // chin
  [0.38, 1.2, 0.02], // elbow
  [0.22, 1.06, -0.14], // shirt hem, front
  [0.2, 1.06, 0.16], // shirt hem, back
  [0.17, 0.62, -0.06], // knee
  [0.16, 0.2, 0.06], // heel
  [0.3, 1.42, 0.24], // tank
];

const STRAND_A = new THREE.Vector3();
const STRAND_B = new THREE.Vector3();
const STRAND_P0 = new THREE.Vector3();
const STRAND_P1 = new THREE.Vector3();

export default createGhostsSystem;
