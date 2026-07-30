/**
 * World → screen projection for the HUD, computed from `frame` alone.
 *
 * The marker layer lives in the DOM, outside the R3F canvas, so it has no
 * access to the THREE camera. It does not need one: `frame` carries the eye
 * position, an orthonormal camera basis and the live FOV, which is exactly a
 * camera. Re-deriving the projection here keeps the marker system decoupled
 * from the render tree — and lets it keep working in photo mode, where the
 * camera is somewhere else entirely.
 *
 * Everything writes into a caller-supplied result object. Nothing in this
 * file allocates; it runs for every marker, every frame.
 */
import { PLAYER } from "../config";
import { frame } from "../state/store";
import { photoRig } from "./photo";

export interface Projected {
  /** Screen pixels, already clamped if `clamped` is true. */
  x: number;
  y: number;
  /** True when the target is behind the camera plane. */
  behind: boolean;
  /** True when the marker had to be pushed to the screen edge. */
  clamped: boolean;
  /** Metres from the eye. */
  distance: number;
  /** Rotation in degrees for an edge arrow to point at the true position. */
  edgeAngle: number;
  /** 0..1 how far off-centre — used to fade distant markers. */
  offCentre: number;
}

export function makeProjected(): Projected {
  return { x: 0, y: 0, behind: false, clamped: false, distance: 0, edgeAngle: 0, offCentre: 0 };
}

/**
 * The eye is the capsule centre lifted to eye height. `frame.position` is the
 * capsule centre by contract, so the offset is half the capsule plus the eye
 * offset — a constant, and one that costs nothing to get right.
 */
const EYE_OFFSET = PLAYER.eyeHeight - PLAYER.height * 0.5;

/**
 * Project a world point.
 *
 * `inset` is the margin (px) kept between a clamped marker and the viewport
 * edge, so an arrow is never half-cropped.
 */
export function project(
  wx: number,
  wy: number,
  wz: number,
  viewW: number,
  viewH: number,
  out: Projected,
  inset = 56,
): Projected {
  // Photo mode flies a detached camera; markers must follow it or they will
  // sit in the wrong place in every screenshot.
  const usePhoto = photoRig.active;
  const ex = usePhoto ? photoRig.x : frame.position.x;
  const ey = usePhoto ? photoRig.y : frame.position.y + EYE_OFFSET;
  const ez = usePhoto ? photoRig.z : frame.position.z;

  let fx: number, fy: number, fz: number;
  let rx: number, ry: number, rz: number;
  let ux: number, uy: number, uz: number;
  let fov: number;

  if (usePhoto) {
    const cy = Math.cos(photoRig.yaw);
    const sy = Math.sin(photoRig.yaw);
    const cp = Math.cos(photoRig.pitch);
    const sp = Math.sin(photoRig.pitch);
    fx = -sy * cp;
    fy = sp;
    fz = -cy * cp;
    rx = cy;
    ry = 0;
    rz = -sy;
    // up = right × forward
    ux = ry * fz - rz * fy;
    uy = rz * fx - rx * fz;
    uz = rx * fy - ry * fx;
    fov = photoRig.fov;
  } else {
    fx = frame.forward.x;
    fy = frame.forward.y;
    fz = frame.forward.z;
    rx = frame.right.x;
    ry = frame.right.y;
    rz = frame.right.z;
    ux = frame.up.x;
    uy = frame.up.y;
    uz = frame.up.z;
    fov = frame.fov;
  }

  const dx = wx - ex;
  const dy = wy - ey;
  const dz = wz - ez;

  const camZ = dx * fx + dy * fy + dz * fz;
  const camX = dx * rx + dy * ry + dz * rz;
  const camY = dx * ux + dy * uy + dz * uz;

  out.distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  out.behind = camZ <= 0.05;

  const tanV = Math.tan((fov * 0.5 * Math.PI) / 180);
  const aspect = viewW / Math.max(1, viewH);
  const tanH = tanV * aspect;

  const cx = viewW * 0.5;
  const cy2 = viewH * 0.5;

  if (!out.behind) {
    const ndcX = camX / (camZ * tanH);
    const ndcY = camY / (camZ * tanV);
    const sx = cx + ndcX * cx;
    const sy = cy2 - ndcY * cy2;
    out.offCentre = Math.min(1, Math.hypot(ndcX, ndcY));
    const minX = inset;
    const maxX = viewW - inset;
    const minY = inset;
    const maxY = viewH - inset;
    if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
      out.x = sx;
      out.y = sy;
      out.clamped = false;
      out.edgeAngle = 0;
      return out;
    }
    clampToEdge(sx - cx, sy - cy2, cx, cy2, inset, out);
    return out;
  }

  // Behind the camera: there is no valid projection, so drive the edge marker
  // from the mirrored direction. Negating both axes puts a target directly
  // behind you at the bottom of the screen, which is what every shooter does
  // and what players expect.
  out.offCentre = 1;
  clampToEdge(-camX, camY, cx, cy2, inset, out);
  return out;
}

/**
 * Push a direction out to the border of the inset rectangle and record the
 * angle an arrow should point. `dxs`/`dys` are in screen space (y already
 * flipped for the in-front case, raw camera-space for the behind case, where
 * we flip here).
 */
function clampToEdge(
  dxs: number,
  dysIn: number,
  cx: number,
  cy: number,
  inset: number,
  out: Projected,
): void {
  const dys = out.behind ? dysIn * -1 : dysIn;
  let ax = dxs;
  let ay = dys;
  const len = Math.hypot(ax, ay);
  if (len < 1e-4) {
    ax = 0;
    ay = 1;
  } else {
    ax /= len;
    ay /= len;
  }
  const halfW = cx - inset;
  const halfH = cy - inset;
  // Scale the unit direction until it touches the nearer of the two borders.
  const tx = Math.abs(ax) > 1e-5 ? halfW / Math.abs(ax) : Infinity;
  const ty = Math.abs(ay) > 1e-5 ? halfH / Math.abs(ay) : Infinity;
  const t = Math.min(tx, ty);
  out.x = cx + ax * t;
  out.y = cy + ay * t;
  out.clamped = true;
  out.edgeAngle = (Math.atan2(ay, ax) * 180) / Math.PI + 90;
}

/** Screen-space yaw of the camera, for the compass strip. */
export function cameraYaw(): number {
  return photoRig.active ? photoRig.yaw : frame.yaw;
}

/** Eye position, honouring photo mode. Written into the supplied triple. */
export function eyePosition(out: { x: number; y: number; z: number }): void {
  if (photoRig.active) {
    out.x = photoRig.x;
    out.y = photoRig.y;
    out.z = photoRig.z;
  } else {
    out.x = frame.position.x;
    out.y = frame.position.y + EYE_OFFSET;
    out.z = frame.position.z;
  }
}
