/**
 * COIL — the simulation.
 *
 * Everything true about the arena lives here and nothing in this file knows a
 * canvas exists, which is what makes the rules testable: `coil.test.ts` builds
 * an arena, steps it by hand, and asserts on who died.
 *
 * ## The three rules
 *
 * 1. **A head only ever moves forwards.** You steer by turning, at a fixed
 *    number of radians per second, and your turning circle is the same whether
 *    you are ten long or a thousand.
 * 2. **Heads lose.** If your head reaches anybody else's body, you die, and it
 *    does not matter which of you is longer. This is the whole genre: size is
 *    score, never safety, and the smallest snake here can kill the biggest by
 *    getting in front of it.
 * 3. **Dying feeds the arena.** A corpse becomes a line of orbs worth most of
 *    what it was carrying, which is why a long match gets richer rather than
 *    starving, and why killing something big is worth the risk of doing it.
 *
 * Boost is the pressure valve on all three: it is the only way to close a gap
 * or escape one, it straightens your turn out while it lasts, and it burns the
 * score you are trying to protect straight onto the floor behind you where the
 * person chasing you can eat it.
 */
import { Body } from "./body";
import {
  ARENA_R,
  BOOST_DRAIN,
  BOOST_MIN_SCORE,
  BOOST_MULT,
  BOOST_ORB_INTERVAL,
  BOOST_TURN_SCALE,
  CORPSE_ORB_SPACING,
  CORPSE_VALUE_SHARE,
  HIT_COVER,
  HIT_SPACING,
  ORB_REGROW,
  ORB_TARGET,
  ORB_VALUE,
  SKILLS,
  SPEED,
  START_SCORE,
  TURN_RATE,
  lengthOf,
  radiusOf,
  type SkillId,
} from "./config";
import { HitGrid, type Hit } from "./grid";
import { Rng } from "./rng";
import { botLooks, playerLook, type Look } from "./roster";
import type { CoilEvent, Orb, Snake, Standing } from "./types";

export interface SimOptions {
  seed?: number;
  skill?: SkillId;
  /** What the player is called. Defaults to their character's name. */
  name?: string;
  /** Overrides the equipped character — the tests use it; the game does not. */
  look?: Look;
}

/** Sim time a bot waits before sliding back into the arena. */
const BOT_RESPAWN = 2.2;
/**
 * How much of its own neck a snake ignores when checking for a crash.
 *
 * Slither's snakes pass through themselves and so do these — a genre where you
 * can kill yourself by turning too hard is a genre nobody plays twice. So this
 * is not "how much of yourself is safe", it is the whole body: `crashes` never
 * tests a snake against itself at all. The constant is what keeps the *grid*
 * from being asked pointless questions about the neck.
 */
const NECK = 1.0;

export class CoilSim {
  readonly skill = SKILLS.standard;
  time = 0;
  snakes: Snake[] = [];
  orbs: Orb[] = [];
  events: CoilEvent[] = [];

  readonly hits = new HitGrid(ARENA_R * 2 + 400, 130);
  private readonly orbGrid = new HitGrid(ARENA_R * 2 + 400, 110);

  private rng: Rng;
  private nextId = 1;
  private orbDebt = 0;
  private scratch: Hit[] = [];
  private orbScratch: Hit[] = [];
  /** Orbs indexed for the grid; parallel to `orbs` and rebuilt with it. */
  private orbHits: Hit[] = [];

