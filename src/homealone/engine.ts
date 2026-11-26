/**
 * The engine: renderer, camera, the kid, the clock, and the loop that ties the
 * house to the people walking round it.
 *
 * Four decisions worth stating, because everything else follows from them.
 *
 * **It is third person.** This is a game about watching a small child do
 * something enormous, and a first-person camera throws that away: you would
 * never once see the bobble hat, or him legging it down a corridor two sizes
 * too big for him. The cost is a camera that has to survive being indoors,
 * which `settleCamera` pays for by pulling the boom in whenever a wall gets
 * between the lens and his head.
 *
 * **Height is a query, not a state.** There is no "which floor am I on" flag.
 * `groundAt` takes the highest floor slab or stair ramp beneath you that is
 * within a step of your feet, and that is the entire multi-storey system. Walk
 * off the landing and the ground under you becomes the hall floor, so you fall
 * into it; walk up the flight and the ramp lifts you. Nothing switches.
 *
 * **The intruders run on the same floor you do.** They path the nav graph,
 * they climb the same ramps, and their footsteps are attenuated by real
 * distance. When you hear one upstairs, one is upstairs.
 *
 * **Traps are laid, not switched on.** You carry a box of parts, you put a
 * thing down where you are standing, and what it does to somebody is a
 * direction and a distance (`kit.ts`). This file's half of that is carrying
 * the body: `advanceFling` walks a thrown intruder along his throw and asks,
 * every twelve centimetres, what he has just hit. A wall is a slam. Another
 * trap is the next link. The top of the stairs is a very long way down.
 */
import * as THREE from "three";
import { line as banterLine, resetBanter } from "./banter";
import { makeBricks, type BrickRig, type BrickTarget } from "./bricks";
import { twinkle } from "./christmas";
import { buildPlaced, type PlacedRig } from "./placed";
import { Burglar, clearLine, entryNode, spawnPoint, type WorldCtx } from "./ai";
import { buildWorld, type BuiltWorld } from "./build";
import { HomeAudio } from "./audio";
import { makeCharacter, type Character } from "./characters";
import {
  CEILING,
  FLOOR,
  ROOMS,
  STREET,
  ZIP_END,
  ZIP_START,
  nearestNode,
  node,
  pathBetween,
  pathLength,
  roomAt,
  type Ramp,
  type RoomId,
} from "./house";
import {
  CHAIN_WINDOW,
  chainMult,
  linkScore,
  KIT,
  KIT_ORDER,
  PLACE_PROBLEM_TEXT,
  kitForNight,
  placeProblem,
  resolveTrap,
  resolveTrick,
  scoreNight,
  type KitKind,
  type NightResult,
  type Placed,
  type PlaceProblem,
  type Trick,
} from "./kit";
import { EXPLORE, LEVELS, LIGHTS, ROAM, ROOM_LINES, levelByNumber, type Level } from "./levels";
import { INTRUDERS, LOOT, NIGHT_COUNT, newKitOn, type Arrival, type Entry } from "./nights";
import * as T from "./textures";

export type Phase = "menu" | "brief" | "playing" | "won" | "lost";

export interface KitSlot {
  kind: KitKind;
  name: string;
  icon: string;
  cost: number;
  blurb: string;
  affordable: boolean;
  selected: boolean;
  /** The number key that picks it. */
  key: number;
}

export interface IntruderState {
  id: number;
  name: string;
  /** 0 … 100, as a share of what he arrived with. */
  nerve: number;
  state: string;
  down: boolean;
  /** What he is shouting, if anything. */
  says: string | null;
  /** The name of what is on his back. */
  carrying: string | null;
  status: "stuck" | "blind" | "flying" | null;
  entry: Entry;
  /** Seconds until he arrives; 0 once he is in play. */
  eta: number;
  /** Whose lines he speaks, which is also which body he has. */
  voice: "gus" | "lenny";
}

export interface LootState {
  id: string;
  name: string;
  state: "safe" | "taken" | "gone";
}

export interface FeedLine {
  id: number;
  who: string;
  /** "Marbles → Springboard → WALL SLAM" */
  text: string;
  chain: number;
  /** Still fresh enough to shout about. */
  hot: boolean;
}

export interface Snapshot {
  phase: Phase;
  level: number;
  title: string;
  brief: string[];
  goal: string;
  kind: Level["kind"];
  /** Where you are, by name. */
  room: string;
  /** The action button's label right now, or null when there is nothing to do. */
  action: string | null;
  /** The kid's most recent line. */
  say: string | null;
  /** A big banner: "CAUGHT", "3x CHAIN", that sort of thing. */
  banner: string | null;
  timeLeft: number | null;
  /** Objective progress, whatever the level counts. */
  done: number;
  total: number;
  /** Bearing to the objective, relative to where the camera is looking. */
  compass: number | null;
  compassLabel: string | null;
  compassDist: number;
  /** 0 … 1. Drives the heartbeat and the vignette. */
  danger: number;
  /** LIGHTS's meter. */
  suspicion: number;
  /** 0 … 1 while somebody has hold of you. */
  caught: number;
  running: boolean;
  /** The highest night finished. */
  cleared: number;
  /** 0 when the shout is ready, otherwise seconds left. */
  tauntCooldown: number;
  /**
   * Where the floating touch stick is, in CSS pixels, so the HUD can draw a
   * ring around the thumb. Null when nothing is touching the left side.
   */
  stick: { ox: number; oy: number; x: number; y: number } | null;
  /** Boom length, for the zoom readout. */
  boom: number;
  /** Seconds until another snowball can be thrown; 0 when ready. */
  brickCooldown: number;
  invertLook: boolean;

  /* ---- the trap game ------------------------------------------------- */
  /** `plan` while you are laying traps, `raid` once they are in. */
  stage: "plan" | "raid" | null;
  /** Seconds of planning left. */
  planLeft: number;
  parts: number;
  /** No budget, no score, nobody comes unless asked. */
  sandbox: boolean;
  kit: KitSlot[];
  /** Why the thing in your hand cannot go where you are pointing. */
  placeHint: string | null;
  /** How many traps are on the floor. */
  laid: number;
  /** Alarm clocks ready to ring. */
  clocks: number;
  intruders: IntruderState[];
  loot: LootState[];
  hearts: number;
  score: number;
  bestChain: number;
  feed: FeedLine[];
  result: NightResult | null;
  /** Who is on tonight's list, for the brief card. */
  cast: Array<{ name: string; trait: string; entry: Entry }>;
  /** What is new in the box tonight, for the brief card. */
  newKit: Array<{ name: string; icon: string; blurb: string }>;
  /** There is a written night after this one. */
  hasNext: boolean;
  bestScore: number;
}


const STEP_UP = 0.62;
const PLAYER_R = 0.26;
const GRAVITY = 20;

interface Interactable {
  id: string;
  kind: "switch" | "zip";
  label: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  room?: RoomId;
  done?: boolean;
}

/** Caught this many times and the night is over. */
const HEARTS = 3;
/** How far in front of you a trap goes down. */
const REACH = 1.25;


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
  kid: [1.0, 0.65],
  parents: [3.9, 0.65],
  brother: [3.4, -1.45],
  guest: [-2.5, -1.45],
  basement: [0.55, -1.5],
};

