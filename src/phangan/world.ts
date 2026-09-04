/**
 * Flow Phangan: the engine.
 *
 * A scooter on a stylised Koh Phangan, a day that runs from four until half
 * past eight in eight real minutes, and six people to ferry to a meetup at a
 * secret location before the rain and before Muay Thai. The rules are in
 * `day.ts` and the bike is in `scooter.ts`; this file is what makes them
 * visible: it feeds them the frame, moves the meshes, points the camera and
 * reports a state object for the page to draw the HUD from.
 */
import * as THREE from "three";
import {
  CHECKPOINT,
  DOGS,
  GYM,
  MONKEY_BEARINGS,
  PAD_THAI_STOPS,
  ROAD_HALF_WIDTH,
  VILLA,
  coastRadius,
  dist2,
  isLand,
  nearestRoad,
  ringPoint,
  terrainHeight,
  type Vec2,
} from "./island";
import { headingOf, newScooter, stepScooter, SCOOTER, type ScooterInput, type ScooterState } from "./scooter";
import {
  DROP_RADIUS,
  action,
  checkpoint,
  clockLabel,
  dayProgress,
  dogBump,
  endDay,
  guestInReach,
  hit,
  isHeld,
  newDay,
  padThai,
  rainFront,
  summary,
  swerve,
  tick,
  type Beat,
  type Day,
  type DayPhase,
  type HitResult,
  type Summary,
} from "./day";
import { NARRATION } from "./dialogue";
import { buildBeacon, buildMonkeys, buildPerson, buildPin, buildScenery, buildScooter, newSkyFrame, skyFor, type Person, type Scenery } from "./scenery";
import { createPutter, type Putter } from "./audio";

export interface GuestView {
  name: string;
  colour: string;
  phase: "waiting" | "riding" | "delivered";
  spot: string;
  x: number;
  z: number;
}

export interface PhanganState {
  phase: DayPhase;
  clock: string;
  minute: number;
  progress: number;
  /** Fractions of the day at which the sun sets, the rain arrives and the bell rings. */
  sunsetAt: number;
  rainAt: number;
  energy: number;
  speedKmh: number;
  boosting: boolean;
  riding: { name: string; colour: string } | null;
  bubble: { name: string; colour: string; text: string } | null;
  note: string | null;
  placeName: string;
  pin: string;
  delivered: number;
  total: number;
  guests: GuestView[];
  nearGuest: string | null;
  atMeetup: boolean;
  nearPadThai: boolean;
  raining: boolean;
  rainHere: number;
  dark: boolean;
  held: boolean;
  checkpointNear: boolean;
  padThai: number;
  compass: { angle: number; distance: number; label: string } | null;
  player: { x: number; z: number; heading: number };
  place: Vec2;
  rainX: number;
  rhythm: { t: number; beats: Beat[] } | null;
  lastHit: { result: HitResult; at: number } | null;
  summary: Summary | null;
  seed: number;
}

export interface PhanganStick {
  /** -1..1 left to right. */
  x: number;
  /** -1..1, positive is throttle. */
  y: number;
  boost: boolean;
}

export interface PhanganWorld {
  readonly stick: PhanganStick;
  /** E: pick up or let off. */
  act(): void;
  /** A hit in the Muay Thai section. */
  hit(): void;
  restart(seed?: number): void;
  /** Skip to the bell. For people who have somewhere to be. */
  skipToBell(): void;
  dispose(): void;
}

export interface PhanganOptions {
  container: HTMLElement;
  onState: (s: PhanganState) => void;
  seed?: number;
  /** Card capture: Haad Yao at sunset, a passenger on the back, no rain yet. */
  shot?: boolean;
}

interface GuestBody {
  person: Person;
  pin: THREE.Group;
  bob: number;
}

interface Monkeys {
  group: THREE.Group;
  active: boolean;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  nextIn: number;
  warned: boolean;
}

const SUNSET_FRACTION = (18 * 60 + 35 - 16 * 60) / (20 * 60 + 30 - 16 * 60);

