/**
 * Everything Cannon Run draws that is not the road: textures made on a
 * canvas, your pickup and its cannon, Mad Mort (all of him), what he drives,
 * and the traffic he drives through. No downloaded assets.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/* ---------------------------------------------------------------- textures */

export function canvasTex(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function roadTexture(): THREE.CanvasTexture {
  const t = canvasTex(256, 512, (c) => {
    c.fillStyle = "#2a2b2e";
    c.fillRect(0, 0, 256, 512);
    for (let k = 0; k < 2600; k++) {
      const v = 30 + Math.random() * 30;
      c.fillStyle = `rgb(${v},${v},${v + 3})`;
      c.fillRect(Math.random() * 256, Math.random() * 512, 2, 2);
    }
    // tyre tracks, a little darker
    c.fillStyle = "rgba(0,0,0,0.16)";
    for (const u of [0.2, 0.32, 0.68, 0.8]) c.fillRect(u * 256 - 9, 0, 18, 512);
    // edge lines, solid
    c.fillStyle = "#e9e4d2";
    c.fillRect(10, 0, 6, 512);
    c.fillRect(240, 0, 6, 512);
    // centre dashes
    c.fillStyle = "#f0c64a";
    c.fillRect(124, 0, 8, 250);
  });
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

export function sandTexture(): THREE.CanvasTexture {
  const t = canvasTex(256, 256, (c) => {
    c.fillStyle = "#3a2f28";
    c.fillRect(0, 0, 256, 256);
    for (let k = 0; k < 3000; k++) {
      const r = 50 + Math.random() * 30;
      c.fillStyle = `rgba(${r},${r * 0.8},${r * 0.65},0.5)`;
      c.fillRect(Math.random() * 256, Math.random() * 256, 2 + Math.random() * 3, 1 + Math.random() * 2);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export function glowTexture(): THREE.CanvasTexture {
  return canvasTex(128, 128, (c) => {
    const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.18, "rgba(255,255,255,0.85)");
    g.addColorStop(0.45, "rgba(255,255,255,0.22)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = g;
    c.fillRect(0, 0, 128, 128);
  });
}

export function puffTexture(): THREE.CanvasTexture {
  return canvasTex(64, 64, (c) => {
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,0.9)");
    g.addColorStop(0.6, "rgba(255,255,255,0.35)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = g;
    c.fillRect(0, 0, 64, 64);
  });
}

export function plateTexture(text: string): THREE.CanvasTexture {
  return canvasTex(128, 64, (c) => {
    c.fillStyle = "#f2efe6";
    c.fillRect(0, 0, 128, 64);
    c.strokeStyle = "#1d3b6e";
    c.lineWidth = 5;
    c.strokeRect(3, 3, 122, 58);
    c.fillStyle = "#1d3b6e";
    c.font = "bold 34px monospace";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(text, 64, 36);
  });
}

/* ---------------------------------------------------------------- models */

type Mat = THREE.Material;
export function box(w: number, h: number, d: number, x: number, y: number, z: number, m: Mat): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  return mesh;
}
export function wheel(r: number, w: number, m: Mat): THREE.Mesh {
  const g = new THREE.CylinderGeometry(r, r, w, 16);
  g.rotateZ(Math.PI / 2);
  return new THREE.Mesh(g, m);
}

/* ---------------------------------------------------------------- the cannon */

export interface Cannon {
  /** The whole gun, carriage and all. Hidden on your truck once Mort has it. */
  root: THREE.Group;
  yaw: THREE.Group;
  pitch: THREE.Group;
  barrel: THREE.Group;
}

/** An oak carriage and an iron barrel with bronze bands. The barrel points to -z. */
export function buildCannon(): Cannon {
  const oak = new THREE.MeshStandardMaterial({ color: 0x6b4428, roughness: 0.85 });
  const iron = new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.6, metalness: 0.55 });
  const bronze = new THREE.MeshStandardMaterial({ color: 0xb4823a, roughness: 0.35, metalness: 0.85 });
  const root = new THREE.Group();
  root.add(box(1.0, 0.22, 1.3, 0, 0.11, 0, oak));
  for (const sx of [-1, 1]) {
    root.add(box(0.12, 0.42, 1.1, sx * 0.4, 0.42, 0.05, oak));
    for (const sz of [-0.42, 0.42]) {
      const tw = wheel(0.2, 0.1, oak);
      tw.position.set(sx * 0.55, 0.12, sz);
      root.add(tw);
    }
  }
  const yaw = new THREE.Group();
  yaw.position.set(0, 0.58, 0.1);
  root.add(yaw);
  const pitch = new THREE.Group();
  yaw.add(pitch);
  const barrel = new THREE.Group();
  pitch.add(barrel);
  const tube = new THREE.CylinderGeometry(0.15, 0.22, 1.9, 20);
  tube.rotateX(-Math.PI / 2);
  tube.translate(0, 0, -0.55);
  barrel.add(new THREE.Mesh(tube, iron));
  for (const [z, r] of [[0.3, 0.235], [-0.2, 0.215], [-1.1, 0.19], [-1.42, 0.2]] as const) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.035, 8, 24), bronze);
    ring.position.z = z;
    barrel.add(ring);
  }
  const swell = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.06, 10, 24), iron);
  swell.position.z = -1.5;
  barrel.add(swell);
  const bore = new THREE.Mesh(new THREE.CircleGeometry(0.11, 18), new THREE.MeshBasicMaterial({ color: 0x050505 }));
  bore.position.z = -1.531;
  bore.rotation.y = Math.PI;
  barrel.add(bore);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 10), iron);
  knob.position.z = 0.5;
  barrel.add(knob);
  for (const sx of [-1, 1]) {
    const trunnion = wheel(0.07, 0.16, bronze);
    trunnion.position.set(sx * 0.27, 0, 0);
    barrel.add(trunnion);
  }
  return { root, yaw, pitch, barrel };
}

