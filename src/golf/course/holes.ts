/**
 * Vibe Golf — the courses.
 *
 * Seven eighteen-hole courses, one per theme, escalating from "learn the
 * swing" to "everything at once". Every hole is built around a single idea and
 * named after it; the name on the loading card should tell you what the hole
 * wants.
 *
 * Each course is a front nine and a back nine. The front nine introduces the
 * theme's vocabulary one idea at a time; the back nine assumes you know it and
 * combines two or three ideas per hole, with longer carries, tighter landing
 * zones and real weather. **Every index 0-17 resolves to a real hole on every
 * course** — the hole selector treats a missing index as "do nothing", so a
 * short course silently leaves you standing on whatever hole you were already
 * on. A capture of "hole 13" that is really hole 1 is worse than a crash,
 * because it looks like a pass. Never shorten a course below eighteen.
 *
 * Three rules govern everything below.
 *
 * 1. **Every hole is completable with geometry alone.** Portals and cannons
 *    are real, implemented mechanics so holes may depend on them. Everything
 *    else — fans, wind, conveyors, bumpers, boosts, movers, breakables — is
 *    authored as a *better line*, never the only line: a conveyor always has a
 *    slab under it, a mover is parked somewhere useful, a breakable wall
 *    always has a route over or under it. A hazard system that lands later can
 *    only make these holes richer, never impossible.
 * 2. **The cup always sits on a flat run of green** at least six metres wide,
 *    with a backstop wherever the approach is fast. A ball that physically
 *    cannot stop next to the cup is the worst bug a golf game can have.
 * 3. **No shot may take longer than a few seconds to resolve.** Two authoring
 *    rules enforce that, and both are load-bearing — see below.
 *
 * ## Rule 3a — never author a slope a rolling ball cannot stop on
 *
 * The solver applies rolling resistance as a *constant* deceleration,
 * `rollDrag × 9.81`, against gravity's along-slope pull of `22 × sinθ`. So a
 * ball stops on a slope if and only if
 *
 *     sinθ  <  rollDrag × 9.81 / 22
 *
 * which gives a hard ceiling per material:
 *
 *     green 5°   ·   metal 4°   ·   stone 6°   ·   wood 8°   ·   fairway 9°
 *     rough 20°  ·   sand 49°   ·   ice 0.5°
 *
 * Anything steeper than that on a long run is not a hill, it is a conveyor
 * belt to nowhere: the ball accelerates forever and the shot never ends. So
 * fairway and green are authored **flat or nearly flat**, and every real
 * gradient is tagged `rough` (or `sand`) so the ball can actually stop on it.
 * Holes read as *plateaus joined by banks*, not as one long ramp.
 *
 * ## Rule 3b — never author a 90° crease a ball can roll into
 *
 * The settle test only fires when the nearest surface under the ball has a
 * normal pointing meaningfully upward (`n.y > 0.25`). Park a ball in the
 * corner where a flat green meets a vertical wall and the nearest edge is the
 * *wall*, whose normal is horizontal — so the ball sits there, motionless,
 * and the shot never resolves. That single geometry mistake was responsible
 * for every multi-minute "the ball just sits there" hang in the game.
 *
 * The cure is geometric and total: **nothing in this file presents a vertical
 * face flush with a surface a ball can rest on.** `backstop()` is a banked
 * lip, not a wall. `wall()` splays into chamfered feet. Gulch floors are
 * `basin()` bowls whose ends rise into the cliffs. Anything else standing on
 * the deck gets `feet()`. A ball always finds ground with "up" in it.
 *
 * Ranges you can design against (standard ball, gravity −22, drag as tuned):
 *   full power ≈ 94 m carry at 45°, peak 26 m; 51 m straight up
 *   ¾ power    ≈ 63 m carry, peak 17 m
 *   ½ power    ≈ 35 m carry, peak 9 m
 *
 * Ground surfaces are wound left-to-right so their left-hand normal points up
 * out of the ground — the physics solver relies on that convention.
 */
import type {
  Course,
  CourseTheme,
  Hole,
  PropSpec,
  Surface,
  SurfaceMaterial,
  System,
  SystemFactory,
  Vec2,
} from "../types";
import { v2 } from "../types";

// ---------------------------------------------------------------------------
// Primitive builders (exported — other modules import these)
// ---------------------------------------------------------------------------

/**
 * Build a ground profile from control points, sampled into a smooth polyline.
 * Uses Catmull-Rom so authored hills are round rather than faceted.
 */
export function ground(
  pts: [number, number][],
  material: Surface["material"] = "fairway",
  step = 1.1,
): Surface {
  const cps = pts.map(([x, y]) => v2(x, y));
  if (cps.length < 2) return { points: cps, material };

  const out: Vec2[] = [];
  const at = (i: number) => cps[Math.max(0, Math.min(cps.length - 1, i))];

  for (let i = 0; i < cps.length - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const span = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const n = Math.max(2, Math.ceil(span / step));
    for (let s = 0; s < n; s++) {
      const t = s / n;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push(
        v2(
          0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
          0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
        ),
      );
    }
  }
  out.push(cps[cps.length - 1]);
  return { points: out, material };
}

/** An axis-aligned solid block — platforms, walls, buildings. */
export function block(
  x: number, y: number, w: number, h: number,
  material: Surface["material"] = "stone",
  id?: string,
): Surface {
  return {
    // Counter-clockwise so left-hand normals point outward.
    points: [v2(x, y), v2(x + w, y), v2(x + w, y + h), v2(x, y + h)],
    material,
    closed: true,
    ...(id ? { id } : {}),
  };
}

// ---------------------------------------------------------------------------
// Authoring vocabulary
// ---------------------------------------------------------------------------

type Pt = [number, number];
/** A material-tagged run of terrain. Consecutive spans share their endpoints. */
type Span = [SurfaceMaterial, ...Pt[]];
/** A prop that needs real geometry to stand on — returned as one unit. */
interface Kit { s: Surface[]; p: PropSpec[] }
type Part = Surface | PropSpec | Kit | Part[];

const rad = (deg: number) => (deg * Math.PI) / 180;

/**
 * A left-to-right terrain profile split into material bands. Author the bands
 * so each one starts where the last ended and the joins are invisible:
 *   terrain(["fairway", [-8, 10], [30, 9]], ["green", [30, 9], [46, 9]])
 */
function terrain(...spans: Span[]): Surface[] {
  return spans.map(([material, ...pts]) => ground(pts, material));
}

/**
 * A plateau: a solid body with a thin cap of playing surface on top, so a
 * stone cliff can wear a grass green without the two fighting for the contact.
 */
function mesa(
  x0: number, x1: number, top: number,
  cap: SurfaceMaterial = "fairway",
  base = -10,
  body: SurfaceMaterial = "stone",
): Surface[] {
  const w = x1 - x0;
  const capH = Math.min(0.8, Math.max(0.2, (top - base) * 0.4));
  return [
    block(x0, base, w, top - base - capH, body),
    block(x0, top - capH, w, capH, cap),
  ];
}

/** A thin floating slab — sky islands, ledges, catwalks. */
function plat(x0: number, x1: number, top: number, material: SurfaceMaterial = "stone", thick = 2.6): Surface {
  return block(x0, top - thick, x1 - x0, thick, material);
}

/**
 * A vertical wall standing on the ground.
 *
 * The bottom corners splay into 45° feet whose outer tips are buried just
 * under the deck. That chamfer is not decoration: a ball that rolls up against
 * a raw vertical face reports a horizontal contact normal, which the solver's
 * settle test reads as "unsupported", so the ball sits there motionless while
 * the shot clock runs out. A buried foot hands it back a normal with real "up"
 * in it and the ball settles in a quarter of a second. Burying the tip matters
 * too — a foot that starts exactly at deck height just moves the bad normal
 * out to its own knife edge.
 *
 * `cap` re-materials the top 0.5 m. Use it whenever the top of the wall is
 * something a ball can land on and the body is springy: a ball on a rubber
 * roof bounces for half a minute.
 */
function wall(
  x: number, y0: number, y1: number, w = 3,
  material: SurfaceMaterial = "stone",
  cap?: SurfaceMaterial,
): Surface[] {
  const f = Math.max(0.2, Math.min(0.9, w * 0.4, (y1 - y0) * 0.3));
  const body: Surface = {
    points: [
      v2(x - f * 1.6, y0 - f * 0.6), v2(x + w + f * 1.6, y0 - f * 0.6),
      v2(x + w, y0 + f), v2(x + w, y1),
      v2(x, y1), v2(x, y0 + f),
    ],
    material,
    closed: true,
  };
  return cap ? [body, block(x, y1, w, 0.5, cap)] : [body];
}

/**
 * A slab hanging in the air — roofs, overhangs, canopies. `under` is its
 * underside. `cap` re-materials the top face for the same reason `wall` has
 * one: the underside wants to be rubber or metal, the walkable top does not.
 */
function roof(
  x0: number, x1: number, under: number, thick = 5,
  material: SurfaceMaterial = "stone",
  cap?: SurfaceMaterial,
): Surface[] {
  const body = block(x0, under, x1 - x0, thick, material);
  return cap ? [body, block(x0, under + thick, x1 - x0, 0.7, cap)] : [body];
}

/** A lethal basin. `top` is the waterline; the ball dies the instant it touches. */
function pool(x0: number, x1: number, top: number, material: SurfaceMaterial = "water", depth = 6): Surface {
  return block(x0, top - depth, x1 - x0, depth, material);
}

/**
 * A solid whose top face is a sampled curve — the general shape behind banks,
 * lips and bowls. Wound to match `block()`.
 */
function bank(profile: Pt[], base: number, material: SurfaceMaterial = "rough"): Surface {
  const top = ground(profile, material, 0.55).points;
  const pts: Vec2[] = [v2(top[0].x, base), v2(top[top.length - 1].x, base)];
  for (let i = top.length - 1; i >= 0; i--) pts.push(v2(top[i].x, top[i].y));
  return { points: pts, material, closed: true };
}

/**
 * A green with a bank behind it, so a hot approach is caught and fed back to
 * the pin instead of lost. Deliberately *not* a wall: the toe rolls out of the
 * putting surface at a few degrees and steepens to about 60°, so there is no
 * crease for a ball to die in and a fast approach spends its speed climbing.
 */
function backstop(x: number, y: number, h = 7, material: SurfaceMaterial = "rough"): Surface[] {
  const run = Math.max(3, h * 0.7);
  return [
    // Deck under the mound. Ground bands are extruded down to the hole floor
    // by the renderer; closed solids are not — so without this strip the bank
    // hangs in the sky with daylight beneath it. Buried inside the bank, so
    // the ball never touches it.
    ground([[x, y - 0.07], [x + run + 2.6, y - 0.07]], material, 4),
    bank(
      [
        [x - 1.8, y - 0.06],
        [x + run * 0.30, y + h * 0.26],
        [x + run * 0.72, y + h * 0.78],
        [x + run, y + h],
        [x + run + 2.6, y + h + 0.4],
      ],
      y - 2.5,
      material,
    ),
  ];
}

/**
 * A gulch floor. Shaped as a shallow bowl whose ends rise into the cliffs at
 * about 22° — steeper than rough can hold, so a ball that drops in always
 * trickles to the middle and stops there rather than wedging against a wall.
 */
function basin(x0: number, x1: number, top: number, material: SurfaceMaterial = "rough", drop = 1.6): Surface {
  const m = (x0 + x1) * 0.5;
  return ground(
    [[x0, top], [x0 + 4, top - drop], [m, top - drop * 0.85], [x1 - 4, top - drop], [x1, top]],
    material,
  );
}

/** A 45° wedge tucked into the crease where a face meets the deck. */
function fillet(x: number, y: number, dir: 1 | -1, size = 1.0, material: SurfaceMaterial = "stone"): Surface {
  return {
    points: dir > 0
      ? [v2(x, y), v2(x + size, y), v2(x, y + size)]
      : [v2(x - size, y), v2(x, y), v2(x, y + size)],
    material,
    closed: true,
  };
}

/** Both feet of something standing on the deck — breakables, towers, panels. */
function feet(x0: number, x1: number, y: number, material: SurfaceMaterial = "stone"): Surface[] {
  return [fillet(x0, y, -1, 1.0, material), fillet(x1, y, 1, 1.0, material)];
}

/** A threading gap: two towers with a window between `lo` and `hi`. */
function keyhole(x: number, base: number, lo: number, hi: number, top: number, w = 3, material: SurfaceMaterial = "stone"): Surface[] {
  return [
    ...wall(x, base, lo, w, material),
    block(x, hi, w, top - hi, material),
  ];
}

// --- Props ------------------------------------------------------------------

const bumper = (x: number, y: number, r = 1.3, power = 19): PropSpec =>
  ({ kind: "bumper", at: v2(x, y), size: v2(r, r), power });

/** A directed blast column. `deg` is the direction it blows. */
const fan = (x: number, y: number, w: number, h: number, deg: number, power = 32): PropSpec =>
  ({ kind: "fan", at: v2(x, y), size: v2(w * 0.5, h * 0.5), angle: rad(deg), power });

/** A broad region of moving air — softer than a fan, and it never stops. */
const windZone = (x0: number, x1: number, y0: number, y1: number, deg: number, power = 11): PropSpec =>
  ({
    kind: "windZone",
    at: v2((x0 + x1) * 0.5, (y0 + y1) * 0.5),
    size: v2((x1 - x0) * 0.5, (y1 - y0) * 0.5),
    angle: rad(deg),
    power,
  });

/** A pad that adds speed along `deg` to anything crossing it. */
const boost = (x: number, y: number, deg: number, power = 24): PropSpec =>
  ({ kind: "boost", at: v2(x, y), size: v2(1.8, 0.6), angle: rad(deg), power });

