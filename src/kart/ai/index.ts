/**
 * Vibe Kart — the CPU field.
 *
 * Seven rivals, each with a name, a temperament and a plan. This module owns
 * none of the simulation: it reads the world through `ctx.services` and writes
 * exactly one thing back, `physics.setControls`, which is the same four numbers
 * the player's controller produces. If this system is deleted the race still
 * runs — everyone else just parks on the grid.
 *
 * WHAT LIVES WHERE
 *   line.ts       bakes the racing line, corridor and speed profile at boot
 *   profiles.ts   the four cc classes and the eight driver temperaments
 *   awareness.ts  hazards, traffic, and the lateral correction they force
 *   tactics.ts    when an item is worth spending, and when the dirt cut is
 *   pilot.ts      one driver: pure pursuit, throttle, and the drift machine
 *
 * BOOT ORDER NOTES
 * The AI boots after physics (so the grid exists) but *before* the race and
 * item systems, so neither may be captured at construction time — both are
 * resolved lazily every tick and both are allowed to be missing forever. A
 * missing item system costs the rivals their items and nothing else.
 *
 * DETERMINISM
 * Every random decision comes from a per-racer stream seeded off the racer id,
 * never from `Math.random` and never from the shared `ctx.rng` — two rivals
 * pulling from one stream would make the whole field depend on the order the
 * pilots happened to be visited in, and the screenshot harness diffs frames.
 */
import * as THREE from "three";
import {
  makeRng,
  TUNING,
  type ItemKind,
  type ItemService,
  type KartCtx,
  type ModelsService,
  type PhysicsService,
  type RaceService,
  type RacerState,
  type System,
  type TrackService,
} from "../types";
import { clamp, wrap01 } from "./math";
import { bakeRacingLine, type RacingLine } from "./line";
import {
  DEFAULT_DIFFICULTY,
  DIFFICULTIES,
  DIFFICULTY_ORDER,
  personalityFor,
  type AiDifficulty,
} from "./profiles";
import type { FieldNode, HazardNode } from "./awareness";
import { makePilot, stepPilot, type Pilot, type PilotWorld } from "./pilot";
import { decideItem, type ItemContext, type RivalRef } from "./tactics";

/** How often the hazard list is re-read and re-projected, seconds. */
const HAZARD_INTERVAL = 1 / 20;

/** Ceiling on hazards considered, so a chaotic final lap cannot spike the tick. */
const MAX_HAZARDS = 40;

export interface AiRacerReport {
  id: number;
  name: string;
  personality: string;
  note: string;
  place: number;
  route: string;
  targetSpeed: number;
  /** Live rubber-band multiplier applied to cornering pace. */
  band: number;
  drifting: boolean;
  item: ItemKind | null;
}

/**
 * The published handle. `update` and `difficulty` are the contract the rest of
 * the game was promised; the rest is additive and every consumer may ignore it.
 * Declared here rather than in types.ts because this module does not get to
 * edit shared law.
 */
export interface KartAiService {
  /** Drive the field one step. Called by the engine; exposed for harnesses. */
  update(dt: number): void;
  /** Current cc class. Assignable — the field changes on the next plan tick. */
  difficulty: AiDifficulty;
  readonly presets: readonly AiDifficulty[];
  /** Turn the whole field off, e.g. for a physics test or a photo mode. */
  enabled: boolean;
  /** Ids currently under AI control. */
  controlled(): number[];
  /** Lateral offset of the baked racing line at a lap position, metres. */
  lineAt(t: number): number;
  /** Planned speed of the racing line at a lap position, m/s. */
  paceAt(t: number): number;
  /** Per-rival state, for the debug overlay and the results screen. */
  report(): AiRacerReport[];
  /** The baked line itself, for anyone who wants to draw it. */
  line: RacingLine | null;
}

/** Physics may publish more than the contract; used only if it is there. */
interface PhysicsExtras {
  playerAi?: boolean;
}

/** The physics racer carries its own arc position; use it rather than reproject. */
interface RacerNav {
  t?: number;
  lateral?: number;
  respawning?: boolean;
}

