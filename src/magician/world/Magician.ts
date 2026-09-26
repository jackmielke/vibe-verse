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
import { fbm, heightAt, riverCentre, riverDistance, WATER_LEVEL } from "./noise";
import { createTerrain, pathAt } from "./terrain";
import { createGrass } from "./grass";
import { createSky } from "./sky";
import { buildBoard, buildForest, buildProp, buildSign, disposeSharedProps, FOLIAGE, type PropObject, type TreeKind } from "./props";
import { createBursts, createFireflies, createLightning, createPetals, createRain, createSnow } from "./weather";
import { createFireballs } from "./fireballs";
import { createAmbience, type Surface } from "./audio";
import { buildTaikoBridge, createRiverLife } from "./bridge";
import { createMagicScreen } from "./screen";
import { createSpellFx, spellColour } from "./spell";
import { createHotaru } from "./hotaru";
import { CHANNELS, findChannel } from "../screen/library";
import { writeProgram } from "../screen/coder";
import { NO_INPUT } from "../screen/runtime";
import { createVibey, type Vibey } from "./vibey";
import { readCompanion, writeCompanion } from "../companions";
import { createGameRunner, type HouseState } from "../game/runner";
import { MODE_INFO, type GameHud, type GameModeId } from "../game/types";
import { joinRoom, readNetMode, readRoom, type PeerPresence, type Room } from "../net";
import { createPeers } from "./peers";
import { createValleyTag } from "./tag";
import { createAvatar } from "@/oni/world/avatars";
import type { Hud } from "@/oni/world/Oni";
import { createPlayer } from "./player";

export interface MagicianOptions {
  /** The visitor's display name for other players. */
  name?: string;
  /** Whether the voice session is live, for the talking ring on our ghost. */
  talking?(): boolean;
  /** One line about the voice for the headset HUD: "pinch to talk", "listening", … */
  voiceLine?(): string;
  /** The visitor's roster character: what everybody else sees them as. */
  char?: string;
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
  /** What there is to do right here (feed the koi, float a wish, ...). */
  onActions?(actions: WorldAction[]): void;
  /** A game of tag: the banner's numbers, or null when none is on. */
  onTag?(hud: Hud | null): void;
}

/** Something to do where the visitor is standing, shown as a button. */
export interface WorldAction {
  id: "feed" | "wish" | "play" | "program" | "sit" | "pet" | "channel";
  label: string;
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
  /** Do one of the actions offered by `onActions`. `text` is the wish, or what to put on the screen. */
  act(id: WorldAction["id"], text?: string): void;
  actions(): WorldAction[];
  setMusic(on: boolean): void;
  /** Render one frame and return it as a data URL. For scripts. */
  snapshot(): string;
  inVR(): boolean;
  /** Start a game of tag round the village. False when alone. */
  startTag(): boolean;
  /** Change who we look like. */
  setChar(id: string): void;
  /** Over the shoulder (true) or through your own eyes. */
  setThirdPerson(on: boolean): void;
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
  // A moonlit night, not a black one: the horizon keeps a blue mist the
  // hills stand against, which is most of what makes a night valley deep.
  const nightC = { z: new THREE.Color("#060c24"), h: new THREE.Color("#23335e") };
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
    // The companion stands in front of the visitor, a touch right of centre, so
    // they read its caption without looking away; on a narrow screen, nearer
    // the middle and further off,
    // so the caption above its head stays on screen.
    const narrow = Math.max(0, Math.min(1, (1.2 - aspect) / 0.8));
    vibey.setStance(4 + narrow * 0.6, 0.55 - narrow * 0.35);
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
  const moonLight = new THREE.DirectionalLight("#a9bcff", 0);
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
  function place(kind: Parameters<typeof buildProp>[0], x: number, z: number, yaw = Math.random() * Math.PI * 2, scale = 1, color?: string, opts: { open?: boolean } = {}): PropObject {
    const p = buildProp(kind, state0.season, color, opts);
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
  // The two facing the square can be walked into. See interior.ts.
  houseSpots.forEach(([x, z, yaw], i) => { const p = place("house", x, z, yaw, 1, undefined, { open: i < 2 }); houses.push({ x, z, group: p.group, hp: 3, alive: true, fire: null }); });
  const openHouses = fixed.filter((p) => p.house);
  /** A point in an open house's own frame. */
  const houseLocal = (p: PropObject, x: number, z: number) => {
    const g = p.group, c = Math.cos(g.rotation.y), sn = Math.sin(g.rotation.y);
    const dx = x - g.position.x, dz = z - g.position.z;
    return { lx: c * dx - sn * dz, lz: sn * dx + c * dz, c, sn };
  };
  /** The floor of an open house at (x, z), in world height, or -Infinity outside it. */
  const houseFloorAt = (x: number, z: number): number => {
    let best = -Infinity;
    for (const p of openHouses) {
      if (!p.group.visible) continue;
      const { lx, lz } = houseLocal(p, x, z);
      const r = p.house!.room;
      const y0 = p.group.position.y;
      let h = -Infinity;
      if (Math.abs(lx) < r.w / 2 && Math.abs(lz) < r.d / 2) h = r.FH + 0.01;
      else if (Math.abs(lx) < r.w / 2 + 0.15 && lz > 0 && lz < r.d / 2 + 0.95) h = r.FH - 0.015;
      else if (Math.abs(lx) < r.w / 2 + 0.25 && Math.abs(lz) < r.d / 2 + 0.25) h = 0.4;
      else if (Math.abs(lx - r.doorX) < 0.45 && Math.abs(lz - (r.d / 2 + 1.25)) < 0.25) h = 0.18;
      if (h > -Infinity) best = Math.max(best, y0 + h);
    }
    return best;
  };
  /** The open house somebody is inside, if any. */
  const insideHouse = (x: number, z: number): PropObject | null => {
    for (const p of openHouses) {
      if (!p.group.visible) continue;
      const { lx, lz } = houseLocal(p, x, z);
      if (Math.abs(lx) < p.house!.room.w / 2 && Math.abs(lz) < p.house!.room.d / 2) return p;
    }
    return null;
  };
  // Footprints the player is pushed out of, so the camera never ends up
  // inside a wall. A burnt house stops blocking: its group is hidden.
  const BODY = 0.35;
  const trunks: Array<{ x: number; z: number; r: number }> = [];
  const solveWalls = (pos: THREE.Vector3) => {
    bridge.solve(pos);
    // Open houses: their walls are segments with a doorway between them.
    for (const p of openHouses) {
      if (!p.group.visible) continue;
      const g = p.group;
      const { lx, lz, c, sn } = houseLocal(p, pos.x, pos.z);
      if (Math.abs(lx) > p.house!.room.w / 2 + 1.5 || Math.abs(lz) > p.house!.room.d / 2 + 1.5) continue;
      let x = lx, z = lz;
      for (const [x1, z1, x2, z2] of p.house!.walls) {
        const vx = x2 - x1, vz = z2 - z1;
        const len2 = vx * vx + vz * vz;
        const t = Math.max(0, Math.min(1, ((x - x1) * vx + (z - z1) * vz) / len2));
        const qx = x1 + vx * t, qz = z1 + vz * t;
        const ex = x - qx, ez = z - qz;
        const dd = Math.hypot(ex, ez);
        const R = BODY + 0.05;
        if (dd < R && dd > 1e-6) { x = qx + (ex / dd) * R; z = qz + (ez / dd) * R; }
        else if (dd <= 1e-6) { z = qz + R; }
      }
      if (x !== lx || z !== lz) { pos.x = g.position.x + c * x + sn * z; pos.z = g.position.z - sn * x + c * z; }
    }
    for (const t of trunks) {
      const dx = pos.x - t.x, dz = pos.z - t.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= t.r * t.r || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      pos.x = t.x + (dx / d) * t.r;
      pos.z = t.z + (dz / d) * t.r;
    }
    for (const p of fixed) {
      if (!p.solid || !p.group.visible) continue;
      const g = p.group;
      const dx = pos.x - g.position.x, dz = pos.z - g.position.z;
      const sc = g.scale.x;
      const hx = p.solid[0] * sc + BODY, hz = p.solid[1] * sc + BODY;
      if (dx * dx + dz * dz > (hx + hz) * (hx + hz)) continue;
      const c = Math.cos(g.rotation.y), sn = Math.sin(g.rotation.y);
      // Into the prop's frame (three's y rotation: local x = c*dx - s*dz).
      const lx = c * dx - sn * dz, lz = sn * dx + c * dz;
      const px = hx - Math.abs(lx), pz = hz - Math.abs(lz);
      if (px <= 0 || pz <= 0) continue;
      let nx = lx, nz = lz;
      if (px < pz) nx = Math.sign(lx || 1) * hx; else nz = Math.sign(lz || 1) * hz;
      pos.x = g.position.x + c * nx + sn * nz;
      pos.z = g.position.z - sn * nx + c * nz;
    }
  };
  const lanternSpots: Array<{ x: number; z: number }> = [];
  // Shrine on its hill, torii on the way, the bridge, the pagoda far side.
  place("shrine", LANDMARKS.shrine.x, LANDMARKS.shrine.z, 0.35, 1.2);
  place("torii", LANDMARKS.torii.x, LANDMARKS.torii.z, 0.1, 1.1);
  place("torii", -40, -48, 0.5, 1);
  place("pagoda", -70, -20, 0.4, 1.1);
  // The drum bridge and the river's life under it. See bridge.ts.
  const BRIDGE_Z = -6;
  const bridge = buildTaikoBridge(BRIDGE_Z);
  scene.add(bridge.group);
  for (const p of bridge.posts) fixed.push(p);
  const river = createRiverLife(BRIDGE_Z);
  scene.add(river.group);
  const hotaru = createHotaru(BRIDGE_Z);
  scene.add(hotaru.points);
  hotaru.setLevel(0);
  const spells = createSpellFx();
  scene.add(spells.group);
  // The Magic Screen at the edge of the square, facing it. See screen.ts.
  const SCREEN_AT = { x: -2, z: -19 };
  const screenCoarse = typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;
  const screen = createMagicScreen({
    x: SCREEN_AT.x, z: SCREEN_AT.z, y: heightAt(SCREEN_AT.x, SCREEN_AT.z), yaw: Math.atan2(-SCREEN_AT.x, -SCREEN_AT.z),
    fps: screenCoarse ? 15 : 24,
    onBeep: (f, sec, type, v) => ambience.beep(f, sec, type, 0.015 + v * 0.05, SCREEN_AT),
  });
  scene.add(screen.prop.group);
  fixed.push(screen.prop);
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
  const forestTrees: Array<{ kind: TreeKind; x: number; z: number; yaw: number; scale: number; far?: boolean }> = [];
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
  // Cedar forest on the hills: the dark sugi stands that make the slopes of a
  // Japanese valley read as mountains rather than green bumps. Cheap far
  // trees, clumped by noise so the slopes have groves and clearings.
  let cedars = 0; tries = 0;
  while (cedars < 700 && tries++ < 9000) {
    const a = Math.random() * Math.PI * 2;
    const r = 70 + Math.random() * 160;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = heightAt(x, z);
    if (h < 12 || h > 110) continue;
    if (fbm(x * 0.018 + 7, z * 0.018 - 3, 3) < 0.45) continue;
    if (Math.abs(x - riverCentre(z)) < 12) continue;
    if (Math.hypot(x - 110, z + 120) < 16) continue;
    forestTrees.push({ kind: "pine", x, z, yaw: Math.random() * 6.28, scale: 1.1 + Math.random() * 0.7, far: true });
    cedars++;
  }
  const forest = buildForest(forestTrees, state0.season);
  // How leafy it is around any point, for the rustle in the wind.
  const LEAF_CELL = 8, LEAF_N = 64;
  const leafGrid = new Float32Array(LEAF_N * LEAF_N);
  for (const t of forestTrees) {
    const i = Math.floor(t.x / LEAF_CELL + LEAF_N / 2), j = Math.floor(t.z / LEAF_CELL + LEAF_N / 2);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const ii = i + a, jj = j + b;
      if (ii >= 0 && jj >= 0 && ii < LEAF_N && jj < LEAF_N) leafGrid[jj * LEAF_N + ii] += a === 0 && b === 0 ? 1 : 0.4;
    }
  }
  const leavesAt = (x: number, z: number) => {
    const i = Math.floor(x / LEAF_CELL + LEAF_N / 2), j = Math.floor(z / LEAF_CELL + LEAF_N / 2);
    if (i < 0 || j < 0 || i >= LEAF_N || j >= LEAF_N) return 0;
    return Math.min(1, leafGrid[j * LEAF_N + i] / 4);
  };
  // Trunks block too; otherwise the camera walks into a crown and the frame
  // is one big leaf.
  for (const t of forestTrees) if (!t.far) trunks.push({ x: t.x, z: t.z, r: 0.45 * t.scale + 0.35 });
  scene.add(forest.group);
  for (const kind of ["tree", "sakura", "maple", "pine"] as const) foliageMats.push({ mat: forest.foliage[kind], kind });
  // The mountain's mouth: where the fireballs come from.
  const crater = new THREE.Mesh(new THREE.CylinderGeometry(6, 9, 3, 12), new THREE.MeshStandardMaterial({ color: "#3a2a26", emissive: "#ff5a1f", emissiveIntensity: 0.25, roughness: 1 }));
  crater.position.set(110, heightAt(110, -120) + 1, -120);
  scene.add(crater);

