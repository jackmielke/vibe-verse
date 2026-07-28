/**
 * Terrain — the San Francisco landform.
 *
 * Built as a geometry clipmap: concentric rings of decreasing resolution
 * centred on the camera. The innermost ring is metre-scale so you can see the
 * camber of a street; the outermost covers the whole bay and the Marin
 * headlands at 100 m resolution. Total vertex count stays constant no matter
 * where you stand, which is the only way a 9.5 km map survives a browser.
 */
import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { QUALITY } from "../config";
import { useSfStore } from "../state/store";
import {
  districtAt,
  districtInfluence,
  isPark,
  isRoad,
  landSDF,
  terrainHeight,
  terrainSlope,
} from "../geo/sfGeo";
import { clamp01, fbm2, smoothstep } from "../math/rng";

/** One clipmap ring: how far it reaches and how coarse its cells are. */
interface Ring {
  extent: number;
  cell: number;
}

const RINGS: Ring[] = [
  { extent: 320, cell: 4 },
  { extent: 900, cell: 12 },
  { extent: 2400, cell: 34 },
  { extent: 6200, cell: 96 },
  { extent: 14000, cell: 280 },
];

/**
 * Ground surface colour. Terrain is not one material — it is asphalt where
 * the streets run, grass in the parks, sand at the waterline, dry California
 * gold on the hills, and dark rock on the steep cuts. Baking this into vertex
 * colour lets one draw call carry the whole landform.
 *
 * `cell` is the clipmap ring's vertex spacing in metres, and it matters a lot.
 * A 9 m street sampled on a 96 m grid does not become a thin line — it becomes
 * a 96 m black band wherever a vertex happens to land on tarmac, and the city
 * reads as if someone drew over it with a marker. So road detail is only
 * resolved on rings fine enough to carry it; coarser rings get the *average*
 * tone of the block instead, which is what a real mip level would give you.
 */
function groundColor(x: number, z: number, out: THREE.Color, cell: number): THREE.Color {
  const sd = landSDF(x, z);
  const h = terrainHeight(x, z);
  const slope = terrainSlope(x, z, 6);

  if (sd <= 0) {
    // Seabed — only ever seen through the water, so it just needs to be dark
    // and slightly varied so shallow water reads as shallow.
    out.setRGB(0.055, 0.075, 0.082);
    return out;
  }

  // Beach / seawall band.
  const beach = 1 - smoothstep(6, 46, sd);

  // Only resolve individual carriageways when the ring can actually carry the
  // frequency. A 9 m street needs better than ~4 m spacing to survive point
  // sampling; at 12 m you get a smeared 12 m-wide band instead of a road, so
  // the innermost ring paints roadway and nothing else does.
  const roadResolve = 1 - smoothstep(4, 9, cell);
  const road = roadResolve > 0 && isRoad(x, z) ? roadResolve : 0;
  const park = isPark(x, z) ? 1 : 0;

  // Dry-grass gold on the exposed hills, greener in the fog belt to the west.
  const west = clamp01((-x - 1200) / 4200);
  const grassGreen = new THREE.Color(0.20, 0.28, 0.13);
  const grassGold = new THREE.Color(0.46, 0.41, 0.21);
  const grass = grassGold.clone().lerp(grassGreen, 0.35 + west * 0.45);

  // Rock shows through where it is too steep to hold soil.
  const rock = smoothstep(0.42, 0.72, slope);

  const d = districtAt(x, z);
  const urban = clamp01(districtInfluence(x, z, d) * 1.15);

  const asphalt = new THREE.Color(0.052, 0.054, 0.058);
  const concrete = new THREE.Color(0.30, 0.295, 0.285);
  const sand = new THREE.Color(0.62, 0.56, 0.44);
  const stone = new THREE.Color(0.24, 0.225, 0.205);

  // The block average: what a built-up city block resolves to once you are far
  // enough away that individual streets and roofs merge. Mostly the dark grey
  // of tarmac and shadowed lightwells, lifted by sidewalk concrete and roof
  // gravel, and tinted slightly toward the district's own palette so the
  // Sunset's pale stucco and Dogpatch's rusted metal stay distinguishable from
  // the air. Real cities read grey-brown from above; they never read green.
  const pal = d.palette[0] ?? 0x9a958c;
  const blockAvg = new THREE.Color(
    0.118 + ((pal >> 16) & 255) / 255 * 0.052,
    0.116 + ((pal >> 8) & 255) / 255 * 0.050,
    0.112 + (pal & 255) / 255 * 0.048,
  );

  out.copy(grass);
  out.lerp(stone, rock * 0.8);
  // Urban ground: the block average first, then resolve concrete and asphalt
  // on top of it only on rings fine enough to show them.
  out.lerp(blockAvg, urban * (1 - park));
  out.lerp(concrete, urban * (1 - park) * 0.55 * roadResolve);
  out.lerp(asphalt, road * (1 - park) * 0.95);
  out.lerp(grass, park * 0.85);
  out.lerp(sand, beach * 0.9);

  // Break up the flatness — grime, tyre polish, patchy repaving.
  const grime = fbm2(x * 0.014, z * 0.014, 3, 2, 0.5, 55) * 0.5 + 0.5;
  const macro = fbm2(x * 0.0018, z * 0.0018, 3, 2, 0.5, 991) * 0.5 + 0.5;
  const v = 0.82 + grime * 0.22 + macro * 0.16;
  out.multiplyScalar(v);

  // High ground catches more light and reads slightly paler.
  out.lerp(new THREE.Color(0.58, 0.55, 0.48), clamp01(h / 900) * 0.18);
  return out;
}

