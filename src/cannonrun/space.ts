/**
 * Cannon Chase in outer space (`?space`, or the 🚀 chip in the lobby).
 *
 * The same chase on the same maths (road.ts): the highway is a glowing space
 * lane, the desert is an asteroid belt, and everything floats a little off
 * the lane instead of rolling on it. You swiped Mad Mort's blaster, he
 * boarded a rocket to get it back, and every ride he had on the ground has a
 * rocket version: the space wagon, the space tug, the monster rocket, the
 * comet mixer, the star hauler and, for the last one, the Tripod.
 *
 * Every builder here returns exactly the shape its ground twin in models.ts
 * returns (Truck, Cannon, Foe), so the engine runs them unchanged. Positions
 * that matter to the simulation (`len`, `wid`, `tall`, `door`, `hatch`) keep
 * the ground numbers, so a rocket is as hard to hit as the truck it replaces.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { box, canvasTex, plateTexture, buildMort, rideAt, RIDES, type Cannon, type Truck, type Foe, type RideKind } from "./models";

/** how far everything floats above the lane */
export const HOVER = 0.55;


const std = (color: number, roughness = 0.5, metalness = 0.4, emissive = 0x000000): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive });
const glowMat = (color: number): THREE.MeshBasicMaterial => new THREE.MeshBasicMaterial({ color, toneMapped: false });

const cyl = (rt: number, rb: number, h: number, seg: number, m: THREE.Material): THREE.Mesh => new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);

/** A rocket bell with a lit throat, pointing its exhaust down -z. */
function thruster(r: number, len: number, shell: THREE.Material, flame: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const bell = cyl(r * 0.55, r, len, 18, shell);
  bell.rotation.x = -Math.PI / 2;
  g.add(bell);
  const throat = new THREE.Mesh(new THREE.CircleGeometry(r * 0.86, 18), flame);
  throat.rotation.y = Math.PI;
  throat.position.z = -len / 2 - 0.01;
  g.add(throat);
  return g;
}

/* ---------------------------------------------------------------- the blaster */

/**
 * Mort's blaster: a long, finned energy gun on a swivel, with a green emitter
 * at the muzzle and coils down the barrel. Same groups as the cannon: the
 * barrel points to -z.
 */
export function buildBlaster(): Cannon {
  const steel = std(0x4a5058, 0.35, 0.85);
  const dark = std(0x16181c, 0.6, 0.5);
  const brass = std(0xc8963a, 0.35, 0.85);
  const green = glowMat(0x6dff8a);
  const root = new THREE.Group();
  const ped = cyl(0.42, 0.55, 0.24, 18, dark);
  ped.position.y = 0.12;
  root.add(ped);
  root.add(box(0.5, 0.38, 0.5, 0, 0.42, 0.05, steel));
  const yaw = new THREE.Group();
  yaw.position.set(0, 0.62, 0.1);
  root.add(yaw);
  for (const sx of [-1, 1]) yaw.add(box(0.1, 0.4, 0.5, sx * 0.3, 0.05, 0, steel));
  const pitch = new THREE.Group();
  yaw.add(pitch);
  const barrel = new THREE.Group();
  pitch.add(barrel);
  // the body of the gun: a fat breech block, then a long tube
  barrel.add(box(0.36, 0.34, 0.7, 0, 0, 0.25, dark));
  const tube = new THREE.CylinderGeometry(0.11, 0.14, 1.7, 16);
  tube.rotateX(-Math.PI / 2);
  tube.translate(0, 0, -0.7);
  barrel.add(new THREE.Mesh(tube, steel));
  for (let i = 0; i < 5; i++) {
    const coil = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.03, 6, 18), i % 2 ? brass : green);
    coil.position.z = -0.1 - i * 0.22;
    barrel.add(coil);
  }
  // cooling fins along the top and the sides
  for (let i = 0; i < 4; i++) {
    barrel.add(box(0.02, 0.16, 0.5, 0, 0.18, -0.25 - i * 0.02, dark).translateZ(-i * 0.2));
  }
  const muzzle = cyl(0.17, 0.13, 0.22, 16, dark);
  muzzle.rotation.x = Math.PI / 2;
  muzzle.position.z = -1.6;
  barrel.add(muzzle);
  const tip = new THREE.Mesh(new THREE.CircleGeometry(0.1, 16), green);
  tip.rotation.y = Math.PI;
  tip.position.z = -1.715;
  barrel.add(tip);
  // a scope on the left
  const scope = cyl(0.05, 0.05, 0.5, 10, dark);
  scope.rotation.x = Math.PI / 2;
  scope.position.set(-0.22, 0.12, 0.1);
  barrel.add(scope);
  return { root, yaw, pitch, barrel };
}

