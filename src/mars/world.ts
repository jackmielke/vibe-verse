/**
 * Mars College, the engine.
 *
 * Ten weeks in the desert on an electric unicycle. The rules are in
 * `colony.ts` and never touch three; this file rides you between the camps,
 * runs the sky, brings the dust in, and turns a press of E at a place into
 * one of the colony's actions. Time passes on its own, a day-part every
 * `PART_SECONDS`, or faster when you spend it: a build is an afternoon, a
 * water run is half a day, a nap is a nap.
 *
 * The end is a teardown. Everything that was built comes down, and the last
 * card reads your stats back to you.
 */
import * as THREE from "three";
import { createAudio } from "./audio";
import {
  DAYS,
  PARTS,
  act,
  advance,
  newColony,
  partIndex,
  verdict,
  weekOf,
  type Action,
  type ColonyState,
  type DayCard,
  type Part,
} from "./colony";
import { SEA_X, SPAWN, groundHeight, nearestPlace, placeById, promptFor, type Place } from "./places";
import { buildRider } from "./rider";
import { buildScene } from "./scene";

export type Phase = "play" | "teardown" | "done";

export interface MarsStats {
  dinners: number;
  km: number;
  kmRun: number;
  storms: number;
  waterRuns: number;
  hugs: number;
  builds: number;
  falls: number;
  scorpions: number;
}

export interface MarsState {
  day: number;
  week: number;
  part: Part;
  /** 0..1 through the current day-part. */
  partT: number;
  water: number;
  power: number;
  shelter: number;
  connection: number;
  purpose: number;
  parts: number;
  pullupBar: boolean;
  storm: boolean;
  stormWarning: boolean;
  /** 0..1, how deep inside the dust you are right now. */
  stormLevel: number;
  speedKmh: number;
  prompt: { place: string; label: string } | null;
  note: string | null;
  card: DayCard | null;
  phase: Phase;
  music: boolean;
  fallen: boolean;
  stats: MarsStats;
  grade: string;
  verdict: string;
}

export interface MarsStick {
  /** -1..1, left to right. */
  x: number;
  /** -1..1, forward is positive. */
  y: number;
}

export interface MarsWorld {
  readonly stick: MarsStick;
  interact(): void;
  sleep(): void;
  toggleMusic(): void;
  dismissCard(): void;
  restart(): void;
  dispose(): void;
}

export interface MarsOptions {
  container: HTMLElement;
  onState: (s: MarsState) => void;
  /** Card capture: a golden afternoon, the rider already moving. */
  shot?: boolean;
  seed?: number;
}

/** Real seconds a day-part lasts if you spend it doing nothing. */
const PART_SECONDS = 45;
const MAX_SPEED = 11;
const STORM_SPEED = 4.5;

// Sky keys: dawn, noon, dusk, night. The desert sky is pale and huge.
const SKY_TOP = [0xf0b48c, 0xcfe0ea, 0xf2a06a, 0x0c1630].map((c) => new THREE.Color(c));
const SKY_HOR = [0xf7d7b0, 0xefe9dc, 0xf7c79a, 0x22304f].map((c) => new THREE.Color(c));
const SUN_COL = [0xffb070, 0xfff6e0, 0xff9a5c, 0x8fa3d6].map((c) => new THREE.Color(c));
const DUST_COL = new THREE.Color(0xa97c4e);

