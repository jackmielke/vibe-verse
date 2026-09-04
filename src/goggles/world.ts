/**
 * The Half-Blind Triathlon: the engine.
 *
 * Lake Chelan on the morning of September 6, 2025, through goggles that
 * fogged on the first stroke. One scene holds all three legs: the lake and
 * its buoys and kayaks, a loop of road through dry gold hills behind it, and
 * the shore path the run goes out and back on. The camera is the only thing
 * that changes between legs.
 *
 * The rules live in `race.ts` and know nothing about three. This file feeds
 * them input, reads the state back, and draws it: the water, the churn of
 * arms, the smoke-softened sun, and the goggle mask, which is DOM rather
 * than a post pass because `backdrop-filter: blur()` is the fog and costs
 * nothing that the renderer has to pay for.
 */
import * as THREE from "three";
import {
  BIKE_LENGTH,
  BUOY_SPACING,
  BUOY_X,
  KAYAK_X,
  LAKE_CZ,
  LAKE_RX,
  LAKE_RZ,
  RUN_LENGTH,
  RUN_TURN,
  SWIM_LENGTH,
  SWIM_TURN,
  bikeAt,
  runAt,
  swimAt,
} from "./course";
import { BREATH_WINDOW, createRace, type Leg, type Pace, type Race, type RaceInput, type RaceState } from "./race";

export interface GogglesTouch {
  steer: number;
  stroke: boolean;
  clear: boolean;
}

export interface GogglesWorld {
  readonly touch: GogglesTouch;
  breathe(): void;
  setPace(p: Pace): void;
  restart(): void;
  dispose(): void;
}

export interface GogglesOptions {
  container: HTMLElement;
  onState: (s: RaceState) => void;
  /**
   * Card capture: the world plays itself. `true` starts mid-swim with a
   * picture's worth of fog; a leg name jumps straight to that leg.
   */
  shot?: boolean | Leg;
}

// ---------------------------------------------------------------------------
// Colours: the lake is deep teal-green, the hills dry gold, the sky peach.
// ---------------------------------------------------------------------------

const SKY_HORIZON = 0xf3cba6;
const SKY_ZENITH = 0xcdc4bb;
const SUN_COLOUR = 0xff8c3a;
const FOG_COLOUR = 0xe6cdb4;
const WATER_SHALLOW = 0x2f8a80;
const WATER_DEEP = 0x145550;

// ---------------------------------------------------------------------------
// Noise, for the hills
// ---------------------------------------------------------------------------

function hash(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}
function noise2(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, y: number): number {
  return noise2(x, y) * 0.55 + noise2(x * 2.1 + 7, y * 2.1 + 3) * 0.28 + noise2(x * 4.3 + 11, y * 4.3 + 5) * 0.17;
}
function smoothstep(a: number, b: number, t: number): number {
  const x = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
}

/** The ground before the road is cut into it. */
function hillHeight(x: number, z: number): number {
  const r = Math.sqrt((x / LAKE_RX) ** 2 + ((z - LAKE_CZ) / LAKE_RZ) ** 2);
  if (r < 1) return -9 * (1 - r * r) - 0.3;
  const shore = smoothstep(1, 1.05, r) * 2.4;
  const rolling = fbm(x / 260, z / 260) * 26 * smoothstep(1.02, 1.3, r);
  const rise = smoothstep(1.2, 2.6, r) * 110;
  return shore + rolling + rise;
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}`;

const SKY_FRAG = `
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uSun;
uniform vec3 uSunColour;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  vec3 col = mix(uHorizon, uZenith, pow(h, 0.5));
  float s = max(dot(d, uSun), 0.0);
  // A soft disc, and a wide warm glow: the sun through wildfire smoke.
  col += uSunColour * (pow(s, 900.0) * 1.6 + pow(s, 60.0) * 0.5 + pow(s, 6.0) * 0.18);
  // Below the horizon is the far shore, which the haze eats.
  col = mix(col, uHorizon, smoothstep(0.0, -0.08, d.y));
  gl_FragColor = vec4(col, 1.0);
}`;

const WATER_VERT = `
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const WATER_FRAG = `
uniform float uTime;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uSky;
uniform vec3 uCam;
varying vec3 vWorld;
#include <fog_pars_fragment>
void main() {
  float w1 = sin(vWorld.x * 0.35 + uTime * 1.3) * sin(vWorld.z * 0.27 - uTime * 0.9);
  float w2 = sin((vWorld.x + vWorld.z) * 0.9 + uTime * 2.1);
  float ripple = 0.5 + 0.5 * (w1 * 0.7 + w2 * 0.3);
  vec3 col = mix(uDeep, uShallow, ripple * 0.55 + 0.15);
  vec3 toCam = uCam - vWorld;
  float dist = length(toCam);
  float grazing = 1.0 - clamp(toCam.y / max(dist, 0.001), 0.0, 1.0);
  col = mix(col, uSky, pow(grazing, 7.0) * 0.55);
  // Sun glitter on the crests, warm.
  col += vec3(1.0, 0.75, 0.45) * pow(ripple, 8.0) * 0.18;
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}`;