  // The sign by the bridge.
  const sign = buildSign();
  sign.group.position.set(12, heightAt(12, 1.5), 1.5);
  sign.group.rotation.y = -0.6;
  scene.add(sign.group);

  // ---- grass -------------------------------------------------------------
  // Everywhere the ground is meadow: not on paths, water, paddies, the lake,
  // under a building or up the bare mountain. Density eases off near each
  // edge so the field thins out instead of stopping at a line.
  const noGrass: Array<{ x: number; z: number; r: number }> = [
    ...houseSpots.map(([x, z]) => ({ x, z, r: 5 })),
    { x: LANDMARKS.shrine.x, z: LANDMARKS.shrine.z, r: 4.5 },
    { x: SCREEN_AT.x, z: SCREEN_AT.z, r: 4.5 },
    { x: -70, z: -20, r: 3.5 },
    { x: 62, z: 12, r: 2.2 },
    { x: 6, z: -3, r: 1.6 },
  ];
  const grassDensity = (x: number, z: number): number => {
    const h = heightAt(x, z);
    if (h < WATER_LEVEL + 0.35) return 0;
    let d = 1;
    d *= Math.min(1, Math.max(0, (riverDistance(x, z) - 5) / 4));
    // A worn edge, not a ruled line: the path's boundary wanders, and a few
    // tufts survive in the middle of the dirt.
    const ragged = (fbm(x * 0.45 + 11, z * 0.45 - 4, 2) - 0.5) * 0.7;
    d *= 1 - Math.min(0.94, Math.max(0, pathAt(x, z) + ragged * Math.min(1, pathAt(x, z) * 4)) * 1.6);
    const paddy = Math.hypot((x - 42) / 1.4, z - 30);
    d *= Math.min(1, Math.max(0, (paddy - 33) / 4));
    d *= Math.min(1, Math.max(0, (Math.hypot(x - 60, z - 56) - 23) / 4));
    for (const o of noGrass) d *= Math.min(1, Math.max(0, (Math.hypot(x - o.x, z - o.z) - o.r + ragged * 2.2) / 2.2));
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

  // ---- lamp light pool -----------------------------------------------------
  // Every lantern and window glows by its own material; only the few nearest
  // the player also throw real light on the ground. The pool is a fixed
  // number of lights, so three never recompiles a shader as the player walks.
  const LAMP_POOL = 4;
  const lampLights: THREE.PointLight[] = [];
  for (let i = 0; i < LAMP_POOL; i++) {
    const l = new THREE.PointLight("#ffb04a", 0, 11, 2);
    lampLights.push(l);
    scene.add(l);
  }
  const lampWorld = new Map<PropObject, THREE.Vector3>();
  const lampOf = (p: PropObject): THREE.Vector3 | null => {
    if (!p.lamp) return null;
    let v = lampWorld.get(p);
    if (!v) { p.group.updateMatrixWorld(true); v = p.group.localToWorld(p.lamp.at.clone()); lampWorld.set(p, v); }
    return v;
  };
  const lampRank: Array<{ p: PropObject; d: number }> = [];
  let lampTick = 0;
  function updateLampPool(dt: number) {
    lampTick -= dt;
    if (lampTick <= 0) {
      // Re-rank a few times a second; lamps do not move.
      lampTick = 0.25;
      lampRank.length = 0;
      const consider = (p: PropObject) => { const v = lampOf(p); if (v) lampRank.push({ p, d: v.distanceToSquared(player.position) }); };
      for (const p of fixed) consider(p);
      for (const sp of spawned.values()) consider(sp.obj);
      lampRank.sort((a, b) => a.d - b.d);
    }
    for (let i = 0; i < LAMP_POOL; i++) {
      const l = lampLights[i];
      const r = lampRank[i];
      if (!r || !r.p.lamp) { l.intensity = 0; continue; }
      const v = lampOf(r.p)!;
      l.position.copy(v);
      l.color.copy(r.p.lamp.color);
      l.intensity = r.p.lamp.level * r.p.lamp.power;
    }
  }

  // ---- conjured things ------------------------------------------------------
  const spawned = new Map<number, { obj: PropObject; prop: Prop }>();
  const spawnMats: Array<{ mat: THREE.MeshStandardMaterial; kind: "tree" | "sakura" | "maple" | "pine" | "bamboo" }> = [];
  function syncProps(props: Prop[], season: WorldState["season"]) {
    const ids = new Set(props.map((p) => p.id));
    for (const [id, s] of spawned) {
      if (!ids.has(id)) { scene.remove(s.obj.group); s.obj.dispose(); spawned.delete(id); lampWorld.delete(s.obj); }
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
  const rays: THREE.Line[] = [];
  for (let i = 0; i < 2; i++) {
    const grip = renderer.xr.getControllerGrip(i);
    grip.add(controllerFactory.createControllerModel(grip));
    player.rig.add(grip);
    const ctrl = renderer.xr.getController(i);
    const ray = new THREE.Line(rayGeo, rayMat);
    ray.scale.z = 3;
    ctrl.add(ray);
    rays.push(ray);
    player.rig.add(ctrl);
    controllers.push(ctrl);
  }
  const vibey = createVibey(readCompanion());
  scene.add(vibey.group);
  applyFov();
  const ambience = createAmbience();
  ambience.setChimes(bridge.chimes);

  // ---- other players --------------------------------------------------------
  const peers = createPeers();
  scene.add(peers.group);
  let room: Room | null = null;
  let applyingRemote = false;
  const myId = Math.random().toString(36).slice(2, 10);
  let myChar = options.char ?? "toadstool";
  let peerList: PeerPresence[] = [];
  void joinRoom({
    id: myId,
    onGame: (m) => tag.handle(m),
    mode: readNetMode(),
    room: readRoom(),
    name: options.name ?? "visitor",
    onPatch: (p) => { applyingRemote = true; try { store.patch(p); } finally { applyingRemote = false; } },
    onFull: (s) => { applyingRemote = true; try { store.patch({ ...s, hits: state.hits }); } finally { applyingRemote = false; } },
    onPeers: (list) => { peerList = list; peers.sync(list); events.onPeers?.(list, true); },
    onJoin: (n) => events.onToast?.(`${n} arrived`),
    onLeave: (n) => events.onToast?.(`${n} left`),
    currentState: () => state,
  }).then((r) => {
    if (disposed) { r.close(); return; }
    room = r;
    events.onPeers?.([], r.connected);
  });

  // ---- tag, and our own body -------------------------------------------------
  // Everybody else sees us as our roster character; over the shoulder, so do we.
  const self = createAvatar({ id: myId, name: options.name ?? "you", char: myChar, noTag: true });
  scene.add(self.group);
  let thirdPerson = true;
  let camBack = 0;
  let lastSelf = new THREE.Vector3();
  let selfSpeed = 0;
  const tag = createValleyTag({
    scene,
    myId,
    name: () => options.name ?? "you",
    char: () => myChar,
    room: () => room,
    peerList: () => room?.peers() ?? peerList,
    peers,
    me: () => player.position,
    teleport: (x, z, yaw) => { player.teleport(x, z, yaw); solveWalls(player.position); },
    groundAt: (x, z) => groundAt(x, z),
    onFeed: (t) => events.onToast?.(t),
    onNotify: (t) => events.onNotify?.(t),
  });
  let lastTagHud: Hud | null = null;

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
    teleport: (x, z, yaw) => { player.teleport(x, z, yaw); solveWalls(player.position); },
    houses,
    lightning: () => lightning.flash,
    time: () => time,
  });
  let prevWishes = 0;
  const store: MagicianStore = {
    get: () => state,
    patch(p: Patch) {
      state = applyPatch(state, p);
      if (p.props) syncProps(state.props, state.season);
      if (p.wishes) {
        if (!applyingRemote && state.wishes.length > prevWishes) vibey.emote("Wave");
        river.syncWishes(state.wishes);
      }
      prevWishes = state.wishes.length;
      if (p.screen !== undefined) syncScreen();
      if (p.screenWriting !== undefined && !screenBusy) {
        const w = state.screenWriting;
        screen.writing(w && Date.now() - w.at < 60_000 ? { request: w.request, code: w.code } : null);
      }
      if (p.sign !== undefined) sign.setText(state.sign);
      events.onState?.(state);
      // Our own patches go to the room; theirs came from it.
      if (!applyingRemote && room?.connected) room.patch(p);
    },
    playerPosition: () => ({ x: player.position.x, z: player.position.z, yaw: player.yaw() }),
    teleport(x, z, yaw) { player.teleport(x, z, yaw); solveWalls(player.position); },
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
    programScreen(request, change) {
      if (screenBusy) return "The screen is already being written; it will be there in a moment.";
      // Walk the visitor over so they see it being made.
      if (Math.hypot(player.position.x - SCREEN_AT.x, player.position.z - SCREEN_AT.z) > 28) {
        const l = LANDMARKS.screen;
        player.teleport(l.x, l.z, l.yaw);
      }
      const channel = change ? null : findChannel(request);
      void writeScreen(request, change && state.screen ? state.screen.code : null, null);
      if (channel && request.split(/\s+/).length <= 7) return `The Magic Screen now shows ${channel.title}.`;
      return change
        ? "Changing the program on the Magic Screen now; the new version lands in about ten seconds and everyone can watch the code being written."
        : "Writing it for the Magic Screen now; it appears in about ten seconds and everyone can watch the code being written. Say something fun meanwhile.";
    },
    zombieTag() {
      return tag.start()
        ? "Zombie tag started for everyone in the valley: one zombie, everybody else runs, last human standing wins. It begins in five seconds."
        : "Zombie tag needs at least two people in the valley. Ask the visitor to invite a friend with the invite button.";
    },
    feedKoi() {
      if (!onBridge()) {
        // Downstream from the top of the arch: the koi below, the lanterns' way.
        const c = bridge.centre;
        const slope = riverCentre(c.z + 0.5) - riverCentre(c.z - 0.5);
        // A step off the middle, so the centre post is not in the middle of the view.
        const ux = 1 / Math.hypot(1, slope), uz = -slope / Math.hypot(1, slope);
        player.teleport(c.x + ux * 1.1, c.z + uz * 1.1, Math.atan2(-slope, -1));
        player.position.y = c.y;
      }
      river.feed(player.position, player.yaw());
      ambience.play("whoosh", { x: player.position.x, z: player.position.z });
      return "Food is on the water under the drum bridge and the koi are racing for it.";
    },
    burst(kind, x, z) {
      const px = x ?? player.position.x - Math.sin(player.yaw()) * 3;
      const pz = z ?? player.position.z - Math.cos(player.yaw()) * 3;
      if (kind === "flash") { flash = 1; bursts.spawn("sparkle", px, heightAt(px, pz), pz); }
      else bursts.spawn(kind, px, heightAt(px, pz), pz);
    },
  };
  sign.setText(state.sign);

  // ---- the magic screen's programs ------------------------------------------------
  // Only the device that asked talks to the coder; everyone else gets the
  // finished program (and a draft every second and a half) through the room.
  let screenBusy = false;
  let screenShown = -1;
  let screenMine = 0;
  let screenFixes = 0;
  function syncScreen() {
    const p = state.screen;
    const key = p ? p.at : 0;
    if (key === screenShown) return;
    screenShown = key;
    screenError = null;
    if (p) screen.run(p.code, p.at, p.title);
    else screen.run(CHANNELS[0].code, Date.now(), CHANNELS[0].title);
  }
  async function writeScreen(request: string, previous: string | null, error: string | null): Promise<void> {
    screenBusy = true;
    const at = Date.now();
    const channel = previous || error ? null : findChannel(request);
    // A plain "put pong on the screen" is a channel we already have: instant.
    if (channel && request.split(/\s+/).length <= 7) {
      screenBusy = false;
      store.patch({ screen: { code: channel.code, title: channel.title, request, at }, screenWriting: null });
      ambience.play("sparkle", SCREEN_AT);
      return;
    }
    screen.writing({ request: error ? `fixing: ${request}` : request, code: "" });
    store.patch({ screenWriting: { request, code: "", at } });
    let lastSent = 0;
    try {
      const prog = await writeProgram({ request, previous, error }, (draft) => {
        screen.writing({ request: error ? `fixing: ${request}` : request, code: draft });
        const now = performance.now();
        if (now - lastSent > 1500) { lastSent = now; store.patch({ screenWriting: { request, code: draft.slice(-1400), at } }); }
      });
      if (disposed) return;
      screenMine = Date.now();
      if (!error) screenFixes = 0;
      screen.writing(null);
      store.patch({ screen: { code: prog.code, title: prog.title, request, at: screenMine }, screenWriting: null });
      ambience.play("sparkle", SCREEN_AT);
      bursts.spawn("sparkle", SCREEN_AT.x, heightAt(SCREEN_AT.x, SCREEN_AT.z) + 3, SCREEN_AT.z);
      vibey.emote("ThumbsUp");
      events.onToast?.(`📺 ${prog.title}`);
      events.onNotify?.(`The Magic Screen now shows "${prog.title}"${error ? " (fixed)" : ""}. Say so in one short, delighted line${/game|play|catch|snake|pong|quiz/i.test(request) ? "; they can walk up to it and press Play" : ""}.`);
    } catch (err) {
      if (disposed) return;
      screen.writing(null);
      store.patch({ screenWriting: null });
      const fallback = findChannel(request);
      if (fallback && !previous) {
        store.patch({ screen: { code: fallback.code, title: fallback.title, request, at: Date.now() } });
        events.onNotify?.(`The screen's coder could not be reached, so the screen shows the "${fallback.title}" channel instead. Mention it lightly.`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        events.onToast?.("📺 the spell fizzled");
        events.onNotify?.(`Writing the screen program failed (${msg.slice(0, 160)}). Tell the visitor in one short line and offer to try again.`);
      }
    } finally {
      screenBusy = false;
    }
  }
  // A program we wrote that falls over gets one automatic repair.
  let screenError: string | null = null;
  screen.onError = (message) => {
    screenError = message;
    const p = state.screen;
    if (!p || p.at !== screenMine || screenBusy || screenFixes >= 1) return;
    screenFixes++;
    void writeScreen(p.request, p.code, message);
  };
  syncScreen();

  river.onEat = (x, z) => ambience.play("plop", { x, z });
  river.syncWishes(state.wishes);
  let flash = 0;

  // ---- playing the screen -----------------------------------------------------
  // Walk up to the Magic Screen and press Play: the walking controls (keys,
  // stick, VR thumbstick, jump) drive the program instead of the player, and
  // pointing at the picture with the mouse, a finger or the crosshair is the
  // program's pointer.
  let playing = false;
  let sitting = false;
  let screenB = false;
  const screenPtr = { x: 0.5, y: 0.5, pressed: false };
  const screenRay = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function nearScreen(): boolean {
    const dx = player.position.x - screen.centre.x, dz = player.position.z - screen.centre.z;
    const along = dx * screen.normal.x + dz * screen.normal.z;
    return along > 1.2 && along < 18 && Math.hypot(dx, dz) < 19;
  }
  function setPlaying(on: boolean) {
    playing = on;
    screenPtr.pressed = false;
    if (on) {
      // Stand where the whole picture fits the view, and face it.
      const px = screen.centre.x + screen.normal.x * 8.5, pz = screen.centre.z + screen.normal.z * 8.5;
      const dx = screen.centre.x - px, dz = screen.centre.z - pz;
      player.teleport(px, pz, Math.atan2(-dx, -dz));
      events.onToast?.("🎮 playing: arrows or stick to move, space to jump, E to stop");
    } else screen.input(NO_INPUT);
  }
  function aimScreen(clientX: number, clientY: number, centre = false): boolean {
    const r = renderer.domElement.getBoundingClientRect();
    if (centre) ndc.set(0, 0);
    else ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
    screenRay.setFromCamera(ndc, cam);
    const h = screen.hit(screenRay.ray.origin, screenRay.ray.direction);
    if (h) { screenPtr.x = h.x; screenPtr.y = h.y; }
    return !!h;
  }
  const onScreenDown = (e: PointerEvent) => {
    if (!playing || (e.target as HTMLElement).closest("button, input, a, select, [data-ui]")) return;
    screenPtr.pressed = aimScreen(e.clientX, e.clientY, document.pointerLockElement === container);
  };
  const onScreenMove = (e: PointerEvent) => { if (playing && screenPtr.pressed) aimScreen(e.clientX, e.clientY, document.pointerLockElement === container); };
  const onScreenUp = () => { screenPtr.pressed = false; };
  const onScreenKey = (down: boolean) => (e: KeyboardEvent) => {
    if (!playing || (e.target as HTMLElement | null)?.tagName === "INPUT") return;
    if (e.code === "Enter" || e.code === "ShiftLeft") screenB = down;
    if (down && e.code === "Escape") setPlaying(false);
    if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
  };
  const onScreenKeyDown = onScreenKey(true), onScreenKeyUp = onScreenKey(false);
  container.addEventListener("pointerdown", onScreenDown);
  window.addEventListener("pointermove", onScreenMove);
  window.addEventListener("pointerup", onScreenUp);
  window.addEventListener("keydown", onScreenKeyDown);
  window.addEventListener("keyup", onScreenKeyUp);

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
    if (playing) {
      // Playing the screen: the trigger is the program's pointer, aimed down the controller.
      vrPointer = c;
      aimFromController(c);
      screenPtr.pressed = true;
      return;
    }
    const hit = groundHits[controllers.indexOf(c)];
    if (hit && !game.active()) { walkTo(hit); return; }
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
  const onSelectEnd = (c: THREE.Group) => () => {
    if (vrPointer === c) { vrPointer = null; screenPtr.pressed = false; }
    const t = holdTimers.get(c); if (t !== undefined) { clearTimeout(t); holdTimers.delete(c); }
  };
  let vrPointer: THREE.Group | null = null;
  const ctrlQ = new THREE.Quaternion();
  function aimFromController(c: THREE.Group) {
    c.getWorldPosition(ctrlPos);
    ctrlDir.set(0, 0, -1).applyQuaternion(c.getWorldQuaternion(ctrlQ));
    const h = screen.hit(ctrlPos, ctrlDir);
    if (h) { screenPtr.x = h.x; screenPtr.y = h.y; }
  }
  // ---- walking by pointing ---------------------------------------------------
  // A controller (or hand) pointed at the ground shows a ring where it lands
  // and its ray turns gold: the trigger or a pinch walks you there. Pointed at
  // the sky the ray stays violet and the trigger talks, as it always did.
  const walkRayMat = new THREE.LineBasicMaterial({ color: "#ffd98a", transparent: true, opacity: 0.85 });
  const reticleGeo = new THREE.RingGeometry(0.2, 0.3, 28);
  reticleGeo.rotateX(-Math.PI / 2);
  const reticleMat = new THREE.MeshBasicMaterial({ color: "#fff4d8", transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });
  const targetMat = new THREE.MeshBasicMaterial({ color: "#ffd98a", transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide });
  const reticles = controllers.map(() => { const m = new THREE.Mesh(reticleGeo, reticleMat); m.visible = false; scene.add(m); return m; });
  const walkMarker = new THREE.Mesh(reticleGeo, targetMat);
  walkMarker.visible = false;
  scene.add(walkMarker);
  const groundHits: Array<THREE.Vector3 | null> = controllers.map(() => null);
  const WALK_RANGE = 30;
  const headW = new THREE.Vector3();
  function updateWalkPointers(inXr: boolean) {
    controllers.forEach((c, i) => {
      const hitNow = inXr && !playing && !game.active() ? pointAtGround(c) : null;
      groundHits[i] = hitNow;
      reticles[i].visible = !!hitNow;
      rays[i].material = hitNow ? walkRayMat : rayMat;
      if (hitNow) {
        reticles[i].position.set(hitNow.x, hitNow.y + 0.05, hitNow.z);
        c.getWorldPosition(ctrlPos);
        rays[i].scale.z = ctrlPos.distanceTo(hitNow) / Math.max(0.01, player.rig.scale.x);
      } else rays[i].scale.z = 3;
    });
    const t = player.target();
    walkMarker.visible = !!t;
    if (t) {
      walkMarker.position.set(t.x, groundAt(t.x, t.z) + 0.06, t.z);
      walkMarker.scale.setScalar(1 + Math.sin(time * 6) * 0.08);
    }
  }
  // March down the controller's ray until it goes under the ground.
  function pointAtGround(c: THREE.Group): THREE.Vector3 | null {
    c.getWorldPosition(ctrlPos);
    ctrlDir.set(0, 0, -1).applyQuaternion(c.getWorldQuaternion(ctrlQ));
    if (ctrlDir.y > -0.03) return null;
    let prev = 0;
    for (let t = 0.4; t <= WALK_RANGE; t += 0.4) {
      const x = ctrlPos.x + ctrlDir.x * t, y = ctrlPos.y + ctrlDir.y * t, z = ctrlPos.z + ctrlDir.z * t;
      if (y <= groundAt(x, z)) {
        // Halve back to the surface.
        let lo = prev, hi = t;
        for (let k = 0; k < 6; k++) {
          const m = (lo + hi) / 2;
          if (ctrlPos.y + ctrlDir.y * m <= groundAt(ctrlPos.x + ctrlDir.x * m, ctrlPos.z + ctrlDir.z * m)) hi = m; else lo = m;
        }
        const hx = ctrlPos.x + ctrlDir.x * hi, hz = ctrlPos.z + ctrlDir.z * hi;
        return new THREE.Vector3(hx, groundAt(hx, hz), hz);
      }
      prev = t;
    }
    return null;
  }
  function walkTo(hit: THREE.Vector3) {
    // The target is for the rig; put the *head* on the spot, wherever the
    // visitor happens to be standing in their room.
    renderer.xr.getCamera().getWorldPosition(headW);
    player.moveTo(hit.x - (headW.x - player.position.x), hit.z - (headW.z - player.position.z));
    ambience.play("sparkle");
  }

  // The grips do what the HUD's buttons do on a screen: the right grip the
  // first thing on offer, the left grip the second. Words (a wish, a program)
  // have no keyboard here, so a wish is written for you and the screen asks
  // you to say what you want.
  const onSqueeze = (e: { data?: XRInputSource }) => {
    const left = e.data?.handedness === "left";
    const a = (left ? actionsNow[1] : undefined) ?? actionsNow[0];
    if (!a) return;
    if (a.id === "wish") world.act("wish", "a wish from the headset");
    else if (a.id === "program") { events.onToast?.("Say what the screen should show"); events.onSelect?.(); }
    else world.act(a.id);
  };
  for (const c of controllers) c.addEventListener("squeezestart", onSqueeze as unknown as (e: THREE.Event) => void);
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
    const grips = actionsNow.length ? `grip: ${actionsNow[0].label}${actionsNow[1] ? ` · left grip: ${actionsNow[1].label}` : ""}` : "";
    const text = h ? `${"♥".repeat(h.hearts)}${"♡".repeat(Math.max(0, h.maxHearts - h.hearts))}   ${h.objective}   ${h.score} pts${h.timer != null ? `   ${Math.ceil(h.timer)}s` : ""}` : (grips || (options.voiceLine?.() ?? ""));
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
    c.font = `500 ${text.length > 44 ? 34 : 44}px system-ui, sans-serif`;
    c.fillText(text.slice(0, 70), 512, 80);
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
    // A low sun leaves every wall facing away from it in its own shade; the
    // bright sky around a sunset fills those, or houses go to silhouettes.
    const lowSun = Math.max(0, 1 - Math.abs(elev) / 0.3);
    look.hemiI += ((0.55 + Math.max(0, elev) * 0.35 + lowSun * 0.3) * (1 - night * 0.42) - look.hemiI) * k;
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
    moonLight.intensity = look.night * 0.75;
    moonLight.position.copy(look.sunDir).multiplyScalar(-100).add(player.position);
    moonLight.position.y = Math.abs(moonLight.position.y) + 40;
    hemi.intensity = look.hemiI + look.lanterns * 0.05;
    hemi.color.copy(look.horizon).lerp(C.setRGB(1, 1, 1), 0.3).lerp(C.setRGB(0.45, 0.55, 0.85), look.night * 0.5);
    hemi.groundColor.copy(look.tint).multiply(C.setRGB(0.35, 0.45, 0.28));
    terrain.setSnow(look.snowCover);
    terrain.setTint(look.tint);
    terrain.setWater(s.flood * 7);
    terrain.setWet(look.wet);
    // Under a roof, the weather stays outside.
    const dry = 1 - indoorsNow;
    rain.setDensity(look.rain * dry);
    snow.setDensity(look.snow * dry);
    petals.setDensity(look.petals * dry);
    petalMat.color.set(s.season === "autumn" ? "#e0742a" : "#ffc0dc");
    fireflies.setDensity(look.fireflies);
    const groundCol = look.tint.clone();
    for (const f of foliageMats) f.mat.color.copy(look.foliage[f.kind]).multiply(groundCol).lerp(C.setRGB(0.92, 0.94, 0.97), look.snowCover * 0.5);
    for (const f of spawnMats) f.mat.color.copy(look.foliage[f.kind]).multiply(groundCol).lerp(C.setRGB(0.92, 0.94, 0.97), look.snowCover * 0.5);
    renderer.toneMappingExposure = 1.05 - look.night * 0.1 + flash * 0.6;
  }

  // ---- where feet go ---------------------------------------------------------
  /**
   * The floor under somebody: the ground, the bridge's planks if they are up
   * on it (somebody wading underneath stays in the water), and in deep water
   * a float that keeps the head out.
   */
  function groundAt(x: number, z: number): number {
    let h = heightAt(x, z);
    const d = bridge.deckAt(x, z);
    if (d !== null && player.position.y > d - 0.7) h = Math.max(h, d);
    h = Math.max(h, houseFloorAt(x, z));
    const wy = terrain.waterY();
    if (h < wy - 1.3) h = wy - 1.3;
    return h;
  }
  const onBridge = () => {
    const d = bridge.deckAt(player.position.x, player.position.z);
    return d !== null && player.position.y > d - 0.3;
  };
  let wasWet = false;

  // ---- the soundscape ---------------------------------------------------------
  /** What the ground is made of where somebody stands, for their footsteps. */
  function surfaceAt(x: number, z: number, y: number): Surface {
    if (onBridge()) return "wood";
    const home = insideHouse(x, z);
    if (home) {
      const { lz } = houseLocal(home, x, z);
      return lz > home.house!.room.d / 2 - 1.4 ? "wood" : "tatami";
    }
    if (houseFloorAt(x, z) > heightAt(x, z) + 0.1) return "wood";
    if (y < terrain.waterY() - 0.05) return "water";
    if (pathAt(x, z) > 0.35) return "stone";
    return "grass";
  }
  let stepDist = 0;
  let hotaruLevel = 0;
  let wasDark: boolean | null = null;
  let indoorsNow = 0, fireNow = 0;
  let actionTick = 0, actionKey = "", actionsNow: WorldAction[] = [];
  const lastFeet = new THREE.Vector3();
  function soundscape() {
    const s = state;
    const p = player.position;
    const dayish = 1 - look.night;
    const wet = look.rain;
    const riverNear = Math.max(0, 1 - Math.max(0, riverDistance(p.x, p.z) - 4) / 38);
    const warm = s.season === "summer" ? 1 : s.season === "spring" ? 0.7 : s.season === "autumn" ? 0.35 : 0;
    const home = insideHouse(p.x, p.z);
    indoorsNow += ((home ? 1 : 0) - indoorsNow) * 0.08;
    let fireTarget = 0;
    if (home) fireTarget = Math.max(0, 1 - home.group.localToWorld(V.copy(home.house!.interior.hearth)).distanceTo(p) / 5);
    fireNow += (fireTarget - fireNow) * 0.08;
    ambience.listener(p.x, p.z, player.yaw());
    // The temple on the hill rings its bell at dusk and at dawn.
    const dark = look.night > 0.35;
    if (wasDark !== null && dark !== wasDark) ambience.play("bonsho");
    wasDark = dark;
    ambience.set({
      rain: wet, wind: s.wind, night: look.night * (s.season === "winter" ? 0.1 : 1), storm: s.weather === "storm" ? 1 : 0,
      water: Math.max(riverNear, s.flood > 0.2 ? 0.5 : 0),
      leaves: leavesAt(p.x, p.z) * (s.season === "winter" ? 0.3 : 1),
      birds: dayish * (1 - wet) * (s.weather === "storm" ? 0 : 1) * (0.3 + 0.5 * warm),
      frogs: riverNear * warm * Math.min(1, look.night * 1.2 + wet * 0.6) * 0.8,
      cicadas: s.season === "summer" ? dayish * (1 - wet) : 0,
      indoors: indoorsNow,
      fire: fireNow,
    });
    // Footsteps: a step every stride of ground actually covered.
    const moved = Math.hypot(p.x - lastFeet.x, p.z - lastFeet.z);
    lastFeet.copy(p);
    if (moved > 3) { stepDist = 0; return; } // a teleport, not a stride
    const inWater = p.y < terrain.waterY() - 0.2;
    if (inWater && !wasWet) { ambience.play("splash", { x: p.x, z: p.z }); river.ripple(p.x, p.z, 1.6); }
    wasWet = inWater;
    if (inWater && moved > 0.01 && Math.random() < 0.08) river.ripple(p.x, p.z, 0.9);
    const grounded = p.y - groundAt(p.x, p.z) < 0.08;
    if (!grounded || renderer.xr.isPresenting && moved < 0.002) return;
    stepDist += moved;
    const stride = 0.72 / s.giant;
    if (stepDist > stride) { stepDist = 0; ambience.step(surfaceAt(p.x, p.z, p.y)); }
  }

  // ---- loop -----------------------------------------------------------------
  const clock = new THREE.Clock();
  let time = 0;
  let disposed = false;
  let lastHitFlash = 0;
  const propCtx = { wind: 0, windDir: 0, season: state.season, lanterns: false, night: 0, snow: 0 };

  // ---- arrival -------------------------------------------------------------
  // The first thing a visitor sees: the camera high over the valley, sweeping
  // down over the river and the village into their own eyes, with the temple
  // bell. Any key or tap skips it; it never runs in a headset or under a
  // script (navigator.webdriver), where it would only get in the way.
  const INTRO = 6;
  let intro = /[?&]intro\b/.test(location.search) || (typeof navigator !== "undefined" && !navigator.webdriver && !/[?&]nointro\b/.test(location.search)) ? 0 : -1;
  const introFrom = new THREE.Vector3(46, 38, 40), introCtrl = new THREE.Vector3(14, 18, 26), introLook0 = new THREE.Vector3(-12, 6, -22);
  const introEye = new THREE.Vector3(), introLook = new THREE.Vector3(), introPos = new THREE.Vector3();
  const playerHead = player.rig.children[0] as THREE.Object3D;
  const endIntro = () => {
    if (intro < 0) return;
    intro = -1;
    playerHead.add(camera);
    camera.position.set(0, 0, 0);
    camera.rotation.set(0, 0, 0);
  };
  const skipIntro = () => { if (intro > 0.4) endIntro(); };
  window.addEventListener("keydown", skipIntro);
  window.addEventListener("pointerdown", skipIntro);
  function arrival(dt: number) {
    if (intro < 0) return;
    if (renderer.xr.isPresenting) { endIntro(); return; }
    if (intro === 0) { scene.add(camera); ambience.play("bonsho"); }
    intro += dt;
    const k = Math.min(1, intro / INTRO);
    const e = k * k * (3 - 2 * k);
    const a = 1 - e;
    introEye.copy(player.position).setY(player.position.y + 1.62 / state.giant);
    introPos.set(
      a * a * introFrom.x + 2 * a * e * introCtrl.x + e * e * introEye.x,
      a * a * introFrom.y + 2 * a * e * introCtrl.y + e * e * introEye.y,
      a * a * introFrom.z + 2 * a * e * introCtrl.z + e * e * introEye.z,
    );
    camera.position.copy(introPos);
    introLook.set(introEye.x - Math.sin(player.yaw()) * 12, introEye.y, introEye.z - Math.cos(player.yaw()) * 12);
    camera.lookAt(introLook0.clone().lerp(introLook, Math.min(1, e * 1.15)));
    if (k >= 1) endIntro();
  }

  // Our body under us, and the camera eased out behind it (or back into our
  // eyes indoors, sitting, at the screen, in the arrival shot and in VR).
  const camGround = new THREE.Vector3();
  function updateSelf(dt: number, inXr: boolean) {
    const p = player.position;
    const moved = Math.hypot(p.x - lastSelf.x, p.z - lastSelf.z) / Math.max(dt, 1e-3);
    lastSelf.copy(p);
    selfSpeed += (Math.min(moved, 12) - selfSpeed) * Math.min(1, dt * 8);
    self.group.position.copy(p);
    self.group.rotation.y = player.yaw() + Math.PI;
    self.setOni(tag.isOni(myId));
    self.update(dt, selfSpeed, p.y - groundAt(p.x, p.z) > 0.25);
    // A portrait phone sees much more up and down, so stand further back and higher.
    const portrait = camera.aspect < 1;
    const want = thirdPerson && !inXr && intro < 0 && !sitting && !playing && !insideHouse(p.x, p.z) ? (portrait ? 5.4 : 3.8) : 0;
    camBack += (want - camBack) * Math.min(1, dt * 4);
    if (intro < 0 && !inXr) {
      camera.position.set(0, camBack * (portrait ? 0.24 : 0.14), camBack);
      // Never under the hill behind us.
      camera.updateMatrixWorld(true);
      camGround.setFromMatrixPosition(camera.matrixWorld);
      const floor = groundAt(camGround.x, camGround.z) + 0.35;
      if (camGround.y < floor) camera.position.y += floor - camGround.y;
    }
    self.group.visible = camBack > 0.9 && !inXr;
  }

  function frame() {
    if (disposed) return;
    const dt = fixedDt ?? Math.min(0.1, clock.getDelta());
    time += dt;
    flash = Math.max(0, flash - dt * 2.5);
    lastHitFlash = Math.max(0, lastHitFlash - dt * 3);
    const s = state;
    const xr = renderer.xr.isPresenting ? renderer.xr.getSession() : null;
    const eye = 1 / s.giant;
    const wading = player.position.y < terrain.waterY() - 0.4 ? 0.55 : 1;
    updateWalkPointers(!!xr);
    player.update(dt, groundAt, { frozen: playing || sitting || intro >= 0 || tag.frozen(), gravity: s.gravity, speed: s.speed * eye * wading * tag.speed(), eye: sitting ? eye * 0.52 : eye, xr, xrCamera: xr ? renderer.xr.getCamera() : null, solve: (p) => { solveWalls(p); tag.clamp(p); } });
    tag.update(dt, time);
    const th = tag.hud();
    if (th !== lastTagHud) { lastTagHud = th; events.onTag?.(th); }
    updateSelf(dt, !!xr);
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
    forest.update(time, s.windDirection, s.wind);
    bridge.update(dt, time, s.wind, s.windDirection);
    screen.update(dt, time, player.position);
    spells.update(dt);
    {
      // Hotaru by the river: warm, dry, dark nights.
      const warmSeason = s.season === "summer" ? 1 : s.season === "spring" ? 0.7 : 0;
      const dryNight = s.weather === "rain" || s.weather === "storm" || s.weather === "snow" ? 0 : 1;
      hotaruLevel += (Math.max(0, (look.night - 0.4) / 0.4) * warmSeason * dryNight - hotaruLevel) * Math.min(1, dt * 0.8);
      hotaru.setLevel(Math.min(1, hotaruLevel));
      hotaru.update(dt, time, terrain.waterY());
    }
    for (const h of openHouses) h.house!.interior.update(dt, time, h.group.visible && h.group.position.distanceTo(player.position) < 16);
    if (playing) {
      const c = player.controls();
      if (vrPointer) aimFromController(vrPointer);
      else if (document.pointerLockElement === container || xr) aimScreen(0, 0, true);
      screen.input({ left: c.x < -0.35, right: c.x > 0.35, up: c.y > 0.35, down: c.y < -0.35, a: c.jump, b: screenB, x: screenPtr.x, y: screenPtr.y, pressed: screenPtr.pressed });
    }
    river.update(dt, time, { waterY: terrain.waterY(), player: player.position, onBridge: onBridge(), night: look.night });
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
    updateLampPool(dt);
    soundscape();
    actionTick -= dt;
    if (actionTick <= 0) {
      actionTick = 0.3;
      if (playing && !nearScreen()) setPlaying(false);
      const home = insideHouse(player.position.x, player.position.z);
      if (sitting && !home) sitting = false;
      const catNear = home && home.group.localToWorld(V.copy(home.house!.interior.cat)).distanceTo(player.position) < 2.4;
      const next: WorldAction[] = home
        ? [{ id: "sit", label: sitting ? "Stand up" : "Sit by the fire" }, ...(catNear ? [{ id: "pet" as const, label: "Pet the cat" }] : [])]
        : onBridge()
        ? [{ id: "feed", label: "Feed the koi" }, { id: "wish", label: "Float a wish" }]
        : nearScreen()
          ? [{ id: "play", label: playing ? "Stop playing" : "Play on the screen" }, { id: "program", label: "Make something" }, { id: "channel", label: "Change channel" }]
          : [];
      const key = next.map((a) => a.label).join();
      if (key !== actionKey) { actionKey = key; actionsNow = next; events.onActions?.(next); }
    }
    room?.presence(player.position.x, player.position.y, player.position.z, player.yaw(), vibey.bodyId(), options.talking?.() ?? false, tag.presence());
    peers.update(dt, time, groundAt, (id) => tag.isOni(id));
    const gh = game.hud();
    events.onGame?.(gh);
    vrHud.visible = renderer.xr.isPresenting;
    if (vrHud.visible) drawVrHud(gh);
    vibey.update(dt, time, player.position, player.yaw(), (x, z) => Math.max(heightAt(x, z), houseFloorAt(x, z), bridge.deckAt(x, z) ?? -Infinity));
    renderer.toneMappingExposure += lastHitFlash * 0.5;
    arrival(dt);
    renderer.render(scene, camera);
  }
  // Offline rendering for films: a script stops the loop and steps the whole
  // engine a fixed slice of time per frame (`__magician.film`).
  let fixedDt: number | null = null;
  renderer.setAnimationLoop(frame);

  // A headset has a mobile GPU and two eyes. Halve the shadow map for the
  // session and put it back after.
  const onXrStart = () => {
    grass.setQuality(8, 20);
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
    startTag: () => tag.start(),
    setChar(id) { myChar = id; self.setChar(id); },
    setThirdPerson(on) { thirdPerson = on; },
    run(name, args) {
      const r = runTool(name, args, store);
      if (r.toast) {
        events.onToast?.(r.toast);
        // A spell landed: sparkles at Vibey's hands and a flourish, unless the
        // model chose its own gesture this turn.
        bursts.spawn("sparkle", vibey.position.x, vibey.position.y + 1.2, vibey.position.z);
        // And the spell leaves: a ribbon up into the sky that blooms there.
        if (!/^(emote|game_status|look_around|shield|blast)$/.test(name)) {
          const aim = new THREE.Vector3(-Math.sin(player.yaw()), 0, -Math.cos(player.yaw()));
          spells.cast(V.copy(vibey.position).setY(vibey.position.y + 1.1), aim, spellColour(name), (at) => bursts.spawn("sparkle", at.x, at.y, at.z));
          ambience.play("sparkle", { x: vibey.position.x, z: vibey.position.z });
        }
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
    act(id, text) {
      if (id === "feed") { river.feed(player.position, player.yaw()); ambience.play("whoosh", { x: player.position.x, z: player.position.z }); }
      else if (id === "wish") runTool("release_lantern", { wish: text ?? "" }, store);
      else if (id === "play") { setPlaying(!playing); actionKey = ""; }
      else if (id === "channel") {
        // Flip through the channels the screen already knows.
        const now = state.screen ? CHANNELS.findIndex((c) => c.title === state.screen!.title) : 0;
        const next = CHANNELS[(now + 1 + CHANNELS.length) % CHANNELS.length];
        store.patch({ screen: { code: next.code, title: next.title, request: next.title, at: Date.now() } });
        ambience.play("pop", SCREEN_AT);
        events.onToast?.(`📺 ${next.title}`);
      }
      else if (id === "sit") {
        sitting = !sitting;
        actionKey = "";
        const home = insideHouse(player.position.x, player.position.z);
        if (sitting && home) {
          // Sit facing the fire.
          const h = home.group.localToWorld(V.copy(home.house!.interior.hearth));
          player.teleport(player.position.x, player.position.z, Math.atan2(-(h.x - player.position.x), -(h.z - player.position.z)));
        }
      } else if (id === "pet") {
        const home = insideHouse(player.position.x, player.position.z);
        if (home) {
          home.house!.interior.pet();
          const c = home.group.localToWorld(V.copy(home.house!.interior.cat));
          ambience.play("purr", { x: c.x, z: c.z });
          if (Math.random() < 0.5) setTimeout(() => ambience.play("mew", { x: c.x, z: c.z }), 2600);
          bursts.spawn("sparkle", c.x, c.y + 0.3, c.z);
        }
      }
      else if (id === "program" && text?.trim()) {
        const change = !!state.screen && /\b(make it|change it|make the|faster|slower|bigger|smaller|instead|add a|add some|more)\b/i.test(text);
        runTool("program_screen", { request: text.trim(), change }, store);
      }
    },
    actions: () => actionsNow,
    setMusic(on) { ambience.setMusic(on); },
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
      walkRayMat.dispose(); reticleGeo.dispose(); reticleMat.dispose(); targetMat.dispose();
      game.dispose();
      room?.close();
      room = null;
      peers.dispose();
      tag.dispose();
      self.dispose();
      container.removeEventListener("mousedown", onDown);
      container.removeEventListener("mouseup", onUp);
      container.removeEventListener("pointerdown", onScreenDown);
      window.removeEventListener("keydown", skipIntro);
      window.removeEventListener("pointerdown", skipIntro);
      window.removeEventListener("pointermove", onScreenMove);
      window.removeEventListener("pointerup", onScreenUp);
      window.removeEventListener("keydown", onScreenKeyDown);
      window.removeEventListener("keyup", onScreenKeyUp);
      screen.dispose();
      spells.dispose();
      hotaru.dispose();
      bridge.dispose();
      river.dispose();
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchend", onTouchEnd);
      controllers.forEach((c, i) => { c.removeEventListener("selectstart", selectHandlers[i].h); c.removeEventListener("selectend", selectHandlers[i].e); c.removeEventListener("squeezestart", onSqueeze as unknown as (e: THREE.Event) => void); });
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
    /** Step the whole world exactly `dt` seconds and return the frame, with the live loop stopped. */
    film: (dt = 1 / 24, quality = 0.9) => {
      renderer.setAnimationLoop(null);
      fixedDt = dt;
      try { frame(); } finally { fixedDt = null; }
      return renderer.domElement.toDataURL("image/jpeg", quality);
    },
    /** Hand the world back to its own clock after filming. */
    live: () => { clock.getDelta(); renderer.setAnimationLoop(frame); },
    teleport: (x: number, z: number, yaw?: number) => { player.teleport(x, z, yaw); solveWalls(player.position); },
    counts: () => ({ props: spawned.size, fixed: fixed.length, fireballs: fireballs.count(), fizzled: fireballs.fizzled(), hits: state.hits }),
    caption: (t: string) => vibey.setCaption(t),
    become: (id: string) => store.become(id),
    game: () => game.hud(),
    fire: () => fireFromCamera(),
    companion: () => vibey.debug(),
    player: () => ({ x: player.position.x, y: player.position.y, z: player.position.z, yaw: player.yaw(), fov: camera.fov, zoom: zoomLevel }),
    /** Tag: the round as this device sees it. */
    tag: () => ({ id: myId, phase: tag.phase(), oni: tag.isOni(myId), hud: tag.hud(), peers: peers.positions().map((p) => ({ ...p, oni: tag.isOni(p.id) })) }),
    startTag: () => tag.start(),
    /** Walk to a spot the way a trigger pointed at the ground does. */
    walkTo: (x: number, z: number) => { player.moveTo(x, z); return player.target(); },
    peers: () => ({ connected: room?.connected ?? false, count: peers.count(), id: room?.id ?? null }),
    grass: () => grass.stats(),
    spells: () => spells.group.children.map((c) => ({ visible: c.visible, head: Array.from(((c as THREE.Points).geometry.attributes.position.array as Float32Array).slice(0, 3)).map((v) => +v.toFixed(2)) })),
    vibeyAt: () => [vibey.position.x, vibey.position.y, vibey.position.z].map((v) => +v.toFixed(2)),
    screen: () => ({ title: screen.title(), error: screenError, busy: screenBusy, playing }),
    river: () => ({ ...river.debug(), waterY: terrain.waterY(), player: [player.position.x, player.position.y, player.position.z].map((v) => +v.toFixed(2)) }),
    listen: (seconds: number) => new Promise<{ png: string; rms: number[]; peak: number; state: string }>((resolve) => {
      // A spectrogram of the ambience mix, drawn here, for checking sound in
      // a sandbox with no speakers: wind should swell and fall, not sit flat.
      // Rendering stops meanwhile: a software renderer starves the sampling.
      ambience.resume();
      soundscape();
      renderer.setAnimationLoop(null);
      const an = ambience.analyser();
      const cols: Float32Array[] = [];
      const rms: number[] = [];
      let peak = 0, sq = 0, count = 0;
      const buf = new Float32Array(2048);
      const t0 = performance.now();
      const id = window.setInterval(() => {
        if (!an) return;
        const spec = new Float32Array(an.frequencyBinCount);
        an.getFloatFrequencyData(spec);
        cols.push(spec);
        an.getFloatTimeDomainData(buf);
        for (const v of buf) { peak = Math.max(peak, Math.abs(v)); sq += v * v; count++; }
        if (performance.now() - t0 > (rms.length + 1) * 1000) { rms.push(Math.round(10 * Math.log10(sq / Math.max(1, count) + 1e-12) * 10) / 10); sq = 0; count = 0; }
        if (performance.now() - t0 > seconds * 1000) {
          clearInterval(id);
          const H = 256, W = cols.length;
          const cv = document.createElement("canvas");
          cv.width = Math.max(1, W); cv.height = H;
          const g2 = cv.getContext("2d")!;
          const img = g2.createImageData(cv.width, H);
          const bins = an.frequencyBinCount, nyq = 24000;
          for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
            const hz = 40 * Math.pow(nyq / 40, 1 - y / H);
            const v = cols[x][Math.min(bins - 1, Math.floor((hz / nyq) * bins))];
            const k = Math.max(0, Math.min(255, (v + 110) * 3.2));
            const o = (y * cv.width + x) * 4;
            img.data[o] = k; img.data[o + 1] = k * 0.7; img.data[o + 2] = 255 - k * 0.6; img.data[o + 3] = 255;
          }
          g2.putImageData(img, 0, 0);
          renderer.setAnimationLoop(frame);
          resolve({ png: cv.toDataURL("image/png"), rms, peak: Math.round(20 * Math.log10(peak + 1e-9) * 10) / 10, state: (an.context as AudioContext).state });
        }
      }, 50);
    }),
    budget: () => {
      // Triangles per top-level object, instancing included: where the frame goes.
      const out: Record<string, number> = {};
      scene.children.forEach((c, i) => {
        let t = 0;
        c.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh || !m.visible) return;
          const g = m.geometry;
          const n = (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3;
          t += n * ((m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1);
        });
        if (t > 5000) out[`${i}:${c.name || c.type}`] = Math.round(t);
      });
      return out;
    },
    render: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, programs: renderer.info.programs?.length ?? 0, textures: renderer.info.memory.textures, geometries: renderer.info.memory.geometries }),
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
        forest.update(time, state.windDirection, state.wind);
        bridge.update(0.1, time, state.wind, state.windDirection);
        river.update(0.1, time, { waterY: terrain.waterY(), player: player.position, onBridge: onBridge(), night: look.night });
        hotaruLevel = Math.max(0, (look.night - 0.4) / 0.4) * (state.season === "summer" || state.season === "spring" ? 1 : 0) * (/rain|storm|snow/.test(state.weather) ? 0 : 1);
        hotaru.setLevel(Math.min(1, hotaruLevel));
        hotaru.update(0.1, time, terrain.waterY());
        spells.update(0.1);
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
      walkTo(x: number, z: number): { x: number; z: number } | null;
      film(dt?: number, quality?: number): string;
      live(): void;
      tag(): unknown;
      startTag(): boolean;
      peers(): { connected: boolean; count: number; id: string | null };
      grass(): { chunks: number; blades: number };
      river(): unknown;
      spells(): unknown;
      vibeyAt(): number[];
      screen(): { title: string; error: string | null; busy: boolean; playing: boolean };
      listen(seconds: number): Promise<{ png: string; rms: number[]; peak: number; state: string }>;
      budget(): Record<string, number>;
      /** The last frame's cost, for checking the headset budget. */
      render(): { calls: number; triangles: number; programs: number; textures: number; geometries: number };
      settle(seconds?: number): void;
    };
  }
}
