/**
 * Lagoon — the shallow pool on the heart island, and the water that spills off
 * its rim into nothing.
 *
 * A small body of water, but it does a lot of work: it gives the cove a focal
 * point, it catches the low sun as a specular streak, and its overflow is the
 * only thing in the world that visibly *falls*, which is what sells the fact
 * that there is no ground down there.
 */
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { frame } from "../state/store";
import { LAGOON, LAGOON_Y } from "../geo/islandGeo";

const vert = /* glsl */ `
uniform float uTime;
uniform vec2  uWind;
varying vec3 vWorld;
varying float vWave;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  // Gentle interference of two directions — a lagoon is sheltered, so this is
  // ripple rather than swell.
  float a = sin(w.x * 0.35 + uTime * 1.4) * 0.055;
  float b = sin(w.z * 0.29 - uTime * 1.1 + 1.7) * 0.045;
  float c = sin((w.x + w.z) * 0.62 + uTime * 2.1) * 0.022;
  w.y += a + b + c;
  vWave = a + b + c;
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const frag = /* glsl */ `
precision highp float;
uniform float uTime;
uniform vec3  uSunDir;
uniform vec3  uSunCol;
uniform vec3  uSky;
uniform vec3  uShallow;
uniform vec3  uDeep;
varying vec3 vWorld;
varying float vWave;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), u.x),
             mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
}

void main() {
  vec3 view = normalize(cameraPosition - vWorld);

  // Micro-normal from scrolling noise — this is what makes the sun streak
  // shimmer instead of sitting there as a static blob.
  vec2 p = vWorld.xz * 0.7;
  float e = 0.12;
  float h  = noise(p + uTime * 0.25);
  float hx = noise(p + vec2(e, 0.0) + uTime * 0.25);
  float hz = noise(p + vec2(0.0, e) + uTime * 0.25);
  vec3 n = normalize(vec3(h - hx, 0.30, h - hz));

  float fres = pow(clamp(1.0 - dot(n, view), 0.0, 1.0), 4.0);
  fres = mix(0.03, 1.0, fres);

  vec3 hv = normalize(uSunDir + view);
  float spec = pow(max(dot(n, hv), 0.0), 260.0) * 3.2;
  float sheen = pow(max(dot(n, hv), 0.0), 20.0) * 0.22;

  // Depth from how far below the surface the bed is — approximated by the
  // wave envelope, which is enough for a lagoon this shallow.
  vec3 body = mix(uShallow, uDeep, clamp(0.45 + vWave * 2.0, 0.0, 1.0));
  vec3 col = mix(body, uSky, fres * 0.75);
  col += uSunCol * (spec + sheen);

  gl_FragColor = vec4(col, 0.86);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export default function Lagoon() {
  const matRef = useRef<THREE.ShaderMaterial>(null);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector2(0.78, 0.63) },
      uSunDir: { value: new THREE.Vector3(0.2, 0.35, 0.9).normalize() },
      uSunCol: { value: new THREE.Color(1.0, 0.72, 0.44) },
      uSky: { value: new THREE.Color(0.62, 0.70, 0.86) },
      uShallow: { value: new THREE.Color(0.30, 0.62, 0.58) },
      uDeep: { value: new THREE.Color(0.06, 0.24, 0.30) },
    }),
    [],
  );

  const geo = useMemo(() => {
    // Sized to the carved basin, tessellated enough for the ripple to read.
    const g = new THREE.CircleGeometry(LAGOON.radius * 1.02, 128, 1);
    g.rotateX(-Math.PI / 2);
    return g;
  }, []);

  useFrame(() => {
    const m = matRef.current;
    if (!m) return;
    m.uniforms.uTime.value = frame.time;
    m.uniforms.uWind.value.copy(frame.windDirection);
  });

  return (
    <mesh
      geometry={geo}
      position={[LAGOON.x, LAGOON_Y, LAGOON.z]}
      name="lagoon"
      renderOrder={2}
    >
      <shaderMaterial
        ref={matRef}
        vertexShader={vert}
        fragmentShader={frag}
        uniforms={uniforms}
        transparent
        depthWrite={false}
      />
    </mesh>
  );
}
