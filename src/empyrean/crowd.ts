/**
 * The people.
 *
 * Sixteen hundred of them, walking the pavement graph in `cityplan.ts` with
 * somewhere to actually be: a shop door, the Beacon, the tram platform, one
 * particular end of one particular bench, a stretch of rim rail with four
 * hundred metres of nothing under it. They path there, they arrive, they do
 * something for a while, and then they pick somewhere else.
 *
 * ## How many, and why that many
 *
 * It was eight hundred and twenty, and eight hundred and twenty over a
 * six-hundred-and-eighty-metre island is one person per hundred and forty
 * square metres of pavement — which on a 4.5 m ring pavement is one person
 * every thirty metres of street, per side. That is not a quiet city, it is an
 * evacuated one, and no test could see it because every test here asks
 * whether a body is somewhere legal rather than whether there are enough of
 * them.
 *
 * Sixteen hundred is one every twelve metres or so. It is deliberately not
 * the number the budget allows: this costs 0.81 ms of CPU a frame against a
 * measured 0.31 at eight hundred and twenty, it is linear at about six tenths
 * of a microsecond a body, and half as many again would still fit inside the
 * frame and nowhere near the triangle ceiling. It stops here because a street
 * at six in the evening is mostly ordinary and quietly full, and the failure
 * past this point is a parade — which is worse than an empty street, because
 * an empty street at least reads as an empty street.
 *
 * The low tier is 640, the same 40% of the high tier it has always been.
 *
 * ## The mix, which is the whole point
 *
 * At any moment about seventy per cent of them are walking, fifteen are
 * standing — outside a shop, at a platform, in a pair facing each other —
 * ten are sitting (half of those on an actual bench) and five are on the rim
 * rail. That distribution is the deliverable. Push the errands longer and everyone is permanently in
 * transit, which reads as a commute; push the dwells longer and the pavement
 * is a waxwork. Neither is visible in a screenshot, so
 * `src/test/empyreanCrowd.test.ts` measures it through `nearest`: who is
 * standing here, and are they still here in five seconds.
 *
 * Sitting and leaning are the two long dwells and they draw from the same
 * pool, so on fixed weights they take turns winning — a hundred people on the
 * rim and nobody sitting for two minutes, then the reverse. Each is therefore
 * damped by how many are already doing it (`satiate`), which is both what
 * stabilises the mix and what a full bench does.
 *
 * ## The benches, and the two ways of sitting
 *
 * There are 334 benches in this city and for a long time nobody sat on any of
 * them, because a bench is not derivable from the plan — `props.ts` places
 * them from its own occupancy grid and its own RNG stream, and a system may
 * not import another system. So the best this file could do was a *kerb* sit:
 * hips a hand's breadth off the deck, legs straight out in front, which is
 * correct on a bench, a step, a plinth or bare pavement and, crucially, on
 * nothing at all. That is still what most sitting is, because there are a
 * hundred thousand square metres of pavement and 334 benches.
 *
 * The other half arrives through `buildCrowd`'s options: hand it the bench
 * placements and it lays two seats on each — 0.42 m either side of the middle
 * of 1.7 m of slat — and hands them out one at a time, exclusively, at the
 * moment a body decides where to go rather than when it gets there. Deciding
 * on arrival means two people walk to the same end of the same bench.
 * A couple gets both ends; a family's third and fourth members sit on the
 * kerb beside it, which is what fits and what happens.
 *
 * Three things about it are load-bearing:
 *
 * - **The seat is a height, not a flag.** `aPose.w` carries how high the
 *   thing under the body is and the whole chair sit is solved from it, so the
 *   kerb sit is the same three lines with a zero in them and is bit-for-bit
 *   what it was. With no seats supplied nothing here does anything at all.
 * - **A bench gets one extra leg of walking.** Every other destination is a
 *   nav node and a body stops on it; a bench is a metre off the pavement
 *   centreline and up to seven metres along it from the nearest node. So the
 *   last few metres are walked off the graph, decelerating, and the snap that
 *   finishes it is sixteen centimetres at a third of a metre a second.
 * - **The booking is given up in exactly two places** — when a body picks a
 *   new destination and when it goes indoors. Miss either and the benches
 *   fill up over ten minutes and never empty again.
 *
 * ## Nobody is on their own, and that is what makes it a place
 *
 * About a third of the deck is in a *group*: a couple, a parent with a child
 * or two, somebody with a dog. A group is one leader and its followers, laid
 * out contiguously in the arrays so the leader is always updated first, and
 * **only the leader decides anything**. It picks the destination, it holds the
 * path, it owns the dwell clock. The followers never path at all.
 *
 * That is deliberate, and it is the whole reason a family reads as a family.
 * Two pedestrians who happen to share a destination take the same A* result
 * and then diverge the moment one of them is shoved a metre sideways at a
 * junction — they arrive together having walked two different streets, which
 * from thirty metres is two strangers. So a follower does not navigate: it
 * walks where its leader *actually walked*, from a short ring buffer of the
 * leader's own recent positions, sampled every 32 cm of ground covered. A
 * child two samples back is 64 cm behind its parent, on ground the parent has
 * already proved is pavement, and it stays there round a corner, through a
 * crossing and into a crowd. When the leader stops, the followers fall into a
 * ring around it — which is what a group waiting to cross looks like — and
 * when it sits, they sit next to it.
 *
 * The lateral part of a slot is bounded by `clearanceAt`, which reports how
 * far you can move from a point in *any* direction and still be somewhere a
 * body may stand. Between two shopfronts on a 3.5 m lane a family closes up
 * to single file on its own, without anything having to know a lane is
 * narrow. It is the same function that answers "is there room here for two
 * people and a dog", and it is asked once per group per frame rather than
 * once per member, because it is the leader's ground that everyone is on.
 *
 * A child is not a small adult. It is 0.60 of the height with a head a third
 * again as big for it, it dawdles — an occasional 0.6–1.6 s of standing and
 * staring at something, then a run to catch up at 1.7× — and it is the one
 * thing here allowed to be brightly coloured. The lag and the catching up is
 * the read; the height alone just makes a short adult.
 *
 * ## The three things that are not people
 *
 * Dogs, robots and prams are one extra draw call between them (`KIT`), one
 * geometry with every part of all three in it and a per-instance kind that
 * collapses the parts it is not to a point. A dog follows its owner's trail
 * one sample back with a weave and a sniff; a lead is drawn as a single sagging
 * quad from its collar to the owner's hand, positioned in the vertex shader
 * from a world-space offset, because a lead that does not join the two of them
 * is worse than no lead.
 *
 * The robots are civic and they are cheerful: a sweeper working the kerb, a
 * courier rolling with a parcel, a companion bobbing along after a family.
 * None of them serves anybody and none of them watches anybody. They ride the
 * nav graph with a random walk that prefers to carry straight on, which needs
 * no A* and cannot leave the pavement, because every edge of that graph was
 * checked at build.
 *
 * ## Why the crowd is the performance story of this world
 *
 * Everything else here is drawn once and shaded; the crowd is eight hundred
 * things that all move, all animate, and all need deciding about. The rule
 * that keeps it affordable is that **the CPU moves people and the GPU poses
 * them**. Per frame, per person, the CPU writes a position, a facing, a walk
 * phase, three pose weights and the body's colours — twenty-two floats into
 * a typed array that never moves. It never touches a limb.
 * The whole walk cycle, the sit, the lean on the rail and the head tilting up
 * at a jetpack are solved in the vertex shader from that phase and those
 * weights, so a hurrying courier and a man on a bench cost the same.
 *
 * It comes out at 0.81 ms of CPU for sixteen hundred bodies and 26,000
 * triangles across the three tiers with the camera standing in a Bazaar
 * street — against a four-hundred-thousand-triangle ceiling for the whole
 * world. The low tier is 0.38 ms and 11,000. Roughly a third of the CPU is
 * the separation pass. The cost is linear in bodies, so the number to watch
 * when changing anything here is the microseconds per body (0.62) and not
 * the triangle count, which is bounded by the LOD rings rather than by the
 * population.
 *
 * Three consequences worth knowing before changing anything here:
 *
 * - **Nothing allocates in `update`.** Every array, every scratch vector and
 *   the entire A* workspace is built once. A crowd is exactly the size of
 *   system where a per-frame object literal becomes a visible collection
 *   pause.
 * - **Pathfinding is amortised.** `REPATH_BUDGET` searches run per frame and
 *   everybody else waits their turn — standing still, which is what a person
 *   deciding where to go looks like anyway.
 * - **LOD is by distance and it is hard.** Full articulation to 45 m, a
 *   six-box body to 130 m, a three-band billboard to 260 m, nothing beyond.
 *
 * ## The graph is the plan's, filtered — and, in one place, extended
 *
 * `cityPlan().nav` is trustworthy about its nodes: all 1403 of them stand on
 * pavement, plaza or road, and none needs moving. (That was not always true —
 * the rim ring used to be offset by the *ring* road's half-width when the rim
 * road is narrower, which put 244 nodes a few centimetres into the flowerbeds,
 * and this file used to nudge them back. The plan fixes it at source now, so
 * the nudge is gone.)
 *
 * It is not *complete*, though, and the hole in it was the whole reason the
 * Halo was empty. See `haloNodes`: the plan gives the central plaza one ring
 * of nodes round its kerb and nothing across it, so nobody could walk through
 * the middle of the city and the Beacon — 500 m of lit glass at the exact
 * centre — had **zero** standing spots, measured, of the ten it asks for.
 * This file paves it, because that is a walking correction and traffic and
 * couriers may reasonably want the raw graph.
 *
 * Its *edges* still need one check. Crossings are stitched by proximity, and
 * 18 of the 5226 of them cut the corner of a block — mostly the long diagonal
 * where an avenue meets a ring, at r≈129→105 and r≈209→188 and their mirrors.
 * Each is sampled along its length and dropped if anything on it is a lot, the
 * parapet or the void, and what survives is reduced to its largest connected
 * component: 1403 nodes, 5208 edges, still one piece, every one of the 138
 * shop doors reachable.
 *
 * The check stays even though it is nearly a no-op, because it is what turns
 * "the plan changed and now people walk through a wall" into a graph that is
 * merely slightly worse connected. It is done here rather than in the plan
 * because it is a *walking* correction: traffic and couriers may want the
 * raw graph.
 */
import * as THREE from "three";
import { makeRng } from "@/shared/proc/rng";
import {
  cityPlan,
  clearanceAt,
  districtAt,
  surfaceAt,
  HALO_R,
  LANDMARKS,
  RIM_R,
  RING_R,
  type DistrictId,
} from "./cityplan";
import { ISLAND_Y, PLATEAU_R } from "./config";
/* The one exception to "a system may not import another system": `SUN_DIR` is
   a constant, not behaviour, and it is only the build-time default — every
   frame overwrites it from `ctx.sunDir`, which is the live one. */
import { SUN_DIR } from "./sky";
import type { BuildContext, FrameContext, System } from "./types";

/**
 * A live tally of what the street is made of.
 *
 * One object, built once and mutated in place — a fresh literal every frame
 * is exactly the allocation this system is not allowed to make. Read it, do
 * not keep it.
 */
export interface Census {
  /** People on the deck right now. */
  people: number;
  children: number;
  /** Whole groups out: a couple, a parent and a child, somebody with a dog. */
  groups: number;
  families: number;
  couples: number;
  /** People not going anywhere: sitting, on the rail, stopped and talking. */
  sitting: number;
  leaning: number;
  standing: number;
  /** Of the sitters, how many are on an actual bench rather than a kerb. */
  benched: number;
  dogs: number;
  robots: number;
  prams: number;
}

/** One body, as seen from outside. See `snapshot`. */
export interface PersonView {
  id: number;
  x: number;
  y: number;
  z: number;
  /** Index of whoever decides for them; equal to `id` when that is themselves. */
  lead: number;
  /** Facing, radians, same convention as everywhere else here: yaw 0 is -Z. */
  yaw: number;
  /**
   * Which place on which bench they hold, or -1 for everybody else.
   *
   * Two places to a bench, so `seat >> 1` is the bench and `seat & 1` is
   * which end of it. Exposed because "is anybody actually on a bench, and is
   * anybody on the same end of one as somebody else" is the question the
   * rendered buffers cannot answer and the one worth asking.
   */
  seat: number;
  role: "alone" | "lead" | "adult" | "child" | "rider";
  group: "alone" | "couple" | "family" | "dog";
  state: "walk" | "stand" | "sit" | "lean" | "wait" | "pause";
  active: boolean;
}

/** Everything the simulation knows, in plain objects. See `snapshot`. */
export interface CrowdSnapshot {
  people: PersonView[];
  dogs: Array<{ x: number; y: number; z: number; owner: number }>;
  robots: Array<{ x: number; y: number; z: number; kind: "sweeper" | "courier" | "companion" }>;
  prams: Array<{ x: number; y: number; z: number; owner: number }>;
}

export interface CrowdHandle extends System {
  /** Live population, for the HUD and for debugging. */
  readonly count: number;
  /** What is out there, mutated in place each frame. */
  readonly census: Readonly<Census>;
  /** Nearest pedestrian to a point, for interactions later. */
  nearest(
    x: number,
    z: number,
    maxDist: number,
  ): { x: number; y: number; z: number; id: number } | null;
  /**
   * Everything, copied out into objects.
   *
   * **This allocates, on purpose, and is not for a frame.** It exists so a
   * test can ask questions the rendered instance buffers cannot answer — is
   * this family still together, is that dog on the pavement, is anybody
   * sitting in the road — and so somebody at a console can find out why one
   * pedestrian is behaving oddly without adding a print to the loop.
   */
  snapshot(): CrowdSnapshot;
}

/**
 * One bench, as this system needs it.
 *
 * `props.ts` owns the benches and this system may not import it, so the
 * engine carries the list across — the same one-fact-between-two-systems
 * arrangement that tells `buildings.ts` which lots the interiors have taken.
 *
 * `yaw` is the bench's own facing, straight off the pavement spot it was
 * placed on: the seat looks along -Z rotated by it, which is the same
 * convention a body's yaw uses, so somebody sitting on a bench faces the way
 * the bench faces and needs no correction. A placement without one is skipped
 * rather than guessed at — a body sitting on a bench at ninety degrees to it
 * is worse than a body sitting on the kerb beside it.
 */
export interface CrowdSeat {
  x: number;
  z: number;
  /** Deck height the bench stands on, not the height of its seat. */
  y: number;
  yaw?: number;
}

export interface CrowdOptions {
  /**
   * Every bench in the city.
   *
   * Optional, and the whole system works without it: with no seats nobody is
   * ever sent to a bench and everybody who sits does the kerb sit this file
   * has always done. Supplying them adds a second kind of sitting on top,
   * and the kerb sit stays as the fallback for the far more numerous places
   * to sit that are not furniture.
   */
  seats?: readonly CrowdSeat[];
}

/* -------------------------------------------------------------------------
 * Tuning
 * ---------------------------------------------------------------------- */

/**
 * Population before daylight scaling. Low tier is the same 60% cut it was.
 *
 * See the note at the top of the file on why this is 1600 and not 820, and
 * why it is not the largest number that fits: the ceiling here is a mood, not
 * a budget.
 */
const POP = { high: 1600, low: 640 } as const;

/** LOD ring radii, metres. Past the last one a person is not drawn at all. */
const LOD_NEAR = 45;
const LOD_MID = 130;
const LOD_FAR = 260;

/**
 * How many of the things that are not people.
 *
 * Scaled with the tier like everything else here, and thinned again with the
 * light in `update`: a street sweeper works after dark, a toddler does not.
 */
const KIT = {
  high: { dogs: 30, sweepers: 5, couriers: 11, companions: 12 },
  low: { dogs: 11, sweepers: 2, couriers: 4, companions: 4 },
} as const;

/** How far a dog, a robot or a pram is worth drawing. They are small. */
const LOD_KIT = 155;

/** A* searches per frame. Everyone else stands still and waits. */
const REPATH_BUDGET = 4;

/** Longest path a body will hold. Longer trips are walked in stages. */
const MAX_PATH = 48;

/** Avoidance grid. 6 m cells over the whole deck. */
const CELL = 6;
const GRID_N = Math.ceil((PLATEAU_R * 2 + 20) / CELL);
const GRID_ORIGIN = -PLATEAU_R - 10;

const TAU = Math.PI * 2;

/** What a body is doing. */
const ST_WALK = 0;
const ST_STAND = 1;
const ST_SIT = 2;
const ST_LEAN = 3;
const ST_WAIT = 4;
/** Stopped mid-walk to look at something. Keeps its path. */
const ST_PAUSE = 5;

/**
 * What somebody is to their group.
 *
 * `aLead[i] === i` for anybody who decides for themselves, which is both a
 * solo pedestrian and the leader of a group; the roles below are what tells
 * the two apart and what a follower is *for*.
 */
const R_ALONE = 0;
const R_LEAD = 1;
/** Another adult: walks abreast, turns to face the leader when they stop. */
const R_ADULT = 2;
/** A child: smaller, two samples back, and inclined to dawdle. */
const R_CHILD = 3;
/** A child on the leader's shoulders. Goes where they go, never walks. */
const R_RIDER = 4;

/** What kind of group this is, for the hour and for the census. */
const G_ALONE = 0;
const G_COUPLE = 1;
const G_FAMILY = 2;
const G_DOG = 3;

/**
 * What the hands are doing. A contract with the vertex shader.
 *
 * 0 nothing, 1 both on a pram handle, 2 an adult holding a child's hand on
 * their left, 3 both arms up round a child on the shoulders, 4 a child
 * reaching up for the hand in 2, 5 a lead in the right hand.
 */
const H_NONE = 0;
const H_PRAM = 1;
const H_HAND = 2;
const H_CARRY = 3;
const H_REACH = 4;
const H_LEAD = 5;

/** Which kind of thing an instance of the kit mesh is. */
const K_DOG = 0;
const K_SWEEPER = 1;
const K_COURIER = 2;
const K_COMPANION = 3;
const K_PRAM = 4;

/**
 * The leader's trail: where they have actually been, every 32 cm of ground.
 *
 * Sampled by distance rather than by time on purpose — a slot is then a fixed
 * distance back however fast the leader is going, so a child sits 64 cm behind
 * its parent at a stroll and at a hurry, and the trail simply stops growing
 * when the leader stops instead of collapsing to a point.
 */
const TRAIL_N = 14;
const TRAIL_STEP = 0.32;

/** What it is walking toward. Decides what it does when it gets there. */
const D_DOOR = 0;
const D_LANDMARK = 1;
const D_RIM = 2;
const D_SIT = 3;
const D_TRAM = 4;
const D_PLAZA = 5;
/** A named place on a named bench. Only ever exists when seats were supplied. */
const D_BENCH = 6;

/**
 * The two places on a bench, and how high the seat is.
 *
 * A bench here is 1.7 m of slat between two iron ends, so two people fit and
 * a third does not. 0.42 m either side of the middle puts them close enough
 * to be together and far enough not to be one silhouette; the separation pass
 * ignores them once they are seated, so this offset is the *only* thing
 * holding two bodies off each other on a bench and it is exact rather than
 * negotiated. Nobody ever gets a place somebody else is already in: a slot is
 * claimed when the destination is chosen and held until they get up.
 *
 * 0.47 m is the top of the slats in `props.ts` — 0.44 for the lowest, plus
 * half its thickness and the two 5 mm risers above it.
 */
const SEAT_OFF = 0.42;
const SEAT_H = 0.47;

const DISTRICT_IDS: DistrictId[] = ["halo", "core", "market", "gardens", "rim"];

/**
 * How strongly the clock is at a given hour, 0..1, wrapping at midnight.
 *
 * `dayPhase` is 0 at midnight and 0.75 at the sunset this world is painted
 * at, so the afternoon is a wide bump around 0.62 and dusk is a narrow one
 * just after 0.79. Used to decide who is out — more families in the
 * afternoon, more couples at dusk — and for nothing to do with light.
 */
function dayBump(phase: number, centre: number, width: number): number {
  let d = phase - centre;
  d -= Math.round(d);
  const t = d / width;
  return Math.max(0, 1 - t * t);
}

/**
 * How busy each district is, and how that moves with the light.
 *
 * The Bazaar is crowded and gets more so as the sun goes; the Rim is sparse
 * and empties after dark, because the whole point of standing at the edge is
 * the view. `base` is the weight at noon, `dusk` is added as daylight fails.
 */
