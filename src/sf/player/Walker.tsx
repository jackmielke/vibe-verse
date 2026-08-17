/**
 * Walker — you, on the pavement, in San Francisco.
 *
 * `Explorer` is a camera. This is a *person*: the same Vibeverse character you
 * picked in the lobby, standing at street level with the city at its real
 * scale, which is the only way any of the geometry in this world reads as a
 * place rather than as a model of a place. The Transamerica is 260 m tall and
 * that fact means nothing from 240 m up.
 *
 * The character comes from `@/lib/characterRig`, which is what /city, the
 * lobby, the profile turntable and the memory garden all load through — so
 * whatever you are wearing here you are wearing there, including the half of
 * the catalog that has no `.glb` behind it and is assembled in code. That
 * detail is not incidental: loading Flux is a *synchronous* path through a
 * different branch, and every world that hand-rolled its own `loader.load`
 * instead of going through the rig silently rendered nothing for anyone who
 * had picked one. See the note at the top of `characterRig.ts`.
 *
 * What this file owns beyond the rig:
 *
 *  - **Standing on things.** The ground under a point is the highest of the
 *    terrain, a building roof deck and a landmark surface — so the Golden
 *    Gate's footway, Lombard's switchbacks and Pier 39's boardwalk are all
 *    floor, and so is the roof you land on coming off a hill.
 *  - **Not standing in things.** Buildings and landmark colliders are pushed
 *    out of horizontally, on the smallest axis, in the obstacle's own frame.
 *  - **A camera that does not go through walls.** The chase boom is shortened
 *    until it is in open air, because a third-person camera in a city of
 *    narrow streets spends a lot of its time inside masonry.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { loadCharacterRig, type CharacterRig } from "@/lib/characterRig";
import { findCharacter } from "@/lib/characters";
import { PLAYER } from "../config";
import { frame } from "../state/store";
import { WORLD, clampToWorld, walkableHeight } from "../geo/sfGeo";
import { clamp, damp } from "../math/rng";
import { buildingIndex } from "../world/buildings/spatialIndex";
import type { BuildingRecord } from "../world/buildings/generator";
import {
  landmarkSurfaceHeight,
  queryLandmarkColliders,
  type LandmarkCollider,
} from "../world/landmarks";
import { readMove, useTraversalInput } from "./traversalInput";
import { getShotHook } from "../debug/shotHook";

/** Chase boom length at rest, metres, and how far it may be pushed in. */
const CAM_DISTANCE = 5.6;
const CAM_MIN_DISTANCE = 1.1;
/** Height above the feet the camera looks at. */
const CAM_TARGET_Y = 1.45;
/** How many samples along the boom decide whether it is clear. */
const CAM_PROBES = 7;

/** Vertical band around the feet that counts as "this obstacle is in my way". */
const BODY_TOP = PLAYER.height;

/**
 * How long after spawning the feet may still climb onto something taller than
 * a step, and how tall that something may be. Long enough for the landmark
 * layer to stream in; short enough that it is over before you have taken three
 * paces. Six metres clears every plinth in the world and reaches no roof.
 */
const SETTLE_SECONDS = 6;
const SETTLE_LIFT = 6;

export interface WalkerProps {
  /** Disabled while the fly camera or the screenshot harness owns the view. */
  enabled?: boolean;
  /** Character id from `@/lib/characters`; falls back to the saved pick. */
  charId: string;
}

/* ------------------------------------------------------------------ *
 * World queries
 * ------------------------------------------------------------------ */

const _recs: BuildingRecord[] = [];
const _cols: LandmarkCollider[] = [];

/**
 * Highest surface at or below `ceiling` that a person could stand on.
 *
 * The ceiling is what stops a walk down the pavement from snapping you onto
 * the roof of the building beside you: only surfaces within a step of the feet
 * are candidates while grounded, and while falling the feet come down through
 * the candidates in order.
 */
function supportAt(x: number, z: number, ceiling: number): number {
  let best = walkableHeight(x, z);
  const roof = buildingIndex.heightAt(x, z);
  if (roof > best && roof <= ceiling) best = roof;
  const deck = landmarkSurfaceHeight(x, z, ceiling);
  if (deck !== null && deck > best) best = deck;
  return best;
}

