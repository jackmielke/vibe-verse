/**
 * The things that move without you: skycars on their lanes, the ring tram,
 * and a couple of flocks of whatever birds live six hundred metres up.
 *
 * A city is believable in the middle distance or it is not believable at all.
 * The crowd sells the pavement; this sells everything above it — a craft
 * banking over the Bazaar, a tram coming round the ring at a hundred, a line
 * of running lights sliding behind a tower. All of it is far enough away to
 * be cheap and near enough to be seen, which is the best trade in the world.
 *
 * ## How a lane works
 *
 * Every flying thing here follows a **closed polyline sampled once at build
 * time**: position, heading, pitch and turn rate per sample, with cumulative
 * arclength alongside. A vehicle is then a single number — how far along it
 * is — plus a speed. Position, facing and the bank angle all fall out of the
 * sample it is between, so there is no steering, no integration error, and no
 * way for a craft to end up somewhere its lane does not go.
 *
 * The bank is not a decoration: `roll = atan(v²κ/g)` off the lane's own turn
 * rate is the same sum an aircraft does, and it is why the ring lanes read as
 * *circling* rather than as beads on a wire.
 *
 * Queueing is the other half. Cars on a lane are stored in order of distance
 * along it and cannot overtake, so each one only ever looks at the one in
 * front: close the gap and it lifts off the throttle. The order can therefore
 * never change, which is what makes the whole thing O(cars) with no sorting.
 *
 * ## The tram, and how you ride it
 *
 * A real vehicle on the middle ring road, 218 m out, all the way round in
 * about ninety seconds with four stops on the way, and you can be on it. Not
 * by pressing a key and watching a cutscene: the three cars are hollow, they
 * have floors, seats, glass and doors that open, and the floor is a deck the
 * body stands on the same way it stands on a pavement.
 *
 * **The whole engineering problem is that a floor which moves sideways does
 * not carry anybody.** The spire's lift works for free, because `flight.ts`
 * looks support up from `prevY + CLIMB` and a floor that has risen under you
 * catches you. Support is looked up *by XZ*, though, so a floor that slides
 * out from under a body leaves that body standing in the air where the tram
 * used to be.
 *
 * The primitive that fixes it is `collide.ts`'s **`MovingFrame`** — a pose, a
 * velocity, and a set of boxes and decks written in the frame's own
 * coordinates — plus `carryAt`, which reports the velocity of whatever deck
 * is holding a body up so `flight.ts` can add it to that body's position.
 * Neither of them mentions a tram. A lift that also translates, a barge and a
 * gondola all want the same thing, and the platforms here use a frame too,
 * with a zero velocity, because they are oblique rectangles the collision
 * grid would have to over-cover.
 *
 * What this file publishes, then:
 *
 * - `frames` — the three cars and the four platforms, as `MovingFrame`s, for
 *   `world.ts` to hand to `buildCollision`. Everything about standing on the
 *   tram, being carried by it, and not walking out of a moving one falls out
 *   of that one list.
 * - `interactables()` — one prompt per platform, offering "Board the tram"
 *   when the tram is standing there with its doors open and "Step off" when
 *   you are aboard. Walking in and out of an open door works and is the point;
 *   the prompt is for people who would rather press a key.
 * - `tram` — where it is, whether it is standing, whether the doors are open.
 * - `stops` — the platforms, for the minimap and for anything offering a ride.
 * - `seats` — where every seat is in world space, updated per frame, so that
 *   a future crowd change can put somebody in one without this file knowing
 *   anything about crowds.
 *
 * ### Two numbers that are not arbitrary
 *
 * The platform deck stands 0.56 m above the roadway and 0.52 m below the car
 * floor. Both are under `CLIMB` (0.62 m), which is what makes boarding a walk
 * rather than a jump — and it is the only reason the step-up finds the car
 * floor at all. Move either and check both.
 *
 * The doors start closing 1.3 s before the dwell runs out rather than on
 * departure, because they take 1.2 s to close and a tram that pulls away with
 * its doors still shutting is a tram you can walk out of at 12 m/s.
 *
 * The stops are named for the landmark each one serves, and each one is the
 * point on the ring nearest that landmark rather than the landmark itself:
 * the Halo Station building stands at r = 96, twelve seconds' walk up the
 * avenue from its platform, the way a station and a stop usually relate. A
 * route that detoured to the door of each would have to leave the road.
 */
import * as THREE from "three";
import { makeRng } from "@/shared/proc/rng";
import { RING_R, RIM_R, KERB_H } from "./cityplan";
import { ISLAND_Y, PLATEAU_R } from "./config";
/* The one exception to "a system may not import another system": `SUN_DIR` is
   a constant, not behaviour, and it is only the build-time default — every
   frame overwrites it from `ctx.sunDir`, which is the live one. */
import { SUN_DIR } from "./sky";
import type { BuildContext, FrameContext, Interactable, InteractiveSystem } from "./types";

/* -------------------------------------------------------------------------
 * The collision shapes this hands back
 *
 * Structurally identical to `collide.ts`'s `Blocker`, `Deck` and
 * `MovingFrame`, and declared here rather than imported for the same reason
 * `interiors.ts` and `spire.ts` declare theirs: TypeScript is structural, so
 * these drop straight into `buildCollision` without this file importing
 * anything it is not allowed to.
 * ---------------------------------------------------------------------- */

/** An axis-aligned box you cannot walk through. */
export interface Blocker {
  x: number;
  z: number;
  hx: number;
  hz: number;
  top: number;
  bottom: number;
}

/** A flat surface you can stand on. */
export interface Deck {
  y: number;
  x?: number;
  z?: number;
  hx?: number;
  hz?: number;
  r?: number;
}

/**
 * A rigid cluster of boxes and decks with a pose and a velocity.
 *
 * Everything inside is in the frame's own coordinates. The pose and the
 * velocity are mutated in place each frame; `blockers` is swapped between two
 * prebuilt arrays when the doors open, which is how a door stops being a wall
 * without anything allocating or re-indexing.
 */
export interface MovingFrame {
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vy: number;
  vz: number;
  /** Yaw rate, radians per second. A carry is a rigid motion, not a slide. */
  w: number;
  radius: number;
  blockers: Blocker[];
  decks: Deck[];
}

export interface TramState {
  /** Front car's position, on the road, in world space. */
  x: number;
  y: number;
  z: number;
  /** Facing, radians, same convention as everything else: 0 is -Z. */
  yaw: number;
  /** True while it is standing at a platform. */
  stopped: boolean;
  /**
   * True only while the doors are far enough open to walk through.
   *
   * Not the same thing as `stopped`, and the difference is the whole
   * affordance: the doors take a second to open after it arrives and are shut
   * again a second before it leaves, so there is a window rather than an
   * instant, and a closed door is a wall.
   */
  doorsOpen: boolean;
  /** Id of the stop it is standing at, or "" while it is running. */
  atStop: string;
  /**
   * Seconds of dwell left before it pulls away, 0 while it is running.
   *
   * Published because a tram standing at a platform and a tram that has
   * stopped working look identical from outside, and telling them apart cost
   * somebody five and a half minutes and a bug report. This is the number
   * that says which. Under a software rasteriser the world's clock runs at a
   * fiftieth of the wall clock, so a seven-second dwell is four real minutes
   * of a train that is behaving perfectly.
   */
  dwell: number;
  /**
   * Human-readable, for a sign or a prompt: the stop it is standing at while
   * `stopped`, and the one it is heading for while it is moving. Match it to
   * `stops` by name order, or use `stops[].id` for anything programmatic.
   */
  nextStop: string;
}

/** One seat, in world space. Mutated in place every frame; never reallocated. */
export interface TramSeat {
  /** Which car, 0 at the front. */
  car: number;
  x: number;
  y: number;
  z: number;
  /** Facing, radians — across the car, the way a longitudinal bench faces. */
  yaw: number;
}

export interface TrafficHandle extends InteractiveSystem {
  readonly tram: TramState;
  /** Platform positions, so another system can offer "ride the tram". */
  readonly stops: Array<{ id: string; x: number; y: number; z: number }>;
  /**
   * The cars and the platforms, for `world.ts` to give to `buildCollision`.
   *
   * Held by reference and mutated in place, so the collision world sees where
   * the tram is now without anything being rebuilt.
   */
  readonly frames: MovingFrame[];
  /**
   * Every seat on the train, in world space, updated each frame.
   *
   * Published rather than used, because seating a pedestrian is `crowd.ts`'s
   * business and a system may not import another system. This is the shape
   * that lets that happen later without either file changing: a stable array
   * whose entries move.
   */
  readonly seats: TramSeat[];
  /** Set by the engine. Announces the stop you have just pulled into. */
  onToast: ((text: string, tone?: "info" | "good" | "warn") => void) | null;
}

const TAU = Math.PI * 2;
const DECK = ISLAND_Y;

/** Where the tram stops, and what each stop is for. */
const TRAM_STOPS: Array<{ id: string; name: string; a: number }> = [
  { id: "halo", name: "Halo Station", a: Math.PI },
  { id: "market", name: "Market Hall", a: Math.PI * 0.75 },
  { id: "launch", name: "Launch Terrace", a: Math.PI * 0.25 },
  { id: "observatory", name: "The Observatory", a: -Math.PI / 2 },
];

/**
 * Tram kinematics. These four numbers *are* the ninety-second lap.
 *
 * The ring is 1370 m and the four stops cut it into 514, 342, 171 and 342 m.
 * At 5 m/s² up to 30 m/s that is 69.7 s of running; four seven-second stands
 * make it 97.7 on paper and 89 in practice, because braking on a discrete
 * step and the snap onto the platform each shave a little off every segment.
 * Change any of them and re-measure — the test asserts the lap, not the
 * speed, which is the number anyone actually notices.
 */
const TRAM_VMAX = 30;
const TRAM_ACCEL = 5;
const TRAM_DWELL = 7;
const TRAM_R = RING_R[1];

/**
 * How far in from the road centreline the *published* stop point sits.
 *
 * This is the prompt's position and the minimap's mark, not the middle of the
 * slab: the platform is an island six metres wide that reaches from the inner
 * kerb out to within fifteen centimetres of the car, and its geometry is
 * authored around this point with an outward offset. Two different things,
 * and conflating them is how you get a station you cannot board from.
 */
const PLATFORM_OFF = 6.0;

/* -------------------------------------------------------------------------
 * The car, in its own frame
 *
 * Origin on the lane, at rail height; forward is -Z, +X is the *inner* side
 * of the ring, which is the side every platform is on and therefore the side
 * the doors open. That is not a choice, it falls out of the lane: the ring is
 * wound counter-clockwise, so local +X maps to world (-cos a, -sin a), which
 * points at the middle of the island.
 * ---------------------------------------------------------------------- */

