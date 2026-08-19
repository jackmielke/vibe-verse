/**
 * THE EMPYREAN — the air.
 *
 * Everything between the camera and the rest of the world: the weather it is
 * doing, the snow going past you sideways, the cloud banks the island is
 * standing on, the mist in the lake basin, the wind that moves all of it, the
 * birds turning below the rim, and the aurora and the meteors that make the
 * night worth climbing into.
 *
 * ## Why this is one system and not six
 *
 * They are one system because they are one *decision*. A squall is snow **and**
 * a low bank **and** fifteen metres a second of wind **and** birds that have
 * gone to roost **and** a fog density the engine has to add — and if those five
 * things are owned by five modules then the world spends its life in states
 * nobody chose, like snow in a still golden calm. One state machine, one set of
 * weights, everything reads the weights.
 *
 * ## The four rules this file was written against
 *
 * **Camera-relative or nothing.** The world is 9 km across and the snow box is
 * 144 m. Snow lives in a box pinned to the camera; particles wrap inside it and
 * are counter-advected by the camera's own motion, so a flake stays where it is
 * in the world while the box slides over it. A world-space snow field over 9 km
 * is not a budget question, it is an impossibility.
 *
 * **Nothing allocates in `update`.** Every vector, every array, every scratch
 * value below is made once at build. The snow's *entire* per-frame cost is four
 * uniform writes — the flake positions are static geometry and the animation is
 * a `mod()` in the vertex shader.
 *
 * **The palette lights everything.** `skyPalette()` is where the sky's colours
 * live and every particle here is tinted from it, every frame. Snow that is
 * white at midnight, or grey at a gold sunset, is the single loudest tell that
 * a particle system was pasted on top of a world instead of built inside one.
 *
 * **The city must stay readable.** This is an optimistic place. A blizzard you
 * cannot see the Beacon through is accurate and is a failed frame, so the snow
 * density, the cloud alpha and the fog boost are all capped well under what a
 * real squall would do, and the fog boost tapers off as you climb above the
 * basin so that mist over the ice never fogs the streets.
 *
 * ## Draw calls
 *
 * Six at high, five at low, and every one of them disappears entirely (a
 * `visible = false`, not a zero-alpha draw) the moment its condition weight
 * reaches zero:
 *
 * | thing | draw | high | low |
 * | --- | --- | --- | --- |
 * | snow | 1 `Points` | 6000 | 1500 |
 * | cloud banks + mist | 1 instanced quad | 420 | 140 |
 * | light shafts | 1 instanced quad | 36 | off |
 * | birds | 1 instanced quad pair | 66 | 14 |
 * | aurora | 1 `Mesh` | 5 ribbons | 3 ribbons |
 * | meteors | 1 `LineSegments` | 28 | 12 |
 */
import * as THREE from "three";

import type { BuildContext, FrameContext, System } from "./types";
import { GROUND_Y, ISLAND_Y, LAKE_R, PLATEAU_R, WATER_Y } from "./config";
import { districtAt, LANDMARKS, type DistrictId } from "./cityplan";
import { skyPalette } from "./sky";
import { clamp, clamp01, damp, makeRng, smoothstep, type Rng } from "@/shared/proc/rng";

/* =========================================================================
 * The contract
 * ====================================================================== */

export type Condition = "clear" | "high-cloud" | "snow" | "mist" | "calm";