/** A cannon swallows anything passing within ~1.8 m and fires it along `deg`. */
const cannon = (x: number, y: number, deg: number, power = 34): PropSpec =>
  ({ kind: "cannon", at: v2(x, y), size: v2(1.5, 1.5), angle: rad(deg), power });

/**
 * A linked portal pair. Each mouth is `[x, y, facing]`, where facing is the
 * direction the mouth looks *out* of: point the entry back at the incoming
 * ball and the exit where you want the ball to leave, and the transit rotation
 * takes care of itself.
 */
function portals(id: string, a: [number, number, number], b: [number, number, number], r = 2.0): PropSpec[] {
  const mk = (suffix: string, m: [number, number, number], link: string): PropSpec => ({
    kind: "portal",
    id: `${id}${suffix}`,
    at: v2(m[0], m[1]),
    size: v2(0.55, r),
    angle: rad(m[2]),
    link,
  });
  return [mk("in", a, `${id}out`), mk("out", b, `${id}in`)];
}

/**
 * A driven belt. The slab is real geometry, so the hole plays as a plain
 * bridge if nothing ever drives it; a positive `speed` pushes with the hole,
 * a negative one shoves you back toward the tee.
 */
function belt(x0: number, x1: number, top: number, speed: number, material: SurfaceMaterial = "metal"): Kit {
  const id = `belt${Math.round(x0)}_${Math.round(top)}`;
  return {
    s: [block(x0, top - 1.4, x1 - x0, 1.4, material, id)],
    p: [{
      kind: "conveyor",
      id,
      at: v2((x0 + x1) * 0.5, top),
      size: v2((x1 - x0) * 0.5, 0.7),
      angle: speed >= 0 ? 0 : Math.PI,
      speed: Math.abs(speed),
      material,
    }],
  };
}

/**
 * A moving platform. The slab is authored at the position that keeps the hole
 * solvable, and the `path` is a loop through world-space waypoints for its
 * centre — so a mover system animates it, and its absence just leaves a ledge.
 */
function lift(id: string, x0: number, x1: number, top: number, path: Pt[], speed = 3.4, material: SurfaceMaterial = "metal"): Kit {
  const thick = 1.6;
  return {
    s: [block(x0, top - thick, x1 - x0, thick, material, id)],
    p: [{
      kind: "mover",
      id,
      at: v2((x0 + x1) * 0.5, top - thick * 0.5),
      size: v2((x1 - x0) * 0.5, thick * 0.5),
      path: path.map(([px, py]) => v2(px, py)),
      speed,
      material,
    }],
  };
}

/**
 * A breakable slab. Real geometry plus the prop that lets a hazard system
 * dissolve it — used for bridges you burn behind you and walls you can smash
 * *or* go around. Never used where removing it would strand the ball.
 */
function breakable(x0: number, x1: number, y0: number, y1: number, material: SurfaceMaterial = "wood"): Kit {
  const id = `brk${Math.round(x0)}_${Math.round(y0)}`;
  return {
    s: [block(x0, y0, x1 - x0, y1 - y0, material, id)],
    p: [{
      kind: "breakable",
      id,
      at: v2((x0 + x1) * 0.5, (y0 + y1) * 0.5),
      size: v2((x1 - x0) * 0.5, (y1 - y0) * 0.5),
      material,
    }],
  };
}

// ---------------------------------------------------------------------------
// Hole assembly
// ---------------------------------------------------------------------------

/** Ball radius is 0.32 m; drop it just clear of the turf and let it settle. */
const TEE_LIFT = 0.5;
/** The cup sits a touch proud of the green so a rolling ball is captured. */
const CUP_LIFT = 0.42;

interface HoleSpec {
  name: string;
  par: number;
  hint: string;
  /** Ground point the ball is teed above. */
  tee: Pt;
  /** Ground point the cup is cut into. */
  cup: Pt;
  parts: Part[];
  /** Kill plane and camera floor. Defaults to 6 m under the lowest geometry. */
  floor?: number;
  /** Horizontal play limits. Defaults to 6 m outside the geometry. */
  span?: [number, number];
  /** Camera ceiling. Defaults to 34 m over the highest geometry. */
  ceil?: number;
  id?: string;
}

function collect(parts: Part[], s: Surface[], p: PropSpec[]): void {
  for (const part of parts) {
    if (Array.isArray(part)) collect(part, s, p);
    else if ((part as Surface).points !== undefined) s.push(part as Surface);
    else if ((part as PropSpec).kind !== undefined) p.push(part as PropSpec);
    else {
      const kit = part as Kit;
      for (const q of kit.s) s.push(q);
      for (const q of kit.p) p.push(q);
    }
  }
}

/**
 * Flatten a spec into a `Hole`, deriving bounds from the geometry. Deriving
 * rather than hand-authoring them removes a whole class of bug: a hole whose
 * bounds quietly clip the very platform you have to land on.
 *
 * The floor is the kill plane, so it is kept as close under the geometry as
 * the hole allows: a ball that leaves the hole should be adjudicated in under
 * a second, not after a long silent fall.
 */
function makeHole(spec: HoleSpec, theme: CourseTheme, id: string): Hole {
  const surfaces: Surface[] = [];
  const props: PropSpec[] = [];
  collect(spec.parts, surfaces, props);

  let minX = Math.min(spec.tee[0], spec.cup[0]);
  let maxX = Math.max(spec.tee[0], spec.cup[0]);
  let minY = Math.min(spec.tee[1], spec.cup[1]);
  let maxY = Math.max(spec.tee[1], spec.cup[1]);
  for (const s of surfaces) {
    for (const q of s.points) {
      if (q.x < minX) minX = q.x;
      if (q.x > maxX) maxX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.y > maxY) maxY = q.y;
    }
  }

  return {
    id,
    name: spec.name,
    par: spec.par,
    theme,
    hint: spec.hint,
    tee: v2(spec.tee[0], spec.tee[1] + TEE_LIFT),
    cup: v2(spec.cup[0], spec.cup[1] + CUP_LIFT),
    surfaces,
    props,
    bounds: {
      min: v2(spec.span ? spec.span[0] : minX - 6, spec.floor ?? minY - 6),
      max: v2(spec.span ? spec.span[1] : maxX + 6, spec.ceil ?? maxY + 34),
    },
  };
}

function makeCourse(
  meta: { id: string; name: string; theme: CourseTheme; blurb: string; unlockAt: number },
  specs: HoleSpec[],
): Course {
  return {
    id: meta.id,
    name: meta.name,
    theme: meta.theme,
    blurb: meta.blurb,
    unlockAt: meta.unlockAt,
    holes: specs.map((s, i) => makeHole(s, meta.theme, s.id ?? `${meta.id}-${i + 1}`)),
  };
}

// ===========================================================================
// 1 — SUNSET LINKS (seaside). The swing, the surfaces, the first prop.
// ===========================================================================

