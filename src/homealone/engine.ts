/**
 * The engine: renderer, camera, the boy, the clock, and the loop that ties the
 * house to the two men walking round it.
 *
 * Three decisions worth stating, because everything else follows from them.
 *
 * **It is third person.** Home Alone is a film about watching a small child do
 * something enormous, and a first-person camera throws that away — you would
 * never once see the sweater, the bowl cut, or him legging it down a corridor
 * two sizes too big for him. The cost is a camera that has to survive being
 * indoors, which `settleCamera` pays for by pulling the boom in whenever a
 * wall gets between the lens and his head.
 *
 * **Height is a query, not a state.** There is no "which floor am I on" flag.
 * `groundAt` takes the highest floor slab or stair ramp beneath you that is
 * within a step of your feet, and that is the entire multi-storey system. Walk
 * off the landing and the ground under you becomes the hall floor, so you fall
 * into it; walk up the flight and the ramp lifts you. Nothing switches.
 *
 * **The burglars run on the same floor you do.** They path the nav graph, they
 * climb the same ramps, and their footsteps are attenuated by real distance.
 * When you hear one upstairs, one is upstairs.
 */
import * as THREE from "three";
import { line as banterLine, resetBanter } from "./banter";
import { twinkle } from "./christmas";
import { buildTraps, type TrapRig } from "./traps";
import { Burglar, clearLine, spawnPoint } from "./ai";
import { buildWorld, type BuiltWorld, type Collider } from "./build";
import { HomeAudio } from "./audio";
import { makeCharacter, type Character } from "./characters";
import {
  CEILING,
  FLOOR,
  ROOMS,
  STREET,
  TRAPS,
  TREEHOUSE,
  ZIP_END,
  ZIP_START,
  roomAt,
  type Ramp,
  type RoomId,
  type TrapKind,
} from "./house";
import { LEVELS, LEVEL_COUNT, ROOM_LINES, levelByNumber, type Level } from "./levels";
import * as T from "./textures";

export type Phase = "menu" | "brief" | "playing" | "won" | "lost" | "outro";

export interface TrapState {
  kind: TrapKind;
  name: string;
  /** Kevin's line when he sets it. */
  quip: string;
  armed: boolean;
  spent: boolean;
  room: string;
}

export interface BurglarState {
  who: "harry" | "marv";
  nerve: number;
  state: string;
  down: boolean;
  /** What he is shouting, if anything. */
  says: string | null;
}

export interface Snapshot {
  phase: Phase;
  level: number;
  title: string;
  quote: string;
  brief: string[];
  goal: string;
  kind: Level["kind"];
  /** Where you are, by name. */
  room: string;
  /** The action button's label right now, or null when there is nothing to do. */
  action: string | null;
  /** Kevin's most recent line. */
  say: string | null;
  /** A big banner: "CAUGHT", "THEY'RE GONE", that sort of thing. */
  banner: string | null;
  timeLeft: number | null;
  /** Objective progress, whatever the level counts. */
  done: number;
  total: number;
  traps: TrapState[];
  burglars: BurglarState[];
  /** Bearing to the objective, relative to where the camera is looking. */
  compass: number | null;
  compassLabel: string | null;
  compassDist: number;
  /** 0 … 1. Drives the heartbeat and the vignette. */
  danger: number;
  /** Level 2's meter. */
  suspicion: number;
  /** 0 … 1 while a burglar has hold of you. */
  caught: number;
  running: boolean;
  cleared: number;
  /** Kevin has been to Buzz's room and taken the BB gun. */
  hasBB: boolean;
  ammo: number;
  /** 0 when the shout is ready, otherwise seconds left. */
  tauntCooldown: number;
  /** True while Old Man Marley is on screen doing something about it. */
  marley: boolean;
}

const STEP_UP = 0.62;
const PLAYER_R = 0.26;
const GRAVITY = 20;

interface Interactable {
  id: string;
  kind: "switch" | "trap" | "zip" | "rope" | "bb";
  label: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  room?: RoomId;
  trap?: TrapKind;
  done?: boolean;
}

/** Where each room's light switch lives — by the door, at hand height. */
const SWITCHES: Partial<Record<RoomId, [number, number]>> = {
  /*
   * No two switches within 1.6 m of each other — including through a wall.
   *
   * The prompt names the room it will light, but a pair 70 cm apart on either
   * side of a partition still means the one you walk up to is a coin toss, and
   * level 2 is nothing but walking up to switches. Two of these pairs were
   * close enough that lighting the seventh room turned the sixth back off.
   */
  hall: [1.7, 2.4],
  stairbay: [-1.9, 4.9],
  living: [2.35, 4.4],
  den: [-3.95, 2.0],
  midhall: [0.95, 0.35],
  dining: [2.25, -1.6],
  family: [-1.75, -1.6],
  kitchen: [-1.2, -3.2],
  backhall: [-3.0, -3.0],
  corridor: [-2.0, 0.15],
  bathroom: [-4.6, 0.65],
  kevin: [1.0, 0.65],
  parents: [3.9, 0.65],
  buzz: [3.4, -1.45],
  guest: [-2.5, -1.45],
  basement: [0.55, -1.5],
};

