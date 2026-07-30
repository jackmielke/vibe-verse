/**
 * Grapple.tsx — the cable and the hook, drawn.
 *
 * A grapple that renders as a stretched line is the tell that a game's
 * traversal is a script rather than a simulation. So this draws a real tube:
 * a swept hexagonal cross-section along a catenary that sags when the rope is
 * slack, pulls straight and thins when it loads, and rings with a decaying
 * transverse standing wave when the hook first bites or the rope snaps taut.
 *
 * Everything — every player tether and every object↔object link — lives in a
 * *single* BufferGeometry and therefore a single draw call. Positions, normals
 * and UVs are rewritten in place each frame into pre-allocated typed arrays;
 * inactive cables collapse to a degenerate point far below the world instead
 * of being removed, because rebuilding index buffers at 60 Hz to save six
 * hundred triangles would be a poor trade.
 *
 * The braid is a generated normal map rather than geometry. At the diameter of
 * a grapple cable, twisted-strand relief is a lighting effect, not a
 * silhouette, and this way the whole thing stays one 3 KB texture.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { GRAPPLE, WORLD_SEED } from "../config";
import { makeRng } from "../math/rng";
import { MAX_WORLD_TETHERS, grappleSystem } from "./grapple";

/** Rings along each cable. 26 is enough for a 240 m arc to read as a curve. */
const SEGMENTS = 26;
/** Sides of the swept cross-section. Six reads as round at this diameter. */
const RADIAL = 6;
const CABLE_COUNT = GRAPPLE.maxTethers + MAX_WORLD_TETHERS;
/** Player hooks bite one end; a world link has a hook buried at both ends. */
const HOOK_COUNT = GRAPPLE.maxTethers + MAX_WORLD_TETHERS * 2;
const VERTS_PER_CABLE = SEGMENTS * RADIAL;
const TOTAL_VERTS = CABLE_COUNT * VERTS_PER_CABLE;

/** Cable radius, metres. A real 8 mm winch cable, slightly flattered. */
const CABLE_RADIUS = 0.036;
/** Somewhere far below the world where degenerate cables go to hide. */
const HIDDEN_Y = -20000;

/* ------------------------------------------------------------------ *
 * Generated textures
 * ------------------------------------------------------------------ */

/**
 * A braided-steel normal map.
 *
 * Three helical strands running along V, with a fine wire twist inside each
 * and a seeded scatter of nicks and burnish. Tangent-space, so the tube's UV
 * layout (U around, V along) does the rest.
 */
