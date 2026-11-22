/**
 * Fog City: the game.
 *
 * One file owns the loop: input, the player on foot and at the wheel, traffic,
 * pedestrians, the police, courier runs, the camera, the sun. There is no
 * physics engine. Cars are a velocity and a heading on a heightfield, buildings
 * are boxes in a lookup, and that is enough for a city you can drive hard in,
 * at a cost of well under a millisecond a frame.
 *
 * Heading convention, used by everything: forward is (sin h, cos h) in (x, z),
 * so heading PI faces north (-z), and a model built facing +z needs only
 * `rotation.y = h`. The right-hand side of forward (fx, fz) is (-fz, fx).
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { buildCity, shared } from "./build";
import {
  BX, BZ, IMAX, JMAX, ROAD, GRID_X, GRID_Z, SHORE_X, SHORE_N, PLACES, SPAWN, type Place,
  groundAt, heightAt, onSpan, resolveCircle, insideBox, nodeOk, blockKind,
  GG_X, GG_HALF, GG_Z1, GG_Z2, GG_Z3,
} from "./world";

export interface FogHud {
  cash: number;
  /** 0..5. Whole numbers are what the meter shows; the fraction is cooling. */
  heat: number;
  /** km/h while driving, null on foot. */
  speed: number | null;
  prompt: string;
  job: string;
  jobTime: number | null;
  toast: string;
  clock: string;
  fps: number;
  found: number;
  places: number;
}

export interface FogCity {
  dispose(): void;
  /** Touch stick: x right, y forward, each -1..1. */
  setStick(x: number, y: number): void;
  /** Drag to look, in pixels. */
  look(dx: number, dy: number): void;
  press(action: "use" | "jump" | "time" | "fog" | "reset"): void;
  /** Held on a phone: brake while driving, run on foot. */
  hold(action: "brake" | "run", down: boolean): void;
  setMuted(m: boolean): void;
  drawMap(ctx: CanvasRenderingContext2D, size: number): void;
}

interface Opts {
  onHud?: (h: FogHud) => void;
  onReady?: () => void;
}

const DX = [1, 0, -1, 0];
const DZ = [0, 1, 0, -1];
const LANE = 3.5;
const MAX_CARS = 56;
const MAX_PEDS = 56;
const MAX_COPS = 5;
const CAR_COLORS = [0xb8392e, 0x2e5fa8, 0xe8e4da, 0x2a2d33, 0x8a8f96, 0xd9a521, 0x3c7a4e, 0x7b4a9e, 0xc96a2a, 0x9fb8c8];
const SHIRTS = [0xd95b4a, 0x4a7fd9, 0xe7c14a, 0x4fae6a, 0xe8e8e8, 0x8a5fd0, 0x35383d, 0xe58ab0];

interface Car {
  x: number; y: number; z: number; h: number;
  vx: number; vz: number;
  pitch: number; roll: number;
  color: number;
  cop: boolean;
  mode: "ai" | "parked" | "player" | "stun";
  /** Grid follower state: last node, direction of travel, metres past the node. */
  i: number; j: number; dir: number; dist: number;
  cruise: number;
  speed: number;
  stun: number;
  /** Cops only: chasing off the grid, straight at the player. */
  free: boolean;
}

interface Ped {
  bi: number; bj: number; s: number; sign: number; pace: number;
  x: number; y: number; z: number; h: number;
  color: number;
  /** > 0 while airborne after being hit. */
  flung: number; vx: number; vy: number; vz: number;
  phase: number;
}

const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Shortest signed turn from a to b. */
const turn = (a: number, b: number): number => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

function tinted(g: THREE.BufferGeometry, r: number, gr: number, b: number): THREE.BufferGeometry {
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = gr; c[i * 3 + 2] = b; }
  g.setAttribute("color", new THREE.BufferAttribute(c, 3));
  return g;
}
function part(w: number, h: number, d: number, x: number, y: number, z: number, r: number, g: number, b: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(x, y, z);
  return tinted(geo, r, g, b);
}

function carGeometry(): THREE.BufferGeometry {
  const parts = [
    part(1.9, 0.6, 4.4, 0, 0.66, 0, 1, 1, 1),
    part(1.84, 0.2, 4.3, 0, 0.3, 0, 0.12, 0.12, 0.13),
    part(1.62, 0.56, 2.3, 0, 1.2, -0.25, 0.1, 0.14, 0.18),
    part(1.66, 0.08, 2.1, 0, 1.5, -0.25, 1, 1, 1),
    part(0.5, 0.16, 0.06, 0.6, 0.74, 2.2, 3, 3, 2.4),
    part(0.5, 0.16, 0.06, -0.6, 0.74, 2.2, 3, 3, 2.4),
    part(0.5, 0.14, 0.06, 0.62, 0.76, -2.2, 2.2, 0.1, 0.08),
    part(0.5, 0.14, 0.06, -0.62, 0.76, -2.2, 2.2, 0.1, 0.08),
  ];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(part(0.28, 0.68, 0.68, sx * 0.9, 0.34, sz * 1.42, 0.05, 0.05, 0.05));
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return g;
}

function pedGeometry(): THREE.BufferGeometry {
  const parts = [
    part(0.34, 0.86, 0.22, 0, 0.43, 0, 0.22, 0.24, 0.3),
    part(0.46, 0.62, 0.26, 0, 1.17, 0, 1, 1, 1),
    part(0.24, 0.26, 0.24, 0, 1.62, 0, 1.25, 1.0, 0.82),
  ];
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return g;
}

