/**
 * The people.
 *
 * Several hundred of them, walking the pavement graph in `cityplan.ts` with
 * somewhere to actually be: a shop door, the Beacon, the tram platform, a
 * bench in the Terraces, a stretch of rim rail with four hundred metres of
 * nothing under it. They path there, they arrive, they do something for a
 * while, and then they pick somewhere else.
 *
 * ## Why the crowd is the performance story of this world
 *
 * Everything else here is drawn once and shaded; the crowd is six hundred
 * things that all move, all animate, and all need deciding about. The rule
 * that keeps it affordable is that **the CPU moves people and the GPU poses
 * them**. Per frame, per person, the CPU writes a position, a facing, a walk
 * phase and three pose weights — seventeen floats. It never touches a limb.
 * The whole walk cycle, the sit, the lean on the rail and the head tilting up
 * at a jetpack are solved in the vertex shader from that phase and those
 * weights, so a hurrying courier and a man on a bench cost the same.
 *
 * Three consequences worth knowing before changing anything here:
 *
 * - **Nothing allocates in `update`.** Every array, every scratch vector and
 *   the entire A* workspace is built once. A crowd is exactly the size of
 *   system where a per-frame object literal becomes a visible collection
 *   pause.
 * - **Pathfinding is amortised.** `REPATH_BUDGET` searches run per frame and
 *   everybody else waits their turn — standing still, which is what a person
 *   deciding where to go looks like anyway.
 * - **LOD is by distance and it is hard.** Full articulation to 45 m, a
 *   six-box body to 130 m, a three-band billboard to 260 m, nothing beyond.
 *
 * ## The graph is the plan's, with two corrections
 *
 * `cityPlan().nav` is built from street centrelines and offsets, and a couple
 * of hundred of its nodes land a few centimetres outside the pavement they
 * were meant to be on — the rim ring is the whole of it, offset by the *ring*
 * road's width when the rim road is narrower. A pedestrian standing there is
 * standing in a flowerbed. So every node is probed with `surfaceAt` and nudged
 * up to 2.6 m onto real pavement if it needs it, every edge is sampled along
 * its length and dropped if it cuts through a lot, and what survives is
 * reduced to its largest connected component. That is 1419 nodes and ~5260
 * edges of the plan's ~5416, still one piece, with every one of the 138 shop
 * doors reachable. It is done here rather than in the plan because it is a
 * *walking* correction: traffic and couriers may well want the raw graph.
 */
import * as THREE from "three";
import { makeRng } from "@/shared/proc/rng";
import {
  cityPlan,
  districtAt,
  surfaceAt,
  HALO_R,
  LANDMARKS,
  RIM_R,
  RING_R,
  type DistrictId,
} from "./cityplan";
import { ISLAND_Y, PLATEAU_R } from "./config";
import { SUN_DIR } from "./sky";
import type { BuildContext, FrameContext, System } from "./types";

export interface CrowdHandle extends System {
  /** Live population, for the HUD and for debugging. */
  readonly count: number;
  /** Nearest pedestrian to a point, for interactions later. */
  nearest(
    x: number,
    z: number,
    maxDist: number,
  ): { x: number; y: number; z: number; id: number } | null;
}

/* -------------------------------------------------------------------------
 * Tuning
 * ---------------------------------------------------------------------- */

/** Population before daylight scaling. Low tier is the 60% cut. */
const POP = { high: 620, low: 248 } as const;

/** LOD ring radii, metres. Past the last one a person is not drawn at all. */
const LOD_NEAR = 45;
const LOD_MID = 130;
const LOD_FAR = 260;

/** A* searches per frame. Everyone else stands still and waits. */
const REPATH_BUDGET = 4;

/** Longest path a body will hold. Longer trips are walked in stages. */
const MAX_PATH = 48;

/** Avoidance grid. 6 m cells over the whole deck. */
const CELL = 6;
const GRID_N = Math.ceil((PLATEAU_R * 2 + 20) / CELL);
const GRID_ORIGIN = -PLATEAU_R - 10;

const TAU = Math.PI * 2;

/** What a body is doing. */
const ST_WALK = 0;
const ST_STAND = 1;
const ST_SIT = 2;
const ST_LEAN = 3;
const ST_WAIT = 4;

/** What it is walking toward. Decides what it does when it gets there. */
const D_DOOR = 0;
const D_LANDMARK = 1;
const D_RIM = 2;
const D_SIT = 3;
const D_TRAM = 4;
const D_PLAZA = 5;

const DISTRICT_IDS: DistrictId[] = ["halo", "core", "market", "gardens", "rim"];

/**
 * How busy each district is, and how that moves with the light.
 *
 * The Bazaar is crowded and gets more so as the sun goes; the Rim is sparse
 * and empties after dark, because the whole point of standing at the edge is
 * the view. `base` is the weight at noon, `dusk` is added as daylight fails.
 */
const DISTRICT_PULL: Record<DistrictId, { base: number; dusk: number }> = {
  halo: { base: 1.5, dusk: 0.5 },
  core: { base: 1.7, dusk: -0.2 },
  market: { base: 3.0, dusk: 1.4 },
  gardens: { base: 1.5, dusk: -0.5 },
  rim: { base: 1.0, dusk: -0.55 },
};

/* -------------------------------------------------------------------------
 * The walk graph
 * ---------------------------------------------------------------------- */

interface WalkGraph {
  n: number;
  x: Float32Array;
  z: Float32Array;
  y: Float32Array;
  width: Float32Array;
  district: Uint8Array;
  /** CSR adjacency: neighbours of i are list[start[i] … start[i + 1]). */
  start: Int32Array;
  list: Int32Array;
}

/** Eight directions at four distances — the nudge search, cheapest first. */
const NUDGE: number[] = [];
for (const d of [0.6, 1.2, 1.8, 2.6]) {
  for (let i = 0; i < 8; i++) {
    NUDGE.push(Math.cos((i / 8) * TAU) * d, Math.sin((i / 8) * TAU) * d);
  }
}

