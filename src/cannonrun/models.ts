/**
 * Everything Cannon Run draws that is not the road: textures made on a
 * canvas, your pickup and its cannon, Mad Mort (all of him), what he drives,
 * and the traffic he drives through. No downloaded assets.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/* ---------------------------------------------------------------- textures */

/** Thanksgiving dress-up: pilgrim hats, turkeys on heads, feathers for Linda. */
/** Face styles for Mort and Linda (Jack, Nov 2026: "make their faces better"). */
export type FaceStyle = "classic" | "cartoon" | "muppet" | "clay";
export const FACE_STYLES: FaceStyle[] = ["classic", "cartoon", "muppet", "clay"];
export const THEME: { thanksgiving: boolean; face: FaceStyle } = { thanksgiving: false, face: "classic" };

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
export function buildMort(linda = false): Mort {
  const root = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: linda ? 0xe89a78 : 0xe07a5a, roughness: 0.7, emissive: 0x5a1a08 });
  const denim = new THREE.MeshStandardMaterial({ color: linda ? 0xc23a8a : 0x35507a, roughness: 0.8 });
  const vest = new THREE.MeshStandardMaterial({ color: linda ? 0x8a3ad8 : 0xe8e2d4, roughness: 0.85 });
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
  if (linda) {
    // Lunatic Linda: wild orange hair going every way, a pink headband, red lips
    const hair = new THREE.MeshStandardMaterial({ color: 0xe0601e, roughness: 0.9 });
    const puffs: [number, number, number, number][] = [[0, 0.16, -0.04, 0.2], [0.17, 0.1, -0.04, 0.15], [-0.17, 0.1, -0.04, 0.15], [0.22, -0.06, -0.06, 0.13], [-0.22, -0.06, -0.06, 0.13], [0, 0.02, -0.18, 0.2], [0.12, 0.24, 0.02, 0.11], [-0.13, 0.25, 0.0, 0.12], [0.26, 0.16, -0.12, 0.1], [-0.27, 0.15, -0.12, 0.1]];
    for (const [x, y, z, rr] of puffs) {
      const h = new THREE.Mesh(new THREE.SphereGeometry(rr, 10, 8), hair);
      h.position.set(x, y, z);
      head.add(h);
    }
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.025, 6, 20), new THREE.MeshStandardMaterial({ color: 0xff4fb0, roughness: 0.6 }));
    band.rotation.x = Math.PI / 2 - 0.35;
    band.position.set(0, 0.1, 0.01);
    head.add(band);
    if (THEME.thanksgiving) {
      // a fan of turkey feathers stuck in the headband
      const cols = [0x8a3a1a, 0xd8862a, 0xb8241a, 0xe0b040, 0x6a2a12];
      for (let i = 0; i < 7; i++) {
        const f = box(0.06, 0.34, 0.015, 0, 0, 0, new THREE.MeshStandardMaterial({ color: cols[i % cols.length], roughness: 0.8 }));
        f.geometry.translate(0, 0.17, 0);
        f.position.set(0, 0.22, -0.12);
        f.rotation.z = (i - 3) * 0.32;
        head.add(f);
      }
    }
  }
  let brows: THREE.Mesh[] = [];
  let mouth: THREE.Mesh;
  if (THEME.face !== "classic") ({ brows, mouth } = buildFace(head, linda, THEME.face, skin, stubble));
  else {
    const beard = new THREE.Mesh(new THREE.SphereGeometry(0.19, 14, 10, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.45), stubble);
    beard.position.set(0, -0.02, 0.02);
    if (!linda) head.add(beard);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), skin);
    nose.position.set(0, -0.01, 0.2);
    head.add(nose);
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
    mouth = box(0.12, 0.035, 0.04, 0, -0.085, 0.18, linda ? white : black);
    if (linda) {
      // Linda grinds her teeth: a clenched white row between red lips
      mouth.scale.set(1.25, 1.6, 1);
      for (let i = -2; i <= 2; i++) mouth.add(box(0.006, 0.04, 0.005, i * 0.022, 0, 0.021, black));
      mouth.add(box(0.12, 0.004, 0.005, 0, 0, 0.021, black));
      const lips = box(0.17, 0.085, 0.03, 0, -0.085, 0.172, new THREE.MeshBasicMaterial({ color: 0xc0102a }));
      head.add(lips);
    }
    head.add(mouth);
  }
  if (!linda) {
    if (THEME.thanksgiving) {
      // a pilgrim hat instead of the cap
      const blk = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.8 });
      head.add(new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.03, 18), blk).translateY(0.15));
      head.add(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.36, 16), blk).translateY(0.33));
      head.add(box(0.16, 0.1, 0.02, 0, 0.22, 0.2, new THREE.MeshStandardMaterial({ color: 0xffc83a, roughness: 0.3, metalness: 0.8 })));
    } else head.add(box(0.42, 0.05, 0.46, 0, 0.17, 0.08, cap)); // brim
    if (!THEME.thanksgiving) {
      const crown = new THREE.Mesh(new THREE.SphereGeometry(0.21, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), cap);
      crown.position.y = 0.12;
      head.add(crown);
    }
  }
  const hands = new THREE.Group();
  hands.position.set(0, 1.12, 0.42);
  root.add(hands);
  return { root, head, brows, mouth, armL, armR, legL, legR, hands };
}

