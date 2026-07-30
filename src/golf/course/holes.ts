/**
 * Vibe Golf — the courses.
 *
 * Seven nine-hole courses, one per theme, escalating from "learn the swing"
 * to "everything at once". Every hole is built around a single idea and named
 * after it; the name on the loading card should tell you what the hole wants.
 *
 * Two rules govern everything below.
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

/** A vertical wall standing on the ground. */
function wall(x: number, y0: number, y1: number, w = 3, material: SurfaceMaterial = "stone"): Surface {
  return block(x, y0, w, y1 - y0, material);
}

/** A slab hanging in the air — roofs, overhangs, canopies. `under` is its underside. */
function roof(x0: number, x1: number, under: number, thick = 5, material: SurfaceMaterial = "stone"): Surface {
  return block(x0, under, x1 - x0, thick, material);
}

/** A lethal basin. `top` is the waterline; the ball dies the instant it touches. */
function pool(x0: number, x1: number, top: number, material: SurfaceMaterial = "water", depth = 6): Surface {
  return block(x0, top - depth, x1 - x0, depth, material);
}

/** A green with a wall behind it, so a hot approach is caught instead of lost. */
function backstop(x: number, y: number, h = 7, material: SurfaceMaterial = "stone"): Surface {
  return block(x, y, 2.6, h, material);
}

