/**
 * ai/navigation.ts — how anything in San Francisco gets from A to B.
 *
 * There are three layers here and they exist for three different reasons.
 *
 *   1. THE GRAPH. `roadNetwork` already publishes a streamed, queryable street
 *      graph — nodes at junctions, edges with lanes, grades and names. Building
 *      a second navmesh on top of it would be two authorities on where the
 *      road is, and two authorities is how you get a bus driving through a
 *      Victorian. So the navgraph *is* the road graph; this module only adds
 *      the search structures and the sidewalk projection.
 *
 *   2. THE SEARCH. A city with ~30 000 junctions cannot be flood-filled per
 *      request. Two-level hierarchical A*: a coarse pass over 512 m clusters
 *      produces a corridor, then the fine pass is confined to that corridor.
 *      A cross-town route drops from ~20 000 expansions to under 900. Results
 *      are cached by (startNode, goalNode) with an LRU, because forty
 *      pedestrians on the same block routinely want the same three routes.
 *
 *   3. THE STEERING. A path is a suggestion. What stops two hundred people
 *      walking through each other is local avoidance, here a candidate-sampling
 *      RVO: each agent proposes a handful of velocities around its preferred
 *      one, scores them against the time-to-collision with the six nearest
 *      neighbours, and takes the cheapest. Reciprocity (each agent assumes the
 *      other will take half the evasive action) is what stops the classic
 *      shuffle-lock in a doorway.
 *
 * Off the graph — a rooftop, a park, the middle of Golden Gate Park — nothing
 * above applies, so there is a fourth, deliberately dumb path: steer straight
 * at the goal, probe the ground with `walkableHeight`, and short-raycast ahead
 * to slide along whatever you bump into. Soldiers use it constantly; it is not
 * a fallback so much as the outdoor case.
 *
 * Public API
 * ----------
 *   navGraph.ensure(x, z, radius)          stream the street graph in
 *   navGraph.nearestNode(x, z)             snap to the graph
 *   findPath(sx, sz, gx, gz, path, opts)   hierarchical A*, cached
 *   NavPath / makeNavPath / advancePath
 *   sidewalkPoint / laneOffsetFor / crossingPoint
 *   avoidance                              the RVO field singleton
 *   groundHeight / probeAhead              off-graph movement helpers
 */
import { SIDEWALK_WIDTH, roadNetwork, roadSurface, type Lane, type RoadEdge, type RoadNode } from "../world/street/roadNetwork";
import { walkableHeight } from "../geo/sfGeo";
import { makeRayHit, raycast } from "../physics/raycast";
import { isPhysicsReady } from "../physics/world";

/* ================================================================== *
 * Graph coverage
 * ================================================================== */

/**
 * Pack a signed cell index pair into one number. Multiplication rather than
 * shifts on purpose: `(i + 32768) << 16` overflows int32 for half the world and
 * silently produces negative keys that no longer round-trip, which is a
 * genuinely miserable bug to find inside a pathfinder.
 */
function packCell(i: number, j: number): number {
  return (i + 32768) * 65536 + (j + 32768);
}
function unpackI(key: number): number {
  return Math.floor(key / 65536) - 32768;
}
function unpackJ(key: number): number {
  return (key % 65536) - 32768;
}

/**
 * The street graph builds itself in 384 m tiles on demand. Everything that
 * wants to path must first guarantee the tiles exist, and doing that per agent
 * per frame would thrash — so coverage requests are coalesced into a coarse
 * grid of already-requested cells.
 */
class NavGraph {
  private covered = new Set<number>();
  /** Cell size for the coverage bookkeeping, metres. */
  private static readonly COVER = 512;

  /** Nodes and edges consumed into the cluster graph so far. */
  private clusterNodeCursor = 0;
  private clusterEdgeCursor = 0;
  /** clusterKey → node ids in that cluster. */
  private clusters = new Map<number, number[]>();
  /** clusterKey → adjacent cluster keys. */
  private clusterLinks = new Map<number, number[]>();

  /** Cluster size, metres. 512 m ≈ four SF blocks — big enough that the coarse
   *  graph is tiny, small enough that the corridor is genuinely narrow. */
  static readonly CLUSTER = 512;

