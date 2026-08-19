/**
 * THE PHOTO HUNT — eight places to stand and eight things to look at.
 *
 * Every one is written as a sentence first and coordinates second, because the
 * whole activity is the gap between the two: "under the rim on the sunrise
 * side, looking back up into the rock" is a place you have to *find*, and a
 * map pin is a place you have to fly to. The pillar of light only appears once
 * you are within a few hundred metres, so the first half of every shot is read
 * off the description and the second half is fiddling with the camera.
 *
 * ## What is actually tested
 *
 * Position against `ctx.player.position` — where you are *standing* — and aim
 * against the camera's forward vector. That split matters in a third-person
 * world: the camera hangs thirteen metres behind the body and putting *it* on
 * the mark would mean flying past the spot and looking backwards. So: stand
 * here, look at that, exactly as the description says.
 *
 * ## Where the eight came from
 *
 * The rim road looking up an avenue; the sunset itself, from the one altitude
 * over the Bazaar where the Beacon just clears the frame; the underside of the
 * island; the ice, from far enough out that the whole rock fits; the
 * promenade directly under the Observatory; the top of the Beacon looking
 * straight down; the Market Hall from the ring road above it; and the great
 * stalactite, from a hundred metres over the lake. Between them they cover
 * every deck of the place and both sides of the light.
 */
import * as THREE from "three";
import type { FrameContext } from "../types";
import { ISLAND_Y, WATER_Y } from "../config";
import { LANDMARKS } from "../cityplan";
import { SUN_DIR } from "../sky";
import {
  buildPhotoFrame,
  buildPillar,
  clamp,
  DEG,
  formatDist,
  readStore,
  writeStore,
  type PhotoFrame,
  type Pillar,
} from "./common";

export const PHOTO_KEY = "empyrean.album.v1";

export interface Shot {
  id: string;
  title: string;
  /** The whole puzzle, in one sentence. */
  hint: string;
  /** Where the body must be. */
  at: { x: number; y: number; z: number };
  /** What the lens must be pointed at. */
  look: { x: number; y: number; z: number };
  /** Slack on the position, metres. */
  near: number;
  /** Slack on the aim, degrees. */
  arc: number;
  /** Coins, the first time. */
  pay: number;
}

const P = (r: number, aDeg: number, y: number) => ({
  x: Math.cos(aDeg * DEG) * r,
  y,
  z: Math.sin(aDeg * DEG) * r,
});

const marketHall = LANDMARKS.find((l) => l.id === "market-hall")!;
const observatory = LANDMARKS.find((l) => l.id === "observatory")!;

/** Eighty metres of sun, from wherever you happen to be standing. */
function towardSun(from: { x: number; y: number; z: number }) {
  return {
    x: from.x + SUN_DIR.x * 800,
    y: from.y + SUN_DIR.y * 800,
    z: from.z + SUN_DIR.z * 800,
  };
}

const spiresView = P(170, 60, 700);

export const SHOTS: Shot[] = [
  {
    id: "avenue",
    title: "The Long Avenue",
    hint: "Stand in the rim road where the western avenue meets it, and look all the way up the street at the Beacon.",
    at: P(316, 180, ISLAND_Y),
    look: { x: 0, y: ISLAND_Y + 180, z: 0 },
    near: 18,
    arc: 24,
    pay: 14,
  },
  {
    id: "spires",
    title: "Sunset in the Spires",
    hint: "Eighty metres over the Bazaar, on the far side from the sun, looking straight into it with the Beacon at the edge of frame.",
    at: spiresView,
    look: towardSun(spiresView),
    near: 24,
    arc: 20,
    pay: 16,
  },
  {
    id: "underside",
    title: "The Underside",
    hint: "Out past the terraces on the sunrise side and two hundred metres down, looking back up into the rock.",
    at: P(380, 45, 430),
    look: { x: 0, y: 560, z: 0 },
    near: 28,
    arc: 26,
    pay: 16,
  },
  {
    id: "ice",
    title: "From the Ice",
    hint: "Walk out onto the frozen lake, most of a kilometre from the axis, and look up at the whole island.",
    at: P(900, 110, WATER_Y),
    look: { x: 0, y: 300, z: 0 },
    near: 34,
    arc: 22,
    pay: 14,
  },
  {
    id: "rail",
    title: "Under the Observatory",
    hint: "The first promenade ring, directly below the Observatory, looking back up at its telescope.",
    at: P(353, -90, 598),
    look: { x: observatory.x, y: ISLAND_Y + 26, z: observatory.z },
    near: 15,
    arc: 28,
    pay: 14,
  },
  {
    id: "crown",
    title: "Above the Crown",
    hint: "Higher than the Beacon. Look straight down the axis at the Halo.",
    at: P(60, 200, 1180),
    look: { x: 0, y: ISLAND_Y, z: 0 },
    near: 32,
    arc: 26,
    pay: 18,
  },
  {
    id: "market",
    title: "The Market's Glass",
    hint: "Where the north-west avenue crosses the middle ring road, looking down the hill at the Market Hall's roof.",
    at: P(218, 135, ISLAND_Y),
    look: { x: marketHall.x, y: ISLAND_Y + 16, z: marketHall.z },
    near: 16,
    arc: 22,
    pay: 14,
  },
  {
    id: "tooth",
    title: "The Great Tooth",
    hint: "A hundred metres over the ice, in under the keel, beside the longest stalactite of the lot. Look up it.",
    at: P(110, 20, 120),
    look: { x: 0, y: 330, z: 0 },
    near: 28,
    arc: 26,
    pay: 18,
  },
];

export type Album = Record<string, { at: number }>;

export function readAlbum(): Album {
  return readStore<Album>(PHOTO_KEY, {});
}

