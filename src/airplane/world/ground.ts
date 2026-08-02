/**
 * Chicago at night, which is a light field and almost nothing else.
 *
 * There is no terrain here worth modelling — northern Illinois is famously,
 * relentlessly flat, and the only elevation change in sixty kilometres is the
 * twenty-eight metres down to the surface of Lake Michigan. So the entire
 * ground is one plane and one shader, and all the work goes into what is
 * *lit*, because at night that is the only thing there is.
 *
 * ## Why the grid matters
 *
 * Chicago is the most legible city in America from the air at night, and the
 * reason is that it is a grid: eight blocks to the mile, arterials on the mile
 * lines, all of it aligned true north–south and east–west for thirty miles in
 * every direction, running right up to a lake edge that cuts it off dead
 * straight. Nothing else in the world looks like that. Getting the *spacing*
 * right — 201 m between streets, 1609 m between arterials — is what makes the
 * ground under Flight 209 read as Chicago rather than as procedural noise,
 * and it costs the same as getting it wrong.
 *
 * ## The filtering is not optional
 *
 * A 200-metre lattice viewed from 9,000 metres puts several cells inside one
 * pixel. Sampled naively that is a shimmering moiré carpet that draws the eye
 * to exactly the wrong thing. Each lattice here is faded out once its cell
 * drops below the pixel footprint — `fwidth` of the world position gives that
 * footprint directly — and replaced by its own average. That is real
 * mip-mapping logic done by hand, and it is the difference between a city and
 * a screen door.
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
import { createLightField, setViewportHeight, type LightField, type LightSpec } from "./lights";
import { DOWNTOWN, FIELD_ELEVATION, shorelineX } from "../flight/nav";
import { PALETTE, type GroundService, type PlaneCtx, type System } from "../types";

/** Lake Michigan's surface, metres. Twenty-eight metres below the field. */
export const LAKE_LEVEL = 176.2;
/** Half-extent of the modelled world. */
export const WORLD_EXTENT = 60000;

const VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorld;
${ENV_UNIFORMS_GLSL}
${OUTPUT_GLSL}
${NOISE_GLSL}
${AERIAL_GLSL}

uniform vec3  uDowntown;
uniform float uLakeLevel;
uniform float uFieldElevation;

/**
 * One lattice of street lights, filtered against the pixel footprint.
 *
 * footprint is how many metres one pixel covers here. Once that exceeds the
 * cell size the lattice cannot be resolved, so it fades to density — its own
 * mean — instead of aliasing. Everything below is one texture fetch's worth of
 * arithmetic and there are three of them.
 */
float lattice(vec2 p, float cell, float radius, float footprint, float density) {
  // What this lattice averages out to once it can no longer be resolved: the
  // area of one lamp over the area of one cell. Derived, not typed — the first
  // version used a flat 0.30 for every lattice, which is two orders of
  // magnitude above the true mean for the mile grid and turned the entire
  // distant city into one even orange sheet with no lights in it at all.
  // The ×6 is an honest fudge for the eye's response to points at night.
  float mean = clamp(3.14159 * radius * radius / (cell * cell) * 6.0, 0.0, 0.35);
  float resolve = smoothstep(cell * 1.6, cell * 0.5, footprint);
  if (resolve < 0.004) return density * mean;
  vec2 g = p / cell;
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  vec2 jitter = (hash22(id) - 0.5) * 0.55;
  float d = length((f - jitter) * cell);
  // A lamp, not a disc: sharp core, wide skirt.
  float lamp = exp(-d * d / (radius * radius)) * 1.7;
  // Not every cell has a light in it, and the ones that do are not equal.
  float present = step(0.22, hash12(id + 3.7));
  float vary = 0.55 + 0.45 * hash12(id + 11.3);
  return mix(density * mean, lamp * present * vary, resolve);
}

/** Street lines: the grid reads as lines long before it resolves into lamps. */
float streets(vec2 p, float cell, float footprint) {
  vec2 g = abs(fract(p / cell) - 0.5) * cell;
  float w = max(footprint * 0.9, 9.0);
  float line = max(smoothstep(w, 0.0, g.x), smoothstep(w, 0.0, g.y));
  return line * smoothstep(cell * 3.5, cell * 0.6, footprint);
}

