/**
 * play.ts — the reasons to go somewhere.
 *
 * A city you can fly around is a toy for about four minutes. What turns it
 * into a place is having something to find in it, and this file is all of
 * that: the landmark logbook, the coins, and one jetpack course down Market
 * Street.
 *
 * Three rules shape it, and the first two are about what persists.
 *
 * **The logbook persists; the coins do not.** Finding the Dragon Gate is a
 * thing you learned about the city and it should still be true next week.
 * Collecting a coin off a rooftop is a thing you *did*, and if it stayed done
 * then every visit after the first is a walk through an empty city. So the
 * twelve landmarks are written to storage and the coins are reseeded every
 * session. Best course times persist, because a time is only worth having if
 * there is something to beat.
 *
 * **Nothing here blocks anything else.** There is no unlock, no gate, no
 * sequence. You can fly to Alcatraz in the first ten seconds. The whole appeal
 * of a jetpack over a city is that the city is *open*, and a checklist that
 * decides what you are allowed to look at throws that away to buy structure
 * nobody asked for.
 *
 * **It is one group and two draw calls.** Coins and rings are `InstancedMesh`,
 * spun by writing matrices rather than by moving objects, so a hundred and
 * sixty pickups cost the frame about as much as one building does. A world
 * that runs at sixty until you turn the collectibles on is a world with no
 * collectibles.
 */
import * as THREE from "three";
import { makeRng } from "@/shared/proc/rng";
import type { BuildingBox } from "./city";
import type { CityCollision } from "./collision";
import { COLORS, flat, toon } from "./look";
import {
  BOUNDS,
  MARKET_DIR,
  SHORE,
  isOpen,
  isWater,
  landmarkPositions,
  ll,
  walkHeight,
  type Vec2,
} from "./map";

const STORE_KEY = "frisco.logbook";

/**
 * How close you have to get before a landmark counts as found: its own
 * footprint, plus this, plus a share of its height.
 *
 * The height term is the part worth having. "Found" should mean "you have
 * seen it", and you can see the Transamerica Pyramid from three streets away
 * and have to be standing under the Dragon Gate to notice it at all. A flat
 * radius makes the tall ones feel unresponsive — you land on the roof, look
 * around, and the logbook says nothing — while making it big enough for them
 * hands you the small ones from the next block.
 */
const FIND_PAD = 55;
const FIND_PER_METRE = 0.35;

export type PlayEvent =
  | { kind: "landmark"; key: string; name: string; blurb: string; found: number; total: number }
  | { kind: "coin"; got: number; total: number }
  | { kind: "ring"; index: number; total: number }
  | { kind: "course"; course: string; name: string; seconds: number; best: number; record: boolean }
  | { kind: "course-start"; course: string; name: string; blurb: string }
  | { kind: "tour"; touched: number; total: number; name: string }
  | { kind: "tour-done"; seconds: number; best: number; record: boolean };

export interface PlaySnapshot {
  /** Landmark keys found, ever. */
  found: string[];
  totalLandmarks: number;
  coins: number;
  totalCoins: number;
  /** Which challenge is running: a course key, "tour", or null. */
  running: string | null;
  /** Which ring of the course is next, or -1 when no course is running. */
  ring: number;
  totalRings: number;
  /** Landmarks touched on this tour run. */
  touched: number;
  touchedKeys: string[];
  /** Seconds into the current run, or 0. */
  clock: number;
  /** Best times by challenge key. */
  best: Record<string, number>;
  /** The nearest landmark, for the compass line in the HUD. */
  nearest: { name: string; metres: number; found: boolean } | null;
}

interface Stored {
  found?: string[];
  /** Legacy: the single Market-run best, before there were three courses. */
  bestCourse?: number;
  best?: Record<string, number>;
}

function load(): Stored {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Stored) : {};
  } catch {
    return {};
  }
}

function save(s: Stored): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* Private browsing, quota, a locked-down embed. Losing the logbook is not
       worth taking the world down for. */
  }
}

/* ------------------------------------------------------------------ *
 * Placement
 * ------------------------------------------------------------------ */

interface Coin {
  x: number;
  y: number;
  z: number;
  taken: boolean;
  /** Phase offset so a row of coins does not spin in lockstep. */
  phase: number;
}

/**
 * Where the coins go, and why they go there.
 *
 * Four kinds, in deliberate proportion. Rooftops are most of them, because a
 * rooftop is the thing a jetpack is *for* — it is the one place in a city you
 * can see from the street and cannot get to. Street-level coins are there so
 * somebody who never presses the fly button still finds things. Park coins
 * make the parks worth walking into. And the arcs out over the bay are pure
 * bait: a line of coins leading away from land, which is how you discover the
 * fuel gauge means something.
 */
