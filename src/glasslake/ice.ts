/**
 * The lake.
 *
 * One disc, one shader, no render targets except the carve trail. The
 * reflection is `glAurora` again, evaluated along the reflected view ray
 * from the point being shaded — see the note at the top of `glsl.ts` for
 * why that beats a planar mirror here.
 *
 * The rest of the material is the argument that fresh black ice is the most
 * beautiful surface in nature and nobody renders it properly: it is nearly
 * a mirror at grazing angles and nearly a window straight down, it is full
 * of frozen pressure cracks that catch light from underneath, and the frost
 * on it is not a texture but a scatter of individual glints that only fire
 * when the geometry is right.
 */
import * as THREE from "three";
import { glslLibrary } from "./glsl";

export interface IceHandle {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  setEnergy(e: number): void;
  setTrailTexture(tex: THREE.Texture): void;
  update(time: number, camera: THREE.Camera): void;
  dispose(): void;
}

const VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAG = (lib: string) => /* glsl */ `
precision highp float;
${lib}
uniform float uTime;
uniform float uEnergy;
uniform vec3 uMoonDir;
uniform vec3 uCamera;
uniform sampler2D uTrail;
uniform float uExtent;      // half-width of the trail texture in metres
uniform float uRadius;      // lake radius, for the shore fade
varying vec3 vWorld;

/**
 * Pressure cracks. Ridged fbm inverted so the *thin* valleys light up:
 * a crack is where the ice parted and the aurora gets underneath it.
 */
float glCracks(vec2 p) {
  float a = abs(glFbm(p * 0.055) - 0.5) * 2.0;
  float b = abs(glFbm(p * 0.021 + 31.7) - 0.5) * 2.0;
  float veins = 1.0 - smoothstep(0.0, 0.09, min(a, b));
  // A second, much rarer set of long fractures across the whole lake.
  float c = abs(glFbm(p * 0.0065 + 91.3) - 0.5) * 2.0;
  return max(veins * 0.55, (1.0 - smoothstep(0.0, 0.035, c)) * 0.9);
}

void main() {
  vec3 I = normalize(vWorld - uCamera);
  float dist = length(vWorld.xz - uCamera.xz);

  // ---- Surface normal ------------------------------------------------
  // Frost relief, fading out with distance so the horizon stays a mirror
  // instead of dissolving into aliased noise.
  float detail = exp(-dist * 0.006);
  vec2 q = vWorld.xz;
  float h1 = glFbm(q * 0.35 + vec2(uTime * 0.02, 0.0));
  vec2 slope = vec2(
    h1 - glFbm((q + vec2(0.35, 0.0)) * 0.35 + vec2(uTime * 0.02, 0.0)),
    h1 - glFbm((q + vec2(0.0, 0.35)) * 0.35 + vec2(uTime * 0.02, 0.0))
  );
  // Barely. This is ice, not water: the reflected ray is the whole picture,
  // and the aurora has hard-edged bands in it, so a normal that wanders by
  // even a couple of degrees turns the mirror into camouflage. At 0.10 the
  // relief reads as the surface being imperfect. At 1.6 it read as static.
  vec3 N = normalize(vec3(slope.x * 0.10 * detail, 1.0, slope.y * 0.10 * detail));

  // ---- Reflection ----------------------------------------------------
  vec3 R = reflect(I, N);
  vec3 refl = glAurora(vWorld, R, uTime, uEnergy, glDither(gl_FragCoord.xy));
  refl += glStars(R, uTime) * 0.55;
  refl += glMoon(R, normalize(uMoonDir)) * 0.75;
  // An analytic reflection has no idea the ridgeline is in the way, so the
  // far strip of the lake was mirroring aurora through a mountain — and
  // brighter than the sky above it, which is the tell. Fading the shallowest
  // reflected rays stands in for that occlusion: below a couple of degrees,
  // what a lake reflects is the black shore opposite.
  refl *= smoothstep(0.018, 0.085, R.y);

  // Schlick, with ice's real F0. Near the camera you look *into* the lake;
  // far away it is a mirror. That gradient is most of the picture.
  float cosT = clamp(dot(-I, N), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);

  // ---- What is under the ice -----------------------------------------
  // Deep water, plus the same aurora leaking through diffusely — it is the
  // only light source in the world, so nothing may be lit by anything else.
  vec3 skyAmbient = glAurora(vWorld, vec3(0.0, 1.0, 0.0), uTime, uEnergy, 0.5);
  float bubbles = smoothstep(0.62, 0.95, glFbm(q * 0.9 + vec2(0.0, uTime * 0.03)));
  vec3 below = vec3(0.008, 0.020, 0.034) + skyAmbient * 0.15 + bubbles * vec3(0.03, 0.06, 0.07);

  float cracks = glCracks(q) * detail;
  below += cracks * (skyAmbient * 1.6 + vec3(0.05, 0.10, 0.13));

  vec3 col = mix(below, refl, F);

  // ---- Frost glints ---------------------------------------------------
  // Individual specks that only fire when the half-vector lines up, so the
  // field crawls as you skate instead of sitting there like grain.
  vec2 gcell = floor(q * 6.0);
  float g = glHash21(gcell);
  vec2 gf = fract(q * 6.0) - 0.5;
  float spec = smoothstep(0.22, 0.0, length(gf)) * step(0.955, g);
  // Almost all of the glint is the moon: a frost crystal that lights up
  // whichever way it faces is not a crystal, it is sand.
  float align = pow(max(dot(R, normalize(uMoonDir)), 0.0), 20.0)
              + pow(max(R.y, 0.0), 6.0) * 0.08;
  col += spec * align * detail * vec3(0.9, 0.97, 1.0) * 1.1;

  // ---- Carve trails ----------------------------------------------------
  vec2 tuv = vWorld.xz / (2.0 * uExtent) + 0.5;
  float trail = texture2D(uTrail, tuv).r;
  // A cut edge, then the faint melt-glow spreading out of it. This wants to
  // read as a scratch that caught the light, not as a lit runway: at 1.9 it
  // clipped to white and became the brightest thing on the lake, which is
  // exactly backwards — the sky is supposed to be.
  vec3 trailTint = mix(vec3(0.35, 1.0, 0.75), vec3(0.75, 0.55, 1.0), uEnergy);
  col += trailTint * (pow(trail, 3.0) * 0.42 + trail * 0.07);
  // The cut also roughens the ice, so it stops mirroring where you have been.
  col = mix(col, col * 0.78 + trailTint * 0.05, smoothstep(0.2, 0.8, trail));

  // ---- Horizon ---------------------------------------------------------
  // Ice meets night. Fade to the same colour the sky has at the horizon so
  // there is no seam, only distance.
  float shore = smoothstep(uRadius * 0.86, uRadius * 1.02, length(vWorld.xz));
  vec3 haze = vec3(0.020, 0.031, 0.058) + skyAmbient * 0.20;
  col = mix(col, haze, max(shore, smoothstep(120.0, 640.0, dist) * 0.85));

  gl_FragColor = vec4(col, 1.0);
}
`;

export function buildIce(opts: {
  radius: number;
  trailExtent: number;
  auroraSteps: number;
}): IceHandle {
  const material = new THREE.ShaderMaterial({
    name: "GlassLakeIce",
    vertexShader: VERT,
    fragmentShader: FRAG(glslLibrary(opts.auroraSteps)),
    uniforms: {
      uTime: { value: 0 },
      uEnergy: { value: 0 },
      uMoonDir: { value: new THREE.Vector3(-0.42, 0.16, -0.9).normalize() },
      uCamera: { value: new THREE.Vector3() },
      uTrail: { value: null },
      uExtent: { value: opts.trailExtent },
      uRadius: { value: opts.radius },
    },
    fog: false,
  });

  // A disc, not a plane: the shore fade is radial, and a square lake reads
  // as a swimming pool the moment you can see two of its corners.
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(opts.radius, 96), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.name = "ice";

  return {
    mesh,
    material,
    setEnergy(e) {
      material.uniforms.uEnergy.value = e;
    },
    setTrailTexture(tex) {
      material.uniforms.uTrail.value = tex;
    },
    update(time, camera) {
      material.uniforms.uTime.value = time;
      (material.uniforms.uCamera.value as THREE.Vector3).copy(camera.position);
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