  constructor(opts: SimOptions = {}) {
    this.skill = SKILLS[opts.skill ?? "standard"];
    this.rng = new Rng(opts.seed ?? ((Math.random() * 0xffffffff) >>> 0));

    const mine = opts.look ?? playerLook();
    // Snake 0 is always you, and always exists — even before you press play.
    // The title screen runs a real arena behind it with your slot empty.
    this.snakes.push(this.makeSnake(0, opts.name || mine.name, mine, false));
    this.snakes[0].alive = false;

    /**
     * The cast is drawn from its OWN generator, not the arena's.
     *
     * `botLooks` shuffles the whole portrait roster, which costs one draw per
     * character in it — so with the shared stream, adding a character to
     * `characterArt.ts` silently re-rolled every seeded match in the game.
     * That is not a hypothetical: fourteen new characters landed and a boost
     * test that had nothing to do with the roster started failing, because the
     * orbs were now somewhere else.
     *
     * A second generator, offset from the same seed, keeps the cast
     * deterministic while making the arena immune to how many faces exist.
     */
    const looks = botLooks(this.skill.snakes, mine.charId, new Rng(((opts.seed ?? 0) ^ 0x5bf03635) >>> 0));
    for (let i = 0; i < looks.length; i++) {
      const s = this.makeSnake(i + 1, looks[i].name, looks[i], true);
      // `makeSnake` builds one; it does not seat it. Forgetting this line gave
      // an arena containing exactly the player and a leaderboard of nobody.
      this.snakes.push(s);
      this.spawn(s);
      // Reindex as we go. `spawn` looks for a clear spot by querying the body
      // index, and on an index that is still empty every snake finds the whole
      // arena clear — so the opening seconds were a pile-up nobody could see
      // the cause of.
      this.reindex();
      // Bots start at a spread of lengths, so the leaderboard is a race already
      // under way rather than thirty ties.
      this.grow(s, this.rng.range(0, 90));
    }

    for (let i = 0; i < ORB_TARGET; i++) this.addOrb();
    this.reindex();
  }

  get you(): Snake {
    return this.snakes[0];
  }

  random(): number {
    return this.rng.next();
  }

