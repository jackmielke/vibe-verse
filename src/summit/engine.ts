/**
 * Vibe Summit: the game loop.
 *
 * One file owns input, every way of getting down the mountain, the Skyway
 * kart, the camera and the HUD. There is no physics engine: the mountain is
 * a heightfield (`world.ts`), the road is a table of frames (`skyway.ts`),
 * and each way of moving is a dozen lines of integration below.
 *
 * Heading convention, as in Fog City: forward is (sin h, cos h) in (x, z), so
 * h = 0 faces +z, which is downhill from the summit toward the village.
 */
import * as THREE from "three";
import { loadCharacterRig, type CharacterRig } from "@/lib/characterRig";
import { findCharacter } from "@/lib/characters";
import { FT, SUMMIT, VILLAGE, buildGrid, groundAt, normalAt, thermalLift, runX } from "./world";
import { buildScenery, type Pad } from "./scenery";
import { buildSky } from "./sky";
import { buildSkyway, ROAD_W, type Frame } from "./skyway";

export type Mode = "walk" | "ski" | "board" | "wingsuit" | "chute" | "paraglider" | "kart" | "fall" | "gondola" | "beam" | "tumble";

export interface SummitHud {
  mode: Mode;
  altFt: number;
  aglFt: number;
  speed: number;
  prompt: string;
  toast: string;
  /** Seconds on the current run, or null when not timing. */
  timer: number | null;
  rings: [number, number] | null;
  lap: [number, number] | null;
  stars: number;
  onDeck: boolean;
  inVillage: boolean;
  results: { title: string; lines: string[] } | null;
  fps: number;
}

export interface Summit {
  dispose(): void;
  setStick(x: number, y: number): void;
  look(dx: number, dy: number): void;
  press(action: "use" | "jump" | "reset" | "skip" | "close"): void;
  hold(action: "jump" | "brake" | "gas", down: boolean): void;
  choose(mode: "ski" | "board" | "wingsuit" | "paraglider" | "skyway"): void;
  travel(where: "summit" | "village" | "skyway"): void;
  setMuted(m: boolean): void;
}

interface Opts {
  charId: string;
  onHud?: (h: SummitHud) => void;
  onReady?: () => void;
}

const G = 9.81;
const wrapAngle = (a: number) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
const damp = (a: number, b: number, k: number, dt: number) => a + (b - a) * (1 - Math.exp(-k * dt));
const BEST_KEY = "summit.best";

function readBest(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(BEST_KEY) ?? "{}"); } catch { return {}; }
}
function writeBest(key: string, v: number): boolean {
  try {
    const b = readBest();
    if (b[key] !== undefined && b[key] <= v) return false;
    b[key] = v;
    localStorage.setItem(BEST_KEY, JSON.stringify(b));
    return true;
  } catch { return false; }
}
const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