/** A threading gap: two towers with a window between `lo` and `hi`. */
function keyhole(x: number, base: number, lo: number, hi: number, top: number, w = 3, material: SurfaceMaterial = "stone"): Surface[] {
  return [block(x, base, w, lo - base, material), block(x, hi, w, top - hi, material)];
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
    name: "Opening Drive",
    par: 3,
    hint: "Drag back from the ball and let go. Further back is harder.",
    tee: [6, 10],
    cup: [84, 10],
    parts: [
      terrain(
        ["fairway", [-8, 10], [16, 10], [30, 8], [46, 11], [60, 13], [74, 10]],
        ["green", [74, 10], [92, 10]],
        ["rough", [92, 10], [104, 13], [116, 17]],
      ),
    ],
  },
  {
    name: "Over the Drink",
    par: 3,
    hint: "Water ends the shot. Carry it, or lay up short and take your three.",
    tee: [6, 11],
    cup: [86, 11],
    parts: [
      terrain(["fairway", [-8, 11], [16, 11], [28, 11.6], [34, 11]]),
      wall(32, 5, 11, 2),
      pool(34, 62, 6.5, "water", 5),
      wall(62, 5, 11, 2),
      terrain(
        ["fairway", [64, 11], [78, 11]],
        ["green", [78, 11], [96, 11]],
        ["rough", [96, 11], [110, 13]],
      ),
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
        ["fairway", [-8, 10], [18, 10], [34, 9]],
        ["sand", [34, 9], [42, 8.4], [48, 8.6]],
        ["fairway", [48, 8.6], [66, 10], [80, 12]],
        ["sand", [80, 12], [86, 11.4], [92, 11.6]],
        ["fairway", [92, 11.6], [100, 12]],
        ["green", [100, 12], [118, 12]],
        ["rough", [118, 12], [130, 15]],
      ),
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
        ["fairway", [40, 9], [56, 9]],
        ["rough", [56, 9], [66, 9.4], [74, 10]],
        ["fairway", [74, 10], [84, 11]],
        ["green", [84, 11], [98, 11]],
        ["rough", [98, 11], [112, 14]],
      ),
    ],
  },
  {
    name: "Cliff Terrace",
    par: 4,
    hint: "Three shelves. Take them one at a time — nobody clears all three.",
    tee: [6, 8],
    cup: [96, 26],
    parts: [
      terrain(["fairway", [-8, 8], [20, 8], [30, 7]]),
      mesa(34, 56, 15, "fairway", -6),
      mesa(60, 78, 21, "rough", -6),
      mesa(82, 118, 26, "green", -6),
      backstop(118, 26, 8),
    ],
  },
  {
    name: "Backboard",
    par: 3,
    hint: "The green is small. The rubber wall behind it is not — use it.",
    tee: [6, 10],
    cup: [90, 10],
    parts: [
      terrain(
        ["fairway", [-8, 10], [24, 10], [44, 9], [62, 10], [70, 10]],
        ["sand", [70, 10], [76, 9.6], [84, 10]],
        ["green", [84, 10], [96, 10]],
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
      terrain(["fairway", [-8, 10], [16, 10], [26, 10.4], [30, 10]]),
      wall(28, 4, 10.2, 2),
      pool(30, 74, 4.5),
      wall(74, 4, 10.2, 2),
      terrain(
        ["fairway", [76, 10], [90, 10]],
        ["green", [90, 10], [108, 10]],
        ["rough", [108, 10], [120, 13]],
      ),
      bumper(42, 9, 1.4),
      bumper(56, 12.5, 1.4),
      bumper(66, 8.5, 1.2),
    ],
  },
  {
    name: "The Keyhole",
    par: 3,
    hint: "A four-metre window at head height, or a very brave lob over the top.",
    tee: [6, 10],
    cup: [96, 10],
    parts: [
      terrain(
        ["fairway", [-8, 10], [20, 10], [34, 10]],
        ["fairway", [47, 10], [60, 8.6], [74, 9.4]],
        ["sand", [74, 9.4], [82, 9]],
        ["fairway", [82, 9], [88, 10]],
        ["green", [88, 10], [106, 10]],
        ["rough", [106, 10], [118, 13]],
      ),
      keyhole(44, 10, 16, 20.5, 30),
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
        ["fairway", [52, 9.4], [62, 11], [70, 11]],
      ),
      wall(68, 5, 11.2, 2),
      pool(70, 100, 5.5),
      wall(100, 5, 11.2, 2),
      terrain(
        ["fairway", [102, 11], [110, 12]],
        ["rough", [110, 12], [118, 13]],
      ),
      mesa(118, 154, 20, "green", -6),
      backstop(154, 20, 8),
      bumper(86, 14, 1.3),
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
        ["fairway", [-8, 10], [20, 10], [40, 9], [62, 10], [84, 10]],
        ["green", [84, 10], [102, 10]],
        ["rough", [102, 10], [116, 13]],
      ),
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
      terrain(["rough", [36, -4], [64, -4]]),
      wall(64, -4, 10, 2),
      terrain(
        ["fairway", [66, 10], [78, 10]],
        ["green", [78, 10], [94, 10]],
        ["rough", [94, 10], [106, 12]],
      ),
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
        ["green", [70, 10], [96, 10]],
      ),
      backstop(98, 10, 7),
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
      terrain(["rough", [36, -3], [68, -3]]),
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
        ["fairway", [-8, 10], [20, 10], [30, 10]],
        ["fairway", [37, 10], [56, 9], [70, 10]],
        ["green", [70, 10], [92, 10]],
        ["rough", [92, 10], [104, 12]],
      ),
      breakable(33, 37, 10, 22),
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
      terrain(["rough", [34, 0], [82, 0]]),
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
        ["green", [84, 8], [106, 8]],
      ),
      backstop(108, 8, 8),
      breakable(58, 60, 8, 12, "wood"),
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
      wall(32, 4, 10.2, 2),
      terrain(["rough", [54, 10], [66, 12], [70, 13]]),
      belt(72, 94, 15, 10, "wood"),
      boost(88, 15, 42, 22),
      terrain(["rough", [94, -2], [114, -2]]),
      mesa(114, 154, 22, "green", -2),
      backstop(154, 22, 8),
    ],
  },
];

// ===========================================================================
// 3 — RED MESA (canyon). Chasms, wind, and the cannon.
// ===========================================================================

