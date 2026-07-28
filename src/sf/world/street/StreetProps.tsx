/**
 * StreetProps.tsx — the furniture pools and the frame loop that drives them.
 *
 * Every prop kind in the city is exactly one InstancedMesh. Chunks bake flat
 * matrix blocks (see `streetFurniture.ts`), the streamer decides which chunks are
 * resident, and whenever that set changes the blocks are memcpy'd into the
 * pools nearest-first. The cost of "walk two blocks" is therefore a handful of
 * typed-array copies, not a thousand object allocations.
 *
 * Two things here are live rather than baked:
 *
 *   Traffic signals. Each lens instance carries the node it belongs to and
 *   which of the two phase groups it serves; a quarter-second tick asks
 *   `signalState` what that node is doing and rewrites the instance colours.
 *   Only the colour buffer is touched, so a whole city of working signals costs
 *   one buffer upload every four frames.
 *
 *   Lamps. The glow blobs fade in over about forty minutes of game dusk and out
 *   again at dawn, driven from the same solar position the sky uses, so the
 *   streetlights come on when the streetlights should come on.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { QUALITY } from "../../config";
import { frame, useSfStore } from "../../state/store";
import { sunDirection } from "../../sky/Sky";
import { clamp, clamp01, smoothstep } from "../../math/rng";
import { getMaterial } from "../../materials";
import {
  ChunkStreamer,
  InstancePool,
  disposeObject,
  reportPending,
  type InstanceChunk,
} from "./chunker";
import {
  buildPropChunk,
  buildWireChunk,
  capacityFor,
  disposePropGeometry,
  propGeometry,
  propMaterial,
  type PropKind,
} from "./streetFurniture";
import { roadNetwork, signalState } from "./roadNetwork";

/** Every pool, in the order they are created. */
const KINDS: PropKind[] = [
  "cobra", "ornate", "signal", "stop-sign", "blade", "meter", "hydrant",
  "mailbox", "bin", "newsrack", "shelter", "shelter-glass", "bench", "bollard",
  "utility-pole", "car-sedan", "car-suv", "car-wheel", "barrier", "dumpster",
  "scaffold",
];

/** Props that should not cast shadows: too small, or too many, to be worth it. */
const NO_SHADOW = new Set<PropKind>(["meter", "bollard", "newsrack", "shelter-glass"]);

/* ------------------------------------------------------------------ *
 * Emissive materials
 * ------------------------------------------------------------------ */

/**
 * Lamp glow. Additive and unlit: a street lamp at night is a bloom source, not
 * a shaded object, and trying to make a MeshStandardMaterial emit convincingly
 * costs a full lighting evaluation per pixel for a result that is worse.
 */
function makeGlowMaterial(color: number): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    fog: true,
  });
  m.name = "sf/lamp-glow";
  return m;
}

/** Signal lenses: unlit, per-instance colour, always on (the dark ones are
 *  simply given a near-black colour rather than being culled). */
function makeLensMaterial(): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    toneMapped: false,
    fog: true,
  });
  m.name = "sf/signal-lens";
  return m;
}

/* ------------------------------------------------------------------ *
 * Chunk record
 * ------------------------------------------------------------------ */

interface PropChunkRec {
  key: string;
  x: number;
  z: number;
  size: number;
  data: InstanceChunk;
}

const LENS_ON = [
  new THREE.Color(0xff2a18), // red
  new THREE.Color(0xffa412), // amber
  new THREE.Color(0x38e04a), // green
  new THREE.Color(0xf0e8d8), // pedestrian
];
const LENS_OFF = new THREE.Color(0x101012);

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

const _cam = new THREE.Vector3();
const _sun = new THREE.Vector3();

