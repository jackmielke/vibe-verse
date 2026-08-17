/**
 * Buildings.tsx — the streaming city.
 *
 * Owns the chunk grid, the generation budget, the LOD cross-fades and the
 * impostor field, and publishes everything it makes into `buildingIndex` so
 * physics, AI and the grapple can query it.
 *
 * The invariant this file exists to protect is: **no frame ever spends more
 * than the budget generating buildings.** A chunk of the Financial District is
 * thirty milliseconds of work. Doing that inside one frame is a visible hitch
 * every time you cross a chunk boundary at wingsuit speed, and "it only stalls
 * when you fly fast" is not a shippable answer in a game about flying fast. So
 * generation is a resumable job: enumerate blocks, subdivide lots, then emit
 * buildings one at a time, checking a deadline as it goes, across as many
 * frames as it takes.
 *
 * Chunk layout is two-level:
 *   A cells   320 m   LOD 0 near, LOD 1 mid
 *   B cells   960 m   LOD 2, used only where the whole B cell is beyond the
 *                     LOD-1 radius. A B cell that straddles the boundary is
 *                     split into its nine A cells instead, which is what keeps
 *                     the two levels from ever overlapping or leaving a hole.
 * Beyond that, `impostors.ts` covers the horizon with instanced proxy boxes.
 *
 * Draw calls: one per chunk (the whole city shares one material), one per
 * impostor tile. Roughly seventy for the entire visible city.
 *
 * Residency is the other invariant, and it is the one that broke. A chunk is
 * resident once it has been *generated*, which is not the same as once it has a
 * *mesh* — a third of this map is water and park and generates nothing at all.
 * Inferring residency from the mesh meant every empty chunk was rebuilt on
 * every rescan, four hundred milliseconds apart, forever: the queue never
 * drained in a whole session, real chunks waited behind work that was already
 * done, and the city visibly boiled. Measured with `scripts/sf-flicker.mjs`,
 * 12.5% of the pixels on screen changed between two frames of a frozen camera.
 * See `Chunk.empty`.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { QUALITY, WORLD_SEED } from "../../config";
import { frame, useSfStore } from "../../state/store";
import { skyFillColor, sunColor, sunDirection } from "../../sky/Sky";
import { GeoSink } from "./geoSink";
import {
  createFadeMaterial,
  disposeFacadeMaterials,
  getFacadeMaterial,
  releaseFadeMaterial,
  updateFacadeUniforms,
} from "./facadeMaterial";
import { buildBlock, enumerateBlocks, type BlockSpec, type Lot } from "./lots";
import { generateBuilding, type BuildingRecord } from "./generator";
import { dressRoofs } from "./rooftops";
import {
  buildLodPlan,
  castsShadow,
  fadeSeconds,
  stableLod,
  type LodPlan,
} from "./lod";
import {
  ImpostorTileJob,
  createImpostorMesh,
  disposeImpostorMesh,
  disposeImpostorResources,
  setImpostorNearClip,
} from "./impostors";
import { buildingIndex } from "./spatialIndex";

/** Milliseconds of generation allowed per frame once the city is up. */
const BUDGET_MS = 5.0;
/**
 * Budget while the initial set is still filling in, at the baseline detail
 * radius. Scaled up for higher tiers by `warmupBudget` below.
 *
 * A fixed warmup budget was a real bug: a higher tier asks for a bigger detail
 * radius, chunk count grows with the *area* of that radius, and so Ultra had
 * roughly five times the work to do with exactly the same milliseconds per
 * frame to do it in. The visible result was backwards — the city filled in
 * fastest on Medium and slowest on Ultra, so the high tiers looked emptier
 * than the low ones for the first several seconds.
 */
const WARMUP_BUDGET_MS = 11.0;
/** The detail radius the warmup budget above was tuned against. */
const BASELINE_DETAIL_RADIUS = 640;
/**
 * Hard ceiling on warmup work per frame. Streaming is a loading phase, so a
 * lower framerate is acceptable there — but not an unresponsive one, and the
 * touch camera still has to feel alive while the city arrives.
 */
const WARMUP_BUDGET_CAP_MS = 26.0;

/** Per-frame generation budget during warmup, scaled to the tier's workload. */
function warmupBudget(detailRadius: number): number {
  const areaRatio = (detailRadius / BASELINE_DETAIL_RADIUS) ** 2;
  return Math.min(WARMUP_BUDGET_CAP_MS, WARMUP_BUDGET_MS * Math.max(1, areaRatio));
}
/** How far the camera must move before the resident set is recomputed. */
const RESCAN_DISTANCE = 48;
const RESCAN_SECONDS = 0.4;

