/**
 * Twelve places to stand, built from fourteen shapes.
 *
 * The temptation with a world like this is to write a hand-placed builder per
 * destination — `buildVulcan()`, `buildQonos()` — and twelve of those is four
 * thousand lines that all do the same four things slightly differently. So
 * instead there is a **vocabulary** (`PropKind`: pillar, arch, dome, spire,
 * stall, brazier, tree…) and a **grammar** (`Rule`: put twelve of these in a
 * ring of radius forty; scatter thirty of those between twenty and a hundred
 * and twenty metres out; put one of these here). A destination is then a
 * paragraph rather than a program, and the whole of Mount Seleya is nine rules.
 *
 * What makes them read as different places is not the shapes — it is the
 * proportions and the palette. Vulcan is wide, low, red and symmetrical;
 * Qo'noS is the same shapes made tall, narrow, dark and deliberately
 * off-centre; Cardassia is the same shapes again, repeated far more times than
 * a human would find comfortable, which is a thing the show says about
 * Cardassian architecture out loud. Three kits, one vocabulary, three
 * unmistakable civilisations.
 *
 * Everything is placed by a seeded RNG keyed off the world, so a return visit
 * finds the same braziers in the same places.
 *
 * Every kit opens with a `beacon` at the origin. That is the transporter pad —
 * the thing the away team is standing on when the shimmer clears — and a kit
 * without one drops the captain onto blank ground with no mark on it, which
 * reads as a bug even when everything else is right.
 *
 * One rule about colour, learned the hard way on Vulcan: **the stone must be
 * several stops lighter than the ground it stands on.** The first pass gave
 * Seleya a 0x9c4f2b sandstone on a 0xa1522c mountain, which is the same colour,
 * and the result was a red plain with slightly redder shapes on it — nine rules
 * of architecture rendered completely invisible. Hue can match; value cannot.
 */
import * as THREE from "three";
import { makeRng } from "../types";
import { surfaced, type SurfaceFamily } from "../gfx/surfacing";
import type { KitName } from "../galaxy/systems";

export type PropKind =
  | "pillar"
  | "arch"
  | "dome"
  | "tower"
  | "wall"
  | "spire"
  | "monolith"
  | "brazier"
  | "stall"
  | "hut"
  | "tree"
  | "palm"
  | "statue"
  | "pool"
  | "banner"
  | "wreck"
  | "beacon";

export type Rule =
  /** `count` copies evenly spaced on a circle of radius `r`. */
  | { kind: PropKind; ring: number; count: number; scale?: number; jitter?: number; color?: number; faceIn?: boolean }
  /** `count` copies scattered in an annulus. */
  | { kind: PropKind; scatter: number; min: number; max: number; scale?: number; vary?: number; color?: number }
  /** Exactly one, here. */
  | { kind: PropKind; at: [number, number]; scale?: number; rot?: number; color?: number }
  /** A straight run of `count`, spaced `step` apart, starting at `at`. */
  | { kind: PropKind; row: [number, number]; dir: [number, number]; count: number; step: number; scale?: number; color?: number };

export interface KitSpec {
  /** Terrain: how rough, and at what wavelength. `relief` 0 is a floor. */
  terrain: { relief: number; scale: number; tint: number; rock: number };
  /** Which baked surface the ground and the stonework are dressed in. */
  ground?: SurfaceFamily;
  face?: SurfaceFamily;
  /** Structure colours: the two the kit's props default to. */
  stone: number;
  metal: number;
  /** Emissive accent — braziers, lamps, pools, banners. */
  glow: number;
  /** Loose ground cover. `density` 0 leaves the ground bare — which only ever
   *  suits a floor somebody swept. */
  scatter?: { color: number; density: number; accent?: { color: number; family: SurfaceFamily; density: number } };
  rules: Rule[];
}

