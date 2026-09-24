/**
 * The Magician's valley, assembled.
 *
 * `createMagician(container)` builds the renderer, the scene, the village and
 * the player, starts the loop, and returns a handle the page and the voice
 * session drive through `store` (the `MagicianStore` the tools run against)
 * and `vibey` (captions, speaking level, emotes).
 *
 * The state is the source of truth; this file is the thing that eases the
 * scene toward it every frame. Nothing here is switched, everything is
 * lerped, because a world that snaps from noon to midnight looks like a bug
 * and one that slides there in two seconds looks like magic.
 *
 * VR: `renderer.xr` is enabled and the loop runs through
 * `setAnimationLoop`, which is what WebXR needs. `vrButton()` hands the page
 * three's own VRButton so it can put it in the HUD.
 */
import * as THREE from "three";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import {
  applyPatch,
  cloudAmount,
  DEFAULT_STATE,
  fireballsFizzle,
  firefliesOn,
  fogDensity,
  lanternsOn,
  nightness,
  petalDensity,
  rainAmount,
  snowAmount,
  snowCover,
  type Patch,
  type Prop,
  type WorldState,
} from "../state";
import { LANDMARKS, runTool, type MagicianStore, type ToolResult } from "../tools";
import { castSpell } from "../spellbook";
import { heightAt, riverCentre, riverDistance, WATER_LEVEL } from "./noise";
import { createTerrain, pathAt } from "./terrain";
import { createGrass } from "./grass";
import { createSky } from "./sky";
import { buildBoard, buildBridge, buildForest, buildProp, buildSign, disposeSharedProps, FOLIAGE, type PropObject, type TreeKind } from "./props";
import { createBursts, createFireflies, createLightning, createPetals, createRain, createSnow } from "./weather";
import { createFireballs } from "./fireballs";
import { createAmbience } from "./audio";
import { createVibey, type Vibey } from "./vibey";
import { readCompanion, writeCompanion } from "../companions";
import { createGameRunner, type HouseState } from "../game/runner";
import { MODE_INFO, type GameHud, type GameModeId } from "../game/types";
import { joinRoom, readNetMode, readRoom, type PeerPresence, type Room } from "../net";
import { createPeers } from "./peers";
import { createPlayer } from "./player";

export interface MagicianOptions {
  /** The visitor's display name for other players. */
  name?: string;
  /** Whether the voice session is live, for the talking ring on our ghost. */
  talking?(): boolean;
  /** One line about the voice for the headset HUD: "pinch to talk", "listening", … */
  voiceLine?(): string;
}

export interface MagicianEvents {
  onToast?(text: string): void;
  onHit?(hits: number): void;
  onState?(state: WorldState): void;
  onFizzle?(): void;
  /** The companion body changed (by voice or the picker). */
  onCompanion?(id: string): void;
  /** Something the voice should be told, from the game. */
  onNotify?(text: string): void;
  /** The game HUD changed (every frame while a game runs, null when none). */
  onGame?(hud: GameHud | null): void;
  /** Who else is in the valley. */
  onPeers?(peers: PeerPresence[], connected: boolean): void;
  /** A trigger or a pinch in VR while no game is running: the visitor wants to talk. */
  onSelect?(): void;
  /** The visitor held the trigger or the pinch: leave VR. */
  onExitVR?(): void;
}

export interface MagicianWorld {
  store: MagicianStore;
  vibey: Vibey;
  /** Run a tool by name; what the voice session calls. */
  run(name: string, args: unknown): ToolResult;
  /** Run a plain sentence through the spellbook. Returns how many spells landed. */
  cast(text: string): ToolResult[];
  getState(): WorldState;
  /** Virtual joystick from the HUD. */
  setStick(x: number, y: number): void;
  jump(): void;
  /** Shoot down the view, from a button. */
  fire(): void;
  /** Zoom: 1 is the natural field of view, 2 is twice as wide. */
  setZoom(z: number): void;
  zoom(): number;
  /** The canvas, for the recorder. */
  canvas(): HTMLCanvasElement;
  /** Names for the supporters' board on the square. */
  setSupporters(lines: string[]): void;
  /** The ambience mix, for the recorder. */
  audioStream(): MediaStream | null;
  startGame(id: GameModeId): void;
  stopGame(): void;
  gameHud(): GameHud | null;
  vrButton(): HTMLElement;
  setMuted(m: boolean): void;
  /** Call from a user gesture to start the ambience. */
  wake(): void;
  /** Render one frame and return it as a data URL. For scripts. */
  snapshot(): string;
  inVR(): boolean;
  dispose(): void;
}

const V = new THREE.Vector3();
const CAST_GESTURES = ["Punch", "ThumbsUp", "Jump", "Yes"];
let lastEmote = 0;
const C = new THREE.Color();
const C2 = new THREE.Color();

/** Sky colours by sun elevation, before weather and palette. */
function naturalSky(elev: number, night: number): { zenith: THREE.Color; horizon: THREE.Color; sun: THREE.Color } {
  const day = { z: new THREE.Color("#3d7fd6"), h: new THREE.Color("#d7e8f6") };
  const sunset = { z: new THREE.Color("#4a3a8f"), h: new THREE.Color("#ff9d5c") };
  const nightC = { z: new THREE.Color("#050a1c"), h: new THREE.Color("#141d3c") };
  const low = 1 - Math.min(1, Math.max(0, elev * 3.5));
  const zenith = day.z.clone().lerp(sunset.z, low * 0.9).lerp(nightC.z, night);
  const horizon = day.h.clone().lerp(sunset.h, low).lerp(nightC.h, night);
  const sun = new THREE.Color("#fff2cf").lerp(new THREE.Color("#ff7a3d"), low).lerp(new THREE.Color("#8fa4ff"), night);
  return { zenith, horizon, sun };
}

