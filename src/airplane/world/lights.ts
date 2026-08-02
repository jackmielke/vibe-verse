/**
 * Point lights, as seen from an aeroplane at night.
 *
 * Every light on the airport — approach bars, the rabbit, threshold, edges,
 * centreline, touchdown zone, PAPI, taxiways, and the red beacons on the
 * skyline — is a vertex in one of these. There is no geometry underneath any
 * of them, and there does not need to be: at night a runway *is* its lights,
 * and a light is a point source with a glow around it.
 *
 * ## The thing that makes it look real
 *
 * A real light does not shrink to nothing with distance. Beyond a few
 * kilometres its image is smaller than one cell of your retina — or one pixel
 * — and what changes with distance after that is its *brightness*, not its
 * size. So the size here attenuates with range down to a floor of about a
 * pixel and a half and then stops, while the intensity keeps falling with the
 * inverse square. Without the floor, an approach lighting system eight miles
 * out simply is not drawn, and the single most important thing you are
 * supposed to be looking for out of the windshield is invisible until it is
 * too late to use it. With it, the airport appears as a faint cluster at the
 * right distance and resolves into bars and a centreline as you close in,
 * which is precisely what happens in an aeroplane.
 */
import * as THREE from "three";
import { ENV_UNIFORMS_GLSL, OUTPUT_GLSL, withEnv, type EnvUniforms } from "./env";

export interface LightSpec {
  position: THREE.Vector3;
  color: THREE.Color | number;
  /** Relative brightness. 1 is a runway edge light. */
  intensity?: number;
  /**
   * The glow's radius in metres.
   *
   * Not the size of the lens — a runway edge light is 15 cm across and its
   * *glow* in rain at night is a couple of metres, which is the thing being
   * drawn. Values here are around 1–3 m; anything much larger turns into a
   * beach ball the moment you taxi past one.
   */
  size?: number;
  /**
   * Blink group. 0 = steady. Positive values index a phase in the shader, so
   * the sequenced flashers ("the rabbit") can run up the approach in order.
   */
  flash?: number;
  /**
   * Directionality. A runway light is not a bulb in free space — it is a
   * shielded lens aimed down the approach, and it disappears when you are
   * abeam it. `axis` is the direction it shines; omitted means omnidirectional.
   */
  axis?: THREE.Vector3;
  /** How tightly it is focused. Higher is narrower. */
  focus?: number;
}

