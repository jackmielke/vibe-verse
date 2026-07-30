/**
 * Vibe Golf — starter course.
 *
 * Hand-authored holes that establish the shape of the data and give the game
 * something genuinely playable from the first boot. The course-design module
 * expands this into the full set; the format is the contract.
 *
 * Ground surfaces are wound left-to-right so their left-hand normal points
 * up out of the ground — the physics solver relies on that convention.
 */
import type { Course, Hole, Surface, Vec2 } from "../types";
import { v2 } from "../types";

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
): Surface {
  return {
    // Counter-clockwise so left-hand normals point outward.
    points: [v2(x, y), v2(x + w, y), v2(x + w, y + h), v2(x, y + h)],
    material,
    closed: true,
  };
}

const HOLES: Hole[] = [
  {
    id: "h1",
    name: "Opening Drive",
    par: 3,
    tee: v2(6, 12),
    cup: v2(96, 8.4),
    theme: "seaside",
    hint: "Drag back from the ball and let go. Further back is harder.",
    bounds: { min: v2(-10, -30), max: v2(120, 90) },
    surfaces: [
      ground([
        [-10, 10], [10, 10], [24, 7], [38, 12], [52, 16],
        [64, 11], [78, 8], [90, 8], [110, 8], [120, 8],
      ]),
      { ...ground([[88, 8], [104, 8]], "green"), material: "green" },
    ],
    props: [],
  },
  {
    id: "h2",
    name: "Over the Drink",
    par: 3,
    tee: v2(6, 14),
    cup: v2(104, 10.4),
    theme: "seaside",
    hint: "Water ends the shot. Carry it or lay up short.",
    bounds: { min: v2(-10, -30), max: v2(130, 90) },
    surfaces: [
      ground([[-10, 12], [8, 12], [26, 13], [38, 12]]),
      // The drink.
      { points: [v2(38, 2), v2(76, 2), v2(76, 5.5), v2(38, 5.5)], material: "water", closed: true },
      ground([[76, 9], [92, 11], [104, 10], [118, 10], [130, 10]]),
      { ...ground([[98, 10], [112, 10]], "green"), material: "green" },
      block(36, 2, 2, 7, "stone"),
      block(76, 2, 2, 7, "stone"),
    ],
    props: [],
  },
  {
    id: "h3",
    name: "The Bank Shot",
    par: 4,
    tee: v2(6, 14),
    cup: v2(78, 30.5),
    theme: "canyon",
    hint: "Rubber walls give back everything you put in.",
    bounds: { min: v2(-10, -30), max: v2(120, 110) },
    surfaces: [
      ground([[-10, 12], [12, 12], [30, 10], [44, 9]]),
      block(52, 0, 6, 28, "rubber"),
      ground([[58, 28], [70, 30], [86, 30], [100, 30], [120, 30]]),
      { ...ground([[72, 30], [86, 30]], "green"), material: "green" },
      block(96, 30, 4, 20, "stone"),
      // Sand trap short of the shelf.
      { points: [v2(44, 6), v2(52, 6), v2(52, 9), v2(44, 9)], material: "sand", closed: true },
    ],
    props: [],
  },
];

export const STARTER_COURSE: Course = {
  id: "sunset-links",
  name: "Sunset Links",
  theme: "seaside",
  blurb: "Nine gentle holes on the water. Learn the swing.",
  holes: HOLES,
};

export const COURSES: Course[] = [STARTER_COURSE];