  /** Make sure the street graph exists within `radius` of (x, z). */
  ensure(x: number, z: number, radius: number): void {
    const c = NavGraph.COVER;
    const i0 = Math.floor((x - radius) / c);
    const i1 = Math.floor((x + radius) / c);
    const j0 = Math.floor((z - radius) / c);
    const j1 = Math.floor((z + radius) / c);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const key = packCell(i, j);
        if (this.covered.has(key)) continue;
        this.covered.add(key);
        roadNetwork.ensureRect(i * c, j * c, (i + 1) * c, (j + 1) * c);
      }
    }
  }

  /** Cluster key for a world position. */
  clusterKey(x: number, z: number): number {
    return packCell(Math.floor(x / NavGraph.CLUSTER), Math.floor(z / NavGraph.CLUSTER));
  }

  clusterOfNode(id: number): number {
    const n = roadNetwork.nodes[id];
    return this.clusterKey(n.x, n.z);
  }

  /**
   * Fold any newly streamed nodes/edges into the coarse cluster graph.
   * Incremental because the street graph only ever grows between `clear()`s;
   * a full rebuild every time a tile streamed in would be the single most
   * expensive thing in the frame.
   */
  syncClusters(): void {
    const nodes = roadNetwork.nodes;
    const edges = roadNetwork.edges;
    if (nodes.length < this.clusterNodeCursor || edges.length < this.clusterEdgeCursor) {
      // The network was cleared out from under us. Start over.
      this.clusters.clear();
      this.clusterLinks.clear();
      this.covered.clear();
      this.clusterNodeCursor = 0;
      this.clusterEdgeCursor = 0;
    }
    for (let i = this.clusterNodeCursor; i < nodes.length; i++) {
      const k = this.clusterKey(nodes[i].x, nodes[i].z);
      let list = this.clusters.get(k);
      if (!list) {
        list = [];
        this.clusters.set(k, list);
      }
      list.push(i);
    }
    this.clusterNodeCursor = nodes.length;

    for (let i = this.clusterEdgeCursor; i < edges.length; i++) {
      const e = edges[i];
      const ka = this.clusterOfNode(e.a);
      const kb = this.clusterOfNode(e.b);
      if (ka === kb) continue;
      this.link(ka, kb);
      this.link(kb, ka);
    }
    this.clusterEdgeCursor = edges.length;
  }

  private link(a: number, b: number): void {
    let l = this.clusterLinks.get(a);
    if (!l) {
      l = [];
      this.clusterLinks.set(a, l);
    }
    if (!l.includes(b)) l.push(b);
  }

  neighboursOfCluster(k: number): number[] | undefined {
    return this.clusterLinks.get(k);
  }

  hasCluster(k: number): boolean {
    return this.clusters.has(k);
  }

  /** World centre of a cluster, for the coarse heuristic. */
  clusterCentre(k: number, out: { x: number; z: number }): void {
    out.x = (unpackI(k) + 0.5) * NavGraph.CLUSTER;
    out.z = (unpackJ(k) + 0.5) * NavGraph.CLUSTER;
  }

  /**
   * Nearest graph node to a world point, or −1. Uses the road network's own
   * spatial hash via `nearestEdge` and then picks the closer endpoint, which is
   * both cheaper and more useful than a raw node search: it guarantees the
   * result is attached to a real street rather than a stub across a park.
   */
  nearestNode(x: number, z: number, maxDist = 140): number {
    this.ensure(x, z, Math.max(120, maxDist));
    const hit = roadNetwork.nearestEdge(x, z, maxDist);
    if (!hit) return -1;
    const e = hit.edge;
    const a = roadNetwork.nodes[e.a];
    const b = roadNetwork.nodes[e.b];
    const da = (a.x - x) * (a.x - x) + (a.z - z) * (a.z - z);
    const db = (b.x - x) * (b.x - x) + (b.z - z) * (b.z - z);
    return da <= db ? e.a : e.b;
  }

  /** Nearest edge with its parameter, or null. Thin passthrough. */
  nearestEdge(x: number, z: number, maxDist = 90) {
    this.ensure(x, z, Math.max(90, maxDist));
    return roadNetwork.nearestEdge(x, z, maxDist);
  }

  stats() {
    return {
      nodes: roadNetwork.nodes.length,
      edges: roadNetwork.edges.length,
      clusters: this.clusters.size,
      covered: this.covered.size,
    };
  }

  reset(): void {
    this.covered.clear();
    this.clusters.clear();
    this.clusterLinks.clear();
    this.clusterNodeCursor = 0;
    this.clusterEdgeCursor = 0;
  }
}

export const navGraph = new NavGraph();

/* ================================================================== *
 * Paths
 * ================================================================== */

/** How a route is costed. Buses hate alleys; pedestrians love them. */
export interface PathOptions {
  /** Multiplier per road class. Missing entries default to 1. */
  classCost?: Partial<Record<RoadEdge["cls"], number>>;
  /** Refuse to route down alleys (buses, cable cars). */
  noAlleys?: boolean;
  /** Refuse edges longer than this (keeps peds off bridges). */
  maxEdgeLength?: number;
  /** Hard cap on fine-graph expansions. Exceeding it returns the best partial. */
  budget?: number;
  /** Skip the cluster corridor (used when the coarse search fails). */
  unrestricted?: boolean;
  /** Bias toward straight-line routes; >1 makes A* greedier and faster. */
  heuristicWeight?: number;
}

export interface NavPath {
  /** Node ids from start to goal inclusive. */
  nodes: Int32Array;
  /** Edge ids joining them; `edges[i]` joins `nodes[i]` → `nodes[i+1]`. */
  edges: Int32Array;
  count: number;
  /** Index of the next node to reach. */
  cursor: number;
  /** True when the search actually reached the goal (vs. best-effort). */
  complete: boolean;
  /** Sim time this path was produced — consumers repath on staleness. */
  stamp: number;
  goalX: number;
  goalZ: number;
}

export function makeNavPath(capacity = 96): NavPath {
  return {
    nodes: new Int32Array(capacity),
    edges: new Int32Array(capacity),
    count: 0,
    cursor: 0,
    complete: false,
    stamp: -1e9,
    goalX: 0,
    goalZ: 0,
  };
}

/** True when the path has no more nodes to consume. */
export function pathFinished(p: NavPath): boolean {
  return p.cursor >= p.count;
}

