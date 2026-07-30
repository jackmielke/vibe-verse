/**
 * Signage.tsx — neon, blades, boxes, billboards and the night pass.
 *
 * This is the layer that decides what time it is. A San Francisco street at
 * 14:00 and the same street at 21:00 are not the same place, and almost all of
 * the difference is signage: Chinatown's vertical blades stacked four storeys
 * up Grant Avenue, North Beach's bar signs with their martini glasses and
 * arrows, the internally-lit box signs over every corner store, and the
 * billboards on the SoMa parking lots.
 *
 * All of it comes off one atlas (`signAtlas.ts`) so the whole signage layer is
 * a single material: one draw call per chunk, day and night. Emission is a
 * single `emissiveIntensity` ramp driven by the real solar elevation, which
 * means the signs come on when the sun goes down rather than at some arbitrary
 * clock hour, and the bloom in the post chain does the rest.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { QUALITY } from "../../config";
import { frame, useSfStore } from "../../state/store";
import { sunDirection } from "../../sky/Sky";
import { clamp, clamp01, makeRng, smoothstep, type Rng } from "../../math/rng";
import { KERB_HEIGHT, SIDEWALK_WIDTH, edgeSpan, roadNetwork, roadSurface, type RoadEdge, type SurfacePoint } from "./roadNetwork";
import { MeshSink, addBox, addCylinder, addPanel, addTube, type RGB } from "./geom";
import { ChunkStreamer, disposeObject, reportPending } from "./chunker";
import { getSignAtlas, disposeSignAtlas, type SignAtlas, type UVRect } from "./signAtlas";

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const WHITE: RGB = { r: 1, g: 1, b: 1 };
const _S1: SurfacePoint = { x: 0, y: 0, z: 0, rx: 0, rz: 0, tx: 0, ty: 0, tz: 0 };

/**
 * Repoint every UV written since `from` at the centre of an atlas swatch.
 *
 * The primitive builders in `geom.ts` generate world-space UVs, which is right
 * for a tiling material and useless for an atlas. Rather than thread UV rects
 * through every primitive, structural parts (frames, posts, brackets, lanterns)
 * are built normally and then pinned to a flat colour cell afterwards.
 */
function pinUV(sink: MeshSink, from: number, rect: UVRect): void {
  const u = (rect[0] + rect[2]) * 0.5;
  const v = (rect[1] + rect[3]) * 0.5;
  for (let i = from; i < sink.vCount; i++) {
    sink.uv[i * 2] = u;
    sink.uv[i * 2 + 1] = v;
  }
}

/** Facade anchor: the point on the property line, and the outward street normal. */
interface Anchor {
  x: number;
  y: number;
  z: number;
  /** Unit vector pointing from the facade toward the road. */
  nx: number;
  nz: number;
  /** Unit vector along the facade. */
  tx: number;
  tz: number;
}

const _anchor: Anchor = { x: 0, y: 0, z: 0, nx: 0, nz: 0, tx: 0, tz: 0 };

function facadeAnchor(e: RoadEdge, s: number, side: 1 | -1, inset: number): Anchor {
  const lat = e.halfWidth + SIDEWALK_WIDTH - inset;
  roadSurface(e, s, side * lat, _S1);
  const kerbY = roadSurface(e, s, side * e.carriageway).y + KERB_HEIGHT;
  _anchor.x = _S1.x;
  _anchor.z = _S1.z;
  _anchor.y = kerbY + (lat - e.carriageway) * 0.02;
  _anchor.nx = -side * e.rx;
  _anchor.nz = -side * e.rz;
  _anchor.tx = e.dx;
  _anchor.tz = e.dz;
  return _anchor;
}

/** Yaw that turns a local +Z normal to face (dx, dz). */
function yawTo(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}

/* ------------------------------------------------------------------ *
 * Sign builders
 * ------------------------------------------------------------------ */

/**
 * The Chinatown vertical blade: a tall narrow sign bolted out at right angles
 * to the facade so it can be read down the length of the street. Two brackets,
 * a face on each side, and — on about a third of them — a run of chase bulbs
 * that the atlas already painted in.
 */
