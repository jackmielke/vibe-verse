/**
 * Rain, and the wisps of cloud that whip past when you are inside it.
 *
 * Both are the same trick: a box of instanced particles that follows the
 * camera and wraps around it, so a few thousand of them look like weather
 * filling the whole sky rather than a cube of confetti you are flying through.
 * The wrap is a modulo, done in the vertex shader against the camera position,
 * which means nothing is ever uploaded per frame.
 *
 * ## Rain from an aeroplane does not fall
 *
 * At 140 knots the drop's downward speed is irrelevant — it is doing 3 m/s
 * down and you are doing 72 m/s forward, so relative to the windshield it
 * travels almost exactly backwards along your flight path. The streak's
 * *direction* is therefore the relative wind, and its *length* is your
 * airspeed, which is why rain out of a cockpit window looks like a starfield
 * and rain out of a car window looks like rain. Modelling that is one dot
 * product and it is the whole difference between this looking like flight and
 * looking like a screensaver.
 */
import * as THREE from "three";
import { ENV_UNIFORMS_GLSL, OUTPUT_GLSL, withEnv, type EnvUniforms } from "./env";
import type { PlaneCtx, System } from "../types";
import type { AircraftService } from "../play/aircraft";

/** Half-size of the box of rain that follows you around. */
const BOX = 90;

const RAIN_VERT = /* glsl */ `
attribute vec3 aSeed;
varying float vFade;
varying vec2 vLocal;

${ENV_UNIFORMS_GLSL}
uniform vec3  uBoxCenter;
uniform vec3  uStreak;      // direction * length, world space
uniform float uBox;

void main() {
  // Wrap the seed position into a box centred on the camera. mod on the
  // offset from the centre keeps every drop within BOX of the eye without
  // anything being re-uploaded, re-sorted or re-allocated.
  vec3 p = aSeed;
  p.y -= uTime * 6.0;                        // drops do still fall, a bit
  vec3 rel = mod(p - uBoxCenter + uBox, uBox * 2.0) - uBox;
  vec3 world = uBoxCenter + rel;

  // Build the streak as a billboard: position.y runs 0..1 along the streak
  // and position.x is its width, expanded towards the eye.
  vec3 toEye = normalize(cameraPosition - world);
  vec3 along = uStreak;
  vec3 side = normalize(cross(normalize(along + vec3(1e-4)), toEye)) * 0.022;

  vec3 offset = along * position.y + side * position.x;
  vec4 mv = viewMatrix * vec4(world + offset, 1.0);

  // Fade out the ones nearly on top of the lens, which otherwise become huge
  // grey bars across the middle of the windshield.
  float d = length(world - cameraPosition);
  vFade = smoothstep(1.2, 6.0, d) * (1.0 - smoothstep(uBox * 0.55, uBox, d));
  vLocal = position.xy;
  gl_Position = projectionMatrix * mv;
}
`;

const RAIN_FRAG = /* glsl */ `
precision highp float;
varying float vFade;
varying vec2 vLocal;
${ENV_UNIFORMS_GLSL}
${OUTPUT_GLSL}

void main() {
  // Soft along the streak and across it, so there are no hard ends.
  float a = vFade * uRain * (1.0 - abs(vLocal.x) * 2.0) * 0.5;
  a *= smoothstep(0.0, 0.12, vLocal.y) * smoothstep(1.0, 0.75, vLocal.y);
  if (a <= 0.002) discard;
  // Rain is not white. It is whatever is lighting it — which at night is the
  // city underneath and, four times a minute, everything.
  vec3 col = uCloudColor * 1.6 + uCityGlow * 0.22 + vec3(1.0) * uFlash * 0.9;
  gl_FragColor = vec4(outputColor(col), a * 0.5);
}
`;

export function createWeather(ctx: PlaneCtx): System {
  const env = ctx.services.skyEnv as EnvUniforms | undefined;
  if (!env) throw new Error("weather needs the sky's env uniforms");

  // Deliberately sparse. Rain streaks are drawn as translucent quads and every
  // one of them covers real screen area at 90 metres; the first pass used 3,600
  // and the overlap turned the whole windshield into a grey wall. What sells
  // rain from a cockpit is a few dozen streaks moving *fast*, not a fog of them.
  const count = ctx.quality === "low" ? 220 : ctx.quality === "medium" ? 500 : 900;

  // One quad, instanced. `position.y` runs 0..1 along the streak.
  const quad = new THREE.InstancedBufferGeometry();
  quad.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3),
  );
  quad.setIndex([0, 1, 2, 0, 2, 3]);

  const seeds = new Float32Array(count * 3);
  const rng = ctx.rng.fork(0x7a11);
  for (let i = 0; i < count; i++) {
    seeds[i * 3] = rng.range(-BOX, BOX);
    seeds[i * 3 + 1] = rng.range(-BOX, BOX);
    seeds[i * 3 + 2] = rng.range(-BOX, BOX);
  }
  quad.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 3));
  quad.instanceCount = count;

  const material = new THREE.ShaderMaterial({
    vertexShader: RAIN_VERT,
    fragmentShader: RAIN_FRAG,
    uniforms: withEnv(env, {
      uBoxCenter: { value: new THREE.Vector3() },
      uStreak: { value: new THREE.Vector3(0, -1, 0) },
      uBox: { value: BOX },
    }),
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    // Normal blending, not additive. Additive is right for a point light and
    // wrong for anything there are thousands of: each streak tone-maps its own
    // contribution and the blend then sums *display-referred* values, so the
    // ACES roll-off that was supposed to protect the highlights is applied
    // before the thing that overflows them. Twenty overlapping streaks go to
    // white no matter how dim each one is.
    blending: THREE.NormalBlending,
  });

  const rain = new THREE.Mesh(quad, material);
  rain.frustumCulled = false;
  rain.renderOrder = 900;
  ctx.scene.add(rain);

  const streak = new THREE.Vector3();
  const relative = new THREE.Vector3();

  return {
    lateUpdate(_dt, c) {
      const air = c.services.flight as AircraftService | undefined;
      const cam = c.camera.position;
      material.uniforms.uBoxCenter.value.copy(cam);

      // The streak is the relative wind, scaled by how fast it is going past.
      // Parked on the runway that collapses to a short vertical drop, which is
      // exactly right and comes out of the same expression.
      relative.set(0, -5, 0);
      if (air) relative.sub(air.state.velocity).addScaledVector(air.model.wind.steady, 1);
      const speed = relative.length();
      streak.copy(relative).normalize().multiplyScalar(Math.min(0.35 + speed * 0.045, 5.5));
      material.uniforms.uStreak.value.copy(streak);

      // Rain only exists below the tops. Above them it is clear and starry,
      // and streaks up there read as a broken renderer.
      const inWeather = cam.y < env.uCloudTops.value + 300;
      rain.visible = inWeather && env.uRain.value > 0.02;
    },
    dispose() {
      ctx.scene.remove(rain);
      quad.dispose();
      material.dispose();
    },
  };
}
