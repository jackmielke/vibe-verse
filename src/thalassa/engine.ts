/**
 * Thalassa: the engine. Owns the renderer, the scene, the player and the
 * loop, and mounts every part of the world.
 *
 * VR: `renderer.xr` is enabled and the loop runs through `setAnimationLoop`.
 * In the headset the left stick walks, the right stick snap-turns, and a
 * trigger pointed at the ground teleports you there (an arc would be nicer;
 * a straight ray is what every visitor already understands).
 *
 * The player is the Magician's: one rig driven by keys and mouse, a phone's
 * stick and drag, or a headset. Thalassa adds what a town needs on top: walls
 * you cannot walk through, steps you can and cliffs you cannot climb, docks
 * and bridges to stand on, and water to swim in.
 */
import * as THREE from "three";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import { createPlayer } from "@/magician/world/player";
import { createGrass, type Grass } from "@/magician/world/grass";
import { buildMap, heightAt, groundType, Ground, WALK_LIMIT, ISLE, ISLE_TOP, ACROPOLIS, OVERLOOK, MOLE, ISLE_STAIR, isleRadius } from "./map";
import { createTerrain } from "./terrain";
import { createWater } from "./water";
import { createSky } from "./sky";
import { createColliders } from "./colliders";
import { createTown } from "./town";
import { createSanctuary } from "./temple";
import { createShips } from "./ships";
import { createNature } from "./nature";
import { createLife } from "./life";
import { createAmbience, type Ambience } from "./audio";
import type { BuildCtx, FrameCtx, Part, Quality, SurfaceFn } from "./types";

export interface Place { id: string; name: string; x: number; z: number; look: [number, number]; y?: number }

export const PLACES: Place[] = [
  { id: "quay", name: "The Quay", x: 18, z: -22, look: [150, 30] },
  { id: "market", name: "Market", x: -28, z: -27, look: [10, 40] },
  { id: "bridge", name: "Bridge", x: 100, z: 18, look: [150, 22] },
  {
    // At the head of the island stair, between the golden guardians, facing the temple.
    id: "temple", name: "Temple",
    x: ISLE.x + Math.cos(ISLE_STAIR.a1 - 0.08) * (isleRadius(ISLE_STAIR.a1 - 0.08) - 12.5),
    z: ISLE.z + Math.sin(ISLE_STAIR.a1 - 0.08) * (isleRadius(ISLE_STAIR.a1 - 0.08) - 12.5),
    look: [ISLE.x + 1, ISLE.z - 3],
  },
  { id: "lighthouse", name: "Lighthouse", x: MOLE.b.x - 6, z: MOLE.b.z + 1, look: [-20, 30] },
  { id: "acropolis", name: "Upper Town", x: ACROPOLIS.x + 10, z: ACROPOLIS.z + 6, look: [40, 40] },
  { id: "overlook", name: "Overlook", x: OVERLOOK.x + 6, z: OVERLOOK.z - 2, look: [60, 10] },
];

export interface ThalassaWorld {
  canvas(): HTMLCanvasElement;
  vrButton(): HTMLElement;
  goTo(id: string): void;
  setStick(x: number, y: number): void;
  jump(): void;
  setMuted(m: boolean): void;
  wake(): void;
  /** What's under foot, for the HUD. */
  where(): { place: string; swimming: boolean };
  dispose(): void;
}

export interface ThalassaOptions {
  onPlace?(name: string): void;
  onReady?(): void;
  /** Start with the arrival flight. */
  intro?: boolean;
}

declare global {
  interface Window {
    __thalassa?: {
      snapshot(q?: number): string;
      pose(px: number, py: number, pz: number, tx: number, ty: number, tz: number, fov?: number): void;
      free(): void;
      teleport(x: number, z: number, yaw?: number): void;
      player(): { x: number; y: number; z: number; yaw: number };
      settle(seconds: number): void;
      stats(): Record<string, number>;
      goTo(id: string): void;
    };
  }
}

