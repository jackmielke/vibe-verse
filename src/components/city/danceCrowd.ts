/**
 * danceCrowd — a room's worth of people who dance when you do.
 *
 * Lifted out of `danceFloor.ts` the moment there was a second venue, because
 * everything that makes a crowd read as people rather than as four loops is
 * fiddly and none of it should exist twice: the personal groove, the staggered
 * arrival, changing move every few bars, drifting on the spot, and turning to
 * watch whoever is dancing.
 *
 * The crowd owns no floor, no lights and no walls — it is a list of places to
 * stand and the behaviour of the people standing there. The plaza floor gives
 * it four spots around a square; the club gives it twenty around a room. That
 * is the whole difference.
 */
import * as THREE from "three";
import {
  DANCES,
  cityBeats,
  createDancePose,
  evalDanceGrooved,
  makeGroove,
  stepDanceWeight,
  type DanceDef,
  type DanceGroove,
  type DancePose,
} from "@/components/city/dances";
import { buildProceduralPilot, type ProceduralPilot } from "@/components/city/proceduralPilot";

export interface CrowdSpot {
  /** Where they stand, in the parent group's space. */
  x: number;
  z: number;
  y?: number;
  /** Which pilot design. */
  design: string;
  /** Which way they face before any glancing, in radians. */
  yaw?: number;
  /** Bars after the first dancer that this one joins in. */
  order?: number;
}

export interface DanceCrowdOpts {
  spots: CrowdSpot[];
  /** Restrict the moves this crowd picks from. Defaults to all of them. */
  dances?: readonly DanceDef[];
  /** Distinguishes one crowd's grooves from another's. */
  seed?: number;
  /** How far a dancer's feet wander from their spot, in metres. */
  sway?: number;
}

export interface DanceCrowd {
  group: THREE.Group;
  /**
   * `watch` is what the crowd turns to look at, in the group's space — pass
   * the player. `active` is whether anybody is dancing for them to join.
   *
   * Returns how many are dancing right now, which is what the music counts.
   */
  update(dt: number, watch: THREE.Vector3, active: boolean): number;
  /** Everyone, for anything that needs to place things around them. */
  size: number;
  dispose(): void;
}

/** Bars between one dancer joining and the next. */
export const JOIN_STAGGER_BARS = 1;
/** Roughly how long somebody sticks with one move before picking another. */
const SWITCH_BARS = 8;
/** How far a head will turn to watch somebody, in radians. */
const MAX_GLANCE = 1.1;

/**
 * Whether the dancer at `order` has joined, `barsIn` bars after the first.
 *
 * The stagger is what stops a room appearing to start dancing on the same
 * frame, which reads as a cutscene rather than as people noticing you. Bars
 * rather than seconds, so each arrival lands on a downbeat.
 */
export const crewHasJoined = (order: number, barsIn: number) =>
  barsIn >= order * JOIN_STAGGER_BARS;

interface Member {
  pilot: ProceduralPilot;
  dance: DanceDef;
  order: number;
  weight: number;
  dancing: boolean;
  groove: DanceGroove;
  home: THREE.Vector3;
  baseYaw: number;
  glance: number;
  switchedBar: number;
}

