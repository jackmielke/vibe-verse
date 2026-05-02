import * as THREE from "three";
import { createSky } from "./sky";
import { createTerrain } from "./terrain";
import { createCity } from "./city";
import { createNature } from "./nature";
import { createPlayer } from "./player";
import { createVehicle } from "./vehicle";
import { createInput } from "./input";
import { buildCollision } from "./collision";
import { createAudio } from "./audio";
import type { HudState, Mode } from "./types";

export interface WorldRuntime {
  dispose: () => void;
  onHud: (cb: (s: HudState) => void) => () => void;
  toggleMute: () => void;
  toggleDayNight: () => void;
  setAutoDayNight: (auto: boolean) => void;
  getCamera: () => THREE.PerspectiveCamera;
  getScene: () => THREE.Scene;
  getRenderer: () => THREE.WebGLRenderer;
  getMode: () => Mode;
  getPlayerPos: () => THREE.Vector3;
  getVehiclePos: () => THREE.Vector3;
  getLandmarks: () => { name: string; x: number; z: number }[];
}

export function createWorld(canvas: HTMLCanvasElement): WorldRuntime {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  const sizeRenderer = () => {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
  };
  sizeRenderer();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(72, 1, 0.1, 1500);
  camera.position.set(0, 8, 30);

  const sky = createSky(scene);
  const terrain = createTerrain(scene);
  const city = createCity(scene, { buildableBlocks: terrain.buildableBlocks });
  const nature = createNature(scene);

  const collision = buildCollision([...city.obstacles, ...nature.obstacles]);

  const player = createPlayer(scene);
  // Park the car near Central Plaza
  const carStart = new THREE.Vector3(8, 0, 22);
  const vehicle = createVehicle(scene, carStart);

  const input = createInput(canvas);
  const audio = createAudio();

  // ---- Mode + camera state ----
  let mode: Mode = "walking";
  player.setActive(true);
  vehicle.setActive(false);

  // The mouse yaw/pitch lives in input.state. Player heading mirrors input.yaw.
  // Driving uses its own yaw and ignores mouse for motion.
  const cameraTarget = new THREE.Vector3();
  const cameraDesired = new THREE.Vector3();
  let dayNightAuto = true;

  // ---- HUD subscribers ----
  const hudState: HudState = {
    mode,
    speedKph: 0,
    heading: 0,
    timeOfDay: sky.getTimeOfDay(),
    muted: false,
    hint: "Click to look • WASD move • Shift run • Space jump",
  };
  const hudSubs = new Set<(s: HudState) => void>();
  const pushHud = () => hudSubs.forEach((fn) => fn({ ...hudState }));
  let hudClock = 0;

  // ---- Boot audio on first user click ----
  const onFirstClick = () => {
    audio.start();
    canvas.removeEventListener("click", onFirstClick);
  };
  canvas.addEventListener("click", onFirstClick);

  // ---- Resize ----
  const onResize = () => {
    sizeRenderer();
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", onResize);
  // Run once after layout
  setTimeout(onResize, 0);

  // ---- Helpers ----
  const distXZ = (a: THREE.Vector3, b: THREE.Vector3) => {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
  };

  const tryEnterExit = () => {
    if (mode === "walking") {
      const d = distXZ(player.position, vehicle.position);
      if (d < 4.5) {
        mode = "driving";
        player.setActive(false);
        vehicle.setActive(true);
        hudState.hint = "WASD drive • Space handbrake • F exit";
      }
    } else {
      // Step out to driver seat
      const seat = vehicle.driverSeat();
      mode = "walking";
      player.position.set(seat.x, 0, seat.z);
      // Match heading to where the car is facing so re-entry is intuitive
      input.state.yaw = vehicle.heading;
      player.setActive(true);
      vehicle.setActive(false);
      hudState.hint = "Click to look • WASD move • F enter car";
    }
    hudState.mode = mode;
    pushHud();
  };

  // ---- Frame loop ----
  let raf = 0;
  let last = performance.now();

  const tick = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // Sky / day-night
    sky.update(dt);
    const tod = sky.getTimeOfDay();
    // Night factor 0..1 — peaks around midnight
    const sunY = Math.sin((tod - 0.25) * Math.PI * 2);
    const night = Math.max(0, -sunY);
    city.setNightFactor(night);
    vehicle.setHeadlightsOn(night > 0.15);

    // Input → discrete actions
    if (input.consumeEnterExit()) tryEnterExit();
    if (input.consumeMuteToggle()) {
      const m = !audio.isMuted();
      audio.setMuted(m);
      hudState.muted = m;
      pushHud();
    }
    if (input.consumeDayNightToggle()) {
      dayNightAuto = !dayNightAuto;
      sky.setAuto(dayNightAuto);
    }

    // Update active actor
    if (mode === "walking") {
      player.update(dt, input.state, collision);
    } else {
      vehicle.update(dt, input.state, collision);
    }

    // ---- Camera ----
    if (mode === "walking") {
      const yaw = input.state.yaw;
      const pitch = input.state.pitch;
      const target = player.position;
      cameraTarget.set(target.x, target.y + 1.5, target.z);
      const dist = 5.5;
      const camY = 2.5 - pitch * 3.5;
      cameraDesired.set(
        target.x - Math.sin(yaw) * Math.cos(pitch) * dist,
        target.y + camY,
        target.z - Math.cos(yaw) * Math.cos(pitch) * dist,
      );
      camera.position.lerp(cameraDesired, Math.min(1, dt * 12));
      camera.lookAt(cameraTarget);
    } else {
      const target = vehicle.position;
      const yaw = vehicle.heading;
      const back = 9;
      const up = 4;
      cameraTarget.set(target.x, target.y + 1.6, target.z);
      cameraDesired.set(
        target.x - Math.sin(yaw) * back,
        target.y + up,
        target.z - Math.cos(yaw) * back,
      );
      camera.position.lerp(cameraDesired, Math.min(1, dt * 7));
      camera.lookAt(cameraTarget);
    }

    // ---- HUD ----
    hudClock += dt;
    if (hudClock > 0.12) {
      hudClock = 0;
      const speed = mode === "walking" ? player.speed : Math.abs(vehicle.speed);
      hudState.speedKph = speed * 3.6;
      hudState.heading = mode === "walking" ? input.state.yaw : vehicle.heading;
      hudState.timeOfDay = tod;
      hudState.mode = mode;
      pushHud();
    }

    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    dispose: () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("click", onFirstClick);
      input.dispose();
      audio.dispose();
      renderer.dispose();
      // Free GPU resources
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
        else if (m) m.dispose();
      });
    },
    onHud: (cb) => {
      hudSubs.add(cb);
      cb({ ...hudState });
      return () => hudSubs.delete(cb);
    },
    toggleMute: () => {
      const m = !audio.isMuted();
      audio.setMuted(m);
      hudState.muted = m;
      pushHud();
    },
    toggleDayNight: () => {
      dayNightAuto = !dayNightAuto;
      sky.setAuto(dayNightAuto);
    },
    setAutoDayNight: (a: boolean) => {
      dayNightAuto = a;
      sky.setAuto(a);
    },
    getCamera: () => camera,
    getScene: () => scene,
    getRenderer: () => renderer,
    getMode: () => mode,
    getPlayerPos: () => player.position,
    getVehiclePos: () => vehicle.position,
    getLandmarks: () => city.landmarks,
  };
}
