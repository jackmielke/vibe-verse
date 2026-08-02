/**
 * The Terminal's 3D scene — reference 3 in `references/VISION.md`.
 *
 * Everything here is built on one idea: **flat-shaded does not mean cheap.**
 * With no texture detail to hide behind, the whole look rests on silhouette,
 * a tight palette, and cel-banded light. So the geometry is low-poly on
 * purpose and lit through a 3-step toon ramp, and the effort goes into the
 * shapes reading cleanly against a saturated sky rather than into surface
 * detail nobody would see at this scale.
 */
import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import {
  DRIFT,
  GATES,
  HOME,
  gatePosition,
  homeHeight,
  homeKeel,
  type GateDef,
} from "../geo/terminalGeo";
import { valueNoise2 } from "@/shared/proc/rng";
import Character from "./Character";

/* ------------------------------------------------------------------ *
 * Toon ramp
 * ------------------------------------------------------------------ */

/**
 * A 3-band gradient map. Three bands is the sweet spot: two reads as a paper
 * cut-out, four starts pretending to be smooth shading and loses the graphic
 * quality entirely.
 */
function useToonRamp(): THREE.DataTexture {
  return useMemo(() => {
    const steps = new Uint8Array([90, 90, 90, 255, 178, 178, 178, 255, 255, 255, 255, 255]);
    const tex = new THREE.DataTexture(steps, 3, 1, THREE.RGBAFormat);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }, []);
}

/* ------------------------------------------------------------------ *
 * Island geometry
 * ------------------------------------------------------------------ */

/**
 * A low-poly island lens: flat grass top, faceted rock keel. Built polar for
 * the same reason as Island II's — the shape lives at the rim — but at a
 * deliberately coarse facet count so the facets themselves are the style.
 */
