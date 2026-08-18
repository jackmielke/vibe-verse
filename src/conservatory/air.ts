/**
 * The air in the room, which is most of why it looks photographed.
 *
 * Three things live in it:
 *
 * SHAFTS. The sun comes through the vault as a set of parallel slabs, one
 * per bay, and the same `roofTransmission` that darkens the floor cuts them
 * into bars. They are slabs rather than cones because the sun is very far
 * away — parallel light makes parallel beams, and a cone would read as a
 * torch. This is the only place in the realm with additive blending.
 *
 * MOTES. Dust hanging in the humid air, visible only where a shaft catches
 * it. Which is the actual physics: the dust is everywhere, the light is not.
 *
 * RAIN OUTSIDE. Falling past the glass, seen through it. Doing it as real
 * geometry beyond the panes rather than as an overlay means it parallaxes
 * when you move, and the glass's own refraction bends it.
 */
import * as THREE from "three";
import { CONSERVATORY_COMMON } from "./shaders";
import { NAVE } from "./structure";

export interface AirSystem {
  group: THREE.Group;
  update(dt: number, t: number, camera: THREE.Camera): void;
  dispose(): void;
}

// ---------------------------------------------------------------------
// Sun shafts
// ---------------------------------------------------------------------
export function buildShafts(uniforms: Record<string, THREE.IUniform>): AirSystem {
  const group = new THREE.Group();
  const owned: THREE.BufferGeometry[] = [];

  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec2 vUv;
      void main(){
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec2 vUv;
      ${CONSERVATORY_COMMON}
      void main(){
        // Cut by the roof, exactly as the floor is. A beam whose bright
        // bars do not line up with the bright bars it lands on is the
        // giveaway that the light was painted rather than cast.
        float thru = roofTransmissionSoft(vec2(vWorld.z * 0.20, vWorld.x * 0.07),
                                          vec2(0.006, 0.013));

        // Thin out towards the floor: the beam has further to travel and
        // more air to lose itself in.
        float height = smoothstep(-0.4, 3.2, vWorld.y);
        // Soft edges across the slab so it has no visible geometry.
        float across = smoothstep(0.0, 0.28, vUv.x) * smoothstep(1.0, 0.72, vUv.x);

        // Grazing beams are the ones you see. Looking along a shaft picks
        // up far more scattering than looking across it.
        vec3 view = normalize(vWorld - uCamPos);
        float align = pow(max(0.0, dot(view, -normalize(uSunDir))), 2.2);

        // Rain outside means more water in the air inside.
        float density = 0.11 + uRain * 0.16;
        /* Fade out anything you are practically standing in. These are flat
           quads pretending to be volumes, and the pretence collapses at
           arm's length — the first version was eighteen metres wide and the
           camera spent the whole walk inside one, so the entire screen was
           washed with additive sun. */
        float near = smoothstep(1.2, 5.0, length(vWorld - uCamPos));
        /* A beam is visible from ANY angle — looking across one you still
           see it, you just see less. The base term was 0.35 against an
           alignment lobe that reads zero for most of the walk, which made
           the shafts a feature you could only find by turning round. */
        float a = thru * across * (0.25 + height * 0.75) * (0.75 + align) * density * near
              * canopyShade(vWorld);
        if (a < 0.002) discard;
        gl_FragColor = vec4(uSunColor * a * 3.6, a);
      }
    `,
  });

  /* One narrow beam per bay rather than one wall-to-wall slab.
     A bay's worth of glass throws a beam about a metre and a half across,
     and that is what you want to see: a row of distinct bars marching down
     the room. The slab version had them overlapping into a single fog. */
  const sun = new THREE.Vector3(...(uniforms.uSunDir.value as number[])).normalize();
  const bays = Math.floor(NAVE.length / NAVE.bay);
  const BEAM_W = 1.6;
  const BEAM_L = 17;
  for (let i = 0; i <= bays; i++) {
    const z = -NAVE.length / 2 + i * NAVE.bay;
    // Two per bay, offset across the nave, so the beams land on both the
    // path and the beds rather than all in a line down the middle.
    for (const off of [-2.6, 2.4]) {
      const geo = new THREE.PlaneGeometry(BEAM_W, BEAM_L, 1, 1);
      const m = new THREE.Mesh(geo, mat);
      // Point the quad's long axis along the sun.
      const dir = sun.clone().negate();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      m.quaternion.copy(q);
      // Hang it so the beam starts up at the glass and reaches the floor.
      const top = new THREE.Vector3(off, NAVE.spring + NAVE.radius * 0.75, z);
      m.position.copy(top).addScaledVector(dir, BEAM_L * 0.45);
      m.renderOrder = 3;
      m.frustumCulled = false;
      group.add(m);
      owned.push(geo);
    }
  }

  return {
    group,
    update() { /* static geometry; the shader does the moving */ },
    dispose() {
      owned.forEach((g) => g.dispose());
      mat.dispose();
    },
  };
}

// ---------------------------------------------------------------------
// Dust
// ---------------------------------------------------------------------
export function buildMotes(uniforms: Record<string, THREE.IUniform>): AirSystem {
  const COUNT = 3200;
  const rand = (() => { let a = 12345; return () => (a = (a * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  const pos = new Float32Array(COUNT * 3);
  const seed = new Float32Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    pos[i * 3] = (rand() - 0.5) * NAVE.halfWidth * 2;
    pos[i * 3 + 1] = rand() * 8.5;
    pos[i * 3 + 2] = (rand() - 0.5) * NAVE.length;
    seed[i] = rand();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), NAVE.length);

  const mat = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uPixelRatio: { value: 1 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime;
      uniform float uPixelRatio;
      uniform float uGust;
      varying float vSeed;
      varying vec3 vWorld;
      void main(){
        vSeed = aSeed;
        vec3 p = position;
        // Dust does not fall, it wanders — and it wanders faster when the
        // air is moving.
        float t = uTime * (0.06 + aSeed * 0.05);
        p.x += sin(t * 2.1 + aSeed * 60.0) * (0.5 + uGust * 2.2);
        p.y += sin(t * 1.3 + aSeed * 31.0) * 0.42;
        p.z += cos(t * 1.7 + aSeed * 45.0) * (0.5 + uGust * 1.6);
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWorld = wp.xyz;
        vec4 mv = viewMatrix * wp;
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(uPixelRatio * 26.0 / max(-mv.z, 0.6), 1.0, 5.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vSeed;
      varying vec3 vWorld;
      ${CONSERVATORY_COMMON}
      void main(){
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d);
        if (r > 0.5) discard;
        float soft = 1.0 - smoothstep(0.05, 0.5, r);

        // Only visible in the light. This is the whole trick: the dust is
        // uniform, the beams are not, so the motes appear and disappear as
        // you walk through the bars.
        float thru = roofTransmission(vec2(vWorld.z * 0.20, vWorld.x * 0.07));
        vec3 view = normalize(vWorld - uCamPos);
        float align = pow(max(0.0, dot(view, -normalize(uSunDir))), 1.6);
        float a = soft * thru * (0.10 + align * 0.55) * (0.5 + 0.5 * sin(vSeed * 40.0 + uTime));
        if (a < 0.004) discard;
        gl_FragColor = vec4(uSunColor * 1.5, a * 0.5);
      }
    `,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 4;
  const group = new THREE.Group();
  group.add(points);

  return {
    group,
    update() {
      (mat.uniforms.uPixelRatio as THREE.IUniform).value = Math.min(window.devicePixelRatio, 2);
    },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}

// ---------------------------------------------------------------------
// Rain beyond the glass
// ---------------------------------------------------------------------
export function buildRainOutside(uniforms: Record<string, THREE.IUniform>): AirSystem {
  const COUNT = 2600;
  const rand = (() => { let a = 99; return () => (a = (a * 48271) % 2147483647) / 2147483647; })();
  // Each streak is a short vertical line segment. Lines rather than points,
  // because rain at a shutter speed is a streak and a round dot reads as
  // snow.
  const positions = new Float32Array(COUNT * 6);
  const seeds = new Float32Array(COUNT * 2);
  const R = NAVE.radius + 5;
  for (let i = 0; i < COUNT; i++) {
    const x = (rand() - 0.5) * (NAVE.halfWidth * 2 + 22);
    const y = rand() * 26;
    const z = (rand() - 0.5) * (NAVE.length + 18);
    const len = 0.5 + rand() * 0.9;
    positions[i * 6] = x; positions[i * 6 + 1] = y; positions[i * 6 + 2] = z;
    positions[i * 6 + 3] = x + 0.06; positions[i * 6 + 4] = y - len; positions[i * 6 + 5] = z;
    seeds[i * 2] = rand(); seeds[i * 2 + 1] = rand();
    seeds[i * 2] = rand();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const seedAttr = new Float32Array(COUNT * 2);
  for (let i = 0; i < COUNT * 2; i++) seedAttr[i] = seeds[i];
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seedAttr, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R + NAVE.length);

  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime;
      uniform float uGust;
      varying vec3 vWorld;
      void main(){
        vec3 p = position;
        // Falling, wrapped. Wind blows it off the vertical, and harder in a
        // gust — rain that falls straight down in a storm looks wrong.
        float fall = mod(p.y - uTime * (11.0 + aSeed * 6.0), 26.0);
        p.y = fall;
        p.x += uGust * 3.4 + (26.0 - fall) * 0.12;
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      ${CONSERVATORY_COMMON}
      void main(){
        // Rain is only visible against something — mostly the sky, and
        // mostly when backlit.
        vec3 view = normalize(vWorld - uCamPos);
        float align = pow(max(0.0, dot(view, -normalize(uSunDir))), 1.4);
        float a = uRain * (0.05 + align * 0.22);
        if (a < 0.004) discard;
        gl_FragColor = vec4(mix(uSkyColor * 1.6, uSunColor, align * 0.5) * a * 2.0, a);
      }
    `,
  });

  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  lines.renderOrder = 2;
  const group = new THREE.Group();
  group.add(lines);

  return {
    group,
    update(_dt, _t, camera) {
      // Follow the viewer so the storm is always around them, snapped so
      // individual streaks still hold still in the world.
      group.position.z = Math.round(camera.position.z / 12) * 12;
    },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}
