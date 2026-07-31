/**
 * Vibe Kart — the model system's material desk.
 *
 * Two jobs.
 *
 * **1. Talk to the material library without importing it.** Systems publish
 * handles on `ctx.services`; they never import each other. So the library is
 * consumed through a structural interface declared right here, and if it is
 * missing — a failed bake, a boot order change, a unit test — the desk hands
 * out its own honest fallbacks instead of throwing. A kart with slightly duller
 * paint is a bad frame; a kart that throws is a missing racer.
 *
 * **2. Keep eight fully dressed karts down to a few dozen materials.** One kit
 * per *character*, cached: paint, accent, chrome, rubber, glass, dark plastic,
 * skin, outfit, trim. Only the three things that must animate independently per
 * racer — the face atlas, the brake lights and the exhaust glow — are cloned per
 * rig, and those are tiny. Everything else is shared by reference.
 */
import * as THREE from "three";
import type { KartCtx, KartQuality } from "../types";
import type { RacerLook } from "./roster";
import { bakeFaceAtlas, bakeLivery, bakeNumberPlate, type FaceAtlas } from "./textures";

/**
 * The slice of the material library this module uses. Declared locally and
 * duck-typed at runtime so `models` has zero build-time coupling to `materials`.
 */
interface MaterialSource {
  get(name: string): THREE.Material;
  carPaint(color: number, accent?: number): THREE.Material;
}

function isMaterialSource(v: unknown): v is MaterialSource {
  if (!v || typeof v !== "object") return false;
  const o = v as Partial<MaterialSource>;
  return typeof o.get === "function" && typeof o.carPaint === "function";
}

/** Texture resolution per quality tier, as a multiplier on the authored size. */
const TEX_SCALE: Record<KartQuality, number> = { low: 0.3, medium: 0.55, high: 1, ultra: 1.15 };

export interface ModelQuality {
  tier: KartQuality;
  faceCell: number;
  liverySize: number;
  plateSize: number;
  /** Bake a per-character livery at all. */
  livery: boolean;
  /** Segment counts scale with the tier so `low` ships a lighter mesh. */
  detail: number;
  /** Real shadow casters, on top of the always-present contact blob. */
  castShadows: boolean;
  /** The scarf simulation and the second rim material. */
  frills: boolean;
}

export function modelQuality(tier: KartQuality): ModelQuality {
  const s = TEX_SCALE[tier];
  const round8 = (v: number) => Math.max(32, Math.round(v / 8) * 8);
  return {
    tier,
    faceCell: round8(256 * s),
    liverySize: round8(512 * s),
    plateSize: round8(256 * s),
    livery: tier !== "low",
    detail: tier === "low" ? 0.6 : tier === "medium" ? 0.8 : 1,
    castShadows: tier !== "low",
    frills: tier !== "low",
  };
}

// ---------------------------------------------------------------------------
// Fallback library
// ---------------------------------------------------------------------------

/**
 * Stand-in surfaces for the case where the material library never published.
 * Deliberately not grey lambert placeholders — if this path ever ships in a
 * screenshot it still has to look like a game.
 */
function makeFallback(owned: THREE.Material[]): MaterialSource {
  const cache = new Map<string, THREE.Material>();
  const paints = new Map<string, THREE.Material>();

  const std = (params: THREE.MeshStandardMaterialParameters) => {
    const m = new THREE.MeshStandardMaterial(params);
    owned.push(m);
    return m;
  };

  return {
    get(name) {
      const hit = cache.get(name);
      if (hit) return hit;
      let mat: THREE.Material;
      switch (name) {
        case "chrome":
          mat = std({ color: 0xf2f5f8, metalness: 1, roughness: 0.14, envMapIntensity: 1.6 });
          break;
        case "rubber":
          mat = std({ color: 0x1c1e23, metalness: 0, roughness: 0.82 });
          break;
        case "glass":
          mat = new THREE.MeshPhysicalMaterial({
            color: 0xbfe2ef,
            transparent: true,
            opacity: 0.34,
            roughness: 0.05,
            metalness: 0,
            clearcoat: 1,
          });
          owned.push(mat);
          break;
        case "plastic":
          mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0, clearcoat: 0.4 });
          owned.push(mat);
          break;
        case "cloth":
          mat = std({ color: 0xffffff, roughness: 0.92, metalness: 0 });
          break;
        case "metal":
          mat = std({ color: 0x9aa4ad, metalness: 0.9, roughness: 0.38 });
          break;
        default:
          mat = std({ color: 0xcccccc, roughness: 0.7, metalness: 0 });
      }
      cache.set(name, mat);
      return mat;
    },

    carPaint(color, accent) {
      const key = `${color}:${accent ?? color}`;
      const hit = paints.get(key);
      if (hit) return hit;
      const mat = new THREE.MeshPhysicalMaterial({
        color,
        metalness: 0.25,
        roughness: 0.32,
        clearcoat: 1,
        clearcoatRoughness: 0.05,
        envMapIntensity: 1.3,
      });
      owned.push(mat);
      paints.set(key, mat);
      return mat;
    },
  };
}