function buildLens(
  radius: number,
  keel: number,
  spokes: number,
  rings: number,
  seed: number,
  topFn?: (x: number, z: number) => number,
  keelFn?: (x: number, z: number) => number,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];

  // Irregular rim, quantised to the spoke count so every facet is a clean edge.
  const rim = new Float32Array(spokes);
  for (let s = 0; s < spokes; s++) {
    const a = (s / spokes) * Math.PI * 2;
    const w = valueNoise2(Math.cos(a) * 1.8 + seed, Math.sin(a) * 1.8, seed);
    rim[s] = radius * (0.80 + w * 0.34);
  }

  const vid = (ring: number, spoke: number, layer: number) =>
    layer * spokes * rings + ring * spokes + (spoke % spokes);

  for (let layer = 0; layer < 2; layer++) {
    for (let ring = 0; ring < rings; ring++) {
      const t = ring / (rings - 1);
      for (let s = 0; s < spokes; s++) {
        const a = (s / spokes) * Math.PI * 2;
        const r = rim[s] * t;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        let y: number;
        if (layer === 0) {
          y = topFn ? topFn(x, z) : (1 - t * t) * radius * 0.10;
        } else {
          y = keelFn
            ? keelFn(x, z)
            : -keel * Math.pow(1 - t, 0.6) - valueNoise2(x * 0.3, z * 0.3, seed) * keel * 0.12 * (1 - t);
        }
        pos.push(x, y, z);
      }
    }
  }

  for (let layer = 0; layer < 2; layer++) {
    for (let ring = 0; ring < rings - 1; ring++) {
      for (let s = 0; s < spokes; s++) {
        const a = vid(ring, s, layer);
        const b = vid(ring, s + 1, layer);
        const c = vid(ring + 1, s, layer);
        const d = vid(ring + 1, s + 1, layer);
        if (layer === 0) idx.push(a, c, b, b, c, d);
        else idx.push(a, b, c, b, d, c);
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/* ------------------------------------------------------------------ *
 * Motifs — the silhouette on top of each gate island
 * ------------------------------------------------------------------ */

/**
 * Each world's island carries a shape that says what it is from a distance.
 * At this scale silhouette is the *only* signal, so these are built as clean
 * primitive stacks rather than as detailed models.
 */
function buildMotif(motif: GateDef["motif"], scale: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const push = (g: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0) => {
    if (ry) g.rotateY(ry);
    g.translate(x, y, z);
    parts.push(g);
  };

  switch (motif) {
    case "city": {
      // A cluster of towers, tallest in the middle.
      const heights = [1.0, 1.7, 2.5, 1.9, 1.2, 0.8];
      heights.forEach((h, i) => {
        const a = (i / heights.length) * Math.PI * 2;
        const r = 1.5 + (i % 2) * 0.7;
        push(
          new THREE.BoxGeometry(0.85, h * 2.6, 0.85),
          Math.cos(a) * r, h * 1.3, Math.sin(a) * r,
          a * 0.4,
        );
      });
      break;
    }
    case "pagoda": {
      for (let i = 0; i < 3; i++) {
        const w = 3.2 - i * 0.75;
        push(new THREE.CylinderGeometry(w * 0.5, w * 0.62, 0.34, 4), 0, 1.1 + i * 1.35, 0, Math.PI / 4);
        push(new THREE.BoxGeometry(w * 0.5, 1.0, w * 0.5), 0, 1.6 + i * 1.35, 0);
      }
      push(new THREE.ConeGeometry(0.28, 1.1, 4), 0, 5.4, 0);
      break;
    }
    case "tree": {
      push(new THREE.CylinderGeometry(0.24, 0.36, 2.6, 6), 0, 1.3, 0);
      push(new THREE.IcosahedronGeometry(1.9, 0), 0, 3.6, 0);
      push(new THREE.IcosahedronGeometry(1.15, 0), 1.3, 2.9, 0.6);
      break;
    }
    case "peak": {
      push(new THREE.ConeGeometry(3.0, 5.2, 6), 0, 2.6, 0);
      push(new THREE.ConeGeometry(1.6, 2.4, 6), 2.2, 1.2, 1.4);
      break;
    }
    case "ruin": {
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        push(new THREE.CylinderGeometry(0.28, 0.32, 2.2 + (i % 2) * 0.9, 6),
             Math.cos(a) * 2.0, 1.2, Math.sin(a) * 2.0);
      }
      push(new THREE.BoxGeometry(5.0, 0.3, 5.0), 0, 0.15, 0);
      break;
    }
    case "dome": {
      push(new THREE.SphereGeometry(1.9, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0.6, 0);
      push(new THREE.CylinderGeometry(2.1, 2.1, 0.5, 10), 0, 0.3, 0);
      push(new THREE.ConeGeometry(0.3, 0.9, 6), 0, 2.7, 0);
      break;
    }
    case "arch": {
      push(new THREE.TorusGeometry(2.0, 0.32, 6, 12, Math.PI), 0, 0.4, 0);
      push(new THREE.BoxGeometry(0.5, 0.9, 0.5), -2.0, 0.45, 0);
      push(new THREE.BoxGeometry(0.5, 0.9, 0.5), 2.0, 0.45, 0);
      break;
    }
  }

  // Merge by hand — no BufferGeometryUtils import needed for position-only
  // geometry, and this keeps every motif to a single draw call.
  let total = 0;
  for (const p of parts) total += p.getAttribute("position").count;
  const pos = new Float32Array(total * 3);
  const idx: number[] = [];
  let vOff = 0;
  let pOff = 0;
  for (const p of parts) {
    const pa = p.getAttribute("position") as THREE.BufferAttribute;
    pos.set(pa.array as Float32Array, pOff);
    const index = p.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i++) idx.push(index.getX(i) + vOff);
    } else {
      for (let i = 0; i < pa.count; i++) idx.push(i + vOff);
    }
    vOff += pa.count;
    pOff += pa.array.length;
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.scale(scale, scale, scale);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/* ------------------------------------------------------------------ *
 * Sky
 * ------------------------------------------------------------------ */

const skyVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w;
}
`;

const skyFrag = /* glsl */ `
precision highp float;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uCloud;
uniform float uTime;
varying vec3 vDir;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), u.x),
             mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.1; a *= 0.5; }
  return v;
}