export const KITS: Record<KitName, KitSpec> = {
  /* Earth. A parade ground under cypress, with the tower behind it. Low, open,
     green, and the only kit in the game with a lawn. */
  presidio: {
    terrain: { relief: 2.4, scale: 0.012, tint: 0x55663f, rock: 0.12 },
    ground: "organic",
    face: "rock",
    stone: 0xdfe4e0,
    metal: 0x8f9aa4,
    glow: 0x8fd6ff,
    scatter: { color: 0x535346, density: 0.35, accent: { color: 0x4f7a3a, family: "organic", density: 0.8 } },
    rules: [
      { kind: "tower", at: [0, -46], scale: 3.4 },
      { kind: "dome", at: [0, -46], scale: 1.5 },
      { kind: "arch", ring: 22, count: 8, scale: 1.05, faceIn: true },
      { kind: "banner", ring: 14, count: 6, scale: 1.0 },
      { kind: "tree", scatter: 42, min: 40, max: 150, scale: 1.4, vary: 0.5 },
      { kind: "beacon", at: [0, 0], scale: 1 },
      { kind: "wall", row: [-34, 26], dir: [1, 0], count: 10, step: 7, scale: 0.7 },
    ],
  },

  /* Vulcan. Wide, symmetrical, and made of the mountain it stands on. Nine
     rules, and the thing that sells it is that everything is on an axis. */
  seleya: {
    terrain: { relief: 9.0, scale: 0.006, tint: 0x8c4020, rock: 0.75 },
    ground: "sand",
    face: "rock",
    stone: 0xcdb49a,
    metal: 0xe0bf86,
    glow: 0xffb04a,
    scatter: { color: 0x5c3721, density: 1.15 },
    rules: [
      { kind: "beacon", at: [0, 0], scale: 1.1 },
      { kind: "arch", at: [0, -30], scale: 2.6 },
      { kind: "pillar", ring: 26, count: 12, scale: 2.2, faceIn: true },
      { kind: "pillar", ring: 46, count: 18, scale: 1.5 },
      { kind: "brazier", ring: 15, count: 6, scale: 1.2 },
      { kind: "statue", at: [0, -52], scale: 2.2 },
      { kind: "monolith", ring: 74, count: 8, scale: 2.4 },
      { kind: "spire", scatter: 26, min: 90, max: 210, scale: 3.2, vary: 0.7 },
      { kind: "wall", row: [-30, 12], dir: [1, 0], count: 9, step: 7.5, scale: 1.0 },
      { kind: "wall", row: [-30, -70], dir: [1, 0], count: 9, step: 7.5, scale: 1.0 },
    ],
  },

  /* Qo'noS. Same vocabulary, made tall and narrow and pushed off the axis.
     Nothing is centred, everything is a spike, and the only light is fire. */
  "first-city": {
    terrain: { relief: 7.0, scale: 0.009, tint: 0x2b3020, rock: 0.6 },
    ground: "rock",
    face: "rock",
    stone: 0x77786a,
    metal: 0xb09030,
    glow: 0xff6a28,
    scatter: { color: 0x24281e, density: 1.0, accent: { color: 0x2a2a24, family: "rock", density: 0.5 } },
    rules: [
      { kind: "beacon", at: [0, 0], scale: 1.1 },
      { kind: "tower", at: [-6, -40], scale: 4.6 },
      { kind: "spire", at: [14, -34], scale: 3.6 },
      { kind: "spire", at: [-26, -30], scale: 2.8 },
      { kind: "pillar", ring: 24, count: 9, scale: 2.9 },
      { kind: "brazier", ring: 11, count: 5, scale: 1.6, color: 0xff5a1a },
      { kind: "statue", at: [3, -18], scale: 2.6 },
      { kind: "banner", ring: 18, count: 7, scale: 1.6, color: 0x8a1010 },
      { kind: "spire", scatter: 40, min: 70, max: 240, scale: 4.4, vary: 0.9 },
      { kind: "wall", row: [-40, 20], dir: [1, 0.18], count: 12, step: 7, scale: 1.4 },
    ],
  },

  /* Bajor. Terraces and a small shrine. Warm, worked, agricultural — the only
     kit whose largest structure is smaller than its trees. */
  kendra: {
    terrain: { relief: 5.0, scale: 0.011, tint: 0x6d6238, rock: 0.28 },
    ground: "organic",
    face: "rock",
    stone: 0xded5bc,
    metal: 0xd8c06a,
    glow: 0xffd28a,
    scatter: { color: 0x524931, density: 0.55, accent: { color: 0x5c7a3c, family: "organic", density: 0.7 } },
    rules: [
      { kind: "beacon", at: [0, 0], scale: 1.0 },
      { kind: "dome", at: [0, -34], scale: 1.9 },
      { kind: "arch", at: [0, -22], scale: 1.5 },
      { kind: "pillar", ring: 17, count: 8, scale: 1.2, faceIn: true },
      { kind: "banner", ring: 24, count: 10, scale: 1.1 },
      { kind: "hut", scatter: 12, min: 40, max: 110, scale: 1.2, vary: 0.4 },
      { kind: "tree", scatter: 54, min: 30, max: 180, scale: 1.7, vary: 0.6 },
      { kind: "wall", row: [-46, 16], dir: [1, 0], count: 14, step: 7, scale: 0.55 },
      { kind: "wall", row: [-46, 34], dir: [1, 0], count: 14, step: 7, scale: 0.45 },
      { kind: "brazier", ring: 9, count: 3, scale: 0.9 },
    ],
  },

  /* Ferenginar. A market under a leaking awning. Dense, cluttered, and lit by
     signage — the only kit where the small props outnumber the large ones. */
  "ferengi-market": {
    terrain: { relief: 1.6, scale: 0.02, tint: 0x363629, rock: 0.1 },
    ground: "rock",
    face: "metal",
    stone: 0x8a8272,
    metal: 0xc9a227,
    glow: 0xffd24a,
    scatter: { color: 0x292a22, density: 0.5 },
    rules: [
      { kind: "beacon", at: [0, 0], scale: 1.0 },
      { kind: "tower", at: [0, -58], scale: 5.6 },
      { kind: "stall", ring: 16, count: 10, scale: 1.1, faceIn: true },
      { kind: "stall", ring: 30, count: 16, scale: 1.0, faceIn: true },
      { kind: "stall", scatter: 18, min: 40, max: 90, scale: 1.0, vary: 0.3 },
      { kind: "banner", ring: 22, count: 14, scale: 0.9, color: 0xd8b83a },
      { kind: "pillar", ring: 44, count: 14, scale: 2.0 },
      { kind: "hut", scatter: 14, min: 55, max: 120, scale: 1.1, vary: 0.3 },
      { kind: "brazier", ring: 8, count: 4, scale: 0.7, color: 0xffd24a },
    ],
  },

  /* Risa. Sand, pavilions, palms and the sea. Almost nothing is vertical. */
  "risa-beach": {
    terrain: { relief: 2.2, scale: 0.014, tint: 0xc2a86e, rock: 0.05 },
    ground: "sand",
    face: "rock",
    stone: 0xf2e6c8,
    metal: 0x2fd6c3,
    glow: 0x6ff0e0,
    scatter: { color: 0x7e7155, density: 0.4, accent: { color: 0xe8e0cc, family: "rock", density: 0.35 } },
    rules: [
      { kind: "beacon", at: [0, 0], scale: 1.0 },
      { kind: "dome", at: [-14, -30], scale: 1.4 },
      { kind: "dome", at: [22, -38], scale: 1.1 },
      { kind: "arch", ring: 20, count: 6, scale: 1.2, faceIn: true },
      { kind: "palm", scatter: 46, min: 22, max: 150, scale: 1.5, vary: 0.55 },
      { kind: "stall", ring: 34, count: 6, scale: 0.9, faceIn: true },
      { kind: "banner", ring: 12, count: 5, scale: 0.9, color: 0x2fd6c3 },
      { kind: "statue", at: [0, -14], scale: 1.3 },
    ],
  },

  /* Andoria. An ice gallery: spires above, a lit floor below, and nothing
     organic anywhere in it. */
  "andoria-ice": {
    terrain: { relief: 6.5, scale: 0.008, tint: 0x6d90ab, rock: 0.5 },
    ground: "ice",
    face: "ice",
    stone: 0xd6e8f4,
    metal: 0x8fb4cc,
    glow: 0x63c8ff,
    scatter: { color: 0x647681, density: 0.9 },
    rules: [
      { kind: "spire", ring: 30, count: 10, scale: 4.2 },
      { kind: "spire", ring: 58, count: 14, scale: 5.6 },
      { kind: "spire", scatter: 40, min: 80, max: 230, scale: 6.5, vary: 0.9 },
      { kind: "arch", at: [0, -34], scale: 2.2, color: 0xbfe4ff },
      { kind: "pool", ring: 14, count: 5, scale: 1.1 },
      { kind: "monolith", ring: 20, count: 6, scale: 1.8 },
      { kind: "beacon", at: [0, 0], scale: 1 },
      { kind: "banner", ring: 24, count: 8, scale: 1.2, color: 0x63c8ff },
    ],
  },

  /* Cardassia. The same four shapes, repeated many more times than is
     comfortable, on a strict grid. The repetition is the characterisation. */
  "cardassia-plaza": {
    terrain: { relief: 1.2, scale: 0.02, tint: 0x6f5730, rock: 0.15 },
    ground: "sand",
    face: "rock",
    stone: 0xb8b0a0,
    metal: 0xb0762e,
    glow: 0xffb45a,
    scatter: { color: 0x544933, density: 0.6 },
    rules: [
      { kind: "beacon", at: [0, 0], scale: 1.1 },
      { kind: "tower", at: [0, -54], scale: 4.2 },
      { kind: "pillar", row: [-48, -20], dir: [1, 0], count: 15, step: 7, scale: 2.4 },
      { kind: "pillar", row: [-48, -6], dir: [1, 0], count: 15, step: 7, scale: 2.4 },
      { kind: "pillar", row: [-48, 8], dir: [1, 0], count: 15, step: 7, scale: 2.4 },
      { kind: "pillar", row: [-48, 22], dir: [1, 0], count: 15, step: 7, scale: 2.4 },
      { kind: "wall", row: [-52, 40], dir: [1, 0], count: 16, step: 7, scale: 1.3 },
      { kind: "monolith", ring: 70, count: 12, scale: 2.6 },
      { kind: "statue", at: [0, -30], scale: 2.0 },
      { kind: "brazier", ring: 12, count: 4, scale: 0.9 },
    ],
  },

  /* Romulus. Vulcan's grammar with the symmetry deliberately broken on one
     axis, and everything a shade of green a Vulcan would never choose. */
  "romulan-forum": {
    terrain: { relief: 3.6, scale: 0.01, tint: 0x3a4a2e, rock: 0.3 },
    ground: "organic",
    face: "rock",
    stone: 0xa9b0a2,
    metal: 0x9aa050,
    glow: 0x8fffb0,
    scatter: { color: 0x333925, density: 0.7, accent: { color: 0x3f6a34, family: "organic", density: 0.9 } },
    rules: [
      { kind: "beacon", at: [0, 0], scale: 1.1 },
      { kind: "arch", at: [0, -40], scale: 3.0 },
      { kind: "pillar", ring: 28, count: 14, scale: 2.8, faceIn: true },
      { kind: "pillar", row: [-40, -8], dir: [1, 0], count: 11, step: 8, scale: 2.2 },
      { kind: "statue", at: [-18, -24], scale: 2.4 },
      { kind: "statue", at: [18, -24], scale: 2.4 },
      { kind: "banner", ring: 20, count: 9, scale: 1.4, color: 0x2a6a48 },
      { kind: "monolith", ring: 62, count: 10, scale: 2.8 },
      { kind: "tree", scatter: 26, min: 70, max: 190, scale: 1.9, vary: 0.5 },
      { kind: "brazier", ring: 13, count: 5, scale: 1.0, color: 0x8fffb0 },
    ],
  },

  /* Trill. Underground, so the "sky" is a cavern roof and the only light in
     the kit comes up out of the floor. */
  "trill-caves": {
    terrain: { relief: 3.0, scale: 0.014, tint: 0x1d2130, rock: 0.55 },
    ground: "rock",
    face: "rock",
    stone: 0x565d78,
    metal: 0x8f7ce0,
    glow: 0x9f8cff,
    scatter: { color: 0x1c1f2a, density: 1.1 },
    rules: [
      { kind: "pool", at: [0, -12], scale: 2.6 },
      { kind: "pool", at: [-22, -30], scale: 1.8 },
      { kind: "pool", at: [24, -34], scale: 2.0 },
      { kind: "pool", scatter: 8, min: 40, max: 110, scale: 1.4, vary: 0.4 },
      { kind: "spire", ring: 34, count: 12, scale: 3.4 },
      { kind: "spire", scatter: 34, min: 55, max: 170, scale: 4.0, vary: 0.8 },
      { kind: "monolith", ring: 18, count: 5, scale: 1.4 },
      { kind: "beacon", at: [0, 8], scale: 0.8 },
    ],
  },

  /* Talos. Almost empty, and what is there is wrong: the surface of a world
     whose people stopped building anything a very long time ago. */
  "talos-surface": {
    terrain: { relief: 8.0, scale: 0.007, tint: 0x3e2c40, rock: 0.7 },
    ground: "rock",
    face: "rock",
    stone: 0x9a93a4,
    metal: 0x9a7ab0,
    glow: 0xd07aff,
    scatter: { color: 0x362939, density: 1.2 },
    rules: [
      { kind: "beacon", at: [0, 0], scale: 1.0 },
      { kind: "monolith", at: [0, -24], scale: 3.2 },
      { kind: "monolith", ring: 40, count: 5, scale: 2.4 },
      { kind: "spire", scatter: 30, min: 60, max: 220, scale: 5.0, vary: 0.9 },
      { kind: "wreck", at: [26, -14], scale: 1.6 },
      { kind: "pool", at: [-10, -8], scale: 1.2 },
      { kind: "beacon", at: [0, 0], scale: 0.9 },
    ],
  },

  /* Nowhere in particular — the fallback, and what a dead world looks like.
     Not reachable from the chart today; kept because a missing kit must not be
     able to take a surface down. */
  "dead-world": {
    terrain: { relief: 7.0, scale: 0.009, tint: 0x40352a, rock: 0.8 },
    ground: "sand",
    face: "rock",
    stone: 0xa4998a,
    metal: 0x7a7268,
    glow: 0xff8a4a,
    scatter: { color: 0x373026, density: 1.2 },
    rules: [
      { kind: "wreck", at: [8, -20], scale: 2.4 },
      { kind: "wreck", at: [-24, -38], scale: 1.6 },
      { kind: "spire", scatter: 34, min: 50, max: 220, scale: 4.6, vary: 0.9 },
      { kind: "beacon", at: [0, 0], scale: 1 },
    ],
  },
};