/**
 * The other faces, on a head of radius 0.2 facing +z. Each returns the two
 * brows (left first, which the engine tilts when he is furious) and a mouth
 * (which it stretches when he shouts).
 */
function buildFace(head: THREE.Group, linda: boolean, style: FaceStyle, skin: THREE.Material, stubble: THREE.Material): { brows: THREE.Mesh[]; mouth: THREE.Mesh } {
  const black = new THREE.MeshBasicMaterial({ color: 0x0a0a0a });
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25, emissive: 0x333333 });
  const tooth = new THREE.MeshStandardMaterial({ color: 0xfffbe8, roughness: 0.4, emissive: 0x2a2a22 });
  const gum = new THREE.MeshBasicMaterial({ color: 0x3a0a10 });
  const browCol = new THREE.MeshStandardMaterial({ color: linda ? 0xc0480e : 0x3a2414, roughness: 1 });
  const lipCol = new THREE.MeshStandardMaterial({ color: linda ? 0xd0103a : 0x9a3a2a, roughness: 0.5 });
  const cheekCol = new THREE.MeshBasicMaterial({ color: linda ? 0xff6a8a : 0xd03a2a, transparent: true, opacity: 0.45, depthWrite: false });
  const iris = new THREE.MeshBasicMaterial({ color: linda ? 0x1aa88a : 0x5a3a14 });
  const brows: THREE.Mesh[] = [];
  const ball = (r: number, m: THREE.Material, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): THREE.Mesh => {
    const b = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), m);
    b.position.set(x, y, z);
    b.scale.set(sx, sy, sz);
    head.add(b);
    return b;
  };
  // ears, for everybody but the muppet
  if (style !== "muppet") for (const sx of [-1, 1]) ball(0.055, skin, sx * 0.195, 0, -0.01, 0.5, 1, 0.8);

  if (style === "cartoon") {
    // big glossy eyes with heavy lids, a fat nose, rosy cheeks, a toothy grimace
    for (const sx of [-1, 1]) {
      ball(0.062, white, sx * 0.078, 0.04, 0.155, 1, 1.18, 0.7);
      ball(0.032, iris, sx * 0.074, 0.035, 0.196, 1, 1.1, 0.5);
      ball(0.017, black, sx * 0.073, 0.035, 0.205, 1, 1, 0.5);
      ball(0.008, new THREE.MeshBasicMaterial({ color: 0xffffff }), sx * 0.073 + 0.012, 0.05, 0.212);
      // the upper lid: a skin cap over the eyeball, tipped down at the middle (Mort) or wide open (Linda)
      const lid = new THREE.Mesh(new THREE.SphereGeometry(0.066, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.38), skin);
      lid.position.set(sx * 0.078, 0.042, 0.157);
      lid.scale.set(1.05, 1.2, 0.75);
      lid.rotation.set(0.5, 0, linda ? 0 : -sx * 0.35);
      head.add(lid);
      if (linda) for (let k = 0; k < 3; k++) {
        const lash = box(0.006, 0.035, 0.004, sx * (0.06 + k * 0.022), 0.115 + (k === 1 ? 0.008 : 0), 0.17, black);
        lash.rotation.z = -sx * (0.3 + k * 0.25);
        head.add(lash);
      }
      ball(0.04, cheekCol, sx * 0.12, -0.05, 0.15, 1, 0.7, 0.4);
      const brow = new THREE.Mesh(new THREE.CapsuleGeometry(0.022, 0.09, 4, 8), browCol);
      brow.rotation.z = Math.PI / 2;
      const g = new THREE.Mesh(new THREE.BoxGeometry(0.001, 0.001, 0.001), black);
      g.position.set(sx * 0.08, 0.118, 0.18);
      g.add(brow);
      head.add(g);
      brows.push(g);
    }
    ball(0.062, skin, 0, -0.02, 0.2, 1, 0.9, 0.9); // nose
    if (!linda) ball(0.19, stubble, 0, -0.03, 0.02, 1, 1, 1).geometry = new THREE.SphereGeometry(0.19, 16, 10, 0, Math.PI * 2, Math.PI * 0.6, Math.PI * 0.4);
    const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.045, 0.02), gum);
    mouth.position.set(0, -0.098, 0.178);
    for (let i = -3; i <= 3; i++) {
      mouth.add(box(0.016, 0.018, 0.012, i * 0.017, 0.012, 0.01, tooth));
      mouth.add(box(0.016, 0.016, 0.012, i * 0.017, -0.013, 0.01, tooth));
    }
    head.add(mouth);
    const lip = new THREE.Mesh(new THREE.TorusGeometry(0.068, 0.011, 6, 20), lipCol);
    lip.scale.set(1, 0.42, 0.6);
    lip.position.set(0, -0.098, 0.176);
    head.add(lip);
    return { brows, mouth };
  }

  if (style === "muppet") {
    // ping-pong eyes on top, a ball nose and a big hinged mouth
    for (const sx of [-1, 1]) {
      ball(0.07, white, sx * 0.075, 0.085, 0.14);
      ball(0.026, black, sx * 0.07 - sx * 0.006, 0.08, 0.208, 1, 1, 0.5);
      const lid = new THREE.Mesh(new THREE.SphereGeometry(0.073, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.42), skin);
      lid.position.set(sx * 0.075, 0.085, 0.14);
      lid.rotation.set(0.4, 0, linda ? sx * 0.15 : -sx * 0.4);
      head.add(lid);
      const brow = box(0.1, 0.028, 0.03, 0, 0, 0, browCol);
      const g = new THREE.Mesh(new THREE.BoxGeometry(0.001, 0.001, 0.001), black);
      g.position.set(sx * 0.075, 0.165, 0.17);
      g.add(brow);
      head.add(g);
      brows.push(g);
      if (linda) for (let k = 0; k < 4; k++) {
        const lash = box(0.006, 0.04, 0.004, sx * (0.04 + k * 0.022), 0.155, 0.18, black);
        lash.rotation.z = -sx * (0.1 + k * 0.25);
        head.add(lash);
      }
    }
    ball(0.055, new THREE.MeshStandardMaterial({ color: linda ? 0xff7a9a : 0xd8402a, roughness: 0.6 }), 0, 0.02, 0.205);
    // the mouth: a dark half-disc from cheek to cheek with a tongue in it
    const mouthGeo = new THREE.CircleGeometry(0.12, 24, Math.PI, Math.PI);
    const mouth = new THREE.Mesh(mouthGeo, gum);
    mouth.position.set(0, -0.045, 0.19);
    mouth.rotation.x = -0.25;
    const tongue = new THREE.Mesh(new THREE.CircleGeometry(0.055, 16, Math.PI, Math.PI), new THREE.MeshBasicMaterial({ color: 0xd8506a }));
    tongue.position.set(0, -0.06, 0.002);
    tongue.scale.y = 0.6;
    mouth.add(tongue);
    if (linda) mouth.add(box(0.2, 0.025, 0.004, 0, -0.008, 0.003, tooth));
    head.add(mouth);
    const lip = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.012, 6, 24, Math.PI), lipCol);
    lip.rotation.z = Math.PI;
    lip.position.copy(mouth.position);
    lip.rotation.x = -0.25;
    head.add(lip);
    if (!linda) ball(0.195, stubble, 0, -0.03, 0.0).geometry = new THREE.SphereGeometry(0.195, 16, 10, 0, Math.PI * 2, Math.PI * 0.66, Math.PI * 0.34);
    return { brows, mouth };
  }

  // clay: Aardman-ish. Eyes close together under one heavy brow ridge, a bulb of a nose, a wide toothy grin
  for (const sx of [-1, 1]) {
    ball(0.045, white, sx * 0.05, 0.06, 0.17, 1, 1.25, 0.7);
    ball(0.02, black, sx * 0.048, 0.055, 0.2, 1, 1.2, 0.5);
    ball(0.006, new THREE.MeshBasicMaterial({ color: 0xffffff }), sx * 0.048 + 0.008, 0.066, 0.208);
    const brow = new THREE.Mesh(new THREE.CapsuleGeometry(0.028, 0.06, 4, 8), browCol);
    brow.rotation.z = Math.PI / 2;
    const g = new THREE.Mesh(new THREE.BoxGeometry(0.001, 0.001, 0.001), black);
    g.position.set(sx * 0.058, 0.122, 0.175);
    g.add(brow);
    head.add(g);
    brows.push(g);
    if (linda) {
      const shadow = ball(0.05, new THREE.MeshBasicMaterial({ color: 0x8a3ad8 }), sx * 0.05, 0.085, 0.165, 1, 0.5, 0.6);
      shadow.renderOrder = -1;
    }
  }
  ball(0.075, skin, 0, -0.005, 0.205, 1.1, 0.95, 0.85); // the nose, big and round
  const cheek = (sx: number): void => { ball(0.06, skin, sx * 0.1, -0.06, 0.13, 1, 0.85, 0.8); ball(0.035, cheekCol, sx * 0.12, -0.05, 0.175, 1, 0.7, 0.3); };
  cheek(-1); cheek(1);
  if (!linda) ball(0.19, stubble, 0, -0.03, 0.02).geometry = new THREE.SphereGeometry(0.19, 16, 10, 0, Math.PI * 2, Math.PI * 0.62, Math.PI * 0.38);
  // the grin: a wide curved slot with a row of big square teeth
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.05, 0.02), gum);
  mouth.position.set(0, -0.105, 0.172);
  for (let i = -3; i <= 3; i++) {
    const t = box(0.022, 0.03, 0.012, i * 0.023, 0.006 + Math.abs(i) * 0.002, 0.012, tooth);
    t.rotation.y = i * 0.08;
    mouth.add(t);
  }
  head.add(mouth);
  const lipU = new THREE.Mesh(new THREE.CapsuleGeometry(0.014, 0.16, 4, 8), lipCol);
  lipU.rotation.z = Math.PI / 2;
  lipU.position.set(0, -0.076, 0.178);
  head.add(lipU);
  const lipL = lipU.clone();
  lipL.position.y = -0.134;
  lipL.scale.set(1, 0.85, 1);
  head.add(lipL);
  return { brows, mouth };
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

