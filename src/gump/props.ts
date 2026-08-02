/**
 * Every object in the world that is not a person.
 *
 * All of it is primitives, all of it is cached by shape, and all of it is
 * authored in metres so a hay bale is a hay bale next to a 1.8 m man. The
 * cache is doing real work here: the finale streams a few hundred props past
 * you and they resolve to about a dozen distinct geometries between them.
 *
 * Every builder returns a Group whose origin sits on the ground at its centre,
 * so the spawner can drop one anywhere with `pos.set(x, 0, z)` and never think
 * about it again.
 */
import * as THREE from "three";

const MATS = new Map<string, THREE.MeshLambertMaterial>();
const GEOS = new Map<string, THREE.BufferGeometry>();

export function m(color: number, opts: THREE.MeshLambertMaterialParameters = {}) {
  const key = color + JSON.stringify(opts);
  let mm = MATS.get(key);
  if (!mm) {
    mm = new THREE.MeshLambertMaterial({ color, ...opts });
    MATS.set(key, mm);
  }
  return mm;
}

export function boxGeo(w: number, h: number, d: number) {
  const key = `b${w.toFixed(3)},${h.toFixed(3)},${d.toFixed(3)}`;
  let g = GEOS.get(key);
  if (!g) GEOS.set(key, (g = new THREE.BoxGeometry(w, h, d)));
  return g;
}

export function cylGeo(rt: number, rb: number, h: number, seg = 8) {
  const key = `c${rt.toFixed(3)},${rb.toFixed(3)},${h.toFixed(3)},${seg}`;
  let g = GEOS.get(key);
  if (!g) GEOS.set(key, (g = new THREE.CylinderGeometry(rt, rb, h, seg)));
  return g;
}

export function sphGeo(r: number, seg = 8) {
  const key = `s${r.toFixed(3)},${seg}`;
  let g = GEOS.get(key);
  if (!g) GEOS.set(key, (g = new THREE.SphereGeometry(r, seg, Math.max(4, Math.round(seg * 0.7)))));
  return g;
}

export function coneGeo(r: number, h: number, seg = 7) {
  const key = `n${r.toFixed(3)},${h.toFixed(3)},${seg}`;
  let g = GEOS.get(key);
  if (!g) GEOS.set(key, (g = new THREE.ConeGeometry(r, h, seg)));
  return g;
}

function mesh(g: THREE.BufferGeometry, mm: THREE.Material, x = 0, y = 0, z = 0) {
  const o = new THREE.Mesh(g, mm);
  o.position.set(x, y, z);
  return o;
}

type Rng = () => number;
const pick = <T,>(r: Rng, arr: T[]) => arr[Math.floor(r() * arr.length) % arr.length];
const between = (r: Rng, a: number, b: number) => a + r() * (b - a);

/* ------------------------------------------------------------------ trees */

const OAK_GREENS = [0x3f6b32, 0x487a36, 0x355c2c, 0x527f3a];

/** The Alabama live oak: a short fat trunk and three overlapping canopies. */
export function oakTree(r: Rng) {
  const g = new THREE.Group();
  const h = between(r, 3.2, 5.4);
  g.add(mesh(cylGeo(0.24, 0.42, h, 6), m(0x5b4332), 0, h / 2, 0));
  const leaf = m(pick(r, OAK_GREENS));
  for (let i = 0; i < 3; i++) {
    const rad = between(r, 1.3, 2.3);
    const b = mesh(
      sphGeo(Math.round(rad * 4) / 4, 7),
      leaf,
      between(r, -1, 1),
      h + between(r, -0.3, 1),
      between(r, -1, 1),
    );
    b.scale.set(1, between(r, 0.6, 0.85), 1);
    g.add(b);
  }
  return g;
}

export function pineTree(r: Rng) {
  const g = new THREE.Group();
  const h = between(r, 4, 8);
  g.add(mesh(cylGeo(0.15, 0.3, h * 0.4, 5), m(0x4a3a2c), 0, h * 0.2, 0));
  const leaf = m(pick(r, [0x24462b, 0x1e3a26, 0x2c5233]));
  for (let i = 0; i < 3; i++) {
    const t = i / 3;
    const rad = Math.round((1.5 - t) * 4) / 4;
    g.add(mesh(coneGeo(rad, h * 0.45, 7), leaf, 0, h * (0.32 + t * 0.28), 0));
  }
  return g;
}

