/**
 * Vibe Marina: a timber pier off the west beach, two finger piers, a T-head
 * with the harbour shack, three sailboats on their moorings, and a speedboat
 * you can take out.
 *
 * The pier is ordinary collision (boxes), so it is walked like any street and
 * jumped off like any pier. The speedboat is not physics at all: it is a
 * little state machine (`Boat`) that `index.ts` locks the player to, the same
 * way it locks a rider to an elevator car. It floats on `seaSurfaceAt`, the
 * same function swimmers float on, and refuses water shallower than its
 * draught, so it cannot be driven up the beach or through the pilings.
 */
import * as THREE from "three";
import type { WorldBox } from "@/components/city/cardboardIsland";
import { seaSurfaceAt, waterDepthAt } from "@/city/ocean";
import { canvas, merge, rng, signTexture, solid, tex } from "./common";

const DECK = 1.5;
const MAIN_W = 3;
const FINGER_W = 1.6;

/** How one kind of boat handles. Speeds in m/s. */
export interface CraftSpec {
  name: string;
  maxFwd: number;
  maxRev: number;
  accel: number;
  /** Yaw rate at full lock, rad/s, with way on. */
  turn: number;
  /** How much of the turn is left at top speed (a hydroplane carves wide). */
  turnAtSpeed: number;
  draught: number;
  radius: number;
  /** How far the hull rises out of the water at full speed. */
  lift: number;
  /** Bow-up pitch at full speed, radians. */
  rake: number;
  /** Where the driver's feet go, in the boat's own space. */
  seat: [number, number, number];
  /** Length, for the swell sampling and where the wake starts. */
  length: number;
}

export interface Boat {
  id: string;
  spec: CraftSpec;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  /** The ride's camera and seat. */
  seat: THREE.Vector3;
  /** Where it was tied up, and where it drifts back to. */
  home: { x: number; z: number; yaw: number };
}

/** The hydroplane course: a loop of buoy gates out past the T-head. */
export interface RaceState {
  /** Gate the driver must take next (0 is start and finish). */
  next: number;
  gates: number;
  /** Lap clock, seconds, or null before the start gate. */
  lap: number | null;
  best: number | null;
}

export type MarinaEvent = { type: "start" } | { type: "lap"; time: number; best: boolean } | { type: "gate"; n: number };

export interface Marina {
  group: THREE.Group;
  /** The land end of the pier, for "take me to the marina". */
  entrance: THREE.Vector3;
  boats: Boat[];
  /** The nearest standing spot on a pier within `reach`, or null. */
  landing(x: number, z: number, reach: number): THREE.Vector3 | null;
  update(dt: number, now: number, drive: { boat: Boat; throttle: number; steer: number } | null): MarinaEvent | null;
  race(): RaceState;
  /** Dev: the gate centres, start first. */
  gates(): number[][];
  setNight(night: boolean): void;
  roofs: THREE.Material[];
  dispose(): void;
}

const SPEEDBOAT: CraftSpec = {
  name: "Vibe Runner",
  maxFwd: 17,
  maxRev: 4.5,
  accel: 5.5,
  turn: 1.25,
  turnAtSpeed: 1,
  draught: 0.75,
  radius: 1.4,
  lift: 0.18,
  rake: 0.09,
  seat: [-0.4, 0.52, -0.25],
  length: 5.6,
};

const HYDROPLANE: CraftSpec = {
  name: "Hydroplane",
  maxFwd: 38,
  maxRev: 4,
  accel: 9.5,
  turn: 1.5,
  turnAtSpeed: 0.55,
  draught: 0.9,
  radius: 1.6,
  lift: 0.45,
  rake: 0.07,
  seat: [0, 0.3, 0.9],
  length: 7.4,
};

const RACE_KEY = "city.hydroplane.best";

function plankTexture() {
  const { c, x } = canvas(256);
  const r = rng(77);
  for (let i = 0; i < 8; i++) {
    const g = 120 + Math.floor(r() * 40);
    x.fillStyle = `rgb(${g + 20},${g - 10},${g - 50})`;
    x.fillRect(0, i * 32, 256, 32);
    x.fillStyle = "rgba(40,25,10,0.55)";
    x.fillRect(0, i * 32, 256, 3);
    for (let k = 0; k < 6; k++) {
      x.fillStyle = `rgba(60,40,20,${0.15 + r() * 0.2})`;
      x.fillRect(r() * 256, i * 32 + 6 + r() * 20, 30 + r() * 80, 2);
    }
    // Butt joints.
    x.fillStyle = "rgba(40,25,10,0.6)";
    x.fillRect(Math.floor(r() * 256), i * 32, 3, 32);
  }
  return tex(c);
}

/** A hull outline in the xz plane, bow at +z, extruded up `h`. */
function hullGeometry(len: number, beam: number, h: number, bowSharp = 0.42) {
  const s = new THREE.Shape();
  const L = len / 2;
  const B = beam / 2;
  s.moveTo(-B * 0.86, -L);
  s.lineTo(B * 0.86, -L);
  s.quadraticCurveTo(B * 1.04, -L * 0.2, B, L * (1 - bowSharp));
  s.quadraticCurveTo(B * 0.7, L * 0.86, 0, L);
  s.quadraticCurveTo(-B * 0.7, L * 0.86, -B, L * (1 - bowSharp));
  s.quadraticCurveTo(-B * 1.04, -L * 0.2, -B * 0.86, -L);
  const g = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.1, bevelSegments: 2, curveSegments: 10 });
  // Shape is in xy; stand it up so y is height and the outline lies in xz.
  g.rotateX(Math.PI / 2);
  g.translate(0, h, 0);
  // Taper the bottom in so it reads as a hull, not a tub.
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const k = 0.62 + 0.38 * THREE.MathUtils.clamp(y / h, 0, 1);
    p.setX(i, p.getX(i) * k);
  }
  g.computeVertexNormals();
  return g;
}

