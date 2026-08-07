/**
 * The USS ODYSSEY — everything you see of your own ship.
 *
 * Built entirely from primitives and one lathe, because the alternative is a
 * mesh somebody owns. The silhouette is the whole job: a flat disc forward, a
 * roll-bar of a neck, a spindle behind it, and two lit nacelles held out and
 * up on swept pylons. Get those five masses in the right places and the
 * profile reads as a Federation starship from any angle at any distance, which
 * no amount of hull plating would achieve if they were wrong.
 *
 * The one thing that is not primitives: the nacelle grilles and the bussard
 * domes are emissive and *animated*, and they are the only part of the model a
 * player at orbit distance will actually be able to resolve. A starship whose
 * engines are not lit is a paperweight.
 *
 * Scale note: 3 units long against a 1,200-unit planet, per the lie documented
 * in `types.ts`. Everything below is expressed as a fraction of `L`, so
 * changing that one number rescales her without breaking the proportions.
 */
import * as THREE from "three";

const L = 3.0; // overall length, scene units

export interface Ship {
  group: THREE.Group;
  /** Impulse glow and nacelle pulse. `warp` 0-1 drives them harder. */
  update(dt: number, throttle: number, warp: number): void;
  dispose(): void;
}

export function createShip(accent = 0x8fd6ff): Ship {
  const g = new THREE.Group();

  const hullMat = new THREE.MeshStandardMaterial({
    color: 0xb8bfc6,
    roughness: 0.55,
    metalness: 0.28,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x6b7480,
    roughness: 0.7,
    metalness: 0.2,
  });
  const glowMat = (c: number, i = 1.6) =>
    new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(i) });

  /* --- saucer ------------------------------------------------------------ */
  // A lathe rather than a cylinder: the taper at the rim and the dome on top
  // are what stop it looking like a hockey puck, and both are two points here.
  const R = L * 0.30;
  const profile: THREE.Vector2[] = [
    new THREE.Vector2(0.0, L * 0.055),
    new THREE.Vector2(R * 0.35, L * 0.05),
    new THREE.Vector2(R * 0.68, L * 0.034),
    new THREE.Vector2(R * 0.9, L * 0.018),
    new THREE.Vector2(R, L * 0.004),
    new THREE.Vector2(R * 0.92, -L * 0.014),
    new THREE.Vector2(R * 0.6, -L * 0.03),
    new THREE.Vector2(R * 0.24, -L * 0.038),
    new THREE.Vector2(0.0, -L * 0.03),
  ];
  const saucer = new THREE.Mesh(new THREE.LatheGeometry(profile, 64), hullMat);
  saucer.position.z = -L * 0.22;
  g.add(saucer);

  // Bridge module — a small dome on top. Tiny, and the eye finds it instantly.
  const bridge = new THREE.Mesh(new THREE.SphereGeometry(L * 0.032, 16, 10), hullMat);
  bridge.position.set(0, L * 0.062, -L * 0.24);
  bridge.scale.y = 0.55;
  g.add(bridge);

  // Rim lighting: a ring of windows around the saucer edge. One instanced ring
  // of tiny boxes, not lights — see the note in the trek README about three
  // recompiling a material variant per light count.
  const winGeo = new THREE.BoxGeometry(L * 0.012, L * 0.006, L * 0.004);
  const winMat = glowMat(0xffe6b0, 1.1);
  const rim = new THREE.InstancedMesh(winGeo, winMat, 48);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s3 = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a);
    m4.compose(new THREE.Vector3(Math.sin(a) * R * 0.97, L * 0.006, Math.cos(a) * R * 0.97 - L * 0.22), q, s3);
    rim.setMatrixAt(i, m4);
  }
  rim.instanceMatrix.needsUpdate = true;
  g.add(rim);

  /* --- neck and engineering hull ----------------------------------------- */
  const neck = new THREE.Mesh(new THREE.BoxGeometry(L * 0.05, L * 0.16, L * 0.13), darkMat);
  neck.position.set(0, -L * 0.055, -L * 0.03);
  neck.rotation.x = -0.32;
  g.add(neck);

  const engineering = new THREE.Mesh(new THREE.CapsuleGeometry(L * 0.072, L * 0.34, 6, 20), hullMat);
  engineering.rotation.x = Math.PI / 2;
  engineering.position.set(0, -L * 0.13, L * 0.10);
  g.add(engineering);

  // Deflector dish — the one warm colour on the front of the ship.
  const dish = new THREE.Mesh(new THREE.CircleGeometry(L * 0.058, 28), glowMat(0xffb44a, 1.3));
  dish.position.set(0, -L * 0.13, -L * 0.145);
  dish.rotation.y = Math.PI;
  g.add(dish);
  const dishRing = new THREE.Mesh(new THREE.TorusGeometry(L * 0.062, L * 0.008, 8, 28), darkMat);
  dishRing.position.copy(dish.position);
  g.add(dishRing);

  /* --- nacelles ----------------------------------------------------------- */
  const grilles: THREE.Mesh[] = [];
  const bussards: THREE.Mesh[] = [];
  const grilleColor = new THREE.Color(accent);

  for (const side of [-1, 1]) {
    const pylon = new THREE.Mesh(new THREE.BoxGeometry(L * 0.02, L * 0.17, L * 0.11), darkMat);
    pylon.position.set(side * L * 0.11, -L * 0.045, L * 0.20);
    pylon.rotation.z = side * -0.62;
    pylon.rotation.x = 0.24;
    g.add(pylon);

    const nac = new THREE.Group();
    nac.position.set(side * L * 0.235, L * 0.055, L * 0.17);
    g.add(nac);

    const body = new THREE.Mesh(new THREE.CapsuleGeometry(L * 0.035, L * 0.40, 5, 16), hullMat);
    body.rotation.x = Math.PI / 2;
    nac.add(body);

    // Bussard collector: the red dome at the front. Emissive and pulsing.
    const bus = new THREE.Mesh(new THREE.SphereGeometry(L * 0.036, 18, 12), glowMat(0xff5a2a, 1.4));
    bus.position.z = -L * 0.235;
    bus.scale.z = 1.25;
    nac.add(bus);
    bussards.push(bus);

    // The grille — a flat panel down the outboard face. This is the blue that
    // says "warp drive" at a distance where nothing else is resolvable.
    const grille = new THREE.Mesh(
      new THREE.BoxGeometry(L * 0.006, L * 0.03, L * 0.30),
      glowMat(accent, 1.5),
    );
    grille.position.set(side * L * 0.036, 0, L * 0.02);
    nac.add(grille);
    grilles.push(grille);

    const grilleIn = grille.clone();
    grilleIn.position.x = side * -L * 0.036;
    grilleIn.material = grille.material;
    nac.add(grilleIn);
    grilles.push(grilleIn);
  }

  /* --- impulse engines ---------------------------------------------------- */
  const impulse = new THREE.Mesh(
    new THREE.BoxGeometry(L * 0.13, L * 0.022, L * 0.012),
    glowMat(0xff7a3a, 0.6),
  );
  impulse.position.set(0, L * 0.006, -L * 0.055);
  g.add(impulse);

  let t = 0;

  return {
    group: g,
    update(dt, throttle, warp) {
      t += dt;
      // Bussards breathe at about 0.4 Hz at rest and speed up under power.
      const pulse = 0.75 + Math.sin(t * (2.4 + warp * 8)) * 0.25;
      for (const b of bussards) {
        (b.material as THREE.MeshBasicMaterial).color.setRGB(
          1.4 * pulse,
          0.36 * pulse,
          0.16 * pulse,
        );
      }
      const gl = 1.2 + warp * 2.4 + Math.sin(t * 3.1) * 0.08;
      for (const gr of grilles) {
        (gr.material as THREE.MeshBasicMaterial).color.copy(grilleColor).multiplyScalar(gl);
      }
      const im = 0.35 + Math.max(0, throttle) * 2.4;
      (impulse.material as THREE.MeshBasicMaterial).color.setRGB(im, im * 0.42, im * 0.2);
    },
    dispose() {
      g.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      g.parent?.remove(g);
    },
  };
}