/** The node id the agent is currently heading toward, or −1. */
export function pathTarget(p: NavPath): number {
  return p.cursor < p.count ? p.nodes[p.cursor] : -1;
}

/** The edge the agent is currently traversing, or −1. */
export function pathEdge(p: NavPath): number {
  return p.cursor > 0 && p.cursor - 1 < p.count ? p.edges[p.cursor - 1] : p.count > 0 ? p.edges[0] : -1;
}

/**
 * Consume the current waypoint if the agent is within `tolerance` of it.
 * Returns true when the path advanced.
 */
export function advancePath(p: NavPath, x: number, z: number, tolerance: number): boolean {
  if (p.cursor >= p.count) return false;
  const n = roadNetwork.nodes[p.nodes[p.cursor]];
  if (!n) {
    p.cursor = p.count;
    return true;
  }
  const dx = n.x - x;
  const dz = n.z - z;
  if (dx * dx + dz * dz <= tolerance * tolerance) {
    p.cursor++;
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * The search structures
 * ------------------------------------------------------------------ *
 * Parallel typed arrays indexed by node id, grown geometrically. A visit
 * stamp instead of a clear() means a search costs O(expanded), not O(|V|) —
 * which matters when you run forty of them a second.
 */

let gScore = new Float32Array(4096);
let fScore = new Float32Array(4096);
let cameFrom = new Int32Array(4096);
let cameEdge = new Int32Array(4096);
let visited = new Int32Array(4096);
let closed = new Uint8Array(4096);
let searchGen = 0;

function ensureCapacity(n: number): void {
  if (n <= gScore.length) return;
  let cap = gScore.length;
  while (cap < n) cap *= 2;
  const g = new Float32Array(cap);
  const f = new Float32Array(cap);
  const c = new Int32Array(cap);
  const ce = new Int32Array(cap);
  const v = new Int32Array(cap);
  const cl = new Uint8Array(cap);
  v.set(visited);
  gScore = g;
  fScore = f;
  cameFrom = c;
  cameEdge = ce;
  visited = v;
  closed = cl;
}

/** Binary min-heap of node ids keyed by fScore. Typed, reused, never realloc'd
 *  inside a search — the open set of a corridor-confined A* stays small. */
class NodeHeap {
  private items = new Int32Array(2048);
  private size = 0;

  clear(): void {
    this.size = 0;
  }

  get length(): number {
    return this.size;
  }

  push(id: number): void {
    if (this.size >= this.items.length) {
      const bigger = new Int32Array(this.items.length * 2);
      bigger.set(this.items);
      this.items = bigger;
    }
    let i = this.size++;
    this.items[i] = id;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (fScore[this.items[parent]] <= fScore[this.items[i]]) break;
      const t = this.items[parent];
      this.items[parent] = this.items[i];
      this.items[i] = t;
      i = parent;
    }
  }

  pop(): number {
    if (this.size === 0) return -1;
    const top = this.items[0];
    this.size--;
    if (this.size > 0) {
      this.items[0] = this.items[this.size];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.size && fScore[this.items[l]] < fScore[this.items[m]]) m = l;
        if (r < this.size && fScore[this.items[r]] < fScore[this.items[m]]) m = r;
        if (m === i) break;
        const t = this.items[m];
        this.items[m] = this.items[i];
        this.items[i] = t;
        i = m;
      }
    }
    return top;
  }
}

const heap = new NodeHeap();

/* ------------------------------------------------------------------ *
 * Coarse pass — A* over 512 m clusters
 * ------------------------------------------------------------------ */

const corridor = new Set<number>();
const coarseG = new Map<number, number>();
const coarseFrom = new Map<number, number>();
const coarseOpen: number[] = [];
const _cc = { x: 0, z: 0 };
const _cc2 = { x: 0, z: 0 };

/**
 * Fill `corridor` with the cluster keys a route may pass through, dilated by
 * one ring so the fine search always has room to round a corner. Returns false
 * if the two ends are not connected at the coarse level, in which case the
 * caller runs an unrestricted (budgeted) fine search instead.
 */
function buildCorridor(startCluster: number, goalCluster: number): boolean {
  corridor.clear();
  if (startCluster === goalCluster) {
    dilate(startCluster);
    return true;
  }
  coarseG.clear();
  coarseFrom.clear();
  coarseOpen.length = 0;
  coarseG.set(startCluster, 0);
  coarseOpen.push(startCluster);
  navGraph.clusterCentre(goalCluster, _cc2);

  let guard = 0;
  while (coarseOpen.length > 0 && guard++ < 4000) {
    // Linear scan for the minimum: the coarse open set is tens of entries, and
    // a heap here would cost more in bookkeeping than it saves.
    let bestI = 0;
    let bestF = Infinity;
    for (let i = 0; i < coarseOpen.length; i++) {
      const k = coarseOpen[i];
      navGraph.clusterCentre(k, _cc);
      const h = Math.hypot(_cc.x - _cc2.x, _cc.z - _cc2.z);
      const f = (coarseG.get(k) ?? Infinity) + h;
      if (f < bestF) {
        bestF = f;
        bestI = i;
      }
    }
    const cur = coarseOpen[bestI];
    coarseOpen[bestI] = coarseOpen[coarseOpen.length - 1];
    coarseOpen.pop();

    if (cur === goalCluster) {
      let k = goalCluster;
      let hops = 0;
      while (k !== undefined && hops++ < 512) {
        dilate(k);
        const prev = coarseFrom.get(k);
        if (prev === undefined) break;
        k = prev;
      }
      return true;
    }

    const g = coarseG.get(cur) ?? Infinity;
    const nb = navGraph.neighboursOfCluster(cur);
    if (!nb) continue;
    navGraph.clusterCentre(cur, _cc);
    const cx = _cc.x;
    const cz = _cc.z;
    for (const n of nb) {
      navGraph.clusterCentre(n, _cc);
      const step = Math.hypot(_cc.x - cx, _cc.z - cz);
      const ng = g + step;
      if (ng < (coarseG.get(n) ?? Infinity)) {
        coarseG.set(n, ng);
        coarseFrom.set(n, cur);
        coarseOpen.push(n);
      }
    }
  }
  return false;
}