/** Gulf coast, and the jungle. Leans, because a straight palm looks fake. */
export function palm(r: Rng) {
  const g = new THREE.Group();
  const h = between(r, 4, 7.5);
  const trunk = mesh(cylGeo(0.16, 0.3, h, 6), m(0x7a6248), 0, h / 2, 0);
  trunk.rotation.z = between(r, -0.18, 0.18);
  g.add(trunk);
  const crown = new THREE.Group();
  crown.position.set(Math.sin(trunk.rotation.z) * -h * 0.5, h, 0);
  const frond = m(pick(r, [0x3d6b34, 0x4a7a3a, 0x2f5a2c]));
  for (let i = 0; i < 9; i++) {
    // Wide and thick. A botanically-correct frond is a 4 cm slat that
    // disappears at ten metres, and a palm with no crown is a telegraph pole.
    const f = mesh(boxGeo(2.8, 0.14, 1.05), frond, 1.3, 0, 0);
    const holder = new THREE.Group();
    holder.rotation.y = (i / 9) * Math.PI * 2;
    holder.rotation.z = between(r, -0.95, -0.3);
    holder.add(f);
    crown.add(holder);
  }
  g.add(crown);
  return g;
}

/** Jungle understory: a low mass of leaves you cannot see through. */
export function bush(r: Rng) {
  const g = new THREE.Group();
  const leaf = m(pick(r, [0x2c4a26, 0x35592e, 0x223d20]));
  for (let i = 0; i < 4; i++) {
    const b = mesh(sphGeo(Math.round(between(r, 0.6, 1.4) * 4) / 4, 6), leaf, between(r, -1, 1), between(r, 0.3, 1), between(r, -1, 1));
    b.scale.y = 0.7;
    g.add(b);
  }
  return g;
}

export function cactus(r: Rng) {
  const g = new THREE.Group();
  const c = m(0x4a7043);
  const h = between(r, 2, 3.8);
  g.add(mesh(cylGeo(0.28, 0.32, h, 7), c, 0, h / 2, 0));
  for (const side of [-1, 1]) {
    if (r() < 0.45) continue;
    const armH = between(r, 0.8, 1.5);
    const y = between(r, h * 0.45, h * 0.7);
    g.add(mesh(boxGeo(0.8, 0.24, 0.24), c, side * 0.45, y, 0));
    g.add(mesh(cylGeo(0.16, 0.18, armH, 6), c, side * 0.82, y + armH / 2, 0));
  }
  return g;
}

/* ---------------------------------------------------------------- roadside */

export function fenceRun(r: Rng) {
  const g = new THREE.Group();
  const wood = m(0x8a6f4e);
  const len = 6;
  for (let i = 0; i < 3; i++) g.add(mesh(boxGeo(0.14, 1.1, 0.14), wood, 0, 0.55, -len / 2 + i * (len / 2)));
  for (const y of [0.5, 0.9]) g.add(mesh(boxGeo(0.08, 0.12, len), wood, 0, y, 0));
  g.rotation.y = r() < 0.5 ? 0 : Math.PI;
  return g;
}

export function mailbox() {
  const g = new THREE.Group();
  g.add(mesh(boxGeo(0.1, 1.1, 0.1), m(0x6b5540), 0, 0.55, 0));
  g.add(mesh(boxGeo(0.3, 0.28, 0.5), m(0xb0b6bb), 0, 1.2, 0));
  g.add(mesh(boxGeo(0.05, 0.22, 0.05), m(0xc23b2c), 0.18, 1.42, 0));
  return g;
}

export function barn(r: Rng) {
  const g = new THREE.Group();
  const w = between(r, 7, 11);
  const h = between(r, 4, 5.5);
  g.add(mesh(boxGeo(w, h, w * 0.8), m(0x8e3b2c), 0, h / 2, 0));
  const roof = mesh(coneGeo(w * 0.78, h * 0.55, 4), m(0x4a4038), 0, h + h * 0.27, 0);
  roof.rotation.y = Math.PI / 4;
  g.add(roof);
  g.add(mesh(boxGeo(w * 0.3, h * 0.55, 0.15), m(0x5e2a20), 0, h * 0.275, w * 0.401));
  return g;
}