function placeCoins(colliders: BuildingBox[]): Coin[] {
  const rng = makeRng("frisco-coins-v1");
  const out: Coin[] = [];
  const push = (x: number, y: number, z: number) =>
    out.push({ x, y, z, taken: false, phase: rng.next() * Math.PI * 2 });

  // Rooftops — only on buildings tall enough that the roof is a destination.
  const tall = colliders.filter((c) => c.roofY - c.baseY > 18);
  for (let i = 0; i < 74 && tall.length > 0; i++) {
    const c = tall[rng.int(0, tall.length - 1)];
    push(c.x + rng.range(-c.hw * 0.4, c.hw * 0.4), c.roofY + 2.6, c.z + rng.range(-c.hd * 0.4, c.hd * 0.4));
  }

  // Street level, spread across downtown.
  for (let i = 0; i < 46; i++) {
    for (let tries = 0; tries < 24; tries++) {
      const x = rng.range(-900, 700);
      const z = rng.range(-1200, 900);
      if (isWater(x, z)) continue;
      push(x, walkHeight(x, z) + 1.5, z);
      break;
    }
  }

  // Parks and plazas.
  for (let i = 0; i < 22; i++) {
    for (let tries = 0; tries < 40; tries++) {
      const x = rng.range(BOUNDS.minX + 200, BOUNDS.maxX - 200);
      const z = rng.range(BOUNDS.minZ + 200, BOUNDS.maxZ - 200);
      if (!isOpen(x, z) || isWater(x, z)) continue;
      push(x, walkHeight(x, z) + 1.5, z);
      break;
    }
  }

  // Three arcs out over the water, climbing then falling.
  const marks = landmarkPositions();
  const rock = marks.find((m) => m.key === "alcatraz");
  const arcs: Array<[number, number, number, number]> = [
    [-200, -1700, rock ? rock.x : -1000, rock ? rock.z : -2000],
    [700, 200, 1250, 620],
    [-1400, -1500, -1850, -1980],
  ];
  for (const [ax, az, bx, bz] of arcs) {
    const N = 9;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const h = 40 + Math.sin(t * Math.PI) * 130;
      push(ax + (bx - ax) * t, h, az + (bz - az) * t);
    }
  }

  // One on top of every landmark, so the logbook and the coins agree about
  // what is worth going to look at.
  for (const m of marks) push(m.x, walkHeight(m.x, m.z) + m.height + 8, m.z);

  return out;
}

interface Ring {
  x: number;
  y: number;
  z: number;
  /** Facing, as a yaw — the ring stands across the direction of travel. */
  yaw: number;
  r: number;
}

/**
 * The courses.
 *
 * Three of them, and every one follows something real: Market Street, the
 * Embarcadero, the climb from the water up over Nob Hill. A ring course laid
 * out in open air is a slalom that could be anywhere; one that runs up an
 * actual street makes you fly the city — down a canyon, over the top of Union
 * Square, up the hill — and you come out of it knowing where things are.
 *
 * They are data now rather than one hard-coded function, which is the whole
 * reason there are three instead of one. A course is a polyline, a count and a
 * height profile; `ringsAlong` does the rest.
 */
export interface Course {
  key: string;
  name: string;
  blurb: string;
  /**
   * `clearance(x, z)` is the height of whatever is already there — a roof, or
   * the ground. Every ring is placed above it.
   *
   * Not optional and not an afterthought: the Hill Climb was unfinishable
   * because three of its ten rings were inside Nob Hill apartment blocks. You
   * could see them through the wall, the collision pushed you back out every
   * time you got near, and the course simply never advanced. Nothing about that
   * is visible from the air, and nothing about it is visible in a screenshot —
   * it took flying all three courses in a harness to find.
   */
  build(clearance: (x: number, z: number) => number): Ring[];
}

/**
 * Lay `count` rings along a polyline, at `liftAt` metres above the ground.
 *
 * The weave is what stops a course being a tube, and it is bounded by
 * `halfWidth` for a reason: the first version of the Market run wove 34 m off
 * the centreline, which is twice the width of the street, so half its rings
 * were buried inside the buildings on either side. You could see them through a
 * wall and there was no way to fly to one. A course you cannot finish is worse
 * than no course, and from outside the canyon it looks perfectly fine.
 */
