/**
 * Sky — the atmosphere of VIBE ISLAND II, and the light rig it implies.
 *
 * The whole world is staged at a held golden hour, so this is not a neutral
 * sky that happens to be warm: the gradient, the sun size, the haze colour and
 * the cloud lighting are all authored for a low sun. Getting a warm sky right
 * is mostly about what happens *away* from the sun — the anti-solar half has
 * to go cool violet-blue or the whole frame turns into orange soup.
 *
 * It also owns the cloud sea. The islands float over a raymarched deck of
 * cloud far below, which is the single strongest cue that there is nothing
 * underneath you. Without it the islands read as terrain with the ground
 * hidden by fog.
 */
import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { QUALITY } from "../config";
import { frame, useIslandStore } from "../state/store";
import { WORLD } from "../geo/islandGeo";
import { clamp01, smoothstep } from "@/shared/proc/rng";

/* ------------------------------------------------------------------ *
 * Sun
 * ------------------------------------------------------------------ */

/**
 * Sun direction for a given hour. The island sits at a low latitude and the
 * day is compressed toward the evening, because the golden hour is the point.
 */
export function sunDirection(hour: number, out = new THREE.Vector3()): THREE.Vector3 {
  // Tuned so the world's default hour lands the sun at ~10 degrees, which is
  // where the light goes long and warm. A sun at 15 degrees reads as a bright
  // afternoon no matter how orange you make it.
  const t = clamp01((hour - 5) / 14.5);
  const elev = Math.sin(t * Math.PI) * 1.02 - 0.08;
  const az = Math.PI * (0.12 + t * 0.78);
  const ce = Math.cos(elev);
  return out.set(-Math.sin(az) * ce, Math.sin(elev), Math.cos(az) * ce).normalize();
}

export function sunColor(hour: number, out = new THREE.Color()): THREE.Color {
  const e = sunDirection(hour).y;
  if (e <= 0.02) {
    const t = clamp01((e + 0.16) / 0.18);
    return out.setRGB(0.20, 0.24, 0.42).lerp(new THREE.Color(1.0, 0.44, 0.20), t);
  }
  return out
    .setRGB(1.0, 0.52, 0.24)
    .lerp(new THREE.Color(1.0, 0.96, 0.90), smoothstep(0.02, 0.55, e));
}

export function sunIntensity(hour: number): number {
  const e = sunDirection(hour).y;
  if (e <= 0) return 0.06 + clamp01((e + 0.2) / 0.2) * 0.14;
  return 0.55 + smoothstep(0, 0.6, e) * 3.1;
}

/** Sky fill — cool, so it opposes the warm key instead of doubling it. */
export function skyFill(hour: number, out = new THREE.Color()): THREE.Color {
  const e = sunDirection(hour).y;
  const night = new THREE.Color(0.05, 0.07, 0.14);
  const dusk = new THREE.Color(0.26, 0.27, 0.44);
  const day = new THREE.Color(0.44, 0.55, 0.74);
  if (e < 0) return out.copy(night).lerp(dusk, clamp01((e + 0.16) / 0.16));
  return out.copy(dusk).lerp(day, smoothstep(0, 0.4, e));
}

/** Haze colour — what distance fades toward. */
export function hazeColor(hour: number, out = new THREE.Color()): THREE.Color {
  const e = sunDirection(hour).y;
  const night = new THREE.Color(0.07, 0.08, 0.13);
  const gold = new THREE.Color(0.94, 0.71, 0.47);
  const day = new THREE.Color(0.72, 0.80, 0.88);
  if (e < 0) return out.copy(night).lerp(gold, clamp01((e + 0.14) / 0.14));
  return out.copy(gold).lerp(day, smoothstep(0.06, 0.5, e));
}

/* ------------------------------------------------------------------ *
 * Sky dome
 * ------------------------------------------------------------------ */

const vert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w;
}
`;

const frag = /* glsl */ `
precision highp float;
uniform vec3  uSunDir;
uniform vec3  uSunCol;
uniform vec3  uZenith;
uniform vec3  uHorizon;
uniform vec3  uAntiSolar;
uniform float uTime;
uniform float uNight;
uniform float uHaze;
varying vec3 vDir;

float hash(vec3 p){ return fract(sin(dot(p, vec3(127.1,311.7,74.7)))*43758.5453); }

