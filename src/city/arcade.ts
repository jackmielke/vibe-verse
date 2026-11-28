/**
 * arcade — the Vibe Arcade, a building on the block just east of the plaza
 * (cell 5,4) that you walk into as yourself and play the Vibe Verse's
 * table games in.
 *
 * Every game in here is a real station with a real thing to walk up to: a
 * pool table for the 8-Ball Club, a basketball machine for Vibe Hoops, a
 * foosball table for Vibe Cup, a card table for Solitaire, and upright
 * cabinets for the arcade games. Press E (or tap the pill) at one and the
 * camera dives into its screen, then the game itself opens over the city in
 * a cabinet frame (see `src/components/city/ArcadeCabinet.tsx`), the same
 * route that is on the front page, so there is one copy of each game and the
 * arcade never goes stale.
 *
 * The room is a late-night synthwave arcade, and all of it is cheap on
 * purpose, because it has to run on a phone:
 *
 *  - No real lights. Every glow is an unlit or additive surface; a
 *    PointLight would change the light count of every material in the city
 *    and recompile all of them.
 *  - The "wet" floor is a glossy tile with emissive grid lines plus additive
 *    smears of colour laid on it under each sign. It reads as a reflection
 *    and costs one quad each.
 *  - Living screens: each station's screen plays its game's filmed card clip
 *    (`src/assets/worlds/<key>.mp4`), or pans its still, but only the few
 *    nearest screens play at once, and none play unless you are inside.
 *  - The beat (`src/arcade/music.ts`) is the room's clock: the ceiling tubes,
 *    the floor grid, the beams and the dance floor all pulse on it.
 *
 * The high score wall above the cabinets is drawn from `src/arcade/board.ts`,
 * and the prize shelf behind the counter fills with what this device has won
 * (`src/arcade/tickets.ts`).
 *
 * Built in world space, +Y up, like `hideouts.ts`: walls are separate
 * collision boxes with a doorway left out, so you can walk (or drive) in.
 * The door is on the west side, facing the plaza.
 */
import * as THREE from "three";
import type { WorldBox } from "@/components/city/cardboardIsland";
import { FILMED } from "@/worlds/motion";
import { artFor } from "@/worlds/art";
import { ARCADE_GAMES, formatScore } from "@/arcade/games";
import type { Board } from "@/arcade/board";
import { PRIZES } from "@/arcade/tickets";
import { questHat } from "@/city/quests/hats";
import { createArcadeMusic, type ArcadeMusic } from "@/arcade/music";
import { createAvatar, type Avatar } from "@/oni/world/avatars";

/** World centre of the arcade's block: cell (5,4) with a 40 m pitch. */
export const ARCADE_AT: [number, number] = [40, 0];
/** The block `buildDistrict({ reserve })` leaves empty for it. */
export const ARCADE_RESERVE = { gx: 5, gz: 4, ground: "pave" as const, trees: false };

export interface ArcadeStation {
  key: string;
  /** What the pill says: "Play 8-Ball Club". */
  title: string;
  emoji: string;
  /** The game's own route, framed by the cabinet. */
  route: string;
  /** Neon colour for the cabinet frame. */
  accent: string;
  /** The thing you walk up to. */
  at: THREE.Vector3;
  /** How close counts as "at it", metres, measured on the ground. */
  reach: number;
  /** A game opens a cabinet; the prize counter opens the counter. */
  kind: "game" | "prizes";
}

export interface CameraShot {
  eye: THREE.Vector3;
  look: THREE.Vector3;
  fov: number;
}

export interface Arcade {
  group: THREE.Group;
  boxes: WorldBox[];
  stations: ArcadeStation[];
  /** Just inside the door, for "take me to the arcade". */
  entrance: THREE.Vector3;
  music: ArcadeMusic;
  /** Inside the hall, where the chase camera must come in close. */
  contains(p: THREE.Vector3): boolean;
  /** The station within reach of the player, or null. */
  nearest(p: THREE.Vector3): ArcadeStation | null;
  /** Fly the camera into a station's screen; `done` runs once it is there. */
  dive(st: ArcadeStation, camera: THREE.PerspectiveCamera, done: () => void): void;
  /** Let go of the camera (the cabinet closed). */
  endDive(): void;
  /** While diving, the camera's pose; otherwise null. */
  cameraShot(now: number): CameraShot | null;
  setBoard(b: Board): void;
  setPrizes(owned: string[]): void;
  update(dt: number, now: number, player: THREE.Vector3): void;
  dispose(): void;
}

const HX = 12.5;
const HZ = 12.5;
const H = 8.5;
const T = 0.4;
const DOOR = 3.2; // half width
const DOOR_H = 4.6;

/** Which card clip or still a station's screen shows. */
const ART_KEY: Record<string, string> = {
  pool: "pool", hoops: "hoops", vibecup: "vibe-cup", solitaire: "solitaire",
  mortmaze: "mort-maze", boxing: "boxing", "2048": "2048", coil: "coil",
};

