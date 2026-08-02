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

export type Who = "kevin" | "harry" | "marv";

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
  kevin: {
    height: 1.27, headR: 0.205, headSquash: 0.92, shoulder: 0.17,
    torsoH: 0.42, torsoW: 0.36, torsoD: 0.22,
    legLen: 0.50, legW: 0.115, armLen: 0.40, armW: 0.095,
    walkSpeed: 2.7, runSpeed: 5.3,
  },
  harry: {
    height: 1.70, headR: 0.20, headSquash: 1.0, shoulder: 0.25,
    torsoH: 0.62, torsoW: 0.56, torsoD: 0.34,
    legLen: 0.74, legW: 0.17, armLen: 0.58, armW: 0.145,
    walkSpeed: 2.5, runSpeed: 4.6,
  },
  marv: {
    height: 1.96, headR: 0.195, headSquash: 1.14, shoulder: 0.235,
    torsoH: 0.68, torsoW: 0.44, torsoD: 0.26,
    legLen: 0.98, legW: 0.135, armLen: 0.72, armW: 0.115,
    walkSpeed: 2.6, runSpeed: 4.9,
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
      : clothMat(who === "harry" ? "#6d4d2c" : "#2b2f3a", who === "harry" ? 3 : 5, 1.4, 1.4);

  cube(torso, coatMat, 0, b.torsoH / 2, 0, b.torsoW, b.torsoH, b.torsoD);

  if (who === "kevin") {
    // Snow boots and jeans, and the sweater's ribbed hem.
    cube(torso, mat(0xd8cdb4), 0, 0.03, 0, b.torsoW + 0.02, 0.07, b.torsoD + 0.02);
  } else {
    // The overcoat: skirts below the hips, which is most of the silhouette.
    const skirtH = who === "marv" ? 0.78 : 0.56;
    cube(torso, coatMat, 0, -skirtH / 2 + 0.02, 0, b.torsoW * 1.06, skirtH, b.torsoD * 1.06);
    // Lapels.
    for (const s of [-1, 1])
      cube(torso, mat(who === "harry" ? 0x543a20 : 0x1e222c), s * b.torsoW * 0.2, b.torsoH * 0.68, b.torsoD / 2 + 0.005, b.torsoW * 0.3, b.torsoH * 0.6, 0.02);
    // Something under the coat — Marv's is a dirty pink, Harry's a green shirt.
    cube(torso, mat(who === "harry" ? 0x4a5c3a : 0x8e5f66), 0, b.torsoH * 0.62, b.torsoD / 2 + 0.004, b.torsoW * 0.22, b.torsoH * 0.6, 0.02);
  }

  /* ---- head -------------------------------------------------------- */
  const head = new THREE.Group();
  head.position.y = b.torsoH + b.headR * b.headSquash * 0.86;
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
  const FACE_SPAN = 1.6;
  const FACE_BAND = 1.40;
  faceTex.repeat.set(FACE_SPAN, FACE_BAND);
  faceTex.offset.set(0.5 - 0.25 * FACE_SPAN, 0.5 - 0.5 * FACE_BAND);
  owned.push(faceTex);
  const faceMat = keep(new THREE.MeshStandardMaterial({ map: faceTex, roughness: 0.82 }));

  const headGeo = keep(new THREE.SphereGeometry(b.headR, 22, 18));
  const skull = new THREE.Mesh(headGeo, faceMat);
  skull.scale.set(0.94, b.headSquash, 0.98);
  skull.castShadow = true;
  head.add(skull);

  // Ears, so the silhouette from behind is not a ball on a stick.
  for (const s of [-1, 1]) cube(head, skin, s * b.headR * 0.92, 0, -b.headR * 0.06, 0.05, b.headR * 0.5, b.headR * 0.42);

  // Neck.
  cube(torso, skin, 0, b.torsoH - 0.02, 0, b.headR * 0.5, 0.09, b.headR * 0.5);

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
    const capGeo = keep(new THREE.SphereGeometry(b.headR * 1.06, 22, 12, 0, Math.PI * 2, 0, Math.PI * 0.36));
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

    // Fringe: a fine arc across the forehead, hanging to just above the brows.
    // It has to stop there. Two builds of this had it hanging over his eyes,
    // and a bowl cut with no eyes under it is a wig on a bowling ball.
    for (let i = -4; i <= 4; i++) {
      const a = (i / 4) * 0.66;
      const f = cube(
        head, hairMat,
        Math.sin(a) * b.headR * 0.93, b.headR * 0.72 - Math.abs(i) * 0.008, Math.cos(a) * b.headR * 0.93,
        0.075, 0.13, 0.05,
      );
      f.rotation.y = a;
    }
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

  function arm(side: -1 | 1) {
    const upper = new THREE.Group();
    upper.position.set(side * (b.torsoW / 2 + b.armW * 0.4), b.torsoH * 0.92, 0);
    torso.add(upper);
    cube(upper, limbMat, 0, -b.armLen * 0.28, 0, b.armW, b.armLen * 0.56, b.armW);
    const fore = new THREE.Group();
    fore.position.y = -b.armLen * 0.56;
    upper.add(fore);
    cube(fore, limbMat, 0, -b.armLen * 0.22, 0, b.armW * 0.9, b.armLen * 0.44, b.armW * 0.9);
    // Hand.
    cube(fore, skin, 0, -b.armLen * 0.46, 0, b.armW * 1.05, b.armW * 1.15, b.armW * 1.05);
    return { upper, fore };
  }

  function leg(side: -1 | 1) {
    const thigh = new THREE.Group();
    thigh.position.set(side * b.legW * 1.05, 0, 0);
    torso.add(thigh);
    cube(thigh, legMat, 0, -b.legLen * 0.27, 0, b.legW, b.legLen * 0.54, b.legW);
    const shin = new THREE.Group();
    shin.position.y = -b.legLen * 0.54;
    thigh.add(shin);
    cube(shin, legMat, 0, -b.legLen * 0.23, 0, b.legW * 0.92, b.legLen * 0.46, b.legW * 0.92);
    cube(shin, shoeMat, 0, -b.legLen * 0.46, b.legW * 0.28, b.legW * 1.1, b.legW * 0.9, b.legW * 2.0);
    return { thigh, shin };
  }

  const la = arm(-1);
  const ra = arm(1);
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
