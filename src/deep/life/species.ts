/**
 * The Midnight Zone — the bestiary.
 *
 * Twelve real animals, at their real depths, built out of primitives and
 * emissive materials. No textures, no models: everything here is lathe-turned
 * bells, tapered tubes and points of light, because the shapes that survive
 * being reduced that far are exactly the shapes deep-sea animals have. A
 * jellyfish *is* a bell and some strings. An anglerfish *is* a mouth and a
 * lamp.
 *
 * Each entry owns its own `build`, so adding an animal is adding one object to
 * this array — the spawner, the log, the scanner and the HUD all read from
 * here and none of them needs to know what a siphonophore is.
 *
 * The facts in `note` are true. That is the whole reason the scanning mechanic
 * exists: the reward for finding a thing in the dark should be finding out
 * what it is.
 */
import * as THREE from "three";

export interface Species {
  id: string;
  name: string;
  latin: string;
  /** Depth band it can be found in, metres. */
  from: number;
  to: number;
  /** Rough length, metres. Drives the scan reticle and the log. */
  size: number;
  /** How often it turns up relative to its neighbours. */
  weight: number;
  /** The payoff for scanning it. One sentence, true. */
  note: string;
  /** Signature glow, also used for its dot on the sonar and its log entry. */
  glow: number;
  build(rng: () => number): THREE.Object3D;
}

/** Emissive material — the only kind that reads in water this dark. */
function glowMat(color: number, intensity = 2.2, opacity = 1): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: intensity,
    roughness: 0.55,
    metalness: 0,
    transparent: opacity < 1,
    opacity,
  });
}

/** Flesh that is *not* glowing: lit only by your lamps, which is the point. */
function fleshMat(color: number, rough = 0.75): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.05 });
}

/** A jellyfish bell, lathed from a profile so it has a real lip and dome. */
function bell(radius: number, height: number, segments = 20): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    // A cosine dome that flares slightly at the rim — the flare is what makes
    // it read as a swimming bell rather than as half a ball.
    const r = Math.sin(t * Math.PI * 0.5) * radius * (1 + 0.14 * Math.pow(t, 3));
    pts.push(new THREE.Vector2(Math.max(0.001, r), height * (1 - t)));
  }
  return new THREE.LatheGeometry(pts, segments);
}

/** Trailing tentacles: thin tapered cylinders, splayed and slightly curled. */
function tentacles(
  group: THREE.Object3D,
  mat: THREE.Material,
  count: number,
  radius: number,
  length: number,
  rng: () => number,
): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const len = length * (0.6 + rng() * 0.7);
    const geo = new THREE.CylinderGeometry(0.008, 0.02, len, 4, 1);
    geo.translate(0, -len / 2, 0);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(Math.cos(a) * radius, 0, Math.sin(a) * radius);
    m.rotation.x = (rng() - 0.5) * 0.3;
    m.rotation.z = (rng() - 0.5) * 0.3;
    group.add(m);
    out.push(m);
  }
  return out;
}

/** A fish body: a stretched sphere with a tail fin. Reads at any distance. */
function fishBody(length: number, mat: THREE.Material, finMat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(length * 0.24, 12, 10), mat);
  body.scale.set(1, 0.78, 2.1);
  g.add(body);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(length * 0.2, length * 0.34, 5), finMat);
  tail.rotation.x = -Math.PI / 2;
  tail.position.z = -length * 0.62;
  g.add(tail);
  return g;
}

