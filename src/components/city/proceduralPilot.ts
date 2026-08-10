/**
 * proceduralPilot — "Flux", a playable character with no model file.
 *
 * Every other pilot on Vibe Island is a GLB: a mesh someone sculpted, a
 * skeleton someone rigged, and three or four baked clips (idle / walk /
 * run / jump) that we cross-fade between. That works, but the seams show
 * — the walk clip plays at one speed forever, so at 3 m/s the feet skate,
 * and the cross-fade into "run" is a visible pop.
 *
 * Flux is built the other way round. The geometry is assembled here out
 * of primitives, the skeleton is a plain hierarchy of Groups, and there
 * are no clips at all: every joint angle is evaluated from the pilot's
 * actual motion each frame. The stride is a phase accumulator driven by
 * real horizontal speed, so stride *length* grows with speed and the feet
 * never skate — walk becomes run continuously, with nothing to blend.
 *
 * What that buys, beyond not skating:
 *
 *   - Banking. Turn hard and Flux leans into it, because the lean is a
 *     function of yaw rate, not a "turn left" clip.
 *   - Squash and stretch on landing, scaled by how hard you actually hit.
 *   - Secondary motion — crest and scarf are damped springs fed by the
 *     body's own acceleration, so they whip on direction changes and
 *     settle when you stand still. Nothing authored that.
 *   - Idle that isn't a loop: breathing, weight shifts onto alternating
 *     hips, and the occasional look-around, all on different periods so
 *     they never resynchronise into an obvious cycle.
 *
 * Feet sit at local y = 0 and the whole rig stands about 1.8m, matching
 * what City's GLB fit produces, so the pilot swaps in without retuning
 * the camera.
 */
import * as THREE from "three";

export interface PilotFrame {
  /** Horizontal speed, m/s. */
  speed: number;
  /** Standing on something. */
  grounded: boolean;
  /** Vertical velocity, m/s (+up). */
  verticalVel: number;
  /** Yaw change rate, rad/s — drives the bank into turns. */
  yawRate: number;
  /** Jetpack held down: switches to a hover pose. */
  thrusting: boolean;
}

export interface ProceduralPilot {
  /** Feet at local y = 0, facing +Z, ~1.8m tall. */
  group: THREE.Group;
  /**
   * The head joint, for anything that has to ride it.
   *
   * Exposed so a hat can be parented to the skull rather than to the root:
   * mounted on the root it stays dead level while the head bobs, leans and
   * glances underneath it, which reads as a hat floating a centimetre above
   * somebody rather than a hat on somebody. Crown y is about 0.30 in this
   * group's local space.
   */
  head: THREE.Group;
  update(dt: number, frame: PilotFrame): void;
  /** Re-tint the emissive accents (visor, crest, scarf, chest core). */
  setAccent(hex: string): void;
  dispose(): void;
}

/**
 * A design is a *skin* over the one rig below: palette, what grows out of
 * the crown, what trails off the back, and which facial hardware the head
 * wears. Everything else — the gait solver, the banking, the squash, the
 * springs — is shared, so a new character is a table entry rather than a
 * new animation system, and it can never skate its feet or pop a blend.
 */
export interface PilotDesign {
  shell: number;      // limbs + torso
  plate: number;      // joints, boots, yoke
  accent: string;     // emissive: eyes, trim, core
  cloth: number;      // scarf / cape / tail membrane
  /** What sits on the crown. */
  crown: "fins" | "cat-ears" | "bat-ears" | "horns" | "antennae" | "ring" | "cap" | "none";
  /** What trails off the body, using the same spring chain. */
  trail: "scarf" | "cape" | "tail" | "none";
  /**
   * What the character stands on — or does not.
   *
   * Everything on the shelf before this was a biped in different paint. Which
   * is a real limit and not an obvious one: you can change the palette, the
   * ears, the cape and the wings and still produce twelve characters that are
   * the same person in a doorway at thirty metres. Silhouette is the thing a
   * player recognises, and silhouette is mostly *how it moves*.
   *
   * So the plan is a fork in the rig rather than another accessory:
   *
   * - `biped`  — hips, two legs, a stride solver. The original, still default.
   * - `hover`  — no legs at all. Floats, banks like an aircraft, and its hands
   *              are detached and trail the body. Nothing to skate.
   * - `tread`  — a tracked base. Wheels roll at real ground speed, the body
   *              pitches against its own acceleration, and it cannot jump well.
   * - `waddle` — stubby legs set wide, no arms. Rocks side to side rather than
   *              striding; the roll IS the walk.
   */
  plan?: "biped" | "hover" | "tread" | "waddle" | "astromech" | "rollerball" | "quad";
  /**
   * Mirror plating instead of paint.
   *
   * One material property, and it changes what a design is *made of* rather
   * than what colour it is — which is the difference between a gold robot and
   * a robot painted yellow, and it is the whole read of an armoured character.
   */
  chrome?: boolean;
  /** A hemisphere instead of a skull. The astromech head. */
  dome?: boolean;
  /** A full helmet with a T-slot cut into it. Nobody's face is visible. */
  bucket?: boolean;
  /** An armoured faceplate: hard cheeks, a jaw, and two lit slits. */
  faceplate?: boolean;
  /** One wide scanning bar where the eyes would be. */
  barEye?: boolean;
  /** Shoulder armour, which is most of what makes a silhouette read as heavy. */
  pauldrons?: boolean;
  /** A pack between the shoulder blades with two nozzles under it. */
  jetpack?: boolean;
  /** A shaggy ruff at the shoulders and hips — the outline goes soft. */
  fur?: boolean;
  /** Two tusks off the jaw. Wants a muzzle to hang from. */
  tusks?: boolean;
  /** Lit bands round the limbs, in the accent. */
  glowRings?: boolean;
  /**
   * Inflatable: vinyl instead of panels.
   *
   * Every other design here is faceted plates over a shell, which is one look —
   * a machine. This drops the facets, the metalness and the joint spheres, and
   * overlaps the limb segments so there is no seam anywhere. It is the whole
   * difference between something built and something *inflated*, and it costs
   * three material properties.
   */
  soft?: boolean;
  /** A crate instead of a ribcage — a body that was manufactured, not grown. */
  boxy?: boolean;
  /** A beak, in the accent colour. Species, not expression. */
  beak?: boolean;
  /**
   * A pale panel down the front of the torso.
   *
   * `suit` repaints the whole chest, which is the wrong tool for anything
   * two-tone: a penguin whose entire body went white stopped being a penguin.
   * This is a front only, so the back and sides keep the shell colour and the
   * silhouette still reads dark from behind.
   */
  belly?: boolean;
  /**
   * How much the visor glows, 0–1. Default 0.22.
   *
   * The shared dark material carries the accent in its emissive so a face is
   * still a face at night. On a bright accent over a white body that lands as
   * a saturated blue blob rather than glass, so the ones that want a sleek
   * black faceplate turn it most of the way down.
   */
  visorGlow?: number;
  /** Face hardware. */
  face: "visor" | "lenses" | "muzzle" | "binocular" | "dots";
  /** Big eyes read as a mask; small ones read as a machine. */
  eyeScale: number;
  /**
   * Round eyes with a dark rim, instead of the default slit.
   *
   * `face` decides what the head *has* — glass, lenses, a snout. This decides
   * what the eyes *are*, which is a separate axis that was previously welded
   * to it: only `lenses` got spheres, so every animal in the roster had to
   * glare through letterbox slits. That is right for Sable and wrong for a
   * cartoon dinosaur, and the difference between feral and friendly is
   * entirely in this one shape.
   */
  roundEyes?: boolean;
  /** Chest emblem plate (bat-style). */
  emblem?: boolean;
  /** Membrane wings off the shoulder blades. */
  wings?: boolean;
  /** Suit piping — thin lines over the torso, spider-suit style. */
  piping?: boolean;
  /** Body scale, for the ones that aren't human-shaped. */
  chunk?: number;
  /** A glowing chest reactor. Flux's, originally — now anyone's. */
  core?: boolean;
  /** Cloth that emits rather than absorbs. 0–1; fabric wants ~0.06. */
  clothGlow?: number;
  /** A thicker, spiked tail that swings with weight, rather than a cat's. */
  heavyTail?: boolean;
  /**
   * A glass bubble over the whole head, with a collar ring under it.
   *
   * Every other piece in this table changes what the character *is*; this one
   * changes where it can be. A helmet reads as vacuum, and vacuum is the only
   * thing on the shelf that implies somewhere other than Vibe Island — which
   * is worth a flag of its own rather than being folded into `face`, because
   * a snout and a bubble are not alternatives. Space Rex has both.
   */
  helmet?: boolean;
  /**
   * Torso in the plate colour instead of the shell colour — a worn suit over
   * a body, rather than a body.
   *
   * Space Rex is green with white joints, and green joints on a green chest is
   * a green robot in a fishbowl. Flipping the one biggest surface to the plate
   * colour is what turns the same rig into something *wearing* a spacesuit,
   * with the limbs and tail still reading as the animal inside it.
   */
  suit?: boolean;
}

