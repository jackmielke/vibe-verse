/**
 * triplanar — world-space projection and distance-blended detail for
 * San Francisco: FREE FALL.
 *
 * Two problems this file exists to solve, both called out in the art bible:
 *
 * 1. **UV stretching on a city built on hills.** The terrain clipmap has no
 *    meaningful UVs, and neither do the sheared/extruded surfaces the building
 *    and road generators produce. Projecting the material from all three world
 *    axes and blending by the surface normal removes the problem entirely:
 *    a 30-degree Filbert Street grade gets the same texel density as a flat
 *    block of SoMa, and a rock face on Twin Peaks does not smear.
 *
 * 2. **Visible tiling.** A 4-metre asphalt tile repeats 200 times across a
 *    street. Two layers fix it:
 *      - a **macro variation** map sampled at ~64 m per tile, multiplied into
 *        albedo, which puts large-scale tonal drift over the repeat so the
 *        pattern stops reading as a grid at range;
 *      - a **detail layer**, the same maps sampled 6-10x tighter and faded in
 *        over the last ~25 m, which quadruples effective resolution where the
 *        camera can actually resolve it and costs nothing beyond that.
 *
 * Implementation note: rather than replacing whole shader chunks (brittle, and
 * it means reimplementing three's AO/clearcoat plumbing by hand), we resolve
 * `#include`s ourselves and then surgically swap the *sampling expressions*.
 * That keeps every one of three's `#ifdef` branches intact and makes the patch
 * far more tolerant of a version bump.
 */
import * as THREE from "three";

/* ------------------------------------------------------------------ *
 * Public options
 * ------------------------------------------------------------------ */

export interface DetailOptions {
  /** How much tighter the detail layer tiles than the base. 1 = disabled. */
  detailScale?: number;
  /** Albedo contrast contributed by the detail layer, 0..1. */
  detailStrength?: number;
  /** Extra normal perturbation from the detail layer, 0..2. */
  detailNormalStrength?: number;
  /** Mean luminance of the base albedo; the detail multiply is normalised by it. */
  detailPivot?: number;
  /** Metres at which the detail layer starts fading out / is fully gone. */
  detailFadeStart?: number;
  detailFadeEnd?: number;
  /** Low-frequency variation map (see `macroVariationRaster`). */
  macroMap?: THREE.Texture | null;
  /** World metres per macro tile. */
  macroWorldScale?: number;
  /** 0..1 strength of the macro multiply. */
  macroStrength?: number;
}

export interface TriplanarOptions extends DetailOptions {
  /** World metres covered by one texture tile. */
  worldScale?: number;
  /** Higher = harder transition between the three projections. 2..12. */
  blendSharpness?: number;
  /** >1 favours the top-down projection — right for ground, wrong for walls. */
  upBias?: number;
}

/** Live uniform handles, so weather/wetness can drive a material at runtime. */
export interface SfShaderUniforms {
  uSfTriScale: THREE.IUniform<number>;
  uSfTriSharp: THREE.IUniform<number>;
  uSfUpBias: THREE.IUniform<number>;
  uSfDetailScale: THREE.IUniform<number>;
  uSfDetailStrength: THREE.IUniform<number>;
  uSfDetailNormalStrength: THREE.IUniform<number>;
  uSfDetailPivot: THREE.IUniform<number>;
  uSfDetailFade: THREE.IUniform<THREE.Vector2>;
  uSfMacroMap: THREE.IUniform<THREE.Texture | null>;
  uSfMacroScale: THREE.IUniform<number>;
  uSfMacroStrength: THREE.IUniform<number>;
}

interface SfMaterialUserData {
  sfUniforms?: SfShaderUniforms;
  sfMode?: "triplanar" | "detail";
  sfKey?: string;
}

/* ------------------------------------------------------------------ *
 * GLSL
 * ------------------------------------------------------------------ */

const VERT_DECL = /* glsl */ `
varying vec3 vSfWorldPos;
varying vec3 vSfWorldNrm;
varying float vSfViewDist;
`;

/** Injected immediately after <defaultnormal_vertex>. */
const VERT_NORMAL = /* glsl */ `
vec3 sfObjNormal = objectNormal;
#ifdef USE_INSTANCING
	sfObjNormal = mat3( instanceMatrix ) * sfObjNormal;
#endif
vSfWorldNrm = normalize( mat3( modelMatrix ) * sfObjNormal );
`;