function ringsAlong(
  path: Vec2[],
  count: number,
  halfWidth: number,
  liftAt: (t: number) => number,
  clearance: (x: number, z: number) => number,
  weaves = 2.6,
): Ring[] {
  const out: Ring[] = [];
  // Arc length, so rings are evenly spaced however unevenly the path is sampled.
  const cum: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z));
  }
  const total = cum[cum.length - 1];
  if (total < 1) return out;

  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const want = t * total;
    let seg = 1;
    while (seg < cum.length - 1 && cum[seg] < want) seg++;
    const span = cum[seg] - cum[seg - 1] || 1;
    const f = (want - cum[seg - 1]) / span;
    const a = path[seg - 1];
    const b = path[seg];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    const cx = a.x + dx * f;
    const cz = a.z + dz * f;
    const side = Math.sin(t * Math.PI * weaves) * halfWidth;
    const px = cx - uz * side;
    const pz = cz + ux * side;
    // Above the ground, and above anything standing on it, plus a ring's worth
    // of room so you are not threading the gap between a roof and a ring.
    const floor = Math.max(walkHeight(px, pz), clearance(px, pz) + 14);
    out.push({
      x: px,
      y: floor + liftAt(t),
      z: pz,
      yaw: Math.atan2(uz, ux),
      r: 11,
    });
  }
  return out;
}

export const COURSES: Course[] = [
  {
    key: "market",
    name: "Market Street Run",
    blurb: "Fourteen rings from the water up the street and over the hill.",
    build: (clear) => {
      const path: Vec2[] = [];
      for (let t = -420; t <= 1580; t += 100) {
        path.push({ x: MARKET_DIR.x * t, z: MARKET_DIR.z * t });
      }
      return ringsAlong(path, 14, 11, (t) => 34 + Math.sin(t * Math.PI * 1.7) * 30, clear);
    },
  },
  {
    key: "waterfront",
    name: "Waterfront Dash",
    blurb: "Twelve rings up the Embarcadero, from the Bay Bridge to Pier 39.",
    build: (clear) => {
      /* The seawall backwards — south to north — offset inland so the rings sit
         over the Embarcadero rather than over the bay. The shore polyline runs
         north to south and land is on its left, so the inland normal is the
         right-hand one when you walk it in reverse. */
      const path: Vec2[] = [];
      const pts = [...SHORE].reverse();
      for (let i = 0; i < pts.length; i++) {
        const a = pts[Math.max(0, i - 1)];
        const b = pts[Math.min(pts.length - 1, i + 1)];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len = Math.hypot(dx, dz) || 1;
        path.push({ x: pts[i].x + (dz / len) * 30, z: pts[i].z - (dx / len) * 30 });
      }
      return ringsAlong(path, 12, 9, (t) => 22 + Math.sin(t * Math.PI) * 24, clear, 3.4);
    },
  },
  {
    key: "hills",
    name: "The Hill Climb",
    blurb: "Ten rings from the Ferry Building over Nob Hill. Watch your fuel.",
    build: (clear) => {
      const a = ll(37.7955, -122.3937);
      const b = ll(37.7924, -122.4145);
      const c = ll(37.8021, -122.4187);
      const path: Vec2[] = [];
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        // Two legs: out to Nob Hill, then north to Lombard.
        const p = t < 0.6
          ? { x: a.x + (b.x - a.x) * (t / 0.6), z: a.z + (b.z - a.z) * (t / 0.6) }
          : { x: b.x + (c.x - b.x) * ((t - 0.6) / 0.4), z: b.z + (c.z - b.z) * ((t - 0.6) / 0.4) };
        path.push(p);
      }
      // A climbing profile ON TOP of terrain that is itself climbing, so the
      // last rings are a hundred and thirty metres over the bay.
      return ringsAlong(path, 10, 14, (t) => 30 + t * 46, clear, 2.0);
    },
  },
];

/* ------------------------------------------------------------------ *
 * The playground
 * ------------------------------------------------------------------ */

export class Playground {
  readonly group = new THREE.Group();

