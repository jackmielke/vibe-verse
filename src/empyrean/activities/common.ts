/**
 * The furniture every activity in The Empyrean shares.
 *
 * Three kinds of thing live here and nothing else:
 *
 *  - **Storage that cannot throw.** Private-mode Safari has a `localStorage`
 *    that exists, answers `getItem`, and throws on `setItem`. A world that
 *    loses its race records is sad; a world that white-screens because it
 *    could not save one is broken. Every read and every write goes through
 *    `readStore`/`writeStore` and every one of them is wrapped.
 *  - **Where the rock is.** Races, viewpoints and collectibles are all placed
 *    by hand against real geometry, and the one piece of geometry that is not
 *    in `cityplan.ts` is the keel. `keelBlocked` is a deliberately *pessimistic*
 *    envelope of it — the analytic worst case of `keel.ts`'s own profile, plus
 *    the annulus its stalactites can reach into — so a point this function
 *    calls clear is clear no matter how the noise lands. It is authoring-time
 *    and test-time only; nothing calls it in a frame.
 *  - **The gizmos.** Gates, pillars of light, picture frames and route lines.
 *    One module builds them so all four activities look like they come from
 *    the same place, and so there is one list of geometries and materials to
 *    dispose.
 *
 * This file may import `types.ts`, `config.ts`, `cityplan.ts` and `three` and
 * that is all — the same rule every other system in this directory follows.
 */
import * as THREE from "three";
import type { Toast } from "../types";
import { DECKS, ISLAND_Y, KEEL_DEPTH, PLATEAU_R } from "../config";
import { cityPlan, surfaceAt, LANDMARKS, type Lot, type Vec2 } from "../cityplan";

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

/* -------------------------------------------------------------------------
 * Little maths
 * ---------------------------------------------------------------------- */