/** Injected immediately after <project_vertex>, where mvPosition is live. */
const VERT_POS = /* glsl */ `
vec4 sfWorldPos4 = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
	sfWorldPos4 = instanceMatrix * sfWorldPos4;
#endif
sfWorldPos4 = modelMatrix * sfWorldPos4;
vSfWorldPos = sfWorldPos4.xyz;
vSfViewDist = - mvPosition.z;
`;

const FRAG_DECL = /* glsl */ `
uniform float uSfTriScale;
uniform float uSfTriSharp;
uniform float uSfUpBias;
uniform float uSfDetailScale;
uniform float uSfDetailStrength;
uniform float uSfDetailNormalStrength;
uniform float uSfDetailPivot;
uniform vec2  uSfDetailFade;
uniform float uSfMacroScale;
uniform float uSfMacroStrength;
#ifdef SF_MACRO
uniform sampler2D uSfMacroMap;
#endif
varying vec3 vSfWorldPos;
varying vec3 vSfWorldNrm;
varying float vSfViewDist;

vec3 sfTriWeights( vec3 n ) {
	vec3 w = pow( abs( n ), vec3( uSfTriSharp ) );
	w.y *= uSfUpBias;
	return w / max( w.x + w.y + w.z, 1e-4 );
}

vec4 sfTri( sampler2D t, vec3 p, vec3 w, float s ) {
	return texture2D( t, p.zy * s ) * w.x
	     + texture2D( t, p.xz * s ) * w.y
	     + texture2D( t, p.xy * s ) * w.z;
}

// Whiteout triplanar normal blend: reconstruct three tangent-space normals,
// fold the world normal into each, then swizzle into world space and blend.
// Cheaper and far more stable at grazing angles than building a real TBN per
// projection axis.
vec3 sfTriNormal( sampler2D t, vec3 p, vec3 w, float s, vec3 n, float str ) {
	vec3 tx = texture2D( t, p.zy * s ).xyz * 2.0 - 1.0;
	vec3 ty = texture2D( t, p.xz * s ).xyz * 2.0 - 1.0;
	vec3 tz = texture2D( t, p.xy * s ).xyz * 2.0 - 1.0;
	tx.xy *= str; ty.xy *= str; tz.xy *= str;
	tx = vec3( tx.xy + n.zy, abs( tx.z ) * n.x );
	ty = vec3( ty.xy + n.xz, abs( ty.z ) * n.y );
	tz = vec3( tz.xy + n.xy, abs( tz.z ) * n.z );
	return normalize( tx.zyx * w.x + ty.xzy * w.y + tz.xyz * w.z );
}
`;

const FRAG_DETAIL_DECL = /* glsl */ `
uniform float uSfDetailScale;
uniform float uSfDetailStrength;
uniform float uSfDetailNormalStrength;
uniform float uSfDetailPivot;
uniform vec2  uSfDetailFade;
uniform float uSfMacroScale;
uniform float uSfMacroStrength;
#ifdef SF_MACRO
uniform sampler2D uSfMacroMap;
#endif
varying vec3 vSfWorldPos;
varying vec3 vSfWorldNrm;
varying float vSfViewDist;
`;

/* ------------------------------------------------------------------ *
 * Include resolution
 * ------------------------------------------------------------------ */

/**
 * Expand three's `#include <chunk>` directives exactly the way WebGLProgram
 * does, so we can pattern-match on real GLSL instead of on include markers.
 * Running it early is harmless: by the time three resolves includes there are
 * none left to find.
 */
function resolveIncludes(source: string): string {
  const re = /^[ \t]*#include +<([\w\d./]+)>/gm;
  return source.replace(re, (match, name: string) => {
    const chunk = (THREE.ShaderChunk as unknown as Record<string, string>)[name];
    if (chunk === undefined) return match;
    return resolveIncludes(chunk);
  });
}

/** Insert `add` directly after the (unresolved) include marker for `name`. */
function after(source: string, name: string, add: string): string {
  const marker = `#include <${name}>`;
  const i = source.indexOf(marker);
  if (i < 0) return source;
  return source.slice(0, i + marker.length) + "\n" + add + "\n" + source.slice(i + marker.length);
}

function replaceAll(source: string, from: string, to: string): string {
  return source.split(from).join(to);
}

/* ------------------------------------------------------------------ *
 * Injection
 * ------------------------------------------------------------------ */

