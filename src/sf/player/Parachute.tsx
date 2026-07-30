/**
 * Parachute.tsx — the canopy.
 *
 * A ram-air seven-cell, because that is what you actually jump with and
 * because a rectangular wing is what makes the steering read: you can see the
 * left side load up when you pull a riser. It is drawn in world space above
 * and behind the player rather than parented to the camera, so looking around
 * under canopy shows you your own chute from a believable angle.
 *
 * Inflation is a single parameter driving three things at once — span, cell
 * depth and line tension — which is what makes the opening read as a snatch
 * rather than a scale animation. At `inflation = 0` the canopy is a folded
 * pencil trailing above you; by 1 it is a taut wing.
 *
 * Everything is one geometry, updated in place, plus one LineSegments for the
 * suspension lines. Two draw calls for the whole thing.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { WORLD_SEED } from "../config";
import { frame } from "../state/store";
import { clamp01, makeRng, smoothstep } from "../math/rng";
import { parachute } from "./parachute";

/** Samples across the span (7 cells × 2 + 1 rib each). */
const SPAN = 15;
/** Samples along the chord, nose to tail. */
const CHORD = 7;
const VERTS = SPAN * CHORD;

/** Full-size canopy, metres. A 210 sq ft nine-cell is about this. */
const CANOPY_SPAN = 5.6;
const CANOPY_CHORD = 2.5;
/** How far above the harness the canopy flies. */
const LINE_LENGTH = 4.6;
/** Attachment points per side of the cascade. */
const LINE_ROWS = 4;

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

