/**
 * Runway 09, and the two thousand lights that make it findable in weather.
 *
 * At night, in rain, at a thousand feet, an airport is not a place — it is a
 * *pattern*, and the pattern is standardised precisely so that a pilot who has
 * never been to this airport can read altitude, alignment and distance off it
 * in one glance. Everything below is built to the real dimensions, because the
 * dimensions are the information:
 *
 *   - **The approach lighting** runs 900 m out from the threshold on the
 *     extended centreline, with crossbars at 300 m and 150 m. Those crossbars
 *     are a ruler. If the near one looks wide and the far one narrow you are
 *     low; if they stack you are on slope.
 *   - **The rabbit** — two sequenced flashes a second running *up* the bars
 *     towards the runway — is visible through cloud that hides everything
 *     else, and it points.
 *   - **The threshold** is a solid green bar, the only green on the airfield.
 *     When it slides under the nose you are over the paint.
 *   - **The PAPI** is four lights beside the touchdown zone that read
 *     white-white-red-red on slope, and go all-red the moment you sink below
 *     it. It is the best instrument in aviation and it is a lamp in a box.
 *   - **The edge lights** converge. How fast they converge is your height.
 *
 * Get those five right and the last minute of the flight plays itself. Get
 * them wrong — or worse, make them up — and the player has nothing to fly by
 * except the panel, which is not what the ending is about.
 */
import * as THREE from "three";
import {
  AERIAL_GLSL,
  ENV_UNIFORMS_GLSL,
  NOISE_GLSL,
  OUTPUT_GLSL,
  withEnv,
  type EnvUniforms,
} from "./env";
import { createLightField, setViewportHeight, type LightSpec } from "./lights";
import { FIELD_ELEVATION, ILS, RUNWAY } from "../flight/nav";
import { PALETTE, type PlaneCtx, type System } from "../types";

/** Down the runway, which is east. Every directional light is aimed at this. */
const DOWN_RUNWAY = new THREE.Vector3(1, 0, 0);
/** Back up the approach, which is what an approach light shines along. */
const UP_APPROACH = new THREE.Vector3(-1, 0.09, 0).normalize();

// ---------------------------------------------------------------------------
// The paved surface
// ---------------------------------------------------------------------------