export class HomeAloneEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private world: BuiltWorld;
  private placedRig: PlacedRig;
  private bricks: BrickRig;
  private audio = new HomeAudio();
  private kid: Character;
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
  private camPitch = 0.1;
  private camDist = 3.1;
  /** The boom length the player has chosen with the wheel or a pinch. */
  private camBoom = 3.0;
  private invertLook = false;
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();

  /* ---- input -------------------------------------------------------- */
  private keys = new Set<string>();
  private stick = { x: 0, y: 0 };
  private sprintHeld = false;
  private actionQueued = false;
  private pointerLocked = false;
  private dragLast = { x: 0, y: 0 };
  /** Which pointer is driving the stick, and which is driving the look. */
  private stickId: number | null = null;
  private lookId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private stickAt = { x: 0, y: 0 };
  private livePointers = new Map<number, { x: number; y: number }>();
  private pinchFrom: number | null = null;

  /* ---- level state --------------------------------------------------- */
  private phase: Phase = "menu";
  private level: Level = LEVELS[0];
  private levelTime = 0;
  private beaconsHit = new Set<string>();
  private interactables: Interactable[] = [];
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
  /** Seconds during which nobody can see you: the start of a raid, and after being caught. */
  private grace = 0;
  private zipRide = -1;
  private muted = false;
  private cleared = 0;
  private bestScores: Record<string, number> = {};
  private nearest: Interactable | null = null;
  private tauntCd = 0;
  /** Counts down through the throwing animation. */
  private throwT = 0;
  private throwCd = 0;
  compassTarget: { x: number; y: number; z: number; label: string } | null = null;
  private time = 0;
  private tvFrame = -1;

  /* ---- the trap game -------------------------------------------------- */
  private stage: "plan" | "raid" | null = null;
  private planLeft = 0;
  private raidT = 0;
  private queue: Arrival[] = [];
  private seat = 0;
  private parts = 0;
  private selected: KitKind | null = null;
  private placed: Placed[] = [];
  private nextTrapId = 1;
  /** Where the thing in your hand would go, and what is wrong with that. */
  private ghost = { x: 0, y: 0, z: 0, yaw: 0, problem: null as PlaceProblem };
  private hint: string | null = null;
  private hintUntil = 0;
  private clockTurn = 0;
  /** A trap near enough to pick back up. */
  private pickable: Placed | null = null;
  private lootState = new Map<string, "safe" | "taken" | "gone">();
  private hearts = HEARTS;
  private points = 0;
  private bestChain = 0;
  private routed = 0;
  private arrived = 0;
  private feed: Array<{ id: number; who: Burglar; parts: string[]; chain: number; until: number }> = [];
  private feedId = 1;
  private result: NightResult | null = null;
  /**
   * Nobody can see or grab the player. For `tools/homealone-play.mjs`, which
   * needs to watch a whole raid play out without a pair of hands on the stick.
   */
  spectator = false;
  /**
   * Frames rendered. Public for `tools/homealone-play.mjs`, which has to wait
   * for the world to actually tick between teleporting and pressing a key:
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
    this.placedRig = buildPlaced(this.world.root);
    this.bricks = makeBricks(this.scene);

    this.kid = makeCharacter("kid");
    this.scene.add(this.kid.root);

    this.bindInput(canvas);
    try {
      this.cleared = Number(localStorage.getItem("houserules:cleared") ?? "0") || 0;
    } catch {
      this.cleared = 0;
    }
    try {
      this.invertLook = localStorage.getItem("houserules:invert") === "1";
    } catch {
      this.invertLook = false;
    }
    try {
      this.bestScores = JSON.parse(localStorage.getItem("houserules:best") ?? "{}") ?? {};
    } catch {
      this.bestScores = {};
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
    this.setupLevel(this.level);
    this.emit();
  }

  begin() {
    if (this.phase !== "brief") return;
    this.setupLevel(this.level);
    this.phase = "playing";
    this.audio.resume();
    this.audio.startAmbience();
    this.audio.playMusic(null);
    this.emit();
  }

  retry() {
    this.select(this.level.n);
    this.begin();
  }

  /** The night after this one. They do not run out. */
  next() {
    this.select(this.level.kind === "night" ? this.level.n + 1 : 1);
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

  /**
   * Swing the camera. `dx`/`dy` are screen-space deltas in radians, so
   * dragging *up* the screen is a negative `dy` and must raise the view.
   */
  look(dx: number, dy: number) {
    this.camYaw -= dx;
    const d = this.invertLook ? -dy : dy;
    // Up is generous, down is not: the useful thing to look at below you is
    // the floor two metres ahead, and any more than that puts the lens in it.
    this.camPitch = clamp(this.camPitch - d, -0.62, 1.0);
  }

  /** Pull the boom in or out. `k` > 1 zooms out. */
  zoom(k: number) {
    this.camBoom = clamp(this.camBoom * k, 1.15, 7.5);
  }

  setInvertLook(on: boolean) {
    this.invertLook = on;
    try {
      localStorage.setItem("houserules:invert", on ? "1" : "0");
    } catch {
      /* private browsing */
    }
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
   * This is the mechanic the whole raid turns on. You cannot fight them and
   * you cannot outrun them; what you *can* do is stand on the far side of
   * something you laid earlier, yell, and make them come to you. Without it,
   * leading somebody onto a trap is luck; with it, it is a plan.
   */
  taunt() {
    if (this.phase !== "playing" || this.tauntCd > 0 || this.caught > 0) return;
    this.tauntCd = 5.5;
    const l = banterLine("kid", "taunt");
    if (l) this.speak(l, 3.2);
    this.audio.scream();
    // Heard through walls, through floors, from anywhere in the house.
    for (const b of this.burglars) b.hear(this.pos.x, this.pos.y, this.pos.z, 60);
  }

  /**
   * Throw a snowball.
   *
   * There is always another one, and the only limit is the beat between
   * throws. What it will not do is win the night: see `Burglar.pelt`.
   */
  throwBrick() {
    if (this.phase !== "playing" || this.caught > 0 || this.throwCd > 0 || this.zipRide >= 0) return;
    this.throwCd = 0.8;
    this.throwT = 1;
    this.kid.setBrick(false);
    this.audio.brickThrow();

    // Out of his hand, in the direction the camera is looking.
    const from = new THREE.Vector3(this.pos.x, this.pos.y + this.kid.height * 0.84, this.pos.z);
    const dir = new THREE.Vector3(
      Math.sin(this.camYaw) * Math.cos(this.camPitch),
      Math.sin(this.camPitch),
      Math.cos(this.camYaw) * Math.cos(this.camPitch),
    );
    from.addScaledVector(dir, 0.3);
    this.bricks.hurl(from, dir, this.brickTargets());
    // He turns to face the throw, or it looks like he lobbed it sideways.
    this.yaw = Math.atan2(dir.x, dir.z);
  }

  /** The intruders, as things a snowball can hit. */
  private brickTargets(): BrickTarget[] {
    const out: BrickTarget[] = [];
    for (const b of this.burglars) {
      if (!b.active || b.flung) continue;
      out.push({
        x: b.pos.x,
        y: b.pos.y,
        z: b.pos.z,
        height: b.char.height,
        hit: () => {
          const how = b.pelt(this.time);
          if (!how) return false;
          // Stuck or blind, a snowball is enough to put him on the floor.
          if (how === "floor") {
            const chain = this.liveChain(b) + 1;
            this.link(b, "Snowball", Math.round(16 * chainMult(chain)), 2.6, chain, linkScore(chain, 1), ["STUCK SHOT"]);
          }
          else if (b.nerve <= 0) this.flash(`${b.name.toUpperCase()} HAS HAD ENOUGH`, 2.4);
          return true;
        },
      });
    }
    return out;
  }

  /* ---- the kit ------------------------------------------------------- */

  /** What is in the box right now. */
  private kitNow(): KitKind[] {
    if (this.level.kind === "roam") return KIT_ORDER;
    if (this.level.kind === "night") return kitForNight(this.level.n);
    return [];
  }

  /** Pick something out of the box, or put it back (null, or the same again). */
  selectKit(kind: KitKind | null) {
    if (this.phase !== "playing") return;
    if (kind && !this.kitNow().includes(kind)) return;
    this.selected = kind && kind !== this.selected ? kind : null;
    this.audio.tick();
    this.emit();
  }

  /** Lay the thing in your hand where the ghost is. */
  place() {
    if (this.phase !== "playing" || !this.selected || this.caught > 0 || this.zipRide >= 0) return false;
    this.updateGhost();
    const g = this.ghost;
    if (g.problem) {
      this.hint = PLACE_PROBLEM_TEXT[g.problem];
      this.hintUntil = this.time + 1.6;
      this.audio.chime(false);
      return false;
    }
    const def = KIT[this.selected];
    const p: Placed = {
      id: this.nextTrapId++, kind: def.kind, x: g.x, y: g.y, z: g.z, yaw: g.yaw,
      usesLeft: def.uses, cool: 0, firing: 0,
    };
    this.placed.push(p);
    this.placedRig.add(p);
    if (this.level.kind !== "roam") this.parts -= def.cost;
    this.audio.place();
    // Out of parts for this one: put it away rather than leave a red ghost up.
    if (this.parts < def.cost) this.selected = null;
    this.emit();
    return true;
  }

  /** Ring the next alarm clock. They take turns, in the order you laid them. */
  ring() {
    if (this.phase !== "playing") return;
    const clocks = this.placed.filter((p) => p.kind === "clock" && p.usesLeft > 0 && p.cool <= 0);
    if (!clocks.length) return;
    const p = clocks[this.clockTurn++ % clocks.length];
    const def = KIT.clock;
    p.usesLeft--;
    p.cool = def.rearm;
    p.firing = 1;
    this.placedRig.ring(p.id);
    this.audio.alarm();
    let heard = 0;
    for (const b of this.burglars) if (b.hear(p.x, p.y, p.z, def.area)) heard++;
    this.hint = heard ? `${heard} of them heard that` : "Nobody close enough to hear it";
    this.hintUntil = this.time + 1.8;
  }

  /** Stop planning and open the doors. */
  ready() {
    if (this.phase === "playing" && this.stage === "plan") this.startRaid();
  }

  /** Sandbox: send one in. */
  callIn(who?: string) {
    if (this.phase !== "playing" || this.level.kind !== "roam") return;
    if (this.burglars.filter((b) => b.active).length >= 6) return;
    const cast = Object.keys(INTRUDERS);
    const id = who && INTRUDERS[who] ? who : cast[this.seat % cast.length];
    this.spawnIntruder({ who: id, entry: this.seat % 2 ? "back" : "front", at: 0 });
  }

  /**
   * Run the simulation forward without drawing it.
   *
   * The sandbox renders this house at well under a frame a second, so a
   * ninety-second raid is a quarter of an hour of wall clock and tells you
   * nothing while it runs. This steps the same `tick` the loop calls, at a
   * fixed thirtieth of a second, which is how `tools/homealone-play.mjs`
   * watches a whole night happen.
   */
  settle(seconds: number) {
    const dt = 1 / 30;
    for (let i = 0; i < seconds * 30 && !this.disposed; i++) {
      this.time += dt;
      this.tick(dt);
    }
    this.emit();
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

  private setupLevel(level: Level) {
    this.setLevelLights(level);
    this.beaconsHit.clear();
    this.suspicion = 0;
    this.vanT = 0;
    this.vanActive = level.kind === "lights";
    this.caught = 0;
    this.caughtBy = null;
    this.danger = 0;
    this.zipRide = -1;
    this.say = null;
    this.banner = null;
    this.hint = null;
    this.levelTime = level.time ?? 0;
    this.kid.setScream(false);

    this.pos.set(level.spawn.x, level.spawn.y + 0.05, level.spawn.z);
    this.vel.set(0, 0, 0);
    this.yaw = level.spawn.yaw;
    this.camYaw = level.spawn.yaw;
    this.camPitch = 0.1;
    this.kid.root.visible = true;

    resetBanter();
    this.bricks.clear();
    this.throwT = 0;
    this.throwCd = 0;
    this.tauntCd = 0;
    this.grace = 0;

    /* Everybody out, and everything off the floor. */
    for (const b of this.burglars) {
      this.scene.remove(b.char.root);
      b.dispose();
    }
    this.burglars = [];
    this.placed = [];
    this.placedRig.clear();
    this.selected = null;
    this.pickable = null;
    this.clockTurn = 0;
    this.seat = 0;
    this.arrived = 0;
    this.feed = [];
    this.points = 0;
    this.bestChain = 0;
    this.routed = 0;
    this.hearts = HEARTS;
    this.result = null;
    this.raidT = 0;
    this.queue = [];
    this.lootState.clear();
    this.compassTarget = null;

    const trapGame = level.kind === "night" || level.kind === "roam";
    if (trapGame) for (const l of LOOT) this.lootState.set(l.id, "safe");
    if (level.kind === "night" && level.night) {
      this.stage = "plan";
      this.planLeft = level.night.planTime;
      this.parts = level.night.parts;
      this.queue = [...level.night.arrivals].sort((a, b) => a.at - b.at);
      this.placedRig.routes(this.likelyRoutes(this.queue));
    } else if (level.kind === "roam") {
      // The sandbox is a raid that nobody has turned up to yet.
      this.stage = "raid";
      this.parts = 99;
    } else {
      this.stage = null;
      this.parts = 0;
    }

    this.world.van.visible = level.kind === "lights" || level.kind === "night";
    this.world.van.position.set(level.kind === "lights" ? -40 : -2, 0, STREET.centre - 1.2);
    this.world.zip.visible = trapGame;

    this.buildInteractables(level);
    this.settleCamera(0.999);
  }

  private buildInteractables(level: Level) {
    const list: Interactable[] = [];
    // Light switches exist everywhere. In LIGHTS they are the whole game; on a
    // night they are a move, because a dark room hides both you and your traps.
    for (const [id, xz] of Object.entries(SWITCHES) as Array<[RoomId, [number, number]]>) {
      const room = ROOMS[id];
      list.push({
        id: `sw:${id}`, kind: "switch", label: `${room.name} light`,
        x: xz[0], y: FLOOR[room.floor] + 1.2, z: xz[1], radius: 1.25, room: id,
      });
    }
    // The wire from the guest-room window to the treehouse: the way out when
    // they have you cornered upstairs. You walk back in through the yard.
    if (level.kind === "night" || level.kind === "roam") {
      list.push({
        id: "zip", kind: "zip", label: "Ride the wire to the treehouse",
        x: ZIP_START.x, y: ZIP_START.y, z: ZIP_START.z + 0.5, radius: 1.5,
      });
    }
    this.interactables = list;
  }

  /**
   * Where they are likely to walk, as dots.
   *
   * Each arrival, in order, takes the nearest valuable nobody ahead of him has
   * taken, which is exactly what the AI does when the doors open. So the line
   * on the floor during planning is not a hint about the route, it *is* the
   * route, right up until you do something to change it.
   */
  private likelyRoutes(arrivals: Arrival[]) {
    const taken = new Set<string>();
    const dots: Array<{ x: number; y: number; z: number }> = [];
    for (const a of arrivals) {
      const from = entryNode(a.entry);
      let best: ReturnType<typeof pathBetween> | null = null;
      let bestLen = Infinity;
      let bestId = "";
      for (const l of LOOT) {
        if (taken.has(l.id)) continue;
        const path = pathBetween(from, l.node);
        const len = pathLength(path);
        if (len < bestLen) {
          bestLen = len;
          best = path;
          bestId = l.id;
        }
      }
      if (!best) break;
      taken.add(bestId);
      for (let i = 1; i < best.length; i++) {
        const p = best[i - 1];
        const q = best[i];
        const len = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
        const n = Math.max(1, Math.round(len / 0.55));
        for (let k = 0; k < n; k++) {
          const f = k / n;
          dots.push({ x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f, z: p.z + (q.z - p.z) * f });
        }
      }
    }
    return dots;
  }

  /* ================================================================== *
   * The loop
   * ================================================================== */

  private tick(dt: number) {
    const playing = this.phase === "playing";

    if (this.zipRide >= 0) this.updateZip(dt);
    else if (playing && this.caught <= 0) this.updatePlayer(dt);
    else this.kid.update(dt, this.time, 0);

    if (playing) {
      this.updateRaid(dt);
      this.updateBurglars(dt);
      this.updateTraps(dt);
      this.updateLevel(dt);
      this.updateInteract();
    }
    this.updateLoot();
    this.updateGhost();

    this.bricks.update(
      dt,
      {
        groundAt: (x, z, c) => this.groundAt(x, z, c),
        blocked: (x, y, z) => this.blocked(x, y, z),
      },
      this.brickTargets(),
      () => this.audio.brickHit(true),
    );
    this.placedRig.update(dt, this.time, this.placed);
    this.updateDoors(dt);
    this.updateAtmosphere(dt);
    this.settleCamera(dt);

    if (this.caught > 0) {
      this.caught = Math.min(1, this.caught + dt * 1.4);
      if (this.caught >= 1 && this.phase === "playing") this.thrownOut();
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
    // Pip is eight. He is fast for eight and slow for a burglar, and the whole
    // battle is balanced on that: you cannot outrun them in a straight line,
    // only round a corner and over something you left on the floor.
    const top = running ? 5.1 : 2.55;

    /*
     * Move relative to where the camera is looking.
     *
     * The basis, written out, because getting a sign wrong here is invisible
     * in a screenshot and infuriating with a thumb on it — this shipped once
     * with *both* axes flipped, so pushing the stick forward walked him at the
     * camera and pushing right strafed left:
     *
     *   forward = ( sin(yaw), 0,  cos(yaw) )   — the way the lens points
     *   right   = (-cos(yaw), 0,  sin(yaw) )   — cross(forward, up)
     *
     * `iz` is screen-space down-positive (W and a stick pushed forward both
     * give -1), so forward is scaled by `-iz`.
     */
    const sin = Math.sin(this.camYaw);
    const cos = Math.cos(this.camYaw);
    const wx = sin * -iz + -cos * ix;
    const wz = cos * -iz + sin * ix;

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

    this.kid.root.position.copy(this.pos);
    this.kid.root.rotation.y = this.yaw;
    this.kid.update(dt, this.time, this.speed);
    /* The throw: the right arm goes over the top. It is applied *after*
       `update`, because the gait would otherwise overwrite it every frame —
       and a throw you cannot see is a button that does nothing. */
    if (this.throwT > 0) {
      const f = 1 - this.throwT; // 0 wind-up … 1 follow-through
      const swing = f < 0.35 ? -(f / 0.35) * 2.6 : -2.6 + ((f - 0.35) / 0.65) * 4.0;
      this.kid.limbs.rArm.rotation.x = swing;
      this.kid.limbs.rFore.rotation.x = -1.1 + f * 0.9;
      this.kid.body.rotation.y = -0.35 * Math.sin(f * Math.PI);
    }
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


  /* ---- the raid -------------------------------------------------------- */

  private startRaid() {
    this.stage = "raid";
    this.raidT = 0;
    this.grace = 3;
    this.placedRig.routes(null);
    this.flash("THEY'RE HERE", 2.4);
    this.speak(banterLine("kid", "enter") ?? "They're in.", 3);
    this.audio.doorbell();
    this.audio.playMusic("sneak", 0.3);
  }

  private spawnIntruder(a: Arrival) {
    const kind = INTRUDERS[a.who] ?? INTRUDERS.gus;
    const b = new Burglar(kind, a.entry, this.seat);
    const at = spawnPoint(a.entry, this.seat);
    this.seat++;
    const back = a.nerve !== undefined;
    if (!back) this.arrived++;
    b.spawn(at.x, at.y, at.z, at.yaw);
    if (a.nerve !== undefined) b.nerve = a.nerve;
    this.scene.add(b.char.root);
    this.burglars.push(b);
    b.speak(this.time, "enter", true);
    this.flash(
      back ? `${kind.name.toUpperCase()} IS BACK FOR MORE` : `${kind.name.toUpperCase()} · ${a.entry.toUpperCase()} DOOR`,
      2.2,
    );
    this.audio.creak(0.8);
  }

  /** The clock of a night: the planning countdown, then who arrives when. */
  private updateRaid(dt: number) {
    if (this.level.kind !== "night") return;
    if (this.stage === "plan") {
      this.planLeft = Math.max(0, this.planLeft - dt);
      if (this.planLeft <= 0) this.startRaid();
      return;
    }
    this.raidT += dt;
    while (this.queue.length && this.queue[0].at <= this.raidT) this.spawnIntruder(this.queue.shift()!);

    if (this.result) return;
    const left = this.burglars.some((b) => b.active) || this.queue.length > 0;
    const anything = [...this.lootState.values()].some((s) => s !== "gone");
    if (!anything) this.finishNight("THEY CLEANED YOU OUT");
    else if (!left) this.finishNight();
  }

  private finishNight(why?: string) {
    const kept = [...this.lootState.values()].filter((s) => s === "safe").length;
    this.result = scoreNight({
      lootKept: kept,
      lootTotal: LOOT.length,
      points: this.points,
      bestChain: this.bestChain,
      routed: this.routed,
      intruders: this.arrived,
      heartsLeft: this.hearts,
      partsLeft: this.parts,
    });
    const key = `n${this.level.n}`;
    if (this.result.won && this.result.score > (this.bestScores[key] ?? 0)) {
      this.bestScores[key] = this.result.score;
      try {
        localStorage.setItem("houserules:best", JSON.stringify(this.bestScores));
      } catch {
        /* private browsing; the score still counts for this session */
      }
    }
    if (this.result.won) {
      this.flash("THEY'RE GONE", 2.6);
      this.win();
    } else {
      this.lose(why ?? (this.hearts <= 0 ? "CAUGHT ONE TIME TOO MANY" : "THEY CLEANED YOU OUT"));
    }
  }

  /* ---- intruders ------------------------------------------------------- */

  private ctx: WorldCtx | null = null;

  private worldCtx(): WorldCtx {
    if (this.ctx) return this.ctx;
    this.ctx = {
      colliders: this.world.colliders,
      litAt: (x, y, z) => {
        const room = roomAt(x, y, z);
        return room ? !!this.world.roomLights.get(room.id)?.on : false;
      },
      pickLoot: (b) => {
        if (this.stage !== "raid") return null;
        const from = nearestNode(b.pos.x, b.pos.y, b.pos.z).id;
        let best: { id: string; node: string } | null = null;
        let bestLen = Infinity;
        for (const l of LOOT) {
          if (this.lootState.get(l.id) !== "safe") continue;
          if (this.burglars.some((o) => o !== b && o.active && o.lootId === l.id)) continue;
          const len = pathLength(pathBetween(from, l.node));
          if (len < bestLen) {
            bestLen = len;
            best = { id: l.id, node: l.node };
          }
        }
        return best;
      },
      spotTrap: (b) => {
        const eye = new THREE.Vector3(b.pos.x, b.pos.y + b.char.eyeY, b.pos.z);
        let best: Placed | null = null;
        let bestD = 3.4;
        for (const p of this.placed) {
          if (KIT[p.kind].hidden || p.usesLeft <= 0) continue;
          if (Math.abs(p.y - b.pos.y) > 1.2) continue;
          const d = Math.hypot(p.x - b.pos.x, p.z - b.pos.z);
          if (d >= bestD) continue;
          // She has to be able to see it: the light on, and nothing in between.
          const room = roomAt(p.x, p.y + 0.3, p.z);
          if (!room || !this.world.roomLights.get(room.id)?.on) continue;
          if (!clearLine(eye, new THREE.Vector3(p.x, p.y + 0.3, p.z), this.world.colliders)) continue;
          best = p;
          bestD = d;
        }
        return best;
      },
      onGrab: (b, lootId) => {
        this.lootState.set(lootId, "taken");
        const l = LOOT.find((x) => x.id === lootId);
        this.flash(`${b.name.toUpperCase()} HAS ${(l?.name ?? "something").toUpperCase()}`, 2.4);
        this.audio.chime(false);
      },
      onDisarm: (b, trapId) => {
        const p = this.placed.find((x) => x.id === trapId);
        if (!p) return;
        this.removeTrap(p);
        this.flash(`${b.name.toUpperCase()} TOOK YOUR ${KIT[p.kind].name.toUpperCase()} APART`, 2.6);
        this.audio.clatter();
      },
      onGone: (b) => {
        if (b.carrying) {
          this.lootState.set(b.carrying, "gone");
          const l = LOOT.find((x) => x.id === b.carrying);
          this.flash(`${b.name.toUpperCase()} GOT AWAY WITH ${(l?.name ?? "something").toUpperCase()}`, 2.8);
          this.audio.chime(false);
          b.carrying = null;
          // One trip is never enough. He drops it in the van and comes back,
          // exactly as rattled as he left, for as long as there is anything
          // to come back for. The only way to end a night is to scare them.
          const more = [...this.lootState.values()].some((s) => s === "safe");
          if (this.level.kind === "night" && more && b.nerve > 0) {
            this.queue.push({ who: b.kind.id, entry: b.entry, at: this.raidT + 7, nerve: b.nerve });
            this.queue.sort((x, y) => x.at - y.at);
          }
        } else if (b.nerve <= 0) {
          this.routed++;
        }
      },
    };
    return this.ctx;
  }

  private updateBurglars(dt: number) {
    if (!this.burglars.length) {
      this.danger += (0 - this.danger) * Math.min(1, dt * 3);
      return;
    }
    const ctx = this.worldCtx();
    this.grace = Math.max(0, this.grace - dt);
    const hidden = this.grace > 0 || this.spectator;
    const aggression = this.level.night?.aggression ?? 0.5;
    let worst = 0;

    for (const b of this.burglars) {
      if (!b.active) continue;
      if (b.flung) this.advanceFling(b, dt);
      b.update(dt, this.time, this.pos, ctx, { aggression, playerHidden: hidden });
      if (!b.active) continue;
      // A flight arcs. The body is the engine's to move, so the arc is too.
      if (b.flung && b.flung.mode === "fly") {
        const f = 1 - b.flung.left / Math.max(0.01, b.flung.total);
        b.char.root.position.y += Math.sin(f * Math.PI) * Math.min(1.1, b.flung.total * 0.2);
      }
      worst = Math.max(worst, b.proximity);

      // Footsteps, attenuated by distance. This is most of the tension: you
      // hear where they are long before you see them.
      if (b.upright) {
        const d = b.pos.distanceTo(this.pos);
        if (d < 16 && Math.random() < dt * (b.state === "hunt" ? 5.5 : 3.2)) this.audio.thud(d * 0.55);
      }

      // Whatever he has just walked onto.
      if (b.upright) {
        const p = this.trapUnder(b, null);
        if (p) this.fireTrap(p, b);
      }

      // Caught. Anybody still on his feet and still in the fight, not just one
      // who has seen you: walking into somebody's back in a dark corridor has
      // to count, or the safest place in the house is behind him.
      const grabby =
        b.upright && b.state !== "flee" && b.state !== "carry" && b.blind <= 0 && this.grace <= 0 && !this.spectator;
      if (grabby && this.caught <= 0 && this.zipRide < 0) {
        const d = Math.hypot(b.pos.x - this.pos.x, b.pos.z - this.pos.z);
        if (d < 0.85 && Math.abs(b.pos.y - this.pos.y) < 1.4) {
          this.caught = 0.01;
          this.caughtBy = b;
          b.speak(this.time, "gotcha", true);
          this.kid.setScream(true);
          this.audio.scream();
        }
      }
    }

    this.danger += (worst - this.danger) * Math.min(1, dt * 3);

    // Anybody who walked out with something is finished with this body; he
    // comes back as a new arrival. Only the routed stay, for the list.
    if (this.burglars.some((b) => !b.active && b.nerve > 0)) {
      this.burglars = this.burglars.filter((b) => {
        if (b.active || b.nerve <= 0) return true;
        this.scene.remove(b.char.root);
        b.dispose();
        return false;
      });
    }
  }

  /**
   * Somebody had hold of you. On a night that costs a heart and puts you back
   * in your own room with a few seconds' head start; in the sandbox it costs
   * nothing, because the sandbox is for finding out what things do.
   */
  private thrownOut() {
    const by = this.caughtBy;
    this.caught = 0;
    this.caughtBy = null;
    this.kid.setScream(false);
    if (this.level.kind === "night") {
      this.hearts--;
      if (this.hearts <= 0) {
        this.finishNight();
        return;
      }
      this.flash(this.hearts === 1 ? "CAUGHT. ONE MORE AND IT'S OVER" : `CAUGHT. ${this.hearts} LEFT`, 2.6);
    } else {
      this.flash("CAUGHT", 1.8);
    }
    const home = node("u_kid");
    this.pos.set(home.x, home.y + 0.05, home.z);
    this.vel.set(0, 0, 0);
    this.grace = 4;
    if (by) by.hear(by.pos.x, by.pos.y, by.pos.z, 1);
    this.settleCamera(0.999);
  }

  /* ---- traps going off -------------------------------------------------- */

  private liveChain(b: Burglar) {
    return this.time < b.chainUntil ? b.chain : 0;
  }

  /** A trap he is standing in that is ready to go, other than `not`. */
  private trapUnder(b: Burglar, not: number | null): Placed | null {
    for (const p of this.placed) {
      if (p.id === not || p.usesLeft <= 0 || p.cool > 0) continue;
      const r = KIT[p.kind].radius;
      if (r <= 0) continue;
      if (Math.abs(p.y - b.pos.y) > 1.3) continue;
      if (Math.hypot(p.x - b.pos.x, p.z - b.pos.z) > r) continue;
      return p;
    }
    return null;
  }

  private fireTrap(p: Placed, b: Burglar) {
    const def = KIT[p.kind];
    p.usesLeft--;
    p.cool = def.rearm;
    p.firing = 1;
    this.placedRig.burst(p);
    this.trapSound(p.kind);

    if (def.effect === "blind") {
      // Everybody in the cloud, not just whoever set it off.
      for (const o of this.burglars) {
        if (!o.active || Math.abs(o.pos.y - p.y) > 1.6) continue;
        if (o !== b && Math.hypot(o.pos.x - p.x, o.pos.z - p.z) > def.area) continue;
        const out = resolveTrap(def, p.yaw, { hx: 0, hz: 0, heavy: false, rooted: false, chain: this.liveChain(o) });
        o.blind = out.blind;
        this.link(o, def.name, out.damage, 0, out.chain, out.score, []);
      }
      return;
    }

    const { hx, hz } = b.heading();
    const out = resolveTrap(def, p.yaw, {
      hx, hz, heavy: b.kind.heavy, rooted: b.rooted > 0, chain: this.liveChain(b),
    });
    if (out.root > 0) b.rooted = out.root;
    else b.rooted = 0;
    this.link(b, def.name, out.damage, out.stun, out.chain, out.score, out.tricks);
    // Glue is a set-up, so the chain waits for as long as he is stuck in it.
    if (out.root > 0) b.chainUntil = this.time + out.root + 1;
    if (out.dist > 0 && out.mode) this.startFling(b, out.tx, out.tz, out.dist, out.mode, p.id);
  }

  /**
   * One more link in somebody's chain: the bookkeeping every hit shares,
   * whether it was a trap, a wall, the stairs or a snowball.
   */
  private link(b: Burglar, label: string, damage: number, stun: number, chain: number, score: number, tricks: Trick[]) {
    b.chain = chain;
    b.chainUntil = this.time + CHAIN_WINDOW;
    this.dropLoot(b);
    b.hit(stun, damage);
    this.points += score;
    this.bestChain = Math.max(this.bestChain, chain);
    this.audio.yell(b.kind.rig);
    b.speak(this.time, "trap", true);

    // The running commentary: one line per chain, growing as it grows.
    const text = [label, ...tricks].join(" + ");
    let line = this.feed.find((f) => f.who === b && this.time < f.until && chain > 1);
    if (!line) {
      line = { id: this.feedId++, who: b, parts: [], chain: 0, until: 0 };
      this.feed.push(line);
      if (this.feed.length > 5) this.feed.shift();
    }
    line.parts.push(text);
    line.chain = chain;
    line.until = this.time + CHAIN_WINDOW;

    if (chain >= 2) {
      this.flash(`${chain}x CHAIN`, 1.8);
      this.audio.chime(true);
      if (chain === 2 || chain === 4) this.speak(banterLine("kid", "chain") ?? "Yes!", 2.6);
    } else if (stun > 0) {
      this.flash(`${label.toUpperCase()} · ${b.name.toUpperCase()} IS DOWN`, 1.8);
    }
    if (b.nerve <= 0) this.flash(`${b.name.toUpperCase()} HAS HAD ENOUGH`, 2.4);

    // Every hit pays for a little more mischief, and a proper chain for a
    // little more than that. It is what keeps the second half of a raid from
    // being a kid with an empty box.
    if (this.level.kind === "night") this.parts = Math.min(40, this.parts + (chain === 3 ? 2 : 1));
    // The others come running. That is the price of a trap going off, and
    // quite often it is also the next link.
    for (const o of this.burglars) if (o !== b) o.hear(b.pos.x, b.pos.y, b.pos.z, 13);
  }

  /** A slam, a tumble, a collision: a link that is not a trap. */
  private trick(b: Burglar, trick: Trick) {
    const r = resolveTrick(trick, this.liveChain(b));
    this.placedRig.thump(b.pos.x, b.pos.y, b.pos.z);
    this.audio.thud(0.2);
    if (trick === "WALL SLAM") this.audio.clang();
    this.link(b, trick, r.damage, 2.6, r.chain, r.score, []);
  }

  private dropLoot(b: Burglar) {
    if (!b.carrying) return;
    this.lootState.set(b.carrying, "safe");
    b.carrying = null;
    if (b.state === "carry") b.state = "prowl";
  }

  private removeTrap(p: Placed) {
    this.placedRig.remove(p.id);
    const i = this.placed.indexOf(p);
    if (i >= 0) this.placed.splice(i, 1);
    if (this.pickable === p) this.pickable = null;
  }

  private trapSound(kind: KitKind) {
    switch (kind) {
      case "marbles": this.audio.clatter(); this.audio.slip(); break;
      case "slick": this.audio.slip(); break;
      case "tripwire": this.audio.tick(); this.audio.thud(0.4); break;
      case "glue": this.audio.slip(); break;
      case "spring": this.audio.boing(); break;
      case "sack": this.audio.whoosh(); break;
      case "flour": this.audio.poof(); break;
      case "clock": this.audio.alarm(); break;
    }
  }

  /** Cooldowns and animations; a trap with nothing left in it is cleared away. */
  private updateTraps(dt: number) {
    for (let i = this.placed.length - 1; i >= 0; i--) {
      const p = this.placed[i];
      p.cool = Math.max(0, p.cool - dt);
      p.firing = Math.max(0, p.firing - dt * (p.kind === "clock" ? 0.3 : 1.1));
      if (p.usesLeft <= 0 && p.firing <= 0) this.removeTrap(p);
    }
    if (this.hint && this.time > this.hintUntil) this.hint = null;
  }

  /* ---- being thrown ------------------------------------------------------ */

  /** The flight of stairs somebody is standing part-way up, if any. */
  private rampUnder(x: number, y: number, z: number): Ramp | null {
    for (const r of this.world.ramps) {
      const h = rampHeight(r, x, z);
      if (h === null || Math.abs(h - y) > 0.5) continue;
      // Not at the very foot: there is nowhere left to fall from there.
      if (h < r.yLow + 0.4) continue;
      return r;
    }
    return null;
  }

  private startFling(b: Burglar, tx: number, tz: number, dist: number, mode: "slide" | "fly", from: number | null) {
    // On a flight of stairs there is only one way to go, and it is down.
    const ramp = this.rampUnder(b.pos.x, b.pos.y, b.pos.z);
    if (ramp) {
      const down = -ramp.dir;
      if (ramp.axis === "z") {
        tx = 0;
        tz = down;
        dist = Math.max(dist, Math.abs((down > 0 ? ramp.z1 : ramp.z0) - b.pos.z) + 0.9);
      } else {
        tx = down;
        tz = 0;
        dist = Math.max(dist, Math.abs((down > 0 ? ramp.x1 : ramp.x0) - b.pos.x) + 0.9);
      }
      mode = "slide";
    }
    b.fling({ tx, tz, left: dist, total: dist, mode, startY: b.pos.y, from });
  }

  /**
   * Carry a thrown body along its throw, twelve centimetres at a time, and
   * find out what it hits. This is where chains actually happen.
   */
  private advanceFling(b: Burglar, dt: number) {
    const f = b.flung;
    if (!f) return;
    // Slow enough to watch. A chain that is over in half a second is a number
    // going up; one that takes three is a man crossing the hall on his back.
    let move = Math.min(f.left, (f.mode === "fly" ? 6.2 : 4.6) * dt);
    const STEP = 0.12;
    while (move > 1e-4) {
      const s = Math.min(STEP, move);
      const nx = b.pos.x + f.tx * s;
      const nz = b.pos.z + f.tz * s;

      // A wall, a sofa, a kitchen counter. All the same to a man in the air.
      if (this.blocked(nx, b.pos.y + 0.55, nz)) {
        const hard = f.left > 0.9;
        this.endFling(b, f);
        if (hard) this.trick(b, "WALL SLAM");
        return;
      }
      // A colleague.
      for (const o of this.burglars) {
        if (o === b || !o.upright || Math.abs(o.pos.y - b.pos.y) > 1.2) continue;
        if (Math.hypot(o.pos.x - nx, o.pos.z - nz) > 0.7) continue;
        const rest = f.left * 0.7;
        const { tx, tz } = f;
        const chain = this.liveChain(b);
        this.endFling(b, f);
        this.trick(b, "BOWLING");
        // He joins the chain that hit him, rather than starting his own.
        o.chain = Math.max(this.liveChain(o), chain);
        o.chainUntil = this.time + CHAIN_WINDOW;
        this.trick(o, "BOWLING");
        if (rest > 0.6) this.startFling(o, tx, tz, o.kind.heavy ? rest * 0.5 : rest, "slide", null);
        return;
      }

      b.pos.x = nx;
      b.pos.z = nz;
      const g = this.groundAt(nx, nz, b.pos.y + 0.35);
      if (g > -20) b.pos.y = g;
      f.left -= s;
      move -= s;

      // Whatever he has just been thrown onto. Not the thing that threw him.
      const p = this.trapUnder(b, f.from);
      if (p) {
        const fell = f.startY - b.pos.y > 1.0;
        b.flung = null;
        if (fell) this.trick(b, "TUMBLE");
        this.fireTrap(p, b);
        return;
      }
    }
    if (f.left <= 1e-3) this.endFling(b, f);
  }

  private endFling(b: Burglar, f: NonNullable<Burglar["flung"]>) {
    b.flung = null;
    // He started this upstairs and finished it down here.
    if (f.startY - b.pos.y > 1.0) this.trick(b, "TUMBLE");
  }

  /* ---- placing ------------------------------------------------------------ */

  /** Work out where the thing in your hand would go, and show it. */
  private updateGhost() {
    const kind = this.phase === "playing" && this.caught <= 0 && this.zipRide < 0 ? this.selected : null;
    if (!kind) {
      this.placedRig.ghost(null, 0, 0, 0, 0, false);
      return;
    }
    const g = this.ghost;
    g.yaw = this.camYaw;
    g.x = this.pos.x + Math.sin(this.camYaw) * REACH;
    g.z = this.pos.z + Math.cos(this.camYaw) * REACH;
    const floor = this.groundAt(g.x, g.z, this.pos.y + STEP_UP);
    g.y = floor > -20 ? floor : this.pos.y;

    let problem: PlaceProblem = null;
    if (floor < -20 || Math.abs(floor - this.pos.y) > 0.75) problem = "air";
    else if (
      this.blocked(g.x, g.y + 0.4, g.z) ||
      this.blocked((g.x + this.pos.x) / 2, g.y + 0.6, (g.z + this.pos.z) / 2)
    ) problem = "wall";
    else if (this.burglars.some((b) => b.upright && b.pos.distanceTo(this.pos) < 2.4)) problem = "busy";
    else problem = placeProblem(kind, g, this.placed, this.parts);
    g.problem = problem;
    this.placedRig.ghost(kind, g.x, g.y, g.z, g.yaw, !problem);
  }

  /** Where each valuable is right now: on its spot, or on somebody's back. */
  private updateLoot() {
    for (const l of LOOT) {
      const state = this.lootState.get(l.id);
      const carrier = this.burglars.find((b) => b.carrying === l.id);
      if (carrier) {
        this.placedRig.loot(l.id, carrier.pos.x, carrier.char.root.position.y + carrier.char.height + 0.35, carrier.pos.z, true, true);
        continue;
      }
      const n = node(l.node);
      this.placedRig.loot(l.id, n.x, n.y + 1.3, n.z, state === "safe", false);
    }
  }

  /* ---- level rules ---------------------------------------------------- */

  private updateLevel(dt: number) {
    const L = this.level;
    if (L.time) {
      this.levelTime = Math.max(0, this.levelTime - dt);
    }

    // On the quiet levels the kid narrates his own house.
    if ((L.kind === "explore" || L.kind === "lights") && this.time > this.lastChatter && this.caught <= 0) {
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
      case "night":
      case "roam": {
        // The arrow points at whoever is walking out with something.
        let best: Burglar | null = null;
        let bestD = Infinity;
        for (const b of this.burglars) {
          if (!b.active || !b.carrying) continue;
          const d = b.pos.distanceTo(this.pos);
          if (d < bestD) {
            bestD = d;
            best = b;
          }
        }
        const what = best ? LOOT.find((l) => l.id === best!.carrying)?.name : null;
        this.compassTarget = best
          ? { x: best.pos.x, y: best.pos.y, z: best.pos.z, label: `${best.name} has ${what ?? "something"}` }
          : null;
        break;
      }
      default:
        this.compassTarget = null;
    }
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

  /* ---- interaction ----------------------------------------------------- */

  private updateInteract() {
    let best: Interactable | null = null;
    let bestD = Infinity;
    for (const it of this.interactables) {
      if (it.done) continue;
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

    // A trap at your feet can be picked back up, as long as your hands are empty.
    let pick: Placed | null = null;
    if (!this.selected) {
      let pickD = 1.15;
      for (const p of this.placed) {
        if (p.usesLeft <= 0 || p.firing > 0 || Math.abs(p.y - this.pos.y) > 1.0) continue;
        const d = Math.hypot(p.x - this.pos.x, p.z - this.pos.z);
        if (d < pickD) {
          pickD = d;
          pick = p;
        }
      }
    }
    this.pickable = pick;

    if (!this.actionQueued) return;
    this.actionQueued = false;

    // With something in your hand, the action button lays it.
    if (this.selected) {
      this.place();
      return;
    }
    if (pick) {
      const def = KIT[pick.kind];
      // Untouched, you get all of it back. Used once, you get half.
      const refund = pick.usesLeft >= def.uses ? def.cost : Math.floor(def.cost / 2);
      if (this.level.kind !== "roam") this.parts += refund;
      this.removeTrap(pick);
      this.audio.tick();
      return;
    }
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
      case "zip": {
        if (this.zipRide >= 0) break;
        this.zipRide = 0;
        this.audio.slip();
        this.speak("Whoa!", 2.4);
        break;
      }
    }
  }

  /** The wire: four seconds, on rails, and nobody can catch you on it. */
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
    this.kid.root.position.copy(this.pos);
    this.kid.root.rotation.y = this.yaw;
    this.kid.limbs.lArm.rotation.x = -2.6;
    this.kid.limbs.rArm.rotation.x = -2.6;
    this.kid.update(dt, this.time, 0);
    this.kid.limbs.lArm.rotation.x = -2.6;
    this.kid.limbs.rArm.rotation.x = -2.6;
    if (f >= 1) {
      this.zipRide = -1;
      // Land him *on the deck*, explicitly. Dropping him at the wire's height
      // and letting gravity find the boards works right up until it doesn't,
      // and when it doesn't he falls out of the world.
      const deck = this.groundAt(this.pos.x, this.pos.z, ZIP_END.y + 1.0);
      this.pos.y = deck > -20 ? deck : ZIP_END.y;
      this.vel.set(0, 0, 0);
      this.grounded = true;
      // Whoever was chasing has lost him, and knows it.
      this.grace = Math.max(this.grace, 2.5);
      this.speak("Made it. Back in through the yard.", 3);
    }
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
      this.world.tv.map = T.tvFrame(frame);
      this.world.tv.needsUpdate = true;
      this.world.tvGlow.intensity = frame === 1 ? 11 : 4.5;
    }
    this.tauntCd = Math.max(0, this.tauntCd - dt);
    this.throwCd = Math.max(0, this.throwCd - dt);
    const wasThrowing = this.throwT > 0;
    this.throwT = Math.max(0, this.throwT - dt * 2.6);
    // He reaches for the next one the moment the last has left.
    if (wasThrowing && this.throwT <= 0) this.kid.setBrick(true);

    this.world.cullLights(this.pos.x, this.pos.y, this.pos.z);
  }

  /**
   * Boom camera behind Pip, pulled in whenever the house is in the way.
   *
   * Indoors this matters more than anything else about the camera: without it
   * the lens sits in the dining room while you stand in the kitchen and you
   * play the level looking at the back of a wall.
   */
  private settleCamera(dt: number) {
    // Aim at his shoulders, derived from his actual height rather than a
    // magic number — the day he got 4 cm taller the magic number was wrong.
    const headY = this.pos.y + this.kid.height * 0.86;
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
    const dist = this.shotDist ?? (this.zipRide >= 0 ? Math.max(5.4, this.camBoom) : this.camBoom);
    const dir = new THREE.Vector3(
      Math.sin(this.camYaw) * Math.cos(this.camPitch),
      // Positive pitch is UP. The first cut had this negated, so dragging up
      // the screen tipped the view down — which is the one control complaint
      // that makes a game feel broken rather than unfamiliar.
      Math.sin(this.camPitch),
      Math.cos(this.camYaw) * Math.cos(this.camPitch),
    );
    // The boom points *behind* him: from his head, backwards along his view.
    const back = dir.clone().multiplyScalar(-1);
    let d = dist;
    const hit = this.rayHit(focus, back, dist + 0.35);
    // 0.45 rather than a comfortable metre: in a 1.6 m corridor there is no
    // comfortable metre, and a boom that refuses to shorten puts the lens in
    // the wall instead. Below 0.95 Pip is hidden, so it degrades into a
    // first-person view rather than a close-up of the back of his head.
    if (hit !== null && this.shotDist === null) d = Math.max(0.45, hit - 0.28);
    this.camDist += (d - this.camDist) * Math.min(1, dt * (d < this.camDist ? 26 : 6));
    this.kid.root.visible = this.camDist > 0.9 || this.zipRide >= 0 || this.shotDist !== null;

    const want = focus.clone().addScaledVector(back, this.camDist);
    // The lift is proportional to the boom. A fixed 42 cm is a gentle
    // over-the-shoulder angle at three metres and a view of the top of his
    // head at half a metre, which is exactly where a wall puts you.
    want.y += Math.min(0.42, this.camDist * 0.15);
    this.camPos.lerp(want, Math.min(1, dt * 16));
    this.camLook.lerp(focus.clone().addScaledVector(dir, 2.2), Math.min(1, dt * 14));
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
  }

  /** Is a point inside a wall? Used by the bricks to bounce off things. */
  blocked(x: number, y: number, z: number) {
    for (const c of this.world.colliders) {
      if (x < c.x0 || x > c.x1 || z < c.z0 || z > c.z1) continue;
      if (y < c.y0 || y > c.y1) continue;
      return true;
    }
    return false;
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
    this.selected = null;
    this.audio.playMusic("home", 0.4);
    this.audio.chime(true);
    if (this.level.kind === "night" && this.level.n > this.cleared) {
      this.cleared = this.level.n;
      try {
        localStorage.setItem("houserules:cleared", String(this.cleared));
      } catch {
        /* private browsing; the run still counts for this session */
      }
    }
    this.emit();
  }

  private lose(why: string) {
    if (this.phase === "lost") return;
    this.phase = "lost";
    this.selected = null;
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
      if (e.code === "Space") {
        this.throwBrick();
        e.preventDefault();
      }
      if (e.code === "KeyF") {
        this.place();
        e.preventDefault();
      }
      if (e.code === "KeyR") this.ring();
      if (e.code === "KeyG") this.ready();
      if (e.code === "KeyB") this.callIn();
      if (e.code === "Escape" || e.code === "Digit0") {
        if (this.selected) this.selectKit(null);
      }
      const digit = /^Digit([1-8])$/.exec(e.code);
      if (digit) {
        const k = this.kitNow()[Number(digit[1]) - 1];
        if (k) this.selectKit(k);
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
      // With the mouse captured, a click lays whatever is in your hand.
      if (this.phase === "playing" && this.pointerLocked && this.selected) this.place();
      if (this.phase === "playing" && !this.pointerLocked && !("ontouchstart" in window))
        canvas.requestPointerLock?.();
    };
    canvas.addEventListener("click", onClick);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("pointerlockchange", onLock);

    /*
     * Touch, all of it, owned here rather than by the HUD.
     *
     * The HUD used to hold a fixed joystick pad in the corner and the canvas
     * held the look-drag, which produced three separate miseries on a phone: a
     * thumb that landed a centimetre outside the pad did nothing, a drag that
     * began on the left half was ignored entirely, and there was no way at all
     * to reach a second finger for zoom. One owner, three rules:
     *
     *   left 45%   — a *floating* stick. Its centre is wherever your thumb
     *                lands, so it is never in the wrong place.
     *   right 55%  — look.
     *   two fingers — pinch to zoom, and neither of the other two runs while
     *                a pinch is live.
     *
     * Buttons are real DOM elements above the canvas, so their pointerdowns
     * never reach these handlers at all.
     */
    const STICK_RADIUS = 68;
    const tStart = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      this.audio.resume();
      const left = e.clientX < window.innerWidth * 0.45;
      if (left && this.stickId === null) {
        this.stickId = e.pointerId;
        this.stickOrigin = { x: e.clientX, y: e.clientY };
        this.stickAt = { x: e.clientX, y: e.clientY };
      } else if (this.lookId === null) {
        this.lookId = e.pointerId;
        this.dragLast = { x: e.clientX, y: e.clientY };
      }
      this.livePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.livePointers.size === 2) {
        const [a, b] = [...this.livePointers.values()];
        this.pinchFrom = Math.hypot(a.x - b.x, a.y - b.y);
      }
      e.preventDefault();
    };
    const tMove = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      if (!this.livePointers.has(e.pointerId)) return;
      this.livePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this.livePointers.size >= 2 && this.pinchFrom !== null) {
        const [a, b] = [...this.livePointers.values()];
        const now = Math.hypot(a.x - b.x, a.y - b.y);
        if (now > 8 && this.pinchFrom > 8) {
          this.zoom(this.pinchFrom / now);
          this.pinchFrom = now;
        }
        return;
      }
      if (e.pointerId === this.stickId) {
        this.stickAt = { x: e.clientX, y: e.clientY };
        let dx = (e.clientX - this.stickOrigin.x) / STICK_RADIUS;
        let dy = (e.clientY - this.stickOrigin.y) / STICK_RADIUS;
        const m = Math.hypot(dx, dy);
        if (m > 1) {
          dx /= m;
          dy /= m;
        }
        // A dead zone big enough that a resting thumb does not creep, and
        // small enough that a deliberate nudge still registers.
        this.stick.x = m < 0.18 ? 0 : dx;
        this.stick.y = m < 0.18 ? 0 : dy;
      } else if (e.pointerId === this.lookId) {
        this.look((e.clientX - this.dragLast.x) * 0.0052, (e.clientY - this.dragLast.y) * 0.0044);
        this.dragLast = { x: e.clientX, y: e.clientY };
      }
    };
    const tEnd = (e: PointerEvent) => {
      this.livePointers.delete(e.pointerId);
      if (this.livePointers.size < 2) this.pinchFrom = null;
      if (e.pointerId === this.stickId) {
        this.stickId = null;
        this.stick.x = 0;
        this.stick.y = 0;
      }
      if (e.pointerId === this.lookId) this.lookId = null;
    };
    canvas.addEventListener("pointerdown", tStart);
    window.addEventListener("pointermove", tMove);
    window.addEventListener("pointerup", tEnd);
    window.addEventListener("pointercancel", tEnd);

    // Desktop zoom. Trackpad pinches arrive here as ctrl+wheel.
    const onWheel = (e: WheelEvent) => {
      if (this.phase !== "playing") return;
      e.preventDefault();
      this.zoom(1 + Math.sign(e.deltaY) * 0.12);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });

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
      canvas.removeEventListener("wheel", onWheel);
    };
  }

  private unbind: () => void = () => {};


  /* ---- snapshot ---------------------------------------------------------- */

  /**
   * The current state, as the HUD sees it.
   *
   * Public rather than private because `tools/homealone-play.mjs` drives the
   * whole game through it: asserting on the same numbers the player is shown
   * is the only way to know a night can actually be finished.
   */
  snapshot(): Snapshot {
    const room = roomAt(this.pos.x, this.pos.y, this.pos.z);
    const L = this.level;
    const trapGame = L.kind === "night" || L.kind === "roam";

    let done = 0;
    let total = 0;
    if (L.kind === "explore") {
      done = this.beaconsHit.size;
      total = L.beacons?.length ?? 0;
    } else if (L.kind === "lights") {
      const rooms = L.streetRooms ?? [];
      done = rooms.filter((r) => this.world.roomLights.get(r)?.on).length;
      total = rooms.length;
    } else if (L.kind === "night") {
      done = this.routed;
      total = L.night?.arrivals.length ?? 0;
    }

    let compass: number | null = null;
    let compassDist = 0;
    if (this.compassTarget) {
      const dx = this.compassTarget.x - this.pos.x;
      const dz = this.compassTarget.z - this.pos.z;
      compassDist = Math.hypot(dx, dz);
      compass = Math.atan2(dx, dz) - this.camYaw;
    }

    // What the action button would do, in the order `updateInteract` tries.
    let action: string | null = null;
    if (this.phase === "playing") {
      if (this.selected) {
        action = this.ghost.problem ? null : `Lay ${KIT[this.selected].name}`;
      } else if (this.pickable) {
        action = `Pick up ${KIT[this.pickable.kind].name}`;
      } else if (this.nearest) {
        // Verb first, room second. "Turn on the ${name}" cannot be made to
        // read for all sixteen: the names carry their own articles and
        // possessives, so it produces "the the den". This shape works for
        // every one.
        action =
          this.nearest.kind === "switch"
            ? `${this.world.roomLights.get(this.nearest.room!)?.on ? "Lights off" : "Lights on"}: ${ROOMS[this.nearest.room!].name}`
            : this.nearest.label;
      }
    }

    const kinds = this.kitNow();
    const kit: KitSlot[] = kinds.map((k, i) => ({
      kind: k,
      name: KIT[k].name,
      icon: KIT[k].icon,
      cost: KIT[k].cost,
      blurb: KIT[k].blurb,
      affordable: L.kind === "roam" || this.parts >= KIT[k].cost,
      selected: this.selected === k,
      key: i + 1,
    }));

    // Somebody who walked out with an armful is not "gone", he is on his way
    // back, and he is in the queue below. Only the routed stay on the list.
    const intruders: IntruderState[] = this.burglars
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.active || b.nerve <= 0)
      .map(({ b, i }) => ({
      id: i,
      name: b.name,
      nerve: Math.max(0, Math.round((b.nerve / b.kind.nerve) * 100)),
      state: b.state,
      down: b.state === "down",
      says: b.says,
      carrying: b.carrying ? (LOOT.find((l) => l.id === b.carrying)?.name ?? null) : null,
      status: b.flung ? "flying" : b.rooted > 0 ? "stuck" : b.blind > 0 ? "blind" : null,
      entry: b.entry,
      eta: 0,
      voice: b.kind.rig,
    }));
    // The ones who have not turned up yet, so the list is the whole night.
    this.queue.forEach((a, i) => {
      const kind = INTRUDERS[a.who] ?? INTRUDERS.gus;
      intruders.push({
        id: 100 + i,
        name: kind.name,
        nerve: 100,
        state: "waiting",
        down: false,
        says: null,
        carrying: null,
        status: null,
        entry: a.entry,
        eta: Math.max(0.1, this.stage === "plan" ? this.planLeft + a.at : a.at - this.raidT),
        voice: kind.rig,
      });
    });

    const night = L.night;
    return {
      phase: this.phase,
      level: L.n,
      title: L.title,
      brief: L.brief,
      goal: L.goal,
      kind: L.kind,
      room: room?.name ?? (this.pos.z > 8 ? "Juniper Lane" : this.pos.z < -8 ? "The Back Yard" : "Outside"),
      action,
      say: this.time < this.sayUntil ? this.say : null,
      banner: this.time < this.bannerUntil ? this.banner : null,
      timeLeft: L.time ? this.levelTime : null,
      done,
      total,
      compass,
      compassLabel: this.compassTarget?.label ?? null,
      compassDist,
      danger: this.danger,
      suspicion: this.suspicion,
      caught: this.caught,
      running: this.sprintHeld || this.keys.has("ShiftLeft"),
      cleared: this.cleared,
      tauntCooldown: this.tauntCd,
      stick:
        this.stickId !== null
          ? { ox: this.stickOrigin.x, oy: this.stickOrigin.y, x: this.stickAt.x, y: this.stickAt.y }
          : null,
      boom: this.camBoom,
      brickCooldown: this.throwCd,
      invertLook: this.invertLook,

      stage: this.stage,
      planLeft: this.planLeft,
      parts: this.parts,
      sandbox: L.kind === "roam",
      kit,
      placeHint: this.hint ?? (this.selected && this.ghost.problem ? PLACE_PROBLEM_TEXT[this.ghost.problem] : null),
      laid: this.placed.length,
      clocks: this.placed.filter((p) => p.kind === "clock" && p.usesLeft > 0 && p.cool <= 0).length,
      intruders,
      loot: trapGame
        ? LOOT.map((l) => ({ id: l.id, name: l.name, state: this.lootState.get(l.id) ?? "safe" }))
        : [],
      hearts: this.hearts,
      score: this.points,
      bestChain: this.bestChain,
      feed: this.feed.map((f) => ({
        id: f.id,
        who: f.who.name,
        text: f.parts.join(" → "),
        chain: f.chain,
        hot: this.time < f.until,
      })),
      result: this.result,
      cast: night
        ? night.arrivals.map((a) => {
            const k = INTRUDERS[a.who] ?? INTRUDERS.gus;
            return { name: k.name, trait: k.trait, entry: a.entry };
          })
        : [],
      newKit: L.kind === "night" ? newKitOn(L.n, KIT).map((k) => ({ name: KIT[k].name, icon: KIT[k].icon, blurb: KIT[k].blurb })) : [],
      hasNext: L.kind === "night",
      bestScore: this.bestScores[`n${L.n}`] ?? 0,
    };
  }

  /** Test hooks: where everybody is, in numbers. */
  debug() {
    return {
      pos: { x: this.pos.x, y: this.pos.y, z: this.pos.z },
      camYaw: this.camYaw,
      placed: this.placed.map((p) => ({ ...p })),
      paths: (["front", "back"] as Entry[]).map((entry) => ({
        entry,
        to: LOOT.map((l) => ({
          id: l.id,
          points: pathBetween(entryNode(entry), l.node).map((n) => ({ x: n.x, y: n.y, z: n.z })),
        })),
      })),
      burglars: this.burglars.map((b) => ({
        name: b.name, state: b.state, x: b.pos.x, y: b.pos.y, z: b.pos.z, nerve: b.nerve,
        carrying: b.carrying, lootId: b.lootId, chain: b.chain, flung: !!b.flung,
      })),
    };
  }

  /** Test hook: stand somewhere, facing some way. */
  teleport(x: number, y: number, z: number, yaw?: number) {
    this.pos.set(x, y + 0.05, z);
    this.vel.set(0, 0, 0);
    if (yaw !== undefined) {
      this.yaw = yaw;
      this.camYaw = yaw;
    }
    this.settleCamera(0.999);
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
    this.kid.dispose();
    this.bricks.dispose();
    this.placedRig.dispose();
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

export { CEILING, LEVELS, NIGHT_COUNT, ROAM, EXPLORE, LIGHTS };