const A_CELL = 320;
const B_CELL = 960;

/* ------------------------------------------------------------------ *
 * Chunk job — the resumable generator
 * ------------------------------------------------------------------ */

type JobPhase = "blocks" | "lots" | "emit" | "ready";

class ChunkJob {
  readonly key: string;
  readonly x: number;
  readonly z: number;
  readonly size: number;
  readonly lod: number;
  /** Squared distance to the camera at scheduling time — the queue order. */
  priority = 0;

  phase: JobPhase = "blocks";
  private blocks: BlockSpec[] = [];
  private blockIdx = 0;
  private lots: Lot[] = [];
  private lotIdx = 0;
  private sink: GeoSink;
  records: BuildingRecord[] = [];

  constructor(key: string, x: number, z: number, size: number, lod: number) {
    this.key = key;
    this.x = x;
    this.z = z;
    this.size = size;
    this.lod = lod;
    // Pre-size the sink from a rough vertex estimate so a downtown chunk does
    // not reallocate eight times on its way up.
    this.sink = new GeoSink(lod === 0 ? 60000 : lod === 1 ? 26000 : 40000);
  }

  /** Do work until `deadline`. Returns true once the chunk is ready to mesh. */
  advance(deadline: number): boolean {
    if (this.phase === "blocks") {
      enumerateBlocks(this.x, this.z, this.x + this.size, this.z + this.size, this.blocks);
      this.phase = "lots";
    }

    if (this.phase === "lots") {
      while (this.blockIdx < this.blocks.length) {
        const b = buildBlock(this.blocks[this.blockIdx++], WORLD_SEED);
        for (const l of b.lots) this.lots.push(l);
        if (performance.now() >= deadline) return false;
      }
      this.phase = "emit";
    }

    if (this.phase === "emit") {
      while (this.lotIdx < this.lots.length) {
        // Four buildings between deadline checks: `performance.now()` is not
        // free, and a single building is well under 0.2 ms.
        const end = Math.min(this.lotIdx + 4, this.lots.length);
        for (; this.lotIdx < end; this.lotIdx++) {
          const rec = generateBuilding(this.lots[this.lotIdx], this.sink, this.lod, this.x, this.z);
          if (!rec) continue;
          dressRoofs(rec, this.sink, this.lod, this.x, this.z);
          this.records.push(rec);
        }
        if (performance.now() >= deadline) return false;
      }
      this.phase = "ready";
    }
    return true;
  }

  /** Hand over the geometry. Null when the chunk turned out to be empty. */
  finish(): THREE.BufferGeometry | null {
    if (this.sink.empty) return null;
    return this.sink.finalize();
  }
}

/* ------------------------------------------------------------------ *
 * Resident chunk
 * ------------------------------------------------------------------ */

interface Chunk {
  key: string;
  x: number;
  z: number;
  size: number;
  lod: number;
  mesh: THREE.Mesh | null;
  /** Outgoing mesh during a cross-fade. */
  oldMesh: THREE.Mesh | null;
  fadeIn: { value: number } | null;
  fadeOut: { value: number } | null;
  fadeT: number;
  /** Set while a job for this chunk is queued or running. */
  job: ChunkJob | null;
  /** LOD the pending job is building. */
  pendingLod: number;
  indexed: boolean;
  /**
   * This chunk was generated and came out with no geometry in it — open water,
   * a park, the Presidio's meadows. It is RESIDENT, and the distinction from
   * "not built yet" is the difference between a city that settles and one that
   * never stops working.
   *
   * `commit` always meant to record this — its comment says so — but residency
   * was inferred from `mesh`, which an empty chunk does not have. So every
   * empty chunk was re-enumerated, re-subdivided and re-emitted on the next
   * rescan, four hundred milliseconds later, forever. A third of this map is
   * water and park: the queue never drained once in a session, the real chunks
   * behind it arrived late, and the LOD cross-fades they arrived with were
   * still dissolving when the next scan retargeted them. Standing still, 12.5%
   * of the pixels on screen changed from one moment to the next.
   */
  empty: boolean;
}

