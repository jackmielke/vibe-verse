/**
 * DROP ZERO — combat routing.
 *
 * Publishes `CombatService`. This module draws nothing and simulates nothing;
 * it is the switchboard every damage event in the game passes through, and it
 * is the only place that knows the *rules* of a hit. Weapons decide what they
 * fired and how far it travelled. Bots decide who they aimed at. The storm
 * decides who is outside it. None of them decide what a headshot is worth,
 * whether shield or health takes the round, who gets credit for the
 * elimination, or what appears on screen when it lands. That all lives here,
 * once, so those five systems can be authored independently and still agree.
 *
 * ── WHY A SWITCHBOARD AT ALL ──────────────────────────────────────────────
 * The alternative — every weapon subtracting HP itself — is how you end up
 * with a shotgun that ignores shields, a sniper whose headshot multiplier
 * drifted from the AR's, and a grenade that kills a bot without the kill feed
 * ever hearing about it. Every one of those is a bug you only find in a demo,
 * in front of someone. Centralising the *policy* while leaving the *pools*
 * with their owners is the compromise that keeps both properties:
 *
 *   - Combat computes the split, the multiplier, the feedback and the death.
 *   - The target's own module stays the authority on its health, because it
 *     has state combat cannot see (the player's down-but-not-out timer, a
 *     bot's threat memory, a hit-reaction pose).
 *
 * So `applyHit` writes the new pools *before* calling `onDamage`, and lets the
 * owner overwrite them afterwards. `player.ts` and `bots.ts` both re-sync
 * their `DamageTarget` at the end of `onDamage` precisely so this works; a
 * target that does neither still takes the damage, because we already wrote
 * it. There is no double-application in either direction and no heuristic
 * guessing at who is in charge.
 *
 * ── SHIELD BEFORE HEALTH ──────────────────────────────────────────────────
 * Fortnite's single most legible combat rule: blue absorbs first, and a shot
 * that spans the boundary shows up as *two* numbers, blue then white. Players
 * read the colour before they read the digits — it is how you know whether
 * the next shot finishes them. We spawn the split, not the total.
 *
 * ── COALESCED DAMAGE NUMBERS ──────────────────────────────────────────────
 * A pump shotgun fires nine pellets in one frame. Nine separate `11`s
 * fountaining off a rival is unreadable mush and is the loudest "this is a
 * hobby project" tell in the whole feedback loop. Real BRs coalesce: damage
 * from one shooter to one victim inside a short window (see `NUMBER_WINDOW`)
 * accumulates into a single number, which is why you see `97` and know
 * instantly that the shot connected clean. The cost is up to 70 ms of latency
 * on the number, which is below the threshold where it stops feeling
 * simultaneous with the impact flash — and the impact flash, tracer and
 * hitmarker are all still instant.
 *
 * ── KILL CREDIT ───────────────────────────────────────────────────────────
 * The last player to damage a target inside `CREDIT_MEMORY` owns the
 * elimination even if the storm or a fall lands the final tick, and whoever
 * dealt the second-most damage in that window gets an assist. Without this,
 * finishing a rival who then steps into the wall robs you of the kill and the
 * feed lies about what happened.
 *
 * ── SERVICES CONSUMED (all lazily, all null-checked, all wrapped) ─────────
 * `vfx` (damage numbers, explosion, smoke, ground scorch), `audio` (impact
 * and blast cues), `build` (`damagePiece` / `queryPieces` — structures are
 * damaged through their owner, never by writing `hp`), `match`
 * (`reportDeath`), `terrain` (ground height + normal for blast scorch, sea
 * level), `collision` (line-of-sight for explosions), `player` (blast
 * knockback). Every one of them may be missing or may throw; combat degrades
 * to "the damage still lands" in every case.
 *
 * ── EVENTS ────────────────────────────────────────────────────────────────
 *   emits "dz:hitmarker"  { kind: "hit"|"shield"|"elim", amount, headshot }
 *                         — only for damage the LOCAL player dealt.
 *   emits "dz:damage"     { id, amount, health, shield, headshot, elim, hp }
 *                         — every routed hit, for the HUD and telemetry.
 *   emits "dz:eliminate"  only when `match` could not accept the death, so
 *                         the kill feed never doubles. See `fileDeath`.
 *   emits "dz:assist"     { by, victim, damage }
 *   emits "dz:shake"      { amount, point, range } — blast trauma; `vfx` owns
 *                         the actual camera displacement.
 *
 * NO EXTERNAL ASSETS, no geometry, no textures, no listeners on window. The
 * only teardown this module needs is releasing its target registry, but it
 * does it anyway — a retained `DamageTarget` retains an `Object3D`, which
 * retains a rig, which retains the geometry the next world needs the memory
 * for.
 *
 * Convention: +X east, +Z south, +Y up. 1 unit = 1 metre.
 */
import * as THREE from "three";
import type {
  BuildPiece,
  CombatService,
  DamageSource,
  DamageTarget,
  QualityTier,
  RayHit,
  System,
  SystemFactory,
  WorldCtx,
} from "../types";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Headshot multipliers, keyed by `DamageSource.weapon`.
 *
 * `CombatService.applyHit` has no per-weapon multiplier parameter, and combat
 * cannot import `weapons.ts` (systems never import each other), so the table
 * is mirrored here from the weapon definitions. These values are deliberately
 * identical to the `headshot` field on each `WeaponDef` — if a weapon is
 * retuned there and not here the shooter and the switchboard disagree, and the
 * damage number will not match what the weapon's own fallback path would have
 * produced. Keep them in step.
 *
 * The spread is the point: a sniper rewards the head far more than a minigun
 * does, which is what makes weapon choice a real decision rather than a DPS
 * lookup.
 */
const HEADSHOT_MULT: Record<string, number> = {
  ar: 1.75,
  smg: 1.5,
  pump: 1.5,
  tac: 1.5,
  sniper: 2.5,
  burst: 1.75,
  rocket: 1,
  pistol: 2,
  minigun: 1.25,
  pickaxe: 1.5,
};

/** Anything not in the table — thrown weapons, bot rifles, debug damage. */
const HEADSHOT_MULT_DEFAULT = 1.75;

/**
 * Vertical slack on the head line, in metres.
 *
 * A hit exactly at `headY` is a headshot; so is one 16 cm below it, because
 * the head capsule sits *around* the eye height rather than above it and
 * because hit points arrive from a broadphase box test that is coarser than
 * the visible skull. `weapons.ts` uses the same slack on its own fallback
 * path — they must agree or the same shot scores differently depending on
 * whether combat happened to boot.
 */
