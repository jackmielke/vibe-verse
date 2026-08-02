/**
 * Christmas, hung on the house.
 *
 * This file exists because the single strongest nostalgia signal in the whole
 * world is not the floor plan or the burglars — it is **a row of coloured
 * bulbs along a gutter in the snow**. Everybody has that image. So the eaves
 * get a string, the porch gets a garland, the door gets a wreath, and the
 * gutters grow icicles, and between them they do more work per line than
 * anything else in the build.
 *
 * It is deliberately self-contained: it owns its own materials and hands back
 * a `dispose`, so `build.ts` does not grow another two hundred lines and the
 * dressing can be reasoned about (and re-tuned) on its own.
 *
 * The one performance decision worth stating: **the bulbs are geometry, the
 * glow is not.** Two hundred and forty little emissive spheres cost nothing;
 * two hundred and forty point lights would cost the frame. Four warm point
 * lights spread along the front do the actual lighting, and the bulbs are just
 * bright dots — which, at night, in snow, is exactly what they look like.
 */
import * as THREE from "three";
import { IN, X, Z } from "./house";

export interface Dressing {
  /** All the bulbs, as one instanced mesh, so the twinkle is one buffer write. */
  bulbMesh: THREE.InstancedMesh | null;
  bulbCount: number;
  /** The lights the string actually throws onto the brick. */
  glow: THREE.PointLight[];
  dispose(): void;
}

/** The 1990 palette: fat C9 bulbs in five colours, and nothing subtle. */
const BULB_COLOURS = [0xff3b30, 0x34c759, 0x2f6fd6, 0xffcc00, 0xff9500];