void main() {
  vec2 p = vWorld.xz;
  float dist = length(vWorld - cameraPosition);

  // How many metres of world one pixel spans here. The single most useful
  // number in the shader.
  float footprint = max(fwidth(vWorld.x), fwidth(vWorld.z));

  float shore = 31500.0 + vWorld.z * 0.16;
  float water = smoothstep(shore - 90.0, shore + 90.0, vWorld.x);

  // --- how built-up is it here --------------------------------------------
  // A broad falloff from the Loop, plus enough noise that the suburbs are not
  // a smooth gradient. Chicago's density really does fall off like this: dense
  // to about 8 km, thinning to 25, then farmland.
  float toCity = length(p - uDowntown.xz);
  float density = exp(-toCity / 14000.0) * 0.85 + 0.16;
  density *= 0.55 + 0.75 * fbm(p * 0.000075);
  // The lake is the hardest edge in the city and the reason it is recognisable.
  density *= 1.0 - water;
  density = clamp(density, 0.0, 1.4);

  // --- the light field -----------------------------------------------------
  float arterial = lattice(p, 1609.0, 26.0, footprint, density) * 1.5;
  float street   = lattice(p, 201.0, 11.0, footprint, density) * 0.85;
  float house    = lattice(p, 62.0, 5.0, footprint, density) * 0.30;

  // The lines the grid makes before it resolves into individual lamps. Faint:
  // a city from the air is a field of points that *implies* streets, not a
  // wireframe drawing of them.
  float grid = streets(p, 201.0, footprint) * 0.045
             + streets(p, 1609.0, footprint) * 0.115;

  float lit = (arterial + street + house) * density + grid * density;

  // The Kennedy: the expressway that runs from this very airport down to the
  // Loop, and the thing you follow in on a night approach.
  vec2 kenA = vec2(1200.0, 900.0);
  vec2 kenB = uDowntown.xz + vec2(-1800.0, -600.0);
  vec2 ab = kenB - kenA;
  float t = clamp(dot(p - kenA, ab) / dot(ab, ab), 0.0, 1.0);
  float dRoad = length(p - (kenA + ab * t));
  float road = smoothstep(max(footprint * 1.5, 70.0), 0.0, dRoad);
  lit += road * 0.55 * (1.0 - water);

  vec3 sodium = uCityGlow;
  vec3 mercury = vec3(0.72, 0.86, 1.0);
  // Downtown burns cooler — office towers and mercury vapour, not street lamps.
  vec3 lampColor = mix(sodium, mercury, smoothstep(9000.0, 1200.0, toCity) * 0.55);
  vec3 col = lampColor * lit * 0.75;

  // --- unlit surfaces ------------------------------------------------------
  vec3 land = vec3(0.014, 0.014, 0.018) * (0.6 + 0.4 * fbm(p * 0.0004));
  // The overcast throws the city's own light back down onto everything.
  land += uCityGlow * 0.008 * density;
  land += vec3(1.0) * uFlash * 0.16;

  vec3 lake = vec3(0.004, 0.007, 0.012);
  // A storm-chopped lake catches the flash and almost nothing else.
  lake += vec3(0.8, 0.85, 1.0) * uFlash * 0.26 * (0.5 + 0.5 * fbm(p * 0.004 + uTime * 0.7));
  lake += uCityGlow * 0.012 * exp(-max(vWorld.x - shore, 0.0) / 2600.0);

  col += mix(land, lake, water);

  col = applyAerial(col, dist, vWorld.y);
  gl_FragColor = vec4(outputColor(max(col, vec3(0.0))), 1.0);
}
`;

// ---------------------------------------------------------------------------
// The skyline
// ---------------------------------------------------------------------------

/**
 * The three towers that *were* the Chicago skyline in 1980, at their real
 * relative positions and real heights.
 *
 * Sears is the one that matters: at 442 m to the roof it is a hundred metres
 * clear of anything else, and a Chicago skyline without one obviously-tallest
 * flat-topped slab on the west side of the Loop does not read as Chicago. The
 * Hancock is the other giveaway — it stands two and a half kilometres north of
 * the rest, on its own, hard against the lake, and it tapers.
 *
 * Offsets are metres from `DOWNTOWN`, +X east and +Z south.
 */
const LANDMARKS = [
  { name: "Sears Tower", dx: -700, dz: 250, w: 68, d: 68, h: 442, mast: 85, taper: 0.55 },
  { name: "Aon Center", dx: 420, dz: -220, w: 58, d: 58, h: 346, mast: 0, taper: 1 },
  { name: "John Hancock Center", dx: 300, dz: -2600, w: 80, d: 50, h: 344, mast: 105, taper: 0.42 },
] as const;

const BUILDING_VERT = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUvY;
void main() {
  vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vUvY = uv;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const BUILDING_FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUvY;
${ENV_UNIFORMS_GLSL}
${OUTPUT_GLSL}
${NOISE_GLSL}
${AERIAL_GLSL}

void main() {
  float dist = length(vWorld - cameraPosition);
  float footprint = max(fwidth(vWorld.x), fwidth(vWorld.y));

  // Windows. A 3.6 m floor-to-floor and a 2.4 m module, which is what an
  // American office tower of this era actually is.
  vec2 cell = vec2(2.4, 3.6);
  vec2 q = vec2(dot(vWorld.xz, normalize(vec2(vNormal.z, -vNormal.x))), vWorld.y);
  vec2 id = floor(q / cell);
  float on = step(0.42, hash12(id));
  // A few of them change over the course of a night.
  on *= 0.55 + 0.45 * step(0.5, hash12(id + floor(uTime * 0.05) * 17.0));
  float resolve = smoothstep(cell.y * 2.2, cell.y * 0.5, footprint);
  float lit = mix(0.30, on, resolve);

  vec3 col = vec3(1.0, 0.88, 0.66) * lit * 0.40;
  // Unlit concrete, picking up the city glow and the lightning.
  col += vec3(0.03, 0.03, 0.036) + uCityGlow * 0.025 + vec3(1.0) * uFlash * 0.34;

  col = applyAerial(col, dist, vWorld.y);
  gl_FragColor = vec4(outputColor(max(col, vec3(0.0))), 1.0);
}
`;