function buildWalkGraph(): WalkGraph {
  const nav = cityPlan().nav;
  const raw = nav.length;
  const px = new Float64Array(raw);
  const pz = new Float64Array(raw);
  const ok = new Uint8Array(raw);

  for (let i = 0; i < raw; i++) {
    const node = nav[i];
    px[i] = node.x;
    pz[i] = node.z;
    const kind = surfaceAt(node.x, node.z).kind;
    if (kind === "walk" || kind === "plaza" || kind === "road") {
      ok[i] = 1;
      continue;
    }
    for (let k = 0; k < NUDGE.length; k += 2) {
      const nx = node.x + NUDGE[k];
      const nz = node.z + NUDGE[k + 1];
      const kk = surfaceAt(nx, nz).kind;
      if (kk === "walk" || kk === "plaza") {
        px[i] = nx;
        pz[i] = nz;
        ok[i] = 1;
        break;
      }
    }
  }

  // An edge survives if nothing along it is a building plot, the parapet or
  // the void. Sampled rather than reasoned about: the graph stitches crossings
  // by proximity, and a few of them cut a corner through a block.
  const passable = (a: number, b: number): boolean => {
    const ax = px[a];
    const az = pz[a];
    const dx = px[b] - ax;
    const dz = pz[b] - az;
    for (let s = 1; s < 8; s++) {
      const t = s / 8;
      const kind = surfaceAt(ax + dx * t, az + dz * t).kind;
      if (kind === "lot" || kind === "void" || kind === "parapet") return false;
    }
    return true;
  };

  const deg = new Int32Array(raw);
  const edgeA: number[] = [];
  const edgeB: number[] = [];
  for (let i = 0; i < raw; i++) {
    if (!ok[i]) continue;
    for (const j of nav[i].links) {
      if (j <= i || !ok[j]) continue;
      if (!passable(i, j)) continue;
      edgeA.push(i);
      edgeB.push(j);
      deg[i]++;
      deg[j]++;
    }
  }

  // Largest connected component, so no body is ever handed a destination it
  // cannot reach and no A* ever runs to exhaustion.
  const head = new Int32Array(raw).fill(-1);
  const next = new Int32Array(edgeA.length * 2).fill(-1);
  const to = new Int32Array(edgeA.length * 2);
  let slot = 0;
  const push = (from: number, dest: number) => {
    to[slot] = dest;
    next[slot] = head[from];
    head[from] = slot;
    slot++;
  };
  for (let e = 0; e < edgeA.length; e++) {
    push(edgeA[e], edgeB[e]);
    push(edgeB[e], edgeA[e]);
  }

  const comp = new Int32Array(raw).fill(-1);
  const stack = new Int32Array(raw);
  let bestComp = -1;
  let bestSize = 0;
  let compId = 0;
  for (let seed = 0; seed < raw; seed++) {
    if (!ok[seed] || comp[seed] >= 0) continue;
    let top = 0;
    stack[top++] = seed;
    comp[seed] = compId;
    let size = 1;
    while (top > 0) {
      const cur = stack[--top];
      for (let e = head[cur]; e >= 0; e = next[e]) {
        const nb = to[e];
        if (comp[nb] >= 0) continue;
        comp[nb] = compId;
        size++;
        stack[top++] = nb;
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestComp = compId;
    }
    compId++;
  }

  // Compact the survivors into dense arrays. Everything downstream indexes
  // this graph and never has to ask whether a node is real.
  const remap = new Int32Array(raw).fill(-1);
  let n = 0;
  for (let i = 0; i < raw; i++) if (ok[i] && comp[i] === bestComp) remap[i] = n++;

  const gx = new Float32Array(n);
  const gz = new Float32Array(n);
  const gy = new Float32Array(n);
  const gw = new Float32Array(n);
  const gd = new Uint8Array(n);
  const gstart = new Int32Array(n + 1);
  for (let i = 0; i < raw; i++) {
    const id = remap[i];
    if (id < 0) continue;
    gx[id] = px[i];
    gz[id] = pz[i];
    gy[id] = surfaceAt(px[i], pz[i]).y;
    gw[id] = nav[i].width;
    gd[id] = DISTRICT_IDS.indexOf(districtAt(Math.hypot(px[i], pz[i])).id);
    gstart[id + 1] = deg[i];
  }
  for (let i = 0; i < n; i++) gstart[i + 1] += gstart[i];
  const glist = new Int32Array(gstart[n]);
  const cursor = gstart.slice(0, n);
  for (let e = 0; e < edgeA.length; e++) {
    const a = remap[edgeA[e]];
    const b = remap[edgeB[e]];
    if (a < 0 || b < 0) continue;
    glist[cursor[a]++] = b;
    glist[cursor[b]++] = a;
  }
  // `deg` counted edges before the component filter, so a node on the fringe
  // can have spare slots. Point them at the node itself; A* skips self-links.
  for (let i = 0; i < n; i++) {
    for (let k = cursor[i]; k < gstart[i + 1]; k++) glist[k] = i;
  }

  return { n, x: gx, z: gz, y: gy, width: gw, district: gd, start: gstart, list: glist };
}

/* -------------------------------------------------------------------------
 * Destinations
 * ---------------------------------------------------------------------- */

interface DestPool {
  node: Int32Array;
  kind: Uint8Array;
  /** Which way a body faces once it gets there. */
  faceX: Float32Array;
  faceZ: Float32Array;
  n: number;
}

/**
 * The tram's platform angles.
 *
 * Duplicated from `traffic.ts` on purpose: a system may not import another
 * system, and this is four numbers that both of them derive from the same
 * ring road. If the tram route changes, change it in both — a queue at a
 * platform no tram stops at is a bug you will see and not a crash.
 */
const TRAM_STOP_A = [Math.PI, Math.PI * 0.75, Math.PI * 0.25, -Math.PI / 2];

export function buildCrowd(ctx: BuildContext): CrowdHandle {
  const rng = makeRng(`empyrean-crowd:${ctx.seedSalt}`);
  const graph = buildWalkGraph();
  const plan = cityPlan();
  const group = new THREE.Group();
  group.name = "empyrean-crowd";

  /* ---- a coarse index over the graph, for "which node is nearest" -------
   * Only used at build time, but it turns a few hundred thousand distance
   * tests into a few thousand. */
  const nodeCell = new Int32Array(GRID_N * GRID_N).fill(-1);
  const nodeNext = new Int32Array(graph.n).fill(-1);
  const cellOf = (x: number, z: number): number => {
    const cx = Math.min(GRID_N - 1, Math.max(0, Math.floor((x - GRID_ORIGIN) / CELL)));
    const cz = Math.min(GRID_N - 1, Math.max(0, Math.floor((z - GRID_ORIGIN) / CELL)));
    return cz * GRID_N + cx;
  };
  for (let i = 0; i < graph.n; i++) {
    const c = cellOf(graph.x[i], graph.z[i]);
    nodeNext[i] = nodeCell[c];
    nodeCell[c] = i;
  }
  const nearestNode = (x: number, z: number, maxDist: number): number => {
    const rings = Math.ceil(maxDist / CELL);
    const cx = Math.floor((x - GRID_ORIGIN) / CELL);
    const cz = Math.floor((z - GRID_ORIGIN) / CELL);
    let best = -1;
    let bestD = maxDist * maxDist;
    for (let dz = -rings; dz <= rings; dz++) {
      const rz = cz + dz;
      if (rz < 0 || rz >= GRID_N) continue;
      for (let dx = -rings; dx <= rings; dx++) {
        const rx = cx + dx;
        if (rx < 0 || rx >= GRID_N) continue;
        for (let i = nodeCell[rz * GRID_N + rx]; i >= 0; i = nodeNext[i]) {
          const q = (graph.x[i] - x) ** 2 + (graph.z[i] - z) ** 2;
          if (q < bestD) {
            bestD = q;
            best = i;
          }
        }
      }
    }
    return best;
  };

  /* ---- the pool of places worth going ---------------------------------- */
  const dNode: number[] = [];
  const dKind: number[] = [];
  const dFx: number[] = [];
  const dFz: number[] = [];

  const addDest = (node: number, kind: number, fx: number, fz: number) => {
    if (node < 0) return;
    const len = Math.hypot(fx, fz) || 1;
    dNode.push(node);
    dKind.push(kind);
    dFx.push(fx / len);
    dFz.push(fz / len);
  };

  // Shop doors. The doorstep, not the wall — see the note in cityplan.ts.
  for (const door of plan.doors) {
    addDest(nearestNode(door.x, door.z, 9), D_DOOR, -door.nx, -door.nz);
  }
  // Landmarks: a handful of standing spots each, all facing the thing.
  for (const lm of LANDMARKS) {
    const want = lm.kind === "beacon" ? 10 : 5;
    let found = 0;
    for (let step = 0; step < 24 && found < want; step++) {
      const a = (step / 24) * TAU;
      const r = lm.clear + 12;
      const node = nearestNode(lm.x + Math.cos(a) * r, lm.z + Math.sin(a) * r, 14);
      if (node < 0) continue;
      addDest(node, D_LANDMARK, lm.x - graph.x[node], lm.z - graph.z[node]);
      found++;
    }
  }
  // The rim rail. Facing out, because that is the entire reason to be there.
  for (let i = 0; i < graph.n; i++) {
    const r = Math.hypot(graph.x[i], graph.z[i]);
    if (r < RIM_R - 4) continue;
    addDest(i, D_RIM, graph.x[i], graph.z[i]);
  }
  // Somewhere to sit: wide pavement in the Terraces and around the Halo.
  for (let i = 0; i < graph.n; i++) {
    const r = Math.hypot(graph.x[i], graph.z[i]);
    const wide = graph.width[i] >= 4.4;
    const green = r > RING_R[1] && r < RING_R[2];
    if (!wide && !green) continue;
    if (!rng.chance(green ? 0.16 : 0.07)) continue;
    const a = rng.range(0, TAU);
    addDest(i, D_SIT, Math.cos(a), Math.sin(a));
  }
  // The tram platforms, on the inner pavement of the middle ring.
  for (const a of TRAM_STOP_A) {
    const pr = RING_R[1] - 9.5;
    const node = nearestNode(Math.cos(a) * pr, Math.sin(a) * pr, 16);
    addDest(node, D_TRAM, Math.cos(a) * RING_R[1] - graph.x[node], Math.sin(a) * RING_R[1] - graph.z[node]);
  }
  // The Halo itself, which is where you go to be somewhere.
  for (let i = 0; i < graph.n; i++) {
    if (Math.hypot(graph.x[i], graph.z[i]) > HALO_R + 14) continue;
    addDest(i, D_PLAZA, -graph.x[i], -graph.z[i]);
  }

  const dests: DestPool = {
    node: Int32Array.from(dNode),
    kind: Uint8Array.from(dKind),
    faceX: Float32Array.from(dFx),
    faceZ: Float32Array.from(dFz),
    n: dNode.length,
  };

  /* ---- A* workspace, allocated once ------------------------------------ */
  const gScore = new Float32Array(graph.n);
  const fScore = new Float32Array(graph.n);
  const cameFrom = new Int32Array(graph.n);
  const stamp = new Int32Array(graph.n).fill(-1);
  const closed = new Uint8Array(graph.n);
  // One slot per directed edge plus one per node: A* here has no decrease-key,
  // so a node is pushed once per better route found and the heap can hold far
  // more entries than there are nodes. Sizing it to the node count overflows
  // in silence — typed arrays drop out-of-range writes — and the search then
  // walks a heap full of zeroes.
  const HEAP_CAP = graph.list.length + graph.n + 16;
  const heapId = new Int32Array(HEAP_CAP);
  const heapKey = new Float32Array(HEAP_CAP);
  const trace = new Int32Array(graph.n);
  let generation = 0;

  const heapPush = (size: number, id: number, key: number): number => {
    if (size >= HEAP_CAP) return size;
    let i = size;
    heapId[i] = id;
    heapKey[i] = key;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heapKey[parent] <= heapKey[i]) break;
      const ti = heapId[i];
      const tk = heapKey[i];
      heapId[i] = heapId[parent];
      heapKey[i] = heapKey[parent];
      heapId[parent] = ti;
      heapKey[parent] = tk;
      i = parent;
    }
    return size + 1;
  };

  const heapPop = (size: number): number => {
    const last = size - 1;
    heapId[0] = heapId[last];
    heapKey[0] = heapKey[last];
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let small = i;
      if (l < last && heapKey[l] < heapKey[small]) small = l;
      if (r < last && heapKey[r] < heapKey[small]) small = r;
      if (small === i) break;
      const ti = heapId[i];
      const tk = heapKey[i];
      heapId[i] = heapId[small];
      heapKey[i] = heapKey[small];
      heapId[small] = ti;
      heapKey[small] = tk;
      i = small;
    }
    return last;
  };

  /* ---- bodies ---------------------------------------------------------- */
  const MAX = ctx.quality === "low" ? POP.low : POP.high;

  const ax = new Float32Array(MAX);
  const ay = new Float32Array(MAX);
  const az = new Float32Array(MAX);
  const avx = new Float32Array(MAX);
  const avz = new Float32Array(MAX);
  const ayaw = new Float32Array(MAX);
  const aspeed = new Float32Array(MAX);
  const aphase = new Float32Array(MAX);
  const agait = new Float32Array(MAX);
  const agesture = new Float32Array(MAX);
  const aSit = new Float32Array(MAX);
  const aLean = new Float32Array(MAX);
  const aLook = new Float32Array(MAX);
  const aLookT = new Float32Array(MAX);
  const aState = new Uint8Array(MAX);
  const aTimer = new Float32Array(MAX);
  const aHeight = new Float32Array(MAX);
  const aBuild = new Float32Array(MAX);
  const aAcc = new Float32Array(MAX);
  const aTopC = new Float32Array(MAX * 3);
  const aBotC = new Float32Array(MAX * 3);
  const aSkinC = new Float32Array(MAX * 3);
  const aPartner = new Int32Array(MAX).fill(-1);
  const aDestNode = new Int32Array(MAX).fill(-1);
  const aDestKind = new Uint8Array(MAX);
  const aFaceX = new Float32Array(MAX);
  const aFaceZ = new Float32Array(MAX);
  const aQueued = new Uint8Array(MAX);
  const aActive = new Uint8Array(MAX);
  const aHurry = new Float32Array(MAX);

  // Path storage. One fixed-size slice per body; long trips are re-planned
  // when the slice runs out, which is what `aDestNode` is still holding.
  const path = new Int32Array(MAX * MAX_PATH);
  const pathLen = new Int32Array(MAX);
  const pathIdx = new Int32Array(MAX);

  // The segment a body is on, resolved once when it steps onto it: the two
  // endpoints, the sideways offset that keeps it on the pavement, and the
  // heights at each end. Nothing in the per-frame loop calls `surfaceAt`.
  const segAx = new Float32Array(MAX);
  const segAz = new Float32Array(MAX);
  const segAy = new Float32Array(MAX);
  const segTx = new Float32Array(MAX);
  const segTz = new Float32Array(MAX);
  const segTy = new Float32Array(MAX);

  const repathQueue = new Int32Array(MAX);
  let repathHead = 0;
  let repathTail = 0;
  let repathCount = 0;

  const requestPath = (i: number) => {
    if (aQueued[i]) return;
    aQueued[i] = 1;
    repathQueue[repathTail] = i;
    repathTail = (repathTail + 1) % MAX;
    repathCount++;
  };

  /* ---- appearance ------------------------------------------------------ */
  const SKINS = [0x6b4634, 0x8a5c3e, 0xb07a52, 0xcf9b71, 0xe4bb92, 0xf0d0ad];
  const TOPS = [
    0x2f3f66, 0x8a3f4e, 0x2f6b58, 0x7a5a2e, 0x4a3b6b, 0xa8552f, 0x3d6f8a, 0xb08a4a,
    0x8f4f7a, 0x35505a, 0xc06a55, 0x5b7a3f,
  ];
  const BOTTOMS = [0x22242e, 0x3a3340, 0x4a4438, 0x2b3644, 0x5a4a3f, 0x1e2a2e, 0x6a5f52];
  const tmpColor = new THREE.Color();

  const setColor = (arr: Float32Array, i: number, hex: number, jitter: number) => {
    tmpColor.setHex(hex);
    const k = 1 + rng.range(-jitter, jitter);
    arr[i * 3] = tmpColor.r * k;
    arr[i * 3 + 1] = tmpColor.g * k;
    arr[i * 3 + 2] = tmpColor.b * k;
  };

  for (let i = 0; i < MAX; i++) {
    aHeight[i] = rng.range(0.90, 1.09);
    aBuild[i] = rng.range(0.86, 1.16);
    aAcc[i] = rng.chance(0.34) ? (rng.chance(0.5) ? 1 : rng.chance(0.65) ? 2 : 3) : 0;
    setColor(aTopC, i, rng.pick(TOPS), 0.18);
    setColor(aBotC, i, rng.pick(BOTTOMS), 0.14);
    setColor(aSkinC, i, rng.pick(SKINS), 0.06);
    aHurry[i] = rng.chance(0.22) ? rng.range(1.55, 2.1) : rng.range(0.95, 1.2);
    aphase[i] = rng.next();
  }
  // Pairs. Two people who arrived together, go together, and stand facing
  // each other outside a shop for a minute at a time — the single strongest
  // "somebody lives here" read there is, and it costs one integer.
  for (let i = 0; i + 1 < MAX; i += 2) {
    if (!rng.chance(0.22)) continue;
    aPartner[i] = i + 1;
    aPartner[i + 1] = i;
  }

  /* ---- where everybody starts ------------------------------------------ */
  for (let i = 0; i < MAX; i++) {
    const node = Math.floor(rng.next() * graph.n);
    ax[i] = graph.x[node];
    az[i] = graph.z[node];
    ay[i] = graph.y[node];
    segAx[i] = ax[i];
    segAz[i] = az[i];
    segAy[i] = ay[i];
    segTx[i] = ax[i];
    segTz[i] = az[i];
    segTy[i] = ay[i];
    ayaw[i] = rng.range(0, TAU);
    aState[i] = ST_WAIT;
    aTimer[i] = rng.range(0, 6);
    aActive[i] = 1;
    aspeed[i] = 1.25 * aHurry[i];
  }

  /* -----------------------------------------------------------------------
   * Geometry
   * -------------------------------------------------------------------- */

  /**
   * Ten boxes and a part index, and the vertex shader does the rest.
   *
   * Part ids are a contract with the shader: 0 head, 1 torso, 2/3 arms,
   * 4/5 thighs, 6/7 shins, 8 head accessory, 9 body accessory. Even part ids
   * are the left side. The mid-detail body drops the shins and the
   * accessories and keeps the same ids, so both share one material.
   */
  interface BoxSpec {
    cx: number;
    cy: number;
    cz: number;
    sx: number;
    sy: number;
    sz: number;
    part: number;
  }

  const FULL_BODY: BoxSpec[] = [
    { cx: 0, cy: 1.585, cz: 0, sx: 0.205, sy: 0.235, sz: 0.215, part: 0 },
    { cx: 0, cy: 1.19, cz: 0, sx: 0.40, sy: 0.60, sz: 0.235, part: 1 },
    { cx: 0.245, cy: 1.15, cz: 0, sx: 0.115, sy: 0.52, sz: 0.115, part: 2 },
    { cx: -0.245, cy: 1.15, cz: 0, sx: 0.115, sy: 0.52, sz: 0.115, part: 3 },
    { cx: 0.105, cy: 0.685, cz: 0, sx: 0.165, sy: 0.44, sz: 0.165, part: 4 },
    { cx: -0.105, cy: 0.685, cz: 0, sx: 0.165, sy: 0.44, sz: 0.165, part: 5 },
    { cx: 0.105, cy: 0.235, cz: 0, sx: 0.145, sy: 0.47, sz: 0.15, part: 6 },
    { cx: -0.105, cy: 0.235, cz: 0, sx: 0.145, sy: 0.47, sz: 0.15, part: 7 },
    { cx: 0, cy: 0, cz: 0, sx: 0.28, sy: 0.28, sz: 0.28, part: 8 },
    { cx: 0, cy: 0, cz: 0, sx: 0.28, sy: 0.28, sz: 0.28, part: 9 },
  ];

  const MID_BODY: BoxSpec[] = [
    { cx: 0, cy: 1.585, cz: 0, sx: 0.205, sy: 0.235, sz: 0.215, part: 0 },
    { cx: 0, cy: 1.19, cz: 0, sx: 0.40, sy: 0.60, sz: 0.235, part: 1 },
    { cx: 0.245, cy: 1.15, cz: 0, sx: 0.115, sy: 0.52, sz: 0.115, part: 2 },
    { cx: -0.245, cy: 1.15, cz: 0, sx: 0.115, sy: 0.52, sz: 0.115, part: 3 },
    { cx: 0.105, cy: 0.46, cz: 0, sx: 0.165, sy: 0.90, sz: 0.165, part: 4 },
    { cx: -0.105, cy: 0.46, cz: 0, sx: 0.165, sy: 0.90, sz: 0.165, part: 5 },
  ];

  const FACES: Array<[number, number, number]> = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];

  function boxBody(boxes: BoxSpec[]): {
    position: Float32Array;
    normal: Float32Array;
    part: Float32Array;
    index: Uint16Array;
  } {
    const verts = boxes.length * 24;
    const position = new Float32Array(verts * 3);
    const normal = new Float32Array(verts * 3);
    const part = new Float32Array(verts);
    const index = new Uint16Array(boxes.length * 36);
    let v = 0;
    let ii = 0;
    for (const b of boxes) {
      const hx = b.sx / 2;
      const hy = b.sy / 2;
      const hz = b.sz / 2;
      for (const [nx, ny, nz] of FACES) {
        // Two in-plane axes for this face, so the quad winds outward.
        const ux = ny !== 0 || nz !== 0 ? 1 : 0;
        const uy = nx !== 0 ? 1 : 0;
        const uz = 0;
        const vx = ny * uz - nz * uy;
        const vy = nz * ux - nx * uz;
        const vz = nx * uy - ny * ux;
        const base = v;
        for (const [su, sv] of [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ]) {
          const lx = nx * hx + (ux * su + vx * sv) * hx;
          const ly = ny * hy + (uy * su + vy * sv) * hy;
          const lz = nz * hz + (uz * su + vz * sv) * hz;
          position[v * 3] = b.cx + lx;
          position[v * 3 + 1] = b.cy + ly;
          position[v * 3 + 2] = b.cz + lz;
          normal[v * 3] = nx;
          normal[v * 3 + 1] = ny;
          normal[v * 3 + 2] = nz;
          part[v] = b.part;
          v++;
        }
        index[ii++] = base;
        index[ii++] = base + 1;
        index[ii++] = base + 2;
        index[ii++] = base;
        index[ii++] = base + 2;
        index[ii++] = base + 3;
      }
    }
    return { position, normal, part, index };
  }

  /** Three stacked quads — legs, body, head — for the far tier. */
  function billboardBody(): {
    position: Float32Array;
    normal: Float32Array;
    part: Float32Array;
    index: Uint16Array;
  } {
    const bands: Array<[number, number, number, number]> = [
      [0.0, 0.47, 0.17, 4],
      [0.44, 0.83, 0.23, 1],
      [0.81, 1.0, 0.11, 0],
    ];
    const position = new Float32Array(bands.length * 4 * 3);
    const normal = new Float32Array(bands.length * 4 * 3);
    const part = new Float32Array(bands.length * 4);
    const index = new Uint16Array(bands.length * 6);
    let v = 0;
    let ii = 0;
    for (const [y0, y1, halfW, p] of bands) {
      const base = v;
      for (const [sx, y] of [
        [-1, y0],
        [1, y0],
        [1, y1],
        [-1, y1],
      ]) {
        position[v * 3] = sx * halfW;
        position[v * 3 + 1] = y;
        position[v * 3 + 2] = 0;
        normal[v * 3 + 2] = 1;
        part[v] = p;
        v++;
      }
      index[ii++] = base;
      index[ii++] = base + 1;
      index[ii++] = base + 2;
      index[ii++] = base;
      index[ii++] = base + 2;
      index[ii++] = base + 3;
    }
    return { position, normal, part, index };
  }

  /* -----------------------------------------------------------------------
   * Shaders
   * -------------------------------------------------------------------- */

  const BODY_VERT = /* glsl */ `
    #define TAU 6.2831853
    uniform float uTime;

    attribute float aPart;
    attribute vec3 aPos;
    attribute float aYaw;
    attribute vec3 aAnim;   // walk phase 0..1, gait amplitude, gesture
    attribute vec3 aPose;   // sit, lean, look-up
    attribute vec3 aBody;   // height scale, build scale, accessory kind
    attribute vec3 aTop;
    attribute vec3 aBot;
    attribute vec3 aSkin;

    varying vec3 vCol;
    varying vec3 vNrm;
    varying vec3 vView;
    varying float vUp;

    vec3 rotX(vec3 p, float a) {
      float s = sin(a), c = cos(a);
      return vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
    }

    void main() {
      float part = aPart;
      // Even parts are the left of the body; the two sides swing in antiphase.
      float side = mod(part, 2.0) < 0.5 ? 1.0 : -1.0;
      float ph = aAnim.x * TAU + (side > 0.0 ? 0.0 : 3.14159265);
      float gait = aAnim.y;
      float sit = aPose.x;
      float lean = aPose.y;
      float look = aPose.z;

      /* One walk cycle, four angles. The knee only ever bends backwards,
         which is the difference between a person and a marionette. */
      float thigh = gait * 0.62 * sin(ph);
      float knee = -gait * 0.95 * max(0.0, sin(ph + 2.25)) - gait * 0.10;
      float arm = -gait * 0.55 * sin(ph)
                + aAnim.z * 0.42 * sin(uTime * 4.6 + aPos.x * 0.7) * side;
      float torso = gait * 0.09 + lean * 0.34 - sit * 0.05;
      float head = look * 0.72 - lean * 0.14 + sin(uTime * 0.7 + aPos.z) * 0.03;

      thigh = mix(thigh, 1.46, sit);
      knee = mix(knee, -1.55, sit);
      arm = mix(arm, 0.24, sit);

      vec3 p = position;
      vec3 n = normal;

      vec3 hip = vec3(side * 0.105, 0.90, 0.0);
      vec3 kneeP = vec3(side * 0.105, 0.47, 0.0);
      vec3 shoulder = vec3(side * 0.245, 1.40, 0.0);
      vec3 waist = vec3(0.0, 0.92, 0.0);
      vec3 neck = vec3(0.0, 1.47, 0.0);

      /* Accessories are one cube each, moved and squashed into whatever this
         body is carrying, or collapsed to a point when it is carrying
         nothing. A hat, a pack and an umbrella is three silhouettes for the
         price of two boxes. */
      if (part > 7.5) {
        float acc = aBody.z;
        float show = 0.0;
        if (part < 8.5) {
          if (acc > 0.5 && acc < 1.5) { p = p * vec3(1.18, 0.34, 1.18) + vec3(0.0, 1.745, 0.0); show = 1.0; }
          else if (acc > 2.5) { p = p * vec3(3.4, 0.20, 3.4) + vec3(0.0, 2.07, -0.05); show = 1.0; }
        } else {
          if (acc > 1.5 && acc < 2.5) { p = p * vec3(1.05, 1.3, 0.62) + vec3(0.0, 1.18, 0.20); show = 1.0; }
          else if (acc > 2.5) { p = p * vec3(0.13, 4.3, 0.13) + vec3(0.17, 1.48, -0.03); show = 1.0; }
        }
        p *= show;
      }

      if (part > 5.5 && part < 7.5) {          // shins: knee, then hip
        p = kneeP + rotX(p - kneeP, knee);
        n = rotX(n, knee);
        p = hip + rotX(p - hip, thigh);
        n = rotX(n, thigh);
      } else if (part > 3.5) {                 // thighs
        p = hip + rotX(p - hip, thigh);
        n = rotX(n, thigh);
      } else if (part > 1.5) {                 // arms hang off the torso
        p = shoulder + rotX(p - shoulder, arm);
        n = rotX(n, arm);
        p = waist + rotX(p - waist, torso);
        n = rotX(n, torso);
      } else if (part < 0.5 || (part > 7.5 && part < 8.5)) {
        p = neck + rotX(p - neck, head);       // head and what is on it
        n = rotX(n, head);
        p = waist + rotX(p - waist, torso);
        n = rotX(n, torso);
      } else {                                 // torso and what is on its back
        p = waist + rotX(p - waist, torso);
        n = rotX(n, torso);
      }

      p.y -= sit * 0.43;
      p.z -= lean * 0.12;
      p.y += gait * 0.026 * cos(aAnim.x * TAU * 2.0);

      vUp = p.y;
      p.x *= aBody.y;
      p.z *= aBody.y;
      p.y *= aBody.x;

      float sy = sin(aYaw), cy = cos(aYaw);
      vec3 w = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
      vec3 wn = vec3(n.x * cy + n.z * sy, n.y, -n.x * sy + n.z * cy);
      vec3 world = aPos + w;

      vec3 col = aTop;
      if (part < 0.5) col = aSkin;
      else if (part > 3.5 && part < 7.5) col = aBot;
      else if (part > 7.5) col = vec3(aTop.b, aTop.r, aTop.g) * 0.92;

      vCol = col;
      vNrm = wn;
      vView = cameraPosition - world;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
    }
  `;

  const BODY_FRAG = /* glsl */ `
    precision mediump float;
    uniform vec3 uSun;
    uniform vec3 uSunCol;
    uniform vec3 uSkyCol;
    uniform vec3 uRimCol;

    varying vec3 vCol;
    varying vec3 vNrm;
    varying vec3 vView;
    varying float vUp;

    void main() {
      vec3 N = normalize(vNrm);
      vec3 V = normalize(vView);
      float ndl = max(dot(N, uSun), 0.0);
      float sky = 0.55 + 0.45 * N.y;
      float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
      /* Shoes, and the fact that the ground steals light. Both of these are
         free here and both of them are most of why a box body reads as a
         person from thirty metres. */
      vec3 col = vCol * (vUp < 0.11 ? 0.34 : 1.0);
      col *= 0.66 + 0.34 * clamp(vUp * 0.66, 0.0, 1.0);
      vec3 lit = col * (uSunCol * ndl + uSkyCol * sky) + uRimCol * rim * 0.22;
      gl_FragColor = vec4(lit, 1.0);
    }
  `;

  const CARD_VERT = /* glsl */ `
    #define TAU 6.2831853
    attribute float aPart;
    attribute vec3 aPos;
    attribute vec3 aAnim;
    attribute vec3 aPose;
    attribute vec3 aBody;
    attribute vec3 aTop;
    attribute vec3 aBot;
    attribute vec3 aSkin;
    varying vec3 vCol;

    void main() {
      vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
      float h = 1.78 * aBody.x * (1.0 - aPose.x * 0.30);
      float w = 1.15 * aBody.y;
      float swing = aAnim.y * 0.10 * sin(aAnim.x * TAU);
      mv.x += position.x * w + swing * position.y;
      mv.y += position.y * h;
      gl_Position = projectionMatrix * mv;
      vCol = aPart < 0.5 ? aSkin : (aPart > 3.5 ? aBot : aTop);
    }
  `;

  const CARD_FRAG = /* glsl */ `
    precision mediump float;
    uniform vec3 uSunCol;
    uniform vec3 uSkyCol;
    varying vec3 vCol;
    void main() {
      gl_FragColor = vec4(vCol * (uSunCol * 0.42 + uSkyCol * 0.9), 1.0);
    }
  `;

  const uniforms = {
    uTime: { value: 0 },
    uSun: { value: SUN_DIR.clone() },
    uSunCol: { value: new THREE.Color(1.42, 1.06, 0.80) },
    uSkyCol: { value: new THREE.Color(0.30, 0.28, 0.40) },
    uRimCol: { value: new THREE.Color(0.42, 0.58, 0.85) },
  };

  const bodyMat = new THREE.ShaderMaterial({
    name: "EmpyreanCrowd",
    uniforms,
    vertexShader: BODY_VERT,
    fragmentShader: BODY_FRAG,
    fog: false,
  });
  const cardMat = new THREE.ShaderMaterial({
    name: "EmpyreanCrowdCard",
    uniforms,
    vertexShader: CARD_VERT,
    fragmentShader: CARD_FRAG,
    fog: false,
    side: THREE.DoubleSide,
  });

  /* -----------------------------------------------------------------------
   * Instance buffers
   * -------------------------------------------------------------------- */

  interface Tier {
    geo: THREE.InstancedBufferGeometry;
    mesh: THREE.Mesh;
    pos: Float32Array;
    yaw: Float32Array;
    anim: Float32Array;
    pose: Float32Array;
    body: Float32Array;
    top: Float32Array;
    bot: Float32Array;
    skin: Float32Array;
    attrs: THREE.InstancedBufferAttribute[];
    n: number;
  }

  const makeTier = (
    src: { position: Float32Array; normal: Float32Array; part: Float32Array; index: Uint16Array },
    mat: THREE.ShaderMaterial,
    cap: number,
  ): Tier => {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(src.position, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(src.normal, 3));
    geo.setAttribute("aPart", new THREE.BufferAttribute(src.part, 1));
    geo.setIndex(new THREE.BufferAttribute(src.index, 1));

    const pos = new Float32Array(cap * 3);
    const yaw = new Float32Array(cap);
    const anim = new Float32Array(cap * 3);
    const pose = new Float32Array(cap * 3);
    const body = new Float32Array(cap * 3);
    const top = new Float32Array(cap * 3);
    const bot = new Float32Array(cap * 3);
    const skin = new Float32Array(cap * 3);
    const attrs: THREE.InstancedBufferAttribute[] = [];
    const bind = (name: string, arr: Float32Array, size: number) => {
      const attr = new THREE.InstancedBufferAttribute(arr, size);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, attr);
      attrs.push(attr);
    };
    bind("aPos", pos, 3);
    bind("aYaw", yaw, 1);
    bind("aAnim", anim, 3);
    bind("aPose", pose, 3);
    bind("aBody", body, 3);
    bind("aTop", top, 3);
    bind("aBot", bot, 3);
    bind("aSkin", skin, 3);

    geo.instanceCount = 0;
    // The whole crowd lives inside a 700 m disc and is culled by distance in
    // `update`; a bounding sphere would only be a second, worse, test.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, ISLAND_Y, 0), PLATEAU_R * 1.6);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    group.add(mesh);
    return { geo, mesh, pos, yaw, anim, pose, body, top, bot, skin, attrs, n: 0 };
  };

  const tiers: Tier[] = [
    makeTier(boxBody(FULL_BODY), bodyMat, MAX),
    makeTier(boxBody(MID_BODY), bodyMat, MAX),
    makeTier(billboardBody(), cardMat, MAX),
  ];

  const writeInstance = (tier: Tier, i: number) => {
    const s = tier.n++;
    tier.pos[s * 3] = ax[i];
    tier.pos[s * 3 + 1] = ay[i];
    tier.pos[s * 3 + 2] = az[i];
    tier.yaw[s] = ayaw[i];
    tier.anim[s * 3] = aphase[i];
    tier.anim[s * 3 + 1] = agait[i];
    tier.anim[s * 3 + 2] = agesture[i];
    tier.pose[s * 3] = aSit[i];
    tier.pose[s * 3 + 1] = aLean[i];
    tier.pose[s * 3 + 2] = aLook[i];
    tier.body[s * 3] = aHeight[i];
    tier.body[s * 3 + 1] = aBuild[i];
    tier.body[s * 3 + 2] = aAcc[i];
    tier.top[s * 3] = aTopC[i * 3];
    tier.top[s * 3 + 1] = aTopC[i * 3 + 1];
    tier.top[s * 3 + 2] = aTopC[i * 3 + 2];
    tier.bot[s * 3] = aBotC[i * 3];
    tier.bot[s * 3 + 1] = aBotC[i * 3 + 1];
    tier.bot[s * 3 + 2] = aBotC[i * 3 + 2];
    tier.skin[s * 3] = aSkinC[i * 3];
    tier.skin[s * 3 + 1] = aSkinC[i * 3 + 1];
    tier.skin[s * 3 + 2] = aSkinC[i * 3 + 2];
  };

  /* -----------------------------------------------------------------------
   * The crowd's own spatial index — separation, and `nearest`
   * -------------------------------------------------------------------- */

  const bodyCell = new Int32Array(GRID_N * GRID_N).fill(-1);
  const bodyNext = new Int32Array(MAX).fill(-1);

  /* -----------------------------------------------------------------------
   * Decisions
   * -------------------------------------------------------------------- */

  let daylight = 1;

  const pickDestination = (i: number) => {
    // Eight candidates, best score wins: district pull for the hour, a taste
    // for the kind of place, and a strong preference for somewhere you could
    // plausibly walk to before the sun finishes going down.
    let best = -1;
    let bestScore = -Infinity;
    for (let k = 0; k < 8; k++) {
      const c = Math.floor(rng.next() * dests.n);
      const node = dests.node[c];
      const pull = DISTRICT_PULL[DISTRICT_IDS[graph.district[node]] ?? "core"];
      const kind = dests.kind[c];
      let score = (pull?.base ?? 1) + (pull?.dusk ?? 0) * (1 - daylight);
      if (kind === D_RIM) score *= 0.55 + daylight * 0.9;
      if (kind === D_SIT) score *= 0.7 + daylight * 0.6;
      if (kind === D_DOOR) score *= 1.25;
      if (kind === D_TRAM) score *= 0.45;
      const d = Math.hypot(graph.x[node] - ax[i], graph.z[node] - az[i]);
      score *= 1 / (1 + d / 130);
      score *= 0.7 + rng.next() * 0.6;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best < 0) return;
    aDestNode[i] = dests.node[best];
    aDestKind[i] = dests.kind[best];
    aFaceX[i] = dests.faceX[best];
    aFaceZ[i] = dests.faceZ[best];
    requestPath(i);
    const mate = aPartner[i];
    // Whoever you came with is coming too.
    if (mate >= 0 && aActive[mate] && mate > i) {
      aDestNode[mate] = aDestNode[i];
      aDestKind[mate] = aDestKind[i];
      aFaceX[mate] = aFaceX[i];
      aFaceZ[mate] = aFaceZ[i];
      aTimer[mate] = 999;
      requestPath(mate);
    }
  };

  /** Fit the current segment: the offset that keeps a body on its pavement. */
  const enterSegment = (i: number, from: number, to: number) => {
    segAx[i] = graph.x[from];
    segAz[i] = graph.z[from];
    segAy[i] = graph.y[from];
    const bx = graph.x[to];
    const bz = graph.z[to];
    const dx = bx - segAx[i];
    const dz = bz - segAz[i];
    const len = Math.hypot(dx, dz) || 1;
    // Right-hand side of the direction of travel, so opposing streams pass
    // each other the way people do rather than walking through each other.
    const rx = dz / len;
    const rz = -dx / len;
    const room = Math.min(graph.width[from], graph.width[to]) * 0.5 - 0.55;
    let lat = Math.max(0, room) * (0.35 + (i % 5) * 0.13);
    // Probe: three points along the offset line. If any of them is not
    // pavement, halve the offset and try again, down to the centreline —
    // which is a node-to-node line and known good.
    for (let attempt = 0; attempt < 3 && lat > 0.05; attempt++) {
      let good = true;
      for (let s = 0; s <= 2; s++) {
        const t = s / 2;
        const kind = surfaceAt(
          segAx[i] + dx * t + rx * lat,
          segAz[i] + dz * t + rz * lat,
        ).kind;
        if (kind === "lot" || kind === "void" || kind === "parapet") {
          good = false;
          break;
        }
      }
      if (good) break;
      lat *= 0.45;
    }
    if (lat <= 0.05) lat = 0;
    segTx[i] = bx + rx * lat;
    segTz[i] = bz + rz * lat;
    segTy[i] = graph.y[to];
    segAx[i] += rx * lat;
    segAz[i] += rz * lat;
  };

  const arrive = (i: number) => {
    const kind = aDestKind[i];
    aphase[i] = aphase[i] % 1;
    switch (kind) {
      case D_RIM:
        aState[i] = ST_LEAN;
        aTimer[i] = rng.range(18, 52);
        break;
      case D_SIT:
        aState[i] = ST_SIT;
        aTimer[i] = rng.range(24, 75);
        break;
      case D_LANDMARK:
        aState[i] = ST_STAND;
        aTimer[i] = rng.range(8, 22);
        aLookT[i] = rng.range(1.5, 4);
        break;
      case D_TRAM:
        aState[i] = ST_STAND;
        aTimer[i] = rng.range(12, 40);
        break;
      case D_DOOR:
        aState[i] = ST_STAND;
        aTimer[i] = rng.range(6, 17);
        break;
      default:
        aState[i] = ST_STAND;
        aTimer[i] = rng.range(5, 16);
        break;
    }
    const mate = aPartner[i];
    // Whoever leads a pair holds the clock for both of them; the other one
    // waits until they are re-targeted, however long that is.
    if (mate >= 0) aTimer[i] = mate < i ? 1e9 : rng.range(24, 62);
  };

  const runPath = (i: number) => {
    const goal = aDestNode[i];
    if (goal < 0) {
      aState[i] = ST_WAIT;
      aTimer[i] = 0.5;
      return;
    }
    const from = nearestNode(ax[i], az[i], 26);
    if (from < 0) {
      // Off the graph entirely — put them back on it and try again next time.
      const any = Math.floor(rng.next() * graph.n);
      ax[i] = graph.x[any];
      az[i] = graph.z[any];
      ay[i] = graph.y[any];
      aState[i] = ST_WAIT;
      aTimer[i] = 0.2;
      return;
    }
    if (from === goal) {
      pathLen[i] = 0;
      pathIdx[i] = 0;
      arrive(i);
      return;
    }

    generation++;
    const gen = generation;
    const gx = graph.x[goal];
    const gz = graph.z[goal];
    let heap = 0;
    stamp[from] = gen;
    closed[from] = 0;
    gScore[from] = 0;
    cameFrom[from] = -1;
    fScore[from] = Math.hypot(gx - graph.x[from], gz - graph.z[from]);
    heap = heapPush(heap, from, fScore[from]);

    let found = false;
    let guard = 0;
    while (heap > 0 && guard++ < 24000) {
      const cur = heapId[0];
      heap = heapPop(heap);
      if (stamp[cur] !== gen || closed[cur]) continue;
      closed[cur] = 1;
      if (cur === goal) {
        found = true;
        break;
      }
      const cx = graph.x[cur];
      const cz = graph.z[cur];
      const g = gScore[cur];
      for (let e = graph.start[cur]; e < graph.start[cur + 1]; e++) {
        const nb = graph.list[e];
        if (nb === cur) continue;
        const step = Math.hypot(graph.x[nb] - cx, graph.z[nb] - cz);
        const tentative = g + step;
        if (stamp[nb] === gen && (closed[nb] || gScore[nb] <= tentative)) continue;
        stamp[nb] = gen;
        closed[nb] = 0;
        gScore[nb] = tentative;
        cameFrom[nb] = cur;
        heap = heapPush(heap, nb, tentative + Math.hypot(gx - graph.x[nb], gz - graph.z[nb]));
      }
    }

    if (!found) {
      aDestNode[i] = -1;
      aState[i] = ST_WAIT;
      aTimer[i] = 0.4;
      return;
    }

    let count = 0;
    for (let cur = goal; cur >= 0 && count < graph.n; cur = cameFrom[cur]) {
      trace[count++] = cur;
      if (cur === from) break;
    }
    // `trace` runs goal → here; the body walks it the other way, and a trip
    // longer than the slice is walked in stages with the destination kept.
    const take = Math.min(count - 1, MAX_PATH);
    const base = i * MAX_PATH;
    for (let k = 0; k < take; k++) path[base + k] = trace[count - 2 - k];
    pathLen[i] = take;
    pathIdx[i] = 0;
    if (take === 0) {
      arrive(i);
      return;
    }
    aState[i] = ST_WALK;
    enterSegment(i, from, path[base]);
  };

  /* -----------------------------------------------------------------------
   * Frame
   * -------------------------------------------------------------------- */

  let liveCount = 0;
  let clock = 0;

  const update = (ctx: FrameContext) => {
    const dt = ctx.dt;
    clock += dt;
    daylight = ctx.daylight;
    uniforms.uTime.value = ctx.time;
    (uniforms.uSun.value as THREE.Vector3).copy(ctx.sunDir);
    // The whole crowd warms and cools with the sky, which is most of why they
    // sit inside the picture rather than on top of it.
    const warm = 0.35 + daylight * 0.9;
    (uniforms.uSunCol.value as THREE.Color).setRGB(1.42 * warm, 1.02 * warm, 0.74 * warm);
    (uniforms.uSkyCol.value as THREE.Color).setRGB(
      0.12 + daylight * 0.20,
      0.12 + daylight * 0.18,
      0.20 + daylight * 0.22,
    );

    /* ---- how many people are out ---------------------------------------- */
    const qualityCut = ctx.quality === "low" ? 0.4 : 1;
    const target = Math.min(
      MAX,
      Math.round(MAX * qualityCut * (0.74 + 0.26 * daylight)),
    );

    const cam = ctx.camera.position;
    const px = ctx.player.position;
    const overhead = ctx.player.altitude > 7 && ctx.player.altitude < 140;

    /* ---- rebuild the body index ----------------------------------------- */
    bodyCell.fill(-1);
    for (let i = 0; i < MAX; i++) {
      if (!aActive[i]) continue;
      const cx = Math.min(GRID_N - 1, Math.max(0, ((ax[i] - GRID_ORIGIN) / CELL) | 0));
      const cz = Math.min(GRID_N - 1, Math.max(0, ((az[i] - GRID_ORIGIN) / CELL) | 0));
      const c = cz * GRID_N + cx;
      bodyNext[i] = bodyCell[c];
      bodyCell[c] = i;
    }

    for (const tier of tiers) tier.n = 0;
    // Decisions this frame read *last* frame's headcount, so an early-indexed
    // body is not comparing a target against a total that is still being
    // counted.
    const crowded = liveCount;
    let live = 0;

    /* ---- everybody ------------------------------------------------------ */
    for (let i = 0; i < MAX; i++) {
      if (!aActive[i]) {
        // Inside somewhere. Come back out when the street wants more people.
        if (crowded < target && rng.chance(dt * 0.12)) {
          aActive[i] = 1;
          aState[i] = ST_WAIT;
          aTimer[i] = 0;
        }
        continue;
      }
      live++;

      const state = aState[i];
      aTimer[i] -= dt;

      /* -- the player ---------------------------------------------------- */
      const pdx = ax[i] - px.x;
      const pdz = az[i] - px.z;
      const pd2 = pdx * pdx + pdz * pdz;
      if (overhead && pd2 < 26 * 26) {
        aLookT[i] = Math.max(aLookT[i], 0.9);
      }
      let shoveX = 0;
      let shoveZ = 0;
      if (pd2 < 30 && Math.abs(px.y - ay[i]) < 14) {
        // Somebody is landing on you. Get out of the way, and watch them.
        const d = Math.sqrt(pd2) || 0.001;
        const push = (5.5 - d) / 5.5;
        shoveX += (pdx / d) * push * 5.5;
        shoveZ += (pdz / d) * push * 5.5;
        if (ctx.player.burn > 0.12 || !ctx.player.grounded) aLookT[i] = Math.max(aLookT[i], 1.4);
      }

      /* -- separation ---------------------------------------------------- */
      const cx = Math.min(GRID_N - 1, Math.max(0, ((ax[i] - GRID_ORIGIN) / CELL) | 0));
      const cz = Math.min(GRID_N - 1, Math.max(0, ((az[i] - GRID_ORIGIN) / CELL) | 0));
      let looked = 0;
      for (let oz = -1; oz <= 1; oz++) {
        const rz = cz + oz;
        if (rz < 0 || rz >= GRID_N) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const rx = cx + ox;
          if (rx < 0 || rx >= GRID_N) continue;
          for (let j = bodyCell[rz * GRID_N + rx]; j >= 0 && looked < 10; j = bodyNext[j]) {
            if (j === i) continue;
            looked++;
            const dx = ax[i] - ax[j];
            const dz = az[i] - az[j];
            const q = dx * dx + dz * dz;
            if (q > 1.5 * 1.5 || q < 1e-6) continue;
            const d = Math.sqrt(q);
            const push = (1.5 - d) / 1.5;
            shoveX += (dx / d) * push * 1.4;
            shoveZ += (dz / d) * push * 1.4;
          }
        }
      }

      /* -- states -------------------------------------------------------- */
      if (state === ST_WALK) {
        const base = i * MAX_PATH;
        const tx = segTx[i];
        const tz = segTz[i];
        const dx = tx - ax[i];
        const dz = tz - az[i];
        const d = Math.hypot(dx, dz);
        if (d < 1.05) {
          pathIdx[i]++;
          if (pathIdx[i] >= pathLen[i]) {
            const goal = aDestNode[i];
            const at = pathLen[i] > 0 ? path[base + pathLen[i] - 1] : -1;
            if (goal >= 0 && at >= 0 && at !== goal) {
              requestPath(i); // a long trip, walked in stages
              aState[i] = ST_WAIT;
              aTimer[i] = 0.1;
            } else {
              arrive(i);
            }
          } else {
            enterSegment(i, path[base + pathIdx[i] - 1], path[base + pathIdx[i]]);
          }
        } else {
          const speed = aspeed[i];
          const wantX = (dx / d) * speed + shoveX;
          const wantZ = (dz / d) * speed + shoveZ;
          const k = Math.min(1, dt * 5.5);
          avx[i] += (wantX - avx[i]) * k;
          avz[i] += (wantZ - avz[i]) * k;
          ax[i] += avx[i] * dt;
          az[i] += avz[i] * dt;
          const moved = Math.hypot(avx[i], avz[i]);
          agait[i] += (Math.min(1.25, moved / 1.4) - agait[i]) * Math.min(1, dt * 6);
          aphase[i] += (moved * dt) / (1.35 * aHeight[i]);
          if (aphase[i] > 1) aphase[i] -= Math.floor(aphase[i]);
          if (moved > 0.05) {
            const want = Math.atan2(-avx[i], -avz[i]);
            let diff = want - ayaw[i];
            while (diff > Math.PI) diff -= TAU;
            while (diff < -Math.PI) diff += TAU;
            ayaw[i] += diff * Math.min(1, dt * 6);
          }
          // Height follows the segment, so a kerb at a crossing is a step and
          // not a hover.
          const prog = 1 - Math.min(1, d / (Math.hypot(segTx[i] - segAx[i], segTz[i] - segAz[i]) || 1));
          const wantY = segAy[i] + (segTy[i] - segAy[i]) * prog;
          ay[i] += (wantY - ay[i]) * Math.min(1, dt * 7);
        }
      } else {
        // Standing, sitting, leaning, or waiting for a path.
        // Anchored to the spot they arrived on, which is a point `surfaceAt`
        // has already agreed is pavement. Without the spring a knot of people
        // outside a busy door shoves itself into a flowerbed over a minute.
        const homeX = segTx[i] - ax[i];
        const homeZ = segTz[i] - az[i];
        ax[i] += (shoveX * 0.6 + homeX * 0.9) * dt;
        az[i] += (shoveZ * 0.6 + homeZ * 0.9) * dt;
        agait[i] += (0 - agait[i]) * Math.min(1, dt * 5);
        avx[i] *= 1 - Math.min(1, dt * 6);
        avz[i] *= 1 - Math.min(1, dt * 6);

        let fx = aFaceX[i];
        let fz = aFaceZ[i];
        const mate = aPartner[i];
        if (mate >= 0 && aActive[mate] && aState[mate] !== ST_WALK) {
          const mx = ax[mate] - ax[i];
          const mz = az[mate] - az[i];
          const md = Math.hypot(mx, mz);
          if (md > 0.4 && md < 4.5) {
            fx = mx / md;
            fz = mz / md;
            agesture[i] = 0.55 + 0.45 * Math.sin(clock * 0.6 + i);
          }
        } else {
          agesture[i] += (0 - agesture[i]) * Math.min(1, dt * 3);
        }
        if (fx !== 0 || fz !== 0) {
          const want = Math.atan2(-fx, -fz);
          let diff = want - ayaw[i];
          while (diff > Math.PI) diff -= TAU;
          while (diff < -Math.PI) diff += TAU;
          ayaw[i] += diff * Math.min(1, dt * 2.5);
        }

        if (aTimer[i] <= 0) {
          if (state === ST_WAIT) {
            if (aDestNode[i] < 0) pickDestination(i);
            else requestPath(i);
            aTimer[i] = 1.5;
          } else {
            // Done here. Some of them step inside instead of walking on.
            const mateLed = aPartner[i] >= 0 && aPartner[i] < i;
            if (
              !mateLed &&
              aDestKind[i] === D_DOOR &&
              crowded > target &&
              rng.chance(0.5)
            ) {
              aActive[i] = 0;
              aDestNode[i] = -1;
              continue;
            }
            if (!mateLed) pickDestination(i);
            aState[i] = ST_WAIT;
            aTimer[i] = 1.2;
          }
        }
      }

      /* -- pose blending ------------------------------------------------- */
      const wantSit = aState[i] === ST_SIT ? 1 : 0;
      const wantLean = aState[i] === ST_LEAN ? 1 : 0;
      if (aLookT[i] > 0) aLookT[i] -= dt;
      const wantLook = aLookT[i] > 0 ? 1 : 0;
      const blend = Math.min(1, dt * 3.2);
      aSit[i] += (wantSit - aSit[i]) * blend;
      aLean[i] += (wantLean - aLean[i]) * blend;
      aLook[i] += (wantLook - aLook[i]) * blend;

      /* -- draw ---------------------------------------------------------- */
      const camdx = ax[i] - cam.x;
      const camdy = ay[i] - cam.y;
      const camdz = az[i] - cam.z;
      const camd2 = camdx * camdx + camdy * camdy + camdz * camdz;
      if (camd2 > LOD_FAR * LOD_FAR) continue;
      if (camd2 < LOD_NEAR * LOD_NEAR) writeInstance(tiers[0], i);
      else if (camd2 < LOD_MID * LOD_MID) writeInstance(tiers[1], i);
      else writeInstance(tiers[2], i);
    }

    liveCount = live;

    /* ---- a few paths, and only a few ------------------------------------ */
    for (let k = 0; k < REPATH_BUDGET && repathCount > 0; k++) {
      const i = repathQueue[repathHead];
      repathHead = (repathHead + 1) % MAX;
      repathCount--;
      aQueued[i] = 0;
      if (!aActive[i]) continue;
      runPath(i);
    }

    /* ---- upload ---------------------------------------------------------- */
    for (const tier of tiers) {
      tier.geo.instanceCount = tier.n;
      if (tier.n === 0) continue;
      for (const attr of tier.attrs) attr.needsUpdate = true;
    }
  };

  return {
    name: "crowd",
    group,
    get count() {
      return liveCount;
    },
    nearest(x: number, z: number, maxDist: number) {
      let best = -1;
      let bestD = maxDist * maxDist;
      const rings = Math.max(1, Math.ceil(maxDist / CELL));
      const cx = Math.floor((x - GRID_ORIGIN) / CELL);
      const cz = Math.floor((z - GRID_ORIGIN) / CELL);
      for (let dz = -rings; dz <= rings; dz++) {
        const rz = cz + dz;
        if (rz < 0 || rz >= GRID_N) continue;
        for (let dx = -rings; dx <= rings; dx++) {
          const rx = cx + dx;
          if (rx < 0 || rx >= GRID_N) continue;
          for (let i = bodyCell[rz * GRID_N + rx]; i >= 0; i = bodyNext[i]) {
            const q = (ax[i] - x) ** 2 + (az[i] - z) ** 2;
            if (q < bestD) {
              bestD = q;
              best = i;
            }
          }
        }
      }
      if (best < 0) return null;
      return { x: ax[best], y: ay[best], z: az[best], id: best };
    },
    update,
    dispose() {
      for (const tier of tiers) {
        tier.geo.dispose();
        group.remove(tier.mesh);
      }
      bodyMat.dispose();
      cardMat.dispose();
    },
  };
}
