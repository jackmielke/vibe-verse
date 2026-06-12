import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useGame } from "./store";

/**
 * Animated ocean surrounding the island.
 * Custom shader: gentle vertex swell, animated micro-normals, fresnel sky
 * reflection, sun glints, depth-tinted shallows and a foam ring that hugs
 * the irregular shoreline (same islandRadius() as terrain/gameplay).
 */
export function Ocean() {
  const matRef = useRef<THREE.ShaderMaterial>(null!);
  const tod = useGame((s) => s.timeOfDay);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uDay: { value: 1 },
      uFogColor: { value: new THREE.Color("#bcdff5") },
    }),
    [],
  );

  useFrame((_, dt) => {
    const m = matRef.current;
    if (!m) return;
    m.uniforms.uTime.value += dt;
    const angle = tod * Math.PI * 2 - Math.PI / 2;
    m.uniforms.uSunDir.value.set(Math.cos(angle), Math.max(Math.sin(angle), 0.02), 0.35).normalize();
    m.uniforms.uDay.value = Math.max(0, Math.sin(tod * Math.PI));
    (m.uniforms.uFogColor.value as THREE.Color).set(tod > 0.5 ? "#bcdff5" : "#0e1830");
  });

  return (
    <mesh position={[0, -0.5, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
      <planeGeometry args={[420, 420, 64, 64]} />
      <shaderMaterial
        ref={matRef}
        transparent
        depthWrite={false}
        uniforms={uniforms}
        vertexShader={/* glsl */ `
          uniform float uTime;
          varying vec3 vWorld;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            float t = uTime;
            wp.y += sin(wp.x * 0.18 + t * 1.1) * 0.10
                  + sin(wp.z * 0.22 - t * 0.9) * 0.09
                  + sin((wp.x + wp.z) * 0.11 + t * 0.6) * 0.07;
            vWorld = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }
        `}
        fragmentShader={/* glsl */ `
          uniform float uTime;
          uniform vec3 uSunDir;
          uniform float uDay;
          uniform vec3 uFogColor;
          varying vec3 vWorld;

          float islandRadius(float a) {
            return 44.0 + 6.0 * sin(a * 3.0 + 1.7) + 3.5 * sin(a * 7.0 + 0.4) + 2.0 * sin(a * 11.0 + 2.9);
          }

          void main() {
            float t = uTime;
            // Animated micro-normals (two octaves of moving ripples)
            vec3 n = normalize(vec3(
              sin(vWorld.x * 0.6 + t * 1.4) * 0.12 + sin(vWorld.x * 1.9 - t * 2.1) * 0.05 + sin(vWorld.z * 1.1 + t) * 0.04,
              1.0,
              sin(vWorld.z * 0.7 + t * 1.2) * 0.12 + sin(vWorld.z * 2.2 - t * 1.7) * 0.05 + sin(vWorld.x * 0.9 - t) * 0.04
            ));

            vec3 viewDir = normalize(cameraPosition - vWorld);
            float fresnel = pow(1.0 - max(dot(viewDir, n), 0.0), 3.0);

            // Depth tint: shallow turquoise near shore, deep blue out at sea
            float r = length(vWorld.xz);
            float a = atan(vWorld.z, vWorld.x);
            float sd = islandRadius(a) - r; // >0 toward island
            float shallowF = smoothstep(-12.0, 2.0, sd);

            vec3 deep = mix(vec3(0.008, 0.025, 0.05), vec3(0.012, 0.10, 0.17), uDay);
            vec3 shallow = mix(vec3(0.02, 0.07, 0.09), vec3(0.10, 0.43, 0.46), uDay);
            vec3 col = mix(deep, shallow, shallowF);

            // Sky reflection via fresnel
            vec3 sky = mix(vec3(0.05, 0.07, 0.13), vec3(0.60, 0.77, 0.92), uDay);
            col = mix(col, sky, fresnel * 0.75);

            // Sun specular + glitter
            vec3 h = normalize(viewDir + normalize(uSunDir));
            float ndh = max(dot(n, h), 0.0);
            col += vec3(1.0, 0.95, 0.8) * pow(ndh, 240.0) * 1.6 * uDay;
            col += pow(ndh, 50.0) * 0.18 * uDay;

            // Breaking foam ring along the shoreline, gently lapping
            float lap = sin(a * 24.0 + t * 1.6) * 0.6 + sin(a * 9.0 - t * 0.8) * 0.4;
            float foamBand = smoothstep(2.6, 0.3, abs(sd - 0.8 + lap * 0.7));
            float foamTex = 0.55 + 0.45 * sin(r * 5.0 - t * 2.4 + sin(a * 33.0) * 2.0);
            float foam = clamp(foamBand * foamTex, 0.0, 1.0);
            col = mix(col, vec3(0.93, 0.96, 0.97) * (0.35 + 0.65 * uDay), foam * 0.85);

            // Match scene fog so the horizon blends away
            float dist = length(cameraPosition - vWorld);
            float fogF = smoothstep(30.0, 80.0, dist);
            col = mix(col, uFogColor, fogF);

            float alpha = mix(mix(0.94, 0.78, shallowF * 0.6), 1.0, fogF);
            gl_FragColor = vec4(col, alpha);
          }
        `}
      />
    </mesh>
  );
}