export function createSummit(mount: HTMLElement, opts: Opts): Summit {
  // ---- Renderer, scene, camera -------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(mount.clientWidth, mount.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.style.display = "block";
  canvas.style.touchAction = "none";
  mount.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, mount.clientWidth / Math.max(1, mount.clientHeight), 0.5, 16000);
  const sky = buildSky();
  scene.add(sky.group);
  scene.fog = new THREE.Fog(sky.horizon.clone(), 900, 9000);

  const hemi = new THREE.HemisphereLight("#cfe2ff", "#8f9fb8", 0.85);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight("#fff3e0", 2.7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 10; sc.far = 900;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);

  const grid = buildGrid();
  const scenery = buildScenery(grid, scene);
  const skyway = buildSkyway(scene);
  const ground = (x: number, z: number) => groundAt(grid, x, z);
  const nrm = { x: 0, y: 1, z: 0 };

  // ---- Snow in the air ---------------------------------------------------
  const FLAKES = 1400, BOXR = 60;
  const flakePos = new Float32Array(FLAKES * 3);
  for (let i = 0; i < FLAKES * 3; i++) flakePos[i] = (Math.random() - 0.5) * BOXR * 2;
  const flakeGeo = new THREE.BufferGeometry();
  flakeGeo.setAttribute("position", new THREE.BufferAttribute(flakePos, 3));
  const flakeMat = new THREE.PointsMaterial({ color: "#ffffff", size: 0.22, transparent: true, opacity: 0.85, depthWrite: false });
  const flakes = new THREE.Points(flakeGeo, flakeMat);
  flakes.frustumCulled = false;
  scene.add(flakes);

  // ---- The player --------------------------------------------------------
  const body = new THREE.Group(); // at the feet, yawed to the heading
  const pose = new THREE.Group(); // leans and lies down
  pose.position.y = 0.9;
  const inner = new THREE.Group();
  inner.position.y = -0.9;
  pose.add(inner);
  body.add(pose);
  scene.add(body);
  let rig: CharacterRig | null = null;
  const placeholder = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 1.0, 4, 10), new THREE.MeshStandardMaterial({ color: "#ff7ac8" }));
  placeholder.position.y = 0.9;
  placeholder.castShadow = true;
  inner.add(placeholder);
  const spec = findCharacter(opts.charId);
  let disposed = false;
  loadCharacterRig({ url: spec.url, id: spec.id }, { height: 1.8, center: false, castShadow: true })
    .then((r) => {
      if (disposed) { r.dispose(); return; }
      rig = r;
      inner.remove(placeholder);
      inner.add(r.object);
    })
    .catch(() => { /* stay a capsule rather than take the mountain down */ });

  // Gear, each shown in its own mode.
  const gearMat = (c: string) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.45 });
  const skis = new THREE.Group();
  for (const s of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 1.9), gearMat("#ff3b6b"));
    m.position.set(s * 0.16, 0.03, 0.1);
    m.castShadow = true;
    skis.add(m);
  }
  inner.add(skis);
  const board = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.06, 1.6), gearMat("#6b2fb3"));
  board.position.set(0, 0.03, 0);
  board.castShadow = true;
  inner.add(board);
  const wing = new THREE.Mesh(
    (() => {
      const sh = new THREE.Shape();
      sh.moveTo(0, 0.95); sh.lineTo(0.95, 0.25); sh.lineTo(0.2, -0.75); sh.lineTo(-0.2, -0.75); sh.lineTo(-0.95, 0.25); sh.closePath();
      const g = new THREE.ShapeGeometry(sh);
      g.rotateX(Math.PI / 2);
      return g;
    })(),
    new THREE.MeshStandardMaterial({ color: "#ff4d2e", side: THREE.DoubleSide, roughness: 0.5 }),
  );
  wing.castShadow = true;
  // Lying face down, the wing sits flat under the body.
  const wingHolder = new THREE.Group();
  wingHolder.add(wing);
  body.add(wingHolder);
  const canopy = new THREE.Group();
  {
    const R = 4.6, C = 2.8;
    const arc = new THREE.Mesh(
      new THREE.CylinderGeometry(R, R, 1.7, 24, 1, true, Math.PI * 0.68, Math.PI * 0.64),
      new THREE.MeshStandardMaterial({ color: "#ffb21f", side: THREE.DoubleSide, roughness: 0.6 }),
    );
    arc.rotation.x = Math.PI / 2;
    arc.position.y = C;
    arc.castShadow = true;
    canopy.add(arc);
    const lineMat = new THREE.LineBasicMaterial({ color: "#333" });
    const pts: THREE.Vector3[] = [];
    for (const x of [-3.85, -1.8, 1.8, 3.85]) pts.push(new THREE.Vector3(0, 1.4, 0), new THREE.Vector3(x, C + Math.sqrt(R * R - x * x), 0));
    canopy.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
    canopy.position.y = 0.2;
  }
  body.add(canopy);
  const kart = new THREE.Group();
  {
    const shell = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.5, 2.6), new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.3, metalness: 0.2 }));
    shell.position.y = 0.45;
    kart.add(shell);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.35, 0.8), new THREE.MeshStandardMaterial({ color: "#ff4fd8", emissive: "#ff4fd8", emissiveIntensity: 0.4 }));
    nose.position.set(0, 0.45, 1.5);
    kart.add(nose);
    const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.3, 14);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({ color: "#1b1b24" });
    for (const [x, z] of [[-0.95, 0.9], [0.95, 0.9], [-0.95, -0.9], [0.95, -0.9]]) {
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      w.position.set(x, 0.34, z);
      kart.add(w);
    }
    const glowMat = new THREE.MeshBasicMaterial({ color: "#8ff7ff", toneMapped: false });
    const under = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.05, 2.2), glowMat);
    under.position.y = 0.12;
    kart.add(under);
  }
  body.add(kart);
  // A rainbow trail behind the kart.
  const TRAIL = 60;
  const trailPos = new Float32Array(TRAIL * 2 * 3);
  const trailCol = new Float32Array(TRAIL * 2 * 3);
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPos, 3));
  trailGeo.setAttribute("color", new THREE.BufferAttribute(trailCol, 3));
  {
    const idx: number[] = [];
    for (let i = 0; i < TRAIL - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 2, i * 2 + 1, i * 2 + 3);
    trailGeo.setIndex(idx);
  }
  const trail = new THREE.Mesh(trailGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  trail.frustumCulled = false;
  trail.visible = false;
  scene.add(trail);
  const trailPts: THREE.Vector3[] = [];

  // ---- State -------------------------------------------------------------
  const pos = new THREE.Vector3(SUMMIT.x, SUMMIT.y, SUMMIT.z + 6);
  const vel = new THREE.Vector3();
  let mode: Mode = "walk";
  let heading = 0;
  let grounded = true;
  let airTime = 0;
  let spin = 0;
  let tumble = 0;
  let afterTumble: Mode = "walk";
  // Flight
  let V = 0, pitch = 0, bank = 0;
  // Kart, in road space
  let ks = 0, kl = 0, kpsi = 0, kv = 0, kh = 0, kvh = 0, kBoost = 0, kGrounded = true;
  let lap = 1;
  const LAPS = 2;
  let stars = 0;
  let fallT = 0;
  // Rides
  let rideU = 0, rideDir = 1;
  let beamT = 0;
  // Timing
  let runKind: string | null = null;
  let runT = 0;
  let runStarted = false;
  let ringsGot = 0;
  let nextRing = 0;
  let score = 0;
  let topSpeed = 0;
  let results: SummitHud["results"] = null;
  let toast = "";
  let toastT = 0;
  const say = (s: string, t = 2.6) => { toast = s; toastT = t; };

  // Camera
  let camYaw = 0, camPitch = 0.18, lookTimer = 0;
  const camPos = new THREE.Vector3(pos.x, pos.y + 4, pos.z - 10);
  const camLook = new THREE.Vector3().copy(pos);

  // ---- Input -------------------------------------------------------------
  const keys = new Set<string>();
  const stick = { x: 0, y: 0 };
  const held = { jump: false, brake: false, gas: false };
  let usePressed = false, jumpPressed = false;
  const onKey = (e: KeyboardEvent, down: boolean) => {
    if ((e.target as HTMLElement)?.tagName === "INPUT") return;
    const k = e.key.toLowerCase();
    if (down) {
      if (!keys.has(k)) {
        if (k === "e" || k === "enter") usePressed = true;
        if (k === " ") jumpPressed = true;
        if (k === "r") api.press("reset");
        if (k === "1") api.choose("ski");
        if (k === "2") api.choose("board");
        if (k === "3") api.choose("wingsuit");
        if (k === "4") api.choose("paraglider");
        if (k === "5") api.choose("skyway");
        if (k === "escape") results = null;
      }
      keys.add(k);
      if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) e.preventDefault();
    } else keys.delete(k);
  };
  const kd = (e: KeyboardEvent) => onKey(e, true);
  const ku = (e: KeyboardEvent) => onKey(e, false);
  window.addEventListener("keydown", kd);
  window.addEventListener("keyup", ku);
  const axis = () => {
    let x = stick.x, y = stick.y;
    if (keys.has("a") || keys.has("arrowleft")) x -= 1;
    if (keys.has("d") || keys.has("arrowright")) x += 1;
    if (keys.has("w") || keys.has("arrowup")) y += 1;
    if (keys.has("s") || keys.has("arrowdown")) y -= 1;
    return { x: THREE.MathUtils.clamp(x, -1, 1), y: THREE.MathUtils.clamp(y, -1, 1) };
  };
  // Mouse drag to look.
  let dragId: number | null = null, dragX = 0, dragY = 0;
  const pd = (e: PointerEvent) => { if (e.pointerType === "mouse") { dragId = e.pointerId; dragX = e.clientX; dragY = e.clientY; } };
  const pm = (e: PointerEvent) => {
    if (dragId !== e.pointerId) return;
    api.look(e.clientX - dragX, e.clientY - dragY);
    dragX = e.clientX; dragY = e.clientY;
  };
  const pu = (e: PointerEvent) => { if (dragId === e.pointerId) dragId = null; };
  canvas.addEventListener("pointerdown", pd);
  window.addEventListener("pointermove", pm);
  window.addEventListener("pointerup", pu);

  // ---- Audio: wind that follows your speed -------------------------------
  let audio: AudioContext | null = null;
  let windGain: GainNode | null = null, windFilter: BiquadFilterNode | null = null;
  let muted = false;
  const startAudio = () => {
    if (audio) return;
    try {
      audio = new AudioContext();
      const buf = audio.createBuffer(1, audio.sampleRate * 2, audio.sampleRate);
      const d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < d.length; i++) { last = last * 0.97 + (Math.random() * 2 - 1) * 0.03; d[i] = last * 6; }
      const src = audio.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      windFilter = audio.createBiquadFilter();
      windFilter.type = "bandpass";
      windFilter.frequency.value = 400;
      windFilter.Q.value = 0.6;
      windGain = audio.createGain();
      windGain.gain.value = 0;
      src.connect(windFilter).connect(windGain).connect(audio.destination);
      src.start();
    } catch { audio = null; }
  };
  const chime = (f = 880) => {
    if (!audio || muted) return;
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = "triangle";
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.18, audio.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.45);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.5);
  };
  const firstGesture = () => startAudio();
  window.addEventListener("pointerdown", firstGesture, { once: true });
  window.addEventListener("keydown", firstGesture, { once: true });

  // ---- Mode changes ------------------------------------------------------
  const resetRun = (kind: string | null) => {
    runKind = kind;
    runT = 0;
    runStarted = false;
    ringsGot = 0;
    nextRing = 0;
    score = 0;
    topSpeed = 0;
    results = null;
    for (const r of scenery.rings) (r.mesh.material as THREE.MeshBasicMaterial).color.set("#ff8a1f");
  };
  const toWalk = () => {
    mode = "walk";
    vel.set(0, 0, 0);
    grounded = true;
    camYaw = heading;
  };
  const placeOnDeck = (dz = 6) => {
    pos.set(SUMMIT.x, SUMMIT.y, SUMMIT.z + dz);
    heading = 0;
  };
  const launch = (m: "ski" | "board" | "wingsuit" | "paraglider") => {
    resetRun(m);
    results = null;
    if (m === "ski" || m === "board") {
      mode = m;
      if (Math.hypot(pos.x - SUMMIT.x, pos.z - SUMMIT.z) < 60) pos.set(SUMMIT.x, SUMMIT.y, SUMMIT.z + 36);
      pos.y = ground(pos.x, pos.z);
      heading = 0;
      vel.set(0, 0, 3);
      grounded = true;
      say(m === "ski" ? "Skis on. A and D to carve, W to tuck, Space to jump." : "Board strapped. A and D to carve, Space to ollie, spin in the air.");
    } else {
      mode = m;
      pos.set(SUMMIT.x + (m === "wingsuit" ? 8 : 24), SUMMIT.y + 2.5, SUMMIT.z + 48);
      heading = 0;
      V = m === "wingsuit" ? 34 : 11;
      pitch = m === "wingsuit" ? 0.42 : 0;
      bank = 0;
      runStarted = true;
      say(m === "wingsuit"
        ? "Wingsuit! W dives, S flares, A and D turn. Thread the orange rings. Space pulls the chute."
        : "Paraglider. A and D turn, W speeds up, S brakes. Find the sparkles: they lift you.", 4);
    }
    camYaw = heading;
  };
  const toKartStart = () => {
    mode = "kart";
    resetRun("skyway");
    ks = 2; kl = 0; kpsi = 0; kv = 0; kh = 0; kvh = 0; kBoost = 0; kGrounded = true;
    lap = 1;
    stars = 0;
    for (const st of skyway.stars) st.got = false;
    trailPts.length = 0;
    say("The Prism Skyway. W to drive, A and D to steer. Some edges have no rail.", 4);
  };
  const enterRide = (dir: 1 | -1) => {
    mode = "gondola";
    rideDir = dir;
    rideU = dir === 1 ? 0 : 1;
    resetRun(null);
    say("Riding the gondola. Press Skip to jump ahead.");
  };

  // ---- The API the page uses ---------------------------------------------
  const api: Summit = {
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      window.removeEventListener("pointermove", pm);
      window.removeEventListener("pointerup", pu);
      window.removeEventListener("pointerdown", firstGesture);
      window.removeEventListener("keydown", firstGesture);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", pd);
      scenery.dispose();
      skyway.dispose();
      sky.dispose();
      rig?.dispose();
      flakeGeo.dispose();
      flakeMat.dispose();
      trailGeo.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      void audio?.close();
      delete (window as unknown as { __summit?: unknown }).__summit;
    },
    setStick(x, y) { stick.x = x; stick.y = y; },
    look(dx, dy) {
      camYaw -= dx * 0.005;
      camPitch = THREE.MathUtils.clamp(camPitch + dy * 0.004, -0.3, 1.1);
      lookTimer = 2.5;
    },
    press(a) {
      startAudio();
      if (a === "use") usePressed = true;
      else if (a === "jump") jumpPressed = true;
      else if (a === "close") results = null;
      else if (a === "skip") {
        if (mode === "gondola") rideU = rideDir === 1 ? 1 : 0;
        if (mode === "beam") beamT = 99;
      } else if (a === "reset") {
        if (mode === "kart" || mode === "fall" || (runKind === "skyway" && (mode === "wingsuit" || mode === "chute"))) {
          const keepLap = lap, keepT = runT, keepStars = stars, s = ks;
          mode = "kart";
          ks = Math.max(0, s - 60); kl = 0; kpsi = 0; kv = 12; kh = 0; kvh = 0; kGrounded = true;
          runKind = "skyway"; runT = keepT; runStarted = keepT > 0; lap = keepLap; stars = keepStars;
          say("Back on the road.");
        } else if (mode === "walk" || mode === "tumble") {
          placeOnDeck();
          toWalk();
        } else {
          pos.y = ground(pos.x, pos.z);
          toWalk();
        }
      }
    },
    hold(a, down) { held[a] = down; if (a === "jump" && down) jumpPressed = true; },
    choose(m) {
      startAudio();
      if (m === "skyway") {
        mode = "beam";
        beamT = 0;
        resetRun(null);
        placeOnDeck(-6);
        pos.x = SUMMIT.x - 30;
        say("Up the rainbow!");
        return;
      }
      launch(m);
    },
    travel(where) {
      results = null;
      if (where === "summit") { placeOnDeck(); toWalk(); resetRun(null); say("The summit, 5,000 ft. Pick a way down."); }
      else if (where === "village") { pos.set(VILLAGE.x + 30, VILLAGE.y, VILLAGE.z + 40); heading = 0.3; toWalk(); resetRun(null); say("The village, 300 ft."); }
      else if (where === "skyway") api.choose("skyway");
    },
    setMuted(m) { muted = m; },
  };

  // ---- Physics, one fixed step -------------------------------------------
  const f: Frame = { p: new THREE.Vector3(), t: new THREE.Vector3(), r: new THREE.Vector3(), u: new THREE.Vector3(), k: 0 };
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();

  const finishDescent = () => {
    if (!runKind || runKind === "skyway") return;
    const name = { ski: "Skis", board: "Snowboard", wingsuit: "Wingsuit", paraglider: "Paraglider" }[runKind] ?? runKind;
    const t = runT;
    const best = writeBest(runKind, t);
    const lines = [`5,000 ft to 300 ft in ${fmt(t)}`, `Top speed ${Math.round(topSpeed * 3.6)} km/h`];
    if (runKind === "wingsuit") lines.push(`${ringsGot} of ${scenery.rings.length} rings`);
    if (runKind === "ski" || runKind === "board") lines.push(`${Math.round(score)} style points`);
    if (best) lines.push("New personal best!");
    else lines.push(`Your best: ${fmt(readBest()[runKind])}`);
    results = { title: `${name}: down!`, lines };
    chime(660); chime(990);
    runKind = null;
  };

  const inVillage = () => Math.hypot(pos.x - VILLAGE.x, pos.z - VILLAGE.z) < 330;

  const step = (dt: number) => {
    const ax = axis();
    const use = usePressed; usePressed = false;
    const jump = jumpPressed; jumpPressed = false;
    if (runKind && runStarted) runT += dt;

    switch (mode) {
      case "walk": {
        const run = keys.has("shift") || held.gas;
        const sp = run ? 9 : 4.6;
        const fx = Math.sin(camYaw), fz = Math.cos(camYaw);
        const mx = fx * ax.y - fz * ax.x, mz = fz * ax.y + fx * ax.x;
        const m = Math.hypot(mx, mz);
        const tvx = m > 0.05 ? (mx / Math.max(1, m)) * sp : 0, tvz = m > 0.05 ? (mz / Math.max(1, m)) * sp : 0;
        vel.x = damp(vel.x, tvx, 10, dt);
        vel.z = damp(vel.z, tvz, 10, dt);
        if (m > 0.05) heading = wrapAngle(heading + wrapAngle(Math.atan2(mx, mz) - heading) * Math.min(1, dt * 10));
        if (jump && grounded) { vel.y = 6; grounded = false; }
        vel.y -= G * dt;
        pos.addScaledVector(vel, dt);
        const gy = ground(pos.x, pos.z);
        if (pos.y <= gy) { pos.y = gy; vel.y = 0; grounded = true; }
        else if (pos.y - gy > 0.3) grounded = false;
        rig?.setLocomotion(Math.hypot(vel.x, vel.z) / 4.6);
        break;
      }
      case "ski":
      case "board": {
        const isBoard = mode === "board";
        if (grounded) {
          normalAt(grid, pos.x, pos.z, nrm);
          const n = tmpA.set(nrm.x, nrm.y, nrm.z);
          heading = wrapAngle(heading - ax.x * (isBoard ? 1.8 : 1.6) * dt);
          const fwd = tmpB.set(Math.sin(heading), 0, Math.cos(heading));
          fwd.addScaledVector(n, -fwd.dot(n)).normalize();
          const side = tmpC.copy(n).cross(fwd).normalize();
          let along = vel.dot(fwd);
          let lat = vel.dot(side);
          const braking = ax.y < -0.3 || held.brake;
          const tuck = ax.y > 0.3;
          lat *= Math.exp(-(braking ? 2.2 : 7) * dt);
          const mu = braking ? 0.32 : 0.035;
          const fr = mu * G * n.y * dt;
          along = Math.abs(along) <= fr ? 0 : along - Math.sign(along) * fr;
          if (braking) along *= Math.exp(-0.9 * dt);
          const sp = vel.length();
          const kdrag = tuck ? 0.0024 : 0.0042;
          along -= Math.sign(along) * kdrag * along * along * dt;
          if (tuck && sp < 7) along += 2.4 * dt; // skate on the flats
          vel.copy(fwd).multiplyScalar(along).addScaledVector(side, lat);
          // Gravity along the slope.
          vel.x += G * n.y * n.x * dt;
          vel.y += (-G + G * n.y * n.y) * dt;
          vel.z += G * n.y * n.z * dt;
          if (jump) { vel.addScaledVector(n, isBoard ? 5.8 : 5.2); grounded = false; airTime = 0; spin = 0; }
          pos.addScaledVector(vel, dt);
          const gy = ground(pos.x, pos.z);
          if (grounded && pos.y - gy > 0.35) { grounded = false; airTime = 0; spin = 0; }
          else if (grounded) {
            pos.y = gy;
            normalAt(grid, pos.x, pos.z, nrm);
            n.set(nrm.x, nrm.y, nrm.z);
            vel.addScaledVector(n, -vel.dot(n));
          }
          if (!runStarted && Math.hypot(pos.x - SUMMIT.x, pos.z - SUMMIT.z) > 50) runStarted = true;
        } else {
          airTime += dt;
          const dh = ax.x * (isBoard ? 5.5 : 4.5) * dt;
          heading = wrapAngle(heading - dh);
          spin += Math.abs(dh);
          vel.y -= G * dt;
          vel.multiplyScalar(1 - 0.0008 * vel.length() * dt);
          pos.addScaledVector(vel, dt);
          const gy = ground(pos.x, pos.z);
          if (pos.y <= gy) {
            pos.y = gy;
            normalAt(grid, pos.x, pos.z, nrm);
            const n = tmpA.set(nrm.x, nrm.y, nrm.z);
            const travel = Math.atan2(vel.x, vel.z);
            let off = Math.abs(wrapAngle(heading - travel));
            if (isBoard) off = Math.min(off, Math.PI - off);
            const hard = -vel.dot(n);
            vel.addScaledVector(n, -vel.dot(n));
            grounded = true;
            if (vel.length() > 6 && (off > 0.9 || hard > 24)) {
              tumble = 1.4;
              afterTumble = mode;
              mode = "tumble";
              vel.multiplyScalar(0.35);
              say("Wipeout!");
            } else if (airTime > 0.6) {
              const spins = Math.round(spin / (Math.PI * 2)) * 360;
              const pts = Math.round(airTime * 120 + spins * 0.8);
              score += pts;
              chime(880);
              say(`${spins >= 360 ? spins + " · " : ""}${airTime.toFixed(1)} s air · +${pts}`);
            }
            // Realign the skis with where they are actually going after a spin.
            if (vel.length() > 2 && mode !== "tumble") heading = isBoard && off > Math.PI / 2 ? heading : Math.atan2(vel.x, vel.z) * 0.5 + heading * 0.5;
          }
        }
        // Finish line.
        if (runKind && pos.z > VILLAGE.z - 170 && Math.abs(pos.x - runX(VILLAGE.z - 170)) < 400) finishDescent();
        if (inVillage() && vel.length() < 1.2 && grounded && !runKind) { toWalk(); }
        topSpeed = Math.max(topSpeed, vel.length());
        rig?.setLocomotion(0);
        break;
      }
      case "tumble": {
        tumble -= dt;
        vel.multiplyScalar(Math.exp(-2.5 * dt));
        vel.y -= G * dt;
        pos.addScaledVector(vel, dt);
        const gy = ground(pos.x, pos.z);
        if (pos.y < gy) { pos.y = gy; vel.y = 0; }
        if (tumble <= 0) {
          mode = afterTumble === "ski" || afterTumble === "board" ? afterTumble : "walk";
          grounded = true;
          vel.set(Math.sin(heading) * 2, 0, Math.cos(heading) * 2);
          if (mode === "walk") vel.set(0, 0, 0);
        }
        break;
      }
      case "wingsuit": {
        const stalled = V < 21;
        const want = stalled ? 1.15 : THREE.MathUtils.clamp(0.36 + ax.y * 0.5, -0.3, 1.25);
        pitch = damp(pitch, want, 2.2, dt);
        bank = damp(bank, ax.x * 0.95, 3, dt);
        heading = wrapAngle(heading - (G * Math.tan(bank) / Math.max(12, V)) * dt);
        const drag = 0.00102 * V * V + 27.1 * (G * Math.cos(pitch)) ** 2 / Math.max(64, V * V);
        V += (G * Math.sin(pitch) - drag) * dt;
        V = THREE.MathUtils.clamp(V, 6, 95);
        vel.set(Math.cos(pitch) * Math.sin(heading) * V, -Math.sin(pitch) * V, Math.cos(pitch) * Math.cos(heading) * V);
        const prev = tmpA.copy(pos);
        pos.addScaledVector(vel, dt);
        // Rings, in order or out of it.
        for (let i = 0; i < scenery.rings.length; i++) {
          const r = scenery.rings[i];
          const nx = Math.sin(r.yaw), nz = Math.cos(r.yaw);
          const a = (prev.x - r.x) * nx + (prev.z - r.z) * nz;
          const b = (pos.x - r.x) * nx + (pos.z - r.z) * nz;
          if (a <= 0 && b > 0) {
            const t = a / (a - b);
            const px = prev.x + (pos.x - prev.x) * t, py = prev.y + (pos.y - prev.y) * t, pz = prev.z + (pos.z - prev.z) * t;
            if (Math.hypot(px - r.x, py - r.y, pz - r.z) < 11.5) {
              const mat = r.mesh.material as THREE.MeshBasicMaterial;
              if (mat.color.getHex() !== 0x4dff88) {
                mat.color.set("#4dff88");
                ringsGot++;
                nextRing = i + 1;
                chime(720 + ringsGot * 40);
                say(`Ring ${ringsGot} of ${scenery.rings.length}`);
              }
            }
          }
        }
        const agl = pos.y - ground(pos.x, pos.z);
        if (jump) { mode = "chute"; vel.multiplyScalar(0.5); say("Chute open. A and D steer. Land in the village for the finish."); }
        else if (agl < 1.0) {
          pos.y = ground(pos.x, pos.z);
          if (V > 26) {
            tumble = 1.6; afterTumble = "walk"; mode = "tumble";
            vel.multiplyScalar(0.25);
            say("Into the snow! Pull the chute next time (Space).", 3.5);
            if (runKind === "wingsuit") runKind = null;
          } else {
            toWalk();
            if (inVillage()) finishDescent();
          }
        }
        topSpeed = Math.max(topSpeed, V);
        break;
      }
      case "chute": {
        heading = wrapAngle(heading - ax.x * 0.9 * dt);
        const hs = Math.hypot(vel.x, vel.z);
        const nhs = damp(hs, 7, 1.5, dt);
        vel.x = Math.sin(heading) * nhs;
        vel.z = Math.cos(heading) * nhs;
        vel.y = damp(vel.y, -4.5, 2, dt);
        pos.addScaledVector(vel, dt);
        const gy = ground(pos.x, pos.z);
        if (pos.y <= gy) {
          pos.y = gy;
          toWalk();
          if (inVillage()) finishDescent();
          else say("Down safe. Ski from here, or take the gondola up.");
          if (runKind === "skyway") runKind = null;
        }
        break;
      }
      case "paraglider": {
        const bar = ax.y > 0.3, brake = ax.y < -0.3 || held.brake;
        const want = bar ? 14.5 : brake ? 7.5 : 11;
        V = damp(V, want, 1.2, dt);
        bank = damp(bank, ax.x * 0.6, 2, dt);
        heading = wrapAngle(heading - ax.x * 0.62 * dt);
        const sink = (bar ? 1.9 : brake ? 1.45 : 1.15) + Math.abs(bank) * 1.2;
        const lift = thermalLift(pos.x, pos.z);
        vel.set(Math.sin(heading) * V, lift - sink, Math.cos(heading) * V);
        pos.addScaledVector(vel, dt);
        if (lift > 1.5 && toastT <= 0) say("Thermal! Circle to climb.", 1.5);
        const gy = ground(pos.x, pos.z);
        if (pos.y - gy < 0.4) {
          pos.y = gy;
          toWalk();
          if (inVillage()) finishDescent();
          else say("Touchdown. Ski from here, or take the gondola up.");
        }
        topSpeed = Math.max(topSpeed, V);
        break;
      }
      case "kart": {
        if (!runStarted && (ax.y > 0.2 || held.gas)) runStarted = true;
        const gas = ax.y > 0.2 || held.gas ? 1 : 0;
        const brake = ax.y < -0.2 || held.brake ? 1 : 0;
        const vmax = kBoost > 0 ? 64 : 44;
        if (kGrounded) {
          kv += (gas * 16 - brake * (kv > 0 ? 26 : 8)) * dt;
          kv -= kv * Math.abs(kv) * 0.0035 * dt + Math.sign(kv) * 1.2 * dt * (gas ? 0 : 1);
          if (kv > vmax) kv = damp(kv, vmax, 3, dt);
          kv = Math.max(-8, kv);
          const steer = ax.x * (1.6 / (1 + Math.abs(kv) * 0.03));
          kpsi += steer * dt * Math.sign(kv || 1);
          kpsi = THREE.MathUtils.clamp(kpsi, -1.2, 1.2);
          // The road bends under you; you have to steer with it.
          skyway.frameAt(ks, f);
          kpsi -= f.k * kv * Math.cos(kpsi) * dt;
          kpsi *= Math.exp(-0.25 * dt);
          if (jump) { kvh = 5; kGrounded = false; }
        }
        kBoost = Math.max(0, kBoost - dt);
        const ds = kv * Math.cos(kpsi) * dt;
        const prevS = ks;
        ks += ds;
        kl += kv * Math.sin(kpsi) * dt;
        const lift = skyway.liftAt(ks);
        if (kGrounded) {
          const prevLift = skyway.liftAt(prevS);
          const slope = (lift - prevLift) / Math.max(1e-3, ds);
          kh = lift;
          kvh = kv * slope;
          if (!skyway.deckAt(ks) || (prevLift > 0.5 && lift < 0.01)) { kGrounded = false; }
        } else {
          kvh -= G * dt;
          kh += kvh * dt;
          if (kh <= lift && kh > lift - 1.5 && skyway.deckAt(ks) && Math.abs(kl) < ROAD_W / 2 + 0.6 && kvh <= 0) { kh = lift; kvh = 0; kGrounded = true; chime(520); }
        }
        // Edges.
        const edge = ROAD_W / 2 - 1.0;
        if (Math.abs(kl) > edge && kh < 2) {
          const side = Math.sign(kl);
          if (skyway.railAt(ks, side)) {
            // Glance off the rail: lose speed for the angle you hit it at, not for touching it.
            kl = side * edge;
            kv *= 1 - 0.6 * Math.abs(Math.sin(kpsi));
            kpsi = -side * Math.min(0.25, Math.abs(kpsi) * 0.5 + 0.03);
          } else if (Math.abs(kl) > ROAD_W / 2 + 0.6) {
            kGrounded = false;
            if (kh > -1) kh = Math.min(kh, -0.01);
          }
        }
        if (!kGrounded && kh < -6) {
          // Off the edge. Hand the kart's velocity to free fall.
          skyway.frameAt(ks, f);
          pos.copy(f.p).addScaledVector(f.r, kl).addScaledVector(f.u, kh);
          const fwd = tmpA.copy(f.t).multiplyScalar(Math.cos(kpsi)).addScaledVector(f.r, Math.sin(kpsi));
          vel.copy(fwd).multiplyScalar(kv).addScaledVector(f.u, kvh);
          heading = Math.atan2(fwd.x, fwd.z);
          mode = "fall";
          fallT = 0;
          say("Off the Skyway! Hang on...", 2);
          break;
        }
        // Boost pads and stars.
        for (const b of skyway.boosts) {
          const d = ((ks - b.s) % skyway.length + skyway.length) % skyway.length;
          if (d < 4 && Math.abs(kl - b.l) < 3.4 && kh < 1) { if (kBoost < 1.2) chime(1180); kBoost = 1.6; kv = Math.max(kv, 52); }
        }
        for (const st of skyway.stars) {
          if (st.got) continue;
          const d = Math.abs(((ks - st.s + skyway.length / 2) % skyway.length + skyway.length) % skyway.length - skyway.length / 2);
          if (d < 2.4 && Math.abs(kl - st.l) < 2.4 && kh < 3) { st.got = true; stars++; chime(1320); }
        }
        // Laps.
        if (ks >= skyway.length) {
          ks -= skyway.length;
          if (lap >= LAPS) {
            const t = runT;
            const best = writeBest("skyway", t);
            results = {
              title: "Prism Skyway: finished!",
              lines: [`${LAPS} laps in ${fmt(t)}`, `${stars} stars`, best ? "New personal best!" : `Your best: ${fmt(readBest().skyway)}`],
            };
            chime(660); chime(990);
            runKind = null;
            lap = 1;
            runT = 0;
            runStarted = false;
            for (const st of skyway.stars) st.got = false;
            stars = 0;
          } else {
            lap++;
            chime(990);
            say(`Lap ${lap} of ${LAPS}`);
          }
        }
        if (ks < 0) ks += skyway.length;
        topSpeed = Math.max(topSpeed, kv);
        // Where the body is.
        skyway.frameAt(ks, f);
        pos.copy(f.p).addScaledVector(f.r, kl).addScaledVector(f.u, kh);
        const fwd = tmpA.copy(f.t).multiplyScalar(Math.cos(kpsi)).addScaledVector(f.r, Math.sin(kpsi)).normalize();
        heading = Math.atan2(fwd.x, fwd.z);
        vel.copy(fwd).multiplyScalar(kv);
        break;
      }
      case "fall": {
        fallT += dt;
        vel.y -= G * dt;
        vel.multiplyScalar(1 - 0.002 * vel.length() * dt);
        pos.addScaledVector(vel, dt);
        if (fallT > 2.2) {
          mode = "wingsuit";
          const hs = Math.hypot(vel.x, vel.z);
          V = Math.max(24, vel.length());
          pitch = THREE.MathUtils.clamp(Math.atan2(-vel.y, hs), 0.2, 1.0);
          heading = Math.atan2(vel.x, vel.z);
          bank = 0;
          say("Wingsuit out! Fly it down, or press R to get back on the road.", 4);
        }
        break;
      }
      case "gondola": {
        rideU += rideDir * dt / 45;
        const N = scenery.cable.length - 1;
        const u = THREE.MathUtils.clamp(rideU, 0, 1);
        const fu = u * N, k = Math.min(N - 1, Math.floor(fu));
        pos.copy(scenery.cable[k]).lerp(scenery.cable[k + 1], fu - k);
        pos.y -= 4.4;
        const dir = tmpA.copy(scenery.cable[k + 1]).sub(scenery.cable[k]).multiplyScalar(rideDir);
        heading = Math.atan2(dir.x, dir.z);
        if (rideU >= 1 && rideDir === 1) { placeOnDeck(-4); toWalk(); say("The summit, 5,000 ft. Pick a way down."); }
        if (rideU <= 0 && rideDir === -1) { pos.set(VILLAGE.x - 90, VILLAGE.y, VILLAGE.z - 28); heading = Math.PI; toWalk(); say("The village, 300 ft."); }
        break;
      }
      case "beam": {
        beamT += dt;
        const bx = SUMMIT.x - 30, bz = SUMMIT.z - 6;
        skyway.frameAt(0, f);
        if (beamT < 3.2) {
          const k = beamT / 3.2;
          const e = k * k * (3 - 2 * k);
          pos.set(bx + (f.p.x - bx) * e * e, SUMMIT.y + (f.p.y - SUMMIT.y) * e, bz + (f.p.z - bz) * e * e);
          heading += dt * 3;
        } else toKartStart();
        break;
      }
    }

    // Pads: what can you do where you stand?
    if (mode === "walk" && use) {
      const p = nearPad();
      if (p) {
        if (p.key === "gondola-up") enterRide(1);
        else if (p.key === "gondola-down") enterRide(-1);
        else api.choose(p.key);
      }
    }
    if (pos.y < -50) { placeOnDeck(); toWalk(); }
  };

  const nearPad = (): Pad | null => {
    for (const p of scenery.pads) if (Math.hypot(pos.x - p.x, pos.z - p.z) < p.r && Math.abs(pos.y - p.y) < 8) return p;
    return null;
  };

  // ---- Drawing the body --------------------------------------------------
  let lean = 0;
  const poseBody = (dt: number, t: number) => {
    body.position.copy(pos);
    skis.visible = mode === "ski" || (mode === "tumble" && afterTumble === "ski");
    board.visible = mode === "board" || (mode === "tumble" && afterTumble === "board");
    wingHolder.visible = mode === "wingsuit" || mode === "fall";
    canopy.visible = mode === "chute" || mode === "paraglider";
    kart.visible = mode === "kart";
    trail.visible = mode === "kart";
    inner.visible = true;
    pose.rotation.set(0, 0, 0);
    inner.position.set(0, -0.9, 0);
    inner.rotation.set(0, 0, 0);
    wingHolder.rotation.set(0, 0, 0);
    body.rotation.set(0, heading, 0);
    switch (mode) {
      case "ski": {
        lean = damp(lean, -axis().x * 0.35, 6, dt);
        pose.rotation.z = lean;
        pose.rotation.x = 0.28;
        inner.position.y = -1.0;
        break;
      }
      case "board": {
        lean = damp(lean, -axis().x * 0.3, 6, dt);
        inner.rotation.y = Math.PI / 2;
        pose.rotation.z = lean;
        pose.rotation.x = 0.15;
        board.rotation.y = 0;
        break;
      }
      case "tumble":
        pose.rotation.x = t * 9;
        pose.rotation.z = Math.sin(t * 7) * 0.8;
        break;
      case "wingsuit":
      case "fall": {
        const p = mode === "fall" ? 0.8 : pitch;
        pose.rotation.x = Math.PI / 2 + p * 0.6;
        pose.rotation.z = -bank;
        wingHolder.position.y = 0.9;
        wingHolder.rotation.x = p * 0.6;
        wingHolder.rotation.z = -bank;
        break;
      }
      case "chute":
      case "paraglider":
        pose.rotation.x = 0.1;
        body.rotation.z = -bank * 0.6;
        break;
      case "kart": {
        skyway.frameAt(ks, f);
        const fwd = tmpA.copy(f.t).multiplyScalar(Math.cos(kpsi)).addScaledVector(f.r, Math.sin(kpsi)).normalize();
        const right = tmpB.copy(fwd).cross(f.u).normalize();
        const m = new THREE.Matrix4().makeBasis(right.negate(), f.u, fwd);
        body.quaternion.setFromRotationMatrix(m);
        inner.position.set(0, -0.62, -0.25);
        inner.scale.setScalar(0.78);
        break;
      }
      case "gondola":
        inner.position.y = -0.9 - 0.2;
        break;
      case "beam":
        pose.rotation.y = t * 4;
        break;
    }
    if (mode !== "kart") inner.scale.setScalar(1);
    rig?.update(dt);

    // Kart trail.
    if (mode === "kart") {
      const back = tmpC.set(0, 0.35, -1.4).applyQuaternion(body.quaternion).add(pos);
      trailPts.unshift(back.clone());
      if (trailPts.length > TRAIL) trailPts.length = TRAIL;
      const side = new THREE.Vector3(1, 0, 0).applyQuaternion(body.quaternion);
      for (let i = 0; i < TRAIL; i++) {
        const p = trailPts[Math.min(i, trailPts.length - 1)] ?? back;
        const w = 0.8 * (1 - i / TRAIL);
        trailPos.set([p.x - side.x * w, p.y, p.z - side.z * w, p.x + side.x * w, p.y, p.z + side.z * w], i * 6);
        const c = new THREE.Color().setHSL(((i / TRAIL) * 1.2 + t * 0.3) % 1, 1, 0.6);
        trailCol.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6);
      }
      trailGeo.attributes.position.needsUpdate = true;
      trailGeo.attributes.color.needsUpdate = true;
    }
  };

  // ---- Camera ------------------------------------------------------------
  const placeCamera = (dt: number) => {
    let dist = 7, height = 2.6, lookUp = 1.4;
    let yaw = camYaw;
    const speed = mode === "kart" ? Math.abs(kv) : vel.length();
    if (mode !== "walk" && mode !== "gondola" && mode !== "beam") {
      if (lookTimer > 0) lookTimer -= dt;
      const target = (mode === "ski" || mode === "board") && speed > 3 ? Math.atan2(vel.x, vel.z) : heading;
      if (lookTimer <= 0) camYaw = wrapAngle(camYaw + wrapAngle(target - camYaw) * (1 - Math.exp(-4 * dt)));
      yaw = camYaw;
    }
    switch (mode) {
      case "ski": case "board": case "tumble": dist = 8.5; height = 3.2; break;
      case "wingsuit": case "fall": dist = 11; height = 2.6; lookUp = 0.6; break;
      case "chute": case "paraglider": dist = 13; height = 4.5; lookUp = 2; break;
      case "kart": dist = 8.5; height = 3.4; lookUp = 1.2; break;
      case "gondola": dist = 14; height = 5; break;
      case "beam": dist = 16; height = 2; break;
    }
    const pitchK = mode === "walk" ? camPitch : 0.18 + (lookTimer > 0 ? camPitch - 0.18 : 0);
    const want = tmpA.set(
      pos.x - Math.sin(yaw) * dist * Math.cos(pitchK),
      pos.y + height + Math.sin(pitchK) * dist * 0.8,
      pos.z - Math.cos(yaw) * dist * Math.cos(pitchK),
    );
    if (mode === "kart") {
      skyway.frameAt(ks, f);
      want.addScaledVector(f.u, 0.5);
    }
    const g = ground(want.x, want.z) + 1.4;
    if (want.y < g) want.y = g;
    const k = mode === "kart" ? 10 : mode === "wingsuit" ? 7 : 6;
    camPos.x = damp(camPos.x, want.x, k, dt);
    camPos.y = damp(camPos.y, want.y, k, dt);
    camPos.z = damp(camPos.z, want.z, k, dt);
    if (camPos.distanceTo(pos) > 80) camPos.copy(want);
    const ahead = mode === "walk" ? 0 : Math.min(6, speed * 0.12);
    camLook.set(pos.x + Math.sin(heading) * ahead, pos.y + lookUp, pos.z + Math.cos(heading) * ahead);
    camera.position.copy(camPos);
    camera.lookAt(camLook);
    const fov = 62 + Math.min(22, Math.max(0, speed - 8) * 0.38);
    if (Math.abs(camera.fov - fov) > 0.1) { camera.fov = damp(camera.fov, fov, 3, dt); camera.updateProjectionMatrix(); }
  };

  // ---- HUD ---------------------------------------------------------------
  let hudT = 0, frames = 0, fpsT = 0, fps = 60;
  const pushHud = () => {
    const p = mode === "walk" ? nearPad() : null;
    let prompt = "";
    if (p) {
      prompt = {
        ski: "E · Skis", board: "E · Snowboard", wingsuit: "E · Wingsuit", paraglider: "E · Paraglider",
        skyway: "E · Ride the rainbow up", "gondola-up": "E · Gondola to the summit", "gondola-down": "E · Gondola to the village",
      }[p.key];
    }
    const onDeck = mode === "walk" && Math.hypot(pos.x - SUMMIT.x, pos.z - SUMMIT.z) < 60 && pos.y > SUMMIT.y - 5;
    const sp = mode === "kart" ? Math.abs(kv) : mode === "wingsuit" ? V : vel.length();
    opts.onHud?.({
      mode,
      altFt: Math.round(pos.y * FT),
      aglFt: Math.round(Math.max(0, pos.y - ground(pos.x, pos.z)) * FT),
      speed: Math.round(sp * 3.6),
      prompt,
      toast: toastT > 0 ? toast : "",
      timer: runKind && runStarted ? runT : null,
      rings: runKind === "wingsuit" ? [ringsGot, scenery.rings.length] : null,
      lap: mode === "kart" ? [lap, LAPS] : null,
      stars,
      onDeck,
      inVillage: mode === "walk" && inVillage(),
      results,
      fps,
    });
    void nextRing;
  };

  // ---- The loop ----------------------------------------------------------
  let last = performance.now();
  let clock = 0;
  let raf = 0;
  let paused = false;
  const advance = (dt: number) => {
    clock += dt;
    const sub = Math.max(1, Math.ceil(dt / (1 / 120)));
    for (let i = 0; i < sub; i++) step(dt / sub);
    if (toastT > 0) toastT -= dt;
    poseBody(dt, clock);
    placeCamera(dt);
    // World bits.
    scenery.update(clock, dt);
    skyway.update(clock);
    const space = THREE.MathUtils.smoothstep(camera.position.y, 2000, 2700);
    sky.update(camera, space, clock);
    (scene.fog as THREE.Fog).color.copy(sky.horizon);
    (scene.fog as THREE.Fog).near = 1200 + space * 2000;
    (scene.fog as THREE.Fog).far = 13000 + space * 2000;
    hemi.intensity = 0.9 - space * 0.25;
    sun.position.copy(pos).addScaledVector(sky.sunDir, 400);
    sun.target.position.copy(pos);
    // Snow falls around the camera, and thins out above the clouds.
    flakes.visible = space < 0.6;
    if (flakes.visible) {
      const a = flakeGeo.attributes.position as THREE.BufferAttribute;
      const arr = a.array as Float32Array;
      for (let i = 0; i < FLAKES; i++) {
        let y = arr[i * 3 + 1] - dt * 1.6;
        if (y < -BOXR) y += BOXR * 2;
        arr[i * 3 + 1] = y;
        arr[i * 3] += Math.sin(clock + i) * dt * 0.3;
      }
      a.needsUpdate = true;
      flakes.position.set(Math.round(camera.position.x / (BOXR * 2)) * BOXR * 2, Math.round(camera.position.y / (BOXR * 2)) * BOXR * 2, Math.round(camera.position.z / (BOXR * 2)) * BOXR * 2);
      // Wrap flakes into a box around the camera.
      for (let i = 0; i < FLAKES; i++) {
        for (let c = 0; c < 3; c++) {
          const rel = arr[i * 3 + c] + flakes.position.getComponent(c) - camera.position.getComponent(c);
          if (rel > BOXR) arr[i * 3 + c] -= BOXR * 2;
          else if (rel < -BOXR) arr[i * 3 + c] += BOXR * 2;
        }
      }
    }
    // Wind.
    if (audio && windGain && windFilter) {
      const sp = mode === "kart" ? Math.abs(kv) : mode === "wingsuit" ? V : vel.length();
      windGain.gain.value = muted ? 0 : Math.min(0.5, 0.02 + sp * 0.008);
      windFilter.frequency.value = 250 + sp * 18;
    }
    hudT -= dt;
    if (hudT <= 0) { hudT = 0.1; pushHud(); }
  };
  const loop = () => {
    raf = requestAnimationFrame(loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    frames++;
    fpsT += dt;
    if (fpsT > 1) { fps = Math.round(frames / fpsT); frames = 0; fpsT = 0; }
    if (paused) return;
    advance(dt);
    renderer.render(scene, camera);
  };

  const onResize = () => {
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    camera.aspect = mount.clientWidth / Math.max(1, mount.clientHeight);
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", onResize);

  // Spawn: on the deck, facing the drop. `?at=` and `?mode=` are for scripts.
  const q = new URLSearchParams(window.location.search);
  camYaw = 0;
  placeCamera(1);
  camPos.copy(camera.position);
  advance(0.016);
  renderer.render(scene, camera);
  loop();
  opts.onReady?.();
  say("Vibe Summit, 5,000 ft. Pick a way down: skis, board, wingsuit or paraglider. Or ride the rainbow up.", 6);
  const qm = q.get("mode");
  if (qm === "ski" || qm === "board" || qm === "wingsuit" || qm === "paraglider" || qm === "skyway") api.choose(qm);
  if (q.get("at") === "village") api.travel("village");

  // ---- Test hook ---------------------------------------------------------
  (window as unknown as { __summit?: unknown }).__summit = {
    state: () => ({ mode, x: pos.x, y: pos.y, z: pos.z, heading, speed: vel.length(), V, ks, kl, kv, lap, runT, ringsGot, results, grounded }),
    /** Run the simulation for `seconds` without drawing, holding the given keys. */
    settle(seconds: number, hold: string[] = []) {
      hold.forEach((k) => keys.add(k));
      paused = true;
      const dt = 1 / 30;
      for (let t = 0; t < seconds; t += dt) advance(dt);
      hold.forEach((k) => keys.delete(k));
      paused = false;
      last = performance.now();
    },
    choose: (m: Parameters<Summit["choose"]>[0]) => api.choose(m),
    travel: (w: Parameters<Summit["travel"]>[0]) => api.travel(w),
    teleport(x: number, z: number, y?: number) { pos.set(x, y ?? ground(x, z), z); toWalk(); },
    press: (a: Parameters<Summit["press"]>[0]) => api.press(a),
    snapshot: () => { renderer.render(scene, camera); return canvas.toDataURL("image/jpeg", 0.88); },
    rigLoaded: () => !!rig,
  };

  return api;
}