export const PILOT_DESIGNS: Record<string, PilotDesign> = {
  flux: {
    shell: 0x4d5a80, plate: 0x9fb0d4, accent: "#73ffb8", cloth: 0x73ffb8,
    crown: "fins", trail: "scarf", face: "visor", eyeScale: 1,
    core: true, clothGlow: 0.7,
  },
  // Red-and-blue wall-crawler: the silhouette is all in the lenses.
  webslinger: {
    shell: 0xc8202e, plate: 0x1d3fa8, accent: "#f2f6ff", cloth: 0xc8202e,
    crown: "none", trail: "none", face: "lenses", eyeScale: 2.35, piping: true,
  },
  // Cowl, ears, and a cape that actually swings — the cape is the character.
  nightcape: {
    shell: 0x2a2f3d, plate: 0x171a24, accent: "#ffd75e", cloth: 0x1b1f2b,
    crown: "bat-ears", trail: "cape", face: "lenses", eyeScale: 1.5, emblem: true,
  },
  // Orange tabby with a tail that whips through every turn.
  whiskers: {
    shell: 0xe08a3c, plate: 0xf7e2c2, accent: "#8bf07a", cloth: 0xe08a3c,
    crown: "cat-ears", trail: "tail", face: "muzzle", eyeScale: 1.75, chunk: 1.04,
  },
  // Wings that spread when you leave the ground, horns, and a heavy tail.
  emberwing: {
    shell: 0x2f7d57, plate: 0xd9a441, accent: "#ff8a3d", cloth: 0x1f5c3e,
    crown: "horns", trail: "tail", face: "muzzle", eyeScale: 1.5,
    wings: true, chunk: 1.08, heavyTail: true,
  },

  // ---- New body plans -------------------------------------------------
  //
  // Everything above this line is the same biped: hips, two legs, a stride.
  // Change the palette, the ears, the cape and the wings and you still get
  // twelve characters who are one person in a doorway at thirty metres.
  //
  // These five are not that. Each one picks a `plan`, which forks the rig at
  // the waist, so what separates them is how they *move* — a thing you can
  // recognise from behind, in the dark, at the far end of a street. That is
  // what a silhouette actually is.

  // Vinyl, not panels. No seams, no joints, no visor — two dots and the bar
  // between them, which is the most-loved face ever drawn and is three
  // primitives. The head is deliberately small on a big body: that ratio is
  // the difference between "gentle" and "menacing" and nothing else is doing
  // that work.
  marshmallow: {
    shell: 0xf4f2ee, plate: 0xe4e1da, accent: "#cfd6e6", cloth: 0xf4f2ee,
    crown: "none", trail: "none", face: "dots", eyeScale: 1,
    plan: "biped", soft: true, chunk: 1.12,
  },
  // A century of hauling, on tracks. The binocular head is the whole
  // character: it has no skull, so where it is looking is unmistakable, and
  // the neck is long enough to crane. Rust over sun-bleached yellow.
  scrap: {
    shell: 0xd8a12a, plate: 0x6f5b3e, accent: "#9be8ff", cloth: 0x6f5b3e,
    crown: "none", trail: "none", face: "binocular", eyeScale: 1,
    plan: "tread", boxy: true, chunk: 0.92,
  },
  // The other half of that pair: no legs, no arms, no seam. Floats, banks
  // like an aircraft, and its hands hang in the air beside it lagging half a
  // beat behind. Pearl white with one hard blue line.
  ovoid: {
    shell: 0xf7fbff, plate: 0xdfeaf5, accent: "#3fa9ff", cloth: 0xbfe4ff,
    crown: "none", trail: "none", face: "visor", eyeScale: 1.15,
    // A near-black faceplate: at the default glow a bright blue accent over a
    // white body renders the visor as a saturated splat instead of glass.
    visorGlow: 0.04,
    plan: "hover", soft: true, core: true, chunk: 0.96,
  },
  // Squat, wide, no arms worth the name. The walk is a roll, and the roll is
  // the joke — legs this short cannot cover ground, so the body has to throw
  // itself side to side and the feet follow it.
  tuxedo: {
    shell: 0x2a3550, plate: 0xf6f7fb, accent: "#ffa53d", cloth: 0x2a3550,
    crown: "none", trail: "none", face: "dots", eyeScale: 1.15,
    // `belly`, not `suit`: repainting the whole chest white turned the penguin
    // into a snowman, and from behind there was nothing left to recognise.
    plan: "waddle", belly: true, beak: true, chunk: 1.05,
  },
  // Proof the plans compose rather than each being a one-off: a waddler with
  // a muzzle, ears and a tail is a completely different animal on the same
  // fork. Moss and bark — the one design here that is not a machine or a toy.
  sprout: {
    shell: 0x6f9e5a, plate: 0xcfe0a8, accent: "#ffe27a", cloth: 0x4e7a3f,
    crown: "cat-ears", trail: "tail", face: "muzzle", eyeScale: 1.9,
    roundEyes: true, plan: "waddle", chunk: 1.0,
  },

  // ---- The wide cast ---------------------------------------------------
  //
  // Thirty, built from the parts above rather than one at a time. That is the
  // whole argument for a table: `bucket` is forty lines of geometry written
  // once, and it is the difference between a soldier and a hero on six
  // different characters that share nothing else.
  //
  // On the obvious question: these are *archetypes*, not anybody's characters.
  // An astromech, a protocol droid, a faceless trooper, an armoured flyer with
  // a lit chest are shapes that predate every film they remind you of, and the
  // repo has done this since Nightcape and Webslinger — evoke the silhouette,
  // give it its own name, and do not copy a design or a trademark. If one of
  // these ever needs the actual name to work, it is not finished.

  // -- Droids ------------------------------------------------------------
  // Rocks on two rigid struts and a centre foot. Cannot walk, and knows it.
  bolt: {
    shell: 0xf0f2f5, plate: 0xdde3ec, accent: "#2f9bff", cloth: 0xdde3ec,
    crown: "none", trail: "none", face: "visor", eyeScale: 1,
    plan: "astromech", dome: true, chunk: 0.98,
  },
  // A ball that is also the wheel, under a head that never touches it.
  pip: {
    shell: 0xfaf6ee, plate: 0xff8f3c, accent: "#ff8f3c", cloth: 0xff8f3c,
    crown: "none", trail: "none", face: "visor", eyeScale: 1,
    plan: "rollerball", dome: true, chunk: 1,
  },
  // Gold, and *gold* rather than yellow — the whole point of `chrome`.
  gilt: {
    shell: 0xd9a441, plate: 0xf0c96a, accent: "#fff0b8", cloth: 0xd9a441,
    crown: "none", trail: "none", face: "visor", eyeScale: 1,
    chrome: true, faceplate: true, glowRings: true,
  },
  // No face at all. The armour is the character.
  sentry: {
    shell: 0xeef1f6, plate: 0xdae0ea, accent: "#5b7fb0", cloth: 0x3a4150,
    crown: "none", trail: "none", face: "visor", eyeScale: 1,
    bucket: true, pauldrons: true,
  },
  // The same helmet, black, with a floor-length cape and a lit chest.
  warden: {
    shell: 0x14151b, plate: 0x22242e, accent: "#ff2d3f", cloth: 0x0d0e12,
    crown: "none", trail: "cape", face: "visor", eyeScale: 1,
    bucket: true, pauldrons: true, core: true,
  },
  // Beskar-bright, one pauldron's worth of scuff, and a pack on the back.
  bounty: {
    shell: 0x9aa6b4, plate: 0xd7dee8, accent: "#4ad6a0", cloth: 0x3d5568,
    crown: "none", trail: "cape", face: "visor", eyeScale: 1,
    chrome: true, bucket: true, pauldrons: true, jetpack: true,
  },
  // Fur is a silhouette problem at this poly count, so it is spikes.
  bramble: {
    shell: 0x7a5230, plate: 0x4a3220, accent: "#ffd36a", cloth: 0x4a3220,
    crown: "none", trail: "none", face: "muzzle", eyeScale: 1.5,
    roundEyes: true, fur: true, tusks: true, chunk: 1.16,
  },
  // Small, robed, enormous ears. Old rather than cute.
  elder: {
    shell: 0x8fae6a, plate: 0xcfd8b8, accent: "#ffe9a8", cloth: 0x6b5a3e,
    crown: "cat-ears", trail: "cape", face: "muzzle", eyeScale: 1.5,
    roundEyes: true, chunk: 0.7,
  },
  // A walking box with no head whatsoever. The joke is that it is finished.
  gonk: {
    shell: 0x6d7a5a, plate: 0x4c5640, accent: "#ffb03a", cloth: 0x4c5640,
    crown: "none", trail: "none", face: "visor", eyeScale: 1,
    boxy: true, barEye: true, chunk: 0.9,
  },
  // Thin, clinical, one sweeping eye and nothing else.
  medic: {
    shell: 0xe8eef4, plate: 0xb9c6d4, accent: "#5ff2c8", cloth: 0xb9c6d4,
    crown: "none", trail: "none", face: "visor", eyeScale: 1,
    dome: true, barEye: true, glowRings: true, chunk: 0.96,
  },

  // -- Armour ------------------------------------------------------------
  // Red and gold, a lit chest, and a pack. Flight, implied.
  magnate: {
    shell: 0xc02233, plate: 0xe8b545, accent: "#7ee8ff", cloth: 0xc02233,
    crown: "none", trail: "none", face: "visor", eyeScale: 1,
    chrome: true, faceplate: true, core: true, jetpack: true, pauldrons: true,
  },
  // The shield read: heavy blue, a white emblem, nothing lit.
  bulwark: {
    shell: 0x1f4fa8, plate: 0xeef3fa, accent: "#f4f7fb", cloth: 0x1f4fa8,
    crown: "none", trail: "none", face: "lenses", eyeScale: 1.6,
    emblem: true, pauldrons: true, chunk: 1.08,
  },
  // Nothing worn at all — the body IS the armour, and it is enormous.
  emerald: {
    shell: 0x3f9e4d, plate: 0x2c6f38, accent: "#d6ff8a", cloth: 0x2f5d3a,
    crown: "none", trail: "none", face: "muzzle", eyeScale: 1.5,
    chunk: 1.3, tusks: true,
  },
  // Storm colours, a cape, and rings that read as charge.
  voltaic: {
    shell: 0x2a3550, plate: 0x9fb6e0, accent: "#ffe14a", cloth: 0x1c2740,
    crown: "fins", trail: "cape", face: "visor", eyeScale: 1.1,
    glowRings: true, core: true, clothGlow: 0.3,
  },
  // Wings, a halo and a lit core: the one that is trying to be seen.
  seraph: {
    shell: 0xf3ead8, plate: 0xffffff, accent: "#ffcf5e", cloth: 0xffe9b0,
    crown: "ring", trail: "cape", face: "visor", eyeScale: 1,
    faceplate: true, wings: true, core: true, chrome: true, clothGlow: 0.5,
  },
  // Matte black, piping, lenses. Reads as somebody who does not want to be.
  vantablack: {
    shell: 0x101218, plate: 0x1b1e27, accent: "#5b6b86", cloth: 0x101218,
    crown: "none", trail: "none", face: "lenses", eyeScale: 1.9,
    piping: true, visorGlow: 0.05,
  },
  // A long cloak and a floating body. The sorcerer shape.
  crimson: {
    shell: 0x8a1f2e, plate: 0xd4a04a, accent: "#ffb95e", cloth: 0x9e2434,
    crown: "none", trail: "cape", face: "visor", eyeScale: 1.2,
    plan: "hover", core: true, clothGlow: 0.22,
  },
  // Small, winged, antennae. Quick rather than strong.
  stinger: {
    shell: 0xffc93c, plate: 0x2a2418, accent: "#ffe98a", cloth: 0x2a2418,
    crown: "antennae", trail: "none", face: "lenses", eyeScale: 2.2,
    wings: true, piping: true, chunk: 0.8,
  },
  // Pauldrons, rings, and enough chunk to change the doorway.
  titan: {
    shell: 0x6b7280, plate: 0x2f3540, accent: "#ff7a3d", cloth: 0x2f3540,
    crown: "none", trail: "none", face: "visor", eyeScale: 1,
    faceplate: true, pauldrons: true, glowRings: true, chunk: 1.28,
  },
  // Chrome and seamless, with one sweeping eye. Unsettling on purpose.
  phase: {
    shell: 0xc9d3de, plate: 0xeef3f8, accent: "#b46bff", cloth: 0xc9d3de,
    crown: "none", trail: "none", face: "visor", eyeScale: 1,
    chrome: true, soft: true, barEye: true,
  },

  // -- Everything else ----------------------------------------------------
  // Lit from the inside, horned, and heavy at the back.
  cinder: {
    shell: 0x2b1410, plate: 0x51231a, accent: "#ff5a1e", cloth: 0x3a1a12,
    crown: "horns", trail: "tail", face: "muzzle", eyeScale: 1.5,
    heavyTail: true, glowRings: true, core: true, chunk: 1.12,
  },
  // Pale, spiked, and cold enough that the accent is the only warm thing.
  frostbite: {
    shell: 0xd7ecf7, plate: 0xa8cfe4, accent: "#6ff0ff", cloth: 0xbfe2f2,
    crown: "fins", trail: "cape", face: "visor", eyeScale: 1.1,
    glowRings: true, clothGlow: 0.35,
  },
  // Fuzzy, winged, and mostly eyes. The gentlest thing on the shelf.
  mothling: {
    shell: 0xd8c7a8, plate: 0x8a7a5e, accent: "#ffe9a0", cloth: 0xb9a684,
    crown: "antennae", trail: "none", face: "lenses", eyeScale: 2.6,
    wings: true, fur: true, chunk: 0.92,
  },
  // Floats, glows, has no bones at all.
  jelly: {
    shell: 0xb98cff, plate: 0xe4d2ff, accent: "#8affea", cloth: 0xb98cff,
    crown: "none", trail: "none", face: "dots", eyeScale: 1.2,
    plan: "hover", soft: true, core: true, chunk: 1.04,
  },
  // Boxy, green, and spiked along the crown. Do not hug.
  prickle: {
    shell: 0x4f8f4a, plate: 0x3a6b38, accent: "#ffe27a", cloth: 0x3a6b38,
    crown: "horns", trail: "none", face: "dots", eyeScale: 1.3,
    boxy: true, chunk: 0.95,
  },
  // A cap, a soft body, and legs too short for any of it.
  toadstool: {
    shell: 0xf4e6d2, plate: 0xc4443c, accent: "#ffd9c2", cloth: 0xc4443c,
    crown: "cap", trail: "none", face: "dots", eyeScale: 1.4,
    plan: "waddle", soft: true, chunk: 0.95,
  },
  // Hard facets, paper colours, and wings that fold flat.
  origami: {
    shell: 0xf6f1e4, plate: 0xe05a4a, accent: "#e05a4a", cloth: 0xf6f1e4,
    crown: "fins", trail: "none", face: "dots", eyeScale: 1,
    wings: true, chunk: 0.96,
  },
  // Four legs, a long body, and a head out front. Not a person on all fours.
  ridgeback: {
    shell: 0x8a6a4a, plate: 0x5d452e, accent: "#ffc46a", cloth: 0x5d452e,
    crown: "cat-ears", trail: "tail", face: "muzzle", eyeScale: 1.6,
    roundEyes: true, plan: "quad", chunk: 1.02,
  },
  // The same four legs, built out of plate and light instead of fur.
  strider: {
    shell: 0x39414f, plate: 0x1f242e, accent: "#5ff2c8", cloth: 0x1f242e,
    crown: "none", trail: "tail", face: "visor", eyeScale: 1,
    plan: "quad", barEye: true, glowRings: true, heavyTail: true,
  },
  // A crate on tracks that is all cargo and no manners.
  hauler: {
    shell: 0xb4552c, plate: 0x3c3a38, accent: "#ffd166", cloth: 0x3c3a38,
    crown: "none", trail: "none", face: "binocular", eyeScale: 1,
    plan: "tread", boxy: true, pauldrons: true, chunk: 1.06,
  },

  // ---- The originals ------------------------------------------------
  //
  // Six designs that exist only here — no model file, nothing licensed, no
  // download. They are the stock of the arcade's character shop, and the
  // reason the shop can sell anything at all: every GLB in the roster is
  // already free in the Character Portal, so putting a price on one would be
  // taking something away rather than adding something. These are new.
  //
  // Each one is a silhouette first and a palette second. If two of them read
  // the same in a doorway at thirty metres, one of them is not worth 300.

  // Halo ring, cape, wings. Reads as light — the one you buy to be seen.
  aurora: {
    shell: 0xdfe9f7, plate: 0xfdfdff, accent: "#7df0ff", cloth: 0x8fd8ff,
    crown: "ring", trail: "cape", face: "visor", eyeScale: 1.1,
    wings: true, core: true, clothGlow: 0.45,
  },
  // Horns, heavy cape, a magenta emblem burning on a black chest.
  grimlock: {
    shell: 0x1b1725, plate: 0x3a2f4d, accent: "#ff4fd8", cloth: 0x120f19,
    crown: "horns", trail: "cape", face: "visor", eyeScale: 1.2, emblem: true,
  },
  // Small, round, enormous lenses. The mascot of the whole place.
  pixel: {
    shell: 0xff6fae, plate: 0xfff0f6, accent: "#fff27a", cloth: 0xff9ec9,
    crown: "cat-ears", trail: "scarf", face: "lenses", eyeScale: 2.6, chunk: 0.82,
  },
  // Mirror plating with a burnt-orange visor. The accent started white, which
  // is the one colour a chrome body cannot show you: the visor, the fins and
  // the tail spikes all disappeared into the plating and it read as a blank.
  chrome: {
    shell: 0x8f9aa8, plate: 0xf2f6fb, accent: "#ff7a3d", cloth: 0x8f9aa8,
    crown: "fins", trail: "tail", face: "visor", eyeScale: 0.9, heavyTail: true,
  },
  // Antennae and a striped, chunky body. The only insect on the floor.
  bumble: {
    shell: 0xf2b829, plate: 0x241f14, accent: "#fff6c2", cloth: 0x241f14,
    crown: "antennae", trail: "none", face: "lenses", eyeScale: 2.1,
    chunk: 1.1, piping: true,
  },
  // Bat ears over a muzzle, with a long tail — nocturnal, not heroic.
  sable: {
    shell: 0x232a3b, plate: 0xc9a86a, accent: "#c9a86a", cloth: 0x1a1f2c,
    crown: "bat-ears", trail: "tail", face: "muzzle", eyeScale: 1.6, chunk: 1.03,
  },
  // A round brass-and-teal robot on a permanent low hover. Antennae, a lens
  // for a face, and a reactor — the friendliest silhouette on the shelf, and
  // the only one built out of curves rather than corners.
  eddie: {
    shell: 0x3f9aa2, plate: 0xd8b263, accent: "#8fe9ff", cloth: 0x3f9aa2,
    crown: "antennae", trail: "none", face: "lenses", eyeScale: 1.85,
    core: true, chunk: 0.94,
  },
  // A corgi in uniform, unimpressed. The cap and the muzzle do the work; the
  // navy is `suit` rather than `shell` so the ears, the legs and the tail stay
  // corgi-coloured under it.
  "vibe-police": {
    shell: 0xdb8b3f, plate: 0x2e3f66, accent: "#ffc94a", cloth: 0xc97f36,
    crown: "cap", trail: "tail", face: "muzzle", eyeScale: 1.7,
    roundEyes: true, suit: true, emblem: true, chunk: 1.02,
  },
  // A green dinosaur in a white suit under a glass bubble. The only one on the
  // shelf that is somewhere else — the other six are all dressed for Vibe
  // Island, and a helmet is the cheapest way to say "not here".
  //
  // The spines run off `accent`, which is what `crown: "fins"` is wired to, so
  // the violet crest, the eyes and the suit light are one colour by
  // construction rather than by three numbers that can drift apart.
  "space-rex": {
    shell: 0x4fb55f, plate: 0xeef2f8, accent: "#b57bff", cloth: 0x3f9e50,
    crown: "fins", trail: "tail", face: "muzzle", eyeScale: 2.3, roundEyes: true,
    core: true, helmet: true, suit: true, chunk: 1.02,
  },
};

