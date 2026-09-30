/**
 * Venus Rising — the engine.
 *
 * Owns the renderer, the three scenes (the Moon, the transfer, the clouds),
 * the camera, input and the loop. The sim is `VenusSim`; this file only ever
 * reads it, steps it, and eases the picture toward what it says.
 *
 * Phases run in order and every one of them can be skipped:
 *
 *   title    — the utopia, already built, at golden hour. Where this ends up.
 *   moon     — the lunar mass driver, satellites every few seconds, then you.
 *   transfer — everyone else went uphill to Mars. Venus is downhill.
 *   entry    — through the ceiling, into the gap, and pull the cord.
 *   play     — the city.
 */
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { VenusSim, freshSave, writeSave, REVOLUTION, type SimFx, type Tile, type VenusSave } from "../sim";
import { ALL_SLOTS, SLOT, hexToWorld, type Hex, type ModuleId } from "../modules";
import { DESIGN_ALT, UPPER_DECK_ALT, airAt } from "../atmosphere";
import { CityView, Palette } from "./city";
import { Sky, KM } from "./sky";
import { MoonScene, TransferScene } from "./prologue";
import { People } from "./people";
import { buildModule } from "./city";
import { joinSky, decodeLayout, type NetMode, type PeerCity, type SkyNet } from "../net";
import { VenusAudio } from "../audio";

export type Phase = "title" | "moon" | "transfer" | "entry" | "play";

export interface Caption {
  kicker?: string;
  text: string;
  sub?: string;
}

export interface EntryState {
  alt: number;
  tempC: number;
  pressure: number;
  window: boolean;
  deployed: boolean;
  rating?: string;
}

export interface VenusOptions {
  container: HTMLElement;
  save: VenusSave | null;
  muted: boolean;
  onPhase(p: Phase): void;
  onTick(): void;
  onFx(f: SimFx): void;
  onCaption(c: Caption | null): void;
  onEntry(e: EntryState): void;
  onSelect(t: Tile | null): void;
  onFire?(): void;
  net?: { mode: NetMode; room: string };
}

export interface VenusWorld {
  sim: VenusSim;
  readonly phase: Phase;
  readonly speed: number;
  begin(): void;
  skipIntro(): void;
  fire(): void;
  deploy(): void;
  setBuild(id: ModuleId | null): void;
  readonly building: ModuleId | null;
  placeSuggested(): boolean;
  selected(): Tile | null;
  upgradeSelected(): boolean;
  recycleSelected(): void;
  cutSelected(): void;
  deselect(): void;
  dumpBallast(): void;
  setTrim(v: number): boolean;
  choose(i: number): void;
  dismiss(): void;
  setSpeed(n: number): void;
  /** Step outside: first person on the deck. */
  setWalk(on: boolean): void;
  readonly walking: boolean;
  /** For touch: -1..1 forward and sideways, held until set back to 0. */
  walkInput(forward: number, strafe: number): void;
  setMuted(m: boolean): void;
  restart(): void;
  save(): void;
  /** A 1200×630 JPEG of the city with its numbers on it, for sharing. */
  postcard(): string;
  /** Real cities in the same room, riding the same wind. */
  peers(): PeerCity[];
  /** Send some of yours. Returns false if you cannot spare it. */
  gift(peerId: string): boolean;
  dispose(): void;
}

/* ------------------------------------------------------------ helpers */

function detectQuality(renderer: THREE.WebGLRenderer): "high" | "low" {
  const q = new URLSearchParams(location.search).get("quality");
  if (q === "high" || q === "low") return q;
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "";
    if (/swiftshader|llvmpipe|software/i.test(name)) return "low";
  } catch { /* ignore */ }
  return "high";
}

function axialRound(qf: number, rf: number): Hex {
  const sf = -qf - rf;
  let q = Math.round(qf), r = Math.round(rf);
  const s = Math.round(sf);
  const dq = Math.abs(q - qf), dr = Math.abs(r - rf), ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q, r };
}

/** The finished city for the title screen: where all this is going. */
function showcaseTiles(): Tile[] {
  const plan: Array<[ModuleId, number]> = [
    ["core", 3],
    ["dome", 3], ["bladder", 2], ["greenhouse", 2], ["dome", 2], ["jazz", 1], ["bladder", 2],
    ["solar", 2], ["dome", 2], ["harvester", 2], ["bladder", 2], ["ballroom", 1], ["dome", 3],
    ["moxie", 2], ["bladder", 2], ["skyport", 1], ["greenhouse", 2], ["dome", 2], ["solar", 2],
    ["dome", 1], ["bladder", 1], ["still", 1], ["biolab", 1], ["dome", 2], ["solar", 1],
    ["bladder", 2], ["greenhouse", 1], ["nanofab", 1], ["dome", 1], ["bladder", 1], ["solar", 1],
    ["dome", 2], ["jazz", 1], ["bladder", 1], ["greenhouse", 1], ["dome", 1], ["solar", 1],
  ];
  return plan.map(([id, level], i) => ({ ...ALL_SLOTS[i], id, level, built: 0, n: 1000 + i }));
}

