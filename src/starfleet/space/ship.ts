/**
 * The USS ODYSSEY.
 *
 * Still primitives, because the alternative is a mesh somebody owns, but every
 * one of them is now doing more than describing a mass. The silhouette was
 * always right — flat disc forward, roll-bar neck, spindle behind, two lit
 * nacelles held out and up — and a silhouette is what carries a starship at
 * the distance she is usually seen from. What was missing was everything that
 * happens when the camera is nine units away instead of ninety:
 *
 * **Hull plating.** The `metal` bake, sampled triplanar in *object* space at a
 * 0.16-unit tile. Object space is not optional: this thing flies, and a
 * world-space projection makes the plating swim across the hull as she moves,
 * which reads instantly as broken. The tile is chosen so a panel is about the
 * size of a shuttlebay door at this scale.
 *
 * **Greebles.** Sixty small boxes and cylinders scattered over the engineering
 * hull and the nacelle pylons, placed by seeded noise and never larger than a
 * hundredth of the ship. Individually invisible; collectively the difference
 * between a model and a machine. The rule is that they must never break the
 * silhouette — a greeble that sticks out past the profile reads as damage.
 *
 * **Lights that mean something.** Windows in rows along the decks, a lit
 * shuttlebay at the stern, red and green running lights on the correct sides
 * (port red, starboard green — the same convention as a ship at sea, which is
 * where Starfleet got it), and a strobe on the dorsal spine.
 *
 * The nacelle grilles and bussard domes are emissive and animated, and with
 * the bloom in `gfx/post.ts` they are now genuinely the brightest thing in
 * frame — which is what makes her read as *under power* rather than as a
 * grey object that happens to have blue stripes painted on it.
 *
 * Scale note: 3 units long against a 1,200-unit planet, per the lie documented
 * in `types.ts`. Everything is a fraction of `L`, so changing that one number
 * rescales her without breaking the proportions.
 */
import * as THREE from "three";
import { makeRng } from "../types";
import { surfaced } from "../gfx/surfacing";

const L = 3.0; // overall length, scene units

export interface Ship {
  group: THREE.Group;
  /** Impulse glow and nacelle pulse. `warp` 0-1 drives them harder. */
  update(dt: number, throttle: number, warp: number): void;
  dispose(): void;
}

