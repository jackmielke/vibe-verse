/**
 * The things that move without you: skycars on their lanes, the ring tram,
 * and a couple of flocks of whatever birds live six hundred metres up.
 *
 * A city is believable in the middle distance or it is not believable at all.
 * The crowd sells the pavement; this sells everything above it — a craft
 * banking over the Bazaar, a tram coming round the ring at a hundred, a line
 * of running lights sliding behind a tower. All of it is far enough away to
 * be cheap and near enough to be seen, which is the best trade in the world.
 *
 * ## How a lane works
 *
 * Every flying thing here follows a **closed polyline sampled once at build
 * time**: position, heading, pitch and turn rate per sample, with cumulative
 * arclength alongside. A vehicle is then a single number — how far along it
 * is — plus a speed. Position, facing and the bank angle all fall out of the
 * sample it is between, so there is no steering, no integration error, and no
 * way for a craft to end up somewhere its lane does not go.
 *
 * The bank is not a decoration: `roll = atan(v²κ/g)` off the lane's own turn
 * rate is the same sum an aircraft does, and it is why the ring lanes read as
 * *circling* rather than as beads on a wire.
 *
 * Queueing is the other half. Cars on a lane are stored in order of distance
 * along it and cannot overtake, so each one only ever looks at the one in
 * front: close the gap and it lifts off the throttle. The order can therefore
 * never change, which is what makes the whole thing O(cars) with no sorting.
 *
 * ## The tram, and what it exposes
 *
 * A real vehicle on the middle ring road, 218 m out, all the way round in
 * about ninety seconds with four stops on the way. It is *not* rideable from
 * here — this system deliberately implements no interaction. It publishes
 * where it is, whether it is standing, and where the platforms are, and
 * whatever owns the player can do the rest.
 *
 * The stops are named for the landmark each one serves, and each one is the
 * point on the ring nearest that landmark rather than the landmark itself:
 * the Halo Station building stands at r = 96, twelve seconds' walk up the
 * avenue from its platform, the way a station and a stop usually relate. A
 * route that detoured to the door of each would have to leave the road.
 */
import * as THREE from "three";
import { makeRng } from "@/shared/proc/rng";
import { RING_R, RIM_R, KERB_H } from "./cityplan";
import { ISLAND_Y, PLATEAU_R } from "./config";
/* The one exception to "a system may not import another system": `SUN_DIR` is
   a constant, not behaviour, and it is only the build-time default — every
   frame overwrites it from `ctx.sunDir`, which is the live one. */
import { SUN_DIR } from "./sky";
import type { BuildContext, FrameContext, System } from "./types";

export interface TramState {
  /** Front car's position, on the road, in world space. */
  x: number;
  y: number;
  z: number;
  /** Facing, radians, same convention as everything else: 0 is -Z. */
  yaw: number;
  /** True while it is standing at a platform with its doors open. */
  stopped: boolean;
  /**
   * Human-readable, for a sign or a prompt: the stop it is standing at while
   * `stopped`, and the one it is heading for while it is moving. Match it to
   * `stops` by name order, or use `stops[].id` for anything programmatic.
   */
  nextStop: string;
}

export interface TrafficHandle extends System {
  readonly tram: TramState;
  /** Platform positions, so another system can offer "ride the tram". */
  readonly stops: Array<{ id: string; x: number; y: number; z: number }>;
}

const TAU = Math.PI * 2;
const DECK = ISLAND_Y;

/** Where the tram stops, and what each stop is for. */
const TRAM_STOPS: Array<{ id: string; name: string; a: number }> = [
  { id: "halo", name: "Halo Station", a: Math.PI },
  { id: "market", name: "Market Hall", a: Math.PI * 0.75 },
  { id: "launch", name: "Launch Terrace", a: Math.PI * 0.25 },
  { id: "observatory", name: "The Observatory", a: -Math.PI / 2 },
];

/**
 * Tram kinematics. These four numbers *are* the ninety-second lap.
 *
 * The ring is 1370 m and the four stops cut it into 514, 342, 171 and 342 m.
 * At 5 m/s² up to 30 m/s that is 69.7 s of running; four seven-second stands
 * make it 97.7 on paper and 89 in practice, because braking on a discrete
 * step and the snap onto the platform each shave a little off every segment.
 * Change any of them and re-measure — the test asserts the lap, not the
 * speed, which is the number anyone actually notices.
 */
const TRAM_VMAX = 30;
const TRAM_ACCEL = 5;
const TRAM_DWELL = 7;
const TRAM_R = RING_R[1];

/** How far in from the road centreline a platform sits. */
const PLATFORM_OFF = 9.6;

/* -------------------------------------------------------------------------
 * Lanes
 * ---------------------------------------------------------------------- */

interface Lane {
  n: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  yaw: Float32Array;
  pitch: Float32Array;
  /** Signed turn rate, radians per metre. Drives the bank. */
  curv: Float32Array;
  /** Cumulative arclength, n + 1 entries; the last is the loop length. */
  cum: Float32Array;
  total: number;
  speed: number;
  first: number;
  count: number;
}

/**
 * Turn a closed list of points into a lane.
 *
 * Heading is the direction to the next sample; turn rate is the change in
 * heading over the distance between them, which on a circle comes out at
 * exactly 1/r and on a straight at zero.
 */