const HEAD_SLACK = 0.16;

/**
 * How long damage from one shooter accumulates into a single number.
 *
 * 70 ms covers a full shotgun pellet spread and a two-round burst without
 * ever merging two deliberate trigger pulls: the fastest weapon in the game
 * cycles in ~85 ms. Any longer and a sustained AR beam would show one number
 * per five rounds, which reads as lag.
 */
const NUMBER_WINDOW = 0.07;

/**
 * A shooter keeps kill credit on a target for this long after their last hit.
 *
 * Long enough that finishing someone who then walks into the storm still
 * counts, short enough that a plink from four circles ago does not steal a
 * kill from the person who actually did the work.
 */
const CREDIT_MEMORY = 8;

/** Damage below this in the credit window does not earn an assist. */
const ASSIST_MIN_DAMAGE = 20;

/**
 * How long a target may sit at zero health while still claiming to be alive
 * before combat files the elimination on its behalf.
 *
 * The number is chosen to be comfortably longer than the player's bleed-out
 * timer — the one legitimate case — so this only ever fires for a target
 * whose module has no death handling at all. It is a backstop against a
 * corpse that would otherwise hold the alive count above zero forever and
 * hang the match on its victory check.
 */
const BLEEDOUT_GRACE = 16;

/**
 * How long a dead target may sit in the registry before it is reaped.
 *
 * Owners are expected to call their unregister function — `bots.ts` does it
 * inside `killBot`. This is the backstop for the one that forgets, and it is
 * generous on purpose: a corpse still needs to be queryable while the death
 * animation plays and while the kill feed is deciding what to say about it.
 */
const DEAD_REAP_TIME = 12;

/** Targets examined per frame by the reaper. The registry is ~50 entries. */
const REAP_PER_FRAME = 6;

/**
 * Explosion falloff exponent.
 *
 * Below 1 the blast is nearly uniform and there is no reason to move; above 2
 * the edge is worthless and grenades feel like they whiffed. 1.35 gives a fat
 * lethal core with a meaningful, survivable rim — the shape that makes
 * players actually run out of the circle instead of tanking it.
 */
const BLAST_FALLOFF = 1.35;

/** Nobody inside the radius takes less than this fraction. A hit is a hit. */
const BLAST_MIN_FRACTION = 0.15;

/**
 * A wall between you and the blast eats this fraction of the damage.
 *
 * Not all of it: a grenade at the foot of your ramp should still hurt, or
 * building becomes an invulnerability button. Terrain is a harder occluder
 * than a wooden wall because a hill genuinely is.
 */
const BLAST_BUILT_OCCLUSION = 0.55;
const BLAST_WORLD_OCCLUSION = 0.8;

/** Structures take this much more from a blast than flesh does. */
const BLAST_STRUCTURE_MULT = 1.6;

/** Self-damage fraction when you catch your own rocket. */
const SELF_DAMAGE = 0.35;

/** Peak knockback speed at the centre of a blast, m/s. */
const BLAST_KNOCK = 7.5;

/** Camera trauma at the centre of a blast, and the range it falls off over. */
const BLAST_SHAKE = 0.55;

/** Ground scorch impacts spawned around a blast, per quality tier. */
const SCORCH_COUNT: Record<QualityTier, number> = {
  low: 0,
  medium: 2,
  high: 4,
  ultra: 6,
};

/** How many nested `queryTargets` results can be live at once. */
const QUERY_POOL = 4;

/**
 * Radius, in metres, of the sphere `applyHit` searches when a hit arrives
 * with no resolved target. Generous, because the fallback only runs for
 * callers that did not do their own capsule test — a thrown weapon landing at
 * someone's feet, mostly.
 */
const POINT_RESOLVE_RADIUS = 3.5;

// ---------------------------------------------------------------------------
// Scratch — the hot path allocates nothing
// ---------------------------------------------------------------------------

const _base = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _boxCenter = new THREE.Vector3();

/**
 * Reusable `RayHit` for damage that did not come from a ray (explosions,
 * scripted damage). Never handed outside this module.
 */
const _synthHit: RayHit = {
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(0, 1, 0),
  distance: 0,
  material: "flesh",
};

/** Reusable event payloads. Emitting allocates once at boot, then never. */
const _hitmarkerEvent = { kind: "hit" as "hit" | "shield" | "elim", amount: 0, headshot: false };
const _damageEvent = {
  id: "",
  by: "",
  amount: 0,
  health: 0,
  shield: 0,
  headshot: false,
  elim: false,
  hp: 0,
  shieldLeft: 0,
  x: 0,
  y: 0,
  z: 0,
};
const _shakeEvent = { amount: 0, point: new THREE.Vector3(), range: 1 };
const _assistEvent = { by: "", name: "", victim: "", damage: 0 };

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * One registered actor plus everything combat remembers *about* it that the
 * actor itself has no business knowing: pending damage numbers, who has a
 * claim on the kill, how much it has taken.
 *
 * Every field is preallocated. A slot is recycled through a free list rather
 * than being reallocated, because bots register and unregister across a match
 * and a fresh object per registration would drip garbage into the middle of a
 * firefight.
 */
interface Slot {
  target: DamageTarget;
  /**
   * True when the object was inside a scene graph at registration time. Bot
   * hit-capsules are deliberately parentless (`bots.ts` drives their
   * `matrixWorld` by hand so hit registration does not depend on whether the
   * rival currently has a visible rig), so "detached" only means "removed"
   * for targets that started out attached.
   */
  wasParented: boolean;
  /** Seconds since `alive` went false. Drives the reap backstop. */
  deadFor: number;
  /**
   * Seconds the target has sat at zero health while still claiming to be
   * alive. `player.ts` legitimately does this while bleeding out; a target
   * whose module has no death handling at all does it forever, and this is
   * what eventually files that elimination anyway. See `BLEEDOUT_GRACE`.
   */
  downFor: number;
  /** True once we have filed this death, so it can never be filed twice. */
  filed: boolean;

  // --- coalescing accumulator ---
  pendHealth: number;
  pendShield: number;
  pendHead: boolean;
  pendTimer: number;
  pendBy: string;
  readonly pendPoint: THREE.Vector3;

  // --- kill credit ---
  lastBy: string;
  lastName: string;
  lastWeapon: string;
  lastAt: number;
  /** Damage dealt by `lastBy` inside the credit window. */
  lastDamage: number;
  assistBy: string;
  assistName: string;
  assistDamage: number;
  assistAt: number;