function sailTexture(stripe: string) {
  const { c, x } = canvas(128);
  x.fillStyle = "#f7f4ea";
  x.fillRect(0, 0, 128, 128);
  x.fillStyle = stripe;
  x.fillRect(0, 92, 128, 14);
  x.strokeStyle = "rgba(0,0,0,0.08)";
  for (let i = 0; i < 128; i += 18) {
    x.beginPath();
    x.moveTo(0, i);
    x.lineTo(128, i + 6);
    x.stroke();
  }
  return tex(c, false);
}

export function buildMarina(opts: { boxes: WorldBox[]; z: number; lowDetail: boolean }): Marina {
  const { boxes } = opts;
  const Z = opts.z;
  const group = new THREE.Group();
  group.name = "vibe-marina";
  const trash: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(t: T) => (trash.push(t), t);

  const planks = keep(plankTexture());
  const wood = keep(new THREE.MeshStandardMaterial({ map: planks, roughness: 0.92, color: 0xd9c2a0 }));
  const piling = keep(new THREE.MeshStandardMaterial({ color: 0x5b4632, roughness: 1 }));
  const white = keep(new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.45 }));
  const rope = keep(new THREE.MeshStandardMaterial({ color: 0xd8c79a, roughness: 1 }));
  const metal = keep(new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.7, roughness: 0.35 }));
  const lampMat = keep(new THREE.MeshStandardMaterial({ color: 0xfff1c9, emissive: 0xffd27a, emissiveIntensity: 0.15 }));

  // ---- Piers ---------------------------------------------------------------
  // Each deck is [x0, x1, z0, z1]. The walkable surface is the box's top.
  const decks: Array<[number, number, number, number]> = [
    [-268, -179, Z - MAIN_W / 2, Z + MAIN_W / 2], // main pier
    [-270, -262, Z - 11, Z + 11], // T-head
    [-236 - FINGER_W / 2, -236 + FINGER_W / 2, Z - 11, Z + 11], // finger piers
    [-252 - FINGER_W / 2, -252 + FINGER_W / 2, Z - 11, Z + 11],
  ];
  const deckParts: THREE.BufferGeometry[] = [];
  const pilePos: Array<[number, number]> = [];
  for (const [x0, x1, z0, z1] of decks) {
    const w = x1 - x0;
    const d = z1 - z0;
    boxes.push({ minX: x0, maxX: x1, minZ: z0, maxZ: z1, base: DECK - 0.35, height: DECK });
    const g = new THREE.BoxGeometry(w, 0.3, d);
    // World-scaled planks: one texture tile is 2 m, planks run across the walk.
    const uv = g.attributes.uv as THREE.BufferAttribute;
    const pos = g.attributes.position as THREE.BufferAttribute;
    const along = w >= d;
    for (let i = 0; i < uv.count; i++) {
      const a = along ? pos.getX(i) : pos.getZ(i);
      const b = along ? pos.getZ(i) : pos.getX(i);
      uv.setXY(i, b / 2, a / 2);
    }
    g.translate((x0 + x1) / 2, DECK - 0.15, (z0 + z1) / 2);
    deckParts.push(g);
    // Pilings every 4 m down both edges.
    const n = Math.max(2, Math.round(Math.max(w, d) / 4));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      if (along) {
        pilePos.push([x0 + t * w, z0 - 0.1], [x0 + t * w, z1 + 0.1]);
      } else {
        pilePos.push([x0 - 0.1, z0 + t * d], [x1 + 0.1, z0 + t * d]);
      }
    }
  }
  // A ramp from the coast road up onto the boards. It used to be four 0.375 m
  // steps, and the last of them had a zero-width collision box (its maxX was
  // its own minX), so a walker dropped into a slot in front of the deck and a
  // car met the deck's edge as a wall: the only way on was the jetpack.
  //
  // Now it is a slab drawn as a slope over ten thin collision steps. Each step
  // is 0.15 m, well under the 0.4 m a walker or a car steps up, and they
  // overlap the deck so there is no gap anywhere along it.
  {
    const RAMP_X0 = -179; // meets the deck
    const RAMP_X1 = -170.5; // meets the road
    const N = 10;
    const run = RAMP_X1 - RAMP_X0;
    for (let i = 0; i < N; i++) {
      // Step i sits nearest the road at i = 0.
      const top = DECK * ((i + 1) / N);
      const xHi = RAMP_X1 - (i * run) / N;
      boxes.push({ minX: RAMP_X0 - 0.5, maxX: xHi, minZ: Z - MAIN_W / 2, maxZ: Z + MAIN_W / 2, base: -1, height: top });
    }
    const len = Math.hypot(run, DECK);
    const slab = new THREE.BoxGeometry(len, 0.3, MAIN_W);
    slab.rotateZ(Math.atan2(DECK, run));
    slab.translate((RAMP_X0 + RAMP_X1) / 2, DECK / 2 - 0.12, Z);
    deckParts.push(slab);
    // Low side cheeks so the slope does not float.
    const cheek = new THREE.BoxGeometry(run, 1, 0.2);
    for (const s of [-1, 1]) {
      const c = cheek.clone();
      const pos = c.attributes.position as THREE.BufferAttribute;
      for (let k = 0; k < pos.count; k++) {
        if (pos.getY(k) > 0) {
          const xw = pos.getX(k) + (RAMP_X0 + RAMP_X1) / 2;
          pos.setY(k, DECK * ((RAMP_X1 - xw) / run) - 0.28);
        } else pos.setY(k, -0.6);
      }
      c.computeVertexNormals();
      c.translate((RAMP_X0 + RAMP_X1) / 2, 0, Z + s * (MAIN_W / 2 + 0.05));
      deckParts.push(c);
    }
    cheek.dispose();
  }
  const deckMesh = new THREE.Mesh(keep(merge(deckParts)), wood);
  deckMesh.castShadow = deckMesh.receiveShadow = true;
  group.add(deckMesh);

  const pileGeo = keep(new THREE.CylinderGeometry(0.17, 0.2, 6, 7));
  pileGeo.translate(0, DECK + 0.35 - 3, 0);
  const piles = new THREE.InstancedMesh(pileGeo, piling, pilePos.length);
  const m4 = new THREE.Matrix4();
  pilePos.forEach(([x, z], i) => piles.setMatrixAt(i, m4.makeTranslation(x, 0, z)));
  piles.castShadow = true;
  group.add(piles);

  // Bollards with a turn of rope, and lamps down the main pier.
  const bollardParts: THREE.BufferGeometry[] = [];
  const lampParts: THREE.BufferGeometry[] = [];
  const bulbParts: THREE.BufferGeometry[] = [];
  for (let x = -186; x > -266; x -= 10) {
    for (const s of [-1, 1]) {
      const b = new THREE.CylinderGeometry(0.16, 0.2, 0.45, 10);
      b.translate(x, DECK + 0.22, Z + s * (MAIN_W / 2 - 0.25));
      bollardParts.push(b);
    }
    if (Math.round(x) % 20 === 6 || x === -186) {
      const s = (Math.round(x / 10) % 2) * 2 - 1;
      const post = new THREE.CylinderGeometry(0.06, 0.08, 3.2, 8);
      post.translate(x + 5, DECK + 1.6, Z + s * (MAIN_W / 2 - 0.15));
      lampParts.push(post);
      const bulb = new THREE.SphereGeometry(0.22, 12, 8);
      bulb.translate(x + 5, DECK + 3.3, Z + s * (MAIN_W / 2 - 0.15));
      bulbParts.push(bulb);
    }
  }
  group.add(new THREE.Mesh(keep(merge(bollardParts)), piling));
  group.add(new THREE.Mesh(keep(merge(lampParts)), metal));
  group.add(new THREE.Mesh(keep(merge(bulbParts)), lampMat));
  const lights: THREE.PointLight[] = [];
  if (!opts.lowDetail) {
    for (const x of [-196, -236, -266]) {
      const l = new THREE.PointLight(0xffd59a, 0, 16, 2);
      l.position.set(x, DECK + 3, Z);
      group.add(l);
      lights.push(l);
    }
  }

  // Life rings on the T-head rail.
  const ringGeo = keep(new THREE.TorusGeometry(0.38, 0.1, 8, 20));
  const ringMat = keep(new THREE.MeshStandardMaterial({ color: 0xff5a36, roughness: 0.6 }));
  for (const z of [Z - 8, Z + 8]) {
    const r = new THREE.Mesh(ringGeo, ringMat);
    r.position.set(-270.15, DECK + 0.9, z);
    r.rotation.y = Math.PI / 2;
    group.add(r);
  }
  // A low rail round the end of the T-head, the only railed edge: the rest is
  // for jumping off.
  {
    const rail = new THREE.Mesh(keep(new THREE.BoxGeometry(0.12, 0.12, 22)), wood);
    rail.position.set(-269.9, DECK + 1, Z);
    group.add(rail);
    for (let z = Z - 11; z <= Z + 11; z += 2.75) {
      const p = new THREE.Mesh(keep(new THREE.BoxGeometry(0.14, 1, 0.14)), wood);
      p.position.set(-269.9, DECK + 0.5, z);
      group.add(p);
    }
    boxes.push({ minX: -270, maxX: -269.7, minZ: Z - 11, maxZ: Z + 11, base: DECK, height: DECK + 1.05 });
  }

  // ---- Harbour shack on the T-head ------------------------------------------
  const roofs: THREE.Material[] = [];
  {
    const sx = -266;
    const sz = Z + 6.5;
    const hutMat = keep(new THREE.MeshStandardMaterial({ color: 0x6fa8c8, roughness: 0.8 }));
    const roofMat = keep(new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.7 }));
    roofs.push(roofMat);
    const hut = new THREE.Mesh(keep(new THREE.BoxGeometry(5, 2.8, 3.6)), hutMat);
    hut.position.set(sx, DECK + 1.4, sz);
    hut.castShadow = true;
    group.add(hut);
    const roof = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.01, 3.6, 1.3, 4, 1)), roofMat);
    roof.rotation.y = Math.PI / 4;
    roof.scale.set(1, 1, 0.74);
    roof.position.set(sx, DECK + 3.45, sz);
    group.add(roof);
    solid(boxes, sx, sz, 5, 3.6, DECK, DECK + 2.8);
    // Hatch, awning and the sign over it, facing the main pier (-z).
    const hatch = new THREE.Mesh(keep(new THREE.PlaneGeometry(2.4, 1)), keep(new THREE.MeshStandardMaterial({ color: 0x23323d, emissive: 0xffcc77, emissiveIntensity: 0.05 })));
    hatch.position.set(sx, DECK + 1.6, sz - 1.81);
    hatch.rotation.y = Math.PI;
    group.add(hatch);
    const awn = new THREE.Mesh(keep(new THREE.BoxGeometry(3, 0.06, 1)), keep(new THREE.MeshStandardMaterial({ color: 0xfff4e0 })));
    awn.position.set(sx, DECK + 2.25, sz - 2.25);
    awn.rotation.x = 0.25;
    group.add(awn);
    const sign = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(4, 0.8)),
      keep(
        new THREE.MeshStandardMaterial({
          map: keep(signTexture([{ text: "BOAT RENTALS · BAIT · ICE", size: 76, color: "#fff7e0" }], "#1d4e6b", 1024, 200, "#f6d27a")),
        }),
      ),
    );
    sign.position.set(sx, DECK + 2.9, sz - 1.82);
    sign.rotation.y = Math.PI;
    group.add(sign);
  }
  // The arch over the land end.
  {
    const arch = new THREE.Group();
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(keep(new THREE.BoxGeometry(0.35, 4.4, 0.35)), wood);
      post.position.set(-180.5, DECK + 2.2, Z + s * (MAIN_W / 2 + 0.1));
      arch.add(post);
      solid(boxes, -180.5, Z + s * (MAIN_W / 2 + 0.1), 0.35, 0.35, DECK, DECK + 4.4);
    }
    const face = keep(
      new THREE.MeshStandardMaterial({
        map: keep(signTexture([{ text: "VIBE MARINA", size: 130, color: "#ffffff" }], "#14506e", 1024, 220, "#ffd27a")),
      }),
    );
    // BoxGeometry faces go +x, -x, +y, -y, +z, -z; the board is read from ±x.
    const sign = new THREE.Mesh(keep(new THREE.BoxGeometry(0.2, 1.1, MAIN_W + 1.4)), [face, face, wood, wood, wood, wood]);
    sign.position.set(-180.5, DECK + 4.7, Z);
    arch.add(sign);
    group.add(arch);
  }

  // ---- Sailboats on their moorings -------------------------------------------
  type Bobber = { obj: THREE.Object3D; x: number; z: number; yaw: number; ph: number };
  const bobbers: Bobber[] = [];
  const hullWhite = keep(hullGeometry(7.5, 2.5, 1.1));
  const navy = keep(new THREE.MeshStandardMaterial({ color: 0x1d3557, roughness: 0.5 }));
  const teak = keep(new THREE.MeshStandardMaterial({ color: 0xb7834c, roughness: 0.8 }));
  const stripes = ["#e63946", "#2a9d8f", "#f4a261"];
  const moorings: Array<[number, number, number]> = [
    [-244, Z + 7, 0.0],
    [-244, Z - 7, Math.PI],
    [-259, Z - 7, Math.PI + 0.05],
  ];
  moorings.forEach(([x, z, yaw], i) => {
    const b = new THREE.Group();
    const hull = new THREE.Mesh(hullWhite, i === 1 ? navy : white);
    hull.castShadow = true;
    b.add(hull);
    const deck = new THREE.Mesh(keep(new THREE.BoxGeometry(1.8, 0.05, 4.8)), teak);
    deck.position.set(0, 1.23, -0.4);
    b.add(deck);
    const cabin = new THREE.Mesh(keep(new THREE.BoxGeometry(1.4, 0.55, 2)), white);
    cabin.position.set(0, 1.5, 0.2);
    b.add(cabin);
    const mast = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.06, 0.08, 9, 6)), metal);
    mast.position.set(0, 5.6, 1.1);
    b.add(mast);
    const boom = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.05, 0.05, 3.2, 6)), metal);
    boom.rotation.x = Math.PI / 2;
    boom.position.set(0, 2.2, -0.45);
    b.add(boom);
    // Furled main on the boom, and a jib up forward.
    const furl = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.16, 0.12, 3, 8)), keep(new THREE.MeshStandardMaterial({ color: 0x264653 })));
    furl.rotation.x = Math.PI / 2;
    furl.position.set(0, 2.36, -0.45);
    b.add(furl);
    const jibGeo = new THREE.BufferGeometry();
    jibGeo.setAttribute("position", new THREE.Float32BufferAttribute([0, 9.8, 1.15, 0, 1.4, 1.2, 0, 1.4, 3.6], 3));
    jibGeo.setAttribute("uv", new THREE.Float32BufferAttribute([0.5, 1, 0, 0, 1, 0], 2));
    jibGeo.computeVertexNormals();
    const jib = new THREE.Mesh(keep(jibGeo), keep(new THREE.MeshStandardMaterial({ map: keep(sailTexture(stripes[i])), side: THREE.DoubleSide, roughness: 0.9 })));
    b.add(jib);
    b.position.set(x, 0, z);
    b.rotation.y = yaw;
    group.add(b);
    bobbers.push({ obj: b, x, z, yaw, ph: i * 1.7 });
  });


  // ---- The speedboat ---------------------------------------------------------
  const speedboat = new THREE.Group();
  {
    const hullMat = keep(new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.35 }));
    const red = keep(new THREE.MeshStandardMaterial({ color: 0xe5383b, roughness: 0.4 }));
    const hull = new THREE.Mesh(keep(hullGeometry(5.6, 2.1, 0.8, 0.5)), hullMat);
    hull.position.y = -0.35;
    hull.castShadow = true;
    speedboat.add(hull);
    const stripe = new THREE.Mesh(keep(hullGeometry(5.62, 2.12, 0.14, 0.5)), red);
    stripe.position.y = 0.05;
    speedboat.add(stripe);
    const floor = new THREE.Mesh(keep(new THREE.BoxGeometry(1.5, 0.04, 3.4)), teak);
    floor.position.set(0, 0.48, -0.5);
    speedboat.add(floor);
    const seatMat = keep(new THREE.MeshStandardMaterial({ color: 0xf1e3c8, roughness: 0.8 }));
    for (const sx of [-0.4, 0.4]) {
      const seat = new THREE.Mesh(keep(new THREE.BoxGeometry(0.6, 0.35, 0.6)), seatMat);
      seat.position.set(sx, 0.68, -0.4);
      speedboat.add(seat);
      const back = new THREE.Mesh(keep(new THREE.BoxGeometry(0.6, 0.6, 0.14)), seatMat);
      back.position.set(sx, 1.0, -0.72);
      speedboat.add(back);
    }
    const glass = new THREE.Mesh(
      keep(new THREE.BoxGeometry(1.7, 0.5, 0.04)),
      keep(new THREE.MeshStandardMaterial({ color: 0x9fd3ff, transparent: true, opacity: 0.45, roughness: 0.05, metalness: 0.3 })),
    );
    glass.position.set(0, 0.95, 0.55);
    glass.rotation.x = -0.5;
    speedboat.add(glass);
    const dash = new THREE.Mesh(keep(new THREE.BoxGeometry(1.5, 0.3, 0.4)), keep(new THREE.MeshStandardMaterial({ color: 0x222831 })));
    dash.position.set(0, 0.7, 0.35);
    speedboat.add(dash);
    const wheel = new THREE.Mesh(keep(new THREE.TorusGeometry(0.17, 0.03, 6, 16)), metal);
    wheel.position.set(-0.4, 0.95, 0.12);
    wheel.rotation.x = -0.9;
    speedboat.add(wheel);
    const motor = new THREE.Mesh(keep(new THREE.BoxGeometry(0.45, 0.9, 0.5)), keep(new THREE.MeshStandardMaterial({ color: 0x1b1b1f, roughness: 0.4 })));
    motor.position.set(0, 0.35, -2.95);
    speedboat.add(motor);
    const cowl = new THREE.Mesh(keep(new THREE.BoxGeometry(0.5, 0.12, 0.55)), red);
    cowl.position.set(0, 0.85, -2.95);
    speedboat.add(cowl);
    const name = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(1.4, 0.3)),
      keep(new THREE.MeshStandardMaterial({ map: keep(signTexture([{ text: "VIBE RUNNER", size: 120, color: "#1d3557" }], "#fafafa", 1024, 200)) })),
    );
    for (const s of [-1, 1]) {
      const n = name.clone();
      n.position.set(s * 1.0, 0.25, -1.4);
      n.rotation.y = (s * Math.PI) / 2;
      speedboat.add(n);
    }
  }

  // ---- Hydroplanes -------------------------------------------------------------
  // A three-point racing hydroplane: a flat planing hull, two sponsons
  // forward that it rides on with the prop, an open cockpit, a big engine
  // cowl and a tail wing. Built facing +z like everything else here.
  const buildHydroplane = (body: number, trim: number, num: string, label: string) => {
    const g = new THREE.Group();
    const bodyMat = keep(new THREE.MeshStandardMaterial({ color: body, roughness: 0.3, metalness: 0.1 }));
    const trimMat = keep(new THREE.MeshStandardMaterial({ color: trim, roughness: 0.35, metalness: 0.2 }));
    const dark = keep(new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.5 }));
    const deck = new THREE.Mesh(keep(hullGeometry(7.4, 2.9, 0.38, 0.22)), bodyMat);
    deck.position.y = -0.1;
    deck.castShadow = true;
    g.add(deck);
    // Sponsons: the two forward runners.
    for (const sx of [-1.15, 1.15]) {
      const sp = new THREE.Mesh(keep(new THREE.CapsuleGeometry(0.34, 3.2, 4, 10)), trimMat);
      sp.rotation.x = Math.PI / 2;
      sp.position.set(sx, 0.02, 1.5);
      g.add(sp);
    }
    // Cockpit tub and windscreen.
    const tub = new THREE.Mesh(keep(new THREE.BoxGeometry(0.95, 0.42, 1.5)), dark);
    tub.position.set(0, 0.42, 0.95);
    g.add(tub);
    const screen = new THREE.Mesh(
      keep(new THREE.SphereGeometry(0.55, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2)),
      keep(new THREE.MeshStandardMaterial({ color: 0xa8dcff, transparent: true, opacity: 0.5, roughness: 0.05 })),
    );
    screen.scale.set(0.95, 0.7, 1.1);
    screen.position.set(0, 0.6, 1.75);
    g.add(screen);
    // Engine cowl with a scoop, behind the driver.
    const cowl = new THREE.Mesh(keep(new THREE.BoxGeometry(1.1, 0.7, 2.6)), bodyMat);
    cowl.position.set(0, 0.55, -1.15);
    g.add(cowl);
    const scoop = new THREE.Mesh(keep(new THREE.BoxGeometry(0.7, 0.36, 0.6)), dark);
    scoop.position.set(0, 1.05, -0.25);
    g.add(scoop);
    const stripe = new THREE.Mesh(keep(new THREE.BoxGeometry(1.12, 0.12, 2.62)), trimMat);
    stripe.position.set(0, 0.75, -1.15);
    g.add(stripe);
    // Tail: twin fins carrying a wing.
    const finTex = keep(signTexture([{ text: num, size: 180, color: "#ffffff" }], `#${trim.toString(16).padStart(6, "0")}`, 256, 256));
    const finMat = keep(new THREE.MeshStandardMaterial({ map: finTex }));
    for (const sx of [-0.9, 0.9]) {
      const fin = new THREE.Mesh(keep(new THREE.BoxGeometry(0.08, 1.1, 1)), [finMat, finMat, trimMat, trimMat, trimMat, trimMat]);
      fin.position.set(sx, 0.85, -3.25);
      g.add(fin);
    }
    const wing = new THREE.Mesh(keep(new THREE.BoxGeometry(2.6, 0.08, 0.75)), bodyMat);
    wing.position.set(0, 1.42, -3.3);
    wing.rotation.x = -0.12;
    g.add(wing);
    const name = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(2.2, 0.36)),
      keep(new THREE.MeshStandardMaterial({ map: keep(signTexture([{ text: label, size: 120, color: "#ffffff" }], `#${body.toString(16).padStart(6, "0")}`, 1024, 168)) })),
    );
    for (const s of [-1, 1]) {
      const n = name.clone();
      n.position.set(s * 0.56, 0.6, -1.2);
      n.rotation.y = (s * Math.PI) / 2;
      g.add(n);
    }
    return g;
  };

  // ---- Boats --------------------------------------------------------------------
  type Craft = { boat: Boat; obj: THREE.Object3D; pitch: number; roll: number; idle: number; spray: number };
  const crafts: Craft[] = [];
  const addCraft = (id: string, spec: CraftSpec, obj: THREE.Object3D, home: { x: number; z: number; yaw: number }) => {
    group.add(obj);
    const boat: Boat = { id, spec, x: home.x, z: home.z, yaw: home.yaw, speed: 0, seat: new THREE.Vector3(), home };
    crafts.push({ boat, obj, pitch: 0, roll: 0, idle: 0, spray: 0 });
  };
  addCraft("speedboat", SPEEDBOAT, speedboat, { x: -233.6, z: Z + 6, yaw: 0 });
  // The hydroplanes sit off the T-head's corners, bows to the course.
  addCraft("hydro-1", { ...HYDROPLANE, name: "Miss Vibe" }, buildHydroplane(0xd62828, 0xffc300, "1", "MISS VIBE"), { x: -267, z: Z + 13.4, yaw: -Math.PI / 2 });
  addCraft("hydro-7", { ...HYDROPLANE, name: "Blue Blur" }, buildHydroplane(0x1d4ed8, 0xf1f5f9, "7", "BLUE BLUR"), { x: -267, z: Z - 13.4, yaw: -Math.PI / 2 });

  // Wake: a trail of foam patches that spread and fade, shared by every boat.
  const WAKE = opts.lowDetail ? 24 : 60;
  const foamMat = keep(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.38, depthWrite: false }));
  const foamGeo = keep(new THREE.CircleGeometry(0.6, 12).rotateX(-Math.PI / 2));
  const foam = new THREE.InstancedMesh(foamGeo, foamMat, WAKE);
  foam.frustumCulled = false;
  const wake = Array.from({ length: WAKE }, () => ({ x: 0, z: 0, age: 9, size: 1 }));
  let wakeNext = 0;
  group.add(foam);

  // Rooster tail: the hydroplane's plume of spray, thrown up and back.
  const SPRAY = opts.lowDetail ? 90 : 260;
  const sprayPos = new Float32Array(SPRAY * 3).fill(-999);
  const sprayVel = new Float32Array(SPRAY * 3);
  const sprayAge = new Float32Array(SPRAY).fill(9);
  const sprayGeo = keep(new THREE.BufferGeometry());
  sprayGeo.setAttribute("position", new THREE.BufferAttribute(sprayPos, 3));
  const dropTex = (() => {
    const { c, x } = canvas(64);
    const g = x.createRadialGradient(32, 32, 2, 32, 32, 30);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.5, "rgba(255,255,255,0.6)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 64);
    return keep(tex(c, false));
  })();
  const sprayMat = keep(new THREE.PointsMaterial({ color: 0xf4fbff, size: 1.1, map: dropTex, transparent: true, opacity: 0.8, depthWrite: false }));
  const spray = new THREE.Points(sprayGeo, sprayMat);
  spray.frustumCulled = false;
  let sprayNext = 0;
  group.add(spray);

  // ---- The course ---------------------------------------------------------------
  // An oval of buoy gates west of the T-head, run anticlockwise seen from
  // above. Gate 0, nearest the marina, is start and finish.
  const C = { x: -352, z: Z };
  const RX = 56;
  const RZ = 118;
  const GATES = 8;
  const GATE_HALF = 8;
  const gateAt = (i: number) => {
    const a = (i / GATES) * Math.PI * 2;
    const x = C.x + Math.cos(a) * RX;
    const z = C.z + Math.sin(a) * RZ;
    // Radial direction (the gate spans across the course) and the way round.
    const nx = Math.cos(a) / RX;
    const nz = Math.sin(a) / RZ;
    const nl = Math.hypot(nx, nz);
    return { x, z, rx: nx / nl, rz: nz / nl };
  };
  const gates = Array.from({ length: GATES }, (_, i) => gateAt(i));
  const buoyMat = keep(new THREE.MeshStandardMaterial({ color: 0xff7b1c, roughness: 0.5, emissive: 0xff5a00, emissiveIntensity: 0.05 }));
  const buoyGeo = keep(merge([new THREE.CylinderGeometry(0.55, 0.65, 1.1, 12).translate(0, 0.3, 0), new THREE.ConeGeometry(0.5, 1.2, 12).translate(0, 1.45, 0)]));
  const flagGeo = keep(new THREE.PlaneGeometry(0.9, 0.55).translate(0.45, 0, 0));
  const flagMat = keep(new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
  const buoys: Array<{ obj: THREE.Object3D; x: number; z: number; ph: number }> = [];
  const nextRings: THREE.Mesh[] = [];
  const ringMat2 = keep(new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }));
  gates.forEach((g, i) => {
    for (const s of [-1, 1]) {
      const b = new THREE.Group();
      b.add(new THREE.Mesh(buoyGeo, buoyMat));
      const pole = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 5)), metal);
      pole.position.y = 2.6;
      b.add(pole);
      const flag = new THREE.Mesh(flagGeo, i === 0 ? flagMat : buoyMat);
      flag.position.y = 3.05;
      b.add(flag);
      const x = g.x + g.rx * GATE_HALF * s;
      const z = g.z + g.rz * GATE_HALF * s;
      b.position.set(x, 0, z);
      group.add(b);
      buoys.push({ obj: b, x, z, ph: i + s });
    }
    // A ring of light across the gate you are heading for.
    const ring = new THREE.Mesh(keep(new THREE.TorusGeometry(GATE_HALF, 0.18, 6, 40, Math.PI)), ringMat2);
    ring.position.set(g.x, 0, g.z);
    ring.rotation.y = -Math.atan2(g.rz, g.rx);
    ring.visible = false;
    group.add(ring);
    nextRings.push(ring);
  });
  // Start and finish: two pylons and a chequered banner over gate 0.
  {
    const g = gates[0];
    const { c, x } = canvas(1024, 160);
    for (let i = 0; i < 32; i++) for (let j = 0; j < 5; j++) {
      x.fillStyle = (i + j) % 2 ? "#111" : "#fff";
      x.fillRect(i * 32, j * 32, 32, 32);
    }
    x.fillStyle = "#d62828";
    x.fillRect(300, 28, 424, 104);
    x.fillStyle = "#fff";
    x.font = "bold 76px system-ui, sans-serif";
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillText("START · FINISH", 512, 82);
    const banner = new THREE.Mesh(keep(new THREE.PlaneGeometry(GATE_HALF * 2 + 1, 2.2)), keep(new THREE.MeshStandardMaterial({ map: keep(tex(c, false)), side: THREE.DoubleSide })));
    banner.position.set(g.x, 7.2, g.z);
    banner.rotation.y = -Math.atan2(g.rz, g.rx);
    group.add(banner);
    const pyl = keep(new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.6 }));
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.28, 0.4, 9, 10)), pyl);
      p.position.set(g.x + g.rx * (GATE_HALF + 0.6) * s, 3.8, g.z + g.rz * (GATE_HALF + 0.6) * s);
      group.add(p);
    }
  }
  const race: RaceState = { next: 0, gates: GATES, lap: null, best: null };
  try {
    const v = Number(localStorage.getItem(RACE_KEY));
    if (v > 0) race.best = v;
  } catch {
    /* fine without it */
  }
  let lastGateD = Infinity;

  const insideDeck = (x: number, z: number, pad: number) => {
    for (const [x0, x1, z0, z1] of decks) if (x > x0 - pad && x < x1 + pad && z > z0 - pad && z < z1 + pad) return true;
    return false;
  };
  /** Somewhere a hull of this draught can be, clear of the piers and the other boats. */
  const water = (c: Craft, x: number, z: number) => {
    const sp = c.boat.spec;
    if (!(waterDepthAt(x, z) > sp.draught && !insideDeck(x, z, sp.radius * 0.75) && x > -1400 && Math.abs(z) < 1400)) return false;
    for (const o of crafts) {
      if (o === c) continue;
      if (Math.hypot(o.boat.x - x, o.boat.z - z) < sp.radius + o.boat.spec.radius) {
        // Moving apart is always allowed, or two boats that touched would stay stuck.
        if (Math.hypot(o.boat.x - x, o.boat.z - z) < Math.hypot(o.boat.x - c.boat.x, o.boat.z - c.boat.z)) return false;
      }
    }
    return true;
  };

  const place = (c: Craft, t: number) => {
    const { boat } = c;
    const sp = boat.spec;
    const y = seaSurfaceAt(boat.x, boat.z, t);
    const fx = Math.sin(boat.yaw);
    const fz = Math.cos(boat.yaw);
    const half = sp.length * 0.4;
    const yf = seaSurfaceAt(boat.x + fx * half, boat.z + fz * half, t);
    const yb = seaSurfaceAt(boat.x - fx * half, boat.z - fz * half, t);
    const yl = seaSurfaceAt(boat.x - fz * 1, boat.z + fx * 1, t);
    const yr = seaSurfaceAt(boat.x + fz * 1, boat.z - fx * 1, t);
    const plane = THREE.MathUtils.clamp(boat.speed / sp.maxFwd, 0, 1);
    // Up on the plane the hull skims, so the swell moves it less.
    const ride = 1 - plane * 0.6;
    const targetPitch = -Math.atan2(yf - yb, half * 2) * ride - plane * sp.rake;
    const targetRoll = Math.atan2(yl - yr, 2) * 0.8 * ride;
    c.pitch += (targetPitch - c.pitch) * 0.2;
    c.roll += (targetRoll - c.roll) * 0.2;
    c.obj.position.set(boat.x, y + 0.05 + plane * sp.lift, boat.z);
    c.obj.rotation.set(0, 0, 0);
    c.obj.rotateY(boat.yaw);
    c.obj.rotateX(c.pitch);
    c.obj.rotateZ(c.roll);
    boat.seat.set(...sp.seat).applyEuler(c.obj.rotation).add(c.obj.position);
  };
  for (const c of crafts) place(c, 0);

  const landingTmp = new THREE.Vector3();

  return {
    group,
    entrance: new THREE.Vector3(-170, 0, Z),
    boats: crafts.map((c) => c.boat),
    roofs,
    race: () => race,
    gates: () => gates.map((g) => [g.x, 0, g.z]),
    landing(x, z, reach) {
      let best: THREE.Vector3 | null = null;
      let bestD = reach;
      for (const [x0, x1, z0, z1] of decks) {
        const px = THREE.MathUtils.clamp(x, x0 + 0.5, x1 - 0.5);
        const pz = THREE.MathUtils.clamp(z, z0 + 0.5, z1 - 0.5);
        const d = Math.hypot(px - x, pz - z);
        if (d < bestD) {
          bestD = d;
          best = landingTmp.set(px, DECK, pz).clone();
        }
      }
      return best;
    },
    update(dt, now, drive) {
      const t = now * 0.001;
      const step = Math.min(dt, 0.1);
      let event: MarinaEvent | null = null;
      for (const c of crafts) {
        const { boat } = c;
        const sp = boat.spec;
        const helm = drive?.boat === boat ? drive : null;
        const driving = !!helm;
        if (helm) {
          c.idle = 0;
          const thr = THREE.MathUtils.clamp(helm.throttle, -1, 1);
          const target = thr >= 0 ? thr * sp.maxFwd : thr * sp.maxRev;
          const accel = thr === 0 ? 1.1 : target > boat.speed ? sp.accel : sp.accel * 1.3;
          boat.speed += THREE.MathUtils.clamp(target - boat.speed, -accel * step, accel * step);
          // A boat turns better with way on, not at all standing still, and a
          // fast one carves a wider line.
          const v = Math.abs(boat.speed);
          const grip = THREE.MathUtils.clamp(v / 5, 0.15, 1) * THREE.MathUtils.lerp(1, sp.turnAtSpeed, THREE.MathUtils.clamp(v / sp.maxFwd, 0, 1));
          boat.yaw -= THREE.MathUtils.clamp(helm.steer, -1, 1) * sp.turn * grip * Math.sign(boat.speed || 1) * step;
        } else {
          boat.speed *= Math.pow(0.5, step);
          c.idle += step;
        }
        // Sub-stepped so a fast boat cannot skip over a finger pier.
        const n = Math.max(1, Math.ceil((Math.abs(boat.speed) * step) / 0.5));
        for (let k = 0; k < n; k++) {
          const nx = boat.x + Math.sin(boat.yaw) * boat.speed * (step / n);
          const nz = boat.z + Math.cos(boat.yaw) * boat.speed * (step / n);
          if (water(c, nx, nz)) {
            boat.x = nx;
            boat.z = nz;
          } else if (water(c, nx, boat.z)) {
            boat.x = nx;
            boat.speed *= 0.9;
          } else if (water(c, boat.x, nz)) {
            boat.z = nz;
            boat.speed *= 0.9;
          } else {
            boat.speed *= -0.25;
            break;
          }
        }
        // Left adrift away from the marina for a while: a harbour hand tows it home.
        if (!driving && c.idle > 40 && Math.hypot(boat.x - boat.home.x, boat.z - boat.home.z) > 25) {
          boat.x = boat.home.x;
          boat.z = boat.home.z;
          boat.yaw = boat.home.yaw;
          boat.speed = 0;
        }
        place(c, t);

        const v = Math.abs(boat.speed);
        const fx = Math.sin(boat.yaw);
        const fz = Math.cos(boat.yaw);
        // Wake.
        c.spray -= step;
        if (v > 2 && c.spray <= 0) {
          c.spray = 0.06;
          const w = wake[wakeNext];
          wakeNext = (wakeNext + 1) % WAKE;
          const back = sp.length * 0.55;
          w.x = boat.x - fx * back + (Math.random() - 0.5) * 0.6;
          w.z = boat.z - fz * back + (Math.random() - 0.5) * 0.6;
          w.age = 0;
          w.size = sp === SPEEDBOAT ? 1 : 1.5;
        }
        // Rooster tail, a hydroplane over about 25 knots.
        if (sp.maxFwd > 30 && v > 13) {
          const k = Math.min(1, (v - 13) / 20);
          const count = Math.ceil(k * (opts.lowDetail ? 4 : 10));
          const y0 = c.obj.position.y;
          for (let j = 0; j < count; j++) {
            const i = sprayNext;
            sprayNext = (sprayNext + 1) % SPRAY;
            sprayPos[i * 3] = boat.x - fx * 3.8 + (Math.random() - 0.5) * 0.5;
            sprayPos[i * 3 + 1] = y0 + 0.1;
            sprayPos[i * 3 + 2] = boat.z - fz * 3.8 + (Math.random() - 0.5) * 0.5;
            const back = v * (0.35 + Math.random() * 0.25);
            const side = (Math.random() - 0.5) * 3;
            sprayVel[i * 3] = -fx * back + fz * side;
            sprayVel[i * 3 + 1] = 5 + k * 7 + Math.random() * 3;
            sprayVel[i * 3 + 2] = -fz * back - fx * side;
            sprayAge[i] = 0;
          }
        }

        // The course, for whoever is driving.
        if (driving) {
          const g = gates[race.next];
          const d = Math.hypot(boat.x - g.x, boat.z - g.z);
          // Through the gate: inside its span, and past its line.
          const along = (boat.x - g.x) * g.rx + (boat.z - g.z) * g.rz;
          if (d < GATE_HALF + 2 && Math.abs(along) < GATE_HALF && d > lastGateD) {
            if (race.next === 0) {
              if (race.lap !== null) {
                const time = race.lap;
                const best = race.best === null || time < race.best;
                if (best) {
                  race.best = time;
                  try {
                    localStorage.setItem(RACE_KEY, String(time));
                  } catch {
                    /* fine */
                  }
                }
                event = { type: "lap", time, best };
              } else {
                event = { type: "start" };
              }
              race.lap = 0;
            } else {
              event = { type: "gate", n: race.next };
            }
            race.next = (race.next + 1) % GATES;
            lastGateD = Infinity;
          } else {
            lastGateD = d < GATE_HALF + 2 ? d : Infinity;
          }
          if (race.lap !== null) race.lap += step;
        }
      }
      // Off the boat, the lap is abandoned.
      if (!drive && race.lap !== null) {
        race.lap = null;
        race.next = 0;
      }
      nextRings.forEach((r, i) => {
        r.visible = !!drive && i === race.next;
        if (r.visible) r.position.y = seaSurfaceAt(r.position.x, r.position.z, t);
      });

      for (let i = 0; i < WAKE; i++) {
        const w = wake[i];
        w.age += step;
        const k = w.age / 2.4;
        if (k >= 1) {
          m4.makeScale(0.0001, 0.0001, 0.0001);
        } else {
          // Spreads and thins out: shrinking the core reads as fading.
          const s = (0.5 + k * 1.8) * (1 - k * k * 0.6) * w.size;
          m4.makeScale(s, 1, s).setPosition(w.x, seaSurfaceAt(w.x, w.z, t) + 0.06, w.z);
        }
        foam.setMatrixAt(i, m4);
      }
      foam.instanceMatrix.needsUpdate = true;

      for (let i = 0; i < SPRAY; i++) {
        if (sprayAge[i] > 1.6) {
          sprayPos[i * 3 + 1] = -999;
          continue;
        }
        sprayAge[i] += step;
        sprayVel[i * 3 + 1] -= 9.8 * step;
        sprayPos[i * 3] += sprayVel[i * 3] * step;
        sprayPos[i * 3 + 1] += sprayVel[i * 3 + 1] * step;
        sprayPos[i * 3 + 2] += sprayVel[i * 3 + 2] * step;
        if (sprayPos[i * 3 + 1] < -0.3) sprayAge[i] = 9;
      }
      (sprayGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;

      // Moored boats and buoys ride the swell.
      for (const b of bobbers) {
        const y = seaSurfaceAt(b.x, b.z, t);
        b.obj.position.y = y - 0.25;
        b.obj.rotation.set(Math.sin(t * 0.9 + b.ph) * 0.03, b.yaw + Math.sin(t * 0.3 + b.ph) * 0.04, Math.sin(t * 1.1 + b.ph) * 0.05);
      }
      for (const b of buoys) {
        b.obj.position.y = seaSurfaceAt(b.x, b.z, t) - 0.2;
        b.obj.rotation.set(Math.sin(t * 1.3 + b.ph) * 0.08, t * 0.2 + b.ph, Math.sin(t * 1.1 + b.ph) * 0.08);
      }
      return event;
    },
    setNight(night) {
      lampMat.emissiveIntensity = night ? 2.4 : 0.15;
      buoyMat.emissiveIntensity = night ? 0.9 : 0.05;
      for (const l of lights) l.intensity = night ? 18 : 0;
    },
    dispose() {
      trash.forEach((x) => x.dispose());
      piles.dispose();
      foam.dispose();
    },
  };
}