// ---------------------------------------------------------------------------
// The desk
// ---------------------------------------------------------------------------

export interface CharacterKit {
  /** Body paint carrying the character's livery. */
  paint: THREE.Material;
  /** Pods, spoiler, wing — accent-coloured paint. */
  accent: THREE.Material;
  /** Small painted details in the third colour. */
  trim: THREE.Material;
  chrome: THREE.Material;
  rubber: THREE.Material;
  glass: THREE.Material;
  /** Seat, dashboard, bumpers, floor tray. */
  dark: THREE.Material;
  /** Rim faces, painted to match the accent. */
  rim: THREE.Material;
  /** Driver racing suit. */
  outfit: THREE.Material;
  /** Helmet / cap / boots / gloves. */
  gear: THREE.Material;
  /** Scarf and other cloth. */
  cloth: THREE.Material;
  face: FaceAtlas;
}

export interface RigMaterials {
  /** Face material — cloned per rig so two racers can blink independently. */
  head: THREE.MeshStandardMaterial;
  headTexture: THREE.Texture;
  plate: THREE.MeshStandardMaterial;
  brake: THREE.MeshStandardMaterial;
  headlight: THREE.MeshStandardMaterial;
  exhaust: THREE.MeshStandardMaterial;
}

export interface MaterialDesk {
  quality: ModelQuality;
  kitFor(look: RacerLook): CharacterKit;
  rigMaterials(look: RacerLook, kit: CharacterKit, number: number): RigMaterials;
  /** Blob-shadow material, shared by the whole field. */
  shadowMaterial(map: THREE.Texture): THREE.Material;
  /** Re-point every material we own at the scene's current environment map. */
  update(): void;
  dispose(): void;
}

/** Tinted clone of a shared library material. Textures stay shared. */
function tint(src: THREE.Material, color: number, owned: THREE.Material[], patch?: (m: THREE.Material) => void): THREE.Material {
  const m = src.clone();
  const c = m as unknown as { color?: THREE.Color };
  if (c.color) c.color.set(color);
  patch?.(m);
  owned.push(m);
  return m;
}