const SUNSET_LINKS: HoleSpec[] = [
  {
    // The first hole anyone plays, so it teaches the shape of every other one:
    // three flat plateaus — tee, fairway, green — joined by short rough banks,
    // a bunker guarding the front, and a grass bank behind the pin that feeds
    // a long approach back down to the cup. Nothing here rolls forever and
    // nothing here is invisible.
    name: "Opening Drive",
    par: 3,
    hint: "Drag back from the ball and let go. Further back is harder.",
    tee: [6, 10],
    cup: [80.6, 9.6],
    parts: [
      terrain(
        ["fairway", [-10, 10], [6, 10], [20, 10]],
        ["rough", [20, 10], [25, 9.4], [30, 8.6]],
        ["fairway", [30, 8.6], [38, 8.6], [46, 8.6]],
        ["sand", [46, 8.6], [50, 8.1], [54, 8.6]],
        ["rough", [54, 8.6], [56.5, 9.1], [59, 9.6]],
        ["green", [59, 9.6], [70, 9.6], [83, 9.6]],
      ),
      backstop(83, 9.6, 6),
    ],
  },
  {
    name: "Over the Drink",
    par: 3,
    hint: "Water ends the shot. Carry it, or lay up short and take your three.",
    tee: [6, 11],
    cup: [86, 11],
    parts: [
      terrain(["fairway", [-8, 11], [16, 11], [28, 11.4], [34, 11]]),
      wall(32, 5, 11, 2),
      pool(34, 62, 6.5, "water", 5),
      wall(62, 5, 11, 2),
      terrain(
        ["fairway", [64, 11], [78, 11]],
        ["green", [78, 11], [88, 11], [98, 11]],
      ),
      backstop(98, 11, 6),
    ],
  },
  {
    name: "Bunker Beach",
    par: 4,
    hint: "Sand eats roll. Fly the traps or resign yourself to a chip out.",
    tee: [6, 10],
    cup: [108, 12],
    parts: [
      terrain(
        ["fairway", [-8, 10], [18, 10], [34, 9.4]],
        ["sand", [34, 9.4], [42, 8.8], [48, 9.4]],
        ["fairway", [48, 9.4], [66, 10.6], [80, 12]],
        ["sand", [80, 12], [86, 11.4], [92, 11.6]],
        ["fairway", [92, 11.6], [100, 12]],
        ["green", [100, 12], [110, 12], [120, 12]],
      ),
      backstop(120, 12, 7),
    ],
  },
  {
    name: "The Rough Stuff",
    par: 3,
    hint: "Rough kills a rolling ball. The fairway comes in islands — land on one.",
    tee: [6, 10],
    cup: [91, 11],
    parts: [
      terrain(
        ["fairway", [-8, 10], [16, 10]],
        ["rough", [16, 10], [28, 9.4], [40, 9]],
        ["fairway", [40, 9], [48, 9], [56, 9]],
        ["rough", [56, 9], [66, 9.4], [74, 10]],
        ["fairway", [74, 10], [84, 10.8]],
        ["green", [84, 11], [92, 11], [100, 11]],
      ),
      backstop(100, 11, 6),
    ],
  },
  {
    // Was the worst hole in the game: three shelves separated by unmarked
    // bottomless gaps rendered in the same blue as the sky, so the opening tee
    // shot vanished into a void the player never saw. Every gap is now a
    // flooded channel with its waterline five metres under the tee — in frame
    // from the moment you aim — and a pale sand apron marks the lip you are
    // standing on. Falling in costs a stroke, which is what it should cost.
    name: "Cliff Terrace",
    par: 4,
    hint: "Three shelves, water in every gap. Take them one at a time.",
    tee: [6, 8],
    cup: [98, 22],
    parts: [
      terrain(
        ["fairway", [-10, 8], [10, 8], [19, 8]],
        // A ten-metre apron of pale sand along the lip. The chasm has to be
        // legible from the tee, before the player commits — a hazard you only
        // discover on the way down is a coin flip, not difficulty.
        ["sand", [19, 8], [24, 7.9], [30, 8]],
      ),
      pool(30, 38, 4.5, "water", 5),
      mesa(38, 62, 13, "fairway", -0.5),
      pool(62, 68, 4.5, "water", 5),
      mesa(68, 84, 18, "rough", -0.5),
      pool(84, 90, 4.5, "water", 5),
      mesa(90, 122, 22, "green", -0.5),
      backstop(122, 22, 7),
    ],
    floor: -4,
  },
  {
    name: "Backboard",
    par: 3,
    hint: "The green is small. The rubber wall behind it is not — use it.",
    tee: [6, 10],
    cup: [90, 10],
    parts: [
      terrain(
        ["fairway", [-8, 10], [24, 10], [44, 9.4], [62, 10], [70, 10]],
        ["sand", [70, 10], [76, 9.6], [84, 10]],
        ["green", [84, 10], [90, 10], [96, 10]],
      ),
      wall(97, 10, 28, 3, "rubber"),
    ],
  },
  {
    name: "Bell Buoy",
    par: 3,
    hint: "Buoys kick a low ball onward. Or just fly the whole bay.",
    tee: [6, 10],
    cup: [99, 10],
    parts: [
      terrain(["fairway", [-8, 10], [16, 10], [26, 10.3], [30, 10]]),
      wall(28, 4, 10, 2),
      pool(30, 74, 4.5),
      wall(74, 4, 10, 2),
      terrain(
        ["fairway", [76, 10], [90, 10]],
        ["green", [90, 10], [100, 10], [110, 10]],
      ),
      backstop(110, 10, 6),
      bumper(42, 9, 1.4),
      bumper(56, 12.5, 1.4),
      bumper(66, 8.5, 1.2),
    ],
  },
  {
    // The fairway runs unbroken under the towers now. The window is still the
    // only way through at ground level, but a weak shot rests against the
    // stonework instead of dropping into a hole that was never drawn.
    name: "The Keyhole",
    par: 3,
    hint: "A four-metre window at head height, or a very brave lob over the top.",
    tee: [6, 10],
    cup: [96, 10],
    parts: [
      terrain(
        ["fairway", [-8, 10], [20, 10], [34, 10], [52, 9.6], [66, 9.6]],
        ["sand", [66, 9.6], [74, 9.2], [82, 9.6]],
        ["fairway", [82, 9.6], [88, 10]],
        ["green", [88, 10], [96, 10], [106, 10]],
      ),
      keyhole(44, 10, 16, 20.5, 30),
      backstop(106, 10, 6),
    ],
  },
  {
    name: "Long Point",
    par: 5,
    hint: "Sand, then water, then a climb. Three good swings beats one heroic one.",
    tee: [6, 10],
    cup: [136, 20],
    parts: [
      terrain(
        ["fairway", [-8, 10], [22, 10], [34, 9.4]],
        ["sand", [34, 9.4], [44, 9], [52, 9.4]],
        ["fairway", [52, 9.4], [62, 10.6], [70, 11]],
      ),
      wall(68, 5, 11, 2),
      pool(70, 100, 5.5),
      wall(100, 5, 11, 2),
      terrain(
        ["fairway", [102, 11], [110, 11.6]],
        ["rough", [110, 11.6], [118, 13]],
      ),
      mesa(118, 154, 20, "green", -6),
      backstop(154, 20, 8),
      bumper(86, 14, 1.3),
    ],
  },

  // --- back nine -----------------------------------------------------------
  // The sea takes over: bigger carries, a standing onshore breeze, and greens
  // that sit on rock with nothing behind them but water.
  {
    // The seaward face of the dune is sand, not grass. That is not decoration:
    // a 17° grass face is steeper than fairway can hold, so a ball landing on
    // it would run to the bottom every time. Sand holds to 49°.
    name: "Dune Ridge",
    par: 4,
    hint: "A blind approach over the dune. Land on the crest and let it feed down.",
    tee: [6, 10],
    cup: [86, 11],
    parts: [
      terrain(
        ["fairway", [-10, 10], [10, 10], [22, 10]],
        ["rough", [22, 10], [33, 13.4], [44, 16.5]],
        ["sand", [44, 16.5], [52, 13], [60, 11]],
        ["fairway", [60, 11], [68, 11], [74, 11]],
        ["green", [74, 11], [86, 11], [98, 11]],
      ),
      backstop(98, 11, 7),
    ],
  },
  {
    name: "Tide Pools",
    par: 4,
    hint: "Two channels and a twelve-metre island between them. Weight the first one.",
    tee: [6, 10],
    cup: [92, 10],
    parts: [
      terrain(["fairway", [-8, 10], [16, 10], [26, 10]]),
      wall(24, 4, 10, 2),
      pool(26, 40, 6, "water", 5),
      wall(40, 4, 10, 2),
      terrain(["fairway", [42, 10], [48, 10], [54, 10]]),
      wall(54, 4, 10, 2),
      pool(56, 72, 6, "water", 5),
      wall(72, 4, 10, 2),
      terrain(
        ["fairway", [74, 10], [82, 10]],
        ["green", [82, 10], [92, 10], [104, 10]],
      ),
      backstop(104, 10, 7),
    ],
  },
  {
    name: "Crosswind Point",
    par: 3,
    hint: "The onshore breeze runs the whole bay. Flatter and harder than it looks.",
    tee: [6, 10],
    cup: [90, 10],
    parts: [
      terrain(["fairway", [-8, 10], [18, 10], [30, 10]]),
      wall(30, 3, 10, 2),
      pool(32, 72, 4.5),
      wall(72, 3, 10, 2),
      terrain(
        ["fairway", [74, 10], [80, 10]],
        ["green", [80, 10], [90, 10], [100, 10]],
      ),
      backstop(100, 10, 7),
      windZone(32, 74, 8, 40, 180, 12),
    ],
  },
  {
    // Two carries, not one. The tee sits high enough to reach the sandbar in a
    // single ¾ swing; nothing gets you the whole way in one, and the breeze is
    // there to punish anyone who tries.
    name: "Sandbar Crossing",
    par: 4,
    hint: "Two carries with a sandbar between. Nobody reaches this green off the tee.",
    tee: [6, 16],
    cup: [118, 12],
    parts: [
      mesa(-8, 26, 16, "fairway", -2),
      pool(26, 60, 4, "water", 6),
      mesa(60, 76, 7, "sand", -2),
      pool(76, 100, 4, "water", 6),
      mesa(100, 140, 12, "green", -2),
      backstop(140, 12, 8),
      windZone(26, 100, 6, 40, 180, 9),
    ],
    floor: -4,
  },
  {
    name: "Buoy Field",
    par: 4,
    hint: "Four buoys across the bay. A low ball can ride them; a high one is on its own.",
    tee: [6, 10],
    cup: [106, 10],
    parts: [
      terrain(["fairway", [-8, 10], [16, 10], [28, 10]]),
      wall(28, 2, 10, 2),
      pool(30, 86, 4),
      wall(86, 2, 10, 2),
      terrain(
        ["fairway", [88, 10], [96, 10]],
        ["green", [96, 10], [106, 10], [116, 10]],
      ),
      backstop(116, 10, 7),
      bumper(40, 13, 1.5),
      bumper(52, 19, 1.5),
      bumper(64, 12, 1.3),
      bumper(76, 17, 1.4),
    ],
  },
  {
    // Both windows are threadable and both towers are low enough to lob — the
    // hole is a choice between two hard shots, not one impossible one.
    name: "Twin Lights",
    par: 4,
    hint: "Two windows in a row, the second one lower. Or go over the pair of them.",
    tee: [6, 10],
    cup: [104, 10],
    parts: [
      terrain(
        ["fairway", [-8, 10], [20, 10], [36, 10], [54, 9.6], [70, 9.6]],
        ["sand", [70, 9.6], [78, 9.2], [86, 9.6]],
        ["fairway", [86, 9.6], [94, 10]],
        ["green", [94, 10], [104, 10], [116, 10]],
      ),
      keyhole(40, 10, 14, 18, 26),
      keyhole(66, 9.6, 12, 16, 24),
      backstop(116, 10, 7),
    ],
  },
  {
    name: "Storm Break",
    par: 4,
    hint: "Into the wind, over the water, off the seawall. The wall is the safe miss.",
    tee: [6, 10],
    cup: [104, 10],
    parts: [
      terrain(["fairway", [-8, 10], [20, 10], [34, 10]]),
      wall(34, 2, 10, 2),
      pool(36, 74, 4),
      wall(74, 2, 10, 2),
      terrain(
        ["fairway", [76, 10], [84, 10]],
        ["sand", [84, 10], [90, 9.6], [96, 10]],
        ["green", [96, 10], [104, 10], [110, 10]],
      ),
      wall(111, 10, 30, 3, "rubber"),
      windZone(36, 76, 6, 34, 180, 10),
    ],
  },
  {
    name: "The Spit",
    par: 5,
    hint: "Sand, then forty metres of channel, then a climb to a green on the rock.",
    tee: [6, 10],
    cup: [152, 20],
    parts: [
      terrain(
        ["fairway", [-8, 10], [22, 10], [36, 9.4]],
        ["sand", [36, 9.4], [46, 9], [56, 9.4]],
        ["fairway", [56, 9.4], [66, 10], [76, 10]],
      ),
      wall(76, 4, 10, 2),
      pool(78, 116, 5),
      wall(116, 4, 10, 2),
      terrain(
        ["fairway", [118, 10], [126, 10.6]],
        ["rough", [126, 10.6], [134, 13]],
      ),
      mesa(134, 172, 20, "green", -6),
      backstop(172, 20, 8),
      bumper(96, 15, 1.3),
    ],
  },
  {
    name: "Sunset Finish",
    par: 5,
    hint: "Dune, bay, buoys, island green. Everything Sunset Links has, in order.",
    tee: [6, 10],
    cup: [140, 11],
    parts: [
      terrain(
        ["fairway", [-8, 10], [18, 10], [28, 10]],
        ["rough", [28, 10], [38, 13], [48, 15.5]],
        ["sand", [48, 15.5], [56, 12], [64, 10.6]],
        ["fairway", [64, 10.6], [70, 10.6], [76, 10.6]],
      ),
      wall(76, 4, 10.6, 2),
      pool(78, 116, 5),
      wall(116, 4, 11, 2),
      bumper(90, 15, 1.4),
      bumper(104, 20, 1.4),
      terrain(
        ["fairway", [118, 11], [128, 11]],
        ["green", [128, 11], [140, 11], [152, 11]],
      ),
      backstop(152, 11, 8),
      windZone(78, 118, 8, 42, 180, 9),
    ],
  },
];

// ===========================================================================
// 2 — EMERALD HOLLOW (jungle). Ceilings, belts, caves, breakables, boosts.
// ===========================================================================

const EMERALD_HOLLOW: HoleSpec[] = [
  {
    name: "Canopy Gap",
    par: 3,
    hint: "The canopy is solid. Keep it flat and let the ground do the work.",
    tee: [6, 10],
    cup: [92, 10],
    parts: [
      terrain(
        ["fairway", [-8, 10], [20, 10], [40, 9.4], [62, 10], [84, 10]],
        ["green", [84, 10], [94, 10], [104, 10]],
      ),
      backstop(104, 10, 6),
      roof(30, 72, 20, 7, "wood"),
    ],
  },
  {
    name: "Log Roll",
    par: 3,
    hint: "The log turns against you. Carry the gorge or fight the belt across.",
    tee: [6, 10],
    cup: [86, 10],
    parts: [
      terrain(["fairway", [-8, 10], [18, 10], [34, 10]]),
      wall(32, -4, 10, 2),
      belt(36, 64, 10, -7, "wood"),
      basin(36, 64, -4),
      wall(64, -4, 10, 2),
      terrain(
        ["fairway", [66, 10], [78, 10]],
        ["green", [78, 10], [86, 10], [96, 10]],
      ),
      backstop(96, 10, 6),
    ],
  },
  {
    name: "The Grotto",
    par: 4,
    hint: "Four metres of daylight above the lip. Thread it and the cave does the rest.",
    tee: [6, 10],
    cup: [86, 10],
    parts: [
      terrain(["fairway", [-8, 10], [22, 10], [40, 9.6], [48, 10]]),
      wall(48, 10, 12, 2, "stone"),
      mesa(48, 102, 26, "rough", 16),
      terrain(
        ["fairway", [50, 10], [70, 10]],
        ["green", [70, 10], [86, 10], [96, 10]],
      ),
      backstop(96, 10, 5, "stone"),
    ],
  },
  {
    name: "Vine Lift",
    par: 4,
    hint: "Ride the platform if it's there. If it isn't, climb the hard way.",
    tee: [6, 10],
    cup: [88, 26],
    parts: [
      terrain(["fairway", [-8, 10], [18, 10], [34, 10]]),
      wall(34, -3, 10, 2),
      basin(36, 68, -3),
      lift("vine", 46, 60, 14, [[53, 14], [53, 25]], 3.2, "wood"),
      mesa(70, 110, 26, "green", -3),
      backstop(110, 26, 8),
    ],
  },
  {
    name: "Termite Wall",
    par: 3,
    hint: "Punch through the rotten timber, or loft the stone above it.",
    tee: [6, 10],
    cup: [82, 10],
    parts: [
      terrain(
        ["fairway", [-8, 10], [20, 10], [34, 10], [52, 9.4], [70, 10]],
        ["green", [70, 10], [82, 10], [94, 10]],
      ),
      backstop(94, 10, 6),
      breakable(33, 37, 10, 22),
      feet(33, 37, 10, "wood"),
      block(33, 22, 4, 6, "stone"),
    ],
  },
  {
    name: "Springboard",
    par: 4,
    hint: "The pad throws you a whole tier. Without it, take the ledges.",
    tee: [6, 10],
    cup: [98, 30],
    parts: [
      terrain(["fairway", [-8, 10], [22, 10], [40, 10]]),
      mesa(44, 62, 15, "fairway", -4),
      mesa(66, 78, 22, "rough", -4),
      mesa(82, 118, 30, "green", -4),
      backstop(118, 30, 8),
      boost(52, 15, 62, 26),
    ],
  },
  {
    name: "Slingshot Vines",
    par: 4,
    hint: "The belt gives you speed; the vines give you height. Take both.",
    tee: [6, 10],
    cup: [102, 24],
    parts: [
      terrain(["fairway", [-8, 10], [18, 10], [30, 10]]),
      belt(34, 58, 12, 12, "wood"),
      basin(34, 82, 0),
      bumper(64, 15, 1.5),
      bumper(76, 21, 1.5),
      mesa(84, 122, 24, "green", 0),
      backstop(122, 24, 8),
    ],
  },
  {
    name: "Hollow Heart",
    par: 4,
    hint: "Roll down the throat and stay under the roof — or drop in through the skylight.",
    tee: [6, 26],
    cup: [94, 8],
    parts: [
      mesa(-8, 30, 26, "fairway", -8),
      // Two roof slabs with a skylight between them: the low route runs the
      // length of the cave, the high route lands on the roof and falls in.
      roof(46, 78, 20, 14, "stone"),
      roof(88, 114, 20, 14, "stone"),
      terrain(
        ["rough", [30, 26], [36, 21], [42, 13], [50, 9], [62, 8]],
        ["fairway", [62, 8], [64, 8]],
      ),
      pool(64, 76, 4),
      terrain(
        ["fairway", [76, 8], [84, 8]],
        ["green", [84, 8], [94, 8], [106, 8]],
      ),
      backstop(106, 8, 8, "stone"),
      breakable(58, 60, 8, 12, "wood"),
      feet(58, 60, 8, "wood"),
    ],
  },
  {
    name: "Emerald Falls",
    par: 5,
    hint: "River, then belt, then the pit. Every stage has a safe landing.",
    tee: [6, 10],
    cup: [134, 22],
    parts: [
      terrain(["fairway", [-8, 10], [20, 10], [34, 10]]),
      pool(34, 52, 6),
      wall(32, 4, 10, 2),
      terrain(["rough", [54, 10], [66, 12], [70, 13]]),
      belt(72, 94, 15, 10, "wood"),
      boost(88, 15, 42, 22),
      basin(94, 114, -2),
      mesa(114, 154, 22, "green", -2),
      backstop(154, 22, 8),
    ],
  },

  // --- back nine -----------------------------------------------------------
  // The jungle closes in: lower canopies, belts that fight you, gates that
  // have to be smashed or lobbed, and a gorge with a vine lift in it.
  {
    name: "Low Canopy",
    par: 3,
    hint: "Five metres of headroom for sixty metres. There is no high route here.",
    tee: [6, 10],
    cup: [94, 10],
    parts: [
      terrain(
        ["fairway", [-8, 10], [24, 10], [48, 9.6], [72, 10], [84, 10]],
        ["green", [84, 10], [94, 10], [104, 10]],
      ),
      roof(26, 80, 15, 6, "wood"),
      backstop(104, 10, 6),
    ],
  },
  {
    // Two logs turning opposite ways with a four-metre gap between them. The
    // gap is the hole: land short and the first belt walks you back into it.
    name: "Twin Logs",
    par: 4,
    hint: "The near log turns against you, the far one with you. Mind the gap between.",
    tee: [6, 10],
    cup: [100, 10],
    parts: [
      terrain(["fairway", [-8, 10], [16, 10], [28, 10]]),
      wall(28, -4, 10, 2),
      belt(30, 52, 10, -8, "wood"),
      basin(30, 80, -4),
      belt(56, 80, 10, 8, "wood"),
      wall(80, -4, 10, 2),
      terrain(
        ["fairway", [82, 10], [90, 10]],
        ["green", [90, 10], [100, 10], [110, 10]],
      ),
      backstop(110, 10, 6),
    ],
  },
  {
    // Both gates cap out well under the peak of a full swing, so the lob is a
    // real route even if nothing ever dissolves the rotten timber.
    name: "Rot Gate",
    par: 4,
    hint: "Two rotten panels with stone caps. Smash through, or loft the lot.",
    tee: [6, 10],
    cup: [88, 10],
    parts: [
      terrain(
        ["fairway", [-8, 10], [20, 10], [36, 10], [56, 9.6], [76, 10]],
        ["green", [76, 10], [88, 10], [98, 10]],
      ),
      backstop(98, 10, 6),
      breakable(34, 38, 10, 18),
      feet(34, 38, 10, "wood"),
      block(34, 18, 4, 4, "stone"),
      breakable(58, 62, 10, 16),
      feet(58, 62, 10, "wood"),
      block(58, 16, 4, 4, "stone"),
    ],
  },
  {
    // A seventy-metre carry from a high tee to a higher green, with a vine
    // lift as the patient route out of the gorge for anyone who comes up short.
    name: "Emerald Chasm",
    par: 4,
    hint: "Carry the gorge or take the vine up. The floor is survivable, barely.",
    tee: [6, 18],
    cup: [100, 24],
    parts: [
      mesa(-8, 30, 18, "fairway", -8),
      wall(30, -8, 18, 2),
      basin(32, 74, -8),
      lift("hollow", 44, 58, 4, [[51, 4], [51, 17]], 3.4, "wood"),
      bumper(66, 2, 1.4),
      wall(74, -8, 24, 2),
      mesa(76, 118, 24, "green", -8),
      backstop(118, 24, 8),
    ],
    floor: -14,
  },
  {
    name: "Boost Ladder",
    par: 4,
    hint: "Each pad throws you exactly one tier. Land on the pad, not past it.",
    tee: [6, 10],
    cup: [104, 32],
    parts: [
      terrain(["fairway", [-8, 10], [22, 10], [38, 10]]),
      mesa(42, 58, 16, "fairway", -4),
      boost(50, 16, 64, 24),
      mesa(64, 78, 24, "rough", -4),
      boost(72, 24, 58, 22),
      mesa(84, 124, 32, "green", -4),
      backstop(124, 32, 8),
    ],
  },
  {
    name: "Under the Roots",
    par: 4,
    hint: "Four metres of daylight at the mouth, then a log turning against you.",
    tee: [6, 10],
    cup: [92, 10],
    parts: [
      terrain(["fairway", [-8, 10], [22, 10], [38, 9.6], [46, 10]]),
      wall(46, 10, 13, 2, "stone"),
      mesa(46, 110, 28, "rough", 17),
      belt(48, 74, 10, -8, "wood"),
      terrain(
        ["fairway", [74, 10], [82, 10]],
        ["green", [82, 10], [92, 10], [102, 10]],
      ),
      backstop(102, 10, 5, "stone"),
    ],
  },
  {
    name: "Skylight",
    par: 4,
    hint: "Roll the throat and stay low, or drop through the gap in the roof.",
    tee: [6, 24],
    cup: [90, 9.6],
    parts: [
      mesa(-8, 24, 24, "fairway", -6),
      terrain(
        ["rough", [24, 24], [32, 18], [40, 12], [48, 9.6]],
        ["fairway", [48, 9.6], [62, 9.6], [76, 9.6]],
        ["green", [76, 9.6], [90, 9.6], [104, 9.6]],
      ),
      roof(38, 72, 15, 10, "stone"),
      roof(82, 116, 15, 10, "stone"),
      backstop(104, 9.6, 8, "stone"),
      bumper(60, 12.5, 1.2),
    ],
  },
  {
    name: "Rope Bridge",
    par: 5,
    hint: "A log, then a plank, then open air. Every stage is a separate decision.",
    tee: [6, 10],
    cup: [120, 20],
    parts: [
      terrain(["fairway", [-8, 10], [18, 10], [30, 10]]),
      wall(30, -8, 10, 2),
      basin(32, 78, -8),
      belt(32, 56, 10, -7, "wood"),
      breakable(60, 70, 9, 10.4, "wood"),
      wall(78, -8, 10, 2),
      terrain(["fairway", [80, 10], [88, 10], [96, 10]]),
      mesa(100, 140, 20, "green", -8),
      backstop(140, 20, 8),
    ],
  },
  {
    name: "Emerald Crown",
    par: 5,
    hint: "Canopy, log, pit, vines. Everything the hollow has, with no rests.",
    tee: [6, 10],
    cup: [116, 26],
    parts: [
      terrain(["fairway", [-8, 10], [20, 10], [34, 10]]),
      roof(22, 46, 16, 5, "wood"),
      belt(34, 62, 10, 9, "wood"),
      basin(62, 90, 0),
      bumper(74, 12, 1.5),
      bumper(86, 18, 1.5),
      mesa(92, 136, 26, "green", 0),
      backstop(136, 26, 8),
    ],
  },
];

