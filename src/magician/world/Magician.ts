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
import { heightAt, riverCentre, WATER_LEVEL } from "./noise";
import { createTerrain, pathAt } from "./terrain";
import { createSky } from "./sky";
import { buildBridge, buildForest, buildProp, buildSign, disposeSharedProps, FOLIAGE, type PropObject, type TreeKind } from "./props";
import { createBursts, createFireflies, createLightning, createPetals, createRain, createSnow } from "./weather";
import { createFireballs } from "./fireballs";
import { createAmbience } from "./audio";
import { createVibey, type Vibey } from "./vibey";
import { createPlayer } from "./player";

export interface MagicianEvents {
  onToast?(text: string): void;
  onHit?(hits: number): void;
  onState?(state: WorldState): void;
  onFizzle?(): void;
}

export interface MagicianWorld {
  store: MagicianStore;
  vibey: Vibey;
  /** Run a tool by name; what the voice session calls. */
  run(name: string, args: unknown): ToolResult;
  /** Run a plain sentence through the spellbook. Returns how many spells landed. */
  cast(text: string): ToolResult[];
  getState(): WorldState;
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

export function createMagician(container: HTMLElement, events: MagicianEvents = {}): MagicianWorld {
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
  for (const [x, z, yaw] of houseSpots) place("house", x, z, yaw);
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
  }
  for (const [x, z] of [[-4, 4], [4, 4], [-4, -4], [4, -4], [-30, -30], [-30, -38]]) place("lantern", x, z, 0, 0.9);
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
  scene.add(player.rig);
  const vibey = createVibey();
  scene.add(vibey.group);
  const ambience = createAmbience();

  // ---- state ----------------------------------------------------------------
  let state: WorldState = applyPatch(DEFAULT_STATE, {});
  const store: MagicianStore = {
    get: () => state,
    patch(p: Patch) {
      state = applyPatch(state, p);
      if (p.props) syncProps(state.props, state.season);
      if (p.sign !== undefined) sign.setText(state.sign);
      events.onState?.(state);
    },
    playerPosition: () => ({ x: player.position.x, z: player.position.z, yaw: player.yaw() }),
    teleport(x, z, yaw) { player.teleport(x, z, yaw); },
    emote(clip) { vibey.emote(clip); },
    sound(name) { ambience.play(name); },
    burst(kind, x, z) {
      const px = x ?? player.position.x - Math.sin(player.yaw()) * 3;
      const pz = z ?? player.position.z - Math.cos(player.yaw()) * 3;
      if (kind === "flash") { flash = 1; bursts.spawn("sparkle", px, heightAt(px, pz), pz); }
      else bursts.spawn(kind, px, heightAt(px, pz), pz);
    },
  };
  sign.setText(state.sign);
  let flash = 0;

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
    look.sunI += (Math.max(0, elev) * 2.4 * (1 - grey * 0.75) - look.sunI) * k;
    look.hemiI += ((0.25 + Math.max(0, elev) * 0.5) * (1 - night * 0.6) - look.hemiI) * k;
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
      ambience.play("hit");
      bursts.spawn("sparkle", hit.x, heightAt(hit.x, hit.z) + 1, hit.z);
      events.onHit?.(state.hits);
      events.onState?.(state);
    }
    vibey.update(dt, time, player.position, player.yaw(), heightAt);
    renderer.toneMappingExposure += lastHitFlash * 0.5;
    renderer.render(scene, camera);
  }
  renderer.setAnimationLoop(frame);

  // A headset has a mobile GPU and two eyes. Halve the shadow map for the
  // session and put it back after.
  const onXrStart = () => {
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.needsUpdate = true;
  };
  const onXrEnd = () => {
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
      sky.dispose();
      rain.dispose(); snow.dispose(); petals.dispose(); fireflies.dispose(); bursts.dispose(); fireballs.dispose();
      sign.dispose();
      for (const p of fixed) p.dispose();
      forest.dispose();
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
        for (const p of fixed) p.update?.(0.1, time, propCtx);
        for (const sp of spawned.values()) { sp.obj.update?.(0.1, time, propCtx); sp.obj.group.scale.setScalar(sp.prop.scale); }
        bursts.update(0.1);
        fireballs.update(0.1, { on: state.fireballs.on, rate: state.fireballs.rate, wet: fireballsFizzle(state), player: V, heightAt });
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
      settle(seconds?: number): void;
    };
  }
}