const PAVE_VERT = /* glsl */ `
varying vec3 vWorld;
varying vec2 vUv;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * Asphalt and paint.
 *
 * All the markings are computed from metres along and across the runway rather
 * than from a texture, which means they are correct at every distance and
 * there is no mip level at which the centreline turns into grey mush. The
 * dimensions are the real ones: a 0.9 m centreline in 30 m dashes with 20 m
 * gaps, the aiming point bars 300 m in, touchdown-zone bars every 150 m.
 */
const PAVE_FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorld;
varying vec2 vUv;
${ENV_UNIFORMS_GLSL}
${OUTPUT_GLSL}
${NOISE_GLSL}
${AERIAL_GLSL}

uniform float uLength;
uniform float uWidth;

float band(float v, float lo, float hi, float soft) {
  return smoothstep(lo - soft, lo + soft, v) * smoothstep(hi + soft, hi - soft, v);
}

void main() {
  // Metres from the threshold, and metres left/right of the centreline.
  float along = vUv.x * uLength;
  float across = (vUv.y - 0.5) * uWidth;
  float a = abs(across);
  float dist = length(vWorld - cameraPosition);
  float soft = max(max(fwidth(along), fwidth(across)) * 0.6, 0.05);

  // --- asphalt ------------------------------------------------------------
  float grain = fbm(vWorld.xz * 0.9) * 0.35 + fbm(vWorld.xz * 0.09) * 0.3;
  vec3 col = vec3(0.020, 0.020, 0.023) * (0.7 + grain);
  // Rubber, laid down where every aeroplane touches. A real runway is nearly
  // black for four hundred metres either side of the touchdown zone.
  col *= 1.0 - 0.45 * band(along, 240.0, 700.0, 160.0) * smoothstep(26.0, 8.0, a);

  // --- paint ---------------------------------------------------------------
  float paint = 0.0;
  // Centreline: 30 m stripe, 20 m gap, 0.9 m wide.
  paint = max(paint, band(a, 0.0, 0.45, soft) * step(fract(along / 50.0), 0.6)
                     * band(along, 6.0, uLength - 6.0, 1.0));
  // Edge stripes.
  paint = max(paint, band(a, uWidth * 0.5 - 1.4, uWidth * 0.5 - 0.5, soft));
  // Threshold piano keys: eight bars, 1.75 m wide, 30 m long, starting 6 m in.
  float keys = band(along, 6.0, 36.0, soft) * step(fract((across + 22.0) / 3.5), 0.5)
             * band(a, 0.0, 22.0, soft);
  paint = max(paint, keys);
  // Aiming point: two 45 m bars, 6 m wide, 11 m off the centreline, 300 m in.
  paint = max(paint, band(along, 300.0, 345.0, soft) * band(a, 9.0, 15.0, soft));
  // Touchdown zone bars, in pairs every 150 m.
  for (int i = 0; i < 5; i++) {
    float x0 = 150.0 + float(i) * 150.0;
    if (i == 1) continue; // the aiming point takes this slot
    paint = max(paint, band(along, x0, x0 + 22.0, soft)
                       * (band(a, 2.0, 3.8, soft) + band(a, 4.8, 6.6, soft)));
  }

  // Paint is retroreflective and the runway is wet, so it takes the lightning
  // and the city glow far harder than the asphalt around it.
  vec3 paintCol = vec3(0.30, 0.30, 0.29) + uCityGlow * 0.10 + vec3(1.0) * uFlash * 0.5;
  col = mix(col, paintCol, paint * 0.9);

  // --- wet ------------------------------------------------------------------
  // Standing water: a broad, dim reflection of whatever is lighting the sky,
  // strongest at grazing angles. This is most of why the ending looks the way
  // it does — a dry runway at night is a black rectangle.
  vec3 toEye = normalize(cameraPosition - vWorld);
  float graze = pow(1.0 - clamp(toEye.y, 0.0, 1.0), 4.0);
  float sheen = graze * (0.35 + 0.65 * uRain);
  col += (uCityGlow * 0.10 + vec3(1.0) * uFlash * 0.45) * sheen;
  col += vec3(0.5, 0.55, 0.6) * uFlash * 0.20;

  col = applyAerial(col, dist, vWorld.y);
  gl_FragColor = vec4(outputColor(max(col, vec3(0.0))), 1.0);
}
`;

// ---------------------------------------------------------------------------
// Buildings — a terminal, so the airport is a place and not a strip
// ---------------------------------------------------------------------------

const BUILDING_FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorld;
varying vec3 vNormal;
${ENV_UNIFORMS_GLSL}
${OUTPUT_GLSL}
${NOISE_GLSL}
${AERIAL_GLSL}