/* ---------------------------------------------------------------- your pickup */

export interface Truck {
  root: THREE.Group;
  cannon: Cannon;
  /** the keg and the pile of shot go with the cannon */
  kit: THREE.Group;
  wheels: THREE.Mesh[];
  tail: THREE.MeshBasicMaterial;
  paint: THREE.MeshStandardMaterial;
}

/** A pickup built facing +z; the camera sits over the front of the bed, looking back. */
export function buildTruck(color: number, plateText: string): Truck {
  const root = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x151618, roughness: 0.8 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc9ccd1, roughness: 0.25, metalness: 0.9 });
  const tyre = new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 0.95 });
  const bedFloor = new THREE.MeshStandardMaterial({ color: 0x4a3a2b, roughness: 0.9 });
  const tail = new THREE.MeshBasicMaterial({ color: 0xff2a1a });

  root.add(box(1.96, 0.75, 1.9, 0, 0.95, 1.05, paint));
  root.add(box(1.82, 0.62, 1.4, 0, 1.62, 0.85, paint));
  root.add(box(1.7, 0.42, 0.06, 0, 1.6, 0.13, new THREE.MeshStandardMaterial({ color: 0x0c1218, roughness: 0.1, metalness: 0.6 })));
  root.add(box(1.96, 0.18, 2.7, 0, 0.62, -1.25, bedFloor));
  root.add(box(0.12, 0.55, 2.7, 0.92, 0.98, -1.25, paint));
  root.add(box(0.12, 0.55, 2.7, -0.92, 0.98, -1.25, paint));
  root.add(box(1.96, 0.5, 0.1, 0, 0.96, -2.58, paint));
  root.add(box(1.96, 0.09, 0.14, 0, 1.25, -2.58, chrome));
  root.add(box(2.02, 0.2, 0.22, 0, 0.5, -2.7, chrome));
  root.add(box(1.98, 0.35, 4.7, 0, 0.42, -0.2, dark));
  for (const sx of [-1, 1]) root.add(box(0.2, 0.36, 0.06, sx * 0.86, 1.0, -2.64, tail));
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.26), new THREE.MeshBasicMaterial({ map: plateTexture(plateText) }));
  plate.position.set(0, 0.84, -2.64);
  plate.rotation.y = Math.PI;
  root.add(plate);
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.3, 10), chrome);
  pipe.rotation.x = Math.PI / 2;
  pipe.position.set(0.6, 0.34, -2.8);
  root.add(pipe);
  const wheels: THREE.Mesh[] = [];
  for (const [x, z] of [[0.9, 1.35], [-0.9, 1.35], [0.9, -1.7], [-0.9, -1.7]] as const) {
    const w = wheel(0.42, 0.3, tyre);
    w.position.set(x, 0.42, z);
    root.add(w);
    wheels.push(w);
  }
  const cannon = buildCannon();
  cannon.root.position.set(0, 0.71, -1.15);
  root.add(cannon.root);
  const kit = new THREE.Group();
  root.add(kit);
  const oak = new THREE.MeshStandardMaterial({ color: 0x6b4428, roughness: 0.85 });
  const iron = new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.6, metalness: 0.55 });
  const keg = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.42, 14), oak);
  keg.position.set(0.62, 0.92, -0.35);
  kit.add(keg);
  const shot = new THREE.SphereGeometry(0.1, 10, 8);
  for (let k = 0; k < 5; k++) {
    const b = new THREE.Mesh(shot, iron);
    b.position.set(-0.6 + (k % 3) * 0.16 + (k > 2 ? 0.08 : 0), 0.8 + (k > 2 ? 0.13 : 0), -0.45 + (k > 2 ? 0.05 : 0));
    kit.add(b);
  }
  return { root, cannon, kit, wheels, tail, paint };
}