function buildCanopy(): {
  geo: THREE.BufferGeometry;
  pos: Float32Array;
} {
  const pos = new Float32Array(VERTS * 3);
  const uv = new Float32Array(VERTS * 2);
  const col = new Float32Array(VERTS * 3);
  const idx: number[] = [];
  const rng = makeRng(`${WORLD_SEED}:canopy`);

  // Alternating cell colours with a little per-cell dye variation, the way a
  // real canopy is panelled. Nothing in this game is one flat colour.
  const cellHue: number[] = [];
  for (let c = 0; c < 8; c++) cellHue.push(rng.next());

  for (let i = 0; i < SPAN; i++) {
    const s = i / (SPAN - 1);
    const cell = Math.min(7, Math.floor(s * 7));
    for (let j = 0; j < CHORD; j++) {
      const c = j / (CHORD - 1);
      const k = i * CHORD + j;
      uv[k * 2] = s;
      uv[k * 2 + 1] = c;
      const dark = cell % 2 === 0;
      const h = cellHue[cell];
      // Charcoal and burnt-orange panels; the tail darkens where the fabric
      // is doubled over the trailing edge seam.
      const shade = 1 - c * 0.18;
      if (dark) {
        col[k * 3] = (0.10 + h * 0.05) * shade;
        col[k * 3 + 1] = (0.11 + h * 0.05) * shade;
        col[k * 3 + 2] = (0.14 + h * 0.06) * shade;
      } else {
        col[k * 3] = (0.72 + h * 0.18) * shade;
        col[k * 3 + 1] = (0.28 + h * 0.10) * shade;
        col[k * 3 + 2] = (0.09 + h * 0.05) * shade;
      }
    }
  }

  for (let i = 0; i < SPAN - 1; i++) {
    for (let j = 0; j < CHORD - 1; j++) {
      const a = i * CHORD + j;
      const b = a + 1;
      const c2 = a + CHORD;
      const d = c2 + 1;
      idx.push(a, c2, b, b, c2, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 12);
  return { geo, pos };
}

function buildLines(): { geo: THREE.BufferGeometry; pos: Float32Array } {
  // Two risers, each cascading to LINE_ROWS attachment points on its side.
  const segs = LINE_ROWS * 2 * 2;
  const pos = new Float32Array(segs * 2 * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 12);
  return { geo, pos };
}

/* ------------------------------------------------------------------ *
 * Scratch
 * ------------------------------------------------------------------ */

const _p = new THREE.Vector3();
const _centre = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, "YXZ");

export interface ParachuteViewProps {
  visible?: boolean;
}

export default function ParachuteView({ visible = true }: ParachuteViewProps) {
  const canopy = useMemo(buildCanopy, []);
  const lines = useMemo(buildLines, []);

  const fabric = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.86,
        metalness: 0,
        side: THREE.DoubleSide,
        transparent: true,
        // Nylon at this weight is faintly translucent against the sky, which
        // is most of why a canopy looks like fabric and not like plastic.
        opacity: 0.97,
      }),
    [],
  );

  const lineMat = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: new THREE.Color(0xbfc4cc),
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      }),
    [],
  );

  const groupRef = useRef<THREE.Group>(null);

  useEffect(
    () => () => {
      canopy.geo.dispose();
      lines.geo.dispose();
      fabric.dispose();
      lineMat.dispose();
    },
    [canopy, lines, fabric, lineMat],
  );

  useFrame(() => {
    const g = groupRef.current;
    if (!g) return;
    const infl = parachute.inflation;
    const on = visible && (parachute.active || infl > 0.02);
    g.visible = on;
    if (!on) return;

    /* ---- where the canopy flies ---- */
    // Directly above the harness, tilted back slightly, and lagging the
    // player's yaw so a turn shows the canopy swinging round after you.
    _euler.set(0, frame.yaw, 0);
    _q.setFromEuler(_euler);
    _fwd.set(0, 0, -1).applyQuaternion(_q);

    _origin.copy(frame.position);
    _origin.y += 0.6;

    const riseT = smoothstep(0, 1, infl);
    const height = LINE_LENGTH * (0.35 + 0.65 * riseT);
    _centre
      .copy(_origin)
      .addScaledVector(_fwd, -0.55 * riseT)
      .setY(_origin.y + height);

    g.position.copy(_centre);
    // Pitch: a canopy in a flare rocks nose-up, in a stall it collapses back.
    const pitch = -0.16 + parachute.flare * 0.34 - (parachute.stalled ? 0.5 : 0);
    _euler.set(pitch, frame.yaw, -parachute.bankRoll * 0.9);
    g.quaternion.setFromEuler(_euler);

    /* ---- canopy surface ---- */
    writeCanopy(canopy.pos, infl, frame.time, parachute.flare, parachute.stalled);
    (canopy.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    canopy.geo.computeVertexNormals();
    fabric.opacity = 0.55 + 0.42 * clamp01(infl);

    /* ---- suspension lines, in the group's local space ---- */
    writeLines(lines.pos, _centre, _origin, g.quaternion, infl);
    (lines.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  });

  return (
    <group frustumCulled={false}>
      <group ref={groupRef} frustumCulled={false}>
        <mesh geometry={canopy.geo} material={fabric} castShadow frustumCulled={false} />
        <lineSegments geometry={lines.geo} material={lineMat} frustumCulled={false} />
      </group>
    </group>
  );
}

/* ------------------------------------------------------------------ *
 * Vertex writers
 * ------------------------------------------------------------------ */

/**
 * The canopy surface, in the group's local frame (X span, Z chord, Y up).
 *
 * Inflation drives span, the anhedral arc and the cell depth together. Before
 * it opens the wing is a narrow, nearly flat streamer; at full inflation it is
 * an arched aerofoil with visible cell bulges between the ribs.
 */
function writeCanopy(
  pos: Float32Array,
  inflation: number,
  time: number,
  flare: number,
  stalled: boolean,
): void {
  const infl = clamp01(inflation);
  const span = CANOPY_SPAN * (0.14 + 0.86 * infl);
  const chord = CANOPY_CHORD * (0.3 + 0.7 * infl);
  // Anhedral: the tips hang below the centre. Deeper as it inflates.
  const arc = 0.9 * infl;
  const cellDepth = 0.24 * infl;
  const breathe = stalled ? 0.09 : 0.018 + flare * 0.03;

  for (let i = 0; i < SPAN; i++) {
    const s = i / (SPAN - 1);
    const sx = (s - 0.5) * span;
    // Seven cells: the bulge peaks between ribs and pinches at each one.
    const cellPhase = Math.sin(s * Math.PI * 7);
    for (let j = 0; j < CHORD; j++) {
      const c = j / (CHORD - 1);
      const k = (i * CHORD + j) * 3;

      // Aerofoil camber: thick near the nose, thin at the tail.
      const camber = Math.sin(c * Math.PI) * (1 - c * 0.55);
      const bulge = Math.abs(cellPhase) * cellDepth * camber;

      // Anhedral arc across the span.
      const dip = -((s - 0.5) * (s - 0.5)) * 4 * arc;

      // Slow breathing, plus a flutter along the tail.
      const wob =
        Math.sin(time * 1.7 + s * 3.1) * breathe +
        Math.sin(time * 6.3 + c * 4.0 + s * 5.2) * breathe * 0.4 * c;

      pos[k] = sx;
      pos[k + 1] = dip + bulge + wob;
      pos[k + 2] = (c - 0.35) * chord;
    }
  }
}

/**
 * Suspension lines, written in the canopy group's local space so they stay
 * attached when the canopy banks. The risers converge on the harness, which
 * lives below and behind in that same local frame.
 */
function writeLines(
  pos: Float32Array,
  canopyCentre: THREE.Vector3,
  harness: THREE.Vector3,
  canopyQuat: THREE.Quaternion,
  inflation: number,
): void {
  // Harness position expressed in canopy-local space.
  _p.copy(harness).sub(canopyCentre).applyQuaternion(_q.copy(canopyQuat).invert());
  const hx = _p.x;
  const hy = _p.y;
  const hz = _p.z;

  const infl = clamp01(inflation);
  const span = CANOPY_SPAN * (0.14 + 0.86 * infl);
  const chord = CANOPY_CHORD * (0.3 + 0.7 * infl);
  const arc = 0.9 * infl;

  let o = 0;
  for (let side = -1; side <= 1; side += 2) {
    // Riser shoulder: 22 cm out from the harness centreline.
    const rx = hx + side * 0.22;
    for (let r = 0; r < LINE_ROWS; r++) {
      // Attachment points march outboard along the span…
      const s = 0.5 + side * (0.12 + (r / (LINE_ROWS - 1)) * 0.36);
      const ax = (s - 0.5) * span;
      const ay = -((s - 0.5) * (s - 0.5)) * 4 * arc;
      // …and are cascaded fore and aft on the chord (A/B and C/D lines).
      for (let f = 0; f < 2; f++) {
        const c = f === 0 ? 0.12 : 0.72;
        const az = (c - 0.35) * chord;
        pos[o++] = rx;
        pos[o++] = hy;
        pos[o++] = hz;
        pos[o++] = ax;
        pos[o++] = ay;
        pos[o++] = az;
      }
    }
  }
}
