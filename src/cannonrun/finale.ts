/**
 * The end of the story. Once the train is wrecked, everybody pulls over at
 * Dot's Diner and it is settled on foot: you (and your friend) against Mad
 * Mort (and Lunatic Linda), in the parking lot, with pies from Dot's counter.
 * Splat them both before Mort hauls the cannon out of your truck bed and the
 * cannon is yours for good.
 *
 * Its own little world: a flat lot in its own scene and camera, which the
 * engine renders instead of the highway once phase is "finale". The host (or
 * the only player) runs it; a guest drives its own hero and draws the rest
 * from the host's snapshots (encode / apply), like the chase.
 *
 * Stages: arrive (cutscene) → standoff (cutscene) → fight → won (cutscene) | lost.
 * `?finale` starts a run here; `?finale=won` jumps to the ending.
 */
import * as THREE from "three";
import { buildMort, buildTruck, buildFoe, box, canvasTex, glowTexture, puffTexture, type Mort, type Truck } from "./models";

export type FinaleStage = "arrive" | "standoff" | "fight" | "won" | "lost";
const STAGES: FinaleStage[] = ["arrive", "standoff", "fight", "won", "lost"];

export interface FinaleHud {
  stage: FinaleStage;
  /** seconds into the stage */
  t: number;
  /** a subtitle: who is talking and what they say */
  who: string;
  line: string;
  /** a big title over everything, or "" */
  title: string;
  /** 0..1 black over the frame (fades between shots) */
  fade: number;
  /** letterbox bars on (the cutscenes) */
  cinema: boolean;
  /** pies in each hero's hands */
  pies: number[];
  /** how far Mort has the cannon out of your truck, 0..1 */
  grab: number;
  foes: { name: string; hp: number; max: number; beaten: boolean }[];
  hint: string;
}

export interface FinaleInput { mx: number; mz: number; throw: boolean }

export interface Finale {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** "auth" runs the rules; "view" (a guest) moves only hero `mine` and eases the rest */
  step(dt: number, inputs: FinaleInput[], role: "auth" | "view", mine?: number): void;
  hud(): FinaleHud;
  /** done: "won" or "lost" once the closing scene has played out */
  done(): "" | "won" | "lost";
  encode(): FinaleSnap;
  apply(s: FinaleSnap, mine: number): void;
  /** the host hears where the guest's hero is, and how many pies it has thrown */
  remote(i: number, x: number, z: number, yaw: number, throws: number): void;
  skip(stage: FinaleStage): void;
  /** for scripts: where everybody is */
  peek(): { heroes: { x: number; z: number; pies: number; stun: number }[]; foes: { x: number; z: number; state: number; hp: number }[]; grab: number; stage: FinaleStage; t: number };
  /** the guest's own throw counter, sent to the host */
  throws: number;
  aspect(a: number): void;
  /** the subtitles, letterbox, titles and fades, drawn into the canvas so a snapshot has them */
  overlay(renderer: THREE.WebGLRenderer, w: number, h: number): void;
  dispose(): void;
}

export interface FinaleSnap { n: number[]; who: string; line: string }

export interface FinaleOpts {
  two: boolean;
  colors: number[];
  plates: string[];
  /** the ride Linda was in when it ended, for her wreck by the road */
  lindaLevel: number;
  thanks: boolean;
  /** "throw", "splat", "shove", "pies", "horn", "boom", "win" */
  sound: (kind: string) => void;
}

/* ------------------------------------------------------------------ the people */

interface Body { root: THREE.Group; head: THREE.Group; armL: THREE.Group; armR: THREE.Group; legL: THREE.Group; legR: THREE.Group; hands: THREE.Group }

/** You: sneakers, jeans, a hoodie in your truck's colour and a red pirate bandana. Faces +z, about 1.75 m. */
function buildHero(color: number, n: number): Body {
  const root = new THREE.Group();
  const hood = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
  const jeans = new THREE.MeshStandardMaterial({ color: 0x2a3550, roughness: 0.85 });
  const shoe = new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.6 });
  const skin = new THREE.MeshStandardMaterial({ color: n ? 0x8a5a3c : 0xe8b090, roughness: 0.7 });
  const band = new THREE.MeshStandardMaterial({ color: n ? 0x1a1a1a : 0xc8202a, roughness: 0.7 });
  const black = new THREE.MeshBasicMaterial({ color: 0x0a0a0a });
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const leg = (sx: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(sx * 0.11, 0.8, 0);
    g.add(box(0.17, 0.74, 0.19, 0, -0.37, 0, jeans));
    g.add(box(0.19, 0.11, 0.3, 0, -0.75, 0.05, shoe));
    root.add(g);
    return g;
  };
  const legL = leg(1);
  const legR = leg(-1);
  root.add(box(0.4, 0.26, 0.24, 0, 0.9, 0, jeans));
  root.add(box(0.44, 0.56, 0.26, 0, 1.24, 0, hood));
  root.add(box(0.3, 0.14, 0.04, 0, 1.12, 0.14, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, transparent: true, opacity: 0.25 }))); // the pocket
  const hoodBack = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), hood);
  hoodBack.position.set(0, 1.48, -0.1);
  hoodBack.rotation.x = -1.2;
  root.add(hoodBack);
  const arm = (sx: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(sx * 0.28, 1.46, 0);
    g.add(box(0.13, 0.52, 0.13, 0, -0.26, 0, hood));
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), skin);
    hand.position.y = -0.56;
    g.add(hand);
    root.add(g);
    return g;
  };
  const armL = arm(1);
  const armR = arm(-1);
  const head = new THREE.Group();
  head.position.set(0, 1.64, 0);
  root.add(head);
  head.add(new THREE.Mesh(new THREE.SphereGeometry(0.17, 16, 12), skin));
  // the bandana, knotted at the back with two tails
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.178, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.42), band);
  cap.rotation.x = -0.15;
  head.add(cap);
  for (const sx of [-1, 1]) {
    const tail = box(0.05, 0.16, 0.02, sx * 0.04, 0.02, -0.18, band);
    tail.rotation.z = sx * 0.4;
    head.add(tail);
  }
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), white);
    eye.position.set(sx * 0.062, 0.02, 0.145);
    head.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.018, 6, 5), black);
    pupil.position.set(sx * 0.062, 0.02, 0.177);
    head.add(pupil);
  }
  const grin = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.012, 6, 12, Math.PI), black);
  grin.rotation.z = Math.PI;
  grin.position.set(0, -0.055, 0.158);
  head.add(grin);
  const hands = new THREE.Group();
  hands.position.set(-0.28, 0.9, 0.12);
  root.add(hands);
  return { root, head, armL, armR, legL, legR, hands };
}

/** Dot, behind the counter: a pink uniform, a grey beehive, a pencil behind the ear. */
function buildDot(): THREE.Group {
  const g = new THREE.Group();
  const pink = new THREE.MeshStandardMaterial({ color: 0xf08aa8, roughness: 0.8 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xf0c0a0, roughness: 0.7 });
  const hair = new THREE.MeshStandardMaterial({ color: 0xb8b8c0, roughness: 0.9 });
  g.add(box(0.5, 0.7, 0.3, 0, 1.15, 0, pink));
  g.add(box(0.36, 0.3, 0.02, 0, 1.0, 0.16, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 })));
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 10), skin);
  head.position.y = 1.68;
  g.add(head);
  const hive = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), hair);
  hive.scale.set(1, 1.5, 1);
  hive.position.set(0, 1.9, -0.03);
  g.add(hive);
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 5), new THREE.MeshBasicMaterial({ color: 0x111111 }));
    eye.position.set(sx * 0.06, 1.7, 0.155);
    g.add(eye);
  }
  const lips = box(0.08, 0.025, 0.02, 0, 1.62, 0.165, new THREE.MeshBasicMaterial({ color: 0xd0203a }));
  g.add(lips);
  return g;
}

/** A pie: a tin, a crust, a filling and a dollop. */
function buildPie(thanks: boolean): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.16, 0.06, 18), new THREE.MeshStandardMaterial({ color: 0xc8ccd2, roughness: 0.3, metalness: 0.8 })));
  const crust = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.03, 6, 18), new THREE.MeshStandardMaterial({ color: 0xd8a060, roughness: 0.8 }));
  crust.rotation.x = Math.PI / 2;
  crust.position.y = 0.04;
  g.add(crust);
  const fill = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.03, 18), new THREE.MeshStandardMaterial({ color: thanks ? 0xd86a1a : 0xb8142a, roughness: 0.5 }));
  fill.position.y = 0.04;
  g.add(fill);
  const cream = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), new THREE.MeshStandardMaterial({ color: 0xfffaf0, roughness: 0.7 }));
  cream.scale.y = 0.7;
  cream.position.y = 0.08;
  g.add(cream);
  return g;
}

/** Cream all over somebody's face. */
function buildSplat(): THREE.Group {
  const g = new THREE.Group();
  const cream = new THREE.MeshStandardMaterial({ color: 0xfffaf0, roughness: 0.6, emissive: 0x222018 });
  const red = new THREE.MeshStandardMaterial({ color: 0xb8142a, roughness: 0.5 });
  const main = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8), cream);
  main.scale.set(1.25, 1.05, 0.45);
  g.add(main);
  for (const [x, y, r, m] of [[0.12, 0.1, 0.06, cream], [-0.13, -0.06, 0.07, cream], [0.05, -0.12, 0.05, red], [-0.06, 0.09, 0.04, red], [0.15, -0.1, 0.045, cream]] as const) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), m);
    b.position.set(x, y, 0.04);
    g.add(b);
  }
  g.position.set(0, 0, 0.17);
  return g;
}

