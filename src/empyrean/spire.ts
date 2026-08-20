/**
 * THE EMPYREAN — one tower you can walk into, ride up, and stand on top of.
 *
 * Everything else in this city of glass is scenery: twenty-three towers you
 * can fly around and land on and never once get inside. The single most
 * requested thing about a city of glass towers is getting *into* one and
 * looking down, so this file builds one whole tower from the pavement to the
 * crown — a double-height lobby off the street, a scenic lift that really
 * travels the three hundred metres with you standing in it, and a belvedere
 * near the top with a glass floor cantilevered out over the street.
 *
 * It lives beside `interiors.ts` rather than inside it because it is a
 * different kind of thing: the five street rooms are furniture inside
 * somebody else's shell, and this one *is* the shell. `interiors.ts` owns it,
 * folds its blockers, decks and prompts into its own, and hands the lot id to
 * the engine as a claim so `buildings.ts` leaves the footprint alone.
 *
 * ## The lift, and the one thing that decides its speed
 *
 * There is no ride mode here and no fade. The car is a `Deck` — the same
 * struct a mezzanine is — whose `y` changes every frame, plus a balustrade of
 * `Blocker`s that move with it. The body's own physics does the carrying, and
 * it can do it because of one number: `flight.ts` looks support up from
 * `prevY + CLIMB`, so a deck that rose more than `CLIMB` (0.62 m) since the
 * last physics step is a deck the body cannot see any more, and the player is
 * left standing in mid-air while the car goes on without them.
 *
 * `dt` is clamped to 0.05 s by the engine, so the naive speed limit is
 * 0.62 / 0.05 = **12.4 m/s** — measured, not guessed: 12.4 rides, 13.0 leaves
 * the body at the bottom of the shaft. Rather than sit near a cliff edge, the
 * car's rise is capped at `MAX_STEP` (0.45 m) *per frame* as well as by its
 * speed. That makes the invariant independent of both the frame rate and the
 * cruise speed: whatever happens to the clock, the deck never moves further
 * than the body's step-up can reach.
 *
 * **Going down is not symmetrical, and this is the part that surprised.** A
 * rising deck pushes the body; a falling one just leaves. The body free-falls
 * after it and settles a sag of `u² / 2g` behind — 19 cm at 3 m/s, 1.8 m at
 * 9 — which reads as the character floating a metre above a descending floor.
 * So the descent, and *only* the descent, sets the body onto the car floor.
 * That moves it onto a floor already underneath it, which is where gravity
 * was about to put it anyway; it cannot move anybody through anything, and it
 * does nothing at all on the way up.
 *
 * And the car is **drawn a frame behind its own deck**. Systems update after
 * the body has already stepped, so the body is always standing on the deck as
 * it was one frame ago. Draw the car at its new height and the character
 * rides visibly sunk into its floor by a frame of travel — eighteen
 * centimetres at eleven metres a second. Draw it where the deck was and the
 * two agree exactly, all the way up, with no correction of any kind.
 *
 * ## Why the shaders are copied and not imported
 *
 * A system may not import another system, and the curtain wall in
 * `buildings.ts` is what the other twenty-two towers are wearing. A tower
 * that does not match its neighbours is the visible failure, so the sky and
 * environment chunk is duplicated here verbatim. It is the price of the rule,
 * it is paid once, and it is written down rather than smuggled.
 *
 * **Never put a backtick inside a GLSL comment in this file.** The shaders
 * are template literals and it terminates the literal a hundred lines early.
 */
import * as THREE from "three";
import { makeRng, type Rng } from "@/shared/proc/rng";
import { ISLAND_Y } from "./config";
import { cityPlan, type Lot } from "./cityplan";
import { SUN_DIR } from "./sky";
import type { BuildContext, FrameContext, Interactable } from "./types";

/* -------------------------------------------------------------------------
 * The shapes this hands back
 *
 * Structurally identical to `interiors.ts`'s own `Blocker` and `Deck`, on
 * purpose: TypeScript is structural, so these drop straight into the engine's
 * lists without either file importing the other.
 * ---------------------------------------------------------------------- */

export interface Blocker {
  x: number;
  z: number;
  hx: number;
  hz: number;
  top: number;
  bottom: number;
}

export interface Deck {
  y: number;
  x?: number;
  z?: number;
  hx?: number;
  hz?: number;
  r?: number;
}

/** A point in the tower's own frame: +z out through the front door. */
export interface P2 {
  x: number;
  z: number;
}

/** A rectangle in the tower's own frame. */
export interface Rect {
  cx: number;
  cz: number;
  hx: number;
  hz: number;
}

/**
 * The whole tower as data, with no THREE in the answer.
 *
 * Pure and deterministic, so a test can assert that the lobby is reachable
 * from the lot's own doorstep and that the lift's stops line up with real
 * floors without building a single triangle.
 */
export interface SpirePlan {
  /** Lot the tower stands on. The engine must claim it. */
  lot: string;
  name: string;
  /** Origin, world. The lot's centroid. */
  x: number;
  z: number;
  /** Floor level of the lobby, world. */
  y: number;
  /** Which way the front door faces, radians, the landmark convention. */
  yaw: number;
  /** Eaves height above the deck, from the plan. */
  height: number;
  /** The tower's footprint in its own frame, wound as the lot is. */
  shell: P2[];
  /** Index into `shell` of the street-facing edge. */
  frontEdge: number;
  /** The plane of the front wall, in the tower's own frame. */
  frontZ: number;
  /** The clear opening in the front wall: x from `x0` to `x1`. */
  entrance: { x0: number; x1: number };
  /** The lobby floor, as a room. */
  lobby: Rect;
  /** Ceiling of the lobby. Double height. */
  lobbyH: number;
  /** The lift bay: a glazed slot up the front of the tower. */
  bay: Rect;
  /** The sky deck floor, as a room. */
  deck: Rect;
  /** Local y of the sky deck floor and of its ceiling. */
  deckY: number;
  deckCeil: number;
  /** The glass floor, cantilevered off the front of the sky deck. */
  ledge: Rect;
  /** Local y of each stop the car serves, in order. */
  stops: number[];
  /** How far the car travels between the first stop and the last, metres. */
  travel: number;
  /** The pavement outside the front door — where you stand when you see in. */
  doorstep: { x: number; z: number };
}

export interface SpireHandle {
  group: THREE.Group;
  blockers: Blocker[];
  decks: Deck[];
  /** Stable array; the car's own prompt is mutated in place as it moves. */
  interactables(): Interactable[];
  plan: SpirePlan;
  /** "spire-lobby", "spire-lift", "spire-deck", or null. */
  inside(x: number, y: number, z: number): string | null;
  /** Local y of the car floor, for the tests and the debug hook. */
  carY(): number;
  onToast: ((text: string, tone?: "info" | "good" | "warn") => void) | null;
  update(ctx: FrameContext): void;
  dispose(): void;
}

/* -------------------------------------------------------------------------
 * Numbers
 * ---------------------------------------------------------------------- */

/** How far the shell stands inside the lot line. Matches the other towers. */
const INSET = 0.9;
/** Wall thickness for anything a body can lean on. */
const WALL = 0.4;

/** Double height, and the reason a lobby reads as a lobby. */
const LOBBY_H = 9.0;
/** The smallest room this file is willing to call a lobby, half-extents. */
const LOBBY_MIN_HX = 8.0;
const LOBBY_MIN_HZ = 6.0;
/** What it would like, given room. */
const LOBBY_WANT_HX = 9.2;
const LOBBY_WANT_HZ = 7.6;

/** The lift bay: clear width and depth of the slot up the front. */
const BAY_HX = 3.0;
const BAY_HZ = 3.4;
/** The car, inside it. */
const CAR_HX = 2.35;
const CAR_HZ = 2.7;
/** Waist-high glass, so the camera can see over it and a body cannot. */
const CAR_RAIL = 1.15;

/** Sky deck: floor this far below the eaves, and this tall. */
const DECK_DROP = 26.0;
const DECK_H = 11.0;
/** The glass floor, cantilevered out past the wall. */
const LEDGE_OUT = 3.2;
const LEDGE_HX = 2.9;

/**
 * Cruise speed of the car, m/s, and the acceleration it reaches it with.
 *
 * Eleven is a brisk express lift and puts the 302 m ride at a little under
 * half a minute. It is nowhere near the limit that matters, because the limit
 * that matters is `MAX_STEP`, below.
 */
const CAR_SPEED = 11.0;
const CAR_ACCEL = 5.0;
/**
 * The hard invariant: the car floor may never rise further than this in one
 * frame, whatever the clock did.
 *
 * `flight.ts` finds support at `prevY + CLIMB`, and CLIMB is 0.62 m. Anything
 * under that is carried; 0.45 leaves nearly a third of the reach in hand.
 * Measured rather than reasoned: at the engine's clamped dt of 0.05 s a deck
 * rising at 12.4 m/s still carries the body and one at 13.0 does not.
 */
const MAX_STEP = 0.45;
/** Seconds the doors stand open at a stop before the call point re-arms. */
const DWELL = 1.4;

/** How near you have to be for the rooms to be worth animating. */
const WAKE_R = 90;

/** Virtual lamps in the surface shader. Free; this is only the array size. */
const NL = 6;

const TAU = Math.PI * 2;

/* -------------------------------------------------------------------------
 * Palette
 * ---------------------------------------------------------------------- */

const P = {
  floor: 0x6f6a72,
  floorWarm: 0x8a7c72,
  stone: 0x544d55,
  plaster: 0x8c8391,
  pier: 0x6a6169,
  iron: 0x2b2730,
  steel: 0x6d6a74,
  brass: 0xb08144,
  timber: 0x6b4a33,
  felt: 0x9c5a46,
  leaf: 0x59934b,
  leafDark: 0x36663a,
  soil: 0x3a2b24,
  lamp: 0xffc48a,
  cool: 0x9fc8e8,
  sign: 0x8fd6ff,
} as const;

/* -------------------------------------------------------------------------
 * The plan
 * ---------------------------------------------------------------------- */

/** World → the tower's own frame: +z out along `yaw`, +x across it. */
function toLocal(x: number, z: number, ox: number, oz: number, yaw: number): P2 {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  const dx = x - ox;
  const dz = z - oz;
  return { x: dx * s - dz * c, z: dx * c + dz * s };
}

/** The tower's own frame → world. The transpose; the rotation is orthonormal. */
export function toWorld(px: number, pz: number, yaw: number, ox: number, oz: number): P2 {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  return { x: ox + px * s + pz * c, z: oz - px * c + pz * s };
}

