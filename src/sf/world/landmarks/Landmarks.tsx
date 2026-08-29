/**
 * Landmarks.tsx — the landmark streamer.
 *
 * Twenty-two hand-modelled structures, each with two levels of detail, drawn
 * across nine kilometres of city. The policy:
 *
 *  **Every silhouette is built at load, and it is cheap.** The far LOD of the
 *  whole set is a few thousand triangles in total and about forty draw calls.
 *  It goes in once, on mount, and it never leaves — a landmark that pops in
 *  when you turn around is worse than one that is slightly too simple.
 *
 *  **Hero meshes stream in on approach.** Each module declares a `nearRange`.
 *  The build is kicked off at 1.35x that range, so by the time the swap
 *  actually happens the geometry already exists and the transition is a
 *  visibility flip rather than a stall. One landmark is built per frame at
 *  most, under a millisecond budget.
 *
 *  **Hero meshes are evicted.** Past 2.5x the near range the detailed group is
 *  disposed. Otherwise a long flight around the city ends up holding every
 *  landmark's full geometry at once, which is tens of megabytes for detail
 *  nobody is looking at.
 *
 *  **Anchors never cull.** The bridges, Sutro Tower, the Transamerica and
 *  Salesforce are how the player navigates. Their far LOD ignores the draw
 *  distance entirely; if you can see the sky in their direction you can see
 *  them.
 *
 * Colliders are published once, from the far build, into the registry in
 * `types.ts`, where the character controller, the vehicles and the grapple can
 * query them without knowing anything about this component.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { QUALITY, WORLD_SEED } from "../../config";
import { LANDMARKS, type LandmarkDef } from "../../geo/sfGeo";
import { makeRng } from "../../math/rng";
import { useSfStore } from "../../state/store";
import { Batch, disposeLandmark } from "./kit";
import { builderFor } from "./registry";
import {
  clearLandmarkColliders,
  landmarkColliders,
  makeLandmarkCtx,
  type LandmarkModule,
} from "./types";

/**
 * Key the landmark hulls are registered under in the physics world.
 *
 * They were not registered anywhere at all until the Terraces needed them.
 * `landmarkSurfaceHeight()` has always answered "what am I standing on" for
 * the kinematic walker, but `Player` drives Rapier, and nothing had ever
 * handed Rapier a landmark — so under the physics controller the Golden
 * Gate's deck, Lombard's switchbacks, Union Square's plinth and Pier 39's
 * boardwalk were all scenery you fall through. `registerStaticBoxes()`
 * existed, exported and documented ("landmark hulls, bridge decks, jersey
 * barriers, the Alcatraz cliffs"), and had never been called with one.
 */
const PHYSICS_KEY = "sf-landmarks";

/** Milliseconds of landmark building allowed per frame. */
const BUDGET_MS = 6;
/** Start building the hero mesh this much earlier than the swap. */
const PREFETCH = 1.35;
/** Dispose the hero mesh past this multiple of the near range. */
const EVICT = 2.6;
/** How far the camera must move before the resident set is recomputed. */
const RESCAN_DISTANCE = 40;

type Anim = (t: number) => void;

interface Built {
  group: THREE.Group;
  anims: Anim[];
  triangles: number;
}

interface Slot {
  def: LandmarkDef;
  mod: LandmarkModule;
  yaw: number;
  nearRange: number;
  anchor: boolean;
  far: Built;
  near: Built | null;
  /** Set when the hero build has been requested but not yet run. */
  queued: boolean;
  dist: number;
}

/* ------------------------------------------------------------------ *
 * Building
 * ------------------------------------------------------------------ */

function buildLandmark(
  def: LandmarkDef,
  mod: LandmarkModule,
  yaw: number,
  lod: 0 | 1,
  recordColliders: boolean,
): Built {
  const group = new THREE.Group();
  group.name = `landmark/${def.key}/lod${lod}`;
  group.position.set(def.x, 0, def.z);
  group.rotation.y = yaw;

  const batch = new Batch();
  const anims: Anim[] = [];
  const ctx = makeLandmarkCtx({
    def,
    lod,
    yaw,
    // Fork per landmark *and* per LOD so the two levels agree on any random
    // choice they share (which gable a Painted Lady has, for instance).
    rng: makeRng(`${WORLD_SEED}:landmark:${def.key}`),
    batch,
    recordColliders,
    onFrame: (fn) => anims.push(fn),
  });

  try {
    mod.build(ctx);
  } catch (err) {
    // A landmark that throws must not take the level with it. The silhouette
    // (or nothing) is a survivable outcome; a black screen is not.
    console.error(`[sf/landmarks] ${def.key} lod${lod} failed to build`, err);
  }

  batch.flush(group, {
    name: def.key,
    castShadow: lod === 0,
    receiveShadow: lod === 0,
  });
  // The far LOD is drawn at ranges where a shadow map has no resolution left
  // for it, and casting from it would only fight the near LOD's shadows during
  // the cross-over.
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (lod !== 0) {
      mesh.castShadow = false;
      mesh.receiveShadow = false;
    }
  });
  return { group, anims, triangles: batch.triangles };
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export interface LandmarksProps {
  /** Override the quality tier (the shot harness pins one). */
  tier?: keyof typeof QUALITY;
}