/**
 * Push a point out of anything solid at that height.
 *
 * Both obstacle kinds are oriented boxes, so both are resolved the same way:
 * rotate into the box's frame, and if the point is inside the box grown by the
 * body radius, move it out along whichever of the two axes it is least deep
 * in. Least-penetration is what makes sliding along a wall feel right rather
 * than sticking — and what stops a corner from flinging you across the street.
 */
function pushOut(pos: THREE.Vector2, feetY: number, radius: number): void {
  _recs.length = 0;
  buildingIndex.queryAABB(pos.x - 4, pos.y - 4, pos.x + 4, pos.y + 4, _recs);
  for (const r of _recs) {
    // Standing on top of it is not colliding with it. `roofY` is the main deck;
    // anything above that is crown and spire, which nobody walks into.
    if (feetY > r.roofY - 0.35) continue;
    if (feetY + BODY_TOP < r.baseY) continue;
    resolveBox(pos, r.cx, r.cz, r.yaw, r.hw, r.hd, radius);
  }

  _cols.length = 0;
  queryLandmarkColliders(pos.x, pos.y, 4 + radius, _cols);
  for (const c of _cols) {
    const top = c.y + c.hy;
    const bottom = c.y - c.hy;
    // A deck you are standing on, or one comfortably overhead, is not a wall.
    if (feetY > top - 0.35) continue;
    if (feetY + BODY_TOP < bottom) continue;
    resolveBox(pos, c.x, c.z, c.yaw, c.hx, c.hz, radius);
  }
}

function resolveBox(
  pos: THREE.Vector2,
  cx: number,
  cz: number,
  yaw: number,
  hw: number,
  hd: number,
  radius: number,
): void {
  const dx = pos.x - cx;
  const dz = pos.y - cz;
  const c = Math.cos(-yaw);
  const s = Math.sin(-yaw);
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  const ex = hw + radius;
  const ez = hd + radius;
  const penX = ex - Math.abs(lx);
  const penZ = ez - Math.abs(lz);
  if (penX <= 0 || penZ <= 0) return; // outside
  let nlx = lx;
  let nlz = lz;
  if (penX < penZ) nlx = lx >= 0 ? ex : -ex;
  else nlz = lz >= 0 ? ez : -ez;
  // Back to world: the inverse of the rotation above.
  const ci = Math.cos(yaw);
  const si = Math.sin(yaw);
  pos.x = cx + (nlx * ci - nlz * si);
  pos.y = cz + (nlx * si + nlz * ci);
}