/** Half-width of the body, outer face. */
const CAR_HW = 1.45;
/** Half-length. Cars sit 11.6 m apart, so there is 1.2 m between them. */
const CAR_HL = 5.2;
/** Top of the floor — the surface you stand on. */
const CAR_FLOOR = 0.74;
/** Underside of the ceiling. */
const CAR_CEIL = 2.84;
/** Half-width of a door aperture. Two leaves part in the middle of it. */
const DOOR_HZ = 1.15;
/** The window band. */
const WIN_Y0 = 1.30;
const WIN_Y1 = 2.28;
/** Spacing between car centres along the lane. */
const CAR_GAP = 11.6;

/** Seconds for a door to travel its full width. */
const DOOR_TIME = 0.9;
/**
 * How long before departure the doors start closing.
 *
 * They have to be *shut* when it pulls away, not shutting. A tram that leaves
 * with a metre of gap in its side is a tram you walk out of at 12 m/s, and
 * the first version did exactly that.
 */
const DOOR_SHUT_LEAD = 1.0;
/** Phase past which a door is open enough to walk through. */
const DOOR_CLEAR = 0.82;

/** Height of the platform deck above the city deck. */
const PLATFORM_TOP = 0.40;
/** Half-extents of the platform slab, and its outward offset from the stop. */
const PLATFORM_CX = 1.40;
const PLATFORM_HX = 3.00;
/**
 * The platform is 35 m long and sits *behind* the stopping point, and both of
 * those are because the train is three cars.
 *
 * A tram stops with its leading car at the stop, so the other two are 11.6 and
 * 23.2 m back down the road. A platform centred on the stop, seventeen metres
 * long, is a platform that only the front car's doors open onto — and the
 * other four open onto the carriageway, half a metre above it, which is a
 * door inviting you out onto a road. So the slab runs from 9.5 m ahead of the
 * stop to 25.5 m behind it, which puts every doorway on the train over it with
 * a couple of metres to spare.
 *
 * The canopy does *not* follow it. Thirty-five metres of roof over a road is a
 * different building; a shelter in the middle is a tram stop.
 */
const PLATFORM_CZ = -8.0;
const PLATFORM_HZ = 17.5;

/* -------------------------------------------------------------------------
 * Lanes
 * ---------------------------------------------------------------------- */

interface Lane {
  n: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  yaw: Float32Array;
  pitch: Float32Array;
  /** Signed turn rate, radians per metre. Drives the bank. */
  curv: Float32Array;
  /** Cumulative arclength, n + 1 entries; the last is the loop length. */
  cum: Float32Array;
  total: number;
  speed: number;
  first: number;
  count: number;
}

/**
 * Turn a closed list of points into a lane.
 *
 * Heading is the direction to the next sample; turn rate is the change in
 * heading over the distance between them, which on a circle comes out at
 * exactly 1/r and on a straight at zero.
 */
function makeLane(pts: number[], speed: number): Lane {
  const n = pts.length / 3;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const z = new Float32Array(n);
  const yaw = new Float32Array(n);
  const pitch = new Float32Array(n);
  const curv = new Float32Array(n);
  const cum = new Float32Array(n + 1);
  for (let i = 0; i < n; i++) {
    x[i] = pts[i * 3];
    y[i] = pts[i * 3 + 1];
    z[i] = pts[i * 3 + 2];
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = x[j] - x[i];
    const dy = y[j] - y[i];
    const dz = z[j] - z[i];
    const flat = Math.hypot(dx, dz) || 1e-4;
    const len = Math.hypot(dx, dy, dz) || 1e-4;
    yaw[i] = Math.atan2(-dx, -dz);
    pitch[i] = Math.atan2(dy, flat);
    cum[i + 1] = cum[i] + len;
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    let d = yaw[j] - yaw[i];
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    curv[i] = d / Math.max(0.5, cum[i + 1] - cum[i]);
  }
  return {
    n,
    x,
    y,
    z,
    yaw,
    pitch,
    curv,
    cum,
    total: cum[n],
    speed,
    first: 0,
    count: 0,
  };
}

/** A ring lane: a circle at a radius and an altitude, either way round. */
function ringLane(r: number, y: number, dir: 1 | -1, speed: number): Lane {
  const n = Math.max(24, Math.round((TAU * r) / 9));
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU * dir;
    pts.push(Math.cos(a) * r, y, Math.sin(a) * r);
  }
  return makeLane(pts, speed);
}

/**
 * An avenue loop: out over one avenue, round at the rim, back over the next,
 * round again at the middle. Two altitudes, so the two legs do not meet.
 */
function avenueLane(a0: number, a1: number, r0: number, r1: number, yOut: number, yBack: number, speed: number): Lane {
  const pts: number[] = [];
  const push = (r: number, a: number, y: number) => pts.push(Math.cos(a) * r, y, Math.sin(a) * r);
  const legs = Math.max(6, Math.round((r1 - r0) / 12));
  for (let i = 0; i < legs; i++) push(r0 + ((r1 - r0) * i) / legs, a0, yOut);
  const arcOut = Math.max(4, Math.round((Math.abs(a1 - a0) * r1) / 12));
  for (let i = 0; i < arcOut; i++) {
    const t = i / arcOut;
    push(r1, a0 + (a1 - a0) * t, yOut + (yBack - yOut) * t);
  }
  for (let i = 0; i < legs; i++) push(r1 - ((r1 - r0) * i) / legs, a1, yBack);
  const arcIn = Math.max(4, Math.round((Math.abs(a1 - a0) * r0) / 12));
  for (let i = 0; i < arcIn; i++) {
    const t = i / arcIn;
    push(r0, a1 - (a1 - a0) * t, yBack + (yOut - yBack) * t);
  }
  return makeLane(pts, speed);
}

/* -------------------------------------------------------------------------
 * Geometry
 * ---------------------------------------------------------------------- */

interface BoxSpec {
  cx: number;
  cy: number;
  cz: number;
  sx: number;
  sy: number;
  sz: number;
  /** 0 hull, 1 glass, 2 emissive. */
  part: number;
}