const DEFAULTS: Required<Omit<TriplanarOptions, "macroMap">> = {
  worldScale: 4,
  blendSharpness: 5,
  upBias: 1,
  detailScale: 8,
  detailStrength: 0.55,
  detailNormalStrength: 0.7,
  detailPivot: 0.35,
  detailFadeStart: 9,
  detailFadeEnd: 34,
  macroWorldScale: 64,
  macroStrength: 0.5,
};

function makeUniforms(o: TriplanarOptions): SfShaderUniforms {
  const worldScale = o.worldScale ?? DEFAULTS.worldScale;
  return {
    uSfTriScale: { value: 1 / Math.max(1e-3, worldScale) },
    uSfTriSharp: { value: o.blendSharpness ?? DEFAULTS.blendSharpness },
    uSfUpBias: { value: o.upBias ?? DEFAULTS.upBias },
    uSfDetailScale: { value: o.detailScale ?? DEFAULTS.detailScale },
    uSfDetailStrength: { value: o.detailStrength ?? DEFAULTS.detailStrength },
    uSfDetailNormalStrength: {
      value: o.detailNormalStrength ?? DEFAULTS.detailNormalStrength,
    },
    uSfDetailPivot: { value: o.detailPivot ?? DEFAULTS.detailPivot },
    uSfDetailFade: {
      value: new THREE.Vector2(
        o.detailFadeStart ?? DEFAULTS.detailFadeStart,
        o.detailFadeEnd ?? DEFAULTS.detailFadeEnd,
      ),
    },
    uSfMacroMap: { value: o.macroMap ?? null },
    uSfMacroScale: { value: 1 / Math.max(1e-3, o.macroWorldScale ?? DEFAULTS.macroWorldScale) },
    uSfMacroStrength: { value: o.macroStrength ?? DEFAULTS.macroStrength },
  };
}

/**
 * Turn a standard/physical material into a world-projected one.
 *
 * The material keeps its maps, its lighting model, its shadows and its
 * instancing support — only the sampling changes. Call it once, at material
 * construction; the uniform block is stashed on `userData.sfUniforms` so the
 * weather system can push wetness/scale changes per frame without recompiling.
 */
export function applyTriplanar<T extends THREE.Material>(
  material: T,
  opts: TriplanarOptions = {},
): T {
  return inject(material, opts, "triplanar");
}

/**
 * Detail + macro variation without triplanar, for surfaces that already have
 * honest UVs (building facades, vehicle bodies, props). Same anti-tiling
 * machinery, one third of the texture fetches.
 */
export function applyDetailBlend<T extends THREE.Material>(
  material: T,
  opts: DetailOptions = {},
): T {
  return inject(material, opts, "detail");
}

