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
  crown: "fins" | "cat-ears" | "bat-ears" | "horns" | "antennae" | "ring" | "none";
  /** What trails off the body, using the same spring chain. */
  trail: "scarf" | "cape" | "tail" | "none";
  /** Face hardware. */
  face: "visor" | "lenses" | "muzzle";
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
  const shell = new THREE.MeshStandardMaterial({
    color: design.shell, roughness: 0.6, metalness: 0.15, flatShading: true,
  });
  const plate = new THREE.MeshStandardMaterial({
    color: design.plate, roughness: 0.45, metalness: 0.25, flatShading: true,
  });
  const glow = new THREE.MeshStandardMaterial({
    color: new THREE.Color(accent), emissive: new THREE.Color(accent),
    emissiveIntensity: 1.5, roughness: 0.35, metalness: 0,
  });
  // Visor glass: dark, but with enough of the accent in its emissive to
  // stay a *face* at night rather than a hole in the head.
  const dark = new THREE.MeshStandardMaterial({
    color: 0x141a28, emissive: new THREE.Color(accent), emissiveIntensity: 0.22,
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
  const HIP_Y = 0.78;
  const root = new THREE.Group();       // squash/stretch + bob live here
  group.add(root);

  const hips = new THREE.Group();
  hips.position.y = HIP_Y;
  root.add(hips);

  const pelvis = mesh(new THREE.BoxGeometry(0.34, 0.18, 0.24), plate);
  pelvis.position.y = 0.02;
  hips.add(pelvis);

  const torso = new THREE.Group();      // counter-twist + lean
  hips.add(torso);
  const chestMesh = mesh(new THREE.CapsuleGeometry(0.2, 0.26, 3, 8), design.suit ? plate : shell);
  chestMesh.position.y = 0.29;
  chestMesh.scale.set(1.12, 1, 0.82);
  torso.add(chestMesh);
  // Chest core — a slow pulse that doubles as a "you are here" marker.
  // Flux's reactor. A cat does not have one, and on the others it read as
  // a sticker: they get an emblem, piping, or bare chest instead.
  const core = mesh(new THREE.IcosahedronGeometry(0.062, 0), glow);
  core.position.set(0, 0.32, 0.17);
  core.visible = design.core ?? false;
  if (core.visible) torso.add(core);
  // Shoulder yoke.
  const yoke = mesh(new THREE.BoxGeometry(0.46, 0.09, 0.2), plate);
  yoke.position.y = 0.5;
  torso.add(yoke);

  // Head.
  const neck = new THREE.Group();
  neck.position.y = 0.55;
  torso.add(neck);
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
  // Eye slits rather than dots: a horizontal bar keeps its shape at the
  // distance the chase camera actually sits at, where a dot is one pixel.
  const es = design.eyeScale;
  // Lenses are the whole identity for a masked character, so they get real
  // geometry — a teardrop plate with a dark rim — rather than a bright bar.
  const round = design.face === "lenses" || design.roundEyes;
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
  const eyeball = design.roundEyes
    ? new THREE.MeshStandardMaterial({ color: 0x14121c, roughness: 0.28, metalness: 0.05 })
    : null;
  if (eyeball) materials.push(eyeball);
  const eyes: THREE.Mesh[] = [];
  for (const side of [-1, 1]) {
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
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.245, 0.48, 0);
    torso.add(shoulder);
    shoulder.add(mesh(new THREE.SphereGeometry(0.075, 8, 6), plate));
    shoulder.add(limb(0.26, 0.062, 0.05, shell));

    const elbow = new THREE.Group();
    elbow.position.y = -0.26;
    shoulder.add(elbow);
    elbow.add(mesh(new THREE.SphereGeometry(0.052, 8, 6), plate));
    elbow.add(limb(0.24, 0.05, 0.042, shell));

    const hand = mesh(new THREE.IcosahedronGeometry(0.068, 0), plate);
    hand.position.y = -0.26;
    elbow.add(hand);
    // Wrist band, so the arm swing has something bright to trace.
    const band = mesh(new THREE.TorusGeometry(0.055, 0.014, 6, 12), glow);
    band.position.y = -0.225;
    band.rotation.x = Math.PI / 2;
    elbow.add(band);

    arms.push({ shoulder, elbow, side });
  }

  // Legs: hip → knee → foot.
  type Leg = { hip: THREE.Group; knee: THREE.Group; foot: THREE.Group; side: number };
  const legs: Leg[] = [];
  for (const side of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(side * 0.115, -0.04, 0);
    hips.add(hip);
    hip.add(mesh(new THREE.SphereGeometry(0.078, 8, 6), plate));
    hip.add(limb(0.36, 0.075, 0.058, shell));

    const knee = new THREE.Group();
    knee.position.y = -0.36;
    hip.add(knee);
    knee.add(mesh(new THREE.SphereGeometry(0.058, 8, 6), plate));
    knee.add(limb(0.34, 0.055, 0.045, shell));

    const foot = new THREE.Group();
    foot.position.y = -0.34;
    knee.add(foot);
    const boot = mesh(new THREE.BoxGeometry(0.13, 0.075, 0.235), plate);
    boot.position.set(0, -0.035, 0.045);
    foot.add(boot);
    const sole = mesh(new THREE.BoxGeometry(0.135, 0.022, 0.24), glow);
    sole.position.set(0, -0.074, 0.045);
    foot.add(sole);

    legs.push({ hip, knee, foot, side });
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

    hips.position.set(sway + weightShift, HIP_Y + bob + breathe, 0);
    hips.rotation.z = bank + (moving ? Math.sin(stridePhase) * 0.05 * swing : weightShift * 1.6);
    hips.rotation.y = moving ? Math.sin(stridePhase) * 0.22 * swing : 0;
    hips.rotation.x = lean * 0.35;

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

    // ---- Arms -------------------------------------------------------------
    for (const arm of arms) {
      const ph = stridePhase + (arm.side < 0 ? Math.PI : 0); // opposite the leg
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