function pointInPoly(px: number, pz: number, poly: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > pz !== b.z > pz && px < ((b.x - a.x) * (pz - a.z)) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * The footprint, pulled in off the lot line.
 *
 * Every vertex is drawn `d` metres toward the centroid rather than each edge
 * being offset along its own normal. On a convex lot the difference is a
 * fraction of a degree of tilt and the result is always *inside* the lot,
 * which is the only property that matters here — a wall standing over the
 * pavement is the failure, and this cannot produce one.
 */
function pull(poly: P2[], d: number): P2[] {
  let cx = 0;
  let cz = 0;
  for (const p of poly) {
    cx += p.x / poly.length;
    cz += p.z / poly.length;
  }
  return poly.map((p) => {
    const dx = p.x - cx;
    const dz = p.z - cz;
    const len = Math.hypot(dx, dz);
    const k = len > d ? 1 - d / len : 0.5;
    return { x: cx + dx * k, z: cz + dz * k };
  });
}

/**
 * Is every point of this rectangle's outline inside the footprint?
 *
 * The whole outline and not only the four corners: a lot here is a wedge with
 * curved sides, and the place a rectangle first pokes out of one is halfway
 * along an edge as often as it is at a corner.
 */
function rectInside(poly: P2[], r: Rect, step = 0.9): boolean {
  const nx = Math.max(2, Math.ceil((r.hx * 2) / step));
  const nz = Math.max(2, Math.ceil((r.hz * 2) / step));
  for (let i = 0; i <= nx; i++) {
    const x = r.cx - r.hx + (r.hx * 2 * i) / nx;
    if (!pointInPoly(x, r.cz - r.hz, poly)) return false;
    if (!pointInPoly(x, r.cz + r.hz, poly)) return false;
  }
  for (let j = 0; j <= nz; j++) {
    const z = r.cz - r.hz + (r.hz * 2 * j) / nz;
    if (!pointInPoly(r.cx - r.hx, z, poly)) return false;
    if (!pointInPoly(r.cx + r.hx, z, poly)) return false;
  }
  return true;
}

/**
 * The biggest rectangle of the given proportions that fits, on the door axis
 * and with its front against the front wall.
 *
 * This is the *lobby's* rule, and both anchors matter: a lobby that is not on
 * the door axis is a lobby you enter sideways, and one that does not reach
 * the front wall has a strip of unreachable floor behind its own glazing.
 */
function fitRect(poly: P2[], cx: number, frontZ: number, wantHx: number, wantHz: number): Rect | null {
  for (let k = 1; k > 0.35; k -= 0.02) {
    const r: Rect = { cx, cz: frontZ - wantHz * k, hx: wantHx * k, hz: wantHz * k };
    if (rectInside(poly, r)) return r;
  }
  return null;
}

/**
 * The largest rectangle that fits against the front wall.
 *
 * The sky deck wants this rather than the lobby's rule: it has no door to
 * line up with, every square metre of it is a place to stand, and the one
 * side it must reach is the front, because that is where the view and the
 * glass floor are. Anything less and the best part of the room is a planter
 * you lean over.
 *
 * Swept rather than grown. Growing greedily fails on a wedge in a way that is
 * easy to miss: take the width first and it comes out as wide as the front
 * wall and one metre deep, and no amount of growing afterwards will trade any
 * of that width back for depth. So the back edge is swept and the width that
 * survives the whole depth is measured for each one.
 */
function frontRect(poly: P2[], frontZ: number, margin = 0.35): Rect | null {
  const front = frontZ - margin;
  let zlo = Infinity;
  for (const p of poly) zlo = Math.min(zlo, p.z);
  let best: Rect | null = null;
  let bestArea = 0;
  for (let zb = front - 3; zb > zlo; zb -= 0.4) {
    let L = -Infinity;
    let R = Infinity;
    for (let z = zb; z <= front + 1e-6; z += 0.4) {
      const [a, b] = xRangeAt(poly, Math.min(z, front - 1e-4));
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        L = Infinity;
        break;
      }
      L = Math.max(L, a);
      R = Math.min(R, b);
    }
    if (!Number.isFinite(L)) continue;
    const hx = (R - L) / 2 - margin;
    const hz = (front - zb) / 2;
    if (hx < 3 || hz < 3) continue;
    const area = hx * hz;
    if (area > bestArea) {
      bestArea = area;
      best = { cx: (L + R) / 2, cz: (front + zb) / 2, hx, hz };
    }
  }
  return best;
}

/**
 * Which tower, and why that one.
 *
 * **The tallest tower lot in the Spires whose own footprint will hold a
 * lobby**, ties broken by id. Both halves of that are load-bearing: height,
 * because a lift is only worth building if the ride is worth taking, and the
 * footprint, because two thirds of the towers here stand on wedges four
 * metres wide at the door and a lobby will not fit in one at any height.
 *
 * Expressed as a rule rather than as a lot id so that it survives the plan
 * changing, which it has: `cityplan.ts` reseeds and every id in it moves.
 */
function chooseLot(): { lot: Lot; shell: P2[]; frontZ: number; lobby: Rect } {
  const towers = cityPlan()
    .lots.filter((l) => l.use === "tower" && !l.landmark)
    .sort((a, b) => (b.height === a.height ? a.id.localeCompare(b.id) : b.height - a.height));

  for (const lot of towers) {
    const yaw = Math.atan2(lot.frontNormal.z, lot.frontNormal.x);
    const local = lot.poly.map((p) => toLocal(p.x, p.z, lot.centroid.x, lot.centroid.z, yaw));
    const shell = pull(local, INSET);
    /* The front edge is squared off to the nearer of its two pulled corners.
     * Pulling toward the centroid tilts it by a fraction of a degree, and a
     * front wall that is not one plane makes every opening in it a special
     * case for the sake of sixteen centimetres. Moving it inward only ever
     * keeps it inside the lot. */
    const i0 = lot.frontEdge;
    const i1 = (i0 + 1) % shell.length;
    const frontZ = Math.min(shell[i0].z, shell[i1].z);
    shell[i0] = { x: shell[i0].x, z: frontZ };
    shell[i1] = { x: shell[i1].x, z: frontZ };

    const door = toLocal(lot.door.x, lot.door.z, lot.centroid.x, lot.centroid.z, yaw);
    const lobby = fitRect(shell, door.x, frontZ - WALL, LOBBY_WANT_HX, LOBBY_WANT_HZ);
    if (!lobby || lobby.hx < LOBBY_MIN_HX || lobby.hz < LOBBY_MIN_HZ) continue;
    return { lot, shell, frontZ, lobby };
  }
  throw new Error("empyrean/spire: no tower lot in the plan will hold a lobby");
}

/**
 * The tower, as data.
 *
 * Cheap, pure and deterministic. Everything the tests want to know — where
 * the lobby is, where the lift stops, whether the sky deck is inside the
 * tower's own footprint — is decided here and nowhere else.
 */
export function spirePlan(): SpirePlan {
  const { lot, shell, frontZ, lobby } = chooseLot();
  const yaw = Math.atan2(lot.frontNormal.z, lot.frontNormal.x);
  const door = toLocal(lot.door.x, lot.door.z, lot.centroid.x, lot.centroid.z, yaw);

  const height = lot.height;
  const deckY = height - DECK_DROP;
  const deckCeil = deckY + DECK_H;

  /* The entrance is on the door axis, because the doorstep the rest of the
   * city walks to is. Wide enough to walk through without aiming. */
  const entHalf = 2.85;
  const entrance = { x0: door.x - entHalf, x1: door.x + entHalf };

  /* The lift bay goes beside the entrance rather than over it, on whichever
   * side of the door has more front wall to give — a slot up the middle would
   * put the car across the way in. */
  const fi = lot.frontEdge;
  const fa = shell[fi];
  const fb = shell[(fi + 1) % shell.length];
  const xLo = Math.min(fa.x, fb.x);
  const xHi = Math.max(fa.x, fb.x);
  const roomRight = xHi - entrance.x1;
  const roomLeft = entrance.x0 - xLo;
  const side = roomRight >= roomLeft ? 1 : -1;
  const edge = side > 0 ? xHi : xLo;
  const near = side > 0 ? entrance.x1 : entrance.x0;
  const deck = frontRect(shell, frontZ) ?? { ...lobby };

  /* Centred in what is left of the front wall, then pulled back inside both
   * rooms it has to open into. A bay that hangs off the side of the lobby is
   * a lift you cannot reach from the floor it stands on. */
  let bayCx = (edge + near) / 2;
  const clamp = (v: number, r: Rect) =>
    Math.min(Math.max(v, r.cx - r.hx + BAY_HX + 0.4), r.cx + r.hx - BAY_HX - 0.4);
  bayCx = clamp(clamp(bayCx, lobby), deck);
  const bay: Rect = { cx: bayCx, cz: frontZ - WALL - BAY_HZ, hx: BAY_HX, hz: BAY_HZ };

  /* The glass floor hangs off the front wall, on the other side of the door
   * from the lift, so the two do not fight for the same view. */
  const ledgeSide = bayCx >= (entrance.x0 + entrance.x1) / 2 ? -1 : 1;
  const ledgeCx = Math.min(
    Math.max(
      ledgeSide > 0 ? entrance.x1 + LEDGE_HX + 0.6 : entrance.x0 - LEDGE_HX - 0.6,
      // Inside the floor you can actually stand on, or it is a door onto a
      // ledge with no way to reach the door.
      deck.cx - deck.hx + LEDGE_HX + 0.5,
    ),
    deck.cx + deck.hx - LEDGE_HX - 0.5,
  );
  const ledge: Rect = { cx: ledgeCx, cz: frontZ + LEDGE_OUT / 2, hx: LEDGE_HX, hz: LEDGE_OUT / 2 };

  return {
    lot: lot.id,
    name: "The Meridian",
    x: lot.centroid.x,
    z: lot.centroid.z,
    y: ISLAND_Y,
    yaw,
    height,
    shell,
    frontEdge: lot.frontEdge,
    frontZ,
    entrance,
    lobby,
    lobbyH: LOBBY_H,
    bay,
    deck,
    deckY,
    deckCeil,
    ledge,
    stops: [0, deckY],
    travel: deckY,
    doorstep: { x: lot.door.x, z: lot.door.z },
  };
}

/* -------------------------------------------------------------------------
 * Shaders
 * ---------------------------------------------------------------------- */

/**
 * The sky, the horizon and the city opposite, as a pane of glass sees them.
 *
 * A verbatim copy of the chunk in `buildings.ts`. The module rule forbids
 * importing it and this is the one thing that makes glass read as glass — the
 * alternative is a tower that is its own gradient standing among twenty-two
 * that are mirrors, which is exactly the sort of wrongness a screenshot
 * catches and a test never will.
 */
const SKY_CHUNK = /* glsl */ `
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  return fract(p * (p + p));
}
float hash21(vec2 c) {
  vec3 p = fract(vec3(c.x, c.y, c.x) * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
vec3 skyColor(vec3 rd, vec3 sun) {
  float t = clamp(rd.y, 0.0, 1.0);
  float sunAmt = clamp(dot(rd, sun) * 0.5 + 0.5, 0.0, 1.0);
  vec3 cRose   = vec3(1.00, 0.44, 0.60);
  vec3 cOrange = vec3(1.00, 0.56, 0.26);
  vec3 cGold   = vec3(1.00, 0.84, 0.40);
  vec3 cJade   = vec3(0.22, 0.82, 0.72);
  vec3 cSky    = vec3(0.07, 0.30, 0.72);
  vec3 cNavy   = vec3(0.020, 0.040, 0.175);
  vec3 c = mix(cOrange, cGold, smoothstep(0.010, 0.070, t));
  c = mix(c, cJade, smoothstep(0.050, 0.155, t));
  c = mix(c, cSky,  smoothstep(0.185, 0.400, t));
  c = mix(c, cNavy, smoothstep(0.360, 0.820, t));
  float low = 1.0 - smoothstep(0.0, 0.42, t);
  c = mix(c, cRose, low * (1.0 - sunAmt) * 0.62);
  c = mix(c, cGold * 1.10, low * pow(sunAmt, 2.2) * 0.75);
  c = mix(c, vec3(0.72, 0.62, 0.70), smoothstep(0.0, -0.28, rd.y) * 0.85);
  c += vec3(1.0, 0.72, 0.44) * pow(max(dot(rd, sun), 0.0), 70.0) * 1.1;
  return c;
}
vec3 envColor(vec3 rd, vec3 sun) {
  vec3 c = skyColor(rd, sun);
  vec3 snow = mix(vec3(0.86, 0.74, 0.78), vec3(0.55, 0.46, 0.62), smoothstep(-0.06, -0.5, rd.y));
  c = mix(c, snow, smoothstep(0.012, -0.030, rd.y));
  float level = 1.0 - smoothstep(0.0, 0.19, abs(rd.y));
  float sweep = 0.5 + 0.5 * sin(atan(rd.z, rd.x) * 5.0);
  vec3 opposite = mix(vec3(0.30, 0.20, 0.26), vec3(0.62, 0.42, 0.34), sweep);
  c = mix(c, opposite, level * 0.42);
  return c;
}
`;