export interface WeatherHandle extends System {
  readonly condition: Condition;
  /** 0..1 how far into the transition to `condition`. */
  readonly blend: number;
  /** Wind at a world position; systems that sway read this. */
  windAt(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3;
  /** Force a condition, for tests and for the capture harness. */
  force(c: Condition | null): void;
  /** Extra fog density this condition wants, added by the engine. */
  readonly fogBoost: number;
  /**
   * Switch the whole system off without tearing it down.
   *
   * Additive to the required API. The card-art camera and the low tier both
   * want a way to pay nothing at all for the air, and `visible = false` on six
   * groups plus an early return out of `update` is that way. `windAt` keeps
   * answering, because a banner that stops moving is a different bug.
   */
  setEnabled(on: boolean): void;
}

/** In the order the weight vector is indexed. Exported so tests can iterate. */
export const CONDITIONS: readonly Condition[] = [
  "clear",
  "high-cloud",
  "snow",
  "mist",
  "calm",
];

/* =========================================================================
 * The cycle
 * ====================================================================== */

/**
 * One slot of weather, and how long it takes to arrive.
 *
 * 260 seconds a slot against the engine's 1200-second day is a little under
 * five changes a day, and 90 seconds of transition means you never see the
 * weather *switch* — you notice, thirty seconds late, that the light has gone
 * flat and there is snow coming past the rail. A ten-second crossfade reads as
 * a bug in the renderer no matter how pretty each end of it is.
 */
const SLOT_SECONDS = 260;
const TRANSITION_SECONDS = 90;

/**
 * How fast a forced condition arrives.
 *
 * Deliberately quick, and deliberately not instant. `force()` exists for tests
 * and for `route-shot.mjs`, and the capture harness holds the frame for a few
 * seconds before it fires — but a hard cut would still make any *recorded*
 * capture (`route-gif.mjs`) open on a discontinuity.
 */
const FORCE_RATE = 1.8;

/**
 * How often each condition comes up, before the anti-repeat rule.
 *
 * Weighted toward the two that leave the city legible. Snow and mist together
 * are 28% of the cycle, which sounds low for a frozen lake and is about right
 * for a world somebody is going to spend twenty minutes in.
 */
const SLOT_ODDS = [0.3, 0.24, 0.16, 0.12, 0.18];

/** Integer hash, allocation-free — this runs once a frame forever. */
function hash1(n: number, salt: number): number {
  let h = (n | 0) ^ Math.imul(salt | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function pickFromOdds(r: number): number {
  let acc = 0;
  for (let i = 0; i < SLOT_ODDS.length; i++) {
    acc += SLOT_ODDS[i];
    if (r < acc) return i;
  }
  return SLOT_ODDS.length - 1;
}

/**
 * What the weather is in slot `n`, as an index into `CONDITIONS`.
 *
 * Pure in (slot, seed), so the whole cycle is reproducible from elapsed time
 * alone and a test can look a thousand slots into the future without simulating
 * one. Consecutive slots that agree simply extend the dwell, which is where the
 * long clear afternoons come from.
 *
 * The one piece of state in it: a heavy condition never immediately repeats. Two
 * squalls back to back is nine minutes of snow, and nine minutes of snow in a
 * world you are meant to be sightseeing in is a mood, not weather.
 */
function slotCondition(slot: number, seed: number): number {
  const idx = pickFromOdds(hash1(slot, seed));
  if (idx !== 2 && idx !== 3) return idx;
  const prev = pickFromOdds(hash1(slot - 1, seed));
  if (prev !== idx) return idx;
  // Reroll into the three light conditions, renormalised.
  const r = hash1(slot, seed ^ 0x5bf03635);
  const lightOdds = SLOT_ODDS[0] + SLOT_ODDS[1] + SLOT_ODDS[4];
  const x = r * lightOdds;
  if (x < SLOT_ODDS[0]) return 0;
  if (x < SLOT_ODDS[0] + SLOT_ODDS[1]) return 1;
  return 4;
}

/* =========================================================================
 * Per-condition constants
 * ====================================================================== */

/** Metres a second of horizontal wind, per condition. */
const WIND_SPEED = [4.5, 7.0, 15.0, 2.0, 1.2];

/**
 * Extra `FogExp2` density, per condition.
 *
 * The engine's own density runs 0.00009–0.00016 across the day, so mist at
 * 0.00022 roughly triples it and is the thickest thing here by a distance. It
 * is also the one that tapers with altitude — see `fogBoost`.
 */
const FOG_BOOST = [0.000005, 0.00002, 0.00011, 0.00022, 0.000015];

/** Snow density, per condition. Only the squall really snows. */
const SNOW_AMOUNT = [0.0, 0.05, 1.0, 0.1, 0.0];

/**
 * Opacity each of the five puff kinds wants, per condition.
 *
 * Rows are conditions in `CONDITIONS` order; columns are the puff kinds:
 * 0 high shelf (y≈470, just under the rim), 1 mid deck (y≈330), 2 low bank
 * (y≈190), 3 basin (y≈75, over the ice), 4 ground mist (y≈15, flat sheets).
 *
 * Read down column 0: there is *always* something under the island. That is the
 * single most important number in this file — an island floating over an empty
 * void reads as a model on a stand, and an island standing on a cloud shelf
 * reads as six hundred metres.
 */
const PUFF_OPACITY: readonly (readonly number[])[] = [
  /* clear      */ [0.16, 0.1, 0.05, 0.0, 0.0],
  /* high-cloud */ [1.0, 0.8, 0.32, 0.06, 0.04],
  /* snow       */ [0.7, 0.85, 0.9, 0.35, 0.22],
  /* mist       */ [0.35, 0.5, 0.8, 1.0, 1.0],
  /* calm       */ [0.42, 0.3, 0.12, 0.14, 0.2],
];

/** How sheltered a street is, by district. The rim gets the whole gale. */
const SHELTER: Record<DistrictId, number> = {
  halo: 0.32,
  core: 0.36,
  market: 0.55,
  gardens: 0.72,
  rim: 1.0,
};

/* =========================================================================
 * Tiers
 * ====================================================================== */

interface Tier {
  snow: number;
  snowHalf: THREE.Vector3;
  puffs: readonly number[];
  shafts: number;
  flocks: number;
  perFlock: number;
  ribbons: number;
  meteors: number;
}

const TIERS: Record<"low" | "high", Tier> = {
  high: {
    snow: 6000,
    snowHalf: new THREE.Vector3(72, 56, 72),
    puffs: [90, 90, 80, 70, 90],
    shafts: 36,
    flocks: 3,
    perFlock: 22,
    ribbons: 5,
    meteors: 28,
  },
  low: {
    snow: 1500,
    snowHalf: new THREE.Vector3(52, 42, 52),
    puffs: [30, 30, 26, 24, 30],
    shafts: 0,
    flocks: 1,
    perFlock: 14,
    ribbons: 3,
    meteors: 12,
  },
};

/* =========================================================================
 * Procedural textures
 * ====================================================================== */

/**
 * The soft blob every cloud puff is drawn with.
 *
 * No image files anywhere in this world, so it is a 64×64 `DataTexture` built
 * on the CPU: a smoothstepped radial falloff with a low-frequency lump in it,
 * so a bank of four hundred of these is not a field of four hundred identical
 * circles. Only the alpha channel is ever read.
 */
function buildPuffTexture(): THREE.DataTexture {
  const N = 64;
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const nx = ((x + 0.5) / N) * 2 - 1;
      const ny = ((y + 0.5) / N) * 2 - 1;
      const r = Math.sqrt(nx * nx + ny * ny);
      let a = clamp01(1 - r);
      a = a * a * (3 - 2 * a);
      const lump =
        0.72 +
        0.28 *
          (0.5 +
            0.5 * Math.sin(nx * 7.3 + ny * 4.1) * Math.cos(nx * 3.7 - ny * 6.2));
      a *= lump;
      const i = (y * N + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(clamp01(a) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.name = "EmpyreanPuff";
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/* =========================================================================
 * Small geometry helpers
 * ====================================================================== */

/** A unit quad in XY, indexed, with uvs. Not shared — see the note below. */
function quadGeometry(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
      3,
    ),
  );
  g.setAttribute(
    "uv",
    new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2),
  );
  g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
  // Built by hand rather than borrowed off a PlaneGeometry: disposing a shared
  // geometry frees the GPU buffers its attributes are sitting in, and two
  // instanced systems sharing one plane means the second one's dispose silently
  // deletes the first one's verts.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  return g;
}

const HAZE_MIX = /* glsl */ `
  vec3 hazed(vec3 col, float dist, vec3 fogCol, float density) {
    float f = 1.0 - exp(-density * density * dist * dist);
    return mix(col, fogCol, clamp(f, 0.0, 1.0));
  }
`;

/* =========================================================================
 * The system
 * ====================================================================== */

export function buildWeather(build: BuildContext): WeatherHandle {
  const tier = TIERS[build.quality === "low" ? "low" : "high"];
  const rng: Rng = makeRng(`empyrean:weather:${build.seedSalt}`);
  const seed = Math.floor(rng.next() * 0xffffffff) >>> 0;

  const group = new THREE.Group();
  group.name = "empyrean-weather";

  const puffTex = buildPuffTexture();

  /* ---- state ----------------------------------------------------------- */

  /** Live weight of each condition, in `CONDITIONS` order. Sums to 1. */
  const weight = [1, 0, 0, 0, 0];
  const schedW = [1, 0, 0, 0, 0];
  const forcedW = [0, 0, 0, 0, 0];
  let forced: Condition | null = null;
  let forceMix = 0;
  let curIndex = 0;
  let time = 0;
  let enabled = true;

  /* Derived once a frame and read by everything. */
  let snowAmount = 0;
  let windSpeed = 4.5;
  let fogBoostValue = 0;
  const kindOpacity = [0, 0, 0, 0, 0];

  /* ---- scratch --------------------------------------------------------- */
  const scratchWind = new THREE.Vector3();
  const prevCam = new THREE.Vector3(0, ISLAND_Y, 0);
  let camPrimed = false;

  /* =======================================================================
   * Wind
   * ==================================================================== */

  /**
   * The one exported vector, and the only part of this file anything else is
   * expected to call.
   *
   * Four terms, in the order they matter:
   *
   *  1. A large-scale direction that turns over minutes, times a gust field
   *     that varies in space as well as time — wind that is uniform across a
   *     680 m city is the thing that makes flags look like they are on rails.
   *  2. An altitude profile. It is calmer down among the buildings and windier
   *     the higher you climb, which is why the promenades are pleasant and the
   *     top of the Beacon is not.
   *  3. Shelter by district. The Halo and the Spires are enclosed enough to
   *     halve it; the Rim gets all of it. This only applies within about forty
   *     metres of the deck — fly up and the streets stop protecting you.
   *  4. Deflection round the island: air curls tangentially past a 340 m disc
   *     rather than through it, and it is pushed *up* the flank just outside
   *     the rim. That updraught is why snow at the parapet goes past you
   *     sideways and slightly upward instead of falling.
   *
   * Finite everywhere, including the axis (where the tangent is undefined) and
   * at coordinates far outside the world, because a `NaN` here becomes a `NaN`
   * position on a flake, which becomes a black screen with no error in it.
   */
  function windAt(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const t = time;

    // 1 — direction and gusts.
    const dir =
      1.9 + Math.sin(t * 0.0071) * 0.9 + Math.sin(t * 0.023 + 1.7) * 0.35;
    let speed = windSpeed;
    const gust =
      1 +
      0.32 * Math.sin(t * 0.47 + x * 0.004 + z * 0.0031) +
      0.16 * Math.sin(t * 1.13 + y * 0.011 + 2.4);
    speed *= gust > 0.15 ? gust : 0.15;

    // 2 — altitude. Reaches its ceiling about a kilometre up.
    const alt = clamp((y - GROUND_Y) / 900, 0, 2.2);
    speed *= 0.55 + 0.5 * alt;

    const r = Math.sqrt(x * x + z * z);

    // 3 — shelter, only near the deck and only over the city.
    if (r < PLATEAU_R + 30) {
      const near = 1 - smoothstep(30, 140, Math.abs(y - ISLAND_Y));
      if (near > 0) {
        const s = SHELTER[districtAt(Math.min(r, PLATEAU_R)).id];
        speed *= 1 + (s - 1) * near;
      }
    }

    let vx = Math.cos(dir) * speed;
    let vz = Math.sin(dir) * speed;
    let vy = Math.sin(t * 0.31 + r * 0.002) * speed * 0.06;

    // 4 — the island in the way. `prox` peaks at the rim and is exactly zero
    // by a kilometre out; `Math.exp(-Infinity)` is 0, which is why extreme
    // coordinates come back finite rather than NaN.
    const q = (r - PLATEAU_R) / 260;
    const prox = Math.exp(-q * q);
    if (prox > 1e-4) {
      const inv = r > 1e-3 ? 1 / r : 0;
      const nx = r > 1e-3 ? x * inv : 1;
      const nz = r > 1e-3 ? z * inv : 0;
      const tang = prox * speed * 0.55;
      vx += -nz * tang;
      vz += nx * tang;
      const dy = (y - (ISLAND_Y - 120)) / 300;
      vy += prox * Math.exp(-dy * dy) * speed * 0.34;
    }

    out.set(vx, vy, vz);
    // Belt and braces. Anything that reaches here non-finite got a non-finite
    // input, and a still flake is a better failure than an absent world.
    if (!Number.isFinite(out.x) || !Number.isFinite(out.y) || !Number.isFinite(out.z)) {
      out.set(0, 0, 0);
    }
    return out;
  }

  /* =======================================================================
   * Snow
   * ==================================================================== */

  /**
   * Six thousand flakes, one draw call, and four uniform writes a frame.
   *
   * The geometry never changes after build. Each flake has a fixed home inside
   * a box half the size of a city block, and the vertex shader computes
   *
   *     p = home + windDrift * var + camDrift
   *     p = mod(p + half, 2*half) - half
   *
   * so the box is an infinite tiling of itself and a flake that leaves the top
   * arrives at the bottom in the same frame. `windDrift` is integrated on the
   * CPU from `windAt` at the camera — one call, not six thousand — and
   * `camDrift` is the negated camera displacement, which is what keeps a flake
   * hanging in the world while you fly past it. They are separate uniforms
   * because only the wind term is scaled per flake: scale the camera term too
   * and boosting at 34 m/s turns a light fall into a blizzard.
   *
   * Both drifts are wrapped into the box on the CPU as well, so neither grows
   * without bound over an hour-long session and the `mod()` never loses its
   * mantissa.
   */
  const snowCount = tier.snow;
  const snowHalf = tier.snowHalf.clone();
  const snowGeo = new THREE.BufferGeometry();
  {
    const pos = new Float32Array(snowCount * 3);
    const seedA = new Float32Array(snowCount);
    const varA = new Float32Array(snowCount);
    const sizeA = new Float32Array(snowCount);
    for (let i = 0; i < snowCount; i++) {
      pos[i * 3] = (rng.next() * 2 - 1) * snowHalf.x;
      pos[i * 3 + 1] = (rng.next() * 2 - 1) * snowHalf.y;
      pos[i * 3 + 2] = (rng.next() * 2 - 1) * snowHalf.z;
      seedA[i] = rng.next();
      varA[i] = 0.8 + rng.next() * 0.5;
      // A handful of big near flakes among a lot of small ones is what stops
      // snow reading as television static.
      sizeA[i] = rng.next() < 0.12 ? 0.16 + rng.next() * 0.14 : 0.05 + rng.next() * 0.06;
    }
    snowGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    snowGeo.setAttribute("aSeed", new THREE.BufferAttribute(seedA, 1));
    snowGeo.setAttribute("aVar", new THREE.BufferAttribute(varA, 1));
    snowGeo.setAttribute("aSize", new THREE.BufferAttribute(sizeA, 1));
    snowGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  }

  const snowMat = new THREE.ShaderMaterial({
    name: "EmpyreanSnow",
    transparent: true,
    depthWrite: false,
    depthTest: true,
    fog: false,
    uniforms: {
      uWindDrift: { value: new THREE.Vector3() },
      uCamDrift: { value: new THREE.Vector3() },
      uHalf: { value: snowHalf.clone() },
      uTime: { value: 0 },
      uSwirl: { value: 0.6 },
      uOpacity: { value: 0 },
      uPointScale: { value: 800 },
      uLit: { value: new THREE.Color(0xffffff) },
      uShade: { value: new THREE.Color(0x8899bb) },
      uGold: { value: new THREE.Color(0xffd166) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uCamY: { value: ISLAND_Y },
      uIceY: { value: WATER_Y },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      attribute float aVar;
      attribute float aSize;
      uniform vec3 uWindDrift;
      uniform vec3 uCamDrift;
      uniform vec3 uHalf;
      uniform float uTime;
      uniform float uSwirl;
      uniform float uPointScale;
      uniform vec3 uLit, uShade, uGold, uSunDir;
      uniform float uCamY, uIceY;
      varying vec3 vColor;
      varying float vAlpha;

      void main() {
        vec3 p = position + uWindDrift * aVar + uCamDrift;
        // A bounded per-flake tumble, added before the wrap so it cannot push a
        // flake outside the tile.
        p += vec3(
          sin(uTime * 0.9 + aSeed * 39.0),
          sin(uTime * 0.61 + aSeed * 17.0) * 0.35,
          cos(uTime * 0.75 + aSeed * 23.0)
        ) * uSwirl;
        vec3 span = uHalf * 2.0;
        p = mod(p + uHalf, span) - uHalf;

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float dist = max(-mv.z, 0.001);
        gl_PointSize = clamp(aSize * uPointScale / dist, 1.0, 22.0);
        gl_Position = projectionMatrix * mv;

        // The object sits on the camera, so p *is* the camera-relative
        // direction to the flake — no extra matrix work to light it.
        vec3 wd = normalize(p + vec3(1e-5));
        float sunAmt = max(dot(wd, uSunDir), 0.0);
        vec3 col = mix(uShade, uLit, 0.5 + 0.5 * sunAmt);
        col += uGold * pow(sunAmt, 3.0) * 0.55;
        vColor = col;

        // Fade at the walls of the box, or the tile edge is a visible seam
        // sweeping through the air whenever you turn.
        vec3 e = 1.0 - abs(p) / uHalf;
        float edge = min(min(e.x, e.y), e.z);
        float a = smoothstep(0.0, 0.2, edge);
        // Nothing inside the near plane, nothing under the ice, nothing in the
        // thin air a long way above the cloud shelf.
        a *= smoothstep(0.5, 3.0, dist);
        float wy = uCamY + p.y;
        a *= smoothstep(-2.0, 8.0, wy - uIceY);
        a *= 1.0 - smoothstep(${(ISLAND_Y + 900).toFixed(1)}, ${(ISLAND_Y + 1700).toFixed(1)}, wy);
        vAlpha = a;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uOpacity;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r2 = dot(d, d) * 4.0;
        float a = smoothstep(1.0, 0.12, r2);
        float o = a * vAlpha * uOpacity;
        if (o <= 0.002) discard;
        gl_FragColor = vec4(vColor, o);
      }
    `,
  });

  const snowPoints = new THREE.Points(snowGeo, snowMat);
  snowPoints.name = "empyrean-snow-volume";
  snowPoints.frustumCulled = false;
  snowPoints.renderOrder = 12;
  snowPoints.visible = false;
  group.add(snowPoints);

  const windDrift = new THREE.Vector3();
  const camDrift = new THREE.Vector3();

  /* =======================================================================
   * Cloud banks, basin fog and ground mist
   * ==================================================================== */

  /**
   * Four hundred soft quads at five altitudes, all in one instanced draw.
   *
   * The deck is at 620 m. Kinds 0–2 are three shelves at 470, 330 and 190 —
   * close enough together that dropping off the rim takes you through all three
   * inside four seconds, which is the whole point of them. Kind 3 is the basin
   * fog that fills the bowl the lake sits in, and kind 4 is the flat sheet on
   * the ice itself, which is horizontal rather than billboarded because from
   * six hundred metres up you are looking *down* at it and a billboard seen
   * from directly above is a line.
   *
   * They are alpha-blended with no sorting between instances, which is a lie
   * that works: every puff in a bank is within a few percent of every other
   * puff's colour, so the order they composite in is not something an eye can
   * find. What it cannot survive is high per-puff alpha, so each one is capped
   * around 0.2 and the bank is built out of overlap instead.
   */
  const puffTotal = tier.puffs.reduce((a, b) => a + b, 0);
  const puffGeo = quadGeometry();
  const puffKind = new Uint8Array(puffTotal);
  const puffVar = new Float32Array(puffTotal);
  const puffOpacArr = new Float32Array(puffTotal);
  const puffOpacAttr = new THREE.InstancedBufferAttribute(puffOpacArr, 1);
  puffOpacAttr.setUsage(THREE.DynamicDrawUsage);
  {
    const iPos = new Float32Array(puffTotal * 3);
    const iScale = new Float32Array(puffTotal * 2);
    const iRot = new Float32Array(puffTotal);
    const iKind = new Float32Array(puffTotal);

    /** y, spread, and size range for each of the five kinds. */
    const KIND_PLAN = [
      { y: 470, jitter: 46, r0: 130, r1: 3000, w0: 260, w1: 560, h: 0.42 },
      { y: 330, jitter: 42, r0: 120, r1: 2700, w0: 240, w1: 520, h: 0.44 },
      { y: 190, jitter: 40, r0: 110, r1: 2400, w0: 220, w1: 480, h: 0.46 },
      { y: 76, jitter: 34, r0: 0, r1: LAKE_R * 1.15, w0: 320, w1: 720, h: 0.3 },
      { y: 16, jitter: 11, r0: 0, r1: LAKE_R * 1.1, w0: 420, w1: 900, h: 1.0 },
    ];

    let n = 0;
    for (let k = 0; k < 5; k++) {
      const plan = KIND_PLAN[k];
      for (let i = 0; i < tier.puffs[k]; i++) {
        const a = rng.next() * Math.PI * 2;
        // sqrt so the ring fills evenly in area rather than crowding the axis.
        const rr = plan.r0 + (plan.r1 - plan.r0) * Math.sqrt(rng.next());
        const w = plan.w0 + (plan.w1 - plan.w0) * rng.next();
        iPos[n * 3] = Math.cos(a) * rr;
        iPos[n * 3 + 1] = plan.y + (rng.next() * 2 - 1) * plan.jitter;
        iPos[n * 3 + 2] = Math.sin(a) * rr;
        iScale[n * 2] = w;
        iScale[n * 2 + 1] = w * plan.h;
        iRot[n] = rng.next() * Math.PI * 2;
        iKind[n] = k;
        puffKind[n] = k;
        puffVar[n] = 0.7 + rng.next() * 0.6;
        n++;
      }
    }

    puffGeo.instanceCount = puffTotal;
    puffGeo.setAttribute("iPos", new THREE.InstancedBufferAttribute(iPos, 3));
    puffGeo.setAttribute("iScale", new THREE.InstancedBufferAttribute(iScale, 2));
    puffGeo.setAttribute("iRot", new THREE.InstancedBufferAttribute(iRot, 1));
    puffGeo.setAttribute("iKind", new THREE.InstancedBufferAttribute(iKind, 1));
    puffGeo.setAttribute("iOpac", puffOpacAttr);
  }

  const puffMat = new THREE.ShaderMaterial({
    name: "EmpyreanClouds",
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    fog: false,
    uniforms: {
      uMap: { value: puffTex },
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uLit: { value: new THREE.Color(0xffffff) },
      uShade: { value: new THREE.Color(0x6a5a86) },
      uGold: { value: new THREE.Color(0xffd166) },
      uFog: { value: new THREE.Color(0xf3bfb2) },
      uHaze: { value: 0.00013 },
      uPeak: { value: 0.2 },
    },
    vertexShader: /* glsl */ `
      attribute vec3 iPos;
      attribute vec2 iScale;
      attribute float iRot;
      attribute float iKind;
      attribute float iOpac;
      uniform float uTime;
      uniform vec3 uSunDir, uLit, uShade, uGold, uFog;
      uniform float uHaze, uPeak;
      varying vec2 vUv;
      varying vec3 vColor;
      varying float vAlpha;

      ${HAZE_MIX}

      void main() {
        vUv = uv;

        // A very slow drift, so a bank is never a decal.
        vec3 centre = iPos + vec3(sin(uTime * 0.013 + iRot) * 26.0, 0.0,
                                  cos(uTime * 0.011 + iRot) * 22.0);

        vec2 q = vec2(position.x * iScale.x, position.y * iScale.y);
        float ca = cos(iRot), sa = sin(iRot);
        vec2 qr = vec2(q.x * ca - q.y * sa, q.x * sa + q.y * ca);

        vec3 wpos;
        if (iKind < 3.5) {
          // Camera-facing. Columns of the view matrix are the camera's basis.
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          wpos = centre + right * qr.x + up * qr.y;
        } else {
          // Flat on the ice.
          wpos = centre + vec3(qr.x, 0.0, qr.y);
        }

        vec3 toCam = cameraPosition - wpos;
        float dist = length(toCam);
        vec3 vd = -toCam / max(dist, 0.001);
        float sunAmt = max(dot(vd, uSunDir), 0.0);

        // Lit on top, shaded underneath — the flat-bottomed cumulus the sky
        // dome draws, in geometry, so the two agree where they meet.
        float vTop = (iKind < 3.5) ? (position.y + 0.5) : 0.55;
        vec3 col = mix(uShade, uLit, mix(0.22, 1.0, vTop));
        col += uGold * pow(sunAmt, 4.0) * 0.9;
        col = hazed(col, dist, uFog, uHaze);
        vColor = col;

        // Fade out as the camera enters the puff. Without this, flying into a
        // bank is one frame of clear air and one frame of full-screen grey.
        float near = smoothstep(iScale.x * 0.08, iScale.x * 0.42, dist);
        vAlpha = iOpac * uPeak * near;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D uMap;
      varying vec2 vUv;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float a = texture2D(uMap, vUv).a * vAlpha;
        if (a <= 0.003) discard;
        gl_FragColor = vec4(vColor, a);
      }
    `,
  });

  const puffMesh = new THREE.Mesh(puffGeo, puffMat);
  puffMesh.name = "empyrean-cloudbanks";
  puffMesh.frustumCulled = false;
  puffMesh.renderOrder = 8;
  group.add(puffMesh);

  /* =======================================================================
   * Light shafts
   * ==================================================================== */

  /**
   * Crepuscular rays, done as geometry rather than as a post pass.
   *
   * Real volumetrics are a depth-aware radial blur and they belong in
   * `postfx.ts`, which this file does not own and must not reach into. What is
   * available here is the cheap version that has always worked: elongated
   * additive quads hanging off the cloud shelves, oriented along the *live* sun
   * direction in the vertex shader — so they swing round as the day turns — and
   * gated on `pow(dot(view, sun), 8)` so they only exist while you are looking
   * into the sun, which is the only time a shaft is visible in the real world
   * either.
   *
   * They cost 36 instances in one additive draw and they are off entirely on
   * the low tier and whenever the sun is high, because a shaft from a sun
   * overhead is a vertical stripe and reads as a bug.
   */
  const shaftCount = tier.shafts;
  const shaftGeo = quadGeometry();
  if (shaftCount > 0) {
    const iPos = new Float32Array(shaftCount * 3);
    const iScale = new Float32Array(shaftCount * 2);
    const iVar = new Float32Array(shaftCount);
    for (let i = 0; i < shaftCount; i++) {
      const a = rng.next() * Math.PI * 2;
      const rr = 150 + 1650 * Math.sqrt(rng.next());
      iPos[i * 3] = Math.cos(a) * rr;
      iPos[i * 3 + 1] = 300 + rng.next() * 200;
      iPos[i * 3 + 2] = Math.sin(a) * rr;
      iScale[i * 2] = 28 + rng.next() * 62;
      iScale[i * 2 + 1] = 260 + rng.next() * 420;
      iVar[i] = 0.5 + rng.next() * 0.5;
    }
    shaftGeo.instanceCount = shaftCount;
    shaftGeo.setAttribute("iPos", new THREE.InstancedBufferAttribute(iPos, 3));
    shaftGeo.setAttribute("iScale", new THREE.InstancedBufferAttribute(iScale, 2));
    shaftGeo.setAttribute("iVar", new THREE.InstancedBufferAttribute(iVar, 1));
  } else {
    shaftGeo.instanceCount = 0;
  }

  const shaftMat = new THREE.ShaderMaterial({
    name: "EmpyreanShafts",
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uGold: { value: new THREE.Color(0xffd166) },
      uStrength: { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute vec3 iPos;
      attribute vec2 iScale;
      attribute float iVar;
      uniform vec3 uSunDir;
      uniform float uStrength;
      varying float vAlpha;
      varying float vAlong;
      varying float vAcross;

      void main() {
        vAcross = position.x * 2.0;
        vec3 axis = normalize(-uSunDir);
        vec3 toCam = cameraPosition - iPos;
        float d = length(toCam);
        vec3 view = -toCam / max(d, 0.001);
        vec3 side = cross(axis, view);
        float sl = length(side);
        side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);

        float along = position.y + 0.5;          // 0 at the cloud, 1 at the tip
        vAlong = along;
        vec3 wpos = iPos + side * (position.x * iScale.x) + axis * (along * iScale.y);

        float sunAmt = max(dot(view, uSunDir), 0.0);
        vAlpha = uStrength * iVar * pow(sunAmt, 8.0);

        gl_Position = projectionMatrix * viewMatrix * vec4(wpos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uGold;
      varying float vAlpha;
      varying float vAlong;
      varying float vAcross;
      void main() {
        // Soft across the width, tapering to nothing along the length. Hard
        // edges on a light shaft are the difference between a god ray and a
        // triangle somebody left in the sky.
        float across = 1.0 - smoothstep(0.25, 1.0, abs(vAcross));
        float taper = 1.0 - vAlong;
        float a = vAlpha * across * taper * taper;
        if (a <= 0.002) discard;
        gl_FragColor = vec4(uGold * a * 1.6, a);
      }
    `,
  });

  const shaftMesh = new THREE.Mesh(shaftGeo, shaftMat);
  shaftMesh.name = "empyrean-shafts";
  shaftMesh.frustumCulled = false;
  shaftMesh.renderOrder = 9;
  shaftMesh.visible = false;
  group.add(shaftMesh);

  /* =======================================================================
   * Birds
   * ==================================================================== */

  /**
   * Three flocks of twenty-two, circling below the rim.
   *
   * Nothing sells six hundred metres like something alive *underneath* you, and
   * a bird is the cheapest object in this world: two triangles, flapped in the
   * vertex shader from a per-instance phase, lit as a near-silhouette off the
   * sky palette. Sixty-six of them in one instanced draw.
   *
   * The boids are the cheap kind on purpose. Cohesion and alignment run against
   * the flock's centroid and mean velocity — O(n), computed once per flock —
   * and separation only checks the four birds after this one in the array,
   * which is not correct and is completely indistinguishable at this distance.
   * On top of that sit three behaviours that are the actual point:
   *
   *  - **Circling.** Each flock seeks a point orbiting the island at its own
   *    radius, altitude and rate.
   *  - **Roosting.** Below a quarter daylight they head for a landmark and
   *    slow to a hover over it, which turns dusk into something you can watch
   *    happen rather than a light change.
   *  - **Scattering.** Fly within forty-five metres and the flock blows apart
   *    for two seconds. It is the only thing in this world that reacts to the
   *    player being *fast*, and it is worth the twelve lines.
   */
  const flockCount = tier.flocks;
  const perFlock = tier.perFlock;
  const birdCount = flockCount * perFlock;

  const birdPos = new Float32Array(birdCount * 3);
  const birdVel = new Float32Array(birdCount * 3);
  const flockScatter = new Float32Array(flockCount);
  const flockPhase = new Float32Array(flockCount);
  const flockRadius = new Float32Array(flockCount);
  const flockOmega = new Float32Array(flockCount);
  const flockAlt = new Float32Array(flockCount);
  const flockRoost = new Float32Array(flockCount * 3);

  for (let f = 0; f < flockCount; f++) {
    flockPhase[f] = rng.next() * Math.PI * 2;
    flockRadius[f] = 420 + rng.next() * 480;
    flockOmega[f] = (rng.next() < 0.5 ? -1 : 1) * (0.028 + rng.next() * 0.03);
    // Mostly below the deck: the shot is looking *down* at them.
    flockAlt[f] = ISLAND_Y - 60 - rng.next() * 230;
    const lm = LANDMARKS[Math.floor(rng.next() * LANDMARKS.length) % LANDMARKS.length];
    flockRoost[f * 3] = lm.x;
    flockRoost[f * 3 + 1] = ISLAND_Y + 40 + rng.next() * 110;
    flockRoost[f * 3 + 2] = lm.z;
    for (let i = 0; i < perFlock; i++) {
      const b = f * perFlock + i;
      const a = rng.next() * Math.PI * 2;
      birdPos[b * 3] = Math.cos(flockPhase[f]) * flockRadius[f] + (rng.next() * 2 - 1) * 40;
      birdPos[b * 3 + 1] = flockAlt[f] + (rng.next() * 2 - 1) * 25;
      birdPos[b * 3 + 2] = Math.sin(flockPhase[f]) * flockRadius[f] + (rng.next() * 2 - 1) * 40;
      birdVel[b * 3] = Math.cos(a) * 10;
      birdVel[b * 3 + 1] = (rng.next() * 2 - 1) * 1.2;
      birdVel[b * 3 + 2] = Math.sin(a) * 10;
    }
  }

  const birdGeo = new THREE.InstancedBufferGeometry();
  {
    // Two triangles sharing the nose–tail spine. `aWing` is 0 on the spine and
    // ±1 at the tips, which is all the flap needs to know.
    const NOSE = 0.34;
    const TAIL = -0.3;
    const SPAN = 0.62;
    const verts = new Float32Array([
      0, 0, NOSE, 0, 0, TAIL, -SPAN, 0, 0,
      0, 0, NOSE, SPAN, 0, 0, 0, 0, TAIL,
    ]);
    const wing = new Float32Array([0, 0, -1, 0, 1, 0]);
    birdGeo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
    birdGeo.setAttribute("aWing", new THREE.BufferAttribute(wing, 1));

    const iScale = new Float32Array(birdCount);
    const iPhase = new Float32Array(birdCount);
    const iFlap = new Float32Array(birdCount);
    for (let b = 0; b < birdCount; b++) {
      iScale[b] = 1.5 + rng.next() * 1.4;
      iPhase[b] = rng.next() * Math.PI * 2;
      iFlap[b] = 6.5 + rng.next() * 4.5;
    }
    birdGeo.instanceCount = birdCount;
    birdGeo.setAttribute("iScale", new THREE.InstancedBufferAttribute(iScale, 1));
    birdGeo.setAttribute("iPhase", new THREE.InstancedBufferAttribute(iPhase, 1));
    birdGeo.setAttribute("iFlap", new THREE.InstancedBufferAttribute(iFlap, 1));
    birdGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  }
  const birdPosAttr = new THREE.InstancedBufferAttribute(birdPos, 3);
  birdPosAttr.setUsage(THREE.DynamicDrawUsage);
  const birdFwdArr = new Float32Array(birdCount * 3);
  for (let b = 0; b < birdCount; b++) birdFwdArr[b * 3] = 1;
  const birdFwdAttr = new THREE.InstancedBufferAttribute(birdFwdArr, 3);
  birdFwdAttr.setUsage(THREE.DynamicDrawUsage);
  birdGeo.setAttribute("iPos", birdPosAttr);
  birdGeo.setAttribute("iFwd", birdFwdAttr);

  const birdMat = new THREE.ShaderMaterial({
    name: "EmpyreanBirds",
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    fog: false,
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uLit: { value: new THREE.Color(0xffffff) },
      uShade: { value: new THREE.Color(0x6a5a86) },
      uFog: { value: new THREE.Color(0xf3bfb2) },
      uHaze: { value: 0.00013 },
      uOpacity: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute float aWing;
      attribute vec3 iPos;
      attribute vec3 iFwd;
      attribute float iScale;
      attribute float iPhase;
      attribute float iFlap;
      uniform float uTime;
      uniform vec3 uSunDir, uLit, uShade, uFog;
      uniform float uHaze, uOpacity;
      varying vec3 vColor;
      varying float vAlpha;

      ${HAZE_MIX}

      void main() {
        vec3 p = position;
        if (abs(aWing) > 0.5) {
          float a = sin(uTime * iFlap + iPhase) * 0.8;
          float s = sin(a), c = cos(a);
          // Both tips rise together — hinge on the spine, not on the origin.
          p.y = p.y * c + abs(p.x) * s;
          p.x = p.x * c;
        }

        vec3 f = normalize(iFwd + vec3(1e-5, 0.0, 0.0));
        vec3 r = cross(f, vec3(0.0, 1.0, 0.0));
        float rl = length(r);
        r = rl > 1e-3 ? r / rl : vec3(1.0, 0.0, 0.0);
        vec3 u = cross(r, f);
        vec3 wpos = iPos + (r * p.x + u * p.y + f * p.z) * iScale;

        vec3 toCam = cameraPosition - wpos;
        float dist = length(toCam);
        vec3 vd = -toCam / max(dist, 0.001);
        float sunAmt = max(dot(vd, uSunDir), 0.0);

        // Near-silhouettes. They pick up the sky when you are looking through
        // them at the sun and go almost black against the ice.
        vec3 col = mix(uShade * 0.3, uLit * 0.7, pow(sunAmt, 2.0));
        vColor = hazed(col, dist, uFog, uHaze);
        vAlpha = uOpacity * (1.0 - smoothstep(1500.0, 2600.0, dist)) *
                 smoothstep(4.0, 14.0, dist);

        gl_Position = projectionMatrix * viewMatrix * vec4(wpos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        if (vAlpha <= 0.004) discard;
        gl_FragColor = vec4(vColor, vAlpha);
      }
    `,
  });

  const birdMesh = new THREE.Mesh(birdGeo, birdMat);
  birdMesh.name = "empyrean-birds";
  birdMesh.frustumCulled = false;
  birdMesh.renderOrder = 6;
  group.add(birdMesh);

  /* =======================================================================
   * Aurora
   * ==================================================================== */

  /**
   * Five curtains over the ranges, from 1500 m to 4200 m.
   *
   * `sky.ts` owns the dome and this file must not touch it, so the aurora is
   * real geometry a long way out — a set of wavy vertical ribbons at 5.2 km on
   * the far side of the world from the sunset. That is not a workaround: it
   * means it has *parallax*, so climbing three hundred metres to look at it
   * actually changes what you see, which a shader on a camera-pinned sphere can
   * never do.
   *
   * Additive, alpha driven by the palette's own `stars` value, so it fades in
   * as the sky darkens rather than switching on at an hour somebody picked.
   */
  const auroraGeo = new THREE.BufferGeometry();
  {
    const ribbons = tier.ribbons;
    const SEG = 46;
    const verts = (SEG + 1) * 2 * ribbons;
    const pos = new Float32Array(verts * 3);
    const aU = new Float32Array(verts);
    const aV = new Float32Array(verts);
    const aRib = new Float32Array(verts);
    const idx: number[] = [];
    let v = 0;
    for (let rb = 0; rb < ribbons; rb++) {
      const radius = 4600 + rng.next() * 1400;
      const a0 = Math.PI * 0.28 - 1.15 + (rng.next() * 2 - 1) * 0.35;
      const sweep = 1.5 + rng.next() * 0.9;
      const y0 = 1400 + rng.next() * 500;
      const y1 = y0 + 1700 + rng.next() * 1300;
      const wob = 180 + rng.next() * 260;
      const wobF = 2.0 + rng.next() * 3.0;
      const base = v;
      for (let s = 0; s <= SEG; s++) {
        const t = s / SEG;
        const a = a0 + sweep * t;
        const rr = radius + Math.sin(t * Math.PI * wobF + rb * 2.1) * wob;
        const x = Math.cos(a) * rr;
        const z = Math.sin(a) * rr;
        for (let e = 0; e < 2; e++) {
          const y = e === 0 ? y0 : y1;
          pos[v * 3] = x;
          pos[v * 3 + 1] = y;
          pos[v * 3 + 2] = z;
          aU[v] = t;
          aV[v] = e;
          aRib[v] = rb;
          v++;
        }
      }
      for (let s = 0; s < SEG; s++) {
        const i0 = base + s * 2;
        idx.push(i0, i0 + 1, i0 + 3, i0, i0 + 3, i0 + 2);
      }
    }
    auroraGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    auroraGeo.setAttribute("aU", new THREE.BufferAttribute(aU, 1));
    auroraGeo.setAttribute("aV", new THREE.BufferAttribute(aV, 1));
    auroraGeo.setAttribute("aRib", new THREE.BufferAttribute(aRib, 1));
    auroraGeo.setIndex(idx);
    auroraGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2800, 0), 9000);
  }

  const auroraMat = new THREE.ShaderMaterial({
    name: "EmpyreanAurora",
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
    uniforms: {
      uTime: { value: 0 },
      uStrength: { value: 0 },
      uLow: { value: new THREE.Color(0x4dffb0) },
      uMid: { value: new THREE.Color(0x35d8d0) },
      uHigh: { value: new THREE.Color(0xb06cff) },
    },
    vertexShader: /* glsl */ `
      attribute float aU;
      attribute float aV;
      attribute float aRib;
      uniform float uTime;
      varying float vU, vV, vRib;
      void main() {
        vU = aU; vV = aV; vRib = aRib;
        vec3 p = position;
        // The whole curtain leans and breathes.
        p.y += sin(uTime * 0.07 + aU * 6.0 + aRib) * 90.0 * aV;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uTime, uStrength;
      uniform vec3 uLow, uMid, uHigh;
      varying float vU, vV, vRib;
      void main() {
        // Vertical rays sweeping along the curtain: three sines beating against
        // each other is enough, and it costs nothing.
        float rays =
          0.55 + 0.45 * sin(vU * 61.0 + uTime * 0.35 + vRib * 3.1);
        rays *= 0.6 + 0.4 * sin(vU * 23.0 - uTime * 0.19 + vRib);
        rays = clamp(rays, 0.0, 1.0);

        // Bright at the base, gone at the top, and gone at both ends.
        float up = 1.0 - vV;
        float band = pow(up, 1.6) * smoothstep(0.0, 0.12, vU) * (1.0 - smoothstep(0.86, 1.0, vU));

        vec3 col = mix(uLow, uMid, smoothstep(0.0, 0.45, vV));
        col = mix(col, uHigh, smoothstep(0.5, 1.0, vV));

        float a = uStrength * band * rays * 0.55;
        if (a <= 0.002) discard;
        gl_FragColor = vec4(col * a * 1.5, a);
      }
    `,
  });

  const auroraMesh = new THREE.Mesh(auroraGeo, auroraMat);
  auroraMesh.name = "empyrean-aurora";
  auroraMesh.frustumCulled = false;
  auroraMesh.renderOrder = 4;
  auroraMesh.visible = false;
  group.add(auroraMesh);

  /**
   * How much aurora there is *tonight*, on a slow envelope.
   *
   * Half an hour of period, seeded, so two consecutive nights are not the same
   * night. An aurora that is always at full strength stops being an event on
   * the second viewing.
   */
  const auroraPhase = rng.next() * Math.PI * 2;

  /* =======================================================================
   * Meteors
   * ==================================================================== */

  /**
   * Twenty-eight streaks, pinned over the camera.
   *
   * A `LineSegments` of two verts each — fifty-six positions, rewritten on the
   * CPU each frame, which is nothing. The group tracks the camera in X and Z
   * but not in Y, so the shower is always overhead wherever you fly without
   * ever being at your altitude. World-space would put the whole shower over
   * the ranges and you would have to know to look there.
   */
  const meteorMax = tier.meteors;
  const meteorPos = new Float32Array(meteorMax * 6);
  const meteorFade = new Float32Array(meteorMax * 2);
  const meteorLife = new Float32Array(meteorMax);
  const meteorVel = new Float32Array(meteorMax * 3);
  const meteorLen = new Float32Array(meteorMax);
  let meteorTimer = 0;

  const meteorGeo = new THREE.BufferGeometry();
  const meteorPosAttr = new THREE.BufferAttribute(meteorPos, 3);
  meteorPosAttr.setUsage(THREE.DynamicDrawUsage);
  const meteorFadeAttr = new THREE.BufferAttribute(meteorFade, 1);
  meteorFadeAttr.setUsage(THREE.DynamicDrawUsage);
  meteorGeo.setAttribute("position", meteorPosAttr);
  meteorGeo.setAttribute("aFade", meteorFadeAttr);
  meteorGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

  const meteorMat = new THREE.ShaderMaterial({
    name: "EmpyreanMeteors",
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: {
      uHead: { value: new THREE.Color(0xfff2d0) },
      uTail: { value: new THREE.Color(0x8fb6ff) },
      uStrength: { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute float aFade;
      varying float vFade;
      void main() {
        vFade = aFade;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uHead, uTail;
      uniform float uStrength;
      varying float vFade;
      void main() {
        float a = vFade * uStrength;
        if (a <= 0.003) discard;
        vec3 col = mix(uTail, uHead, vFade);
        gl_FragColor = vec4(col * a * 2.2, a);
      }
    `,
  });

  const meteorLines = new THREE.LineSegments(meteorGeo, meteorMat);
  meteorLines.name = "empyrean-meteors";
  meteorLines.frustumCulled = false;
  meteorLines.renderOrder = 5;
  meteorLines.visible = false;
  group.add(meteorLines);

  /* =======================================================================
   * Weights
   * ==================================================================== */

  /**
   * The schedule, evaluated analytically at `t`.
   *
   * No accumulator and no per-frame state: given the same seed and the same
   * elapsed time you get the same weather on any machine, at any frame rate,
   * having skipped any number of frames. That is what lets a test assert the
   * cycle a thousand slots out without simulating it, and it is why `force()`
   * can be released and have the world land exactly where it would have been.
   */
  function evaluateSchedule(t: number): void {
    const tt = t > 0 ? t : 0;
    const slot = Math.floor(tt / SLOT_SECONDS);
    const local = tt - slot * SLOT_SECONDS;
    const to = slotCondition(slot, seed);
    const from = slotCondition(slot - 1, seed);
    let k = local < TRANSITION_SECONDS ? local / TRANSITION_SECONDS : 1;
    k = k * k * (3 - 2 * k);
    if (from === to) k = 1;
    for (let i = 0; i < 5; i++) schedW[i] = 0;
    schedW[from] += 1 - k;
    schedW[to] += k;
    curIndex = to;
  }

  /** Roll the derived numbers everything else reads. Cheap; no allocation. */
  function derive(camY: number, dayPhase: number): void {
    let snow = 0;
    let wind = 0;
    let fogB = 0;
    for (let k = 0; k < 5; k++) kindOpacity[k] = 0;
    for (let i = 0; i < 5; i++) {
      const w = weight[i];
      if (w <= 0) continue;
      snow += SNOW_AMOUNT[i] * w;
      wind += WIND_SPEED[i] * w;
      fogB += FOG_BOOST[i] * w;
      const row = PUFF_OPACITY[i];
      for (let k = 0; k < 5; k++) kindOpacity[k] += row[k] * w;
    }

    // Ground mist is a dawn and a small-hours thing. `dayPhase` 0.25 is dawn;
    // the second lobe is the middle of the night, when the basin has had all
    // night to fill.
    const p = ((dayPhase % 1) + 1) % 1;
    const dawn = Math.exp(-Math.pow((p - 0.22) / 0.09, 2));
    const small = Math.exp(-Math.pow((p - 0.94) / 0.13, 2));
    const mistHour = 0.4 + 0.6 * clamp01(dawn + small);
    kindOpacity[3] *= mistHour;
    kindOpacity[4] *= mistHour;

    snowAmount = clamp01(snow);
    windSpeed = wind;

    /* The fog boost tapers as you climb out of the basin. Mist over the ice is
     * a beautiful thing to fly down into and a catastrophe if it also fogs the
     * Bazaar — and the engine only has one global density, so the taper has to
     * happen here, where the camera height is known. */
    const basin = 1 - smoothstep(140, 520, camY);
    const mistShare = FOG_BOOST[3] * weight[3] + FOG_BOOST[2] * weight[2] * 0.4;
    fogBoostValue = fogB - mistShare * (1 - basin) * 0.85;
    if (fogBoostValue < 0) fogBoostValue = 0;
    // Hard ceiling. Past this the far ranges vanish and so does the picture.
    if (fogBoostValue > 0.00024) fogBoostValue = 0.00024;
  }

  evaluateSchedule(0);
  for (let i = 0; i < 5; i++) weight[i] = schedW[i];
  derive(ISLAND_Y, 0.75);

  /* =======================================================================
   * Birds — the step
   * ==================================================================== */

  function stepBirds(ctx: FrameContext): void {
    const dt = ctx.dt;
    const px = ctx.player.position.x;
    const py = ctx.player.position.y;
    const pz = ctx.player.position.z;
    const roosting = ctx.daylight < 0.26;

    for (let f = 0; f < flockCount; f++) {
      // Centroid and mean velocity: one pass, no allocation.
      let cx = 0, cy = 0, cz = 0, mx = 0, my = 0, mz = 0;
      for (let i = 0; i < perFlock; i++) {
        const b = (f * perFlock + i) * 3;
        cx += birdPos[b];
        cy += birdPos[b + 1];
        cz += birdPos[b + 2];
        mx += birdVel[b];
        my += birdVel[b + 1];
        mz += birdVel[b + 2];
      }
      const inv = 1 / perFlock;
      cx *= inv; cy *= inv; cz *= inv;
      mx *= inv; my *= inv; mz *= inv;

      // Where the flock is going.
      let tx: number, ty: number, tz: number;
      if (roosting) {
        tx = flockRoost[f * 3];
        ty = flockRoost[f * 3 + 1];
        tz = flockRoost[f * 3 + 2];
      } else {
        const a = flockPhase[f] + time * flockOmega[f];
        tx = Math.cos(a) * flockRadius[f];
        ty = flockAlt[f] + Math.sin(time * 0.11 + flockPhase[f]) * 36;
        tz = Math.sin(a) * flockRadius[f];
      }

      const scattered = flockScatter[f] > 0;
      if (scattered) flockScatter[f] = Math.max(0, flockScatter[f] - dt);

      const cohesion = scattered ? 0.05 : 0.55;
      const align = scattered ? 0.2 : 1.1;
      const seek = scattered ? 0.15 : roosting ? 1.4 : 0.9;
      const maxSpeed = scattered ? 26 : roosting ? 5 : 16;
      const minSpeed = roosting ? 0.4 : 6;

      for (let i = 0; i < perFlock; i++) {
        const b = (f * perFlock + i) * 3;
        const x = birdPos[b];
        const y = birdPos[b + 1];
        const z = birdPos[b + 2];

        let ax = (cx - x) * cohesion + (mx - birdVel[b]) * align;
        let ay = (cy - y) * cohesion + (my - birdVel[b + 1]) * align;
        let az = (cz - z) * cohesion + (mz - birdVel[b + 2]) * align;

        // Seek, normalised so a distant target does not launch them.
        const sx = tx - x, sy = ty - y, sz = tz - z;
        const sd = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
        ax += (sx / sd) * seek * 14;
        ay += (sy / sd) * seek * 14;
        az += (sz / sd) * seek * 14;

        // Separation against the next four in the array. Wrong, and invisible.
        for (let k = 1; k <= 4; k++) {
          const j = (f * perFlock + ((i + k) % perFlock)) * 3;
          const dx = x - birdPos[j];
          const dy = y - birdPos[j + 1];
          const dz = z - birdPos[j + 2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < 90 && d2 > 1e-4) {
            const s = 26 / d2;
            ax += dx * s;
            ay += dy * s;
            az += dz * s;
          }
        }

        // The player, going past.
        const dx = x - px, dy = y - py, dz = z - pz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 45 * 45) {
          const d = Math.sqrt(d2) || 1;
          const push = (1 - d / 45) * 160;
          ax += (dx / d) * push;
          ay += (dy / d) * push + 20;
          az += (dz / d) * push;
          flockScatter[f] = 2.0;
        }

        let vx = birdVel[b] + ax * dt;
        let vy = birdVel[b + 1] + ay * dt;
        let vz = birdVel[b + 2] + az * dt;
        const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (sp > maxSpeed) {
          const s = maxSpeed / sp;
          vx *= s; vy *= s; vz *= s;
        } else if (sp < minSpeed && sp > 1e-4) {
          const s = minSpeed / sp;
          vx *= s; vy *= s; vz *= s;
        }
        birdVel[b] = vx;
        birdVel[b + 1] = vy;
        birdVel[b + 2] = vz;
        birdPos[b] = x + vx * dt;
        birdPos[b + 1] = y + vy * dt;
        birdPos[b + 2] = z + vz * dt;

        const fl = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
        birdFwdArr[b] = vx / fl;
        birdFwdArr[b + 1] = vy / fl;
        birdFwdArr[b + 2] = vz / fl;
      }
    }
    birdPosAttr.needsUpdate = true;
    birdFwdAttr.needsUpdate = true;
  }

  /* =======================================================================
   * Meteors — the step
   * ==================================================================== */

  function stepMeteors(dt: number, strength: number): void {
    if (strength > 0.02) {
      meteorTimer -= dt;
      if (meteorTimer <= 0) {
        meteorTimer = 0.35 + rng.next() * (2.4 / Math.max(strength, 0.05));
        for (let i = 0; i < meteorMax; i++) {
          if (meteorLife[i] > 0) continue;
          const a = rng.next() * Math.PI * 2;
          const rr = 1200 + rng.next() * 3600;
          meteorPos[i * 6] = Math.cos(a) * rr;
          meteorPos[i * 6 + 1] = 2400 + rng.next() * 2600;
          meteorPos[i * 6 + 2] = Math.sin(a) * rr;
          const da = a + Math.PI * (0.5 + rng.next() * 0.6);
          const sp = 700 + rng.next() * 900;
          meteorVel[i * 3] = Math.cos(da) * sp;
          meteorVel[i * 3 + 1] = -sp * (0.18 + rng.next() * 0.3);
          meteorVel[i * 3 + 2] = Math.sin(da) * sp;
          meteorLen[i] = 0.055 + rng.next() * 0.06;
          meteorLife[i] = 0.8 + rng.next() * 0.8;
          break;
        }
      }
    }

    for (let i = 0; i < meteorMax; i++) {
      if (meteorLife[i] <= 0) {
        meteorFade[i * 2] = 0;
        meteorFade[i * 2 + 1] = 0;
        continue;
      }
      meteorLife[i] -= dt;
      const hx = meteorPos[i * 6] + meteorVel[i * 3] * dt;
      const hy = meteorPos[i * 6 + 1] + meteorVel[i * 3 + 1] * dt;
      const hz = meteorPos[i * 6 + 2] + meteorVel[i * 3 + 2] * dt;
      meteorPos[i * 6] = hx;
      meteorPos[i * 6 + 1] = hy;
      meteorPos[i * 6 + 2] = hz;
      const L = meteorLen[i];
      meteorPos[i * 6 + 3] = hx - meteorVel[i * 3] * L;
      meteorPos[i * 6 + 4] = hy - meteorVel[i * 3 + 1] * L;
      meteorPos[i * 6 + 5] = hz - meteorVel[i * 3 + 2] * L;
      // Fade in fast, out slow — a streak that pops out of nothing is a bug.
      const l = meteorLife[i];
      const f = clamp01(Math.min(l * 3.0, 1));
      meteorFade[i * 2] = f;
      meteorFade[i * 2 + 1] = 0;
      if (meteorLife[i] <= 0) {
        meteorLife[i] = 0;
        meteorFade[i * 2] = 0;
      }
    }
    meteorPosAttr.needsUpdate = true;
    meteorFadeAttr.needsUpdate = true;
  }

  /* =======================================================================
   * The frame
   * ==================================================================== */

  function update(ctx: FrameContext): void {
    const dt = ctx.dt;
    time = ctx.time;

    /* ---- the cycle --------------------------------------------------- */
    evaluateSchedule(time);
    forceMix = damp(forceMix, forced ? 1 : 0, FORCE_RATE, dt);
    if (forced) {
      const fi = CONDITIONS.indexOf(forced);
      for (let i = 0; i < 5; i++) forcedW[i] = i === fi ? 1 : 0;
    }
    for (let i = 0; i < 5; i++) {
      weight[i] = schedW[i] + (forcedW[i] - schedW[i]) * forceMix;
    }

    const cam = ctx.camera.position;
    derive(cam.y, ctx.dayPhase);

    if (!enabled) {
      // Still integrate the clock and the wind; a disabled system that stops
      // answering `windAt` breaks the banners rather than saving them.
      prevCam.copy(cam);
      return;
    }

    const pal = skyPalette(ctx.dayPhase);

    /* ---- snow -------------------------------------------------------- */
    const snowOn = snowAmount > 0.004;
    snowPoints.visible = snowOn;
    if (snowOn) {
      windAt(cam.x, cam.y, cam.z, scratchWind);
      const fall = 2.4 + 1.6 * snowAmount;
      if (!camPrimed) {
        prevCam.copy(cam);
        camPrimed = true;
      }
      windDrift.x += scratchWind.x * dt;
      windDrift.y += (scratchWind.y - fall) * dt;
      windDrift.z += scratchWind.z * dt;
      camDrift.x -= cam.x - prevCam.x;
      camDrift.y -= cam.y - prevCam.y;
      camDrift.z -= cam.z - prevCam.z;
      wrapVec(windDrift, snowHalf);
      wrapVec(camDrift, snowHalf);

      const u = snowMat.uniforms;
      (u.uWindDrift.value as THREE.Vector3).copy(windDrift);
      (u.uCamDrift.value as THREE.Vector3).copy(camDrift);
      u.uTime.value = time;
      u.uOpacity.value = 0.9 * snowAmount;
      u.uSwirl.value = 0.35 + 0.8 * snowAmount;
      u.uCamY.value = cam.y;
      (u.uSunDir.value as THREE.Vector3).copy(ctx.sunDir);
      (u.uLit.value as THREE.Color).copy(pal.cloudLit);
      (u.uShade.value as THREE.Color).copy(pal.cloudShade);
      (u.uGold.value as THREE.Color).copy(pal.gold);
      u.uPointScale.value = pointScale;
      snowPoints.position.copy(cam);
    }
    prevCam.copy(cam);

    /* ---- cloud banks -------------------------------------------------- */
    let puffMax = 0;
    for (let k = 0; k < 5; k++) if (kindOpacity[k] > puffMax) puffMax = kindOpacity[k];
    puffMesh.visible = puffMax > 0.006;
    if (puffMesh.visible) {
      for (let i = 0; i < puffTotal; i++) {
        puffOpacArr[i] = kindOpacity[puffKind[i]] * puffVar[i];
      }
      puffOpacAttr.needsUpdate = true;
      const u = puffMat.uniforms;
      u.uTime.value = time;
      (u.uSunDir.value as THREE.Vector3).copy(ctx.sunDir);
      (u.uLit.value as THREE.Color).copy(pal.cloudLit);
      (u.uShade.value as THREE.Color).copy(pal.cloudShade);
      (u.uGold.value as THREE.Color).copy(pal.gold);
      (u.uFog.value as THREE.Color).copy(pal.fog);
      u.uHaze.value = 0.00013 + fogBoostValue;
      // The cap that keeps the city visible through the worst of it.
      u.uPeak.value = 0.2;
    }

    /* ---- shafts ------------------------------------------------------- */
    if (shaftCount > 0) {
      const lowSun =
        smoothstep(-0.04, 0.07, ctx.sunDir.y) * (1 - smoothstep(0.08, 0.5, ctx.sunDir.y));
      const s = lowSun * clamp01(kindOpacity[1] * 0.7 + kindOpacity[0] * 0.5) * 0.5;
      shaftMesh.visible = s > 0.004;
      if (shaftMesh.visible) {
        const u = shaftMat.uniforms;
        (u.uSunDir.value as THREE.Vector3).copy(ctx.sunDir);
        (u.uGold.value as THREE.Color).copy(pal.gold);
        u.uStrength.value = s;
      }
    }

    /* ---- birds -------------------------------------------------------- */
    stepBirds(ctx);
    {
      const u = birdMat.uniforms;
      u.uTime.value = time;
      (u.uSunDir.value as THREE.Vector3).copy(ctx.sunDir);
      (u.uLit.value as THREE.Color).copy(pal.cloudLit);
      (u.uShade.value as THREE.Color).copy(pal.cloudShade);
      (u.uFog.value as THREE.Color).copy(pal.fog);
      u.uHaze.value = 0.00013 + fogBoostValue;
      // Snow thins them out: a squall is not a day for flying.
      u.uOpacity.value = 1 - 0.55 * snowAmount;
    }

    /* ---- night ------------------------------------------------------- */
    const env = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(time * 0.0031 + auroraPhase));
    // The cloud deck hides it, which is what makes a clear night worth having.
    const veil = 1 - clamp01(kindOpacity[0] * 0.8);
    const aur = clamp01(pal.stars * 1.25 - 0.2) * env * veil;
    auroraMesh.visible = aur > 0.006;
    if (auroraMesh.visible) {
      auroraMat.uniforms.uTime.value = time;
      auroraMat.uniforms.uStrength.value = aur;
    }

    const met = clamp01(pal.stars * 1.4 - 0.35) * veil;
    stepMeteors(dt, met);
    meteorLines.visible = met > 0.01;
    if (meteorLines.visible) {
      meteorMat.uniforms.uStrength.value = met;
      meteorLines.position.set(cam.x, 0, cam.z);
    }
  }

  /** Componentwise wrap into [-h, h]. Keeps the drifts from growing forever. */
  function wrapVec(v: THREE.Vector3, h: THREE.Vector3): void {
    v.x = wrap1(v.x, h.x);
    v.y = wrap1(v.y, h.y);
    v.z = wrap1(v.z, h.z);
  }
  function wrap1(v: number, h: number): number {
    const span = h * 2;
    if (!Number.isFinite(v) || span <= 0) return 0;
    return ((((v + h) % span) + span) % span) - h;
  }

  /* Point size is in metres and gl_PointSize is in pixels, so the conversion
   * needs the viewport height. There is no renderer here and no resize event to
   * hook, so it is sampled off the window twice a second — reading innerHeight
   * does not force layout, and being one frame stale after a resize costs
   * nothing. */
  let pointScale = 800;
  let scaleTimer = 0;
  function refreshPointScale(dt: number): void {
    scaleTimer -= dt;
    if (scaleTimer > 0) return;
    scaleTimer = 0.5;
    if (typeof window === "undefined") return;
    const h = (window.innerHeight || 800) * Math.min(window.devicePixelRatio || 1, 2);
    // fov 58° → half-height in world units at unit distance is tan(29°).
    pointScale = h / 2 / 0.5543;
  }
  refreshPointScale(1);

  /* =======================================================================
   * Handle
   * ==================================================================== */

  const handle: WeatherHandle = {
    name: "weather",
    group,
    get condition(): Condition {
      return forced ?? CONDITIONS[curIndex];
    },
    get blend(): number {
      const i = forced ? CONDITIONS.indexOf(forced) : curIndex;
      return clamp01(weight[i]);
    },
    get fogBoost(): number {
      return fogBoostValue;
    },
    windAt,
    force(c) {
      forced = c;
      if (c) {
        const fi = CONDITIONS.indexOf(c);
        for (let i = 0; i < 5; i++) forcedW[i] = i === fi ? 1 : 0;
      }
    },
    setEnabled(on) {
      enabled = on;
      group.visible = on;
      if (!on) {
        snowPoints.visible = false;
        puffMesh.visible = false;
        shaftMesh.visible = false;
        birdMesh.visible = false;
        auroraMesh.visible = false;
        meteorLines.visible = false;
      } else {
        // The cloud shelf and the birds are the two that are on by default;
        // everything else earns its visibility back in `update`.
        puffMesh.visible = true;
        birdMesh.visible = true;
      }
    },
    update(ctx) {
      refreshPointScale(ctx.dt);
      update(ctx);
    },
    dispose() {
      snowGeo.dispose();
      snowMat.dispose();
      puffGeo.dispose();
      puffMat.dispose();
      shaftGeo.dispose();
      shaftMat.dispose();
      birdGeo.dispose();
      birdMat.dispose();
      auroraGeo.dispose();
      auroraMat.dispose();
      meteorGeo.dispose();
      meteorMat.dispose();
      puffTex.dispose();
      group.clear();
    },
  };

  return handle;
}
