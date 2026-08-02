/**
 * Vibe Kart — the material library.
 *
 * Turns the raw channels the bakers produce into shared GPU materials, and owns
 * every texture in the game. Three rules run through the whole file:
 *
 * · **Share aggressively.** One material instance per surface kind, one texture
 *   per map, and a packed ao/roughness/metalness texture bound to all three
 *   slots. A track dressed from this library costs a few dozen unique
 *   materials, which is what keeps the draw-call budget spendable on geometry.
 *
 * · **Bake once, at boot.** `createMaterialLibrary` publishes its handle
 *   synchronously and then fills itself in on a yielding loop so the loading bar
 *   still paints. Anything asked for before its turn is baked on demand, so a
 *   consumer can never see an undefined material.
 *
 * · **Nothing exotic.** The screenshot harness runs on a software rasteriser:
 *   no float render targets, no MRT, no derivatives beyond what three's own
 *   tangent frame already uses, and anisotropy clamped to whatever the context
 *   actually reports.
 */
import * as THREE from "three";
import { BAKERS, type Baked, type BakeInput, type MaterialName } from "./textures";
import {
  clamp01,
  clearNoiseCaches,
  makeRng,
  normalFromHeight,
  packORM,
  rasterTexture,
  type Field,
  type Raster,
} from "./noise";

export type { MaterialName };

export interface MaterialLibrary {
  /** Cached shared material. Clone before mutating. */
  get(name: MaterialName): THREE.Material;
  /** A car-paint material tinted for a racer. */
  carPaint(color: number, accent?: number): THREE.Material;
  /** Cached procedural texture, tiled `repeat` times over a metre. */
  texture(name: MaterialName, repeat?: number): THREE.Texture;
  /** Animated materials (water, neon, anti-gravity) tick here. */
  update(dt: number, elapsed: number): void;
  /** Re-point every PBR material at the scene's prefiltered environment. */
  setEnvMap(env: THREE.Texture | null): void;
  dispose(): void;

  // -- additions beyond the boot contract, safe for consumers to ignore -----

  /** World metres covered by one tile of `name` — use it to set `repeat`. */
  tileSize(name: MaterialName): number;
  /**
   * Set `repeat` from a world-space extent, so two meshes of different sizes
   * share one material scale. Returns a cached clone keyed by the repeat.
   */
  tiled(name: MaterialName, metresU: number, metresV?: number): THREE.Texture;
  /** Raw maps, for a system that wants to build its own ShaderMaterial. */
  maps(name: MaterialName): MaterialMaps;
  /** Every material this library has handed out, for debug overlays. */
  readonly names: readonly MaterialName[];
  /** False until the boot bake finishes; consumers may ignore it. */
  readonly ready: boolean;
}

export interface MaterialMaps {
  map?: THREE.Texture;
  normalMap?: THREE.Texture;
  /** Packed ao (r) / roughness (g) / metalness (b). */
  ormMap?: THREE.Texture;
  emissiveMap?: THREE.Texture;
}

// ---------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------

type Quality = "low" | "medium" | "high" | "ultra";

interface QualityTier {
  /** Multiplier on every material's authored texture size. */
  scale: number;
  anisotropy: number;
  /** The AO pass is the most expensive bake step; it is the first to go. */
  ao: boolean;
}

const TIERS: Record<Quality, QualityTier> = {
  low: { scale: 0.25, anisotropy: 1, ao: false },
  medium: { scale: 0.5, anisotropy: 4, ao: true },
  high: { scale: 1, anisotropy: 8, ao: true },
  ultra: { scale: 1, anisotropy: 16, ao: true },
};

/**
 * Authored texture side at `high`, and the world extent one tile covers.
 *
 * The sizes are not uniform on purpose. Tarmac and turf fill the screen for the
 * whole race and earn 512²; a windscreen is forty pixels tall at 100 km/h and
 * does not.
 */
