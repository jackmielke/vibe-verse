/**
 * Kevin, Harry and Marv.
 *
 * All three come off the same skeleton — hips, torso, head, two arms with
 * elbows, two legs with knees — and everything that makes one recognisable is
 * in the proportions and the four or five props bolted on top. That is not a
 * shortcut; it is the only way three characters share one gait, one pratfall
 * and one set of blend weights without any of it being written three times.
 *
 * The proportions are doing the heavy lifting:
 *
 * - **Kevin** is 1.27 m with a head a third of his height. Children read as
 *   children because of head-to-body ratio long before anything else, and
 *   pushing it further than life does is what stops him reading as a short man.
 * - **Harry** is 1.70 m and wide, with his neck inside his collar.
 * - **Marv** is 1.96 m of coat with nothing in it. Every measurement of his is
 *   the same as Harry's except taller and thinner, which is the joke.
 *
 * The faces are drawn (see `textures.face`) and wrapped round the front of a
 * squashed sphere. A face is the one thing boxes will never do, and it is
 * worth saying plainly: nothing else in this file would make you say "that's
 * the kid from the film" — the drawing does all of it.
 */
import * as THREE from "three";
import * as T from "./textures";

export type Who = "kevin" | "harry" | "marv" | "marley";

export interface Character {
  who: Who;
  root: THREE.Group;
  /** Bobs and leans. Everything below the yaw. */
  body: THREE.Group;
  head: THREE.Group;
  eyesMat: THREE.MeshStandardMaterial;
  limbs: {
    lArm: THREE.Group; rArm: THREE.Group;
    lFore: THREE.Group; rFore: THREE.Group;
    lLeg: THREE.Group; rLeg: THREE.Group;
    lShin: THREE.Group; rShin: THREE.Group;
  };
  /** Metres per second at a walk. */
  walkSpeed: number;
  runSpeed: number;
  /** Eye height, for line of sight and for the camera when this is the player. */
  eyeY: number;
  height: number;
  /** 0 idle … 1 flat sprint. Blended, so the gait never snaps. */
  gait: number;
  /** 0 upright … 1 flat on his back. Drives the pratfall. */
  down: number;
  /** Set true for one frame to make Kevin scream. */
  setScream(on: boolean): void;
  /** Show or hide what he is holding — Kevin's BB gun, Marley's shovel. */
  setProp(on: boolean): void;
  /** Advance the animation. `speed` is metres per second right now. */
  update(dt: number, t: number, speed: number): void;
  dispose(): void;
}

interface Build {
  height: number;
  headR: number;
  headSquash: number;
  shoulder: number;
  torsoH: number;
  torsoW: number;
  torsoD: number;
  legLen: number;
  legW: number;
  armLen: number;
  armW: number;
  walkSpeed: number;
  runSpeed: number;
}

const BUILDS: Record<Who, Build> = {
  /*
   * Kevin is 1.31 m with a head about a fifth of his height.
   *
   * The first build made it a *third*, on the theory that children read as
   * children because of head-to-body ratio. They do — but a third is a Funko
   * pop, and at a third he stopped being a boy and became a mascot. A real
   * eight-year-old is nearer a fifth-and-a-half, and the childishness has to
   * come from everywhere else instead: narrow shoulders, no waist to speak
   * of, short forearms, and a stride that is quick rather than long.
   */
  kevin: {
    height: 1.31, headR: 0.116, headSquash: 1.13, shoulder: 0.15,
    torsoH: 0.42, torsoW: 0.245, torsoD: 0.155,
    legLen: 0.60, legW: 0.078, armLen: 0.42, armW: 0.055,
    walkSpeed: 2.7, runSpeed: 5.3,
  },
  harry: {
    height: 1.70, headR: 0.132, headSquash: 1.16, shoulder: 0.24,
    torsoH: 0.58, torsoW: 0.44, torsoD: 0.28,
    legLen: 0.76, legW: 0.135, armLen: 0.58, armW: 0.105,
    walkSpeed: 2.5, runSpeed: 4.6,
  },
  marv: {
    height: 1.96, headR: 0.129, headSquash: 1.3, shoulder: 0.215,
    torsoH: 0.62, torsoW: 0.34, torsoD: 0.215,
    legLen: 1.00, legW: 0.105, armLen: 0.74, armW: 0.082,
    walkSpeed: 2.6, runSpeed: 4.9,
  },
  // Old Man Marley: tall, stooped, and slow. Everything about him is built to
  // be misread from a distance as something to be frightened of, which is the
  // entire point of the character.
  marley: {
    height: 1.84, headR: 0.135, headSquash: 1.18, shoulder: 0.225,
    torsoH: 0.60, torsoW: 0.41, torsoD: 0.25,
    legLen: 0.88, legW: 0.12, armLen: 0.66, armW: 0.095,
    walkSpeed: 1.15, runSpeed: 1.6,
  },
};