/* ---------------------------------------------------------------- Mort */

export interface Mort {
  root: THREE.Group;
  head: THREE.Group;
  brows: THREE.Mesh[];
  mouth: THREE.Mesh;
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  /** where a carried cannon goes, in front of his belly */
  hands: THREE.Group;
}

/**
 * All of Mad Mort, built standing on y = 0 and facing +z: work boots, denim
 * overalls over a vest, a belly that has seen a lot of diners, a red face,
 * a stubble beard and a green trucker cap. About 1.95 m tall.
 */
export function buildMort(): Mort {
  const root = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0xe07a5a, roughness: 0.7, emissive: 0x5a1a08 });
  const denim = new THREE.MeshStandardMaterial({ color: 0x35507a, roughness: 0.8 });
  const vest = new THREE.MeshStandardMaterial({ color: 0xe8e2d4, roughness: 0.85 });
  const boot = new THREE.MeshStandardMaterial({ color: 0x3a2418, roughness: 0.8 });
  const cap = new THREE.MeshStandardMaterial({ color: 0x2b5a2a, roughness: 0.8 });
  const stubble = new THREE.MeshStandardMaterial({ color: 0x5a3a2a, roughness: 1 });
  const black = new THREE.MeshBasicMaterial({ color: 0x0a0a0a });
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff });

  const leg = (sx: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(sx * 0.13, 0.86, 0);
    g.add(box(0.2, 0.78, 0.22, 0, -0.39, 0, denim));
    g.add(box(0.22, 0.12, 0.34, 0, -0.8, 0.05, boot));
    root.add(g);
    return g;
  };
  const legL = leg(1);
  const legR = leg(-1);
  root.add(box(0.5, 0.36, 0.3, 0, 0.98, 0, denim)); // hips
  root.add(box(0.48, 0.5, 0.28, 0, 1.38, -0.02, vest)); // chest
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.29, 16, 12), denim);
  belly.scale.set(1, 0.95, 0.9);
  belly.position.set(0, 1.1, 0.07);
  root.add(belly);
  root.add(box(0.36, 0.3, 0.06, 0, 1.3, 0.15, denim)); // bib
  for (const sx of [-1, 1]) root.add(box(0.06, 0.32, 0.05, sx * 0.15, 1.5, 0.12, denim)); // straps
  const arm = (sx: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(sx * 0.31, 1.56, 0);
    g.add(box(0.14, 0.32, 0.14, 0, -0.16, 0, vest));
    g.add(box(0.12, 0.3, 0.12, 0, -0.44, 0, skin));
    const fist = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), skin);
    fist.position.y = -0.62;
    g.add(fist);
    root.add(g);
    return g;
  };
  const armL = arm(1);
  const armR = arm(-1);
  root.add(box(0.14, 0.1, 0.14, 0, 1.66, 0, skin)); // neck
  const head = new THREE.Group();
  head.position.set(0, 1.8, 0);
  root.add(head);
  head.add(new THREE.Mesh(new THREE.SphereGeometry(0.2, 18, 14), skin));
  const beard = new THREE.Mesh(new THREE.SphereGeometry(0.19, 14, 10, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.45), stubble);
  beard.position.set(0, -0.02, 0.02);
  head.add(beard);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), skin);
  nose.position.set(0, -0.01, 0.2);
  head.add(nose);
  const brows: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.048, 10, 8), white);
    eye.position.set(sx * 0.075, 0.045, 0.165);
    head.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.024, 8, 6), black);
    pupil.position.set(sx * 0.075, 0.045, 0.208);
    head.add(pupil);
    const brow = box(0.12, 0.03, 0.04, sx * 0.075, 0.12, 0.18, black);
    brow.rotation.z = sx * 0.5;
    head.add(brow);
    brows.push(brow);
  }
  const mouth = box(0.12, 0.035, 0.04, 0, -0.085, 0.18, black);
  head.add(mouth);
  head.add(box(0.42, 0.05, 0.46, 0, 0.17, 0.08, cap)); // brim
  const crown = new THREE.Mesh(new THREE.SphereGeometry(0.21, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), cap);
  crown.position.y = 0.12;
  head.add(crown);
  const hands = new THREE.Group();
  hands.position.set(0, 1.12, 0.42);
  root.add(hands);
  return { root, head, brows, mouth, armL, armR, legL, legR, hands };
}