export function dressForChristmas(parent: THREE.Object3D, eavesY: number): Dressing {
  const owned: Array<{ dispose(): void }> = [];
  const keep = <M extends THREE.Material | THREE.BufferGeometry>(m: M) => {
    owned.push(m);
    return m;
  };

  const bulbGeo = keep(new THREE.SphereGeometry(0.055, 7, 6));
  const bulbMat = keep(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  let iceGeo: THREE.ConeGeometry | null = null;
  const capGeo = keep(new THREE.CylinderGeometry(0.028, 0.032, 0.05, 6));
  const capMat = keep(new THREE.MeshStandardMaterial({ color: 0x1e1e22, roughness: 0.6 }));
  const wireMat = keep(new THREE.LineBasicMaterial({ color: 0x22301f }));
  const needleMat = keep(new THREE.MeshStandardMaterial({ color: 0x2f5c33, roughness: 0.92 }));
  const berryMat = keep(new THREE.MeshStandardMaterial({ color: 0xa8202c, roughness: 0.5 }));
  const ribbonMat = keep(new THREE.MeshStandardMaterial({ color: 0xb8232f, roughness: 0.55 }));
  const iceMat = keep(
    new THREE.MeshStandardMaterial({
      color: 0xdce9f7, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.85,
    }),
  );

  /*
   * Everything here is *collected*, then emitted as four InstancedMeshes.
   *
   * The first cut added a Mesh per bulb, per cap, per icicle and per sprig of
   * garland: about seven hundred draw calls hung on the front of one house,
   * which is more than the rest of the world put together and precisely the
   * sort of thing that runs beautifully on a laptop and drops a phone to
   * single figures. Instanced, the whole of Christmas is four.
   */
  interface Placed {
    pos: THREE.Vector3;
    scale: number;
    rot?: THREE.Euler;
    colour?: number;
  }
  const bulbSpots: Placed[] = [];
  const capSpots: Placed[] = [];
  const puffSpots: Placed[] = [];
  const iceSpots: Placed[] = [];
  const glow: THREE.PointLight[] = [];
  let bulbIndex = 0;
  const addBulb = (x: number, y: number, z: number, scale = 1) => {
    bulbSpots.push({ pos: new THREE.Vector3(x, y, z), scale, colour: BULB_COLOURS[bulbIndex++ % BULB_COLOURS.length] });
  };

  /**
   * A run of lights between two points, sagging between fixings.
   *
   * The sag is the whole trick. A string of bulbs on a straight line reads as
   * a row of LEDs on a circuit board; the same string drooping 12 cm between
   * every second bulb reads as something a father put up on a ladder.
   */
  function run(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    count: number,
    sag = 0.14,
  ) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= count; i++) {
      const f = i / count;
      // Swags of four bulbs, each dipping and coming back up to a fixing.
      const swag = Math.sin(((i % 4) / 4) * Math.PI) * sag;
      const p = new THREE.Vector3(
        ax + (bx - ax) * f,
        ay + (by - ay) * f - swag,
        az + (bz - az) * f,
      );
      pts.push(p);
      if (i === count) break;
      addBulb(p.x, p.y - 0.05, p.z);
      capSpots.push({ pos: p.clone(), scale: 1 });
    }
    const g = keep(new THREE.BufferGeometry().setFromPoints(pts));
    parent.add(new THREE.Line(g, wireMat));
  }

  /* ---- the eaves ---------------------------------------------------- */
  const y = eavesY - 0.34;
  run(X.W - 0.35, y, Z.S + 0.45, X.E + 0.35, y, Z.S + 0.45, 30);
  run(X.W - 0.35, y, Z.N - 0.45, X.E + 0.35, y, Z.N - 0.45, 30);
  run(X.W - 0.4, y, Z.N - 0.4, X.W - 0.4, y, Z.S + 0.4, 24);
  run(X.E + 0.4, y, Z.N - 0.4, X.E + 0.4, y, Z.S + 0.4, 24);

  // Four lights for the whole string. The bulbs are dots; these are the glow.
  for (const [gx, gz] of [
    [-4.5, Z.S + 0.6], [4.5, Z.S + 0.6], [X.W - 0.6, 0], [X.E + 0.6, 0],
  ] as const) {
    const l = new THREE.PointLight(0xffb26e, 9, 9, 1.7);
    l.position.set(gx, y - 0.3, gz);
    parent.add(l);
    glow.push(l);
  }

  /* ---- porch garland ------------------------------------------------- */
  {
    const pz = Z.S + 1.35;
    // Rope of needles across the porch beam and down both columns.
    const garland = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, n: number) => {
      for (let i = 0; i <= n; i++) {
        const f = i / n;
        const swag = Math.sin(f * Math.PI) * 0.16;
        const px = x0 + (x1 - x0) * f;
        const py = y0 + (y1 - y0) * f - swag;
        const pzz = z0 + (z1 - z0) * f;
        const sc = 0.09 + (i % 3) * 0.02;
        puffSpots.push({ pos: new THREE.Vector3(px, py, pzz), scale: sc / 0.055 });
        if (i % 3 === 1) addBulb(px - 0.04, py - 0.07, pzz + 0.06, 0.72);
      }
    };
    garland(0.4 - 1.62, 2.82, pz, 0.4 + 1.62, 2.82, pz, 16);
    // Spiralling down each column. Bulbs every third puff, or the spiral
    // reads as a chain of coal in the dark — which is exactly how the first
    // version of it looked.
    for (const s of [-1, 1]) {
      for (let i = 0; i <= 22; i++) {
        const f = i / 22;
        const a = f * Math.PI * 5.2;
        const px = 0.4 + s * 1.5 + Math.sin(a) * 0.17;
        const py = 2.7 - f * 2.6;
        const pzz = pz + Math.cos(a) * 0.17;
        puffSpots.push({ pos: new THREE.Vector3(px, py, pzz), scale: 1.5 });
        if (i % 3 === 0) addBulb(px + Math.sin(a) * 0.09, py - 0.03, pzz + Math.cos(a) * 0.09, 0.8);
      }
    }
    // Two porch lights so the garland lights the doorway it frames.
    for (const s of [-1, 1]) {
      const l = new THREE.PointLight(0xff9c5a, 5, 5, 1.7);
      l.position.set(0.4 + s * 1.5, 1.6, pz);
      parent.add(l);
      glow.push(l);
    }
  }

  /* ---- the wreath ---------------------------------------------------- */
  {
    const ring = keep(new THREE.TorusGeometry(0.32, 0.1, 8, 20));
    const wreath = new THREE.Mesh(ring, needleMat);
    wreath.position.set(0.4, 1.45, Z.S + 0.09);
    parent.add(wreath);
    // Berries and a bow, because a plain green ring reads as a tyre.
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const berry = new THREE.Mesh(bulbGeo, berryMat);
      berry.position.set(0.4 + Math.cos(a) * 0.33, 1.45 + Math.sin(a) * 0.33, Z.S + 0.16);
      berry.scale.setScalar(0.62);
      parent.add(berry);
    }
    void puffSpots;
    const bowGeo = keep(new THREE.BoxGeometry(1, 1, 1));
    for (const [bx, by, bw, bh, rot] of [
      [-0.16, -0.3, 0.24, 0.14, 0.5], [0.16, -0.3, 0.24, 0.14, -0.5],
      [-0.06, -0.46, 0.08, 0.3, 0.2], [0.06, -0.46, 0.08, 0.3, -0.2],
    ] as const) {
      const b = new THREE.Mesh(bowGeo, ribbonMat);
      b.position.set(0.4 + bx, 1.45 + by, Z.S + 0.14);
      b.scale.set(bw, bh, 0.04);
      b.rotation.z = rot;
      parent.add(b);
    }
  }

  /* ---- icicles -------------------------------------------------------- */
  {
    iceGeo = keep(new THREE.ConeGeometry(0.045, 0.42, 5));
    const seed = (i: number) => Math.abs(Math.sin(i * 78.233) * 43758.5453) % 1;
    let n = 0;
    const fringe = (x0: number, z0: number, x1: number, z1: number, count: number) => {
      for (let i = 0; i < count; i++) {
        const f = (i + 0.5) / count;
        const r = seed(n++);
        if (r < 0.28) continue; // gaps, or it reads as a comb
        const len = 0.5 + r * 1.4;
        iceSpots.push({
          pos: new THREE.Vector3(x0 + (x1 - x0) * f, eavesY - 0.16 - 0.21 * len, z0 + (z1 - z0) * f),
          scale: len,
          rot: new THREE.Euler(Math.PI, 0, 0),
        });
      }
    };
    fringe(X.W - 0.3, Z.S + 0.45, X.E + 0.3, Z.S + 0.45, 46);
    fringe(X.W - 0.3, Z.N - 0.45, X.E + 0.3, Z.N - 0.45, 46);
    fringe(X.W - 0.42, Z.N - 0.4, X.W - 0.42, Z.S + 0.4, 34);
    fringe(X.E + 0.42, Z.N - 0.4, X.E + 0.42, Z.S + 0.4, 34);
  }

  /* ---- drifts against the walls ---------------------------------------- *
   * A house whose walls meet the snow at a hard right angle looks pasted on.
   * A wedge of snow banked against every side is two triangles' worth of
   * geometry and it seats the building in the ground.
   * ------------------------------------------------------------------- */
  {
    const driftMat = keep(new THREE.MeshStandardMaterial({ color: 0xe4ecf8, roughness: 0.62 }));
    const box = keep(new THREE.BoxGeometry(1, 1, 1));
    const bank = (x: number, z: number, w: number, d: number, rot: number) => {
      const m = new THREE.Mesh(box, driftMat);
      m.position.set(x, 0.11, z);
      m.scale.set(w, 0.34, d);
      m.rotation.x = rot;
      parent.add(m);
    };
    bank(0, Z.S + 0.5, X.E - X.W + 1.0, 1.1, -0.28);
    bank(0, Z.N - 0.5, X.E - X.W + 1.0, 1.1, 0.28);
    const side = keep(new THREE.BoxGeometry(1, 1, 1));
    for (const s of [-1, 1]) {
      const m = new THREE.Mesh(side, driftMat);
      m.position.set(s * (X.E + 0.5), 0.11, 0);
      m.scale.set(1.1, 0.34, Z.S - Z.N + 1.0);
      m.rotation.z = s * 0.28;
      parent.add(m);
    }
    void IN;
  }

  /* ---- emit ------------------------------------------------------------ */
  const M4 = new THREE.Matrix4();
  const Q = new THREE.Quaternion();
  const S = new THREE.Vector3();
  const emit = (geo: THREE.BufferGeometry, mat: THREE.Material, spots: Placed[], colours: boolean) => {
    if (!spots.length) return null;
    const im = new THREE.InstancedMesh(geo, mat, spots.length);
    im.frustumCulled = false;
    for (let i = 0; i < spots.length; i++) {
      const p = spots[i];
      Q.setFromEuler(p.rot ?? ZERO);
      S.setScalar(p.scale);
      if (p.rot) S.set(1, p.scale, 1);
      M4.compose(p.pos, Q, S);
      im.setMatrixAt(i, M4);
      if (colours) im.setColorAt(i, TMP_COLOUR.setHex(p.colour ?? 0xffffff));
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    parent.add(im);
    return im;
  };
  const bulbMesh = emit(bulbGeo, bulbMat, bulbSpots, true);
  emit(capGeo, capMat, capSpots, false);
  emit(bulbGeo, needleMat, puffSpots, false);
  if (iceGeo) emit(iceGeo, iceMat, iceSpots, false);

  return {
    bulbMesh,
    bulbCount: bulbSpots.length,
    glow,
    dispose() {
      for (const o of owned) o.dispose();
    },
  };
}

const ZERO = new THREE.Euler();
const TMP_COLOUR = new THREE.Color();

/**
 * Twinkle. Not a random flicker — a slow chase along the string, because that
 * is what a 1990 controller box actually did, and a random one reads as a
 * fault. Each bulb keeps its colour and only its brightness moves.
 */
export function twinkle(d: Dressing, t: number) {
  const im = d.bulbMesh;
  if (im?.instanceColor) {
    for (let i = 0; i < d.bulbCount; i++) {
      const k = 0.68 + 0.32 * (0.5 + 0.5 * Math.sin(t * 1.15 - i * 0.09));
      TMP_COLOUR.setHex(BULB_COLOURS[i % BULB_COLOURS.length]).multiplyScalar(k);
      im.setColorAt(i, TMP_COLOUR);
    }
    im.instanceColor.needsUpdate = true;
  }
  for (let i = 0; i < d.glow.length; i++) d.glow[i].intensity = 8 + Math.sin(t * 1.15 - i * 0.7) * 2.2;
}