export function createMars(options: MarsOptions): MarsWorld {
  const { container, onState } = options;
  const shot = !!options.shot;

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
  renderer.setClearColor(0xefe9dc, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.touchAction = "none";

  const scene = new THREE.Scene();
  const fogColor = new THREE.Color(0xefe9dc);
  scene.fog = new THREE.FogExp2(fogColor.getHex(), 0.00055);
  const camera = new THREE.PerspectiveCamera(60, (container.clientWidth || 1) / (container.clientHeight || 1), 0.3, 6000);

  const sun = new THREE.DirectionalLight(0xfff1d6, 2.0);
  sun.position.set(200, 300, -100);
  scene.add(sun);
  const hemi = new THREE.HemisphereLight(0xdfe6ee, 0x8a7a5a, 0.8);
  scene.add(hemi);

  const world = buildScene();
  scene.add(world.group);
  const rider = buildRider();
  scene.add(rider.group);
  const audio = createAudio();

  // ---- Colony ---------------------------------------------------------------
  let colony: ColonyState = newColony(options.seed ?? 7);
  let partT = 0;
  let phase: Phase = "play";
  let teardownT = 0;
  const noteQueue: string[] = [];
  let note: string | null = null;
  let noteUntil = 0;
  let card: DayCard | null = null;
  let elapsed = 0;
  let kmRidden = 0;
  let falls = 0;
  let stormLevel = 0;
  let wallLevel = 0;
  let drillIn = 4;

  // ---- Rider -------------------------------------------------------------------
  const stick: MarsStick = { x: 0, y: 0 };
  let px = SPAWN.x;
  let pz = SPAWN.z;
  let heading = Math.PI; // facing the table, which is north of the spawn
  let speed = 0;
  let wobble = 0;
  let fallen = 0;
  let leanIn = 0;
  let tiltIn = 0;

  const say = (lines: string[]) => {
    for (const l of lines) if (noteQueue.length < 5) noteQueue.push(l);
  };

  const takeColony = (next: ColonyState) => {
    colony = next;
    say(next.lines);
    if (next.card) card = next.card;
    world.pullupBar.visible = colony.pullupBar;
    world.shelterStages.forEach((g, i) => (g.visible = colony.shelter >= (i + 1) * 20));
    if (colony.over && phase === "play") {
      phase = "teardown";
      teardownT = 0;
    }
  };

  const reset = () => {
    colony = newColony(options.seed ?? 7);
    partT = shot ? 0.45 : 0;
    if (shot) colony = { ...colony, part: "afternoon", card: null };
    phase = "play";
    teardownT = 0;
    noteQueue.length = 0;
    note = null;
    card = null;
    kmRidden = 0;
    falls = 0;
    stormLevel = 0;
    wallLevel = 0;
    px = shot ? 26 : SPAWN.x;
    pz = shot ? 58 : SPAWN.z;
    heading = shot ? Math.atan2(-26 - 8, -58 + 10) : Math.PI;
    speed = shot ? 5 : 0;
    wobble = 0;
    fallen = 0;
    for (const s of world.structures) {
      s.scale.set(1, 1, 1);
      s.position.y = 0;
      s.visible = true;
    }
    world.dodeca.position.y = groundHeight(placeById("research").x, placeById("research").z) + 6.2;
    takeColony({ ...colony, lines: shot ? [] : colony.lines, card: shot ? null : colony.card });
    if (shot) card = null;
  };
  reset();

  // ---- Input -------------------------------------------------------------------------
  const keys = new Set<string>();
  let camYaw = 0;
  let camPitch = 0.22;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    keys.add(e.code);
    if (e.code === "KeyE" || e.code === "Enter" || e.code === "Space") {
      e.preventDefault();
      interact();
    }
    if (e.code === "KeyN") sleep();
    if (e.code === "KeyM") toggleMusic();
    if (e.code === "KeyR" && phase === "done") reset();
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
    camPitch = Math.max(-0.1, Math.min(0.9, camPitch + (e.clientY - lastY) * 0.004));
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

  function currentPlace(): Place | null {
    return nearestPlace(px, pz);
  }

  function doAction(a: Action) {
    if (phase !== "play") return;
    const before = colony;
    takeColony(act(colony, a));
    // Spending a day-part restarts the clock on the new one.
    if (colony.day !== before.day || colony.part !== before.part) partT = 0;
  }

  function interact() {
    if (card) {
      card = null;
      return;
    }
    if (phase !== "play") return;
    const place = currentPlace();
    if (!place) {
      say(["Nothing here but sand. Ride to a camp, the table, or town."]);
      return;
    }
    doAction(promptFor(colony, place).action);
  }

  function sleep() {
    if (card) {
      card = null;
      return;
    }
    doAction("sleep");
  }

  function toggleMusic() {
    audio.setMusic(!audio.musicOn());
    say([audio.musicOn() ? "Music on. The whole desert can hear it, which is the idea." : "Music off. Now it is just the drills."]);
  }

  // ---- Loop --------------------------------------------------------------------------------
  const tmp = new THREE.Vector3();
  const camGoal = new THREE.Vector3();
  const camPos = new THREE.Vector3(px, 4, pz + 8);
  const look = new THREE.Vector3();
  const skyTop = new THREE.Color();
  const skyHor = new THREE.Color();
  const sunCol = new THREE.Color();
  let raf = 0;
  let last = performance.now();
  let stateClock = 0;
  let disposed = false;

  const lerp4 = (out: THREE.Color, keys: THREE.Color[], tod: number) => {
    // dawn 0, pale from 0.2 to 0.55, dusk 2/3, full night from 0.76 to 0.95, dawn at 1.
    const stops = [0, 0.2, 0.55, 2 / 3, 0.76, 0.95, 1];
    const cols = [keys[0], keys[1], keys[1], keys[2], keys[3], keys[3], keys[0]];
    for (let i = 0; i < 6; i++) {
      if (tod >= stops[i] && tod <= stops[i + 1]) {
        const t = (tod - stops[i]) / (stops[i + 1] - stops[i]);
        out.copy(cols[i]).lerp(cols[i + 1], t * t * (3 - 2 * t));
        return;
      }
    }
    out.copy(keys[0]);
  };

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    elapsed += dt;

    // ---- Input --------------------------------------------------------------------
    let lx = stick.x;
    let ly = stick.y;
    if (keys.has("KeyA") || keys.has("ArrowLeft")) lx -= 1;
    if (keys.has("KeyD") || keys.has("ArrowRight")) lx += 1;
    if (keys.has("KeyW") || keys.has("ArrowUp")) ly += 1;
    if (keys.has("KeyS") || keys.has("ArrowDown")) ly -= 1;
    if (shot) ly = 0.6;
    if (phase !== "play" || card) {
      lx = 0;
      ly = 0;
    }
    lx = Math.max(-1, Math.min(1, lx));
    ly = Math.max(-1, Math.min(1, ly));
    leanIn += (lx - leanIn) * Math.min(1, dt * 8);
    tiltIn += (ly - tiltIn) * Math.min(1, dt * 6);

    // ---- The clock ------------------------------------------------------------------
    if (phase === "play" && !card) {
      partT += dt / PART_SECONDS;
      if (partT >= 1) {
        partT = 0;
        takeColony(advance(colony, 1));
      }
    }
    const tod = (partIndex(colony.part) + partT) / PARTS.length;

    // ---- Riding -------------------------------------------------------------------
    const maxSpeed = colony.storm ? STORM_SPEED + (1 - stormLevel) * (MAX_SPEED - STORM_SPEED) : MAX_SPEED;
    if (fallen > 0) {
      fallen -= dt;
      speed = 0;
    } else {
      const ahead = groundHeight(px + Math.sin(heading) * 1.5, pz + Math.cos(heading) * 1.5);
      const here = groundHeight(px, pz);
      const slope = (ahead - here) / 1.5;
      speed += tiltIn * 6.5 * dt;
      speed -= slope * 6 * dt * Math.sign(speed || 1);
      speed *= Math.max(0, 1 - dt * (tiltIn === 0 ? 0.9 : 0.25));
      speed = Math.max(-2.5, Math.min(maxSpeed, speed));
      if (Math.abs(speed) < 0.02 && tiltIn === 0) speed = 0;
      const turnRate = (1.4 + 1.3 * Math.min(1, Math.abs(speed) / 6)) * (speed < -0.2 ? -1 : 1);
      heading -= leanIn * turnRate * dt;
      // Tech exploration sometimes involves falling off unicycles.
      if (Math.abs(leanIn) > 0.85 && Math.abs(speed) > 8.5) wobble += dt * 1.1;
      else wobble = Math.max(0, wobble - dt * 0.8);
      if (wobble > 1 && !shot) {
        wobble = 0;
        fallen = 1.8;
        falls++;
        speed = 0;
        say(["Tech exploration sometimes involves falling off unicycles. Sand in everything."]);
      }
      const dist = speed * dt;
      px += Math.sin(heading) * dist;
      pz += Math.cos(heading) * dist;
      kmRidden += Math.abs(dist) / 1000;
      // The edge of the world: the sea to the west, the hills to the east.
      if (px < SEA_X + 6) {
        px = SEA_X + 6;
        speed = 0;
        say(["The Salton Sea. It smells like that. You do not ride in."]);
      }
      px = Math.max(-1150, Math.min(900, px));
      pz = Math.max(-1300, Math.min(1300, pz));
    }
    const groundY = groundHeight(px, pz);
    rider.group.position.set(px, groundY, pz);
    rider.group.rotation.y = heading;
    rider.update(dt, speed * dt, leanIn, tiltIn, speed, fallen, audio.musicOn());

    // ---- Sky, sun, night ------------------------------------------------------
    lerp4(skyTop, SKY_TOP, tod);
    lerp4(skyHor, SKY_HOR, tod);
    lerp4(sunCol, SUN_COL, tod);
    const daylight = tod < 2 / 3 ? Math.sin((tod / (2 / 3)) * Math.PI) : 0;
    const sunAngle = tod < 2 / 3 ? (tod / (2 / 3)) * Math.PI : Math.PI + ((tod - 2 / 3) / (1 / 3)) * Math.PI;
    // The sun rises over the mountains in the east and sets into the sea.
    tmp.set(Math.cos(sunAngle), Math.sin(sunAngle) * 0.9, -0.25).normalize();
    world.skyUniforms.sunDir.value.copy(tmp);
    sun.position.copy(tmp).multiplyScalar(500).add(rider.group.position);
    sun.target.position.copy(rider.group.position);
    sun.target.updateMatrixWorld();
    const night = tod >= 2 / 3 ? Math.sin(((tod - 2 / 3) / (1 / 3)) * Math.PI) : 0;

    // ---- Dust ------------------------------------------------------------------------
    const targetStorm = colony.storm ? 1 : 0;
    stormLevel += (targetStorm - stormLevel) * Math.min(1, dt * 0.12);
    const targetWall = colony.storm ? 1 : colony.stormWarning ? 0.55 * (0.4 + partT * 0.6) : 0;
    wallLevel += (targetWall - wallLevel) * Math.min(1, dt * 0.2);
    const wallMat = world.dustWall.material as THREE.MeshBasicMaterial;
    wallMat.opacity = Math.min(0.92, wallLevel * 0.9);
    // Far on the horizon while it is a warning; on top of you in the storm.
    const wallR = 1400 - stormLevel * 1330;
    world.dustWall.scale.set(wallR, 380 + stormLevel * 100, wallR);
    world.dustWall.position.set(px - (1 - stormLevel) * 500, groundY + 120, pz);
    const dustMat = world.dust.material as THREE.PointsMaterial;
    dustMat.opacity = stormLevel * 0.85;
    world.dust.visible = stormLevel > 0.02;
    if (world.dust.visible) {
      const p = world.dustPositions;
      const wind = dt * (14 + stormLevel * 10);
      for (let i = 0; i < p.length; i += 3) {
        p[i] += wind;
        p[i + 2] += wind * 0.35;
        if (p[i] > 45) p[i] -= 90;
        if (p[i + 2] > 45) p[i + 2] -= 90;
      }
      (world.dust.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      world.dust.position.set(px, groundY, pz);
    }
    audio.setStorm(stormLevel);

    // Colours: a warm pale day, a cold blue night, a brown storm.
    skyTop.lerp(DUST_COL, stormLevel * 0.9);
    skyHor.lerp(DUST_COL, stormLevel * 0.95);
    world.skyUniforms.top.value.copy(skyTop);
    world.skyUniforms.horizon.value.copy(skyHor);
    world.skyUniforms.sunColor.value.copy(sunCol).multiplyScalar((0.3 + daylight * 0.7) * (1 - stormLevel * 0.9));
    world.skyUniforms.haze.value = 0.25 + stormLevel * 0.7;
    fogColor.copy(skyHor);
    (scene.fog as THREE.FogExp2).color.copy(fogColor);
    (scene.fog as THREE.FogExp2).density = 0.00045 + stormLevel * 0.013 + night * 0.0003;
    renderer.setClearColor(fogColor, 1);
    sun.color.copy(sunCol);
    sun.intensity = (0.15 + daylight * 2.3) * (1 - stormLevel * 0.85) + night * 0.12;
    hemi.color.copy(skyTop).lerp(new THREE.Color(0xffffff), 0.3);
    hemi.groundColor.set(night > 0.2 ? 0x1a1c26 : 0x8a7a5a).lerp(DUST_COL, stormLevel * 0.6);
    hemi.intensity = 0.35 + daylight * 0.6 + night * 0.12;
    renderer.toneMappingExposure = 0.85 + daylight * 0.4 - night * 0.2 - stormLevel * 0.25;
    (world.stars.material as THREE.PointsMaterial).opacity = Math.max(0, night * 1.2 - 0.1) * (1 - stormLevel);
    world.sky.position.copy(camera.position);
    world.stars.position.copy(camera.position);
    world.stars.rotation.y = elapsed * 0.002;
    world.tableLight.intensity = night * 14 + (tod > 0.6 && tod < 2 / 3 ? 6 : 0);
    (world.bulbs.material as THREE.MeshBasicMaterial).color.setScalar(0.4 + night * 0.6).multiply(new THREE.Color(0xffd58a));
    world.dodeca.rotation.y += dt * 0.35;
    world.dodeca.rotation.x += dt * 0.12;

    // ---- The end: everything comes down --------------------------------------------
    if (phase === "teardown") {
      teardownT += dt;
      const total = 9;
      world.structures.forEach((s, i) => {
        const start = (i / world.structures.length) * (total - 3);
        const t = Math.max(0, Math.min(1, (teardownT - start) / 3));
        const k = 1 - t * t;
        s.scale.set(1, Math.max(0.001, k), 1);
        if (s === world.dodeca) s.position.y = groundHeight(placeById("research").x, placeById("research").z) + 0.5 + 5.7 * k;
        s.visible = t < 1;
      });
      if (teardownT > total) {
        phase = "done";
        card = colony.card ?? null;
        if (!card) card = { id: "last", title: "Last day", date: "3/28/25", lines: [verdict(colony).line] };
      }
    }

    // ---- Drills, all day, every day ------------------------------------------------
    drillIn -= dt;
    if (drillIn <= 0) {
      drillIn = 5 + Math.random() * 9;
      if (daylight > 0.1 && phase === "play" && !colony.storm) audio.drill();
    }

    // ---- Notes --------------------------------------------------------------------------
    if ((!note || elapsed > noteUntil) && noteQueue.length) {
      note = noteQueue.shift()!;
      noteUntil = elapsed + 3.2 + Math.min(4, note.length * 0.045);
    } else if (note && elapsed > noteUntil) {
      note = null;
    }

    // ---- Camera ----------------------------------------------------------------------------
    const yaw = heading + Math.PI + camYaw;
    const dist = shot ? 9 : 7.5;
    const pitchNow = shot ? 0.3 : camPitch;
    tmp.set(Math.sin(yaw) * Math.cos(pitchNow), Math.sin(pitchNow), Math.cos(yaw) * Math.cos(pitchNow));
    camGoal.copy(rider.group.position).addScaledVector(tmp, dist);
    camGoal.y = Math.max(camGoal.y, groundHeight(camGoal.x, camGoal.z) + 1.4);
    camPos.lerp(camGoal, Math.min(1, dt * 4));
    camera.position.copy(camPos);
    look.copy(rider.group.position);
    look.y += 1.4;
    look.x += Math.sin(heading) * 2;
    look.z += Math.cos(heading) * 2;
    camera.lookAt(look);

    renderer.render(scene, camera);

    // ---- Report ---------------------------------------------------------------------------
    stateClock += dt;
    if (stateClock > 0.1) {
      stateClock = 0;
      const place = phase === "play" ? currentPlace() : null;
      const v = verdict(colony);
      onState({
        day: colony.day,
        week: weekOf(colony.day),
        part: colony.part,
        partT,
        water: colony.water,
        power: colony.power,
        shelter: colony.shelter,
        connection: colony.connection,
        purpose: colony.purpose,
        parts: colony.parts,
        pullupBar: colony.pullupBar,
        storm: colony.storm,
        stormWarning: colony.stormWarning,
        stormLevel,
        speedKmh: Math.abs(speed) * 3.6,
        prompt: place ? { place: place.name, label: promptFor(colony, place).label } : null,
        note,
        card,
        phase,
        music: audio.musicOn(),
        fallen: fallen > 0,
        stats: {
          dinners: colony.stats.dinners,
          km: Math.round((colony.stats.km + kmRidden) * 10) / 10,
          kmRun: colony.stats.kmRun,
          storms: colony.stats.storms,
          waterRuns: colony.stats.waterRuns,
          hugs: colony.stats.hugs,
          builds: colony.stats.builds,
          falls,
          scorpions: colony.stats.scorpions,
        },
        grade: v.grade,
        verdict: v.line,
      });
    }
  };
  raf = requestAnimationFrame(tick);

  // A hook for the capture scripts: there is no other way to look at a dust
  // storm or a cold night without playing three weeks first.
  const debug = {
    set(opts: { part?: Part; partT?: number; storm?: boolean; warning?: boolean }) {
      if (opts.part) colony = { ...colony, part: opts.part };
      if (opts.partT !== undefined) partT = opts.partT;
      if (opts.storm !== undefined) {
        colony = { ...colony, storm: opts.storm };
        stormLevel = opts.storm ? 1 : 0;
        wallLevel = opts.storm ? 1 : 0;
      }
      if (opts.warning !== undefined) colony = { ...colony, stormWarning: opts.warning };
    },
    state: () => colony,
  };
  (window as unknown as { __mars?: typeof debug }).__mars = debug;

  return {
    stick,
    interact,
    sleep,
    toggleMusic,
    dismissCard() {
      card = null;
    },
    restart: reset,
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
      delete (window as unknown as { __mars?: typeof debug }).__mars;
      audio.dispose();
      rider.dispose();
      world.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (canvas.parentElement === container) container.removeChild(canvas);
    },
  };
}

export { DAYS };