export function waterTower() {
  const g = new THREE.Group();
  const steel = m(0x9aa7ad);
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const leg = mesh(cylGeo(0.1, 0.14, 9, 5), steel, x * 1.5, 4.5, z * 1.5);
    leg.rotation.z = -x * 0.08;
    leg.rotation.x = z * 0.08;
    g.add(leg);
  }
  g.add(mesh(cylGeo(2.4, 2.4, 3, 10), m(0xd8d2c4), 0, 10.5, 0));
  g.add(mesh(coneGeo(2.5, 1.4, 10), m(0x5a5148), 0, 12.7, 0));
  return g;
}

export function powerPole() {
  const g = new THREE.Group();
  const wood = m(0x6b5540);
  g.add(mesh(cylGeo(0.14, 0.2, 9, 6), wood, 0, 4.5, 0));
  g.add(mesh(boxGeo(2.6, 0.14, 0.14), wood, 0, 8.2, 0));
  g.add(mesh(boxGeo(2, 0.12, 0.12), wood, 0, 7.5, 0));
  return g;
}

/** A US highway shield on a post. The finale is nothing but these. */
export function roadSign(color = 0x2c6e49) {
  const g = new THREE.Group();
  g.add(mesh(cylGeo(0.07, 0.07, 3, 5), m(0x8d949a), 0, 1.5, 0));
  const face = mesh(boxGeo(2.2, 1.1, 0.1), m(color), 0, 3.1, 0);
  g.add(face);
  g.add(mesh(boxGeo(1.9, 0.12, 0.02), m(0xffffff), 0, 3.35, 0.06));
  g.add(mesh(boxGeo(1.4, 0.1, 0.02), m(0xffffff), -0.25, 3.05, 0.06));
  return g;
}

export function mesa(r: Rng) {
  const g = new THREE.Group();
  const h = between(r, 12, 30);
  const w = between(r, 14, 34);
  const layers = 3;
  for (let i = 0; i < layers; i++) {
    const t = i / layers;
    const c = [0xa8583c, 0xb56a45, 0x8f4632][i % 3];
    g.add(mesh(boxGeo(w * (1 - t * 0.22), h / layers, w * 0.75 * (1 - t * 0.22)), m(c), 0, (h / layers) * (i + 0.5), 0));
  }
  g.rotation.y = r() * Math.PI;
  return g;
}

/* ------------------------------------------------------------- the stadium */

/**
 * A grandstand with a crowd in it. The crowd is one InstancedMesh of ~200
 * boxes — the alternative, two hundred Groups, is what makes a phone give up
 * on a stadium, and at this distance nobody can tell the difference anyway.
 */
export function grandstand(r: Rng, rows = 9, seats = 34) {
  const g = new THREE.Group();
  const concrete = m(0x8f8b80);
  const rise = 0.7;
  const depth = 1.1;
  for (let i = 0; i < rows; i++) {
    g.add(mesh(boxGeo(seats * 1.1, rise, depth), concrete, 0, rise / 2 + i * rise, -i * depth));
  }

  const geo = boxGeo(0.5, 0.85, 0.4);
  const crowd = new THREE.InstancedMesh(geo, m(0xffffff), rows * seats);
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  let n = 0;
  for (let row = 0; row < rows; row++) {
    for (let s = 0; s < seats; s++) {
      if (r() < 0.12) continue; // empty seats — a full house every game is a lie
      dummy.position.set((s - seats / 2) * 1.1 + between(r, -0.15, 0.15), rise * (row + 1) + 0.42, -row * depth + 0.1);
      dummy.rotation.y = between(r, -0.25, 0.25);
      dummy.updateMatrix();
      crowd.setMatrixAt(n, dummy.matrix);
      col.setHSL(r(), between(r, 0.35, 0.75), between(r, 0.42, 0.68));
      crowd.setColorAt(n, col);
      n++;
    }
  }
  crowd.count = n;
  crowd.instanceMatrix.needsUpdate = true;
  g.add(crowd);
  g.userData.crowd = crowd;
  g.userData.seed = r() * 100;
  return g;
}