/* -------------------------------------------------------------------------
 * The runner
 * ---------------------------------------------------------------------- */

export interface PhotoHooks {
  toast(text: string, tone?: "info" | "good" | "warn", ttl?: number): void;
  pay(coins: number): void;
  ended(): void;
  chime(freq: number, dur?: number, gain?: number): void;
}

export interface PhotoRunner {
  group: THREE.Object3D;
  start(time: number): boolean;
  abort(reason: "recall" | "player"): void;
  running(): boolean;
  update(ctx: FrameContext): void;
  view(): { title: string; lines: string[]; progress?: number } | null;
  taken(): number;
  dispose(): void;
}

/** How long you have to hold the shot before the shutter goes. */
const HOLD = 0.45;

export function buildPhotoHunt(hooks: PhotoHooks): PhotoRunner {
  const group = new THREE.Group();
  group.name = "empyrean-photo";
  group.visible = false;

  const pillar: Pillar = buildPillar();
  const frame: PhotoFrame = buildPhotoFrame();
  group.add(pillar.object, frame.object);

  const at = new THREE.Vector3();
  const look = new THREE.Vector3();
  const want = new THREE.Vector3();
  const fwd = new THREE.Vector3();

  let album: Album = readAlbum();
  let active = false;
  let target: Shot | null = null;
  let hold = 0;
  let aimed = 0;
  let dist = 0;

  function remaining(): number {
    let n = 0;
    for (const s of SHOTS) if (!album[s.id]) n++;
    return n;
  }

  function retarget(px: number, py: number, pz: number): void {
    let best: Shot | null = null;
    let bestD = Infinity;
    for (const s of SHOTS) {
      if (album[s.id]) continue;
      const d = Math.hypot(s.at.x - px, s.at.y - py, s.at.z - pz);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (best === target) return;
    target = best;
    if (!target) {
      pillar.hide();
      frame.hide();
      return;
    }
    at.set(target.at.x, target.at.y, target.at.z);
    look.set(target.look.x, target.look.y, target.look.z);
    pillar.set(at.x, at.y, at.z, 0xbfe6ff);
    frame.place(at, look);
  }

  function capture(shot: Shot): void {
    const first = !album[shot.id];
    const coins = first ? shot.pay : 3;
    album = { ...album, [shot.id]: { at: Date.now() } };
    writeStore(PHOTO_KEY, album);
    hooks.pay(coins);
    hooks.toast(`“${shot.title}” — in the album · +${coins} ✦`, "good", 4.5);
    hooks.chime(1046, 0.4, 0.05);
    hold = 0;
    if (remaining() === 0) {
      hooks.toast("Every viewpoint found. The album is full.", "good", 6);
      active = false;
      group.visible = false;
      pillar.hide();
      frame.hide();
      hooks.ended();
      return;
    }
    // Cleared, not chosen: the next frame picks whichever is now nearest.
    target = null;
  }

  return {
    group,

    start() {
      album = readAlbum();
      if (remaining() === 0) {
        hooks.toast("The album is already full — every viewpoint found.", "info", 4);
        return false;
      }
      active = true;
      group.visible = true;
      target = null;
      hold = 0;
      hooks.toast(`Photo hunt — ${remaining()} viewpoints left to find`, "info", 5);
      return true;
    },

    abort(reason) {
      if (!active) return;
      active = false;
      group.visible = false;
      pillar.hide();
      frame.hide();
      hooks.toast(
        reason === "recall" ? "Camera put away" : "Camera back in the bag",
        "info",
      );
      hooks.ended();
    },

    running() {
      return active;
    },

    taken() {
      let n = 0;
      for (const s of SHOTS) if (album[s.id]) n++;
      return n;
    },

    update(ctx) {
      pillar.update(ctx.time);
      if (!active) return;
      const p = ctx.player.position;
      retarget(p.x, p.y, p.z);
      if (!target) return;

      dist = Math.hypot(target.at.x - p.x, target.at.y - p.y, target.at.z - p.z);
      // The pillar is a reward for getting warm, not a map pin: it lights when
      // you are inside four hundred metres and not before.
      if (dist < 420) pillar.set(at.x, at.y, at.z, 0xbfe6ff);
      else pillar.hide();

      ctx.camera.getWorldDirection(fwd);
      want.copy(look).sub(at).normalize();
      aimed = fwd.dot(want);
      const arc = Math.cos(target.arc * DEG);
      frame.setAligned((aimed - arc) / (1 - arc));

      if (dist <= target.near && aimed >= arc) {
        hold += ctx.dt;
        if (hold >= HOLD) capture(target);
      } else {
        hold = Math.max(0, hold - ctx.dt * 2);
      }
    },

    view() {
      if (!active) return null;
      const done = SHOTS.length - remaining();
      if (!target) {
        /* The first frame after starting, and the frame after a capture: the
         * hunt is live but has not chosen its next subject yet. Returning null
         * here would blink the whole panel out of the HUD and back in. */
        return {
          title: "Photo hunt",
          lines: [
            "Looking for the nearest viewpoint…",
            "",
            `${done} of ${SHOTS.length} in the album`,
          ],
          progress: done / SHOTS.length,
        };
      }
      return {
        title: `Photo hunt · ${target.title}`,
        // Fresh, not rewritten in place — see the note in `races.ts`.
        lines: [
          target.hint,
          dist > target.near
            ? `${formatDist(dist)} away`
            : aimed >= Math.cos(target.arc * DEG)
              ? "Hold it…"
              : "You are on the spot — now find the angle",
          `${done} of ${SHOTS.length} in the album`,
        ],
        progress: clamp(done / SHOTS.length, 0, 1),
      };
    },

    dispose() {
      pillar.dispose();
      frame.dispose();
      group.clear();
    },
  };
}
