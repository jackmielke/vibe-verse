/**
 * Vibe Kart — the scenery material set.
 *
 * Eleven materials dress the entire circuit. That number is the whole design:
 * every merged prop carries its paint job in vertex colours and multiplies it
 * against one shared *painted-surface* material, so a marshal post, a barrier,
 * a windmill and a castle are the same material with different vertices. Colour
 * variety is free; a new material is a new shader program and is not.
 *
 * Where the shared library (`ctx.services.materials`) already has the right
 * surface — rubber for tyre walls, metal for truss work — we borrow it rather
 * than bake a second copy. Borrowed materials are never mutated and never
 * disposed here; a missing library just falls through to a local bake, because
 * a system that failed to boot must cost detail and nothing else.
 */
import * as THREE from "three";
import type { KartQuality } from "../types";
import {
  bakeFabric,
  bakeFlagAtlas,
  bakeFoliage,
  bakeGantryBanner,
  bakeGlow,
  bakeGrassCard,
  bakePainted,
  bakeRock,
  bakeSponsorAtlas,
  bakeStripes,
  textureScale,
  FLAG_GRID,
  SPONSOR_GRID,
} from "./textures";
import { Resources } from "./util";
import { patchScenery, depthTwin, type SceneryUniforms } from "./wind";

/**
 * The slice of the material library we use. Declared structurally rather than
 * imported: `types.ts` is shared law and the library's own module belongs to
 * another agent, so we describe the shape we need and duck-type against it.
 */
interface BorrowedLibrary {
  get(name: string): THREE.Material;
}

function borrow(services: Record<string, unknown>, name: string): THREE.Material | null {
  const lib = services.materials as BorrowedLibrary | undefined;
  if (!lib || typeof lib.get !== "function") return null;
  try {
    const m = lib.get(name);
    return m && (m as THREE.Material).isMaterial ? m : null;
  } catch {
    return null;
  }
}

export interface SceneryMaterials {
  /** Vertex-coloured painted surface. Backs nearly every merged prop. */
  painted: THREE.MeshStandardMaterial;
  /** Same, but unlit-ish and emissive — signage faces, lit bulbs, rim lights. */
  glow: THREE.MeshStandardMaterial;
  /** Cloth for canopies, banners, bunting. Vertex-coloured, sheened, two-sided. */
  fabric: THREE.MeshStandardMaterial;
  /** Rock for hills, mesas and cliffs. */
  rock: THREE.MeshStandardMaterial;
  /** Distant landmass — flat-shaded, cheap, fog does the work. */
  distant: THREE.MeshStandardMaterial;
  /** Foliage cards, one per species. Alpha-tested, two-sided, wind-patched. */
  leafBroadleaf: THREE.MeshStandardMaterial;
  leafConifer: THREE.MeshStandardMaterial;
  leafPalm: THREE.MeshStandardMaterial;
  leafBush: THREE.MeshStandardMaterial;
  grass: THREE.MeshStandardMaterial;
  /** Trunks — plain, but wind-patched so the canopy does not shear off. */
  bark: THREE.MeshStandardMaterial;
  /** Spectators: vertex-coloured, shirt hue chosen in the shader. */
  crowd: THREE.MeshStandardMaterial;
  /** Circling birds: wings hinge in the vertex shader off `instanceColor.r`. */
  bird: THREE.MeshStandardMaterial;
  /** 4×4 sponsor atlas, cell picked per instance. */
  sponsor: THREE.MeshStandardMaterial;
  /** 2×2 flag atlas plus a ripple. */
  flag: THREE.MeshStandardMaterial;
  /** Striped inflatable skin with a whip animation. */
  dancer: THREE.MeshStandardMaterial;
  /** The start/finish banner artwork. */
  banner: THREE.MeshStandardMaterial;
  /** Additive sprite sheet for bulbs and lamp haloes. */
  halo: THREE.SpriteMaterial;
  /** Water for the lake. Borrowed when the library has it. */
  water: THREE.Material;
  /** Depth twins for the animated alpha-cut kinds. */
  depth: {
    broadleaf: THREE.Material;
    conifer: THREE.Material;
    palm: THREE.Material;
    bush: THREE.Material;
  } | null;
}

