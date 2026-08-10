/**
 * BLOB — the phone control, on its own so it can be tested.
 *
 * A desktop player points at where they want to be and the cell walks there.
 * That does not translate to a phone: your thumb is *on* the dish, so pointing
 * means covering the thing you are trying to see, and holding a thumb down for
 * a whole match is genuinely tiring.
 *
 * So a phone sets a **course**: flick a direction, let go, and you keep going
 * until you set a different one. That is what the original does on a phone and
 * it is the right answer — the game is about committing to a line and living
 * with it, and a control that stops the moment you stop touching it turns every
 * chase into a thumb endurance test.
 *
 * The whole thing is two functions and no state of its own, which is why it can
 * be checked without a canvas, a pointer, or a browser.
 */

export interface Course {
  /** Unit heading. Zero-length only when `power` is 0. */
  dx: number;
  dy: number;
  /** 0 is stopped, 1 is full speed. Deflection is throttle. */
  power: number;
}

export const STOPPED: Course = { dx: 0, dy: 0, power: 0 };

/** Thumb travel, in css pixels, below which a touch is a tap and not a drag. */
export const DEADZONE = 8;
/** Travel that means full throttle. */
export const RANGE = 62;

/**
 * Fold a thumb's offset from where it landed into the current course.
 *
 * Inside the dead zone the previous course is returned untouched rather than
 * zeroed. That matters more than it looks: a thumb resting near its own origin
 * reports a jittering couple of pixels, and steering off that would spin the
 * blob on the spot every time somebody held still.
 */
export function steerCourse(prev: Course, dx: number, dy: number): Course {
  const d = Math.hypot(dx, dy);
  if (d < DEADZONE) return prev;
  return { dx: dx / d, dy: dy / d, power: Math.min(1, d / RANGE) };
}

/**
 * The point in the dish to aim at, given where the blob is *now*.
 *
 * Recomputing this every tick from the current centroid is what makes a course
 * persist: the target is always the same distance ahead, so the blob never
 * arrives and never stops. Returns the blob's own position when stopped, which
 * the sim reads as "stay put".
 */
export function aimForCourse(
  course: Course,
  cx: number,
  cy: number,
): { x: number; y: number } {
  if (course.power <= 0) return { x: cx, y: cy };
  // Near the bottom of the throttle the reach has to stay clear of the blob's
  // own radius, or the sim's arrival easing cancels the crawl entirely.
  const reach = 40 + 520 * course.power;
  return { x: cx + course.dx * reach, y: cy + course.dy * reach };
}
