/**
 * Cannon Run: the game.
 *
 * You are in the bed of a pickup doing a hundred and ten down a desert highway
 * at night, sitting behind an old ship's cannon, and the camera looks back
 * over the tailgate at the man who wants his cannon back. His headlights are
 * the brightest thing on the road.
 *
 * Everything lives in road coordinates: `s` is metres along the highway, `lat`
 * is metres right of the centre line (right of the direction of travel), `y`
 * is height. The player, the pursuer, the traffic, every cannonball and every
 * tyre he throws are simulated there, and only drawn in world space. That is
 * what makes a ballistic cannon on a curving road cheap and exact: a ball
 * keeps the forward speed of the truck that fired it, and nothing has to
 * reason about curves.
 *
 * World mapping: the road runs toward -z. A model built facing +z needs only
 * `rotation.y = heading(s)`, where forward is (sin h, cos h) and the right of
 * forward is (-cos h, sin h), the same convention Fog City uses.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export interface ChaseHud {
  phase: "intro" | "play" | "over";
  hull: number;
  score: number;
  best: number;
  meters: number;
  boost: number;
  reload: number;
  level: number;
  ride: string;
  foeHp: number;
  foeMax: number;
  foeWrecked: boolean;
  gap: number;
  hits: number;
  wrecks: number;
  toast: string;
  fps: number;
}

export interface CannonRun {
  dispose(): void;
  /** Phone stick, x right on screen, -1..1. */
  setStick(x: number, y: number): void;
  /** Aim at a point on screen (client pixels) and, optionally, fire. */
  aimAt(clientX: number, clientY: number, fire: boolean): void;
  hold(action: "boost", down: boolean): void;
  restart(): void;
  setMuted(m: boolean): void;
}

interface Opts {
  onHud?: (h: ChaseHud) => void;
  onReady?: () => void;
}

/* ---------------------------------------------------------------- the road */

const HALF = 7.4; // asphalt half width
const LANE = 3.6;
const LAT_MAX = 5.4;
const G = 9.8;
const MUZZLE = 46;
const RELOAD = 0.85;

export const roadX = (s: number): number =>
  38 * Math.sin(s / 310) + 14 * Math.sin(s / 113 + 1.3) + 5 * Math.sin(s / 47 + 0.4);
const roadDX = (s: number): number =>
  (38 / 310) * Math.cos(s / 310) + (14 / 113) * Math.cos(s / 113 + 1.3) + (5 / 47) * Math.cos(s / 47 + 0.4);
export const heading = (s: number): number => Math.atan2(roadDX(s), -1);

const V = new THREE.Vector3();
function toWorld(s: number, lat: number, y: number, out: THREE.Vector3 = V): THREE.Vector3 {
  const d = roadDX(s);
  const inv = 1 / Math.hypot(d, 1);
  // tangent (d, -1)*inv, right of it (1, d)*inv
  return out.set(roadX(s) + lat * inv, y, -s + lat * d * inv);
}
/** World (x, z) back to road (s, lat). Two Newton steps is plenty on these curves. */
function toRoad(x: number, z: number): { s: number; lat: number } {
  let s = -z;
  let lat = 0;
  for (let k = 0; k < 3; k++) {
    const d = roadDX(s);
    const inv = 1 / Math.hypot(d, 1);
    const px = x - roadX(s);
    const pz = z + s;
    const along = (px * d - pz) * inv;
    lat = (px + pz * d) * inv;
    s += along;
  }
  return { s, lat };
}

const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const hash = (n: number): number => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/* ---------------------------------------------------------------- textures */

function canvasTex(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function roadTexture(): THREE.CanvasTexture {
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

function sandTexture(): THREE.CanvasTexture {
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

function glowTexture(): THREE.CanvasTexture {
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

function puffTexture(): THREE.CanvasTexture {
  return canvasTex(64, 64, (c) => {
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,0.9)");
    g.addColorStop(0.6, "rgba(255,255,255,0.35)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = g;
    c.fillRect(0, 0, 64, 64);
  });
}

function plateTexture(text: string): THREE.CanvasTexture {
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
function box(w: number, h: number, d: number, x: number, y: number, z: number, m: Mat): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  return mesh;
}
function wheel(r: number, w: number, m: Mat): THREE.Mesh {
  const g = new THREE.CylinderGeometry(r, r, w, 16);
  g.rotateZ(Math.PI / 2);
  return new THREE.Mesh(g, m);
}

interface Truck {
  root: THREE.Group;
  yaw: THREE.Group;
  pitch: THREE.Group;
  barrel: THREE.Group;
  wheels: THREE.Mesh[];
  tail: THREE.MeshBasicMaterial;
}

/** The player's pickup. Built facing +z; the camera sits over the front of the bed. */
function buildTruck(): Truck {
  const root = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0x2f6d8c, roughness: 0.45, metalness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x151618, roughness: 0.8 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc9ccd1, roughness: 0.25, metalness: 0.9 });
  const tyre = new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 0.95 });
  const bedFloor = new THREE.MeshStandardMaterial({ color: 0x4a3a2b, roughness: 0.9 });
  const tail = new THREE.MeshBasicMaterial({ color: 0xff2a1a });

  // cab (mostly out of view, but it casts the silhouette at the bottom edge)
  root.add(box(1.96, 0.75, 1.9, 0, 0.95, 1.05, paint));
  root.add(box(1.82, 0.62, 1.4, 0, 1.62, 0.85, paint));
  root.add(box(1.7, 0.42, 0.06, 0, 1.6, 0.13, new THREE.MeshStandardMaterial({ color: 0x0c1218, roughness: 0.1, metalness: 0.6 })));
  // bed
  root.add(box(1.96, 0.18, 2.7, 0, 0.62, -1.25, bedFloor));
  root.add(box(0.12, 0.55, 2.7, 0.92, 0.98, -1.25, paint));
  root.add(box(0.12, 0.55, 2.7, -0.92, 0.98, -1.25, paint));
  root.add(box(1.96, 0.5, 0.1, 0, 0.96, -2.58, paint)); // tailgate
  root.add(box(1.96, 0.09, 0.14, 0, 1.25, -2.58, chrome));
  root.add(box(2.02, 0.2, 0.22, 0, 0.5, -2.7, chrome)); // bumper
  root.add(box(1.98, 0.35, 4.7, 0, 0.42, -0.2, dark)); // chassis skirt
  // tail lights
  for (const sx of [-1, 1]) {
    root.add(box(0.2, 0.36, 0.06, sx * 0.86, 1.0, -2.64, tail));
  }
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.26), new THREE.MeshBasicMaterial({ map: plateTexture("ARRR") }));
  plate.position.set(0, 0.84, -2.64);
  plate.rotation.y = Math.PI;
  root.add(plate);
  // exhaust
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

  // The cannon: an oak carriage bolted to the bed, an iron barrel with bronze bands.
  const oak = new THREE.MeshStandardMaterial({ color: 0x6b4428, roughness: 0.85 });
  const iron = new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.6, metalness: 0.55 });
  const bronze = new THREE.MeshStandardMaterial({ color: 0xb4823a, roughness: 0.35, metalness: 0.85 });
  const carriage = new THREE.Group();
  carriage.position.set(0, 0.71, -1.15);
  root.add(carriage);
  carriage.add(box(1.0, 0.22, 1.3, 0, 0.11, 0, oak));
  for (const sx of [-1, 1]) {
    const cheek = box(0.12, 0.42, 1.1, sx * 0.4, 0.42, 0.05, oak);
    carriage.add(cheek);
    for (const sz of [-0.42, 0.42]) {
      const tw = wheel(0.2, 0.1, oak);
      tw.position.set(sx * 0.55, 0.12, sz);
      carriage.add(tw);
    }
  }
  const yaw = new THREE.Group();
  yaw.position.set(0, 0.58, 0.1);
  carriage.add(yaw);
  const pitch = new THREE.Group();
  yaw.add(pitch);
  const barrel = new THREE.Group();
  pitch.add(barrel);
  // barrel points to -z (out over the tailgate)
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
  // a powder keg and a little pile of shot
  const keg = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.42, 14), oak);
  keg.position.set(0.62, 0.92, -0.35);
  root.add(keg);
  const shot = new THREE.SphereGeometry(0.1, 10, 8);
  for (let k = 0; k < 5; k++) {
    const b = new THREE.Mesh(shot, iron);
    b.position.set(-0.6 + (k % 3) * 0.16 + (k > 2 ? 0.08 : 0), 0.8 + (k > 2 ? 0.13 : 0), -0.45 + (k > 2 ? 0.05 : 0));
    root.add(b);
  }
  return { root, yaw, pitch, barrel, wheels, tail };
}

interface Foe {
  root: THREE.Group;
  body: THREE.Group;
  arm: THREE.Group;
  head: THREE.Group;
  brows: THREE.Mesh[];
  wheels: THREE.Mesh[];
  paint: THREE.MeshStandardMaterial;
  len: number;
  wid: number;
  tall: number;
  lamps: THREE.Vector3[];
}

const RIDES = [
  { name: "the station wagon", color: 0x8a5a2b, len: 4.8, wid: 1.9, tall: 1.5, hp: 4 },
  { name: "the tow truck", color: 0xd6a42a, len: 5.6, wid: 2.1, tall: 1.9, hp: 6 },
  { name: "the monster pickup", color: 0xb52a22, len: 5.4, wid: 2.5, tall: 2.6, hp: 8 },
  { name: "the big rig", color: 0x3c4552, len: 7.0, wid: 2.5, tall: 3.2, hp: 11 },
];