export function goalpost() {
  const g = new THREE.Group();
  const y = m(0xf2c23b);
  g.add(mesh(cylGeo(0.12, 0.12, 3.2, 6), y, 0, 1.6, 0));
  g.add(mesh(boxGeo(5.6, 0.14, 0.14), y, 0, 3.2, 0));
  for (const x of [-2.7, 2.7]) g.add(mesh(cylGeo(0.1, 0.1, 6, 6), y, x, 6.2, 0));
  return g;
}

/* --------------------------------------------------------------- the water */

export function buoy(r: Rng) {
  const g = new THREE.Group();
  g.add(mesh(cylGeo(0.34, 0.4, 1.4, 7), m(r() < 0.5 ? 0xd8452c : 0xe8e2d2), 0, 0.5, 0));
  g.add(mesh(coneGeo(0.22, 0.5, 6), m(0x2c2c2c), 0, 1.45, 0));
  return g;
}

export function crabPot() {
  const g = new THREE.Group();
  g.add(mesh(boxGeo(1.1, 0.7, 1.1), m(0x6f7a52), 0, 0.35, 0));
  g.add(mesh(cylGeo(0.12, 0.14, 0.9, 6), m(0xe8b13a), 0.35, 0.9, 0.2));
  return g;
}

/** A rival trawler. In the storm chapter these are what is left afterwards. */
export function trawler(r: Rng, wreck = false) {
  const g = new THREE.Group();
  const hull = m(pick(r, [0x2f5d7a, 0x7a3f2f, 0x4a4a52]));
  const body = mesh(boxGeo(3.4, 1.5, 9), hull, 0, 0.55, 0);
  g.add(body);
  g.add(mesh(boxGeo(2.4, 1.6, 2.6), m(0xe4dfd2), 0, 2.1, -1.4));
  const mast = mesh(cylGeo(0.09, 0.11, 5, 5), m(0xb8b2a4), 0, 3.5, -0.5);
  g.add(mast);
  for (const side of [-1, 1]) {
    const boom = mesh(cylGeo(0.07, 0.09, 5.4, 5), m(0xb8b2a4), side * 1.7, 2.8, -0.5);
    boom.rotation.z = side * 0.9;
    g.add(boom);
  }
  if (wreck) {
    g.rotation.z = between(r, 0.5, 1.3) * (r() < 0.5 ? -1 : 1);
    g.position.y = -0.7;
  }
  return g;
}

export function oilRig() {
  const g = new THREE.Group();
  const steel = m(0x6e6a62);
  for (const [x, z] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) g.add(mesh(cylGeo(0.5, 0.6, 14, 6), steel, x, 7, z));
  g.add(mesh(boxGeo(12, 2, 12), m(0x8a8378), 0, 15, 0));
  g.add(mesh(boxGeo(3, 9, 3), steel, 2, 20, -2));
  g.add(mesh(coneGeo(0.7, 1.6, 6), m(0xff7a1a), -3.5, 17.5, 3));
  return g;
}

/* ------------------------------------------------------------- obstacles */

export function hayBale(r: Rng) {
  const g = new THREE.Group();
  const b = mesh(cylGeo(0.85, 0.85, 1.5, 10), m(0xc9a94e), 0, 0.85, 0);
  b.rotation.z = Math.PI / 2;
  g.add(b);
  g.rotation.y = r() * 0.6;
  return g;
}

export function puddle(r: Rng) {
  const g = new THREE.Group();
  const p = mesh(cylGeo(1.3, 1.3, 0.06, 12), m(0x54697a, { transparent: true, opacity: 0.75 }), 0, 0.04, 0);
  p.scale.set(1, 1, between(r, 0.6, 1.1));
  g.add(p);
  return g;
}

export function logProp(r: Rng) {
  const g = new THREE.Group();
  const l = mesh(cylGeo(0.42, 0.46, 4.5, 8), m(0x6b5137), 0, 0.44, 0);
  l.rotation.z = Math.PI / 2;
  l.rotation.y = between(r, -0.2, 0.2);
  g.add(l);
  return g;
}

export function tractor() {
  const g = new THREE.Group();
  g.add(mesh(boxGeo(1.9, 1.1, 3), m(0x2c7a3a), 0, 1.1, 0));
  g.add(mesh(boxGeo(1.5, 1.2, 1.4), m(0x2c7a3a), 0, 2.2, -0.4));
  const tyre = m(0x1f1c1a);
  for (const [x, z, rad] of [[-1.05, 1, 0.55], [1.05, 1, 0.55], [-1.15, -1, 0.95], [1.15, -1, 0.95]]) {
    const w = mesh(cylGeo(rad, rad, 0.4, 10), tyre, x, rad, z);
    w.rotation.z = Math.PI / 2;
    g.add(w);
  }
  return g;
}