export function makeCharacter(who: Who): Character {
  const b = BUILDS[who];
  const owned: Array<{ dispose(): void }> = [];
  const keep = <M extends THREE.Material | THREE.BufferGeometry>(m: M) => {
    owned.push(m);
    return m;
  };

  const BOX = keep(new THREE.BoxGeometry(1, 1, 1));

  /*
   * Limbs are tapered cylinders, not boxes.
   *
   * This is the single biggest step from "assembled out of blocks" to "a
   * person". A forearm that is 15% narrower at the wrist than the elbow, and a
   * thigh that is wider than the shin, read as anatomy at a glance; two boxes
   * of the same width read as furniture, however good the texture on them is.
   * Ten sides is plenty at the size any of these are ever seen.
   */
  const limbCache = new Map<string, THREE.CylinderGeometry>();
  const limbGeo = (top: number, bottom: number) => {
    const key = `${top.toFixed(3)}:${bottom.toFixed(3)}`;
    let g = limbCache.get(key);
    if (!g) {
      g = keep(new THREE.CylinderGeometry(top, bottom, 1, 10, 1));
      limbCache.set(key, g);
    }
    return g;
  };
  /** A tapered limb segment hung from a joint, growing downwards. */
  const limb = (
    parent: THREE.Object3D, m: THREE.Material,
    y: number, len: number, top: number, bottom: number, z = 0,
  ) => {
    const o = new THREE.Mesh(limbGeo(top, bottom), m);
    o.position.set(0, y - len / 2, z);
    o.scale.set(1, len, 1);
    o.castShadow = true;
    parent.add(o);
    return o;
  };
  /** A joint, so elbows and knees are not sharp corners. */
  const BALL = keep(new THREE.SphereGeometry(1, 10, 8));
  const ball = (parent: THREE.Object3D, m: THREE.Material, x: number, y: number, z: number, r: number, sy = 1) => {
    const o = new THREE.Mesh(BALL, m);
    o.position.set(x, y, z);
    o.scale.set(r, r * sy, r);
    o.castShadow = true;
    parent.add(o);
    return o;
  };

  /**
   * A skull, from a sphere.
   *
   * A sphere is a ball, and a face painted on a ball stays a ball. Four
   * deformations turn it into a head, and all four are things you would notice
   * missing before you could name them: the jaw narrows towards the chin, the
   * back of the cranium is longer than the front, the brow steps forward over
   * the eyes, and there is an actual chin rather than the bottom of a circle.
   * The UVs are untouched, so the drawn face still lands exactly where it did.
   */
  const skullGeo = (r: number) => {
    const g = keep(new THREE.SphereGeometry(r, 26, 20));
    const pos = g.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const ny = v.y / r; // -1 at the chin, +1 at the crown
      // Jaw: pinch everything below the cheekbones towards the midline.
      if (ny < -0.1) {
        // 0.26, not 0.42, and starting below the cheekbones rather than at
        // them. A harder pinch gives a chin like a chess piece, and the drawn
        // face gets compressed into it and reads as a beard.
        const t = Math.min(1, (-0.1 - ny) / 0.9);
        const pinch = 1 - t * t * 0.26;
        v.x *= pinch;
        v.z *= pinch * 0.94 + 0.06;
      }
      // Cranium: longer front-to-back than side-to-side, and flatter behind.
      v.z *= v.z < 0 ? 1.06 : 1.0;
      v.x *= 0.9;
      // Brow: a small step forward over the eyes.
      if (ny > 0.05 && ny < 0.4 && v.z > 0) v.z += r * 0.06 * Math.sin(((ny - 0.05) / 0.35) * Math.PI);
      // Chin: push the very bottom-front out and up a little.
      if (ny < -0.6 && v.z > 0) v.z += r * 0.05 * (-ny - 0.6) * 2.5;
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    return g;
  };
  const mat = (color: number, rough = 0.9, metal = 0) =>
    keep(new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }));
  const clothMat = (hex: string, seed: number, rx = 1, ry = 1) => {
    const t = T.cloth(hex, seed).clone();
    t.needsUpdate = true;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx, ry);
    owned.push(t);
    return keep(new THREE.MeshStandardMaterial({ map: t, roughness: 0.95 }));
  };

  const PAL = {
    kevin: { skin: 0xf2c49e, coat: 0xe9e0cc, trouser: 0x36537f, shoe: 0xdedad0, hair: 0xe4c36a },
    harry: { skin: 0xd9a97f, coat: 0x6d4d2c, trouser: 0x2f2a26, shoe: 0x231d18, hair: 0x241a12 },
    marv: { skin: 0xe4c09a, coat: 0x2b2f3a, trouser: 0x1e2029, shoe: 0x1a1a1e, hair: 0x3a2a1a },
    marley: { skin: 0xd6b89c, coat: 0x3d4148, trouser: 0x2c2f36, shoe: 0x241f1b, hair: 0xc8c4bc },
  }[who];

  const skin = mat(PAL.skin, 0.82);

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const cube = (parent: THREE.Object3D, m: THREE.Material, x: number, y: number, z: number, w: number, h: number, d: number) => {
    const o = new THREE.Mesh(BOX, m);
    o.position.set(x, y, z);
    o.scale.set(w, h, d);
    o.castShadow = true;
    parent.add(o);
    return o;
  };

  /* ---- torso ------------------------------------------------------- */
  const hipY = b.legLen;
  const torso = new THREE.Group();
  torso.position.y = hipY;
  body.add(torso);

  const heavyCoat = who === "harry" || who === "marv" || who === "marley";
  const coatMat =
    who === "kevin"
      ? keep(
          (() => {
            const t = T.nordicSweater().clone();
            t.needsUpdate = true;
            t.wrapS = t.wrapT = THREE.RepeatWrapping;
            owned.push(t);
            return new THREE.MeshStandardMaterial({ map: t, roughness: 0.98 });
          })(),
        )
      : clothMat(
          who === "harry" ? "#6d4d2c" : who === "marley" ? "#3d4148" : "#2b2f3a",
          who === "harry" ? 3 : who === "marley" ? 7 : 5,
          1.4,
          1.4,
        );

  /* The torso is a tapered box rather than a slab: chest wider than waist,
     and shoulders rounded off with two balls so the arms grow out of
     something instead of being stuck on the sides of a crate. */
  {
    const chest = new THREE.Mesh(BOX, coatMat);
    chest.position.set(0, b.torsoH * 0.62, 0);
    chest.scale.set(b.torsoW, b.torsoH * 0.76, b.torsoD);
    chest.castShadow = true;
    torso.add(chest);
    const waist = new THREE.Mesh(BOX, coatMat);
    waist.position.set(0, b.torsoH * 0.14, 0);
    waist.scale.set(b.torsoW * 0.86, b.torsoH * 0.34, b.torsoD * 0.9);
    waist.castShadow = true;
    torso.add(waist);
    // Shoulders sit at the *top of the ribcage*, not under the ears. The
    // first pass had them at 94% of the torso and half its depth across,
    // which read as a fur collar with a small head resting on it.
    for (const sd of [-1, 1])
      ball(torso, coatMat, sd * b.torsoW * 0.44, b.torsoH * 0.86, 0, b.torsoD * 0.42, 0.8);
  }

  if (who === "kevin") {
    // Snow boots and jeans, and the sweater's ribbed hem.
    cube(torso, mat(0xd8cdb4), 0, 0.03, 0, b.torsoW + 0.02, 0.07, b.torsoD + 0.02);
  } else {
    // The overcoat: skirts below the hips, which is most of the silhouette.
    const skirtH = who === "marv" ? 0.78 : who === "marley" ? 0.62 : 0.56;
    cube(torso, coatMat, 0, -skirtH / 2 + 0.02, 0, b.torsoW * 1.06, skirtH, b.torsoD * 1.06);
    // Lapels.
    for (const s of [-1, 1])
      cube(torso, mat(who === "harry" ? 0x543a20 : who === "marley" ? 0x2b2f36 : 0x1e222c), s * b.torsoW * 0.2, b.torsoH * 0.68, b.torsoD / 2 + 0.005, b.torsoW * 0.3, b.torsoH * 0.6, 0.02);
    // Something under the coat — Marv's is a dirty pink, Harry's a green
    // shirt, Marley's a scarf.
    cube(torso, mat(who === "harry" ? 0x4a5c3a : who === "marley" ? 0x7a2b2b : 0x8e5f66), 0, b.torsoH * 0.62, b.torsoD / 2 + 0.004, b.torsoW * (who === "marley" ? 0.5 : 0.22), b.torsoH * 0.6, 0.03);
  }

  /* ---- head -------------------------------------------------------- */
  const head = new THREE.Group();
  /* Clear of the collar. At 0.86 the chin sat *below* the top of the torso
     and the head looked pushed down into the sweater like a tortoise. */
  head.position.y = b.torsoH + b.headR * b.headSquash * 1.14;
  torso.add(head);

  const faceTex = T.face(who).clone();
  faceTex.needsUpdate = true;
  faceTex.wrapS = THREE.ClampToEdgeWrapping;
  faceTex.wrapT = THREE.ClampToEdgeWrapping;
  // The sphere's u=0.25 is dead ahead (+Z). Compress the drawing to ~130° of
  // circumference and slide it so its centre lands there.
  // Vertically the drawing is squeezed into a band around the equator rather
  // than stretched pole to pole. Pole to pole puts the eyes up under the
  // hairline and crushes the mouth into the chin, because latitude near a pole
  // covers almost no surface — the head ends up all forehead and jaw. The
  // texture clamps, so above and below the band it is simply skin.
  // FACE_SPAN 1.6 puts the drawing across about 112° of circumference. Lower
  // numbers wrap it round the sides of the skull and the eyes end up level
  // with the ears, which is a very specific kind of wrong.
  const FACE_SPAN = 1.58;
  const FACE_BAND = 1.62;
  faceTex.repeat.set(FACE_SPAN, FACE_BAND);
  /*
   * The +0.09 slides the drawing *down* the skull.
   *
   * Centred, it leaves a hand's width of bare jaw below the mouth — and bare
   * jaw on a head lit from above is a smooth dark wedge that reads, from any
   * distance, as a goatee. It is a lighting artefact rather than a texture
   * one, and the cure is not to fight the light: it is to stop having that
   * much face below the mouth.
   */
  faceTex.offset.set(0.5 - 0.25 * FACE_SPAN, 0.5 - 0.5 * FACE_BAND + 0.09);
  owned.push(faceTex);
  const faceMat = keep(new THREE.MeshStandardMaterial({ map: faceTex, roughness: 0.82 }));

  const skull = new THREE.Mesh(skullGeo(b.headR), faceMat);
  skull.scale.set(1, b.headSquash, 1);
  skull.castShadow = true;
  head.add(skull);

  // Ears. Rounded, set back, and angled off the skull — square tabs on the
  // side of a head are one of those details nobody spots until they are wrong.
  for (const sd of [-1, 1]) {
    // Set back behind the midline and only just proud of the skull. Ears that
    // stick out level with the eyes read as handles.
    const ear = ball(head, skin, sd * b.headR * 0.76, -b.headR * 0.04, -b.headR * 0.18, b.headR * 0.15, 1.2);
    ear.scale.x *= 0.36;
    ear.rotation.z = sd * 0.12;
  }

  // Neck: tapered, and long enough to be visible under the jaw.
  limb(torso, skin, b.torsoH + b.headR * 0.34, b.headR * 0.55, b.headR * 0.34, b.headR * 0.42);

  if (who === "kevin") {
    /* The bowl cut.
     *
     * The thing to get right is what it does *not* cover. A hemisphere over
     * the whole skull is a helmet, and the first build of this had one — a
     * featureless gold egg where an eight-year-old's face should be. So the
     * cap stops well above the eyes (thetaLength 0.38π, about 68° from the
     * crown), the sides hang past the ears at the back only, and the fringe
     * is a separate row of blocks sitting on the brow. Everything below and
     * in front of that is face. */
    const hairMat = mat(PAL.hair, 0.95);
    // Three pieces, and the shape only works because they are three:
    //   1. a shallow skull cap over the crown, front to back
    //   2. a deep bowl over the BACK 200° only, hanging to below the ears
    //   3. a fringe of blocks resting on the brow
    // Piece 2 is what makes it a bowl rather than a hat, and restricting it in
    // phi is what keeps it off his cheeks. A single hemisphere gives you a
    // gold egg with no face; a ring of boxes gives you a flat yellow slab from
    // behind. This gives you a haircut.
    const capGeo = keep(new THREE.SphereGeometry(b.headR * 1.06, 22, 12, 0, Math.PI * 2, 0, Math.PI * 0.42));
    const cap = new THREE.Mesh(capGeo, hairMat);
    cap.position.y = b.headR * 0.02;
    cap.scale.set(1.02, b.headSquash * 1.0, 1.04);
    head.add(cap);

    // The back and sides. phi = π/2 is dead ahead, so an arc centred on 3π/2
    // is the back of the head; 1.12π of it leaves the face and both cheeks
    // clear. It hangs to 0.62π of theta — just below the ears.
    const backGeo = keep(
      new THREE.SphereGeometry(b.headR * 1.07, 22, 14, Math.PI * 0.94, Math.PI * 1.12, 0, Math.PI * 0.62),
    );
    const backHair = new THREE.Mesh(backGeo, hairMat);
    backHair.position.y = b.headR * 0.02;
    backHair.scale.set(1.02, b.headSquash * 1.02, 1.05);
    head.add(backHair);
    // Its blunt bottom edge — the cut line that makes it a *bowl* cut.
    //
    // Note the different angle: CylinderGeometry measures theta from +Z (dead
    // ahead) while SphereGeometry measures phi from -X. Reusing the sphere's
    // numbers here swung the rim round onto his face and put a fringe across
    // his mouth, which took a screenshot to notice and one line to fix.
    const rimGeo = keep(
      new THREE.CylinderGeometry(b.headR * 1.09, b.headR * 1.09, b.headR * 0.16, 22, 1, false, Math.PI * 0.44, Math.PI * 1.12),
    );
    const rim = new THREE.Mesh(rimGeo, hairMat);
    rim.position.y = -b.headR * 0.5;
    rim.scale.set(1.0, 1, 1.03);
    head.add(rim);

    /* Fringe: a fine arc across the forehead, hanging to just above the brows.
     *
     * Every dimension here is a fraction of `headR`, and that is not tidiness
     * — these were absolute metres once, and the day the head got smaller the
     * fringe stayed the same size and hung down past his nose. A bowl cut with
     * no eyes under it is a wig on a bowling ball. */
    for (let i = -5; i <= 5; i++) {
      const a = (i / 5) * 0.7;
      const f = cube(
        head, hairMat,
        Math.sin(a) * b.headR * 0.9, b.headR * (0.62 - Math.abs(i) * 0.022), Math.cos(a) * b.headR * 0.9,
        b.headR * 0.34, b.headR * 0.52, b.headR * 0.3,
      );
      f.rotation.y = a;
    }
  } else if (who === "marley") {
    /* White hair and a flat cap. He is the only adult here who is not a
       cartoon, so nothing about him is exaggerated. */
    const hairMat = mat(PAL.hair, 0.98);
    const backGeo = keep(new THREE.SphereGeometry(b.headR * 1.05, 18, 12, Math.PI * 0.9, Math.PI * 1.2, 0, Math.PI * 0.6));
    const back = new THREE.Mesh(backGeo, hairMat);
    back.scale.set(1.02, b.headSquash, 1.03);
    head.add(back);
    const capMat = mat(0x4a4a50, 0.9);
    const capGeo = keep(new THREE.SphereGeometry(b.headR * 1.05, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.34));
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.y = b.headR * 0.06;
    cap.scale.set(1.05, b.headSquash * 0.8, 1.08);
    head.add(cap);
    cube(head, capMat, 0, b.headR * 0.5, b.headR * 0.72, b.headR * 1.5, 0.035, b.headR * 0.7);
  } else {
    /* Both burglars wear the black knit cap. Marv's sits higher because his
       head is longer; Harry's is pulled down to his eyebrows. */
    const capMat = clothMat("#1c1c20", who === "harry" ? 8 : 9, 2, 2);
    const capGeo = keep(new THREE.SphereGeometry(b.headR * 1.07, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.55));
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.y = who === "harry" ? b.headR * 0.06 : b.headR * 0.12;
    cap.scale.set(1.02, b.headSquash * 1.06, 1.02);
    head.add(cap);
    const brimGeo = keep(new THREE.CylinderGeometry(b.headR * 1.09, b.headR * 1.09, b.headR * 0.42, 18, 1, true));
    const brim = new THREE.Mesh(brimGeo, capMat);
    brim.position.y = (who === "harry" ? 0.16 : 0.28) * b.headR;
    brim.scale.set(1, b.headSquash, 1);
    head.add(brim);
    if (who === "marv") {
      // Marv's hair sticks out under the cap at the back.
      cube(head, mat(PAL.hair), 0, 0, -b.headR * 0.85, b.headR * 1.2, b.headR * 0.5, b.headR * 0.5);
    }
  }

  /* ---- limbs ------------------------------------------------------- */
  const limbMat = who === "kevin" ? coatMat : coatMat;
  const legMat = clothMat(who === "kevin" ? "#36537f" : who === "harry" ? "#2f2a26" : "#1e2029", 11, 1, 2);
  const shoeMat = mat(PAL.shoe, 0.7);

  /* Arms: upper tapers to the elbow, forearm tapers to the wrist, and there
     is a ball at every joint. The hand is a squashed sphere — a cube on the
     end of an arm is the most obviously wrong thing a character can have. */
  function arm(side: -1 | 1) {
    const upper = new THREE.Group();
    upper.position.set(side * (b.torsoW / 2 + b.armW * 0.75), b.torsoH * 0.84, 0);
    torso.add(upper);
    ball(upper, limbMat, 0, 0, 0, b.armW * 1.12);
    limb(upper, limbMat, 0, b.armLen * 0.56, b.armW * 1.05, b.armW * 0.86);
    const fore = new THREE.Group();
    fore.position.y = -b.armLen * 0.56;
    upper.add(fore);
    ball(fore, limbMat, 0, 0, 0, b.armW * 0.92);
    limb(fore, limbMat, 0, b.armLen * 0.42, b.armW * 0.88, b.armW * 0.7);
    // A child's hand is small. At 1.18× the arm's radius it hung off the end
    // of the sleeve like a boxing glove.
    const hand = ball(fore, skin, 0, -b.armLen * 0.45, 0, b.armW * 0.82, 1.3);
    hand.scale.z *= 0.7;
    return { upper, fore };
  }

  /* Legs: thigh into knee into shin, and a shoe with a toe and a sole rather
     than a brick. */
  function leg(side: -1 | 1) {
    const thigh = new THREE.Group();
    thigh.position.set(side * b.legW * 1.25, b.torsoH * 0.02, 0);
    torso.add(thigh);
    ball(thigh, legMat, 0, 0, 0, b.legW * 1.2);
    limb(thigh, legMat, 0, b.legLen * 0.54, b.legW * 1.15, b.legW * 0.82);
    const shin = new THREE.Group();
    shin.position.y = -b.legLen * 0.54;
    thigh.add(shin);
    ball(shin, legMat, 0, 0, 0, b.legW * 0.86);
    limb(shin, legMat, 0, b.legLen * 0.46, b.legW * 0.84, b.legW * 0.62);
    const foot = ball(shin, shoeMat, 0, -b.legLen * 0.46, b.legW * 0.42, b.legW * 1.15, 0.62);
    foot.scale.z *= 1.9;
    cube(shin, shoeMat, 0, -b.legLen * 0.485, b.legW * 0.34, b.legW * 2.0, b.legW * 0.34, b.legW * 2.6);
    return { thigh, shin };
  }

  const la = arm(-1);
  const ra = arm(1);

  /*
   * A socket in the right hand, and the two things that go in it.
   *
   * Both are hidden by default and toggled from the engine, so a character
   * carrying something is one boolean rather than a second model. Kevin's BB
   * gun only appears once he has been to Buzz's room, and Marley's shovel is
   * the reason his silhouette on the street is unmistakable and slightly
   * alarming, which is exactly how the film introduces him.
   */
  const grip = new THREE.Group();
  grip.position.set(0, -b.armLen * 0.5, 0.03);
  ra.fore.add(grip);
  let prop: THREE.Group | null = null;
  if (who === "kevin") {
    prop = new THREE.Group();
    cube(prop, mat(0x4a3116, 0.75), 0, -0.04, -0.12, 0.045, 0.08, 0.22); // stock
    cube(prop, mat(0x2a2c31, 0.4, 0.7), 0, 0.01, 0.16, 0.03, 0.03, 0.42); // barrel
    cube(prop, mat(0x4a3116, 0.75), 0, -0.02, 0.02, 0.05, 0.05, 0.14); // receiver
    prop.rotation.x = 1.35;
    prop.visible = false;
    grip.add(prop);
  } else if (who === "marley") {
    prop = new THREE.Group();
    cube(prop, mat(0x6a4a28, 0.9), 0, 0, 0.5, 0.04, 0.04, 1.0); // handle
    cube(prop, mat(0xb9c0c8, 0.35, 0.6), 0, 0, 1.05, 0.3, 0.03, 0.34); // blade
    prop.rotation.x = 1.9;
    prop.position.set(0.02, -0.02, 0);
    grip.add(prop);
  }
  const ll = leg(-1);
  const rl = leg(1);

  /* ---- state ------------------------------------------------------- */
  const state = {
    gait: 0,
    down: 0,
    phase: 0,
    screaming: false,
  };

  const screamTex = who === "kevin" ? T.face("kevinScream").clone() : null;
  if (screamTex) {
    screamTex.needsUpdate = true;
    screamTex.wrapS = screamTex.wrapT = THREE.ClampToEdgeWrapping;
    screamTex.repeat.copy(faceTex.repeat);
    screamTex.offset.copy(faceTex.offset);
    owned.push(screamTex);
  }

  const character: Character = {
    who,
    root,
    body,
    head,
    eyesMat: faceMat,
    limbs: {
      lArm: la.upper, rArm: ra.upper, lFore: la.fore, rFore: ra.fore,
      lLeg: ll.thigh, rLeg: rl.thigh, lShin: ll.shin, rShin: rl.shin,
    },
    walkSpeed: b.walkSpeed,
    runSpeed: b.runSpeed,
    eyeY: b.height * 0.92,
    height: b.height,
    get gait() {
      return state.gait;
    },
    set gait(v: number) {
      state.gait = v;
    },
    get down() {
      return state.down;
    },
    set down(v: number) {
      state.down = v;
    },
    setProp(on: boolean) {
      if (prop) prop.visible = on;
    },
    setScream(on: boolean) {
      if (!screamTex || state.screaming === on) return;
      state.screaming = on;
      faceMat.map = on ? screamTex : faceTex;
      faceMat.needsUpdate = true;
    },
    update(dt, t, speed) {
      // Gait blend from actual speed, so nothing ever snaps between animations.
      const want = Math.min(1, speed / b.runSpeed);
      state.gait += (want - state.gait) * Math.min(1, dt * 9);
      const g = state.gait;

      // Stride frequency rises with speed; the +1.6 keeps an idle sway alive.
      state.phase += dt * (1.6 + speed * 2.5);
      const p = state.phase;
      const swing = Math.sin(p) * (0.32 + g * 0.85);
      const lift = Math.max(0, Math.sin(p)) * g;

      const down = state.down;
      const live = 1 - down;

      ll.thigh.rotation.x = swing * live;
      rl.thigh.rotation.x = -swing * live;
      // Knees only bend one way. Bending the trailing knee is the difference
      // between a run and a pair of scissors.
      ll.shin.rotation.x = -Math.max(0, -swing) * (0.5 + g * 1.1) * live;
      rl.shin.rotation.x = -Math.max(0, swing) * (0.5 + g * 1.1) * live;

      const armSwing = -swing * (0.85 + g * 0.5);
      la.upper.rotation.x = armSwing * live;
      ra.upper.rotation.x = -armSwing * live;
      la.upper.rotation.z = 0.09 + g * 0.12;
      ra.upper.rotation.z = -0.09 - g * 0.12;
      la.fore.rotation.x = -(0.25 + g * 0.9 + Math.max(0, -armSwing) * 0.5) * live;
      ra.fore.rotation.x = -(0.25 + g * 0.9 + Math.max(0, armSwing) * 0.5) * live;

      // Bob, lean, and the little sway that keeps a standing figure alive.
      const bob = Math.abs(Math.sin(p)) * (0.012 + g * 0.055);
      body.position.y = (bob + lift * 0.01) * live;
      body.rotation.x = (g * 0.22) * live;
      body.rotation.z = Math.sin(p * 0.5) * 0.02 * live;
      head.rotation.x = -(g * 0.16) * live + Math.sin(t * 0.7 + b.height) * 0.02;

      // The pratfall: flat on his back, legs in the air, arms out.
      if (down > 0.001) {
        body.rotation.x = -down * Math.PI * 0.5;
        body.position.y = -down * (b.legLen * 0.86);
        ll.thigh.rotation.x = down * 1.1;
        rl.thigh.rotation.x = down * 0.8;
        ll.shin.rotation.x = -down * 1.5;
        rl.shin.rotation.x = -down * 1.2;
        la.upper.rotation.x = -down * 2.0;
        ra.upper.rotation.x = -down * 2.3;
        la.upper.rotation.z = 0.09 + down * 0.9;
        ra.upper.rotation.z = -0.09 - down * 0.9;
        head.rotation.x = down * 0.5;
      }
    },
    dispose() {
      for (const o of owned) o.dispose();
      root.parent?.remove(root);
    },
  };

  return character;
}