// ===========================================================================
// 3 — RED MESA (canyon). Chasms, wind, and the cannon.
// ===========================================================================

const RED_MESA: HoleSpec[] = [
  {
    // The gaps between terraces read as a canyon river rather than as blue
    // nothing, so it is obvious from the tee what a short shot costs.
    name: "Mesa Steps",
    par: 3,
    hint: "Three terraces over the river. Each one is an easy hop from the last.",
    tee: [6, 8],
    cup: [98, 26],
    parts: [
      terrain(["fairway", [-8, 8], [18, 8], [26, 8]]),
      pool(26, 30, 1.5, "water", 5),
      mesa(30, 50, 14, "fairway", -3),
      pool(50, 54, 1.5, "water", 5),
      mesa(54, 76, 20, "rough", -3),
      pool(76, 80, 1.5, "water", 5),
      mesa(80, 116, 26, "green", -3),
      backstop(116, 26, 8, "stone"),
    ],
    floor: -8,
  },
  {
    name: "The Chasm",
    par: 4,
    hint: "Forty metres of nothing. Down in the gulch is survivable — barely.",
    tee: [6, 12],
    cup: [112, 12],
    parts: [
      terrain(["fairway", [-8, 12], [24, 12], [40, 12]]),
      wall(40, -14, 12, 2),
      basin(42, 82, -14),
      wall(82, -14, 12, 2),
      terrain(
        ["fairway", [84, 12], [100, 12]],
        ["green", [100, 12], [112, 12], [124, 12]],
      ),
      backstop(124, 12, 7, "stone"),
    ],
  },
  {
    name: "Wind Gorge",
    par: 3,
    hint: "The gorge blows straight back at you. Hit it lower and harder.",
    tee: [6, 10],
    cup: [90, 10],
    parts: [
      terrain(["fairway", [-8, 10], [20, 10], [32, 10]]),
      wall(32, -10, 10, 2),
      basin(34, 68, -10),
      wall(68, -10, 10, 2),
      terrain(
        ["fairway", [70, 10], [80, 10]],
        ["green", [80, 10], [90, 10], [102, 10]],
      ),
      backstop(102, 10, 7, "stone"),
      windZone(32, 70, 8, 34, 180, 12),
    ],
  },
  {
    name: "Powder Keg",
    par: 4,
    hint: "Roll into the cannon and it does the flying. Or carry the gulch yourself.",
    tee: [6, 10],
    cup: [106, 10],
    parts: [
      terrain(["fairway", [-8, 10], [24, 10], [40, 10], [52, 10]]),
      cannon(44, 11.2, 60, 40),
      wall(52, -12, 10, 2),
      basin(54, 82, -12),
      wall(82, -12, 10, 2),
      terrain(
        ["fairway", [84, 10], [96, 10]],
        ["green", [96, 10], [106, 10], [118, 10]],
      ),
      backstop(118, 10, 7, "stone"),
    ],
  },
  {
    name: "Slot Canyon",
    par: 4,
    hint: "Under the overhang, into the pocket, then straight up over the rubber.",
    tee: [6, 10],
    cup: [92, 10],
    parts: [
      terrain(
        ["fairway", [-8, 10], [22, 10], [38, 10]],
        ["sand", [38, 10], [46, 9.7], [52, 10]],
        ["fairway", [55, 10], [70, 9.4], [84, 10]],
        ["green", [84, 10], [94, 10], [104, 10]],
      ),
      backstop(104, 10, 7, "stone"),
      roof(40, 44, 18, 16, "stone"),
      wall(52, 10, 28, 3, "rubber"),
    ],
  },
  {
    name: "Hoodoo Alley",
    par: 4,
    hint: "Four spires in a row. A clean drive flies over the lot of them.",
    tee: [6, 10],
    cup: [116, 10],
    parts: [
      terrain(
        ["fairway", [-8, 10], [22, 10], [46, 9.4], [70, 10], [96, 10]],
        ["fairway", [96, 10], [104, 10]],
        ["green", [104, 10], [116, 10], [128, 10]],
      ),
      backstop(128, 10, 7, "stone"),
      wall(34, 10, 24, 2.5),
      wall(52, 10, 28, 2.5),
      wall(70, 10, 22, 2.5),
      wall(88, 10, 26, 2.5),
    ],
  },
  {
    name: "Updraft",
    par: 3,
    hint: "The vent lifts you a whole shelf. The ledge is the patient route.",
    tee: [6, 10],
    cup: [78, 30],
    parts: [
      terrain(["fairway", [-8, 10], [22, 10], [40, 10]]),
      mesa(43, 51, 18, "rough", -6),
      fan(47, 12, 6, 26, 90, 34),
      mesa(56, 100, 30, "green", -6),
      backstop(100, 30, 8, "stone"),
    ],
  },
  {
    name: "Double Barrel",
    par: 4,
    hint: "One cannon to the island, a second one home. Miss and it's a long way down.",
    tee: [6, 10],
    cup: [138, 14],
    parts: [
      terrain(["fairway", [-8, 10], [16, 10], [30, 10]]),
      cannon(26, 11.2, 58, 36),
      mesa(68, 90, 10, "fairway", -18),
      cannon(84, 11.2, 34, 40),
      mesa(118, 158, 14, "green", -18),
      backstop(158, 14, 8, "stone"),
    ],
    floor: -26,
  },
  {
    name: "Rimrock Run",
    par: 5,
    hint: "Headwind over the gulch, sand island halfway, then two climbs.",
    tee: [6, 10],
    cup: [146, 28],
    parts: [
      terrain(["fairway", [-8, 10], [22, 10], [38, 10]]),
      windZone(38, 82, 6, 40, 180, 10),
      mesa(58, 74, 7, "sand", -16),
      mesa(82, 120, 16, "fairway", -16),
      boost(110, 16, 55, 24),
      mesa(126, 166, 28, "green", -16),
      backstop(166, 28, 8, "stone"),
    ],
    floor: -24,
  },

  // --- back nine -----------------------------------------------------------
  // Deeper gulches, a standing headwind through most of them, and the cannon
  // stops being a novelty and starts being the only sane line.
  {
    name: "Canyon Rim",
    par: 4,
    hint: "Fifty metres of gulch with the wind coming back out of it. Stay low.",
    tee: [6, 10],
    cup: [110, 10],
    parts: [
      terrain(["fairway", [-8, 10], [22, 10], [36, 10]]),
      wall(36, -16, 10, 2),
      basin(38, 86, -16),
      windZone(38, 86, 8, 44, 180, 11),
      wall(86, -16, 10, 2),
      terrain(
        ["fairway", [88, 10], [98, 10]],
        ["green", [98, 10], [110, 10], [122, 10]],
      ),
      backstop(122, 10, 7, "stone"),
    ],
    floor: -24,
  },
  {
    name: "Hoodoo Gate",
    par: 3,
    hint: "A four-metre slot between two spires, or a very steep one over the top.",
    tee: [6, 10],
    cup: [84, 10],
    parts: [
      terrain(
        ["fairway", [-8, 10], [22, 10], [40, 9.6], [58, 10], [72, 10]],
        ["green", [72, 10], [84, 10], [96, 10]],
      ),
      wall(34, 10, 20, 2.5),
      keyhole(46, 10, 15, 19, 26),
      backstop(96, 10, 7, "stone"),
    ],
  },
  {
    name: "Red Cannon",
    par: 4,
    hint: "Roll it into the barrel. Fifty metres of gulch says do not try it yourself.",
    tee: [6, 10],
    cup: [116, 14],
    parts: [
      terrain(["fairway", [-8, 10], [20, 10], [36, 10]]),
      cannon(30, 11.2, 56, 44),
      wall(36, -18, 10, 2),
      basin(38, 92, -18),
      wall(92, -18, 14, 2),
      mesa(94, 136, 14, "green", -18),
      backstop(136, 14, 8, "stone"),
    ],
    floor: -26,
  },
  {
    // The sand island in the gulch is the whole hole. Nobody carries seventy
    // metres uphill into a ten-power headwind, and pretending otherwise is how
    // you end up on the floor of the canyon playing your fourth.
    name: "Anvil Rock",
    par: 4,
    hint: "Drop onto the sand island first. The green is not reachable off this tee.",
    tee: [6, 20],
    cup: [106, 26],
    parts: [
      mesa(-8, 26, 20, "fairway", -10),
      wall(26, -10, 20, 2),
      basin(28, 80, -10),
      mesa(46, 62, 4, "sand", -10),
      windZone(28, 84, -6, 34, 180, 10),
      wall(80, -10, 26, 2),
      mesa(82, 126, 26, "green", -10),
      backstop(126, 26, 8, "stone"),
    ],
    floor: -18,
  },
  {
    name: "Rimrock Overhang",
    par: 4,
    hint: "Seven metres of headroom under the slab, then a bank up to the shelf.",
    tee: [6, 10],
    cup: [96, 14],
    parts: [
      terrain(
        ["fairway", [-8, 10], [24, 10], [42, 10], [58, 10]],
        ["rough", [58, 10], [66, 12], [74, 14]],
        ["fairway", [74, 14], [84, 14]],
        ["green", [84, 14], [96, 14], [108, 14]],
      ),
      roof(44, 52, 17, 16, "stone"),
      backstop(108, 14, 7, "stone"),
    ],
  },
  {
    name: "Sandstone Steps",
    par: 4,
    hint: "Four terraces, six metres of climb each, river in every gap.",
    tee: [6, 8],
    cup: [116, 32],
    parts: [
      terrain(["fairway", [-8, 8], [16, 8], [24, 8]]),
      pool(24, 30, 1.5, "water", 5),
      mesa(30, 46, 14, "rough", -4),
      pool(46, 52, 1.5, "water", 5),
      mesa(52, 68, 20, "rough", -4),
      pool(68, 74, 1.5, "water", 5),
      mesa(74, 90, 26, "rough", -4),
      pool(90, 96, 1.5, "water", 5),
      mesa(96, 136, 32, "green", -4),
      backstop(136, 32, 8, "stone"),
    ],
    floor: -8,
  },
  {
    name: "Devil's Vent",
    par: 3,
    hint: "The vent lifts you the whole rim. Straight up and let the air carry it.",
    tee: [6, 10],
    cup: [72, 36],
    parts: [
      terrain(["fairway", [-8, 10], [20, 10], [34, 10]]),
      pool(34, 44, 2, "water", 5),
      fan(39, 8, 8, 32, 90, 38),
      wall(44, 2, 12, 2),
      mesa(46, 96, 36, "green", 2),
      backstop(96, 36, 8, "stone"),
    ],
  },
  {
    name: "Rattlesnake",
    par: 5,
    hint: "Headwind gulch, sand island, then a cannon off the middle shelf.",
    tee: [6, 10],
    cup: [148, 28],
    parts: [
      terrain(["fairway", [-8, 10], [20, 10], [34, 10]]),
      wall(34, -12, 10, 2),
      basin(36, 78, -12),
      mesa(52, 66, 2, "sand", -12),
      windZone(36, 80, 6, 40, 180, 10),
      wall(78, -12, 16, 2),
      mesa(80, 104, 16, "fairway", -12),
      cannon(96, 17.2, 50, 40),
      mesa(126, 168, 28, "green", -12),
      backstop(168, 28, 8, "stone"),
    ],
    floor: -20,
  },
  {
    name: "Mesa Crown",
    par: 5,
    hint: "Cannon, pad, headwind, sand shelf, summit. Red Mesa's whole hand.",
    tee: [6, 10],
    cup: [158, 30],
    parts: [
      terrain(["fairway", [-8, 10], [22, 10], [38, 10]]),
      cannon(32, 11.2, 58, 38),
      mesa(70, 88, 12, "rough", -20),
      boost(80, 12, 40, 22),
      mesa(112, 128, 18, "sand", -20),
      windZone(88, 130, 8, 46, 180, 10),
      mesa(136, 180, 30, "green", -20),
      backstop(180, 30, 8, "stone"),
    ],
    floor: -28,
  },
];