/** Highway traffic for the finale — a period sedan, seen from behind. */
export function car(r: Rng) {
  const g = new THREE.Group();
  const paint = m(pick(r, [0xb8452c, 0x2f5d7a, 0xd8cfa8, 0x3a5a3a, 0x8a8f96]));
  // Sat lower than the first version, on fatter tyres. A body floating a third
  // of a metre up on four thin black cylinders reads as a car hovering over
  // the road — the wheels vanish against the asphalt and the gap does not.
  g.add(mesh(boxGeo(1.9, 0.8, 4.6), paint, 0, 0.62, 0));
  g.add(mesh(boxGeo(1.7, 0.7, 2.1), paint, 0, 1.34, -0.2));
  g.add(mesh(boxGeo(1.72, 0.46, 0.06), m(0x2a333a, { transparent: true, opacity: 0.7 }), 0, 1.38, 0.86));
  g.add(mesh(boxGeo(1.96, 0.22, 4.5), m(0x22262b), 0, 0.34, 0));
  const tyre = m(0x2a2724);
  for (const [x, z] of [[-0.9, 1.45], [0.9, 1.45], [-0.9, -1.45], [0.9, -1.45]]) {
    const w = mesh(cylGeo(0.34, 0.34, 0.34, 10), tyre, x, 0.34, z);
    w.rotation.z = Math.PI / 2;
    g.add(w);
  }
  for (const x of [-0.65, 0.65]) g.add(mesh(boxGeo(0.3, 0.16, 0.06), m(0xff4a2a), x, 0.8, -2.32));
  return g;
}

/** A shell crater, mid-jungle. Low enough to hurdle, wide enough to catch you. */
export function crater(r: Rng) {
  const g = new THREE.Group();
  const c = mesh(cylGeo(1.5, 1.1, 0.5, 10), m(0x3a3026), 0, -0.15, 0);
  g.add(c);
  for (let i = 0; i < 5; i++) {
    g.add(mesh(sphGeo(Math.round(between(r, 0.2, 0.5) * 4) / 4, 5), m(0x4a3d2e), between(r, -1.7, 1.7), 0.15, between(r, -1.7, 1.7)));
  }
  return g;
}

/**
 * A bicycle, with its wheels exposed on `userData.wheels` so whatever is
 * riding it can spin them. Three bullies on three of these are the first
 * thing in the story that ever made him run.
 */
export function bike(r: Rng) {
  const g = new THREE.Group();
  const frame = m(pick(r, [0xc23b2c, 0x2f5d7a, 0x2c6e49]));
  const rubber = m(0x1f1c1a);
  const wheels: THREE.Group[] = [];
  for (const z of [0.52, -0.52]) {
    // The tyre lives inside a group so the *spokes* spin with it. A bare
    // cylinder rolling is perfectly correct and completely invisible.
    const w = new THREE.Group();
    w.position.set(0, 0.34, z);
    const tyre = mesh(cylGeo(0.34, 0.34, 0.06, 12), rubber);
    tyre.rotation.z = Math.PI / 2;
    w.add(tyre);
    w.add(mesh(boxGeo(0.06, 0.62, 0.05), m(0xc8ccd0)));
    const cross = mesh(boxGeo(0.06, 0.62, 0.05), m(0xc8ccd0));
    cross.rotation.x = Math.PI / 2;
    w.add(cross);
    g.add(w);
    wheels.push(w);
  }
  const bar = mesh(boxGeo(0.07, 0.07, 1.05), frame, 0, 0.6, 0);
  g.add(bar);
  g.add(mesh(boxGeo(0.06, 0.42, 0.06), frame, 0, 0.62, -0.42));
  g.add(mesh(boxGeo(0.5, 0.05, 0.05), frame, 0, 0.95, 0.46));
  g.add(mesh(cylGeo(0.05, 0.05, 0.45, 6), frame, 0, 0.75, 0.46));
  g.add(mesh(boxGeo(0.16, 0.06, 0.3), m(0x2a2220), 0, 0.85, -0.35));
  g.userData.wheels = wheels;
  return g;
}