/** Shared henchman materials (each one adds his own shirt and hat). Built on y = 0, facing +z. */
export function henchKit(): Record<"jeans" | "shoe" | "skin" | "stick" | "eyes" | "stubble" | "iron" | "shade" | "dark", THREE.Material> {
  return {
    jeans: new THREE.MeshStandardMaterial({ color: 0x5a5236, roughness: 0.9 }),
    shoe: new THREE.MeshStandardMaterial({ color: 0x3a2a1e, roughness: 0.8 }),
    skin: new THREE.MeshStandardMaterial({ color: 0xd99a74, roughness: 0.7 }),
    stick: new THREE.MeshStandardMaterial({ color: 0x8a6234, roughness: 0.9 }),
    eyes: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    stubble: new THREE.MeshStandardMaterial({ color: 0x4a3426, roughness: 1 }),
    iron: new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.35, metalness: 0.9 }),
    shade: new THREE.MeshStandardMaterial({ color: 0x101014, roughness: 0.15, metalness: 0.6 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8 }),
  };
}

const SHIRTS = [0xe8e0c8, 0xd2542a, 0x3a8a5a, 0xe0b830, 0x6a4aa0, 0x2a7ab8, 0xc23a5a, 0x8a8a8a];

/** One of his junkyard pals. Each of the eight has his own ridiculous hat and his own stick. */
export function buildHench(m: ReturnType<typeof henchKit>, n = 0): Hench {
  const root = new THREE.Group();
  const mat = (c: number, r = 0.8): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color: c, roughness: r });
  const shirt = mat(SHIRTS[n % SHIRTS.length], 0.9);
  const leg = (sx: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(sx * 0.11, 0.82, 0);
    g.add(box(0.19, 0.5, 0.21, 0, -0.25, 0, m.jeans)); // cargo shorts
    g.add(box(0.13, 0.28, 0.13, 0, -0.62, 0, m.skin)); // hairy shins
    g.add(box(0.19, 0.1, 0.3, 0, -0.77, 0.05, m.shoe));
    root.add(g);
    return g;
  };
  const legL = leg(1);
  const legR = leg(-1);
  // a stained vest top over a little belly
  root.add(box(0.42, 0.6, 0.26, 0, 1.17, 0, shirt));
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), shirt);
  belly.scale.set(1, 0.9, 0.75);
  belly.position.set(0, 1.05, 0.1);
  root.add(belly);
  const stain = new THREE.Mesh(new THREE.CircleGeometry(0.06, 10), mat(0x6a5030));
  stain.position.set(0.08, 1.12, 0.255);
  root.add(stain);
  const arm = (sx: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(sx * 0.27, 1.42, 0);
    g.add(box(0.12, 0.58, 0.13, 0, -0.29, 0, m.skin));
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), m.skin);
    hand.position.y = -0.62;
    g.add(hand);
    root.add(g);
    return g;
  };
  const armL = arm(1);
  const armR = arm(-1);

  // the stick, with things sticking out of it
  const weapon = new THREE.Group();
  weapon.position.set(0, -0.62, 0.38);
  weapon.rotation.x = Math.PI / 2 - 0.3;
  armR.add(weapon);
  const kind = n % 3;
  if (kind === 0) {
    // a two-by-four full of nails
    weapon.add(box(0.07, 1.0, 0.1, 0, 0, 0, m.stick));
    for (let i = 0; i < 6; i++) {
      const nail = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.16, 4), m.iron);
      nail.rotation.z = Math.PI / 2;
      nail.position.set((i % 2 ? 1 : -1) * 0.07, 0.15 + i * 0.06, (i % 3 - 1) * 0.03);
      weapon.add(nail);
    }
  } else if (kind === 1) {
    // a crooked branch, twigs and all
    weapon.add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 1.0, 7), m.stick));
    for (const [y, a, l] of [[0.2, 0.8, 0.25], [0.32, -0.9, 0.2], [0.42, 0.6, 0.18], [0.05, -0.7, 0.15]]) {
      const twig = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.018, l, 5), m.stick);
      twig.position.set(Math.sin(a) * l * 0.5, y, 0);
      twig.rotation.z = -a;
      weapon.add(twig);
    }
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 4), mat(0x5a8a2a));
    leaf.scale.set(1, 0.4, 1);
    leaf.position.set(0.1, 0.5, 0);
    weapon.add(leaf);
  } else {
    // a bent pipe wrapped in tape, a bike chain looped round the end
    weapon.add(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.95, 8), m.iron));
    const tape = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.22, 8), mat(0xd8c020));
    tape.position.y = -0.32;
    weapon.add(tape);
    for (let i = 0; i < 5; i++) {
      const link = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.009, 4, 8), m.dark);
      link.position.set(0.05, 0.42 - i * 0.05, (i % 2) * 0.02);
      link.rotation.y = i % 2 ? Math.PI / 2 : 0;
      weapon.add(link);
    }
  }

  // a face: stubble, a big goofy grin, one of them in shades
  root.add(box(0.14, 0.1, 0.14, 0, 1.5, 0, m.skin));
  const head = new THREE.Group();
  head.position.y = 1.66;
  root.add(head);
  head.add(new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 10), m.skin));
  const jaw = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 8, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.45), m.stubble);
  jaw.position.set(0, -0.01, 0.015);
  head.add(jaw);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), mat(0xe07a5a));
  nose.position.set(0, -0.01, 0.16);
  head.add(nose);
  head.add(box(0.12, 0.03, 0.03, 0, -0.07, 0.145, mat(0x3a0e0e)));
  const tooth = box(0.03, 0.025, 0.02, 0.025, -0.06, 0.16, m.eyes);
  head.add(tooth);
  if (n % 2 === 0) {
    head.add(box(0.26, 0.06, 0.03, 0, 0.035, 0.15, m.shade)); // sunglasses
  } else {
    for (const sx of [-1, 1]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 4), m.eyes);
      e.position.set(sx * 0.055, 0.04, 0.14);
      head.add(e);
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.014, 5, 4), m.dark);
      p.position.set(sx * 0.055 + 0.01 * sx, 0.04, 0.168);
      head.add(p);
    }
  }

  // and the hat, the whole point
  const hat = new THREE.Group();
  hat.position.y = 0.1;
  head.add(hat);
  const style = THEME.thanksgiving ? (n % 2 ? 8 : 9) : n % 8;
  if (style === 0) {
    // ten-gallon cowboy hat, far too big
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.03, 18), mat(0xc8964a));
    brim.scale.set(1, 1, 0.8);
    hat.add(brim);
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.18, 0.3, 14), mat(0xc8964a));
    crown.position.y = 0.15;
    hat.add(crown);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.185, 0.185, 0.05, 14), mat(0x3a1e10));
    band.position.y = 0.04;
    hat.add(band);
  } else if (style === 1) {
    // a giant top hat with a feather
    hat.add(new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.03, 16), m.dark));
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.14, 0.55, 14), m.dark);
    t.position.y = 0.28;
    hat.add(t);
    const f = box(0.03, 0.4, 0.08, 0.14, 0.45, 0, mat(0xff3a8a));
    f.rotation.z = -0.4;
    hat.add(f);
  } else if (style === 2) {
    // a traffic cone
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.5, 14), mat(0xff6a1a, 0.6));
    cone.position.y = 0.2;
    hat.add(cone);
    const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.08, 14), mat(0xffffff, 0.6));
    stripe.position.y = 0.22;
    hat.add(stripe);
  } else if (style === 3) {
    // a propeller beanie, propeller spinning in the breeze
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), mat(0x2a7ad8));
    hat.add(cap);
    const prop = box(0.38, 0.015, 0.05, 0, 0.2, 0, mat(0xffd020));
    prop.rotation.y = 0.6;
    hat.add(prop);
    hat.add(box(0.02, 0.06, 0.02, 0, 0.17, 0, mat(0xd8261a)));
  } else if (style === 4) {
    // horns, like a viking who shops at a gas station
    const lid = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), m.iron);
    hat.add(lid);
    for (const sx of [-1, 1]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.26, 8), mat(0xf0e6c8));
      horn.position.set(sx * 0.19, 0.1, 0);
      horn.rotation.z = -sx * 0.9;
      hat.add(horn);
    }
  } else if (style === 5) {
    // an enormous sombrero
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.6, 0.04, 20), mat(0xe0c060));
    hat.add(brim);
    const crown = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.4, 14), mat(0xe0c060));
    crown.position.y = 0.2;
    hat.add(crown);
    const trim = new THREE.Mesh(new THREE.TorusGeometry(0.57, 0.02, 4, 24), mat(0xd8261a));
    trim.rotation.x = Math.PI / 2;
    hat.add(trim);
  } else if (style === 6) {
    // a hard hat with a flashing light on top
    const hh = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xffd020, 0.5));
    hat.add(hh);
    hat.add(box(0.4, 0.02, 0.3, 0, 0, 0.06, mat(0xffd020, 0.5)));
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff3a1a }));
    beacon.position.y = 0.2;
    hat.add(beacon);
  } else if (style === 8) {
    // a whole roast turkey, worn as a hat, legs in the air
    const roast = mat(0xb8642a, 0.5);
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 10), roast);
    body.scale.set(1.1, 0.75, 1.25);
    body.position.y = 0.1;
    hat.add(body);
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.2, 8), roast);
      leg.position.set(sx * 0.1, 0.26, 0.14);
      leg.rotation.x = -0.6;
      hat.add(leg);
      const frill = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), mat(0xffffff));
      frill.position.set(sx * 0.1, 0.35, 0.2);
      hat.add(frill);
    }
  } else if (style === 9) {
    // a tall pilgrim hat with a gold buckle
    const blk = mat(0x141414);
    hat.add(new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.03, 16), blk));
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.17, 0.42, 14), blk);
    t.position.y = 0.21;
    hat.add(t);
    hat.add(box(0.14, 0.09, 0.02, 0, 0.08, 0.17, new THREE.MeshStandardMaterial({ color: 0xffc83a, roughness: 0.3, metalness: 0.8 })));
  } else {
    // a crown off a burger box, gold and slightly bent
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.12, 14, 1, true), new THREE.MeshStandardMaterial({ color: 0xffc020, roughness: 0.3, metalness: 0.7, side: THREE.DoubleSide }));
    ring.position.y = 0.06;
    ring.rotation.z = 0.12;
    hat.add(ring);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const pt = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.1, 4), new THREE.MeshStandardMaterial({ color: 0xffc020, roughness: 0.3, metalness: 0.7 }));
      pt.position.set(Math.cos(a) * 0.16, 0.17, Math.sin(a) * 0.16);
      hat.add(pt);
    }
  }
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
  wheels: THREE.Object3D[];
  paint: THREE.MeshStandardMaterial;
  len: number;
  wid: number;
  tall: number;
  lamps: THREE.Vector3[];
  /** his driver's door, in the vehicle's own frame */
  door: THREE.Vector3;
  /** moving parts beyond the wheels (the train's side rods), given the wheel angle */
  anim: ((wheelAngle: number) => void) | null;
  /** the top of a smokestack, if this ride has one, in the vehicle's own frame */
  stack: THREE.Vector3 | null;
  /** where henchmen climb out, in the vehicle's own frame */
  hatch: THREE.Vector3;
}

