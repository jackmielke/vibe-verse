/**
 * Wingsuit.tsx — what flight looks like from inside the suit.
 *
 * Three things are drawn, and each exists for a reason the flight model alone
 * cannot deliver:
 *
 *  1. **The wings.** Two ram-air membranes at the periphery of vision, with
 *     the arms inside their leading edges. They are the only proof that the
 *     thing making you fly is strapped to you. The trailing edge ripples at a
 *     frequency set by airspeed and an amplitude set by how close the wing is
 *     to stalling — a wing that flutters when you pull too hard tells you
 *     you are about to fall out of the sky before the stall does.
 *
 *  2. **Speed streaks.** Static world-space lines that you fly *past*. This is
 *     the difference between a screen-space particle effect (which reads as a
 *     filter) and parallax (which reads as speed). They respawn ahead of the
 *     player and are stretched along the velocity vector.
 *
 *  3. **The pull-up chevrons.** A head-mounted warning that pulses harder the
 *     lower you get. `WINGSUIT.pullWarning` is 60 m, which at 90 m/s is about
 *     two thirds of a second — you need to be told, and you need to be told
 *     without reading text.
 *
 * All of it is one mesh per element, all geometry pre-allocated, all vertex
 * animation written into existing typed arrays.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { WINGSUIT, WORLD_SEED } from "../config";
import { frame } from "../state/store";
import { clamp01, makeRng, smoothstep } from "../math/rng";
import { wingsuit } from "./wingsuit";

/* ---- wing tessellation ---- */
const SPAN = 9; // samples along the arm
const CHORD = 5; // samples from leading to trailing edge
const WING_VERTS = SPAN * CHORD;

/* ---- streaks ---- */
const STREAKS = 320;
/** Radius of the cylinder streaks are seeded into, metres. */
const STREAK_RADIUS = 22;
/** Distance ahead of the player streaks are seeded at. */
const STREAK_AHEAD = 46;

/* ------------------------------------------------------------------ *
 * Wing surface
 * ------------------------------------------------------------------ */

/**
 * Parametric wing. `s` runs shoulder→tip, `c` runs leading edge→trailing edge.
 *
 * The shape is a real wingsuit's: the arm wing is a narrow triangle that
 * sweeps back sharply, so from inside the helmet you see a taut membrane
 * running from your shoulder out past the edge of your vision and back behind
 * your head.
 */
function wingPoint(side: number, s: number, c: number, out: THREE.Vector3): void {
  // Chord grows toward the shoulder — the membrane is widest at the body.
  const chordLen = 0.34 + (1 - s) * 0.62;
  const sweep = s * s * 0.55;
  out.x = side * (0.26 + s * 1.42 - c * 0.10 * s);
  out.y = -0.20 - s * 0.26 - c * chordLen * 0.30 - s * s * 0.10;
  out.z = -0.34 + s * 0.30 + sweep + c * chordLen * 1.05;
}

