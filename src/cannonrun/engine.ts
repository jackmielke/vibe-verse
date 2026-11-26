/**
 * Cannon Run: the game.
 *
 * You are in the bed of a pickup doing a hundred and ten down a desert highway
 * at night, sitting behind an old ship's cannon, and the camera looks back
 * over the tailgate at the man who wants his cannon back. With a friend there
 * are two pickups, two cannons and two health bars, and one Mort.
 *
 * Everything lives in road coordinates (see road.ts): `s` along the highway,
 * `lat` right of the centre line, `y` up. Trucks, Mort, traffic, every ball
 * and every tyre he throws are simulated there and only drawn in world space.
 *
 * Modes:
 *  - `solo`: one truck.
 *  - `duo`: two trucks, one keyboard (A/D/Shift/Space and the mouse for one,
 *    the arrows and Enter for the other), one camera that frames both.
 *  - `host` / `guest`: two browsers over net.ts. The host runs the chase; the
 *    guest drives its own truck and draws everything else from snapshots.
 *
 * When every truck is out of the fight Mort stops shouting, parks, gets out,
 * walks up to your tailgate, lifts his cannon out of the bed and drives off
 * with it. That is the end of the run.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { HALF, LANE, LAT_MAX, G, MUZZLE, RELOAD, heading, V, toWorld, toRoad, clamp, lerp, hash } from "./road";
import {
  canvasTex, roadTexture, sandTexture, glowTexture, puffTexture, box,
  buildTruck, buildFoe, buildMort, buildCannon, trafficGeometry, RIDES, rideAt, THEME, buildHench, henchKit, buildAutoGun,
  type Truck, type Foe, type Hench,
} from "./models";
import type { Transport, Upgrades, Wire, Snap, Input } from "./net";
import { createFinale, type Finale, type FinaleHud, type FinaleInput, type FinaleStage } from "./finale";

export type Mode = "solo" | "duo" | "host" | "guest";
type Phase = "intro" | "play" | "takeback" | "finale" | "over";

export interface RiderHud {
  hull: number;
  max: number;
  boost: number;
  reload: number;
  out: boolean;
  respawn: number;
  you: boolean;
  label: string;
  color: string;
  gone: boolean;
}

export interface ChaseHud {
  phase: Phase;
  mode: Mode;
  riders: RiderHud[];
  score: number;
  best: number;
  cash: number;
  meters: number;
  level: number;
  ride: string;
  foeHp: number;
  foeMax: number;
  foeWrecked: boolean;
  /** his cousin Linda, two-player only */
  linda: { hp: number; max: number; ride: string; wrecked: boolean } | null;
  gap: number;
  hits: number;
  wrecks: number;
  toast: string;
  fps: number;
  /** online only: "ok", or "lost" when the other side has gone quiet */
  link: "" | "ok" | "lost";
  /** a big red warning, when Mort's backup is on the way */
  alert: string;
  henchmen: number;
  /** the diner showdown after the train, while it is on */
  finale: FinaleHud | null;
  /** the run ended with the cannon yours for good */
  won: boolean;
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

export interface Opts {
  mode?: Mode;
  net?: Transport | null;
  upgrades?: Upgrades;
  /** host only: what the guest bought, which decides its truck's health */
  guestUpgrades?: Upgrades;
  onHud?: (h: ChaseHud) => void;
  onReady?: () => void;
  /** once per run, when it is over: cash earned and the final score */
  onEnd?: (cash: number, score: number) => void;
  /** northern lights over the desert instead of a plain moonlit sky */
  aurora?: boolean;
  /** pumpkins for cannonballs, pies and drumsticks, pilgrim hats, a harvest moon */
  thanksgiving?: boolean;
}

const NO_UPGRADES: Upgrades = { armor: 0, loader: 0, nitro: 0, auto: 0, punch: 0, engine: 0 };
const RIDER_LOOK = [
  { color: 0x2f6d8c, css: "#5ab4ff", plate: "ARRR" },
  { color: 0xc0472a, css: "#ff7a4a", plate: "YARR" },
];
const NET_HZ = 15;
const RESPAWN = 10;
/** Jack, Nov 2026: Mort only ever throws at civilians in his way, never at you. */
const THROW_AT_PLAYER = false;

interface Rider {
  idx: number;
  truck: Truck;
  s: number; lat: number; vl: number; v: number;
  boost: number; hull: number; max: number;
  shake: number; bump: number;
  reload: number; recoil: number;
  aim: { yaw: number; pitch: number; lat: number };
  out: boolean; respawn: number; disarmed: boolean; gone: boolean;
  /** drawn lean and roll, eased */
  yawSm: number; rollSm: number;
  wantFire: boolean;
  reloadMul: number; drainMul: number; bonusV: number;
  /** garage: base speed, and the roof gun (0 = none) */
  engine: number; auto: number; punch: number; autoT: number; autoGun: ReturnType<typeof buildAutoGun>; autoYaw: number; autoPitch: number;
  /** seconds of hard swerving, which is how you shake a henchman off */
  shakeOff: number;
  /** host: the guest's latest report. guest: the host's view of the other truck. */
  net: { s: number; lat: number; v: number; vl: number; at: number; fire: number } | null;
  fired: number;
}
interface Ball { s: number; lat: number; y: number; vs: number; vl: number; vy: number; age: number; bounces: number; mesh: THREE.Mesh; live: boolean; trail: number; rider: number; dmg: number }
/** rider -1: thrown at a civilian, `car` */
interface Thrown { s: number; lat: number; y: number; vs: number; vl: number; vy: number; age: number; spin: number; mesh: THREE.Mesh; live: boolean; targetLat: number; passed: boolean; kind: number; rider: number; car: Traffic | null }
/** state: -1 none, 0 jumping out, 1 running, 2 on your tailgate, 3 knocked flying, 4 lying in the road */
interface Henchman { s: number; lat: number; y: number; v: number; vl: number; vy: number; state: number; t: number; rider: number; rx: number; spin: number; walk: number; yaw: number; whack: number; body: Hench }
/** mode: 0 driving, 1 tipping onto its side, 2 in the air, 3 burnt out, 4 lying on its side */
interface Traffic {
  s: number; lat: number; y: number; v: number; vl: number; vy: number;
  rx: number; ry: number; rz: number; wx: number; wy: number; wz: number;
  color: THREE.Color; mode: number; air: number; side: number; hitCd: number; live: boolean;
  /** hit by something Mort threw: a drift sideways for a while */
  swerve: number;
}
interface Puff { sprite: THREE.Sprite; mat: THREE.SpriteMaterial; s: number; lat: number; y: number; vs: number; vl: number; vy: number; age: number; life: number; size: number; grow: number; kind: "smoke" | "black" | "fire" | "spark" | "dust"; live: boolean }

const TAUNTS = [
  "GET BACK HERE!", "That's MY cannon!", "You scratched my paint!", "Nobody outruns Mort!",
  "PULL OVER!", "I've got all night, pal!", "That cannon was my grandpa's!", "I can see you laughing!",
  "Ten more miles of desert, buddy!", "I'm not even mad. I'm FURIOUS.",
];
const OUCH = ["OW!", "MY BUMPER!", "Lucky shot!", "That's coming out of your pocket!", "You'll pay for that!", "My radiator!"];
const COMEBACK = ["This isn't over!", "I've got a bigger truck!", "I'll be back with my cousin's rig!"];
const L_TAUNTS = [
  "Hi sweetie! Pull OVER!", "Linda's here, honey!", "That's my cousin's cannon!", "You made Mort CRY!",
  "Wheeee! Nobody outruns Linda!", "I'm not crazy, YOU'RE crazy!", "Mama's coming, babies!", "Linda the Lunatic, darling!",
];
const L_OUCH = ["My HAIR!", "RUDE!", "That's my good bumper!", "Oh, you did NOT!", "Mort, they shot me!"];
const L_COMEBACK = ["Linda's getting a bigger one!", "Mort, help!", "I'll be back, sugar!"];
const T_TAUNTS = [
  "That cannon was for carving the TURKEY!", "Grandma's gravy is getting COLD!", "You're STUFFED, pal!",
  "Happy Thanksgiving, THIEF!", "I'm not thankful for YOU!", "Pass the cannon, not the potatoes!",
];
const T_L_TAUNTS = ["Gobble gobble, sweetie!", "Linda brought PIE, honey!", "I'll baste you like a turkey!", "Save me a drumstick, darling!"];
const COMMENTS: Record<number, string> = {
  2: "He's back. In a tow truck.",
  3: "Oh no. Monster pickup.",
  4: "A cement truck. Of course it's a cement truck.",
  5: "Now it's an 18-wheeler.",
  6: "He's driving a train!",
};
const BURNT = new THREE.Color(0x1c1714);

/* ---------------------------------------------------------------- the game */