interface ImpTile {
  key: string;
  x: number;
  z: number;
  job: ImpostorTileJob | null;
  mesh: THREE.InstancedMesh | null;
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

const _sunDir = new THREE.Vector3();
const _sunCol = new THREE.Color();
const _skyCol = new THREE.Color();
const _camPos = new THREE.Vector3();

export default function Buildings() {
  const tier = useSfStore((s) => s.quality);
  const q = QUALITY[tier];
  const { camera, size, gl } = useThree();

  const group = useRef<THREE.Group>(null);
  const chunks = useRef(new Map<string, Chunk>()).current;
  const queue = useRef<ChunkJob[]>([]).current;
  const impostors = useRef(new Map<string, ImpTile>()).current;
  const impQueue = useRef<ImpTile[]>([]).current;
  const lastScan = useRef({ x: Infinity, z: Infinity, t: -99 });
  const planRef = useRef<LodPlan | null>(null);
  const warm = useRef(true);

  const material = useMemo(() => getFacadeMaterial(), []);

  // The plan depends on projection, so it is rebuilt when the framebuffer or
  // the quality tier changes. FOV drift from the sprint boost is small enough
  // that folding it in per frame would only cause LOD churn.
  const drawH = size.height * gl.getPixelRatio();
  const plan = useMemo(
    () => buildLodPlan(q, (camera as THREE.PerspectiveCamera).fov ?? 74, drawH),
    [q, camera, drawH],
  );
  planRef.current = plan;

  /* ---------------- teardown ---------------- */
  useEffect(() => {
    const g = group.current;
    return () => {
      for (const c of chunks.values()) {
        if (c.mesh) {
          c.mesh.geometry.dispose();
          g?.remove(c.mesh);
        }
        if (c.oldMesh) {
          c.oldMesh.geometry.dispose();
          g?.remove(c.oldMesh);
        }
        if (c.mesh && c.mesh.material !== material) releaseFadeMaterial(c.mesh.material as THREE.MeshStandardMaterial);
        if (c.oldMesh) releaseFadeMaterial(c.oldMesh.material as THREE.MeshStandardMaterial);
      }
      chunks.clear();
      queue.length = 0;
      for (const t of impostors.values()) {
        if (t.mesh) {
          g?.remove(t.mesh);
          disposeImpostorMesh(t.mesh);
        }
      }
      impostors.clear();
      impQueue.length = 0;
      buildingIndex.clear();
      disposeImpostorResources();
      disposeFacadeMaterials();
    };
  }, [chunks, queue, impostors, impQueue, material]);

  /* ---------------- streaming ---------------- */

  /** Recompute which chunks should be resident, and schedule the difference. */
  const rescan = (cx: number, cz: number): void => {
    const p = planRef.current;
    const g = group.current;
    if (!p || !g) return;

    const wanted = new Set<string>();

    // --- geometric tiers ---
    const bReach = Math.ceil(p.nearRadius / B_CELL) + 1;
    const bi0 = Math.floor(cx / B_CELL) - bReach;
    const bi1 = Math.floor(cx / B_CELL) + bReach;
    const bj0 = Math.floor(cz / B_CELL) - bReach;
    const bj1 = Math.floor(cz / B_CELL) + bReach;

    for (let bj = bj0; bj <= bj1; bj++) {
      for (let bi = bi0; bi <= bi1; bi++) {
        const bx = bi * B_CELL;
        const bz = bj * B_CELL;
        const bNear = boxDistance(cx, cz, bx, bz, B_CELL);
        if (bNear > p.nearRadius) continue;

        const near1 = p.rings[1].radius;
        if (bNear >= near1) {
          // Whole super-cell is out in coarse country: one chunk covers it.
          scheduleChunk(wanted, `B:${bi}:${bj}`, bx, bz, B_CELL, 2, bNear);
          continue;
        }
        // Straddles the boundary — resolve its nine A cells individually.
        for (let sj = 0; sj < 3; sj++) {
          for (let si = 0; si < 3; si++) {
            const ax = bx + si * A_CELL;
            const az = bz + sj * A_CELL;
            const aNear = boxDistance(cx, cz, ax, az, A_CELL);
            if (aNear > p.nearRadius) continue;
            const ai = Math.round(ax / A_CELL);
            const aj = Math.round(az / A_CELL);
            const key = `A:${ai}:${aj}`;
            const existing = chunks.get(key);
            const lod = stableLod(p, aNear, existing ? existing.lod : 99);
            scheduleChunk(wanted, key, ax, az, A_CELL, Math.min(lod, 2), aNear);
          }
        }
      }
    }

    // Evict everything that fell out of range.
    for (const [key, c] of chunks) {
      if (wanted.has(key)) continue;
      retire(c);
      chunks.delete(key);
      buildingIndex.removeChunk(key);
    }
    // Drop queued jobs for chunks that no longer exist.
    for (let i = queue.length - 1; i >= 0; i--) {
      if (!chunks.has(queue[i].key)) queue.splice(i, 1);
    }
    queue.sort((a, b) => a.priority - b.priority);

    // --- impostor field ---
    const wantImp = new Set<string>();
    const tile = p.impostorTile;
    const tReach = Math.ceil(p.impostorRadius / tile) + 1;
    const ti = Math.floor(cx / tile);
    const tj = Math.floor(cz / tile);
    for (let j = tj - tReach; j <= tj + tReach; j++) {
      for (let i = ti - tReach; i <= ti + tReach; i++) {
        const tx = i * tile;
        const tz = j * tile;
        const near = boxDistance(cx, cz, tx, tz, tile);
        // Keep a tile until it is ENTIRELY inside the geometric field, judged
        // by its far corner rather than its near edge — a 1500 m tile that
        // merely touches the boundary still carries a kilometre of skyline
        // nothing else draws. The overlap is clipped per-fragment instead, so
        // nothing is painted twice. See `setImpostorNearClip`.
        const far = boxFarDistance(cx, cz, tx, tz, tile);
        if (near > p.impostorRadius || far < p.nearRadius) continue;
        const key = `I:${i}:${j}`;
        wantImp.add(key);
        if (impostors.has(key)) continue;
        const t: ImpTile = { key, x: tx, z: tz, job: new ImpostorTileJob(tx, tz, tile, WORLD_SEED), mesh: null };
        impostors.set(key, t);
        impQueue.push(t);
      }
    }
    for (const [key, t] of impostors) {
      if (wantImp.has(key)) continue;
      if (t.mesh) {
        g.remove(t.mesh);
        disposeImpostorMesh(t.mesh);
      }
      const qi = impQueue.indexOf(t);
      if (qi >= 0) impQueue.splice(qi, 1);
      impostors.delete(key);
    }
  };

  /** Ensure a chunk exists at the requested LOD, queueing work if needed. */
  const scheduleChunk = (
    wanted: Set<string>,
    key: string,
    x: number,
    z: number,
    sz: number,
    lod: number,
    dist: number,
  ): void => {
    wanted.add(key);
    let c = chunks.get(key);
    if (!c) {
      c = {
        key, x, z, size: sz, lod,
        mesh: null, oldMesh: null,
        fadeIn: null, fadeOut: null, fadeT: 0,
        job: null, pendingLod: lod, indexed: false, empty: false,
      };
      chunks.set(key, c);
    }
    /**
     * Silhouette first, detail second.
     *
     * A chunk with nothing on screen yet is not a slightly-too-simple block, it
     * is a *hole* — bare ground with a road grid painted on it, which is what
     * flying anywhere used to look like for the first several seconds. A full
     * LOD-0 block of the Financial District is around thirty milliseconds of
     * lot subdivision, bays, fire escapes and stoops; the LOD-2 version of the
     * same block is a prism, a crown and a roof cap, and lands roughly an order
     * of magnitude sooner.
     *
     * So a chunk that has never been drawn is always built coarse first,
     * whatever tier it is entitled to, and a later scan refines it. You reach a
     * block and it is *there*, and the bays arrive while you look at it. The
     * silhouette is the same either way — that is the whole reason tier 2
     * resolves into tier 0 rather than into a different shape.
     */
    const firstBuild = !c.mesh && !c.empty;
    const want = firstBuild ? Math.max(lod, 2) : lod;

    // Already correct, or already building the right thing. An empty chunk
    // counts as built — see `Chunk.empty`.
    if ((c.mesh || c.empty) && c.lod === want && !c.job) return;
    if (c.job && (c.pendingLod === want || firstBuild)) {
      // While a chunk still has nothing on screen, finishing *something* beats
      // retargeting to the right thing: a job dropped at 90% is 90% of a block
      // that nobody ever saw.
      c.job.priority = dist;
      return;
    }
    if (c.job) {
      // Retarget: drop the stale job before it wastes any more budget.
      const qi = queue.indexOf(c.job);
      if (qi >= 0) queue.splice(qi, 1);
      c.job = null;
    }
    const job = new ChunkJob(key, x, z, sz, want);
    job.priority = dist;
    c.job = job;
    c.pendingLod = want;
    queue.push(job);
  };

  /** Tear a chunk down completely. */
  const retire = (c: Chunk): void => {
    const g = group.current;
    if (c.mesh) {
      g?.remove(c.mesh);
      c.mesh.geometry.dispose();
      if (c.mesh.material !== material) releaseFadeMaterial(c.mesh.material as THREE.MeshStandardMaterial);
      c.mesh = null;
    }
    if (c.oldMesh) {
      g?.remove(c.oldMesh);
      c.oldMesh.geometry.dispose();
      releaseFadeMaterial(c.oldMesh.material as THREE.MeshStandardMaterial);
      c.oldMesh = null;
    }
    if (c.job) {
      const qi = queue.indexOf(c.job);
      if (qi >= 0) queue.splice(qi, 1);
      c.job = null;
    }
  };

  /** Promote a finished job to a live mesh, starting a cross-fade if needed. */
  const commit = (c: Chunk, job: ChunkJob): void => {
    const g = group.current;
    if (!g) return;
    const geo = job.finish();
    c.job = null;

    if (!geo) {
      // Empty chunk (water, park, the Presidio's meadows). Still counts as
      // resident so we do not re-queue it every rescan.
      if (c.mesh) {
        g.remove(c.mesh);
        c.mesh.geometry.dispose();
        c.mesh = null;
      }
      c.lod = job.lod;
      c.empty = true;
      buildingIndex.removeChunk(c.key);
      c.indexed = false;
      return;
    }
    c.empty = false;

    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(job.x, 0, job.z);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.castShadow = castsShadow(planRef.current!, job.lod);
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.name = `sf-buildings-${c.key}`;

    if (c.mesh && fadeSeconds() <= 0) {
      // No temporal resolve downstream, so the dissolve would be visible noise
      // rather than a dissolve — see `fadeSeconds` in lod.ts. Swap outright.
      if (c.oldMesh) {
        g.remove(c.oldMesh);
        c.oldMesh.geometry.dispose();
        releaseFadeMaterial(c.oldMesh.material as THREE.MeshStandardMaterial);
        c.oldMesh = null;
        c.fadeIn = null;
        c.fadeOut = null;
      }
      g.remove(c.mesh);
      c.mesh.geometry.dispose();
      if (c.mesh.material !== material) {
        releaseFadeMaterial(c.mesh.material as THREE.MeshStandardMaterial);
      }
      c.mesh = null;
    } else if (c.mesh) {
      // Cross-fade: the outgoing mesh dissolves out while the new one dissolves
      // in. Both get their own fade material, which shares the compiled program
      // with the base one, so this costs no shader compilation.
      if (c.oldMesh) {
        g.remove(c.oldMesh);
        c.oldMesh.geometry.dispose();
        releaseFadeMaterial(c.oldMesh.material as THREE.MeshStandardMaterial);
      }
      const outMat = createFadeMaterial();
      const inMat = createFadeMaterial();
      c.oldMesh = c.mesh;
      if (c.oldMesh.material !== material) releaseFadeMaterial(c.oldMesh.material as THREE.MeshStandardMaterial);
      c.oldMesh.material = outMat.material;
      c.fadeOut = outMat.fade;
      c.fadeOut.value = 1;
      mesh.material = inMat.material;
      c.fadeIn = inMat.fade;
      c.fadeIn.value = 0;
      c.fadeT = 0;
    }

    g.add(mesh);
    c.mesh = mesh;
    c.lod = job.lod;

    // Only the near tiers go into the queryable index: at 1.5 km nothing is
    // going to raycast a building, and 30 000 records would make every grapple
    // shot walk a much longer list.
    if (job.lod <= 1) {
      buildingIndex.insert(c.key, job.records);
      c.indexed = true;
    } else if (c.indexed) {
      buildingIndex.removeChunk(c.key);
      c.indexed = false;
    }
  };

  /* ---------------- frame ---------------- */

  useFrame((_, delta) => {
    const g = group.current;
    const p = planRef.current;
    if (!g || !p) return;

    // Sky → facade uniforms. Allocation-free.
    sunDirection(frame.timeOfDay, _sunDir);
    sunColor(frame.timeOfDay, _sunCol);
    skyFillColor(frame.timeOfDay, _skyCol);
    updateFacadeUniforms(_sunDir, _sunCol, _skyCol, frame.timeOfDay, frame.fogDensity);
    // Where the real city stops and the box city may start.
    setImpostorNearClip(p.nearRadius);

    camera.getWorldPosition(_camPos);
    const now = performance.now();

    // Rescan on movement or on a slow tick, whichever comes first.
    const moved = Math.hypot(_camPos.x - lastScan.current.x, _camPos.z - lastScan.current.z);
    if (moved > RESCAN_DISTANCE || frame.time - lastScan.current.t > RESCAN_SECONDS) {
      lastScan.current.x = _camPos.x;
      lastScan.current.z = _camPos.z;
      lastScan.current.t = frame.time;
      rescan(_camPos.x, _camPos.z);
    }

    /* --- generation budget ---
     *
     * The warmup budget is for holes, not for start-up. It used to latch off
     * the first time the queue drained and never come back, so the city loaded
     * on 11–26 ms a frame and was then re-loaded on 5 as you flew across it —
     * and crossing the map is exactly when the near field is emptiest. What
     * earns the larger budget is the thing you can see: resident chunks in
     * range with nothing drawn for them. When there are none, the city is
     * complete and generation goes back to a slice that never costs a frame. */
    let holes = 0;
    for (const c of chunks.values()) {
      if (!c.mesh && !c.empty) holes++;
    }
    warm.current = holes > 0;
    const budget = holes > 0 ? warmupBudget(q.detailRadius) : BUDGET_MS;
    const deadline = now + budget;

    while (queue.length > 0 && performance.now() < deadline) {
      const job = queue[0];
      const c = chunks.get(job.key);
      if (!c || c.job !== job) {
        queue.shift();
        continue;
      }
      if (job.advance(deadline)) {
        queue.shift();
        commit(c, job);
      } else {
        break; // out of budget mid-chunk; resume next frame
      }
    }

    // Impostor tiles get whatever budget the near field left over, plus a
    // guaranteed slice so the horizon still fills in while you fly.
    const impDeadline = Math.max(performance.now() + 1.2, deadline);
    while (impQueue.length > 0 && performance.now() < impDeadline) {
      const t = impQueue[0];
      if (!t.job) {
        impQueue.shift();
        continue;
      }
      t.job.advance(impDeadline);
      if (!t.job.done) break;
      const data = t.job.result();
      t.job = null;
      impQueue.shift();
      if (data) {
        const mesh = createImpostorMesh(data);
        mesh.name = `sf-impostors-${t.key}`;
        g.add(mesh);
        t.mesh = mesh;
      }
    }

    // --- cross-fades ---
    const dt = Math.min(delta, 1 / 15);
    for (const c of chunks.values()) {
      if (!c.oldMesh) continue;
      c.fadeT += dt / Math.max(fadeSeconds(), 1e-3);
      const t = Math.min(1, c.fadeT);
      if (c.fadeIn) c.fadeIn.value = t;
      if (c.fadeOut) c.fadeOut.value = 1 - t;
      if (t >= 1) {
        g.remove(c.oldMesh);
        c.oldMesh.geometry.dispose();
        releaseFadeMaterial(c.oldMesh.material as THREE.MeshStandardMaterial);
        c.oldMesh = null;
        if (c.mesh && c.mesh.material !== material) {
          releaseFadeMaterial(c.mesh.material as THREE.MeshStandardMaterial);
          c.mesh.material = material;
        }
        c.fadeIn = null;
        c.fadeOut = null;
      }
    }

    // The screenshot harness waits on this before it grabs a frame.
    if (typeof window !== "undefined" && window.__sf) {
      window.__sf.pendingChunks = queue.length + impQueue.length;
      window.__sf.pendingDetail = queue.length;
      window.__sf.pendingImpostor = impQueue.length;
    }
  });

  return <group ref={group} name="sf-buildings" />;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Distance from a point to the nearest edge of an axis-aligned square. */
function boxDistance(px: number, pz: number, x: number, z: number, size: number): number {
  const dx = Math.max(x - px, 0, px - (x + size));
  const dz = Math.max(z - pz, 0, pz - (z + size));
  return Math.hypot(dx, dz);
}

/** Distance to the FARTHEST corner of the same square. */
function boxFarDistance(px: number, pz: number, x: number, z: number, size: number): number {
  const dx = Math.max(Math.abs(px - x), Math.abs(px - (x + size)));
  const dz = Math.max(Math.abs(pz - z), Math.abs(pz - (z + size)));
  return Math.hypot(dx, dz);
}
