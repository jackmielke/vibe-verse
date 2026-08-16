/**
 * The Glass Lake — the engine.
 *
 * Owns the renderer, the loop and the teardown. Everything with an opinion
 * about how it looks lives in its own file next door; this one wires them
 * together and makes sure that when the page unmounts, the WebGL context
 * goes with it. Browsers cap live contexts at around sixteen, and a world
 * that leaks one breaks the *next* world the visitor opens.
 */
import * as THREE from "three";
import { buildSky } from "./sky";
import { buildIce } from "./ice";
import { buildTrails } from "./trails";
import { buildSkater } from "./skater";
import { buildScenery } from "./scenery";
import { buildShards } from "./shards";
import { buildPostFx } from "./postfx";
import { findCharacter } from "@/lib/characters";
import { loadCharacterRig, type CharacterRig } from "@/lib/characterRig";
import { createLakeAudio, type LakeAudio } from "./audio";

export const LAKE_RADIUS = 190;
const TRAIL_EXTENT = 200;      // half-width of the trail buffer, in metres
const SHARD_COUNT = 12;

export interface LakeState {
  shards: number;
  total: number;
  speed: number;
  energy: number;
  /** Metres to the nearest shard left, for the compass chip. */
  nearest: number;
  complete: boolean;
}

export interface LakeStick {
  x: number;
  y: number;
  boost: boolean;
}

export interface GlassLakeWorld {
  /** Touch controls write straight into this; the loop reads it. */
  readonly stick: LakeStick;
  hop(): void;
  setMuted(muted: boolean): void;
  restart(): void;
  dispose(): void;
}

export interface GlassLakeOptions {
  container: HTMLElement;
  onState: (state: LakeState) => void;
  muted?: boolean;
}

function pickQuality(): { tier: "low" | "high"; auroraSteps: number; snow: number; maxRatio: number } {
  const coarse =
    typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  const small = typeof window !== "undefined" && window.innerWidth < 900;
  // The aurora is a per-pixel loop, so the step count is the single biggest
  // lever on a phone — and going from 22 steps to 12 costs far less than it
  // sounds, because the curtains are low-frequency by nature.
  if (coarse || small) return { tier: "low", auroraSteps: 12, snow: 900, maxRatio: 2 };
  return { tier: "high", auroraSteps: 22, snow: 2200, maxRatio: 2 };
}