/** Is this point inside something solid at this height? Used by the camera. */
function occupied(x: number, y: number, z: number): boolean {
  if (y < walkableHeight(x, z) + 0.25) return true;
  const r = buildingIndex.queryPoint(x, z);
  if (r && y > r.baseY - 2 && y < r.roofY) return true;
  _cols.length = 0;
  queryLandmarkColliders(x, z, 0.6, _cols);
  for (const c of _cols) {
    if (y < c.y - c.hy || y > c.y + c.hy) continue;
    const dx = x - c.x;
    const dz = z - c.z;
    const co = Math.cos(-c.yaw);
    const si = Math.sin(-c.yaw);
    const lx = dx * co - dz * si;
    const lz = dx * si + dz * co;
    if (Math.abs(lx) <= c.hx && Math.abs(lz) <= c.hz) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export default function Walker({ enabled = true, charId }: WalkerProps) {
  const { camera } = useThree();
  const input = useTraversalInput({ enabled });
  const group = useRef<THREE.Group>(null);
  const [rig, setRig] = useState<CharacterRig | null>(null);

  const scratch = useMemo(
    () => ({
      forward: new THREE.Vector3(),
      right: new THREE.Vector3(),
      move: new THREE.Vector3(),
      flat: new THREE.Vector2(),
      camPos: new THREE.Vector3(),
      target: new THREE.Vector3(),
      boom: new THREE.Vector3(),
    }),
    [],
  );

  /** Facing, smoothed toward the direction of travel. */
  const facing = useRef(frame.yaw);
  const camDist = useRef(CAM_DISTANCE);
  /**
   * Seconds left in which the feet may still be lifted onto a surface higher
   * than a step — see the note at `SETTLE_LIFT` in the frame loop.
   */
  const settling = useRef(SETTLE_SECONDS);

  /* ---------------- the character ---------------- */
  useEffect(() => {
    let live = true;
    let mine: CharacterRig | null = null;
    const spec = findCharacter(charId);
    loadCharacterRig(
      { url: spec.url, id: spec.id },
      // `center: false` — the rig anchors feet to y=0 and we want it standing
      // where the controller says it is, not recentred on its own silhouette.
      { height: PLAYER.height, center: false, castShadow: true, walkSpeed: PLAYER.walkSpeed },
    )
      .then((r) => {
        if (!live) {
          r.dispose();
          return;
        }
        mine = r;
        setRig(r);
      })
      .catch(() => {
        /* A character that will not load leaves you invisible rather than
           taking the world down with it — /city learned that one the hard way. */
      });
    return () => {
      live = false;
      setRig(null);
      mine?.dispose();
    };
  }, [charId]);

  useEffect(() => {
    const g = group.current;
    if (!g || !rig) return;
    g.add(rig.object);
    return () => {
      g.remove(rig.object);
    };
  }, [rig]);

  /* ---------------- debug surface ---------------- */
  useEffect(() => {
    const hook = getShotHook();
    hook.player = () => ({
      x: frame.position.x,
      y: frame.position.y,
      z: frame.position.z,
      grounded: frame.grounded,
      support: supportAt(frame.position.x, frame.position.z, frame.position.y + SETTLE_LIFT),
      settling: settling.current,
      rig: !!rig,
      colliders: queryLandmarkColliders(frame.position.x, frame.position.z, 40, []).length,
      rigHeight: rig ? rig.size.y : 0,
    });
    return () => {
      delete hook.player;
    };
  }, [rig]);

  /* ---------------- the frame ---------------- */
  useFrame((_, delta) => {
    const g = group.current;
    if (!enabled || !g) return;
    const dt = Math.min(delta, 1 / 15);

    /* ---- look ---- */
    frame.yaw -= input.lookX * PLAYER.mouseSensitivity;
    frame.pitch -= input.lookY * PLAYER.mouseSensitivity;
    // A chase camera may look down at the roof of the world and up at the sky,
    // but not through the character's own feet.
    frame.pitch = clamp(frame.pitch, -1.15, 0.95);
    input.lookX = 0;
    input.lookY = 0;

    /* ---- intent ---- */
    const { x: mx, z: mz, boost, slow } = readMove(input);
    const cy = Math.cos(frame.yaw);
    const sy = Math.sin(frame.yaw);
    // Movement is on the ground plane whatever the camera is looking at:
    // pitching down must not shorten your stride.
    scratch.forward.set(-sy, 0, -cy);
    scratch.right.set(cy, 0, -sy);
    scratch.move
      .set(0, 0, 0)
      .addScaledVector(scratch.forward, -mz)
      .addScaledVector(scratch.right, mx);
    const intent = Math.min(scratch.move.length(), 1);
    if (intent > 1e-3) scratch.move.normalize();

    const speed =
      intent *
      (boost ? PLAYER.sprintSpeed : slow ? PLAYER.crouchSpeed : PLAYER.walkSpeed);

    /**
     * ---- stand up before moving ----
     *
     * The vertical resolve has to come FIRST, and the order is the whole bug it
     * fixes. A spawn point is worked out from the *terrain*, because at the
     * moment the level mounts that is all that exists — landmarks stream in
     * afterwards. So spawning at Union Square puts you at terrain height and
     * the plaza then builds its 1.4 m granite deck around you. With the
     * horizontal pass running first, `pushOut` sees a solid box containing your
     * feet and does exactly what it is asked to: ejects you sideways out of it.
     * A 62 m plaza ejects you 31 m, into the street, where the deck is no
     * longer overhead and can never be stood on. What that looks like from
     * outside is a character that is simply not there, with the camera skimming
     * a granite surface it is five centimetres above.
     *
     * Settle first, and the plaza is a floor rather than a wall: the feet climb
     * onto it, `pushOut` then skips it (you are on top), and you spawn in the
     * middle of the square looking at the Dewey Monument.
     *
     * The relaxed lift is time-boxed because it only exists to absorb geometry
     * that arrived after the spawn — six metres clears every plinth in the
     * world and reaches no roof.
     */
    settling.current = Math.max(0, settling.current - dt);
    const settlingNow = settling.current > 0;
    const stepLimit = settlingNow ? SETTLE_LIFT : PLAYER.stepHeight;
    // While settling this runs even when airborne, because at spawn you ARE
    // airborne — `resetFrame` drops you — and the very first frame is the one
    // that ejects you. It is skipped on the way UP so it can never interrupt a
    // jump, only a fall or a stand.
    if (frame.grounded || (settlingNow && frame.velocity.y <= 0)) {
      const here = supportAt(frame.position.x, frame.position.z, frame.position.y + stepLimit);
      if (here > frame.position.y) {
        frame.position.y = here;
        frame.velocity.y = 0;
        frame.grounded = true;
      }
    }

    /* ---- horizontal move, then resolve ---- */
    const feetY = frame.position.y;
    scratch.flat.set(
      frame.position.x + scratch.move.x * speed * dt,
      frame.position.z + scratch.move.z * speed * dt,
    );
    pushOut(scratch.flat, feetY, PLAYER.radius);
    const clamped = clampToWorld(scratch.flat.x, scratch.flat.y);
    frame.position.x = clamped.x;
    frame.position.z = clamped.z;

    /* ---- vertical ---- */
    const ceiling = frame.grounded ? feetY + stepLimit : feetY;
    const ground = supportAt(frame.position.x, frame.position.z, ceiling);

    if (frame.grounded && input.consumeJump()) {
      frame.velocity.y = PLAYER.jumpVelocity;
      frame.grounded = false;
    } else if (!frame.grounded) {
      input.consumeJump(); // never bank a jump for the landing
    }

    frame.velocity.y += PLAYER.gravity * dt;
    frame.velocity.y = Math.max(frame.velocity.y, -PLAYER.terminalVelocity);
    let y = frame.position.y + frame.velocity.y * dt;

    if (y <= ground) {
      y = ground;
      frame.velocity.y = 0;
      frame.grounded = true;
    } else if (y - ground > 0.06) {
      frame.grounded = false;
    }
    frame.position.y = Math.min(y, WORLD.skyCeiling);

    frame.velocity.x = scratch.move.x * speed;
    frame.velocity.z = scratch.move.z * speed;
    frame.movement = frame.grounded ? "grounded" : "airborne";

    /* ---- the body ---- */
    g.position.copy(frame.position);
    if (intent > 0.05) {
      // Face where you are going, catching up over about a fifth of a second.
      const want = Math.atan2(scratch.move.x, scratch.move.z);
      let d = want - facing.current;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      facing.current += d * Math.min(1, dt * 12);
    }
    g.rotation.y = facing.current;
    if (rig) {
      rig.setLocomotion(speed / PLAYER.walkSpeed);
      // A sprint is the walk clip played faster, not a second clip: almost
      // nothing in this catalog ships a run.
      if (rig.mixer) rig.mixer.timeScale = speed > PLAYER.walkSpeed + 0.1 ? 1.5 : 1;
      rig.update(dt);
    }

    /* ---- the camera ---- */
    scratch.target.set(frame.position.x, frame.position.y + CAM_TARGET_Y, frame.position.z);
    const cp = Math.cos(frame.pitch);
    const sp = Math.sin(frame.pitch);
    scratch.boom.set(sy * cp, -sp, cy * cp).normalize();

    // Walk the boom out from the head and stop at the last clear sample, so a
    // camera that would sit inside the building behind you sits against it
    // instead. Sampling beats a raycast here: the obstacles are already boxes
    // in a grid, and seven point tests are cheaper than a ray against both.
    let want = CAM_DISTANCE;
    for (let i = 1; i <= CAM_PROBES; i++) {
      const d = (CAM_DISTANCE * i) / CAM_PROBES;
      scratch.camPos.copy(scratch.target).addScaledVector(scratch.boom, d);
      if (occupied(scratch.camPos.x, scratch.camPos.y, scratch.camPos.z)) {
        want = Math.max(CAM_MIN_DISTANCE, (CAM_DISTANCE * (i - 1)) / CAM_PROBES);
        break;
      }
    }
    // Snap in hard, ease out slow: a camera that eases *into* a wall spends the
    // easing inside it.
    camDist.current =
      want < camDist.current ? want : damp(camDist.current, want, 3.5, dt);
    scratch.camPos.copy(scratch.target).addScaledVector(scratch.boom, camDist.current);
    camera.position.copy(scratch.camPos);
    camera.lookAt(scratch.target);
  });

  return <group ref={group} name="sf-walker" />;
}