function verticalNeon(
  sink: MeshSink, a: Anchor, atlas: SignAtlas, rng: Rng, baseY: number,
): void {
  const h = rng.range(2.6, 4.6);
  const w = h * 0.42;
  const out = w * 0.5 + 0.25;
  const cy = baseY + h * 0.5;
  const cx = a.x + a.nx * out;
  const cz = a.z + a.nz * out;
  const rect = atlas.neonV[rng.int(0, atlas.neonV.length - 1)];
  // The face is perpendicular to the facade: it faces along the street.
  const yaw = yawTo(a.tx, a.tz);
  addPanel(sink, cx, cy, cz, w, h, yaw, WHITE, rect, true);

  // Mounting brackets back to the wall.
  const from = sink.vCount;
  for (const k of [-1, 1] as const) {
    const by = cy + k * h * 0.36;
    addBox(
      sink,
      (a.x + cx) * 0.5, by, (a.z + cz) * 0.5,
      out * 0.5, 0.035, 0.035, yawTo(a.nx, a.nz),
      WHITE, 1,
    );
  }
  pinUV(sink, from, atlas.swatch[8]);
}

/** A flat internally-lit box sign over a shopfront. */
function shopSign(
  sink: MeshSink, a: Anchor, atlas: SignAtlas, rng: Rng, baseY: number,
): void {
  const w = rng.range(2.4, 5.2);
  const h = rng.range(0.7, 1.15);
  const out = 0.22;
  const cx = a.x + a.nx * out;
  const cz = a.z + a.nz * out;
  const cy = baseY + rng.range(3.4, 4.4);
  const rect = atlas.shop[rng.int(0, atlas.shop.length - 1)];
  addPanel(sink, cx, cy, cz, w, h, yawTo(a.nx, a.nz), WHITE, rect, false);
  // Slim return frame so the box has depth from an angle.
  const from = sink.vCount;
  addBox(sink, (a.x + cx) * 0.5, cy, (a.z + cz) * 0.5, w * 0.5, h * 0.5, out * 0.5, yawTo(a.tx, a.tz), WHITE, 1);
  pinUV(sink, from, atlas.swatch[0]);
}

/** A projecting bar sign — the North Beach staple. */
function bladeSign(
  sink: MeshSink, a: Anchor, atlas: SignAtlas, rng: Rng, baseY: number,
): void {
  const w = rng.range(1.6, 2.6);
  const h = w * 0.5;
  const out = w * 0.5 + 0.3;
  const cy = baseY + rng.range(3.3, 5.2);
  const cx = a.x + a.nx * out;
  const cz = a.z + a.nz * out;
  const rect = atlas.blade[rng.int(0, atlas.blade.length - 1)];
  addPanel(sink, cx, cy, cz, w, h, yawTo(a.tx, a.tz), WHITE, rect, true);
  const from = sink.vCount;
  addBox(sink, (a.x + cx) * 0.5, cy + h * 0.5 + 0.08, (a.z + cz) * 0.5, out * 0.5, 0.04, 0.04, yawTo(a.nx, a.nz), WHITE, 1);
  // A diagonal stay, which is what actually holds these up.
  addBox(sink, a.x + a.nx * out * 0.4, cy - h * 0.1, a.z + a.nz * out * 0.4, out * 0.45, 0.03, 0.03, yawTo(a.nx, a.nz), WHITE, 1);
  pinUV(sink, from, atlas.swatch[8]);
}

/** A fabric awning over the shopfront, with its valance. */
function awning(sink: MeshSink, a: Anchor, atlas: SignAtlas, rng: Rng, baseY: number): void {
  const w = rng.range(2.2, 4.4);
  const proj = rng.range(1.1, 1.7);
  const yTop = baseY + rng.range(3.0, 3.5);
  const yLip = yTop - rng.range(0.45, 0.75);
  const from = sink.vCount;
  const hx = a.tx * w * 0.5;
  const hz = a.tz * w * 0.5;
  // Sloping fabric.
  const p0x = a.x - hx;
  const p0z = a.z - hz;
  const p1x = a.x + hx;
  const p1z = a.z + hz;
  const q0x = p0x + a.nx * proj;
  const q0z = p0z + a.nz * proj;
  const q1x = p1x + a.nx * proj;
  const q1z = p1z + a.nz * proj;
  const n = sink.vert.bind(sink);
  const ny = 0.72;
  const v0 = n(p0x, yTop, p0z, a.nx * 0.5, ny, a.nz * 0.5, 0, 0, 1, 1, 1);
  const v1 = n(p1x, yTop, p1z, a.nx * 0.5, ny, a.nz * 0.5, 0, 0, 1, 1, 1);
  const v2 = n(q1x, yLip, q1z, a.nx * 0.5, ny, a.nz * 0.5, 0, 0, 1, 1, 1);
  const v3 = n(q0x, yLip, q0z, a.nx * 0.5, ny, a.nz * 0.5, 0, 0, 1, 1, 1);
  sink.quad(v0, v1, v2, v3);
  sink.quad(v3, v2, v1, v0);
  // Valance hanging off the lip.
  const w0 = n(q0x, yLip, q0z, a.nx, 0, a.nz, 0, 0, 1, 1, 1);
  const w1 = n(q1x, yLip, q1z, a.nx, 0, a.nz, 0, 0, 1, 1, 1);
  const w2 = n(q1x, yLip - 0.26, q1z, a.nx, 0, a.nz, 0, 0, 1, 1, 1);
  const w3 = n(q0x, yLip - 0.26, q0z, a.nx, 0, a.nz, 0, 0, 1, 1, 1);
  sink.quad(w0, w1, w2, w3);
  sink.quad(w3, w2, w1, w0);
  pinUV(sink, from, atlas.swatch[rng.chance(0.5) ? 3 : 4]);
}

