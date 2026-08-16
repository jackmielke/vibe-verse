/**
 * The Midnight Zone — the survey.
 *
 * The reason to slow down. Point the sub at something and hold the scan; a ring
 * closes; the animal goes in the log with its name, its latin, and one true
 * sentence about it. Twelve species, and the last of them only exists below
 * six kilometres.
 *
 * The design constraint that shaped it: **it must not turn the ocean into a
 * shooting gallery.** So there is no crosshair discipline and no timing — you
 * hold it, and drifting off target only pauses the ring rather than resetting
 * it. The difficulty is entirely in *finding* the animal in the dark, which is
 * the thing the world is actually about. Getting the scan itself to complete
 * should never be the interesting part.
 *
 * Progress is persisted, so the log is a record of everything you have ever
 * found rather than of this dive. Coming back to catch the two you missed is a
 * better reason to return than a score.
 */
import * as THREE from "three";
import type { CameraService } from "../engine/camera";
import {
  type CreatureInstance,
  type CreatureService,
  type DeepCtx,
  type LogService,
  type SubService,
  type System,
} from "../types";
import { SPECIES, SPECIES_BY_ID } from "../life/species";

const STORE_KEY = "deep:log";
/** How far the scanner reaches. A little past the lamps, so it rewards nerve. */
const RANGE = 34;
/** Seconds of held scan to complete one. */
const DWELL = 1.5;
/** Cone half-angle the target must sit inside, radians. Generous on purpose. */
const CONE = 0.42;

export interface ScanService {
  /** What is currently in the reticle, or null. */
  target: CreatureInstance | null;
  /** 0..1 while scanning. */
  progress: number;
  /** Set for a moment after a successful scan, for the HUD to celebrate. */
  justFound: string | null;
  range: number;
}

function loadFound(): string[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Filter against the roster so a renamed species cannot resurrect a ghost
    // entry that the log would then render as a blank card.
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string" && SPECIES_BY_ID.has(id)) : [];
  } catch {
    return [];
  }
}

export default function createScan(ctx: DeepCtx): System {
  const found = loadFound();
  const log: LogService = {
    found,
    has: (id) => found.includes(id),
    total: SPECIES.length,
  };
  ctx.services.log = log;

  const scan: ScanService = { target: null, progress: 0, justFound: null, range: RANGE };
  ctx.services.scan = scan;

  const forward = new THREE.Vector3();
  const toTarget = new THREE.Vector3();
  let holding = false;
  let celebrate = 0;

  /**
   * Whether F is *held*, which the shared input contract cannot answer.
   *
   * `ctx.input` clears its edges every frame by design, and the scanner needs
   * a level rather than an edge. These live on the system rather than at module
   * scope so they come off with it — a world that leaves listeners on `window`
   * keeps reacting to keys after the visitor has gone somewhere else, and that
   * is a bug you find three worlds later.
   */
  const heldKeys = new Set<string>();
  const onDown = (e: KeyboardEvent) => heldKeys.add(e.key.toLowerCase());
  const onUp = (e: KeyboardEvent) => heldKeys.delete(e.key.toLowerCase());
  const onBlur = () => heldKeys.clear();
  window.addEventListener("keydown", onDown);
  window.addEventListener("keyup", onUp);
  window.addEventListener("blur", onBlur);
  const isHeld = () => heldKeys.has("f");

  // The scan ring, drawn in the world around the target rather than on the
  // HUD: it has to sit *at* the animal's distance or the eye cannot tell which
  // of two overlapping creatures is being surveyed.
  const ringGeo = new THREE.RingGeometry(0.86, 1, 48, 1, 0, Math.PI * 2);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x7ff0ff,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    depthTest: false,
    fog: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.renderOrder = 20;
  ring.visible = false;
  ctx.scene.add(ring);

  function complete(target: CreatureInstance): void {
    if (!log.has(target.speciesId)) {
      found.push(target.speciesId);
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(found));
      } catch {
        // Private browsing. The dive still works; the log just will not keep.
      }
      ctx.emit("scan:new", { speciesId: target.speciesId, total: found.length });
    } else {
      ctx.emit("scan:again", { speciesId: target.speciesId });
    }
    target.scanned = true;
    scan.justFound = target.speciesId;
    celebrate = 3.4;
    (ctx.services.camera as CameraService | undefined)?.shake?.(0.22);
  }

  return {
    update(dt) {
      const sub = ctx.services.sub as SubService | undefined;
      const creatures = ctx.services.creatures as CreatureService | undefined;
      if (celebrate > 0) {
        celebrate -= dt;
        if (celebrate <= 0) scan.justFound = null;
      }
      if (!sub || !creatures) {
        scan.target = null;
        ring.visible = false;
        return;
      }

      if (ctx.input.scanPressed) holding = true;
      // Held scanning on keyboard means holding F; the edge sets `holding` and
      // releasing the key clears it. Touch fires the edge repeatedly, which
      // works out to the same thing.
      if (!ctx.input.scanPressed && !isHeld()) holding = false;

      // Aim from the hull, down its own axis — not from the camera. The camera
      // lags on purpose, and scanning through a lagging reticle feels broken.
      forward.set(0, 0, 1).applyQuaternion(sub.object.quaternion);

      let best: CreatureInstance | null = null;
      let bestScore = Infinity;
      for (const c of creatures.alive()) {
        toTarget.copy(c.position).sub(sub.position);
        const dist = toTarget.length();
        if (dist > RANGE || dist < 0.4) continue;
        toTarget.divideScalar(dist);
        const angle = Math.acos(THREE.MathUtils.clamp(toTarget.dot(forward), -1, 1));
        if (angle > CONE) continue;
        // Prefer centred over close: two animals in frame, the one you are
        // pointing at wins.
        const score = angle * 2.2 + dist / RANGE;
        if (score < bestScore) {
          bestScore = score;
          best = c;
        }
      }

      // Losing the target pauses rather than resets. See the note at the top.
      if (best !== scan.target) {
        scan.target = best;
      }

      if (holding && best) {
        scan.progress = Math.min(1, scan.progress + dt / DWELL);
        if (scan.progress >= 1) {
          complete(best);
          scan.progress = 0;
          holding = false;
        }
      } else if (!best) {
        scan.progress = Math.max(0, scan.progress - dt * 0.35);
      }

      // -- the ring ---------------------------------------------------------
      if (best) {
        ring.visible = true;
        ring.position.copy(best.position);
        ring.quaternion.copy(ctx.camera.quaternion);
        const size = Math.max(0.8, best.size * 1.5);
        // Closes as it fills — the scale *is* the progress bar.
        const closing = 1 - scan.progress * 0.42;
        ring.scale.setScalar(size * closing);
        ringMat.opacity = 0.35 + scan.progress * 0.6;
        ringMat.color.setHex(log.has(best.speciesId) ? 0x8fa8b8 : 0x7ff0ff);
      } else {
        ring.visible = false;
      }
    },

    dispose() {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
      ctx.scene.remove(ring);
      ringGeo.dispose();
      ringMat.dispose();
      if (ctx.services.scan === scan) delete ctx.services.scan;
      if (ctx.services.log === log) delete ctx.services.log;
    },
  };

}
