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
import { COLORS, flat, toon } from "./look";
import {
  BOUNDS,
  MARKET_DIR,
  isOpen,
  isWater,
  landmarkPositions,
  walkHeight,
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
  | { kind: "course"; seconds: number; best: number; record: boolean }
  | { kind: "course-start" };

export interface PlaySnapshot {
  /** Landmark keys found, ever. */
  found: string[];
  totalLandmarks: number;
  coins: number;
  totalCoins: number;
  /** Which ring of the course is next, or -1 when the course is not running. */
  ring: number;
  totalRings: number;
  /** Seconds into the current run, or 0. */
  clock: number;
  bestCourse: number | null;
  /** The nearest landmark, for the compass line in the HUD. */
  nearest: { name: string; metres: number; found: boolean } | null;
}

interface Stored {
  found?: string[];
  bestCourse?: number;
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
 * The course: fourteen rings from the Ferry Building up Market Street and over
 * Nob Hill.
 *
 * It follows a real street on purpose. A ring course laid out in open air is a
 * slalom that could be anywhere; one that runs up Market makes you fly the
 * city — down a canyon, over the top of Union Square, up the hill — and you
 * come out of it knowing where things are.
 */
function placeRings(): Ring[] {
  const out: Ring[] = [];
  const N = 14;
  const yaw = Math.atan2(MARKET_DIR.z, MARKET_DIR.x);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    // From the foot of Market (behind the origin) up past Twin Peaks way.
    const along = -420 + t * 2000;
    const x = MARKET_DIR.x * along;
    const z = MARKET_DIR.z * along;
    /* Weave and climb — but the weave stays inside Market's own half-width.
       It was 34 m, which is twice the street, so half the course was buried
       inside the buildings on either side: you could see the ring through a
       wall and there was no way to fly to it. A course you cannot complete is
       worse than no course, and it is invisible from outside the canyon. */
    const side = Math.sin(t * Math.PI * 2.6) * 11;
    const px = x - MARKET_DIR.z * side;
    const pz = z + MARKET_DIR.x * side;
    const ground = walkHeight(px, pz);
    const lift = 34 + Math.sin(t * Math.PI * 1.7) * 30;
    out.push({ x: px, y: ground + lift, z: pz, yaw, r: 11 });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The playground
 * ------------------------------------------------------------------ */

export class Playground {
  readonly group = new THREE.Group();

  private coins: Coin[];
  private rings: Ring[];
  private coinMesh: THREE.InstancedMesh;
  private ringMesh: THREE.InstancedMesh;
  private coinGeo: THREE.BufferGeometry;
  private ringGeo: THREE.BufferGeometry;
  private found: Set<string>;
  private bestCourse: number | null;
  private got = 0;
  private nextRing = -1;
  private clock = 0;
  private nearest: PlaySnapshot["nearest"] = null;
  private tmp = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);

  constructor(colliders: BuildingBox[]) {
    this.group.name = "frisco-play";
    const stored = load();
    this.found = new Set(stored.found ?? []);
    this.bestCourse = stored.bestCourse ?? null;

    this.coins = placeCoins(colliders);
    this.rings = placeRings();

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
    this.ringMesh = new THREE.InstancedMesh(this.ringGeo, flat(0x35f0d0), this.rings.length);
    this.ringMesh.name = "frisco-rings";
    this.ringMesh.frustumCulled = false;
    this.ringMesh.visible = false;
    this.group.add(this.ringMesh);

    this.layoutRings();
  }

  private layoutRings(): void {
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i];
      this.v.set(r.x, r.y, r.z);
      this.q.setFromEuler(new THREE.Euler(0, -r.yaw, 0));
      this.tmp.compose(this.v, this.q, this.s);
      this.ringMesh.setMatrixAt(i, this.tmp);
    }
    this.ringMesh.instanceMatrix.needsUpdate = true;
  }

  /** Start the Market Street course from the beginning. */
  startCourse(): PlayEvent[] {
    this.nextRing = 0;
    this.clock = 0;
    this.ringMesh.visible = true;
    return [{ kind: "course-start" }];
  }

  /** Abandon a run. The rings go away and nothing is recorded. */
  stopCourse(): void {
    this.nextRing = -1;
    this.clock = 0;
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
      if (this.found.has(m.key)) continue;
      this.found.add(m.key);
      save({ found: [...this.found], bestCourse: this.bestCourse ?? undefined });
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

    /* ---- the course ---- */
    if (this.nextRing >= 0) {
      this.clock += dt;
      const r = this.rings[this.nextRing];
      const d = Math.hypot(player.x - r.x, player.y - r.y, player.z - r.z);
      if (d < r.r) {
        this.nextRing++;
        if (this.nextRing >= this.rings.length) {
          const seconds = this.clock;
          const record = this.bestCourse === null || seconds < this.bestCourse;
          if (record) {
            this.bestCourse = seconds;
            save({ found: [...this.found], bestCourse: seconds });
          }
          events.push({
            kind: "course",
            seconds,
            best: this.bestCourse ?? seconds,
            record,
          });
          this.stopCourse();
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

  snapshot(): PlaySnapshot {
    return {
      found: [...this.found],
      totalLandmarks: landmarkPositions().length,
      coins: this.got,
      totalCoins: this.coins.length,
      ring: this.nextRing,
      totalRings: this.rings.length,
      clock: this.nextRing >= 0 ? this.clock : 0,
      bestCourse: this.bestCourse,
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
