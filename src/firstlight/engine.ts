/**
 * First Light — the engine.
 *
 * Assembled from `src/lib/quality.ts` rather than from its own copy of the
 * settings, which makes it the first world in the repo whose resolution
 * responds to how fast it is actually running. See docs/performance.md for why
 * that took an audit to notice.
 *
 * ## Order of operations, and why it is this order
 *
 * 1. Renderer, with ACES and sRGB output. Tone mapping is not a post-effect
 *    here, it is the thing that lets the sun be brighter than 1.0 without
 *    clipping the sky to white — a dawn scene lives almost entirely in the top
 *    two stops and looks like a photocopy without it.
 * 2. Sky, then the PMREM built from it. Everything else is lit by that, so it
 *    has to exist before any material is judged.
 * 3. Terrain, then water, then flora — each reads the one before it.
 *
 * ## Teardown
 *
 * Disposes geometries, materials, textures and render targets, then calls
 * `releaseRenderer`, which is the part almost every other world in the repo
 * omits. Measured: six worlds visited, twelve GL contexts alive, one released.
 * Browsers evict the *oldest* context past the cap, so a world that leaks one
 * breaks whichever world the visitor opened first.
 */
import * as THREE from "three";
import {
  createAdaptive,
  detectTier,
  getProfile,
  releaseRenderer,
  type Adaptive,
  type QualityProfile,
  type QualityTier,
} from "@/lib/quality";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { createSky, type SkySystem } from "./sky";
import { createTerrain, WATER_LEVEL, type Terrain } from "./terrain";
import { createLake, type Lake } from "./water";
import { createFlora, type Flora } from "./flora";
import { tilingNormalMap, tilingCloudAlpha } from "./textures";

export interface EngineStats {
  fps: number;
  scale: number;
  tier: QualityTier;
  draws: number;
  triangles: number;
}

export interface FirstLightEngine {
  start(): void;
  stop(): void;
  dispose(): void;
  resize(): void;
  readonly stats: EngineStats;
  /** 0 = pre-dawn, 1 = full morning. Drives the whole scene's light. */
  setDawn(t: number): void;
  readonly dawn: number;
  setPaused(p: boolean): void;
  onStats(cb: (s: EngineStats) => void): () => void;
  readonly player: import("./player").Player;
  readonly camera: THREE.PerspectiveCamera;
}

export interface BootOptions {
  canvas: HTMLCanvasElement;
  tier?: QualityTier;
  /** Freeze the sun and skip the intro ease — used by the capture harness. */
  shot?: boolean;
  onProgress?: (stage: string, fraction: number) => void;
}

/** Sun elevation, in degrees, across the dawn. */
const DAWN_START = -3.4;
const DAWN_END = 14;

