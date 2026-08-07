/**
 * The ship, the mission, and the clock — everything stateful that is not a
 * mesh.
 *
 * This is the only module that knows both scenes exist. The space scene has
 * never heard of the surface; the surface has never heard of the warp drive;
 * the UI holds a reference to this and to nothing else. Everything the three of
 * them need to say to one another goes over the bus in `types.ts`.
 *
 * ## The loop
 *
 * chart → warp → orbit → scan → hail → beam down → walk → talk → beam up →
 * chart. Seven verbs, and every one of them is a key as well as a button,
 * because a captain giving orders through a mouse is a captain filling in a
 * form.
 *
 * ## Warp, and why it takes six seconds
 *
 * The travel time is computed honestly: `travelDays(ly, warp)` on the real
 * distance at the real TNG warp scale, and the log records it — 90 light years
 * at warp 8 is eighty-four days and the ship's clock advances by eighty-four
 * days. The *animation* is six seconds, because the alternative is either a
 * cut, which throws away the best-looking thing in the game, or eighty-four
 * days, which is not a game. Reporting the true figure while showing a
 * compressed one is the compromise every Star Trek episode has ever made and
 * it is the right one.
 *
 * ## What is deliberately not here
 *
 * There is no combat. Not because it would be hard — the vibeverse has five
 * worlds that already shoot — but because this one is about the other half of
 * the show, the half where you make orbit around somewhere nobody has been and
 * ask it a question. `/trek` is the ship-to-ship game. This is the other one.
 */
import * as THREE from "three";
import {
  FIXED_DT,
  createBus,
  createInput,
  type Bus,
  type Input,
  type Mode,
} from "./types";
import {
  MAX_WARP,
  ORIGIN,
  SYSTEMS,
  distanceLy,
  stardate,
  travelDays,
  travelTime,
  type TrekSystem,
} from "./galaxy/systems";
import { characterByKey, type Character } from "./crew/characters";
import { createSpaceScene, type SpaceScene } from "./space/scene";
import { createSurfaceScene, type SurfaceScene } from "./surface/scene";
import { createAudio, type Audio } from "./audio";

export type Phase = "idle" | "warping" | "beaming";

export interface LogLine {
  text: string;
  urgent: boolean;
  /** Stardate the line was written on, as the log records it. */
  stamp: string;
  id: number;
}

export interface GameState {
  system: TrekSystem;
  mode: Mode;
  phase: Phase;
  warpFactor: number;
  /** 0-1, drives the tunnel and the camera's FOV punch. */
  warpK: number;
  /** 0-1, drives the transporter wash. The UI owns the look of it. */
  beamK: number;
  elapsedDays: number;
  alert: boolean;
  orbiting: boolean;
  altitude: number;
  visited: string[];
  scanned: string[];
  log: LogLine[];
  /** Who the comm panel currently has a channel to. */
  channel: Character | null;
  /** Who is standing close enough to talk to on the surface. */
  near: Character | null;
  captain: string;
}

export interface Game {
  state: GameState;
  bus: Bus;
  audio: Audio;
  input: Input;
  /** Subscribe to state changes — the UI re-renders off this and nothing else. */
  subscribe(fn: () => void): () => void;
  start(): void;
  dispose(): void;
  resize(): void;

  setCourse(key: string): void;
  setWarpFactor(w: number): void;
  scan(): void;
  hail(who?: string): void;
  closeChannel(): void;
  beamDown(): void;
  beamUp(): void;
  toggleAlert(): void;
  toggleOrbit(): void;
  toggleView(): void;
  requestPointerLock(): void;
  /** Called whenever a panel opens — a locked pointer sends every click to the
   *  canvas, which makes the whole LCARS rail unclickable. */
  releasePointerLock(): void;
  say(line: string, urgent?: boolean): void;
}

export interface GameOptions {
  canvas: HTMLCanvasElement;
  captain?: string;
  onEnterWorld?: (route: string) => void;
}

/** Compression: six seconds of animation stands in for the real crossing. */
const WARP_SECONDS = 6.0;
const BEAM_SECONDS = 2.4;