const RED_MESA: HoleSpec[] = [
  {
    name: "Mesa Steps",
    par: 3,
    hint: "Three terraces. Each one is an easy hop from the last.",
    tee: [6, 8],
    cup: [98, 26],
    parts: [
      terrain(["fairway", [-8, 8], [18, 8], [26, 8]]),
      mesa(30, 50, 14, "fairway", -8),
      mesa(54, 76, 20, "rough", -8),
      mesa(80, 116, 26, "green", -8),
      backstop(116, 26, 8),
    ],
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
      terrain(["rough", [42, -14], [82, -14]]),
      wall(82, -14, 12, 2),
      terrain(
        ["fairway", [84, 12], [100, 12]],
        ["green", [100, 12], [122, 12]],
        ["rough", [122, 12], [134, 15]],
      ),
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
      terrain(["rough", [34, -10], [68, -10]]),
      wall(68, -10, 10, 2),
      terrain(
        ["fairway", [70, 10], [80, 10]],
        ["green", [80, 10], [100, 10]],
        ["rough", [100, 10], [112, 13]],
      ),
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
      terrain(["rough", [54, -12], [82, -12]]),
      wall(82, -12, 10, 2),
      terrain(
        ["fairway", [84, 10], [96, 10]],
        ["green", [96, 10], [118, 10]],
        ["rough", [118, 10], [130, 13]],
      ),
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
        ["fairway", [55, 10], [70, 9], [84, 10]],
        ["green", [84, 10], [104, 10]],
        ["rough", [104, 10], [116, 13]],
      ),
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
        ["fairway", [-8, 10], [22, 10], [46, 9], [70, 10], [96, 10]],
        ["green", [104, 10], [126, 10]],
        ["rough", [126, 10], [138, 13]],
      ),
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
      backstop(100, 30, 8),
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
      backstop(158, 14, 8),
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
      backstop(166, 28, 8),
    ],
    floor: -24,
  },
];

// ===========================================================================
// 4 — NEON CIRCUIT (neon). Portals, rails, boosts, bumpers.
// ===========================================================================

const NEON_CIRCUIT: HoleSpec[] = [
  {
    name: "Warp One",
    par: 3,
    hint: "That wall does not open. Post the ball through the ring instead.",
    tee: [6, 10],
    cup: [86, 10],
    parts: [
      terrain(["fairway", [-8, 10], [20, 10], [34, 10]]),
      wall(38, 10, 42, 4, "metal"),
      terrain(
        ["fairway", [48, 10], [64, 10], [76, 10]],
        ["green", [76, 10], [98, 10]],
        ["rough", [98, 10], [110, 13]],
      ),
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
        ["green", [92, 10], [110, 10]],
      ),
      roof(30, 90, 16, 4, "rubber"),
      backstop(112, 10, 8),
    ],
  },
  {
    name: "Right Angle",
    par: 3,
    hint: "The exit ring stands at sixty degrees. Whatever goes in, comes out climbing.",
    tee: [6, 10],
    cup: [92, 12],
    parts: [
      terrain(["fairway", [-8, 10], [22, 10], [40, 10]]),
      wall(46, 10, 44, 3, "metal"),
      terrain(
        ["fairway", [56, 12], [78, 12]],
        ["green", [78, 12], [104, 12]],
        ["rough", [104, 12], [116, 15]],
      ),
      portals("ra", [44.4, 15, 180], [60, 13, 60], 2.4),
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
        ["metal", [-8, 10], [30, 10], [60, 10], [90, 10]],
        ["green", [100, 10], [122, 10]],
      ),
      roof(22, 96, 14, 4, "metal"),
      boost(34, 10, 0, 18),
      boost(58, 10, 0, 18),
      boost(82, 10, 0, 18),
      backstop(124, 10, 8),
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
      backstop(122, 12, 8),
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
      wall(22, 20, 40, 2, "rubber"),
      mesa(30, 46, 30, "metal", -8),
      wall(46, 12, 30, 2, "rubber"),
      mesa(54, 66, 20, "metal", -8),
      terrain(
        ["metal", [70, 12], [74, 12]],
        ["green", [74, 12], [96, 12]],
      ),
      backstop(96, 12, 8),
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
      block(33, 22, 3, 12, "metal"),
      wall(64, 10, 34, 3, "metal"),
      terrain(
        ["metal", [78, 10], [90, 10]],
        ["green", [90, 10], [112, 10]],
      ),
      backstop(112, 10, 8),
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
      terrain(["fairway", [-8, 10], [18, 10], [32, 10]]),
      wall(36, 10, 42, 3, "metal"),
      terrain(["fairway", [50, 10], [66, 10], [78, 10]]),
      mesa(94, 126, 12, "green", -6),
      backstop(126, 12, 8),
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
      terrain(["metal", [-8, 10], [24, 10], [46, 10]]),
      roof(20, 44, 14, 4, "metal"),
      boost(30, 10, 0, 18),
      wall(48, 10, 40, 3, "metal"),
      terrain(["fairway", [66, 10], [84, 10]]),
      pool(86, 122, 3),
      wall(84, 3, 10.2, 2, "rubber"),
      bumper(96, 16, 1.5),
      bumper(110, 22, 1.5),
      mesa(122, 164, 16, "green", -4),
      backstop(164, 16, 8),
      portals("cf", [46.4, 14, 180], [68, 14, 0], 2.2),
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
        ["green", [82, 12], [102, 12]],
        ["rough", [102, 12], [114, 15]],
      ),
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
      backstop(150, 12, 8),
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
        ["fairway", [-8, 12], [20, 12], [30, 12]],
        ["fairway", [37, 12], [56, 11], [72, 12]],
        ["green", [72, 12], [94, 12]],
        ["rough", [94, 12], [106, 15]],
      ),
      breakable(32, 36, 12, 22, "stone"),
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
      backstop(142, 26, 8),
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
      backstop(138, 12, 8),
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
      backstop(104, 34, 8),
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
      backstop(144, 12, 8),
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
      backstop(172, 30, 8),
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
      backstop(180, 40, 8),
    ],
  },
];