// ===========================================================================
// 4 — NEON CIRCUIT (neon). Portals, rails, boosts, bumpers.
// ===========================================================================

const NEON_CIRCUIT: HoleSpec[] = [
  {
    // The deck runs unbroken under every ring wall on this course. The wall is
    // still impassable at ground level — the ring is still the route — but a
    // short shot now stops against the panel instead of dropping into an
    // undrawn pit between the fairway and the wall.
    name: "Warp One",
    par: 3,
    hint: "That wall does not open. Post the ball through the ring instead.",
    tee: [6, 10],
    cup: [86, 10],
    parts: [
      terrain(
        ["fairway", [-8, 10], [20, 10], [34, 10], [52, 10], [76, 10]],
        ["green", [76, 10], [88, 10], [100, 10]],
      ),
      backstop(100, 10, 6, "metal"),
      wall(38, 10, 42, 4, "metal"),
      portals("w1", [36.4, 15, 180], [58, 15, 0], 2.6),
    ],
  },
  {
    name: "Bank Runner",
    par: 3,
    hint: "Six metres of headroom and a rubber ceiling. Fire it flat and let it ping.",
    tee: [6, 10],
    cup: [100, 10],
    parts: [
      terrain(
        ["fairway", [-8, 10], [24, 10], [48, 10], [72, 10]],
        ["metal", [72, 10], [92, 10]],
        ["green", [92, 10], [102, 10], [112, 10]],
      ),
      roof(30, 90, 16, 4, "rubber", "stone"),
      backstop(112, 10, 8, "metal"),
    ],
  },
  {
    name: "Right Angle",
    par: 3,
    hint: "The exit ring stands at sixty degrees. Whatever goes in, comes out climbing.",
    tee: [6, 10],
    cup: [92, 12],
    parts: [
      terrain(
        ["fairway", [-8, 10], [22, 10], [40, 10], [52, 10]],
        ["rough", [52, 10], [56, 11], [60, 12]],
        ["fairway", [60, 12], [78, 12]],
        ["green", [78, 12], [92, 12], [106, 12]],
      ),
      backstop(106, 12, 6, "metal"),
      wall(46, 10, 44, 3, "metal"),
      portals("ra", [44.4, 15, 180], [62, 13, 60], 2.4),
    ],
  },
  {
    name: "Boost Lane",
    par: 3,
    hint: "Four metres of ceiling. Keep it on the deck and let the pads do the rest.",
    tee: [6, 10],
    cup: [112, 10],
    parts: [
      terrain(
        ["metal", [-8, 10], [30, 10], [60, 10], [96, 10]],
        ["green", [96, 10], [112, 10], [124, 10]],
      ),
      roof(22, 92, 14, 4, "metal", "stone"),
      boost(34, 10, 0, 18),
      boost(58, 10, 0, 18),
      boost(82, 10, 0, 18),
      backstop(124, 10, 8, "metal"),
    ],
  },
  {
    name: "Pinball",
    par: 4,
    hint: "The bumpers hang in your flight path. Go under them or over the lot.",
    tee: [6, 10],
    cup: [100, 12],
    parts: [
      terrain(["fairway", [-8, 10], [18, 10], [32, 10]]),
      wall(32, 2, 10, 2, "rubber"),
      pool(34, 78, 2.5),
      wall(78, 2, 10, 2, "rubber"),
      bumper(44, 20, 1.6),
      bumper(58, 26, 1.6),
      bumper(70, 19, 1.4),
      mesa(80, 122, 12, "green", -4),
      backstop(122, 12, 8, "metal"),
    ],
  },
  {
    name: "Downtown Drop",
    par: 3,
    hint: "Straight down the block. Rubber facades will hand you back your mistakes.",
    tee: [6, 40],
    cup: [82, 12],
    parts: [
      mesa(-8, 22, 40, "metal", -8),
      wall(22, 20, 39.4, 2, "rubber"),
      mesa(30, 46, 30, "metal", -8),
      wall(46, 12, 29.4, 2, "rubber"),
      mesa(54, 66, 20, "metal", -8),
      terrain(
        ["metal", [70, 12], [74, 12]],
        ["green", [74, 12], [84, 12], [96, 12]],
      ),
      backstop(96, 12, 8, "metal"),
    ],
  },
  {
    name: "Grid Lock",
    par: 4,
    hint: "Smash the panel, fight the belt, then post it through the ring.",
    tee: [6, 10],
    cup: [100, 10],
    parts: [
      terrain(["fairway", [-8, 10], [16, 10], [30, 10]]),
      belt(30, 62, 10, -8),
      breakable(33, 36, 10, 22, "metal"),
      feet(33, 36, 10, "metal"),
      block(33, 22, 3, 12, "metal"),
      terrain(
        ["metal", [62, 10], [78, 10], [90, 10]],
        ["green", [90, 10], [100, 10], [112, 10]],
      ),
      wall(64, 10, 34, 3, "metal"),
      backstop(112, 10, 8, "metal"),
      portals("gl", [62.4, 15, 180], [80, 14, 0], 2.2),
    ],
  },
  {
    name: "Split Circuit",
    par: 4,
    hint: "Two rings, two routes. The high one is faster and very easy to overcook.",
    tee: [6, 10],
    cup: [108, 12],
    parts: [
      terrain(["fairway", [-8, 10], [18, 10], [32, 10], [50, 10], [78, 10]]),
      wall(36, 10, 42, 3, "metal"),
      mesa(94, 126, 12, "green", -6),
      backstop(126, 12, 8, "metal"),
      portals("sc-lo", [34.4, 15, 180], [52, 12, 0], 2.2),
      portals("sc-hi", [34.4, 28, 180], [100, 22, 0], 1.8),
    ],
  },
  {
    name: "Circuit Final",
    par: 5,
    hint: "Pads, then a ring, then the bumper field. Everything the city has.",
    tee: [6, 10],
    cup: [148, 16],
    parts: [
      terrain(
        ["metal", [-8, 10], [24, 10], [46, 10]],
        ["fairway", [46, 10], [66, 10], [84, 10]],
      ),
      roof(20, 44, 14, 4, "metal", "stone"),
      boost(30, 10, 0, 18),
      wall(48, 10, 40, 3, "metal"),
      pool(86, 122, 3),
      wall(84, 3, 10, 2, "rubber"),
      bumper(96, 16, 1.5),
      bumper(110, 22, 1.5),
      mesa(122, 164, 16, "green", -4),
      backstop(164, 16, 8, "metal"),
      portals("cf", [46.4, 14, 180], [68, 14, 0], 2.2),
    ],
  },

  // --- back nine -----------------------------------------------------------
  // Rings in series, ceilings low enough to matter, and a tower drop. Every
  // ring wall has unbroken deck under it, so a short ball stops against the
  // panel instead of falling into a hole that was never drawn.
  {
    name: "Double Warp",
    par: 4,
    hint: "Two rings, back to back. The second one is lower than the first.",
    tee: [6, 10],
    cup: [104, 10],
    parts: [
      terrain(
        ["fairway", [-8, 10], [20, 10], [34, 10], [52, 10], [76, 10], [92, 10]],
        ["green", [92, 10], [104, 10], [116, 10]],
      ),
      wall(38, 10, 40, 4, "metal"),
      wall(70, 10, 36, 4, "metal"),
      portals("dw1", [36.4, 15, 180], [58, 14, 0], 2.4),
      portals("dw2", [68.4, 14, 180], [86, 13, 0], 2.2),
      backstop(116, 10, 8, "metal"),
    ],
  },
  {
    name: "Rubber Room",
    par: 3,
    hint: "Five metres of ceiling and a wall at the end. Everything in here comes back.",
    tee: [6, 10],
    cup: [98, 10],
    parts: [
      terrain(
        ["metal", [-8, 10], [30, 10], [60, 10], [88, 10]],
        ["green", [88, 10], [98, 10], [108, 10]],
      ),
      roof(24, 86, 15, 4, "rubber", "stone"),
      wall(109, 10, 30, 3, "rubber"),
    ],
  },
  {
    name: "Bumper Alley",
    par: 4,
    hint: "Six metres of ceiling with three bumpers under it. The pad sets the line.",
    tee: [6, 10],
    cup: [94, 10],
    parts: [
      terrain(
        ["metal", [-8, 10], [24, 10], [52, 10], [80, 10]],
        ["green", [80, 10], [94, 10], [106, 10]],
      ),
      roof(20, 78, 16, 4, "metal", "stone"),
      boost(28, 10, 0, 18),
      bumper(34, 12.6, 1.4),
      bumper(48, 13.5, 1.4),
      bumper(62, 12.4, 1.4),
      backstop(106, 10, 8, "metal"),
    ],
  },
  {
    // Two honest routes: fifty metres of open carry across the reservoir at
    // full power, or a lofted ball into the high ring that spits you out over
    // the green. The bumpers punish anyone splitting the difference.
    name: "Overdrive",
    par: 4,
    hint: "Carry the whole reservoir, or loft it into the ring above the tee shelf.",
    tee: [6, 16],
    cup: [100, 16],
    parts: [
      mesa(-8, 26, 16, "metal", -6),
      pool(26, 74, 2, "water", 6),
      bumper(40, 20, 1.5),
      bumper(56, 26, 1.5),
      wall(74, 2, 16, 2, "rubber"),
      terrain(
        ["metal", [76, 16], [88, 16]],
        ["green", [88, 16], [100, 16], [112, 16]],
      ),
      backstop(112, 16, 8, "metal"),
      portals("od", [24.4, 22, 180], [92, 26, 0], 2.0),
    ],
    floor: -4,
  },
  {
    name: "Ceiling Runner",
    par: 4,
    hint: "The belt shoves you back and the rubber roof will not let you climb out.",
    tee: [6, 10],
    cup: [102, 10],
    parts: [
      terrain(["metal", [-8, 10], [20, 10], [32, 10]]),
      belt(32, 64, 10, -9),
      roof(24, 70, 16, 4, "rubber", "stone"),
      terrain(
        ["metal", [64, 10], [78, 10], [90, 10]],
        ["green", [90, 10], [102, 10], [114, 10]],
      ),
      backstop(114, 10, 8, "metal"),
    ],
  },
  {
    name: "Neon Drop",
    par: 4,
    hint: "Three rooftops down. Rubber facades will hand back anything you overhit.",
    tee: [6, 44],
    cup: [86, 12],
    parts: [
      mesa(-8, 20, 44, "metal", -8),
      wall(20, 24, 43.4, 2, "rubber"),
      mesa(28, 42, 34, "metal", -8),
      wall(42, 16, 33.4, 2, "rubber"),
      mesa(50, 64, 22, "metal", -8),
      wall(64, 14, 21.4, 2, "rubber"),
      terrain(
        ["metal", [70, 12], [76, 12]],
        ["green", [76, 12], [86, 12], [98, 12]],
      ),
      backstop(98, 12, 8, "metal"),
    ],
  },
  {
    name: "Pulse Gate",
    par: 4,
    hint: "Fight the belt to the ring mouth. Arrive with pace or you never get in.",
    tee: [6, 10],
    cup: [98, 10],
    parts: [
      terrain(["metal", [-8, 10], [18, 10], [30, 10]]),
      belt(30, 54, 10, -10),
      terrain(
        ["metal", [54, 10], [70, 10], [86, 10]],
        ["green", [86, 10], [98, 10], [110, 10]],
      ),
      wall(56, 10, 34, 3, "metal"),
      portals("pg", [54.4, 15, 180], [72, 15, 20], 2.2),
      bumper(78, 19, 1.4),
      backstop(110, 10, 8, "metal"),
    ],
  },
  {
    name: "Night Shift",
    par: 5,
    hint: "Lift across the sump, ring through the panel, then a shelf in the dark.",
    tee: [6, 10],
    cup: [132, 16],
    parts: [
      terrain(["metal", [-8, 10], [22, 10], [36, 10]]),
      wall(36, 3, 10, 2, "rubber"),
      pool(38, 72, 3),
      lift("nshift", 48, 60, 16, [[54, 16], [54, 28]], 3.4),
      wall(72, 3, 10, 2, "rubber"),
      terrain(["metal", [74, 10], [88, 10], [100, 10]]),
      wall(90, 10, 34, 3, "metal"),
      portals("ns", [88.4, 15, 180], [110, 22, 0], 2.2),
      mesa(112, 152, 16, "green", -4),
      backstop(152, 16, 8, "metal"),
    ],
  },
  {
    name: "Neon Crown",
    par: 5,
    hint: "Pad, ring, reservoir, bumper field. The whole city in one hole.",
    tee: [6, 10],
    cup: [164, 20],
    parts: [
      terrain(["metal", [-8, 10], [24, 10], [50, 10]]),
      roof(16, 42, 15, 4, "rubber", "stone"),
      boost(30, 10, 0, 20),
      wall(46, 10, 42, 3, "metal"),
      portals("nc", [44.4, 15, 180], [66, 15, 0], 2.4),
      terrain(["metal", [50, 10], [70, 10], [96, 10]]),
      boost(88, 10, 0, 20),
      wall(96, 3, 10, 2, "rubber"),
      pool(98, 140, 3),
      bumper(110, 17, 1.5),
      bumper(124, 24, 1.5),
      mesa(140, 184, 20, "green", -4),
      backstop(184, 20, 8, "metal"),
    ],
  },
];