function makeBraidNormal(): THREE.DataTexture {
  const W = 32;
  const H = 96;
  const data = new Uint8Array(W * H * 4);
  const rng = makeRng(`${WORLD_SEED}:grapple-braid`);
  // Pre-roll the wear field so the pattern is stable across reloads.
  const wear = new Float32Array(W * H);
  for (let i = 0; i < wear.length; i++) wear[i] = rng.next();

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const v = y / H;
      // Three strands, each wrapping once every 1/3 of the tile.
      const phase = (u + v * 3) % 1;
      const strand = Math.sin(phase * Math.PI * 3) ;
      const dU = Math.cos(phase * Math.PI * 3) * 0.85;
      // Fine wires inside the strand.
      const fine = Math.sin((u * 18 + v * 26) * Math.PI) * 0.18;
      const i = (y * W + x) * 4;
      const nick = (wear[i >> 2] - 0.5) * 0.16;
      let nx = dU * 0.7 + fine + nick;
      let ny = strand * 0.22 + nick * 0.4;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

function buildCableGeometry(): {
  geo: THREE.BufferGeometry;
  pos: Float32Array;
  nor: Float32Array;
  uv: Float32Array;
} {
  const pos = new Float32Array(TOTAL_VERTS * 3);
  const nor = new Float32Array(TOTAL_VERTS * 3);
  const uv = new Float32Array(TOTAL_VERTS * 2);
  const idx: number[] = [];
  for (let c = 0; c < CABLE_COUNT; c++) {
    const base = c * VERTS_PER_CABLE;
    for (let s = 0; s < SEGMENTS - 1; s++) {
      for (let r = 0; r < RADIAL; r++) {
        const r2 = (r + 1) % RADIAL;
        const a = base + s * RADIAL + r;
        const b = base + s * RADIAL + r2;
        const cc = base + (s + 1) * RADIAL + r;
        const d = base + (s + 1) * RADIAL + r2;
        idx.push(a, cc, b, b, cc, d);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  // The cable spans the whole city; culling it against a stale bounding
  // volume would pop it out at exactly the moment it matters.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return { geo, pos, nor, uv };
}

/**
 * The hook itself: a tapered shaft, a spike and three swept-back flukes.
 * Merged into one geometry so all six live in a single InstancedMesh.
 */
function buildHookGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const shaft = new THREE.CylinderGeometry(0.038, 0.052, 0.26, 8, 1);
  shaft.rotateX(Math.PI * 0.5);
  shaft.translate(0, 0, -0.13);
  parts.push(shaft);

  const spike = new THREE.ConeGeometry(0.04, 0.20, 8);
  spike.rotateX(-Math.PI * 0.5);
  spike.translate(0, 0, 0.1);
  parts.push(spike);

  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const fluke = new THREE.CylinderGeometry(0.012, 0.022, 0.17, 5, 1);
    // Swept back and outward, the way a real grapnel fluke sits.
    fluke.rotateZ(0.85);
    fluke.rotateY(-Math.PI * 0.5);
    fluke.translate(0.055, 0, -0.045);
    fluke.rotateZ(a);
    parts.push(fluke);
  }

  const merged = mergeSimple(parts);
  for (const p of parts) p.dispose();
  return merged;
}

/**
 * Minimal position/normal/uv merge. `BufferGeometryUtils.mergeGeometries` is
 * available, but these are five primitives with identical attribute sets and
 * doing it by hand keeps this file free of an examples/jsm import.
 */
function mergeSimple(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vCount = 0;
  let iCount = 0;
  for (const p of parts) {
    vCount += p.getAttribute("position").count;
    iCount += p.getIndex() ? p.getIndex()!.count : p.getAttribute("position").count;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const idx = new Uint16Array(iCount);
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    const pp = p.getAttribute("position") as THREE.BufferAttribute;
    const pn = p.getAttribute("normal") as THREE.BufferAttribute;
    const pu = p.getAttribute("uv") as THREE.BufferAttribute | undefined;
    pos.set(pp.array as Float32Array, vo * 3);
    nor.set(pn.array as Float32Array, vo * 3);
    if (pu) uv.set(pu.array as Float32Array, vo * 2);
    const pi = p.getIndex();
    if (pi) {
      for (let i = 0; i < pi.count; i++) idx[io + i] = pi.getX(i) + vo;
      io += pi.count;
    } else {
      for (let i = 0; i < pp.count; i++) idx[io + i] = i + vo;
      io += pp.count;
    }
    vo += pp.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}

/* ------------------------------------------------------------------ *
 * Scratch
 * ------------------------------------------------------------------ */

const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3();
const _p = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _WORLD_UP = new THREE.Vector3(0, 1, 0);
const _WORLD_X = new THREE.Vector3(1, 0, 0);
const _HOOK_FWD = new THREE.Vector3(0, 0, 1);

export interface GrappleViewProps {
  /** Hide the cable in photo mode or during a cutscene. */
  visible?: boolean;
}

export default function GrappleView({ visible = true }: GrappleViewProps) {
  const cable = useMemo(buildCableGeometry, []);
  const hookGeo = useMemo(buildHookGeometry, []);
  const braid = useMemo(makeBraidNormal, []);

  const cableMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        // Galvanised steel that has been dragged over a lot of concrete.
        color: new THREE.Color(0x2b2e33),
        roughness: 0.52,
        metalness: 0.88,
        normalMap: braid,
        normalScale: new THREE.Vector2(1.15, 1.15),
        envMapIntensity: 1.1,
      }),
    [braid],
  );

  const hookMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(0x4a4d54),
        roughness: 0.34,
        metalness: 1,
        envMapIntensity: 1.25,
      }),
    [],
  );

  const cableRef = useRef<THREE.Mesh>(null);
  const hookRef = useRef<THREE.InstancedMesh>(null);

  useEffect(
    () => () => {
      cable.geo.dispose();
      hookGeo.dispose();
      braid.dispose();
      cableMat.dispose();
      hookMat.dispose();
    },
    [cable, hookGeo, braid, cableMat, hookMat],
  );

  useFrame(() => {
    const mesh = cableRef.current;
    const hooks = hookRef.current;
    if (!mesh || !hooks) return;

    let cursor = 0;
    let hookCursor = 0;

    /* ---- player tethers ---- */
    for (const t of grappleSystem.tethers) {
      const s = t.shared;
      if (!visible || !s.active) {
        hideCable(cable.pos, cursor++);
        continue;
      }
      _from.copy(t.muzzle);
      _to.copy(t.hook);
      const slack = Math.max(0, s.length - _from.distanceTo(_to));
      writeCable(
        cable,
        cursor++,
        _from,
        _to,
        slack,
        t.tension,
        t.vibration,
        t.vibPhase,
      );
      // The hook points along the cable while it flies and buries itself
      // nose-first once it bites.
      _tan.copy(_to).sub(_from);
      writeHook(hooks, hookCursor++, _to, _tan, s.flying ? 1 : 1.15);
    }

    /* ---- object↔object links ---- */
    for (const w of grappleSystem.worldTethers) {
      if (!visible || !w.active) {
        hideCable(cable.pos, cursor++);
        continue;
      }
      _from.copy(w.a.world);
      _to.copy(w.b.world);
      const slack = Math.max(0, w.rest - _from.distanceTo(_to));
      writeCable(cable, cursor++, _from, _to, slack, w.tension, w.vibration, w.vibPhase);
      _tan.copy(_to).sub(_from);
      writeHook(hooks, hookCursor++, _to, _tan, 1);
      if (hookCursor < HOOK_COUNT) {
        _tan.copy(_from).sub(_to);
        writeHook(hooks, hookCursor++, _from, _tan, 1);
      }
    }

    for (let i = hookCursor; i < HOOK_COUNT; i++) hideHook(hooks, i);

    const posAttr = cable.geo.getAttribute("position") as THREE.BufferAttribute;
    const norAttr = cable.geo.getAttribute("normal") as THREE.BufferAttribute;
    const uvAttr = cable.geo.getAttribute("uv") as THREE.BufferAttribute;
    posAttr.needsUpdate = true;
    norAttr.needsUpdate = true;
    uvAttr.needsUpdate = true;
    hooks.instanceMatrix.needsUpdate = true;
  });

  return (
    <group frustumCulled={false}>
      <mesh
        ref={cableRef}
        geometry={cable.geo}
        material={cableMat}
        frustumCulled={false}
        castShadow={false}
        receiveShadow={false}
      />
      <instancedMesh
        ref={hookRef}
        args={[hookGeo, hookMat, HOOK_COUNT]}
        frustumCulled={false}
        castShadow
      />
    </group>
  );
}

