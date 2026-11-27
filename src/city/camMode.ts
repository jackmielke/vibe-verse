/**
 * camMode — the three ways to watch yourself in Vibe City.
 *
 * Jack (Nov 27 2026): "right now you have to change where you're looking all
 * the time by dragging on the screen". So the world controls carry a camera
 * toggle where the Thanksgiving one used to be:
 *
 * - **Default**: the drag-to-orbit camera the city always had.
 * - **Chase**: third person that swings in behind wherever you are facing
 *   while you move, like a driving game does for a car. A drag still looks
 *   around; let go and it settles back behind you after a moment.
 * - **First person**: your own eyes. Drag (or a mouse drag) to look, and the
 *   guns fire where you look.
 *
 * The maths that decides how the chase camera swings is here, pure, so it can
 * be tested without a renderer.
 */

export type CamMode = "default" | "chase" | "first";

export const CAM_MODES: Record<CamMode, { label: string; emoji: string }> = {
  default: { label: "Default view", emoji: "🎥" },
  chase: { label: "Chase cam", emoji: "🏃" },
  first: { label: "First person", emoji: "👀" },
};

const ORDER: CamMode[] = ["default", "chase", "first"];
const KEY = "city.camMode";

export function nextCamMode(m: CamMode): CamMode {
  return ORDER[(ORDER.indexOf(m) + 1) % ORDER.length];
}

export function loadCamMode(search = typeof window !== "undefined" ? window.location.search : ""): CamMode {
  const q = new URLSearchParams(search).get("cam");
  if (q === "default" || q === "chase" || q === "first") return q;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "default" || saved === "chase" || saved === "first") return saved;
  } catch {
    /* private window */
  }
  return "default";
}

export function saveCamMode(m: CamMode) {
  try {
    localStorage.setItem(KEY, m);
  } catch {
    /* private window */
  }
}

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * One frame of the chase camera: how far `camYaw` turns toward sitting behind
 * an avatar facing `faceYaw`.
 *
 * The city's camera sits at `pos + (sin camYaw, cos camYaw) * dist`, and a
 * body facing `yaw` walks along `(sin yaw, cos yaw)`, so "behind" is
 * `faceYaw + PI`.
 *
 * It only follows while you are moving, faster the faster you go, and not at
 * all while you are running back toward the camera: turning round to chase
 * your back as you run at it is a camera that spins in circles, which is the
 * one thing a chase camera must never do.
 */
export function chaseYawStep(camYaw: number, faceYaw: number, speed: number, dt: number): number {
  if (speed < 0.8) return 0;
  const want = wrapAngle(faceYaw + Math.PI - camYaw);
  // How much the avatar faces away from the camera: 1 straight ahead, 0
  // across the screen, -1 running at it.
  const away = Math.cos(want);
  const follow = Math.max(0, away + 0.25) / 1.25;
  if (follow <= 0) return 0;
  const rate = 2.6 * Math.min(1, speed / 5) * follow;
  return want * Math.min(1, dt * rate);
}