function makeLane(pts: number[], speed: number): Lane {
  const n = pts.length / 3;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const z = new Float32Array(n);
  const yaw = new Float32Array(n);
  const pitch = new Float32Array(n);
  const curv = new Float32Array(n);
  const cum = new Float32Array(n + 1);
  for (let i = 0; i < n; i++) {
    x[i] = pts[i * 3];
    y[i] = pts[i * 3 + 1];
    z[i] = pts[i * 3 + 2];
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = x[j] - x[i];
    const dy = y[j] - y[i];
    const dz = z[j] - z[i];
    const flat = Math.hypot(dx, dz) || 1e-4;
    const len = Math.hypot(dx, dy, dz) || 1e-4;
    yaw[i] = Math.atan2(-dx, -dz);
    pitch[i] = Math.atan2(dy, flat);
    cum[i + 1] = cum[i] + len;
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    let d = yaw[j] - yaw[i];
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    curv[i] = d / Math.max(0.5, cum[i + 1] - cum[i]);
  }
  return {
    n,
    x,
    y,
    z,
    yaw,
    pitch,
    curv,
    cum,
    total: cum[n],
    speed,
    first: 0,
    count: 0,
  };
}

/** A ring lane: a circle at a radius and an altitude, either way round. */
function ringLane(r: number, y: number, dir: 1 | -1, speed: number): Lane {
  const n = Math.max(24, Math.round((TAU * r) / 9));
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU * dir;
    pts.push(Math.cos(a) * r, y, Math.sin(a) * r);
  }
  return makeLane(pts, speed);
}

/**
 * An avenue loop: out over one avenue, round at the rim, back over the next,
 * round again at the middle. Two altitudes, so the two legs do not meet.
 */
function avenueLane(a0: number, a1: number, r0: number, r1: number, yOut: number, yBack: number, speed: number): Lane {
  const pts: number[] = [];
  const push = (r: number, a: number, y: number) => pts.push(Math.cos(a) * r, y, Math.sin(a) * r);
  const legs = Math.max(6, Math.round((r1 - r0) / 12));
  for (let i = 0; i < legs; i++) push(r0 + ((r1 - r0) * i) / legs, a0, yOut);
  const arcOut = Math.max(4, Math.round((Math.abs(a1 - a0) * r1) / 12));
  for (let i = 0; i < arcOut; i++) {
    const t = i / arcOut;
    push(r1, a0 + (a1 - a0) * t, yOut + (yBack - yOut) * t);
  }
  for (let i = 0; i < legs; i++) push(r1 - ((r1 - r0) * i) / legs, a1, yBack);
  const arcIn = Math.max(4, Math.round((Math.abs(a1 - a0) * r0) / 12));
  for (let i = 0; i < arcIn; i++) {
    const t = i / arcIn;
    push(r0, a1 - (a1 - a0) * t, yBack + (yOut - yBack) * t);
  }
  return makeLane(pts, speed);
}

/* -------------------------------------------------------------------------
 * Geometry
 * ---------------------------------------------------------------------- */

interface BoxSpec {
  cx: number;
  cy: number;
  cz: number;
  sx: number;
  sy: number;
  sz: number;
  /** 0 hull, 1 glass, 2 emissive. */
  part: number;
}