export function createSceneryMaterials(
  quality: KartQuality,
  services: Record<string, unknown>,
  u: SceneryUniforms,
  res: Resources,
): SceneryMaterials {
  const s = textureScale(quality);
  const px = (base: number) => Math.max(32, Math.round(base * s));
  const shadows = quality === "high" || quality === "ultra";

  const painted = bakePainted(px(256));
  const fabric = bakeFabric(px(256));
  const rock = bakeRock(px(256));
  const sponsorAtlas = bakeSponsorAtlas(px(1024));
  const flagAtlas = bakeFlagAtlas(px(512));
  const bannerArt = bakeGantryBanner(px(1024));
  const grassCard = bakeGrassCard(px(256));
  const leaves = {
    broadleaf: bakeFoliage(px(256), "broadleaf"),
    conifer: bakeFoliage(px(256), "conifer"),
    palm: bakeFoliage(px(256), "palm"),
    bush: bakeFoliage(px(256), "bush"),
  };
  const glowTex = bakeGlow(64);
  const stripeTex = bakeStripes(px(128), 0xff2f24, 0xffd21f, 8);

  for (const set of [painted, fabric, rock, sponsorAtlas, flagAtlas, bannerArt, grassCard, leaves.broadleaf, leaves.conifer, leaves.palm, leaves.bush]) {
    for (const t of set.all) res.tex(t);
  }
  res.tex(glowTex);
  res.tex(stripeTex);

  const paintedMat = res.mat(
    new THREE.MeshStandardMaterial({
      name: "scenery/painted",
      map: painted.map,
      normalMap: painted.normalMap,
      vertexColors: true,
      roughness: 0.68,
      metalness: 0.06,
      envMapIntensity: 0.75,
      dithering: true,
    }),
  );
  paintedMat.normalScale.set(0.7, 0.7);

  // Lit signage and bulb lenses. Emissive keyed off the vertex colour so one
  // material serves a red bulb, a green bulb and a white rim light.
  const glowMat = res.mat(
    new THREE.MeshStandardMaterial({
      name: "scenery/glow",
      vertexColors: true,
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 1.0,
      roughness: 0.35,
      metalness: 0,
      toneMapped: true,
    }),
  );
  // Emissive with no emissiveMap takes the flat emissive colour; pushing the
  // vertex colour into it is what lets a single material carry many bulb hues.
  glowMat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>\n#ifdef USE_COLOR\n totalEmissiveRadiance *= vColor;\n#endif",
    );
  };
  glowMat.customProgramCacheKey = () => "scenery-glow-v1";

  const fabricMat = res.mat(
    new THREE.MeshStandardMaterial({
      name: "scenery/fabric",
      map: fabric.map,
      normalMap: fabric.normalMap,
      vertexColors: true,
      roughness: 0.92,
      metalness: 0,
      side: THREE.DoubleSide,
      envMapIntensity: 0.5,
    }),
  );

  const rockMat = res.mat(
    new THREE.MeshStandardMaterial({
      name: "scenery/rock",
      map: rock.map,
      normalMap: rock.normalMap,
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
      envMapIntensity: 0.4,
    }),
  );
  rockMat.normalScale.set(1.1, 1.1);

  // The far ring is fifty thousand triangles of hill seen through 400 m of fog.
  // It gets flat shading and no maps: the silhouette is the only thing legible.
  const distantMat = res.mat(
    new THREE.MeshStandardMaterial({
      name: "scenery/distant",
      vertexColors: true,
      flatShading: true,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.35,
    }),
  );

  /** Alpha-cut card material for one vegetation species. */
  function leaf(
    name: string,
    map: THREE.Texture,
    tint: number,
    height: number,
    amp: number,
  ): THREE.MeshStandardMaterial {
    const m = res.mat(
      new THREE.MeshStandardMaterial({
        name: `scenery/${name}`,
        map,
        color: tint,
        // A hard cut, not blending: transparency would need sorting, and sorted
        // transparency across ten thousand instances is not a thing that ships.
        transparent: false,
        alphaTest: 0.42,
        side: THREE.DoubleSide,
        roughness: 0.86,
        metalness: 0,
        envMapIntensity: 0.42,
        // Foliage lit only from the front reads as a cut-out; a little of the
        // sun coming through the leaves is what makes a canopy look deep. Kept
        // low: any more and the sky's ambient bleaches the whole wood.
        emissive: new THREE.Color(tint).multiplyScalar(0.035),
      }),
    );
    patchScenery(m, `scenery-leaf-${name}`, { kind: "tree", height, amp, flutter: 0.22 }, u);
    return m;
  }

  const leafBroadleaf = leaf("leafBroadleaf", leaves.broadleaf.map, 0xf2fff0, 7.5, 0.5);
  const leafConifer = leaf("leafConifer", leaves.conifer.map, 0xf0fff4, 11, 0.28);
  const leafPalm = leaf("leafPalm", leaves.palm.map, 0xf6fff0, 9, 0.62);
  const leafBush = leaf("leafBush", leaves.bush.map, 0xf4fff0, 1.5, 0.14);

  const grassMat = res.mat(
    new THREE.MeshStandardMaterial({
      name: "scenery/grass",
      map: grassCard.map,
      alphaTest: 0.38,
      side: THREE.DoubleSide,
      vertexColors: true,
      roughness: 0.9,
      metalness: 0,
      envMapIntensity: 0.5,
    }),
  );
  patchScenery(grassMat, "scenery-grass", { kind: "tree", height: 0.6, amp: 0.16, flutter: 0.3 }, u);

  // Bark is the painted surface with the relief cranked up, *not* the library's
  // bark: that one already carries a brown albedo, and multiplying it by the
  // brown in our vertex colours takes every trunk in the circuit to near-black.
  // Neutral map × coloured vertices is the only combination that composes.
  const barkMat = res.mat(
    new THREE.MeshStandardMaterial({
      name: "scenery/bark",
      map: painted.map,
      normalMap: painted.normalMap,
      vertexColors: true,
      roughness: 0.94,
      metalness: 0,
      envMapIntensity: 0.4,
    }),
  );
  barkMat.normalScale.set(1.6, 1.6);
  // The trunk has to sway with its own canopy or the tree tears in half.
  patchScenery(barkMat, "scenery-bark", { kind: "tree", height: 7.5, amp: 0.32 }, u);

  const crowdMat = res.mat(
    new THREE.MeshStandardMaterial({
      name: "scenery/crowd",
      map: fabric.map,
      normalMap: fabric.normalMap,
      vertexColors: true,
      roughness: 0.85,
      metalness: 0,
      envMapIntensity: 0.45,
    }),
  );
  patchScenery(crowdMat, "scenery-crowd", { kind: "crowd" }, u);

  const birdMat = res.mat(
    new THREE.MeshStandardMaterial({
      name: "scenery/bird",
      vertexColors: true,
      roughness: 0.8,
      metalness: 0,
      envMapIntensity: 0.6,
      side: THREE.DoubleSide,
    }),
  );
  patchScenery(birdMat, "scenery-bird", { kind: "bird" }, u);

  const sponsorMat = res.mat(
    new THREE.MeshStandardMaterial({
      name: "scenery/sponsor",
      map: sponsorAtlas.map,
      roughness: 0.55,
      metalness: 0.04,
      envMapIntensity: 0.8,
      side: THREE.FrontSide,
    }),
  );
  patchScenery(sponsorMat, "scenery-sponsor", { kind: "still" }, u, { atlas: SPONSOR_GRID });

  const flagMat = res.mat(
    new THREE.MeshStandardMaterial({
      name: "scenery/flag",
      map: flagAtlas.map,
      roughness: 0.95,
      metalness: 0,
      side: THREE.DoubleSide,
      envMapIntensity: 0.5,
    }),
  );
  // Two effects on one material: the atlas remap lands in <uv_vertex>, the
  // ripple in <begin_vertex>. Four flag designs, one draw call, and each one
  // flying on its own phase.
  patchScenery(flagMat, "scenery-flag", { kind: "flag" }, u, { atlas: FLAG_GRID });

  const dancerMat = res.mat(
    new THREE.MeshStandardMaterial({
      name: "scenery/dancer",
      map: stripeTex,
      roughness: 0.62,
      metalness: 0,
      side: THREE.DoubleSide,
      envMapIntensity: 0.45,
    }),
  );
  patchScenery(dancerMat, "scenery-dancer", { kind: "dancer" }, u);

  const bannerMat = res.mat(
    new THREE.MeshStandardMaterial({
      name: "scenery/banner",
      map: bannerArt.map,
      transparent: true,
      alphaTest: 0.2,
      // Single-sided on purpose. The gantry hangs two banners back to back; if
      // the material were double-sided you would read the near one's *reverse*
      // through it, and mirrored type is the loudest possible art bug.
      side: THREE.FrontSide,
      roughness: 0.85,
      metalness: 0,
      envMapIntensity: 0.5,
    }),
  );

  const halo = res.mat(
    new THREE.SpriteMaterial({
      name: "scenery/halo",
      map: glowTex,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
      fog: true,
    }),
  );

  const water =
    borrow(services, "water") ??
    res.mat(
      new THREE.MeshStandardMaterial({
        name: "scenery/water",
        color: 0x2e93d9,
        roughness: 0.12,
        metalness: 0.1,
        envMapIntensity: 1.4,
        transparent: true,
        opacity: 0.9,
      }),
    );

  const depth = shadows
    ? {
        broadleaf: res.mat(
          depthTwin("scenery-leaf-leafBroadleaf", { kind: "tree", height: 7.5, amp: 0.5, flutter: 0.22 }, u, leaves.broadleaf.map, 0.42),
        ),
        conifer: res.mat(
          depthTwin("scenery-leaf-leafConifer", { kind: "tree", height: 11, amp: 0.28, flutter: 0.22 }, u, leaves.conifer.map, 0.42),
        ),
        palm: res.mat(
          depthTwin("scenery-leaf-leafPalm", { kind: "tree", height: 9, amp: 0.62, flutter: 0.22 }, u, leaves.palm.map, 0.42),
        ),
        bush: res.mat(
          depthTwin("scenery-leaf-leafBush", { kind: "tree", height: 1.5, amp: 0.14, flutter: 0.22 }, u, leaves.bush.map, 0.42),
        ),
      }
    : null;

  return {
    painted: paintedMat,
    glow: glowMat,
    fabric: fabricMat,
    rock: rockMat,
    distant: distantMat,
    leafBroadleaf,
    leafConifer,
    leafPalm,
    leafBush,
    grass: grassMat,
    bark: barkMat,
    crowd: crowdMat,
    bird: birdMat,
    sponsor: sponsorMat,
    flag: flagMat,
    dancer: dancerMat,
    banner: bannerMat,
    halo,
    water,
    depth,
  };
}