// ===========================================================================
// 5 — CLOUDBREAK (sky). Islands over the void — every shot is a carry.
// ===========================================================================

const CLOUDBREAK: HoleSpec[] = [
  {
    name: "First Step",
    par: 3,
    hint: "Nothing but air below. One clean carry to the far island.",
    tee: [6, 10],
    cup: [76, 10],
    parts: [
      mesa(-8, 26, 10, "fairway", 2),
      mesa(54, 98, 10, "green", 2),
      backstop(98, 10, 8),
    ],
    floor: -22,
  },
  {
    name: "Stepping Stones",
    par: 4,
    hint: "Five islands, all small. Distance control beats power every time.",
    tee: [6, 10],
    cup: [104, 10],
    parts: [
      mesa(-8, 20, 10, "fairway", 3),
      plat(32, 44, 12, "fairway", 3),
      plat(54, 64, 15, "rough", 3),
      plat(72, 84, 12, "fairway", 3),
      mesa(92, 124, 10, "green", 3),
      backstop(124, 10, 8),
    ],
    floor: -20,
  },
  {
    name: "Headwind",
    par: 4,
    hint: "It blows hard against you out there. The middle island is not cowardice.",
    tee: [6, 10],
    cup: [94, 10],
    parts: [
      mesa(-8, 24, 10, "fairway", 3),
      windZone(24, 78, 4, 44, 180, 14),
      plat(46, 58, 12, "rough", 3),
      mesa(76, 114, 10, "green", 3),
      backstop(114, 10, 8),
    ],
    floor: -20,
  },
  {
    name: "Updraught",
    par: 3,
    hint: "Ride the thermal to the high shelf, or lob it the honest way.",
    tee: [6, 10],
    cup: [70, 30],
    parts: [
      mesa(-8, 26, 10, "fairway", 2),
      fan(38, 8, 7, 28, 90, 36),
      mesa(52, 90, 30, "green", 20),
      backstop(90, 30, 8),
    ],
    floor: -18,
  },
  {
    name: "Cloud Ladder",
    par: 4,
    hint: "Up, back, up again. The ladder zig-zags — don't fight it.",
    tee: [6, 10],
    cup: [86, 44],
    parts: [
      mesa(-8, 22, 10, "fairway", 3),
      plat(30, 42, 20, "fairway", 3),
      plat(18, 30, 32, "rough", 3),
      plat(42, 56, 42, "fairway", 3),
      mesa(66, 104, 44, "green", 37),
      backstop(104, 44, 8),
      fan(26, 12, 5, 18, 90, 26),
      fan(37, 34, 5, 16, 90, 24),
    ],
    floor: -16,
  },
  {
    name: "The Long Carry",
    par: 4,
    hint: "Ninety metres of open sky, with the wind behind you. Or take the halfway rock.",
    tee: [6, 10],
    cup: [116, 10],
    parts: [
      mesa(-8, 26, 10, "fairway", 3),
      windZone(26, 130, 4, 46, 0, 9),
      plat(58, 70, 8, "rough", 3),
      mesa(96, 136, 10, "green", 3),
      backstop(136, 10, 8),
    ],
    floor: -20,
  },
  {
    name: "Skyhook",
    par: 4,
    hint: "The hook throws you the whole way. Landing on it is the shot.",
    tee: [6, 10],
    cup: [114, 10],
    parts: [
      mesa(-8, 22, 10, "fairway", 3),
      mesa(34, 50, 10, "fairway", 3),
      cannon(44, 11.2, 44, 42),
      mesa(96, 134, 10, "green", 3),
      backstop(134, 10, 8),
    ],
    floor: -20,
  },
  {
    name: "Thermal Maze",
    par: 5,
    hint: "Two thermals up, one gale back. Read the air before you swing.",
    tee: [6, 10],
    cup: [110, 12],
    parts: [
      mesa(-8, 20, 10, "fairway", 3),
      fan(26, 12, 5, 20, 90, 28),
      plat(32, 42, 16, "fairway", 3),
      fan(47, 18, 5, 20, 75, 26),
      plat(52, 62, 26, "rough", 3),
      windZone(62, 92, 6, 44, 180, 11),
      plat(72, 82, 18, "fairway", 3),
      mesa(92, 130, 12, "green", 3),
      backstop(130, 12, 8),
    ],
    floor: -18,
  },
  {
    name: "Above the Storm",
    par: 5,
    hint: "Ride the ring over the front, or claw across it island by island.",
    tee: [6, 10],
    cup: [120, 20],
    parts: [
      mesa(-8, 20, 10, "fairway", 3),
      windZone(20, 70, 4, 46, 180, 16),
      plat(34, 44, 14, "rough", 3),
      plat(54, 64, 18, "rough", 3),
      plat(78, 92, 24, "fairway", 3),
      mesa(102, 142, 20, "green", 3),
      backstop(142, 20, 8),
      portals("st", [22, 18, 180], [81, 28, 0], 2.2),
    ],
    floor: -18,
  },

  // --- back nine -----------------------------------------------------------
  // Smaller islands, harder weather. Every hole up here is a carry, so the
  // back nine is about carrying accurately with the air pushing back.
  {
    name: "Narrow Ledges",
    par: 4,
    hint: "Four eight-metre ledges climbing away from you. Distance control, nothing else.",
    tee: [6, 10],
    cup: [112, 10],
    parts: [
      mesa(-8, 20, 10, "fairway", 3),
      plat(30, 38, 14, "rough", 3),
      plat(46, 54, 18, "fairway", 3),
      plat(62, 70, 22, "rough", 3),
      plat(78, 88, 16, "fairway", 3),
      mesa(96, 132, 10, "green", 3),
      backstop(132, 10, 8),
    ],
    floor: -20,
  },
  {
    name: "Crosswind Carry",
    par: 4,
    hint: "Sixty metres of gale between you and the green. The rock halfway is free.",
    tee: [6, 10],
    cup: [104, 10],
    parts: [
      mesa(-8, 24, 10, "fairway", 3),
      windZone(24, 96, 4, 48, 180, 15),
      plat(50, 60, 14, "rough", 3),
      mesa(84, 124, 10, "green", 3),
      backstop(124, 10, 8),
    ],
    floor: -20,
  },
  {
    name: "Thermal Stack",
    par: 4,
    hint: "Three thermals, three shelves. Enter each one low and let it do the lifting.",
    tee: [6, 10],
    cup: [94, 40],
    parts: [
      mesa(-8, 20, 10, "fairway", 3),
      fan(26, 12, 5, 20, 90, 28),
      plat(32, 42, 18, "fairway", 3),
      fan(48, 20, 5, 20, 90, 26),
      plat(54, 64, 30, "rough", 3),
      fan(70, 32, 5, 20, 90, 24),
      mesa(76, 112, 40, "green", 30),
      backstop(112, 40, 8),
    ],
    floor: -14,
  },
  {
    // A gale the whole way and a cannon parked on the only island that matters.
    // Landing on that island is the shot; everything after it is bookkeeping.
    name: "The Gauntlet",
    par: 4,
    hint: "Land the low island, roll into the barrel, and let it fight the wind for you.",
    tee: [6, 10],
    cup: [108, 16],
    parts: [
      mesa(-8, 22, 10, "fairway", 3),
      windZone(22, 90, 4, 50, 180, 14),
      plat(38, 52, 12, "rough", 3),
      cannon(46, 13.2, 42, 40),
      plat(66, 76, 20, "fairway", 3),
      mesa(88, 128, 16, "green", 3),
      backstop(128, 16, 8),
    ],
    floor: -18,
  },
  {
    name: "Cloud Cannon",
    par: 4,
    hint: "Two barrels, two flights. Miss the second island and it is a very long fall.",
    tee: [6, 10],
    cup: [140, 12],
    parts: [
      mesa(-8, 20, 10, "fairway", 3),
      mesa(32, 46, 10, "fairway", 3),
      cannon(40, 11.2, 48, 40),
      mesa(80, 94, 14, "fairway", 3),
      cannon(88, 15.2, 38, 38),
      mesa(122, 160, 12, "green", 3),
      backstop(160, 12, 8),
    ],
    floor: -20,
  },
  {
    name: "Sky Ring",
    par: 3,
    hint: "Loft it into the ring. Nobody carries this one into a wind like that.",
    tee: [6, 10],
    cup: [102, 14],
    parts: [
      mesa(-8, 22, 10, "fairway", 3),
      windZone(24, 80, 4, 44, 180, 12),
      mesa(84, 120, 14, "green", 3),
      backstop(120, 14, 8),
      portals("skr", [24, 16, 180], [80, 20, 0], 2.2),
    ],
    floor: -18,
  },
  {
    name: "Storm Ladder",
    par: 4,
    hint: "Thermal up, then three shelves through the front. The wind only pushes one way.",
    tee: [6, 10],
    cup: [100, 46],
    parts: [
      mesa(-8, 20, 10, "fairway", 3),
      fan(26, 12, 5, 20, 90, 28),
      plat(30, 40, 22, "fairway", 3),
      windZone(40, 74, 18, 50, 180, 12),
      plat(48, 58, 32, "rough", 3),
      plat(64, 74, 40, "fairway", 3),
      mesa(82, 120, 46, "green", 39),
      backstop(120, 46, 8),
    ],
    floor: -14,
  },
  {
    name: "Long Way Home",
    par: 5,
    hint: "The wind is behind you for once. Two islands, a barrel, and a big finish.",
    tee: [6, 10],
    cup: [152, 16],
    parts: [
      mesa(-8, 24, 10, "fairway", 3),
      windZone(24, 120, 4, 48, 0, 9),
      plat(52, 62, 8, "rough", 3),
      plat(84, 96, 12, "fairway", 3),
      cannon(90, 13.2, 40, 36),
      mesa(130, 172, 16, "green", 3),
      backstop(172, 16, 8),
    ],
    floor: -20,
  },
  {
    name: "Cloudbreak Crown",
    par: 5,
    hint: "Thermal, gale, barrel, ring. Read the air twice before you swing once.",
    tee: [6, 10],
    cup: [144, 22],
    parts: [
      mesa(-8, 20, 10, "fairway", 3),
      fan(26, 12, 5, 20, 90, 30),
      plat(32, 44, 20, "fairway", 3),
      windZone(44, 86, 6, 50, 180, 13),
      plat(54, 64, 26, "rough", 3),
      plat(74, 86, 18, "fairway", 3),
      cannon(80, 19.2, 44, 38),
      mesa(120, 164, 22, "green", 3),
      backstop(164, 22, 8),
      portals("cbc", [34, 34, 180], [118, 32, 0], 1.8),
    ],
    floor: -16,
  },
];