export function createDanceCrowd(opts: DanceCrowdOpts): DanceCrowd {
  const group = new THREE.Group();
  const pool = opts.dances ?? DANCES;
  const seed = opts.seed ?? 0;
  const sway = opts.sway ?? 0.16;

  const members: Member[] = opts.spots.map((spot, i) => {
    const pilot = buildProceduralPilot(undefined, spot.design);
    const home = new THREE.Vector3(spot.x, spot.y ?? 0, spot.z);
    pilot.group.position.copy(home);
    // Face the middle of the crowd unless told otherwise, plus a few degrees
    // of not-quite — a room of people squared to a common centre is furniture.
    const baseYaw = spot.yaw ?? Math.atan2(-home.x, -home.z);
    pilot.group.rotation.y = baseYaw;
    group.add(pilot.group);
    return {
      pilot,
      dance: pool[(i * 3 + 1) % pool.length],
      order: spot.order ?? i,
      weight: 0,
      dancing: false,
      groove: makeGroove(seed * 977 + i * 137 + 11),
      home,
      baseYaw,
      glance: 0,
      switchedBar: -999,
    };
  });

  const pose: DancePose = createDancePose();
  let startBar = 0;
  let wasActive = false;

  const update = (dt: number, watch: THREE.Vector3, active: boolean) => {
    const beats = cityBeats();
    const bar = Math.floor(beats / 4);
    const seconds = Date.now() / 1000;
    // The bar somebody first started is the anchor for the stagger, so the
    // second dancer comes in on a bar line rather than 1.7s after the first.
    if (active && !wasActive) startBar = bar;
    wasActive = active;

    let dancing = 0;
    for (const m of members) {
      m.dancing = active && crewHasJoined(m.order, bar - startBar);
      m.weight = stepDanceWeight(m.weight, m.dancing, dt);

      // Change it up. Nobody does one move for eleven minutes, and a crowd
      // that does is what gives away that it is a handful of loops. Each
      // dancer runs their own clock, so the room is always partway through
      // somebody changing their mind.
      if (m.dancing) {
        const period = SWITCH_BARS + (m.order % 5) * 3;
        if (bar - m.switchedBar >= period) {
          m.switchedBar = bar;
          m.dance = pool[Math.abs((bar * 7 + m.order * 31) | 0) % pool.length];
        }
      }

      // Where they are looking. People on a dance floor watch whoever is
      // dancing and turn their shoulders to do it; a crowd of heads locked
      // forward is the tell that they are props.
      let want = 0;
      if (active) {
        let d = Math.atan2(watch.x - m.home.x, watch.z - m.home.z) - m.baseYaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        want = Math.max(-MAX_GLANCE, Math.min(MAX_GLANCE, d));
      }
      m.glance += (want - m.glance) * Math.min(1, dt * 2.4);
      m.pilot.group.rotation.y = m.baseYaw + m.glance;

      // And they drift. A dancer bolted to one square metre reads as a statue
      // with moving parts; a few centimetres of wander, on a period that has
      // nothing to do with the beat, reads as somebody standing.
      const s = m.weight * sway;
      m.pilot.group.position.set(
        m.home.x + Math.sin(seconds * 0.31 + m.order * 2.1) * s,
        m.home.y,
        m.home.z + Math.sin(seconds * 0.23 + m.order * 4.7) * s,
      );

      if (m.weight > 0) {
        evalDanceGrooved(m.dance, pose, m.groove);
        dancing += m.dancing ? 1 : 0;
      }
      m.pilot.update(dt, {
        speed: 0,
        grounded: true,
        verticalVel: 0,
        yawRate: 0,
        thrusting: false,
        dance: m.weight > 0 ? { pose, weight: m.weight, lag: m.dance.lag } : null,
      });
    }
    return dancing;
  };

  /** Park everyone: used when the venue is too far away to be worth animating. */
  const rest = () => {
    wasActive = false;
    for (const m of members) {
      m.dancing = false;
      m.weight = 0;
    }
  };

  return {
    group,
    size: members.length,
    update(dt, watch, active) {
      if (!active && !wasActive) {
        // Still tick the rigs so they breathe and blink, but skip the rest.
        for (const m of members) {
          m.pilot.update(dt, {
            speed: 0,
            grounded: true,
            verticalVel: 0,
            yawRate: 0,
            thrusting: false,
          });
        }
        return 0;
      }
      return update(dt, watch, active);
    },
    dispose() {
      rest();
      for (const m of members) m.pilot.dispose();
    },
  };
}

/**
 * Places to stand around a rectangular floor, laid out like people rather than
 * like a grid.
 *
 * Rings rather than rows, with the ring radius and the angle both nudged per
 * dancer: real crowds are denser toward whatever they are facing and nobody
 * stands on a lattice point. Deterministic, so a room is the same room on
 * every visit.
 */
export function ringSpots(opts: {
  count: number;
  radius: number;
  designs: string[];
  /** Pull the crowd toward −Z (the stage end), 0 for an even ring. */
  stageBias?: number;
  /** Closest two dancers may stand, in metres. */
  minGap?: number;
  seed?: number;
}): CrowdSpot[] {
  const { count, radius, designs } = opts;
  const bias = opts.stageBias ?? 0;
  const minGap = opts.minGap ?? 1.5;
  const s0 = opts.seed ?? 0;
  const rnd = (n: number) => {
    const x = Math.sin((n + s0) * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  };

  /*
   * Candidates on a golden-angle spiral, then greedily rejected if they land
   * too near one already taken.
   *
   * The spiral alone is not enough, and it looks like it is: it spreads
   * points beautifully on a *disc of uniform density*, and this is not one —
   * the radius is squashed toward the stage and jittered per dancer, and two
   * of those nudges can cancel. The first version shipped two regulars 38
   * centimetres apart, standing inside one another, which no camera angle in
   * the shot harness happened to show. Rejection is four lines and removes
   * the whole class of it.
   */
  const spots: CrowdSpot[] = [];
  for (let i = 0; spots.length < count && i < count * 8; i++) {
    const a = i * 2.399963 + rnd(i) * 0.5;
    const r = radius * (0.35 + 0.65 * Math.sqrt((i + 0.6) / count)) * (0.85 + rnd(i + 99) * 0.3);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r - bias * r * 0.35;
    let clear = true;
    for (const other of spots) {
      if (Math.hypot(x - other.x, z - other.z) < minGap) {
        clear = false;
        break;
      }
    }
    if (!clear) continue;
    spots.push({
      x,
      z,
      design: designs[spots.length % designs.length],
      // Facing the stage, roughly, with a few degrees of not-quite.
      yaw: Math.atan2(-x, -(z + 6)) + (rnd(i + 7) - 0.5) * 0.7,
      order: spots.length % 6,
    });
  }
  return spots;
}