/* ---------------------------------------------------------------- his backup */

export interface Hench {
  root: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  /** the stick arm */
  armR: THREE.Group;
}

/**
 * One of Mort's cousins: a black hoodie, dark jeans, sneakers, a black
 * face-covering hat with an eye slit, and a stick. Built on y = 0, facing +z.
 * The materials are shared by every henchman, so pass them in.
 */
export function henchKit(): Record<"hood" | "jeans" | "shoe" | "mask" | "skin" | "stick" | "eyes", THREE.Material> {
  return {
    hood: new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.9 }),
    jeans: new THREE.MeshStandardMaterial({ color: 0x2c3b55, roughness: 0.85 }),
    shoe: new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.7 }),
    mask: new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.95 }),
    skin: new THREE.MeshStandardMaterial({ color: 0xc98a64, roughness: 0.7 }),
    stick: new THREE.MeshStandardMaterial({ color: 0x7a5432, roughness: 0.9 }),
    eyes: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  };
}
export function buildHench(m: ReturnType<typeof henchKit>): Hench {
  const root = new THREE.Group();
  const leg = (sx: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(sx * 0.11, 0.82, 0);
    g.add(box(0.17, 0.76, 0.19, 0, -0.38, 0, m.jeans));
    g.add(box(0.19, 0.1, 0.3, 0, -0.77, 0.05, m.shoe));
    root.add(g);
    return g;
  };
  const legL = leg(1);
  const legR = leg(-1);
  root.add(box(0.4, 0.62, 0.24, 0, 1.16, 0, m.hood));
  root.add(box(0.3, 0.12, 0.08, 0, 0.98, 0.13, m.hood)); // the pocket
  const arm = (sx: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(sx * 0.26, 1.42, 0);
    g.add(box(0.12, 0.58, 0.13, 0, -0.29, 0, m.hood));
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.065, 8, 6), m.skin);
    hand.position.y = -0.62;
    g.add(hand);
    root.add(g);
    return g;
  };
  const armL = arm(1);
  const armR = arm(-1);
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.95, 8), m.stick);
  stick.position.set(0, -0.62, 0.38);
  stick.rotation.x = Math.PI / 2 - 0.3;
  armR.add(stick);
  // the head is the hat: a black knit mask pulled all the way down, with a slit for the eyes
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 10), m.mask);
  head.scale.set(1, 1.12, 1);
  head.position.y = 1.66;
  root.add(head);
  const slit = box(0.22, 0.05, 0.02, 0, 1.69, 0.165, m.skin);
  root.add(slit);
  for (const sx of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.02, 6, 4), m.eyes);
    e.position.set(sx * 0.055, 1.69, 0.18);
    root.add(e);
  }
  const pom = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), m.mask);
  pom.position.y = 1.86;
  root.add(pom);
  return { root, legL, legR, armL, armR };
}