  private coins: Coin[];
  private rings: Ring[];
  private courseRings: Map<string, Ring[]>;
  private maxRings: number;
  private coinMesh: THREE.InstancedMesh;
  private ringMesh: THREE.InstancedMesh;
  private coinGeo: THREE.BufferGeometry;
  private ringGeo: THREE.BufferGeometry;
  private found: Set<string>;
  private best: Record<string, number>;
  private got = 0;
  private running: string | null = null;
  private nextRing = -1;
  private touched = new Set<string>();
  private clock = 0;
  private nearest: PlaySnapshot["nearest"] = null;
  private tmp = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);

  constructor(colliders: BuildingBox[], collision: CityCollision) {
    this.group.name = "frisco-play";
    const stored = load();
    this.found = new Set(stored.found ?? []);
    this.best = { ...(stored.best ?? {}) };
    // Carry forward the one time that existed before there were three courses,
    // rather than silently resetting somebody's record.
    if (stored.bestCourse !== undefined && this.best.market === undefined) {
      this.best.market = stored.bestCourse;
    }

    this.coins = placeCoins(colliders);
    // Sized for the longest course; shorter ones leave the tail scaled to zero.
    const clear = (x: number, z: number) => collision.roofOver(x, z) ?? walkHeight(x, z);
    this.courseRings = new Map(COURSES.map((c) => [c.key, c.build(clear)]));
    this.maxRings = Math.max(...[...this.courseRings.values()].map((r) => r.length));
    this.rings = [];

    /* A twelve-sided coin lying on its side, spun about Y. Not a torus and not
       a sprite: a sprite cannot show you which way it is facing, and the flash
       as a flat disc turns edge-on is most of what makes a coin catch your eye
       from three streets away. */
    this.coinGeo = new THREE.CylinderGeometry(2.1, 2.1, 0.42, 12);
    this.coinGeo.rotateX(Math.PI / 2);
    this.coinMesh = new THREE.InstancedMesh(
      this.coinGeo,
      toon(COLORS.gold, { emissive: 0x6b4a00, emissiveIntensity: 0.55 }),
      this.coins.length,
    );
    this.coinMesh.name = "frisco-coins";
    this.coinMesh.frustumCulled = false;
    this.coinMesh.castShadow = false;
    this.group.add(this.coinMesh);

    this.ringGeo = new THREE.TorusGeometry(11, 0.85, 8, 26);
    this.ringMesh = new THREE.InstancedMesh(this.ringGeo, flat(0x35f0d0), this.maxRings);
    this.ringMesh.name = "frisco-rings";
    this.ringMesh.frustumCulled = false;
    this.ringMesh.visible = false;
    this.group.add(this.ringMesh);
  }

  /**
   * Start a challenge: one of the `COURSES` keys, or `"tour"`.
   *
   * Starting one stops whatever else was running, because two clocks at once
   * is a HUD problem and an "is that time for the thing I finished or the thing
   * I am doing" problem, and neither is worth the feature.
   */
  start(key: string): PlayEvent[] {
    this.stop();
    if (key === "tour") {
      this.running = "tour";
      this.clock = 0;
      this.touched.clear();
      return [{
        kind: "course-start", course: "tour", name: "The Grand Tour",
        blurb: "Touch all twelve landmarks. The clock is running.",
      }];
    }
    const course = COURSES.find((c) => c.key === key);
    if (!course) return [];
    this.running = key;
    this.rings = this.courseRings.get(key) ?? [];
    this.nextRing = 0;
    this.clock = 0;
    this.ringMesh.visible = true;
    return [{
      kind: "course-start", course: key, name: course.name, blurb: course.blurb,
    }];
  }

  /** Abandon a run. Nothing is recorded. */
  stop(): void {
    this.running = null;
    this.nextRing = -1;
    this.clock = 0;
    this.touched.clear();
    this.ringMesh.visible = false;
  }

  /** Where the next ring is, so the HUD can point at it. */
  nextRingPosition(): THREE.Vector3 | null {
    if (this.nextRing < 0 || this.nextRing >= this.rings.length) return null;
    const r = this.rings[this.nextRing];
    return new THREE.Vector3(r.x, r.y, r.z);
  }

  update(dt: number, elapsed: number, player: THREE.Vector3): PlayEvent[] {
    const events: PlayEvent[] = [];

    /* ---- coins ---- */
    // Spin them all, and collect the ones the player has reached. The whole
    // list every frame is fine: a hundred and seventy distance checks is
    // nothing next to one draw call, and a spatial index for it would be more
    // code than the feature.
    for (let i = 0; i < this.coins.length; i++) {
      const c = this.coins[i];
      if (c.taken) continue;
      const dx = player.x - c.x;
      const dy = player.y - c.y;
      const dz = player.z - c.z;
      if (dx * dx + dy * dy + dz * dz < 25) {
        c.taken = true;
        this.got++;
        // Scale to nothing rather than rebuilding the buffer.
        this.tmp.makeScale(0, 0, 0);
        this.coinMesh.setMatrixAt(i, this.tmp);
        events.push({ kind: "coin", got: this.got, total: this.coins.length });
        continue;
      }
      this.v.set(c.x, c.y + Math.sin(elapsed * 1.7 + c.phase) * 0.35, c.z);
      this.q.setFromEuler(new THREE.Euler(0, elapsed * 2.1 + c.phase, 0));
      this.tmp.compose(this.v, this.q, this.s);
      this.coinMesh.setMatrixAt(i, this.tmp);
    }
    this.coinMesh.instanceMatrix.needsUpdate = true;

    /* ---- landmarks ---- */
    const marks = landmarkPositions();
    let bestD = Infinity;
    let bestMark: (typeof marks)[number] | null = null;
    for (const m of marks) {
      const d = Math.hypot(player.x - m.x, player.z - m.z);
      if (d < bestD) {
        bestD = d;
        bestMark = m;
      }
      if (d > m.footprint + FIND_PAD + m.height * FIND_PER_METRE) continue;
      /* The tour counts a touch whether or not the logbook already has it —
         they are different questions. The logbook is "have you ever seen this";
         the tour is "have you been to all twelve since the clock started". */
      if (this.running === "tour" && !this.touched.has(m.key)) {
        this.touched.add(m.key);
        if (this.touched.size >= marks.length) {
          const seconds = this.clock;
          const record = this.best.tour === undefined || seconds < this.best.tour;
          if (record) {
            this.best.tour = seconds;
            this.persist();
          }
          events.push({ kind: "tour-done", seconds, best: this.best.tour ?? seconds, record });
          this.stop();
        } else {
          events.push({
            kind: "tour", touched: this.touched.size, total: marks.length, name: m.name,
          });
        }
      }
      if (this.found.has(m.key)) continue;
      this.found.add(m.key);
      this.persist();
      events.push({
        kind: "landmark",
        key: m.key,
        name: m.name,
        blurb: m.blurb,
        found: this.found.size,
        total: marks.length,
      });
    }
    this.nearest = bestMark
      ? { name: bestMark.name, metres: Math.round(bestD), found: this.found.has(bestMark.key) }
      : null;

    /* ---- the clock ---- */
    if (this.running === "tour") this.clock += dt;

    /* ---- the course ---- */
    if (this.nextRing >= 0) {
      this.clock += dt;
      const r = this.rings[this.nextRing];
      const d = Math.hypot(player.x - r.x, player.y - r.y, player.z - r.z);
      if (d < r.r) {
        this.nextRing++;
        if (this.nextRing >= this.rings.length) {
          const seconds = this.clock;
          const key = this.running ?? "market";
          const prev = this.best[key];
          const record = prev === undefined || seconds < prev;
          if (record) {
            this.best[key] = seconds;
            this.persist();
          }
          events.push({
            kind: "course",
            course: key,
            name: COURSES.find((c) => c.key === key)?.name ?? "Course",
            seconds,
            best: this.best[key] ?? seconds,
            record,
          });
          this.stop();
        } else {
          events.push({ kind: "ring", index: this.nextRing, total: this.rings.length });
        }
      }
      // The next ring pulses; the ones behind you are dimmed by shrinking them
      // out of the way, which costs nothing and keeps the course readable from
      // inside it.
      for (let i = 0; i < this.rings.length; i++) {
        const ring = this.rings[i];
        const done = i < this.nextRing;
        const next = i === this.nextRing;
        const scale = done ? 0 : next ? 1 + Math.sin(elapsed * 4) * 0.05 : 0.86;
        this.v.set(ring.x, ring.y, ring.z);
        this.q.setFromEuler(new THREE.Euler(0, -ring.yaw, 0));
        this.s.set(scale, scale, scale);
        this.tmp.compose(this.v, this.q, this.s);
        this.ringMesh.setMatrixAt(i, this.tmp);
      }
      this.s.set(1, 1, 1);
      this.ringMesh.instanceMatrix.needsUpdate = true;
    }

    return events;
  }

  private persist(): void {
    save({ found: [...this.found], best: this.best });
  }

  snapshot(): PlaySnapshot {
    return {
      found: [...this.found],
      totalLandmarks: landmarkPositions().length,
      coins: this.got,
      totalCoins: this.coins.length,
      running: this.running,
      ring: this.nextRing,
      totalRings: this.rings.length,
      touched: this.touched.size,
      touchedKeys: [...this.touched],
      clock: this.running ? this.clock : 0,
      best: { ...this.best },
      nearest: this.nearest,
    };
  }

  dispose(): void {
    this.group.removeFromParent();
    this.coinGeo.dispose();
    this.ringGeo.dispose();
    this.coinMesh.dispose();
    this.ringMesh.dispose();
  }
}