void main() {
  vec3 d = normalize(vDir);
  float up = clamp(d.y, -1.0, 1.0);
  float mu = dot(d, uSunDir);

  // Vertical gradient: warm at the horizon, deep at the zenith.
  float h = pow(clamp(1.0 - abs(up), 0.0, 1.0), 2.2);
  vec3 col = mix(uZenith, uHorizon, h);

  // The anti-solar half goes cool. Without this a golden-hour sky turns into
  // a uniform orange wash and loses all of its depth.
  float away = clamp(-mu, 0.0, 1.0);
  col = mix(col, uAntiSolar, away * 0.42 * (1.0 - uNight));

  // Warm bloom around the sun, widening as it approaches the horizon.
  float glow = pow(max(mu, 0.0), 9.0) * 0.20 + pow(max(mu, 0.0), 90.0) * 0.42;
  col += uSunCol * glow * (1.0 - uNight * 0.85);

  // The disc.
  float disc = smoothstep(0.9993, 0.99975, mu);
  col += uSunCol * disc * 9.0 * (1.0 - uNight * 0.92);

  // Haze thickens toward the horizon and washes the far archipelago out.
  float horizonBand = 1.0 - smoothstep(0.0, 0.42, abs(up));
  col = mix(col, uHorizon, horizonBand * uHaze * 0.42);

  // Stars, once it is actually dark.
  if (uNight > 0.01) {
    vec3 sp = floor(d * 320.0);
    float s = hash(sp);
    float star = s > 0.9972 ? (s - 0.9972) / 0.0028 : 0.0;
    col += vec3(0.85, 0.9, 1.0) * star * uNight * 0.9;
  }

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------ *
 * Cloud sea
 * ------------------------------------------------------------------ */

const cloudVert = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const cloudFrag = /* glsl */ `
precision highp float;
uniform float uTime;
uniform vec3  uSunDir;
uniform vec3  uSunCol;
uniform vec3  uShadow;
uniform vec3  uHaze;
uniform vec2  uWind;
varying vec3 vWorld;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), u.x),
             mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}

void main() {
  vec2 p = vWorld.xz * 0.00085 + uWind * uTime * 0.004;

  // Two layers drifting at different rates gives parallax within the deck, so
  // it reads as volume rather than as a painted plane.
  float lo = fbm(p);
  float hi = fbm(p * 2.7 + vec2(4.2, 1.7) + uWind * uTime * 0.010);
  float d = lo * 0.68 + hi * 0.32;

  // Billowy tops: push the density through a curve so we get defined cauliflower
  // edges instead of a smooth haze.
  float dens = smoothstep(0.38, 0.72, d);

  // Fake lighting: the gradient of the density field stands in for a normal,
  // so tops facing the sun catch warm light and the troughs go cool.
  float e = 0.010;
  float gx = fbm(p + vec2(e, 0.0)) - fbm(p - vec2(e, 0.0));
  float gy = fbm(p + vec2(0.0, e)) - fbm(p - vec2(0.0, e));
  vec3 n = normalize(vec3(-gx, 0.42, -gy));
  float lit = clamp(dot(n, uSunDir) * 0.5 + 0.5, 0.0, 1.0);

  vec3 col = mix(uShadow, vec3(1.0, 0.95, 0.90), pow(lit, 1.35));
  col = mix(col, uSunCol, pow(lit, 5.0) * 0.55);

  // Distance: the deck melts into the haze so it never shows an edge.
  float dist = length(vWorld.xz - cameraPosition.xz);
  float fade = 1.0 - smoothstep(6000.0, 20000.0, dist);
  col = mix(uHaze, col, fade);

  float alpha = mix(0.55, 0.97, dens) * fade + (1.0 - fade) * 0.85;
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export default function Sky() {
  const { scene } = useThree();
  const tier = useIslandStore((s) => s.quality);
  const q = QUALITY[tier];

  const domeRef = useRef<THREE.Mesh>(null);
  const cloudRef = useRef<THREE.Mesh>(null);
  const skyMat = useRef<THREE.ShaderMaterial>(null);
  const cloudMat = useRef<THREE.ShaderMaterial>(null);
  const sunRef = useRef<THREE.DirectionalLight>(null);
  const fillRef = useRef<THREE.HemisphereLight>(null);

  const skyUniforms = useMemo(
    () => ({
      uSunDir: { value: new THREE.Vector3(0, 0.3, 1) },
      uSunCol: { value: new THREE.Color(1, 0.7, 0.4) },
      uZenith: { value: new THREE.Color(0.055, 0.135, 0.36) },
      uHorizon: { value: new THREE.Color(0.98, 0.72, 0.45) },
      uAntiSolar: { value: new THREE.Color(0.26, 0.26, 0.54) },
      uTime: { value: 0 },
      uNight: { value: 0 },
      uHaze: { value: 0.42 },
    }),
    [],
  );

  const cloudUniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 0.3, 1) },
      uSunCol: { value: new THREE.Color(1, 0.72, 0.42) },
      uShadow: { value: new THREE.Color(0.42, 0.44, 0.62) },
      uHaze: { value: new THREE.Color(0.94, 0.74, 0.52) },
      uWind: { value: new THREE.Vector2(0.78, 0.63) },
    }),
    [],
  );

  const scratch = useMemo(
    () => ({ dir: new THREE.Vector3(), sun: new THREE.Color(), fill: new THREE.Color(), haze: new THREE.Color() }),
    [],
  );

  const cloudGeo = useMemo(() => {
    const g = new THREE.PlaneGeometry(26000, 26000, 1, 1);
    g.rotateX(-Math.PI / 2);
    return g;
  }, []);

  useFrame(({ camera }) => {
    const hour = frame.timeOfDay;
    const dir = sunDirection(hour, scratch.dir);
    const night = 1 - clamp01((dir.y + 0.12) / 0.2);

    if (domeRef.current) domeRef.current.position.copy(camera.position);
    if (cloudRef.current) {
      cloudRef.current.position.x = camera.position.x;
      cloudRef.current.position.z = camera.position.z;
    }

    if (skyMat.current) {
      const u = skyMat.current.uniforms;
      u.uSunDir.value.copy(dir);
      u.uTime.value = frame.time;
      u.uNight.value = night;
      u.uHaze.value = frame.haze;
      (u.uSunCol.value as THREE.Color).copy(sunColor(hour, scratch.sun));
      (u.uHorizon.value as THREE.Color).copy(hazeColor(hour, scratch.haze));
    }

    if (cloudMat.current) {
      const u = cloudMat.current.uniforms;
      u.uTime.value = frame.time;
      u.uSunDir.value.copy(dir);
      u.uWind.value.copy(frame.windDirection);
      (u.uSunCol.value as THREE.Color).copy(sunColor(hour, scratch.sun));
      (u.uHaze.value as THREE.Color).copy(hazeColor(hour, scratch.haze));
      (u.uShadow.value as THREE.Color).copy(skyFill(hour, scratch.fill)).multiplyScalar(1.35);
    }

    if (sunRef.current) {
      const l = sunRef.current;
      l.position.copy(camera.position).addScaledVector(dir, 600);
      l.target.position.copy(camera.position);
      l.target.updateMatrixWorld();
      l.color.copy(sunColor(hour, scratch.sun));
      l.intensity = sunIntensity(hour);
      const cam = l.shadow.camera as THREE.OrthographicCamera;
      const d = q.shadowDistance * 0.5;
      if (cam.right !== d) {
        cam.left = -d; cam.right = d; cam.top = d; cam.bottom = -d;
        cam.near = 1; cam.far = 2200;
        cam.updateProjectionMatrix();
      }
      l.shadow.bias = -0.0005;
      l.shadow.normalBias = 0.42;
    }

    if (fillRef.current) {
      const f = skyFill(hour, scratch.fill);
      fillRef.current.color.copy(f);
      // Ground bounce is warm here — light comes up off the cloud deck, which
      // is a real and very flattering feature of a floating world.
      fillRef.current.groundColor.copy(hazeColor(hour, scratch.haze)).multiplyScalar(0.7);
      fillRef.current.intensity = 0.75 + (1 - night) * 0.5;
    }

    const hz = hazeColor(hour, scratch.haze);
    if (scene.fog instanceof THREE.Fog) {
      scene.fog.color.copy(hz);
      // Aerial perspective should tint the far islands, not dissolve them.
      // The archipelago spans ~1.5 km, so fog that starts biting at 2 km and
      // saturates around 14 km reads as distance rather than as milk.
      scene.fog.near = 1200 - frame.haze * 500;
      scene.fog.far = 15000 - frame.haze * 6000;
    }
    scene.background = null;
  });

  return (
    <>
      <mesh ref={domeRef} frustumCulled={false} renderOrder={-1000} name="sky">
        <sphereGeometry args={[1, 40, 28]} />
        <shaderMaterial
          ref={skyMat}
          vertexShader={vert}
          fragmentShader={frag}
          uniforms={skyUniforms}
          side={THREE.BackSide}
          depthWrite={false}
          depthTest={false}
          toneMapped={false}
        />
      </mesh>

      <mesh
        ref={cloudRef}
        geometry={cloudGeo}
        position={[0, WORLD.cloudDeck, 0]}
        frustumCulled={false}
        renderOrder={-900}
        name="cloud-sea"
      >
        <shaderMaterial
          ref={cloudMat}
          vertexShader={cloudVert}
          fragmentShader={cloudFrag}
          uniforms={cloudUniforms}
          transparent
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      <directionalLight
        ref={sunRef}
        castShadow
        shadow-mapSize-width={q.shadowMapSize}
        shadow-mapSize-height={q.shadowMapSize}
      />
      <hemisphereLight ref={fillRef} intensity={0.9} />
    </>
  );
}