export function createGround(ctx: PlaneCtx): System {
  const env = (ctx.services.skyEnv ?? null) as EnvUniforms | null;
  if (!env) throw new Error("ground needs the sky's env uniforms");

  const group = new THREE.Group();

  // --- the plane -----------------------------------------------------------
  const groundMat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: withEnv(env, {
      uDowntown: { value: DOWNTOWN.clone() },
      uLakeLevel: { value: LAKE_LEVEL },
      uFieldElevation: { value: FIELD_ELEVATION },
    }),
    side: THREE.FrontSide,
    fog: false,
  });

  // Flat, because Illinois is. Subdivided only enough that the near field has
  // vertices to interpolate across; everything visual is per-fragment.
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD_EXTENT * 2.6, WORLD_EXTENT * 2.6, 48, 48),
    groundMat,
  );
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = FIELD_ELEVATION;
  plane.frustumCulled = false;
  plane.renderOrder = -500;
  group.add(plane);

  // --- downtown ------------------------------------------------------------
  const buildingMat = new THREE.ShaderMaterial({
    vertexShader: BUILDING_VERT,
    fragmentShader: BUILDING_FRAG,
    uniforms: withEnv(env),
    fog: false,
  });

  const rng = ctx.rng.fork(0x10c0);
  const filler = ctx.quality === "low" ? 90 : ctx.quality === "medium" ? 220 : 420;
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0); // origin at the base, so scaling grows upward

  const towers = new THREE.InstancedMesh(box, buildingMat, filler + LANDMARKS.length);
  const m = new THREE.Matrix4();
  let i = 0;

  for (const l of LANDMARKS) {
    m.compose(
      new THREE.Vector3(DOWNTOWN.x + l.dx, FIELD_ELEVATION, DOWNTOWN.z + l.dz),
      new THREE.Quaternion(),
      new THREE.Vector3(l.w, l.h, l.d),
    );
    towers.setMatrixAt(i++, m);
  }

  // The rest of the Loop. Rejection-sampled against the lake, because a
  // forty-storey tower standing in Lake Michigan is the sort of detail that
  // becomes the only thing anyone sees.
  for (let k = 0; k < filler; k++) {
    // Concentrated on the Loop, thinning north along the lake — which is the
    // shape Chicago's tall buildings actually make.
    const r = Math.abs(rng.gauss()) * 1500;
    const a = rng.range(0, Math.PI * 2);
    const x = DOWNTOWN.x + Math.cos(a) * r + rng.gauss() * 400;
    const z = DOWNTOWN.z + Math.sin(a) * r * 1.6 - Math.max(0, rng.gauss()) * 900;
    if (x > shorelineX(z) - 120) continue;
    const h = 40 + Math.pow(rng.next(), 2.4) * 210;
    m.compose(
      new THREE.Vector3(x, FIELD_ELEVATION, z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(-0.06, 0.06)),
      new THREE.Vector3(rng.range(22, 46), h, rng.range(22, 46)),
    );
    towers.setMatrixAt(i++, m);
  }
  towers.count = i;
  towers.instanceMatrix.needsUpdate = true;
  towers.frustumCulled = false;
  group.add(towers);

  // --- the red lights on top of everything tall ----------------------------
  const beacons: LightSpec[] = [];
  for (const l of LANDMARKS) {
    beacons.push({
      position: new THREE.Vector3(
        DOWNTOWN.x + l.dx,
        FIELD_ELEVATION + l.h + l.mast,
        DOWNTOWN.z + l.dz,
      ),
      color: 0xff2a1a,
      intensity: 2.2,
      size: 2.16,
    });
  }
  const beaconField = createLightField(env, beacons, {
    viewportHeight: ctx.viewport.height * ctx.viewport.dpr,
  });
  group.add(beaconField.points);

  ctx.scene.add(group);

  const service: GroundService = {
    heightAt(x, z) {
      const shore = shorelineX(z);
      // A 400 m bluff down to the lake. Small, but it means the shoreline is
      // a real edge rather than a colour change.
      const t = Math.max(0, Math.min(1, (x - shore + 200) / 400));
      return FIELD_ELEVATION + (LAKE_LEVEL - FIELD_ELEVATION) * t * t * (3 - 2 * t);
    },
    isWater(x, z) {
      return x > shorelineX(z);
    },
    extent: WORLD_EXTENT,
  };
  ctx.services.ground = service;

  return {
    update(dt) {
      beaconField.update(dt);
    },
    resize(_w, h) {
      setViewportHeight(beaconField, h, ctx.viewport.dpr);
    },
    dispose() {
      ctx.scene.remove(group);
      plane.geometry.dispose();
      groundMat.dispose();
      box.dispose();
      buildingMat.dispose();
      towers.dispose();
      beaconField.dispose();
    },
  };
}

/** Kept next to the ground because it is the only other flat colour in the world. */
export const GROUND_PALETTE = PALETTE;