const DISTRICT_PULL: Record<DistrictId, { base: number; dusk: number }> = {
  halo: { base: 1.5, dusk: 0.5 },
  core: { base: 1.7, dusk: -0.2 },
  market: { base: 3.0, dusk: 1.4 },
  gardens: { base: 1.5, dusk: -0.5 },
  rim: { base: 1.0, dusk: -0.55 },
};

/* -------------------------------------------------------------------------
 * The walk graph
 * ---------------------------------------------------------------------- */

interface WalkGraph {
  n: number;
  x: Float32Array;
  z: Float32Array;
  y: Float32Array;
  width: Float32Array;
  district: Uint8Array;
  /** CSR adjacency: neighbours of i are list[start[i] … start[i + 1]). */
  start: Int32Array;
  list: Int32Array;
}

/**
 * The Halo, which the plan does not pave.
 *
 * The great circular plaza at the middle of the city — 112 m across, with the
 * Beacon standing in it and the Cistern off to one side — had **no nav nodes
 * inside it at all**. `buildNav` gives it exactly one ring, at `HALO_R + 6`,
 * which is the kerb *round* the plaza rather than anything across it, so the
 * only route from one avenue to the opposite one was the long way round the
 * edge. Every pedestrian in the city took it, because it was the only one.
 *
 * That is why nothing was ever in the Halo, and it was not a weighting
 * problem: it also meant the *Beacon had no standing spots*. Landmarks get
 * theirs by looking for a node within 14 m of a circle at `clear + 12` — 38 m
 * for the Beacon — and the nearest node to any point on that circle was 24 m
 * away on the kerb ring. Of the ten spots it asks for it got zero, measured,
 * so the single most visible object in the world was a place nobody had any
 * reason to walk to. The Cistern got five, all of them 25 m away on the same
 * kerb.
 *
 * So the plaza gets paved, here rather than in the plan, for the same reason
 * the corner-cutting crossings are dropped here: it is a *walking* correction
 * and traffic and couriers may reasonably want the raw graph. Two rings and a
 * circle round the fountain, checked exactly the way the plan's own nodes are
 * — `surfaceAt` has to call every node plaza, every metre of every edge has
 * to be plaza too, and everything stays outside the clearance each landmark
 * declares for itself. Nothing here knows a radius the plan does not.
 */
const PLAZA_RINGS = [
  /* Just outside the Beacon's own 26 m of clearance, and on the circle its
     standing spots are looked for on. */
  { r: 37, n: 17 },
  /* Half way out to the kerb ring at 62, close enough to stitch to it. */
  { r: 51, n: 23 },
] as const;

/** How far apart two plaza nodes may be and still be walkable between. */
const PLAZA_STITCH = 17;

/** Landmarks standing in the Halo, which the plaza has to be laid around. */
const HALO_LANDMARKS = LANDMARKS.filter((lm) => Math.hypot(lm.x, lm.z) < HALO_R + 6);

/**
 * How much room to leave round something standing in the plaza, on top of the
 * clearance it declares for itself.
 *
 * Six metres, and it is not padding. A pedestrian is never *on* a nav node:
 * it walks a lateral offset across the width of the pavement it is on and it
 * is shoved by everybody it passes, so a plaza node six metres clear of the
 * Cistern is a body two metres clear of it in a crowd. Two metres of margin
 * put people in the fountain, measured.
 */
const HALO_MARGIN = 6;

function clearOfHaloLandmarks(x: number, z: number): boolean {
  for (const lm of HALO_LANDMARKS) {
    if (Math.hypot(x - lm.x, z - lm.z) < lm.clear + HALO_MARGIN) return false;
  }
  return true;
}

function haloNodes(): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  const push = (x: number, z: number) => {
    if (surfaceAt(x, z).kind !== "plaza") return;
    if (!clearOfHaloLandmarks(x, z)) return;
    out.push({ x, z });
  };
  for (const ring of PLAZA_RINGS) {
    for (let i = 0; i < ring.n; i++) {
      const a = (i / ring.n) * TAU;
      push(Math.cos(a) * ring.r, Math.sin(a) * ring.r);
    }
  }
  /* And a circle round the fountain, just outside everything it reserves.
     A fountain nobody can stand at is a sculpture. */
  for (const lm of HALO_LANDMARKS) {
    if (lm.kind !== "fountain") continue;
    const rr = lm.clear + HALO_MARGIN + 2;
    const n = Math.max(6, Math.round((TAU * rr) / 13));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + 0.2;
      push(lm.x + Math.cos(a) * rr, lm.z + Math.sin(a) * rr);
    }
  }
  return out;
}

/** True when every metre between two points is open plaza. */
function plazaBetween(ax: number, az: number, bx: number, bz: number): boolean {
  const d = Math.hypot(bx - ax, bz - az);
  const steps = Math.max(2, Math.ceil(d));
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const x = ax + (bx - ax) * t;
    const z = az + (bz - az) * t;
    const kind = surfaceAt(x, z).kind;
    if (kind !== "plaza" && kind !== "walk" && kind !== "road") return false;
    if (!clearOfHaloLandmarks(x, z)) return false;
  }
  return true;
}

