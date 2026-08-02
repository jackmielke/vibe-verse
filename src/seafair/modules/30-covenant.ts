import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { bus } from "../core/EventBus";
import type { Collider } from "../entities/Player";
import type { DamageTarget, GameModule, ModuleContext } from "../ModuleTypes";

/**
 * COVENANT REMNANT — the enemy faction.
 *
 * Three silhouettes you can name from 150 m away:
 *
 *   GRUNT    small, wide, orange, methane tank hump. Waddles. Panics.
 *   ZEALOT   tall, huge shoulders, back-canted legs, violet, cyan shield bubble.
 *   SPECTRE  airborne arrowhead, two cyan engine eyes. Fast, orbits, dives.
 *
 * Everything is drawn from instanced part pools — one draw call per body part
 * for the whole faction, not per enemy — so the count scales with the quality
 * profile and a phone still gets a real firefight.
 *
 * Colour contract: this module lives in the same scene-linear HDR space as
 * everything else. An 18% grey reads 0.18; emissive and the shield are the only
 * things allowed above 1.0 and they top out around 4 linear — enough to bloom,
 * far below the 110 of the sun disc.
 *
 * Readability against aerial perspective is the whole design problem here, and
 * it is not solved by picking nice colours. Engine's AtmospherePass adds
 * inscatter to every pixel in proportion to depth: over a hundred metres of
 * sun-struck shore that is a wash of white comparable to the entire reflectance
 * budget of the surface underneath it, so a faction painted only in albedo goes
 * to sky grey at exactly the range where you most need to identify it. Two
 * answers, both here: albedos pushed past plausible reflectance into the
 * saturated corner, and a self-lit accent per kind whose strength is *scaled up
 * with view distance* so the identity survives the haze rather than fighting it.
 */

// --------------------------------------------------------------- tuning ---

type Kind = "grunt" | "elite" | "drone";

interface Spec {
  name: string;
  health: number;
  shield: number;
  /** metres/second on flat ground */
  speed: number;
  sprint: number;
  /**
   * Damage sphere, fed to the weapon raycast. `centreY` lifts the target point
   * off the feet to the middle of the mass, so the sphere actually wraps the
   * body instead of half of it and the ground under it.
   */
  centreY: number;
  radius: number;
  /** head sphere, measured from the damage-sphere centre */
  headOffset: number;
  headRadius: number;
  /** eye height used for line-of-sight and as the aiming origin */
  eye: number;
  sight: number;
  /** the band it tries to hold the player at */
  rangeMin: number;
  rangeMax: number;
  boltDamage: number;
  boltSpeed: number;
  burst: number;
  /** seconds between rounds inside a burst, and between bursts */
  boltGap: number;
  cycle: number;
  /** radians of aim cone — the whole reason a fight feels fair */
  aimErrorMin: number;
  aimErrorMax: number;
  reactionMin: number;
  reactionMax: number;
  /** How far the dissolve front has to climb to consume the whole body. */
  burnHeight: number;
  boltColor: THREE.Color;
  score: number;
}

/**
 * Balanced against systems/Weapons.ts: the AR lands ~120 dps and a BR burst is
 * 51 damage, so a grunt dies to one clean burst and a zealot needs four plus
 * the shield break. Incoming damage is set against the thinnest character in
 * entities/Player.ts — the street operative's 45 shields and 130 health — so a
 * careless ten seconds in the open kills anyone.
 */
const SPECS: Record<Kind, Spec> = {
  grunt: {
    name: "Remnant Grunt",
    health: 45,
    shield: 0,
    speed: 3.9,
    sprint: 6.8,
    centreY: 0.98,
    radius: 0.58,
    headOffset: 0.52,
    headRadius: 0.22,
    eye: 1.34,
    sight: 135,
    rangeMin: 7,
    rangeMax: 21,
    boltDamage: 7,
    boltSpeed: 54,
    burst: 3,
    boltGap: 0.14,
    cycle: 1.75,
    aimErrorMin: 0.04,
    aimErrorMax: 0.095,
    reactionMin: 0.42,
    reactionMax: 1.05,
    burnHeight: 1.75,
    boltColor: new THREE.Color(6.2, 1.5, 0.16),
    score: 100,
  },
  elite: {
    name: "Remnant Zealot",
    health: 110,
    shield: 90,
    speed: 4.4,
    sprint: 7.4,
    centreY: 1.45,
    radius: 0.92,
    headOffset: 0.71,
    headRadius: 0.3,
    eye: 2.05,
    sight: 190,
    rangeMin: 14,
    rangeMax: 40,
    boltDamage: 15,
    boltSpeed: 76,
    burst: 5,
    boltGap: 0.115,
    cycle: 2.8,
    aimErrorMin: 0.017,
    aimErrorMax: 0.04,
    reactionMin: 0.16,
    reactionMax: 0.5,
    burnHeight: 3.0,
    boltColor: new THREE.Color(1.1, 4.4, 8.0),
    score: 400,
  },
  drone: {
    name: "Spectre Drone",
    health: 32,
    shield: 0,
    speed: 11,
    sprint: 17,
    centreY: 0,
    radius: 0.72,
    headOffset: 0,
    headRadius: 0,
    eye: 0,
    sight: 210,
    rangeMin: 14,
    rangeMax: 40,
    boltDamage: 5,
    boltSpeed: 92,
    burst: 2,
    boltGap: 0.1,
    cycle: 1.15,
    aimErrorMin: 0.035,
    aimErrorMax: 0.08,
    reactionMin: 0.2,
    reactionMax: 0.6,
    burnHeight: 1.4,
    boltColor: new THREE.Color(2.2, 5.6, 7.4),
    score: 200,
  },
};

/** Ranks read as colour: the darker/hotter one is the one that will hurt. */
const GRUNT_RANKS = [
  { tint: new THREE.Color(1.0, 1.0, 1.0), health: 1.0, skill: 1.0, weight: 0.68 },
  { tint: new THREE.Color(1.25, 0.62, 0.45), health: 1.5, skill: 0.72, weight: 0.24 },
  { tint: new THREE.Color(0.52, 0.78, 1.5), health: 2.1, skill: 0.55, weight: 0.08 },
];
const ELITE_RANKS = [
  { tint: new THREE.Color(1.0, 1.0, 1.0), health: 1.0, skill: 1.0, weight: 0.72 },
  { tint: new THREE.Color(2.0, 1.5, 0.35), health: 1.35, skill: 0.7, weight: 0.28 },
];

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _scale = new THREE.Vector3();

// ------------------------------------------------------------ part pools ---

/**
 * One InstancedMesh per body part, shared by every enemy of that kind. Slot i
 * belongs to enemy i; unused slots are parked at zero scale rather than being
 * compacted, so an enemy's identity never migrates between draws.
 */
class PartPool {
  readonly mesh: THREE.InstancedMesh;
  private readonly burn: THREE.InstancedBufferAttribute | null;

  constructor(
    scene: THREE.Scene,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    count: number,
    opts: { burn?: boolean; shadow?: boolean } = {},
  ) {
    this.mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = opts.shadow ?? false;
    // Receiving would mean self-shadow acne all over a 1.5 m body lit by a
    // cascade sized for a kilometre of shoreline. They cast; they do not receive.
    this.mesh.receiveShadow = false;
    // Instances move every frame over hundreds of metres; a static bounding
    // sphere would pop the whole faction out of view.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;

    if (opts.burn) {
      const arr = new Float32Array(Math.max(1, count) * 2);
      this.burn = new THREE.InstancedBufferAttribute(arr, 2);
      this.burn.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute("aBurn", this.burn);
    } else {
      this.burn = null;
    }

    _m.makeScale(0, 0, 0);
    for (let i = 0; i < this.mesh.count; i++) this.mesh.setMatrixAt(i, _m);
    scene.add(this.mesh);
  }

  set(i: number, m: THREE.Matrix4): void {
    this.mesh.setMatrixAt(i, m);
  }

  hide(i: number): void {
    _m.makeScale(0, 0, 0);
    this.mesh.setMatrixAt(i, _m);
  }

  setBurn(i: number, amount: number, baseY: number): void {
    if (!this.burn) return;
    this.burn.setXY(i, amount, baseY);
  }

  tint(i: number, c: THREE.Color): void {
    this.mesh.setColorAt(i, c);
  }

  flush(): void {
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.burn) this.burn.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.mesh.dispose();
    this.mesh.geometry.dispose();
  }
}

/**
 * Armour shader: one standard PBR surface for the entire faction. Albedo comes
 * from baked vertex colour, so a body can carry four materials' worth of
 * contrast in a single draw call, and the per-instance colour on top of it is
 * free to say "this one is a veteran".
 *
 * The other half is a bottom-up dissolve. `aBurn.x` is the burn amount and
 * `aBurn.y` the world Y of the corpse's feet, so the burn front sweeps up the
 * whole body rather than each part burning in its own little space.
 */
function armourMaterial(detail: THREE.Texture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.55,
    metalness: 0.2,
    flatShading: true,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBurnColor = { value: new THREE.Color(1.0, 0.34, 0.07) };
    shader.uniforms.uDetail = { value: detail };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        attribute vec2 aBurn;
        attribute vec4 aAccent;
        varying vec2 vBurn;
        varying vec3 vBurnPos;
        varying vec4 vAccent;
        varying vec3 vObj;
        varying vec3 vObjN;
        varying vec3 vSmoothN;`,
      )
      .replace(
        "#include <beginnormal_vertex>",
        `#include <beginnormal_vertex>
        vObjN = objectNormal;`,
      )
      .replace(
        "#include <defaultnormal_vertex>",
        `#include <defaultnormal_vertex>
        vSmoothN = transformedNormal;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vBurn = aBurn;
        vAccent = aAccent;
        vObj = transformed;
        vBurnPos = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform vec3 uBurnColor;
        uniform sampler2D uDetail;
        varying vec2 vBurn;
        varying vec3 vBurnPos;
        varying vec4 vAccent;
        varying vec3 vObj;
        varying vec3 vObjN;
        varying vec3 vSmoothN;
        float burnHash( vec3 p ) {
          return fract( sin( dot( floor( p ), vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 );
        }`,
      )
      .replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>
        float burnAmt = vBurn.x;
        float burnEdge = vBurnPos.y - ( vBurn.y + burnAmt )
          + burnHash( vBurnPos * 11.0 ) * 0.34 + burnHash( vBurnPos * 2.7 ) * 0.22;
        if ( burnAmt > 0.001 && burnEdge < 0.0 ) discard;
        // Object-space triplanar so the wear stays welded to the armour while
        // the body walks, rolls and topples.
        vec3 tw = abs( normalize( vObjN ) );
        tw /= ( tw.x + tw.y + tw.z );
        vec3 dc = vObj * 3.1;
        vec4 wear = texture2D( uDetail, dc.yz ) * tw.x
                  + texture2D( uDetail, dc.xz ) * tw.y
                  + texture2D( uDetail, dc.xy ) * tw.z;`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
        roughnessFactor = clamp( roughnessFactor + vAccent.w + ( wear.r - 0.5 ) * 0.55, 0.08, 1.0 );`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        // Grime darkens, rubbed edges lighten. Both are small: the silhouette
        // colour is doing the readability work, this is only breaking up mass.
        diffuseColor.rgb *= 0.80 + 0.34 * wear.g + 0.16 * wear.b;`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        {
          // Aerial perspective adds roughly its own +0.3 to +2.0 of white haze
          // over 100 m of shore, which flattens any reflectance-only palette to
          // sky grey. The faction answers with self-lit armour that is *scaled
          // up* with distance, so a grunt is still orange at 120 m.
          float dcam = length( vViewPosition );
          float far = 1.0 + 2.4 * smoothstep( 18.0, 130.0, dcam );
          vec3 Nv = normalize( vSmoothN );
          vec3 Vv = normalize( vViewPosition );
          float rim = pow( 1.0 - clamp( dot( Nv, Vv ), 0.0, 1.0 ), 2.2 );
          totalEmissiveRadiance += vAccent.rgb * ( 0.14 + 1.05 * rim ) * far;
        }
        if ( burnAmt > 0.001 ) {
          totalEmissiveRadiance += uBurnColor * ( 1.0 - smoothstep( 0.0, 0.5, burnEdge ) ) * 8.0;
        }`,
      );
  };
  return mat;
}

/**
 * Two octaves of tileable value noise, packed so one fetch drives everything:
 * R scratch (roughness), G grime (albedo), B micro-speckle. Sized off the
 * quality profile — a phone gets 64 px of it and never notices.
 */
function detailTexture(size: number): THREE.DataTexture {
  const n = THREE.MathUtils.clamp(size >> 2, 64, 256);
  const data = new Uint8Array(n * n * 4);

  const lattice = (x: number, y: number, s: number): number => {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const value = (u: number, v: number, period: number, s: number): number => {
    const fx = u * period;
    const fy = v * period;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const w = (a: number): number => ((a % period) + period) % period;
    const x1 = w(x0 + 1);
    const y1 = w(y0 + 1);
    const a = lattice(w(x0), w(y0), s);
    const b = lattice(x1, w(y0), s);
    const c = lattice(w(x0), y1, s);
    const d = lattice(x1, y1, s);
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
  };

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n;
      const v = y / n;
      const scratch = value(u, v, 24, 1) * 0.6 + value(u, v, 61, 2) * 0.4;
      const grime = value(u, v, 4, 3) * 0.62 + value(u, v, 9, 4) * 0.38;
      const micro = value(u, v, 48, 5);
      const i = (y * n + x) * 4;
      data[i] = scratch * 255;
      data[i + 1] = grime * 255;
      data[i + 2] = micro * 255;
      data[i + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Contact shadows and scorch decals: flat multiply-blended discs. One shader,
 * two pools. On a beach lit by a high sun this buys more perceived grounding
 * than the real cascade does, because the cascade is sized for a kilometre of
 * shoreline and a 1.6 m body barely registers in it past 30 m.
 */
function decalMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: `
      attribute vec3 aDecal;
      varying vec2 vUv;
      varying vec3 vD;
      void main() {
        vUv = uv;
        vD = aDecal;
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4( position, 1.0 );
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      varying vec3 vD;
      void main() {
        if ( vD.z <= 0.002 ) discard;
        vec2 d = vUv - 0.5;
        float r = length( d ) * 2.0;
        float a = atan( d.y, d.x );
        // Break the perfect circle; a round dot reads as a sticker, not a mark.
        r *= 1.0 + 0.16 * sin( a * 5.0 + vD.y ) + 0.09 * sin( a * 11.0 - vD.y * 2.3 );
        float k = ( 1.0 - smoothstep( 0.18, 1.0, r ) ) * vD.z;
        // Sun-shadow on pale sand is blue-grey ambient; plasma scorch is brown.
        // Both are laid down before the aerial pass adds its inscatter, so they
        // have to be darker than a real shadow to survive being hazed over.
        vec3 tint = mix( vec3( 0.30, 0.35, 0.48 ), vec3( 0.22, 0.17, 0.14 ), vD.x );
        gl_FragColor = vec4( mix( vec3( 1.0 ), tint, k ), 1.0 );
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.MultiplyBlending,
    side: THREE.DoubleSide,
  });
}

/** Unlit accents. Vertex colours here are emission, not reflectance, so they
 *  sit well above 1.0 — bright enough to survive the aerial perspective at
 *  120 m, two orders below the sun disc. */
function glowMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, fog: false });
}