export function createShip(accent = 0x8fd6ff): Ship {
  const g = new THREE.Group();
  // Seeded, so the greebles land in the same places every session.
  const rng = makeRng(0x0d1553);
  const owned: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    owned.push(x);
    return x;
  };

  /* --- materials ---------------------------------------------------------- */
  const hullMat = keep(
    surfaced({
      color: 0xcfd4d8,
      family: "metal",
      // One panel ≈ 4 % of the ship's length. Any tighter and it moirés at
      // orbit distance; any looser and there is nothing to see up close.
      tile: L * 0.055,
      bump: 0.9,
      roughness: 0.62,
      metalness: 0.35,
      macro: 0.07,
      space: "object",
    }),
  );
  const darkMat = keep(
    surfaced({
      color: 0x74808c,
      family: "metal",
      tile: L * 0.04,
      bump: 1.0,
      roughness: 0.72,
      metalness: 0.45,
      macro: 0.05,
      space: "object",
    }),
  );
  const glowMat = (c: number, i = 1.6) =>
    keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(i) }));

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D = g) => {
    keep(geo);
    const m = new THREE.Mesh(geo, mat);
    parent.add(m);
    return m;
  };

  /* --- saucer ------------------------------------------------------------- */
  // A lathe rather than a cylinder: the taper at the rim and the dome on top
  // are what stop it looking like a hockey puck, and both are two points here.
  const R = L * 0.3;
  const profile: THREE.Vector2[] = [
    new THREE.Vector2(0.0, -L * 0.03),
    new THREE.Vector2(R * 0.24, -L * 0.038),
    new THREE.Vector2(R * 0.6, -L * 0.03),
    new THREE.Vector2(R * 0.92, -L * 0.014),
    new THREE.Vector2(R, L * 0.004),
    new THREE.Vector2(R * 0.9, L * 0.018),
    new THREE.Vector2(R * 0.68, L * 0.034),
    new THREE.Vector2(R * 0.35, L * 0.05),
    new THREE.Vector2(0.0, L * 0.055),
  ];
  const saucer = add(new THREE.LatheGeometry(profile, 96), hullMat);
  saucer.position.z = -L * 0.22;

  // Bridge module — a small dome on top. Tiny, and the eye finds it instantly.
  const bridge = add(new THREE.SphereGeometry(L * 0.032, 20, 12), hullMat);
  bridge.position.set(0, L * 0.062, -L * 0.24);
  bridge.scale.y = 0.55;
  const bridgeRing = add(new THREE.TorusGeometry(L * 0.033, L * 0.005, 8, 24), darkMat);
  bridgeRing.position.set(0, L * 0.05, -L * 0.24);
  bridgeRing.rotation.x = Math.PI / 2;

  /* --- windows ------------------------------------------------------------ */
  // Rows of tiny emissive boxes, instanced. Not lights — three compiles a
  // material variant per light count and a hundred of them would recompile the
  // world every frame. See the note in the trek README.
  const winGeo = keep(new THREE.BoxGeometry(L * 0.011, L * 0.005, L * 0.004));
  const winMat = glowMat(0xffe0a8, 1.15);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s3 = new THREE.Vector3(1, 1, 1);
  const yAxis = new THREE.Vector3(0, 1, 0);

  const rimCount = 76;
  const rim = new THREE.InstancedMesh(winGeo, winMat, rimCount);
  for (let i = 0; i < rimCount; i++) {
    const a = (i / rimCount) * Math.PI * 2;
    // Two decks: alternate rows sit a little higher and a little further in.
    const deck = i % 2;
    q.setFromAxisAngle(yAxis, -a);
    m4.compose(
      new THREE.Vector3(
        Math.sin(a) * R * (0.965 - deck * 0.03),
        L * (0.003 + deck * 0.017),
        Math.cos(a) * R * (0.965 - deck * 0.03) - L * 0.22,
      ),
      q,
      s3,
    );
    rim.setMatrixAt(i, m4);
  }
  rim.instanceMatrix.needsUpdate = true;
  g.add(rim);
  owned.push({ dispose: () => rim.dispose() });

  /* --- neck and engineering hull ------------------------------------------ */
  const neck = add(new THREE.BoxGeometry(L * 0.05, L * 0.17, L * 0.14), darkMat);
  neck.position.set(0, -L * 0.055, -L * 0.03);
  neck.rotation.x = -0.32;

  const engineering = add(new THREE.CapsuleGeometry(L * 0.072, L * 0.34, 8, 28), hullMat);
  engineering.rotation.x = Math.PI / 2;
  engineering.position.set(0, -L * 0.13, L * 0.1);

  // A dorsal spine along the engineering hull, which is what gives the stern
  // its profile from the side.
  const spine = add(new THREE.BoxGeometry(L * 0.03, L * 0.03, L * 0.3), darkMat);
  spine.position.set(0, -L * 0.075, L * 0.12);

  // Deflector: the one warm colour on the front of the ship, in a housing.
  const dish = add(new THREE.CircleGeometry(L * 0.056, 40), glowMat(0xffb44a, 2.6));
  dish.position.set(0, -L * 0.13, -L * 0.147);
  dish.rotation.y = Math.PI;
  const dishRing = add(new THREE.TorusGeometry(L * 0.062, L * 0.009, 10, 36), darkMat);
  dishRing.position.set(0, -L * 0.13, -L * 0.145);
  const dishHousing = add(new THREE.CylinderGeometry(L * 0.07, L * 0.062, L * 0.03, 28), hullMat);
  dishHousing.rotation.x = Math.PI / 2;
  dishHousing.position.set(0, -L * 0.13, -L * 0.128);

  // Shuttlebay, lit, at the stern. A ship with a lit door in the back reads as
  // somewhere people work.
  const bay = add(new THREE.BoxGeometry(L * 0.075, L * 0.038, L * 0.006), glowMat(0xbfe4ff, 1.5));
  bay.position.set(0, -L * 0.13, L * 0.285);

  /* --- greebles ----------------------------------------------------------- */
  /* Sixty small boxes on the engineering hull and pylons.
   *
   * The rule that keeps them from looking like damage: they hug the surface
   * they are on and never break the silhouette. Anything that stands proud of
   * the profile stops reading as machinery and starts reading as a hit. */
  const greebleGeo = keep(new THREE.BoxGeometry(1, 1, 1));
  const greebles = new THREE.InstancedMesh(greebleGeo, darkMat, 64);
  for (let i = 0; i < 64; i++) {
    const along = rng();
    const ang = rng() * Math.PI * 2;
    const r = L * 0.073;
    const pos = new THREE.Vector3(
      Math.cos(ang) * r,
      -L * 0.13 + Math.sin(ang) * r,
      L * (-0.08 + along * 0.38),
    );
    q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), ang);
    m4.compose(
      pos,
      q,
      new THREE.Vector3(
        L * (0.006 + rng() * 0.014),
        L * (0.004 + rng() * 0.008),
        L * (0.008 + rng() * 0.03),
      ),
    );
    greebles.setMatrixAt(i, m4);
  }
  greebles.instanceMatrix.needsUpdate = true;
  g.add(greebles);
  owned.push({ dispose: () => greebles.dispose() });

  /* --- nacelles ----------------------------------------------------------- */
  const grilles: THREE.Mesh[] = [];
  const bussards: THREE.Mesh[] = [];
  const grilleColor = new THREE.Color(accent);

  for (const side of [-1, 1]) {
    const pylon = add(new THREE.BoxGeometry(L * 0.022, L * 0.18, L * 0.11), darkMat);
    pylon.position.set(side * L * 0.11, -L * 0.045, L * 0.2);
    pylon.rotation.z = side * -0.62;
    pylon.rotation.x = 0.24;

    const nac = new THREE.Group();
    nac.position.set(side * L * 0.235, L * 0.055, L * 0.17);
    g.add(nac);

    const body = add(new THREE.CapsuleGeometry(L * 0.035, L * 0.4, 8, 26), hullMat, nac);
    body.rotation.x = Math.PI / 2;

    // A collar where the pylon meets the nacelle. Two rings, and they are what
    // stop the join reading as two objects pushed into each other.
    const collar = add(new THREE.CylinderGeometry(L * 0.042, L * 0.042, L * 0.03, 24), darkMat, nac);
    collar.rotation.x = Math.PI / 2;
    collar.position.z = L * 0.02;

    // Bussard collector: the red dome at the front, in a cowl.
    const bus = add(new THREE.SphereGeometry(L * 0.036, 24, 16), glowMat(0xff5a2a, 1.4), nac);
    bus.position.z = -L * 0.235;
    bus.scale.z = 1.25;
    bussards.push(bus);
    const cowl = add(new THREE.TorusGeometry(L * 0.037, L * 0.006, 10, 28), darkMat, nac);
    cowl.position.z = -L * 0.21;

    // The grille — a flat panel down each face. This is the blue that says
    // "warp drive" at a distance where nothing else is resolvable.
    for (const face of [-1, 1]) {
      const grille = add(
        new THREE.BoxGeometry(L * 0.006, L * 0.03, L * 0.3),
        glowMat(accent, 1.5),
        nac,
      );
      grille.position.set(face * L * 0.036, 0, L * 0.02);
      grilles.push(grille);
    }

    // Running light: port red, starboard green — the same convention as a ship
    // at sea, which is where Starfleet got it.
    const nav = add(
      new THREE.SphereGeometry(L * 0.008, 8, 6),
      glowMat(side < 0 ? 0xff2020 : 0x20ff40, 3.0),
      nac,
    );
    nav.position.set(side * L * 0.04, L * 0.03, -L * 0.05);
  }

  /* --- impulse engines ---------------------------------------------------- */
  const impulse = add(new THREE.BoxGeometry(L * 0.13, L * 0.022, L * 0.012), glowMat(0xff7a3a, 0.6));
  impulse.position.set(0, L * 0.006, -L * 0.055);

  // Dorsal strobe. One blink a second, and it is the only thing on the model
  // that moves when the ship is dead in space.
  const strobe = add(new THREE.SphereGeometry(L * 0.007, 8, 6), glowMat(0xffffff, 3.0));
  strobe.position.set(0, L * 0.075, -L * 0.24);

  let t = 0;

  return {
    group: g,
    update(dt, throttle, warp) {
      t += dt;
      // Bussards breathe at about 0.4 Hz at rest and speed up under power.
      const pulse = 0.75 + Math.sin(t * (2.4 + warp * 8)) * 0.25;
      for (const b of bussards) {
        (b.material as THREE.MeshBasicMaterial).color.setRGB(1.7 * pulse, 0.42 * pulse, 0.18 * pulse);
      }
      const gl = 1.6 + warp * 3.4 + Math.sin(t * 3.1) * 0.1;
      for (const gr of grilles) {
        (gr.material as THREE.MeshBasicMaterial).color.copy(grilleColor).multiplyScalar(gl);
      }
      const im = 0.4 + Math.max(0, throttle) * 3.0;
      (impulse.material as THREE.MeshBasicMaterial).color.setRGB(im, im * 0.42, im * 0.2);
      const blink = (t % 1.4) < 0.09 ? 4.0 : 0.04;
      (strobe.material as THREE.MeshBasicMaterial).color.setScalar(blink);
    },
    dispose() {
      for (const o of owned) {
        try {
          o.dispose();
        } catch {
          /* already gone */
        }
      }
      g.parent?.remove(g);
    },
  };
}