function canvasTex(w: number, h: number, draw: (x: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d")!;
  draw(x);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** A neon word: glowing coloured strokes on black. */
function neonTex(text: string, color: string, w = 1024, h = 256, bg = "#07040f"): THREE.CanvasTexture {
  return canvasTex(w, h, (x) => {
    if (bg) {
      x.fillStyle = bg;
      x.fillRect(0, 0, w, h);
    }
    let size = Math.round(h * 0.6);
    x.font = `900 ${size}px system-ui, sans-serif`;
    while (size > 12 && x.measureText(text).width > w * 0.9) {
      size -= 4;
      x.font = `900 ${size}px system-ui, sans-serif`;
    }
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.shadowColor = color;
    for (const blur of [h * 0.35, h * 0.18, h * 0.06]) {
      x.shadowBlur = blur;
      x.strokeStyle = color;
      x.lineWidth = h * 0.05;
      x.strokeText(text, w / 2, h / 2 + h * 0.03);
    }
    x.shadowBlur = h * 0.05;
    x.fillStyle = "#ffffff";
    x.fillText(text, w / 2, h / 2 + h * 0.03);
  });
}

/** A cabinet's attract screen: the game's name and emoji over a grid. Shown until its clip arrives. */
function screenTex(title: string, emoji: string, color: string): THREE.CanvasTexture {
  const w = 320;
  const h = 240;
  return canvasTex(w, h, (x) => {
    const g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#120a2a");
    g.addColorStop(1, "#04020a");
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
    x.strokeStyle = color;
    x.globalAlpha = 0.35;
    x.lineWidth = 2;
    for (let i = 0; i <= 10; i++) {
      const y = h * 0.62 + i * i * 1.0;
      x.beginPath();
      x.moveTo(0, y);
      x.lineTo(w, y);
      x.stroke();
    }
    for (let i = -6; i <= 6; i++) {
      x.beginPath();
      x.moveTo(w / 2 + i * 8, h * 0.62);
      x.lineTo(w / 2 + i * 60, h);
      x.stroke();
    }
    x.globalAlpha = 1;
    x.font = "80px system-ui, sans-serif";
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillText(emoji, w / 2, h * 0.3);
    x.font = "900 28px system-ui, sans-serif";
    x.shadowColor = color;
    x.shadowBlur = 14;
    x.fillStyle = "#ffffff";
    x.fillText(title.toUpperCase(), w / 2, h * 0.64);
    x.font = "700 16px system-ui, sans-serif";
    x.fillStyle = color;
    x.fillText("INSERT COIN", w / 2, h * 0.86);
  });
}

/** The floor: black glass tiles, and the glowing grid that is only in the emissive map. */
function floorTex(glow: boolean): THREE.CanvasTexture {
  const S = 512;
  const t = canvasTex(S, S, (x) => {
    x.fillStyle = glow ? "#000000" : "#07051a";
    x.fillRect(0, 0, S, S);
    if (!glow) {
      x.strokeStyle = "#1a1438";
      x.lineWidth = 2;
      for (let i = 0; i <= 4; i++) {
        x.beginPath(); x.moveTo(i * 128, 0); x.lineTo(i * 128, S); x.stroke();
        x.beginPath(); x.moveTo(0, i * 128); x.lineTo(S, i * 128); x.stroke();
      }
      return;
    }
    const line = (vertical: boolean, at: number, color: string) => {
      x.shadowColor = color;
      x.shadowBlur = 18;
      x.strokeStyle = color;
      x.lineWidth = 4;
      x.beginPath();
      if (vertical) { x.moveTo(at, 0); x.lineTo(at, S); } else { x.moveTo(0, at); x.lineTo(S, at); }
      x.stroke();
    };
    line(true, 0, "#ff3fd1");
    line(false, 0, "#38e8ff");
    line(true, S / 2, "#5a2a9a");
    line(false, S / 2, "#2a4a9a");
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 6);
  return t;
}

/** A synthwave sunset: striped sun, wire mountains, a perspective grid, palms. */
function muralTex(seed: number): THREE.CanvasTexture {
  const W = 2048;
  const Hh = 512;
  return canvasTex(W, Hh, (x) => {
    const sky = x.createLinearGradient(0, 0, 0, Hh);
    sky.addColorStop(0, "#0a0220");
    sky.addColorStop(0.35, "#2b0a4f");
    sky.addColorStop(0.58, "#b0207a");
    sky.addColorStop(0.66, "#ff7a3a");
    sky.addColorStop(0.661, "#12051f");
    sky.addColorStop(1, "#05010c");
    x.fillStyle = sky;
    x.fillRect(0, 0, W, Hh);
    // Stars.
    let s = seed * 9301 + 49297;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    x.fillStyle = "#ffffff";
    for (let i = 0; i < 160; i++) {
      x.globalAlpha = 0.3 + rnd() * 0.7;
      x.fillRect(rnd() * W, rnd() * Hh * 0.45, 2, 2);
    }
    x.globalAlpha = 1;
    // The sun, banded.
    const hz = Hh * 0.66;
    const cx = W * (seed % 2 ? 0.62 : 0.38);
    const r = Hh * 0.3;
    const sun = x.createLinearGradient(0, hz - r, 0, hz);
    sun.addColorStop(0, "#ffe14d");
    sun.addColorStop(1, "#ff3fd1");
    x.save();
    x.beginPath();
    x.arc(cx, hz, r, Math.PI, 0);
    x.clip();
    x.fillStyle = sun;
    x.shadowColor = "#ff3fd1";
    x.shadowBlur = 40;
    x.fillRect(cx - r, hz - r, r * 2, r);
    x.globalCompositeOperation = "destination-out";
    for (let i = 0; i < 7; i++) {
      const y = hz - r * 0.55 + i * r * 0.085;
      x.fillRect(cx - r, y, r * 2, 3 + i * 1.6);
    }
    x.restore();
    // Mountains, wireframe.
    const ridge = (base: number, amp: number, color: string, step: number) => {
      x.beginPath();
      x.moveTo(0, hz);
      for (let px = 0; px <= W; px += step) {
        const y = base - Math.abs(Math.sin(px * 0.004 + seed) * amp + Math.sin(px * 0.011 + seed * 2) * amp * 0.4);
        x.lineTo(px, y);
      }
      x.lineTo(W, hz);
      x.closePath();
      x.fillStyle = "#12051f";
      x.fill();
      x.strokeStyle = color;
      x.lineWidth = 3;
      x.shadowColor = color;
      x.shadowBlur = 12;
      x.stroke();
      x.shadowBlur = 0;
    };
    ridge(hz, Hh * 0.16, "#38e8ff", 48);
    ridge(hz, Hh * 0.08, "#a66bff", 32);
    // The grid running to the horizon.
    x.strokeStyle = "#ff3fd1";
    x.shadowColor = "#ff3fd1";
    x.shadowBlur = 8;
    x.lineWidth = 2;
    for (let i = 0; i < 12; i++) {
      const y = hz + Math.pow(i / 11, 2.2) * (Hh - hz);
      x.beginPath(); x.moveTo(0, y); x.lineTo(W, y); x.stroke();
    }
    for (let i = -24; i <= 24; i++) {
      x.beginPath(); x.moveTo(W / 2 + i * 30, hz); x.lineTo(W / 2 + i * 220, Hh); x.stroke();
    }
    x.shadowBlur = 0;
    // Palms at the edges, silhouettes.
    const palm = (px: number, scale: number) => {
      x.strokeStyle = "#05010c";
      x.fillStyle = "#05010c";
      x.lineWidth = 10 * scale;
      x.beginPath();
      x.moveTo(px, Hh);
      x.quadraticCurveTo(px + 30 * scale, Hh - 160 * scale, px + 10 * scale, Hh - 300 * scale);
      x.stroke();
      const tx = px + 10 * scale;
      const ty = Hh - 300 * scale;
      for (let k = 0; k < 7; k++) {
        const a = -Math.PI / 2 + (k - 3) * 0.5;
        x.beginPath();
        x.moveTo(tx, ty);
        x.quadraticCurveTo(tx + Math.cos(a) * 80 * scale, ty + Math.sin(a) * 60 * scale - 20 * scale, tx + Math.cos(a) * 150 * scale, ty + Math.sin(a) * 30 * scale + 50 * scale);
        x.lineWidth = 8 * scale;
        x.stroke();
      }
    };
    palm(80, 1.1);
    palm(220, 0.8);
    palm(W - 160, 1.15);
    palm(W - 300, 0.75);
  });
}

/** A soft white blob, for glows, spots and haze; tinted by the material. */
function blobTex(): THREE.CanvasTexture {
  return canvasTex(128, 128, (x) => {
    const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,255,255,0.45)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g;
    x.fillRect(0, 0, 128, 128);
  });
}

/** Strong at v=1 fading to nothing at v=0, for beams and floor smears. */
function fadeTex(): THREE.CanvasTexture {
  return canvasTex(8, 128, (x) => {
    const g = x.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g;
    x.fillRect(0, 0, 8, 128);
  });
}

/** Mirror ball tiles: little squares in greys, a few catching pink and cyan. */
function mirrorTex(): THREE.CanvasTexture {
  return canvasTex(256, 128, (x) => {
    let s = 5;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 32; i++) for (let j = 0; j < 16; j++) {
      const r = rnd();
      x.fillStyle = r > 0.93 ? "#ffffff" : r > 0.88 ? "#ff8fe0" : r > 0.83 ? "#8ff4ff" : `hsl(240, 15%, ${25 + rnd() * 45}%)`;
      x.fillRect(i * 8, j * 8, 7, 7);
    }
  });
}

/** CRT scanlines with a soft vignette, laid over every screen. */
function scanTex(): THREE.CanvasTexture {
  const t = canvasTex(64, 256, (x) => {
    for (let y = 0; y < 256; y += 4) {
      x.fillStyle = "rgba(0,0,0,0.42)";
      x.fillRect(0, y, 64, 2);
    }
    const g = x.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.48, "rgba(255,255,255,0)");
    g.addColorStop(0.5, "rgba(255,255,255,0.12)");
    g.addColorStop(0.56, "rgba(255,255,255,0)");
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 256);
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** The high score wall's face. */
function drawBoard(x: CanvasRenderingContext2D, W: number, Hh: number, board: Board | null, page: number) {
  x.fillStyle = "#06031a";
  x.fillRect(0, 0, W, Hh);
  // Faint grid.
  x.strokeStyle = "rgba(166,107,255,0.12)";
  x.lineWidth = 2;
  for (let i = 0; i < W; i += 48) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, Hh); x.stroke(); }
  for (let i = 0; i < Hh; i += 48) { x.beginPath(); x.moveTo(0, i); x.lineTo(W, i); x.stroke(); }
  x.textAlign = "center";
  x.textBaseline = "middle";
  const glowText = (t: string, px: number, py: number, size: number, color: string, weight = 900) => {
    x.font = `${weight} ${size}px ui-monospace, Menlo, monospace`;
    x.shadowColor = color;
    x.shadowBlur = size * 0.5;
    x.fillStyle = color;
    x.fillText(t, px, py);
    x.shadowBlur = 0;
  };
  glowText("★ HIGH SCORES ★", W / 2, 58, 64, "#ff3fd1");
  x.font = "700 22px ui-monospace, Menlo, monospace";
  x.fillStyle = board?.live ? "#7cff6b" : "#ffe14d";
  x.textAlign = "right";
  x.fillText(board ? (board.live ? "● LIVE" : "● THIS DEVICE") : "● LOADING", W - 30, 34);
  x.textAlign = "center";
  const per = 4;
  const games = ARCADE_GAMES.slice(page * per, page * per + per);
  const colW = W / per;
  const cols = ["#38e8ff", "#ffe14d", "#7cff6b", "#ff7a1a"];
  games.forEach((g, i) => {
    const cx = colW * i + colW / 2;
    const color = cols[i % cols.length];
    glowText(g.short, cx, 132, 34, color);
    x.fillStyle = color;
    x.globalAlpha = 0.5;
    x.fillRect(cx - colW * 0.38, 156, colW * 0.76, 3);
    x.globalAlpha = 1;
    const b = board?.games[g.key];
    const rows = b?.top.slice(0, 5) ?? [];
    rows.forEach((r, k) => {
      const y = 196 + k * 50;
      x.font = "800 30px ui-monospace, Menlo, monospace";
      x.fillStyle = r.mine ? "#ffe14d" : r.house ? "rgba(255,255,255,0.55)" : "#ffffff";
      x.textAlign = "left";
      x.fillText(`${k + 1}. ${r.initials}`, cx - colW * 0.4, y);
      x.textAlign = "right";
      x.fillText(formatScore(g, r.score), cx + colW * 0.4, y);
    });
    x.textAlign = "center";
    const t = b?.today;
    x.font = "700 22px ui-monospace, Menlo, monospace";
    x.fillStyle = "#ff3fd1";
    x.fillText(t ? `TODAY: ${t.initials} ${formatScore(g, t.score)}` : "TODAY: YOUR NAME HERE", cx, Hh - 34);
  });
}

/** A little 3D prize for the shelf, from primitives. */
function buildPrize(id: string): THREE.Group {
  const g = new THREE.Group();
  const std = (c: string, o: Partial<THREE.MeshStandardMaterialParameters> = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, ...o });
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
    const o = new THREE.Mesh(geo, m);
    o.position.set(x, y, z);
    g.add(o);
    return o;
  };
  switch (id) {
    case "duck": {
      const y = std("#ffd21a");
      add(new THREE.SphereGeometry(0.16, 14, 10), y, 0, 0.14, 0).scale.set(1.2, 0.85, 1);
      add(new THREE.SphereGeometry(0.1, 12, 10), y, 0.1, 0.32, 0);
      add(new THREE.ConeGeometry(0.04, 0.1, 8), std("#f97316"), 0.21, 0.31, 0).rotation.z = -Math.PI / 2;
      break;
    }
    case "mort-plush": {
      const p = std("#a66bff", { roughness: 0.95 });
      add(new THREE.SphereGeometry(0.16, 14, 10), p, 0, 0.3, 0);
      add(new THREE.CylinderGeometry(0.16, 0.18, 0.22, 14), p, 0, 0.15, 0);
      const w = std("#ffffff");
      add(new THREE.SphereGeometry(0.04, 8, 6), w, 0.06, 0.33, 0.14);
      add(new THREE.SphereGeometry(0.04, 8, 6), w, -0.06, 0.33, 0.14);
      break;
    }
    case "lava-lamp": {
      const chrome = std("#d8dde6", { metalness: 0.9, roughness: 0.25 });
      add(new THREE.CylinderGeometry(0.07, 0.13, 0.14, 14), chrome, 0, 0.07, 0);
      add(new THREE.CylinderGeometry(0.09, 0.07, 0.32, 14), new THREE.MeshBasicMaterial({ color: "#ff3fd1", transparent: true, opacity: 0.55 }), 0, 0.3, 0);
      add(new THREE.SphereGeometry(0.045, 8, 6), new THREE.MeshBasicMaterial({ color: "#ffe14d" }), 0, 0.24, 0).name = "blob";
      add(new THREE.SphereGeometry(0.035, 8, 6), new THREE.MeshBasicMaterial({ color: "#ffe14d" }), 0.01, 0.38, 0).name = "blob";
      add(new THREE.ConeGeometry(0.06, 0.08, 14), chrome, 0, 0.5, 0);
      break;
    }
    case "vibey-plush": {
      add(new THREE.BoxGeometry(0.28, 0.24, 0.24), std("#c9d2e0", { roughness: 0.9 }), 0, 0.3, 0);
      add(new THREE.BoxGeometry(0.22, 0.18, 0.2), std("#7a8699", { roughness: 0.9 }), 0, 0.1, 0);
      const eye = new THREE.MeshBasicMaterial({ color: "#38e8ff" });
      add(new THREE.SphereGeometry(0.035, 8, 6), eye, 0.06, 0.32, 0.12);
      add(new THREE.SphereGeometry(0.035, 8, 6), eye, -0.06, 0.32, 0.12);
      add(new THREE.CylinderGeometry(0.008, 0.008, 0.1, 4), std("#15151c"), 0, 0.47, 0);
      add(new THREE.SphereGeometry(0.025, 8, 6), new THREE.MeshBasicMaterial({ color: "#ff3fd1" }), 0, 0.53, 0);
      break;
    }
    case "flamingo": {
      const neon = new THREE.MeshBasicMaterial({ color: "#ff5fc8" });
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(-0.12, 0.25, 0), new THREE.Vector3(0.05, 0.18, 0), new THREE.Vector3(0.12, 0.3, 0),
        new THREE.Vector3(0.05, 0.42, 0), new THREE.Vector3(0.0, 0.55, 0), new THREE.Vector3(0.08, 0.6, 0),
      ]);
      add(new THREE.TubeGeometry(curve, 30, 0.014, 6), neon);
      add(new THREE.CylinderGeometry(0.008, 0.008, 0.22, 4), neon, 0, 0.1, 0);
      add(new THREE.BoxGeometry(0.3, 0.02, 0.1), std("#15151c"), 0, 0.0, 0);
      break;
    }
    case "golden-joystick": {
      const gold = std("#fbbf24", { metalness: 0.85, roughness: 0.2, emissive: "#7c4a03", emissiveIntensity: 0.4 });
      add(new THREE.BoxGeometry(0.3, 0.08, 0.22), gold, 0, 0.04, 0);
      add(new THREE.CylinderGeometry(0.018, 0.018, 0.22, 8), gold, 0, 0.19, 0);
      add(new THREE.SphereGeometry(0.06, 14, 10), new THREE.MeshStandardMaterial({ color: "#d8283a", roughness: 0.3 }), 0, 0.32, 0);
      add(new THREE.CylinderGeometry(0.025, 0.025, 0.02, 10), new THREE.MeshBasicMaterial({ color: "#38e8ff" }), 0.09, 0.09, 0.05);
      break;
    }
    default: {
      const hat = questHat(id);
      if (hat) {
        const h = hat.build();
        h.scale.setScalar(0.7);
        h.position.y = 0.05;
        g.add(h);
      }
    }
  }
  return g;
}