export function createCannonRun(mount: HTMLElement, opts: Opts = {}): CannonRun {
  const params = new URLSearchParams(window.location.search);
  const automated = navigator.webdriver || params.has("shot");
  const mode: Mode = opts.mode ?? "solo";
  const thanks = opts.thanksgiving ?? params.has("thanksgiving");
  THEME.thanksgiving = thanks;
  const TAUNT_LIST = thanks ? [...TAUNTS, ...T_TAUNTS, ...T_TAUNTS] : TAUNTS;
  const L_TAUNT_LIST = thanks ? [...L_TAUNTS, ...T_L_TAUNTS, ...T_L_TAUNTS] : L_TAUNTS;
  const net = mode === "host" || mode === "guest" ? opts.net ?? null : null;
  const isGuest = mode === "guest";
  const two = mode !== "solo";
  /** the truck this browser drives (in duo, the one the mouse and stick drive) */
  const mine = isGuest ? 1 : 0;

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: automated });
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
  const lindaBubble = document.createElement("div");
  lindaBubble.style.cssText = bubble.style.cssText + ";background:#f3d2ff;color:#3a0a52";
  mount.appendChild(lindaBubble);

  const scene = new THREE.Scene();
  const FOG = new THREE.Color(0x141a2e);
  scene.fog = new THREE.FogExp2(FOG, 0.0042);
  scene.background = FOG;
  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 1400);
  let baseFov = 56;

  const resize = (): void => {
    const w = mount.clientWidth || window.innerWidth;
    const h = mount.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Keep the road wide on a portrait phone, and wider still with two trucks on one screen.
    baseFov = (w / h < 0.9 ? 72 : 56) + (mode === "duo" ? 8 : 0);
    camera.fov = baseFov;
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
  if (thanks) {
    // a big orange harvest moon
    (moonDisc.material as THREE.MeshBasicMaterial).color.set(0xffa64a);
    moonDisc.scale.setScalar(1.8);
    moon.material.color.set(0xffb070);
    moon.scale.setScalar(190);
  }

  /* ------------------------------------------------------------ aurora */
  // Three curtains of light right round the sky, each a ring of tall strips.
  // The shader draws the rays: bright at the hem, fading up, flickering along.
  const aurora = opts.aurora ?? params.has("aurora");
  const auroraMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    vertexShader: "varying vec2 vUv; varying float vSeed; attribute float seed; void main(){ vUv = uv; vSeed = seed; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: [
      "uniform float uTime; varying vec2 vUv; varying float vSeed;",
      "float h(float n){ return fract(sin(n) * 43758.5453); }",
      "float n1(float x){ float i = floor(x); float f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(h(i), h(i + 1.0), f); }",
      "void main(){",
      "  float x = vUv.x * 90.0 + vSeed * 13.0;",
      "  float rays = n1(x * 3.1 + uTime * 0.7) * 0.6 + n1(x * 9.7 - uTime * 1.3) * 0.4;",
      "  float band = 0.55 + 0.45 * n1(vUv.x * 7.0 + uTime * 0.12 + vSeed * 5.0);",
      "  float y = vUv.y;",
      "  float hem = smoothstep(0.0, 0.08, y) * (1.0 - smoothstep(0.15, 1.0, y));",
      "  vec3 green = vec3(0.15, 1.0, 0.55);",
      "  vec3 top = mix(vec3(0.55, 0.2, 0.95), vec3(1.0, 0.3, 0.55), vSeed);",
      "  vec3 col = mix(green, top, smoothstep(0.25, 0.85, y));",
      "  float a = hem * (0.35 + 0.65 * rays) * band;",
      "  gl_FragColor = vec4(col * a * 0.9, a);",
      "}",
    ].join("\n"),
  });
  const auroraGroup = new THREE.Group();
  if (aurora) {
    for (let k = 0; k < 3; k++) {
      const N = 160;
      const pos: number[] = [];
      const uv: number[] = [];
      const seed: number[] = [];
      const idx: number[] = [];
      const R0 = 620 + k * 90;
      const base = 70 + k * 35;
      const tall = 230 - k * 30;
      for (let i = 0; i <= N; i++) {
        const u = i / N;
        const a = u * Math.PI * 2;
        const r = R0 * (1 + 0.12 * Math.sin(a * 3 + k * 2.1) + 0.06 * Math.sin(a * 7 + k));
        const yb = base + 40 * Math.sin(a * 2 + k * 1.3);
        pos.push(Math.cos(a) * r, yb, Math.sin(a) * r, Math.cos(a) * r * 1.04, yb + tall, Math.sin(a) * r * 1.04);
        uv.push(u, 0, u, 1);
        seed.push(k / 2, k / 2);
        if (i < N) { const j = i * 2; idx.push(j, j + 1, j + 2, j + 1, j + 3, j + 2); }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute("seed", new THREE.Float32BufferAttribute(seed, 1));
      g.setIndex(idx);
      const m = new THREE.Mesh(g, auroraMat);
      m.renderOrder = -8;
      m.frustumCulled = false;
      auroraGroup.add(m);
    }
    scene.add(auroraGroup);
    // the whole desert picks up a little green
    sky.material.color.setRGB(0.85, 1.05, 1.0);
  }

  /* ------------------------------------------------------------ light */
  scene.add(new THREE.HemisphereLight(aurora ? 0x4a9a8a : 0x5a6ea8, 0x2a2018, 0.9));
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
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1800, 1800), new THREE.MeshLambertMaterial({ map: sand }));
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
  const pools = new THREE.InstancedMesh(poolGeo, new THREE.MeshBasicMaterial({ map: glow, color: 0xff9a40, transparent: true, opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending }), LAMPS);
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
  const ROCKS = 40;
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ color: 0x5a4636 }), ROCKS);
  rocks.frustumCulled = false;
  scene.add(rocks);
  const mesaGeo = new THREE.CylinderGeometry(0.75, 1, 1, 7);
  mesaGeo.translate(0, 0.5, 0);
  const MESAS = 16;
  const mesas = new THREE.InstancedMesh(mesaGeo, new THREE.MeshLambertMaterial({ color: 0x2a2030 }), MESAS);
  mesas.frustumCulled = false;
  scene.add(mesas);
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

  /* ------------------------------------------------------------ the trucks */
  const myUp = opts.upgrades ?? NO_UPGRADES;
  const upFor = (i: number): Upgrades => (mode === "host" && i === 1 ? opts.guestUpgrades ?? NO_UPGRADES : mode === "guest" && i === 0 ? NO_UPGRADES : myUp);
  const riders: Rider[] = [];
  for (let i = 0; i < (two ? 2 : 1); i++) {
    const look = RIDER_LOOK[i];
    const truck = buildTruck(look.color, look.plate);
    scene.add(truck.root);
    const up = upFor(i);
    riders.push({
      idx: i, truck,
      s: 0, lat: 0, vl: 0, v: 31, boost: 1, hull: 100, max: 100 + 25 * up.armor, shake: 0, bump: 0,
      reload: 0, recoil: 0, aim: { yaw: 0, pitch: 0.08, lat: 0 },
      out: false, respawn: 0, disarmed: false, gone: false, yawSm: 0, rollSm: 0, wantFire: false,
      reloadMul: 1 - 0.15 * up.loader, drainMul: 1 - 0.15 * up.nitro, bonusV: 2 * up.nitro,
      net: null, fired: 0,
      engine: up.engine, auto: up.auto, punch: up.punch, autoT: 2, autoGun: buildAutoGun(), autoYaw: 0, autoPitch: 0, shakeOff: 0,
    });
    const rr = riders[riders.length - 1];
    rr.autoGun.root.position.set(-0.7, 1.24, -2.3);
    rr.autoGun.root.visible = up.auto > 0;
    truck.root.add(rr.autoGun.root);
  }
  const resetRider = (r: Rider): void => {
    Object.assign(r, {
      s: 0, lat: two ? (r.idx === 0 ? 2.4 : -2.4) : 2, vl: 0, v: 31, boost: 1, hull: r.max, shake: 0, bump: 0,
      reload: 0, recoil: 0, out: false, respawn: 0, disarmed: false, yawSm: 0, rollSm: 0, wantFire: false, autoT: 2, shakeOff: 0,
    });
    r.truck.cannon.root.visible = true;
    r.truck.kit.visible = true;
  };
  riders.forEach(resetRider);
  /** riders this browser steers */
  const local = riders.filter((r) => (mode === "duo" ? true : r.idx === mine));
  const me = riders[mine];

  // DOM name tags over the trucks, when there are two of them
  const tags = riders.map((r) => {
    const el = document.createElement("div");
    el.style.cssText = `position:absolute;left:0;top:0;pointer-events:none;padding:2px 7px;border-radius:8px;font:800 11px Inter,system-ui,sans-serif;letter-spacing:.08em;color:#0b0f1c;background:${RIDER_LOOK[r.idx].css};transform:translate(-50%,-100%);opacity:0`;
    el.textContent = mode === "duo" ? `P${r.idx + 1}` : r.idx === mine ? "YOU" : "FRIEND";
    if (two) mount.appendChild(el);
    return el;
  });

  /* ------------------------------------------------------------ Mort */
  let foe: Foe = buildFoe(1);
  scene.add(foe.root);
  const glareMat = new THREE.SpriteMaterial({ map: glow, color: 0xfff2d8, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const glares = [new THREE.Sprite(glareMat), new THREE.Sprite(glareMat)];
  glares.forEach((g) => scene.add(g));
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xffe2a8, transparent: true, opacity: 0.25, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  scene.add(halo);
  // Mort on foot, for when he comes for the cannon, and the cannon he carries back.
  const walker = buildMort();
  walker.root.visible = false;
  scene.add(walker.root);
  const carried = buildCannon();
  carried.root.scale.setScalar(0.85);
  carried.root.rotation.y = Math.PI / 2;
  carried.root.position.set(0, -0.42, 0.05);
  carried.root.visible = false;
  walker.hands.add(carried.root);
  // His backup: scruffy junkyard guys in ridiculous hats, with nail-studded sticks.
  const henchMats = henchKit();
  const MAX_HENCH = 8;
  const henchmen: Henchman[] = [];
  for (let k = 0; k < MAX_HENCH; k++) {
    const body = buildHench(henchMats, k);
    body.root.visible = false;
    scene.add(body.root);
    henchmen.push({ s: 0, lat: 0, y: 0, v: 0, vl: 0, vy: 0, state: -1, t: 0, rider: 0, rx: 0, spin: 0, walk: 0, yaw: 0, whack: 0, body });
  }
  const henchBubble = document.createElement("div");
  henchBubble.style.cssText = bubble.style.cssText + ";background:#111;color:#fff;font-size:12px";
  mount.appendChild(henchBubble);
  let henchSay = { i: -1, t: 0 };

  /* ------------------------------------------------------------ traffic */
  const trafficMesh = new THREE.InstancedMesh(trafficGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.3 }), 8);
  const MAX_TRAFFIC = 8;
  trafficMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_TRAFFIC * 3), 3);
  trafficMesh.frustumCulled = false;
  scene.add(trafficMesh);
  const TRAFFIC_COLORS = [0xe8e4da, 0x2e5fa8, 0x8a8f96, 0x3c7a4e, 0x7b4a9e, 0xc96a2a];
  const traffic: Traffic[] = [];

  /* ------------------------------------------------------------ projectiles and puffs */
  const ballGeo = new THREE.SphereGeometry(0.19, 14, 10);
  if (thanks) {
    // a little pumpkin: squashed, ribbed
    const p = ballGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const rib = 1 + 0.08 * Math.cos(Math.atan2(z, x) * 8);
      p.setXYZ(i, x * rib * 1.15, y * 0.8, z * rib * 1.15);
    }
    ballGeo.computeVertexNormals();
  }
  const ballMat = thanks ? new THREE.MeshStandardMaterial({ color: 0xf07a1a, roughness: 0.6, emissive: 0x3a1400 }) : new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.35, metalness: 0.8 });
  const stemGeo = new THREE.CylinderGeometry(0.025, 0.035, 0.09, 6);
  const stemMat = new THREE.MeshStandardMaterial({ color: 0x4a6a1a, roughness: 0.8 });
  const balls: Ball[] = [];
  for (let k = 0; k < 14; k++) {
    const mesh = new THREE.Mesh(ballGeo, ballMat);
    if (thanks) { const st = new THREE.Mesh(stemGeo, stemMat); st.position.y = 0.17; mesh.add(st); }
    mesh.visible = false;
    scene.add(mesh);
    balls.push({ s: 0, lat: 0, y: 0, vs: 0, vl: 0, vy: 0, age: 0, bounces: 0, mesh, live: false, trail: 0, rider: 0, dmg: 1 });
  }
  // tyres and cans, or on Thanksgiving a giant drumstick and a pumpkin pie
  const tyreGeo = thanks ? new THREE.SphereGeometry(0.42, 14, 10).scale(1, 0.85, 1.5) : new THREE.TorusGeometry(0.42, 0.18, 10, 20);
  const canGeo = thanks ? new THREE.CylinderGeometry(0.55, 0.45, 0.22, 20) : new THREE.CylinderGeometry(0.3, 0.3, 0.8, 12);
  const thrownMatA = thanks ? new THREE.MeshStandardMaterial({ color: 0xa8521e, roughness: 0.5 }) : new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
  const thrownMatB = thanks ? new THREE.MeshStandardMaterial({ color: 0xd8a060, roughness: 0.8 }) : new THREE.MeshStandardMaterial({ color: 0xb8392e, roughness: 0.5, metalness: 0.4 });
  const thrown: Thrown[] = [];
  for (let k = 0; k < 6; k++) {
    const mesh = new THREE.Mesh(k % 2 ? canGeo : tyreGeo, k % 2 ? thrownMatB : thrownMatA);
    if (thanks && k % 2 === 0) {
      const bone = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.6, 8), new THREE.MeshStandardMaterial({ color: 0xf4ecd8, roughness: 0.6 }));
      bone.rotation.x = Math.PI / 2;
      bone.position.z = 0.8;
      mesh.add(bone);
    } else if (thanks) {
      const fill = new THREE.Mesh(new THREE.CylinderGeometry(0.47, 0.47, 0.05, 20), new THREE.MeshStandardMaterial({ color: 0xd86a1a, roughness: 0.6 }));
      fill.position.y = 0.1;
      mesh.add(fill);
      const cream = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), new THREE.MeshStandardMaterial({ color: 0xfffaf0, roughness: 0.7 }));
      cream.position.y = 0.16;
      mesh.add(cream);
    }
    mesh.visible = false;
    scene.add(mesh);
    thrown.push({ s: 0, lat: 0, y: 0, vs: 0, vl: 0, vy: 0, age: 0, spin: 0, mesh, live: false, targetLat: 0, passed: false, kind: k % 2, rider: 0, car: null });
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
  for (let k = 0; k < 170; k++) {
    const mat = new THREE.SpriteMaterial({ map: puffTex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    scene.add(sprite);
    puffs.push({ sprite, mat, s: 0, lat: 0, y: 0, vs: 0, vl: 0, vy: 0, age: 0, life: 1, size: 1, grow: 1, kind: "smoke", live: false });
  }
  let puffNext = 0;
  const PUFF_COLOR: Record<Puff["kind"], number> = { smoke: 0x8a8a8a, black: 0x1a1a1c, dust: 0x7a6650, fire: 0xff8a2a, spark: 0xffd27a };
  const puff = (kind: Puff["kind"], s: number, lat: number, y: number, vs: number, vl: number, vy: number, size: number, life: number): void => {
    const p = puffs[puffNext];
    puffNext = (puffNext + 1) % puffs.length;
    Object.assign(p, { kind, s, lat, y, vs, vl, vy, size, life, age: 0, live: true, grow: kind === "smoke" || kind === "black" ? 2.2 : kind === "dust" ? 1.6 : kind === "fire" ? 0.8 : 0.2 });
    p.mat.blending = kind === "fire" || kind === "spark" ? THREE.AdditiveBlending : THREE.NormalBlending;
    p.mat.color.set(PUFF_COLOR[kind]);
    p.sprite.visible = true;
  };

  // Aim: dots along the predicted arc and a ring where it lands, one set per local truck.
  const dotGeo = new THREE.SphereGeometry(0.07, 8, 6);
  const DOTS = 16;
  const aimSets = local.map((r) => {
    const tint = mode === "duo" ? RIDER_LOOK[r.idx].css : "#ffe08a";
    const dots = new THREE.InstancedMesh(dotGeo, new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.75, depthWrite: false }), DOTS);
    dots.frustumCulled = false;
    scene.add(dots);
    const reticle = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.15, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.9, depthWrite: false }));
    scene.add(reticle);
    return { r, dots, reticle, tint };
  });

  /* ------------------------------------------------------------ state */
  let best = 0;
  try { best = Number(localStorage.getItem("cannonrun.best") ?? 0) || 0; } catch { /* private window */ }

  let en = { ramCd: 0, s: -140, lat: 0, vl: 0, v: 40, hp: 4, max: 4, level: 1, hitSlow: 0, lunge: 0, lungeT: 5, throwT: 4, wreck: 0, roll: 0, rollV: 0, y: 0, vy: 0, dodge: 0, rage: 0, seated: true };
  const tb = { phase: 0, t: 0, rider: 0, s: 0, lat: 0, y: 0, yaw: 0, carrying: false, walk: 0 };
  let phase: Phase = "intro";
  let gen = 0;
  let introT = 0;
  let time = 0;
  let score = 0;
  let cash = 0;
  let kmPaid = 0;
  let hits = 0;
  let wrecks = 0;
  let toast = "";
  let toastT = 0;
  let talk = "";
  let talkT = 0;
  let tauntT = 3;
  let trafficT = 6;
  let respawnT = 0;
  let backupT = 16 + Math.random() * 30;
  let alert = "";
  let alertT = 0;
  let ended = false;
  let muted = false;
  let fin: Finale | null = null;
  let won = false;
  const keys = new Set<string>();
  const stick = { x: 0, y: 0 };
  const held = { boost: false };
  let mouseX = -1;
  let mouseY = -1;

  const say = (t: string, d = 2.2): void => { toast = t; toastT = d; };
  // Once he has you, Mort stops talking.
  const shout = (t: string, d = 2.2): void => { if (phase === "takeback" || phase === "over") return; talk = t; talkT = d; };
  /* Mort, and in two-player his cousin Lunatic Linda. Every bit of chaser code
     reads en, foe and a few timers; use(c) points them at one chaser. */
  interface Chaser { en: typeof en; foe: Foe; respawnT: number; backupT: number; tauntT: number; talk: string; talkT: number; linda: boolean; net: { s: number; lat: number }; bubble: HTMLDivElement }
  const mort: Chaser = { en, foe, respawnT, backupT, tauntT, talk, talkT, linda: false, net: { s: en.s, lat: en.lat }, bubble };
  const chasers: Chaser[] = [mort];
  let cur = mort;
  const sync = (): void => { Object.assign(cur, { foe, respawnT, backupT, tauntT, talk, talkT }); };
  const use = (c: Chaser): void => {
    if (c === cur) return;
    sync();
    cur = c;
    ({ en, foe, respawnT, backupT, tauntT, talk, talkT } = c);
  };
  let linda: Chaser | null = null;
  // Lunatic Linda, Mort's cousin: two-player only (Jack, Nov 2026: "go w linda").
  const LINDA_ON = true;
  if (two && LINDA_ON) {
    const lf = buildFoe(1, true);
    scene.add(lf.root);
    const le = { ...en };
    linda = { en: le, foe: lf, respawnT: 0, backupT: 10 + Math.random() * 30, tauntT: 5, talk: "", talkT: 0, linda: true, net: { s: le.s, lat: le.lat }, bubble: lindaBubble };
    chasers.push(linda);
  }
  const nameOf = (r: Rider): string => (mode === "duo" ? `P${r.idx + 1}` : r.idx === mine ? "You" : "Your friend");

  /* ------------------------------------------------------------ input */
  const P2_FIRE = new Set(["Enter", "/", "0", "l"]);
  const onKey = (e: KeyboardEvent): void => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (e.type === "keydown") {
      audio.start();
      if (mode === "duo") {
        if (k === " " || k === "f") { riders[0].wantFire = true; e.preventDefault(); }
        if (P2_FIRE.has(k)) { riders[1].wantFire = true; e.preventDefault(); }
      } else if (k === " " || k === "f" || k === "Enter") { me.wantFire = true; e.preventDefault(); }
      if (k.startsWith("Arrow")) e.preventDefault();
      if (k === "Enter" && phase === "over" && !isGuest) api.restart();
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
    if (e.button === 0) me.wantFire = true;
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);
  window.addEventListener("blur", onBlur);
  window.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerdown", onDown);

  const controls = (r: Rider): { steer: number; boost: boolean } => {
    let steer = 0;
    let boost = false;
    if (mode === "duo" && r.idx === 1) {
      if (keys.has("ArrowLeft")) steer -= 1;
      if (keys.has("ArrowRight")) steer += 1;
      boost = keys.has("ArrowUp");
    } else if (mode === "duo") {
      if (keys.has("a")) steer -= 1;
      if (keys.has("d")) steer += 1;
      boost = keys.has("Shift") || keys.has("w") || held.boost;
      if (Math.abs(stick.x) > 0.1) steer = stick.x;
    } else {
      if (keys.has("a") || keys.has("ArrowLeft")) steer -= 1;
      if (keys.has("d") || keys.has("ArrowRight")) steer += 1;
      boost = keys.has("Shift") || keys.has("w") || keys.has("ArrowUp") || held.boost;
      if (Math.abs(stick.x) > 0.1) steer = stick.x;
    }
    return { steer, boost };
  };

  /* ------------------------------------------------------------ sound */
  const audio = (() => {
    let ctx: AudioContext | null = null;
    let master: GainNode | null = null;
    let myEngine: OscillatorNode | null = null;
    let myGain: GainNode | null = null;
    let hisEngine: OscillatorNode | null = null;
    let hisGain: GainNode | null = null;
    let noise: AudioBuffer | null = null;
    const burst = (dur: number, freq: number, gain: number, type: BiquadFilterType = "lowpass", delay = 0): void => {
      if (!ctx || !master || !noise) return;
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      const g = ctx.createGain();
      const t = ctx.currentTime + delay;
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
    /** quieter the further from the camera */
    const near = (s: number): number => clamp(1.15 - Math.abs(s - me.s) / 160, 0.25, 1);
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
        myGain.gain.setTargetAtTime(phase === "over" ? 0 : 0.03 + Math.min(1, v / 31) * 0.06, t, 0.2);
        hisEngine.frequency.setTargetAtTime(38 + clamp(60 - gap, 0, 60) * 0.6, t, 0.1);
        hisGain.gain.setTargetAtTime(live ? clamp(1 - Math.abs(gap) / 90, 0, 1) * 0.08 : 0, t, 0.2);
      },
      boom(s: number): void { const k = near(s); burst(0.9, 520, 0.9 * k); tone("sine", 130, 34, 0.7, 0.7 * k); },
      clang(s: number): void { const k = near(s); burst(0.35, 2400, 0.5 * k, "bandpass"); tone("triangle", 900, 420, 0.3, 0.25 * k); },
      crunch(s: number): void { const k = near(s); burst(0.6, 900, 0.7 * k, "bandpass"); tone("sawtooth", 90, 30, 0.5, 0.35 * k); },
      blast(s: number): void { const k = near(s); burst(1.6, 380, 1.0 * k); tone("sine", 90, 22, 1.4, 0.8 * k); },
      /** a car coming down and going up: a sharp crack, a fat low thump, a long rumble */
      explode(s: number): void {
        const k = near(s);
        burst(0.22, 3200, 0.7 * k, "highpass");
        burst(0.5, 700, 1.0 * k);
        tone("sine", 110, 26, 1.1, 0.95 * k);
        burst(2.2, 220, 0.6 * k, "lowpass", 0.08);
        tone("triangle", 60, 30, 1.6, 0.3 * k, 0.1);
      },
      scrape(s: number): void { const k = near(s); burst(0.8, 1800, 0.25 * k, "bandpass"); },
      whistle(): void { tone("sine", 620, 600, 1.4, 0.14); tone("sine", 780, 760, 1.4, 0.11); tone("sine", 930, 905, 1.4, 0.07); burst(1.3, 3200, 0.12, "bandpass"); },
      horn(): void { tone("square", 330, 328, 0.55, 0.12); tone("square", 415, 412, 0.55, 0.1); },
      whoosh(): void { burst(0.5, 1200, 0.25, "highpass"); },
      whack(s: number): void { const k = near(s); burst(0.08, 1500, 0.45 * k, "bandpass"); tone("triangle", 220, 140, 0.08, 0.2 * k); },
      pop(s: number): void { const k = near(s); burst(0.3, 900, 0.5 * k); tone("sine", 220, 70, 0.25, 0.35 * k); },
      door(): void { burst(0.18, 600, 0.5, "bandpass"); tone("square", 120, 80, 0.12, 0.15); },
      mute(m: boolean): void { if (master && ctx) master.gain.setTargetAtTime(m ? 0 : 0.55, ctx.currentTime, 0.05); },
      stop(): void { void ctx?.close(); ctx = null; },
    };
  })();

  /* ------------------------------------------------------------ effects */
  // Everything that makes a bang goes through emit(), so the host can hand
  // the same bangs to the guest in its next snapshot.
  const outbox: (string | number)[][] = [];
  const play = (kind: string, s: number, lat: number, y: number, ri: number): void => {
    const r = riders[ri] ?? me;
    switch (kind) {
      case "fire": {
        toWorld(s, lat, y, flash.position);
        flash.intensity = 900;
        if (r) { r.recoil = 1; r.shake = Math.max(r.shake, 0.5); }
        const v = r?.v ?? 31;
        for (let k = 0; k < 7; k++) puff("smoke", s, lat, y, v - 10 - Math.random() * 8, (Math.random() - 0.5) * 3, Math.random() * 2, 0.6, 1.4);
        for (let k = 0; k < 4; k++) puff("fire", s, lat, y, v - 18, (Math.random() - 0.5) * 4, (Math.random() - 0.3) * 3, 1.2, 0.18);
        audio.boom(s);
        break;
      }
      case "hit":
        audio.clang(s);
        for (let k = 0; k < 10; k++) puff("spark", s, lat, y, en.v + (Math.random() - 0.3) * 14, (Math.random() - 0.5) * 12, Math.random() * 8, 0.45, 0.4);
        for (let k = 0; k < 5; k++) puff("smoke", s, lat, y, en.v - 4, (Math.random() - 0.5) * 2, 1 + Math.random(), 1.3, 1.4);
        break;
      case "wreck":
        boomLight.intensity = 3000;
        toWorld(s, lat, 2, boomLight.position);
        audio.blast(s);
        for (let k = 0; k < 26; k++) puff("fire", s, lat, 1.2, en.v + (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10, Math.random() * 9, 2.4, 0.7 + Math.random() * 0.5);
        for (let k = 0; k < 18; k++) puff("black", s, lat, 1.5, en.v - 6, (Math.random() - 0.5) * 6, 2 + Math.random() * 3, 2.6, 2.6);
        break;
      case "ram":
        audio.crunch(s);
        for (let k = 0; k < 8; k++) puff("spark", s, lat, 0.8, r?.v ?? 31, (Math.random() - 0.5) * 10, Math.random() * 6, 0.4, 0.4);
        if (r) r.shake = Math.max(r.shake, 1);
        break;
      case "crunch":
        audio.crunch(s);
        for (let k = 0; k < 6; k++) puff("spark", s, lat, y, en.v, (Math.random() - 0.5) * 10, Math.random() * 6, 0.4, 0.4);
        for (let k = 0; k < 4; k++) puff("dust", s, lat, 0.4, en.v * 0.6, (Math.random() - 0.5) * 4, 1, 1.4, 1.2);
        break;
      case "tink":
        audio.clang(s);
        for (let k = 0; k < 8; k++) puff("spark", s, lat, y, me.v, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, 0.4, 0.35);
        break;
      case "smack":
        audio.clang(s);
        for (let k = 0; k < 6; k++) puff("spark", s, lat, y, r?.v ?? 31, (Math.random() - 0.5) * 8, Math.random() * 5, 0.4, 0.35);
        if (r) r.shake = Math.max(r.shake, 1);
        break;
      case "dust":
        for (let k = 0; k < 4; k++) puff("dust", s, lat, 0.3, 0, (Math.random() - 0.5) * 3, 1 + Math.random(), 0.9, 1.0);
        break;
      case "scrape":
        audio.scrape(s);
        break;
      case "boom":
        // a car that came down hard
        boomLight.intensity = Math.max(boomLight.intensity, 2600);
        toWorld(s, lat, 2, boomLight.position);
        audio.explode(s);
        for (let k = 0; k < 22; k++) puff("fire", s, lat, 0.8 + Math.random(), (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 9, 2 + Math.random() * 8, 2.2, 0.6 + Math.random() * 0.5);
        for (let k = 0; k < 14; k++) puff("black", s, lat, 1.4, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 4, 2 + Math.random() * 3, 2.4, 2.8);
        for (let k = 0; k < 14; k++) puff("spark", s, lat, 1, (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16, 4 + Math.random() * 8, 0.4, 0.6);
        break;
      case "blast":
        boomLight.intensity = 3000;
        audio.blast(s);
        break;
      case "horn": audio.horn(); break;
      case "whistle": audio.whistle(); break;
      case "whoosh": audio.whoosh(); break;
      case "door": audio.door(); break;
      case "clank": audio.clang(s); break;
      case "gogo":
        henchSay = { i: ri, t: 2.2 };
        audio.horn();
        break;
      case "pop":
        audio.clang(s);
        for (let k = 0; k < 8; k++) puff("spark", s, lat, y, en.v * 0.5, (Math.random() - 0.5) * 8, Math.random() * 6, 0.4, 0.4);
        for (let k = 0; k < 4; k++) puff("dust", s, lat, 0.4, 0, (Math.random() - 0.5) * 3, 1, 1, 1);
        break;
      case "whack":
        audio.whack(s);
        for (let k = 0; k < 3; k++) puff("spark", s, lat, y, r?.v ?? 31, (Math.random() - 0.5) * 4, Math.random() * 3, 0.25, 0.25);
        if (r) r.shake = Math.max(r.shake, 0.35);
        break;
      case "thunk":
        audio.clang(s);
        for (let k = 0; k < 5; k++) puff("spark", s, lat, y, en.v * 0.6, (Math.random() - 0.5) * 6, Math.random() * 4, 0.35, 0.3);
        break;
      case "auto":
        audio.pop(s);
        for (let k = 0; k < 3; k++) puff("smoke", s, lat, y, (r?.v ?? 31) - 6, (Math.random() - 0.5) * 2, 1, 0.35, 0.8);
        puff("fire", s, lat, y, (r?.v ?? 31) - 10, 0, 0, 0.5, 0.1);
        break;
    }
  };
  const emit = (kind: string, s: number, lat: number, y: number, ri = -1): void => {
    play(kind, s, lat, y, ri);
    if (mode === "host") outbox.push([kind, +s.toFixed(2), +lat.toFixed(2), +y.toFixed(2), ri]);
  };

  /* ------------------------------------------------------------ rules */
  const alive = (r: Rider): boolean => !r.out && !r.gone;
  /** Mort goes for the rearmost truck still fighting. */
  const target = (): Rider => {
    let t: Rider | null = null;
    // Mort goes for the truck at the back; Linda for the one in front
    for (const r of riders) if (alive(r) && (!t || (cur.linda ? r.s > t.s : r.s < t.s))) t = r;
    return t ?? riders[tb.rider] ?? me;
  };
  const leadS = (): number => riders.reduce((m, r) => (r.gone ? m : Math.max(m, r.s)), -Infinity);

  const spawnFoe = (level: number, gap: number): void => {
    scene.remove(foe.root);
    disposeTree(foe.root);
    foe = buildFoe(level, cur.linda);
    scene.add(foe.root);
    const spec = RIDES[Math.min(level - 1, RIDES.length - 1)];
    const max = spec.hp + Math.max(0, level - RIDES.length) * 3 + (two ? 5 : 0);
    const t = target();
    Object.assign(en, { ramCd: 0, s: t.s - gap - (cur.linda ? 30 : 0), lat: cur.linda ? t.lat : -t.lat, vl: 0, v: t.v + 14, hp: max, max, level, hitSlow: 0, lunge: 0, lungeT: 6, throwT: 3.5, wreck: 0, roll: 0, rollV: 0, y: 0, vy: 0, rage: 0, seated: true });
  };

  const muzzle = (r: Rider): { s: number; lat: number; y: number; cp: number } => {
    const cp = Math.cos(r.aim.pitch);
    return {
      s: r.s - 1.15 - 1.55 * cp * Math.cos(r.aim.yaw),
      lat: r.lat + 1.55 * cp * Math.sin(r.aim.yaw),
      y: 1.29 + 1.55 * Math.sin(r.aim.pitch),
      cp,
    };
  };
  const canFire = (r: Rider): boolean => r.reload <= 0 && alive(r) && !r.disarmed && (phase === "play" || phase === "intro");
  /** The ball itself: only ever on the host (or alone). */
  const fireBall = (r: Rider): void => {
    r.reload = RELOAD * r.reloadMul;
    const m = muzzle(r);
    const b = balls.find((x) => !x.live) ?? balls[0];
    Object.assign(b, {
      s: m.s, lat: m.lat, y: m.y,
      vs: r.v - MUZZLE * m.cp * Math.cos(r.aim.yaw),
      vl: MUZZLE * m.cp * Math.sin(r.aim.yaw),
      vy: MUZZLE * Math.sin(r.aim.pitch),
      age: 0, bounces: 0, live: true, trail: 0, rider: r.idx, dmg: 1,
    });
    emit("fire", m.s, m.lat, m.y, r.idx);
    // anybody hanging off your tailgate gets the muzzle blast in the face
    for (const h of henchmen) if (h.state === 2 && h.rider === r.idx) knockHench(h, "POINT BLANK!", 1);
  };

  const hurt = (r: Rider, n: number, why: string): void => {
    if (phase !== "play" || !alive(r)) return;
    r.hull = Math.max(0, r.hull - n);
    r.shake = Math.max(r.shake, 1);
    say(two ? `${nameOf(r).toUpperCase()}: ${why}` : why, 1.6);
    if (r.hull <= 0) knockOut(r);
  };
  const knockOut = (r: Rider): void => {
    r.out = true;
    emit("crunch", r.s - 2, r.lat, 1, r.idx);
    const others = riders.filter((o) => o !== r && alive(o));
    if (others.length) {
      r.respawn = RESPAWN;
      say(`${nameOf(r)} ${r.idx === mine && mode !== "duo" ? "are" : "is"} out! Back in ${RESPAWN}s. Hold him off!`, 3);
      shout("ONE DOWN!", 2);
    } else startTakeback(r);
  };

  const startTakeback = (r: Rider): void => {
    phase = "takeback";
    Object.assign(tb, { phase: 0, t: 0, rider: r.idx, carrying: false, walk: 0 });
    talk = "";
    talkT = 0;
    say("He's got you.", 3);
    for (const o of riders) o.wantFire = false;
    for (const h of henchmen) if (h.state >= 0 && h.state <= 2) knockHench(h, "", 0);
    alert = "";
  };

  /* ------------------------------------------------------------ his backup */
  const spawnBackup = (): void => {
    const n = en.level === 1 ? 1 : en.level >= 4 ? 3 : 2;
    const tgt = target();
    let first = -1;
    for (let k = 0; k < n; k++) {
      const i = henchmen.findIndex((h) => h.state === -1);
      if (i < 0) break;
      const h = henchmen[i];
      Object.assign(h, {
        s: en.s + foe.hatch.z - k * 0.9, lat: clamp(en.lat - foe.hatch.x + k * 0.4, -HALF, HALF), y: 1.1, v: en.v, vl: -1.5, vy: 3,
        state: 0, t: 0, rider: tgt.idx, rx: 0, spin: 0, walk: Math.random() * 6, yaw: 0, whack: 0.5,
      });
      if (first < 0) first = i;
    }
    if (first < 0) return;
    const h = henchmen[first];
    emit("gogo", h.s, h.lat, 2.2, first);
    alert = n > 1 ? `⚠ ${n} HENCHMEN COMING! SHOOT THEM OR SWERVE THEM OFF` : "⚠ HENCHMAN COMING! SHOOT HIM OR SWERVE HIM OFF";
    alertT = 3.2;
  };
  const knockHench = (h: Henchman, label: string, pay: number): void => {
    if (h.state < 0 || h.state >= 3) return;
    const i = henchmen.indexOf(h);
    h.state = 3;
    h.t = 0;
    h.y = Math.max(h.y, 0.3);
    h.vy = 5 + Math.random() * 3;
    h.vl = (Math.random() - 0.5) * 8;
    h.v *= 0.6;
    h.spin = (Math.random() > 0.5 ? 1 : -1) * (6 + Math.random() * 4);
    emit("pop", h.s, h.lat, h.y + 1, i);
    if (pay) {
      cash += 40 * pay;
      score += 150 * pay;
      say(`${label} +$${40 * pay}`, 1.3);
    } else if (label) say(label, 1.3);
  };
  const stepHenchmen = (dt: number): void => {
    // backup every half a minute to a minute and eleven, whatever he is driving
    if (phase === "play") {
      for (const c of chasers) {
        use(c);
        if (en.wreck > 0) continue;
        backupT -= dt;
        if (backupT <= 0 && target().s - en.s < 70) { backupT = 16 + Math.random() * 30; spawnBackup(); }
      }
      use(mort);
    }
    for (const h of henchmen) {
      if (h.state < 0) continue;
      h.t += dt;
      const r = riders[h.rider];
      if (h.state === 0) {
        // out of the side and down onto the road, already running
        h.vy -= G * dt;
        h.y = Math.max(0, h.y + h.vy * dt);
        h.s += h.v * dt;
        h.lat += h.vl * dt;
        h.walk += dt * 14;
        if (h.y === 0) h.state = 1;
      } else if (h.state === 1) {
        if (!alive(r)) { const o = riders.find(alive); if (o) h.rider = o.idx; }
        const tr = riders[h.rider];
        const gapH = tr.s - 3.1 - h.s;
        // cartoon cousins: they sprint faster than a pickup
        const want = tr.v + clamp(gapH * 0.5, -4, 9);
        h.v = lerp(h.v, want, Math.min(1, dt * 2));
        h.s += h.v * dt;
        h.vl = clamp(tr.lat - h.lat, -1, 1) * 4;
        h.lat += h.vl * dt;
        h.walk += dt * (10 + h.v * 0.15);
        h.yaw = lerp(h.yaw, -Math.atan2(h.vl, Math.max(h.v, 1)), Math.min(1, dt * 6));
        if (gapH < 0.4 && Math.abs(tr.lat - h.lat) < 0.9 && alive(tr) && henchmen.filter((o) => o.state === 2 && o.rider === tr.idx).length < 2) {
          h.state = 2;
          h.t = 0;
          h.whack = 0.6;
          h.rider = tr.idx;
          say(`${two ? nameOf(tr).toUpperCase() + ": " : ""}HENCHMAN ON THE TAILGATE! SWERVE OR SHOOT`, 2);
        }
        if (h.state === 1 && (gapH < -12 || h.t > 40)) h.state = -1;
        // traffic does not stop for him
        for (const t of traffic) {
          if (h.state === 1 && Math.abs(t.s - h.s) < 2.6 && Math.abs(t.lat - h.lat) < 1.3) { emit("crunch", h.s, h.lat, 1); knockHench(h, "RUN OVER BY A CIVILIAN!", 0); }
        }
      } else if (h.state === 2) {
        // hanging off the tailgate, beating it with a stick
        const side = henchmen.filter((o) => o.state === 2 && o.rider === r.idx).indexOf(h) === 0 ? 1 : -1;
        h.s = r.s - 2.95;
        h.lat = r.lat + side * 0.45;
        h.y = 0.35;
        h.v = r.v;
        h.yaw = 0;
        h.whack -= dt;
        if (h.whack <= 0 && phase === "play") {
          h.whack = 0.8;
          if (alive(r)) {
            emit("whack", h.s + 0.4, h.lat, 1.0, r.idx);
            r.hull = Math.max(0, r.hull - 4);
            if (r.hull <= 0) knockOut(r);
          }
        }
        // swerve hard and he comes off
        if (Math.abs(r.vl) > 5.5) r.shakeOff += dt; else r.shakeOff = Math.max(0, r.shakeOff - dt * 0.5);
        if (r.shakeOff > 0.5) { r.shakeOff = 0; knockHench(h, "SHOOK HIM OFF!", 1); }
        else if (!alive(r) || phase !== "play") knockHench(h, "", 0);
      } else if (h.state === 3) {
        h.vy -= G * dt;
        h.y += h.vy * dt;
        h.s += h.v * dt;
        h.lat += h.vl * dt;
        h.rx += h.spin * dt;
        if (h.y <= 0 && h.vy < 0) { h.y = 0; h.state = 4; h.t = 0; h.rx = Math.PI / 2; h.v = 0; }
      } else if (h.state === 4) {
        if (h.t > 6) h.state = -1;
      }
    }
  };
  /** The garage's roof gun: henchmen first, then Mort. */
  const autoGuns = (dt: number): void => {
    for (const r of riders) {
      if (r.auto <= 0 || !alive(r) || r.disarmed || phase !== "play") continue;
      r.autoT -= dt;
      const clinger = henchmen.find((h) => h.state === 2 && h.rider === r.idx);
      let tS = en.s + (en.v - r.v) * 0.6;
      let tL = en.lat;
      let ok = en.wreck === 0 && r.s - en.s < 120;
      const runner = henchmen.filter((h) => h.state === 1 && r.s - h.s < 60).sort((a, b) => b.s - a.s)[0];
      if (runner) { tS = runner.s + (runner.v - r.v) * 0.5; tL = runner.lat; ok = true; }
      if (clinger) { tS = clinger.s - 3; tL = clinger.lat; ok = true; }
      const a = solveAim(r.s - 2.3, r.lat + 0.7, 1.6, tS, tL, MUZZLE * 0.9);
      r.autoYaw = lerpAngle(r.autoYaw, a.yaw, Math.min(1, dt * 10));
      r.autoPitch = a.pitch;
      if (r.autoT > 0 || !ok) continue;
      r.autoT = [0, 2.6, 1.9, 1.3][Math.min(3, r.auto)];
      const muz = { s: r.s - 2.3 - 0.8 * Math.cos(a.yaw), lat: r.lat + 0.7 + 0.8 * Math.sin(a.yaw), y: 1.6 };
      if (clinger) {
        knockHench(clinger, "AUTO CANNON GOT HIM!", 1);
        emit("auto", muz.s, muz.lat, muz.y, r.idx);
        continue;
      }
      const b = balls.find((x) => !x.live) ?? balls[0];
      const sp = MUZZLE * 0.9;
      Object.assign(b, {
        s: muz.s, lat: muz.lat, y: muz.y,
        vs: r.v - sp * Math.cos(a.pitch) * Math.cos(a.yaw), vl: sp * Math.cos(a.pitch) * Math.sin(a.yaw), vy: sp * Math.sin(a.pitch),
        age: 0, bounces: 0, live: true, trail: 0, rider: r.idx, dmg: 0.35 + 0.25 * r.punch,
      });
      emit("auto", muz.s, muz.lat, muz.y, r.idx);
    }
  };

  const hitFoe = (b: { s: number; lat: number; y: number }, label: string, dmg = 1): void => {
    if (en.wreck > 0 || phase === "takeback" || phase === "over") return;
    en.hp = Math.round((en.hp - dmg) * 100) / 100;
    hits += 1;
    const pay = Math.max(1, Math.round(25 * en.level * Math.min(1, dmg)));
    score += Math.round(100 * en.level * Math.min(1, dmg));
    cash += pay;
    en.hitSlow = 12;
    en.rage = 1;
    en.dodge = (Math.random() - 0.5) * 4;
    emit("hit", b.s, b.lat, b.y);
    if (en.hp <= 0) {
      en.hp = 0;
      en.wreck = 0.001;
      en.vy = 6;
      en.rollV = (Math.random() > 0.5 ? 1 : -1) * 4.5;
      wrecks += 1;
      score += 1000 * en.level;
      cash += 250 * en.level;
      for (const r of riders) if (alive(r)) r.hull = Math.min(r.max, r.hull + 15);
      emit("wreck", en.s, en.lat, 1);
      if (!cur.linda && rideAt(en.level).kind === "train" && FINALE_ON) say("THE TRAIN IS DOWN! Everybody's pulling over...", 4);
      else say(`WRECKED ${cur.linda ? "LINDA'S " : ""}${RIDES[Math.min(en.level - 1, RIDES.length - 1)].name.replace(/^the /, cur.linda ? "" : "the ").toUpperCase()}! +$${250 * en.level}`, 2.6);
      const back = cur.linda ? L_COMEBACK : COMEBACK;
      shout(back[Math.floor(Math.random() * back.length)], 2.6);
      respawnT = 5.5;
    } else {
      say(`${label} +$${pay}`, 1.1);
      const ow = cur.linda ? L_OUCH : OUCH;
      shout(ow[Math.floor(Math.random() * ow.length)], 1.6);
    }
  };

  /** Knock a car: tip it onto its side, or throw it in the air spinning. */
  const launch = (t: Traffic, fromLat: number, force: number, fly: boolean): void => {
    const side = Math.sign(t.lat - fromLat) || (Math.random() > 0.5 ? 1 : -1);
    t.side = side;
    t.hitCd = 0.8;
    if (fly) {
      t.mode = 2;
      t.air = 0;
      t.vy = 6.5 + force * 0.9 + Math.random() * 2;
      t.vl = side * (3 + force * 0.5);
      t.v = Math.max(t.v, en.v * 0.7) + force;
      t.wx = (Math.random() - 0.5) * 7;
      t.wy = (Math.random() - 0.5) * 5;
      t.wz = side * (3 + Math.random() * 4);
    } else {
      t.mode = 1;
      t.vl = side * 4.5;
      t.v = Math.max(t.v, en.v * 0.6);
      t.vy = 0;
    }
  };

  /** Point the cannon where the mouse (or a tap) meets the road. */
  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.02);
  const hitP = new THREE.Vector3();
  const NDC = new THREE.Vector2();
  const updateAim = (r: Rider): void => {
    const mouseRider = r.idx === mine;
    if (!mouseRider || mouseX < 0) {
      // No pointer: point at him. Also what a phone sees until a tap, and what P2 always does.
      setAimTo(r, en.s, en.lat, true);
      return;
    }
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    ray.setFromCamera(NDC.set((mouseX / w) * 2 - 1, -(mouseY / h) * 2 + 1), camera);
    if (ray.ray.intersectPlane(plane, hitP)) {
      const p = toRoad(hitP.x, hitP.z);
      setAimTo(r, p.s, p.lat, false);
    } else setAimTo(r, r.s - 160, r.aim.lat, false);
  };
  /** Low-angle ballistic solution to land at road point (s, lat), in the truck's frame. */
  const setAimTo = (r: Rider, s: number, lat: number, auto: boolean): void => {
    if (en.wreck === 0 && phase !== "over" && phase !== "takeback") {
      const dS = s - en.s;
      const dL = lat - en.lat;
      if (auto || Math.hypot(dS, dL) < 7.5) {
        const d0 = Math.max(4, r.s - 1.15 - en.s);
        const tf = d0 / MUZZLE;
        s = en.s + (en.v - r.v) * tf * 1.05;
        lat = en.lat + en.vl * tf + (auto ? 0 : dL * 0.25);
      }
    }
    const a = solveAim(r.s - 1.15, r.lat, 1.3, s, lat, MUZZLE);
    r.aim.yaw = clamp(a.yaw, -0.85, 0.85);
    r.aim.pitch = a.pitch;
    r.aim.lat = lat;
  };
  /** Low-angle ballistic solution from (s0, lat0, y0) backward to land at road point (s, lat). */
  const solveAim = (s0: number, lat0: number, y0: number, s: number, lat: number, speed: number): { yaw: number; pitch: number } => {
    const D = clamp(s0 - s, 5, 190);
    const L = lat - lat0;
    const yaw = Math.atan2(L, D);
    const dist = Math.hypot(D, L);
    let lo = -0.25;
    let hi = 0.75;
    const range = (p: number): number => {
      const vh = speed * Math.cos(p);
      const vv = speed * Math.sin(p);
      return vh * ((vv + Math.sqrt(Math.max(0, vv * vv + 2 * G * y0))) / G);
    };
    if (range(hi) < dist) return { yaw, pitch: hi };
    for (let k = 0; k < 18; k++) {
      const m = (lo + hi) / 2;
      if (range(m) < dist) lo = m; else hi = m;
    }
    return { yaw, pitch: (lo + hi) / 2 };
  };

  /* ------------------------------------------------------------ your truck, wherever it is simulated */
  const driveRider = (r: Rider, dt: number): void => {
    r.reload = Math.max(0, r.reload - dt);
    if (r.gone) return;
    const { steer, boost: wantBoost } = controls(r);
    const canDrive = phase === "play" || phase === "intro";
    const s0 = canDrive && !r.out ? steer : 0;
    // Looking back, screen right is the truck's left.
    const wantLat = r.lat - s0 * 9;
    r.vl = lerp(r.vl, clamp(wantLat - r.lat, -1, 1) * 9 * Math.abs(s0), Math.min(1, dt * 6));
    if (s0 === 0) r.vl *= Math.pow(0.02, dt);
    r.lat = clamp(r.lat + r.vl * dt, -LAT_MAX, LAT_MAX);
    const boosting = wantBoost && r.boost > 0.02 && phase === "play" && !r.out;
    r.boost = clamp(r.boost + (boosting ? -0.32 * r.drainMul : 0.09) * dt, 0, 1);
    if (phase === "takeback" || phase === "over") {
      r.v = Math.max(0, r.v - 13 * dt);
    } else {
      let want = 31 + r.engine * 1.5 + (boosting ? 13 + r.bonusV : 0) + Math.min(10, r.s / 1500);
      // a rubber band, so two trucks stay in one fight
      if (two) {
        const o = riders[1 - r.idx];
        if (!o.gone) want += clamp((o.s - r.s) * 0.22, -5, 5);
      }
      if (r.out) want = 30;
      r.v = lerp(r.v, want, Math.min(1, dt * 1.4));
    }
    if (r.bump > 0) { r.v += r.bump * dt * 4; r.bump = Math.max(0, r.bump - dt * 8); }
    r.s += r.v * dt;
    // shoulder past traffic and each other rather than through
    for (const t of traffic) if (t.live && t.mode !== 2 && Math.abs(t.s - r.s) < 4.5 && Math.abs(t.lat - r.lat) < 2) r.lat += Math.sign(r.lat - t.lat || 1) * dt * 8;
    if (two) {
      const o = riders[1 - r.idx];
      if (!o.gone && Math.abs(o.s - r.s) < 5 && Math.abs(o.lat - r.lat) < 2.1) {
        r.lat += Math.sign(r.lat - o.lat || (r.idx ? -1 : 1)) * dt * 9;
        if (Math.abs(o.lat - r.lat) < 1.6 && Math.random() < dt * 6) emit("scrape", r.s, (r.lat + o.lat) / 2, 0.8);
      }
    }
    r.lat = clamp(r.lat, -LAT_MAX, LAT_MAX);
  };

  /** Host only: the guest's truck, eased onto what it last said. */
  const followRemote = (r: Rider, dt: number): void => {
    r.reload = Math.max(0, r.reload - dt);
    if (!r.net) return;
    const age = Math.min(0.5, time - r.net.at);
    r.v = r.net.v;
    r.vl = r.net.vl;
    r.s += r.v * dt;
    r.lat += r.vl * dt;
    const k = Math.min(1, dt * 9);
    r.s += (r.net.s + r.net.v * age - r.s) * k;
    r.lat = clamp(r.lat + (r.net.lat + r.net.vl * age - r.lat) * k, -LAT_MAX, LAT_MAX);
  };

  const stepRiderStatus = (r: Rider, dt: number): void => {
    if (r.gone) return;
    r.shake = Math.max(0, r.shake - dt * 2.4);
    r.recoil = Math.max(0, r.recoil - dt * 3.2);
    if (r.out && r.respawn > 0 && phase === "play") {
      r.respawn -= dt;
      if (r.respawn <= 0) {
        r.respawn = 0;
        r.out = false;
        r.hull = Math.round(r.max * 0.5);
        say(`${nameOf(r)} ${r.idx === mine && mode !== "duo" ? "are" : "is"} back in it!`, 2);
      }
    }
  };

  /* ------------------------------------------------------------ the takeback */
  const WALK = 1.7;
  const doorAt = (): { s: number; lat: number } => ({ s: en.s + foe.door.z, lat: en.lat - foe.door.x });
  const walkTo = (s: number, lat: number, speed: number, dt: number): boolean => {
    const ds = s - tb.s;
    const dl = lat - tb.lat;
    const d = Math.hypot(ds, dl);
    if (d < 0.12) return true;
    const k = Math.min(d, speed * dt) / d;
    tb.s += ds * k;
    tb.lat += dl * k;
    tb.yaw = lerpAngle(tb.yaw, -Math.atan2(dl, ds), Math.min(1, dt * 8));
    tb.walk += dt * speed * 4.2;
    return false;
  };
  const stepTakeback = (dt: number): void => {
    const r = riders[tb.rider];
    tb.t += dt;
    if (tb.phase < 4) {
      // park behind the truck he is robbing
      const ps = r.s - (foe.len / 2 + 4.6);
      en.v = r.v;
      en.s += en.v * dt;
      en.s += (ps - en.s) * Math.min(1, dt * 1.6);
      en.vl = 0;
      en.lat += (r.lat - 0.3 * Math.sign(r.lat || 1) - en.lat) * Math.min(1, dt * 1.5);
    }
    if (tb.phase === 0) {
      if (tb.t > 2.8 && r.v < 0.4) {
        const d = doorAt();
        Object.assign(tb, { phase: 1, t: 0, s: d.s, lat: d.lat, y: 0, yaw: 0, carrying: false, walk: 0 });
        en.seated = false;
        emit("door", d.s, d.lat, 1);
      }
    } else if (tb.phase === 1) {
      if (walkTo(r.s - 3.4, r.lat, WALK, dt)) { tb.phase = 2; tb.t = 0; }
    } else if (tb.phase === 2) {
      // up into the bed, lift it, turn round, down again
      const t = tb.t;
      if (t < 0.55) { tb.y = lerp(0, 0.71, t / 0.55); tb.s = lerp(r.s - 3.4, r.s - 2.3, t / 0.55); tb.walk += dt * 6; }
      else if (t < 1.0) { tb.y = 0.71; tb.s = r.s - 2.3; }
      else if (t < 1.5) {
        if (!tb.carrying) { tb.carrying = true; r.disarmed = true; emit("clank", r.s - 1.2, r.lat, 1.2, r.idx); }
        tb.yaw = lerpAngle(tb.yaw, Math.PI, Math.min(1, dt * 7));
      } else if (t < 2.1) { tb.yaw = Math.PI; tb.y = lerp(0.71, 0, (t - 1.5) / 0.6); tb.s = lerp(r.s - 2.3, r.s - 3.4, (t - 1.5) / 0.6); tb.walk += dt * 6; }
      else { tb.y = 0; tb.phase = 3; tb.t = 0; }
    } else if (tb.phase === 3) {
      const d = doorAt();
      if (walkTo(d.s, d.lat, WALK * 0.75, dt)) {
        tb.phase = 4;
        tb.t = 0;
        en.seated = true;
        emit("door", d.s, d.lat, 1);
      }
    } else if (tb.phase === 4) {
      // and off he goes, round you and away up the road, without a word
      if (tb.t > 0.6) {
        en.v = Math.min(36, en.v + dt * 9);
        const pass = r.lat > 0 ? -LANE : LANE;
        en.lat += (pass - en.lat) * Math.min(1, dt * 2.2);
        en.s += en.v * dt;
      }
      if (tb.t > 0.6 && tb.t - dt <= 0.6) emit("horn", en.s, en.lat, 1);
      if (tb.t > 5) endRun();
    }
  };
  /* ------------------------------------------------------------ the finale: Dot's Diner (finale.ts)
     Wreck the train and the chase is over: everybody pulls over at a diner and
     it is settled on foot, with pies. The highway stays where it is; the finale
     is its own scene, drawn instead of it. */
  const FINALE_ON = true;
  const FIN_SOUND: Record<string, string> = { throw: "whoosh", splat: "pop", shove: "whack", pies: "clank", horn: "horn", door: "door", win: "horn" };
  const finSound = (k: string): void => { const kind = FIN_SOUND[k]; if (kind) emit(kind, me.s, me.lat, 1.2, mine); };
  const ensureFinale = (): Finale => {
    if (fin) return fin;
    fin = createFinale({
      two, colors: riders.map((r) => RIDER_LOOK[r.idx].color), plates: riders.map((r) => RIDER_LOOK[r.idx].plate),
      lindaLevel: linda?.en.level ?? 1, thanks, sound: finSound,
    });
    // the highway's floating labels would hang over the diner
    for (const el of [bubble, lindaBubble, henchBubble, ...tags]) el.style.display = "none";
    news.on = 0;
    news.radioT = 0;
    return fin;
  };
  const startFinale = (stage: FinaleStage = "arrive"): void => {
    if (isGuest) return;
    phase = "finale";
    toast = ""; talk = ""; alert = "";
    for (const r of riders) { r.v = 0; r.wantFire = false; }
    henchmen.forEach((h) => { h.state = -1; h.body.root.visible = false; });
    const f = ensureFinale();
    if (stage !== "arrive") f.skip(stage);
  };
  const finInputs = (): FinaleInput[] => {
    const inp = (r: Rider): FinaleInput => {
      let mx = 0, mz = 0;
      // a friend on another device moves its own hero (fin.remote)
      if (!local.includes(r)) return { mx, mz, throw: false };
      if (mode === "duo" && r.idx === 1) {
        if (keys.has("ArrowLeft")) mx -= 1; if (keys.has("ArrowRight")) mx += 1;
        if (keys.has("ArrowUp")) mz -= 1; if (keys.has("ArrowDown")) mz += 1;
      } else if (mode === "duo") {
        if (keys.has("a")) mx -= 1; if (keys.has("d")) mx += 1;
        if (keys.has("w")) mz -= 1; if (keys.has("s")) mz += 1;
      } else {
        if (keys.has("a") || keys.has("ArrowLeft")) mx -= 1; if (keys.has("d") || keys.has("ArrowRight")) mx += 1;
        if (keys.has("w") || keys.has("ArrowUp")) mz -= 1; if (keys.has("s") || keys.has("ArrowDown")) mz += 1;
      }
      // the phone stick: up on the stick is away from the camera
      if (r === me && Math.hypot(stick.x, stick.y) > 0.12) { mx = stick.x; mz = -stick.y; }
      const t = r.wantFire;
      r.wantFire = false;
      return { mx, mz, throw: t };
    };
    return riders.map(inp);
  };
  const stepFinale = (dt: number): void => {
    if (!fin) return;
    fin.step(dt, finInputs(), "auth");
    const d = fin.done();
    if (d && phase === "finale") {
      won = d === "won";
      if (won) { score += 5000; cash += 1500; }
      phase = "over";
      finish();
    }
  };

  const endRun = (): void => {
    if (phase === "over") return;
    phase = "over";
    finish();
  };
  const finish = (): void => {
    if (ended) return;
    ended = true;
    const sc = Math.max(0, Math.round(score));
    if (sc > best) {
      best = sc;
      try { localStorage.setItem("cannonrun.best", String(best)); } catch { /* ignore */ }
    }
    opts.onEnd?.(Math.round(cash), sc);
  };

  /* ------------------------------------------------------------ the world steps (host, solo, duo) */
  const step = (dt: number): void => {
    time += dt;
    if (toastT > 0) { toastT -= dt; if (toastT <= 0) toast = ""; }
    for (const c of chasers) { use(c); if (talkT > 0) { talkT -= dt; if (talkT <= 0) talk = ""; } }
    use(mort);
    flash.intensity *= Math.pow(0.0005, dt);
    boomLight.intensity *= Math.pow(0.02, dt);
    if (phase === "finale" || (phase === "over" && fin)) {
      if (phase === "finale") stepFinale(dt);
      else fin?.step(dt, [], "auth");
      sendNet(dt);
      return;
    }

    if (phase === "intro") {
      introT += dt;
      if (introT > 0.6 && introT - dt <= 0.6) { emit("horn", en.s, en.lat, 1); shout("HEY! THAT'S MY CANNON!", 2.8); }
      if (introT > 2.6) { phase = "play"; say(two ? "Here he comes. Both barrels!" : "Here he comes. Light him up!", 3); }
    }

    // --- trucks
    for (const r of riders) {
      if (mode === "host" && r.idx === 1) followRemote(r, dt);
      else driveRider(r, dt);
      stepRiderStatus(r, dt);
    }
    if (mode === "host") {
      const r = riders[1];
      if (!r.gone && r.net && time - r.net.at > 8 && phase !== "over") {
        r.gone = true;
        r.out = true;
        say("Your friend lost the signal.", 3);
        if (!riders.some(alive) && phase === "play") startTakeback(riders[0]);
      }
    }
    const lead = leadS();
    if (phase === "play") {
      score += me.v * dt * 0.5;
      const km = Math.floor(lead / 1000);
      if (km > kmPaid) { kmPaid = km; cash += 20; }
    }
    if (phase === "play" && !riders.some(alive)) startTakeback(riders.reduce((a, b) => (a.gone ? b : b.gone ? a : a.s < b.s ? a : b)));

    // --- traffic you overtake, which becomes his problem
    trafficT -= dt;
    if (trafficT <= 0 && phase === "play" && traffic.length < MAX_TRAFFIC) {
      trafficT = (two ? 3.5 : 5) + Math.random() * 6;
      const t0 = target();
      const lat = two ? (Math.random() > 0.5 ? 1 : -1) * (LANE / 2 + 0.2) : t0.lat > 0 ? -LANE / 2 - 0.2 : LANE / 2 + 0.2;
      traffic.push({
        s: lead + 28, lat, y: 0.75, v: 18 + Math.random() * 5, vl: 0, vy: 0, rx: 0, ry: 0, rz: 0, wx: 0, wy: 0, wz: 0,
        color: new THREE.Color(TRAFFIC_COLORS[Math.floor(Math.random() * TRAFFIC_COLORS.length)]), mode: 0, air: 0, side: 1, hitCd: 0, live: true, swerve: 0,
      });
    }
    stepTraffic(dt, true);

    // --- Mort, and Linda
    const stepChaser = (): void => {
    const tgt = target();
    const gap = tgt.s - en.s;
    if (phase === "takeback" && !cur.linda) stepTakeback(dt);
    else if (en.wreck > 0) {
      en.wreck += dt;
      en.v = Math.max(0, en.v - dt * 22);
      en.vy -= G * dt;
      en.y = Math.max(0, en.y + en.vy * dt);
      if (en.y === 0 && en.vy < 0) { en.vy = -en.vy * 0.35; en.rollV *= 0.6; }
      en.roll += en.rollV * dt;
      en.s += en.v * dt;
      respawnT -= dt;
      if (respawnT <= 0 && phase === "play" && !cur.linda && rideAt(en.level).kind === "train" && FINALE_ON) startFinale();
      else if (respawnT <= 0 && phase === "play") {
        spawnFoe(en.level + 1, 220);
        emit(rideAt(en.level).kind === "train" ? "whistle" : "horn", en.s, en.lat, 1);
        if (cur.linda) {
          say(rideAt(en.level).kind === "train" ? "She's driving a train!" : `Linda's back. In ${rideAt(en.level).name.replace(/^the /, "a ")}.`, 2.8);
          shout(L_TAUNT_LIST[Math.floor(Math.random() * L_TAUNT_LIST.length)], 2.5);
        } else {
          say(COMMENTS[en.level] ?? `Level ${en.level}. He just keeps coming.`, 2.8);
          shout(TAUNT_LIST[Math.floor(Math.random() * TAUNT_LIST.length)], 2.5);
        }
      }
    } else {
      en.hitSlow = Math.max(0, en.hitSlow - dt * 5);
      en.rage = Math.max(0, en.rage - dt * 0.6);
      const close = Math.max(1.5, 4 + en.level * 1.3 + Math.min(4, tgt.s / 2000) - tgt.engine * 1.1);
      let want = tgt.v + (gap > 30 ? close + (gap - 30) * 0.25 : close * 0.6);
      if (phase === "intro") want = tgt.v + 10;
      if (phase === "over" || phase === "takeback") want = tgt.v - (cur.linda ? 8 : 5);
      en.lungeT -= dt;
      if (en.lungeT <= 0 && gap < 26 && phase === "play") { en.lunge = 1.3; en.lungeT = 7 - Math.min(4, en.level); emit("horn", en.s, en.lat, 1); }
      if (en.lunge > 0) { en.lunge -= dt; want += 11; }
      want -= en.hitSlow;
      en.v = lerp(en.v, Math.max(8, want), Math.min(1, dt * 1.8));
      en.s += en.v * dt;
      for (const r of riders) {
        if (r.gone) continue;
        if (r.s - en.s < 4 && Math.abs(r.lat - en.lat) < (foe.wid + 1.96) / 2) en.s = r.s - 4;
      }
      // steer for the target, round traffic, and (later in the night) out of the way of a ball
      let aimLat = tgt.lat;
      for (const t of traffic) {
        if (t.mode !== 0) continue;
        const ahead = t.s - en.s;
        if (ahead > 0 && ahead < 26 && Math.abs(t.lat - en.lat) < 2.6 && hash(Math.floor(t.s / 50) + en.level) < 0.85 - en.level * 0.1) aimLat = t.lat > 0 ? -LANE : LANE;
      }
      if (en.level >= 2) for (const b of balls) {
        if (!b.live || b.vy < -2) continue;
        if (Math.abs(b.lat - en.lat) < 2 && b.s - en.s < 30 && b.s - en.s > 0 && Math.random() < dt * en.level * 0.5) en.dodge = (b.lat > en.lat ? -1 : 1) * 3.5;
      }
      en.dodge *= Math.pow(0.4, dt);
      aimLat = clamp(aimLat + en.dodge + Math.sin(time * 0.9) * 1.2, -LAT_MAX, LAT_MAX);
      // steering is a velocity that eases, not a position that snaps: that is what makes him look heavy
      const wantVl = clamp(aimLat - en.lat, -1.4, 1.4) * (3.2 + en.level * 0.5);
      en.vl = lerp(en.vl, wantVl, Math.min(1, dt * 3.2));
      en.lat = clamp(en.lat + en.vl * dt, -LAT_MAX, LAT_MAX);
      for (const o of chasers) {
        if (o === cur || o.en.wreck > 0) continue;
        if (Math.abs(o.en.s - en.s) < (foe.len + o.foe.len) / 2 + 0.5 && Math.abs(o.en.lat - en.lat) < (foe.wid + o.foe.wid) / 2 + 0.2) {
          const side = Math.sign(en.lat - o.en.lat) || (cur.linda ? 1 : -1);
          en.lat = clamp(en.lat + side * dt * 6, -LAT_MAX, LAT_MAX);
          en.vl = side * Math.max(Math.abs(en.vl), 2);
          if (en.s < o.en.s) en.hitSlow = Math.max(en.hitSlow, 3);
        }
      }
      // the ram
      const reach = foe.len / 2 + 2.6;
      en.ramCd = Math.max(0, en.ramCd - dt);
      for (const r of riders) {
        if (!alive(r) || en.ramCd > 0 || phase !== "play") continue;
        if (r.s - en.s < reach + 0.4 && Math.abs(en.lat - r.lat) < (foe.wid + 1.96) / 2) {
          en.ramCd = 1.6;
          en.s -= 3;
          en.hitSlow = 18;
          en.lunge = 0;
          r.bump = 3;
          emit("ram", r.s - 2.6, r.lat, 0.8, r.idx);
          hurt(r, Math.round((14 + en.level * 4) * (two ? 1.2 : 1)), cur.linda ? "LINDA RAMMED YOU!" : "RAMMED!");
          shout("BOOP!", 1);
        }
      }
      // straight through traffic: cars go flying
      for (const t of traffic) {
        if (t.hitCd > 0 || !t.live) continue;
        if (Math.abs(t.s - en.s) < (foe.len + 4.3) / 2 && Math.abs(t.lat - en.lat) < (foe.wid + 1.85) / 2 && t.y < 2.2) {
          const fresh = t.mode === 0;
          launch(t, en.lat, en.level + 2, !fresh || Math.random() < 0.55);
          emit("crunch", en.s + foe.len / 2, (en.lat + t.lat) / 2, 1);
          if (fresh) {
            score += 150;
            cash += 15;
            hitFoe({ s: en.s + foe.len / 2, lat: en.lat, y: 1 }, "HE HIT TRAFFIC!");
          } else en.hitSlow = Math.max(en.hitSlow, 6);
        }
      }
      // throwing things (from the second truck on)
      if (en.level >= 2 && phase === "play" && gap < 60 && gap > 10) {
        en.throwT -= dt;
        if (en.throwT <= 0) {
          en.throwT = (Math.max(1.6, 4.2 - en.level * 0.55) + Math.random() * 1.5) * (two ? 0.8 : 1);
          const it = thrown.find((x) => !x.live);
          // only ever at civilians in his way, to clear the road; never at you
          const civ = traffic.filter((t) => t.mode === 0 && t.swerve <= 0 && t.s - en.s > 6 && t.s - en.s < 55).sort((a, b) => a.s - b.s)[0];
          if (it && civ) {
            const d = civ.s - en.s;
            const T = 0.7 + d / 45;
            const s0 = en.s + foe.len / 2 - 0.6;
            const y0 = foe.tall + 0.3;
            const ls = en.lat + foe.wid / 2;
            Object.assign(it, {
              s: s0, lat: ls, y: y0,
              vs: (civ.s + civ.v * T - s0) / T,
              vl: (civ.lat - ls) / T,
              vy: (1.1 - y0 + 0.5 * G * T * T) / T,
              age: 0, spin: 0, live: true, targetLat: civ.lat, passed: false, rider: -1, car: civ,
            });
            shout(["GET OUT!", "GET OUT OF THE WAY!", "SWERVE TO THE RIGHT OR LEFT, BUDDY!"][Math.floor(Math.random() * 3)], 1.6);
            emit("whoosh", s0, en.lat, y0);
          } else if (it && THROW_AT_PLAYER) {
            const T = 1.25 + gap / 90;
            const s0 = en.s + foe.len / 2 - 0.6;
            const y0 = foe.tall + 0.3;
            // the throws that are not at civilians never hit you: he lobs them into the road beside you
            const tl = clamp(tgt.lat + (tgt.lat > 0 ? -2.9 : 2.9), -LAT_MAX, LAT_MAX);
            Object.assign(it, {
              s: s0, lat: en.lat + foe.wid / 2, y: y0,
              vs: (tgt.s + tgt.v * T - 1.2 - s0) / T,
              vl: (tl - (en.lat + foe.wid / 2)) / T,
              vy: (1.2 - y0 + 0.5 * G * T * T) / T,
              age: 0, spin: 0, live: true, targetLat: tl, passed: false, rider: tgt.idx, car: null,
            });
            shout(it.kind === 0 ? "CATCH!" : "HAVE A CAN!", 1.2);
            emit("whoosh", s0, en.lat, y0);
          }
        }
      }
      tauntT -= dt;
      if (tauntT <= 0 && talkT <= 0) { const tl = cur.linda ? L_TAUNT_LIST : TAUNT_LIST; tauntT = 4 + Math.random() * 4; shout(tl[Math.floor(Math.random() * tl.length)]); }
    }
    };
    for (const c of chasers) { use(c); stepChaser(); }
    use(mort);

    // --- cannons
    for (const r of riders) {
      if (local.includes(r)) updateAim(r);
      if (r.wantFire) { r.wantFire = false; if (canFire(r)) fireBall(r); }
    }
    for (const b of balls) {
      if (!b.live) continue;
      b.age += dt;
      b.vy -= G * dt;
      b.s += b.vs * dt;
      b.lat += b.vl * dt;
      b.y += b.vy * dt;
      if (b.y < 0.19) {
        b.y = 0.19;
        b.vy = Math.abs(b.vy) * 0.42;
        b.vs = lerp(b.vs, 0, 0.2);
        b.vl *= 0.6;
        b.bounces += 1;
        emit("dust", b.s, b.lat, 0.3);
      }
      for (const c of chasers) {
        use(c);
        if (en.wreck === 0 && phase !== "takeback" && Math.abs(b.s - en.s) < foe.len / 2 + 0.35 && Math.abs(b.lat - en.lat) < foe.wid / 2 + 0.3 && b.y < foe.tall + 0.3) {
          b.live = false;
          hitFoe(b, (c.linda ? "LINDA: " : "") + (b.dmg < 1 ? "AUTO CANNON!" : b.bounces > 0 ? "BOUNCE SHOT!" : b.y > foe.tall * 0.6 ? "RIGHT IN THE CAB!" : "DIRECT HIT!"), b.dmg);
          break;
        }
      }
      use(mort);
      if (!b.live) continue;
      for (const h of henchmen) {
        if (b.live && (h.state === 1 || h.state === 0) && Math.abs(b.s - h.s) < 1.1 && Math.abs(b.lat - h.lat) < 0.9 && b.y < 2.2) {
          b.live = false;
          knockHench(h, "HENCHMAN DOWN!", 1);
        }
      }
      for (const it of thrown) {
        if (it.live && Math.hypot(it.s - b.s, it.lat - b.lat, it.y - b.y) < 1.1) {
          it.live = false;
          b.live = false;
          score += 75;
          cash += 10;
          say("SHOT IT OUT OF THE AIR! +$10", 1.4);
          emit("tink", it.s, it.lat, it.y);
        }
      }
      for (const t of traffic) {
        if (b.live && t.mode === 0 && Math.abs(b.s - t.s) < 2.3 && Math.abs(b.lat - t.lat) < 1.1 && b.y < 1.6) {
          b.live = false;
          launch(t, b.lat - Math.sign(b.vl || 1), 2, true);
          score -= 25;
          say("Hey, that was a civilian. -25", 1.4);
          emit("hit", t.s, t.lat, 1);
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
      if (it.car) {
        const c = it.car;
        if (!it.passed && it.s >= c.s - 1.6) {
          it.passed = true;
          if (c.live && c.mode === 0 && Math.abs(it.lat - c.lat) < 1.6 && it.y < 2.4) {
            it.live = false;
            emit("thunk", c.s, c.lat, 1.3);
            // 57 in 100 swerve the wrong way, into him; 42 get out of his way; 1 just wobbles
            const roll = Math.random();
            const toward = Math.sign(en.lat - c.lat) || 1;
            c.swerve = 2.4;
            c.side = roll < 0.57 ? toward : roll < 0.99 ? -toward : 0;
            say(roll < 0.57 ? "He hit a car and it swerved right into him!" : "That car's getting out of his way.", 1.5);
          }
        }
        if (it.y < 0.3 && it.vy < 0) { it.vy = Math.abs(it.vy) * 0.35; it.vs *= 0.7; }
        if (it.age > 3.2) it.live = false;
        continue;
      }
      const r = riders[it.rider];
      if (!it.passed && it.s >= r.s - 2.4) {
        it.passed = true;
        if (phase === "play") score += 20;
      }
      if (it.y < 0.3 && it.vy < 0) { it.vy = Math.abs(it.vy) * 0.35; it.vs *= 0.7; }
      if (it.age > 3.2) it.live = false;
    }
    stepHenchmen(dt);
    autoGuns(dt);
    if (alertT > 0) { alertT -= dt; if (alertT <= 0) alert = ""; }
    stepPuffs(dt);
    ambient(dt);
    sendNet(dt);
  };

  /** Cars: driving, tipping, flying, landing, and going up when they land hard. */
  const stepTraffic = (dt: number, authority: boolean): void => {
    const back = Math.min(...riders.filter((r) => !r.gone).map((r) => r.s), ...chasers.map((c) => c.en.s));
    for (const t of traffic) {
      if (!t.live) continue;
      t.hitCd = Math.max(0, t.hitCd - dt);
      t.s += t.v * dt;
      t.lat += t.vl * dt;
      if (t.mode === 0) {
        t.y = 0.75;
        if (t.swerve > 0) {
          t.swerve -= dt;
          const want = t.side * 5.5;
          t.vl = lerp(t.vl, want, Math.min(1, dt * 3));
          t.ry = Math.sin(t.swerve * 9) * 0.2 * Math.min(1, t.swerve) - t.vl * 0.03;
          if (t.swerve <= 0) { t.vl = 0; t.ry = 0; }
          t.lat = clamp(t.lat, -HALF - 1.5, HALF + 1.5);
        }
      } else if (t.mode === 1) {
        // over onto its side, sliding
        t.rz += t.side * dt * 3.6;
        if (Math.abs(t.rz) >= Math.PI / 2) { t.rz = t.side * Math.PI / 2; t.mode = 4; if (authority) emit("crunch", t.s, t.lat, 0.6); }
        t.y = lerp(0.75, 0.93, Math.min(1, Math.abs(t.rz) / (Math.PI / 2)));
        t.v = Math.max(0, t.v - dt * 12);
        t.vl *= Math.pow(0.2, dt);
      } else if (t.mode === 2) {
        t.air += dt;
        t.vy -= G * dt;
        t.y += t.vy * dt;
        t.rx += t.wx * dt;
        t.ry += t.wy * dt;
        t.rz += t.wz * dt;
        t.v = Math.max(0, t.v - dt * 3);
        if (t.y <= 0.8 && t.vy < 0) {
          if (t.air > 0.45) {
            // it lands on whatever side it lands on, and goes up
            t.rx = Math.round(t.rx / Math.PI) * Math.PI;
            t.rz = Math.round(t.rz / (Math.PI / 2)) * (Math.PI / 2);
            const onSide = Math.abs(Math.round(t.rz / (Math.PI / 2))) % 2 === 1;
            t.y = onSide ? 0.93 : 0.75;
            t.vy = 0;
            t.mode = 3;
            t.v *= 0.35;
            t.vl *= 0.3;
            t.color.lerp(BURNT, 0.85);
            if (authority) emit("boom", t.s, t.lat, 1);
          } else {
            t.y = 0.8;
            t.vy = Math.abs(t.vy) * 0.35;
            t.air = 0;
          }
        }
      } else {
        // 3 burnt out, 4 on its side: grinding to a stop
        t.v = Math.max(0, t.v - dt * 16);
        t.vl *= Math.pow(0.05, dt);
      }
      if (t.s < back - 260) t.live = false;
    }
    for (let i = traffic.length - 1; i >= 0; i--) if (!traffic[i].live) traffic.splice(i, 1);
  };

  const stepPuffs = (dt: number): void => {
    for (const p of puffs) {
      if (!p.live) continue;
      p.age += dt;
      if (p.age >= p.life) { p.live = false; p.sprite.visible = false; continue; }
      p.s += p.vs * dt;
      p.lat += p.vl * dt;
      p.y += p.vy * dt;
      if (p.kind === "spark") p.vy -= G * dt;
      p.vs = lerp(p.vs, 0, Math.min(1, dt * (p.kind === "smoke" || p.kind === "black" ? 1.2 : 0.4)));
    }
  };

  /** Smoke that comes from state rather than events, so both browsers make their own. */
  const ambient = (dt: number): void => {
    const chance = (rate: number): boolean => Math.random() < dt * rate;
    for (const r of riders) {
      if (r.gone) continue;
      // exhaust
      if (r.v > 1 && chance(10)) puff("smoke", r.s - 2.85, r.lat - 0.6, 0.34, r.v * 0.75, (Math.random() - 0.5) * 0.6, 0.5, 0.28, 0.7);
      // nitro: blue flame out of the pipe
      if (r.v > 38 && chance(26)) puff("fire", r.s - 2.95, r.lat - 0.6, 0.34, r.v - 6, (Math.random() - 0.5), 0.3, 0.42, 0.14);
      // damage: grey under 60%, black under 30%, fire when out
      const f = r.hull / r.max;
      if ((f < 0.6 || r.out) && chance(f < 0.3 || r.out ? 16 : 7)) puff(f < 0.3 || r.out ? "black" : "smoke", r.s + 0.4, r.lat + (Math.random() - 0.5) * 0.8, 1.75, r.v - 7, (Math.random() - 0.5) * 0.8, 1.6, 0.8, 1.5);
      if (r.out && chance(14)) puff("fire", r.s + 0.2, r.lat + (Math.random() - 0.5) * 0.9, 1.2, r.v - 1, 0, 1.6, 0.9, 0.35);
      // dust off the rear wheels on the shoulder
      if (Math.abs(r.lat) > HALF - 2.2 && r.v > 5 && chance(24)) puff("dust", r.s - 3, r.lat + Math.sign(r.lat) * 0.8, 0.3, r.v * 0.7, 0, 0.6, 0.6, 0.8);
    }
    for (const c of chasers) {
    use(c);
    if (en.wreck === 0) {
      if (en.v > 1 && chance(9)) puff("smoke", en.s - foe.len / 2, en.lat + foe.wid * 0.3, 0.4, en.v * 0.75, 0, 0.5, 0.4, 0.8);
      if (foe.stack) {
        // the stack never stops: thick black puffs, faster the faster he goes
        if (chance(3)) puff(Math.random() < 0.6 ? "smoke" : "black", en.s + foe.stack.z, en.lat - foe.stack.x + (Math.random() - 0.5) * 0.3, foe.stack.y, en.v - 3, (Math.random() - 0.5) * 0.6, 3 + Math.random() * 2, 1.3, 2.2);
        if (chance(10)) puff("smoke", en.s + foe.len / 2 - 1.5, en.lat + (Math.random() > 0.5 ? 1 : -1) * (foe.wid / 2 + 0.3), 0.5, en.v * 0.6, (Math.random() - 0.5) * 2, 0.6, 0.9, 0.9);
      } else if (en.level >= 4 && chance(8)) puff("black", en.s + foe.len / 2 - 2.6, en.lat + (Math.random() > 0.5 ? 1 : -1) * foe.wid / 2, foe.tall + 1.5, en.v - 1, 0, 2.2, 0.7, 1.2);
      const f = en.hp / en.max;
      if (f <= 0.5 && chance(4 + (1 - f) * 10)) puff(f <= 0.25 ? "black" : "smoke", en.s + foe.len / 2 - 0.8, en.lat, foe.tall * 0.6, en.v - 2, 0, 1.5, 1.2, 1.6);
      if (f <= 0.25 && chance(7)) puff("fire", en.s + foe.len / 2 - 0.7, en.lat + (Math.random() - 0.5), foe.tall * 0.55, en.v - 1, 0, 1.4, 0.7, 0.3);
    } else {
      if (chance(14)) puff("fire", en.s, en.lat, 0.8 + Math.random(), en.v, (Math.random() - 0.5), 2 + Math.random() * 2, 1.4, 0.5);
      if (chance(10)) puff("black", en.s, en.lat, 1.6, en.v, 0, 3, 2.2, 2.4);
    }
    }
    use(mort);
    for (const t of traffic) {
      if (t.mode === 3) {
        if (chance(12)) puff("fire", t.s, t.lat + (Math.random() - 0.5) * 1.2, 0.9 + Math.random() * 0.6, t.v, 0, 1.8, 1.1, 0.4);
        if (chance(8)) puff("black", t.s, t.lat, 1.6, t.v, 0, 2.4, 1.6, 2.4);
      } else if (t.mode === 4 || t.mode === 1) {
        if (chance(5)) puff("smoke", t.s + 1.8, t.lat, 0.9, t.v, 0, 1.2, 0.9, 1.5);
        if (t.v > 4 && chance(30)) puff("spark", t.s, t.lat + t.side * 0.9, 0.2, t.v, (Math.random() - 0.5) * 3, Math.random() * 3, 0.3, 0.3);
      } else if (t.mode === 2 && chance(10)) puff("smoke", t.s, t.lat, t.y, t.v, 0, 0, 0.8, 0.9);
    }
  };

  /* ------------------------------------------------------------ the wire */
  let netT = 0;
  let lastHeard = 0;
  let lastSnap: Snap | null = null;
  let snapAt = 0;
  const r2 = (n: number): number => Math.round(n * 100) / 100;
  const encE = (c: Chaser): number[] => {
    const e = c.en;
    return [r2(e.s), r2(e.lat), r2(e.y), r2(e.roll), e.level, e.hp, e.max, r2(e.wreck), r2(e.rage), r2(e.lunge), r2(e.v), r2(e.vl), e.seated ? 1 : 0, r2(e.rollV), r2(e.vy)];
  };
  const sendNet = (dt: number): void => {
    if (!net) return;
    netT -= dt;
    if (netT > 0) return;
    netT = 1 / NET_HZ;
    if (mode === "host") {
      const walking = phase === "takeback" && tb.phase >= 1 && tb.phase <= 3;
      use(mort);
      sync();
      const snap: Snap = {
        t: "st", k: r2(time), g: gen, ph: phase,
        r: riders.map((r) => [r2(r.s), r2(r.lat), r2(r.v), r2(r.vl), Math.round(r.hull), r.max, r2(r.boost), r2(r.reload), r2(r.aim.yaw), r2(r.aim.pitch), r.out ? 1 : 0, r2(r.respawn), r.disarmed ? 1 : 0, r.gone ? 1 : 0, r2(r.autoYaw)]),
        e: encE(mort),
        e2: linda ? encE(linda) : null,
        tk2: linda?.talk ?? "",
        b: balls.filter((b) => b.live).map((b) => [r2(b.s), r2(b.lat), r2(b.y), r2(b.vs), r2(b.vl), r2(b.vy), b.dmg < 1 ? 1 : 0]),
        th: thrown.filter((x) => x.live).map((x) => [r2(x.s), r2(x.lat), r2(x.y), r2(x.vs), r2(x.vl), r2(x.vy), x.kind, r2(x.targetLat), x.passed ? 1 : 0, x.rider]),
        tr: traffic.map((t) => [r2(t.s), r2(t.lat), r2(t.y), r2(t.v), r2(t.vl), r2(t.vy), r2(t.rx), r2(t.ry), r2(t.rz), r2(t.wx), r2(t.wy), r2(t.wz), t.color.getHex(), t.mode]),
        w: walking ? [r2(tb.s), r2(tb.lat), r2(tb.y), r2(tb.yaw), tb.phase, tb.carrying ? 1 : 0, tb.rider] : null,
        sc: Math.round(score), cash: Math.round(cash), hits, wrecks, talk, toast,
        hm: henchmen.map((h) => (h.state < 0 ? [0, 0, 0, -1, 0, 0, 0, 0] : [r2(h.s), r2(h.lat), r2(h.y), h.state, r2(h.v), r2(h.rx), r2(h.walk), r2(h.yaw)])),
        al: alert,
        ev: outbox.splice(0),
        fn: fin ? fin.encode() : undefined,
        won: won ? 1 : 0,
      };
      net.send(snap);
    } else if (fin && phase === "finale") {
      // on foot: where my hero stands, and how many pies it has thrown
      const h = fin.encode().n;
      const at = 3 + mine * 7;
      net.send({ t: "in", g: gen, s: h[at], lat: h[at + 1], v: 0, vl: 0, boost: 0, yaw: h[at + 2], pitch: 0, fire: fin.throws, fin: 1 });
    } else {
      net.send({ t: "in", g: gen, s: r2(me.s), lat: r2(me.lat), v: r2(me.v), vl: r2(me.vl), boost: r2(me.boost), yaw: r2(me.aim.yaw), pitch: r2(me.aim.pitch), fire: me.fired });
    }
  };

  const onWire = (msg: Wire): void => {
    lastHeard = time;
    if (msg.t === "bye") {
      if (mode === "host" && !riders[1].gone) { riders[1].gone = true; riders[1].out = true; say("Your friend left.", 3); }
      if (mode === "guest") lastHeard = -1e9;
      return;
    }
    if (mode === "host" && msg.t === "in") {
      const m = msg as Input;
      if (m.g !== gen) return;
      if (m.fin) { if (fin && phase === "finale") fin.remote(1, m.s, m.lat, m.yaw, m.fire); riders[1].net = riders[1].net ? { ...riders[1].net, at: time } : riders[1].net; return; }
      const r = riders[1];
      const prev = r.net?.fire ?? m.fire;
      r.net = { s: m.s, lat: m.lat, v: m.v, vl: m.vl, at: time, fire: m.fire };
      if (!r.net || Math.abs(r.s - m.s) > 40) { r.s = m.s; r.lat = m.lat; }
      r.boost = m.boost;
      r.aim.yaw = m.yaw;
      r.aim.pitch = m.pitch;
      if (m.fire > prev && canFire(r)) fireBall(r);
      if (r.gone && phase !== "over") { r.gone = false; r.out = false; r.hull = Math.max(r.hull, Math.round(r.max * 0.5)); say("Your friend is back!", 2); }
    }
    if (mode === "guest" && msg.t === "st") applySnap(msg as Snap);
  };
  net?.receive(onWire);

  const applySnap = (sn: Snap): void => {
    if (sn.g !== gen) {
      // the host restarted
      gen = sn.g;
      resetRider(me);
      me.fired = 0;
      ended = false;
      kmPaid = 0;
      puffs.forEach((p) => { p.live = false; p.sprite.visible = false; });
    }
    lastSnap = sn;
    snapAt = time;
    const prevPhase = phase;
    phase = sn.ph as Phase;
    if (sn.fn) { ensureFinale().apply(sn.fn, mine); won = sn.won === 1; }
    if (phase === "over" && prevPhase !== "over") finish();
    score = sn.sc;
    cash = sn.cash;
    hits = sn.hits;
    wrecks = sn.wrecks;
    use(mort);
    talk = sn.talk;
    if (sn.toast !== toast && sn.toast) say(sn.toast, 1.8);
    for (let i = 0; i < riders.length; i++) {
      const r = riders[i];
      const a = sn.r[i];
      if (!a) continue;
      r.hull = a[4];
      r.max = a[5];
      r.out = a[10] === 1;
      r.respawn = a[11];
      r.disarmed = a[12] === 1;
      r.gone = a[13] === 1;
      if (r === me) continue;
      r.net = { s: a[0], lat: a[1], v: a[2], vl: a[3], at: time, fire: 0 };
      if (Math.abs(r.s - a[0]) > 40) { r.s = a[0]; r.lat = a[1]; }
      r.boost = a[6];
      r.reload = a[7];
      r.aim.yaw = a[8];
      r.aim.pitch = a[9];
      r.autoYaw = a[14] ?? 0;
    }
    const applyE = (e: number[]): void => {
      if (e[4] !== en.level) {
        scene.remove(foe.root);
        disposeTree(foe.root);
        foe = buildFoe(e[4], cur.linda);
        scene.add(foe.root);
        en.s = e[0];
        en.lat = e[1];
      }
      Object.assign(en, { y: e[2], roll: e[3], level: e[4], hp: e[5], max: e[6], wreck: e[7], rage: e[8], lunge: e[9], v: e[10], vl: e[11], seated: e[12] === 1, rollV: e[13], vy: e[14] });
      cur.net.s = e[0];
      cur.net.lat = e[1];
    };
    applyE(sn.e);
    if (linda && sn.e2) { use(linda); talk = sn.tk2 ?? ""; applyE(sn.e2); }
    use(mort);
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      const a = sn.b[i];
      b.live = !!a;
      if (a) Object.assign(b, { s: a[0], lat: a[1], y: a[2], vs: a[3], vl: a[4], vy: a[5], dmg: a[6] ? 0.5 : 1 });
    }
    for (let i = 0; i < thrown.length; i++) {
      const it = thrown[i];
      const a = sn.th.find((x) => x[6] === it.kind && !used.has(x));
      it.live = !!a;
      if (a) { used.add(a); Object.assign(it, { s: a[0], lat: a[1], y: a[2], vs: a[3], vl: a[4], vy: a[5], targetLat: a[7], passed: a[8] === 1, rider: a[9], car: null }); }
    }
    used.clear();
    traffic.length = 0;
    for (const a of sn.tr) {
      traffic.push({ s: a[0], lat: a[1], y: a[2], v: a[3], vl: a[4], vy: a[5], rx: a[6], ry: a[7], rz: a[8], wx: a[9], wy: a[10], wz: a[11], color: new THREE.Color(a[12]), mode: a[13], air: 0, side: Math.sign(a[8]) || 1, hitCd: 1, live: true, swerve: 0 });
    }
    for (let i = 0; i < henchmen.length; i++) {
      const h = henchmen[i];
      const a = sn.hm?.[i];
      if (!a || a[3] < 0) { h.state = -1; continue; }
      if (h.state < 0 || Math.abs(h.s - a[0]) > 6) { h.s = a[0]; h.lat = a[1]; }
      Object.assign(h, { y: a[2], state: a[3], v: a[4], rx: a[5], walk: a[6], yaw: a[7], vl: 0 });
      h.vy = a[0];
      h.whack = a[1];
    }
    if (sn.al !== alert) { alert = sn.al ?? ""; }
    if (sn.w) Object.assign(tb, { s: sn.w[0], lat: sn.w[1], y: sn.w[2], yaw: sn.w[3], phase: sn.w[4], carrying: sn.w[5] === 1, rider: sn.w[6] });
    else if (phase === "takeback") tb.phase = en.seated ? 4 : 0;
    for (const ev of sn.ev) {
      const [kind, s, lat, y, ri] = ev as [string, number, number, number, number];
      if (kind === "fire" && ri === mine) continue; // already seen, the moment we pulled the lanyard
      play(kind, s, lat, y, ri);
    }
  };
  const used = new Set<number[]>();

  /** The guest's world step: drive my own truck, ease everything else toward the host. */
  const guestStep = (dt: number): void => {
    time += dt;
    if (fin) {
      if (toastT > 0) { toastT -= dt; if (toastT <= 0) toast = ""; }
      const inp = finInputs()[mine];
      fin.step(dt, [inp], "view", mine);
      sendNet(dt);
      return;
    }
    if (toastT > 0) { toastT -= dt; if (toastT <= 0) toast = ""; }
    flash.intensity *= Math.pow(0.0005, dt);
    boomLight.intensity *= Math.pow(0.02, dt);
    driveRider(me, dt);
    stepRiderStatus(me, dt);
    updateAim(me);
    for (const r of riders) r.autoPitch = 0.05;
    if (me.wantFire) {
      me.wantFire = false;
      if (canFire(me) && lastSnap) {
        me.fired += 1;
        me.reload = RELOAD * me.reloadMul;
        const m = muzzle(me);
        play("fire", m.s, m.lat, m.y, mine);
      }
    }
    const age = Math.min(0.4, time - snapAt);
    const k = Math.min(1, dt * 9);
    for (const r of riders) {
      if (r === me || !r.net) continue;
      r.s += r.net.v * dt;
      r.lat += r.net.vl * dt;
      r.v = r.net.v;
      r.vl = r.net.vl;
      r.s += (r.net.s + r.net.v * age - r.s) * k;
      r.lat += (r.net.lat + r.net.vl * age - r.lat) * k;
      r.recoil = Math.max(0, r.recoil - dt * 3.2);
    }
    for (const c of chasers) {
      const e = c.en;
      e.s += e.v * dt;
      e.lat += e.vl * dt;
      e.s += (c.net.s + e.v * age - e.s) * k;
      e.lat += (c.net.lat + e.vl * age - e.lat) * k;
      if (e.wreck > 0) { e.roll += e.rollV * dt; e.vy -= G * dt; e.y = Math.max(0, e.y + e.vy * dt); }
    }
    for (const b of balls) {
      if (!b.live) continue;
      b.vy -= G * dt;
      b.s += b.vs * dt;
      b.lat += b.vl * dt;
      b.y = Math.max(0.19, b.y + b.vy * dt);
    }
    for (const it of thrown) {
      if (!it.live) continue;
      it.vy -= G * dt;
      it.s += it.vs * dt;
      it.lat += it.vl * dt;
      it.y = Math.max(0.3, it.y + it.vy * dt);
      it.spin += dt * 9;
    }
    for (const h of henchmen) {
      if (h.state < 0) continue;
      h.s += h.v * dt;
      h.s += (h.vy + h.v * age - h.s) * k;
      h.lat += (h.whack - h.lat) * k;
    }
    stepTraffic(dt, false);
    stepPuffs(dt);
    ambient(dt);
    sendNet(dt);
  };

  /* ------------------------------------------------------------ draw */
  const M = new THREE.Matrix4();
  const Q = new THREE.Quaternion();
  const E = new THREE.Euler();
  const S3 = new THREE.Vector3();
  const P = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const camPos = new THREE.Vector3();
  const camLook = new THREE.Vector3();
  const wantPos = new THREE.Vector3();
  const wantLook = new THREE.Vector3();
  let camReady = false;
  const tmp = new THREE.Vector3();

  const place = (obj: THREE.Object3D, s: number, lat: number, y: number, yawOff = 0): void => {
    toWorld(s, lat, y, obj.position);
    obj.rotation.set(0, heading(s) + yawOff, 0);
  };

  const project = (el: HTMLElement, s: number, lat: number, y: number, show: boolean, pad = 40): void => {
    if (!show) { el.style.opacity = "0"; return; }
    toWorld(s, lat, y, tmp);
    tmp.project(camera);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (tmp.z >= 1 || Math.abs(tmp.x) > 1.2) { el.style.opacity = "0"; return; }
    el.style.left = `${clamp((tmp.x * 0.5 + 0.5) * w, pad, w - pad)}px`;
    el.style.top = `${clamp((-tmp.y * 0.5 + 0.5) * h, 50, h - 30)}px`;
    el.style.opacity = "1";
  };

  const draw = (dt: number): void => {
    if (fin) return;
    const ease = (rate: number): number => 1 - Math.exp(-dt * rate);
    // trucks
    for (const r of riders) {
      r.truck.root.visible = !r.gone;
      if (r.gone) continue;
      // lean into the swerve, roll with the road, and bob on the springs
      const wantYaw = -Math.atan2(r.vl, Math.max(r.v, 6)) * 0.9;
      r.yawSm = lerp(r.yawSm, wantYaw, ease(7));
      r.rollSm = lerp(r.rollSm, clamp(r.vl * 0.016, -0.09, 0.09), ease(5));
      const bob = r.v > 1 ? Math.sin(r.s * 0.9) * 0.012 + Math.sin(r.s * 2.3 + r.idx) * 0.006 : 0;
      place(r.truck.root, r.s, r.lat, bob + r.shake * r.shake * 0.04 * Math.sin(time * 41), r.yawSm);
      r.truck.root.rotation.z = r.rollSm;
      r.truck.root.rotation.x = Math.sin(r.s * 0.7 + 1) * 0.004 - (r.bump > 0 ? 0.02 : 0);
      for (const w of r.truck.wheels) w.rotation.x -= r.v * 0.016 * (dt * 60);
      r.truck.cannon.yaw.rotation.y = r.aim.yaw;
      r.truck.cannon.pitch.rotation.x = r.aim.pitch;
      r.truck.cannon.barrel.position.z = r.recoil * r.recoil * 0.35;
      r.truck.cannon.root.visible = !r.disarmed;
      r.truck.kit.visible = !r.disarmed;
      r.autoGun.root.visible = r.auto > 0 && !r.disarmed;
      r.autoGun.yaw.rotation.y = r.autoYaw;
      r.autoGun.barrel.rotation.x = r.autoPitch;
      r.truck.paint.emissive.setRGB(r.out ? 0.25 : 0, r.out ? 0.05 : 0, 0);
    }
    const f = me.gone ? riders.find((r) => !r.gone) ?? me : me;
    toWorld(f.s - 3.4, f.lat, 0.9, tailLight.position);
    toWorld(f.s + 0.2, f.lat, 2.6, work.position);

    // the camera
    let camS: number;
    let fov = baseFov;
    if (phase === "takeback" || (phase === "over" && camReady)) {
      const r = riders[tb.rider];
      const side = r.lat > 0 ? -1 : 1;
      if (phase === "takeback") {
        toWorld(r.s - 2.6, r.lat + side * 8.5, 3.4, wantPos);
        const ls = tb.phase === 4 ? clamp(en.s, r.s - 6, r.s + 18) : tb.phase >= 1 ? lerp(r.s - 5, tb.s, 0.35) : r.s - 6;
        toWorld(ls, lerp(r.lat, en.lat, 0.3), 1.1, wantLook);
      } else {
        wantPos.copy(camPos);
        wantLook.copy(camLook);
      }
      camS = r.s;
      fov = baseFov - 4;
    } else if (mode === "duo") {
      const a = riders[0].gone ? riders[1] : riders[0];
      const b = riders[1].gone ? riders[0] : riders[1];
      const ms = Math.max(a.s, b.s);
      const ml = (a.lat + b.lat) / 2;
      toWorld(ms + 4.2, ml * 0.6, 6.0, wantPos);
      toWorld(ms - 28, ml * 0.45, -3.4, wantLook);
      camS = ms;
    } else {
      toWorld(f.s + 1.6, f.lat * 0.9, 3.5, wantPos);
      toWorld(f.s - 28, f.lat * 0.55, -2.6, wantLook);
      camS = f.s;
    }
    if (!camReady || dt >= 0.5) { camPos.copy(wantPos); camLook.copy(wantLook); camReady = true; }
    else {
      const k = phase === "takeback" ? ease(2.2) : ease(14);
      camPos.lerp(wantPos, k);
      camLook.lerp(wantLook, k);
    }
    const shakeAmp = Math.max(...local.map((r) => r.shake)) ** 2 * 0.22;
    camera.position.copy(camPos);
    camera.position.x += Math.sin(time * 47) * shakeAmp;
    camera.position.y += Math.sin(time * 61 + 1) * shakeAmp * 0.8;
    camera.up.copy(UP);
    camera.lookAt(camLook);
    if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = lerp(camera.fov, fov, ease(3)); camera.updateProjectionMatrix(); }
    sky.position.copy(camera.position);
    stars.position.copy(camera.position);
    if (aurora) { auroraGroup.position.copy(camera.position); auroraMat.uniforms.uTime.value = time; }
    const h = heading(camS);
    tmp.set(-Math.sin(h) * 700 - 180 * Math.cos(h), 240, -Math.cos(h) * 700 + 180 * Math.sin(h));
    moon.position.copy(camera.position).add(tmp);
    moonDisc.position.copy(moon.position);
    moonDisc.lookAt(camera.position);
    moonLight.position.copy(moon.position);
    moonLight.target.position.copy(camera.position);
    ground.position.set(camera.position.x, -0.03, camera.position.z);
    sand.offset.set(camera.position.x / 20, -camera.position.z / 20);

    const s0 = camS - SEG * STEP + 30;
    layRibbon(road, s0);
    layRibbon(shoulder, s0);

    // lamps, alternating sides
    const k0 = Math.floor((camS - LAMPS * LAMP_GAP + 40) / LAMP_GAP);
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
    near.sort((a, b) => Math.abs(a.s - (camS - 25)) - Math.abs(b.s - (camS - 25)));
    for (let i = 0; i < lampLights.length; i++) toWorld(near[i].s, near[i].lat, 7.2, lampLights[i].position);

    // desert furniture
    const c0 = Math.floor((camS - CACTI * CACTUS_GAP + 30) / CACTUS_GAP);
    for (let i = 0; i < CACTI; i++) {
      const k = c0 + i;
      const side = hash(k) > 0.5 ? 1 : -1;
      toWorld(k * CACTUS_GAP + hash(k + 7) * 8, side * (HALF + 6 + hash(k + 0.31) * 55), 0, P);
      const sc = 0.7 + hash(k + 2.2) * 0.9;
      Q.setFromEuler(E.set(0, hash(k + 9) * 6.28, 0));
      M.compose(P, Q, S3.set(sc, sc, sc));
      cacti.setMatrixAt(i, M);
    }
    cacti.instanceMatrix.needsUpdate = true;
    const r0 = Math.floor((camS - ROCKS * 20 + 30) / 20);
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
    const m0 = Math.floor((camS - MESAS * 90) / 90);
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
      const k = Math.floor(camS / 700) - i;
      const side = k % 2 === 0 ? -1 : 1;
      place(signs[i], k * 700 + 300, side * (HALF + 7), 0, side * 0.45);
    }

    // traffic
    for (let i = 0; i < MAX_TRAFFIC; i++) {
      const t = traffic[i];
      if (!t) { M.makeScale(0, 0, 0); trafficMesh.setMatrixAt(i, M); continue; }
      toWorld(t.s, t.lat, t.y, P);
      const lean = t.mode === 0 ? Math.sin(time * 1.7 + i) * 0.01 : 0;
      Q.setFromEuler(E.set(t.rx, heading(t.s) + t.ry, t.rz + lean));
      M.compose(P, Q, S3.set(1, 1, 1));
      trafficMesh.setMatrixAt(i, M);
      trafficMesh.setColorAt(i, t.color);
    }
    trafficMesh.instanceMatrix.needsUpdate = true;
    if (trafficMesh.instanceColor) trafficMesh.instanceColor.needsUpdate = true;

    // Mort, and what he drives (and Linda, and hers)
    const quiet = phase === "takeback" || phase === "over";
    const drawChaser = (): void => {
    const lean = en.wreck > 0 ? 0 : clamp(-en.vl * 0.012, -0.07, 0.07);
    const steerYaw = en.wreck > 0 ? 0 : -Math.atan2(en.vl, Math.max(en.v, 8)) * 0.8;
    place(foe.root, en.s, en.lat, en.y, steerYaw);
    foe.root.rotation.z = en.roll + lean;
    foe.root.rotation.x = en.wreck > 0 ? en.roll * 0.3 : en.lunge > 0 ? -0.04 : 0;
    for (const w of foe.wheels) w.rotation.x += en.v * 0.016 * (dt * 60);
    foe.anim?.(foe.wheels[0]?.rotation.x ?? 0);
    foe.body.position.y = en.v > 1 ? Math.sin(en.s * 0.8) * 0.02 + (en.lunge > 0 ? 0.04 : 0) : 0;
    const m = foe.mort;
    m.root.visible = en.seated;
    const fury = quiet ? 0.25 : 0.5 + en.rage * 0.4;
    // a fist out at you, shaking, and the other hand on the wheel
    // Right hand on the wheel; the left arm out of the window, shaking a fist at you and never stopping.
    const flail = time * (9 + en.rage * 5);
    m.armL.rotation.z = quiet ? -0.25 : 2.35 + Math.sin(flail) * 0.3;
    m.armL.rotation.x = quiet ? -1.1 : Math.sin(flail * 1.45) * 0.35 - 0.15;
    m.armL.rotation.y = 0;
    m.armR.rotation.x = -1.15 + Math.sin(time * 2.1) * 0.04;
    m.armR.rotation.z = 0.3;
    m.head.rotation.y = quiet ? 0 : Math.sin(time * 1.3) * 0.12;
    m.head.rotation.x = quiet ? 0.1 : -0.05 + Math.sin(flail) * 0.03;
    // brows down at the middle: furious, not frightened
    m.brows[0].rotation.z = -fury;
    m.brows[1].rotation.z = fury;
    m.brows[0].position.y = m.brows[1].position.y = 0.105;
    m.mouth.scale.x = quiet ? 0.9 : 1.35;
    m.mouth.scale.y = talk && !quiet ? 1.2 + Math.abs(Math.sin(time * 18)) * 0.7 : 0.8;
    if (cur.linda) {
      // she never opens it: she grinds, jaw sliding side to side
      m.mouth.scale.set(1.25, 1.6, 1);
      m.mouth.position.x = quiet ? 0 : Math.sin(time * 34) * 0.012;
    }
    foe.paint.emissive.setRGB(en.rage * 0.35, 0, 0);
    const lit = en.wreck === 0;
    if (cur.linda) return; // the two big headlight beams are his
    foe.root.updateMatrixWorld(true);
    for (let i = 0; i < 2; i++) {
      tmp.copy(foe.lamps[i]);
      foe.body.localToWorld(tmp);
      beams[i].position.copy(tmp);
      toWorld(en.s + 40, en.lat + (i ? 1 : -1) * 0.8, 0, beams[i].target.position);
      beams[i].intensity = lit ? 1400 : 0;
      glares[i].position.copy(tmp);
      const dCam = tmp.distanceTo(camera.position);
      glares[i].scale.setScalar(lit ? Math.min(4.2, 2.2 + 26 / Math.max(6, dCam)) : 0.001);
    }
    halo.position.copy(glares[0].position).lerp(glares[1].position, 0.5);
    halo.scale.setScalar(lit ? Math.min(16, 10 + 160 / Math.max(8, halo.position.distanceTo(camera.position))) : 0.001);
    };
    for (const c of chasers) { use(c); drawChaser(); }
    use(mort);

    // Mort on foot
    const walking = phase === "takeback" && tb.phase >= 1 && tb.phase <= 3;
    walker.root.visible = walking;
    carried.root.visible = walking && tb.carrying;
    if (walking) {
      place(walker.root, tb.s, tb.lat, tb.y, tb.yaw);
      const sw = Math.sin(tb.walk) * 0.55;
      walker.legL.rotation.x = sw;
      walker.legR.rotation.x = -sw;
      if (tb.carrying) { walker.armL.rotation.x = -1.25; walker.armR.rotation.x = -1.25; walker.armL.rotation.z = -0.25; walker.armR.rotation.z = 0.25; }
      else { walker.armL.rotation.x = -sw * 0.8; walker.armR.rotation.x = sw * 0.8; walker.armL.rotation.z = 0; walker.armR.rotation.z = 0; }
      walker.root.position.y += Math.abs(Math.cos(tb.walk)) * 0.04;
      walker.brows[0].rotation.z = -0.4;
      walker.brows[1].rotation.z = 0.4;
    }

    // his backup
    for (const h of henchmen) {
      const bd = h.body;
      bd.root.visible = h.state >= 0;
      if (h.state < 0) continue;
      place(bd.root, h.s, h.lat, h.y, h.state === 2 ? 0 : h.yaw);
      if (h.state === 2) bd.root.rotation.y = heading(h.s); // facing the cab, his back to Mort
      bd.root.rotation.x = h.rx;
      const sw = Math.sin(h.walk) * 0.8;
      if (h.state === 0 || h.state === 1) {
        bd.legL.rotation.x = sw;
        bd.legR.rotation.x = -sw;
        bd.armL.rotation.x = -sw * 0.7;
        bd.armR.rotation.x = -1.9 + Math.sin(h.walk * 0.5) * 0.4; // stick up, ready
      } else if (h.state === 2) {
        bd.legL.rotation.x = 0.9;
        bd.legR.rotation.x = 0.9;
        bd.armL.rotation.x = -1.3;
        bd.armR.rotation.x = -2.6 + Math.abs(Math.sin(time * 7.8)) * 2.0; // and down on your tailgate
      } else {
        bd.legL.rotation.x = 0.3;
        bd.legR.rotation.x = -0.4;
        bd.armL.rotation.x = -2.6;
        bd.armR.rotation.x = -2.2;
      }
    }
    if (henchSay.t > 0) henchSay.t -= dt >= 0.5 ? 0 : dt;

    // projectiles
    for (const b of balls) {
      b.mesh.visible = b.live;
      if (b.live) { toWorld(b.s, b.lat, b.y, b.mesh.position); b.mesh.scale.setScalar(b.dmg < 1 ? 0.55 : 1); }
      if (b.live && dt > 0 && dt < 0.5) {
        b.trail -= dt;
        if (b.trail <= 0) { b.trail = 0.035; puff("smoke", b.s, b.lat, b.y, b.vs * 0.2, 0, 0.5, 0.35, 0.7); }
      }
    }
    for (let i = 0; i < thrown.length; i++) {
      const it = thrown[i];
      it.mesh.visible = it.live;
      warns[i].visible = it.live && !it.passed;
      if (!it.live) continue;
      toWorld(it.s, it.lat, it.y, it.mesh.position);
      it.mesh.rotation.set(it.spin, heading(it.s), it.spin * 0.5);
      toWorld((riders[it.rider] ?? me).s - 1.2, it.targetLat, 0.06, warns[i].position);
      warns[i].scale.setScalar(1 + Math.sin(time * 20) * 0.15);
    }
    for (const p of puffs) {
      if (!p.live) continue;
      toWorld(p.s, p.lat, p.y, p.sprite.position);
      const k = p.age / p.life;
      p.sprite.scale.setScalar(p.size * (1 + k * p.grow));
      p.mat.opacity = (p.kind === "smoke" ? 0.55 : p.kind === "black" ? 0.7 : p.kind === "dust" ? 0.4 : 1) * (1 - k);
      if (p.kind === "fire") p.mat.color.setRGB(1, 0.55 * (1 - k) + 0.15, 0.15 * (1 - k));
    }

    // the arc each local truck is about to fire
    for (const a of aimSets) {
      const r = a.r;
      const show = phase !== "over" && phase !== "takeback" && alive(r) && !r.disarmed;
      a.reticle.visible = show;
      a.dots.visible = show;
      if (!show) continue;
      const mz = muzzle(r);
      let s = mz.s;
      let l = mz.lat;
      let y = mz.y;
      const vs = -MUZZLE * mz.cp * Math.cos(r.aim.yaw);
      const vl = MUZZLE * mz.cp * Math.sin(r.aim.yaw);
      let vy = MUZZLE * Math.sin(r.aim.pitch);
      const tTot = (vy + Math.sqrt(vy * vy + 2 * G * y)) / G;
      const dtd = tTot / DOTS;
      const sc = r.reload > 0 ? 0.6 : 1;
      for (let i = 0; i < DOTS; i++) {
        s += vs * dtd; l += vl * dtd; vy -= G * dtd; y = Math.max(0.1, y + vy * dtd);
        toWorld(s, l, y, P);
        M.compose(P, Q.identity(), S3.set(sc, sc, sc));
        a.dots.setMatrixAt(i, M);
      }
      a.dots.instanceMatrix.needsUpdate = true;
      toWorld(s, l, 0.05, a.reticle.position);
      a.reticle.rotation.set(0, heading(s), 0);
      (a.reticle.material as THREE.MeshBasicMaterial).color.set(r.reload > 0 ? 0x8a7a5a : a.tint);
    }

    // words over heads
    for (const c of chasers) {
      use(c);
      if (talk && en.wreck < 2 && !quiet) {
        c.bubble.textContent = talk;
        project(c.bubble, en.s + foe.len / 2 - 1, en.lat, foe.tall + 1.2, true, 80);
      } else c.bubble.style.opacity = "0";
    }
    use(mort);
    const hs = henchmen[henchSay.i];
    if (hs && henchSay.t > 0 && hs.state >= 0 && hs.state <= 2) {
      henchBubble.textContent = "Go get 'em, guys!";
      project(henchBubble, hs.s, hs.lat, hs.y + 2.3, true, 70);
    } else henchBubble.style.opacity = "0";
    if (two) for (const r of riders) project(tags[r.idx], r.s - 1, r.lat, 2.7, !r.gone && phase !== "over", 30);
    watchNews(Math.min(dt, 0.1));
  };


  /* ------------------------------------------------------------ Gatch News
     The chase is on national TV. Now and then a chopper shot opens in the
     corner with a breaking-news lower third, and between broadcasts the truck
     radio chips in. All of it is drawn into the WebGL canvas, so snapshots
     and films catch it too. */
  const NEWS_W = 640;
  const NEWS_PIC = 360;
  const NEWS_H = 430;
  const newsCanvas = document.createElement("canvas");
  newsCanvas.width = NEWS_W;
  newsCanvas.height = NEWS_H;
  const nc = newsCanvas.getContext("2d")!;
  const newsTex = new THREE.CanvasTexture(newsCanvas);
  newsTex.colorSpace = THREE.SRGBColorSpace;
  const hudScene = new THREE.Scene();
  const hudCam = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
  const newsPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: newsTex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
  hudScene.add(newsPlane);
  const newsCam = new THREE.PerspectiveCamera(36, 16 / 9, 0.5, 1200);
  const news = { on: 0, cd: 6, headline: "", sub: "", radio: "", radioT: 0, radioCd: 9, tick: 0, drawT: 0, level: 1, lindaLevel: 1, wrecked: false, lindaWrecked: false, alert: "", linda: false, idle: 0 };
  const RADIO = [
    "Folks, if you're on Route 66 tonight... pull over.",
    "Our chopper confirms: that is a REAL pirate cannon.",
    "A caller says the man chasing them is named Mort. He sounds upset.",
    "Gatch Traffic: heavy delays, cannonballs in the left lane.",
    "Experts say: do not try this in your own pickup.",
    "We go live to our reporter, who is hiding behind a cactus.",
    "Mort's grandmother has asked everyone to please stop.",
    "This just in: he is still very, very mad.",
  ];
  const RADIO_LINDA = ["A woman called in. She says she's his cousin and she's 'on her way, sugar.'", "Witnesses describe Linda as 'grinding her teeth like a garbage disposal.'"];
  const RADIO_THANKS = ["Happy Thanksgiving from Gatch News, where the turkey is airborne.", "Reports of pumpkin pie on the windshield of a minivan."];
  const IDLE_NEWS: [string, string][] = [
    ["CANNON CHASE ENTERS ITS {MIN}TH MINUTE", "Nobody has pulled over"],
    ["NATION GRIPPED BY ROUTE 66 CANNON CHASE", "Gatch News Chopper 7 is overhead"],
    ["'THAT WAS MY GRANDPA'S,' SAYS FURIOUS DRIVER", "He has said it eleven times now"],
  ];
  const breaking = (headline: string, sub: string, dur = 7): void => {
    if (news.on > 1.5 && news.headline === headline) return;
    news.headline = headline;
    news.sub = sub;
    news.on = dur;
    news.cd = 22 + Math.random() * 14;
    news.idle = 0;
  };
  const watchNews = (dt: number): void => {
    if (phase === "intro") return;
    const L = rideAt(mort.en.level).name.replace(/^the /, "").toUpperCase();
    if (mort.en.level !== news.level) {
      news.level = mort.en.level;
      if (rideAt(mort.en.level).kind === "train") breaking("HE IS DRIVING A TRAIN", "We cannot stress this enough: a TRAIN, on the highway");
      else breaking(`MORT IS BACK, NOW IN A ${L}`, "Where does he keep finding these?");
    }
    const mw = mort.en.wreck > 0;
    if (mw && !news.wrecked) breaking(`${L} WRECKED BY CANNON FIRE`, "Witnesses expect him back in something bigger");
    news.wrecked = mw;
    if (linda) {
      if (!news.linda && phase === "play") { news.linda = true; }
      const LL = rideAt(linda.en.level).name.replace(/^the /, "").toUpperCase();
      if (linda.en.level !== news.lindaLevel) {
        news.lindaLevel = linda.en.level;
        breaking(rideAt(linda.en.level).kind === "train" ? "SHE IS ALSO DRIVING A TRAIN" : `COUSIN LINDA NOW IN A ${LL}`, "Family sources call her 'a lunatic, lovingly'");
      }
      const lw = linda.en.wreck > 0;
      if (lw && !news.lindaWrecked) breaking(`LUNATIC LINDA'S ${LL} WRECKED`, "She is reportedly 'not done, honey'");
      news.lindaWrecked = lw;
    }
    if (alert && alert !== news.alert && phase === "play") breaking("ACCOMPLICES IN RIDICULOUS HATS JOIN CHASE", "Police describe the hats as 'a lot'");
    news.alert = alert;
    if (phase === "takeback" && news.headline !== "IT'S OVER: MORT TAKES BACK HIS CANNON") breaking("IT'S OVER: MORT TAKES BACK HIS CANNON", "He is walking it back to his car. Slowly.", 9);
    news.on = Math.max(0, news.on - dt);
    news.cd -= dt;
    if (news.cd <= 0 && phase === "play") {
      const first = news.idle === 0 && news.headline === "";
      if (first) breaking("BREAKING: STOLEN PIRATE CANNON ON ROUTE 66", linda ? "Owner 'Mad Mort' and cousin in pursuit" : "Owner 'Mad Mort' in pursuit in a station wagon", 8);
      else {
        const [h, sub] = IDLE_NEWS[Math.floor(Math.random() * IDLE_NEWS.length)];
        breaking(h.replace("{MIN}", String(Math.max(2, Math.floor(time / 60)))), sub, 6);
      }
      news.idle++;
    }
    // the radio fills the gaps between broadcasts
    news.radioT = Math.max(0, news.radioT - dt);
    news.radioCd -= dt;
    if (news.radioCd <= 0 && news.on <= 0 && phase === "play") {
      const pool = [...RADIO, ...(linda ? RADIO_LINDA : []), ...(thanks ? RADIO_THANKS : [])];
      news.radio = pool[Math.floor(Math.random() * pool.length)];
      news.radioT = 6;
      news.radioCd = 16 + Math.random() * 12;
    }
    news.tick += dt * 70;
  };
  const paintNews = (): void => {
    nc.clearRect(0, 0, NEWS_W, NEWS_H);
    const tv = news.on > 0;
    if (tv) {
      const k = Math.min(1, news.on * 3, (8 - Math.min(8, news.on)) * 4 + 0.2);
      nc.globalAlpha = Math.min(1, k + 0.2);
      // frame
      nc.lineWidth = 6;
      nc.strokeStyle = "#0b1230";
      nc.strokeRect(3, 3, NEWS_W - 6, NEWS_PIC - 3);
      // the bug
      nc.fillStyle = "#c8101e";
      nc.fillRect(14, 14, 176, 40);
      nc.fillStyle = "#fff";
      nc.font = "900 24px Inter, system-ui, sans-serif";
      nc.fillText("GATCH NEWS", 24, 43);
      nc.fillStyle = "rgba(0,0,0,0.6)";
      nc.fillRect(196, 14, 84, 40);
      nc.fillStyle = Math.floor(time * 2) % 2 ? "#ff3a3a" : "#7a1a1a";
      nc.beginPath(); nc.arc(214, 34, 7, 0, Math.PI * 2); nc.fill();
      nc.fillStyle = "#fff";
      nc.font = "800 19px Inter, system-ui, sans-serif";
      nc.fillText("LIVE", 228, 41);
      nc.fillStyle = "rgba(0,0,0,0.5)";
      nc.fillRect(NEWS_W - 150, 14, 136, 32);
      nc.fillStyle = "#fff";
      nc.font = "700 15px Inter, system-ui, sans-serif";
      nc.fillText("CHOPPER 7", NEWS_W - 138, 36);
      // lower third
      nc.fillStyle = "#0b1a4a";
      nc.fillRect(0, NEWS_PIC - 92, NEWS_W, 70);
      nc.fillStyle = "#c8101e";
      nc.fillRect(0, NEWS_PIC - 92, 132, 70);
      nc.fillStyle = "#fff";
      nc.font = "900 22px Inter, system-ui, sans-serif";
      nc.fillText("BREAKING", 12, NEWS_PIC - 50);
      let size = 26;
      nc.font = `900 ${size}px Inter, system-ui, sans-serif`;
      while (nc.measureText(news.headline).width > NEWS_W - 156 && size > 14) { size -= 1; nc.font = `900 ${size}px Inter, system-ui, sans-serif`; }
      nc.fillText(news.headline, 144, NEWS_PIC - 58);
      nc.fillStyle = "#c8d4ff";
      nc.font = "600 17px Inter, system-ui, sans-serif";
      nc.fillText(news.sub, 144, NEWS_PIC - 32);
    }
    // the ticker (with the picture) or the truck radio (between broadcasts)
    const radio = !tv && news.radioT > 0;
    if (tv || radio) {
      nc.globalAlpha = radio ? Math.min(1, news.radioT * 2, (6 - news.radioT) * 3) : 1;
      const y = NEWS_PIC + 8;
      nc.fillStyle = radio ? "rgba(10,14,30,0.85)" : "#ffd23a";
      nc.fillRect(0, y, NEWS_W, 52);
      nc.save();
      nc.beginPath(); nc.rect(0, y, NEWS_W, 52); nc.clip();
      if (radio) {
        nc.fillStyle = "#ffd23a";
        nc.font = "900 17px Inter, system-ui, sans-serif";
        nc.fillText("📻 GATCH RADIO", 12, y + 21);
        nc.fillStyle = "#fff";
        let size = 18;
        nc.font = `600 ${size}px Inter, system-ui, sans-serif`;
        while (nc.measureText(news.radio).width > NEWS_W - 24 && size > 11) { size -= 1; nc.font = `600 ${size}px Inter, system-ui, sans-serif`; }
        nc.fillText(news.radio, 12, y + 43);
      } else {
        const line = [...RADIO.slice(0, 5), "HOLIDAY TRAFFIC: AVOID ROUTE 66", "MORE ON THE CANNON CHASE AT ELEVEN"].join("   •   ");
        nc.fillStyle = "#0b1230";
        nc.font = "800 19px Inter, system-ui, sans-serif";
        const wLine = nc.measureText(line + "   •   ").width;
        const x0 = -(news.tick % wLine);
        nc.fillText(line, x0 + 12, y + 33);
        nc.fillText(line, x0 + 12 + wLine, y + 33);
      }
      nc.restore();
    }
    nc.globalAlpha = 1;
    newsTex.needsUpdate = true;
  };
  /** The main view, then the chopper shot and the news graphics on top. */
  const renderAll = (): void => {
    if (fin) {
      const W = canvas.clientWidth || mount.clientWidth || 1;
      const H = canvas.clientHeight || mount.clientHeight || 1;
      fin.aspect(W / H);
      renderer.render(fin.scene, fin.camera);
      fin.overlay(renderer, W, H);
      return;
    }
    renderer.render(scene, camera);
    const tv = news.on > 0;
    const radio = !tv && news.radioT > 0;
    if (!tv && !radio) return;
    const W = canvas.clientWidth || mount.clientWidth;
    const H = canvas.clientHeight || mount.clientHeight;
    const phoneView = W < 640 || W / H < 0.9;
    const pw = phoneView ? Math.round(W * 0.56) : Math.round(Math.min(430, W * 0.33));
    const total = (pw * NEWS_H) / NEWS_W;
    const picH = (pw * NEWS_PIC) / NEWS_W;
    const x = W - pw - (phoneView ? 10 : 16);
    // phones: above the stick and the fire button, clear of the cards up top and of the chaser
    const top = phoneView ? H - total - 170 : H - total - 16;
    if (tv) {
      // the chopper: high and off to the side, circling slowly, looking down at the chase
      const sMid = (me.s * 2 + en.s) / 3;
      const latMid = (me.lat + en.lat) / 2;
      toWorld(sMid, latMid, 1, tmp);
      const a = time * 0.12;
      newsCam.position.set(tmp.x + Math.cos(a) * 34, tmp.y + 24, tmp.z + Math.sin(a) * 34);
      newsCam.lookAt(tmp);
      newsCam.aspect = pw / picH;
      newsCam.updateProjectionMatrix();
      const yGL = H - top - picH;
      renderer.setScissorTest(true);
      renderer.setViewport(x, yGL, pw, picH);
      renderer.setScissor(x, yGL, pw, picH);
      renderer.render(scene, newsCam);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, W, H);
    }
    news.drawT -= 1;
    if (news.drawT <= 0) { paintNews(); news.drawT = 2; }
    hudCam.left = 0; hudCam.right = W; hudCam.top = H; hudCam.bottom = 0;
    hudCam.updateProjectionMatrix();
    newsPlane.position.set(x + pw / 2, H - top - total / 2, 0);
    newsPlane.scale.set(pw, total, 1);
    renderer.autoClear = false;
    renderer.render(hudScene, hudCam);
    renderer.autoClear = true;
  };

  /* ------------------------------------------------------------ loop */
  let raf = 0;
  let last = performance.now();
  let hudT = 0;
  let fps = 60;
  let disposed = false;
  const tick = (dt: number): void => { if (isGuest) guestStep(dt); else step(dt); };
  const hud = (): ChaseHud => {
    const t = target();
    return {
      phase, mode,
      riders: riders.map((r) => ({
        hull: Math.round(r.hull), max: r.max, boost: r.boost, reload: 1 - r.reload / (RELOAD * r.reloadMul),
        out: r.out, respawn: Math.ceil(r.respawn), you: local.includes(r),
        label: mode === "duo" ? `P${r.idx + 1}` : !two ? "TRUCK" : r.idx === mine ? "YOU" : "FRIEND",
        color: RIDER_LOOK[r.idx].css, gone: r.gone,
      })),
      score: Math.max(0, Math.round(score)), best: Math.round(Math.max(best, score)), cash: Math.round(cash),
      meters: Math.round(Math.max(0, leadS())), level: en.level,
      ride: RIDES[Math.min(en.level - 1, RIDES.length - 1)].name, foeHp: Math.max(0, Math.ceil(en.hp - 0.001)), foeMax: en.max,
      foeWrecked: en.wreck > 0,
      linda: linda ? { hp: Math.max(0, Math.ceil(linda.en.hp - 0.001)), max: linda.en.max, ride: rideAt(linda.en.level).name, wrecked: linda.en.wreck > 0 } : null,
      gap: Math.round(t.s - en.s), hits, wrecks, toast, fps: Math.round(fps),
      link: !net ? "" : time - lastHeard > 6 ? "lost" : "ok",
      alert, henchmen: henchmen.filter((h) => h.state >= 0 && h.state <= 2).length,
      finale: fin ? fin.hud() : null,
      won,
    };
  };
  const frame = (now: number): void => {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    fps = lerp(fps, 1 / Math.max(dt, 0.001), 0.05);
    tick(dt);
    audio.update(fin ? 0 : me.v, target().s - en.s, !fin && en.wreck === 0 && en.seated);
    draw(dt);
    renderAll();
    hudT -= dt;
    if (hudT <= 0) { hudT = 0.1; opts.onHud?.(hud()); }
  };

  function disposeTree(o: THREE.Object3D): void {
    o.traverse((x) => {
      const mm = x as THREE.Mesh;
      mm.geometry?.dispose();
      const mat = mm.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((y) => y.dispose()); else mat?.dispose();
    });
  }

  const api: CannonRun = {
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      try { net?.send({ t: "bye" }); } catch { /* closed */ }
      net?.close();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("pointerdown", onDown);
      audio.stop();
      fin?.dispose();
      scene.traverse((x) => {
        const mm = x as THREE.Mesh;
        mm.geometry?.dispose();
        const mat = mm.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((y) => y.dispose()); else mat?.dispose();
      });
      [roadTex, sand, glow, puffTex, signTex].forEach((t) => t.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      bubble.remove();
      lindaBubble.remove();
      tags.forEach((t) => t.remove());
      henchBubble.remove();
      delete (window as unknown as { __chase?: unknown }).__chase;
    },
    setStick(x, y) { stick.x = x; stick.y = y; },
    aimAt(clientX, clientY, f) {
      audio.start();
      const r = canvas.getBoundingClientRect();
      mouseX = clientX - r.left;
      mouseY = clientY - r.top;
      if (f) me.wantFire = true;
    },
    hold(action, down) { if (action === "boost") held.boost = down; },
    restart() {
      if (isGuest) return;
      gen += 1;
      if (fin) { fin.dispose(); fin = null; for (const el of [bubble, lindaBubble, henchBubble, ...tags]) el.style.display = ""; }
      won = false;
      riders.forEach((r) => { resetRider(r); if (r.idx === 1 && mode === "host") r.net = null; });
      score = 0; cash = 0; kmPaid = 0; hits = 0; wrecks = 0; introT = 0; phase = "intro"; toast = ""; talk = ""; ended = false;
      traffic.length = 0;
      balls.forEach((b) => { b.live = false; });
      thrown.forEach((t) => { t.live = false; });
      henchmen.forEach((h) => { h.state = -1; });
      backupT = 16 + Math.random() * 30;
      alert = "";
      puffs.forEach((p) => { p.live = false; p.sprite.visible = false; });
      Object.assign(tb, { phase: 0, t: 0, carrying: false });
      for (const c of chasers) { use(c); spawnFoe(1, 140); en.v = 40; talk = ""; backupT = (c.linda ? 10 : 16) + Math.random() * 30; }
      use(mort);
      camReady = false;
    },
    setMuted(m) { muted = m; audio.mute(m); },
  };

  if (mode === "host") riders[1].net = null;
  for (const c of chasers) { use(c); spawnFoe(1, 140); en.v = 40; }
  use(mort);

  // For scripts that play it without a person: scripts/cannonrun-check.mjs.
  (window as unknown as { __chase?: unknown }).__chase = {
    state: () => ({
      ...hud(), lat: me.lat, swerves: traffic.map((t) => +t.swerve.toFixed(1)), foeLat: en.lat, foeS: en.s, s: me.s, seated: en.seated, tb: { ...tb },
      riderS: riders.map((r) => r.s), riderLat: riders.map((r) => r.lat), disarmed: riders.map((r) => r.disarmed),
      balls: balls.filter((b) => b.live).length, thrown: thrown.filter((t) => t.live).length,
      traffic: traffic.map((t) => ({ mode: t.mode, y: +t.y.toFixed(2), s: Math.round(t.s - me.s) })),
      draws: renderer.info.render.calls, tris: renderer.info.render.triangles,
    }),
    key: (k: string, down: boolean) => {
      if (down) {
        if (mode === "duo") { if (k === " ") riders[0].wantFire = true; if (P2_FIRE.has(k)) riders[1].wantFire = true; }
        else if (k === " ") me.wantFire = true;
        keys.add(k);
      } else keys.delete(k);
    },
    /** Aim at the road by screen fraction (0..1); no args points back at him. */
    aim: (fx?: number, fy?: number) => { if (fx === undefined || fy === undefined) { mouseX = -1; mouseY = -1; } else { mouseX = fx * canvas.clientWidth; mouseY = fy * canvas.clientHeight; } },
    fire: (i = mine) => { (riders[i] ?? me).wantFire = true; },
    level: (n: number, gap = 40) => spawnFoe(n, gap),
    gap: (g: number) => { en.s = target().s - g; },
    hull: (n: number, i = mine) => { const r = riders[i] ?? me; r.hull = n; if (n <= 0 && alive(r)) knockOut(r); },
    /** Put a car right in front of Mort's grille: fly=true launches it into the air at once. */
    launchCar: (fly = true) => {
      const t: Traffic = {
        s: en.s + foe.len / 2 + 6, lat: en.lat, y: 0.75, v: en.v * 0.5, vl: 0, vy: 0, rx: 0, ry: 0, rz: 0, wx: 0, wy: 0, wz: 0,
        color: new THREE.Color(TRAFFIC_COLORS[traffic.length % TRAFFIC_COLORS.length]), mode: 0, air: 0, side: 1, hitCd: 0, live: true, swerve: 0,
      };
      traffic.push(t);
      if (traffic.length > MAX_TRAFFIC) traffic.shift();
      launch(t, en.lat - 1, en.level + 2, fly);
    },
    /** call his backup now */
    backup: () => { backupT = 0; },
    /** put Linda this far behind the truck she is after, optionally in a given ride */
    lindaAt: (g: number, level = 0) => { if (!linda) return; use(linda); if (level) spawnFoe(level, g); en.s = target().s - g; use(mort); },
    hench: () => henchmen.filter((h) => h.state >= 0).map((h) => ({ state: h.state, ds: +(h.s - riders[h.rider].s).toFixed(1), lat: +h.lat.toFixed(1) })),
    /** put a civilian just ahead of Mort and have him throw at it */
    throwAtCar: () => {
      const t: Traffic = {
        s: en.s + 22, lat: en.lat + 2.5, y: 0.75, v: en.v * 0.6, vl: 0, vy: 0, rx: 0, ry: 0, rz: 0, wx: 0, wy: 0, wz: 0,
        color: new THREE.Color(0x2e5fa8), mode: 0, air: 0, side: 1, hitCd: 0, live: true, swerve: 0,
      };
      traffic.push(t);
      if (traffic.length > MAX_TRAFFIC) traffic.shift();
      en.throwT = 0;
    },
    upgrade: (u: Partial<Upgrades>, i = mine) => { const r = riders[i]; Object.assign(r, u); r.autoGun.root.visible = r.auto > 0; },
    run: (n: number, dt = 1 / 60) => { for (let k = 0; k < n; k++) { tick(dt); draw(dt); } },
    snapshot: () => { draw(1); renderAll(); return canvas.toDataURL("image/jpeg", 0.9); },
    /** put a Gatch News bulletin on now */
    news: (headline = "BREAKING: STOLEN PIRATE CANNON ON ROUTE 66", sub = "Owner 'Mad Mort' in pursuit") => breaking(headline, sub, 8),
    radio: (line?: string) => { news.radio = line ?? RADIO[0]; news.radioT = 6; news.on = 0; },
    /** go straight to the diner: "arrive" (the whole thing), "fight", "won" (the ending) or "lost" */
    finale: (stage: FinaleStage = "arrive") => startFinale(stage),
    finaleHud: () => fin?.hud() ?? null,
    finalePeek: () => fin?.peek() ?? null,
    /** wreck whatever Mort is driving, now (with level(6) first, that is the train) */
    wreck: () => hitFoe({ s: en.s, lat: en.lat, y: 1 }, "test", 999),
  };
  // ?finale opens a run at the diner; ?finale=fight|won|lost skips ahead (for filming)
  if (params.has("finale") && !isGuest) {
    const want = params.get("finale") as FinaleStage;
    startFinale(["fight", "won", "lost", "standoff"].includes(want) ? want : "arrive");
  }

  draw(1);
  raf = requestAnimationFrame(frame);
  opts.onReady?.();
  return api;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