/** Add a cluster and its eight neighbours to the corridor. */
function dilate(k: number): void {
  const i = unpackI(k);
  const j = unpackJ(k);
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      corridor.add(packCell(i + di, j + dj));
    }
  }
}

/* ------------------------------------------------------------------ *
 * Path cache
 * ------------------------------------------------------------------ */

interface CacheEntry {
  nodes: Int32Array;
  edges: Int32Array;
  count: number;
  complete: boolean;
  used: number;
}

const CACHE_CAP = 320;
const pathCache = new Map<number, CacheEntry>();
let cacheClock = 0;
let cacheHits = 0;
let cacheMisses = 0;

function cacheKey(a: number, b: number, profile: number): number {
  // 15 bits per node id and 2 for the cost profile. Node ids beyond 32767 wrap,
  // which produces an occasional false key — mitigated by storing the endpoints
  // in the entry and validating on read.
  return (((a & 0x7fff) << 17) | ((b & 0x7fff) << 2) | (profile & 3)) >>> 0;
}

function evictIfNeeded(): void {
  if (pathCache.size <= CACHE_CAP) return;
  // Evict the quarter that has gone longest unused. Doing it in one sweep
  // rather than per insert keeps the common path allocation-free.
  const entries: { k: number; used: number }[] = [];
  pathCache.forEach((v, k) => entries.push({ k, used: v.used }));
  entries.sort((p, q) => p.used - q.used);
  const drop = Math.floor(entries.length * 0.25);
  for (let i = 0; i < drop; i++) pathCache.delete(entries[i].k);
}

/** Invalidate every cached route. Call after the street graph changes shape. */
export function clearPathCache(): void {
  pathCache.clear();
}

export function pathCacheStats() {
  return { size: pathCache.size, hits: cacheHits, misses: cacheMisses };
}

/* ------------------------------------------------------------------ *
 * The fine search
 * ------------------------------------------------------------------ */

const DEFAULT_CLASS_COST: Record<RoadEdge["cls"], number> = {
  boulevard: 1,
  arterial: 1,
  street: 1,
  alley: 1,
};

/** Reconstructed node/edge scratch, reused across searches. */
const _nodeStack = new Int32Array(512);
const _edgeStack = new Int32Array(512);

/**
 * Hierarchical A* from the node nearest (sx, sz) to the node nearest (gx, gz),
 * writing into `out`. Returns true if a usable route was produced — including
 * a best-effort partial, because an agent that walks most of the way and then
 * repaths looks far better than one that stands still because the search
 * budget ran out.
 */
export function findPath(
  sx: number,
  sz: number,
  gx: number,
  gz: number,
  out: NavPath,
  opts: PathOptions = {},
  now = 0,
): boolean {
  navGraph.ensure(sx, sz, 260);
  navGraph.ensure(gx, gz, 260);
  navGraph.syncClusters();

  const start = navGraph.nearestNode(sx, sz, 180);
  const goal = navGraph.nearestNode(gx, gz, 220);
  out.cursor = 0;
  out.count = 0;
  out.complete = false;
  out.stamp = now;
  out.goalX = gx;
  out.goalZ = gz;
  if (start < 0 || goal < 0) return false;
  if (start === goal) {
    out.nodes[0] = goal;
    out.count = 1;
    out.complete = true;
    return true;
  }

  const profile = opts.noAlleys ? 1 : 0;
  const key = cacheKey(start, goal, profile);
  const cached = pathCache.get(key);
  if (cached && cached.nodes[0] === start && cached.nodes[cached.count - 1] === goal) {
    cacheHits++;
    cached.used = ++cacheClock;
    copyInto(out, cached.nodes, cached.edges, cached.count, cached.complete);
    return true;
  }
  cacheMisses++;

  const restricted =
    !opts.unrestricted &&
    buildCorridor(navGraph.clusterOfNode(start), navGraph.clusterOfNode(goal));

  const found = searchFine(start, goal, restricted, opts);
  const reached = found >= 0 ? found : bestPartial;
  if (reached < 0) return false;

  // Walk the parent chain back to the start.
  let n = reached;
  let len = 0;
  const cap = out.nodes.length;
  let guard = 0;
  while (n !== start && guard++ < 4096) {
    if (len < _nodeStack.length) {
      _nodeStack[len] = n;
      _edgeStack[len] = cameEdge[n];
      len++;
    }
    const p = cameFrom[n];
    if (p < 0) break;
    n = p;
  }
  if (len === 0) return false;

  const count = Math.min(len, cap);
  for (let i = 0; i < count; i++) {
    // Reverse while copying; the last pushed entry is the first step.
    out.nodes[i] = _nodeStack[len - 1 - i];
    out.edges[i] = _edgeStack[len - 1 - i];
  }
  out.count = count;
  out.complete = found >= 0 && count === len;

  if (out.complete) {
    const entry: CacheEntry = {
      nodes: out.nodes.slice(0, count),
      edges: out.edges.slice(0, count),
      count,
      complete: true,
      used: ++cacheClock,
    };
    // The cached array starts at the first *step*, not at `start`; record the
    // start so a false-key hit can be detected. Prepending start is cheaper
    // than a second lookup structure.
    const withStart = new Int32Array(count + 1);
    withStart[0] = start;
    withStart.set(entry.nodes, 1);
    const edgesWithStart = new Int32Array(count + 1);
    edgesWithStart[0] = -1;
    edgesWithStart.set(entry.edges, 1);
    pathCache.set(key, {
      nodes: withStart,
      edges: edgesWithStart,
      count: count + 1,
      complete: true,
      used: entry.used,
    });
    evictIfNeeded();
  }
  return true;
}

