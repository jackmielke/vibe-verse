/**
 * The cast, built out of boxes and spheres.
 *
 * The rule that shaped all four of them: at the distance and light level you
 * ever actually see one, silhouette and eye-glow are the entire performance.
 * So the ears are tall, the jaws are wide, the eyes are two hot white dots in a
 * black socket, and nobody got a nose worth more than one sphere.
 *
 * They walk. In the original they cut between stills, which was a budget
 * decision that became a style; here there is a real room between the stage and
 * your door, so they cross it — `walkTo()` sets a target and `update()` runs a
 * gait until they arrive. Seeing Bonnie halfway down the west hall on camera,
 * mid-stride, is worth the fifty lines it costs.
 */
import * as THREE from "three";

export type AnimKind = "freddy" | "bonnie" | "chica" | "foxy";

export interface Animatronic {
  kind: AnimKind;
  root: THREE.Group;
  head: THREE.Group;
  jaw: THREE.Group;
  eyeMats: THREE.MeshStandardMaterial[];
  limbs: {
    la: THREE.Object3D;
    ra: THREE.Object3D;
    ll: THREE.Object3D;
    rl: THREE.Object3D;
    /** Elbows and knees — what makes a run a run instead of a swing. */
    le: THREE.Object3D;
    re: THREE.Object3D;
    lk: THREE.Object3D;
    rk: THREE.Object3D;
  };
  /** Metres per second when crossing a room. Foxy is not like the others. */
  speed: number;
  /**
   * Floor height at the destination. The show stage and Pirate Cove are on
   * risers, and without this the three of them stand shin-deep in the stage.
   */
  groundY: number;
  /** Where it is heading; null when parked. */
  target: THREE.Vector3 | null;
  targetYaw: number;
  /** Gait phase, so the legs keep swinging across frames. */
  phase: number;
  /** 0 = walking, 1 = flat sprint. Blended from speed, not switched. */
  runBlend: number;
  /** 0 = idle, 1 = fully lunging. Driven by the jumpscare. */
  scare: number;
  walkTo: (x: number, z: number, yaw: number, speed?: number, y?: number) => void;
  /**
   * Walk a list of waypoints. Rooms connect through doorways, so anything
   * further than the next room over has to be routed — see `pathBetween`.
   * Without this they cut the corner and clip through the wall, which is
   * exactly the sort of thing a camera catches.
   */
  walkPath: (points: Array<[number, number]>, yaw: number, speed?: number, y?: number) => void;
  teleport: (x: number, z: number, yaw: number, y?: number) => void;
  update: (dt: number, t: number) => void;
  /** True while still walking. The AI waits for this before its next move. */
  moving: () => boolean;
}

const PALETTE: Record<
  AnimKind,
  { fur: number; muzzle: number; accent: number; eye: number; iris: number; inner: number }
> = {
  // `inner` is ear-lining and belly plate. It is deliberately close to `fur`
  // rather than to `muzzle`: lining an ear in the muzzle tone made Bonnie's
  // ears read as two lit tubes from across a dark room.
  freddy: { fur: 0x6b4526, muzzle: 0x8a5f36, accent: 0x14141a, eye: 0xf6f2e6, iris: 0x2f6ecf, inner: 0x5c3a20 },
  bonnie: { fur: 0x54397f, muzzle: 0x6f52a0, accent: 0xb02a3c, eye: 0xf6f2e6, iris: 0xc0397a, inner: 0x6a4f95 },
  chica: { fur: 0xd9bb35, muzzle: 0xe8a13a, accent: 0xe86a2a, eye: 0xf6f2e6, iris: 0x9b6ad0, inner: 0xc9a92e },
  foxy: { fur: 0x8c3320, muzzle: 0xa8452c, accent: 0xd8d2c0, eye: 0xffe9a8, iris: 0x141414, inner: 0x7a2b1a },
};

function mat(color: number, rough = 0.86, metal = 0.04) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}

function bibTexture() {
  const el = document.createElement("canvas");
  el.width = el.height = 128;
  const c = el.getContext("2d")!;
  c.fillStyle = "#f0ead4";
  c.fillRect(0, 0, 128, 128);
  c.fillStyle = "#c8202c";
  c.font = "bold 22px Impact, sans-serif";
  c.textAlign = "center";
  c.fillText("LET'S", 64, 52);
  c.fillText("EAT!!!", 64, 82);
  return new THREE.CanvasTexture(el);
}

