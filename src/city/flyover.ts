/**
 * The flyover behind the character picker.
 *
 * Before a visitor presses Enter, the city is already loaded and rendering
 * underneath the picker: it always was, behind a painted backdrop that hid
 * it. A flyover puts the camera on a slow drone path instead and lets the
 * picker sit on top of the real thing, so the background is whatever Vibe
 * City looks like today (its sky, its weather, whoever the Wizard granted a
 * statue to this morning) with no video to keep up to date.
 *
 * Pure: a path is a function of seconds, so the frame loop (camera) and the
 * picker (captions, dips to black) read the same clock and always agree.
 *
 * Coordinates are the city's own: the district is a 360 m square centred on
 * the origin, Vibe Island floats at (330, 120, -30), the bridge leaves the
 * west shore at z = -140.
 */
import * as THREE from "three";

export type FlyoverId = "drone" | "glide" | "tour";
export const FLYOVER_IDS: FlyoverId[] = ["drone", "glide", "tour"];

export interface FlyoverShot {
  eye: THREE.Vector3;
  look: THREE.Vector3;
  fov: number;
  /** Where the camera is, for a caption. */
  label: string;
  /** 0..1, how far dipped to black (the tour cuts between shots). */
  fade: number;
}

export function flyoverFromSearch(search: string): FlyoverId | "classic" | null {
  const v = new URLSearchParams(search).get("entry");
  if (v === "classic") return "classic";
  return (FLYOVER_IDS as string[]).includes(v ?? "") ? (v as FlyoverId) : null;
}

const eye = new THREE.Vector3();
const look = new THREE.Vector3();
const tmp = new THREE.Vector3();

/* A: one slow, high orbit round downtown. Two minutes a lap. */
function drone(t: number): FlyoverShot {
  const a = (t / 120) * Math.PI * 2 + 2.2;
  const r = 290 + Math.sin(t * 0.05) * 25;
  eye.set(Math.sin(a) * r, 135 + Math.sin(t * 0.08) * 18, Math.cos(a) * r);
  look.set(Math.sin(a + 0.35) * 30, 28, Math.cos(a + 0.35) * 30);
  return { eye, look, fov: 50, label: "Over downtown", fade: 0 };
}

/* B: a lower glide through the landmarks, as a closed loop. */
const GLIDE_POINTS = [
  [-215, 46, 120], // over the marina
  [-110, 58, 150], // the park and the pitch
  [10, 72, 175], // past the Eiffel Tower
  [120, 78, 110],
  [175, 92, 0], // round the Space Needle
  [120, 100, -120],
  [10, 110, -175], // behind the Empire State
  [-120, 70, -205],
  [-270, 48, -170], // out along the bridge
  [-330, 42, -70],
  [-290, 44, 40],
].map(([x, y, z]) => new THREE.Vector3(x, y, z));
const GLIDE = new THREE.CatmullRomCurve3(GLIDE_POINTS, true, "centripetal");
const GLIDE_LAP = 160;
const GLIDE_LABELS = [
  "The marina",
  "Vibe Commons",
  "The Eiffel Tower",
  "Downtown",
  "The Space Needle",
  "Downtown",
  "The Empire State",
  "The bay",
  "Vibe Gate Bridge",
  "The Rock",
  "The marina",
];
function glide(t: number): FlyoverShot {
  const u = ((t / GLIDE_LAP) % 1 + 1) % 1;
  GLIDE.getPointAt(u, eye);
  // Look a little ahead and in toward the middle of town, so the city
  // stays in frame while the camera banks round it.
  GLIDE.getPointAt((u + 0.035) % 1, tmp);
  look.copy(tmp).lerp(new THREE.Vector3(0, 20, 0), 0.45);
  look.y = Math.min(look.y, eye.y - 18);
  const label = GLIDE_LABELS[Math.floor(u * GLIDE_LABELS.length) % GLIDE_LABELS.length];
  return { eye, look, fov: 56, label, fade: 0 };
}

/* C: a postcard tour. Slow pushes on each landmark, dipping between them. */
type Card = { label: string; from: number[]; to: number[]; look: number[]; fov: number };
const TOUR: Card[] = [
  { label: "Vibe Gate Bridge", from: [-140, 52, -50], to: [-175, 40, -72], look: [-380, 18, -140], fov: 52 },
  { label: "The Eiffel Tower", from: [-80, 22, -10], to: [-62, 28, 12], look: [20, 55, 100], fov: 54 },
  { label: "The Empire State", from: [60, 30, 75], to: [45, 42, 55], look: [-40, 85, -80], fov: 52 },
  { label: "Vibe Island", from: [215, 150, 70], to: [235, 140, 50], look: [330, 112, -30], fov: 55 },
  { label: "The Space Needle", from: [-30, 25, 50], to: [-8, 34, 32], look: [80, 62, -40], fov: 54 },
  { label: "The marina", from: [-195, 30, 118], to: [-205, 22, 100], look: [-245, 0, 55], fov: 55 },
];
const CARD_SECONDS = 9;
const DIP = 0.7;
function tour(t: number): FlyoverShot {
  const i = Math.floor(t / CARD_SECONDS);
  const card = TOUR[((i % TOUR.length) + TOUR.length) % TOUR.length];
  const local = t - i * CARD_SECONDS;
  const s = local / CARD_SECONDS;
  const ease = s * s * (3 - 2 * s);
  eye.set(card.from[0], card.from[1], card.from[2]).lerp(tmp.set(card.to[0], card.to[1], card.to[2]), ease);
  look.set(card.look[0], card.look[1], card.look[2]);
  const edge = Math.min(local, CARD_SECONDS - local);
  const fade = edge < DIP ? 1 - edge / DIP : 0;
  return { eye, look, fov: card.fov, label: card.label, fade };
}

export function flyoverShot(id: FlyoverId, seconds: number): FlyoverShot {
  if (id === "glide") return glide(seconds);
  if (id === "tour") return tour(seconds);
  return drone(seconds);
}