const FACES: Array<[number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

interface RawGeo {
  position: Float32Array;
  normal: Float32Array;
  part: Float32Array;
  index: Uint16Array;
}

function boxes(list: BoxSpec[]): RawGeo {
  const verts = list.length * 24;
  const position = new Float32Array(verts * 3);
  const normal = new Float32Array(verts * 3);
  const part = new Float32Array(verts);
  const index = new Uint16Array(list.length * 36);
  let v = 0;
  let ii = 0;
  for (const b of list) {
    const hx = b.sx / 2;
    const hy = b.sy / 2;
    const hz = b.sz / 2;
    for (const [nx, ny, nz] of FACES) {
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
        position[v * 3] = b.cx + nx * hx + (ux * su + vx * sv) * hx;
        position[v * 3 + 1] = b.cy + ny * hy + (uy * su + vy * sv) * hy;
        position[v * 3 + 2] = b.cz + nz * hz + (uz * su + vz * sv) * hz;
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

/** Forward is -Z, the same as everything else that has a front in this world. */
const SKYCAR: BoxSpec[] = [
  { cx: 0, cy: 0, cz: 0.2, sx: 1.9, sy: 0.85, sz: 5.0, part: 0 },
  { cx: 0, cy: -0.06, cz: -2.9, sx: 1.15, sy: 0.5, sz: 1.5, part: 0 },
  { cx: 0, cy: 0.46, cz: -0.7, sx: 1.45, sy: 0.55, sz: 2.1, part: 1 },
  { cx: 1.32, cy: -0.12, cz: 0.5, sx: 0.62, sy: 0.55, sz: 2.9, part: 0 },
  { cx: -1.32, cy: -0.12, cz: 0.5, sx: 0.62, sy: 0.55, sz: 2.9, part: 0 },
  { cx: 0, cy: -0.46, cz: 0.6, sx: 1.25, sy: 0.12, sz: 3.2, part: 2 },
  { cx: 0, cy: 0.62, cz: 2.3, sx: 0.13, sy: 0.85, sz: 1.1, part: 0 },
];

const TRAM_CAR: BoxSpec[] = [
  { cx: 0, cy: 1.55, cz: 0, sx: 2.9, sy: 2.5, sz: 10.4, part: 0 },
  { cx: 0, cy: 2.05, cz: 0, sx: 2.98, sy: 1.05, sz: 9.4, part: 1 },
  { cx: 0, cy: 3.0, cz: 0, sx: 2.4, sy: 0.42, sz: 9.0, part: 0 },
  { cx: 0, cy: 0.35, cz: 0, sx: 2.3, sy: 0.55, sz: 9.6, part: 0 },
  { cx: 0, cy: 0.72, cz: 0, sx: 3.02, sy: 0.14, sz: 8.6, part: 2 },
];

const PLATFORM: BoxSpec[] = [
  { cx: 0, cy: 0.18, cz: 0, sx: 4.4, sy: 0.36, sz: 17, part: 0 },
  { cx: -1.9, cy: 1.9, cz: -7.2, sx: 0.18, sy: 3.1, sz: 0.18, part: 0 },
  { cx: -1.9, cy: 1.9, cz: 7.2, sx: 0.18, sy: 3.1, sz: 0.18, part: 0 },
  { cx: -1.9, cy: 1.9, cz: 0, sx: 0.18, sy: 3.1, sz: 0.18, part: 0 },
  { cx: -0.6, cy: 3.55, cz: 0, sx: 3.4, sy: 0.16, sz: 15.4, part: 0 },
  { cx: -0.6, cy: 3.4, cz: 0, sx: 2.4, sy: 0.09, sz: 13.0, part: 2 },
];

/** A bird: two wing quads either side of a scrap of body. */
function birdGeo(): RawGeo {
  const position = new Float32Array((4 + 4 + 24) * 3);
  const normal = new Float32Array((4 + 4 + 24) * 3);
  const part = new Float32Array(4 + 4 + 24);
  const index = new Uint16Array(6 + 6 + 36);
  let v = 0;
  let ii = 0;
  for (const side of [1, -1]) {
    const base = v;
    const quad: Array<[number, number]> = [
      [0.04, -0.16],
      [0.62, -0.30],
      [0.62, 0.24],
      [0.04, 0.14],
    ];
    for (const [w, z] of quad) {
      position[v * 3] = w * side;
      position[v * 3 + 1] = 0;
      position[v * 3 + 2] = z;
      normal[v * 3 + 1] = 1;
      part[v] = side > 0 ? 0 : 1;
      v++;
    }
    if (side > 0) {
      index[ii++] = base;
      index[ii++] = base + 1;
      index[ii++] = base + 2;
      index[ii++] = base;
      index[ii++] = base + 2;
      index[ii++] = base + 3;
    } else {
      index[ii++] = base;
      index[ii++] = base + 2;
      index[ii++] = base + 1;
      index[ii++] = base;
      index[ii++] = base + 3;
      index[ii++] = base + 2;
    }
  }
  const body = boxes([{ cx: 0, cy: 0, cz: 0, sx: 0.09, sy: 0.09, sz: 0.42, part: 2 }]);
  position.set(body.position, v * 3);
  normal.set(body.normal, v * 3);
  part.set(body.part, v);
  for (let k = 0; k < body.index.length; k++) index[ii++] = body.index[k] + v;
  return { position, normal, part, index };
}

/* -------------------------------------------------------------------------
 * Shaders
 * ---------------------------------------------------------------------- */

const HULL_VERT = /* glsl */ `
  attribute float aPart;
  attribute vec3 aTint;
  attribute vec2 aGlow;  // emissive gain, strobe phase

  uniform float uTime;
  uniform float uNight;

  varying vec3 vCol;
  varying vec3 vNrm;
  varying vec3 vView;
  varying float vEmit;

  void main() {
    // Position and facing both come out of the instance matrix, which three
    // declares for us because this is drawn from an InstancedMesh.
    vec3 world = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
    vec3 n = mat3(modelMatrix) * mat3(instanceMatrix) * normal;

    vec3 col = aTint;
    float emit = 0.0;
    if (aPart > 1.5) {
      // The lit strip: always on, brighter after dark, with a slow breath so a
      // line of them never pulses in step.
      col = vec3(1.0, 0.72, 0.42);
      emit = aGlow.x * (0.55 + uNight * 1.5)
           * (0.8 + 0.2 * sin(uTime * 2.1 + aGlow.y * 6.283));
    } else if (aPart > 0.5) {
      col = aTint * 0.35 + vec3(0.05, 0.08, 0.12);
      emit = uNight * aGlow.x * 0.55;
    }

    vCol = col;
    vEmit = emit;
    vNrm = n;
    vView = cameraPosition - world;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const HULL_FRAG = /* glsl */ `
  precision mediump float;
  uniform vec3 uSun;
  uniform vec3 uSunCol;
  uniform vec3 uSkyCol;

  varying vec3 vCol;
  varying vec3 vNrm;
  varying vec3 vView;
  varying float vEmit;

  void main() {
    vec3 N = normalize(vNrm);
    vec3 V = normalize(vView);
    float ndl = max(dot(N, uSun), 0.0);
    float sky = 0.5 + 0.5 * N.y;
    // A hard specular off the sun, because these are lacquered metal and it is
    // the flash of one turning that catches your eye at four hundred metres.
    float spec = pow(max(dot(reflect(-uSun, N), V), 0.0), 42.0);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    vec3 lit = vCol * (uSunCol * ndl + uSkyCol * sky)
             + uSunCol * spec * 0.9
             + uSkyCol * fres * 0.4
             + vCol * vEmit;
    gl_FragColor = vec4(lit, 1.0);
  }
`;

const BIRD_VERT = /* glsl */ `
  attribute float aPart;
  attribute vec3 aTint;
  attribute vec2 aGlow;
  uniform float uTime;
  varying vec3 vCol;
  varying float vShade;

  vec3 rotZ(vec3 p, float a) { float s = sin(a), c = cos(a); return vec3(p.x * c - p.y * s, p.x * s + p.y * c, p.z); }

  void main() {
    vec3 p = position;
    if (aPart < 1.5) {
      // Each wing hinges on the spine; the two of them are mirrored, so one
      // sine drives both and the flock never beats in unison because every
      // bird carries its own phase.
      float flap = sin(uTime * 7.0 + aGlow.y * 6.283) * 0.62 + 0.1;
      p = rotZ(p, aPart < 0.5 ? flap : -flap);
      vShade = 0.7 + 0.3 * cos(flap);
    } else {
      vShade = 1.0;
    }
    // Flap first, in the bird's own frame, then fly it.
    vCol = aTint;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
  }
`;

const BIRD_FRAG = /* glsl */ `
  precision mediump float;
  varying vec3 vCol;
  varying float vShade;
  void main() { gl_FragColor = vec4(vCol * vShade, 1.0); }
`;

const LIGHT_VERT = /* glsl */ `
  attribute float aSize;
  uniform float uScale;
  varying vec3 vCol;
  void main() {
    vCol = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(aSize * uScale / max(-mv.z, 1.0), 1.4, 9.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const LIGHT_FRAG = /* glsl */ `
  precision mediump float;
  varying vec3 vCol;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d) * 2.0;
    float core = smoothstep(1.0, 0.0, r);
    gl_FragColor = vec4(vCol * (0.35 + core * 2.1), core * core);
  }
`;

/* -------------------------------------------------------------------------
 * Build
 * ---------------------------------------------------------------------- */

export function buildTraffic(ctx: BuildContext): TrafficHandle {
  const low = ctx.quality === "low";
  const rng = makeRng(`empyrean-traffic:${ctx.seedSalt}`);
  const group = new THREE.Group();
  group.name = "empyrean-traffic";

  /* ---- lanes ----------------------------------------------------------- */
  /* Altitudes are chosen against each other, not for the look of them: every
     lane crosses several others in plan, so the only thing keeping two craft
     out of the same cubic metre is ten metres of air. Ring lanes take 26, 40,
     64 and 88; the cross-town loops take the gaps between them, and the four
     loops never overlap each other in plan, so they can share. */
  const lanes: Lane[] = [
    ringLane(RING_R[0], DECK + 40, 1, 30),
    ringLane(RING_R[1], DECK + 64, -1, 34),
    ringLane(RING_R[2], DECK + 88, 1, 36),
    ringLane(RIM_R + 22, DECK + 26, -1, 28),
  ];
  /* Four cross-town loops, each out over one avenue and back over the next.
     Every leg and every turn is above an actual street — out along an avenue,
     round on the rim road, back along the next avenue, round again on the
     first ring. A lane that cuts a corner between two avenues is a lane that
     flies through the middle of the Spires. */
  for (let i = 0; i < 4; i++) {
    const a0 = (i / 4) * TAU;
    lanes.push(
      avenueLane(
        a0,
        a0 + Math.PI / 4,
        RING_R[0],
        RIM_R,
        DECK + 51 + (i % 2) * 3,
        DECK + 75 + (i % 2) * 3,
        32,
      ),
    );
  }

  const perLane = low ? [2, 2, 2, 2, 1, 1, 1, 1] : [6, 8, 9, 7, 4, 4, 4, 4];
  let carCount = 0;
  for (let i = 0; i < lanes.length; i++) {
    lanes[i].first = carCount;
    lanes[i].count = perLane[i] ?? 2;
    carCount += lanes[i].count;
  }

  const carLane = new Int32Array(carCount);
  const carS = new Float32Array(carCount);
  const carV = new Float32Array(carCount);
  const carSample = new Int32Array(carCount);
  const carWant = new Float32Array(carCount);
  const carTint = new Float32Array(carCount * 3);
  const carPhase = new Float32Array(carCount);

  const TINTS = [0xd8dde6, 0xb4c3d4, 0x8fa2bd, 0xd6b48c, 0xc2c8cf, 0x9fb3a6, 0xcfa5a0];
  const tmpColor = new THREE.Color();
  for (let li = 0; li < lanes.length; li++) {
    const lane = lanes[li];
    for (let k = 0; k < lane.count; k++) {
      const c = lane.first + k;
      carLane[c] = li;
      // Evenly spaced round the loop, so nobody starts inside anybody.
      carS[c] = (lane.total * k) / lane.count;
      carV[c] = lane.speed;
      carWant[c] = lane.speed * rng.range(0.88, 1.06);
      carPhase[c] = rng.next();
      tmpColor.setHex(rng.pick(TINTS));
      carTint[c * 3] = tmpColor.r;
      carTint[c * 3 + 1] = tmpColor.g;
      carTint[c * 3 + 2] = tmpColor.b;
    }
  }

  /* ---- the tram -------------------------------------------------------- */
  const tramLane = ringLane(TRAM_R, DECK - KERB_H + 0.34, 1, TRAM_VMAX);
  const stopS: number[] = TRAM_STOPS.map((s) => {
    // Where along the loop that angle lands. The lane is a circle wound
    // counter-clockwise from angle zero, so this is just arclength.
    let a = s.a;
    while (a < 0) a += TAU;
    while (a >= TAU) a -= TAU;
    return (a / TAU) * tramLane.total;
  });
  const stopOrder = stopS.map((_, i) => i).sort((a, b) => stopS[a] - stopS[b]);

  const stops = TRAM_STOPS.map((s) => ({
    id: s.id,
    x: Math.cos(s.a) * (TRAM_R - PLATFORM_OFF),
    y: DECK + 0.36,
    z: Math.sin(s.a) * (TRAM_R - PLATFORM_OFF),
  }));

  let tramS = stopS[stopOrder[0]];
  let tramV = 0;
  let tramDwell = TRAM_DWELL;
  let tramTargetIdx = 0; // index into stopOrder
  let tramStopped = true;

  const tram: TramState = {
    x: Math.cos(TRAM_STOPS[stopOrder[0]].a) * TRAM_R,
    y: DECK,
    z: Math.sin(TRAM_STOPS[stopOrder[0]].a) * TRAM_R,
    yaw: 0,
    stopped: true,
    nextStop: TRAM_STOPS[stopOrder[0]].name,
  };

  /* ---- birds ----------------------------------------------------------- */
  const BIRDS = low ? 0 : 26;
  const birdA = new Float32Array(BIRDS);
  const birdR = new Float32Array(BIRDS);
  const birdY = new Float32Array(BIRDS);
  const birdW = new Float32Array(BIRDS);
  const birdPhase = new Float32Array(BIRDS);
  for (let i = 0; i < BIRDS; i++) {
    const flock = Math.floor(i / 9);
    birdA[i] = rng.range(0, TAU) + flock * 2.1;
    birdR[i] = PLATEAU_R * rng.range(0.45, 1.15) + flock * 40;
    birdY[i] = DECK + rng.range(20, 150) + flock * 30;
    birdW[i] = rng.range(0.035, 0.062) * (flock % 2 === 0 ? 1 : -1);
    birdPhase[i] = rng.next();
  }

  /* ---- meshes ---------------------------------------------------------- */
  const uniforms = {
    uTime: { value: 0 },
    uNight: { value: 0.6 },
    uSun: { value: SUN_DIR.clone() },
    uSunCol: { value: new THREE.Color(1.5, 1.12, 0.84) },
    uSkyCol: { value: new THREE.Color(0.3, 0.3, 0.42) },
  };

  const hullMat = new THREE.ShaderMaterial({
    name: "EmpyreanVehicle",
    uniforms,
    vertexShader: HULL_VERT,
    fragmentShader: HULL_FRAG,
    fog: false,
  });
  const birdMat = new THREE.ShaderMaterial({
    name: "EmpyreanBirds",
    uniforms,
    vertexShader: BIRD_VERT,
    fragmentShader: BIRD_FRAG,
    fog: false,
    side: THREE.DoubleSide,
  });

  /**
   * A fleet is a real `InstancedMesh`, and that is a correctness decision
   * rather than a stylistic one.
   *
   * The obvious alternative — a plain `Mesh` over an `InstancedBufferGeometry`
   * with the transform in custom attributes — draws identically and is what
   * the crowd does, because eight hundred bodies want four floats a frame
   * rather than sixteen. But it makes every three.js utility lie about where
   * the thing is: `Box3.setFromObject` reads the *geometry's* box for a plain
   * mesh, which is authored around the origin, so a tram lapping the ring at
   * y = 620 reports as a ten-metre box sitting on the ice six hundred metres
   * below the city. Frustum tests, raycasts and "where is the tram" queries
   * all inherit that. `InstancedMesh` carries an object-level bounding box
   * that walks the instance matrices, so it answers honestly — and at
   * seventy-nine vehicles the per-frame matrix compose is free.
   */
  interface Fleet {
    geo: THREE.BufferGeometry;
    mesh: THREE.InstancedMesh;
    tint: Float32Array;
    glow: Float32Array;
    attrs: THREE.InstancedBufferAttribute[];
  }

  const makeFleet = (src: RawGeo, mat: THREE.ShaderMaterial, cap: number): Fleet => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(src.position, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(src.normal, 3));
    geo.setAttribute("aPart", new THREE.BufferAttribute(src.part, 1));
    geo.setIndex(new THREE.BufferAttribute(src.index, 1));
    const n = Math.max(1, cap);
    const tint = new Float32Array(n * 3);
    const glow = new Float32Array(n * 2);
    const attrs: THREE.InstancedBufferAttribute[] = [];
    const bind = (name: string, arr: Float32Array, size: number) => {
      const attr = new THREE.InstancedBufferAttribute(arr, size);
      geo.setAttribute(name, attr);
      attrs.push(attr);
    };
    // Colour and glow are per-vehicle and written once; only the matrices move.
    bind("aTint", tint, 3);
    bind("aGlow", glow, 2);
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.count = cap;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    group.add(mesh);
    return { geo, mesh, tint, glow, attrs };
  };

  /* One matrix and one euler, reused by every vehicle in the world. The order
     is YXZ — yaw, then pitch, then roll — which is the order a craft actually
     banks in and the order the old vertex shader composed by hand. */
  const mtx = new THREE.Matrix4();
  const eul = new THREE.Euler();
  const place = (
    fleet: Fleet,
    i: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    pitch: number,
    roll: number,
  ) => {
    eul.set(pitch, yaw, roll, "YXZ");
    mtx.makeRotationFromEuler(eul);
    mtx.setPosition(x, y, z);
    fleet.mesh.setMatrixAt(i, mtx);
  };

  const cars = makeFleet(boxes(SKYCAR), hullMat, carCount);
  const tramCars = makeFleet(boxes(TRAM_CAR), hullMat, 3);
  const platforms = makeFleet(boxes(PLATFORM), hullMat, stops.length);
  const birds = makeFleet(birdGeo(), birdMat, BIRDS);

  for (let c = 0; c < carCount; c++) {
    cars.tint[c * 3] = carTint[c * 3];
    cars.tint[c * 3 + 1] = carTint[c * 3 + 1];
    cars.tint[c * 3 + 2] = carTint[c * 3 + 2];
    cars.glow[c * 2] = 1;
    cars.glow[c * 2 + 1] = carPhase[c];
  }
  for (let i = 0; i < 3; i++) {
    tramCars.tint[i * 3] = 0.78;
    tramCars.tint[i * 3 + 1] = 0.82;
    tramCars.tint[i * 3 + 2] = 0.88;
    tramCars.glow[i * 2] = 1;
    tramCars.glow[i * 2 + 1] = i * 0.31;
  }
  // Platforms never move; write them once and never touch them again.
  for (let i = 0; i < stops.length; i++) {
    const a = TRAM_STOPS[i].a;
    // The slab runs along the road, so its long axis is the tangent.
    place(platforms, i, stops[i].x, DECK, stops[i].z, -a, 0, 0);
    platforms.tint[i * 3] = 0.52;
    platforms.tint[i * 3 + 1] = 0.55;
    platforms.tint[i * 3 + 2] = 0.6;
    platforms.glow[i * 2] = 1;
    platforms.glow[i * 2 + 1] = i * 0.2;
  }
  for (const attr of platforms.attrs) attr.needsUpdate = true;
  platforms.mesh.instanceMatrix.needsUpdate = true;
  platforms.mesh.computeBoundingBox();
  platforms.mesh.computeBoundingSphere();
  for (let i = 0; i < BIRDS; i++) {
    birds.tint[i * 3] = 0.10;
    birds.tint[i * 3 + 1] = 0.09;
    birds.tint[i * 3 + 2] = 0.13;
    birds.glow[i * 2] = 1;
    birds.glow[i * 2 + 1] = birdPhase[i];
  }
  for (const attr of birds.attrs) attr.needsUpdate = true;

  /* ---- running lights -------------------------------------------------- */
  const LIGHTS_PER_CAR = 3;
  const lightCount = carCount * LIGHTS_PER_CAR + 3 * 2;
  const lightPos = new Float32Array(lightCount * 3);
  const lightCol = new Float32Array(lightCount * 3);
  const lightSize = new Float32Array(lightCount);
  for (let c = 0; c < carCount; c++) {
    const b = c * LIGHTS_PER_CAR;
    // Port red, starboard green, and a white strobe on the fin. Aircraft
    // convention, because everybody already knows how to read it.
    lightCol.set([1.0, 0.16, 0.14], b * 3);
    lightCol.set([0.2, 1.0, 0.35], (b + 1) * 3);
    lightCol.set([1.0, 0.95, 0.85], (b + 2) * 3);
    lightSize[b] = 1.5;
    lightSize[b + 1] = 1.5;
    lightSize[b + 2] = 2.2;
  }
  for (let i = 0; i < 6; i++) {
    const b = carCount * LIGHTS_PER_CAR + i;
    lightCol.set([1.0, 0.78, 0.42], b * 3);
    lightSize[b] = 2.4;
  }
  const lightGeo = new THREE.BufferGeometry();
  const lightPosAttr = new THREE.BufferAttribute(lightPos, 3);
  lightPosAttr.setUsage(THREE.DynamicDrawUsage);
  lightGeo.setAttribute("position", lightPosAttr);
  lightGeo.setAttribute("color", new THREE.BufferAttribute(lightCol, 3));
  lightGeo.setAttribute("aSize", new THREE.BufferAttribute(lightSize, 1));
  lightGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, DECK, 0), PLATEAU_R * 2);
  const lightMat = new THREE.ShaderMaterial({
    name: "EmpyreanVehicleLights",
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: { uScale: { value: 620 } },
    vertexShader: LIGHT_VERT,
    fragmentShader: LIGHT_FRAG,
  });
  lightMat.vertexColors = true;
  const lights = new THREE.Points(lightGeo, lightMat);
  lights.name = "empyrean-vehicle-lights";
  lights.frustumCulled = false;
  group.add(lights);

  /* -----------------------------------------------------------------------
   * Frame
   * -------------------------------------------------------------------- */

  /** Where a lane is at arclength `s`, written into these six numbers. */
  const sampleOut = new Float32Array(6); // x, y, z, yaw, pitch, curv
  const tramSample = new Int32Array(3);

  const sampleLane = (lane: Lane, s: number, hint: number): number => {
    let si = hint;
    if (si < 0 || si >= lane.n) si = 0;
    let guard = 0;
    while (s >= lane.cum[si + 1] && guard++ < lane.n) si = (si + 1) % lane.n;
    while (s < lane.cum[si] && guard++ < lane.n * 2) si = (si + lane.n - 1) % lane.n;
    const a = lane.cum[si];
    const b = lane.cum[si + 1];
    const t = b > a ? (s - a) / (b - a) : 0;
    const j = (si + 1) % lane.n;
    sampleOut[0] = lane.x[si] + (lane.x[j] - lane.x[si]) * t;
    sampleOut[1] = lane.y[si] + (lane.y[j] - lane.y[si]) * t;
    sampleOut[2] = lane.z[si] + (lane.z[j] - lane.z[si]) * t;
    let dy = lane.yaw[j] - lane.yaw[si];
    while (dy > Math.PI) dy -= TAU;
    while (dy < -Math.PI) dy += TAU;
    sampleOut[3] = lane.yaw[si] + dy * t;
    sampleOut[4] = lane.pitch[si] + (lane.pitch[j] - lane.pitch[si]) * t;
    sampleOut[5] = lane.curv[si];
    return si;
  };

  const update = (frame: FrameContext) => {
    const dt = frame.dt;
    uniforms.uTime.value = frame.time;
    uniforms.uNight.value = 1 - frame.daylight;
    (uniforms.uSun.value as THREE.Vector3).copy(frame.sunDir);
    const warm = 0.4 + frame.daylight * 0.9;
    (uniforms.uSunCol.value as THREE.Color).setRGB(1.5 * warm, 1.08 * warm, 0.78 * warm);
    (uniforms.uSkyCol.value as THREE.Color).setRGB(
      0.13 + frame.daylight * 0.2,
      0.13 + frame.daylight * 0.19,
      0.2 + frame.daylight * 0.24,
    );

    /* ---- skycars ------------------------------------------------------- */
    for (let li = 0; li < lanes.length; li++) {
      const lane = lanes[li];
      for (let k = 0; k < lane.count; k++) {
        const c = lane.first + k;
        // The car in front is the next one round the loop; nobody overtakes,
        // so this ordering is fixed for the life of the world.
        const ahead = lane.first + ((k + 1) % lane.count);
        let gap = carS[ahead] - carS[c];
        if (gap <= 0) gap += lane.total;
        const minGap = 24;
        let want = carWant[c];
        if (gap < minGap * 2.2) {
          want *= Math.max(0.08, (gap - minGap * 0.55) / (minGap * 1.65));
        }
        const accel = want > carV[c] ? 7 : 12;
        carV[c] += Math.max(-accel * dt, Math.min(accel * dt, want - carV[c]));
        if (carV[c] < 0) carV[c] = 0;
        carS[c] += carV[c] * dt;
        if (carS[c] >= lane.total) carS[c] -= lane.total;

        carSample[c] = sampleLane(lane, carS[c], carSample[c]);
        const x = sampleOut[0];
        const y = sampleOut[1];
        const z = sampleOut[2];
        const yaw = sampleOut[3];
        const roll = Math.atan((carV[c] * carV[c] * sampleOut[5]) / 9.81);
        const bank = Math.max(-0.9, Math.min(0.9, roll));
        place(cars, c, x, y, z, yaw, sampleOut[4], bank);

        // Wingtips and a strobe, in the craft's own frame.
        const sy = Math.sin(yaw);
        const cy = Math.cos(yaw);
        const sr = Math.sin(bank);
        const cr = Math.cos(bank);
        const b = c * LIGHTS_PER_CAR;
        const put = (idx: number, lx: number, ly: number, lz: number) => {
          const rx = lx * cr - ly * sr;
          const ry = lx * sr + ly * cr;
          lightPos[idx * 3] = x + rx * cy + lz * sy;
          lightPos[idx * 3 + 1] = y + ry;
          lightPos[idx * 3 + 2] = z - rx * sy + lz * cy;
        };
        put(b, 1.68, -0.12, 0.5);
        put(b + 1, -1.68, -0.12, 0.5);
        // The strobe is switched off by being moved *inside* the fuselage,
        // where the hull's own depth occludes it. Cheaper than a per-point
        // alpha the shader would have to carry for every light on every car.
        const strobe = Math.sin(frame.time * 3.4 + carPhase[c] * 6.283) > 0.86;
        put(b + 2, 0, strobe ? 1.5 : 0, strobe ? 2.3 : 0.2);
      }
    }

    /* ---- the tram ------------------------------------------------------ */
    const targetStop = stopOrder[tramTargetIdx];
    if (tramStopped) {
      tramDwell -= dt;
      if (tramDwell <= 0) {
        tramStopped = false;
        tramTargetIdx = (tramTargetIdx + 1) % stopOrder.length;
      }
    } else {
      let togo = stopS[stopOrder[tramTargetIdx]] - tramS;
      while (togo < 0) togo += tramLane.total;
      const brake = (tramV * tramV) / (2 * TRAM_ACCEL);
      tramV += (togo <= brake ? -TRAM_ACCEL : TRAM_ACCEL) * dt;
      /* The floor is not a detail. Braking on a discrete step can put the
         speed at zero a metre short of the platform, and a tram that has
         stopped without *arriving* never arrives: it is still braking, so it
         never accelerates, and the ring stands still for the rest of the
         session. Creep in. */
      tramV = Math.min(TRAM_VMAX, Math.max(1.0, tramV));
      tramS += tramV * dt;
      if (tramS >= tramLane.total) tramS -= tramLane.total;
      let left = stopS[stopOrder[tramTargetIdx]] - tramS;
      while (left < 0) left += tramLane.total;
      if (left < 0.9 || left > tramLane.total - 0.9) {
        tramS = stopS[stopOrder[tramTargetIdx]];
        tramV = 0;
        tramStopped = true;
        tramDwell = TRAM_DWELL;
      }
    }

    for (let i = 0; i < 3; i++) {
      let s = tramS - i * 11.6;
      while (s < 0) s += tramLane.total;
      tramSample[i] = sampleLane(tramLane, s, tramSample[i]);
      place(tramCars, i, sampleOut[0], sampleOut[1], sampleOut[2], sampleOut[3], 0, 0);
      if (i === 0) {
        tram.x = sampleOut[0];
        tram.y = sampleOut[1];
        tram.z = sampleOut[2];
        tram.yaw = sampleOut[3];
        const headLight = carCount * LIGHTS_PER_CAR;
        lightPos[headLight * 3] = sampleOut[0];
        lightPos[headLight * 3 + 1] = sampleOut[1] + 2.4;
        lightPos[headLight * 3 + 2] = sampleOut[2];
      }
      if (i === 2) {
        const tailLight = carCount * LIGHTS_PER_CAR + 1;
        lightPos[tailLight * 3] = sampleOut[0];
        lightPos[tailLight * 3 + 1] = sampleOut[1] + 2.4;
        lightPos[tailLight * 3 + 2] = sampleOut[2];
      }
    }
    tram.stopped = tramStopped;
    // Standing at a platform, the sign reads that platform; moving, it reads
    // the one you are heading for.
    tram.nextStop = TRAM_STOPS[tramStopped ? targetStop : stopOrder[tramTargetIdx]].name;

    // The four platform canopy lamps, so a stop is findable after dark.
    for (let i = 0; i < 4 && i < stops.length; i++) {
      const b = carCount * LIGHTS_PER_CAR + 2 + i;
      if (b >= lightCount) break;
      lightPos[b * 3] = stops[i].x;
      lightPos[b * 3 + 1] = DECK + 3.4;
      lightPos[b * 3 + 2] = stops[i].z;
    }

    /* ---- birds --------------------------------------------------------- */
    for (let i = 0; i < BIRDS; i++) {
      birdA[i] += birdW[i] * dt;
      const r = birdR[i] + Math.sin(frame.time * 0.21 + i) * 12;
      const x = Math.cos(birdA[i]) * r;
      const z = Math.sin(birdA[i]) * r;
      const y = birdY[i] + Math.sin(frame.time * 0.4 + i * 1.7) * 6;

      // Facing the way they are going: the tangent, whichever way round the
      // flock is drifting.
      const sw = birdW[i] < 0 ? -1 : 1;
      place(
        birds,
        i,
        x,
        y,
        z,
        Math.atan2(Math.sin(birdA[i]) * sw, -Math.cos(birdA[i]) * sw),
        Math.sin(frame.time * 0.6 + i) * 0.12,
        0,
      );
    }

    /* ---- upload -------------------------------------------------------- */
    /* Matrices up, and then the object-level bounds recomputed from them.
       Seventy-nine instances of eight corners is nothing, and it is what makes
       `Box3.setFromObject(tram)` agree with `tram.x` — without it the scene
       graph insists the whole fleet is a ten-metre box on the ice, which is
       both wrong and exactly the shape of a real bug worth catching. */
    for (const fleet of [cars, tramCars, birds]) {
      if (fleet.mesh.count === 0) continue;
      fleet.mesh.instanceMatrix.needsUpdate = true;
      fleet.mesh.computeBoundingBox();
      fleet.mesh.computeBoundingSphere();
    }
    lightPosAttr.needsUpdate = true;
  };

  return {
    name: "traffic",
    group,
    tram,
    stops,
    update,
    dispose() {
      for (const fleet of [cars, tramCars, platforms, birds]) {
        fleet.mesh.dispose();
        fleet.geo.dispose();
        group.remove(fleet.mesh);
      }
      lightGeo.dispose();
      lightMat.dispose();
      group.remove(lights);
      hullMat.dispose();
      birdMat.dispose();
    },
  };
}