// ------------------------------------------------------------- geometry ---

/**
 * Linear reflectances. These are the whole readability budget: the shore is a
 * pale sun-bleached 0.2-ish and the lake behind it is brighter still, so a
 * faction painted in the usual sci-fi near-blacks would vanish. Everything
 * here is either well above the ground value or decisively below it.
 */
type Paint = {
  /** linear reflectance */
  a: readonly [number, number, number];
  /** self-lit accent radiance, tinted per faction kind, and a roughness bias */
  g?: readonly [number, number, number];
  r?: number;
};

const C: Record<string, Paint> = {
  // Pushed well past plausible reflectance into the saturated corner. There is
  // no such thing as a 0.62 red pigment, but there is also no such thing as a
  // 2.0-linear white haze laid over it, and only one of those two is negotiable.
  gruntShell: { a: [0.62, 0.075, 0.004], g: [0.72, 0.16, 0.012], r: -0.1 },
  gruntPlate: { a: [0.40, 0.13, 0.012], g: [0.42, 0.09, 0.006], r: 0.05 },
  gruntTank: { a: [0.030, 0.028, 0.038], g: [0.0, 0.0, 0.0], r: 0.18 },
  gruntLimb: { a: [0.036, 0.033, 0.042], g: [0.02, 0.008, 0.0], r: 0.22 },
  eliteArmour: { a: [0.30, 0.020, 0.55], g: [0.42, 0.05, 0.86], r: -0.22 },
  eliteTrim: { a: [0.46, 0.34, 0.10], g: [0.26, 0.17, 0.02], r: -0.3 },
  eliteUnder: { a: [0.028, 0.020, 0.045], g: [0.03, 0.0, 0.06], r: 0.14 },
  droneHull: { a: [0.026, 0.036, 0.070], g: [0.02, 0.16, 0.30], r: -0.15 },
  droneEdge: { a: [0.17, 0.19, 0.23], g: [0.05, 0.30, 0.46], r: -0.2 },
  gunMetal: { a: [0.055, 0.055, 0.062], g: [0.0, 0.0, 0.0], r: -0.05 },
  /** The one bright chip on a weapon, so you can see which way it is pointed. */
  coolant: { a: [0.30, 0.62, 0.75], g: [0.10, 0.55, 0.78], r: -0.35 },
};

const GLOW = {
  methane: [0.55, 1.9, 2.4] as const,
  pilot: [0.35, 1.2, 1.5] as const,
  eye: [3.4, 0.8, 0.12] as const,
  // Kept inside the AgX shoulder. Above ~4 these thin strips pin to flat white
  // and lose their hue entirely, which is the opposite of a readability cue.
  eliteEnergy: [1.6, 2.4, 3.2] as const,
  droneEye: [0.7, 3.8, 5.4] as const,
};

const GLOW_PAINT = (c: readonly [number, number, number]): Paint => ({ a: c, g: [0, 0, 0], r: 0 });

/** Bake albedo, self-lit accent and roughness bias into a geometry so it can be
 *  merged with differently finished parts and still draw in one call. */