const FACES: Array<[number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

interface RawGeo {
  position: Float32Array;
  normal: Float32Array;
  part: Float32Array;
  index: Uint16Array;
}

function boxes(list: BoxSpec[]): RawGeo {
  const verts = list.length * 24;
  const position = new Float32Array(verts * 3);
  const normal = new Float32Array(verts * 3);
  const part = new Float32Array(verts);
  const index = new Uint16Array(list.length * 36);
  let v = 0;
  let ii = 0;
  for (const b of list) {
    const hx = b.sx / 2;
    const hy = b.sy / 2;
    const hz = b.sz / 2;
    for (const [nx, ny, nz] of FACES) {
      const ux = ny !== 0 || nz !== 0 ? 1 : 0;
      const uy = nx !== 0 ? 1 : 0;
      const uz = 0;
      const vx = ny * uz - nz * uy;
      const vy = nz * ux - nx * uz;
      const vz = nx * uy - ny * ux;
      const base = v;
      for (const [su, sv] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        position[v * 3] = b.cx + nx * hx + (ux * su + vx * sv) * hx;
        position[v * 3 + 1] = b.cy + ny * hy + (uy * su + vy * sv) * hy;
        position[v * 3 + 2] = b.cz + nz * hz + (uz * su + vz * sv) * hz;
        normal[v * 3] = nx;
        normal[v * 3 + 1] = ny;
        normal[v * 3 + 2] = nz;
        part[v] = b.part;
        v++;
      }
      index[ii++] = base;
      index[ii++] = base + 1;
      index[ii++] = base + 2;
      index[ii++] = base;
      index[ii++] = base + 2;
      index[ii++] = base + 3;
    }
  }
  return { position, normal, part, index };
}

/** Forward is -Z, the same as everything else that has a front in this world. */
const SKYCAR: BoxSpec[] = [
  { cx: 0, cy: 0, cz: 0.2, sx: 1.9, sy: 0.85, sz: 5.0, part: 0 },
  { cx: 0, cy: -0.06, cz: -2.9, sx: 1.15, sy: 0.5, sz: 1.5, part: 0 },
  { cx: 0, cy: 0.46, cz: -0.7, sx: 1.45, sy: 0.55, sz: 2.1, part: 1 },
  { cx: 1.32, cy: -0.12, cz: 0.5, sx: 0.62, sy: 0.55, sz: 2.9, part: 0 },
  { cx: -1.32, cy: -0.12, cz: 0.5, sx: 0.62, sy: 0.55, sz: 2.9, part: 0 },
  { cx: 0, cy: -0.46, cz: 0.6, sx: 1.25, sy: 0.12, sz: 3.2, part: 2 },
  { cx: 0, cy: 0.62, cz: 2.3, sx: 0.13, sy: 0.85, sz: 1.1, part: 0 },
];

/* -------------------------------------------------------------------------
 * The tram car
 *
 * A **shell**, not a block. The old car was a solid 2.9 x 2.5 x 10.4 box with
 * a glass band painted on it, which is exactly right for something you only
 * ever see from four hundred metres and useless the moment you are inside it:
 * with backfaces culled, standing in a solid box shows you the city straight
 * through the walls. So it is built the way a tram is built — floor, sills,
 * window band, header, roof, two bulkheads — and the doorways are simply
 * where the sill and the header stop.
 *
 * The three lists are separated by *material*, not by part: hull and the lit
 * strips share one shader, the glass wants a transparent one, and the door
 * leaves move independently of the car so they cannot share its instances.
 * ---------------------------------------------------------------------- */

/** Wall thickness, and the centre-line of a side wall. */
const WALL_T = 0.14;
const WALL_X = CAR_HW - WALL_T / 2;
/** Where a wall segment between the door and the end of the car sits. */
const SEG_HZ = (CAR_HL - DOOR_HZ) / 2;
const SEG_CZ = (CAR_HL + DOOR_HZ) / 2;
/** Bulkhead centre. */
const END_CZ = CAR_HL - 0.09;

function tramCarBoxes(): BoxSpec[] {
  const b: BoxSpec[] = [];
  const mid = (a: number, c: number) => (a + c) / 2;
  const span = (a: number, c: number) => c - a;

  /* Underframe, floor, and the lit strip that runs the length of the sill —
     the one part of the old car that was doing real work at distance. */
  b.push({ cx: 0, cy: 0.34, cz: 0, sx: 2.3, sy: 0.52, sz: 9.6, part: 0 });
  b.push({ cx: 0, cy: CAR_FLOOR - 0.08, cz: 0, sx: 2.9, sy: 0.16, sz: 10.4, part: 0 });
  b.push({ cx: 0, cy: CAR_FLOOR - 0.04, cz: 0, sx: 3.02, sy: 0.12, sz: 8.6, part: 2 });
  /* Roof, and the cap ridge over it. */
  b.push({ cx: 0, cy: CAR_CEIL + 0.1, cz: 0, sx: 2.9, sy: 0.2, sz: 10.4, part: 0 });
  b.push({ cx: 0, cy: CAR_CEIL + 0.28, cz: 0, sx: 2.4, sy: 0.16, sz: 9.0, part: 0 });

  for (const side of [1, -1]) {
    const x = WALL_X * side;
    for (const cz of [-SEG_CZ, SEG_CZ]) {
      // Sill, below the windows.
      b.push({
        cx: x, cy: mid(CAR_FLOOR, WIN_Y0), cz,
        sx: WALL_T, sy: span(CAR_FLOOR, WIN_Y0), sz: SEG_HZ * 2, part: 0,
      });
    }
    // Header, above the windows and unbroken over the doorway.
    b.push({
      cx: x, cy: mid(WIN_Y1, CAR_CEIL), cz: 0,
      sx: WALL_T, sy: span(WIN_Y1, CAR_CEIL), sz: CAR_HL * 2, part: 0,
    });
    // The two posts that frame the doorway.
    for (const cz of [-DOOR_HZ, DOOR_HZ]) {
      b.push({
        cx: x, cy: mid(CAR_FLOOR, WIN_Y1), cz,
        sx: WALL_T, sy: span(CAR_FLOOR, WIN_Y1), sz: 0.14, part: 0,
      });
    }
  }

  /* The two bulkheads, each a sill and a header with a screen between them
     that is glass — so the front of the train looks where it is going and the
     back of it watches the city recede. */
  for (const cz of [-END_CZ, END_CZ]) {
    b.push({
      cx: 0, cy: mid(CAR_FLOOR, WIN_Y0), cz,
      sx: 2.9, sy: span(CAR_FLOOR, WIN_Y0), sz: 0.18, part: 0,
    });
    b.push({
      cx: 0, cy: mid(WIN_Y1, CAR_CEIL), cz,
      sx: 2.9, sy: span(WIN_Y1, CAR_CEIL), sz: 0.18, part: 0,
    });
    for (const cx of [-1.35, 1.35]) {
      b.push({
        cx, cy: mid(WIN_Y0, WIN_Y1), cz,
        sx: 0.2, sy: span(WIN_Y0, WIN_Y1), sz: 0.18, part: 0,
      });
    }
  }

  /* Longitudinal benches, fore and aft of the doors on both sides.
   *
   * Deliberately *not* blockers. The body is a 1.2 m cylinder and the car is
   * 2.62 m wide inside; furniture you cannot walk through would leave a
   * corridor of nothing, and being able to stand where a seat is costs this
   * world far less than not being able to move. */
  for (const side of [1, -1]) {
    for (const h of [-1, 1]) {
      b.push({
        cx: 0.92 * side, cy: 1.02, cz: 2.9 * h,
        sx: 0.84, sy: 0.12, sz: 3.3, part: 0,
      });
      b.push({
        cx: 1.28 * side, cy: 1.32, cz: 2.9 * h,
        sx: 0.12, sy: 0.48, sz: 3.3, part: 0,
      });
    }
    // The grab rail along the ceiling, and a stanchion each side of the door.
    b.push({ cx: 0.7 * side, cy: 2.44, cz: 0, sx: 0.07, sy: 0.07, sz: 9.4, part: 0 });
    for (const cz of [-1.55, 1.55]) {
      b.push({
        cx: 0.62 * side, cy: mid(CAR_FLOOR, 2.44), cz,
        sx: 0.07, sy: span(CAR_FLOOR, 2.44), sz: 0.07, part: 0,
      });
    }
    /* The route strip: part 3, and the only part in this whole file that the
       fragment shader treats as a diagram rather than as a surface. A pip
       travels along it as the tram travels round the ring, with a notch at
       each of the four stops. */
    b.push({ cx: 1.3 * side, cy: 2.4, cz: 0, sx: 0.03, sy: 0.13, sz: 9.4, part: 3 });
  }
  // One long ceiling light.
  b.push({ cx: 0, cy: CAR_CEIL - 0.04, cz: 0, sx: 0.6, sy: 0.06, sz: 8.8, part: 2 });
  return b;
}

/** The glazing, drawn with the transparent material. */
function tramGlassBoxes(): BoxSpec[] {
  const g: BoxSpec[] = [];
  const h = WIN_Y1 - WIN_Y0;
  const cy = (WIN_Y0 + WIN_Y1) / 2;
  for (const side of [1, -1]) {
    for (const cz of [-SEG_CZ, SEG_CZ]) {
      g.push({ cx: (CAR_HW - 0.03) * side, cy, cz, sx: 0.06, sy: h, sz: SEG_HZ * 2 - 0.1, part: 1 });
    }
  }
  for (const cz of [-(END_CZ + 0.02), END_CZ + 0.02]) {
    g.push({ cx: 0, cy, cz, sx: 2.5, sy: h, sz: 0.06, part: 1 });
  }
  return g;
}

/**
 * One door leaf, authored about its own centre.
 *
 * It is placed in world space per instance, because a leaf slides relative to
 * the car it belongs to and an instance matrix is the only per-thing
 * transform an `InstancedMesh` has. The lit edge is part 2, which the glass
 * shader draws opaque — a door you can see the state of from the platform.
 */
function tramDoorBoxes(): BoxSpec[] {
  const hz = DOOR_HZ / 2;
  const cy = (CAR_FLOOR + WIN_Y1) / 2;
  const sy = WIN_Y1 - CAR_FLOOR;
  return [
    { cx: 0, cy, cz: 0, sx: 0.07, sy, sz: hz * 2 - 0.03, part: 1 },
    { cx: 0, cy: cy + sy / 2, cz: 0, sx: 0.09, sy: 0.06, sz: hz * 2, part: 2 },
    { cx: 0, cy: cy - sy / 2, cz: 0, sx: 0.09, sy: 0.06, sz: hz * 2, part: 2 },
    { cx: 0, cy, cz: -hz, sx: 0.09, sy, sz: 0.05, part: 2 },
    { cx: 0, cy, cz: hz, sx: 0.09, sy, sz: 0.05, part: 2 },
  ];
}

/**
 * The platform: an island slab reaching from the inner kerb of the ring road
 * out to within fifteen centimetres of the car, with a canopy over it.
 *
 * Local +X is *outward* here, because the slab is placed with `yaw = -a`
 * while the car is placed with the lane's own heading. The two frames run
 * opposite ways and it has caught somebody once already.
 */
const PLATFORM: BoxSpec[] = [
  { cx: PLATFORM_CX, cy: PLATFORM_TOP / 2, cz: PLATFORM_CZ, sx: PLATFORM_HX * 2, sy: PLATFORM_TOP, sz: PLATFORM_HZ * 2, part: 0 },
  // The lit edge along the platform side, which is where you stand and wait.
  { cx: PLATFORM_CX + PLATFORM_HX - 0.2, cy: PLATFORM_TOP + 0.02, cz: PLATFORM_CZ, sx: 0.36, sy: 0.04, sz: PLATFORM_HZ * 2 - 0.6, part: 2 },
  { cx: -1.0, cy: 2.05, cz: -7.2, sx: 0.18, sy: 3.3, sz: 0.18, part: 0 },
  { cx: -1.0, cy: 2.05, cz: 0, sx: 0.18, sy: 3.3, sz: 0.18, part: 0 },
  { cx: -1.0, cy: 2.05, cz: 7.2, sx: 0.18, sy: 3.3, sz: 0.18, part: 0 },
  { cx: 1.3, cy: 3.78, cz: 0, sx: 5.4, sy: 0.16, sz: 15.4, part: 0 },
  { cx: 1.3, cy: 3.62, cz: 0, sx: 2.4, sy: 0.09, sz: 13.0, part: 2 },
];

/** A bird: two wing quads either side of a scrap of body. */
function birdGeo(): RawGeo {
  const position = new Float32Array((4 + 4 + 24) * 3);
  const normal = new Float32Array((4 + 4 + 24) * 3);
  const part = new Float32Array(4 + 4 + 24);
  const index = new Uint16Array(6 + 6 + 36);
  let v = 0;
  let ii = 0;
  for (const side of [1, -1]) {
    const base = v;
    const quad: Array<[number, number]> = [
      [0.04, -0.16],
      [0.62, -0.30],
      [0.62, 0.24],
      [0.04, 0.14],
    ];
    for (const [w, z] of quad) {
      position[v * 3] = w * side;
      position[v * 3 + 1] = 0;
      position[v * 3 + 2] = z;
      normal[v * 3 + 1] = 1;
      part[v] = side > 0 ? 0 : 1;
      v++;
    }
    if (side > 0) {
      index[ii++] = base;
      index[ii++] = base + 1;
      index[ii++] = base + 2;
      index[ii++] = base;
      index[ii++] = base + 2;
      index[ii++] = base + 3;
    } else {
      index[ii++] = base;
      index[ii++] = base + 2;
      index[ii++] = base + 1;
      index[ii++] = base;
      index[ii++] = base + 3;
      index[ii++] = base + 2;
    }
  }
  const body = boxes([{ cx: 0, cy: 0, cz: 0, sx: 0.09, sy: 0.09, sz: 0.42, part: 2 }]);
  position.set(body.position, v * 3);
  normal.set(body.normal, v * 3);
  part.set(body.part, v);
  for (let k = 0; k < body.index.length; k++) index[ii++] = body.index[k] + v;
  return { position, normal, part, index };
}

/* -------------------------------------------------------------------------
 * Shaders
 * ---------------------------------------------------------------------- */

const HULL_VERT = /* glsl */ `
  attribute float aPart;
  attribute vec3 aTint;
  attribute vec2 aGlow;  // emissive gain, strobe phase

  uniform float uTime;
  uniform float uNight;

  varying vec3 vCol;
  varying vec3 vNrm;
  varying vec3 vView;
  varying float vEmit;
  varying float vRoute;

  void main() {
    // Position and facing both come out of the instance matrix, which three
    // declares for us because this is drawn from an InstancedMesh.
    vec3 world = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
    vec3 n = mat3(modelMatrix) * mat3(instanceMatrix) * normal;

    vec3 col = aTint;
    float emit = 0.0;
    // Negative means "not a route strip", which is every vertex of every
    // skycar in the city and all but two boxes of every tram car.
    vRoute = -1.0;
    if (aPart > 2.5) {
      // The route strip inside the tram. Position along the strip, 0 at the
      // back and 1 at the front, so a pip drawn at the tram's own progress
      // round the ring travels the way the tram does.
      vRoute = (4.7 - position.z) / 9.4;
      col = vec3(0.30, 0.36, 0.44);
    } else if (aPart > 1.5) {
      // The lit strip: always on, brighter after dark, with a slow breath so a
      // line of them never pulses in step.
      col = vec3(1.0, 0.72, 0.42);
      emit = aGlow.x * (0.55 + uNight * 1.5)
           * (0.8 + 0.2 * sin(uTime * 2.1 + aGlow.y * 6.283));
    } else if (aPart > 0.5) {
      col = aTint * 0.35 + vec3(0.05, 0.08, 0.12);
      emit = uNight * aGlow.x * 0.55;
    }

    vCol = col;
    vEmit = emit;
    vNrm = n;
    vView = cameraPosition - world;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const HULL_FRAG = /* glsl */ `
  precision mediump float;
  uniform vec3 uSun;
  uniform vec3 uSunCol;
  uniform vec3 uSkyCol;

  uniform float uRoute;
  uniform vec4 uStops;

  varying vec3 vCol;
  varying vec3 vNrm;
  varying vec3 vView;
  varying float vEmit;
  varying float vRoute;

  // How brightly a notch at fraction s marks this point on the strip.
  float notchAt(float t, float s) {
    return smoothstep(0.014, 0.0, abs(t - s));
  }

  void main() {
    if (vRoute >= 0.0) {
      // The route diagram. Four notches for the four stops, and one travelling
      // pip for where the tram is, which is the only thing on this strip that
      // moves and the only reason it is worth drawing.
      float t = vRoute;
      float marks = notchAt(t, uStops.x) + notchAt(t, uStops.y)
                  + notchAt(t, uStops.z) + notchAt(t, uStops.w);
      float pip = smoothstep(0.055, 0.0, abs(t - uRoute));
      vec3 c = vCol * 0.5
             + vec3(0.55, 0.78, 1.0) * marks * 0.9
             + vec3(1.0, 0.78, 0.44) * pip * 2.4;
      gl_FragColor = vec4(c, 1.0);
      return;
    }
    vec3 N = normalize(vNrm);
    vec3 V = normalize(vView);
    float ndl = max(dot(N, uSun), 0.0);
    float sky = 0.5 + 0.5 * N.y;
    // A hard specular off the sun, because these are lacquered metal and it is
    // the flash of one turning that catches your eye at four hundred metres.
    float spec = pow(max(dot(reflect(-uSun, N), V), 0.0), 42.0);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    vec3 lit = vCol * (uSunCol * ndl + uSkyCol * sky)
             + uSunCol * spec * 0.9
             + uSkyCol * fres * 0.4
             + vCol * vEmit;
    gl_FragColor = vec4(lit, 1.0);
  }
`;

/*
 * The tram's glazing.
 *
 * The hull shader's "glass" part is an opaque dark panel, which is right for a
 * skycar seen from four hundred metres and wrong for a window you are sitting
 * behind for ninety seconds. This one is real transparent glass with a
 * fresnel rim, and it is the reason the ride is worth taking.
 *
 * Part 2 inside this material is the door leaves' lit edge: opaque, so a shut
 * door reads as shut from the platform. Sharing one material between the panes
 * and the leaves keeps this to two draw calls instead of four.
 */
const TRAM_GLASS_VERT = /* glsl */ `
  attribute float aPart;
  attribute vec3 aTint;
  attribute vec2 aGlow;

  varying vec3 vNrm;
  varying vec3 vView;
  varying float vPart;
  varying float vGain;

  void main() {
    vec3 world = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
    vNrm = mat3(modelMatrix) * mat3(instanceMatrix) * normal;
    vView = cameraPosition - world;
    vPart = aPart;
    vGain = aGlow.x;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const TRAM_GLASS_FRAG = /* glsl */ `
  precision mediump float;
  uniform vec3 uSun;
  uniform vec3 uSunCol;
  uniform vec3 uSkyCol;
  uniform float uNight;

  varying vec3 vNrm;
  varying vec3 vView;
  varying float vPart;
  varying float vGain;

  void main() {
    vec3 N = normalize(vNrm);
    vec3 V = normalize(vView);
    if (vPart > 1.5) {
      // The door's lit edge. Opaque, and it comes up after dark.
      vec3 c = vec3(1.0, 0.84, 0.58) * (0.55 + uNight * 1.35) * vGain;
      gl_FragColor = vec4(c, 1.0);
      return;
    }
    // Two-sided, so the facing has to be folded out of the dot products or
    // the inside of every pane comes out black.
    float ndv = abs(dot(N, V));
    float ndl = abs(dot(N, uSun));
    float fres = pow(1.0 - ndv, 3.0);
    float spec = pow(max(dot(reflect(-uSun, N), V), 0.0), 60.0);
    vec3 tint = vec3(0.40, 0.55, 0.66);
    vec3 col = tint * (uSkyCol * 1.5 + uSunCol * ndl * 0.4)
             + uSunCol * spec * 1.3
             + uSkyCol * fres * 1.2;
    gl_FragColor = vec4(col, 0.14 + fres * 0.55);
  }
`;

const BIRD_VERT = /* glsl */ `
  attribute float aPart;
  attribute vec3 aTint;
  attribute vec2 aGlow;
  uniform float uTime;
  varying vec3 vCol;
  varying float vShade;

  vec3 rotZ(vec3 p, float a) { float s = sin(a), c = cos(a); return vec3(p.x * c - p.y * s, p.x * s + p.y * c, p.z); }

  void main() {
    vec3 p = position;
    if (aPart < 1.5) {
      // Each wing hinges on the spine; the two of them are mirrored, so one
      // sine drives both and the flock never beats in unison because every
      // bird carries its own phase.
      float flap = sin(uTime * 7.0 + aGlow.y * 6.283) * 0.62 + 0.1;
      p = rotZ(p, aPart < 0.5 ? flap : -flap);
      vShade = 0.7 + 0.3 * cos(flap);
    } else {
      vShade = 1.0;
    }
    // Flap first, in the bird's own frame, then fly it.
    vCol = aTint;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
  }
`;

const BIRD_FRAG = /* glsl */ `
  precision mediump float;
  varying vec3 vCol;
  varying float vShade;
  void main() { gl_FragColor = vec4(vCol * vShade, 1.0); }
`;

const LIGHT_VERT = /* glsl */ `
  attribute float aSize;
  uniform float uScale;
  varying vec3 vCol;
  void main() {
    vCol = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(aSize * uScale / max(-mv.z, 1.0), 1.4, 9.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const LIGHT_FRAG = /* glsl */ `
  precision mediump float;
  varying vec3 vCol;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d) * 2.0;
    float core = smoothstep(1.0, 0.0, r);
    gl_FragColor = vec4(vCol * (0.35 + core * 2.1), core * core);
  }