void main() {
  vec3 d = normalize(vDir);
  float up = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(uBottom, uTop, pow(up, 0.85));

  // Big soft cumulus, banded hard so they stay graphic rather than turning
  // into the soft photographic haze this style is specifically not.
  if (d.y > -0.05) {
    vec2 p = d.xz / max(d.y + 0.30, 0.10) * 0.62 + vec2(uTime * 0.006, 0.0);
    float c = fbm(p * 1.15);
    // Harder bands and a lower threshold: reference 3's sky is most of the
    // frame and its clouds are big, bright and confident, not a faint texture.
    // Wide, bright, hard-edged. These are the big fluffy cumulus of a
    // children's-book sky, not atmospheric haze.
    float band = smoothstep(0.40, 0.455, c) * 0.70 + smoothstep(0.455, 0.58, c) * 0.30;
    float horizonFade = smoothstep(-0.04, 0.13, d.y);
    // Fade the deck out toward the zenith. The projection d.xz/d.y collapses
    // to a point directly overhead, so the noise there is a single constant
    // value — which painted the entire top of the sky as one solid cloud.
    // Clouds belong in the lower and middle sky anyway; straight up is blue.
    float zenithFade = 1.0 - smoothstep(0.42, 0.92, d.y);
    col = mix(col, uCloud, band * horizonFade * zenithFade);
  }

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------ *
 * Scene
 * ------------------------------------------------------------------ */

export interface SceneProps {
  /** Which gate is focused, so its island can lift and glow. */
  focusedKey: string | null;
}

export default function Scene({ focusedKey }: SceneProps) {
  const ramp = useToonRamp();
  const skyRef = useRef<THREE.Mesh>(null);
  const skyMat = useRef<THREE.ShaderMaterial>(null);
  const gateRefs = useRef(new Map<string, THREE.Group>()).current;

  const homeGeo = useMemo(
    () => buildLens(HOME.radius, HOME.keel, 26, 9, 3, homeHeight, homeKeel),
    [],
  );
  const platformGeo = useMemo(
    () => new THREE.CylinderGeometry(HOME.platformRadius, HOME.platformRadius + 0.5, HOME.platformHeight, 32),
    [],
  );
  const gateGeos = useMemo(
    () =>
      GATES.map((g) => ({
        gate: g,
        lens: buildLens(g.radius, g.radius * 1.5, 18, 7, g.key.length * 7 + 3),
        motif: buildMotif(g.motif, g.radius * 0.30),
      })),
    [],
  );
  const driftGeos = useMemo(
    () => DRIFT.map((d) => ({ d, lens: buildLens(d.radius, d.radius * 1.6, 12, 5, d.seed) })),
    [],
  );

  useLayoutEffect(() => {
    return () => {
      homeGeo.dispose();
      platformGeo.dispose();
      for (const g of gateGeos) {
        g.lens.dispose();
        g.motif.dispose();
      }
      for (const g of driftGeos) g.lens.dispose();
      ramp.dispose();
    };
  }, [homeGeo, platformGeo, gateGeos, driftGeos, ramp]);

  const skyUniforms = useMemo(
    () => ({
      // Reference 3's sky is a deep, confident blue that carries most of the
      // frame. A pale gradient reads as washed-out rather than as sunny.
      uTop: { value: new THREE.Color(0.055, 0.36, 0.90) },
      uBottom: { value: new THREE.Color(0.52, 0.79, 0.99) },
      uCloud: { value: new THREE.Color(1.0, 1.0, 1.0) },
      uTime: { value: 0 },
    }),
    [],
  );

  useFrame(({ camera, clock }) => {
    if (skyRef.current) skyRef.current.position.copy(camera.position);
    if (skyMat.current) skyMat.current.uniforms.uTime.value = clock.elapsedTime;

    // Gate islands bob gently, and the focused one rises and steadies — motion
    // is how the lobby tells you which world you are pointed at.
    const t = clock.elapsedTime;
    for (const { gate } of gateGeos) {
      const grp = gateRefs.get(gate.key);
      if (!grp) continue;
      const base = gatePosition(gate);
      const focused = gate.key === focusedKey;
      const bob = Math.sin(t * 0.6 + gate.bearing * 3.1) * (focused ? 0.5 : 1.5);
      const lift = focused ? 5.5 : 0;
      grp.position.set(base.x, base.y + bob + lift, base.z);
      grp.rotation.y = gate.bearing * 0.5 + Math.sin(t * 0.12 + gate.distance) * 0.05;
      const s = focused ? 1.14 : 1;
      grp.scale.lerp(new THREE.Vector3(s, s, s), 0.08);
    }
  });

  return (
    <>
      <mesh ref={skyRef} frustumCulled={false} renderOrder={-1000}>
        <sphereGeometry args={[1, 24, 16]} />
        <shaderMaterial
          ref={skyMat}
          vertexShader={skyVert}
          fragmentShader={skyFrag}
          uniforms={skyUniforms}
          side={THREE.BackSide}
          depthWrite={false}
          depthTest={false}
          toneMapped={false}
        />
      </mesh>

      {/* Key light high and warm; the fill is a strong sky blue so shadowed
          faces go blue rather than grey. That colour contrast is what makes a
          flat-shaded scene look painted rather than unlit. */}
      <directionalLight
        position={[42, 60, 26]}
        intensity={2.5}
        color="#fff4dc"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-60}
        shadow-camera-right={60}
        shadow-camera-top={60}
        shadow-camera-bottom={-60}
        shadow-camera-near={1}
        shadow-camera-far={220}
      />
      <hemisphereLight args={["#bfe3ff", "#5d8f4a", 1.15]} />

      {/* Home island */}
      <group name="home">
        <mesh geometry={homeGeo} castShadow receiveShadow>
          <meshToonMaterial color="#7ec850" gradientMap={ramp} />
        </mesh>
        <mesh geometry={platformGeo} position={[0, HOME.platformHeight / 2, 0]} receiveShadow castShadow>
          <meshToonMaterial color="#d9cfc0" gradientMap={ramp} />
        </mesh>
        <mesh
          geometry={platformGeo}
          position={[0, HOME.platformHeight / 2 + 0.03, 0]}
          scale={[0.62, 1.05, 0.62]}
          receiveShadow
        >
          <meshToonMaterial color="#c2b6a4" gradientMap={ramp} />
        </mesh>
      </group>

      {/* The traveller, on the platform. */}
      <group position={[0, HOME.platformHeight, 0]}>
        <Character gradientMap={ramp} />
      </group>

      {/* Gate islands */}
      {gateGeos.map(({ gate, lens, motif }) => (
        <group
          key={gate.key}
          ref={(r) => {
            if (r) gateRefs.set(gate.key, r);
            else gateRefs.delete(gate.key);
          }}
        >
          <mesh geometry={lens} castShadow receiveShadow>
            <meshToonMaterial color="#7ec850" gradientMap={ramp} />
          </mesh>
          <mesh geometry={motif} position={[0, gate.radius * 0.10, 0]} castShadow>
            <meshToonMaterial color={new THREE.Color(gate.accent)} gradientMap={ramp} />
          </mesh>
        </group>
      ))}

      {/* Distant drift — silhouette only. */}
      {driftGeos.map(({ d, lens }, i) => (
        <mesh key={i} geometry={lens} position={[d.x, d.y, d.z]}>
          <meshToonMaterial color="#8fd06a" gradientMap={ramp} />
        </mesh>
      ))}
    </>
  );
}