export function createGlassLake(options: GlassLakeOptions): GlassLakeWorld {
  const { container, onState } = options;
  const quality = pickQuality();

  // ---- Renderer --------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({
    antialias: quality.tier === "high",
    powerPreference: "high-performance",
    alpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.maxRatio));
  renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
  // Every buffer in this world is scene-linear and the grade pass is the
  // only thing that tone maps. See postfx.ts.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x02030a, 1);
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.touchAction = "none";

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    62,
    (container.clientWidth || 1) / (container.clientHeight || 1),
    0.1,
    6000,
  );
  camera.position.set(0, 3, 9);

  // ---- The world -------------------------------------------------------
  const sky = buildSky(quality.auroraSteps);
  scene.add(sky.mesh);

  const ice = buildIce({
    radius: LAKE_RADIUS,
    trailExtent: TRAIL_EXTENT,
    auroraSteps: Math.max(8, Math.round(quality.auroraSteps * 0.6)),
  });
  scene.add(ice.mesh);

  const trails = buildTrails(quality.tier === "high" ? 1024 : 512, TRAIL_EXTENT, 26);
  trails.clear(renderer);
  ice.setTrailTexture(trails.texture);

  const scenery = buildScenery(LAKE_RADIUS, quality.snow);
  scene.add(scenery.group);

  const shards = buildShards(LAKE_RADIUS, SHARD_COUNT);
  scene.add(shards.group);

  const skater = buildSkater();
  scene.add(skater.group, skater.scarfGroup);

  // Whoever you already are, on the ice.
  //
  // Read straight from the same localStorage key the lobby, the hub and
  // the profile all write, so the character you picked anywhere in the
  // vibeverse is the one standing on the lake — no picker of its own, and
  // no second copy of the roster. The load is not awaited: the world is
  // skateable on the first frame and the body drops in when it arrives.
  const SKATER_HEIGHT = 1.7;
  let rig: CharacterRig | null = null;
  let rigDropped = false;
  const charId =
    (typeof window !== "undefined" &&
      (localStorage.getItem("lobby.character") ?? localStorage.getItem("city.character"))) ||
    "vibey";
  void loadCharacterRig(findCharacter(charId), {
    height: SKATER_HEIGHT,
    fitBy: "height",
    center: true,
    castShadow: false,
    // Locomotion 1 means "pushing", which is a brisk stride rather than
    // the 4.2 m/s a walking world means by it.
    walkSpeed: 2.6,
  })
    .then((r) => {
      // The world may already have been torn down while the GLB was in
      // flight; mounting into a disposed scene leaks the whole rig.
      if (rigDropped) return r.dispose();
      rig = r;
      skater.mount(r.object, SKATER_HEIGHT);
    })
    .catch(() => {
      /* A missing model costs you a body, not the lake. */
    });

  // The only two lights in the world, and both of them are the sky: the
  // moon as a key, and the aurora as a coloured fill that brightens as it
  // fills in. Nothing else is lit at all.
  const moon = new THREE.DirectionalLight(0xbfd4ff, 0.9);
  moon.position.set(-0.42, 0.16, -0.9).multiplyScalar(100);
  scene.add(moon);
  const auroraFill = new THREE.HemisphereLight(0x2ef0a8, 0x050a12, 0.55);
  scene.add(auroraFill);
  // A rim from the arc, which stands to the north at +Z. Nothing else in
  // the world is lit — the ice, the sky, the pines and the snow are all
  // shaders or flat silhouettes — so these three lights exist solely to
  // make the character you picked legible against a bright sky. Without
  // the rim, a gold knight and a goblin are the same black cut-out.
  const auroraRim = new THREE.DirectionalLight(0x7dffd0, 0.85);
  auroraRim.position.set(0.15, 0.35, 1).multiplyScalar(100);
  scene.add(auroraRim);

  const postfx = buildPostFx(renderer, quality.tier);

  let audio: LakeAudio | null = createLakeAudio();
  audio?.setMuted(options.muted ?? false);

  // ---- Input -----------------------------------------------------------
  const keys = new Set<string>();
  const stick: LakeStick = { x: 0, y: 0, boost: false };
  let hopRequest = false;
  let camYaw = 0;          // where the camera is looking, world radians
  let yawOffset = 0;       // drag-to-look, decays back behind the skater
  let pitch = 0.20;
  let camDist = 9;
  let dragging = false;
  let lastPointer = { x: 0, y: 0 };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code === "Space") {
      hopRequest = true;
      e.preventDefault();
    }
    keys.add(e.code);
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  const onBlur = () => keys.clear();

  const onPointerDown = (e: PointerEvent) => {
    dragging = true;
    lastPointer = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement)?.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    yawOffset -= (e.clientX - lastPointer.x) * 0.005;
    pitch = THREE.MathUtils.clamp(pitch + (e.clientY - lastPointer.y) * 0.003, -0.15, 0.85);
    lastPointer = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = () => {
    dragging = false;
  };
  const onWheel = (e: WheelEvent) => {
    camDist = THREE.MathUtils.clamp(camDist + e.deltaY * 0.01, 4.5, 22);
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  const canvas = renderer.domElement;
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: true });

  const onResize = () => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    postfx.setSize(w, h, renderer.getPixelRatio());
  };
  window.addEventListener("resize", onResize);
  onResize();

  // ---- Loop ------------------------------------------------------------
  let energy = 0;
  let flash = 0;
  let complete = false;
  const lastTrail = new THREE.Vector2(0, 0);
  const trailFrom = new THREE.Vector2();
  const trailTo = new THREE.Vector2();
  const camTarget = new THREE.Vector3(0, 1.2, 0);
  const camGoal = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  let raf = 0;
  let last = performance.now();
  let elapsed = 0;
  let stateClock = 0;
  let disposed = false;

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    // Clamped: a backgrounded tab returns with a half-second delta, and an
    // unclamped one teleports the skater across the lake and stamps a line
    // through everything on the way.
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    elapsed += dt;

    // Keyboard folds into the same stick the touch pad writes.
    let ix = stick.x;
    let iy = stick.y;
    if (keys.has("KeyW") || keys.has("ArrowUp")) iy -= 1;
    if (keys.has("KeyS") || keys.has("ArrowDown")) iy += 1;
    if (keys.has("KeyA") || keys.has("ArrowLeft")) ix -= 1;
    if (keys.has("KeyD") || keys.has("ArrowRight")) ix += 1;
    const boost = stick.boost || keys.has("ShiftLeft") || keys.has("ShiftRight");
    const hop = hopRequest;
    hopRequest = false;

    skater.update(dt, { x: ix, y: iy, boost, hop }, camYaw, LAKE_RADIUS);
    if (rig) {
      rig.setLocomotion(skater.effort);
      rig.update(dt);
    }

    // ---- Carve trail -------------------------------------------------
    // Only while a blade is actually on the ice.
    trailFrom.copy(lastTrail);
    trailTo.set(skater.position.x, skater.position.z);
    const moved = trailFrom.distanceTo(trailTo);
    if (!skater.airborne && moved > 0.001) {
      // A blade's worth of ice, not a lane: the width is metres, and the
      // shader fogs a shoulder around it that is twice as wide again.
      const bite = Math.min(1, skater.speed / 14);
      trails.stamp(renderer, trailFrom, trailTo, 0.3 + bite * 0.28, 0.45 + bite * 0.55, dt);
      ice.setTrailTexture(trails.texture);
    } else {
      // Still age the buffer when standing still, or the lake remembers
      // your last lap forever.
      trails.stamp(renderer, trailTo, trailTo, 0.0001, 0, dt);
      ice.setTrailTexture(trails.texture);
    }
    lastTrail.copy(trailTo);

    // ---- Shards --------------------------------------------------------
    const got = shards.update(dt, elapsed, skater.position);
    if (got > 0) {
      for (let i = 0; i < got; i++) audio?.shard(shards.taken - got + i);
      flash = 1;
      if (shards.taken >= shards.total && !complete) {
        complete = true;
        audio?.finale();
      }
    }
    const targetEnergy = shards.taken / shards.total;
    // Ease rather than snap: the sky visibly *answers* the pickup, over
    // about a second, which is the whole feedback loop of the world.
    energy += (targetEnergy - energy) * (1 - Math.exp(-2.2 * dt));
    flash = Math.max(0, flash - dt * 1.8);

    sky.setEnergy(energy);
    ice.setEnergy(energy);
    postfx.setFlash(flash);
    // The character is lit by the sky, so it warms toward violet with it.
    auroraFill.intensity = 0.5 + energy * 0.55;
    (auroraFill.color as THREE.Color).setHSL(0.42 - energy * 0.18, 0.85, 0.55);
    auroraRim.intensity = 0.75 + energy * 0.6;
    (auroraRim.color as THREE.Color).setHSL(0.42 - energy * 0.2, 0.8, 0.62);

    // ---- Camera ---------------------------------------------------------
    // Sits behind the direction of travel, not behind the body: at speed
    // those differ during a carve, and following the travel keeps the ice
    // ahead of you in frame where you need it.
    const speed = skater.speed;
    const travel = speed > 1.5 ? Math.atan2(skater.velocity.x, skater.velocity.z) : skater.heading;
    yawOffset *= Math.exp(-(dragging ? 0.0 : 1.1) * dt);
    let delta = travel + yawOffset - camYaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    camYaw += delta * (1 - Math.exp(-3.4 * dt));

    const dist = camDist + Math.min(4, speed * 0.16);
    const height = 2.6 + pitch * 6 + Math.min(1.6, speed * 0.05);
    camGoal.set(
      skater.position.x - Math.sin(camYaw) * dist,
      skater.position.y + height,
      skater.position.z - Math.cos(camYaw) * dist,
    );
    camera.position.lerp(camGoal, 1 - Math.exp(-7 * dt));
    // Never let the camera dip under the ice — a mirror seen from behind
    // is a black screen.
    camera.position.y = Math.max(camera.position.y, 0.6);
    camTarget.lerp(
      lookAt.set(
        skater.position.x + Math.sin(camYaw) * 3,
        skater.position.y + 1.3,
        skater.position.z + Math.cos(camYaw) * 3,
      ),
      1 - Math.exp(-9 * dt),
    );
    camera.lookAt(camTarget);
    // Speed lives in the lens as well as the numbers.
    const wantFov = 62 + Math.min(14, speed * 0.55);
    if (Math.abs(camera.fov - wantFov) > 0.01) {
      camera.fov += (wantFov - camera.fov) * (1 - Math.exp(-3 * dt));
      camera.updateProjectionMatrix();
    }

    sky.update(elapsed, camera);
    ice.update(elapsed, camera);
    scenery.update(dt, elapsed, camera, energy);

    const carve = Math.min(
      1,
      Math.abs(skater.velocity.x * Math.cos(skater.heading) - skater.velocity.z * Math.sin(skater.heading)) / 8,
    );
    audio?.drive(speed, skater.airborne ? 0 : carve);

    postfx.render(renderer, scene, camera, elapsed);

    // The HUD does not need sixty updates a second, and React does not
    // want them.
    stateClock += dt;
    if (stateClock > 0.1) {
      stateClock = 0;
      onState({
        shards: shards.taken,
        total: shards.total,
        speed,
        energy,
        nearest: shards.nearest(skater.position),
        complete,
      });
    }
  };
  raf = requestAnimationFrame(tick);

  // Test aid. The look of this world can only be judged by opening it, so
  // the harness that opens it needs to be able to drive the one loop that
  // matters — take a shard, watch the sky answer — without skating a
  // hundred and ninety metres in a software rasteriser at four frames a
  // second. Everything here goes through the real pickup path.
  const debug = {
    /** Which catalog id the world actually put on the ice. */
    character: () => charId,
    state: (): LakeState => ({
      shards: shards.taken,
      total: shards.total,
      speed: skater.speed,
      energy,
      nearest: shards.nearest(skater.position),
      complete,
    }),
    /** Remaining shard positions, world space. */
    shards: (): Array<[number, number, number]> => {
      const out: Array<[number, number, number]> = [];
      shards.group.traverse((o) => {
        if (o.name === "shard-core" && o.visible) out.push([o.position.x, o.position.y, o.position.z]);
      });
      return out;
    },
    warp: (x: number, z: number) => {
      skater.position.set(x, 0, z);
      skater.velocity.set(0, 0, 0);
      lastTrail.set(x, z);
    },
  };
  (window as unknown as { __lakeDebug?: typeof debug }).__lakeDebug = debug;

  return {
    stick,
    hop() {
      hopRequest = true;
    },
    setMuted(muted) {
      audio?.setMuted(muted);
    },
    restart() {
      shards.reset();
      skater.reset();
      trails.clear(renderer);
      energy = 0;
      complete = false;
      lastTrail.set(0, 0);
    },
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
      skater.unmount();
      rig?.dispose();
      rig = null;
      delete (window as unknown as { __lakeDebug?: unknown }).__lakeDebug;
      sky.dispose();
      ice.dispose();
      trails.dispose();
      scenery.dispose();
      shards.dispose();
      skater.dispose();
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
