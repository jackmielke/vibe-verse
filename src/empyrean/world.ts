/**
 * THE EMPYREAN — the engine.
 *
 * Owns the renderer, the loop, the input, the systems list and the teardown.
 * Everything with an opinion about how the world looks lives in its own file
 * next door; this one wires them together, keeps one `FrameContext` up to
 * date, and makes sure that when the page unmounts the WebGL context goes with
 * it. Browsers cap live contexts at around sixteen, and a world that leaks one
 * breaks the *next* world the visitor opens.
 *
 * ## The shape
 *
 * ```
 * scene
 * ├── sky            one inverted sphere, pinned to the camera
 * ├── terrain        snow, ranges, the lake
 * │    └── mirror    scale.y = -1  ──▶  clone(true) of REFLECTED
 * ├── REFLECTED      keel + buildings — the island's silhouette
 * ├── DETAIL         streets, props, crowd, traffic, interiors, activities
 * └── body + plume
 * ```
 *
 * A system declares `reflected` and lands in one group or the other. The lake
 * reflection is a real mirrored clone rather than a second render pass, so
 * everything in REFLECTED costs a second draw — worth it for the rock and the
 * towers, which *are* the reflection, and not for eight hundred pedestrians
 * who are four pixels each at a kilometre and a half.
 *
 * ## Two things this file must never be tempted into
 *
 * **Allocating in the loop.** Every vector here is preallocated and the frame
 * context is one object mutated in place. A dozen systems each handed a fresh
 * object sixty times a second is a garbage-collector pause you can see.
 *
 * **Knowing what a system does.** It knows a system has a group, an update and
 * a dispose. Everything else — what a courier run is, how a tram moves — is
 * behind an interface in `types.ts`. The moment this file starts special-casing
 * one system, all twelve become one module with twelve files in it.
 */
import * as THREE from "three";
import { findCharacter } from "@/lib/characters";
import { loadCharacterRig, type CharacterRig } from "@/lib/characterRig";
import { RUN_SPEED } from "@/lib/worldPhysics";

import type {
  EmpyreanState,
  FrameContext,
  Interactable,
  QualityTier,
  System,
  Toast,
} from "./types";
import { DECKS, ISLAND_Y, KILL_Y, PLATEAU_R, SPAWN } from "./config";
import { cityPlan, districtAt, surfaceAt } from "./cityplan";
import { buildSky, DEFAULT_DAY_PHASE, skyPalette, sunDirFor } from "./sky";
import { buildTerrain } from "./terrain";
import { buildKeel } from "./keel";
import { buildStreets } from "./streets";
import { buildBuildings } from "./buildings";
import { buildProps } from "./props";
import { buildCrowd } from "./crowd";
import { buildTraffic } from "./traffic";
import { buildInteriors } from "./interiors";
import { buildActivities } from "./activities";
import { buildWeather, type Condition } from "./weather";
import { buildVehicles } from "./vehicles";
import { buildLighting, setShadowFlags } from "./lighting";
import { buildPostFx } from "./postfx";
import { buildAudio, type AudioHandle } from "./audio";
import { buildPlume } from "./plume";
import { buildMinimap, type MapMark } from "./minimap";
import { buildCollision, type Blocker, type Deck } from "./collide";
import { CameraRig } from "./camera";
import { makeFlyer, stepFlyer, jump, type FlyerState } from "./flight";

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
  /** Put the flyer back on the Halo. */
  recall(): void;
  /** The interact key, from the HUD's touch button. */
  interact(): void;
  /**
   * Pin the hour, or hand it back to the clock.
   *
   * `null` means live — the world's own slow cycle, which dwells near the
   * sunset it was painted at. A number pins it there and the world *sweeps*
   * to it rather than cutting: see `DAY_SWEEP_RATE`.
   */
  setDayPhase(p: number | null): void;
  /** Pin the weather, or `null` to hand it back to the cycle. */
  setWeather(c: Condition | null): void;
  dispose(): void;
}

export interface EmpyreanOptions {
  container: HTMLElement;
  minimap?: HTMLCanvasElement | null;
  onState: (s: EmpyreanState) => void;
  muted?: boolean;
  /**
   * Capture mode. The camera flies a slow arc on the composition the whole
   * world was built around — island centred, lake under it, ranges at the
   * edges — and the player is not in the frame. `?shot` sets it.
   */
  shot?: boolean;
}

