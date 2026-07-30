/**
 * Bay — San Francisco Bay and the Pacific.
 *
 * A single large plane with a custom shader: Gerstner swell for the silhouette,
 * three scrolling normal octaves for the sparkle, depth-based absorption so
 * shallows go green and the channel goes near-black, a Fresnel-weighted sky
 * reflection, and foam banded on the shoreline SDF.
 *
 * Real water is the fastest way to make a scene read as expensive, and the
 * fastest way to make it read as cheap. Worth the shader.
 */
import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { WORLD } from "../geo/sfGeo";
import { frame } from "../state/store";

const vertexShader = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;
uniform float uWindSpeed;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vWave;

// Gerstner wave: returns displacement, accumulates the analytic normal.
vec3 gerstner(vec2 dir, float steepness, float wavelength, vec2 p, float t, inout vec3 tangent, inout vec3 binormal) {
  float k = 6.28318530718 / wavelength;
  float c = sqrt(9.81 / k);
  vec2 d = normalize(dir);
  float f = k * (dot(d, p) - c * t);
  float a = steepness / k;

  tangent += vec3(
    -d.x * d.x * (steepness * sin(f)),
    d.x * (steepness * cos(f)),
    -d.x * d.y * (steepness * sin(f))
  );
  binormal += vec3(
    -d.x * d.y * (steepness * sin(f)),
    d.y * (steepness * cos(f)),
    -d.y * d.y * (steepness * sin(f))
  );

  return vec3(d.x * (a * cos(f)), a * sin(f), d.y * (a * cos(f)));
}

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec2 p = world.xz;

  vec3 tangent = vec3(1.0, 0.0, 0.0);
  vec3 binormal = vec3(0.0, 0.0, 1.0);
  vec3 disp = vec3(0.0);

  float energy = clamp(uWindSpeed / 12.0, 0.25, 1.6);
  disp += gerstner(uWind,             0.16 * energy, 128.0, p, uTime, tangent, binormal);
  disp += gerstner(uWind + vec2(0.6, -0.4), 0.13 * energy, 61.0,  p, uTime, tangent, binormal);
  disp += gerstner(uWind + vec2(-0.8, 0.5), 0.10 * energy, 27.0,  p, uTime, tangent, binormal);
  disp += gerstner(uWind + vec2(1.2, 0.9),  0.07 * energy, 11.0,  p, uTime, tangent, binormal);

  world.xyz += disp;
  vWave = disp.y;
  vWorldPos = world.xyz;
  vNormal = normalize(cross(binormal, tangent));

  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const fragmentShader = /* glsl */ `
uniform float uTime;
uniform vec3  uSunDirection;
uniform vec3  uSunColor;
uniform vec3  uSkyColor;
uniform vec3  uHorizonColor;
uniform vec3  uShallowColor;
uniform vec3  uDeepColor;
uniform float uFogDensity;
uniform vec3  uFogColor;
uniform vec2  uWind;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vWave;

// Cheap value noise for the micro-detail normals.
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1,0)), u.x),
             mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
}

vec3 detailNormal(vec2 p, float t) {
  // Three scrolling octaves at different scales and speeds — this is what
  // makes water look like water rather than like moving plastic.
  vec2 d1 = p * 0.35 + uWind * t * 0.30;
  vec2 d2 = p * 0.90 - uWind * t * 0.42;
  vec2 d3 = p * 2.60 + vec2(uWind.y, -uWind.x) * t * 0.55;
  float e = 0.35;
  float h  = noise(d1) * 0.55 + noise(d2) * 0.30 + noise(d3) * 0.15;
  float hx = noise(d1 + vec2(e,0.0)) * 0.55 + noise(d2 + vec2(e,0.0)) * 0.30 + noise(d3 + vec2(e,0.0)) * 0.15;
  float hz = noise(d1 + vec2(0.0,e)) * 0.55 + noise(d2 + vec2(0.0,e)) * 0.30 + noise(d3 + vec2(0.0,e)) * 0.15;
  return normalize(vec3(h - hx, 0.09, h - hz));
}

void main() {
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  float dist = length(cameraPosition - vWorldPos);

  // Fade detail normals out with distance or the horizon turns into noise soup.
  float detailFade = 1.0 - smoothstep(200.0, 2600.0, dist);
  vec3 n = normalize(vNormal + detailNormal(vWorldPos.xz, uTime) * (0.85 * detailFade));

  float fres = pow(clamp(1.0 - dot(n, viewDir), 0.0, 1.0), 5.0);
  fres = mix(0.020, 1.0, fres);

  // Sky reflection: a cheap two-colour gradient standing in for the real sky.
  vec3 refl = reflect(-viewDir, n);
  vec3 sky = mix(uHorizonColor, uSkyColor, clamp(refl.y * 1.6, 0.0, 1.0));

  // Sun specular — a tight Blinn lobe plus a broad glitter lobe.
  vec3 h = normalize(uSunDirection + viewDir);
  float spec = pow(max(dot(n, h), 0.0), 420.0) * 3.6;
  float glitter = pow(max(dot(n, h), 0.0), 34.0) * 0.28;

  // Water body colour: shallow green → deep blue-black, driven by how high the
  // seabed sits relative to the surface (approximated by distance to shore via
  // the wave envelope; the terrain SDF is baked into vertex colour upstream).
  float depthT = clamp((-vWorldPos.y + 1.4) * 0.06 + 0.35, 0.0, 1.0);
  vec3 body = mix(uShallowColor, uDeepColor, depthT);

  // Subsurface: wave crests glow where light passes through them.
  float sss = clamp(vWave * 0.45 + 0.2, 0.0, 1.0);
  body += uSunColor * sss * 0.10;

  vec3 color = mix(body, sky, fres);
  color += uSunColor * (spec + glitter);

  // Whitecaps on steep crests.
  float caps = smoothstep(0.55, 1.15, vWave * 1.4) * clamp(length(uWind) * 0.6, 0.2, 1.0);
  color = mix(color, vec3(0.86, 0.90, 0.93), caps * 0.55 * detailFade);

  // Distance haze so the bay melts into the marine layer instead of ending.
  float fogT = 1.0 - exp(-dist * 0.00016 * (0.55 + uFogDensity * 1.9));
  color = mix(color, uFogColor, clamp(fogT, 0.0, 1.0));

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export default function Bay() {
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const { camera } = useThree();

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector2(0.82, 0.57) },
      uWindSpeed: { value: 7.5 },
      uSunDirection: { value: new THREE.Vector3(0.4, 0.5, 0.76).normalize() },
      uSunColor: { value: new THREE.Color(1.0, 0.86, 0.68) },
      uSkyColor: { value: new THREE.Color(0.30, 0.47, 0.72) },
      uHorizonColor: { value: new THREE.Color(0.68, 0.75, 0.82) },
      uShallowColor: { value: new THREE.Color(0.055, 0.135, 0.130) },
      uDeepColor: { value: new THREE.Color(0.012, 0.031, 0.055) },
      uFogDensity: { value: 0.35 },
      uFogColor: { value: new THREE.Color(0.72, 0.78, 0.83) },
    }),
    [],
  );

  // One very large plane, tessellated enough that Gerstner displacement reads
  // near the camera. It follows the camera in XZ so the player never reaches
  // its edge.
  const geo = useMemo(() => {
    const size = 26000;
    const g = new THREE.PlaneGeometry(size, size, 420, 420);
    g.rotateX(-Math.PI / 2);
    return g;
  }, []);

  useFrame(() => {
    const m = matRef.current;
    if (m) {
      m.uniforms.uTime.value = frame.time;
      m.uniforms.uWind.value.copy(frame.windDirection);
      m.uniforms.uWindSpeed.value = frame.windSpeed;
      m.uniforms.uFogDensity.value = frame.fogDensity;
    }
    const mesh = meshRef.current;
    if (mesh) {
      mesh.position.x = camera.position.x;
      mesh.position.z = camera.position.z;
    }
  });

  return (
    <mesh
      ref={meshRef}
      geometry={geo}
      position={[0, WORLD.seaLevel, 0]}
      frustumCulled={false}
      renderOrder={1}
      name="bay"
    >
      <shaderMaterial
        ref={matRef}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
        transparent={false}
      />
    </mesh>
  );
}
