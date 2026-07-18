/**
 * liveDirector — the AI camera director behind /live.
 *
 * The world becomes television that directs itself: in idle moments the
 * camera drifts between beauty shots (the plaza, the wall, the newsstand)
 * and slow orbits of whichever residents are around; when something
 * happens on the event stream — a walk-up, a dance, fresh graffiti —
 * it cuts there. The "camera" is the city's invisible player anchor plus
 * the chase-cam's yaw/pitch/dist, so every shot is a real in-world shot.
 */
import type { WorldEventRow } from "./worldEventFeed";

interface Cast {
  key: string;
  agentId: string | null;
  name: string;
  x: number;
  y: number;
  z: number;
}

interface Shot {
  x: number;
  y: number;
  z: number;
  dist: number;
  pitch: number;
  yaw: number;
  panSpeed: number; // radians/sec — slow drift
  dur: number;      // seconds
  label?: string;
}

export interface LiveDirector {
  /** Feed a world event; cut-worthy kinds preempt the current shot. */
  notify: (ev: WorldEventRow) => void;
  dispose: () => void;
}

const CUT_KINDS = new Set(["proximity", "emote", "graffiti", "enter", "mention"]);

export function createLiveDirector(deps: {
  moveTo: (x: number, y: number, z: number) => void;
  aim: (yaw: number, pitch?: number, dist?: number) => void;
  cast: () => Cast[];
  /** Static points of interest: [x, y, z, label]. */
  pois: Array<[number, number, number, string]>;
  onShot?: (label: string) => void;
}): LiveDirector {
  let current: Shot | null = null;
  let t = 0;
  let queue: Shot[] = [];
  let shotCount = 0;

  const agentShot = (a: Cast, opts?: Partial<Shot>): Shot => ({
    x: a.x, y: a.y + 0.5, z: a.z,
    dist: 7 + Math.random() * 4,
    pitch: 0.18 + Math.random() * 0.15,
    yaw: Math.random() * Math.PI * 2,
    panSpeed: (Math.random() < 0.5 ? -1 : 1) * (0.05 + Math.random() * 0.05),
    dur: 10 + Math.random() * 6,
    label: a.name,
    ...opts,
  });

  const poiShot = ([x, y, z, label]: [number, number, number, string]): Shot => ({
    x, y: y + 0.5, z,
    dist: 12 + Math.random() * 10,
    pitch: 0.25 + Math.random() * 0.2,
    yaw: Math.random() * Math.PI * 2,
    panSpeed: (Math.random() < 0.5 ? -1 : 1) * (0.04 + Math.random() * 0.04),
    dur: 12 + Math.random() * 8,
    label,
  });

  const nextIdleShot = (): Shot => {
    const cast = deps.cast();
    // Every ~5th shot is a wide establishing shot of a POI; otherwise
    // follow the residents (they're the show).
    if (cast.length && shotCount % 5 !== 0) {
      const a = cast[Math.floor(Math.random() * cast.length)];
      return agentShot(a);
    }
    const poi = deps.pois[Math.floor(Math.random() * deps.pois.length)];
    return poiShot(poi);
  };

  const startShot = (shot: Shot) => {
    current = shot;
    t = 0;
    shotCount++;
    deps.moveTo(shot.x, shot.y, shot.z);
    deps.aim(shot.yaw, shot.pitch, shot.dist);
    if (shot.label) deps.onShot?.(shot.label);
  };

  const TICK_S = 0.2;
  const interval = window.setInterval(() => {
    if (!current) {
      startShot(queue.shift() ?? nextIdleShot());
      return;
    }
    t += TICK_S;
    current.yaw += current.panSpeed * TICK_S;
    deps.aim(current.yaw, current.pitch, current.dist);
    if (t >= current.dur) {
      current = null;
    }
  }, TICK_S * 1000);

  return {
    notify(ev) {
      if (!CUT_KINDS.has(ev.kind)) return;
      const cast = deps.cast();
      const wanted = ev.target_key ?? ev.actor_key;
      const wantedName = (ev.target_name ?? ev.actor_name ?? "").toLowerCase();
      const subject =
        cast.find((a) => wanted && (a.key === wanted || a.agentId === wanted)) ??
        cast.find((a) => wantedName && a.name.toLowerCase() === wantedName);
      if (!subject) return;
      // Cut: closer, snappier shot of the subject. Preempts current.
      const shot = agentShot(subject, {
        dist: 5.5 + Math.random() * 2,
        pitch: 0.14 + Math.random() * 0.1,
        dur: 8,
      });
      queue = [shot];
      current = null; // next tick cuts immediately
    },
    dispose() {
      window.clearInterval(interval);
    },
  };
}
