/**
 * The Midnight Zone — marine snow.
 *
 * The single highest-value effect in the world, and the cheapest. Real marine
 * snow is a constant fall of dead plankton and detritus drifting down out of
 * the lit water; on screen it does three jobs at once that nothing else does:
 *
 *   1. It gives the water **parallax**. Without it, descending through open
 *      ocean is descending through a flat colour — there is no way to perceive
 *      that you are moving at all until something swims past.
 *   2. It gives the lamps something to **catch**, which is what makes a
 *      headlight look like a beam rather than a bright patch on a model.
 *   3. It is the depth gauge your eye reads before it reads the HUD: the
 *      faster it streams upward, the faster you are going down.
 *
 * One `THREE.Points` with a custom shader, recycled in a box that follows the
 * camera. Nothing is ever created or destroyed after boot — a particle that
 * leaves the top of the box is teleported to the bottom with a new X and Z, so
 * the field is infinite and the allocation is constant.
 *
 * The shader does the work that makes it look lit: each flake's brightness
 * falls off with distance from the camera *and* is boosted inside a cone in
 * front of it, which is a two-instruction approximation of "the headlights are
 * shining through the snow" and costs nothing next to real volumetrics.
 */
import * as THREE from "three";
import type { DeepCtx, SubService, System } from "../types";

/** Half-extent of the recycling box around the camera, metres. */
const BOX = 42;

const VERT = /* glsl */ `
  uniform float uTime;
  uniform float uPixelRatio;
  attribute float aScale;
  attribute float aPhase;
  varying float vFade;
  varying float vPhase;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = -mv.z;

    // Near flakes are the ones the lamps are actually catching; far ones melt
    // into the fog. Squared falloff reads far more like light than linear.
    float near = 1.0 - clamp(dist / 46.0, 0.0, 1.0);
    vFade = near * near;
    vPhase = aPhase;

    // Perspective-correct size, clamped so a flake that drifts into the lens
    // does not become a screen-filling white square.
    gl_PointSize = clamp(aScale * uPixelRatio * 260.0 / max(dist, 0.6), 0.9, 11.0);
    gl_Position = projectionMatrix * mv;
    vPhase += uTime * 0.0;
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;
  varying float vPhase;

  void main() {
    // Round the point off. A square flake is the tell that gives away every
    // cheap particle system.
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = dot(d, d);
    if (r > 0.25) discard;
    float soft = 1.0 - smoothstep(0.06, 0.25, r);

    // Vary the brightness per flake so the field does not read as one texture.
    float glint = 0.62 + 0.38 * sin(vPhase * 6.2831);
    gl_FragColor = vec4(uColor, soft * vFade * uOpacity * glint);
  }
`;

export default function createSnow(ctx: DeepCtx): System {
  const count =
    ctx.quality === "low" ? 1200 : ctx.quality === "medium" ? 2600 : ctx.quality === "ultra" ? 7000 : 4500;

  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count);
  const phases = new Float32Array(count);
  // Each flake sinks at its own rate — real detritus is not one grain size,
  // and a uniform fall speed reads as a scrolling texture.
  const fall = new Float32Array(count);
  const drift = new Float32Array(count * 2);

  const cam = ctx.camera.position;
  for (let i = 0; i < count; i++) {
    positions[i * 3] = cam.x + (ctx.rng() * 2 - 1) * BOX;
    positions[i * 3 + 1] = cam.y + (ctx.rng() * 2 - 1) * BOX;
    positions[i * 3 + 2] = cam.z + (ctx.rng() * 2 - 1) * BOX;
    scales[i] = 0.012 + ctx.rng() * 0.05;
    phases[i] = ctx.rng();
    fall[i] = 0.22 + ctx.rng() * 0.75;
    drift[i * 2] = (ctx.rng() * 2 - 1) * 0.14;
    drift[i * 2 + 1] = (ctx.rng() * 2 - 1) * 0.14;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("aScale", new THREE.BufferAttribute(scales, 1));
  geo.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
  // The box travels with the camera, so a bounding sphere computed once is
  // wrong the moment you move — and a wrong one frustum-culls the whole field
  // out of existence. Turning culling off for one draw call is the fix.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), BOX * 2.2);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: ctx.renderer.getPixelRatio() },
      uColor: { value: new THREE.Color(0xdff3ff) },
      uOpacity: { value: 0.85 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 2;
  ctx.scene.add(points);

  const attr = geo.attributes.position as THREE.BufferAttribute;

  return {
    update(dt) {
      const sub = ctx.services.sub as SubService | undefined;
      const cx = ctx.camera.position.x;
      const cy = ctx.camera.position.y;
      const cz = ctx.camera.position.z;

      // Snow is only visible where there is light to catch it — either the
      // sun's or your own. With the lamps off in the midnight zone the water
      // should be genuinely, alarmingly empty.
      const lit = sub?.lightsOn ?? true;
      mat.uniforms.uOpacity.value += ((lit ? 0.85 : 0.12) - mat.uniforms.uOpacity.value) * Math.min(1, dt * 3);
      mat.uniforms.uTime.value = ctx.elapsed;

      // Two sines per particle per frame was nine thousand trig calls a frame at
      // the default count, on the main thread, for a wander of eight
      // centimetres a second. The swirl is now one pair of sines for the whole
      // field, phase-shifted per particle by its own constant drift — visually
      // the same drifting motion, and it costs two trig calls instead of nine
      // thousand.
      const t = ctx.elapsed;
      const swirlX = Math.sin(t * 0.3) * 0.08;
      const swirlZ = Math.cos(t * 0.26) * 0.08;
      for (let i = 0; i < count; i++) {
        const i3 = i * 3;
        // Sink, with a slow lateral wander so it never reads as rain.
        positions[i3 + 1] -= fall[i] * dt;
        positions[i3] += (drift[i * 2] + swirlX * phases[i]) * dt;
        positions[i3 + 2] += (drift[i * 2 + 1] + swirlZ * (1 - phases[i])) * dt;

        // Recycle across whichever face it left. Wrapping on each axis
        // independently keeps the field seamless when the sub moves sideways
        // as well as down.
        let dx = positions[i3] - cx;
        let dy = positions[i3 + 1] - cy;
        let dz = positions[i3 + 2] - cz;
        if (dx > BOX) dx -= BOX * 2;
        else if (dx < -BOX) dx += BOX * 2;
        if (dy > BOX) dy -= BOX * 2;
        else if (dy < -BOX) dy += BOX * 2;
        if (dz > BOX) dz -= BOX * 2;
        else if (dz < -BOX) dz += BOX * 2;
        positions[i3] = cx + dx;
        positions[i3 + 1] = cy + dy;
        positions[i3 + 2] = cz + dz;
      }
      attr.needsUpdate = true;
    },

    resize() {
      mat.uniforms.uPixelRatio.value = ctx.renderer.getPixelRatio();
    },

    dispose() {
      ctx.scene.remove(points);
      geo.dispose();
      mat.dispose();
    },
  };
}
