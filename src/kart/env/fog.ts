/**
 * Height fog, installed globally by patching three's fog chunks.
 *
 * `THREE.FogExp2` is uniform in height: it swallows a hilltop at 900 m exactly
 * as hard as it swallows the tarmac at 900 m. Real aerial perspective does not
 * do that — the air thins with altitude, so a distant ridge line stays legible
 * against the haze while the valley floor below it dissolves. That single
 * difference is most of what separates "distant scenery" from "grey soup", and
 * it is the cheapest AAA cue in the box.
 *
 * ## Why a global chunk patch, and why it is safe
 * There is no per-material hook that reaches every mesh in a scene authored by
 * five other systems, so the fog chunks themselves are rewritten. Two rules
 * keep that from being reckless:
 *
 * 1. **The new varying is computed from data the stock chunk already relies
 *    on.** `fog_vertex` is only ever included where `mvPosition` exists, and
 *    `viewMatrix`/`cameraPosition` are in three's own vertex prefix for every
 *    non-raw shader. World Y is recovered from those three, so any shader that
 *    compiles today still compiles after the patch — including custom
 *    `ShaderMaterial`s written by other systems.
 * 2. **The tuning constants are baked in as GLSL literals**, not new uniforms.
 *    Adding uniforms would mean reaching into `ShaderLib` for every material
 *    type; literals need nothing, and the falloff profile is an art constant
 *    that has no business changing at runtime anyway. Density and colour stay
 *    on the real `fogDensity`/`fogColor` uniforms, so time of day still drives
 *    them normally.
 *
 * The patch is idempotent and fully reversible — `restoreFogChunks()` puts the
 * originals back, so a hot-reloaded or disposed world leaves no trace.
 */
import * as THREE from "three";

/** Marker so a second boot (or a second world) cannot double-patch. */
const MARKER = "// kart-height-fog";

/**
 * Metres of altitude per halving of fog density. 90 m keeps kerbside haze
 * strong, lets a 200 m hillside keep its silhouette, and leaves anything
 * genuinely tall standing clear of the murk.
 */
const HALF_HEIGHT = 90;
/** World Y the fog is thickest at — the altitude the track itself lives on. */
const FOG_BASE = 0;

const ORIGINALS: Record<string, string> = {};
let patched = false;

const PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG

	varying float vFogDepth;
	varying float vFogWorldY;

#endif
`;

const VERTEX = /* glsl */ `
#ifdef USE_FOG

	vFogDepth = - mvPosition.z;

	// World Y without a second matrix multiply. viewMatrix is rigid, so its
	// inverse rotation row is just column 1, and cameraPosition already carries
	// the translation. Works for skinned, morphed and instanced geometry alike
	// because it starts from mvPosition rather than from the local vertex.
	vFogWorldY = dot( viewMatrix[ 1 ].xyz, mvPosition.xyz ) + cameraPosition.y;

#endif
`;

const PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG

	uniform vec3 fogColor;
	varying float vFogDepth;
	varying float vFogWorldY;

	#ifdef FOG_EXP2

		uniform float fogDensity;

	#else

		uniform float fogNear;
		uniform float fogFar;

	#endif

#endif
`;

const FRAGMENT = /* glsl */ `
#ifdef USE_FOG

	#ifdef FOG_EXP2

		// Density falls off exponentially with altitude. Integrating that
		// properly along the view ray costs a transcendental and a division;
		// averaging the endpoint densities is within a couple of percent over
		// the height range a kart track occupies, monotonic, and free.
		float fogHeightFrag = exp2( -( max( vFogWorldY - ${FOG_BASE.toFixed(1)}, 0.0 ) ) / ${HALF_HEIGHT.toFixed(1)} );
		float fogHeightCam  = exp2( -( max( cameraPosition.y - ${FOG_BASE.toFixed(1)}, 0.0 ) ) / ${HALF_HEIGHT.toFixed(1)} );
		float fogHeight = ( fogHeightFrag + fogHeightCam ) * 0.5;

		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth * fogHeight );

	#else

		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );

	#endif

	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );

#endif
`;

/**
 * Install the height-fog chunks. Call before the first frame; materials
 * created earlier are unaffected because chunk resolution happens at program
 * compile time, not at material construction.
 */
export function patchFogChunks(): boolean {
  if (patched) return true;
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  // Somebody else already owns these chunks — leave them alone rather than
  // fight over a global.
  if (chunks.fog_fragment.includes(MARKER)) return false;

  for (const key of ["fog_pars_vertex", "fog_vertex", "fog_pars_fragment", "fog_fragment"]) {
    ORIGINALS[key] = chunks[key];
  }
  chunks.fog_pars_vertex = `${MARKER}${PARS_VERTEX}`;
  chunks.fog_vertex = `${MARKER}${VERTEX}`;
  chunks.fog_pars_fragment = `${MARKER}${PARS_FRAGMENT}`;
  chunks.fog_fragment = `${MARKER}${FRAGMENT}`;
  patched = true;
  return true;
}

/** Put three's own chunks back. */
export function restoreFogChunks(): void {
  if (!patched) return;
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  for (const key of Object.keys(ORIGINALS)) chunks[key] = ORIGINALS[key];
  patched = false;
}
