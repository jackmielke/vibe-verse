/**
 * Sky, sun, and the cloud deck.
 *
 * Three pieces, and the order they are drawn in is the whole trick:
 *
 * 1. A dome that rides the camera with `gl_Position.z = gl_Position.w`, which
 *    pins it to the far plane no matter where the far plane is. At 240 km that
 *    matters — a dome with an actual radius either clips through the Cascades
 *    or z-fights with them.
 * 2. Two cloud sheets on virtual altitude planes, ray-marched from the camera
 *    rather than modelled. They are the only thing in the world that tells you
 *    how fast you are actually going when you are at 12,000 feet with nothing
 *    but water underneath, which is why they are here and not in the "later"
 *    pile.
 * 3. A directional light and a hemisphere fill, taking their colours from the
 *    same `EnvUniforms` the dome shades with.
 */
import * as THREE from "three";
import type { AngelsCtx, System } from "../types";
import {
  ATMOSPHERE_GLSL,
  ENV_UNIFORMS_GLSL,
  OUTPUT_GLSL,
  SEAFAIR_AFTERNOON,
  applyTimeOfDay,
  makeEnvUniforms,
  type EnvUniforms,
} from "./env";

export interface EnvService {
  uniforms: EnvUniforms;
  timeOfDay: number;
  setTimeOfDay(t: number): void;
  sunDirection: THREE.Vector3;
  key: THREE.DirectionalLight;
}