function pickQuality(): QualityTier {
  const coarse = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  const small = typeof window !== "undefined" && window.innerWidth < 900;
  return coarse || small ? "low" : "high";
}

/**
 * How fast the clock runs — and why it does not run at a constant rate.
 *
 * The whole world is painted at one hour. The reference is a sunset; the sky
 * palette, the glass, the water's analytic reflection and the rock's bounce
 * light were all tuned at `dayPhase` 0.75, and it is the reason anybody would
 * open the route. A linear clock at any speed spends 96% of its time not being
 * that, and a visitor who stays five minutes mostly sees dusk turning into
 * night.
 *
 * But a world with no clock at all is worse: night here is a city of lit glass
 * over a black lake under an aurora, and it would be a waste never to reach
 * it. So the clock *dwells*. `RATE` is how many phase-units pass per second at
 * the fastest, and `dwell()` slows it to a crawl through the golden hour and
 * lets it run through the middle of the night. A full circuit takes about
 * forty minutes, of which roughly half is spent within sight of the hour the
 * place was designed at.
 */
const DAY_SECONDS = 2400;

/**
 * How fast the sky travels when somebody picks an hour, in phase per second.
 *
 * Not a cut, and not an ease. A cut is cheap and throws away the best thing
 * about having a day cycle at all: watching the light move across four hundred
 * metres of glass. An ease-to-target crawls at the end, which on a *sky* reads
 * as the renderer struggling. A constant rate means a nudge is instant and a
 * jump from noon to midnight is a three-second time-lapse — the shadows swing,
 * the lamps come on in it, and it is the single most satisfying thing in the
 * whole control.
 */
const DAY_SWEEP_RATE = 0.17;

/**
 * How fast time passes at a given hour, 0..1 of full rate.
 *
 * A cosine bump centred on sunset, floored so the clock never actually stops —
 * a frozen sky is a bug report, and somebody watching for it would see the
 * light stop changing rather than a beautiful hour holding.
 */
function dwell(phase: number): number {
  const SUNSET = 0.75;
  let d = Math.abs(((phase - SUNSET) % 1) + 1) % 1;
  if (d > 0.5) d = 1 - d;
  // Full rate more than a fifth of a day away; a fifth of it at the hour.
  const near = 1 - Math.min(1, d / 0.2);
  return 1 - 0.8 * near * near;
}

/** Where you are, said out loud. Cheap, and it does a lot for the HUD. */
function placeOf(p: THREE.Vector3): { name: string; accent: string } {
  const r = Math.hypot(p.x, p.z);
  if (r > DECKS[DECKS.length - 1].outer + 40) {
    if (p.y < 40) return { name: "The Mirror", accent: "#bcd8ff" };
    if (p.y < ISLAND_Y - 120) return { name: "Under the keel", accent: "#c9a2ff" };
    return { name: "The high air", accent: "#8fd6ff" };
  }
  if (p.y > ISLAND_Y + 200) return { name: "Above the spires", accent: "#bfe9ff" };
  if (p.y < ISLAND_Y - 90) return { name: "Under the keel", accent: "#c9a2ff" };

  // Standing at a landmark beats standing in a district.
  for (const l of cityPlan().landmarks) {
    if (Math.hypot(l.x - p.x, l.z - p.z) < l.clear + 8) {
      return { name: l.name, accent: "#ffd28a" };
    }
  }
  const d = districtAt(r);
  return { name: d.name, accent: d.accent };
}