// ===========================================================================
// 6 — CINDER RISE (volcano). Lava, burning bridges, the long climb.
// ===========================================================================

const CINDER_RISE: HoleSpec[] = [
  {
    name: "Ash Fairway",
    par: 3,
    hint: "The lake is thirty metres wide and entirely unforgiving.",
    tee: [6, 12],
    cup: [90, 12],
    parts: [
      terrain(["fairway", [-8, 12], [22, 12], [40, 12]]),
      wall(40, 2, 12, 2),
      pool(42, 72, 3, "lava"),
      wall(72, 2, 12, 2),
      terrain(
        ["fairway", [74, 12], [82, 12]],
        ["green", [82, 12], [92, 12], [104, 12]],
      ),
      backstop(104, 12, 7, "stone"),
    ],
  },
  {
    name: "Lava Skip",
    par: 4,
    hint: "One black rock in eighty metres of lava. Use it or fly the lot.",
    tee: [6, 12],
    cup: [132, 12],
    parts: [
      terrain(["fairway", [-8, 12], [20, 12], [30, 12]]),
      pool(30, 110, 4, "lava"),
      mesa(52, 72, 12, "rough", 4),
      mesa(110, 150, 12, "green", 4),
      backstop(150, 12, 8, "stone"),
    ],
  },
  {
    name: "Obsidian Wall",
    par: 3,
    hint: "The glass shatters. The basalt above it does not — go through or over.",
    tee: [6, 12],
    cup: [84, 12],
    parts: [
      terrain(
        ["fairway", [-8, 12], [20, 12], [34, 12], [54, 11.4], [72, 12]],
        ["green", [72, 12], [84, 12], [96, 12]],
      ),
      backstop(96, 12, 7, "stone"),
      breakable(32, 36, 12, 22, "stone"),
      feet(32, 36, 12, "stone"),
      block(32, 22, 4, 4, "stone"),
    ],
  },
  {
    name: "Magma Lift",
    par: 4,
    hint: "Land on the lift, take the height, then across to the shelf.",
    tee: [6, 12],
    cup: [122, 26],
    parts: [
      terrain(["fairway", [-8, 12], [20, 12], [30, 12]]),
      pool(30, 96, 4, "lava"),
      lift("magma", 50, 64, 14, [[57, 14], [57, 27]], 3.0),
      mesa(96, 142, 26, "green", 4),
      backstop(142, 26, 8, "stone"),
    ],
  },
  {
    name: "Ember Cannon",
    par: 4,
    hint: "Roll it into the barrel and hang on. The black rock catches a short one.",
    tee: [6, 12],
    cup: [116, 12],
    parts: [
      terrain(["fairway", [-8, 12], [14, 12], [26, 12]]),
      cannon(22, 13.2, 52, 46),
      pool(26, 120, 3, "lava"),
      mesa(68, 92, 12, "rough", 3),
      mesa(96, 138, 12, "green", 3),
      backstop(138, 12, 8, "stone"),
    ],
  },
  {
    name: "The Vent",
    par: 3,
    hint: "The vent throws you over the rim. So does a very steep lob.",
    tee: [6, 12],
    cup: [80, 34],
    parts: [
      terrain(["fairway", [-8, 12], [22, 12], [34, 12]]),
      pool(34, 46, 3, "lava"),
      fan(40, 10, 8, 30, 90, 40),
      mesa(46, 104, 34, "green", 2),
      backstop(104, 34, 8, "stone"),
    ],
  },
  {
    name: "Bridge of Cinders",
    par: 4,
    hint: "Every plank burns once you touch it. Don't plan on coming back.",
    tee: [6, 12],
    cup: [122, 12],
    parts: [
      terrain(["fairway", [-8, 12], [20, 12], [32, 12]]),
      pool(32, 104, 4, "lava"),
      breakable(36, 46, 10.6, 12),
      breakable(52, 62, 10.6, 12),
      breakable(68, 78, 10.6, 12),
      breakable(84, 94, 10.6, 12),
      mesa(104, 144, 12, "green", 4),
      backstop(144, 12, 8, "stone"),
    ],
  },
  {
    name: "Caldera",
    par: 5,
    hint: "Down the inside wall, over the lake, back up the far side.",
    tee: [6, 30],
    cup: [150, 30],
    parts: [
      mesa(-8, 26, 30, "rough", -4),
      mesa(30, 46, 20, "rough", -4),
      mesa(50, 62, 10, "rough", -4),
      pool(62, 98, 3, "lava"),
      mesa(98, 112, 10, "rough", -4),
      mesa(116, 130, 20, "rough", -4),
      mesa(134, 172, 30, "green", -4),
      backstop(172, 30, 8, "stone"),
    ],
  },
  {
    name: "Summit",
    par: 5,
    hint: "Three ash ledges, eight metres of climb each. The vent helps with one.",
    tee: [6, 12],
    cup: [160, 40],
    parts: [
      terrain(["fairway", [-8, 12], [20, 12], [30, 12]]),
      pool(30, 58, 3, "lava"),
      mesa(58, 80, 16, "rough", 3),
      mesa(88, 108, 24, "rough", 3),
      fan(84, 14, 5, 22, 80, 26),
      mesa(116, 134, 32, "rough", 3),
      mesa(142, 180, 40, "green", 3),
      backstop(180, 40, 8, "stone"),
    ],
  },

  // --- back nine -----------------------------------------------------------
  // Wider lakes, longer bridges, and vents that will throw you a whole rim if
  // you enter them straight. Every lava crossing still has a black rock in it.
  {
    name: "Cinder Steps",
    par: 4,
    hint: "Three black rocks across ninety metres of lake. Take them one at a time.",
    tee: [6, 12],
    cup: [144, 14],
    parts: [
      terrain(["fairway", [-8, 12], [20, 12], [30, 12]]),
      pool(30, 124, 4, "lava"),
      mesa(44, 58, 12, "rough", 4),
      mesa(70, 84, 14, "rough", 4),
      mesa(96, 110, 12, "rough", 4),
      mesa(124, 164, 14, "green", 4),
      backstop(164, 14, 8, "stone"),
    ],
  },
  {
    name: "Firewall",
    par: 3,
    hint: "Cross the moat, then a basalt gate on the far bank. Through it or over it.",
    tee: [6, 12],
    cup: [84, 12],
    parts: [
      terrain(["fairway", [-8, 12], [20, 12], [32, 12]]),
      wall(30, 3, 12, 2),
      pool(32, 60, 3, "lava"),
      wall(60, 3, 12, 2),
      terrain(
        ["fairway", [62, 12], [72, 12]],
        ["green", [72, 12], [84, 12], [96, 12]],
      ),
      backstop(96, 12, 7, "stone"),
      breakable(64, 68, 12, 20, "stone"),
      feet(64, 68, 12, "stone"),
      block(64, 20, 4, 4, "stone"),
    ],
  },
  {
    name: "Ember Lift",
    par: 4,
    hint: "Two platforms over the lake. Parked or moving, both of them hold a ball.",
    tee: [6, 12],
    cup: [130, 28],
    parts: [
      terrain(["fairway", [-8, 12], [18, 12], [28, 12]]),
      pool(28, 110, 4, "lava"),
      lift("ember1", 44, 56, 14, [[50, 14], [50, 26]], 3.0),
      lift("ember2", 74, 86, 20, [[80, 20], [80, 32]], 3.0),
      mesa(110, 150, 28, "green", 4),
      backstop(150, 28, 8, "stone"),
    ],
  },
  {
    // Eighty metres of open lava with one rock in it and a vent on the far
    // shore. The cannon on the rock is the difference between a par and a
    // swim, and it is deliberately the only thing that reaches from there.
    name: "Crucible",
    par: 4,
    hint: "Rock, then barrel, then let the vent carry you up onto the rim.",
    tee: [6, 20],
    cup: [126, 26],
    parts: [
      mesa(-8, 24, 20, "fairway", 2),
      pool(24, 104, 4, "lava"),
      mesa(52, 70, 10, "rough", 2),
      cannon(62, 11.2, 46, 42),
      fan(88, 8, 7, 26, 90, 32),
      mesa(104, 148, 26, "green", 2),
      backstop(148, 26, 8, "stone"),
    ],
    floor: -8,
  },
  {
    name: "Ash Bridge",
    par: 4,
    hint: "Three planks and a lift. The planks burn once, so do not plan a second visit.",
    tee: [6, 12],
    cup: [118, 22],
    parts: [
      terrain(["fairway", [-8, 12], [18, 12], [28, 12]]),
      pool(28, 96, 4, "lava"),
      breakable(32, 42, 10.6, 12),
      breakable(48, 58, 10.6, 12),
      breakable(64, 74, 10.6, 12),
      lift("ash", 78, 90, 16, [[84, 16], [84, 26]], 3.0),
      mesa(96, 138, 22, "green", 4),
      backstop(138, 22, 8, "stone"),
    ],
  },
  {
    name: "Basalt Gate",
    par: 4,
    hint: "Two glass panels with basalt caps. Smash both, or fly the pair of them.",
    tee: [6, 12],
    cup: [90, 12],
    parts: [
      terrain(
        ["fairway", [-8, 12], [20, 12], [36, 12], [58, 11.4], [78, 12]],
        ["green", [78, 12], [90, 12], [102, 12]],
      ),
      backstop(102, 12, 7, "stone"),
      breakable(34, 38, 12, 18, "stone"),
      feet(34, 38, 12, "stone"),
      block(34, 18, 4, 4, "stone"),
      breakable(60, 64, 12, 16, "stone"),
      feet(60, 64, 12, "stone"),
      block(60, 16, 4, 4, "stone"),
    ],
  },
  {
    name: "The Throat",
    par: 4,
    hint: "Roll all the way down the inside wall, then let the vent take you back out.",
    tee: [6, 28],
    cup: [110, 26],
    parts: [
      mesa(-8, 24, 28, "rough", -4),
      terrain(["rough", [24, 28], [32, 22], [42, 14], [52, 10], [62, 10]]),
      pool(62, 86, 3, "lava"),
      fan(74, 8, 8, 28, 90, 36),
      mesa(86, 130, 26, "green", -4),
      backstop(130, 26, 8, "stone"),
    ],
  },
  {
    name: "Magma Run",
    par: 5,
    hint: "Rock, pad, then a sand ramp onto the shelf. The lake is fifty metres wide.",
    tee: [6, 12],
    cup: [162, 30],
    parts: [
      terrain(["fairway", [-8, 12], [20, 12], [32, 12]]),
      pool(32, 88, 4, "lava"),
      mesa(50, 66, 12, "rough", 4),
      boost(58, 12, 50, 24),
      wall(88, 4, 12, 2),
      terrain(
        ["fairway", [90, 12], [100, 12]],
        ["sand", [100, 12], [106, 16], [112, 20]],
      ),
      mesa(112, 134, 20, "rough", -2),
      mesa(140, 182, 30, "green", -2),
      backstop(182, 30, 8, "stone"),
    ],
  },
  {
    name: "Cinder Crown",
    par: 5,
    hint: "Barrel off the tee, pad off the rock, vent onto the summit. No rests.",
    tee: [6, 12],
    cup: [168, 34],
    parts: [
      terrain(["fairway", [-8, 12], [18, 12], [28, 12]]),
      cannon(24, 13.2, 54, 44),
      pool(28, 112, 4, "lava"),
      mesa(60, 78, 14, "rough", 4),
      boost(70, 14, 48, 22),
      fan(96, 10, 7, 28, 90, 34),
      mesa(112, 140, 24, "rough", 4),
      mesa(146, 190, 34, "green", 4),
      backstop(190, 34, 8, "stone"),
    ],
  },
];

// ===========================================================================
// 7 — HOARFROST (glacier). Ice takes the brakes off everything.
// ===========================================================================
//
// Ice stops a ball on nothing steeper than half a degree, so every sheet here
// is authored dead flat and always ends in a snow (rough) collar. Ice that
// tilts is ice the ball never gets off.