/* -------------------------------------------------------------------------- */

export interface BuiltKit {
  group: THREE.Group;
  /** Cylinders the player cannot walk through: x, z, radius. Kept flat and
   *  small — collision against forty boxes a frame is not worth a broadphase. */
  blockers: { x: number; z: number; r: number }[];
  dispose(): void;
}

/**
 * Evaluate a kit's rules into meshes.
 *
 * `heightAt` is passed in rather than imported so this file never has to know
 * how the terrain is generated — the surface scene owns that, and a prop that
 * floats a metre above the ground is the most obvious bug a world of this kind
 * can have.
 */
export function buildKit(
  name: KitName,
  seed: number,
  heightAt: (x: number, z: number) => number,
): BuiltKit {
  const spec = KITS[name] ?? KITS["dead-world"];
  const rng = makeRng(seed);
  const group = new THREE.Group();
  const blockers: { x: number; z: number; r: number }[] = [];

  /* Everything below is surfaced rather than coloured: a baked, mipmapped,
     triplanar-sampled map set per family, tinted by the kit's own palette.
     See `gfx/surfacing.ts` for why the detail is baked and not computed. */
  const face = spec.face ?? "rock";
  const stone = surfaced({ color: spec.stone, family: face, macro: 0.13 });
  const metal = surfaced({ color: spec.metal, family: "metal", tile: 1.4, roughness: 0.9, metalness: 0.9 });
  const dark = surfaced({ color: 0x33322e, family: face, tile: 1.1, macro: 0.1 });
  const leaf = surfaced({ color: 0x4d7a3c, family: "organic", tile: 0.9, macro: 0.22 });
  const owned: THREE.Material[] = [stone, metal, dark, leaf];

  const glowMat = (c: number) => {
    const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(1.7) });
    owned.push(m);
    return m;
  };

  function place(kind: PropKind, x: number, z: number, s: number, rot: number, color?: number): void {
    const y = heightAt(x, z);
    const node = makeProp(kind, s, spec, { stone, metal, dark, leaf }, glowMat, color, rng);
    if (!node) return;
    node.position.set(x, y, z);
    node.rotation.y = rot;
    group.add(node);
    const r = blockerRadius(kind, s);
    if (r > 0) blockers.push({ x, z, r });
  }

  for (const rule of spec.rules) {
    if ("ring" in rule) {
      for (let i = 0; i < rule.count; i++) {
        const a = (i / rule.count) * Math.PI * 2 + (rule.jitter ?? 0) * (rng() - 0.5);
        const r = rule.ring * (1 + (rule.jitter ?? 0) * (rng() - 0.5) * 0.2);
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        place(rule.kind, x, z, rule.scale ?? 1, rule.faceIn ? -a + Math.PI / 2 : rng() * Math.PI * 2, rule.color);
      }
    } else if ("scatter" in rule) {
      for (let i = 0; i < rule.scatter; i++) {
        const a = rng() * Math.PI * 2;
        const r = rule.min + rng() * (rule.max - rule.min);
        const s = (rule.scale ?? 1) * (1 + (rule.vary ?? 0) * (rng() - 0.5) * 2);
        place(rule.kind, Math.cos(a) * r, Math.sin(a) * r, Math.max(0.2, s), rng() * Math.PI * 2, rule.color);
      }
    } else if ("row" in rule) {
      const [dx, dz] = rule.dir;
      const len = Math.hypot(dx, dz) || 1;
      for (let i = 0; i < rule.count; i++) {
        place(
          rule.kind,
          rule.row[0] + (dx / len) * rule.step * i,
          rule.row[1] + (dz / len) * rule.step * i,
          rule.scale ?? 1,
          0,
          rule.color,
        );
      }
    } else {
      place(rule.kind, rule.at[0], rule.at[1], rule.scale ?? 1, rule.rot ?? 0, rule.color);
    }
  }

  return {
    group,
    blockers,
    dispose() {
      group.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.());
      owned.forEach((m) => m.dispose());
      group.parent?.remove(group);
    },
  };
}

