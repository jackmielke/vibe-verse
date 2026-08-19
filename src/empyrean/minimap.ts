/**
 * The minimap.
 *
 * Drawn in 2D canvas from `cityplan.ts` rather than rendered from the scene:
 * the plan is already an exact description of every street and block, so a
 * second camera pointed at the world would be strictly worse — a whole extra
 * render pass to recover information we are holding in an array.
 *
 * **North up, whole island, always.** A rotating minimap is the right choice
 * for a city you can get lost in; this one is 680 m across and every street
 * points at the middle, so there is nothing to get lost in and rotation would
 * only cost you the ability to remember where things are. The island fits in
 * the dial at all times and the player is a triangle on it.
 *
 * The static half — streets, blocks, the rim — is rasterised once into an
 * offscreen canvas at build time and blitted every frame. The moving half is
 * a dozen shapes. That keeps the whole thing under a tenth of a millisecond,
 * which is the only reason it can run at all next to a world this size.
 */
import {
  cityPlan,
  DISTRICTS,
  HALO_R,
  LANE_A0,
  LANE_N,
  RIM_R,
  RING_R,
  W,
  AVENUE_A0,
  AVENUE_N,
} from "./cityplan";
import { DECKS, PLATEAU_R } from "./config";

const TAU = Math.PI * 2;

/** A thing to draw on top: a waypoint, a race ring, a parcel. */
export interface MapMark {
  x: number;
  z: number;
  kind: "waypoint" | "ring" | "landmark" | "find" | "tram";
  /** Drawn larger and with a ring around it. */
  active?: boolean;
  label?: string;
}

export interface Minimap {
  /** Radius of the island in map pixels, for anything drawing over the top. */
  readonly scale: number;
  draw(
    playerX: number,
    playerZ: number,
    playerYaw: number,
    playerY: number,
    marks: readonly MapMark[],
  ): void;
  dispose(): void;
}

/** Everything outside the island's outer promenade, in world metres. */
const WORLD_EXTENT = DECKS[DECKS.length - 1].outer + 14;

