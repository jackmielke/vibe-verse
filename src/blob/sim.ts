/**
 * BLOB — the simulation.
 *
 * Everything that is true about the dish lives here, and nothing in this file
 * knows that a canvas exists. That separation is what makes the rules testable:
 * `blob.test.ts` builds a sim, steps it by hand and asserts on masses, with no
 * DOM anywhere near it.
 *
 * ## The three rules the whole game is made of
 *
 * 1. You are a list of cells. Every cell steers towards one point — the cursor,
 *    the thumb, or whatever a bot has decided it wants — at a speed set by how
 *    heavy it is.
 * 2. A cell eats another when it is `EAT_RATIO` times heavier *and* has actually
 *    swallowed it (see `EAT_COVER`). Cells of the same owner never eat each
 *    other; after a delay, they merge.
 * 3. Splitting doubles your reach and halves your safety, and that trade is the
 *    only real decision in the game.
 *
 * Everything else — viruses, ejected mass, decay — exists to stop one of those
 * three rules from having a dominant strategy.
 *
 * ## Fixed timestep
 *
 * `step(dt)` expects to be called with a fixed `TICK`. The renderer interpolates
 * between the last two positions, which is why every cell carries `px`/`py`. A
 * variable timestep would make split distance depend on frame rate, and a game
 * where a 144 Hz monitor lunges further than a 60 Hz laptop is a game with a
 * hardware requirement instead of a skill curve.
 */
import {
  BOOST_DAMP,
  DECAY_FLOOR,
  DECAY_RATE,
  EAT_COVER,
  EAT_RATIO,
  EJECT_COST,
  EJECT_MASS,
  EJECT_SPEED,
  FOOD_MASS,
  FOOD_REGROW,
  FOOD_TARGET,
  MAX_CELLS,
  MIN_SPLIT_MASS,
  MODES,
  SKILLS,
  SPLIT_SPEED,
  START_MASS,
  VIRUS_FEED,
  VIRUS_MASS,
  VIRUS_SHOT_SPEED,
  VIRUS_TARGET,
  WORLD,
  mergeDelay,
  radiusOf,
  speedOf,
  type ModeId,
  type SkillId,
} from "./config";
import { hueFor, pickNames } from "./names";
import { Rng } from "./rng";
import { Grid } from "./spatial";
import type { Cell, Food, Pellet, Player, SimEvent, Standing, Virus } from "./types";

export interface SimOptions {
  seed?: number;
  mode?: ModeId;
  skill?: SkillId;
  /** What the player is called on the leaderboard. */
  name?: string;
}

/** Sim time a bot waits before climbing back into the dish. */
const BOT_RESPAWN = 2.6;
/** A remote cell that moved further than this between packets was not moving —
 *  it respawned, or it was flung by a split. Snap rather than slide. */
const TELEPORT_DIST = 420;
/** Seconds you cannot re-swallow your own ejected mass. Without it, W is a
 *  no-op: the pellet leaves your edge and walks straight back in. */