export const SPECIES: Species[] = [
  // -- sunlight -------------------------------------------------------------
  {
    id: "moon-jelly",
    name: "Moon Jelly",
    latin: "Aurelia aurita",
    from: 0,
    to: 260,
    size: 0.35,
    weight: 1.2,
    glow: 0x9fdcff,
    note: "It has no brain, no blood and no heart, and it has been managing without them for 500 million years.",
    build(rng) {
      const g = new THREE.Group();
      const mat = glowMat(0x9fdcff, 1.5, 0.55);
      const dome = new THREE.Mesh(bell(0.35, 0.26), mat);
      g.add(dome);
      // The four horseshoe gonads are the one marking everybody recognises.
      const ring = glowMat(0xd6a2ff, 2.6, 0.9);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        const horse = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.016, 6, 12, Math.PI * 1.2), ring);
        horse.position.set(Math.cos(a) * 0.13, 0.05, Math.sin(a) * 0.13);
        horse.rotation.x = Math.PI / 2;
        g.add(horse);
      }
      tentacles(g, glowMat(0xbfe9ff, 1.2, 0.5), 16, 0.33, 0.42, rng);
      return g;
    },
  },
  {
    id: "sardine-school",
    name: "Sardine Baitball",
    latin: "Sardina pilchardus",
    from: 0,
    to: 220,
    size: 2.4,
    weight: 0.8,
    glow: 0xc8e6f0,
    note: "The ball is the defence: with no individual at the edge for long, a predator cannot pick one out.",
    build(rng) {
      const g = new THREE.Group();
      const mat = fleshMat(0xb9d4e2, 0.35);
      mat.metalness = 0.55;
      const fin = fleshMat(0x8fb3c6, 0.5);
      for (let i = 0; i < 34; i++) {
        const f = fishBody(0.32, mat, fin);
        // Spherical shell with jitter — a baitball is hollow-ish in the middle.
        const r = 0.7 + rng() * 0.6;
        const theta = rng() * Math.PI * 2;
        const phi = Math.acos(2 * rng() - 1);
        f.position.set(
          r * Math.sin(phi) * Math.cos(theta),
          r * Math.cos(phi) * 0.7,
          r * Math.sin(phi) * Math.sin(theta),
        );
        f.rotation.y = theta + Math.PI / 2;
        g.add(f);
      }
      return g;
    },
  },
  // -- twilight -------------------------------------------------------------
  {
    id: "lanternfish",
    name: "Lanternfish",
    latin: "Myctophum punctatum",
    from: 180,
    to: 1100,
    size: 0.12,
    weight: 1.6,
    glow: 0x76ffd4,
    note: "Every night they rise a kilometre to feed and sink again by dawn — the largest migration on Earth, and it happens twice a day.",
    build(rng) {
      const g = new THREE.Group();
      const mat = fleshMat(0x2a3f52, 0.4);
      const fin = fleshMat(0x1b2b3a);
      const dot = glowMat(0x76ffd4, 5);
      for (let i = 0; i < 9; i++) {
        const f = fishBody(0.16, mat, fin);
        f.position.set((rng() - 0.5) * 1.6, (rng() - 0.5) * 0.9, (rng() - 0.5) * 1.6);
        f.rotation.y = rng() * Math.PI * 2;
        // Photophores in a row along the belly — the actual field mark.
        for (let p = 0; p < 5; p++) {
          const light = new THREE.Mesh(new THREE.SphereGeometry(0.012, 5, 4), dot);
          light.position.set(0, -0.03, -0.05 + p * 0.026);
          f.add(light);
        }
        g.add(f);
      }
      return g;
    },
  },
  {
    id: "siphonophore",
    name: "Siphonophore",
    latin: "Apolemia",
    from: 300,
    to: 2200,
    size: 6,
    weight: 0.9,
    glow: 0xff8fd0,
    note: "Not one animal but a colony of clones, each specialised for swimming, feeding or stinging. The longest recorded was 45 metres.",
    build(rng) {
      const g = new THREE.Group();
      const nectMat = glowMat(0xff8fd0, 1.8, 0.75);
      const stemMat = glowMat(0xffd0ec, 1.1, 0.4);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 6, 5), stemMat);
      g.add(stem);
      // A chain of swimming bells down one long stem.
      for (let i = 0; i < 26; i++) {
        const t = i / 26;
        const z = new THREE.Mesh(bell(0.1 + rng() * 0.05, 0.12, 8), nectMat);
        z.position.y = 2.9 - t * 5.8;
        z.rotation.y = rng() * Math.PI;
        z.position.x = Math.sin(t * 9) * 0.06;
        g.add(z);
      }
      return g;
    },
  },
  {
    id: "vampire-squid",
    name: "Vampire Squid",
    latin: "Vampyroteuthis infernalis",
    from: 600,
    to: 1400,
    size: 0.3,
    weight: 0.7,
    glow: 0xff5a4a,
    note: "It eats nothing living — only marine snow. When frightened it turns itself inside out and hides inside its own cloak.",
    build(rng) {
      const g = new THREE.Group();
      const skin = glowMat(0x51101c, 0.35);
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), skin);
      body.scale.set(1, 1.35, 1);
      g.add(body);
      // The webbed cloak between the arms is its signature.
      const cloak = new THREE.Mesh(
        new THREE.SphereGeometry(0.2, 12, 8, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.55),
        glowMat(0x6a1524, 0.3, 0.85),
      );
      cloak.position.y = -0.12;
      g.add(cloak);
      const eye = glowMat(0xff5a4a, 6);
      for (const s of [-1, 1]) {
        const e = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), eye);
        e.position.set(s * 0.1, 0.1, 0.09);
        g.add(e);
      }
      tentacles(g, glowMat(0x8a1e2e, 0.5, 0.8), 8, 0.14, 0.34, rng);
      return g;
    },
  },
  // -- midnight -------------------------------------------------------------
  {
    id: "anglerfish",
    name: "Humpback Anglerfish",
    latin: "Melanocetus johnsonii",
    from: 900,
    to: 3600,
    size: 0.18,
    weight: 1,
    glow: 0xfff0a8,
    note: "The lure glows with bacteria she farms. The male is a twentieth her size and fuses to her body permanently, becoming a pair of gonads.",
    build() {
      const g = new THREE.Group();
      const skin = fleshMat(0x120c14, 0.9);
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 12), skin);
      body.scale.set(1, 0.95, 1.15);
      g.add(body);
      // Jaw and teeth. The silhouette is the whole animal.
      const jaw = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.16, 8, 1, true), skin);
      jaw.rotation.x = -Math.PI / 2;
      jaw.position.z = 0.16;
      g.add(jaw);
      const tooth = glowMat(0xf6f2e0, 0.5);
      for (let i = 0; i < 11; i++) {
        const a = (i / 11) * Math.PI * 2;
        const t = new THREE.Mesh(new THREE.ConeGeometry(0.008, 0.05, 4), tooth);
        t.position.set(Math.cos(a) * 0.1, Math.sin(a) * 0.1, 0.2);
        t.rotation.x = -Math.PI / 2 + (Math.sin(a) * 0.3);
        g.add(t);
      }
      // The esca, on its stalk. This is a real light, not just a bright dot —
      // it is the only thing in the frame that lights the fish's own face.
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.008, 0.3, 4), fleshMat(0x1a1220));
      rod.position.set(0, 0.24, 0.06);
      rod.rotation.x = 0.55;
      g.add(rod);
      const esca = new THREE.Mesh(new THREE.SphereGeometry(0.028, 10, 8), glowMat(0xfff0a8, 8));
      esca.position.set(0, 0.37, 0.19);
      esca.name = "esca";
      g.add(esca);
      const lamp = new THREE.PointLight(0xffe8a0, 2.6, 4.5, 2);
      lamp.position.copy(esca.position);
      g.add(lamp);
      return g;
    },
  },
  {
    id: "atolla",
    name: "Alarm Jelly",
    latin: "Atolla wyvillei",
    from: 800,
    to: 4200,
    size: 0.22,
    weight: 1.1,
    glow: 0x3fa0ff,
    note: "Attacked, it fires a spinning blue light show — not to escape, but to call something bigger to eat its attacker.",
    build(rng) {
      const g = new THREE.Group();
      const mat = glowMat(0x8a1b2c, 0.9, 0.8);
      const dome = new THREE.Mesh(bell(0.22, 0.1, 22), mat);
      g.add(dome);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.018, 6, 26), glowMat(0x3fa0ff, 5));
      rim.rotation.x = Math.PI / 2;
      rim.name = "alarm";
      g.add(rim);
      tentacles(g, glowMat(0xff4a6a, 1.4, 0.7), 20, 0.21, 0.5, rng);
      // The one long trailing tentacle Atolla drags behind it.
      const trail = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.012, 1.5, 4), glowMat(0xff4a6a, 1.4, 0.6));
      trail.position.set(0.2, -0.7, 0);
      g.add(trail);
      return g;
    },
  },
  {
    id: "gulper-eel",
    name: "Gulper Eel",
    latin: "Eurypharynx pelecanoides",
    from: 1200,
    to: 5000,
    size: 1.4,
    weight: 0.6,
    glow: 0xff69b4,
    note: "Its mouth is bigger than the rest of it, and unhinges to swallow prey larger than itself. The tail ends in a pink light.",
    build() {
      const g = new THREE.Group();
      const skin = fleshMat(0x0d1017, 0.85);
      const mouth = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.62, 10, 1, true), skin);
      mouth.rotation.x = Math.PI / 2;
      mouth.position.z = 0.24;
      g.add(mouth);
      // A whip of a body, tapering the whole way.
      for (let i = 0; i < 14; i++) {
        const t = i / 14;
        const seg = new THREE.Mesh(new THREE.SphereGeometry(0.08 * (1 - t * 0.92) + 0.01, 6, 5), skin);
        seg.position.z = -t * 1.3;
        seg.name = `seg${i}`;
        g.add(seg);
      }
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), glowMat(0xff69b4, 7));
      tip.position.z = -1.32;
      g.add(tip);
      const lamp = new THREE.PointLight(0xff69b4, 1.4, 3, 2);
      lamp.position.copy(tip.position);
      g.add(lamp);
      return g;
    },
  },
  {
    id: "dumbo",
    name: "Dumbo Octopus",
    latin: "Grimpoteuthis",
    from: 2000,
    to: 6000,
    size: 0.3,
    weight: 0.8,
    glow: 0xffc9de,
    note: "The deepest-living octopus known. It flaps those ear-fins to swim and swallows its prey whole, having no radula to bite with.",
    build(rng) {
      const g = new THREE.Group();
      const skin = fleshMat(0xd08aa0, 0.6);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 12), skin);
      head.scale.set(1, 0.86, 1.05);
      g.add(head);
      for (const s of [-1, 1]) {
        const ear = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), skin);
        ear.scale.set(1.25, 0.2, 0.75);
        ear.position.set(s * 0.19, 0.09, 0);
        ear.rotation.z = s * 0.32;
        ear.name = s < 0 ? "earL" : "earR";
        g.add(ear);
      }
      const eye = glowMat(0x1a0d12, 0.2);
      for (const s of [-1, 1]) {
        const e = new THREE.Mesh(new THREE.SphereGeometry(0.032, 8, 6), eye);
        e.position.set(s * 0.075, 0.02, 0.14);
        g.add(e);
      }
      tentacles(g, fleshMat(0xc07c92, 0.65), 8, 0.09, 0.3, rng);
      return g;
    },
  },
  // -- abyss ----------------------------------------------------------------
  {
    id: "tripod-fish",
    name: "Tripod Fish",
    latin: "Bathypterois grallator",
    from: 3500,
    to: 7000,
    size: 0.34,
    weight: 0.7,
    glow: 0xe8ffd8,
    note: "It stands on three stiffened fin rays on the mud, facing the current, and waits. It may never swim at all as an adult.",
    build() {
      const g = new THREE.Group();
      const mat = fleshMat(0x9aa87e, 0.8);
      const body = fishBody(0.34, mat, fleshMat(0x7c8a63));
      body.position.y = 0.42;
      g.add(body);
      // The tripod itself — the reason anyone remembers this fish.
      for (const [x, z] of [[0, 0.16], [-0.13, -0.1], [0.13, -0.1]]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.007, 0.46, 4), mat);
        leg.position.set(x, 0.21, z);
        leg.rotation.z = -x * 1.1;
        leg.rotation.x = z * 1.1;
        g.add(leg);
      }
      return g;
    },
  },
  {
    id: "sea-pig",
    name: "Sea Pig",
    latin: "Scotoplanes globosa",
    from: 3000,
    to: 8000,
    size: 0.14,
    weight: 1,
    glow: 0xffd9b3,
    note: "A sea cucumber that walks on inflatable legs, hoovering the top layer of ooze. They gather in herds of hundreds, all facing the same way.",
    build(rng) {
      const g = new THREE.Group();
      const mat = fleshMat(0xf0cba6, 0.7);
      for (let i = 0; i < 5; i++) {
        const body = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), mat);
        body.scale.set(1, 0.85, 1.4);
        body.position.set((rng() - 0.5) * 1.1, 0.07, (rng() - 0.5) * 1.1);
        const unit = new THREE.Group();
        unit.add(body);
        for (let l = 0; l < 6; l++) {
          const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.012, 0.08, 4), mat);
          leg.position.set(
            body.position.x + (l % 2 === 0 ? -0.045 : 0.045),
            0.025,
            body.position.z - 0.06 + Math.floor(l / 2) * 0.06,
          );
          unit.add(leg);
        }
        // Papillae — the little antennae along the back.
        for (let p = 0; p < 3; p++) {
          const t = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.005, 0.07, 3), mat);
          t.position.set(body.position.x, 0.13, body.position.z - 0.03 + p * 0.03);
          unit.add(t);
        }
        g.add(unit);
      }
      return g;
    },
  },
  // -- hadal ----------------------------------------------------------------
  {
    id: "snailfish",
    name: "Hadal Snailfish",
    latin: "Pseudoliparis swirei",
    from: 6000,
    to: 8200,
    size: 0.22,
    weight: 1.2,
    glow: 0xdff0ff,
    note: "The deepest fish ever caught, at 8,336 m. Below about 8,200 m no fish can exist: the chemistry that keeps their proteins folded gives out.",
    build() {
      const g = new THREE.Group();
      // Translucent, unpigmented, faintly pink through the skin. It looks like
      // a tadpole made of glass, and that is not artistic licence.
      const mat = new THREE.MeshStandardMaterial({
        color: 0xf6dede,
        roughness: 0.35,
        metalness: 0,
        transparent: true,
        opacity: 0.72,
      });
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 10), mat);
      body.scale.set(1, 0.9, 1.7);
      g.add(body);
      const tail = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.26, 6), mat);
      tail.rotation.x = Math.PI / 2;
      tail.position.z = -0.2;
      tail.scale.set(1, 1, 0.4);
      g.add(tail);
      const eye = glowMat(0x2b2b33, 0.1);
      for (const s of [-1, 1]) {
        const e = new THREE.Mesh(new THREE.SphereGeometry(0.014, 6, 5), eye);
        e.position.set(s * 0.036, 0.02, 0.1);
        g.add(e);
      }
      return g;
    },
  },
];

export const SPECIES_BY_ID = new Map(SPECIES.map((s) => [s.id, s]));

/** Everything that can appear at this depth, with its spawn weight. */
export function speciesAt(depth: number): Species[] {
  return SPECIES.filter((s) => depth >= s.from && depth <= s.to);
}
