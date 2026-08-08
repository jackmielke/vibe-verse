/**
 * BLOB — the twenty-four other people in the dish.
 *
 * There is no multiplayer server behind this world, so the bots *are* the game.
 * That sets the bar: a bot that hoovers pellets in a straight line is scenery,
 * and a dish full of scenery is a screensaver you can lose to by accident.
 *
 * So each one runs the same four questions a person runs, in the same order:
 *
 *   1. Is something about to eat me?          → run, and run *away*, not sideways
 *   2. Can I eat something that is not food?  → chase it, and split if that lands it
 *   3. Where is the food densest?             → go there
 *   4. Am I about to reverse into a wall?     → the corner is how bots die
 *
 * Each answer contributes a vector, they are summed, and the result is a point
 * the bot steers at. Summing rather than picking a winner is the whole trick:
 * it is what produces a bot that flees a whale *along* a line of pellets, which
 * looks like judgement and is four multiplications.
 *
 * `wit` scales how far they see and how well they weigh those vectors, so the
 * Chill roster is not a different brain — it is this one, squinting.
 */
import { EAT_RATIO, MAX_CELLS, MIN_SPLIT_MASS, SPLIT_SPEED, VIRUS_MASS, WORLD, radiusOf } from "./config";
import type { BlobSim } from "./sim";
import type { Cell, Food, Player } from "./types";

/** How far a split actually carries, given the lunge decays exponentially. */
const SPLIT_REACH = 250;

const nearCells: Cell[] = [];
const nearFood: Food[] = [];