// ---------------------------------------------------------------------------
// The goggle mask, as DOM
// ---------------------------------------------------------------------------

interface Mask {
  root: HTMLDivElement;
  fog: HTMLDivElement;
  blotch: HTMLDivElement;
  drips: HTMLDivElement[];
  dip: HTMLDivElement;
  wave: HTMLDivElement;
  ring: HTMLDivElement;
  dot: HTMLDivElement;
  clearBar: HTMLDivElement;
  clearFill: HTMLDivElement;
}

function buildMask(): Mask {
  const root = document.createElement("div");
  root.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:5;overflow:hidden;";

  // Fog on the lens: a blur of what is behind it and a milky wash.
  const fog = document.createElement("div");
  fog.style.cssText = "position:absolute;inset:0;background:rgba(228,238,236,0);";
  root.appendChild(fog);

  // Blotches that thicken with the fog, so it is not one flat wash.
  const blotch = document.createElement("div");
  blotch.style.cssText =
    "position:absolute;inset:0;opacity:0;background:" +
    "radial-gradient(ellipse 30% 40% at 28% 45%, rgba(240,246,244,0.7) 0%, rgba(240,246,244,0) 70%)," +
    "radial-gradient(ellipse 34% 30% at 72% 60%, rgba(240,246,244,0.65) 0%, rgba(240,246,244,0) 70%)," +
    "radial-gradient(ellipse 22% 26% at 50% 25%, rgba(240,246,244,0.5) 0%, rgba(240,246,244,0) 70%)," +
    "radial-gradient(ellipse 40% 22% at 45% 85%, rgba(240,246,244,0.55) 0%, rgba(240,246,244,0) 70%);";
  root.appendChild(blotch);

  // Drips running down the inside of the lens.
  const drips: HTMLDivElement[] = [];
  for (let i = 0; i < 5; i++) {
    const d = document.createElement("div");
    d.style.cssText =
      "position:absolute;width:10px;height:70px;border-radius:50% 50% 45% 45%;opacity:0;" +
      "background:linear-gradient(180deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.35) 60%, rgba(255,255,255,0.6) 100%);";
    root.appendChild(d);
    drips.push(d);
  }

  // The wave you are about to breathe into, rising from the bottom of the lens.
  const wave = document.createElement("div");
  wave.style.cssText =
    "position:absolute;left:0;right:0;bottom:0;height:0;background:linear-gradient(180deg, rgba(40,120,110,0) 0%, rgba(30,110,100,0.55) 30%, rgba(20,80,75,0.85) 100%);";
  root.appendChild(wave);

  // The dip after a mouthful.
  const dip = document.createElement("div");
  dip.style.cssText = "position:absolute;inset:0;background:rgba(6,40,44,0);";
  root.appendChild(dip);

  // The mask itself: two lenses cut out of the dark.
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 1000 560");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
  svg.innerHTML =
    '<defs><filter id="gogglesoft" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="9"/></filter></defs>' +
    '<path fill="rgba(6,12,14,0.96)" fill-rule="evenodd" filter="url(#gogglesoft)" d="M-50,-50 H1050 V610 H-50 Z ' +
    "M262,280 m-236,0 a236,215 0 1,0 472,0 a236,215 0 1,0 -472,0 Z " +
    'M738,280 m-236,0 a236,215 0 1,0 472,0 a236,215 0 1,0 -472,0 Z"/>' +
    '<path fill="none" stroke="rgba(120,150,150,0.35)" stroke-width="6" d="M498,250 q2,-40 4,0 q-2,40 -4,0"/>';
  root.appendChild(svg);

  // The breath: a ring closing on a dot. Breathe when they meet.
  const ring = document.createElement("div");
  ring.style.cssText =
    "position:absolute;left:50%;bottom:9%;width:64px;height:64px;margin-left:-32px;border-radius:50%;border:2px solid rgba(255,255,255,0.8);";
  root.appendChild(ring);
  const dot = document.createElement("div");
  dot.style.cssText =
    "position:absolute;left:50%;bottom:9%;width:64px;height:64px;margin-left:-32px;border-radius:50%;display:flex;align-items:center;justify-content:center;" +
    "font:600 11px/1 system-ui, sans-serif;letter-spacing:0.12em;color:rgba(255,255,255,0.85);";
  dot.textContent = "E";
  root.appendChild(dot);

  // Clearing the goggles: a bar that fills while you tread water.
  const clearBar = document.createElement("div");
  clearBar.style.cssText =
    "position:absolute;left:50%;top:50%;width:220px;height:6px;margin-left:-110px;border-radius:3px;background:rgba(0,0,0,0.4);display:none;";
  const clearFill = document.createElement("div");
  clearFill.style.cssText = "height:100%;width:0;border-radius:3px;background:#fff;";
  clearBar.appendChild(clearFill);
  root.appendChild(clearBar);

  return { root, fog, blotch, drips, dip, wave, ring, dot, clearBar, clearFill };
}

// ---------------------------------------------------------------------------