/* ---------------------------------------------------------------- your freighter */

/**
 * Your ride: a battered saucer freighter, a flat disc with two cargo prongs
 * out the front, the cockpit in a tube on its right shoulder and a blue
 * engine glow across the back. Built facing +z like the pickup, about its
 * size, with the blaster where the cannon sat.
 */
export function buildFreighter(color: number, plateText: string): Truck {
  const root = new THREE.Group();
  const hull = std(0xc9c6bd, 0.6, 0.35);
  const paint = std(color, 0.45, 0.35);
  const dark = std(0x24272c, 0.7, 0.45);
  const grime = std(0x7d786c, 0.85, 0.2);
  const glass = std(0x0c1a26, 0.1, 0.6, 0x0a2a40);
  const engine = glowMat(0x7ad8ff);
  const tail = new THREE.MeshBasicMaterial({ color: 0x7ad8ff, toneMapped: false });
  const y0 = 0.95;
  // the disc: a squat cylinder, bevelled top and bottom
  const disc = cyl(2.25, 2.25, 0.34, 40, hull);
  disc.position.set(0, y0, -0.55);
  root.add(disc);
  const top = cyl(1.6, 2.25, 0.22, 40, hull);
  top.position.set(0, y0 + 0.28, -0.55);
  root.add(top);
  const bot = cyl(2.25, 1.5, 0.22, 40, grime);
  bot.position.set(0, y0 - 0.28, -0.55);
  root.add(bot);
  // the raised hub the blaster stands on
  const hub = cyl(0.95, 1.1, 0.2, 28, grime);
  hub.position.set(0, y0 + 0.48, -0.9);
  root.add(hub);
  // painted panels, in your colour, round the top of the disc
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    const p = box(0.7, 0.04, 0.4, 0, 0, 0, i % 2 ? paint : grime);
    p.position.set(Math.sin(a) * 1.7, y0 + 0.4, -0.55 + Math.cos(a) * 1.7);
    p.rotation.y = a;
    p.rotation.x = -0.18;
    root.add(p);
  }
  // the two prongs out the front, with a slot between them
  for (const sx of [-1, 1]) {
    root.add(box(0.75, 0.32, 2.1, sx * 0.6, y0, 2.0, hull));
    root.add(box(0.76, 0.06, 1.9, sx * 0.6, y0 + 0.19, 2.0, paint));
    root.add(box(0.2, 0.2, 0.3, sx * 0.6, y0 - 0.06, 3.1, dark));
  }
  root.add(box(0.5, 0.2, 0.6, 0, y0, 1.25, dark));
  // the cockpit: a tube off the right shoulder ending in a glazed nose
  const tube = cyl(0.34, 0.34, 1.5, 18, hull);
  tube.rotation.x = Math.PI / 2;
  tube.position.set(1.95, y0 + 0.05, 0.9);
  root.add(tube);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.34, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2), glass);
  nose.rotation.x = Math.PI / 2;
  nose.position.set(1.95, y0 + 0.05, 1.65);
  root.add(nose);
  root.add(box(0.5, 0.2, 0.9, 1.6, y0, 0.3, hull));
  // a dish on the left and some pipework, so it looks lived in
  const dish = new THREE.Mesh(new THREE.SphereGeometry(0.35, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2.6), dark);
  dish.rotation.x = Math.PI;
  dish.position.set(-1.25, y0 + 0.62, 0.1);
  root.add(dish);
  root.add(cyl(0.04, 0.04, 0.3, 6, dark).translateX(-1.25).translateY(y0 + 0.45).translateZ(0.1));
  for (const sx of [-1, 1]) root.add(box(0.08, 0.08, 1.2, sx * 1.1, y0 + 0.42, 0.7, dark));
  // the engine: one long blue slot across the back of the disc
  const slot = new THREE.Mesh(new THREE.CylinderGeometry(2.27, 2.27, 0.16, 40, 1, true, Math.PI * 0.72, Math.PI * 0.56), engine);
  slot.position.set(0, y0, -0.55);
  root.add(slot);
  // a glow under it too, which is what it floats on
  const under = new THREE.Mesh(new THREE.CircleGeometry(1.1, 24), new THREE.MeshBasicMaterial({ color: 0x3aa8ff, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false }));
  under.rotation.x = Math.PI / 2;
  under.position.set(0, y0 - 0.4, -0.55);
  root.add(under);
  for (const sx of [-1, 1]) root.add(box(0.22, 0.12, 0.05, sx * 0.9, y0 + 0.05, -2.78, tail));
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.26), new THREE.MeshBasicMaterial({ map: plateTexture(plateText) }));
  plate.position.set(0, y0 - 0.05, -2.81);
  plate.rotation.y = Math.PI;
  root.add(plate);
  const cannon = buildBlaster();
  cannon.root.position.set(0, y0 + 0.58, -0.95);
  root.add(cannon.root);
  // spare power cells by the gun
  const kit = new THREE.Group();
  root.add(kit);
  const cell = new THREE.CylinderGeometry(0.09, 0.09, 0.34, 10);
  const cellMat = glowMat(0x6dff8a);
  for (let k = 0; k < 4; k++) {
    const c = new THREE.Mesh(cell, k % 2 ? cellMat : dark);
    c.position.set(0.78 + (k % 2) * 0.2, y0 + 0.6, -0.4 - Math.floor(k / 2) * 0.24);
    kit.add(c);
  }
  return { root, cannon, kit, wheels: [], tail, paint };
}