function inject<T extends THREE.Material>(
  material: T,
  opts: TriplanarOptions,
  mode: "triplanar" | "detail",
): T {
  const ud = material.userData as SfMaterialUserData;
  if (ud.sfMode) return material; // already patched — never double-inject
  const uniforms = makeUniforms(opts);
  const useMacro = !!opts.macroMap;
  const useDetail = (opts.detailScale ?? DEFAULTS.detailScale) > 1.001;
  const key = `sf:${mode}:${useMacro ? "m" : "-"}${useDetail ? "d" : "-"}`;

  ud.sfUniforms = uniforms;
  ud.sfMode = mode;
  ud.sfKey = key;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    /* ---- vertex ---- */
    let v = VERT_DECL + shader.vertexShader;
    v = after(v, "defaultnormal_vertex", VERT_NORMAL);
    v = after(v, "project_vertex", VERT_POS);
    shader.vertexShader = v;

    /* ---- fragment ---- */
    const defines: string[] = [];
    if (useMacro) defines.push("#define SF_MACRO");
    if (useDetail) defines.push("#define SF_DETAIL");
    const decl = defines.join("\n") + "\n" + (mode === "triplanar" ? FRAG_DECL : FRAG_DETAIL_DECL);

    let f = decl + shader.fragmentShader;

    // Per-fragment setup, injected at the very top of main().
    const setup =
      mode === "triplanar"
        ? /* glsl */ `
	vec3 sfWorldP = vSfWorldPos;
	vec3 sfNrmW = normalize( vSfWorldNrm );
	vec3 sfBlend = sfTriWeights( sfNrmW );
	float sfDetailFade = 1.0 - smoothstep( uSfDetailFade.x, uSfDetailFade.y, vSfViewDist );
`
        : /* glsl */ `
	float sfDetailFade = 1.0 - smoothstep( uSfDetailFade.x, uSfDetailFade.y, vSfViewDist );
`;
    f = after(f, "clipping_planes_fragment", setup);

    // Albedo: detail contrast, then macro drift.
    const albedoExtra =
      mode === "triplanar"
        ? /* glsl */ `
#if defined( SF_DETAIL ) && defined( USE_MAP )
	{
		vec4 sfD = sfTri( map, sfWorldP, sfBlend, uSfTriScale * uSfDetailScale );
		float sfDl = dot( sfD.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) / max( uSfDetailPivot, 1e-3 );
		diffuseColor.rgb *= mix( 1.0, clamp( sfDl, 0.25, 2.5 ), uSfDetailStrength * sfDetailFade );
	}
#endif
#ifdef SF_MACRO
	{
		vec3 sfM = sfTri( uSfMacroMap, sfWorldP, sfBlend, uSfMacroScale ).rgb;
		diffuseColor.rgb *= mix( vec3( 1.0 ), sfM * 2.0, uSfMacroStrength );
	}
#endif
`
        : /* glsl */ `
#if defined( SF_DETAIL ) && defined( USE_MAP )
	{
		vec4 sfD = texture2D( map, vMapUv * uSfDetailScale );
		float sfDl = dot( sfD.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) / max( uSfDetailPivot, 1e-3 );
		diffuseColor.rgb *= mix( 1.0, clamp( sfDl, 0.25, 2.5 ), uSfDetailStrength * sfDetailFade );
	}
#endif
#if defined( SF_MACRO ) && defined( USE_MAP )
	{
		vec3 sfM = texture2D( uSfMacroMap, vMapUv * uSfMacroScale ).rgb;
		diffuseColor.rgb *= mix( vec3( 1.0 ), sfM * 2.0, uSfMacroStrength );
	}
#endif
`;
    f = after(f, "map_fragment", albedoExtra);

    // Roughness detail. Uniform roughness is the single most reliable tell of
    // a cheap renderer, so the detail layer perturbs it too.
    const roughExtra =
      mode === "triplanar"
        ? /* glsl */ `
#if defined( SF_DETAIL ) && defined( USE_ROUGHNESSMAP )
	{
		float sfR = sfTri( roughnessMap, sfWorldP, sfBlend, uSfTriScale * uSfDetailScale ).g;
		roughnessFactor = mix( roughnessFactor, roughnessFactor * ( 0.62 + sfR * 0.78 ), uSfDetailStrength * sfDetailFade * 0.7 );
	}
#endif
`
        : /* glsl */ `
#if defined( SF_DETAIL ) && defined( USE_ROUGHNESSMAP )
	{
		float sfR = texture2D( roughnessMap, vRoughnessMapUv * uSfDetailScale ).g;
		roughnessFactor = mix( roughnessFactor, roughnessFactor * ( 0.62 + sfR * 0.78 ), uSfDetailStrength * sfDetailFade * 0.7 );
	}
#endif
`;
    f = after(f, "roughnessmap_fragment", roughExtra);

    // Normals. In triplanar mode we override outright; in detail mode we only
    // add the high-frequency perturbation on top of three's own TBN result.
    const normalExtra =
      mode === "triplanar"
        ? /* glsl */ `
#ifdef USE_NORMALMAP
	{
		vec3 sfN = sfTriNormal( normalMap, sfWorldP, sfBlend, uSfTriScale, sfNrmW, normalScale.x );
		#ifdef SF_DETAIL
			vec3 sfDN = sfTriNormal( normalMap, sfWorldP, sfBlend, uSfTriScale * uSfDetailScale, sfNrmW, normalScale.x );
			sfN = normalize( sfN + ( sfDN - sfNrmW ) * uSfDetailNormalStrength * sfDetailFade );
		#endif
		normal = normalize( mat3( viewMatrix ) * sfN );
		#ifdef DOUBLE_SIDED
			normal *= faceDirection;
		#endif
	}
#endif
`
        : /* glsl */ `
#if defined( SF_DETAIL ) && defined( USE_NORMALMAP_TANGENTSPACE )
	{
		vec3 sfDN = texture2D( normalMap, vNormalMapUv * uSfDetailScale ).xyz * 2.0 - 1.0;
		sfDN.xy *= normalScale * uSfDetailNormalStrength * sfDetailFade;
		normal = normalize( normal + normalize( tbn * vec3( sfDN.xy, 1.0 ) ) - normalize( tbn * vec3( 0.0, 0.0, 1.0 ) ) );
	}
#endif
`;
    f = after(f, "normal_fragment_maps", normalExtra);

    // Now expand three's chunks and swap the base sampling expressions for the
    // triplanar equivalents. Surgical, and it leaves every #ifdef branch alone.
    if (mode === "triplanar") {
      f = resolveIncludes(f);
      f = replaceAll(
        f,
        "texture2D( map, vMapUv )",
        "sfTri( map, sfWorldP, sfBlend, uSfTriScale )",
      );
      f = replaceAll(
        f,
        "texture2D( roughnessMap, vRoughnessMapUv )",
        "sfTri( roughnessMap, sfWorldP, sfBlend, uSfTriScale )",
      );
      f = replaceAll(
        f,
        "texture2D( metalnessMap, vMetalnessMapUv )",
        "sfTri( metalnessMap, sfWorldP, sfBlend, uSfTriScale )",
      );
      f = replaceAll(
        f,
        "texture2D( aoMap, vAoMapUv ).r",
        "sfTri( aoMap, sfWorldP, sfBlend, uSfTriScale ).r",
      );
      f = replaceAll(
        f,
        "texture2D( emissiveMap, vEmissiveMapUv )",
        "sfTri( emissiveMap, sfWorldP, sfBlend, uSfTriScale )",
      );
    }

    shader.fragmentShader = f;
  };

  // Without this, three caches one program per (vertex, fragment) *source*
  // pair derived from the material type — two materials with different
  // injections would share a program and one of them would be silently wrong.
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
  return material;
}