/**
 * The wall of fire behind you in the jungle. Twelve slabs of emissive orange
 * on a lattice, jittered every frame by the chapter — a particle system would
 * be prettier and this is legible at 60 m in fog, which matters more.
 */
export function firewall() {
  const g = new THREE.Group();
  const shades = [0xff5a1a, 0xffa22a, 0xd8341a, 0x8a1f10];
  for (let i = 0; i < 26; i++) {
    const w = 3 + (i % 4) * 1.6;
    const h = 3 + ((i * 7) % 5) * 1.4;
    const f = mesh(
      boxGeo(w, h, 0.6),
      m(shades[i % shades.length], { transparent: true, opacity: 0.9 }),
      ((i % 9) - 4) * 5.2,
      h / 2,
      ((i * 3) % 4) * -1.4,
    );
    g.add(f);
  }
  const smoke = mesh(boxGeo(60, 16, 1), m(0x2a2320, { transparent: true, opacity: 0.75 }), 0, 8, -3);
  g.add(smoke);
  g.userData.flames = g.children.slice(0, 26);
  return g;
}

/** A reef, just under the surface, waiting for a shrimp boat. */
export function reefRock(r: Rng) {
  const g = new THREE.Group();
  const rock = m(0x4a4740);
  for (let i = 0; i < 4; i++) {
    const s = between(r, 0.7, 1.7);
    const b = mesh(boxGeo(s * 1.6, s * 1.4, s * 1.6), rock, between(r, -1, 1), between(r, -0.5, 0.3), between(r, -1, 1));
    b.rotation.set(between(r, -0.3, 0.3), r() * Math.PI, between(r, -0.3, 0.3));
    g.add(b);
  }
  g.add(mesh(cylGeo(2.6, 2.6, 0.1, 10), m(0x9fd0cc, { transparent: true, opacity: 0.35 }), 0, 0.2, 0));
  return g;
}

/**
 * The Jenny. A shrimp boat you stand on: hull, wheelhouse, outriggers and the
 * nets, with the deck at 1.02 m so the captain's boots land on it.
 *
 * Forward is −Z, like everything else in this game. The first version of this
 * had the bow at +Z and the whole boat sailed backwards up the gulf with the
 * captain standing in the wheelhouse — which is exactly the sort of thing that
 * builds clean, ships, and looks ridiculous the moment anybody plays it.
 */
export function shrimpBoat() {
  const g = new THREE.Group();
  const hull = m(0xf2f2ea);
  const trim = m(0x2f5d7a);
  g.add(mesh(boxGeo(3.6, 1.5, 10), hull, 0, 0.4, 0));
  g.add(mesh(boxGeo(3.7, 0.3, 10.2), trim, 0, 1.05, 0));
  const bow = mesh(coneGeo(1.85, 3, 4), hull, 0, 0.4, -6);
  bow.rotation.x = Math.PI / 2;
  bow.rotation.y = Math.PI / 4;
  bow.scale.set(1, 1, 0.82);
  g.add(bow);
  // Deck.
  g.add(mesh(boxGeo(3.4, 0.12, 9.6), m(0xc8a56a), 0, 1.02, 0));
  // Wheelhouse, aft of the captain so he stands out on the open deck.
  g.add(mesh(boxGeo(2.2, 1.9, 2.4), hull, 0, 2.05, 3.4));
  g.add(mesh(boxGeo(2.24, 0.7, 0.06), m(0x2a333a, { transparent: true, opacity: 0.6 }), 0, 2.4, 2.21));
  g.add(mesh(boxGeo(2.4, 0.14, 2.6), trim, 0, 3.05, 3.4));
  g.add(mesh(cylGeo(0.1, 0.13, 5.4, 6), m(0xd8d2c4), 0, 3.6, 1.6));
  for (const side of [-1, 1]) {
    const boom = mesh(cylGeo(0.08, 0.1, 6.2, 5), m(0xd8d2c4), side * 2.1, 3.1, 1.6);
    boom.rotation.z = side * 0.85;
    g.add(boom);
    const net = mesh(
      boxGeo(0.1, 2, 2.4),
      m(0x4a5a3a, { transparent: true, opacity: 0.5 }),
      side * 3.5,
      1.9,
      1.6,
    );
    g.add(net);
  }
  g.add(mesh(boxGeo(0.06, 1.1, 0.7), m(0xb3261e), 0, 4.3, 1.6));
  return g;
}