export default function Landmarks({ tier }: LandmarksProps = {}) {
  const quality = useSfStore((s) => s.quality);
  const activeTier = tier ?? quality;
  const q = QUALITY[activeTier];

  const root = useMemo(() => {
    const g = new THREE.Group();
    g.name = "landmarks";
    // The bridges and Sutro Tower have enormous bounding spheres and are
    // deliberately visible from anywhere; per-object frustum culling still
    // applies to their child meshes.
    g.frustumCulled = false;
    return g;
  }, []);

  const slots = useRef<Slot[]>([]);
  const lastScan = useRef(new THREE.Vector3(1e9, 1e9, 1e9));
  const queue = useRef<Slot[]>([]);
  /** Set once the silhouettes are built; cleared once Rapier has taken them. */
  const physicsPending = useRef(false);

  /* ---- build every silhouette once ---- */
  useEffect(() => {
    clearLandmarkColliders();
    const made: Slot[] = [];
    for (const def of LANDMARKS) {
      const mod = builderFor(def.kind);
      if (!mod) continue;
      const yaw = mod.yaw ? mod.yaw(def) : def.rotation;
      const far = buildLandmark(def, mod, yaw, 1, true);
      root.add(far.group);
      made.push({
        def,
        mod,
        yaw,
        nearRange: mod.nearRange ? mod.nearRange(def) : Math.max(300, def.radius * 8),
        anchor: mod.anchor === true,
        far,
        near: null,
        queued: false,
        dist: Infinity,
      });
    }
    slots.current = made;
    lastScan.current.set(1e9, 1e9, 1e9);
    // Rapier may not exist yet — it loads on its own schedule — so this is a
    // request, retried in the frame loop until it takes.
    physicsPending.current = true;

    return () => {
      for (const s of made) {
        root.remove(s.far.group);
        disposeLandmark(s.far.group);
        if (s.near) {
          root.remove(s.near.group);
          disposeLandmark(s.near.group);
        }
      }
      slots.current = [];
      queue.current = [];
      clearLandmarkColliders();
      physicsPending.current = false;
      void import("../../physics").then((m) => m.removeStaticBoxes(PHYSICS_KEY));
    };
  }, [root]);

  /* ---- stream, swap and animate ---- */
  useFrame((state) => {
    const list = slots.current;
    if (list.length === 0) return;

    /* Hand the hulls to Rapier as soon as there is a Rapier to hand them to.
       Dynamic, so a build that never boots physics does not pull it in; and
       `registerStaticBoxes` reports whether the world was there, so this is a
       poll rather than a guess about load order. */
    if (physicsPending.current) {
      physicsPending.current = false;
      const boxes = landmarkColliders().map((c) => ({
        cx: c.x, cy: c.y, cz: c.z,
        hx: c.hx, hy: c.hy, hz: c.hz,
        // Same sign convention as `landmarkSurfaceHeight` and the ribbon sink:
        // a box whose long axis points along bearing `a` is stored at `-a`,
        // and a three/Rapier yaw about +Y takes local +X to that same place.
        yaw: c.yaw,
        surface: "concrete" as const,
      }));
      void import("../../physics").then((m) => {
        if (!m.registerStaticBoxes(PHYSICS_KEY, boxes)) physicsPending.current = true;
      });
    }
    const cam = state.camera.position;
    const t = state.clock.elapsedTime;

    // Rescan only when the camera has actually moved. Twenty-two distance
    // checks is nothing, but the sort and the queue rebuild are not free and
    // there is no reason to do them at 144 Hz while standing still.
    if (lastScan.current.distanceToSquared(cam) > RESCAN_DISTANCE * RESCAN_DISTANCE) {
      lastScan.current.copy(cam);
      queue.current.length = 0;
      for (const s of list) {
        const dx = cam.x - s.def.x;
        const dz = cam.z - s.def.z;
        s.dist = Math.hypot(dx, dz);

        if (s.near === null && !s.queued && s.dist < s.nearRange * PREFETCH) {
          s.queued = true;
        }
        if (s.queued && s.near === null) queue.current.push(s);

        // Evict a hero mesh the player has left far behind.
        if (s.near !== null && s.dist > s.nearRange * EVICT) {
          root.remove(s.near.group);
          disposeLandmark(s.near.group);
          s.near = null;
          s.queued = false;
          s.far.group.visible = true;
        }
      }
      queue.current.sort((a, b) => a.dist - b.dist);
    }

    /* ---- build, under a budget ---- */
    if (queue.current.length > 0) {
      const deadline = performance.now() + BUDGET_MS;
      while (queue.current.length > 0) {
        const s = queue.current[0];
        if (s.near !== null) {
          queue.current.shift();
          continue;
        }
        s.near = buildLandmark(s.def, s.mod, s.yaw, 0, false);
        s.near.group.visible = false;
        root.add(s.near.group);
        queue.current.shift();
        // One landmark per frame unless there is budget left over: the hero
        // builds are big enough that a second one is always a dropped frame.
        if (performance.now() > deadline) break;
      }
    }

    /* ---- visibility ---- */
    const cullRadius = q.drawDistance;
    for (const s of list) {
      const near = s.near;
      const showNear = near !== null && s.dist < s.nearRange;
      if (near) near.group.visible = showNear;
      // The far mesh stays up whenever the hero mesh is not, and anchors are
      // never distance-culled.
      s.far.group.visible = !showNear && (s.anchor || s.dist < cullRadius);

      const anims = showNear ? near!.anims : s.far.anims;
      for (let i = 0; i < anims.length; i++) anims[i](t);
    }
  });

  return <primitive object={root} />;
}
