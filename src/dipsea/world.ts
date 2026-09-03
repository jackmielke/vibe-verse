/**
 * The Dipsea — the engine.
 *
 * You run the trail; the trail decides how fast. Effort is the only control
 * that matters — walk, run or push — and the grade under your feet turns it
 * into speed. What you manage is the body: stamina goes with the hills, the
 * bottle has six sips and refills twice, and pushing on an empty tank builds
 * the nausea that stopped a real run at mile four. Touching a tree helps. It
 * genuinely does.
 *
 * Nothing here is random except the ghost runners' breathing. The course is
 * data (`trail.ts`), so two runs at the same effort are the same run, which
 * is what makes a time worth chasing.
 */
import * as THREE from "three";
import { buildScenery, type Scenery } from "./scenery";
import { COURSE_MILES, TRAIL, gradeAt, sectionAt, type Section } from "./trail";
import { findCharacter } from "@/lib/characters";
import { loadCharacterRig, type CharacterRig } from "@/lib/characterRig";

export type Effort = "walk" | "run" | "push";
export type Mode = "single" | "quad";

export interface Ghost {
  name: string;
  colour: string;
  mile: number;
  /** Course progress, 0..1, across all legs. */
  progress: number;
}

export interface DipseaState {
  mode: Mode;
  effort: Effort;
  /** Miles along the course, 0..7.3, on the current leg. */
  mile: number;
  /** Which leg of the quad you are on, 1..4. Always 1 in single. */
  leg: number;
  /** +1 heading to Stinson, -1 heading home. */
  direction: 1 | -1;
  elapsed: number;
  speedMph: number;
  grade: number;
  stamina: number;
  water: number;
  nausea: number;
  grounded: number;
  section: Section;
  /** A line to show for a few seconds. */
  note: string | null;
  finished: boolean;
  /** Nearest tree is close enough to touch. */
  treeNear: boolean;
  /** You are stopped, hands on knees. */
  stopped: boolean;
  ghosts: Ghost[];
  totalMiles: number;
  milesDone: number;
}

export interface DipseaStick {
  /** -1 = push, 0 = run, +1 = walk. */
  y: number;
}

export interface DipseaWorld {
  readonly stick: DipseaStick;
  setEffort(effort: Effort): void;
  sip(): void;
  touchTree(): void;
  restart(mode?: Mode): void;
  dispose(): void;
}

export interface DipseaOptions {
  container: HTMLElement;
  mode: Mode;
  onState: (state: DipseaState) => void;
}

const WALK = 3.2;
const RUN = 7.2;
const PUSH = 10.5;
const SIPS = 6;

/** How the grade multiplies a runner's speed. Uphill costs; downhill pays a little. */
function gradeFactor(grade: number): number {
  if (grade > 0) return 1 / (1 + grade * 5.5);
  return 1 + Math.min(0.28, -grade * 1.1);
}

interface GhostRunner {
  name: string;
  colour: string;
  /** Multiplier on the player's run pace. */
  pace: number;
  /** How much hills bother them: <1 climbs well. */
  hillWeight: number;
  /** Late-race fade, as a fraction of pace lost by the end. */
  fade: number;
  s: number;
  direction: 1 | -1;
  leg: number;
  group: THREE.Group;
  done: boolean;
}

function buildGhostFigure(colour: string): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: colour, transparent: true, opacity: 0.8 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.8, 4, 8), mat);
  body.position.y = 1.0;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 8), mat);
  head.position.y = 1.72;
  g.add(body, head);
  return g;
}