/**
 * A billboard on the property line: a big face, a frame, two posts and the
 * floodlight gantry along the bottom edge that makes it legible at night.
 */
function billboard(sink: MeshSink, a: Anchor, atlas: SignAtlas, rng: Rng, baseY: number): void {
  const w = rng.range(9, 14.6);
  const h = w * 0.46;
  const yBase = baseY + rng.range(4.5, 9);
  const cy = yBase + h * 0.5;
  const out = 0.4;
  const cx = a.x + a.nx * out;
  const cz = a.z + a.nz * out;
  const rect = atlas.billboard[rng.int(0, atlas.billboard.length - 1)];
  addPanel(sink, cx, cy, cz, w, h, yawTo(a.nx, a.nz), WHITE, rect, false);

  const from = sink.vCount;
  const yaw = yawTo(a.nx, a.nz);
  // Frame.
  addBox(sink, cx, cy + h * 0.5 + 0.12, cz, w * 0.5 + 0.2, 0.12, 0.12, yaw, WHITE, 1);
  addBox(sink, cx, cy - h * 0.5 - 0.12, cz, w * 0.5 + 0.2, 0.12, 0.12, yaw, WHITE, 1);
  for (const k of [-1, 1] as const) {
    addBox(
      sink,
      cx + a.tx * k * (w * 0.5 + 0.1), cy, cz + a.tz * k * (w * 0.5 + 0.1),
      0.1, h * 0.5, 0.1, yaw, WHITE, 1,
    );
  }
  // Posts down to the ground.
  for (const k of [-1, 1] as const) {
    const px = a.x + a.tx * k * w * 0.28;
    const pz = a.z + a.tz * k * w * 0.28;
    addCylinder(sink, px, baseY - 0.3, pz, 0.24, 0.19, yBase - baseY + 0.4, 8, WHITE, 1, false);
  }
  // Floodlight gantry.
  for (let i = 0; i < 4; i++) {
    const t = (i + 0.5) / 4 - 0.5;
    const lx = cx + a.tx * t * w * 0.8 + a.nx * 0.8;
    const lz = cz + a.tz * t * w * 0.8 + a.nz * 0.8;
    addBox(sink, lx, cy - h * 0.5 - 0.28, lz, 0.16, 0.1, 0.12, yaw, WHITE, 1, true);
  }
  pinUV(sink, from, atlas.swatch[8]);
}

/**
 * A string of lanterns hung across the street.
 *
 * Two catenaries, staggered, each carrying a run of paper lanterns — the thing
 * Grant Avenue is famous for. The sag is real: 8 % of the span, which is what a
 * steel messenger wire actually does with that load on it.
 */