/** uv carries metres: x along the facade, y up from the deck. */
const SHELL_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vNrm;
varying vec3 vWPos;
void main() {
  vUv = uv;
  vNrm = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SHELL_HEAD = /* glsl */ `
precision highp float;
uniform float uTime;
uniform float uDaylight;
uniform float uSunUp;
uniform float uTop;
uniform float uSeed;
uniform vec3 uCam;
uniform vec3 uSun;
varying vec2 vUv;
varying vec3 vNrm;
varying vec3 vWPos;
`;

/**
 * The curtain wall.
 *
 * Trimmed from the one in `buildings.ts` and keeping the parts that were
 * learned there: floor lines in metres so a 330 m tower is banded like a 90 m
 * one, mullions and spandrels rather than a flat sheet, variation per bay and
 * per floor band and never per cell (a 2-D jitter over a grid cell is what
 * quilts a tower), the analytic environment in the glass at every range, and
 * every metre-scale pattern faded into its own mean once a bay is smaller
 * than a pixel.
 */
const SHELL_FRAG = SHELL_HEAD + SKY_CHUNK + /* glsl */ `
void main() {
  float s = uSeed;
  float warmth = hash11(s * 7.13);
  float cool = hash11(s * 3.71 + 2.0);

  vec3 cFoot  = mix(vec3(0.10, 0.05, 0.11), vec3(0.16, 0.07, 0.09), warmth);
  vec3 cLow   = mix(vec3(1.00, 0.56, 0.30), vec3(0.92, 0.40, 0.40), warmth);
  vec3 cMid   = mix(vec3(1.00, 0.88, 0.66), vec3(1.00, 0.74, 0.74), warmth);
  vec3 cUpper = mix(vec3(0.30, 0.80, 1.00), vec3(0.66, 0.55, 1.00), cool);
  vec3 cTop   = mix(vec3(0.72, 0.92, 1.00), vec3(0.36, 0.50, 0.98), cool);

  float h = clamp(vUv.y / uTop, 0.0, 1.0);
  float breakpoint = 0.58;
  vec3 col = mix(cFoot, cLow, smoothstep(0.0, 0.10, h));
  col = mix(col, cMid,   smoothstep(0.06, breakpoint, h));
  col = mix(col, cUpper, smoothstep(breakpoint, breakpoint + 0.30, h));
  col = mix(col, cTop,   smoothstep(0.80, 1.0, h));

  float fh = 4.05;
  float bw = 2.7;
  vec2 g = vec2(vUv.x / bw, vUv.y / fh);
  float px = max(fwidth(g.x), fwidth(g.y));
  float det = 1.0 - smoothstep(0.28, 0.80, px);

  vec2 f = fract(g);
  float mull  = smoothstep(0.0, 0.06, min(f.x, 1.0 - f.x));
  float trans = smoothstep(0.0, 0.05, min(f.y, 1.0 - f.y));
  float spandrel = 1.0 - smoothstep(0.17, 0.31, f.y);
  float glazed = mull * trans * (1.0 - spandrel);
  float frame = max(1.0 - mull, 1.0 - trans);
  col *= mix(1.0, mix(mix(0.72, 1.02, glazed), 1.26, frame * 0.5), det);

  float bayJit = hash21(vec2(floor(g.x), s * 0.37)) - 0.5;
  float floorJit = hash21(vec2(s * 0.71, floor(g.y))) - 0.5;
  col *= 1.0 + (bayJit * 0.085 + floorJit * 0.065) * det;

  float belt = abs(fract(vUv.y / (fh * 8.0)) - 0.5) * 2.0;
  col *= mix(1.0, mix(1.0, 0.74, smoothstep(0.93, 1.0, belt)), det);

  float coverage = 1.0 - mix(0.42, 0.955, uDaylight);
  float r = hash21(vec2(floor(g.x) + s, floor(g.y) - s));
  float li = clamp((r - (1.0 - coverage)) / max(coverage, 0.001), 0.0, 1.0);
  float lit = mix(coverage * 0.5, li * glazed, det);
  col += vec3(1.0, 0.78, 0.42) * lit
       * (0.12 + 0.88 * pow(1.0 - uDaylight, 2.0))
       * (1.0 - smoothstep(0.55, 0.98, h)) * 0.62;

  col = mix(cFoot * 1.5, col, smoothstep(0.5, 7.0, vUv.y));

  vec3 toEye = uCam - vWPos;
  float dist = length(toEye);
  vec3 V = toEye / max(dist, 0.001);
  vec3 N = normalize(vNrm);
  if (!gl_FrontFacing) N = -N;

  vec2 pane = vec2(floor(g.x), floor(g.y));
  float wobX = (hash21(pane + vec2(s * 0.19, 11.3)) - 0.5) * 0.030;
  float wobY = (hash21(pane + vec2(41.7, s * 0.23)) - 0.5) * 0.022;
  vec3 T = normalize(cross(vec3(0.0, 1.0, 0.0), N));
  vec3 B = cross(N, T);
  vec3 Ng = normalize(N + (T * wobX + B * wobY) * glazed * det);

  float fres = pow(1.0 - clamp(dot(Ng, V), 0.0, 1.0), 2.6);
  vec3 sunDir = normalize(uSun);
  vec3 R = reflect(-V, Ng);
  vec3 env = envColor(R, sunDir);

  float mirror = mix(0.10, 0.34, glazed) + fres * mix(0.30, 0.66, glazed);
  col *= mix(1.0, 0.52, glazed * det);
  col = mix(col, env, mirror);

  float mirrorDot = max(dot(R, sunDir), 0.0);
  float glint = pow(mirrorDot, 900.0) * 9.0 + pow(mirrorDot, 42.0) * 0.55;
  col += vec3(1.0, 0.86, 0.62) * glint * mix(0.25, 1.0, glazed) * uSunUp;

  col += mix(vec3(0.45, 0.85, 1.0), vec3(1.0, 0.72, 0.85), warmth)
       * fres * smoothstep(35.0, 220.0, dist) * 0.85;

  col *= mix(0.46, 1.0, uSunUp);
  col *= 0.94 + 0.06 * sin(uTime * 0.5 + s * 6.28);
  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * Clear glass, and the only transparent thing in this world.
 *
 * The lift bay, the sky deck's walls and the glass floor all have to be seen
 * *through* — an opaque pane would make the whole point of the tower
 * invisible. Depth-write is off and the material is double sided, so it never
 * occludes anything and never has to be sorted against itself.
 */
const GLASS_FRAG = SHELL_HEAD + SKY_CHUNK + /* glsl */ `
void main() {
  vec3 N = normalize(vNrm);
  if (!gl_FrontFacing) N = -N;
  vec3 toEye = uCam - vWPos;
  float dist = length(toEye);
  vec3 V = toEye / max(dist, 0.001);
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.3);
  vec3 R = reflect(-V, N);
  vec3 env = envColor(R, normalize(uSun));

  vec2 g = vec2(vUv.x / 1.95, vUv.y / 2.55);
  float px = max(fwidth(g.x), fwidth(g.y));
  float det = 1.0 - smoothstep(0.30, 0.90, px);
  vec2 f = fract(g);
  float bar = 1.0 - smoothstep(0.0, 0.05, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
  bar *= det;

  vec3 tint = mix(vec3(0.62, 0.80, 0.92), vec3(0.95, 0.80, 0.72), 0.35);
  vec3 col = mix(env * 0.55, env, fres) * tint;
  float a = mix(0.11, 0.55, fres);
  vec3 metal = vec3(0.50, 0.48, 0.53) * mix(0.42, 1.0, uSunUp);
  col = mix(col, metal, bar);
  a = mix(a, 1.0, bar);
  col *= mix(0.55, 1.0, uSunUp);
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
}
`;

/**
 * Everything inside: floors, walls, desks, benches, planting, the car.
 *
 * Lit here rather than by the renderer, from a handful of virtual lamps in a
 * uniform. Six loop iterations a pixel, no light-count recompiles, and light
 * that has a *place* — which is the whole difference between a room and a
 * diagram of a room.
 */
const SURF_VERT = /* glsl */ `
attribute vec3 aCol;
attribute float aEmit;
attribute float aSky;
varying vec3 vCol;
varying vec3 vNrm;
varying vec3 vPos;
varying float vEmit;
varying float vSky;
void main() {
  vCol = aCol;
  vEmit = aEmit;
  vSky = aSky;
  vec4 p = vec4(position, 1.0);
  vec3 n = normal;
  #ifdef USE_INSTANCING
    p = instanceMatrix * p;
    n = mat3(instanceMatrix) * n;
  #endif
  vec4 world = modelMatrix * p;
  vPos = world.xyz;
  vNrm = normalize(mat3(modelMatrix) * n);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const SURF_FRAG = /* glsl */ `
precision highp float;
uniform vec4 uLamp[${NL}];
uniform vec3 uLampC[${NL}];
uniform vec3 uAmbTop;
uniform vec3 uAmbFloor;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
varying vec3 vCol;
varying vec3 vNrm;
varying vec3 vPos;
varying float vEmit;
varying float vSky;

void main() {
  vec3 N = normalize(vNrm);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vPos);

  float up = N.y * 0.5 + 0.5;
  vec3 lit = mix(uAmbFloor, uAmbTop, up);
  lit += uSunCol * max(dot(N, uSunDir), 0.0) * vSky;
  lit += uSunCol * 0.26 * vSky;

  float spec = 0.0;
  for (int i = 0; i < ${NL}; i++) {
    vec3 d = uLamp[i].xyz - vPos;
    float dist = length(d);
    float att = clamp(1.0 - dist / max(uLamp[i].w, 0.001), 0.0, 1.0);
    att *= att;
    if (att <= 0.0) continue;
    vec3 L = d / max(dist, 0.001);
    float lam = max(dot(N, L), 0.0) * 0.86 + 0.14;
    lit += uLampC[i] * att * lam;
    vec3 H = normalize(L + V);
    spec += pow(max(dot(N, H), 0.0), 42.0) * att;
  }

  vec3 col = vCol * lit;
  col += vCol * vEmit * 2.4;
  col += spec * 0.16;
  col += vCol * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0) * 0.30;
  gl_FragColor = vec4(col, 1.0);
}
`;

const GLOW_VERT = /* glsl */ `
attribute vec3 aCol;
uniform float uTime;
varying vec3 vCol;
void main() {
  vCol = aCol * (0.94 + 0.06 * sin(uTime * 1.7));
  vec4 p = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    p = instanceMatrix * p;
  #endif
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * p;
}
`;

const GLOW_FRAG = /* glsl */ `
precision highp float;
varying vec3 vCol;
void main() { gl_FragColor = vec4(vCol, 1.0); }
`;

/* -------------------------------------------------------------------------
 * A place to put triangles
 * ---------------------------------------------------------------------- */

const _col = new THREE.Color();

/**
 * One growing pile of vertices, emitted as one non-indexed geometry.
 *
 * Merging a few hundred small `BufferGeometry` objects is the obvious way and
 * costs a few hundred allocations and a merge pass for a mesh that is one
 * draw either way. Pushing into four number arrays does the same job with no
 * intermediate garbage at all.
 */
class Buf {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly emit: number[] = [];
  readonly sky: number[] = [];

  get empty(): boolean {
    return this.pos.length === 0;
  }

  vert(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    u: number, v: number,
    r: number, g: number, b: number,
    emit: number, sky: number,
  ): void {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(r, g, b);
    this.emit.push(emit);
    this.sky.push(sky);
  }

  /** Four corners wound so the normal comes out of the front. */
  quad(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    uv: [number, number, number, number, number, number, number, number],
    colour: number,
    emit = 0,
    sky = 0,
  ): void {
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    _col.setHex(colour, THREE.SRGBColorSpace);
    const r = _col.r, g = _col.g, b = _col.b;
    const push = (px: number, py: number, pz: number, u: number, v: number) =>
      this.vert(px, py, pz, nx, ny, nz, u, v, r, g, b, emit, sky);
    push(ax, ay, az, uv[0], uv[1]);
    push(bx, by, bz, uv[2], uv[3]);
    push(cx, cy, cz, uv[4], uv[5]);
    push(ax, ay, az, uv[0], uv[1]);
    push(cx, cy, cz, uv[4], uv[5]);
    push(dx, dy, dz, uv[6], uv[7]);
  }

  /** An axis-aligned box, six quads. `ry` rotates it about its own centre. */
  box(
    w: number, h: number, d: number,
    x: number, y: number, z: number,
    colour: number, emit = 0, sky = 0, ry = 0,
  ): void {
    const hx = w / 2, hy = h / 2, hz = d / 2;
    const c = Math.cos(ry), s = Math.sin(ry);
    const p = (lx: number, ly: number, lz: number): [number, number, number] => [
      x + lx * c + lz * s,
      y + ly,
      z - lx * s + lz * c,
    ];
    const A = p(-hx, -hy, hz), B = p(hx, -hy, hz), C = p(hx, hy, hz), D = p(-hx, hy, hz);
    const E = p(hx, -hy, -hz), F = p(-hx, -hy, -hz), G = p(-hx, hy, -hz), H = p(hx, hy, -hz);
    const uvW: [number, number, number, number, number, number, number, number] =
      [0, 0, w, 0, w, h, 0, h];
    const uvD: [number, number, number, number, number, number, number, number] =
      [0, 0, d, 0, d, h, 0, h];
    const uvT: [number, number, number, number, number, number, number, number] =
      [0, 0, w, 0, w, d, 0, d];
    this.quad(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2], D[0], D[1], D[2], uvW, colour, emit, sky);
    this.quad(E[0], E[1], E[2], F[0], F[1], F[2], G[0], G[1], G[2], H[0], H[1], H[2], uvW, colour, emit, sky);
    this.quad(B[0], B[1], B[2], E[0], E[1], E[2], H[0], H[1], H[2], C[0], C[1], C[2], uvD, colour, emit, sky);
    this.quad(F[0], F[1], F[2], A[0], A[1], A[2], D[0], D[1], D[2], G[0], G[1], G[2], uvD, colour, emit, sky);
    this.quad(D[0], D[1], D[2], C[0], C[1], C[2], H[0], H[1], H[2], G[0], G[1], G[2], uvT, colour, emit, sky);
    this.quad(F[0], F[1], F[2], E[0], E[1], E[2], B[0], B[1], B[2], A[0], A[1], A[2], uvT, colour, emit, sky);
  }

  /** A flat slab lying in the XZ plane, one quad, facing up (or down). */
  slab(cx: number, y: number, cz: number, hx: number, hz: number, colour: number, emit = 0, sky = 0, down = false): void {
    const uv: [number, number, number, number, number, number, number, number] =
      [0, 0, hx * 2, 0, hx * 2, hz * 2, 0, hz * 2];
    if (down) {
      this.quad(
        cx - hx, y, cz - hz, cx + hx, y, cz - hz, cx + hx, y, cz + hz, cx - hx, y, cz + hz,
        uv, colour, emit, sky,
      );
    } else {
      this.quad(
        cx - hx, y, cz + hz, cx + hx, y, cz + hz, cx + hx, y, cz - hz, cx - hx, y, cz - hz,
        uv, colour, emit, sky,
      );
    }
  }

  /** A vertical wall panel between two points in plan. */
  wall(
    ax: number, az: number, bx: number, bz: number,
    y0: number, y1: number, u0: number, colour: number, emit = 0, sky = 0,
  ): void {
    const len = Math.hypot(bx - ax, bz - az);
    const uv: [number, number, number, number, number, number, number, number] =
      [u0, y0, u0 + len, y0, u0 + len, y1, u0, y1];
    this.quad(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az, uv, colour, emit, sky);
  }

  finish(withUv: boolean, withCol: boolean): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    if (withUv) g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    if (withCol) {
      g.setAttribute("aCol", new THREE.Float32BufferAttribute(this.col, 3));
      g.setAttribute("aEmit", new THREE.Float32BufferAttribute(this.emit, 1));
      g.setAttribute("aSky", new THREE.Float32BufferAttribute(this.sky, 1));
    }
    return g;
  }
}