export function createSky(ctx: AngelsCtx): System {
  const env = makeEnvUniforms();
  let timeOfDay = SEAFAIR_AFTERNOON;
  applyTimeOfDay(env, timeOfDay);

  // ---- dome ---------------------------------------------------------------
  // Radius 10 rather than 1: the dome is pinned to the far plane by the vertex
  // shader so its size does not affect depth, but the camera has to be *inside*
  // it or a back-faced sphere renders as a small blob instead of a sky.
  const domeGeo = new THREE.SphereGeometry(10, 48, 32);
  const domeMat = new THREE.ShaderMaterial({
    uniforms: env as unknown as Record<string, THREE.IUniform>,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        // Pin to the far plane. The dome then has no scale to get wrong.
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      ${ENV_UNIFORMS_GLSL}
      ${OUTPUT_GLSL}
      ${ATMOSPHERE_GLSL}
      void main() {
        vec3 dir = normalize(vDir);
        vec3 col = outputColor(skyRadiance(dir));
        // Hashed dither, applied after the encode. A gradient this smooth bands
        // visibly in 8 bits, and the sky is two thirds of every frame here.
        float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
        gl_FragColor = vec4(col + (n - 0.5) / 255.0, 1.0);
      }
    `,
  });
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  // Synced in `onBeforeRender`, not in `update`. Three calls this immediately
  // before the draw with the camera that is actually being used, which is the
  // only hook that is guaranteed to run *after* the camera rig has moved. Doing
  // it in `update` leaves the dome one frame behind — and one frame at 400
  // knots is six metres, which is enough to put the camera outside a
  // camera-locked sphere and turn the sky black.
  dome.onBeforeRender = (_r, _s, camera) => {
    dome.position.copy(camera.position);
    dome.updateMatrixWorld();
  };
  ctx.scene.add(dome);

  // ---- clouds -------------------------------------------------------------
  // Two sheets at 1,400 m and 3,200 m: a scattered cumulus layer you fly
  // through and a thin cirrus layer you never reach. Both are camera-locked
  // planes with the world position derived in the shader, so they extend for
  // ever and still parallax correctly.
  const cloudUniforms = {
    ...(env as unknown as Record<string, THREE.IUniform>),
    uLayerY: { value: 1400 },
    uCloudScale: { value: 0.00042 },
    uCoverage: { value: 0.44 },
    uWind: { value: new THREE.Vector2(11, 4) },
    uCamPos: { value: new THREE.Vector3() },
    uOpacity: { value: 0.92 },
  };

  const cloudMat = new THREE.ShaderMaterial({
    uniforms: cloudUniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform float uLayerY;
      uniform float uCloudScale;
      uniform float uCoverage;
      uniform vec2  uWind;
      uniform vec3  uCamPos;
      uniform float uOpacity;
      uniform vec3  uSunDir;
      uniform vec3  uSunColor;
      uniform vec3  uHazeColor;
      uniform float uTime;
      uniform float uNight;
      ${OUTPUT_GLSL}

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1,0)), u.x),
                   mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
      }
      float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
        return v;
      }

      void main() {
        vec3 dir = normalize(vDir);
        // Where this view ray crosses the layer's altitude plane.
        float dy = uLayerY - uCamPos.y;
        // Looking the wrong way, or too near the horizon to resolve: nothing.
        if (dir.y * dy <= 0.0001) discard;
        float t = dy / dir.y;
        if (t > 260000.0 || t < 0.0) discard;

        vec2 world = uCamPos.xz + dir.xz * t;
        vec2 uv = world * uCloudScale + uWind * uTime * uCloudScale * 6.0;

        float d = fbm(uv) * 0.62 + fbm(uv * 2.7 + 31.0) * 0.28 + fbm(uv * 7.1) * 0.10;
        float cover = smoothstep(uCoverage, uCoverage + 0.24, d);
        if (cover <= 0.002) discard;

        // Fade out at grazing angles: the sheet is a plane, and a plane seen
        // edge-on is an infinitely long smear if you let it be.
        float grazing = smoothstep(0.02, 0.16, abs(dir.y));
        // ...and fade with distance, into the same haze as everything else.
        float far = 1.0 - smoothstep(30000.0, 150000.0, t);

        // Shade from the density gradient: the side of a cloud facing the sun
        // is bright, the underside is not. One extra fbm tap, and it is the
        // difference between clouds and grey stains.
        float dSun = fbm(uv + uSunDir.xz * 0.055) * 0.62 + fbm((uv + uSunDir.xz * 0.055) * 2.7 + 31.0) * 0.28;
        float lit = clamp((d - dSun) * 5.0 + 0.55, 0.0, 1.0);

        vec3 lo = mix(vec3(0.30, 0.34, 0.42), uHazeColor * 1.5, 0.45);
        vec3 hi = uSunColor * 1.02;
        vec3 col = mix(lo, hi, lit) * (1.0 - uNight * 0.82);

        gl_FragColor = vec4(outputColor(col), cover * grazing * far * uOpacity);
      }
    `,
  });

  const cloudGeo = new THREE.SphereGeometry(10, 32, 20);
  const cumulus = new THREE.Mesh(cloudGeo, cloudMat);
  cumulus.frustumCulled = false;
  cumulus.renderOrder = -900;
  cumulus.onBeforeRender = (_r, _s, camera) => {
    cumulus.position.copy(camera.position);
    cumulus.updateMatrixWorld();
    cloudUniforms.uCamPos.value.copy(camera.position);
  };
  ctx.scene.add(cumulus);

  let cirrus: THREE.Mesh | null = null;
  let cirrusMat: THREE.ShaderMaterial | null = null;
  if (ctx.quality !== "low") {
    cirrusMat = cloudMat.clone();
    cirrusMat.uniforms = {
      ...(env as unknown as Record<string, THREE.IUniform>),
      uLayerY: { value: 5200 },
      uCloudScale: { value: 0.000105 },
      uCoverage: { value: 0.56 },
      uWind: { value: new THREE.Vector2(24, 9) },
      uCamPos: cloudUniforms.uCamPos,
      uOpacity: { value: 0.4 },
    };
    cirrus = new THREE.Mesh(cloudGeo, cirrusMat);
    cirrus.frustumCulled = false;
    cirrus.renderOrder = -899;
    const cirrusMesh = cirrus;
    cirrusMesh.onBeforeRender = (_r, _s, camera) => {
      cirrusMesh.position.copy(camera.position);
      cirrusMesh.updateMatrixWorld();
    };
    ctx.scene.add(cirrus);
  }

  // ---- lights -------------------------------------------------------------
  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.castShadow = false;
  ctx.scene.add(key);
  ctx.scene.add(key.target);

  const fill = new THREE.HemisphereLight(0x9fc9f2, 0x4a5240, 0.85);
  ctx.scene.add(fill);

  function refresh(): void {
    applyTimeOfDay(env, timeOfDay);
    key.color.copy(env.uSunColor.value);
    key.intensity = 0.9 + Math.max(0, env.uSunDir.value.y) * 2.4;
    fill.color.copy(env.uSkyColor.value);
    fill.groundColor.copy(env.uGroundColor.value);
    fill.intensity = 0.42 + Math.max(0, env.uSunDir.value.y) * 0.6;
  }
  refresh();

  const service: EnvService = {
    uniforms: env,
    get timeOfDay() {
      return timeOfDay;
    },
    setTimeOfDay(t: number) {
      timeOfDay = ((t % 1) + 1) % 1;
      refresh();
      ctx.emit("angels:timeofday", timeOfDay);
    },
    sunDirection: env.uSunDir.value,
    key,
  };
  ctx.services.env = service;

  return {
    lateUpdate(dt, c) {
      env.uTime.value += dt;
      const cam = c.camera;
      env.uCameraHeight.value = cam.position.y;
      // Keep the key light near the camera so its (unused) shadow frustum and
      // its position never drift somewhere numerically silly.
      key.position.copy(cam.position).addScaledVector(env.uSunDir.value, 4000);
      key.target.position.copy(cam.position);
      key.target.updateMatrixWorld();
    },

    dispose() {
      ctx.scene.remove(dome, cumulus, key, key.target, fill);
      if (cirrus) ctx.scene.remove(cirrus);
      domeGeo.dispose();
      domeMat.dispose();
      cloudGeo.dispose();
      cloudMat.dispose();
      cirrusMat?.dispose();
      if (ctx.services.env === service) delete ctx.services.env;
    },
  };
}