export function think(sim: BlobSim, p: Player): void {
  const brain = p.brain;
  if (!brain || !p.cells.length) return;

  // The biggest cell is the one that decides: it is what threatens others and
  // what everything else is measured against.
  let head = p.cells[0];
  for (const c of p.cells) if (c.mass > head.mass) head = c;
  const me = sim.centroid(p);
  const mass = sim.massOf(p);
  const vision = Math.max(820, head.r * 7) * (0.55 + 0.65 * brain.wit);

  let ax = 0;
  let ay = 0;

  // --- 1. Threats ----------------------------------------------------------
  // Anything that could swallow `head`, weighted by how close it is. A sharper
  // bot also respects cells that could *split* onto it, which is the difference
  // between a bot that dies to split-kills and one that keeps its distance.
  sim.cellGrid.query(me.x, me.y, vision, nearCells);
  let prey: Cell | null = null;
  let preyScore = -Infinity;
  let preyDist = 0;
  let preyWorth = 1;
  let danger = 0;

  for (let i = 0; i < nearCells.length; i++) {
    const c = nearCells[i];
    if (c.owner === p.id) continue;
    const dx = c.x - me.x;
    const dy = c.y - me.y;
    const d = Math.hypot(dx, dy) || 1;
    if (d > vision) continue;

    const eatsMe = c.mass > head.mass * EAT_RATIO;
    const splitsOntoMe =
      brain.wit > 0.5 &&
      c.mass / 2 > head.mass * EAT_RATIO &&
      c.mass >= MIN_SPLIT_MASS &&
      d < SPLIT_REACH + c.r + head.r;

    if (eatsMe || splitsOntoMe) {
      /* Inverse-square-ish falloff around a length scale set by the two bodies,
         rather than a straight ramp over the vision radius. A linear ramp made
         a predator four hundred pixels away worth about as much as a patch of
         pellets, so bots grazed towards whales; this makes anything within a
         couple of body lengths the only thing that matters, and anything far
         away a mild preference. */
      const scale = head.r + c.r + 170;
      const t = 1 / (1 + (d / scale) * (d / scale));
      const soft = splitsOntoMe && !eatsMe ? 0.6 : 1;
      const w = t * (2.2 + brain.caution * 2.4) * soft;
      ax -= (dx / d) * w;
      ay -= (dy / d) * w;
      danger = Math.max(danger, t * soft);
      continue;
    }

    if (head.mass > c.mass * EAT_RATIO * 1.05) {
      // Prefer fat, close prey. The `d` in the denominator is what stops a bot
      // crossing the dish for a crumb while a meal drifts past its face.
      const score = (c.mass * (1 + brain.aggression)) / (d + 120);
      if (score > preyScore) {
        preyScore = score;
        prey = c;
        preyDist = d;
        // How much this target is actually worth to *this* bot. A four-hundred
        // mass bot that drops everything to chase a crumb is both bad play and
        // a miserable opening minute for anybody who just spawned — the whole
        // dish converges on the smallest thing in it. Scaled by relative size,
        // a big bot will still eat you if you wander into it and will not cross
        // the room for the privilege.
        preyWorth = Math.max(0.15, Math.min(1, c.mass / (head.mass * 0.35)));
      }
    }
  }

  // --- 2. Prey -------------------------------------------------------------
  if (prey) {
    const dx = prey.x - me.x;
    const dy = prey.y - me.y;
    const d = preyDist || 1;
    const w = (0.9 + brain.aggression * 1.4) * preyWorth * Math.max(0, 1 - danger * 1.1);
    ax += (dx / d) * w;
    ay += (dy / d) * w;

    /* Spend a split on it? Only when the *halves* still comfortably out-mass
       the target — a bot that splits into a fair fight has just handed someone
       two meals — and only when it is close enough for the lunge to arrive. */
    const half = head.mass / 2;
    const canReach = d < SPLIT_REACH + head.r + prey.r;
    const worthIt = half > prey.mass * EAT_RATIO * 1.35 && half >= MIN_SPLIT_MASS;
    if (
      canReach &&
      worthIt &&
      danger < 0.3 &&
      p.cells.length < MAX_CELLS / 2 &&
      sim.random() < brain.daring
    ) {
      brain.wantSplit = true;
    }
  }

  // --- 3. Food -------------------------------------------------------------
  // Weighted mean of nearby pellets rather than "nearest pellet": the mean
  // points at the middle of a patch, so a bot grazes a field instead of
  // zig-zagging between the two crumbs closest to its face.
  sim.foodGrid.query(me.x, me.y, vision * 0.7, nearFood);
  let fx = 0;
  let fy = 0;
  let fw = 0;
  for (let i = 0; i < nearFood.length; i++) {
    const f = nearFood[i];
    const d = Math.hypot(f.x - me.x, f.y - me.y) || 1;
    const w = 1 / (d + 90);
    fx += (f.x - me.x) * w;
    fy += (f.y - me.y) * w;
    fw += w;
  }
  if (fw > 0) {
    const d = Math.hypot(fx, fy) || 1;
    const w =
      (0.75 + brain.greed * 0.9) *
      (prey ? 0.45 + (1 - preyWorth) * 0.5 : 1) *
      Math.max(0, 1 - danger * 1.15);
    ax += (fx / d) * w;
    ay += (fy / d) * w;
  }

  // --- 4. Viruses ----------------------------------------------------------
  // Big bots keep away. Small ones do the opposite when something is chasing
  // them, because sitting on a virus is the cheapest bodyguard in the game.
  const vr = radiusOf(VIRUS_MASS);
  const popsMe = head.mass > VIRUS_MASS * EAT_RATIO;
  for (const v of sim.viruses) {
    const dx = v.x - me.x;
    const dy = v.y - me.y;
    const d = Math.hypot(dx, dy) || 1;
    if (d > 620) continue;
    if (popsMe) {
      const t = Math.max(0, 1 - d / (head.r + vr + 130));
      const w = t * t * (1.4 + brain.caution);
      ax -= (dx / d) * w;
      ay -= (dy / d) * w;
    } else if (danger > 0.25) {
      const w = danger * 1.5 * brain.wit;
      ax += (dx / d) * w;
      ay += (dy / d) * w;
    }
  }

  // --- 5. Walls ------------------------------------------------------------
  // Fleeing straight into a corner is the single most common way a naive bot
  // dies, and it looks exactly as stupid as it is.
  const edge = 380 + head.r;
  if (me.x < edge) ax += (1 - me.x / edge) * 2.4;
  if (me.x > WORLD - edge) ax -= (1 - (WORLD - me.x) / edge) * 2.4;
  if (me.y < edge) ay += (1 - me.y / edge) * 2.4;
  if (me.y > WORLD - edge) ay -= (1 - (WORLD - me.y) / edge) * 2.4;

  // --- Commit --------------------------------------------------------------
  const len = Math.hypot(ax, ay);
  if (len < 1e-3) {
    // Nothing to want: keep the old heading rather than freezing, and jitter it
    // so a bored bot wanders instead of standing in a field of nothing.
    const a = Math.atan2(brain.ty - me.y, brain.tx - me.x) + (sim.random() - 0.5) * 0.6;
    brain.tx = me.x + Math.cos(a) * 500;
    brain.ty = me.y + Math.sin(a) * 500;
  } else {
    // A dull bot's aim wobbles. This is the only place `wit` shows up as
    // clumsiness rather than as blindness, and it is what makes Chill winnable.
    const wobble = (1 - brain.wit) * 0.55;
    const a =
      Math.atan2(ay, ax) + (sim.random() - 0.5) * wobble;
    brain.tx = me.x + Math.cos(a) * 520;
    brain.ty = me.y + Math.sin(a) * 520;
  }
  brain.tx = Math.max(20, Math.min(WORLD - 20, brain.tx));
  brain.ty = Math.max(20, Math.min(WORLD - 20, brain.ty));

  /* Feeding a virus: rare, deliberate, and the reason a Frenzy dish feels like
     it has people in it. A bot big enough to be worth popping, with a virus in
     front of it and something even bigger behind, spits into the virus to fire
     it at the thing chasing it. */
  if (
    brain.wit > 0.65 &&
    danger > 0.3 &&
    mass > VIRUS_MASS * 2 &&
    sim.random() < 0.06 * brain.daring
  ) {
    for (const v of sim.viruses) {
      const d = Math.hypot(v.x - me.x, v.y - me.y);
      if (d > 60 + head.r + vr || d < 1) continue;
      brain.tx = v.x;
      brain.ty = v.y;
      brain.wantEject = true;
      break;
    }
  }
}

/** Used by the tests and by nothing else: a bot with every dial at the middle. */
export function neutralBrain(): NonNullable<Player["brain"]> {
  return {
    aggression: 0.5,
    caution: 0.5,
    greed: 0.5,
    wit: 0.7,
    daring: 0.4,
    nextThink: 0,
    tx: WORLD / 2,
    ty: WORLD / 2,
    wantSplit: false,
    wantEject: false,
  };
}

/** `SPLIT_SPEED` is in here only so the reach constant above can be sanity
 *  checked against it in the tests: reach ≈ speed / damping. */
export const SPLIT_REACH_REF = SPLIT_REACH;
export const SPLIT_SPEED_REF = SPLIT_SPEED;
