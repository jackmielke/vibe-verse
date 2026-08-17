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
}

/**
 * The one material constructor this world uses.
 *
 * Everything is cached by its options, so the whole city ends up sharing a
 * handful of programs and a handful of materials — a few dozen draw calls for
 * a downtown, without any batching cleverness, purely because nothing needs to
 * be different from anything else.
 */
export function toon(color: number, o: ToonOptions = {}): THREE.MeshToonMaterial {
  const key = `t:${color}:${o.vertexColors ? 1 : 0}:${o.transparent ? 1 : 0}:${
    o.opacity ?? 1
  }:${o.side ?? 0}:${o.emissive ?? -1}:${o.emissiveIntensity ?? 0}`;
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
 */
export function outlineMaterial(thickness = 0.02): THREE.ShaderMaterial {
  const key = `o:${thickness}`;
  const hit = cache.get(key);
  if (hit) return hit as THREE.ShaderMaterial;
  const m = new THREE.ShaderMaterial({
    uniforms: { uThickness: { value: thickness }, uColor: { value: new THREE.Color(COLORS.outline) } },
    vertexShader: /* glsl */ `
      uniform float uThickness;
      void main() {
        // Grow along the normal in VIEW space, scaled by depth, so the outline
        // keeps a constant thickness on screen instead of vanishing at range.
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        mv.xyz += n * uThickness * -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      void main() { gl_FragColor = vec4(uColor, 1.0); }
    `,
    side: THREE.BackSide,
  });
  cache.set(key, m);
  return m;
}

/** Give an object a cartoon outline. Returns the added mesh, or null. */
export function addOutline(mesh: THREE.Mesh, thickness = 0.02): THREE.Mesh | null {
  if (!mesh.geometry) return null;
  const shell = new THREE.Mesh(mesh.geometry, outlineMaterial(thickness));
  shell.renderOrder = -1;
  shell.castShadow = false;
  shell.receiveShadow = false;
  mesh.add(shell);
  return shell;
}

/** Drop every cached material. Called on unmount. */
export function disposeLook(): void {
  for (const m of cache.values()) m.dispose();
  cache.clear();
  gradientMap?.dispose();
  gradientMap = null;
}