/* ---------------------------------------------------------------- what Mort flies */

/**
 * Mort's rockets, one for every ride he had on the ground. Built facing +z,
 * nose toward you, Mort in a bubble canopy at the front. The footprint is the
 * ground ride's footprint; the look is not.
 */
export function buildRocket(level: number, linda = false): Foe {
  const spec = rideAt(level);
  const kind: RideKind = spec.kind;
  const { len, wid, tall } = spec;
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const LINDA = [0x6a3d8f, 0x2f8f6a, 0xd2449a, 0x8fd4e0, 0x7a2fa8, 0x3a1f4a];
  const hue = linda ? LINDA[RIDES.indexOf(spec)] : spec.color;
  // a touch of self-glow, because in space nothing lights a nose pointed at you
  const paint = std(hue, 0.45, 0.4, new THREE.Color(hue).multiplyScalar(0.18).getHex());
  const dark = std(0x2a2d33, 0.6, 0.5, 0x0c0e12);
  const steel = std(0x9aa1a8, 0.3, 0.9, 0x1a1c20);
  const wood = std(0x7a4a24, 0.8, 0.1);
  const cream = std(0xe8e0c8, 0.6, 0.2);
  const glass = new THREE.MeshStandardMaterial({ color: 0x9ad8ff, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.28, depthWrite: false });
  const flame = glowMat(linda ? 0xff6ad8 : 0xff9a3a);
  const lamp = new THREE.MeshBasicMaterial({ color: 0xfff4d6 });
  const red = std(0xc0281e, 0.5, 0.3, 0x3a0806);

  // Where Mort sits and how big the canopy is, per ride.
  let base = 0.75; // underside of the hull
  let seatY = 1.25;
  let cabZ = len / 2 - 1.3;
  let room = 1.0;
  let anim: Foe["anim"] = null;
  const stack: THREE.Vector3 | null = null;
  const tripod = kind === "train";

  const canopy = (r: number, x: number, y: number, z: number): void => {
    const dome = new THREE.Mesh(new THREE.SphereGeometry(r, 22, 14, 0, Math.PI * 2, 0, Math.PI / 2), glass);
    dome.position.set(x, y, z);
    dome.renderOrder = 2;
    body.add(dome);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(r, 0.06, 8, 26), steel);
    rim.rotation.x = Math.PI / 2;
    rim.position.set(x, y, z);
    body.add(rim);
  };
  /** a nose cone pointing +z */
  let nose: { z: number; y: number; r: number } | null = null;
  const noseCone = (r: number, l: number, z: number, y: number, m: THREE.Material): void => {
    // blunt, so the headlamps have a face to sit on
    const c = cyl(r * 0.5, r, l, 22, m);
    nose = { z: z + l + 0.02, y, r: r * 0.5 };
    c.rotation.x = Math.PI / 2;
    c.position.set(0, y, z + l / 2);
    body.add(c);
  };
  const tube = (r: number, l: number, z: number, y: number, m: THREE.Material): THREE.Mesh => {
    const c = cyl(r, r, l, 22, m);
    c.rotation.x = Math.PI / 2;
    c.position.set(0, y, z);
    body.add(c);
    return c;
  };
  const fins = (n: number, size: number, z: number, y: number, r: number, m: THREE.Material): void => {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.PI / n;
      const f = new THREE.Group();
      f.position.set(0, y, z);
      f.rotation.z = a;
      const blade = box(0.08, size, size * 1.3, 0, r + size / 2 - 0.1, 0, m);
      blade.rotation.x = -0.35;
      f.add(blade);
      body.add(f);
    }
  };
  const motor = (r: number, l: number, x: number, y: number, z: number, shell: THREE.Material = dark): void => {
    const t = thruster(r, l, shell, flame);
    t.position.set(x, y, z);
    body.add(t);
  };

  if (kind === "wagon") {
    // A station wagon somebody bolted a rocket to: long, boxy, wood panels, tail fins.
    base = 0.6;
    const h = tall * 0.55;
    body.add(box(wid, h, len * 0.86, 0, base + h / 2, -len * 0.05, paint));
    for (const sx of [-1, 1]) body.add(box(0.04, h * 0.5, len * 0.7, sx * (wid / 2 + 0.01), base + h * 0.45, -len * 0.1, wood));
    noseCone(wid * 0.48, len * 0.2, len * 0.38, base + h / 2, paint);
    body.add(box(wid * 0.86, 0.12, len * 0.5, 0, base + h + 0.4, -len * 0.18, cream));
    for (const sx of [-1, 1]) {
      const fin = box(0.08, 0.9, 1.1, sx * (wid / 2 - 0.1), base + h + 0.3, -len / 2 + 0.6, paint);
      fin.rotation.z = sx * 0.35;
      body.add(fin);
    }
    motor(0.55, 0.8, 0, base + h / 2, -len / 2 - 0.2);
    cabZ = len * 0.2;
    seatY = base + h - 0.15;
    room = 0.95;
    canopy(0.75, wid * 0.18, base + h, cabZ);
  } else if (kind === "tow") {
    // A stubby yellow tug with a grabber claw on the back and a beacon on top.
    base = 0.7;
    const h = tall * 0.6;
    body.add(box(wid, h, len * 0.7, 0, base + h / 2, 0.2, paint));
    noseCone(wid * 0.5, 0.9, len * 0.55 - 0.1, base + h / 2, paint);
    for (const sx of [-1, 1]) {
      body.add(box(0.5, 0.5, 1.2, sx * (wid / 2 + 0.2), base + 0.35, -len / 2 + 0.9, dark));
      motor(0.32, 0.6, sx * (wid / 2 + 0.2), base + 0.35, -len / 2 + 0.1);
    }
    const boom = box(0.25, 0.25, 2.4, 0, base + h + 0.6, -len / 2 + 0.8, dark);
    boom.rotation.x = 0.4;
    body.add(boom);
    const claw = new THREE.Group();
    claw.position.set(0, base + h + 0.15, -len / 2 - 0.3);
    for (const sx of [-1, 1]) {
      const finger = box(0.1, 0.1, 0.7, sx * 0.25, -0.2, -0.1, steel);
      finger.rotation.y = sx * 0.5;
      claw.add(finger);
    }
    body.add(claw);
    body.add(box(wid * 0.6, 0.18, 0.4, 0, base + h + 0.1, 0.3, glowMat(0xff9a1a)));
    anim = (a) => { claw.rotation.x = Math.sin(a * 0.7) * 0.25; };
    cabZ = len * 0.25;
    seatY = base + h - 0.1;
    room = 1.0;
    canopy(0.72, wid * 0.18, base + h, cabZ);
  } else if (kind === "monster") {
    // Four enormous thruster pods where the monster tyres were, hull high in the middle.
    base = 1.3;
    const h = tall * 0.38;
    body.add(box(wid * 0.8, h, len * 0.8, 0, base + h / 2, 0, paint));
    noseCone(wid * 0.38, 1.0, len * 0.4, base + h / 2, paint);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const pod = cyl(0.62, 0.62, 1.7, 18, dark);
      pod.rotation.x = Math.PI / 2;
      pod.position.set(sx * (wid / 2 + 0.05), 0.95, sz * len * 0.3);
      body.add(pod);
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.64, 0.07, 6, 20), paint);
      band.position.set(sx * (wid / 2 + 0.05), 0.95, sz * len * 0.3);
      body.add(band);
      motor(0.5, 0.4, sx * (wid / 2 + 0.05), 0.95, sz * len * 0.3 - 1.0);
      body.add(box(0.2, 0.6, 0.2, sx * (wid / 2 - 0.3), base, sz * len * 0.3, steel));
    }
    // a roll cage and a row of roof lamps, as monster trucks have
    body.add(box(wid * 0.8, 0.08, 0.08, 0, base + h + 0.75, len * 0.12, steel));
    for (let i = 0; i < 4; i++) body.add(box(0.2, 0.15, 0.1, (i / 3 - 0.5) * wid * 0.6, base + h + 0.85, len * 0.12, lamp));
    cabZ = len * 0.12;
    seatY = base + h - 0.1;
    room = 1.0;
    canopy(0.8, wid * 0.16, base + h, cabZ);
  } else if (kind === "cement") {
    // A cab up front and a striped drum that never stops turning, now with rockets.
    base = 0.7;
    const cabLen = 2.2;
    const h = tall * 0.32;
    body.add(box(wid, h, len, 0, base + h / 2, 0, dark));
    body.add(box(wid, tall * 0.3, cabLen, 0, base + h + tall * 0.15, len / 2 - cabLen / 2, paint));
    noseCone(wid * 0.45, 0.8, len / 2, base + h * 0.8, paint);
    const rear = len - cabLen - 1.0;
    const drum = new THREE.Group();
    drum.position.set(0, base + h + 0.95, -len / 2 + rear / 2 + 0.2);
    drum.rotation.x = -0.12;
    body.add(drum);
    const geo = new THREE.CylinderGeometry(0.75, 1.15, rear, 20, 1);
    geo.rotateX(Math.PI / 2);
    const stripes = canvasTex(64, 256, (c) => {
      for (let i = 0; i < 8; i++) { c.fillStyle = i % 2 ? "#e8e4da" : linda ? "#8a3ad8" : "#3a8ad8"; c.fillRect(0, i * 32, 64, 32); }
    });
    stripes.wrapS = THREE.RepeatWrapping;
    drum.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: stripes, roughness: 0.6, metalness: 0.2 })));
    for (const sx of [-1, 1]) motor(0.4, 0.7, sx * 0.7, base + h / 2, -len / 2 - 0.2);
    anim = (a) => { drum.rotation.z = a * 0.25; };
    cabZ = len / 2 - 1.0;
    seatY = base + h + 0.2;
    room = 1.1;
    canopy(0.78, wid * 0.18, base + h + tall * 0.3, cabZ);
  } else if (kind === "rig") {
    // A long-haul tractor towing a container of somebody's freight between planets.
    base = 0.7;
    const cabLen = 3.0;
    const h = tall * 0.5;
    body.add(box(wid, h, cabLen, 0, base + h / 2, len / 2 - cabLen / 2, paint));
    noseCone(wid * 0.48, 1.0, len / 2, base + h / 2, paint);
    const tLen = len - cabLen - 1.6;
    const cont = new THREE.MeshStandardMaterial({ color: linda ? 0xe8d8f0 : 0xd8d4c4, roughness: 0.7 });
    body.add(box(wid * 1.04, tall + 0.4 - base, tLen, 0, base + (tall + 0.4 - base) / 2, -len / 2 + tLen / 2, cont));
    for (const sx of [-1, 1]) {
      body.add(box(0.03, 0.3, tLen - 0.4, sx * (wid * 0.52 + 0.01), base + 1.6, -len / 2 + tLen / 2, glowMat(linda ? 0xff6ad8 : 0x6ad8ff)));
      body.add(box(0.3, 0.3, 1.4, sx * 0.5, base + 0.3, -len / 2 + tLen + 0.7, dark));
    }
    for (const sx of [-1, 1]) for (const sy of [0, 1]) motor(0.38, 0.6, sx * 0.7, base + 0.6 + sy * 1.4, -len / 2 - 0.3);
    // two whip antennas where the stacks were
    for (const sx of [-1, 1]) body.add(cyl(0.03, 0.05, 2.2, 6, steel).translateX(sx * (wid / 2 - 0.1)).translateY(base + h + 1.1).translateZ(len / 2 - cabLen - 0.2));
    cabZ = len / 2 - 1.2;
    seatY = base + h - 0.1;
    room = 1.05;
    canopy(0.8, wid * 0.18, base + h, cabZ);
  } else if (tripod) {
    // The last one is not a rocket. A domed war machine on three long legs,
    // with a heat-ray eye that glows, wading down the lane after you.
    base = 3.2;
    const hullM = std(linda ? 0x7a5a8a : 0x8a8f94, 0.3, 0.85);
    const shell = new THREE.Mesh(new THREE.SphereGeometry(1, 30, 18), hullM);
    shell.scale.set(wid * 1.05, 1.15, len * 0.42);
    shell.position.set(0, base + 1.0, -0.3);
    body.add(shell);
    const skirt = new THREE.Mesh(new THREE.TorusGeometry(1, 0.08, 8, 40), dark);
    skirt.scale.set(wid * 1.07, len * 0.43, 1);
    skirt.rotation.x = Math.PI / 2;
    skirt.position.set(0, base + 0.85, -0.3);
    body.add(skirt);
    // a ring of ports along the skirt
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const port = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), flame);
      port.position.set(Math.sin(a) * wid * 1.0, base + 0.75, -0.3 + Math.cos(a) * len * 0.41);
      body.add(port);
    }
    // the heat-ray eye on a neck at the front
    const neck = cyl(0.18, 0.25, 1.2, 10, dark);
    neck.rotation.x = Math.PI / 2 - 0.3;
    neck.position.set(-wid * 0.3, base + 1.7, len * 0.36);
    body.add(neck);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.38, 16, 12), hullM);
    eye.position.set(-wid * 0.3, base + 1.9, len * 0.44);
    body.add(eye);
    const ray = new THREE.Mesh(new THREE.CircleGeometry(0.24, 18), glowMat(linda ? 0xff4ad8 : 0x6dff6a));
    ray.position.set(-wid * 0.3, base + 1.9, len * 0.44 + 0.37);
    body.add(ray);
    // three legs, each hip-knee-foot, that swing as it walks
    const legs: { hip: THREE.Group; knee: THREE.Group; phase: number }[] = [];
    const HIPS: [number, number, number][] = [[wid * 0.7, len * 0.22, 0], [-wid * 0.7, len * 0.22, 2.1], [0, -len * 0.34, 4.2]];
    for (const [x, z, ph] of HIPS) {
      const hip = new THREE.Group();
      hip.position.set(x, base + 0.6, z);
      const upper = cyl(0.14, 0.18, 2.6, 8, dark);
      upper.position.y = -1.3;
      hip.add(upper);
      const knee = new THREE.Group();
      knee.position.y = -2.6;
      hip.add(knee);
      knee.add(new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 8), steel));
      const lower = cyl(0.1, 0.14, base + 0.5, 8, steel);
      lower.position.y = -(base + 0.5) / 2;
      knee.add(lower);
      const foot = cyl(0.35, 0.45, 0.16, 12, dark);
      foot.position.y = -(base + 0.5);
      knee.add(foot);
      hip.rotation.z = x === 0 ? 0 : -Math.sign(x) * 0.42;
      knee.rotation.z = x === 0 ? 0 : Math.sign(x) * 0.62;
      body.add(hip);
      legs.push({ hip, knee, phase: ph });
    }
    // and a cluster of tendrils hanging underneath, because it would
    for (let i = 0; i < 5; i++) {
      const t = cyl(0.04, 0.02, 1.4, 5, dark);
      t.position.set((i - 2) * 0.35, base - 0.1, -0.2 + (i % 2) * 0.4);
      t.rotation.z = (i - 2) * 0.12;
      body.add(t);
    }
    anim = (a) => {
      for (const l of legs) {
        const k = a * 0.18 + l.phase;
        l.hip.rotation.x = Math.sin(k) * 0.32;
        l.knee.rotation.x = Math.max(0, -Math.cos(k)) * 0.5;
      }
      ray.scale.setScalar(0.85 + 0.25 * Math.sin(a * 2.3));
    };
    cabZ = len * 0.26;
    seatY = base + 1.55;
    room = 1.1;
    canopy(0.85, wid * 0.22, base + 1.55, cabZ);
  }

  // headlamps on the nose, where the engine looks for them
  const lamps: THREE.Vector3[] = [];
  const nz = nose as { z: number; y: number; r: number } | null;
  const lampY = tripod ? base + 1.0 : nz ? nz.y : base + 0.35;
  const lampZ = tripod ? len * 0.42 : nz ? nz.z : len / 2 + 0.07;
  const lampX = tripod ? wid * 0.3 : nz ? nz.r * 0.5 : wid * 0.3;
  for (const sx of [-1, 1]) {
    const l = new THREE.Mesh(new THREE.CircleGeometry(nz ? Math.min(0.18, nz.r * 0.35) : 0.18, 16), lamp);
    const p = new THREE.Vector3(sx * lampX, lampY, lampZ);
    l.position.copy(p);
    body.add(l);
    lamps.push(p);
  }
  // a stripe of warning red under the nose of the rockets
  if (!tripod) body.add(box(wid * 0.7, 0.1, 0.1, 0, base + 0.1, len / 2 - 0.3, red));
  // a lamp out in front, because in space nothing else lights the side he points at you
  const fill = new THREE.PointLight(0xdfe6ff, 9, 14, 1.6);
  fill.position.set(0, base + 2.2, len / 2 + 3.5);
  root.add(fill);
  // the thing anim() is driven by: no wheels in space, so a dummy that turns with speed
  const spinner = new THREE.Object3D();
  root.add(spinner);

  // Mort under the canopy, upper body only, in his helmet
  const mort = buildMort(linda);
  const sc = Math.min(1.25, Math.max(0.7, room / 1.15));
  mort.root.scale.setScalar(sc);
  const mx = tripod ? wid * 0.22 : wid * 0.18;
  mort.root.position.set(mx, seatY - 0.86 * sc, cabZ - 0.1);
  mort.legL.visible = false;
  mort.legR.visible = false;
  const steer = new THREE.Mesh(new THREE.TorusGeometry(0.17 * sc, 0.025 * sc, 8, 20), dark);
  steer.position.set(mx - 0.28 * sc, seatY + 0.5 * sc - 0.86 * sc + 0.86 * sc, cabZ + 0.4 * sc);
  steer.rotation.x = -0.5;
  body.add(steer);
  body.add(mort.root);
  const door = new THREE.Vector3(wid / 2 + 0.6, 0, cabZ);
  const hatch = new THREE.Vector3(-wid / 2 - 0.4, 0, cabZ);
  return { root, body, mort, wheels: [spinner], paint, len, wid, tall: tripod ? base + 2.2 : tall, lamps, door, anim, stack, hatch };
}