const SPEC: Record<MaterialName, { size: number; tile: number }> = {
  asphalt: { size: 512, tile: 4 },
  asphaltWorn: { size: 512, tile: 4 },
  kerb: { size: 512, tile: 3.2 },
  roadLine: { size: 256, tile: 4 },
  startLine: { size: 256, tile: 8 },
  grass: { size: 512, tile: 6 },
  dirt: { size: 256, tile: 6 },
  sand: { size: 256, tile: 7 },
  water: { size: 256, tile: 12 },
  ice: { size: 256, tile: 8 },
  wood: { size: 256, tile: 3.2 },
  metal: { size: 256, tile: 3 },
  grate: { size: 256, tile: 1.6 },
  concrete: { size: 256, tile: 4 },
  brick: { size: 256, tile: 1 },
  stone: { size: 256, tile: 3 },
  rubber: { size: 128, tile: 0.6 },
  chrome: { size: 64, tile: 1 },
  carPaint: { size: 256, tile: 1.5 },
  glass: { size: 128, tile: 2 },
  plastic: { size: 128, tile: 1.5 },
  foliage: { size: 256, tile: 1.6 },
  bark: { size: 256, tile: 1.2 },
  cloth: { size: 256, tile: 1.5 },
  banner: { size: 256, tile: 4 },
  neon: { size: 256, tile: 1.5 },
  antigrav: { size: 256, tile: 4 },
  boostPad: { size: 256, tile: 4 },
  crowd: { size: 512, tile: 8 },
};

/**
 * Global normal-map gain. Tuned at speed, not standing still: a track read at
 * 28 m/s wants noticeably stronger surface relief than the same material looks
 * "correct" with in a turntable render, because motion eats detail.
 */
const NORMAL_GAIN = 1.15;