export function createMaterialDesk(ctx: KartCtx): MaterialDesk {
  const owned: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];
  const quality = modelQuality(ctx.quality);

  let appliedEnv: THREE.Texture | null = null;
  let envCursor = 0;
  const applyEnv = (m: THREE.Material) => {
    // Only the PBR family: an equirect PMREM handed to a MeshBasicMaterial is
    // interpreted as a reflection map and comes out as garbage.
    if (!(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) return;
    const s = m as THREE.MeshStandardMaterial;
    if (s.envMap === appliedEnv) return;
    s.envMap = appliedEnv;
    s.needsUpdate = true;
  };

  const src: MaterialSource = isMaterialSource(ctx.services.materials)
    ? (ctx.services.materials as MaterialSource)
    : makeFallback(owned);

  const kits = new Map<string, CharacterKit>();
  const trims = new Map<string, THREE.Material>();

  /**
   * Body paint. The library's car paint is a flake-metallic base under a
   * clearcoat; we keep its normal and ORM maps (that is where the sparkle
   * lives) and swap the albedo for the character's livery, tiling the flake
   * normal up so it stays microscopic on a metre-long panel instead of being
   * stretched into a lava lamp.
   */
  function paintWithLivery(look: RacerLook): THREE.Material {
    const base = src.carPaint(look.preset.colors.body, look.preset.colors.accent);
    if (!quality.livery) return base;
    let livery: THREE.CanvasTexture | null = null;
    try {
      livery = bakeLivery(look, quality.liverySize);
    } catch (err) {
      // A canvas failure costs a livery, not a kart.
      console.warn("[kart/models] livery bake failed:", err);
      return base;
    }
    textures.push(livery);
    const mat = base.clone() as THREE.MeshStandardMaterial;
    mat.name = `kart/paint/${look.preset.id}`;
    mat.map = livery;
    if (mat.color) mat.color.set(0xffffff);
    if (mat.normalMap) {
      const n = mat.normalMap.clone();
      n.wrapS = n.wrapT = THREE.RepeatWrapping;
      n.repeat.set(5, 5);
      n.needsUpdate = true;
      textures.push(n);
      mat.normalMap = n;
    }
    // The ORM's occlusion channel was authored for a tiling panel, not for a
    // whole car; keeping it here just dims the wrap.
    mat.aoMap = null;
    owned.push(mat);
    return mat;
  }

  /**
   * Painted parts other than the body.
   *
   * The library's car paint tiles its flake normal over 1.5 m, and a spoiler
   * endplate is 0.3 m of sphere-mapped UV — so straight off the shelf the flake
   * stretches into golf-ball dimples. A clone with the normal tiled up fixes it
   * and costs nothing: the texture is shared, only the repeat differs.
   */
  function trimPaint(color: number, accent: number): THREE.Material {
    const key = `trim:${color}:${accent}`;
    const hit = trims.get(key);
    if (hit) return hit;
    const mat = src.carPaint(color, accent).clone() as THREE.MeshStandardMaterial;
    if (mat.normalMap) {
      const n = mat.normalMap.clone();
      n.wrapS = n.wrapT = THREE.RepeatWrapping;
      n.repeat.set(6, 6);
      n.needsUpdate = true;
      textures.push(n);
      mat.normalMap = n;
    }
    mat.aoMap = null;
    owned.push(mat);
    trims.set(key, mat);
    return mat;
  }

  function buildKit(look: RacerLook): CharacterKit {
    const c = look.preset.colors;
    const d = look.preset.driver;
    const chrome = src.get("chrome");
    const glass = src.get("glass");
    const plastic = src.get("plastic");
    const cloth = src.get("cloth");
    // Tyre rubber: the shared pebble grain is right for a mudflap and much too
    // loud for a wheel filling a quarter of the screen at the start line.
    const rubber = tint(src.get("rubber"), 0x1d2026, owned, (m) => {
      const s = m as THREE.MeshStandardMaterial;
      if (s.normalScale) s.normalScale.set(0.4, 0.4);
    });

    let face: FaceAtlas;
    try {
      face = bakeFaceAtlas(look, quality.faceCell);
    } catch (err) {
      console.warn("[kart/models] face bake failed:", err);
      // A flat head is better than no driver: an empty 1×1 white texture keeps
      // the material valid and the skin tint does the rest.
      const data = new Uint8Array([255, 255, 255, 255]);
      const tex = new THREE.DataTexture(data, 1, 1);
      tex.needsUpdate = true;
      face = { texture: tex as unknown as THREE.CanvasTexture, repeat: { x: 1, y: 1 } };
    }
    textures.push(face.texture);

    const kit: CharacterKit = {
      paint: paintWithLivery(look),
      accent: trimPaint(c.accent, c.body),
      trim: trimPaint(c.trim, c.accent),
      chrome,
      rubber,
      glass,
      dark: tint(plastic, 0x24272e, owned, (m) => {
        const p = m as THREE.MeshPhysicalMaterial;
        if (p.isMeshPhysicalMaterial) p.clearcoat = 0.25;
      }),
      rim: trimPaint(c.accent, c.trim),
      outfit: tint(plastic, d.outfit, owned, (m) => {
        const p = m as THREE.MeshPhysicalMaterial;
        // A racing suit is fabric with a shell over it: low clearcoat, not none.
        if (p.isMeshPhysicalMaterial) p.clearcoat = 0.18;
      }),
      gear: tint(plastic, d.hat, owned),
      cloth: tint(cloth, 0xffffff, owned),
      face,
    };
    return kit;
  }

  return {
    quality,

    kitFor(look) {
      let kit = kits.get(look.preset.id);
      if (!kit) kits.set(look.preset.id, (kit = buildKit(look)));
      return kit;
    },

    rigMaterials(look, kit, number) {
      // Per-rig face texture: a clone shares the GPU upload but gets its own
      // offset, so eight racers blink and grimace on their own schedules.
      const headTexture = kit.face.texture.clone();
      headTexture.needsUpdate = true;
      headTexture.repeat.set(kit.face.repeat.x, kit.face.repeat.y);
      headTexture.offset.copy(kit.face.texture.offset);
      textures.push(headTexture);

      const head = new THREE.MeshStandardMaterial({
        name: `kart/head/${look.preset.id}`,
        map: headTexture,
        roughness: 0.62,
        metalness: 0,
        envMapIntensity: 0.55,
      });

      let plateMap: THREE.Texture | null = null;
      try {
        plateMap = bakeNumberPlate(number, look.preset.colors, quality.plateSize);
        textures.push(plateMap);
      } catch {
        plateMap = null;
      }
      const plate = new THREE.MeshStandardMaterial({
        name: "kart/plate",
        map: plateMap,
        color: plateMap ? 0xffffff : look.preset.colors.trim,
        roughness: 0.45,
        metalness: 0,
        envMapIntensity: 0.7,
      });

      const brake = new THREE.MeshStandardMaterial({
        name: "kart/tailLight",
        color: 0x2a0505,
        emissive: new THREE.Color(0xff2a14),
        emissiveIntensity: 0.85,
        roughness: 0.22,
        metalness: 0,
        // Lens plastic: the bloom pass is what makes these read as lit, so the
        // intensity is kept low enough that ACES never clips them to white.
        envMapIntensity: 1.1,
      });

      const headlight = new THREE.MeshStandardMaterial({
        name: "kart/headLight",
        color: 0xfff8e8,
        // Low enough that ACES keeps a lens shape instead of a white blob; the
        // bloom pass is what makes a headlight read as lit.
        emissive: new THREE.Color(0xffdfa0),
        emissiveIntensity: 0.55,
        roughness: 0.12,
        metalness: 0,
        envMapIntensity: 1.4,
      });

      const exhaust = new THREE.MeshStandardMaterial({
        name: "kart/exhaustGlow",
        color: 0x120a08,
        emissive: new THREE.Color(0xff7a22),
        emissiveIntensity: 0.35,
        roughness: 0.55,
        metalness: 0.6,
      });

      owned.push(head, plate, brake, headlight, exhaust);
      return { head, headTexture, plate, brake, headlight, exhaust };
    },

    /**
     * The material library re-points its *own* materials when the environment
     * probe changes, but it has never heard of our clones — and a clearcoat
     * car paint with no environment to reflect renders as a black slab. So we
     * keep our own list in step. `envCursor` means a material created on frame
     * 900 still gets the map without re-walking the whole list every frame.
     */
    update() {
      const env = ctx.services.env?.envMap ?? null;
      const changed = env !== appliedEnv;
      if (!changed && envCursor >= owned.length) return;
      appliedEnv = env;
      for (let i = changed ? 0 : envCursor; i < owned.length; i++) applyEnv(owned[i]);
      envCursor = owned.length;
    },

    shadowMaterial(map) {
      const mat = new THREE.MeshBasicMaterial({
        name: "kart/contactShadow",
        map,
        color: 0x000000,
        transparent: true,
        depthWrite: false,
        // Under the kart and over the road: the offset keeps it off the tarmac
        // without needing a geometry lift that would break on banked corners.
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
        toneMapped: false,
        vertexColors: true,
      });
      // Per-instance fade. `vertexColors` on an InstancedMesh feeds instanceColor
      // into vColor, and three multiplies it into the *rgb*; a black shadow
      // ignores that entirely, so the red channel is repurposed as alpha.
      mat.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <color_fragment>",
          "#ifdef USE_COLOR\n  diffuseColor.a *= vColor.r;\n#endif",
        );
      };
      mat.customProgramCacheKey = () => "kart-contact-shadow-v1";
      owned.push(mat);
      return mat;
    },

    dispose() {
      for (const t of textures) t.dispose();
      for (const m of owned) m.dispose();
      textures.length = 0;
      owned.length = 0;
      kits.clear();
      trims.clear();
    },
  };
}