  /** Lifetime damage taken. Read by the end-of-match card. */
  taken: number;
}

function makeSlot(): Slot {
  return {
    target: null as unknown as DamageTarget,
    wasParented: false,
    deadFor: 0,
    downFor: 0,
    filed: false,
    pendHealth: 0,
    pendShield: 0,
    pendHead: false,
    pendTimer: 0,
    pendBy: "",
    pendPoint: new THREE.Vector3(),
    lastBy: "",
    lastName: "",
    lastWeapon: "",
    lastAt: -1e9,
    lastDamage: 0,
    assistBy: "",
    assistName: "",
    assistDamage: 0,
    assistAt: -1e9,
    taken: 0,
  };
}

function resetSlot(s: Slot, t: DamageTarget, elapsed: number): void {
  s.target = t;
  s.wasParented = t.object.parent !== null;
  s.deadFor = 0;
  s.downFor = 0;
  s.filed = false;
  s.pendHealth = 0;
  s.pendShield = 0;
  s.pendHead = false;
  s.pendTimer = 0;
  s.pendBy = "";
  s.pendPoint.set(0, 0, 0);
  s.lastBy = "";
  s.lastName = "";
  s.lastWeapon = "";
  s.lastAt = elapsed - 1e6;
  s.lastDamage = 0;
  s.assistBy = "";
  s.assistName = "";
  s.assistDamage = 0;
  s.assistAt = elapsed - 1e6;
  s.taken = 0;
}

/**
 * Extra surface on top of `CombatService`, for systems that want the
 * bookkeeping combat already keeps rather than duplicating it. Published as
 * the same object, so `ctx.services.combat` stays exactly the contract in
 * `types.ts` and anything reaching for the extras has to ask for them by
 * casting — which is the honest signal that they are not part of the contract.
 */
