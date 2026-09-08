/**
 * Beck Road, the engine: a walk (or a fly) through a 1:1 reconstruction of
 * the neighbourhood around 8330 NE Beck Road on Bainbridge Island, from
 * Blakely Elementary to Lytle Beach, placed from real map data. The scene
 * is assembled from the modules alongside this file; this file owns the
 * renderer, the post pipeline, the camera and the person holding it.
 */
import * as THREE from "three";
import { buildPost } from "./post";
import { loadNeighbourhood, nearestAddress, nearestRoad, point, signName, type Neighbourhood, type Terrain } from "./geo";
import { buildSky, type SkyRig, type Weather } from "./sky";
import { buildGround, updateWaterCamera, type Ground } from "./terrain";
import { buildRoads, type Roads } from "./roads";
import { buildBuildings, type Buildings } from "./buildings";
import { buildVegetation, type Vegetation } from "./vegetation";
import { buildStreet, type Street } from "./street";

export type { Weather } from "./sky";
export type Mode = "walk" | "fly";

export interface BeckState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  heading: string;
  address: string;
  road: string;
  weather: Weather;
  mode: Mode;
  ready: boolean;
  frames: number;
}

export interface BeckStick {
  x: number;
  y: number;
}

export interface BeckWorld {
  readonly stick: BeckStick;
  readonly look: BeckStick;
  setWeather(w: Weather): void;
  setMode(m: Mode): void;
  preset(name: string): void;
  presets(): string[];
  dispose(): void;
}

export interface BeckOptions {
  container: HTMLElement;
  weather?: Weather;
  /** Sandbox mode: no ambient occlusion, pixel ratio one. */
  lite?: boolean;
  onState: (s: BeckState) => void;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export function createBeck(options: BeckOptions): BeckWorld {
  const { container, onState } = options;
  let weather: Weather = options.weather ?? "sun";
  let mode: Mode = "walk";

  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance", logarithmicDepthBuffer: false });
  renderer.setPixelRatio(options.lite ? 1 : Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, 1, 0.2, 6000);

  const post = buildPost(renderer, scene, camera, { ssao: !options.lite });

  const onResize = () => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h);
    post.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  onResize();
  window.addEventListener("resize", onResize);

  // ---- The person ---------------------------------------------------------
  const stick: BeckStick = { x: 0, y: 0 };
  const look: BeckStick = { x: 0, y: 0 };
  const keys = new Set<string>();
  let yaw = 0;
  let pitch = 0;
  const pos = new THREE.Vector3(0, 40, 0);
  let dragging = false;
  let lastPX = 0;
  let lastPY = 0;
  const onKeyDown = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    keys.add(k);
    if (k === "f" && !e.repeat) setMode(mode === "walk" ? "fly" : "walk");
    if (k === "t" && !e.repeat) setWeather(weather === "sun" ? "overcast" : "sun");
    if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
  const onBlur = () => keys.clear();
  const onPointerDown = (e: PointerEvent) => {
    dragging = true;
    lastPX = e.clientX;
    lastPY = e.clientY;
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    yaw -= (e.clientX - lastPX) * 0.0032;
    pitch -= (e.clientY - lastPY) * 0.0032;
    pitch = Math.max(-1.4, Math.min(1.4, pitch));
    lastPX = e.clientX;
    lastPY = e.clientY;
  };
  const onPointerUp = () => {
    dragging = false;
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);

  // ---- The world ------------------------------------------------------------
  let data: Neighbourhood | null = null;
  let terrain: Terrain | null = null;
  let sky: SkyRig | null = null;
  let ground: Ground | null = null;
  let roads: Roads | null = null;
  let buildings: Buildings | null = null;
  let veg: Vegetation | null = null;
  let street: Street | null = null;
  let ready = false;
  let disposed = false;
  const presetTable = new Map<string, { x: number; z: number; yaw: number; pitch: number }>();