const HOARFROST: HoleSpec[] = [
  {
    name: "First Slide",
    par: 3,
    hint: "Ice has no brakes. Hit it half as hard as you think.",
    tee: [6, 10],
    cup: [88, 10],
    parts: [
      terrain(
        ["fairway", [-8, 10], [20, 10]],
        ["ice", [20, 10], [38, 10], [56, 10]],
        ["rough", [56, 10], [66, 10], [78, 10]],
        ["green", [78, 10], [88, 10], [98, 10]],
      ),
      backstop(98, 10, 7),
    ],
  },
  {
    name: "Crevasse",
    par: 4,
    hint: "Two splits in the ice. Landing between them is the whole hole.",
    tee: [6, 10],
    cup: [108, 10],
    parts: [
      terrain(["ice", [-8, 10], [20, 10], [36, 10]]),
      pool(36, 54, 5),
      terrain(["ice", [54, 10], [70, 10]]),
      pool(70, 86, 5),
      terrain(
        ["ice", [86, 10], [96, 10]],
        ["rough", [96, 10], [100, 10]],
        ["green", [100, 10], [110, 10], [120, 10]],
      ),
      backstop(120, 10, 8),
    ],
  },
  {
    name: "Curling Sheet",
    par: 3,
    hint: "Ninety metres of glass to a green with water behind it. Weight it.",
    tee: [6, 10],
    cup: [98, 10],
    parts: [
      terrain(
        ["fairway", [-8, 10], [14, 10]],
        ["ice", [14, 10], [42, 10], [70, 10]],
        ["sand", [70, 10], [80, 9.9], [90, 9.8]],
        ["green", [90, 9.8], [98, 9.8], [108, 9.8]],
        ["rough", [108, 9.8], [114, 9.4]],
      ),
      pool(116, 140, 8),
    ],
  },
  {
    name: "Icefall",
    par: 4,
    hint: "Four steps down a frozen waterfall. Nothing stops on the way.",
    tee: [6, 34],
    cup: [112, 4],
    parts: [
      mesa(-8, 24, 34, "ice", -8),
      mesa(30, 44, 26, "ice", -8),
      mesa(50, 64, 18, "ice", -8),
      mesa(70, 84, 10, "ice", -8),
      terrain(
        ["ice", [90, 4], [98, 4]],
        ["rough", [98, 4], [102, 4]],
        ["green", [102, 4], [112, 4], [124, 4]],
      ),
      backstop(124, 4, 8),
    ],
    floor: -12,
  },
  {
    name: "Blue Cave",
    par: 4,
    hint: "Eight metres of headroom inside. Small swings, and the meltpool is real.",
    tee: [6, 10],
    cup: [84, 10],
    parts: [
      terrain(["ice", [-8, 10], [22, 10], [36, 10]]),
      mesa(38, 98, 28, "rough", 18),
      // Snow inside the mouth so an arriving ball has somewhere to stop.
      terrain(
        ["rough", [36, 10], [52, 10]],
        ["ice", [52, 10], [58, 10]],
      ),
      pool(58, 70, 5),
      terrain(
        ["rough", [70, 10], [76, 10]],
        ["green", [76, 10], [84, 10], [94, 10]],
      ),
      backstop(94, 10, 5),
    ],
  },
  {
    name: "Wind Chill",
    par: 4,
    hint: "A gale across an open crevasse. The ice floe halfway is your friend.",
    tee: [6, 10],
    cup: [92, 10],
    parts: [
      terrain(["ice", [-8, 10], [20, 10], [30, 10]]),
      windZone(30, 66, 4, 38, 180, 13),
      plat(44, 56, 8, "ice", 3),
      terrain(
        ["ice", [64, 10], [80, 10]],
        ["rough", [80, 10], [84, 10]],
        ["green", [84, 10], [94, 10], [104, 10]],
      ),
      backstop(104, 10, 8),
    ],
    floor: -12,
  },
  {
    name: "Glass Tower",
    par: 4,
    hint: "Three ledges up the face. The bumpers will help if you find them.",
    tee: [6, 10],
    cup: [104, 40],
    parts: [
      terrain(["ice", [-8, 10], [20, 10], [30, 10]]),
      mesa(32, 50, 18, "rough", -4),
      bumper(32, 14, 1.4),
      mesa(56, 74, 27, "rough", -4),
      bumper(54, 22, 1.4),
      mesa(80, 96, 34, "rough", -4),
      terrain(
        ["rough", [96, 40], [100, 40]],
        ["green", [100, 40], [110, 40], [122, 40]],
      ),
      block(96, 24, 30, 16, "stone"),
      fillet(96, 34, -1, 1.0, "rough"),
      backstop(122, 40, 8),
    ],
  },
  {
    name: "Frozen Circuit",
    par: 4,
    hint: "The ring spits you onto bare ice. Arrive slowly or you'll sail past.",
    tee: [6, 10],
    cup: [102, 10],
    parts: [
      terrain(
        ["ice", [-8, 10], [20, 10], [32, 10], [50, 10], [74, 10]],
        ["rough", [74, 10], [84, 10], [92, 10]],
        ["green", [92, 10], [102, 10], [112, 10]],
      ),
      wall(36, 10, 40, 3, "stone"),
      backstop(112, 10, 7),
      portals("fc", [34.4, 16, 180], [62, 14, 0], 2.2),
    ],
  },
  {
    name: "Hoarfrost Crown",
    par: 5,
    hint: "Water, cannon, ring, ice. Everything Hoarfrost has, in order.",
    tee: [6, 10],
    cup: [156, 10],
    parts: [
      terrain(["ice", [-8, 10], [16, 10], [26, 10]]),
      pool(26, 56, 5),
      mesa(54, 76, 10, "rough", 3),
      cannon(64, 11.2, 30, 30),
      wall(80, 10, 44, 3, "stone"),
      terrain(
        ["ice", [108, 10], [140, 10]],
        ["rough", [140, 10], [148, 10]],
        ["green", [148, 10], [158, 10], [168, 10]],
      ),
      backstop(168, 10, 8),
      portals("hc", [78.4, 16, 180], [108, 15, 0], 2.4),
    ],
    floor: -14,
  },

  // --- back nine -----------------------------------------------------------
  // Same rule as the front nine, harder application: every sheet dead flat,
  // every green wearing a snow collar, and the only climbs cut into snow — ice
  // that tilts is ice the ball never gets off.
  {
    name: "Split Sheet",
    par: 4,
    hint: "A crevasse across the middle of the sheet. Stopping short is the whole skill.",
    tee: [6, 10],
    cup: [96, 10],
    parts: [
      terrain(["ice", [-8, 10], [20, 10], [34, 10]]),
      pool(34, 50, 5),
      terrain(
        ["ice", [50, 10], [64, 10], [78, 10]],
        ["rough", [78, 10], [86, 10]],
        ["green", [86, 10], [96, 10], [106, 10]],
      ),
      backstop(106, 10, 8),
    ],
  },
  {
    name: "Snow Ramp",
    par: 3,
    hint: "Off the ice and up the snow. Snow is the only thing here with any grip.",
    tee: [6, 10],
    cup: [80, 18],
    parts: [
      terrain(
        ["ice", [-8, 10], [18, 10], [30, 10]],
        ["rough", [30, 10], [40, 13], [50, 16]],
        ["rough", [50, 16], [60, 17], [70, 18]],
        ["green", [70, 18], [80, 18], [92, 18]],
      ),
      backstop(92, 18, 7),
    ],
  },
  {
    name: "Frozen Falls",
    par: 4,
    hint: "Three ice steps down. Nothing on the way holds a ball for long.",
    tee: [6, 30],
    cup: [96, 6],
    parts: [
      mesa(-8, 22, 30, "ice", -6),
      mesa(28, 42, 22, "ice", -6),
      mesa(48, 62, 14, "ice", -6),
      terrain(
        ["ice", [68, 6], [78, 6]],
        ["rough", [78, 6], [86, 6]],
        ["green", [86, 6], [96, 6], [108, 6]],
      ),
      backstop(108, 6, 8),
    ],
    floor: -12,
  },
  {
    // A thirty-six metre crevasse, then a wall the ring is the only way past,
    // then bare ice into a snow collar. The exit ring is set back from the
    // collar on purpose: you land on ice with pace and have to trust the snow.
    name: "Glacier Gate",
    par: 4,
    hint: "Carry the crevasse, post it through the ring, then let the snow stop it.",
    tee: [6, 10],
    cup: [130, 10],
    parts: [
      terrain(["ice", [-8, 10], [20, 10], [32, 10]]),
      pool(32, 68, 5),
      terrain(
        ["ice", [68, 10], [84, 10], [100, 10], [112, 10]],
        ["rough", [112, 10], [120, 10]],
        ["green", [120, 10], [130, 10], [142, 10]],
      ),
      wall(88, 10, 40, 3, "stone"),
      portals("gg", [86.4, 16, 180], [104, 15, 0], 2.4),
      backstop(142, 10, 8),
      bumper(50, 16, 1.4),
    ],
    floor: -12,
  },
  {
    name: "Snowdrift",
    par: 4,
    hint: "Drifts break the sheet into three. Each drift is a chance to stop.",
    tee: [6, 10],
    cup: [104, 11],
    parts: [
      terrain(
        ["ice", [-8, 10], [18, 10], [30, 10]],
        // Drift faces stay well inside snow's 20° ceiling even after the
        // Catmull-Rom pass rounds them: a drift a ball cannot stop on is just
        // a funnel back onto the ice it came from.
        ["rough", [30, 10], [40, 12.2], [48, 10.6]],
        ["ice", [48, 10.6], [56, 10.6], [62, 10.6]],
        ["rough", [62, 10.6], [72, 12.6], [80, 11]],
        ["ice", [80, 11], [88, 11]],
        ["rough", [88, 11], [94, 11]],
        ["green", [94, 11], [104, 11], [116, 11]],
      ),
      backstop(116, 11, 8),
    ],
  },
  {
    name: "Blue Chamber",
    par: 4,
    hint: "Four metres at the mouth, a meltpool inside, and snow to land on either side.",
    tee: [6, 10],
    cup: [88, 10],
    parts: [
      terrain(["ice", [-8, 10], [20, 10], [34, 10]]),
      wall(34, 10, 13, 2, "stone"),
      mesa(34, 104, 30, "rough", 17),
      terrain(
        ["rough", [36, 10], [48, 10]],
        ["ice", [48, 10], [58, 10]],
      ),
      pool(58, 70, 5),
      terrain(
        ["rough", [70, 10], [78, 10]],
        ["green", [78, 10], [88, 10], [100, 10]],
      ),
      backstop(100, 10, 6),
    ],
  },
  {
    name: "Icebreaker",
    par: 4,
    hint: "Three snow shelves up the face. The bumpers are there if you find them.",
    tee: [6, 10],
    cup: [100, 34],
    parts: [
      terrain(["ice", [-8, 10], [18, 10], [30, 10]]),
      mesa(34, 50, 16, "rough", -4),
      bumper(33, 13, 1.4),
      mesa(56, 72, 26, "rough", -4),
      bumper(55, 22, 1.4),
      mesa(78, 120, 34, "green", -4),
      backstop(120, 34, 8),
    ],
    floor: -10,
  },
  {
    name: "White Out",
    par: 5,
    hint: "A gale across sixty metres of meltwater, with one floe to break it up.",
    tee: [6, 10],
    cup: [146, 10],
    parts: [
      terrain(["ice", [-8, 10], [20, 10], [32, 10]]),
      pool(32, 96, 5),
      plat(56, 70, 9, "ice", 3),
      windZone(32, 100, 4, 44, 180, 13),
      terrain(
        ["ice", [96, 10], [112, 10], [128, 10]],
        ["rough", [128, 10], [136, 10]],
        ["green", [136, 10], [146, 10], [158, 10]],
      ),
      backstop(158, 10, 8),
    ],
    floor: -8,
  },
  {
    // The barrel is aimed at the ring, not at the green: it lifts a rolling
    // ball to mouth height with about six metres to spare. Everything past the
    // ring is bare ice, so the snow collar in front of the pin is the brake.
    name: "Winter Crown",
    par: 5,
    hint: "Water, then the barrel into the ring, then bare ice. Trust the snow collar.",
    tee: [6, 10],
    cup: [160, 10],
    parts: [
      terrain(["ice", [-8, 10], [16, 10], [28, 10]]),
      pool(28, 58, 5),
      mesa(58, 96, 10, "rough", 3),
      cannon(72, 11.2, 32, 34),
      wall(88, 10, 42, 3, "stone"),
      portals("wc", [86.4, 16, 180], [116, 16, 0], 2.4),
      windZone(96, 140, 6, 44, 180, 9),
      terrain(
        ["ice", [116, 10], [130, 10], [140, 10]],
        ["rough", [140, 10], [150, 10]],
        ["green", [150, 10], [160, 10], [172, 10]],
      ),
      backstop(172, 10, 8),
    ],
    floor: -14,
  },
];

// ---------------------------------------------------------------------------
// Courses
// ---------------------------------------------------------------------------

export const STARTER_COURSE: Course = makeCourse(
  {
    id: "sunset-links",
    name: "Sunset Links",
    theme: "seaside",
    blurb: "Eighteen holes on the water. The front nine teaches the swing.",
    unlockAt: 0,
  },
  SUNSET_LINKS,
);

export const COURSES: Course[] = [
  STARTER_COURSE,
  makeCourse(
    {
      id: "emerald-hollow",
      name: "Emerald Hollow",
      theme: "jungle",
      blurb: "Low canopies, rolling logs and a cave with a green in it.",
      unlockAt: 12,
    },
    EMERALD_HOLLOW,
  ),
  makeCourse(
    {
      id: "red-mesa",
      name: "Red Mesa",
      theme: "canyon",
      blurb: "Big air over bigger holes in the ground. Bring the cannon.",
      unlockAt: 30,
    },
    RED_MESA,
  ),
  makeCourse(
    {
      id: "neon-circuit",
      name: "Neon Circuit",
      theme: "neon",
      blurb: "Portals, boost pads and rubber ceilings, all after dark.",
      unlockAt: 52,
    },
    NEON_CIRCUIT,
  ),
  makeCourse(
    {
      id: "cloudbreak",
      name: "Cloudbreak",
      theme: "sky",
      blurb: "Floating islands and honest wind. Every shot is a carry.",
      unlockAt: 76,
    },
    CLOUDBREAK,
  ),
  makeCourse(
    {
      id: "cinder-rise",
      name: "Cinder Rise",
      theme: "volcano",
      blurb: "Lava below, burning bridges across it, and a long climb out.",
      unlockAt: 104,
    },
    CINDER_RISE,
  ),
  makeCourse(
    {
      id: "hoarfrost",
      name: "Hoarfrost",
      theme: "glacier",
      blurb: "Ice takes the brakes off. Eighteen holes about stopping.",
      unlockAt: 136,
    },
    HOARFROST,
  ),
];

/**
 * The course book is pure data, but boot's module shape is a `SystemFactory`;
 * this one publishes nothing and costs nothing to install.
 */
const createHoles: SystemFactory = (_ctx) => ({ name: "holes" }) as System;

export default createHoles;
