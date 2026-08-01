/**
 * Vibe Kart — what the rivals can see.
 *
 * Everything in here answers one question: *given where I want to be, where do
 * I actually have to be instead?* The output is a lateral nudge in metres and a
 * throttle cut in [0,1], both of which the pilot folds into its plan rather
 * than obeying — an avoidance system that overrides the racing line outright
 * produces karts that jitter down the road dodging phantoms.
 *
 * Two things keep it honest:
 *
 *   · Everything is measured in *arc* space (metres along the lap, metres
 *     across it), never as a euclidean radius. A banana thirty metres away on
 *     the far side of the hairpin is not a threat, and a euclidean test cannot
 *     tell the difference.
 *
 *   · Nothing is dodged for free. A swerve is chosen toward the side with more
 *     corridor left, and it decays back to the line the moment the threat is
 *     behind — so the reaction reads as a driver moving over, not as a solver
 *     converging.
 */
import type * as THREE from "three";
import type { ItemKind } from "../types";
import { clamp, clamp01 } from "./math";

export interface FieldNode {
  id: number;
  /** Arc position in metres along the centreline. */
  s: number;
  lateral: number;
  /** Laps completed plus fraction — monotonic, the ordering key. */
  progress: number;
  speed: number;
  stunned: boolean;
  invincible: boolean;
  finished: boolean;
  respawning: boolean;
  position: THREE.Vector3;
  /** 1-based place, computed locally from `progress`. */
  place: number;
}

export interface HazardNode {
  kind: ItemKind;
  ownerId: number;
  s: number;
  lateral: number;
  position: THREE.Vector3;
  /** True for things that sit still and must be steered around. */
  static: boolean;
}

export interface ThreatQuery {
  id: number;
  s: number;
  lateral: number;
  speed: number;
  /** Where the pilot wanted to be before anyone got in the way. */
  wanted: number;
  corridorMin: number;
  corridorMax: number;
  lapLength: number;
  /** 0 dodges nothing, 1.4 dodges everything. */
  caution: number;
  /** High aggression drives through a rival rather than around them. */
  aggression: number;
  /** Star or mercy frames: hazards stop mattering. */
  invincible: boolean;
}

export interface ThreatResult {
  /** Signed metres to add to the wanted lateral. */
  lateral: number;
  /** Throttle cut in [0,1] — only used when there is genuinely no way past. */
  slow: number;
  /** True while something is close enough that a drift would be a bad idea. */
  crowded: boolean;
}

const result: ThreatResult = { lateral: 0, slow: 0, crowded: false };

/** Signed metres from `from` to `to` around a closed lap. */
function arcAhead(to: number, from: number, lapLength: number): number {
  let d = (to - from) % lapLength;
  if (d > lapLength * 0.5) d -= lapLength;
  else if (d < -lapLength * 0.5) d += lapLength;
  return d;
}

/**
 * How much room a swerve to `side` still has, normalised. Used to break the tie
 * when a hazard sits square on the line: go the way the road is, not the way
 * the arithmetic happens to fall out.
 */
function room(q: ThreatQuery, side: number, from: number): number {
  return side > 0 ? Math.max(0, q.corridorMax - from) : Math.max(0, from - q.corridorMin);
}

/** Radius of concern, in metres of lateral, for each kind of thing on the road. */
function hazardWidth(kind: ItemKind): number {
  switch (kind) {
    case "bobomb":
      return 5.5;
    case "blueShell":
      return 4.5;
    case "greenShell":
    case "redShell":
      return 2.6;
    case "fireflower":
      return 2.2;
    default:
      return 2.4;
  }
}

/**
 * Scan hazards and rivals, and return the correction to the pilot's intent.
 * Allocation-free: the result object is module-scoped and overwritten.
 */
export function scanThreats(
  q: ThreatQuery,
  field: readonly FieldNode[],
  hazards: readonly HazardNode[],
): ThreatResult {
  let push = 0;
  let slow = 0;
  let crowded = false;

  // --- things lying on the road -------------------------------------------
  if (!q.invincible) {
    for (let i = 0; i < hazards.length; i++) {
      const h = hazards[i];
      const ahead = arcAhead(h.s, q.s, q.lapLength);
      // A window that scales with speed: at 28 m/s a banana forty metres out is
      // a second and a half away, which is about when a driver starts moving.
      const reach = clamp(10 + q.speed * 1.35, 14, 48);
      if (ahead < 1.5 || ahead > reach) continue;
      // Your own banana, just dropped, is not something to swerve at.
      if (h.ownerId === q.id && ahead < 16) continue;

      const width = hazardWidth(h.kind) * q.caution;
      const gap = h.lateral - q.wanted;
      if (Math.abs(gap) > width) continue;

      // Urgency: near things move you more than distant ones, and a hazard dead
      // ahead moves you more than one you were going to clip anyway.
      const urgency = (1 - clamp01(ahead / reach)) * (1 - clamp01(Math.abs(gap) / width));
      let side = gap > 0 ? -1 : 1;
      if (room(q, side, q.wanted) < width + 0.8 && room(q, -side, q.wanted) > width + 0.8) side = -side;
      const target = h.lateral + side * (width + 0.9);
      push += (target - q.wanted) * urgency * 1.15;
      if (ahead < 12) crowded = true;
      // A bob-omb about to go off is worth backing out of entirely.
      if (h.kind === "bobomb" && ahead < 14) slow = Math.max(slow, 0.45);
    }
  }

  // --- rivals -------------------------------------------------------------
  for (let i = 0; i < field.length; i++) {
    const r = field[i];
    if (r.id === q.id || r.finished || r.respawning) continue;
    const ahead = arcAhead(r.s, q.s, q.lapLength);
    if (ahead < 0.5 || ahead > 26) continue;

    const gap = r.lateral - q.wanted;
    // A spun-out rival is a stationary obstacle in the middle of the road and
    // gets a wide berth; a rival merely a little slower gets a lane, not a
    // panic. Star power gets the widest berth of all.
    const spun = r.stunned || r.speed < q.speed * 0.55;
    const width = (r.invincible ? 5.0 : spun ? 4.0 : 2.9) * clamp(q.caution, 0.5, 1.4);
    if (Math.abs(gap) > width) continue;

    const closing = Math.max(0, q.speed - r.speed);
    // Time to contact, which is the only honest measure of how urgent this is.
    const ttc = closing > 0.4 ? ahead / closing : 99;
    if (ttc > 2.6 && !spun && !r.invincible) continue;

    const urgency = clamp01(1 - ahead / 26) * clamp01(1 - ttc / 3);
    let side = gap > 0 ? -1 : 1;
    if (room(q, side, q.wanted) < width + 0.6 && room(q, -side, q.wanted) > width + 0.6) side = -side;
    // The bullies barely move. That is the entire point of them.
    const yield_ = spun || r.invincible ? 1 : 1 - 0.55 * clamp01(q.aggression);
    push += (r.lateral + side * (width + 0.7) - q.wanted) * urgency * yield_;
    // Only genuinely close company counts as traffic — a rival twenty metres up
    // the road must not talk the pilot out of a drift it has time for.
    if (ahead < 13) crowded = true;

    // No room either side and closing fast: lift rather than rear-end them.
    if (room(q, side, q.wanted) < width * 0.6 && ttc < 1.1) {
      slow = Math.max(slow, clamp01(0.7 - ttc * 0.4) * (1 - 0.5 * clamp01(q.aggression)));
    }
  }

  result.lateral = clamp(push, -7, 7);
  result.slow = clamp01(slow);
  result.crowded = crowded;
  return result;
}