function copyInto(
  out: NavPath,
  nodes: Int32Array,
  edges: Int32Array,
  count: number,
  complete: boolean,
): void {
  // Cached entries include the start node at index 0; agents are already
  // standing on it, so it is skipped.
  const n = Math.min(count - 1, out.nodes.length);
  for (let i = 0; i < n; i++) {
    out.nodes[i] = nodes[i + 1];
    out.edges[i] = edges[i + 1];
  }
  out.count = Math.max(0, n);
  out.complete = complete;
  out.cursor = 0;
}

/** Node reached with the lowest heuristic when a search runs out of budget. */
let bestPartial = -1;
/** Expansions performed by the last fine search — the profiler reads it. */
export let lastSearchExpansions = 0;

function searchFine(start: number, goal: number, restricted: boolean, opts: PathOptions): number {
  const nodes = roadNetwork.nodes;
  const edges = roadNetwork.edges;
  ensureCapacity(nodes.length);
  const gen = ++searchGen;
  const budget = opts.budget ?? 2600;
  const hw = opts.heuristicWeight ?? 1.12;
  const classCost = opts.classCost ?? DEFAULT_CLASS_COST;
  const maxEdge = opts.maxEdgeLength ?? Infinity;

  const gn = nodes[goal];
  heap.clear();
  visited[start] = gen;
  closed[start] = 0;
  gScore[start] = 0;
  cameFrom[start] = -1;
  cameEdge[start] = -1;
  fScore[start] = Math.hypot(nodes[start].x - gn.x, nodes[start].z - gn.z) * hw;
  heap.push(start);

  bestPartial = start;
  let bestH = fScore[start];
  let expansions = 0;

  while (heap.length > 0) {
    const cur = heap.pop();
    if (cur < 0) break;
    if (closed[cur] === gen) continue;
    closed[cur] = gen;
    if (cur === goal) {
      lastSearchExpansions = expansions;
      return goal;
    }
    if (++expansions > budget) break;

    const cn = nodes[cur];
    const g = gScore[cur];
    for (let i = 0; i < cn.edges.length; i++) {
      const eid = cn.edges[i];
      const e = edges[eid];
      if (!e) continue;
      if (opts.noAlleys && e.isAlley) continue;
      if (e.length > maxEdge) continue;
      const other = e.a === cur ? e.b : e.a;
      const on = nodes[other];
      if (!on) continue;
      if (restricted && !corridor.has(navGraph.clusterKey(on.x, on.z))) continue;

      const cost = e.length * (classCost[e.cls] ?? 1);
      const ng = g + cost;
      if (visited[other] === gen && ng >= gScore[other]) continue;
      visited[other] = gen;
      gScore[other] = ng;
      cameFrom[other] = cur;
      cameEdge[other] = eid;
      const h = Math.hypot(on.x - gn.x, on.z - gn.z);
      fScore[other] = ng + h * hw;
      if (h < bestH) {
        bestH = h;
        bestPartial = other;
      }
      heap.push(other);
    }
  }
  lastSearchExpansions = expansions;
  return -1;
}

/* ================================================================== *
 * Projecting the graph onto the surfaces agents actually stand on
 * ================================================================== */

export interface NavPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * A small ring of scratch results.
 *
 * These helpers return a shared object so they can be called in a frame loop
 * without allocating — but a single shared object aliases, and
 * `const a = sidewalkPoint(…); const b = sidewalkPoint(…);` then quietly gives
 * you the same point twice. A four-deep ring makes the common back-to-back
 * cases correct while keeping the allocation count at zero. Callers who hold a
 * result across many calls should still pass their own `out`.
 */
const _npRing: NavPoint[] = [
  { x: 0, y: 0, z: 0 },
  { x: 0, y: 0, z: 0 },
  { x: 0, y: 0, z: 0 },
  { x: 0, y: 0, z: 0 },
];
let _npCursor = 0;
function scratchPoint(): NavPoint {
  _npCursor = (_npCursor + 1) & 3;
  return _npRing[_npCursor];
}

/**
 * A point on the pavement: `s` metres along the edge from node a, on the
 * given side. Lateral offset puts the walker in the middle of the footway
 * rather than in the gutter or against the shopfront.
 */