function paint(geo: THREE.BufferGeometry, p: Paint): THREE.BufferGeometry {
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  const acc = new Float32Array(n * 4);
  const g = p.g ?? [0, 0, 0];
  for (let i = 0; i < n; i++) {
    col[i * 3] = p.a[0];
    col[i * 3 + 1] = p.a[1];
    col[i * 3 + 2] = p.a[2];
    acc[i * 4] = g[0];
    acc[i * 4 + 1] = g[1];
    acc[i * 4 + 2] = g[2];
    acc[i * 4 + 3] = p.r ?? 0;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("aAccent", new THREE.BufferAttribute(acc, 4));
  return geo;
}

function put(
  geo: THREE.BufferGeometry,
  pos: [number, number, number],
  rot?: [number, number, number],
  scl?: [number, number, number],
): THREE.BufferGeometry {
  if (scl) geo.scale(scl[0], scl[1], scl[2]);
  if (rot) {
    if (rot[0]) geo.rotateX(rot[0]);
    if (rot[1]) geo.rotateY(rot[1]);
    if (rot[2]) geo.rotateZ(rot[2]);
  }
  geo.translate(pos[0], pos[1], pos[2]);
  return geo;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  if (!out) throw new Error("covenant: geometry merge failed");
  out.computeVertexNormals();
  return out;
}

interface KindGeo {
  body: THREE.BufferGeometry;
  glow: THREE.BufferGeometry;
  limbA?: THREE.BufferGeometry;
  limbB?: THREE.BufferGeometry;
  arm?: THREE.BufferGeometry;
}

/** Enemies face -Z in local space, matching the player's forward at yaw 0. */
/**
 * The grunt is the hardest silhouette in the faction because it is the smallest
 * and the most numerous, and the first version of it read as a boar: barrel
 * body, four stubby legs, one arm projecting forward at body height as a snout.
 * The fixes are all silhouette-level: legs long enough to be legs (0.62 m under
 * a 1.06 m upper body), a torso half as deep as it is tall so it cannot read
 * as a quadruped's ribcage, a raised head on a visible neck, and TWO arms
 * bringing the weapon diagonally across the chest instead of out in front.
 */
function buildGrunt(seg: number): KindGeo {
  const lo = Math.max(4, seg >> 1);
  const body = merge([
    // Torso: narrow front-to-back, so from any angle it has a waist and shoulders.
    paint(put(new THREE.SphereGeometry(0.38, seg, lo), [0, 1.0, -0.02], [0.14, 0, 0], [1.06, 1.12, 0.70]), C.gruntShell),
    paint(put(new THREE.BoxGeometry(0.42, 0.2, 0.34), [0, 0.66, 0.0], [0.1, 0, 0]), C.gruntPlate),
    // Shoulder pads high and wide — the horizontal at the TOP, not the middle.
    paint(put(new THREE.SphereGeometry(0.185, seg, lo), [-0.36, 1.22, -0.02], [0, 0, 0.34], [1.05, 0.78, 0.92]), C.gruntShell),
    paint(put(new THREE.SphereGeometry(0.185, seg, lo), [0.36, 1.22, -0.02], [0, 0, -0.34], [1.05, 0.78, 0.92]), C.gruntShell),
    paint(put(new THREE.BoxGeometry(0.30, 0.09, 0.26), [0, 1.30, -0.04]), C.gruntPlate),
    // Methane tank: tall and flat against the spine, not a barrel slung behind.
    paint(put(new THREE.SphereGeometry(0.2, seg, lo), [0, 1.04, 0.30], [0, 0, 0], [0.88, 1.35, 0.62]), C.gruntTank),
    paint(put(new THREE.CylinderGeometry(0.055, 0.07, 0.24, 5), [-0.13, 1.36, 0.28], [0.2, 0, -0.12]), C.gruntTank),
    paint(put(new THREE.CylinderGeometry(0.055, 0.07, 0.24, 5), [0.13, 1.36, 0.28], [0.2, 0, 0.12]), C.gruntTank),
    // Neck then head: the vertical gap above the shoulders is what says biped.
    paint(put(new THREE.CylinderGeometry(0.085, 0.1, 0.14, 6), [0, 1.38, 0.02]), C.gruntTank),
    paint(put(new THREE.SphereGeometry(0.165, seg, lo), [0, 1.50, -0.03], [0, 0, 0], [1.0, 0.94, 1.05]), C.gruntTank),
    paint(put(new THREE.ConeGeometry(0.11, 0.22, 6), [0, 1.45, -0.16], [-Math.PI / 2, 0, 0]), C.gruntTank),
  ]);
  const glow = merge([
    paint(put(new THREE.TorusGeometry(0.16, 0.045, 4, 10), [0, 1.04, 0.30], [Math.PI / 2, 0, 0], [1, 1.4, 1]), GLOW_PAINT(GLOW.methane)),
    paint(put(new THREE.BoxGeometry(0.19, 0.05, 0.05), [0, 1.52, -0.16], [0.1, 0, 0]), GLOW_PAINT(GLOW.eye)),
    // Shoulder-cap pilot lights. Small and dim on purpose: at chest height and
    // full brightness they blew out into two headlamps and read as the widest
    // thing on the body, which is not what the silhouette should be saying.
    paint(put(new THREE.BoxGeometry(0.05, 0.05, 0.05), [-0.38, 1.28, -0.09]), GLOW_PAINT(GLOW.pilot)),
    paint(put(new THREE.BoxGeometry(0.05, 0.05, 0.05), [0.38, 1.28, -0.09]), GLOW_PAINT(GLOW.pilot)),
  ]);
  // Hip pivot at the top; 0.62 m of leg plus a foot that catches the light.
  const limbA = merge([
    paint(put(new THREE.CylinderGeometry(0.115, 0.09, 0.6, 6), [0, -0.3, 0]), C.gruntLimb),
    paint(put(new THREE.BoxGeometry(0.155, 0.09, 0.28), [0, -0.6, -0.05]), C.gruntPlate),
  ]);

  // Both arms and the weapon as one rigid unit pivoting at the chest. The gun
  // runs down-forward and across to the left, so the silhouette is a diagonal
  // through the body rather than a horizontal spike off the side of it.
  const gunRot: [number, number, number] = [-0.222, 0.386, 0];
  const arm = merge([
    paint(put(new THREE.CylinderGeometry(0.075, 0.062, 0.30, 5), [0.335, -0.088, -0.078], [0.55, 0, 0]), C.gruntLimb),
    paint(put(new THREE.CylinderGeometry(0.062, 0.052, 0.30, 5), [0.265, -0.265, -0.20], [1.05, 0.55, 0]), C.gruntLimb),
    paint(put(new THREE.CylinderGeometry(0.075, 0.062, 0.30, 5), [-0.335, -0.088, -0.078], [0.55, 0, 0]), C.gruntLimb),
    paint(put(new THREE.CylinderGeometry(0.058, 0.05, 0.34, 5), [-0.185, -0.245, -0.33], [1.15, -0.7, 0]), C.gruntLimb),
    paint(put(new THREE.BoxGeometry(0.095, 0.14, 0.40), [0.107, -0.324, -0.50], gunRot), C.gunMetal),
    paint(put(new THREE.BoxGeometry(0.075, 0.16, 0.10), [0.10, -0.45, -0.47], gunRot), C.gruntPlate),
    paint(put(new THREE.BoxGeometry(0.05, 0.05, 0.22), [0.018, -0.377, -0.716], gunRot), C.gunMetal),
    paint(put(new THREE.BoxGeometry(0.10, 0.11, 0.09), [-0.004, -0.39, -0.77], gunRot), C.coolant),
  ]);
  return { body, glow, limbA, arm };
}

function buildElite(seg: number): KindGeo {
  const lo = Math.max(5, seg >> 1);
  // Tall, top-heavy, small head slung forward off a long neck. The shoulder
  // span is the whole read — nothing else is that wide that high up — and the
  // gold trim is what keeps the violet from going to mud at distance.
  const body = merge([
    paint(put(new THREE.SphereGeometry(0.44, seg, lo), [0, 1.64, 0], [0.16, 0, 0], [1.2, 1.18, 0.84]), C.eliteArmour),
    paint(put(new THREE.SphereGeometry(0.3, seg, lo), [0, 1.16, 0.04], [0, 0, 0], [0.88, 1.0, 0.8]), C.eliteUnder),
    paint(put(new THREE.SphereGeometry(0.37, seg, lo), [-0.66, 1.9, -0.02], [0, 0, 0.3], [1.06, 0.8, 0.98]), C.eliteArmour),
    paint(put(new THREE.SphereGeometry(0.37, seg, lo), [0.66, 1.9, -0.02], [0, 0, -0.3], [1.06, 0.8, 0.98]), C.eliteArmour),
    paint(put(new THREE.BoxGeometry(0.44, 0.1, 0.44), [-0.72, 2.07, -0.02], [0, 0, 0.32]), C.eliteTrim),
    paint(put(new THREE.BoxGeometry(0.44, 0.1, 0.44), [0.72, 2.07, -0.02], [0, 0, -0.32]), C.eliteTrim),
    paint(put(new THREE.BoxGeometry(0.34, 0.52, 0.24), [-0.84, 1.7, -0.06], [0, 0, 0.24]), C.eliteArmour),
    paint(put(new THREE.BoxGeometry(0.34, 0.52, 0.24), [0.84, 1.7, -0.06], [0, 0, -0.24]), C.eliteArmour),
    paint(put(new THREE.CylinderGeometry(0.13, 0.18, 0.28, 6), [0, 2.02, -0.06], [0.34, 0, 0]), C.eliteUnder),
    paint(put(new THREE.SphereGeometry(0.22, seg, lo), [0, 2.16, -0.19], [0.2, 0, 0], [0.94, 0.88, 1.3]), C.eliteArmour),
    paint(put(new THREE.ConeGeometry(0.14, 0.36, 5), [0, 2.1, -0.4], [-1.35, 0, 0]), C.eliteUnder),
    paint(put(new THREE.BoxGeometry(0.54, 0.36, 0.3), [0, 1.3, 0.32]), C.eliteUnder),
    paint(put(new THREE.BoxGeometry(0.62, 0.09, 0.16), [0, 1.42, -0.34]), C.eliteTrim),
  ]);
  const glow = merge([
    paint(put(new THREE.BoxGeometry(0.3, 0.07, 0.07), [0, 2.21, -0.38], [0.16, 0, 0]), GLOW_PAINT(GLOW.eliteEnergy)),
    // Wide enough to cover several pixels at combat range: a 2 px high-contrast
    // strip crawls the moment anything moves.
    paint(put(new THREE.BoxGeometry(0.14, 0.44, 0.07), [-0.4, 1.62, -0.35]), GLOW_PAINT(GLOW.eliteEnergy)),
    paint(put(new THREE.BoxGeometry(0.14, 0.44, 0.07), [0.4, 1.62, -0.35]), GLOW_PAINT(GLOW.eliteEnergy)),
    paint(put(new THREE.TorusGeometry(0.19, 0.05, 4, 8), [0, 1.32, 0.46], [Math.PI / 2, 0, 0]), GLOW_PAINT(GLOW.eliteEnergy)),
  ]);
  // Digitigrade: the thigh drives back, the shin swings forward to the hoof.
  const limbA = paint(put(new THREE.CylinderGeometry(0.16, 0.13, 0.62, 6), [0, -0.31, 0.06], [-0.16, 0, 0]), C.eliteArmour);
  const limbB = merge([
    paint(put(new THREE.CylinderGeometry(0.12, 0.09, 0.6, 6), [0, -0.3, -0.03]), C.eliteUnder),
    paint(put(new THREE.BoxGeometry(0.18, 0.12, 0.36), [0, -0.58, -0.13]), C.eliteArmour),
  ]);
  const arm = merge([
    paint(put(new THREE.CylinderGeometry(0.1, 0.08, 0.48, 5), [0, -0.2, -0.02]), C.eliteArmour),
    paint(put(new THREE.BoxGeometry(0.15, 0.22, 0.76), [0, -0.44, -0.28]), C.gunMetal),
    paint(put(new THREE.BoxGeometry(0.26, 0.1, 0.24), [0, -0.5, -0.58]), C.eliteArmour),
    paint(put(new THREE.BoxGeometry(0.1, 0.1, 0.16), [0, -0.44, -0.7]), C.coolant),
  ]);
  return { body, glow, limbA, limbB, arm };
}

function buildDrone(seg: number): KindGeo {
  const lo = Math.max(4, seg >> 1);
  // Flat arrowhead. Against the sky it is a dark silhouette, so the read is the
  // two engine eyes — the only cyan point lights anywhere above the horizon.
  const body = merge([
    paint(put(new THREE.ConeGeometry(0.4, 1.5, 4).rotateY(Math.PI / 4), [0, 0, -0.2], [-Math.PI / 2, 0, 0], [1, 1, 0.4]), C.droneHull),
    paint(put(new THREE.BoxGeometry(1.9, 0.1, 0.5), [0, 0.02, 0.22]), C.droneHull),
    paint(put(new THREE.BoxGeometry(1.9, 0.05, 0.12), [0, 0.06, -0.02]), C.droneEdge),
    paint(put(new THREE.BoxGeometry(0.5, 0.24, 0.56), [-0.78, 0.04, 0.22], [0, 0.2, 0]), C.droneHull),
    paint(put(new THREE.BoxGeometry(0.5, 0.24, 0.56), [0.78, 0.04, 0.22], [0, -0.2, 0]), C.droneHull),
    paint(put(new THREE.SphereGeometry(0.22, seg, lo), [0, 0.11, 0.1], [0, 0, 0], [1, 0.72, 1.25]), C.droneEdge),
  ]);
  const glow = merge([
    paint(put(new THREE.SphereGeometry(0.23, 6, 5), [-0.78, 0.04, 0.4], [0, 0, 0], [1, 0.85, 0.7]), GLOW_PAINT(GLOW.droneEye)),
    paint(put(new THREE.SphereGeometry(0.23, 6, 5), [0.78, 0.04, 0.4], [0, 0, 0], [1, 0.85, 0.7]), GLOW_PAINT(GLOW.droneEye)),
    paint(put(new THREE.BoxGeometry(0.1, 0.07, 0.6), [0, 0.15, -0.34]), GLOW_PAINT(GLOW.droneEye)),
  ]);
  const limbA = paint(put(new THREE.TorusGeometry(0.52, 0.045, 4, 12), [0, 0.06, 0.14], [Math.PI / 2, 0, 0]), C.droneEdge);
  return { body, glow, limbA };
}

// --------------------------------------------------------------- shield ---

function shieldMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0.22, 0.86, 1.35) },
      uTime: { value: 0 },
    },
    vertexShader: `
      attribute vec2 aShield;
      varying float vS;
      varying float vFoot;
      varying vec3 vN;
      varying vec3 vW;
      void main() {
        vS = aShield.x;
        vFoot = aShield.y;
        vec4 wp = modelMatrix * instanceMatrix * vec4( position, 1.0 );
        vW = wp.xyz;
        // The bubble is scaled 1.15/1.42/1.15, so the model matrix skews normals
        // toward the poles. Dividing by the squared column lengths is the
        // inverse-transpose without needing GLSL ES 3.00's inverse().
        mat3 im = mat3( instanceMatrix );
        vec3 isc = vec3( dot( im[0], im[0] ), dot( im[1], im[1] ), dot( im[2], im[2] ) );
        vN = normalize( mat3( modelMatrix ) * ( im * ( normal / isc ) ) );
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uTime;
      varying float vS;
      varying float vFoot;
      varying vec3 vN;
      varying vec3 vW;
      void main() {
        if ( vS <= 0.004 ) discard;
        vec3 V = normalize( cameraPosition - vW );
        // Tight enough that the rim is 4-5x the interior. A broad Fresnel wash
        // is a frosted marble, and it desaturates the zealot standing inside it.
        float f = pow( 1.0 - abs( dot( V, normalize( vN ) ) ), 6.0 );
        // Standing wave up the bubble so it reads as a field, not as glass.
        float band = 0.5 + 0.5 * sin( vW.y * 22.0 - uTime * 3.4 );
        // Dissolve into the sand instead of terminating in a straight chord
        // where the terrain clips the sphere.
        float ground = smoothstep( 0.0, 0.5, vW.y - vFoot );
        vec3 c = uColor * ( 0.02 + 2.9 * f + 1.0 * band * f ) * vS * ground;
        gl_FragColor = vec4( c, 1.0 );
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
  });
}

// --------------------------------------------------------------- module ---

type State = "patrol" | "advance" | "cover" | "strafe" | "retreat" | "dead";

interface Bolt {
  active: boolean;
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  /** metres flown, used to hold off the prop test near the shooter */
  travel: number;
  damage: number;
  color: THREE.Color;
  from: THREE.Vector3;
}

const mod: GameModule = {
  id: "covenant",
  order: 30,

  build(ctx: ModuleContext) {
    const { scene, profile, terrain, water, rng } = ctx;
    const seg = profile.tier === "low" ? 6 : profile.tier === "medium" ? 8 : 10;

    const budget =
      profile.tier === "low" ? 6 : profile.tier === "medium" ? 9 : profile.tier === "high" ? 14 : 18;
    const CAP: Record<Kind, number> = {
      grunt: budget,
      elite: Math.max(2, Math.ceil(budget * 0.45)),
      drone: Math.max(2, Math.ceil(budget * 0.4)),
    };

    // ------------------------------------------------------- materials --
    const disposables: Array<{ dispose: () => void }> = [];
    const track = <T extends { dispose: () => void }>(x: T): T => {
      disposables.push(x);
      return x;
    };

    // One armour material and one glow material for the whole faction: the
    // colour lives in the geometry, so this is fifteen instanced meshes sharing
    // two programs.
    const detail = track(detailTexture(profile.textureSize));
    detail.anisotropy = Math.min(4, profile.anisotropy);
    const matArmour = track(armourMaterial(detail));
    const matGlow = track(glowMaterial());
    const matShield = track(shieldMaterial());
    const matDecal = track(decalMaterial());
    const matBoltCore = track(new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }));
    const matBoltHalo = track(
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(1, 1, 1),
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      }),
    );

    // ------------------------------------------------------------ pools --
    const gGeo = buildGrunt(seg);
    const eGeo = buildElite(seg);
    const dGeo = buildDrone(seg);

    const shadows = profile.shadowMapSize > 0;
    const pools = {
      // Limbs cast too. A shadow that is a torso with no legs or arms does not
      // read as a figure, it reads as a rock.
      gruntBody: new PartPool(scene, gGeo.body, matArmour, CAP.grunt, { burn: true, shadow: shadows }),
      gruntLeg: new PartPool(scene, gGeo.limbA!, matArmour, CAP.grunt * 2, { burn: true, shadow: shadows }),
      gruntArm: new PartPool(scene, gGeo.arm!, matArmour, CAP.grunt, { burn: true, shadow: shadows }),
      gruntGlow: new PartPool(scene, gGeo.glow, matGlow, CAP.grunt),
      eliteBody: new PartPool(scene, eGeo.body, matArmour, CAP.elite, { burn: true, shadow: shadows }),
      eliteThigh: new PartPool(scene, eGeo.limbA!, matArmour, CAP.elite * 2, { burn: true, shadow: shadows }),
      eliteShin: new PartPool(scene, eGeo.limbB!, matArmour, CAP.elite * 2, { burn: true, shadow: shadows }),
      eliteArm: new PartPool(scene, eGeo.arm!, matArmour, CAP.elite, { burn: true, shadow: shadows }),
      eliteGlow: new PartPool(scene, eGeo.glow, matGlow, CAP.elite),
      eliteShield: new PartPool(scene, new THREE.SphereGeometry(1, seg + 4, seg + 2), matShield, CAP.elite),
      droneHull: new PartPool(scene, dGeo.body, matArmour, CAP.drone, { burn: true, shadow: shadows }),
      droneRing: new PartPool(scene, dGeo.limbA!, matArmour, CAP.drone, { burn: true, shadow: shadows }),
      droneGlow: new PartPool(scene, dGeo.glow, matGlow, CAP.drone),
    };

    // Claim the per-instance colour buffers up front. Three recompiles the
    // program the first time an InstancedMesh grows one, and a shader compile
    // in the middle of a firefight is a visible hitch.
    const WHITE = new THREE.Color(1, 1, 1);
    for (const p of [pools.gruntBody, pools.eliteBody, pools.droneHull]) {
      for (let i = 0; i < p.mesh.count; i++) p.tint(i, WHITE);
    }

    // The shield bubble needs a per-instance strength and the world Y of the
    // wearer's feet, so the field can fade out where it meets the sand.
    const shieldAttr = new THREE.InstancedBufferAttribute(new Float32Array(CAP.elite * 2), 2);
    shieldAttr.setUsage(THREE.DynamicDrawUsage);
    pools.eliteShield.mesh.geometry.setAttribute("aShield", shieldAttr);
    pools.eliteShield.mesh.castShadow = false;

    // ----------------------------------------------- ground marks --------
    const totalBodies = CAP.grunt + CAP.elite + CAP.drone;
    const scorchCount = Math.max(6, Math.round(20 * profile.particleScale));
    const discGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const scorchGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const contactPool = new PartPool(scene, discGeo, matDecal, totalBodies);
    const scorchPool = new PartPool(scene, scorchGeo, matDecal, scorchCount);
    contactPool.mesh.renderOrder = 0;
    scorchPool.mesh.renderOrder = 0;
    const contactAttr = new THREE.InstancedBufferAttribute(new Float32Array(totalBodies * 3), 3);
    const scorchAttr = new THREE.InstancedBufferAttribute(new Float32Array(scorchCount * 3), 3);
    contactAttr.setUsage(THREE.DynamicDrawUsage);
    scorchAttr.setUsage(THREE.DynamicDrawUsage);
    discGeo.setAttribute("aDecal", contactAttr);
    scorchGeo.setAttribute("aDecal", scorchAttr);

    /** Scorches are a ring buffer: the battlefield keeps the last N kills. */
    const scorchLife = new Float32Array(scorchCount);
    let scorchCursor = 0;
    function dropScorch(x: number, z: number, size: number): void {
      const i = scorchCursor;
      scorchCursor = (scorchCursor + 1) % scorchCount;
      scorchLife[i] = 26;
      scorchAttr.setXYZ(i, 1, rng() * 6.28, 1);
      _q.setFromAxisAngle(UP, rng() * 6.28);
      _v.set(x, groundAt(x, z) + 0.035, z);
      _scale.set(size, 1, size);
      _m.compose(_v, _q, _scale);
      scorchPool.set(i, _m);
      scorchAttr.needsUpdate = true;
    }

    const boltCount = Math.max(36, Math.round(80 * (0.55 + profile.particleScale * 0.6)));
    // Fat at the head, thin at the tail — the taper is the direction cue. Sized
    // to be legible at 40 m: a bolt you cannot see is not a warning.
    const boltGeo = put(new THREE.CylinderGeometry(0.024, 0.09, 1, 5), [0, 0, 0], [Math.PI / 2, 0, 0]);
    const haloGeo = put(new THREE.SphereGeometry(0.19, 6, 5), [0, 0, 0]);
    const boltPools = {
      core: new PartPool(scene, boltGeo, matBoltCore, boltCount),
      halo: new PartPool(scene, haloGeo, matBoltHalo, boltCount),
    };
    boltPools.core.mesh.renderOrder = 3;
    boltPools.halo.mesh.renderOrder = 4;
    for (let i = 0; i < boltCount; i++) {
      boltPools.core.tint(i, WHITE);
      boltPools.halo.tint(i, WHITE);
    }

    const allPools = [...Object.values(pools), contactPool, scorchPool];

    // ------------------------------------------------------ world query --
    const waterAt = (x: number, z: number): number => water.sampleHeight(x, z);
    const groundAt = (x: number, z: number): number => terrain.height(x, z);

    /**
     * Hot path, run every frame by every walker: dry land only, and cheap.
     * terrain.walkable costs five height samples for its slope test, which is
     * not worth paying on the apron and the strand — both are gentle.
     */
    const dryLand = (x: number, z: number): boolean => groundAt(x, z) > waterAt(x, z) + 0.55;

    /** Cold path, for cover and spawn selection: adds the real slope test. */
    const standable = (x: number, z: number): boolean => dryLand(x, z) && terrain.walkable(x, z);

    /**
     * Crates, tents, trailers and hulls, bucketed into a coarse grid. The
     * strand and the pit apron are both nearly flat, so terrain alone offers no
     * cover at all — without the props in this list the "cover" state degrades
     * into wandering, which is exactly what it looked like.
     *
     * Other modules push colliders during their own build, some of which run
     * after this one, so the grid is rebuilt on a slow timer rather than once.
     */
    const CELL = 16;
    let coverBoxes: Collider[] = [];
    const coverGrid = new Map<number, number[]>();
    let coverAge = 99;
    const cellKey = (cx: number, cz: number): number => (cx + 4096) * 8192 + (cz + 4096);

    function rebuildCoverGrid(): void {
      coverBoxes = ctx.colliders.filter((c) => {
        if (!c.solid) return false;
        const b = c.box;
        return b.max.y - b.min.y > 0.7 && b.max.x - b.min.x < 60 && b.max.z - b.min.z < 60;
      });
      coverGrid.clear();
      for (let i = 0; i < coverBoxes.length; i++) {
        const b = coverBoxes[i].box;
        const x0 = Math.floor(b.min.x / CELL);
        const x1 = Math.floor(b.max.x / CELL);
        const z0 = Math.floor(b.min.z / CELL);
        const z1 = Math.floor(b.max.z / CELL);
        for (let cx = x0; cx <= x1; cx++) {
          for (let cz = z0; cz <= z1; cz++) {
            const k = cellKey(cx, cz);
            const list = coverGrid.get(k);
            if (list) list.push(i);
            else coverGrid.set(k, [i]);
          }
        }
      }
    }

    /** Collect the boxes whose cells the segment a→b passes through. */
    const _cells: number[] = [];
    function boxesAlong(ax: number, az: number, bx: number, bz: number, out: number[]): void {
      out.length = 0;
      const x0 = Math.floor(Math.min(ax, bx) / CELL);
      const x1 = Math.floor(Math.max(ax, bx) / CELL);
      const z0 = Math.floor(Math.min(az, bz) / CELL);
      const z1 = Math.floor(Math.max(az, bz) / CELL);
      // A segment longer than a few cells is not worth a DDA; the bounding
      // rectangle of a 30 m sight line is at most a handful of buckets.
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > 64) return;
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const list = coverGrid.get(cellKey(cx, cz));
          if (!list) continue;
          for (const i of list) if (!out.includes(i)) out.push(i);
        }
      }
    }

    /** Slab test: fraction along a→b at which the segment first enters `b`. */
    function segmentBox(
      ax: number, ay: number, az: number,
      bx: number, by: number, bz: number,
      box: THREE.Box3,
    ): number {
      let t0 = 0;
      let t1 = 1;
      const d = [bx - ax, by - ay, bz - az];
      const o = [ax, ay, az];
      const lo = [box.min.x, box.min.y, box.min.z];
      const hi = [box.max.x, box.max.y, box.max.z];
      for (let i = 0; i < 3; i++) {
        if (Math.abs(d[i]) < 1e-6) {
          if (o[i] < lo[i] || o[i] > hi[i]) return -1;
          continue;
        }
        let ta = (lo[i] - o[i]) / d[i];
        let tb = (hi[i] - o[i]) / d[i];
        if (ta > tb) [ta, tb] = [tb, ta];
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) return -1;
      }
      return t0;
    }

    /**
     * Sight test used for the dozens of cover candidates scored each second.
     * Terrain ridges plus the prop grid; ctx.raycast stays for the
     * authoritative "can I shoot the player" check.
     */
    const ridgeBlocks = (a: THREE.Vector3, b: THREE.Vector3): boolean => {
      const dist = a.distanceTo(b);
      const steps = THREE.MathUtils.clamp(Math.round(dist / 3.5), 4, 20);
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        const y = a.y + (b.y - a.y) * t;
        if (groundAt(x, z) > y + 0.3) return true;
      }
      boxesAlong(a.x, a.z, b.x, b.z, _cells);
      for (const i of _cells) {
        if (segmentBox(a.x, a.y, a.z, b.x, b.y, b.z, coverBoxes[i].box) >= 0) return true;
      }
      return false;
    };

    // ------------------------------------------------------- spawn ring --
    /**
     * Anchors on dry ground: a band along the strand either side of the pit
     * gate, plus a ring around the apron itself, so waves come out of the
     * festival ground and up off the shore rather than out of thin air.
     */
    const anchors: THREE.Vector3[] = [];
    for (let i = 0; i < 46; i++) {
      const x = -260 + (520 * i) / 45 + (rng() - 0.5) * 14;
      let z = 4 + rng() * 26;
      let guard = 0;
      while (!standable(x, z) && guard++ < 22) z += 3;
      if (guard < 22) anchors.push(new THREE.Vector3(x, 0, z));
    }
    for (let i = 0; i < 34; i++) {
      const a = (i / 34) * Math.PI * 2;
      const r = 46 + rng() * 105;
      const x = Math.cos(a) * r;
      const z = 62 + Math.sin(a) * r * 0.72;
      if (standable(x, z)) anchors.push(new THREE.Vector3(x, 0, z));
    }

    // --------------------------------------------------------- entities --
    interface Enemy {
      kind: Kind;
      /** index inside this kind's part pools */
      slot: number;
      /** index inside the faction-wide contact-shadow pool */
      slot2: number;
      spec: Spec;
      target: DamageTarget;
      active: boolean;

      pos: THREE.Vector3;
      vel: THREE.Vector3;
      yaw: number;
      aimYaw: number;
      aimPitch: number;
      groundY: number;
      groundAge: number;

      health: number;
      maxHealth: number;
      shield: number;
      maxShield: number;
      shieldBroken: boolean;
      shieldFlash: number;
      damageQuiet: number;

      state: State;
      stateT: number;
      aware: boolean;
      awareT: number;
      reaction: number;
      canSee: boolean;
      senseT: number;
      lastSeen: THREE.Vector3;
      distToPlayer: number;

      moveTo: THREE.Vector3;
      hasMoveTo: boolean;
      repathT: number;
      strafeDir: number;
      strafeT: number;
      advanceUntil: number;
      retreatUntil: number;
      /** Squad permission to open fire. See directSquad. */
      fireToken: boolean;

      fireT: number;
      burstLeft: number;
      burstT: number;
      aimError: number;
      lead: number;
      firstBurst: boolean;

      panicUntil: number;
      flinch: number;
      phase: number;
      gait: number;
      /**
       * Actual per-frame ground speed, not `vel`. Cover leans, separation and
       * prop push-out all move `pos` directly, so a gait driven off `vel` shows
       * static legs while the body slides sideways.
       */
      speedSeen: number;
      scale: number;
      tint: THREE.Color;

      deathT: number;
      deathDir: THREE.Vector3;
      deathTilt: number;
      deathSpin: number;
      corpseY: number;
      fell: boolean;
    }

    const enemies: Enemy[] = [];
    const unregisters: Array<() => void> = [];
    let idCounter = 0;

    const pickRank = <T extends { weight: number }>(list: T[]): T => {
      let r = rng();
      for (const item of list) {
        r -= item.weight;
        if (r <= 0) return item;
      }
      return list[0];
    };

    function makeEnemy(kind: Kind, slot: number, slot2: number): Enemy {
      const spec = SPECS[kind];
      const e: Enemy = {
        kind,
        slot,
        slot2,
        spec,
        active: false,
        target: null as unknown as DamageTarget,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        yaw: 0,
        aimYaw: 0,
        aimPitch: 0,
        groundY: 0,
        groundAge: 0,
        health: spec.health,
        maxHealth: spec.health,
        shield: spec.shield,
        maxShield: spec.shield,
        shieldBroken: false,
        shieldFlash: 0,
        damageQuiet: 0,
        state: "patrol",
        stateT: 0,
        aware: false,
        awareT: 0,
        reaction: 0.5,
        canSee: false,
        senseT: 0,
        lastSeen: new THREE.Vector3(),
        distToPlayer: 999,
        moveTo: new THREE.Vector3(),
        hasMoveTo: false,
        repathT: 0,
        strafeDir: 1,
        strafeT: 0,
        advanceUntil: 0,
        retreatUntil: 0,
        fireToken: false,
        fireT: 0,
        burstLeft: 0,
        burstT: 0,
        aimError: spec.aimErrorMax,
        lead: 0.5,
        firstBurst: true,
        panicUntil: 0,
        flinch: 0,
        phase: 0,
        gait: 0,
        speedSeen: 0,
        scale: 1,
        tint: new THREE.Color(1, 1, 1),
        deathT: 0,
        deathDir: new THREE.Vector3(0, 0, 1),
        deathTilt: 0,
        deathSpin: 0,
        corpseY: 0,
        fell: false,
      };

      const target: DamageTarget = {
        id: `cov-${kind}-${idCounter++}`,
        name: spec.name,
        // Its own vector, tracked to the middle of the mass each frame. Sharing
        // e.pos would put the hit sphere half underground.
        position: new THREE.Vector3(),
        radius: spec.radius,
        headOffset: spec.headOffset,
        headRadius: spec.headRadius,
        health: spec.health,
        maxHealth: spec.health,
        team: "covenant",
        alive: false,
        applyDamage: (amount, headshot, direction) => applyDamage(e, amount, headshot, direction),
      };
      e.target = target;
      unregisters.push(ctx.registerTarget(target));
      return e;
    }

    (Object.keys(CAP) as Kind[]).forEach((kind) => {
      for (let i = 0; i < CAP[kind]; i++) enemies.push(makeEnemy(kind, i, enemies.length));
    });

    const free = (kind: Kind): Enemy | null => enemies.find((e) => e.kind === kind && !e.active) ?? null;
    const liveCount = (): number => enemies.reduce((n, e) => n + (e.active && e.state !== "dead" ? 1 : 0), 0);

    // ---------------------------------------------------------- damage --
    let score = 0;
    let combo = 0;
    let comboT = 0;

    function applyDamage(e: Enemy, amount: number, headshot: boolean, direction: THREE.Vector3): boolean {
      if (!e.active || e.state === "dead") return false;
      e.damageQuiet = 0;
      e.deathDir.copy(direction).setY(0).normalize();
      e.flinch = Math.min(1, e.flinch + amount / 60);

      // Being shot is how a patrolling enemy finds out there is a fight.
      if (!e.aware) {
        e.aware = true;
        e.lastSeen.copy(ctx.player.position);
        callout(e, "contact");
      }

      let dmg = amount;
      if (e.shield > 0) {
        const absorbed = Math.min(e.shield, dmg);
        e.shield -= absorbed;
        dmg -= absorbed;
        e.shieldFlash = 1;
        if (e.shield <= 0 && !e.shieldBroken) {
          e.shieldBroken = true;
          _v.copy(e.pos).setY(e.pos.y + e.spec.centreY);
          ctx.fx.spawn("shield-pop", _v, UP, 2.4);
          ctx.fx.spawn("plasma-burst", _v, UP, 1.4);
          ctx.sound.play("impact-metal", _v, 1, 0.55);
          bus.emit("notify", { text: "ZEALOT SHIELD DOWN", kind: "good" });
        }
        // A collapsing shield eats most of the overkill — you have to commit.
        dmg *= 0.55;
        if (dmg <= 0) {
          e.target.health = e.health;
          return false;
        }
      }

      e.health -= dmg;
      e.target.health = Math.max(0, e.health);
      if (e.health > 0) return false;

      kill(e, headshot);
      return true;
    }

    function kill(e: Enemy, headshot: boolean): void {
      e.state = "dead";
      e.deathT = 0;
      e.fell = false;
      e.target.alive = false;
      e.target.health = 0;
      e.deathTilt = 0;
      e.deathSpin = (Math.random() - 0.5) * 2.4;
      e.corpseY = e.pos.y;
      // Something has to be left behind, or a fight that was won looks exactly
      // like a fight that never happened.
      dropScorch(e.pos.x, e.pos.z, e.spec.radius * (e.kind === "grunt" ? 4.4 : 3.4));

      _v.copy(e.pos).setY(e.pos.y + e.spec.centreY);
      ctx.fx.spawn("impact-flesh", _v, UP, headshot ? 2.2 : 1.5);
      if (e.kind === "grunt") {
        // The methane tank goes off. It is the best thing about killing grunts.
        _v2.copy(e.pos).setY(e.pos.y + 1.05);
        ctx.fx.spawn("plasma-burst", _v2, UP, 2.2);
        ctx.sound.play("explosion", _v2, 0.34, 1.55);
      } else if (e.kind === "drone") {
        ctx.fx.spawn("explosion", _v, UP, 1.1);
        ctx.sound.play("explosion", _v, 0.5, 1.25);
      } else {
        ctx.fx.spawn("plasma-burst", _v, UP, 2.6);
        ctx.sound.play("explosion", _v, 0.42, 0.85);
      }

      comboT = 3.4;
      combo += 1;
      score += Math.round(e.spec.score * (1 + combo * 0.12) * (headshot ? 1.5 : 1));
      bus.emit("score:changed", { score, combo });

      // Grunts break when the thing giving them orders dies.
      if (e.kind === "elite") {
        for (const o of enemies) {
          if (o.kind !== "grunt" || !o.active || o.state === "dead") continue;
          if (o.pos.distanceToSquared(e.pos) < 45 * 45 && Math.random() < 0.75) {
            o.panicUntil = 2.6 + Math.random() * 2.4;
            o.aware = true;
          }
        }
        bus.emit("notify", { text: "ZEALOT DOWN", kind: "good" });
      }
    }

    // -------------------------------------------------------- callouts --
    let calloutCooldown = 0;
    function callout(e: Enemy, kind: "contact" | "flank" | "panic"): void {
      if (calloutCooldown > 0) return;
      calloutCooldown = kind === "panic" ? 1.4 : 2.6;
      const pitch = e.kind === "grunt" ? 1.9 : e.kind === "drone" ? 2.3 : 0.62;
      ctx.sound.play("shot-plasma", e.pos, 0.32, pitch);
      if (kind === "contact" && e.kind === "elite") {
        bus.emit("subtitle", { speaker: "ZEALOT", text: "There! Wretch — do not let it reach the pits!", duration: 2.6 });
      } else if (kind === "panic") {
        bus.emit("subtitle", { speaker: "GRUNT", text: "It killed the boss! RUN!", duration: 2.2 });
      }
    }

    // ----------------------------------------------------------- bolts --
    const bolts: Bolt[] = [];
    for (let i = 0; i < boltCount; i++) {
      bolts.push({
        active: false,
        pos: new THREE.Vector3(),
        prev: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
        travel: 0,
        damage: 0,
        color: new THREE.Color(),
        from: new THREE.Vector3(),
      });
    }
    let boltCursor = 0;

    function fireBolt(from: THREE.Vector3, dir: THREE.Vector3, spec: Spec, skill: number): void {
      let b: Bolt | null = null;
      for (let i = 0; i < bolts.length; i++) {
        const cand = bolts[(boltCursor + i) % bolts.length];
        if (!cand.active) {
          b = cand;
          boltCursor = (boltCursor + i + 1) % bolts.length;
          break;
        }
      }
      if (!b) return;
      b.active = true;
      b.pos.copy(from);
      b.prev.copy(from);
      b.vel.copy(dir).multiplyScalar(spec.boltSpeed);
      b.life = (spec.boltSpeed > 0 ? 260 / spec.boltSpeed : 3) + 0.4;
      b.travel = 0;
      b.damage = spec.boltDamage * skill;
      b.color.copy(spec.boltColor);
      b.from.copy(from);
      ctx.fx.spawn("muzzle", from, dir, 0.5);
    }

    function updateBolts(dt: number): void {
      const player = ctx.player;
      _v3.copy(player.position).setY(player.position.y + player.eyeHeight * 0.55);
      const hitRadius = 0.66;

      for (let i = 0; i < bolts.length; i++) {
        const b = bolts[i];
        if (!b.active) {
          boltPools.core.hide(i);
          boltPools.halo.hide(i);
          continue;
        }
        b.prev.copy(b.pos);
        b.pos.addScaledVector(b.vel, dt);
        b.life -= dt;
        b.travel += b.vel.length() * dt;

        // Player: closest approach of this step's segment to the chest sphere.
        _v.subVectors(b.pos, b.prev);
        const segLen2 = _v.lengthSq();
        _v2.subVectors(_v3, b.prev);
        const t = segLen2 > 1e-6 ? THREE.MathUtils.clamp(_v2.dot(_v) / segLen2, 0, 1) : 0;
        _v2.copy(b.prev).addScaledVector(_v, t);
        if (!player.dead && _v2.distanceToSquared(_v3) < hitRadius * hitRadius) {
          _v.subVectors(b.from, player.position).normalize();
          player.damage(b.damage, _v);
          ctx.fx.spawn("plasma-burst", _v2, _v, 0.9);
          ctx.sound.play("impact-metal", undefined, 0.5, 1.4);
          b.active = false;
          boltPools.core.hide(i);
          boltPools.halo.hide(i);
          continue;
        }

        // Props stop plasma. Without this the player cannot take cover behind
        // anything on the field, which makes every crate decorative. The first
        // couple of metres are exempt: a shooter leaning on a trailer would
        // otherwise detonate every round against its own cover.
        let hitProp = -1;
        if (b.travel > 2.5) boxesAlong(b.prev.x, b.prev.z, b.pos.x, b.pos.z, _cells);
        else _cells.length = 0;
        for (const ci of _cells) {
          const t2 = segmentBox(
            b.prev.x, b.prev.y, b.prev.z,
            b.pos.x, b.pos.y, b.pos.z,
            coverBoxes[ci].box,
          );
          if (t2 >= 0 && (hitProp < 0 || t2 < hitProp)) hitProp = t2;
        }
        if (hitProp >= 0) {
          _v.subVectors(b.pos, b.prev);
          _v2.copy(b.prev).addScaledVector(_v, hitProp);
          ctx.fx.spawn("plasma-burst", _v2, UP, 0.8);
          ctx.sound.play("impact-metal", _v2, 0.4, 1.25);
          b.active = false;
          boltPools.core.hide(i);
          boltPools.halo.hide(i);
          continue;
        }

        const gh = groundAt(b.pos.x, b.pos.z);
        const wh = waterAt(b.pos.x, b.pos.z);
        const surf = Math.max(gh, wh);
        if (b.life <= 0 || b.pos.y <= surf) {
          if (b.pos.y <= surf) {
            _v.copy(b.pos).setY(surf);
            ctx.fx.spawn(gh > wh ? "plasma-burst" : "impact-water", _v, UP, 0.9);
          }
          b.active = false;
          boltPools.core.hide(i);
          boltPools.halo.hide(i);
          continue;
        }

        // Stretched along travel so it reads as a bolt, not a dot.
        _v.copy(b.vel).normalize();
        _q.setFromUnitVectors(FORWARD, _v);
        _scale.set(1, 1, 3.4);
        _m.compose(b.pos, _q, _scale);
        boltPools.core.set(i, _m);
        boltPools.core.tint(i, b.color);
        _scale.set(1, 1, 1);
        _v2.copy(b.pos).addScaledVector(_v, 1.1);
        _m.compose(_v2, _q, _scale);
        boltPools.halo.set(i, _m);
        boltPools.halo.tint(i, b.color);
      }
      boltPools.core.flush();
      boltPools.halo.flush();
    }

    // ------------------------------------------------------- spawning ---
    /**
     * Whether this landing has already seen the player. The opening group of a
     * wave has: it dropped onto the strand to take the pits and the player is
     * standing in them, so a second of blank staring before anyone reacts is
     * neither plausible nor fun. Reinforcements arriving off-screen still have
     * to find you the hard way.
     */
    let spawnAlert = false;

    function spawnAt(kind: Kind, at: THREE.Vector3): Enemy | null {
      const e = free(kind);
      if (!e) return null;
      const spec = e.spec;
      const rank =
        kind === "grunt" ? pickRank(GRUNT_RANKS) : kind === "elite" ? pickRank(ELITE_RANKS) : GRUNT_RANKS[0];

      e.active = true;
      e.pos.copy(at);
      e.vel.set(0, 0, 0);
      e.groundY = groundAt(at.x, at.z);
      e.groundAge = 0;
      if (kind === "drone") e.pos.y = Math.max(e.groundY, waterAt(at.x, at.z)) + 7 + rng() * 5;
      else e.pos.y = e.groundY;

      e.maxHealth = spec.health * rank.health;
      e.health = e.maxHealth;
      e.maxShield = spec.shield * rank.health;
      e.shield = e.maxShield;
      e.shieldBroken = false;
      e.shieldFlash = 0;
      e.damageQuiet = 9;

      e.state = "patrol";
      e.stateT = 0;
      e.aware = spawnAlert;
      e.awareT = 0;
      e.canSee = false;
      e.senseT = rng() * 0.2;
      e.distToPlayer = 999;
      e.hasMoveTo = false;
      e.repathT = rng() * 0.8;
      e.strafeDir = rng() < 0.5 ? -1 : 1;
      e.strafeT = 0;
      e.advanceUntil = 0;
      e.retreatUntil = 0;
      e.fireToken = false;
      e.fireT = 0.7 + rng() * 0.9;
      e.burstLeft = 0;
      e.burstT = 0;
      e.firstBurst = true;
      e.panicUntil = 0;
      e.flinch = 0;
      e.deathT = 0;
      // Everything that decides how this individual LOOKS or WHERE it stands
      // runs off ctx.rng, so the opening tableau is the same frame every load
      // and can actually be art-directed. Per-frame combat jitter stays on
      // Math.random — nobody screenshots a recoil cone.
      e.phase = rng() * Math.PI * 2;
      e.gait = rng() * 6;
      e.scale = 0.94 + rng() * 0.12;
      e.tint.copy(rank.tint);

      // Personality: reaction time and aim cone vary per individual, then the
      // rank sharpens or dulls them. Two identical grunts would feel robotic.
      const t = rng();
      e.reaction = THREE.MathUtils.lerp(spec.reactionMin, spec.reactionMax, t) * (2 - rank.skill);
      e.aimError = THREE.MathUtils.lerp(spec.aimErrorMin, spec.aimErrorMax, rng()) * rank.skill;
      e.lead = 0.3 + rng() * 0.55 * (2 - rank.skill);

      const yawToPlayer = Math.atan2(ctx.player.position.x - at.x, ctx.player.position.z - at.z);
      e.yaw = yawToPlayer + Math.PI + (rng() - 0.5) * (spawnAlert ? 0.5 : 1.4);
      e.aimYaw = e.yaw;
      e.aimPitch = 0;

      e.target.alive = true;
      e.target.health = e.health;
      e.target.maxHealth = e.maxHealth;
      e.target.radius = spec.radius * e.scale;

      const bodyPool =
        kind === "grunt" ? pools.gruntBody : kind === "elite" ? pools.eliteBody : pools.droneHull;
      bodyPool.tint(e.slot, e.tint);

      _v.copy(e.pos).setY(e.pos.y + 0.9);
      // The opening group is already on the ground when the fight starts, so it
      // does not get a translocation flare — only reinforcements phase in.
      if (!spawnAlert) ctx.fx.spawn("plasma-burst", _v, UP, 1.1);
      ctx.sound.play("impact-metal", _v, 0.45, 1.7);
      return e;
    }

    /**
     * The opening group is staged as a composition, not a rank. A constant
     * radius put every enemy on one screen row at one apparent size — a line of
     * skittles — so each index gets its own depth band as well as its own
     * bearing: the odd ones close enough to be a threat now, the even ones back
     * in the midground, one deliberately deep and dead centre for the zealot.
     * The fan is narrow enough that nobody lands under the viewmodel at fov 78.
     */
    function frontSpawn(index: number, count: number, wave: number, deep: boolean): THREE.Vector3 | null {
      const p = ctx.player.position;
      const centre = Math.atan2(-ctx.player.forward.x, -ctx.player.forward.z);
      const t = count > 1 ? index / (count - 1) - 0.5 : 0;
      const a = centre + (deep ? t * 0.34 : t * 0.86) + (rng() - 0.5) * 0.2;
      // Alternate near and far so the group has a foreground and a background.
      // The near band has to be genuinely near: from z=20 to z=55 the strand
      // falls at almost exactly the rate that cancels perspective, so two
      // enemies 25 m apart in depth still land on the same screen row unless
      // one of them is close enough to be a different size entirely.
      const band = deep ? 0.86 : index % 2 === 0 ? 0.03 : 0.44;
      let d = 12 + band * 36 + rng() * 5 + Math.min(9, wave * 1.1);
      for (let k = 0; k < 12; k++) {
        const x = p.x - Math.sin(a) * d;
        const z = p.z - Math.cos(a) * d;
        // Walk back toward the player until the fan lands on dry ground rather
        // than in the lake.
        if (dryLand(x, z) && terrain.walkable(x, z) && d > 11) {
          return new THREE.Vector3(x, groundAt(x, z), z);
        }
        d -= 3.4;
        if (d < 11) break;
      }
      return null;
    }

    /** Reinforcements come from the shore and the apron, off-screen if possible. */
    function pickSpawn(minDist: number, maxDist: number, preferVisible = false): THREE.Vector3 | null {
      const p = ctx.player.position;
      const fwd = ctx.player.forward;
      let best: THREE.Vector3 | null = null;
      let bestScore = -1e9;
      for (let i = 0; i < 26; i++) {
        const a = anchors[Math.floor(rng() * anchors.length)];
        if (!a) continue;
        const x = a.x + (rng() - 0.5) * 22;
        const z = a.z + (rng() - 0.5) * 22;
        if (!standable(x, z)) continue;
        const dx = x - p.x;
        const dz = z - p.z;
        const d = Math.hypot(dx, dz);
        if (d < minDist || d > maxDist) continue;
        const facing = (dx * fwd.x + dz * fwd.z) / (d || 1);
        let s = -Math.abs(d - (minDist + maxDist) * 0.5) * 0.05;
        if (preferVisible ? facing > 0.78 : facing < 0.25) s += 1.6;
        // Spread the landing out. A squad stacked on one anchor is one target.
        for (const o of enemies) {
          if (!o.active || o.state === "dead") continue;
          const sep = Math.hypot(x - o.pos.x, z - o.pos.z);
          if (sep < 26) s -= (26 - sep) * 0.12;
        }
        s += rng() * 0.7;
        if (s > bestScore) {
          bestScore = s;
          best = new THREE.Vector3(x, groundAt(x, z), z);
        }
      }
      return best;
    }

    // ---------------------------------------------------------- waves ---
    let wave = 0;
    let waveQueue: Kind[] = [];
    let waveTotal = 0;
    let waveTimer = 3.2;
    let waveActive = false;
    let trickle = 0;

    function composeWave(n: number): Kind[] {
      const list: Kind[] = [];
      const grunts = Math.min(CAP.grunt + 6, 4 + Math.round(n * 1.4));
      const elites = Math.min(CAP.elite + 2, 1 + Math.floor((n - 1) * 0.6));
      // A drone from the first wave: all three silhouettes need to be on the
      // field before the player has decided what this faction is.
      const drones = Math.min(CAP.drone + 2, Math.floor(n * 0.5) + 1);
      for (let i = 0; i < grunts; i++) list.push("grunt");
      for (let i = 0; i < elites; i++) list.push("elite");
      for (let i = 0; i < drones; i++) list.push("drone");
      // Interleave so the first thing over the berm is not always a grunt.
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      return list;
    }

    let pendingAnnounce: (() => void) | null = null;

    function startWave(): void {
      wave += 1;
      waveQueue = composeWave(wave);
      waveTotal = waveQueue.length;
      waveActive = true;
      trickle = 1.2;

      // The opening group lands together and in view. Anything past the
      // concurrent budget trickles in behind it as the field clears.
      // Zealots are placed first and deliberately — deep and centre, where the
      // shield bubble reads as the thing at the back of the picture you have to
      // work through — rather than wherever the shuffle happened to put them.
      const first = Math.min(waveQueue.length, budget - liveCount());
      spawnAlert = true;
      const order = waveQueue
        .slice(0, first)
        .map((k, i) => ({ k, i }))
        .sort((a, b) => (a.k === "elite" ? 0 : 1) - (b.k === "elite" ? 0 : 1) || a.i - b.i)
        .map((o) => o.k);
      for (let i = 0; i < order.length; i++) {
        const kind = order[i];
        const deep = kind === "elite";
        const at = frontSpawn(i, order.length, wave, deep) ?? pickSpawn(22, 60, true);
        if (!at || !spawnAt(kind, at)) break;
        waveQueue.splice(waveQueue.indexOf(kind), 1);
      }

      spawnAlert = false;

      const n = wave;
      const total = waveTotal;
      pendingAnnounce = () => {
        bus.emit("wave:started", { wave: n, enemies: total });
        bus.emit("notify", { text: `WAVE ${n} — ${total} HOSTILES`, kind: "warn" });
        if (n === 1) {
          bus.emit("objective:changed", {
            text: "HOLD THE STAN SAYRES PITS",
            sub: "Remnant landing party on the strand.",
          });
          bus.emit("subtitle", {
            speaker: "SEAFAIR CONTROL",
            text: "Contacts on the strand — they came up out of the lake. Hold the pits.",
            duration: 4,
          });
        } else if (n % 3 === 0) {
          bus.emit("spectacle", { text: `WAVE ${n}` });
        }
      };
    }

    function updateWaves(dt: number): void {
      if (!waveActive) {
        waveTimer -= dt;
        if (waveTimer <= 0) startWave();
        return;
      }

      trickle -= dt;
      const alive = liveCount();
      // Reinforcements feed in as the field clears, so pressure is constant but
      // the concurrent count never exceeds what the tier can draw.
      if (waveQueue.length > 0 && alive < budget && trickle <= 0) {
        const kind = waveQueue[0];
        const at = pickSpawn(34, 80 + Math.min(100, wave * 14));
        if (at) {
          const spawned = spawnAt(kind, at);
          if (spawned) {
            waveQueue.shift();
            trickle = 0.55 + rng() * 0.9;
            if (kind === "elite" && rng() < 0.6) {
              bus.emit("notify", { text: "ZEALOT INBOUND", kind: "warn" });
            }
          } else {
            // That kind's pool is full — try a different one rather than
            // stalling the whole wave behind it.
            waveQueue.push(waveQueue.shift()!);
            trickle = 0.4;
          }
        } else {
          trickle = 0.5;
        }
      }

      if (waveQueue.length === 0 && alive === 0) {
        waveActive = false;
        waveTimer = 7.5;
        bus.emit("wave:cleared", { wave });
        bus.emit("notify", { text: `WAVE ${wave} CLEAR`, kind: "good" });
        bus.emit("objective:changed", {
          text: `WAVE ${wave} CLEAR`,
          sub: `Regroup. Wave ${wave + 1} inbound.`,
        });
      }
    }

    // ------------------------------------------------------------- AI ---
    let squadTimer = 0;

    /**
     * Only this many of the squad may be shooting at any moment. Without a cap,
     * incoming damage scales linearly with the quality tier and an ultra
     * machine gets a fight nobody could survive; with one, a big wave reads as
     * pressure from a few directions at a time instead of an undodgeable wall.
     */
    const maxFiring = Math.min(6, Math.max(3, Math.round(budget * 0.5)));

    /** Bounding: only a slice of the squad pushes at a time; the rest suppress. */
    function directSquad(): void {
      const pushers = enemies
        .filter((e) => e.active && e.state !== "dead" && e.aware && e.kind !== "drone")
        .sort((a, b) => a.distToPlayer - b.distToPlayer);
      const allowed = Math.max(1, Math.ceil(pushers.length * 0.4));
      for (let i = 0; i < pushers.length; i++) {
        // The far half of the squad is the half that moves — the close ones
        // already have the angle and should be shooting, not walking into it.
        pushers[i].advanceUntil = i >= pushers.length - allowed ? 2.2 + Math.random() * 1.6 : 0;
      }

      // The jitter keeps the token from parking on the same three individuals,
      // so fire trades around the squad instead of coming from one corner.
      const shooters = enemies
        .filter((e) => e.active && e.state !== "dead" && e.aware && e.canSee)
        .map((e) => ({ e, k: e.distToPlayer + Math.random() * 22 }))
        .sort((a, b) => a.k - b.k);
      for (let i = 0; i < shooters.length; i++) shooters[i].e.fireToken = i < maxFiring;
      for (const e of enemies) if (!e.aware || !e.canSee) e.fireToken = false;
    }

    /**
     * Candidates are drawn from two sources: the shadow side of nearby props,
     * and a uniform ring as a fallback. Uniform sampling alone finds nothing on
     * a flat apron, which is why "take cover" used to look like "wander".
     */
    const _cand: number[] = [];
    function findCover(e: Enemy, awayFromPlayer: boolean): void {
      const p = ctx.player.position;
      _v3.set(p.x, p.y + ctx.player.eyeHeight, p.z);
      let best: THREE.Vector3 | null = null;
      let bestScore = -1e9;
      let foundHidden = false;

      boxesAlong(e.pos.x - 18, e.pos.z - 18, e.pos.x + 18, e.pos.z + 18, _cand);
      const props = Math.min(_cand.length, 5);

      for (let i = 0; i < 12 + props; i++) {
        let x: number;
        let z: number;
        if (i < props) {
          // Stand just off the face of the box that points away from the player.
          const b = coverBoxes[_cand[i]].box;
          const cx = (b.min.x + b.max.x) * 0.5;
          const cz = (b.min.z + b.max.z) * 0.5;
          const dx = cx - p.x;
          const dz = cz - p.z;
          const len = Math.max(0.5, Math.hypot(dx, dz));
          const out = awayFromPlayer ? 1 : 0.55;
          const half = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * 0.5;
          x = cx + (dx / len) * (half + 0.9) * out + (Math.random() - 0.5) * 1.6;
          z = cz + (dz / len) * (half + 0.9) * out + (Math.random() - 0.5) * 1.6;
        } else {
          const a = Math.random() * Math.PI * 2;
          const r = 5 + Math.random() * 11;
          x = e.pos.x + Math.cos(a) * r;
          z = e.pos.z + Math.sin(a) * r;
        }
        if (!standable(x, z)) continue;
        const gy = groundAt(x, z);
        _v.set(x, gy + e.spec.eye, z);
        const hidden = ridgeBlocks(_v, _v3);
        const d = Math.hypot(x - p.x, z - p.z);
        const reach = Math.hypot(x - e.pos.x, z - e.pos.z);
        let s = hidden ? 6 : 0;
        s -= Math.abs(d - (awayFromPlayer ? e.spec.rangeMax * 1.6 : e.spec.rangeMax * 0.75)) * 0.09;
        s -= reach * 0.05;
        s += Math.random() * 1.2;
        if (s > bestScore) {
          bestScore = s;
          foundHidden = hidden;
          best = new THREE.Vector3(x, gy, z);
        }
      }
      if (best && foundHidden) {
        e.moveTo.copy(best);
        e.hasMoveTo = true;
        return;
      }

      // The strand and the apron are genuinely open — there are stretches with
      // no cover within 18 m. Wandering to a random nearby point there reads as
      // aimless milling, so with nothing to hide behind the squad swings around
      // the player at its preferred fighting range instead. Circling is a
      // legible intent; drifting is not.
      const want = awayFromPlayer ? e.spec.rangeMax * 1.5 : e.spec.rangeMax * 0.72;
      const bearing = Math.atan2(e.pos.x - p.x, e.pos.z - p.z);
      for (let k = 0; k < 3; k++) {
        const a = bearing + e.strafeDir * (0.45 + Math.random() * 0.4);
        const x = p.x + Math.sin(a) * want;
        const z = p.z + Math.cos(a) * want;
        if (standable(x, z)) {
          e.moveTo.set(x, groundAt(x, z), z);
          e.hasMoveTo = true;
          return;
        }
        e.strafeDir *= -1;
      }
      if (best) {
        e.moveTo.copy(best);
        e.hasMoveTo = true;
      }
    }

    function steer(e: Enemy, dt: number, dest: THREE.Vector3, speed: number): void {
      _v.set(dest.x - e.pos.x, 0, dest.z - e.pos.z);
      const d = _v.length();
      if (d < 0.4) {
        e.vel.multiplyScalar(Math.max(0, 1 - dt * 6));
        return;
      }
      _v.multiplyScalar(1 / d);

      // Refuse to walk into the lake: fan out from the desired heading and take
      // the first bearing that lands on dry, walkable ground.
      const probe = Math.max(1.4, speed * 0.32);
      let chosen: THREE.Vector3 | null = null;
      for (const off of [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6]) {
        const c = Math.cos(off);
        const s = Math.sin(off);
        const dx = _v.x * c - _v.z * s;
        const dz = _v.x * s + _v.z * c;
        if (dryLand(e.pos.x + dx * probe, e.pos.z + dz * probe)) {
          chosen = _v2.set(dx, 0, dz);
          break;
        }
      }
      if (!chosen) {
        e.vel.multiplyScalar(Math.max(0, 1 - dt * 8));
        e.hasMoveTo = false;
        return;
      }

      const blend = 1 - Math.exp(-7 * dt);
      e.vel.x = THREE.MathUtils.lerp(e.vel.x, chosen.x * speed, blend);
      e.vel.z = THREE.MathUtils.lerp(e.vel.z, chosen.z * speed, blend);
    }

    function separate(e: Enemy, dt: number): void {
      for (const o of enemies) {
        if (o === e || !o.active || o.state === "dead" || o.kind !== e.kind) continue;
        const dx = e.pos.x - o.pos.x;
        const dz = e.pos.z - o.pos.z;
        const d2 = dx * dx + dz * dz;
        const want = e.spec.radius * 2.1;
        if (d2 > want * want || d2 < 1e-5) continue;
        const d = Math.sqrt(d2);
        const push = ((want - d) / d) * 3.4 * dt;
        e.pos.x += dx * push;
        e.pos.z += dz * push;
      }
    }

    function pushOutOfProps(e: Enemy): void {
      const r = e.spec.radius * 0.7;
      for (const c of ctx.colliders) {
        if (!c.solid) continue;
        const b = c.box;
        if (e.pos.y + 0.4 < b.min.y || e.pos.y > b.max.y - 0.1) continue;
        if (e.pos.x < b.min.x - r || e.pos.x > b.max.x + r) continue;
        if (e.pos.z < b.min.z - r || e.pos.z > b.max.z + r) continue;
        const cx = THREE.MathUtils.clamp(e.pos.x, b.min.x, b.max.x);
        const cz = THREE.MathUtils.clamp(e.pos.z, b.min.z, b.max.z);
        const dx = e.pos.x - cx;
        const dz = e.pos.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = (r - d) / d;
        e.pos.x += dx * push;
        e.pos.z += dz * push;
      }
    }

    function tryFire(e: Enemy, dt: number): void {
      const player = ctx.player;
      if (player.dead) return;

      if (e.burstLeft > 0) {
        e.burstT -= dt;
        if (e.burstT > 0) return;
        e.burstT = e.spec.boltGap;
        e.burstLeft -= 1;

        const muzzle = muzzleOf(e, _v3);
        _v.copy(player.position);
        _v.y += player.eyeHeight * 0.55;
        const flight = muzzle.distanceTo(_v) / e.spec.boltSpeed;
        _v.addScaledVector(player.velocity, flight * e.lead);
        _v.sub(muzzle).normalize();

        // The opening burst of an engagement is deliberately wide: the player
        // gets a tracer past the ear before anything actually lands.
        const err = e.aimError * (e.firstBurst ? 2.3 : 1) * (e.panicUntil > 0 ? 2.6 : 1);
        _v2.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(err * 2);
        _v.add(_v2).normalize();

        fireBolt(muzzle, _v, e.spec, e.kind === "elite" ? 1 : 1);
        ctx.sound.play("shot-plasma", e.pos, 0.42, e.kind === "elite" ? 0.72 : e.kind === "drone" ? 1.5 : 1.2);
        if (e.burstLeft === 0) {
          e.firstBurst = false;
          e.fireT = e.spec.cycle * (0.75 + Math.random() * 0.6);
        }
        return;
      }

      e.fireT -= dt;
      if (e.fireT > 0) return;
      if (!e.fireToken) {
        e.fireT = 0.3;
        return;
      }
      if (!e.canSee || e.distToPlayer > e.spec.sight * 0.75) {
        e.fireT = 0.35;
        return;
      }
      e.burstLeft = e.spec.burst;
      e.burstT = 0;
      e.strafeDir *= -1;
    }

    /**
     * The barrel tip, in the same rotation the geometry is actually drawn with.
     * Rolling this by hand got the sign of the yaw wrong and every bolt left
     * the shooter's back; reuse the quaternion path `place()` uses instead.
     */
    const MUZZLE: Record<Kind, THREE.Vector3> = {
      grunt: new THREE.Vector3(-0.02, 1.16 - 0.4, -0.82),
      elite: new THREE.Vector3(0.64, 1.33, -0.84),
      drone: new THREE.Vector3(0, 0.05, -0.8),
    };

    function muzzleOf(e: Enemy, out: THREE.Vector3): THREE.Vector3 {
      return out.copy(MUZZLE[e.kind]).multiplyScalar(e.scale).applyAxisAngle(UP, e.aimYaw).add(e.pos);
    }

    function updateAI(e: Enemy, dt: number): void {
      const player = ctx.player;
      const spec = e.spec;

      e.stateT += dt;
      e.damageQuiet += dt;
      e.flinch = Math.max(0, e.flinch - dt * 2.6);
      e.phase += dt;
      if (e.panicUntil > 0) e.panicUntil -= dt;

      // Zealot shields come back if you let them breathe.
      if (e.maxShield > 0 && e.shield < e.maxShield && e.damageQuiet > 5) {
        e.shield = Math.min(e.maxShield, e.shield + 26 * dt);
        if (e.shield >= e.maxShield) e.shieldBroken = false;
      }
      e.shieldFlash = Math.max(0, e.shieldFlash - dt * 3.4);

      // --- perception, staggered so no frame pays for the whole squad ---
      e.senseT -= dt;
      if (e.senseT <= 0) {
        e.senseT = 0.16 + Math.random() * 0.16;
        _v.set(e.pos.x, e.pos.y + (e.kind === "drone" ? 0 : spec.eye), e.pos.z);
        _v2.set(player.position.x, player.position.y + player.eyeHeight * 0.6, player.position.z);
        e.distToPlayer = _v.distanceTo(_v2);
        if (e.distToPlayer > spec.sight || player.dead) {
          e.canSee = false;
        } else {
          _v3.subVectors(_v2, _v).normalize();
          const hit = ctx.raycast(_v, _v3, e.distToPlayer + 1);
          // A hit on a target is an ally in the way, not a wall.
          e.canSee = !hit || hit.surface === "target" || hit.distance >= e.distToPlayer - 1.2;
        }
        if (e.canSee) e.lastSeen.copy(player.position);
      }

      if (!e.aware) {
        if (e.canSee) {
          e.awareT += dt;
          if (e.awareT >= e.reaction) {
            e.aware = true;
            callout(e, "contact");
          }
        } else {
          e.awareT = Math.max(0, e.awareT - dt * 0.4);
        }
      }

      // --- state selection ---
      const prevState = e.state;
      const hurt = (e.health + e.shield) / (e.maxHealth + e.maxShield);
      e.advanceUntil = Math.max(0, e.advanceUntil - dt);
      e.retreatUntil = Math.max(0, e.retreatUntil - dt);

      if (ctx.player.dead) {
        e.state = "patrol";
        e.aware = false;
        e.awareT = 0;
        e.fireToken = false;
      } else if (e.panicUntil > 0) {
        e.state = "retreat";
      } else if (!e.aware) {
        e.state = "patrol";
      } else if (e.distToPlayer > 150) {
        // Leash. A wave that runs off the edge of the map never gets cleared.
        e.state = "advance";
        e.retreatUntil = 0;
      } else if (e.retreatUntil > 0) {
        e.state = "retreat";
      } else if (hurt < 0.34 && e.kind !== "drone" && e.damageQuiet < 1.6) {
        // Break contact just long enough to get a wall between you and the
        // shooter, then come back — not a permanent rout.
        e.retreatUntil = 1.8 + Math.random() * 1.6;
        e.state = "retreat";
      } else if (!e.canSee) {
        e.state = "advance";
        if (e.stateT > 2) e.firstBurst = true;
      } else if (e.distToPlayer > spec.rangeMax * 1.35) {
        // Well outside its own effective range there is nothing to hold, so
        // holding reads as milling about. Close the distance first.
        e.state = "advance";
      } else if (e.distToPlayer > spec.rangeMax) {
        e.state = e.advanceUntil > 0 ? "advance" : "cover";
      } else {
        e.state = e.advanceUntil > 0 || e.distToPlayer < spec.rangeMin ? "strafe" : "cover";
      }

      if (e.state !== prevState) e.stateT = 0;

      // --- movement per state ---
      let speed = spec.speed;
      e.repathT -= dt;

      if (e.kind === "drone") {
        // Flyers have their own steering; none of the walker states apply.
      } else if (e.state === "patrol") {
        if (!e.hasMoveTo || e.repathT <= 0) {
          e.repathT = 3 + Math.random() * 3;
          const a = Math.random() * Math.PI * 2;
          const r = 6 + Math.random() * 14;
          const x = e.pos.x + Math.cos(a) * r;
          const z = e.pos.z + Math.sin(a) * r;
          if (standable(x, z)) {
            e.moveTo.set(x, groundAt(x, z), z);
            e.hasMoveTo = true;
          }
        }
        speed = spec.speed * 0.42;
        if (e.hasMoveTo) steer(e, dt, e.moveTo, speed);
      } else if (e.state === "advance") {
        speed = spec.sprint * (e.canSee ? 0.72 : 1);
        _v.copy(e.canSee ? player.position : e.lastSeen);
        steer(e, dt, _v, speed);
        if (e.distToPlayer < spec.rangeMax * 0.9) e.advanceUntil = 0;
      } else if (e.state === "cover") {
        if (!e.hasMoveTo || e.repathT <= 0) {
          e.repathT = 1.8 + Math.random() * 1.8;
          findCover(e, false);
        }
        speed = spec.speed;
        if (e.hasMoveTo) steer(e, dt, e.moveTo, speed);
        // Lean out of cover for the burst, duck back between them. This goes
        // into velocity so the legs know about it.
        if (e.burstLeft > 0) {
          _v.set(-Math.sin(e.aimYaw + Math.PI / 2), 0, -Math.cos(e.aimYaw + Math.PI / 2));
          e.vel.addScaledVector(_v, e.strafeDir * 1.6);
        }
      } else if (e.state === "strafe") {
        e.strafeT -= dt;
        if (e.strafeT <= 0) {
          e.strafeT = 0.9 + Math.random() * 1.5;
          e.strafeDir *= -1;
        }
        _v.set(player.position.x - e.pos.x, 0, player.position.z - e.pos.z).normalize();
        _v2.set(-_v.z, 0, _v.x).multiplyScalar(e.strafeDir);
        const closing =
          e.distToPlayer < spec.rangeMin
            ? -1.2
            : THREE.MathUtils.clamp((e.distToPlayer - spec.rangeMin) / 20, 0, 1) * 0.7;
        _v2.addScaledVector(_v, closing).normalize();
        _v.copy(e.pos).addScaledVector(_v2, 8);
        speed = spec.speed * 1.15;
        steer(e, dt, _v, speed);
      } else if (e.state === "retreat") {
        if (!e.hasMoveTo || e.repathT <= 0) {
          e.repathT = 1.4 + Math.random() * 1.2;
          findCover(e, true);
        }
        speed = spec.sprint * (e.panicUntil > 0 ? 1 : 0.85);
        if (e.hasMoveTo) steer(e, dt, e.moveTo, speed);
        else {
          _v.set(e.pos.x - player.position.x, 0, e.pos.z - player.position.z).normalize();
          _v.multiplyScalar(14).add(e.pos);
          steer(e, dt, _v, speed);
        }
      }

      // --- integrate ---
      if (e.kind === "drone") {
        updateDrone(e, dt);
      } else {
        e.pos.x += e.vel.x * dt;
        e.pos.z += e.vel.z * dt;
        separate(e, dt);
        pushOutOfProps(e);
        e.groundAge += dt;
        if (e.groundAge > 0.08) {
          e.groundAge = 0;
          e.groundY = groundAt(e.pos.x, e.pos.z);
        }
        // Feet track the slope, but not instantly — a step up should look like
        // a step, not a teleport.
        e.pos.y = THREE.MathUtils.lerp(e.pos.y, e.groundY, 1 - Math.exp(-14 * dt));
      }

      const moved = e.speedSeen;
      e.gait += dt * (2.4 + moved * (e.kind === "grunt" ? 1.5 : 0.95));

      // --- facing: body leads with the feet, aim leads with the eyes ---
      const wantAim = e.aware
        ? Math.atan2(player.position.x - e.pos.x, player.position.z - e.pos.z) + Math.PI
        : e.yaw;
      e.aimYaw = angleLerp(e.aimYaw, wantAim, 1 - Math.exp(-(e.kind === "drone" ? 6 : 4.2) * dt));
      const wantBody = moved > 0.6 ? Math.atan2(-e.vel.x, -e.vel.z) : e.aimYaw;
      e.yaw = angleLerp(e.yaw, e.aware && moved < 2.2 ? e.aimYaw : wantBody, 1 - Math.exp(-6 * dt));

      const dy = player.position.y + player.eyeHeight * 0.55 - (e.pos.y + spec.eye);
      const flat = Math.max(1, Math.hypot(player.position.x - e.pos.x, player.position.z - e.pos.z));
      e.aimPitch = THREE.MathUtils.lerp(e.aimPitch, Math.atan2(dy, flat), 1 - Math.exp(-6 * dt));

      if (e.aware && e.panicUntil <= 0) tryFire(e, dt);
    }

    function updateDrone(e: Enemy, dt: number): void {
      const player = ctx.player;
      const surf = Math.max(groundAt(e.pos.x, e.pos.z), waterAt(e.pos.x, e.pos.z));
      // Orbit rather than approach head-on: a straight-in flyer is a free kill.
      if (e.aware) {
        _v.set(player.position.x - e.pos.x, 0, player.position.z - e.pos.z);
        const d = Math.max(0.5, _v.length());
        _v.multiplyScalar(1 / d);
        _v2.set(-_v.z, 0, _v.x).multiplyScalar(e.strafeDir);
        e.strafeT -= dt;
        if (e.strafeT <= 0) {
          e.strafeT = 1.6 + Math.random() * 2;
          e.strafeDir *= -1;
        }
        const closing = THREE.MathUtils.clamp((d - (e.spec.rangeMin + e.spec.rangeMax) * 0.5) / 18, -1, 1);
        _v2.addScaledVector(_v, closing).normalize();
        const sp = e.spec.speed * (e.distToPlayer > 60 ? 1.5 : 1);
        e.vel.x = THREE.MathUtils.lerp(e.vel.x, _v2.x * sp, 1 - Math.exp(-3.2 * dt));
        e.vel.z = THREE.MathUtils.lerp(e.vel.z, _v2.z * sp, 1 - Math.exp(-3.2 * dt));
      } else {
        e.vel.x = THREE.MathUtils.lerp(e.vel.x, Math.sin(e.phase * 0.3) * 4, dt);
        e.vel.z = THREE.MathUtils.lerp(e.vel.z, Math.cos(e.phase * 0.23) * 4, dt);
      }
      e.pos.x += e.vel.x * dt;
      e.pos.z += e.vel.z * dt;

      const wantY = surf + 6.5 + Math.sin(e.phase * 0.85 + e.slot) * 3.4;
      e.pos.y = THREE.MathUtils.lerp(e.pos.y, Math.max(surf + 3.5, wantY), 1 - Math.exp(-2.2 * dt));
      e.vel.y = 0;
    }

    function angleLerp(a: number, b: number, t: number): number {
      let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
      if (d < -Math.PI) d += Math.PI * 2;
      return a + d * t;
    }

    // ---------------------------------------------------------- death ---
    /**
     * A corpse has to lie there long enough to be looked at. Two seconds was
     * short enough that the beach was pristine again before you had finished
     * the burst that killed it.
     */
    const DEATH_BURN = 3.6;
    const DEATH_LIFE = 5.4;

    function updateDeath(e: Enemy, dt: number): void {
      e.deathT += dt;
      const t = e.deathT;

      if (e.kind === "drone") {
        // Spins out and falls; the ground is where it explodes.
        e.vel.y -= 16 * dt;
        e.pos.x += e.vel.x * dt * 0.6;
        e.pos.z += e.vel.z * dt * 0.6;
        e.pos.y += e.vel.y * dt;
        e.deathSpin += dt * 7;
        const surf = Math.max(groundAt(e.pos.x, e.pos.z), waterAt(e.pos.x, e.pos.z));
        if (!e.fell && e.pos.y <= surf + 0.3) {
          e.fell = true;
          e.pos.y = surf + 0.3;
          _v.copy(e.pos);
          ctx.fx.spawn("explosion", _v, UP, 1.5);
          ctx.sound.play("explosion", _v, 0.7, 1.05);
        }
        if (e.fell) e.pos.y = Math.max(e.pos.y, surf + 0.3);
      } else {
        // Stagger along the shot, then topple, then burn out.
        const shove = Math.max(0, 1 - t / 0.34) * 3.2;
        e.pos.x += e.deathDir.x * shove * dt;
        e.pos.z += e.deathDir.z * shove * dt;
        e.groundY = groundAt(e.pos.x, e.pos.z);
        e.pos.y = THREE.MathUtils.lerp(e.pos.y, e.groundY, 1 - Math.exp(-12 * dt));
        const fall = THREE.MathUtils.smoothstep(t, 0.16, 0.82);
        e.deathTilt = fall * 1.5;
        if (!e.fell && fall > 0.94) {
          e.fell = true;
          _v.copy(e.pos).setY(e.pos.y + 0.2);
          ctx.fx.spawn("impact-dirt", _v, UP, 1.3);
          ctx.sound.play("impact-dirt", _v, 0.6, 0.7);
        }
      }

      if (t > 1.0 && t < 4.6 && Math.random() < dt * 2) {
        _v.copy(e.pos).setY(e.pos.y + 0.5 + Math.random());
        ctx.fx.spawn("smoke", _v, UP, 0.8);
      }
      if (e.deathT > DEATH_LIFE) release(e);
    }

    function release(e: Enemy): void {
      e.active = false;
      e.target.alive = false;
      hideParts(e);
    }

    function hideParts(e: Enemy): void {
      contactPool.hide(e.slot2);
      contactAttr.setXYZ(e.slot2, 0, 0, 0);
      contactAttr.needsUpdate = true;
      if (e.kind === "grunt") {
        pools.gruntBody.hide(e.slot);
        pools.gruntArm.hide(e.slot);
        pools.gruntGlow.hide(e.slot);
        pools.gruntLeg.hide(e.slot * 2);
        pools.gruntLeg.hide(e.slot * 2 + 1);
      } else if (e.kind === "elite") {
        pools.eliteBody.hide(e.slot);
        pools.eliteArm.hide(e.slot);
        pools.eliteGlow.hide(e.slot);
        pools.eliteShield.hide(e.slot);
        pools.eliteThigh.hide(e.slot * 2);
        pools.eliteThigh.hide(e.slot * 2 + 1);
        pools.eliteShin.hide(e.slot * 2);
        pools.eliteShin.hide(e.slot * 2 + 1);
      } else {
        pools.droneHull.hide(e.slot);
        pools.droneRing.hide(e.slot);
        pools.droneGlow.hide(e.slot);
      }
    }

    // ----------------------------------------------------------- pose ---
    const root = new THREE.Matrix4();
    const part = new THREE.Matrix4();

    function place(
      pool: PartPool,
      slot: number,
      lx: number,
      ly: number,
      lz: number,
      rx: number,
      ry: number,
      rz: number,
      s = 1,
    ): void {
      _e.set(rx, ry, rz, "YXZ");
      _q.setFromEuler(_e);
      _v.set(lx, ly, lz);
      _scale.set(s, s, s);
      part.compose(_v, _q, _scale);
      part.premultiply(root);
      pool.set(slot, part);
    }

    function poseEnemy(e: Enemy): void {
      const dying = e.state === "dead";
      const burn = dying
        ? THREE.MathUtils.clamp((e.deathT - DEATH_BURN) / 1.35, 0, 1.12) * e.spec.burnHeight
        : 0;
      // Shrink at the very end so the shadow leaves with the body.
      const shrink = dying ? 1 - THREE.MathUtils.smoothstep(e.deathT, DEATH_LIFE - 0.3, DEATH_LIFE) : 1;
      const s = e.scale * shrink;
      if (s <= 0.02) {
        hideParts(e);
        return;
      }

      _q.setFromAxisAngle(UP, e.yaw);
      let lift = 0;
      if (dying && e.kind !== "drone") {
        // Topple about the axis across the shot direction. Rotating about the
        // feet alone drives the mass into the ground, so raise the root by the
        // body radius as it goes over and it comes to rest on its side.
        _v2.set(e.deathDir.z, 0, -e.deathDir.x).normalize();
        _q2.setFromAxisAngle(_v2, e.deathTilt);
        _q.premultiply(_q2);
        lift = Math.sin(e.deathTilt) * e.spec.radius * 0.72;
      } else if (dying) {
        _q2.setFromEuler(_e.set(e.deathSpin * 0.7, e.deathSpin, e.deathSpin * 1.3, "YXZ"));
        _q.premultiply(_q2);
      }
      _v.copy(e.pos).setY(e.pos.y + lift);
      _scale.set(s, s, s);
      root.compose(_v, _q, _scale);

      const bodyBase = e.pos.y - 0.15;
      const stride = THREE.MathUtils.clamp(e.speedSeen / e.spec.speed, 0, 1.4);
      const flinch = e.flinch * 0.22;
      // A soldier standing still is not a soldier standing to attention. At
      // zero stride the walk cycle collapses to two parallel legs and a rigid
      // torso, which reads as a mannequin, so blend in a planted stance and a
      // slow breath that never fully switch off.
      const rest = 1 - Math.min(1, stride * 1.6);
      const plant = (0.2 + 0.16 * Math.sin(e.phase * 1.7)) * rest;
      const breathe = Math.sin(e.gait * 0.55 + e.phase) * 0.018 * rest;

      if (e.kind === "grunt") {
        // Waddle: the whole body rolls side to side, which is the tell that
        // separates a grunt from a zealot before you can see either clearly.
        const roll = Math.sin(e.gait * 2) * 0.13 * stride + breathe * 0.6;
        const bob = Math.abs(Math.sin(e.gait * 2)) * 0.06 * stride + breathe;
        place(pools.gruntBody, e.slot, 0, bob, 0, 0.06 + flinch, 0, roll);
        place(pools.gruntGlow, e.slot, 0, bob, 0, 0.06 + flinch, 0, roll);
        for (let i = 0; i < 2; i++) {
          const swing = Math.sin(e.gait * 2 + i * Math.PI) * 0.62 * stride + (i ? plant : -plant);
          place(pools.gruntLeg, e.slot * 2 + i, (i ? 1 : -1) * 0.19, 0.64, 0, swing, 0, (i ? 1 : -1) * 0.09);
        }
        // Arms pivot at the chest, on the centreline. The old off-centre pivot
        // at body height is what made the weapon read as a snout.
        const armPitch = e.aware ? -e.aimPitch * 0.8 : 0.34;
        place(
          pools.gruntArm,
          e.slot,
          0,
          1.16 + bob,
          0,
          armPitch + (e.burstLeft > 0 ? Math.random() * 0.07 : 0),
          angleLerp(0, e.aimYaw - e.yaw, 1),
          0,
        );
        pools.gruntBody.setBurn(e.slot, burn, bodyBase);
        pools.gruntArm.setBurn(e.slot, burn, bodyBase);
        pools.gruntLeg.setBurn(e.slot * 2, burn, bodyBase);
        pools.gruntLeg.setBurn(e.slot * 2 + 1, burn, bodyBase);
      } else if (e.kind === "elite") {
        const sway = Math.sin(e.gait * 1.7) * 0.05 * stride + breathe * 0.5;
        const bob = Math.abs(Math.sin(e.gait * 1.7)) * 0.09 * stride + breathe;
        place(pools.eliteBody, e.slot, 0, bob, 0, 0.1 + flinch, 0, sway);
        place(pools.eliteGlow, e.slot, 0, bob, 0, 0.1 + flinch, 0, sway);
        for (let i = 0; i < 2; i++) {
          const ph = e.gait * 1.7 + i * Math.PI;
          const swing = Math.sin(ph) * 0.7 * stride + (i ? plant : -plant) * 0.8;
          const hipY = 1.16;
          place(pools.eliteThigh, e.slot * 2 + i, (i ? 1 : -1) * 0.26, hipY, 0.05, -0.42 + swing, 0, 0);
          // Knee position follows the thigh so the shin stays attached.
          const kneeY = hipY - Math.cos(-0.42 + swing) * 0.62;
          const kneeZ = 0.05 + Math.sin(-0.42 + swing) * 0.62;
          place(
            pools.eliteShin,
            e.slot * 2 + i,
            (i ? 1 : -1) * 0.26,
            kneeY,
            kneeZ,
            0.62 - swing * 0.55,
            0,
            0,
          );
        }
        const armPitch = e.aware ? -e.aimPitch - 0.1 : 0.45;
        place(
          pools.eliteArm,
          e.slot,
          0.66,
          1.78 + bob,
          -0.1,
          armPitch + (e.burstLeft > 0 ? Math.random() * 0.06 : 0),
          angleLerp(0, e.aimYaw - e.yaw, 1),
          0,
        );
        pools.eliteBody.setBurn(e.slot, burn, bodyBase);
        pools.eliteArm.setBurn(e.slot, burn, bodyBase);
        pools.eliteThigh.setBurn(e.slot * 2, burn, bodyBase);
        pools.eliteThigh.setBurn(e.slot * 2 + 1, burn, bodyBase);
        pools.eliteShin.setBurn(e.slot * 2, burn, bodyBase);
        pools.eliteShin.setBurn(e.slot * 2 + 1, burn, bodyBase);

        const shieldStrength = dying
          ? 0
          : e.maxShield > 0
            ? (e.shield / e.maxShield) * 0.55 + e.shieldFlash * 1.6
            : 0;
        shieldAttr.setXY(e.slot, shieldStrength, e.pos.y);
        if (shieldStrength > 0.004) {
          // Tangent to the ground: centred one vertical half-extent up, so the
          // terrain never slices the bubble with a straight horizontal chord.
          _v.copy(e.pos).setY(e.pos.y + 1.42 * s);
          _q.setFromAxisAngle(UP, 0);
          _scale.set(1.15 * s, 1.42 * s, 1.15 * s);
          part.compose(_v, _q, _scale);
          pools.eliteShield.set(e.slot, part);
        } else {
          pools.eliteShield.hide(e.slot);
        }
      } else {
        const bank = THREE.MathUtils.clamp(-e.vel.x * Math.cos(e.yaw) + e.vel.z * Math.sin(e.yaw), -8, 8) * 0.05;
        const hover = Math.sin(e.phase * 3.1 + e.slot) * 0.07;
        place(pools.droneHull, e.slot, 0, hover, 0, dying ? 0 : -0.12, 0, bank);
        place(pools.droneGlow, e.slot, 0, hover, 0, dying ? 0 : -0.12, 0, bank);
        place(pools.droneRing, e.slot, 0, hover, 0, dying ? 0 : -0.12, e.phase * 7, bank);
        pools.droneHull.setBurn(e.slot, burn, e.pos.y - 0.4);
        pools.droneRing.setBurn(e.slot, burn, e.pos.y - 0.4);
      }

      // Glow strips are unlit basic material, so they fade by shrinking rather
      // than by the armour's dissolve.
      if (burn > 0.35) {
        const glowPool =
          e.kind === "grunt" ? pools.gruntGlow : e.kind === "elite" ? pools.eliteGlow : pools.droneGlow;
        glowPool.hide(e.slot);
      }

      e.target.position.set(e.pos.x, e.pos.y + e.spec.centreY * s, e.pos.z);
      e.target.radius = e.spec.radius * s;

      // Contact shadow. Fades as the corpse burns so the mark leaves with it.
      if (e.kind === "drone") {
        contactAttr.setXYZ(e.slot2, 0, 0, 0);
      } else {
        const gy = groundAt(e.pos.x, e.pos.z);
        const lift = THREE.MathUtils.clamp(1 - (e.pos.y - gy) * 0.7, 0, 1);
        const strength = lift * (dying ? Math.max(0, 1 - e.deathT / 4.2) : 1) * 0.95;
        contactAttr.setXYZ(e.slot2, 0, e.slot2 * 2.4, strength);
        _v.set(e.pos.x, gy + 0.03, e.pos.z);
        _q.setFromAxisAngle(UP, e.yaw);
        const w = e.spec.radius * 2.9 * s;
        _scale.set(w, 1, w);
        part.compose(_v, _q, _scale);
        contactPool.set(e.slot2, part);
      }
    }

    // ---------------------------------------------------------- frame ---
    const offRespawn = bus.on("player:respawn", () => {
      for (const e of enemies) if (e.active) release(e);
      for (const b of bolts) b.active = false;
      wave = Math.max(0, wave - 1);
      waveActive = false;
      waveQueue = [];
      waveTimer = 5;
      combo = 0;
      bus.emit("score:changed", { score, combo });
    });

    // Deploying into an empty park is the whole problem this module exists to
    // fix, so the first landing party is already on the ground at spawn.
    rebuildCoverGrid();
    startWave();

    let elapsedTotal = 0;

    return {
      update(dt: number) {
        const step = Math.min(dt, 0.05);
        elapsedTotal += step;
        matShield.uniforms.uTime.value = elapsedTotal;

        if (pendingAnnounce) {
          pendingAnnounce();
          pendingAnnounce = null;
        }
        calloutCooldown = Math.max(0, calloutCooldown - step);
        comboT -= step;
        if (comboT <= 0 && combo > 0) {
          combo = 0;
          bus.emit("score:changed", { score, combo });
        }

        squadTimer -= step;
        if (squadTimer <= 0) {
          squadTimer = 1.3;
          directSquad();
        }

        // Prop modules build after this one, and some spawn scenery over time.
        coverAge += step;
        if (coverAge > 4) {
          coverAge = 0;
          rebuildCoverGrid();
        }

        updateWaves(step);

        for (const e of enemies) {
          if (!e.active) continue;
          const px = e.pos.x;
          const pz = e.pos.z;
          if (e.state === "dead") {
            updateDeath(e, step);
          } else {
            updateAI(e, step);
          }
          e.speedSeen = THREE.MathUtils.lerp(
            e.speedSeen,
            Math.hypot(e.pos.x - px, e.pos.z - pz) / step,
            0.4,
          );
          if (e.active) poseEnemy(e);
        }

        updateBolts(step);

        // Scorches outlive their owners, then fade so the beach does not become
        // a solid mat of black by wave five.
        let scorchDirty = false;
        for (let i = 0; i < scorchCount; i++) {
          if (scorchLife[i] <= 0) continue;
          scorchLife[i] -= step;
          scorchAttr.setZ(i, THREE.MathUtils.clamp(scorchLife[i] / 5, 0, 1));
          if (scorchLife[i] <= 0) scorchPool.hide(i);
          scorchDirty = true;
        }
        if (scorchDirty) scorchAttr.needsUpdate = true;

        shieldAttr.needsUpdate = true;
        contactAttr.needsUpdate = true;
        for (const p of allPools) p.flush();
      },

      dispose() {
        offRespawn();
        unregisters.forEach((u) => u());
        for (const p of allPools) p.dispose(scene);
        boltPools.core.dispose(scene);
        boltPools.halo.dispose(scene);
        disposables.forEach((d) => d.dispose());
      },
    };
  },
};

export default mod;