/** A little swivel gun for the cab roof, bought in the garage. Points to -z. */
export function buildAutoGun(): { root: THREE.Group; yaw: THREE.Group; barrel: THREE.Group } {
  const steel = new THREE.MeshStandardMaterial({ color: 0x3a3e44, roughness: 0.4, metalness: 0.8 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xc8963a, roughness: 0.35, metalness: 0.85 });
  const root = new THREE.Group();
  root.add(box(0.36, 0.1, 0.36, 0, 0.05, 0, steel));
  const yaw = new THREE.Group();
  yaw.position.y = 0.22;
  root.add(yaw);
  yaw.add(box(0.26, 0.2, 0.3, 0, 0, 0.05, steel));
  const barrel = new THREE.Group();
  yaw.add(barrel);
  const tube = new THREE.CylinderGeometry(0.05, 0.07, 0.8, 12);
  tube.rotateX(-Math.PI / 2);
  tube.translate(0, 0.02, -0.4);
  barrel.add(new THREE.Mesh(tube, steel));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.02, 6, 14), brass);
  ring.position.set(0, 0.02, -0.78);
  barrel.add(ring);
  return { root, yaw, barrel };
}

/* ---------------------------------------------------------------- what Mort drives */

export interface Foe {
  root: THREE.Group;
  body: THREE.Group;
  mort: Mort;
  wheels: THREE.Mesh[];
  paint: THREE.MeshStandardMaterial;
  len: number;
  wid: number;
  tall: number;
  lamps: THREE.Vector3[];
  /** his driver's door, in the vehicle's own frame */
  door: THREE.Vector3;
  /** the cement truck's mixing drum, which turns */
  drum: THREE.Group | null;
  /** where henchmen climb out, in the vehicle's own frame */
  hatch: THREE.Vector3;
}

export const RIDES = [
  { name: "the station wagon", color: 0x8a5a2b, len: 4.8, wid: 1.9, tall: 1.75, hp: 4 },
  { name: "the tow truck", color: 0xd6a42a, len: 5.6, wid: 2.1, tall: 2.0, hp: 6 },
  { name: "the monster pickup", color: 0xb52a22, len: 5.4, wid: 2.5, tall: 2.6, hp: 8 },
  { name: "the big rig", color: 0x3c4552, len: 7.0, wid: 2.5, tall: 3.2, hp: 11 },
  { name: "the cement truck", color: 0xd8d6cf, len: 8.0, wid: 2.5, tall: 3.3, hp: 14 },
];

