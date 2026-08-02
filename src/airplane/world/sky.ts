/**
 * The sky over Chicago, which is mostly the inside of a thunderstorm.
 *
 * One camera-locked dome, one shader, three regimes — below the overcast,
 * inside it, and on top of it — blended by the aeroplane's own altitude. That
 * structure is the point: the flight starts on top at 29,000 feet under a
 * moonlit deck of cloud tops and stars, descends *into* the layer where the
 * world goes grey and you are flying on instruments alone, and comes out of
 * the bottom at a thousand feet with Chicago underneath. Three completely
 * different pictures, from one dome, driven by one number.
 *
 * ## Two things that took more than one try
 *
 * **A camera-locked dome must be synced in `onBeforeRender`.** Updating it in
 * `update()` leaves it one frame behind, and one frame at 250 knots is two
 * metres — enough to put the camera outside the sphere and turn the sky black
 * from one side. It renders perfectly while parked, which is the worst kind of
 * bug.
 *
 * **The cloud deck has to be sampled where the view ray hits it, not where the
 * pixel is.** Intersecting the ray with the layer plane and sampling noise at
 * that world position costs one divide and gives real parallax: the tops slide
 * past underneath you at a speed that matches your groundspeed, and the base
 * spreads out towards the horizon. Sampling by direction alone gives a sky
 * painted on the inside of a ball, and the aeroplane looks stationary no
 * matter how fast it is going.
 */
import * as THREE from "three";
import {
  ENV_UNIFORMS_GLSL,
  Lightning,
  NOISE_GLSL,
  OUTPUT_GLSL,
  WEATHER,
  applyStormIntensity,
  makeEnvUniforms,
  withEnv,
  type EnvUniforms,
} from "./env";
import type { PlaneCtx, SkyService, System } from "../types";

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

uniform float uStormTops;

/** Stars. Only ever seen from on top of the layer, and worth the eight lines. */
float starField(vec3 dir) {
  vec3 p = dir * 260.0;
  vec3 cell = floor(p);
  float h = hash13(cell);
  if (h < 0.9955) return 0.0;
  vec3 f = fract(p) - 0.5;
  float twinkle = 0.65 + 0.35 * sin(uTime * (0.9 + h * 6.0) + h * 90.0);
  return smoothstep(0.36, 0.0, length(f)) * twinkle;
}

/**
 * Where a view ray meets a horizontal layer, as a world XZ to sample noise at.
 *
 * ok comes back 0 when the ray never reaches the layer (looking up from
 * above it, or down from below), which the caller uses to fade the layer out
 * rather than sampling garbage.
 */
vec2 layerHit(vec3 dir, float layerY, out float ok, out float range) {
  float dy = layerY - cameraPosition.y;
  ok = step(0.0002, dy * dir.y);
  // Grazing rays run to the horizon; clamp so the noise does not alias into
  // a moiré band right at eye level.
  float t = clamp(dy / (abs(dir.y) < 0.004 ? sign(dir.y) * 0.004 : dir.y), 0.0, 260000.0);
  range = t;
  return cameraPosition.xz + dir.xz * t;
}