export function sidewalkPoint(
  e: RoadEdge,
  s: number,
  side: 1 | -1,
  out: NavPoint = scratchPoint(),
  inset = 0,
): NavPoint {
  const lateral = side * (e.carriageway + SIDEWALK_WIDTH * 0.5 + inset);
  const sp = roadSurface(e, s, lateral);
  out.x = sp.x;
  out.z = sp.z;
  // The kerb lifts the footway; using the carriageway height puts pedestrians
  // shin-deep in the road at every corner.
  out.y = sp.y + 0.152;
  return out;
}

/** Lane centre point for a vehicle: `s` along the edge in the lane's own frame. */
export function lanePoint(e: RoadEdge, s: number, lane: Lane, out: NavPoint = scratchPoint()): NavPoint {
  const sp = roadSurface(e, s, lane.offset);
  out.x = sp.x;
  out.y = sp.y;
  out.z = sp.z;
  return out;
}

/**
 * Where a pedestrian steps off the kerb to cross an edge, and where they land.
 * Crossings sit just inside the junction deck so the walk lines up with the
 * zebra the road renderer paints there.
 */
export function crossingPoint(
  e: RoadEdge,
  atNodeA: boolean,
  side: 1 | -1,
  out: NavPoint = scratchPoint(),
): NavPoint {
  const s = atNodeA ? Math.min(e.trimA + 3.5, e.length * 0.5) : Math.max(e.length - e.trimB - 3.5, e.length * 0.5);
  return sidewalkPoint(e, s, side, out);
}

/**
 * Which side of an edge a world point is on, as the edge's own right-hand
 * normal sees it. Pedestrians keep to a side and only switch at crossings.
 */
export function sideOfEdge(e: RoadEdge, x: number, z: number): 1 | -1 {
  const a = roadNetwork.nodes[e.a];
  const lat = (x - a.x) * e.rx + (z - a.z) * e.rz;
  return lat >= 0 ? 1 : -1;
}

/** Distance along an edge from node a for a world point, clamped to the edge. */
export function sAlongEdge(e: RoadEdge, x: number, z: number): number {
  const a = roadNetwork.nodes[e.a];
  const s = (x - a.x) * e.dx + (z - a.z) * e.dz;
  return s < 0 ? 0 : s > e.length ? e.length : s;
}

/** Node ids at the two ends of an edge, ordered so `from` is the one given. */
export function otherEnd(e: RoadEdge, from: number): number {
  return e.a === from ? e.b : e.a;
}

/**
 * Pick the outgoing edge at `node` that best continues from `fromEdge`.
 * `turnBias` < 0 favours turning, > 0 favours going straight; the crowd uses a
 * mild straight bias so people walk down a street instead of spinning at every
 * corner, while traffic uses a strong one.
 */
const _contEdges = new Int32Array(16);
const _contWeights = new Float32Array(16);

export function chooseContinuation(
  node: RoadNode,
  fromEdge: number,
  turnBias: number,
  pick: number,
  noAlleys = false,
): number {
  const edges = roadNetwork.edges;
  const from = edges[fromEdge];
  if (!from) {
    if (node.edges.length === 0) return -1;
    return node.edges[Math.min(node.edges.length - 1, Math.floor(pick * node.edges.length))];
  }
  // Incoming bearing, pointing *away* from the node — the direction we would
  // continue in if we drove straight on.
  const incoming = from.a === node.id ? Math.atan2(from.dz, from.dx) : Math.atan2(-from.dz, -from.dx);

  let n = 0;
  let total = 0;
  for (let i = 0; i < node.edges.length && n < 16; i++) {
    const eid = node.edges[i];
    if (eid === fromEdge) continue;
    const e = edges[eid];
    if (!e) continue;
    if (noAlleys && e.isAlley) continue;
    const out = e.a === node.id ? Math.atan2(e.dz, e.dx) : Math.atan2(-e.dz, -e.dx);
    let d = out - incoming;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d <= -Math.PI) d += Math.PI * 2;
    // |d| ≈ 0 is straight on, |d| ≈ π is a U-turn.
    const straightness = 1 - Math.abs(d) / Math.PI;
    const w = Math.max(0.02, Math.pow(straightness, Math.max(0.1, turnBias * 3)));
    _contEdges[n] = eid;
    _contWeights[n] = w;
    total += w;
    n++;
  }
  if (n === 0) return fromEdge; // dead end: turn around
  let r = pick * total;
  for (let i = 0; i < n; i++) {
    r -= _contWeights[i];
    if (r <= 0) return _contEdges[i];
  }
  return _contEdges[n - 1];
}

/* ================================================================== *
 * Off-graph movement
 * ================================================================== */

const _rayHit = makeRayHit();

/**
 * Ground height under a point. Prefers the physics world (so an agent can
 * stand on a rooftop, a bridge deck or a parked truck) and falls back to the
 * analytic terrain, which is always available and never wrong about the hills.
 *
 * `from` is where to start the downward probe; pass the agent's current feet
 * height plus a step so a soldier walking up stairs does not snap to the
 * street twenty metres below.
 */
export function groundHeight(x: number, z: number, from = 400, reach = 500): number {
  if (isPhysicsReady()) {
    if (raycast(x, from, z, 0, -1, 0, reach, _rayHit, { skipSurface: true })) {
      return _rayHit.py;
    }
  }
  return walkableHeight(x, z);
}