function pow2(v: number): number {
  let n = 32;
  while (n * 2 <= v) n *= 2;
  return n;
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

interface Entry {
  maps: MaterialMaps;
  material: THREE.Material;
}

/**
 * three types `normalScale` as a Vector2; every call site here wants one
 * number, so the parameter is swapped out rather than intersected (an
 * intersection of Vector2 and number is `never`, which is a fun ten minutes).
 */
type StdParams = Omit<Partial<THREE.MeshStandardMaterialParameters>, "normalScale"> & {
  normalScale?: number;
};
type PhysParams = Omit<Partial<THREE.MeshPhysicalMaterialParameters>, "normalScale"> & {
  normalScale?: number;
};

/** Materials whose emissive glow the library animates. */
interface Animated {
  neon?: THREE.MeshStandardMaterial;
  antigrav?: THREE.MeshStandardMaterial;
  boostPad?: THREE.MeshStandardMaterial;
}

export interface MaterialLibraryOptions {
  quality?: Quality;
  renderer?: THREE.WebGLRenderer;
}

/** What the boot system holds: the public library plus the deferred bake. */
export interface BakingMaterialLibrary extends MaterialLibrary {
  bakeAll(onProgress?: (done: number, total: number) => void): Promise<void>;
}

export function createMaterialLibrary(opts: MaterialLibraryOptions = {}): BakingMaterialLibrary {
  const tier = TIERS[opts.quality ?? "high"];
  // Never ask for more anisotropy than the context has: on SwiftShader the
  // extension is absent and getMaxAnisotropy() returns 1.
  const maxAniso = opts.renderer ? opts.renderer.capabilities.getMaxAnisotropy() : 4;
  const aniso = Math.max(1, Math.min(tier.anisotropy, maxAniso));

  const entries = new Map<MaterialName, Entry>();
  const textures: THREE.Texture[] = [];
  const materials: THREE.Material[] = [];
  const clones = new Map<string, THREE.Texture>();
  const paints = new Map<string, THREE.Material>();
  const animated: Animated = {};
  const envUsers: THREE.Material[] = [];

  let envMap: THREE.Texture | null = null;
  let ready = false;
  let disposed = false;

  // Water is the one material with a hand-written shader patch: two scrolling
  // normal samples plus a horizon-tinted fresnel rim.
  const waterScrollA = { value: new THREE.Vector2() };
  const waterScrollB = { value: new THREE.Vector2() };

  const names = Object.keys(SPEC) as MaterialName[];

  function sizeOf(name: MaterialName): number {
    return pow2(Math.max(32, Math.round(SPEC[name].size * tier.scale)));
  }

  function track<T extends THREE.Texture>(tex: T): T {
    textures.push(tex);
    return tex;
  }

  function buildMaps(name: MaterialName, baked: Baked, size: number): MaterialMaps {
    const maps: MaterialMaps = {};
    if (baked.albedo) {
      maps.map = track(
        rasterTexture(baked.albedo, size, { srgb: true, anisotropy: aniso, name: `kart/${name}/albedo` }),
      );
    }
    if (baked.height) {
      const strength = (baked.normalStrength ?? 1) * NORMAL_GAIN;
      maps.normalMap = track(
        rasterTexture(normalFromHeight(baked.height, size, strength), size, {
          anisotropy: aniso,
          name: `kart/${name}/normal`,
        }),
      );
    }
    const rough: Field | number = baked.roughness ?? 0.8;
    const metal: Field | number = baked.metalness ?? 0;
    const occl: Field | number = baked.ao ?? 1;
    maps.ormMap = track(
      rasterTexture(packORM(size, occl, rough, metal), size, {
        anisotropy: Math.min(aniso, 4),
        name: `kart/${name}/orm`,
      }),
    );
    if (baked.emissive) {
      maps.emissiveMap = track(
        rasterTexture(baked.emissive, size, { srgb: true, anisotropy: aniso, name: `kart/${name}/emissive` }),
      );
    }
    return maps;
  }

  /** Standard PBR body shared by nearly everything. */
  function std(
    name: MaterialName,
    maps: MaterialMaps,
    o: StdParams = {},
  ): THREE.MeshStandardMaterial {
    const { normalScale, ...rest } = o;
    const mat = new THREE.MeshStandardMaterial({
      name: `kart/${name}`,
      map: maps.map ?? null,
      normalMap: maps.normalMap ?? null,
      // One packed texture, three slots. `roughness`/`metalness` stay at 1 so
      // the map is the value rather than a multiplier on some other guess.
      aoMap: maps.ormMap ?? null,
      roughnessMap: maps.ormMap ?? null,
      metalnessMap: maps.ormMap ?? null,
      roughness: 1,
      metalness: 1,
      aoMapIntensity: 1,
      ...rest,
    });
    if (maps.normalMap) mat.normalScale.set(normalScale ?? 1, normalScale ?? 1);
    return mat;
  }

  function phys(
    name: MaterialName,
    maps: MaterialMaps,
    o: PhysParams = {},
  ): THREE.MeshPhysicalMaterial {
    const { normalScale, ...rest } = o;
    const mat = new THREE.MeshPhysicalMaterial({
      name: `kart/${name}`,
      map: maps.map ?? null,
      normalMap: maps.normalMap ?? null,
      aoMap: maps.ormMap ?? null,
      roughnessMap: maps.ormMap ?? null,
      metalnessMap: maps.ormMap ?? null,
      roughness: 1,
      metalness: 1,
      ...rest,
    });
    if (maps.normalMap) mat.normalScale.set(normalScale ?? 1, normalScale ?? 1);
    return mat;
  }

  /**
   * Dual-scroll normals + a fresnel horizon tint, patched into the standard
   * physical shader. Deliberately conservative: one extra texture fetch and a
   * pow, no derivatives beyond three's own, nothing that needs an extension.
   */
  function patchWater(mat: THREE.MeshPhysicalMaterial): void {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uScrollA = waterScrollA;
      shader.uniforms.uScrollB = waterScrollB;
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "void main() {",
          "uniform vec2 uScrollA;\nuniform vec2 uScrollB;\nvoid main() {",
        )
        .replace(
          "#include <normal_fragment_maps>",
          /* glsl */ `
          #ifdef USE_NORMALMAP_TANGENTSPACE
            vec3 wnA = texture2D( normalMap, vNormalMapUv + uScrollA ).xyz * 2.0 - 1.0;
            vec3 wnB = texture2D( normalMap, vNormalMapUv * 2.17 + uScrollB ).xyz * 2.0 - 1.0;
            // Whiteout blend: add the slopes, multiply the vertical term. Two
            // wave trains at different scales and speeds is the whole illusion.
            vec3 mapN = normalize( vec3( wnA.xy + wnB.xy, wnA.z * wnB.z ) );
            mapN.xy *= normalScale;
            normal = normalize( tbn * mapN );
          #endif
          `,
        )
        .replace(
          "#include <emissivemap_fragment>",
          /* glsl */ `
          #include <emissivemap_fragment>
          // Grazing angles pick up the sky. Without this the far end of a lake
          // goes flat and dark, which is the classic giveaway of fake water.
          float wFres = pow( 1.0 - saturate( dot( normalize( vViewPosition ), normal ) ), 4.0 );
          totalEmissiveRadiance += vec3( 0.26, 0.42, 0.55 ) * wFres * 0.45;
          `,
        );
    };
    // A patched shader needs its own program key or three will reuse the
    // unpatched physical program from another material.
    mat.customProgramCacheKey = () => "kart-water-v1";
  }

  function build(name: MaterialName, maps: MaterialMaps): THREE.Material {
    switch (name) {
      case "asphalt":
      case "asphaltWorn":
        // Double-sided, and not for looks: the ground is the one surface a
        // player can ever get underneath — clip the camera below the track on
        // a landing and a front-sided road simply is not there, so you see the
        // void through the floor of the world. Backfaces cost almost nothing
        // here (the depth buffer rejects them immediately) and the guarantee
        // is worth more than the saving.
        return std(name, maps, {
          envMapIntensity: 0.5,
          normalScale: 1,
          dithering: true,
          side: THREE.DoubleSide,
        });

      case "kerb":
        return std(name, maps, { envMapIntensity: 0.6, normalScale: 1 });

      case "roadLine":
      case "startLine":
        // Painted decals sit a millimetre above the road; the offset keeps them
        // out of a z-fight without any geometry lift.
        return std(name, maps, {
          envMapIntensity: 0.5,
          normalScale: 0.9,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        });

      case "boostPad": {
        const mat = std(name, maps, {
          envMapIntensity: 0.7,
          normalScale: 1,
          emissive: new THREE.Color(0xffffff),
          emissiveMap: maps.emissiveMap ?? null,
          emissiveIntensity: 1.5,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        });
        animated.boostPad = mat;
        return mat;
      }

      case "grass":
      case "dirt":
      case "sand":
        // Same reasoning as the asphalt above: the world must have a floor
        // from underneath as well as from on top.
        return std(name, maps, { envMapIntensity: 0.4, normalScale: 1, side: THREE.DoubleSide });

      case "water": {
        const mat = phys(name, maps, {
          color: new THREE.Color(0x2e93d9),
          transparent: true,
          opacity: 0.86,
          metalness: 0,
          roughness: 1,
          ior: 1.33,
          clearcoat: 0.4,
          clearcoatRoughness: 0.08,
          envMapIntensity: 1.25,
          normalScale: 1.4,
          depthWrite: true,
          side: THREE.FrontSide,
        });
        patchWater(mat);
        return mat;
      }

      case "ice":
        return phys(name, maps, {
          color: new THREE.Color(0xd8f0fa),
          metalness: 0,
          roughness: 1,
          clearcoat: 1,
          clearcoatRoughness: 0.05,
          ior: 1.31,
          envMapIntensity: 1.4,
          normalScale: 0.8,
        });

      case "wood":
        return std(name, maps, { envMapIntensity: 0.45, normalScale: 1 });

      case "metal":
        return std(name, maps, { envMapIntensity: 1.1, normalScale: 0.9 });

      case "chrome":
        return std(name, maps, { envMapIntensity: 1.7, normalScale: 0.6, color: new THREE.Color(0xffffff) });

      case "grate":
        return std(name, maps, {
          envMapIntensity: 1,
          normalScale: 1,
          transparent: false,
          alphaTest: 0.5,
          side: THREE.DoubleSide,
        });

      case "concrete":
      case "brick":
      case "stone":
        return std(name, maps, { envMapIntensity: 0.45, normalScale: 1 });

      case "rubber":
        return std(name, maps, { envMapIntensity: 0.3, normalScale: 1 });

      case "carPaint":
        return makeCarPaint(maps, 0xffffff, 0xffffff);

      case "glass":
        return phys(name, maps, {
          color: new THREE.Color(0xbfe2ef),
          transparent: true,
          opacity: 0.34,
          metalness: 0,
          roughness: 1,
          clearcoat: 1,
          clearcoatRoughness: 0.03,
          ior: 1.5,
          envMapIntensity: 1.6,
          normalScale: 0.35,
          side: THREE.FrontSide,
        });

      case "plastic":
        return phys(name, maps, {
          color: new THREE.Color(0xffffff),
          metalness: 0,
          roughness: 1,
          clearcoat: 0.45,
          clearcoatRoughness: 0.2,
          envMapIntensity: 0.9,
          normalScale: 0.6,
        });

      case "foliage":
        return std(name, maps, {
          envMapIntensity: 0.5,
          normalScale: 0.9,
          alphaTest: 0.5,
          side: THREE.DoubleSide,
        });

      case "bark":
        return std(name, maps, { envMapIntensity: 0.35, normalScale: 1.1 });

      case "cloth":
        return phys(name, maps, {
          metalness: 0,
          roughness: 1,
          // Sheen is the cheapest thing that makes fabric read as fabric.
          sheen: 0.6,
          sheenRoughness: 0.85,
          sheenColor: new THREE.Color(0xffffff),
          envMapIntensity: 0.5,
          normalScale: 0.9,
        });

      case "banner":
        return std(name, maps, { envMapIntensity: 0.4, normalScale: 0.8, side: THREE.DoubleSide });

      case "neon": {
        const mat = std(name, maps, {
          envMapIntensity: 0.6,
          normalScale: 0.7,
          emissive: new THREE.Color(0xffffff),
          emissiveMap: maps.emissiveMap ?? null,
          emissiveIntensity: 2.0,
        });
        animated.neon = mat;
        return mat;
      }

      case "antigrav": {
        const mat = std(name, maps, {
          envMapIntensity: 1,
          normalScale: 1,
          emissive: new THREE.Color(0x35e8ff),
          emissiveMap: maps.emissiveMap ?? null,
          emissiveIntensity: 1.3,
        });
        animated.antigrav = mat;
        return mat;
      }

      case "crowd":
        return std(name, maps, {
          envMapIntensity: 0.35,
          normalScale: 0.7,
          alphaTest: 0.4,
          side: THREE.DoubleSide,
        });

      default:
        return std(name, maps, { envMapIntensity: 0.5, normalScale: 1 });
    }
  }

  /**
   * Car paint. Clearcoat over a flake-metallic base: the flake normal is fed to
   * the *base* normal only, so the clearcoat stays glassy over it — which is
   * exactly how a real two-stage paint behaves and why it sparkles without
   * looking rough.
   */
  function makeCarPaint(maps: MaterialMaps, color: number, accent: number): THREE.MeshPhysicalMaterial {
    const mat = new THREE.MeshPhysicalMaterial({
      name: "kart/carPaint",
      color: new THREE.Color(color),
      map: maps.map ?? null,
      normalMap: maps.normalMap ?? null,
      aoMap: maps.ormMap ?? null,
      roughnessMap: maps.ormMap ?? null,
      metalnessMap: maps.ormMap ?? null,
      roughness: 1,
      metalness: 1,
      clearcoat: 1,
      clearcoatRoughness: 0.045,
      envMapIntensity: 1.35,
      // The accent tints the dielectric specular, so a highlight on a red kart
      // carries a breath of its trim colour rather than being pure white.
      specularColor: new THREE.Color(accent),
      specularIntensity: 1,
    });
    if (maps.normalMap) mat.normalScale.set(0.55, 0.55);
    return mat;
  }

  function bakeOne(name: MaterialName): Entry {
    const size = sizeOf(name);
    const input: BakeInput = { size, ao: tier.ao, rng: makeRng(`kart:${name}`) };
    let baked: Baked;
    try {
      baked = BAKERS[name](input);
    } catch (err) {
      // A failed bake costs one surface's detail, never the race.
      console.error(`[Vibe Kart] material "${name}" failed to bake:`, err);
      baked = { roughness: 0.8, metalness: 0 };
    }
    const maps = buildMaps(name, baked, size);
    const material = build(name, maps);
    materials.push(material);
    envUsers.push(material);
    if (envMap) applyEnv(material, envMap);
    return { maps, material };
  }

  function ensure(name: MaterialName): Entry {
    let e = entries.get(name);
    if (!e) entries.set(name, (e = bakeOne(name)));
    return e;
  }

  function applyEnv(mat: THREE.Material, env: THREE.Texture | null): void {
    const m = mat as THREE.MeshStandardMaterial;
    if (!("envMap" in m)) return;
    m.envMap = env;
    m.needsUpdate = true;
  }

  // -- the public surface ----------------------------------------------------

  const lib: MaterialLibrary = {
    get(name) {
      return ensure(name).material;
    },

    carPaint(color, accent) {
      const key = `${color >>> 0}:${(accent ?? color) >>> 0}`;
      const hit = paints.get(key);
      if (hit) return hit;
      const maps = ensure("carPaint").maps;
      const mat = makeCarPaint(maps, color, accent ?? 0xffffff);
      if (envMap) applyEnv(mat, envMap);
      paints.set(key, mat);
      materials.push(mat);
      envUsers.push(mat);
      return mat;
    },

    texture(name, repeat) {
      const base = ensure(name).maps.map;
      // A material with no albedo (there are none today, but a future one may
      // be pure ORM) still owes the caller something samplable.
      const src = base ?? ensure(name).maps.ormMap!;
      if (repeat === undefined || repeat === 1) return src;
      const key = `${name}:${repeat}`;
      const hit = clones.get(key);
      if (hit) return hit;
      // Clones share the underlying source, so this costs no extra upload.
      const tex = src.clone();
      tex.repeat.set(repeat, repeat);
      tex.needsUpdate = true;
      clones.set(key, tex);
      textures.push(tex);
      return tex;
    },

    tileSize(name) {
      return SPEC[name].tile;
    },

    tiled(name, metresU, metresV) {
      const tile = SPEC[name].tile;
      const ru = Math.max(0.01, metresU / tile);
      const rv = Math.max(0.01, (metresV ?? metresU) / tile);
      const key = `${name}:${ru.toFixed(3)}x${rv.toFixed(3)}`;
      const hit = clones.get(key);
      if (hit) return hit;
      const src = ensure(name).maps.map ?? ensure(name).maps.ormMap!;
      const tex = src.clone();
      tex.repeat.set(ru, rv);
      tex.needsUpdate = true;
      clones.set(key, tex);
      textures.push(tex);
      return tex;
    },

    maps(name) {
      return ensure(name).maps;
    },

    update(dt, elapsed) {
      void dt;
      // Two wave trains, deliberately non-harmonic speeds so the surface never
      // resolves into a repeating pulse.
      waterScrollA.value.set(elapsed * 0.014, elapsed * 0.021);
      waterScrollB.value.set(-elapsed * 0.019, elapsed * 0.0075);

      const boost = animated.boostPad;
      if (boost) {
        const map = boost.emissiveMap;
        // Chevrons fly forward, one full chevron every ~0.55 s.
        if (map) map.offset.y = -((elapsed * 0.45) % 1);
        // Kept well under the point where ACES clips the orange to white: the
        // bloom pass is what makes a boost pad look hot, not raw intensity.
        boost.emissiveIntensity = 1.4 + Math.sin(elapsed * 7.5) * 0.25;
      }

      const neon = animated.neon;
      if (neon) {
        // Mains hum plus a slow starter flicker — a perfectly steady neon sign
        // is the one thing real neon never is.
        const hum = Math.sin(elapsed * 12.6) * 0.05;
        const flick = Math.sin(elapsed * 1.7) * Math.sin(elapsed * 4.3) > 0.985 ? -0.5 : 0;
        neon.emissiveIntensity = 2.0 + hum + flick;
      }

      const anti = animated.antigrav;
      if (anti) {
        const t = 0.5 + 0.5 * Math.sin(elapsed * 1.9);
        anti.emissiveIntensity = 1.05 + t * 0.6;
        // Cyan breathing towards magenta: the plating tells you the gravity is
        // doing something, without a single extra draw call.
        anti.emissive.setRGB(
          clamp01(0.2 + t * 0.55),
          clamp01(0.9 - t * 0.35),
          1,
        );
      }
    },

    setEnvMap(env) {
      envMap = env;
      for (const m of envUsers) applyEnv(m, env);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const t of textures) t.dispose();
      for (const m of materials) m.dispose();
      textures.length = 0;
      materials.length = 0;
      envUsers.length = 0;
      entries.clear();
      clones.clear();
      paints.clear();
      clearNoiseCaches();
    },

    names,

    get ready() {
      return ready;
    },
  };

  /**
   * Bake everything, yielding between materials so the loading bar paints.
   * Ordered so the surfaces the first frame needs exist first — if a later
   * system asks for something out of order, `ensure` just bakes it early.
   */
  async function bakeAll(onProgress?: (done: number, total: number) => void): Promise<void> {
    const order: MaterialName[] = [
      "asphalt", "kerb", "grass", "roadLine", "startLine", "boostPad",
      "asphaltWorn", "dirt", "sand", "concrete", "stone", "brick",
      "carPaint", "chrome", "rubber", "plastic", "glass", "metal",
      "wood", "grate", "water", "ice", "antigrav", "neon",
      "foliage", "bark", "cloth", "banner", "crowd",
    ];
    for (let i = 0; i < order.length; i++) {
      if (disposed) return;
      ensure(order[i]);
      onProgress?.(i + 1, order.length);
      // A macrotask, not a microtask: rAF and layout need a chance to run or
      // the loading screen freezes for the whole bake.
      await new Promise((r) => setTimeout(r, 0));
    }
    ready = true;
    // The lattice tables are worth tens of megabytes and are dead after boot.
    clearNoiseCaches();
  }

  return Object.assign(lib, { bakeAll });
}

/** Convenience for tests and tooling: bake one material's raw channels. */
export function bakeMaterial(name: MaterialName, size: number, ao = true): Baked {
  return BAKERS[name]({ size, ao, rng: makeRng(`kart:${name}`) });
}

export type { Raster, Field };