function lanternString(
  sink: MeshSink, e: RoadEdge, s: number, atlas: SignAtlas, rng: Rng,
): void {
  const lat = e.halfWidth + SIDEWALK_WIDTH - 0.4;
  roadSurface(e, s, -lat, _S1);
  const ax = _S1.x;
  const az = _S1.z;
  const ay = roadSurface(e, s, -e.carriageway).y + KERB_HEIGHT;
  roadSurface(e, s, lat, _S1);
  const bx = _S1.x;
  const bz = _S1.z;
  const by = roadSurface(e, s, e.carriageway).y + KERB_HEIGHT;
  const span = Math.hypot(bx - ax, bz - az);
  if (span < 6) return;
  const hang = 6.4 + rng.range(0, 1.2);
  const sag = span * 0.075;

  const N = 10;
  const pts = new Float32Array((N + 1) * 3);
  const ys: number[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const y = ay + hang + (by - ay) * t - Math.sin(t * Math.PI) * sag;
    pts[i * 3] = ax + (bx - ax) * t;
    pts[i * 3 + 1] = y;
    pts[i * 3 + 2] = az + (bz - az) * t;
    ys.push(y);
  }
  const from = sink.vCount;
  addTube(sink, pts, N + 1, 0.022, 4, WHITE, 1);
  pinUV(sink, from, atlas.swatch[12]);

  // Lanterns.
  const count = Math.max(3, Math.round(span / 3.4));
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const idx = Math.min(N, Math.round(t * N));
    const lx = ax + (bx - ax) * t;
    const lz = az + (bz - az) * t;
    const ly = ys[idx] - 0.36;
    const r = rng.range(0.20, 0.30);
    const lf = sink.vCount;
    // Barrel profile: three stacked frusta reads as a paper lantern.
    addCylinder(sink, lx, ly - r * 1.05, lz, r * 0.45, r, r * 0.5, 8, WHITE, 1, false);
    addCylinder(sink, lx, ly - r * 0.55, lz, r, r, r * 0.55, 8, WHITE, 1, false);
    addCylinder(sink, lx, ly, lz, r, r * 0.45, r * 0.5, 8, WHITE, 1, false);
    pinUV(sink, lf, atlas.swatch[rng.chance(0.75) ? 1 : 2]);
    // Tassel.
    const tf = sink.vCount;
    addCylinder(sink, lx, ly - r * 1.6, lz, 0.03, 0.015, r * 0.55, 4, WHITE, 1, false);
    pinUV(sink, tf, atlas.swatch[2]);
  }
}

/* ------------------------------------------------------------------ *
 * Chunk assembly
 * ------------------------------------------------------------------ */

const _edges: RoadEdge[] = [];

/** How busy each district's frontage is, and with what. */
interface SignProfile {
  vertical: number;
  blade: number;
  shop: number;
  awning: number;
  billboard: number;
  lantern: number;
}

function profileFor(key: string): SignProfile {
  switch (key) {
    case "chinatown":
      return { vertical: 0.72, blade: 0.14, shop: 0.42, awning: 0.34, billboard: 0, lantern: 0.55 };
    case "northbeach":
      return { vertical: 0.16, blade: 0.5, shop: 0.42, awning: 0.4, billboard: 0.02, lantern: 0.06 };
    case "fidi":
    case "rincon":
      return { vertical: 0.02, blade: 0.14, shop: 0.46, awning: 0.2, billboard: 0.05, lantern: 0 };
    case "soma":
    case "dogpatch":
    case "potrero":
      return { vertical: 0.02, blade: 0.16, shop: 0.3, awning: 0.14, billboard: 0.16, lantern: 0 };
    case "mission":
      return { vertical: 0.08, blade: 0.3, shop: 0.55, awning: 0.42, billboard: 0.1, lantern: 0.02 };
    case "castro":
    case "haight":
    case "hayesvalley":
      return { vertical: 0.05, blade: 0.32, shop: 0.5, awning: 0.36, billboard: 0.02, lantern: 0 };
    case "civiccenter":
    case "embarcadero":
    case "westernaddition":
    case "nobhill":
    case "russianhill":
      return { vertical: 0.02, blade: 0.16, shop: 0.32, awning: 0.2, billboard: 0.03, lantern: 0 };
    case "bayview":
      return { vertical: 0.01, blade: 0.1, shop: 0.2, awning: 0.08, billboard: 0.14, lantern: 0 };
    default:
      return { vertical: 0.01, blade: 0.08, shop: 0.16, awning: 0.12, billboard: 0.01, lantern: 0 };
  }
}