/* ------------------------------------------------------------------ the place */

const LOT = { x0: -17, x1: 17, z0: -14.2, z1: 12 };
const CART = new THREE.Vector3(0, 0, -13.4);
const TRUCK = [new THREE.Vector3(-8, 0, -8.5), new THREE.Vector3(-12.5, 0, -8.5)];
/** where Mort goes to get the cannon: the tailgate of the first truck */
const TAILGATE = new THREE.Vector3(-8, 0, -5.2);

function neonTexture(): THREE.CanvasTexture {
  return canvasTex(1024, 256, (c) => {
    c.fillStyle = "#1a0c14";
    c.fillRect(0, 0, 1024, 256);
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.shadowColor = "#ff4fa8";
    c.shadowBlur = 30;
    c.fillStyle = "#ffd0ea";
    c.font = "bold italic 150px 'Arial Black', Impact, sans-serif";
    c.fillText("DOT'S DINER", 512, 118);
    c.shadowColor = "#5dfff0";
    c.fillStyle = "#c8fffa";
    c.font = "bold 46px 'Arial Black', sans-serif";
    c.fillText("PIE · COFFEE · OPEN 24 HRS", 512, 222);
  });
}

function pylonTexture(): THREE.CanvasTexture {
  return canvasTex(256, 512, (c) => {
    c.fillStyle = "#0e2a3a";
    c.fillRect(0, 0, 256, 512);
    c.strokeStyle = "#ffd36a";
    c.lineWidth = 10;
    c.strokeRect(8, 8, 240, 496);
    c.textAlign = "center";
    c.shadowColor = "#ffb02a";
    c.shadowBlur = 24;
    c.fillStyle = "#ffe8a8";
    c.font = "bold 150px 'Arial Black', Impact, sans-serif";
    c.fillText("E", 128, 160);
    c.fillText("A", 128, 300);
    c.fillText("T", 128, 440);
  });
}