/**
 * Short forward probe used by off-graph steering. Returns 0 when the way is
 * clear, otherwise the fraction of `dist` that is traversable, with the
 * blocking surface normal written into `outNormal` so the caller can slide.
 */
export function probeAhead(
  x: number,
  y: number,
  z: number,
  dx: number,
  dz: number,
  dist: number,
  outNormal: Float32Array,
): number {
  if (!isPhysicsReady()) return 1;
  const inv = 1 / (Math.hypot(dx, dz) || 1);
  if (!raycast(x, y, z, dx * inv, 0, dz * inv, dist, _rayHit, { skipSurface: true })) return 1;
  outNormal[0] = _rayHit.nx;
  outNormal[1] = _rayHit.ny;
  outNormal[2] = _rayHit.nz;
  return _rayHit.distance / dist;
}

/**
 * Slide a desired direction along a wall. Standard "project out the normal
 * component" — the difference between an agent that hugs a wall to the corner
 * and one that vibrates against it.
 */
export function slideAlong(dx: number, dz: number, nx: number, nz: number, out: Float32Array): void {
  const d = dx * nx + dz * nz;
  let sx = dx - nx * d;
  let sz = dz - nz * d;
  const len = Math.hypot(sx, sz);
  if (len > 1e-4) {
    sx /= len;
    sz /= len;
  } else {
    sx = -nz;
    sz = nx;
  }
  out[0] = sx;
  out[1] = sz;
}

/* ================================================================== *
 * Local avoidance — candidate-sampling RVO
 * ================================================================== */

/**
 * Reciprocal velocity obstacles, sampled rather than solved.
 *
 * The textbook ORCA linear program is exact and slow; for a crowd where every
 * agent is a cylinder on a plane, sampling ~13 candidate velocities and scoring
 * each against the six nearest neighbours gives visually identical results for
 * a fraction of the cost and no half-plane degeneracies. The reciprocity term
 * is the important part: each agent assumes the other will contribute half the
 * avoidance, so two people meeting head-on each step aside once, instead of
 * both stepping aside twice and oscillating.
 *
 * Priorities let a police cruiser part a crowd: a higher-priority agent takes
 * a smaller share of the avoidance, down to none at all.
 */
class AvoidanceField {
  private static readonly CELL = 6;
  private static readonly MAX_AGENTS = 2048;
  private static readonly MAX_NEIGHBOURS = 6;

  private px = new Float32Array(AvoidanceField.MAX_AGENTS);
  private pz = new Float32Array(AvoidanceField.MAX_AGENTS);
  private vx = new Float32Array(AvoidanceField.MAX_AGENTS);
  private vz = new Float32Array(AvoidanceField.MAX_AGENTS);
  private rad = new Float32Array(AvoidanceField.MAX_AGENTS);
  private pri = new Float32Array(AvoidanceField.MAX_AGENTS);
  private count = 0;

  private cells = new Map<number, number[]>();
  /** Scratch neighbour list, reused. */
  private nb = new Int32Array(AvoidanceField.MAX_NEIGHBOURS);
  private nbD = new Float32Array(AvoidanceField.MAX_NEIGHBOURS);
  private nbCount = 0;

  /** Candidate direction offsets, radians. Zero first so a clear path is free. */
  private static readonly ANGLES = [
    0, 0.26, -0.26, 0.55, -0.55, 0.95, -0.95, 1.5, -1.5, 2.3, -2.3, 3.1416, 0,
  ];
  /** Speed scales paired with the angles; the last two allow slowing down. */
  private static readonly SPEEDS = [
    1, 1, 1, 0.95, 0.95, 0.85, 0.85, 0.7, 0.7, 0.5, 0.5, 0.35, 0.25,
  ];

  /** Drop everything. Called once per frame before agents re-register. */
  begin(): void {
    this.count = 0;
    this.cells.clear();
  }

  /**
   * Register a moving obstacle. Returns the handle to pass to `solve`, or −1
   * when the field is full (in which case the agent simply does not avoid,
   * which is the correct graceful degradation at 2000 agents).
   */
  add(x: number, z: number, vx: number, vz: number, radius: number, priority = 0): number {
    if (this.count >= AvoidanceField.MAX_AGENTS) return -1;
    const i = this.count++;
    this.px[i] = x;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vz[i] = vz;
    this.rad[i] = radius;
    this.pri[i] = priority;
    const key = this.cellKey(x, z);
    let list = this.cells.get(key);
    if (!list) {
      list = [];
      this.cells.set(key, list);
    }
    list.push(i);
    return i;
  }

  private cellKey(x: number, z: number): number {
    const i = Math.floor(x / AvoidanceField.CELL);
    const j = Math.floor(z / AvoidanceField.CELL);
    return ((i + 65536) * 131071 + (j + 65536)) | 0;
  }