export function createFogCity(mount: HTMLElement, opts: Opts = {}): FogCity {
  const automated = typeof navigator !== "undefined" && navigator.webdriver === true;

  /* ------------------------------------------------------------ renderer */
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  let pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
  renderer.setPixelRatio(pixelRatio);
  renderer.domElement.style.cssText = "display:block;width:100%;height:100%;touch-action:none";
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xb9d4ea, 0.00025);
  const camera = new THREE.PerspectiveCamera(62, 1, 0.3, 9000);

  const city = buildCity();
  scene.add(city.group);

  const sun = new THREE.DirectionalLight(0xffffff, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -110; sc.right = 110; sc.top = 110; sc.bottom = -110; sc.near = 10; sc.far = 1100;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xbcd6ff, 0x6b6558, 0.9);
  scene.add(hemi);
  const headlamp = new THREE.SpotLight(0xfff0d0, 0, 60, 0.5, 0.6, 1.2);
  scene.add(headlamp, headlamp.target);

  /* ------------------------------------------------------------ actors */
  const carGeo = carGeometry();
  const carMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const carMesh = new THREE.InstancedMesh(carGeo, carMat, MAX_CARS);
  carMesh.castShadow = true;
  carMesh.frustumCulled = false;
  carMesh.count = 0;
  scene.add(carMesh);

  const barGeo = new THREE.BoxGeometry(1.2, 0.18, 0.34);
  const barMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const barMesh = new THREE.InstancedMesh(barGeo, barMat, MAX_COPS * 2);
  barMesh.frustumCulled = false;
  barMesh.count = 0;
  scene.add(barMesh);

  const pedGeo = pedGeometry();
  const pedMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const pedMesh = new THREE.InstancedMesh(pedGeo, pedMat, MAX_PEDS);
  pedMesh.castShadow = true;
  pedMesh.frustumCulled = false;
  pedMesh.count = 0;
  scene.add(pedMesh);

  // You: a figure with limbs that swing, so walking reads as walking.
  const me = new THREE.Group();
  const limb = (w: number, h: number, d: number, color: number, x: number, y: number): THREE.Mesh => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(0, -h / 2, 0);
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color }));
    m.position.set(x, y, 0);
    m.castShadow = true;
    me.add(m);
    return m;
  };
  const torso = limb(0.5, 0.66, 0.28, 0x1f8a8a, 0, 1.5);
  const head = limb(0.26, 0.28, 0.26, 0xe0b48c, 0, 1.82);
  const hair = limb(0.28, 0.1, 0.28, 0x2a2018, 0, 1.86);
  const armL = limb(0.14, 0.62, 0.16, 0x1f8a8a, -0.33, 1.48);
  const armR = limb(0.14, 0.62, 0.16, 0x1f8a8a, 0.33, 1.48);
  const legL = limb(0.19, 0.86, 0.2, 0x2b3550, -0.13, 0.86);
  const legR = limb(0.19, 0.86, 0.2, 0x2b3550, 0.13, 0.86);
  void torso; void head; void hair;
  scene.add(me);

  // The courier marker: a ring on the ground and a beam you can see across town.
  const marker = new THREE.Group();
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xffc83d, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 1.4, 28, 1, true), ringMat);
  ring.position.y = 0.9;
  const beamMat = new THREE.MeshBasicMaterial({ color: 0xffc83d, transparent: true, opacity: 0.22, depthWrite: false, fog: false });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 260, 8, 1, true), beamMat);
  beam.position.y = 130;
  marker.add(ring, beam);
  scene.add(marker);

  /* ------------------------------------------------------------ state */
  const player = { x: SPAWN.x, y: 0, z: SPAWN.z + 3, h: SPAWN.heading, vy: 0, grounded: true, phase: 0, moving: 0 };
  player.y = groundAt(player.x, player.z);
  let driving: Car | null = null;
  const cars: Car[] = [];
  const peds: Ped[] = [];

  let camYaw = SPAWN.heading;
  let camPitch = 0.32;
  let camDist = 6.5;
  let lookIdle = 9;
  const camPos = new THREE.Vector3();

  let tod = 16.6;
  let fogWanted = 0.12;
  let fogNow = 0.12;

  const SAVE = "fogcity.save.v1";
  let cash = 250;
  const found = new Set<string>();
  try {
    const s = JSON.parse(localStorage.getItem(SAVE) ?? "null") as { cash?: number; found?: string[] } | null;
    if (s && typeof s.cash === "number") cash = s.cash;
    if (s && Array.isArray(s.found)) s.found.forEach((k) => found.add(k));
  } catch { /* a private window: play without saving */ }
  const save = (): void => {
    try { localStorage.setItem(SAVE, JSON.stringify({ cash, found: [...found] })); } catch { /* fine */ }
  };

  let heat = 0;
  let coolFor = 0;
  let bustFor = 0;
  let copClock = 0;
  let toast = "";
  let toastFor = 0;
  const say = (t: string, secs = 3.2): void => { toast = t; toastFor = secs; };

  const stops = PLACES.filter((p) => p.job);
  let job: { stage: "pickup" | "deliver"; at: Place; from: Place | null; time: number; pay: number } = { stage: "pickup", at: stops[1], from: null, time: 0, pay: 0 };
  let lastSafe = { x: player.x, z: player.z };

  const keys = new Set<string>();
  const stick = { x: 0, y: 0 };
  const held = { brake: false, run: false };
  const once = { use: false, jump: false };
  let muted = false;

  /* ------------------------------------------------------------ helpers */
  const lanePoint = (c: { i: number; j: number; dir: number }, dist: number, out: { x: number; z: number }): void => {
    const fx = DX[c.dir];
    const fz = DZ[c.dir];
    out.x = c.i * BX + fx * dist - fz * LANE;
    out.z = c.j * BZ + fz * dist + fx * LANE;
  };
  const segLen = (dir: number): number => (dir % 2 === 0 ? BX : BZ);
  const tmp = { x: 0, z: 0 };

  const makeCar = (i: number, j: number, dir: number, dist: number, cop: boolean): Car => {
    lanePoint({ i, j, dir }, dist, tmp);
    const cruise = cop ? 17 : 8 + Math.random() * 5;
    return {
      x: tmp.x, z: tmp.z, y: groundAt(tmp.x, tmp.z), h: Math.atan2(DX[dir], DZ[dir]),
      vx: 0, vz: 0, pitch: 0, roll: 0,
      color: cop ? 0xf2f2f2 : CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)],
      cop, mode: "ai", i, j, dir, dist, cruise, speed: cruise * 0.7, stun: 0, free: false,
    };
  };

  /** Pick the next direction at a junction. Cops pick the one that closes on you. */
  const chooseDir = (c: Car): void => {
    let best = -1;
    let bestScore = Infinity;
    const tx = driving ? driving.x : player.x;
    const tz = driving ? driving.z : player.z;
    for (let d = 0; d < 4; d++) {
      if (d === (c.dir + 2) % 4) continue;
      const ni = c.i + DX[d];
      const nj = c.j + DZ[d];
      if (!nodeOk(ni, nj)) continue;
      let score: number;
      if (c.cop) score = Math.hypot(ni * BX - tx, nj * BZ - tz) + Math.random() * 20;
      else score = (d === c.dir ? 0 : 0.55) + Math.random();
      if (score < bestScore) { bestScore = score; best = d; }
    }
    c.dir = best < 0 ? (c.dir + 2) % 4 : best;
  };

  const nearestNode = (x: number, z: number): { i: number; j: number } => ({
    i: clamp(Math.round(x / BX), -IMAX, IMAX),
    j: clamp(Math.round(z / BZ), -JMAX, JMAX),
  });

  const focus = (): { x: number; z: number } => (driving ? driving : player);

  const spawnTraffic = (): void => {
    const f = focus();
    const civ = cars.filter((c) => !c.cop).length;
    if (civ >= 34) return;
    const a = Math.random() * Math.PI * 2;
    const r = 110 + Math.random() * 190;
    const n = nearestNode(f.x + Math.cos(a) * r, f.z + Math.sin(a) * r);
    const dir = Math.floor(Math.random() * 4);
    if (!nodeOk(n.i + DX[dir], n.j + DZ[dir])) return;
    const c = makeCar(n.i, n.j, dir, 12 + Math.random() * (segLen(dir) - 24), false);
    if (Math.hypot(c.x - f.x, c.z - f.z) < 80) return;
    for (const o of cars) if (Math.hypot(o.x - c.x, o.z - c.z) < 14) return;
    // One in four is parked at the kerb, waiting for somebody to borrow it.
    if (Math.random() < 0.25) {
      c.mode = "parked";
      c.speed = 0;
      c.x += -DZ[dir] * 2.2;
      c.z += DX[dir] * 2.2;
      c.y = groundAt(c.x, c.z);
    }
    cars.push(c);
  };

  const spawnPed = (): void => {
    if (peds.length >= MAX_PEDS - 4) return;
    const f = focus();
    const a = Math.random() * Math.PI * 2;
    const r = 30 + Math.random() * 120;
    const bi = clamp(Math.floor((f.x + Math.cos(a) * r) / BX), -IMAX, IMAX - 1);
    const bj = clamp(Math.floor((f.z + Math.sin(a) * r) / BZ), -JMAX, JMAX - 1);
    if (blockKind(bi, bj) === "forest") return;
    peds.push({
      bi, bj, s: Math.random() * 400, sign: Math.random() < 0.5 ? 1 : -1, pace: 1.1 + Math.random() * 0.7,
      x: 0, y: 0, z: 0, h: 0, color: SHIRTS[Math.floor(Math.random() * SHIRTS.length)],
      flung: 0, vx: 0, vy: 0, vz: 0, phase: Math.random() * 6,
    });
  };

  /** Where a pedestrian is, s metres round the pavement of their block. */
  const pedPlace = (p: Ped): void => {
    const x0 = p.bi * BX + 8.5;
    const z0 = p.bj * BZ + 8.5;
    const w = BX - 17;
    const d = BZ - 17;
    const per = 2 * (w + d);
    let s = ((p.s % per) + per) % per;
    let h: number;
    if (s < w) { p.x = x0 + s; p.z = z0; h = Math.PI / 2; }
    else if ((s -= w) < d) { p.x = x0 + w; p.z = z0 + s; h = 0; }
    else if ((s -= d) < w) { p.x = x0 + w - s; p.z = z0 + d; h = -Math.PI / 2; }
    else { s -= w; p.x = x0; p.z = z0 + d - s; h = Math.PI; }
    p.h = p.sign > 0 ? h : h + Math.PI;
    p.y = heightAt(p.x, p.z);
  };

  const addHeat = (n: number, why: string): void => {
    const before = Math.ceil(heat);
    heat = clamp(heat + n, 0, 5);
    coolFor = 0;
    if (Math.ceil(heat) > before) say(before === 0 ? `${why}. The police are coming.` : `${why}. Heat ${Math.ceil(heat)}.`);
  };

  const respawn = (x: number, z: number, why: string): void => {
    const n = nearestNode(x, z);
    if (driving) { driving.mode = "parked"; driving.vx = driving.vz = 0; driving = null; }
    player.x = n.i * BX + ROAD + 1.5;
    player.z = n.j * BZ + ROAD + 1.5;
    player.y = groundAt(player.x, player.z);
    player.vy = 0;
    if (why) say(why, 4);
  };

  const newPickup = (): void => {
    const f = focus();
    const far = stops.filter((s) => { const d = Math.hypot(s.x - f.x, s.z - f.z); return d > 220 && d < 1500; });
    job = { stage: "pickup", at: (far.length ? far : stops)[Math.floor(Math.random() * (far.length || stops.length))], from: null, time: 0, pay: 0 };
  };
  newPickup();
  // The first job is close and obvious.
  job.at = stops.find((s) => s.key === "hall") ?? job.at;

  /* ------------------------------------------------------------ input */
  const onKey = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (e.type === "keydown") {
      if (!keys.has(k)) {
        if (k === "f" || k === "e" || k === "Enter") once.use = true;
        if (k === " ") once.jump = true;
        if (k === "t") api.press("time");
        if (k === "g") api.press("fog");
        if (k === "r") api.press("reset");
      }
      keys.add(k);
      if (k === " " || k.startsWith("Arrow")) e.preventDefault();
    } else keys.delete(k);
  };
  const onBlur = (): void => keys.clear();
  const canvas = renderer.domElement;
  let dragging = false;
  const onDown = (e: PointerEvent): void => {
    if (e.pointerType === "mouse") {
      if (!automated && document.pointerLockElement !== canvas) void canvas.requestPointerLock?.();
      dragging = true;
    }
    audio.start();
  };
  const onUp = (): void => { dragging = false; };
  const onMove = (e: PointerEvent): void => {
    if (e.pointerType !== "mouse") return;
    if (document.pointerLockElement === canvas || dragging) api.look(e.movementX, e.movementY);
  };
  const onWheel = (e: WheelEvent): void => { camDist = clamp(camDist + Math.sign(e.deltaY) * 0.8, 3.5, 22); };
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);
  window.addEventListener("blur", onBlur);
  canvas.addEventListener("pointerdown", onDown);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointermove", onMove);
  canvas.addEventListener("wheel", onWheel, { passive: true });

  /* ------------------------------------------------------------ sound */
  const audio = (() => {
    let ctx: AudioContext | null = null;
    let engine: OscillatorNode | null = null;
    let engineGain: GainNode | null = null;
    let siren: OscillatorNode | null = null;
    let sirenGain: GainNode | null = null;
    let master: GainNode | null = null;
    return {
      start(): void {
        if (ctx || automated) return;
        try {
          const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
          ctx = new AC();
          master = ctx.createGain();
          master.gain.value = muted ? 0 : 0.5;
          master.connect(ctx.destination);
          const lp = ctx.createBiquadFilter();
          lp.type = "lowpass";
          lp.frequency.value = 520;
          engine = ctx.createOscillator();
          engine.type = "sawtooth";
          engineGain = ctx.createGain();
          engineGain.gain.value = 0;
          engine.connect(lp).connect(engineGain).connect(master);
          engine.start();
          siren = ctx.createOscillator();
          siren.type = "triangle";
          sirenGain = ctx.createGain();
          sirenGain.gain.value = 0;
          siren.connect(sirenGain).connect(master);
          siren.start();
        } catch { ctx = null; }
      },
      update(speed: number, inCar: boolean, copNear: number, t: number): void {
        if (!ctx || !engine || !engineGain || !siren || !sirenGain) return;
        const now = ctx.currentTime;
        engine.frequency.setTargetAtTime(48 + Math.abs(speed) * 4.2, now, 0.08);
        engineGain.gain.setTargetAtTime(inCar ? 0.12 + Math.min(Math.abs(speed) / 40, 1) * 0.1 : 0, now, 0.15);
        siren.frequency.setTargetAtTime(660 + Math.sin(t * 5.5) * 220, now, 0.03);
        sirenGain.gain.setTargetAtTime(copNear * 0.07, now, 0.2);
      },
      mute(m: boolean): void { if (master && ctx) master.gain.setTargetAtTime(m ? 0 : 0.5, ctx.currentTime, 0.05); },
      stop(): void { void ctx?.close(); ctx = null; },
    };
  })();

  /* ------------------------------------------------------------ driving */
  const sampleTilt = (c: Car): void => {
    const fx = Math.sin(c.h);
    const fz = Math.cos(c.h);
    const hf = groundAt(c.x + fx * 1.5, c.z + fz * 1.5);
    const hb = groundAt(c.x - fx * 1.5, c.z - fz * 1.5);
    const hl = groundAt(c.x + fz * 0.9, c.z - fx * 0.9);
    const hr = groundAt(c.x - fz * 0.9, c.z + fx * 0.9);
    c.pitch = Math.atan2(hb - hf, 3);
    c.roll = Math.atan2(hl - hr, 1.8);
    c.y = (hf + hb + hl + hr) / 4;
  };

  const drive = (c: Car, dt: number): void => {
    let throttle = 0;
    let steer = 0;
    if (keys.has("w") || keys.has("ArrowUp")) throttle += 1;
    if (keys.has("s") || keys.has("ArrowDown")) throttle -= 1;
    if (keys.has("a") || keys.has("ArrowLeft")) steer += 1;
    if (keys.has("d") || keys.has("ArrowRight")) steer -= 1;
    if (Math.abs(stick.y) > 0.12) throttle = stick.y;
    if (Math.abs(stick.x) > 0.12) steer = -stick.x;
    const brake = keys.has(" ") || held.brake;

    const fx = Math.sin(c.h);
    const fz = Math.cos(c.h);
    let vf = c.vx * fx + c.vz * fz;
    let vl = c.vx * -fz + c.vz * fx;

    const top = 39;
    if (throttle > 0) vf += (vf < 0 ? 26 : 16 * (1 - Math.max(vf, 0) / top)) * throttle * dt;
    else if (throttle < 0) vf += (vf > 0.5 ? 26 : 7 * (1 - Math.min(-vf, 12) / 12)) * throttle * dt;
    // Hills pull on you. This is the whole character of driving here.
    vf += Math.sin(c.pitch) * 9.8 * 0.55 * dt;
    vf -= vf * (0.18 + Math.abs(vf) * 0.006) * dt;
    if (brake) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 22 * dt);
    vl *= Math.exp(-(brake ? 2.4 : 7.5) * dt);

    const grip = vf / (4 + vf * vf * 0.034);
    c.h += steer * grip * 1.35 * dt * (brake ? 1.35 : 1);

    const nfx = Math.sin(c.h);
    const nfz = Math.cos(c.h);
    c.vx = nfx * vf + -nfz * vl;
    c.vz = nfz * vf + nfx * vl;
    c.x += c.vx * dt;
    c.z += c.vz * dt;
    c.speed = vf;
  };

  /** Keep a car out of buildings, off the bridge rail and out of the bay. */
  const contain = (c: Car): boolean => {
    let hit = false;
    const fx = Math.sin(c.h);
    const fz = Math.cos(c.h);
    for (const o of [1.25, -1.25]) {
      const p = { x: c.x + fx * o, z: c.z + fz * o };
      if (resolveCircle(p, 1.15, c.y + 0.5)) {
        hit = true;
        c.x = p.x - fx * o;
        c.z = p.z - fz * o;
      }
    }
    if (onSpan(c.x, c.z) && c.z < GG_Z1 && c.z > GG_Z2) {
      const lim = GG_HALF - 1.3;
      if (Math.abs(c.x - GG_X) > lim) { c.x = GG_X + Math.sign(c.x - GG_X) * lim; hit = true; }
    }
    return hit;
  };

  /* ------------------------------------------------------------ frame */
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const euler = new THREE.Euler(0, 0, 0, "YXZ");
  const sunDir = new THREE.Vector3();
  const cTop = new THREE.Color();
  const cHor = new THREE.Color();
  const DAY_TOP = new THREE.Color(0x2f6fc0), DAY_HOR = new THREE.Color(0xb6d3ea);
  const DUSK_TOP = new THREE.Color(0x3a4f8e), DUSK_HOR = new THREE.Color(0xf2a25e);
  const NIGHT_TOP = new THREE.Color(0x04060d), NIGHT_HOR = new THREE.Color(0x141c2e);
  const FOG_GREY = new THREE.Color(0xc9d0d4);

  let last = performance.now();
  let raf = 0;
  let spawnClock = 0;
  let hudClock = 0;
  let fpsFrames = 0;
  let fpsTime = 0;
  let fps = 60;
  let age = 0;
  let level = 0;
  let disposed = false;
  let time = 0;

  const resize = (): void => {
    const w = mount.clientWidth || window.innerWidth;
    const h = mount.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // A portrait phone keeps a usable field of view across.
    camera.fov = w < h ? 78 : 62;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", resize);
  resize();

  const step = (dt: number): void => {
    time += dt;
    age += dt;
    const f = focus();

    /* ---- use: get in, get out ---- */
    let prompt = "";
    if (driving) {
      if (once.use && Math.abs(driving.speed) < 6) {
        const c = driving;
        c.mode = "parked";
        c.vx = c.vz = 0;
        c.speed = 0;
        player.x = c.x + Math.cos(c.h) * 1.9;
        player.z = c.z - Math.sin(c.h) * 1.9;
        player.y = groundAt(player.x, player.z);
        player.h = c.h;
        driving = null;
      }
    } else {
      let near: Car | null = null;
      let nd = 4.2;
      for (const c of cars) {
        const d = Math.hypot(c.x - player.x, c.z - player.z);
        if (d < nd) { nd = d; near = c; }
      }
      if (near) {
        prompt = near.cop ? "F  take the police car" : "F  drive";
        if (once.use) {
          if (near.cop) addHeat(1.5, "You took a police car");
          else if (near.mode === "ai") addHeat(0.6, "Carjacking");
          near.mode = "player";
          near.free = false;
          near.vx = Math.sin(near.h) * near.speed * 0.5;
          near.vz = Math.cos(near.h) * near.speed * 0.5;
          driving = near;
          lookIdle = 9;
        }
      }
    }

    /* ---- you ---- */
    if (driving) {
      const c = driving;
      drive(c, dt);
      if (contain(c)) {
        const sp = Math.hypot(c.vx, c.vz);
        c.vx *= 0.45;
        c.vz *= 0.45;
        if (sp > 14) say("Ouch.", 1.2);
      }
      sampleTilt(c);
      player.x = c.x; player.z = c.z; player.y = c.y; player.h = c.h;
    } else {
      let mx = 0;
      let mz = 0;
      if (keys.has("w") || keys.has("ArrowUp")) mz += 1;
      if (keys.has("s") || keys.has("ArrowDown")) mz -= 1;
      if (keys.has("d") || keys.has("ArrowRight")) mx += 1;
      if (keys.has("a") || keys.has("ArrowLeft")) mx -= 1;
      if (Math.hypot(stick.x, stick.y) > 0.12) { mx = stick.x; mz = stick.y; }
      const mag = Math.min(1, Math.hypot(mx, mz));
      const run = keys.has("Shift") || held.run || Math.hypot(stick.x, stick.y) > 0.92;
      const sp = (run ? 8.2 : 4.2) * mag;
      if (mag > 0.05) {
        const fx = Math.sin(camYaw);
        const fz = Math.cos(camYaw);
        const wx = (fx * mz + -fz * mx) / (mag || 1);
        const wz = (fz * mz + fx * mx) / (mag || 1);
        player.x += wx * sp * dt;
        player.z += wz * sp * dt;
        player.h += turn(player.h, Math.atan2(wx, wz)) * Math.min(1, dt * 12);
        player.phase += sp * dt * 1.9;
      }
      player.moving = lerp(player.moving, mag > 0.05 ? (run ? 1 : 0.6) : 0, Math.min(1, dt * 10));
      resolveCircle(player, 0.42, player.y);
      for (const c of cars) {
        const dx = player.x - c.x;
        const dz = player.z - c.z;
        const d = Math.hypot(dx, dz);
        if (d < 1.5 && d > 0.01) { player.x = c.x + (dx / d) * 1.5; player.z = c.z + (dz / d) * 1.5; }
      }
      const g = groundAt(player.x, player.z);
      if (once.jump && player.grounded) { player.vy = 6.4; player.grounded = false; }
      player.vy -= 19 * dt;
      player.y += player.vy * dt;
      if (player.y <= g) { player.y = g; player.vy = 0; player.grounded = true; }
      else if (player.y - g > 0.25) player.grounded = false;
    }
    once.use = false;
    once.jump = false;

    // The bay.
    if (heightAt(f.x, f.z) < 0.3 && !onSpan(f.x, f.z)) {
      cash = Math.max(0, cash - 50);
      respawn(lastSafe.x, lastSafe.z, "The bay is cold. Towed out for $50.");
    } else if (Math.abs(f.x) < GRID_X + 8 && Math.abs(f.z) < GRID_Z + 8) lastSafe = { x: f.x, z: f.z };

    /* ---- traffic and police ---- */
    let copNear = 0;
    let copClose = false;
    for (let n = cars.length - 1; n >= 0; n--) {
      const c = cars[n];
      if (c === driving) continue;
      const dp = Math.hypot(c.x - f.x, c.z - f.z);
      if (dp > (c.cop ? 520 : 340) || (c.cop && heat <= 0 && dp > 90)) { cars.splice(n, 1); continue; }
      if (c.cop) { copNear = Math.max(copNear, 1 - dp / 220); if (dp < 6) copClose = true; }
      if (c.mode === "parked") continue;
      if (c.mode === "stun") {
        c.x += c.vx * dt; c.z += c.vz * dt;
        c.vx *= Math.exp(-2.2 * dt); c.vz *= Math.exp(-2.2 * dt);
        c.stun -= dt;
        contain(c);
        sampleTilt(c);
        if (c.stun <= 0) {
          c.mode = "ai";
          const nn = nearestNode(c.x, c.z);
          c.i = nn.i; c.j = nn.j; c.dist = 0; c.speed = 0;
          chooseDir(c);
        }
        continue;
      }

      let want = c.cruise + (c.cop ? heat * 2.2 : 0);
      let targetH: number;
      c.free = c.cop && heat > 0 && dp < 60;
      if (c.free) {
        targetH = Math.atan2(f.x - c.x, f.z - c.z);
        if (dp < 7) want = 3;
      } else {
        c.dist += c.speed * dt;
        const len = segLen(c.dir);
        if (c.dist >= len) {
          c.dist -= len;
          c.i += DX[c.dir];
          c.j += DZ[c.dir];
          chooseDir(c);
        }
        lanePoint(c, c.dist + 7, tmp);
        targetH = Math.atan2(tmp.x - c.x, tmp.z - c.z);
        // If a shove left it well off its lane, drive back rather than orbit.
        if (Math.hypot(tmp.x - c.x, tmp.z - c.z) > 30) { const nn = nearestNode(c.x, c.z); c.i = nn.i; c.j = nn.j; c.dist = 0; }
        if (len - c.dist < 14 || c.dist < 6) want = Math.min(want, c.cop ? 11 : 6.5);
      }
      // Brake for whatever is in the way, unless it is a cop and you are it.
      const fx = Math.sin(c.h);
      const fz = Math.cos(c.h);
      const blocked = (ox: number, oz: number, reach: number): boolean => {
        const ax = ox - c.x;
        const az = oz - c.z;
        const ahead = ax * fx + az * fz;
        return ahead > 0.5 && ahead < reach && Math.abs(ax * -fz + az * fx) < 1.9;
      };
      if (!c.cop || heat <= 0) {
        if (blocked(f.x, f.z, 11)) want = 0;
        else for (const o of cars) if (o !== c && blocked(o.x, o.z, 9)) { want = Math.min(want, o.speed > 0 ? o.speed * 0.8 : 0); break; }
      }
      c.speed += clamp(want - c.speed, -16 * dt, (c.cop ? 9 : 5) * dt);
      c.h += clamp(turn(c.h, targetH), -2.6 * dt, 2.6 * dt);
      c.x += Math.sin(c.h) * c.speed * dt;
      c.z += Math.cos(c.h) * c.speed * dt;
      if (c.free) contain(c);
      sampleTilt(c);
    }

    /* ---- your car against everybody else's ---- */
    if (driving) {
      const c = driving;
      for (const o of cars) {
        if (o === c) continue;
        const dx = o.x - c.x;
        const dz = o.z - c.z;
        const d = Math.hypot(dx, dz);
        if (d > 3.0 || d < 0.01) continue;
        const nx = dx / d;
        const nz = dz / d;
        const closing = (c.vx - (o.mode === "ai" ? Math.sin(o.h) * o.speed : o.vx)) * nx + (c.vz - (o.mode === "ai" ? Math.cos(o.h) * o.speed : o.vz)) * nz;
        const push = (3.0 - d) / 2;
        c.x -= nx * push; c.z -= nz * push;
        o.x += nx * push; o.z += nz * push;
        if (closing > 1.5) {
          o.vx = nx * closing * 0.7 + c.vx * 0.2;
          o.vz = nz * closing * 0.7 + c.vz * 0.2;
          if (o.mode !== "player") { o.mode = "stun"; o.stun = 1.6 + closing * 0.08; }
          c.vx -= nx * closing * 0.6;
          c.vz -= nz * closing * 0.6;
          if (closing > 6) addHeat(o.cop ? 0.8 : 0.4, o.cop ? "You rammed the police" : "Hit and run");
        }
      }
    }

    /* ---- people ---- */
    for (let n = peds.length - 1; n >= 0; n--) {
      const p = peds[n];
      if (p.flung > 0) {
        p.flung -= dt;
        p.vy -= 19 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        const g = heightAt(p.x, p.z);
        if (p.y < g) { p.y = g; p.vx *= 0.5; p.vz *= 0.5; p.vy = 0; }
        if (p.flung <= 0) peds.splice(n, 1);
        continue;
      }
      p.s += p.sign * p.pace * dt;
      p.phase += p.pace * dt * 4;
      pedPlace(p);
      const dp = Math.hypot(p.x - f.x, p.z - f.z);
      if (dp > 190) { peds.splice(n, 1); continue; }
      if (driving && dp < 1.9 && Math.abs(driving.speed) > 4) {
        p.flung = 2.6;
        p.vx = driving.vx * 0.9 + (Math.random() - 0.5) * 3;
        p.vz = driving.vz * 0.9 + (Math.random() - 0.5) * 3;
        p.vy = 4 + Math.abs(driving.speed) * 0.18;
        driving.vx *= 0.9; driving.vz *= 0.9;
        addHeat(1, "You hit somebody");
      }
    }

    /* ---- spawning ---- */
    spawnClock += dt;
    if (spawnClock > 0.12) {
      spawnClock = 0;
      spawnTraffic();
      spawnPed();
    }

    /* ---- heat ---- */
    const cops = cars.filter((c) => c.cop && c !== driving).length;
    if (heat > 0) {
      copClock += dt;
      if (cops < Math.min(MAX_COPS, Math.ceil(heat)) && copClock > 2.2 && cars.length < MAX_CARS - 2) {
        copClock = 0;
        const a = Math.random() * Math.PI * 2;
        const n = nearestNode(f.x + Math.cos(a) * 190, f.z + Math.sin(a) * 190);
        const c = makeCar(n.i, n.j, 0, 0, true);
        chooseDir(c);
        if (Math.hypot(c.x - f.x, c.z - f.z) > 90) cars.push(c);
      }
      if (copNear < 0.45) {
        coolFor += dt;
        if (coolFor > 7) {
          const before = Math.ceil(heat);
          heat = Math.max(0, heat - dt * 0.22);
          if (heat <= 0) { say("You lost them.", 3); cash += 40 * before; save(); }
        }
      } else coolFor = 0;
      const slow = driving ? Math.abs(driving.speed) < 2.5 : true;
      if (copClose && slow) {
        bustFor += dt;
        if (bustFor > 1.8) {
          const fine = Math.min(cash, 100 + Math.ceil(heat) * 60);
          cash -= fine;
          heat = 0;
          bustFor = 0;
          for (let n = cars.length - 1; n >= 0; n--) if (cars[n].cop && cars[n] !== driving) cars.splice(n, 1);
          respawn(SPAWN.x, SPAWN.z, `Busted. That cost you $${fine}.`);
          save();
        }
      } else bustFor = Math.max(0, bustFor - dt);
    }

    /* ---- courier runs and discoveries ---- */
    const jd = Math.hypot(job.at.x - f.x, job.at.z - f.z);
    if (job.stage === "deliver") {
      job.time -= dt;
      if (job.time <= 0) { say("Too slow. The package went cold.", 3.5); newPickup(); }
    }
    if (jd < 8.5) {
      if (job.stage === "pickup") {
        const from = job.at;
        const far = stops.filter((s) => s !== from && Math.hypot(s.x - from.x, s.z - from.z) > 480);
        const to = far[Math.floor(Math.random() * far.length)];
        const dist = Math.abs(to.x - from.x) + Math.abs(to.z - from.z);
        job = { stage: "deliver", at: to, from, time: dist / 11 + 25, pay: Math.round(dist * 0.35 / 10) * 10 + 60 };
        say(`Package for ${to.name}.`, 3.5);
      } else {
        const bonus = Math.round(job.time * 2);
        cash += job.pay + bonus;
        say(`Delivered. $${job.pay} plus $${bonus} for speed.`, 4);
        save();
        newPickup();
      }
    }
    for (const p of PLACES) {
      if (found.has(p.key)) continue;
      if (Math.hypot(p.x - f.x, p.z - f.z) < p.r) {
        found.add(p.key);
        cash += 100;
        say(`Found: ${p.name}. $100.`, 4);
        save();
      }
    }
    if (toastFor > 0) { toastFor -= dt; if (toastFor <= 0) toast = ""; }

    /* ---- the day ---- */
    tod = (tod + dt / 45) % 24;
    const a = ((tod - 6) / 12) * Math.PI;
    sunDir.set(Math.cos(a), Math.sin(a) * 0.92, 0.38).normalize();
    const up = sunDir.y;
    const night = 1 - smooth(-0.14, 0.08, up);
    const dusk = (1 - smooth(0.0, 0.38, Math.abs(up))) * (1 - night * 0.6);
    fogNow = lerp(fogNow, fogWanted, Math.min(1, dt * 0.35));
    cTop.copy(DAY_TOP).lerp(DUSK_TOP, dusk).lerp(NIGHT_TOP, night);
    cHor.copy(DAY_HOR).lerp(DUSK_HOR, dusk).lerp(NIGHT_HOR, night);
    cHor.lerp(color.copy(FOG_GREY).multiplyScalar(1 - night * 0.86), fogNow * 0.7);
    cTop.lerp(cHor, fogNow * 0.55);
    city.skyUniforms.uTop.value.copy(cTop);
    city.skyUniforms.uHorizon.value.copy(cHor);
    city.skyUniforms.uSun.value.copy(sunDir);
    city.skyUniforms.uNight.value = night;
    city.skyUniforms.uSunColor.value.setRGB(1, lerp(0.95, 0.55, dusk), lerp(0.85, 0.25, dusk));
    (scene.fog as THREE.FogExp2).color.copy(cHor);
    (scene.fog as THREE.FogExp2).density = 0.00016 + fogNow * 0.0021;
    shared.uNight.value = night;
    shared.uSky.value.copy(cHor);
    if (up > 0.02) {
      sun.color.setRGB(1, lerp(0.96, 0.62, dusk), lerp(0.9, 0.34, dusk));
      sun.intensity = (0.5 + smooth(0, 0.3, up) * 2.3) * (1 - fogNow * 0.6);
      sun.position.copy(sunDir);
    } else {
      // Moonlight, from somewhere else.
      sun.color.setRGB(0.55, 0.65, 0.9);
      sun.intensity = 0.28 * night;
      sun.position.set(-0.35, 0.8, 0.45);
    }
    // Night here is a city's night: never black, lit from below by its own streets.
    hemi.color.copy(cTop).lerp(cHor, 0.5).lerp(color.setRGB(0.3, 0.38, 0.6), night);
    hemi.groundColor.setRGB(0.42, 0.4, 0.36).lerp(color.setRGB(0.42, 0.32, 0.2), night);
    hemi.intensity = lerp(1.0, 0.8, night) + fogNow * 0.5;
    city.lamps.color.setRGB(0.2 + night * 1.0, 0.19 + night * 0.72, 0.16 + night * 0.36);
    (city.water.material as THREE.MeshStandardMaterial).color.setRGB(0.17, 0.36, 0.47).lerp(cHor, 0.25).multiplyScalar(1 - night * 0.7);
    headlamp.intensity = driving ? night * 60 : 0;

    /* ---- camera ---- */
    lookIdle += dt;
    const wantDist = driving ? Math.max(camDist, 8.5) + Math.abs(driving.speed) * 0.06 : camDist;
    if (driving && lookIdle > 1.4 && Math.abs(driving.speed) > 1.5) {
      const back = driving.speed < -1 ? driving.h + Math.PI : driving.h;
      camYaw += turn(camYaw, back) * Math.min(1, dt * 2.4);
      camPitch = lerp(camPitch, 0.26, Math.min(1, dt * 1.5));
    }
    const tx = player.x;
    const ty = player.y + (driving ? 1.5 : 1.55);
    const tz = player.z;
    const cp = Math.cos(camPitch);
    const bx = -Math.sin(camYaw) * cp;
    const by = Math.sin(camPitch);
    const bz = -Math.cos(camYaw) * cp;
    // Shorten the boom if a building is in the way.
    let d = wantDist;
    for (let k = 1; k <= 6; k++) {
      const s = (wantDist * k) / 6;
      if (insideBox(tx + bx * s, ty + by * s, tz + bz * s)) { d = Math.max(1.2, s - wantDist / 6); break; }
    }
    let cx = tx + bx * d;
    let cy = ty + by * d;
    let cz = tz + bz * d;
    cy = Math.max(cy, groundAt(cx, cz) + 0.6);
    camPos.set(cx, cy, cz);
    // A soft follow in the car, a tight one on foot.
    camera.position.lerp(camPos, age < 0.2 ? 1 : Math.min(1, dt * (driving ? 9 : 14)));
    camera.lookAt(tx, ty, tz);
    cx = camera.position.x; cz = camera.position.z;
    city.sky.position.copy(camera.position);

    // Shadows follow you, snapped so the edges do not crawl.
    const snap = 4;
    const sx = Math.round(tx / snap) * snap;
    const sz = Math.round(tz / snap) * snap;
    sun.target.position.set(sx, player.y, sz);
    sun.position.multiplyScalar(520).add(sun.target.position);
    sun.castShadow = level < 2 && up > 0.05;

    /* ---- write the instances ---- */
    let bars = 0;
    cars.forEach((c, n) => {
      euler.set(c.pitch, c.h, c.roll);
      dummy.position.set(c.x, c.y, c.z);
      dummy.quaternion.setFromEuler(euler);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      carMesh.setMatrixAt(n, dummy.matrix);
      carMesh.setColorAt(n, color.setHex(c.color));
      if (c.cop && bars < MAX_COPS * 2 - 1) {
        const flash = Math.floor(time * 6) % 2 === 0;
        for (const side of [-1, 1]) {
          dummy.position.set(c.x + Math.cos(c.h) * 0.36 * side, c.y + 1.66, c.z - Math.sin(c.h) * 0.36 * side);
          dummy.scale.set(0.5, 1, 1);
          dummy.updateMatrix();
          barMesh.setMatrixAt(bars, dummy.matrix);
          barMesh.setColorAt(bars, (side < 0) === flash ? color.setRGB(3, 0.1, 0.1) : color.setRGB(0.1, 0.3, 3));
          bars++;
        }
      }
    });
    carMesh.count = cars.length;
    carMesh.instanceMatrix.needsUpdate = true;
    if (carMesh.instanceColor) carMesh.instanceColor.needsUpdate = true;
    barMesh.count = bars;
    barMesh.instanceMatrix.needsUpdate = true;
    if (barMesh.instanceColor) barMesh.instanceColor.needsUpdate = true;

    peds.forEach((p, n) => {
      dummy.position.set(p.x, p.y + Math.abs(Math.sin(p.phase)) * 0.05, p.z);
      if (p.flung > 0) euler.set(p.flung * 5, p.h, 1.2);
      else euler.set(0, p.h, Math.sin(p.phase) * 0.05);
      dummy.quaternion.setFromEuler(euler);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      pedMesh.setMatrixAt(n, dummy.matrix);
      pedMesh.setColorAt(n, color.setHex(p.color));
    });
    pedMesh.count = peds.length;
    pedMesh.instanceMatrix.needsUpdate = true;
    if (pedMesh.instanceColor) pedMesh.instanceColor.needsUpdate = true;

    me.visible = !driving;
    if (!driving) {
      me.position.set(player.x, player.y, player.z);
      me.rotation.y = player.h;
      const sw = Math.sin(player.phase) * 0.9 * player.moving;
      legL.rotation.x = sw; legR.rotation.x = -sw;
      armL.rotation.x = -sw * 0.8; armR.rotation.x = sw * 0.8;
    } else {
      const c = driving;
      headlamp.position.set(c.x + Math.sin(c.h) * 1.5, c.y + 1.2, c.z + Math.cos(c.h) * 1.5);
      headlamp.target.position.set(c.x + Math.sin(c.h) * 30, c.y, c.z + Math.cos(c.h) * 30);
    }

    marker.position.set(job.at.x, groundAt(job.at.x, job.at.z), job.at.z);
    const pulse = 0.75 + Math.sin(time * 3) * 0.2;
    ringMat.opacity = pulse;
    const mc = job.stage === "pickup" ? 0xffc83d : 0x4de0a8;
    ringMat.color.setHex(mc);
    beamMat.color.setHex(mc);
    ring.rotation.y = time * 0.6;

    audio.update(driving ? driving.speed : 0, !!driving, heat > 0 ? Math.max(0, copNear) : 0, time);

    /* ---- HUD ---- */
    hudClock += dt;
    if (hudClock > 0.12 && opts.onHud) {
      hudClock = 0;
      const hh = Math.floor(tod);
      const mm = Math.floor((tod - hh) * 60);
      let jobText: string;
      if (job.stage === "pickup") jobText = `Courier work at ${job.at.name}  ·  ${Math.round(jd)} m`;
      else jobText = `Deliver to ${job.at.name}  ·  ${Math.round(jd)} m  ·  $${job.pay}`;
      if (bustFor > 0.3) prompt = "Move, or you are busted";
      opts.onHud({
        cash, heat, speed: driving ? Math.abs(driving.speed) * 3.6 : null, prompt,
        job: jobText, jobTime: job.stage === "deliver" ? job.time : null, toast,
        clock: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
        fps: Math.round(fps), found: found.size, places: PLACES.length,
      });
    }
  };

  const frame = (): void => {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    const raw = (now - last) / 1000;
    last = now;
    const dt = Math.min(raw, 0.05);
    step(dt);
    renderer.render(scene, camera);

    // Measure, and give ground before the game feels slow rather than after.
    fpsFrames++;
    fpsTime += raw;
    if (fpsTime >= 1.5) {
      fps = fpsFrames / fpsTime;
      fpsFrames = 0;
      fpsTime = 0;
      if (age > 5 && fps < 36 && level < 3) {
        level++;
        if (level === 1) pixelRatio = Math.min(pixelRatio, 1);
        if (level === 3) pixelRatio = 0.75;
        renderer.setPixelRatio(pixelRatio);
        resize();
      }
    }
  };

  // Seed the streets so the first frame is not an empty city.
  const mine = makeCar(-3, 0, 1, SPAWN.z - 2, false);
  mine.mode = "parked";
  mine.color = 0xd9a521;
  mine.speed = 0;
  mine.x -= 2.2;
  mine.y = groundAt(mine.x, mine.z);
  sampleTilt(mine);
  cars.push(mine);
  for (let k = 0; k < 60; k++) { spawnTraffic(); spawnPed(); }
  for (const p of peds) pedPlace(p);

  const api: FogCity = {
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      save();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("wheel", onWheel);
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      audio.stop();
      city.dispose();
      [carGeo, carMat, barGeo, barMat, pedGeo, pedMat, ringMat, beamMat, ring.geometry, beam.geometry].forEach((x) => x.dispose());
      me.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose(); });
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      delete (window as unknown as { __fog?: unknown }).__fog;
    },
    setStick(x, y) { stick.x = x; stick.y = y; },
    look(dx, dy) {
      camYaw -= dx * 0.0032;
      camPitch = clamp(camPitch + dy * 0.0026, -0.12, 1.25);
      lookIdle = 0;
    },
    press(action) {
      if (action === "use") once.use = true;
      else if (action === "jump") once.jump = true;
      else if (action === "time") { tod = (tod + 3) % 24; }
      else if (action === "fog") { fogWanted = fogWanted > 0.5 ? 0.08 : 1; say(fogWanted > 0.5 ? "Karl is rolling in." : "The fog is lifting.", 2.5); }
      else if (action === "reset") respawn(focus().x, focus().z, "Back on the street.");
    },
    hold(action, down) { held[action] = down; },
    setMuted(m) { muted = m; audio.mute(m); },
    drawMap(ctx, size) {
      const f = focus();
      const scale = size / 620;
      const X = (x: number): number => size / 2 + (x - f.x) * scale;
      const Z = (z: number): number => size / 2 + (z - f.z) * scale;
      ctx.fillStyle = "#23465a";
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = "#3b4038";
      ctx.fillRect(X(-SHORE_X), Z(SHORE_N), SHORE_X * 2 * scale, 4000 * scale);
      ctx.fillRect(X(-1500), Z(-2900), 3000 * scale, (GG_Z2 + 60 + 2900) * scale);
      const i0 = Math.max(-IMAX, Math.floor((f.x - 330) / BX));
      const i1 = Math.min(IMAX, Math.ceil((f.x + 330) / BX));
      const j0 = Math.max(-JMAX, Math.floor((f.z - 330) / BZ));
      const j1 = Math.min(JMAX, Math.ceil((f.z + 330) / BZ));
      ctx.fillStyle = "#3f6b3a";
      for (let i = i0 - 1; i < i1; i++) for (let j = j0 - 1; j < j1; j++) {
        if (i < -IMAX || j < -JMAX) continue;
        const k = blockKind(i, j);
        if (k === "park" || k === "forest") ctx.fillRect(X(i * BX), Z(j * BZ), BX * scale, BZ * scale);
      }
      ctx.strokeStyle = "#8d9299";
      ctx.lineWidth = Math.max(1.5, ROAD * 2 * scale * 0.7);
      ctx.beginPath();
      for (let i = i0; i <= i1; i++) { ctx.moveTo(X(i * BX), Z(-GRID_Z)); ctx.lineTo(X(i * BX), Z(GRID_Z)); }
      for (let j = j0; j <= j1; j++) { ctx.moveTo(X(-GRID_X), Z(j * BZ)); ctx.lineTo(X(GRID_X), Z(j * BZ)); }
      ctx.stroke();
      ctx.strokeStyle = "#d0553c";
      ctx.beginPath(); ctx.moveTo(X(GG_X), Z(-GRID_Z)); ctx.lineTo(X(GG_X), Z(GG_Z3 - 30)); ctx.stroke();
      const dot = (x: number, z: number, c: string, r: number): void => {
        // Things off the edge are pinned to it, so you can always steer by them.
        const px = clamp(X(x), 6, size - 6);
        const pz = clamp(Z(z), 6, size - 6);
        ctx.fillStyle = c;
        ctx.beginPath(); ctx.arc(px, pz, r, 0, Math.PI * 2); ctx.fill();
      };
      for (const p of PLACES) if (!found.has(p.key)) dot(p.x, p.z, "rgba(255,255,255,0.55)", 2.5);
      for (const c of cars) if (c.cop && c !== driving) dot(c.x, c.z, Math.floor(time * 4) % 2 ? "#ff4b3e" : "#5a8cff", 4);
      dot(job.at.x, job.at.z, job.stage === "pickup" ? "#ffc83d" : "#4de0a8", 5.5);
      ctx.save();
      ctx.translate(size / 2, size / 2);
      ctx.rotate(Math.PI - (driving ? driving.h : player.h));
      ctx.fillStyle = "#ffffff";
      ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(5.5, 6); ctx.lineTo(0, 3); ctx.lineTo(-5.5, 6); ctx.closePath(); ctx.fill();
      ctx.restore();
    },
  };

  // For the scripts that drive this without a person: scripts/fogcity-check.mjs.
  (window as unknown as { __fog?: unknown }).__fog = {
    state: () => ({
      x: player.x, y: player.y, z: player.z, h: player.h, driving: !!driving, speed: driving?.speed ?? 0,
      cars: cars.length, cops: cars.filter((c) => c.cop).length, peds: peds.length, heat, cash, tod, fps, level,
      job: job.stage, jobAt: job.at.key, draws: renderer.info.render.calls, tris: renderer.info.render.triangles,
    }),
    key: (k: string, down: boolean) => { if (down) { if (!keys.has(k)) { if (k === "f") once.use = true; if (k === " ") once.jump = true; } keys.add(k); } else keys.delete(k); },
    teleport: (x: number, z: number, h?: number) => {
      const t = driving ?? player;
      t.x = x; t.z = z; if (h !== undefined) { t.h = h; camYaw = h; }
      if (driving) { driving.vx = driving.vz = 0; }
      player.y = groundAt(x, z); player.vy = 0;
    },
    setTime: (h: number) => { tod = h; },
    setFog: (v: number) => { fogWanted = v; fogNow = v; },
    setCam: (yaw: number, pitch: number, dist: number) => { camYaw = yaw; camPitch = pitch; camDist = dist; lookIdle = 0; },
    heat: (n: number) => addHeat(n, "Test"),
    /** Run the simulation without waiting for frames: n steps of dt. */
    run: (n: number, dt = 1 / 60) => { for (let k = 0; k < n; k++) step(dt); },
    snapshot: () => { renderer.render(scene, camera); return canvas.toDataURL("image/jpeg", 0.9); },
  };

  raf = requestAnimationFrame(frame);
  opts.onReady?.();
  return api;
}