/* ------------------------------------------------------------------ *
 * Writers — allocation-free, called once per cable per frame
 * ------------------------------------------------------------------ */

function hideCable(pos: Float32Array, index: number): void {
  const base = index * VERTS_PER_CABLE * 3;
  for (let i = 0; i < VERTS_PER_CABLE; i++) {
    pos[base + i * 3] = 0;
    pos[base + i * 3 + 1] = HIDDEN_Y;
    pos[base + i * 3 + 2] = 0;
  }
}

/**
 * Sweep one cable.
 *
 * `slack` is how much rope is longer than the straight-line distance, and
 * drives the catenary sag. `tension` 0..1 straightens and thins it — under
 * load a real cable visibly narrows. `vibration` and `phase` add a standing
 * wave with a node at each end, which is what a rope actually does when a
 * hook lands.
 */
function writeCable(
  cable: { pos: Float32Array; nor: Float32Array; uv: Float32Array },
  index: number,
  from: THREE.Vector3,
  to: THREE.Vector3,
  slack: number,
  tension: number,
  vibration: number,
  phase: number,
): void {
  const { pos, nor, uv } = cable;
  const base = index * VERTS_PER_CABLE;

  _tan.copy(to).sub(from);
  const dist = _tan.length();
  if (dist < 1e-4) {
    hideCable(pos, index);
    return;
  }
  _tan.multiplyScalar(1 / dist);

  // A stable frame: pick whichever world axis is least parallel to the cable.
  const ref = Math.abs(_tan.y) > 0.94 ? _WORLD_X : _WORLD_UP;
  _side.crossVectors(_tan, ref).normalize();
  _up.crossVectors(_side, _tan).normalize();

  // Natural droop even when taut, plus the slack the simulation reports.
  const sag = (slack * 0.42 + dist * 0.008) * (1 - tension * 0.85);
  const radius = CABLE_RADIUS * (1 - tension * 0.22);
  // Texture density: one braid tile every 0.35 m, so the twist rate does not
  // change when the rope stretches.
  const vScale = dist / 0.35;
  const amp = vibration * Math.min(1, dist * 0.06);

  for (let s = 0; s < SEGMENTS; s++) {
    const t = s / (SEGMENTS - 1);
    _p.lerpVectors(from, to, t);
    // 4t(1-t) is a parabola pinned at both ends — a close enough catenary at
    // these sags, and far cheaper than cosh.
    _p.y -= sag * 4 * t * (1 - t);

    if (amp > 1e-4) {
      const env = Math.sin(t * Math.PI);
      const a = amp * env;
      _p.addScaledVector(_side, Math.sin(t * Math.PI * 3 + phase) * a);
      _p.addScaledVector(_up, Math.cos(t * Math.PI * 2 + phase * 1.31) * a * 0.6);
    }

    for (let r = 0; r < RADIAL; r++) {
      const ang = (r / RADIAL) * Math.PI * 2;
      const cx = Math.cos(ang);
      const sy = Math.sin(ang);
      const nx = _side.x * cx + _up.x * sy;
      const ny = _side.y * cx + _up.y * sy;
      const nz = _side.z * cx + _up.z * sy;
      const vi = (base + s * RADIAL + r) * 3;
      pos[vi] = _p.x + nx * radius;
      pos[vi + 1] = _p.y + ny * radius;
      pos[vi + 2] = _p.z + nz * radius;
      nor[vi] = nx;
      nor[vi + 1] = ny;
      nor[vi + 2] = nz;
      const ui = (base + s * RADIAL + r) * 2;
      uv[ui] = r / RADIAL;
      uv[ui + 1] = t * vScale;
    }
  }
}

function writeHook(
  hooks: THREE.InstancedMesh,
  index: number,
  at: THREE.Vector3,
  dir: THREE.Vector3,
  scale: number,
): void {
  if (index >= hooks.count) return;
  const l = dir.length();
  if (l < 1e-5) {
    hideHook(hooks, index);
    return;
  }
  dir.multiplyScalar(1 / l);
  _q.setFromUnitVectors(_HOOK_FWD, dir);
  _scale.set(scale, scale, scale);
  _m.compose(at, _q, _scale);
  hooks.setMatrixAt(index, _m);
}

function hideHook(hooks: THREE.InstancedMesh, index: number): void {
  if (index >= hooks.count) return;
  _q.identity();
  _scale.set(0, 0, 0);
  _p.set(0, HIDDEN_Y, 0);
  _m.compose(_p, _q, _scale);
  hooks.setMatrixAt(index, _m);
}