function buildSignChunk(
  x: number, z: number, size: number, lod: number, atlas: SignAtlas, mat: THREE.Material,
): { meshes: THREE.Object3D[] } | null {
  roadNetwork.ensureRect(x - 300, z - 300, x + size + 300, z + size + 300);
  roadNetwork.edgesInRect(x, z, x + size, z + size, _edges);
  if (_edges.length === 0) return null;
  const sink = new MeshSink(lod === 0 ? 5000 : 1200);

  for (const e of _edges) {
    if (e.isAlley) continue;
    const span = edgeSpan(e);
    if (span.len < 8) continue;
    const p = profileFor(e.district.key);
    const rng = makeRng(e.seed ^ 0x5164);

    // Billboards read from a long way off, so they survive into the far ring.
    if (p.billboard > 0 && rng.chance(p.billboard)) {
      const side: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      const s = span.s0 + span.len * rng.range(0.25, 0.75);
      const a = facadeAnchor(e, s, side, 0.6);
      billboard(sink, a, atlas, rng, a.y);
    }
    if (lod !== 0) continue;

    // Frontage furniture, walked along the block at shopfront pitch.
    for (const side of [1, -1] as const) {
      for (let s = span.s0 + rng.range(1, 5); s < span.s1 - 2; s += rng.range(5.5, 9.5)) {
        const a = facadeAnchor(e, s, side, 0.12);
        const base = a.y;
        const roll = rng.next();
        if (roll < p.vertical) {
          // Chinatown stacks them up the building, not just at ground level.
          const storeys = rng.int(1, 3);
          for (let k = 0; k < storeys; k++) {
            verticalNeon(sink, facadeAnchor(e, s, side, 0.12), atlas, rng, base + 3.2 + k * rng.range(3.2, 4.4));
          }
        } else if (roll < p.vertical + p.blade) {
          bladeSign(sink, a, atlas, rng, base);
        } else if (roll < p.vertical + p.blade + p.shop) {
          shopSign(sink, a, atlas, rng, base);
          if (rng.chance(p.awning)) awning(sink, facadeAnchor(e, s, side, 0.12), atlas, rng, base);
        } else if (roll < p.vertical + p.blade + p.shop + p.awning) {
          awning(sink, a, atlas, rng, base);
        }
      }
    }

    // Lanterns across the street.
    if (p.lantern > 0) {
      for (let s = span.s0 + 6; s < span.s1 - 6; s += rng.range(9, 16)) {
        if (rng.chance(p.lantern)) lanternString(sink, e, s, atlas, rng);
      }
    }
  }

  const origin = { x: x + size * 0.5, y: 0, z: z + size * 0.5 };
  const g = sink.finalize(origin);
  if (!g) return null;
  const m = new THREE.Mesh(g, mat);
  m.position.set(origin.x, origin.y, origin.z);
  m.matrixAutoUpdate = false;
  m.updateMatrix();
  m.castShadow = false;
  m.receiveShadow = true;
  m.name = "sf-signage";
  return { meshes: [m] };
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

const _cam = new THREE.Vector3();
const _sun = new THREE.Vector3();

export default function Signage() {
  const tier = useSfStore((s) => s.quality);
  const q = QUALITY[tier];
  const { camera } = useThree();
  const group = useRef<THREE.Group>(null);

  const atlas = useMemo(() => getSignAtlas(tier), [tier]);

  /**
   * One material for every sign in the city. Emission rides the same texture as
   * the albedo, so a sign that is dark on the atlas stays dark at night and a
   * neon tube goes incandescent — no second map, no second draw call.
   */
  const material = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({
      map: atlas.texture,
      emissiveMap: atlas.texture,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.04,
      roughness: 0.52,
      metalness: 0.06,
      vertexColors: true,
      side: THREE.DoubleSide,
      dithering: true,
    });
    m.name = "sf/signage";
    return m;
  }, [atlas]);

  const streamer = useRef<ChunkStreamer | null>(null);

  useEffect(() => {
    const g = group.current;
    if (!g) return;
    const s = new ChunkStreamer(
      g,
      (x, z, size, lod) => buildSignChunk(x, z, size, lod, atlas, material),
      () => clamp(q.detailRadius * 0.5, 220, 640),
      () => clamp(q.detailRadius * 2.4, 800, 3000),
      { cell: 256, farCell: 1024, budgetMs: 2.0, warmupMs: 6 },
    );
    streamer.current = s;
    return () => {
      s.dispose();
      streamer.current = null;
      for (const c of g.children.slice()) {
        g.remove(c);
        disposeObject(c);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atlas, material, q.detailRadius]);

  useEffect(() => () => material.dispose(), [material]);
  // The atlas is a tier-keyed singleton: `getSignAtlas` retires the previous one
  // itself, so only a genuine unmount should tear it down. Folding this into the
  // material's cleanup would dispose the *new* atlas on a quality change.
  useEffect(() => () => disposeSignAtlas(), []);

  useFrame(() => {
    const s = streamer.current;
    if (!s) return;
    camera.getWorldPosition(_cam);
    s.update(_cam.x, _cam.z, frame.time);

    // The night pass. Signs are already faintly lit at dusk (they come on
    // early, before the sun is properly down) and reach full output once the
    // sun is a few degrees under the horizon.
    sunDirection(frame.timeOfDay, _sun);
    const night = clamp01(1 - smoothstep(-0.09, 0.10, _sun.y));
    const target = 0.04 + night * 2.5;
    if (Math.abs(material.emissiveIntensity - target) > 0.004) {
      material.emissiveIntensity = target;
    }
    reportPending(s.pending);
  });

  return <group ref={group} name="sf-signage" />;
}