/** Mad Mort and whatever he is driving tonight. Built facing +z, so his grille faces us. */
function buildFoe(level: number): Foe {
  const spec = RIDES[Math.min(level - 1, RIDES.length - 1)];
  const { len, wid, tall } = spec;
  const lift = level === 3 ? 0.7 : 0;
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const paint = new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.55, metalness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.85 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xbfc3c8, roughness: 0.3, metalness: 0.9 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1a2630, roughness: 0.15, metalness: 0.4, transparent: true, opacity: 0.55 });
  const tyreM = new THREE.MeshStandardMaterial({ color: 0x0e0e0e, roughness: 0.95 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xe07a5a, roughness: 0.7, emissive: 0x5a1a08 });
  const lamp = new THREE.MeshBasicMaterial({ color: 0xfff4d6 });

  const lower = tall * 0.45;
  const base = 0.35 + lift;
  body.add(box(wid, lower, len, 0, base + lower / 2, 0, paint));
  // cab sits toward the front (+z) for trucks, middle for the wagon
  const cabLen = level === 1 ? len * 0.62 : Math.min(2.2, len * 0.38);
  const cabZ = level === 1 ? -0.1 : len / 2 - cabLen / 2 - 0.9;
  const cabH = tall * 0.5;
  const cabY = base + lower + cabH / 2;
  // A shell, not a block, so you can see him through the windshield.
  const cw = wid * 0.92;
  body.add(box(cw, 0.1, cabLen, 0, cabY + cabH / 2 - 0.05, cabZ, paint)); // roof
  body.add(box(cw, cabH, 0.08, 0, cabY, cabZ - cabLen / 2 + 0.04, paint)); // back wall
  for (const sx of [-1, 1]) {
    body.add(box(0.08, cabH * 0.35, cabLen, sx * (cw / 2 - 0.04), cabY - cabH * 0.32, cabZ, paint)); // door below the window
    body.add(box(0.1, cabH, 0.1, sx * (cw / 2 - 0.05), cabY, cabZ + cabLen / 2 - 0.05, paint)); // A pillar
  }
  body.add(box(cw * 0.95, 0.2, 0.5, 0, cabY - cabH / 2 + 0.25, cabZ + cabLen / 2 - 0.3, dark)); // dashboard
  // windshield faces +z
  const shield = box(wid * 0.84, cabH * 0.78, 0.05, 0, cabY + 0.02, cabZ + cabLen / 2 + 0.01, glass);
  body.add(shield);
  // hood and grille
  body.add(box(wid * 0.9, 0.5, 0.08, 0, base + lower * 0.55, len / 2 + 0.02, chrome));
  // bull bar
  for (const sx of [-0.35, 0.35]) body.add(box(0.09, lower * 1.05, 0.09, sx * wid, base + lower * 0.5, len / 2 + 0.32, chrome));
  body.add(box(wid * 0.85, 0.1, 0.1, 0, base + lower * 0.95, len / 2 + 0.32, chrome));
  body.add(box(wid * 0.85, 0.1, 0.1, 0, base + lower * 0.3, len / 2 + 0.32, chrome));
  if (level === 2) {
    // the tow boom, behind the cab
    const boom = box(0.25, 0.25, 2.4, 0, base + lower + 0.9, -len / 2 + 1.1, dark);
    boom.rotation.x = 0.35;
    body.add(boom);
    body.add(box(wid * 0.6, 0.18, 0.4, 0, base + lower + 0.1 + cabH, cabZ, new THREE.MeshBasicMaterial({ color: 0xff9a1a })));
  }
  if (level >= 4) {
    // twin stacks and a trailer stub
    for (const sx of [-1, 1]) {
      const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 2.2, 10), chrome);
      stack.position.set(sx * (wid / 2 + 0.05), base + lower + 1.0, cabZ - cabLen / 2 - 0.1);
      body.add(stack);
    }
  }
  // headlights: two big round lamps, facing +z
  const lamps: THREE.Vector3[] = [];
  for (const sx of [-1, 1]) {
    const l = new THREE.Mesh(new THREE.CircleGeometry(0.2, 18), lamp);
    const p = new THREE.Vector3(sx * wid * 0.33, base + lower * 0.62, len / 2 + 0.07);
    l.position.copy(p);
    body.add(l);
    lamps.push(p);
  }
  // wheels
  const wheels: THREE.Mesh[] = [];
  const r = level === 3 ? 0.95 : 0.42 + tall * 0.06;
  for (const sx of [-1, 1]) for (const sz of [len * 0.32, -len * 0.32]) {
    const w = wheel(r, level === 3 ? 0.6 : 0.3, tyreM);
    w.position.set(sx * (wid / 2 - (level === 3 ? -0.1 : 0.05)), r, sz);
    root.add(w);
    wheels.push(w);
  }
  if (level === 3) body.position.y = 0;

  // Mort himself, on the driver's side (his left, which is +x when facing +z)
  const head = new THREE.Group();
  head.position.set(wid * 0.22, cabY + 0.05, cabZ + cabLen / 2 - 0.45);
  body.add(head);
  head.add(new THREE.Mesh(new THREE.SphereGeometry(0.26, 18, 14), skin));
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const black = new THREE.MeshBasicMaterial({ color: 0x0a0a0a });
  const brows: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), white);
    eye.position.set(sx * 0.09, 0.04, 0.22);
    head.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 6), black);
    pupil.position.set(sx * 0.09, 0.04, 0.275);
    head.add(pupil);
    const brow = box(0.14, 0.035, 0.04, sx * 0.09, 0.13, 0.25, black);
    brow.rotation.z = sx * 0.5;
    head.add(brow);
    brows.push(brow);
  }
  const mouth = box(0.16, 0.05, 0.04, 0, -0.1, 0.24, black);
  head.add(mouth);
  head.add(box(0.5, 0.1, 0.5, 0, 0.24, 0, new THREE.MeshStandardMaterial({ color: 0x2b3f2a }))); // cap brim
  head.add(box(0.36, 0.16, 0.36, 0, 0.3, -0.04, new THREE.MeshStandardMaterial({ color: 0x2b3f2a })));
  // his arm, out of the window, shaking a fist
  const arm = new THREE.Group();
  arm.position.set(wid / 2, cabY - 0.05, cabZ + cabLen / 2 - 0.5);
  body.add(arm);
  const sleeve = box(0.16, 0.6, 0.16, 0, 0.3, 0, new THREE.MeshStandardMaterial({ color: 0xd8d2c4 }));
  arm.add(sleeve);
  const fist = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), skin);
  fist.position.y = 0.66;
  arm.add(fist);
  arm.rotation.z = -0.5;

  return { root, body, arm, head, brows, wheels, paint, len, wid, tall: tall + lift, lamps };
}

function trafficGeometry(): THREE.BufferGeometry {
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
  add(1.85, 0.6, 4.3, 0, 0.65, 0, 1, 1, 1);
  add(1.6, 0.55, 2.2, 0, 1.2, -0.2, 0.12, 0.15, 0.2);
  add(0.4, 0.14, 0.05, 0.6, 0.75, 2.16, 4, 4, 3.4);
  add(0.4, 0.14, 0.05, -0.6, 0.75, 2.16, 4, 4, 3.4);
  add(0.42, 0.14, 0.05, 0.62, 0.78, -2.16, 3, 0.1, 0.08);
  add(0.42, 0.14, 0.05, -0.62, 0.78, -2.16, 3, 0.1, 0.08);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(0.26, 0.64, 0.64, sx * 0.88, 0.32, sz * 1.38, 0.05, 0.05, 0.05);
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return g;
}

/* ---------------------------------------------------------------- sim types */

interface Ball { s: number; lat: number; y: number; vs: number; vl: number; vy: number; age: number; bounces: number; mesh: THREE.Mesh; live: boolean; trail: number }
interface Thrown { s: number; lat: number; y: number; vs: number; vl: number; vy: number; age: number; spin: number; mesh: THREE.Mesh; live: boolean; targetLat: number; passed: boolean }
interface Traffic { s: number; lat: number; v: number; color: THREE.Color; flung: number; vy: number; y: number; spin: number; vl: number; live: boolean }
interface Puff { sprite: THREE.Sprite; mat: THREE.SpriteMaterial; s: number; lat: number; y: number; vs: number; vl: number; vy: number; age: number; life: number; size: number; grow: number; kind: "smoke" | "fire" | "spark" | "dust"; live: boolean }

const TAUNTS = [
  "GET BACK HERE!", "That's MY cannon!", "You scratched my paint!", "Nobody outruns Mort!",
  "PULL OVER!", "I've got all night, pal!", "That cannon was my grandpa's!", "I can see you laughing!",
  "Ten more miles of desert, buddy!", "I'm not even mad. I'm FURIOUS.",
];
const OUCH = ["OW!", "MY BUMPER!", "Lucky shot!", "That's coming out of your pocket!", "You'll pay for that!", "My radiator!"];
const COMEBACK = ["This isn't over!", "I've got a bigger truck!", "I'll be back with my cousin's rig!"];
const COMMENTS: Record<number, string> = {
  2: "He's back. In a tow truck.",
  3: "Oh no. Monster pickup.",
  4: "He found a big rig somewhere.",
};

/* ---------------------------------------------------------------- the game */