export default function StreetProps() {
  const tier = useSfStore((s) => s.quality);
  const q = QUALITY[tier];
  const { camera } = useThree();
  const group = useRef<THREE.Group>(null);
  const wireGroup = useRef<THREE.Group>(null);

  /* ---- pools ---- */
  const pools = useMemo(() => {
    const map = new Map<PropKind, InstancePool>();
    for (const k of KINDS) {
      map.set(
        k,
        new InstancePool(propGeometry(k), propMaterial(k), capacityFor(k, tier), {
          castShadow: !NO_SHADOW.has(k),
          receiveShadow: true,
          color: true,
          name: `sf-prop-${k}`,
        }),
      );
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier]);

  const glow = useMemo(() => {
    const mat = makeGlowMaterial(0xffd9a0);
    const pool = new InstancePool(propGeometry("lamp-glow"), mat, capacityFor("lamp-glow", tier), {
      castShadow: false,
      receiveShadow: false,
      color: false,
      name: "sf-prop-lamp-glow",
    });
    return { mat, pool };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier]);

  const lens = useMemo(() => {
    const mat = makeLensMaterial();
    const pool = new InstancePool(propGeometry("signal-lens"), mat, capacityFor("signal-lens", tier), {
      castShadow: false,
      receiveShadow: false,
      color: true,
      name: "sf-prop-signal-lens",
    });
    return { mat, pool };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier]);

  /** Overhead wire material — thin, dark, unlit enough to read as a silhouette. */
  const wireMat = useMemo(
    () => getMaterial("steel-rusted", { vertexColors: true, repeat: 1, name: "sf/overhead-wire", detail: false }),
    [],
  );

  /* ---- resident chunk store ---- */
  const chunks = useRef(new Map<string, PropChunkRec>()).current;
  const lensMeta = useRef<{ node: Int32Array; role: Int32Array; count: number }>({
    node: new Int32Array(0),
    role: new Int32Array(0),
    count: 0,
  }).current;
  const streamer = useRef<ChunkStreamer | null>(null);
  const wireStreamer = useRef<ChunkStreamer | null>(null);
  const dirty = useRef(true);

  /* ---- mount ---- */
  useEffect(() => {
    const g = group.current;
    const wg = wireGroup.current;
    if (!g || !wg) return;
    for (const p of pools.values()) g.add(p.mesh);
    g.add(glow.pool.mesh);
    g.add(lens.pool.mesh);

    // The prop streamer's builder does not add meshes to the scene; it stores
    // baked instance blocks. `ChunkStreamer` still owns the residency logic,
    // which is the part worth sharing.
    const s = new ChunkStreamer(
      new THREE.Group(), // a throwaway parent: nothing is parented per chunk
      (x, z, size) => {
        const key = `${x}:${z}:${size}`;
        chunks.set(key, { key, x, z, size, data: buildPropChunk(x, z, size, tier) });
        dirty.current = true;
        return null;
      },
      () => clamp(q.detailRadius * 0.48, 230, 620),
      () => clamp(q.detailRadius * 0.48, 230, 620),
      { cell: 256, farCell: 256, budgetMs: 2.6, warmupMs: 7 },
    );
    streamer.current = s;

    const ws = new ChunkStreamer(
      wg,
      (x, z, size) => {
        const geo = buildWireChunk(x, z, size);
        if (!geo) return null;
        const m = new THREE.Mesh(geo, wireMat);
        m.position.set(x + size * 0.5, 0, z + size * 0.5);
        m.matrixAutoUpdate = false;
        m.updateMatrix();
        m.castShadow = false;
        m.receiveShadow = false;
        m.name = "sf-overhead-wires";
        return { meshes: [m] };
      },
      () => clamp(q.detailRadius * 0.45, 200, 560),
      () => clamp(q.detailRadius * 0.45, 200, 560),
      { cell: 384, farCell: 384, budgetMs: 1.4, warmupMs: 4 },
    );
    wireStreamer.current = ws;

    return () => {
      s.dispose();
      ws.dispose();
      streamer.current = null;
      wireStreamer.current = null;
      chunks.clear();
      for (const p of pools.values()) {
        g.remove(p.mesh);
        p.dispose();
      }
      g.remove(glow.pool.mesh);
      glow.pool.dispose();
      glow.mat.dispose();
      g.remove(lens.pool.mesh);
      lens.pool.dispose();
      lens.mat.dispose();
      for (const c of wg.children.slice()) {
        wg.remove(c);
        disposeObject(c);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pools, glow, lens, tier, q.detailRadius, wireMat, chunks]);

  /* ---- pool refill ---- */
  const refill = (cx: number, cz: number): void => {
    // Nearest chunks first so the capacity ceiling drops the far ones.
    const list = Array.from(chunks.values());
    list.sort(
      (a, b) =>
        (a.x + a.size * 0.5 - cx) ** 2 + (a.z + a.size * 0.5 - cz) ** 2 -
        ((b.x + b.size * 0.5 - cx) ** 2 + (b.z + b.size * 0.5 - cz) ** 2),
    );
    for (const p of pools.values()) p.begin();
    glow.pool.begin();
    lens.pool.begin();

    // Grow the lens metadata arrays if the capacity changed.
    const lensCap = lens.pool.capacity;
    if (lensMeta.node.length < lensCap) {
      lensMeta.node = new Int32Array(lensCap);
      lensMeta.role = new Int32Array(lensCap);
    }
    let lensN = 0;

    for (const rec of list) {
      for (const [kind, block] of rec.data) {
        if (kind === "lamp-glow") {
          glow.pool.pushBlock(block.mat, block.n, null);
          continue;
        }
        if (kind === "signal-lens") {
          const taken = lens.pool.pushBlock(block.mat, block.n, null);
          for (let i = 0; i < taken && lensN < lensCap; i++) {
            lensMeta.node[lensN] = block.meta[i * 2];
            lensMeta.role[lensN] = block.meta[i * 2 + 1];
            lensN++;
          }
          continue;
        }
        const pool = pools.get(kind as PropKind);
        if (pool) pool.pushBlock(block.mat, block.n, block.col);
      }
    }
    lensMeta.count = lensN;
    for (const p of pools.values()) p.end();
    glow.pool.end();
    lens.pool.end();
  };

  /* ---- frame ---- */
  const lastSignal = useRef(-1);

  useFrame(() => {
    const s = streamer.current;
    const ws = wireStreamer.current;
    if (!s || !ws) return;
    camera.getWorldPosition(_cam);

    s.update(_cam.x, _cam.z, frame.time, () => {
      // Evict baked data for chunks the streamer dropped.
      const live = new Set<string>();
      s.forEachResident((_k, x, z, size) => live.add(`${x}:${z}:${size}`));
      for (const key of Array.from(chunks.keys())) {
        if (!live.has(key)) chunks.delete(key);
      }
      dirty.current = true;
    });
    ws.update(_cam.x, _cam.z, frame.time);

    if (dirty.current) {
      dirty.current = false;
      refill(_cam.x, _cam.z);
      lastSignal.current = -1; // force a signal repaint against the new indices
    }

    // --- lamps ---
    sunDirection(frame.timeOfDay, _sun);
    // Lamps switch on as the sun drops below about 4° and are full at -3°.
    const night = clamp01(1 - smoothstep(-0.05, 0.07, _sun.y));
    const target = night * 0.85;
    if (Math.abs(glow.mat.opacity - target) > 0.002) {
      glow.mat.opacity = target;
      glow.pool.mesh.visible = target > 0.004;
    }

    // --- traffic signals, four times a second ---
    if (frame.time - lastSignal.current > 0.25 && lensMeta.count > 0) {
      lastSignal.current = frame.time;
      for (let i = 0; i < lensMeta.count; i++) {
        const nodeId = lensMeta.node[i];
        const role = lensMeta.role[i];
        const group = role >> 2;
        const lamp = role & 3;
        const n = roadNetwork.nodes[nodeId];
        if (!n) continue;
        const st = signalState(n, frame.time);
        const isGreen = st.green === group;
        let lit = false;
        if (lamp === 0) lit = !isGreen || st.allRed;       // red
        else if (lamp === 1) lit = isGreen && st.amber;     // amber
        else if (lamp === 2) lit = isGreen && !st.amber && !st.allRed; // green
        else lit = isGreen && !st.amber && !st.allRed;      // walk
        const c = lit ? LENS_ON[lamp] : LENS_OFF;
        lens.pool.setColorAt(i, c.r, c.g, c.b);
      }
      lens.pool.flushColors();
    }

    reportPending(s.pending + ws.pending);
  });

  useEffect(() => () => disposePropGeometry(), []);

  return (
    <>
      <group ref={group} name="sf-street-props" />
      <group ref={wireGroup} name="sf-overhead-wires" />
    </>
  );
}