function canvasText(text: string, bg: string, fg: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 512, 128);
  ctx.fillStyle = fg;
  ctx.font = "bold 72px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 256, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createGogglesWorld(options: GogglesOptions): GogglesWorld {
  const { container, onState, shot = false } = options;

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
  renderer.setClearColor(FOG_COLOUR, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.touchAction = "none";
  const canvas = renderer.domElement;

  const mask = buildMask();
  container.appendChild(mask.root);

  const scene = new THREE.Scene();
  const fog = new THREE.FogExp2(FOG_COLOUR, 0.0018);
  scene.fog = fog;
  const camera = new THREE.PerspectiveCamera(70, (container.clientWidth || 1) / (container.clientHeight || 1), 0.1, 4000);

  const sunDir = new THREE.Vector3(0.35, 0.2, -0.9).normalize();
  const sun = new THREE.DirectionalLight(0xffd0a0, 1.5);
  sun.position.copy(sunDir).multiplyScalar(500);
  scene.add(sun);
  const hemi = new THREE.HemisphereLight(0xe9d5c0, 0x8a7a50, 0.85);
  scene.add(hemi);

  // ---- Sky ------------------------------------------------------------------
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    uniforms: {
      uHorizon: { value: new THREE.Color(SKY_HORIZON) },
      uZenith: { value: new THREE.Color(SKY_ZENITH) },
      uSun: { value: sunDir.clone() },
      uSunColour: { value: new THREE.Color(SUN_COLOUR) },
    },
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(3200, 24, 14), skyMat);
  sky.renderOrder = -10;
  scene.add(sky);

  // ---- Terrain: the lake basin, the shore, the hills, with the road cut in --
  const roadPts: { x: number; z: number; y: number }[] = [];
  for (let s = 0; s <= BIKE_LENGTH; s += 6) {
    const p = bikeAt(s);
    roadPts.push({ x: p.x, z: p.z, y: p.y });
  }
  const groundHeight = (x: number, z: number): number => {
    const hill = hillHeight(x, z);
    let best = 1e9;
    let roadY = 0;
    for (const p of roadPts) {
      const dx = p.x - x;
      const dz = p.z - z;
      if (Math.abs(dx) > 70 || Math.abs(dz) > 70) continue;
      const d = dx * dx + dz * dz;
      if (d < best) {
        best = d;
        roadY = p.y;
      }
    }
    if (best > 70 * 70) return hill;
    const d = Math.sqrt(best);
    const t = smoothstep(9, 65, d);
    return roadY - 0.4 + (hill - roadY + 0.4) * t;
  };

  const TERRAIN_W = 2600;
  const TERRAIN_D = 2800;
  const terrainGeo = new THREE.PlaneGeometry(TERRAIN_W, TERRAIN_D, 120, 128);
  terrainGeo.rotateX(-Math.PI / 2);
  terrainGeo.translate(0, 0, 350);
  {
    const pos = terrainGeo.attributes.position as THREE.BufferAttribute;
    const colours = new Float32Array(pos.count * 3);
    const sand = new THREE.Color(0xd8c48f);
    const gold = new THREE.Color(0xcaa85a);
    const olive = new THREE.Color(0x8f7d3c);
    const pale = new THREE.Color(0xe2cc93);
    const bed = new THREE.Color(0x184f4a);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = groundHeight(x, z);
      pos.setY(i, y);
      if (y < 0) c.copy(bed);
      else if (y < 2.6) c.copy(sand).lerp(gold, y / 2.6);
      else {
        const n = fbm(x / 90 + 3, z / 90 + 9);
        c.copy(gold).lerp(olive, n * 0.7).lerp(pale, smoothstep(40, 120, y) * 0.5);
      }
      colours[i * 3] = c.r;
      colours[i * 3 + 1] = c.g;
      colours[i * 3 + 2] = c.b;
    }
    terrainGeo.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    terrainGeo.computeVertexNormals();
  }
  const terrain = new THREE.Mesh(terrainGeo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  scene.add(terrain);

  // ---- Water -----------------------------------------------------------------
  const waterMat = new THREE.ShaderMaterial({
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uShallow: { value: new THREE.Color(WATER_SHALLOW) },
        uDeep: { value: new THREE.Color(WATER_DEEP) },
        uSky: { value: new THREE.Color(SKY_HORIZON) },
        uCam: { value: new THREE.Vector3() },
      },
    ]),
    fog: true,
    side: THREE.DoubleSide,
  });
  const waterGeo = new THREE.PlaneGeometry(LAKE_RX * 2.4, LAKE_RZ * 2.4, 1, 1);
  waterGeo.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.position.set(0, 0, LAKE_CZ);
  scene.add(water);

  // ---- Swim course: buoys, the turn, kayaks, the churn ---------------------
  const swimGroup = new THREE.Group();
  scene.add(swimGroup);

  const buoyGeo = new THREE.SphereGeometry(2.2, 12, 10);
  const buoyMat = new THREE.MeshLambertMaterial({ color: 0xff5a14, emissive: 0xff3c00, emissiveIntensity: 0.55 });
  const buoyCount = Math.floor(SWIM_TURN / BUOY_SPACING) * 2 + 2;
  const buoys = new THREE.InstancedMesh(buoyGeo, buoyMat, buoyCount);
  const buoyBase: THREE.Vector3[] = [];
  {
    let i = 0;
    for (let s = BUOY_SPACING; s < SWIM_LENGTH; s += BUOY_SPACING) {
      if (Math.abs(s - SWIM_TURN) < 1) continue;
      const p = swimAt(s, BUOY_X);
      buoyBase[i++] = new THREE.Vector3(p.x, 0.6, p.z);
    }
    // The turn buoy, bigger, between the lanes.
    const t = swimAt(SWIM_TURN, 0);
    buoyBase[i++] = new THREE.Vector3(-t.x - 4, 0.9, t.z + 10);
    buoys.count = i;
    // Place them now: an instance nobody has written sits at the origin,
    // which is the beach, at scale one.
    const m = new THREE.Matrix4();
    for (let j = 0; j < i; j++) {
      m.makeScale(j === i - 1 ? 1.9 : 1, j === i - 1 ? 1.9 : 1, j === i - 1 ? 1.9 : 1).setPosition(buoyBase[j]);
      buoys.setMatrixAt(j, m);
    }
    buoys.instanceMatrix.needsUpdate = true;
  }
  swimGroup.add(buoys);

  const kayaks: THREE.Group[] = [];
  const kayakBase: THREE.Vector3[] = [];
  {
    const hullGeo = new THREE.SphereGeometry(1, 10, 6);
    hullGeo.scale(2.0, 0.32, 0.5);
    const paddlerGeo = new THREE.CapsuleGeometry(0.22, 0.5, 3, 6);
    const paddleGeo = new THREE.BoxGeometry(2.2, 0.05, 0.14);
    const colours = [0xffd23f, 0xe8442c, 0x2fa3d8, 0xffd23f, 0xf07a2a, 0xe8442c, 0x2fa3d8, 0xf07a2a];
    for (let k = 0; k < 8; k++) {
      const s = 90 + k * (SWIM_LENGTH - 180) / 7;
      const p = swimAt(s, KAYAK_X + 4);
      const g = new THREE.Group();
      const hull = new THREE.Mesh(hullGeo, new THREE.MeshLambertMaterial({ color: colours[k] }));
      g.add(hull);
      const paddler = new THREE.Mesh(paddlerGeo, new THREE.MeshLambertMaterial({ color: 0x2a2a30 }));
      paddler.position.y = 0.55;
      g.add(paddler);
      const paddle = new THREE.Mesh(paddleGeo, new THREE.MeshLambertMaterial({ color: 0xd9d4c4 }));
      paddle.position.y = 0.75;
      paddle.name = "paddle";
      g.add(paddle);
      g.position.set(p.x, 0.15, p.z);
      g.rotation.y = p.heading + (k % 2 ? 0.4 : -0.3);
      kayakBase.push(g.position.clone());
      kayaks.push(g);
      swimGroup.add(g);
    }
  }

  // Ripple rings that grow when you drift toward the kayak line.
  const rings: THREE.Mesh[] = [];
  {
    const ringGeo = new THREE.RingGeometry(0.8, 1.05, 24);
    ringGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
      m.position.y = 0.06;
      rings.push(m);
      swimGroup.add(m);
    }
  }

  // The churn: arms and splashes around you, thinning as the race spreads out.
  const CHURN = 72;
  const armGeo = new THREE.CapsuleGeometry(0.09, 0.5, 3, 5);
  const armMat = new THREE.MeshLambertMaterial({ color: 0xd9a77c });
  const arms = new THREE.InstancedMesh(armGeo, armMat, CHURN);
  const splashGeo = new THREE.CircleGeometry(0.7, 10);
  splashGeo.rotateX(-Math.PI / 2);
  const splashMat = new THREE.MeshBasicMaterial({ color: 0xeef7f5, transparent: true, opacity: 0.7, depthWrite: false });
  const splashes = new THREE.InstancedMesh(splashGeo, splashMat, CHURN);
  const churnOffsets: { dx: number; dz: number; phase: number; startDx: number }[] = [];
  for (let i = 0; i < CHURN; i++) {
    churnOffsets.push({
      dx: -3.5 - hash(i, 1) * 10,
      startDx: -8 + hash(i, 2) * 16,
      dz: -6 + hash(i, 3) * 30,
      phase: hash(i, 4) * Math.PI * 2,
    });
  }
  {
    // Same again for the churn: hidden until the swim places it.
    const none = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < CHURN; i++) {
      arms.setMatrixAt(i, none);
      splashes.setMatrixAt(i, none);
    }
    arms.instanceMatrix.needsUpdate = true;
    splashes.instanceMatrix.needsUpdate = true;
  }
  swimGroup.add(arms, splashes);

  // ---- The road, the gravel, and the bike ----------------------------------
  const bikeGroup = new THREE.Group();
  scene.add(bikeGroup);

  const ribbon = (at: (s: number) => { x: number; z: number; y: number; heading: number }, length: number, halfWidth: number, lift: number, step: number, colour: number) => {
    const n = Math.floor(length / step) + 1;
    const pos = new Float32Array(n * 2 * 3);
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = Math.min(length, i * step);
      const p = at(s);
      const rx = Math.cos(p.heading);
      const rz = -Math.sin(p.heading);
      pos.set([p.x + rx * halfWidth, p.y + lift, p.z + rz * halfWidth], i * 6);
      pos.set([p.x - rx * halfWidth, p.y + lift, p.z - rz * halfWidth], i * 6 + 3);
      if (i > 0) {
        const a = (i - 1) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: colour, side: THREE.DoubleSide }));
  };
  bikeGroup.add(ribbon(bikeAt, BIKE_LENGTH, 8.5, 0.08, 4, 0xa89a72));
  bikeGroup.add(ribbon(bikeAt, BIKE_LENGTH, 4.6, 0.16, 4, 0x4b4744));
  // A centre line, dashed by being thin and pale.
  bikeGroup.add(ribbon(bikeAt, BIKE_LENGTH, 0.12, 0.2, 4, 0xe6dfc8));

  const bike = new THREE.Group();
  {
    const frameMat = new THREE.MeshLambertMaterial({ color: 0x1f6fd0 });
    const tube = (len: number, x: number, y: number, z: number, rz: number) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, len, 6), frameMat);
      m.position.set(x, y, z);
      m.rotation.z = rz;
      return m;
    };
    bike.add(tube(0.95, 0, 0.88, 0, Math.PI / 2));
    bike.add(tube(0.8, 0.1, 0.55, 0, Math.PI / 4));
    bike.add(tube(0.6, 0.48, 0.65, 0, 0.3));
    bike.add(tube(0.6, -0.45, 0.62, 0, -0.35));
    const wheelGeo = new THREE.TorusGeometry(0.34, 0.03, 6, 20);
    const wheelMat = new THREE.MeshLambertMaterial({ color: 0x111111 });
    const w1 = new THREE.Mesh(wheelGeo, wheelMat);
    w1.position.set(0.5, 0.34, 0);
    const w2 = new THREE.Mesh(wheelGeo, wheelMat);
    w2.position.set(-0.5, 0.34, 0);
    bike.add(w1, w2);
    const rider = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.55, 4, 8), new THREE.MeshLambertMaterial({ color: 0xe8442c }));
    rider.position.set(0.05, 1.35, 0);
    rider.rotation.z = -0.55;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 8), new THREE.MeshLambertMaterial({ color: 0xffffff }));
    head.position.set(0.42, 1.62, 0);
    bike.add(rider, head);
    // Sits on +x heading; the group is turned to the road heading below.
  }
  bikeGroup.add(bike);

  // Trees: dark pines on the hills, orchard rows where the road flattens.
  const treeGeo = new THREE.ConeGeometry(2.2, 7, 6);
  treeGeo.translate(0, 3.5, 0);
  const treeMat = new THREE.MeshLambertMaterial({ color: 0x4d5f34 });
  const TREES = 220;
  const trees = new THREE.InstancedMesh(treeGeo, treeMat, TREES);
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const sc = new THREE.Vector3();
    let placed = 0;
    for (let i = 0; i < TREES; i++) {
      const alongRoad = i < 150;
      let x: number;
      let z: number;
      if (alongRoad) {
        const p = bikeAt(hash(i, 7) * BIKE_LENGTH);
        const side = hash(i, 8) < 0.5 ? -1 : 1;
        const d = 14 + hash(i, 9) * 40;
        x = p.x + Math.cos(p.heading) * side * d;
        z = p.z - Math.sin(p.heading) * side * d;
      } else {
        const p = runAt(hash(i, 10) * RUN_TURN);
        const d = 4 + hash(i, 11) * 30;
        x = p.x + Math.cos(p.heading) * d * 0.4 + (hash(i, 12) - 0.5) * 20;
        z = p.z - Math.sin(p.heading) * d - 6;
      }
      const y = groundHeight(x, z);
      if (y < 1.5) continue;
      const s = 0.7 + hash(i, 13) * 0.8;
      v.set(x, y - 0.2, z);
      sc.set(s, s, s);
      m.compose(v, q, sc);
      trees.setMatrixAt(placed++, m);
    }
    trees.count = placed;
    trees.instanceMatrix.needsUpdate = true;
  }
  scene.add(trees);

  // ---- The shore path, the turnaround, the finish ----------------------------
  const runGroup = new THREE.Group();
  scene.add(runGroup);
  runGroup.add(ribbon((s) => ({ ...runAt(s), y: groundHeight(runAt(s).x, runAt(s).z) }), RUN_TURN, 1.6, 0.15, 4, 0xcbb98a));
  {
    const t = runAt(RUN_TURN);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.4, 1.1, 8), new THREE.MeshLambertMaterial({ color: 0xff6a1a }));
    cone.position.set(t.x, groundHeight(t.x, t.z) + 0.7, t.z);
    runGroup.add(cone);
    // Kilometre posts.
    const postGeo = new THREE.BoxGeometry(0.12, 1.1, 0.12);
    const postMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    for (let km = 1; km <= 4; km++) {
      const p = runAt((km / 10) * RUN_LENGTH);
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(p.x + Math.cos(p.heading) * 2.2, groundHeight(p.x, p.z) + 0.6, p.z - Math.sin(p.heading) * 2.2);
      runGroup.add(post);
    }
    // The finish arch at the beach.
    const f = runAt(RUN_LENGTH);
    const fy = groundHeight(f.x, f.z);
    const archMat = new THREE.MeshLambertMaterial({ color: 0x2a2a30 });
    const rx = Math.cos(f.heading);
    const rz = -Math.sin(f.heading);
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 4.2, 8), archMat);
      post.position.set(f.x + rx * side * 3, fy + 2.1, f.z + rz * side * 3);
      runGroup.add(post);
    }
    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(6.4, 1.3),
      new THREE.MeshBasicMaterial({ map: canvasText("FINISH", "#e8442c", "#ffffff"), side: THREE.DoubleSide }),
    );
    banner.position.set(f.x, fy + 3.7, f.z);
    // The readable side faces the runner coming home, and the finish camera.
    banner.rotation.y = f.heading + Math.PI;
    runGroup.add(banner);
    // Transition: bike racks, a few bikes' worth of colour, on the sand.
    const rackMat = new THREE.MeshLambertMaterial({ color: 0x8a8f96 });
    for (let i = 0; i < 6; i++) {
      const rack = new THREE.Mesh(new THREE.BoxGeometry(6, 0.08, 0.08), rackMat);
      rack.position.set(-8 + (i % 3) * 8, 1.1 + 1.6, -34 - Math.floor(i / 3) * 6);
      runGroup.add(rack);
      const bikes = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.6, 0.3), new THREE.MeshLambertMaterial({ color: [0x1f6fd0, 0xe8442c, 0xffd23f][i % 3] }));
      bikes.position.set(-8 + (i % 3) * 8, 1.1 + 0.9, -34 - Math.floor(i / 3) * 6);
      runGroup.add(bikes);
    }
  }

  // ---- The race ----------------------------------------------------------------
  let race: Race = createRace(shot ? 11 : (Date.now() % 100000) + 1);
  if (shot === true || shot === "swim") {
    race.state.s = 210;
    race.state.fog = 0.25;
  } else if (shot) {
    race.jump(shot);
    if (shot === "bike") race.state.s = 420;
    if (shot === "run") race.state.s = 120;
  }

  const touch: GogglesTouch = { steer: 0, stroke: false, clear: false };
  const keys = new Set<string>();
  let breatheEdge = false;
  let pace: Pace = 2;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    keys.add(e.code);
    if (e.code === "KeyE") breatheEdge = true;
    if (e.code === "Digit1") pace = 1;
    if (e.code === "Digit2") pace = 2;
    if (e.code === "Digit3") pace = 3;
    if (e.code === "KeyR") restart();
    if (e.code === "Space") e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  const onBlur = () => keys.clear();
  const onResize = () => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  window.addEventListener("resize", onResize);

  function restart() {
    race = createRace((Date.now() % 100000) + 1);
    camPos.set(0, 0, 0);
    camSet = false;
  }

  // In shot mode the world swims itself so the capture has something to look at.
  let shotBreathed = false;
  let shotLastPhase = 0;
  const readInput = (): RaceInput => {
    const st = race.state;
    if (shot) {
      const input: RaceInput = { steer: Math.max(-1, Math.min(1, (1 - st.x) * 0.6)), stroke: true, breathe: false, clear: false, pace: 2 };
      if (st.breathPhase < shotLastPhase) shotBreathed = false;
      shotLastPhase = st.breathPhase;
      const dist = Math.min(st.breathPhase, 1 - st.breathPhase);
      if (dist < BREATH_WINDOW * 0.5 && !shotBreathed && !st.waveNext && st.breathPhase > 0.5) {
        input.breathe = true;
        shotBreathed = true;
      }
      if (st.leg === "bike") input.steer = Math.abs(st.curvature) > 0.006 ? Math.sign(st.curvature) : -st.x * 0.5;
      return input;
    }
    let steer = 0;
    if (keys.has("KeyA") || keys.has("ArrowLeft")) steer -= 1;
    if (keys.has("KeyD") || keys.has("ArrowRight")) steer += 1;
    if (touch.steer !== 0) steer = touch.steer;
    const stroke = keys.has("KeyW") || keys.has("Space") || keys.has("ArrowUp") || touch.stroke;
    const clear = keys.has("KeyQ") || touch.clear;
    const breathe = breatheEdge;
    breatheEdge = false;
    return { steer, stroke, breathe, clear, pace };
  };

  // ---- Camera ------------------------------------------------------------------
  const camPos = new THREE.Vector3();
  const camGoal = new THREE.Vector3();
  const look = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  let camSet = false;
  let strokePhase = 0;
  let stridePhase = 0;
  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpV = new THREE.Vector3();
  const tmpS = new THREE.Vector3(1, 1, 1);
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);

  let raf = 0;
  let last = performance.now();
  let stateClock = 0;
  let disposed = false;
  let time = 0;

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    time += dt;

    const input = readInput();
    race.step(input, dt);
    const st = race.state;
    if (shot && st.leg === "swim") st.fog = Math.min(st.fog, 0.3);

    swimGroup.visible = st.leg === "swim" || st.leg === "finish";
    bikeGroup.visible = st.leg !== "swim";
    runGroup.visible = true;
    mask.root.style.display = st.leg === "swim" ? "block" : "none";

    // ---- Swim ----------------------------------------------------------------
    if (st.leg === "swim") {
      fog.density = 0.0026;
      const p = swimAt(st.s, st.x);
      fwd.set(Math.sin(p.heading), 0, Math.cos(p.heading));
      right.crossVectors(fwd, up);
      if (st.speed > 1) strokePhase += dt * (Math.PI * 2) / 0.85;
      const bob = Math.sin(strokePhase) * 0.09 * Math.min(1, st.speed / 6);
      camGoal.set(p.x, 0.36 + bob, p.z);
      const yaw = p.heading + input.steer * 0.22 + Math.sin(strokePhase * 0.5) * 0.06 * Math.min(1, st.speed / 6);
      camera.position.copy(camGoal);
      look.set(camGoal.x + Math.sin(yaw) * 10, 0.2 + Math.sin(strokePhase + 1) * 0.15, camGoal.z + Math.cos(yaw) * 10);
      camera.lookAt(look);
      camera.rotateZ(Math.sin(strokePhase) * 0.05 * Math.min(1, st.speed / 6));

      // Buoys bob.
      for (let i = 0; i < buoys.count; i++) {
        const b = buoyBase[i];
        tmpV.set(b.x, b.y + Math.sin(time * 1.4 + i) * 0.18, b.z);
        tmpS.setScalar(i === buoys.count - 1 ? 1.9 : 1);
        tmpM.compose(tmpV, tmpQ, tmpS);
        buoys.setMatrixAt(i, tmpM);
      }
      buoys.instanceMatrix.needsUpdate = true;

      // Kayaks bob and paddle.
      kayaks.forEach((k, i) => {
        k.position.y = kayakBase[i].y + Math.sin(time * 1.1 + i * 1.7) * 0.1;
        k.rotation.z = Math.sin(time * 0.9 + i) * 0.06;
        const paddle = k.getObjectByName("paddle");
        if (paddle) paddle.rotation.x = Math.sin(time * 1.6 + i) * 0.7;
      });

      // Ripple rings by the nearest kayaks, growing with the splash cue.
      const nearest = [...kayaks]
        .map((k, i) => ({ i, d: k.position.distanceTo(camera.position) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, rings.length);
      rings.forEach((r, j) => {
        const k = kayaks[nearest[j].i];
        const phase = (time * 0.9 + j * 0.37) % 1;
        const size = 1 + phase * (3 + st.splash * 8);
        r.position.set(k.position.x, 0.06, k.position.z);
        r.scale.set(size, 1, size);
        (r.material as THREE.MeshBasicMaterial).opacity = st.splash * (1 - phase) * 0.8;
      });

      // The churn.
      const alive = Math.round(CHURN * st.churn);
      const early = st.s < 70 ? 1 - st.s / 70 : 0;
      for (let i = 0; i < CHURN; i++) {
        if (i >= alive) {
          arms.setMatrixAt(i, hidden);
          splashes.setMatrixAt(i, hidden);
          continue;
        }
        const o = churnOffsets[i];
        const dx = o.dx * (1 - early) + o.startDx * early;
        const dz = o.dz + Math.sin(time * 0.3 + o.phase) * 2;
        const q = swimAt(Math.max(0, st.s + dz), dx);
        const lift = Math.sin(time * 3.2 + o.phase);
        tmpV.set(q.x, 0.1 + lift * 0.45, q.z);
        tmpQ.setFromAxisAngle(right, lift * 0.9);
        tmpS.setScalar(1);
        tmpM.compose(tmpV, tmpQ, tmpS);
        arms.setMatrixAt(i, tmpM);
        tmpV.set(q.x, 0.03, q.z);
        tmpQ.identity();
        tmpS.setScalar(0.6 + Math.abs(lift) * 0.9);
        tmpM.compose(tmpV, tmpQ, tmpS);
        splashes.setMatrixAt(i, tmpM);
      }
      arms.instanceMatrix.needsUpdate = true;
      splashes.instanceMatrix.needsUpdate = true;

      // The lens.
      const f = st.fog;
      mask.fog.style.backdropFilter = `blur(${(f * 16).toFixed(1)}px)`;
      (mask.fog.style as unknown as Record<string, string>).webkitBackdropFilter = `blur(${(f * 16).toFixed(1)}px)`;
      mask.fog.style.background = `rgba(228,238,236,${(f * 0.5).toFixed(3)})`;
      mask.blotch.style.opacity = String(Math.min(1, f * 1.3));
      mask.drips.forEach((d, i) => {
        const y = ((time * (8 + i * 3) + i * 137) % 140) - 20;
        d.style.left = `${18 + i * 16 + (i % 2) * 5}%`;
        d.style.top = `${y}%`;
        d.style.opacity = String(Math.max(0, f - 0.25) * 0.9);
      });
      mask.dip.style.background = `rgba(6,40,44,${(st.dip * 0.8).toFixed(3)})`;
      const waveRise = st.waveNext ? smoothstep(0.45, 1, st.breathPhase) : 0;
      mask.wave.style.height = `${(waveRise * 42).toFixed(1)}%`;
      const closing = 1 - st.breathPhase;
      const size = 64 + closing * 120;
      mask.ring.style.width = `${size}px`;
      mask.ring.style.height = `${size}px`;
      mask.ring.style.marginLeft = `${-size / 2}px`;
      mask.ring.style.bottom = `calc(9% + ${32 - size / 2}px)`;
      const inWindow = Math.min(st.breathPhase, 1 - st.breathPhase) < BREATH_WINDOW;
      const wave = st.breathPhase > 0.5 ? st.waveNext : false;
      mask.ring.style.borderColor = wave ? "rgba(90,220,200,0.9)" : inWindow ? "rgba(255,255,255,1)" : "rgba(255,255,255,0.55)";
      mask.dot.style.background = inWindow ? (wave ? "rgba(60,160,150,0.5)" : "rgba(255,255,255,0.35)") : "rgba(0,0,0,0.25)";
      mask.dot.textContent = wave ? "WAVE" : "E";
      mask.clearBar.style.display = st.clearing ? "block" : "none";
      mask.clearFill.style.width = `${(st.clearProgress * 100).toFixed(1)}%`;
    }

    // ---- Bike --------------------------------------------------------------------
    if (st.leg === "bike") {
      fog.density = 0.0017;
      const p = bikeAt(st.s);
      fwd.set(Math.sin(p.heading), 0, Math.cos(p.heading));
      right.set(Math.cos(p.heading), 0, -Math.sin(p.heading));
      const ahead = bikeAt(Math.min(BIKE_LENGTH, st.s + 3));
      const pitch = Math.atan2(ahead.y - p.y, 3);
      bike.position.set(p.x + right.x * st.x, p.y + 0.12, p.z + right.z * st.x);
      bike.rotation.set(0, p.heading - Math.PI / 2, 0);
      bike.rotateZ(pitch);
      bike.rotateX(-input.steer * 0.35 + (st.wobble > 0 ? Math.sin(time * 30) * 0.25 : 0));
      const wobble = st.wobble > 0 ? Math.sin(time * 25) * 0.3 : 0;
      camGoal.copy(bike.position).addScaledVector(fwd, -7.5).addScaledVector(right, wobble);
      camGoal.y = Math.max(camGoal.y + 2.6, groundHeight(camGoal.x, camGoal.z) + 1.4);
      if (!camSet) {
        camPos.copy(camGoal);
        camSet = true;
      }
      camPos.lerp(camGoal, Math.min(1, dt * 5));
      camera.position.copy(camPos);
      look.copy(bike.position).addScaledVector(fwd, 8).addScaledVector(right, st.x * 0.3);
      look.y += 1.0;
      camera.lookAt(look);
      camera.rotateZ(input.steer * 0.05 + wobble * 0.15);
    }

    // ---- Run ---------------------------------------------------------------------
    if (st.leg === "run") {
      fog.density = 0.002;
      const p = runAt(st.s);
      fwd.set(Math.sin(p.heading), 0, Math.cos(p.heading));
      const cadence = st.walking ? 1.6 : 2.4 + st.pace * 0.35;
      if (st.speed > 0.5) stridePhase += dt * Math.PI * 2 * cadence * 0.5;
      const hard = st.ankle / 100;
      const bob = Math.abs(Math.sin(stridePhase)) * (st.walking ? 0.05 : 0.09 + st.pace * 0.02);
      const jolt = st.walking ? 0 : Math.max(0, Math.sin(stridePhase * 2)) * hard * 0.05;
      camGoal.set(p.x, groundHeight(p.x, p.z) + 1.65 + bob - jolt, p.z);
      camera.position.copy(camGoal);
      look.copy(camGoal).addScaledVector(fwd, 12);
      look.y -= 0.6 + hard * 0.6;
      look.x += Math.sin(stridePhase) * 0.25;
      camera.lookAt(look);
      camera.rotateZ(Math.sin(stridePhase) * (0.015 + hard * 0.04));
      camSet = false;
    }

    // ---- Finish: the beach, from a little way out, slowly ------------------------
    if (st.leg === "finish") {
      fog.density = 0.0016;
      const f = runAt(RUN_LENGTH);
      const a = time * 0.12;
      camGoal.set(f.x + Math.sin(a) * 26, groundHeight(f.x, f.z) + 7, f.z - 22 + Math.cos(a) * 8);
      camera.position.lerp(camGoal, Math.min(1, dt * 2));
      look.set(f.x, groundHeight(f.x, f.z) + 2.5, f.z + 40);
      camera.lookAt(look);
    }

    waterMat.uniforms.uTime.value = time;
    waterMat.uniforms.uCam.value.copy(camera.position);
    sky.position.copy(camera.position);
    renderer.render(scene, camera);

    stateClock += dt;
    if (stateClock > 0.1) {
      stateClock = 0;
      onState({ ...st });
    }
  };
  raf = requestAnimationFrame(tick);

  return {
    touch,
    breathe() {
      breatheEdge = true;
    },
    setPace(p) {
      pace = p;
    },
    restart,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onResize);
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      renderer.dispose();
      renderer.forceContextLoss();
      if (canvas.parentElement === container) container.removeChild(canvas);
      if (mask.root.parentElement === container) container.removeChild(mask.root);
    },
  };
}