/* ---------------------------------------------------------------- traffic */

/** Civilian pods: a rounded little shuttle with a glowing window band. Vertex colours, white body tinted per instance. */
export function spaceTrafficGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const tint = (geo: THREE.BufferGeometry, r: number, g: number, b: number): void => {
    const geo2 = geo.index ? geo.toNonIndexed() : geo;
    const n = geo2.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b; }
    geo2.setAttribute("color", new THREE.BufferAttribute(c, 3));
    geo2.deleteAttribute("uv");
    parts.push(geo2);
  };
  // Built round its centre (y = 0), floating; the engine lifts it by HOVER + 0.75.
  const hull = new THREE.SphereGeometry(1, 18, 12);
  hull.scale(0.95, 0.5, 2.1);
  tint(hull, 1, 1, 1);
  const band = new THREE.CylinderGeometry(0.97, 0.97, 0.16, 18, 1, true);
  band.scale(1, 1, 2.0);
  band.translate(0, 0.12, 0);
  tint(band, 0.5, 2.2, 3.2);
  for (const sx of [-1, 1]) {
    const pod = new THREE.CylinderGeometry(0.22, 0.3, 1.1, 10);
    pod.rotateX(Math.PI / 2);
    pod.translate(sx * 0.95, -0.1, -1.2);
    tint(pod, 0.1, 0.1, 0.12);
    const jet = new THREE.CircleGeometry(0.2, 10);
    jet.rotateY(Math.PI);
    jet.translate(sx * 0.95, -0.1, -1.76);
    tint(jet, 3, 1.2, 0.3);
  }
  for (const sx of [-1, 1]) {
    const lamp = new THREE.BoxGeometry(0.3, 0.1, 0.05);
    lamp.translate(sx * 0.5, -0.05, 2.08);
    tint(lamp, 4, 4, 3.4);
  }
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  hull.dispose();
  band.dispose();
  return g;
}

