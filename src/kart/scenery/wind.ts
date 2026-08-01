/**
 * Vibe Kart — scenery vertex animation.
 *
 * Every moving thing at trackside — four thousand spectators, a forest, a
 * grass layer, the flags, the air dancers — moves entirely on the GPU. Nothing
 * in this directory writes an instance matrix per frame except a handful of
 * hero props (the Ferris wheel's gondolas, the balloons), because at these
 * counts the matrix upload alone would cost more than the whole render.
 *
 * The trick that makes it work is that **no animation needs a per-instance
 * attribute**. Phase, shirt colour, which sponsor is on which hoarding — all of
 * it is hashed out of `instanceMatrix[3].xyz` in the vertex shader. Instance
 * attributes live on the *geometry*, so needing one would have forced a
 * geometry clone per culling sector; hashing the origin keeps a single shared
 * geometry behind a dozen sectorised `InstancedMesh`es.
 *
 * Wind arrives in world space and is rotated into instance space by dotting it
 * against the instance basis. That matters: the alternative — swaying along a
 * fixed local axis — makes a wood of randomly-yawed trees look like it is being
 * blown by fifty separate breezes.
 */
import * as THREE from "three";

export interface SceneryUniforms {
  uTime: { value: number };
  /** Horizontal wind direction (unit) in world XZ. */
  uWind: { value: THREE.Vector2 };
  /** Gust strength, ~0.6..1.6, breathing over ~20 s. */
  uGust: { value: number };
  /** Crowd excitement 0..1 — bob amplitude, jump chance, wave strength. */
  uExcite: { value: number };
  /** Circuit centroid; the Mexican wave sweeps around it. */
  uCentre: { value: THREE.Vector3 };
  /** Curated shirt palette, indexed by an instance hash. */
  uShirts: { value: THREE.Color[] };
  uSkins: { value: THREE.Color[] };
}

/**
 * Ten hues, chosen the way a stadium looks on television rather than the way a
 * random number generator looks: mostly warm mid-values, two near-whites to
 * carry highlights, one deep navy so the mass has a floor. Random RGB gives a
 * grey mush at distance, which is exactly the failure this palette avoids.
 */
const SHIRT_HEX = [
  0xe8402a, 0xf2f2ef, 0x2b6ad1, 0xffcc22, 0x2c8c3f,
  0xff8c1a, 0xf0f0f0, 0x8a2be2, 0x18305f, 0xff4fa3,
];

const SKIN_HEX = [0xf2c9a0, 0xd79b6e, 0xa3673f, 0x6d4326];

export function createSceneryUniforms(): SceneryUniforms {
  const mk = (list: number[]) => list.map((h) => new THREE.Color().setHex(h, THREE.SRGBColorSpace));
  return {
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector2(0.82, 0.57) },
    uGust: { value: 1 },
    uExcite: { value: 0.35 },
    uCentre: { value: new THREE.Vector3() },
    uShirts: { value: mk(SHIRT_HEX) },
    uSkins: { value: mk(SKIN_HEX) },
  };
}

/**
 * Shared GLSL prelude. `kartOrigin` falls back to the model matrix so a patched
 * material still behaves if someone draws it as a plain mesh — which the hero
 * props (the gantry flags, the pit-lane dancers) actually do.
 */
const PRELUDE = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;
uniform float uGust;