/** Mort and whatever he is driving tonight. Built facing +z, so his grille faces you. */
export function buildFoe(level: number): Foe {
  const spec = RIDES[Math.min(level - 1, RIDES.length - 1)];
  const { len, wid, tall } = spec;
  const lift = level === 3 ? 0.7 : 0;
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const paint = new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.55, metalness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.85 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xbfc3c8, roughness: 0.3, metalness: 0.9 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1a2630, roughness: 0.15, metalness: 0.4, transparent: true, opacity: 0.45 });
  const tyreM = new THREE.MeshStandardMaterial({ color: 0x0e0e0e, roughness: 0.95 });
  const lamp = new THREE.MeshBasicMaterial({ color: 0xfff4d6 });

  const lower = tall * 0.45;
  const base = 0.35 + lift;
  body.add(box(wid, lower, len, 0, base + lower / 2, 0, paint));
  const cabLen = level === 1 ? len * 0.62 : Math.min(2.2, len * 0.38);
  const cabZ = level === 1 ? -0.1 : len / 2 - cabLen / 2 - 0.9;
  const cabH = tall * 0.5;
  const cabY = base + lower + cabH / 2;
  const cw = wid * 0.92;
  body.add(box(cw, 0.1, cabLen, 0, cabY + cabH / 2 - 0.05, cabZ, paint));
  body.add(box(cw, cabH, 0.08, 0, cabY, cabZ - cabLen / 2 + 0.04, paint));
  for (const sx of [-1, 1]) {
    body.add(box(0.08, cabH * 0.35, cabLen, sx * (cw / 2 - 0.04), cabY - cabH * 0.32, cabZ, paint));
    body.add(box(0.1, cabH, 0.1, sx * (cw / 2 - 0.05), cabY, cabZ + cabLen / 2 - 0.05, paint));
  }
  body.add(box(cw * 0.95, 0.2, 0.5, 0, cabY - cabH / 2 + 0.25, cabZ + cabLen / 2 - 0.3, dark));
  body.add(box(wid * 0.84, cabH * 0.78, 0.05, 0, cabY + 0.02, cabZ + cabLen / 2 + 0.01, glass));
  body.add(box(wid * 0.9, 0.5, 0.08, 0, base + lower * 0.55, len / 2 + 0.02, chrome));
  for (const sx of [-0.35, 0.35]) body.add(box(0.09, lower * 1.05, 0.09, sx * wid, base + lower * 0.5, len / 2 + 0.32, chrome));
  body.add(box(wid * 0.85, 0.1, 0.1, 0, base + lower * 0.95, len / 2 + 0.32, chrome));
  body.add(box(wid * 0.85, 0.1, 0.1, 0, base + lower * 0.3, len / 2 + 0.32, chrome));
  if (level === 2) {
    const boom = box(0.25, 0.25, 2.4, 0, base + lower + 0.9, -len / 2 + 1.1, dark);
    boom.rotation.x = 0.35;
    body.add(boom);
    body.add(box(wid * 0.6, 0.18, 0.4, 0, base + lower + 0.1 + cabH, cabZ, new THREE.MeshBasicMaterial({ color: 0xff9a1a })));
  }
  if (level === 4) {
    for (const sx of [-1, 1]) {
      const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 2.2, 10), chrome);
      stack.position.set(sx * (wid / 2 + 0.05), base + lower + 1.0, cabZ - cabLen / 2 - 0.1);
      body.add(stack);
    }
  }
  let drum: THREE.Group | null = null;
  if (level >= 5) {
    // a striped mixing drum on its cradle, tipped up toward the cab
    const rear = len - cabLen - 1.2;
    drum = new THREE.Group();
    drum.position.set(0, base + lower + 0.95, -len / 2 + rear / 2 + 0.2);
    drum.rotation.x = -0.12;
    body.add(drum);
    const geo = new THREE.CylinderGeometry(0.75, 1.15, rear, 20, 1);
    geo.rotateX(Math.PI / 2);
    const stripes = canvasTex(64, 256, (c) => {
      for (let i = 0; i < 8; i++) { c.fillStyle = i % 2 ? "#e8e4da" : "#d8622a"; c.fillRect(0, i * 32, 64, 32); }
    });
    stripes.wrapS = THREE.RepeatWrapping;
    drum.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: stripes, roughness: 0.6, metalness: 0.2 })));
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.75, 0.5, 16), dark);
    cap.rotation.x = -Math.PI / 2;
    cap.position.z = -rear / 2 - 0.2;
    drum.add(cap);
    for (const sx of [-1, 1]) body.add(box(0.15, 0.9, 0.3, sx * 0.8, base + lower + 0.35, -len / 2 + 0.8, dark));
    body.add(box(0.5, 0.4, 0.9, 0, base + lower + 0.3, -len / 2 - 0.1, dark)); // the chute
  }
  const lamps: THREE.Vector3[] = [];
  for (const sx of [-1, 1]) {
    const l = new THREE.Mesh(new THREE.CircleGeometry(0.2, 18), lamp);
    const p = new THREE.Vector3(sx * wid * 0.33, base + lower * 0.62, len / 2 + 0.07);
    l.position.copy(p);
    body.add(l);
    lamps.push(p);
  }
  const wheels: THREE.Mesh[] = [];
  const r = level === 3 ? 0.95 : 0.42 + tall * 0.06;
  for (const sx of [-1, 1]) for (const sz of [len * 0.32, -len * 0.32]) {
    const w = wheel(r, level === 3 ? 0.6 : 0.3, tyreM);
    w.position.set(sx * (wid / 2 - (level === 3 ? -0.1 : 0.05)), r, sz);
    root.add(w);
    wheels.push(w);
  }

  // Mort, sitting on the driver's side (+x when facing +z): hips on the seat,
  // legs folded out of sight under the dash, upper body scaled to the cab.
  const mort = buildMort();
  const seatY = base + lower - 0.2;
  const room = cabY + cabH / 2 - 0.1 - seatY;
  const sc = clampN(room / 1.15, 0.7, 1.35);
  mort.root.scale.setScalar(sc);
  mort.root.position.set(wid * 0.22, seatY - 0.86 * sc, cabZ + cabLen / 2 - 0.55);
  mort.legL.visible = false;
  mort.legR.visible = false;
  // a steering wheel under his right hand
  const steer = new THREE.Mesh(new THREE.TorusGeometry(0.17 * sc, 0.025 * sc, 8, 20), dark);
  steer.position.set(wid * 0.22 - 0.28 * sc, seatY + 0.5 * sc, cabZ + cabLen / 2 - 0.55 + 0.5 * sc);
  steer.rotation.x = -0.5;
  body.add(steer);
  body.add(mort.root);
  const door = new THREE.Vector3(wid / 2 + 0.6, 0, cabZ);
  const hatch = new THREE.Vector3(-wid / 2 - 0.4, 0, cabZ);
  return { root, body, mort, wheels, paint, len, wid, tall: tall + lift, lamps, door, drum, hatch };
}