function buildWingGeometry(side: number): {
  geo: THREE.BufferGeometry;
  base: Float32Array;
  pos: Float32Array;
} {
  const base = new Float32Array(WING_VERTS * 3);
  const pos = new Float32Array(WING_VERTS * 3);
  const uv = new Float32Array(WING_VERTS * 2);
  const col = new Float32Array(WING_VERTS * 3);
  const idx: number[] = [];
  const p = new THREE.Vector3();

  for (let i = 0; i < SPAN; i++) {
    const s = i / (SPAN - 1);
    for (let j = 0; j < CHORD; j++) {
      const c = j / (CHORD - 1);
      wingPoint(side, s, c, p);
      const v = (i * CHORD + j) * 3;
      base[v] = p.x;
      base[v + 1] = p.y;
      base[v + 2] = p.z;
      uv[(i * CHORD + j) * 2] = s;
      uv[(i * CHORD + j) * 2 + 1] = c;
      // A high-visibility stripe down the leading edge, the way jump suits
      // are actually marked, plus a wash of darkening toward the trailing
      // edge where the fabric is doubled.
      const stripe = smoothstep(0.22, 0.08, c);
      const wear = 1 - c * 0.22;
      col[(i * CHORD + j) * 3] = (0.11 + stripe * 0.86) * wear;
      col[(i * CHORD + j) * 3 + 1] = (0.12 + stripe * 0.40) * wear;
      col[(i * CHORD + j) * 3 + 2] = (0.15 + stripe * 0.06) * wear;
    }
  }
  pos.set(base);

  for (let i = 0; i < SPAN - 1; i++) {
    for (let j = 0; j < CHORD - 1; j++) {
      const a = i * CHORD + j;
      const b = a + 1;
      const c2 = a + CHORD;
      const d = c2 + 1;
      // Wind the two sides opposite so the front faces point outward.
      if (side > 0) idx.push(a, c2, b, b, c2, d);
      else idx.push(a, b, c2, b, d, c2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 4);
  return { geo, base, pos };
}

/**
 * Ripstop nylon normal map. The grid of reinforcing threads every few
 * millimetres is the single detail that reads as "technical fabric" rather
 * than "flat coloured surface".
 */
function makeRipstopNormal(): THREE.DataTexture {
  const N = 64;
  const data = new Uint8Array(N * N * 4);
  const rng = makeRng(`${WORLD_SEED}:wingsuit-ripstop`);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      // Ripstop grid every 8 texels, weave noise everywhere.
      const gx = x % 8 === 0 ? 1 : 0;
      const gy = y % 8 === 0 ? 1 : 0;
      const weave = Math.sin(x * 1.9) * 0.06 + Math.sin(y * 2.1) * 0.06;
      let nx = gx * 0.42 - gy * 0.05 + weave + (rng.next() - 0.5) * 0.05;
      let ny = gy * 0.42 - gx * 0.05 + weave + (rng.next() - 0.5) * 0.05;
      let nz = 1;
      const l = Math.hypot(nx, ny, nz);
      data[i] = Math.round((nx / l * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny / l * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz / l * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(5, 3);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** The arm inside the leading edge: shoulder, forearm, glove. */
function buildArmGeometry(side: number): THREE.BufferGeometry {
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  const parts: THREE.BufferGeometry[] = [];
  const segs: [number, number, number, number][] = [
    [0.0, 0.34, 0.075, 0.055],
    [0.34, 0.74, 0.055, 0.042],
    [0.74, 1.0, 0.042, 0.036],
  ];
  for (const [s0, s1, r0, r1] of segs) {
    wingPoint(side, s0, 0, p);
    wingPoint(side, s1, 0, q);
    const len = p.distanceTo(q);
    const g = new THREE.CylinderGeometry(r1, r0, len, 7, 1);
    // Orient the cylinder along the segment, then move it into place.
    const dir = q.clone().sub(p).normalize();
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    g.applyQuaternion(quat);
    g.translate((p.x + q.x) * 0.5, (p.y + q.y) * 0.5, (p.z + q.z) * 0.5);
    parts.push(g);
  }
  const merged = mergeParts(parts);
  for (const g of parts) g.dispose();
  return merged;
}

function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vc = 0;
  let ic = 0;
  for (const p of parts) {
    vc += p.getAttribute("position").count;
    ic += p.getIndex()!.count;
  }
  const pos = new Float32Array(vc * 3);
  const nor = new Float32Array(vc * 3);
  const uv = new Float32Array(vc * 2);
  const idx = new Uint16Array(ic);
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    const pp = p.getAttribute("position") as THREE.BufferAttribute;
    const pn = p.getAttribute("normal") as THREE.BufferAttribute;
    const pu = p.getAttribute("uv") as THREE.BufferAttribute;
    pos.set(pp.array as Float32Array, vo * 3);
    nor.set(pn.array as Float32Array, vo * 3);
    uv.set(pu.array as Float32Array, vo * 2);
    const pi = p.getIndex()!;
    for (let i = 0; i < pi.count; i++) idx[io + i] = pi.getX(i) + vo;
    io += pi.count;
    vo += pp.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
  return geo;
}

/* ------------------------------------------------------------------ *
 * Scratch
 * ------------------------------------------------------------------ */

const _dir = new THREE.Vector3();
const _sideV = new THREE.Vector3();
const _upV = new THREE.Vector3();
const _AXIS_X = new THREE.Vector3(1, 0, 0);
const _AXIS_Y = new THREE.Vector3(0, 1, 0);

export interface WingsuitViewProps {
  visible?: boolean;
}

export default function WingsuitView({ visible = true }: WingsuitViewProps) {
  const camera = useThree((s) => s.camera);

  const left = useMemo(() => buildWingGeometry(-1), []);
  const right = useMemo(() => buildWingGeometry(1), []);
  const armL = useMemo(() => buildArmGeometry(-1), []);
  const armR = useMemo(() => buildArmGeometry(1), []);
  const ripstop = useMemo(makeRipstopNormal, []);

  const fabric = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.78,
        metalness: 0.02,
        normalMap: ripstop,
        normalScale: new THREE.Vector2(0.7, 0.7),
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 1,
      }),
    [ripstop],
  );

  const armMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(0x1b1e24),
        roughness: 0.62,
        metalness: 0.08,
        transparent: true,
      }),
    [],
  );

  /* ---- speed streaks ---- */
  const streaks = useMemo(() => {
    const pos = new Float32Array(STREAKS * 2 * 3);
    const col = new Float32Array(STREAKS * 2 * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    // Seeded seed points inside a cylinder around the flight path.
    const rng = makeRng(`${WORLD_SEED}:wingsuit-streaks`);
    const seeds = new Float32Array(STREAKS * 3);
    for (let i = 0; i < STREAKS; i++) {
      const a = rng.next() * Math.PI * 2;
      const r = Math.sqrt(rng.next()) * STREAK_RADIUS;
      seeds[i * 3] = Math.cos(a) * r;
      seeds[i * 3 + 1] = Math.sin(a) * r;
      seeds[i * 3 + 2] = rng.next();
    }
    const world = new Float32Array(STREAKS * 3);
    return { geo, pos, col, seeds, world, seeded: { value: false } };
  }, []);

  const streakMat = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 1,
      }),
    [],
  );

  /* ---- pull-up chevrons ---- */
  const chevron = useMemo(() => {
    // Two nested arrowheads pointing up, sitting just below the crosshair.
    const shape = new THREE.Shape();
    shape.moveTo(-0.09, -0.02);
    shape.lineTo(0, 0.05);
    shape.lineTo(0.09, -0.02);
    shape.lineTo(0.075, -0.045);
    shape.lineTo(0, 0.012);
    shape.lineTo(-0.075, -0.045);
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    return geo;
  }, []);

  const chevronMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(0xff5a3c),
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    [],
  );

  const rootRef = useRef<THREE.Group>(null);
  const wingLRef = useRef<THREE.Mesh>(null);
  const wingRRef = useRef<THREE.Mesh>(null);
  const chevRef = useRef<THREE.Group>(null);

  useEffect(
    () => () => {
      left.geo.dispose();
      right.geo.dispose();
      armL.dispose();
      armR.dispose();
      ripstop.dispose();
      fabric.dispose();
      armMat.dispose();
      streaks.geo.dispose();
      streakMat.dispose();
      chevron.dispose();
      chevronMat.dispose();
    },
    [left, right, armL, armR, ripstop, fabric, armMat, streaks, streakMat, chevron, chevronMat],
  );

  useFrame((_, delta) => {
    const root = rootRef.current;
    if (!root) return;
    const dt = Math.min(delta, 1 / 15);

    // Deploy blend: the wings fade and swing out as the suit inflates rather
    // than popping into existence.
    const on = visible && wingsuit.active;
    const t = clamp01(wingsuit.deployT / 0.42);
    const open = on ? t * t * (3 - 2 * t) : 0;
    root.visible = open > 0.01;
    fabric.opacity = open;
    armMat.opacity = open;

    if (root.visible) {
      // Sit on the camera. Copying the transform (rather than parenting to the
      // camera) keeps this out of the camera's child list, which matters
      // because the post pipeline reparents the camera.
      root.position.copy(camera.position);
      root.quaternion.copy(camera.quaternion);

      // The suit rolls a little later than the camera does, so a hard bank
      // shows you the top surface of the inside wing for a beat.
      const lag = -wingsuit.bankRoll * 0.22;
      root.rotateZ(lag);
      // And it pitches with angle of attack: at high AoA you see more wing.
      root.rotateX(-wingsuit.aoa * 0.35);

      const speedT = clamp01(
        (wingsuit.airspeed - WINGSUIT.stallSpeed * 0.5) /
          (WINGSUIT.maxSpeed - WINGSUIT.stallSpeed * 0.5),
      );
      // Flutter: frequency with speed, amplitude with stall. A wing about to
      // let go shakes; a clean wing at 90 m/s is almost rigid.
      const flutterAmp = 0.004 + wingsuit.stall * 0.05 + (1 - speedT) * 0.012;
      const flutterHz = 9 + speedT * 26;
      rippleWing(left, frame.time, flutterAmp, flutterHz, -1, wingsuit.bankRoll);
      rippleWing(right, frame.time, flutterAmp, flutterHz, 1, wingsuit.bankRoll);
      if (wingLRef.current) {
        (wingLRef.current.geometry.getAttribute("position") as THREE.BufferAttribute)
          .needsUpdate = true;
      }
      if (wingRRef.current) {
        (wingRRef.current.geometry.getAttribute("position") as THREE.BufferAttribute)
          .needsUpdate = true;
      }
    }

    /* ---- streaks ---- */
    updateStreaks(streaks, dt, on ? wingsuit.rush : 0);
    (streaks.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (streaks.geo.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;

    /* ---- warning ---- */
    const chev = chevRef.current;
    if (chev) {
      const w = on ? wingsuit.warning : 0;
      chev.visible = w > 0.02;
      if (chev.visible) {
        chev.position.copy(camera.position);
        chev.quaternion.copy(camera.quaternion);
        chev.translateZ(-0.55);
        chev.translateY(-0.055);
        // Pulse rate rises as the ground does — a rhythm you feel before you
        // consciously read it.
        const hz = 2.5 + w * 7;
        const pulse = 0.5 + 0.5 * Math.sin(frame.time * hz * Math.PI * 2);
        chevronMat.opacity = w * (0.35 + pulse * 0.65);
        const s = 1 + pulse * 0.12 * w;
        chev.scale.set(s, s, 1);
      } else {
        chevronMat.opacity = 0;
      }
    }
  });

  return (
    <>
      <group ref={rootRef} frustumCulled={false} renderOrder={4}>
        <mesh ref={wingLRef} geometry={left.geo} material={fabric} frustumCulled={false} />
        <mesh ref={wingRRef} geometry={right.geo} material={fabric} frustumCulled={false} />
        <mesh geometry={armL} material={armMat} frustumCulled={false} />
        <mesh geometry={armR} material={armMat} frustumCulled={false} />
      </group>
      <lineSegments
        geometry={streaks.geo}
        material={streakMat}
        frustumCulled={false}
        renderOrder={3}
      />
      <group ref={chevRef} frustumCulled={false} renderOrder={20}>
        <mesh geometry={chevron} material={chevronMat} frustumCulled={false} />
      </group>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Vertex animation
 * ------------------------------------------------------------------ */

/**
 * Displace the membrane.
 *
 * The wave runs from the leading edge back, so the trailing edge moves most —
 * which is exactly how a ram-air surface behaves, and it means the leading
 * edge stays pinned to the arm geometry without any explicit constraint.
 */
function rippleWing(
  wing: { base: Float32Array; pos: Float32Array },
  time: number,
  amp: number,
  hz: number,
  side: number,
  bank: number,
): void {
  const { base, pos } = wing;
  for (let i = 0; i < SPAN; i++) {
    const s = i / (SPAN - 1);
    for (let j = 0; j < CHORD; j++) {
      const c = j / (CHORD - 1);
      const v = (i * CHORD + j) * 3;
      // Chordwise envelope: zero at the arm, maximum at the trailing edge.
      const env = c * c;
      const w =
        Math.sin((time * hz + s * 3.1 + c * 2.2) * Math.PI * 2) * 0.7 +
        Math.sin((time * hz * 0.61 + s * 5.7) * Math.PI * 2) * 0.3;
      const d = w * amp * env * (0.5 + s * 0.5);
      // Banking loads the inside wing and slackens the outside one.
      const load = 1 + side * bank * 0.35;
      pos[v] = base[v];
      pos[v + 1] = base[v + 1] + d * load;
      pos[v + 2] = base[v + 2] + d * 0.35;
    }
  }
}

/**
 * March the streaks.
 *
 * They are world-static: the player moves past them, which is the whole point.
 * When one falls behind or drifts too far off the flight path it is recycled
 * to a fresh position ahead, using a fixed seeded offset table so the
 * distribution never clumps and never needs `Math.random`.
 */
function updateStreaks(
  s: {
    pos: Float32Array;
    col: Float32Array;
    seeds: Float32Array;
    world: Float32Array;
    seeded: { value: boolean };
  },
  _dt: number,
  rush: number,
): void {
  const { pos, col, seeds, world } = s;
  const px = frame.position.x;
  const py = frame.position.y;
  const pz = frame.position.z;
  const speed = frame.speed;

  if (rush <= 0.01) {
    // Collapse to nothing rather than fade — an almost-invisible streak field
    // is more distracting than none.
    for (let i = 0; i < STREAKS * 2 * 3; i++) pos[i] = 0;
    for (let i = 0; i < STREAKS * 2 * 3; i++) col[i] = 0;
    s.seeded.value = false;
    return;
  }

  _dir.copy(frame.velocity);
  const vlen = _dir.length();
  if (vlen < 1e-3) return;
  _dir.multiplyScalar(1 / vlen);

  // An orthonormal frame around the flight path to scatter seeds into.
  _sideV.crossVectors(_dir, Math.abs(_dir.y) > 0.94 ? _AXIS_X : _AXIS_Y).normalize();
  _upV.crossVectors(_sideV, _dir).normalize();

  const len = Math.min(4.5, 0.35 + speed * 0.055);
  const bright = rush * 0.85;

  for (let i = 0; i < STREAKS; i++) {
    const wi = i * 3;
    let dx = world[wi] - px;
    let dy = world[wi + 1] - py;
    let dz = world[wi + 2] - pz;
    const ahead = dx * _dir.x + dy * _dir.y + dz * _dir.z;
    const dist2 = dx * dx + dy * dy + dz * dz;

    if (!s.seeded.value || ahead < -6 || dist2 > STREAK_AHEAD * STREAK_AHEAD * 2.6) {
      const a = seeds[wi];
      const b = seeds[wi + 1];
      const t = seeds[wi + 2];
      const fwd = 8 + t * STREAK_AHEAD;
      world[wi] = px + _dir.x * fwd + _sideV.x * a + _upV.x * b;
      world[wi + 1] = py + _dir.y * fwd + _sideV.y * a + _upV.y * b;
      world[wi + 2] = pz + _dir.z * fwd + _sideV.z * a + _upV.z * b;
      dx = world[wi] - px;
      dy = world[wi + 1] - py;
      dz = world[wi + 2] - pz;
    }

    const p0 = i * 6;
    pos[p0] = world[wi];
    pos[p0 + 1] = world[wi + 1];
    pos[p0 + 2] = world[wi + 2];
    pos[p0 + 3] = world[wi] - _dir.x * len;
    pos[p0 + 4] = world[wi + 1] - _dir.y * len;
    pos[p0 + 5] = world[wi + 2] - _dir.z * len;

    // Fade with distance so nothing pops in at the seed radius.
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const a = bright * (1 - clamp01(d / (STREAK_AHEAD * 1.4)));
    col[p0] = a * 0.75;
    col[p0 + 1] = a * 0.85;
    col[p0 + 2] = a;
    col[p0 + 3] = 0;
    col[p0 + 4] = 0;
    col[p0 + 5] = 0;
  }
  s.seeded.value = true;
}