export const RIDES = [
  { kind: "wagon", name: "the station wagon", color: 0x8a5a2b, len: 4.8, wid: 1.9, tall: 1.75, hp: 4 },
  { kind: "tow", name: "the tow truck", color: 0xd6a42a, len: 5.6, wid: 2.1, tall: 2.0, hp: 6 },
  { kind: "monster", name: "the monster pickup", color: 0xb52a22, len: 5.4, wid: 2.5, tall: 2.6, hp: 8 },
  { kind: "cement", name: "the cement truck", color: 0xd8d6cf, len: 8.0, wid: 2.5, tall: 3.3, hp: 11 },
  { kind: "rig", name: "the 18-wheeler", color: 0x3c4552, len: 12.0, wid: 2.5, tall: 3.2, hp: 14 },
  { kind: "train", name: "the locomotive", color: 0x1c1d20, len: 10.0, wid: 2.6, tall: 3.6, hp: 18 },
] as const;
export type RideKind = (typeof RIDES)[number]["kind"];
export const rideAt = (level: number) => RIDES[Math.min(level - 1, RIDES.length - 1)];


/** Mort and whatever he is driving tonight. Built facing +z, so his grille faces you. */
export function buildFoe(level: number, linda = false): Foe {
  const spec = rideAt(level);
  const kind: RideKind = spec.kind;
  const { len, wid, tall } = spec;
  const lift = kind === "monster" ? 0.7 : 0;
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  // Linda drives the same rides in her own colours
  const LINDA = [0x6a3d8f, 0x2f8f6a, 0xd2449a, 0x8fd4e0, 0x7a2fa8, 0x3a1f4a];
  const paint = new THREE.MeshStandardMaterial({ color: linda ? LINDA[RIDES.indexOf(spec)] : spec.color, roughness: 0.55, metalness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.85 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xbfc3c8, roughness: 0.3, metalness: 0.9 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1a2630, roughness: 0.15, metalness: 0.4, transparent: true, opacity: 0.45 });
  const tyreM = new THREE.MeshStandardMaterial({ color: 0x0e0e0e, roughness: 0.95 });
  const lamp = new THREE.MeshBasicMaterial({ color: 0xfff4d6 });

  const lower = tall * 0.45;
  const base = 0.35 + lift;
  body.add(box(wid, lower, len, 0, base + lower / 2, 0, paint));
  const cabLen = kind === "wagon" ? len * 0.62 : Math.min(2.2, len * 0.38);
  const cabZ = kind === "wagon" ? -0.1 : len / 2 - cabLen / 2 - 0.9;
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
  const train = kind === "train";
  if (!train) {
    body.add(box(wid * 0.9, 0.5, 0.08, 0, base + lower * 0.55, len / 2 + 0.02, chrome));
    for (const sx of [-0.35, 0.35]) body.add(box(0.09, lower * 1.05, 0.09, sx * wid, base + lower * 0.5, len / 2 + 0.32, chrome));
    body.add(box(wid * 0.85, 0.1, 0.1, 0, base + lower * 0.95, len / 2 + 0.32, chrome));
    body.add(box(wid * 0.85, 0.1, 0.1, 0, base + lower * 0.3, len / 2 + 0.32, chrome));
  }
  if (kind === "tow") {
    const boom = box(0.25, 0.25, 2.4, 0, base + lower + 0.9, -len / 2 + 1.1, dark);
    boom.rotation.x = 0.35;
    body.add(boom);
    body.add(box(wid * 0.6, 0.18, 0.4, 0, base + lower + 0.1 + cabH, cabZ, new THREE.MeshBasicMaterial({ color: 0xff9a1a })));
  }
  if (kind === "rig") {
    // the trailer: a long box van, taller than the cab, behind a gap
    const tLen = len - cabLen - 2.2;
    body.add(box(wid, tall + 0.6 - base, tLen, 0, base + (tall + 0.6 - base) / 2 + 0.25, -len / 2 + tLen / 2, new THREE.MeshStandardMaterial({ color: linda ? 0xe8d8f0 : 0xe6e6e2, roughness: 0.7 })));
    for (const sx of [-1, 1]) body.add(box(0.03, 0.35, tLen - 0.4, sx * (wid / 2 + 0.01), base + 1.4, -len / 2 + tLen / 2, paint));
  }
  if (kind === "rig") {
    for (const sx of [-1, 1]) {
      const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 2.2, 10), chrome);
      stack.position.set(sx * (wid / 2 + 0.05), base + lower + 1.0, cabZ - cabLen / 2 - 0.1);
      body.add(stack);
    }
  }
  let anim: Foe["anim"] = null;
  let stack: THREE.Vector3 | null = null;
  const red = new THREE.MeshStandardMaterial({ color: 0xc0281e, roughness: 0.5, metalness: 0.3, emissive: 0x4a0a06 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xc8963a, roughness: 0.35, metalness: 0.85 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x8d939a, roughness: 0.35, metalness: 0.9 });
  if (kind === "cement") {
    const rear = len - cabLen - 1.2;
    const drum = new THREE.Group();
    drum.position.set(0, base + lower + 0.95, -len / 2 + rear / 2 + 0.2);
    drum.rotation.x = -0.12;
    body.add(drum);
    const geo = new THREE.CylinderGeometry(0.75, 1.15, rear, 20, 1);
    geo.rotateX(Math.PI / 2);
    const stripes = canvasTex(64, 256, (c) => {
      for (let i = 0; i < 8; i++) { c.fillStyle = i % 2 ? "#e8e4da" : linda ? "#8a3ad8" : "#d8622a"; c.fillRect(0, i * 32, 64, 32); }
    });
    stripes.wrapS = THREE.RepeatWrapping;
    drum.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: stripes, roughness: 0.6, metalness: 0.2 })));
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.75, 0.5, 16), dark);
    cap.rotation.x = -Math.PI / 2;
    cap.position.z = -rear / 2 - 0.2;
    drum.add(cap);
    for (const sx of [-1, 1]) body.add(box(0.15, 0.9, 0.3, sx * 0.8, base + lower + 0.35, -len / 2 + 0.8, dark));
    body.add(box(0.5, 0.4, 0.9, 0, base + lower + 0.3, -len / 2 - 0.1, dark)); // the chute
    anim = (a) => { drum.rotation.z = a * 0.25; };
  }
  if (train) {
    // A steam locomotive driven cab first (the old cab-forward kind), so Mort is
    // still at the front glaring at you, with the boiler running back behind him.
    const boilR = 0.95;
    const boilFront = cabZ - cabLen / 2;
    const boilBack = -len / 2 + 0.4;
    const boilLen = boilFront - boilBack;
    const boilY = base + lower + boilR * 0.9;
    const bg = new THREE.CylinderGeometry(boilR, boilR, boilLen, 22);
    bg.rotateX(Math.PI / 2);
    const boiler = new THREE.Mesh(bg, paint);
    boiler.position.set(0, boilY, boilBack + boilLen / 2);
    body.add(boiler);
    for (let i = 0; i < 4; i++) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(boilR + 0.02, 0.04, 6, 24), brass);
      band.position.set(0, boilY, boilBack + 0.3 + (i * (boilLen - 0.6)) / 3);
      body.add(band);
    }
    const smoke = new THREE.Mesh(new THREE.CylinderGeometry(boilR + 0.05, boilR + 0.05, 0.3, 22), dark);
    smoke.rotation.x = Math.PI / 2;
    smoke.position.set(0, boilY, boilBack);
    body.add(smoke);
    // the stack right behind the cab, tall enough to stand over its roof, flared at the top
    const stZ = boilFront - 0.9;
    const stY = boilY + boilR;
    const st = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.24, 1.5, 16), dark);
    st.position.set(0, stY + 0.75, stZ);
    body.add(st);
    const flare = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.32, 0.45, 16), dark);
    flare.position.set(0, stY + 1.7, stZ);
    body.add(flare);
    const lip = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.05, 6, 20), brass);
    lip.rotation.x = Math.PI / 2;
    lip.position.set(0, stY + 1.92, stZ);
    body.add(lip);
    stack = new THREE.Vector3(0, stY + 2.0, stZ);
    // steam dome and bell
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), brass);
    dome.position.set(0, stY - 0.05, boilBack + boilLen * 0.45);
    body.add(dome);
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.26, 0.4, 14, 1, true), brass);
    bell.position.set(0, stY + 0.2, boilBack + boilLen * 0.2);
    body.add(bell);
    // a big round headlamp on the cab roof
    const hl = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.55, 18), dark);
    hl.rotation.x = Math.PI / 2;
    hl.position.set(0, cabY + cabH / 2 + 0.35, cabZ + cabLen / 2 - 0.25);
    body.add(hl);
    const hlFace = new THREE.Mesh(new THREE.CircleGeometry(0.28, 20), lamp);
    hlFace.position.set(0, cabY + cabH / 2 + 0.35, cabZ + cabLen / 2 + 0.03);
    body.add(hlFace);
    // a red stripe down each side, and a red buffer beam across the front
    for (const sx of [-1, 1]) body.add(box(0.04, 0.22, len - 0.4, sx * (wid / 2 + 0.02), base + lower * 0.7, 0, red));
    body.add(box(wid, 0.4, 0.25, 0, base + 0.15, len / 2 + 0.05, red));
    // the cowcatcher: slats raked forward to a point at road level
    for (let i = 0; i < 9; i++) {
      const x = (i / 8 - 0.5) * (wid - 0.2);
      const reach = (1 - Math.abs(x) / (wid / 2)) * 1.0 + 0.2;
      const slat = box(0.08, 0.06, Math.hypot(reach, 0.75), x, 0, 0, red);
      slat.position.set(x, base - 0.05, len / 2 + 0.15 + reach / 2);
      slat.rotation.x = Math.atan2(0.75, reach);
      body.add(slat);
    }
    body.add(box(wid - 0.1, 0.08, 0.1, 0, base + 0.3, len / 2 + 0.2, red));
    
  }
  const lamps: THREE.Vector3[] = [];
  for (const sx of [-1, 1]) {
    const l = new THREE.Mesh(new THREE.CircleGeometry(0.2, 18), lamp);
    const p = new THREE.Vector3(sx * wid * 0.33, base + lower * 0.62, len / 2 + 0.07);
    l.position.copy(p);
    body.add(l);
    lamps.push(p);
  }
  const wheels: THREE.Object3D[] = [];
  if (train) {
    // Real driving wheels: red, spoked, three a side, coupled by side rods. On the road.
    const R0 = 1.0;
    const crank = 0.36;
    const zs = [len * 0.24, len * 0.06, -len * 0.12];
    const rods: THREE.Mesh[] = [];
    const rodRest: THREE.Vector3[] = [];
    for (const sx of [-1, 1]) {
      const x = sx * (wid / 2 + 0.12);
      for (const z of zs) {
        const w = new THREE.Group();
        w.position.set(x, R0, z);
        const tyre = new THREE.Mesh(new THREE.TorusGeometry(R0 - 0.06, 0.08, 8, 28), steel);
        tyre.rotation.y = Math.PI / 2;
        w.add(tyre);
        const rim = new THREE.Mesh(new THREE.TorusGeometry(R0 - 0.16, 0.05, 6, 24), red);
        rim.rotation.y = Math.PI / 2;
        w.add(rim);
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.24, 12), red);
        hub.rotation.z = Math.PI / 2;
        w.add(hub);
        for (let k = 0; k < 10; k++) {
          const sp = box(0.06, R0 * 1.62, 0.07, 0, 0, 0, red);
          sp.rotation.x = (k / 10) * Math.PI;
          w.add(sp);
        }
        // a counterweight opposite the crank, as real ones have
        const cw = box(0.1, 0.22, 0.5, 0, -R0 * 0.5, 0, red);
        w.add(cw);
        const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.2, 8), steel);
        pin.rotation.z = Math.PI / 2;
        pin.position.set(sx * 0.12, crank, 0);
        w.add(pin);
        root.add(w);
        wheels.push(w);
      }
      const span = zs[0] - zs[2];
      const rod = box(0.07, 0.14, span + 0.35, 0, 0, 0, steel);
      const rest = new THREE.Vector3(x + sx * 0.2, R0, (zs[0] + zs[2]) / 2);
      rod.position.copy(rest);
      root.add(rod);
      rods.push(rod);
      rodRest.push(rest);
    }
    // a little leading wheel each side, under the cowcatcher end
    for (const sx of [-1, 1]) {
      const w = wheel(0.42, 0.22, tyreM);
      w.position.set(sx * (wid / 2 - 0.3), 0.42, len * 0.36);
      root.add(w);
      wheels.push(w);
    }
    anim = (a) => {
      for (let i = 0; i < rods.length; i++) {
        rods[i].position.set(rodRest[i].x, rodRest[i].y + crank * Math.cos(a), rodRest[i].z + crank * Math.sin(a));
      }
    };
  }
  const r = kind === "monster" ? 0.95 : 0.42 + tall * 0.06;
  // eighteen for the 18-wheeler: a steer axle, then four axles of duals
  const axles = kind === "rig" ? [len / 2 - 1.3, len / 2 - 3.2, len / 2 - 4.4, -len / 2 + 2.4, -len / 2 + 1.2] : [len * 0.32, -len * 0.32];
  if (!train) for (const sx of [-1, 1]) for (const [ai, sz] of axles.entries()) for (const dual of kind === "rig" && ai > 0 ? [0, 1] : [0]) {
    const w = wheel(r, kind === "monster" ? 0.6 : 0.3, tyreM);
    w.position.set(sx * (wid / 2 - (kind === "monster" ? -0.1 : 0.05) - dual * 0.34), r, sz);
    root.add(w);
    wheels.push(w);
  }

  // Mort, sitting on the driver's side (+x when facing +z): hips on the seat,
  // legs folded out of sight under the dash, upper body scaled to the cab.
  const mort = buildMort(linda);
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
  return { root, body, mort, wheels, paint, len, wid, tall: tall + lift, lamps, door, anim, stack, hatch };
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