const clampN = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));

/* ---------------------------------------------------------------- traffic */

export function trafficGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (w: number, h: number, d: number, x: number, y: number, z: number, r: number, g: number, b: number): void => {
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(x, y, z);
    const n = geo.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b; }
    geo.setAttribute("color", new THREE.BufferAttribute(c, 3));
    parts.push(geo);
  };
  // Built around its own centre of mass (y = 0.75), so it can spin in the air.
  add(1.85, 0.6, 4.3, 0, 0.65 - 0.75, 0, 1, 1, 1);
  add(1.6, 0.55, 2.2, 0, 1.2 - 0.75, -0.2, 0.12, 0.15, 0.2);
  add(0.4, 0.14, 0.05, 0.6, 0.75 - 0.75, 2.16, 4, 4, 3.4);
  add(0.4, 0.14, 0.05, -0.6, 0.75 - 0.75, 2.16, 4, 4, 3.4);
  add(0.42, 0.14, 0.05, 0.62, 0.78 - 0.75, -2.16, 3, 0.1, 0.08);
  add(0.42, 0.14, 0.05, -0.62, 0.78 - 0.75, -2.16, 3, 0.1, 0.08);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(0.26, 0.64, 0.64, sx * 0.88, 0.32 - 0.75, sz * 1.38, 0.05, 0.05, 0.05);
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return g;
}