  private gather(self: number, x: number, z: number, range: number): void {
    this.nbCount = 0;
    const c = AvoidanceField.CELL;
    const i0 = Math.floor((x - range) / c);
    const i1 = Math.floor((x + range) / c);
    const j0 = Math.floor((z - range) / c);
    const j1 = Math.floor((z + range) / c);
    const r2 = range * range;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const list = this.cells.get(((i + 65536) * 131071 + (j + 65536)) | 0);
        if (!list) continue;
        for (let k = 0; k < list.length; k++) {
          const o = list[k];
          if (o === self) continue;
          const dx = this.px[o] - x;
          const dz = this.pz[o] - z;
          const d2 = dx * dx + dz * dz;
          if (d2 > r2) continue;
          // Insertion sort into a fixed six-slot nearest list.
          if (this.nbCount < AvoidanceField.MAX_NEIGHBOURS) {
            let p = this.nbCount++;
            while (p > 0 && this.nbD[p - 1] > d2) {
              this.nbD[p] = this.nbD[p - 1];
              this.nb[p] = this.nb[p - 1];
              p--;
            }
            this.nbD[p] = d2;
            this.nb[p] = o;
          } else if (d2 < this.nbD[AvoidanceField.MAX_NEIGHBOURS - 1]) {
            let p = AvoidanceField.MAX_NEIGHBOURS - 1;
            while (p > 0 && this.nbD[p - 1] > d2) {
              this.nbD[p] = this.nbD[p - 1];
              this.nb[p] = this.nb[p - 1];
              p--;
            }
            this.nbD[p] = d2;
            this.nb[p] = o;
          }
        }
      }
    }
  }

  /**
   * Choose a velocity close to (prefVx, prefVz) that does not walk into anyone.
   * Writes the result into `out` as [vx, vz]. `handle` is this agent's own
   * registration so it does not avoid itself; pass −1 if unregistered.
   */
  solve(
    handle: number,
    x: number,
    z: number,
    prefVx: number,
    prefVz: number,
    radius: number,
    out: Float32Array,
    horizon = 2.2,
    priority = 0,
  ): void {
    out[0] = prefVx;
    out[1] = prefVz;
    const prefSpeed = Math.hypot(prefVx, prefVz);
    if (prefSpeed < 1e-3) return;

    this.gather(handle, x, z, Math.max(4, prefSpeed * horizon + radius * 3));
    if (this.nbCount === 0) return;

    const prefAngle = Math.atan2(prefVz, prefVx);
    let bestScore = Infinity;
    let bestVx = prefVx;
    let bestVz = prefVz;

    for (let c = 0; c < AvoidanceField.ANGLES.length; c++) {
      const a = prefAngle + AvoidanceField.ANGLES[c];
      const s = prefSpeed * AvoidanceField.SPEEDS[c];
      const cvx = Math.cos(a) * s;
      const cvz = Math.sin(a) * s;

      // Deviation cost: how far this is from what we wanted.
      const dvx = cvx - prefVx;
      const dvz = cvz - prefVz;
      let score = Math.hypot(dvx, dvz) * 0.85;

      // Collision cost: the earliest time-to-collision across neighbours.
      let worst = 0;
      for (let n = 0; n < this.nbCount; n++) {
        const o = this.nb[n];
        // Reciprocity: each agent expects the other to do its half, so the
        // penalty it feels is only its own share. A higher-priority agent (an
        // ambulance in a crowd) takes a smaller share and simply comes through;
        // everyone around it takes a bigger one and gets out of the way.
        let share = 0.5 - (priority - this.pri[o]) * 0.25;
        share = share < 0 ? 0 : share > 1 ? 1 : share;
        if (share <= 0) continue;
        const rvx = cvx - this.vx[o];
        const rvz = cvz - this.vz[o];
        const relx = this.px[o] - x;
        const relz = this.pz[o] - z;
        const combined = radius + this.rad[o];
        const ttc = timeToCollision(relx, relz, rvx, rvz, combined);
        if (ttc < 0 || ttc > horizon) continue;
        const penalty = ((horizon - ttc) / Math.max(0.08, ttc)) * share * 2;
        if (penalty > worst) worst = penalty;
      }
      score += worst * 2.6;

      if (score < bestScore) {
        bestScore = score;
        bestVx = cvx;
        bestVz = cvz;
      }
    }
    out[0] = bestVx;
    out[1] = bestVz;
  }

  get agentCount(): number {
    return this.count;
  }
}

/**
 * Time until two discs of combined radius `r` collide, given relative position
 * (rx, rz) and relative velocity (vx, vz). −1 when they never do. Already
 * overlapping returns 0, which produces a maximal penalty and pushes agents
 * apart, which is what you want when a spawn drops two people on one another.
 */
function timeToCollision(rx: number, rz: number, vx: number, vz: number, r: number): number {
  // (rx, rz) is other − self; (vx, vz) is self's velocity − other's. In that
  // frame the pair is *closing* when their dot product is positive, and the
  // impact time is the near root of |w − v t| = r. Getting this sign backwards
  // produces an avoidance system that confidently steers into people, which is
  // exactly what it did until the smoke test caught it.
  const c = rx * rx + rz * rz - r * r;
  if (c < 0) return 0; // already overlapping
  const a = vx * vx + vz * vz;
  if (a < 1e-6) return -1;
  const b = rx * vx + rz * vz;
  if (b <= 0) return -1; // separating
  const disc = b * b - a * c;
  if (disc <= 0) return -1; // passes wide
  const t = (b - Math.sqrt(disc)) / a;
  return t < 0 ? -1 : t;
}

export const avoidance = new AvoidanceField();

/** Full reset. Level reload / hot-swap. */
export function resetNavigation(): void {
  navGraph.reset();
  clearPathCache();
  avoidance.begin();
}