interface Nav {
  id: number;
  hint: number;
  lastT: number;
  progress: number;
  seeded: boolean;
}

export default function createAi(ctx: KartCtx): System {
  let difficulty: AiDifficulty = DEFAULT_DIFFICULTY;
  let line: RacingLine | null = null;

  const pilots = new Map<number, Pilot>();
  const navs = new Map<number, Nav>();
  const field: FieldNode[] = [];
  const hazards: HazardNode[] = [];
  const order: FieldNode[] = [];
  const itemCooldown = new Map<number, number>();
  const itemThink = new Map<number, number>();
  const itemHeld = new Map<number, number>();
  const lastItem = new Map<number, ItemKind | null>();

  let hazardClock = 0;

  const world: PilotWorld = {
    line: null as unknown as RacingLine,
    lapLength: 1,
    field,
    hazards,
    difficulty: DIFFICULTIES[difficulty],
    racing: false,
    countdown: 0,
    paused: false,
    playerProgress: 0,
  };

  const service: KartAiService = {
    update: (dt) => step(dt),
    get difficulty() {
      return difficulty;
    },
    set difficulty(value: AiDifficulty) {
      if (DIFFICULTIES[value]) difficulty = value;
    },
    presets: DIFFICULTY_ORDER,
    enabled: true,
    controlled: () => Array.from(pilots.keys()),
    lineAt: (t) => (line ? line.offsetAt(wrap01(t) * line.length) : 0),
    paceAt: (t) => (line ? line.speedAt(wrap01(t) * line.length) : TUNING.topSpeed),
    report: () => buildReport(),
    line: null,
  };

  // Published before anything heavy runs: a later system must find a handle
  // here even if baking the line goes wrong.
  ctx.services.ai = service;

  const track = (): TrackService | undefined => ctx.services.track as TrackService | undefined;
  const physics = (): (PhysicsService & PhysicsExtras) | undefined =>
    ctx.services.physics as (PhysicsService & PhysicsExtras) | undefined;
  const items = (): ItemService | undefined => ctx.services.items as ItemService | undefined;
  const race = (): RaceService | undefined => ctx.services.race as RaceService | undefined;
  const models = (): ModelsService | undefined => ctx.services.models as ModelsService | undefined;

  // -------------------------------------------------------------------------
  // Bake the line
  // -------------------------------------------------------------------------
  {
    const t = track();
    if (!t) {
      console.warn("[Vibe Kart] AI booted without a track — the rivals will sit this one out.");
    } else {
      try {
        line = bakeRacingLine(t, ctx.quality);
      } catch (err) {
        console.error("[Vibe Kart] racing line bake failed:", err);
        line = null;
      }
      if (line) {
        service.line = line;
        world.line = line;
        world.lapLength = line.length;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Pilots
  // -------------------------------------------------------------------------

  /**
   * Kart stat multipliers, re-derived from the character preset rather than
   * asked of the physics module, which keeps them private. The mapping mirrors
   * `statsOf`; if it drifts, the AI's feedforward is slightly off and the
   * feedback term absorbs it.
   */
  function statsFor(characterId: string): { handling: number } {
    const preset = models()?.roster?.find((r) => r.id === characterId);
    const s = preset?.stats;
    const handling = Number.isFinite(s?.handling) ? clamp(s?.handling as number, 1, 10) : 5;
    return { handling: 0.86 + handling * 0.032 };
  }

  function ensurePilot(racer: RacerState): Pilot {
    let pilot = pilots.get(racer.id);
    if (!pilot) {
      const profile = personalityFor(racer.characterId, racer.id);
      pilot = makePilot(
        racer.id,
        racer.name || profile.name,
        profile,
        // A stream per racer, salted with the id: reproducible across reloads,
        // and independent of how many times anybody else rolled a die.
        makeRng(0x5a17_0000 ^ ((racer.id + 1) * 2654435761)),
        statsFor(racer.characterId),
      );
      pilots.set(racer.id, pilot);
    }
    return pilot;
  }

  function ensureNav(id: number): Nav {
    let nav = navs.get(id);
    if (!nav) {
      nav = { id, hint: 0, lastT: 0, progress: 0, seeded: false };
      navs.set(id, nav);
    }
    return nav;
  }

  // -------------------------------------------------------------------------
  // Perception
  // -------------------------------------------------------------------------
  const scratchProject = new THREE.Vector3();

  /**
   * A pooled node per racer. The field is rebuilt every fixed step, and eight
   * fresh objects 120 times a second is eight hundred allocations a second for
   * no reason at all.
   */
  function nodeFor(i: number, id: number): FieldNode {
    let node = field[i];
    if (!node) {
      node = {
        id,
        s: 0,
        lateral: 0,
        progress: 0,
        speed: 0,
        stunned: false,
        invincible: false,
        finished: false,
        respawning: false,
        position: scratchProject,
        place: i + 1,
      };
      field[i] = node;
    }
    node.id = id;
    return node;
  }

  /** Arc position and monotonic progress for every racer on the grid. */
  function syncField(racers: readonly RacerState[], lapLength: number): void {
    const t = track();
    if (field.length > racers.length) field.length = racers.length;
    for (let i = 0; i < racers.length; i++) {
      const racer = racers[i];
      const nav = ensureNav(racer.id);
      const ext = racer as RacerState & RacerNav;

      let tt: number;
      let lateral: number;
      if (typeof ext.t === "number" && Number.isFinite(ext.t)) {
        // The physics already projected this kart four times this step; there
        // is no reason at all to do it a fifth.
        tt = wrap01(ext.t);
        lateral = Number.isFinite(ext.lateral) ? (ext.lateral as number) : 0;
      } else if (t) {
        const pr = t.project(racer.position, nav.hint);
        tt = wrap01(pr.t);
        lateral = pr.lateral;
      } else {
        tt = nav.lastT;
        lateral = 0;
      }
      nav.hint = tt;

      if (!nav.seeded) {
        nav.progress = tt;
        nav.lastT = tt;
        nav.seeded = true;
      } else {
        // Unwrap across the start/finish line so "who is ahead" is a single
        // subtraction all race long, with no lap bookkeeping to get wrong.
        let d = tt - nav.lastT;
        if (d > 0.5) d -= 1;
        else if (d < -0.5) d += 1;
        nav.progress += d;
        nav.lastT = tt;
      }

      const node = nodeFor(i, racer.id);
      node.s = tt * lapLength;
      node.lateral = lateral;
      node.progress = nav.progress;
      node.speed = Math.abs(racer.speed);
      node.stunned = racer.stun > 0;
      node.invincible = racer.star > 0;
      node.finished = racer.finished;
      node.respawning = !!ext.respawning;
      node.position = racer.position;
      node.place = 1;
    }

    // Places, from progress alone. The race system will have its own, arrived
    // at with checkpoints and lap validation; this one only has to be right
    // enough to decide who to shoot at.
    order.length = 0;
    for (let i = 0; i < field.length; i++) order.push(field[i]);
    order.sort((a, b) => b.progress - a.progress);
    for (let i = 0; i < order.length; i++) order[i].place = i + 1;
  }

  function syncHazards(dt: number, lapLength: number): void {
    hazardClock -= dt;
    if (hazardClock > 0) return;
    hazardClock = HAZARD_INTERVAL;
    hazards.length = 0;
    const svc = items();
    const t = track();
    if (!svc || !t || typeof svc.hazards !== "function") return;
    let list: ReturnType<ItemService["hazards"]>;
    try {
      list = svc.hazards();
    } catch {
      return;
    }
    if (!list) return;
    const n = Math.min(list.length, MAX_HAZARDS);
    for (let i = 0; i < n; i++) {
      const h = list[i];
      if (!h || !h.position) continue;
      scratchProject.copy(h.position);
      const pr = t.project(scratchProject);
      hazards.push({
        kind: h.kind,
        ownerId: h.ownerId,
        s: wrap01(pr.t) * lapLength,
        lateral: pr.lateral,
        position: h.position,
        static: h.kind === "banana" || h.kind === "bobomb" || h.kind === "fireflower",
      });
    }
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------
  function nearestRivals(me: FieldNode, lapLength: number): { ahead: RivalRef | null; behind: RivalRef | null; pack: number } {
    let ahead: RivalRef | null = null;
    let behind: RivalRef | null = null;
    let aheadDist = Infinity;
    let behindDist = -Infinity;
    let pack = 0;
    for (let i = 0; i < field.length; i++) {
      const r = field[i];
      if (r.id === me.id || r.finished) continue;
      let d = (r.s - me.s) % lapLength;
      if (d > lapLength * 0.5) d -= lapLength;
      else if (d < -lapLength * 0.5) d += lapLength;
      if (d > 0) {
        if (d < 90) pack++;
        if (d < aheadDist) {
          aheadDist = d;
          ahead = { dist: d, offset: r.lateral - me.lateral, speed: r.speed, invincible: r.invincible };
        }
      } else if (d < 0 && d > behindDist) {
        behindDist = d;
        behind = { dist: d, offset: r.lateral - me.lateral, speed: r.speed, invincible: r.invincible };
      }
    }
    return { ahead, behind, pack };
  }

  function updateItems(pilot: Pilot, racer: RacerState, node: FieldNode, dt: number, lapLength: number): void {
    const held = (itemHeld.get(racer.id) ?? 0) + dt;
    const cooldown = Math.max(0, (itemCooldown.get(racer.id) ?? 0) - dt);
    itemCooldown.set(racer.id, cooldown);

    const previous = lastItem.get(racer.id) ?? null;
    if (racer.item !== previous) {
      lastItem.set(racer.id, racer.item ?? null);
      itemHeld.set(racer.id, 0);
      return;
    }
    itemHeld.set(racer.id, held);

    const svc = items();
    if (!svc || typeof svc.use !== "function") return;
    if (!racer.item || racer.rolling || cooldown > 0 || racer.finished) return;

    // Reconsidering a hand-grenade eight hundred times a second is not thought,
    // it is a busy loop. Ten times a second is well inside human reaction.
    const think = (itemThink.get(racer.id) ?? 0) - dt;
    if (think > 0) {
      itemThink.set(racer.id, think);
      return;
    }
    itemThink.set(racer.id, 0.1);

    const diff = DIFFICULTIES[difficulty];
    const near = nearestRivals(node, lapLength);
    const sc = line?.shortcut;
    let shortcutIn = Infinity;
    if (sc && line) {
      let d = (sc.entryT * lapLength - node.s) % lapLength;
      if (d < 0) d += lapLength;
      shortcutIn = d;
    }

    const context: ItemContext = {
      item: racer.item,
      itemCount: Math.max(1, racer.itemCount),
      held,
      place: node.place,
      fieldSize: Math.max(1, field.length),
      speed: node.speed,
      topSpeed: TUNING.topSpeed,
      boosting: racer.boost > 0,
      starTime: racer.star,
      stunned: racer.stun > 0,
      offRoad: racer.grounded && (racer.surface === "grass" || racer.surface === "dirt" || racer.surface === "sand"),
      runway: pilot.runway,
      onShortcut: pilot.onShortcut,
      shortcutIn,
      finalLap: isFinalLap(racer, node),
      ahead: near.ahead,
      behind: near.behind,
      packAhead: near.pack,
      profile: pilot.profile,
      skill: diff.itemSkill,
      random: pilot.rng(),
    };

    const decision = decideItem(context);
    if (!decision.use) return;
    try {
      svc.use(racer.id, decision.aimBack);
    } catch {
      // A broken item system must not stop the rivals driving.
      itemCooldown.set(racer.id, 2);
      return;
    }
    // Long enough that a triple fires as three shots rather than one frame of
    // machine-gun, short enough that the second one still lands in traffic.
    itemCooldown.set(racer.id, 0.55 + (1 - diff.itemSkill) * 0.6);
    itemHeld.set(racer.id, 0);
  }

  function isFinalLap(racer: RacerState, node: FieldNode): boolean {
    const r = race();
    const laps = r?.totalLaps ?? track()?.laps ?? 3;
    const lap = racer.lap > 0 ? racer.lap : Math.floor(node.progress);
    return lap >= laps - 1;
  }

  // -------------------------------------------------------------------------
  // The step
  // -------------------------------------------------------------------------
  function step(dt: number): void {
    if (!service.enabled || !line) return;
    const phys = physics();
    if (!phys || !phys.racers || phys.racers.length === 0) return;

    const racers = phys.racers;
    const lapLength = line.length;
    syncField(racers, lapLength);
    syncHazards(dt, lapLength);

    const r = race();
    const phase = r?.phase;
    world.line = line;
    world.lapLength = lapLength;
    world.difficulty = DIFFICULTIES[difficulty];
    world.paused = !!phys.paused;
    // Without a race system there is nobody to drop the flag, so the field
    // races whenever the physics is not frozen.
    world.racing = phase ? phase === "racing" || phase === "finished" || phase === "results" : !phys.paused;
    world.countdown = phase === "countdown" ? (r?.countdown ?? 0) : 0;

    const playerId = phys.player?.id;
    const driveThePlayer = !!phys.playerAi;

    // The player's progress is the yardstick every rubber band is measured
    // against — and the player is never on the other end of one.
    world.playerProgress = 0;
    for (let i = 0; i < field.length; i++) {
      if (field[i].id === playerId) {
        world.playerProgress = field[i].progress;
        break;
      }
    }

    for (let i = 0; i < racers.length; i++) {
      const racer = racers[i];
      // The player is never driven, never rubber-banded, and never has an item
      // spent for them — unless attract mode has explicitly asked for it.
      if (racer.isPlayer && !driveThePlayer) continue;
      const node = field[i];
      if (!node) continue;

      const pilot = ensurePilot(racer);
      pilot.s = node.s;
      pilot.lateral = node.lateral;
      pilot.progress = node.progress;
      pilot.place = node.place;

      const controls = stepPilot(pilot, racer, world, dt);
      phys.setControls(racer.id, controls);

      updateItems(pilot, racer, node, dt, lapLength);
    }
  }

  function buildReport(): AiRacerReport[] {
    const phys = physics();
    const list: AiRacerReport[] = [];
    for (const pilot of pilots.values()) {
      const racer = phys?.racers.find((r) => r.id === pilot.id);
      list.push({
        id: pilot.id,
        name: pilot.name,
        personality: pilot.profile.name,
        note: pilot.profile.note,
        place: pilot.place,
        route: pilot.route,
        targetSpeed: pilot.targetSpeed,
        band: pilot.band,
        drifting: !!racer?.drifting,
        item: racer?.item ?? null,
      });
    }
    list.sort((a, b) => a.place - b.place);
    return list;
  }

  // -------------------------------------------------------------------------
  // A restart re-uses racer identities; the plans that went with them are stale
  // -------------------------------------------------------------------------
  const offRestart = ctx.on("race:countdown", ((payload: { count?: number }) => {
    if (payload && payload.count !== 3) return;
    for (const nav of navs.values()) nav.seeded = false;
    pilots.clear();
    itemHeld.clear();
    itemCooldown.clear();
    itemThink.clear();
    lastItem.clear();
  }) as (p: never) => void);

  return {
    fixedUpdate(dt) {
      step(dt);
    },

    dispose() {
      offRestart();
      pilots.clear();
      navs.clear();
      itemHeld.clear();
      itemCooldown.clear();
      itemThink.clear();
      lastItem.clear();
      field.length = 0;
      hazards.length = 0;
      order.length = 0;
      line = null;
      service.line = null;
      // Nothing in this module touches the GPU: no geometry, no material, no
      // texture, no render target. The only thing to give back is the handle.
      if (ctx.services.ai === service) delete ctx.services.ai;
    },
  };
}

export type { AiDifficulty } from "./profiles";
export type { RacingLine } from "./line";