const COMPOSITE = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uVignette: { value: 0.9 } },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uVignette; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime) * 43758.5453); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      float v = 1.0 - dot(d, d) * uVignette;
      c.rgb *= v;
      // A warm lift in the shadows: Venus has no black.
      c.rgb = mix(c.rgb, c.rgb * vec3(1.03, 0.99, 0.94) + vec3(0.012, 0.006, 0.0), 0.8);
      c.rgb += (h(vUv * 1000.0) - 0.5) * 0.018;
      gl_FragColor = c;
    }`,
};

/* ------------------------------------------------------------- engine */

export function createVenus(opts: VenusOptions): VenusWorld {
  const { container } = opts;
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  const quality = detectQuality(renderer);
  const pr = quality === "high" ? Math.min(window.devicePixelRatio, 1.75) : 0.6;
  renderer.setPixelRatio(pr);
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = quality === "high";
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.style.touchAction = "none";
  renderer.domElement.style.display = "block";
  container.appendChild(renderer.domElement);

  const aspect = () => container.clientWidth / Math.max(1, container.clientHeight);

  /* -------------------------------------------------- the main scene */
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xf0d8a8, 0.00016);
  const camera = new THREE.PerspectiveCamera(50, aspect(), 0.5, 60000);
  const palette = new Palette();
  const sky = new Sky(palette, quality);
  scene.add(sky.group);

  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.castShadow = quality === "high";
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -260; sc.right = 260; sc.top = 260; sc.bottom = -260; sc.near = 10; sc.far = 1600;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xfff0d0, 0xb07040, 1.0);
  scene.add(hemi);
  const cityGlow = new THREE.PointLight(0xffb070, 0, 600, 1.6);
  cityGlow.position.set(0, 40, 0);
  scene.add(cityGlow);

  const cityRoot = new THREE.Group();
  scene.add(cityRoot);
  const city = new CityView(palette);
  cityRoot.add(city.root);
  const people = new People();
  cityRoot.add(people.group);
  const show = new CityView(palette);
  show.sync(showcaseTiles(), 0);
  scene.add(show.root);

  const shuttles: Array<{ g: THREE.Group; from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number }> = [];
  const shuttleMat = new THREE.MeshStandardMaterial({ color: 0xf6f2ea, roughness: 0.35, metalness: 0.2 });
  const shuttleGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.5, 3.5, 4) });
  const lanterns: Array<{ s: THREE.Sprite; v: THREE.Vector3; t: number }> = [];
  const lanternTex = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const x = c.getContext("2d")!;
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.3, "rgba(255,220,160,0.6)");
    g.addColorStop(1, "rgba(255,160,80,0)");
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  const drops: THREE.Points[] = [];

  /* ----------------------------------------------------- post */
  let composer: EffectComposer | null = null;
  let renderPass: RenderPass | null = null;
  let bloom: UnrealBloomPass | null = null;
  let grade: ShaderPass | null = null;
  if (quality === "high") {
    composer = new EffectComposer(renderer);
    renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);
    bloom = new UnrealBloomPass(new THREE.Vector2(container.clientWidth, container.clientHeight), 0.3, 0.5, 1.6);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    grade = new ShaderPass(COMPOSITE);
    composer.addPass(grade);
  }

  /* -------------------------------------------------- state */
  let sim = new VenusSim(opts.save ?? freshSave());
  let phase: Phase = "title";
  let speed = 1;
  let moon: MoonScene | null = null;
  let transfer: TransferScene | null = null;
  let building: ModuleId | null = null;
  let hover: Hex | null = null;
  let selected: Hex | null = null;
  let time = 0;
  let tickAcc = 0;
  let saveAcc = 0;
  let fallFrom = 0;
  const walk = { on: false, x: 0, z: 0, yaw: 0, pitch: 0.02, fwd: 0, side: 0, bob: 0 };
  const keys = new Set<string>();
  let tileSig = -1;
  /** A script has posed the camera: stop drifting. */
  let held = false;
  let disposed = false;
  const audio = new VenusAudio();
  audio.setMuted(opts.muted);

  // Entry.
  const capsule = new THREE.Group();
  {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(3, 4, 8, 20), shuttleMat);
    capsule.add(body);
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), palette.envelope(0xfff0d8));
    canopy.scale.set(18, 10, 18);
    canopy.position.y = 40;
    canopy.name = "canopy";
    capsule.add(canopy);
    // Shrouds, re-strung every frame to wherever the canopy's rim is.
    const pts = new Float32Array(8 * 2 * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pts, 3));
    const shrouds = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x6a5a4a }));
    shrouds.name = "shrouds";
    shrouds.frustumCulled = false;
    capsule.add(shrouds);
    capsule.visible = false;
    scene.add(capsule);
  }
  let entryY = 0;
  let entryV = 0;
  let deployed = false;
  let deployAt = 0;
  let entryRating = "";

  /* -------------------------------------------------- camera rig */
  const rig = {
    yaw: 0.6, pitch: 0.32, dist: 420,
    tYaw: 0.6, tPitch: 0.32, tDist: 420,
    target: new THREE.Vector3(0, 30, 0),
    tTarget: new THREE.Vector3(0, 30, 0),
    idle: 0,
  };
  const applyRig = (dt: number) => {
    const k = Math.min(1, dt * 5);
    rig.yaw += (rig.tYaw - rig.yaw) * k;
    rig.pitch += (rig.tPitch - rig.pitch) * k;
    rig.dist += (rig.tDist - rig.dist) * k;
    rig.target.lerp(rig.tTarget, k);
    const cp = Math.cos(rig.pitch);
    camera.position.set(
      rig.target.x + Math.sin(rig.yaw) * cp * rig.dist,
      rig.target.y + Math.sin(rig.pitch) * rig.dist,
      rig.target.z + Math.cos(rig.yaw) * cp * rig.dist,
    );
    camera.lookAt(rig.target);
  };

  /* -------------------------------------------------- input */
  const el = renderer.domElement;
  const pointers = new Map<number, { x: number; y: number; sx: number; sy: number }>();
  let pinch0 = 0;
  const ndc = new THREE.Vector2();
  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  function pick(cx: number, cy: number): Hex | null {
    const r = el.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    plane.constant = -cityRoot.position.y;
    const p = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, p)) return null;
    cityRoot.worldToLocal(p);
    const qf = ((Math.sqrt(3) / 3) * p.x - (1 / 3) * p.z) / SLOT;
    const rf = ((2 / 3) * p.z) / SLOT;
    return axialRound(qf, rf);
  }

  function refreshSlots() {
    if (building && phase === "play") {
      const free = sim.freeSlots();
      const h = hover && free.some((f) => f.q === hover!.q && f.r === hover!.r) ? hover : null;
      city.showSlots(free, h);
      city.showGhost(building, h ?? free[0] ?? null);
    } else {
      city.showSlots(null, null);
      city.showGhost(null, null);
    }
  }

  function onDown(e: PointerEvent) {
    audio.start();
    audio.resume();
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch0 = Math.hypot(a.x - b.x, a.y - b.y);
    }
    rig.idle = 0;
  }
  function onMove(e: PointerEvent) {
    const p = pointers.get(e.pointerId);
    if (phase === "play" && building && e.pointerType === "mouse") {
      const h = pick(e.clientX, e.clientY);
      if (!hover || !h || h.q !== hover.q || h.r !== hover.r) { hover = h; refreshSlots(); }
    }
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size === 1 && walk.on) {
      walk.yaw -= dx * 0.004;
      walk.pitch = Math.max(-1.1, Math.min(1.2, walk.pitch - dy * 0.003));
    } else if (pointers.size === 1 && (phase === "play" || phase === "title")) {
      rig.tYaw -= dx * 0.005;
      rig.tPitch = Math.max(0.06, Math.min(1.35, rig.tPitch + dy * 0.004));
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch0 > 0) rig.tDist = Math.max(120, Math.min(1400, rig.tDist * (pinch0 / d)));
      pinch0 = d;
    }
    rig.idle = 0;
  }
  function onUp(e: PointerEvent) {
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (!p) return;
    const moved = Math.hypot(e.clientX - p.sx, e.clientY - p.sy);
    if (moved < 8 && pointers.size === 0) click(e.clientX, e.clientY);
  }
  function click(x: number, y: number) {
    if (phase === "moon") { api.fire(); return; }
    if (phase !== "play" || sim.s.fallen || walk.on) return;
    const h = pick(x, y);
    if (!h) return;
    if (building) {
      const free = sim.freeSlots();
      if (free.some((f) => f.q === h.q && f.r === h.r)) {
        if (sim.build(building, h.q, h.r)) {
          audio.build();
          if (sim.whyNot(building)) building = null;
        }
      } else {
        const t = sim.tileAt(h.q, h.r);
        if (t) select(h);
      }
      hover = null;
      refreshSlots();
      opts.onTick();
      return;
    }
    const t = sim.tileAt(h.q, h.r);
    if (t) { select(h); audio.click(); }
    else select(null);
  }
  function select(h: Hex | null) {
    selected = h;
    city.select(h);
    const t = h ? sim.tileAt(h.q, h.r) ?? null : null;
    opts.onSelect(t);
    if (t) {
      const { x, z } = hexToWorld(t.q, t.r);
      rig.tTarget.set(x * 0.6, 30, z * 0.6);
    }
  }
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    rig.tDist = Math.max(120, Math.min(1400, rig.tDist * Math.exp(e.deltaY * 0.0012)));
    rig.idle = 0;
  }
  function onKeyUp(e: KeyboardEvent) { keys.delete(e.code); }
  function onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement)?.tagName === "INPUT") return;
    keys.add(e.code);
    if (walk.on) {
      if (e.key === "Escape") api.setWalk(false);
      return;
    }
    if (e.key === "Escape") { api.setBuild(null); api.deselect(); }
    if (phase === "moon" && (e.key === " " || e.key === "Enter")) { e.preventDefault(); api.fire(); }
    if (phase === "entry" && (e.key === " " || e.key === "Enter")) { e.preventDefault(); api.deploy(); }
    if (phase === "play") {
      if (e.key === "Enter" && building) api.placeSuggested();
      if (e.key === "q" || e.key === "ArrowLeft") rig.tYaw += 0.25;
      if (e.key === "e" || e.key === "ArrowRight") rig.tYaw -= 0.25;
      if (e.key === "w" || e.key === "ArrowUp") rig.tDist = Math.max(120, rig.tDist * 0.85);
      if (e.key === "s" || e.key === "ArrowDown") rig.tDist = Math.min(1400, rig.tDist * 1.15);
    }
  }
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
  el.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKeyUp);

  const ro = new ResizeObserver(() => {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h);
    composer?.setSize(w, h);
    camera.aspect = aspect();
    camera.updateProjectionMatrix();
    moon?.resize(aspect());
    transfer?.resize(aspect());
  });
  ro.observe(container);

  /* -------------------------------------------------- fx */
  function spawnShuttle(n = 1) {
    const port = sim.s.tiles.find((t) => t.id === "skyport") ?? sim.s.tiles[0];
    const { x, z } = hexToWorld(port.q, port.r);
    for (let i = 0; i < n; i++) {
      const g = new THREE.Group();
      const b = new THREE.Mesh(new THREE.CapsuleGeometry(2.2, 6, 4, 10), shuttleMat);
      g.add(b);
      const f = new THREE.Mesh(new THREE.SphereGeometry(1.6, 8, 6), shuttleGlow);
      f.position.y = -5;
      g.add(f);
      const a = Math.random() * Math.PI * 2;
      const from = new THREE.Vector3(x + Math.cos(a) * 900, sky.ceilY + 40, z + Math.sin(a) * 900);
      const to = new THREE.Vector3(x, port.id === "skyport" ? 8 : 70, z);
      g.position.copy(from);
      cityRoot.add(g);
      shuttles.push({ g, from, to, t: -i * 1.5, dur: 9 });
    }
  }
  function spawnLanterns(n: number) {
    for (let i = 0; i < n; i++) {
      const t = sim.s.tiles[Math.floor(Math.random() * sim.s.tiles.length)];
      const { x, z } = hexToWorld(t.q, t.r);
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: lanternTex, color: new THREE.Color(2.4, 1.6, 0.9), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      s.position.set(x + (Math.random() - 0.5) * 20, 12, z + (Math.random() - 0.5) * 20);
      s.scale.setScalar(5 + Math.random() * 3);
      cityRoot.add(s);
      lanterns.push({ s, v: new THREE.Vector3((Math.random() - 0.5) * 3, 6 + Math.random() * 6, (Math.random() - 0.5) * 3), t: 0 });
    }
  }
  function spawnDrops() {
    const n = 600;
    const pos = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    const src = sim.s.tiles.filter((t) => t.id === "still" || t.id === "core");
    for (let i = 0; i < n; i++) {
      const t = src[i % src.length];
      const { x, z } = hexToWorld(t.q, t.r);
      pos.set([x + (Math.random() - 0.5) * 10, -4, z + (Math.random() - 0.5) * 10], i * 3);
      vel.set([(Math.random() - 0.5) * 8, -10 - Math.random() * 25, (Math.random() - 0.5) * 8], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const p = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xbfe8ff, size: 1.4, transparent: true, opacity: 0.8, depthWrite: false }));
    p.userData.vel = vel;
    p.userData.t = 0;
    cityRoot.add(p);
    drops.push(p);
  }

  function handleFx(f: SimFx) {
    switch (f.kind) {
      case "built": city.sync(sim.s.tiles, time); break;
      case "fell": city.sync(sim.s.tiles, time); if (f.reason === "cut") audio.fall(); break;
      case "arrival": if (Math.random() < 0.5) spawnShuttle(1); break;
      case "shipment": spawnShuttle(2); audio.whoosh(); break;
      case "party": spawnLanterns(36); audio.chime(); break;
      case "ballast": spawnDrops(); audio.ballast(); break;
      case "milestone": audio.milestone(); if (lanterns.length < 40) spawnLanterns(14); break;
      case "fallen": fallFrom = sim.s.alt; audio.fall(); select(null); building = null; refreshSlots(); break;
      case "won": spawnLanterns(90); audio.milestone(); break;
      default: break;
    }
    opts.onFx(f);
  }

  /* -------------------------------------------------- phases */
  function setPhase(p: Phase) {
    if (p !== "title") camera.clearViewOffset();
    phase = p;
    opts.onPhase(p);
  }

  function beginPlay(fresh: boolean) {
    capsule.visible = false;
    show.root.visible = false;
    cityRoot.visible = true;
    city.sync(sim.s.tiles, fresh ? time : 0);
    rig.tYaw = rig.yaw = 0.9;
    rig.tPitch = 0.34;
    rig.tDist = sim.s.tiles.length > 12 ? 520 : 300;
    rig.tTarget.set(0, 30, 0);
    setPhase("play");
    opts.onCaption(null);
    opts.onTick();
  }

  const MOON_CAPTIONS: Array<[number, Caption]> = [
    [0.5, { kicker: "2041 · Mare Imbrium", text: "Everybody is racing to the Moon.", sub: "The lunar mass driver: a maglev railgun that throws a satellite into solar orbit every few seconds, for the price of electricity." }],
    [7.5, { kicker: "Next", text: "Then everybody is racing to Mars.", sub: "Point three eight g. Minus sixty. A tent. Nobody is asking why." }],
  ];
  const TRANSFER_CAPTIONS: Array<[number, Caption]> = [
    [0.2, { kicker: "Earth → Venus", text: "Everyone else went uphill.", sub: "Venus is sunward. You don't climb out to it, you fall toward it." }],
    [5.5, { kicker: "What everyone pictures", text: "462 °C. 92 bar. Venera lasted two hours.", sub: "That's the surface. Nobody is going to the surface." }],
    [10, { kicker: "What nobody pictured", text: "Fifty-four kilometres up: 30 °C and half a bar.", sub: "0.9 g. Twice Earth's sunlight. A coat and a breathing mask. And air floats." }],
  ];
  let capIdx = 0;

  function updateTitle(dt: number) {
    rig.idle += dt;
    if (rig.idle > 2 && !held) rig.tYaw += dt * 0.05;
    applyRig(dt);
    // Frame the city right of centre, so the title has somewhere to sit.
    const w = container.clientWidth, h = container.clientHeight;
    if (w > 760) camera.setViewOffset(w, h, -w * 0.2, -h * 0.04, w, h);
    else camera.clearViewOffset();
    sky.update(dt, time, 0.455, DESIGN_ALT, camera);
    show.update(dt, time, sky.look, sky.deckY);
  }

  function updateEntry(dt: number) {
    // Falling out of the ceiling on a drogue, then the envelope.
    if (!deployed) {
      entryV = Math.max(24, entryV - dt * 9);
      entryY -= entryV * dt;
    } else {
      entryV += (0 - entryV) * Math.min(1, dt * 1.5);
      entryY -= Math.max(0, entryV) * dt;
    }
    const alt = DESIGN_ALT + entryY / KM;
    const canopy = capsule.getObjectByName("canopy")!;
    const open = deployed ? Math.min(1, (time - deployAt) / 1.6) : 0.15;
    canopy.scale.set(4 + open * 30, 2 + open * 14, 4 + open * 30);
    {
      const sh = capsule.getObjectByName("shrouds") as THREE.LineSegments;
      const pos = sh.geometry.attributes.position as THREE.BufferAttribute;
      const R = canopy.scale.x * 0.95;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        pos.setXYZ(i * 2, 0, 4, 0);
        pos.setXYZ(i * 2 + 1, Math.cos(a) * R, canopy.position.y + 1, Math.sin(a) * R);
      }
      pos.needsUpdate = true;
    }
    capsule.position.set(0, entryY, 0);
    capsule.rotation.z = Math.sin(time * 1.3) * 0.05;
    const win = !deployed && alt <= 58.5 && alt >= 55.2;
    if (!deployed && entryY <= 30) {
      entryRating = "Auto-deployed. Cutting it fine.";
      doDeploy();
    }
    const air = airAt(alt);
    opts.onEntry({ alt, tempC: air.tempC, pressure: air.pressure, window: win, deployed, rating: entryRating });
    camera.position.set(Math.sin(time * 0.05) * 90 + 60, entryY + 60, 140);
    camera.lookAt(0, entryY - 20, 0);
    sky.update(dt, time, 0.2, DESIGN_ALT, camera);
    city.update(dt, time, sky.look, sky.deckY);
    if (deployed && time - deployAt > 3.2) {
      beginPlay(true);
    }
  }

  function doDeploy() {
    if (deployed) return;
    deployed = true;
    deployAt = time;
    const alt = DESIGN_ALT + entryY / KM;
    if (!entryRating) {
      const miss = Math.abs(alt - 56.5);
      entryRating = miss < 0.8 ? "Perfect deploy. +40 carbon." : miss < 1.6 ? "Good deploy. +20 carbon." : "Deployed.";
      sim.give({ carbon: miss < 0.8 ? 40 : miss < 1.6 ? 20 : 0 });
    }
    audio.whoosh();
    // The canopy becomes the founding envelope: the spire grows in under it.
    cityRoot.visible = true;
    city.sync(sim.s.tiles, time);
  }

  function updatePlay(dt: number) {
    if (!sim.s.fallen) {
      sim.step(dt * speed);
    } else {
      sim.step(dt);
    }
    for (const f of sim.drain()) handleFx(f);

    const s = sim.s;
    // Belt and braces: anything that edited the tiles without an fx still shows.
    let sig = s.serial * 31 + s.tiles.length;
    for (const t of s.tiles) sig += (t.level ?? 1) * (t.n + 7);
    if (sig !== tileSig) { tileSig = sig; city.sync(s.tiles, time); }
    // The city bobs; when it has fallen it sinks through the floor.
    if (s.fallen) {
      cityRoot.position.y = (s.alt - fallFrom) * KM;
      rig.tTarget.y = Math.max(cityRoot.position.y + 30, sky.deckY + 200);
      rig.tDist = 700;
    } else {
      cityRoot.position.y = Math.sin(time * 0.35) * 0.8;
    }
    rig.idle += dt;
    if (walk.on && !s.fallen) updateWalk(dt);
    else applyRig(dt);
    people.sync(s.tiles, s.pop);
    people.update(dt, time);
    updatePeers(dt);
    const skyAlt = s.fallen ? fallFrom : s.alt;
    sky.update(dt, time, sim.d.dayPhase, skyAlt, camera);
    if (s.fallen) sky.u.uHeat.value = Math.min(1, (fallFrom - s.alt) / 8);
    city.update(dt, time, sky.look, sky.deckY - cityRoot.position.y);

    // Shuttles.
    for (const sh of [...shuttles]) {
      sh.t += dt;
      const k = Math.max(0, Math.min(1, sh.t / sh.dur));
      const e = 1 - Math.pow(1 - k, 3);
      sh.g.visible = sh.t > 0;
      sh.g.position.lerpVectors(sh.from, sh.to, e);
      sh.g.position.y = sh.from.y + (sh.to.y - sh.from.y) * (1 - Math.pow(1 - k, 2));
      if (k >= 1) {
        sh.g.scale.multiplyScalar(Math.exp(-dt * 3));
        if (sh.g.scale.x < 0.05) {
          cityRoot.remove(sh.g);
          shuttles.splice(shuttles.indexOf(sh), 1);
        }
      }
    }
    for (const l of [...lanterns]) {
      l.t += dt;
      l.s.position.addScaledVector(l.v, dt);
      l.v.x += Math.sin(time + l.t) * dt;
      const m = l.s.material as THREE.SpriteMaterial;
      m.opacity = Math.min(1, l.t) * Math.max(0, 1 - l.t / 18);
      if (l.t > 18) { cityRoot.remove(l.s); m.dispose(); lanterns.splice(lanterns.indexOf(l), 1); }
    }
    for (const p of [...drops]) {
      const pos = p.geometry.attributes.position as THREE.BufferAttribute;
      const vel = p.userData.vel as Float32Array;
      p.userData.t += dt;
      for (let i = 0; i < pos.count; i++) {
        vel[i * 3 + 1] -= 9.8 * dt;
        pos.setXYZ(i, pos.getX(i) + vel[i * 3] * dt, pos.getY(i) + vel[i * 3 + 1] * dt, pos.getZ(i) + vel[i * 3 + 2] * dt);
      }
      pos.needsUpdate = true;
      (p.material as THREE.PointsMaterial).opacity = Math.max(0, 0.8 - p.userData.t * 0.2);
      if (p.userData.t > 4) { cityRoot.remove(p); p.geometry.dispose(); (p.material as THREE.Material).dispose(); drops.splice(drops.indexOf(p), 1); }
    }

    audio.jazz = sim.count("jazz") > 0 && !s.fallen;

    tickAcc += dt;
    if (tickAcc > 0.2) { tickAcc = 0; opts.onTick(); }
    saveAcc += dt;
    if (saveAcc > 15 && !s.fallen) { saveAcc = 0; writeSave(sim.snapshot()); }
  }

  function onDeck(x: number, z: number): boolean {
    const h = axialRound(((Math.sqrt(3) / 3) * x - (1 / 3) * z) / SLOT, ((2 / 3) * z) / SLOT);
    if (!sim.tileAt(h.q, h.r)) return false;
    // Inside the hex, with a rail's width to spare.
    const c = hexToWorld(h.q, h.r);
    return Math.hypot(x - c.x, z - c.z) < SLOT * 0.93;
  }

  function updateWalk(dt: number) {
    let f = walk.fwd, st = walk.side;
    if (keys.has("KeyW") || keys.has("ArrowUp")) f += 1;
    if (keys.has("KeyS") || keys.has("ArrowDown")) f -= 1;
    if (keys.has("KeyA") || keys.has("ArrowLeft")) st -= 1;
    if (keys.has("KeyD") || keys.has("ArrowRight")) st += 1;
    const run = keys.has("ShiftLeft") || keys.has("ShiftRight") ? 2.4 : 1;
    const sp = 4.2 * run;
    const fx = -Math.sin(walk.yaw), fz = -Math.cos(walk.yaw);
    const sx = Math.cos(walk.yaw), sz = -Math.sin(walk.yaw);
    const len = Math.hypot(f, st) || 1;
    const mx = ((fx * f + sx * st) / len) * sp * dt * Math.min(1, Math.hypot(f, st));
    const mz = ((fz * f + sz * st) / len) * sp * dt * Math.min(1, Math.hypot(f, st));
    // Slide along the rail rather than stopping dead at it.
    if (onDeck(walk.x + mx, walk.z + mz)) { walk.x += mx; walk.z += mz; }
    else if (onDeck(walk.x + mx, walk.z)) walk.x += mx;
    else if (onDeck(walk.x, walk.z + mz)) walk.z += mz;
    const moving = Math.abs(mx) + Math.abs(mz) > 0.0001;
    if (moving) walk.bob += dt * 9 * run;
    const eye = new THREE.Vector3(walk.x, cityRoot.position.y + 1.72 + (moving ? Math.sin(walk.bob) * 0.035 : 0), walk.z);
    camera.position.copy(eye);
    const dir = new THREE.Vector3(-Math.sin(walk.yaw) * Math.cos(walk.pitch), Math.sin(walk.pitch), -Math.cos(walk.yaw) * Math.cos(walk.pitch));
    camera.lookAt(eye.add(dir));
  }

  function updateLights() {
    const look = sky.look;
    const sd = look.sunDir;
    const up = Math.max(0, sd.y);
    sun.position.copy(sd).multiplyScalar(800).add(new THREE.Vector3(0, cityRoot.position.y, 0));
    sun.target.position.set(0, cityRoot.position.y, 0);
    sun.color.copy(look.sunCol).multiplyScalar(1 / Math.max(0.001, Math.max(look.sunCol.r, look.sunCol.g, look.sunCol.b)));
    sun.intensity = sd.y > -0.05 ? Math.min(2.6, 0.3 + up * 4.5) * Math.max(0.1, Math.max(look.sunCol.r, look.sunCol.g, look.sunCol.b) / 2.4) : 0;
    hemi.color.copy(look.ceiling);
    hemi.groundColor.copy(sky.deckColor);
    hemi.intensity = 0.55 + (1 - look.night) * 0.75;
    cityGlow.intensity = look.night * 900;
    cityGlow.position.y = cityRoot.position.y + 40;
    palette.update(look);
    const fog = scene.fog as THREE.FogExp2;
    fog.color.copy(look.horizon);
    fog.density = sky.u.uFogDensity.value * 1.4;
    renderer.toneMappingExposure = 1.0 + look.night * 0.35;
  }

  /* -------------------------------------------------- loop */
  let last = performance.now();
  let raf = 0;
  function frame(now: number) {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    step(dt);
    render();
  }

  function step(dt: number) {
    time += dt;
    audio.update(dt, sky.heat, sky.look.night, time);
    if (phase === "title") updateTitle(dt);
    else if (phase === "moon" && moon) {
      moon.update(dt);
      while (capIdx < MOON_CAPTIONS.length && moon.t >= MOON_CAPTIONS[capIdx][0]) opts.onCaption(MOON_CAPTIONS[capIdx++][1]);
      if (moon.fired < 0 && moon.t > 16) api.fire();
      if (moon.done) {
        transfer = new TransferScene(aspect());
        capIdx = 0;
        setPhase("transfer");
        moon.dispose();
        moon = null;
      }
    } else if (phase === "transfer" && transfer) {
      transfer.update(dt);
      while (capIdx < TRANSFER_CAPTIONS.length && transfer.t >= TRANSFER_CAPTIONS[capIdx][0]) opts.onCaption(TRANSFER_CAPTIONS[capIdx++][1]);
      if (transfer.progress >= 1) {
        transfer.dispose();
        transfer = null;
        startEntry();
      }
    } else if (phase === "entry") updateEntry(dt);
    else if (phase === "play") updatePlay(dt);
    if (phase === "title" || phase === "entry" || phase === "play") updateLights();
  }

  function startEntry() {
    opts.onCaption({ kicker: "Entry", text: "Pull the cord between 58 and 55 km.", sub: "Too high and it's freezing. Too low and it's an oven. Tap, click or press space." });
    show.root.visible = false;
    cityRoot.visible = false;
    capsule.visible = true;
    deployed = false;
    entryRating = "";
    entryY = (UPPER_DECK_ALT - DESIGN_ALT) * KM - 20;
    entryV = 110;
    setPhase("entry");
  }

  function render() {
    let sc: THREE.Scene = scene, cam: THREE.Camera = camera;
    if (phase === "moon" && moon) { sc = moon.scene; cam = moon.camera; }
    else if (phase === "transfer" && transfer) { sc = transfer.scene; cam = transfer.camera; }
    if (composer && renderPass) {
      renderPass.scene = sc;
      renderPass.camera = cam;
      if (grade) grade.uniforms.uTime.value = time % 100;
      if (bloom) {
        const cloudy = phase === "play" || phase === "title" || phase === "entry";
        bloom.strength = cloudy ? 0.22 + sky.look.night * 0.55 : 0.8;
        bloom.threshold = cloudy ? 1.5 - sky.look.night * 0.7 : 0.9;
      }
      composer.render();
    } else {
      renderer.render(sc, cam);
    }
  }

  /* -------------------------------------------------- neighbours */
  const peerCities = new Map<string, { g: THREE.Group; layout: string; label: THREE.Sprite; a: number; r: number }>();
  const hash = (s: string, k: number) => {
    let h = 2166136261 ^ k;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 10000) / 10000;
  };
  function labelSprite(text: string) {
    const c = document.createElement("canvas");
    c.width = 512; c.height = 96;
    const x = c.getContext("2d")!;
    x.font = "600 44px Georgia, serif";
    x.textAlign = "center";
    x.fillStyle = "rgba(20,10,4,0.45)";
    const w = Math.min(500, x.measureText(text).width + 60);
    x.beginPath();
    x.roundRect?.(256 - w / 2, 10, w, 76, 38);
    x.fill();
    x.fillStyle = "#fff4e0";
    x.fillText(text, 256, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, fog: false }));
    sp.scale.set(180, 34, 1);
    return sp;
  }
  function rebuildPeers() {
    if (!net) return;
    const live = new Set<string>();
    for (const p of net.peers()) {
      live.add(p.id);
      const cur = peerCities.get(p.id);
      if (cur && cur.layout === p.layout) {
        (cur.label.material as THREE.SpriteMaterial).map?.dispose();
        cur.g.remove(cur.label);
        cur.label = labelSprite(`${p.name} · ${p.pop.toLocaleString()}`);
        cur.label.position.y = 240;
        cur.g.add(cur.label);
        continue;
      }
      if (cur) scene.remove(cur.g);
      const g = new THREE.Group();
      for (const t of decodeLayout(p.layout)) {
        const m = buildModule(palette, t.id, t.level, t.q * 31 + t.r * 7 + 11, true);
        const w = hexToWorld(t.q, t.r);
        m.group.position.set(w.x, 0, w.z);
        m.group.traverse((o) => { const mm = o as THREE.Mesh; if (mm.isMesh) { mm.castShadow = false; mm.receiveShadow = false; } });
        g.add(m.group);
      }
      const label = labelSprite(`${p.name} · ${p.pop.toLocaleString()}`);
      label.position.y = 240;
      g.add(label);
      scene.add(g);
      peerCities.set(p.id, { g, layout: p.layout, label, a: hash(p.id, 1) * Math.PI * 2, r: 700 + hash(p.id, 2) * 450 });
    }
    for (const [id, c] of peerCities) {
      if (!live.has(id)) { scene.remove(c.g); peerCities.delete(id); }
    }
  }
  function updatePeers(dt: number) {
    if (!net) return;
    const byId = new Map(net.peers().map((p) => [p.id, p] as const));
    for (const [id, c] of peerCities) {
      const p = byId.get(id);
      c.a += dt * 0.002;
      const dy = p ? Math.max(-500, Math.min(500, (p.alt - sim.s.alt) * KM)) : 0;
      const tx = Math.cos(c.a) * c.r, tz = Math.sin(c.a) * c.r;
      c.g.position.x = tx;
      c.g.position.z = tz;
      c.g.position.y += (cityRoot.position.y + dy - c.g.position.y) * Math.min(1, dt * 0.5);
    }
  }
  const params = new URLSearchParams(location.search);
  const netMode: NetMode = opts.net?.mode ?? ((params.get("net") as NetMode) || "online");
  const net: SkyNet | null = netMode === "off" ? null : joinSky({
    mode: netMode,
    room: opts.net?.room ?? params.get("room") ?? "cytherea",
    describe: () => (phase === "play" && !sim.s.fallen ? { name: sim.s.cityName, pop: sim.s.pop, alt: sim.s.alt, tiles: sim.s.tiles } : null),
    onGift: (from, res) => {
      sim.give(res);
      const what = Object.entries(res).map(([k, v]) => `${Math.round(v as number)} ${k}`).join(" and ");
      opts.onFx({ kind: "toast", text: `${from} sent you ${what}. There is no scarcity up here.`, tone: "good" });
      audio.chime();
      opts.onTick();
    },
    onChange: () => { rebuildPeers(); opts.onTick(); },
  });

  raf = requestAnimationFrame(frame);

  /* -------------------------------------------------- api */
  const api: VenusWorld = {
    get sim() { return sim; },
    get phase() { return phase; },
    get speed() { return speed; },
    get building() { return building; },
    begin() {
      audio.start();
      audio.resume();
      moon = new MoonScene(aspect());
      capIdx = 0;
      setPhase("moon");
    },
    skipIntro() {
      audio.start();
      audio.resume();
      moon?.dispose(); moon = null;
      transfer?.dispose(); transfer = null;
      beginPlay(false);
    },
    fire() {
      if (phase !== "moon" || !moon || moon.fired >= 0) return;
      moon.fire();
      audio.massDriver();
      opts.onCaption({ kicker: "Mass driver", text: "Every thousandth launch is a capsule for Venus.", sub: "This one is yours." });
      opts.onFire?.();
    },
    deploy() {
      if (phase === "entry") { doDeploy(); audio.click(); }
    },
    setBuild(id) {
      building = id;
      hover = null;
      if (id) select(null);
      refreshSlots();
    },
    placeSuggested() {
      if (!building) return false;
      const free = sim.freeSlots();
      const at = hover && free.some((f) => f.q === hover!.q && f.r === hover!.r) ? hover : free[0];
      if (!at) return false;
      const ok = sim.build(building, at.q, at.r);
      if (ok) {
        audio.build();
        if (sim.whyNot(building)) building = null;
      }
      hover = null;
      refreshSlots();
      opts.onTick();
      return ok;
    },
    selected() { return selected ? sim.tileAt(selected.q, selected.r) ?? null : null; },
    upgradeSelected() {
      if (!selected) return false;
      const ok = sim.upgrade(selected.q, selected.r);
      if (ok) { audio.build(); select(selected); }
      opts.onTick();
      return ok;
    },
    recycleSelected() {
      if (!selected) return;
      sim.recycle(selected.q, selected.r);
      select(null);
      opts.onTick();
    },
    cutSelected() {
      if (!selected) return;
      sim.cutLoose(selected.q, selected.r);
      select(null);
      opts.onTick();
    },
    deselect() { select(null); rig.tTarget.set(0, 30, 0); },
    dumpBallast() { sim.dumpBallast(); opts.onTick(); },
    setTrim(v) { const ok = sim.setTrim(v); opts.onTick(); return ok; },
    choose(i) { sim.choose(i); audio.click(); for (const f of sim.drain()) handleFx(f); opts.onTick(); },
    dismiss() { sim.dismiss(); opts.onTick(); },
    setSpeed(n) { speed = n; opts.onTick(); },
    get walking() { return walk.on; },
    setWalk(on) {
      if (phase !== "play" || sim.s.fallen) on = false;
      walk.on = on;
      walk.fwd = walk.side = 0;
      if (on) {
        building = null;
        select(null);
        refreshSlots();
        // At the rail on the sunward rim, looking out over the cloud sea:
        // the one view in the game that is not about managing anything.
        const sd = sky.look.sunDir;
        const dx = sd.x, dz = sd.z;
        const n = Math.hypot(dx, dz) || 1;
        let best = sim.s.tiles[0], score = -Infinity;
        for (const t of sim.s.tiles) {
          const c = hexToWorld(t.q, t.r);
          const sc = (c.x * dx + c.z * dz) / n;
          if (sc > score) { score = sc; best = t; }
        }
        const c = hexToWorld(best.q, best.r);
        walk.yaw = Math.atan2(-dx, -dz);
        walk.x = c.x + (dx / n) * SLOT * 0.7;
        walk.z = c.z + (dz / n) * SLOT * 0.7;
        if (!onDeck(walk.x, walk.z)) { walk.x = c.x; walk.z = c.z; }
        walk.pitch = -0.06;
        camera.fov = 70;
      } else {
        camera.fov = 50;
      }
      camera.updateProjectionMatrix();
      opts.onTick();
    },
    walkInput(forward, strafe) { walk.fwd = forward; walk.side = strafe; },
    setMuted(m) { audio.setMuted(m); },
    restart() {
      sim = new VenusSim(freshSave(Math.floor(Math.random() * 1e9), sim.s.cityName));
      writeSave(sim.snapshot());
      cityRoot.position.y = 0;
      city.reset();
      city.sync(sim.s.tiles, time);
      sky.heat = 0;
      select(null);
      building = null;
      refreshSlots();
      beginPlay(true);
    },
    save() { if (!sim.s.fallen) writeSave(sim.snapshot()); },
    peers() { return net ? net.peers() : []; },
    postcard() {
      render();
      const src = renderer.domElement;
      const W = 1200, H = 630;
      const c = document.createElement("canvas");
      c.width = W; c.height = H;
      const x = c.getContext("2d")!;
      // Cover-fit the frame.
      const k = Math.max(W / src.width, H / src.height);
      x.drawImage(src, (W - src.width * k) / 2, (H - src.height * k) / 2, src.width * k, src.height * k);
      const g = x.createLinearGradient(0, H * 0.45, 0, H);
      g.addColorStop(0, "rgba(26,13,8,0)");
      g.addColorStop(1, "rgba(26,13,8,0.82)");
      x.fillStyle = g;
      x.fillRect(0, 0, W, H);
      const s = sim.s;
      x.fillStyle = "#ffe0a8";
      x.font = "600 18px Georgia, serif";
      x.fillText(`GREETINGS FROM VENUS · ${s.alt.toFixed(1)} KM UP · ${sim.d.air.tempC.toFixed(0)} °C`, 48, H - 150);
      x.fillStyle = "#fff6e6";
      x.font = "italic 64px Georgia, serif";
      x.fillText(s.cityName, 44, H - 86);
      x.font = "22px Georgia, serif";
      x.fillStyle = "rgba(255,241,218,0.85)";
      x.fillText(`${Math.round(s.pop).toLocaleString()} people · ${Math.round(s.res.culture).toLocaleString()} culture · Mars: 212, in a tent.`, 48, H - 44);
      return c.toDataURL("image/jpeg", 0.9);
    },
    gift(peerId) {
      if (!net || sim.s.res.carbon < 40) return false;
      sim.give({ carbon: -40 });
      net.gift(peerId, { carbon: 40 });
      audio.chime();
      opts.onTick();
      return true;
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      if (phase === "play" && !sim.s.fallen) writeSave(sim.snapshot());
      moon?.dispose();
      transfer?.dispose();
      net?.close();
      city.dispose();
      people.dispose();
      show.dispose();
      sky.dispose();
      palette.dispose();
      lanternTex.dispose();
      shuttleMat.dispose();
      shuttleGlow.dispose();
      audio.dispose();
      composer?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      if ((window as unknown as { __venus?: unknown }).__venus) delete (window as unknown as { __venus?: unknown }).__venus;
    },
  };

  /* -------------------------------------------------- debug hooks */
  (window as unknown as { __venus: unknown }).__venus = {
    api,
    get sim() { return sim; },
    get phase() { return phase; },
    quality,
    /** Render one frame and hand it back as a JPEG data URL. */
    snapshot(q = 0.85) {
      render();
      return renderer.domElement.toDataURL("image/jpeg", q);
    },
    /** Advance everything by `sec`, in fixed slices, without drawing. */
    settle(sec: number, slice = 1 / 15) {
      for (let t = 0; t < sec; t += slice) step(slice);
    },
    /** Put the sun where you want it: 0.25 is noon, 0.5 sunset, 0.75 midnight. */
    day(phaseOfDay: number) {
      const want = ((phaseOfDay - 0.07) % 1 + 1) % 1;
      sim.s.t = Math.floor(sim.s.t / REVOLUTION) * REVOLUTION + want * REVOLUTION;
      sim.derive();
    },
    view(yaw: number, pitch: number, dist: number, tx = 0, ty = 30, tz = 0) {
      held = true;
      rig.yaw = rig.tYaw = yaw;
      rig.pitch = rig.tPitch = pitch;
      rig.dist = rig.tDist = dist;
      rig.target.set(tx, ty, tz);
      rig.tTarget.set(tx, ty, tz);
      applyRig(1);
    },
    /** Skip straight to a phase. */
    go(p: Phase) {
      if (p === "moon") api.begin();
      else if (p === "transfer") { transfer = new TransferScene(aspect()); capIdx = 0; setPhase("transfer"); }
      else if (p === "entry") startEntry();
      else if (p === "play") api.skipIntro();
    },
    counts() {
      return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, programs: renderer.info.programs?.length };
    },
    sky,
    scene,
    /** Put the walker somewhere, facing somewhere: yaw in radians, pitch up. */
    walkTo(pitch: number, dist: number, yaw: number) {
      walk.yaw = yaw;
      walk.pitch = pitch;
      walk.x = -Math.sin(yaw) * dist;
      walk.z = -Math.cos(yaw) * dist;
      if (!onDeck(walk.x, walk.z)) { walk.x = 0; walk.z = SLOT * 0.78; }
    },
    moon() { return moon; },
    transfer() { return transfer; },
  };

  return api;
}