function yawToward(fx: number, fz: number, tx: number, tz: number): number {
  return Math.atan2(-(tx - fx), -(tz - fz));
}

export function createThalassa(container: HTMLElement, options: ThalassaOptions = {}): ThalassaWorld {
  buildMap();
  const coarse = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  const headset = /OculusBrowser|Quest|Pico/i.test(navigator.userAgent);
  const quality: Quality = { tier: headset ? "vr" : coarse ? "phone" : "desktop" };

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.tier === "desktop" ? 2 : 1.5));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.xr.enabled = true;
  renderer.domElement.style.display = "block";
  renderer.domElement.style.touchAction = "none";
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog("#d4ecf7", 220, 1500);
  scene.background = new THREE.Color("#d4ecf7");
  const camera = new THREE.PerspectiveCamera(72, container.clientWidth / Math.max(1, container.clientHeight), 0.1, 2600);

  const applyFov = () => {
    if (renderer.xr.isPresenting) return;
    const aspect = camera.aspect;
    const hfov = (78 * Math.PI) / 180;
    const v = (2 * Math.atan(Math.tan(hfov / 2) / aspect) * 180) / Math.PI;
    camera.fov = Math.max(55, Math.min(95, v));
    camera.updateProjectionMatrix();
  };
  applyFov();

  /* ---- the world ---- */
  const colliders = createColliders();
  const surfaces: SurfaceFn[] = [];
  const ctx: BuildCtx = { colliders, surfaces, quality };
  const sky = createSky();
  if (quality.tier !== "desktop") sky.setShadowSize(70, 2048);
  scene.add(sky.group);
  const terrain = createTerrain({ coreSegs: quality.tier === "desktop" ? 380 : 300 });
  scene.add(terrain.group);
  const water = createWater();
  scene.add(water.mesh);
  const parts: Part[] = [];
  const mount = (p: Part) => { parts.push(p); scene.add(p.group); return p; };
  mount(createTown(ctx));
  mount(createSanctuary(ctx));
  mount(createShips(ctx));
  mount(createNature(ctx));
  mount(createLife(ctx));

  const grass: Grass = createGrass({
    heightAt,
    density: (x, z) => {
      const h = heightAt(x, z);
      if (h < 1.2) return 0;
      const g = groundType(x, z, h);
      if (g !== Ground.Grass) return 0;
      return colliders.blocked(x, z, 0.2, h + 0.5) ? 0 : 1;
    },
    perSquareMetre: quality.tier === "desktop" ? 20 : 12,
    radius: quality.tier === "desktop" ? 36 : 22,
  });
  scene.add(grass.group);

  /* ---- the player ---- */
  const player = createPlayer(container, camera);
  scene.add(player.rig);
  let swimming = false;
  const SWIM_FLOOR = -1.15;

  /** The floor at (x, z) for someone whose feet are at y. */
  const groundAt = (x: number, z: number, y = Infinity): number => {
    let g = heightAt(x, z);
    for (const s of surfaces) {
      const h = s(x, z);
      if (h !== null && h > g && h <= y + 1.0) g = h;
    }
    return Math.max(g, SWIM_FLOOR);
  };

  const last = new THREE.Vector3();
  const solve = (p: THREE.Vector3) => {
    colliders.solve(p);
    // Steps yes, cliffs no. Out of the water you can haul yourself onto a
    // quay or a dock; you cannot climb a cliff.
    const limit = p.y < -0.4 ? 2.95 : 0.85;
    const ok = (x: number, z: number) => groundAt(x, z, p.y) - p.y <= limit;
    if (!ok(p.x, p.z)) {
      if (ok(p.x, last.z)) p.z = last.z;
      else if (ok(last.x, p.z)) p.x = last.x;
      else { p.x = last.x; p.z = last.z; }
    }
    p.x = Math.max(-WALK_LIMIT, Math.min(WALK_LIMIT, p.x));
    p.z = Math.max(-WALK_LIMIT, Math.min(WALK_LIMIT, p.z));
  };

  /* ---- VR hands ---- */
  const controllerFactory = new XRControllerModelFactory();
  const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  const rayMat = new THREE.LineBasicMaterial({ color: "#ffd27a", transparent: true, opacity: 0.75 });
  const marker = new THREE.Mesh(new THREE.RingGeometry(0.35, 0.5, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#ffd27a", transparent: true, opacity: 0.85, depthWrite: false }));
  marker.visible = false;
  scene.add(marker);
  const controllers: THREE.Group[] = [];
  const rays: THREE.Line[] = [];
  for (let i = 0; i < 2; i++) {
    const grip = renderer.xr.getControllerGrip(i);
    grip.add(controllerFactory.createControllerModel(grip));
    player.rig.add(grip);
    const ctrl = renderer.xr.getController(i);
    const ray = new THREE.Line(rayGeo, rayMat);
    ray.scale.z = 6;
    ctrl.add(ray);
    rays.push(ray);
    player.rig.add(ctrl);
    controllers.push(ctrl);
  }
  const ctrlPos = new THREE.Vector3();
  const ctrlDir = new THREE.Vector3();
  const ctrlQ = new THREE.Quaternion();
  /** March a controller's ray to the ground; null if it points at the sky. */
  const aimGround = (c: THREE.Group): THREE.Vector3 | null => {
    c.getWorldPosition(ctrlPos);
    c.getWorldQuaternion(ctrlQ);
    ctrlDir.set(0, 0, -1).applyQuaternion(ctrlQ);
    let prev = 0;
    for (let t = 0.5; t < 60; t += t < 10 ? 0.5 : 1.5) {
      const x = ctrlPos.x + ctrlDir.x * t, y = ctrlPos.y + ctrlDir.y * t, z = ctrlPos.z + ctrlDir.z * t;
      if (y <= groundAt(x, z, y)) {
        let lo = prev, hi = t;
        for (let k = 0; k < 6; k++) {
          const m = (lo + hi) / 2;
          const mx = ctrlPos.x + ctrlDir.x * m, mz = ctrlPos.z + ctrlDir.z * m;
          if (ctrlPos.y + ctrlDir.y * m <= groundAt(mx, mz, ctrlPos.y + ctrlDir.y * m)) hi = m; else lo = m;
        }
        const hx = ctrlPos.x + ctrlDir.x * hi, hz = ctrlPos.z + ctrlDir.z * hi;
        return new THREE.Vector3(hx, groundAt(hx, hz, ctrlPos.y + ctrlDir.y * hi), hz);
      }
      prev = t;
    }
    return null;
  };
  const aiming = new Set<THREE.Group>();
  const headW = new THREE.Vector3();
  const onSelectStart = (c: THREE.Group) => () => { aiming.add(c); };
  const onSelectEnd = (c: THREE.Group) => () => {
    aiming.delete(c);
    const hit = aimGround(c);
    marker.visible = false;
    if (!hit) return;
    if (colliders.blocked(hit.x, hit.z, 0.3, hit.y + 0.5)) return;
    // Put the head, not the rig's origin, on the spot.
    renderer.xr.getCamera().getWorldPosition(headW);
    const ox = headW.x - player.position.x, oz = headW.z - player.position.z;
    player.teleport(hit.x - ox, hit.z - oz);
    player.position.y = hit.y;
    last.copy(player.position);
    ambience.play("whoosh");
  };
  const selectHandlers = controllers.map((c) => {
    const s = onSelectStart(c), e = onSelectEnd(c);
    c.addEventListener("selectstart", s);
    c.addEventListener("selectend", e);
    return { s, e };
  });

  /* ---- sound ---- */
  const ambience: Ambience = createAmbience();

  /* ---- places ---- */
  let placeName = "";
  const placeFor = (x: number, z: number): string => {
    let best = "The Harbor", bd = 26;
    for (const p of PLACES) {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < bd) { bd = d; best = p.name; }
    }
    if (Math.hypot(x - ISLE.x, z - ISLE.z) < 34) return "Temple of the Sea";
    return best;
  };
  const goTo = (id: string) => {
    const p = PLACES.find((q) => q.id === id) ?? PLACES[0];
    const probe = p.id === "temple" ? ISLE_TOP + 2 : 999;
    // Never arrive inside a tree, a planter or a wall: spiral out to clear ground.
    let x = p.x, z = p.z;
    for (let k = 0; k < 120; k++) {
      const a = k * 2.399, rr = Math.sqrt(k) * 1.2;
      const cx = p.x + Math.cos(a) * rr, cz = p.z + Math.sin(a) * rr;
      if (!colliders.blocked(cx, cz, 2, groundAt(cx, cz, probe) + 1)) { x = cx; z = cz; break; }
    }
    player.teleport(x, z, yawToward(x, z, p.look[0], p.look[1]));
    player.position.y = groundAt(x, z, probe);
    last.copy(player.position);
    intro = -1;
  };

  /* ---- shot camera (scripts) and the arrival flight ---- */
  let shot: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  const shotCam = new THREE.PerspectiveCamera(60, camera.aspect, 0.1, 2600);
  let intro = options.intro && !navigator.webdriver ? 0 : -1;
  const INTRO_S = 7.5;
  const introFrom = new THREE.Vector3(-150, 150, 230);
  const introLook = new THREE.Vector3(40, 0, 10);

  goTo("quay");
  if (intro >= 0) intro = 0;

  /* ---- the loop ---- */
  const clock = new THREE.Clock();
  let time = 0;
  const frameCtx: FrameCtx = { player: player.position, camera, sunDir: sky.sunDir };
  let fpsAcc = 0, fpsFrames = 0, fps = 0;
  const camWorld = new THREE.Vector3();

  const step = (dt: number) => {
    time += dt;
    const xr = renderer.xr.isPresenting ? renderer.xr.getSession() : null;
    last.copy(player.position);
    const flying = intro >= 0 || !!shot;
    player.update(dt, (x, z) => groundAt(x, z, player.position.y), {
      gravity: "normal",
      speed: swimming ? 0.6 : 1,
      eye: 1,
      xr,
      xrCamera: xr ? renderer.xr.getCamera() : null,
      solve,
      frozen: flying,
    });
    swimming = player.position.y < -0.6;

    for (const p of parts) p.update?.(dt, time, frameCtx);
    terrain.update(time);
    camera.getWorldPosition(camWorld);
    water.update(time, sky.sunDir);
    sky.update(dt, time, renderer.xr.isPresenting ? renderer.xr.getCamera() : camera, player.position);
    grass.update(dt, time, player.position, {
      windDir: 2.2 + Math.sin(time * 0.05) * 0.3,
      wind: 0.35 + Math.sin(time * 0.23) * 0.12,
      snow: 0,
      tint: new THREE.Color(1, 1, 1),
      sunDir: sky.sunDir,
      sunColor: sky.sun.color,
      night: 0,
    });
    ambience.update(dt, { x: player.position.x, y: player.position.y, z: player.position.z, swimming });

    // VR aiming marker.
    if (xr) {
      marker.visible = false;
      for (const c of aiming) {
        const hit = aimGround(c);
        if (hit) { marker.position.set(hit.x, hit.y + 0.05, hit.z); marker.visible = true; }
      }
    }

    const name = placeFor(player.position.x, player.position.z);
    if (name !== placeName) { placeName = name; options.onPlace?.(name); }
  };

  let readySent = false;
  const render = () => {
    if (shot) {
      shotCam.aspect = camera.aspect;
      shotCam.position.copy(shot.pos);
      shotCam.lookAt(shot.target);
      shotCam.updateProjectionMatrix();
      sky.update(0, time, shotCam, shot.target);
      renderer.render(scene, shotCam);
      return;
    }
    if (intro >= 0 && !renderer.xr.isPresenting) {
      const t = Math.min(1, intro / INTRO_S);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const eye = new THREE.Vector3();
      camera.getWorldPosition(eye);
      const look = new THREE.Vector3();
      camera.getWorldDirection(look).multiplyScalar(30).add(eye);
      shotCam.aspect = camera.aspect;
      shotCam.fov = camera.fov;
      shotCam.position.copy(introFrom).lerp(eye, e);
      shotCam.lookAt(introLook.clone().lerp(look, e));
      shotCam.updateProjectionMatrix();
      renderer.render(scene, shotCam);
      return;
    }
    renderer.render(scene, camera);
  };

  const frame = () => {
    const dt = Math.min(clock.getDelta(), 1 / 15);
    if (intro >= 0) { intro += dt; if (intro > INTRO_S) intro = -1; }
    step(dt);
    render();
    fpsAcc += dt; fpsFrames++;
    if (fpsAcc > 1) { fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0; }
    if (!readySent) { readySent = true; options.onReady?.(); }
  };
  renderer.setAnimationLoop(frame);

  const onResize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    applyFov();
  };
  window.addEventListener("resize", onResize);

  // In the headset, less of what is optional.
  const onXrStart = () => {
    intro = -1;
    sky.setShadowSize(60, 2048);
    grass.setQuality(10, 18);
    renderer.setPixelRatio(1);
    renderer.xr.setFoveation(1);
  };
  const onXrEnd = () => {
    if (quality.tier === "desktop") { sky.setShadowSize(95, 4096); grass.setQuality(20, 36); }
    onResize();
  };
  renderer.xr.addEventListener("sessionstart", onXrStart);
  renderer.xr.addEventListener("sessionend", onXrEnd);

  window.__thalassa = {
    snapshot(q = 0.9) {
      render();
      return renderer.domElement.toDataURL("image/jpeg", q);
    },
    pose(px, py, pz, tx, ty, tz, fov = 60) {
      shot = { pos: new THREE.Vector3(px, py, pz), target: new THREE.Vector3(tx, ty, tz) };
      shotCam.fov = fov;
    },
    free() { shot = null; },
    teleport(x, z, yaw) {
      player.teleport(x, z, yaw);
      player.position.y = groundAt(x, z, 999);
      last.copy(player.position);
      intro = -1;
    },
    player: () => ({ x: player.position.x, y: player.position.y, z: player.position.z, yaw: player.yaw() }),
    settle(seconds) {
      const n = Math.ceil(seconds * 30);
      for (let i = 0; i < n; i++) step(1 / 30);
    },
    stats: () => ({
      fps: Math.round(fps),
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      colliders: colliders.count(),
      grass: grass.stats().blades,
      ...Object.fromEntries(parts.map((p, i) => {
        let n = 0;
        p.group.traverse((o) => { if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints) n++; });
        return [`meshes${i}`, n];
      })),
    }),
    goTo,
  };

  return {
    canvas: () => renderer.domElement,
    vrButton() {
      const b = VRButton.createButton(renderer);
      b.style.position = "static";
      b.style.margin = "0";
      b.style.left = "auto";
      b.style.bottom = "auto";
      return b;
    },
    goTo,
    setStick: (x, y) => player.setStick(x, y),
    jump: () => player.jump(),
    setMuted: (m) => ambience.setMuted(m),
    wake: () => ambience.resume(),
    where: () => ({ place: placeName, swimming }),
    dispose() {
      renderer.setAnimationLoop(null);
      window.removeEventListener("resize", onResize);
      renderer.xr.removeEventListener("sessionstart", onXrStart);
      renderer.xr.removeEventListener("sessionend", onXrEnd);
      controllers.forEach((c, i) => {
        c.removeEventListener("selectstart", selectHandlers[i].s);
        c.removeEventListener("selectend", selectHandlers[i].e);
      });
      void renderer.xr.getSession()?.end().catch(() => undefined);
      player.dispose();
      for (const p of parts) p.dispose();
      grass.dispose();
      terrain.dispose();
      water.dispose();
      sky.dispose();
      ambience.dispose();
      rayGeo.dispose();
      rayMat.dispose();
      marker.geometry.dispose();
      (marker.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.domElement.remove();
      delete window.__thalassa;
    },
  };
}