/**
 * A bow tie, worn under the chin. It used to be one box at chest height, which
 * the skull hung over and hid — and a box is not a bow anyway.
 */
function bowTie(m: THREE.Material, y: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(0, y, 0.27);
  for (const s of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.ConeGeometry(0.088, 0.15, 4), m);
    wing.rotation.z = s * Math.PI / 2;
    wing.position.x = s * 0.078;
    g.add(wing);
  }
  const knot = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.07, 0.06), m);
  g.add(knot);
  return g;
}

export function makeAnimatronic(kind: AnimKind): Animatronic {
  const p = PALETTE[kind];
  const fur = mat(p.fur);
  const muzzle = mat(p.muzzle, 0.9);
  const accent = mat(p.accent, 0.7);
  const endo = mat(0x9aa1a9, 0.35, 0.8);

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const bx = (w: number, h: number, d: number, m: THREE.Material) =>
    new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  const sp = (r: number, m: THREE.Material, seg = 14) =>
    new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(8, seg - 4)), m);

  /* torso ---------------------------------------------------------------- */
  const chest = bx(0.8, 0.84, 0.5, fur);
  chest.position.y = 1.22;
  chest.castShadow = true;
  body.add(chest);
  // A belly *plate* pressed into the chest, not a sphere sitting on top of it.
  // The sphere read as a beach ball stuck to the front of a box from every
  // angle the game ever shows you.
  const belly = sp(0.32, mat(p.inner, 0.9), 16);
  belly.position.set(0, 1.05, 0.19);
  belly.scale.set(1.02, 1.18, 0.34);
  body.add(belly);
  const hips = bx(0.62, 0.3, 0.44, fur);
  hips.position.y = 0.76;
  body.add(hips);

  /* legs ------------------------------------------------------------------
   * Hip and knee, not one rigid limb. A leg that only swings from the hip is a
   * pendulum, and a pendulum cannot run — the knee is the whole difference
   * between Foxy sprinting and Foxy skating down the hall.
   */
  const legs: THREE.Object3D[] = [];
  const knees: THREE.Object3D[] = [];
  for (const s of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(s * 0.19, 0.72, 0);
    body.add(hip);
    // Foxy's suit is shredded, so his shins are bare endoskeleton.
    const thigh = bx(0.24, 0.42, 0.26, fur);
    thigh.position.y = -0.21;
    hip.add(thigh);

    const knee = new THREE.Group();
    knee.position.y = -0.42;
    hip.add(knee);
    const shin = bx(0.2, 0.36, 0.22, kind === "foxy" ? endo : fur);
    shin.position.y = -0.16;
    knee.add(shin);
    const foot = bx(0.26, 0.12, 0.42, kind === "foxy" ? endo : fur);
    foot.position.set(0, -0.3, 0.08);
    knee.add(foot);

    legs.push(hip);
    knees.push(knee);
  }

  /* arms ----------------------------------------------------------------- */
  const arms: THREE.Object3D[] = [];
  const elbows: THREE.Object3D[] = [];
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(s * 0.45, 1.5, 0);
    body.add(pivot);
    // A shoulder ball at the pivot. Without it the arm starts below the top of
    // the chest and the whole limb reads as detached.
    const shoulder = sp(0.15, fur, 10);
    pivot.add(shoulder);
    const upper = bx(0.19, 0.42, 0.19, fur);
    upper.position.y = -0.21;
    pivot.add(upper);

    const elbow = new THREE.Group();
    elbow.position.y = -0.42;
    pivot.add(elbow);
    const fore = bx(0.17, 0.4, 0.17, kind === "foxy" && s > 0 ? endo : fur);
    fore.position.y = -0.18;
    elbow.add(fore);
    if (kind === "foxy" && s > 0) {
      // The hook.
      const hook = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.028, 6, 14, Math.PI * 1.4), endo);
      hook.position.set(0, -0.46, 0);
      hook.rotation.set(Math.PI / 2, 0, 0.4);
      elbow.add(hook);
    } else {
      const hand = sp(0.12, fur, 10);
      hand.position.y = -0.44;
      elbow.add(hand);
      // Three stubby fingers — enough to read as a hand in silhouette.
      for (let f = -1; f <= 1; f++) {
        const finger = bx(0.05, 0.16, 0.05, fur);
        finger.position.set(f * 0.06, -0.56, 0.02);
        elbow.add(finger);
      }
    }
    arms.push(pivot);
    elbows.push(elbow);
  }

  /* head ----------------------------------------------------------------- */
  // A short neck, then a head a size larger than the anatomy wants. Both are
  // deliberate: the first stops the skull sitting on the collarbone, and the
  // second is why you can tell which one is in the hall from the far camera.
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.16, 12), fur);
  neck.position.y = 1.68;
  body.add(neck);

  const head = new THREE.Group();
  head.position.y = 1.86;
  body.add(head);

  const skull = sp(0.37, fur, 18);
  skull.scale.set(1.05, 1, 1.02);
  skull.castShadow = true;
  head.add(skull);

  // Ears: the fastest way to tell four silhouettes apart in the dark. Each one
  // is lined in `inner` rather than `muzzle` — the muzzle tone is bright enough
  // that Bonnie's ears turned into two glowing tubes under a hall light.
  const innerMat = mat(p.inner, 0.95);
  if (kind === "bonnie") {
    for (const s of [-1, 1]) {
      const ear = bx(0.15, 0.5, 0.13, fur);
      ear.position.set(s * 0.16, 0.5, -0.03);
      ear.rotation.z = s * 0.12;
      head.add(ear);
      // Rounded tip, so the ear stops looking like a length of timber.
      const tip = sp(0.075, fur, 10);
      tip.scale.set(1, 1.05, 0.87);
      tip.position.set(s * 0.16 - Math.sin(s * 0.12) * 0.25, 0.5 + 0.25, -0.03);
      head.add(tip);
      const inner = bx(0.075, 0.34, 0.03, innerMat);
      inner.position.set(s * 0.16, 0.5, 0.05);
      inner.rotation.z = s * 0.12;
      head.add(inner);
    }
  } else if (kind === "foxy") {
    for (const s of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.28, 4), fur);
      ear.position.set(s * 0.22, 0.4, -0.02);
      ear.rotation.z = s * 0.2;
      head.add(ear);
    }
  } else if (kind === "chica") {
    // A chicken has no ears. She had Freddy's, which is most of why her head
    // read wrong. Three feathers instead, swept back off the crown.
    for (let i = -1; i <= 1; i++) {
      const quill = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.3, 6), fur);
      quill.position.set(i * 0.12, 0.36, -0.06 - Math.abs(i) * 0.02);
      quill.rotation.x = -0.5;
      quill.rotation.z = i * 0.35;
      head.add(quill);
    }
  } else {
    // Freddy: round bear ears standing on the crown, facing forward, not flat
    // discs bolted to the sides of the skull at mid-height.
    for (const s of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.155, 0.075, 18), fur);
      ear.position.set(s * 0.245, 0.31, -0.03);
      ear.rotation.x = Math.PI / 2;
      head.add(ear);
      const inner = new THREE.Mesh(new THREE.CylinderGeometry(0.092, 0.092, 0.02, 16), innerMat);
      inner.position.set(s * 0.245, 0.31, 0.02);
      inner.rotation.x = Math.PI / 2;
      head.add(inner);
    }
  }

  // Muzzle / beak / snout, and the jaw that opens under it.
  const jaw = new THREE.Group();
  jaw.position.set(0, -0.12, 0.18);
  head.add(jaw);

  if (kind === "chica") {
    /*
     * A wide flat bill, built from tapered boxes, sitting *proud of the face*.
     *
     * Two things were wrong before and both mattered.
     *
     * The solid was wrong: a four-sided cone pointed down the view axis is a
     * rhombus seen head-on, so her whole face was a kite. A tapered box reads
     * as a bill from every angle.
     *
     * And the placement was wrong, which is the part that survived the first
     * fix. The skull is radius 0.377 in Z, so its surface at beak height is at
     * z ≈ 0.374 — a 0.34-deep beak centred at z = 0.31 is therefore *inside her
     * head*, with only the narrow tapered tip breaking the surface. Hence the
     * numbers below: back edge tucked just inside the skull at 0.28, front edge
     * out at 0.62, so a quarter of a metre of bill actually projects. If this
     * ever needs moving again, move it in Z against the skull radius rather
     * than nudging it and looking at the front view — from straight on, a beak
     * buried in the face and a beak sticking out of it look nearly identical.
     */
    const beakMat = mat(p.muzzle, 0.7);
    const mandible = (w: number, h: number, d: number, taper: number) => {
      const g = new THREE.BoxGeometry(w, h, d);
      // Pinch the front face in, so it is a bill and not a brick.
      const pos = g.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        if (pos.getZ(i) > 0) {
          pos.setX(i, pos.getX(i) * taper);
          pos.setY(i, pos.getY(i) * taper);
        }
      }
      pos.needsUpdate = true;
      g.computeVertexNormals();
      return g;
    };

    const upperBeak = new THREE.Mesh(mandible(0.32, 0.1, 0.34, 0.66), beakMat);
    upperBeak.position.set(0, -0.05, 0.45);
    upperBeak.rotation.x = 0.13;
    head.add(upperBeak);

    // Jaw sits at (0, -0.12, 0.18), so this lands at world (0, -0.135, 0.43):
    // directly under the upper bill, meeting it along the mouth line.
    const lowerBeak = new THREE.Mesh(mandible(0.28, 0.075, 0.3, 0.7), beakMat);
    lowerBeak.position.set(0, -0.015, 0.25);
    lowerBeak.rotation.x = -0.05;
    jaw.add(lowerBeak);

    // The seam, so the mouth is a line rather than a crease between two solids.
    const gape = bx(0.3, 0.018, 0.3, mat(0x140f08, 0.9));
    gape.position.set(0, -0.099, 0.46);
    head.add(gape);
  } else if (kind === "foxy") {
    const snout = bx(0.24, 0.16, 0.4, muzzle);
    snout.position.set(0, 0.0, 0.36);
    head.add(snout);
    const lower = bx(0.22, 0.1, 0.36, muzzle);
    lower.position.set(0, -0.05, 0.2);
    jaw.add(lower);
    // Teeth: Foxy's are the point of Foxy.
    for (let i = 0; i < 6; i++) {
      const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.09, 4), mat(0xf2ead4, 0.6));
      tooth.position.set(-0.09 + i * 0.036, -0.07, 0.49);
      tooth.rotation.x = Math.PI;
      head.add(tooth);
      const bottom = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.07, 4), mat(0xe8dcc0, 0.6));
      bottom.position.set(-0.09 + i * 0.036, -0.02, 0.34);
      jaw.add(bottom);
    }
    // Eyepatch, flipped up over the brow — he is on duty tonight.
    const patch = bx(0.16, 0.14, 0.03, mat(0x15151a, 0.9));
    patch.position.set(0.16, 0.25, 0.31);
    patch.rotation.z = -0.3;
    head.add(patch);
  } else {
    const m = sp(0.22, muzzle, 14);
    m.scale.set(1.15, 0.78, 1);
    m.position.set(0, -0.06, 0.25);
    head.add(m);
    const lowerJaw = sp(0.2, muzzle, 12);
    lowerJaw.scale.set(1.1, 0.42, 0.95);
    lowerJaw.position.set(0, -0.06, 0.08);
    jaw.add(lowerJaw);
    const nose = sp(0.07, mat(0x151519, 0.5), 10);
    nose.position.set(0, 0.02, 0.46);
    head.add(nose);
    for (let i = 0; i < 5; i++) {
      const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.06, 0.03), mat(0xf2ead4, 0.6));
      tooth.position.set(-0.08 + i * 0.04, -0.14, 0.42);
      head.add(tooth);
    }
  }

  /*
   * Eyes — two lit dots set *into* a dark socket.
   *
   * What was wrong before: the iris was a full sphere floating in front of the
   * eyeball and the pupil a second one in front of that, so every face had two
   * stalks growing out of it. The eyeball now sits flush with the skull, and
   * the iris is a heavily flattened sphere resting on its surface — proud by
   * about a millimetre, enough to catch light, not enough to be a nose.
   */
  const eyeMats: THREE.MeshStandardMaterial[] = [];
  const EYE_X = 0.152;
  const EYE_Y = 0.09;
  const EYE_R = 0.1;
  const EYE_Z = 0.255;
  for (const s of [-1, 1]) {
    // The socket is a shell behind the eye, so the eye reads as set in a hole.
    const socket = sp(0.132, mat(0x08080c, 0.7), 14);
    socket.position.set(s * EYE_X, EYE_Y, EYE_Z - 0.05);
    socket.scale.set(1, 1, 0.85);
    head.add(socket);

    const eyeMat = new THREE.MeshStandardMaterial({
      color: p.eye,
      emissive: new THREE.Color(p.eye),
      emissiveIntensity: 1.35,
      roughness: 0.3,
    });
    eyeMats.push(eyeMat);
    const eye = sp(EYE_R, eyeMat, 16);
    eye.position.set(s * EYE_X, EYE_Y, EYE_Z);
    head.add(eye);

    const iris = sp(0.053, mat(p.iris, 0.3), 14);
    iris.scale.set(1, 1, 0.3);
    iris.position.set(s * EYE_X, EYE_Y, EYE_Z + EYE_R * 0.93);
    head.add(iris);
    const pupil = sp(0.023, mat(0x050505, 0.2), 10);
    pupil.scale.set(1, 1, 0.35);
    pupil.position.set(s * EYE_X, EYE_Y, EYE_Z + EYE_R * 1.02);
    head.add(pupil);

    // Brow. Thin, and tucked against the skull rather than hovering off it —
    // at the old depth it read as a plank taped above the eye.
    const brow = bx(0.155, 0.042, 0.055, mat(p.inner, 0.9));
    brow.position.set(s * (EYE_X + 0.012), EYE_Y + 0.128, EYE_Z + 0.03);
    brow.rotation.z = -s * 0.32;
    head.add(brow);
  }

  /* per-character dressing ----------------------------------------------- */
  if (kind === "freddy") {
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.39, 0.39, 0.035, 18), accent);
    brim.position.y = 0.36;
    head.add(brim);
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.25, 0.3, 18), accent);
    crown.position.y = 0.5;
    head.add(crown);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.252, 0.252, 0.06, 18), mat(0x2a2a34, 0.8));
    band.position.y = 0.4;
    head.add(band);
    body.add(bowTie(accent, 1.44));
    for (const y of [1.2, 1.02]) {
      const btn = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 10), accent);
      btn.rotation.x = Math.PI / 2;
      btn.position.set(0, y, 0.3);
      body.add(btn);
    }
    // Microphone in the right hand — he never puts it down.
    const mic = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.16, 8), mat(0x1b1b22, 0.5, 0.3));
    mic.position.set(0, -1.02, 0.04);
    arms[1].add(mic);
    const micHead = sp(0.055, mat(0x6a6a74, 0.4, 0.6), 10);
    micHead.position.set(0, -1.12, 0.04);
    arms[1].add(micHead);
  } else if (kind === "bonnie") {
    body.add(bowTie(accent, 1.44));
    // The guitar, slung across the front. Bonnie only carries it on stage —
    // the AI drops it when he leaves, which is a small thing you notice.
    const guitar = new THREE.Group();
    guitar.name = "guitar";
    const bodyG = bx(0.22, 0.28, 0.07, mat(0x6d1a26, 0.45, 0.25));
    guitar.add(bodyG);
    const neck = bx(0.06, 0.38, 0.05, mat(0x2a1a10, 0.7));
    neck.position.y = 0.32;
    guitar.add(neck);
    const head6 = bx(0.08, 0.1, 0.04, mat(0x2a1a10, 0.7));
    head6.position.y = 0.54;
    guitar.add(head6);
    guitar.position.set(0.24, 1.02, 0.31);
    guitar.rotation.set(0, -0.25, 0.62);
    body.add(guitar);
  } else if (kind === "chica") {
    const bib = new THREE.Mesh(
      new THREE.PlaneGeometry(0.46, 0.36),
      new THREE.MeshStandardMaterial({ map: bibTexture(), roughness: 0.95 }),
    );
    bib.position.set(0, 1.34, 0.33);
    body.add(bib);
    // The cupcake, held out in the left hand, staring at you.
    const cup = new THREE.Group();
    cup.position.set(0, -1.06, 0.06);
    arms[0].add(cup);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.06, 0.09, 12), mat(0xc98a4a, 0.9));
    cup.add(base);
    const icing = sp(0.085, mat(0xf2c8d8, 0.7), 12);
    icing.position.y = 0.07;
    icing.scale.y = 0.8;
    cup.add(icing);
    for (const s of [-1, 1]) {
      const e = sp(0.026, new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.8 }), 8);
      e.position.set(s * 0.035, 0.09, 0.07);
      cup.add(e);
    }
    const candle = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.07, 6), mat(0xfff0d0, 0.6));
    candle.position.y = 0.15;
    cup.add(candle);
  } else {
    // Foxy: torn chest plating over the endoskeleton.
    for (let i = 0; i < 5; i++) {
      const rag = bx(0.16, 0.2, 0.04, fur);
      rag.position.set(-0.28 + i * 0.14, 1.02 + (i % 2) * 0.12, 0.26);
      rag.rotation.z = (Math.random() - 0.5) * 0.5;
      body.add(rag);
    }
    const ribs = bx(0.4, 0.4, 0.3, endo);
    ribs.position.set(0, 1.06, 0.1);
    body.add(ribs);
  }

  /* rig ------------------------------------------------------------------- */
  const queue: THREE.Vector3[] = [];
  const a: Animatronic = {
    kind,
    root,
    head,
    jaw,
    eyeMats,
    limbs: {
      la: arms[0],
      ra: arms[1],
      ll: legs[0],
      rl: legs[1],
      le: elbows[0],
      re: elbows[1],
      lk: knees[0],
      rk: knees[1],
    },
    speed: kind === "foxy" ? 6.5 : 1.35,
    groundY: 0,
    runBlend: 0,
    target: null,
    targetYaw: 0,
    phase: 0,
    scare: 0,
    walkTo(x, z, yaw, speed, y = 0) {
      queue.length = 0;
      a.target = new THREE.Vector3(x, 0, z);
      a.targetYaw = yaw;
      a.groundY = y;
      if (speed) a.speed = speed;
    },
    walkPath(points, yaw, speed, y = 0) {
      queue.length = 0;
      if (!points.length) return;
      for (const [x, z] of points.slice(1)) queue.push(new THREE.Vector3(x, 0, z));
      a.target = new THREE.Vector3(points[0][0], 0, points[0][1]);
      a.targetYaw = yaw;
      a.groundY = y;
      if (speed) a.speed = speed;
    },
    teleport(x, z, yaw, y = 0) {
      queue.length = 0;
      root.position.set(x, y, z);
      root.rotation.y = yaw;
      a.target = null;
      a.targetYaw = yaw;
      a.groundY = y;
      // Land standing up, not mid-sprint: a parked character carrying a lean
      // and a bent knee reads as broken.
      a.runBlend = 0;
      a.phase = 0;
    },
    moving: () => a.target !== null,
    update(dt, t) {
      const { la, ra, ll, rl, le, re, lk, rk } = a.limbs;

      if (a.target) {
        const d = a.target.clone().sub(root.position);
        d.y = 0;
        const dist = d.length();
        if (dist < 0.09) {
          a.target = queue.length ? queue.shift()! : null;
          if (!a.target) a.phase = 0;
        } else {
          const step = Math.min(dist, a.speed * dt);
          root.position.addScaledVector(d.normalize(), step);
          // Face the walk, then settle into the slot's facing on arrival.
          const want = Math.atan2(d.x, d.z);
          let diff = want - root.rotation.y;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          root.rotation.y += diff * Math.min(1, dt * 6);
          // Stride rate rises with speed but not linearly — at Foxy's 6.5 m/s
          // the walk cadence would be three and a half strides a second, which
          // reads as a cartoon scramble rather than a sprint.
          a.phase += dt * a.speed * (a.speed > 3 ? 1.9 : 3.1);
        }
      } else {
        let diff = a.targetYaw - root.rotation.y;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        root.rotation.y += diff * Math.min(1, dt * 4);
        a.phase *= Math.max(0, 1 - dt * 5);
      }

      // Step up onto the riser rather than popping; a metre a second reads as
      // a machine climbing one step, which is what it is.
      const dy = a.groundY - root.position.y;
      if (Math.abs(dy) > 0.001) root.position.y += Math.sign(dy) * Math.min(Math.abs(dy), dt * 1.1);

      /*
       * One gait, blended by speed. A walker sits near runBlend 0 and swings
       * gently from the hip; Foxy at 6.5 m/s sits at 1 and gets the lot — long
       * stride, knees folding under him, elbows up, a forward lean and a bounce
       * on every footfall. Blending rather than switching means the first
       * stride out of the cove accelerates into the sprint instead of snapping.
       */
      const wantRun = a.target ? Math.min(1, Math.max(0, (a.speed - 1.8) / 3.6)) : 0;
      a.runBlend += (wantRun - a.runBlend) * Math.min(1, dt * 6);
      const run = a.runBlend;

      const swing = Math.sin(a.phase);
      const swingBack = Math.sin(a.phase + Math.PI);
      const amp = 0.5 + run * 0.62;
      ll.rotation.x = swing * amp;
      rl.rotation.x = swingBack * amp;
      // A knee only folds one way. Most of the fold happens as the foot comes
      // through underneath, which is the shape the eye reads as "running".
      const fold = 0.3 + run * 1.35;
      lk.rotation.x = -Math.max(0, -swing) * fold - run * 0.12;
      rk.rotation.x = -Math.max(0, -swingBack) * fold - run * 0.12;

      la.rotation.x = -swing * (0.42 + run * 0.55);
      ra.rotation.x = -swingBack * (0.42 + run * 0.55);
      le.rotation.x = -(0.12 + run * 0.95);
      re.rotation.x = -(0.12 + run * 0.95);

      body.rotation.x = run * 0.3;
      body.rotation.z = swing * 0.05 * run;
      body.position.y = Math.abs(swing) * (0.045 + run * 0.055) - run * 0.05;

      // Idle: a servo twitch every couple of seconds. Nothing here is alive,
      // and the twitch is what says so.
      const twitch = Math.sin(t * 0.7 + kind.length) > 0.985 ? (Math.random() - 0.5) * 0.25 : 0;
      if (a.scare < 0.01) {
        head.rotation.y = Math.sin(t * 0.31 + kind.length * 2) * 0.06 + twitch;
        // Counter the body's lean and then some, so a sprinter is looking down
        // the hall at you rather than at the floor in front of his feet.
        head.rotation.x = Math.sin(t * 0.23) * 0.03 - run * 0.42;
        // Running with your mouth shut is for people who are not Foxy.
        jaw.rotation.x = 0.04 + Math.sin(t * 0.9 + kind.length) * 0.03 + run * 0.34;
      }

      // The scare pose: jaw wide, head thrown back, arms up.
      if (a.scare > 0) {
        const s = a.scare;
        body.rotation.x = -s * 0.12;
        body.rotation.z = 0;
        // Arms up and folded, legs straight — a lunge, not a jog.
        le.rotation.x = -1.5 * s;
        re.rotation.x = -1.5 * s;
        lk.rotation.x = -0.1 * s;
        rk.rotation.x = -0.1 * s;
        jaw.rotation.x = 0.05 + s * 0.95;
        head.rotation.x = -s * 0.12 + Math.sin(t * 60) * 0.05 * s;
        head.rotation.y = Math.sin(t * 47) * 0.09 * s;
        la.rotation.x = -2.1 * s;
        ra.rotation.x = -2.1 * s;
        la.rotation.z = 0.5 * s;
        ra.rotation.z = -0.5 * s;
        eyeMats.forEach((m) => (m.emissiveIntensity = 1.35 + s * 2.5));
      }
    },
  };

  a.teleport(0, 0, 0);
  return a;
}

/** Bonnie's guitar stays on the stage when he leaves it. */
export function setGuitarVisible(a: Animatronic, visible: boolean) {
  a.root.traverse((o) => {
    if (o.name === "guitar") o.visible = visible;
  });
}