interface Screen {
  station: string;
  center: THREE.Vector3;
  normal: THREE.Vector3;
  w: number;
  h: number;
  mat: THREE.MeshBasicMaterial;
  attract: THREE.Texture;
  clip?: string;
  still?: string;
  video?: HTMLVideoElement;
  live?: THREE.Texture;
  failed?: boolean;
  pan: number;
}

export function buildArcade(opts: { lowDetail?: boolean } = {}): Arcade {
  const low = !!opts.lowDetail;
  const group = new THREE.Group();
  group.name = "vibe-arcade";
  const boxes: WorldBox[] = [];
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const texs: THREE.Texture[] = [];
  const mat = <M extends THREE.Material>(m: M) => {
    mats.push(m);
    return m;
  };
  const tex = <X extends THREE.Texture>(t: X) => {
    texs.push(t);
    return t;
  };
  const music = createArcadeMusic();

  const [cx, cz] = ARCADE_AT;
  const x0 = cx - HX;
  const x1 = cx + HX;
  const z0 = cz - HZ;
  const z1 = cz + HZ;

  const solid = (
    m: THREE.Material, minX: number, maxX: number, minZ: number, maxZ: number, base: number, top: number,
    collide = true,
  ) => {
    const geo = new THREE.BoxGeometry(maxX - minX, top - base, maxZ - minZ);
    geos.push(geo);
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set((minX + maxX) / 2, (base + top) / 2, (minZ + maxZ) / 2);
    mesh.castShadow = !low;
    mesh.receiveShadow = true;
    group.add(mesh);
    if (collide) boxes.push({ minX, maxX, minZ, maxZ, base, height: top });
    return mesh;
  };
  const plane = (m: THREE.Material, w: number, h: number, x: number, y: number, z: number, yaw: number) => {
    const geo = new THREE.PlaneGeometry(w, h);
    geos.push(geo);
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.rotation.y = yaw;
    group.add(mesh);
    return mesh;
  };
  const cyl = (m: THREE.Material, r: number, h: number, x: number, y: number, z: number, seg = 16) => {
    const geo = new THREE.CylinderGeometry(r, r, h, seg);
    geos.push(geo);
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };

  // ---- Materials -----------------------------------------------------------
  const shell = mat(new THREE.MeshStandardMaterial({ color: 0x150d28, roughness: 0.45, metalness: 0.35 }));
  const inner = mat(new THREE.MeshStandardMaterial({ color: 0x1a1236, roughness: 0.8, emissive: 0x0c0620 }));
  const roofM = mat(new THREE.MeshStandardMaterial({ color: 0x0c0818, roughness: 0.85 }));
  const pink = mat(new THREE.MeshBasicMaterial({ color: 0xff3fd1 }));
  const cyan = mat(new THREE.MeshBasicMaterial({ color: 0x38e8ff }));
  const yellow = mat(new THREE.MeshBasicMaterial({ color: 0xffe14d }));
  // The ceiling's tubes pulse with the beat, so they are their own materials.
  const tubePink = mat(new THREE.MeshBasicMaterial({ color: 0xff3fd1 }));
  const tubeCyan = mat(new THREE.MeshBasicMaterial({ color: 0x38e8ff }));
  const black = mat(new THREE.MeshStandardMaterial({ color: 0x15151c, roughness: 0.5, metalness: 0.3 }));
  const wood = mat(new THREE.MeshStandardMaterial({ color: 0x6b3a1e, roughness: 0.55 }));
  const felt = mat(new THREE.MeshStandardMaterial({ color: 0x0f7a4a, roughness: 0.95 }));
  const blueFelt = mat(new THREE.MeshStandardMaterial({ color: 0x1d4fb8, roughness: 0.95 }));
  const chrome = mat(new THREE.MeshStandardMaterial({ color: 0xd8dde6, roughness: 0.25, metalness: 0.9 }));
  const orange = mat(new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.6 }));
  const white = mat(new THREE.MeshStandardMaterial({ color: 0xf6f2ea, roughness: 0.6 }));
  const red = mat(new THREE.MeshStandardMaterial({ color: 0xd8283a, roughness: 0.5 }));
  const blue = mat(new THREE.MeshStandardMaterial({ color: 0x2c6cf0, roughness: 0.5 }));

  const blob = tex(blobTex());
  const fade = tex(fadeTex());
  const additive = (color: THREE.ColorRepresentation, map: THREE.Texture, opacity: number) =>
    mat(new THREE.MeshBasicMaterial({ color, map, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  /**
   * Things lying on the floor (reflections, spots, the dance floor) have to
   * win the depth test against a floor that is itself pulled forward, or
   * they vanish into it at any distance.
   */
  const onFloor = <M extends THREE.Material>(m: M): M => {
    m.polygonOffset = true;
    m.polygonOffsetFactor = -10;
    m.polygonOffsetUnits = -20;
    return m;
  };
  /** A glow behind something bright: fake bloom, one quad. */
  const halo = (color: THREE.ColorRepresentation, w: number, h: number, x: number, y: number, z: number, yaw: number, opacity = 0.35) => {
    const m = plane(additive(color, blob, opacity), w, h, x, y, z, yaw);
    m.renderOrder = 2;
    return m;
  };
  /**
   * A reflection on the wet floor: a smear of colour lying on the tiles,
   * strongest at the wall it comes from. `dir` is the direction it runs out
   * into the room, in the XZ plane.
   */
  const reflections: THREE.MeshBasicMaterial[] = [];
  const smear = (color: THREE.ColorRepresentation, x: number, z: number, w: number, len: number, dirX: number, dirZ: number, opacity = 0.32) => {
    const geo = new THREE.PlaneGeometry(w, len);
    geos.push(geo);
    const m = additive(color, fade, opacity);
    onFloor(m);
    reflections.push(m);
    const mesh = new THREE.Mesh(geo, m);
    // Lie flat, then turn so the bright end (v=1, local +y) points back at the wall.
    mesh.rotation.order = "YXZ";
    mesh.rotation.y = Math.atan2(dirX, dirZ);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x + (dirX * len) / 2, 0.09, z + (dirZ * len) / 2);
    mesh.renderOrder = 1;
    group.add(mesh);
    return mesh;
  };

  // ---- The hall ------------------------------------------------------------
  let floorMat: THREE.MeshStandardMaterial;
  {
    // Pulled toward the camera in the depth test: the street's own slab is
    // 4 cm below, and at the city's far plane that is close enough to fight.
    floorMat = mat(new THREE.MeshStandardMaterial({
      map: tex(floorTex(false)), emissiveMap: tex(floorTex(true)), emissive: 0xffffff, emissiveIntensity: 0.7,
      roughness: 0.18, metalness: 0.4, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
    }));
    solid(floorMat, x0, x1, z0, z1, 0, 0.05, false);
    // Walls: north, south, east whole; west with the door left out.
    solid(shell, x0, x1, z1 - T, z1, 0, H);
    solid(shell, x0, x1, z0, z0 + T, 0, H);
    solid(shell, x1 - T, x1, z0 + T, z1 - T, 0, H);
    solid(shell, x0, x0 + T, z0 + T, cz - DOOR, 0, H);
    solid(shell, x0, x0 + T, cz + DOOR, z1 - T, 0, H);
    solid(shell, x0, x0 + T, cz - DOOR, cz + DOOR, DOOR_H, H);
    // Inner skin, nearly black so the neon reads.
    solid(inner, x0 + T, x1 - T, z1 - T - 0.02, z1 - T, 0, H - 0.4, false);
    solid(inner, x0 + T, x1 - T, z0 + T, z0 + T + 0.02, 0, H - 0.4, false);
    solid(inner, x1 - T - 0.02, x1 - T, z0 + T, z1 - T, 0, H - 0.4, false);
    solid(inner, x0 + T, x0 + T + 0.02, z0 + T, cz - DOOR, 0, H - 0.4, false);
    solid(inner, x0 + T, x0 + T + 0.02, cz + DOOR, z1 - T, 0, H - 0.4, false);
    // Roof: a slab you can stand on and a ceiling you can bump into.
    solid(roofM, x0, x1, z0, z1, H - 0.4, H);
    solid(black, x0, x1, z1 - 0.3, z1, H, H + 0.5, false);
    solid(black, x0, x1, z0, z0 + 0.3, H, H + 0.5, false);
    solid(black, x1 - 0.3, x1, z0, z1, H, H + 0.5, false);
    solid(black, x0, x0 + 0.3, z0, z1, H, H + 0.5, false);

    // Outside, one line of light and nothing else: a slim cyan cornice along
    // the top of the parapet and down every corner, so the building reads as
    // one clean shape at night and the sign is the only loud thing on it.
    const top = H + 0.5;
    const e = 0.05;
    solid(cyan, x0 - e, x1 + e, z1, z1 + e, top - 0.09, top, false);
    solid(cyan, x0 - e, x1 + e, z0 - e, z0, top - 0.09, top, false);
    solid(cyan, x1, x1 + e, z0, z1, top - 0.09, top, false);
    solid(cyan, x0 - e, x0, z0, z1, top - 0.09, top, false);
    for (const [x, z] of [[x0, z0], [x0, z1], [x1, z0], [x1, z1]] as const) {
      const sx = x === x0 ? -e : 0;
      const sz = z === z0 ? -e : 0;
      solid(cyan, x + sx, x + sx + e, z + sz, z + sz + e, 0, top, false);
    }
    // Inside: a pink tube along the skirting and a cyan one under the ceiling,
    // all the way round, so every wall has a line of light to reflect.
    const inBand = (m: THREE.Material, y: number, th: number) => {
      solid(m, x0 + T, x1 - T, z1 - T - 0.06, z1 - T - 0.02, y, y + th, false);
      solid(m, x0 + T, x1 - T, z0 + T + 0.02, z0 + T + 0.06, y, y + th, false);
      solid(m, x1 - T - 0.06, x1 - T - 0.02, z0 + T, z1 - T, y, y + th, false);
      solid(m, x0 + T + 0.02, x0 + T + 0.06, z0 + T, cz - DOOR, y, y + th, false);
      solid(m, x0 + T + 0.02, x0 + T + 0.06, cz + DOOR, z1 - T, y, y + th, false);
    };
    inBand(tubePink, 0.12, 0.06);
    inBand(tubeCyan, H - 0.75, 0.07);
    // Neon tubes across the ceiling, a grid of them.
    for (const dz of [-8, -4, 0, 4, 8]) solid(dz % 8 === 0 ? tubePink : tubeCyan, x0 + 1, x1 - 1, cz + dz - 0.05, cz + dz + 0.05, H - 0.47, H - 0.4, false);
    for (const dx of [-6, 0, 6]) solid(tubeCyan, cx + dx - 0.05, cx + dx + 0.05, z0 + 1, z1 - 1, H - 0.48, H - 0.41, false);
    // The skirting tube's glow on the floor, every wall.
    smear("#ff3fd1", x0 + 1, z0 + T, 23, 2.2, 0, 1, 0.18).position.x = cx;
    smear("#ff3fd1", x0 + 1, z1 - T, 23, 2.2, 0, -1, 0.18).position.x = cx;

    // Synthwave murals on the long walls, the room's big picture.
    const muralH = 4.6;
    const muralY = H - 0.5 - muralH / 2 - 0.2;
    for (const [z, yaw, seed] of [[z0 + T + 0.04, 0, 3], [z1 - T - 0.04, Math.PI, 4]] as const) {
      const m = mat(new THREE.MeshBasicMaterial({ map: tex(muralTex(seed)) }));
      plane(m, 2 * HX - 2 * T - 0.4, muralH, cx, muralY, z, yaw);
      const dir = z < cz ? 1 : -1;
      // Tube frame under the mural.
      solid(dir > 0 ? tubeCyan : tubePink, x0 + T + 0.2, x1 - T - 0.2, z + dir * 0.01, z + dir * 0.05, muralY - muralH / 2 - 0.08, muralY - muralH / 2 - 0.02, false);
      // The sunset in the floor.
      smear("#ff6aa8", cx, z, 18, 6.5, 0, dir, 0.16);
    }
    // Over the door, inside: INSERT COIN.
    const coinSign = mat(new THREE.MeshBasicMaterial({ map: tex(neonTex("INSERT COIN", "#ffe14d", 1024, 200, "")), transparent: true, depthWrite: false }));
    plane(coinSign, 6.4, 1.25, x0 + T + 0.08, DOOR_H + 1.2, cz, Math.PI / 2);
    halo("#ffe14d", 8, 3, x0 + T + 0.06, DOOR_H + 1.2, cz, Math.PI / 2, 0.18);
  }

  // ---- The front: the sign, the marquee, the bulbs -------------------------
  const bulbs: THREE.Mesh[] = [];
  const bulbOn = mat(new THREE.MeshBasicMaterial({ color: 0xfff1b0 }));
  const bulbOff = mat(new THREE.MeshBasicMaterial({ color: 0x6d5a2a }));
  let signMesh: THREE.Mesh;
  {
    // The one sign. Everything else on the front is quiet so this reads.
    const signM = mat(new THREE.MeshBasicMaterial({ map: tex(neonTex("VIBE ARCADE", "#ff3fd1")) }));
    signMesh = plane(signM, 15, 3.75, x0 - 0.08, H - 2.4, cz, -Math.PI / 2);
    halo("#ff3fd1", 19, 6.5, x0 - 0.1, H - 2.4, cz, -Math.PI / 2, 0.2);
    // Marquee canopy over the door: a dark slab with a pink edge and one
    // row of warm bulbs underneath it.
    solid(shell, x0 - 2.2, x0, cz - DOOR - 0.8, cz + DOOR + 0.8, DOOR_H + 0.15, DOOR_H + 0.45, false);
    solid(pink, x0 - 2.26, x0 - 2.2, cz - DOOR - 0.8, cz + DOOR + 0.8, DOOR_H + 0.15, DOOR_H + 0.21, false);
    const bulbGeo = new THREE.SphereGeometry(0.07, 8, 6);
    geos.push(bulbGeo);
    const n = low ? 12 : 20;
    for (let i = 0; i < n; i++) {
      const z = cz - DOOR - 0.6 + ((DOOR + 0.6) * 2 * i) / (n - 1);
      const b = new THREE.Mesh(bulbGeo, bulbOn);
      b.position.set(x0 - 2.0, DOOR_H + 0.08, z);
      group.add(b);
      bulbs.push(b);
    }
    // The canopy's light on the pavement.
    halo("#ffd9a0", 2.6, 9, x0 - 1.1, 0.1, cz, 0, 0.12).rotation.set(-Math.PI / 2, 0, Math.PI / 2);
    // Door frame, pink.
    solid(pink, x0 - 0.1, x0 + T + 0.1, cz - DOOR - 0.12, cz - DOOR, 0, DOOR_H, false);
    solid(pink, x0 - 0.1, x0 + T + 0.1, cz + DOOR, cz + DOOR + 0.12, 0, DOOR_H, false);
    solid(pink, x0 - 0.1, x0 + T + 0.1, cz - DOOR - 0.12, cz + DOOR + 0.12, DOOR_H, DOOR_H + 0.12, false);
    // A dark runner out to the pavement, and the sign's pink in the wet
    // ground in front of it.
    solid(mat(new THREE.MeshStandardMaterial({ color: 0x241542, roughness: 0.9 })), x0 - 3, x0, cz - 1.6, cz + 1.6, 0, 0.035, false);
    smear("#ff3fd1", x0, cz, 14, 7, -1, 0, 0.14);
  }

  // ---- Screens -------------------------------------------------------------
  const screens: Screen[] = [];
  const scan = tex(scanTex());
  const scanMat = mat(new THREE.MeshBasicMaterial({ map: scan, transparent: true, depthWrite: false }));
  /**
   * A living screen: shows the attract card until it is close enough to be
   * worth playing, then the game's filmed clip (or its still, panning).
   */
  const screen = (station: string, title: string, emoji: string, color: string, w: number, h: number, x: number, y: number, z: number, yaw: number) => {
    const attract = tex(screenTex(title, emoji, color));
    const m = mat(new THREE.MeshBasicMaterial({ map: attract }));
    plane(m, w, h, x, y, z, yaw);
    const normal = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const over = plane(scanMat, w, h, x + normal.x * 0.006, y, z + normal.z * 0.006, yaw);
    over.renderOrder = 3;
    halo(color, w * 1.9, h * 1.9, x - normal.x * 0.02, y, z - normal.z * 0.02, yaw, 0.28);
    const key = ART_KEY[station];
    const s: Screen = {
      station, center: new THREE.Vector3(x, y, z), normal, w, h, mat: m, attract,
      clip: key ? FILMED[key] : undefined, still: key ? artFor(key) : undefined, pan: Math.random() * 10,
    };
    screens.push(s);
    return s;
  };

  // ---- Stations ------------------------------------------------------------
  const stations: ArcadeStation[] = [];
  const station = (s: Omit<ArcadeStation, "at" | "kind"> & { at: [number, number]; kind?: ArcadeStation["kind"] }) => {
    const st: ArcadeStation = { kind: "game", ...s, at: new THREE.Vector3(s.at[0], 0, s.at[1]) };
    stations.push(st);
    return st;
  };
  /** A floating neon label over a station. */
  const label = (text: string, color: string, x: number, y: number, z: number, yaw: number, w = 3.2) => {
    const m = mat(new THREE.MeshBasicMaterial({ map: tex(neonTex(text, color, 768, 192)) }));
    plane(m, w, w / 4, x, y, z, yaw);
  };
  /** A screen hung from the ceiling over a table, showing both ways. */
  const hungScreen = (key: string, title: string, emoji: string, color: string, x: number, y: number, z: number, w = 1.9) => {
    const h = w * 0.5625;
    solid(black, x - 0.06, x + 0.06, z - w / 2 - 0.06, z + w / 2 + 0.06, y - h / 2 - 0.06, y + h / 2 + 0.06, false);
    solid(black, x - 0.015, x + 0.015, z - 0.015, z + 0.015, y + h / 2, H - 0.4, false);
    screen(key, title, emoji, color, w, h, x - 0.065, y, z, -Math.PI / 2);
    screen(key, title, emoji, color, w, h, x + 0.065, y, z, Math.PI / 2);
  };

  // 8-Ball Club: a real pool table, balls racked, a cue on the rail.
  {
    const tx = cx + 1;
    const tz = cz - 6.5;
    const L = 2.7;
    const W = 1.5;
    solid(wood, tx - L / 2 - 0.12, tx + L / 2 + 0.12, tz - W / 2 - 0.12, tz + W / 2 + 0.12, 0.62, 0.82, false);
    boxes.push({ minX: tx - L / 2 - 0.12, maxX: tx + L / 2 + 0.12, minZ: tz - W / 2 - 0.12, maxZ: tz + W / 2 + 0.12, base: 0, height: 0.9 });
    solid(felt, tx - L / 2, tx + L / 2, tz - W / 2, tz + W / 2, 0.82, 0.84, false);
    for (const [a, b, c, d] of [
      [tx - L / 2 - 0.12, tx + L / 2 + 0.12, tz - W / 2 - 0.12, tz - W / 2],
      [tx - L / 2 - 0.12, tx + L / 2 + 0.12, tz + W / 2, tz + W / 2 + 0.12],
      [tx - L / 2 - 0.12, tx - L / 2, tz - W / 2, tz + W / 2],
      [tx + L / 2, tx + L / 2 + 0.12, tz - W / 2, tz + W / 2],
    ] as const) solid(wood, a, b, c, d, 0.82, 0.9, false);
    for (const px of [tx - L / 2 + 0.1, tx + L / 2 - 0.1]) for (const pz of [tz - W / 2 + 0.1, tz + W / 2 - 0.1]) {
      solid(wood, px - 0.09, px + 0.09, pz - 0.09, pz + 0.09, 0, 0.62, false);
    }
    for (const px of [tx - L / 2, tx, tx + L / 2]) for (const pz of [tz - W / 2, tz + W / 2]) cyl(black, 0.07, 0.02, px, 0.845, pz, 10);
    const ballGeo = new THREE.SphereGeometry(0.045, 12, 8);
    geos.push(ballGeo);
    const ballCols = [0xffd21a, 0x1d4ed8, 0xdc2626, 0x6d28d9, 0xf97316, 0x15803d, 0x7f1d1d, 0x111111, 0xffd21a, 0x1d4ed8, 0xdc2626, 0x6d28d9, 0xf97316, 0x15803d, 0x7f1d1d];
    let k = 0;
    for (let row = 0; row < 5; row++) for (let i = 0; i <= row; i++) {
      const m = mat(new THREE.MeshStandardMaterial({ color: ballCols[k++ % ballCols.length], roughness: 0.25 }));
      const b = new THREE.Mesh(ballGeo, m);
      b.position.set(tx + 0.55 + row * 0.08, 0.885, tz + (i - row / 2) * 0.092);
      group.add(b);
    }
    const cue = new THREE.Mesh(ballGeo, white);
    cue.position.set(tx - 0.7, 0.885, tz);
    group.add(cue);
    const stickGeo = new THREE.CylinderGeometry(0.012, 0.022, 1.45, 8).rotateZ(Math.PI / 2);
    geos.push(stickGeo);
    const stick = new THREE.Mesh(stickGeo, wood);
    stick.position.set(tx, 0.93, tz + W / 2 + 0.06);
    group.add(stick);
    // A hanging lamp, and the pool of light it throws on the felt.
    solid(black, tx - 0.9, tx + 0.9, tz - 0.25, tz + 0.25, 2.55, 2.7, false);
    solid(yellow, tx - 0.85, tx + 0.85, tz - 0.2, tz + 0.2, 2.53, 2.55, false);
    const pool = plane(additive("#fff1b0", blob, 0.25), 3.4, 2.2, tx, 0.95, tz, 0);
    pool.rotation.x = -Math.PI / 2;
    hungScreen("pool", "8-Ball Club", "🎱", "#7cff6b", tx, 4.1, tz);
    label("8-BALL CLUB", "#7cff6b", tx, 5.15, tz, -Math.PI / 2);
    label("8-BALL CLUB", "#7cff6b", tx, 5.15, tz, Math.PI / 2);
    station({ key: "pool", title: "8-Ball Club", emoji: "🎱", route: "/pool", accent: "#7cff6b", at: [tx, tz], reach: 2.6 });
  }

  // Vibe Hoops: a basketball machine against the east wall, ramp and all.
  {
    const hx = x1 - 2.2;
    const hz = cz - 7.5;
    solid(black, hx - 1.6, hx + 1.4, hz - 0.8, hz + 0.8, 0, 1.0);
    solid(orange, hx - 1.6, hx + 1.4, hz - 0.82, hz - 0.78, 0.2, 0.9, false);
    solid(orange, hx - 1.6, hx + 1.4, hz + 0.78, hz + 0.82, 0.2, 0.9, false);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(3, 0.06, 1.5), mat(new THREE.MeshStandardMaterial({ color: 0x9a6a3a, roughness: 0.6 })));
    geos.push(deck.geometry);
    deck.position.set(hx - 0.1, 1.15, hz);
    deck.rotation.z = 0.12;
    group.add(deck);
    const net = mat(new THREE.MeshStandardMaterial({ color: 0x222233, transparent: true, opacity: 0.35, roughness: 0.9 }));
    solid(net, hx - 1.6, hx + 1.4, hz - 0.85, hz - 0.8, 1.0, 3.2, false);
    solid(net, hx - 1.6, hx + 1.4, hz + 0.8, hz + 0.85, 1.0, 3.2, false);
    solid(white, hx + 1.3, hx + 1.4, hz - 0.7, hz + 0.7, 2.2, 3.3, false);
    solid(orange, hx + 1.29, hx + 1.3, hz - 0.25, hz + 0.25, 2.4, 2.75, false);
    const rimGeo = new THREE.TorusGeometry(0.22, 0.02, 8, 24).rotateX(Math.PI / 2);
    geos.push(rimGeo);
    const rim = new THREE.Mesh(rimGeo, orange);
    rim.position.set(hx + 1.05, 2.45, hz);
    group.add(rim);
    const bGeo = new THREE.SphereGeometry(0.12, 14, 10);
    geos.push(bGeo);
    for (let i = 0; i < 4; i++) {
      const b = new THREE.Mesh(bGeo, orange);
      b.position.set(hx - 1.35, 1.12, hz - 0.45 + i * 0.3);
      group.add(b);
    }
    solid(black, hx + 1.3, hx + 1.4, hz - 1.0, hz + 1.0, 3.3, 5.0, false);
    screen("hoops", "Vibe Hoops", "🏀", "#ff7a1a", 1.8, 1.01, hx + 1.25, 4.15, hz, -Math.PI / 2);
    smear("#ff7a1a", hx + 1.2, hz, 2.6, 3.5, -1, 0, 0.3);
    station({ key: "hoops", title: "Vibe Hoops", emoji: "🏀", route: "/hoops", accent: "#ff7a1a", at: [hx - 1.6, hz], reach: 2.2 });
  }

  // Vibe Cup: a foosball table, red against blue.
  {
    const fx = cx + 1;
    const fz = cz + 6.5;
    const L = 1.5;
    const W = 0.85;
    solid(black, fx - L / 2 - 0.08, fx + L / 2 + 0.08, fz - W / 2 - 0.08, fz + W / 2 + 0.08, 0.55, 0.95, false);
    boxes.push({ minX: fx - L / 2 - 0.08, maxX: fx + L / 2 + 0.08, minZ: fz - W / 2 - 0.08, maxZ: fz + W / 2 + 0.08, base: 0, height: 0.95 });
    solid(felt, fx - L / 2, fx + L / 2, fz - W / 2, fz + W / 2, 0.95, 0.96, false);
    solid(white, fx - 0.01, fx + 0.01, fz - W / 2, fz + W / 2, 0.96, 0.965, false);
    for (const px of [fx - L / 2 + 0.05, fx + L / 2 - 0.05]) for (const pz of [fz - W / 2 + 0.05, fz + W / 2 - 0.05]) {
      solid(black, px - 0.05, px + 0.05, pz - 0.05, pz + 0.05, 0, 0.55, false);
    }
    const rodGeo = new THREE.CylinderGeometry(0.012, 0.012, W + 0.5, 6).rotateX(Math.PI / 2);
    const manGeo = new THREE.BoxGeometry(0.05, 0.14, 0.04);
    geos.push(rodGeo, manGeo);
    const rods = [-0.6, -0.36, -0.12, 0.12, 0.36, 0.6];
    rods.forEach((dx, i) => {
      const rod = new THREE.Mesh(rodGeo, chrome);
      rod.position.set(fx + dx, 1.08, fz);
      group.add(rod);
      const men = i === 0 || i === 5 ? 1 : i % 2 ? 3 : 2;
      for (let m = 0; m < men; m++) {
        const man = new THREE.Mesh(manGeo, i % 2 ? blue : red);
        man.position.set(fx + dx, 1.03, fz + (men === 1 ? 0 : (m / (men - 1) - 0.5) * W * 0.7));
        group.add(man);
      }
    });
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.025, 10, 8), white);
    geos.push(ball.geometry);
    ball.position.set(fx + 0.05, 0.99, fz + 0.1);
    group.add(ball);
    hungScreen("vibecup", "Vibe Cup", "⚽", "#38e8ff", fx, 3.4, fz, 1.6);
    label("VIBE CUP", "#38e8ff", fx, 4.35, fz, -Math.PI / 2, 2.6);
    label("VIBE CUP", "#38e8ff", fx, 4.35, fz, Math.PI / 2, 2.6);
    station({ key: "vibecup", title: "Vibe Cup", emoji: "⚽", route: "/vibe-cup", accent: "#38e8ff", at: [fx, fz], reach: 2.1 });
  }

  // Solitaire: a round card table under a lamp, a game laid out.
  {
    const sx = cx - 6;
    const sz = cz + 7.5;
    cyl(wood, 0.95, 0.06, sx, 0.78, sz, 28);
    cyl(blueFelt, 0.88, 0.01, sx, 0.815, sz, 28);
    cyl(black, 0.08, 0.76, sx, 0.38, sz, 10);
    cyl(black, 0.45, 0.04, sx, 0.02, sz, 18);
    boxes.push({ minX: sx - 0.9, maxX: sx + 0.9, minZ: sz - 0.9, maxZ: sz + 0.9, base: 0, height: 0.81 });
    const cardGeo = new THREE.BoxGeometry(0.1, 0.004, 0.14);
    geos.push(cardGeo);
    const back = mat(new THREE.MeshStandardMaterial({ color: 0xc81e4a, roughness: 0.7 }));
    for (let col = 0; col < 7; col++) for (let r = 0; r <= col; r++) {
      const c = new THREE.Mesh(cardGeo, r === col ? white : back);
      c.position.set(sx - 0.48 + col * 0.16, 0.82 + r * 0.002, sz - 0.25 + r * 0.05);
      group.add(c);
    }
    for (let f = 0; f < 4; f++) {
      const c = new THREE.Mesh(cardGeo, white);
      c.position.set(sx - 0.1 + f * 0.16, 0.82, sz - 0.5);
      group.add(c);
    }
    for (const [dx, dz] of [[-1.25, 0.2], [1.25, -0.2]] as const) {
      cyl(red, 0.25, 0.08, sx + dx, 0.62, sz + dz, 16);
      cyl(chrome, 0.03, 0.6, sx + dx, 0.3, sz + dz, 8);
    }
    solid(black, sx - 0.02, sx + 0.02, sz - 0.02, sz + 0.02, 2.4, 3.0, false);
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.45, 0.35, 18, 1, true), mat(new THREE.MeshStandardMaterial({ color: 0x0f7a4a, side: THREE.DoubleSide })));
    geos.push(shade.geometry);
    shade.position.set(sx, 2.3, sz);
    group.add(shade);
    const pool = plane(additive("#fff1b0", blob, 0.22), 2.4, 2.4, sx, 0.84, sz, 0);
    pool.rotation.x = -Math.PI / 2;
    hungScreen("solitaire", "Solitaire", "🃏", "#ffe14d", sx, 3.75, sz, 1.6);
    label("SOLITAIRE", "#ffe14d", sx, 4.7, sz, -Math.PI / 2, 2.8);
    label("SOLITAIRE", "#ffe14d", sx, 4.7, sz, Math.PI / 2, 2.8);
    station({ key: "solitaire", title: "Solitaire", emoji: "🃏", route: "/solitaire", accent: "#ffe14d", at: [sx, sz], reach: 2.2 });
  }

  // Upright cabinets along the east wall, under the high score wall.
  const cabinet = (key: string, title: string, emoji: string, route: string, color: string, z: number) => {
    const bx = x1 - 1.1;
    const body = mat(new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.3), roughness: 0.45, metalness: 0.3 }));
    const trim = mat(new THREE.MeshBasicMaterial({ color }));
    solid(body, bx - 0.4, bx + 0.45, z - 0.5, z + 0.5, 0, 1.0);
    solid(body, bx - 0.55, bx + 0.45, z - 0.5, z + 0.5, 1.0, 1.15, false);
    solid(body, bx - 0.05, bx + 0.45, z - 0.5, z + 0.5, 1.15, 2.2, false);
    // Side panels' neon edges.
    solid(trim, bx - 0.4, bx - 0.38, z - 0.52, z - 0.5, 0.05, 1.0, false);
    solid(trim, bx - 0.4, bx - 0.38, z + 0.5, z + 0.52, 0.05, 1.0, false);
    // Marquee: the game's name lit from behind.
    const marq = mat(new THREE.MeshBasicMaterial({ map: tex(neonTex(title.toUpperCase(), color, 512, 128)) }));
    solid(trim, bx - 0.12, bx + 0.45, z - 0.52, z + 0.52, 2.2, 2.22, false);
    solid(body, bx - 0.12, bx + 0.45, z - 0.52, z + 0.52, 2.22, 2.5, false);
    plane(marq, 1.0, 0.26, bx - 0.125, 2.36, z, -Math.PI / 2);
    solid(trim, bx - 0.56, bx - 0.55, z - 0.5, z + 0.5, 1.0, 1.15, false);
    cyl(black, 0.015, 0.12, bx - 0.4, 1.2, z - 0.15, 6);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), red);
    geos.push(knob.geometry);
    knob.position.set(bx - 0.4, 1.27, z - 0.15);
    group.add(knob);
    for (let i = 0; i < 3; i++) cyl(i === 1 ? yellow : cyan, 0.025, 0.02, bx - 0.38 + (i % 2) * 0.05, 1.16, z + 0.05 + i * 0.09, 10);
    screen(key, title, emoji, color, 0.86, 0.64, bx - 0.07, 1.68, z, -Math.PI / 2);
    smear(color, bx - 0.4, z, 1.1, 2.6, -1, 0, 0.34);
    station({ key, title, emoji, route, accent: color, at: [bx - 0.6, z], reach: 1.5 });
  };
  cabinet("mortmaze", "Mort Maze", "👻", "/mort-maze", "#a66bff", cz - 2.7);
  cabinet("boxing", "Haymaker Boxing", "🥊", "/boxing", "#ff3fd1", cz - 0.9);
  cabinet("2048", "2048", "🔢", "/2048", "#ffe14d", cz + 0.9);
  cabinet("coil", "COIL", "🐍", "/coil", "#7cff6b", cz + 2.7);

  // ---- The high score wall -------------------------------------------------
  const boardCanvas = document.createElement("canvas");
  boardCanvas.width = low ? 1024 : 1536;
  boardCanvas.height = low ? 410 : 614;
  const boardTex = tex(new THREE.CanvasTexture(boardCanvas));
  boardTex.colorSpace = THREE.SRGBColorSpace;
  let board: Board | null = null;
  let boardPage = 0;
  const pages = Math.ceil(ARCADE_GAMES.length / 4);
  const redrawBoard = () => {
    const x = boardCanvas.getContext("2d")!;
    x.save();
    x.scale(boardCanvas.width / 1536, boardCanvas.height / 614);
    drawBoard(x, 1536, 614, board, boardPage);
    x.restore();
    boardTex.needsUpdate = true;
  };
  {
    const bw = 10.5;
    const bh = bw / 2.5;
    const by = 5.25;
    const bxx = x1 - T - 0.05;
    plane(mat(new THREE.MeshBasicMaterial({ map: boardTex })), bw, bh, bxx, by, cz, -Math.PI / 2);
    halo("#ff3fd1", bw * 1.5, bh * 1.8, bxx + 0.02, by, cz, -Math.PI / 2, 0.2);
    // A tube frame round it.
    for (const [a, b, c, d] of [
      [by + bh / 2, by + bh / 2 + 0.08, -bw / 2 - 0.08, bw / 2 + 0.08],
      [by - bh / 2 - 0.08, by - bh / 2, -bw / 2 - 0.08, bw / 2 + 0.08],
      [by - bh / 2, by + bh / 2, -bw / 2 - 0.08, -bw / 2],
      [by - bh / 2, by + bh / 2, bw / 2, bw / 2 + 0.08],
    ] as const) solid(tubePink, bxx - 0.06, bxx - 0.01, cz + c, cz + d, a, b, false);
    smear("#ff3fd1", bxx, cz, 10, 5, -1, 0, 0.14);
    redrawBoard();
  }

  // ---- The DJ booth and dance floor (south-east corner) ---------------------
  const dancefloor: THREE.MeshBasicMaterial[] = [];
  {
    const dx = x1 - 3;
    const dz = z1 - 3.4;
    // The desk, facing the room.
    solid(black, dx - 0.5, dx + 0.5, dz - 1.4, dz + 1.4, 0, 1.1);
    solid(pink, dx - 0.52, dx - 0.5, dz - 1.4, dz + 1.4, 0.15, 0.22, false);
    solid(cyan, dx - 0.52, dx - 0.5, dz - 1.4, dz + 1.4, 0.95, 1.0, false);
    for (const oz of [-0.6, 0.6]) {
      cyl(black, 0.3, 0.04, dx, 1.13, dz + oz, 20);
      cyl(chrome, 0.05, 0.05, dx, 1.16, dz + oz, 10);
    }
    solid(chrome, dx - 0.15, dx + 0.15, dz - 0.15, dz + 0.15, 1.1, 1.18, false);
    // Speaker stacks.
    const cone = mat(new THREE.MeshStandardMaterial({ color: 0x24242e, roughness: 0.4 }));
    for (const oz of [-2.3, 2.3]) {
      const sz = dz + oz;
      if (sz + 0.6 > z1 - T) continue;
      solid(black, dx - 0.4, dx + 0.6, sz - 0.6, sz + 0.6, 0, 2.6);
      for (const y of [0.6, 1.4, 2.1]) {
        const c = cyl(cone, y > 2 ? 0.22 : 0.36, 0.06, dx - 0.42, y, sz, 20);
        c.rotation.z = Math.PI / 2;
      }
      solid(pink, dx - 0.42, dx - 0.4, sz - 0.6, sz + 0.6, 2.55, 2.6, false);
    }
    solid(black, dx - 0.4, dx + 0.6, z1 - T - 1.0, z1 - T, 0, 2.6);
    const djSign = mat(new THREE.MeshBasicMaterial({ map: tex(neonTex("DJ VIBEY", "#38e8ff", 768, 192, "")), transparent: true, depthWrite: false }));
    plane(djSign, 3.2, 0.8, dx + 0.6, 3.4, dz, -Math.PI / 2);
    halo("#38e8ff", 5, 2.2, dx + 0.62, 3.4, dz, -Math.PI / 2, 0.22);
    // The light-up dance floor in front of the booth.
    const tile = new THREE.PlaneGeometry(0.96, 0.96);
    geos.push(tile);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      const m = mat(onFloor(new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })));
      dancefloor.push(m);
      const t = new THREE.Mesh(tile, m);
      t.rotation.x = -Math.PI / 2;
      t.position.set(dx - 1.5 - i, 0.09, dz - 1.5 + j);
      t.renderOrder = 1;
      group.add(t);
    }
  }

  // ---- The prize counter and the shelf of what you won ---------------------
  const prizeModels = new Map<string, { model: THREE.Group; mystery: THREE.Mesh; tag: THREE.Mesh }>();
  {
    const px = cx - 8;
    const pz = cz - 8;
    solid(black, px - 1.8, px + 1.8, pz - 0.5, pz + 0.5, 0, 1.05);
    solid(pink, px - 1.82, px + 1.82, pz + 0.5, pz + 0.52, 0.9, 1.0, false);
    solid(cyan, px - 1.82, px + 1.82, pz + 0.5, pz + 0.52, 0.12, 0.17, false);
    const glass = mat(new THREE.MeshStandardMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.22, roughness: 0.05 }));
    solid(glass, px - 1.75, px + 1.75, pz - 0.45, pz + 0.45, 1.05, 1.5, false);
    // Tickets piled in the case.
    const ticketM = mat(new THREE.MeshStandardMaterial({ color: 0xff5f7a, roughness: 0.8 }));
    for (let i = 0; i < 12; i++) solid(ticketM, px - 1.5 + i * 0.25, px - 1.36 + i * 0.25, pz - 0.2, pz + 0.05, 1.05, 1.08 + (i % 3) * 0.02, false);
    smear("#ff3fd1", px, pz + 0.52, 3.6, 1.6, 0, 1, 0.3);
    // The shelf, against the north wall behind the counter.
    const sz = z0 + T + 0.35;
    const shelfM = mat(new THREE.MeshStandardMaterial({ color: 0x241840, roughness: 0.6 }));
    solid(shelfM, px - 2.4, px + 2.4, sz - 0.3, sz + 0.3, 0, 0.08);
    for (const y of [0.9, 1.75, 2.6]) {
      solid(shelfM, px - 2.4, px + 2.4, sz - 0.3, sz + 0.3, y - 0.05, y);
      solid(cyan, px - 2.4, px + 2.4, sz + 0.3, sz + 0.32, y - 0.05, y - 0.02, false);
    }
    for (const ex of [-2.4, 2.4]) solid(shelfM, px + ex - 0.05, px + ex + 0.05, sz - 0.3, sz + 0.3, 0, 2.6);
    const qMat = mat(new THREE.MeshBasicMaterial({ map: tex(neonTex("?", "#a66bff", 128, 128)), transparent: true, opacity: 0.8 }));
    const qGeo = new THREE.BoxGeometry(0.26, 0.26, 0.26);
    geos.push(qGeo);
    PRIZES.forEach((p, i) => {
      const row = Math.floor(i / 3);
      const col = i % 3;
      const y = [0.9, 1.75, 2.6][2 - row] ?? 0.9;
      const x = px - 1.55 + col * 1.55;
      const model = buildPrize(p.id);
      model.position.set(x, y, sz);
      model.visible = false;
      group.add(model);
      const mystery = new THREE.Mesh(qGeo, qMat);
      mystery.position.set(x, y + 0.14, sz);
      group.add(mystery);
      const tagM = mat(new THREE.MeshBasicMaterial({ map: tex(neonTex(`🎟️${p.cost}`, "#ffe14d", 256, 96, "")), transparent: true, depthWrite: false }));
      const tag = plane(tagM, 0.6, 0.22, x, y - 0.17, sz + 0.33, 0);
      prizeModels.set(p.id, { model, mystery, tag });
    });
    const yours = mat(new THREE.MeshBasicMaterial({ map: tex(neonTex("PRIZES", "#ff3fd1", 768, 192, "")), transparent: true, depthWrite: false }));
    plane(yours, 3.2, 0.8, px, 3.2, sz + 0.05, 0);
    station({ key: "prizes", title: "Prize Counter", emoji: "🎟️", route: "", accent: "#ff3fd1", at: [px, pz + 1.3], reach: 1.9, kind: "prizes" });
  }

  // ---- The mirror ball, beams and haze -------------------------------------
  const ballGroup = new THREE.Group();
  const spots = new THREE.Group();
  const beams: Array<{ mesh: THREE.Mesh; m: THREE.MeshBasicMaterial; phase: number }> = [];
  const hazeMats: THREE.SpriteMaterial[] = [];
  {
    const mb = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 24, 16),
      mat(new THREE.MeshBasicMaterial({ map: tex(mirrorTex()) })),
    );
    geos.push(mb.geometry);
    ballGroup.add(mb);
    ballGroup.position.set(cx - 2, 6.6, cz);
    group.add(ballGroup);
    solid(chrome, cx - 2.01, cx - 1.99, cz - 0.01, cz + 0.01, 7.0, H - 0.4, false);
    const glint = new THREE.Sprite(mat(new THREE.SpriteMaterial({ map: blob, color: 0xffffff, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false })));
    glint.scale.set(2.2, 2.2, 1);
    ballGroup.add(glint);
    // Light spots thrown on the floor, turning with the ball.
    const spotGeo = new THREE.PlaneGeometry(0.5, 0.5);
    geos.push(spotGeo);
    const spotCols = [0xffffff, 0xff3fd1, 0x38e8ff, 0xffe14d];
    const spotMats = spotCols.map((c) => onFloor(additive(c, blob, 0.55)));
    const N = low ? 14 : 34;
    let s = 11;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < N; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 2 + rnd() * 9;
      const sp = new THREE.Mesh(spotGeo, spotMats[i % spotMats.length]);
      sp.rotation.x = -Math.PI / 2;
      sp.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      sp.scale.setScalar(0.5 + rnd() * 0.6);
      sp.renderOrder = 1;
      spots.add(sp);
    }
    spots.position.set(cx - 2, 0.09, cz);
    group.add(spots);
    // Coloured beams from fixtures in the ceiling, sweeping.
    const beamGeo = new THREE.ConeGeometry(1.6, 7.4, 20, 1, true).translate(0, -3.7, 0);
    geos.push(beamGeo);
    const beamSpots: Array<[number, number, string]> = low
      ? [[cx - 6, cz - 4, "#ff3fd1"], [cx + 4, cz + 4, "#38e8ff"]]
      : [[cx - 6, cz - 4, "#ff3fd1"], [cx + 4, cz + 4, "#38e8ff"], [cx + 4, cz - 4, "#a66bff"], [cx - 6, cz + 4, "#ffe14d"]];
    beamSpots.forEach(([bx, bz, c], i) => {
      const m = additive(c, fade, 0.09);
      const b = new THREE.Mesh(beamGeo, m);
      b.position.set(bx, H - 0.5, bz);
      b.renderOrder = 4;
      group.add(b);
      solid(black, bx - 0.15, bx + 0.15, bz - 0.15, bz + 0.15, H - 0.75, H - 0.4, false);
      beams.push({ mesh: b, m, phase: i * 1.7 });
    });
    // Haze: a few huge, faint sprites up in the room.
    const hazeN = low ? 2 : 4;
    for (let i = 0; i < hazeN; i++) {
      const hm = mat(new THREE.SpriteMaterial({ map: blob, color: i % 2 ? 0x7a3cff : 0xff3fd1, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false }));
      hazeMats.push(hm);
      const h = new THREE.Sprite(hm);
      h.scale.set(14, 7, 1);
      h.position.set(cx - 6 + (i % 2) * 10, 5.2, cz - 5 + Math.floor(i / 2) * 10);
      group.add(h);
    }
  }

  // ---- The regulars --------------------------------------------------------
  interface Regular { avatar: Avatar; base: THREE.Vector3; yaw: number; dance: boolean; emotes: string[]; next: number }
  const regulars: Regular[] = [];
  {
    const cast: Array<{ char: string; at: [number, number]; yaw: number; dance?: boolean; emotes: string[]; keep?: boolean }> = [
      { char: "pixel", at: [x1 - 2.4, z1 - 3.4], yaw: -Math.PI / 2, dance: true, emotes: ["🎧", "🔥", "🎶"], keep: true }, // the DJ
      { char: "bolt", at: [cx + 2.5, cz - 7.8], yaw: -0.9, emotes: ["🎱", "😤", "🎯"], keep: true },
      { char: "aurora", at: [x1 - 5.2, z1 - 4.2], yaw: 0.6, dance: true, emotes: ["💃", "✨", "🎶"] },
      { char: "sprout", at: [x1 - 6.0, z1 - 2.6], yaw: 2.2, dance: true, emotes: ["🕺", "🙌"] },
      { char: "pip", at: [x1 - 4.2, cz - 4.6], yaw: Math.PI / 2 - 0.3, emotes: ["👀", "🏆", "😮"] },
      { char: "eddie", at: [cx + 2.25, cz + 6.5], yaw: -Math.PI / 2, emotes: ["⚽", "🙌", "😆"] },
    ];
    for (const [i, c] of cast.entries()) {
      if (low && !c.keep) continue;
      const avatar = createAvatar({ id: `arcade-${i}`, name: "", char: c.char, noTag: true });
      avatar.group.position.set(c.at[0], 0.05, c.at[1]);
      avatar.group.rotation.y = c.yaw;
      avatar.group.visible = false;
      group.add(avatar.group);
      regulars.push({ avatar, base: avatar.group.position.clone(), yaw: c.yaw, dance: !!c.dance, emotes: c.emotes, next: 3 + i * 2.3 });
    }
  }

  // ---- Living screens: which ones play -------------------------------------
  const MAX_PLAYING = low ? 1 : 5;
  const fit = (t: THREE.Texture, iw: number, ih: number, w: number, h: number) => {
    const a = iw / ih;
    const s = w / h;
    t.repeat.set(1, 1);
    t.offset.set(0, 0);
    if (a > s) {
      t.repeat.x = s / a;
      t.offset.x = (1 - t.repeat.x) / 2;
    } else {
      t.repeat.y = a / s;
      t.offset.y = (1 - t.repeat.y) / 2;
    }
  };
  const loader = new THREE.TextureLoader();
  const wake = (s: Screen) => {
    if (s.failed || s.live) {
      if (s.video && s.video.paused) void s.video.play().catch(() => undefined);
      return;
    }
    if (s.clip && !s.video) {
      const v = document.createElement("video");
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.setAttribute("playsinline", "");
      v.preload = "auto";
      v.src = s.clip;
      s.video = v;
      v.addEventListener("error", () => {
        // No H.264 here (some open-source builds), or the clip went missing:
        // fall back to the still.
        s.video = undefined;
        s.clip = undefined;
        wake(s);
      }, { once: true });
      v.addEventListener("loadeddata", () => {
        const t = tex(new THREE.VideoTexture(v));
        t.colorSpace = THREE.SRGBColorSpace;
        fit(t, v.videoWidth || 16, v.videoHeight || 9, s.w, s.h);
        s.live = t;
        s.mat.map = t;
        s.mat.needsUpdate = true;
      }, { once: true });
      void v.play().catch(() => undefined);
      return;
    }
    if (!s.clip && s.still && !s.live) {
      s.failed = true; // only try once
      loader.load(s.still, (t) => {
        texs.push(t);
        t.colorSpace = THREE.SRGBColorSpace;
        const img = t.image as HTMLImageElement;
        fit(t, img.width, img.height, s.w, s.h);
        // Zoom in a touch so there is room to pan, like an attract loop.
        t.repeat.multiplyScalar(0.8);
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
        s.live = t;
        s.mat.map = t;
        s.mat.needsUpdate = true;
      });
    }
  };
  const sleep = (s: Screen) => {
    if (s.video && !s.video.paused) s.video.pause();
  };

  // ---- The dive ------------------------------------------------------------
  let diving: { from: THREE.Vector3; fromLook: THREE.Vector3; to: THREE.Vector3; toLook: THREE.Vector3; fov0: number; t0: number; done: (() => void) | null } | null = null;
  const DIVE_MS = 900;
  const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const shotOut: CameraShot = { eye: new THREE.Vector3(), look: new THREE.Vector3(), fov: 60 };

  const entrance = new THREE.Vector3(x0 + 2.5, 0, cz);
  const flat = new THREE.Vector3();
  let wasInside = false;
  let lastNearKey: string | null = null;
  let pageT = 0;
  const tmp = new THREE.Vector3();
  const beatPink = new THREE.Color(0xff3fd1);
  const beatCyan = new THREE.Color(0x38e8ff);
  const danceCols = [0xff3fd1, 0x38e8ff, 0xffe14d, 0x7cff6b, 0xa66bff].map((c) => new THREE.Color(c));

  const inside = (p: THREE.Vector3) => p.x > x0 && p.x < x1 && p.z > z0 && p.z < z1 && p.y < H - 0.5;

  return {
    group,
    boxes,
    stations,
    entrance,
    music,
    contains: inside,
    nearest(p) {
      if (p.y > 2.5 || p.x < x0 || p.x > x1 || p.z < z0 || p.z > z1) return null;
      flat.set(p.x, 0, p.z);
      let best: ArcadeStation | null = null;
      let bestD = Infinity;
      for (const s of stations) {
        const d = flat.distanceTo(s.at);
        if (d < s.reach && d < bestD) {
          best = s;
          bestD = d;
        }
      }
      return best;
    },
    dive(st, camera, done) {
      // The screen of this station that faces the camera.
      let best: Screen | null = null;
      let bestDot = -Infinity;
      for (const s of screens) {
        if (s.station !== st.key) continue;
        const d = tmp.copy(camera.position).sub(s.center).dot(s.normal);
        if (d > bestDot) {
          bestDot = d;
          best = s;
        }
      }
      music.coin();
      if (!best) {
        done();
        return;
      }
      const fov1 = 42;
      const dist = (best.h * 0.62) / Math.tan(THREE.MathUtils.degToRad(fov1 / 2));
      const fromLook = new THREE.Vector3();
      camera.getWorldDirection(fromLook);
      fromLook.multiplyScalar(6).add(camera.position);
      diving = {
        from: camera.position.clone(),
        fromLook,
        to: best.center.clone().addScaledVector(best.normal, dist),
        toLook: best.center.clone(),
        fov0: camera.fov,
        t0: performance.now(),
        done,
      };
    },
    endDive() {
      diving = null;
    },
    cameraShot(now) {
      if (!diving) return null;
      const k = Math.min(1, (now - diving.t0) / DIVE_MS);
      const e = ease(k);
      shotOut.eye.lerpVectors(diving.from, diving.to, e);
      shotOut.look.lerpVectors(diving.fromLook, diving.toLook, Math.min(1, e * 1.5));
      shotOut.fov = THREE.MathUtils.lerp(diving.fov0, 42, e);
      if (k >= 1 && diving.done) {
        const d = diving.done;
        diving.done = null;
        d();
      }
      return shotOut;
    },
    setBoard(b) {
      board = b;
      redrawBoard();
    },
    setPrizes(owned) {
      for (const [id, p] of prizeModels) {
        const has = owned.includes(id);
        p.model.visible = has;
        p.mystery.visible = !has;
        p.tag.visible = !has;
      }
    },
    update(dt, now, player) {
      const near = Math.abs(player.x - cx) < 160 && Math.abs(player.z - cz) < 160;
      const isIn = inside(player);
      if (!near) {
        if (wasInside) for (const s of screens) sleep(s);
        wasInside = false;
        music.setLevel(0);
        return;
      }
      const t = now / 1000;
      const beat = music.beat();
      const bf = beat - Math.floor(beat);
      const pulse = Math.pow(1 - bf, 3); // 1 on the beat, falling away
      const bar = Math.floor(beat / 4);

      // Chasing bulbs: a slow march, one step a beat, so it reads as a
      // marquee and not as a warning light.
      const step = Math.floor(beat);
      for (let i = 0; i < bulbs.length; i++) bulbs[i].material = (i + step) % 3 === 0 ? bulbOff : bulbOn;
      // The big sign buzzes now and then, like a real one.
      const buzz = Math.sin(t * 0.7) > 0.96 && Math.sin(t * 47) > 0;
      signMesh.visible = !buzz;

      // The music: loud by the booth, quiet at the door, a murmur outside.
      const dj = Math.hypot(player.x - (x1 - 3), player.z - (z1 - 3.4));
      const door = Math.hypot(player.x - x0, player.z - cz);
      music.setLevel(isIn ? 0.55 + 0.45 * Math.max(0, 1 - dj / 18) : Math.max(0, 0.25 * (1 - door / 14)));

      if (!isIn && !wasInside && door > 30) return;

      // Everything below is the inside of the room.
      const glow = 0.75 + 0.5 * pulse;
      tubePink.color.copy(beatPink).multiplyScalar(0.7 + 0.3 * pulse);
      tubeCyan.color.copy(beatCyan).multiplyScalar(0.7 + 0.3 * pulse);
      floorMat.emissiveIntensity = 0.45 + 0.45 * pulse;
      for (const [i, b] of beams.entries()) {
        b.mesh.rotation.z = Math.sin(t * 0.5 + b.phase) * 0.45;
        b.mesh.rotation.x = Math.cos(t * 0.37 + b.phase) * 0.35;
        b.m.opacity = 0.05 + 0.07 * (((bar + i) % 2 === 0) ? pulse : pulse * 0.4);
      }
      for (const h of hazeMats) h.opacity = 0.05 + 0.03 * glow;
      ballGroup.rotation.y += dt * 0.6;
      spots.rotation.y -= dt * 0.35;
      dancefloor.forEach((m, i) => {
        const on = (i * 7 + Math.floor(beat)) % 5;
        m.color.copy(danceCols[on]).multiplyScalar(0.35 + 0.55 * pulse * (((i + Math.floor(beat)) % 3) === 0 ? 1 : 0.4));
      });
      scan.offset.y = (t * 0.25) % 1;
      // Lava lamp blobs drift.
      const lamp = prizeModels.get("lava-lamp")?.model;
      if (lamp?.visible) lamp.children.forEach((c, i) => { if (c.name === "blob") c.position.y = 0.3 + Math.sin(t * 0.8 + i * 2) * 0.09; });

      // The wall turns its page now and then.
      pageT += dt;
      if (pageT > 9) {
        pageT = 0;
        boardPage = (boardPage + 1) % pages;
        redrawBoard();
      }

      // Living screens: the nearest few play, the rest hold their card.
      if (isIn) {
        const ranked = screens
          .map((s) => ({ s, d: Math.hypot(s.center.x - player.x, s.center.z - player.z) }))
          .sort((a, b) => a.d - b.d);
        let playing = 0;
        const woke = new Set<string>();
        for (const { s } of ranked) {
          // A still costs nothing once loaded; only clips are rationed.
          if (!s.clip) {
            wake(s);
            continue;
          }
          // Both faces of a hung screen count as one.
          const already = woke.has(s.station);
          if (playing < MAX_PLAYING || already) {
            wake(s);
            if (!already) {
              woke.add(s.station);
              playing++;
            }
          } else sleep(s);
        }
        // A still pans slowly, like an attract loop.
        for (const s of screens) {
          if (!s.live || s.video) continue;
          const r = s.live.repeat;
          s.live.offset.x = (1 - r.x) * (0.5 + 0.5 * Math.sin(t * 0.15 + s.pan));
          s.live.offset.y = (1 - r.y) * (0.5 + 0.5 * Math.cos(t * 0.11 + s.pan));
        }
      } else if (wasInside) for (const s of screens) sleep(s);
      wasInside = isIn;

      // An attract jingle from whatever you just walked up to.
      const st = this.nearest(player);
      const key = st && st.kind === "game" ? st.key : null;
      if (key && key !== lastNearKey) music.attract(key.length * 7 + key.charCodeAt(0));
      lastNearKey = key;

      // The regulars.
      for (const r of regulars) {
        const g = r.avatar.group;
        g.visible = isIn || door < 14;
        if (!g.visible) continue;
        if (r.dance) {
          g.position.y = r.base.y + Math.abs(Math.sin(beat * Math.PI)) * 0.08;
          g.rotation.y = r.yaw + Math.sin(beat * Math.PI * 0.5) * 0.35;
        }
        r.next -= dt;
        if (r.next <= 0) {
          r.next = 6 + Math.random() * 7;
          r.avatar.emote(r.emotes[Math.floor(Math.random() * r.emotes.length)]);
        }
        r.avatar.update(dt, 0, false);
      }
    },
    dispose() {
      music.dispose();
      for (const s of screens) {
        if (s.video) {
          s.video.pause();
          s.video.removeAttribute("src");
          s.video.load();
        }
      }
      for (const r of regulars) r.avatar.dispose();
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry && !geos.includes(m.geometry)) geos.push(m.geometry);
        const mm = m.material as THREE.Material | THREE.Material[] | undefined;
        if (mm && !Array.isArray(mm) && !mats.includes(mm)) mats.push(mm);
      });
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
      texs.forEach((t) => t.dispose());
    },
  };
}