/* --------------------------------------------------------------- pickups */

/**
 * The box of chocolates. Scoring pickup in every chapter, because it is the
 * one object in the whole story that belongs in all six of them.
 */
export function chocolateBox() {
  const g = new THREE.Group();
  g.add(mesh(boxGeo(0.55, 0.16, 0.42), m(0x9b1c30), 0, 0.08, 0));
  g.add(mesh(boxGeo(0.6, 0.08, 0.47), m(0xb8253c), 0, 0.2, 0));
  g.add(mesh(boxGeo(0.62, 0.05, 0.1), m(0xe8c46a), 0, 0.25, 0));
  g.add(mesh(boxGeo(0.1, 0.05, 0.49), m(0xe8c46a), 0, 0.25, 0));
  g.position.y = 0.7;
  return g;
}

export function dollar() {
  const g = new THREE.Group();
  const bill = mesh(boxGeo(0.7, 0.34, 0.03), m(0x63a06a), 0, 0, 0);
  g.add(bill);
  g.add(mesh(cylGeo(0.1, 0.1, 0.035, 8), m(0xd8e0cc), 0, 0, 0.02));
  g.position.y = 1;
  return g;
}

export function shrimpProp() {
  const g = new THREE.Group();
  const body = m(0xf08a7a);
  for (let i = 0; i < 4; i++) {
    const s = mesh(sphGeo(0.16 - i * 0.025, 6), body, 0, 0.05 * i, -i * 0.16);
    g.add(s);
  }
  g.add(mesh(boxGeo(0.05, 0.05, 0.3), body, 0, 0.02, 0.24));
  g.position.y = 0.25;
  return g;
}

/** A fallen squadmate, face down in the grass. Run over him to pick him up. */
export function fallenSoldier() {
  const g = new THREE.Group();
  const cloth = m(0x4d5a35);
  g.add(mesh(boxGeo(0.5, 0.28, 1.5), cloth, 0, 0.14, 0));
  g.add(mesh(sphGeo(0.22, 7), m(0x4a5236), 0, 0.2, 0.85));
  g.add(mesh(boxGeo(1.3, 0.2, 0.22), cloth, 0, 0.12, 0.2));
  return g;
}

/* -------------------------------------------------------------- the bench */

/** The bench at the bus stop. Where the whole thing is told from. */
export function benchProp() {
  const g = new THREE.Group();
  const wood = m(0x3f6b4a);
  const iron = m(0x2a2f2c);
  for (const x of [-0.85, 0.85]) {
    g.add(mesh(boxGeo(0.1, 0.45, 0.5), iron, x, 0.22, 0));
    g.add(mesh(boxGeo(0.1, 0.55, 0.1), iron, x, 0.7, -0.22));
  }
  for (let i = 0; i < 3; i++) g.add(mesh(boxGeo(2, 0.07, 0.15), wood, 0, 0.46, -0.18 + i * 0.17));
  for (let i = 0; i < 3; i++) g.add(mesh(boxGeo(2, 0.13, 0.06), wood, 0, 0.62 + i * 0.16, -0.26));
  return g;
}

export function busStopSign() {
  const g = new THREE.Group();
  g.add(mesh(cylGeo(0.06, 0.06, 2.6, 6), m(0x8d949a), 0, 1.3, 0));
  g.add(mesh(boxGeo(0.65, 0.9, 0.05), m(0x2f5d7a), 0, 2.6, 0));
  g.add(mesh(boxGeo(0.45, 0.1, 0.02), m(0xffffff), 0, 2.8, 0.04));
  g.add(mesh(boxGeo(0.45, 0.1, 0.02), m(0xffffff), 0, 2.6, 0.04));
  return g;
}

/**
 * The feather. It opens the story and it closes it, so it is the one prop in
 * here that gets its own motion — see `driftFeather`.
 */