export function createGame(opts: GameOptions): Game {
  const { canvas } = opts;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: window.devicePixelRatio < 2,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  /* Shadows, on the surface only.
   *
   * The single biggest step from "coloured shapes on a coloured plane" to
   * "a place with a sun over it". The cost is one extra depth pass over the
   * kit's forty-odd props and the terrain, on a 200 m box that follows the
   * away team — see `surface/scene.ts`. Space does not use them: nothing there
   * casts onto anything, and the planet lights itself in its own shader. */
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const aspect = (canvas.clientWidth || 1) / (canvas.clientHeight || 1);
  const space: SpaceScene = createSpaceScene(aspect);
  const surface: SurfaceScene = createSurfaceScene(aspect);
  const audio = createAudio();
  const input = createInput(canvas);
  const bus = createBus();

  let logId = 0;
  const state: GameState = {
    system: ORIGIN,
    mode: "space",
    phase: "idle",
    warpFactor: 8,
    warpK: 0,
    beamK: 0,
    elapsedDays: 0,
    alert: false,
    orbiting: true,
    altitude: 0,
    visited: [ORIGIN.key],
    scanned: [],
    log: [],
    channel: null,
    near: null,
    captain: opts.captain?.trim() || "Captain",
  };

  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((f) => f());

  function say(text: string, urgent = false): void {
    state.log = [
      ...state.log.slice(-40),
      { text, urgent, stamp: stardate(state.elapsedDays), id: logId++ },
    ];
    bus.emit({ type: "log", line: text, urgent });
    notify();
  }

  /* --- warp ---------------------------------------------------------------- */

  let warpTarget: TrekSystem | null = null;
  let warpT = 0;
  let warpDays = 0;

  function setCourse(key: string): void {
    if (state.phase !== "idle") return;
    const target = SYSTEMS.find((s) => s.key === key);
    if (!target || target.key === state.system.key) {
      audio.deny();
      return;
    }
    const ly = distanceLy(state.system, target);
    warpDays = travelDays(ly, state.warpFactor);
    warpTarget = target;
    warpT = 0;
    state.phase = "warping";
    state.channel = null;
    audio.accept();
    audio.warpIn();
    say(
      `Course laid in for ${target.name}. ${ly.toFixed(1)} light years at warp ${state.warpFactor.toFixed(1)} — ${travelTime(ly, state.warpFactor)} at present speed.`,
    );
    bus.emit({ type: "warp-start", system: target, ly, warp: state.warpFactor });
    notify();
  }

  function completeWarp(): void {
    const target = warpTarget;
    warpTarget = null;
    if (!target) return;
    state.system = target;
    state.elapsedDays += warpDays;
    if (!state.visited.includes(target.key)) state.visited.push(target.key);
    space.enter(target);
    audio.warpOut();
    say(`Dropping out of warp. ${target.name} system, ${target.quadrant} Quadrant. Standard orbit established.`);
    say(target.tagline);
    bus.emit({ type: "arrive", system: target });
    notify();
  }

  /* --- transporter --------------------------------------------------------- */

  let beamT = 0;
  let beamDir: "down" | "up" | null = null;

  function beamDown(): void {
    if (state.phase !== "idle" || state.mode !== "space") return;
    const sys = state.system;
    if (sys.hazard) {
      audio.deny();
      say(`Transport denied. ${sys.hazard}`, true);
      return;
    }
    if (!sys.surface) {
      audio.deny();
      say("No landing site on file. There is nothing down there to stand on.", true);
      return;
    }
    if (!space.orbiting()) {
      audio.deny();
      say("Transporter needs a stable orbit. Answer the helm — establish standard orbit first.", true);
      return;
    }
    state.phase = "beaming";
    beamDir = "down";
    beamT = 0;
    audio.transporter(false);
    say(`Energising. Coordinates: ${sys.surface.site}.`);
    notify();
  }

  function beamUp(): void {
    if (state.phase !== "idle" || state.mode !== "surface") return;
    state.phase = "beaming";
    beamDir = "up";
    beamT = 0;
    state.channel = null;
    audio.transporter(true);
    say("Away team to Transporter Room. Energise.");
    notify();
  }

  function completeBeam(): void {
    if (beamDir === "down") {
      state.mode = "surface";
      surface.enter(state.system);
      audio.bed("surface", state.system.surface?.gravity ?? 1);
      const ch = state.system.character ? characterByKey(state.system.character) : null;
      say(`Away team materialised. ${state.system.surface?.site}.`);
      if (ch) say(`Sensors read one lifesign in range: ${ch.name}, ${ch.species}.`);
      bus.emit({ type: "beam", down: true });
    } else {
      state.mode = "space";
      surface.leave();
      // The surface loop is what clears this, and it is about to stop running.
      // Left set, the rail offers to hail whoever the away team was standing
      // next to for the rest of the mission, across every system.
      state.near = null;
      audio.bed("space");
      say("Away team aboard. All hands accounted for.");
      bus.emit({ type: "beam", down: false });
    }
    beamDir = null;
    notify();
  }

  /* --- orders --------------------------------------------------------------- */

  function scan(): void {
    if (state.phase !== "idle") return;
    audio.scan();
    const sys = state.system;
    if (!state.scanned.includes(sys.key)) state.scanned.push(sys.key);
    say(`Sensor sweep complete. ${sys.world.name} — class ${sys.world.class}, ${sys.world.diameterKm.toLocaleString()} km, ${sys.world.gravity.toFixed(2)} g.`);
    say(sys.world.notes[Math.floor(Math.random() * sys.world.notes.length)]);
    bus.emit({ type: "scan", system: sys });
    notify();
  }

  function hail(who?: string): void {
    if (state.phase !== "idle") return;
    const key = who ?? state.system.character;
    const ch = key ? characterByKey(key) : undefined;
    if (!ch) {
      audio.deny();
      say("No response on any hailing frequency.", true);
      return;
    }
    audio.hail();
    state.channel = ch;
    say(`Channel open — ${ch.name}.`);
    bus.emit({ type: "channel", character: ch });
    notify();
  }

  function closeChannel(): void {
    if (!state.channel) return;
    say(`Channel closed.`);
    state.channel = null;
    bus.emit({ type: "channel", character: null });
    notify();
  }

  function toggleAlert(): void {
    state.alert = !state.alert;
    if (state.alert) {
      audio.alert();
      say("Red alert. All hands to battle stations.", true);
    } else {
      audio.accept();
      say("Stand down from alert.");
    }
    bus.emit({ type: "alert", on: state.alert });
    notify();
  }

  /* --- loop ----------------------------------------------------------------- */

  let raf = 0;
  let last = 0;
  let acc = 0;
  let running = false;

  function frame(now: number): void {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000 || 0);
    last = now;
    acc += dt;

    let steps = 0;
    while (acc >= FIXED_DT && steps < 5) {
      step(FIXED_DT);
      acc -= FIXED_DT;
      steps++;
    }
    // A tab that has been in the background for a minute must not try to
    // simulate a minute; drop whatever is left over rather than freezing.
    if (steps >= 5) acc = 0;

    render();
    input.endFrame();
  }

  function step(dt: number): void {
    audio.update(dt);

    /* keys — the same seven verbs the buttons call */
    if (!input.typing) {
      if (input.pressed("c")) scan();
      if (input.pressed("h")) {
        if (state.channel) closeChannel();
        else hail();
      }
      if (input.pressed("y")) toggleAlert();
      if (input.pressed("v")) toggleView();
      if (input.pressed("o") && state.mode === "space") toggleOrbit();
      if (input.pressed("b")) (state.mode === "space" ? beamDown : beamUp)();
      if (input.pressed("f") && state.mode === "surface" && state.near) hail(state.near.key);
      if (input.pressed("escape") && state.channel) closeChannel();
    }

    if (state.phase === "warping") {
      warpT += dt;
      const k = warpT / WARP_SECONDS;
      // Ease in over the first fifth, hold, then snap out over the last tenth.
      state.warpK = k < 0.2 ? smooth(k / 0.2) : k > 0.9 ? smooth((1 - k) / 0.1) : 1;
      if (warpT >= WARP_SECONDS) {
        state.warpK = 0;
        state.phase = "idle";
        completeWarp();
      }
    } else if (state.phase === "beaming") {
      beamT += dt;
      const k = beamT / BEAM_SECONDS;
      state.beamK = k < 0.5 ? smooth(k / 0.5) : smooth((1 - k) / 0.5);
      // The swap happens at the peak of the wash, when the screen is white.
      if (beamDir && beamT >= BEAM_SECONDS * 0.5) completeBeam();
      if (beamT >= BEAM_SECONDS) {
        state.beamK = 0;
        state.phase = "idle";
        notify();
      }
    }

    if (state.mode === "space") {
      space.update(dt, input, { warp: state.warpK, frozen: state.phase !== "idle" && state.warpK < 0.02 });
      const orb = space.orbiting();
      const alt = space.altitude();
      if (orb !== state.orbiting) {
        state.orbiting = orb;
        bus.emit({ type: "orbit", established: orb });
        notify();
      }
      // The HUD reads altitude to the nearest ten kilometres. Anything finer
      // is a number that changes every frame and tells nobody anything.
      const rounded = Math.round(alt / 10) * 10;
      if (rounded !== state.altitude) {
        state.altitude = rounded;
        notify();
      }
    } else {
      surface.update(dt, input, { frozen: state.phase !== "idle", talking: !!state.channel });
      const n = surface.nearby();
      const ch = n?.character ?? null;
      if (ch?.key !== state.near?.key) {
        state.near = ch;
        bus.emit({ type: "near", character: ch });
        notify();
      }
    }
  }

  function render(): void {
    if (state.mode === "space") renderer.render(space.scene, space.camera);
    else renderer.render(surface.scene, surface.camera);
  }

  function resize(): void {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    const a = w / Math.max(1, h);
    space.camera.aspect = a;
    space.camera.updateProjectionMatrix();
    surface.camera.aspect = a;
    surface.camera.updateProjectionMatrix();
  }

  function toggleOrbit(): void {
    const next = !space.orbiting();
    space.setOrbit(next);
    audio.accept();
    say(next ? "Standard orbit, aye." : "Helm answering manual control. You have the con.");
    notify();
  }

  function toggleView(): void {
    space.toggleView();
    audio.chirp(2);
    notify();
  }

  return {
    state,
    bus,
    audio,
    input,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start() {
      if (running) return;
      running = true;
      space.enter(state.system);
      audio.bed("space");
      say(`Captain's log, stardate ${stardate(0)}. ${state.captain} recording.`);
      say(`USS Odyssey, standard orbit of ${state.system.world.name}. The chart is yours — twelve systems on file, and the Federation has been to eight of them.`);
      last = performance.now();
      raf = requestAnimationFrame(frame);
      notify();
    },
    dispose() {
      running = false;
      cancelAnimationFrame(raf);
      listeners.clear();
      bus.clear();
      input.dispose();
      audio.dispose();
      space.dispose();
      surface.dispose();
      renderer.dispose();
      // Explicitly drop the context. Without this, three or four visits
      // exhaust the browser's limit and the *next* world a visitor opens
      // renders black — which is a miserable thing to debug from the outside.
      renderer.forceContextLoss?.();
    },
    resize,
    setCourse,
    setWarpFactor(w) {
      state.warpFactor = Math.max(1, Math.min(MAX_WARP, Math.round(w * 10) / 10));
      notify();
    },
    scan,
    hail,
    closeChannel,
    beamDown,
    beamUp,
    toggleAlert,
    toggleOrbit,
    toggleView,
    requestPointerLock() {
      try {
        canvas.requestPointerLock();
      } catch {
        /* denied — touch and arrow keys still work */
      }
      audio.resume();
    },
    releasePointerLock() {
      try {
        if (document.pointerLockElement === canvas) document.exitPointerLock();
      } catch {
        /* never locked */
      }
    },
    say,
  };
}

const smooth = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};