/* -------------------------------------------------------------------------
 * Local boxes into world AABBs
 *
 * The same compromise `interiors.ts` documents at length: a `Blocker` is an
 * axis-aligned box in *world* XZ and this tower stands at whatever angle its
 * lot does, so an oblique wall is chopped into short pieces and each piece
 * becomes the AABB that contains it. Duplicated here rather than imported,
 * because a system may not import another system and `interiors.ts` is the
 * file that owns this one.
 * ---------------------------------------------------------------------- */

const AXIS_EPS = 1e-3;
/** How far a tiled deck may overshoot the platform it stands for, metres. */
const DECK_TOL = 0.12;

function rotLocal(x: number, z: number, rot: number, ox: number, oz: number): P2 {
  return { x: ox + x * Math.cos(rot) + z * Math.sin(rot), z: oz - x * Math.sin(rot) + z * Math.cos(rot) };
}

interface LBox {
  x: number;
  z: number;
  hx: number;
  hz: number;
  ry: number;
  bottom: number;
  top: number;
  chop: number;
}

function pushBlockers(out: Blocker[], b: LBox, rot: number, ox: number, oz: number): void {
  const phi = rot + b.ry;
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const oblique = Math.abs(c * s) > AXIS_EPS;
  const nx = oblique ? Math.max(1, Math.ceil((b.hx * 2) / b.chop)) : 1;
  const nz = oblique ? Math.max(1, Math.ceil((b.hz * 2) / b.chop)) : 1;
  const px = b.hx / nx;
  const pz = b.hz / nz;
  const cr = Math.cos(b.ry);
  const sr = Math.sin(b.ry);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const lx = -b.hx + px * (2 * i + 1);
      const lz = -b.hz + pz * (2 * j + 1);
      const cx = b.x + lx * cr + lz * sr;
      const cz = b.z - lx * sr + lz * cr;
      const w = rotLocal(cx, cz, rot, ox, oz);
      out.push({
        x: w.x,
        z: w.z,
        hx: px * Math.abs(c) + pz * Math.abs(s),
        hz: px * Math.abs(s) + pz * Math.abs(c),
        bottom: ISLAND_Y + b.bottom,
        top: ISLAND_Y + b.top,
      });
    }
  }
}

/**
 * A deck cannot be over-approximated — an AABB larger than the platform is
 * floor you can stand on that is not there — so an oblique one is tiled and
 * each tile inset by the worst-case overshoot.
 */
/** The polygon's z range at a given x. Convex footprints only, which is all. */
function zRangeAt(poly: P2[], x: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (a.x === b.x) continue;
    const t = (x - a.x) / (b.x - a.x);
    if (t < 0 || t > 1) continue;
    const z = a.z + (b.z - a.z) * t;
    lo = Math.min(lo, z);
    hi = Math.max(hi, z);
  }
  return [lo, hi];
}

/**
 * Fill a footprint solid, as world boxes, without going through the chopper.
 *
 * Three hundred metres of tower between the lobby ceiling and the sky deck
 * has to be solid — not because anybody walks in it, but because the camera
 * boom does. Park the lens inside a hollow tower and the world goes black
 * with the player two metres away behind a wall, which is the whole frame and
 * is not obviously a collision bug when you are looking at it.
 *
 * Sliced in *world* x rather than the tower's, so nothing has to be chopped
 * into oriented pieces: sixteen boxes instead of six hundred. Each slice
 * takes the z range that survives its whole width, so the union is always
 * *inside* the footprint — a blocker wider than the building it stands for is
 * the "floor of clear air" this world has shipped once already, and it is
 * much worse than a few centimetres of unfilled corner behind a wall that is
 * solid anyway.
 */
function fillWorld(out: Blocker[], polyWorld: P2[], y0: number, y1: number, step = 2.0): void {
  if (polyWorld.length < 3) return;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of polyWorld) {
    lo = Math.min(lo, p.x);
    hi = Math.max(hi, p.x);
  }
  const n = Math.max(1, Math.ceil((hi - lo) / step));
  for (let i = 0; i < n; i++) {
    const x0 = lo + ((hi - lo) * i) / n;
    const x1 = lo + ((hi - lo) * (i + 1)) / n;
    const [a0, b0] = zRangeAt(polyWorld, x0 + 1e-4);
    const [a1, b1] = zRangeAt(polyWorld, x1 - 1e-4);
    const za = Math.max(a0, a1);
    const zb = Math.min(b0, b1);
    if (!Number.isFinite(za) || !Number.isFinite(zb) || zb - za < 0.3) continue;
    out.push({
      x: (x0 + x1) / 2,
      z: (za + zb) / 2,
      hx: (x1 - x0) / 2,
      hz: (zb - za) / 2,
      bottom: ISLAND_Y + y0,
      top: ISLAND_Y + y1,
    });
  }
}