const VERT = /* glsl */ `
attribute vec3 aColor;
attribute vec4 aParams;   // x: intensity, y: size, z: flash group, w: focus
attribute vec3 aAxis;

varying vec3 vColor;
varying float vAlpha;

${ENV_UNIFORMS_GLSL}

uniform float uViewportHeight;
uniform float uRabbit;

/** The smallest a light is ever drawn. Below this, brightness carries range. */
const float MIN_PX = 1.7;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec4 view = viewMatrix * world;
  float dist = max(-view.z, 1.0);

  float intensity = aParams.x;

  // Directional lights fade out as you move off their axis.
  if (aParams.w > 0.001) {
    vec3 toEye = normalize(cameraPosition - world.xyz);
    float aim = max(dot(normalize(aAxis), toEye), 0.0);
    intensity *= pow(aim, aParams.w);
  }

  // The sequenced flashers. Group n lights at phase n/15 of a half-second
  // cycle, which is what makes the rabbit run *towards* the threshold rather
  // than twinkling at random.
  if (aParams.z > 0.5) {
    float phase = fract(uRabbit - aParams.z * 0.0455);
    intensity *= smoothstep(0.06, 0.0, phase) * 2.4;
  }

  // The pixel size is derived rather than tuned: a glow of radius r metres at
  // distance d subtends 2r/d, the screen height covers 2·tan(fov/2), and
  // projectionMatrix[1][1] is exactly 1/tan(fov/2). So the whole thing is
  // r·H·P11/d — correct at every resolution and every field of view. A
  // hand-tuned constant here is the right size on the machine it was tuned on
  // and four times too big on a phone.
  float natural = aParams.y * uViewportHeight * projectionMatrix[1][1] / dist;
  gl_PointSize = clamp(natural, MIN_PX, 90.0);

  // Brightness, in two parts.
  //
  // **Resolution.** While the glow is bigger than a pixel it is a small
  // surface, and a surface's brightness does not change with distance — only
  // its size does. Once it drops below a pixel the renderer can no longer
  // shrink it, so the *brightness* has to carry the falloff instead. The
  // exponent is 0.9 rather than the physically exact 2.0 on purpose: a true
  // inverse square makes an approach lighting system invisible at four miles,
  // which is photometrically correct and completely wrong, because the eye's
  // response to a point source at night is nothing like linear and neither is
  // a monitor's. Every flight simulator fudges this and this is the fudge.
  float unresolved = pow(clamp(natural / MIN_PX, 0.02, 1.0), 0.9);

  // **Extinction.** What actually limits how far you can see a light at night
  // is not distance, it is the air between — and tonight the air is full of
  // rain. This is the term that makes the airport swim into view at the right
  // range instead of being either always visible or never.
  float extinction = exp(-dist * (0.00006 + uRain * 0.00011));

  vAlpha = intensity * unresolved * extinction;
  vColor = aColor;
  gl_Position = projectionMatrix * view;
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vAlpha;
${ENV_UNIFORMS_GLSL}
${OUTPUT_GLSL}

void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;
  // A hot core in a soft halo. One gaussian alone reads as a fuzzy dot; the
  // core is what makes it read as a *lamp*.
  float core = exp(-r2 * 13.0);
  float halo = exp(-r2 * 2.0) * 0.55;

  // Alpha is 1 and the colour carries everything. Three's additive blending is
  // src.rgb * src.a + dst, so putting the brightness in *both* channels —
  // which is the obvious thing to write — squares it, and every light in the
  // world then falls off twice as fast as intended.
  vec3 col = vColor * (core * 2.2 + halo) * vAlpha * 2.4;
  gl_FragColor = vec4(outputColor(col), 1.0);
}
`;

export interface LightField {
  points: THREE.Points;
  material: THREE.ShaderMaterial;
  /** Advance the sequenced flashers. */
  update(dt: number): void;
  dispose(): void;
}

const _c = new THREE.Color();

export function createLightField(
  env: EnvUniforms,
  lights: LightSpec[],
  opts: { viewportHeight?: number } = {},
): LightField {
  const n = lights.length;
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const params = new Float32Array(n * 4);
  const axes = new Float32Array(n * 3);

  for (let i = 0; i < n; i++) {
    const l = lights[i];
    positions[i * 3] = l.position.x;
    positions[i * 3 + 1] = l.position.y;
    positions[i * 3 + 2] = l.position.z;
    _c.set(l.color as THREE.ColorRepresentation);
    colors[i * 3] = _c.r;
    colors[i * 3 + 1] = _c.g;
    colors[i * 3 + 2] = _c.b;
    params[i * 4] = l.intensity ?? 1;
    params[i * 4 + 1] = l.size ?? 6;
    params[i * 4 + 2] = l.flash ?? 0;
    params[i * 4 + 3] = l.axis ? (l.focus ?? 2.5) : 0;
    if (l.axis) {
      axes[i * 3] = l.axis.x;
      axes[i * 3 + 1] = l.axis.y;
      axes[i * 3 + 2] = l.axis.z;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("aParams", new THREE.BufferAttribute(params, 4));
  geometry.setAttribute("aAxis", new THREE.BufferAttribute(axes, 3));
  geometry.computeBoundingSphere();

  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: withEnv(env, {
      uViewportHeight: { value: opts.viewportHeight ?? 720 },
      uRabbit: { value: 0 },
    }),
    transparent: true,
    depthWrite: false,
    // Additive: lights add to whatever is behind them, which is what light
    // does. It also means the approach lighting stays visible through the
    // cloud fog rather than being blended away by it.
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  return {
    points,
    material,
    update(dt: number) {
      // Two flashes a second up the bars, which is what an ALSF-II does.
      material.uniforms.uRabbit.value = (material.uniforms.uRabbit.value + dt * 2) % 1;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/** Tell a field how tall the framebuffer is, in real pixels. */
export function setViewportHeight(field: LightField, height: number, dpr: number): void {
  field.material.uniforms.uViewportHeight.value = height * dpr;
}
