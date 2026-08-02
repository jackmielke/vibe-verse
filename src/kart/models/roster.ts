/**
 * Vibe Kart — the cast.
 *
 * Eight originals, built to the same rule a Nintendo roster is: you must be
 * able to name the character from a 40-pixel silhouette in a rear-view mirror.
 * That means one strong shape idea each (spiky, round, tall, wide, slouched,
 * boxy, cone, hunched), one dominant hue each, spaced around the wheel so no
 * two karts can be confused at speed, and a weight class you can *read* — the
 * heavy is literally built out of bigger boxes than the feather.
 *
 * `CharacterPreset` is the shared contract (name, blurb, stats, colours).
 * `KartStyle`/`DriverStyle` are this module's own extensions: the geometry
 * parameters that turn one builder into eight distinct vehicles. They are
 * deliberately declarative — nobody should have to edit `kart.ts` to add a
 * ninth racer.
 */
import type { CharacterPreset } from "../types";

export type LiveryPattern = "stripe" | "bolt" | "bubble" | "flame" | "wave" | "check" | "swirl" | "plate";

export interface KartStyle {
  /** Overall size multiplier — the weight class you can see. */
  scale: number;
  /** Extra body width on top of `scale`. Heavies are square, feathers are thin. */
  width: number;
  /** Ride height multiplier. */
  ride: number;
  nose: "wedge" | "snub" | "plough" | "bullet";
  spoiler: "wing" | "ducktail" | "double" | "fin";
  engine: "twin" | "stack" | "turbine" | "boxer";
  rollbar: "hoop" | "twin" | "cage";
  livery: LiveryPattern;
  wheels: {
    frontRadius: number;
    rearRadius: number;
    frontWidth: number;
    rearWidth: number;
    spokes: number;
    twist: number;
  };
}

export interface DriverStyle {
  /** Torso proportions. */
  build: "tiny" | "slim" | "stocky" | "broad" | "blocky";
  headScale: number;
  /** Head-topper. Each is a different silhouette read from behind. */
  hat: "goggles" | "bowl" | "cap" | "antenna" | "aviator" | "swirl" | "visor" | "crest";
  ears: "none" | "fox" | "moth" | "rock" | "fin";
  scarf: { length: number; width: number; segments: number; color: number } | null;
  /** How the face is drawn — see `textures.ts`. */
  face: FaceStyle;
}

export interface FaceStyle {
  eye: "round" | "oval" | "slit" | "bead" | "goggle" | "led";
  /** Iris colour. */
  iris: number;
  brow: "flat" | "arch" | "angry" | "none";
  browColor: number;
  mouth: "smile" | "smirk" | "beak" | "grin" | "line";
  /** Cheek blush strength, 0..1. */
  blush: number;
  /** Optional freckles / rivets / lichen speckle. */
  speckle: "none" | "freckle" | "rivet" | "moss" | "sprinkle";
  speckleColor: number;
  /** Hair or shell colour painted around the face on the head sphere. */
  crown: number;
  /** Extra marking: a stripe over one eye, a chin plate, a beauty spot. */
  mark: "none" | "eyepatch" | "stripe" | "plate" | "swirl";
  markColor: number;
}

export interface RacerLook {
  preset: CharacterPreset;
  kart: KartStyle;
  driver: DriverStyle;
}

/** Compact constructor so the table below reads as a spec sheet, not a wall. */
function wheels(
  frontRadius: number,
  rearRadius: number,
  frontWidth: number,
  rearWidth: number,
  spokes: number,
  twist: number,
): KartStyle["wheels"] {
  return { frontRadius, rearRadius, frontWidth, rearWidth, spokes, twist };
}