export function createPhangan(options: PhanganOptions): PhanganWorld {
  const { container, onState } = options;

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
  renderer.setClearColor(0x86cfee, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.touchAction = "none";

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xd6ecf6, 160, 900);
  const camera = new THREE.PerspectiveCamera(64, (container.clientWidth || 1) / (container.clientHeight || 1), 0.3, 5000);

  const scenery: Scenery = buildScenery();
  scene.add(scenery.group);

  const beacon = buildBeacon();
  scene.add(beacon);

  const scooterMesh = buildScooter();
  scene.add(scooterMesh.group);
  const rider = buildPerson("#f4f4f4", true);
  rider.group.position.copy(scooterMesh.seat);
  rider.group.scale.setScalar(0.92);
  scooterMesh.group.add(rider.group);

  const monkeys: Monkeys = {
    group: buildMonkeys(5),
    active: false,
    from: new THREE.Vector3(),
    to: new THREE.Vector3(),
    t: 0,
    nextIn: 20,
    warned: false,
  };
  monkeys.group.visible = false;
  scene.add(monkeys.group);

  // ---- Day and guests -----------------------------------------------------
  let seed = options.seed ?? Math.floor(Math.random() * 100000);
  let day: Day = newDay(seed);
  const bodies: GuestBody[] = day.guests.map((g) => {
    const person = buildPerson(g.def.colour);
    const pin = buildPin(g.def.colour);
    scene.add(person.group, pin);
    return { person, pin, bob: g.id * 1.3 };
  });

  let scooter: ScooterState = newScooter(0, 0, 0);
  let audio: Putter | null = null;
  let audioTried = false;
  let note: string | null = null;
  let noteUntil = 0;
  const noteQueue: string[] = [];
  let elapsed = 0;
  let lastPhase: DayPhase = "ride";
  let lastHit: PhanganState["lastHit"] = null;
  let beatsRung = 0;
  let punch = 0;
  let checkpointWarnedAt = -100;
  const dogWarnedAt = DOGS.map(() => -100);
  let rainHere = 0;
  const sky = newSkyFrame();

  const spawnAtVilla = () => {
    const road = nearestRoad(VILLA.pos.x, VILLA.pos.z);
    scooter = newScooter(road.point.x, road.point.z, headingOf(road.dir.x, road.dir.z));
  };

  const placeGuest = (i: number) => {
    const g = day.guests[i];
    const b = bodies[i];
    b.person.setColour(g.def.colour);
    (b.pin.userData.mat as THREE.MeshBasicMaterial).color.set(g.def.colour);
    if (g.phase === "riding") {
      if (b.person.group.parent !== scooterMesh.group) {
        scene.remove(b.person.group);
        scooterMesh.group.add(b.person.group);
      }
      b.person.group.position.copy(scooterMesh.pillion);
      b.person.group.rotation.set(0, 0, 0);
      b.person.group.scale.setScalar(0.9);
      b.pin.visible = false;
      return;
    }
    if (b.person.group.parent !== scene) {
      scooterMesh.group.remove(b.person.group);
      scene.add(b.person.group);
    }
    b.person.group.scale.setScalar(1);
    if (g.phase === "delivered") {
      // The party builds up around the flag.
      const k = day.guests.filter((x) => x.phase === "delivered" && x.id < g.id).length;
      const a = (k / 6) * Math.PI * 2 + 0.4;
      const x = day.place.pos.x + Math.cos(a) * 4.5;
      const z = day.place.pos.z + Math.sin(a) * 4.5;
      b.person.group.position.set(x, terrainHeight(x, z), z);
      b.person.group.rotation.y = Math.atan2(day.place.pos.x - x, day.place.pos.z - z);
      b.pin.visible = false;
      return;
    }
    // Waiting: stand just off the road, facing it.
    const road = nearestRoad(g.pos.x, g.pos.z);
    const side = road.dist < ROAD_HALF_WIDTH + 1 ? ROAD_HALF_WIDTH + 1.6 : 0;
    const px = -road.dir.z;
    const pz = road.dir.x;
    const x = side ? road.point.x + px * side : g.pos.x;
    const z = side ? road.point.z + pz * side : g.pos.z;
    b.person.group.position.set(x, terrainHeight(x, z), z);
    b.person.group.rotation.y = Math.atan2(-px, -pz);
    b.pin.visible = true;
    b.pin.position.set(x, terrainHeight(x, z) + 2.2, z);
  };

  const resetDay = (s: number) => {
    seed = s;
    day = newDay(seed);
    spawnAtVilla();
    for (let i = 0; i < bodies.length; i++) placeGuest(i);
    beacon.position.set(day.place.pos.x, terrainHeight(day.place.pos.x, day.place.pos.z), day.place.pos.z);
    note = null;
    noteQueue.length = 0;
    lastPhase = "ride";
    lastHit = null;
    beatsRung = 0;
    monkeys.active = false;
    monkeys.group.visible = false;
    monkeys.nextIn = 20;
    rider.group.position.copy(scooterMesh.seat);
    rider.group.rotation.set(0, 0, 0);
    if (rider.group.parent !== scooterMesh.group) {
      scene.remove(rider.group);
      scooterMesh.group.add(rider.group);
    }
    scooterMesh.group.visible = true;
    camPos.set(0, 0, 0);
    camInit = false;
  };

  // ---- Input ----------------------------------------------------------------
  const stick: PhanganStick = { x: 0, y: 0, boost: false };
  const keys = new Set<string>();
  const ensureAudio = () => {
    if (!audioTried) {
      audioTried = true;
      try {
        audio = createPutter();
      } catch {
        audio = null;
      }
    }
    audio?.resume();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    ensureAudio();
    if (e.repeat) return;
    keys.add(e.code);
    if (e.code === "KeyE" || e.code === "Enter") act();
    if (e.code === "KeyR") restart();
    if (day.phase === "muaythai" && ["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
      e.preventDefault();
      hitBeat();
    }
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  const onBlur = () => keys.clear();
  const onPointerDown = () => {
    ensureAudio();
    if (day.phase === "muaythai") hitBeat();
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

  const say = (text: string) => noteQueue.push(text);

  function act() {
    if (day.phase !== "ride") return;
    const before = day.riding;
    const r = action(day, { x: scooter.x, z: scooter.z });
    if (r === "nothing") return;
    audio?.click("pick");
    for (let i = 0; i < bodies.length; i++) placeGuest(i);
    if (r === "picked" && day.riding !== null) say(`${day.guests[day.riding].def.name} hops on the back.`);
    if (r === "delivered" && before !== null) say(`${day.guests[before].def.name} delivered. ${day.guests.filter((g) => g.phase === "delivered").length} of ${day.guests.length} at the meetup.`);
  }

  function hitBeat() {
    if (day.phase !== "muaythai") return;
    const r = hit(day);
    if (!r) return;
    lastHit = { result: r, at: elapsed };
    punch = 1;
    audio?.click(r);
  }

  function restart(s?: number) {
    resetDay(s ?? Math.floor(Math.random() * 100000));
  }

  // ---- Monkeys --------------------------------------------------------------
  const onNorthCoast = () => {
    const b = ((Math.atan2(scooter.x, -scooter.z) * 180) / Math.PI + 360) % 360;
    return b > 315 || b < 45;
  };
  const stepMonkeys = (dt: number) => {
    if (!monkeys.active) {
      monkeys.nextIn -= dt;
      if (monkeys.nextIn <= 0 && onNorthCoast() && Math.abs(scooter.speed) > 4 && day.phase === "ride") {
        // Pick the crossing on the ring road ahead of the rider.
        const ahead = { x: scooter.x + Math.sin(scooter.heading) * 45, z: scooter.z - Math.cos(scooter.heading) * 45 };
        let best = MONKEY_BEARINGS[0];
        let bestD = Infinity;
        for (const mb of MONKEY_BEARINGS) {
          const p = ringPoint(mb);
          const d = dist2(p, ahead);
          if (d < bestD) {
            bestD = d;
            best = mb;
          }
        }
        if (bestD < 60) {
          const p = ringPoint(best);
          const road = nearestRoad(p.x, p.z);
          const px = -road.dir.z;
          const pz = road.dir.x;
          monkeys.from.set(p.x + px * 9, terrainHeight(p.x + px * 9, p.z + pz * 9), p.z + pz * 9);
          monkeys.to.set(p.x - px * 9, terrainHeight(p.x - px * 9, p.z - pz * 9), p.z - pz * 9);
          monkeys.t = 0;
          monkeys.active = true;
          monkeys.warned = false;
          monkeys.group.visible = true;
          monkeys.group.rotation.y = Math.atan2(-px, -pz);
          say(NARRATION.monkeys);
        } else {
          monkeys.nextIn = 4;
        }
      }
      return;
    }
    monkeys.t += dt / 7;
    monkeys.group.position.lerpVectors(monkeys.from, monkeys.to, Math.min(1, monkeys.t));
    monkeys.group.position.y += Math.abs(Math.sin(elapsed * 9)) * 0.12;
    const d = Math.hypot(monkeys.group.position.x - scooter.x, monkeys.group.position.z - scooter.z);
    if (d < 5 && Math.abs(scooter.speed) > 11 && !monkeys.warned) {
      monkeys.warned = true;
      swerve(day);
      audio?.click("bump");
      scooter = { ...scooter, heading: scooter.heading + (Math.random() > 0.5 ? 0.45 : -0.45), vx: scooter.vx * 0.55, vz: scooter.vz * 0.55 };
    }
    if (monkeys.t >= 1) {
      monkeys.active = false;
      monkeys.group.visible = false;
      monkeys.nextIn = 22 + Math.random() * 20;
    }
  };

  // ---- Camera ---------------------------------------------------------------
  const camPos = new THREE.Vector3();
  const camGoal = new THREE.Vector3();
  const look = new THREE.Vector3();
  let camInit = false;

  // ---- Loop -----------------------------------------------------------------
  let raf = 0;
  let last = performance.now();
  let stateClock = 0;
  let disposed = false;

  resetDay(seed);
  if (options.shot) {
    // The north-west coast road, half an hour before sunset, heading for Haad Salad with the sun ahead over the sea.
    day.rainAt = 470;
    for (let t = 0; t < 222; t += 0.1) tick(day, 0.1, { climb: 0, boosting: false, speed: 0 });
    const p = ringPoint(328);
    const road = nearestRoad(p.x, p.z);
    const toSun = { x: -0.88, z: 0.48 };
    const fwd = road.dir.x * toSun.x + road.dir.z * toSun.z > 0 ? road.dir : { x: -road.dir.x, z: -road.dir.z };
    scooter = { ...newScooter(road.point.x, road.point.z, headingOf(fwd.x, fwd.z)), speed: 12, vx: fwd.x * 12, vz: fwd.z * 12 };
    day.guests[0].pos = { x: scooter.x, z: scooter.z };
    action(day, { x: scooter.x, z: scooter.z });
    for (let i = 0; i < bodies.length; i++) placeGuest(i);
    camInit = false;
  }

  const tickFrame = (now: number) => {
    raf = requestAnimationFrame(tickFrame);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    elapsed += dt;

    // Input.
    let throttle = stick.y;
    let lean = stick.x;
    if (keys.has("KeyW") || keys.has("ArrowUp")) throttle = 1;
    if (keys.has("KeyS") || keys.has("ArrowDown")) throttle = -1;
    if (keys.has("KeyA") || keys.has("ArrowLeft")) lean = -1;
    if (keys.has("KeyD") || keys.has("ArrowRight")) lean = 1;
    const boost = stick.boost || keys.has("ShiftLeft") || keys.has("ShiftRight");
    const input: ScooterInput = { throttle, lean, boost: boost && day.energy > 0 };

    // Where the front wheel is: road, grade, wet.
    const road = nearestRoad(scooter.x, scooter.z);
    const onRoad = road.dist <= (road.road?.steep ? ROAD_HALF_WIDTH * 0.8 : ROAD_HALF_WIDTH) + 0.7;
    const dirX = Math.sin(scooter.heading);
    const dirZ = -Math.cos(scooter.heading);
    const hAhead = terrainHeight(scooter.x + dirX * 2.5, scooter.z + dirZ * 2.5);
    const hBehind = terrainHeight(scooter.x - dirX * 2.5, scooter.z - dirZ * 2.5);
    const grade = (hAhead - hBehind) / 5;
    const wallX = 900 - rainFront(day) * 1700;
    rainHere = Math.max(0, Math.min(1, (wallX < 900 ? (scooter.x - wallX + 40) / 80 : 0)));
    if (day.raining) rainHere = 1;

    const riding = day.phase === "ride";
    if (riding) {
      scooter = stepScooter(scooter, input, { onRoad, wet: rainHere > 0.5, grade, energy: day.energy, held: isHeld(day) }, dt);
      // The sea is not a road. Turn the bike round at the waterline.
      if (!isLand(scooter.x, scooter.z) || terrainHeight(scooter.x, scooter.z) < 0.25) {
        const th = Math.atan2(scooter.z, scooter.x);
        const r = coastRadius(th) - 4;
        scooter = { ...scooter, x: Math.cos(th) * r, z: Math.sin(th) * r, vx: scooter.vx * 0.2, vz: scooter.vz * 0.2 };
      }
      tick(day, dt, { climb: Math.max(0, grade), boosting: input.boost, speed: scooter.speed });
      if (Math.abs(scooter.speed) < 8) {
        if (padThai(day, { x: scooter.x, z: scooter.z })) audio?.click("eat");
      }
      if (day.riding !== null && dist2(CHECKPOINT.pos, scooter) < 9) {
        if (checkpoint(day)) audio?.click("bump");
      }
      if (day.riding !== null && dist2(CHECKPOINT.pos, scooter) < 70 && elapsed - checkpointWarnedAt > 40) {
        checkpointWarnedAt = elapsed;
        say(NARRATION.checkpointWarn);
      }
      for (let i = 0; i < DOGS.length; i++) {
        const d = dist2(DOGS[i], scooter);
        if (d < 28 && Math.abs(scooter.speed) > 9 && elapsed - dogWarnedAt[i] > 30) {
          dogWarnedAt[i] = elapsed;
          say(NARRATION.dog);
        }
        if (d < 1.8 && Math.abs(scooter.speed) > 3) {
          dogBump(day);
          audio?.click("bump");
          scooter = { ...scooter, vx: scooter.vx * 0.25, vz: scooter.vz * 0.25, x: scooter.x - dirX * 1.2, z: scooter.z - dirZ * 1.2 };
        }
      }
      stepMonkeys(dt);
    } else {
      tick(day, dt, { climb: 0, boosting: false, speed: 0 });
    }

    // Phase changes.
    if (day.phase !== lastPhase) {
      if (day.phase === "muaythai") {
        // Off the bike, into the ring.
        for (let i = 0; i < bodies.length; i++) placeGuest(i);
        scooterMesh.group.remove(rider.group);
        scene.add(rider.group);
        const gy = terrainHeight(GYM.pos.x, GYM.pos.z) + 0.6;
        rider.group.position.set(GYM.pos.x, gy, GYM.pos.z);
        rider.group.rotation.y = 0.3 + Math.PI / 2;
        const road = nearestRoad(GYM.pos.x, GYM.pos.z);
        scooter = { ...newScooter(road.point.x, road.point.z, headingOf(road.dir.x, road.dir.z)), speed: 0 };
        audio?.bell();
        audio?.engine(0, 0);
        camInit = false;
      }
      lastPhase = day.phase;
    }

    // Narration queue.
    while (day.notes.length) noteQueue.push(day.notes.shift()!);
    if (note && elapsed > noteUntil) note = null;
    if (!note && noteQueue.length) {
      note = noteQueue.shift()!;
      noteUntil = elapsed + (noteQueue.length ? 3.2 : 4.8);
    }

    // Beats: a click on each beat, so you can hear where it is.
    if (day.phase === "muaythai" && day.rhythm) {
      while (beatsRung < day.rhythm.beats.length && day.rhythm.t >= day.rhythm.beats[beatsRung].at) {
        beatsRung++;
        audio?.click("good");
      }
    }
    punch = Math.max(0, punch - dt * 4);

    // ---- Place the scooter -------------------------------------------------
    const groundY = terrainHeight(scooter.x, scooter.z) + (onRoad ? 0.24 : 0);
    scooterMesh.group.position.set(scooter.x, groundY, scooter.z);
    scooterMesh.group.rotation.set(Math.atan(grade), -scooter.heading, -scooter.lean, "YXZ");
    for (const w of scooterMesh.wheels) w.rotation.x = -scooter.wheelSpin;
    if (day.phase === "ride") {
      // The rider leans a little more than the bike, and hunches on the throttle.
      rider.group.rotation.z = -scooter.lean * 0.4;
      rider.group.rotation.x = throttle > 0 ? 0.12 : 0;
      rider.group.position.y = scooterMesh.seat.y + (Math.abs(scooter.speed) > 1 && !onRoad ? Math.abs(Math.sin(elapsed * 22)) * 0.03 : 0);
    } else {
      // Shadow-boxing in the ring, and a punch when you hit.
      rider.group.position.y = terrainHeight(GYM.pos.x, GYM.pos.z) + 0.6 + Math.abs(Math.sin(elapsed * 5)) * 0.05;
      rider.group.rotation.y = 0.3 + Math.PI / 2 + Math.sin(elapsed * 2.5) * 0.25 - punch * 0.6;
      rider.group.rotation.x = -punch * 0.25;
    }
    const night = sky.night;
    scooterMesh.headlight.intensity = Math.max(night, rainHere * 0.5) * 900 * (day.phase === "ride" ? 1 : 0);
    (scooterMesh.lamp.material as THREE.MeshLambertMaterial).emissiveIntensity = Math.max(night, rainHere * 0.5);
    (beacon.getObjectByName("beaconLight") as THREE.PointLight).intensity = 40 + night * 200;
    beacon.rotation.y = elapsed * 0.6;

    // Guests idle.
    for (let i = 0; i < bodies.length; i++) {
      const g = day.guests[i];
      const b = bodies[i];
      if (g.phase === "waiting") {
        b.pin.position.y = terrainHeight(b.person.group.position.x, b.person.group.position.z) + 2.2 + Math.sin(elapsed * 2 + b.bob) * 0.18;
        b.pin.rotation.y = elapsed * 1.5;
        b.person.group.position.y = terrainHeight(b.person.group.position.x, b.person.group.position.z) + Math.abs(Math.sin(elapsed * 1.6 + b.bob)) * 0.02;
      } else if (g.phase === "riding") {
        b.person.group.rotation.z = -scooter.lean * 0.5;
      } else {
        // At the bar, dancing a bit.
        b.person.group.position.y = terrainHeight(b.person.group.position.x, b.person.group.position.z) + Math.abs(Math.sin(elapsed * 3 + b.bob)) * 0.06;
      }
    }

    // ---- Sky and weather ----------------------------------------------------
    skyFor(day.minute, rainHere, sky);
    renderer.setClearColor(sky.sky, 1);
    const fog = scene.fog as THREE.Fog;
    fog.color.copy(sky.fog);
    const fogNear = 160 - rainHere * 110;
    const fogFar = 900 - rainHere * 560 - night * 250;
    fog.near += (fogNear - fog.near) * Math.min(1, dt * 0.8);
    fog.far += (fogFar - fog.far) * Math.min(1, dt * 0.8);
    renderer.toneMappingExposure = 1.0 - night * 0.25;
    scenery.update(dt, camera, sky, rainHere, wallX);

    // ---- Camera ---------------------------------------------------------------
    if (day.phase === "ride") {
      const back = 7.5 + Math.abs(scooter.speed) * 0.09;
      camGoal.set(scooter.x - dirX * back, groundY + 3.1 + Math.abs(scooter.speed) * 0.02, scooter.z - dirZ * back);
      camGoal.y = Math.max(camGoal.y, terrainHeight(camGoal.x, camGoal.z) + 1.6);
      if (!camInit) {
        camPos.copy(camGoal);
        camInit = true;
      }
      camPos.lerp(camGoal, Math.min(1, dt * 5));
      camera.position.copy(camPos);
      look.set(scooter.x + dirX * 6, groundY + 1.2, scooter.z + dirZ * 6);
      camera.lookAt(look);
      camera.rotation.z += -scooter.lean * 0.35;
    } else {
      const gy = terrainHeight(GYM.pos.x, GYM.pos.z);
      const a = elapsed * 0.25;
      camGoal.set(GYM.pos.x + Math.cos(a) * 9, gy + 3.2, GYM.pos.z + Math.sin(a) * 9);
      if (!camInit) {
        camPos.copy(camGoal);
        camInit = true;
      }
      camPos.lerp(camGoal, Math.min(1, dt * 2));
      camera.position.copy(camPos);
      camera.lookAt(GYM.pos.x, gy + 1.5, GYM.pos.z);
    }

    // ---- Audio ------------------------------------------------------------------
    if (audio) {
      if (day.phase === "ride") audio.engine(Math.abs(scooter.speed) / SCOOTER.maxSpeed, Math.max(0, throttle));
      else audio.engine(0, 0);
      audio.rain(rainHere);
    }

    renderer.render(scene, camera);

    // ---- Report ---------------------------------------------------------------
    stateClock += dt;
    if (stateClock > 0.1) {
      stateClock = 0;
      const pos = { x: scooter.x, z: scooter.z };
      const near = guestInReach(day, pos);
      let target: Vec2 | null = null;
      let label = "";
      if (day.riding !== null) {
        target = day.place.pos;
        label = day.place.name;
      } else {
        let bestD = Infinity;
        for (const g of day.guests) {
          if (g.phase !== "waiting") continue;
          const d = dist2(g.pos, pos);
          if (d < bestD) {
            bestD = d;
            target = g.pos;
            label = `${g.def.name} at ${g.spot}`;
          }
        }
        if (!target && day.guests.some((g) => g.phase === "delivered")) {
          target = day.place.pos;
          label = day.place.name;
        }
      }
      let compass: PhanganState["compass"] = null;
      if (target) {
        const b = headingOf(target.x - scooter.x, target.z - scooter.z);
        let rel = b - scooter.heading;
        rel = Math.atan2(Math.sin(rel), Math.cos(rel));
        compass = { angle: rel, distance: dist2(target, pos), label };
      }
      const ridingGuest = day.riding !== null ? day.guests[day.riding] : null;
      let nearPadThai = false;
      for (const s of PAD_THAI_STOPS) if (dist2(s.pos, pos) < 30) nearPadThai = true;
      onState({
        phase: day.phase,
        clock: clockLabel(day.minute),
        minute: day.minute,
        progress: dayProgress(day),
        sunsetAt: SUNSET_FRACTION,
        rainAt: day.rainAt / 480,
        energy: day.energy,
        speedKmh: Math.abs(scooter.speed) * 3.6,
        boosting: input.boost,
        riding: ridingGuest ? { name: ridingGuest.def.name, colour: ridingGuest.def.colour } : null,
        bubble: day.bubble ? { name: day.bubble.name, colour: day.bubble.colour, text: day.bubble.text } : null,
        note,
        placeName: day.place.name,
        pin: day.place.pin,
        delivered: day.guests.filter((g) => g.phase === "delivered").length,
        total: day.guests.length,
        guests: day.guests.map((g) => ({ name: g.def.name, colour: g.def.colour, phase: g.phase, spot: g.spot, x: g.pos.x, z: g.pos.z })),
        nearGuest: near ? near.def.name : null,
        atMeetup: dist2(day.place.pos, pos) <= DROP_RADIUS,
        nearPadThai,
        raining: day.raining,
        rainHere,
        dark: day.dark,
        held: isHeld(day),
        checkpointNear: day.riding !== null && dist2(CHECKPOINT.pos, pos) < 70,
        padThai: day.padThai,
        compass,
        player: { x: scooter.x, z: scooter.z, heading: scooter.heading },
        place: day.place.pos,
        rainX: wallX,
        rhythm: day.rhythm && day.phase !== "ride" ? { t: day.rhythm.t, beats: day.rhythm.beats.map((b) => ({ ...b })) } : null,
        lastHit: lastHit && elapsed - lastHit.at < 0.8 ? lastHit : null,
        summary: day.phase === "done" ? summary(day) : null,
        seed,
      });
    }
  };
  raf = requestAnimationFrame(tickFrame);

  // A debug hook, in the spirit of window.__sf: the sandbox renders this at
  // about a frame a second, so the only way to see the sunset, the rain or the
  // bell is to jump the day forward and look.
  const debug = {
    jump(seconds: number) {
      for (let t = 0; t < seconds; t += 0.1) tick(day, 0.1, { climb: 0, boosting: false, speed: 0 });
    },
    rain() {
      day.rainAt = Math.min(day.rainAt, day.t + 1);
    },
    bell() {
      endDay(day);
    },
    teleport(x: number, z: number, heading = 0) {
      scooter = { ...newScooter(x, z, heading) };
      camInit = false;
    },
    day: () => day,
  };
  (window as unknown as { __phangan?: typeof debug }).__phangan = debug;

  return {
    stick,
    act,
    hit: hitBeat,
    restart,
    skipToBell() {
      if (day.phase === "ride") endDay(day);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      delete (window as unknown as { __phangan?: typeof debug }).__phangan;
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onPointerDown);
      audio?.dispose();
      scenery.dispose();
      for (const root of [beacon, scooterMesh.group, monkeys.group, rider.group, ...bodies.flatMap((b) => [b.person.group, b.pin])]) {
        root.traverse((o) => {
          const m = o as THREE.Mesh;
          m.geometry?.dispose();
          const mat = m.material as THREE.Material | THREE.Material[] | undefined;
          const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
          for (const x of mats) x.dispose();
        });
      }
      renderer.dispose();
      renderer.forceContextLoss();
      if (canvas.parentElement === container) container.removeChild(canvas);
    },
  };
}