function pushDecks(
  out: Deck[], d: { x: number; z: number; hx: number; hz: number; y: number },
  rot: number, ox: number, oz: number, tol = DECK_TOL,
): Deck[] {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  if (Math.abs(c * s) <= AXIS_EPS) {
    const w = rotLocal(d.x, d.z, rot, ox, oz);
    out.push({
      y: ISLAND_Y + d.y,
      x: w.x,
      z: w.z,
      hx: d.hx * Math.abs(c) + d.hz * Math.abs(s),
      hz: d.hx * Math.abs(s) + d.hz * Math.abs(c),
    });
    return out;
  }
  /* Each tile is the world box that *contains* its piece of the platform, not
   * one inscribed in it. Containing boxes overlap, so the union has no holes
   * anywhere — and a hole in a floor three hundred metres up is a fall, which
   * is a far worse failure than the alternative. What the union costs is a
   * staircase of overshoot round the edge, and that overshoot is
   * `tile * |sin r cos r|` and nothing else: it does not depend on how big
   * the platform is. So the tile size is chosen from the angle to hold the
   * overshoot under `tol`, which on a nearly square-on tower is a few tiles
   * and on a tower at forty-five degrees is a great many. */
  const chop = Math.min(24, Math.max(0.8, tol / Math.max(Math.abs(c * s), 1e-3)));
  const nx = Math.max(1, Math.ceil((d.hx * 2) / chop));
  const nz = Math.max(1, Math.ceil((d.hz * 2) / chop));
  const px = d.hx / nx;
  const pz = d.hz / nz;
  const hx = px * Math.abs(c) + pz * Math.abs(s);
  const hz = px * Math.abs(s) + pz * Math.abs(c);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const lx = -d.hx + px * (2 * i + 1);
      const lz = -d.hz + pz * (2 * j + 1);
      const w = rotLocal(d.x + lx, d.z + lz, rot, ox, oz);
      out.push({ y: ISLAND_Y + d.y, x: w.x, z: w.z, hx, hz });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------
 * Polygon knives
 * ---------------------------------------------------------------------- */

/** Sutherland–Hodgman against one half-plane: keep `nx*x + nz*z <= d`. */
function clipPoly(poly: P2[], nx: number, nz: number, d: number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const da = nx * a.x + nz * a.z - d;
    const db = nx * b.x + nz * b.z - d;
    if (da <= 0) out.push(a);
    if (da * db < 0) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out;
}

/** The polygon's x range at a given z. Convex footprints only, which is all. */
function xRangeAt(poly: P2[], z: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (a.z === b.z) {
      if (Math.abs(a.z - z) < 1e-6) {
        lo = Math.min(lo, a.x, b.x);
        hi = Math.max(hi, a.x, b.x);
      }
      continue;
    }
    const t = (z - a.z) / (b.z - a.z);
    if (t < 0 || t > 1) continue;
    const x = a.x + (b.x - a.x) * t;
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  return [lo, hi];
}

/** A polygon, flat, as a triangle fan from its first vertex. */
function fan(buf: Buf, poly: P2[], y: number, colour: number, up: boolean, emit = 0, sky = 0): void {
  if (poly.length < 3) return;
  const a = poly[0];
  for (let i = 1; i < poly.length - 1; i++) {
    const b = poly[i];
    const c = poly[i + 1];
    const p = up ? [a, c, b] : [a, b, c];
    buf.quad(
      p[0].x, y, p[0].z,
      p[1].x, y, p[1].z,
      p[2].x, y, p[2].z,
      p[0].x, y, p[0].z,
      [p[0].x, p[0].z, p[1].x, p[1].z, p[2].x, p[2].z, p[0].x, p[0].z],
      colour, emit, sky,
    );
  }
}

/* -------------------------------------------------------------------------
 * Build
 * ---------------------------------------------------------------------- */

interface Lamp {
  x: number;
  y: number;
  z: number;
  col: number;
  power: number;
  range: number;
}

/** One vertical run of the front wall: an x span carrying a stack of y bands. */
interface Band {
  y0: number;
  y1: number;
  kind: "curtain" | "glass" | "open";
}

export function buildSpire(ctx: BuildContext): SpireHandle {
  const plan = spirePlan();
  const rng: Rng = makeRng(`empyrean-spire:${plan.lot}`);
  const detail = ctx.quality === "high";

  const shell = plan.shell;
  const H = plan.height;
  const { deckY, deckCeil, bay, lobby, deck, entrance, ledge, frontZ } = plan;
  const lobbyH = plan.lobbyH;
  const rot = Math.PI / 2 - plan.yaw;

  const curtain = new Buf();
  const glass = new Buf();
  const room = new Buf();
  const glowBuf = new Buf();
  const carRoom = new Buf();
  const carGlass = new Buf();

  const blockers: Blocker[] = [];
  const decks: Deck[] = [];
  const lamps: { lobby: Lamp[]; deck: Lamp[] } = { lobby: [], deck: [] };

  const boxes: LBox[] = [];
  const solid = (
    x: number, z: number, hx: number, hz: number, bottom: number, top: number, ry = 0, chop = 1.2,
  ) => boxes.push({ x, z, hx, hz, ry, bottom, top, chop });

  /* ---------------------------------------------------------------------
   * The shell
   * ------------------------------------------------------------------ */

  const fi = plan.frontEdge;
  const n = shell.length;
  const fa = shell[fi];
  const fb = shell[(fi + 1) % n];
  const xLo = Math.min(fa.x, fb.x);
  const xHi = Math.max(fa.x, fb.x);

  /** Where the wall changes character along the front, in order. */
  const cuts = [xLo, xHi, entrance.x0, entrance.x1, bay.cx - bay.hx, bay.cx + bay.hx,
    ledge.cx - ledge.hx - 0.5, ledge.cx + ledge.hx + 0.5]
    .filter((x) => x > xLo + 1e-6 && x < xHi - 1e-6)
    .concat([xLo, xHi])
    .sort((a, b) => a - b);

  /* Cumulative metres along the facade, so the mullions of the curtain wall
     run continuously round every corner instead of restarting at each. */
  let u = 0;
  for (let i = 0; i < n; i++) {
    const a = shell[i];
    const b = shell[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    // Outward-facing winding: the wall helper takes the left perpendicular of
    // (b - a) as its normal, so an edge is flipped when that points inward.
    const mx = (a.x + b.x) / 2;
    const mz = (a.z + b.z) / 2;
    const px = -(b.z - a.z);
    const pz = b.x - a.x;
    const outward = px * mx + pz * mz > 0;
    const p0 = outward ? a : b;
    const p1 = outward ? b : a;

    if (i !== fi) {
      curtain.wall(p0.x, p0.z, p1.x, p1.z, 0, deckY, u, 0xffffff);
      glass.wall(p0.x, p0.z, p1.x, p1.z, deckY, deckCeil, u, 0xffffff);
      solid(mx, mz, len / 2 + 0.05, WALL / 2, 0, deckCeil, Math.atan2(-(b.z - a.z), b.x - a.x));
    } else {
      /* The street front: openings for the way in, the lift bay and the glass
         floor, and a wall everywhere else. */
      for (let k = 0; k < cuts.length - 1; k++) {
        const xa = cuts[k];
        const xb = cuts[k + 1];
        if (xb - xa < 0.05) continue;
        const mid = (xa + xb) / 2;
        const isBay = mid > bay.cx - bay.hx && mid < bay.cx + bay.hx;
        const isDoor = mid > entrance.x0 && mid < entrance.x1;
        const isLedge = mid > ledge.cx - ledge.hx - 0.5 && mid < ledge.cx + ledge.hx + 0.5;
        const bands: Band[] = isBay
          ? [{ y0: 0, y1: deckCeil, kind: "glass" }]
          : [
              { y0: 0, y1: lobbyH, kind: isDoor ? "open" : "glass" },
              { y0: lobbyH, y1: deckY, kind: "curtain" },
              ...(isLedge
                ? ([
                    { y0: deckY, y1: deckY + 2.6, kind: "open" },
                    { y0: deckY + 2.6, y1: deckCeil, kind: "glass" },
                  ] as Band[])
                : ([{ y0: deckY, y1: deckCeil, kind: "glass" }] as Band[])),
            ];
        for (const band of bands) {
          if (band.kind === "open") continue;
          const buf = band.kind === "curtain" ? curtain : glass;
          const uu = u + (outward ? xa - xLo : xHi - xb);
          buf.wall(xa, frontZ, xb, frontZ, band.y0, band.y1, uu, 0xffffff);
          solid((xa + xb) / 2, frontZ, (xb - xa) / 2, WALL / 2, band.y0, band.y1);
        }
      }
    }
    u += len;
  }

  /* ---------------------------------------------------------------------
   * The lobby
   * ------------------------------------------------------------------ */

  const bayZ0 = bay.cz - bay.hz;
  const bayX0 = bay.cx - bay.hx;
  const bayX1 = bay.cx + bay.hx;

  /**
   * A rectangle with the lift shaft cut out of its front, as three pieces.
   *
   * Every floor this tower has is a rectangle with a hole in it where the
   * shaft goes through, and a floor that forgets the hole is a floor the
   * rising car puts the player onto and then leaves behind.
   */
  const aroundBay = (r: Rect) => {
    const z0 = r.cz - r.hz;
    const z1 = r.cz + r.hz;
    const x0 = r.cx - r.hx;
    const x1 = r.cx + r.hx;
    const cut = Math.max(z0, Math.min(z1, bayZ0));
    return [
      { x: r.cx, z: (z0 + cut) / 2, hx: r.hx, hz: (cut - z0) / 2 },
      { x: (x0 + bayX0) / 2, z: (cut + z1) / 2, hx: (bayX0 - x0) / 2, hz: (z1 - cut) / 2 },
      { x: (bayX1 + x1) / 2, z: (cut + z1) / 2, hx: (x1 - bayX1) / 2, hz: (z1 - cut) / 2 },
    ].filter((k) => k.hx > 0.2 && k.hz > 0.2);
  };

  /* Floor. The deck is already underfoot everywhere on the island, so this
     is a surface to look at rather than one to stand on — no deck needed. */
  fan(room, shell, 0.02, P.floor, true, 0, 0.62);
  /* A darker inlay on the walking line from the door to the lift. */
  room.slab((entrance.x0 + entrance.x1) / 2, 0.04, frontZ - 4.2, 2.6, 4.0, P.floorWarm, 0, 0.66);
  room.slab(bay.cx, 0.04, bayZ0 - 1.2, bay.hx, 1.2, P.floorWarm, 0, 0.55);

  /* Ceiling, in three pieces so the lift bay is a hole in it and not a lid. */
  const behind = clipPoly(shell, 0, 1, bayZ0);
  fan(room, behind, lobbyH, P.stone, false, 0, 0.30);
  for (const [x0, x1] of [[xLo - 1, bayX0], [bayX1, xHi + 1]] as const) {
    const strip = clipPoly(clipPoly(clipPoly(shell, 0, -1, -bayZ0), 1, 0, x1), -1, 0, -x0);
    fan(room, strip, lobbyH, P.stone, false, 0, 0.30);
  }
  /* Anything that falls down the inside of the tower stops here rather than
     at the lobby floor, which is 300 m of nothing away.
     Cut around the bay, and that is not tidiness: a slab of floor across the
     shaft at nine metres is a floor the rising car puts the player onto and
     then leaves, and the ride ends on the lobby ceiling. */
  for (const r of aroundBay(lobby)) pushDecks(decks, { ...r, y: lobbyH }, rot, plan.x, plan.z, 0.5);
  /* And the tower above it is solid, everywhere except the shaft. */
  const toWorldPoly = (poly: P2[]) => poly.map((q) => rotLocal(q.x, q.z, rot, plan.x, plan.z));
  for (const region of [
    clipPoly(shell, 0, 1, bayZ0),
    clipPoly(clipPoly(shell, 0, -1, -bayZ0), 1, 0, bayX0),
    clipPoly(clipPoly(shell, 0, -1, -bayZ0), -1, 0, -bayX1),
  ]) {
    fillWorld(blockers, toWorldPoly(region), lobbyH, deckY);
  }

  /* Line the walls.
   *
   * The tower's shell is the *curtain wall* shader — an exterior material
   * that models a dark body under a bright reflection, which is exactly right
   * from the street and reads as black from a metre inside it. So the lobby
   * gets its own lining on every side but the glazed front: a plastered
   * inner skin and a skirting, in the room material, lit by the room's own
   * lamps. Seven quads, and the difference between a lobby and a cave. */
  for (let i = 0; i < n; i++) {
    if (i === fi) continue;
    const a = shell[i];
    const b = shell[(i + 1) % n];
    const inA = { x: a.x * 0.975, z: a.z * 0.975 };
    const inB = { x: b.x * 0.975, z: b.z * 0.975 };
    room.wall(inB.x, inB.z, inA.x, inA.z, 0, lobbyH, 0, P.plaster, 0, 0.42);
    room.wall(inB.x, inB.z, inA.x, inA.z, 0, 0.22, 0, P.stone, 0, 0.30);
  }

  /* The piers between the lobby glazing, so the front reads as structure.
     Never inside the way in: the cut list also carries the edges of the glass
     floor two hundred and ninety metres above, one of which lands in the
     middle of the doorway, and a post standing in a door is the sort of thing
     a test that measures clear width never sees — the pier is drawn and is
     not a blocker, so the doorway measured 5.7 m and looked half shut. */
  for (let k = 0; k < cuts.length - 1; k++) {
    const x = cuts[k + 1];
    if (x <= xLo + 0.2 || x >= xHi - 0.2) continue;
    if (x > entrance.x0 + 0.05 && x < entrance.x1 - 0.05) continue;
    room.box(0.5, lobbyH, 0.6, x, lobbyH / 2, frontZ - 0.35, P.pier, 0, 0.75);
  }

  /* The reception desk: a long counter across the back of the room, a
     worktop, and a light under the lip that does most of the work. */
  const deskZ = lobby.cz - lobby.hz + 2.0;
  const deskW = Math.min(7.2, lobby.hx * 1.1);
  room.box(deskW, 1.06, 0.95, lobby.cx, 0.53, deskZ, P.timber, 0, 0.34);
  room.box(deskW + 0.4, 0.09, 1.25, lobby.cx, 1.12, deskZ, P.stone, 0, 0.42);
  room.box(deskW - 0.5, 0.10, 0.10, lobby.cx, 0.86, deskZ + 0.62, P.lamp, 0.9);
  glowBuf.box(deskW - 0.5, 0.05, 0.05, lobby.cx, 0.86, deskZ + 0.66, P.lamp, 1.4);
  lamps.lobby.push({ x: lobby.cx, y: 1.5, z: deskZ + 0.9, col: P.lamp, power: 1.05, range: 14 });
  /* The tower's name, over the desk, as a bar of light rather than letters —
     there is no font in this world and a fake one reads as a smudge. */
  glowBuf.box(deskW * 0.62, 0.16, 0.06, lobby.cx, 3.1, deskZ - 0.48, P.sign, 1.9);

  /* Seating: two benches facing each other over a low table. */
  const seatX = lobby.cx - lobby.hx + 3.0;
  const seatZ = lobby.cz + 1.0;
  for (const s of [-1, 1]) {
    room.box(2.7, 0.12, 0.62, seatX, 0.44, seatZ + s * 1.5, P.timber);
    room.box(2.7, 0.44, 0.10, seatX, 0.66, seatZ + s * 1.94, P.felt);
    for (const e of [-1, 1]) {
      room.box(0.12, 0.44, 0.55, seatX + e * 1.2, 0.22, seatZ + s * 1.5, P.iron);
    }
  }
  room.box(1.5, 0.06, 0.9, seatX, 0.42, seatZ, P.stone);
  for (const e of [-1, 1]) room.box(0.08, 0.42, 0.08, seatX + e * 0.6, 0.21, seatZ, P.iron);

  /* The planted bed. Low wall, soil, a hedge and three saplings — the one
     thing in a lobby that says somebody looks after it. */
  const bedX = lobby.cx + lobby.hx - 2.6;
  const bedZ = lobby.cz - 0.6;
  room.box(3.6, 0.62, 2.0, bedX, 0.31, bedZ, P.stone, 0, 0.15);
  room.box(3.2, 0.10, 1.6, bedX, 0.64, bedZ, P.soil);
  room.box(3.0, 0.55, 1.4, bedX, 0.92, bedZ, P.leafDark, 0, 0.10);
  for (let t = 0; t < (detail ? 3 : 1); t++) {
    const tx = bedX - 1.1 + t * 1.1;
    const tz = bedZ + (rng.next() - 0.5) * 0.7;
    const hgt = 2.2 + rng.range(0, 0.9);
    room.box(0.14, hgt, 0.14, tx, 0.7 + hgt / 2, tz, P.timber);
    for (let c = 0; c < 3; c++) {
      const cy = 0.7 + hgt * (0.55 + c * 0.19);
      const r = 0.95 - c * 0.22;
      room.box(r, 0.34, r * 0.8, tx, cy, tz, c % 2 ? P.leaf : P.leafDark, 0, 0.22, rng.range(0, TAU));
    }
  }
  solid(bedX, bedZ, 1.8, 1.0, 0, 0.62);

  /* Uplighters round the room. */
  for (const [lx, lz] of [
    [lobby.cx - lobby.hx + 1.0, lobby.cz + lobby.hz - 1.6],
    [lobby.cx + lobby.hx - 1.0, lobby.cz + lobby.hz - 1.6],
    [lobby.cx - lobby.hx + 1.0, lobby.cz - lobby.hz + 1.2],
  ] as const) {
    room.box(0.30, 1.05, 0.30, lx, 0.52, lz, P.iron);
    room.box(0.42, 0.10, 0.42, lx, 1.09, lz, P.lamp, 1.0);
    glowBuf.box(0.30, 0.04, 0.30, lx, 1.16, lz, P.lamp, 1.6);
    lamps.lobby.push({ x: lx, y: 1.6, z: lz, col: P.lamp, power: 0.9, range: 16 });
  }
  lamps.lobby.push({ x: bay.cx, y: 2.4, z: bayZ0 + 0.6, col: P.cool, power: 0.55, range: 10 });

  /* ---------------------------------------------------------------------
   * The lift bay: three walls, open to the room, all the way up
   * ------------------------------------------------------------------ */

  /* The flanks are real walls of the tower and run the whole height. */
  for (const s of [-1, 1]) {
    const x = bay.cx + s * (bay.hx + WALL / 2);
    curtain.wall(x, bayZ0, x, frontZ, 0, deckCeil, 0, 0xffffff);
    room.box(WALL, deckCeil, bay.hz * 2 + WALL, x, deckCeil / 2, (bayZ0 + frontZ) / 2, P.plaster, 0, 0.80);
    solid(x, (bayZ0 + frontZ) / 2, WALL / 2, bay.hz + WALL / 2, 0, deckCeil);
  }
  /* The back of the shaft, solid between the two landings. */
  room.box(bay.hx * 2 + WALL * 2, deckY - lobbyH, WALL, bay.cx, (lobbyH + deckY) / 2, bayZ0 - WALL / 2, P.plaster, 0, 0.72);
  solid(bay.cx, bayZ0 - WALL / 2, bay.hx + WALL, WALL / 2, lobbyH, deckY);
  /* And above the sky deck's landing, so the shaft has a head. */
  room.box(bay.hx * 2 + WALL * 2, deckCeil - (deckY + 3.0), WALL, bay.cx, (deckY + 3.0 + deckCeil) / 2, bayZ0 - WALL / 2, P.plaster, 0, 0.72);
  solid(bay.cx, bayZ0 - WALL / 2, bay.hx + WALL, WALL / 2, deckY + 3.0, deckCeil);

  /* The call points: a post with a lit panel on it at each landing, and a
     strip of light up the jamb beside the opening so the lift reads as the
     lift from across the room rather than as a gap in a wall. */
  for (const [ly, tag] of [[0, "lobby"], [deckY, "deck"]] as const) {
    room.box(0.30, 1.12, 0.26, bay.cx + bay.hx - 0.7, ly + 0.56, bayZ0 - 0.9, P.iron, 0, 0.4);
    room.box(0.24, 0.30, 0.05, bay.cx + bay.hx - 0.7, ly + 1.02, bayZ0 - 1.04, P.cool, 0.9);
    glowBuf.box(0.16, 0.20, 0.04, bay.cx + bay.hx - 0.7, ly + 1.02, bayZ0 - 1.09, P.sign, 1.5);
    for (const e of [-1, 1]) {
      const jx = bay.cx + e * (bay.hx + 0.12);
      room.box(0.10, 2.9, 0.08, jx, ly + 1.5, bayZ0 - 0.24, P.cool, 0.7);
      glowBuf.box(0.06, 2.7, 0.05, jx, ly + 1.5, bayZ0 - 0.29, P.sign, 1.2);
    }
    void tag;
  }

  /* Guide rails, the length of the travel. Cheap, and the one thing that
     makes a shaft read as a shaft rather than as a slot. */
  for (const s of [-1, 1]) {
    const x = bay.cx + s * (bay.hx - 0.28);
    room.box(0.16, deckY + 2.0, 0.16, x, (deckY + 2.0) / 2, bayZ0 + 0.34, P.steel, 0, 0.70);
  }

  /* The landing gate at the sky deck. Solid unless the car is standing there.
     Kept as a live reference so `update` can retract it. */
  const gate: Blocker = {
    x: 0, z: 0, hx: 1, hz: 1,
    bottom: ISLAND_Y + deckY,
    top: ISLAND_Y + deckY + 2.4,
  };
  {
    /* A slab across the threshold rather than a pane in the plane of it.
     *
     * `collide.ts` indexes a blocker by its own box and then tests it with a
     * body radius added on, so a box thinner than the grid's tolerance can be
     * missed entirely by a body standing just outside the cell it was filed
     * under. Everywhere else in the world that costs you a scuff against a
     * wall. Here it is the only thing between a room full of people looking
     * at a view and a three-hundred-metre hole, so the gate is a metre and a
     * half deep and does not rely on the pad at all. */
    const GATE_D = 0.8;
    const w = rotLocal(bay.cx, bayZ0 + GATE_D, rot, plan.x, plan.z);
    const c = Math.abs(Math.cos(rot));
    const s = Math.abs(Math.sin(rot));
    gate.x = w.x;
    gate.z = w.z;
    gate.hx = bay.hx * c + GATE_D * s;
    gate.hz = bay.hx * s + GATE_D * c;
  }
  blockers.push(gate);
  const GATE_SILL = 0.04;
  const GATE_H = 2.4;

  /* ---------------------------------------------------------------------
   * The sky deck
   * ------------------------------------------------------------------ */

  /* Floor, drawn over the whole footprint and standable over the rectangle
     the tower is guaranteed to contain. The strip between the two is fenced
     off by the plinth, below — a floor you can see and not reach is a hole,
     and a hole three hundred metres up is a very long fall. */
  const deckBehind = clipPoly(shell, 0, 1, bayZ0);
  fan(room, deckBehind, deckY, P.floorWarm, true, 0, 0.85);
  for (const [x0, x1] of [[xLo - 1, bayX0], [bayX1, xHi + 1]] as const) {
    const strip = clipPoly(clipPoly(clipPoly(shell, 0, -1, -bayZ0), 1, 0, x1), -1, 0, -x0);
    fan(room, strip, deckY, P.floorWarm, true, 0, 0.85);
  }
  fan(room, shell, deckCeil, P.plaster, false, 0, 0.85);

  /* The standable rectangle, in three pieces around the bay. */
  const dz0 = deck.cz - deck.hz;
  const dz1 = deck.cz + deck.hz;
  const dx0 = deck.cx - deck.hx;
  const dx1 = deck.cx + deck.hx;
  for (const r of aroundBay(deck)) pushDecks(decks, { ...r, y: deckY }, rot, plan.x, plan.z);
  /* The ceiling is standable too, so a jetpack landing on the roof lands on
     something rather than falling through the glass into the room. */
  for (const r of aroundBay(deck)) pushDecks(decks, { ...r, y: deckCeil }, rot, plan.x, plan.z, 0.5);

  /* The plinth: a bench-height kerb whose inner face is the edge of the floor
     you can stand on.
     The footprint is a wedge and the floor is a rectangle inside it, so there
     is a band round three sides that is drawn and is not standable. Left open
     that band is a hole with a three-hundred-metre fall under it, so it is
     fenced and planted instead — which is what the band round the top of a
     tower usually is anyway. The front is not fenced: the rectangle reaches
     the glazing there, which is the side the whole room is for. */
  const PL = 0.62;
  for (const [ax, az, bx, bz] of [
    [dx0, dz0, dx1, dz0],
    [dx0, dz0, dx0, dz1],
    [dx1, dz0, dx1, dz1],
  ] as const) {
    const len = Math.hypot(bx - ax, bz - az);
    const along = Math.atan2(-(bz - az), bx - ax);
    const cx = (ax + bx) / 2;
    const cz = (az + bz) / 2;
    room.box(len, PL, 0.24, cx, deckY + PL / 2, cz, P.stone, 0, 0.8, along);
    solid(cx, cz, len / 2, 0.15, deckY, deckY + PL, along);
  }
  /* The band itself: the footprint with the rectangle cut out of it, raised
     and planted. Four half-plane clips, which is the whole of the geometry. */
  const surround = [
    clipPoly(shell, 0, 1, dz0),
    clipPoly(shell, 0, -1, -dz1),
    clipPoly(clipPoly(clipPoly(shell, 0, -1, -dz0), 0, 1, dz1), 1, 0, dx0),
    clipPoly(clipPoly(clipPoly(shell, 0, -1, -dz0), 0, 1, dz1), -1, 0, -dx1),
  ];
  for (const band of surround) {
    if (band.length < 3) continue;
    fan(room, band, deckY + PL, P.stone, true, 0, 0.85);
    if (detail) fan(room, pull(band, 0.4), deckY + PL + 0.26, P.leafDark, true, 0, 0.9);
  }

  /* Benches on the plinth, facing out, and two telescopes. */
  for (const [bx, bz, ry] of [
    [deck.cx - deck.hx + 2.2, dz0 + 0.9, 0],
    [deck.cx + deck.hx - 2.2, dz0 + 0.9, 0],
    [dx0 + 0.9, deck.cz, Math.PI / 2],
    [dx1 - 0.9, deck.cz, Math.PI / 2],
  ] as const) {
    room.box(2.4, 0.10, 0.5, bx, deckY + PL + 0.42, bz, P.timber, 0, 0.85, ry);
    for (const e of [-1, 1]) {
      room.box(0.10, 0.42, 0.44, bx + Math.cos(ry) * e * 1.05, deckY + PL + 0.21, bz - Math.sin(ry) * e * 1.05, P.iron, 0, 0.4, ry);
    }
  }
  const scopes: Array<[number, number]> = [
    [deck.cx - deck.hx + 3.4, dz1 - 1.4],
    [deck.cx + deck.hx - 3.4, dz1 - 1.4],
  ];
  for (const [sx, sz] of scopes) {
    room.box(0.34, 1.15, 0.34, sx, deckY + PL + 0.58, sz, P.iron, 0, 0.4);
    room.box(0.30, 0.30, 1.30, sx, deckY + PL + 1.32, sz + 0.18, P.brass, 0, 0.9, 0.0);
    glowBuf.box(0.16, 0.16, 0.05, sx, deckY + PL + 1.32, sz + 0.86, P.cool, 1.1);
    solid(sx, sz, 0.3, 0.3, deckY, deckY + PL + 1.6);
  }

  /* Ceiling lights. */
  for (const s of [-1, 1]) {
    const lx = deck.cx + s * (deck.hx * 0.5);
    room.box(deck.hx * 0.8, 0.12, 0.35, lx, deckCeil - 0.5, deck.cz, P.lamp, 0.85);
    glowBuf.box(deck.hx * 0.8, 0.05, 0.20, lx, deckCeil - 0.62, deck.cz, P.lamp, 1.3);
    lamps.deck.push({ x: lx, y: deckCeil - 1.0, z: deck.cz, col: P.lamp, power: 0.75, range: 22 });
  }
  lamps.deck.push({ x: bay.cx, y: deckY + 2.6, z: bayZ0 + 0.4, col: P.cool, power: 0.6, range: 12 });

  /* ---------------------------------------------------------------------
   * The glass floor
   * ------------------------------------------------------------------ */

  {
    const lx = ledge.cx;
    const z0 = frontZ;
    const z1 = frontZ + LEDGE_OUT;
    const hx = ledge.hx;
    /* The pane you stand on. Transparent, and the whole point: the street is
       three hundred metres directly underneath it. */
    glass.slab(lx, deckY + 0.06, (z0 + z1) / 2, hx, LEDGE_OUT / 2, 0xffffff, 0, 0);
    glass.slab(lx, deckY + 0.05, (z0 + z1) / 2, hx, LEDGE_OUT / 2, 0xffffff, 0, 0, true);
    /* Glass on three sides, to the height of a parapet, and a steel nosing so
       the edge of a transparent floor is visible before you step onto it. */
    glass.wall(lx - hx, z1, lx + hx, z1, deckY + 0.1, deckY + 1.2, 0, 0xffffff);
    glass.wall(lx - hx, z0, lx - hx, z1, deckY + 0.1, deckY + 1.2, 0, 0xffffff);
    glass.wall(lx + hx, z1, lx + hx, z0, deckY + 0.1, deckY + 1.2, 0, 0xffffff);
    room.box(hx * 2 + 0.3, 0.14, 0.18, lx, deckY + 1.26, z1, P.steel, 0, 0.9);
    room.box(0.16, 0.14, LEDGE_OUT, lx - hx, deckY + 1.26, (z0 + z1) / 2, P.steel, 0, 0.9);
    room.box(0.16, 0.14, LEDGE_OUT, lx + hx, deckY + 1.26, (z0 + z1) / 2, P.steel, 0, 0.9);
    room.box(hx * 2 + 0.5, 0.22, 0.30, lx, deckY - 0.12, z1 - 0.1, P.steel, 0, 0.9);
    /* Two struts back to the wall, because three metres of glass has to hang
       off something and a ledge that visibly does not is a ledge nobody
       stands on. */
    for (const e of [-1, 1]) {
      room.box(0.20, 0.24, LEDGE_OUT + 0.4, lx + e * (hx - 0.2), deckY - 0.3, (z0 + z1) / 2, P.steel, 0, 0.9);
    }
    /* Bridged back to the floor inside, or the way out onto it is a
       thirty-centimetre slot between the room and the ledge. */
    const bz0 = deck.cz + deck.hz - 0.3;
    pushDecks(decks, { x: lx, z: (bz0 + z1) / 2, hx: hx - 0.15, hz: (z1 - bz0) / 2, y: deckY }, rot, plan.x, plan.z);
    solid(lx, z1 + 0.1, hx + 0.3, 0.2, deckY, deckY + 1.2);
    for (const e of [-1, 1]) solid(lx + e * (hx + 0.1), (z0 + z1) / 2, 0.2, LEDGE_OUT / 2, deckY, deckY + 1.2);
  }

  /* ---------------------------------------------------------------------
   * The crown
   * ------------------------------------------------------------------ */

  {
    const crownPoly = pull(shell, 1.4);
    let cu = 0;
    for (let i = 0; i < crownPoly.length; i++) {
      const a = crownPoly[i];
      const b = crownPoly[(i + 1) % crownPoly.length];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const mx = (a.x + b.x) / 2;
      const mz = (a.z + b.z) / 2;
      const outward = -(b.z - a.z) * mx + (b.x - a.x) * mz > 0;
      const p0 = outward ? a : b;
      const p1 = outward ? b : a;
      curtain.wall(p0.x, p0.z, p1.x, p1.z, deckCeil, deckCeil + 2.4, cu, 0xffffff);
      cu += len;
    }
    fan(curtain, crownPoly, deckCeil + 2.4, 0xffffff, true);

    /* A plant room, then a mast. A rectangle rather than the footprint, so
       the box that makes it solid ends exactly where the building does — a
       blocker wider than the thing it stands for is a floor of clear air, and
       this world has shipped one of those before. */
    const plant = fitRect(pull(shell, 3.0), (xLo + xHi) / 2, frontZ - 4.0, 6.0, 6.0);
    if (plant) {
      const ph = H - (deckCeil + 2.4);
      curtain.box(plant.hx * 2, ph, plant.hz * 2, plant.cx, deckCeil + 2.4 + ph / 2, plant.cz, 0xffffff);
      solid(plant.cx, plant.cz, plant.hx, plant.hz, deckCeil + 2.4, H);
      pushDecks(decks, { x: plant.cx, z: plant.cz, hx: plant.hx - 0.3, hz: plant.hz - 0.3, y: H }, rot, plan.x, plan.z, 0.5);
      const mastH = 22;
      room.box(0.9, mastH, 0.9, plant.cx, H + mastH / 2, plant.cz, P.steel, 0, 1);
      glowBuf.box(1.5, 1.5, 1.5, plant.cx, H + mastH + 1.2, plant.cz, 0xff8a5c, 2.2);
    }
  }

  /* ---------------------------------------------------------------------
   * The car
   * ------------------------------------------------------------------ */

  const carGroup = new THREE.Group();
  carGroup.name = "empyrean-spire-car";
  /* Authored around the origin so the group's own y is the floor. */
  carRoom.slab(0, 0.06, 0, CAR_HX, CAR_HZ, P.floorWarm, 0, 0.75);
  carRoom.slab(0, 0.05, 0, CAR_HX, CAR_HZ, P.stone, 0, 0, true);
  carRoom.box(CAR_HX * 2 + 0.2, 0.22, CAR_HZ * 2 + 0.2, 0, -0.11, 0, P.steel, 0, 0.7);
  for (const [ex, ez] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    carRoom.box(0.14, 2.5, 0.14, ex * (CAR_HX - 0.08), 1.25, ez * (CAR_HZ - 0.08), P.steel, 0, 0.9);
  }
  /* A frame over the car, not a lid.
   *
   * The first pass roofed it with one slab, and the third-person boom sits
   * about where that slab is: the whole frame became four and a half metres
   * of grey ceiling with a lift somewhere underneath it. Four beams round the
   * edge read as the same structure and the camera looks straight through the
   * middle of them. */
  for (const [ax, az, bx, bz] of [
    [-CAR_HX, CAR_HZ, CAR_HX, CAR_HZ],
    [-CAR_HX, -CAR_HZ, CAR_HX, -CAR_HZ],
    [-CAR_HX, -CAR_HZ, -CAR_HX, CAR_HZ],
    [CAR_HX, -CAR_HZ, CAR_HX, CAR_HZ],
  ] as const) {
    const len = Math.hypot(bx - ax, bz - az) + 0.28;
    carRoom.box(len, 0.16, 0.28, (ax + bx) / 2, 2.52, (az + bz) / 2, P.steel, 0, 0.9,
      Math.atan2(-(bz - az), bx - ax));
  }
  carRoom.box(CAR_HX * 1.2, 0.10, 0.22, 0, 2.44, -CAR_HZ + 0.5, P.lamp, 0.9);
  glowBuf.box(CAR_HX * 1.2, 0.05, 0.14, 0, 2.38, -CAR_HZ + 0.5, P.lamp, 1.4);
  /* Waist-high glass on the three closed sides. Low on purpose: a body is
     stopped by it and the camera boom is not, so the ride is a view and not
     the inside of a box. */
  for (const [ax, az, bx, bz] of [
    [-CAR_HX, CAR_HZ, CAR_HX, CAR_HZ],
    [-CAR_HX, -CAR_HZ, -CAR_HX, CAR_HZ],
    [CAR_HX, CAR_HZ, CAR_HX, -CAR_HZ],
  ] as const) {
    carGlass.wall(ax, az, bx, bz, 0.1, CAR_RAIL, 0, 0xffffff);
    const len = Math.hypot(bx - ax, bz - az);
    carRoom.box(len, 0.09, 0.10, (ax + bx) / 2, CAR_RAIL, (az + bz) / 2, P.steel, 0, 0.8,
      Math.atan2(-(bz - az), bx - ax));
  }
  /* The control pedestal, and the button you press. */
  carRoom.box(0.42, 1.05, 0.30, CAR_HX - 0.5, 0.52, -CAR_HZ + 0.45, P.iron, 0, 0.3);
  carRoom.box(0.34, 0.06, 0.22, CAR_HX - 0.5, 1.06, -CAR_HZ + 0.45, P.brass, 0.6);

  /* ---------------------------------------------------------------------
   * Materials and meshes
   * ------------------------------------------------------------------ */

  const group = new THREE.Group();
  group.name = "empyrean-spire";
  const rg = new THREE.Group();
  rg.name = `empyrean-spire-${plan.lot}`;
  rg.rotation.y = rot;
  rg.position.set(plan.x, ISLAND_Y, plan.z);
  rg.matrixAutoUpdate = false;
  rg.updateMatrix();
  group.add(rg);

  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];

  const shellUniforms = {
    uTime: { value: 0 },
    uDaylight: { value: 0.32 },
    uSunUp: { value: 1 },
    uTop: { value: H },
    uSeed: { value: rng.range(0, 100) },
    uCam: { value: new THREE.Vector3() },
    uSun: { value: SUN_DIR.clone() },
  };
  const glassUniforms = {
    uTime: { value: 0 },
    uDaylight: { value: 0.32 },
    uSunUp: { value: 1 },
    uTop: { value: H },
    uSeed: { value: shellUniforms.uSeed.value },
    uCam: shellUniforms.uCam,
    uSun: shellUniforms.uSun,
  };

  const curtainMat = new THREE.ShaderMaterial({
    name: "EmpyreanSpireCurtain",
    vertexShader: SHELL_VERT,
    fragmentShader: SHELL_FRAG,
    uniforms: shellUniforms,
    side: THREE.DoubleSide,
    extensions: { derivatives: true },
    fog: false,
  });
  const glassMat = new THREE.ShaderMaterial({
    name: "EmpyreanSpireGlass",
    vertexShader: SHELL_VERT,
    fragmentShader: GLASS_FRAG,
    uniforms: glassUniforms,
    side: THREE.DoubleSide,
    extensions: { derivatives: true },
    transparent: true,
    depthWrite: false,
    fog: false,
  });

  const lampVec: THREE.Vector4[] = [];
  const lampCol: THREE.Vector3[] = [];
  for (let i = 0; i < NL; i++) {
    lampVec.push(new THREE.Vector4(0, -9999, 0, 1));
    lampCol.push(new THREE.Vector3());
  }
  const surfMat = new THREE.ShaderMaterial({
    name: "EmpyreanSpireSurface",
    vertexShader: SURF_VERT,
    fragmentShader: SURF_FRAG,
    uniforms: {
      uLamp: { value: lampVec },
      uLampC: { value: lampCol },
      uAmbTop: { value: new THREE.Color(0x4a4668) },
      uAmbFloor: { value: new THREE.Color(0x352836) },
      uSunDir: { value: SUN_DIR.clone() },
      uSunCol: { value: new THREE.Color(0xffc98e).multiplyScalar(1.5) },
    },
    side: THREE.DoubleSide,
    fog: false,
  });
  const glowMat = new THREE.ShaderMaterial({
    name: "EmpyreanSpireGlow",
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    uniforms: { uTime: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  mats.push(curtainMat, glassMat, surfMat, glowMat);

  const addMesh = (buf: Buf, mat: THREE.Material, name: string, parent: THREE.Object3D, order: number, uv: boolean, col: boolean) => {
    if (buf.empty) return;
    const geo = buf.finish(uv, col);
    geos.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    parent.add(mesh);
  };

  addMesh(curtain, curtainMat, "spire-shell", rg, 0, true, false);
  addMesh(room, surfMat, "spire-rooms", rg, 0, false, true);
  addMesh(glass, glassMat, "spire-glass", rg, 2, true, false);
  addMesh(glowBuf, glowMat, "spire-glow", rg, 3, false, true);
  addMesh(carRoom, surfMat, "spire-car-body", carGroup, 0, false, true);
  addMesh(carGlass, glassMat, "spire-car-glass", carGroup, 2, true, false);
  carGroup.position.set(bay.cx, 0, bay.cz);
  rg.add(carGroup);

  /* ---------------------------------------------------------------------
   * Collision
   * ------------------------------------------------------------------ */

  for (const b of boxes) pushBlockers(blockers, b, rot, plan.x, plan.z);

  /* The car: one deck that moves, and three rails that move with it.
   *
   * The rails' undersides sit 0.6 m below the floor rather than level with
   * it. `flight.ts` tests a blocker from where the body *was*, and while the
   * car is rising the body is briefly below the new floor — with the rail
   * starting at the floor exactly, it reads as "flying underneath" and stops
   * blocking, and you can walk out of a moving lift. */
  const carDeck: Deck = { y: ISLAND_Y, x: 0, z: 0, hx: 0, hz: 0 };
  {
    const w = rotLocal(bay.cx, bay.cz, rot, plan.x, plan.z);
    const c = Math.abs(Math.cos(rot));
    const s = Math.abs(Math.sin(rot));
    carDeck.x = w.x;
    carDeck.z = w.z;
    carDeck.hx = Math.max(0.4, (CAR_HX - 0.25) * c + (CAR_HZ - 0.25) * s - Math.max(CAR_HX, CAR_HZ) * 0.12);
    carDeck.hz = Math.max(0.4, (CAR_HX - 0.25) * s + (CAR_HZ - 0.25) * c - Math.max(CAR_HX, CAR_HZ) * 0.12);
  }
  decks.push(carDeck);

  const carRails: Blocker[] = [];
  for (const [ax, az, bx, bz] of [
    [-CAR_HX, CAR_HZ, CAR_HX, CAR_HZ],
    [-CAR_HX, -CAR_HZ, -CAR_HX, CAR_HZ],
    [CAR_HX, CAR_HZ, CAR_HX, -CAR_HZ],
  ] as const) {
    const mid = rotLocal(bay.cx + (ax + bx) / 2, bay.cz + (az + bz) / 2, rot, plan.x, plan.z);
    const phi = rot + Math.atan2(-(bz - az), bx - ax);
    const hx = Math.hypot(bx - ax, bz - az) / 2 + 0.1;
    const hz = 0.16;
    const b: Blocker = {
      x: mid.x,
      z: mid.z,
      hx: hx * Math.abs(Math.cos(phi)) + hz * Math.abs(Math.sin(phi)),
      hz: hx * Math.abs(Math.sin(phi)) + hz * Math.abs(Math.cos(phi)),
      bottom: ISLAND_Y - 0.6,
      top: ISLAND_Y + CAR_RAIL,
    };
    carRails.push(b);
    blockers.push(b);
  }

  /* ---------------------------------------------------------------------
   * The lift, and the prompts on it
   * ------------------------------------------------------------------ */

  const stops = plan.stops;
  let carY = 0;
  let carV = 0;
  let target = 0;
  let dwell = 0;
  let attached = false;

  const handle: SpireHandle = {
    group,
    blockers,
    decks,
    plan,
    interactables: () => hits,
    inside: () => null,
    carY: () => carY,
    onToast: null,
    update: () => undefined,
    dispose: () => undefined,
  };

  const moving = () => Math.abs(carY - target) > 1e-4;
  const atStop = (i: number) => !moving() && Math.abs(carY - stops[i]) < 0.05;
  const send = (i: number) => {
    if (dwell > 0 || moving()) return;
    target = stops[i];
    if (Math.abs(target - carY) > 1e-4) handle.onToast?.(i === 1 ? "Going up." : "Going down.", "info");
  };

  const carHit: Interactable = {
    id: "spire-car",
    x: 0,
    y: ISLAND_Y + 1.0,
    z: 0,
    radius: 3.0,
    label: "Ride to the sky deck",
    detail: "The Meridian — 302 m",
    activate: () => send(atStop(0) ? 1 : 0),
    enabled: () => !moving() && dwell <= 0,
  };
  const callLobby: Interactable = {
    id: "spire-call-lobby",
    x: 0,
    y: ISLAND_Y + 1.2,
    z: 0,
    radius: 3.4,
    label: "Call the lift",
    detail: "The Meridian — sky deck, 302 m",
    activate: () => (atStop(0) ? send(1) : send(0)),
  };
  const callDeck: Interactable = {
    id: "spire-call-deck",
    x: 0,
    y: ISLAND_Y + deckY + 1.2,
    z: 0,
    radius: 3.4,
    label: "Call the lift",
    detail: "Back down to the lobby",
    activate: () => (atStop(1) ? send(0) : send(1)),
  };
  const desk: Interactable = {
    id: "spire-desk",
    x: 0,
    y: ISLAND_Y + 1.2,
    z: 0,
    radius: 3.0,
    label: "Ask at the desk",
    detail: "The Meridian",
    activate: () =>
      handle.onToast?.(
        "Sky deck, floor seventy-four. The lift takes half a minute and the view is worth it.",
        "info",
      ),
  };
  const scope: Interactable = {
    id: "spire-scope",
    x: 0,
    y: ISLAND_Y + deckY + 1.4,
    z: 0,
    radius: 2.6,
    label: "Look through the telescope",
    detail: "302 m above the street",
    activate: () =>
      handle.onToast?.("The lake is frozen all the way to the ranges. Nothing moves on it.", "good"),
  };

  const place = (it: Interactable, lx: number, lz: number) => {
    const w = rotLocal(lx, lz, rot, plan.x, plan.z);
    it.x = w.x;
    it.z = w.z;
  };
  place(callLobby, bay.cx, bayZ0 - 1.4);
  place(callDeck, bay.cx, bayZ0 - 1.6);
  place(desk, lobby.cx, deskZ + 1.6);
  place(scope, scopes[0][0], scopes[0][1] - 1.0);
  const hits: Interactable[] = [carHit, callLobby, callDeck, desk, scope];

  /* ---------------------------------------------------------------------
   * Frame
   * ------------------------------------------------------------------ */

  const sunCol = new THREE.Color();
  const lobbyWorld = rotLocal(lobby.cx, lobby.cz, rot, plan.x, plan.z);
  const carWorldX = carDeck.x;
  const carWorldZ = carDeck.z;
  const sinYaw = Math.sin(plan.yaw);
  const cosYaw = Math.cos(plan.yaw);

  const setLamps = (list: Lamp[]) => {
    for (let i = 0; i < NL; i++) {
      const l = list[i];
      if (!l) {
        lampVec[i].set(0, -9999, 0, 1);
        lampCol[i].set(0, 0, 0);
        continue;
      }
      const w = rotLocal(l.x, l.z, rot, plan.x, plan.z);
      lampVec[i].set(w.x, ISLAND_Y + l.y, w.z, l.range);
      _col.setHex(l.col, THREE.SRGBColorSpace);
      lampCol[i].set(_col.r * l.power, _col.g * l.power, _col.b * l.power);
    }
  };
  let lampSet: "lobby" | "deck" | null = null;

  handle.inside = (x, y, z) => {
    const dx = x - plan.x;
    const dz = z - plan.z;
    const lx = dx * sinYaw - dz * cosYaw;
    const lz = dx * cosYaw + dz * sinYaw;
    const ly = y - ISLAND_Y;
    if (Math.abs(lx - bay.cx) <= bay.hx && lz >= bayZ0 && lz <= frontZ && ly > -1 && ly < deckCeil) {
      return "spire-lift";
    }
    if (ly > -1.5 && ly < lobbyH + 1.5 &&
      Math.abs(lx - lobby.cx) <= lobby.hx && Math.abs(lz - lobby.cz) <= lobby.hz) {
      return "spire-lobby";
    }
    if (ly > deckY - 1.5 && ly < deckCeil + 1.5 &&
      Math.abs(lx - deck.cx) <= deck.hx && Math.abs(lz - deck.cz) <= deck.hz + LEDGE_OUT) {
      return "spire-deck";
    }
    return null;
  };

  handle.update = (frame: FrameContext) => {
    const dt = frame.dt;
    const p = frame.player.position;

    /* ---- the car ---- */
    if (dwell > 0) dwell -= dt;
    const wasAt = carY;
    const gap = target - carY;
    if (Math.abs(gap) > 1e-4) {
      const dir = gap > 0 ? 1 : -1;
      /* Ease out into the stop: the speed a constant deceleration could still
         shed in the distance that is left. A lift that arrives at full speed
         and stops in one frame throws the player off it. */
      const brake = Math.sqrt(2 * CAR_ACCEL * Math.abs(gap));
      const want = dir * Math.min(CAR_SPEED, brake);
      carV += (want - carV) * Math.min(1, dt * 6);
      let step = carV * dt;
      /* The invariant. Whatever the clock did, the floor never moves further
         in one frame than the body's step-up can follow. */
      if (step > MAX_STEP) step = MAX_STEP;
      if (step < -MAX_STEP) step = -MAX_STEP;
      if (Math.abs(step) >= Math.abs(gap)) {
        carY = target;
        carV = 0;
        dwell = DWELL;
      } else {
        carY += step;
      }
    } else {
      carV = 0;
    }

    /* Where the car is *drawn* is a frame behind where its deck is, and that
     * is not a bug to fix later.
     *
     * Systems update after the body has already stepped, so the body is
     * always standing on the deck as it was one frame ago: it reaches the new
     * floor on the next step, not this one. Draw the car at the new height
     * and the character rides visibly sunk into its floor by a frame's worth
     * of travel — eighteen centimetres at eleven metres a second. Draw it
     * where the deck *was* and the two agree exactly, all the way up, with no
     * correction of any kind. */
    const rising = carY > wasAt + 1e-9;
    const shown = rising ? wasAt : carY;
    carGroup.position.y = shown;
    /* The deck leads on the way up so the body's step-up has something to
     * find, and does not on the way down, where a deck below the body is a
     * body in free fall. */
    carDeck.y = ISLAND_Y + carY;
    for (let i = 0; i < carRails.length; i++) {
      carRails[i].bottom = ISLAND_Y + shown - 0.6;
      carRails[i].top = ISLAND_Y + shown + CAR_RAIL;
    }
    /* The landing gate retracts to a sill when the car is standing there.
       `blockedAt` skips a blocker a body is at or above the top of, so a
       four-centimetre gate is not a wall — and it is still a box with a
       positive height, which every check in the world expects. */
    const open = Math.abs(shown - stops[1]) < 0.06 && Math.abs(carY - stops[1]) < 0.06;
    gate.top = gate.bottom + (open ? GATE_SILL : GATE_H);

    carHit.x = carWorldX;
    carHit.z = carWorldZ;
    carHit.y = ISLAND_Y + shown + 1.0;
    carHit.label = Math.abs(carY - stops[0]) < 0.06 ? "Ride to the sky deck" : "Ride down to the lobby";
    callLobby.label = Math.abs(carY - stops[0]) < 0.06 ? "Ride to the sky deck" : "Call the lift";
    callDeck.label = open ? "Ride down to the lobby" : "Call the lift";

    /* ---- carrying the player ----
     *
     * **Up needs nothing.** The car floor is a `Deck` and `flight.ts` looks
     * support up from prevY + CLIMB, so a floor that has risen less than
     * 0.62 m since the last physics step picks the body up by itself. That is
     * the whole mechanism and the reason `MAX_STEP` exists.
     *
     * **Down it cannot.** A falling floor does not push anything; it just
     * leaves. The body free-falls after it and settles a sag of u squared
     * over 2g behind — 19 cm at 3 m/s and 1.8 m at 9 — which reads as the
     * character floating inside a descending lift. So on the way down, and
     * only on the way down, a body that was standing in the car is set onto
     * the floor it is standing on. It moves the body *onto a floor that is
     * already underneath it*, which is where gravity was about to put it
     * anyway; it can never move anybody through anything, and it does
     * nothing at all on the way up. */
    const dx = p.x - plan.x;
    const dz = p.z - plan.z;
    const lx = dx * sinYaw - dz * cosYaw;
    const lz = dx * cosYaw + dz * sinYaw;
    const feet = p.y - ISLAND_Y;
    const over =
      Math.abs(lx - bay.cx) <= CAR_HX - 0.1 && Math.abs(lz - bay.cz) <= CAR_HZ - 0.1;
    if (over && feet > shown - 0.5 && feet < shown + 2.4) attached = true;
    else if (!over || feet > shown + 3.0 || feet < shown - 3.0) attached = false;
    if (attached && !rising && feet > shown + 0.02 && feet < shown + 1.5 &&
      frame.player.velocity.y <= 0.5) {
      p.y = ISLAND_Y + shown;
      frame.player.velocity.y = 0;
    }

    /* ---- lights and shaders ---- */
    const near =
      (p.x - plan.x) * (p.x - plan.x) + (p.z - plan.z) * (p.z - plan.z) < WAKE_R * WAKE_R;
    const want: "lobby" | "deck" = feet > deckY - 40 ? "deck" : "lobby";
    if (want !== lampSet) {
      lampSet = want;
      setLamps(want === "deck" ? lamps.deck : lamps.lobby);
    }
    shellUniforms.uTime.value = frame.time;
    shellUniforms.uDaylight.value = frame.daylight;
    shellUniforms.uSunUp.value = frame.gradeDaylight;
    glassUniforms.uTime.value = frame.time;
    glassUniforms.uDaylight.value = frame.daylight;
    glassUniforms.uSunUp.value = frame.gradeDaylight;
    shellUniforms.uCam.value.copy(frame.camera.position);
    shellUniforms.uSun.value.copy(frame.sunDir);
    if (near) glowMat.uniforms.uTime.value = frame.time;
    sunCol.setRGB(1.0, 0.79, 0.56).multiplyScalar(0.35 + frame.daylight * 1.5);
    (surfMat.uniforms.uSunDir.value as THREE.Vector3).copy(frame.sunDir);
    (surfMat.uniforms.uSunCol.value as THREE.Color).copy(sunCol);
  };

  setLamps(lamps.lobby);
  lampSet = "lobby";

  handle.dispose = () => {
    for (const g of geos) g.dispose();
    geos.length = 0;
    for (const m of mats) m.dispose();
    mats.length = 0;
    carGroup.clear();
    rg.clear();
    group.clear();
    if (typeof window !== "undefined") {
      const w = window as unknown as { __empyreanLift?: unknown };
      if (w.__empyreanLift) delete w.__empyreanLift;
    }
  };

  /* A hand on the lift from outside the world, for the screenshot script.
   * There is no other way to photograph a car that is halfway up a
   * three-hundred-metre shaft on a rasteriser that renders one frame a
   * second, and the alternative — driving it for eleven real minutes — is not
   * a check anybody runs twice. */
  if (typeof window !== "undefined") {
    (window as unknown as { __empyreanLift?: unknown }).__empyreanLift = {
      /** Put the car at a local height immediately. */
      set(y: number) {
        carY = Math.max(stops[0], Math.min(stops[stops.length - 1], y));
        target = carY;
        carV = 0;
        dwell = 0;
      },
      /** Send it to a stop, the way the button does. */
      go(i: number) {
        target = stops[Math.max(0, Math.min(stops.length - 1, i))];
      },
      at: () => carY,
      plan: () => plan,
    };
  }

  return handle;
}