// ===========================================================================
// 7 — HOARFROST (glacier). Ice takes the brakes off everything.
// ===========================================================================

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
        ["ice", [20, 10], [48, 9.4], [72, 10]],
        ["rough", [72, 10], [78, 10]],
        ["green", [78, 10], [98, 10]],
      ),
      backstop(98, 10, 8),
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
        ["green", [100, 10], [120, 10]],
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
        ["ice", [14, 10], [50, 10], [84, 10]],
        ["sand", [84, 10], [90, 9.7]],
        ["green", [90, 9.7], [108, 9.7]],
        ["ice", [108, 9.7], [116, 8]],
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
        ["green", [102, 4], [124, 4]],
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
        ["green", [76, 10], [94, 10]],
      ),
      backstop(94, 10, 6),
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
        ["green", [84, 10], [104, 10]],
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
        ["green", [100, 40], [122, 40]],
      ),
      block(96, 24, 30, 16, "stone"),
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
      terrain(["ice", [-8, 10], [20, 10], [32, 10]]),
      wall(36, 10, 40, 3, "stone"),
      terrain(
        ["ice", [60, 10], [86, 10]],
        ["rough", [86, 10], [92, 10]],
        ["green", [92, 10], [112, 10]],
        ["ice", [112, 10], [120, 9]],
      ),
      pool(120, 142, 9),
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
        ["green", [148, 10], [168, 10]],
      ),
      backstop(168, 10, 8),
      portals("hc", [78.4, 16, 180], [108, 15, 0], 2.4),
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
    blurb: "Nine gentle holes on the water. Learn the swing.",
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
      unlockAt: 6,
    },
    EMERALD_HOLLOW,
  ),
  makeCourse(
    {
      id: "red-mesa",
      name: "Red Mesa",
      theme: "canyon",
      blurb: "Big air over bigger holes in the ground. Bring the cannon.",
      unlockAt: 15,
    },
    RED_MESA,
  ),
  makeCourse(
    {
      id: "neon-circuit",
      name: "Neon Circuit",
      theme: "neon",
      blurb: "Portals, boost pads and rubber ceilings, all after dark.",
      unlockAt: 26,
    },
    NEON_CIRCUIT,
  ),
  makeCourse(
    {
      id: "cloudbreak",
      name: "Cloudbreak",
      theme: "sky",
      blurb: "Floating islands and honest wind. Every shot is a carry.",
      unlockAt: 38,
    },
    CLOUDBREAK,
  ),
  makeCourse(
    {
      id: "cinder-rise",
      name: "Cinder Rise",
      theme: "volcano",
      blurb: "Lava below, burning bridges across it, and a long climb out.",
      unlockAt: 52,
    },
    CINDER_RISE,
  ),
  makeCourse(
    {
      id: "hoarfrost",
      name: "Hoarfrost",
      theme: "glacier",
      blurb: "Ice takes the brakes off. Nine holes about stopping.",
      unlockAt: 68,
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