export function feather() {
  const g = new THREE.Group();
  const quill = m(0xf4f2ec);
  const vane = mesh(boxGeo(0.09, 0.34, 0.012), quill, 0, 0, 0);
  vane.scale.x = 1.6;
  g.add(vane);
  g.add(mesh(boxGeo(0.014, 0.42, 0.014), m(0xdad6cc), 0, 0, 0));
  g.add(mesh(boxGeo(0.07, 0.18, 0.01), quill, 0.04, 0.12, 0.006));
  return g;
}

/**
 * Move a feather one frame. `t` is seconds since it was released.
 *
 * A feather does not fall, it *files* — it slides on air, stalls, tips over
 * and slides the other way. Two sines at different rates against a slow
 * descent get most of the way there, and the rotation follows the horizontal
 * velocity so it always looks like it is leaning into the slide.
 */
export function driftFeather(f: THREE.Object3D, t: number, origin: THREE.Vector3, seed = 0) {
  const sway = Math.sin(t * 0.9 + seed) * 1.4 + Math.sin(t * 2.3 + seed * 2) * 0.35;
  f.position.set(origin.x + sway, origin.y - t * 0.55, origin.z + Math.cos(t * 0.7 + seed) * 0.9);
  f.rotation.z = Math.cos(t * 0.9 + seed) * 0.8;
  f.rotation.x = Math.sin(t * 1.7 + seed) * 0.5;
  f.rotation.y = t * 0.6;
}

/* ------------------------------------------------------------- ping-pong */

/** Regulation, to the centimetre: 2.74 × 1.525 m, 76 cm off the floor. */
export function pingPongTable() {
  const g = new THREE.Group();
  const top = mesh(boxGeo(1.525, 0.05, 2.74), m(0x1b4d6b), 0, 0.76, 0);
  g.add(top);
  g.add(mesh(boxGeo(1.545, 0.02, 2.76), m(0xf2f2f0), 0, 0.783, 0));
  g.add(mesh(boxGeo(1.525, 0.05, 2.74), m(0x1b4d6b), 0, 0.79, 0));
  g.add(mesh(boxGeo(0.02, 0.05, 2.74), m(0xf2f2f0), 0, 0.816, 0));
  const legs = m(0x2a2f34);
  for (const [x, z] of [[-0.65, -1.25], [0.65, -1.25], [-0.65, 1.25], [0.65, 1.25]]) {
    g.add(mesh(boxGeo(0.06, 0.74, 0.06), legs, x, 0.37, z));
  }
  g.add(mesh(boxGeo(1.83, 0.1525, 0.02), m(0x14213d), 0, 0.87, 0));
  g.add(mesh(boxGeo(1.83, 0.015, 0.03), m(0xf2f2f0), 0, 0.945, 0));
  return g;
}

export function paddleProp(faceColor = 0xb3261e) {
  const g = new THREE.Group();
  const blade = mesh(cylGeo(0.085, 0.085, 0.018, 14), m(faceColor), 0, 0, 0);
  blade.rotation.x = Math.PI / 2;
  g.add(blade);
  const handle = mesh(boxGeo(0.032, 0.11, 0.022), m(0x8a6a45), 0, -0.13, 0);
  g.add(handle);
  return g;
}

export function pingPongBall() {
  const g = new THREE.Group();
  g.add(mesh(sphGeo(0.02, 8), m(0xf5ede0)));
  return g;
}

/* ----------------------------------------------------------------- misc */

/**
 * A soft blob shadow. Nothing in this world casts a real shadow — a shadow map
 * that covers a 500 m road is either enormous or useless — but a runner with
 * no shadow reads as floating, and one dark ellipse under the feet fixes it
 * for the price of one transparent quad.
 */
export function blobShadow(radius = 0.55) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(0,0,0,0.5)");
  grad.addColorStop(0.55, "rgba(0,0,0,0.25)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  const mm = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  const geo = new THREE.PlaneGeometry(radius * 2, radius * 2);
  const q = new THREE.Mesh(geo, mm);
  q.rotation.x = -Math.PI / 2;
  q.position.y = 0.02;
  q.renderOrder = 2;
  q.userData.dispose = () => {
    tex.dispose();
    mm.dispose();
    geo.dispose();
  };
  return q;
}

/** Free every cached geometry and material. Once, from engine teardown. */
export function disposePropCache() {
  for (const g of GEOS.values()) g.dispose();
  for (const mm of MATS.values()) mm.dispose();
  GEOS.clear();
  MATS.clear();
}