/* ---------------------------------------------------------------- scenery */

/** A lumpy asteroid of radius about 1, flat-shaded. */
export function asteroidGeometry(seed = 1, detail = 1): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = 0.78 + 0.32 * Math.abs(Math.sin(x * 3.1 * seed + y * 1.7) * Math.cos(z * 2.3 + seed) + 0.4 * Math.sin(y * 5.3 + x * 2.1));
    p.setXYZ(i, x * n, y * n * 0.85, z * n);
  }
  g.computeVertexNormals();
  return g;
}

/** The lane: dark glass with cyan edges and dashed lane lines, drawn on top of the stars. */
export function laneTexture(): THREE.CanvasTexture {
  const t = canvasTex(256, 256, (c) => {
    c.fillStyle = "#070b1c";
    c.fillRect(0, 0, 256, 256);
    // a faint grid
    c.strokeStyle = "rgba(90,160,255,0.18)";
    c.lineWidth = 2;
    for (let x = 0; x <= 256; x += 32) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, 256); c.stroke(); }
    for (let y = 0; y <= 256; y += 32) { c.beginPath(); c.moveTo(0, y); c.lineTo(256, y); c.stroke(); }
    // edges
    c.fillStyle = "#4de0ff";
    c.fillRect(0, 0, 10, 256);
    c.fillRect(246, 0, 10, 256);
    // the dashes between lanes
    c.fillStyle = "#ffd84a";
    for (const x of [84, 170]) c.fillRect(x - 3, 0, 6, 128);
  });
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** A gas giant, banded, for where the moon was. */
export function planetTexture(): THREE.CanvasTexture {
  return canvasTex(256, 256, (c) => {
    const g = c.createRadialGradient(100, 100, 10, 128, 128, 128);
    g.addColorStop(0, "#ffe2b0");
    g.addColorStop(1, "#b0602a");
    c.fillStyle = g;
    c.beginPath();
    c.arc(128, 128, 126, 0, Math.PI * 2);
    c.fill();
    c.save();
    c.beginPath();
    c.arc(128, 128, 126, 0, Math.PI * 2);
    c.clip();
    for (let i = 0; i < 14; i++) {
      c.fillStyle = i % 2 ? "rgba(120,50,20,0.35)" : "rgba(255,230,190,0.25)";
      const y = 20 + i * 16 + Math.sin(i * 1.7) * 4;
      c.fillRect(0, y, 256, 6 + (i % 3) * 4);
    }
    c.fillStyle = "rgba(170,40,20,0.6)";
    c.beginPath();
    c.ellipse(160, 150, 22, 11, 0, 0, Math.PI * 2);
    c.fill();
    // the night side
    const sh = c.createLinearGradient(40, 0, 256, 0);
    sh.addColorStop(0, "rgba(0,0,0,0)");
    sh.addColorStop(1, "rgba(0,0,10,0.75)");
    c.fillStyle = sh;
    c.fillRect(0, 0, 256, 256);
    c.restore();
  });
}