void main() {
  vec3 dir = normalize(vWorld - cameraPosition);
  float camY = cameraPosition.y;

  float above = smoothstep(uCloudTops, uCloudTops + 260.0, camY);
  float below = 1.0 - smoothstep(uCloudBase - 140.0, uCloudBase, camY);
  float inside = clamp(1.0 - above - below, 0.0, 1.0);

  // ---- clear night sky, above the deck ------------------------------------
  float up = clamp(dir.y, -1.0, 1.0);
  vec3 clear = uSkyColor * (0.55 + 0.45 * smoothstep(-0.1, 0.6, up));
  clear += vec3(0.9, 0.95, 1.0) * starField(dir) * 0.9 * smoothstep(0.0, 0.25, up);
  float moon = max(dot(dir, uMoonDir), 0.0);
  clear += uMoonColor * (pow(moon, 900.0) * 6.0 + pow(moon, 26.0) * 0.06);
  // The storm's own anvil, thirty thousand feet of it, off to the north-west.
  float ok1, r1;
  vec2 anvil = layerHit(dir, uStormTops, ok1, r1);
  float tower = fbm(anvil * 0.000045 + vec2(uTime * 0.0009, 0.0));
  clear = mix(clear, uMoonColor * 0.10 + vec3(1.0) * uFlash * 0.5,
              ok1 * smoothstep(0.45, 0.78, tower) * smoothstep(0.02, 0.2, up));

  // ---- the tops of the overcast, seen from above ---------------------------
  float okT, rT;
  vec2 topsP = layerHit(dir, uCloudTops, okT, rT);
  float topsN = fbm(topsP * 0.00028 + vec2(uTime * 0.004, uTime * 0.0016));
  float topsN2 = fbm(topsP * 0.0011 - vec2(uTime * 0.006, 0.0));
  float relief = topsN * 0.72 + topsN2 * 0.28;
  vec3 tops = uMoonColor * (0.055 + 0.16 * smoothstep(0.28, 0.75, relief));
  // Lightning inside the deck lights it from below and behind, which from on
  // top is the single most beautiful thing in this world.
  tops += vec3(1.0, 0.97, 0.9) * uFlash * (0.17 + 0.62 * smoothstep(0.3, 0.7, relief));
  tops = mix(uHazeColor + uCityGlow * 0.006, tops, smoothstep(0.0, 0.045, -dir.y));
  vec3 aboveCol = mix(clear, tops, okT * smoothstep(0.0, -0.012, dir.y));

  // ---- the base of the overcast, seen from underneath ----------------------
  float okB, rB;
  vec2 baseP = layerHit(dir, uCloudBase, okB, rB);
  float baseN = fbm(baseP * 0.00042 + vec2(uTime * 0.005, uTime * 0.002));
  // Lit from below by a city of three million sodium lamps. The falloff with
  // range is what stops the whole ceiling being one flat orange.
  //
  // The coefficients here are the most sensitive numbers in the world. A
  // city-lit overcast is *dim* — you can read it as orange, and you can see
  // structure in it, and it is nowhere near as bright as the lights causing
  // it. The first pass ran this ten times too hot and produced a sky the
  // colour of a sodium lamp itself, which drowned the runway lighting the
  // entire ending depends on being able to pick out.
  float glow = exp(-rB * 0.00006);
  vec3 base = uCloudColor * 0.55 + uCityGlow * (0.004 + 0.042 * glow) * (0.22 + 0.78 * baseN * baseN);
  base += vec3(1.0) * uFlash * (0.16 + 0.30 * baseN);
  vec3 belowCol = mix(uHazeColor + uCityGlow * 0.006, base, okB * smoothstep(0.0, 0.05, dir.y));

  // ---- inside it ----------------------------------------------------------
  vec3 insideCol = uCloudColor * (0.55 + 0.25 * fbm(dir.xz * 22.0 + uTime * 0.35))
                 + uCityGlow * 0.010
                 + vec3(1.0) * uFlash * 0.62;

  vec3 col = aboveCol * above + belowCol * below + insideCol * inside;

  // Below the horizon the dome is only ever a backdrop for terrain that has
  // not been drawn yet — keep it the colour the haze fades into so the seam
  // at the horizon does not exist.
  col = mix(col, uHazeColor + uCityGlow * 0.008, smoothstep(-0.005, -0.09, dir.y) * (1.0 - inside));

  gl_FragColor = vec4(outputColor(max(col, vec3(0.0))), 1.0);
}
`;

export interface SkySystem extends System {
  env: EnvUniforms;
}

export function createSky(ctx: PlaneCtx): SkySystem {
  const env = makeEnvUniforms();
  const lightning = new Lightning();

  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: withEnv(env, { uStormTops: { value: WEATHER.stormTops } }),
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });

  const dome = new THREE.Mesh(new THREE.SphereGeometry(3000, 40, 24), material);
  dome.frustumCulled = false;
  // Drawn first, writing no depth, so everything else lands on top of it
  // without the dome needing to be larger than the far plane.
  dome.renderOrder = -1000;
  dome.onBeforeRender = (_r, _s, camera) => {
    // Sync here and not in update(). One frame of lag at 250 knots puts the
    // camera outside a dome this size on the next resize, and the sky goes
    // black on one side only.
    dome.position.copy(camera.position);
    env.uCameraHeight.value = camera.position.y;
  };
  ctx.scene.add(dome);

  let storm = 0.85;
  let nextStrike = 2.5;

  const service: SkyService = {
    rain: env.uRain.value,
    storm,
    setStorm(v: number) {
      storm = Math.max(0, Math.min(1, v));
      applyStormIntensity(env, storm);
      service.storm = storm;
      service.rain = env.uRain.value;
    },
    strike(intensity = 1) {
      const dir = new THREE.Vector3(
        ctx.rng.range(-1, 1),
        ctx.rng.range(0.05, 0.6),
        ctx.rng.range(-1, 1),
      ).normalize();
      lightning.strike(intensity, dir);
      env.uFlashDir.value.copy(dir);
      ctx.emit("lightning", { intensity });
      (ctx.services.audio as { cue?: (n: string, o?: object) => void } | undefined)?.cue?.(
        "thunder",
        { gain: 0.35 + intensity * 0.65 },
      );
    },
    cloudBase: WEATHER.cloudBase,
    cloudTops: WEATHER.cloudTops,
  };

  service.setStorm(storm);
  ctx.services.sky = service;
  // Published so every other system's materials can share these exact uniform
  // objects. Three only shares a uniform between materials when it is handed
  // the same object, and that is the whole mechanism by which one write to
  // `uFlash` lights the cloud, the city, the runway and the wing in one frame.
  ctx.services.skyEnv = env;

  return {
    env,
    update(dt) {
      env.uTime.value += dt;
      env.uFlash.value = lightning.update(dt);

      // Strikes arrive as a Poisson-ish process whose rate is the storm. A
      // fixed interval reads as a lighthouse; this reads as weather.
      nextStrike -= dt * (0.25 + storm * 1.7);
      if (nextStrike <= 0) {
        nextStrike = ctx.rng.range(0.7, 4.5);
        service.strike(ctx.rng.range(0.35, 1));
      }
    },
    dispose() {
      ctx.scene.remove(dome);
      dome.geometry.dispose();
      material.dispose();
    },
  };
}