function buildWalkGraph(): WalkGraph {
  const nav = cityPlan().nav;
  const extra = haloNodes();
  const raw = nav.length + extra.length;
  const px = new Float64Array(raw);
  const pz = new Float64Array(raw);
  const pw = new Float32Array(raw);
  const ok = new Uint8Array(raw);
  /* The plan's adjacency, copied rather than referenced: the plaza stitches
     new edges onto the plan's own nodes, and `cityPlan()` is shared with
     every other system in the world. */
  const adj: number[][] = new Array(raw);

  // Every node the plan offers, as long as it is somewhere a body can stand.
  // Currently that is all of them; the check costs one `surfaceAt` each and
  // is the difference between a plan regression and a crowd in the walls.
  for (let i = 0; i < nav.length; i++) {
    const node = nav[i];
    px[i] = node.x;
    pz[i] = node.z;
    pw[i] = node.width;
    adj[i] = node.links.slice();
    const kind = surfaceAt(node.x, node.z).kind;
    if (kind === "walk" || kind === "plaza" || kind === "road") ok[i] = 1;
  }
  for (let e = 0; e < extra.length; e++) {
    const i = nav.length + e;
    px[i] = extra[e].x;
    pz[i] = extra[e].z;
    /* Seven, not the twelve the plan gives its own kerb ring.
     *
     * `width` is how far across its walkway a body may drift, and on a
     * hundred-metre plaza the honest answer is "as far as it likes" — but the
     * one thing in the middle of this one is a fountain, and twelve puts a
     * body nearly five metres off the line it is walking. Seven spreads the
     * crowd across the plaza and still lands inside the margin the nodes were
     * laid out with. */
    pw[i] = 7;
    adj[i] = [];
    ok[i] = 1;
  }
  /* Stitch the plaza to itself and to the kerb ring the plan already has.
     Proximity, then the same exactness the plan's crossings get: an edge only
     survives if every metre of it is open plaza. */
  for (let e = 0; e < extra.length; e++) {
    const i = nav.length + e;
    for (let j = 0; j < raw; j++) {
      if (j === i || !ok[j]) continue;
      if (Math.hypot(px[j] - px[i], pz[j] - pz[i]) > PLAZA_STITCH) continue;
      if (!plazaBetween(px[i], pz[i], px[j], pz[j])) continue;
      if (!adj[i].includes(j)) adj[i].push(j);
      if (!adj[j].includes(i)) adj[j].push(i);
    }
  }

  // An edge survives if nothing along it is a building plot, the parapet or
  // the void. Sampled rather than reasoned about: the graph stitches crossings
  // by proximity, and a few of them cut a corner through a block.
  const passable = (a: number, b: number): boolean => {
    const ax = px[a];
    const az = pz[a];
    const dx = px[b] - ax;
    const dz = pz[b] - az;
    for (let s = 1; s < 8; s++) {
      const t = s / 8;
      const kind = surfaceAt(ax + dx * t, az + dz * t).kind;
      if (kind === "lot" || kind === "void" || kind === "parapet") return false;
    }
    return true;
  };

  const deg = new Int32Array(raw);
  const edgeA: number[] = [];
  const edgeB: number[] = [];
  for (let i = 0; i < raw; i++) {
    if (!ok[i]) continue;
    for (const j of adj[i]) {
      if (j <= i || !ok[j]) continue;
      if (!passable(i, j)) continue;
      edgeA.push(i);
      edgeB.push(j);
      deg[i]++;
      deg[j]++;
    }
  }

  // Largest connected component, so no body is ever handed a destination it
  // cannot reach and no A* ever runs to exhaustion.
  const head = new Int32Array(raw).fill(-1);
  const next = new Int32Array(edgeA.length * 2).fill(-1);
  const to = new Int32Array(edgeA.length * 2);
  let slot = 0;
  const push = (from: number, dest: number) => {
    to[slot] = dest;
    next[slot] = head[from];
    head[from] = slot;
    slot++;
  };
  for (let e = 0; e < edgeA.length; e++) {
    push(edgeA[e], edgeB[e]);
    push(edgeB[e], edgeA[e]);
  }

  const comp = new Int32Array(raw).fill(-1);
  const stack = new Int32Array(raw);
  let bestComp = -1;
  let bestSize = 0;
  let compId = 0;
  for (let seed = 0; seed < raw; seed++) {
    if (!ok[seed] || comp[seed] >= 0) continue;
    let top = 0;
    stack[top++] = seed;
    comp[seed] = compId;
    let size = 1;
    while (top > 0) {
      const cur = stack[--top];
      for (let e = head[cur]; e >= 0; e = next[e]) {
        const nb = to[e];
        if (comp[nb] >= 0) continue;
        comp[nb] = compId;
        size++;
        stack[top++] = nb;
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestComp = compId;
    }
    compId++;
  }

  // Compact the survivors into dense arrays. Everything downstream indexes
  // this graph and never has to ask whether a node is real.
  const remap = new Int32Array(raw).fill(-1);
  let n = 0;
  for (let i = 0; i < raw; i++) if (ok[i] && comp[i] === bestComp) remap[i] = n++;

  const gx = new Float32Array(n);
  const gz = new Float32Array(n);
  const gy = new Float32Array(n);
  const gw = new Float32Array(n);
  const gd = new Uint8Array(n);
  const gstart = new Int32Array(n + 1);
  for (let i = 0; i < raw; i++) {
    const id = remap[i];
    if (id < 0) continue;
    gx[id] = px[i];
    gz[id] = pz[i];
    gy[id] = surfaceAt(px[i], pz[i]).y;
    gw[id] = pw[i];
    gd[id] = DISTRICT_IDS.indexOf(districtAt(Math.hypot(px[i], pz[i])).id);
    gstart[id + 1] = deg[i];
  }
  for (let i = 0; i < n; i++) gstart[i + 1] += gstart[i];
  const glist = new Int32Array(gstart[n]);
  const cursor = gstart.slice(0, n);
  for (let e = 0; e < edgeA.length; e++) {
    const a = remap[edgeA[e]];
    const b = remap[edgeB[e]];
    if (a < 0 || b < 0) continue;
    glist[cursor[a]++] = b;
    glist[cursor[b]++] = a;
  }
  // `deg` counted edges before the component filter, so a node on the fringe
  // can have spare slots. Point them at the node itself; A* skips self-links.
  for (let i = 0; i < n; i++) {
    for (let k = cursor[i]; k < gstart[i + 1]; k++) glist[k] = i;
  }

  return { n, x: gx, z: gz, y: gy, width: gw, district: gd, start: gstart, list: glist };
}

/* -------------------------------------------------------------------------
 * Destinations
 * ---------------------------------------------------------------------- */

interface DestPool {
  node: Int32Array;
  kind: Uint8Array;
  /** Which way a body faces once it gets there. */
  faceX: Float32Array;
  faceZ: Float32Array;
  /** Which bench this is, for a `D_BENCH`; -1 for everything else. */
  bench: Int32Array;
  n: number;
}

/**
 * The tram's platform angles.
 *
 * Duplicated from `traffic.ts` on purpose: a system may not import another
 * system, and this is four numbers that both of them derive from the same
 * ring road. If the tram route changes, change it in both — a queue at a
 * platform no tram stops at is a bug you will see and not a crash.
 */
const TRAM_STOP_A = [Math.PI, Math.PI * 0.75, Math.PI * 0.25, -Math.PI / 2];

export function buildCrowd(ctx: BuildContext, options?: CrowdOptions): CrowdHandle {
  const rng = makeRng(`empyrean-crowd:${ctx.seedSalt}`);
  const graph = buildWalkGraph();
  const plan = cityPlan();
  const group = new THREE.Group();
  group.name = "empyrean-crowd";

  /* ---- a coarse index over the graph, for "which node is nearest" -------
   * Only used at build time, but it turns a few hundred thousand distance
   * tests into a few thousand. */
  const nodeCell = new Int32Array(GRID_N * GRID_N).fill(-1);
  const nodeNext = new Int32Array(graph.n).fill(-1);
  const cellOf = (x: number, z: number): number => {
    const cx = Math.min(GRID_N - 1, Math.max(0, Math.floor((x - GRID_ORIGIN) / CELL)));
    const cz = Math.min(GRID_N - 1, Math.max(0, Math.floor((z - GRID_ORIGIN) / CELL)));
    return cz * GRID_N + cx;
  };
  for (let i = 0; i < graph.n; i++) {
    const c = cellOf(graph.x[i], graph.z[i]);
    nodeNext[i] = nodeCell[c];
    nodeCell[c] = i;
  }
  const nearestNode = (x: number, z: number, maxDist: number): number => {
    const rings = Math.ceil(maxDist / CELL);
    const cx = Math.floor((x - GRID_ORIGIN) / CELL);
    const cz = Math.floor((z - GRID_ORIGIN) / CELL);
    let best = -1;
    let bestD = maxDist * maxDist;
    for (let dz = -rings; dz <= rings; dz++) {
      const rz = cz + dz;
      if (rz < 0 || rz >= GRID_N) continue;
      for (let dx = -rings; dx <= rings; dx++) {
        const rx = cx + dx;
        if (rx < 0 || rx >= GRID_N) continue;
        for (let i = nodeCell[rz * GRID_N + rx]; i >= 0; i = nodeNext[i]) {
          const q = (graph.x[i] - x) ** 2 + (graph.z[i] - z) ** 2;
          if (q < bestD) {
            bestD = q;
            best = i;
          }
        }
      }
    }
    return best;
  };

  /* ---- the pool of places worth going ---------------------------------- */
  const dNode: number[] = [];
  const dKind: number[] = [];
  const dFx: number[] = [];
  const dFz: number[] = [];
  const dBench: number[] = [];

  const addDest = (node: number, kind: number, fx: number, fz: number, bench = -1) => {
    if (node < 0) return;
    /* Never somewhere to *stand* in the carriageway.
     *
     * The nav graph is allowed road nodes — a crossing is a road node and a
     * pedestrian has to be able to use one — but a destination is a place a
     * body stops for forty seconds to a couple of minutes, and where the
     * pavement crosses an avenue the closed-form surface says "road", because
     * it is one. Nearly a third of everybody sitting was sitting in a junction
     * before this line, which reads exactly as badly as it sounds and is
     * invisible in every test that only asks whether they are on the island. */
    if (surfaceAt(graph.x[node], graph.z[node]).kind === "road") return;
    const len = Math.hypot(fx, fz) || 1;
    dNode.push(node);
    dKind.push(kind);
    dFx.push(fx / len);
    dFz.push(fz / len);
    dBench.push(bench);
  };

  // Shop doors. The doorstep, not the wall — see the note in cityplan.ts.
  for (const door of plan.doors) {
    addDest(nearestNode(door.x, door.z, 9), D_DOOR, -door.nx, -door.nz);
  }
  // Landmarks: a handful of standing spots each, all facing the thing.
  for (const lm of LANDMARKS) {
    const want = lm.kind === "beacon" ? 10 : 5;
    let found = 0;
    for (let step = 0; step < 24 && found < want; step++) {
      const a = (step / 24) * TAU;
      const r = lm.clear + 12;
      const node = nearestNode(lm.x + Math.cos(a) * r, lm.z + Math.sin(a) * r, 14);
      if (node < 0) continue;
      addDest(node, D_LANDMARK, lm.x - graph.x[node], lm.z - graph.z[node]);
      found++;
    }
  }
  // The rim rail. Facing out, because that is the entire reason to be there.
  for (let i = 0; i < graph.n; i++) {
    const r = Math.hypot(graph.x[i], graph.z[i]);
    if (r < RIM_R - 4) continue;
    addDest(i, D_RIM, graph.x[i], graph.z[i]);
  }
  /* Somewhere to sit: the wide pavements of the Bazaar and the Terraces.
   *
   * `props.ts` puts its benches along pavement at a fixed spacing, and a
   * system may not import another system, so there is no way to ask where
   * they actually are — only to sit where they plausibly are and, more
   * importantly, to sit in a way that does not need one. See the sit pose in
   * the vertex shader: bodies sit on the kerb, at kerb height, which is
   * correct on a bench, a step, a plinth or a bare pavement edge. A person
   * floating at bench height over nothing is far worse than one more person
   * standing, and this is how that is avoided rather than guessed at.
   *
   * The width filter is doing the real work: 3.5 m lane pavement has no room
   * for somebody sitting on it, and 4.5 m ring pavement does. */
  for (let i = 0; i < graph.n; i++) {
    const r = Math.hypot(graph.x[i], graph.z[i]);
    if (graph.width[i] < 4.4) continue;
    if (r < RING_R[0] || r > RING_R[2]) continue;
    if (!rng.chance(0.2)) continue;
    const a = rng.range(0, TAU);
    addDest(i, D_SIT, Math.cos(a), Math.sin(a));
  }
  // The tram platforms, on the inner pavement of the middle ring.
  for (const a of TRAM_STOP_A) {
    const pr = RING_R[1] - 9.5;
    const node = nearestNode(Math.cos(a) * pr, Math.sin(a) * pr, 16);
    addDest(node, D_TRAM, Math.cos(a) * RING_R[1] - graph.x[node], Math.sin(a) * RING_R[1] - graph.z[node]);
  }
  // The Halo itself, which is where you go to be somewhere.
  for (let i = 0; i < graph.n; i++) {
    if (Math.hypot(graph.x[i], graph.z[i]) > HALO_R + 14) continue;
    addDest(i, D_PLAZA, -graph.x[i], -graph.z[i]);
  }

  /* ---- the benches, if anybody handed us any --------------------------- *
   *
   * Two places on each, laid out along its own long axis, and a destination
   * that stands for the bench rather than for either place: which of the two
   * a body gets is decided when it sets off, so a couple can take both and
   * two strangers cannot take the same one.
   *
   * `y` is the deck under the bench, not the seat — the body's origin stays
   * on the ground the way it does everywhere else here and the *pose* lifts
   * the hips. That is what keeps a seated body's shins reaching the deck
   * instead of a whole body floating 47 cm up with its feet in the air.
   */
  const seatsIn = options?.seats ?? [];
  const benchN = seatsIn.length;
  const seatX = new Float32Array(benchN * 2);
  const seatZ = new Float32Array(benchN * 2);
  const seatY = new Float32Array(benchN * 2);
  const seatFx = new Float32Array(benchN * 2);
  const seatFz = new Float32Array(benchN * 2);
  /** Who is in this place, or -1. The only thing stopping two bodies sharing one. */
  const seatOwner = new Int32Array(benchN * 2).fill(-1);
  for (let b = 0; b < benchN; b++) {
    const bench = seatsIn[b];
    const yaw = bench.yaw;
    // No facing, no seat. See the note on CrowdSeat.
    if (yaw === undefined || !Number.isFinite(yaw)) continue;
    // A body's forward at this yaw, which is also the bench's: both are -Z.
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    // …and the bench's long axis, which is its local +X.
    const lx = Math.cos(yaw);
    const lz = -Math.sin(yaw);
    for (let k = 0; k < 2; k++) {
      const u = k === 0 ? -SEAT_OFF : SEAT_OFF;
      const s = b * 2 + k;
      seatX[s] = bench.x + lx * u;
      seatZ[s] = bench.z + lz * u;
      seatY[s] = bench.y;
      seatFx[s] = fx;
      seatFz[s] = fz;
    }
    /* One destination for the bench, at the nearest node on the graph. A
       bench further than that from any pavement node is one nobody could
       have been walking past anyway. */
    addDest(nearestNode(bench.x, bench.z, 12), D_BENCH, fx, fz, b);
  }

  const dests: DestPool = {
    node: Int32Array.from(dNode),
    kind: Uint8Array.from(dKind),
    faceX: Float32Array.from(dFx),
    faceZ: Float32Array.from(dFz),
    bench: Int32Array.from(dBench),
    n: dNode.length,
  };

  /* ---- A* workspace, allocated once ------------------------------------ */
  const gScore = new Float32Array(graph.n);
  const fScore = new Float32Array(graph.n);
  const cameFrom = new Int32Array(graph.n);
  const stamp = new Int32Array(graph.n).fill(-1);
  const closed = new Uint8Array(graph.n);
  // One slot per directed edge plus one per node: A* here has no decrease-key,
  // so a node is pushed once per better route found and the heap can hold far
  // more entries than there are nodes. Sizing it to the node count overflows
  // in silence — typed arrays drop out-of-range writes — and the search then
  // walks a heap full of zeroes.
  const HEAP_CAP = graph.list.length + graph.n + 16;
  const heapId = new Int32Array(HEAP_CAP);
  const heapKey = new Float32Array(HEAP_CAP);
  const trace = new Int32Array(graph.n);
  let generation = 0;

  const heapPush = (size: number, id: number, key: number): number => {
    if (size >= HEAP_CAP) return size;
    let i = size;
    heapId[i] = id;
    heapKey[i] = key;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heapKey[parent] <= heapKey[i]) break;
      const ti = heapId[i];
      const tk = heapKey[i];
      heapId[i] = heapId[parent];
      heapKey[i] = heapKey[parent];
      heapId[parent] = ti;
      heapKey[parent] = tk;
      i = parent;
    }
    return size + 1;
  };

  const heapPop = (size: number): number => {
    const last = size - 1;
    heapId[0] = heapId[last];
    heapKey[0] = heapKey[last];
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let small = i;
      if (l < last && heapKey[l] < heapKey[small]) small = l;
      if (r < last && heapKey[r] < heapKey[small]) small = r;
      if (small === i) break;
      const ti = heapId[i];
      const tk = heapKey[i];
      heapId[i] = heapId[small];
      heapKey[i] = heapKey[small];
      heapId[small] = ti;
      heapKey[small] = tk;
      i = small;
    }
    return last;
  };

  /* ---- bodies ---------------------------------------------------------- */
  const MAX = ctx.quality === "low" ? POP.low : POP.high;

  const ax = new Float32Array(MAX);
  const ay = new Float32Array(MAX);
  const az = new Float32Array(MAX);
  const avx = new Float32Array(MAX);
  const avz = new Float32Array(MAX);
  const ayaw = new Float32Array(MAX);
  const aspeed = new Float32Array(MAX);
  const aphase = new Float32Array(MAX);
  const agait = new Float32Array(MAX);
  const agesture = new Float32Array(MAX);
  const aSit = new Float32Array(MAX);
  const aLean = new Float32Array(MAX);
  const aLook = new Float32Array(MAX);
  const aLookT = new Float32Array(MAX);
  const aState = new Uint8Array(MAX);
  const aTimer = new Float32Array(MAX);
  const aHeight = new Float32Array(MAX);
  const aBuild = new Float32Array(MAX);
  const aAcc = new Float32Array(MAX);
  const aTopC = new Float32Array(MAX * 3);
  const aBotC = new Float32Array(MAX * 3);
  const aSkinC = new Float32Array(MAX * 3);
  /* Who decides for this body. `aLead[i] === i` means "I do" — which covers
     somebody walking on their own and the leader of a group alike. */
  const aLead = new Int32Array(MAX);
  const aRole = new Uint8Array(MAX);
  const aGroup = new Uint8Array(MAX);
  /** Which side of the leader, how far out, and where in the ring when stopped. */
  const aSlotSide = new Float32Array(MAX);
  const aSlotOff = new Float32Array(MAX);
  const aSlotAng = new Float32Array(MAX);
  /** How many trail samples back this follower walks. */
  const aLagI = new Uint8Array(MAX);
  /** Child-ness: proportions in the shader, dawdling in the loop. */
  const aKid = new Float32Array(MAX);
  /** What the hands are doing — one of the `H_` codes. */
  const aHold = new Float32Array(MAX);
  /** Riding on somebody's shoulders, blended. */
  const aRide = new Float32Array(MAX);
  /** Seconds until this child stops to look at something, then catches up. */
  const aDawdle = new Float32Array(MAX);
  const aChase = new Float32Array(MAX);
  /** Row in the trail buffer, or -1 for anybody nobody is following. */
  const aTrail = new Int32Array(MAX).fill(-1);
  const aDestNode = new Int32Array(MAX).fill(-1);
  const aDestKind = new Uint8Array(MAX);
  /** Which place on which bench this body holds, or -1. */
  const aSeat = new Int32Array(MAX).fill(-1);
  /**
   * How high the thing under this body's backside is, metres, 0 for the kerb.
   *
   * Latched rather than derived from `aSeat`, and that is not tidiness: the
   * seat is given up the instant a body decides to leave, and the *pose*
   * takes a third of a second to unfold out of it. Clear the height with the
   * booking and a body standing up off a bench drops 37 cm into the pavement
   * on the frame it decides to go.
   */
  const aSeatH = new Float32Array(MAX);
  /** Walking the last few metres off the graph and onto a bench. */
  const aFinal = new Uint8Array(MAX);
  const aFaceX = new Float32Array(MAX);
  const aFaceZ = new Float32Array(MAX);
  const aQueued = new Uint8Array(MAX);
  const aActive = new Uint8Array(MAX);
  const aHurry = new Float32Array(MAX);

  // Path storage. One fixed-size slice per body; long trips are re-planned
  // when the slice runs out, which is what `aDestNode` is still holding.
  const path = new Int32Array(MAX * MAX_PATH);
  const pathLen = new Int32Array(MAX);
  const pathIdx = new Int32Array(MAX);

  // The segment a body is on, resolved once when it steps onto it: the two
  // endpoints, the sideways offset that keeps it on the pavement, and the
  // heights at each end. Nothing in the per-frame loop calls `surfaceAt`.
  const segAx = new Float32Array(MAX);
  const segAz = new Float32Array(MAX);
  const segAy = new Float32Array(MAX);
  const segTx = new Float32Array(MAX);
  const segTz = new Float32Array(MAX);
  const segTy = new Float32Array(MAX);

  const repathQueue = new Int32Array(MAX);
  let repathHead = 0;
  let repathTail = 0;
  let repathCount = 0;

  const requestPath = (i: number) => {
    if (aQueued[i]) return;
    aQueued[i] = 1;
    repathQueue[repathTail] = i;
    repathTail = (repathTail + 1) % MAX;
    repathCount++;
  };

  /* ---- appearance ------------------------------------------------------ */
  const SKINS = [0x6b4634, 0x8a5c3e, 0xb07a52, 0xcf9b71, 0xe4bb92, 0xf0d0ad];
  const TOPS = [
    0x2f3f66, 0x8a3f4e, 0x2f6b58, 0x7a5a2e, 0x4a3b6b, 0xa8552f, 0x3d6f8a, 0xb08a4a,
    0x8f4f7a, 0x35505a, 0xc06a55, 0x5b7a3f,
  ];
  const BOTTOMS = [0x22242e, 0x3a3340, 0x4a4438, 0x2b3644, 0x5a4a3f, 0x1e2a2e, 0x6a5f52];
  /* Children are the one thing on this street allowed to be loud. Adults here
     wear a city's worth of muted wool; a scarlet coat forty centimetres tall
     beside one of them is the single cheapest way to make a pair of bodies
     read as a parent and a child rather than as two pedestrians. */
  const KID_TOPS = [
    0xe8564a, 0xf2a03c, 0x3fbf7f, 0x3f9fe0, 0xf06fa8, 0xffd24a, 0x9b6ede, 0x2fd0c4,
  ];
  const KID_BOTTOMS = [0x2f4a7a, 0x7a3a5e, 0x2e6b4a, 0x8a5a2e, 0x35405a, 0x5a3f6b];
  const tmpColor = new THREE.Color();

  const setColor = (arr: Float32Array, i: number, hex: number, jitter: number) => {
    tmpColor.setHex(hex);
    const k = 1 + rng.range(-jitter, jitter);
    arr[i * 3] = tmpColor.r * k;
    arr[i * 3 + 1] = tmpColor.g * k;
    arr[i * 3 + 2] = tmpColor.b * k;
  };

  /* ---- who is with whom ------------------------------------------------
   *
   * Groups are laid out contiguously with the leader first, and that is not
   * cosmetic: `update` walks the arrays in index order, so a follower always
   * reads a leader whose position for this frame is already final. Reverse
   * the two and every child in the city is a frame behind its parent — which
   * at a stroll is a centimetre and at a corner is most of a metre.
   */
  const kitT = KIT[ctx.quality];
  const dogOwner: number[] = [];
  const companionOwner: number[] = [];
  const pramOwner: number[] = [];
  let familyN = 0;
  let coupleN = 0;

  const startGroup = (lead: number, kind: number) => {
    aLead[lead] = lead;
    aGroup[lead] = kind;
    aRole[lead] = kind === G_ALONE ? R_ALONE : R_LEAD;
  };
  const addFollower = (
    lead: number,
    i: number,
    role: number,
    side: number,
    off: number,
    lag: number,
    ang: number,
  ) => {
    aLead[i] = lead;
    aRole[i] = role;
    aGroup[i] = aGroup[lead];
    aSlotSide[i] = side;
    aSlotOff[i] = off;
    aLagI[i] = lag;
    aSlotAng[i] = ang;
  };
  /* A child, and whether it is holding a hand.
   *
   * The hand is the leader's *left* — part 2 in the shader, the even side —
   * so a child that takes it has to be on that side of them and level with
   * them rather than trailing. Everything else about the pose follows from
   * those two facts, which is why the side is decided here and not there. */
  const makeChild = (lead: number, i: number, side: number, lag: number, ang: number, freeHands: boolean) => {
    addFollower(lead, i, R_CHILD, side, rng.range(0.46, 0.62), lag, ang);
    aKid[i] = 1;
    if (freeHands && side > 0 && aHold[lead] === H_NONE && rng.chance(0.55)) {
      aHold[lead] = H_HAND;
      aHold[i] = H_REACH;
      aSlotOff[i] = 0.52;
      aLagI[i] = 1;
    }
  };

  let cursor = 0;
  while (cursor < MAX) {
    const room = MAX - cursor;
    const roll = rng.next();
    const lead = cursor;
    if (room >= 3 && roll < 0.05) {
      /* Three: either both parents and one child, or one adult with two,
         which is the arrangement that actually reads at a distance — the
         second child walks on the other side and lags further. */
      startGroup(lead, G_FAMILY);
      familyN++;
      const pram = rng.chance(0.3);
      const ride = !pram && rng.chance(0.24);
      if (pram) {
        aHold[lead] = H_PRAM;
        pramOwner.push(lead);
      }
      if (rng.chance(0.42)) {
        addFollower(lead, lead + 1, R_ADULT, -1, rng.range(0.58, 0.74), 0, -1.05);
        makeChild(lead, lead + 2, 1, 2, 0.95, !pram && !ride);
      } else {
        makeChild(lead, lead + 1, 1, 2, 0.95, !pram && !ride);
        makeChild(lead, lead + 2, -1, 3, -0.95, false);
      }
      if (ride) {
        const kid = lead + 2;
        aRole[kid] = R_RIDER;
        aRide[kid] = 1;
        aHold[lead] = H_CARRY;
        aHold[kid] = H_NONE;
      }
      cursor += 3;
    } else if (room >= 2 && roll < 0.13) {
      startGroup(lead, G_FAMILY);
      familyN++;
      const pram = rng.chance(0.3);
      const ride = !pram && rng.chance(0.2);
      if (pram) {
        aHold[lead] = H_PRAM;
        pramOwner.push(lead);
      }
      makeChild(lead, lead + 1, 1, 2, 0.95, !pram && !ride);
      if (ride) {
        aRole[lead + 1] = R_RIDER;
        aRide[lead + 1] = 1;
        aHold[lead] = H_CARRY;
        aHold[lead + 1] = H_NONE;
      }
      cursor += 2;
    } else if (room >= 2 && roll < 0.29) {
      startGroup(lead, G_COUPLE);
      coupleN++;
      const side = rng.chance(0.5) ? 1 : -1;
      addFollower(lead, lead + 1, R_ADULT, side, rng.range(0.56, 0.72), 0, side * rng.range(0.85, 1.25));
      cursor += 2;
    } else {
      startGroup(lead, G_ALONE);
      cursor += 1;
    }

    /* A dog needs a free hand, so it goes to somebody who has one. */
    if (dogOwner.length < kitT.dogs && aHold[lead] === H_NONE && rng.chance(0.075)) {
      aHold[lead] = H_LEAD;
      dogOwner.push(lead);
      if (aGroup[lead] === G_ALONE) aGroup[lead] = G_DOG;
    }
    if (
      aGroup[lead] === G_FAMILY &&
      companionOwner.length < kitT.companions &&
      rng.chance(0.22)
    ) {
      companionOwner.push(lead);
    }
  }

  /* How many people are in each sort of group, which is fixed for the life of
     the world: the population is recycled, never respawned. The hour moves
     how many of each are *out*, and it needs the denominator to do it. */
  const CLASS_N = 3;
  const classBuilt = new Int32Array(CLASS_N);
  const classOf = (i: number): number =>
    aGroup[i] === G_FAMILY ? 2 : aGroup[i] === G_COUPLE ? 1 : 0;
  for (let i = 0; i < MAX; i++) classBuilt[classOf(i)]++;

  /* Only somebody who is followed needs a trail kept for them. */
  let trailRows = 0;
  const claimTrail = (lead: number) => {
    if (aTrail[lead] < 0) aTrail[lead] = trailRows++;
  };
  for (let i = 0; i < MAX; i++) if (aLead[i] !== i) claimTrail(aLead[i]);
  for (const owner of dogOwner) claimTrail(owner);
  for (const owner of companionOwner) claimTrail(owner);

  const trX = new Float32Array(Math.max(1, trailRows) * TRAIL_N);
  const trY = new Float32Array(Math.max(1, trailRows) * TRAIL_N);
  const trZ = new Float32Array(Math.max(1, trailRows) * TRAIL_N);
  const trHead = new Int32Array(Math.max(1, trailRows));
  const trFill = new Int32Array(Math.max(1, trailRows));
  const trLastX = new Float32Array(Math.max(1, trailRows));
  const trLastZ = new Float32Array(Math.max(1, trailRows));

  /** The trail sample `k` steps back, clamped to what has been recorded. */
  const trailAt = (row: number, k: number): number => {
    const back = Math.min(k, trFill[row] - 1);
    return row * TRAIL_N + ((trHead[row] - back + TRAIL_N * 2) % TRAIL_N);
  };

  /* ---- appearance ------------------------------------------------------ */
  for (let i = 0; i < MAX; i++) {
    const kid = aKid[i] > 0.5;
    /* A child is 0.6 of an adult, and the vertex shader gives it a head a
       third again as big for its size. Height alone makes a short adult. */
    aHeight[i] = kid ? rng.range(0.55, 0.69) : rng.range(0.90, 1.09);
    aBuild[i] = kid ? rng.range(0.94, 1.10) : rng.range(0.86, 1.16);
    // A child gets a bobble hat or a satchel and never an umbrella.
    aAcc[i] = kid
      ? rng.chance(0.42)
        ? rng.chance(0.6)
          ? 1
          : 2
        : 0
      : rng.chance(0.34)
        ? rng.chance(0.5)
          ? 1
          : rng.chance(0.65)
            ? 2
            : 3
        : 0;
    setColor(aTopC, i, kid ? rng.pick(KID_TOPS) : rng.pick(TOPS), 0.18);
    setColor(aBotC, i, kid ? rng.pick(KID_BOTTOMS) : rng.pick(BOTTOMS), 0.14);
    setColor(aSkinC, i, rng.pick(SKINS), 0.06);
    aHurry[i] = rng.chance(0.22) ? rng.range(1.55, 2.1) : rng.range(0.95, 1.2);
    aphase[i] = rng.next();
    /* Children stop. That is the whole of what makes a family read as one
       from across a street: not the size difference, the gap opening and
       closing. `1e9` is "never" for everybody else. */
    aDawdle[i] = kid ? rng.range(3, 18) : 1e9;
  }
  /* A parent carrying a child walks the way somebody carrying a child walks. */
  for (let i = 0; i < MAX; i++) {
    if (aHold[i] === H_CARRY || aHold[i] === H_PRAM) aHurry[i] = Math.min(aHurry[i], 1.02);
    if (aRole[i] === R_CHILD || aRole[i] === R_RIDER) aHurry[i] = Math.min(aHurry[i], 1.15);
  }

  /* ---- where everybody starts ------------------------------------------ */
  for (let i = 0; i < MAX; i++) {
    const lead = aLead[i];
    if (lead === i) {
      const node = Math.floor(rng.next() * graph.n);
      ax[i] = graph.x[node];
      az[i] = graph.z[node];
      ay[i] = graph.y[node];
      ayaw[i] = rng.range(0, TAU);
    } else {
      // Beside whoever they came with, facing the same way.
      ax[i] = ax[lead] + Math.cos(ayaw[lead]) * aSlotSide[i] * aSlotOff[i];
      az[i] = az[lead] - Math.sin(ayaw[lead]) * aSlotSide[i] * aSlotOff[i];
      ay[i] = ay[lead];
      ayaw[i] = ayaw[lead];
    }
    segAx[i] = ax[i];
    segAz[i] = az[i];
    segAy[i] = ay[i];
    segTx[i] = ax[i];
    segTz[i] = az[i];
    segTy[i] = ay[i];
    aState[i] = ST_WAIT;
    aTimer[i] = lead === i ? rng.range(0, 6) : 0;
    aActive[i] = 1;
    aspeed[i] = 1.25 * aHurry[i];
    const row = aTrail[i];
    if (row >= 0) {
      for (let k = 0; k < TRAIL_N; k++) {
        trX[row * TRAIL_N + k] = ax[i];
        trY[row * TRAIL_N + k] = ay[i];
        trZ[row * TRAIL_N + k] = az[i];
      }
      trHead[row] = 0;
      trFill[row] = 1;
      trLastX[row] = ax[i];
      trLastZ[row] = az[i];
    }
  }

  /* -----------------------------------------------------------------------
   * Geometry
   * -------------------------------------------------------------------- */

  /**
   * Ten boxes and a part index, and the vertex shader does the rest.
   *
   * Part ids are a contract with the shader: 0 head, 1 torso, 2/3 arms,
   * 4/5 thighs, 6/7 shins, 8 head accessory, 9 body accessory. Even part ids
   * are the left side. The mid-detail body drops the shins and the
   * accessories and keeps the same ids, so both share one material.
   */
  interface BoxSpec {
    cx: number;
    cy: number;
    cz: number;
    sx: number;
    sy: number;
    sz: number;
    part: number;
  }

  const FULL_BODY: BoxSpec[] = [
    { cx: 0, cy: 1.585, cz: 0, sx: 0.205, sy: 0.235, sz: 0.215, part: 0 },
    { cx: 0, cy: 1.19, cz: 0, sx: 0.40, sy: 0.60, sz: 0.235, part: 1 },
    { cx: 0.245, cy: 1.15, cz: 0, sx: 0.115, sy: 0.52, sz: 0.115, part: 2 },
    { cx: -0.245, cy: 1.15, cz: 0, sx: 0.115, sy: 0.52, sz: 0.115, part: 3 },
    { cx: 0.105, cy: 0.685, cz: 0, sx: 0.165, sy: 0.44, sz: 0.165, part: 4 },
    { cx: -0.105, cy: 0.685, cz: 0, sx: 0.165, sy: 0.44, sz: 0.165, part: 5 },
    { cx: 0.105, cy: 0.235, cz: 0, sx: 0.145, sy: 0.47, sz: 0.15, part: 6 },
    { cx: -0.105, cy: 0.235, cz: 0, sx: 0.145, sy: 0.47, sz: 0.15, part: 7 },
    { cx: 0, cy: 0, cz: 0, sx: 0.28, sy: 0.28, sz: 0.28, part: 8 },
    { cx: 0, cy: 0, cz: 0, sx: 0.28, sy: 0.28, sz: 0.28, part: 9 },
  ];

  const MID_BODY: BoxSpec[] = [
    { cx: 0, cy: 1.585, cz: 0, sx: 0.205, sy: 0.235, sz: 0.215, part: 0 },
    { cx: 0, cy: 1.19, cz: 0, sx: 0.40, sy: 0.60, sz: 0.235, part: 1 },
    { cx: 0.245, cy: 1.15, cz: 0, sx: 0.115, sy: 0.52, sz: 0.115, part: 2 },
    { cx: -0.245, cy: 1.15, cz: 0, sx: 0.115, sy: 0.52, sz: 0.115, part: 3 },
    { cx: 0.105, cy: 0.46, cz: 0, sx: 0.165, sy: 0.90, sz: 0.165, part: 4 },
    { cx: -0.105, cy: 0.46, cz: 0, sx: 0.165, sy: 0.90, sz: 0.165, part: 5 },
  ];

  const FACES: Array<[number, number, number]> = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];

  function boxBody(boxes: BoxSpec[]): {
    position: Float32Array;
    normal: Float32Array;
    part: Float32Array;
    index: Uint16Array;
  } {
    const verts = boxes.length * 24;
    const position = new Float32Array(verts * 3);
    const normal = new Float32Array(verts * 3);
    const part = new Float32Array(verts);
    const index = new Uint16Array(boxes.length * 36);
    let v = 0;
    let ii = 0;
    for (const b of boxes) {
      const hx = b.sx / 2;
      const hy = b.sy / 2;
      const hz = b.sz / 2;
      for (const [nx, ny, nz] of FACES) {
        // Two in-plane axes for this face, so the quad winds outward.
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
          const lx = nx * hx + (ux * su + vx * sv) * hx;
          const ly = ny * hy + (uy * su + vy * sv) * hy;
          const lz = nz * hz + (uz * su + vz * sv) * hz;
          position[v * 3] = b.cx + lx;
          position[v * 3 + 1] = b.cy + ly;
          position[v * 3 + 2] = b.cz + lz;
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

  /** Three stacked quads — legs, body, head — for the far tier. */
  function billboardBody(): {
    position: Float32Array;
    normal: Float32Array;
    part: Float32Array;
    index: Uint16Array;
  } {
    const bands: Array<[number, number, number, number]> = [
      [0.0, 0.47, 0.17, 4],
      [0.44, 0.83, 0.23, 1],
      [0.81, 1.0, 0.11, 0],
    ];
    const position = new Float32Array(bands.length * 4 * 3);
    const normal = new Float32Array(bands.length * 4 * 3);
    const part = new Float32Array(bands.length * 4);
    const index = new Uint16Array(bands.length * 6);
    let v = 0;
    let ii = 0;
    for (const [y0, y1, halfW, p] of bands) {
      const base = v;
      for (const [sx, y] of [
        [-1, y0],
        [1, y0],
        [1, y1],
        [-1, y1],
      ]) {
        position[v * 3] = sx * halfW;
        position[v * 3 + 1] = y;
        position[v * 3 + 2] = 0;
        normal[v * 3 + 2] = 1;
        part[v] = p;
        v++;
      }
      index[ii++] = base;
      index[ii++] = base + 1;
      index[ii++] = base + 2;
      index[ii++] = base;
      index[ii++] = base + 2;
      index[ii++] = base + 3;
    }
    return { position, normal, part, index };
  }

  /* -----------------------------------------------------------------------
   * Shaders
   * -------------------------------------------------------------------- */

  const BODY_VERT = /* glsl */ `
    #define TAU 6.2831853
    uniform float uTime;

    attribute float aPart;
    attribute vec3 aPos;
    attribute float aYaw;
    attribute vec3 aAnim;   // walk phase 0..1, gait amplitude, gesture
    attribute vec4 aPose;   // sit, lean, look-up, seat height
    attribute vec3 aBody;   // height scale, build scale, accessory kind
    attribute vec3 aExtra;  // child-ness, what the hands are doing, riding
    attribute vec3 aTop;
    attribute vec3 aBot;
    attribute vec3 aSkin;

    varying vec3 vCol;
    varying vec3 vNrm;
    varying vec3 vView;
    varying float vUp;

    vec3 rotX(vec3 p, float a) {
      float s = sin(a), c = cos(a);
      return vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
    }

    void main() {
      float part = aPart;
      // Even parts are the left of the body; the two sides swing in antiphase.
      float side = mod(part, 2.0) < 0.5 ? 1.0 : -1.0;
      float ph = aAnim.x * TAU + (side > 0.0 ? 0.0 : 3.14159265);
      float gait = aAnim.y;
      float sit = aPose.x;
      float lean = aPose.y;
      float look = aPose.z;
      /* How high whatever this body is sitting on is, in metres, or zero for
         the kerb. It is a height and not a flag because the pose is solved
         from it: a bench and a step and a plinth are the same three lines
         with a different number in them. */
      float seatH = aPose.w;
      float onSeat = step(0.001, seatH);

      /* One walk cycle, four angles. The knee only ever bends backwards,
         which is the difference between a person and a marionette. */
      float thigh = gait * 0.62 * sin(ph);
      float knee = -gait * 0.95 * max(0.0, sin(ph + 2.25)) - gait * 0.10;
      float arm = -gait * 0.55 * sin(ph)
                + aAnim.z * 0.42 * sin(uTime * 4.6 + aPos.x * 0.7) * side;
      float torso = gait * 0.09 + lean * 0.34 - sit * 0.05;
      float head = look * 0.72 - lean * 0.14 + sin(uTime * 0.7 + aPos.z) * 0.03;

      /* Two sits, and which one you get is whether anything is under you.
         There are three hundred and thirty-four benches in this city and
         about a hundred thousand square metres of pavement, so both matter.

         With seatH at zero it is a *kerb* sit: hips a hand's breadth off
         the deck with the legs stretched out in front, which is what somebody
         sitting on a step, a plinth, a bench's edge or the bare kerb looks
         like — and, crucially, what somebody sitting on nothing at all looks
         like too. That is the fallback and it is the common case: a chair sit
         over nothing is a person levitating, and the straight knee is the
         same argument, because a folded one puts the shin through the deck.

         With a seat height it is a chair sit, and every part of it is that
         one number: the hips are dropped to the seat instead of to the deck,
         and the knee folds the whole ninety degrees so the shins hang down
         the front of it. aBody.x is in the drop because the drop happens
         before the body is scaled — without it a tall body's hips finish
         above a short body's on the same bench. A child's shins are shorter
         than the seat is high and its feet swing, which is correct and is
         the one place this is worth more than the geometry it costs. */
      float sitDrop = mix(0.80, 0.90 - seatH / max(0.4, aBody.x), onSeat);
      thigh = mix(thigh, 1.5708, sit);
      knee = mix(knee, mix(0.0, -1.5708, onSeat), sit);
      arm = mix(arm, 0.06, sit);
      torso -= sit * 0.13;

      /* What the hands are doing.
         Five poses and one arm rotation between them, because every one of
         them is the same joint: a pram handle and a child's hand and a dog's
         lead differ only in how far forward the arm is and whether it is one
         arm or both. Even parts are the left side, which is why the hand a
         child takes is the left one — the child is placed on that side of the
         parent by the group builder for exactly this reason. */
      float hold = aExtra.y;
      float ride = aExtra.z;
      float wantArm = 0.0;
      float takeArm = 0.0;
      float leftArm = step(0.0, side);
      if (hold > 0.5 && hold < 1.5) { wantArm = 1.00; takeArm = 1.0; }
      else if (hold > 1.5 && hold < 2.5) { wantArm = 0.72; takeArm = leftArm; }
      else if (hold > 2.5 && hold < 3.5) { wantArm = 2.02; takeArm = 1.0; }
      else if (hold > 3.5 && hold < 4.5) { wantArm = 1.32; takeArm = 1.0 - leftArm; }
      else if (hold > 4.5) { wantArm = 0.52; takeArm = 1.0 - leftArm; }
      arm = mix(arm, wantArm + gait * 0.055 * sin(ph), takeArm * (1.0 - sit));

      /* Up on somebody's shoulders: thighs over the shoulders, shins hanging
         down the front, hands somewhere on the top of a head. The seat height
         is in aPos — the CPU knows how tall the parent is and the shader does
         not — so all of this is the fold and none of it is the lift. */
      thigh = mix(thigh, 1.24, ride);
      knee = mix(knee, -1.12, ride);
      arm = mix(arm, -0.28, ride);
      torso -= ride * 0.05;

      vec3 p = position;
      vec3 n = normal;

      vec3 hip = vec3(side * 0.105, 0.90, 0.0);
      vec3 kneeP = vec3(side * 0.105, 0.47, 0.0);
      vec3 shoulder = vec3(side * 0.245, 1.40, 0.0);
      vec3 waist = vec3(0.0, 0.92, 0.0);
      vec3 neck = vec3(0.0, 1.47, 0.0);

      /* Accessories are one cube each, moved and squashed into whatever this
         body is carrying, or collapsed to a point when it is carrying
         nothing. A hat, a pack and an umbrella is three silhouettes for the
         price of two boxes. */
      if (part > 7.5) {
        float acc = aBody.z;
        float show = 0.0;
        if (part < 8.5) {
          if (acc > 0.5 && acc < 1.5) { p = p * vec3(1.18, 0.34, 1.18) + vec3(0.0, 1.745, 0.0); show = 1.0; }
          else if (acc > 2.5) { p = p * vec3(3.4, 0.20, 3.4) + vec3(0.0, 2.07, -0.05); show = 1.0; }
        } else {
          if (acc > 1.5 && acc < 2.5) { p = p * vec3(1.05, 1.3, 0.62) + vec3(0.0, 1.18, 0.20); show = 1.0; }
          else if (acc > 2.5) { p = p * vec3(0.13, 4.3, 0.13) + vec3(0.17, 1.48, -0.03); show = 1.0; }
        }
        p *= show;
      }

      if (part > 5.5 && part < 7.5) {          // shins: knee, then hip
        p = kneeP + rotX(p - kneeP, knee);
        n = rotX(n, knee);
        p = hip + rotX(p - hip, thigh);
        n = rotX(n, thigh);
      } else if (part > 3.5) {                 // thighs
        p = hip + rotX(p - hip, thigh);
        n = rotX(n, thigh);
      } else if (part > 1.5) {                 // arms hang off the torso
        p = shoulder + rotX(p - shoulder, arm);
        n = rotX(n, arm);
        p = waist + rotX(p - waist, torso);
        n = rotX(n, torso);
      } else if (part < 0.5 || (part > 7.5 && part < 8.5)) {
        // A child's head is a third again as big for its body as an adult's,
        // and without that a short body is a short adult and nothing else.
        p = neck + (p - neck) * (1.0 + aExtra.x * 0.34);
        p = neck + rotX(p - neck, head);       // head and what is on it
        n = rotX(n, head);
        p = waist + rotX(p - waist, torso);
        n = rotX(n, torso);
      } else {                                 // torso and what is on its back
        p = waist + rotX(p - waist, torso);
        n = rotX(n, torso);
      }

      /* Captured before the seat drop, so vUp stays a measurement of the
         body rather than of the ground: the fragment shader darkens shoes
         below 0.11, and a seated body whose hips are at 0.10 would otherwise
         come out in shoe leather from the waist down. */
      vUp = p.y;

      // 0.80 puts a straight, horizontal leg's underside on the deck; a
      // bench's own figure puts the hips on the bench. See sitDrop.
      p.y -= sit * sitDrop;
      p.z -= lean * 0.12;
      p.y += gait * 0.026 * cos(aAnim.x * TAU * 2.0);

      p.x *= aBody.y;
      p.z *= aBody.y;
      p.y *= aBody.x;

      float sy = sin(aYaw), cy = cos(aYaw);
      vec3 w = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
      vec3 wn = vec3(n.x * cy + n.z * sy, n.y, -n.x * sy + n.z * cy);
      vec3 world = aPos + w;

      vec3 col = aTop;
      if (part < 0.5) col = aSkin;
      else if (part > 3.5 && part < 7.5) col = aBot;
      else if (part > 7.5) col = vec3(aTop.b, aTop.r, aTop.g) * 0.92;

      vCol = col;
      vNrm = wn;
      vView = cameraPosition - world;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
    }
  `;

  const BODY_FRAG = /* glsl */ `
    precision mediump float;
    uniform vec3 uSun;
    uniform vec3 uSunCol;
    uniform vec3 uSkyCol;
    uniform vec3 uRimCol;

    varying vec3 vCol;
    varying vec3 vNrm;
    varying vec3 vView;
    varying float vUp;

    void main() {
      vec3 N = normalize(vNrm);
      vec3 V = normalize(vView);
      float ndl = max(dot(N, uSun), 0.0);
      float sky = 0.55 + 0.45 * N.y;
      float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
      /* Shoes, and the fact that the ground steals light. Both of these are
         free here and both of them are most of why a box body reads as a
         person from thirty metres. */
      vec3 col = vCol * (vUp < 0.11 ? 0.34 : 1.0);
      col *= 0.66 + 0.34 * clamp(vUp * 0.66, 0.0, 1.0);
      vec3 lit = col * (uSunCol * ndl + uSkyCol * sky) + uRimCol * rim * 0.22;
      gl_FragColor = vec4(lit, 1.0);
    }
  `;

  const CARD_VERT = /* glsl */ `
    #define TAU 6.2831853
    attribute float aPart;
    attribute vec3 aPos;
    attribute vec3 aAnim;
    attribute vec4 aPose;
    attribute vec3 aBody;
    attribute vec3 aTop;
    attribute vec3 aBot;
    attribute vec3 aSkin;
    varying vec3 vCol;

    void main() {
      vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
      float h = 1.78 * aBody.x * (1.0 - aPose.x * 0.30);
      float w = 1.15 * aBody.y;
      float swing = aAnim.y * 0.10 * sin(aAnim.x * TAU);
      mv.x += position.x * w + swing * position.y;
      mv.y += position.y * h;
      // Somebody on a bench stands on the bench, not on the pavement. Two
      // hundred metres out this is a pixel, and it is a pixel in the right
      // place for one multiply.
      mv.y += aPose.x * aPose.w;
      gl_Position = projectionMatrix * mv;
      vCol = aPart < 0.5 ? aSkin : (aPart > 3.5 ? aBot : aTop);
    }
  `;

  const CARD_FRAG = /* glsl */ `
    precision mediump float;
    uniform vec3 uSunCol;
    uniform vec3 uSkyCol;
    varying vec3 vCol;
    void main() {
      gl_FragColor = vec4(vCol * (uSunCol * 0.42 + uSkyCol * 0.9), 1.0);
    }
  `;

  const uniforms = {
    uTime: { value: 0 },
    uSun: { value: SUN_DIR.clone() },
    uSunCol: { value: new THREE.Color(1.42, 1.06, 0.80) },
    uSkyCol: { value: new THREE.Color(0.30, 0.28, 0.40) },
    uRimCol: { value: new THREE.Color(0.42, 0.58, 0.85) },
  };

  const bodyMat = new THREE.ShaderMaterial({
    name: "EmpyreanCrowd",
    uniforms,
    vertexShader: BODY_VERT,
    fragmentShader: BODY_FRAG,
    fog: false,
  });
  const cardMat = new THREE.ShaderMaterial({
    name: "EmpyreanCrowdCard",
    uniforms,
    vertexShader: CARD_VERT,
    fragmentShader: CARD_FRAG,
    fog: false,
    side: THREE.DoubleSide,
  });

  /* -----------------------------------------------------------------------
   * Instance buffers
   * -------------------------------------------------------------------- */

  interface Tier {
    geo: THREE.InstancedBufferGeometry;
    mesh: THREE.Mesh;
    pos: Float32Array;
    yaw: Float32Array;
    anim: Float32Array;
    pose: Float32Array;
    body: Float32Array;
    extra: Float32Array;
    top: Float32Array;
    bot: Float32Array;
    skin: Float32Array;
    attrs: THREE.InstancedBufferAttribute[];
    n: number;
  }

  const makeTier = (
    src: { position: Float32Array; normal: Float32Array; part: Float32Array; index: Uint16Array },
    mat: THREE.ShaderMaterial,
    cap: number,
  ): Tier => {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(src.position, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(src.normal, 3));
    geo.setAttribute("aPart", new THREE.BufferAttribute(src.part, 1));
    geo.setIndex(new THREE.BufferAttribute(src.index, 1));

    const pos = new Float32Array(cap * 3);
    const yaw = new Float32Array(cap);
    const anim = new Float32Array(cap * 3);
    const pose = new Float32Array(cap * 4);
    const body = new Float32Array(cap * 3);
    const extra = new Float32Array(cap * 3);
    const top = new Float32Array(cap * 3);
    const bot = new Float32Array(cap * 3);
    const skin = new Float32Array(cap * 3);
    const attrs: THREE.InstancedBufferAttribute[] = [];
    const bind = (name: string, arr: Float32Array, size: number) => {
      const attr = new THREE.InstancedBufferAttribute(arr, size);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, attr);
      attrs.push(attr);
    };
    bind("aPos", pos, 3);
    bind("aYaw", yaw, 1);
    bind("aAnim", anim, 3);
    bind("aPose", pose, 4);
    bind("aBody", body, 3);
    bind("aExtra", extra, 3);
    bind("aTop", top, 3);
    bind("aBot", bot, 3);
    bind("aSkin", skin, 3);

    geo.instanceCount = 0;
    /* Declared, not computed, and it covers the deck rather than the body.
     *
     * The geometry here is one person authored around the origin and the
     * placements live in `aPos`, so anything that reads these bounds — a
     * frustum test, a `Box3.setFromObject`, a debug sweep looking for
     * geometry left in the wrong space — would otherwise be told that eight
     * hundred pedestrians are a two-metre box sitting on the ice six hundred
     * metres below the city. The honest answer is the disc they walk on.
     * (The traffic solves the same problem the other way, with a real
     * `InstancedMesh`, because at seventy-nine vehicles the exact answer is
     * affordable and here it is not.) */
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, ISLAND_Y, 0), PLATEAU_R * 1.6);
    geo.boundingBox = new THREE.Box3(
      new THREE.Vector3(-PLATEAU_R, ISLAND_Y - 2, -PLATEAU_R),
      new THREE.Vector3(PLATEAU_R, ISLAND_Y + 3, PLATEAU_R),
    );
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    group.add(mesh);
    return { geo, mesh, pos, yaw, anim, pose, body, extra, top, bot, skin, attrs, n: 0 };
  };

  const tiers: Tier[] = [
    makeTier(boxBody(FULL_BODY), bodyMat, MAX),
    makeTier(boxBody(MID_BODY), bodyMat, MAX),
    makeTier(billboardBody(), cardMat, MAX),
  ];

  const writeInstance = (tier: Tier, i: number) => {
    const s = tier.n++;
    tier.pos[s * 3] = ax[i];
    tier.pos[s * 3 + 1] = ay[i];
    tier.pos[s * 3 + 2] = az[i];
    tier.yaw[s] = ayaw[i];
    tier.anim[s * 3] = aphase[i];
    tier.anim[s * 3 + 1] = agait[i];
    tier.anim[s * 3 + 2] = agesture[i];
    tier.pose[s * 4] = aSit[i];
    tier.pose[s * 4 + 1] = aLean[i];
    tier.pose[s * 4 + 2] = aLook[i];
    tier.pose[s * 4 + 3] = aSeatH[i];
    tier.body[s * 3] = aHeight[i];
    tier.body[s * 3 + 1] = aBuild[i];
    tier.body[s * 3 + 2] = aAcc[i];
    tier.extra[s * 3] = aKid[i];
    tier.extra[s * 3 + 1] = aHold[i];
    tier.extra[s * 3 + 2] = aRide[i];
    tier.top[s * 3] = aTopC[i * 3];
    tier.top[s * 3 + 1] = aTopC[i * 3 + 1];
    tier.top[s * 3 + 2] = aTopC[i * 3 + 2];
    tier.bot[s * 3] = aBotC[i * 3];
    tier.bot[s * 3 + 1] = aBotC[i * 3 + 1];
    tier.bot[s * 3 + 2] = aBotC[i * 3 + 2];
    tier.skin[s * 3] = aSkinC[i * 3];
    tier.skin[s * 3 + 1] = aSkinC[i * 3 + 1];
    tier.skin[s * 3 + 2] = aSkinC[i * 3 + 2];
  };

  /* -----------------------------------------------------------------------
   * The kit — dogs, robots and prams
   *
   * Three geometries, one material, one program, three draw calls. They share
   * a shader because they share a *problem*: a handful of boxes, a yaw, a
   * phase, and one moving part each. Part ids are global across the three, so
   * the shader knows which of them it is looking at without being told.
   * -------------------------------------------------------------------- */

  /** 0 body, 1 head, 2 muzzle and ears, 3 front legs, 4 back legs, 5 tail,
      6 the lead — one thin box, repositioned in world space. */
  const DOG_BOXES: BoxSpec[] = [
    { cx: 0, cy: 0.42, cz: 0, sx: 0.20, sy: 0.20, sz: 0.54, part: 0 },
    { cx: 0, cy: 0.55, cz: -0.34, sx: 0.19, sy: 0.17, sz: 0.19, part: 1 },
    { cx: 0, cy: 0.51, cz: -0.47, sx: 0.10, sy: 0.09, sz: 0.13, part: 2 },
    { cx: 0.075, cy: 0.66, cz: -0.31, sx: 0.05, sy: 0.10, sz: 0.035, part: 2 },
    { cx: -0.075, cy: 0.66, cz: -0.31, sx: 0.05, sy: 0.10, sz: 0.035, part: 2 },
    { cx: 0.075, cy: 0.17, cz: -0.18, sx: 0.06, sy: 0.34, sz: 0.06, part: 3 },
    { cx: -0.075, cy: 0.17, cz: -0.18, sx: 0.06, sy: 0.34, sz: 0.06, part: 3 },
    { cx: 0.075, cy: 0.17, cz: 0.19, sx: 0.06, sy: 0.34, sz: 0.06, part: 4 },
    { cx: -0.075, cy: 0.17, cz: 0.19, sx: 0.06, sy: 0.34, sz: 0.06, part: 4 },
    { cx: 0, cy: 0.52, cz: 0.30, sx: 0.045, sy: 0.045, sz: 0.22, part: 5 },
    { cx: 0, cy: 0.5, cz: 0, sx: 0.026, sy: 1.0, sz: 0.026, part: 6 },
  ];

  /** 7 chassis, 8 dome, 9 eyes, 10 antenna, 11 the one tool it has, 12 base. */
  const BOT_BOXES: BoxSpec[] = [
    { cx: 0, cy: 0.36, cz: 0, sx: 0.42, sy: 0.44, sz: 0.52, part: 7 },
    { cx: 0, cy: 0.67, cz: -0.02, sx: 0.34, sy: 0.22, sz: 0.34, part: 8 },
    { cx: 0.085, cy: 0.69, cz: -0.17, sx: 0.10, sy: 0.10, sz: 0.05, part: 9 },
    { cx: -0.085, cy: 0.69, cz: -0.17, sx: 0.10, sy: 0.10, sz: 0.05, part: 9 },
    { cx: 0, cy: 0.87, cz: 0, sx: 0.026, sy: 0.20, sz: 0.026, part: 10 },
    { cx: 0, cy: 1.00, cz: 0, sx: 0.085, sy: 0.085, sz: 0.085, part: 10 },
    { cx: 0, cy: 0.16, cz: -0.34, sx: 0.58, sy: 0.16, sz: 0.16, part: 11 },
    { cx: 0, cy: 0.09, cz: 0, sx: 0.44, sy: 0.16, sz: 0.50, part: 12 },
  ];

  /** 13 body, 14 hood, 15 wheels, 16 the handle the parent is holding. */
  /* The wheels are 20 cm and turn about an axle at 14.5 cm, which is not a
     coincidence: a *square* wheel spinning about its centre sweeps its own
     diagonal, so a 28 cm one at that height dips four centimetres through the
     pavement twice a revolution. Small enough that the diagonal clears the
     deck is the whole constraint, and it is why the body sits where it does. */
  const PRAM_BOXES: BoxSpec[] = [
    { cx: 0, cy: 0.46, cz: 0, sx: 0.40, sy: 0.30, sz: 0.60, part: 13 },
    { cx: 0, cy: 0.66, cz: 0.14, sx: 0.38, sy: 0.26, sz: 0.30, part: 14 },
    { cx: 0.20, cy: 0.145, cz: -0.22, sx: 0.06, sy: 0.20, sz: 0.20, part: 15 },
    { cx: -0.20, cy: 0.145, cz: -0.22, sx: 0.06, sy: 0.20, sz: 0.20, part: 15 },
    { cx: 0.20, cy: 0.145, cz: 0.22, sx: 0.06, sy: 0.20, sz: 0.20, part: 15 },
    { cx: -0.20, cy: 0.145, cz: 0.22, sx: 0.06, sy: 0.20, sz: 0.20, part: 15 },
    { cx: 0.18, cy: 0.68, cz: 0.30, sx: 0.035, sy: 0.42, sz: 0.035, part: 16 },
    { cx: -0.18, cy: 0.68, cz: 0.30, sx: 0.035, sy: 0.42, sz: 0.035, part: 16 },
    { cx: 0, cy: 0.88, cz: 0.31, sx: 0.40, sy: 0.04, sz: 0.04, part: 16 },
  ];

  const KIT_VERT = /* glsl */ `
    #define TAU 6.2831853
    uniform float uTime;

    attribute float aPart;
    attribute vec3 aPos;
    attribute float aYaw;
    attribute vec3 aTune;   // scale, phase 0..1, mode
    attribute vec3 aRope;   // world offset from here to the hand, for a lead
    attribute vec3 aTint;

    varying vec3 vCol;
    varying vec3 vNrm;
    varying vec3 vView;
    varying float vGlow;

    vec3 rotX(vec3 p, float a) {
      float s = sin(a), c = cos(a);
      return vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
    }
    vec3 rotY(vec3 p, float a) {
      float s = sin(a), c = cos(a);
      return vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
    }

    void main() {
      float part = aPart;
      float scale = aTune.x;
      float ph = aTune.y * TAU;
      float mode = aTune.z;
      vec3 p = position;
      vec3 n = normal;
      vec3 col = aTint;
      float glow = 0.0;
      // Which of a pair this vertex belongs to. Every paired box here sits
      // wholly to one side of the centreline, so the sign of x is the side.
      float sd = position.x >= 0.0 ? 1.0 : -1.0;
      vec3 world;

      if (part > 5.5 && part < 6.5) {
        /* The lead. Drawn straight into world space between the dog's collar
           and the hand at the other end of it, because those two points are
           in different frames and no single yaw takes you from one to the
           other. A lead that does not join them is worse than none. */
        vec3 collar = aPos + rotY(vec3(0.0, 0.5 * scale, -0.26 * scale), aYaw);
        vec3 hand = aPos + aRope;
        vec3 span = hand - collar;
        float len = length(span);
        if (len < 0.05) {
          world = collar;                       // nobody on the other end
          n = vec3(0.0, 1.0, 0.0);
        } else {
          float t = position.y;
          vec3 dir = span / len;
          vec3 across = normalize(cross(dir, vec3(0.0, 1.0, 0.0)) + vec3(0.0, 0.0, 1e-4));
          vec3 up = cross(across, dir);
          vec3 mid = collar + span * t;
          mid.y -= 0.16 * len * sin(3.14159 * t);   // slack
          world = mid + across * position.x + up * position.z;
          n = up;
        }
        col = vec3(0.80, 0.30, 0.32);
        vNrm = n;
        vCol = col;
        vGlow = 0.0;
        vView = cameraPosition - world;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
        return;
      }

      if (part < 5.5) {
        /* A dog. The mode slot is how hard it is trotting: at zero the head
           goes down, which is the whole of "it has found something". */
        float gait = mode;
        if (part < 0.5) {
          p.y += 0.014 * sin(ph * 2.0) * gait;
        } else if (part < 2.5) {
          vec3 neck = vec3(0.0, 0.5, -0.24);
          float tilt = 0.42 * (1.0 - gait) + 0.08 * sin(ph) * gait;
          p = neck + rotX(p - neck, tilt);
          n = rotX(n, tilt);
          if (part > 1.5) col = aTint * 0.80;
        } else if (part < 4.5) {
          float back = part > 3.5 ? 3.14159 : 0.0;
          /* 0.62 and not more: the legs are straight, so a swing of a is a
             paw lifted by 0.34 * (1 - cos a) — at 0.8 that is ten centimetres
             of daylight under a trotting dog at both ends of every stride. */
          float swing = gait * 0.62 * sin(ph + back + (sd > 0.0 ? 0.0 : 3.14159));
          vec3 hip = vec3(p.x, 0.34, part > 3.5 ? 0.19 : -0.18);
          p = hip + rotX(p - hip, swing);
          n = rotX(n, swing);
        } else {
          vec3 root = vec3(0.0, 0.52, 0.20);
          float wag = sin(uTime * 7.5 + ph) * (0.25 + gait * 0.55);
          p = root + rotY(rotX(p - root, -0.55), wag);
          n = rotY(rotX(n, -0.55), wag);
          col = aTint * 0.92;
        }
      } else if (part < 12.5) {
        /* A robot. One chassis, three jobs: mode 0 sweeps, 1 delivers,
           2 keeps a child company. Nothing here is a servant and nothing
           here has a face that could frown.

           Every scale below is about the part's OWN centre. Scaling the raw
           position instead moves a part as well as resizing it, by its
           distance from the origin — which floated the companion's head
           twenty-three centimetres clear of its body and threw the courier's
           parcel a metre and a half up and behind it. Both drew perfectly,
           both were in the right place in every test, and both were only
           ever going to be found by looking. */
        float sweeper = 1.0 - step(0.5, mode);
        float courier = step(0.5, mode) * (1.0 - step(1.5, mode));
        float pal = step(1.5, mode);
        float lift = courier * 0.06 - sweeper * 0.03;
        if (part < 7.5) {
          vec3 c = vec3(0.0, 0.36, 0.0);
          vec3 sc = sweeper > 0.5 ? vec3(1.26, 0.82, 1.12)
                  : courier > 0.5 ? vec3(0.96, 1.20, 0.94)
                  : vec3(0.92, 0.88, 0.92);
          p = c + (p - c) * sc;
        } else if (part < 8.5) {
          vec3 c = vec3(0.0, 0.67, -0.02);
          p = c + (p - c) * (pal > 0.5 ? vec3(1.10, 1.30, 1.10) : vec3(1.0));
          p.y += lift;
          col = vec3(0.93, 0.96, 0.98);
        } else if (part < 9.5) {
          // The eyes: big, round-ish, dark, proud of the dome so they read
          // from a distance, and lit from inside once the lamps come on.
          vec3 c = vec3(sd * 0.085, 0.69, -0.17);
          p = c + (p - c) * vec3(1.2, 1.2, 1.4);
          p.y += lift;
          p.z -= 0.035;
          col = vec3(0.09, 0.12, 0.18);
          glow = 1.0;
        } else if (part < 10.5) {
          p.y += lift;
          col = p.y > 0.93 ? vec3(1.0, 0.78, 0.30) : vec3(0.80, 0.83, 0.86);
          glow = p.y > 0.93 ? 1.0 : 0.0;
        } else if (part < 11.5) {
          vec3 c = vec3(0.0, 0.16, -0.34);
          if (sweeper > 0.5) {
            // A brush roller, turning on its own axis. Slow enough to read
            // as a brush rather than as a warning light.
            p = c + rotX(p - c, uTime * 5.0);
            n = rotX(n, uTime * 5.0);
            col = vec3(0.95, 0.80, 0.34);
          } else if (courier > 0.5) {
            // A parcel on the back deck, with a ribbon of tape over it.
            p = c + (p - c) * vec3(0.52, 2.1, 1.9) + vec3(0.0, 0.63, 0.56);
            col = abs(p.x) < 0.035 ? vec3(0.92, 0.55, 0.36) : vec3(0.86, 0.73, 0.52);
          } else {
            p *= 0.0;
          }
        } else {
          if (pal > 0.5) {
            // No wheels on a thing that hovers: a lit pad instead.
            vec3 c = vec3(0.0, 0.09, 0.0);
            p = c + (p - c) * vec3(0.78, 0.30, 0.78) + vec3(0.0, 0.06, 0.0);
            col = vec3(0.45, 0.85, 0.95);
            glow = 1.0;
          } else {
            col = vec3(0.22, 0.24, 0.28);
          }
        }
      } else {
        /* A pram. The wheels are the only moving part and they are most of
           what says this is being pushed rather than parked. */
        if (part > 14.5 && part < 15.5) {
          vec3 axle = vec3(0.0, 0.145, position.z >= 0.0 ? 0.22 : -0.22);
          p = axle + rotX(p - axle, ph * 3.0);
          n = rotX(n, ph * 3.0);
          col = vec3(0.17, 0.18, 0.21);
        } else if (part > 15.5) {
          col = vec3(0.74, 0.77, 0.81);
        } else if (part > 13.5) {
          col = aTint * 0.74;
        }
      }

      p *= scale;
      float sy = sin(aYaw), cy = cos(aYaw);
      vec3 w = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
      vec3 wn = vec3(n.x * cy + n.z * sy, n.y, -n.x * sy + n.z * cy);
      world = aPos + w;

      vCol = col;
      vNrm = wn;
      vGlow = glow;
      vView = cameraPosition - world;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
    }
  `;

  const KIT_FRAG = /* glsl */ `
    precision mediump float;
    uniform vec3 uSun;
    uniform vec3 uSunCol;
    uniform vec3 uSkyCol;
    uniform vec3 uRimCol;

    varying vec3 vCol;
    varying vec3 vNrm;
    varying vec3 vView;
    varying float vGlow;

    void main() {
      vec3 N = normalize(vNrm);
      vec3 V = normalize(vView);
      float ndl = max(dot(N, uSun), 0.0);
      float sky = 0.55 + 0.45 * N.y;
      float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
      vec3 lit = vCol * (uSunCol * ndl + uSkyCol * sky) + uRimCol * rim * 0.22;
      // An eye and a signal lamp are lit from inside, which is the difference
      // between a machine that is on and a machine that is broken.
      lit += vCol * vGlow * 0.35 + vGlow * vec3(0.30, 0.40, 0.46) * 0.5;
      gl_FragColor = vec4(lit, 1.0);
    }
  `;

  const kitMat = new THREE.ShaderMaterial({
    name: "EmpyreanCrowdKit",
    uniforms,
    vertexShader: KIT_VERT,
    fragmentShader: KIT_FRAG,
    fog: false,
  });

  interface Kit {
    geo: THREE.InstancedBufferGeometry;
    mesh: THREE.Mesh;
    pos: Float32Array;
    yaw: Float32Array;
    tune: Float32Array;
    rope: Float32Array;
    tint: Float32Array;
    attrs: THREE.InstancedBufferAttribute[];
    n: number;
  }

  const makeKit = (boxes: BoxSpec[], want: number): Kit => {
    const cap = Math.max(1, want);
    const src = boxBody(boxes);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(src.position, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(src.normal, 3));
    geo.setAttribute("aPart", new THREE.BufferAttribute(src.part, 1));
    geo.setIndex(new THREE.BufferAttribute(src.index, 1));

    const pos = new Float32Array(cap * 3);
    const yaw = new Float32Array(cap);
    const tune = new Float32Array(cap * 3);
    const rope = new Float32Array(cap * 3);
    const tint = new Float32Array(cap * 3);
    const attrs: THREE.InstancedBufferAttribute[] = [];
    const bind = (name: string, arr: Float32Array, size: number) => {
      const attr = new THREE.InstancedBufferAttribute(arr, size);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, attr);
      attrs.push(attr);
    };
    bind("aPos", pos, 3);
    bind("aYaw", yaw, 1);
    bind("aTune", tune, 3);
    bind("aRope", rope, 3);
    bind("aTint", tint, 3);

    geo.instanceCount = 0;
    // The deck they stand on, declared, for the same reason as the tiers.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, ISLAND_Y, 0), PLATEAU_R * 1.6);
    geo.boundingBox = new THREE.Box3(
      new THREE.Vector3(-PLATEAU_R, ISLAND_Y - 2, -PLATEAU_R),
      new THREE.Vector3(PLATEAU_R, ISLAND_Y + 3, PLATEAU_R),
    );
    const mesh = new THREE.Mesh(geo, kitMat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    group.add(mesh);
    return { geo, mesh, pos, yaw, tune, rope, tint, attrs, n: 0 };
  };

  const writeKit = (
    kit: Kit,
    x: number,
    y: number,
    z: number,
    yaw: number,
    scale: number,
    phase: number,
    mode: number,
    r: number,
    g: number,
    b: number,
    ropeX: number,
    ropeY: number,
    ropeZ: number,
  ) => {
    const i = kit.n++;
    kit.pos[i * 3] = x;
    kit.pos[i * 3 + 1] = y;
    kit.pos[i * 3 + 2] = z;
    kit.yaw[i] = yaw;
    kit.tune[i * 3] = scale;
    kit.tune[i * 3 + 1] = phase;
    kit.tune[i * 3 + 2] = mode;
    kit.rope[i * 3] = ropeX;
    kit.rope[i * 3 + 1] = ropeY;
    kit.rope[i * 3 + 2] = ropeZ;
    kit.tint[i * 3] = r;
    kit.tint[i * 3 + 1] = g;
    kit.tint[i * 3 + 2] = b;
  };

  /* ---- dogs ------------------------------------------------------------ */

  const NDOG = dogOwner.length;
  const dgOwner = Int32Array.from(dogOwner.length ? dogOwner : []);
  const dgX = new Float32Array(NDOG);
  const dgY = new Float32Array(NDOG);
  const dgZ = new Float32Array(NDOG);
  const dgYaw = new Float32Array(NDOG);
  const dgPhase = new Float32Array(NDOG);
  const dgGait = new Float32Array(NDOG);
  const dgSize = new Float32Array(NDOG);
  const dgSniff = new Float32Array(NDOG);
  const dgWeave = new Float32Array(NDOG);
  const dgCol = new Float32Array(NDOG * 3);
  const DOG_COATS = [0x6b4a33, 0x2e2a28, 0xd8c4a0, 0xa8683a, 0xe8e2d6, 0x8a8f95, 0x4a3a2e];
  for (let d = 0; d < NDOG; d++) {
    const o = dgOwner[d];
    dgX[d] = ax[o];
    dgY[d] = ay[o];
    dgZ[d] = az[o];
    dgYaw[d] = ayaw[o];
    dgPhase[d] = rng.next();
    dgSize[d] = rng.range(0.72, 1.24);
    dgWeave[d] = rng.next();
    dgSniff[d] = rng.range(3, 20);
    tmpColor.setHex(rng.pick(DOG_COATS));
    dgCol[d * 3] = tmpColor.r;
    dgCol[d * 3 + 1] = tmpColor.g;
    dgCol[d * 3 + 2] = tmpColor.b;
  }

  /* ---- robots ---------------------------------------------------------- */

  const NBOT = kitT.sweepers + kitT.couriers + companionOwner.length;
  const btX = new Float32Array(NBOT);
  const btY = new Float32Array(NBOT);
  const btZ = new Float32Array(NBOT);
  const btYaw = new Float32Array(NBOT);
  const btMode = new Uint8Array(NBOT);
  const btOwner = new Int32Array(NBOT).fill(-1);
  const btNode = new Int32Array(NBOT);
  const btNext = new Int32Array(NBOT);
  const btPrev = new Int32Array(NBOT).fill(-1);
  const btT = new Float32Array(NBOT);
  const btLen = new Float32Array(NBOT);
  const btSpeed = new Float32Array(NBOT);
  const btSide = new Float32Array(NBOT);
  const btPhase = new Float32Array(NBOT);
  const btTimer = new Float32Array(NBOT);
  const btCol = new Float32Array(NBOT * 3);
  /* Mint, coral, sunflower, sky. Chosen so that a five-year-old would pick
     one up, and so that none of them could be mistaken for a uniform. */
  const BOT_COATS = [0x46c6a8, 0xf2795f, 0xf5c04a, 0x5aa9e6, 0xb08ae0];

  /** The neighbour that carries on the way we were going, roughly. */
  const pickNext = (node: number, fromX: number, fromZ: number, avoid: number): number => {
    let best = -1;
    let bestScore = -Infinity;
    const dx = graph.x[node] - fromX;
    const dz = graph.z[node] - fromZ;
    const dl = Math.hypot(dx, dz) || 1;
    for (let e = graph.start[node]; e < graph.start[node + 1]; e++) {
      const nb = graph.list[e];
      if (nb === node) continue;
      const ex = graph.x[nb] - graph.x[node];
      const ez = graph.z[nb] - graph.z[node];
      const el = Math.hypot(ex, ez) || 1;
      let score = (dx / dl) * (ex / el) + (dz / dl) * (ez / el) + rng.next() * 0.55;
      if (nb === avoid) score -= 1.6;
      if (score > bestScore) {
        bestScore = score;
        best = nb;
      }
    }
    return best < 0 ? node : best;
  };

  for (let b = 0; b < NBOT; b++) {
    const mode = b < kitT.sweepers ? 0 : b < kitT.sweepers + kitT.couriers ? 1 : 2;
    btMode[b] = mode;
    btPhase[b] = rng.next();
    btSide[b] = rng.chance(0.5) ? 1 : -1;
    tmpColor.setHex(BOT_COATS[mode === 0 ? 0 : mode === 1 ? 1 : rng.int(2, 4)]);
    btCol[b * 3] = tmpColor.r;
    btCol[b * 3 + 1] = tmpColor.g;
    btCol[b * 3 + 2] = tmpColor.b;
    if (mode === 2) {
      const owner = companionOwner[b - kitT.sweepers - kitT.couriers];
      btOwner[b] = owner;
      btX[b] = ax[owner];
      btY[b] = ay[owner];
      btZ[b] = az[owner];
      btSpeed[b] = 1.6;
      continue;
    }
    // A sweeper works at a crawl; a courier keeps up with the pavement.
    btSpeed[b] = mode === 0 ? rng.range(0.75, 1.0) : rng.range(1.5, 2.0);
    const node = Math.floor(rng.next() * graph.n);
    btNode[b] = node;
    btNext[b] = pickNext(node, graph.x[node] - 1, graph.z[node], -1);
    btLen[b] = Math.max(
      0.5,
      Math.hypot(graph.x[btNext[b]] - graph.x[node], graph.z[btNext[b]] - graph.z[node]),
    );
    btX[b] = graph.x[node];
    btY[b] = graph.y[node];
    btZ[b] = graph.z[node];
  }

  /* ---- prams ----------------------------------------------------------- */

  const NPRAM = pramOwner.length;
  const pmOwner = Int32Array.from(pramOwner.length ? pramOwner : []);
  const pmPhase = new Float32Array(NPRAM);
  const pmCol = new Float32Array(NPRAM * 3);
  const PRAM_COATS = [0x3f6f8f, 0x8f4f6f, 0x4f7f5f, 0x7f5f3f, 0x555f7f];
  for (let m = 0; m < NPRAM; m++) {
    pmPhase[m] = rng.next();
    tmpColor.setHex(rng.pick(PRAM_COATS));
    pmCol[m * 3] = tmpColor.r;
    pmCol[m * 3 + 1] = tmpColor.g;
    pmCol[m * 3 + 2] = tmpColor.b;
  }

  const dogMesh = makeKit(DOG_BOXES, NDOG);
  const botMesh = makeKit(BOT_BOXES, NBOT);
  const pramMesh = makeKit(PRAM_BOXES, NPRAM);
  const kits: Kit[] = [dogMesh, botMesh, pramMesh];

  /* -----------------------------------------------------------------------
   * The crowd's own spatial index — separation, and `nearest`
   * -------------------------------------------------------------------- */

  const bodyCell = new Int32Array(GRID_N * GRID_N).fill(-1);
  const bodyNext = new Int32Array(MAX).fill(-1);

  /* -----------------------------------------------------------------------
   * Decisions
   * -------------------------------------------------------------------- */

  /* The lamp switch, deliberately: everything below it decides *when in the
     day* something happens — how full the Bazaar is, whether anybody is at
     the rim — rather than how bright anything is. Shading uses
     `ctx.gradeDaylight` instead. */
  let daylight = 1;
  /* How much of the crowd should be sitting and how much on the rail. Not
     quotas — the falloff below is soft — but the numbers the mix settles on. */
  let sitTarget = 40;
  let leanTarget = 34;
  const satiate = (have: number, want: number): number => {
    const t = have / Math.max(1, want);
    return 1 / (1 + t * t);
  };

  /** Give up a place on a bench, if this body is holding one. */
  const releaseSeat = (i: number) => {
    const s = aSeat[i];
    if (s < 0) return;
    if (seatOwner[s] === i) seatOwner[s] = -1;
    aSeat[i] = -1;
  };
  /**
   * …and whoever is with them, because the leader booked both.
   *
   * Only the first follower is ever given one: a bench holds two, and the
   * third and fourth members of a family sit on the kerb beside it, which is
   * both what fits and what happens.
   */
  const releaseGroupSeats = (i: number) => {
    releaseSeat(i);
    const f = firstFollower(i);
    if (f >= 0) releaseSeat(f);
  };

  const pickDestination = (i: number) => {
    /* Whatever was booked is given up here and nowhere else. Every route out
       of a destination goes through this function or through going indoors,
       so a seat cannot be left held by somebody who has walked away — which
       presents as benches that fill up over ten minutes and never empty. */
    releaseGroupSeats(i);
    aFinal[i] = 0;
    // Eight candidates, best score wins: district pull for the hour, a taste
    // for the kind of place, and a strong preference for somewhere you could
    // plausibly walk to before the sun finishes going down.
    let best = -1;
    let bestScore = -Infinity;
    for (let k = 0; k < 8; k++) {
      const c = Math.floor(rng.next() * dests.n);
      const node = dests.node[c];
      const pull = DISTRICT_PULL[DISTRICT_IDS[graph.district[node]] ?? "core"];
      const kind = dests.kind[c];
      let score = (pull?.base ?? 1) + (pull?.dusk ?? 0) * (1 - daylight);
      /* Damped by how many people are already doing it.
       *
       * Sitting and leaning on the rail are the two long dwells, they draw
       * from the same pool, and left to compete on a fixed weight they take
       * turns winning: a hundred people on the rim and nobody on a bench for
       * two minutes, then the reverse. Nothing about that is visible as a
       * bug and all of it is visible as a city that keeps changing its mind.
       *
       * So the weight falls off as the share fills, which halves at target
       * and collapses past it — a bench nobody is on is worth more than the
       * tenth seat on a full one, which is also true of benches. */
      /* The rim was 5.5, and 5.5 was why the streets were thin.
       *
       * Measured at the sunset this world exists for: 345 of 1303 people —
       * a quarter of the city — were on the rim ring or walking to it, and
       * `census.leaning` sat at two and a half times the `leanTarget` this
       * same file computes. Two separate statements of intent said otherwise:
       * the doc at the top of this file says five per cent on the rail, and
       * `DISTRICT_PULL.rim` is the *sparsest* district in the table and gets
       * sparser after dark. `satiate` cannot hold it on its own, because the
       * rim also gets `reach` 190 against a local errand's 60 — at 150 m a
       * rim spot scores 0.56 of its weight and a shop door scores 0.29 — so
       * it wins from anywhere on the island.
       *
       * 2.4 lands `leaning` on the number `leanTarget` asks for, and the
       * ~190 people that frees go back into the street network: the east
       * avenue went from 35 bodies over its 230 m of pavement to 50, the
       * Halo from 128 to 230. This is a correction toward what the file
       * already said, not a change of mind about the rim. */
      if (kind === D_RIM) score *= 2.4 * (0.5 + daylight * 0.9) * satiate(leanCount, leanTarget);
      if (kind === D_SIT) score *= 1.1 * (0.6 + daylight * 0.7) * satiate(sitCount, sitTarget);
      if (kind === D_BENCH) {
        const b = dests.bench[c];
        // Both places taken. Not a low score — no score: a body sent to a
        // full bench would stand in front of it for two minutes.
        if (seatOwner[b * 2] >= 0 && seatOwner[b * 2 + 1] >= 0) continue;
        /* Damped by the same count a kerb sit is, so seats change *where*
           the city sits rather than how much of it does.
           Below the kerb's 1.1 rather than above it, which looks backwards
           and is not: there are 334 benches against 112 kerb spots, so at
           equal weight three sits in four would be on furniture and the
           street would visibly sit down — measured, sitting went from 4% of
           the crowd to 14% and the rim halved to pay for it. At 0.9 it is
           about half and half, which is what a pavement with a bench every
           forty-six metres actually looks like. */
        score *= 0.9 * (0.6 + daylight * 0.7) * satiate(sitCount, sitTarget);
      }
      if (kind === D_DOOR) score *= 1.25;
      if (kind === D_TRAM) score *= 0.7;
      /* Sharply local, except for the two things people cross a city for.
         A world where every errand is a mile is a world of commuters: almost
         everybody is walking at any moment, nothing is standing still, and
         the street reads as a conveyor. But nobody has ever gone to the
         nearest view. */
      const reach = kind === D_RIM || kind === D_LANDMARK ? 190 : 60;
      const d = Math.hypot(graph.x[node] - ax[i], graph.z[node] - az[i]);
      score *= 1 / (1 + d / reach);
      score *= 0.7 + rng.next() * 0.6;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best < 0) return;
    aDestNode[i] = dests.node[best];
    aDestKind[i] = dests.kind[best];
    aFaceX[i] = dests.faceX[best];
    aFaceZ[i] = dests.faceZ[best];
    if (aDestKind[i] === D_BENCH) {
      /* Book a place now rather than on arrival. Deciding at the bench means
         two people walk to the same end of it and one of them is standing in
         the other's lap when they get there; deciding here means the second
         one never chose this bench at all. */
      const b = dests.bench[best];
      const mine = seatOwner[b * 2] < 0 ? b * 2 : b * 2 + 1;
      seatOwner[mine] = i;
      aSeat[i] = mine;
      /* And the other place goes to whoever they came with, if that is
         somebody who would sit on a bench: a partner or the second parent.
         A couple on a bench is the single best thing a bench can have on it
         and it costs one array read, because a group is contiguous. */
      const other = mine === b * 2 ? b * 2 + 1 : b * 2;
      const f = firstFollower(i);
      if (f >= 0 && aRole[f] === R_ADULT && seatOwner[other] < 0) {
        seatOwner[other] = f;
        aSeat[f] = other;
      }
    }
    requestPath(i);
    /* Nobody else in the group is consulted, and that is the point: whoever
       is with them is coming, and they are coming by walking where this body
       walks rather than by being handed the same destination and finding
       their own way to it. Two people who path separately to one door arrive
       together having walked different streets. */
  };

  /** Fit the current segment: the offset that keeps a body on its pavement. */
  const enterSegment = (i: number, from: number, to: number) => {
    segAx[i] = graph.x[from];
    segAz[i] = graph.z[from];
    segAy[i] = graph.y[from];
    const bx = graph.x[to];
    const bz = graph.z[to];
    const dx = bx - segAx[i];
    const dz = bz - segAz[i];
    const len = Math.hypot(dx, dz) || 1;
    // Right-hand side of the direction of travel, so opposing streams pass
    // each other the way people do rather than walking through each other.
    const rx = dz / len;
    const rz = -dx / len;
    const room = Math.min(graph.width[from], graph.width[to]) * 0.5 - 0.55;
    let lat = Math.max(0, room) * (0.35 + (i % 5) * 0.13);
    // Probe: three points along the offset line. If any of them is not
    // pavement, halve the offset and try again, down to the centreline —
    // which is a node-to-node line and known good.
    for (let attempt = 0; attempt < 3 && lat > 0.05; attempt++) {
      let good = true;
      for (let s = 0; s <= 2; s++) {
        const t = s / 2;
        const kind = surfaceAt(
          segAx[i] + dx * t + rx * lat,
          segAz[i] + dz * t + rz * lat,
        ).kind;
        if (kind === "lot" || kind === "void" || kind === "parapet") {
          good = false;
          break;
        }
      }
      if (good) break;
      lat *= 0.45;
    }
    if (lat <= 0.05) lat = 0;
    segTx[i] = bx + rx * lat;
    segTz[i] = bz + rz * lat;
    segTy[i] = graph.y[to];
    segAx[i] += rx * lat;
    segAz[i] += rz * lat;
  };

  const arrive = (i: number) => {
    const kind = aDestKind[i];
    aphase[i] = aphase[i] % 1;
    switch (kind) {
      case D_RIM:
        aState[i] = ST_LEAN;
        aTimer[i] = rng.range(40, 110);
        break;
      case D_SIT:
        aState[i] = ST_SIT;
        aTimer[i] = rng.range(40, 110);
        break;
      case D_BENCH:
        aState[i] = ST_SIT;
        // Longer than a kerb, because a bench is more comfortable than a kerb.
        aTimer[i] = rng.range(55, 140);
        break;
      case D_LANDMARK:
        aState[i] = ST_STAND;
        aTimer[i] = rng.range(20, 55);
        aLookT[i] = rng.range(1.5, 4);
        break;
      case D_TRAM:
        aState[i] = ST_STAND;
        aTimer[i] = rng.range(25, 70);
        break;
      case D_DOOR:
        aState[i] = ST_STAND;
        aTimer[i] = rng.range(14, 40);
        break;
      default:
        aState[i] = ST_STAND;
        aTimer[i] = rng.range(12, 34);
        break;
    }
    /* A group stops for longer than one person does, because the reason a
       group has stopped is usually each other. */
    if (aGroup[i] !== G_ALONE) aTimer[i] *= 1.45;

    /* Onto the bench, exactly.
     *
     * `reachEnd` has already walked the last few metres off the graph and
     * slowed down doing it, so this is a snap of at most sixteen centimetres
     * at a walking pace of about a third of a metre a second — which is
     * nothing to look at, and is the difference between sitting *on* a bench
     * and sitting a hand's breadth to one side of it. The yaw is deliberately
     * not snapped: `aFaceX/Z` is the bench's own facing and the turn that
     * follows reads as somebody settling. */
    if (kind === D_BENCH && aSeat[i] >= 0) {
      const s = aSeat[i];
      ax[i] = seatX[s];
      az[i] = seatZ[s];
      ay[i] = seatY[s];
      segAx[i] = seatX[s];
      segAz[i] = seatZ[s];
      segAy[i] = seatY[s];
      segTx[i] = seatX[s];
      segTz[i] = seatZ[s];
      segTy[i] = seatY[s];
      avx[i] = 0;
      avz[i] = 0;
    }
  };

  /**
   * The end of the walk, which for a bench is not the end of the path.
   *
   * Every other destination here is a nav node and a body stops on it. A
   * bench is a metre or so off the pavement centreline and up to seven metres
   * along it from the nearest node, so arriving at the node and sitting down
   * puts somebody on the pavement near a bench — which is exactly what this
   * system did before there were any. So a bench gets one extra leg, walked
   * off the graph, decelerating into the seat.
   */
  const reachEnd = (i: number) => {
    if (aDestKind[i] === D_BENCH && aSeat[i] >= 0 && !aFinal[i]) {
      const s = aSeat[i];
      const dx = seatX[s] - ax[i];
      const dz = seatZ[s] - az[i];
      if (dx * dx + dz * dz > 0.16 * 0.16) {
        aFinal[i] = 1;
        aState[i] = ST_WALK;
        segAx[i] = ax[i];
        segAz[i] = az[i];
        segAy[i] = ay[i];
        segTx[i] = seatX[s];
        segTz[i] = seatZ[s];
        segTy[i] = seatY[s];
        return;
      }
    }
    aFinal[i] = 0;
    arrive(i);
  };

  const runPath = (i: number) => {
    aFinal[i] = 0;
    const goal = aDestNode[i];
    if (goal < 0) {
      aState[i] = ST_WAIT;
      aTimer[i] = 0.5;
      return;
    }
    const from = nearestNode(ax[i], az[i], 26);
    if (from < 0) {
      // Off the graph entirely — put them back on it and try again next time.
      const any = Math.floor(rng.next() * graph.n);
      ax[i] = graph.x[any];
      az[i] = graph.z[any];
      ay[i] = graph.y[any];
      aState[i] = ST_WAIT;
      aTimer[i] = 0.2;
      return;
    }
    if (from === goal) {
      pathLen[i] = 0;
      pathIdx[i] = 0;
      reachEnd(i);
      return;
    }

    generation++;
    const gen = generation;
    const gx = graph.x[goal];
    const gz = graph.z[goal];
    let heap = 0;
    stamp[from] = gen;
    closed[from] = 0;
    gScore[from] = 0;
    cameFrom[from] = -1;
    fScore[from] = Math.hypot(gx - graph.x[from], gz - graph.z[from]);
    heap = heapPush(heap, from, fScore[from]);

    let found = false;
    let guard = 0;
    while (heap > 0 && guard++ < 24000) {
      const cur = heapId[0];
      heap = heapPop(heap);
      if (stamp[cur] !== gen || closed[cur]) continue;
      closed[cur] = 1;
      if (cur === goal) {
        found = true;
        break;
      }
      const cx = graph.x[cur];
      const cz = graph.z[cur];
      const g = gScore[cur];
      for (let e = graph.start[cur]; e < graph.start[cur + 1]; e++) {
        const nb = graph.list[e];
        if (nb === cur) continue;
        const step = Math.hypot(graph.x[nb] - cx, graph.z[nb] - cz);
        const tentative = g + step;
        if (stamp[nb] === gen && (closed[nb] || gScore[nb] <= tentative)) continue;
        stamp[nb] = gen;
        closed[nb] = 0;
        gScore[nb] = tentative;
        cameFrom[nb] = cur;
        heap = heapPush(heap, nb, tentative + Math.hypot(gx - graph.x[nb], gz - graph.z[nb]));
      }
    }

    if (!found) {
      aDestNode[i] = -1;
      aState[i] = ST_WAIT;
      aTimer[i] = 0.4;
      return;
    }

    let count = 0;
    for (let cur = goal; cur >= 0 && count < graph.n; cur = cameFrom[cur]) {
      trace[count++] = cur;
      if (cur === from) break;
    }
    // `trace` runs goal → here; the body walks it the other way, and a trip
    // longer than the slice is walked in stages with the destination kept.
    const take = Math.min(count - 1, MAX_PATH);
    const base = i * MAX_PATH;
    for (let k = 0; k < take; k++) path[base + k] = trace[count - 2 - k];
    pathLen[i] = take;
    pathIdx[i] = 0;
    if (take === 0) {
      reachEnd(i);
      return;
    }
    aState[i] = ST_WALK;
    enterSegment(i, from, path[base]);
  };

  /* -----------------------------------------------------------------------
   * Following
   * -------------------------------------------------------------------- */

  /** The first follower of a group, or -1. Groups are contiguous. */
  const firstFollower = (i: number): number =>
    i + 1 < MAX && aLead[i + 1] === i ? i + 1 : -1;

  /**
   * One member of a group, moving because somebody else decided to.
   *
   * A follower has no path, no destination and no A* — it walks where its
   * leader walked, `aLagI` samples back down the leader's own trail, offset
   * sideways by as much as `clearanceAt` says the pavement there can spare.
   * Every point on that trail is ground the leader has already stood on, so a
   * follower cannot be pushed into a wall by a corner, a crossing or a crowd,
   * and cannot take a different turning at a junction because it is never
   * asked to choose one.
   *
   * When the leader stops, the trail stops growing, so the followers close up
   * into a ring around them instead — which is what a group waiting at a
   * kerb looks like — and turn to face whoever they came with.
   */
  const follow = (i: number, lead: number, dt: number, shoveX: number, shoveZ: number) => {
    const leadState = aState[lead];
    const walking = leadState === ST_WALK || leadState === ST_WAIT;

    /* Somebody on their parent's shoulders is not on the pavement at all.
       The seat is computed here rather than in the shader because only this
       side knows how tall the parent is: their shoulder, less the child's own
       hip, is exactly where the child's origin has to be. */
    if (aRole[i] === R_RIDER) {
      ax[i] = ax[lead];
      az[i] = az[lead];
      ay[i] = ay[lead] + 1.44 * aHeight[lead] - 0.90 * aHeight[i];
      ayaw[i] = ayaw[lead];
      avx[i] = 0;
      avz[i] = 0;
      agait[i] += (0 - agait[i]) * Math.min(1, dt * 5);
      agesture[i] += (0.5 - agesture[i]) * Math.min(1, dt * 2);
      aState[i] = ST_STAND;
      aRide[i] = 1;
      return;
    }

    /* What the leader is doing, this body's version of it. A child does not
       lean over a parapet with six hundred metres under it; it stands next to
       the adult who is. */
    if (leadState === ST_SIT) aState[i] = ST_SIT;
    else if (leadState === ST_LEAN) aState[i] = aKid[i] > 0.5 ? ST_STAND : ST_LEAN;
    else if (leadState === ST_WALK || leadState === ST_WAIT) aState[i] = ST_WALK;
    else aState[i] = ST_STAND;

    const row = aTrail[lead];
    let tx = ax[lead];
    let tz = az[lead];
    let ty = ay[lead];
    const perpX = Math.cos(ayaw[lead]);
    const perpZ = -Math.sin(ayaw[lead]);
    /* The other end of the bench, when the leader booked one for them. Not
       the ring the other followers fall into: this is a named place with a
       body's width to it, and the point of it is that it is exactly beside
       the person they came with rather than somewhere near them. */
    const seat = leadState === ST_SIT ? aSeat[i] : -1;
    if (seat >= 0) {
      tx = seatX[seat];
      tz = seatZ[seat];
      ty = seatY[seat];
    } else if (walking && row >= 0 && trFill[row] > 1) {
      const k = trailAt(row, aLagI[i]);
      tx = trX[k];
      ty = trY[k];
      tz = trZ[k];
      // As far out as there is room for, and no further. On a 3.5 m lane
      // between two shopfronts a family closes up into single file on its own.
      const room = Math.min(aSlotOff[i], Math.max(0, clearanceAt(tx, tz) - 0.30));
      tx += perpX * room * aSlotSide[i];
      tz += perpZ * room * aSlotSide[i];
    } else {
      const room = Math.min(
        aSlotOff[i] + 0.34,
        Math.max(0.3, clearanceAt(ax[lead], az[lead]) - 0.30),
      );
      const ang = ayaw[lead] + aSlotAng[i];
      tx = ax[lead] + Math.sin(ang) * room;
      tz = az[lead] + Math.cos(ang) * room;
    }

    /* Dawdling, which is the entire read.
     *
     * A child that keeps station perfectly is a small adult on a rail. One
     * that stops dead every ten seconds or so to look at something and then
     * runs to catch up is a child from thirty metres away, and it costs two
     * floats and no thinking. */
    if (aKid[i] > 0.5) {
      if (aTimer[i] > 0) {
        aTimer[i] -= dt;
        if (aTimer[i] <= 0) aChase[i] = 1;
      } else if (walking) {
        aDawdle[i] -= dt;
        if (aDawdle[i] <= 0) {
          aTimer[i] = rng.range(0.5, 1.5);
          aLookT[i] = Math.max(aLookT[i], aTimer[i] * 0.8);
          aDawdle[i] = rng.range(7, 26);
        }
      }
    }

    const dx = tx - ax[i];
    const dz = tz - az[i];
    const d = Math.hypot(dx, dz);
    if (aChase[i] > 0 && d < 0.5) aChase[i] = 0;
    /* Still on their feet until they are actually at the bench. Copying the
       leader's sit the moment the leader sits slides a seated body across
       three metres of pavement, which is a thing you cannot un-see. */
    if (seat >= 0 && d > 0.4) aState[i] = ST_WALK;

    /* `aTimer` on a follower is the dawdle clock and nothing else — only a
       child ever sets it, and only a child is ever held by it. Reading it on
       an adult froze every companion in the city where it was standing when
       the world booted, for as long as the timer it was given at build:
       still walking on the spot, still facing the right way, and quietly a
       hundred metres from the person they arrived with. */
    const held = aKid[i] > 0.5 && aTimer[i] > 0;
    let speed = 0;
    if (!held) {
      const base = walking ? aspeed[lead] : 0.85;
      // Fast enough to close a gap, and only while there is a gap to close.
      speed = Math.min(base * (aChase[i] > 0 ? 1.75 : 1.12), d * 2.7);
    }
    const wantX = d > 1e-4 ? (dx / d) * speed + shoveX * 0.5 : shoveX * 0.5;
    const wantZ = d > 1e-4 ? (dz / d) * speed + shoveZ * 0.5 : shoveZ * 0.5;
    const k = Math.min(1, dt * 6);
    avx[i] += (wantX - avx[i]) * k;
    avz[i] += (wantZ - avz[i]) * k;
    ax[i] += avx[i] * dt;
    az[i] += avz[i] * dt;
    ay[i] += (ty - ay[i]) * Math.min(1, dt * 7);

    const moved = Math.hypot(avx[i], avz[i]);
    agait[i] += (Math.min(1.3, moved / 1.3) - agait[i]) * Math.min(1, dt * 6);
    aphase[i] += (moved * dt) / (1.35 * aHeight[i]);
    if (aphase[i] > 1) aphase[i] -= Math.floor(aphase[i]);

    let faceX = 0;
    let faceZ = 0;
    if (moved > 0.18) {
      faceX = avx[i];
      faceZ = avz[i];
    } else if (seat >= 0 && aState[i] === ST_SIT) {
      /* Sitting on a bench faces the way the bench faces. Turning to the
         person next to you is the right instinct on a kerb and is wrong here:
         it swings a seated body ninety degrees and puts its legs through the
         slats. */
      faceX = seatFx[seat];
      faceZ = seatFz[seat];
    } else {
      // Stopped, so look at whoever you are with rather than at the street.
      faceX = ax[lead] - ax[i];
      faceZ = az[lead] - az[i];
      const md = Math.hypot(faceX, faceZ);
      if (md > 0.25 && md < 4.5) {
        agesture[i] = 0.45 + 0.4 * Math.sin(clock * 0.7 + i);
      } else {
        faceX = 0;
        faceZ = 0;
      }
    }
    if (faceX !== 0 || faceZ !== 0) {
      // Same convention as everywhere else here: yaw 0 faces -Z.
      const want = Math.atan2(-faceX, -faceZ);
      let diff = want - ayaw[i];
      while (diff > Math.PI) diff -= TAU;
      while (diff < -Math.PI) diff += TAU;
      ayaw[i] += diff * Math.min(1, dt * (moved > 0.18 ? 6 : 2.6));
    }
    if (moved > 0.18) agesture[i] += (0 - agesture[i]) * Math.min(1, dt * 3);
  };

  /* -----------------------------------------------------------------------
   * Frame
   * -------------------------------------------------------------------- */

  let liveCount = 0;
  let sitCount = 0;
  let leanCount = 0;
  let clock = 0;
  /** How much the hour wants families and couples on the street. */
  let familyBias = 1;
  let coupleBias = 1;
  /** How many of each sort of group the hour wants out, and how many are. */
  const classTarget = new Float32Array(CLASS_N);
  const classLive = new Int32Array(CLASS_N);
  const classNow = new Int32Array(CLASS_N);
  const classW = new Float32Array(CLASS_N);
  const classCap = new Uint8Array(CLASS_N);

  /** Mutated in place every frame — never rebuilt. See `Census`. */
  const census: Census = {
    people: 0,
    children: 0,
    groups: 0,
    families: 0,
    couples: 0,
    sitting: 0,
    leaning: 0,
    standing: 0,
    benched: 0,
    dogs: 0,
    robots: 0,
    prams: 0,
  };

  const update = (ctx: FrameContext) => {
    const dt = ctx.dt;
    clock += dt;
    daylight = ctx.daylight;
    uniforms.uTime.value = ctx.time;
    (uniforms.uSun.value as THREE.Vector3).copy(ctx.sunDir);
    /* The whole crowd warms and cools with the sky, which is most of why they
       sit inside the picture rather than on top of it.
     *
     * `gradeDaylight`, not `daylight` — see the note on both in types.ts.
     * `daylight` is the lamp switch and reads 0.32 at the hour this world
     * exists for, so shading with it took a third of the light off every
     * pedestrian at exactly the sunset they are meant to be standing in. The
     * sky dome is at its brightest then; the people should be too. */
    const warm = 0.35 + ctx.gradeDaylight * 0.9;
    (uniforms.uSunCol.value as THREE.Color).setRGB(1.42 * warm, 1.02 * warm, 0.74 * warm);
    (uniforms.uSkyCol.value as THREE.Color).setRGB(
      0.12 + ctx.gradeDaylight * 0.20,
      0.12 + ctx.gradeDaylight * 0.18,
      0.20 + ctx.gradeDaylight * 0.22,
    );

    /* ---- how many people are out ---------------------------------------- */
    /* The tier cut is applied once. `MAX` is already the low-tier population
       when the world was *built* low; this only bites when the frame context
       drops to low afterwards. Multiplying both is how a phone ends up with
       forty people on a whole island. */
    const cap = ctx.quality === "low" ? Math.min(MAX, POP.low) : MAX;
    const target = Math.round(cap * (0.74 + 0.26 * daylight));
    sitTarget = target * 0.085;
    leanTarget = target * (0.03 + 0.06 * daylight);

    /* Who is out, and when.
     *
     * The city has always thinned with the light. This is the other half of
     * it: *which* people. Families are an afternoon and early-evening thing
     * and are indoors by the small hours; couples are a dusk thing and are
     * the last ones on the rim. Both are one multiplier on the chance of
     * stepping back out of a door, which is the only lever there is — the
     * population is fixed at build and recycled, never respawned. */
    const afternoon = dayBump(ctx.dayPhase, 0.62, 0.19);
    const dusk = dayBump(ctx.dayPhase, 0.80, 0.11);
    familyBias = 0.3 + 2.0 * afternoon * (0.3 + 0.7 * daylight);
    coupleBias = 0.55 + 1.6 * dusk + 0.35 * daylight;
    /* Split the headcount the hour allows between the three sorts of group,
       rather than biasing a lottery — because the lottery does not work. The
       population reaches `target`, the gate that lets anybody back out of a
       door shuts, and whatever mix happened to get out first is the mix the
       city keeps for ever: measured, families were within half a per cent of
       the same share of the street at four in the afternoon and four in the
       morning. The shares below sum to `target`, so the crowd still thins
       with the light by exactly as much as it did before; only who moves.

       The clamping matters. A share is allowed to exceed the number of
       people who are *in* that sort of group — at the afternoon's weight the
       families' share comes out at 314 of a population that only contains
       190 of them — and an uncapped target that can never be met holds the
       whole street a hundred and fifty people below its headcount at the
       brightest hour of the day. Two or three passes settle it. */
    classW[0] = classBuilt[0];
    classW[1] = classBuilt[1] * coupleBias;
    classW[2] = classBuilt[2] * familyBias;
    classCap.fill(0);
    for (let pass = 0; pass < CLASS_N; pass++) {
      let ws = 0;
      let used = 0;
      for (let c = 0; c < CLASS_N; c++) {
        if (classCap[c]) used += classTarget[c];
        else ws += classW[c];
      }
      if (ws <= 0) break;
      const remain = Math.max(0, target - used);
      let clamped = false;
      for (let c = 0; c < CLASS_N; c++) {
        if (classCap[c]) continue;
        const want = (remain * classW[c]) / ws;
        if (want >= classBuilt[c]) {
          classTarget[c] = classBuilt[c];
          classCap[c] = 1;
          clamped = true;
        } else {
          classTarget[c] = want;
        }
      }
      if (!clamped) break;
    }

    const cam = ctx.camera.position;
    const px = ctx.player.position;
    const overhead = ctx.player.altitude > 7 && ctx.player.altitude < 140;

    /* ---- rebuild the body index ----------------------------------------- */
    bodyCell.fill(-1);
    for (let i = 0; i < MAX; i++) {
      if (!aActive[i]) continue;
      const cx = Math.min(GRID_N - 1, Math.max(0, ((ax[i] - GRID_ORIGIN) / CELL) | 0));
      const cz = Math.min(GRID_N - 1, Math.max(0, ((az[i] - GRID_ORIGIN) / CELL) | 0));
      const c = cz * GRID_N + cx;
      bodyNext[i] = bodyCell[c];
      bodyCell[c] = i;
    }

    for (const tier of tiers) tier.n = 0;
    for (const kit of kits) kit.n = 0;
    census.dogs = 0;
    census.robots = 0;
    census.prams = 0;
    // Decisions this frame read *last* frame's headcount, so an early-indexed
    // body is not comparing a target against a total that is still being
    // counted.
    const crowded = liveCount;
    let live = 0;
    let nowSit = 0;
    let nowBench = 0;
    let nowLean = 0;
    let nowStand = 0;
    let nowKids = 0;
    let nowGroups = 0;
    let nowFamilies = 0;
    let nowCouples = 0;

    /* ---- everybody ------------------------------------------------------ */
    for (let i = 0; i < MAX; i++) {
      const lead = aLead[i];
      if (lead !== i) {
        /* Whoever you came with went in with you and comes out with you.
           The leader is always the lower index, so this is already settled
           for this frame by the time anybody reads it. */
        aActive[i] = aActive[lead];
      } else if (!aActive[i]) {
        // Inside somewhere. Come back out when the street wants more people
        // of this sort — which is what makes six in the evening full of
        // families and four in the morning not.
        const c = classOf(i);
        if (crowded < target && classLive[c] < classTarget[c] && rng.chance(dt * 0.25)) {
          aActive[i] = 1;
          aState[i] = ST_WAIT;
          aTimer[i] = 0;
        }
      }
      if (!aActive[i]) continue;
      live++;
      classNow[classOf(i)]++;
      const liveState = aState[i];
      if (liveState === ST_SIT) {
        nowSit++;
        if (aSeat[i] >= 0) nowBench++;
      } else if (liveState === ST_LEAN) nowLean++;
      else if (liveState !== ST_WALK) nowStand++;
      if (aKid[i] > 0.5) nowKids++;
      if (lead === i && aGroup[i] !== G_ALONE) {
        nowGroups++;
        if (aGroup[i] === G_FAMILY) nowFamilies++;
        else if (aGroup[i] === G_COUPLE) nowCouples++;
      }

      const state = liveState;
      // A follower's timer is its own — the dawdle clock — and `follow` runs
      // it. Decrementing it here as well halves every child's attention span.
      if (lead === i) aTimer[i] -= dt;

      /* -- the player ---------------------------------------------------- */
      const pdx = ax[i] - px.x;
      const pdz = az[i] - px.z;
      const pd2 = pdx * pdx + pdz * pdz;
      if (overhead && pd2 < 26 * 26) {
        aLookT[i] = Math.max(aLookT[i], 0.9);
      }
      let shoveX = 0;
      let shoveZ = 0;
      if (pd2 < 30 && Math.abs(px.y - ay[i]) < 14) {
        // Somebody is landing on you. Get out of the way, and watch them.
        const d = Math.sqrt(pd2) || 0.001;
        const push = (5.5 - d) / 5.5;
        shoveX += (pdx / d) * push * 5.5;
        shoveZ += (pdz / d) * push * 5.5;
        if (ctx.player.burn > 0.12 || !ctx.player.grounded) aLookT[i] = Math.max(aLookT[i], 1.4);
      }

      /* -- separation ---------------------------------------------------- */
      const cx = Math.min(GRID_N - 1, Math.max(0, ((ax[i] - GRID_ORIGIN) / CELL) | 0));
      const cz = Math.min(GRID_N - 1, Math.max(0, ((az[i] - GRID_ORIGIN) / CELL) | 0));
      let looked = 0;
      for (let oz = -1; oz <= 1; oz++) {
        const rz = cz + oz;
        if (rz < 0 || rz >= GRID_N) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const rx = cx + ox;
          if (rx < 0 || rx >= GRID_N) continue;
          for (let j = bodyCell[rz * GRID_N + rx]; j >= 0 && looked < 10; j = bodyNext[j]) {
            if (j === i) continue;
            /* Not from your own group. The slots already hold them apart at
               the distance they are meant to be apart, and a separation force
               on top of that is two systems fighting over the same metre —
               which presents as a family that vibrates. */
            if (aLead[j] === lead) continue;
            looked++;
            const dx = ax[i] - ax[j];
            const dz = az[i] - az[j];
            const q = dx * dx + dz * dz;
            if (q > 1.5 * 1.5 || q < 1e-6) continue;
            const d = Math.sqrt(q);
            const push = (1.5 - d) / 1.5;
            shoveX += (dx / d) * push * 1.4;
            shoveZ += (dz / d) * push * 1.4;
          }
        }
      }

      /* -- states -------------------------------------------------------- */
      if (lead !== i) {
        follow(i, lead, dt, shoveX, shoveZ);
      } else if (state === ST_WALK) {
        const base = i * MAX_PATH;
        const tx = segTx[i];
        const tz = segTz[i];
        const dx = tx - ax[i];
        const dz = tz - az[i];
        const d = Math.hypot(dx, dz);
        // The last leg onto a bench is walked to the seat and not to a node,
        // so it ends when the body is *on* it rather than a stride short.
        if (d < (aFinal[i] ? 0.16 : 1.05)) {
          if (aFinal[i]) {
            aFinal[i] = 0;
            arrive(i);
          } else {
          pathIdx[i]++;
          if (pathIdx[i] >= pathLen[i]) {
            const goal = aDestNode[i];
            const at = pathLen[i] > 0 ? path[base + pathLen[i] - 1] : -1;
            if (goal >= 0 && at >= 0 && at !== goal) {
              requestPath(i); // a long trip, walked in stages
              aState[i] = ST_WAIT;
              aTimer[i] = 0.1;
            } else {
              reachEnd(i);
            }
          } else {
            enterSegment(i, path[base + pathIdx[i] - 1], path[base + pathIdx[i]]);
            // Something in a window. Two seconds of somebody stopped on a
            // pavement is worth more than two more people walking down it.
            if (rng.chance(0.035)) {
              aState[i] = ST_PAUSE;
              aTimer[i] = rng.range(2.5, 8);
            }
          }
          }
        } else {
          /* Slowing into a seat. Full pace right up to the bench overshoots
             it and then orbits it — the steering has no brake of its own —
             and the snap `arrive` finishes with is only invisible because
             this makes it small and slow. */
          const speed = aFinal[i] ? Math.max(0.35, Math.min(aspeed[i], d * 1.6)) : aspeed[i];
          const wantX = (dx / d) * speed + shoveX;
          const wantZ = (dz / d) * speed + shoveZ;
          const k = Math.min(1, dt * 5.5);
          avx[i] += (wantX - avx[i]) * k;
          avz[i] += (wantZ - avz[i]) * k;
          ax[i] += avx[i] * dt;
          az[i] += avz[i] * dt;
          const moved = Math.hypot(avx[i], avz[i]);
          agait[i] += (Math.min(1.25, moved / 1.4) - agait[i]) * Math.min(1, dt * 6);
          aphase[i] += (moved * dt) / (1.35 * aHeight[i]);
          if (aphase[i] > 1) aphase[i] -= Math.floor(aphase[i]);
          if (moved > 0.05) {
            const want = Math.atan2(-avx[i], -avz[i]);
            let diff = want - ayaw[i];
            while (diff > Math.PI) diff -= TAU;
            while (diff < -Math.PI) diff += TAU;
            ayaw[i] += diff * Math.min(1, dt * 6);
          }
          // Height follows the segment, so a kerb at a crossing is a step and
          // not a hover.
          const prog = 1 - Math.min(1, d / (Math.hypot(segTx[i] - segAx[i], segTz[i] - segAz[i]) || 1));
          const wantY = segAy[i] + (segTy[i] - segAy[i]) * prog;
          ay[i] += (wantY - ay[i]) * Math.min(1, dt * 7);
        }
      } else {
        // Standing, sitting, leaning, or waiting for a path.
        /* Anchored to the spot they arrived on, which is a point `surfaceAt`
           has already agreed is pavement. Without the spring a knot of people
           outside a busy door shoves itself into a flowerbed over a minute.
           Somebody paused mid-walk has no such spot yet — they are between two
           nodes — so they only get shoved. */
        if (state === ST_PAUSE) {
          ax[i] += shoveX * dt * 0.5;
          az[i] += shoveZ * dt * 0.5;
        } else {
          const homeX = segTx[i] - ax[i];
          const homeZ = segTz[i] - az[i];
          ax[i] += (shoveX * 0.35 + homeX * 1.9) * dt;
          az[i] += (shoveZ * 0.35 + homeZ * 1.9) * dt;
        }
        agait[i] += (0 - agait[i]) * Math.min(1, dt * 5);
        avx[i] *= 1 - Math.min(1, dt * 6);
        avz[i] *= 1 - Math.min(1, dt * 6);

        let fx = state === ST_PAUSE ? segTx[i] - ax[i] : aFaceX[i];
        let fz = state === ST_PAUSE ? segTz[i] - az[i] : aFaceZ[i];
        /* Turn to whoever you came with. Two people stopped on a pavement
           facing each other is the strongest "somebody lives here" signal
           available, and it costs one array read: a group is contiguous, so
           the first follower is the very next index. */
        const with1 = firstFollower(i);
        if (aSeatH[i] > 0) {
          /* …unless you are on a bench, in which case you are facing the way
             the bench faces and so is whoever is next to you. */
          agesture[i] = 0.35 + 0.3 * Math.sin(clock * 0.55 + i);
        } else if (with1 >= 0 && aActive[with1] && aRole[with1] !== R_RIDER) {
          const mx = ax[with1] - ax[i];
          const mz = az[with1] - az[i];
          const md = Math.hypot(mx, mz);
          if (md > 0.35 && md < 4.5) {
            fx = mx / md;
            fz = mz / md;
            agesture[i] = 0.55 + 0.45 * Math.sin(clock * 0.6 + i);
          }
        } else {
          agesture[i] += (0 - agesture[i]) * Math.min(1, dt * 3);
        }
        if (fx !== 0 || fz !== 0) {
          const want = Math.atan2(-fx, -fz);
          let diff = want - ayaw[i];
          while (diff > Math.PI) diff -= TAU;
          while (diff < -Math.PI) diff += TAU;
          ayaw[i] += diff * Math.min(1, dt * 2.5);
        }

        if (aTimer[i] <= 0) {
          if (state === ST_PAUSE) {
            aState[i] = ST_WALK; // carry on; the path was never dropped
          } else if (state === ST_WAIT) {
            if (aDestNode[i] < 0) pickDestination(i);
            else requestPath(i);
            aTimer[i] = 1.5;
          } else {
            /* Done here. Some of them step inside instead of walking on —
               and a group steps inside together, because `aActive` is
               mirrored down the group at the top of the loop. A family is
               readier to go in the further the afternoon is behind it. */
            const c = classOf(i);
            /* Going home, which is a different thing from stepping into a
               shop: it happens from wherever they are and it happens because
               the hour has moved on from the sort of evening this group is
               having. Tying it to a door as well made the mix take twenty
               minutes of world time to turn over, which is longer than
               anybody looks at a street. */
            const home = classLive[c] > classTarget[c] + 2;
            const atDoor = aDestKind[i] === D_DOOR && crowded > target;
            if ((atDoor || home) && rng.chance(home ? 0.7 : 0.5)) {
              aActive[i] = 0;
              aDestNode[i] = -1;
              // The other route out of a destination, and the one that leaks
              // a booking if it is forgotten: they go indoors still holding
              // a bench and nobody can ever sit on it again.
              releaseGroupSeats(i);
              aFinal[i] = 0;
              continue;
            }
            pickDestination(i);
            aState[i] = ST_WAIT;
            aTimer[i] = 1.2;
          }
        }
      }

      /* -- the leader's trail -------------------------------------------- */
      /* Sampled by distance, so a slot is a fixed distance back however fast
         this body is going, and the trail simply stops growing when it stops
         rather than collapsing to a point under its followers' feet. */
      const trow = aTrail[i];
      if (trow >= 0) {
        const tdx = ax[i] - trLastX[trow];
        const tdz = az[i] - trLastZ[trow];
        if (tdx * tdx + tdz * tdz >= TRAIL_STEP * TRAIL_STEP) {
          const h = (trHead[trow] + 1) % TRAIL_N;
          trHead[trow] = h;
          trX[trow * TRAIL_N + h] = ax[i];
          trY[trow * TRAIL_N + h] = ay[i];
          trZ[trow * TRAIL_N + h] = az[i];
          trLastX[trow] = ax[i];
          trLastZ[trow] = az[i];
          if (trFill[trow] < TRAIL_N) trFill[trow]++;
        }
      }

      /* -- pose blending ------------------------------------------------- */
      const toSit = aState[i] === ST_SIT ? 1 : 0;
      /* Held past the decision to get up, and released only once the pose has
         actually unfolded — see the note on `aSeatH`. */
      if (toSit) aSeatH[i] = aSeat[i] >= 0 ? SEAT_H : 0;
      else if (aSit[i] < 0.02) aSeatH[i] = 0;
      const toLean = aState[i] === ST_LEAN ? 1 : 0;
      if (aLookT[i] > 0) aLookT[i] -= dt;
      const wantLook = aLookT[i] > 0 ? 1 : 0;
      const blend = Math.min(1, dt * 3.2);
      aSit[i] += (toSit - aSit[i]) * blend;
      aLean[i] += (toLean - aLean[i]) * blend;
      aLook[i] += (wantLook - aLook[i]) * blend;

      /* -- draw ---------------------------------------------------------- */
      const camdx = ax[i] - cam.x;
      const camdy = ay[i] - cam.y;
      const camdz = az[i] - cam.z;
      const camd2 = camdx * camdx + camdy * camdy + camdz * camdz;
      if (camd2 > LOD_FAR * LOD_FAR) continue;
      if (camd2 < LOD_NEAR * LOD_NEAR) writeInstance(tiers[0], i);
      else if (camd2 < LOD_MID * LOD_MID) writeInstance(tiers[1], i);
      else writeInstance(tiers[2], i);
    }

    /* ---- dogs ------------------------------------------------------------
     *
     * A dog walks its owner's trail one sample back with a weave across it
     * and a stop to smell something every ten or twenty seconds, and it is
     * quicker than they are, which is the whole of why it reads as a dog:
     * it is always either ahead and waiting or behind and hurrying, and never
     * once in step. The lead is drawn to the hand, so the two of them are
     * visibly one thing even at the far end of a street.
     */
    const dogsOut = Math.round(NDOG * (0.5 + 0.5 * daylight));
    for (let d = 0; d < NDOG; d++) {
      const o = dgOwner[d];
      if (d >= dogsOut || !aActive[o]) {
        // Parked on their owner, so the pair come back out of a door together.
        dgX[d] = ax[o];
        dgY[d] = ay[o];
        dgZ[d] = az[o];
        continue;
      }
      census.dogs++;

      if (dgSniff[d] < 0) {
        dgSniff[d] += dt;
        if (dgSniff[d] >= 0) dgSniff[d] = rng.range(7, 24);
      } else {
        dgSniff[d] -= dt;
        if (dgSniff[d] <= 0) dgSniff[d] = -rng.range(0.9, 2.4);
      }

      const row = aTrail[o];
      const walking = aState[o] === ST_WALK || aState[o] === ST_WAIT;
      let tx = ax[o];
      let tz = az[o];
      let ty = ay[o];
      if (walking && row >= 0 && trFill[row] > 1) {
        const k = trailAt(row, 1);
        tx = trX[k];
        ty = trY[k];
        tz = trZ[k];
      }
      // Off to the owner's right — the hand the lead is in — and weaving.
      const wob = -0.44 + Math.sin(clock * 1.7 + dgWeave[d] * TAU) * 0.5;
      const room = Math.max(0, clearanceAt(tx, tz) - 0.35);
      const off = Math.max(-room, Math.min(room, wob));
      tx += Math.cos(ayaw[o]) * off;
      tz += -Math.sin(ayaw[o]) * off;

      const dx = tx - dgX[d];
      const dz = tz - dgZ[d];
      const dd = Math.hypot(dx, dz);
      // A lead is a metre and a half; past that it is being pulled taut.
      const speed = dgSniff[d] < 0 && dd < 1.6 ? 0 : Math.min(2.9, dd * 3.2);
      if (dd > 1e-4 && speed > 0) {
        dgX[d] += (dx / dd) * speed * dt;
        dgZ[d] += (dz / dd) * speed * dt;
        const want = Math.atan2(-dx / dd, -dz / dd);
        let diff = want - dgYaw[d];
        while (diff > Math.PI) diff -= TAU;
        while (diff < -Math.PI) diff += TAU;
        dgYaw[d] += diff * Math.min(1, dt * 7);
      }
      dgY[d] += (ty - dgY[d]) * Math.min(1, dt * 7);
      const trot = Math.min(1.2, speed / 1.6);
      dgGait[d] += (trot - dgGait[d]) * Math.min(1, dt * 7);
      dgPhase[d] += (speed * dt) / (0.55 * dgSize[d]);
      if (dgPhase[d] > 1) dgPhase[d] -= Math.floor(dgPhase[d]);

      const cdx = dgX[d] - cam.x;
      const cdy = dgY[d] - cam.y;
      const cdz = dgZ[d] - cam.z;
      if (cdx * cdx + cdy * cdy + cdz * cdz > LOD_KIT * LOD_KIT) continue;
      // The hand on the other end of the lead: the right arm, held forward.
      const hb = aBuild[o];
      const hlx = -0.245 * hb;
      const hlz = -0.27 * hb;
      const cy = Math.cos(ayaw[o]);
      const sy = Math.sin(ayaw[o]);
      const handX = ax[o] + hlx * cy + hlz * sy;
      const handZ = az[o] - hlx * sy + hlz * cy;
      const handY = ay[o] + 0.92 * aHeight[o];
      writeKit(
        dogMesh,
        dgX[d],
        dgY[d],
        dgZ[d],
        dgYaw[d],
        dgSize[d],
        dgPhase[d],
        dgGait[d],
        dgCol[d * 3],
        dgCol[d * 3 + 1],
        dgCol[d * 3 + 2],
        handX - dgX[d],
        handY - dgY[d],
        handZ - dgZ[d],
      );
    }

    /* ---- robots ----------------------------------------------------------
     *
     * Civic, and cheerful. A sweeper works the kerb at a crawl, a courier
     * rolls a parcel along the pavement and stops at doors, and a companion
     * bobs along after a family. None of them needs a path: the sweeper and
     * the courier random-walk the nav graph with a strong preference for
     * carrying straight on, which cannot leave the pavement because every
     * edge of that graph was checked when it was built.
     */
    for (let b = 0; b < NBOT; b++) {
      const mode = btMode[b];
      if (mode === 2) {
        const o = btOwner[b];
        // A small robot that follows a child is a daytime thing.
        if (!aActive[o] || daylight < 0.12) {
          btX[b] = ax[o];
          btY[b] = ay[o];
          btZ[b] = az[o];
          continue;
        }
        const row = aTrail[o];
        const walking = aState[o] === ST_WALK || aState[o] === ST_WAIT;
        let tx = ax[o];
        let tz = az[o];
        let ty = ay[o];
        if (walking && row >= 0 && trFill[row] > 1) {
          const k = trailAt(row, 4);
          tx = trX[k];
          ty = trY[k];
          tz = trZ[k];
        } else {
          /* Standing still, it goes and stands by the child rather than by
             the adult, which is the whole of the joke and costs one index:
             a group is contiguous, so the children are the next two slots. */
          const k1 = o + 1 < MAX && aLead[o + 1] === o ? o + 1 : -1;
          const k2 = o + 2 < MAX && aLead[o + 2] === o ? o + 2 : -1;
          // No closure here: this runs per companion per frame, and a helper
          // arrow declared inside `update` is an allocation sixty times a
          // second, which is the one thing this system may not do.
          const ok1 = k1 >= 0 && aKid[k1] > 0.5 && aRole[k1] !== R_RIDER;
          const ok2 = k2 >= 0 && aKid[k2] > 0.5 && aRole[k2] !== R_RIDER;
          const near = ok1 ? k1 : ok2 ? k2 : -1;
          if (near >= 0) {
            tx = ax[near];
            tz = az[near];
            ty = ay[near];
          }
        }
        const room = Math.max(0, clearanceAt(tx, tz) - 0.4);
        const off = Math.max(-room, Math.min(room, Math.sin(clock * 0.9 + btPhase[b] * TAU) * 0.6));
        tx += Math.cos(ayaw[o]) * off;
        tz += -Math.sin(ayaw[o]) * off;
        const dx = tx - btX[b];
        const dz = tz - btZ[b];
        const dd = Math.hypot(dx, dz);
        const speed = Math.min(2.4, dd * 2.6);
        if (dd > 1e-4) {
          btX[b] += (dx / dd) * speed * dt;
          btZ[b] += (dz / dd) * speed * dt;
          const want = Math.atan2(-dx / dd, -dz / dd);
          let diff = want - btYaw[b];
          while (diff > Math.PI) diff -= TAU;
          while (diff < -Math.PI) diff += TAU;
          btYaw[b] += diff * Math.min(1, dt * 4);
        }
        btY[b] += (ty - btY[b]) * Math.min(1, dt * 6);
      } else {
        if (btTimer[b] > 0) {
          btTimer[b] -= dt;
        } else {
          btT[b] += (btSpeed[b] * dt) / btLen[b];
          while (btT[b] >= 1) {
            btT[b] -= 1;
            const prev = btNode[b];
            btNode[b] = btNext[b];
            btNext[b] = pickNext(btNode[b], graph.x[prev], graph.z[prev], prev);
            btPrev[b] = prev;
            btLen[b] = Math.max(
              0.5,
              Math.hypot(
                graph.x[btNext[b]] - graph.x[btNode[b]],
                graph.z[btNext[b]] - graph.z[btNode[b]],
              ),
            );
            // A parcel arriving somewhere, or a stretch of kerb worth doing
            // twice. Both of them are a machine that is visibly working.
            if (rng.chance(mode === 1 ? 0.12 : 0.06)) {
              btTimer[b] = mode === 1 ? rng.range(3, 9) : rng.range(2, 5);
            }
          }
        }
        const nx = graph.x[btNode[b]];
        const nz = graph.z[btNode[b]];
        const mx = graph.x[btNext[b]];
        const mz = graph.z[btNext[b]];
        const ex = mx - nx;
        const ez = mz - nz;
        const el = Math.hypot(ex, ez) || 1;
        const t = btT[b];
        let px2 = nx + ex * t;
        let pz2 = nz + ez * t;
        // The sweeper hugs the edge of the pavement, which is where the grit
        // is; the courier keeps out of the middle of it.
        const want = mode === 0 ? 1.2 : 0.55;
        const room = Math.max(0, clearanceAt(px2, pz2) - 0.5);
        const off = Math.min(want, room) * btSide[b];
        px2 += (ez / el) * off;
        pz2 += (-ex / el) * off;
        btX[b] = px2;
        btZ[b] = pz2;
        btY[b] = graph.y[btNode[b]] + (graph.y[btNext[b]] - graph.y[btNode[b]]) * t;
        const wantYaw = Math.atan2(-ex / el, -ez / el);
        let diff = wantYaw - btYaw[b];
        while (diff > Math.PI) diff -= TAU;
        while (diff < -Math.PI) diff += TAU;
        btYaw[b] += diff * Math.min(1, dt * 3.5);
      }
      census.robots++;

      const cdx = btX[b] - cam.x;
      const cdz = btZ[b] - cam.z;
      const cdy = btY[b] - cam.y;
      if (cdx * cdx + cdy * cdy + cdz * cdz > LOD_KIT * LOD_KIT) continue;
      const hover = mode === 2 ? 0.30 + 0.055 * Math.sin(clock * 2.4 + btPhase[b] * TAU) : 0;
      writeKit(
        botMesh,
        btX[b],
        btY[b] + hover,
        btZ[b],
        btYaw[b],
        mode === 2 ? 0.56 : mode === 0 ? 1.02 : 0.92,
        btPhase[b],
        mode,
        btCol[b * 3],
        btCol[b * 3 + 1],
        btCol[b * 3 + 2],
        0,
        0,
        0,
      );
    }

    /* ---- prams -----------------------------------------------------------
     * Nothing decides anything here: a pram is exactly where the person
     * pushing it is, plus half a metre of forward. */
    for (let m = 0; m < NPRAM; m++) {
      const o = pmOwner[m];
      if (!aActive[o]) continue;
      census.prams++;
      const fx = -Math.sin(ayaw[o]);
      const fz = -Math.cos(ayaw[o]);
      const x = ax[o] + fx * 0.68;
      const z = az[o] + fz * 0.68;
      pmPhase[m] += Math.hypot(avx[o], avz[o]) * dt * 0.55;
      if (pmPhase[m] > 1) pmPhase[m] -= Math.floor(pmPhase[m]);
      const cdx = x - cam.x;
      const cdz = z - cam.z;
      const cdy = ay[o] - cam.y;
      if (cdx * cdx + cdy * cdy + cdz * cdz > LOD_KIT * LOD_KIT) continue;
      writeKit(
        pramMesh,
        x,
        ay[o],
        z,
        ayaw[o],
        1,
        pmPhase[m],
        0,
        pmCol[m * 3],
        pmCol[m * 3 + 1],
        pmCol[m * 3 + 2],
        0,
        0,
        0,
      );
    }

    liveCount = live;
    for (let c = 0; c < CLASS_N; c++) {
      classLive[c] = classNow[c];
      classNow[c] = 0;
    }
    sitCount = nowSit;
    leanCount = nowLean;
    census.people = live;
    census.children = nowKids;
    census.groups = nowGroups;
    census.families = nowFamilies;
    census.couples = nowCouples;
    census.sitting = nowSit;
    census.benched = nowBench;
    census.leaning = nowLean;
    census.standing = nowStand;

    /* ---- a few paths, and only a few ------------------------------------ */
    for (let k = 0; k < REPATH_BUDGET && repathCount > 0; k++) {
      const i = repathQueue[repathHead];
      repathHead = (repathHead + 1) % MAX;
      repathCount--;
      aQueued[i] = 0;
      if (!aActive[i]) continue;
      runPath(i);
    }

    /* ---- upload ---------------------------------------------------------- */
    for (const tier of tiers) {
      tier.geo.instanceCount = tier.n;
      if (tier.n === 0) continue;
      for (const attr of tier.attrs) attr.needsUpdate = true;
    }
    for (const kit of kits) {
      kit.geo.instanceCount = kit.n;
      if (kit.n === 0) continue;
      for (const attr of kit.attrs) attr.needsUpdate = true;
    }
  };

  return {
    name: "crowd",
    group,
    get count() {
      return liveCount;
    },
    census,
    nearest(x: number, z: number, maxDist: number) {
      let best = -1;
      let bestD = maxDist * maxDist;
      // Clamped, because a caller asking for the nearest body within a
      // kilometre would otherwise sweep a quarter of a million empty cells.
      const rings = Math.max(1, Math.min(GRID_N, Math.ceil(maxDist / CELL)));
      const cx = Math.floor((x - GRID_ORIGIN) / CELL);
      const cz = Math.floor((z - GRID_ORIGIN) / CELL);
      for (let dz = -rings; dz <= rings; dz++) {
        const rz = cz + dz;
        if (rz < 0 || rz >= GRID_N) continue;
        for (let dx = -rings; dx <= rings; dx++) {
          const rx = cx + dx;
          if (rx < 0 || rx >= GRID_N) continue;
          for (let i = bodyCell[rz * GRID_N + rx]; i >= 0; i = bodyNext[i]) {
            /* Not somebody's child on their shoulders. They are a metre and a
               half above the deck and standing on nobody: every caller of
               this wants a body another body could walk up to. */
            if (aRole[i] === R_RIDER) continue;
            const q = (ax[i] - x) ** 2 + (az[i] - z) ** 2;
            if (q < bestD) {
              bestD = q;
              best = i;
            }
          }
        }
      }
      if (best < 0) return null;
      return { x: ax[best], y: ay[best], z: az[best], id: best };
    },
    snapshot() {
      const ROLES = ["alone", "lead", "adult", "child", "rider"] as const;
      const GROUPS = ["alone", "couple", "family", "dog"] as const;
      const STATES = ["walk", "stand", "sit", "lean", "wait", "pause"] as const;
      const people: PersonView[] = [];
      for (let i = 0; i < MAX; i++) {
        people.push({
          id: i,
          x: ax[i],
          y: ay[i],
          z: az[i],
          lead: aLead[i],
          yaw: ayaw[i],
          seat: aSeat[i],
          role: ROLES[aRole[i]] ?? "alone",
          group: GROUPS[aGroup[i]] ?? "alone",
          state: STATES[aState[i]] ?? "wait",
          active: aActive[i] === 1,
        });
      }
      const dogs = [];
      for (let d = 0; d < NDOG; d++) {
        dogs.push({ x: dgX[d], y: dgY[d], z: dgZ[d], owner: dgOwner[d] });
      }
      const robots = [];
      for (let b = 0; b < NBOT; b++) {
        robots.push({
          x: btX[b],
          y: btY[b],
          z: btZ[b],
          kind: (btMode[b] === 0 ? "sweeper" : btMode[b] === 1 ? "courier" : "companion") as
            | "sweeper"
            | "courier"
            | "companion",
        });
      }
      const prams = [];
      for (let m = 0; m < NPRAM; m++) {
        const o = pmOwner[m];
        prams.push({
          x: ax[o] - Math.sin(ayaw[o]) * 0.68,
          y: ay[o],
          z: az[o] - Math.cos(ayaw[o]) * 0.68,
          owner: o,
        });
      }
      return { people, dogs, robots, prams };
    },
    update,
    dispose() {
      for (const tier of tiers) {
        tier.geo.dispose();
        group.remove(tier.mesh);
      }
      for (const kit of kits) {
        kit.geo.dispose();
        group.remove(kit.mesh);
      }
      bodyMat.dispose();
      cardMat.dispose();
      kitMat.dispose();
    },
  };
}