/** A soft cloud of colour for the nebulae. */
export function nebulaTexture(): THREE.CanvasTexture {
  return canvasTex(256, 256, (c) => {
    for (let i = 0; i < 40; i++) {
      const x = 128 + (Math.random() - 0.5) * 140;
      const y = 128 + (Math.random() - 0.5) * 110;
      const r = 30 + Math.random() * 70;
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, "rgba(255,255,255,0.10)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      c.fillStyle = g;
      c.fillRect(0, 0, 256, 256);
    }
  });
}

/** Lines Mort shouts in space, mixed in with his usual ones. */
export const SPACE_TAUNTS = [
  "That's MY blaster!", "GIVE ME BACK MY BLASTER!", "I built this rocket in my GARAGE!", "Nobody outflies Mort!",
  "In space, everybody can hear me YELL!", "PULL OVER! Wait, where's over?", "That blaster was my grandpa's!",
  "I'll chase you to the next galaxy, pal!", "I'm not even mad. I'm ORBITAL.",
];
export const SPACE_L_TAUNTS = [
  "Linda's in SPACE, honey!", "That's my cousin's blaster, sweetie!", "Zero gravity, zero mercy, darling!", "Wheeee! Nobody outflies Linda!",
];
export const SPACE_COMMENTS: Record<number, string> = {
  2: "He's back. In a space tug.",
  3: "Oh no. Monster rocket.",
  4: "A comet mixer. In SPACE.",
  5: "Now it's a star hauler.",
  6: "Is that... a TRIPOD?!",
};
export const SPACE_RADIO = [
  "Gatch News, live from low orbit. Folks, stay in your pods.",
  "Our space cam confirms: that is a REAL blaster.",
  "A caller says the man chasing them is named Mort. He sounds upset. And far away.",
  "Gatch Traffic: heavy delays at the asteroid belt, blaster bolts in the left lane.",
  "Experts say: do not try this in your own freighter.",
  "We go live to our reporter, who is hiding behind a small moon.",
  "Mort's grandmother has asked everyone to please come home for dinner.",
  "This just in: he is still very, very mad. In space.",
];
export const SPACE_IDLE_NEWS: [string, string][] = [
  ["BLASTER CHASE ENTERS ITS {MIN}TH MINUTE", "Nobody has docked"],
  ["GALAXY GRIPPED BY BLASTER CHASE", "Gatch News Space Cam 7 is in orbit"],
  ["'THAT WAS MY GRANDPA'S,' SAYS FURIOUS PILOT", "He has said it eleven times now"],
];