`;

/* -------------------------------------------------------------------------
 * Build
 * ---------------------------------------------------------------------- */

export function buildTraffic(ctx: BuildContext): TrafficHandle {
  const low = ctx.quality === "low";
  const rng = makeRng(`empyrean-traffic:${ctx.seedSalt}`);
  const group = new THREE.Group();
  group.name = "empyrean-traffic";

  /* ---- lanes ----------------------------------------------------------- */
  /* Altitudes are chosen against each other, not for the look of them: every
     lane crosses several others in plan, so the only thing keeping two craft
     out of the same cubic metre is ten metres of air. Ring lanes take 26, 40,
     64 and 88; the cross-town loops take the gaps between them, and the four
     loops never overlap each other in plan, so they can share. */
  const lanes: Lane[] = [
    ringLane(RING_R[0], DECK + 40, 1, 30),
    ringLane(RING_R[1], DECK + 64, -1, 34),
    ringLane(RING_R[2], DECK + 88, 1, 36),
    ringLane(RIM_R + 22, DECK + 26, -1, 28),
  ];
  /* Four cross-town loops, each out over one avenue and back over the next.
     Every leg and every turn is above an actual street — out along an avenue,
     round on the rim road, back along the next avenue, round again on the
     first ring. A lane that cuts a corner between two avenues is a lane that
     flies through the middle of the Spires. */
  for (let i = 0; i < 4; i++) {
    const a0 = (i / 4) * TAU;
    lanes.push(
      avenueLane(
        a0,
        a0 + Math.PI / 4,
        RING_R[0],
        RIM_R,
        DECK + 51 + (i % 2) * 3,
        DECK + 75 + (i % 2) * 3,
        32,
      ),
    );
  }

  const perLane = low ? [2, 2, 2, 2, 1, 1, 1, 1] : [6, 8, 9, 7, 4, 4, 4, 4];
  let carCount = 0;
  for (let i = 0; i < lanes.length; i++) {
    lanes[i].first = carCount;
    lanes[i].count = perLane[i] ?? 2;
    carCount += lanes[i].count;
  }

  const carLane = new Int32Array(carCount);
  const carS = new Float32Array(carCount);
  const carV = new Float32Array(carCount);
  const carSample = new Int32Array(carCount);
  const carWant = new Float32Array(carCount);
  const carTint = new Float32Array(carCount * 3);
  const carPhase = new Float32Array(carCount);

  const TINTS = [0xd8dde6, 0xb4c3d4, 0x8fa2bd, 0xd6b48c, 0xc2c8cf, 0x9fb3a6, 0xcfa5a0];
  const tmpColor = new THREE.Color();
  for (let li = 0; li < lanes.length; li++) {
    const lane = lanes[li];
    for (let k = 0; k < lane.count; k++) {
      const c = lane.first + k;
      carLane[c] = li;
      // Evenly spaced round the loop, so nobody starts inside anybody.
      carS[c] = (lane.total * k) / lane.count;
      carV[c] = lane.speed;
      carWant[c] = lane.speed * rng.range(0.88, 1.06);
      carPhase[c] = rng.next();
      tmpColor.setHex(rng.pick(TINTS));
      carTint[c * 3] = tmpColor.r;
      carTint[c * 3 + 1] = tmpColor.g;
      carTint[c * 3 + 2] = tmpColor.b;
    }
  }

  /* ---- the tram -------------------------------------------------------- */
  const tramLane = ringLane(TRAM_R, DECK - KERB_H + 0.34, 1, TRAM_VMAX);
  const stopS: number[] = TRAM_STOPS.map((s) => {
    // Where along the loop that angle lands. The lane is a circle wound
    // counter-clockwise from angle zero, so this is just arclength.
    let a = s.a;
    while (a < 0) a += TAU;
    while (a >= TAU) a -= TAU;
    return (a / TAU) * tramLane.total;
  });
  const stopOrder = stopS.map((_, i) => i).sort((a, b) => stopS[a] - stopS[b]);

  const stops = TRAM_STOPS.map((s) => ({
    id: s.id,
    x: Math.cos(s.a) * (TRAM_R - PLATFORM_OFF),
    y: DECK + PLATFORM_TOP,
    z: Math.sin(s.a) * (TRAM_R - PLATFORM_OFF),
  }));
  /** Where the four stops fall as fractions of the loop, for the route strip. */
  const stopFrac = new THREE.Vector4(
    stopS[0] / tramLane.total,
    stopS[1] / tramLane.total,
    stopS[2] / tramLane.total,
    stopS[3] / tramLane.total,
  );

  let tramS = stopS[stopOrder[0]];
  let tramV = 0;
  let tramDwell = TRAM_DWELL;
  let tramTargetIdx = 0; // index into stopOrder
  let tramStopped = true;
  /** 0 shut, 1 fully open. Only the inner side has doors that ever move. */
  let doorPhase = 0;
  /** Edge-detected, so the arrival is announced once rather than every frame. */
  let announced = -1;

  const tram: TramState = {
    x: Math.cos(TRAM_STOPS[stopOrder[0]].a) * TRAM_R,
    y: DECK,
    z: Math.sin(TRAM_STOPS[stopOrder[0]].a) * TRAM_R,
    yaw: 0,
    stopped: true,
    doorsOpen: false,
    atStop: TRAM_STOPS[stopOrder[0]].id,
    dwell: TRAM_DWELL,
    nextStop: TRAM_STOPS[stopOrder[0]].name,
  };

  /* ---- the cars, as things you can stand in ----------------------------
   *
   * One `MovingFrame` per car. Everything in them is in the car's own frame,
   * so nothing here has to know that the ring is a circle: the pose is four
   * numbers written once a frame and every query is exact at any angle.
   *
   * Two decisions worth keeping:
   *
   * - **The floor deck is 10 cm wider than the body on each side.** That is
   *   the threshold plate. The platform's outer edge stops 15 cm short of the
   *   car, and a body whose support is sampled at a single point can put that
   *   point in the gap for a frame; a deck that reaches out to meet the
   *   platform means it never does. It cannot pick anybody up off the road,
   *   because a road-level body is 76 cm below it and the step-up only
   *   reaches 62.
   * - **The side walls start 60 cm below the floor, not at it.** A body on the
   *   platform stands 52 cm below the car floor, and a blocker whose underside
   *   is level with the floor reads to `blockedAt` as something that body is
   *   flying underneath — so the shut side of the tram would not stop anybody
   *   standing on the platform. The same trick, for the same reason, is what
   *   holds the spire's lift rails together.
   */
  const CAR_BLOCK_BOTTOM = CAR_FLOOR - 0.6;

  /** The boxes shared by every state of a car. */
  const carShell = (): Blocker[] => {
    const out: Blocker[] = [];
    // The outer side is one unbroken wall: its doors exist, and never open.
    out.push({
      x: -WALL_X, z: 0, hx: WALL_T, hz: CAR_HL,
      bottom: CAR_BLOCK_BOTTOM, top: CAR_CEIL,
    });
    // The inner side, either side of the doorway.
    for (const z of [-SEG_CZ, SEG_CZ]) {
      out.push({
        x: WALL_X, z, hx: WALL_T, hz: SEG_HZ,
        bottom: CAR_BLOCK_BOTTOM, top: CAR_CEIL,
      });
    }
    // The two bulkheads.
    for (const z of [-END_CZ, END_CZ]) {
      out.push({
        x: 0, z, hx: CAR_HW, hz: 0.12,
        bottom: CAR_BLOCK_BOTTOM, top: CAR_CEIL,
      });
    }
    return out;
  };

  /** The doorway, when it is shut. */
  const carDoorShut = (): Blocker => ({
    x: WALL_X, z: 0, hx: WALL_T, hz: DOOR_HZ,
    bottom: CAR_BLOCK_BOTTOM, top: CAR_CEIL,
  });

  interface CarFrame extends MovingFrame {
    /** Prebuilt, swapped by the doors. No allocation, no re-indexing. */
    shutList: Blocker[];
    openList: Blocker[];
  }

  const carFrames: CarFrame[] = [];
  for (let i = 0; i < 3; i++) {
    const openList = carShell();
    const shutList = openList.concat([carDoorShut()]);
    carFrames.push({
      x: 0,
      y: DECK,
      z: 0,
      yaw: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      w: 0,
      // Generous: the diagonal of the deck is 5.43, and a cull radius that is
      // too small is a tram you fall through when you walk to the far end.
      radius: 7,
      blockers: shutList,
      decks: [{ x: 0, z: 0, hx: CAR_HW + 0.1, hz: CAR_HL - 0.15, y: CAR_FLOOR }],
      shutList,
      openList,
    });
  }

  /* ---- the platforms, as frames too ------------------------------------
   *
   * They do not move, and they are frames anyway: two of the four sit at 45
   * degrees to the axes, and an oblique deck indexed by its bounding box
   * would report solid platform over several metres of open roadway beside
   * it. A frame with a zero velocity costs one squared-distance test and is
   * exact. */
  const platformFrames: MovingFrame[] = TRAM_STOPS.map((sp, i) => ({
    x: stops[i].x,
    y: DECK,
    z: stops[i].z,
    yaw: -sp.a,
    vx: 0,
    vy: 0,
    vz: 0,
    w: 0,
    // The far corner of a 35 m slab is 26 m from the stop; be generous.
    radius: 28,
    blockers: [],
    decks: [{ x: PLATFORM_CX, z: PLATFORM_CZ, hx: PLATFORM_HX, hz: PLATFORM_HZ, y: PLATFORM_TOP }],
  }));

  const frames: MovingFrame[] = [...carFrames, ...platformFrames];
  /** False until the cars have been posed once; see the velocity below. */
  let posed = false;

  /* ---- the seats -------------------------------------------------------
   * Four benches a car, three places on each. Written in the car's frame once
   * and swung into world space every frame, so `crowd.ts` could one day sit
   * somebody down without either file learning about the other. */
  const SEAT_LOCAL: Array<{ x: number; z: number; yaw: number }> = [];
  for (const side of [1, -1]) {
    for (const h of [-1, 1]) {
      for (const k of [-1, 0, 1]) {
        SEAT_LOCAL.push({
          x: 0.92 * side,
          z: 2.9 * h + k * 1.05,
          // A longitudinal bench faces across the car: +X bench looks at -X.
          yaw: side > 0 ? Math.PI / 2 : -Math.PI / 2,
        });
      }
    }
  }
  const seats: TramSeat[] = [];
  for (let c = 0; c < 3; c++) {
    for (const sl of SEAT_LOCAL) {
      seats.push({ car: c, x: 0, y: DECK + CAR_FLOOR, z: 0, yaw: sl.yaw });
    }
  }

  /* ---- birds ----------------------------------------------------------- */
  const BIRDS = low ? 0 : 26;
  const birdA = new Float32Array(BIRDS);
  const birdR = new Float32Array(BIRDS);
  const birdY = new Float32Array(BIRDS);
  const birdW = new Float32Array(BIRDS);
  const birdPhase = new Float32Array(BIRDS);
  for (let i = 0; i < BIRDS; i++) {
    const flock = Math.floor(i / 9);
    birdA[i] = rng.range(0, TAU) + flock * 2.1;
    birdR[i] = PLATEAU_R * rng.range(0.45, 1.15) + flock * 40;
    birdY[i] = DECK + rng.range(20, 150) + flock * 30;
    birdW[i] = rng.range(0.035, 0.062) * (flock % 2 === 0 ? 1 : -1);
    birdPhase[i] = rng.next();
  }

  /* ---- meshes ---------------------------------------------------------- */
  const uniforms = {
    uTime: { value: 0 },
    uNight: { value: 0.6 },
    uSun: { value: SUN_DIR.clone() },
    uSunCol: { value: new THREE.Color(1.5, 1.12, 0.84) },
    uSkyCol: { value: new THREE.Color(0.3, 0.3, 0.42) },
    /* The route strip's two numbers: how far round the ring the tram is, and
       where the four stops are. Shared with the skycars' material, which
       never draws a part 3 and so never reads either of them. */
    uRoute: { value: 0 },
    uStops: { value: stopFrac },
  };

  const hullMat = new THREE.ShaderMaterial({
    name: "EmpyreanVehicle",
    uniforms,
    vertexShader: HULL_VERT,
    fragmentShader: HULL_FRAG,
    fog: false,
  });
  /* Real glass, and only for the tram: the hull shader's glass part is an
     opaque panel, which is the right call at four hundred metres and the
     wrong one when you are sitting behind it. Two-sided and depth-write off,
     because you look out through the near pane and in through the far one. */
  const tramGlassMat = new THREE.ShaderMaterial({
    name: "EmpyreanTramGlass",
    uniforms,
    vertexShader: TRAM_GLASS_VERT,
    fragmentShader: TRAM_GLASS_FRAG,
    fog: false,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const birdMat = new THREE.ShaderMaterial({
    name: "EmpyreanBirds",
    uniforms,
    vertexShader: BIRD_VERT,
    fragmentShader: BIRD_FRAG,
    fog: false,
    side: THREE.DoubleSide,
  });

  /**
   * A fleet is a real `InstancedMesh`, and that is a correctness decision
   * rather than a stylistic one.
   *
   * The obvious alternative — a plain `Mesh` over an `InstancedBufferGeometry`
   * with the transform in custom attributes — draws identically and is what
   * the crowd does, because eight hundred bodies want four floats a frame
   * rather than sixteen. But it makes every three.js utility lie about where
   * the thing is: `Box3.setFromObject` reads the *geometry's* box for a plain
   * mesh, which is authored around the origin, so a tram lapping the ring at
   * y = 620 reports as a ten-metre box sitting on the ice six hundred metres
   * below the city. Frustum tests, raycasts and "where is the tram" queries
   * all inherit that. `InstancedMesh` carries an object-level bounding box
   * that walks the instance matrices, so it answers honestly — and at
   * seventy-nine vehicles the per-frame matrix compose is free.
   */
  interface Fleet {
    geo: THREE.BufferGeometry;
    mesh: THREE.InstancedMesh;
    tint: Float32Array;
    glow: Float32Array;
    attrs: THREE.InstancedBufferAttribute[];
  }

  const makeFleet = (src: RawGeo, mat: THREE.ShaderMaterial, cap: number): Fleet => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(src.position, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(src.normal, 3));
    geo.setAttribute("aPart", new THREE.BufferAttribute(src.part, 1));
    geo.setIndex(new THREE.BufferAttribute(src.index, 1));
    const n = Math.max(1, cap);
    const tint = new Float32Array(n * 3);
    const glow = new Float32Array(n * 2);
    const attrs: THREE.InstancedBufferAttribute[] = [];
    const bind = (name: string, arr: Float32Array, size: number) => {
      const attr = new THREE.InstancedBufferAttribute(arr, size);
      geo.setAttribute(name, attr);
      attrs.push(attr);
    };
    // Colour and glow are per-vehicle and written once; only the matrices move.
    bind("aTint", tint, 3);
    bind("aGlow", glow, 2);
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.count = cap;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    group.add(mesh);
    return { geo, mesh, tint, glow, attrs };
  };

  /* One matrix and one euler, reused by every vehicle in the world. The order
     is YXZ — yaw, then pitch, then roll — which is the order a craft actually
     banks in and the order the old vertex shader composed by hand. */
  const mtx = new THREE.Matrix4();
  const eul = new THREE.Euler();
  const place = (
    fleet: Fleet,
    i: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    pitch: number,
    roll: number,
  ) => {
    eul.set(pitch, yaw, roll, "YXZ");
    mtx.makeRotationFromEuler(eul);
    mtx.setPosition(x, y, z);
    fleet.mesh.setMatrixAt(i, mtx);
  };

  /* Order matters here and only here: the fleets are the group's children in
     the order they are made, and the crowd's test reaches for children[0],
     [1] and [3] by index. Anything new goes on the end. */
  const cars = makeFleet(boxes(SKYCAR), hullMat, carCount);
  const tramCars = makeFleet(boxes(tramCarBoxes()), hullMat, 3);
  const platforms = makeFleet(boxes(PLATFORM), hullMat, stops.length);
  const birds = makeFleet(birdGeo(), birdMat, BIRDS);
  const tramGlass = makeFleet(boxes(tramGlassBoxes()), tramGlassMat, 3);
  /** Two leaves a doorway, two doorways a car — the outer pair never opens. */
  const DOOR_LEAVES = 3 * 4;
  const tramDoors = makeFleet(boxes(tramDoorBoxes()), tramGlassMat, DOOR_LEAVES);

  for (let c = 0; c < carCount; c++) {
    cars.tint[c * 3] = carTint[c * 3];
    cars.tint[c * 3 + 1] = carTint[c * 3 + 1];
    cars.tint[c * 3 + 2] = carTint[c * 3 + 2];
    cars.glow[c * 2] = 1;
    cars.glow[c * 2 + 1] = carPhase[c];
  }
  for (let i = 0; i < 3; i++) {
    /* Darker than the old solid box, and deliberately.
     *
     * The car used to be five boxes seen from four hundred metres, where a
     * near-white hull is what makes it read against the city at all. It is
     * now forty boxes with an inside, and at this sun a 0.8 albedo takes the
     * whole interior to paper: no shading, no depth, and the lit strips and
     * the route diagram lost inside it. Two thirds of the way down leaves the
     * silhouette intact at distance and gives the inside somewhere to go. */
    tramCars.tint[i * 3] = 0.55;
    tramCars.tint[i * 3 + 1] = 0.59;
    tramCars.tint[i * 3 + 2] = 0.66;
    tramCars.glow[i * 2] = 1;
    tramCars.glow[i * 2 + 1] = i * 0.31;
  }
  // Platforms never move; write them once and never touch them again.
  for (let i = 0; i < stops.length; i++) {
    const a = TRAM_STOPS[i].a;
    // The slab runs along the road, so its long axis is the tangent.
    place(platforms, i, stops[i].x, DECK, stops[i].z, -a, 0, 0);
    platforms.tint[i * 3] = 0.52;
    platforms.tint[i * 3 + 1] = 0.55;
    platforms.tint[i * 3 + 2] = 0.6;
    platforms.glow[i * 2] = 1;
    platforms.glow[i * 2 + 1] = i * 0.2;
  }
  for (const attr of platforms.attrs) attr.needsUpdate = true;
  platforms.mesh.instanceMatrix.needsUpdate = true;
  platforms.mesh.computeBoundingBox();
  platforms.mesh.computeBoundingSphere();
  for (let i = 0; i < BIRDS; i++) {
    birds.tint[i * 3] = 0.10;
    birds.tint[i * 3 + 1] = 0.09;
    birds.tint[i * 3 + 2] = 0.13;
    birds.glow[i * 2] = 1;
    birds.glow[i * 2 + 1] = birdPhase[i];
  }
  for (const attr of birds.attrs) attr.needsUpdate = true;
  /* The glass fleets carry no colour of their own — the shader tints them —
     but `aGlow.x` is the door edge's gain and defaults to zero, which would
     draw twelve unlit black frames. */
  for (const fleet of [tramGlass, tramDoors]) {
    for (let i = 0; i < fleet.mesh.count; i++) {
      fleet.tint[i * 3] = 0.78;
      fleet.tint[i * 3 + 1] = 0.84;
      fleet.tint[i * 3 + 2] = 0.92;
      fleet.glow[i * 2] = 1;
      fleet.glow[i * 2 + 1] = i * 0.17;
    }
    for (const attr of fleet.attrs) attr.needsUpdate = true;
  }

  /* ---- running lights -------------------------------------------------- */
  const LIGHTS_PER_CAR = 3;
  const lightCount = carCount * LIGHTS_PER_CAR + 3 * 2;
  const lightPos = new Float32Array(lightCount * 3);
  const lightCol = new Float32Array(lightCount * 3);
  const lightSize = new Float32Array(lightCount);
  for (let c = 0; c < carCount; c++) {
    const b = c * LIGHTS_PER_CAR;
    // Port red, starboard green, and a white strobe on the fin. Aircraft
    // convention, because everybody already knows how to read it.
    lightCol.set([1.0, 0.16, 0.14], b * 3);
    lightCol.set([0.2, 1.0, 0.35], (b + 1) * 3);
    lightCol.set([1.0, 0.95, 0.85], (b + 2) * 3);
    lightSize[b] = 1.5;
    lightSize[b + 1] = 1.5;
    lightSize[b + 2] = 2.2;
  }
  for (let i = 0; i < 6; i++) {
    const b = carCount * LIGHTS_PER_CAR + i;
    lightCol.set([1.0, 0.78, 0.42], b * 3);
    lightSize[b] = 2.4;
  }
  const lightGeo = new THREE.BufferGeometry();
  const lightPosAttr = new THREE.BufferAttribute(lightPos, 3);
  lightPosAttr.setUsage(THREE.DynamicDrawUsage);
  lightGeo.setAttribute("position", lightPosAttr);
  lightGeo.setAttribute("color", new THREE.BufferAttribute(lightCol, 3));
  lightGeo.setAttribute("aSize", new THREE.BufferAttribute(lightSize, 1));
  lightGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, DECK, 0), PLATEAU_R * 2);
  const lightMat = new THREE.ShaderMaterial({
    name: "EmpyreanVehicleLights",
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: { uScale: { value: 620 } },
    vertexShader: LIGHT_VERT,
    fragmentShader: LIGHT_FRAG,
  });
  lightMat.vertexColors = true;
  const lights = new THREE.Points(lightGeo, lightMat);
  lights.name = "empyrean-vehicle-lights";
  lights.frustumCulled = false;
  group.add(lights);

  /* -----------------------------------------------------------------------
   * Frame
   * -------------------------------------------------------------------- */

  /** Where a lane is at arclength `s`, written into these six numbers. */
  const sampleOut = new Float32Array(6); // x, y, z, yaw, pitch, curv
  const tramSample = new Int32Array(3);

  const sampleLane = (lane: Lane, s: number, hint: number): number => {
    let si = hint;
    if (si < 0 || si >= lane.n) si = 0;
    let guard = 0;
    while (s >= lane.cum[si + 1] && guard++ < lane.n) si = (si + 1) % lane.n;
    while (s < lane.cum[si] && guard++ < lane.n * 2) si = (si + lane.n - 1) % lane.n;
    const a = lane.cum[si];
    const b = lane.cum[si + 1];
    const t = b > a ? (s - a) / (b - a) : 0;
    const j = (si + 1) % lane.n;
    sampleOut[0] = lane.x[si] + (lane.x[j] - lane.x[si]) * t;
    sampleOut[1] = lane.y[si] + (lane.y[j] - lane.y[si]) * t;
    sampleOut[2] = lane.z[si] + (lane.z[j] - lane.z[si]) * t;
    let dy = lane.yaw[j] - lane.yaw[si];
    while (dy > Math.PI) dy -= TAU;
    while (dy < -Math.PI) dy += TAU;
    sampleOut[3] = lane.yaw[si] + dy * t;
    sampleOut[4] = lane.pitch[si] + (lane.pitch[j] - lane.pitch[si]) * t;
    sampleOut[5] = lane.curv[si];
    return si;
  };

  /* -----------------------------------------------------------------------
   * Riding it
   *
   * Boarding is walking through an open door onto a deck, and stepping off is
   * walking back out. Everything below is the *prompt*, which exists for the
   * player who would rather press a key than aim at a doorway — and for the
   * one who cannot tell that the doorway is a doorway. Neither of them is a
   * different code path: the prompt sets the body down on the same deck the
   * walk would have carried it to.
   *
   * The player's position is not passed to `activate()`, so it is held from
   * the frame context. That is the same handle `spire.ts` uses to set a body
   * onto a descending lift floor; `ctx.player.position` is the live vector,
   * mutated in place by the engine and never reallocated.
   * -------------------------------------------------------------------- */
  let playerPos: THREE.Vector3 | null = null;
  let playerVel: THREE.Vector3 | null = null;

  /** Which car the player is standing in, or -1. */
  const aboardCar = (): number => {
    if (!playerPos) return -1;
    for (let i = 0; i < carFrames.length; i++) {
      const f = carFrames[i];
      const dx = playerPos.x - f.x;
      const dz = playerPos.z - f.z;
      if (dx * dx + dz * dz > f.radius * f.radius) continue;
      const c = Math.cos(f.yaw);
      const sn = Math.sin(f.yaw);
      const lx2 = dx * c - dz * sn;
      const lz2 = dx * sn + dz * c;
      const ly = playerPos.y - f.y;
      if (
        Math.abs(lx2) <= CAR_HW &&
        Math.abs(lz2) <= CAR_HL &&
        ly > CAR_FLOOR - 0.4 &&
        ly < CAR_FLOOR + 2.4
      ) {
        return i;
      }
    }
    return -1;
  };

  /** Put the body at a point in a car's frame. */
  const setLocal = (f: MovingFrame, lx2: number, lz2: number, ly: number) => {
    if (!playerPos) return;
    const c = Math.cos(f.yaw);
    const sn = Math.sin(f.yaw);
    playerPos.set(f.x + lx2 * c + lz2 * sn, f.y + ly, f.z - lx2 * sn + lz2 * c);
    playerVel?.set(0, 0, 0);
  };

  /* Held in a box rather than closed over directly, because `onToast` is set
     by the engine after this function has returned and a captured `null`
     would stay null for ever. */
  const onToastRef: { fn: ((t: string, tone?: "info" | "good" | "warn") => void) | null } = {
    fn: null,
  };

  /** The stop after the one with this index in `TRAM_STOPS`. */
  const stopAfter = (idx: number) => {
    const at = stopOrder.indexOf(idx);
    return TRAM_STOPS[stopOrder[(at + 1) % stopOrder.length]];
  };

  const hits: Interactable[] = TRAM_STOPS.map((sp, i) => {
    /* The prompt sits between the platform edge and the car rather than in
       the middle of the slab, so it reaches both somebody waiting on the
       platform and somebody standing inside the tram four metres away. */
    const pr = TRAM_R - 2.6;
    const here: Interactable = {
      id: `tram-${sp.id}`,
      x: Math.cos(sp.a) * pr,
      y: DECK + PLATFORM_TOP,
      z: Math.sin(sp.a) * pr,
      /* Wide enough to cover the whole seventeen-metre platform and the car
         standing beside it, which is the point: this one prompt has to reach
         somebody waiting at either end of the platform and somebody already
         sitting down inside the tram. It is harmless to be generous, because
         it is only offered at all while the train is standing there. */
      radius: 14,
      label: "Board the tram",
      detail: undefined,
      enabled: () => tram.stopped && tram.atStop === sp.id && tram.doorsOpen,
      activate() {
        const car = aboardCar();
        if (car >= 0) {
          // Off. Onto the platform, a metre in from its edge, facing the city.
          if (playerPos) {
            const rr = TRAM_R - PLATFORM_OFF + PLATFORM_CX + PLATFORM_HX - 1.2;
            playerPos.set(Math.cos(sp.a) * rr, DECK + PLATFORM_TOP, Math.sin(sp.a) * rr);
            playerVel?.set(0, 0, 0);
          }
          onToastRef.fn?.(`${sp.name}.`, "info");
          return;
        }
        /* On. Onto the centre line of the nearest car, not the doorway.
         *
         * A body set down at the doorway sits four centimetres off the edge
         * of the band `pushOutAt` clears, so the sway of a normal ride nudges
         * it in and out of the doors' reach for the whole journey. It is
         * invisible and it is also pointless: the middle of the car is where
         * somebody stepping aboard would end up anyway. */
        let best = 0;
        let bestD = Infinity;
        if (playerPos) {
          for (let k = 0; k < carFrames.length; k++) {
            const d = Math.hypot(playerPos.x - carFrames[k].x, playerPos.z - carFrames[k].z);
            if (d < bestD) {
              bestD = d;
              best = k;
            }
          }
        }
        setLocal(carFrames[best], 0.3, 0, CAR_FLOOR + 0.02);
        onToastRef.fn?.(`Aboard. Next stop: ${stopAfter(i).name}`, "good");
      },
    };
    return here;
  });

  /* Both sets of prompt text, built once. The stops never change, so neither
     do these; the frame only ever chooses between them. */
  const stepOffLabel = TRAM_STOPS.map((sp) => `Step off at ${sp.name}`);
  const nextStopLabel = TRAM_STOPS.map((_, i) => `Next stop: ${stopAfter(i).name}`);
  let wasRiding = true; // so the first frame writes the boarding labels

  /* Entered and returned, counted separately.
   *
   * A system's `update` is called from one unguarded loop over every system,
   * so an exception thrown in the middle of one stops every system after it
   * and leaves this one's state half-written — and from outside, a tram whose
   * pose stopped being written is indistinguishable from a tram that has
   * simply stopped. These two numbers tell those apart in one glance: they
   * differ by at most one, and a widening gap is a throw. */
  let ticksIn = 0;
  let ticksOut = 0;

  const update = (frame: FrameContext) => {
    ticksIn++;
    const dt = frame.dt;
    playerPos = frame.player.position;
    playerVel = frame.player.velocity;
    uniforms.uTime.value = frame.time;
    /* Two different daylights, and the difference matters here more than
       anywhere else in this file. `daylight` is the lamp switch — it is what
       decides whether a craft's running lights and a tram's windows are lit,
       and it reads 0.32 at the sunset the world is painted at, which is
       exactly right for "the lights are on". `gradeDaylight` is how much
       light there is to shade a hull by, and shading with the other one puts
       every skycar in the sky at a third brightness under the brightest sky
       of the day. */
    uniforms.uNight.value = 1 - frame.daylight;
    (uniforms.uSun.value as THREE.Vector3).copy(frame.sunDir);
    const warm = 0.4 + frame.gradeDaylight * 0.9;
    (uniforms.uSunCol.value as THREE.Color).setRGB(1.5 * warm, 1.08 * warm, 0.78 * warm);
    (uniforms.uSkyCol.value as THREE.Color).setRGB(
      0.13 + frame.gradeDaylight * 0.2,
      0.13 + frame.gradeDaylight * 0.19,
      0.2 + frame.gradeDaylight * 0.24,
    );

    /* ---- skycars ------------------------------------------------------- */
    for (let li = 0; li < lanes.length; li++) {
      const lane = lanes[li];
      for (let k = 0; k < lane.count; k++) {
        const c = lane.first + k;
        // The car in front is the next one round the loop; nobody overtakes,
        // so this ordering is fixed for the life of the world.
        const ahead = lane.first + ((k + 1) % lane.count);
        let gap = carS[ahead] - carS[c];
        if (gap <= 0) gap += lane.total;
        const minGap = 24;
        let want = carWant[c];
        if (gap < minGap * 2.2) {
          want *= Math.max(0.08, (gap - minGap * 0.55) / (minGap * 1.65));
        }
        const accel = want > carV[c] ? 7 : 12;
        carV[c] += Math.max(-accel * dt, Math.min(accel * dt, want - carV[c]));
        if (carV[c] < 0) carV[c] = 0;
        carS[c] += carV[c] * dt;
        if (carS[c] >= lane.total) carS[c] -= lane.total;

        carSample[c] = sampleLane(lane, carS[c], carSample[c]);
        const x = sampleOut[0];
        const y = sampleOut[1];
        const z = sampleOut[2];
        const yaw = sampleOut[3];
        const roll = Math.atan((carV[c] * carV[c] * sampleOut[5]) / 9.81);
        const bank = Math.max(-0.9, Math.min(0.9, roll));
        place(cars, c, x, y, z, yaw, sampleOut[4], bank);

        // Wingtips and a strobe, in the craft's own frame.
        const sy = Math.sin(yaw);
        const cy = Math.cos(yaw);
        const sr = Math.sin(bank);
        const cr = Math.cos(bank);
        const b = c * LIGHTS_PER_CAR;
        const put = (idx: number, lx: number, ly: number, lz: number) => {
          const rx = lx * cr - ly * sr;
          const ry = lx * sr + ly * cr;
          lightPos[idx * 3] = x + rx * cy + lz * sy;
          lightPos[idx * 3 + 1] = y + ry;
          lightPos[idx * 3 + 2] = z - rx * sy + lz * cy;
        };
        put(b, 1.68, -0.12, 0.5);
        put(b + 1, -1.68, -0.12, 0.5);
        // The strobe is switched off by being moved *inside* the fuselage,
        // where the hull's own depth occludes it. Cheaper than a per-point
        // alpha the shader would have to carry for every light on every car.
        const strobe = Math.sin(frame.time * 3.4 + carPhase[c] * 6.283) > 0.86;
        put(b + 2, 0, strobe ? 1.5 : 0, strobe ? 2.3 : 0.2);
      }
    }

    /* ---- the tram ------------------------------------------------------ */
    const targetStop = stopOrder[tramTargetIdx];
    if (tramStopped) {
      tramDwell -= dt;
      if (tramDwell <= 0) {
        tramStopped = false;
        tramTargetIdx = (tramTargetIdx + 1) % stopOrder.length;
      }
    } else {
      let togo = stopS[stopOrder[tramTargetIdx]] - tramS;
      while (togo < 0) togo += tramLane.total;
      const brake = (tramV * tramV) / (2 * TRAM_ACCEL);
      tramV += (togo <= brake ? -TRAM_ACCEL : TRAM_ACCEL) * dt;
      /* The floor is not a detail. Braking on a discrete step can put the
         speed at zero a metre short of the platform, and a tram that has
         stopped without *arriving* never arrives: it is still braking, so it
         never accelerates, and the ring stands still for the rest of the
         session. Creep in. */
      tramV = Math.min(TRAM_VMAX, Math.max(1.0, tramV));
      tramS += tramV * dt;
      if (tramS >= tramLane.total) tramS -= tramLane.total;
      let left = stopS[stopOrder[tramTargetIdx]] - tramS;
      while (left < 0) left += tramLane.total;
      if (left < 0.9 || left > tramLane.total - 0.9) {
        tramS = stopS[stopOrder[tramTargetIdx]];
        tramV = 0;
        tramStopped = true;
        tramDwell = TRAM_DWELL;
      }
    }

    /* ---- the doors ------------------------------------------------------
     *
     * They open on arrival and are shut again before departure, which is a
     * second state machine rather than a rendering of `stopped`: a door that
     * takes 0.9 s to close and is only told to close on departure is a door
     * that is still a metre open while the tram is doing 4 m/s. The dwell is
     * the clock they run against, so they lead the departure by
     * DOOR_SHUT_LEAD and are a wall again before the wheels turn.
     *
     * When the tram is not at a platform at all the target is zero, so a tram
     * that somehow left with them open shuts them on the way. */
    const wantOpen = tramStopped && tramDwell > DOOR_SHUT_LEAD ? 1 : 0;
    const dstep = dt / DOOR_TIME;
    doorPhase += Math.max(-dstep, Math.min(dstep, wantOpen - doorPhase));
    const doorsOpen = doorPhase >= DOOR_CLEAR;

    for (let i = 0; i < 3; i++) {
      let s = tramS - i * CAR_GAP;
      while (s < 0) s += tramLane.total;
      tramSample[i] = sampleLane(tramLane, s, tramSample[i]);
      const cx = sampleOut[0];
      const cy = sampleOut[1];
      const cz = sampleOut[2];
      const cyaw = sampleOut[3];
      place(tramCars, i, cx, cy, cz, cyaw, 0, 0);
      place(tramGlass, i, cx, cy, cz, cyaw, 0, 0);

      /* ---- the car as a place to stand -------------------------------
       *
       * The pose is written from the same sample the mesh is drawn from, so
       * the deck and the geometry can never disagree — that is the failure
       * the world test caught once already, with the tram reporting perfect
       * coordinates and its cars sitting on the ice.
       *
       * The velocity is the tram's own, resolved onto the car's heading. It
       * is what `flight.ts` adds to a passenger's position, and it is a
       * frame behind the pose by construction: systems update after the body
       * has stepped, so the body is always carried by the speed the tram had
       * when it was where the body thought it was. The residual is a dt of
       * acceleration — about a centimetre a second at 5 m/s squared — and it
       * shows up as the passenger swaying half a metre towards the back
       * under power and forward under braking, which is what a tram does.
       */
      const f = carFrames[i];
      /* The velocity and the yaw rate are **measured**, not derived.
       *
       * The obvious version takes the tram's speed and its heading and
       * multiplies. It is wrong, and wrong in a way that takes about three
       * seconds to throw a passenger onto the road: the lane is a 152-sided
       * polygon, so the car's position advances along a chord while
       * `sampleLane` interpolates the heading *between* two chords. The two
       * disagree by half a segment's turn — 0.02 rad — which at 30 m/s is
       * 0.6 m/s of sideways carry that nothing corrects.
       *
       * What the passenger actually needs is the motion the frame really
       * made, so that is what is published: last pose to this pose, over dt.
       * It is exact by construction, it costs a subtraction, and it stays
       * right if the lane is ever resampled.
       */
      if (posed && dt > 1e-6) {
        f.vx = (cx - f.x) / dt;
        f.vy = (cy - f.y) / dt;
        f.vz = (cz - f.z) / dt;
        let dyaw = cyaw - f.yaw;
        while (dyaw > Math.PI) dyaw -= TAU;
        while (dyaw < -Math.PI) dyaw += TAU;
        f.w = dyaw / dt;
      }
      f.x = cx;
      f.y = cy;
      f.z = cz;
      f.yaw = cyaw;
      f.blockers = doorsOpen ? f.openList : f.shutList;

      /* ---- the doors, four leaves a car ------------------------------ */
      const dc = Math.cos(cyaw);
      const ds = Math.sin(cyaw);
      const slide = doorPhase * (DOOR_HZ - 0.06);
      for (let k = 0; k < 4; k++) {
        // k 0,1 are the inner pair and slide; 2,3 are the outer pair and do
        // not, because there is never a platform on that side.
        const inner = k < 2;
        const lead = k % 2 === 0 ? -1 : 1;
        const lz2 = lead * (DOOR_HZ / 2 + (inner ? slide : 0));
        const lx2 = inner ? CAR_HW + 0.05 : -(CAR_HW + 0.05);
        place(
          tramDoors,
          i * 4 + k,
          cx + lx2 * dc + lz2 * ds,
          cy,
          cz - lx2 * ds + lz2 * dc,
          cyaw,
          0,
          0,
        );
      }

      /* ---- the seats, in world space --------------------------------- */
      for (let k = 0; k < SEAT_LOCAL.length; k++) {
        const sl = SEAT_LOCAL[k];
        const seat = seats[i * SEAT_LOCAL.length + k];
        seat.x = cx + sl.x * dc + sl.z * ds;
        seat.y = cy + CAR_FLOOR;
        seat.z = cz - sl.x * ds + sl.z * dc;
        seat.yaw = cyaw + sl.yaw;
      }

      if (i === 0) {
        tram.x = cx;
        tram.y = cy;
        tram.z = cz;
        tram.yaw = cyaw;
        const headLight = carCount * LIGHTS_PER_CAR;
        lightPos[headLight * 3] = cx;
        lightPos[headLight * 3 + 1] = cy + 2.4;
        lightPos[headLight * 3 + 2] = cz;
      }
      if (i === 2) {
        const tailLight = carCount * LIGHTS_PER_CAR + 1;
        lightPos[tailLight * 3] = cx;
        lightPos[tailLight * 3 + 1] = cy + 2.4;
        lightPos[tailLight * 3 + 2] = cz;
      }
    }
    posed = true;
    tram.stopped = tramStopped;
    tram.doorsOpen = doorsOpen;
    tram.atStop = tramStopped ? TRAM_STOPS[targetStop].id : "";
    tram.dwell = tramStopped ? Math.max(0, tramDwell) : 0;
    // Standing at a platform, the sign reads that platform; moving, it reads
    // the one you are heading for.
    tram.nextStop = TRAM_STOPS[tramStopped ? targetStop : stopOrder[tramTargetIdx]].name;
    /* Where the pip on the route strip sits. The strip is a diagram of the
       loop, so this is simply how far round the loop the front car is. */
    uniforms.uRoute.value = tramS / tramLane.total;

    /* ---- the prompts, and the announcement ------------------------------
     *
     * The label flips rather than there being two interactables, because from
     * the engine's side "the nearest thing you can press a key on" wants one
     * answer and the platform prompt reaches both the person waiting on it
     * and the person standing in the car four metres away. */
    const riding = aboardCar() >= 0;
    /* Rewritten on the edge, not every frame. Both branches build strings,
       and this file's own header says the frame path allocates nothing —
       eight interpolations sixty times a second is a garbage collector pause
       in the one system that is drawing eighty moving objects. */
    if (riding !== wasRiding) {
      wasRiding = riding;
      for (let i = 0; i < hits.length; i++) {
        const h = hits[i];
        if (riding) {
          h.label = stepOffLabel[i];
          h.detail = undefined;
        } else {
          h.label = "Board the tram";
          h.detail = nextStopLabel[i];
        }
      }
    }
    if (tramStopped && doorsOpen && announced !== targetStop) {
      announced = targetStop;
      if (riding) {
        onToastRef.fn?.(
          `${TRAM_STOPS[targetStop].name}. Next stop: ${stopAfter(targetStop).name}`,
          "info",
        );
      }
    } else if (!tramStopped) {
      announced = -1;
    }

    // The four platform canopy lamps, so a stop is findable after dark.
    for (let i = 0; i < 4 && i < stops.length; i++) {
      const b = carCount * LIGHTS_PER_CAR + 2 + i;
      if (b >= lightCount) break;
      lightPos[b * 3] = stops[i].x;
      lightPos[b * 3 + 1] = DECK + 3.4;
      lightPos[b * 3 + 2] = stops[i].z;
    }

    /* ---- birds --------------------------------------------------------- */
    for (let i = 0; i < BIRDS; i++) {
      birdA[i] += birdW[i] * dt;
      const r = birdR[i] + Math.sin(frame.time * 0.21 + i) * 12;
      const x = Math.cos(birdA[i]) * r;
      const z = Math.sin(birdA[i]) * r;
      const y = birdY[i] + Math.sin(frame.time * 0.4 + i * 1.7) * 6;

      // Facing the way they are going: the tangent, whichever way round the
      // flock is drifting.
      const sw = birdW[i] < 0 ? -1 : 1;
      place(
        birds,
        i,
        x,
        y,
        z,
        Math.atan2(Math.sin(birdA[i]) * sw, -Math.cos(birdA[i]) * sw),
        Math.sin(frame.time * 0.6 + i) * 0.12,
        0,
      );
    }

    /* ---- upload -------------------------------------------------------- */
    /* Matrices up, and then the object-level bounds recomputed from them.
       Seventy-nine instances of eight corners is nothing, and it is what makes
       `Box3.setFromObject(tram)` agree with `tram.x` — without it the scene
       graph insists the whole fleet is a ten-metre box on the ice, which is
       both wrong and exactly the shape of a real bug worth catching. */
    for (const fleet of [cars, tramCars, tramGlass, tramDoors, birds]) {
      if (fleet.mesh.count === 0) continue;
      fleet.mesh.instanceMatrix.needsUpdate = true;
      fleet.mesh.computeBoundingBox();
      fleet.mesh.computeBoundingSphere();
    }
    lightPosAttr.needsUpdate = true;
    ticksOut++;
  };

  /* A hand on the tram from outside the world, for a harness.
   *
   * `__empyrean.state()` reports where the *player* is, and for anything that
   * carries a player that is exactly half the story: "the body did not move"
   * and "the tram did not move" are two different bugs with one symptom, and
   * five minutes were spent on the wrong one for want of this. The same
   * reasoning, and the same shape, as `spire.ts`'s `__empyreanLift`. */
  if (typeof window !== "undefined") {
    (window as unknown as { __empyreanTram?: unknown }).__empyreanTram = {
      /** Update entered / returned. A widening gap is an exception inside. */
      ticks: () => ({ in: ticksIn, out: ticksOut }),
      /** What the train is doing. */
      at: () => ({
        x: tram.x, y: tram.y, z: tram.z, yaw: tram.yaw,
        stopped: tram.stopped, doorsOpen: tram.doorsOpen,
        atStop: tram.atStop, nextStop: tram.nextStop,
      }),
      /** Each car's pose and the velocity a passenger on it is carried by. */
      cars: () =>
        carFrames.map((f) => ({
          x: f.x, y: f.y, z: f.z, yaw: f.yaw, vx: f.vx, vz: f.vz, w: f.w,
        })),
      /** The state machine in the raw, for when the pose looks fine. */
      run: () => ({
        s: tramS, v: tramV, dwell: tramDwell, door: doorPhase,
        target: tramTargetIdx, riding: aboardCar(),
      }),
      /**
       * End the dwell now and let it pull away.
       *
       * The same reasoning as `__empyreanLift.set()`: under this container's
       * rasteriser the world advances about a fiftieth of a second per real
       * second, so the seven-second stand at a platform is four real minutes
       * and a lap is over an hour. There is no way to watch a departure
       * otherwise, and "wait longer" is not a check anybody runs twice. It
       * only skips the *waiting* — the doors still close on their own clock
       * and the run between stops is the real one at the real speed.
       */
      skip() {
        if (tramStopped) tramDwell = Math.min(tramDwell, DOOR_SHUT_LEAD + 0.001);
      },
    };
  }

  const handle: TrafficHandle = {
    name: "traffic",
    group,
    tram,
    stops,
    frames,
    seats,
    /* A pair rather than a field, so the engine can assign `onToast` after
       this function has returned and the closures above still see it. A plain
       field would be written by `world.ts` and read by nobody. */
    get onToast() {
      return onToastRef.fn;
    },
    set onToast(fn) {
      onToastRef.fn = fn;
    },
    interactables: () => hits,
    update,
    dispose() {
      for (const fleet of [cars, tramCars, platforms, birds, tramGlass, tramDoors]) {
        fleet.mesh.dispose();
        fleet.geo.dispose();
        group.remove(fleet.mesh);
      }
      lightGeo.dispose();
      lightMat.dispose();
      group.remove(lights);
      hullMat.dispose();
      birdMat.dispose();
      tramGlassMat.dispose();
      if (typeof window !== "undefined") {
        const w = window as unknown as { __empyreanTram?: unknown };
        if (w.__empyreanTram) delete w.__empyreanTram;
      }
    },
  };
  return handle;
}