float kartHash( vec3 p ) {
  return fract( sin( dot( p, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 );
}

vec3 kartInstanceOrigin() {
  #ifdef USE_INSTANCING
    return instanceMatrix[ 3 ].xyz;
  #else
    return modelMatrix[ 3 ].xyz;
  #endif
}

/**
 * World direction into instance space. The instance basis is orthogonal (every
 * placement helper in this directory is yaw + scale only), so dotting against
 * the columns and renormalising is the exact inverse rotation — no matrix
 * inverse, no extra uniform.
 */
vec3 kartDirToLocal( vec3 w ) {
  #ifdef USE_INSTANCING
    vec3 d = vec3(
      dot( w, instanceMatrix[ 0 ].xyz ),
      dot( w, instanceMatrix[ 1 ].xyz ),
      dot( w, instanceMatrix[ 2 ].xyz )
    );
    return normalize( d + vec3( 1e-6 ) );
  #else
    return normalize( w + vec3( 1e-6 ) );
  #endif
}
`;

/**
 * Bend a standing thing about its base.
 *
 * `height` is the local height the sway is normalised against, `amp` the tip
 * excursion in local metres. The arc-length compensation on the last line is
 * what stops a bending tree visibly growing taller as it leans — cheap, and the
 * first thing you notice without it.
 */
function bendGlsl(height: number, amp: number, flutter: number): string {
  return /* glsl */ `
  vec3 kOrigin = kartInstanceOrigin();
  float kPhase = kOrigin.x * 0.137 + kOrigin.z * 0.091 + kartHash( kOrigin ) * 6.283;
  float kT = uTime * ( 0.55 + uGust * 0.16 );
  // Two decorrelated sines plus a slow surge: a single sine reads as a metronome.
  float kWave = sin( kT * 0.9 + kPhase ) * 0.62
              + sin( kT * 1.63 + kPhase * 1.7 ) * 0.27
              + sin( kT * 0.31 + kPhase * 0.4 ) * 0.11;
  float kW = clamp( transformed.y / ${height.toFixed(3)}, 0.0, 1.4 );
  kW *= kW;
  vec3 kDir = kartDirToLocal( vec3( uWind.x, 0.0, uWind.y ) );
  float kAmp = ${amp.toFixed(4)} * uGust * kW;
  vec3 kOff = kDir * kWave * kAmp;
  ${
    flutter > 0
      ? `
  // Leaf flutter: high frequency, tiny, decorrelated per vertex so the canopy
  // shimmers instead of translating as one board.
  kOff.x += sin( kT * 4.3 + transformed.y * 3.4 + kPhase ) * kAmp * ${flutter.toFixed(3)};
  kOff.z += cos( kT * 3.9 + transformed.x * 3.1 + kPhase ) * kAmp * ${flutter.toFixed(3)};`
      : ""
  }
  transformed += kOff;
  // Keep the arc honest: a pure shear stretches the trunk as it leans.
  transformed.y -= dot( kOff.xz, kOff.xz ) / ( 2.0 * ${height.toFixed(3)} );
  `;
}

/** Cheer, bob and the Mexican wave. See `stands.ts` for the geometry contract. */
const CROWD_GLSL = /* glsl */ `
  vec3 kOrigin = kartInstanceOrigin();
  float kRnd = kartHash( kOrigin );
  float kRnd2 = kartHash( kOrigin.zxy + 3.17 );
  float kPhase = kRnd * 6.283;

  // The wave sweeps as a function of angle about the circuit centroid, so it
  // runs round the stands the way a real one does rather than along an axis.
  vec2 kRel = kOrigin.xz - uCentre.xz;
  float kAng = atan( kRel.y, kRel.x );
  float kWaveRaw = sin( uTime * 0.85 - kAng * 2.0 );
  float kWave = smoothstep( 0.55, 0.97, kWaveRaw ) * uExcite;

  // Idle bob never switches off. A stand of perfectly still figures is the one
  // thing that instantly reads as "these are instanced boxes".
  float kRate = 2.1 + kRnd * 2.4;
  float kBob = sin( uTime * kRate + kPhase ) * ( 0.012 + uExcite * 0.02 );
  // Jumping: a sharp-peaked sine so most of the time they are on the ground.
  float kJump = pow( max( 0.0, sin( uTime * ( 1.6 + kRnd2 ) + kPhase ) ), 8.0 )
              * ( 0.05 + uExcite * 0.30 ) * step( 0.35, kRnd2 + uExcite * 0.5 );

  float kUp = clamp( transformed.y * 0.9, 0.0, 1.0 );

  // Arms. aArm.xyz is the shoulder pivot, aArm.w flags an arm vertex; the sign
  // of the pivot's x picks which way the arm swings out.
  if ( aArm.w > 0.5 ) {
    float kSide = aArm.x >= 0.0 ? 1.0 : -1.0;
    float kIdle = 0.16 + sin( uTime * ( kRate * 0.7 ) + kPhase ) * 0.11;
    float kAngle = mix( kIdle, 2.55 + kRnd2 * 0.25, kWave ) * kSide;
    vec3 kRelP = transformed - aArm.xyz;
    float kS = sin( kAngle ), kC = cos( kAngle );
    transformed = aArm.xyz + vec3(
      kRelP.x * kC - kRelP.y * kS,
      kRelP.x * kS + kRelP.y * kC,
      kRelP.z
    );
  }

  // Upper-body lean, so the crowd is not a field of vertical pins.
  float kLean = sin( uTime * kRate * 0.53 + kPhase * 1.9 ) * 0.035 * kUp;
  transformed.x += kLean;
  transformed.z += cos( uTime * kRate * 0.41 + kPhase ) * 0.028 * kUp;
  transformed.y += kBob * kUp + kJump;
`;

/** Cloth pinned along its x = 0 edge; local geometry spans x ∈ [0,1]. */
const FLAG_GLSL = /* glsl */ `
  vec3 kOrigin = kartInstanceOrigin();
  float kPhase = kartHash( kOrigin ) * 6.283;
  float kT = uTime * ( 4.2 + uGust * 1.6 );
  float kX = clamp( transformed.x, 0.0, 1.0 );
  // Pinned at the pole, free at the fly: the weight has to be zero at x = 0 or
  // the flag detaches, and superlinear or the whole sheet waggles rigidly.
  float kW = kX * kX;
  float kRip = sin( kX * 9.0 - kT + kPhase ) * 0.5
             + sin( kX * 15.0 - kT * 1.37 + kPhase * 2.1 ) * 0.22;
  transformed.z += kRip * 0.30 * kW * uGust;
  transformed.y += sin( kX * 6.0 - kT * 0.9 + kPhase * 1.4 ) * 0.13 * kW;
  // Cloth cannot stretch: pull the fly edge back by the arc it just travelled.
  transformed.x -= kRip * kRip * 0.06 * kW;
`;

/**
 * Wing flap for the bird flock.
 *
 * The flap phase comes out of `instanceColor.r` rather than the usual instance
 * hash, because the birds are the one instanced thing in the game whose origin
 * *moves*: hashing a position that changes every frame gives a new phase every
 * frame, and the flock reads as static noise. Packing the phase into a colour
 * channel costs a barely-visible warm/cool variation on a dark silhouette.
 */
const BIRD_GLSL = /* glsl */ `
  #ifdef USE_INSTANCING_COLOR
    float kPh = ( instanceColor.r - 0.8 ) * 31.4;
  #else
    float kPh = 0.0;
  #endif
  if ( aArm.w > 0.5 ) {
    float kSide = aArm.x >= 0.0 ? 1.0 : -1.0;
    // Fast down-stroke, slower recovery: a symmetric sine flaps like a toy.
    float kF = sin( uTime * 7.2 + kPh );
    float kAngle = ( 0.62 * kF - 0.08 ) * kSide;
    vec3 kRelP = transformed - aArm.xyz;
    float kS = sin( kAngle ), kC = cos( kAngle );
    transformed = aArm.xyz + vec3(
      kRelP.x * kC - kRelP.y * kS,
      kRelP.x * kS + kRelP.y * kC,
      kRelP.z
    );
  }
`;

/** Inflatable tube man: a whip travelling up the tube, plus the occasional flop. */
const DANCER_GLSL = /* glsl */ `
  vec3 kOrigin = kartInstanceOrigin();
  float kPhase = kartHash( kOrigin ) * 6.283;
  float kT = uTime * 2.6 + kPhase;
  float kY = clamp( transformed.y, 0.0, 1.0 );
  float kW = kY * kY;
  // The fan pulses; when it eases the tube folds over and snaps back up. That
  // irregularity is the entire character of the prop.
  float kPulse = 0.55 + 0.45 * smoothstep( -0.2, 0.6, sin( kT * 0.37 ) );
  float kWhip = sin( kT - kY * 5.4 );
  float kWhip2 = cos( kT * 0.83 - kY * 3.6 + 1.3 );
  transformed.x += kWhip * 0.62 * kW * kPulse;
  transformed.z += kWhip2 * 0.46 * kW * kPulse;
  transformed.y -= ( 1.0 - kPulse ) * 0.22 * kW;
`;

/**
 * Pick an atlas cell from the instance hash and remap the UV into it.
 *
 * Sixteen sponsors on sixteen hoardings for one draw call. The inset is not
 * optional: without it the mip chain drags a neighbouring advert's colour
 * across the edge of this one at any distance.
 */
function atlasGlsl(grid: number): string {
  const g = grid.toFixed(1);
  // The braces are load-bearing: this snippet and the motion snippet both land
  // inside main(), and both want an instance origin. Scoping keeps them from
  // redefining each other's locals.
  return /* glsl */ `
  #ifdef USE_MAP
  {
    vec3 aOrigin = kartInstanceOrigin();
    float aCell = floor( kartHash( aOrigin + 1.7 ) * ${(grid * grid).toFixed(1)} );
    vec2 aCxy = vec2( mod( aCell, ${g} ), floor( aCell / ${g} ) );
    vMapUv = ( clamp( vMapUv, 0.02, 0.98 ) + aCxy ) / ${g};
  }
  #endif
  `;
}

export type SceneryShader =
  | { kind: "tree"; height: number; amp: number; flutter?: number }
  | { kind: "crowd" }
  | { kind: "flag" }
  | { kind: "dancer" }
  | { kind: "bird" }
  | { kind: "still" };

export interface PatchOptions {
  /** Side of a square texture atlas; the cell is picked per instance. */
  atlas?: number;
}

function vertexBody(spec: SceneryShader): string {
  switch (spec.kind) {
    case "tree":
      return bendGlsl(spec.height, spec.amp, spec.flutter ?? 0);
    case "crowd":
      return CROWD_GLSL;
    case "flag":
      return FLAG_GLSL;
    case "dancer":
      return DANCER_GLSL;
    case "bird":
      return BIRD_GLSL;
    default:
      return "";
  }
}

/**
 * Install a scenery shader on a material.
 *
 * `key` must be unique per (shader, parameters) pair: three caches compiled
 * programs by material signature, and two materials that differ only in an
 * `onBeforeCompile` body will silently share one program without it.
 */
export function patchScenery(
  material: THREE.Material,
  key: string,
  spec: SceneryShader,
  u: SceneryUniforms,
  opts: PatchOptions = {},
): void {
  const body = vertexBody(spec);
  const crowd = spec.kind === "crowd";
  const hinged = crowd || spec.kind === "bird";
  // Atlas selection and motion compose: the remap lands in <uv_vertex> and the
  // displacement in <begin_vertex>, so a rippling flag can also pick its own
  // design out of a sheet of four.
  const atlas = opts.atlas ? atlasGlsl(opts.atlas) : "";

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = u.uTime;
    shader.uniforms.uWind = u.uWind;
    shader.uniforms.uGust = u.uGust;
    if (crowd) {
      shader.uniforms.uExcite = u.uExcite;
      shader.uniforms.uCentre = u.uCentre;
      shader.uniforms.uShirts = u.uShirts;
      shader.uniforms.uSkins = u.uSkins;
    }

    const decls =
      PRELUDE +
      (hinged ? "attribute vec4 aArm;\nattribute vec2 aTint;\n" : "") +
      (crowd
        ? /* glsl */ `
uniform float uExcite;
uniform vec3 uCentre;
uniform vec3 uShirts[ 10 ];
uniform vec3 uSkins[ 4 ];
`
        : "");

    shader.vertexShader = shader.vertexShader.replace("#include <common>", `#include <common>\n${decls}`);

    if (body) {
      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\n${body}`,
      );
    }
    if (atlas) {
      shader.vertexShader = shader.vertexShader.replace("#include <uv_vertex>", `#include <uv_vertex>\n${atlas}`);
    }
    if (crowd) {
      // Shirt and skin are chosen here rather than through `instanceColor`
      // because one instance needs *two* colours — a tinted shirt over a fixed
      // complexion — and `instanceColor` would tint the face too.
      shader.vertexShader = shader.vertexShader.replace(
        "#include <color_vertex>",
        /* glsl */ `
        #include <color_vertex>
        #if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
        {
          vec3 cOrigin = kartInstanceOrigin();
          int shirtIdx = int( floor( kartHash( cOrigin + 5.3 ) * 9.999 ) );
          int skinIdx = int( floor( kartHash( cOrigin.yzx + 11.9 ) * 3.999 ) );
          // aTint.x selects the shirt hue, aTint.y the complexion; both zero
          // leaves the baked vertex colour alone, which is how trousers and
          // hair keep their own paint.
          vec3 tint = mix( vec3( 1.0 ), uShirts[ shirtIdx ], aTint.x );
          tint = mix( tint, uSkins[ skinIdx ], aTint.y );
          vColor *= tint;
        }
        #endif
        `,
      );
    }
  };
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
}

/**
 * A depth twin for an animated, alpha-cut material.
 *
 * Shadow passes render with three's own depth material, which knows nothing
 * about our vertex displacement — so a swaying tree casts a rigid shadow and
 * the illusion dies at the trunk. This builds a `MeshDepthMaterial` carrying the
 * same patch and the same alpha cut-out, to be assigned as
 * `mesh.customDepthMaterial`.
 */
export function depthTwin(
  key: string,
  spec: SceneryShader,
  u: SceneryUniforms,
  map: THREE.Texture | null,
  alphaTest: number,
): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    map,
    alphaTest,
    side: THREE.DoubleSide,
  });
  patchScenery(mat, `${key}-depth`, spec, u);
  return mat;
}
