/**
 * look.ts — the entire art direction of Vibe Francisco, in one file.
 *
 * The world next door, /sf, spends two thousand lines generating physically
 * plausible asphalt: aggregate grain, crack networks, oil stains, utility
 * patches, a wet variant with puddles that pool in the wheel ruts. It is
 * genuinely beautiful and it is the opposite of what this world wants.
 *
 * **Nothing here has a texture.** Not one. Every surface in Vibe Francisco is
 * a flat colour off the palette below, banded into two or three tones by a
 * toon ramp, and that is the whole shading model. Three consequences, all of
 * them the point:
 *
 *  - It reads as *made* rather than photographed. A toy city is painted wood
 *    and the eye knows the difference instantly — from the absence of grain
 *    more than from anything you could add.
 *  - It cannot shimmer. Texture aliasing at a grazing angle is what put white
 *    crumbs all over /sf's roads at street level; a flat colour minifies to
 *    itself at every distance, from every angle, forever.
 *  - It costs nothing. No texture memory, no mip chains, no anisotropy, and a
 *    handful of materials shared by the whole city — which is what lets the
 *    map be resident all at once with no streaming.
 *
 * Colour does the work texture usually does. The palette is a fixed set of
 * saturated pastels; districts draw from different slices of it, so Chinatown
 * reads red-and-gold and the Financial District reads glass-and-slate without
 * a single decal.
 */
import * as THREE from "three";

/* ------------------------------------------------------------------ *
 * Palette
 * ------------------------------------------------------------------ */

/**
 * Wall colours, indexed by `District.palette`.
 *
 * Sampled off a sunny afternoon in the real city and then pushed: San
 * Francisco is already a pastel town — cream, terracotta, sage, dusty rose
 * stacked up a hill — which is a large part of why it survives being made into
 * a toy at all. A grey city would not.
 */
export const WALLS = [
  0xf2ede2, // 0  cream stucco — the FiDi default
  0x9fb8c8, // 1  pale blue glass
  0x6d7f92, // 2  slate curtain wall
  0xd85a4a, // 3  Chinatown red
  0xe8a33d, // 4  gold / awning yellow
  0xb43b3b, // 5  deep lacquer red
  0xe9d3b6, // 6  warm sand
  0xd98f6a, // 7  terracotta
  0xa8bfa0, // 8  sage
  0xe3b9c8, // 9  dusty rose
  0x4d5a6b, // 10 deep navy glass
] as const;

export const COLORS = {
  asphalt: 0x5b5f6b,
  asphaltLine: 0xf5e9c8,
  sidewalk: 0xcfc9bd,
  crossing: 0xf6f2e8,
  grass: 0x86b25c,
  grassDark: 0x6b9448,
  sand: 0xe6d7ae,
  water: 0x3f86c4,
  waterDeep: 0x2a5f96,
  waterFoam: 0xd8ecf8,
  roof: 0x8d8577,
  roofDark: 0x6c6558,
  window: 0x7fd4e8,
  windowLit: 0xffd98a,
  trunk: 0x8a6146,
  leaf: 0x6fae54,
  leafDark: 0x548a41,
  palmLeaf: 0x7cb85e,
  bridgeOrange: 0xe4572e,
  brick: 0xb5654a,
  stone: 0xded6c6,
  stoneDark: 0xb9b0a0,
  metal: 0x9aa4b0,
  gold: 0xf0b93b,
  outline: 0x2a2622,
  fog: 0xdfe9ef,
  sky: 0x7fc4f0,
  skyHigh: 0x3f8fd8,
} as const;

/* ------------------------------------------------------------------ *
 * The toon ramp
 * ------------------------------------------------------------------ */

let gradientMap: THREE.DataTexture | null = null;

/**
 * A three-step gradient map: shadow, mid, light.
 *
 * `MeshToonMaterial` looks up lambertian N·L in this instead of using it
 * directly, so a curved surface bands into flat regions with hard edges — the
 * single most recognisable ingredient of a cel-shaded look, and three gives it
 * to us for the cost of a 3-pixel texture.
 *
 * Three steps rather than the usual five because a toy wants fewer, chunkier
 * bands, and rather than two because two makes every north face read as
 * unlit black.
 */