export function createCannonRun(mount: HTMLElement, opts: Opts = {}): CannonRun {
  const params = new URLSearchParams(window.location.search);
  const automated = navigator.webdriver || params.has("shot");

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  const canvas = renderer.domElement;
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:crosshair";
  mount.appendChild(canvas);

  const bubble = document.createElement("div");
  bubble.style.cssText =
    "position:absolute;left:0;top:0;pointer-events:none;padding:6px 11px;border-radius:14px;background:#fff;color:#111;font:700 13px Inter,system-ui,sans-serif;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,.4);opacity:0;transition:opacity .18s;transform:translate(-50%,-100%)";
  mount.appendChild(bubble);

  const scene = new THREE.Scene();
  const FOG = new THREE.Color(0x141a2e);
  scene.fog = new THREE.FogExp2(FOG, 0.0042);
  scene.background = FOG;
  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 1400);

  const resize = (): void => {
    const w = mount.clientWidth || window.innerWidth;
    const h = mount.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Keep the road wide on a portrait phone.
    camera.fov = w / h < 0.9 ? 72 : 56;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener("resize", resize);

  /* ------------------------------------------------------------ sky */
  const skyGeo = new THREE.SphereGeometry(1000, 32, 16);
  {
    const pos = skyGeo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const top = new THREE.Color(0x03050c);
    const hor = new THREE.Color(0x26314f);
    const low = new THREE.Color(0x141a2e);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 1000;
      if (y > 0) c.copy(hor).lerp(top, Math.pow(Math.min(1, y * 2.2), 0.7));
      else c.copy(hor).lerp(low, Math.min(1, -y * 8));
      col.set([c.r, c.g, c.b], i * 3);
    }
    skyGeo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  }
  const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  sky.renderOrder = -10;
  scene.add(sky);
  const starGeo = new THREE.BufferGeometry();
  {
    const n = 900;
    const p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * Math.PI * 2;
      const v = 0.06 + Math.pow(Math.random(), 0.8) * 1.45;
      p.set([Math.cos(u) * Math.cos(v) * 950, Math.sin(v) * 950, Math.sin(u) * Math.cos(v) * 950], i * 3);
    }
    starGeo.setAttribute("position", new THREE.BufferAttribute(p, 3));
  }
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xcfd8ff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.85, depthWrite: false }));
  scene.add(stars);
  const glow = glowTexture();
  const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xdfe6ff, fog: false, depthWrite: false, transparent: true }));
  moon.scale.setScalar(110);
  scene.add(moon);
  const moonDisc = new THREE.Mesh(new THREE.CircleGeometry(14, 32), new THREE.MeshBasicMaterial({ color: 0xf4f1e4, fog: false }));
  scene.add(moonDisc);

  /* ------------------------------------------------------------ light */
  scene.add(new THREE.HemisphereLight(0x5a6ea8, 0x2a2018, 0.9));
  const moonLight = new THREE.DirectionalLight(0xaab8ff, 0.55);
  scene.add(moonLight);
  scene.add(moonLight.target);
  const lampLights: THREE.PointLight[] = [];
  for (let k = 0; k < 3; k++) {
    const l = new THREE.PointLight(0xffa44a, 260, 42, 1.7);
    scene.add(l);
    lampLights.push(l);
  }
  const tailLight = new THREE.PointLight(0xff2a1a, 14, 9, 1.6);
  scene.add(tailLight);
  // a cab-mounted work lamp, so the cannon reads as bronze and iron, not a silhouette
  const work = new THREE.PointLight(0xffd8a0, 3.5, 7, 1.4);
  scene.add(work);
  const flash = new THREE.PointLight(0xffb062, 0, 30, 1.5);
  scene.add(flash);
  const boomLight = new THREE.PointLight(0xff7a2a, 0, 60, 1.4);
  scene.add(boomLight);
  const beams: THREE.SpotLight[] = [];
  for (let k = 0; k < 2; k++) {
    const sp = new THREE.SpotLight(0xfff0d0, 1400, 110, 0.42, 0.55, 1.5);
    scene.add(sp);
    scene.add(sp.target);
    beams.push(sp);
  }

  /* ------------------------------------------------------------ ground and road */
  const sand = sandTexture();
  sand.repeat.set(90, 90);
  const groundMat = new THREE.MeshLambertMaterial({ map: sand });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1800, 1800), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.03;
  scene.add(ground);

  const SEG = 180;
  const STEP = 2.5;
  const ribbon = (half: number, y: number, mat: THREE.Material): { mesh: THREE.Mesh; geo: THREE.BufferGeometry } => {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array((SEG + 1) * 2 * 3);
    const uv = new Float32Array((SEG + 1) * 2 * 2);
    const idx: number[] = [];
    for (let i = 0; i < SEG; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    const nrm = new Float32Array((SEG + 1) * 2 * 3);
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
    geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.userData = { half, y };
    scene.add(mesh);
    return { mesh, geo };
  };
  const roadTex = roadTexture();
  const road = ribbon(HALF, 0.02, new THREE.MeshLambertMaterial({ map: roadTex }));
  const shoulder = ribbon(HALF + 2.6, 0.0, new THREE.MeshLambertMaterial({ color: 0x4a4038 }));
  const layRibbon = (r: { mesh: THREE.Mesh; geo: THREE.BufferGeometry }, s0: number): void => {
    const { half, y } = r.mesh.userData as { half: number; y: number };
    const pos = r.geo.attributes.position as THREE.BufferAttribute;
    const uv = r.geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i <= SEG; i++) {
      const s = s0 + i * STEP;
      toWorld(s, -half, y);
      pos.setXYZ(i * 2, V.x, V.y, V.z);
      toWorld(s, half, y);
      pos.setXYZ(i * 2 + 1, V.x, V.y, V.z);
      uv.setXY(i * 2, 0, s / 14);
      uv.setXY(i * 2 + 1, 1, s / 14);
    }
    pos.needsUpdate = true;
    uv.needsUpdate = true;
    r.geo.computeBoundingSphere();
  };

  /* ------------------------------------------------------------ roadside */
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x3b3f45 });
  const poleGeo = (() => {
    const pole = new THREE.CylinderGeometry(0.11, 0.15, 8, 8);
    pole.translate(0, 4, 0);
    const arm = new THREE.BoxGeometry(2.6, 0.12, 0.12);
    arm.translate(1.3, 7.9, 0);
    const head = new THREE.BoxGeometry(0.7, 0.18, 0.36);
    head.translate(2.5, 7.8, 0);
    const g = mergeGeometries([pole, arm, head])!;
    [pole, arm, head].forEach((x) => x.dispose());
    return g;
  })();
  const LAMPS = 12;
  const LAMP_GAP = 46;
  const lamps = new THREE.InstancedMesh(poleGeo, poleMat, LAMPS);
  lamps.frustumCulled = false;
  scene.add(lamps);
  const lampGlowGeo = new THREE.BufferGeometry();
  lampGlowGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(LAMPS * 3), 3));
  const lampGlow = new THREE.Points(lampGlowGeo, new THREE.PointsMaterial({ map: glow, color: 0xffb46a, size: 7, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  lampGlow.frustumCulled = false;
  scene.add(lampGlow);
  const poolGeo = new THREE.CircleGeometry(1, 24);
  poolGeo.rotateX(-Math.PI / 2);
  const poolMat = new THREE.MeshBasicMaterial({ map: glow, color: 0xff9a40, transparent: true, opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending });
  const pools = new THREE.InstancedMesh(poolGeo, poolMat, LAMPS);
  pools.frustumCulled = false;
  scene.add(pools);

  const cactusGeo = (() => {
    const trunk = new THREE.CylinderGeometry(0.32, 0.38, 4.2, 8);
    trunk.translate(0, 2.1, 0);
    const a1 = new THREE.CylinderGeometry(0.22, 0.24, 1.6, 7);
    a1.translate(0.75, 2.6, 0);
    const a1b = new THREE.CylinderGeometry(0.2, 0.22, 0.9, 7);
    a1b.rotateZ(Math.PI / 2);
    a1b.translate(0.4, 1.9, 0);
    const a2 = new THREE.CylinderGeometry(0.2, 0.22, 1.3, 7);
    a2.translate(-0.7, 3.1, 0);
    const a2b = new THREE.CylinderGeometry(0.18, 0.2, 0.8, 7);
    a2b.rotateZ(Math.PI / 2);
    a2b.translate(-0.36, 2.5, 0);
    const g = mergeGeometries([trunk, a1, a1b, a2, a2b])!;
    [trunk, a1, a1b, a2, a2b].forEach((x) => x.dispose());
    return g;
  })();
  const CACTI = 48;
  const CACTUS_GAP = 16;
  const cacti = new THREE.InstancedMesh(cactusGeo, new THREE.MeshLambertMaterial({ color: 0x2f4a33 }), CACTI);
  cacti.frustumCulled = false;
  scene.add(cacti);
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const ROCKS = 40;
  const rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshLambertMaterial({ color: 0x5a4636 }), ROCKS);
  rocks.frustumCulled = false;
  scene.add(rocks);
  const mesaGeo = new THREE.CylinderGeometry(0.75, 1, 1, 7);
  mesaGeo.translate(0, 0.5, 0);
  const MESAS = 16;
  const mesas = new THREE.InstancedMesh(mesaGeo, new THREE.MeshLambertMaterial({ color: 0x2a2030 }), MESAS);
  mesas.frustumCulled = false;
  scene.add(mesas);
  // A neon motel sign every so often, for something to read at night.
  const signs: THREE.Group[] = [];
  const signTex = canvasTex(256, 96, (c) => {
    c.fillStyle = "#120a14";
    c.fillRect(0, 0, 256, 96);
    c.font = "bold 46px Inter, system-ui, sans-serif";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.shadowColor = "#ff3b7a";
    c.shadowBlur = 18;
    c.fillStyle = "#ff6aa0";
    c.fillText("MOTEL", 128, 40);
    c.font = "bold 20px Inter, system-ui, sans-serif";
    c.shadowColor = "#4de0ff";
    c.fillStyle = "#8ff0ff";
    c.fillText("NO VACANCY", 128, 78);
  });
  for (let k = 0; k < 2; k++) {
    const g = new THREE.Group();
    const face = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 2.0), new THREE.MeshBasicMaterial({ map: signTex, side: THREE.DoubleSide }));
    face.position.y = 6.2;
    g.add(face);
    g.add(box(0.25, 5.4, 0.25, 0, 2.7, 0, poleMat));
    const neon = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xff3b7a, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }));
    neon.scale.set(10, 5, 1);
    neon.position.y = 6.2;
    g.add(neon);
    scene.add(g);
    signs.push(g);
  }

  /* ------------------------------------------------------------ vehicles */
  const truck = buildTruck();
  scene.add(truck.root);
  let foe = buildFoe(1);
  scene.add(foe.root);
  const glareMat = new THREE.SpriteMaterial({ map: glow, color: 0xfff2d8, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const glares = [new THREE.Sprite(glareMat), new THREE.Sprite(glareMat)];
  glares.forEach((g) => scene.add(g));
  const haloMat = new THREE.SpriteMaterial({ map: glow, color: 0xffe2a8, transparent: true, opacity: 0.25, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const halo = new THREE.Sprite(haloMat);
  scene.add(halo);

  const trafficGeo = trafficGeometry();
  const trafficMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.3 });
  const MAX_TRAFFIC = 5;
  const trafficMesh = new THREE.InstancedMesh(trafficGeo, trafficMat, MAX_TRAFFIC);
  trafficMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_TRAFFIC * 3), 3);
  trafficMesh.frustumCulled = false;
  scene.add(trafficMesh);
  const TRAFFIC_COLORS = [0xe8e4da, 0x2e5fa8, 0x8a8f96, 0x3c7a4e, 0x7b4a9e, 0xc96a2a];

  /* ------------------------------------------------------------ projectiles and puffs */
  const ballGeo = new THREE.SphereGeometry(0.19, 14, 10);
  const ballMat = new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.35, metalness: 0.8 });
  const balls: Ball[] = [];
  for (let k = 0; k < 10; k++) {
    const mesh = new THREE.Mesh(ballGeo, ballMat);
    mesh.visible = false;
    scene.add(mesh);
    balls.push({ s: 0, lat: 0, y: 0, vs: 0, vl: 0, vy: 0, age: 0, bounces: 0, mesh, live: false, trail: 0 });
  }
  const tyreGeo = new THREE.TorusGeometry(0.42, 0.18, 10, 20);
  const canGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.8, 12);
  const thrownMatA = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
  const thrownMatB = new THREE.MeshStandardMaterial({ color: 0xb8392e, roughness: 0.5, metalness: 0.4 });
  const thrown: Thrown[] = [];
  for (let k = 0; k < 6; k++) {
    const mesh = new THREE.Mesh(k % 2 ? canGeo : tyreGeo, k % 2 ? thrownMatB : thrownMatA);
    mesh.visible = false;
    scene.add(mesh);
    thrown.push({ s: 0, lat: 0, y: 0, vs: 0, vl: 0, vy: 0, age: 0, spin: 0, mesh, live: false, targetLat: 0, passed: false });
  }
  const warnGeo = new THREE.RingGeometry(0.7, 1.0, 28);
  warnGeo.rotateX(-Math.PI / 2);
  const warnMat = new THREE.MeshBasicMaterial({ color: 0xff3b2e, transparent: true, opacity: 0.8, depthWrite: false });
  const warns = thrown.map(() => {
    const m = new THREE.Mesh(warnGeo, warnMat);
    m.visible = false;
    scene.add(m);
    return m;
  });

  const puffTex = puffTexture();
  const puffs: Puff[] = [];
  for (let k = 0; k < 110; k++) {
    const mat = new THREE.SpriteMaterial({ map: puffTex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    scene.add(sprite);
    puffs.push({ sprite, mat, s: 0, lat: 0, y: 0, vs: 0, vl: 0, vy: 0, age: 0, life: 1, size: 1, grow: 1, kind: "smoke", live: false });
  }
  let puffNext = 0;
  const puff = (kind: Puff["kind"], s: number, lat: number, y: number, vs: number, vl: number, vy: number, size: number, life: number): void => {
    const p = puffs[puffNext];
    puffNext = (puffNext + 1) % puffs.length;
    Object.assign(p, { kind, s, lat, y, vs, vl, vy, size, life, age: 0, live: true, grow: kind === "smoke" ? 2.2 : kind === "dust" ? 1.6 : kind === "fire" ? 0.8 : 0.2 });
    p.mat.blending = kind === "fire" || kind === "spark" ? THREE.AdditiveBlending : THREE.NormalBlending;
    p.mat.color.set(kind === "smoke" ? 0x8a8a8a : kind === "dust" ? 0x7a6650 : kind === "fire" ? 0xff8a2a : 0xffd27a);
    p.sprite.visible = true;
  };

  // Aim: dots along the predicted arc and a ring where it lands.
  const dotGeo = new THREE.SphereGeometry(0.07, 8, 6);
  const dotMat = new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.75, depthWrite: false });
  const DOTS = 16;
  const dots = new THREE.InstancedMesh(dotGeo, dotMat, DOTS);
  dots.frustumCulled = false;
  scene.add(dots);
  const reticle = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.15, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9, depthWrite: false }));
  scene.add(reticle);

  /* ------------------------------------------------------------ state */
  let best = 0;
  try { best = Number(localStorage.getItem("cannonrun.best") ?? 0) || 0; } catch { /* private window */ }

  const me = { s: 0, lat: 2, vl: 0, v: 31, boost: 1, hull: 100, shake: 0, spin: 0, bump: 0 };
  const en = { ramCd: 0, s: -140, lat: 0, v: 40, hp: 4, max: 4, level: 1, hitSlow: 0, lunge: 0, lungeT: 5, throwT: 4, wreck: 0, roll: 0, rollV: 0, y: 0, vy: 0, dodge: 0, rage: 0 };
  const aim = { yaw: 0, pitch: 0.08, dist: 30, lat: 0, has: false, sx: 0, sy: 0 };
  let reload = 0;
  let recoil = 0;
  let phase: ChaseHud["phase"] = "intro";
  let introT = 0;
  let time = 0;
  let score = 0;
  let hits = 0;
  let wrecks = 0;
  let toast = "";
  let toastT = 0;
  let talk = "";
  let talkT = 0;
  let tauntT = 3;
  let trafficT = 6;
  let respawnT = 0;
  let muted = false;
  const traffic: Traffic[] = [];
  const keys = new Set<string>();
  const stick = { x: 0, y: 0 };
  const held = { boost: false };
  let wantFire = false;
  let mouseX = -1;
  let mouseY = -1;

  const say = (t: string, d = 2.2): void => { toast = t; toastT = d; };
  const shout = (t: string, d = 2.2): void => { talk = t; talkT = d; };

  /* ------------------------------------------------------------ input */
  const onKey = (e: KeyboardEvent): void => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (e.type === "keydown") {
      audio.start();
      if (k === " " || k === "f") { wantFire = true; e.preventDefault(); }
      if (k === "Enter" && phase === "over") api.restart();
      keys.add(k);
    } else keys.delete(k);
  };
  const onBlur = (): void => { keys.clear(); held.boost = false; };
  const onMove = (e: PointerEvent): void => {
    if (e.pointerType !== "mouse") return;
    const r = canvas.getBoundingClientRect();
    mouseX = e.clientX - r.left;
    mouseY = e.clientY - r.top;
  };
  const onDown = (e: PointerEvent): void => {
    audio.start();
    if (e.pointerType !== "mouse") return; // the page handles touch through aimAt
    const r = canvas.getBoundingClientRect();
    mouseX = e.clientX - r.left;
    mouseY = e.clientY - r.top;
    if (e.button === 0) wantFire = true;
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);
  window.addEventListener("blur", onBlur);
  window.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerdown", onDown);

  /* ------------------------------------------------------------ sound */
  const audio = (() => {
    let ctx: AudioContext | null = null;
    let master: GainNode | null = null;
    let myEngine: OscillatorNode | null = null;
    let myGain: GainNode | null = null;
    let hisEngine: OscillatorNode | null = null;
    let hisGain: GainNode | null = null;
    let noise: AudioBuffer | null = null;
    const burst = (dur: number, freq: number, gain: number, type: BiquadFilterType = "lowpass"): void => {
      if (!ctx || !master || !noise) return;
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      const g = ctx.createGain();
      const t = ctx.currentTime;
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(f).connect(g).connect(master);
      src.start(t);
      src.stop(t + dur + 0.05);
    };
    const tone = (type: OscillatorType, f0: number, f1: number, dur: number, gain: number, delay = 0): void => {
      if (!ctx || !master) return;
      const o = ctx.createOscillator();
      o.type = type;
      const g = ctx.createGain();
      const t = ctx.currentTime + delay;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + dur + 0.05);
    };
    return {
      start(): void {
        if (ctx) { if (ctx.state === "suspended") void ctx.resume(); return; }
        if (automated) return;
        try {
          const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
          ctx = new AC();
          master = ctx.createGain();
          master.gain.value = muted ? 0 : 0.55;
          master.connect(ctx.destination);
          noise = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
          const d = noise.getChannelData(0);
          for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
          const mk = (type: OscillatorType, cut: number): [OscillatorNode, GainNode] => {
            const o = ctx!.createOscillator();
            o.type = type;
            const lp = ctx!.createBiquadFilter();
            lp.type = "lowpass";
            lp.frequency.value = cut;
            const g = ctx!.createGain();
            g.gain.value = 0;
            o.connect(lp).connect(g).connect(master!);
            o.start();
            return [o, g];
          };
          [myEngine, myGain] = mk("sawtooth", 420);
          [hisEngine, hisGain] = mk("square", 300);
        } catch { ctx = null; }
      },
      update(v: number, gap: number, live: boolean): void {
        if (!ctx || !myEngine || !myGain || !hisEngine || !hisGain) return;
        const t = ctx.currentTime;
        myEngine.frequency.setTargetAtTime(52 + v * 1.6, t, 0.1);
        myGain.gain.setTargetAtTime(phase === "over" ? 0 : 0.09, t, 0.2);
        hisEngine.frequency.setTargetAtTime(38 + clamp(60 - gap, 0, 60) * 0.6, t, 0.1);
        hisGain.gain.setTargetAtTime(live ? clamp(1 - gap / 90, 0, 1) * 0.08 : 0, t, 0.2);
      },
      boom(): void { burst(0.9, 520, 0.9); tone("sine", 130, 34, 0.7, 0.7); },
      clang(): void { burst(0.35, 2400, 0.5, "bandpass"); tone("triangle", 900, 420, 0.3, 0.25); },
      crunch(): void { burst(0.6, 900, 0.7, "bandpass"); tone("sawtooth", 90, 30, 0.5, 0.35); },
      blast(): void { burst(1.6, 380, 1.0); tone("sine", 90, 22, 1.4, 0.8); },
      horn(): void { tone("square", 330, 328, 0.55, 0.12); tone("square", 415, 412, 0.55, 0.1); },
      whoosh(): void { burst(0.5, 1200, 0.25, "highpass"); },
      mute(m: boolean): void { if (master && ctx) master.gain.setTargetAtTime(m ? 0 : 0.55, ctx.currentTime, 0.05); },
      stop(): void { void ctx?.close(); ctx = null; },
    };
  })();

  /* ------------------------------------------------------------ rules */
  const spawnFoe = (level: number, gap: number): void => {
    scene.remove(foe.root);
    disposeTree(foe.root);
    foe = buildFoe(level);
    scene.add(foe.root);
    const spec = RIDES[Math.min(level - 1, RIDES.length - 1)];
    const max = spec.hp + Math.max(0, level - RIDES.length) * 3;
    Object.assign(en, { ramCd: 0, s: me.s - gap, lat: -me.lat, v: me.v + 14, hp: max, max, level, hitSlow: 0, lunge: 0, lungeT: 6, throwT: 3.5, wreck: 0, roll: 0, rollV: 0, y: 0, vy: 0, rage: 0 });
  };

  const fire = (): void => {
    if (reload > 0 || phase === "over") return;
    reload = RELOAD;
    recoil = 1;
    const b = balls.find((x) => !x.live) ?? balls[0];
    const cp = Math.cos(aim.pitch);
    // The muzzle sits 1.55 m back from the trunnions, 1.3 m up, over the tailgate.
    const ms = me.s - 1.15 - 1.55 * cp * Math.cos(aim.yaw);
    const ml = me.lat + 1.55 * cp * Math.sin(aim.yaw);
    Object.assign(b, {
      s: ms, lat: ml, y: 1.29 + 1.55 * Math.sin(aim.pitch),
      vs: me.v - MUZZLE * cp * Math.cos(aim.yaw),
      vl: MUZZLE * cp * Math.sin(aim.yaw),
      vy: MUZZLE * Math.sin(aim.pitch),
      age: 0, bounces: 0, live: true, trail: 0,
    });
    b.mesh.visible = true;
    flash.intensity = 900;
    me.shake = Math.max(me.shake, 0.5);
    for (let k = 0; k < 7; k++) puff("smoke", b.s, b.lat, b.y, me.v - 10 - Math.random() * 8, (Math.random() - 0.5) * 3, Math.random() * 2, 0.6, 1.4);
    for (let k = 0; k < 4; k++) puff("fire", b.s, b.lat, b.y, me.v - 18, (Math.random() - 0.5) * 4, (Math.random() - 0.3) * 3, 1.2, 0.18);
    audio.boom();
  };

  const hurt = (n: number, why: string): void => {
    if (phase !== "play") return;
    me.hull = Math.max(0, me.hull - n);
    me.shake = Math.max(me.shake, 1);
    say(why, 1.6);
    if (me.hull <= 0) {
      phase = "over";
      me.spin = 0.01;
      shout("HA! GOT YOU!", 4);
      audio.crunch();
      if (score > best) {
        best = score;
        try { localStorage.setItem("cannonrun.best", String(best)); } catch { /* ignore */ }
      }
    }
  };

  const hitFoe = (b: { s: number; lat: number; y: number }, label: string): void => {
    if (en.wreck > 0) return;
    en.hp -= 1;
    hits += 1;
    score += 100 * en.level;
    en.hitSlow = 12;
    en.rage = 1;
    en.dodge = (Math.random() - 0.5) * 4;
    audio.clang();
    for (let k = 0; k < 10; k++) puff("spark", b.s, b.lat, b.y, en.v + (Math.random() - 0.3) * 14, (Math.random() - 0.5) * 12, Math.random() * 8, 0.45, 0.4);
    for (let k = 0; k < 5; k++) puff("smoke", b.s, b.lat, b.y, en.v - 4, (Math.random() - 0.5) * 2, 1 + Math.random(), 1.3, 1.4);
    if (en.hp <= 0) {
      en.wreck = 0.001;
      en.vy = 6;
      en.rollV = (Math.random() > 0.5 ? 1 : -1) * 4.5;
      wrecks += 1;
      score += 1000 * en.level;
      me.hull = Math.min(100, me.hull + 15);
      boomLight.intensity = 3000;
      audio.blast();
      for (let k = 0; k < 26; k++) puff("fire", en.s, en.lat, 1.2, en.v + (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10, Math.random() * 9, 2.4, 0.7 + Math.random() * 0.5);
      for (let k = 0; k < 18; k++) puff("smoke", en.s, en.lat, 1.5, en.v - 6, (Math.random() - 0.5) * 6, 2 + Math.random() * 3, 2.6, 2.6);
      say(`WRECKED ${RIDES[Math.min(en.level - 1, RIDES.length - 1)].name.toUpperCase()}! +${1000 * en.level}`, 2.6);
      shout(COMEBACK[Math.floor(Math.random() * COMEBACK.length)], 2.6);
      respawnT = 5.5;
    } else {
      say(label, 1.1);
      shout(OUCH[Math.floor(Math.random() * OUCH.length)], 1.6);
    }
  };

  /** Point the cannon where the mouse (or a tap) meets the road. */
  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.02);
  const hitP = new THREE.Vector3();
  const updateAim = (): void => {
    if (mouseX < 0) {
      // No pointer yet: point at him, which is also what a phone sees until a tap.
      setAimTo(en.s, en.lat, true);
      return;
    }
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    ray.setFromCamera(new THREE.Vector2((mouseX / w) * 2 - 1, -(mouseY / h) * 2 + 1), camera);
    if (ray.ray.intersectPlane(plane, hitP)) {
      const r = toRoad(hitP.x, hitP.z);
      setAimTo(r.s, r.lat, false);
    } else {
      setAimTo(me.s - 160, aim.lat, false);
    }
  };
  /** Low-angle ballistic solution to land at road point (s, lat), in the truck's frame. */
  const setAimTo = (s: number, lat: number, auto: boolean): void => {
    // A little help: near him, aim where he will be.
    if (en.wreck === 0 && phase !== "over") {
      const dS = s - en.s;
      const dL = lat - en.lat;
      if (auto || Math.hypot(dS, dL) < 7.5) {
        const d0 = Math.max(4, me.s - 1.15 - en.s);
        const tf = d0 / MUZZLE;
        const rel = en.v - me.v;
        s = en.s + rel * tf * 1.05;
        lat = en.lat + (auto ? 0 : dL * 0.25);
      }
    }
    const D = clamp(me.s - 1.15 - s, 5, 190);
    const L = lat - me.lat;
    aim.yaw = clamp(Math.atan2(L, D), -0.85, 0.85);
    aim.lat = lat;
    const dist = Math.hypot(D, L);
    aim.dist = dist;
    // Land a ball fired from 1.3 m up at distance dist: solve numerically on the low arc.
    let lo = -0.12;
    let hi = 0.75;
    const range = (p: number): number => {
      const vh = MUZZLE * Math.cos(p);
      const vv = MUZZLE * Math.sin(p);
      const t = (vv + Math.sqrt(vv * vv + 2 * G * 1.3)) / G;
      return vh * t;
    };
    if (range(hi) < dist) aim.pitch = hi;
    else {
      for (let k = 0; k < 18; k++) {
        const m = (lo + hi) / 2;
        if (range(m) < dist) lo = m; else hi = m;
      }
      aim.pitch = (lo + hi) / 2;
    }
    aim.has = true;
  };

  /* ------------------------------------------------------------ step */
  const step = (dt: number): void => {
    time += dt;
    if (toastT > 0) { toastT -= dt; if (toastT <= 0) toast = ""; }
    if (talkT > 0) { talkT -= dt; if (talkT <= 0) talk = ""; }
    reload = Math.max(0, reload - dt);
    recoil = Math.max(0, recoil - dt * 3.2);
    me.shake = Math.max(0, me.shake - dt * 2.4);
    flash.intensity *= Math.pow(0.0005, dt);
    boomLight.intensity *= Math.pow(0.02, dt);

    if (phase === "intro") {
      introT += dt;
      if (introT > 0.6 && introT - dt <= 0.6) { audio.horn(); shout("HEY! THAT'S MY CANNON!", 2.8); }
      if (introT > 2.6) { phase = "play"; say("Here he comes. Light him up!", 3); }
    }

    // --- you
    let steer = 0;
    if (keys.has("a") || keys.has("ArrowLeft")) steer -= 1;
    if (keys.has("d") || keys.has("ArrowRight")) steer += 1;
    if (Math.abs(stick.x) > 0.1) steer = stick.x;
    // Looking back, screen right is the truck's left.
    const wantLat = phase === "over" ? me.lat : me.lat - steer * 9;
    me.vl = lerp(me.vl, clamp(wantLat - me.lat, -1, 1) * 9 * Math.abs(steer), Math.min(1, dt * 6));
    if (steer === 0) me.vl *= Math.pow(0.02, dt);
    me.lat = clamp(me.lat + me.vl * dt, -LAT_MAX, LAT_MAX);
    const boosting = (keys.has("Shift") || held.boost || keys.has("w") || keys.has("ArrowUp")) && me.boost > 0.02 && phase === "play";
    me.boost = clamp(me.boost + (boosting ? -0.32 : 0.09) * dt, 0, 1);
    const target = phase === "over" ? Math.max(0, me.v - 18 * dt) : 31 + (boosting ? 13 : 0) + Math.min(10, me.s / 1500);
    me.v = phase === "over" ? target : lerp(me.v, target, Math.min(1, dt * 1.4));
    if (me.bump > 0) { me.v += me.bump * dt * 4; me.bump = Math.max(0, me.bump - dt * 8); }
    me.s += me.v * dt;
    if (phase === "over") me.spin += dt * (me.v / 10);
    if (phase === "play") score += me.v * dt * 0.5;

    // --- traffic you overtake, which becomes his problem
    trafficT -= dt;
    if (trafficT <= 0 && phase === "play" && traffic.filter((t) => t.live).length < MAX_TRAFFIC) {
      trafficT = 5 + Math.random() * 7;
      const lat = me.lat > 0 ? -LANE / 2 - 0.2 : LANE / 2 + 0.2;
      traffic.push({ s: me.s + 28, lat, v: 18 + Math.random() * 5, color: new THREE.Color(TRAFFIC_COLORS[Math.floor(Math.random() * TRAFFIC_COLORS.length)]), flung: 0, vy: 0, y: 0, spin: 0, vl: 0, live: true });
    }
    for (const t of traffic) {
      if (!t.live) continue;
      t.s += t.v * dt;
      if (t.flung > 0) {
        t.flung += dt;
        t.vy -= G * dt;
        t.y = Math.max(0, t.y + t.vy * dt);
        if (t.y === 0) { t.vy = Math.abs(t.vy) * 0.3; t.v *= 0.9; }
        t.lat += t.vl * dt;
        t.spin += dt * 5;
        t.v = Math.max(0, t.v - dt * 14);
      }
      // you shoulder past it rather than through it
      if (t.flung === 0 && Math.abs(t.s - me.s) < 4.5 && Math.abs(t.lat - me.lat) < 2) me.lat += Math.sign(me.lat - t.lat || 1) * dt * 8;
      if (t.s < me.s - 420) t.live = false;
    }
    for (let i = traffic.length - 1; i >= 0; i--) if (!traffic[i].live) traffic.splice(i, 1);

    // --- Mort
    const gap = me.s - en.s;
    if (en.wreck > 0) {
      en.wreck += dt;
      en.v = Math.max(0, en.v - dt * 22);
      en.vy -= G * dt;
      en.y = Math.max(0, en.y + en.vy * dt);
      if (en.y === 0 && en.vy < 0) { en.vy = -en.vy * 0.35; en.rollV *= 0.6; }
      en.roll += en.rollV * dt;
      if (Math.random() < dt * 14) puff("fire", en.s, en.lat, 0.8 + Math.random(), en.v, (Math.random() - 0.5), 2 + Math.random() * 2, 1.4, 0.5);
      if (Math.random() < dt * 10) puff("smoke", en.s, en.lat, 1.6, en.v, 0, 3, 2.2, 2.4);
      respawnT -= dt;
      if (respawnT <= 0 && phase === "play") {
        spawnFoe(en.level + 1, 220);
        audio.horn();
        say(COMMENTS[en.level] ?? `Level ${en.level}. He just keeps coming.`, 2.8);
        shout(TAUNTS[Math.floor(Math.random() * TAUNTS.length)], 2.5);
      }
    } else {
      en.hitSlow = Math.max(0, en.hitSlow - dt * 5);
      en.rage = Math.max(0, en.rage - dt * 0.6);
      const close = 4 + en.level * 1.3 + Math.min(4, me.s / 2000);
      let want = me.v + (gap > 30 ? close + (gap - 30) * 0.25 : close * 0.6);
      if (phase === "intro") want = me.v + 10;
      if (phase === "over") want = me.v - 5;
      en.lungeT -= dt;
      if (en.lungeT <= 0 && gap < 26 && phase === "play") { en.lunge = 1.3; en.lungeT = 7 - Math.min(4, en.level); audio.horn(); }
      if (en.lunge > 0) { en.lunge -= dt; want += 11; }
      want -= en.hitSlow;
      en.v = lerp(en.v, Math.max(8, want), Math.min(1, dt * 1.8));
      en.s += en.v * dt;
      if (gap < 4) en.s = me.s - 4;
      // steer for you, around traffic, and (later in the night) out of the way of a ball
      let target = me.lat;
      for (const t of traffic) {
        if (t.flung > 0 || !t.live) continue;
        const ahead = t.s - en.s;
        if (ahead > 0 && ahead < 26 && Math.abs(t.lat - en.lat) < 2.6 && Math.random() < 0.85 - en.level * 0.1) target = t.lat > 0 ? -LANE : LANE;
      }
      if (en.level >= 2) for (const b of balls) {
        if (!b.live || b.vy < -2) continue;
        if (Math.abs(b.lat - en.lat) < 2 && b.s - en.s < 30 && b.s - en.s > 0 && Math.random() < dt * en.level * 0.5) en.dodge = (b.lat > en.lat ? -1 : 1) * 3.5;
      }
      en.dodge *= Math.pow(0.4, dt);
      target = clamp(target + en.dodge + Math.sin(time * 0.9) * 1.2, -LAT_MAX, LAT_MAX);
      en.lat += clamp(target - en.lat, -1, 1) * dt * (3.2 + en.level * 0.5);
      // the ram
      const reach = foe.len / 2 + 2.6;
      en.ramCd = Math.max(0, en.ramCd - dt);
      if (gap < reach + 0.4 && en.ramCd === 0 && Math.abs(en.lat - me.lat) < (foe.wid + 1.96) / 2 && phase === "play") {
        en.ramCd = 1.6;
        en.s -= 3;
        hurt(14 + en.level * 4, "RAMMED!");
        audio.crunch();
        en.hitSlow = 18;
        en.lunge = 0;
        me.bump = 3;
        for (let k = 0; k < 8; k++) puff("spark", me.s - 2.6, me.lat, 0.8, me.v, (Math.random() - 0.5) * 10, Math.random() * 6, 0.4, 0.4);
        shout("BOOP!", 1);
      }
      // pursuer through traffic
      for (const t of traffic) {
        if (t.flung > 0 || !t.live) continue;
        if (Math.abs(t.s - en.s) < (foe.len + 4.3) / 2 && Math.abs(t.lat - en.lat) < (foe.wid + 1.85) / 2) {
          t.flung = 0.001;
          t.vy = 4 + en.level;
          t.vl = Math.sign(t.lat - en.lat || 1) * 7;
          t.v = en.v + 3;
          audio.crunch();
          hitFoe({ s: en.s + foe.len / 2, lat: en.lat, y: 1 }, "HE HIT TRAFFIC!");
          score += 150;
        }
      }
      // throwing things (from the second truck on)
      if (en.level >= 2 && phase === "play" && gap < 60 && gap > 10) {
        en.throwT -= dt;
        if (en.throwT <= 0) {
          en.throwT = Math.max(1.6, 4.2 - en.level * 0.55) + Math.random() * 1.5;
          const it = thrown.find((x) => !x.live);
          if (it) {
            const T = 1.25 + gap / 90;
            const s0 = en.s + foe.len / 2 - 0.6;
            const y0 = foe.tall + 0.3;
            const tl = clamp(me.lat + me.vl * T * 0.4, -LAT_MAX, LAT_MAX);
            Object.assign(it, {
              s: s0, lat: en.lat + foe.wid / 2, y: y0,
              vs: (me.s + me.v * T - 1.2 - s0) / T,
              vl: (tl - (en.lat + foe.wid / 2)) / T,
              vy: (1.2 - y0 + 0.5 * G * T * T) / T,
              age: 0, spin: 0, live: true, targetLat: tl, passed: false,
            });
            it.mesh.visible = true;
            shout(it.mesh.geometry === tyreGeo ? "CATCH!" : "HAVE A CAN!", 1.2);
            audio.whoosh();
          }
        }
      }
      tauntT -= dt;
      if (tauntT <= 0 && talkT <= 0) { tauntT = 4 + Math.random() * 4; shout(TAUNTS[Math.floor(Math.random() * TAUNTS.length)]); }
      // a tired engine smokes
      if (en.hp <= en.max / 2 && Math.random() < dt * (6 - en.hp)) puff("smoke", en.s + foe.len / 2 - 0.8, en.lat, foe.tall * 0.6, en.v - 2, 0, 1.5, 1.2, 1.6);
    }

    // --- cannon
    updateAim();
    if (wantFire) { wantFire = false; fire(); }
    for (const b of balls) {
      if (!b.live) continue;
      b.age += dt;
      b.vy -= G * dt;
      b.s += b.vs * dt;
      b.lat += b.vl * dt;
      b.y += b.vy * dt;
      b.trail -= dt;
      if (b.trail <= 0 && b.age < 2) { b.trail = 0.035; puff("smoke", b.s, b.lat, b.y, b.vs * 0.2 + me.v * 0.3, 0, 0.5, 0.35, 0.7); }
      if (b.y < 0.19) {
        b.y = 0.19;
        b.vy = Math.abs(b.vy) * 0.42;
        b.vs = lerp(b.vs, 0, 0.2);
        b.vl *= 0.6;
        b.bounces += 1;
        for (let k = 0; k < 4; k++) puff("dust", b.s, b.lat, 0.3, b.vs * 0.3, (Math.random() - 0.5) * 3, 1 + Math.random(), 0.9, 1.0);
      }
      // him
      if (en.wreck === 0 && Math.abs(b.s - en.s) < foe.len / 2 + 0.35 && Math.abs(b.lat - en.lat) < foe.wid / 2 + 0.3 && b.y < foe.tall + 0.3) {
        b.live = false;
        hitFoe(b, b.bounces > 0 ? "BOUNCE SHOT!" : b.y > foe.tall * 0.6 ? "RIGHT IN THE CAB!" : "DIRECT HIT!");
        continue;
      }
      // whatever he threw
      for (const it of thrown) {
        if (it.live && Math.hypot(it.s - b.s, it.lat - b.lat, it.y - b.y) < 1.1) {
          it.live = false;
          b.live = false;
          score += 75;
          say("SHOT IT OUT OF THE AIR! +75", 1.4);
          audio.clang();
          for (let k = 0; k < 8; k++) puff("spark", it.s, it.lat, it.y, me.v, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, 0.4, 0.35);
        }
      }
      // traffic
      for (const t of traffic) {
        if (b.live && t.flung === 0 && Math.abs(b.s - t.s) < 2.3 && Math.abs(b.lat - t.lat) < 1.1 && b.y < 1.6) {
          b.live = false;
          t.flung = 0.001;
          t.vy = 5;
          t.vl = Math.sign(t.lat || 1) * 4;
          score -= 25;
          say("Hey, that was a civilian. -25", 1.4);
          audio.clang();
        }
      }
      if (b.age > 4.5 || b.bounces > 3) b.live = false;
    }
    for (const it of thrown) {
      if (!it.live) continue;
      it.age += dt;
      it.vy -= G * dt;
      it.s += it.vs * dt;
      it.lat += it.vl * dt;
      it.y += it.vy * dt;
      it.spin += dt * 9;
      if (!it.passed && it.s >= me.s - 2.4) {
        it.passed = true;
        if (Math.abs(it.lat - me.lat) < 1.35 && it.y < 2.4 && phase === "play") {
          it.live = false;
          hurt(10 + en.level * 2, "TAKE THAT TO THE TAILGATE!");
          audio.clang();
          for (let k = 0; k < 6; k++) puff("spark", me.s - 2.4, me.lat, 1.2, me.v, (Math.random() - 0.5) * 8, Math.random() * 5, 0.4, 0.35);
        } else if (phase === "play") {
          score += 20;
        }
      }
      if (it.y < 0.3 && it.vy < 0) { it.vy = Math.abs(it.vy) * 0.35; it.vs *= 0.7; }
      if (it.age > 3.2) it.live = false;
    }
    for (const p of puffs) {
      if (!p.live) continue;
      p.age += dt;
      if (p.age >= p.life) { p.live = false; p.sprite.visible = false; continue; }
      p.s += p.vs * dt;
      p.lat += p.vl * dt;
      p.y += p.vy * dt;
      if (p.kind === "spark") p.vy -= G * dt;
      p.vs = lerp(p.vs, 0, Math.min(1, dt * (p.kind === "smoke" ? 1.2 : 0.4)));
    }

    // dust off your rear wheels on the shoulder
    if (Math.abs(me.lat) > HALF - 2.2 && Math.random() < dt * 24) puff("dust", me.s - 3, me.lat + Math.sign(me.lat) * 0.8, 0.3, me.v * 0.7, 0, 0.6, 0.6, 0.8);
  };

  /* ------------------------------------------------------------ draw */
  const M = new THREE.Matrix4();
  const Q = new THREE.Quaternion();
  const E = new THREE.Euler();
  const S3 = new THREE.Vector3();
  const P = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const camTarget = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const tmpColor = new THREE.Color();

  const place = (obj: THREE.Object3D, s: number, lat: number, y: number, yawOff = 0): void => {
    toWorld(s, lat, y, obj.position);
    obj.rotation.set(0, heading(s) + yawOff, 0);
  };

  const draw = (): void => {
    // you
    place(truck.root, me.s, me.lat, 0, me.spin + me.vl * -0.02);
    truck.root.rotation.z = me.vl * 0.012;
    for (const w of truck.wheels) w.rotation.x -= me.v * 0.016;
    truck.yaw.rotation.y = aim.yaw;
    truck.pitch.rotation.x = aim.pitch;
    truck.barrel.position.z = recoil * recoil * 0.35;
    truck.tail.color.setRGB(1, 0.16 + (me.boost < 0.05 ? 0 : 0), 0.1);
    toWorld(me.s - 3.4, me.lat, 0.9, tailLight.position);
    toWorld(me.s - 3.2, me.lat, 1.5, flash.position);
    toWorld(me.s + 0.2, me.lat, 2.6, work.position);

    // the camera: over the front of the bed, looking back down the road
    const shake = me.shake * me.shake * 0.25;
    const h = heading(me.s);
    toWorld(me.s + 1.6, me.lat * 0.9, 3.5, camera.position);
    camera.position.x += (Math.random() - 0.5) * shake;
    camera.position.y += (Math.random() - 0.5) * shake;
    toWorld(me.s - 28, me.lat * 0.55, -2.6, camTarget);
    camera.up.copy(UP);
    camera.lookAt(camTarget);
    sky.position.copy(camera.position);
    stars.position.copy(camera.position);
    // the moon hangs over the road behind you
    tmp.set(-Math.sin(h) * 700 - 180 * Math.cos(h), 240, -Math.cos(h) * 700 + 180 * Math.sin(h));
    moon.position.copy(camera.position).add(tmp);
    moonDisc.position.copy(moon.position);
    moonDisc.lookAt(camera.position);
    moonLight.position.copy(moon.position);
    moonLight.target.position.copy(camera.position);
    ground.position.set(camera.position.x, -0.03, camera.position.z);
    sand.offset.set(camera.position.x / 20, -camera.position.z / 20);

    const s0 = me.s - SEG * STEP + 30;
    layRibbon(road, s0);
    layRibbon(shoulder, s0);

    // lamps, alternating sides
    const k0 = Math.floor((me.s - LAMPS * LAMP_GAP + 40) / LAMP_GAP);
    const glowPos = lampGlowGeo.attributes.position as THREE.BufferAttribute;
    const near: { s: number; lat: number }[] = [];
    for (let i = 0; i < LAMPS; i++) {
      const k = k0 + i;
      const s = k * LAMP_GAP;
      const side = k % 2 === 0 ? 1 : -1;
      const lat = side * (HALF + 1.8);
      const hh = heading(s);
      toWorld(s, lat, 0, P);
      Q.setFromEuler(E.set(0, side > 0 ? hh : hh + Math.PI, 0));
      M.compose(P, Q, S3.set(1, 1, 1));
      lamps.setMatrixAt(i, M);
      toWorld(s, lat - side * 2.5, 7.7, P);
      glowPos.setXYZ(i, P.x, P.y, P.z);
      toWorld(s, lat - side * 3.2, 0.04, P);
      M.compose(P, Q.identity(), S3.set(7, 1, 7));
      pools.setMatrixAt(i, M);
      near.push({ s, lat: lat - side * 2.5 });
    }
    lamps.instanceMatrix.needsUpdate = true;
    pools.instanceMatrix.needsUpdate = true;
    glowPos.needsUpdate = true;
    near.sort((a, b) => Math.abs(a.s - (me.s - 25)) - Math.abs(b.s - (me.s - 25)));
    for (let i = 0; i < lampLights.length; i++) toWorld(near[i].s, near[i].lat, 7.2, lampLights[i].position);

    // desert furniture
    const c0 = Math.floor((me.s - CACTI * CACTUS_GAP + 30) / CACTUS_GAP);
    for (let i = 0; i < CACTI; i++) {
      const k = c0 + i;
      const r = hash(k);
      const side = r > 0.5 ? 1 : -1;
      const lat = side * (HALF + 6 + hash(k + 0.31) * 55);
      toWorld(k * CACTUS_GAP + hash(k + 7) * 8, lat, 0, P);
      const sc = 0.7 + hash(k + 2.2) * 0.9;
      Q.setFromEuler(E.set(0, hash(k + 9) * 6.28, 0));
      M.compose(P, Q, S3.set(sc, sc, sc));
      cacti.setMatrixAt(i, M);
    }
    cacti.instanceMatrix.needsUpdate = true;
    const r0 = Math.floor((me.s - ROCKS * 20 + 30) / 20);
    for (let i = 0; i < ROCKS; i++) {
      const k = r0 + i;
      const side = hash(k + 3.3) > 0.5 ? 1 : -1;
      toWorld(k * 20 + hash(k) * 10, side * (HALF + 3.5 + hash(k + 1.7) * 40), 0, P);
      const sc = 0.3 + Math.pow(hash(k + 5.5), 3) * 2.4;
      Q.setFromEuler(E.set(hash(k) * 3, hash(k + 1) * 3, 0));
      M.compose(P, Q, S3.set(sc * 1.3, sc * 0.7, sc));
      rocks.setMatrixAt(i, M);
    }
    rocks.instanceMatrix.needsUpdate = true;
    const m0 = Math.floor((me.s - MESAS * 90) / 90);
    for (let i = 0; i < MESAS; i++) {
      const k = m0 + i;
      const side = hash(k + 4.4) > 0.5 ? 1 : -1;
      toWorld(k * 90, side * (220 + hash(k + 8) * 260), 0, P);
      const w = 60 + hash(k + 1.1) * 120;
      M.compose(P, Q.identity(), S3.set(w, 25 + hash(k + 6) * 55, w * 0.6));
      mesas.setMatrixAt(i, M);
    }
    mesas.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < signs.length; i++) {
      const k = Math.floor(me.s / 700) - i;
      const s = k * 700 + 300;
      const side = k % 2 === 0 ? -1 : 1;
      place(signs[i], s, side * (HALF + 7), 0, side * 0.45);
    }

    // traffic
    for (let i = 0; i < MAX_TRAFFIC; i++) {
      const t = traffic[i];
      if (!t) { M.makeScale(0, 0, 0); trafficMesh.setMatrixAt(i, M); continue; }
      toWorld(t.s, t.lat, t.y, P);
      Q.setFromEuler(E.set(t.spin * 0.3, heading(t.s) + t.spin, t.spin * 0.6));
      M.compose(P, Q, S3.set(1, 1, 1));
      trafficMesh.setMatrixAt(i, M);
      trafficMesh.setColorAt(i, tmpColor.copy(t.color));
    }
    trafficMesh.instanceMatrix.needsUpdate = true;
    if (trafficMesh.instanceColor) trafficMesh.instanceColor.needsUpdate = true;

    // Mort
    place(foe.root, en.s, en.lat, en.y, 0);
    const lean = en.wreck > 0 ? 0 : clamp((me.lat - en.lat) * 0.02, -0.06, 0.06);
    foe.root.rotation.z = en.roll + lean;
    foe.root.rotation.x = en.wreck > 0 ? en.roll * 0.3 : en.lunge > 0 ? -0.04 : 0;
    for (const w of foe.wheels) w.rotation.x += en.v * 0.016;
    foe.body.position.y = Math.sin(time * 17) * 0.02 + (en.lunge > 0 ? 0.04 : 0);
    const fury = 0.5 + en.rage * 0.4;
    foe.arm.rotation.z = -0.5 - Math.abs(Math.sin(time * (8 + en.rage * 6))) * 0.5;
    foe.arm.rotation.x = Math.sin(time * 11) * 0.25;
    foe.head.rotation.y = Math.sin(time * 1.3) * 0.15;
    foe.head.position.y += 0;
    foe.brows[0].rotation.z = -fury;
    foe.brows[1].rotation.z = fury;
    foe.paint.emissive.setRGB(en.rage * 0.35, 0, 0);
    const live = en.wreck === 0;
    foe.root.updateMatrixWorld(true);
    for (let i = 0; i < 2; i++) {
      tmp.copy(foe.lamps[i]);
      foe.body.localToWorld(tmp);
      beams[i].position.copy(tmp);
      toWorld(en.s + 40, en.lat + (i ? 1 : -1) * 0.8, 0, beams[i].target.position);
      beams[i].intensity = live ? 1400 : 0;
      glares[i].position.copy(tmp);
      const dCam = tmp.distanceTo(camera.position);
      // bigger the closer he gets, the way real headlights blow out a mirror
      glares[i].scale.setScalar(live ? Math.min(4.2, 2.2 + 26 / Math.max(6, dCam)) : 0.001);
    }
    halo.position.copy(glares[0].position).lerp(glares[1].position, 0.5);
    halo.scale.setScalar(live ? Math.min(16, 10 + 160 / Math.max(8, halo.position.distanceTo(camera.position))) : 0.001);

    // projectiles
    for (const b of balls) {
      b.mesh.visible = b.live;
      if (b.live) toWorld(b.s, b.lat, b.y, b.mesh.position);
    }
    for (let i = 0; i < thrown.length; i++) {
      const it = thrown[i];
      it.mesh.visible = it.live;
      warns[i].visible = it.live && !it.passed;
      if (!it.live) continue;
      toWorld(it.s, it.lat, it.y, it.mesh.position);
      it.mesh.rotation.set(it.spin, heading(it.s), it.spin * 0.5);
      toWorld(me.s - 1.2, it.targetLat, 0.06, warns[i].position);
      warns[i].scale.setScalar(1 + Math.sin(time * 20) * 0.15);
    }
    for (const p of puffs) {
      if (!p.live) continue;
      toWorld(p.s, p.lat, p.y, p.sprite.position);
      const k = p.age / p.life;
      p.sprite.scale.setScalar(p.size * (1 + k * p.grow));
      p.mat.opacity = (p.kind === "smoke" ? 0.55 : p.kind === "dust" ? 0.4 : 1) * (1 - k);
      if (p.kind === "fire") p.mat.color.setRGB(1, 0.55 * (1 - k) + 0.15, 0.15 * (1 - k));
    }

    // the arc you are about to fire
    const showAim = phase !== "over";
    reticle.visible = showAim;
    if (showAim) {
      const cp = Math.cos(aim.pitch);
      let s = me.s - 1.15 - 1.55 * cp * Math.cos(aim.yaw);
      let l = me.lat + 1.55 * cp * Math.sin(aim.yaw);
      let y = 1.29 + 1.55 * Math.sin(aim.pitch);
      const vs = -MUZZLE * cp * Math.cos(aim.yaw);
      const vl = MUZZLE * cp * Math.sin(aim.yaw);
      let vy = MUZZLE * Math.sin(aim.pitch);
      const tTot = (vy + Math.sqrt(vy * vy + 2 * G * y)) / G;
      const dtd = tTot / DOTS;
      for (let i = 0; i < DOTS; i++) {
        s += vs * dtd; l += vl * dtd; vy -= G * dtd; y = Math.max(0.1, y + vy * dtd);
        toWorld(s, l, y, P);
        const sc = reload > 0 ? 0.6 : 1;
        M.compose(P, Q.identity(), S3.set(sc, sc, sc));
        dots.setMatrixAt(i, M);
      }
      dots.instanceMatrix.needsUpdate = true;
      toWorld(s, l, 0.05, reticle.position);
      reticle.rotation.set(0, heading(s), 0);
      (reticle.material as THREE.MeshBasicMaterial).color.set(reload > 0 ? 0x8a7a5a : 0xffe08a);
    }
    dots.visible = showAim;

    // his speech bubble, over his cab
    if (talk && en.wreck < 2) {
      toWorld(en.s + foe.len / 2 - 1, en.lat, foe.tall + 1.2, tmp);
      tmp.project(camera);
      const w = canvas.clientWidth;
      const hh = canvas.clientHeight;
      if (tmp.z < 1) {
        bubble.textContent = talk;
        bubble.style.left = `${clamp((tmp.x * 0.5 + 0.5) * w, 80, w - 80)}px`;
        bubble.style.top = `${clamp((-tmp.y * 0.5 + 0.5) * hh, 60, hh - 40)}px`;
        bubble.style.opacity = "1";
      }
    } else bubble.style.opacity = "0";
  };

  /* ------------------------------------------------------------ loop */
  let raf = 0;
  let last = performance.now();
  let hudT = 0;
  let fps = 60;
  let disposed = false;
  const hud = (): ChaseHud => ({
    phase, hull: Math.round(me.hull), score: Math.max(0, Math.round(score)), best: Math.round(best), meters: Math.round(me.s),
    boost: me.boost, reload: 1 - reload / RELOAD, level: en.level,
    ride: RIDES[Math.min(en.level - 1, RIDES.length - 1)].name, foeHp: Math.max(0, en.hp), foeMax: en.max,
    foeWrecked: en.wreck > 0, gap: Math.round(me.s - en.s), hits, wrecks, toast, fps: Math.round(fps),
  });
  const frame = (now: number): void => {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    fps = lerp(fps, 1 / Math.max(dt, 0.001), 0.05);
    step(dt);
    audio.update(me.v, me.s - en.s, en.wreck === 0);
    draw();
    renderer.render(scene, camera);
    hudT -= dt;
    if (hudT <= 0) { hudT = 0.1; opts.onHud?.(hud()); }
  };

  function disposeTree(o: THREE.Object3D): void {
    o.traverse((x) => {
      const m = x as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((y) => y.dispose()); else mat?.dispose();
    });
  }

  const api: CannonRun = {
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("pointerdown", onDown);
      audio.stop();
      scene.traverse((x) => {
        const m = x as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((y) => y.dispose()); else mat?.dispose();
      });
      [roadTex, sand, glow, puffTex, signTex].forEach((t) => t.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      bubble.remove();
      delete (window as unknown as { __chase?: unknown }).__chase;
    },
    setStick(x, y) { stick.x = x; stick.y = y; },
    aimAt(clientX, clientY, f) {
      audio.start();
      const r = canvas.getBoundingClientRect();
      mouseX = clientX - r.left;
      mouseY = clientY - r.top;
      if (f) wantFire = true;
    },
    hold(action, down) { if (action === "boost") held.boost = down; },
    restart() {
      Object.assign(me, { s: 0, lat: 2, vl: 0, v: 31, boost: 1, hull: 100, shake: 0, spin: 0, bump: 0 });
      score = 0; hits = 0; wrecks = 0; time = 0; introT = 0; phase = "intro"; toast = ""; talk = "";
      traffic.length = 0;
      balls.forEach((b) => { b.live = false; });
      thrown.forEach((t) => { t.live = false; });
      puffs.forEach((p) => { p.live = false; p.sprite.visible = false; });
      spawnFoe(1, 140);
      en.v = 40;
    },
    setMuted(m) { muted = m; audio.mute(m); },
  };

  // For scripts that play it without a person: scripts/cannonrun-check.mjs.
  (window as unknown as { __chase?: unknown }).__chase = {
    state: () => ({ ...hud(), lat: me.lat, foeLat: en.lat, foeS: en.s, s: me.s, balls: balls.filter((b) => b.live).length, thrown: thrown.filter((t) => t.live).length, traffic: traffic.length, draws: renderer.info.render.calls, tris: renderer.info.render.triangles }),
    key: (k: string, down: boolean) => { if (down) { if (k === " ") wantFire = true; keys.add(k); } else keys.delete(k); },
    /** Aim at the road by screen fraction (0..1) and fire if asked; no args points back at him. */
    aim: (fx?: number, fy?: number) => { if (fx === undefined || fy === undefined) { mouseX = -1; mouseY = -1; } else { mouseX = fx * canvas.clientWidth; mouseY = (fy ?? 0.5) * canvas.clientHeight; } },
    fire: () => { wantFire = true; },
    level: (n: number, gap = 40) => spawnFoe(n, gap),
    gap: (g: number) => { en.s = me.s - g; },
    hull: (n: number) => { me.hull = n; },
    run: (n: number, dt = 1 / 60) => { for (let k = 0; k < n; k++) step(dt); },
    snapshot: () => { draw(); renderer.render(scene, camera); return canvas.toDataURL("image/jpeg", 0.9); },
  };

  draw();
  raf = requestAnimationFrame(frame);
  opts.onReady?.();
  return api;
}
