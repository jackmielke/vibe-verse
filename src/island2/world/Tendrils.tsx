/**
 * Tendrils — the roots and vines that hang below every island's rim, and the
 * rope bridges strung between them.
 *
 * These are doing more work than they look. In reference 2 the islands are
 * *connected* and they *drip* — long roots trailing metres into the air below
 * each rim, and sagging rope bridges spanning the gaps. Without them a
 * floating archipelago reads as a set of separate props that happen to share a
 * sky; with them it reads as one place that grew this way.
 *
 * Both are built as instanced/merged geometry with no per-frame allocation:
 * a few hundred tendrils and a handful of bridges cost two draw calls.
 */
import { useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { QUALITY } from "../config";
import { useIslandStore } from "../state/store";
import { ISLANDS, islandSDF, keelDepth, surfaceHeight, type IslandDef } from "../geo/islandGeo";
import { makeRng } from "@/shared/proc/rng";

/* ------------------------------------------------------------------ *
 * Hanging roots
 * ------------------------------------------------------------------ */

/**
 * Find the rim radius of an island along a bearing, by bisection on the SDF.
 * Shared with the terrain builder's approach so roots land exactly on the edge
 * rather than floating slightly off it.
 */
function rimRadius(isle: IslandDef, angle: number): number {
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);
  let lo = 0;
  let hi = isle.radius * 1.35;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) * 0.5;
    if (islandSDF(isle.x + dx * mid, isle.z + dz * mid, isle) > 0) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Build all the hanging tendrils for one island as a single merged geometry.
 *
 * Each tendril is a tapering ribbon that starts just inside the rim, hangs
 * down, and drifts slightly outward as it falls — roots that hang dead
 * vertical look like wires, and the outward drift is what makes them read as
 * organic.
 */