/** A point in the island's polar frame. `a` is degrees, counter-clockwise. */
export function polar(r: number, aDeg: number, y: number): THREE.Vector3 {
  const a = aDeg * DEG;
  return new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** "1:04.2" over a minute, "34.7s" under it. Race clocks and nothing else. */
export function formatTime(sec: number): string {
  if (!Number.isFinite(sec)) return "—";
  const s = Math.max(0, sec);
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? "0" : ""}${r.toFixed(1)}`;
}

/** "820 m" / "1.2 km". Distances a player reads while moving at 30 m/s. */
export function formatDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

/* -------------------------------------------------------------------------
 * Storage that cannot throw
 * ---------------------------------------------------------------------- */

export function readStore<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

export function writeStore(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Private mode, a full quota, or no window at all. Play on. */
  }
}

/* -------------------------------------------------------------------------
 * Toasts
 * ---------------------------------------------------------------------- */

/**
 * The notification stack, one side of it.
 *
 * The engine drains this every frame and counts the TTLs down itself, so the
 * activities never own a timer and a toast raised on the frame the world is
 * torn down goes nowhere instead of into a dead React tree.
 */
export class Toaster {
  private queue: Toast[] = [];
  private nextId = 1;

  push(text: string, tone: Toast["tone"] = "info", ttl = 3.6): void {
    // A hard cap: an activity in a bad loop must not be able to allocate
    // without bound between two drains.
    if (this.queue.length > 12) this.queue.shift();
    this.queue.push({ id: this.nextId++, text, ttl, tone });
  }

  /**
   * Hand the queue over and start a new one.
   *
   * A *fresh* array every time, including when it is empty. Returning one
   * shared empty array would be cheaper and is a trap: the engine owns what it
   * is given and counts TTLs down in it, so a shared array would come back on
   * the next drain with the last frame's toasts still in it.
   */
  drain(): Toast[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }
}

/* -------------------------------------------------------------------------
 * Where the buildings are
 * ---------------------------------------------------------------------- */

export function pointInPoly(poly: Vec2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (
      a.z > z !== b.z > z &&
      x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z || 1e-9) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** Shortest distance from (x, z) to a lot's outline. Negative-free. */
export function distToPoly(poly: Vec2[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const len2 = ex * ex + ez * ez || 1e-9;
    let t = ((x - a.x) * ex + (z - a.z) * ez) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - (a.x + ex * t);
    const dz = z - (a.z + ez * t);
    const d = Math.hypot(dx, dz);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Is a point inside a building?
 *
 * The lots are the buildings: `buildings.ts` extrudes each `Lot.poly` from the
 * deck to `Lot.height` and puts nothing anywhere else, so a point-in-polygon
 * against the plan is the same question asked one file earlier. `margin`
 * widens the footprint, which is what a race line wants — passing a tower with
 * a metre to spare is not passing it.
 */
export function buildingBlocked(x: number, z: number, y: number, margin = 0): boolean {
  const lots = cityPlan().lots;
  for (let i = 0; i < lots.length; i++) {
    const lot = lots[i];
    if (lot.use === "garden") continue;
    if (y < lot.y - margin || y > lot.y + lot.height + margin) continue;
    // Cheap reject on the mean radius before the polygon test.
    const dr = Math.hypot(x, z) - lot.r;
    if (dr > 60 || dr < -60) continue;
    if (pointInPoly(lot.poly, x, z)) return true;
    if (margin > 0 && distToPoly(lot.poly, x, z) < margin) return true;
  }
  return false;
}

/**
 * The landmarks, as cylinders.
 *
 * `Landmark.clear` is the footprint the *plan* keeps clear so nothing else is
 * built there, and it is bigger than the thing itself — the Launch Terrace
 * holds 28 m of painted apron around a 5 m control tower. Using it as an
 * obstacle would forbid a race from starting over its own start line.
 *
 * So this is the structure rather than its clearance: measured off the
 * landmark builders and rounded generously outward. It exists to keep a gate,
 * a viewpoint or a collectible out of a building, and for nothing else.
 */
const LANDMARK_BODY: Record<string, { r: number; h: number }> = {
  // 24 m of basalt base, a shaft tapering to a mast, a light at 500 m.
  beacon: { r: 26, h: 505 },
  // A 16.5 m podium under a dome, and the telescope through the top of it.
  observatory: { r: 19, h: 38 },
  // 58 by 30 of iron and glass, so 33 m from the middle at the corners.
  "market-hall": { r: 33, h: 16 },
  // The control tower on the terrace. The apron around it is walkable, and a
  // race that could not start over its own start line would be a poor joke.
  launch: { r: 7, h: 15 },
  // A platform and a canopy.
  tram: { r: 14, h: 9 },
  // A basin and a spout.
  fountain: { r: 10, h: 6 },
};

export function landmarkBlocked(x: number, z: number, y: number, margin = 0): boolean {
  for (const l of LANDMARKS) {
    const body = LANDMARK_BODY[l.kind] ?? { r: l.clear, h: 20 };
    if (y < l.y - margin || y > l.y + body.h + margin) continue;
    if (Math.hypot(x - l.x, z - l.z) < body.r + margin) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------
 * Where the rock is
 * ---------------------------------------------------------------------- */

const KEEL_TOP = DECKS[DECKS.length - 1].y - 6;
const KEEL_TIP = ISLAND_Y - KEEL_DEPTH;
const KEEL_TOP_R = DECKS[DECKS.length - 1].outer * 0.99;

/**
 * The widest the rock can be at height `y`, over every angle and every roll of
 * the noise.
 *
 * `keel.ts` builds its lathe as `profile(t)` scaled by three per-angle terms —
 * a four-lobed buttress, a fine flute, and an fbm roughness that coarsens with
 * depth. Each has a known ceiling, so their product is an honest upper bound
 * rather than a guess: a route this function clears is clear even where the
 * noise happens to peak.
 */
export function keelRockRadius(y: number): number {
  if (y > KEEL_TOP || y < KEEL_TIP) return 0;
  const t = (KEEL_TOP - y) / (KEEL_TOP - KEEL_TIP);
  const base = KEEL_TOP_R * Math.pow(1 - t, 1.22) * (1 - 0.12 * Math.sin(t * Math.PI * 2.1));
  const lobe = 1.16;
  const flute = 1 + 0.055 * (0.35 + t);
  const rough = 1 + 0.34 * (0.3 + t * 1.1);
  return base * lobe * flute * rough;
}

/* The scattered stalactites, bounded the same way. `keel.ts` seeds thirty of
 * them at radii 0.24–0.9 of the plateau, roots each one inside the rock, and
 * hangs it 45–200 m. Which angles they land on is a roll of a die this module
 * is not allowed to see — so instead of pretending to know, the annulus they
 * could *possibly* occupy at a given height is treated as solid. It costs a
 * course thirty metres of clearance and buys a guarantee. */
const SPIKE_R0 = PLATEAU_R * 0.24;
const SPIKE_R1 = PLATEAU_R * 0.9;
const SPIKE_FAT = 30;

const spikeTop = (rr: number) => ISLAND_Y - 190 - Math.pow(rr / PLATEAU_R, 2.4) * 220;
const spikeBottom = (rr: number) => spikeTop(rr) - 90 - 200 * (1 - (rr / PLATEAU_R) * 0.28);

/** Innermost radius a stalactite can reach at height `y`. Infinity if none can. */
export function keelFringeInner(y: number): number {
  let best = Infinity;
  for (let rr = SPIKE_R0; rr <= SPIKE_R1; rr += 2) {
    if (y <= spikeTop(rr) && y >= spikeBottom(rr)) {
      const inner = rr - SPIKE_FAT;
      if (inner < best) best = inner;
    }
  }
  return best;
}

export const KEEL_FRINGE_OUTER = SPIKE_R1 + SPIKE_FAT + 4;

/**
 * True if a point might be inside the island's underside.
 *
 * Pessimistic on purpose — see the note at the top. Above the deck it answers
 * `false` and leaves the towers to `buildingBlocked`.
 */
export function keelBlocked(x: number, z: number, y: number): boolean {
  if (y > ISLAND_Y + 2) return false;
  const r = Math.hypot(x, z);
  /* The decks, and the terrace fascias holding them up.
   *
   * Solid *below* the surface you stand on and open above it — which is the
   * whole difference between "standing on the second promenade" and "inside
   * the second promenade", and the reason this asks `surfaceAt` rather than
   * treating everything inside r = 400 as rock. The gaps between the rings are
   * the faces of the steps, and those are solid all the way up to the deck. */
  if (y > KEEL_TOP) {
    if (r > DECKS[DECKS.length - 1].outer + 3) return false;
    const s = surfaceAt(x, z);
    const top = s.kind === "void" ? ISLAND_Y : s.y;
    return y < top - 0.6;
  }
  if (y < 8) return false;
  if (y >= KEEL_TIP && r <= keelRockRadius(y)) return true;
  // The one enormous spike down the axis: 40 m of radius, y 30 to 360.
  if (y >= 15 && y <= 372 && r <= 46) return true;
  if (y <= 436 && r >= keelFringeInner(y) && r <= KEEL_FRINGE_OUTER) return true;
  return false;
}

/** `keelBlocked` with a safety cube around the point. */
export function keelBlockedNear(x: number, z: number, y: number, margin: number): boolean {
  const r = Math.hypot(x, z);
  const a = Math.atan2(z, x);
  for (let dr = -1; dr <= 1; dr++) {
    for (let dy = -1; dy <= 1; dy++) {
      const rr = Math.max(0, r + dr * margin);
      const yy = y + dy * margin;
      if (keelBlocked(Math.cos(a) * rr, Math.sin(a) * rr, yy)) return true;
    }
  }
  return false;
}

/** Every lot with a real building on it, tallest first. Authoring-time only. */
export function tallLots(minHeight: number): Lot[] {
  return cityPlan()
    .lots.filter((l) => l.use !== "garden" && l.height >= minHeight)
    .sort((a, b) => b.height - a.height);
}

/* -------------------------------------------------------------------------
 * The gizmos
 * ---------------------------------------------------------------------- */

/**
 * A field of gates.
 *
 * One instanced torus for the rings and one instanced open cylinder for the
 * sleeve behind each — the sleeve is what tells you which way through, because
 * a ring seen edge-on is a line and a ring seen down its own axis is a hoop
 * with a tunnel behind it. Both are additive, both write no depth, and both
 * are driven by two uniforms and one per-instance attribute, so a race costs
 * two draw calls and no per-frame CPU beyond a clock.
 */
export interface GateField {
  group: THREE.Group;
  /** Place `n` gates. Called once when a course starts, never in a frame. */
  layout(points: THREE.Vector3[], normals: THREE.Vector3[], radius: number): void;
  /** 0 pending, 1 next, 2 cleared. */
  setState(i: number, state: number): void;
  update(time: number): void;
  dispose(): void;
}

const GATE_VERT = /* glsl */ `
attribute float aState;
attribute float aPhase;
varying float vState;
varying float vFace;
varying vec2 vTex;
uniform float uTime;
void main() {
  vState = aState;
  vTex = uv;
  float isNext = step(0.5, aState) * (1.0 - step(1.5, aState));
  float grow = 1.0 + isNext * 0.05 * sin(uTime * 3.4 + aPhase);
  vec4 wp = modelMatrix * instanceMatrix * vec4(position * grow, 1.0);
  vec3 axis = normalize((modelMatrix * instanceMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
  vFace = abs(dot(normalize(cameraPosition - wp.xyz), axis));
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const GATE_FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform float uAlpha;
uniform float uChevrons;
uniform vec3 uPending;
uniform vec3 uNext;
uniform vec3 uDone;
varying float vState;
varying float vFace;
varying vec2 vTex;
void main() {
  float isNext = step(0.5, vState) * (1.0 - step(1.5, vState));
  float isDone = step(1.5, vState);
  vec3 col = mix(uPending, uNext, isNext);
  col = mix(col, uDone, isDone);

  /* Chevrons running round the hoop, and running *faster* on the gate you
   * want next. Motion is the only thing that reads at six hundred metres. */
  float march = uTime * (0.7 + isNext * 2.6);
  float band = 0.5 + 0.5 * sin(vTex.x * uChevrons - march * 6.2831);
  float a = uAlpha * (0.34 + 0.66 * band);
  /* Face-on it flares, edge-on it thins: the cue that tells you which side to
   * come at it from before you are close enough to see the sleeve. */
  a *= 0.35 + 0.75 * vFace;
  a *= (0.5 + 1.3 * isNext) * (1.0 - 0.62 * isDone);
  gl_FragColor = vec4(col * (1.1 + isNext * 1.5), a);
}
`;

function gateMaterial(alpha: number, chevrons: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "EmpyreanGate",
    vertexShader: GATE_VERT,
    fragmentShader: GATE_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uAlpha: { value: alpha },
      uChevrons: { value: chevrons },
      uPending: { value: new THREE.Color(0x74d0ff) },
      uNext: { value: new THREE.Color(0xffd98a) },
      uDone: { value: new THREE.Color(0x6f8fb0) },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

export function buildGateField(max: number): GateField {
  const group = new THREE.Group();
  group.name = "empyrean-gates";

  const hoop = new THREE.TorusGeometry(1, 0.055, 8, 44);
  const sleeve = new THREE.CylinderGeometry(1, 1, 1, 40, 1, true);
  // A cylinder stands on Y; the gates are aimed down Z, like the torus.
  sleeve.rotateX(Math.PI / 2);

  const state = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
  const phase = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
  for (let i = 0; i < max; i++) phase.setX(i, i * 1.7);
  hoop.setAttribute("aState", state);
  hoop.setAttribute("aPhase", phase);
  sleeve.setAttribute("aState", state);
  sleeve.setAttribute("aPhase", phase);

  const hoopMat = gateMaterial(0.95, 60);
  const sleeveMat = gateMaterial(0.16, 22);

  const hoops = new THREE.InstancedMesh(hoop, hoopMat, max);
  const sleeves = new THREE.InstancedMesh(sleeve, sleeveMat, max);
  hoops.frustumCulled = false;
  sleeves.frustumCulled = false;
  hoops.count = 0;
  sleeves.count = 0;
  group.add(hoops, sleeves);

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const fwd = new THREE.Vector3(0, 0, 1);

  return {
    group,
    layout(points, normals, radius) {
      const n = Math.min(points.length, max);
      for (let i = 0; i < n; i++) {
        q.setFromUnitVectors(fwd, normals[i]);
        scale.set(radius, radius, radius);
        m4.compose(points[i], q, scale);
        hoops.setMatrixAt(i, m4);
        // The sleeve is the same hoop stretched into a short tunnel.
        scale.set(radius * 0.94, radius * 0.94, radius * 0.9);
        m4.compose(points[i], q, scale);
        sleeves.setMatrixAt(i, m4);
        state.setX(i, 0);
      }
      hoops.count = n;
      sleeves.count = n;
      hoops.instanceMatrix.needsUpdate = true;
      sleeves.instanceMatrix.needsUpdate = true;
      state.needsUpdate = true;
      group.visible = n > 0;
    },
    setState(i, s) {
      if (i < 0 || i >= max) return;
      state.setX(i, s);
      state.needsUpdate = true;
    },
    update(time) {
      hoopMat.uniforms.uTime.value = time;
      sleeveMat.uniforms.uTime.value = time;
    },
    dispose() {
      hoop.dispose();
      sleeve.dispose();
      hoopMat.dispose();
      sleeveMat.dispose();
    },
  };
}

/**
 * The pillar of light.
 *
 * One of these, moved around, for every activity's current target: the next
 * gate, the shop you are delivering to, the spot a photograph is taken from.
 * A marker you can only see when you are already near it is not a marker, and
 * this one is nine hundred metres tall and visible from the far shore.
 */
export interface Pillar {
  object: THREE.Object3D;
  set(x: number, y: number, z: number, colour: THREE.ColorRepresentation): void;
  hide(): void;
  update(time: number): void;
  dispose(): void;
}

const PILLAR_VERT = /* glsl */ `
varying vec2 vTex;
void main() {
  vTex = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const PILLAR_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColour;
uniform float uTime;
varying vec2 vTex;
void main() {
  /* Brightest at the marked height, fading away up and down, with a slow
   * rise through it so it reads as light rather than as a painted post. */
  float d = abs(vTex.y - 0.5) * 2.0;
  float a = pow(1.0 - d, 2.4) * 0.5;
  a *= 0.72 + 0.28 * sin(uTime * 2.0 - vTex.y * 26.0);
  gl_FragColor = vec4(uColour, a);
}
`;

export function buildPillar(): Pillar {
  const geo = new THREE.CylinderGeometry(2.6, 2.6, 900, 14, 1, true);
  const mat = new THREE.ShaderMaterial({
    name: "EmpyreanPillar",
    vertexShader: PILLAR_VERT,
    fragmentShader: PILLAR_FRAG,
    uniforms: { uColour: { value: new THREE.Color(0xffd28a) }, uTime: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "empyrean-waypoint-pillar";
  mesh.frustumCulled = false;
  mesh.visible = false;
  return {
    object: mesh,
    set(x, y, z, colour) {
      mesh.position.set(x, y, z);
      (mat.uniforms.uColour.value as THREE.Color).set(colour);
      mesh.visible = true;
    },
    hide() {
      mesh.visible = false;
    },
    update(time) {
      mat.uniforms.uTime.value = time;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}

/**
 * The ideal line to the next gate, and on through the rest of the course.
 *
 * Rebuilt only when the target changes — never in a frame that has not cleared
 * a gate — and drawn additively so it lies over the city like a thrown rope
 * rather than a wireframe through it.
 */
export interface RouteLine {
  object: THREE.Object3D;
  set(points: THREE.Vector3[], from: number, head: THREE.Vector3 | null): void;
  /** Drag the first vertex along behind the player. Three floats, no allocation. */
  setHead(x: number, y: number, z: number): void;
  hide(): void;
  dispose(): void;
}

export function buildRouteLine(max: number): RouteLine {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(max * 3);
  const col = new Float32Array(max * 3);
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setDrawRange(0, 0);
  const mat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const line = new THREE.Line(geo, mat);
  line.name = "empyrean-route";
  line.frustumCulled = false;
  line.visible = false;
  let hasHead = false;

  return {
    object: line,
    set(points, from, head) {
      let n = 0;
      const write = (p: THREE.Vector3, fade: number) => {
        if (n >= max) return;
        pos[n * 3] = p.x;
        pos[n * 3 + 1] = p.y;
        pos[n * 3 + 2] = p.z;
        col[n * 3] = 1.0 * fade;
        col[n * 3 + 1] = 0.82 * fade;
        col[n * 3 + 2] = 0.45 * fade;
        n++;
      };
      hasHead = !!head;
      if (head) write(head, 1);
      for (let i = from; i < points.length; i++) {
        write(points[i], Math.max(0.12, 1 - (i - from) * 0.22));
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
      geo.setDrawRange(0, n);
      line.visible = n > 1;
    },
    setHead(x, y, z) {
      if (!hasHead || !line.visible) return;
      pos[0] = x;
      pos[1] = y;
      pos[2] = z;
      geo.attributes.position.needsUpdate = true;
    },
    hide() {
      line.visible = false;
      geo.setDrawRange(0, 0);
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}

/**
 * A picture frame, hanging in the air where a photograph is taken from and
 * facing what the photograph is of.
 *
 * Four thin bars rather than a line loop: `LineBasicMaterial` ignores
 * `linewidth` on every platform that matters, so a frame drawn as lines is one
 * pixel wide at every distance and invisible at most of them.
 */
export interface PhotoFrame {
  object: THREE.Object3D;
  place(at: THREE.Vector3, look: THREE.Vector3): void;
  setAligned(t: number): void;
  hide(): void;
  dispose(): void;
}

export function buildPhotoFrame(): PhotoFrame {
  const group = new THREE.Group();
  group.name = "empyrean-photo-frame";
  group.visible = false;

  const w = 5.4;
  const h = 3.6;
  const t = 0.16;
  const bar = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffe6b0,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const spec: Array<[number, number, number, number, number]> = [
    [0, h / 2, w, t, 0],
    [0, -h / 2, w, t, 0],
    [-w / 2, 0, t, h, 0],
    [w / 2, 0, t, h, 0],
  ];
  for (const [x, y, sx, sy] of spec) {
    const m = new THREE.Mesh(bar, mat);
    m.position.set(x, y, 0);
    m.scale.set(sx, sy, t);
    group.add(m);
  }

  const aim = new THREE.Vector3();
  return {
    object: group,
    place(at, look) {
      group.position.copy(at);
      // The frame faces the subject, so standing behind it and looking through
      // it *is* the shot.
      aim.copy(look).sub(at);
      if (aim.lengthSq() > 1e-6) group.lookAt(aim.add(at));
      group.visible = true;
    },
    setAligned(v) {
      mat.opacity = 0.5 + 0.5 * clamp(v, 0, 1);
      (mat.color as THREE.Color).setHSL(0.12 - 0.05 * clamp(v, 0, 1), 0.75, 0.62);
    },
    hide() {
      group.visible = false;
    },
    dispose() {
      bar.dispose();
      mat.dispose();
    },
  };
}

/* -------------------------------------------------------------------------
 * A very small amount of sound
 * ---------------------------------------------------------------------- */

/**
 * Two notes and a chime.
 *
 * `audio.ts` owns the world's sound and this module is not allowed to import
 * it, so the collectibles bring their own — one lazily created context, made
 * on the first ping (which is to say after a gesture, because you have to fly
 * to get near one), and closed on dispose. Everything is wrapped: a browser
 * that refuses an AudioContext costs you a chime, not a world.
 */
export class Chimes {
  private ctx: AudioContext | null = null;
  private failed = false;
  private timers: number[] = [];

  private ensure(): AudioContext | null {
    if (this.ctx || this.failed) return this.ctx;
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        this.failed = true;
        return null;
      }
      this.ctx = new Ctor();
    } catch {
      this.failed = true;
    }
    return this.ctx;
  }

  play(freq: number, dur = 0.5, gain = 0.05, type: OscillatorType = "sine"): void {
    const ctx = this.ensure();
    if (!ctx) return;
    try {
      if (ctx.state === "suspended") void ctx.resume();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const amp = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);
      amp.gain.setValueAtTime(0, now);
      amp.gain.linearRampToValueAtTime(gain, now + 0.02);
      amp.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      osc.connect(amp).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + dur + 0.05);
    } catch {
      /* Not worth a single frame of trouble. */
    }
  }

  /**
   * Three notes, seventy milliseconds apart.
   *
   * The timers are kept so `dispose` can cancel them: a chime scheduled on the
   * frame the page navigates away would otherwise fire into a closed context,
   * which is a caught exception per note and a leaked handle per chime.
   */
  arpeggio(base: number, steps: readonly number[], gain = 0.05): void {
    for (let i = 0; i < steps.length; i++) {
      const f = base * Math.pow(2, steps[i] / 12);
      const id = window.setTimeout(() => {
        const at = this.timers.indexOf(id);
        if (at >= 0) this.timers.splice(at, 1);
        this.play(f, 0.45, gain);
      }, i * 70);
      this.timers.push(id);
    }
  }

  dispose(): void {
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.length = 0;
    try {
      void this.ctx?.close();
    } catch {
      /* Already gone. */
    }
    this.ctx = null;
    this.failed = true;
  }
}