const EJECT_IMMUNITY = 0.55;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export class BlobSim {
  readonly mode = MODES.ffa;
  readonly skill = SKILLS.standard;
  /** Seconds simulated since the match began. */
  time = 0;
  players: Player[] = [];
  food: Food[] = [];
  pellets: Pellet[] = [];
  viruses: Virus[] = [];
  /** Drained by the engine every frame and handed to audio and the renderer. */
  events: SimEvent[] = [];

  readonly cellGrid = new Grid<Cell>(WORLD, 220);
  readonly foodGrid = new Grid<Food>(WORLD, 128);
  private readonly pelletGrid = new Grid<Pellet>(WORLD, 128);

  private rng: Rng;
  private nextId = 1;
  /** Fractional pellets owed to the dish, carried between ticks. */
  private foodDebt = 0;
  private scratchA: (Cell | Food | Pellet)[] = [];
  private allCells: Cell[] = [];
  /** Viruses created since the host last broadcast. See `takeSpawnedViruses`. */
  private spawnedViruses: [number, number, number][] = [];

  constructor(opts: SimOptions = {}) {
    this.mode = MODES[opts.mode ?? "ffa"];
    this.skill = SKILLS[opts.skill ?? "standard"];
    this.rng = new Rng(opts.seed ?? ((Math.random() * 0xffffffff) >>> 0));

    const roster = this.skill.bots;
    const names = pickNames(roster, () => this.rng.next());

    // Player 0 is always you, and always exists — even before you have pressed
    // play. The title screen runs a real match behind it with your slot empty,
    // which is why `alive` starts false rather than the player starting absent.
    this.players.push({
      id: 0,
      name: opts.name || "you",
      hue: 194,
      isBot: false,
      cells: [],
      aimX: WORLD / 2,
      aimY: WORLD / 2,
      peak: 0,
      kills: 0,
      diedAt: -1,
      alive: false,
    });

    for (let i = 0; i < roster; i++) {
      const id = i + 1;
      this.players.push({
        id,
        name: names[i],
        hue: hueFor(i, roster),
        isBot: true,
        cells: [],
        aimX: WORLD / 2,
        aimY: WORLD / 2,
        peak: 0,
        kills: 0,
        diedAt: -1,
        alive: false,
        brain: {
          aggression: this.rng.range(0.25, 1),
          caution: this.rng.range(0.3, 1),
          greed: this.rng.range(0.4, 1),
          wit: this.skill.wit * this.rng.range(0.75, 1.05),
          daring: this.skill.daring * this.rng.range(0.6, 1.15),
          nextThink: this.rng.range(0, 0.14),
          tx: WORLD / 2,
          ty: WORLD / 2,
          wantSplit: false,
          wantEject: false,
        },
      });
      this.spawn(this.players[id]);
      // Bots start scattered in size as well as in space, so the leaderboard is
      // a race that is already under way rather than thirty ties.
      const c = this.players[id].cells[0];
      this.setMass(c, START_MASS * this.rng.range(0.9, 4.5));
    }

    for (let i = 0; i < FOOD_TARGET; i++) this.addFood();
    for (let i = 0; i < VIRUS_TARGET; i++) this.addVirus();
    // Bots think before the first tick indexes anything, and a brain that opens
    // its eyes on an empty grid spends its first decision blind.
    this.reindex();
  }

  /** The sim's own random stream, so bot decisions stay part of the seed. A bot
   *  reaching for `Math.random` would make a seeded match unreproducible. */
  random(): number {
    return this.rng.next();
  }

  /**
   * Whether this client is the one that decides what a player does.
   *
   * Every rule that *changes* a player — moving, eating, splitting, merging,
   * rotting — is gated on this. Offline it is true for everybody and the sim
   * behaves exactly as it always did; in a room it is false for your friends
   * and, unless you are the host, for the bots as well.
   */
  owns(id: number): boolean {
    const p = this.players[id];
    return !!p && !p.remote;
  }

  // -------------------------------------------------------------------------
  // Seats for other people
  // -------------------------------------------------------------------------

  /**
   * Add a player driven by somebody else's client, and hand back its id.
   *
   * Appended rather than seated in a reserved block: the roster is already a
   * plain array indexed by id, the leaderboard sorts by mass, and the eat rules
   * do not care who is a person. A friend arriving is simply one more player.
   */
  addRemotePlayer(peerId: string, name: string, hue: number): number {
    const id = this.players.length;
    this.players.push({
      id,
      name,
      hue,
      isBot: false,
      remote: true,
      peerId,
      cells: [],
      aimX: WORLD / 2,
      aimY: WORLD / 2,
      peak: 0,
      kills: 0,
      diedAt: -1,
      alive: false,
    });
    return id;
  }

  /** A friend closed the tab. Their blob goes with them. */
  dropPlayer(id: number): void {
    const p = this.players[id];
    if (!p) return;
    p.cells.length = 0;
    p.alive = false;
    p.peerId = undefined;
    p.diedAt = this.time;
  }

  playerByPeer(peerId: string): Player | undefined {
    return this.players.find((p) => p.peerId === peerId);
  }

  /**
   * Hand every bot over to the host's client, or take them back.
   *
   * Bots are the reason a room needs a host at all. Simulated independently on
   * each client they diverge within seconds — same seed, but split decisions
   * land on different ticks — and then you watch a friend get eaten by a blob
   * that, on your screen, is somewhere else entirely. One client runs them and
   * the rest read the wire.
   */
  setBotsRemote(remote: boolean): void {
    for (const p of this.players) {
      if (!p.isBot) continue;
      p.remote = remote;
      if (remote) {
        // Freeze rather than clear: the next packet overwrites these anyway,
        // and clearing would blink every bot out of the dish for a frame.
        for (const c of p.cells) {
          c.vx = 0;
          c.vy = 0;
        }
      }
    }
  }

  /**
   * Replace a remote player's cells with what their client just told us.
   *
   * `px`/`py` keep their previous values so the renderer interpolates towards
   * the new position instead of teleporting — a packet is a destination, not a
   * jump. Cells are matched by id so a blob keeps its wobble across updates.
   */
  writeCells(
    id: number,
    wire: readonly { id: number; x: number; y: number; mass: number }[],
  ): void {
    const p = this.players[id];
    if (!p) return;
    const existing = new Map(p.cells.map((c) => [c.id, c]));
    const next: Cell[] = [];
    for (const w of wire) {
      const had = existing.get(w.id);
      if (had) {
        had.tx = w.x;
        had.ty = w.y;
        // A jump this far is a respawn or a split lunge, not movement. Easing
        // towards it would slide a blob across the dish over half a second.
        if (Math.hypot(w.x - had.x, w.y - had.y) > TELEPORT_DIST) {
          had.x = w.x;
          had.y = w.y;
          had.px = w.x;
          had.py = w.y;
        }
        this.setMass(had, w.mass);
        next.push(had);
      } else {
        const c = this.makeCellDetached(p, w.id, w.x, w.y, w.mass);
        next.push(c);
      }
    }
    p.cells = next;
    if (next.length) {
      if (!p.alive) p.diedAt = -1;
      p.alive = true;
      const m = this.massOf(p);
      if (m > p.peak) p.peak = m;
    } else if (p.alive) {
      p.alive = false;
      p.diedAt = this.time;
    }
  }

  /** A cell that already has an id, because the client that owns it chose one. */
  private makeCellDetached(p: Player, id: number, x: number, y: number, mass: number): Cell {
    const c: Cell = {
      id,
      owner: p.id,
      x,
      y,
      px: x,
      py: y,
      tx: x,
      ty: y,
      vx: 0,
      vy: 0,
      mass,
      r: radiusOf(mass),
      mergeAt: 0,
      bornAt: this.time,
    };
    p.cells.push(c);
    return c;
  }

  /** Somebody else's client says it ate these cells of ours. Sender authority:
   *  the eater decides, because only one of the two can be right and the eater
   *  is the one whose screen the bite happened on. */
  killCells(id: number, cellIds: readonly number[]): void {
    const p = this.players[id];
    if (!p || !p.cells.length) return;
    const gone = new Set(cellIds);
    const before = p.cells.length;
    const mass = this.massOf(p);
    p.cells = p.cells.filter((c) => !gone.has(c.id));
    if (p.cells.length === before) return;
    if (p.cells.length === 0 && p.alive) {
      p.alive = false;
      p.diedAt = this.time;
      this.events.push({ type: "death", id: p.id, name: p.name, mass });
    }
  }

  /** Remove a virus somebody else popped, so the dish agrees about the board. */
  removeVirus(virusId: number): void {
    const i = this.viruses.findIndex((v) => v.id === virusId);
    if (i >= 0) this.viruses.splice(i, 1);
  }

  /** Add a virus the host spawned, with the host's id so pops can name it. */
  addVirusAt(id: number, x: number, y: number): void {
    if (this.viruses.some((v) => v.id === id)) return;
    this.viruses.push({
      id,
      x,
      y,
      vx: 0,
      vy: 0,
      mass: VIRUS_MASS,
      fed: 0,
      feedAngle: 0,
      spin: this.rng.range(0, Math.PI * 2),
    });
  }

  /**
   * Stop inventing viruses locally.
   *
   * On a client, a virus that grows back after a pop would be a virus nobody
   * else can see. The host restocks and says so.
   */
  virusesFromWire = false;

  // -------------------------------------------------------------------------
  // The player's handle on the world
  // -------------------------------------------------------------------------

  get you(): Player {
    return this.players[0];
  }

  setAim(id: number, x: number, y: number): void {
    const p = this.players[id];
    if (!p) return;
    p.aimX = x;
    p.aimY = y;
  }

  /**
   * Split every cell that is big enough, biggest first, until the cap.
   *
   * Biggest first is not arbitrary: with a mixed bag of cells, splitting the
   * heavy ones is what a player means by "split", and spending the cap on four
   * crumbs while a 900-mass cell sits there intact feels broken.
   */
  requestSplit(id: number): void {
    const p = this.players[id];
    if (!p || !p.alive || p.remote) return;
    const candidates = [...p.cells].sort((a, b) => b.mass - a.mass);
    for (const c of candidates) {
      if (p.cells.length >= MAX_CELLS) break;
      if (c.mass < MIN_SPLIT_MASS) continue;
      this.splitCell(p, c, this.aimAngle(p, c), SPLIT_SPEED);
      this.events.push({ type: "split", x: c.x, y: c.y, by: p.id });
    }
  }

  /** Spit a pellet from every cell that can afford one. */
  requestEject(id: number): void {
    const p = this.players[id];
    if (!p || !p.alive || p.remote) return;
    for (const c of p.cells) {
      if (c.mass < EJECT_COST + MIN_SPLIT_MASS * 0.5) continue;
      const a = this.aimAngle(p, c);
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      this.setMass(c, c.mass - EJECT_COST);
      this.pellets.push({
        id: this.nextId++,
        x: c.x + dx * (c.r + 4),
        y: c.y + dy * (c.r + 4),
        vx: dx * EJECT_SPEED,
        vy: dy * EJECT_SPEED,
        mass: EJECT_MASS,
        hue: p.hue,
        from: p.id,
        bornAt: this.time,
      });
      this.events.push({ type: "eject", x: c.x, y: c.y, by: p.id });
    }
  }

  /** Drop the player back into the dish at starting size. */
  respawnYou(): void {
    const p = this.you;
    p.cells.length = 0;
    p.kills = 0;
    p.diedAt = -1;
    this.spawn(p);
  }

  /** Total mass, which is both the score and what the camera is keyed to. */
  massOf(p: Player): number {
    let m = 0;
    for (const c of p.cells) m += c.mass;
    return m;
  }

  /** Mass-weighted centre of a player's cells — where the camera looks. */
  centroid(p: Player, alpha = 1): { x: number; y: number } {
    let mx = 0;
    let my = 0;
    let m = 0;
    for (const c of p.cells) {
      const x = c.px + (c.x - c.px) * alpha;
      const y = c.py + (c.y - c.py) * alpha;
      mx += x * c.mass;
      my += y * c.mass;
      m += c.mass;
    }
    if (m <= 0) return { x: WORLD / 2, y: WORLD / 2 };
    return { x: mx / m, y: my / m };
  }

  /** The leaderboard, heaviest first. */
  standings(limit = 10): Standing[] {
    const rows: Standing[] = [];
    for (const p of this.players) {
      if (!p.alive) continue;
      rows.push({ id: p.id, name: p.name, mass: this.massOf(p), hue: p.hue, isBot: p.isBot });
    }
    rows.sort((a, b) => b.mass - a.mass);
    return rows.slice(0, limit);
  }

  /** Where the camera should sit when the player is not in the dish: on
   *  whoever is winning, so the title screen is a live match and not a wall. */
  leader(): Player | null {
    let best: Player | null = null;
    let bestMass = -1;
    for (const p of this.players) {
      if (!p.alive) continue;
      const m = this.massOf(p);
      if (m > bestMass) {
        bestMass = m;
        best = p;
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // The tick
  // -------------------------------------------------------------------------

  step(dt: number, think: (sim: BlobSim, p: Player) => void): void {
    this.time += dt;

    // 1. Bots decide. They think about seven times a second; running a brain at
    //    60 Hz costs thirty times as much and looks identical.
    for (const p of this.players) {
      if (!p.isBot || !p.alive || !p.brain || p.remote) continue;
      if (this.time >= p.brain.nextThink) {
        p.brain.nextThink = this.time + 0.1 + this.rng.next() * 0.06;
        think(this, p);
      }
      p.aimX = p.brain.tx;
      p.aimY = p.brain.ty;
      if (p.brain.wantSplit) {
        p.brain.wantSplit = false;
        this.requestSplit(p.id);
      }
      if (p.brain.wantEject) {
        p.brain.wantEject = false;
        this.requestEject(p.id);
      }
    }

    // 2. Move everything.
    this.moveCells(dt);
    this.moveLoose(dt);

    // 3. Rebuild the broad phase from the positions we just wrote.
    this.reindex();

    // 4. Resolve, in the order the rules depend on each other: a cell has to
    //    have eaten its pellets before we ask whether it is big enough to pop
    //    on a virus, and it has to have popped before anything eats the pieces.
    this.eatFood();
    this.eatPellets();
    this.feedViruses();
    this.hitViruses();
    this.eatCells();
    this.mergeAndSeparate();

    // 5. Bookkeeping: rot, restock, respawn.
    this.decay(dt);
    this.restock(dt);
    this.respawnBots();

    for (const p of this.players) {
      if (!p.alive) continue;
      const m = this.massOf(p);
      if (m > p.peak) p.peak = m;
    }
  }

  // -------------------------------------------------------------------------
  // Movement
  // -------------------------------------------------------------------------

  private moveCells(dt: number): void {
    const damp = Math.exp(-BOOST_DAMP * dt);
    for (const p of this.players) {
      /* A remote blob's motion arrives in packets, twelve a second against
         sixty frames. Snapping to each one steps it across the dish; easing
         towards it turns the same data into smooth movement, at the cost of
         being an interpolation behind. That is the right trade — a friend who
         is 80 ms in the past is invisible, a friend who teleports is not. */
      if (p.remote) {
        const k = 1 - Math.exp(-14 * dt);
        for (const c of p.cells) {
          c.px = c.x;
          c.py = c.y;
          if (c.tx === undefined || c.ty === undefined) continue;
          c.x += (c.tx - c.x) * k;
          c.y += (c.ty - c.y) * k;
        }
        continue;
      }
      for (const c of p.cells) {
        c.px = c.x;
        c.py = c.y;

        const dx = p.aimX - c.x;
        const dy = p.aimY - c.y;
        const d = Math.hypot(dx, dy);
        if (d > 1e-3) {
          /* Ease off as the target gets close. Without this a cell judders on
             top of the cursor at full speed, and — worse on a phone — a thumb
             resting near the middle of the screen makes a giant twitch. */
          const ease = clamp(d / Math.max(c.r * 0.9, 26), 0, 1);
          const sp = speedOf(c.mass) * ease;
          c.x += (dx / d) * sp * dt;
          c.y += (dy / d) * sp * dt;
        }

        c.x += c.vx * dt;
        c.y += c.vy * dt;
        c.vx *= damp;
        c.vy *= damp;
        if (Math.abs(c.vx) < 3) c.vx = 0;
        if (Math.abs(c.vy) < 3) c.vy = 0;

        this.confine(c);
      }
    }
  }

  /** Keep a cell inside the dish, and kill the component of its lunge that is
   *  pointing at the wall so it does not grind along the edge for a second. */
  private confine(c: Cell): void {
    const pad = Math.min(c.r, WORLD * 0.25);
    if (c.x < pad) {
      c.x = pad;
      if (c.vx < 0) c.vx = 0;
    } else if (c.x > WORLD - pad) {
      c.x = WORLD - pad;
      if (c.vx > 0) c.vx = 0;
    }
    if (c.y < pad) {
      c.y = pad;
      if (c.vy < 0) c.vy = 0;
    } else if (c.y > WORLD - pad) {
      c.y = WORLD - pad;
      if (c.vy > 0) c.vy = 0;
    }
  }

  private moveLoose(dt: number): void {
    const damp = Math.exp(-6 * dt);
    for (const p of this.pellets) {
      p.x = clamp(p.x + p.vx * dt, 4, WORLD - 4);
      p.y = clamp(p.y + p.vy * dt, 4, WORLD - 4);
      p.vx *= damp;
      p.vy *= damp;
    }
    for (const v of this.viruses) {
      v.x = clamp(v.x + v.vx * dt, radiusOf(v.mass), WORLD - radiusOf(v.mass));
      v.y = clamp(v.y + v.vy * dt, radiusOf(v.mass), WORLD - radiusOf(v.mass));
      v.vx *= damp;
      v.vy *= damp;
      v.spin += dt * 0.25;
    }
  }

  private reindex(): void {
    this.allCells.length = 0;
    for (const p of this.players) for (const c of p.cells) this.allCells.push(c);
    this.cellGrid.clear();
    this.cellGrid.insertAll(this.allCells);
    this.foodGrid.clear();
    this.foodGrid.insertAll(this.food);
    this.pelletGrid.clear();
    this.pelletGrid.insertAll(this.pellets);
  }

  // -------------------------------------------------------------------------
  // Eating
  // -------------------------------------------------------------------------

  private eatFood(): void {
    const near = this.scratchA as Food[];
    const eaten = new Set<Food>();
    for (const c of this.allCells) {
      if (!this.owns(c.owner)) continue;
      this.foodGrid.query(c.x, c.y, c.r, near);
      for (let i = 0; i < near.length; i++) {
        const f = near[i];
        if (eaten.has(f)) continue;
        const dx = f.x - c.x;
        const dy = f.y - c.y;
        // A pellet is swallowed the moment its centre is inside you. Requiring
        // full containment makes the early game feel sticky for no gain.
        if (dx * dx + dy * dy > c.r * c.r) continue;
        eaten.add(f);
        this.setMass(c, c.mass + f.mass);
        this.events.push({ type: "eat", x: f.x, y: f.y, mass: f.mass, hue: f.hue, by: c.owner });
      }
    }
    if (eaten.size) this.food = this.food.filter((f) => !eaten.has(f));
  }

  private eatPellets(): void {
    if (!this.pellets.length) return;
    const near = this.scratchA as Pellet[];
    const eaten = new Set<Pellet>();
    for (const c of this.allCells) {
      if (!this.owns(c.owner)) continue;
      this.pelletGrid.query(c.x, c.y, c.r, near);
      for (let i = 0; i < near.length; i++) {
        const p = near[i];
        if (eaten.has(p)) continue;
        // Your own spit is yours again in half a second, not instantly.
        if (p.from === c.owner && this.time - p.bornAt < EJECT_IMMUNITY) continue;
        if (c.mass < p.mass * EAT_RATIO) continue;
        const dx = p.x - c.x;
        const dy = p.y - c.y;
        if (dx * dx + dy * dy > c.r * c.r) continue;
        eaten.add(p);
        this.setMass(c, c.mass + p.mass);
        this.events.push({ type: "eat", x: p.x, y: p.y, mass: p.mass, hue: p.hue, by: c.owner });
      }
    }
    if (eaten.size) this.pellets = this.pellets.filter((p) => !eaten.has(p));
  }

  /**
   * Cell eats cell — the only pass in here that ends someone's game.
   *
   * Heaviest first, so that when three blobs pile onto one crumb the outcome
   * matches what a player watching it would predict. Masses are read as they
   * change, which means a cell that eats twice in a tick really is bigger for
   * the second bite; that is a rounding-level difference and it errs towards
   * the aggressor, which is the more satisfying way for it to be wrong.
   */
  private eatCells(): void {
    const order = [...this.allCells].sort((a, b) => b.mass - a.mass);
    const dead = new Set<Cell>();
    const near = this.scratchA as Cell[];
    for (const a of order) {
      if (dead.has(a)) continue;
      /* The eater must be ours. Both sides of a bite compute the same result
         from slightly different positions, so if both applied it the two
         clients would disagree about who survived — and a player watching
         themselves die on someone else's screen only is the worst bug this
         game could have. The eater's client decides and says so. */
      if (!this.owns(a.owner)) continue;
      this.cellGrid.query(a.x, a.y, a.r, near);
      for (let i = 0; i < near.length; i++) {
        const b = near[i];
        if (b === a || dead.has(b) || b.owner === a.owner) continue;
        if (a.mass < b.mass * EAT_RATIO) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const reach = a.r - b.r * EAT_COVER;
        if (reach <= 0 || dx * dx + dy * dy > reach * reach) continue;
        dead.add(b);
        this.setMass(a, a.mass + b.mass);
        const victim = this.players[b.owner];
        this.events.push({
          type: "eat",
          x: b.x,
          y: b.y,
          mass: b.mass,
          hue: victim ? victim.hue : 0,
          by: a.owner,
          victim: b.owner,
          cell: b.id,
        });
      }
    }
    if (dead.size) this.reap(dead);
  }

  /** Remove eaten cells from their owners and settle up anybody who ran out. */
  private reap(dead: Set<Cell>): void {
    for (const p of this.players) {
      if (!p.cells.some((c) => dead.has(c))) continue;
      const mass = this.massOf(p);
      p.cells = p.cells.filter((c) => !dead.has(c));
      if (p.cells.length) continue;

      p.alive = false;
      p.diedAt = this.time;
      // Whoever took the last cell gets the credit on the kill feed.
      const killer = this.lastEaterOf(p, dead);
      if (killer && killer.id !== p.id) {
        killer.kills++;
        this.events.push({
          type: "kill",
          killer: killer.name,
          victim: p.name,
          hue: p.hue,
          victimMass: mass,
        });
      }
      this.events.push({ type: "death", id: p.id, name: p.name, mass });
    }
  }

  /**
   * Who ate the last of `p`.
   *
   * There is no record on the cell of what swallowed it, and adding one would
   * mean carrying a field through every eat path for the sake of a line of
   * text. Instead: of everything alive and overlapping the victim's final
   * cells, the biggest one that could legally have eaten them is the killer.
   * It is right essentially always and wrong harmlessly — a wrong name on a
   * kill feed is a cosmetic bug, and the alternative was a field nobody
   * remembers to set.
   */
  private lastEaterOf(p: Player, dead: Set<Cell>): Player | undefined {
    let best: Player | undefined;
    let bestMass = 0;
    for (const c of dead) {
      if (c.owner !== p.id) continue;
      for (const other of this.allCells) {
        if (dead.has(other) || other.owner === p.id) continue;
        if (other.mass < c.mass * EAT_RATIO) continue;
        const d = Math.hypot(other.x - c.x, other.y - c.y);
        if (d > other.r + c.r) continue;
        if (other.mass > bestMass) {
          bestMass = other.mass;
          best = this.players[other.owner];
        }
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Viruses
  // -------------------------------------------------------------------------

  private feedViruses(): void {
    if (!this.pellets.length) return;
    const eaten = new Set<Pellet>();
    for (const v of this.viruses) {
      const vr = radiusOf(v.mass);
      for (const p of this.pellets) {
        if (eaten.has(p)) continue;
        const dx = p.x - v.x;
        const dy = p.y - v.y;
        if (dx * dx + dy * dy > vr * vr) continue;
        eaten.add(p);
        v.fed++;
        v.feedAngle = Math.atan2(p.vy, p.vx);
        if (v.fed >= VIRUS_FEED) {
          v.fed = 0;
          // The child is launched the way the food was travelling, which is
          // what makes feeding a virus into a crowd a weapon rather than litter.
          const dxs = Math.cos(v.feedAngle);
          const dys = Math.sin(v.feedAngle);
          const shotId = this.nextId++;
          this.spawnedViruses.push([
            shotId,
            Math.round(v.x + dxs * (vr + 6)),
            Math.round(v.y + dys * (vr + 6)),
          ]);
          this.viruses.push({
            id: shotId,
            x: v.x + dxs * (vr + 6),
            y: v.y + dys * (vr + 6),
            vx: dxs * VIRUS_SHOT_SPEED,
            vy: dys * VIRUS_SHOT_SPEED,
            mass: VIRUS_MASS,
            fed: 0,
            feedAngle: 0,
            spin: this.rng.range(0, Math.PI * 2),
          });
        }
      }
    }
    if (eaten.size) this.pellets = this.pellets.filter((p) => !eaten.has(p));
  }

  private hitViruses(): void {
    if (!this.viruses.length) return;
    const popped = new Set<Virus>();
    for (const v of this.viruses) {
      const vr = radiusOf(v.mass);
      for (const c of this.allCells) {
        if (popped.has(v)) break;
        if (!this.owns(c.owner)) continue;
        if (c.mass < v.mass * EAT_RATIO) continue;
        const dx = v.x - c.x;
        const dy = v.y - c.y;
        const reach = c.r - vr * 0.5;
        if (reach <= 0 || dx * dx + dy * dy > reach * reach) continue;
        popped.add(v);
        this.pop(c, v);
      }
    }
    if (popped.size) {
      this.viruses = this.viruses.filter((v) => !popped.has(v));
      // The dish keeps its virus count: one bursts here, one grows over there.
      // Unless somebody else is keeping the board — then a virus we invented
      // would be one only we can see.
      if (!this.virusesFromWire) {
        while (this.viruses.length < VIRUS_TARGET) this.addVirus();
      }
    }
  }

  /**
   * A cell walks into a virus and comes apart.
   *
   * At the cell cap there is nowhere for the pieces to go, so you simply
   * swallow it — which is the reward for being at sixteen cells, and the reason
   * a full board is a safe board.
   */
  private pop(c: Cell, v: Virus): void {
    const p = this.players[c.owner];
    const room = MAX_CELLS - p.cells.length;
    this.setMass(c, c.mass + v.mass * 0.5);
    const pieces = Math.min(room, Math.floor(c.mass / MIN_SPLIT_MASS) - 1, 9);
    if (pieces <= 0) {
      // At the cell cap you simply swallow it — but it is still gone, and every
      // other client has to hear about that or they keep rendering a virus that
      // is not there.
      this.events.push({ type: "pop", x: c.x, y: c.y, by: p.id, pieces: 1, virus: v.id });
      return;
    }

    const share = c.mass / (pieces + 1);
    const base = this.rng.range(0, Math.PI * 2);
    for (let i = 0; i < pieces; i++) {
      const angle = base + (i / pieces) * Math.PI * 2;
      // Uneven speeds, so a pop scatters into a ring with depth instead of a
      // perfect flower. Perfect flowers read as a bug.
      const speed = SPLIT_SPEED * (0.55 + 0.55 * ((i % 3) / 2));
      const piece = this.makeCell(p, c.x, c.y, share, angle, speed);
      piece.mergeAt = this.time + mergeDelay(share);
    }
    this.setMass(c, share);
    c.mergeAt = this.time + mergeDelay(share);
    this.events.push({ type: "pop", x: c.x, y: c.y, by: p.id, pieces: pieces + 1, virus: v.id });
  }

  // -------------------------------------------------------------------------
  // Your own cells: merge, or shove
  // -------------------------------------------------------------------------

  private mergeAndSeparate(): void {
    for (const p of this.players) {
      if (p.remote) continue;
      const cells = p.cells;
      if (cells.length < 2) continue;
      const merged = new Set<Cell>();
      for (let i = 0; i < cells.length; i++) {
        const a = cells[i];
        if (merged.has(a)) continue;
        for (let j = i + 1; j < cells.length; j++) {
          const b = cells[j];
          if (merged.has(b)) continue;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d = Math.hypot(dx, dy);
          const touch = a.r + b.r;
          if (d >= touch) continue;
          // Two cells that landed exactly on top of each other have no normal
          // to push along; pick one rather than dividing by zero.
          if (d < 1e-4) {
            dx = 1;
            dy = 0;
            d = 1e-4;
          }

          const ready = this.time >= a.mergeAt && this.time >= b.mergeAt;
          if (ready) {
            const big = a.mass >= b.mass ? a : b;
            const small = big === a ? b : a;
            if (d < big.r - small.r * 0.5) {
              // Absorb, keeping the centre of mass where it was so a merge does
              // not teleport you.
              const total = big.mass + small.mass;
              big.x = (big.x * big.mass + small.x * small.mass) / total;
              big.y = (big.y * big.mass + small.y * small.mass) / total;
              this.setMass(big, total);
              merged.add(small);
            }
            /* Overlapping but not swallowed yet: leave them alone. Shoving here
               is what made merging impossible for a while — the shove holds
               them exactly at touching distance, which is further apart than
               the merge test ever accepts, so two halves steered at the same
               point would orbit each other for the rest of the match. */
            continue;
          }

          /* Not ready: shove them apart so a split reads as several blobs and
             not one lumpy one. Cells still flying from the split that made them
             are left alone, or the shove fights the lunge and they never
             separate at all. */
          if (Math.hypot(a.vx, a.vy) > 40 || Math.hypot(b.vx, b.vy) > 40) continue;
          const overlap = (touch - d) * 0.45;
          const nx = dx / d;
          const ny = dy / d;
          const total = a.mass + b.mass;
          // The lighter cell moves further, which keeps a big cell from being
          // batted around by the crumbs orbiting it.
          const aShare = b.mass / total;
          const bShare = a.mass / total;
          a.x -= nx * overlap * aShare;
          a.y -= ny * overlap * aShare;
          b.x += nx * overlap * bShare;
          b.y += ny * overlap * bShare;
          this.confine(a);
          this.confine(b);
        }
      }
      if (merged.size) p.cells = cells.filter((c) => !merged.has(c));
    }
  }

  // -------------------------------------------------------------------------
  // Upkeep
  // -------------------------------------------------------------------------

  private decay(dt: number): void {
    for (const p of this.players) {
      if (p.remote) continue;
      for (const c of p.cells) {
        if (c.mass <= DECAY_FLOOR) continue;
        const next = Math.max(DECAY_FLOOR, c.mass - c.mass * DECAY_RATE * dt);
        this.setMass(c, next);
      }
    }
  }

  private restock(dt: number): void {
    this.foodDebt += FOOD_REGROW * dt;
    while (this.foodDebt >= 1 && this.food.length < FOOD_TARGET) {
      this.foodDebt -= 1;
      this.addFood();
    }
    if (this.food.length >= FOOD_TARGET) this.foodDebt = 0;
  }

  private respawnBots(): void {
    for (const p of this.players) {
      if (p.alive || !p.isBot || p.remote) continue;
      if (this.time - p.diedAt < BOT_RESPAWN) continue;
      this.spawn(p);
    }
  }

  // -------------------------------------------------------------------------
  // Making things
  // -------------------------------------------------------------------------

  private setMass(c: Cell, mass: number): void {
    c.mass = mass;
    c.r = radiusOf(mass);
  }

  private makeCell(
    p: Player,
    x: number,
    y: number,
    mass: number,
    angle: number,
    speed: number,
  ): Cell {
    const c: Cell = {
      id: this.nextId++,
      owner: p.id,
      x,
      y,
      px: x,
      py: y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      mass,
      r: radiusOf(mass),
      mergeAt: this.time,
      bornAt: this.time,
    };
    p.cells.push(c);
    return c;
  }

  private splitCell(p: Player, c: Cell, angle: number, speed: number): void {
    const half = c.mass / 2;
    this.setMass(c, half);
    const child = this.makeCell(
      p,
      c.x + Math.cos(angle) * c.r * 0.2,
      c.y + Math.sin(angle) * c.r * 0.2,
      half,
      angle,
      speed,
    );
    const delay = mergeDelay(half);
    c.mergeAt = this.time + delay;
    child.mergeAt = this.time + delay;
  }

  /** Direction a cell should be flung: towards the player's aim, or forwards if
   *  the aim is sitting on top of the cell. */
  private aimAngle(p: Player, c: Cell): number {
    const dx = p.aimX - c.x;
    const dy = p.aimY - c.y;
    if (Math.hypot(dx, dy) < 1) return this.rng.range(0, Math.PI * 2);
    return Math.atan2(dy, dx);
  }

  private addFood(): void {
    this.food.push({
      id: this.nextId++,
      x: this.rng.range(12, WORLD - 12),
      y: this.rng.range(12, WORLD - 12),
      mass: FOOD_MASS * this.rng.range(0.85, 1.2),
      hue: this.rng.range(0, 360),
      phase: this.rng.range(0, Math.PI * 2),
    });
  }

  private addVirus(): void {
    const spot = this.safeSpot(radiusOf(VIRUS_MASS) * 3);
    const id = this.nextId++;
    this.spawnedViruses.push([id, Math.round(spot.x), Math.round(spot.y)]);
    this.viruses.push({
      id,
      x: spot.x,
      y: spot.y,
      vx: 0,
      vy: 0,
      mass: VIRUS_MASS,
      fed: 0,
      feedAngle: 0,
      spin: this.rng.range(0, Math.PI * 2),
    });
  }

  /**
   * Viruses created since the last call, for the host to broadcast.
   *
   * Drained rather than read: every spawn must go out exactly once, and a list
   * that is only ever appended to would resend the whole match every packet.
   */
  takeSpawnedViruses(): [number, number, number][] {
    if (!this.spawnedViruses.length) return [];
    const out = this.spawnedViruses;
    this.spawnedViruses = [];
    return out;
  }

  /** Put a player back in the dish somewhere that is not immediately fatal. */
  private spawn(p: Player): void {
    // The human gets the more careful search. A bot that spawns badly loses a
    // life nobody was watching; a player who spawns badly loses the round
    // before they have touched the controls, which is the worst thirty seconds
    // this game can produce.
    const spot = p.isBot ? this.safeSpot(340, 12) : this.safeSpot(620, 28);
    p.cells.length = 0;
    const c = this.makeCell(p, spot.x, spot.y, START_MASS, 0, 0);
    c.vx = 0;
    c.vy = 0;
    p.aimX = c.x;
    p.aimY = c.y;
    p.alive = true;
    p.diedAt = -1;
  }

  /**
   * A point with nothing dangerous near it.
   *
   * Throw `tries` darts, keep the one furthest from the nearest thing that
   * could eat a fresh cell, and stop early once one clears `want`. Not
   * exhaustive and does not need to be — an exact answer
   * costs a search over the whole dish, and the failure mode of the cheap
   * version is "you spawned a bit close to someone", which the genre calls
   * Tuesday.
   */
  private safeSpot(want: number, tries = 12): { x: number; y: number } {
    let bestX = WORLD / 2;
    let bestY = WORLD / 2;
    let bestScore = -1;
    for (let i = 0; i < tries; i++) {
      const x = this.rng.range(WORLD * 0.06, WORLD * 0.94);
      const y = this.rng.range(WORLD * 0.06, WORLD * 0.94);
      let nearest = Infinity;
      for (const p of this.players) {
        for (const c of p.cells) {
          if (c.mass < START_MASS * EAT_RATIO) continue;
          nearest = Math.min(nearest, Math.hypot(c.x - x, c.y - y) - c.r);
        }
      }
      for (const v of this.viruses) {
        nearest = Math.min(nearest, Math.hypot(v.x - x, v.y - y) - radiusOf(v.mass));
      }
      if (nearest > bestScore) {
        bestScore = nearest;
        bestX = x;
        bestY = y;
      }
      if (nearest > want) break;
    }
    return { x: bestX, y: bestY };
  }
}