function stallTexture(): THREE.CanvasTexture {
  const t = canvasTex(512, 512, (c) => {
    c.fillStyle = "#44464c";
    c.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 2600; i++) {
      const v = 52 + Math.random() * 26;
      c.fillStyle = `rgb(${v},${v},${v + 3})`;
      c.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
    }
    // a couple of faint oil stains
    for (let i = 0; i < 3; i++) {
      const x = Math.random() * 512, y = Math.random() * 512;
      const g = c.createRadialGradient(x, y, 0, x, y, 40);
      g.addColorStop(0, "rgba(20,20,24,0.25)");
      g.addColorStop(1, "rgba(20,20,24,0)");
      c.fillStyle = g;
      c.fillRect(x - 40, y - 40, 80, 80);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(4, 3);
  return t;
}

/* ------------------------------------------------------------------ lines */

const HIT_MORT = ["MY BEARD!", "IS THAT CHERRY?!", "NOT THE FACE!", "I CAN'T SEE!", "BLUEBERRY? REALLY?", "MMPH! ...that's good pie."];
const HIT_MORT_T = ["PUMPKIN?! IN MY EYES?!", "IS THAT... CINNAMON?", "NOT THE FACE!", "I CAN'T SEE!", "MMPH! ...that's good pie."];
const HIT_LINDA = ["MY HAIR!!", "GRRRRRR!", "OH, IT'S ON NOW!", "THIS HEADBAND WAS NEW!", "I'LL GRIND YOU INTO CRUMBS!"];
const GRAB = ["GRANDPA'S CANNON IS COMING HOME!", "HOLD STILL, YOU BIG IRON BEAUTY!", "GOT IT... GOT IT..."];

interface Hero { body: Body; x: number; z: number; yaw: number; pies: number; stun: number; throwT: number; walk: number; vx: number; vz: number; on: boolean; tx: number; tz: number; tyaw: number; throws: number; seen: number; refillCd: number }
interface Foe { body: Mort; splat: THREE.Group; x: number; z: number; yaw: number; hp: number; max: number; state: number; t: number; linda: boolean; walk: number; vx: number; vz: number; dodgeT: number; shoveCd: number; tx: number; tz: number; tyaw: number; mind: number; mindT: number }
// foe states
const WALK = 0, STUN = 1, GRABBING = 2, BEATEN = 3, CARRY = 4, SHOVE = 5;
interface Pie { mesh: THREE.Group; live: boolean; fx: number; fy: number; fz: number; tx: number; ty: number; tz: number; t: number; dur: number; foe: number; hero: number }

const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smooth = (a: number, b: number, t: number): number => { const k = clamp((t - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];
function angTo(a: number, b: number, k: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

export function createFinale(o: FinaleOpts): Finale {
  const scene = new THREE.Scene();
  const NIGHT = new THREE.Color(0x0b1226);
  const DAWN = new THREE.Color(0x6a4a6a);
  scene.background = NIGHT.clone();
  scene.fog = new THREE.FogExp2(0x0b1226, 0.012);
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 900);
  let aspect = 16 / 9;

  // sky: a dome that goes from night to sunrise in the last scene
  const skyGeo = new THREE.SphereGeometry(600, 24, 12);
  const skyCol = new Float32Array(skyGeo.attributes.position.count * 3);
  skyGeo.setAttribute("color", new THREE.BufferAttribute(skyCol, 3));
  const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  scene.add(sky);
  const paintSky = (dawn: number): void => {
    const p = skyGeo.attributes.position;
    const top = new THREE.Color(0x050a1c).lerp(new THREE.Color(0x3a5a9a), dawn);
    const mid = new THREE.Color(0x101a38).lerp(new THREE.Color(0xd8789a), dawn);
    const low = new THREE.Color(0x1a2040).lerp(new THREE.Color(0xffb060), dawn);
    const c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const h = p.getY(i) / 600;
      // the sunrise is on the +x side, down the road where you drive off
      const east = clamp(p.getX(i) / 600, 0, 1) * dawn;
      if (h < 0.15) c.copy(low).lerp(mid, clamp(h / 0.15, 0, 1));
      else c.copy(mid).lerp(top, clamp((h - 0.15) / 0.5, 0, 1));
      c.lerp(new THREE.Color(0xffc070), east * clamp(1 - h * 3, 0, 1) * 0.8);
      skyCol[i * 3] = c.r; skyCol[i * 3 + 1] = c.g; skyCol[i * 3 + 2] = c.b;
    }
    skyGeo.attributes.color.needsUpdate = true;
  };
  paintSky(0);
  const starGeo = new THREE.BufferGeometry();
  const sp: number[] = [];
  for (let i = 0; i < 500; i++) {
    const a = Math.random() * Math.PI * 2;
    const e = 0.12 + Math.random() * 1.3;
    sp.push(Math.cos(a) * Math.cos(e) * 500, Math.sin(e) * 500, Math.sin(a) * Math.cos(e) * 500);
  }
  starGeo.setAttribute("position", new THREE.Float32BufferAttribute(sp, 3));
  const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true });
  scene.add(new THREE.Points(starGeo, starMat));

  const hemi = new THREE.HemisphereLight(0x8a9ad0, 0x3a2c20, 1.25);
  scene.add(hemi);
  const moon = new THREE.DirectionalLight(0xa8bcff, 1.1);
  moon.position.set(-30, 60, 40);
  scene.add(moon);
  const sun = new THREE.DirectionalLight(0xffb070, 0);
  sun.position.set(120, 20, 0);
  scene.add(sun);
  const glow = glowTexture();
  const halo = (color: number, size: number, op: number): THREE.Sprite => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color, transparent: true, opacity: op, depthWrite: false, blending: THREE.AdditiveBlending }));
    s.scale.setScalar(size);
    scene.add(s);
    return s;
  };

  // the ground: desert, the lot, the road
  const desert = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), new THREE.MeshStandardMaterial({ color: 0x3a2c20, roughness: 1 }));
  desert.rotation.x = -Math.PI / 2;
  desert.position.y = -0.02;
  scene.add(desert);
  const stallTex = stallTexture();
  const lot = new THREE.Mesh(new THREE.PlaneGeometry(LOT.x1 - LOT.x0 + 4, LOT.z1 - LOT.z0 + 4), new THREE.MeshStandardMaterial({ map: stallTex, roughness: 0.9 }));
  lot.rotation.x = -Math.PI / 2;
  lot.position.set(0, 0, (LOT.z0 + LOT.z1) / 2);
  scene.add(lot);
  const paintM = new THREE.MeshBasicMaterial({ color: 0xd8d4c0 });
  for (let i = -3; i <= 3; i++) {
    const line = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 5), paintM);
    line.rotation.x = -Math.PI / 2;
    line.position.set(-10.25 + i * 4.5 + 13.5, 0.01, -9);
    if (Math.abs(line.position.x) < 15.5) scene.add(line);
  }
  const road = new THREE.Mesh(new THREE.PlaneGeometry(400, 9), new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.85 }));
  road.rotation.x = -Math.PI / 2;
  road.position.set(0, 0.005, 17.5);
  scene.add(road);
  const yellow = new THREE.MeshBasicMaterial({ color: 0xe8b830 });
  for (let x = -200; x < 200; x += 6) {
    const dash = new THREE.Mesh(new THREE.PlaneGeometry(3, 0.16), yellow);
    dash.rotation.x = -Math.PI / 2;
    dash.position.set(x, 0.012, 17.5);
    scene.add(dash);
  }
  const curbM = new THREE.MeshStandardMaterial({ color: 0x8a8a84, roughness: 0.9 });
  scene.add(box(LOT.x1 - LOT.x0 + 4, 0.18, 0.4, 0, 0.09, 12.9, curbM));

  // Dot's Diner: a long chrome-and-teal box with a wall of warm windows
  const diner = new THREE.Group();
  diner.position.set(0, 0, -19.5);
  scene.add(diner);
  const teal = new THREE.MeshStandardMaterial({ color: 0x4ab8b0, roughness: 0.45, metalness: 0.3 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xd8dce2, roughness: 0.2, metalness: 0.95 });
  const redM = new THREE.MeshStandardMaterial({ color: 0xc8202a, roughness: 0.5 });
  const win = new THREE.MeshBasicMaterial({ color: 0xffd89a });
  diner.add(box(24, 4.2, 8, 0, 2.1, 0, teal));
  diner.add(box(24.3, 0.5, 8.3, 0, 0.25, 0, chrome));
  diner.add(box(24.3, 0.35, 8.3, 0, 4.3, 0, chrome));
  diner.add(box(24.1, 0.4, 0.1, 0, 1.25, 4.02, redM));
  for (let i = 0; i < 8; i++) {
    if (i === 3 || i === 4) continue;
    diner.add(box(2.3, 1.6, 0.06, -10.5 + i * 3, 2.55, 4.03, win));
  }
  // the service window and Dot in it, the pie cart under it
  diner.add(box(4.4, 1.9, 0.06, 0, 2.5, 4.03, new THREE.MeshBasicMaterial({ color: 0xfff0d0 })));
  diner.add(box(4.8, 0.14, 0.7, 0, 1.5, 4.3, chrome));
  const dot = buildDot();
  dot.position.set(0, 0.6, 3.7);
  diner.add(dot);
  const awning = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 5.2, 16, 1, false, 0, Math.PI), new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.6 }));
  awning.rotation.z = Math.PI / 2;
  awning.rotation.y = Math.PI / 2;
  awning.position.set(0, 3.6, 4.2);
  diner.add(awning);
  const neon = new THREE.Mesh(new THREE.PlaneGeometry(12, 3), new THREE.MeshBasicMaterial({ map: neonTexture(), transparent: false }));
  neon.position.set(0, 6.3, 0.6);
  diner.add(neon);
  diner.add(box(12.4, 0.2, 0.3, 0, 4.75, 0.5, chrome));
  for (const sx of [-5.5, 5.5]) diner.add(box(0.15, 1.6, 0.15, sx, 5.2, 0.5, chrome));
  const neonGlow = halo(0xff4fa8, 16, 0.35);
  neonGlow.position.set(0, 6.3, -18.6);
  const winGlow = halo(0xffc080, 26, 0.3);
  winGlow.position.set(0, 2.5, -15);
  const warm = new THREE.PointLight(0xffb070, 260, 34, 1.5);
  warm.position.set(0, 3.2, -14);
  scene.add(warm);
  // the pie cart
  const cart = new THREE.Group();
  cart.position.copy(CART);
  scene.add(cart);
  cart.add(box(2.6, 0.9, 0.9, 0, 0.45, 0, redM));
  cart.add(box(2.7, 0.06, 1.0, 0, 0.93, 0, chrome));
  const cartPies: THREE.Group[] = [];
  for (let i = 0; i < 6; i++) {
    const p = buildPie(o.thanks);
    p.position.set(-0.95 + (i % 3) * 0.95, 1.0 + Math.floor(i / 3) * 0.0, i < 3 ? -0.2 : 0.22);
    cart.add(p);
    cartPies.push(p);
  }
  const cartGlow = halo(0xffe08a, 4.5, 0);
  cartGlow.position.set(CART.x, 1.4, CART.z);

  // the EAT pylon and two lot lights
  const pylon = new THREE.Group();
  pylon.position.set(15, 0, 9);
  scene.add(pylon);
  pylon.add(box(0.3, 7, 0.3, 0, 3.5, 0, chrome));
  const eat = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 4.4), new THREE.MeshBasicMaterial({ map: pylonTexture(), side: THREE.DoubleSide }));
  eat.position.set(0, 8.2, 0);
  eat.rotation.y = -0.5;
  pylon.add(eat);
  const eatGlow = halo(0xffb02a, 9, 0.3);
  eatGlow.position.set(15, 8.2, 9);
  for (const [x, z] of [[-16, 6], [13, -11], [-16, -12], [16, 4]] as const) {
    scene.add(box(0.18, 6.5, 0.18, x, 3.25, z, chrome));
    scene.add(box(1.2, 0.15, 0.5, x + 0.5, 6.5, z, chrome));
    const l = new THREE.PointLight(0xffc27a, 200, 24, 1.4);
    l.position.set(x + 0.6, 6.2, z);
    scene.add(l);
    const h = halo(0xffd090, 5, 0.55);
    h.position.set(x + 0.6, 6.3, z);
  }
  // a few cactus silhouettes and distant mesas
  const cactusM = new THREE.MeshStandardMaterial({ color: 0x1a2a1a, roughness: 1 });
  for (const [x, z, s] of [[-26, -8, 1.4], [24, -12, 1.1], [-30, 20, 1.6], [34, 30, 1.2], [-8, 34, 1.3]] as const) {
    const g = new THREE.Group();
    g.add(box(0.5, 3.5, 0.5, 0, 1.75, 0, cactusM));
    g.add(box(0.35, 1.2, 0.35, 0.6, 2.2, 0, cactusM));
    g.add(box(0.6, 0.3, 0.3, 0.35, 1.6, 0, cactusM));
    g.position.set(x, 0, z);
    g.scale.setScalar(s);
    scene.add(g);
  }
  const mesaM = new THREE.MeshStandardMaterial({ color: 0x1a1420, roughness: 1 });
  for (const [x, z, w, h] of [[-120, -160, 90, 26], [40, -200, 140, 34], [180, -90, 70, 20], [-200, 60, 80, 22]] as const) scene.add(box(w, h, 40, x, h / 2, z, mesaM));

  // the wrecks by the road: the train on its side, smoking, and Linda's ride
  const train = buildFoe(6);
  train.mort.root.visible = false;
  train.root.position.set(13, 1.3, 19.5);
  train.root.rotation.set(0, Math.PI / 2 + 0.25, Math.PI / 2 * 0.92);
  scene.add(train.root);
  const fire = new THREE.PointLight(0xff7a2a, 120, 22, 1.5);
  fire.position.set(12, 2, 17);
  scene.add(fire);
  let lindaWreck: ReturnType<typeof buildFoe> | null = null;
  if (o.two) {
    lindaWreck = buildFoe(Math.max(1, o.lindaLevel), true);
    lindaWreck.mort.root.visible = false;
    lindaWreck.root.position.set(-4, 0, 20.5);
    lindaWreck.root.rotation.set(0, -Math.PI / 2 - 0.4, 0.25);
    scene.add(lindaWreck.root);
  }
  const puffTex = puffTexture();
  const smoke: { s: THREE.Sprite; age: number; life: number; x: number; z: number }[] = [];
  for (let i = 0; i < 26; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, color: 0x3a3a3c, transparent: true, depthWrite: false, opacity: 0 }));
    scene.add(s);
    smoke.push({ s, age: Math.random() * 4, life: 4, x: 0, z: 0 });
  }

  // your trucks, parked nose-in by the diner, tailgates to the lot
  const trucks: Truck[] = [];
  for (let i = 0; i < (o.two ? 2 : 1); i++) {
    const t = buildTruck(o.colors[i], o.plates[i]);
    t.root.position.copy(TRUCK[i]);
    t.root.rotation.y = Math.PI;
    t.cannon.yaw.rotation.y = 0;
    t.cannon.pitch.rotation.x = 0.12;
    if (i > 0) { t.cannon.root.visible = false; t.kit.visible = false; }
    scene.add(t.root);
    trucks.push(t);
  }
  const cannon = trucks[0].cannon.root;
  const headL = new THREE.SpotLight(0xfff0d0, 0, 40, 0.5, 0.5, 1.4);
  scene.add(headL);
  scene.add(headL.target);

  /* --------------------------------------------------------------- the cast */
  const heroes: Hero[] = [];
  for (let i = 0; i < (o.two ? 2 : 1); i++) {
    const body = buildHero(o.colors[i], i);
    scene.add(body.root);
    const carried = buildPie(o.thanks);
    carried.scale.setScalar(0.9);
    body.hands.add(carried);
    heroes.push({ body, x: 0, z: 0, yaw: 0, pies: 3, stun: 0, throwT: 0, walk: 0, vx: 0, vz: 0, on: true, tx: 0, tz: 0, tyaw: 0, throws: 0, seen: 0, refillCd: 0 });
  }
  const foes: Foe[] = [];
  const addFoe = (linda: boolean): void => {
    const body = buildMort(linda);
    body.root.scale.setScalar(linda ? 0.95 : 1.02);
    scene.add(body.root);
    const splat = buildSplat();
    splat.visible = false;
    body.head.add(splat);
    const max = linda ? 5 : o.two ? 7 : 6;
    foes.push({ body, splat, x: 0, z: 0, yaw: 0, hp: max, max, state: WALK, t: 0, linda, walk: 0, vx: 0, vz: 0, dodgeT: 0, shoveCd: 2, tx: 0, tz: 0, tyaw: 0, mind: 0, mindT: 4 });
  };
  addFoe(false);
  if (o.two) addFoe(true);
  const carriedCannon = buildTruck(0x000000, "").cannon.root;
  carriedCannon.scale.setScalar(0.85);
  carriedCannon.rotation.y = Math.PI / 2;
  carriedCannon.position.set(0, -0.42, 0.05);
  carriedCannon.visible = false;
  foes[0].body.hands.add(carriedCannon);

  const pies: Pie[] = [];
  for (let i = 0; i < 10; i++) {
    const mesh = buildPie(o.thanks);
    mesh.visible = false;
    scene.add(mesh);
    pies.push({ mesh, live: false, fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0, t: 0, dur: 1, foe: -1, hero: 0 });
  }
  // dropped pies stay on the asphalt for a bit
  const drops: { m: THREE.Mesh; age: number }[] = [];
  const dropGeo = new THREE.CircleGeometry(0.32, 14);
  dropGeo.rotateX(-Math.PI / 2);
  const dropMat = new THREE.MeshStandardMaterial({ color: 0xf6ecd8, roughness: 0.6 });
  for (let i = 0; i < 8; i++) {
    const m = new THREE.Mesh(dropGeo, dropMat);
    m.visible = false;
    scene.add(m);
    drops.push({ m, age: 99 });
  }
  let dropNext = 0;

  /* --------------------------------------------------------------- state */
  let stage: FinaleStage = "arrive";
  let st = 0;
  let grab = 0;
  let who = "";
  let line = "";
  let lineT = 0;
  let ended: "" | "won" | "lost" = "";
  let doneT = 0;
  let time = 0;
  const say = (w: string, l: string, d = 2.6): void => { who = w; line = l; lineT = d; };

  const place = (): void => {
    heroes.forEach((h, i) => { h.x = i ? -11 : -6; h.z = -3.2; h.yaw = Math.PI * 0.75; h.pies = 3; h.stun = 0; h.on = true; h.body.root.visible = true; h.tx = h.x; h.tz = h.z; h.tyaw = h.yaw; });
    foes.forEach((f) => {
      f.x = f.linda ? 6 : 11; f.z = 16.5; f.yaw = Math.PI; f.hp = f.max; f.state = WALK; f.t = 0; f.splat.visible = false;
      f.tx = f.x; f.tz = f.z; f.tyaw = f.yaw;
      f.body.root.position.y = 0;
      f.body.legL.rotation.set(0, 0, 0); f.body.legR.rotation.set(0, 0, 0);
    });
    grab = 0;
    cannon.visible = true;
    carriedCannon.visible = false;
    trucks.forEach((t, i) => { t.root.position.copy(TRUCK[i]); t.root.rotation.y = Math.PI; t.root.visible = true; });
  };
  place();

  const goStage = (s: FinaleStage): void => {
    stage = s;
    st = 0;
    if (s === "fight") {
      // walk them into their marks if a cutscene was skipped
      foes.forEach((f) => { if (f.z > 9) { f.x = f.linda ? 5 : 9; f.z = 6; } f.state = WALK; f.t = 0; });
      say("", o.two ? "Pie them both before Mort gets the cannon out of your truck!" : "Pie Mort before he gets the cannon out of your truck!", 3.4);
    }
    if (s === "won") {
      o.sound("win");
      foes.forEach((f, i) => { f.state = BEATEN; f.t = 0; f.splat.visible = true; f.hp = 0; f.tx = i ? 1.2 : -0.6; f.tz = 12.2; });
      pies.forEach((p) => { p.live = false; p.mesh.visible = false; });
      who = ""; line = "";
    }
    if (s === "lost") {
      const m = foes[0];
      m.state = CARRY; m.t = 0;
      cannon.visible = false;
      carriedCannon.visible = true;
      say("MORT", "HA! Grandpa's cannon is coming HOME!", 3);
    }
  };

  /* --------------------------------------------------------------- the rules */
  const nearestFoe = (x: number, z: number, range: number): number => {
    let best = -1;
    let bd = range;
    foes.forEach((f, i) => {
      if (f.state === BEATEN || f.state === CARRY) return;
      const d = Math.hypot(f.x - x, f.z - z);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };
  const throwPie = (hi: number): void => {
    const h = heroes[hi];
    if (h.pies <= 0 || h.stun > 0 || h.throwT > 0.15 || stage !== "fight") return;
    const p = pies.find((q) => !q.live);
    if (!p) return;
    h.pies -= 1;
    h.throwT = 0.45;
    const fi = nearestFoe(h.x, h.z, 18);
    const fx = h.x + Math.sin(h.yaw) * 0.4;
    const fz = h.z + Math.cos(h.yaw) * 0.4;
    let tx: number, tz: number;
    if (fi >= 0) {
      const f = foes[fi];
      const d = Math.hypot(f.x - fx, f.z - fz);
      const dur = clamp(d / 15, 0.18, 1.1);
      // lead him a little
      tx = f.x + f.vx * dur * 0.9;
      tz = f.z + f.vz * dur * 0.9;
      h.yaw = Math.atan2(f.x - h.x, f.z - h.z);
      Object.assign(p, { live: true, fx, fy: 1.5, fz, tx, ty: 1.75, tz, t: 0, dur, foe: fi, hero: hi });
      // he might see it coming and duck aside (not while he is busy with the cannon)
      if (f.state === WALK && Math.random() < (f.linda ? 0.18 : 0.25)) f.dodgeT = 0.45;
    } else {
      tx = h.x + Math.sin(h.yaw) * 9;
      tz = h.z + Math.cos(h.yaw) * 9;
      Object.assign(p, { live: true, fx, fy: 1.5, fz, tx, ty: 0.05, tz, t: 0, dur: 0.6, foe: -1, hero: hi });
    }
    p.mesh.visible = true;
    o.sound("throw");
  };
  const dropAt = (x: number, z: number): void => {
    const d = drops[dropNext];
    dropNext = (dropNext + 1) % drops.length;
    d.m.position.set(x, 0.015, z);
    d.m.visible = true;
    d.age = 0;
  };
  const landPie = (p: Pie): void => {
    p.live = false;
    p.mesh.visible = false;
    const f = foes[p.foe];
    if (f && f.state !== BEATEN && f.state !== CARRY && Math.hypot(f.x - p.tx, f.z - p.tz) < 1.0) {
      f.hp -= 1;
      f.splat.visible = true;
      o.sound("splat");
      const away = Math.atan2(f.x - heroes[p.hero].x, f.z - heroes[p.hero].z);
      f.vx = Math.sin(away) * (f.state === GRABBING ? 5 : 2.5);
      f.vz = Math.cos(away) * (f.state === GRABBING ? 5 : 2.5);
      if (f.hp <= 0) {
        f.state = BEATEN;
        f.t = 0;
        say(f.linda ? "LINDA" : "MORT", f.linda ? "Okay! OKAY! I'm out! ...is there whipped cream in my EAR?" : "ENOUGH! Enough pie!", 2.8);
      } else {
        f.state = STUN;
        f.t = 0;
        say(f.linda ? "LINDA" : "MORT", pick(f.linda ? HIT_LINDA : o.thanks ? HIT_MORT_T : HIT_MORT), 1.8);
      }
    } else {
      dropAt(p.tx, p.tz);
      o.sound("miss");
    }
  };
  const blockTrucks = (e: { x: number; z: number }, r: number): void => {
    for (let i = 0; i < trucks.length; i++) {
      const c = TRUCK[i];
      // the truck is about 2 m wide and 5.5 m long, centred a little ahead of its position
      const dx = e.x - c.x;
      const dz = e.z - (c.z + 0.2);
      const hx = 1.0 + r, hz = 2.9 + r;
      if (Math.abs(dx) < hx && Math.abs(dz) < hz) {
        const px = hx - Math.abs(dx), pz = hz - Math.abs(dz);
        if (px < pz) e.x = c.x + Math.sign(dx || 1) * hx; else e.z = c.z + 0.2 + Math.sign(dz || 1) * hz;
      }
    }
    e.x = clamp(e.x, LOT.x0, LOT.x1);
    e.z = clamp(e.z, LOT.z0, LOT.z1 + 4);
    if (Math.abs(e.x - CART.x) < 1.3 + r && e.z < CART.z + 0.45 + r) e.z = CART.z + 0.45 + r;
  };

  const stepHero = (h: Hero, hi: number, inp: FinaleInput, dt: number): void => {
    h.stun = Math.max(0, h.stun - dt);
    h.throwT = Math.max(0, h.throwT - dt);
    h.refillCd = Math.max(0, h.refillCd - dt);
    let mx = inp.mx, mz = inp.mz;
    const m = Math.hypot(mx, mz);
    if (m > 1) { mx /= m; mz /= m; }
    const can = stage === "fight" && h.stun <= 0;
    const sp = 5.6;
    const want = can ? { x: mx * sp, z: mz * sp } : { x: 0, z: 0 };
    h.vx = lerp(h.vx, want.x, Math.min(1, dt * 12));
    h.vz = lerp(h.vz, want.z, Math.min(1, dt * 12));
    h.x += h.vx * dt;
    h.z += h.vz * dt;
    blockTrucks(h, 0.35);
    const v = Math.hypot(h.vx, h.vz);
    if (v > 0.4 && h.throwT <= 0) h.yaw = angTo(h.yaw, Math.atan2(h.vx, h.vz), Math.min(1, dt * 14));
    h.walk += v * dt * 2.4;
    if (can && inp.throw) throwPie(hi);
    // the pie cart: three more, and Dot says so
    if (stage === "fight" && h.pies < 3 && Math.hypot(h.x - CART.x, h.z - (CART.z + 1)) < 2.1 && h.refillCd <= 0) {
      h.pies = 3;
      h.refillCd = 1;
      o.sound("pies");
      say("DOT", pick(["Fresh pies, hon!", "On the house, sugar!", "Aim for the beard, dear.", "Cherry's still warm!"]), 1.6);
    }
  };

  const stepFoe = (f: Foe, dt: number): void => {
    f.t += dt;
    f.shoveCd = Math.max(0, f.shoveCd - dt);
    f.dodgeT = Math.max(0, f.dodgeT - dt);
    // knockback bleeds off
    f.x += f.vx * dt;
    f.z += f.vz * dt;
    const k = Math.pow(0.02, dt);
    f.vx *= k;
    f.vz *= k;
    if (f.state === STUN) {
      if (f.t > 1.7) { f.state = WALK; f.t = 0; f.splat.visible = f.hp < f.max * 0.5; }
      blockTrucks(f, 0.45);
      return;
    }
    if (f.state === SHOVE) {
      if (f.t > 0.6) { f.state = WALK; f.t = 0; }
      return;
    }
    if (f.state !== WALK && f.state !== GRABBING) return;
    // Linda mostly goes after you; every so often she has a go at the cannon too
    f.mindT -= dt;
    if (f.mindT <= 0) { f.mind = f.linda ? (Math.random() < 0.4 ? 1 : 0) : 1; f.mindT = 3 + Math.random() * 3; }
    let gx = TAILGATE.x + (f.linda ? 1.1 : 0), gz = TAILGATE.z;
    let near: Hero | null = null;
    let nd = 1e9;
    for (const h of heroes) { const d = Math.hypot(h.x - f.x, h.z - f.z); if (d < nd) { nd = d; near = h; } }
    if (f.linda && f.mind === 0 && near) { gx = near.x; gz = near.z; }
    // shove anybody standing in the way
    if (near && nd < 1.25 && f.shoveCd <= 0) {
      const a = Math.atan2(near.x - f.x, near.z - f.z);
      near.vx = Math.sin(a) * 9;
      near.vz = Math.cos(a) * 9;
      near.stun = 0.7;
      f.state = SHOVE;
      f.t = 0;
      f.shoveCd = f.linda ? 1.6 : 2.4;
      f.yaw = a;
      o.sound("shove");
      say(f.linda ? "LINDA" : "MORT", pick(f.linda ? ["OUTTA MY WAY, PIRATE!", "HRRRGH!", "MOVE IT!"] : ["MOVE!", "OUTTA THE WAY!", "NOT TODAY!"]), 1.4);
      return;
    }
    const dx = gx - f.x, dz = gz - f.z;
    const d = Math.hypot(dx, dz);
    const atCannon = Math.hypot(TAILGATE.x - f.x, TAILGATE.z - f.z) < 1.3;
    if (atCannon && (f.mind === 1 || !f.linda)) {
      if (f.state !== GRABBING) { f.state = GRABBING; f.t = 0; if (!f.linda) say("MORT", pick(GRAB), 2); }
      f.yaw = angTo(f.yaw, Math.PI, Math.min(1, dt * 6));
      return;
    }
    if (f.state === GRABBING) { f.state = WALK; f.t = 0; }
    const sp = (f.linda ? 3.3 : o.two ? 2.9 : 2.6) * (f.dodgeT > 0 ? 0.4 : 1);
    if (d > 0.3) {
      f.x += (dx / d) * sp * dt;
      f.z += (dz / d) * sp * dt;
      f.yaw = angTo(f.yaw, Math.atan2(dx, dz), Math.min(1, dt * 7));
      f.walk += sp * dt * 2.2;
    }
    if (f.dodgeT > 0) {
      // a quick hop sideways
      f.x += Math.cos(f.yaw) * 6 * dt;
      f.z -= Math.sin(f.yaw) * 6 * dt;
    }
    blockTrucks(f, 0.45);
  };

  /* --------------------------------------------------------------- the script */
  // the cutscene lines, from the stage clock, so a guest hears them too
  const ARRIVE: [number, string, string][] = [
    [0.4, "", "DOT'S DINER, ROUTE 66. 2:14 AM."],
    [3.3, "MORT", o.two ? "END OF THE LINE, PIRATES! ...LINDA, GET OVER HERE!" : "END OF THE LINE, PIRATE!"],
  ];
  const STANDOFF: [number, string, string][] = [
    [0.2, "DOT", "Not in my parking lot, you don't!"],
    [2.2, "DOT", "...unless it's with PIE. Pies are on the house!"],
  ];
  const WON: [number, string, string][] = o.two
    ? [[1.0, "MORT", "Okay. OKAY. We give up."], [3.6, "LINDA", "I'm not even mad. This pie is incredible."], [6.4, "MORT", "Grandpa's cannon... take care of it. He'd have liked you two."], [9.4, "", ""]]
    : [[1.0, "MORT", "Okay. OKAY. I give up."], [3.6, "MORT", "That's Grandpa's cannon, you know."], [6.4, "MORT", "...Take care of it. He'd have liked you."], [9.4, "", ""]];
  const scriptAt = (lines: [number, string, string][], t: number): void => {
    let cur: [number, string, string] | null = null;
    for (const l of lines) if (t >= l[0]) cur = l;
    if (cur) { who = cur[1]; line = cur[2]; lineT = 0.5; }
  };
  const ARRIVE_T = 6.6, STANDOFF_T = 4.6, WON_T = 19, LOST_T = 7;

  const stepScript = (dt: number, auth: boolean): void => {
    if (stage === "arrive") {
      scriptAt(ARRIVE, st);
      // they climb out of the wrecks and walk into the lot
      foes.forEach((f) => {
        const gx = f.linda ? 4.5 : 8.5, gz = f.linda ? 7.5 : 5.5;
        const k = smooth(1.2, 6.2, st);
        const sx = f.linda ? -4 : 11, sz = f.linda ? 18 : 16.5;
        const nx = lerp(sx, gx, k), nz = lerp(sz, gz, k);
        if (Math.hypot(nx - f.x, nz - f.z) > 0.001) { f.walk += Math.hypot(nx - f.x, nz - f.z) * 2.2; f.yaw = Math.atan2(nx - f.x, nz - f.z); }
        f.x = nx; f.z = nz;
      });
      if (auth && st > ARRIVE_T) goStage("standoff");
    } else if (stage === "standoff") {
      scriptAt(STANDOFF, st);
      foes.forEach((f) => { f.yaw = angTo(f.yaw, Math.atan2(heroes[0].x - f.x, heroes[0].z - f.z), Math.min(1, dt * 4)); });
      heroes.forEach((h) => { h.yaw = angTo(h.yaw, Math.atan2(foes[0].x - h.x, foes[0].z - h.z), Math.min(1, dt * 4)); });
      if (auth && st > STANDOFF_T) goStage("fight");
    } else if (stage === "won") {
      scriptAt(WON, st);
      // the beaten pair sit down on the curb; you two walk to the truck and drive off into the sunrise
      foes.forEach((f) => {
        const k = Math.min(1, dt * 1.6);
        if (st < 0.8) return;
        const d = Math.hypot(f.tx - f.x, f.tz - f.z);
        if (d > 0.1) { f.x = lerp(f.x, f.tx, k); f.z = lerp(f.z, f.tz, k); f.walk += d * k * 2.2; f.yaw = angTo(f.yaw, Math.atan2(f.tx - f.x, f.tz - f.z), k * 3); }
        else f.yaw = angTo(f.yaw, Math.PI, k * 2);
      });
      heroes.forEach((h, i) => {
        if (st < 8.5) { h.yaw = angTo(h.yaw, Math.atan2(foes[0].x - h.x, foes[0].z - h.z), Math.min(1, dt * 3)); return; }
        const gx = TRUCK[0].x + (i ? -1.6 : 1.6), gz = TRUCK[0].z - 1.2;
        const d = Math.hypot(gx - h.x, gz - h.z);
        if (d > 0.4 && h.on) { const sp = 4 * dt; h.x += ((gx - h.x) / d) * Math.min(sp, d); h.z += ((gz - h.z) / d) * Math.min(sp, d); h.walk += sp * 2.4; h.yaw = Math.atan2(gx - h.x, gz - h.z); }
        else if (h.on && st > 10.6) { h.on = false; h.body.root.visible = false; o.sound("door"); }
      });
      // the truck backs out, turns onto the road and goes east
      const tr = trucks[0].root;
      if (st > 11.4) {
        const u = st - 11.4;
        if (u < 2.6) {
          const k = smooth(0, 2.6, u);
          tr.position.set(lerp(TRUCK[0].x, -2, k), 0, lerp(TRUCK[0].z, 15.6, k));
          tr.rotation.y = lerp(Math.PI, Math.PI / 2, k);
        } else {
          const v = Math.min(22, (u - 2.6) * 7);
          tr.rotation.y = Math.PI / 2;
          tr.position.x += v * dt;
          tr.position.z = lerp(tr.position.z, 15.6, Math.min(1, dt * 3));
        }
        if (u > 0.3 && u - dt <= 0.3) o.sound("horn");
        for (const w of trucks[0].wheels) w.rotation.x += dt * 8;
        if (trucks[1]) {
          const t2 = trucks[1].root;
          const u2 = u - 1.2;
          if (u2 > 0) {
            if (u2 < 2.6) { const k = smooth(0, 2.6, u2); t2.position.set(lerp(TRUCK[1].x, -6, k), 0, lerp(TRUCK[1].z, 15.6, k)); t2.rotation.y = lerp(Math.PI, Math.PI / 2, k); }
            else { t2.rotation.y = Math.PI / 2; t2.position.x += Math.min(22, (u2 - 2.6) * 7) * dt; }
          }
        }
      }
      if (st > 9.4) { who = ""; line = ""; }
      if (auth && st > WON_T && !ended) ended = "won";
    } else if (stage === "lost") {
      const m = foes[0];
      // he walks off with it, back to the road
      const gx = 6, gz = 18;
      const d = Math.hypot(gx - m.x, gz - m.z);
      if (d > 0.3) { const sp = 2.1 * dt; m.x += ((gx - m.x) / d) * sp; m.z += ((gz - m.z) / d) * sp; m.walk += sp * 2; m.yaw = Math.atan2(gx - m.x, gz - m.z); }
      if (st > 3.2 && st - dt <= 3.2) say("", "Mort got Grandpa's cannon back.", 3.6);
      if (auth && st > LOST_T && !ended) ended = "lost";
    }
  };

  /* --------------------------------------------------------------- drawing */
  const tmpV = new THREE.Vector3();
  const camPos = new THREE.Vector3(30, 10, 40);
  const camLook = new THREE.Vector3(0, 1, 0);
  let camReady = false;
  const pose = (b: Body | Mort, walk: number, moving: number): void => {
    const s = Math.sin(walk) * 0.7 * moving;
    b.legL.rotation.x = s;
    b.legR.rotation.x = -s;
    b.armL.rotation.x = -s * 0.8;
    b.armR.rotation.x = s * 0.8;
    b.armL.rotation.z = 0;
    b.armR.rotation.z = 0;
  };
  const shot = (px: number, py: number, pz: number, lx: number, ly: number, lz: number): void => { camPos.set(px, py, pz); camLook.set(lx, ly, lz); };
  const lastPos = new Map<object, [number, number]>();
  const speedOf = (key: object, x: number, z: number, dt: number): number => {
    const p = lastPos.get(key);
    lastPos.set(key, [x, z]);
    if (!p || dt <= 0) return 0;
    return Math.hypot(x - p[0], z - p[1]) / dt;
  };

  const draw = (dt: number): void => {
    time += dt;
    // heroes
    heroes.forEach((h) => {
      const b = h.body;
      b.root.position.set(h.x, 0, h.z);
      b.root.rotation.y = h.yaw;
      const v = Math.min(1, speedOf(h, h.x, h.z, dt) / 4);
      pose(b, h.walk, v);
      if (h.throwT > 0) {
        // wind up and fling, right arm over the top
        const k = h.throwT / 0.45;
        b.armR.rotation.x = k > 0.6 ? -2.6 * ((1 - k) / 0.4) : -2.6 + (0.6 - k) * 4.5;
      }
      if (h.stun > 0) { b.root.rotation.z = Math.sin(time * 18) * 0.12; } else b.root.rotation.z = 0;
      b.hands.visible = h.pies > 0 && stage === "fight";
      b.hands.position.set(-0.28, h.throwT > 0 ? 1.7 : 0.9, 0.18);
    });
    // foes
    foes.forEach((f) => {
      const b = f.body;
      b.root.position.set(f.x, 0, f.z);
      b.root.rotation.y = f.yaw;
      const v = Math.min(1, speedOf(f, f.x, f.z, dt) / 3);
      pose(b, f.walk, v);
      b.root.rotation.z = 0;
      b.root.position.y = 0;
      b.head.rotation.set(0, 0, 0);
      if (f.state === STUN) {
        b.root.rotation.z = Math.sin(time * 14) * 0.15;
        b.armL.rotation.x = -2.4 + Math.sin(time * 20) * 0.3; // wiping the pie off
        b.armR.rotation.x = -2.2 + Math.cos(time * 19) * 0.3;
      } else if (f.state === GRABBING) {
        b.armL.rotation.x = -1.4 + Math.sin(time * 9) * 0.25;
        b.armR.rotation.x = -1.4 + Math.cos(time * 9) * 0.25;
        b.root.rotation.x = 0.25;
      } else if (f.state === SHOVE) {
        const k = Math.sin(Math.min(1, f.t / 0.3) * Math.PI);
        b.armL.rotation.x = -1.5 * k;
        b.armR.rotation.x = -1.5 * k;
      } else if (f.state === CARRY) {
        b.armL.rotation.x = -1.1;
        b.armR.rotation.x = -1.1;
      } else if (f.state === BEATEN) {
        const seated = stage === "won" && Math.hypot(f.tx - f.x, f.tz - f.z) < 0.3;
        if (seated) {
          // sat on the curb, legs out, elbows on knees, head hung
          b.root.position.y = -0.45;
          b.legL.rotation.x = -1.45;
          b.legR.rotation.x = -1.45;
          b.armL.rotation.x = -0.9;
          b.armR.rotation.x = -0.9;
          b.head.rotation.x = 0.35 + Math.sin(time * 1.3) * 0.04;
        } else if (stage !== "won") {
          b.root.rotation.z = 0.08 * Math.sin(time * 3);
          b.head.rotation.x = 0.4;
          b.armL.rotation.z = 0.5;
          b.armR.rotation.z = -0.5;
        }
      }
      if (f.state !== GRABBING) b.root.rotation.x = 0;
      // grinding teeth / shouting
      b.mouth.scale.y = f.linda ? 1.6 + Math.sin(time * 30) * 0.15 : f.state === STUN || f.state === SHOVE ? 3 : 1;
    });
    // pies in flight
    for (const p of pies) {
      if (!p.live) continue;
      const k = clamp(p.t / p.dur, 0, 1);
      p.mesh.position.set(lerp(p.fx, p.tx, k), lerp(p.fy, p.ty, k) + Math.sin(k * Math.PI) * 0.9, lerp(p.fz, p.tz, k));
      p.mesh.rotation.set(Math.PI / 2 - 0.3, 0, time * 12);
    }
    for (const d of drops) { d.age += dt; if (d.age > 6) d.m.visible = false; }
    // the cart glows when somebody is low
    const low = stage === "fight" && heroes.some((h) => h.pies === 0);
    (cartGlow.material as THREE.SpriteMaterial).opacity = low ? 0.45 + Math.sin(time * 6) * 0.2 : stage === "standoff" ? 0.35 : 0;
    cartPies.forEach((p, i) => { p.position.y = 1.0 + (low ? Math.abs(Math.sin(time * 5 + i)) * 0.08 : 0); });
    // the cannon rocks in the bed as he pulls at it
    cannon.position.z = -1.15 + grab * 1.4;
    cannon.rotation.x = grab > 0 ? Math.sin(time * 16) * 0.04 * grab : 0;
    // smoke off the train
    for (const s of smoke) {
      s.age += dt;
      if (s.age > s.life) { s.age = 0; s.life = 3 + Math.random() * 2; s.x = 11 + Math.random() * 3; s.z = 17 + Math.random() * 3; }
      const k = s.age / s.life;
      s.s.position.set(s.x + k * 2, 1.5 + k * 9, s.z - k * 1.5);
      s.s.scale.setScalar(1.2 + k * 5);
      (s.s.material as THREE.SpriteMaterial).opacity = Math.sin(k * Math.PI) * 0.55;
    }
    fire.intensity = 110 + Math.sin(time * 23) * 30 + Math.sin(time * 7) * 20;
    (neonGlow.material as THREE.SpriteMaterial).opacity = 0.3 + (Math.sin(time * 40) > 0.97 ? -0.2 : 0);
    // the sunrise in the last scene
    const dawn = stage === "won" ? smooth(8, 18, st) : 0;
    if (dawn > 0) {
      paintSky(dawn);
      (scene.background as THREE.Color).copy(NIGHT).lerp(DAWN, dawn);
      (scene.fog as THREE.FogExp2).color.copy(NIGHT).lerp(DAWN, dawn);
      sun.intensity = dawn * 1.3;
      hemi.intensity = 1.25 + dawn * 0.6;
      starMat.opacity = 1 - dawn;
    }
    // headlights on the truck that leaves
    const tr = trucks[0].root;
    tmpV.set(0, 1, 2.5).applyEuler(tr.rotation).add(tr.position);
    headL.position.copy(tmpV);
    tmpV.set(0, 0.5, 14).applyEuler(tr.rotation).add(tr.position);
    headL.target.position.copy(tmpV);
    headL.intensity = stage === "won" && st > 11 ? 300 : 0;

    // the camera
    const portrait = aspect < 0.9;
    const back = portrait ? 1.55 : 1;
    if (stage === "arrive") {
      if (st < 3.2) {
        const k = smooth(0, 3.2, st);
        shot(lerp(28, 18, k), lerp(14, 7, k), lerp(40, 30, k), lerp(4, 0, k), 2.5, lerp(-8, -10, k));
      } else {
        const m = foes[0];
        shot(m.x - 3.5 * back, 1.6, m.z - 5 * back, m.x, 1.7, m.z);
      }
    } else if (stage === "standoff") {
      // low, behind the hero's shoulder, looking at the two of them
      const h = heroes[0];
      const m = foes[0];
      const ax = m.x - h.x, az = m.z - h.z;
      const L = Math.hypot(ax, az) || 1;
      const ux = ax / L, uz = az / L;
      // a two-shot from the side, low, creeping in
      const k = smooth(0, STANDOFF_T, st);
      const mx = (h.x + m.x) / 2, mz = (h.z + m.z) / 2;
      const dist = L * 0.62 + 3 - k * 1.5;
      // a tall phone screen gets the over-the-shoulder version: you in front, him down the lot
      if (portrait) shot(h.x - ux * (4.5 - k) + uz * 0.8, 3 - k * 0.4, h.z - uz * (4.5 - k) - ux * 0.8, mx + ux * 2, 1, mz + uz * 2);
      else shot(mx - uz * dist, 1.3 + k * 0.3, mz + ux * dist, mx, 1.25, mz);
    } else if (stage === "fight") {
      // high over the lot, following the action and keeping the cannon in view
      let cx = TAILGATE.x * 0.5, cz = TAILGATE.z * 0.5, n = 0.5;
      for (const h of heroes) { cx += h.x; cz += h.z; n += 1; }
      for (const f of foes) if (f.state !== BEATEN) { cx += f.x * 0.8; cz += f.z * 0.8; n += 0.8; }
      cx /= n; cz /= n;
      shot(cx, 8.5 * back, cz + 9 * back, cx, 0.6, cz - 0.5);
    } else if (stage === "won") {
      if (st < 8.6) {
        // on the curb: the two of them, pie on their faces, the diner behind you
        const m = foes[0];
        const k = smooth(0.5, 8.6, st);
        shot(lerp(m.x + 2, m.x + 0.6, k), lerp(4, 1.3, k), lerp(m.z - 7, m.z - 4.2, k) - (back - 1) * 3, m.x + (o.two ? 0.9 : 0), 0.9, m.z);
      } else if (st < 12.2) {
        shot(-1, 4.5 * back, 4 + 4 * back, TRUCK[0].x, 1, TRUCK[0].z);
      } else {
        // wide and low by the road as the truck drives off into the sunrise
        const tx = tr.position.x;
        shot(Math.min(tx, 30) - 14, 2.4, 26 + (back - 1) * 8, Math.min(tx, 60) + 6, 2, 16);
      }
    } else {
      const m = foes[0];
      shot(m.x - 6, 3.5 * back, m.z - 8 * back, m.x, 1.2, m.z);
    }
    if (!camReady || dt > 0.5) { camera.position.copy(camPos); camReady = true; camera.lookAt(camLook); }
    else {
      const cut = stage !== "fight";
      const k = cut ? Math.min(1, dt * 4) : Math.min(1, dt * 3);
      camera.position.lerp(camPos, k);
      tmpV.copy(camLook);
      camera.lookAt(tmpV);
    }
    camera.fov = portrait ? 62 : 50;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  };

  /* --------------------------------------------------------------- the words on screen */
  const ov = document.createElement("canvas");
  const ovCtx = ov.getContext("2d")!;
  const ovTex = new THREE.CanvasTexture(ov);
  ovTex.colorSpace = THREE.SRGBColorSpace;
  const ovScene = new THREE.Scene();
  const ovCam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 2);
  const ovPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: ovTex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
  ovPlane.position.z = -1;
  ovScene.add(ovPlane);
  let bars = 1;
  let ovKey = "";
  const COLORS: Record<string, string> = { MORT: "#ff8a5a", LINDA: "#e08aff", DOT: "#ff9ac0" };
  const wrap = (c: CanvasRenderingContext2D, text: string, max: number): string[] => {
    const words = text.split(" ");
    const out: string[] = [];
    let cur = "";
    for (const w of words) {
      const t = cur ? cur + " " + w : w;
      if (c.measureText(t).width > max && cur) { out.push(cur); cur = w; } else cur = t;
    }
    if (cur) out.push(cur);
    return out;
  };
  const paintOverlay = (W: number, H: number, h: FinaleHud): void => {
    const c = ovCtx;
    c.clearRect(0, 0, W, H);
    const u = Math.min(W, H * 1.4) / 100; // a unit that suits phones and laptops alike
    const barH = H * 0.11 * bars;
    if (barH > 0.5) {
      c.fillStyle = "#000";
      c.fillRect(0, 0, W, barH);
      c.fillRect(0, H - barH, W, barH);
    }
    if (h.fade > 0.003) { c.fillStyle = `rgba(0,0,0,${h.fade})`; c.fillRect(0, 0, W, H); }
    if (h.line) {
      if (!h.who && h.stage !== "fight") {
        // the narrator: a yellow caption box, comic style, top left
        c.font = `900 ${Math.round(u * 3.4)}px 'Arial Black', Impact, sans-serif`;
        const tw = c.measureText(h.line).width;
        const x = u * 3, y = barH + u * 2.5, ph = u * 6;
        c.fillStyle = "#ffe27a";
        c.fillRect(x, y, tw + u * 4, ph);
        c.strokeStyle = "#0b0b10";
        c.lineWidth = u * 0.6;
        c.strokeRect(x, y, tw + u * 4, ph);
        c.fillStyle = "#0b0b10";
        c.textBaseline = "middle";
        c.textAlign = "left";
        c.fillText(h.line, x + u * 2, y + ph / 2 + u * 0.2);
      } else if (h.stage === "fight") {
        // a bark in the middle of a fight: a white pill under the HUD
        c.font = `800 ${Math.round(u * 3.2)}px Inter, system-ui, sans-serif`;
        const text = h.who ? `${h.who}: ${h.line}` : h.line;
        const lines = wrap(c, text, W * 0.8);
        const lh = u * 4.4;
        const y0 = H * (W < H ? 0.34 : 0.2);
        lines.forEach((l, i) => {
          const tw = c.measureText(l).width;
          c.fillStyle = h.who === "DOT" ? "rgba(255,230,240,0.95)" : "rgba(255,255,255,0.95)";
          const y = y0 + i * (lh + u * 0.6);
          c.beginPath();
          c.roundRect(W / 2 - tw / 2 - u * 2, y - lh / 2, tw + u * 4, lh, lh / 2);
          c.fill();
          c.fillStyle = "#111";
          c.textAlign = "center";
          c.textBaseline = "middle";
          c.fillText(l, W / 2, y + u * 0.2);
        });
      } else {
        // a film subtitle in the bottom bar: the name in colour, the words in white
        c.font = `800 ${Math.round(u * 3.6)}px Inter, system-ui, sans-serif`;
        const lines = wrap(c, h.line, W * 0.86);
        const lh = u * 4.6;
        const total = lines.length * lh + (h.who ? u * 3.8 : 0);
        let y = H - Math.max(barH, total + u * 3) + (Math.max(barH, total + u * 3) - total) / 2;
        c.textAlign = "center";
        c.textBaseline = "top";
        if (h.who) {
          c.font = `900 ${Math.round(u * 3)}px Inter, system-ui, sans-serif`;
          c.fillStyle = COLORS[h.who] ?? "#ffd36a";
          c.fillText(h.who, W / 2, y);
          y += u * 3.8;
          c.font = `800 ${Math.round(u * 3.6)}px Inter, system-ui, sans-serif`;
        }
        c.lineWidth = u * 0.7;
        c.strokeStyle = "rgba(0,0,0,0.85)";
        for (const l of lines) { c.strokeText(l, W / 2, y); c.fillStyle = "#fff"; c.fillText(l, W / 2, y); y += lh; }
      }
    }
    if (h.title) {
      const gold = h.title.startsWith("THE CANNON");
      const size = gold ? u * (W < H ? 6.4 : 7.2) : u * (h.title === "SPLAT!" ? 16 : 13);
      c.font = `900 ${Math.round(size)}px Impact, 'Arial Black', sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      const lines = gold ? (W < H ? ["THE CANNON", "IS YOURS.", "FOR GOOD."] : ["THE CANNON IS YOURS.", "FOR GOOD."]) : [h.title];
      const pop = h.stage === "won" && h.title === "SPLAT!" ? 1 + Math.max(0, 0.35 - h.t) : 1;
      c.save();
      c.translate(W / 2, H * (W < H && !gold ? 0.26 : 0.45));
      c.scale(pop, pop);
      c.rotate(gold ? 0 : -0.06);
      lines.forEach((l, i) => {
        const y = (i - (lines.length - 1) / 2) * size * 1.08;
        c.lineWidth = size * 0.12;
        c.strokeStyle = "#0b0b10";
        c.lineJoin = "round";
        c.strokeText(l, 0, y);
        c.fillStyle = gold ? "#ffd36a" : h.title === "SPLAT!" ? "#fff6e0" : "#ff4a2a";
        c.fillText(l, 0, y);
      });
      c.restore();
    }
  };

  /* --------------------------------------------------------------- the api */
  let prevStage: FinaleStage = stage;
  const fin: Finale = {
    scene, camera, throws: 0,
    step(dt, inputs, role, mine = 0) {
      st += dt;
      if (lineT > 0) { lineT -= dt; if (lineT <= 0 && stage === "fight") { who = ""; line = ""; } }
      if (role === "auth") {
        heroes.forEach((h, i) => { if (h.on) stepHero(h, i, inputs[i] ?? { mx: 0, mz: 0, throw: false }, dt); });
        if (stage === "fight") {
          foes.forEach((f) => stepFoe(f, dt));
          for (const p of pies) if (p.live) { p.t += dt; if (p.t >= p.dur) landPie(p); }
          const pulling = foes.some((f) => f.state === GRABBING);
          grab = clamp(grab + (pulling ? dt / (o.two ? 6.5 : 7.5) : -dt * 0.04), 0, 1);
          if (foes.every((f) => f.state === BEATEN)) {
            if (doneT === 0) doneT = st;
            if (st - doneT > 1.6) goStage("won");
          }
          else if (grab >= 1) goStage("lost");
        }
        stepScript(dt, true);
      } else {
        // a guest: my own hero moves here, the rest eases toward the host
        const h = heroes[mine];
        if (h) {
          const inp = inputs[0] ?? { mx: 0, mz: 0, throw: false };
          h.stun = Math.max(0, h.stun - dt);
          const can = stage === "fight" && h.stun <= 0;
          h.vx = lerp(h.vx, can ? inp.mx * 5.6 : 0, Math.min(1, dt * 12));
          h.vz = lerp(h.vz, can ? inp.mz * 5.6 : 0, Math.min(1, dt * 12));
          h.x += h.vx * dt;
          h.z += h.vz * dt;
          blockTrucks(h, 0.35);
          const v = Math.hypot(h.vx, h.vz);
          if (v > 0.4) h.yaw = angTo(h.yaw, Math.atan2(h.vx, h.vz), Math.min(1, dt * 14));
          h.walk += v * dt * 2.4;
          if (inp.throw && can && h.pies > 0) { fin.throws += 1; h.throwT = 0.45; o.sound("throw"); }
          h.throwT = Math.max(0, h.throwT - dt);
        }
        const k = Math.min(1, dt * 9);
        heroes.forEach((x, i) => {
          if (i === mine) return;
          const d = Math.hypot(x.tx - x.x, x.tz - x.z);
          x.x = lerp(x.x, x.tx, k); x.z = lerp(x.z, x.tz, k); x.yaw = angTo(x.yaw, x.tyaw, k);
          x.walk += d * k * 2.4;
          x.throwT = Math.max(0, x.throwT - dt);
        });
        foes.forEach((f) => {
          const d = Math.hypot(f.tx - f.x, f.tz - f.z);
          f.x = lerp(f.x, f.tx, k); f.z = lerp(f.z, f.tz, k); f.yaw = angTo(f.yaw, f.tyaw, k);
          f.walk += d * k * 2.2;
          f.t += dt;
        });
        for (const p of pies) if (p.live) { p.t += dt; if (p.t >= p.dur) { p.live = false; p.mesh.visible = false; } }
        if (stage === "arrive" || stage === "standoff" || stage === "won") {
          // the cutscenes run from the clock on both sides; only the trucks and walks need it
          stepScript(dt, false);
        }
      }
      if (stage !== prevStage) { prevStage = stage; }
      draw(dt);
    },
    hud() {
      const fade = stage === "arrive" ? 1 - smooth(0, 1.2, st) : stage === "won" ? smooth(WON_T - 1.6, WON_T, st) : stage === "lost" ? smooth(LOST_T - 1.2, LOST_T, st) : 0;
      let title = "";
      if (stage === "standoff" && st > 3.4) title = "SHOWDOWN";
      if (stage === "won" && st > 13.6) title = "THE CANNON IS YOURS. FOR GOOD.";
      if (stage === "won" && st < 1.4) title = "SPLAT!";
      return {
        stage, t: st, who, line, title, fade,
        cinema: stage !== "fight",
        pies: heroes.map((h) => h.pies),
        grab,
        foes: foes.map((f) => ({ name: f.linda ? "LUNATIC LINDA" : "MAD MORT", hp: Math.max(0, f.hp), max: f.max, beaten: f.state === BEATEN })),
        hint: stage === "fight" && st < 9 ? "pies" : "",
      };
    },
    done: () => ended,
    encode() {
      const n: number[] = [STAGES.indexOf(stage), +st.toFixed(2), +grab.toFixed(3)];
      for (const h of heroes) n.push(+h.x.toFixed(2), +h.z.toFixed(2), +h.yaw.toFixed(2), h.pies, +h.stun.toFixed(2), +h.throwT.toFixed(2), h.on ? 1 : 0);
      for (const f of foes) n.push(+f.x.toFixed(2), +f.z.toFixed(2), +f.yaw.toFixed(2), f.hp, f.state, f.splat.visible ? 1 : 0);
      const live = pies.filter((p) => p.live);
      n.push(live.length);
      for (const p of live) n.push(+p.fx.toFixed(2), +p.fz.toFixed(2), +p.tx.toFixed(2), +p.ty.toFixed(2), +p.tz.toFixed(2), +p.t.toFixed(2), +p.dur.toFixed(2));
      return { n, who, line };
    },
    apply(s, mine) {
      const n = s.n;
      let i = 0;
      const ns = STAGES[n[i++]] ?? "fight";
      const nst = n[i++];
      if (ns !== stage) {
        stage = ns;
        if (ns === "won") goStage("won");
        if (ns === "lost") goStage("lost");
        st = nst;
      } else if (Math.abs(nst - st) > 0.5) st = nst;
      grab = n[i++];
      heroes.forEach((h, hi) => {
        const x = n[i++], z = n[i++], yaw = n[i++], pies = n[i++], stun = n[i++], tt = n[i++], on = n[i++];
        h.pies = pies;
        h.on = on === 1;
        h.body.root.visible = h.on;
        if (hi === mine) {
          // the host shoved me: take its word for it
          if (stun > 0.3 && h.stun <= 0) { h.stun = stun; h.x = x; h.z = z; }
          return;
        }
        h.tx = x; h.tz = z; h.tyaw = yaw; h.stun = stun;
        if (tt > h.throwT + 0.2) h.throwT = tt;
      });
      foes.forEach((f) => {
        f.tx = n[i++]; f.tz = n[i++]; f.tyaw = n[i++]; f.hp = n[i++];
        const state = n[i++];
        if (state !== f.state) f.t = 0;
        f.state = state;
        f.splat.visible = n[i++] === 1;
      });
      const count = n[i++];
      pies.forEach((p) => { p.live = false; p.mesh.visible = false; });
      for (let k = 0; k < count && k < pies.length; k++) {
        const p = pies[k];
        Object.assign(p, { live: true, fx: n[i++], fy: 1.5, fz: n[i++], tx: n[i++], ty: n[i++], tz: n[i++], t: n[i++], dur: n[i++] });
        p.mesh.visible = true;
      }
      if (s.line !== line || s.who !== who) { who = s.who; line = s.line; lineT = 2; }
      if (stage === "fight") cannon.visible = true;
      if (stage === "lost") { cannon.visible = false; carriedCannon.visible = true; }
    },
    remote(i, x, z, yaw, throws) {
      const h = heroes[i];
      if (!h) return;
      if (h.stun <= 0) { h.x = x; h.z = z; h.yaw = yaw; }
      while (h.seen < throws) { h.seen += 1; throwPie(i); }
    },
    skip(s) {
      if (s === "fight") {
        foes.forEach((f) => { f.x = f.linda ? 4.5 : 8.5; f.z = f.linda ? 7.5 : 5.5; });
        goStage("fight");
      } else if (s === "won") {
        foes.forEach((f) => { f.x = f.linda ? 2 : 0; f.z = 4; });
        heroes.forEach((h, i) => { h.x = -2 - i * 2.5; h.z = 0; });
        goStage("won");
      } else if (s === "lost") {
        foes[0].x = TAILGATE.x; foes[0].z = TAILGATE.z;
        goStage("lost");
      } else { place(); if (s === "standoff") foes.forEach((f) => { f.x = f.linda ? 4.5 : 8.5; f.z = f.linda ? 7.5 : 5.5; }); goStage(s); }
      camReady = false;
    },
    aspect(a) { aspect = a; },
    peek: () => ({ heroes: heroes.map((h) => ({ x: h.x, z: h.z, pies: h.pies, stun: h.stun })), foes: foes.map((f) => ({ x: f.x, z: f.z, state: f.state, hp: f.hp })), grab, stage, t: st }),
    overlay(renderer, w, h) {
      const hd = fin.hud();
      bars = lerp(bars, hd.cinema ? 1 : 0, 0.12);
      if (Math.abs(bars - (hd.cinema ? 1 : 0)) < 0.01) bars = hd.cinema ? 1 : 0;
      const sc = Math.min(1, 1280 / Math.max(w, 1));
      const W = Math.max(2, Math.round(w * sc)), H = Math.max(2, Math.round(h * sc));
      const key = [W, H, hd.who, hd.line, hd.title, hd.fade.toFixed(2), bars.toFixed(2), hd.stage, hd.title === "SPLAT!" ? hd.t.toFixed(2) : ""].join("|");
      if (key !== ovKey) {
        ovKey = key;
        if (ov.width !== W || ov.height !== H) { ov.width = W; ov.height = H; }
        paintOverlay(W, H, hd);
        ovTex.needsUpdate = true;
      }
      const auto = renderer.autoClear;
      renderer.autoClear = false;
      renderer.render(ovScene, ovCam);
      renderer.autoClear = auto;
    },
    dispose() {
      scene.traverse((x) => {
        const m = x as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        const all = Array.isArray(mat) ? mat : mat ? [mat] : [];
        for (const y of all) { (y as THREE.MeshBasicMaterial).map?.dispose(); y.dispose(); }
      });
      glow.dispose();
      puffTex.dispose();
      ovTex.dispose();
      ovPlane.geometry.dispose();
      (ovPlane.material as THREE.Material).dispose();
      stallTex.dispose();
    },
  };
  return fin;
}
