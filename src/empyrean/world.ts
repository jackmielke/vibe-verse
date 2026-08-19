/**
 * THE EMPYREAN — the engine.
 *
 * Owns the renderer, the loop, the input and the teardown. Everything with an
 * opinion about how the place looks lives in its own file next door; this one
 * wires them together and makes sure that when the page unmounts, the WebGL
 * context goes with it. Browsers cap live contexts at around sixteen, and a
 * world that leaks one breaks the *next* world the visitor opens.
 *
 * The two things worth knowing before you change anything here:
 *
 * **The body is whoever you already are.** The character is read straight from
 * the same `lobby.character` key the lobby, the hub and the profile all write,
 * through `loadCharacterRig` — which is the module that knows half the catalog
 * has no `url` at all and is assembled from primitives instead. There is no
 * picker in this world and there should not be one.
 *
 * **The reflection is the scene graph, not a texture.** `terrain.mirror` is a
 * group scaled by -1 on Y; the citadel is `clone(true)`d into it, sharing every
 * geometry and material with the original. That is the whole mirror: one extra
 * draw per mesh, no second render pass, and it is correct from every angle
 * because it is the same geometry seen from underneath.
 */
import * as THREE from "three";
import { findCharacter } from "@/lib/characters";
import { loadCharacterRig, type CharacterRig } from "@/lib/characterRig";
import { RUN_SPEED } from "@/lib/worldPhysics";
import { buildSky, SUN_DIR } from "./sky";
import { buildTerrain, groundHeight } from "./terrain";
import { buildCitadel, syncCitadelUniforms, type Blocker, type Deck } from "./citadel";
import { buildPlume } from "./plume";
import { buildPostFx } from "./postfx";
import { createEmpyreanAudio, type EmpyreanAudio } from "./audio";
import { makeFlyer, stepFlyer, BODY_R, type FlyerState } from "./flight";
import { ISLAND_Y, KILL_Y, LAKE_R, PLATEAU_R, SPAWN, WATER_Y } from "./config";

export interface EmpyreanState {
  /** Metres above the snow. */
  altitude: number;
  /** Horizontal speed, m/s. */
  speed: number;
  /** Clear air directly below, m. */
  drop: number;
  thrusting: boolean;
  /** Catalog label of whoever is flying, once the rig has arrived. */
  who: string;
  /** Roughly where you are, in words, for the HUD. */
  place: string;
}

/** Touch and the page write into this; the loop reads it. */
export interface EmpyreanStick {
  x: number;
  y: number;
  jet: boolean;
  boost: boolean;
}

export interface EmpyreanWorld {
  readonly stick: EmpyreanStick;
  setMuted(muted: boolean): void;
  /** Put the flyer back on the plaza. */
  recall(): void;
  dispose(): void;
}

export interface EmpyreanOptions {
  container: HTMLElement;
  onState: (s: EmpyreanState) => void;
  muted?: boolean;
  /**
   * Capture mode. The camera flies a slow arc on the composition the whole
   * world was built around — island centred, lake under it, mountains at the
   * edges — and the player is not in the frame. `?shot` sets it.
   */
  shot?: boolean;
}

interface Quality {
  tier: "low" | "high";
  maxRatio: number;
  antialias: boolean;
  shadow: boolean;
}

function pickQuality(): Quality {
  const coarse = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  const small = typeof window !== "undefined" && window.innerWidth < 900;
  if (coarse || small) return { tier: "low", maxRatio: 1.75, antialias: false, shadow: false };
  return { tier: "high", maxRatio: 2, antialias: true, shadow: false };
}

/** Where you are, said out loud. Cheap, and it does a lot for the HUD. */
function placeName(p: THREE.Vector3): string {
  const r = Math.hypot(p.x, p.z);
  if (r < PLATEAU_R * 1.5) {
    if (p.y > ISLAND_Y + 120) return "Above the spires";
    if (p.y > ISLAND_Y - 6) return "The Plaza";
    if (p.y > ISLAND_Y - 70) return "The Terraces";
    return "Under the keel";
  }
  if (p.y > ISLAND_Y + 220) return "The high air";
  if (r < LAKE_R) return p.y < 4 ? "On the mirror" : "Over the mirror";
  if (r < LAKE_R * 1.4) return "The shore";
  return "The white ranges";
}