export class HomeAloneEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private world: BuiltWorld;
  private traps: TrapRig;
  private audio = new HomeAudio();
  private kevin: Character;
  private burglars: Burglar[] = [];
  private clock = new THREE.Clock();
  private raf = 0;
  private disposed = false;
  private listeners = new Set<(s: Snapshot) => void>();
  private emitAt = 0;

  /* ---- player ------------------------------------------------------- */
  private pos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private yaw = 0;
  private grounded = true;
  private speed = 0;
  private stepPhase = 0;

  /* ---- camera ------------------------------------------------------- */
  private camYaw = 0;
  private camPitch = -0.13;
  private camDist = 3.1;
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();

  /* ---- input -------------------------------------------------------- */
  private keys = new Set<string>();
  private stick = { x: 0, y: 0 };
  private sprintHeld = false;
  private actionQueued = false;
  private pointerLocked = false;
  private dragging: number | null = null;
  private dragLast = { x: 0, y: 0 };

  /* ---- level state --------------------------------------------------- */
  private phase: Phase = "menu";
  private level: Level = LEVELS[0];
  private levelTime = 0;
  private beaconsHit = new Set<string>();
  private interactables: Interactable[] = [];
  private armed = new Set<TrapKind>();
  private say: string | null = null;
  private sayUntil = 0;
  private banner: string | null = null;
  private bannerUntil = 0;
  private caught = 0;
  private caughtBy: Burglar | null = null;
  private suspicion = 0;
  private vanT = 0;
  private vanActive = false;
  private danger = 0;
  private lastChatter = 0;
  /** Seconds at the start of a fight during which they cannot see you. */
  private grace = 0;
  private zipRide = -1;
  private ropeCut = false;
  private outroT = 0;
  private muted = false;
  private cleared = 0;
  private nearest: Interactable | null = null;
  /* ---- Kevin's kit -------------------------------------------------- */
  private hasBB = false;
  private ammo = 0;
  private tauntCd = 0;
  private muzzle = 0;
  /* ---- Old Man Marley ----------------------------------------------- */
  private marley: Character | null = null;
  private marleyT = 0;
  private marleyActive = false;
  private marleyUsed = false;
  private marleyShowUntil = 0;
  private compassTarget: { x: number; y: number; z: number; label: string } | null = null;
  private time = 0;
  private tvFrame = -1;
  /**
   * Frames rendered. Public for `tools/homealone-play.mjs`, which has to wait
   * for the world to actually tick between teleporting and pressing a key —
   * on a software renderer a fixed millisecond wait is sometimes less than one
   * frame, and the test then presses against a stale prompt and toggles a room
   * two rooms away. Waiting on this number cannot go wrong at any frame rate.
   */
  frames = 0;
  /**
   * Boom length override for the capture harness (`tools/homealone-shot.mjs`).
   * Null in play. It exists because checking a face at 2.85 m is checking a
   * thumbnail, and every character bug found so far was found by pulling in.
   */
  shotDist: number | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: window.devicePixelRatio < 2,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.97;

    this.camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.06, 400);

    // A winter night: deep blue overhead, sodium haze at the horizon, and fog
    // thick enough that the block ends before the world does.
    this.scene.background = new THREE.Color(0x0d1524);
    this.scene.fog = new THREE.FogExp2(0x101a2c, 0.017);
    {
      const skyGeo = new THREE.SphereGeometry(180, 24, 16);
      const skyMat = new THREE.MeshBasicMaterial({ map: T.nightSky(), side: THREE.BackSide, fog: false });
      const sky = new THREE.Mesh(skyGeo, skyMat);
      this.scene.add(sky);
    }

    // Moonlight and sky bounce. Both are deliberately generous for "night":
    // a real winter night over snow is far from black — the ground throws
    // light back up, and a house you cannot see the shape of is not scary,
    // it is just a dark screen.
    /*
     * Moonlight and sky bounce, both kept deliberately low.
     *
     * Nothing here casts shadows — sixteen rooms of shadow maps is not a thing
     * a phone will do — which means a generous directional light shines
     * straight through the roof and lights every interior as if the house had
     * no lid. The first build did exactly that, and every room came out flat
     * and daylit. So the sky is barely there, and the inside of the house is
     * lit entirely by its own bulbs, its fire and its tree. That is also the
     * right answer artistically: the contrast between a warm lit room and a
     * blue-black one is the entire look.
     */
    const moon = new THREE.DirectionalLight(0xa8c8f2, 0.34);
    moon.position.set(-40, 60, 34);
    this.scene.add(moon);
    this.scene.add(new THREE.HemisphereLight(0x8098bc, 0x262a36, 0.22));
    this.scene.add(new THREE.AmbientLight(0x415067, 0.35));

    this.world = buildWorld(this.scene);
    this.traps = buildTraps(this.world.root);

    this.kevin = makeCharacter("kevin");
    this.scene.add(this.kevin.root);

    /*
     * Old Man Marley. He shovels the pavement in the quiet levels and he is
     * *meant* to be alarming there — a tall stooped shape with a snow shovel
     * that Kevin runs away from. In the last level he is the one who turns up
     * when they finally have hold of you, which only works because you have
     * spent four levels being frightened of him.
     */
    this.marley = makeCharacter("marley");
    this.marley.setProp(true);
    this.marley.root.visible = false;
    this.scene.add(this.marley.root);

    this.burglars = [new Burglar("harry"), new Burglar("marv")];
    for (const b of this.burglars) {
      this.scene.add(b.char.root);
      b.char.root.visible = false;
    }

    this.bindInput(canvas);
    try {
      this.cleared = Number(localStorage.getItem("homealone:cleared") ?? "0") || 0;
    } catch {
      this.cleared = 0;
    }
    this.setLevelLights(LEVELS[0]);
    this.pos.set(0.4, 0, 12.0);
    this.camYaw = Math.PI;
  }

  /* ================================================================== *
   * Public API
   * ================================================================== */

  on(fn: (s: Snapshot) => void) {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  start() {
    this.clock.start();
    const loop = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, this.clock.getDelta());
      this.time += dt;
      this.frames++;
      this.tick(dt);
      this.renderer.render(this.scene, this.camera);
      if (this.time > this.emitAt) {
        this.emitAt = this.time + 0.09;
        this.emit();
      }
    };
    this.raf = requestAnimationFrame(loop);
  }

  resize() {
    const c = this.renderer.domElement;
    const w = c.clientWidth || window.innerWidth;
    const h = c.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  setMuted(m: boolean) {
    this.muted = m;
    this.audio.setMuted(m);
  }

  isMuted() {
    return this.muted;
  }

  /** Show the brief for a level. `begin()` starts it for real. */
  select(n: number) {
    this.level = levelByNumber(n);
    this.phase = "brief";
    this.audio.resume();
    this.audio.playMusic("home", 0.35);
    this.setupLevel(this.level, false);
    this.emit();
  }

  begin() {
    if (this.phase !== "brief") return;
    this.setupLevel(this.level, true);
    this.phase = "playing";
    this.audio.resume();
    this.audio.startAmbience();
    this.audio.playMusic(this.level.kind === "battle" || this.level.kind === "escape" ? "bells" : null, 0.34);
    this.emit();
  }

  retry() {
    this.select(this.level.n);
    this.begin();
  }

  next() {
    const n = Math.min(LEVEL_COUNT, this.level.n + 1);
    this.select(n);
  }

  toMenu() {
    this.phase = "menu";
    this.audio.playMusic("home", 0.35);
    this.emit();
  }

  /* ---- input surface used by the touch HUD --------------------------- */

  setStick(x: number, y: number) {
    this.stick.x = x;
    this.stick.y = y;
  }

  look(dx: number, dy: number) {
    this.camYaw -= dx;
    this.camPitch = clamp(this.camPitch - dy, -0.95, 0.62);
  }

  setSprint(on: boolean) {
    this.sprintHeld = on;
  }

  act() {
    this.actionQueued = true;
  }

  /**
   * Shout at them.
   *
   * This is the mechanic the whole battle turns on. You cannot fight them and
   * you cannot outrun them — what you *can* do is stand at the top of the
   * stairs where the paint cans are, yell, and make them come to you. Without
   * it, leading two men onto eight specific spots is a matter of luck; with
   * it, it is a plan. It is also the single most quoted thing in the film,
   * which is not a coincidence.
   */
  taunt() {
    if (this.phase !== "playing" || this.tauntCd > 0 || this.caught > 0) return;
    this.tauntCd = 5.5;
    const l = banterLine("kevin", "taunt");
    if (l) this.speak(l, 3.2);
    this.audio.scream();
    // Heard through walls, through floors, from anywhere in the house.
    for (const b of this.burglars) b.hear(this.pos.x, this.pos.y, this.pos.z, 60);
  }

  /**
   * Fire the BB gun.
   *
   * It never knocks anybody down — see `Burglar.sting`. A gun that solved the
   * problem would replace the traps, and the traps are the game; this buys a
   * second and a half and a very satisfying noise.
   */
  fire() {
    if (this.phase !== "playing" || !this.hasBB || this.ammo <= 0 || this.caught > 0) return;
    this.ammo--;
    this.muzzle = 1;
    this.audio.bb();
    const eye = this.pos.clone();
    eye.y += 1.0;
    let best: Burglar | null = null;
    let bestD = 15;
    for (const b of this.burglars) {
      if (b.state === "gone") continue;
      const dx = b.pos.x - this.pos.x;
      const dz = b.pos.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > bestD) continue;
      let diff = Math.atan2(dx, dz) - this.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      if (Math.abs(diff) > 0.4) continue;
      const target = b.pos.clone();
      target.y += b.char.eyeY * 0.7;
      if (!clearLine(eye, target, this.world.colliders)) continue;
      best = b;
      bestD = d;
    }
    if (best?.sting(this.time)) {
      this.flash("HIT", 1.1);
      // The other one hears it and comes looking.
      for (const o of this.burglars) if (o !== best) o.hear(best.pos.x, best.pos.y, best.pos.z, 20);
    }
  }

  /* ================================================================== *
   * Level setup
   * ================================================================== */

  private setLevelLights(level: Level) {
    for (const id of Object.keys(ROOMS) as RoomId[]) {
      const on = level.lit === "all" ? true : level.lit === "none" ? false : level.lit.includes(id);
      this.world.setRoomLight(id, on);
    }
  }

  private setupLevel(level: Level, live: boolean) {
    this.setLevelLights(level);
    this.beaconsHit.clear();
    this.suspicion = 0;
    this.vanT = 0;
    this.vanActive = level.kind === "lights";
    this.caught = 0;
    this.caughtBy = null;
    this.danger = 0;
    this.zipRide = -1;
    this.ropeCut = false;
    this.outroT = 0;
    this.say = null;
    this.banner = null;
    this.levelTime = level.time ?? 0;
    this.kevin.setScream(false);

    this.pos.set(level.spawn.x, level.spawn.y + 0.05, level.spawn.z);
    this.vel.set(0, 0, 0);
    this.yaw = level.spawn.yaw;
    this.camYaw = level.spawn.yaw;
    this.camPitch = -0.13;
    this.kevin.root.visible = true;

    /* Traps. Level 3 arms them; level 4 inherits whatever level 3 left; level 5
       starts with the lot spent, because that is the premise of level 5. */
    resetBanter();
    this.hasBB = false;
    this.ammo = 0;
    this.tauntCd = 0;
    this.kevin.setProp(false);
    this.marleyUsed = false;
    this.marleyShowUntil = 0;
    // He shovels his path on the quiet nights and turns up on the loud one.
    this.marleyActive = level.kind === "explore" || level.kind === "lights" || level.kind === "traps" || level.kind === "roam";
    this.marleyT = 0;
    if (this.marley) this.marley.root.visible = this.marleyActive;

    this.traps.reset();
    if (level.kind === "traps") {
      this.armed.clear();
    } else if (level.kind === "battle") {
      if (!this.armed.size) {
        // Straight into the battle from the menu — hand out a fair starting set
        // rather than an empty house, which is unplayable and not a lesson.
        for (const k of ["cars", "paint", "iron", "ornaments", "torch"] as TrapKind[]) this.armed.add(k);
      }
      for (const k of this.armed) this.traps.arm(k, true);
    } else if (level.kind === "escape") {
      this.armed.clear();
    }

    /* Burglars. */
    for (const b of this.burglars) {
      b.char.root.visible = false;
      b.state = "gone";
    }
    /*
     * Three and a half seconds before either of them can see you.
     *
     * Harry comes in the front door and Kevin starts in the hall; without this
     * the level opens with a man already sprinting at you from four metres,
     * before you have found the run button. The grace is the beat where you
     * hear the door and decide where to go, which is the beat the film is
     * actually built on.
     */
    this.grace = level.kind === "battle" || level.kind === "escape" ? 3.5 : 0;
    if (live && (level.kind === "battle" || level.kind === "escape")) {
      const h = spawnPoint("front", "harry");
      const m = spawnPoint("back", "marv");
      this.burglars[0].spawn(h.x, h.y, h.z, h.yaw);
      this.burglars[1].spawn(m.x, m.y, m.z, m.yaw);
      if (level.kind === "escape") for (const b of this.burglars) b.nerve = 100;
    }

    this.world.van.visible = level.kind === "lights" || level.kind === "battle" || level.kind === "escape";
    this.world.van.position.set(level.kind === "lights" ? -40 : -2, 0, STREET.centre - 1.2);
    this.world.zip.visible = level.kind === "escape" || level.kind === "roam";

    this.buildInteractables(level);
    this.settleCamera(0.999);
  }

  private buildInteractables(level: Level) {
    const list: Interactable[] = [];
    // Light switches exist in every level — flicking a light is always allowed,
    // and in level 2 it is the whole game.
    for (const [id, xz] of Object.entries(SWITCHES) as Array<[RoomId, [number, number]]>) {
      const room = ROOMS[id];
      list.push({
        id: `sw:${id}`, kind: "switch", label: `${room.name} light`,
        x: xz[0], y: FLOOR[room.floor] + 1.2, z: xz[1], radius: 1.25, room: id,
      });
    }
    // Buzz's BB gun. It lives on his dresser in every level that has anybody
    // to shoot at, and finding it is a small reward for going up two floors
    // while there are men in the house.
    if (level.kind === "battle" || level.kind === "escape" || level.kind === "roam") {
      list.push({
        id: "bb", kind: "bb", label: "Take Buzz's BB gun",
        x: 6.2, y: FLOOR.upper + 1.3, z: -4.6, radius: 1.6,
      });
    }
    if (level.kind === "traps") {
      for (const t of TRAPS)
        list.push({
          id: `tr:${t.kind}`, kind: "trap", label: t.name,
          x: t.x, y: t.y + 0.5, z: t.z, radius: 1.7, trap: t.kind,
        });
    }
    if (level.kind === "escape" || level.kind === "roam") {
      list.push({
        id: "zip", kind: "zip", label: "Ride the zipline",
        x: ZIP_START.x, y: ZIP_START.y, z: ZIP_START.z + 0.5, radius: 1.5,
      });
      list.push({
        id: "rope", kind: "rope", label: "Cut the rope",
        x: ZIP_END.x + 1.0, y: ZIP_END.y, z: ZIP_END.z, radius: 1.8,
      });
    }
    this.interactables = list;
  }

  /* ================================================================== *
   * The loop
   * ================================================================== */

  private tick(dt: number) {
    const playing = this.phase === "playing";

    if (this.zipRide >= 0) this.updateZip(dt);
    else if (playing && this.caught <= 0) this.updatePlayer(dt);
    else this.kevin.update(dt, this.time, 0);

    if (playing) {
      this.updateBurglars(dt);
      this.updateLevel(dt);
      this.updateInteract();
    }

    this.updateMarley(dt);
    this.traps.update(dt, this.time);
    this.updateDoors(dt);
    this.updateAtmosphere(dt);
    this.settleCamera(dt);

    if (this.caught > 0) {
      this.caught = Math.min(1, this.caught + dt * 1.4);
      if (this.caught >= 1 && this.phase === "playing") this.lose("CAUGHT");
    }
    if (this.phase === "outro") {
      this.outroT += dt;
      if (this.outroT > 3.4) this.win();
    }
  }

  /* ---- player -------------------------------------------------------- */

  private updatePlayer(dt: number) {
    // Desktop keys and the touch stick land in the same two numbers.
    let ix = this.stick.x;
    let iz = this.stick.y;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) iz -= 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) iz += 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) ix -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) ix += 1;
    const mag = Math.hypot(ix, iz);
    if (mag > 1) {
      ix /= mag;
      iz /= mag;
    }
    const input = Math.min(1, mag);

    const running = this.sprintHeld || this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    // Kevin is eight. He is fast for eight and slow for a burglar, and the whole
    // battle is balanced on that: you cannot outrun them in a straight line,
    // only round a corner and over something you left on the floor.
    const top = running ? 5.1 : 2.55;

    // Move relative to where the camera is looking, which is the only scheme
    // that survives a camera that swings round corners on its own.
    const sin = Math.sin(this.camYaw);
    const cos = Math.cos(this.camYaw);
    const wx = ix * cos - iz * sin;
    const wz = ix * sin + iz * cos;

    const want = new THREE.Vector3(wx, 0, wz);
    if (want.lengthSq() > 0) want.normalize().multiplyScalar(top * input);

    const accel = this.grounded ? 14 : 3;
    this.vel.x += (want.x - this.vel.x) * Math.min(1, dt * accel);
    this.vel.z += (want.z - this.vel.z) * Math.min(1, dt * accel);

    this.vel.y -= GRAVITY * dt;
    this.pos.y += this.vel.y * dt;

    const nx = this.pos.x + this.vel.x * dt;
    const nz = this.pos.z + this.vel.z * dt;
    const solved = this.resolve(nx, nz, this.pos.y);
    this.pos.x = solved.x;
    this.pos.z = solved.z;

    const g = this.groundAt(this.pos.x, this.pos.z, this.pos.y + (this.grounded ? STEP_UP : 0.05));
    if (this.pos.y <= g) {
      if (this.vel.y < -7 && !this.grounded) this.audio.thud(1);
      this.pos.y = g;
      this.vel.y = 0;
      this.grounded = true;
    } else if (this.pos.y > g + 0.06) {
      this.grounded = false;
    }

    this.speed = Math.hypot(this.vel.x, this.vel.z);
    if (this.speed > 0.25) {
      const target = Math.atan2(this.vel.x, this.vel.z);
      let diff = target - this.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.yaw += diff * Math.min(1, dt * 11);
    }

    // Footsteps, on the surface actually underfoot. A burglar two rooms away
    // hears a sprint on bare boards and does not hear a walk on carpet.
    this.stepPhase += dt * this.speed * 1.35;
    if (this.stepPhase > 1) {
      this.stepPhase -= 1;
      const room = roomAt(this.pos.x, this.pos.y, this.pos.z);
      const outside = !room;
      const surface = outside
        ? "snow"
        : Math.abs(this.pos.x - -2.6) < 1.2 && this.pos.z > 0.3 && this.pos.z < 5.2 && this.pos.y > 0.2
          ? "stair"
          : room.ground === "concrete"
            ? "tile"
            : (room.ground as "wood" | "carpet" | "tile");
      this.audio.step(surface, running);
      if (running && !outside && room.ground !== "carpet") {
        for (const b of this.burglars) b.hear(this.pos.x, this.pos.y, this.pos.z, 11);
      }
    }

    this.kevin.root.position.copy(this.pos);
    this.kevin.root.rotation.y = this.yaw;
    this.kevin.update(dt, this.time, this.speed);
  }

  /** Push a circle out of every wall box it has ended up inside. */
  private resolve(x: number, z: number, y: number) {
    const lo = y + 0.16;
    const hi = y + 1.06;
    for (let pass = 0; pass < 2; pass++) {
      for (const c of this.world.colliders) {
        if (c.y1 <= lo || c.y0 >= hi) continue;
        const cx = clamp(x, c.x0, c.x1);
        const cz = clamp(z, c.z0, c.z1);
        const dx = x - cx;
        const dz = z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= PLAYER_R * PLAYER_R) continue;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          x += (dx / d) * (PLAYER_R - d);
          z += (dz / d) * (PLAYER_R - d);
        } else {
          // Dead centre: push out of the shallowest face.
          const l = x - c.x0, r = c.x1 - x, n = z - c.z0, s = c.z1 - z;
          const m = Math.min(l, r, n, s);
          if (m === l) x = c.x0 - PLAYER_R;
          else if (m === r) x = c.x1 + PLAYER_R;
          else if (m === n) z = c.z0 - PLAYER_R;
          else z = c.z1 + PLAYER_R;
        }
      }
    }
    return { x, z };
  }

  /**
   * The highest thing you could be standing on. Slabs and stair ramps, capped
   * at one step above your feet so an upstairs floor never grabs you from the
   * hall below.
   */
  private groundAt(x: number, z: number, ceiling: number) {
    let best = -60;
    for (const s of this.world.slabs) {
      if (x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) continue;
      if (s.y <= ceiling && s.y > best) best = s.y;
    }
    for (const r of this.world.ramps) {
      const y = rampHeight(r, x, z);
      if (y === null) continue;
      if (y <= ceiling && y > best) best = y;
    }
    return best;
  }

  /* ---- burglars ------------------------------------------------------- */

  private updateBurglars(dt: number) {
    if (this.level.kind !== "battle" && this.level.kind !== "escape") return;
    const ctx = { colliders: this.world.colliders };
    this.grace = Math.max(0, this.grace - dt);
    const hidden = this.grace > 0;
    let worst = 0;
    let alive = 0;

    for (const b of this.burglars) {
      if (b.state === "gone") continue;
      alive++;
      b.update(dt, this.time, this.pos, ctx, {
        aggression: this.level.aggression ?? 0.5,
        playerHidden: hidden,
      });
      worst = Math.max(worst, b.proximity);

      // `update` can change his state — including to "gone" — so re-read it
      // rather than leaning on what it was at the top of the iteration.
      const st: string = b.state;
      const upright = st !== "down" && st !== "gone";

      // Footsteps, attenuated by distance. This is most of the tension: you
      // hear where they are long before you see them.
      if (upright) {
        const d = b.pos.distanceTo(this.pos);
        if (d < 16 && Math.random() < dt * (st === "hunt" ? 5.5 : 3.2)) {
          this.audio.thud(d * 0.55);
        }
      }

      // Traps.
      if (upright && this.armed.size) {
        for (const t of TRAPS) {
          if (!this.armed.has(t.kind)) continue;
          const dy = Math.abs(b.pos.y - t.y);
          if (dy > 1.6) continue;
          if (Math.hypot(b.pos.x - t.x, b.pos.z - t.z) > t.radius) continue;
          const spot = this.traps.fire(t.kind);
          if (!spot) continue;
          this.armed.delete(t.kind);
          b.hit(spot.stun, spot.damage);
          this.audio.yell(b.who);
          this.trapSound(t.kind);
          this.flash(`${spot.name.toUpperCase()} — ${b.who === "harry" ? "HARRY" : "MARV"} IS DOWN`, 2.2);
          // The other one comes running. That is the price of a trap firing.
          for (const o of this.burglars) if (o !== b) o.hear(t.x, t.y, t.z, 22);
          if (b.nerve <= 0) {
            b.state = "flee";
            this.flash(`${b.who === "harry" ? "HARRY" : "MARV"} HAS HAD ENOUGH`, 2.4);
          }
          break;
        }
      }

      // Caught. Any burglar still on his feet and still in the fight — not
      // just one who has seen you. Walking into Marv's back in a dark
      // corridor has to count, or the safest place in the house is behind him.
      const grabby = st !== "down" && st !== "gone" && st !== "flee" && this.grace <= 0;
      if (grabby && this.caught <= 0 && this.zipRide < 0) {
        const d = Math.hypot(b.pos.x - this.pos.x, b.pos.z - this.pos.z);
        if (d < 0.85 && Math.abs(b.pos.y - this.pos.y) < 1.4) {
          if (this.level.kind === "escape" && !this.marleyUsed) {
            b.speak(this.time, "gotcha", true);
            this.marleySave(b);
          } else {
            this.caught = 0.01;
            this.caughtBy = b;
            b.speak(this.time, "gotcha", true);
            this.kevin.setScream(true);
            this.audio.scream();
            this.audio.playMusic(null);
          }
        }
      }
    }

    this.danger += (worst - this.danger) * Math.min(1, dt * 3);
    if (this.level.kind === "battle" && alive === 0 && this.phase === "playing") {
      this.flash("THEY'RE GONE", 2.6);
      this.phase = "outro";
    }
  }

  private trapSound(kind: TrapKind) {
    switch (kind) {
      case "iron": this.audio.clang(); break;
      case "ornaments": this.audio.glass(); break;
      case "torch": case "doorknob": this.audio.fire(); break;
      case "cars": case "tar": this.audio.slip(); break;
      case "paint": this.audio.clang(); this.audio.thud(0.4); break;
      case "glue": this.audio.clatter(); break;
    }
    this.audio.thud(0.5);
  }

  /* ---- level rules ---------------------------------------------------- */

  private updateLevel(dt: number) {
    const L = this.level;
    if (L.time) {
      this.levelTime = Math.max(0, this.levelTime - dt);
    }

    // Kevin narrates his own house, which is most of why the first act works.
    if (this.time > this.lastChatter && this.caught <= 0) {
      this.lastChatter = this.time + 16 + Math.random() * 14;
      const room = roomAt(this.pos.x, this.pos.y, this.pos.z);
      const lines = room ? ROOM_LINES[room.id] : null;
      if (lines?.length) this.speak(lines[Math.floor(Math.random() * lines.length)], 4.2);
    }

    switch (L.kind) {
      case "explore": {
        for (const b of L.beacons ?? []) {
          if (this.beaconsHit.has(b.id)) continue;
          if (Math.abs(this.pos.y - b.y) > 1.6) continue;
          if (Math.hypot(this.pos.x - b.x, this.pos.z - b.z) > b.radius) continue;
          this.beaconsHit.add(b.id);
          this.speak(b.line, 5);
          this.audio.chime(true);
        }
        this.compassTarget = this.nextBeacon();
        if (this.beaconsHit.size >= (L.beacons?.length ?? 0)) this.win();
        break;
      }
      case "lights": {
        this.updateVan(dt);
        const rooms = L.streetRooms ?? [];
        const lit = rooms.filter((r) => this.world.roomLights.get(r)?.on).length;
        this.compassTarget = this.nextDarkRoom(rooms);
        if (lit >= rooms.length) {
          this.flash("THE VAN KEEPS GOING", 2.4);
          this.win();
        } else if (this.suspicion >= 1) {
          this.lose("THEY MARKED THE HOUSE");
        } else if (this.levelTime <= 0) {
          this.lose("OUT OF TIME");
        }
        break;
      }
      case "traps": {
        this.compassTarget = this.nextTrap();
        if (this.armed.size >= TRAPS.length) {
          this.flash("EVERY ONE OF THEM", 2.2);
          this.win();
        } else if (this.levelTime <= 0) {
          if (this.armed.size >= (L.trapsNeeded ?? 4)) this.win();
          else this.lose("NINE O'CLOCK, AND NOTHING SET");
        }
        break;
      }
      case "battle": {
        this.compassTarget = this.nextArmedTrap();
        break;
      }
      case "escape": {
        if (this.ropeCut) break;
        const b = L.beacons?.[0];
        this.compassTarget = this.zipRide >= 0 || this.atTreehouse()
          ? { x: ZIP_END.x + 1.0, y: ZIP_END.y, z: ZIP_END.z, label: "the rope" }
          : b
            ? { x: b.x, y: b.y, z: b.z, label: b.label }
            : null;
        break;
      }
      default:
        this.compassTarget = null;
    }
  }

  private atTreehouse() {
    return Math.hypot(this.pos.x - TREEHOUSE.x, this.pos.z - TREEHOUSE.z) < 3.0 && this.pos.y > 2.0;
  }

  /**
   * The van. It cruises the block; while it is level with the house, every
   * street-facing room still dark adds to what they think of the place.
   */
  private updateVan(dt: number) {
    if (!this.vanActive) return;
    this.vanT += dt;
    const period = 26;
    const f = (this.vanT % period) / period;
    const dir = Math.floor(this.vanT / period) % 2 === 0 ? 1 : -1;
    const x = dir > 0 ? -46 + f * 92 : 46 - f * 92;
    this.world.van.position.x = x;
    this.world.van.rotation.y = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    this.world.van.position.z = STREET.centre + dir * 1.5;

    const near = Math.max(0, 1 - Math.abs(x - 0.4) / 22);
    if (near > 0.05) {
      const rooms = this.level.streetRooms ?? [];
      const dark = rooms.filter((r) => !this.world.roomLights.get(r)?.on).length;
      this.suspicion = Math.min(1, this.suspicion + dt * near * dark * 0.014);
    }
  }

  private nextBeacon() {
    for (const b of this.level.beacons ?? []) {
      if (!this.beaconsHit.has(b.id)) return { x: b.x, y: b.y, z: b.z, label: b.label };
    }
    return null;
  }

  private nextDarkRoom(rooms: RoomId[]) {
    let best: { x: number; y: number; z: number; label: string } | null = null;
    let bestD = Infinity;
    for (const id of rooms) {
      if (this.world.roomLights.get(id)?.on) continue;
      const sw = SWITCHES[id];
      if (!sw) continue;
      const y = FLOOR[ROOMS[id].floor];
      const d = Math.hypot(sw[0] - this.pos.x, sw[1] - this.pos.z) + Math.abs(y - this.pos.y) * 2;
      if (d < bestD) {
        bestD = d;
        best = { x: sw[0], y, z: sw[1], label: `${ROOMS[id].name} light` };
      }
    }
    return best;
  }

  private nextTrap() {
    let best: { x: number; y: number; z: number; label: string } | null = null;
    let bestD = Infinity;
    for (const t of TRAPS) {
      if (this.armed.has(t.kind)) continue;
      const d = Math.hypot(t.x - this.pos.x, t.z - this.pos.z) + Math.abs(t.y - this.pos.y) * 2.5;
      if (d < bestD) {
        bestD = d;
        best = { x: t.x, y: t.y, z: t.z, label: t.name };
      }
    }
    return best;
  }

  private nextArmedTrap() {
    let best: { x: number; y: number; z: number; label: string } | null = null;
    let bestD = Infinity;
    for (const t of TRAPS) {
      if (!this.armed.has(t.kind)) continue;
      const d = Math.hypot(t.x - this.pos.x, t.z - this.pos.z) + Math.abs(t.y - this.pos.y) * 2.5;
      if (d < bestD) {
        bestD = d;
        best = { x: t.x, y: t.y, z: t.z, label: t.name };
      }
    }
    return best;
  }

  /* ---- interaction ----------------------------------------------------- */

  private updateInteract() {
    let best: Interactable | null = null;
    let bestD = Infinity;
    for (const it of this.interactables) {
      if (it.done) continue;
      if (it.kind === "rope" && !this.atTreehouse()) continue;
      const dy = Math.abs(this.pos.y - (it.y - 1.0));
      if (dy > 1.6) continue;
      const d = Math.hypot(this.pos.x - it.x, this.pos.z - it.z);
      if (d > it.radius) continue;
      if (d < bestD) {
        bestD = d;
        best = it;
      }
    }
    this.nearest = best;

    if (!this.actionQueued) return;
    this.actionQueued = false;
    if (!best) return;

    switch (best.kind) {
      case "switch": {
        const room = best.room!;
        const on = !this.world.roomLights.get(room)?.on;
        this.world.setRoomLight(room, on);
        this.audio.tick();
        if (on && this.level.kind === "lights") this.speak(`${ROOMS[room].name}. Lit.`, 1.8);
        break;
      }
      case "trap": {
        const kind = best.trap!;
        if (this.armed.has(kind)) break;
        this.armed.add(kind);
        this.traps.arm(kind, true);
        const spot = TRAPS.find((t) => t.kind === kind)!;
        this.speak(spot.quip, 3.6);
        this.audio.chime(true);
        break;
      }
      case "zip": {
        if (this.zipRide >= 0) break;
        this.zipRide = 0;
        this.audio.slip();
        this.speak("Whoa—", 2.4);
        break;
      }
      case "bb": {
        this.hasBB = true;
        this.ammo = 12;
        best.done = true;
        this.kevin.setProp(true);
        this.audio.chime(true);
        this.speak("Buzz's BB gun. He'll never know.", 3.4);
        break;
      }
      case "rope": {
        this.ropeCut = true;
        best.done = true;
        this.world.zip.visible = false;
        this.audio.clang();
        this.flash("MERRY CHRISTMAS, YA FILTHY ANIMAL", 3.0);
        this.phase = "outro";
        break;
      }
    }
  }

  /** The zipline ride: four seconds, on rails, and you cannot be caught on it. */
  private updateZip(dt: number) {
    this.zipRide += dt / 3.6;
    const f = Math.min(1, this.zipRide);
    // Ease in, so he drops off the sill before he picks up speed.
    const e = f * f * (3 - 2 * f);
    this.pos.set(
      ZIP_START.x + (ZIP_END.x - ZIP_START.x) * e,
      ZIP_START.y + (ZIP_END.y - ZIP_START.y) * e - Math.sin(f * Math.PI) * 0.35,
      ZIP_START.z + (ZIP_END.z - ZIP_START.z) * e,
    );
    this.yaw = Math.atan2(ZIP_END.x - ZIP_START.x, ZIP_END.z - ZIP_START.z);
    this.kevin.root.position.copy(this.pos);
    this.kevin.root.rotation.y = this.yaw;
    this.kevin.limbs.lArm.rotation.x = -2.6;
    this.kevin.limbs.rArm.rotation.x = -2.6;
    this.kevin.update(dt, this.time, 0);
    this.kevin.limbs.lArm.rotation.x = -2.6;
    this.kevin.limbs.rArm.rotation.x = -2.6;
    if (f >= 1) {
      this.zipRide = -1;
      // Land him *on the deck*, explicitly. Dropping him at the wire's height
      // and letting gravity find the boards works right up until it doesn't,
      // and when it doesn't he falls out of the world with the level half
      // finished — which is the single worst bug this game could ship.
      const deck = this.groundAt(this.pos.x, this.pos.z, ZIP_END.y + 1.0);
      this.pos.y = deck > -20 ? deck : ZIP_END.y;
      this.vel.set(0, 0, 0);
      this.grounded = true;
      this.speak("Made it. Now the rope.", 3);
    }
  }

  /**
   * Marley, shovelling.
   *
   * He walks the pavement, turns at each end, and never comes onto the
   * property. That distance is the point: for four levels he is a shape at the
   * edge of the world you are told nothing about.
   */
  private updateMarley(dt: number) {
    const m = this.marley;
    if (!m) return;
    if (this.marleyShowUntil > this.time) {
      m.update(dt, this.time, 0);
      return;
    }
    if (!this.marleyActive) {
      // Not shovelling tonight, and not mid-rescue: he is simply not here.
      if (m.root.visible) m.root.visible = false;
      return;
    }
    this.marleyT += dt;
    const span = 34;
    const period = 58;
    const f = (this.marleyT % period) / period;
    const back = f > 0.5;
    const g = back ? 1 - (f - 0.5) * 2 : f * 2;
    m.root.position.set(-18 + g * span, -0.02, STREET.kerb - 2.6);
    m.root.rotation.y = back ? -Math.PI / 2 : Math.PI / 2;
    // He stops every so often and looks at the house, which is unnerving and
    // is meant to be — you find out much later that he is not the problem.
    const pause = Math.sin(this.marleyT * 0.42) > 0.86;
    m.update(dt, this.time, pause ? 0 : m.walkSpeed * 0.8);
    if (pause) m.root.rotation.y = Math.PI;
  }

  /**
   * The save.
   *
   * In the last level the first time they get hold of you, Marley turns up
   * with the snow shovel and that is that. Once, and only once — it is a beat,
   * not a mechanic, and if it happened twice it would be a second life.
   */
  private marleySave(b: Burglar) {
    this.marleyUsed = true;
    this.caught = 0;
    this.caughtBy = null;
    this.kevin.setScream(false);
    b.hit(6.5, 48);
    const m = this.marley;
    if (m) {
      m.root.visible = true;
      m.root.position.set(b.pos.x + Math.sin(b.yaw) * 1.4, b.pos.y, b.pos.z + Math.cos(b.yaw) * 1.4);
      m.root.rotation.y = b.yaw + Math.PI;
      m.update(0.016, this.time, 0);
    }
    this.marleyShowUntil = this.time + 6;
    this.flash("OLD MAN MARLEY", 3.2);
    this.speak(banterLine("marley", "trap") ?? "That's about enough of that.", 3.4);
    this.audio.thud(0.2);
    this.audio.clang();
    for (const o of this.burglars) if (o !== b) o.hear(b.pos.x, b.pos.y, b.pos.z, 30);
  }

  /* ---- doors, atmosphere, camera ---------------------------------------- */

  private updateDoors(dt: number) {
    const movers: Array<{ x: number; y: number; z: number }> = [this.pos];
    for (const b of this.burglars) if (b.state !== "gone") movers.push(b.pos);
    for (const d of this.world.doors) {
      let near = false;
      for (const m of movers) {
        if (Math.abs(m.y - FLOOR[d.floor]) > 1.6) continue;
        if (Math.hypot(m.x - d.x, m.z - d.z) < 1.7) {
          near = true;
          break;
        }
      }
      const want = near ? 1 : 0;
      if (want !== d.target) {
        d.target = want;
        if (want) this.audio.creak(0.55);
      }
      d.t += (d.target - d.t) * Math.min(1, dt * 4.5);
      d.pivot.rotation.y = d.closed + (d.open - d.closed) * d.t;
    }
  }

  private updateAtmosphere(dt: number) {
    // Snow follows you, so it always snows wherever you are.
    const s = this.world.snow;
    s.position.x = Math.round(this.camPos.x / 45) * 45;
    s.position.z = Math.round(this.camPos.z / 45) * 45;
    const p = s.geometry.attributes.position as THREE.BufferAttribute;
    const arr = p.array as Float32Array;
    for (let i = 0; i < arr.length; i += 3) {
      arr[i + 1] -= dt * (1.1 + (i % 7) * 0.12);
      arr[i] += Math.sin(this.time * 0.6 + i) * dt * 0.35;
      if (arr[i + 1] < -2) {
        arr[i + 1] = 28;
        arr[i] = (Math.random() - 0.5) * 90;
        arr[i + 2] = (Math.random() - 0.5) * 90;
      }
    }
    p.needsUpdate = true;

    // Firelight and the tree never sit still.
    this.world.fire.intensity = 1.7 + Math.sin(this.time * 9.1) * 0.3 + Math.sin(this.time * 3.3) * 0.25;
    for (let i = 0; i < this.world.treeLights.length; i++)
      this.world.treeLights[i].intensity = 1.1 + Math.sin(this.time * (1.6 + i * 0.7)) * 0.35;

    // The string of bulbs, chasing along the eaves.
    twinkle(this.world.dressing, this.time);
    // The television. Three frames on a 4 Hz cut, and its light moving with
    // them — a still picture in a dark room reads as a poster, not a set.
    const frame = Math.floor(this.time * 4) % 3;
    if (this.tvFrame !== frame) {
      this.tvFrame = frame;
      this.world.tv.map = T.filmFrame(frame);
      this.world.tv.needsUpdate = true;
      this.world.tvGlow.intensity = frame === 1 ? 11 : 4.5;
    }
    this.tauntCd = Math.max(0, this.tauntCd - dt);
    this.muzzle = Math.max(0, this.muzzle - dt * 4);

    this.world.cullLights(this.pos.x, this.pos.y, this.pos.z);
  }

  /**
   * Boom camera behind Kevin, pulled in whenever the house is in the way.
   *
   * Indoors this matters more than anything else about the camera: without it
   * the lens sits in the dining room while you stand in the kitchen and you
   * play the level looking at the back of a wall.
   */
  private settleCamera(dt: number) {
    const headY = this.pos.y + 1.12;
    const focus = new THREE.Vector3(this.pos.x, headY, this.pos.z);

    if (this.caught > 0 && this.caughtBy) {
      // He has you. Swing round to his face and stay there.
      const b = this.caughtBy;
      const f = this.caught;
      const bx = b.pos.x + Math.sin(b.yaw) * 0.9;
      const bz = b.pos.z + Math.cos(b.yaw) * 0.9;
      this.camPos.lerp(new THREE.Vector3(bx, b.pos.y + b.char.eyeY - 0.05, bz), Math.min(1, dt * 4));
      this.camLook.lerp(new THREE.Vector3(b.pos.x, b.pos.y + b.char.eyeY, b.pos.z), Math.min(1, dt * 5));
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camLook);
      this.camera.fov = 62 - f * 14;
      this.camera.updateProjectionMatrix();
      return;
    }
    if (this.camera.fov !== 62) {
      this.camera.fov += (62 - this.camera.fov) * Math.min(1, dt * 4);
      this.camera.updateProjectionMatrix();
    }

    // Indoors the boom has to be short enough to survive a 1.6 m corridor.
    const dist = this.shotDist ?? (this.zipRide >= 0 ? 5.4 : 2.85);
    const dir = new THREE.Vector3(
      Math.sin(this.camYaw) * Math.cos(this.camPitch),
      -Math.sin(this.camPitch),
      Math.cos(this.camYaw) * Math.cos(this.camPitch),
    );
    // The boom points *behind* him: from his head, backwards along his view.
    const back = dir.clone().multiplyScalar(-1);
    let d = dist;
    const hit = this.rayHit(focus, back, dist + 0.35);
    // 0.45 rather than a comfortable metre: in a 1.6 m corridor there is no
    // comfortable metre, and a boom that refuses to shorten puts the lens in
    // the wall instead. Below 0.95 Kevin is hidden, so it degrades into a
    // first-person view rather than a close-up of the back of his head.
    if (hit !== null && this.shotDist === null) d = Math.max(0.45, hit - 0.28);
    this.camDist += (d - this.camDist) * Math.min(1, dt * (d < this.camDist ? 26 : 6));
    this.kevin.root.visible = this.camDist > 0.95 || this.zipRide >= 0 || this.shotDist !== null;

    const want = focus.clone().addScaledVector(back, this.camDist);
    want.y += 0.42 + this.camPitch * 0.4;
    this.camPos.lerp(want, Math.min(1, dt * 16));
    this.camLook.lerp(focus.clone().addScaledVector(dir, 2.2), Math.min(1, dt * 14));
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
  }

  /** Distance along a ray to the first wall, or null. */
  private rayHit(from: THREE.Vector3, dir: THREE.Vector3, maxT: number) {
    let best: number | null = null;
    for (const c of this.world.camBlockers) {
      if (c.y1 - c.y0 < 0.5) continue;
      let t0 = 0;
      let t1 = maxT;
      let ok = true;
      for (const [o, d, lo, hi] of [
        [from.x, dir.x, c.x0, c.x1],
        [from.y, dir.y, c.y0, c.y1],
        [from.z, dir.z, c.z0, c.z1],
      ] as const) {
        if (Math.abs(d) < 1e-6) {
          if (o < lo || o > hi) {
            ok = false;
            break;
          }
          continue;
        }
        let n = (lo - o) / d;
        let f = (hi - o) / d;
        if (n > f) [n, f] = [f, n];
        t0 = Math.max(t0, n);
        t1 = Math.min(t1, f);
        if (t0 > t1) {
          ok = false;
          break;
        }
      }
      if (ok && t0 >= 0 && (best === null || t0 < best)) best = t0;
    }
    return best;
  }

  /* ---- outcomes --------------------------------------------------------- */

  private speak(line: string, secs: number) {
    this.say = line;
    this.sayUntil = this.time + secs;
  }

  private flash(text: string, secs: number) {
    this.banner = text;
    this.bannerUntil = this.time + secs;
  }

  private win() {
    if (this.phase === "won") return;
    this.phase = "won";
    this.audio.playMusic("home", 0.4);
    this.audio.chime(true);
    if (this.level.n <= LEVEL_COUNT && this.level.n > this.cleared) {
      this.cleared = this.level.n;
      try {
        localStorage.setItem("homealone:cleared", String(this.cleared));
      } catch {
        /* private browsing; the run still counts for this session */
      }
    }
    this.emit();
  }

  private lose(why: string) {
    if (this.phase === "lost") return;
    this.phase = "lost";
    this.banner = why;
    this.bannerUntil = this.time + 6;
    this.audio.playMusic(null);
    this.audio.chime(false);
    this.emit();
  }

  /* ---- input plumbing ---------------------------------------------------- */

  private bindInput(canvas: HTMLCanvasElement) {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Tab") return;
      this.keys.add(e.code);
      if (e.code === "KeyE" || e.code === "Enter") {
        this.actionQueued = true;
        e.preventDefault();
      }
      if (e.code === "KeyQ") {
        this.taunt();
        e.preventDefault();
      }
      if (e.code === "KeyF" || e.code === "Space") {
        this.fire();
        e.preventDefault();
      }
      if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code))
        e.preventDefault();
    };
    const up = (e: KeyboardEvent) => this.keys.delete(e.code);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);

    const onMove = (e: MouseEvent) => {
      if (!this.pointerLocked) return;
      this.look(e.movementX * 0.0026, e.movementY * 0.0022);
    };
    const onLock = () => {
      this.pointerLocked = document.pointerLockElement === canvas;
    };
    const onClick = () => {
      this.audio.resume();
      if (this.phase === "playing" && !this.pointerLocked && !("ontouchstart" in window))
        canvas.requestPointerLock?.();
    };
    canvas.addEventListener("click", onClick);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("pointerlockchange", onLock);

    // Touch look: any drag that starts on the right-hand side of the screen.
    const tStart = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      if (e.clientX < window.innerWidth * 0.42) return;
      this.dragging = e.pointerId;
      this.dragLast = { x: e.clientX, y: e.clientY };
    };
    const tMove = (e: PointerEvent) => {
      if (this.dragging !== e.pointerId) return;
      this.look((e.clientX - this.dragLast.x) * 0.0055, (e.clientY - this.dragLast.y) * 0.0045);
      this.dragLast = { x: e.clientX, y: e.clientY };
    };
    const tEnd = (e: PointerEvent) => {
      if (this.dragging === e.pointerId) this.dragging = null;
    };
    canvas.addEventListener("pointerdown", tStart);
    window.addEventListener("pointermove", tMove);
    window.addEventListener("pointerup", tEnd);
    window.addEventListener("pointercancel", tEnd);

    this.unbind = () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      canvas.removeEventListener("click", onClick);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("pointerlockchange", onLock);
      canvas.removeEventListener("pointerdown", tStart);
      window.removeEventListener("pointermove", tMove);
      window.removeEventListener("pointerup", tEnd);
      window.removeEventListener("pointercancel", tEnd);
    };
  }

  private unbind: () => void = () => {};

  /* ---- snapshot ---------------------------------------------------------- */

  /**
   * The current state, as the HUD sees it.
   *
   * Public rather than private because `tools/homealone-play.mjs` drives the
   * whole game through it — asserting on the same numbers the player is shown
   * is the only way to know a level can actually be finished.
   */
  snapshot(): Snapshot {
    const room = roomAt(this.pos.x, this.pos.y, this.pos.z);
    const L = this.level;

    let done = 0;
    let total = 0;
    if (L.kind === "explore") {
      done = this.beaconsHit.size;
      total = L.beacons?.length ?? 0;
    } else if (L.kind === "lights") {
      const rooms = L.streetRooms ?? [];
      done = rooms.filter((r) => this.world.roomLights.get(r)?.on).length;
      total = rooms.length;
    } else if (L.kind === "traps") {
      done = this.armed.size;
      total = TRAPS.length;
    } else if (L.kind === "battle") {
      done = this.burglars.filter((b) => b.state === "gone").length;
      total = 2;
    } else if (L.kind === "escape") {
      done = this.ropeCut ? 2 : this.atTreehouse() ? 1 : 0;
      total = 2;
    }

    let compass: number | null = null;
    let compassDist = 0;
    if (this.compassTarget) {
      const dx = this.compassTarget.x - this.pos.x;
      const dz = this.compassTarget.z - this.pos.z;
      compassDist = Math.hypot(dx, dz);
      compass = Math.atan2(dx, dz) - this.camYaw;
    }

    return {
      phase: this.phase,
      level: L.n,
      title: L.title,
      quote: L.quote,
      brief: L.brief,
      goal: L.goal,
      kind: L.kind,
      room: room?.name ?? (this.pos.z > 8 ? "Lincoln Avenue" : this.pos.z < -8 ? "The Back Yard" : "Outside"),
      action: this.nearest
        ? this.nearest.kind === "switch"
          // Verb first, room second. "Turn on the ${name}" cannot be made to
          // read for all sixteen — the names carry their own articles and
          // possessives ("The Den", "Kevin's Room"), so it produces "the the
          // den" and "the kevin's room". This shape works for every one.
          ? `${this.world.roomLights.get(this.nearest.room!)?.on ? "Lights off" : "Lights on"} — ${ROOMS[this.nearest.room!].name}`
          : this.nearest.kind === "trap"
            ? this.armed.has(this.nearest.trap!) ? null : `Set: ${this.nearest.label}`
            : this.nearest.label
        : null,
      say: this.time < this.sayUntil ? this.say : null,
      banner: this.time < this.bannerUntil ? this.banner : null,
      timeLeft: L.time ? this.levelTime : null,
      done,
      total,
      traps: TRAPS.map((t) => ({
        kind: t.kind,
        name: t.name,
        quip: t.quip,
        armed: this.armed.has(t.kind),
        spent: this.traps.visuals.get(t.kind)?.spent ?? false,
        room: ROOMS[t.room].name,
      })),
      burglars: this.burglars.map((b) => ({
        who: b.who,
        nerve: b.nerve,
        state: b.state,
        down: b.state === "down",
        says: b.says,
      })),
      compass,
      compassLabel: this.compassTarget?.label ?? null,
      compassDist,
      danger: this.danger,
      suspicion: this.suspicion,
      caught: this.caught,
      running: this.sprintHeld || this.keys.has("ShiftLeft"),
      cleared: this.cleared,
      hasBB: this.hasBB,
      ammo: this.ammo,
      tauntCooldown: this.tauntCd,
      marley: this.marleyShowUntil > this.time,
    };
  }

  private emit() {
    const s = this.snapshot();
    for (const fn of this.listeners) fn(s);
  }

  /* ---- teardown ------------------------------------------------------------ */

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.unbind();
    if (document.pointerLockElement) document.exitPointerLock?.();
    this.audio.dispose();
    for (const b of this.burglars) b.dispose();
    this.marley?.dispose();
    this.kevin.dispose();
    this.traps.dispose();
    this.world.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    T.disposeTextures();
    this.renderer.dispose();
    // Browsers cap live WebGL contexts. A world that leaks one breaks the next
    // world a visitor opens, which is a miserable thing to debug.
    this.renderer.forceContextLoss?.();
    this.listeners.clear();
  }
}

/* ------------------------------------------------------------------ */

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Height of a stair ramp at a point, or null if the point is off the flight. */
function rampHeight(r: Ramp, x: number, z: number): number | null {
  if (x < r.x0 - 0.05 || x > r.x1 + 0.05 || z < r.z0 - 0.05 || z > r.z1 + 0.05) return null;
  const a = r.axis === "z" ? z : x;
  const a0 = r.axis === "z" ? r.z0 : r.x0;
  const a1 = r.axis === "z" ? r.z1 : r.x1;
  const f = clamp(r.dir === 1 ? (a - a0) / (a1 - a0) : (a1 - a) / (a1 - a0), 0, 1);
  return r.yLow + (r.yHigh - r.yLow) * f;
}

export { CEILING, LEVELS, LEVEL_COUNT, TRAPS };