/* ------------------------------------------------------------------ *
 * Runtime control
 * ------------------------------------------------------------------ */

export function getSfUniforms(material: THREE.Material): SfShaderUniforms | null {
  return (material.userData as SfMaterialUserData).sfUniforms ?? null;
}

export function isTriplanar(material: THREE.Material): boolean {
  return (material.userData as SfMaterialUserData).sfMode === "triplanar";
}

/** Change the world size of one tile after the fact (metres). */
export function setTriplanarWorldScale(material: THREE.Material, metres: number): void {
  const u = getSfUniforms(material);
  if (u) u.uSfTriScale.value = 1 / Math.max(1e-3, metres);
}

export interface TriplanarPatch {
  worldScale?: number;
  blendSharpness?: number;
  upBias?: number;
  detailScale?: number;
  detailStrength?: number;
  detailNormalStrength?: number;
  detailPivot?: number;
  detailFadeStart?: number;
  detailFadeEnd?: number;
  macroStrength?: number;
  macroWorldScale?: number;
}

/** Bulk uniform update — safe to call every frame; allocates nothing. */
export function updateTriplanar(material: THREE.Material, patch: TriplanarPatch): void {
  const u = getSfUniforms(material);
  if (!u) return;
  if (patch.worldScale !== undefined) u.uSfTriScale.value = 1 / Math.max(1e-3, patch.worldScale);
  if (patch.blendSharpness !== undefined) u.uSfTriSharp.value = patch.blendSharpness;
  if (patch.upBias !== undefined) u.uSfUpBias.value = patch.upBias;
  if (patch.detailScale !== undefined) u.uSfDetailScale.value = patch.detailScale;
  if (patch.detailStrength !== undefined) u.uSfDetailStrength.value = patch.detailStrength;
  if (patch.detailNormalStrength !== undefined) {
    u.uSfDetailNormalStrength.value = patch.detailNormalStrength;
  }
  if (patch.detailPivot !== undefined) u.uSfDetailPivot.value = patch.detailPivot;
  if (patch.detailFadeStart !== undefined) u.uSfDetailFade.value.x = patch.detailFadeStart;
  if (patch.detailFadeEnd !== undefined) u.uSfDetailFade.value.y = patch.detailFadeEnd;
  if (patch.macroStrength !== undefined) u.uSfMacroStrength.value = patch.macroStrength;
  if (patch.macroWorldScale !== undefined) {
    u.uSfMacroScale.value = 1 / Math.max(1e-3, patch.macroWorldScale);
  }
}