export function createEmpyrean(options: EmpyreanOptions): EmpyreanWorld {
  const { container, onState } = options;
  const quality = pickQuality();
  const shotMode = !!options.shot;

  /* ---- renderer -------------------------------------------------------- */
  const renderer = new THREE.WebGLRenderer({
    antialias: quality.antialias,
    powerPreference: "high-performance",
    alpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.maxRatio));
  renderer.setSize(
    container.clientWidth || window.innerWidth,
    container.clientHeight || window.innerHeight,
  );
  // Every buffer before the grade pass is scene-linear radiance. postfx.ts is
  // the only thing in this world that tone maps, and it does it exactly once.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x150c22, 1);
  container.appendChild(renderer.domElement);
  const canvas = renderer.domElement;
  canvas.style.display = "block";
  canvas.style.touchAction = "none";
  canvas.style.cursor = "grab";

  const scene = new THREE.Scene();
  // Deep and pink, matched to the below-horizon haze the sky dome paints, so
  // the range fades into the sky rather than into a wall of grey.
  scene.fog = new THREE.FogExp2(0xf3bfb2, 0.00016);

  const camera = new THREE.PerspectiveCamera(
    58,
    (container.clientWidth || 1) / (container.clientHeight || 1),
    0.35,
    22000,
  );

  /* ---- world ----------------------------------------------------------- */
  const sky = buildSky();
  scene.add(sky.mesh);

  const terrain = buildTerrain();
  scene.add(terrain.group);

  const citadel = buildCitadel();
  scene.add(citadel.group);

  // The reflection. `clone(true)` copies the hierarchy and shares every
  // geometry and material, so the mirrored city costs draws and nothing else —
  // and it can never drift out of step with the real one.
  const citadelMirror = citadel.group.clone(true);
  terrain.mirror.add(citadelMirror);
  // The ranges reflect too. Same trick, one mesh.
  const snow = terrain.group.getObjectByName("empyrean-snow") as THREE.Mesh | null;
  if (snow) terrain.mirror.add(snow.clone());

  /* ---- light ----------------------------------------------------------
   * Two lights, and both of them are the sky. Only the snow and the character
   * are lit by them at all — the towers, the rock, the water and the lamps are
   * shaders that compute their own radiance. */
  const sun = new THREE.DirectionalLight(0xffd0a4, 3.1);
  sun.position.copy(SUN_DIR).multiplyScalar(3000);
  scene.add(sun);
  const skyFill = new THREE.HemisphereLight(0xffc6d6, 0x6f5c8a, 1.7);
  scene.add(skyFill);
  // A cold kicker from the anti-sun side, which is what keeps a character
  // from being a black cut-out against a very bright sky.
  const rim = new THREE.DirectionalLight(0x9fd4ff, 0.85);
  rim.position.set(-SUN_DIR.x, 0.4, -SUN_DIR.z).multiplyScalar(1000);
  scene.add(rim);

  /* ---- the body -------------------------------------------------------- */
  const BODY_H = 1.8;
  const body = new THREE.Group();
  body.name = "empyrean-body";
  scene.add(body);

  const plume = buildPlume();
  body.add(plume.flames);
  scene.add(plume.trail);

  let rig: CharacterRig | null = null;
  let rigDropped = false;
  let who = "";
  const charId =
    (typeof window !== "undefined" &&
      (localStorage.getItem("lobby.character") ?? localStorage.getItem("city.character"))) ||
    "vibey";
  const spec = findCharacter(charId);
  void loadCharacterRig(spec, {
    height: BODY_H,
    fitBy: "height",
    center: true,
    castShadow: false,
    walkSpeed: RUN_SPEED * 0.5,
  })
    .then((r) => {
      // The world may already have been torn down while the GLB was in
      // flight; mounting into a disposed scene leaks the whole rig.
      if (rigDropped) return r.dispose();
      rig = r;
      who = spec.label;
      body.add(r.object);
    })
    .catch(() => {
      /* A missing model costs you a body, not the world. */
    });

  /* ---- collision -------------------------------------------------------
   * Two flat arrays and a linear scan. Ninety-odd boxes at sixty frames is
   * five thousand comparisons a second, which is nothing, and a spatial index
   * here would be a structure to keep correct in exchange for no measurable
   * win. */
  const blockers: Blocker[] = citadel.blockers;
  const decks: Deck[] = citadel.decks;

  const flyerWorld = {
    supportAt(x: number, z: number, fromY: number): number {
      // The ground: snow outside the lake, ice on it. The lake is frozen and
      // you are meant to be able to stand on your own reflection.
      let best = Math.hypot(x, z) < LAKE_R ? WATER_Y : groundHeight(x, z);
      for (let i = 0; i < decks.length; i++) {
        const d = decks[i];
        if (d.y > fromY || d.y <= best) continue;
        if (d.r !== undefined) {
          if (Math.hypot(x, z) <= d.r) best = d.y;
        } else if (
          Math.abs(x - (d.x ?? 0)) <= (d.hx ?? 0) &&
          Math.abs(z - (d.z ?? 0)) <= (d.hz ?? 0)
        ) {
          best = d.y;
        }
      }
      return best;
    },
    blockedAt(x: number, z: number, y: number): boolean {
      for (let i = 0; i < blockers.length; i++) {
        const b = blockers[i];
        // Not inside a building you are standing on the roof of, and not
        // inside one you are flying underneath.
        if (y >= b.top - 0.15 || y < b.bottom - 0.15) continue;
        if (Math.abs(x - b.x) <= b.hx + BODY_R && Math.abs(z - b.z) <= b.hz + BODY_R) return true;
      }
      return false;
    },
    killY: KILL_Y,
    spawn: SPAWN,
  };

  const flyer: FlyerState = makeFlyer(SPAWN);

  /* ---- input ----------------------------------------------------------- */
  const keys = new Set<string>();
  const stick: EmpyreanStick = { x: 0, y: 0, jet: false, boost: false };
  let camYaw = SPAWN.yaw;
  let camPitch = 0.14;
  let camDist = 13;

  const onKeyDown = (e: KeyboardEvent) => {
    keys.add(e.code);
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
      e.preventDefault();
    }
    if (e.code === "KeyR") recall();
    audio?.resume();
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  const onBlur = () => keys.clear();
  window.addEventListener("keydown", onKeyDown, { passive: false });
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  // Drag to look. Deliberately not pointer lock: this world has a HUD you
  // want to be able to click, it opens on a phone as often as not, and the
  // capture harness cannot spend a gesture on acquiring a lock.
  let dragId = -1;
  let lastX = 0;
  let lastY = 0;
  const onPointerDown = (e: PointerEvent) => {
    if (dragId !== -1) return;
    dragId = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture?.(e.pointerId);
    canvas.style.cursor = "grabbing";
    audio?.resume();
  };
  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerId !== dragId) return;
    camYaw -= (e.clientX - lastX) * 0.0042;
    camPitch = THREE.MathUtils.clamp(camPitch + (e.clientY - lastY) * 0.0042, -0.85, 1.15);
    lastX = e.clientX;
    lastY = e.clientY;
  };
  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerId !== dragId) return;
    dragId = -1;
    canvas.style.cursor = "grab";
  };
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);

  const onWheel = (e: WheelEvent) => {
    camDist = THREE.MathUtils.clamp(camDist * Math.exp(e.deltaY * 0.0011), 3.5, 160);
    e.preventDefault();
  };
  canvas.addEventListener("wheel", onWheel, { passive: false });

  const onResize = () => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    postfx.setSize(w, h);
  };
  window.addEventListener("resize", onResize);

  /* ---- audio ----------------------------------------------------------- */
  let audio: EmpyreanAudio | null = shotMode ? null : createEmpyreanAudio();
  audio?.setMuted(options.muted ?? false);

  const postfx = buildPostFx(renderer, quality.tier);

  function recall() {
    flyer.position.set(SPAWN.x, SPAWN.y, SPAWN.z);
    flyer.velocity.set(0, 0, 0);
    flyer.yaw = SPAWN.yaw;
    camYaw = SPAWN.yaw;
    camPitch = 0.14;
  }

  /* ---- loop ------------------------------------------------------------ */
  const clock = new THREE.Clock();
  let raf = 0;
  let disposed = false;
  let stateTimer = 0;
  const camTarget = new THREE.Vector3();
  const camWant = new THREE.Vector3();
  const packPos = new THREE.Vector3();
  // First frame is placed, not lerped — a camera that eases in from the origin
  // spends the first second flying through the mountains.
  let camPlaced = false;

  const tick = () => {
    if (disposed) return;
    raf = requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05);
    const time = clock.elapsedTime;

    if (shotMode) {
      /* The card composition, exactly: island centred and a little above the
       * lens, the lake filling the lower third, the sun behind the towers. A
       * very slow orbit so a recorder gets motion without the frame changing
       * enough to stop being the picture. */
      const a = Math.PI * 0.5 + time * 0.018;
      // Just inside the lake's edge, a couple of hundred metres up: high
      // enough that the ice reads as a mirror rather than as a line, low
      // enough that you are still looking *up* at the city.
      camera.position.set(Math.sin(a) * 850, 250, Math.cos(a) * 850);
      camera.lookAt(0, ISLAND_Y - 20, 0);
      body.visible = false;
    } else {
      /* ---- gather input ---- */
      let f = 0;
      let s = 0;
      if (keys.has("KeyW") || keys.has("ArrowUp")) f += 1;
      if (keys.has("KeyS") || keys.has("ArrowDown")) f -= 1;
      if (keys.has("KeyD") || keys.has("ArrowRight")) s += 1;
      if (keys.has("KeyA") || keys.has("ArrowLeft")) s -= 1;
      // The touch stick's Y is screen-down-positive, which is forward-negative.
      f = THREE.MathUtils.clamp(f - stick.y, -1, 1);
      s = THREE.MathUtils.clamp(s + stick.x, -1, 1);

      stepFlyer(
        flyer,
        {
          forward: f,
          strafe: s,
          run: keys.has("ShiftLeft") || keys.has("ShiftRight") || stick.boost,
          jet: keys.has("Space") || stick.jet,
          camYaw,
        },
        flyerWorld,
        dt,
      );

      body.position.copy(flyer.position);
      body.rotation.set(0, flyer.yaw, 0);
      // Lean. Applied to the body's own X after the yaw, so it tips forward
      // along the direction of travel rather than sideways.
      body.rotateX(flyer.pitch);

      /* ---- camera ----
       * A plain orbit at `camDist`, raised a little so you are looking slightly
       * down at the body, and pulled up whenever it would end up inside the
       * plaza. No collision sweep against the towers: a camera that ducks
       * around fifty slabs is a camera that never stops moving. */
      /* Aim above the head, not at the feet.
       *
       * Aiming at the body and then lifting the lens tips the whole view
       * downward, and the world opens on three-quarters of a frame of paving.
       * Aiming a couple of metres over the character puts the horizon back
       * where a person standing there would find it and leaves the body in
       * the lower third, which is where a third-person camera wants it. */
      camTarget.copy(flyer.position);
      camTarget.y += 3.0;
      const cp = Math.cos(camPitch);
      camWant.set(
        camTarget.x + Math.sin(camYaw) * cp * camDist,
        camTarget.y + Math.sin(camPitch) * camDist,
        camTarget.z + Math.cos(camYaw) * cp * camDist,
      );
      const floor = flyerWorld.supportAt(camWant.x, camWant.z, camWant.y) + 1.2;
      if (camWant.y < floor) camWant.y = floor;
      /**
       * And pull in if that put the lens inside a building.
       *
       * Not a sweep — a handful of samples along the line back to the body,
       * taking the first clear one. A proper sweep against fifty slabs gives a
       * camera that is always ducking; this only fires when the shot is
       * genuinely inside something, which on a plaza this dense is often
       * enough that without it the world opens on the inside of a wall.
       */
      if (flyerWorld.blockedAt(camWant.x, camWant.z, camWant.y)) {
        for (let step = 1; step <= 6; step++) {
          const k = 1 - step / 7;
          const tx = camTarget.x + (camWant.x - camTarget.x) * k;
          const tz = camTarget.z + (camWant.z - camTarget.z) * k;
          const ty = camTarget.y + (camWant.y - camTarget.y) * k;
          if (!flyerWorld.blockedAt(tx, tz, ty)) {
            camWant.set(tx, ty, tz);
            break;
          }
          if (step === 6) camWant.copy(camTarget).y += 1.0;
        }
      }
      if (camPlaced) camera.position.lerp(camWant, Math.min(1, dt * 7));
      else {
        camera.position.copy(camWant);
        camPlaced = true;
      }
      camera.lookAt(camTarget);
    }

    /* ---- the world moves ---- */
    sky.update(time, camera);
    terrain.update(time, camera);
    citadel.update(time);
    syncCitadelUniforms(citadel.group, SUN_DIR, camera.position);
    syncCitadelUniforms(citadelMirror, SUN_DIR, camera.position);

    // The pack sits between the shoulder blades, in body space.
    packPos.set(0, 1.1, -0.24).applyEuler(body.rotation).add(body.position);
    plume.update(dt, time, shotMode ? 0 : flyer.burn, packPos, flyer.velocity);

    if (rig) {
      // Locomotion is ground speed only — a character sprinting on air while
      // hovering is the tell that a walk cycle was wired to velocity.
      const ground = flyer.grounded ? Math.hypot(flyer.velocity.x, flyer.velocity.z) : 0;
      rig.setLocomotion(Math.min(1, ground / RUN_SPEED));
      rig.update(dt);
    }

    const speed = Math.hypot(flyer.velocity.x, flyer.velocity.z);
    audio?.update(speed, flyer.burn, Math.max(0, flyer.position.y));

    postfx.render(scene, camera, time);

    /* ---- HUD ---- */
    stateTimer += dt;
    if (stateTimer > 0.1) {
      stateTimer = 0;
      onState({
        altitude: flyer.position.y,
        speed,
        drop: flyer.drop,
        thrusting: flyer.thrusting,
        who,
        place: placeName(flyer.position),
      });
    }
  };
  raf = requestAnimationFrame(tick);

  /**
   * Test aid. The only honest way to check a world this size is to open it,
   * and the harness that opens it needs to be able to put the flyer somewhere
   * specific without holding W for ninety seconds in a software rasteriser.
   */
  const debug = {
    character: () => charId,
    warp: (x: number, y: number, z: number) => {
      flyer.position.set(x, y, z);
      flyer.velocity.set(0, 0, 0);
      camPlaced = false;
    },
    look: (yaw: number, pitch: number) => {
      camYaw = yaw;
      camPitch = pitch;
    },
    state: () => ({
      position: flyer.position.toArray(),
      grounded: flyer.grounded,
      support: flyerWorld.supportAt(flyer.position.x, flyer.position.z, flyer.position.y + 0.35),
    }),
  };
  (window as unknown as { __empyrean?: typeof debug }).__empyrean = debug;

  return {
    stick,
    setMuted(muted) {
      audio?.setMuted(muted);
    },
    recall,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      audio?.dispose();
      audio = null;
      rigDropped = true;
      rig?.dispose();
      rig = null;
      delete (window as unknown as { __empyrean?: unknown }).__empyrean;
      sky.dispose();
      terrain.dispose();
      citadel.dispose();
      plume.dispose();
      postfx.dispose();
      scene.clear();
      renderer.dispose();
      // forceContextLoss is the only thing that actually hands the context
      // back on Safari; dispose() alone leaves it live until GC.
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