export function buildMinimap(canvas: HTMLCanvasElement, sizeCss: number): Minimap | null {
  const dpr = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2);
  const size = Math.round(sizeCss * dpr);
  canvas.width = size;
  canvas.height = size;
  canvas.style.width = `${sizeCss}px`;
  canvas.style.height = `${sizeCss}px`;
  const g = canvas.getContext("2d");
  if (!g) return null;

  const scale = size / 2 / WORLD_EXTENT;
  const cx = size / 2;
  const cy = size / 2;
  const px = (x: number) => cx + x * scale;
  const py = (z: number) => cy + z * scale;

  /* ---- the static plate ------------------------------------------------ */
  const plate = document.createElement("canvas");
  plate.width = size;
  plate.height = size;
  const p = plate.getContext("2d");

  if (p) {
    const plan = cityPlan();

    // The island itself: the promenade rings first, then the deck.
    for (let i = DECKS.length - 1; i >= 0; i--) {
      p.beginPath();
      p.arc(cx, cy, DECKS[i].outer * scale, 0, TAU);
      p.fillStyle = i === 0 ? "rgba(38,26,44,0.94)" : `rgba(26,18,32,${0.5 + i * 0.06})`;
      p.fill();
    }

    // District tints, outermost first so the inner ones land on top.
    for (let i = DISTRICTS.length - 1; i >= 0; i--) {
      const d = DISTRICTS[i];
      p.beginPath();
      p.arc(cx, cy, d.r1 * scale, 0, TAU);
      p.fillStyle = `${d.accent}14`;
      p.fill();
    }

    // Blocks. Drawn as filled polygons so the streets read as the gaps
    // between them, which is how a real map reads and is one draw either way.
    p.fillStyle = "rgba(150,160,190,0.30)";
    for (const lot of plan.lots) {
      p.beginPath();
      p.moveTo(px(lot.poly[0].x), py(lot.poly[0].z));
      for (let i = 1; i < lot.poly.length; i++) p.lineTo(px(lot.poly[i].x), py(lot.poly[i].z));
      p.closePath();
      p.fill();
    }

    // Streets, over the top, so junctions are clean.
    p.lineCap = "round";
    const stroke = (widthM: number, alpha: number) => {
      p.strokeStyle = `rgba(255,236,214,${alpha})`;
      p.lineWidth = Math.max(1, widthM * 2 * scale);
    };

    stroke(W.ring.half, 0.5);
    for (const r of RING_R) {
      p.beginPath();
      p.arc(cx, cy, r * scale, 0, TAU);
      p.stroke();
    }
    stroke(W.rim.half, 0.4);
    p.beginPath();
    p.arc(cx, cy, RIM_R * scale, 0, TAU);
    p.stroke();

    stroke(W.avenue.half, 0.55);
    for (let i = 0; i < AVENUE_N; i++) {
      const a = AVENUE_A0 + (i / AVENUE_N) * TAU;
      p.beginPath();
      p.moveTo(px(Math.cos(a) * HALO_R), py(Math.sin(a) * HALO_R));
      p.lineTo(px(Math.cos(a) * RIM_R), py(Math.sin(a) * RIM_R));
      p.stroke();
    }
    stroke(W.lane.half, 0.34);
    for (let i = 0; i < LANE_N; i++) {
      const a = LANE_A0 + (i / LANE_N) * TAU;
      p.beginPath();
      p.moveTo(px(Math.cos(a) * RING_R[0]), py(Math.sin(a) * RING_R[0]));
      p.lineTo(px(Math.cos(a) * RIM_R), py(Math.sin(a) * RIM_R));
      p.stroke();
    }

    // The Halo.
    p.beginPath();
    p.arc(cx, cy, HALO_R * scale, 0, TAU);
    p.fillStyle = "rgba(255,214,150,0.20)";
    p.fill();
    p.strokeStyle = "rgba(255,214,150,0.55)";
    p.lineWidth = 1.2 * dpr;
    p.stroke();

    // The parapet.
    p.beginPath();
    p.arc(cx, cy, PLATEAU_R * scale, 0, TAU);
    p.strokeStyle = "rgba(255,255,255,0.22)";
    p.lineWidth = 1.4 * dpr;
    p.stroke();
  }

  /* ---- the moving half ------------------------------------------------- */
  const MARK_COLOUR: Record<MapMark["kind"], string> = {
    waypoint: "#ffd166",
    ring: "#7ff0ff",
    landmark: "#ffffff",
    find: "#b8ff9c",
    tram: "#ff9ec4",
  };

  return {
    scale: PLATEAU_R * scale,
    draw(playerX, playerZ, playerYaw, playerY, marks) {
      g.clearRect(0, 0, size, size);
      g.drawImage(plate, 0, 0);

      // Landmarks, always.
      const plan = cityPlan();
      g.font = `${9 * dpr}px ui-sans-serif, system-ui, sans-serif`;
      g.textAlign = "center";
      for (const l of plan.landmarks) {
        g.beginPath();
        g.arc(px(l.x), py(l.z), 2.4 * dpr, 0, TAU);
        g.fillStyle = "rgba(255,255,255,0.8)";
        g.fill();
      }

      for (const m of marks) {
        const mx = px(m.x);
        const my = py(m.z);
        const col = MARK_COLOUR[m.kind];
        if (m.active) {
          g.beginPath();
          g.arc(mx, my, 6.5 * dpr, 0, TAU);
          g.strokeStyle = col;
          g.lineWidth = 1.5 * dpr;
          g.stroke();
        }
        g.beginPath();
        g.arc(mx, my, (m.active ? 3.4 : 2.4) * dpr, 0, TAU);
        g.fillStyle = col;
        g.fill();
      }

      /* The player. A triangle, because a dot cannot tell you which way you
       * are facing and on a radial plan that is the only thing you need. */
      const ax = px(playerX);
      const ay = py(playerZ);
      // Screen -Z is forward at yaw 0, and the map's +Y is world +Z.
      const dir = playerYaw + Math.PI;
      g.save();
      g.translate(ax, ay);
      g.rotate(-dir);
      g.beginPath();
      g.moveTo(0, -6 * dpr);
      g.lineTo(4.2 * dpr, 5 * dpr);
      g.lineTo(0, 2.6 * dpr);
      g.lineTo(-4.2 * dpr, 5 * dpr);
      g.closePath();
      g.fillStyle = "#ffffff";
      g.fill();
      g.strokeStyle = "rgba(0,0,0,0.55)";
      g.lineWidth = 1 * dpr;
      g.stroke();
      g.restore();

      /* Off the island? Draw the player clamped to the edge with a halo, and
       * a height readout — flying under the keel is a place you can be, and a
       * map that says "you are nowhere" there is a map that has given up. */
      const r = Math.hypot(playerX, playerZ);
      if (r > WORLD_EXTENT) {
        const k = WORLD_EXTENT / r;
        g.beginPath();
        g.arc(px(playerX * k), py(playerZ * k), 5 * dpr, 0, TAU);
        g.strokeStyle = "rgba(255,255,255,0.8)";
        g.lineWidth = 1.4 * dpr;
        g.stroke();
      }
      if (playerY < DECKS[DECKS.length - 1].y - 10) {
        g.fillStyle = "rgba(255,255,255,0.65)";
        g.textAlign = "center";
        g.fillText("below the deck", cx, size - 6 * dpr);
      }
    },
    dispose() {
      plate.width = 0;
      plate.height = 0;
    },
  };
}