/** How wide a thing is for the purposes of not walking through it. Trees and
 *  banners are 0 — being stopped by a sapling is worse than clipping one. */
function blockerRadius(kind: PropKind, s: number): number {
  switch (kind) {
    case "pillar":
      return 1.2 * s;
    case "tower":
      return 5 * s;
    case "dome":
      return 6 * s;
    case "monolith":
      return 1.6 * s;
    case "spire":
      return 1.8 * s;
    case "statue":
      return 1.4 * s;
    case "stall":
      return 2.2 * s;
    case "hut":
      return 3 * s;
    case "wall":
      return 2.6 * s;
    case "wreck":
      return 4 * s;
    default:
      return 0;
  }
}

type Mats = { stone: THREE.Material; metal: THREE.Material; dark: THREE.Material; leaf: THREE.Material };

/** The vocabulary. Every one of these is two to five primitives. */
function makeProp(
  kind: PropKind,
  s: number,
  spec: KitSpec,
  m: Mats,
  glow: (c: number) => THREE.Material,
  color: number | undefined,
  rng: () => number,
): THREE.Object3D | null {
  const g = new THREE.Group();
  const G = color ?? spec.glow;

  switch (kind) {
    case "pillar": {
      const h = 6 * s;
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.55 * s, 0.75 * s, h, 12), m.stone);
      shaft.position.y = h / 2;
      const cap = new THREE.Mesh(new THREE.BoxGeometry(2.0 * s, 0.5 * s, 2.0 * s), m.stone);
      cap.position.y = h + 0.2 * s;
      g.add(shaft, cap);
      break;
    }
    case "arch": {
      const h = 7 * s;
      const w = 5 * s;
      for (const side of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(1.2 * s, h, 1.4 * s), m.stone);
        leg.position.set(side * w, h / 2, 0);
        g.add(leg);
      }
      const top = new THREE.Mesh(new THREE.BoxGeometry(w * 2 + 1.6 * s, 1.4 * s, 1.8 * s), m.stone);
      top.position.y = h + 0.7 * s;
      const crown = new THREE.Mesh(new THREE.TorusGeometry(w * 0.62, 0.34 * s, 8, 20, Math.PI), glow(G));
      crown.position.y = h + 1.4 * s;
      g.add(top, crown);
      break;
    }
    case "dome": {
      const r = 6 * s;
      const base = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.06, 3 * s, 24), m.stone);
      base.position.y = 1.5 * s;
      const shell = new THREE.Mesh(new THREE.SphereGeometry(r, 26, 14, 0, Math.PI * 2, 0, Math.PI / 2), m.stone);
      shell.position.y = 3 * s;
      const light = new THREE.Mesh(new THREE.SphereGeometry(0.5 * s, 10, 8), glow(G));
      light.position.y = 3 * s + r;
      g.add(base, shell, light);
      break;
    }
    case "tower": {
      const h = 22 * s;
      const body = new THREE.Mesh(new THREE.CylinderGeometry(2.4 * s, 4.4 * s, h, 14), m.stone);
      body.position.y = h / 2;
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(3.2 * s, 2.2 * s, 3 * s, 14), m.metal);
      crown.position.y = h + 1.2 * s;
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.9 * s, 12, 10), glow(G));
      lamp.position.y = h + 3.6 * s;
      g.add(body, crown, lamp);
      break;
    }
    case "wall": {
      const w = new THREE.Mesh(new THREE.BoxGeometry(7.2 * s, 3.2 * s, 1.1 * s), m.stone);
      w.position.y = 1.6 * s;
      g.add(w);
      break;
    }
    case "spire": {
      const h = 9 * s * (0.7 + rng() * 0.7);
      const sp = new THREE.Mesh(new THREE.ConeGeometry(1.5 * s, h, 7), m.stone);
      sp.position.y = h / 2;
      sp.rotation.z = (rng() - 0.5) * 0.22;
      g.add(sp);
      break;
    }
    case "monolith": {
      const h = 8 * s;
      const mo = new THREE.Mesh(new THREE.BoxGeometry(1.8 * s, h, 0.9 * s), m.stone);
      mo.position.y = h / 2;
      mo.rotation.z = (rng() - 0.5) * 0.1;
      const seam = new THREE.Mesh(new THREE.BoxGeometry(0.24 * s, h * 0.7, 0.96 * s), glow(G));
      seam.position.y = h / 2;
      g.add(mo, seam);
      break;
    }
    case "brazier": {
      // The bowl has to be visibly wider than the flame and the post visibly
      // thicker than both, or the whole thing reads as a mushroom — which is
      // exactly what six of them around a Vulcan sanctum looked like on the
      // first pass. Flame is a cone, not a sphere, for the same reason.
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.3 * s, 0.46 * s, 2.1 * s, 8), m.metal);
      post.position.y = 1.05 * s;
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(1.0 * s, 0.42 * s, 0.62 * s, 14), m.metal);
      bowl.position.y = 2.4 * s;
      const fire = new THREE.Mesh(new THREE.ConeGeometry(0.62 * s, 1.5 * s, 9), glow(G));
      fire.position.y = 3.3 * s;
      fire.name = "flicker";
      g.add(post, bowl, fire);
      break;
    }
    case "stall": {
      const w = 3.2 * s;
      const table = new THREE.Mesh(new THREE.BoxGeometry(w, 1.1 * s, 1.6 * s), m.dark);
      table.position.y = 0.55 * s;
      const awn = new THREE.Mesh(new THREE.BoxGeometry(w * 1.25, 0.14 * s, 2.6 * s), m.metal);
      awn.position.y = 2.6 * s;
      awn.rotation.x = 0.16;
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09 * s, 0.09 * s, 2.6 * s, 6), m.dark);
        post.position.set(side * w * 0.55, 1.3 * s, -0.9 * s);
        g.add(post);
      }
      const sign = new THREE.Mesh(new THREE.BoxGeometry(w * 0.8, 0.4 * s, 0.08 * s), glow(G));
      sign.position.set(0, 2.1 * s, 1.2 * s);
      g.add(table, awn, sign);
      break;
    }
    case "hut": {
      const h = 3.4 * s;
      const body = new THREE.Mesh(new THREE.CylinderGeometry(2.6 * s, 2.8 * s, h, 10), m.stone);
      body.position.y = h / 2;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(3.4 * s, 2.2 * s, 10), m.dark);
      roof.position.y = h + 1.1 * s;
      const win = new THREE.Mesh(new THREE.BoxGeometry(0.7 * s, 0.7 * s, 0.1 * s), glow(G));
      win.position.set(0, h * 0.6, 2.75 * s);
      g.add(body, roof, win);
      break;
    }
    case "tree": {
      const h = 5.5 * s;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18 * s, 0.32 * s, h, 7), m.dark);
      trunk.position.y = h / 2;
      const crown = new THREE.Mesh(new THREE.SphereGeometry(1.9 * s, 9, 7), m.leaf);
      crown.position.y = h * 0.95;
      crown.scale.set(1, 1.25 + rng() * 0.4, 1);
      g.add(trunk, crown);
      break;
    }
    case "palm": {
      const h = 7 * s;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16 * s, 0.3 * s, h, 7), m.dark);
      trunk.position.y = h / 2;
      trunk.rotation.z = (rng() - 0.5) * 0.3;
      g.add(trunk);
      for (let i = 0; i < 7; i++) {
        const frond = new THREE.Mesh(new THREE.BoxGeometry(3.4 * s, 0.08 * s, 0.65 * s), m.leaf);
        const a = (i / 7) * Math.PI * 2;
        frond.position.set(Math.cos(a) * 1.5 * s, h * 0.98, Math.sin(a) * 1.5 * s);
        frond.rotation.y = -a;
        frond.rotation.z = -0.42;
        g.add(frond);
      }
      break;
    }
    case "statue": {
      const h = 5.4 * s;
      const plinth = new THREE.Mesh(new THREE.BoxGeometry(2.4 * s, 1.2 * s, 2.4 * s), m.stone);
      plinth.position.y = 0.6 * s;
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.62 * s, h * 0.5, 4, 10), m.metal);
      body.position.y = 1.2 * s + h * 0.42;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.5 * s, 12, 10), m.metal);
      head.position.y = 1.2 * s + h * 0.82;
      g.add(plinth, body, head);
      break;
    }
    case "pool": {
      const r = 3.2 * s;
      const rim = new THREE.Mesh(new THREE.TorusGeometry(r, 0.32 * s, 8, 28), m.stone);
      rim.rotation.x = Math.PI / 2;
      rim.position.y = 0.28 * s;
      const water = new THREE.Mesh(new THREE.CircleGeometry(r, 28), glow(G));
      water.rotation.x = -Math.PI / 2;
      water.position.y = 0.2 * s;
      water.name = "flicker";
      g.add(rim, water);
      break;
    }
    case "banner": {
      const h = 6 * s;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09 * s, 0.09 * s, h, 6), m.metal);
      pole.position.y = h / 2;
      const cloth = new THREE.Mesh(
        new THREE.PlaneGeometry(1.3 * s, 3.4 * s),
        new THREE.MeshStandardMaterial({ color: G, roughness: 1, side: THREE.DoubleSide }),
      );
      cloth.position.set(0.7 * s, h * 0.65, 0);
      g.add(pole, cloth);
      break;
    }
    case "wreck": {
      const w = 6 * s;
      const hull = new THREE.Mesh(new THREE.CapsuleGeometry(1.9 * s, w, 4, 10), m.metal);
      hull.rotation.set(0.32, rng() * Math.PI, 1.35);
      hull.position.y = 1.4 * s;
      const rib = new THREE.Mesh(new THREE.TorusGeometry(2.1 * s, 0.2 * s, 6, 16), m.dark);
      rib.position.set(2 * s, 1.6 * s, 1.2 * s);
      rib.rotation.y = 0.6;
      g.add(hull, rib);
      break;
    }
    case "beacon": {
      // The transporter pad. Every kit has one, at the origin, and it is the
      // thing the player is standing on when the shimmer clears.
      // 2.4 m rather than 3.4. The away team materialises standing in the
      // middle of this, so its near edge is a couple of metres from the
      // camera at eye height — at the old size the ring wrapped round the
      // bottom of the frame as a glowing band rather than reading as a disc
      // on the floor.
      // Set into the ground rather than standing on it, and small: the away
      // team materialises in the middle of this, so at eye height its near
      // edge is a couple of metres away and every extra centimetre of radius
      // is another band across the bottom of the frame.
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(1.9 * s, 2.1 * s, 0.16 * s, 32), m.metal);
      pad.position.y = 0.02 * s;
      // Half brightness: the away team is standing *inside* this one, and at
      // eye height a full-strength ring is a light bar across the bottom of
      // the frame rather than a marking on the floor.
      const dim = new THREE.Color(spec.glow).multiplyScalar(0.28).getHex();
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.75 * s, 0.07 * s, 8, 36), glow(dim));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.11 * s;
      ring.name = "flicker";
      g.add(pad, ring);
      break;
    }
    default:
      return null;
  }
  return g;
}