export function createMagician(container: HTMLElement, events: MagicianEvents = {}, options: MagicianOptions = {}): MagicianWorld {
  // ---- renderer ---------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.xr.enabled = true;
  renderer.domElement.style.display = "block";
  renderer.domElement.style.touchAction = "none";
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2("#d7e8f6", 0.004);
  const camera = new THREE.PerspectiveCamera(70, container.clientWidth / Math.max(1, container.clientHeight), 0.1, 1500);
  // A phone held upright is a tall, narrow window. Keep a sensible horizontal
  // view (about 75 degrees) by widening the vertical one for portrait, with a
  // ceiling so it never turns into a fisheye. Pinch multiplies it.
  let zoomLevel = 1;
  function applyFov() {
    if (renderer.xr.isPresenting) return;
    const aspect = camera.aspect;
    const hfov = (75 * Math.PI) / 180;
    let v = (2 * Math.atan(Math.tan(hfov / 2) / aspect) * 180) / Math.PI;
    v = Math.max(55, Math.min(95, v)) * zoomLevel;
    camera.fov = Math.max(30, Math.min(115, v));
    camera.updateProjectionMatrix();
    // On a narrow screen the companion stands nearer the middle, further off,
    // so the caption above its head stays on screen.
    const narrow = Math.max(0, Math.min(1, (1.2 - aspect) / 0.8));
    vibey.setStance(2.6 + narrow * 0.8, 1.3 - narrow * 0.9);
  }

  // ---- light --------------------------------------------------------------
  const hemi = new THREE.HemisphereLight("#cfe6ff", "#4f6a3a", 0.6);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight("#fff2cf", 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 260;
  const sc = sun.shadow.camera;
  sc.left = -55; sc.right = 55; sc.top = 55; sc.bottom = -55;
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  const moonLight = new THREE.DirectionalLight("#8fa4ff", 0);
  scene.add(moonLight);

  // ---- ground and sky -----------------------------------------------------
  const terrain = createTerrain();
  scene.add(terrain.group);
  const sky = createSky();
  scene.add(sky.group);

  // ---- the village ----------------------------------------------------------
  const fixed: PropObject[] = [];
  const foliageMats: Array<{ mat: THREE.MeshStandardMaterial; kind: "tree" | "sakura" | "maple" | "pine" | "bamboo" }> = [];
  const state0 = applyPatch(DEFAULT_STATE, {});
  function place(kind: Parameters<typeof buildProp>[0], x: number, z: number, yaw = Math.random() * Math.PI * 2, scale = 1, color?: string): PropObject {
    const p = buildProp(kind, state0.season, color);
    p.group.position.set(x, heightAt(x, z), z);
    p.group.rotation.y = yaw;
    p.group.scale.setScalar(scale);
    scene.add(p.group);
    fixed.push(p);
    if (p.foliage && ["tree", "sakura", "maple", "pine", "bamboo"].includes(kind)) {
      for (const m of p.foliage) foliageMats.push({ mat: m as THREE.MeshStandardMaterial, kind: kind as "tree" });
    }
    return p;
  }
  // Houses around the village square, doors facing in.
  const houseSpots: Array<[number, number, number]> = [
    [-9, 9, Math.PI], [6, 11, Math.PI], [-14, -10, 0.2], [8, -12, -0.2], [17, 4, -Math.PI / 2], [-19, 1, Math.PI / 2], [0, 22, Math.PI], [14, 18, Math.PI * 0.8],
  ];
  const houses: HouseState[] = [];
  for (const [x, z, yaw] of houseSpots) { const p = place("house", x, z, yaw); houses.push({ x, z, group: p.group, hp: 3, alive: true, fire: null }); }
  const lanternSpots: Array<{ x: number; z: number }> = [];
  // Shrine on its hill, torii on the way, the bridge, the pagoda far side.
  place("shrine", LANDMARKS.shrine.x, LANDMARKS.shrine.z, 0.35, 1.2);
  place("torii", LANDMARKS.torii.x, LANDMARKS.torii.z, 0.1, 1.1);
  place("torii", -40, -48, 0.5, 1);
  place("pagoda", -70, -20, 0.4, 1.1);
  scene.add(buildBridge(LANDMARKS.bridge.x, LANDMARKS.bridge.z));
  place("windmill", 62, 12, 0, 1);
  // Lanterns along the shrine path and the square.
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    const sx = -8 - t * 38 + 2.4;
    const sz = -6 - t * 56 + Math.sin(t * 6) * 4;
    place("lantern", sx, sz, 0, 0.9);
    lanternSpots.push({ x: sx, z: sz });
  }
  for (const [x, z] of [[-4, 4], [4, 4], [-4, -4], [4, -4], [-30, -30], [-30, -38]]) { place("lantern", x, z, 0, 0.9); lanternSpots.push({ x, z }); }
  // A few campfires' worth of rocks by the river, bamboo by the lake.
  for (let i = 0; i < 10; i++) {
    const z = -80 + i * 17;
    const x = riverCentre(z) + (i % 2 ? 7 : -7) + (Math.random() - 0.5) * 3;
    place(i % 3 ? "rock" : "boulder", x, z);
  }
  for (let i = 0; i < 7; i++) place("bamboo", 44 + Math.random() * 14, 62 + Math.random() * 12);
  // Trees: sakura around the village and up the shrine path, maples by the
  // lake, pines on the slopes, generic trees everywhere else.
  const treeCount = 260;
  const forestTrees: Array<{ kind: TreeKind; x: number; z: number; yaw: number; scale: number }> = [];
  let placed = 0, tries = 0;
  while (placed < treeCount && tries++ < 4000) {
    const x = (Math.random() - 0.5) * 380;
    const z = (Math.random() - 0.5) * 380;
    const r = Math.hypot(x, z);
    if (r < 22) continue;
    if (Math.abs(x - riverCentre(z)) < 9) continue;
    if (pathAt(x, z) > 0.05) continue;
    if (Math.hypot((x - 42) / 1.4, z - 30) < 36) continue;
    if (Math.hypot(x - 60, z - 56) < 24) continue;
    if (Math.hypot(x - LANDMARKS.shrine.x, z - LANDMARKS.shrine.z) < 7) continue;
    if (Math.hypot(x - LANDMARKS.torii.x, z - LANDMARKS.torii.z) < 5) continue;
    const h = heightAt(x, z);
    if (h < WATER_LEVEL + 0.5 || h > 95) continue;
    const kind: TreeKind = r < 60 && Math.random() < 0.55 ? "sakura" : Math.hypot(x - 60, z - 56) < 45 && Math.random() < 0.6 ? "maple" : h > 30 || Math.random() < 0.35 ? "pine" : "tree";
    forestTrees.push({ kind, x, z, yaw: Math.random() * 6.28, scale: 0.9 + Math.random() * 0.5 });
    placed++;
  }
  const forest = buildForest(forestTrees, state0.season);
  scene.add(forest.group);
  for (const kind of ["tree", "sakura", "maple", "pine"] as const) foliageMats.push({ mat: forest.foliage[kind], kind });
  // The mountain's mouth: where the fireballs come from.
  const crater = new THREE.Mesh(new THREE.CylinderGeometry(6, 9, 3, 12), new THREE.MeshStandardMaterial({ color: "#3a2a26", emissive: "#ff5a1f", emissiveIntensity: 0.25, roughness: 1 }));
  crater.position.set(110, heightAt(110, -120) + 1, -120);
  scene.add(crater);

  // The sign by the bridge.
  const sign = buildSign();
  sign.group.position.set(LANDMARKS.bridge.x - 14, heightAt(LANDMARKS.bridge.x - 14, LANDMARKS.bridge.z + 3), LANDMARKS.bridge.z + 3);
  sign.group.rotation.y = -0.6;
  scene.add(sign.group);

  // ---- grass -------------------------------------------------------------
  // Everywhere the ground is meadow: not on paths, water, paddies, the lake,
  // under a building or up the bare mountain. Density eases off near each
  // edge so the field thins out instead of stopping at a line.
  const noGrass: Array<{ x: number; z: number; r: number }> = [
    ...houseSpots.map(([x, z]) => ({ x, z, r: 5 })),
    { x: LANDMARKS.shrine.x, z: LANDMARKS.shrine.z, r: 4.5 },
    { x: -70, z: -20, r: 3.5 },
    { x: 62, z: 12, r: 2.2 },
    { x: 6, z: -3, r: 1.6 },
  ];
  const grassDensity = (x: number, z: number): number => {
    const h = heightAt(x, z);
    if (h < WATER_LEVEL + 0.35) return 0;
    let d = 1;
    d *= Math.min(1, Math.max(0, (riverDistance(x, z) - 5) / 4));
    d *= 1 - Math.min(1, pathAt(x, z) * 1.6);
    const paddy = Math.hypot((x - 42) / 1.4, z - 30);
    d *= Math.min(1, Math.max(0, (paddy - 33) / 4));
    d *= Math.min(1, Math.max(0, (Math.hypot(x - 60, z - 56) - 23) / 4));
    for (const o of noGrass) d *= Math.min(1, Math.max(0, (Math.hypot(x - o.x, z - o.z) - o.r) / 1.5));
    if (h > 45) d *= Math.max(0, 1 - (h - 45) / 25);
    return d;
  };
  const coarse = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  const grass = createGrass({ heightAt, density: grassDensity, perSquareMetre: coarse ? 10 : 22, radius: coarse ? 24 : 32 });
  scene.add(grass.group);

  // The supporters' board, on the square, where everyone arrives.
  const board = buildBoard();
  board.group.position.set(6, heightAt(6, -3), -3);
  board.group.rotation.y = 2.4;
  scene.add(board.group);

  // ---- conjured things ------------------------------------------------------
  const spawned = new Map<number, { obj: PropObject; prop: Prop }>();
  const spawnMats: Array<{ mat: THREE.MeshStandardMaterial; kind: "tree" | "sakura" | "maple" | "pine" | "bamboo" }> = [];
  function syncProps(props: Prop[], season: WorldState["season"]) {
    const ids = new Set(props.map((p) => p.id));
    for (const [id, s] of spawned) {
      if (!ids.has(id)) { scene.remove(s.obj.group); s.obj.dispose(); spawned.delete(id); }
    }
    for (const p of props) {
      if (spawned.has(p.id)) continue;
      const obj = buildProp(p.kind, season, p.color);
      obj.group.position.set(p.x, heightAt(p.x, p.z), p.z);
      obj.group.rotation.y = p.yaw;
      obj.group.scale.setScalar(0.01);
      scene.add(obj.group);
      spawned.set(p.id, { obj, prop: p });
    }
    spawnMats.length = 0;
    for (const s of spawned.values()) {
      if (s.prop.color || !s.obj.foliage) continue;
      if (["tree", "sakura", "maple", "pine", "bamboo"].includes(s.prop.kind)) for (const m of s.obj.foliage) spawnMats.push({ mat: m as THREE.MeshStandardMaterial, kind: s.prop.kind as "tree" });
    }
  }

  // ---- air ----------------------------------------------------------------
  const rain = createRain();
  const snow = createSnow();
  const petals = createPetals();
  const fireflies = createFireflies();
  const bursts = createBursts();
  const lightning = createLightning();
  const fireballs = createFireballs();
  scene.add(rain.object, snow.object, petals.object, fireflies.object, bursts.object, lightning.light, fireballs.group);
  const petalMat = (petals.object as THREE.Points).material as THREE.PointsMaterial;

  // ---- people ---------------------------------------------------------------
  const player = createPlayer(container, camera);
  player.teleport(-2, 6, Math.PI * 0.15);
  let pinchStartZoom = 1;
  let pinchArmed = false;
  player.onPinch((ratio) => {
    if (!pinchArmed) { pinchStartZoom = zoomLevel; pinchArmed = true; }
    zoomLevel = Math.max(0.6, Math.min(1.8, pinchStartZoom / ratio));
    applyFov();
  });
  container.addEventListener("touchend", () => { pinchArmed = false; });
  scene.add(player.rig);
  // Hands in the headset: the controller models and a short pointer ray each,
  // parented to the rig so they move with the player.
  const controllerFactory = new XRControllerModelFactory();
  const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  const rayMat = new THREE.LineBasicMaterial({ color: "#b98cff", transparent: true, opacity: 0.6 });
  const controllers: THREE.Group[] = [];
  for (let i = 0; i < 2; i++) {
    const grip = renderer.xr.getControllerGrip(i);
    grip.add(controllerFactory.createControllerModel(grip));
    player.rig.add(grip);
    const ctrl = renderer.xr.getController(i);
    const ray = new THREE.Line(rayGeo, rayMat);
    ray.scale.z = 3;
    ctrl.add(ray);
    player.rig.add(ctrl);
    controllers.push(ctrl);
  }
  const vibey = createVibey(readCompanion());
  scene.add(vibey.group);
  applyFov();
  const ambience = createAmbience();

  // ---- other players --------------------------------------------------------
  const peers = createPeers();
  scene.add(peers.group);
  let room: Room | null = null;
  let applyingRemote = false;
  void joinRoom({
    mode: readNetMode(),
    room: readRoom(),
    name: options.name ?? "visitor",
    onPatch: (p) => { applyingRemote = true; try { store.patch(p); } finally { applyingRemote = false; } },
    onFull: (s) => { applyingRemote = true; try { store.patch({ ...s, hits: state.hits }); } finally { applyingRemote = false; } },
    onPeers: (list) => { peers.sync(list); events.onPeers?.(list, true); },
    onJoin: (n) => events.onToast?.(`${n} arrived`),
    onLeave: (n) => events.onToast?.(`${n} left`),
    currentState: () => state,
  }).then((r) => {
    if (disposed) { r.close(); return; }
    room = r;
    events.onPeers?.([], r.connected);
  });

  // ---- state ----------------------------------------------------------------
  let state: WorldState = applyPatch(DEFAULT_STATE, {});
  let lastNotify = 0;
  const notify = (text: string) => {
    if (time - lastNotify < 4) return;
    lastNotify = time;
    events.onNotify?.(text);
  };
  const game = createGameRunner({
    scene,
    state: () => state,
    patch: (p) => store.patch(p),
    player: { position: player.position, yaw: () => player.yaw() },
    heightAt,
    vibey: () => vibey.position,
    burst: (kind, x, y, z) => { if (kind === "flash") flash = 1; bursts.spawn(kind === "flash" ? "sparkle" : kind, x, y, z); },
    sound: (n) => ambience.play(n),
    notify,
    toast: (t) => events.onToast?.(t),
    caption: (t) => vibey.setCaption(t),
    emote: (c) => vibey.emote(c),
    teleport: (x, z, yaw) => player.teleport(x, z, yaw),
    houses,
    lightning: () => lightning.flash,
    time: () => time,
  });
  const store: MagicianStore = {
    get: () => state,
    patch(p: Patch) {
      state = applyPatch(state, p);
      if (p.props) syncProps(state.props, state.season);
      if (p.sign !== undefined) sign.setText(state.sign);
      events.onState?.(state);
      // Our own patches go to the room; theirs came from it.
      if (!applyingRemote && room?.connected) room.patch(p);
    },
    playerPosition: () => ({ x: player.position.x, z: player.position.z, yaw: player.yaw() }),
    teleport(x, z, yaw) { player.teleport(x, z, yaw); },
    emote(clip) { vibey.emote(clip); },
    sound(name) { ambience.play(name); },
    game: {
      start: (m) => game.start(m),
      stop: () => game.stop(),
      active: () => game.active(),
      status: () => {
        const h = game.hud();
        if (!h) return "No game running (free play).";
        return `${h.title}: ${h.objective}. Score ${h.score}, hearts ${h.hearts}/${h.maxHearts}${h.timer != null ? `, ${Math.ceil(h.timer)}s left` : ""}${h.detail ? `, ${h.detail}` : ""}. Shield ${h.shield > 0 ? `up for ${Math.ceil(h.shield)}s` : h.shield < 0 ? `recharging ${Math.ceil(-h.shield)}s` : "ready"}, blast ${h.blast < 0 ? `recharging ${Math.ceil(-h.blast)}s` : "ready"}.${h.over ? (h.won ? " The game is WON." : " The game is LOST.") : ""}`;
      },
      shield: () => game.shield(),
      blast: () => game.blast(),
    },
    become(id) {
      writeCompanion(id);
      void vibey.setBody(id).then(() => events.onCompanion?.(id));
    },
    burst(kind, x, z) {
      const px = x ?? player.position.x - Math.sin(player.yaw()) * 3;
      const pz = z ?? player.position.z - Math.cos(player.yaw()) * 3;
      if (kind === "flash") { flash = 1; bursts.spawn("sparkle", px, heightAt(px, pz), pz); }
      else bursts.spawn(kind, px, heightAt(px, pz), pz);
    },
  };
  sign.setText(state.sign);
  let flash = 0;

  // ---- shooting -----------------------------------------------------------
  // Desktop: a click (while locked, or a click with no drag) fires down the
  // view. Phone: a short tap on the right half. VR: the trigger, down the
  // controller's ray.
  const shotDir = new THREE.Vector3();
  const shotOrigin = new THREE.Vector3();
  function fireFromCamera() {
    if (!game.active()) return;
    const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
    cam.getWorldDirection(shotDir);
    cam.getWorldPosition(shotOrigin);
    shotOrigin.addScaledVector(shotDir, 0.6);
    game.fire(shotOrigin, shotDir);
  }
  let downAt = 0, downX = 0, downY = 0;
  const onDown = (e: MouseEvent) => { if ((e.target as HTMLElement).closest("button, input, a, select, [data-ui]")) return; downAt = performance.now(); downX = e.clientX; downY = e.clientY; };
  const onUp = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, input, a, select, [data-ui]")) return;
    const quick = performance.now() - downAt < 250 && Math.hypot(e.clientX - downX, e.clientY - downY) < 6;
    if (quick || document.pointerLockElement === container) fireFromCamera();
  };
  container.addEventListener("mousedown", onDown);
  container.addEventListener("mouseup", onUp);
  let tapAt = 0, tapX = 0, tapY = 0, tapId = -1;
  const onTouchStart = (e: TouchEvent) => { const t = e.changedTouches[0]; if (!t || t.clientX < window.innerWidth / 2) return; if ((t.target as HTMLElement).closest("button, input, a, select, [data-ui]")) return; tapAt = performance.now(); tapX = t.clientX; tapY = t.clientY; tapId = t.identifier; };
  const onTouchEnd = (e: TouchEvent) => { for (const t of Array.from(e.changedTouches)) { if (t.identifier !== tapId) continue; if (performance.now() - tapAt < 250 && Math.hypot(t.clientX - tapX, t.clientY - tapY) < 10) fireFromCamera(); } };
  container.addEventListener("touchstart", onTouchStart, { passive: true });
  container.addEventListener("touchend", onTouchEnd);
  const ctrlDir = new THREE.Vector3();
  const ctrlPos = new THREE.Vector3();
  // In the headset a trigger or a pinch means: shoot if a game is on,
  // otherwise talk. Holding it for two seconds leaves VR, which is the only
  // way out with bare hands.
  const holdTimers = new Map<THREE.Group, number>();
  const onSelectStart = (c: THREE.Group) => () => {
    if (game.active()) {
      c.getWorldPosition(ctrlPos);
      ctrlDir.set(0, 0, -1).applyQuaternion(c.getWorldQuaternion(new THREE.Quaternion()));
      game.fire(ctrlPos, ctrlDir);
    } else events.onSelect?.();
    holdTimers.set(c, window.setTimeout(() => {
      holdTimers.delete(c);
      events.onExitVR?.();
      void renderer.xr.getSession()?.end().catch(() => undefined);
    }, 2000));
  };
  const onSelectEnd = (c: THREE.Group) => () => { const t = holdTimers.get(c); if (t !== undefined) { clearTimeout(t); holdTimers.delete(c); } };
  const selectHandlers = controllers.map((c) => { const h = onSelectStart(c); const e = onSelectEnd(c); c.addEventListener("selectstart", h); c.addEventListener("selectend", e); return { h, e }; });

  // A HUD that exists inside the headset: a small canvas sprite under the
  // view with hearts, the objective and the score.
  const vrHudCanvas = document.createElement("canvas");
  vrHudCanvas.width = 1024; vrHudCanvas.height = 160;
  const vrHudTex = new THREE.CanvasTexture(vrHudCanvas);
  vrHudTex.colorSpace = THREE.SRGBColorSpace;
  const vrHudMat = new THREE.SpriteMaterial({ map: vrHudTex, transparent: true, depthTest: false, depthWrite: false });
  const vrHud = new THREE.Sprite(vrHudMat);
  vrHud.scale.set(0.9, 0.14, 1);
  vrHud.position.set(0, -0.32, -1.1);
  vrHud.renderOrder = 30;
  vrHud.visible = false;
  camera.add(vrHud);
  let vrHudText = "";
  function drawVrHud(h: GameHud | null) {
    const text = h ? `${"♥".repeat(h.hearts)}${"♡".repeat(Math.max(0, h.maxHearts - h.hearts))}   ${h.objective}   ${h.score} pts${h.timer != null ? `   ${Math.ceil(h.timer)}s` : ""}` : (options.voiceLine?.() ?? "");
    if (text === vrHudText) return;
    vrHudText = text;
    const c = vrHudCanvas.getContext("2d")!;
    c.clearRect(0, 0, 1024, 160);
    if (!text) { vrHudTex.needsUpdate = true; return; }
    c.fillStyle = "rgba(10,14,20,0.7)";
    c.fillRect(0, 20, 1024, 120);
    c.fillStyle = "#f3ecff";
    c.font = "500 44px system-ui, sans-serif";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(text.slice(0, 60), 512, 80);
    vrHudTex.needsUpdate = true;
  }

  // ---- eased look ---------------------------------------------------------
  const look = {
    zenith: new THREE.Color("#3d7fd6"),
    horizon: new THREE.Color("#d7e8f6"),
    sunColor: new THREE.Color("#fff2cf"),
    sunDir: new THREE.Vector3(0.3, 0.8, 0.2),
    night: 0,
    sunI: 2.2,
    hemiI: 0.6,
    fog: 0.004,
    rain: 0,
    snow: 0,
    snowCover: 0,
    petals: 0,
    fireflies: 0,
    clouds: 0.25,
    aurora: 0,
    meteors: 0,
    tint: new THREE.Color("#ffffff"),
    lanterns: 0,
    wet: 0,
    foliage: { tree: new THREE.Color(FOLIAGE.spring.tree), sakura: new THREE.Color(FOLIAGE.spring.sakura), maple: new THREE.Color(FOLIAGE.spring.maple), pine: new THREE.Color(FOLIAGE.spring.pine), bamboo: new THREE.Color(FOLIAGE.spring.bamboo) },
  };
  const ease = (dt: number, k = 1.2) => Math.min(1, dt * k);

  function applyState(dt: number, time: number) {
    const s = state;
    if (s.clockRunning) { state = { ...s, timeOfDay: (s.timeOfDay + dt * (24 / 600)) % 24 }; }
    const t = state.timeOfDay;
    const night = nightness(t);
    const ang = ((t - 6) / 12) * Math.PI; // 0 at 6h, π at 18h
    const elev = Math.sin(ang);
    const sunDir = V.set(Math.cos(ang) * 0.9, elev, -0.35 + Math.cos(ang) * 0.2).normalize();
    const nat = naturalSky(elev, night);
    let zenith = nat.zenith, horizon = nat.horizon;
    if (s.palette) {
      const dim = 1 - night * 0.75;
      zenith = new THREE.Color(s.palette.sky).multiplyScalar(dim);
      horizon = new THREE.Color(s.palette.horizon).multiplyScalar(dim + 0.1);
    }
    // Weather greys the sky.
    const grey = { clear: 0, cloudy: 0.55, rain: 0.75, storm: 0.9, snow: 0.6, fog: 0.7 }[s.weather];
    const greyC = C.setRGB(0.62, 0.66, 0.72).lerp(C2.setRGB(0.08, 0.09, 0.12), night);
    zenith = zenith.clone().lerp(greyC, grey * 0.8);
    horizon = horizon.clone().lerp(greyC, grey * 0.6);
    if (s.weather === "fog") horizon.lerp(C.setRGB(0.85, 0.87, 0.9).lerp(C2.setRGB(0.1, 0.11, 0.14), night), 0.5);

    const k = ease(dt);
    look.zenith.lerp(zenith, k);
    look.horizon.lerp(horizon, k);
    look.sunColor.lerp(nat.sun, k);
    look.sunDir.lerp(sunDir, k).normalize();
    look.night += (night - look.night) * k;
    // The sun stays strong when it is low (golden hour is the best light of
    // the day, not a dim one) and fades out only as it touches the horizon.
    // The sky fills shadows generously, so a house's shade is cool and
    // readable rather than black.
    const sunUp = Math.max(0, Math.min(1, (elev + 0.04) / 0.14));
    look.sunI += ((0.4 + 2.1 * Math.sqrt(Math.max(0, elev))) * sunUp * (1 - grey * 0.75) - look.sunI) * k;
    look.hemiI += ((0.55 + Math.max(0, elev) * 0.35) * (1 - night * 0.62) - look.hemiI) * k;
    look.fog += (fogDensity(s) - look.fog) * k;
    look.rain += (rainAmount(s) - look.rain) * k;
    look.snow += (snowAmount(s) - look.snow) * k;
    look.snowCover += (snowCover(s) - look.snowCover) * ease(dt, 0.5);
    look.petals += (petalDensity(s) - look.petals) * k;
    look.fireflies += ((firefliesOn(s) ? 1 : 0) - look.fireflies) * k;
    look.clouds += (cloudAmount(s) - look.clouds) * k;
    look.aurora += (s.aurora - look.aurora) * k;
    look.meteors += (s.meteors - look.meteors) * k;
    look.lanterns += ((lanternsOn(s) ? 1 : 0) - look.lanterns) * k;
    look.wet += ((s.weather === "rain" || s.weather === "storm" ? 1 : 0) - look.wet) * ease(dt, 0.4);
    const tintTarget = s.palette ? new THREE.Color(s.palette.ground) : C.setRGB(1, 1, 1);
    look.tint.lerp(tintTarget, k);
    const fol = FOLIAGE[s.season];
    for (const key of ["tree", "sakura", "maple", "pine", "bamboo"] as const) look.foliage[key].lerp(C.set(fol[key]), ease(dt, 0.7));

    // Apply.
    sky.apply({ zenith: look.zenith, horizon: look.horizon, sunDir: look.sunDir, sunColor: look.sunColor, night: look.night, aurora: look.aurora, clouds: look.clouds, meteors: look.meteors });
    (scene.fog as THREE.FogExp2).color.copy(look.horizon);
    (scene.fog as THREE.FogExp2).density = look.fog;
    sun.color.copy(look.sunColor);
    sun.intensity = look.sunI;
    sun.position.copy(look.sunDir).multiplyScalar(120).add(player.position);
    sun.target.position.copy(player.position);
    moonLight.intensity = look.night * 0.35;
    moonLight.position.copy(look.sunDir).multiplyScalar(-100).add(player.position);
    moonLight.position.y = Math.abs(moonLight.position.y) + 40;
    hemi.intensity = look.hemiI + look.lanterns * 0.05;
    hemi.color.copy(look.horizon).lerp(C.setRGB(1, 1, 1), 0.3);
    hemi.groundColor.copy(look.tint).multiply(C.setRGB(0.35, 0.45, 0.28));
    terrain.setSnow(look.snowCover);
    terrain.setTint(look.tint);
    terrain.setWater(s.flood * 7);
    terrain.setWet(look.wet);
    rain.setDensity(look.rain);
    snow.setDensity(look.snow);
    petals.setDensity(look.petals);
    petalMat.color.set(s.season === "autumn" ? "#e0742a" : "#ffc0dc");
    fireflies.setDensity(look.fireflies);
    const groundCol = look.tint.clone();
    for (const f of foliageMats) f.mat.color.copy(look.foliage[f.kind]).multiply(groundCol).lerp(C.setRGB(0.92, 0.94, 0.97), look.snowCover * 0.5);
    for (const f of spawnMats) f.mat.color.copy(look.foliage[f.kind]).multiply(groundCol).lerp(C.setRGB(0.92, 0.94, 0.97), look.snowCover * 0.5);
    renderer.toneMappingExposure = 1.05 - look.night * 0.25 + flash * 0.6;
    ambience.set({ rain: look.rain, wind: s.wind, night: look.night, storm: s.weather === "storm" ? 1 : 0, water: 0.6 });
  }

  // ---- loop -----------------------------------------------------------------
  const clock = new THREE.Clock();
  let time = 0;
  let disposed = false;
  let lastHitFlash = 0;
  const propCtx = { wind: 0, windDir: 0, season: state.season, lanterns: false, night: 0, snow: 0 };

  function frame() {
    if (disposed) return;
    const dt = Math.min(0.1, clock.getDelta());
    time += dt;
    flash = Math.max(0, flash - dt * 2.5);
    lastHitFlash = Math.max(0, lastHitFlash - dt * 3);
    const s = state;
    const xr = renderer.xr.isPresenting ? renderer.xr.getSession() : null;
    const eye = 1 / s.giant;
    player.update(dt, heightAt, { gravity: s.gravity, speed: s.speed * eye, eye, xr, xrCamera: xr ? renderer.xr.getCamera() : null });
    applyState(dt, time);
    propCtx.wind = s.wind; propCtx.windDir = s.windDirection; propCtx.season = s.season; propCtx.lanterns = look.lanterns > 0.5; propCtx.night = look.night; propCtx.snow = look.snowCover;
    for (const p of fixed) p.update?.(dt, time, propCtx);
    for (const sp of spawned.values()) {
      sp.obj.update?.(dt, time, propCtx);
      const target = sp.prop.scale;
      const cur = sp.obj.group.scale.x;
      if (Math.abs(cur - target) > 0.002) sp.obj.group.scale.setScalar(cur + (target - cur) * Math.min(1, dt * 4));
    }
    sky.update(dt, time, s.wind, s.windDirection);
    terrain.update(dt, time);
    grass.update(dt, time, player.position, { windDir: s.windDirection, wind: s.wind, snow: look.snowCover, tint: look.tint, sunDir: look.sunDir, sunColor: look.sunColor, night: look.night });
    V.copy(player.position);
    V.y += 1.6;
    rain.update(dt, time, V, s.wind, s.windDirection);
    snow.update(dt, time, V, s.wind, s.windDirection);
    petals.update(dt, time, V, s.wind, s.windDirection);
    fireflies.update(dt, time, V, s.wind * 0.3, s.windDirection);
    bursts.update(dt);
    lightning.update(dt, s.weather === "storm", () => ambience.play("thunder"));
    if (lightning.flash > 0.75) flash = Math.max(flash, 0.5);
    const before = fireballs.fizzled();
    const hit = fireballs.update(dt, { on: s.fireballs.on, rate: s.fireballs.rate, wet: fireballsFizzle(s), player: V, heightAt });
    if (fireballs.fizzled() !== before) { ambience.play("fizz"); events.onFizzle?.(); }
    if (hit) {
      state = { ...state, hits: state.hits + 1 };
      lastHitFlash = 1;
      bursts.spawn("sparkle", hit.x, heightAt(hit.x, hit.z) + 1, hit.z);
      if (!game.playerHit()) ambience.play("hit");
      events.onHit?.(state.hits);
      events.onState?.(state);
    }
    game.update(dt, time, lanternSpots);
    room?.presence(player.position.x, player.position.y, player.position.z, player.yaw(), vibey.bodyId(), options.talking?.() ?? false);
    peers.update(dt, time, heightAt);
    const gh = game.hud();
    events.onGame?.(gh);
    vrHud.visible = renderer.xr.isPresenting;
    if (vrHud.visible) drawVrHud(gh);
    vibey.update(dt, time, player.position, player.yaw(), heightAt);
    renderer.toneMappingExposure += lastHitFlash * 0.5;
    renderer.render(scene, camera);
  }
  renderer.setAnimationLoop(frame);

  // A headset has a mobile GPU and two eyes. Halve the shadow map for the
  // session and put it back after.
  const onXrStart = () => {
    grass.setQuality(9, 22);
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.needsUpdate = true;
  };
  const onXrEnd = () => {
    grass.setQuality(coarse ? 10 : 22, coarse ? 24 : 32);
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.needsUpdate = true;
    onResize();
  };
  renderer.xr.addEventListener("sessionstart", onXrStart);
  renderer.xr.addEventListener("sessionend", onXrEnd);

  const onResize = () => {
    if (renderer.xr.isPresenting) return;
    const w = container.clientWidth, h = container.clientHeight;
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    applyFov();
    renderer.setSize(w, h);
  };
  window.addEventListener("resize", onResize);

  const world: MagicianWorld = {
    store,
    vibey,
    run(name, args) {
      const r = runTool(name, args, store);
      if (r.toast) {
        events.onToast?.(r.toast);
        // A spell landed: sparkles at Vibey's hands and a flourish, unless the
        // model chose its own gesture this turn.
        bursts.spawn("sparkle", vibey.position.x, vibey.position.y + 1.2, vibey.position.z);
        if (name !== "emote" && performance.now() - lastEmote > 1500) {
          lastEmote = performance.now();
          vibey.emote(CAST_GESTURES[Math.floor(Math.random() * CAST_GESTURES.length)]);
        }
      }
      return r;
    },
    cast(text) {
      const calls = castSpell(text);
      return calls.map((c) => world.run(c.name, c.args));
    },
    getState: () => state,
    setStick: (x, y) => player.setStick(x, y),
    jump: () => player.jump(),
    fire: () => fireFromCamera(),
    setZoom: (z) => { zoomLevel = Math.max(0.6, Math.min(1.8, z)); applyFov(); },
    zoom: () => zoomLevel,
    canvas: () => renderer.domElement,
    setSupporters: (lines) => board.setLines("Supporters of Hoshimura", lines),
    audioStream: () => ambience.stream(),
    startGame: (id) => game.start(id),
    stopGame: () => game.stop(),
    gameHud: () => game.hud(),
    vrButton() {
      const b = VRButton.createButton(renderer);
      b.style.position = "static";
      b.style.margin = "0";
      b.style.left = "auto";
      b.style.bottom = "auto";
      return b;
    },
    setMuted(m) { ambience.setMuted(m); },
    wake() { ambience.resume(); },
    snapshot() {
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL("image/jpeg", 0.85);
    },
    inVR: () => renderer.xr.isPresenting,
    dispose() {
      disposed = true;
      renderer.setAnimationLoop(null);
      window.removeEventListener("resize", onResize);
      player.dispose();
      vibey.dispose();
      ambience.dispose();
      terrain.dispose();
      grass.dispose();
      sky.dispose();
      rain.dispose(); snow.dispose(); petals.dispose(); fireflies.dispose(); bursts.dispose(); fireballs.dispose();
      sign.dispose();
      board.dispose();
      for (const p of fixed) p.dispose();
      forest.dispose();
      rayGeo.dispose();
      rayMat.dispose();
      game.dispose();
      room?.close();
      room = null;
      peers.dispose();
      container.removeEventListener("mousedown", onDown);
      container.removeEventListener("mouseup", onUp);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchend", onTouchEnd);
      controllers.forEach((c, i) => { c.removeEventListener("selectstart", selectHandlers[i].h); c.removeEventListener("selectend", selectHandlers[i].e); });
      for (const t of holdTimers.values()) clearTimeout(t);
      vrHudTex.dispose();
      vrHudMat.dispose();
      renderer.xr.removeEventListener("sessionstart", onXrStart);
      renderer.xr.removeEventListener("sessionend", onXrEnd);
      for (const s of spawned.values()) s.obj.dispose();
      disposeSharedProps();
      crater.geometry.dispose();
      (crater.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      if (window.__magician?.world === world) delete window.__magician;
    },
  };

  // Debug and test hook: the only way to see this world from a script, since
  // page.screenshot() cannot composite a software WebGL canvas.
  window.__magician = {
    world,
    state: () => state,
    apply: (p: Patch) => store.patch(p),
    run: (name: string, args: unknown) => world.run(name, args),
    cast: (text: string) => world.cast(text),
    snapshot: () => world.snapshot(),
    teleport: (x: number, z: number, yaw?: number) => player.teleport(x, z, yaw),
    counts: () => ({ props: spawned.size, fixed: fixed.length, fireballs: fireballs.count(), fizzled: fireballs.fizzled(), hits: state.hits }),
    caption: (t: string) => vibey.setCaption(t),
    become: (id: string) => store.become(id),
    game: () => game.hud(),
    fire: () => fireFromCamera(),
    companion: () => vibey.debug(),
    player: () => ({ x: player.position.x, y: player.position.y, z: player.position.z, yaw: player.yaw(), fov: camera.fov, zoom: zoomLevel }),
    peers: () => ({ connected: room?.connected ?? false, count: peers.count(), id: room?.id ?? null }),
    grass: () => grass.stats(),
    settle: (seconds = 6) => {
      // Fast-forward the eased look, for scripts on machines that render at
      // one frame a second. Physics and the player are left alone.
      const steps = Math.ceil(seconds / 0.1);
      V.copy(player.position); V.y += 1.6;
      for (let i = 0; i < steps; i++) {
        time += 0.1;
        applyState(0.1, time);
        rain.update(0.1, time, V, state.wind, state.windDirection);
        snow.update(0.1, time, V, state.wind, state.windDirection);
        petals.update(0.1, time, V, state.wind, state.windDirection);
        fireflies.update(0.1, time, V, state.wind * 0.3, state.windDirection);
        propCtx.lanterns = look.lanterns > 0.5;
        grass.update(0.1, time, player.position, { windDir: state.windDirection, wind: state.wind, snow: look.snowCover, tint: look.tint, sunDir: look.sunDir, sunColor: look.sunColor, night: look.night });
        for (const p of fixed) p.update?.(0.1, time, propCtx);
        for (const sp of spawned.values()) { sp.obj.update?.(0.1, time, propCtx); sp.obj.group.scale.setScalar(sp.prop.scale); }
        bursts.update(0.1);
        fireballs.update(0.1, { on: state.fireballs.on, rate: state.fireballs.rate, wet: fireballsFizzle(state), player: V, heightAt });
        game.update(0.1, time, lanternSpots);
      }
    },
  };

  return world;
}

declare global {
  interface Window {
    __magician?: {
      world: MagicianWorld;
      state(): WorldState;
      apply(p: Patch): void;
      run(name: string, args: unknown): ToolResult;
      cast(text: string): ToolResult[];
      snapshot(): string;
      teleport(x: number, z: number, yaw?: number): void;
      counts(): { props: number; fixed: number; fireballs: number; fizzled: number; hits: number };
      caption(t: string): void;
      become(id: string): void;
      game(): GameHud | null;
      fire(): void;
      companion(): ReturnType<Vibey["debug"]>;
      player(): { x: number; y: number; z: number; yaw: number; fov: number; zoom: number };
      peers(): { connected: boolean; count: number; id: string | null };
      grass(): { chunks: number; blades: number };
      settle(seconds?: number): void;
    };
  }
}