export function createDipsea(options: DipseaOptions): DipseaWorld {
  const { container, onState } = options;
  let mode: Mode = options.mode;

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
  renderer.setClearColor(0xd8e3ea, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.touchAction = "none";

  const scene = new THREE.Scene();
  const fogColor = new THREE.Color(0xd8e3ea);
  scene.fog = new THREE.FogExp2(fogColor.getHex(), 0.0012);

  const camera = new THREE.PerspectiveCamera(
    62,
    (container.clientWidth || 1) / (container.clientHeight || 1),
    0.3,
    6000,
  );

  const sun = new THREE.DirectionalLight(0xfff1d6, 1.9);
  sun.position.set(-300, 400, -200);
  scene.add(sun);
  const hemi = new THREE.HemisphereLight(0xbcd4ea, 0x5a4a30, 0.9);
  scene.add(hemi);

  const scenery: Scenery = buildScenery();
  scene.add(scenery.group);

  // ---- The runner -----------------------------------------------------
  const runner = new THREE.Group();
  scene.add(runner);
  const RUNNER_HEIGHT = 1.7;
  let rig: CharacterRig | null = null;
  let rigDropped = false;
  // A stand-in until the rig arrives, so the camera has something to follow.
  const standIn = buildGhostFigure("#f0f0f0");
  runner.add(standIn);
  const charId =
    (typeof window !== "undefined" &&
      (localStorage.getItem("lobby.character") ?? localStorage.getItem("city.character"))) ||
    "vibey";
  void loadCharacterRig(findCharacter(charId), {
    height: RUNNER_HEIGHT,
    fitBy: "height",
    center: true,
    castShadow: false,
    walkSpeed: 3,
  })
    .then((r) => {
      if (rigDropped) return r.dispose();
      rig = r;
      runner.remove(standIn);
      runner.add(r.object);
    })
    .catch(() => {
      /* still a run */
    });

  // ---- Ghosts ------------------------------------------------------------
  const ghosts: GhostRunner[] = [
    { name: "Janine", colour: "#ff8fb1", pace: 0.96, hillWeight: 0.8, fade: 0.02, s: 0, direction: 1, leg: 1, group: buildGhostFigure("#ff8fb1"), done: false },
    { name: "Liv", colour: "#8fd3ff", pace: 1.06, hillWeight: 1.15, fade: 0.18, s: 0, direction: 1, leg: 1, group: buildGhostFigure("#8fd3ff"), done: false },
    { name: "Noah", colour: "#c8ff8f", pace: 0.99, hillWeight: 1.0, fade: 0.06, s: 0, direction: 1, leg: 1, group: buildGhostFigure("#c8ff8f"), done: false },
  ];
  for (const g of ghosts) scene.add(g.group);

  // ---- Run state -----------------------------------------------------------
  const stick: DipseaStick = { y: 0 };
  let effort: Effort = "run";
  let keyEffort: Effort | null = null;
  let s = 0;
  let direction: 1 | -1 = 1;
  let leg = 1;
  let elapsed = 0;
  let speed = 0;
  let stamina = 100;
  let water = SIPS;
  let thirst = 0;
  let nausea = 0;
  let grounded = 40;
  let stoppedUntil = 0;
  let finished = false;
  let note: string | null = null;
  let noteUntil = 0;
  let lastSection: Section | null = null;
  let treeNear = false;
  const touched = new Map<number, number>();
  let mile4Warned = false;
  let refillMile = -1;

  const totalLegs = () => (mode === "quad" ? 4 : 1);

  const say = (text: string, seconds = 4.5) => {
    note = text;
    noteUntil = elapsed + seconds;
  };

  const resetRun = () => {
    s = 0;
    direction = 1;
    leg = 1;
    elapsed = 0;
    speed = 0;
    stamina = 100;
    water = SIPS;
    thirst = 0;
    nausea = 0;
    grounded = 40;
    stoppedUntil = 0;
    finished = false;
    note = null;
    lastSection = null;
    mile4Warned = false;
    refillMile = -1;
    touched.clear();
    effort = "run";
    for (const g of ghosts) {
      g.s = 0;
      g.direction = 1;
      g.leg = 1;
      g.done = false;
    }
    say(mode === "quad" ? "Quad Dipsea. Four legs, 28 miles, 9,000 feet. Pace yourself." : "The Dipsea. Old Mill Park to Stinson Beach.", 5);
  };
  resetRun();

  // ---- Input ---------------------------------------------------------------
  const keys = new Set<string>();
  let camYaw = 0;
  let camPitch = 0.18;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    keys.add(e.code);
    if (e.code === "KeyQ") sip();
    if (e.code === "KeyE") touchTree();
    if (e.code === "KeyR") resetRun();
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  const onBlur = () => keys.clear();
  const onPointerDown = (e: PointerEvent) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    camYaw -= (e.clientX - lastX) * 0.006;
    camPitch = Math.max(-0.3, Math.min(0.9, camPitch + (e.clientY - lastY) * 0.004));
    lastX = e.clientX;
    lastY = e.clientY;
  };
  const onPointerUp = () => {
    dragging = false;
  };
  const onResize = () => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  window.addEventListener("resize", onResize);
  const canvas = renderer.domElement;
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);

  function sip() {
    if (water <= 0) {
      say("The bottle is empty. There is water at Redwood Creek and at the beach.");
      return;
    }
    water--;
    stamina = Math.min(100, stamina + 14);
    nausea = Math.max(0, nausea - 12);
    thirst = Math.max(0, thirst - 35);
    say(water === 0 ? "Last sip. Tastes like surf water." : "A sip. Better.", 2.5);
  }

  function touchTree() {
    const p = runner.position;
    let best: (typeof scenery.trees)[number] | null = null;
    let bestD = 4.2;
    let bestI = -1;
    for (let i = 0; i < scenery.trees.length; i++) {
      const t = scenery.trees[i];
      const d = Math.hypot(t.x - p.x, t.z - p.z);
      if (d < bestD) {
        bestD = d;
        best = t;
        bestI = i;
      }
    }
    if (best === null) {
      say("No tree in reach. The ridge is grass and the beach is sand.", 2.5);
      return;
    }
    const last = touched.get(bestI) ?? -100;
    if (elapsed - last < 20) {
      say("You already touched that one. It counts once.", 2.5);
      return;
    }
    touched.set(bestI, elapsed);
    grounded = Math.min(100, grounded + (best.big ? 32 : 20));
    nausea = Math.max(0, nausea - 8);
    say(best.big ? "Redwood. Bark like a sponge. You feel it in your feet." : "A bay tree. Smells like the whole hillside.", 3);
  }

  // ---- Physics ----------------------------------------------------------------
  const tmpDir = new THREE.Vector3();
  const camGoal = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const look = new THREE.Vector3();

  const ghostSpeed = (g: GhostRunner, grade: number, progress: number): number => {
    const eff = RUN * g.pace * (1 - g.fade * progress);
    const gf = grade > 0 ? 1 / (1 + grade * 5.5 * g.hillWeight) : gradeFactor(grade);
    const breathing = 1 + Math.sin(elapsed * 0.7 + g.name.length) * 0.03;
    return eff * gf * breathing;
  };

  const stepGhost = (g: GhostRunner, dt: number) => {
    if (g.done) return;
    const mile = (g.s / TRAIL.length) * COURSE_MILES;
    const grade = gradeAt(mile) * g.direction;
    const total = totalLegs();
    const progress = (g.leg - 1 + (g.direction === 1 ? mile / COURSE_MILES : 1 - mile / COURSE_MILES)) / total;
    g.s += ghostSpeed(g, grade, progress) * dt * g.direction;
    if (g.direction === 1 && g.s >= TRAIL.length) {
      if (g.leg >= total) {
        g.s = TRAIL.length;
        g.done = true;
      } else {
        g.leg++;
        g.direction = -1;
        g.s = TRAIL.length;
      }
    } else if (g.direction === -1 && g.s <= 0) {
      if (g.leg >= total) {
        g.s = 0;
        g.done = true;
      } else {
        g.leg++;
        g.direction = 1;
        g.s = 0;
      }
    }
    const p = TRAIL.at(g.s);
    // Ghosts run their own line, a stride to the side, so you can pass them.
    const off = g.name === "Janine" ? 1.1 : g.name === "Liv" ? -1.1 : 0.4;
    g.group.position.set(p.x - p.dz * off, p.y, p.z + p.dx * off);
    g.group.rotation.y = Math.atan2(p.dx * g.direction, p.dz * g.direction);
    const bob = Math.abs(Math.sin(elapsed * 9 + off * 5)) * 0.08;
    g.group.position.y += bob;
  };

  let raf = 0;
  let last = performance.now();
  let stateClock = 0;
  let disposed = false;

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    // ---- Effort from keys or the stick ----------------------------------
    keyEffort = null;
    if (keys.has("ShiftLeft") || keys.has("ShiftRight") || keys.has("ArrowUp") || keys.has("KeyW")) keyEffort = "push";
    if (keys.has("KeyS") || keys.has("ArrowDown")) keyEffort = "walk";
    if (stick.y < -0.4) keyEffort = "push";
    else if (stick.y > 0.4) keyEffort = "walk";
    const wanted: Effort = keyEffort ?? effort;
    if (keyEffort === null) effort = "run";
    else effort = wanted;

    if (!finished) elapsed += dt;

    const mile = (s / TRAIL.length) * COURSE_MILES;
    const grade = gradeAt(mile) * direction;
    const section = sectionAt(mile);

    // ---- Body ----------------------------------------------------------------
    const stopped = elapsed < stoppedUntil;
    let base = effort === "push" ? PUSH : effort === "walk" ? WALK : RUN;
    if (stopped) base = 0;
    if (finished) base = 0;
    const stairs = section.biome === "stairs" ? 0.72 : 1;
    const tired = stamina < 25 ? 0.5 + (stamina / 25) * 0.5 : 1;
    const queasy = nausea > 60 ? 0.65 : 1;
    const targetSpeed = base * gradeFactor(grade) * stairs * tired * queasy;
    speed += (targetSpeed - speed) * Math.min(1, dt * 3);

    const uphill = Math.max(0, grade);
    const downhill = Math.max(0, -grade);
    const calm = 0.5 + (grounded / 100) * 0.5; // high grounded = slower nausea, faster recovery
    if (!finished && !stopped) {
      if (effort === "push") stamina -= dt * (4.2 + uphill * 22);
      else if (effort === "run") stamina -= dt * (0.9 + uphill * 14 - 0.4);
      else stamina += dt * (3.2 + calm * 2) * (thirst > 70 ? 0.5 : 1);
      stamina = Math.max(0, Math.min(100, stamina));

      let n = 0;
      if (effort === "push") n += 3.6 + downhill * 10;
      if (stamina < 30) n += 3.0;
      if (effort === "walk") n -= 2.6 * calm;
      else if (effort === "run") n -= 0.7 * calm;
      if (thirst > 60) n += 0.8;
      nausea = Math.max(0, Math.min(100, nausea + n * dt * (effort === "push" ? 2 - calm : 1)));
      thirst = Math.min(100, thirst + dt * (0.55 + (effort === "push" ? 0.4 : 0)));
      grounded = Math.max(0, grounded - dt * 0.35);
    }
    if (nausea >= 95 && !stopped) {
      stoppedUntil = elapsed + 4;
      nausea = 55;
      say("Salivating. You have to stop, hands on knees. Drink something.", 4.5);
    }
    if (!mile4Warned && mile > 3.9 && mile < 4.2 && nausea > 45 && direction === 1 && leg === 1) {
      mile4Warned = true;
      say("Mile four. This is where it went wrong last time.", 4);
    }

    // ---- Along the trail ------------------------------------------------------
    s += speed * dt * direction;
    const total = totalLegs();
    if (direction === 1 && s >= TRAIL.length) {
      if (leg >= total) {
        s = TRAIL.length;
        if (!finished) {
          finished = true;
          say(mode === "quad" ? "Four legs. Twenty-eight miles. Stinson Beach, twice." : "Stinson Beach. The ocean. Touch it.", 8);
        }
      } else {
        leg++;
        direction = -1;
        s = TRAIL.length;
        say(`Leg ${leg}. Turn around at the ocean and run it home.`, 4);
      }
    } else if (direction === -1 && s <= 0) {
      if (leg >= total) {
        s = 0;
        if (!finished) {
          finished = true;
          say("Old Mill Park. Home. Twenty-eight miles.", 8);
        }
      } else {
        leg++;
        direction = 1;
        s = 0;
        say(`Leg ${leg}. Back up the stairs.`, 4);
      }
    }

    // Water refills, once per pass.
    for (const m of [2.05, 7.2]) {
      if (Math.abs(mile - m) < 0.03 && refillMile !== m && water < SIPS) {
        refillMile = m;
        water = SIPS;
        thirst = 0;
        say(m < 5 ? "Redwood Creek. Bottle full, and it is cold." : "A tap at the beach. Bottle full.", 3);
      }
      if (Math.abs(mile - m) > 0.2 && refillMile === m) refillMile = -1;
    }

    // Section notes.
    if (section !== lastSection) {
      if (lastSection !== null) say(`${section.name} — ${section.note}`, 4.5);
      lastSection = section;
    }
    if (note && elapsed > noteUntil) note = null;

    // ---- Place the runner -----------------------------------------------
    const p = TRAIL.at(s);
    runner.position.set(p.x, p.y, p.z);
    const heading = Math.atan2(p.dx * direction, p.dz * direction);
    runner.rotation.y = heading;
    if (rig) {
      rig.setLocomotion(Math.min(1, speed / RUN));
      rig.update(dt);
    } else {
      standIn.position.y = Math.abs(Math.sin(elapsed * 9)) * 0.08 * Math.min(1, speed / 3);
    }

    // Nearest tree?
    treeNear = false;
    for (const t of scenery.trees) {
      if (Math.abs(t.x - p.x) > 4.2 || Math.abs(t.z - p.z) > 4.2) continue;
      if (Math.hypot(t.x - p.x, t.z - p.z) < 4.2) {
        treeNear = true;
        break;
      }
    }

    for (const g of ghosts) stepGhost(g, dt);

    // ---- Fog: the marine layer lives on the coast side of Cardiac ---------
    const coastal = Math.max(0, Math.min(1, (mile - 4.0) / 2.6));
    const creek = section.biome === "creek" || section.biome === "redwoods" ? 0.35 : 0;
    const density = 0.0007 + coastal * 0.0026 + creek * 0.0012;
    (scene.fog as THREE.FogExp2).density += (density - (scene.fog as THREE.FogExp2).density) * Math.min(1, dt * 0.8);
    const warm = new THREE.Color(0xdfe6ea);
    const white = new THREE.Color(0xeef1f3);
    fogColor.copy(warm).lerp(white, coastal);
    (scene.fog as THREE.FogExp2).color.copy(fogColor);
    renderer.setClearColor(fogColor, 1);
    hemi.intensity = 0.9 + coastal * 0.4;
    sun.intensity = 1.9 - coastal * 0.8;

    // ---- Camera: chase, with a wobble when you are not well -------------
    const wobble = nausea > 55 ? ((nausea - 55) / 45) * 0.35 : 0;
    const yaw = heading + Math.PI + camYaw + Math.sin(elapsed * 1.7) * wobble * 0.5;
    const dist = 7.5;
    tmpDir.set(Math.sin(yaw) * Math.cos(camPitch), Math.sin(camPitch), Math.cos(yaw) * Math.cos(camPitch));
    camGoal.copy(runner.position).addScaledVector(tmpDir, dist);
    camGoal.y = Math.max(camGoal.y, runner.position.y + 1.2);
    camPos.lerp(camGoal, Math.min(1, dt * 4));
    camera.position.copy(camPos);
    look.copy(runner.position);
    look.y += 1.3 + Math.sin(elapsed * 2.3) * wobble;
    look.x += p.dx * direction * 2;
    look.z += p.dz * direction * 2;
    camera.lookAt(look);
    camera.rotation.z = Math.sin(elapsed * 1.1) * wobble * 0.25;

    scenery.update(elapsed, camera, fogColor);
    renderer.render(scene, camera);

    // ---- Report -----------------------------------------------------------------
    stateClock += dt;
    if (stateClock > 0.1) {
      stateClock = 0;
      const milesDone = (leg - 1) * COURSE_MILES + (direction === 1 ? mile : COURSE_MILES - mile);
      onState({
        mode,
        effort,
        mile,
        leg,
        direction,
        elapsed,
        // The world runs about eight times faster than a real runner covers
        // real miles, so this reads as a plausible running pace rather than
        // sixty miles an hour.
        speedMph: ((speed / TRAIL.metresPerMile) * 3600) / 8,
        grade,
        stamina,
        water,
        nausea,
        grounded,
        section,
        note,
        finished,
        treeNear,
        stopped,
        ghosts: ghosts.map((g) => {
          const gm = (g.s / TRAIL.length) * COURSE_MILES;
          const done = (g.leg - 1) * COURSE_MILES + (g.direction === 1 ? gm : COURSE_MILES - gm);
          return { name: g.name, colour: g.colour, mile: gm, progress: done / (COURSE_MILES * total) };
        }),
        totalMiles: COURSE_MILES * total,
        milesDone,
      });
    }
  };
  raf = requestAnimationFrame(tick);

  return {
    stick,
    setEffort(e) {
      effort = e;
    },
    sip,
    touchTree,
    restart(m) {
      if (m) mode = m;
      resetRun();
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
      rigDropped = true;
      rig?.dispose();
      scenery.dispose();
      for (const g of ghosts) {
        g.group.traverse((o) => {
          const m = o as THREE.Mesh;
          m.geometry?.dispose();
          (m.material as THREE.Material | undefined)?.dispose();
        });
      }
      renderer.dispose();
      renderer.forceContextLoss();
      if (canvas.parentElement === container) container.removeChild(canvas);
    },
  };
}