  /** The orb index, for the bots to look down a ray with. Exposed as a method
   *  rather than the grid itself so nothing outside can clear or rebuild it. */
  orbGridQuery(x: number, y: number, radius: number, out: Hit[]): Hit[] {
    return this.orbGrid.query(x, y, radius, out);
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  /** Point a snake at a world position. The turn rate does the rest. */
  steerTo(id: number, x: number, y: number): void {
    const s = this.snakes[id];
    if (!s || !s.alive) return;
    const dx = x - s.body.headX;
    const dy = y - s.body.headY;
    if (dx * dx + dy * dy < 1) return;
    s.targetAngle = Math.atan2(dy, dx);
  }

  /** Point a snake along an absolute heading. */
  steerAngle(id: number, angle: number): void {
    const s = this.snakes[id];
    if (!s || !s.alive) return;
    s.targetAngle = angle;
  }

  setBoost(id: number, on: boolean): void {
    const s = this.snakes[id];
    if (!s || !s.alive) return;
    s.boosting = on && s.score > BOOST_MIN_SCORE;
  }

  respawnYou(): void {
    const s = this.you;
    s.score = START_SCORE;
    s.peak = START_SCORE;
    s.kills = 0;
    this.spawn(s);
  }

  /** Swap the player's character mid-session — the picker on the title screen
   *  does this, and the body colour has to follow the head. */
  setPlayerLook(look: Look, name?: string): void {
    const s = this.you;
    s.charId = look.charId;
    s.color = look.color;
    s.name = name || look.name;
  }

  // -------------------------------------------------------------------------
  // Reading the arena
  // -------------------------------------------------------------------------

  standings(limit = 10): Standing[] {
    const rows: Standing[] = [];
    for (const s of this.snakes) {
      if (!s.alive) continue;
      rows.push({
        id: s.id,
        name: s.name,
        score: Math.round(s.score),
        color: s.color,
        charId: s.charId,
        isBot: s.isBot,
      });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows.slice(0, limit);
  }

  /** Whoever is winning, for the title screen's camera to follow. */
  leader(): Snake | null {
    let best: Snake | null = null;
    for (const s of this.snakes) {
      if (!s.alive) continue;
      if (!best || s.score > best.score) best = s;
    }
    return best;
  }

  rankOf(id: number): number {
    const me = this.snakes[id];
    if (!me || !me.alive) return 0;
    let rank = 1;
    for (const s of this.snakes) if (s.alive && s.score > me.score) rank++;
    return rank;
  }

  aliveCount(): number {
    let n = 0;
    for (const s of this.snakes) if (s.alive) n++;
    return n;
  }

  // -------------------------------------------------------------------------
  // The tick
  // -------------------------------------------------------------------------

  step(dt: number, think: (sim: CoilSim, s: Snake) => void): void {
    this.time += dt;

    for (const s of this.snakes) {
      if (!s.isBot || !s.alive || !s.brain) continue;
      if (this.time >= s.brain.nextThink) {
        s.brain.nextThink = this.time + 0.08 + this.rng.next() * 0.05;
        think(this, s);
      }
      s.targetAngle = s.brain.want;
      s.boosting = s.brain.wantBoost && s.score > BOOST_MIN_SCORE;
    }

    this.move(dt);
    this.reindex();
    this.eat();
    this.crashes();
    this.restock(dt);
    this.respawnBots();
  }

  // -------------------------------------------------------------------------
  // Motion
  // -------------------------------------------------------------------------

  private move(dt: number): void {
    for (const s of this.snakes) {
      if (!s.alive) continue;

      // Turn towards the target, but no faster than the turn rate. This one
      // clamp is the entire skill ceiling of the game.
      const turn = TURN_RATE * (s.boosting ? BOOST_TURN_SCALE : 1) * dt;
      let delta = s.targetAngle - s.angle;
      // Normalise into (-π, π] so a snake takes the short way round rather than
      // spinning 350° to make a 10° correction.
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      s.angle += Math.max(-turn, Math.min(turn, delta));

      const speed = SPEED * (s.boosting ? BOOST_MULT : 1);
      const nx = s.body.headX + Math.cos(s.angle) * speed * dt;
      const ny = s.body.headY + Math.sin(s.angle) * speed * dt;
      s.body.advance(nx, ny);
      s.body.trim(lengthOf(s.score) + 60);

      if (s.boosting) this.burn(s, dt);

      // The wall. Touching it is fatal, which is what makes the edge of the
      // arena a place you can be driven towards on purpose.
      const r = radiusOf(s.score);
      if (Math.hypot(nx, ny) > ARENA_R - r * 0.5) {
        this.kill(s, null);
      }
    }
  }

  /** Boosting costs score, and the score lands on the floor behind you. */
  private burn(s: Snake, dt: number): void {
    s.boostDebt += BOOST_DRAIN * dt;
    if (s.boostDebt >= 1) {
      const spend = Math.floor(s.boostDebt);
      s.boostDebt -= spend;
      s.score = Math.max(1, s.score - spend);
      if (s.score <= BOOST_MIN_SCORE) s.boosting = false;
    }
    if (this.time < s.nextBoostOrb) return;
    s.nextBoostOrb = this.time + BOOST_ORB_INTERVAL;
    // Dropped a little behind the tail, so you cannot immediately re-eat your
    // own exhaust and boost forever.
    const probe = { x: 0, y: 0 };
    const len = lengthOf(s.score);
    if (!s.body.at(len * 0.9, probe)) return;
    this.orbs.push({
      id: this.nextId++,
      x: probe.x,
      y: probe.y,
      value: ORB_VALUE,
      r: 6,
      hue: this.hueOf(s.color),
      phase: this.rng.range(0, Math.PI * 2),
    });
    this.events.push({ type: "boost", x: probe.x, y: probe.y, by: s.id });
  }

  // -------------------------------------------------------------------------
  // Indexing
  // -------------------------------------------------------------------------

  /**
   * Rebuild both broad phases from the positions we just wrote.
   *
   * The body index samples every snake at `HIT_SPACING` body radii. That is a
   * coarser grid than the drawn body by design — a circle every 0.9 radii still
   * leaves no gap a head could slip through, and it is four times fewer entries
   * than drawing spacing would give.
   */
  private reindex(): void {
    this.hits.clear();
    for (const s of this.snakes) {
      if (!s.alive) continue;
      const r = radiusOf(s.score);
      s.body.walk(
        r * HIT_SPACING,
        lengthOf(s.score),
        (x, y) => this.hits.insert({ x, y, snake: s.id, r }),
        r * NECK,
      );
    }
    this.orbGrid.clear();
    this.orbHits.length = 0;
    for (const o of this.orbs) {
      const h: Hit = { x: o.x, y: o.y, snake: o.id, r: o.r };
      this.orbHits.push(h);
      this.orbGrid.insert(h);
    }
  }

  // -------------------------------------------------------------------------
  // Eating
  // -------------------------------------------------------------------------

  private eat(): void {
    if (!this.orbs.length) return;
    const eaten = new Set<number>();
    const near = this.orbScratch;
    for (const s of this.snakes) {
      if (!s.alive) continue;
      const r = radiusOf(s.score);
      // A snake's mouth is a bit wider than its head. Slither does the same,
      // and without it hoovering a line of orbs feels like threading a needle.
      const reach = r + 16;
      const hx = s.body.headX;
      const hy = s.body.headY;
      this.orbGrid.query(hx, hy, reach, near);
      for (let i = 0; i < near.length; i++) {
        const h = near[i];
        if (eaten.has(h.snake)) continue;
        const dx = h.x - hx;
        const dy = h.y - hy;
        if (dx * dx + dy * dy > reach * reach) continue;
        eaten.add(h.snake);
      }
    }
    if (!eaten.size) return;
    const keep: Orb[] = [];
    for (const o of this.orbs) {
      if (!eaten.has(o.id)) {
        keep.push(o);
        continue;
      }
      // Attribute the orb to the nearest head that could have taken it. Two
      // heads arriving on the same orb in the same tick is rare and the tie
      // does not matter; what matters is that it is eaten exactly once.
      const owner = this.nearestHead(o.x, o.y);
      if (owner) {
        this.grow(owner, o.value);
        this.events.push({ type: "eat", x: o.x, y: o.y, value: o.value, by: owner.id });
      }
    }
    this.orbs = keep;
  }

  private nearestHead(x: number, y: number): Snake | null {
    let best: Snake | null = null;
    let bestD = Infinity;
    for (const s of this.snakes) {
      if (!s.alive) continue;
      const d = Math.hypot(s.body.headX - x, s.body.headY - y);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  private grow(s: Snake, by: number): void {
    s.score += by;
    if (s.score > s.peak) s.peak = s.score;
  }

  // -------------------------------------------------------------------------
  // Dying
  // -------------------------------------------------------------------------

  /**
   * Heads against bodies.
   *
   * A snake is never tested against itself: crossing your own line is legal
   * here exactly as it is in the game this is modelled on. Tested against
   * everybody else's, a head dies on contact regardless of who is longer, which
   * is the rule the whole genre turns on.
   */
  private crashes(): void {
    const dead: { snake: Snake; into: number }[] = [];
    const near = this.scratch;
    for (const s of this.snakes) {
      if (!s.alive) continue;
      const r = radiusOf(s.score);
      const hx = s.body.headX;
      const hy = s.body.headY;
      this.hits.query(hx, hy, r + 60, near);
      for (let i = 0; i < near.length; i++) {
        const h = near[i];
        if (h.snake === s.id) continue;
        const dx = h.x - hx;
        const dy = h.y - hy;
        const reach = (r + h.r) * HIT_COVER;
        if (dx * dx + dy * dy > reach * reach) continue;
        dead.push({ snake: s, into: h.snake });
        break;
      }
    }
    // Collected first and applied after, so two snakes running into each other
    // in the same tick both die. Applying as we go would let whichever was
    // checked first stop existing and let the other one through.
    for (const d of dead) this.kill(d.snake, d.into);
  }

  private kill(s: Snake, into: number | null): void {
    if (!s.alive) return;
    s.alive = false;
    s.diedAt = this.time;
    s.boosting = false;
    const score = Math.round(s.score);
    this.events.push({
      type: "crash",
      x: s.body.headX,
      y: s.body.headY,
      by: s.id,
      into: into ?? -1,
      score,
    });
    if (into !== null && into >= 0) {
      const killer = this.snakes[into];
      if (killer && killer.id !== s.id) {
        killer.kills++;
        this.events.push({
          type: "kill",
          killer: killer.name,
          victim: s.name,
          color: s.color,
          score,
        });
      }
    }
    this.scatter(s);
  }

  /** A corpse becomes orbs along the line it was lying on. */
  private scatter(s: Snake): void {
    const len = lengthOf(s.score);
    const total = s.score * CORPSE_VALUE_SHARE;
    const count = Math.max(3, Math.floor(len / CORPSE_ORB_SPACING));
    const each = Math.max(1, total / count);
    const hue = this.hueOf(s.color);
    let made = 0;
    s.body.walk(CORPSE_ORB_SPACING, len, (x, y) => {
      if (made >= count) return;
      made++;
      // Jittered off the line, so a corpse reads as a spill rather than a
      // dotted stripe somebody drew.
      this.orbs.push({
        id: this.nextId++,
        x: x + this.rng.range(-9, 9),
        y: y + this.rng.range(-9, 9),
        value: each,
        r: 8 + Math.min(7, each * 0.6),
        hue,
        phase: this.rng.range(0, Math.PI * 2),
      });
    });
    s.score = START_SCORE;
    s.boostDebt = 0;
  }

  // -------------------------------------------------------------------------
  // Upkeep
  // -------------------------------------------------------------------------

  private restock(dt: number): void {
    this.orbDebt += ORB_REGROW * dt;
    while (this.orbDebt >= 1 && this.orbs.length < ORB_TARGET) {
      this.orbDebt -= 1;
      this.addOrb();
    }
    if (this.orbs.length >= ORB_TARGET) this.orbDebt = 0;
  }

  private respawnBots(): void {
    for (const s of this.snakes) {
      if (s.alive || !s.isBot) continue;
      if (this.time - s.diedAt < BOT_RESPAWN) continue;
      this.spawn(s);
    }
  }

  // -------------------------------------------------------------------------
  // Making things
  // -------------------------------------------------------------------------

  private makeSnake(id: number, name: string, look: Look, isBot: boolean): Snake {
    return {
      id,
      name,
      charId: look.charId,
      color: look.color,
      isBot,
      alive: true,
      body: new Body(0, 0),
      angle: 0,
      targetAngle: 0,
      boosting: false,
      score: START_SCORE,
      peak: START_SCORE,
      kills: 0,
      diedAt: -1,
      boostDebt: 0,
      nextBoostOrb: 0,
      brain: isBot
        ? {
            wit: this.skill.wit * this.rng.range(0.75, 1.05),
            daring: this.skill.daring * this.rng.range(0.6, 1.2),
            greed: this.rng.range(0.4, 1),
            nextThink: this.rng.range(0, 0.1),
            want: 0,
            wantBoost: false,
            commitUntil: 0,
            nextCut: 0,
          }
        : undefined,
    };
  }

  private addOrb(): void {
    const p = this.rng.inDisc(ARENA_R - 40);
    this.orbs.push({
      id: this.nextId++,
      x: p.x,
      y: p.y,
      value: ORB_VALUE,
      r: 5 + this.rng.range(0, 2.5),
      hue: this.rng.range(0, 360),
      phase: this.rng.range(0, Math.PI * 2),
    });
  }

  /**
   * Put a snake back in, somewhere with nothing lethal nearby and pointing
   * inwards.
   *
   * Pointing inwards matters more than it sounds: spawn on the outer half of a
   * round arena facing outwards and the wall arrives before the first turn
   * finishes, which reads as the game killing you during the loading screen.
   */
  private spawn(s: Snake): void {
    let bx = 0;
    let by = 0;
    let bestClear = -1;
    for (let i = 0; i < 22; i++) {
      const p = this.rng.inDisc(ARENA_R * 0.82);
      let clear = ARENA_R - Math.hypot(p.x, p.y);
      const near = this.scratch;
      this.hits.query(p.x, p.y, 260, near);
      for (let j = 0; j < near.length; j++) {
        if (near[j].snake === s.id) continue;
        clear = Math.min(clear, Math.hypot(near[j].x - p.x, near[j].y - p.y));
      }
      if (clear > bestClear) {
        bestClear = clear;
        bx = p.x;
        by = p.y;
      }
      if (clear > 340) break;
    }
    s.body.reset(bx, by);
    s.angle = Math.atan2(-by, -bx) + this.rng.range(-0.6, 0.6);
    s.targetAngle = s.angle;
    s.score = START_SCORE;
    s.peak = Math.max(s.peak, START_SCORE);
    s.alive = true;
    s.diedAt = -1;
    s.boosting = false;
    s.boostDebt = 0;
    if (s.brain) {
      s.brain.want = s.angle;
      s.brain.wantBoost = false;
      s.brain.commitUntil = 0;
    }
  }

  /** Rough hue of a hex accent, so a corpse's orbs match the snake that made
   *  them without carrying a second colour format around. */
  private hueOf(hex: string): number {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return 280;
    const n = parseInt(m[1], 16);
    const r = ((n >> 16) & 255) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (d < 1e-4) return 0;
    let h: number;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
  }
}