export async function boot(opts: BootOptions): Promise<FirstLightEngine> {
  const { canvas } = opts;
  const tier: QualityTier = opts.tier ?? detectTier();
  const profile: QualityProfile = getProfile(tier);
  const progress = opts.onProgress ?? (() => {});

  /* Let the browser paint the loading UI between steps. Without this the whole
     boot is one blocked task and the progress bar arrives already finished. */
  const breathe = () => new Promise<void>((r) => setTimeout(r, 0));

  progress("Clearing the sky", 0.05);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: profile.tier !== "low",
    powerPreference: "high-performance",
    stencil: false,
  });
  const basePixelRatio = Math.min(window.devicePixelRatio || 1, profile.maxPixelRatio);
  renderer.setPixelRatio(basePixelRatio);
  renderer.setSize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  /* Under 1.0 on purpose. The sky shader outputs well above white around the
     sun, and exposure is how much of that headroom reaches the frame. At 1.0
     the horizon blows out and takes the reflection with it. This has been both
     ways: 0.62 put the shore in mud, and 0.82 clipped the entire Preetham sky
     to white and took the sunrise colour with it. The sky shader's output
     around a low sun is enormous, so this number lives in a narrow band. */
  renderer.toneMappingExposure = 0.55;
  if (profile.shadowMapSize > 0) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    58,
    (canvas.clientWidth || 1) / (canvas.clientHeight || 1),
    0.1,
    profile.drawDistance,
  );

  await breathe();
  progress("Raising the sun", 0.2);

  const sky = createSky({
    shadowMapSize: profile.shadowMapSize,
    shadowDistance: profile.shadowDistance,
  });
  scene.add(sky.sky);
  scene.add(sky.sun);
  scene.add(sky.sun.target);
  scene.add(sky.ambient);

  /* Exponential fog, not linear. Linear fog has a start plane, and a start
     plane is visible as a ring on the ground when you look down at a shallow
     angle — which is most of the time in a world you walk through. */
  const fog = new THREE.FogExp2(0x000000, 0.0016);
  scene.fog = fog;

  await breathe();
  progress("Filling the basin", 0.38);

  const detailNormal = tilingNormalMap(
    512,
    [
      { period: 8, amp: 1 },
      { period: 16, amp: 0.5 },
      { period: 32, amp: 0.25 },
    ],
    777,
    1.5,
  );
  detailNormal.anisotropy = profile.anisotropy;

  const terrain: Terrain = createTerrain({
    segments: profile.tier === "low" ? 128 : profile.tier === "medium" ? 192 : 256,
    detailNormal,
  });
  scene.add(terrain.mesh);

  await breathe();
  progress("Letting the water settle", 0.56);

  const lake: Lake = createLake({ reflectionSize: profile.reflectionSize, fog: true });
  scene.add(lake.mesh);

  await breathe();
  progress("Planting the shore", 0.72);

  const flora: Flora = createFlora({
    terrain,
    density: profile.foliageDensity,
    castShadows: profile.shadowMapSize > 0,
  });
  scene.add(flora.group);

  await breathe();
  progress("Drawing the mist", 0.88);

  /* ---- mist ------------------------------------------------------------- *
   * Slowly-drifting horizontal sheets above the water. The shape is the trap:
   * a horizontal plane seen from a camera standing *level with it* is seen
   * edge-on, so it covers the entire lake with its full opacity no matter how
   * thin it is meant to be. Four such layers at eye height turned the water
   * into a sheet of milk in the fourth capture of this world, and no amount of
   * tuning the water itself could have fixed it.
   *
   * So: two layers, well above head height, and faint. The depth cue that
   * actually matters comes from the fog, which is distance-correct by
   * construction; these only break it up so the far shore arrives in bands.   */
  const mistTex = tilingCloudAlpha(512, 12);
  const mistMat = new THREE.MeshBasicMaterial({
    map: mistTex,
    transparent: true,
    opacity: 0.1,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const mistGeo = new THREE.PlaneGeometry(1500, 1500);
  const mist = new THREE.Group();
  const mistLayers: THREE.Mesh[] = [];
  const layerCount = profile.volumetrics === 0 ? 1 : 2;
  for (let i = 0; i < layerCount; i++) {
    const m = new THREE.Mesh(mistGeo, mistMat.clone());
    m.rotation.x = -Math.PI / 2;
    /* Above the player's head (1.68 m) by a clear margin, so walking never
       puts the camera inside a layer. */
    m.position.y = WATER_LEVEL + 6.5 + i * 5;
    m.renderOrder = 10 + i;
    mistLayers.push(m);
    mist.add(m);
  }
  scene.add(mist);

  /* ---- post ------------------------------------------------------------- *
   * One effect, and only for the sun.
   *
   * `threshold` is high — 1.9, against the 0 the bloom examples use — because
   * the pass sees *linear HDR*, before tone mapping, and a Preetham sky within
   * twenty degrees of a low sun is already many times brighter than white
   * there. At 0.85 the threshold caught most of the sky and the bloom ate the
   * far ridge; at 1.9 it catches the disc and the specular path on the water,
   * which is all it was ever wanted for.
   *
   * The composer's target is half-float. Bloom on an 8-bit target has nothing
   * above 1.0 to find, so it would bloom clipped white uniformly and lose the
   * colour of the sun, which is the only reason to do this at all.            */
  let composer: EffectComposer | null = null;
  let bloomPass: UnrealBloomPass | null = null;
  if (profile.bloom) {
    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: profile.tier === "low" ? 0 : 2,
    });
    composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(scene, camera));
    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      profile.tier === "ultra" ? 0.34 : 0.28,
      0.55,
      1.9,
    );
    composer.addPass(bloomPass);
    /* OutputPass is what applies tone mapping and the sRGB conversion when a
       composer is in play. Without it the frame is written linear and the whole
       scene comes out washed and pale — and it must be last. */
    composer.addPass(new OutputPass());
  }

  const { createPlayer } = await import("./player");
  const player = createPlayer({ terrain });
  player.object.add(camera);
  scene.add(player.object);

  await breathe();
  progress("Ready", 1);

  /* ---- loop ------------------------------------------------------------- */
  const clock = new THREE.Clock();
  let raf = 0;
  let running = false;
  let paused = false;
  /* Captures are posed at the best minute of the arc rather than the middle of
     it. Note the easing: `dawn` is smoothstepped before it reaches the sun, so
     0.2 is not a fifth of the way up — it is elevation −1.6°, still below the
     horizon, which is how the second and third captures came out with no sun
     and no specular path on the water at all. 0.42 puts the disc about 3° up:
     clear of the ridge, still gold. */
  let dawn = opts.shot ? 0.42 : 0;
  const statsListeners = new Set<(s: EngineStats) => void>();
  const stats: EngineStats = { fps: 0, scale: 1, tier, draws: 0, triangles: 0 };
  let statTimer = 0;

  const applyScale = (scale: number) => {
    renderer.setPixelRatio(basePixelRatio * scale);
    resize();
    /* Below three-quarter scale the reflection is costing more than it returns
       — the frame is already soft, and the distortion is the first thing that
       stops being legible. */
    lake.setReflections(scale > 0.74);
  };

  const adaptive: Adaptive = createAdaptive({
    targetFps: 58,
    min: 0.55,
    onChange: applyScale,
  });

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    composer?.setSize(w, h);
    composer?.setPixelRatio(renderer.getPixelRatio());
    bloomPass?.setSize(w, h);
  }
  resize();

  const applyDawn = () => {
    const eased = dawn * dawn * (3 - 2 * dawn);
    /* Azimuth 126° puts the sun across the lake from the spawn rather than
       behind the player's shoulder, which is where it was for the first four
       captures — a sunrise world in which you could not see the sunrise. The
       spawn bearing and this number are a pair; move one and check the other. */
    sky.setElevation(DAWN_START + (DAWN_END - DAWN_START) * eased, 126 - eased * 14);
    /* Fog takes the sky's own horizon colour, so the far hills always dissolve
       into exactly what is painted behind them. This is the whole of aerial
       perspective and it is one line. */
    fog.color.copy(sky.horizon);

    /* Exposure stops down as the sun climbs, the way an eye or a camera does.
       A fixed exposure cannot serve a seventeen-degree swing in sun elevation:
       set it for the pre-dawn and the full sunrise blows the sky to white
       (which is exactly what the dawn=1 capture showed), set it for the
       sunrise and the pre-dawn is an unreadable black. This is the one piece of
       "cheating" in the lighting and it is the piece that is most true to how
       the scene would actually be photographed. */
    renderer.toneMappingExposure = 0.95 - eased * 0.52;
    /* Thick before the sun is up, burning off as it rises — which is what mist
       does, and doing it on a timer instead would be the version that feels
       arbitrary.
       
       These numbers are small and the range they work in is narrow. FogExp2
       falls off with the *square* of distance × density, so 0.0042 — which
       sounds like nothing — leaves the far hills 89% fogged and flattens the
       entire frame to one pink tone. That was the second capture. At 0.0022 the
       same hills sit at about half, which is the depth cue without the wash. */
    fog.density = 0.0022 - eased * 0.0013;
    for (let i = 0; i < mistLayers.length; i++) {
      const m = mistLayers[i].material as THREE.MeshBasicMaterial;
      m.opacity = (0.11 - i * 0.03) * (1 - eased * 0.5);
      /* Tinted toward the horizon rather than to white. White mist over a warm
         sunrise is the single fastest way to grey the whole frame out. */
      m.color.copy(sky.horizon).lerp(new THREE.Color(0xffffff), 0.2);
    }
  };
  applyDawn();
  sky.update(renderer, scene);

  const tick = () => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.1);
    if (paused) return;
    const elapsed = clock.elapsedTime;

    /* The dawn takes four minutes and then holds. It is not a loop: the sun
       going back down would make the world a screensaver, and the one thing a
       place should not do is reset while you are standing in it. */
    if (!opts.shot && dawn < 1) {
      dawn = Math.min(1, dawn + dt / 240);
      applyDawn();
    }

    player.update(dt);
    flora.update(elapsed);
    lake.update(dt, sky.sunDirection, sky.sun.color);

    /* Keep the sun's shadow box on the player, or a 140 m box centred on the
       origin means no shadows anywhere near you the moment you walk. */
    sky.sun.position.copy(player.object.position).addScaledVector(sky.sunDirection, profile.shadowDistance * 2.2);
    sky.sun.target.position.copy(player.object.position);
    sky.sun.target.updateMatrixWorld();

    mist.position.set(player.object.position.x, 0, player.object.position.z);
    for (let i = 0; i < mistLayers.length; i++) {
      mistLayers[i].rotation.z = elapsed * (0.004 + i * 0.0016) * (i % 2 ? -1 : 1);
    }

    sky.update(renderer, scene);
    renderer.info.reset();
    if (composer) composer.render(dt);
    else renderer.render(scene, camera);

    adaptive.sample(dt);

    statTimer += dt;
    if (statTimer > 0.4) {
      statTimer = 0;
      stats.fps = Math.round(adaptive.fps);
      stats.scale = adaptive.scale;
      stats.draws = renderer.info.render.calls;
      stats.triangles = renderer.info.render.triangles;
      for (const cb of statsListeners) cb(stats);
    }
  };

  return {
    camera,
    player,
    stats,
    get dawn() {
      return dawn;
    },
    setDawn(t: number) {
      dawn = Math.min(1, Math.max(0, t));
      applyDawn();
      sky.update(renderer, scene);
    },
    setPaused(p: boolean) {
      paused = p;
    },
    onStats(cb) {
      statsListeners.add(cb);
      return () => statsListeners.delete(cb);
    },
    resize,
    start() {
      if (running) return;
      running = true;
      clock.start();
      raf = requestAnimationFrame(tick);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
    },
    dispose() {
      running = false;
      cancelAnimationFrame(raf);
      statsListeners.clear();
      flora.dispose();
      lake.dispose();
      terrain.dispose();
      sky.dispose();
      player.dispose();
      mistGeo.dispose();
      mistTex.dispose();
      mistMat.dispose();
      for (const m of mistLayers) (m.material as THREE.Material).dispose();
      detailNormal.dispose();
      bloomPass?.dispose();
      composer?.dispose();
      scene.clear();
      releaseRenderer(renderer);
    },
  };
}