void main() {
  float dist = length(vWorld - cameraPosition);
  float footprint = max(fwidth(vWorld.x), fwidth(vWorld.y));
  vec2 q = vec2(dot(vWorld.xz, normalize(vec2(vNormal.z, -vNormal.x))), vWorld.y);
  vec2 id = floor(q / vec2(3.0, 3.2));
  float on = step(0.30, hash12(id));
  float resolve = smoothstep(7.0, 1.6, footprint);
  float lit = mix(0.45, on, resolve) * step(0.5, step(vWorld.y, 999.0));
  vec3 col = vec3(1.0, 0.92, 0.74) * lit * 0.30;
  col += vec3(0.022, 0.022, 0.026) + uCityGlow * 0.05 + vec3(1.0) * uFlash * 0.35;
  col = applyAerial(col, dist, vWorld.y);
  gl_FragColor = vec4(outputColor(max(col, vec3(0.0))), 1.0);
}
`;

const BUILDING_VERT = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

// ---------------------------------------------------------------------------

export interface AirportService {
  /** How many of the four PAPI units are showing white, right now. */
  papiWhite: number;
}

export function createAirport(ctx: PlaneCtx): System {
  const env = ctx.services.skyEnv as EnvUniforms | undefined;
  if (!env) throw new Error("airport needs the sky's env uniforms");

  const group = new THREE.Group();
  const y = FIELD_ELEVATION;
  const vh = ctx.viewport.height * ctx.viewport.dpr;
  // Everything on the airfield sits a few centimetres above the ground plane,
  // so a 60 km plane and a 3 km strip do not z-fight along their whole length.
  const PAVE_Y = y + 0.05;

  // --- the runway ----------------------------------------------------------
  const paveMat = new THREE.ShaderMaterial({
    vertexShader: PAVE_VERT,
    fragmentShader: PAVE_FRAG,
    uniforms: withEnv(env, {
      uLength: { value: RUNWAY.length },
      uWidth: { value: RUNWAY.width },
    }),
  });

  const runway = new THREE.Mesh(new THREE.PlaneGeometry(RUNWAY.length, RUNWAY.width, 1, 1), paveMat);
  runway.rotation.x = -Math.PI / 2;
  // PlaneGeometry's +Y becomes −Z after that rotation, so the UV runs the way
  // the shader expects only if the mesh is not additionally spun.
  runway.position.set(RUNWAY.length / 2, PAVE_Y, 0);
  group.add(runway);

  // A parallel runway, because O'Hare has several and one lonely strip in the
  // middle of a light field looks like a road.
  const runway2 = new THREE.Mesh(
    new THREE.PlaneGeometry(RUNWAY.length * 0.82, RUNWAY.width, 1, 1),
    paveMat,
  );
  runway2.rotation.x = -Math.PI / 2;
  runway2.position.set(RUNWAY.length / 2 + 260, PAVE_Y, -1400);
  group.add(runway2);

  // --- the lights ----------------------------------------------------------
  const lights: LightSpec[] = [];
  const at = (x: number, z: number, dy = 0.35) => new THREE.Vector3(x, y + dy, z);

  // Approach lighting: centreline barrettes every 30 m out to 900 m, five
  // lamps wide, with the two crossbars.
  for (let i = 1; i <= 30; i++) {
    const x = -i * 30;
    const barrette = i <= 10 ? 5 : 3;
    for (let k = -(barrette - 1) / 2; k <= (barrette - 1) / 2; k++) {
      lights.push({
        position: at(x, k * 1.4),
        color: PALETTE.approachWhite,
        intensity: 2.4,
        size: 1.2,
        axis: UP_APPROACH,
        focus: 1.8,
      });
    }
    // The rabbit: sequenced flashers on the outer 600 m, firing in order so
    // the flash *runs* towards the threshold.
    if (i >= 10) {
      lights.push({
        position: at(x, 0, 0.5),
        color: 0xffffff,
        intensity: 3.4,
        size: 1.92,
        flash: 31 - i,
        axis: UP_APPROACH,
        focus: 1.3,
      });
    }
  }
  // Crossbars at 300 m and 150 m — the ruler you read slope off.
  for (const [bx, halfWidth] of [
    [-300, 15],
    [-150, 7.5],
  ] as const) {
    for (let k = -halfWidth; k <= halfWidth; k += 1.5) {
      if (Math.abs(k) < 1.2) continue;
      lights.push({
        position: at(bx, k),
        color: PALETTE.approachWhite,
        intensity: 2.6,
        size: 1.2,
        axis: UP_APPROACH,
        focus: 1.8,
      });
    }
  }
  // Red side rows, inner 300 m.
  for (let i = 1; i <= 9; i++) {
    for (const side of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        lights.push({
          position: at(-i * 30, side * (5 + k * 1.4)),
          color: 0xff3020,
          intensity: 1.5,
          size: 0.96,
          axis: UP_APPROACH,
          focus: 1.8,
        });
      }
    }
  }

  // Threshold: a solid green bar across the full width. The only green here.
  for (let k = -RUNWAY.width / 2; k <= RUNWAY.width / 2; k += 1.8) {
    lights.push({
      position: at(1, k),
      color: PALETTE.thresholdGreen,
      intensity: 3.0,
      size: 1.44,
      axis: UP_APPROACH,
      focus: 1.2,
    });
  }
  // Runway end, seen from the far side: red.
  for (let k = -RUNWAY.width / 2; k <= RUNWAY.width / 2; k += 3.6) {
    lights.push({
      position: at(RUNWAY.length - 1, k),
      color: 0xff2418,
      intensity: 2.2,
      size: 1.44,
      axis: DOWN_RUNWAY,
      focus: 1.2,
    });
  }

  // Edge lights every 60 m, both sides. These are the ones that converge, and
  // how fast they converge is your height above the runway in the flare.
  for (let x = 0; x <= RUNWAY.length; x += 60) {
    // The last 600 m of a runway's edge lights are amber, telling you how much
    // you have left. From the flare it is the only distance cue there is.
    const amber = x > RUNWAY.length - 600;
    for (const side of [-1, 1]) {
      lights.push({
        position: at(x, (side * RUNWAY.width) / 2),
        color: amber ? 0xffb01e : PALETTE.runwayEdge,
        intensity: 1.7,
        size: 1.2,
      });
    }
  }
  // Centreline lights every 15 m — white, then alternating red for the last
  // 900 m, then solid red for the last 300.
  for (let x = 15; x < RUNWAY.length; x += 15) {
    const remaining = RUNWAY.length - x;
    const color =
      remaining < 300 ? 0xff2418 : remaining < 900 && Math.round(x / 15) % 2 === 0 ? 0xff2418 : 0xfff6e0;
    lights.push({ position: at(x, 0), color, intensity: 1.5, size: 0.96 });
  }
  // Touchdown zone: bars either side of the centreline for the first 900 m.
  for (let x = 30; x <= 900; x += 30) {
    for (const side of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        lights.push({
          position: at(x, side * (3.5 + k * 1.5)),
          color: 0xfff6e0,
          intensity: 1.3,
          size: 0.96,
          axis: UP_APPROACH,
          focus: 2.2,
        });
      }
    }
  }
  // Taxiway edge: blue, off to the north side.
  for (let x = -200; x <= RUNWAY.length + 200; x += 55) {
    lights.push({ position: at(x, -140), color: 0x2a6bff, intensity: 0.9, size: 0.96 });
    lights.push({ position: at(x, -200), color: 0x2a6bff, intensity: 0.9, size: 0.96 });
  }

  const field = createLightField(env, lights, { viewportHeight: vh });
  group.add(field.points);

  // --- the PAPI ------------------------------------------------------------
  // Four boxes on the left of the runway, abeam the aiming point. Each has its
  // own transition angle twenty minutes of arc apart, and each shows white
  // above its angle and red below it — which is the whole instrument.
  const PAPI_STEP = (20 / 60) * (Math.PI / 180);
  const papiAngles: number[] = [];
  const papiLights: LightSpec[] = [];
  for (let i = 0; i < 4; i++) {
    // Unit 1 is nearest the runway and has the *highest* angle, so sinking
    // below the slope turns them red from the inside out.
    papiAngles.push(ILS.glideslope + (1.5 - i) * PAPI_STEP);
    papiLights.push({
      position: at(RUNWAY.aimPoint, -(RUNWAY.width / 2 + 15 + i * 9)),
      color: 0xffffff,
      intensity: 4.2,
      size: 1.92,
      axis: UP_APPROACH,
      focus: 1.1,
    });
  }
  const papi = createLightField(env, papiLights, { viewportHeight: vh });
  group.add(papi.points);
  const papiColors = papi.points.geometry.getAttribute("aColor") as THREE.BufferAttribute;

  // --- the airport beacon --------------------------------------------------
  // Alternating white and green, once every three seconds, from a mast north
  // of the terminal. Visible from thirty kilometres and the first thing you
  // ever see of an airport at night.
  const beacon = createLightField(
    env,
    [{ position: at(RUNWAY.length * 0.4, -1800, 34), color: 0xffffff, intensity: 6, size: 2.88 }],
    { viewportHeight: vh },
  );
  group.add(beacon.points);
  const beaconColor = beacon.points.geometry.getAttribute("aColor") as THREE.BufferAttribute;
  const beaconParams = beacon.points.geometry.getAttribute("aParams") as THREE.BufferAttribute;

  // --- the terminal --------------------------------------------------------
  const buildingMat = new THREE.ShaderMaterial({
    vertexShader: BUILDING_VERT,
    fragmentShader: BUILDING_FRAG,
    uniforms: withEnv(env),
  });
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);
  const rng = ctx.rng.fork(0xa1a1);
  const buildings = new THREE.InstancedMesh(box, buildingMat, 26);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  let bi = 0;
  const place = (x: number, z: number, w: number, h: number, d: number) => {
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(w, h, d));
    buildings.setMatrixAt(bi++, m);
  };
  // A main terminal and four concourses reaching out onto the apron, which is
  // roughly what O'Hare looks like from the air.
  place(RUNWAY.length * 0.45, -2050, 380, 22, 70);
  for (let k = 0; k < 4; k++) {
    place(RUNWAY.length * 0.45 - 150 + k * 100, -1780, 26, 14, 300);
  }
  // Hangars along the south side.
  for (let k = 0; k < 5; k++) {
    place(400 + k * 340, 620 + rng.range(-40, 40), rng.range(80, 140), rng.range(16, 26), 70);
  }
  buildings.count = bi;
  buildings.instanceMatrix.needsUpdate = true;
  group.add(buildings);

  // Apron floodlights: tall, bright, and they wash the whole terminal area.
  const apron: LightSpec[] = [];
  for (let k = 0; k < 14; k++) {
    apron.push({
      position: at(RUNWAY.length * 0.45 - 320 + k * 50, -1650, 26),
      color: 0xfff0d0,
      intensity: 3.2,
      size: 2.4,
    });
  }
  const apronField = createLightField(env, apron, { viewportHeight: vh });
  group.add(apronField.points);

  ctx.scene.add(group);

  const service: AirportService = { papiWhite: 2 };
  ctx.services.airport = service;

  const fields = [field, papi, beacon, apronField];
  let beaconPhase = 0;
  const _c = new THREE.Color();

  return {
    update(dt, c) {
      for (const f of fields) f.update(dt);

      // The PAPI, computed the way the real optical system works: each unit
      // shows white to an observer above its own transition angle and red to
      // one below it. No game logic, no thresholds — just where the eye is.
      const cam = c.camera.position;
      const range = ILS.gsOrigin.x - cam.x;
      const angle = range > 30 ? Math.atan2(cam.y - FIELD_ELEVATION, range) : ILS.glideslope;
      let white = 0;
      for (let i = 0; i < 4; i++) {
        const isWhite = angle > papiAngles[i];
        if (isWhite) white++;
        _c.setHex(isWhite ? 0xffffff : PALETTE.papiRed);
        papiColors.setXYZ(i, _c.r, _c.g, _c.b);
      }
      papiColors.needsUpdate = true;
      service.papiWhite = white;

      // The beacon: white, green, dark, once every three seconds.
      beaconPhase = (beaconPhase + dt) % 3;
      const on = beaconPhase % 1.5 < 0.16;
      _c.setHex(beaconPhase < 1.5 ? 0xffffff : 0x2bff88);
      beaconColor.setXYZ(0, _c.r, _c.g, _c.b);
      beaconColor.needsUpdate = true;
      beaconParams.setX(0, on ? 7 : 0);
      beaconParams.needsUpdate = true;
    },
    resize(_w, h) {
      for (const f of fields) setViewportHeight(f, h, ctx.viewport.dpr);
    },
    dispose() {
      ctx.scene.remove(group);
      runway.geometry.dispose();
      runway2.geometry.dispose();
      paveMat.dispose();
      box.dispose();
      buildingMat.dispose();
      buildings.dispose();
      for (const f of fields) f.dispose();
    },
  };
}