export const LOOKS: RacerLook[] = [
  {
    preset: {
      id: "zippa",
      name: "Zippa",
      blurb: "A courier sprite who has never been late — she just leaves absurdly early.",
      weight: "feather",
      stats: { speed: 3, accel: 9, handling: 10, traction: 6, weight: 2 },
      colors: { body: 0xffe14d, accent: 0xff3d7f, trim: 0x2b2f4a },
      driver: { skin: 0xffd6b0, outfit: 0xff3d7f, hat: 0x2b2f4a },
    },
    kart: {
      scale: 0.9,
      width: 0.92,
      ride: 0.94,
      nose: "wedge",
      spoiler: "fin",
      engine: "turbine",
      rollbar: "hoop",
      livery: "bolt",
      wheels: wheels(0.31, 0.34, 0.22, 0.28, 5, 0.5),
    },
    driver: {
      build: "tiny",
      headScale: 1.16,
      hat: "goggles",
      ears: "none",
      scarf: { length: 1.5, width: 0.15, segments: 12, color: 0xff3d7f },
      face: {
        eye: "round",
        iris: 0x2b2f4a,
        brow: "arch",
        browColor: 0x3a2a1e,
        mouth: "grin",
        blush: 0.75,
        speckle: "freckle",
        speckleColor: 0xd98a6a,
        crown: 0xffd23f,
        mark: "none",
        markColor: 0xffffff,
      },
    },
  },
  {
    preset: {
      id: "bloop",
      name: "Bloop",
      blurb: "Half puddle, half optimist. Refuses to race without his weather bowl on.",
      weight: "light",
      stats: { speed: 4, accel: 8, handling: 8, traction: 7, weight: 3 },
      colors: { body: 0x2fc9e0, accent: 0xfff6c9, trim: 0x11557f },
      driver: { skin: 0x7fe3d6, outfit: 0xfff6c9, hat: 0xbfeaf5 },
    },
    kart: {
      scale: 0.95,
      width: 1.02,
      ride: 1.0,
      nose: "snub",
      spoiler: "ducktail",
      engine: "boxer",
      rollbar: "hoop",
      livery: "bubble",
      wheels: wheels(0.32, 0.35, 0.25, 0.32, 6, 0.2),
    },
    driver: {
      build: "stocky",
      headScale: 1.22,
      hat: "bowl",
      ears: "fin",
      scarf: null,
      face: {
        eye: "round",
        iris: 0x11557f,
        brow: "none",
        browColor: 0x11557f,
        mouth: "smile",
        blush: 0.5,
        speckle: "none",
        speckleColor: 0xffffff,
        crown: 0x5fd9cd,
        mark: "swirl",
        markColor: 0x37b8c9,
      },
    },
  },
  {
    preset: {
      id: "mikko",
      name: "Mikko",
      blurb: "Fixed his own gearbox on the grid twice. Won both of those races anyway.",
      weight: "light",
      stats: { speed: 5, accel: 8, handling: 8, traction: 5, weight: 4 },
      colors: { body: 0xff8b2b, accent: 0x2e2a36, trim: 0xffe0b0 },
      driver: { skin: 0xf7a55c, outfit: 0x2e2a36, hat: 0xd94f2b },
    },
    kart: {
      scale: 0.97,
      width: 0.98,
      ride: 0.98,
      nose: "wedge",
      spoiler: "wing",
      engine: "twin",
      rollbar: "twin",
      livery: "flame",
      wheels: wheels(0.32, 0.36, 0.24, 0.33, 5, 0.42),
    },
    driver: {
      build: "slim",
      headScale: 1.12,
      hat: "cap",
      ears: "fox",
      scarf: null,
      face: {
        eye: "oval",
        iris: 0x4a7a2b,
        brow: "flat",
        browColor: 0x8a4a1e,
        mouth: "smirk",
        blush: 0.45,
        speckle: "freckle",
        speckleColor: 0xc4703c,
        crown: 0xffb066,
        mark: "stripe",
        markColor: 0xfff0dc,
      },
    },
  },
  {
    preset: {
      id: "rue",
      name: "Rue",
      blurb: "Night-shift moth courier. Steers by streetlight and refuses to use the brakes.",
      weight: "medium",
      stats: { speed: 6, accel: 6, handling: 7, traction: 5, weight: 5 },
      colors: { body: 0x7f5cff, accent: 0xe6dcff, trim: 0x241a45 },
      driver: { skin: 0xd8c6f0, outfit: 0x3b2a68, hat: 0xe6dcff },
    },
    kart: {
      scale: 1.0,
      width: 1.0,
      ride: 1.02,
      nose: "bullet",
      spoiler: "double",
      engine: "turbine",
      rollbar: "hoop",
      livery: "wave",
      wheels: wheels(0.33, 0.37, 0.25, 0.34, 7, 0.3),
    },
    driver: {
      build: "slim",
      headScale: 1.08,
      hat: "antenna",
      ears: "moth",
      scarf: { length: 2.4, width: 0.2, segments: 16, color: 0xe6dcff },
      face: {
        eye: "slit",
        iris: 0xffd23f,
        brow: "arch",
        browColor: 0x2a1f4a,
        mouth: "line",
        blush: 0.3,
        speckle: "none",
        speckleColor: 0xffffff,
        crown: 0x4a3a7a,
        mark: "eyepatch",
        markColor: 0x2a1f4a,
      },
    },
  },
  {
    preset: {
      id: "volt",
      name: "Captain Volt",
      blurb: "Test pilot, retired. Still salutes the marshals on the cool-down lap.",
      weight: "medium",
      stats: { speed: 7, accel: 6, handling: 6, traction: 6, weight: 5 },
      colors: { body: 0x2b6bff, accent: 0xf5f7ff, trim: 0xff3b30 },
      driver: { skin: 0xe8b48a, outfit: 0xf5f7ff, hat: 0xc9432f },
    },
    kart: {
      scale: 1.02,
      width: 1.02,
      ride: 1.0,
      nose: "bullet",
      spoiler: "wing",
      engine: "stack",
      rollbar: "twin",
      livery: "stripe",
      wheels: wheels(0.33, 0.37, 0.26, 0.35, 8, 0.25),
    },
    driver: {
      build: "stocky",
      headScale: 1.02,
      hat: "aviator",
      ears: "none",
      scarf: { length: 2.0, width: 0.22, segments: 14, color: 0xff3b30 },
      face: {
        eye: "oval",
        iris: 0x2b6bff,
        brow: "flat",
        browColor: 0x6b4a2a,
        mouth: "smile",
        blush: 0.35,
        speckle: "none",
        speckleColor: 0xffffff,
        crown: 0xb98a5a,
        mark: "none",
        markColor: 0xffffff,
      },
    },
  },
  {
    preset: {
      id: "grumbo",
      name: "Grumbo",
      blurb: "A polite landslide. Apologises after every single corner, keeps the racing line.",
      weight: "cruiser",
      stats: { speed: 8, accel: 4, handling: 5, traction: 8, weight: 7 },
      colors: { body: 0x4f7a3a, accent: 0x8d8578, trim: 0xc9d97a },
      driver: { skin: 0x8d8578, outfit: 0x5f6b4a, hat: 0x6f8a3a },
    },
    kart: {
      scale: 1.1,
      width: 1.12,
      ride: 1.08,
      nose: "plough",
      spoiler: "ducktail",
      engine: "boxer",
      rollbar: "cage",
      livery: "swirl",
      wheels: wheels(0.35, 0.4, 0.3, 0.42, 6, 0.15),
    },
    driver: {
      build: "broad",
      headScale: 1.1,
      hat: "crest",
      ears: "rock",
      scarf: null,
      face: {
        eye: "bead",
        iris: 0xffe9a8,
        brow: "flat",
        browColor: 0x3f5a2a,
        mouth: "line",
        blush: 0.15,
        speckle: "moss",
        speckleColor: 0x8ec24a,
        crown: 0x6f8a3a,
        mark: "plate",
        markColor: 0xa39a89,
      },
    },
  },
  {
    preset: {
      id: "sundae",
      name: "Sundae",
      blurb: "Melts under pressure, literally. Somehow always re-forms in second place.",
      weight: "cruiser",
      stats: { speed: 8, accel: 5, handling: 4, traction: 6, weight: 7 },
      colors: { body: 0xfff0d2, accent: 0xff6f91, trim: 0x9c6b3a },
      driver: { skin: 0xfff3e0, outfit: 0xff9ab0, hat: 0xff6f91 },
    },
    kart: {
      scale: 1.08,
      width: 1.1,
      ride: 1.06,
      nose: "snub",
      spoiler: "fin",
      engine: "twin",
      rollbar: "hoop",
      livery: "check",
      wheels: wheels(0.34, 0.39, 0.29, 0.4, 6, 0.28),
    },
    driver: {
      build: "broad",
      headScale: 1.2,
      hat: "swirl",
      ears: "none",
      scarf: null,
      face: {
        eye: "round",
        iris: 0x7a4a2a,
        brow: "arch",
        browColor: 0xc98a5a,
        mouth: "smile",
        blush: 0.85,
        speckle: "sprinkle",
        speckleColor: 0x5cd6ff,
        crown: 0xfff0d2,
        mark: "none",
        markColor: 0xffffff,
      },
    },
  },
  {
    preset: {
      id: "baron",
      name: "Baron Bolt",
      blurb: "Assembled from three losing karts and one very stubborn opinion about corners.",
      weight: "heavy",
      stats: { speed: 10, accel: 3, handling: 3, traction: 4, weight: 10 },
      colors: { body: 0x59606e, accent: 0xd8342b, trim: 0xffc93c },
      driver: { skin: 0x7c848f, outfit: 0x3a3f49, hat: 0xd8342b },
    },
    kart: {
      scale: 1.16,
      width: 1.18,
      ride: 1.12,
      nose: "plough",
      spoiler: "double",
      engine: "stack",
      rollbar: "cage",
      livery: "plate",
      wheels: wheels(0.36, 0.42, 0.32, 0.46, 8, 0.1),
    },
    driver: {
      build: "blocky",
      headScale: 1.05,
      hat: "visor",
      ears: "none",
      scarf: null,
      face: {
        eye: "led",
        iris: 0xff5a3c,
        brow: "angry",
        browColor: 0x2a2e36,
        mouth: "line",
        blush: 0,
        speckle: "rivet",
        speckleColor: 0x9aa3b0,
        crown: 0x4a515c,
        mark: "plate",
        markColor: 0x3a3f49,
      },
    },
  },
];

export const ROSTER: CharacterPreset[] = LOOKS.map((l) => l.preset);

const BY_ID = new Map<string, RacerLook>(LOOKS.map((l) => [l.preset.id, l]));

/** Look-up that never fails: an unknown id gets the first entry rather than a
 *  hole in the grid. A missing character must cost a costume, not a racer. */
export function lookOf(id: string | undefined): RacerLook {
  return (id ? BY_ID.get(id) : undefined) ?? LOOKS[0];
}

/** Weight class → chassis mass feel, used for suspension travel and lean. */
export const WEIGHT_FEEL: Record<CharacterPreset["weight"], { travel: number; lean: number; bob: number }> = {
  feather: { travel: 1.25, lean: 1.3, bob: 1.3 },
  light: { travel: 1.12, lean: 1.15, bob: 1.15 },
  medium: { travel: 1.0, lean: 1.0, bob: 1.0 },
  cruiser: { travel: 0.86, lean: 0.85, bob: 0.85 },
  heavy: { travel: 0.72, lean: 0.7, bob: 0.7 },
};