  function applyEnv() {
    if (!sky) return;
    const k = sky.envIntensity();
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[] | undefined;
      const list = Array.isArray(m) ? m : m ? [m] : [];
      for (const mm of list) if ((mm as THREE.MeshStandardMaterial).isMeshStandardMaterial) (mm as THREE.MeshStandardMaterial).envMapIntensity = k;
    });
  }

  function makePresets(d: Neighbourhood) {
    const roadAt = (x: number, z: number, nameLike?: string) => nearestRoad(d, x, z, ["residential", "tertiary", "secondary"], nameLike);
    const addr = (n: string, street: string) => d.addresses.find((a) => a.n === n && a.st && a.st.toLowerCase().includes(street));
    const stand = (name: string, target: number[] | null, back = 14, faceTarget = true, nameLike?: string) => {
      if (!target) return;
      const r = roadAt(target[0], target[1], nameLike) ?? roadAt(target[0], target[1]);
      if (!r) return;
      // Stand on the road's centreline, `back` metres along it, and face the target.
      const dir = Math.sign((target[0] - r.x) * -r.tz + (target[1] - r.z) * r.tx) || 1;
      const x = r.x + r.tx * back * 0.35;
      const z = r.z + r.tz * back * 0.35;
      const y = faceTarget ? Math.atan2(-(target[0] - x), -(target[1] - z)) : Math.atan2(-r.tx * dir, -r.tz * dir);
      presetTable.set(name, { x, z, yaw: y, pitch: 0.02 });
    };
    stand("8330 NE Beck Rd", point(addr("8330", "beck")?.g ?? { t: "pt", c: [0, 0] }), 14, true, "beck road");
    for (const n of ["8000", "8250", "8300", "8368", "8416", "8490"]) {
      const a = addr(n, "beck");
      if (a) stand(`${n} NE Beck Rd`, point(a.g), 14, true, "beck road");
    }
    // Along Beck Road looking east and west.
    const beck = d.roads.find((r) => r.name && r.name.toLowerCase().includes("beck road"));
    if (beck && beck.g.t === "ls") {
      const c = beck.g.c;
      const mid = c[Math.floor(c.length / 2)];
      const a = c[0];
      const b = c[c.length - 1];
      presetTable.set("Beck Rd, looking east", { x: mid[0], z: mid[1], yaw: Math.atan2(-(b[0] - mid[0]), -(b[1] - mid[1])), pitch: 0 });
      presetTable.set("Beck Rd, looking west", { x: mid[0], z: mid[1], yaw: Math.atan2(-(a[0] - mid[0]), -(a[1] - mid[1])), pitch: 0 });
    }
    const school = d.places.find((p) => (p.name || "").toLowerCase().includes("elementary"));
    if (school) stand("Blakely Elementary", point(school.g), 30);
    const beach = d.places.find((p) => (p.name || "").toLowerCase().includes("lytle beach"));
    if (beach) {
      const p = point(beach.g)!;
      presetTable.set("Lytle Beach", { x: p[0], z: p[1] - 10, yaw: Math.PI, pitch: 0.05 });
    }
    presetTable.set("Above the neighbourhood", { x: 0, z: 60, yaw: 0, pitch: -0.55 });
  }

  function preset(name: string) {
    const p = presetTable.get(name);
    if (!p || !ground) return;
    pos.set(p.x, 0, p.z);
    yaw = p.yaw;
    pitch = p.pitch;
    if (name === "Above the neighbourhood") {
      mode = "fly";
      pos.y = ground.heightAt(p.x, p.z) + 120;
    } else {
      mode = "walk";
      pos.y = ground.heightAt(p.x, p.z) + 1.65;
    }
  }

  void (async () => {
    const loaded = await loadNeighbourhood();
    if (disposed) return;
    data = loaded.data;
    terrain = loaded.terrain;
    sky = buildSky(scene, renderer);
    ground = buildGround(data, terrain);
    scene.add(ground.group);
    roads = buildRoads(data, ground);
    scene.add(roads.group);
    buildings = buildBuildings(data, ground);
    scene.add(buildings.group);
    veg = buildVegetation(data, ground, buildings);
    scene.add(veg.group);
    street = buildStreet(data, ground);
    scene.add(street.group);
    sky.setWeather(weather, renderer, scene);
    applyEnv();
    makePresets(data);
    preset("8330 NE Beck Rd");
    ready = true;
    publish();
  })();

  function setWeather(w: Weather) {
    weather = w;
    if (sky) {
      sky.setWeather(w, renderer, scene);
      applyEnv();
    }
  }
  function setMode(m: Mode) {
    mode = m;
  }

  // ---- Loop -----------------------------------------------------------------
  let raf = 0;
  let last = performance.now();
  let time = 0;
  let frames = 0;
  let stateAt = 0;
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();

  function publish() {
    let address = "";
    let road = "";
    let heading = "";
    if (data) {
      const a = nearestAddress(data, pos.x, pos.z);
      if (a && a.d < 90) address = `${a.address.n} ${signName(a.address.st)}`;
      const r = nearestRoad(data, pos.x, pos.z, ["residential", "tertiary", "secondary"]);
      if (r && r.road.name) road = signName(r.road.name);
      const deg = ((-yaw * 180) / Math.PI + 360) % 360;
      heading = COMPASS[Math.round(deg / 45) % 8];
    }
    onState({ x: pos.x, y: pos.y, z: pos.z, yaw, heading, address, road, weather, mode, ready, frames });
  }

  function frame(now: number) {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    time += dt;
    frames++;

    // Look from the touch stick.
    yaw -= look.x * 1.8 * dt;
    pitch = Math.max(-1.4, Math.min(1.4, pitch - look.y * 1.2 * dt));
    if (keys.has("arrowleft")) yaw += 1.6 * dt;
    if (keys.has("arrowright")) yaw -= 1.6 * dt;

    // Move.
    let mx = stick.x;
    let mz = stick.y;
    if (keys.has("w") || keys.has("arrowup")) mz += 1;
    if (keys.has("s") || keys.has("arrowdown")) mz -= 1;
    if (keys.has("a")) mx -= 1;
    if (keys.has("d")) mx += 1;
    const run = keys.has("shift");
    const speed = mode === "fly" ? (run ? 60 : 22) : run ? 4.2 : 1.6;
    fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    if (mode === "fly") {
      fwd.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
      if (keys.has("q")) pos.y -= speed * dt;
      if (keys.has("e") || keys.has(" ")) pos.y += speed * dt;
    }
    pos.addScaledVector(fwd, mz * speed * dt);
    pos.addScaledVector(right, mx * speed * dt);

    if (ground) {
      const g = ground.heightAt(pos.x, pos.z);
      if (mode === "walk") {
        // Keep out of buildings and trees.
        if (buildings) {
          for (const f of buildings.footprints) {
            const d = Math.hypot(f.cx - pos.x, f.cz - pos.z);
            if (d < f.r - 0.4) {
              const k = (f.r - 0.4 - d) / (d || 1);
              pos.x += (pos.x - f.cx) * k;
              pos.z += (pos.z - f.cz) * k;
            }
          }
        }
        if (veg) {
          for (const t of veg.trunks) {
            const d = Math.hypot(t.x - pos.x, t.z - pos.z);
            if (d < t.r + 0.35) {
              const k = (t.r + 0.35 - d) / (d || 1);
              pos.x += (pos.x - t.x) * k;
              pos.z += (pos.z - t.z) * k;
            }
          }
        }
        const eye = Math.max(g, 0.3) + 1.65;
        pos.y += (eye - pos.y) * Math.min(1, dt * 10);
      } else {
        pos.y = Math.max(pos.y, g + 1.2);
      }
    }
    camera.position.copy(pos);
    camera.rotation.set(0, 0, 0);
    camera.rotateY(yaw);
    camera.rotateX(pitch);

    if (ground) {
      ground.update(time);
      updateWaterCamera(ground, camera);
    }
    veg?.update(time, 0.45 + 0.25 * Math.sin(time * 0.3));
    if (sky) {
      // Shadow frustum follows the eye.
      sky.sun.target.position.set(pos.x, 0, pos.z);
      sky.sun.position.copy(sky.sun.target.position).addScaledVector(sky.sun.position.clone().sub(sky.sun.target.position).normalize(), 500);
    }
    post.render();
    if (now - stateAt > 150) {
      stateAt = now;
      publish();
    }
  }
  raf = requestAnimationFrame(frame);

  (window as unknown as { __beck?: unknown }).__beck = {
    teleport: (x: number, z: number, y: number, p: number, fly = false) => {
      pos.set(x, 0, z);
      yaw = y;
      pitch = p;
      mode = fly ? "fly" : "walk";
      pos.y = (ground?.heightAt(x, z) ?? 0) + (fly ? 40 : 1.65);
    },
    preset,
    presets: () => [...presetTable.keys()],
    frames: () => frames,
    ready: () => ready,
    debug: () => {
      if (!ground || !terrain) return null;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < terrain.data.length; i += 97) {
        lo = Math.min(lo, terrain.data[i]);
        hi = Math.max(hi, terrain.data[i]);
      }
      const g = ground.group.children[0] as THREE.Mesh;
      g.geometry.computeBoundingSphere();
      const bs = g.geometry.boundingSphere!;
      return { h00: ground.heightAt(0, 0), h200: ground.heightAt(200, -300), lo, hi, groundCenter: bs.center.toArray(), groundR: bs.radius, waterY: ground.group.children[1].position.y, children: scene.children.length, groundVisible: g.visible, mat: (g.material as THREE.Material).type };
    },
    state: () => ({ x: pos.x, y: pos.y, z: pos.z, yaw, pitch }),
    weather: setWeather,
  };

  return {
    stick,
    look,
    setWeather,
    setMode,
    preset,
    presets: () => [...presetTable.keys()],
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      street?.dispose();
      veg?.dispose();
      buildings?.dispose();
      roads?.dispose();
      ground?.dispose();
      sky?.dispose();
      post.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