export function toonGradient(): THREE.DataTexture {
  if (gradientMap) return gradientMap;
  const data = new Uint8Array([90, 90, 90, 255, 190, 190, 190, 255, 255, 255, 255, 255]);
  const tex = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  gradientMap = tex;
  return tex;
}

/* ------------------------------------------------------------------ *
 * Materials
 * ------------------------------------------------------------------ */

const cache = new Map<string, THREE.Material>();

export interface ToonOptions {
  /** Vertex colours multiply the base colour — how one material paints a city. */
  vertexColors?: boolean;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
  emissive?: number;
  emissiveIntensity?: number;
  /** Read the per-vertex `glow` attribute and emit it at night. */
  glow?: boolean;
}

/**
 * The one material constructor this world uses.
 *
 * Everything is cached by its options, so the whole city ends up sharing a
 * handful of programs and a handful of materials — a few dozen draw calls for
 * a downtown, without any batching cleverness, purely because nothing needs to
 * be different from anything else.
 */
/**
 * How lit the world is, 0 by day and 1 at deep night, shared by every material
 * that can glow.
 *
 * One uniform *object*, handed to every compiled program by reference, so
 * setting `.value` once lights every window in the city on the same frame.
 * Giving each material its own uniform and looping over them would work too,
 * and would go wrong the first time somebody added a material and forgot.
 */
const NIGHT = { value: 0 };
const LAMPLIGHT = { value: new THREE.Color(0xffd08a) };

/** 0 = full daylight, 1 = the lights are on. Driven by `sky.ts`. */
export function setNight(v: number): void {
  NIGHT.value = Math.max(0, Math.min(1, v));
}

export function nightAmount(): number {
  return NIGHT.value;
}