export interface CombatServiceEx extends CombatService {
  /** Total damage dealt by a source id this match. */
  damageDealt(by: string): number;
  /** Total damage a registered target has taken. */
  damageTaken(id: string): number;
  /** Live registered target count, alive or not. */
  readonly targetCount: number;
  /** Damage a built piece through its owner, with all the feedback. */
  damageStructure(piece: BuildPiece, amount: number, source: DamageSource): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const createCombat: SystemFactory = (ctx: WorldCtx): System => {
  // -------------------------------------------------------------------------
  // Registry state. Declared before the service so the closures below can see
  // it, but nothing expensive happens until well after the service is live.
  // -------------------------------------------------------------------------

  /** Dense array of live slots. Order is not stable — removal swap-pops. */
  const slots: Slot[] = [];
  /** Recycled slot objects, so registration never allocates after warm-up. */
  const freeSlots: Slot[] = [];
  /** Identity index, for the double-registration guard and O(1) removal. */
  const byTarget = new Map<DamageTarget, number>();
  /** Id index. Ids are unique per actor and the kill feed keys off them. */
  const byId = new Map<string, Slot>();
  /** Running damage tally per source id, for the end-of-match card. */
  const dealt = new Map<string, number>();

  /**
   * Round-robin scratch arrays for `queryTargets`.
   *
   * Callers (`storm`, `match`, `water`, `weapons`) all iterate the result
   * immediately and never retain it, and two of them sweep the entire island
   * on a timer — returning a fresh array from those would be a 50-element
   * allocation several times a second for no reason. Four buffers means four
   * nested queries can be live at once, which is three more than anything in
   * the codebase actually does.
   */
  const queryPool: DamageTarget[][] = [];
  for (let i = 0; i < QUERY_POOL; i++) queryPool.push([]);
  let queryCursor = 0;

  /** Amortised reaper cursor. */
  let reapCursor = 0;

  /**
   * Snapshot buffer for the blast loop, and the scratch `DamageSource` used
   * when an environmental kill is re-credited to whoever broke the victim.
   * Both preallocated: an explosion in the endgame is exactly when the frame
   * budget is tightest.
   */
  const blastTargets: DamageTarget[] = [];
  const _credit: DamageSource = { by: "", name: undefined, weapon: undefined };

  let disposed = false;

  // -------------------------------------------------------------------------
  // Service, published FIRST — before any other work — so that every system
  // booting after us finds it during its own factory even if something below
  // throws. Boot order is a guarantee about ordering, not about success.
  // -------------------------------------------------------------------------

  const service: CombatServiceEx = {
    registerTarget(t: DamageTarget): () => void {
      return registerTarget(t);
    },
    queryTargets(point: THREE.Vector3, radius: number): DamageTarget[] {
      return queryTargets(point, radius);
    },
    applyHit(hit: RayHit, amount: number, source: DamageSource): void {
      applyHit(hit, amount, source);
    },
    explode(point: THREE.Vector3, radius: number, damage: number, source: DamageSource): void {
      explode(point, radius, damage, source);
    },
    damageStructure(piece: BuildPiece, amount: number, source: DamageSource): void {
      damageStructure(piece, amount, source, null);
    },
    damageDealt(by: string): number {
      return dealt.get(by) ?? 0;
    },
    damageTaken(id: string): number {
      return byId.get(id)?.taken ?? 0;
    },
    get targetCount(): number {
      return slots.length;
    },
  };
  ctx.services.combat = service;

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  function registerTarget(t: DamageTarget): () => void {
    if (disposed || !t || !t.object) return noop;

    // Guard 1: the same object registering twice. Returns a remover for the
    // existing slot rather than a no-op, so a caller that legitimately
    // re-registers after a respawn still gets a working handle.
    const existing = byTarget.get(t);
    if (existing !== undefined) return () => unregister(t);

    // Guard 2: a *different* object claiming an id we already know. This is
    // always a stale registration (a bot recycled without unregistering), and
    // leaving both in would double the alive count and let the kill feed file
    // the same rival twice. The newcomer wins.
    const clash = byId.get(t.id);
    if (clash && clash.target !== t) unregister(clash.target);

    const slot = freeSlots.pop() ?? makeSlot();
    resetSlot(slot, t, ctx.elapsed);
    byTarget.set(t, slots.length);
    byId.set(t.id, slot);
    slots.push(slot);
    return () => unregister(t);
  }

  function unregister(t: DamageTarget): void {
    const index = byTarget.get(t);
    if (index === undefined) return;
    const slot = slots[index];

    // Anything still accumulating must land before the slot is recycled, or a
    // rival killed mid-shotgun-spread swallows the number that explains why.
    flushNumbers(slot);

    byTarget.delete(t);
    if (byId.get(t.id) === slot) byId.delete(t.id);

    // Swap-pop: order in `slots` is meaningless, and this keeps unregistering
    // a bot O(1) in the middle of a firefight.
    const last = slots.pop();
    if (last && last !== slot) {
      slots[index] = last;
      byTarget.set(last.target, index);
    }
    slot.target = null as unknown as DamageTarget;
    freeSlots.push(slot);
  }

  function noop(): void {
    /* registration refused — nothing to undo */
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * World position of a target's capsule base.
   *
   * `getWorldPosition` rather than reading `matrixWorld` directly, because
   * combat runs inside `fixed()` — before the renderer refreshes the graph —
   * and a target parented to a rig would otherwise be queried a frame stale.
   * For the parentless bot capsules this costs nothing beyond a matrix copy.
   */
  function basePosition(t: DamageTarget, out: THREE.Vector3): THREE.Vector3 {
    t.object.getWorldPosition(out);
    return out;
  }

  function queryTargets(point: THREE.Vector3, radius: number): DamageTarget[] {
    const out = queryPool[queryCursor];
    queryCursor = (queryCursor + 1) % QUERY_POOL;
    out.length = 0;
    if (!(radius > 0)) return out;

    for (let i = 0; i < slots.length; i++) {
      const t = slots[i].target;
      if (!t) continue;
      basePosition(t, _base);

      // Early rejection against the capsule's bounding sphere rather than its
      // base point: a sniper's blast at head height must still find a target
      // whose origin is at their feet two metres below.
      const half = t.height * 0.5;
      const dx = _base.x - point.x;
      const dz = _base.z - point.z;
      const dy = _base.y + half - point.y;
      const reach = radius + Math.max(t.radius, half);
      if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
      out.push(t);
    }
    return out;
  }

  /**
   * Squared distance from a point to a target's capsule, and the closest
   * point on it. Used for blast falloff and for resolving a hit that arrived
   * without a target attached.
   */
  function capsuleDistanceSq(t: DamageTarget, point: THREE.Vector3, out: THREE.Vector3): number {
    basePosition(t, _base);
    // Capsule axis runs from the base up to `height`; the sphere centres sit
    // one radius in from each cap so a shot at the very top of the head still
    // resolves to the head and not past it.
    const r = t.radius;
    const lo = Math.min(r, t.height * 0.5);
    const hi = Math.max(t.height - r, lo);
    _axis.set(_base.x, _base.y + lo, _base.z);
    const span = hi - lo;
    const rel = span > 1e-5 ? (point.y - _axis.y) / span : 0;
    const clamped = rel < 0 ? 0 : rel > 1 ? 1 : rel;
    out.set(_axis.x, _axis.y + clamped * span, _axis.z);
    const dx = point.x - out.x;
    const dy = point.y - out.y;
    const dz = point.z - out.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // Push the returned point onto the capsule surface, so callers get
    // somewhere to spawn a number that is on the body rather than inside it.
    if (d > 1e-4) {
      const k = Math.min(d, r) / d;
      out.x += dx * k;
      out.y += dy * k;
      out.z += dz * k;
    }
    const surface = Math.max(0, d - r);
    return surface * surface;
  }

  /**
   * Best target for a hit point that arrived without one.
   *
   * Flat scan with an early bounding-sphere reject — the registry is ~50
   * entries and a spatial hash for that would cost more to maintain than it
   * saves. `hit.target` is set by the collision broadphase for anything shot
   * through it, so this path only runs for damage that never went near a ray.
   */
  function resolveByPoint(point: THREE.Vector3): DamageTarget | null {
    let best: DamageTarget | null = null;
    let bestSq = POINT_RESOLVE_RADIUS * POINT_RESOLVE_RADIUS;
    for (let i = 0; i < slots.length; i++) {
      const t = slots[i].target;
      if (!t || !t.alive) continue;
      const dSq = capsuleDistanceSq(t, point, _closest);
      if (dSq < bestSq) {
        bestSq = dSq;
        best = t;
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // The damage pipeline
  // -------------------------------------------------------------------------

  function headshotMultiplier(source: DamageSource): number {
    const w = source.weapon;
    if (!w) return HEADSHOT_MULT_DEFAULT;
    const m = HEADSHOT_MULT[w];
    return m === undefined ? HEADSHOT_MULT_DEFAULT : m;
  }

  function applyHit(hit: RayHit, amount: number, source: DamageSource): void {
    if (disposed || !hit || !(amount > 0) || !Number.isFinite(amount)) return;

    // A built piece is not an actor: it has no shield, no head, and its own
    // module owns its destruction chain (a wall that dies takes the ramp above
    // it with it). Route and leave.
    if (hit.piece) {
      damageStructure(hit.piece, amount, source, hit.point);
      return;
    }

    const target = hit.target ?? resolveByPoint(hit.point);
    if (!target) return;

    // Geometric headshot: the hit's height above the capsule base against the
    // target's own head line. `weapons.ts` computes the same test for its
    // fallback path — see HEAD_SLACK.
    basePosition(target, _base);
    const headshot = hit.point.y - _base.y >= target.headY - HEAD_SLACK;

    _normal.copy(hit.normal);
    if (_normal.lengthSq() < 1e-6) _normal.copy(_up);
    // `tag === "actor"` is the marker `weapons.ts` and `bots.ts` both stamp on
    // a hit they have already decorated — they spawn their own flesh impact
    // right after this call, and a second puff on the same pixel doubles the
    // blood and reads as a stutter.
    deal(
      target,
      amount,
      hit.point,
      _normal,
      source,
      headshot,
      headshotMultiplier(source),
      hit.tag !== "actor",
    );
  }

  /**
   * The one place damage is applied. Everything above funnels here.
   *
   * `headMult` is passed rather than looked up so the explosion path can pass
   * 1 without pretending it fired a weapon.
   */
  function deal(
    target: DamageTarget,
    raw: number,
    point: THREE.Vector3,
    normal: THREE.Vector3,
    source: DamageSource,
    headshot: boolean,
    headMult: number,
    spawnImpact: boolean,
  ): void {
    if (!target.alive || target.hp <= 0) return;

    // By identity, not by id: an unregistered target that happens to share an
    // id with a live one must not inherit its kill credit.
    const slotIndex = byTarget.get(target);
    const slot = slotIndex === undefined ? undefined : slots[slotIndex];
    const damage = headshot ? raw * headMult : raw;
    if (!(damage > 0)) return;

    const hp0 = Math.max(0, target.hp);
    const sh0 = Math.max(0, target.shield);

    // Fortnite's rule, and the reason the numbers are two colours: blue soaks
    // first, and only the overflow reaches health.
    const shieldTaken = Math.min(sh0, damage);
    const healthTaken = Math.min(hp0, damage - shieldTaken);

    // Write the pools first, then hand the owner the *total*. Owners that
    // manage their own health (player, bots) recompute the same split from
    // their own authoritative fields and overwrite what we wrote; owners that
    // do not are already correct. Either way the damage lands exactly once.
    target.shield = sh0 - shieldTaken;
    target.hp = hp0 - healthTaken;

    try {
      target.onDamage(damage, point, source, headshot);
    } catch (err) {
      // A broken reaction must not swallow the kill: the pools are already
      // written, so the death check below still runs.
      console.error("[Drop Zero] combat: onDamage threw for", target.id, err);
    }

    const actualShield = Math.max(0, sh0 - Math.max(0, target.shield));
    const actualHealth = Math.max(0, hp0 - Math.max(0, target.hp));
    const actual = actualShield + actualHealth;
    if (actual <= 0 && damage > 0) {
      // The owner refused the damage outright (spawn protection, a downed
      // player whose bleed-out clock took it instead). Respect that: no
      // number, no hitmarker, no credit.
      return;
    }

    if (slot) {
      slot.taken += actual;
      creditDamage(slot, source, actual);
      accumulateNumber(slot, actualHealth, actualShield, headshot, point, source);
    } else {
      // Unregistered target — someone handed us a `DamageTarget` that never
      // registered. Still legal, still damaged, just not tracked.
      spawnNumber(point, actualHealth, actualShield, headshot);
    }
    dealt.set(source.by, (dealt.get(source.by) ?? 0) + actual);

    /**
     * Two different questions, deliberately answered separately.
     *
     * `down` — the target is out of health *right now*. That is what the
     * shooter's hitmarker answers: you dropped them, and the confirm has to
     * land on the same frame as the shot or it does not feel like yours.
     *
     * `dead` — the target's own module has declared it gone. `player.ts`
     * runs a down-and-bleeding-out beat at zero health (the camera keeps
     * running while the kill feed lands) and keeps `alive` true throughout;
     * `bots.ts` clears `alive` inside `killBot`. Filing the elimination off
     * `hp <= 0` would cut the player's death sequence off at the knees and
     * flip the match to "eliminated" while they are still on the ground.
     * `alive` is the target's flag and combat respects it. See `checkBleedout`
     * for the backstop that covers a target with no death handling at all.
     */
    const down = target.hp <= 0;
    const dead = !target.alive;
    feedback(
      target,
      actual,
      actualShield,
      actualHealth,
      headshot,
      point,
      normal,
      source,
      down || dead,
      spawnImpact,
    );

    if (dead) {
      fileDeath(target, slot, source);
    } else if (down && slot) {
      // Remember who put them there, so the backstop can credit it correctly
      // if the owner never gets around to declaring the death.
      slot.downFor = 0;
    }
  }

  /** Positional audio + hitmarker + the HUD damage event for one landed hit. */
  function feedback(
    target: DamageTarget,
    total: number,
    shieldPart: number,
    healthPart: number,
    headshot: boolean,
    point: THREE.Vector3,
    normal: THREE.Vector3,
    source: DamageSource,
    dead: boolean,
    spawnImpact: boolean,
  ): void {
    const audio = ctx.services.audio;
    const byPlayer = source.by === "player";

    // Victim-side cue: the wet thud everyone nearby hears, positional and
    // distance-attenuated. Deliberately NOT the same cue as the shooter's
    // hitmarker tick (`weapons.ts` owns that, non-positional) — in a real BR
    // those are two different sounds arriving from two different places, and
    // collapsing them into one is what makes web shooters sound thin.
    if (audio) {
      try {
        if (shieldPart > 0 && healthPart <= 0) {
          audio.play("hit-shield", {
            position: point,
            volume: clamp(0.22 + total / 220, 0.22, 0.6),
            maxDistance: 70,
            rate: 0.94 + (headshot ? 0.12 : 0),
          });
        } else {
          audio.play("hit-flesh", {
            position: point,
            volume: clamp(0.24 + total / 200, 0.24, 0.65),
            maxDistance: 70,
            rate: headshot ? 1.12 : 0.96 + total * 0.0012,
          });
        }
        // The shield popping is its own event and deserves its own sound —
        // it is the moment the fight changes.
        if (shieldPart > 0 && target.shield <= 0 && !dead) {
          audio.play("shield-break", { position: point, volume: 0.55, maxDistance: 90 });
        }
        // The headshot chime is the local player's reward and nobody else's.
        if (headshot && byPlayer && !dead) {
          audio.play("headshot", { volume: 0.5 });
        }
      } catch {
        /* audio is optional; a missing cue never blocks damage */
      }
    }

    // Blood/impact puff for damage that arrived undecorated — explosions,
    // thrown weapons, scripted damage. A hit with no impact at all reads as a
    // miss no matter what the number says.
    if (spawnImpact) {
      try {
        ctx.services.vfx?.impact(point, normal, "flesh");
      } catch {
        /* cosmetic */
      }
    }

    if (byPlayer) {
      _hitmarkerEvent.kind = dead ? "elim" : shieldPart > 0 && healthPart <= 0 ? "shield" : "hit";
      _hitmarkerEvent.amount = Math.round(total);
      _hitmarkerEvent.headshot = headshot;
      ctx.emit("dz:hitmarker", _hitmarkerEvent);
    }

    _damageEvent.id = target.id;
    _damageEvent.by = source.by;
    _damageEvent.amount = total;
    _damageEvent.health = healthPart;
    _damageEvent.shield = shieldPart;
    _damageEvent.headshot = headshot;
    _damageEvent.elim = dead;
    _damageEvent.hp = Math.max(0, target.hp);
    _damageEvent.shieldLeft = Math.max(0, target.shield);
    _damageEvent.x = point.x;
    _damageEvent.y = point.y;
    _damageEvent.z = point.z;
    ctx.emit("dz:damage", _damageEvent);
  }

  // -------------------------------------------------------------------------
  // Damage numbers — coalesced
  // -------------------------------------------------------------------------

  function accumulateNumber(
    slot: Slot,
    health: number,
    shield: number,
    headshot: boolean,
    point: THREE.Vector3,
    source: DamageSource,
  ): void {
    // A different shooter must never merge into someone else's number: two
    // people beaming the same rival should each read their own damage.
    if (slot.pendBy !== source.by) flushNumbers(slot);

    slot.pendBy = source.by;
    slot.pendHealth += health;
    slot.pendShield += shield;
    // One headshot in a spread makes the whole coalesced number a headshot.
    // That is the honest read: the shot *was* a headshot, and splitting nine
    // pellets into "headshot 22 / body 71" is information nobody uses.
    slot.pendHead = slot.pendHead || headshot;
    slot.pendPoint.copy(point);
    slot.pendTimer = NUMBER_WINDOW;
  }

  function flushNumbers(slot: Slot): void {
    if (slot.pendHealth <= 0 && slot.pendShield <= 0) {
      slot.pendTimer = 0;
      return;
    }
    spawnNumber(slot.pendPoint, slot.pendHealth, slot.pendShield, slot.pendHead);
    slot.pendHealth = 0;
    slot.pendShield = 0;
    slot.pendHead = false;
    slot.pendTimer = 0;
    slot.pendBy = "";
  }

  /**
   * Spawn the split. A shot that crosses the shield boundary produces two
   * numbers — blue then white — because that is exactly what happened, and
   * because a single merged number leaves the player unable to tell whether
   * the next shot finishes them.
   */
  function spawnNumber(point: THREE.Vector3, health: number, shield: number, headshot: boolean): void {
    const vfx = ctx.services.vfx;
    if (!vfx) return;
    try {
      if (shield >= 1) {
        // Nudged up so the pair does not overlap into mush when both fire on
        // the same frame; the vfx layer stacks anything closer than this.
        _tmp.copy(point);
        _tmp.y += 0.26;
        vfx.damageNumber(_tmp, Math.round(shield), headshot && health < 1, true);
      }
      if (health >= 1) {
        vfx.damageNumber(point, Math.round(health), headshot, false);
      }
    } catch {
      /* a missing number is cosmetic; the damage already landed */
    }
  }

  // -------------------------------------------------------------------------
  // Kill credit and death
  // -------------------------------------------------------------------------

  function creditDamage(slot: Slot, source: DamageSource, amount: number): void {
    const now = ctx.elapsed;
    if (slot.lastBy === source.by) {
      // Same shooter still on the clock: extend, do not reset.
      if (now - slot.lastAt <= CREDIT_MEMORY) slot.lastDamage += amount;
      else slot.lastDamage = amount;
      slot.lastAt = now;
      slot.lastName = source.name ?? slot.lastName;
      slot.lastWeapon = source.weapon ?? slot.lastWeapon;
      return;
    }

    // A new shooter takes the kill claim; the outgoing one drops to assist if
    // they did enough work recently enough to deserve it.
    if (now - slot.lastAt <= CREDIT_MEMORY && slot.lastDamage > slot.assistDamage) {
      slot.assistBy = slot.lastBy;
      slot.assistName = slot.lastName;
      slot.assistDamage = slot.lastDamage;
      slot.assistAt = slot.lastAt;
    }
    slot.lastBy = source.by;
    slot.lastName = source.name ?? source.by;
    slot.lastWeapon = source.weapon ?? "";
    slot.lastDamage = amount;
    slot.lastAt = now;
  }

  /**
   * File an elimination exactly once.
   *
   * The kill feed is the single most-screenshotted piece of UI in a battle
   * royale and a duplicated line in it is instantly, embarrassingly visible.
   * Three modules can plausibly notice the same death — combat, the victim's
   * own module, and `match` itself — so the rule here is: `match.reportDeath`
   * is idempotent by id and owns the feed, and combat only *announces*
   * `dz:eliminate` itself when match could not take the report at all. That
   * covers the standalone case (match failed to boot) without ever doubling
   * the line when it did.
   */
  function fileDeath(target: DamageTarget, slot: Slot | undefined, source: DamageSource): void {
    if (slot?.filed) return;
    if (slot) {
      slot.filed = true;
      slot.deadFor = 0;
      flushNumbers(slot);
    }
    target.alive = false;
    target.hp = 0;
    target.shield = 0;

    /* Every elimination in the water game bursts. This is the one place every
       death is filed — bots, the storm, a balloon, a fall — so it is the one
       place the burst belongs, rather than at each of the callers that can end
       a life. The victim's capsule centre, not their feet: water thrown from
       ankle height reads as a puddle rather than as somebody going out. */
    if (ctx.mode === "water") {
      const at = target.object.position.clone();
      at.y += target.height * 0.5;
      ctx.services.vfx?.soakBurst(at, 1);
    }

    // Credit goes to whoever has the live claim, which is normally the source
    // of the killing blow but is not when the storm or a fall finished someone
    // a player had already broken.
    let credited = source;
    if (slot && slot.lastBy && slot.lastBy !== source.by && ctx.elapsed - slot.lastAt <= CREDIT_MEMORY) {
      const environmental = source.by === "storm" || source.by === "world" || source.by === "";
      if (environmental) {
        _credit.by = slot.lastBy;
        _credit.name = slot.lastName || slot.lastBy;
        _credit.weapon = slot.lastWeapon || source.weapon;
        credited = _credit;
      }
    }

    let reported = false;
    const match = ctx.services.match;
    if (match) {
      try {
        match.reportDeath(target.id, credited);
        reported = true;
      } catch (err) {
        console.error("[Drop Zero] combat: reportDeath threw for", target.id, err);
      }
    }

    if (!reported) {
      // Fallback announcement. The payload is a superset of the two shapes
      // already in the codebase (`match.ts` emits killer/victim/byPlayer,
      // `bots.ts` emits victim/victimName/by/byName) so a HUD written against
      // either one still reads this correctly.
      ctx.emit("dz:eliminate", {
        victim: target.id,
        victimName: target.id === "player" ? "You" : target.id,
        killer: credited.name ?? credited.by,
        by: credited.by,
        byName: credited.name ?? credited.by,
        weapon: credited.weapon,
        byPlayer: credited.by === "player",
        onPlayer: target.id === "player",
        environmental: credited.by === "storm" || credited.by === "world",
      });
    }

    if (slot && slot.assistBy && slot.assistBy !== credited.by && slot.assistDamage >= ASSIST_MIN_DAMAGE) {
      _assistEvent.by = slot.assistBy;
      _assistEvent.name = slot.assistName || slot.assistBy;
      _assistEvent.victim = target.id;
      _assistEvent.damage = Math.round(slot.assistDamage);
      ctx.emit("dz:assist", _assistEvent);
    }
  }

  // -------------------------------------------------------------------------
  // Structures
  // -------------------------------------------------------------------------

  /**
   * Damage a built piece.
   *
   * Always through `build.damagePiece`, never by writing `hp` — the build
   * system runs a structural pass when a piece dies (shoot the wall under a
   * ramp tower and the tower comes down) and a piece removed behind its back
   * would leave a floating ramp and a stale collider.
   *
   * The fallback exists for pieces the build system does not own: `bots.ts`
   * fabricates `BuildPiece`-shaped objects for the walls its rivals throw up,
   * shaped so that `build.damagePiece` recognises them as foreign and no-ops.
   * Those route their damage through an `hp` setter instead, so if the call
   * left the piece untouched we assign through the setter and let the wall's
   * owner deal with it.
   */
  function damageStructure(
    piece: BuildPiece,
    amount: number,
    source: DamageSource,
    point: THREE.Vector3 | null,
  ): void {
    if (!piece || !(amount > 0)) return;
    const before = piece.hp;
    const build = ctx.services.build;
    if (build) {
      try {
        build.damagePiece(piece, amount, source);
      } catch (err) {
        console.error("[Drop Zero] combat: damagePiece threw", err);
      }
    }
    if (piece.hp === before && before > 0) {
      // Foreign piece (or no build service at all) — go through the setter.
      try {
        piece.hp = before - amount;
      } catch {
        /* nothing owns this piece; the damage is simply lost */
      }
    }

    const hitPoint = point ?? piece.box.getCenter(_boxCenter);
    // Builds get numbers too. In Fortnite they are the feedback that tells you
    // whether to keep shooting the wall or to swap to the ramp, and a silent
    // wall is the reason players give up on shooting through cover.
    const vfx = ctx.services.vfx;
    if (vfx) {
      try {
        vfx.damageNumber(hitPoint, Math.round(amount), false, false);
      } catch {
        /* cosmetic */
      }
    }
    if (source.by === "player") {
      _hitmarkerEvent.kind = "hit";
      _hitmarkerEvent.amount = Math.round(amount);
      _hitmarkerEvent.headshot = false;
      ctx.emit("dz:hitmarker", _hitmarkerEvent);
    }
    dealt.set(source.by, (dealt.get(source.by) ?? 0) + amount);
  }

  // -------------------------------------------------------------------------
  // Explosions
  // -------------------------------------------------------------------------

  /**
   * Fraction of a blast that reaches a point at `dist` from the centre.
   *
   * Ease-out rather than linear: the core is fat and the rim is survivable but
   * real. See BLAST_FALLOFF.
   */
  function blastFraction(dist: number, radius: number): number {
    if (dist >= radius) return 0;
    const t = 1 - dist / radius;
    return BLAST_MIN_FRACTION + (1 - BLAST_MIN_FRACTION) * Math.pow(t, BLAST_FALLOFF);
  }

  /**
   * How much of the blast survives the geometry between it and a point.
   *
   * One raycast per target inside the radius — there are never more than a
   * handful. Without this a grenade kills through a hill, which players read
   * (correctly) as the game not simulating anything.
   */
  function occlusion(from: THREE.Vector3, to: THREE.Vector3): number {
    const collision = ctx.services.collision;
    if (!collision) return 1;
    _dir.copy(to).sub(from);
    const dist = _dir.length();
    if (dist < 0.25) return 1;
    _dir.multiplyScalar(1 / dist);
    try {
      // Start a little off the blast origin: a grenade resting on the floor
      // would otherwise occlude itself against the floor it is touching.
      _tmp2.copy(from).addScaledVector(_dir, 0.25);
      const hit = collision.raycast(_tmp2, _dir, dist - 0.35);
      if (!hit) return 1;
      return hit.piece ? 1 - BLAST_BUILT_OCCLUSION : 1 - BLAST_WORLD_OCCLUSION;
    } catch {
      return 1;
    }
  }

  function explode(point: THREE.Vector3, radius: number, damage: number, source: DamageSource): void {
    if (disposed || !(radius > 0) || !(damage > 0)) return;

    // --- actors ------------------------------------------------------------
    const list = queryTargets(point, radius);
    // Copy out of the pooled buffer: `deal` runs the victim's `onDamage`,
    // which can register or unregister targets (a bot dying unregisters
    // itself), and iterating a buffer another query can reuse underneath us
    // is exactly the kind of bug that only shows up in a crowded endgame.
    blastTargets.length = 0;
    for (let i = 0; i < list.length; i++) blastTargets.push(list[i]);

    for (let i = 0; i < blastTargets.length; i++) {
      const t = blastTargets[i];
      if (!t.alive || t.hp <= 0) continue;
      const dSq = capsuleDistanceSq(t, point, _closest);
      const dist = Math.sqrt(dSq);
      let frac = blastFraction(dist, radius);
      if (frac <= 0) continue;
      frac *= occlusion(point, _closest);
      if (frac <= 0.001) continue;

      let amount = damage * frac;
      // Catching your own rocket should cost you, not delete you — rocket
      // riding is a mechanic and full self-damage would remove it.
      if (t.id === source.by) amount *= SELF_DAMAGE;
      if (!(amount > 0.5)) continue;

      _normal.copy(_closest).sub(point);
      if (_normal.lengthSq() < 1e-6) _normal.copy(_up);
      else _normal.normalize();
      // Explosions never headshot. A blast that rolled a 2.5× because the
      // fragment happened to clip an ear would be pure noise.
      deal(t, amount, _closest, _normal, source, false, 1, true);
    }
    blastTargets.length = 0;

    // --- structures --------------------------------------------------------
    const build = ctx.services.build;
    if (build) {
      let pieces: BuildPiece[] | null = null;
      try {
        pieces = build.queryPieces(point, radius);
      } catch {
        pieces = null;
      }
      if (pieces) {
        for (let i = 0; i < pieces.length; i++) {
          const p = pieces[i];
          if (!p || p.hp <= 0) continue;
          // Distance to the box, not to its centre: a long floor piece should
          // take the blast where it is actually closest.
          p.box.clampPoint(point, _tmp);
          const dist = _tmp.distanceTo(point);
          const frac = blastFraction(dist, radius);
          if (frac <= 0) continue;
          damageStructure(p, damage * frac * BLAST_STRUCTURE_MULT, source, _tmp);
        }
      }
    }

    // --- knockback ---------------------------------------------------------
    const player = ctx.services.player;
    if (player) {
      const dist = player.position.distanceTo(point);
      if (dist < radius * 1.4) {
        const f = blastFraction(Math.min(dist, radius * 0.999), radius * 1.4);
        _dir.copy(player.position).sub(point);
        if (_dir.lengthSq() < 0.01) _dir.copy(_up);
        _dir.normalize();
        // Bias upward: a blast that only shoves you sideways slides you into
        // the wall behind you, which feels like a bug rather than a bomb.
        player.velocity.addScaledVector(_dir, BLAST_KNOCK * f);
        player.velocity.y += BLAST_KNOCK * f * 0.5;
      }
    }

    spawnBlastCosmetics(point, radius, source);
  }

  /**
   * The look and sound of a blast.
   *
   * Three layers, because one fireball sprite on its own is the definition of
   * a Three.js demo: the core flash, a smoke column sized off the radius, and
   * a scatter of ground impacts that lay scorch decals along the *terrain
   * normal* rather than flat — a blast on a hillside whose scorch is
   * horizontal is a tell you notice before you can name it.
   */
  function spawnBlastCosmetics(point: THREE.Vector3, radius: number, source: DamageSource): void {
    const vfx = ctx.services.vfx;
    const terrain = ctx.services.terrain;

    if (vfx) {
      try {
        // Scale is sublinear in radius: a 12 m blast is not four times the
        // fireball of a 3 m one, it is about twice, and linear scaling makes
        // rockets look like nuclear tests.
        vfx.explosion(point, clamp(Math.sqrt(radius / 4), 0.7, 2.6));
        vfx.smoke(point, clamp(radius * 1.6, 6, 26));

        const count = SCORCH_COUNT[ctx.quality] ?? 3;
        if (count > 0 && terrain) {
          for (let i = 0; i < count; i++) {
            // Golden-angle scatter so the marks never form a visible ring.
            const a = i * 2.399963 + ctx.elapsed;
            const r = radius * 0.35 * Math.sqrt((i + 0.5) / count);
            const x = point.x + Math.cos(a) * r;
            const z = point.z + Math.sin(a) * r;
            const gy = terrain.heightAt(x, z);
            // Only mark ground the blast could actually reach.
            if (point.y - gy > radius * 0.9 || gy > point.y + 1.5) continue;
            _tmp.set(x, gy + 0.02, z);
            terrain.normalAt(x, z, _normal);
            vfx.impact(_tmp, _normal, terrain.materialAt(x, z));
          }
        }
      } catch {
        /* cosmetic only */
      }
    }

    const audio = ctx.services.audio;
    if (audio) {
      try {
        audio.play("explosion", {
          position: point,
          volume: clamp(0.55 + radius * 0.04, 0.55, 1),
          maxDistance: 400,
          // Bigger blasts sit lower. Pitch is the cheapest size cue there is.
          rate: clamp(1.18 - radius * 0.02, 0.82, 1.18),
        });
      } catch {
        /* audio optional */
      }
    }

    // Trauma, not a fixed jolt: `vfx` owns the camera displacement and applies
    // its own distance falloff from `range`.
    _shakeEvent.amount = BLAST_SHAKE * clamp(radius / 6, 0.5, 1.6);
    _shakeEvent.point.copy(point);
    _shakeEvent.range = radius * 4;
    ctx.emit("dz:shake", _shakeEvent);
    void source;
  }

  // -------------------------------------------------------------------------
  // Frame work — bookkeeping only, all of it cosmetic-rate
  // -------------------------------------------------------------------------

  function update(dt: number): void {
    if (disposed) return;

    // Flush coalesced numbers whose window expired, and run the two clocks
    // the registry keeps: how long a target has been dead (drives the reap)
    // and how long it has been at zero health without admitting it (drives
    // the bleed-out backstop).
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s.pendTimer > 0) {
        s.pendTimer -= dt;
        if (s.pendTimer <= 0) flushNumbers(s);
      }
      const t = s.target;
      if (!t) continue;
      if (!t.alive) {
        s.deadFor += dt;
        s.downFor = 0;
      } else if (t.hp <= 0) {
        s.downFor += dt;
        if (s.downFor > BLEEDOUT_GRACE) checkBleedout(s);
      } else {
        s.downFor = 0;
      }
    }

    reap(dt);
  }

  /**
   * File an elimination for a target that has been at zero health long past
   * any plausible down-and-bleeding-out beat.
   *
   * Credit goes to whoever last damaged it, because by definition nobody is
   * around to tell us who finished the job.
   */
  function checkBleedout(slot: Slot): void {
    const t = slot.target;
    if (!t || slot.filed) return;
    _credit.by = slot.lastBy || "world";
    _credit.name = slot.lastName || undefined;
    _credit.weapon = slot.lastWeapon || undefined;
    fileDeath(t, slot, _credit);
  }

  /**
   * Amortised registry hygiene.
   *
   * Two conditions retire a slot, and both are backstops rather than the
   * normal path (owners unregister themselves):
   *
   *  1. The object was in the scene when it registered and has since been
   *     removed — its owner tore it down without unregistering. Note the
   *     `wasParented` guard: bot hit-capsules are *deliberately* parentless
   *     for their whole lives, and reaping those would silently make every
   *     rival on the island bulletproof.
   *  2. It has been dead for `DEAD_REAP_TIME`. A corpse nobody cleaned up
   *     still costs a distance test in every sweep, and `match` counts the
   *     island's survivors by sweeping this registry.
   */
  function reap(dt: number): void {
    void dt;
    if (slots.length === 0) return;
    let checks = Math.min(REAP_PER_FRAME, slots.length);
    while (checks-- > 0) {
      if (slots.length === 0) return;
      if (reapCursor >= slots.length) reapCursor = 0;
      const s = slots[reapCursor];
      const t = s.target;
      if (!t) {
        reapCursor++;
        continue;
      }
      const detached = s.wasParented && t.object.parent === null;
      const stale = !t.alive && s.deadFor > DEAD_REAP_TIME;
      if (detached || stale) {
        unregister(t);
        // `unregister` swap-popped something into this index; re-examine it
        // next frame rather than skipping it.
        continue;
      }
      reapCursor++;
    }
  }

  return {
    name: "combat",
    update,
    dispose(): void {
      disposed = true;
      // Nothing here owns GPU resources, but it does own references: a
      // retained DamageTarget retains an Object3D, which retains a whole
      // character rig and its geometry. Drop the lot.
      for (let i = 0; i < slots.length; i++) {
        slots[i].target = null as unknown as DamageTarget;
      }
      slots.length = 0;
      freeSlots.length = 0;
      blastTargets.length = 0;
      for (let i = 0; i < queryPool.length; i++) queryPool[i].length = 0;
      byTarget.clear();
      byId.clear();
      dealt.clear();
      if (ctx.services.combat === service) delete ctx.services.combat;
    },
  };
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export default createCombat;