/** Critically-ish damped spring toward a target. Returns the new velocity. */
function spring(cur: number, target: number, vel: number, stiffness: number, damping: number, dt: number) {
  return vel + ((target - cur) * stiffness - vel * damping) * dt;
}

/** Frame-rate independent exponential approach — the lerp we actually want. */
const approach = (cur: number, target: number, rate: number, dt: number) =>
  cur + (target - cur) * (1 - Math.exp(-rate * dt));

export function buildProceduralPilot(
  accent?: string,
  designId = "flux",
): ProceduralPilot {
  const design = PILOT_DESIGNS[designId] ?? PILOT_DESIGNS.flux;
  accent = accent ?? design.accent;
  const chunk = design.chunk ?? 1;
  const group = new THREE.Group();

  // ---- Materials ----------------------------------------------------
  // Shell is flat-shaded so the low-poly facets read as a deliberate
  // style rather than a budget; the accent is emissive so Flux stays
  // legible at night and against the cloud deck.
  // The first pass was several stops too dark: against Vibe Island's
  // bright green lawn and pale sky, a 0x2b3346 shell rendered as a black
  // cut-out with no readable form at all. These are lifted well into the
  // midtones, with a genuinely light plate so the joints separate from
  // the limbs at chase-camera distance.
  const plan = design.plan ?? "biped";
  /* Vinyl, not panels: smooth normals so there is no facet to catch a
     highlight, almost no metalness so nothing reads as machined, and a high
     roughness so the whole body is one soft falloff. The geometry does the
     rest — see `soft` at each limb, where the segments overlap instead of
     meeting at a joint sphere. */
  /**
   * On `chrome`, and why it is not metalness 1.
   *
   * A physically-correct metal is *only* its reflections — it has no diffuse
   * colour at all — so at metalness 0.95 with no environment map to reflect,
   * every one of these rendered near-black with a couple of specular streaks
   * on it. Gold went brown, a mirror body went to a dark blob, and a radiant
   * white one came out charcoal. That is the material behaving correctly in a
   * scene that cannot support it: worlds here light with directional lights
   * and a hemisphere, and most of them ship no envmap.
   *
   * So this is deliberately *cheated* metal. Enough metalness to get a tight
   * bright highlight and a hard falloff, enough diffuse left to keep the hue
   * the design asked for. It reads as polished under lights that exist rather
   * than as correct under lights that do not.
   */
  const shell = new THREE.MeshStandardMaterial({
    color: design.shell,
    roughness: design.chrome ? 0.22 : design.soft ? 0.95 : 0.6,
    metalness: design.chrome ? 0.55 : design.soft ? 0.02 : 0.15,
    flatShading: !design.soft,
  });
  const plate = new THREE.MeshStandardMaterial({
    color: design.plate,
    roughness: design.chrome ? 0.26 : design.soft ? 0.9 : 0.45,
    metalness: design.chrome ? 0.5 : design.soft ? 0.02 : 0.25,
    flatShading: !design.soft,
  });
  const glow = new THREE.MeshStandardMaterial({
    color: new THREE.Color(accent), emissive: new THREE.Color(accent),
    emissiveIntensity: 1.5, roughness: 0.35, metalness: 0,
  });
  // Visor glass: dark, but with enough of the accent in its emissive to
  // stay a *face* at night rather than a hole in the head.
  const dark = new THREE.MeshStandardMaterial({
    color: 0x141a28, emissive: new THREE.Color(accent),
    emissiveIntensity: design.visorGlow ?? 0.22,
    roughness: 0.25, metalness: 0.4,
  });
  const cloth = new THREE.MeshStandardMaterial({
    color: new THREE.Color(design.cloth),
    emissive: new THREE.Color(design.cloth),
    // Flux's scarf glows; a bat's cape and a cat's tail are fabric and fur,
    // and reading them as neon would undo the whole silhouette. A knob
    // rather than an id check, so a new design can pick without editing this.
    emissiveIntensity: design.clothGlow ?? 0.06,
    roughness: 0.85, metalness: 0, side: THREE.DoubleSide,
  });
  const materials = [shell, plate, glow, dark, cloth];
  /**
   * Materials that must be freed but must NOT be re-tinted.
   *
   * `materials` above is not a disposal list, it is the set `setAccent`
   * rewrites — which is why helmet glass cannot go in it, and why it needs
   * somewhere else to live rather than being left undisposed. Two lists
   * because there are genuinely two questions.
   */
  const extraMaterials: THREE.Material[] = [];
  const geometries: THREE.BufferGeometry[] = [];

  const track = <T extends THREE.BufferGeometry>(g: T): T => { geometries.push(g); return g; };
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material) => {
    const o = new THREE.Mesh(track(g), m);
    o.castShadow = true;
    return o;
  };
  /** A tapered segment hanging DOWN from its parent's origin. */
  const limb = (len: number, rTop: number, rBot: number, m: THREE.Material) => {
    const o = mesh(new THREE.CylinderGeometry(rTop, rBot, len, 7), m);
    o.position.y = -len / 2;
    return o;
  };

  // ---- Skeleton ------------------------------------------------------
  // Each joint is a Group whose origin IS the pivot, so animating means
  // writing rotations and nothing else.
  /**
   * Where the waist sits, which is entirely a consequence of what is under it.
   *
   * Feet (or treads, or nothing) have to end at local y = 0 or the character
   * sinks into the floor of every world at once — City fits its camera to this
   * rig's height and does not re-measure per design. So each plan pays for its
   * own base: two 0.35 m legs put the hips at 0.78, a pair of stubby ones at
   * 0.34, a tracked bogie at 0.55, and a hoverer floats with clear air under it.
   */
  const HIP_Y =
    plan === "waddle" ? 0.39 :
    plan === "tread" ? 0.39 :
    plan === "hover" ? 0.92 :
    plan === "astromech" ? 0.53 :
    plan === "rollerball" ? 0.42 :
    plan === "quad" ? 0.54 :
    0.78;
  const root = new THREE.Group();       // squash/stretch + bob live here
  group.add(root);

  const hips = new THREE.Group();
  hips.position.y = HIP_Y;
  root.add(hips);

  /* A hard rectangular pelvis and a shoulder yoke are what make the default
     rig read as assembled. Both are exactly wrong on a body with no seams and
     on a body that is one egg from chin to knee, so those two skip them —
     otherwise you get a balloon with a plank through its hips. */
  const rigid =
    !design.soft && plan !== "waddle" && plan !== "rollerball" &&
    plan !== "astromech" && plan !== "quad";
  if (rigid) {
    const pelvis = mesh(new THREE.BoxGeometry(0.34, 0.18, 0.24), plate);
    pelvis.position.y = 0.02;
    hips.add(pelvis);
  }

  const torso = new THREE.Group();      // counter-twist + lean
  hips.add(torso);
  /* A capsule at 8 segments is a faceted cylinder, which is right for a
     panelled machine and wrong for anything inflated — the flat sides are
     visible on a big torso from any angle. Soft bodies get the smooth one. */
  const chestMesh = mesh(
    design.boxy
      ? new THREE.BoxGeometry(0.42, 0.46, 0.34)
      : new THREE.CapsuleGeometry(0.2, 0.26, design.soft ? 8 : 3, design.soft ? 20 : 8),
    design.suit ? plate : shell,
  );
  chestMesh.position.y = 0.29;
  /* The one measurement that decides what body you are looking at. A machine
     is a narrow slab; a balloon is nearly as deep as it is wide and taller
     than its limbs; a waddler is a wide egg with the shoulders inside it. */
  if (design.boxy) chestMesh.scale.set(1, 1, 1);
  else if (design.soft) chestMesh.scale.set(1.42, 1.18, 1.34);
  else if (plan === "waddle") chestMesh.scale.set(1.5, 1.3, 1.24);
  /* A barrel: as deep as it is wide, so it has no front. That is the astromech
     read — a body with no shoulders to square at you. */
  else if (plan === "astromech") chestMesh.scale.set(1.3, 1.05, 1.3);
  /* A quadruped's body runs front-to-back, not side to side. This one scale is
     the difference between an animal and a person on all fours. */
  else if (plan === "quad") chestMesh.scale.set(1.0, 0.92, 1.95);
  else chestMesh.scale.set(1.12, 1, 0.82);
  /* The rollerball has no torso. The ball is the body, and a capsule inside it
     is geometry nobody will ever see. */
  chestMesh.visible = plan !== "rollerball";
  torso.add(chestMesh);

  /* The white front of a two-tone animal. A squashed capsule laid ON the chest
     rather than a repaint of it, so it stops at the shoulders and the back
     stays dark — which is the only reason the silhouette still reads as a
     penguin from behind. */
  if (design.belly) {
    const belly = mesh(new THREE.CapsuleGeometry(0.17, 0.24, 4, 14), plate);
    /* It has to sit PROUD of the chest or it is simply inside it and invisible,
       which is how the first one rendered: a penguin with no white on it at
       all. So the depth is measured off the chest's actual scale rather than
       guessed — front of the belly a couple of centimetres outside the front
       of the body, whatever size that body is. */
    const chestHalfDepth = 0.2 * chestMesh.scale.z;
    const bellyHalfDepth = 0.17 * 0.72;
    belly.scale.set(1.2, 1.1, 0.72);
    belly.position.set(0, 0.27, chestHalfDepth - bellyHalfDepth + 0.035);
    torso.add(belly);
  }
  // Chest core — a slow pulse that doubles as a "you are here" marker.
  // Flux's reactor. A cat does not have one, and on the others it read as
  // a sticker: they get an emblem, piping, or bare chest instead.
  const core = mesh(new THREE.IcosahedronGeometry(0.062, 0), glow);
  core.position.set(0, 0.32, 0.17);
  core.visible = design.core ?? false;
  if (core.visible) torso.add(core);
  // Shoulder yoke.
  if (rigid) {
    const yoke = mesh(new THREE.BoxGeometry(0.46, 0.09, 0.2), plate);
    yoke.position.y = 0.5;
    torso.add(yoke);
  }

  // Head.
  const neck = new THREE.Group();
  /**
   * The neck has to clear the chest, and the chest is no longer one size.
   *
   * 0.55 is measured for the default slab torso, whose capsule tops out around
   * 0.62. Fatten that torso — a balloon at 1.18, a waddler at 1.3 — and the
   * top of the chest rises past the neck, so the head is *inside the body* and
   * the character loses its face and half its ears to the shoulders. Both of
   * the first waddlers rendered exactly that way.
   *
   * So it is derived from the chest rather than hand-tuned per design: the
   * capsule's half-height (0.33) times its vertical scale, plus the chest's own
   * offset, less the 0.07 the head has always been sunk into the shoulders by.
   * At scale 1 that is exactly 0.55, so every design that existed before this
   * line is bit-for-bit unmoved.
   */
  const chestTop = 0.29 + (design.boxy ? 0.23 : 0.33) * chestMesh.scale.y;
  neck.position.y =
    /* The ball is the body, so the head sits on top of the ball rather than on
       a chest that is not rendered. A quadruped's head goes on the FRONT of
       its body, which is the other half of what makes it read as an animal. */
    plan === "rollerball" ? 0.42 : chestTop - 0.07;
  if (plan === "quad") neck.position.z = 0.5;
  torso.add(neck);
  /**
   * A stalk, for a head that is not sitting on its shoulders.
   *
   * The binocular head has no skull — it is two barrels on a bar, and with
   * nothing between them and the chest they read as a pair of eyes hanging in
   * the air above a crate. The neck is the character: it is what lets the head
   * crane, and it is most of the reason that silhouette is readable at all.
   */
  if (design.face === "binocular") {
    const stalk = mesh(new THREE.CylinderGeometry(0.045, 0.06, 0.2, 8), plate);
    stalk.position.y = -0.06;
    neck.add(stalk);
    const collar = mesh(new THREE.CylinderGeometry(0.09, 0.105, 0.05, 10), plate);
    collar.position.y = -0.15;
    neck.add(collar);
  }
  const head = new THREE.Group();
  neck.add(head);
  const skull = mesh(new THREE.CapsuleGeometry(0.15, 0.1, 3, 10), shell);
  skull.position.y = 0.15;
  skull.scale.set(1, 0.95, 1.05);
  head.add(skull);
  // Wraparound visor, with the eyes standing PROUD of the glass. The
  // first cut sank them inside it, which from the front produced a
  // featureless dark blob — the character had no face at all.
  if (design.face === "visor") {
    const visor = mesh(new THREE.CapsuleGeometry(0.132, 0.085, 3, 14), dark);
    visor.position.set(0, 0.155, 0.05);
    visor.scale.set(1.02, 0.55, 1.0);
    head.add(visor);
  } else if (design.face === "muzzle") {
    // A snout turns a helmet into an animal: it's the one addition that
    // changes the read of the silhouette from the back of the room.
    const snout = mesh(new THREE.BoxGeometry(0.115, 0.085, 0.12), shell);
    snout.position.set(0, 0.125, 0.15);
    head.add(snout);
    const nose = mesh(new THREE.BoxGeometry(0.05, 0.035, 0.035), dark);
    nose.position.set(0, 0.145, 0.212);
    head.add(nose);
    // Jaw, slightly lighter, so the mouth line reads.
    /* Two tusks off the lower jaw. One addition, and a friendly snout becomes
       something you would not want to meet — it is the only piece in the table
       that changes a character's temperament rather than its species. */
    if (design.tusks) {
      for (const side of [-1, 1]) {
        const tusk = mesh(new THREE.ConeGeometry(0.022, 0.11, 6), plate);
        tusk.position.set(side * 0.052, 0.135, 0.175);
        tusk.rotation.set(0.35, 0, side * 0.22);
        head.add(tusk);
      }
    }
    const jaw = mesh(new THREE.BoxGeometry(0.098, 0.03, 0.1), plate);
    jaw.position.set(0, 0.093, 0.155);
    head.add(jaw);
    if (designId === "whiskers") {
      const whiskerGeo = track(new THREE.CylinderGeometry(0.004, 0.002, 0.17, 4));
      for (const side of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          const w = new THREE.Mesh(whiskerGeo, plate);
          w.position.set(side * 0.055, 0.128 + i * 0.016, 0.185);
          w.rotation.z = side * (Math.PI / 2 - 0.25);
          w.rotation.y = side * (0.25 - i * 0.22);
          head.add(w);
        }
      }
    }
  }
  /**
   * Binoculars on a yoke — the salvage-robot face.
   *
   * Two barrels that toe in slightly, on a crossbar, over a flat plate instead
   * of a skull. It is the one face here with no head shape at all: the barrels
   * ARE the head, so where it looks is unmistakable from behind and above,
   * which is where a chase camera actually sits. Built here rather than as a
   * `crown` because it replaces the skull rather than sitting on it.
   */
  /**
   * A dome instead of a skull.
   *
   * The astromech read, and it is entirely in the shape: a hemisphere has no
   * front, so a dome-headed character is looking wherever its one eye happens
   * to be pointed, and turning the dome is the only expression it needs. Three
   * radial panel lines stop it reading as a plain bowl.
   */
  if (design.dome) {
    skull.visible = false;
    /* Big. The first cut used a 0.165 cap, which on a barrel body scaled 1.3
       reads as a bottle cap rather than a head — the body swallowed it and the
       character had no face at any distance. An astromech's dome is as wide as
       its shoulders, and that ratio is the entire silhouette. */
    const cap = mesh(new THREE.SphereGeometry(0.27, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), plate);
    cap.position.y = 0.03;
    cap.scale.set(1, 0.86, 1);
    head.add(cap);
    // The eye: one big lens, off to the front, plus a smaller lamp beside it.
    const lens = mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.02, 16), dark);
    lens.rotation.x = Math.PI / 2;
    lens.position.set(0, 0.12, 0.21);
    head.add(lens);
    const pupil = mesh(new THREE.CircleGeometry(0.048, 16), glow);
    pupil.position.set(0, 0.12, 0.222);
    head.add(pupil);
    const lamp = mesh(new THREE.SphereGeometry(0.026, 8, 6), glow);
    lamp.position.set(0.12, 0.15, 0.185);
    head.add(lamp);
    for (let i = 0; i < 4; i++) {
      const band = mesh(new THREE.BoxGeometry(0.01, 0.14, 0.27), shell);
      band.position.y = 0.09;
      band.rotation.y = (i / 4) * Math.PI * 2 + 0.5;
      head.add(band);
    }
  }

  /**
   * A bucket helmet with a T cut into it.
   *
   * The most efficient shape in character design: it removes the face
   * entirely, so the whole read moves to the helmet's outline and the T. It
   * also means the character has no expression at all, which is exactly why
   * every faceless soldier ever drawn wears one.
   */
  if (design.bucket) {
    skull.visible = false;
    const helm = mesh(new THREE.CapsuleGeometry(0.155, 0.09, 4, 14), plate);
    helm.position.y = 0.16;
    helm.scale.set(1, 1.0, 1.06);
    head.add(helm);
    // Brow ridge and cheeks in the shell colour, so the T is what is left.
    const brow = mesh(new THREE.BoxGeometry(0.24, 0.055, 0.1), shell);
    brow.position.set(0, 0.215, 0.115);
    brow.rotation.x = -0.12;
    head.add(brow);
    for (const side of [-1, 1]) {
      const cheek = mesh(new THREE.BoxGeometry(0.07, 0.14, 0.1), shell);
      cheek.position.set(side * 0.09, 0.14, 0.105);
      head.add(cheek);
    }
    // The slot itself: a wide bar and a narrow stem, both dark.
    const bar = mesh(new THREE.BoxGeometry(0.13, 0.042, 0.05), dark);
    bar.position.set(0, 0.175, 0.15);
    head.add(bar);
    const stem = mesh(new THREE.BoxGeometry(0.045, 0.1, 0.05), dark);
    stem.position.set(0, 0.12, 0.15);
    head.add(stem);
  }

  /**
   * An armoured faceplate — the one that reads as a hero rather than a soldier.
   *
   * Same trick as the bucket and the opposite result, which is worth noting:
   * a helmet with a *jaw* and two lit slits gets read as a face wearing armour,
   * where a helmet with a slot gets read as armour with nobody in it. The
   * difference is about four primitives.
   */
  if (design.faceplate) {
    skull.visible = false;
    const mask = mesh(new THREE.CapsuleGeometry(0.15, 0.08, 4, 14), plate);
    mask.position.y = 0.16;
    mask.scale.set(1, 1, 1.02);
    head.add(mask);
    // Hard cheekbones and a jaw, which is what stops it being a bucket.
    const jaw = mesh(new THREE.BoxGeometry(0.15, 0.075, 0.13), plate);
    jaw.position.set(0, 0.085, 0.09);
    head.add(jaw);
    const mouth = mesh(new THREE.BoxGeometry(0.1, 0.018, 0.03), dark);
    mouth.position.set(0, 0.086, 0.155);
    head.add(mouth);
    for (const side of [-1, 1]) {
      const slit = mesh(new THREE.BoxGeometry(0.06, 0.028, 0.03), glow);
      slit.position.set(side * 0.06, 0.175, 0.142);
      slit.rotation.z = side * -0.13;
      head.add(slit);
    }
  }

  /** One scanning bar. No eyes at all, and it sweeps in the idle. */
  let scanBar: THREE.Mesh | null = null;
  if (design.barEye) {
    if (!design.dome && !design.bucket && !design.faceplate) skull.visible = true;
    const slot = mesh(new THREE.BoxGeometry(0.23, 0.05, 0.04), dark);
    slot.position.set(0, 0.16, 0.135);
    head.add(slot);
    scanBar = mesh(new THREE.BoxGeometry(0.05, 0.032, 0.03), glow);
    scanBar.position.set(0, 0.16, 0.152);
    head.add(scanBar);
  }

  if (design.face === "binocular") {
    skull.visible = false;
    const bar = mesh(new THREE.BoxGeometry(0.2, 0.045, 0.06), plate);
    bar.position.y = 0.15;
    head.add(bar);
    for (const side of [-1, 1]) {
      const barrel = mesh(new THREE.CylinderGeometry(0.062, 0.07, 0.15, 12), shell);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(side * 0.072, 0.155, 0.045);
      /* Toed in a few degrees. Parallel barrels stare through you; converged
         ones are looking AT something, and that is the whole expression this
         face has. */
      barrel.rotation.z = side * 0.07;
      head.add(barrel);
      /* A brow over the top of the barrel, not a sleeve around it. The first
         cut was an open-ended cylinder, which from three-quarters reads as a
         flap sticking up off the eye rather than a hood over it — and it hid
         the lens, which is the only lit thing on the whole face. */
      const brow = mesh(new THREE.BoxGeometry(0.155, 0.03, 0.11), plate);
      brow.position.set(side * 0.072, 0.215, 0.06);
      brow.rotation.x = -0.22;
      head.add(brow);
      // The lens, filling the barrel mouth: it is the eye, and a small disc
      // inside a big cylinder just looks like a hole with something at the back.
      const lens = mesh(new THREE.CircleGeometry(0.056, 16), glow);
      lens.position.set(side * 0.072, 0.155, 0.121);
      head.add(lens);
      // An iris, so it is a lens and not a torch.
      const iris = mesh(new THREE.CircleGeometry(0.026, 14), dark);
      iris.position.set(side * 0.072, 0.155, 0.123);
      head.add(iris);
    }
  }

  // Eye slits rather than dots: a horizontal bar keeps its shape at the
  // distance the chase camera actually sits at, where a dot is one pixel.
  const es = design.eyeScale;
  // Lenses are the whole identity for a masked character, so they get real
  // geometry — a teardrop plate with a dark rim — rather than a bright bar.
  // `roundEyes` is a MUZZLE option. Lenses are already round and already have
  // their own placement, rim and scale; letting the flag through there swapped
  // the glowing lens for the dark eyeball material and gave Eddie two black
  // blobs covering his whole face. Narrowed here rather than left to the
  // caller, because "silently produces a different character" is not a thing a
  // design table should be able to do.
  const roundMuzzle = design.face === "muzzle" && !!design.roundEyes;
  const dots = design.face === "dots";
  const round = design.face === "lenses" || roundMuzzle || dots;
  const eyeGeo = track(
    round
      ? new THREE.SphereGeometry(0.055, 10, 8)
      : new THREE.BoxGeometry(0.052, 0.026, 0.03),
  );
  /**
   * A cartoon eye is a dark ball with a bright speck on it, not a glowing
   * ball. Lighting the whole sphere in the accent is what made the first pass
   * read as a lens flare with a black ring round it — the highlight has to be
   * a *small* fraction of the eye or there is nothing for it to be a highlight
   * on. This is the eyeball; the glow becomes a speck parented to it, so it
   * squashes with the blink for free.
   */
  const eyeball = roundMuzzle || dots
    ? new THREE.MeshStandardMaterial({ color: 0x14121c, roughness: 0.28, metalness: 0.05 })
    : null;
  if (eyeball) materials.push(eyeball);
  /**
   * Two dots and the bar between them.
   *
   * The whole face, and deliberately the whole face: no mouth, no brow, no
   * visor. A blank oval with two dots on it is read as gentle by absolutely
   * everyone, and the moment you add a third feature it starts having an
   * opinion. The bar is what stops them reading as two separate holes — it is
   * one continuous drawn line, which is why this face works at any distance
   * down to about six pixels.
   */
  if (dots) {
    const link = mesh(new THREE.BoxGeometry(0.075, 0.014, 0.02), eyeball ?? plate);
    link.position.set(0, 0.168, 0.142);
    head.add(link);
  }
  /* A beak. The one feature allowed to break the two-dots rule, because it is
     not an expression — it is a species. It also gives the accent colour
     somewhere to live on a body that is otherwise two flat tones. */
  if (design.beak) {
    const beak = mesh(new THREE.ConeGeometry(0.05, 0.09, 4), glow);
    beak.rotation.x = Math.PI / 2;
    beak.rotation.y = Math.PI / 4;
    beak.position.set(0, 0.128, 0.16);
    beak.scale.set(1, 1, 0.62);
    head.add(beak);
  }
  const eyes: THREE.Mesh[] = [];
  /* Anything that replaced the skull brought its own eyes with it — barrels, a
     dome lens, a T-slot, lit slits, a scanning bar. Letting the generic pair
     through as well is two extra eyes floating in front of a helmet, which is
     exactly what happened the first time. */
  const ownsItsEyes =
    design.face === "binocular" || !!design.dome || !!design.bucket ||
    !!design.faceplate || !!design.barEye;
  for (const side of [-1, 1]) {
    if (ownsItsEyes) break;
    const eye = new THREE.Mesh(eyeGeo, eyeball ?? glow);
    if (design.face === "lenses") {
      // Angular lenses, wide-set and tilted into a scowl. Spheres read as
      // goggles; these are squashed hard on Y and Z so they sit ON the
      // mask as teardrops, with a black outline that separates them from
      // a bright suit.
      // A cowl wants slits, not lenses: on a dark suit a round eye reads as
      // an owl. Squash it almost flat and let the tilt do the glaring.
      const slit = designId === "nightcape";
      eye.position.set(side * (slit ? 0.072 : 0.082), 0.174, slit ? 0.118 : 0.108);
      eye.scale.set(es * (slit ? 0.95 : 1.02), es * (slit ? 0.16 : 0.5), es * 0.34);
      eye.rotation.z = side * (slit ? -0.42 : -0.42);
      const rim = new THREE.Mesh(
        track(new THREE.SphereGeometry(0.055, 10, 8)),
        // A true black outline — the shared `dark` carries the accent in
        // its emissive, which glowed straight through the lens.
        new THREE.MeshStandardMaterial({ color: 0x0a0c12, roughness: 0.5, metalness: 0.1 }),
      );
      // `materials` is inferred as MeshStandardMaterial[] from its initialiser,
      // so widening this to Material fails the push. It IS a standard material
      // — it is constructed as one four lines up.
      materials.push(rim.material as THREE.MeshStandardMaterial);
      rim.castShadow = true;
      rim.position.copy(eye.position);
      rim.position.z -= 0.014;
      rim.scale.set(eye.scale.x * 1.22, eye.scale.y * 1.5, eye.scale.z * 0.9);
      rim.rotation.z = eye.rotation.z;
      head.add(rim);
    } else if (design.face === "muzzle") {
      // Separation has to grow with the eye, or a big-eyed animal ends up
      // with one bar across its face instead of two eyes. The base eye box is
      // 0.052 wide, so at eyeScale 2.6 each one reaches 0.068 from its own
      // centre and the fixed 0.062 offset overlapped them by a third. Half the
      // scaled width plus a fixed gap keeps a clear bridge at any size, and
      // stays at the hand-tuned 0.062 for everything under about 1.8 — which
      // is every muzzle that existed before Space Rex.
      const gap = Math.max(0.062, (0.052 * es) / 2 + 0.021);
      if (design.roundEyes) {
        // A cartoon eye is nearly spherical and sits proud of the skull, with
        // a dark rim behind it doing the work an outline does in 2D. Kept
        // narrower than the slit's gap because two big circles set as wide as
        // two bars reads as a frog.
        eye.position.set(side * Math.max(0.058, 0.022 * es + 0.03), 0.176, 0.124);
        eye.scale.set(es * 0.72, es * 0.78, es * 0.55);
        // The speck, up and inboard — the direction the key light comes from
        // in the shop portraits and in every world's morning sun. Parented to
        // the eye so it inherits the blink and never slides off.
        const spark = new THREE.Mesh(track(new THREE.SphereGeometry(0.055, 8, 6)), glow);
        spark.scale.setScalar(0.34);
        spark.position.set(-side * 0.016, 0.018, 0.042);
        eye.add(spark);
      } else {
        eye.position.set(side * gap, 0.185, 0.128);
        eye.scale.set(es, es * 0.9, es);
        eye.rotation.z = side * -0.2;
      }
    } else if (dots) {
      // Small, set close, and sitting almost flush — a drawn mark on a face
      // rather than a fitted component. Wide-set dots read as a bug.
      eye.position.set(side * 0.052, 0.168, 0.146);
      eye.scale.set(es * 0.4, es * 0.44, es * 0.24);
    } else {
      eye.position.set(side * 0.058, 0.163, 0.166);
      eye.rotation.z = side * -0.16; // a slight scowl, so it has an attitude
    }
    head.add(eye);
    eyes.push(eye);
  }
  // Chin light — catches the underside of the visor and gives the head a
  // second point of interest from below, which is where the camera is
  // whenever you're jumping.
  if (design.face === "visor") {
    const chin = mesh(new THREE.BoxGeometry(0.1, 0.014, 0.02), glow);
    chin.position.set(0, 0.098, 0.14);
    head.add(chin);
  }

  // Crest — three tapering fins with independent spring lag. This is the
  // single loudest piece of secondary motion; it sells acceleration.
  // Three fins running front-to-back along the crown, not stacked end to
  // end — stacking merged them into one thin antenna, which read as a
  // stray wire rather than as part of the character.
  const crestJoints: THREE.Group[] = [];
  if (design.crown === "cat-ears" || design.crown === "bat-ears" || design.crown === "horns") {
    // Ears and horns hang off their own joints so they inherit the crest
    // spring: they lag on acceleration and flick on hard turns, which is
    // most of what makes an animal head look alive.
    const bat = design.crown === "bat-ears";
    const horn = design.crown === "horns";
    for (const side of [-1, 1]) {
      const j = new THREE.Group();
      j.position.set(side * (horn ? 0.085 : 0.075), 0.235, horn ? -0.02 : 0);
      head.add(j);
      const len = bat ? 0.19 : horn ? 0.27 : 0.13;
      const ear = mesh(
        new THREE.ConeGeometry(bat ? 0.042 : horn ? 0.062 : 0.055, len, horn ? 5 : 4),
        horn ? plate : shell, // horns in the gold, so they read as horn not hide
      );
      ear.position.y = len / 2;
      ear.scale.z = bat ? 0.55 : 0.72;
      if (horn) ear.rotation.x = -0.5; // sweep them back over the skull
      // Bat ears stand tall and slightly back; cat ears splay; horns sweep back.
      j.rotation.z = side * (bat ? 0.16 : horn ? 0.34 : 0.3);
      j.rotation.x = bat ? -0.1 : horn ? 0.55 : -0.05;
      j.add(ear);
      if (!horn) {
        // Inner ear, in the accent — a cat without pink ears is a fox.
        const inner = mesh(new THREE.ConeGeometry(bat ? 0.024 : 0.033, len * 0.66, 4), glow);
        inner.position.set(0, len * 0.42, bat ? 0.012 : 0.02);
        inner.scale.z = 0.5;
        j.add(inner);
      }
      crestJoints.push(j);
    }
  } else if (design.crown === "fins") {
    let parent: THREE.Object3D = head;
    for (let i = 0; i < 3; i++) {
      const j = new THREE.Group();
      j.position.set(0, i === 0 ? 0.245 : 0, i === 0 ? 0.055 : -0.072);
      parent.add(j);
      // Flattened cones, tallest in front, so the crown has a profile.
      const fin = mesh(new THREE.ConeGeometry(0.045, 0.16 - i * 0.028, 4), glow);
      fin.position.y = (0.16 - i * 0.028) / 2;
      fin.scale.z = 1.5;
      fin.scale.x = 0.42;
      fin.rotation.x = -0.12 - i * 0.06;
      j.add(fin);
      crestJoints.push(j);
      parent = j;
    }
  } else if (design.crown === "antennae") {
    // Two thin stalks with a glowing bulb on the end. On the crest spring
    // they bob a beat behind the head, which is the entire read: nothing
    // else in the roster has a piece that light and that slow.
    for (const side of [-1, 1]) {
      const j = new THREE.Group();
      j.position.set(side * 0.055, 0.235, 0.01);
      head.add(j);
      j.rotation.z = side * 0.42;
      j.rotation.x = -0.14;
      const stalk = mesh(new THREE.CylinderGeometry(0.009, 0.013, 0.2, 5), plate);
      stalk.position.y = 0.1;
      j.add(stalk);
      const bulb = mesh(new THREE.SphereGeometry(0.032, 8, 6), glow);
      bulb.position.y = 0.21;
      j.add(bulb);
      crestJoints.push(j);
    }
  } else if (design.crown === "cap") {
    // A peaked cap, on a crest joint like everything else up here so it lags
    // a beat behind a hard turn. A cap welded to the skull is the difference
    // between a character wearing one and a character modelled with one.
    const j = new THREE.Group();
    j.position.set(0, 0.235, 0.01);
    j.rotation.x = -0.12;
    head.add(j);
    // A cap is navy all the way through. `dark` carries the accent in its
    // emissive — right for a visor, wrong here, where it gave a gold-badged
    // officer a gold peak.
    const capDark = new THREE.MeshStandardMaterial({
      color: new THREE.Color(design.plate).multiplyScalar(0.55),
      roughness: 0.55, metalness: 0.1, flatShading: true,
    });
    extraMaterials.push(capDark);
    // Ears out from under it, when there is an animal under the cap. A dog in
    // a police hat with no ears is a mannequin in a police hat.
    if (design.face === "muzzle") {
      for (const side of [-1, 1]) {
        const ear = mesh(new THREE.ConeGeometry(0.082, 0.26, 4), shell);
        ear.position.set(side * 0.142, 0.09, -0.02);
        ear.rotation.z = side * 0.42;
        ear.rotation.x = -0.12;
        ear.scale.z = 0.62;
        j.add(ear);
        const inner = mesh(new THREE.ConeGeometry(0.046, 0.16, 4), plate);
        inner.position.set(side * 0.15, 0.1, 0.014);
        inner.rotation.z = side * 0.42;
        inner.rotation.x = -0.12;
        inner.scale.z = 0.45;
        j.add(inner);
      }
    }
    // Crown, band, peak, star. Four pieces is the fewest that still reads as
    // police rather than as a baseball cap.
    const crown = mesh(new THREE.CylinderGeometry(0.155, 0.145, 0.085, 12), plate);
    crown.position.y = 0.055;
    j.add(crown);
    const lid = mesh(new THREE.CylinderGeometry(0.163, 0.163, 0.016, 12), plate);
    lid.position.y = 0.1;
    j.add(lid);
    const band = mesh(new THREE.CylinderGeometry(0.152, 0.152, 0.032, 12), capDark);
    band.position.y = 0.012;
    j.add(band);
    const peak = mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.014, 12, 1, false, -0.8, 1.6), capDark);
    peak.position.set(0, 0.006, 0.075);
    peak.scale.set(1, 1, 1.5);
    j.add(peak);
    const star = mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.012, 5), glow);
    star.rotation.x = Math.PI / 2 - 0.2;
    star.position.set(0, 0.055, 0.148);
    j.add(star);
    crestJoints.push(j);
  } else if (design.crown === "ring") {
    // A halo that is not attached to anything. It sits on a crest joint so
    // it lags through turns and settles a moment after you stop — a ring
    // welded to the skull reads as a hat, and this has to read as light.
    const j = new THREE.Group();
    j.position.set(0, 0.34, 0);
    head.add(j);
    const ring = mesh(new THREE.TorusGeometry(0.115, 0.016, 8, 24), glow);
    ring.rotation.x = Math.PI / 2 - 0.22; // tilted, so it is never a flat line
    j.add(ring);
    crestJoints.push(j);
  }

  // The bubble. Built AFTER the crown on purpose — the crest fins have to be
  // inside the glass, and a helmet that clips through them reads as a mistake
  // rather than as a helmet.
  if (design.helmet) {
    // Not in `materials`: that array is what `setAccent` re-tints, and glass
    // taking the accent turns the head into a coloured ball with nothing
    // visible inside it.
    const glass = new THREE.MeshStandardMaterial({
      color: 0xdff0ff,
      transparent: true,
      opacity: 0.22,
      roughness: 0.05,
      metalness: 0.1,
      // Front faces only. A double-sided sphere draws the back of the glass
      // over the face and halves the contrast on the one thing you are meant
      // to be looking at.
      side: THREE.FrontSide,
      // The dome is drawn over the head, and depth-writing transparent
      // geometry hides whatever is behind it whichever order they sort in.
      depthWrite: false,
    });
    extraMaterials.push(glass);
    const dome = new THREE.Mesh(track(new THREE.SphereGeometry(0.245, 20, 16)), glass);
    dome.position.y = 0.175;
    dome.scale.set(1, 1.06, 1);
    dome.renderOrder = 2; // after the face, always
    head.add(dome);

    // A hard specular streak across the top-left of the glass. Without it the
    // dome is a faint grey wash that reads as fog; one bright arc is what
    // makes a sphere read as a curved surface with a light on it.
    const gleamMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.5, side: THREE.FrontSide, depthWrite: false,
    });
    extraMaterials.push(gleamMat);
    const gleam = new THREE.Mesh(
      track(new THREE.SphereGeometry(0.248, 18, 14, 0.55, 0.62, 0.42, 0.5)),
      gleamMat,
    );
    gleam.position.copy(dome.position);
    gleam.renderOrder = 3;
    head.add(gleam);

    // The collar seal, which is what stops the bubble looking like a balloon
    // resting on the shoulders.
    const collar = mesh(new THREE.TorusGeometry(0.15, 0.032, 8, 18), plate);
    collar.rotation.x = Math.PI / 2;
    collar.position.y = -0.015;
    head.add(collar);
  }

  // Arms: shoulder → elbow → hand.
  type Arm = { shoulder: THREE.Group; elbow: THREE.Group; side: number };
  const arms: Arm[] = [];
  /**
   * Hands with no arm attached to them.
   *
   * A floating character with jointed arms looks like a biped someone deleted
   * the legs from — the shoulders still hinge, so the eye keeps looking for the
   * ground. Detached mitts hanging in space beside the body say "this thing has
   * no skeleton" in one frame, and they get to trail the body on a spring,
   * which no shoulder-mounted arm can do.
   */
  const floatHands: { pivot: THREE.Group; side: number }[] = [];
  if (plan === "hover") {
    /* Something has to hold it up, visibly. Without this the body reads as a
       character standing in a hole rather than one floating above the floor —
       a soft disc of accent under the belly is the cheapest possible way to
       say "there is nothing touching the ground here". */
    const wash = mesh(new THREE.CircleGeometry(0.22, 20), glow);
    wash.rotation.x = -Math.PI / 2;
    wash.position.y = -0.24;
    wash.scale.set(1, 1, 0.85);
    hips.add(wash);
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.3, 0.34, 0);
      torso.add(pivot);
      const mitt = mesh(new THREE.CapsuleGeometry(0.075, 0.1, 4, 12), shell);
      mitt.rotation.z = Math.PI / 2;
      mitt.scale.set(1, 1, 0.82);
      pivot.add(mitt);
      // A ring of accent where the arm would have been, so the gap is
      // deliberate rather than an unfinished shoulder.
      const cuff = mesh(new THREE.TorusGeometry(0.062, 0.011, 6, 14), glow);
      cuff.position.x = side * -0.075;
      cuff.rotation.y = Math.PI / 2;
      pivot.add(cuff);
      floatHands.push({ pivot, side });
    }
  } else if (plan === "waddle") {
    /* Flippers, not arms: one flat tapered paddle straight off the body with
       no elbow in it. The whole comic timing of a waddle is that the arms
       cannot help — they stick out and slap. */
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.235, 0.4, 0);
      torso.add(shoulder);
      const flipper = mesh(new THREE.CapsuleGeometry(0.052, 0.24, 4, 10), shell);
      flipper.position.y = -0.13;
      flipper.scale.set(1, 1, 0.42);
      shoulder.add(flipper);
      shoulder.rotation.z = side * -0.24;
      // No elbow group of its own — the update treats a flipper as one bone.
      arms.push({ shoulder, elbow: shoulder, side });
    }
  } else if (plan !== "astromech" && plan !== "rollerball" && plan !== "quad") {
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.245, 0.48, 0);
      torso.add(shoulder);
      /* A vinyl arm has no ball joint showing — but it does need something at
         the joint, or two cylinders of different radii meet in a visible step
         and the balloon has a seam cut into its elbow. So the sphere stays for
         everybody; on a soft body it is the SHELL colour and slightly proud of
         the limb, which reads as one continuous inflated tube. */
      shoulder.add(
        design.soft
          ? mesh(new THREE.SphereGeometry(0.088, 12, 10), shell)
          : mesh(new THREE.SphereGeometry(0.075, 8, 6), plate),
      );
      shoulder.add(limb(0.26, design.soft ? 0.085 : 0.062, design.soft ? 0.078 : 0.05, shell));

      const elbow = new THREE.Group();
      elbow.position.y = design.soft ? -0.235 : -0.26;
      shoulder.add(elbow);
      elbow.add(
        design.soft
          ? mesh(new THREE.SphereGeometry(0.083, 12, 10), shell)
          : mesh(new THREE.SphereGeometry(0.052, 8, 6), plate),
      );
      elbow.add(limb(0.24, design.soft ? 0.082 : 0.05, design.soft ? 0.072 : 0.042, shell));

      /* Lit bands round the limbs. Cheap, and the only decoration in the table
         that reads at silhouette distance on a dark character — it draws the
         arm swing as two moving lines when the body itself is a black shape. */
      if (design.glowRings) {
        const upper = mesh(new THREE.TorusGeometry(0.062, 0.011, 6, 14), glow);
        upper.position.y = -0.18;
        upper.rotation.x = Math.PI / 2;
        shoulder.add(upper);
        const fore = mesh(new THREE.TorusGeometry(0.05, 0.01, 6, 14), glow);
        fore.position.y = -0.13;
        fore.rotation.x = Math.PI / 2;
        elbow.add(fore);
      }

      const hand = mesh(
        design.soft
          ? new THREE.SphereGeometry(0.085, 10, 8)
          : new THREE.IcosahedronGeometry(0.068, 0),
        design.soft ? shell : plate,
      );
      hand.position.y = design.soft ? -0.24 : -0.26;
      elbow.add(hand);
      // Wrist band, so the arm swing has something bright to trace. A seamless
      // body does not wear one.
      if (!design.soft) {
        const band = mesh(new THREE.TorusGeometry(0.055, 0.014, 6, 12), glow);
        band.position.y = -0.225;
        band.rotation.x = Math.PI / 2;
        elbow.add(band);
      }

      arms.push({ shoulder, elbow, side });
    }
  }

  // Legs: hip → knee → foot.
  type Leg = { hip: THREE.Group; knee: THREE.Group; foot: THREE.Group; side: number };
  const legs: Leg[] = [];
  /** Rolling parts, for the tracked plan. Spun at real ground speed. */
  const wheels: THREE.Mesh[] = [];
  /** The astromech's two side struts, which rock rather than stride. */
  const legStruts: THREE.Group[] = [];
  /** Its centre foot, which lifts on the rock. */
  let centreFoot: THREE.Group | null = null;
  /** The rollerball's body, which is also its wheel. */
  let rollBall: THREE.Mesh | null = null;
  if (plan === "tread") {
    /**
     * A tracked base instead of legs.
     *
     * The hips group still exists and still carries the torso, so everything
     * above the waist — lean, bank, breathing, the crest springs — is unchanged
     * and free. What changes is that nothing down here is ever asked to take a
     * step, so there is no gait to skate: the wheels are driven straight off
     * ground speed, which is the one motion that is *always* right.
     */
    /* A waist between the body and the bogie.
       Without it the crate and the tracks are two separate objects a third of
       a metre apart, which is exactly how the first render came out: a box
       hovering over a skateboard. Everything down here is measured off HIP_Y
       so the assembly meets the bottom of the chest at one end and the floor
       at the other. */
    const waist = mesh(new THREE.BoxGeometry(0.32, 0.24, 0.3), plate);
    waist.position.y = -0.06;
    hips.add(waist);
    for (const side of [-1, 1]) {
      const track_ = new THREE.Group();
      track_.position.set(side * 0.19, -0.22, 0);
      hips.add(track_);
      // The belt: a long box with rounded caps faked by two cylinders.
      const belt = mesh(new THREE.BoxGeometry(0.15, 0.3, 0.44), plate);
      belt.position.y = 0.01;
      track_.add(belt);
      for (const end of [-1, 1]) {
        const drum = mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.155, 14), plate);
        drum.rotation.z = Math.PI / 2;
        drum.position.set(0, 0, end * 0.2);
        track_.add(drum);
        // Hub, which is the part that visibly turns.
        const hub = mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.17, 8), shell);
        hub.rotation.z = Math.PI / 2;
        hub.position.set(0, 0, end * 0.2);
        track_.add(hub);
        // One spoke per hub, so rotation is legible. A smooth cylinder
        // spinning looks identical to a still one.
        const spoke = mesh(new THREE.BoxGeometry(0.175, 0.026, 0.13), glow);
        spoke.position.set(0, 0, end * 0.2);
        hub.add(spoke);
        wheels.push(hub);
      }
      // Grousers along the belt: the detail that says "track" and not "box".
      for (let i = -2; i <= 2; i++) {
        const cleat = mesh(new THREE.BoxGeometry(0.165, 0.035, 0.055), shell);
        cleat.position.set(0, -0.155, i * 0.095);
        track_.add(cleat);
      }
    }
  } else if (plan === "astromech") {
    /**
     * Two legs on the outside of a barrel, and a foot in the middle.
     *
     * The point of this plan is that it has no hips and no knees: the legs are
     * rigid struts bolted to the sides of the body, so it cannot walk — it
     * *rocks*, pivoting over one foot and then the other, and the centre strut
     * is what keeps it from falling over while it does. Which is why the body
     * language reads as a machine improvising rather than a person walking.
     */
    for (const side of [-1, 1]) {
      const strut = new THREE.Group();
      strut.position.set(side * 0.22, 0.06, 0);
      hips.add(strut);
      const shoulderCap = mesh(new THREE.SphereGeometry(0.075, 10, 8), plate);
      strut.add(shoulderCap);
      const leg = mesh(new THREE.BoxGeometry(0.12, 0.36, 0.16), plate);
      leg.position.y = -0.2;
      strut.add(leg);
      const shin = mesh(new THREE.BoxGeometry(0.1, 0.16, 0.13), shell);
      shin.position.y = -0.44;
      strut.add(shin);
      const foot = mesh(new THREE.BoxGeometry(0.15, 0.09, 0.32), plate);
      foot.position.set(0, -0.53, 0.03);
      strut.add(foot);
      const skid = mesh(new THREE.BoxGeometry(0.155, 0.03, 0.33), glow);
      skid.position.set(0, -0.575, 0.03);
      strut.add(skid);
      legStruts.push(strut);
    }
    // The third leg, shorter and further forward, that makes the tripod work.
    const centre = new THREE.Group();
    centre.position.set(0, 0.02, 0.1);
    hips.add(centre);
    const post = mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.42, 8), plate);
    post.position.y = -0.24;
    centre.add(post);
    const pad = mesh(new THREE.BoxGeometry(0.14, 0.08, 0.24), shell);
    pad.position.y = -0.5;
    centre.add(pad);
    centreFoot = centre;
  } else if (plan === "rollerball") {
    /**
     * A ball, with a head that never touches it.
     *
     * The body IS the wheel — it spins forward at real ground speed and rolls
     * with the bank — and the head rides on top on nothing at all, staying
     * upright while the thing under it turns over. Nothing else in the table
     * moves like this, because nothing else has a part that spins freely under
     * a part that does not.
     */
    const ball = mesh(new THREE.SphereGeometry(0.42, 20, 16), shell);
    hips.add(ball);
    /* Panel bands ON the surface, not inside it.
       The first pass put three shrinking rings at increasing heights, which
       described a cone through the middle of the sphere — all of it buried,
       and the ball rendered as a blank white egg that gave no sign it was
       turning. A latitude band's radius is sqrt(r² − y²); anything else is
       geometry nobody sees. */
    const R = 0.42;
    for (const y of [-0.19, 0, 0.19]) {
      const r = Math.sqrt(R * R - y * y);
      const ring = mesh(new THREE.TorusGeometry(r, 0.022, 8, 24), plate);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      ball.add(ring);
    }
    // Three lit discs around the equator, so the spin is unmistakable.
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const dot = mesh(new THREE.CircleGeometry(0.085, 14), glow);
      dot.position.set(Math.sin(a) * R * 0.99, 0.08, Math.cos(a) * R * 0.99);
      dot.rotation.y = a;
      ball.add(dot);
    }
    rollBall = ball;
  } else if (plan === "quad") {
    /* Four legs on one stride, diagonally paired — front-left with rear-right,
       the trot every four-legged animal defaults to. The rig's own solver does
       the work; all this changes is where the hips are and how many there are. */
    for (const side of [-1, 1]) {
      for (const end of [-1, 1]) {
        const hip = new THREE.Group();
        hip.position.set(side * 0.17, -0.02, end * 0.24);
        hips.add(hip);
        hip.add(mesh(new THREE.SphereGeometry(0.062, 8, 6), plate));
        hip.add(limb(0.24, 0.058, 0.045, shell));
        const knee = new THREE.Group();
        knee.position.y = -0.24;
        hip.add(knee);
        knee.add(mesh(new THREE.SphereGeometry(0.048, 8, 6), plate));
        knee.add(limb(0.22, 0.045, 0.036, shell));
        const foot = new THREE.Group();
        foot.position.y = -0.22;
        knee.add(foot);
        const paw = mesh(new THREE.BoxGeometry(0.1, 0.06, 0.15), plate);
        paw.position.set(0, -0.03, 0.02);
        foot.add(paw);
        /* Diagonal pairs share a phase: side*end is +1 for two of the four
           legs and -1 for the other two, which is the trot for free. */
        legs.push({ hip, knee, foot, side: side * end });
      }
    }
  } else if (plan !== "hover") {
    /* Waddle: legs half the length, set wide, with a foot that is nearly all
       toe. A short leg cannot stride, which is the point — the walk has to
       come from the roll instead, and that is what makes it funny. */
    const short = plan === "waddle";
    const thigh = short ? 0.16 : 0.36;
    const shin = short ? 0.14 : 0.34;
    for (const side of [-1, 1]) {
      const hip = new THREE.Group();
      /* Hips at the top of the hips group, not partway down it. The stubby
         legs were being hung from -0.3, which is most of their own length
         below the body: the render was a penguin walking along under a
         penguin-shaped balloon it was not attached to. */
      hip.position.set(side * (short ? 0.135 : 0.115), short ? -0.02 : -0.04, 0);
      hips.add(hip);
      if (!design.soft) hip.add(mesh(new THREE.SphereGeometry(0.078, 8, 6), plate));
      hip.add(limb(thigh, design.soft ? 0.105 : 0.075, design.soft ? 0.098 : 0.058, shell));

      const knee = new THREE.Group();
      knee.position.y = -thigh;
      hip.add(knee);
      if (!design.soft) knee.add(mesh(new THREE.SphereGeometry(0.058, 8, 6), plate));
      knee.add(limb(shin, design.soft ? 0.1 : 0.055, design.soft ? 0.092 : 0.045, shell));

      const foot = new THREE.Group();
      foot.position.y = -shin;
      knee.add(foot);
      const boot = mesh(
        new THREE.BoxGeometry(short ? 0.15 : 0.13, 0.075, short ? 0.3 : 0.235),
        short ? glow : plate,
      );
      boot.position.set(0, -0.035, short ? 0.075 : 0.045);
      foot.add(boot);
      // The bright sole is a machine detail. On a webbed foot it is the foot.
      if (!short) {
        const sole = mesh(new THREE.BoxGeometry(0.135, 0.022, 0.24), glow);
        sole.position.set(0, -0.074, 0.045);
        foot.add(sole);
      }

      legs.push({ hip, knee, foot, side });
    }
  }

  // Scarf — a chain of quads, each lagging the one above it. Cheap, and
  // it turns every direction change into something you can read.
  // Scarf. It hangs off the LEFT shoulder rather than down the spine —
  // City straps a jetpack to the player's back, which swallowed a
  // centred scarf whole, so the one piece of secondary motion you'd see
  // most often was invisible exactly when the pack was equipped.
  const scarfJoints: THREE.Group[] = [];
  if (design.trail === "scarf") {
    let parent: THREE.Object3D = torso;
    const SEGS = 6;
    for (let i = 0; i < SEGS; i++) {
      const j = new THREE.Group();
      j.position.set(i === 0 ? -0.17 : 0, i === 0 ? 0.48 : -0.145, i === 0 ? -0.05 : 0);
      if (i === 0) j.rotation.z = -0.3; // sweep it clear of the arm
      parent.add(j);
      const w = 0.22 * (1 - i * 0.1);
      const panel = new THREE.Mesh(track(new THREE.PlaneGeometry(w, 0.155)), cloth);
      panel.position.y = -0.078;
      j.add(panel);
      scarfJoints.push(j);
      parent = j;
    }
    // Collar, so the scarf reads as worn rather than stuck on.
    const collar = mesh(new THREE.TorusGeometry(0.115, 0.028, 6, 14), cloth);
    collar.position.y = 0.5;
    collar.rotation.x = Math.PI / 2;
    collar.scale.set(1, 0.8, 1);
    torso.add(collar);
  } else if (design.trail === "cape") {
    // A full cape off both shoulders. Same chain as the scarf, but wide
    // and centred: it billows on acceleration and sweeps through turns,
    // which is the entire reason to wear one.
    let parent: THREE.Object3D = torso;
    const SEGS = 5;
    for (let i = 0; i < SEGS; i++) {
      const j = new THREE.Group();
      j.position.set(0, i === 0 ? 0.52 : -0.21, i === 0 ? -0.11 : 0);
      parent.add(j);
      // Widens slightly then tapers — a trapezoid reads as cloth, a
      // rectangle reads as a plank.
      const w = 0.44 + Math.sin((i / SEGS) * Math.PI) * 0.2 - i * 0.02;
      const panel = new THREE.Mesh(track(new THREE.PlaneGeometry(w, 0.225)), cloth);
      panel.position.y = -0.112;
      j.add(panel);
      scarfJoints.push(j);
      parent = j;
    }
    // Shoulder mantle so the cape has a visible anchor.
    const mantle = mesh(new THREE.CylinderGeometry(0.235, 0.2, 0.1, 10, 1, true), cloth);
    mantle.position.set(0, 0.5, -0.02);
    torso.add(mantle);
  } else if (design.trail === "tail") {
    // A tail is the same chain again, but it grows from the base of the
    // spine and is solid rather than cloth — so it swings with weight.
    const dragon = design.heavyTail ?? false;
    let parent: THREE.Object3D = hips;
    const SEGS = 7;
    for (let i = 0; i < SEGS; i++) {
      const j = new THREE.Group();
      j.position.set(0, i === 0 ? 0.02 : 0, i === 0 ? -0.15 : -(dragon ? 0.17 : 0.145));
      if (i === 0) j.rotation.x = dragon ? 0.35 : -0.55; // cats carry it up
      parent.add(j);
      const r = (dragon ? 0.075 : 0.055) * (1 - i / (SEGS + 1.5));
      const seg = mesh(
        new THREE.CylinderGeometry(r, r * 0.86, dragon ? 0.17 : 0.145, 7),
        shell,
      );
      seg.rotation.x = Math.PI / 2;
      seg.position.z = -(dragon ? 0.085 : 0.072);
      j.add(seg);
      if (dragon && i > 1) {
        // Dorsal spikes down the back half of the tail.
        const spike = mesh(new THREE.ConeGeometry(0.028, 0.07, 4), plate);
        spike.position.set(0, r + 0.02, -0.085);
        spike.rotation.x = -0.4;
        j.add(spike);
      }
      if (!dragon && i === SEGS - 1) {
        // White tip — it's what your eye tracks when the tail whips.
        const tip = mesh(new THREE.SphereGeometry(r * 1.25, 8, 6), plate);
        tip.position.z = -0.15;
        j.add(tip);
      }
      scarfJoints.push(j);
      parent = j;
    }
  }

  // Chest emblem — a flattened plate the eye locks onto immediately.
  if (design.emblem) {
    const wing = track(new THREE.ConeGeometry(0.085, 0.13, 3));
    for (const side of [-1, 1]) {
      const half = new THREE.Mesh(wing, glow);
      half.position.set(side * 0.052, 0.33, 0.175);
      half.rotation.z = side * (Math.PI / 2) * 0.92;
      half.scale.set(0.62, 1, 0.24);
      torso.add(half);
    }
    const body = mesh(new THREE.SphereGeometry(0.045, 8, 6), glow);
    body.position.set(0, 0.335, 0.178);
    body.scale.set(0.55, 0.85, 0.25);
    torso.add(body);
  }

  // Suit piping — thin dark lines fanning over the chest. Cheap, and it
  // turns a flat red torso into a *suit*.
  if (design.piping) {
    const line = track(new THREE.BoxGeometry(0.006, 0.3, 0.006));
    for (let i = -2; i <= 2; i++) {
      const l = new THREE.Mesh(line, dark);
      l.position.set(i * 0.055, 0.3, 0.155);
      l.rotation.z = i * 0.12;
      l.rotation.x = -0.25;
      torso.add(l);
    }
    for (let i = 0; i < 3; i++) {
      const ring = mesh(new THREE.TorusGeometry(0.09 + i * 0.05, 0.005, 4, 14, Math.PI), dark);
      ring.position.set(0, 0.34 - i * 0.02, 0.15 - i * 0.01);
      ring.rotation.x = -0.25 + i * 0.05;
      torso.add(ring);
    }
  }

  /* Shoulder armour. Two curved caps sitting proud of the shoulders, which is
     most of what makes any silhouette read as heavy: the widest point of the
     body moves from the hips to the shoulders and the whole outline inverts. */
  if (design.pauldrons) {
    for (const side of [-1, 1]) {
      const pad = mesh(new THREE.SphereGeometry(0.135, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.62), plate);
      pad.position.set(side * 0.25, 0.5, 0);
      pad.rotation.z = side * 0.32;
      pad.scale.set(1, 0.85, 1.05);
      torso.add(pad);
      const trim = mesh(new THREE.TorusGeometry(0.115, 0.012, 6, 16), glow);
      trim.position.set(side * 0.25, 0.46, 0);
      trim.rotation.x = Math.PI / 2;
      trim.rotation.y = side * 0.3;
      torso.add(trim);
    }
  }

  /* A pack, and two nozzles under it. Purely a back detail, and back details
     matter more here than anywhere else: the chase camera spends most of its
     life looking at exactly this. */
  if (design.jetpack) {
    const pack = mesh(new THREE.BoxGeometry(0.26, 0.3, 0.13), plate);
    pack.position.set(0, 0.38, -0.19);
    torso.add(pack);
    for (const side of [-1, 1]) {
      const tank = mesh(new THREE.CapsuleGeometry(0.055, 0.18, 4, 10), shell);
      tank.position.set(side * 0.085, 0.4, -0.24);
      torso.add(tank);
      const nozzle = mesh(new THREE.CylinderGeometry(0.045, 0.03, 0.08, 8), dark);
      nozzle.position.set(side * 0.085, 0.24, -0.23);
      torso.add(nozzle);
      const flame = mesh(new THREE.SphereGeometry(0.032, 8, 6), glow);
      flame.position.set(side * 0.085, 0.2, -0.23);
      torso.add(flame);
    }
  }

  /* A ruff at the shoulders and the hips. Fur is not a texture problem here —
     at this poly count it is a *silhouette* problem, so it is spikes around the
     outline rather than anything on the surface. */
  if (design.fur) {
    const tuft = track(new THREE.ConeGeometry(0.055, 0.19, 5));
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const f = new THREE.Mesh(tuft, shell);
      f.castShadow = true;
      f.position.set(Math.sin(a) * 0.23, 0.44 + Math.cos(a * 3) * 0.03, Math.cos(a) * 0.18);
      f.rotation.set(Math.cos(a) * 0.8, a, -Math.sin(a) * 0.8);
      torso.add(f);
    }
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const f = new THREE.Mesh(tuft, shell);
      f.castShadow = true;
      f.scale.setScalar(0.8);
      f.position.set(Math.sin(a) * 0.2, 0.13, Math.cos(a) * 0.16);
      f.rotation.set(Math.cos(a) * 0.6 + 2.4, a, -Math.sin(a) * 0.6);
      torso.add(f);
    }
  }

  // Wings — membranes on their own joints, folded when grounded and
  // spread when airborne, with a beat driven by vertical speed.
  const wingJoints: THREE.Group[] = [];
  if (design.wings) {
    const membrane = new THREE.MeshStandardMaterial({
      color: design.cloth, roughness: 0.9, metalness: 0,
      side: THREE.DoubleSide, flatShading: true,
    });
    materials.push(membrane);
    for (const side of [-1, 1]) {
      const j = new THREE.Group();
      j.position.set(side * 0.18, 0.46, -0.1);
      torso.add(j);
      // Leading-edge bone out to the tip, with finger struts.
      const bone = mesh(new THREE.CylinderGeometry(0.026, 0.012, 0.62, 5), plate);
      bone.rotation.z = side * -Math.PI / 2;
      bone.position.set(side * 0.31, 0.04, 0);
      j.add(bone);
      // One big membrane behind the bone rather than three little flags —
      // a wing is a surface, and the earlier fan read as loose sticks.
      const web = new THREE.Mesh(track(new THREE.PlaneGeometry(0.62, 0.5)), membrane);
      web.position.set(side * 0.3, -0.19, -0.05);
      web.rotation.y = side * 0.22;
      web.rotation.x = 0.1;
      j.add(web);
      // Finger struts fanning down the trailing edge, so it reads as bat-wing.
      for (let i = 0; i < 3; i++) {
        const strut = mesh(new THREE.CylinderGeometry(0.011, 0.006, 0.38 - i * 0.06, 4), plate);
        strut.position.set(side * (0.14 + i * 0.16), -0.17, -0.03);
        strut.rotation.z = side * (0.5 - i * 0.16);
        j.add(strut);
      }
      wingJoints.push(j);
    }
  }

  group.add(root);

  // ---- Animation state ----------------------------------------------
  let stridePhase = 0;      // radians; one full cycle = two steps
  let t = 0;                // seconds since spawn
  let bank = 0, bankV = 0;  // roll into turns
  let lean = 0, leanV = 0;  // pitch from acceleration
  let squash = 1;           // 1 = neutral; <1 compressed after a landing
  let squashV = 0;
  let smoothSpeed = 0;
  let prevSpeed = 0;
  let prevGrounded = true;
  let airTime = 0;
  /** Hover bob + hand trail state, and the rolling angle of a tracked base. */
  let hoverPhase = Math.random() * Math.PI * 2;
  let wheelSpin = 0;
  const handLag = floatHands.map(() => 0), handLagV = floatHands.map(() => 0);
  // Crest/scarf springs: angle + velocity per joint.
  /**
   * Which way a negative `drag` swings this character's trail.
   *
   * The crest grows UP off the head and the cloth hangs DOWN off the
   * shoulders, so one x-rotation means opposite things to them: on the crest
   * a negative angle tips it backward (right), and on a cape it swings the
   * hem *forward, across the chest* (wrong — and that is exactly what the
   * cape had been doing since it was written, most visibly on Nightcape).
   *
   * A tail is neither: it grows BACK along -Z, so the same rotation is a lift
   * rather than a sweep, and the sign it already had — dropping under speed —
   * is fine. Hence a per-trail sign rather than a blanket flip.
   */
  const trailSign = design.trail === "tail" ? 1 : -1;

  const crestA = crestJoints.map(() => 0), crestV = crestJoints.map(() => 0);
  /* The pose each crest piece was BUILT in — cat ears splayed, horns swept
     back, antennae angled out. The animation below writes rotation.x and .z
     outright, so without this it flattened every one of them to zero on the
     first frame and a cat's ears stood up in a single straight line. Base
     plus animation, not animation instead of it. */
  const crestBase = crestJoints.map((j) => ({ x: j.rotation.x, z: j.rotation.z }));
  const scarfA = scarfJoints.map(() => 0), scarfV = scarfJoints.map(() => 0);
  // Rest pose the scarf was built in — the bank is applied on top of it,
  // not instead of it.
  const scarfRestZ = scarfJoints.map((j) => j.rotation.z);
  // Idle direction: blinks and glances fire on their own irregular clocks
  // so the idle never resolves into a visible loop.
  let blinkAt = 2 + Math.random() * 3;
  let blinkFor = 0;
  let glanceAt = 4 + Math.random() * 5;
  let glanceYaw = 0, glanceHold = 0;
  let weightShift = 0;

  const update = (dt: number, f: PilotFrame) => {
    // Guard against tab-switch hitches — a 4-second dt would fling every
    // spring in the rig to infinity.
    dt = Math.min(dt, 0.05);
    t += dt;

    smoothSpeed = approach(smoothSpeed, f.speed, 12, dt);
    const accel = (f.speed - prevSpeed) / Math.max(dt, 1e-4);
    prevSpeed = f.speed;

    // ---- Gait ---------------------------------------------------------
    // Stride frequency rises with the SQUARE ROOT of speed, which is how
    // legs actually work: doubling speed lengthens the stride more than
    // it quickens it. That's what keeps the feet from skating.
    const gait = Math.min(smoothSpeed / 9, 1.35);          // 0..1.35 walk→sprint
    const freq = 2.1 * Math.sqrt(Math.max(gait, 0.0001)) + gait * 1.5;
    if (f.grounded && !f.thrusting) stridePhase += dt * freq * Math.PI * 2;
    const moving = gait > 0.035;
    const swing = Math.min(gait * 1.05, 0.95);              // stride amplitude

    if (!f.grounded) airTime += dt; else airTime = 0;

    // ---- Landing squash ------------------------------------------------
    if (f.grounded && !prevGrounded) {
      // Impact scales with the fall we just absorbed, capped so a long
      // drop doesn't fold Flux into the floor.
      const impact = Math.min(Math.abs(f.verticalVel) / 26, 1);
      squash = 1 - 0.32 * impact;
      squashV = 0;
    }
    prevGrounded = f.grounded;
    squashV = spring(squash, 1, squashV, 210, 16, dt);
    squash += squashV * dt;
    // Volume-preserving-ish: what the body loses in height it gains in width.
    // `chunk` rides along here rather than being set once at build time: this
    // line writes root.scale outright every frame, so a build-time scale was
    // silently thrown away on the first update — which is why the knob had
    // been declared and had no effect on anything. Root's origin is between
    // the feet, so scaling about it keeps them planted.
    root.scale.set(
      chunk * (1 + (1 - squash) * 0.55),
      chunk * squash,
      chunk * (1 + (1 - squash) * 0.55),
    );

    // ---- Bank + lean ---------------------------------------------------
    // Bank comes from yaw rate (lean into the corner), lean from
    // acceleration (lean into the launch, rock back on the brakes).
    const bankTarget = THREE.MathUtils.clamp(-f.yawRate * 0.16, -0.42, 0.42) * Math.min(gait * 1.6, 1);
    bankV = spring(bank, bankTarget, bankV, 90, 13, dt);
    bank += bankV * dt;
    const leanTarget = f.thrusting
      ? 0.22
      : THREE.MathUtils.clamp(accel * 0.012, -0.22, 0.3) + gait * 0.16;
    leanV = spring(lean, leanTarget, leanV, 80, 13, dt);
    lean += leanV * dt;

    // ---- Hips ----------------------------------------------------------
    // Vertical bob peaks twice per stride (once per footfall); lateral
    // sway peaks once, on the loaded leg.
    const bob = moving ? Math.sin(stridePhase * 2) * 0.035 * swing : 0;
    const sway = moving ? Math.sin(stridePhase) * 0.03 * swing : 0;
    // Idle weight shift: settle onto alternating hips on a slow, prime-ish
    // period so it never lines up with the breathing.
    weightShift = approach(weightShift, moving ? 0 : Math.sin(t * 0.55) * 0.028, 3, dt);
    const breathe = moving ? 0 : Math.sin(t * 1.35) * 0.012;

    if (plan === "hover") {
      /* Nothing here is a footfall, so none of the stride terms apply. A
         hoverer's whole idle is a slow figure-of-eight drift on two periods
         that never line up, and its "walk" is a nose-down pitch and a hard
         bank — an aircraft, not a body. The bob keeps going at speed, where a
         biped's would be replaced by the gait. */
      hoverPhase += dt * (0.9 + gait * 0.5);
      hips.position.set(
        Math.sin(hoverPhase * 0.61) * 0.035,
        HIP_Y + Math.sin(hoverPhase) * 0.055 + gait * 0.04,
        0,
      );
      hips.rotation.z = bank * 1.7;
      hips.rotation.y = Math.sin(hoverPhase * 0.43) * 0.06;
      hips.rotation.x = lean * 0.9 + gait * 0.12;
    } else if (plan === "tread") {
      /* Tracks do not bob and do not sway — that is the entire read. What a
         tracked thing does instead is pitch against its own acceleration,
         because the mass is up top and the drive is at the floor: it noses
         down when it pulls away and rocks back when it stops. */
      wheelSpin += dt * f.speed * 5.4;
      for (const w of wheels) w.rotation.x = wheelSpin;
      hips.position.set(0, HIP_Y + (moving ? Math.sin(t * 9 + hoverPhase) * 0.006 : 0), 0);
      hips.rotation.z = bank * 0.5;
      hips.rotation.y = 0;
      hips.rotation.x = lean * 0.75 + THREE.MathUtils.clamp(accel * 0.008, -0.16, 0.2);
    } else if (plan === "astromech") {
      /* It cannot walk — the legs are rigid struts with no knee in them. So it
         rocks: the body tips onto one strut, the other lifts, and the centre
         foot picks up as it goes. Standing still it settles level and hums,
         which is the whole personality. */
      const rock = moving ? Math.sin(stridePhase * 0.6) : 0;
      hips.position.set(rock * 0.045 * swing, HIP_Y + Math.abs(rock) * 0.02 * swing, 0);
      hips.rotation.z = bank * 0.4 + rock * 0.2 * swing;
      hips.rotation.y = 0;
      hips.rotation.x = lean * 0.5;
      for (let i = 0; i < legStruts.length; i++) {
        const s = legStruts[i];
        const dir = i === 0 ? 1 : -1;
        s.rotation.z = -rock * 0.18 * swing * dir;
        s.position.y = 0.06 + Math.max(0, rock * dir) * 0.05 * swing;
      }
      // The centre foot retracts at speed and drops when it stops.
      if (centreFoot) centreFoot.position.y = 0.02 - (moving ? 0 : 0.0) + gait * 0.09;
    } else if (plan === "rollerball") {
      /* The body is the wheel. It spins at real ground speed about its own
         centre, and the head — parented above rather than to it — is left
         upright, which is the trick the whole design rests on. */
      if (rollBall) {
        rollBall.rotation.x += dt * f.speed * 2.4;
        rollBall.rotation.z = -bank * 0.6;
      }
      hips.position.set(0, HIP_Y, 0);
      hips.rotation.z = bank * 0.7;
      hips.rotation.y = 0;
      hips.rotation.x = 0;
      // The head leans into the direction of travel, the way a rider would.
      torso.position.y = 0;
      torso.rotation.z = -bank * 0.5;
    } else if (plan === "quad") {
      /* A trot. The diagonal pairs already share a phase from how the legs were
         built, so the body only has to do the rest: less roll than a biped,
         more pitch, and a bob at twice the stride because four feet land
         twice as often. */
      hips.position.set(0, HIP_Y + (moving ? Math.sin(stridePhase * 2) * 0.028 * swing : breathe), 0);
      hips.rotation.z = bank * 0.6 + (moving ? Math.sin(stridePhase) * 0.06 * swing : 0);
      hips.rotation.y = moving ? Math.sin(stridePhase) * 0.05 * swing : 0;
      hips.rotation.x = lean * 0.4 + (moving ? Math.sin(stridePhase * 2) * 0.05 * swing : 0);
    } else if (plan === "waddle") {
      /* The roll IS the walk. Legs this short cannot cover ground, so the
         body throws its weight side to side and the feet follow — which is
         why the sway is six times a biped's and the vertical bob rides on the
         same period as the roll rather than double it. */
      const roll = moving ? Math.sin(stridePhase) : 0;
      hips.position.set(roll * 0.055 * swing + weightShift, HIP_Y + Math.abs(roll) * 0.03 * swing + breathe, 0);
      hips.rotation.z = bank * 0.5 + roll * 0.26 * swing + (moving ? 0 : weightShift * 1.6);
      hips.rotation.y = roll * 0.16 * swing;
      hips.rotation.x = lean * 0.3;
    } else {
      hips.position.set(sway + weightShift, HIP_Y + bob + breathe, 0);
      hips.rotation.z = bank + (moving ? Math.sin(stridePhase) * 0.05 * swing : weightShift * 1.6);
      hips.rotation.y = moving ? Math.sin(stridePhase) * 0.22 * swing : 0;
      hips.rotation.x = lean * 0.35;
    }

    // Torso counter-twists against the hips — the thing that separates a
    // walk from a shuffle.
    torso.rotation.y = moving ? -Math.sin(stridePhase) * 0.3 * swing : 0;
    torso.rotation.x = lean * 0.5 + (moving ? 0 : Math.sin(t * 1.35) * 0.01);
    torso.rotation.z = -bank * 0.35;

    // ---- Legs -----------------------------------------------------------
    for (const leg of legs) {
      const ph = stridePhase + (leg.side < 0 ? 0 : Math.PI);
      if (f.thrusting) {
        // Hover: knees tucked, feet trailing.
        leg.hip.rotation.x = approach(leg.hip.rotation.x, -0.55 + Math.sin(t * 2 + leg.side) * 0.05, 8, dt);
        leg.knee.rotation.x = approach(leg.knee.rotation.x, 0.95, 8, dt);
        leg.foot.rotation.x = approach(leg.foot.rotation.x, 0.35, 8, dt);
      } else if (!f.grounded) {
        // Airborne: tuck on the way up, reach for the ground on the way
        // down. Blended by airtime so a hop doesn't snap into a skydive.
        const falling = THREE.MathUtils.clamp(-f.verticalVel / 14, 0, 1);
        const blend = Math.min(airTime * 5, 1);
        const tuck = -0.75 + falling * 1.0;
        const bend = 1.15 - falling * 0.85;
        const split = leg.side * 0.12 * (1 - falling);
        leg.hip.rotation.x = approach(leg.hip.rotation.x, tuck + split, 9 * blend + 2, dt);
        leg.knee.rotation.x = approach(leg.knee.rotation.x, bend, 9 * blend + 2, dt);
        leg.foot.rotation.x = approach(leg.foot.rotation.x, -0.15 + falling * 0.4, 8, dt);
      } else if (moving) {
        const s = Math.sin(ph), c = Math.cos(ph);
        // Thigh swings fore/aft; the knee only bends on the return arc
        // (max(0, ...)), which is what stops the classic "wading" look.
        leg.hip.rotation.x = s * 0.72 * swing;
        leg.knee.rotation.x = Math.max(0, -c * 0.5 + 0.28) * 1.35 * swing;
        // Toe-off at the back of the stride, heel-strike at the front.
        leg.foot.rotation.x = (-s * 0.3 - Math.max(0, c) * 0.22) * swing;
        leg.hip.rotation.z = leg.side * 0.02;
      } else {
        // Idle: a soft stance, weight rocking between the legs.
        const load = leg.side * weightShift * 6;
        leg.hip.rotation.x = approach(leg.hip.rotation.x, 0.03 + load * 0.1, 6, dt);
        leg.knee.rotation.x = approach(leg.knee.rotation.x, 0.09 - load * 0.12, 6, dt);
        leg.foot.rotation.x = approach(leg.foot.rotation.x, -0.05, 6, dt);
        leg.hip.rotation.z = approach(leg.hip.rotation.z, leg.side * 0.045, 6, dt);
      }
    }

    // A single eye sweeping its slot. Slow, and never quite reaching the end.
    if (scanBar) scanBar.position.x = Math.sin(t * 1.6) * 0.075;

    // ---- Detached hands ----------------------------------------------------
    /* They have no shoulder, so they cannot swing — they LAG. Each one is a
       spring fed by the body's own acceleration, dragging behind on the way
       out and overshooting on the way back, which is the entire reason to cut
       the arms off in the first place. */
    for (let i = 0; i < floatHands.length; i++) {
      const h = floatHands[i];
      const target = THREE.MathUtils.clamp(-accel * 0.02, -0.5, 0.5) - gait * 0.3;
      handLagV[i] = spring(handLag[i], target, handLagV[i], 55, 9, dt);
      handLag[i] += handLagV[i] * dt;
      h.pivot.rotation.x = handLag[i];
      // Splay out with speed and swing wide on the outside of a turn.
      h.pivot.position.x = h.side * (0.3 + gait * 0.05);
      h.pivot.position.y = 0.34 + Math.sin(hoverPhase * 1.3 + i) * 0.02;
      h.pivot.rotation.z = -bank * 0.8 + h.side * gait * 0.12;
    }

    // ---- Arms -------------------------------------------------------------
    for (const arm of arms) {
      const ph = stridePhase + (arm.side < 0 ? Math.PI : 0); // opposite the leg
      if (plan === "waddle") {
        /* One bone, no elbow — `elbow` and `shoulder` are the same Group on a
           flipper, so the generic path below would write rotation.x twice and
           the second would win. A flipper does not swing with the stride
           either: it holds out from the body and slaps on the roll. */
        const s = Math.sin(ph);
        arm.shoulder.rotation.x = s * 0.3 * swing;
        arm.shoulder.rotation.z = approach(
          arm.shoulder.rotation.z,
          arm.side * (-0.24 - swing * 0.34) + bank * 0.3,
          9, dt,
        );
        continue;
      }
      if (f.thrusting) {
        // Arms back and out, like the thrust is coming off the palms.
        arm.shoulder.rotation.x = approach(arm.shoulder.rotation.x, 0.9, 8, dt);
        arm.shoulder.rotation.z = approach(arm.shoulder.rotation.z, arm.side * 0.5, 8, dt);
        arm.elbow.rotation.x = approach(arm.elbow.rotation.x, -0.5, 8, dt);
      } else if (!f.grounded) {
        const falling = THREE.MathUtils.clamp(-f.verticalVel / 14, 0, 1);
        // Up: arms tight. Down: arms out for balance.
        arm.shoulder.rotation.x = approach(arm.shoulder.rotation.x, -0.5 + falling * 0.35, 9, dt);
        arm.shoulder.rotation.z = approach(arm.shoulder.rotation.z, arm.side * (0.18 + falling * 0.75), 9, dt);
        arm.elbow.rotation.x = approach(arm.elbow.rotation.x, -0.9 + falling * 0.55, 9, dt);
      } else {
        const s = Math.sin(ph);
        arm.shoulder.rotation.x = s * 0.62 * swing + (moving ? 0 : Math.sin(t * 1.35 + arm.side) * 0.02);
        // Elbows stay bent and bend MORE on the forward swing — arms that
        // stay ruler-straight are the giveaway of a cheap walk cycle.
        arm.elbow.rotation.x = -0.22 - Math.max(0, s) * 0.75 * swing;
        arm.shoulder.rotation.z = approach(
          arm.shoulder.rotation.z,
          arm.side * (0.13 + swing * 0.1) + bank * 0.3,
          8, dt,
        );
      }
    }

    // ---- Head -------------------------------------------------------------
    // Counter the bob so the head stays level (real necks stabilise the
    // eyes), then add the glance and a small lead into turns.
    glanceAt -= dt;
    if (glanceAt <= 0 && moving === false) {
      glanceYaw = (Math.random() - 0.5) * 1.0;
      glanceHold = 0.9 + Math.random() * 1.4;
      glanceAt = 5 + Math.random() * 7;
    }
    if (glanceHold > 0) glanceHold -= dt; else glanceYaw = approach(glanceYaw, 0, 3, dt);
    if (moving) glanceYaw = approach(glanceYaw, 0, 6, dt);

    neck.rotation.x = approach(
      neck.rotation.x,
      -lean * 0.65 - bob * 1.4 + (f.grounded ? 0 : THREE.MathUtils.clamp(-f.verticalVel / 30, -0.25, 0.25)),
      10, dt,
    );
    neck.rotation.y = approach(neck.rotation.y, glanceYaw - THREE.MathUtils.clamp(f.yawRate * 0.09, -0.3, 0.3), 8, dt);
    neck.rotation.z = approach(neck.rotation.z, -bank * 0.45, 8, dt);

    // Blink — eyelids are just the eye spheres squashing flat.
    blinkAt -= dt;
    if (blinkAt <= 0) {
      blinkFor = 0.11;
      // Double-blinks happen; a fixed cadence never looks alive.
      blinkAt = Math.random() < 0.22 ? 0.22 : 2.2 + Math.random() * 4;
    }
    if (blinkFor > 0) blinkFor -= dt;
    const lid = blinkFor > 0 ? 0.12 : 1;
    for (const eye of eyes) eye.scale.y = approach(eye.scale.y, lid, 40, dt);

    // Chest core pulse — faster when you're moving, like it's working.
    const pulse = 1 + Math.sin(t * (2.2 + gait * 3)) * 0.14;
    core.scale.setScalar(pulse);
    glow.emissiveIntensity = 1.35 + Math.sin(t * (2.2 + gait * 3)) * 0.3;

    // ---- Secondary motion: crest + scarf ------------------------------------
    // Both chains are driven by the same inputs (acceleration, speed,
    // turn) but with different stiffness, so they never move in lockstep.
    const drag = -Math.min(smoothSpeed * 0.055, 0.55) - THREE.MathUtils.clamp(accel * 0.01, -0.3, 0.3);
    const airLift = f.grounded ? 0 : THREE.MathUtils.clamp(f.verticalVel * 0.02, -0.35, 0.35);
    for (let i = 0; i < crestJoints.length; i++) {
      const target = drag * (0.55 + i * 0.3) + airLift * (0.5 + i * 0.4) + Math.sin(t * 3.1 + i) * 0.02;
      crestV[i] = spring(crestA[i], target, crestV[i], 150 - i * 30, 11, dt);
      crestA[i] += crestV[i] * dt;
      crestJoints[i].rotation.x = crestBase[i].x + crestA[i];
      crestJoints[i].rotation.z = crestBase[i].z - bank * (0.3 + i * 0.2);
    }
    for (let i = 0; i < scarfJoints.length; i++) {
      // Each segment chases the one above it, which is what produces the
      // whip rather than a rigid flag.
      const upstream = i === 0 ? 0 : scarfA[i - 1];
      const target =
        upstream * 0.55 +
        drag * trailSign * (0.9 + i * 0.22) +
        airLift * trailSign * (0.6 + i * 0.3) +
        Math.sin(t * (2.4 + i * 0.37) + i) * (0.035 + smoothSpeed * 0.006);
      scarfV[i] = spring(scarfA[i], target, scarfV[i], 120 - i * 14, 9.5, dt);
      scarfA[i] += scarfV[i] * dt;
      scarfJoints[i].rotation.x = scarfA[i];
      scarfJoints[i].rotation.y = THREE.MathUtils.clamp(-f.yawRate * 0.06 * (i + 1), -0.4, 0.4);
      // Keep the shoulder sweep the rig was built with; bank on top of it.
      scarfJoints[i].rotation.z = scarfRestZ[i] - bank * (0.2 + i * 0.12);
    }

    // ---- Wings ---------------------------------------------------------
    // Folded on the ground, spread in the air, and beating harder the
    // faster you're climbing — so leaving the ground reads as taking off.
    for (let i = 0; i < wingJoints.length; i++) {
      const side = i === 0 ? -1 : 1;
      const spread = f.grounded ? 0.1 : 1;
      const beat = Math.sin(t * (f.grounded ? 1.6 : 7 + Math.min(smoothSpeed, 8))) *
        (f.grounded ? 0.06 : 0.42);
      const j = wingJoints[i];
      j.rotation.z = approach(j.rotation.z, side * (0.25 + spread * 0.85) + beat * side, 9, dt);
      j.rotation.y = approach(j.rotation.y, side * (f.grounded ? 0.75 : 0.15), 8, dt);
      j.rotation.x = approach(j.rotation.x, -bank * 0.3 + (f.grounded ? 0.1 : -0.15), 8, dt);
    }
  };

  return {
    group,
    head,
    update,
    setAccent(hex: string) {
      const c = new THREE.Color(hex);
      glow.color.copy(c);
      glow.emissive.copy(c);
      cloth.color.copy(c);
      cloth.emissive.copy(c);
    },
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const m of extraMaterials) m.dispose();
      geometries.length = 0;
      extraMaterials.length = 0;
    },
  };
}