export function toon(color: number, o: ToonOptions = {}): THREE.MeshToonMaterial {
  const key = `t:${color}:${o.vertexColors ? 1 : 0}:${o.transparent ? 1 : 0}:${
    o.opacity ?? 1
  }:${o.side ?? 0}:${o.emissive ?? -1}:${o.emissiveIntensity ?? 0}:${o.glow ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return hit as THREE.MeshToonMaterial;
  const m = new THREE.MeshToonMaterial({
    color,
    gradientMap: toonGradient(),
    vertexColors: o.vertexColors ?? false,
    transparent: o.transparent ?? false,
    opacity: o.opacity ?? 1,
    side: o.side ?? THREE.FrontSide,
  });
  if (o.glow) {
    /* The night lights, injected rather than hand-written.
       `look.ts` learned this the hard way with the outline shader: a raw
       ShaderMaterial here would lose skinning, the logarithmic depth buffer and
       colour management all at once. So this is a stock MeshToonMaterial with a
       `glow` attribute read in the vertex shader and added to the output in the
       fragment shader, and everything else three does for us stays done.

       The addition happens BEFORE `colorspace_fragment`, so the glow is added
       in linear space along with everything else and converted once on the way
       out. Adding it after gives a light that is roughly twice as bright as
       intended and does not blend with the toon bands underneath. */
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = NIGHT;
      shader.uniforms.uLamp = LAMPLIGHT;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float glow;\nvarying float vGlow;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvGlow = glow;");
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nuniform float uNight;\nuniform vec3 uLamp;\nvarying float vGlow;",
        )
        .replace(
          "#include <colorspace_fragment>",
          "gl_FragColor.rgb += vGlow * uNight * uLamp * 0.95;\n#include <colorspace_fragment>",
        );
    };
    // Without this three reuses one compiled program for every MeshToonMaterial
    // in the scene and the injection silently applies to all of them or none.
    m.customProgramCacheKey = () => `frisco-glow:${color}:${o.vertexColors ? 1 : 0}`;
  }
  if (o.emissive !== undefined) {
    m.emissive = new THREE.Color(o.emissive);
    m.emissiveIntensity = o.emissiveIntensity ?? 1;
  }
  /* No flat-shading knob: `MeshToonMaterial` does not carry one in three 0.160,
     and it does not need to. The gradient ramp already collapses a curved
     surface into hard bands, which is the look flat shading is usually reached
     for — and unlike flat shading it keeps working on the merged geometry the
     city is built from, where every block shares one buffer and there are no
     per-face normals left to flatten. */
  cache.set(key, m);
  return m;
}

/** Unlit flat colour — for water foam, flames, anything that makes its own light. */
export function flat(color: number, o: { transparent?: boolean; opacity?: number; side?: THREE.Side } = {}) {
  const key = `f:${color}:${o.transparent ? 1 : 0}:${o.opacity ?? 1}:${o.side ?? 0}`;
  const hit = cache.get(key);
  if (hit) return hit as THREE.MeshBasicMaterial;
  const m = new THREE.MeshBasicMaterial({
    color,
    transparent: o.transparent ?? false,
    opacity: o.opacity ?? 1,
    side: o.side ?? THREE.FrontSide,
  });
  cache.set(key, m);
  return m;
}

/**
 * The outline material: the same shape, grown along its normals, drawn
 * back-faces-only in near-black behind the real thing.
 *
 * This is the inverted-hull trick, and it is the second half of what makes
 * something read as a cartoon rather than as a low-poly model. It costs a
 * whole extra draw of the geometry, so it is reserved for the objects that
 * carry the world's identity — the landmarks and the character — and never
 * applied to the thousand background blocks, which get their definition from
 * the toon ramp alone.
 *
 * **It is a stock `MeshBasicMaterial` with one injected line, and not the
 * hand-written `ShaderMaterial` it obviously wants to be.** That is the whole
 * point of this function and it is worth the paragraph, because the obvious
 * version — twelve lines of GLSL that push the vertex along its normal and
 * return a constant colour — was written first and cost most of a day.
 *
 * A raw shader opts out of everything three does for you, and three was doing
 * three things here that this world depends on:
 *
 *  - **Skinning.** A hand-written shader has none, so the hull of a character
 *    renders in bind pose, ignoring the bones. On a rig scaled 38× — which is
 *    what `loadCharacterRig` hands back — the un-skinned hull is a
 *    seventy-metre black shape parked at the rig's origin. It engulfs the
 *    camera, and every pixel of the sky comes back the outline colour. What
 *    that looks like is a world with no sky, so it is diagnosed as a sky bug,
 *    which is where the day went. The `[6,5,4]` in the framebuffer was what
 *    finally named it: `COLORS.outline` in *linear* space, which is the third
 *    problem below announcing itself.
 *  - **The logarithmic depth buffer.** Every other material in this world
 *    writes `gl_FragDepth` on the log scale; a raw shader writes ordinary
 *    `gl_FragCoord.z`. The two are not comparable, and the outline wins and
 *    loses depth tests essentially at random.
 *  - **Colour management.** Uniforms set from a `THREE.Color` are converted to
 *    linear on assignment, and a raw shader never converts back, so the colour
 *    that reaches the screen is not the colour in the palette.
 *
 * `onBeforeCompile` keeps all three and buys the one thing the raw shader was
 * for. `customProgramCacheKey` is not optional alongside it: without it three
 * reuses one compiled program for every `MeshBasicMaterial` in the scene and
 * the injection silently applies to none of them, or all of them.
 */
export function outlineMaterial(thickness = 0.02): THREE.MeshBasicMaterial {
  const key = `o:${thickness}`;
  const hit = cache.get(key);
  if (hit) return hit as THREE.MeshBasicMaterial;
  const m = new THREE.MeshBasicMaterial({ color: COLORS.outline, side: THREE.BackSide });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uThickness = { value: thickness };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uThickness;")
      .replace(
        "#include <project_vertex>",
        /* glsl */ `
        // The stock projection, with the hull pushed out along the normal in
        // VIEW space and scaled by depth, so the line keeps a constant width on
        // screen instead of thinning to nothing at range.
        //
        // \`transformed\` already carries the skinning; the normal has to be
        // skinned by hand here because MeshBasicMaterial only bothers to do it
        // when there is an environment map, and a shell with an unskinned
        // normal turns inside out at every joint.
        vec3 outlineNormal = normal;
        #ifdef USE_SKINNING
          outlineNormal = vec3( skinMatrix * vec4( outlineNormal, 0.0 ) );
        #endif
        vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
        // Scaled by depth so the line keeps a constant width on screen — but
        // CLAMPED, because unbounded it eats the thing it is outlining. At a
        // kilometre the shell was growing six metres, which is wider than a
        // bridge cable, a clock face or a cathedral spire: distant landmarks
        // turned into featureless black lumps floating over the skyline, and
        // the shape of the lump changed as you flew, which reads as anything
        // but an outline. Past a hundred metres the line is sub-pixel anyway.
        mvPosition.xyz += normalize( normalMatrix * outlineNormal ) * uThickness *
          clamp( -mvPosition.z, 0.05, 110.0 );
        gl_Position = projectionMatrix * mvPosition;
        `,
      );
  };
  m.customProgramCacheKey = () => `frisco-outline:${thickness}`;
  cache.set(key, m);
  return m;
}

/**
 * Give an object a cartoon outline. Returns the added shell, or null.
 *
 * Where the shell goes depends on what it is outlining, and the two cases are
 * not interchangeable:
 *
 *  - A plain mesh gets the shell as a **child** with an identity transform, so
 *    it inherits the mesh's place in the world for free.
 *  - A skinned mesh gets a `SkinnedMesh` shell bound to the *same skeleton*,
 *    added as a **sibling**. A skinned mesh's own `matrixWorld` is not where it
 *    appears — the bones decide that — so a child would be drawn wherever the
 *    rig's root happens to sit, at whatever scale the rig happens to carry.
 *
 * Either way the shell is marked, because it is a trap for anything that walks
 * the scene graph: the first version of this had no mark, and
 * `traverse(addOutline)` over a character rig outlined the outline, and
 * outlined that, until the stack ran out. The symptom is a `Maximum call stack
 * size exceeded` from deep inside `updateMatrixWorld`, which points at three
 * rather than at the code that did it. Never add to a subtree you are
 * traversing.
 */
export function addOutline(mesh: THREE.Mesh, thickness = 0.02): THREE.Mesh | null {
  if (!mesh.geometry) return null;
  if (isOutline(mesh)) return null;

  const mat = outlineMaterial(thickness);
  const skinned = mesh as THREE.SkinnedMesh;
  let shell: THREE.Mesh;

  if (skinned.isSkinnedMesh && skinned.skeleton) {
    const s = new THREE.SkinnedMesh(mesh.geometry, mat);
    s.bindMode = skinned.bindMode;
    s.bind(skinned.skeleton, skinned.bindMatrix);
    s.position.copy(mesh.position);
    s.quaternion.copy(mesh.quaternion);
    s.scale.copy(mesh.scale);
    shell = s;
  } else {
    shell = new THREE.Mesh(mesh.geometry, mat);
    shell.matrixAutoUpdate = false;
  }

  shell.name = OUTLINE_NAME;
  shell.userData.friscoOutline = true;
  shell.renderOrder = -1;
  shell.castShadow = false;
  shell.receiveShadow = false;
  // The hull is bigger than the thing it wraps and the camera can end up inside
  // it, which three's bounding-sphere test reads as "off screen".
  shell.frustumCulled = false;

  if (skinned.isSkinnedMesh && mesh.parent) mesh.parent.add(shell);
  else mesh.add(shell);
  return shell;
}

const OUTLINE_NAME = "frisco-outline";

/** True for a shell this module added. */
export function isOutline(o: THREE.Object3D): boolean {
  return o.userData?.friscoOutline === true;
}

/**
 * Outline every mesh in a subtree, safely.
 *
 * Collects first, mutates second — see the note on `addOutline`.
 */
export function outlineTree(root: THREE.Object3D, thickness = 0.012): void {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry && !isOutline(m)) meshes.push(m);
  });
  for (const m of meshes) addOutline(m, thickness);
}

/** Drop every cached material. Called on unmount. */
export function disposeLook(): void {
  for (const m of cache.values()) m.dispose();
  cache.clear();
  gradientMap?.dispose();
  gradientMap = null;
}