function buildTendrils(isle: IslandDef, count: number): THREE.BufferGeometry {
  const rng = makeRng(`tendrils:${isle.key}`);
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];

  const SEGMENTS = 5;
  const leafGreen = new THREE.Color(0.16, 0.34, 0.13);
  const rootBrown = new THREE.Color(0.28, 0.21, 0.14);
  const c = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const a = rng.next() * Math.PI * 2;
    const r = rimRadius(isle, a) * (0.88 + rng.next() * 0.10);
    const x = isle.x + Math.cos(a) * r;
    const z = isle.z + Math.sin(a) * r;

    const top = surfaceHeight(x, z);
    if (top === null) continue;
    const keel = keelDepth(x, z) ?? top - isle.keel;

    // Length: most are short, a few are dramatic. A uniform length reads as a
    // fringe; the long outliers are what sell the scale of the drop.
    const maxDrop = Math.min(top - keel + isle.keel * 0.35, isle.keel * 0.95);
    const len = maxDrop * (0.18 + Math.pow(rng.next(), 2.2) * 0.82);
    const width = 0.55 + rng.next() * 1.15;

    // Vines are green near the light, woody roots deeper down.
    c.copy(rng.chance(0.55) ? leafGreen : rootBrown);
    c.multiplyScalar(0.72 + rng.next() * 0.5);

    const base = pos.length / 3;
    const driftX = (rng.next() - 0.5) * 0.5;
    const driftZ = (rng.next() - 0.5) * 0.5;
    const outX = Math.cos(a) * 0.35;
    const outZ = Math.sin(a) * 0.35;

    for (let s = 0; s <= SEGMENTS; s++) {
      const t = s / SEGMENTS;
      // Ease so the taper happens mostly near the tip.
      const w = width * (1 - Math.pow(t, 1.6)) * 0.5;
      const y = top - 1.0 - len * t;
      const px = x + (driftX + outX) * len * t * 0.10;
      const pz = z + (driftZ + outZ) * len * t * 0.10;
      // Two verts per ring, forming a flat ribbon. Cheap, and at this distance
      // a ribbon and a tube are indistinguishable.
      pos.push(px - w, y, pz, px + w, y, pz);
      const shade = 1 - t * 0.45;
      col.push(c.r * shade, c.g * shade, c.b * shade, c.r * shade, c.g * shade, c.b * shade);
    }
    for (let s = 0; s < SEGMENTS; s++) {
      const a0 = base + s * 2;
      idx.push(a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/* ------------------------------------------------------------------ *
 * Rope bridges
 * ------------------------------------------------------------------ */

/** Which islands are joined. Chosen so the heart is never more than one hop away. */
const SPANS: [string, string][] = [
  ["heart", "snackfe"],
  ["heart", "grove"],
  ["heart", "arch-isle"],
  ["heart", "palace-rock"],
  ["snackfe", "lantern"],
];

/**
 * A catenary rope bridge: two ropes and a ladder of planks between them.
 *
 * The sag is the whole point. A straight bridge between two floating islands
 * looks like a girder; the catenary is what tells you it is rope, and it is
 * what makes the gap feel like a gap.
 */
function buildBridges(): THREE.BufferGeometry | null {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const byKey = Object.fromEntries(ISLANDS.map((i) => [i.key, i]));
  const plank = new THREE.Color(0.36, 0.26, 0.17);
  const rope = new THREE.Color(0.46, 0.40, 0.28);

  const addBox = (
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    yaw: number, c: THREE.Color,
  ) => {
    const base = pos.length / 3;
    const s = Math.sin(yaw);
    const co = Math.cos(yaw);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const lx = sx * hx;
      const lz = sz * hz;
      pos.push(cx + lx * co - lz * s, cy + sy * hy, cz + lx * s + lz * co);
      col.push(c.r, c.g, c.b);
    }
    // 0..7 corner ordering: (x,y,z) with x outer, y mid, z inner.
    const q = [
      [0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1],
      [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3],
    ];
    for (const [a, b, cc, d] of q) {
      idx.push(base + a, base + b, base + cc, base + a, base + cc, base + d);
    }
  };

  for (const [ka, kb] of SPANS) {
    const A = byKey[ka];
    const B = byKey[kb];
    if (!A || !B) continue;

    const ang = Math.atan2(B.z - A.z, B.x - A.x);
    const ra = rimRadius(A, ang);
    const rb = rimRadius(B, ang + Math.PI);
    const ax = A.x + Math.cos(ang) * ra;
    const az = A.z + Math.sin(ang) * ra;
    const bx = B.x + Math.cos(ang + Math.PI) * rb;
    const bz = B.z + Math.sin(ang + Math.PI) * rb;
    const ay = (surfaceHeight(ax, az) ?? A.elevation) + 1.0;
    const by = (surfaceHeight(bx, bz) ?? B.elevation) + 1.0;

    const span = Math.hypot(bx - ax, bz - az);
    if (span < 8 || span > 900) continue;
    const sag = Math.min(span * 0.13, 34);
    const steps = Math.max(10, Math.round(span / 5));

    let px = ax;
    let py = ay;
    let pz = az;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      // Catenary approximated by a parabola — indistinguishable at this scale
      // and far cheaper than cosh.
      const y = ay + (by - ay) * t - sag * 4 * t * (1 - t);

      const segLen = Math.hypot(x - px, y - py, z - pz);
      const mx = (x + px) / 2;
      const my = (y + py) / 2;
      const mz = (z + pz) / 2;
      const yaw = Math.atan2(z - pz, x - px);

      // Deck plank.
      addBox(mx, my, mz, segLen * 0.5, 0.07, 1.05, yaw, plank);
      // Hand ropes either side, a little above the deck.
      const nx = Math.cos(yaw + Math.PI / 2) * 1.05;
      const nz = Math.sin(yaw + Math.PI / 2) * 1.05;
      addBox(mx + nx, my + 0.95, mz + nz, segLen * 0.5, 0.05, 0.05, yaw, rope);
      addBox(mx - nx, my + 0.95, mz - nz, segLen * 0.5, 0.05, 0.05, yaw, rope);

      px = x;
      py = y;
      pz = z;
    }
  }

  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export default function Tendrils() {
  const tier = useIslandStore((s) => s.quality);
  const q = QUALITY[tier];

  const tendrils = useMemo(
    () =>
      ISLANDS.filter((i) => i.key !== "snow-peak").map((isle) => ({
        isle,
        geo: buildTendrils(
          isle,
          Math.max(26, Math.round((isle.radius / 2.2) * q.foliageDensity)),
        ),
      })),
    [q.foliageDensity],
  );

  const bridges = useMemo(() => buildBridges(), []);

  useLayoutEffect(() => {
    return () => {
      for (const t of tendrils) t.geo.dispose();
      bridges?.dispose();
    };
  }, [tendrils, bridges]);

  return (
    <group name="tendrils">
      {tendrils.map(({ isle, geo }) => (
        <mesh key={isle.key} geometry={geo} castShadow>
          <meshStandardMaterial
            vertexColors
            roughness={0.95}
            metalness={0}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
      {bridges && (
        <mesh geometry={bridges} castShadow receiveShadow name="bridges">
          <meshStandardMaterial vertexColors roughness={0.88} metalness={0} />
        </mesh>
      )}
    </group>
  );
}