function clockString(dayPhase: number): string {
  const mins = Math.floor(((dayPhase % 1) + 1) % 1 * 24 * 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function createEmpyrean(options: EmpyreanOptions): EmpyreanWorld {
  const { container, onState } = options;
  const quality = pickQuality();
  const shotMode = !!options.shot;
  const low = quality === "low";

  /* ---- renderer -------------------------------------------------------- */
  const renderer = new THREE.WebGLRenderer({
    antialias: false, // the post chain resolves; MSAA on an HDR target is dear
    powerPreference: "high-performance",
    alpha: false,
    stencil: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, low ? 1.6 : 2));
  renderer.setSize(
    container.clientWidth || window.innerWidth,
    container.clientHeight || window.innerHeight,
  );
  // Every buffer before the grade pass is scene-linear radiance. postfx.ts is
  // the only thing in this world that tone maps, and it does it exactly once.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x150c22, 1);
  /* Count the whole frame, not the last pass of it.
   *
   * `renderer.info.render` resets on every `render()` call, and the post chain
   * ends with a single full-screen quad — so anything reading the counters
   * afterwards is told the world costs one draw call and no triangles, which
   * is a very reassuring number and completely false. */
  renderer.info.autoReset = false;
  renderer.shadowMap.enabled = !low;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  const canvas = renderer.domElement;
  canvas.style.display = "block";
  canvas.style.touchAction = "none";
  canvas.style.cursor = "grab";

  const scene = new THREE.Scene();
  const fog = new THREE.FogExp2(0xf3bfb2, 0.00010);
  scene.fog = fog;

  const camera = new THREE.PerspectiveCamera(
    58,
    (container.clientWidth || 1) / (container.clientHeight || 1),
    0.3,
    26000,
  );

  /* ---- the two graphs -------------------------------------------------- */
  const reflected = new THREE.Group();
  reflected.name = "empyrean-silhouette";
  const detail = new THREE.Group();
  detail.name = "empyrean-detail";
  scene.add(reflected, detail);

  /* ---- systems --------------------------------------------------------- */
  const build = { quality, seedSalt: "v2" };
  const systems: System[] = [];
  const add = <T extends System>(s: T): T => {
    systems.push(s);
    (s.reflected ? reflected : detail).add(s.group);
    return s;
  };

  const sky = buildSky();
  scene.add(sky.mesh);

  const terrain = buildTerrain();
  scene.add(terrain.group);

  const lighting = buildLighting(build, renderer);
  scene.add(lighting.group);

  const keel = add(buildKeel(build));
  /* Interiors are built first, and only so that the buildings can be told to
   * leave their lots alone.
   *
   * The café and the gallery are real rooms standing inside two ordinary shop
   * lots. `buildings.ts` has no idea, so left to itself it puts a solid block
   * on top of each of them — walls with no door, a room sealed inside somebody
   * else's box. Neither system may import the other, so the engine carries the
   * one fact between them. */
  const interiors = add(buildInteriors(build));
  const buildings = add(buildBuildings(build, { skipLots: interiors.claimedLots }));
  const streets = add(buildStreets(build));
  const props = add(buildProps(build));
  const crowd = add(buildCrowd(build));
  const traffic = add(buildTraffic(build));
  const activities = add(buildActivities(build));
  const weather = add(buildWeather(build));
  const vehicles = add(buildVehicles(build));
  // A world that opens in whatever weather the clock happened to land on is a
  // world whose card art is a different picture every time it is captured.
  if (shotMode) {
    /* Pinned, not merely started, at the signature hour. A capture takes
     * thirty seconds or more under a software rasteriser, and a clock that
     * runs during it makes the card art a different picture every time it is
     * taken — which is indistinguishable from the world having changed. */
    weather.force("high-cloud");
  }

  /* Who casts.
   *
   * Marked before the mirror is cloned, so the clone inherits the flags and
   * can then have them stripped — the mirror is scaled -1 on Y, its winding is
   * reversed, and a shadow cast by an upside-down island lands in the sky.
   * Nothing cast at all until this was added, which is the sort of thing that
   * looks like "the lighting is a bit flat" rather than like a bug. */
  setShadowFlags(reflected, true);
  setShadowFlags(detail, true);
  setShadowFlags(terrain.group, true);

  /* The reflection: a real clone of the silhouette, mirrored through the
   * water plane. Shares every geometry and material, so it costs draws and
   * nothing else — and it can never drift out of step with the original. */
  const mirrorClone = reflected.clone(true);
  terrain.mirror.add(mirrorClone);
  const snow = terrain.group.getObjectByName("empyrean-snow") as THREE.Mesh | null;
  if (snow) terrain.mirror.add(snow.clone());
  setShadowFlags(terrain.mirror, false);

  /* ---- collision ------------------------------------------------------- */
  const blockers: Blocker[] = [
    ...buildings.blockers,
    ...interiors.blockers,
    ...(props.blockers ?? []),
  ];
  const decks: Deck[] = [...buildings.decks, ...interiors.decks];
  const collision = buildCollision(blockers, decks);

  // Interiors raise toasts of their own — a departure board, a guest book.
  interiors.onToast = (text, tone) => pushToast(text, tone ?? "info");
  // Vehicles collide against the same world the body does.
  vehicles.setWorld({
    blockedAt: (x, z, y) => collision.blockedAt(x, z, y),
    supportAt: collision.supportAt,
  });

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
    castShadow: true,
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

  /* What the player has pinned, if anything. `null` on both means the world
     runs itself, which is what it does until somebody touches the control. */
  let pinnedPhase: number | null = null;
  let pinnedWeather: Condition | null = null;

  const flyer: FlyerState = makeFlyer(SPAWN);
  const rigCam = new CameraRig(SPAWN.yaw);

  /* ---- notifications ---- */
  const toasts: Toast[] = [];
  let toastId = 1;
  const pushToast = (text: string, tone: Toast["tone"] = "info") => {
    toasts.push({ id: toastId++, text, ttl: 4, tone });
    while (toasts.length > 4) toasts.shift();
  };

  /* ---- input ----------------------------------------------------------- */
  const keys = new Set<string>();
  const stick: EmpyreanStick = { x: 0, y: 0, jet: false, boost: false };
  let wantInteract = false;
  let prevJet = false;
  /**
   * Debug only: hold the body exactly where it was put.
   *
   * Without it there is no way to photograph the world from the air. `warp`
   * sets a position and gravity spends the next six seconds undoing it, so
   * every "three hundred metres up" viewpoint in the capture harness was
   * actually a picture of the pavement the player landed on.
   */
  let frozen = false;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) {
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
        e.preventDefault();
      }
      return;
    }
    keys.add(e.code);
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
      e.preventDefault();
    }
    if (e.code === "KeyR") recall();
    if (e.code === "KeyE") wantInteract = true;
    audio?.resume();
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  const onBlur = () => keys.clear();
  window.addEventListener("keydown", onKeyDown, { passive: false });
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  /* Drag to look. Deliberately not pointer lock: the HUD has buttons you want
   * to be able to click, this opens on a phone as often as not, and the
   * capture harness cannot spend a gesture on acquiring a lock.
   *
   * ## Why this is bound the paranoid way
   *
   * The first version put `pointerdown`, `pointermove` and `pointerup` all on
   * the canvas and leaned on `setPointerCapture` to keep the moves coming.
   * That is the textbook shape and it has three ways to fail silently, all of
   * which look identical from the sofa — the world simply does not turn:
   *
   *  - the capture is lost (a re-render, a devtools overlay, an extension
   *    that reparents the canvas) and the moves go to whatever is on top;
   *  - the browser starts a native drag or a selection on the press, and the
   *    pointer stream stops after the first move;
   *  - `pointermove` never arrives at all, because something upstream called
   *    `preventDefault()` on the `pointerdown`.
   *
   * So: press on the canvas, but track the *movement* on `window`, where
   * nothing can get above it, and take mouse events as well as pointer ones
   * for the case where only the legacy stream survives. `seenPointer` stops
   * the two paths both turning the camera on a browser that sends both.
   *
   * `cursor: grab` is set here, on the way in, not on the first pointer-up.
   * It used to be the latter, so the one moment the affordance mattered — the
   * first second, before you know dragging does anything — was the one moment
   * it was missing.
   */
  canvas.style.cursor = "grab";
  canvas.style.touchAction = "none";
  let dragging = false;
  let seenPointer = false;
  let lastX = 0;
  let lastY = 0;
  let lastMoveAt = 0;
  let velX = 0;
  let velY = 0;
  let dragDist = 0;
  let downAt = 0;

  const beginDrag = (x: number, y: number, t: number) => {
    dragging = true;
    lastX = x;
    lastY = y;
    lastMoveAt = t;
    downAt = t;
    velX = 0;
    velY = 0;
    dragDist = 0;
    canvas.style.cursor = "grabbing";
    audio?.resume();
  };
  const moveDrag = (x: number, y: number, t: number) => {
    if (!dragging) return;
    const dx = x - lastX;
    const dy = y - lastY;
    rigCam.look(dx, dy);
    /* Pixels per second, smoothed over about three frames. One frame's delta
       is far too noisy to throw a camera with: a single hiccup at the moment
       you let go and the view spins off across the island. */
    const dtMs = Math.max(1, t - lastMoveAt);
    const k = Math.min(1, dtMs / 48);
    velX += ((dx * 1000) / dtMs - velX) * k;
    velY += ((dy * 1000) / dtMs - velY) * k;
    dragDist += Math.abs(dx) + Math.abs(dy);
    lastX = x;
    lastY = y;
    lastMoveAt = t;
  };
  const endDrag = (t: number) => {
    if (!dragging) return;
    dragging = false;
    canvas.style.cursor = "grab";
    /* Only a *flick* coasts. Letting go after resting on a spot has to leave
       the camera exactly where you put it — a view that drifts once you have
       finished aiming is worse than one that never coasts at all. */
    if (t - lastMoveAt < 90 && dragDist > 12) rigCam.fling(velX, velY);
    /* A press that never moved is a click, and a click on the world means
       "put the camera back behind me". It needs no key, and it is what
       everybody reaches for after turning round twice and getting lost. */
    if (dragDist < 5 && t - downAt < 350) rigCam.recentre(flyer.yaw);
  };

  const onPointerDown = (e: PointerEvent) => {
    seenPointer = true;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    beginDrag(e.clientX, e.clientY, e.timeStamp);
  };
  const onPointerMove = (e: PointerEvent) => moveDrag(e.clientX, e.clientY, e.timeStamp);
  const onPointerUp = (e: PointerEvent) => endDrag(e.timeStamp);
  const onMouseDown = (e: MouseEvent) => {
    if (seenPointer || e.button !== 0) return;
    beginDrag(e.clientX, e.clientY, e.timeStamp);
  };
  const onMouseMove = (e: MouseEvent) => {
    if (seenPointer) return;
    moveDrag(e.clientX, e.clientY, e.timeStamp);
  };
  const onMouseUp = (e: MouseEvent) => {
    if (seenPointer) return;
    endDrag(e.timeStamp);
  };
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("mousedown", onMouseDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);

  const onWheel = (e: WheelEvent) => {
    rigCam.zoom(e.deltaY);
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

  /* ---- audio and image ------------------------------------------------- */
  let audio: AudioHandle | null = shotMode ? null : buildAudio(build);
  audio?.setMuted(options.muted ?? false);
  const postfx = buildPostFx(renderer, quality);
  const minimap = options.minimap ? buildMinimap(options.minimap, low ? 132 : 168) : null;

  function recall() {
    activities.abort();
    flyer.position.set(SPAWN.x, SPAWN.y, SPAWN.z);
    flyer.velocity.set(0, 0, 0);
    flyer.yaw = SPAWN.yaw;
    rigCam.reset(SPAWN.yaw);
  }

  /* ---- the frame context ----------------------------------------------- */
  const ctx: FrameContext = {
    time: 0,
    dt: 0,
    camera,
    player: {
      position: flyer.position,
      velocity: flyer.velocity,
      yaw: flyer.yaw,
      grounded: flyer.grounded,
      burn: flyer.burn,
      altitude: 0,
    },
    quality,
    dayPhase: DEFAULT_DAY_PHASE,
    sunDir: sunDirFor(DEFAULT_DAY_PHASE),
    daylight: 0.32,
    gradeDaylight: 1,
    camRadiusSq: 0,
  };

  /* ---- loop ------------------------------------------------------------ */
  const clock = new THREE.Clock();
  let raf = 0;
  let disposed = false;
  let hudTimer = 0;
  let mapTimer = 0;
  let nearest: Interactable | null = null;
  /** Held, not rebuilt: see the scan in the loop. */
  const offerGroups: readonly Interactable[][] = [
    activities.interactables(),
    interiors.interactables(),
    vehicles.interactables(),
  ];
  const marks: MapMark[] = [];
  const packPos = new THREE.Vector3();



  const tick = () => {
    if (disposed) return;
    raf = requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05);
    const time = clock.elapsedTime;
    renderer.info.reset();

    /* ---- clock ---- */
    ctx.time = time;
    ctx.dt = dt;
    if (!shotMode) {
      if (pinnedPhase === null) {
        ctx.dayPhase = (ctx.dayPhase + (dt / DAY_SECONDS) * dwell(ctx.dayPhase)) % 1;
      } else {
        /* The shorter way round the clock. Without this, picking dawn while
           standing in the small hours takes the sky the long way through the
           entire day — twenty-three hours of time-lapse to travel one. */
        let d = (((pinnedPhase - ctx.dayPhase) % 1) + 1) % 1;
        if (d > 0.5) d -= 1;
        const step = DAY_SWEEP_RATE * dt;
        ctx.dayPhase =
          Math.abs(d) <= step ? pinnedPhase : (ctx.dayPhase + Math.sign(d) * step + 1) % 1;
      }
    }
    const pal = skyPalette(ctx.dayPhase);
    ctx.daylight = pal.daylight;
    ctx.gradeDaylight = lighting.look.gradeDaylight;
    sunDirFor(ctx.dayPhase, ctx.sunDir);
    sky.setDayPhase(ctx.dayPhase);
    lighting.setDayPhase(ctx.dayPhase);
    /* Fog and grade both come from the lighting rig rather than from the sky
     * palette directly. Two daylights exist and confusing them is a trap the
     * rig's own docs flag: `pal.daylight` is 0.32 at sunset, which is right
     * for deciding when a lamp comes on and ruinous as an exposure control.
     * `gradeDaylight` is the one the image wants. */
    fog.color.copy(lighting.look.fogColor);
    postfx.setSunDirection(lighting.sunDir);
    postfx.setDaylight(lighting.look.gradeDaylight);
    postfx.setExposure(lighting.exposure);

    if (shotMode) {
      /* The card composition, exactly: island centred and a little above the
       * lens, the lake filling the lower third, the sun behind the towers. A
       * very slow orbit, so a recorder gets motion without the frame changing
       * enough to stop being the picture. */
      /* Framed on the island's whole vertical extent, which is the constraint.
       *
       * The city spans from the keel's tip at y=60 to the Beacon's crown at
       * 1120 — 1060 m of subject — so the camera distance is set by fitting
       * that into 58 degrees, not by how wide the island looks. At 1250 m the
       * tip sits at -13 degrees and the crown at +32, inside the frame with
       * room, and the bottom of the shot lands on the ice directly under the
       * island rather than on empty sky. Closer and the point of the rock is
       * cut off, which is the one part of the silhouette the whole world is
       * named for. */
      const a = Math.PI * 0.5 + time * 0.014;
      camera.position.set(Math.sin(a) * 1250, 340, Math.cos(a) * 1250);
      camera.lookAt(0, ISLAND_Y + 20, 0);
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

      const jet = keys.has("Space") || stick.jet;
      // A tap of Space on the ground is a jump; a hold is the jetpack. City
      // gives the jetpack the whole key, but City has no stairs.
      if (jet && !prevJet && flyer.grounded && !vehicles.riding()) jump(flyer);
      prevJet = jet;

      const ride = vehicles.riding();
      if (frozen) {
        flyer.velocity.set(0, 0, 0);
        flyer.grounded = false;
        flyer.burn = 0;
      } else if (ride) {
        /* Aboard something. The vehicle owns the body: it is driven with the
         * same stick the legs use, and it says where the player ends up. The
         * jetpack is off — the plume firing out of the back of a glider is
         * the kind of detail that reads as a bug even to somebody who could
         * not say why. */
        vehicles.drive(
          {
            forward: f,
            strafe: s,
            lift: jet ? 1 : 0,
            boost: keys.has("ShiftLeft") || keys.has("ShiftRight") || stick.boost,
            camYaw: rigCam.yaw,
          },
          dt,
        );
        const r = vehicles.riding();
        if (r) {
          flyer.position.set(r.x, r.y, r.z);
          flyer.yaw = r.yaw;
          flyer.pitch = r.pitch;
          flyer.grounded = false;
          flyer.burn = 0;
          flyer.velocity.set(0, 0, 0);
        }
      } else stepFlyer(
        flyer,
        {
          forward: f,
          strafe: s,
          run: keys.has("ShiftLeft") || keys.has("ShiftRight") || stick.boost,
          jet,
          camYaw: rigCam.yaw,
        },
        {
          supportAt: collision.supportAt,
          blockedAt: (x, z, y) => collision.blockedAt(x, z, y),
          killY: KILL_Y,
          spawn: SPAWN,
        },
        dt,
      );

      // Landing only. Footsteps, scuffs and the jet's ignition and tail are
      // all detected inside the audio module from the player's own motion, so
      // firing a step event here would double every footfall.
      if (flyer.landed > 6) audio?.event("land", Math.min(1, flyer.landed / 22));

      body.position.copy(flyer.position);
      body.rotation.set(0, flyer.yaw, 0);
      body.rotateX(flyer.pitch);

      rigCam.update(camera, flyer, collision, dt);
    }

    /* ---- publish the player ---- */
    ctx.player.yaw = flyer.yaw;
    ctx.player.grounded = flyer.grounded;
    ctx.player.burn = flyer.burn;
    ctx.player.altitude = flyer.drop;
    ctx.camRadiusSq = camera.position.x * camera.position.x + camera.position.z * camera.position.z;

    /* ---- the world moves ---- */
    sky.update(time, camera);
    terrain.update(time, camera);
    lighting.shadowsFor(camera, flyer.position);
    for (let i = 0; i < systems.length; i++) systems[i].update?.(ctx);

    /* Fog density is set after the systems, not before, because the weather's
     * contribution depends on where the camera is *this* frame — mist fills
     * the lake basin and has to be gone by the time you climb back onto the
     * deck, or flying down into it also fogs the Bazaar. */
    fog.density = lighting.look.fogDensity + weather.fogBoost;

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
    audio?.update?.(ctx);
    audio?.setTram(traffic.tram.x, traffic.tram.y, traffic.tram.z, true);

    /* ---- interaction ---- */
    /* Scanned without building a list.
     *
     * Each system hands back a stable array whose entries it mutates in place
     * — a board prompt follows its craft, a "stop" prompt follows the player —
     * so the arrays can be held from build time and walked. Spreading the
     * three into a new array every frame, which is what this did first, is
     * three allocations sixty times a second in the one file whose header
     * says not to allocate in the loop. */
    nearest = null;
    let bestD = Infinity;
    for (let g = 0; g < offerGroups.length; g++) {
      const group = offerGroups[g];
      for (let i = 0; i < group.length; i++) {
        const it = group[i];
        if (it.enabled && !it.enabled()) continue;
        const dx = it.x - flyer.position.x;
        const dz = it.z - flyer.position.z;
        const d = Math.hypot(dx, dz);
        if (d >= it.radius || d >= bestD) continue;
        if (Math.abs(it.y - flyer.position.y) >= 6) continue;
        bestD = d;
        nearest = it;
      }
    }
    if (wantInteract) {
      wantInteract = false;
      if (nearest) {
        nearest.activate();
        audio?.event("ui");
        /* Getting out is a two-step handshake on purpose: the prompt's own
         * activate() stashes an exit point and `dismount()` drains it, so
         * pressing the key and calling dismount yields one exit and one
         * place to stand — never two, and never none. */
        const exit = vehicles.dismount();
        if (exit) {
          flyer.position.set(exit.x, exit.y, exit.z);
          flyer.velocity.set(0, 0, 0);
          flyer.grounded = true;
        }
      }
    }

    for (const t of activities.drainToasts()) {
      toasts.push({ ...t, id: toastId++ });
      while (toasts.length > 4) toasts.shift();
    }
    for (let i = toasts.length - 1; i >= 0; i--) {
      toasts[i].ttl -= dt;
      if (toasts[i].ttl <= 0) toasts.splice(i, 1);
    }

    postfx.render(scene, camera, time);

    /* ---- the minimap, at fifteen hertz ---- */
    mapTimer += dt;
    if (minimap && mapTimer > 1 / 15) {
      mapTimer = 0;
      marks.length = 0;
      for (const s of traffic.stops) marks.push({ x: s.x, z: s.z, kind: "tram" });
      for (const pad of vehicles.pads) marks.push({ x: pad.x, z: pad.z, kind: "waypoint" });
      marks.push({ x: traffic.tram.x, z: traffic.tram.z, kind: "tram", active: true });
      minimap.draw(flyer.position.x, flyer.position.z, flyer.yaw, flyer.position.y, marks);
    }

    /* ---- the HUD, at ten hertz ---- */
    hudTimer += dt;
    if (hudTimer > 0.1) {
      hudTimer = 0;
      const place = placeOf(flyer.position);
      onState({
        altitude: flyer.position.y,
        speed,
        drop: flyer.drop,
        thrusting: flyer.thrusting,
        who,
        place: place.name,
        placeAccent: place.accent,
        clock: clockString(ctx.dayPhase),
        dayPhase: ctx.dayPhase,
        dayPinned: pinnedPhase !== null,
        weather: weather.condition,
        weatherPinned: pinnedWeather !== null,
        prompt: nearest ? { label: nearest.label, detail: nearest.detail } : null,
        activity: (() => {
          const r = vehicles.riding();
          // Riding wins the panel: while you are in a glider, the glide ratio
          // is the thing you need on screen, not a courier's distance.
          if (r) return { title: r.label, lines: r.lines.slice() };
          return activities.activity();
        })(),
        toasts: toasts.slice(),
        earned: activities.earned,
        found: activities.found,
      });
    }
  };
  raf = requestAnimationFrame(tick);

  /**
   * Test aid. The only honest way to check a world this size is to open it,
   * and the harness that opens it needs to be able to put the player
   * somewhere specific without holding W for ninety seconds in a software
   * rasteriser.
   */
  const debug = {
    character: () => charId,
    warp: (x: number, y: number, z: number) => {
      activities.abort();
      flyer.position.set(x, y, z);
      flyer.velocity.set(0, 0, 0);
      rigCam.reset(flyer.yaw);
    },
    freeze: (on: boolean) => {
      frozen = on;
    },
    look: (yaw: number, pitch: number) => {
      rigCam.yaw = yaw;
      rigCam.pitch = pitch;
    },
    dist: (d: number) => {
      rigCam.dist = d;
      rigCam.mode = d <= 2.3 ? "first" : "third";
    },
    day: (p: number) => {
      ctx.dayPhase = p;
    },
    weather: (c: Condition | null) => weather.force(c),
    /**
     * Toggle one system's group, by name.
     *
     * The fastest way to find out which of a dozen overlapping systems is the
     * one covering the screen. Bisecting by commenting out `add()` calls means
     * a rebuild and a reload per guess; this is one line in a harness.
     */
    hide: (name: string, on = false) => {
      for (const s of systems) if (s.name === name) s.group.visible = on;
      if (name === "sky") sky.mesh.visible = on;
      if (name === "terrain") terrain.group.visible = on;
      if (name === "body") body.visible = on;
    },
    names: () => systems.map((s) => s.name),
    /**
     * Every drawable in the world with its *world-space* bounding box.
     *
     * `hide` answers "which system is covering the screen"; this answers the
     * next question, which is "and where is it, actually". A thing drawn in
     * the wrong place looks exactly like a thing drawn in the wrong shape
     * until you read the numbers — the towers hanging under the island were
     * mistaken for the rock twice before anybody measured them.
     */
    bboxes: () => {
      const out: Array<{ name: string; min: number[]; max: number[]; tris: number }> = [];
      const walk = (o: THREE.Object3D, label: string) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m.geometry) {
          const b = new THREE.Box3().setFromObject(m);
          const pos = m.geometry.getAttribute("position");
          out.push({
            name: `${label}/${m.name || m.type}`,
            min: b.min.toArray().map((v) => Math.round(v)),
            max: b.max.toArray().map((v) => Math.round(v)),
            tris: Math.round(((m.geometry.index?.count ?? pos?.count ?? 0) / 3) * (m as THREE.InstancedMesh).count || (pos?.count ?? 0) / 3),
          });
        }
        for (const c of o.children) walk(c, label);
      };
      walk(reflected, "reflected");
      walk(detail, "detail");
      walk(terrain.group, "terrain");
      return out;
    },
    room: () => interiors.inside(flyer.position.x, flyer.position.y, flyer.position.z),
    counts: () => ({
      systems: systems.length,
      ...collision.counts,
      lots: cityPlan().lots.length,
      calls: renderer.info.render.calls,
      tris: renderer.info.render.triangles,
      programs: renderer.info.programs?.length ?? 0,
    }),
    state: () => ({
      position: flyer.position.toArray(),
      grounded: flyer.grounded,
      surface: surfaceAt(flyer.position.x, flyer.position.z).kind,
      place: placeOf(flyer.position).name,
      prompt: nearest?.label ?? null,
      dayPhase: ctx.dayPhase,
      /* The rig, so a harness can tell "the drag did nothing" from "the drag
         worked and the picture happens to look similar". */
      cam: { yaw: rigCam.yaw, pitch: rigCam.pitch, dist: rigCam.dist, mode: rigCam.mode },
    }),
    toast: (t: string) => pushToast(t),
  };
  (window as unknown as { __empyrean?: typeof debug }).__empyrean = debug;

  return {
    stick,
    setMuted(muted) {
      audio?.setMuted(muted);
    },
    recall,
    interact() {
      wantInteract = true;
      audio?.resume();
    },
    setDayPhase(p) {
      pinnedPhase = p === null ? null : ((p % 1) + 1) % 1;
    },
    setWeather(c) {
      pinnedWeather = c;
      weather.force(c);
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
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      audio?.dispose();
      audio = null;
      rigDropped = true;
      rig?.dispose();
      rig = null;
      delete (window as unknown as { __empyrean?: unknown }).__empyrean;
      minimap?.dispose();
      for (const s of systems) s.dispose();
      sky.dispose();
      terrain.dispose();
      lighting.dispose();
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

/** Re-exported so the page can type its state without importing the engine. */
export type { EmpyreanState } from "./types";

/** Unused here, kept so `PLATEAU_R` stays imported for future bounds checks. */
export const CITY_RADIUS = PLATEAU_R;