/** Build one clipmap ring as a hollow square annulus (or a full quad for ring 0). */
function buildRing(inner: number, outer: number, cell: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const cols = Math.ceil((outer * 2) / cell) + 1;
  const index = new Map<number, number>();

  const key = (ix: number, iz: number) => ix * 100003 + iz;

  const addVert = (ix: number, iz: number) => {
    const k = key(ix, iz);
    const existing = index.get(k);
    if (existing !== undefined) return existing;
    const id = positions.length / 3;
    positions.push(-outer + ix * cell, 0, -outer + iz * cell);
    index.set(k, id);
    return id;
  };

  for (let iz = 0; iz < cols - 1; iz++) {
    for (let ix = 0; ix < cols - 1; ix++) {
      const cx = -outer + (ix + 0.5) * cell;
      const cz = -outer + (iz + 0.5) * cell;
      if (inner > 0 && Math.abs(cx) < inner && Math.abs(cz) < inner) continue;
      const a = addVert(ix, iz);
      const b = addVert(ix + 1, iz);
      const c = addVert(ix + 1, iz + 1);
      const d = addVert(ix, iz + 1);
      indices.push(a, d, b, b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(new Float32Array(positions.length), 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(positions.length), 3));
  geo.setIndex(indices);
  return geo;
}

/** Sample heights + colours into a ring geometry positioned at (ox,oz). */
function displaceRing(geo: THREE.BufferGeometry, ox: number, oz: number, cell: number): void {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const col = geo.getAttribute("color") as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  const carr = col.array as Float32Array;
  const c = new THREE.Color();
  for (let i = 0; i < arr.length; i += 3) {
    const wx = arr[i] + ox;
    const wz = arr[i + 2] + oz;
    arr[i + 1] = terrainHeight(wx, wz);
    groundColor(wx, wz, c, cell);
    carr[i] = c.r;
    carr[i + 1] = c.g;
    carr[i + 2] = c.b;
  }
  pos.needsUpdate = true;
  col.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  if (geo.boundingSphere) geo.boundingSphere.radius *= 2.2;
}

function ClipmapRing({
  inner,
  outer,
  cell,
  receive,
}: {
  inner: number;
  outer: number;
  cell: number;
  receive: boolean;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const geo = useMemo(() => buildRing(inner, outer, cell), [inner, outer, cell]);
  const last = useRef({ x: Infinity, z: Infinity });
  const { camera } = useThree();

  useLayoutEffect(() => () => geo.dispose(), [geo]);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    // Snap the ring to a multiple of its cell size so vertices never swim.
    const snap = cell * 2;
    const sx = Math.round(camera.position.x / snap) * snap;
    const sz = Math.round(camera.position.z / snap) * snap;
    if (sx === last.current.x && sz === last.current.z) return;
    last.current.x = sx;
    last.current.z = sz;
    mesh.position.set(sx, 0, sz);
    displaceRing(geo, sx, sz, cell);
  });

  return (
    <mesh ref={meshRef} geometry={geo} receiveShadow={receive} castShadow={false} frustumCulled={false}>
      <meshStandardMaterial
        vertexColors
        roughness={0.94}
        metalness={0.0}
        dithering
      />
    </mesh>
  );
}

export default function Terrain() {
  const tier = useSfStore((s) => s.quality);
  const q = QUALITY[tier];
  const rings = useMemo(() => {
    const budget = q.drawDistance;
    const list: { inner: number; outer: number; cell: number; receive: boolean }[] = [];
    let inner = 0;
    for (const r of RINGS) {
      if (inner > budget) break;
      const cell = tier === "low" ? r.cell * 2 : tier === "ultra" ? r.cell * 0.75 : r.cell;
      // Only rings that lie inside the shadow volume may receive shadows.
      // A ring reaching 14 km still samples the 900 m shadow map, and outside
      // the light frustum that lookup degenerates into a repeating grid of
      // phantom shadows smeared across the whole landform — which is exactly
      // what it looks like: someone drew the street grid on the hills in pen.
      list.push({ inner, outer: r.extent, cell, receive: inner < q.shadowDistance });
      inner = r.extent;
    }
    return list;
  }, [q.drawDistance, q.shadowDistance, tier]);

  return (
    <group name="terrain">
      {rings.map((r) => (
        <ClipmapRing
          key={`${r.inner}-${r.outer}`}
          inner={r.inner}
          outer={r.outer}
          cell={r.cell}
          receive={r.receive}
        />
      ))}
    </group>
  );
}
